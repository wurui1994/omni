// ext/polydraw/units.js —— **EVAL 两门切成两格单元产物**（`.pss` / `.kc`）
//
// 为什么要切：一份脚本编出来的核心方言里，`gl_*` / `g3_*` / `gfx_*` 那一层
// （GL 的状态机与光栅器在语言这一侧）**每份脚本一字不差**。量过 `02-gl.pss`：129 项里
// 127 项是它，脚本自己只有 `fn eval$frame` 与 `main` 两项。整份重发一遍是纯浪费
// （`docs/design/omni-serve-studio.md` §9.3）。
//
// 怎么切（零件全在公共层，这一份只是接线）：
//   1. `o.coreSx(path, argv, out, opts)` —— 跑**一趟**降级，顺手拿回 `out.rtNames`（那张名单）；
//   2. `sxForms(text)` 切成顶层项、`sxDoStmts` 把 `(main (do …))` 拆成语句；
//   3. 名字在名单里的归 `ev_rt`、其余归入口，拼成 `sections` 交给 `asyUnitModules`。
//
// **降级器那一格是调用方递进来的**（`cap`/注入，不是 import）：登记处 `lower/langs.js` 已经
// import 了这一份（`units: evalUnitsBuild`），而降级器 `lower/drive.js` 又 import 登记处 ——
// 这一份再去 import `drive.js` 就成了环，`check:self` 当场报
// `import cycle through 'src/core/lower/drive.js'`（这条红从 7d731632 一直挂着没人看见）。
// 与 `textToMod`/`emitEsm`/`runtimeText` 同一条纪律：**别人家的能力从外面递进来**。
//
// `ev_rt` 的**名字按内容算**（`ev_rt_<哈希>`）：于是换个脚本它一定命中盘上那一份，
// 而我们改了 `gl-rt.js` 它就自动变成另一份 —— 与 `UnitIndex` 那套"内容定址"同一条纪律。

import {
  sxForms, sxDoStmts, buildUnits, builtGet, builtSet, declRead,
} from '../../src/core/build/modules.js';
import { asyUnitModules, formsOf } from '../../src/core/frontend-asy/link.js';
import { hash16 } from '../../src/core/host/hash.js';
import { readText } from '../../src/core/host/native.js';
import { join } from '../../src/core/host/path.js';

/**
 * 一份单元产物的**接口**：它那几条顶层项各自的第一行（`link.js` 的 `formsOf` 读出来的）。
 * 盘上那份 `<名字>.d.sx` 里存的就是它 —— 下一趟"正文不降"时发签名靠它。
 *
 * **要按分段里的那几项算，不能拿拼好的模块文本算**：拼好的那一份外头包着 `(module …)`，
 * 于是每一项在 `formsOf` 眼里深度都是 1、一条都认不出来（踩过：接口文件只有表头 25 字节，
 * 那条快路永远命中不了）。
 */
const secSigs = (sec) => [...sec.cls, ...sec.glb, ...sec.fns, ...sec.wraps]
  .flatMap((t) => formsOf(t).map((f) => f.sig));

/** 把算好的接口挂到对应那份单元上（名字 -> 签名表）。 */
const withSigs = (r, byName) => {
  for (const u of r.units ?? []) {
    const s = byName.get(u.name);
    if (s !== undefined) u.sigs = s;
  }
  return r;
};

/** 空的一格 `secs`（四格都是"顶层项正文"的数组，见 `link.js` 那个循环）。 */
const emptySec = () => ({ cls: [], glb: [], fns: [], wraps: [] });

/** 一项该进 `secs` 的哪一格。 */
function putForm(sec, form) {
  if (form.head === 'class' || form.head === 'struct') sec.cls.push(form.text);
  else if (form.head === 'global') sec.glb.push(form.text);
  else sec.fns.push(form.text);
}

/**
 * 入口那份产物的名字：**基名 + 内容哈希**。
 *
 * 为什么按内容而不是按路径：页面那一侧是 `import(URL)`，而浏览器的模块登记表**按 URL 缓存**
 * —— 名字不变的话改一行脚本再跑，页面拿到的还是上一份模块（改了没反应）。按内容起名之后
 * 每一版是一个新 URL，而且"同一份内容"永远命中同一份产物（与 `ev_rt` 同一条纪律）。
 */
function entryName(path, text) {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
  return `${base.replace(/[^A-Za-z0-9_]/g, '_')}_${hash16(text).slice(0, 8)}`;
}

