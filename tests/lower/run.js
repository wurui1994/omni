#!/usr/bin/env node
// tests/lower/run.js —— **公共降级器那条路的判据**（ADR-0044）
//
//   源码 → GLR → CST → adapter(语言) → 标准 IR → lower(公共) → .sx → OIR → 后端
//
// 一门语言迁过来之后，它在 `tests/graph/` 那张矩阵里的那几格就没了（`tograph.js` 删掉了，
// 图那一层不再有它）。判据搬到这儿，而且**判的是同一件事**：那几个例子家族的输出逐行相同。
//
// 期望的输出行从 `tests/graph/cases.js` 借（那是家族表的正本，与语言无关）——
// 图那一层全部拆掉那天，那几个常量搬到这儿来。**不抄第二份**：抄了就会分叉。
//
// 两条判据，一门语言一格例子文件：
//   1. `omni run x.<ext>` 的 stdout 与家族期望**逐行相同**（退出码 0）；
//   2. `omni emit sx x.<ext>` 出得来 —— 那是这条路的中间产物，它坏了上面那条也会红，
//      但分开报能一眼看出坏在"降级"还是"跑"。
//
//   node tests/lower/run.js
//   node tests/lower/run.js awk      只跑名字里带 awk 的那几格

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS } from '../../src/core/lower/langs.js';
import { pngToRgba } from '../../src/studio/render.js';
import {
  BASICS, INTMATH, LOOPEXIT, DICT, UNARY, RECORD, INDEX, SLICE, CONV, VALUES, MUT,
  DEFER, BLOCKRET, METHOD, ASSERTOK, STRCAT, NUMSTR, NAMEDARG, CASEFOR, CASERANGE,
  CTIF, MEMBER, BLOCKSCOPE, BITS, CHARLIT, CTCONST, DECLS, ENUMVAL, FNVAL, FORIN,
  HOIST, LITNONE, MATCH, METHOD2, OPTRES, POINTER, POSINIT, PUSH, INHERIT, OPOVER, TMPL, CTOR, VIRT, CTMPL, LAMBDA, FMT, FORMAT, POSTEST, CTOR2, METHOV, PUREVIRT, DTORCHAIN, MIXVIRT, OUTLINE, CTMPL2, FNOVL, METHOV2, CTOR3, REFPARAM, STATICMEM, BYVALUE, ARRFIELD, RANGEFOR, SWBREAK, NARROW, ENUMDO, DECLMIX, ARRMATH, GLOBALS, CHAIN, EVALARR,
} from '../lib/cases.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'src/core/cli.js');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

let pass = 0;
let fail = 0;
const ok = (s) => { pass++; process.stdout.write(`  ok   ${s}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n       ${why}\n`); };

/**
 * 哪一门语言有哪几个家族的例子。**语言名 → 家族名单**，家族的期望在上面那几个常量里。
 * 加一门迁过来的语言就在这儿加一行（例子文件名是算出来的：`ext/<lang>/examples/<家族>.<后缀>`）。
 */
