// ext/python/units.js —— python 切成两格单元产物：公共库（`py_rt_*`）与入口
//
// 为什么要切：一份脚本编出来的核心方言里，公共库那一层 **每份脚本一字不差** ——
//   * `ext/python/lib/*.py` 的那些函数经单态化后的实例（`_str_upper` / `_float_inf` /
//     `_ucase_map` …，adapter 经 `rtNames` 报上来）；
//   * ucase 那张表（`ext/python/rt/ucase.tab`，一段 112KB 的静态数据）。
// 量过 `basics.py`：整份核心方言 288KB，脚本自己只有 ~10KB —— 剩下的全是公共库，
// 而且光把那张表发成文本（十进制字节）一趟就要几十毫秒。整份重发重解析是纯浪费。
//
// 怎么切：零件全在公共层，这一份只是接线 —— 与 `ext/polydraw/units.js`（EVAL 两门）
// 同一条路，差异只有三格：
//   * `rtNames` 是**库函数实例的 mangled 名**（adapter 报上来）；
//   * `(memory …)` / `(data …)` 两项归 `py_rt`（EVAL 没有数据段，那一层没这格账）；
//   * 键与产物名带 `py_` 前缀 —— 与 EVAL 共用一目录（`modules/js-eval`），前缀分开
//     才不会撞。
//
// **降级器那几格是调用方递进来的**（`cap`/注入，不是 import）：登记处
// `lower/langs.js` 已经 import 了这一份，而降级器 `lower/drive.js` 又 import 登记处 ——
// 这一份再去 import `drive.js` 就成了环。与 `textToMod`/`emitEsm`/`runtimeText`
// 同一条纪律：**别人家的能力从外面递进来**。

import {
  sxForms, sxDoStmts, buildUnits, builtGet, builtSet, declRead,
} from '../../src/core/build/modules.js';
import { asyUnitModules, formsOf } from '../../src/core/frontend-asy/link.js';
import { hash16 } from '../../src/core/host/hash.js';
import { exists, fileSize, mtimeMs, readText } from '../../src/core/host/native.js';
import { join } from '../../src/core/host/path.js';
import { treeRoot } from '../../src/core/host/treeroot.js';
import { LIB_FILES } from './adapter/pylib.js';

/** 一份单元产物的**接口**：它那几条顶层项各自的第一行（`link.js` 的 `formsOf`）。 */
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

/** 一项该进 `secs` 的哪一格。`memory`/`data` 没有名字，也是公共库的 —— 归 `fns` 桶。 */
function putForm(sec, form) {
  if (form.head === 'class' || form.head === 'struct') sec.cls.push(form.text);
  else if (form.head === 'global') sec.glb.push(form.text);
  else sec.fns.push(form.text);
}

/**
 * 入口那份产物的名字：**基名 + 内容哈希**（与 EVAL 同一条纪律 —— 页面按 URL 缓存，
 * 改一行必须换一个名字；同一份内容永远命中同一份产物）。
 */
function entryName(path, text) {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
  return `${base.replace(/[^A-Za-z0-9_]/g, '_')}_${hash16(text).slice(0, 8)}`;
}

/**
 * 公共库的**新鲜度探针**：键 = lib 源文件 + ucase.tab + 编译器指纹。
 *
 * **在编译之前判** —— 与实例集无关：接口（`.d.sx`）里有签名，adapter 按它把库的
 * 实例登记成 frozen（`adapter/libsig.js` + `index.js` 的 `registerFrozen`），调用点
 * 对得上就用、对不上现造一格落在入口，`py_rt` 不动。所以"改一行"的趟连库的 IR
 * 都不必重推。命中回 `{name, sigs}`，没命中回 null。
 */
function libProbe(o) {
  const root = treeRoot();
  const parts = [o.tool ?? ''];
  for (const f of LIB_FILES) {
    const p = join(root, 'ext', 'python', 'lib', f);
    if (!exists(p)) return null;
    parts.push(`${p}:${mtimeMs(p)}:${fileSize(p)}`);
  }
  const tab = join(root, 'ext', 'python', 'rt', 'ucase.tab');
  if (!exists(tab)) return null;
  parts.push(`${tab}:${mtimeMs(tab)}:${fileSize(tab)}`);
  const libKey = `py_lib|${hash16(parts.join('\u0000'))}`;
  const hit = builtGet(o.dir, libKey);
  if (hit === null) return { name: null, sigs: null, key: libKey };
  const name = hit.names[0] ?? '';
  const d = name === '' ? null : declRead(o.dir, name);
  /* 接口里一条签名都没有就当没命中：那是旧版写下的空 `.d.sx`（还不记签名的年代），
     照它走的话入口那一格会报一片"未声明的函数"。 */
  if (d === null || (d.sigs ?? []).length === 0) return { name: null, sigs: null, key: libKey };
  return { name, sigs: d.sigs, key: libKey };
}

