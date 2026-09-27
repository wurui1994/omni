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
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS } from '../../src/core/lower/langs.js';
import { pngToRgba } from '../../src/studio/render.js';
import {
  BASICS, INTMATH, LOOPEXIT, DICT, UNARY, RECORD, INDEX, SLICE, CONV, VALUES, MUT,
  DEFER, BLOCKRET, METHOD, ASSERTOK, STRCAT, NUMSTR, NAMEDARG, CASEFOR, CASERANGE,
  CTIF, MEMBER, BLOCKSCOPE, BITS, CHARLIT, CTCONST, DECLS, ENUMVAL, FNVAL, FORIN,
  HOIST, LITNONE, MATCH, METHOD2, OPTRES, POINTER, POSINIT, PUSH, INHERIT, OPOVER, TMPL, CTOR, VIRT, CTMPL, LAMBDA, FMT, FORMAT, POSTEST, CTOR2, METHOV, PUREVIRT, DTORCHAIN, MIXVIRT, OUTLINE, CTMPL2, FNOVL, METHOV2, CTOR3, REFPARAM, STATICMEM, BYVALUE, ARRFIELD, RANGEFOR, SWBREAK, NARROW, ENUMDO, DECLMIX, ARRMATH, GLOBALS, CHAIN, EVALARR, PDNOISE, EVDOWHILE, EVTAIL, EVTAILSEMI, EVREADPIX, EVARRVIEW, EVBLOCKCOPY, EVNETBOX, EVINST,
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
  noise: PDNOISE,
  dowhile: EVDOWHILE,
  tailexpr: EVTAIL,
  tailsemi: EVTAILSEMI,
  readpix: EVREADPIX,
  arrview: EVARRVIEW,
  blockcopy: EVBLOCKCOPY,
  netbox: EVNETBOX,
  inst: EVINST,
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
     口径在 `eval.txt` 的 "Variables & arrays"）。画图那一族的判据在第二节（判表面）。
     `noise` 是**噪声那一族**（`NOISE`/`NOISE3D`）：纯函数，落成生成出来的 IR
     （`ext/polydraw/noise-rt.js`），期望值由 `polydraw_src/polydraw.c:852-960` 那份正本
     单独编一趟给出，18 个数一位不差。 */
  polydraw: ['basics', 'evalarr', 'noise'],
  /* evaldraw（`.kc`）**与 polydraw 是同一门语言**：同一份 `.grammar`、同一份 `evalToIR`，
     差别只有那张宿主表。这一格判据在的理由正是这个 —— 它证明"两门共用一份"没有走样。
     `dowhile` 与 `tailexpr` 是这门语言自己那两样写法：do-while 里的 `break`/`continue`
     （落成"旗子 + while"，从前抄两份 body 会当场报）、**末尾那句不带分号的表达式就是
     返回值**（语料里十八份 `.kc` 这么写），`tailsemi` 是**带分号那一档也算返回值**
     （口径由 `eval_bench` 量出来，少这一格 `voxes/meatball.kc` 整幅图是黑的）。
     `blockcopy` 是**整块赋值与整块传参**
     （说明书那句"两边大小相同就许"，见 §8.3.1）。`netbox` 是 **`&一整块里的某一格`**
     （形参 `&x` 拿到的是"块 + 偏移"，`krnd(&lgs.krnd)` 那一格）**与联网那一族**
     （单机就是"自己发自己收"，见 `ext/polydraw/net-rt.js`）。
     `inst` 是**入口收一整块**（`(a[16])`：自己写乐器那一档，`insts/` 那五份靠它）。 */
  evaldraw: ['basics', 'dowhile', 'tailexpr', 'tailsemi', 'readpix', 'arrview', 'blockcopy', 'netbox', 'inst'],
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
/**
 * 一帧图**默认**落哪儿：`<缓存根>/gfx/<脚本名>.png`（`cli.js` 的 `setGfxDefaultOut`）。
 * 从前是钉死的 `.omni-cache/gfx/frame.png`（相对 cwd + 名字固定），两份脚本互相覆盖。
 * 判据从仓库根跑、没设 `OMNI_CACHE_DIR`，所以缓存根就是 `<ROOT>/.omni-cache`。
 *
 * `jnc+ege` 那一格例外：落点烧在**库的源码里**（`ext/jnc/lib/ege.jnc` 的 `gfxframe(…)`
 * 那一句，那是用户级的库代码、不读环境变量）—— 它判的就是那句老兜底。
 */
const GFX_FALLBACK = '.omni-cache/gfx/frame.png';
const gfxOutOf = (G) => {
  if (G.out !== undefined) return G.out;
  const base = G.file.slice(G.file.lastIndexOf('/') + 1);
  const cut = base.lastIndexOf('.');
  /* 判据从仓库根跑 ⇒ 落点就在 cwd 底下 ⇒ CLI 印的是**相对**那一份（见 setGfxDefaultOut）。 */
  return `.omni-cache/gfx/${cut > 0 ? base.slice(0, cut) : base}.png`;
};

const GFX_CASES = [
  { who: 'evaldraw+2d', file: 'ext/evaldraw/examples/draw2d.kc', w: 320, h: 240 },
  { who: 'polydraw+gl', file: 'ext/polydraw/examples/02-gl.pss', w: 320, h: 240 },
  /* **2D graphing mode**（`(x,y)` —— 主函数的形参表就是模式，`evaldraw.txt:1298`）：
     宿主**每像素调一次**、回值过默认调色板，循环在语言这一侧（`graph-rt.js`）。
     判的是那两件定死的事：**网格**（默认 `setgrid(-4,3,4,-3)`）与**调色板**
     （`<=0` 蓝、`>=1` 红、中间蓝→青→绿→黄→红）。这一份的回值沿横向从 0 线性到 1，
     所以左中右三格颜色是算得出来的（量出来的数写在下面）。 */
  {
    who: 'evaldraw+graph2d',
    file: 'ext/evaldraw/examples/graph2d.kc',
    w: 320,
    h: 240,
    probes: [
      [0, 120, 0, 1, 255],        /* 最左：v≈0.0016 ⇒ 蓝那一头 */
      [80, 120, 0, 255, 253],     /* 四分之一：青 */
      [160, 120, 1, 255, 0],      /* 正中：绿 */
      [240, 120, 255, 253, 0],    /* 四分之三：黄 */
      [319, 120, 255, 1, 0],      /* 最右：v≈0.998 ⇒ 红那一头 */
      [319, 239, 255, 1, 0],      /* 每一行都一样（回值只看 x） */
    ],
  },
  /* jnc（C 那一侧）：同一格 op 的**指针那一档** —— 帧缓冲是 `int fb[N]`（一槽一个
     0xRRGGBB），不是 `(arr real)`。库是普通的 jnc 代码（`ext/jnc/lib/ege.jnc`），
     只有"交出一帧"那一句走方言。落点也烧在那份库里（用户级代码不读环境变量），
     所以这一格判的是那句老兜底。 */
  { who: 'jnc+ege', file: 'ext/jnc/examples/01-shapes.jnc', w: 320, h: 240, out: GFX_FALLBACK },
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
  /* **画布文字那一族**（`setfont`/`moveto`/`printchar`/`printnum`/`printf`，落在语言
     那一侧：`ext/polydraw/text-rt.js`）。probes 挑的是字模上的**具体笔画**：'H' 的左竖与
     中横、两竖之间那一格黑、'A' 铺到 12×16 之后的竖与横、`printnum` 换行之后那个 '!'、
     `printf` 里 `\n` 之后那个 '#' —— 于是"字模抄对了没有、字号缩放对不对、光标走位对不对"
     都判得出来，不是"画了点什么就算过"。
     `text` 是脚本自己印到 stdout 的那一份（这门的 `printf` 两处都去）：它与指针行的**先后
     按缓冲走**（c 那条腿先印文字），所以有 `text` 的例子比的是集合，不是次序。 */
  {
    who: 'evaldraw+text',
    file: 'ext/evaldraw/examples/text.kc',
    w: 320,
    h: 240,
    env: { OMNI_GFX: 'host' },
    text: ['ok 7'],
    probes: [
      [11, 10, 255, 255, 255],    /* 'H' 左竖（6×8，白） */
      [13, 13, 255, 255, 255],    /* 'H' 中横：字模第 3 行 */
      [13, 10, 0, 0, 0],          /* 两竖之间：没画 */
      [12, 33, 0, 255, 0],        /* 'A' 左竖（12×16：一格放大成 2×2） */
      [16, 38, 0, 255, 0],        /* 'A' 中横 */
      [103, 18, 255, 0, 0],       /* `printnum(42)` 换过行 —— '!' 落在下一行 */
      [182, 20, 0, 128, 255],     /* `printf("ok %g\n")` 里那个 `\n` 也换行了 */
      [300, 200, 0, 0, 0],        /* 没写字的地方：没动过 */
    ],
  },
  /* **KV6 体素模型那一族**（`drawkv6`；解码在设备、画在语言那一侧 —— 见
     `ext/polydraw/gfx3-rt.js` 的 `g3_kv67`）。资源是现造的 `cube8.kv6`：2×2×2 八格体素、
     八个角八种颜色，正对相机画出来就是**前四格四个圆**（后四格只露一牙）。
     probes 钉的正是"**x/y 是靠两张游程表数出来的**"：体素记录里只有 z，数错一格
     八个颜色就会串位。三条腿仍要逐字节相同（解码那一份在 C 里另写了一遍）。 */
  {
    who: 'evaldraw+kv6',
    file: 'ext/evaldraw/examples/kv6.kc',
    w: 320,
    h: 240,
    env: { OMNI_GFX: 'host' },
    probes: [
      [145, 105, 0, 255, 0],          /* 前层左上：绿（x=0,y=0,z=1） */
      [175, 105, 255, 0, 255],        /* 前层右上：品红 */
      [145, 135, 255, 255, 0],        /* 前层左下：黄 */
      [175, 135, 128, 128, 128],      /* 前层右下：灰 */
      [142, 84, 255, 0, 0],           /* 后层露出来那一牙：红（z=0） */
      [178, 84, 0, 255, 255],         /* 后层：青 */
      [142, 120, 0, 0, 255],          /* 后层：蓝 */
      [178, 120, 255, 255, 255],      /* 后层：白 */
      [10, 10, 0, 0, 0],              /* 模型外头：没画 */
    ],
  },
  /* **1D 那一档**（`(x)`：一列一格取样、连成折线）。这一份画的是直线 `y = x/4`，
     所以每一列落在哪一行是算得出来的：左端在下（行 160）、正中在半高（行 120）、
     右端在上（行 80）。折线画歪一格、y 上下颠倒、标尺换错一头，这四格都看得见。 */
  {
    who: 'evaldraw+graph1d',
    file: 'ext/evaldraw/examples/graph1d.kc',
    w: 320,
    h: 240,
    env: { OMNI_GFX: 'host' },
    probes: [
      [0, 160, 255, 255, 255],        /* 第 0 列：x≈-4 -> y≈-1 -> 行 160 */
      [160, 120, 255, 255, 255],      /* 正中那一列：x≈0 -> 半高 */
      [240, 100, 255, 255, 255],      /* 四分之三处 */
      [160, 60, 0, 0, 0],             /* 曲线上头：没画 */
      [0, 0, 0, 0, 0],
    ],
  },
  /* **`pic` 那一族：设备自己解 PNG**（`host/png-read.js` 与 `omni_fmt.c` 的 `png_decode`，
     同算法两份）。先前这一格挂在 GL 插件的 ImageIO 上 ⇒ 默认那一档 `pic` 一律回 0，
     而 `demos/lab3d.kc` 拿 `while (pic(…) != 16777215)` 走光线 —— **死循环**。
     图是现造的 `ramp8.png`（8×8、RGB8、真 zlib 压的，所以动态霍夫曼那条路也走到）：
     第 (x,y) 格是 `(x*32, y*32, (x+y)*16)`。四格回值 + 一格 `&r,&g,&b` 偏一格就看得见；
     probes 再钉住"放大画出来那一片贴的位置对"。 */
  {
    who: 'evaldraw+pic',
    file: 'ext/evaldraw/examples/pic.kc',
    w: 320,
    h: 240,
    env: { OMNI_GFX: 'host', OMNI_GFX_DIR: 'ext/evaldraw/examples' },
    text: ['p00=0 p10=2.09717e+06 p07=57456 p77=1.47376e+07', 'rgb=96,160,128'],
    probes: [
      [14, 14, 0, 0, 0],              /* 左上那一格是源图 (0,0) = (0,0,0) */
      [26, 14, 64, 0, 32],            /* 往右两格：源图 (2,0) -> (64,0,32) */
      [14, 26, 0, 64, 32],            /* 往下两格：源图 (0,2) -> (0,64,32) */
      [70, 70, 224, 224, 224],        /* 右下那一格 (7,7) */
    ],
  },
  /* **`GL_COMPLEX` + `glnextcontour()` + 顶点色是 `setcol`**（见那份例子的头注）。
     probes 钉的是这三件事里最容易悄悄错的那一格：**取色的时机是顶点，不是 `glBegin`**
     —— 在 `glBegin` 那一刻取一次的话两圈都是上一格颜色（探针里是纯白）。 */
  {
    who: 'evaldraw+glcomplex',
    file: 'ext/evaldraw/examples/glcomplex.kc',
    w: 320,
    h: 240,
    env: { OMNI_GFX: 'host' },
    probes: [
      [115, 120, 0, 255, 0],          /* 第二圈（绿）：x 正 -> 画面左边 */
      [200, 120, 255, 0, 0],          /* 第一圈（红）：同一次 glBegin 里换过颜色 */
      [160, 120, 0, 0, 0],            /* 两圈之间那道缝：没画（两圈各自成一格多边形） */
      [10, 10, 0, 0, 0],
    ],
  },
  /* **帧循环写在脚本自己身上**那一族（`do{ …; refresh(); }while(1)`，语料里二十来份）：
     那个 `while` 的唯一出口是 `refresh()` 里那格帧预算。这一格判 CPU 帧缓冲那一档
     （每回 `refresh` 一行指针 + 末帧那条线在它该在的位置上）；录制那一档（`--gfx null`，
     扫描的尺子）另有一格，见下头"自循环脚本在录制那一档也得出来"。

     **为什么 `OMNI_FRAMES=3` 给的是四行**：`refresh` 那一格分两种写法 —— 一次 body 里
     **第一回只交图**（宿主每帧调一次 body 那一族的边界是 `nextframe`，不能在这儿重复记账），
     第二回起才是帧边界。于是自循环的脚本画 N+1 帧、交 N+1 次。这是明写的偏差，不是漏：
     要改成"正好 N 帧"得动帧号与 `--frame N` 的对应关系，而 `.pss` 逐像素那一轴（43 份）
     的参考全钉在现在这个对应上。 */
  {
    who: 'evaldraw+selfloop',
    file: 'ext/evaldraw/examples/selfloop.kc',
    w: 320,
    h: 240,
    frames: 4,
    env: { OMNI_GFX: 'host', OMNI_FRAMES: '3' },
    probes: [
      [20, 53, 255, 75, 0],           /* 末帧（n=3）那条线：y=53，颜色随 n 变 */
      [20, 52, 0, 0, 0],              /* 上一帧那条线已经被 cls 清掉了 */
      [20, 50, 0, 0, 0],              /* 第一帧那条也没留下 */
    ],
  },
  /* **顶点批那一格 op**（`(gfxbatch 类 数 顶点)`，手写 `.sx`）。只有一个模型：变换 /
     拆 mode / 2D 图元变顶点 / **合批**全在语言那一侧，交到设备手里的就是一段顶点
     （`docs/design/eval-realtime-gpu.md` 第 9 节 —— 用户的口径是"绝对不要硬件对应的
     立即模式，必须与 WebGL 同一个模型"）。这一格单判"收批"那条路，不必先把 gl-rt.js 改完：
     一格三角（左下红、右下绿、上蓝），颜色按重心插值，三条腿逐字节相同。 */
  {
    who: 'gfxbatch+tri',
    file: 'tests/lower/gfxbatch.sx',
    w: 320,
    h: 240,
    env: { OMNI_GFX: 'host' },
    probes: [
      [40, 210, 243, 5, 7],       /* 左下角那一片：红占大头 */
      [280, 210, 4, 244, 7],      /* 右下角：绿 */
      [160, 40, 10, 11, 233],     /* 顶上：蓝 */
      [160, 150, 84, 85, 87],     /* 正中间：三色各一份（插值真的在做） */
      [10, 10, 0, 0, 0],          /* 三角外头：没动过 */
    ],
  },
];
const gfxLegs = [['js', []], ['interp', ['--backend', 'interp']], ['c', ['--backend', 'c']]];
for (const G of GFX_CASES) {
  if (only.length > 0 && !only.some((x) => 'gfx'.includes(x) || G.file.includes(x) || G.who.includes(x))) continue;
  const seen = [];
  const gout = gfxOutOf(G);
  for (const [leg, flags] of gfxLegs) {
    const label = `${G.who}(${leg})`;
    const got = omni(['run', ...flags, G.file, ...(G.args ?? [])], G.env);
    /* 一帧一行指针：帧循环那一档跑几帧就有几行。 */
    const want = new Array(G.frames === undefined ? 1 : G.frames)
      .fill(`#gfx png ${gout} ${G.w} ${G.h}`);
    if (G.text !== undefined) want.push(...G.text);
    if (got.code !== 0) { no(label, `退出码 ${got.code}：${got.err.split('\n').slice(-2).join(' ')}`); continue; }
    /* 脚本自己也往 stdout 印东西的那一档（`text`）：指针行与它的先后按缓冲走，比集合。 */
    const cmp = (a) => JSON.stringify(G.text === undefined ? a : [...a].sort());
    if (cmp(got.out) !== cmp(want)) {
      no(label, `stdout 期望 ${JSON.stringify(want)} 得到 ${JSON.stringify(got.out)}`);
      continue;
    }
    const buf = readFileSync(gout.startsWith('/') ? gout : join(ROOT, gout));
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

/* ── **在别处的目录里跑**：落点跟着**缓存根**走，不在 cwd 底下拉一坨 ────────────────
 *
 * 上头那几格是从仓库根跑的（落点正好在 cwd 底下 ⇒ 印相对路径）。这一格换个 cwd：
 * 指针那一行该是**绝对**的、指到 `<缓存根>/gfx/<脚本名>.png`，而且那个 cwd 底下
 * **不许**多出 `.omni-cache/`。从前是钉死的相对 `.omni-cache/gfx/frame.png`：
 * 在哪儿跑就在哪儿建一个空壳缓存目录，而编译那一摊缓存在另一个根上。
 */
if (only.length === 0 || only.some((x) => 'gfx'.includes(x))) {
  const away = join(ROOT, '.omni-cache', 'test-cwd-away');
  rmSync(away, { recursive: true, force: true });
  mkdirSync(away, { recursive: true });
  const src = join(ROOT, 'ext/evaldraw/examples/draw2d.kc');
  const r = spawnSync(process.execPath, [CLI, 'run', src], {
    encoding: 'utf8', cwd: away, env: process.env,
  });
  const line = (r.stdout ?? '').split('\n').find((s) => s.startsWith('#gfx ')) ?? '';
  const want = `#gfx png ${join(ROOT, '.omni-cache/gfx/draw2d.png')} 320 240`;
  if (line !== want) {
    no('换个 cwd 跑：落点跟着缓存根走', `期望 ${want} 得到 ${line || '(没有指针行)'}`);
  } else if (existsSync(join(away, '.omni-cache'))) {
    no('换个 cwd 跑：不在 cwd 底下拉一坨', `${away}/.omni-cache 被建出来了`);
  } else {
    ok('换个 cwd 跑：落点跟着缓存根走、cwd 底下不落东西', '绝对路径 + 按脚本名');
  }
  rmSync(away, { recursive: true, force: true });
}

/* ── KV6 解码器（`src/core/host/kv6.js`）：**x/y 要靠两张游程表数出来** ───────────
 *
 * 体素记录里只有 z 与颜色；x 来自 `xlen[]`、y 来自 `ylen[][]`。所以这一格判的正是
 * "数对了没有"：现造一份 2×2×… 的模型（四根柱子、各 0/1/2/1 格体素），把每一格的
 * x,y,z 与颜色都对一遍。语料那 11 份资源不在仓库里，判据不许靠它们。
 */
if (only.length === 0 || only.some((x) => 'kv6'.includes(x))) {
  const { decodeKv6 } = await import('../../src/core/host/kv6.js');
  /* xsiz=2, ysiz=2；ylen = [[0,1],[2,1]] ⇒ 一共 4 格体素，次序是 x 大类、y 小类。 */
  const vox = [
    /* (x=0,y=1) */ [10, 20, 30, 128, 5],
    /* (x=1,y=0) */ [1, 2, 3, 128, 7], [4, 5, 6, 128, 8],
    /* (x=1,y=1) */ [9, 9, 9, 128, 1],
  ];
  const b = [];
  const i32 = (v) => { b.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255); };
  const u16 = (v) => { b.push(v & 255, (v >> 8) & 255); };
  const f32 = (v) => {
    const t = new DataView(new ArrayBuffer(4));
    t.setFloat32(0, v, true);
    for (let i = 0; i < 4; i++) b.push(t.getUint8(i));
  };
  b.push(0x4b, 0x76, 0x78, 0x6c);                 /* "Kvxl" */
  i32(2); i32(2); i32(16);                        /* xsiz, ysiz, zsiz */
  f32(0.5); f32(1); f32(2);                       /* 支点 */
  i32(vox.length);
  for (const [bb, g, r, al, z] of vox) { b.push(bb, g, r, al); u16(z); b.push(0, 0); }
  i32(1); i32(3);                                 /* xlen[0]=1, xlen[1]=3 */
  u16(0); u16(1); u16(2); u16(1);                 /* ylen[0][*], ylen[1][*] */
  const m = decodeKv6(new Uint8Array(b));
  const want = [
    [0 - 0.5, 1 - 1, 5 - 2, (30 << 16) | (20 << 8) | 10],
    [1 - 0.5, 0 - 1, 7 - 2, (3 << 16) | (2 << 8) | 1],
    [1 - 0.5, 0 - 1, 8 - 2, (6 << 16) | (5 << 8) | 4],
    [1 - 0.5, 1 - 1, 1 - 2, (9 << 16) | (9 << 8) | 9],
  ];
  if (m === null) no('KV6 解码', '解不开现造的那一份');
  else if (m.n !== want.length) no('KV6 解码', `体素个数 ${m.n} != ${want.length}`);
  else {
    let bad = '';
    for (let i = 0; i < want.length && bad === ''; i++) {
      for (let c = 0; c < 4; c++) {
        if (m.vox[i * 4 + c] !== want[i][c]) {
          bad = `第 ${i} 格第 ${c} 个数：${m.vox[i * 4 + c]} != ${want[i][c]}`;
        }
      }
    }
    if (bad !== '') no('KV6 解码', bad);
    else ok(`KV6 解码：4 格体素的 x/y（游程表数出来的）/z/颜色都对`);
  }
}

/* ── **一页里连着跑两份脚本**：换程序要清那张"具名函数当值用"的单件表 ──────────────
 *
 * `$fnOnes` 按**名字**记，记的是**闭着上一个程序那份模块作用域**的薄适配器；而运行时
 * 那一份（`omni_rt_<哈希>.js`）在一个宿主里只有一份（浏览器按 URL 缓存、node 按路径缓存）。
 * 于是第二份脚本的 `omni_mk_ref_gt_moveto` 会拿到第一份的适配器 —— 调到上一个程序那份
 * 从没初始化过的全局上，**不报错、帧还在涨、一个像素都不画**。
 *
 * 这一格判的是**宿主那一侧的契约**（`$fnOnesReset`，`src/studio/eval-live.js` 在换程序
 * 之前调它）：先跑 `draw2d.kc`，再跑 `text.kc`，第二份照样得画出那 300 多个 `setpix`。
 * 判据不靠浏览器 —— 同一个机制在 node 里一模一样（模块登记表是同一件事）。
 */
if (only.length === 0 || only.some((x) => 'fnone'.includes(x))) {
  const mk = (rel) => {
    const r = spawnSync(process.execPath, [CLI, 'emit', 'js', join(ROOT, rel),
      '--units', '--gfx', 'host'], { encoding: 'utf8' });
    try { return JSON.parse((r.stdout ?? '').trim().split('\n').pop()).main; } catch { return null; }
  };
  const a = mk('ext/evaldraw/examples/draw2d.kc');
  const b = mk('ext/evaldraw/examples/text.kc');
  if (a === null || b === null) no('两份产物都要出得来', `draw2d=${a} text=${b}`);
  else {
    /* `head` 是"先跑哪一份"（空 = 只跑 text.kc，那一趟的数就是**尺子**）。
       为什么要这把尺子：串味的样子**不是"一个像素都不画"**，而是
       "第二份画出了第一份的图"（量到过 200/200 —— 那正是 draw2d 的数）。 */
    const drv = (head) => `
const ops = new Map();
let frames = 0;
globalThis.__OMNI_GFX = {
  kind: 'null',
  call(nm) {
    ops.set(nm, (ops.get(nm) ?? 0) + 1);
    if (nm === 'nextframe') { frames += 1; return frames <= 1 ? 1 : 0; }
    return 0;
  },
  batch: () => 0, tex: () => 0, arr: () => 0, def: () => 0,
  size: () => 320 * 65536 + 240, input: () => 0,
  present() {}, snapshot: () => new Uint8Array(0), misses: () => [],
  setFrame() {}, frames: () => 1, stop() {}, step() {}, reset() {},
};
${head === null ? '' : `await import(${JSON.stringify(head)});
ops.clear(); frames = 0;
/* 宿主换程序：照 src/studio/eval-live.js 那一句清表 */
globalThis.$fnOnesReset();`}
await import(${JSON.stringify(b)});
console.log('##' + JSON.stringify({ setpix: ops.get('setpix') ?? 0 }));
`;
    const run = (head) => {
      const p = join(ROOT, '.omni-cache', `fnone-drv${head === null ? 0 : 1}.mjs`);
      writeFileSync(p, drv(head));
      const r = spawnSync(process.execPath, [p], { encoding: 'utf8' });
      rmSync(p, { force: true });
      const line = (r.stdout ?? '').split('\n').find((s) => s.startsWith('##')) ?? '';
      try { return JSON.parse(line.slice(2)).setpix; } catch { return -1; }
    };
    const alone = run(null);
    const after = run(a);
    if (alone < 100) no('一页两份脚本：尺子先得立住', `text.kc 单独跑只发了 ${alone} 次 setpix`);
    else if (after !== alone) {
      no('一页里连着跑两份：第二份画的还得是它自己',
        `单独跑 ${alone} 次 setpix，跟在 draw2d 后面变成 ${after} 次 —— 单件表串味了`);
    } else ok(`一页里连着跑两份：第二份画的还是它自己（setpix ${alone}）`);
  }
}

/* ── **文件末尾那个没关的块注释**：EVAL 认，别的语言照旧当错 ─────────────────────────
 *
 * 正本那台剥注释的机器是一遍扫描 + 一格 `got` 旗子（`polydraw_src/eval.c:6893`），
 * 扫到文件头就结束 —— 所以作者在末尾开一个块注释、不关它、压一段笔记是**合法写法**
 * （`games/snood.kc:295` 末尾压着两行 bind 说明，整份先前跑不起来）。
 *
 * 落法是语法自己声明一格 `eof-ok` 旗子（`polydraw.grammar` 的那句 block-comment，
 * 实现在 `glr/lex.js`）。**这一格判据的重点是后一半**：别的语言（这儿拿 `.go`）一个字都
 * 不受影响 —— 在 C 那一族里"没关的块注释"是真错（它会把后面整份文件吃掉），不许一律宽容。
 */
if (only.length === 0 || only.some((x) => 'eofcomment'.includes(x))) {
  const tmp = join(ROOT, '.omni-cache', 'eofcomment');
  mkdirSync(tmp, { recursive: true });
  const write = (name, text) => { const p = join(tmp, name); writeFileSync(p, text); return p; };
  /* EVAL（`.kc`）：末尾压一段没关的注释 —— 照旧要跑出那一行。 */
  const kc = write('tail.kc', '()\nprintf("ok=%g\\n", 7);\n\n/*\nbind f2 format savetxt\n');
  const r1 = spawnSync(process.execPath, [CLI, 'run', kc], { encoding: 'utf8', timeout: 60000 });
  if (r1.status !== 0) {
    no('末尾没关的块注释：`.kc` 要认', `退出码 ${r1.status}：${(r1.stderr ?? '').split('\n').slice(0, 2).join(' ')}`);
  } else if (!(r1.stdout ?? '').includes('ok=7')) {
    no('末尾没关的块注释：`.kc` 要认', `stdout 里没有 ok=7：${JSON.stringify(r1.stdout)}`);
  } else ok('末尾没关的块注释：`.kc` 认（扫到文件头就算关了）');
  /* `.go`：同一个形状必须还是错 —— `eof-ok` 是**按语法**给的，不是全局宽容。 */
  const go = write('tail.go', 'package main\n\nfunc main() {\n}\n\n/* 没关\n');
  const r2 = spawnSync(process.execPath, [CLI, 'run', go], { encoding: 'utf8', timeout: 60000 });
  const said = `${r2.stdout ?? ''}${r2.stderr ?? ''}`;
  if (r2.status === 0) {
    no('末尾没关的块注释：`.go` 照旧要报', '它跑通了 —— `eof-ok` 漏成全局宽容了');
  } else if (!said.includes('unterminated block comment')) {
    no('末尾没关的块注释：`.go` 照旧要报', `报的不是那一句：${said.split('\n').slice(0, 2).join(' ')}`);
  } else ok('末尾没关的块注释：`.go` 照旧报 unterminated（旗子是按语法给的）');
  /* **挨着的两个串字面量拼成一个**（C 的翻译阶段 6，`(string STRING "\"" join)`）：
     `games/traffic.kc:810` 那段多行帮助文本用的就是这个写法。 */
  const j1 = write('join.kc', '()\nprintf("ab" "cd"\n       "ef\\n");\n');
  const r3 = spawnSync(process.execPath, [CLI, 'run', j1], { encoding: 'utf8', timeout: 60000 });
  if (r3.status !== 0) {
    no('挨着的串字面量要拼起来', `退出码 ${r3.status}：${(r3.stderr ?? '').split('\n').slice(0, 2).join(' ')}`);
  } else if ((r3.stdout ?? '').trim() !== 'abcdef') {
    no('挨着的串字面量要拼起来', `期望 abcdef，得到 ${JSON.stringify(r3.stdout)}`);
  } else ok('挨着的串字面量拼成一个（跨行也算）');
  /* **字符字面量是"引号 + 一个字符 + 引号"**（正本 `eval.c:6909` 那条规矩，没有转义）：
     所以 `'''` 是撇号本身（`geeky/morse.kc:68` 的莫尔斯码表）。按"带转义的串"去扫会把
     第二个引号当收尾、第三个引号又开一个新串，整份文件从那儿起全错位 —— 所以这一格
     还要判**三字符那一档不成立时照旧认转义**（`'\n'` 要是 10）。 */
  const c1 = write('char3.kc', "()\nprintf(\"a=%g q=%g n=%g\\n\", 'A', ''', '\\n');\n");
  const r4 = spawnSync(process.execPath, [CLI, 'run', c1], { encoding: 'utf8', timeout: 60000 });
  if (r4.status !== 0) {
    no('字符字面量那三格', `退出码 ${r4.status}：${(r4.stderr ?? '').split('\n').slice(0, 2).join(' ')}`);
  } else if ((r4.stdout ?? '').trim() !== 'a=65 q=39 n=10') {
    no('字符字面量那三格', `期望 a=65 q=39 n=10，得到 ${JSON.stringify(r4.stdout)}`);
  } else ok("字符字面量：`'''` 是撇号（39），`'\\n'` 照旧是转义（10）");
  rmSync(tmp, { recursive: true, force: true });
}

/* ── **自循环的脚本在录制那一档（`--gfx null`）也得走出来** ─────────────────────────
 *
 * 录制那一档是扫描的**尺子**（`tests/eval/scan.js` 的默认设备）：画图那一族记一笔就回 0，
 * 只有"查询 + 帧循环"那几格给真答案。`refresh` 从前不在那张名单里 —— 于是
 * `do{ …; refresh(); }while(1)` 这个形状（语料里二十来份）**在尺子上永远转不出来**，
 * 被记成"超时"，而同一份在 `--gfx host` 上一帧就出图。**尺子把活着的例子判成死的**
 * 是最贵的一类假红：它会把人引去查"为什么这份慢"，而那儿压根没有慢。
 *
 * 这一格判的就是那条契约：录制那一档里 `refresh()` 仍然是帧边界（记账 + 出口），
 * 但**一个字节的图都不写**（`present` 在那一档里整格免了）。js 与 c 两条腿各一趟。
 */
if (only.length === 0 || only.some((x) => 'selfloop'.includes(x) || 'gfx'.includes(x))) {
  const src = 'ext/evaldraw/examples/selfloop.kc';
  const png = join(ROOT, gfxOutOf({ file: src }));
  for (const [leg, flags] of [['js', []], ['c', ['--backend', 'c']]]) {
    rmSync(png, { force: true });
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [CLI, 'run', ...flags, join(ROOT, src)],
      { encoding: 'utf8', env: { ...process.env, OMNI_GFX: 'null', OMNI_FRAMES: '3' }, timeout: 60000 });
    const ms = Date.now() - t0;
    const label = `evaldraw+selfloop(${leg}) 录制那一档`;
    if (r.error !== undefined && r.error !== null) {
      no(label, `${r.error.message}（${ms}ms）—— 自循环的脚本在 --gfx null 上出不来`);
    } else if (r.status !== 0) {
      no(label, `退出码 ${r.status}：${(r.stderr ?? '').split('\n').slice(-2).join(' ')}`);
    } else if ((r.stdout ?? '').includes('#gfx ')) {
      no(label, `录制那一档不许交图，stdout 上却有指针行：${(r.stdout ?? '').trim()}`);
    } else if (existsSync(png)) {
      no(label, `录制那一档不许写表面文件，却写出了 ${gfxOutOf({ file: src })}`);
    } else ok(`${label}：三帧走完就退出、一个字节都没写（${ms}ms）`);
  }
}

/* ── GLSL 那一层：int/float 混着算时补 `float(…)`（`ext/polydraw/glsl-type.js`）────
 *
 * 判两件事，后一件才是这一格的风险：**该补的补上了**，以及**不该补的一个都没补**
 * （`i/j` 两边都是 `int` 时是整数除法，套上 `float()` 语义就悄悄变了）。
 */
if (only.length === 0 || only.some((x) => 'glsl'.includes(x))) {
  const { glslFloatFix } = await import('../../ext/polydraw/glsl-type.js');
  /* [源码, 期望：null = 一个字都不许动 / 字符串 = 结果里要有它] */
  const cases = [
    ['uniform int n; void main(){ float f=2.0; f = 1.0-f*f*n*(1.0/16.0); }', 'f*float(n)'],
    ['void main(){ int i=3, j=2; int k = i/j; }', null],
    ['uniform int n; void main(){ int i = n*2; }', null],
    ['void main(){ float f = 3; }', 'float(3)'],
    ['uniform vec2 fibw[45]; void main(){ int b=2; float x = dot(fibw[b],vec2(1.0)); }', null],
    ['void main(){ int i=1; vec3 v = vec3(1.0); v = v*i; }', 'v*float(i)'],
    ['void main(){ int i=1; if (i < 2) { } }', null],
    ['void main(){ int i=2; float f=1.0; if (f > i) f = 0.0; }', 'float(i)'],
    ['void main(){ for (int i=0;i<4;i++) { } }', null],
    ['int g(int a){ return a; } void main(){ float x = g(1)*2.0; }', 'float(g(1))'],
  ];
  let bad = 0;
  for (const [src, want] of cases) {
    const got = glslFloatFix(src, {});
    const good = want === null ? got === src : got.includes(want);
    if (!good) {
      bad += 1;
      no('GLSL 补 float()', `${src}\n       期望 ${want ?? '原样不动'}\n       得到 ${got}`);
    }
  }
  if (bad === 0) ok(`GLSL int/float 混用补 float()（${cases.length} 格，含"不许动"那几格）`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed`
  + '（adapter → 标准 IR → 公共 lower → .sx → 真跑一趟）\n');
process.exit(fail === 0 ? 0 : 1);