/**
 * 回 `{units, reused, rtKey, rtName}`（`units`/`reused` 与 `cap('asy.unitTexts')` 同形状）——
 * 驱动那一格（`evalUnitsBuild`）拿它去比印记、只编该编的那几份。
 *
 * ## 运行时那一层：命中了就**连正文都不降**（2026-09-26）
 *
 * 量出来的账（`ken/balls.pss`，64 行的脚本，热进程）：整份 sx **77KB**，其中脚本自己只有
 * **9.4KB** —— 剩下 68KB 是 `gl_*`/`g3_*`/`gfx_*`/`gt_*` 那一层，**每份脚本一字不差**。
 * 光"造 IR + 降 + 印"那 68KB 每趟就要 **13~20ms**，而它的产物逐字节相同、`UnitIndex`
 * 一比印记就复用。也就是说改一个字符按一次运行，有一多半时间花在**重新生成一份马上
 * 被扔掉的文本**上。
 *
 * 所以这一趟先问一句"那一层还是上一趟那一份吗"（键 = 那张名字表 + 编译器指纹），
 * 命中就让公共降级器**只登记签名、不发正文**（`lower` 的 `skipBodies`），拼单元时那一份
 * 走 `sections.skipped`（`frontend-asy/link.js` 早就认这一格 —— asy 复用库产物同一条路）。
 * 没命中才照旧全降一趟，并把那一层的名字记下来。
 */
export function evalUnitTexts(path, argv = [], o = {}) {
  const out = {};
  /* 运行时那一层：命中了记在这儿（`name` 是盘上那份产物名），没命中记 `key` 等着回填。 */
  const rt = { key: '', name: '', hit: false };
  if (typeof o.coreSx !== 'function') {
    throw new Error('evalUnitTexts：降级器那一格要调用方递进来（o.coreSx）');
  }
  const text = o.coreSx(path, argv, out, {
    skipBodies: (names) => {
      if (names.length === 0 || typeof o.dir !== 'string') return null;
      rt.key = `rt|${hash16(`${names.join(',')}|${o.tool ?? ''}`)}`;
      const had = builtGet(o.dir, rt.key);
      if (had === null) return null;
      /* 盘上那份产物与它的接口都还在（`builtGet` 已经 stat 过）—— 这一趟不降它。
         **接口里一条签名都没有就当没命中**：那是旧版写下的空 `.d.sx`（那时还不记签名），
         照它走的话入口那一份会报一片"未声明的函数"。 */
      const name = had.names[0] ?? '';
      const d = name === '' ? null : declRead(o.dir, name);
      if (d === null || (d.sigs ?? []).length === 0) return null;
      rt.name = name;
      rt.hit = true;
      return new Set(names);
    },
  });
  if (text === null || text === undefined) return null;
  const rtSet = new Set(Array.isArray(out.rtNames) ? out.rtNames : []);
  const app = emptySec();
  const lib = emptySec();
  let main = [];
  for (const f of sxForms(text)) {
    if (f.head === 'main') { main = sxDoStmts(f.text); continue; }
    putForm(rtSet.has(f.name) ? lib : app, f);
  }
  /* 入口那一份的名字按**它自己那几项**算（含 `(main …)` 里那几句）。 */
  const appText = [...app.cls, ...app.glb, ...app.fns, ...main].join('\n');
  const entry = entryName(path, appText);
  /* **命中那一档**：`lib` 一项都没有（正文压根没降）—— 那一份按 `skipped` 交出去，
     它的签名从盘上那份接口读（`<名字>.d.sx`）。 */
  if (rt.hit) {
    const d = declRead(o.dir, rt.name);
    const keys = new Map([[0, { file: path }], [1, { file: `<${rt.name}>` }]]);
    const r = withSigs(asyUnitModules({
      ids: [0],
      secs: new Map([[0, app]]),
      keys,
      weak: [],
      main,
      skipped: new Map([[1, { sigs: d === null ? [] : d.sigs }]]),
    }, (k) => (k.file === `<${rt.name}>` ? rt.name : entry)), new Map([[entry, secSigs(app)]]));
    return { ...r, rtKey: rt.key, rtName: rt.name };
  }
  /* 运行时那一层一项都没有（纯算术的 `.pss`）：一格单元都不必切。 */
  const libItems = [...lib.cls, ...lib.glb, ...lib.fns];
  if (libItems.length === 0) {
    const secs = new Map([[0, app]]);
    return {
      ...withSigs(asyUnitModules({
        ids: [0], secs, keys: new Map([[0, { file: path }]]), weak: [], main,
      }, () => entry), new Map([[entry, secSigs(app)]])),
      rtKey: '',
      rtName: '',
    };
  }
  const rtName = `ev_rt_${hash16(libItems.join('\n')).slice(0, 8)}`;
  const keys = new Map([[0, { file: path }], [1, { file: `<${rtName}>` }]]);
  const nameOf = (k) => (k.file === `<${rtName}>` ? rtName : entry);
  return {
    ...withSigs(asyUnitModules({
      ids: [0, 1], secs: new Map([[0, app], [1, lib]]), keys, weak: [], main,
    }, nameOf), new Map([[entry, secSigs(app)], [rtName, secSigs(lib)]])),
    rtKey: rt.key,
    rtName,
  };
}