/**
 * 回 `{units, reused, rtName}` —— 驱动那一格（`pyUnitsBuild`）拿它去比印记、
 * 只编该编的那几份。
 *
 * ## 库是依赖图上一格**独立的节点**
 *
 * `libProbe` 在降级**之前**判（lib 源 + ucase.tab + 编译器指纹）：
 *   * **没变** → `o.rt` 带着接口下去，adapter 一个字节都不碰库（不读源、不解析、
 *     不推断）—— 这一趟编译的就是**脚本自己那份短码**，库的正文与那张表躺在
 *     盘上那份 `py_rt_*` 里，已经编好了。接口（`.d.sx` 的那几行签名）是它全部的
 *     对外面，脚本里的库调用按它解析。
 *   * **变了** → 照旧全量：读源、推断、切成 `py_rt` 编一次。库的实例集是 lib
 *     文件的**纯函数**（`lib/*.py` 全标注、一 def 一例 —— 单态化不再按调用点收），
 *     所以哪一份脚本都不能让它动。
 */
export function pyUnitTexts(path, argv = [], o = {}) {
  const out = {};
  const rt = { key: '', name: '', hit: false };
  if (typeof o.coreSx !== 'function') {
    throw new Error('pyUnitTexts：降级器那一格要调用方递进来（o.coreSx）');
  }
  const hit = o.rt !== null && o.rt !== undefined;
  const text = o.coreSx(path, argv, out, {
    lib: hit ? { name: o.rt.name, sigs: o.rt.sigs } : null,
  });
  if (text === null || text === undefined) return null;
  /* 命中那一档：接口就是库这一趟的全部 —— 名字直接用探针那份。 */
  if (hit) { rt.hit = true; rt.name = o.rt.name; }
  const rtSet = new Set(Array.isArray(out.rtNames) ? out.rtNames : []);
  const app = emptySec();
  const lib = emptySec();
  const memForms = [];
  let main = [];
  for (const f of sxForms(text)) {
    if (f.head === 'main') { main = sxDoStmts(f.text); continue; }
    if (f.head === 'memory' || f.head === 'data') { memForms.push(f.text); continue; }
    putForm(rtSet.has(f.name) ? lib : app, f);
  }
  /* `main` 里那几句包回一格 `(do …)` —— 与模块级的 `(global …)` 同一层，
     不包的话脚本在 main 里遮蔽一个同名全局就成了重复声明（EVAL 那边踩过）。 */
  const mainDo = main.length === 0 ? [] : [`(do\n${main.join('\n')})`];
  /* **内存与 data 段（ucase 表）归谁**：没命中 → 归 `py_rt`（编一次）；命中 →
     盘上那份已经装好了，入口里不该有库的正文、也就不该有 `(mload …)`
     （兜底扫一遍：万一有就自带一份，重复初始化无害——两份内容一字不差）。 */
  const appSoFar = [...app.cls, ...app.glb, ...app.fns, ...mainDo].join('\n');
  if (rt.hit) {
    if (appSoFar.includes('(mload')) for (const t of memForms) app.fns.push(t);
  } else {
    for (const t of memForms) lib.fns.push(t);
  }
  const appText = [...app.cls, ...app.glb, ...app.fns, ...mainDo].join('\n');
  const entry = entryName(path, appText);
  if (rt.hit) {
    const d = declRead(o.dir, rt.name);
    const keys = new Map([[0, { file: path }], [1, { file: `<${rt.name}>` }]]);
    const r = withSigs(asyUnitModules({
      ids: [0],
      secs: new Map([[0, app]]),
      keys,
      weak: [],
      main: mainDo,
      skipped: new Map([[1, { sigs: d === null ? [] : d.sigs }]]),
    }, (k) => (k.file === `<${rt.name}>` ? rt.name : entry)), new Map([[entry, secSigs(app)]]));
    return { ...r, rtName: rt.name };
  }
  /* 公共库一层一项都没有（纯 int 算术的脚本）：一格单元都不必切。 */
  const libItems = [...lib.cls, ...lib.glb, ...lib.fns];
  if (libItems.length === 0) {
    const secs = new Map([[0, app]]);
    return {
      ...withSigs(asyUnitModules({
        ids: [0], secs, keys: new Map([[0, { file: path }]]), weak: [], main: mainDo,
      }, () => entry), new Map([[entry, secSigs(app)]])),
      rtName: '',
    };
  }
  /* 公共库那份的名字按**它自己那几项**算（含那张表）—— 内容变了名字就变。 */
  const rtName = `py_rt_${hash16(libItems.join('\n')).slice(0, 8)}`;
  const keys = new Map([[0, { file: path }], [1, { file: `<${rtName}>` }]]);
  const nameOf = (k) => (k.file === `<${rtName}>` ? rtName : entry);
  return {
    ...withSigs(asyUnitModules({
      ids: [0, 1], secs: new Map([[0, app], [1, lib]]), keys, weak: [], main: mainDo,
    }, nameOf), new Map([[entry, secSigs(app)], [rtName, secSigs(lib)]])),
    rtName,
  };
}