const FAMILIES = {
  basics: BASICS, intmath: INTMATH, loopexit: LOOPEXIT, dict: DICT, unary: UNARY,
  record: RECORD, index: INDEX, slice: SLICE, conv: CONV, values: VALUES, mut: MUT,
  defer: DEFER, blockret: BLOCKRET, method: METHOD, assertok: ASSERTOK,
  strcat: STRCAT, numstr: NUMSTR, namedarg: NAMEDARG, casefor: CASEFOR,
  caserange: CASERANGE, ctif: CTIF, member: MEMBER, blockscope: BLOCKSCOPE,
  bits: BITS, charlit: CHARLIT, ctconst: CTCONST, decls: DECLS, enumval: ENUMVAL,
  fnval: FNVAL, forin: FORIN, hoist: HOIST, litnone: LITNONE, match: MATCH,
  method2: METHOD2, optres: OPTRES, pointer: POINTER, posinit: POSINIT, push: PUSH,
  inherit: INHERIT, opover: OPOVER, tmpl: TMPL, ctor: CTOR, virt: VIRT,
  ctmpl: CTMPL, lambda: LAMBDA, fmt: FMT, format: FORMAT, postest: POSTEST,
  ctor2: CTOR2, methov: METHOV, purevirt: PUREVIRT, dtorchain: DTORCHAIN, mixvirt: MIXVIRT,
  outline: OUTLINE, ctmpl2: CTMPL2, fnovl: FNOVL, methov2: METHOV2, ctor3: CTOR3, refparam: REFPARAM, staticmem: STATICMEM, byvalue: BYVALUE, arrfield: ARRFIELD, rangefor: RANGEFOR,
  swbreak: SWBREAK, narrow: NARROW, enumdo: ENUMDO, declmix: DECLMIX, arrmath: ARRMATH, globals: GLOBALS,
  chain: CHAIN,
  evalarr: EVALARR,
};
const MIGRATED = {
  awk: ['basics', 'intmath', 'loopexit', 'dict', 'unary'],
  /* chez：九个家族全在。`intmath` 那一格**从前是红的**（提升出来的函数叫 `sum-go`，
     名字里的 `-` 方言那侧读不了）—— adapter 这条路上名字会规整，所以它现在是绿的。 */
  chez: ['basics', 'intmath', 'record', 'index', 'dict', 'slice', 'conv', 'mut', 'values'],
  /* sbcl：十个家族全在。`defer`（`unwind-protect`）与 `blockret`（`return-from`）
     是这门语言独有的两族 —— 落到的仍是现成的语句，一格新东西都没加。 */
  sbcl: ['basics', 'blockret', 'conv', 'defer', 'dict', 'index', 'intmath', 'record', 'slice', 'values'],
  /* freebasic：七个家族。`defer` 那一族在这门语言里是**析构**（`Declare Destructor`）——
     adapter 在每个出口按逆序补一遍调用（FB 的 RAII），公共层一格新东西都没加。 */
  freebasic: ['basics', 'conv', 'defer', 'index', 'intmath', 'loopexit', 'record'],
  /* mojo：十二个家族。`method`（struct 的方法 → `<类型>_<方法>` + 接收者当第一格实参）、
     `with`（`__enter__`/`__exit__` 那一族 = defer）、`assertok`（方言里没有 assert，
     按口径拼成 `if !cond then print + fail`）三样是这门语言带进来的。 */
  mojo: ['assertok', 'basics', 'conv', 'defer', 'dict', 'index', 'intmath', 'loopexit',
    'method', 'record', 'slice', 'values'],
  /* cpp：三十九个家族。`defer` 在这门语言里是 `~Say()`（RAII，与 freebasic 同一手，
     出口那一半交给公共层的 `{ kind: 'scope' }`）；`printf` 只接"一格转换 + 换行"
     （见 adapter/expr.js 的 printArgs）。`inherit` 与 `opover` 两族的期望输出是
     本机 `c++ -std=c++17` 给的，不是我们自己编的。 */
  cpp: ['arrfield', 'arrmath', 'basics', 'byvalue', 'chain', 'conv', 'ctmpl', 'ctmpl2', 'ctor', 'ctor2', 'ctor3', 'declmix', 'defer', 'dict', 'dtorchain', 'enumdo', 'fmt', 'globals',
    'fnovl',
    'index', 'inherit', 'intmath', 'methov', 'methov2', 'mixvirt', 'outline',
    'lambda', 'loopexit', 'narrow', 'swbreak', 'opover', 'purevirt', 'rangefor', 'record', 'refparam', 'staticmem', 'tmpl', 'values', 'virt'],
  /* nim：十九个家族（借来那几门里最多的一格）。这门语言自己带进来的有五样：
     `casefor`（`case` 里能有 `elif` + `for … in` 区间/序列）、`caserange`（`of 0 .. 59:`）、
     `ctif`（`when` 是**编译期**分支：中的那支摊开、别的整格丢掉）、`namedarg`
     （`Point(x: 1)` 是造记录、`f(a = 3)` 是命名实参 —— 在实参那个位置上两者**不同形**）、
     `blockscope`（`block:` 自己一层作用域）。
     **`mapiter` 有意不在这张表里**：`for k in t` 当场报（方言里没有能装下键列表的类型，
     那是一次语言决定）—— 在图那条路上它也是红的，账没变。 */
  nim: ['basics', 'blockscope', 'casefor', 'caserange', 'conv', 'ctif', 'defer', 'dict',
    'index', 'intmath', 'loopexit', 'member', 'method', 'namedarg', 'numstr', 'record',
    'slice', 'strcat', 'values'],
  /* vlang：三十个家族（借来那几门里最多的一格）。这门语言自己带进来的有六样：
     `optres` / `litnone` / `hoist`（Option 与 Result —— **"零值就是 none"**那条口径，
     与图那条路一字不差）、`fnval`（函数值：提升 + `(fnref …)` / `(callfn …)`，那两格加在
     **公共**降级器里）、`pointer`（`&T` 与 `mut` —— struct 一律落 `(class …)`）、
     `ctconst`（`@FN` / `@MOD` / `@STRUCT` / `@METHOD`）、`method2`（两个类型上的同名方法）。
     **`mapiter` 有意不在这张表里**：`for k, v in m` 当场报（与 nim 同一格语言决定）。 */
  vlang: ['assertok', 'basics', 'bits', 'charlit', 'conv', 'ctconst', 'ctif', 'decls',
    'defer', 'dict', 'enumval', 'fnval', 'forin', 'hoist', 'index', 'intmath', 'litnone',
    'loopexit', 'match', 'member', 'method', 'method2', 'optres', 'pointer', 'posinit',
    'push', 'record', 'slice', 'strcat', 'values'],
  /* go：**判据的主力在 `tests/go/run.js`**（46 份与 `go run` 逐字节，原生腿），所以这张表里
     只留 `format` 一格 —— 它是"家族表里有期望常量、却没人跑"那个洞的补丁：`fmt.Sprintf` /
     `Printf` 在迁过来之后曾经整格当场报，而 146 份例子那把尺子只看"退出码变没变"，
     一直记着它是红的，没人发现它本该是绿的。 */
  go: ['format', 'postest'],   // 两格都是 `Sprintf` 一修就转绿的
  /* polydraw（`.pss`，Ken Silverman 的 EVAL）：先一格 `basics`。这门语言的正确性口径是
     **那棵参考树里的旧实现**（`polydraw_src/eval.c` + `eval.txt`），不是新写的
     `c_impl` / `js_impl`（它们有已知偏差）。这一版只接"只算不画"那一半 ——
     画图那一族（glBegin / glVertex / 矩阵栈）在 adapter 里当场报，见任务 #19。 */
  /* polydraw（`.pss`，Ken Silverman 的 EVAL）：`basics` 是"只算不画"那一半，
     **`evalarr` 是这门语言自己的三样规矩**（`static` 数组 + 越界那两档 + RND/NRND，
     口径在 `eval.txt` 的 "Variables & arrays"）。画图那一族的判据在第二节（判表面）。 */
  polydraw: ['basics', 'evalarr'],
  /* evaldraw（`.kc`）**与 polydraw 是同一门语言**：同一份 `.grammar`、同一份 `evalToIR`，
     差别只有那张宿主表。这一格判据在的理由正是这个 —— 它证明"两门共用一份"没有走样。 */
  evaldraw: ['basics'],
};