/**
 * **EVAL 那条按单元产物的驱动**：切两格单元 -> `buildUnits`（比印记、只编该编的、
 * 出接口、写启动器）。回 `{mainPath, made, kept, names}`。
 *
 * 外面那几样由调用方注入（这一份不认识后端与能力表，也就不会把 cli 那一摊拖进来）：
 *   `coreSx(路径, argv, out, opts)`      源码 -> 核心方言文本（`lower/drive.js` 的 `coreSxText`）
 *   `textToMod(名字, sx文本, 初始化符号)` 核心方言文本 -> 模块（`cap('sx.textToMod')`）
 *   `emitEsm(模块)`                      -> 那份 ESM 产物文本（`target('js').emit(m, {esm:true})`）
 *   `runtimeText`                        一目录一份的 `omni_rt.js`（`cap('jsgen.runtimeModule')`）
 *   `tool`                               编译器指纹（改了后端就该重编）
 *
 * 两处印记的口径（`rowKey` 只认"文件的内容身份"）：
 *   * 入口那一份 `self` 就是脚本本身，`extras` 里放它依赖的单元名 —— 运行时那一层换了
 *     （名字里带内容哈希）入口的键就跟着变，于是不会拿着旧的 import 名字；
 *   * `ev_rt` 那一份**没有源文件**，它的名字本身就是内容哈希，所以 `self` 空着、
 *     身份放在 `extras` 里。
 */
export function evalUnitsBuild(o) {
  /* 运行时那一份的名字：调用方给了就用它（它一进程只算一次 —— `hash16` 在那 350KB 上
     要 47ms），没给才自己算。 */
  const rtFile = typeof o.runtimeName === 'string' ? o.runtimeName
    : (typeof o.runtimeText === 'string'
      ? `omni_rt_${hash16(o.runtimeText).slice(0, 8)}.js`
      : 'omni_rt.js');
  /* **快路：这一份输入上一趟编出来的就是答案**（`built.log`，见 `builtGet` 的头注）。
     Studio 里点一次运行就是一趟这个；不带这道闸的话就算一份产物都不重编，也要把脚本
     整个降一遍才知道单元叫什么名字（`ken/balls.pss` 热进程里 117ms，产物逐字节相同）。
     键里有：源文件内容、编译器指纹、这一趟的旗子、运行时那一份的名字。 */
  const src = readText(o.path);
  const key = typeof src === 'string' ? hash16([
    src, o.tool ?? '', (o.argv ?? []).join(' '), rtFile,
  ].join('\u0000')) : null;
  if (key !== null) {
    const hit = builtGet(o.dir, key);
    if (hit !== null) {
      return { mainPath: hit.mainPath, made: 0, kept: hit.names.length + 1, names: hit.names };
    }
  }
  const r = evalUnitTexts(o.path, o.argv ?? [], {
    dir: o.dir, tool: o.tool ?? '', coreSx: o.coreSx,
  });
  if (r === null) return null;
  /* 入口那一份的名字由切法算出来（按内容）—— 这儿从单元清单里认它：唯一不是 `ev_rt_…`
     的那一份就是入口。 */
  const entry = [...r.units, ...(r.reused ?? [])]
    .map((u) => u.name).find((n) => !n.startsWith('ev_rt_')) ?? '';
  const rowOf = (u) => (u.name === entry
    ? { self: o.path, incs: [], deps: [], needs: [], extras: [...(u.deps ?? [])] }
    : { self: '', incs: [], deps: [], needs: [], extras: [u.name] });
  const built = buildUnits({
    dir: o.dir,
    units: r.units,
    reused: r.reused ?? [],
    entry,
    tool: o.tool ?? '',
    rowOf,
    emitJs: (u) => o.emitEsm(o.textToMod(u.name, u.text, `omni_init_${u.name}`)),
    unitSym: (n) => `omni_init_${n}`,
    runtimeText: o.runtimeText,
    /* **运行时那一份也按内容起名**：浏览器才敢给它 immutable（四百 KB 一次都不再问）。 */
    runtimeName: rtFile,
    prelude: [`import './${rtFile}';`],
    tail: ['$js_check_uncaught();', '$flush();'],
  });
  if (key !== null && built !== null) {
    builtSet(o.dir, key, {
      mainPath: built.mainPath,
      names: built.names,
      /* 命中之前每一份都要 stat 得到 —— 少一份（缓存清过/`gc` 扫过）就退回慢路。 */
      files: [`${entry}.js`, ...built.names.map((n) => `${n}.js`),
        ...(typeof o.runtimeText === 'string' ? ['omni_rt.js', rtFile] : [])],
    });
  }
  /* **运行时那一层记一格账**（键 = 那张名字表 + 编译器指纹 -> 产物名）：下一趟就能
     "只登记签名、不发正文"（见 `evalUnitTexts` 的头注）。摆在 `buildUnits` 之后 ——
     那一份 `.js` 与 `.d.sx` 得先真在盘上，`builtGet` 会 stat 它们。 */
  if (r.rtKey !== '' && r.rtName !== '' && built !== null) {
    builtSet(o.dir, r.rtKey, {
      mainPath: join(o.dir, `${r.rtName}.js`),
      names: [r.rtName],
      files: [`${r.rtName}.d.sx`],
    });
  }
  return built;
}