/**
 * **python 那条按单元产物的驱动**：切两格单元 -> `buildUnits`（比印记、只编该编的、
 * 出接口、写启动器）。回 `{mainPath, made, kept, names}`。
 *
 * 外面那几样由调用方注入（cli.js 的 `unitsBuild`），与 EVAL 那一格同一张单子：
 *   `coreSx(path, argv, out, opts)`     源码 -> 核心方言文本（`lower/drive.js` 的 `coreSxText`）
 *   `textToMod(名字, sx文本, 初始化符号)` 核心方言文本 -> 模块（`cap('sx.textToMod')`）
 *   `emitEsm(模块)`                     -> 那份 ESM 产物文本（`target('js').emit(m, {esm:true})`）
 *   `runtimeText` / `runtimeName`       一目录一份的 `omni_rt.js`
 *   `tool`                              编译器指纹（改了后端就该重编）
 *
 * 键里带 `py` 那一格前缀：目录与 EVAL 共用（`modules/js-eval`），前缀分开才不撞。
 */
export function pyUnitsBuild(o) {
  /* **快路：这一份输入上一趟编出来的就是答案**（`built.log`）。键 = 源文件内容 +
     编译器指纹 + 这一趟的旗子 —— 命中就连降级都不用跑，直接装盘上那几份。 */
  const src = readText(o.path);
  const key = typeof src === 'string' ? hash16([
    'py', src, o.tool ?? '', (o.argv ?? []).join(' '),
  ].join('\u0000')) : null;
  if (key !== null) {
    const hit = builtGet(o.dir, key);
    if (hit !== null) {
      return { mainPath: hit.mainPath, made: 0, kept: hit.names.length + 1, names: hit.names };
    }
  }
  const pick = (v) => (typeof v === 'function' ? v() : v);
  const rtText = pick(o.runtimeText);
  const rtGiven = pick(o.runtimeName);
  const rtFile = typeof rtGiven === 'string' ? rtGiven
    : (typeof rtText === 'string'
      ? `omni_rt_${hash16(rtText).slice(0, 8)}.js`
      : 'omni_rt.js');
  /* **公共库的新鲜度：编译之前判**（`libProbe`）。命中 → `o.rt` 带着接口下去，
     adapter 按它登记 frozen 实例，库的体一格都不推；没命中 → 照旧整份推，
     推完了把 py_lib 那格账记上（见下）。 */
  const probe = libProbe(o);
  const rt = probe.name !== null ? probe : null;
  const r = pyUnitTexts(o.path, o.argv ?? [], {
    dir: o.dir, tool: o.tool ?? '', coreSx: o.coreSx, rt,
  });
  if (r === null) return null;
  /* 入口那一份的名字由切法算出来 —— 唯一不以 `py_rt_` 开头的就是入口。 */
  const entry = [...r.units, ...(r.reused ?? [])]
    .map((u) => u.name).find((n) => !n.startsWith('py_rt_')) ?? '';
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
    runtimeText: rtText,
    runtimeName: rtFile,
    prelude: [`import './${rtFile}';`],
    tail: ['$js_check_uncaught();', '$flush();'],
  });
  if (key !== null && built !== null) {
    builtSet(o.dir, key, {
      mainPath: built.mainPath,
      names: built.names,
      files: [`${entry}.js`, ...built.names.map((n) => `${n}.js`), 'omni_rt.js', rtFile],
    });
  }
  /* **公共库记一格账**（`py_lib|<lib源+指纹>`，`libProbe` 的正面）：下一趟在编译之前
     就能判"没变"，库一个字节都不碰。摆在 `buildUnits` 之后 —— 那份 `.js` 与 `.d.sx`
     得先真在盘上，`builtGet` 会 stat 它们。命中那档不写（还是同一份，不用续期）。 */
  if (r.rtName !== '' && built !== null && probe.key !== undefined && rt === null) {
    builtSet(o.dir, probe.key, {
      mainPath: join(o.dir, `${r.rtName}.js`),
      names: [r.rtName],
      files: [`${r.rtName}.js`, `${r.rtName}.d.sx`],
    });
  }
  return built;
}