/** 敲一条命令，回 `{ code, out, err }`（out 按行切好，末尾空行去掉）。 */
function omni(args, extraEnv) {
  const env = extraEnv === undefined ? process.env : { ...process.env, ...extraEnv };
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, env });
  const out = (r.stdout ?? '').split('\n');
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return { code: r.status ?? 1, out, err: r.stderr ?? '' };
}

/* 登记处与这张表要对得上：迁过来的语言必须真的有 `toIR`（漏登记就是"测试绿、命令行没有"）。 */
for (const name of Object.keys(MIGRATED)) {
  const d = LANGS.get(name);
  if (d === undefined || typeof d.toIR !== 'function') {
    no(`${name} 登记`, '这张表说它迁过来了，可登记处（langs.js）没有 toIR 那一格');
  }
}

for (const [name, families] of Object.entries(MIGRATED)) {
  const d = LANGS.get(name);
  if (d === undefined) continue;
  for (const family of families) {
    const label = `${name}+${family}`;
    if (only.length > 0 && !only.some((x) => label.includes(x))) continue;
    const file = `ext/${name}/examples/${family}.${d.exts[0]}`;
    if (!existsSync(join(ROOT, file))) { no(label, `例子文件没有：${file}`); continue; }
    const want = FAMILIES[family];
    /* 判据 2 先跑（它是上面那一条的前一步）：降级出得来吗。 */
    const sx = omni(['emit', 'sx', file]);
    if (sx.code !== 0 || sx.out.length === 0) {
      no(`${label} emit sx`, `退出码 ${sx.code}：${sx.err.split('\n')[0]}`);
      continue;
    }
    ok(`${label} emit sx [${sx.out.join('\n').length} 字节]`);
    /* 判据 1：真跑一趟，输出逐行相同。 */
    const got = omni(['run', file]);
    if (got.code !== 0) { no(label, `退出码 ${got.code}：${got.err.split('\n').slice(-2).join(' ')}`); continue; }
    if (JSON.stringify(got.out) !== JSON.stringify(want)) {
      no(label, `输出 期望 ${JSON.stringify(want)} 得到 ${JSON.stringify(got.out)}`);
      continue;
    }
    ok(`${label} run [${want.join(' ')}]`);
  }
}

/* ─── 第二节：图形设备那一格（**判的是那一帧表面**，不是 stdout） ──────────────
 * `(gfxframe PATH W H FB)` 有三份实现（backend-js 的 `$gfx_frame`、interp 的 `gfxFrame`、
 * C 的 `omni_gfx_frame`）。三条腿各跑一趟同一份例子，判四件事：
 *   1. stdout 上只有那一行**指针**（像素不走 stdout —— 这是这一层的全部要点）；
 *   2. 那一帧是**一份能解开的 PNG**（默认出口），IHDR 里的宽高与指针那行一致；
 *   3. **不是全黑**（"什么都没画"也能满足上面两条）；
 *   4. 三条腿**逐字节相同**（PNG 是 filter 0 + stored 的，编码那一层也是确定的）。
 *
 * 两份例子走的是两套宿主 API，落的是同一块帧缓冲：
 *   * `.kc` = EvalDraw 的 2D（`cls`/`setcol`/`moveto`/`lineto`/`drawsph`/`drawcone`）；
 *   * `.pss` = PolyDraw 的 **GL 立即模式**（`glBegin`/`glVertex`/`glColor` + 矩阵栈）——
 *     它多一层变换与三角形光栅化（`gl-rt.js`），所以值得单独一格。
 */
const GFX_OUT = '.omni-cache/gfx/frame.png';
const GFX_CASES = [
  { who: 'evaldraw+2d', file: 'ext/evaldraw/examples/draw2d.kc', w: 320, h: 240 },
  { who: 'polydraw+gl', file: 'ext/polydraw/examples/02-gl.pss', w: 320, h: 240 },
  /* jnc（C 那一侧）：同一格 op 的**指针那一档** —— 帧缓冲是 `int fb[N]`（一槽一个
     0xRRGGBB），不是 `(arr real)`。库是普通的 jnc 代码（`ext/jnc/lib/ege.jnc`），
     只有"交出一帧"那一句走方言。 */
  { who: 'jnc+ege', file: 'ext/jnc/examples/01-shapes.jnc', w: 320, h: 240 },
  /* **宿主设备那条路**（`OMNI_GFX=host`：画图落成 `(gfxcall "名字" …)`，设备在宿主那一侧）。
     判的是"搬家不改语义"：同一份 `.kc` 走这条路，与上头 `evaldraw+2d`（生成出来的 CPU
     光栅器）出来的表面**逐字节相同**。这条路才是往后的默认 —— GPU 那两档设备（WebGL2 /
     本机 OpenGL）挂在同一格全局上（`docs/design/eval-realtime-gpu.md`）。 */
  {
    who: 'evaldraw+host',
    file: 'ext/evaldraw/examples/draw2d.kc',
    w: 320,
    h: 240,
    env: { OMNI_GFX: 'host' },
  },
  /* **帧循环那一格**（`OMNI_FRAMES=3`：设备说"还画不画下一帧"，产物自己 while）。
     判三件事：stdout 上**三行**指针（一帧一行）、`static` 跨帧活（圆的半径 = 帧数×20，
     三帧之后是 60 —— 非黑格数对得上）、三条腿逐字节相同。 */
  {
    who: 'evaldraw+frames',
    file: 'ext/evaldraw/examples/frames.kc',
    w: 320,
    h: 240,
    env: { OMNI_GFX: 'host', OMNI_FRAMES: '3' },
    frames: 3,
  },
  /* **输入那一族**（`mousx`/`mousy`/`bstatus`/`keystatus[k]`，还有"写回去消掉一次点击"）。
     CPU 这一档没有窗口，所以来源是 `OMNI_MOUSE=x,y,按键位` 与 `OMNI_KEYS=扫描码,…` ——
     输入在这一趟里是常量，于是三条腿仍然逐字节相同。例子里四格都留了痕（见 probes）。 */
  {
    who: 'evaldraw+input',
    file: 'ext/evaldraw/examples/input.kc',
    w: 320,
    h: 240,
    env: { OMNI_GFX: 'host', OMNI_MOUSE: '200,80,1', OMNI_KEYS: '0xc8' },
    /* 挑几格像素：`[x, y, r, g, b]` —— 判的是"输入真的进到图里了"。 */
    probes: [
      [200, 80, 255, 190, 60],      /* 实心圆（左键按着）盖在十字上 -> 鼠标位置与 bstatus 都活 */
      [150, 20, 255, 255, 255],     /* 方向键上那条白线 -> keystatus[0xc8] 活 */
      [40, 200, 16, 24, 32],        /* 绿点**没画** -> `bstatus--` 写回设备生效了 */
    ],
  },
  /* **CLI 那几格旗子**（`--frame N` / `--w` / `--h`，照 c_impl 的 `polydraw-render`）：
     判的是"走到第 2 帧、**只交出那一帧**"（所以 stdout 上只有一行指针，而不是三行）
     加上画布尺寸真换了（160×120）。这几格旗子隐含 `OMNI_GFX=host`（设备那条路）——
     三条腿仍然逐字节相同，因为 klock 在 render 模式下是"帧号/60"的确定性时钟。 */
  {
    who: 'evaldraw+cli',
    file: 'ext/evaldraw/examples/frames.kc',
    w: 160,
    h: 120,
    args: ['--frame', '2', '--w', '160', '--h', '120'],
  },
];
const gfxLegs = [['js', []], ['interp', ['--backend', 'interp']], ['c', ['--backend', 'c']]];
for (const G of GFX_CASES) {
  if (only.length > 0 && !only.some((x) => 'gfx'.includes(x) || G.file.includes(x) || G.who.includes(x))) continue;
  const seen = [];
  for (const [leg, flags] of gfxLegs) {
    const label = `${G.who}(${leg})`;
    const got = omni(['run', ...flags, G.file, ...(G.args ?? [])], G.env);
    /* 一帧一行指针：帧循环那一档跑几帧就有几行。 */
    const want = new Array(G.frames === undefined ? 1 : G.frames)
      .fill(`#gfx png ${GFX_OUT} ${G.w} ${G.h}`);
    if (got.code !== 0) { no(label, `退出码 ${got.code}：${got.err.split('\n').slice(-2).join(' ')}`); continue; }
    if (JSON.stringify(got.out) !== JSON.stringify(want)) {
      no(label, `stdout 期望 ${JSON.stringify(want)} 得到 ${JSON.stringify(got.out)}`);
      continue;
    }
    const buf = readFileSync(join(ROOT, GFX_OUT));
    /* 默认出口是 PNG：解开它（页面那一格同一份解码器 —— 判据与 UI 不许各解一套）。
       解得开这件事本身就把"签名 / IHDR / stored 流 / filter 0"全判了。 */
    let px = null;
    try {
      const img = pngToRgba(buf.toString('latin1'));
      if (img.w !== G.w || img.h !== G.h) throw new Error(`${img.w}x${img.h} != ${G.w}x${G.h}`);
      px = Buffer.from(img.body, 'latin1');
    } catch (e) {
      no(label, `那一帧不是我们这一档 PNG：${String(e.message ?? e)}`);
      continue;
    }
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] !== 0 || px[i + 1] !== 0 || px[i + 2] !== 0) lit++;
    }
    if (lit === 0) { no(label, '表面整幅全黑 —— 图元一格都没落进帧缓冲'); continue; }
    /* 挑出来的那几格像素（有 `probes` 的例子才判）：证明**这一格输入真的影响了图**，
       不是"画了点什么就算过"。 */
    let bad = null;
    for (const [x, y, r, g, b] of G.probes ?? []) {
      const o = (y * G.w + x) * 4;
      if (px[o] !== r || px[o + 1] !== g || px[o + 2] !== b) {
        bad = `(${x},${y}) 期望 ${r},${g},${b} 得到 ${px[o]},${px[o + 1]},${px[o + 2]}`;
        break;
      }
    }
    if (bad !== null) { no(label, `像素 ${bad}`); continue; }
    seen.push([leg, buf]);
    ok(`${label} 一帧 PNG [${buf.length} 字节，${lit} 格非黑`
      + `${G.probes === undefined ? '' : `，${G.probes.length} 格像素对得上`}]`);
  }
  for (let i = 1; i < seen.length; i++) {
    const [leg, buf] = seen[i];
    if (buf.equals(seen[0][1])) ok(`${G.who} ${seen[0][0]}/${leg} 逐字节相同`);
    else no(`${G.who} ${seen[0][0]}/${leg}`, '两条腿的表面不是同一份字节');
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed`
  + '（adapter → 标准 IR → 公共 lower → .sx → 真跑一趟）\n');
process.exit(fail === 0 ? 0 : 1);
