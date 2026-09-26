// ext/polydraw/adapter.js —— **polydraw（EVAL / `.pss`）的树 → 标准 IR**（ADR-0044 §1.2）
//
// 正确性口径是 `/Users/wurui/Train/polydraw/polydraw_src/`（`eval.c` + `eval.txt`）——
// 那棵树里的 `c_impl/` 与 `js_impl/` 只当参考，它们与旧实现有已知偏差。
//
// ## 这门语言要 adapter 自己消化的六件事
//
//   1. **全是 double**。没有类型、没有 int：每一格值都是 `real`。数组是 `(arr real)`。
//   2. **名字不分大小写**（`eval.txt`：function and variable names are case insensitive）。
//      一律折成小写 —— `twice(21)` 与 `TWICE(4)` 是同一个函数。
//   3. **没有声明**。函数体里 `s = 0` 既是赋值也是"第一次出现"，所以扫一遍这一段里被写过的
//      名字，在段顶上补 `let`（零值）。`static` 是另一档：它跨调用留值，落成模块级量。
//   4. **`^` 是幂、`%` 是 fmod**（`eval.c:7352` 那张优先级 LUT + 2305 行那一段发射）。
//   5. **真值观与比较的结果**。`if (x)` 是"x 不为 0"；而 `a < b` 当**值**用的时候是
//      1.0 / 0.0（全是 double 的语言里没有 bool）。所以比较与 `&&`/`||`/`!` 分两种位置译：
//      条件位置发 bool，值位置包一格 `cond ? 1 : 0`。
//   6. **内建数学函数**照 `eval.txt` 那张表映到 `rmath`（公共层那一格，C 走 libm、JS 走
//      `Math.*`）。`ABS`/`FABS` 都是 `fabs`、`SQR` 是 `sqrt` 的别名、`ATN` 是 `atan`、
//      `INT` 是朝零取整（不是 floor）、`SGN`/`UNIT`/`FACT` 没有现成的库函数，摊成表达式。
//
// ## 这一版明说的边界（**不猜**）
//
//   * 画图那一族（`glBegin` / `glVertex` / 矩阵栈 …）**还没接** —— 见任务 #19。
//     碰到那些名字时当场报一句"这一格要渲染那一侧"，不悄悄当普通函数调用。
//   * `goto` / `label:` 没接（标准 IR 里没有无条件跳转那一格）。
//   * `static` 数组的**越界两档规矩**（2 的幂按位与绕回、否则改成 0）还没接：
//     这一版按裸下标走，越界是未定义 —— 那一格要在 `lowerIndex` 的钩子里补。
//   * 函数指针形参（`a()` / `a(,)`）与 `$a` 串形参没接。

import { isList, tag, kids, leaf } from '../../src/core/lower/cst.js';
import { cUnescape, fmtToStmts } from '../../src/core/lower/fmt.js';
import { gfxGlobalDecls, gfxFnDecls, gfxPresentDecl } from './gfx-rt.js';
import { POLYDRAW_GL, GL_CONSTS, glGlobalDecls, glFnDecls } from './gl-rt.js';
import { gfx3FnDecls, gfx3GlobalDecls } from './gfx3-rt.js';
import { glslAlign } from './glsl.js';
import { NOISE_FNS, noiseGlobalDecls, noiseFnDecls } from './noise-rt.js';
import { env } from '../../src/core/host/native.js';

/**
 * **图形那一层走哪条路**（`OMNI_GFX`，口径在 `docs/design/eval-realtime-gpu.md`）：
 *
 * * `host`（往后的默认）—— 宿主调用：每一格画图都落成 `(gfxcall "名字" 实参…)`，
 *   设备在宿主那一侧（浏览器 WebGL2 / 本机 OpenGL / CPU 备选）。**实时那一档只能走它**：
 *   帧循环、鼠标键盘、着色器与纹理都在设备那边。
 * * `ir`（**眼下的默认**）—— 生成出来的 CPU 光栅器（`gfx-rt.js` / `gl-rt.js`）：
 *   三条腿逐字节相同、判据现成。GL 那一族现在只有它接得住，所以还没换默认。
 *
 * 换默认的条件写在这儿，免得日子久了忘掉：**WebGL2 与本机 OpenGL 两档设备把
 * GL 立即模式接全**（design 文档第 6 节的第 3、4 刀）之后，默认改成 `host`，
 * `ir` 退成 `--gfx=cpu` 那一格开关。
 */
function gfxMode() {
  const m = env('OMNI_GFX');
  /* **默认是 `host`**（2026-09-24 第七刀换的）：设备在宿主那一侧（node 上是
     `host/gfx-cpu.js` 的 CPU 备选、浏览器里是 WebGL2、往后是本机 OpenGL）。
     换默认的条件早就写在这儿了 —— GL 与 3D 那两族现在都在**语言这一侧**变顶点/变 2D
     图元（`gl-rt.js` / `gfx3-rt.js`），设备只收批与 2D，于是宿主那条路已经比生成出来的
     那一份全（它还有 `klock`/输入/每帧初态/纹理收下那几格）。
     `ir` 那一档留着（`OMNI_GFX=ir`）—— 它是"整份产物自带一台光栅器、不要宿主设备"
     那种用法，判据里 `evaldraw+2d` 那一格判的正是它。 */
  return m === undefined || m === null || m === '' ? 'host' : String(m);
}

/**
 * **宿主给的那几格量**（两门语言同一份：`myext[]` 里 `XRES`/`YRES`/`NUMFRAMES`/`MOUSX`/
 * `MOUSY`/`BSTATUS` 是"名字 -> 一格 double"）。在宿主调用那条路上，读它们就是问设备一句。
 *
 * `KEYSTATUS[256]` 在那张表里是**一块 256 格的 double**（`polydraw.c:2222`），
 * 所以它在这儿是 `HOST_ARRS`：`keystatus[k]` 落成 `(gfxcall "keystatus" k)`。
 */
const HOST_VARS = ['xres', 'yres', 'numframes', 'mousx', 'mousy', 'bstatus',
  /* `FRAMEINIT`（`evaldraw.txt:40`："per-frame init" 那格量）：第一帧是 1、之后是 0 ——
     脚本拿它当"这一帧要不要重新初始化"（`demos/ceilflor.kc`、`voxes/pacman.kc`）。 */
  'frameinit'];
/** 宿主那侧按下标读的量。 */
const HOST_ARRS = ['keystatus'];
/**
 * **设备/联网不在场时，说明书自己给的那几个值**（不是"猜一个数"）。
 *
 * * `evaldraw.txt:1422` —— `using6dof`「1 if using a 6 degree of freedom input device,
 *   else 0」：我们这条腿上没有那台磁场追踪器 ⇒ **0**；
 * * `:1423` —— `usingstereo`「0 if not using stereo mode」⇒ **0**；
 * * `:1719` —— `net_players`「Number of connected users, including own machine:
 *   1 when not connected」⇒ **1**；
 * * `:1721` —— `net_me`「Index of current player. Range: {0 .. net_players-1}」⇒ **0**。
 *
 * 这四格在我们这儿是**常量**（没有设备、没有联网），所以就地折成那个数，不问设备。
 */
const ABSENT_VARS = new Map([
  ['using6dof', 0], ['usingstereo', 0], ['net_players', 1], ['net_me', 0],
]);
/**
 * 同一格口径的**函数**：设备/对方不在，所以"什么都没读到" ⇒ **回 0，出参一格不动**。
 *
 * * `readmag6d(设备号, &x,&y,&z, …)` —— 回的是读到几组；没有追踪器就是 0；
 * * `net_recv(&from,&val)` / `net_recv(&from,buf,leng)` —— `evaldraw.txt:1732`：
 *   「Returns the # of values read, or 0 if nothing」；
 * * `net_send(to,val)` / `net_send(to,buf,leng)` —— `:1728`：「Returns the number of
 *   values actually transmitted; 0 if failed」。
 *
 * **实参一格都不算**（它们全是 `&x` / `&a[i]` 这种出参，单独过 `exprOf` 会当场报）——
 * 而这正好也是对的：没读到东西就不该动它们（静态量本来是 0）。代价是实参里的副作用
 * 不发生 —— 这一族的实参全是纯粹的地址，语料里没有例外。
 * 语料里靠这一族的五份：`magpong` / `magpong2` / `magsword` / `bowling` / `kpool`
 * （全都按回来的个数判"有没有设备"），加上联网那四份。
 */
const ABSENT_FNS = new Set(['readmag6d', 'net_recv', 'net_send']);
/**
 * **脚本写得动的那几格**。那张表里它们全是"名字 -> 一格 double 的地址"
 * （`polydraw.c:2217-2222`），所以**每一格都写得动** —— 从前这儿只放了两格，
 * `tigrou/ballsk.pss:17` 的 `xres = 50;` 于是当场报错。分两类：
 *
 *   * `HOST_FRAME`（`xres`/`yres`/`mousx`/`mousy`）—— 宿主在调脚本**之前**重新盖一次
 *     （`polydraw.c:2276-2280`：`dxres = (double)oglxres;` 那四句），所以写只在这一帧里
 *     算数。落法：语言这一侧一格模块级量，每帧开头问设备一次盖上去。
 *     顺带它还快了 —— 读不再是每次一句宿主调用（实时性那条线，见 §15）。
 *   * `bstatus` / `keystatus[k]` —— 宿主**不盖**（只有窗口消息与脚本自己改，
 *     `polydraw.c:3146-3153`），所以写要落到设备上：`(gfxcall "setbstatus" v)` /
 *     `(gfxcall "setkeystatus" k v)`。说明书里"消掉一次点击/一次按键"就是这个
 *     （`polydraw.txt:381`/`:388`）。
 *
 * `numframes` 由宿主每帧 `++`（`polydraw.c:2354`），既不属于"每帧盖"也不属于"只脚本改"，
 * 语料里也没人写它 —— 先仍按只读（真碰上再按设备那条路加 `setnumframes`）。
 */
const HOST_FRAME = ['xres', 'yres', 'mousx', 'mousy'];
const HOST_WRITABLE = new Set(['bstatus', 'keystatus', ...HOST_FRAME]);
/** `HOST_FRAME` 那几格在语言这一侧的名字。 */
const hvName = (n) => `pd_hv_${n}`;

/**
 * **可编程管线那一族**（`名字/元数` -> 哪几格实参是串）。
 *
 * 为什么要这张表：宿主面那一格（`(gfxcall …)`）只收 double，而这一族的实参里有**名字**
 * （着色器名、uniform 名）。串在这儿就**内部到**一张表里换成下标，表本身在入口里用
 * `(gfxdef "name" 下标 串)` 登记 —— 于是运行期仍然全是 double。
 *
 * 名字与元数照 `polydraw.c:2070` 的 `myext[]`（`GLSETSHADER($,$)` 里的 `$` 就是串）。
 */
const SHADER_FNS = new Map([
  ['glsetshader/1', [0]],
  ['glsetshader/2', [0, 1]],
  ['glsetshader/3', [0, 1, 2]],
  ['glquad/0', []],
  ['glquad/1', []],
  ['glgetuniformloc/1', [0]],
  ['gluniform/2', []],
  ['gluniform1f/2', []],
  ['gluniform2f/3', []],
  ['gluniform3f/4', []],
  ['gluniform4f/5', []],
  /* **带一整块数组的那两族**（§19.1）：实参里没有串（数组是光秃秃的名字，`exprOf`
     照旧给一格 `(var 名字)`），登记在这儿只为走 `gl-rt.js` 那条路。 */
  ['gluniform1fv/3', []],
  ['gluniform2fv/3', []],
  ['gluniform3fv/3', []],
  ['gluniform4fv/3', []],
  ['gluniform1iv/3', []],
  ['gluniform2iv/3', []],
  ['gluniform3iv/3', []],
  ['gluniform4iv/3', []],
  ['glgettex/5', []],
  /* 纹理坐标与顶点属性那几格（**串只在 `glgetattribloc` 那一格**）。 */
  ['gltexcoord/2', []],
  ['gltexcoord/3', []],
  ['gltexcoord/4', []],
  ['glnormal/3', []],
  /* **文件纹理**（`glsettex(槽,"earth.jpg"[,colmode])`）：第 1 格是串（§20）。 */
  ['glsettex/2', [1]],
  ['glsettex/3', [1]],
  /* **EvalDraw 那三档**（`evaldraw.txt:1627-1637`，见 `gl-rt.js` 的 `EVALDRAW_TEX`）：
     那门语言的 `glsettex` 没有槽号 —— 一参那一档的实参**可能是串、也可能是句柄**，
     所以这儿登记"第 0 格可以是串"，真是串字面量时 `callOf` 会去查 `#str0` 那个键。
     PolyDraw 没有一参那一档，所以这两行对它是空的（查不到名字就照旧落到设备调用）。 */
  ['glsettex/1', [0]],
  ['glremovetex/1', []],
  ['glgetattribloc/1', [0]],
  ['glvertexattrib1f/2', []],
  ['glvertexattrib2f/3', []],
  ['glvertexattrib3f/4', []],
  ['glvertexattrib4f/5', []],
]);

/** 把一格串内部到名字表里，回它的下标。 */
function internStr(C, s) {
  const had = C.strs.get(s);
  if (had !== undefined) return had;
  const i = C.strs.size;
  C.strs.set(s, i);
  return i;
}

/**
 * **切区段**（`@v` / `@g` / `@f` / `@h`，可带 `:名字`）。
 *
 * 口径照 `polydraw.txt:158-196`：区段头单独一行；`@(:名字)` 接着上一格的类；
 * `@h` 是宿主脚本（**只许一格**，多的取最后那一格）；没有 `@h` 时开头到第一个 `@` 就是宿主。
 * 没名字的区段给一格内部名（`$0`、`$1`…），设备上"没挑过就用第一对"。
 *
 * 这一层**只切不看**：着色器原文原样交给设备（要不要翻成 GLSL ES 是设备那一侧的事）。
 */
export function splitSections(src) {
  const out = [];
  let kind = null;
  let name = null;
  let buf = [];
  let anon = 0;
  let geo = null;
  const flush = () => {
    if (kind === null) return;
    out.push({
      kind,
      name: name === null ? `$${anon++}` : name,
      text: buf.join('\n'),
      geo,
    });
    buf = [];
    geo = null;
  };
  for (const line of String(src).split('\n')) {
    const t = line.trim();
    if (t.startsWith('@')) {
      /* 段首那一行：`@v`/`@f`/`@h`/`@g`，可带 `:名字`。
         **几何段还带三个参数**（`polydraw.txt:203`）：
         `@g,输入图元,输出图元,最大顶点数:名字` —— core profile 里那三样是两句 `layout`，
         所以要解出来带着走（从前这条正则只吃到 `@g`、名字与参数一起丢，
         于是 `glsetshader("v","g","f")` 找不着那一段、静默画不出东西）。 */
      const m = /^@([vgfh]?)((?:,[^:\n]*)?)(?::([A-Za-z0-9_$]+))?/.exec(t);
      if (m !== null) {
        flush();
        const k = m[1] === '' ? kind : ({ v: 'vert', g: 'geom', f: 'frag', h: 'host' })[m[1]];
        kind = k;
        name = m[3] === undefined ? null : m[3];
        geo = null;
        if (k === 'geom' && m[2] !== '') {
          const a = m[2].slice(1).split(',').map((x) => x.trim());
          geo = { in: a[0] ?? '', out: a[1] ?? '', max: Number(a[2] ?? 0) };
        }
        continue;
      }
    }
    if (kind !== null) buf.push(line);
  }
  flush();
  return out.filter((s) => s.kind !== 'host');
}

/** 一格 `(gfxdef 种类 名字 内容)`。 */
const gfxDefIR = (kind, name, text) => ({
  kind: 'builtin',
  name: 'gfxdef',
  args: [{ kind: 'string', value: kind }, { kind: 'string', value: String(name) },
    { kind: 'string', value: text }],
});
/**
 * **哪几格实参是"一整块"**（宿主/生成那一族里带数组的那几个）。
 *
 * 与 `SHADER_FNS`（哪几格是串）同一手：那几格实参按 `blockArg` 配对着发（块 + 偏移，
 * 见 `offName` 的头注），所以被调用的生成函数形参里也是两格。
 * 名字/元数照 `evaldraw.txt`：`sethlin(x0,y,buf,dx[,flags])` / `gethlin(x0,y,buf,dx)` /
 * `getpicsiz([名字,]&x,&y)`。
 */
const BLOCK_ARGS = new Map([
  ['sethlin/4', [2]], ['sethlin/5', [2]], ['gethlin/4', [2]],
  ['getpicsiz/2', [0, 1]], ['getpicsiz/3', [1, 2]],
]);

/** 宿主那边**无参的函数**（`KLOCK()`）。 */
const HOST_FNS0 = ['klock'];

/** 一格宿主调用：`(gfxcall "名字" 实参…)`。 */
const gfxCallIR = (name, args = []) => ({
  kind: 'builtin',
  name: 'gfxcall',
  args: [{ kind: 'string', value: name }, ...args],
});

const REAL = { kind: 'real' };
/** `static a[n]` 落成一格模块级的 `(arr real)`（长度在编译期就知道）。 */
const ARR = { kind: 'arr', elem: REAL };
const INT = { kind: 'int' };
const num = (v) => ({ kind: 'real', value: String(v) });
const nameRef = (n) => ({ kind: 'name', name: n });

/**
 * **装在一格数组里的量**（`&a` 那一族）：读写都走 `x[0]`。
 *
 * 这门语言的 `&a` 形参是"改得到调用方"（`eval.txt` 那张形参表的第二态）。标准 IR 里
 * 没有指针，所以凡是**被取过地址**的量都落成一格长度 1 的数组：实参传那一格数组本身，
 * 被调用的函数改的就是同一块。名单在 `C.boxed`（见 `collectBoxed`）。
 */
const boxRef = (n) => ({ kind: 'index', obj: nameRef(n), index: { kind: 'int', value: '0' } });

/** 这门语言的名字一律折小写（大小写不敏感）。 */
const low = (s) => String(s).toLowerCase();
const idOf = (x) => low(tag(x) === 'name' ? leaf(kids(x)[0]) : leaf(x));
const unquote = (s) => (s.startsWith('"') ? s.slice(1, -1) : s);

/* ─── 内建函数：名字 -> 怎么发 ───────────────────────────────────────────
 *
 * `rmath` 那一格是公共层的"转手宿主数学库"（名单在 `sexpr/lower.js` 的 RMATH）。
 * 名单里没有的（SGN / UNIT / INT / FACT）摊成表达式 —— 不往公共层加算子，
 * 那是这门语言自己的知识。
 */
const RMATH1 = new Map([
  ['sqrt', 'sqrt'], ['sqr', 'sqrt'], ['abs', 'fabs'], ['fabs', 'fabs'],
  ['sin', 'sin'], ['cos', 'cos'], ['tan', 'tan'],
  ['asin', 'asin'], ['acos', 'acos'], ['atan', 'atan'], ['atn', 'atan'],
  ['exp', 'exp'], ['log', 'log'], ['floor', 'floor'], ['ceil', 'ceil'],
]);
const RMATH2 = new Map([['atan2', 'atan2'], ['fmod', 'fmod'], ['pow', 'pow'], ['hypot', 'hypot']]);

/** 画图那一族的名字（碰到就报"要渲染那一侧"，不当普通调用）。**一门语言一张表**：
 *  PolyDraw 照 `polydraw.c:2070` 那张 `myext[]` 的前缀取；EvalDraw 那张在
 *  `ext/evaldraw/adapter.js` 里（照 `evaldraw_ref.md` / `evaldraw.txt`）。 */
export const POLYDRAW_HOST = {
  who: 'polydraw',
  spec: 'polydraw.c:2070 的 myext[]',
  /* 固定管线那一档落到同一块帧缓冲上（`gl-rt.js`）：`glBegin`/`glVertex`/`glColor`/
     矩阵栈/`gluPerspective`。着色器与纹理那两族**不在这张表里** —— 它们落到下面
     `gfx` 那条拒的路上（这条腿没有可编程管线，不装作有）。 */
  draw: POLYDRAW_GL,
  consts: GL_CONSTS,
  glrt: true,
  /* **每帧要把 GL 摆回初态**（`polydraw.c:3572-3579`）—— EvalDraw 那张表没有这一格。 */
  frameReset: true,
  gfx: ['gl', 'glu', 'kgl', 'setfov', 'printg', 'playnote', 'mountzip',
    /* `myext[]` 里还有这几族（`polydraw.c:2070`）：噪声、体素、画布文字、一次读一组输入。 */
    'noise', 'drawkv6', 'drawspr', 'drawvox', 'printchar', 'readmouse', 'setfont', 'sleep'],
};

const rmath = (fn, args) => ({ kind: 'rmath', fn, args });
const bin = (op, a, b) => ({ kind: 'binop', op, left: a, right: b });
const tern = (c, a, b) => ({ kind: 'ternary', cond: c, then: a, else_: b });
/** 一格值当条件用：`x != 0`（EVAL 的真值观）。 */
const truthy = (e) => bin('!=', e, num(0));
/** 一格 bool 当值用：`c ? 1 : 0`（这门语言里没有 bool 这种值）。 */
const asReal = (c) => tern(c, num(1), num(0));

const CMP = new Set(['==', '!=', '<', '<=', '>', '>=']);
const LOGIC = new Set(['&&', '||']);

/**
 * 表达式。`want` 是**位置**：`'val'` 要一格 real、`'cond'` 要一格 bool ——
 * 比较与 `&&`/`||`/`!` 在两种位置发的东西不同（见头注第 5 条）。
 */
function exprOf(x, C, want = 'val') {
  const t = tag(x);
  if (t === 'num') {
    const raw = String(leaf(kids(x)[0]));
    /* **十六进制**（语料里是键码那一族：`keystatus[0xc8]`、`0xffffff`）。方言的
       `(real …)` 只认十进制，原样递下去会当场报"(real 十进制小数)" —— 在这儿就折成那个数。 */
    const v = raw.length > 2 && raw[0] === '0' && (raw[1] === 'x' || raw[1] === 'X')
      ? num(Number(raw)) : num(raw);
    /* `while (1)` / `if (0)` —— 字面量也要按位置补 truthy（语料里 `while(1)` 很常见）。 */
    return want === 'cond' ? truthy(v) : v;
  }
  if (t === 'str') {
    return { kind: 'string', value: cUnescape(unquote(leaf(kids(x)[0]))) };
  }
  /* **字符字面量**（`'+'`、`'\n'`）：值是那个字符的编码（`RScript.htm` 算子表第二行
     "substitutes a character for its integer value"）。空的 `''` 当 0、多字符取第一个。 */
  if (t === 'chr') {
    const s = cUnescape(unquote(leaf(kids(x)[0])));
    const v = num(s.length === 0 ? 0 : s.charCodeAt(0));
    return want === 'cond' ? truthy(v) : v;
  }
  if (t === 'name') {
    const n = idOf(x);
    /* 内建常量。`PI` 在 `eval.txt` 里是内建；`RND`/`NRND` 是**无参函数**，
       写成光秃秃的名字也算调用（说明书 §"1-Param Operators" 那一行里就有它们）。 */
    if (n === 'pi') return num('3.14159265358979323846');
    if (n === 'e') return num('2.71828182845904523536');
    /* `RND` / `NRND` 光秃秃写着也算调用（`eval.txt` 的 "1-Param Operators" 那一行）。 */
    if (n === 'rnd' || n === 'nrnd') {
      C.needRnd = true;
      needRndSigs(C);
      const v = { kind: 'call', fn: nameRef(n === 'rnd' ? 'pd_rnd' : 'pd_nrnd'), args: [] };
      return want === 'cond' ? truthy(v) : v;
    }
    /* `enum` 是**编译期常量**（`eval.txt`：数组长度可以用它）—— 就地换成那个数。
       **除了被本函数里的量盖住的那几个**（见 `bodyOf` 里 `C.shadow` 的头注）。 */
    if (C.enums.has(n) && C.shadow?.has(n) !== true) return num(C.enums.get(n));
    /* 宿主的那批常量（PolyDraw 的 `GL_TRIANGLE_FAN` 之类：`myext[]` 里它们是
       "名字 -> 一格 double"）。值照 `GL/gl.h`，不是我们自己编的号。 */
    if (C.host.consts?.has(n)) return num(C.host.consts.get(n));
    /* **设备/联网不在场那四格**（见 `ABSENT_VARS` 的头注：值是说明书给的）。
       被本函数里的量盖住就不算（与 `enum` 那一格同一手）。 */
    if (ABSENT_VARS.has(n) && C.shadow?.has(n) !== true) {
      const v = num(ABSENT_VARS.get(n));
      return want === 'cond' ? truthy(v) : v;
    }
    /* **宿主给的那几格量**（`xres` / `yres` / `numframes`）：在宿主调用那条路上，
       读它们就是问设备一句 —— 每帧都可能不一样，所以不能折成常量。 */
    if (C.gfxHost && HOST_VARS.includes(n)) {
      C.needGfx = true;
      /* `HOST_FRAME` 那四格走语言这一侧的量（每帧开头盖一次，见 `HOST_WRITABLE` 的头注）。 */
      if (HOST_FRAME.includes(n)) {
        C.hostFrame.add(n);
        const g = nameRef(hvName(n));
        return want === 'cond' ? truthy(g) : g;
      }
      const v = gfxCallIR(n);
      return want === 'cond' ? truthy(v) : v;
    }
    const v = C.boxed.has(n) ? boxRef(n) : nameRef(n);
    return want === 'cond' ? truthy(v) : v;
  }
  if (t === 'neg') return { kind: 'unop', op: '-', operand: exprOf(kids(x)[0], C) };
  if (t === 'not') {
    const c = bin('==', exprOf(kids(x)[0], C), num(0));
    return want === 'cond' ? c : asReal(c);
  }
  if (t === 'bin') {
    const op = unquote(leaf(kids(x)[0]));
    const a = kids(x)[1];
    const b = kids(x)[2];
    /* `^` 是幂、`%` 是**按 |除数| 向下取整的模**（不是 `fmod`，不是整数取模 ——
       见 `needModSig` 那段注释里抄的 `eval.c:5141`）。两格都可能**直接站在条件位置**
       （`if (bstatus % 2)` 就是说明书里"消一次点击"的写法）—— 所以也要按位置补 truthy。 */
    if (op === '^' || op === '%') {
      let v;
      if (op === '^') {
        /* **`x^2` / `x^3` 落成乘法**（2026-09-25）：`pow` 是一次 libm 调用，而这门语言里
           `x^2+y^2 < r^2` 是最常见的写法 —— `tigrou/balls2k.pss` 的碰撞那一段里 `pow`
           占语言那一半 **17%** 的栈顶样本（`--gfx null` + `OMNI_PROF=sample:997`）。
           **只在底数是"重算一遍也没副作用"的简单式（名字或字面量）时折**：不然那一侧
           要出现两三次，复杂式子会被算两三遍。指数只认字面量 2 与 3 ——
           `0.5` 那档不折（`sqrt` 与 `pow(x,0.5)` 未必逐位相同）。 */
        const eb = exprOf(b, C);
        const ea = exprOf(a, C);
        const n = eb.kind === 'real' ? Number(eb.value) : NaN;
        if ((ea.kind === 'name' || ea.kind === 'real') && (n === 2 || n === 3)) {
          const sq = bin('*', exprOf(a, C), exprOf(a, C));
          v = n === 2 ? sq : bin('*', sq, exprOf(a, C));
        } else {
          v = rmath('pow', [ea, eb]);
        }
      } else {
        v = modIR(C, exprOf(a, C), exprOf(b, C));
      }
      return want === 'cond' ? truthy(v) : v;
    }
    if (CMP.has(op)) {
      const c = bin(op, exprOf(a, C), exprOf(b, C));
      return want === 'cond' ? c : asReal(c);
    }
    if (LOGIC.has(op)) {
      const c = bin(op, exprOf(a, C, 'cond'), exprOf(b, C, 'cond'));
      return want === 'cond' ? c : asReal(c);
    }
    const v = bin(op, exprOf(a, C), exprOf(b, C));
    return want === 'cond' ? truthy(v) : v;
  }
  if (t === 'index' || t === 'field') {
    /* **结构体那条路先看**（`vt[i].stuck`、`cam.x`、`cel[i][j].o`）：带类型的变量落成
       一块摊平的 double，偏移由 `fieldRef` 算（`.` 与 `[]` 混着来都认）。 */
    const fr = fieldRef(x, C);
    if (fr !== null) {
      const v = { kind: 'index', obj: nameRef(fr.name), index: withOff(fr.name, fr.index, C) };
      return want === 'cond' ? truthy(v) : v;
    }
    if (t === 'field') {
      throw new Error(`eval->IR: \`.${idOf(kids(x)[1])}\` 取字段的左边不是带类型的变量`
        + '（结构体要先 `struct { … } 类型名;` 再 `static 类型名 变量;`）');
    }
  }
  if (t === 'index') {
    const b = kids(x)[0];
    /* `keystatus[k]` 不是脚本自己的数组，是**问设备一句**（宿主那张表里它是一块 256 格的
       double）—— 所以先看这一格，再当普通下标。 */
    if (C.gfxHost && isList(b) && tag(b) === 'name' && HOST_ARRS.includes(idOf(b))) {
      C.needGfx = true;
      const h = gfxCallIR(idOf(b), [exprOf(kids(x)[1], C)]);
      return want === 'cond' ? truthy(h) : h;
    }
    /* `static a[n]` 那一族：多维摊成一块、下标过越界那一夹（见 `clampIdx`）。 */
    const ch = indexChain(x);
    if (isList(ch.base) && tag(ch.base) === 'name' && C.arrs.has(idOf(ch.base))) {
      const dims = C.arrs.get(idOf(ch.base));
      if (ch.chain.length > dims.length) {
        throw new Error(`eval->IR: \`${idOf(ch.base)}\` 是 ${dims.length} 维的数组，`
          + `这儿给了 ${ch.chain.length} 格下标（比维数还多）`);
      }
      const v = {
        kind: 'builtin',
        name: 'aget',
        args: [nameRef(idOf(ch.base)), withOff(idOf(ch.base), arrIndex(ch.chain, dims, C), C)],
      };
      return want === 'cond' ? truthy(v) : v;
    }
    /* 收整块的形参（`&a` / `a[]`）那一族：下标是**相对视图的**，所以要加那格偏移。 */
    if (isList(b) && tag(b) === 'name' && C.offs.has(idOf(b))) {
      const v = {
        kind: 'index',
        obj: nameRef(idOf(b)),
        index: withOff(idOf(b), toInt(exprOf(kids(x)[1], C)), C),
      };
      return want === 'cond' ? truthy(v) : v;
    }
    const v = { kind: 'index', obj: exprOf(b, C), index: exprOf(kids(x)[1], C) };
    return want === 'cond' ? truthy(v) : v;
  }
  if (t === 'call') {
    const v = callOf(x, C);
    return want === 'cond' ? truthy(v) : v;
  }
  if (t === 'addr') {
    /* `&x` 只在实参位置出现（配 `&a` 形参）。三种落法：
       * 被取过地址的**标量**（`C.boxed`）—— 它本来就是一格长度 1 的数组，直接把那格数组
         传过去，被调用的函数改的就是同一块（这就是"改得到调用方"）；
       * 本来就是**一块**的（数组 / 结构体，`&vec`）—— 也直接传那一块；
       * 别的形状（`&a[i]`、`&p.x`）当场报 —— 那要一格"带偏移的视图"，这一版没有。 */
    const a = kids(x)[0];
    if (isList(a) && tag(a) === 'name') {
      const n = idOf(a);
      if (C.boxed.has(n) || C.arrs.has(n) || C.svars.has(n)) return nameRef(n);
      /* **按值收的形参取地址**：那要给这一格形参也开个箱子（入口里拷一份进去），
         而调用方那一侧看不到这一趟改动 —— 两种落法差着语义，所以当场报，不猜。 */
      if (C.valParams.has(n)) {
        throw new Error(`eval->IR: \`&${n}\` 里的 \`${n}\` 是**按值**收的形参 ——`
          + ' 这一版不接（要么把这格形参写成 `&' + n + '`，要么先抄进一格局部量）');
      }
    }
    throw new Error('eval->IR: `&` 只接名字（`&x` / `&一整块`）—— '
      + `这儿是 ${isList(a) ? tag(a) : '别的东西'}，那要一格带偏移的视图，这一版没有`);
  }
  if (t === 'postinc' || t === 'postdec' || t === 'preinc' || t === 'predec') {
    throw new Error(`eval->IR: \`${t}\` 只在语句位置接了（EVAL 一句只许一个赋值）`);
  }
  throw new Error(`eval->IR: 这一格表达式还没接：${t}`
    + `（形状：${JSON.stringify(x).slice(0, 160)}）`);
}

/* ─── 调用 ───────────────────────────────────────────────────────────── */

/**
 * **一格"整块"实参 -> `{ name, off }`**（那一格形参占两格：块本身 + 偏移）。
 * 口径在 `docs/design/eval-realtime-gpu.md` 第 8.6 节。
 *
 * 认四种形状（`&` 写不写都一样 —— 被调用方要的是一整块）：
 *   * `a`（名字）—— 装箱的标量、数组、结构体；自己也可能是视图，那就把它那格偏移带上；
 *   * `a[i]` / `a[i][j]` —— 摊平下标就是偏移（"从这一格起的那一段"）；
 *   * `p.x` / `vt[i].f` —— `fieldRef` 算出来的那个数就是偏移；
 *   * 别的（表达式、调用回来的值）—— **当场报**：这一版没有"临时块"。
 */
function blockArg(raw, C, fname) {
  /* 偏移形参是 real（这门语言只有 double），而摊平下标算出来是 int ⇒ 过一次 `toreal`。 */
  const asReal2 = (e) => (e.kind === 'real' ? e : { kind: 'builtin', name: 'toreal', args: [e] });
  const x = isList(raw) && tag(raw) === 'addr' ? kids(raw)[0] : raw;
  if (isList(x) && tag(x) === 'name') {
    const nm = idOf(x);
    if (C.boxed.has(nm) || C.arrs.has(nm) || C.svars.has(nm) || C.offs.has(nm)) {
      return { name: nm, off: asReal2(offOf(nm, C) ?? num(0)) };
    }
    if (C.valParams.has(nm)) {
      throw new Error(`eval->IR: \`&${nm}\` 里的 \`${nm}\` 是**按值**收的形参 ——`
        + ' 这一版不接（要么把这格形参写成 `&' + nm + '`，要么先抄进一格局部量）');
    }
    throw new Error(`eval->IR: \`${fname}\` 这一格形参要的是一整块，`
      + `而 \`${nm}\` 既不是数组/结构体、也没被取过地址`);
  }
  if (isList(x) && (tag(x) === 'index' || tag(x) === 'field')) {
    /* **整块**那一支先看（`clear(box[i],…)` 递的是一整个 `box_t`、`g.play` 递的是一整排）：
       偏移按结构体大小算，不是按"第 i 个 double"。放在 `fieldRef` 之前 —— 那一格
       只认落到一个数的路径，整块会当场报。 */
    const b = blockOperand(x, C);
    if (b !== null && b.weak !== true) return { name: b.name, off: asReal2(blockSlot(b, null, C)) };
    /* 结构体那条路（`&p.x`、`&vt[i].f`）：偏移就是 `fieldRef` 算出来的那个数。 */
    const fr = fieldRef(x, C);
    if (fr !== null) return { name: fr.name, off: asReal2(withOff(fr.name, fr.index, C)) };
  }
  if (isList(x) && tag(x) === 'index') {
    const ch = indexChain(x);
    if (isList(ch.base) && tag(ch.base) === 'name') {
      const nm = idOf(ch.base);
      if (C.arrs.has(nm)) {
        const dims = C.arrs.get(nm);
        if (ch.chain.length !== dims.length) {
          throw new Error(`eval->IR: \`&${nm}[…]\` 给了 ${ch.chain.length} 格下标，`
            + `而它是 ${dims.length} 维的（多维摊成一块，维数要对齐）`);
        }
        return { name: nm, off: asReal2(withOff(nm, arrIndex(ch.chain, dims, C), C)) };
      }
      if (C.offs.has(nm) && ch.chain.length === 1) {
        return { name: nm, off: asReal2(withOff(nm, toInt(exprOf(ch.chain[0], C)), C)) };
      }
    }
  }
  throw new Error(`eval->IR: \`${fname}\` 这一格形参要的是一整块，这儿给的是`
    + ` ${isList(x) ? tag(x) : '别的东西'} —— 只接名字 / \`a[i]\` / \`p.x\` 这三种`);
}

function callOf(x, C) {
  const head = kids(x)[0];
  if (tag(head) !== 'name') throw new Error('eval->IR: 调用的不是一个名字（函数指针还没接）');
  const n = idOf(head);
  /**
   * **`readtouch(&id,&x,&y)`**（EvalDraw，`evaldraw.txt:1413`）：读多点触摸。
   *
   * 这台机器上**没有触摸设备**，所以照那份说明书自己的协议回"没有点了"——
   * 返回 `-1`，出参一个都不写。
   *
   * 为什么不写出参也是对的：说明书那句是 *"Start id as -1, then continue reading until
   * id is set to -1"* —— **调用方必须先把 `id` 置成 -1**，语料里三处都照做了
   * （`for(id=-1;readtouch(&id,&x,&y)>=0;)` 两处、`id = -1; while(1){ readtouch(…);
   * if (id < 0) break; …}` 一处）。所以 `id` 本来就是 -1，我们不写它，行为与"真硬件
   * 但没有触点"逐句相同。
   *
   * 为什么拦在这儿（而不是像 `readmouse` 那样摊成几句赋值）：那三处里**两处是在
   * 表达式位置**（`for` 的条件），摊成语句摊不进去；而 `&id` 这种实参光过 `exprOf`
   * 会当场报（局部量取地址这一档方言里没有）—— 所以要在**算实参之前**拦。
   */
  if (C.host.who === 'evaldraw' && n === 'readtouch') return num(-1);
  /**
   * **`fputc(v)`**（EvalDraw，`evaldraw.txt:1525`）：与 `printchar` 像，但那个字符
   * **只在"capture (next frame's output) to file (F6)"开着的时候**进文件
   * （那门语言里连文件句柄都没有 —— "only 1 file can be saved at a time"）。
   *
   * 我们这一侧没有 F6 那一档 ⇒ **capture 是关着的**，照说明书那句，这个字符哪儿都不去。
   * 所以这一格就是个收下不管的空操作（回 0）。
   *
   * 一句明写的偏差：**实参不求值**。语料里那两份（`geeky/pi.kc:122`、
   * `geeky/circtris.kc` 那十几处）的实参都是纯算术，没有副作用；真碰上
   * `fputc(i++)` 这种得改成"算一遍再丢"。
   */
  if (C.host.who === 'evaldraw' && n === 'fputc') return num(0);


  /* **可编程管线那一族**先看：它的实参里可能有**串**（着色器名 / uniform 名），
     而 `exprOf` 把串落成 `{kind:'string'}` —— 那格进不了宿主面（只收 double）。
     所以这儿把串内部到名字表里换成下标（表在入口里登记，见 `gfxDefIR`）。
     换完之后**照 `draw` 那张表走**（第四刀：这一族也落在 `gl-rt.js` 上 —— 顶点与批
     在语言这一侧，program 与 uniform 才转给设备）。 */
  if (C.gfxHost) {
    const raw = kids(x).slice(1);
    const strAt = SHADER_FNS.get(`${n}/${raw.length}`);
    if (strAt !== undefined) {
      C.needGfx = true;
      C.usedGL = true;
      /* 哪几格**真的**是串字面量（登记过的位置不一定次次都递串 —— EvalDraw 的
         `glsettex(句柄)` 与 `glsettex("wood.png")` 是同一个名字/元数）。 */
      const strGot = [];
      const arrGot = [];
      const as = raw.map((a, i) => {
        if (strAt.includes(i) && isList(a) && tag(a) === 'str') {
          strGot.push(i);
          return num(internStr(C, cUnescape(unquote(leaf(kids(a)[0])))));
        }
        if (isList(a) && tag(a) === 'name' && C.arrs.has(idOf(a))) arrGot.push(i);
        return exprOf(a, C);
      });
      /* **形状挑名字**：递了串的那几格拼成 `#str0`、递了整块的拼成 `#arr0`
         （多格就 `#str0,1`），按"串 -> 块 -> 光名字"的次序各查一次 ——
         同一个名字/元数在不同实参形状下是**不同的宿主函数**时用这一格
         （只有 EvalDraw 那三档 `glsettex` 用到，见 `gl-rt.js` 的 `EVALDRAW_TEX`）。 */
      const keys = [];
      if (strGot.length > 0) keys.push(`${n}/${as.length}#str${strGot.join(',')}`);
      if (arrGot.length > 0) keys.push(`${n}/${as.length}#arr${arrGot.join(',')}`);
      keys.push(`${n}/${as.length}`);
      const glFn = C.host.glrt === true
        ? keys.map((k) => C.host.draw?.get(k)).find((v) => v !== undefined)
        : undefined;

      if (glFn !== undefined) {
        C.needGL = true;
        return { kind: 'call', fn: nameRef(glFn), args: as };
      }
      return gfxCallIR(n, as);
    }

  }
  /* **宿主调用的串实参一律换成名字表下标**（`glsettex(0,"earth.jpg")` 那一族）：
     宿主面只收 double，所以串在入口里内部到名字表、这儿发它的下标（与 `SHADER_FNS`
     那一段同一手 —— 那一段是"哪几格实参是串"的白名单，这一格是兜底的一般规矩）。
     只在宿主调用那条路上这么做：普通函数的串实参照旧原样递下去。 */
  const rawArgs = kids(x).slice(1);
  /* **脚本自己定义的函数先看**（在算实参之前）：它的"整块"形参要按对配（块 + 偏移），
     而 `&a[i]` 这种实参单独过 `exprOf` 会当场报 —— 所以不能先把实参都算出来。
     同名时以脚本自己那一份为准（它写了同名函数，本意就是覆盖）。 */
  if (C.fns.has(n)) {
    /**
     * **收整块的那几个形参各占两格**（块本身 + 那格偏移，见 `offName` 的头注）——
     * 所以实参要按被调用方那张表**配对**着发：
     *
     *     f(&a)        -> (a, 0)
     *     f(&a[i])     -> (a, 那一格的摊平下标)          ← "从第 i 格起的那一段"
     *     f(&p.x)      -> (p, 字段偏移)
     *     f(a)         -> (a, a$o)                      ← 整块往下传（自己也可能是视图）
     *     f(x)（标量）  -> 照旧一格
     */
    const want = C.fns.get(n).params;
    const out = [];
    let wi = 0;
    for (const raw of rawArgs) {
      if (want[wi] === ARR) {
        const bl = blockArg(raw, C, n);
        out.push(nameRef(bl.name), bl.off);
        wi += 2;
      } else {
        out.push(exprOf(raw, C));
        wi += 1;
      }
    }
    return { kind: 'call', fn: nameRef(n), args: out };
  }
  /* **设备/对方不在场那一族**（`readmag6d` / `net_recv` / `net_send`，见 `ABSENT_FNS`
     的头注）：回 0，**实参一格都不算** —— 它们全是出参地址，算它们会当场报。
     摆在脚本自己那张表**后头**：脚本写了同名函数就以它为准。 */
  if (ABSENT_FNS.has(n)) return num(0);
  const hostish = C.gfxHost
    && (C.host.draw?.has(`${n}/${rawArgs.length}`) === true
      || HOST_FNS0.includes(n)
      || C.host.gfx.some((p) => n === p || n.startsWith(p)));
  const args = rawArgs.map((a) => (hostish && isList(a) && tag(a) === 'str'
    ? num(internStr(C, cUnescape(unquote(leaf(kids(a)[0])))))
    : exprOf(a, C)));

  if (RMATH1.has(n) && args.length === 1) return rmath(RMATH1.get(n), args);
  if (RMATH2.has(n) && args.length === 2) return rmath(RMATH2.get(n), args);
  /* `LOG` 两种元数：一参是自然对数、二参是"以第二个为底"（`eval.txt`）。 */
  if (n === 'log' && args.length === 2) {
    return bin('/', rmath('log', [args[0]]), rmath('log', [args[1]]));
  }
  if (n === 'min' && args.length === 2) return tern(bin('<', args[0], args[1]), args[0], args[1]);
  if (n === 'max' && args.length === 2) return tern(bin('>', args[0], args[1]), args[0], args[1]);
  /* `INT` 朝零取整（**不是** floor）：负数走 ceil。 */
  if (n === 'int' && args.length === 1) {
    return tern(bin('<', args[0], num(0)), rmath('ceil', [args[0]]), rmath('floor', [args[0]]));
  }
  /* `NEAR(x)`：**就近取整**（语料里 `geeky/circtris.kc` / `games/traffic.kc` 那一族用它
     把浮点量成格子）—— 与我们别处的 `dtol` 同一手：`floor(x+0.5)`。 */
  if (n === 'near' && args.length === 1) {
    return rmath('floor', [bin('+', args[0], num(0.5))]);
  }
  /* `SGN`：负 -1、正 1、零 0。`UNIT`：负 0、正 1、零 .5（说明书那两行）。 */
  if (n === 'sgn' && args.length === 1) {
    return tern(bin('<', args[0], num(0)), num(-1),
      tern(bin('>', args[0], num(0)), num(1), num(0)));
  }
  if (n === 'unit' && args.length === 1) {
    return tern(bin('<', args[0], num(0)), num(0),
      tern(bin('>', args[0], num(0)), num(1), num(0.5)));
  }
  if ((n === 'rnd' || n === 'nrnd') && args.length === 0) {
    C.needRnd = true;
    needRndSigs(C);
    return { kind: 'call', fn: nameRef(n === 'rnd' ? 'pd_rnd' : 'pd_nrnd'), args: [] };
  }
  /* `SRAND(种)`：照 `ksrand`（`eval.c:491`）—— 设种子。落成一格函数（它在语料里
     既当语句用也可能站在表达式位置，回 0）。 */
  if (n === 'srand' && args.length === 1) {
    C.needRnd = true;
    needRndSigs(C);
    return { kind: 'call', fn: nameRef('pd_srand'), args };
  }
  /* `FACT` 走 gamma（说明书：It calculates factorials using the gamma function）。
     这一版只接**非负整数**那一档：一格自己的循环函数（`pd_fact`，下面发出来）。 */
  if (n === 'fact' && args.length === 1) {
    /* 签名也要登记：格式串那台机器按 `fns` 查返回类型 —— 不登记就被当 int，
       于是它会在已经是 real 的东西上再发一格 `(toreal …)`，方言当场报。 */
    C.needFact = true;
    C.fns.set('pd_fact', { params: [REAL], ret: REAL });
    return { kind: 'call', fn: nameRef('pd_fact'), args };
  }

  if (C.fns.has(n)) {
    /* 已经在上头（算实参之前）接住了 —— 这儿不该再走到。 */
    throw new Error(`eval->IR: \`${n}\` 这一格调用走漏了（内部错）`);
  }

  /* **画图那一族**：这一门的宿主表里有的，落成生成出来的设备函数（`gfx-rt.js`）。
     设备就是一块帧缓冲 —— 清单/像素都在进程里，跨出去的只有一帧表面。 */
  const drawFn = C.host.draw?.get(`${n}/${args.length}`);
  if (drawFn !== undefined) {
    C.needGfx = true;
    /* GL 那一族（固定管线 + 着色器）用过没有 —— 每帧的 GL 初态只给用过的脚本发。 */
    if (drawFn.startsWith('gl_')) C.usedGL = true;
    /* **GL 那一族永远走生成出来的那一份**（`gl-rt.js`），连宿主设备那条路也走它 ——
       "只有一个模型"（`docs/design/eval-realtime-gpu.md` 第 9 节）：命令变顶点、合批、
       拆 mode 全在语言这一侧，设备只收顶点批。
       原来在宿主那条路上把 `glbegin/glvertex/…` 原样递给设备，于是 CPU 备选那一档
       （它那张名字表里没有 GL）当场报"不认识 framebegin" —— 语料里 39 份 GL 脚本
       一张图都出不来。 */
    if (C.host.glrt === true && drawFn.startsWith('gl_')) {
      C.needGL = true;
      return { kind: 'call', fn: nameRef(drawFn), args };
    }
    /* **3D 那一族永远走生成出来的那一份**（`gfx3-rt.js`）：投影是纯算术，按"只有一个
       模型"放在语言这一侧 —— 设备只收投影完的 2D 图元（声音那几格也在这张表里，收下不响）。 */
    if (drawFn.startsWith('g3_')) {
      C.need3D = true;
      /* 带数组实参的那几格（`BLOCK_ARGS`）：那一格发两个 —— 块本身 + 偏移。 */
      const blk = BLOCK_ARGS.get(`${n}/${rawArgs.length}`);
      if (blk !== undefined) {
        const out = [];
        rawArgs.forEach((raw, i) => {
          if (!blk.includes(i)) { out.push(exprOf(raw, C)); return; }
          const bl = blockArg(raw, C, n);
          out.push(nameRef(bl.name), bl.off);
        });
        return { kind: 'call', fn: nameRef(drawFn), args: out };
      }
      return { kind: 'call', fn: nameRef(drawFn), args };
    }
    /* **宿主调用那条路**：一格 `(gfxcall "名字" 实参…)`，设备在宿主那一侧。
       名字与元数原样交过去 —— 设备按 `名字/个数` 分派（与这张表同一条口径）。 */
    if (C.gfxHost) return gfxCallIR(n, args);
    return { kind: 'call', fn: nameRef(drawFn), args };
  }
  /* 宿主那边的 `KLOCK()` / `KLOCK(档)` —— 同一条路，也是问设备一句
     （`tigrou/clock.pss:10` 用的是一参那档：`klock(1)`）。 */
  if (C.gfxHost && HOST_FNS0.includes(n) && args.length <= 1) {
    C.needGfx = true;
    return gfxCallIR(n, args);
  }

  /* **噪声那一族**（`NOISE(x[,y[,z]])` / `NOISE3D(x,y,z)`）：纯函数，落成生成出来的 IR
     （`noise-rt.js`，照 `polydraw.c:852` 那份算法）—— 不进设备，四条腿逐字节相同。
     摆在设备那一支前头：它的名字以 `noise` 开头，会被那张前缀表捞走。 */
  const noiseFn = NOISE_FNS.get(`${n}/${args.length}`);
  if (noiseFn !== undefined) {
    C.needNoise = true;
    C.fns.set(noiseFn, { params: args.map(() => REAL), ret: REAL });
    return { kind: 'call', fn: nameRef(noiseFn), args };
  }

  /* 画图那一族：**按这一门的宿主表判**（`C.host`）。两门语言共用这一份 adapter，
     差别只在这张表 —— PolyDraw 是 GL 立即模式（`polydraw.c:2070` 的 myext[]）、
     EvalDraw 是 `cls/setcol/setpix/moveto/lineto/drawsph/drawcone/…`（`evaldraw_ref.md`）。 */
  if (C.host.gfx.some((p) => n === p || n.startsWith(p))) {
    /* **宿主调用那条路上一律交给设备**：一门语言的宿主面有几十格，而"这一格能不能做"
       是**设备**的事（浏览器 WebGL2 有着色器与纹理、CPU 备选没有 z 缓冲、本机 OpenGL
       什么都有）。所以 adapter 这一层不再替设备拒绝 —— 名字原样递过去，设备接不住时
       它自己报（那条错里写着"这一档有的是哪几格"，比编译期的清单准）。
       录制那一档（`--gfx null`）照旧：设备认所有名字、记一笔回 0。 */
    if (C.gfxHost) return gfxCallIR(n, args);
    throw new Error(`${C.host.who}->IR: \`${n}\` 这一格宿主函数生成出来的那一档没有落点`
      + '（固定管线那一档已经接了：glClear/glBegin/glEnd/glVertex/glColor/矩阵栈/gluPerspective；'
      + '**着色器与纹理那两族要走设备** —— 加 --gfx host。'
      + `口径是 ${C.host.spec}）`);
  }
  /* **`fadd`/`fsub`/`fmul`/`fdiv`**（RScript.htm 的内建库那张表）："Forces addition without
     interference from the optimizer" —— 那是给量化小把戏留的（`fadd(x,3*2^51)-3*2^51`）。
     我们这儿落成**普通算术**：语义是同一个，只是不保证优化器不合并它 ——
     **已知偏差**，写在这儿免得日子久了当成"接好了"。 */
  const FARITH = { fadd: '+', fsub: '-', fmul: '*', fdiv: '/' };
  if (FARITH[n] !== undefined && args.length === 2) return bin(FARITH[n], args[0], args[1]);
  /* **`sizeof(名字)`**：编译期的**槽数**（不是字节）。口径是 `evaldraw.txt:1513`
     那一行 —— `bufset(dst,val,n)` 等于 `for(i=0;i<n;i++) dst[i]=val`，而语料里就写
     `bufset(trilistn,-1,sizeof(trilistn))`（`demos/minsurf.kc:338`）⇒ n 是元素个数。
     认三种：`static` 数组（各维之积）、带类型的变量（总槽数）、结构体类型名（它的槽数）。 */
  if (n === 'sizeof' && rawArgs.length === 1) {
    const a0 = rawArgs[0];
    if (isList(a0) && tag(a0) === 'name') {
      const nm = idOf(a0);
      if (C.arrs.has(nm)) return num(C.arrs.get(nm).reduce((p, q) => p * q, 1));
      if (C.structs.has(nm)) return num(C.structs.get(nm).size);
      return num(1);                       /* 一格普通量就是一个 double */
    }
    throw new Error('eval->IR: `sizeof` 只收一个名字（数组、带类型的变量或结构体类型名）');
  }
  throw new Error(`${C.host.who}->IR: 不认识的函数 \`${n}\``);
}

/* ─── 语句 ───────────────────────────────────────────────────────────── */

/** 赋值的目标：名字、下标，或结构体的字段。 */
function targetOf(x, C) {
  if (tag(x) === 'name') {
    const n = idOf(x);
    return C.boxed.has(n) ? boxRef(n) : nameRef(n);
  }
  if (tag(x) === 'index' || tag(x) === 'field') {
    /* 结构体那条路先看（`vt[i].stuck = 1`）—— 与读那一侧同一格 `fieldRef`。 */
    const fr = fieldRef(x, C);
    if (fr !== null) {
      return { kind: 'index', obj: nameRef(fr.name), index: withOff(fr.name, fr.index, C) };
    }
  }
  if (tag(x) === 'index') {
    /* `static a[n]` 那一族：与读那一侧同一条路（摊平 + 越界那一夹）。 */
    const ch = indexChain(x);
    if (isList(ch.base) && tag(ch.base) === 'name' && C.arrs.has(idOf(ch.base))) {
      const dims = C.arrs.get(idOf(ch.base));
      if (ch.chain.length > dims.length) {
        throw new Error(`eval->IR: \`${idOf(ch.base)}\` 是 ${dims.length} 维的数组，`
          + `这儿给了 ${ch.chain.length} 格下标（比维数还多）`);
      }
      return {
        kind: 'index',
        obj: nameRef(idOf(ch.base)),
        index: withOff(idOf(ch.base), arrIndex(ch.chain, dims, C), C),
      };
    }
    /* 收整块的形参那一族：下标相对视图，要加那格偏移（与读那一侧同一手）。 */
    const b0 = kids(x)[0];
    if (isList(b0) && tag(b0) === 'name' && C.offs.has(idOf(b0))) {
      return {
        kind: 'index',
        obj: nameRef(idOf(b0)),
        index: withOff(idOf(b0), toInt(exprOf(kids(x)[1], C)), C),
      };
    }
    return { kind: 'index', obj: exprOf(kids(x)[0], C), index: exprOf(kids(x)[1], C) };
  }
  throw new Error(`eval->IR: 赋不到这一格上：${tag(x)}`);
}

/** `x++` / `++x` / `x--` 一律摊成 `x = x ± 1`（EVAL 一句只许一个赋值，所以只在语句位置）。 */
function stepOf(x, C, delta) {
  const ht = hostTargetOf(kids(x)[0], C);
  if (ht !== null) return hostStore(ht, delta > 0 ? '+=' : '-=', num(1), C);
  const tgt = targetOf(kids(x)[0], C);
  return { kind: 'assign', target: tgt, value: bin(delta > 0 ? '+' : '-', tgt, num(1)) };
}

/**
 * 赋值的目标是不是**宿主那一侧**的量？回 `{ name, index }`（`index` 是 `keystatus[k]`
 * 里那格下标的 IR，别的量是 `null`），不是就回 `null`。
 */
function hostTargetOf(x, C) {
  if (!C.gfxHost || !isList(x)) return null;
  if (tag(x) === 'name' && HOST_VARS.includes(idOf(x))) return { name: idOf(x), index: null };
  if (tag(x) === 'index') {
    const b = kids(x)[0];
    if (isList(b) && tag(b) === 'name' && HOST_ARRS.includes(idOf(b))) {
      return { name: idOf(b), index: exprOf(kids(x)[1], C) };
    }
  }
  return null;
}

/**
 * 往宿主那一侧写一格（`bstatus--`、`keystatus[0xc8] = 0`）——
 * 落成 `(gfxcall "setbstatus" v)` / `(gfxcall "setkeystatus" k v)`，方言里仍然只有一格 op。
 *
 * `op` 不是 `=` 的时候（`-=` / `bstatus--` 摊出来的那种）读那一格也是问设备一句，于是
 * **下标那棵树会发两份**（读一次、写一次）。EVAL 的下标是纯算术，没有副作用，所以成立；
 * 真要接带副作用的下标得先落一格临时量 —— 记在这儿。
 */
function hostStore(ht, op, val, C) {
  if (!HOST_WRITABLE.has(ht.name)) {
    throw new Error(`${C.host.who}->IR: \`${ht.name}\` 是宿主给的只读量，赋不进去`
      + '（`numframes` 由宿主每帧递增 —— polydraw.c:2354）');
  }
  C.needGfx = true;
  /* `HOST_FRAME` 那四格是**这一帧里的一格量**（宿主下一帧会盖掉）——
     所以写就是往语言这一侧那格量上写，不发宿主调用。 */
  if (HOST_FRAME.includes(ht.name)) {
    C.hostFrame.add(ht.name);
    const tgt = nameRef(hvName(ht.name));
    if (op === '=') return { kind: 'assign', target: tgt, value: val };
    const core = op.slice(0, 1);
    const v = core === '%' ? modIR(C, tgt, val) : bin(core, tgt, val);
    return { kind: 'assign', target: tgt, value: v };
  }
  let v = val;
  if (op !== '=') {
    const read = ht.index === null ? gfxCallIR(ht.name) : gfxCallIR(ht.name, [ht.index]);
    const core = op.slice(0, 1);
    v = core === '%' ? modIR(C, read, val) : bin(core, read, val);
  }
  const args = ht.index === null ? [v] : [ht.index, v];
  return { kind: 'expr-stmt', expr: gfxCallIR(`set${ht.name}`, args) };
}

/**
 * **`ir` 那一档（产物自带光栅器）把落点烧进产物里** —— 所以它只认"这份脚本的默认落点"
 * （`OMNI_GFX_OUT_DEFAULT`，CLI 按脚本名 + 缓存根算的），**不认 `-o`**：
 * 那一格是每趟都可能变的，烧进产物就与缓存的印记打架（产物按内容作键）。
 * 要换落点就走宿主设备那条路（默认那条）。拿不到那格环境变量（`omni build` 出来的
 * 独立产物）就还是那句老兜底。
 */
function irOutPath() {
  const p = env('OMNI_GFX_OUT_DEFAULT');
  return p === undefined || p === null || p === '' ? '.omni-cache/gfx/frame.png' : p;
}


/**
 * **`goto` / `label:`**（RScript 的关键字表里那两行）。标准 IR 里没有无条件跳转，
 * 所以这儿只接**往前跳**那一档，落法是一格**旗子**（经典的 goto 消除法）：
 *
 *     ... goto skip; ...        ->    pd_go_skip = 0;
 *     skip:                            if (!pd_go_skip) { ... pd_go_skip = 1; ... }
 *     后面的语句                        后面的语句
 *
 * 也就是：从这一格语句表的开头到 `skip:` 那一句之间（**含嵌套**）每一句都加一层
 * `if (旗子 == 0)`，循环的条件上再 `&& 旗子 == 0` —— 于是 `goto` 一置旗，控制流
 * 就一路退到标号那儿。语义与真跳转相同，代价是那一段里每句多一格判断（只有用了
 * `goto` 的函数摊这份）。
 *
 * **往后跳**（`goto` 在标号后头，`games/kenken.kc:909` 的 `goto back2it` 那种循环）
 * 落成"标号到这段末尾包进 `while (旗子)`"（见 `stmtsOf`）。
 *
 * **跳进块里**（标号在 `if {}` 里头、`goto` 在外层，`ken/drawcone2.pss` 的 `goto singsph`）
 * 落成**照抄那一段**：护卫那一招只退得出去、退不进去，而那一段（标号到它那格语句表末尾）
 * 只要**不会走到底**（末句是 `goto`/`return`）就可以原样在跳转点再降一份 —— 原处那一段
 * 照旧留着给顺着走下来的那条路。见 `stmtOf1` 的 `goto` 那一格。
 *
 * 往前跳那一族还有两种形状（2026-09-26 补，语料里各占几份）：
 *
 * * **跳进一格循环体里**（`games/backgammon.kc:890` 的 `ls=0; goto in2it; do{…in2it:…}while(1)`、
 *   `games/kenken.kc:503` 的 `goto in2y`）—— 经典的**循环入口旗子**：goto 那儿置旗、
 *   循环照常进、体里标号前头那一段在旗子起着的那一趟整段跳过、标号那儿清旗，
 *   循环的条件上 OR 一格旗子（原文那一跳压根没测过条件）。见 `loopEntryAt`。
 * * **往前跳进一格嵌套里**（`games/chess/chess.kc:162` 跳进 `if (n==0){dowin:…}`、
 *   `games/bowling/bowling.kc:119` 从 `if` 的这一支跳进 `else` 那一支）—— 旗子护卫
 *   **到那句为止**（于是控制流退到那句后头），而标号那儿本该跑的那一段（含一路上外层的
 *   尾巴）在 goto 那儿照抄一份先跑掉。见 `blockEntryAt`。
 *
 * **往后跳进一格嵌套里**（`games/kenken.kc:909` 的 `goto back2it`：标号在两层 `if` 里头
 * 那格 `while` 的体上）要**两格旗子**：绕回旗把"那句起到这段末尾"包进 `while (绕回旗)`
 * （与往后跳那一档同一招），进入旗把那条路上每一格判断改成"起着就一定走"、标号那儿清掉。
 * 见 `pathEntryAt` 与 `entryLower`。
 */

const gotoFlag = (name) => `pd_go_${name}`;

/** 这一格语句表里第一个标号的位置（没有就是 -1）。 */
function labelAt(list) {
  return list.findIndex((s) => isList(s) && tag(s) === 'label');
}

/** 一段（**一串语句**）里 `goto` 到的标号名（含嵌套）。 */
function gotoNames(list, out = new Set()) {
  for (const s of list) gotoNamesIn(s, out);
  return out;
}

function gotoNamesIn(x, out) {
  if (!isList(x)) return out;
  if (tag(x) === 'goto') { out.add(idOf(kids(x)[0])); return out; }
  for (const k of kids(x)) gotoNamesIn(k, out);
  return out;
}

/** 一格循环（三种写法）的**体**；不是循环就 undefined。 */
function loopBodyOf(s) {
  const t = tag(s);
  const k = kids(s);
  if (t === 'while') return k[1];
  if (t === 'dowhile') return k[0];
  if (t === 'for') return k[3];
  return undefined;
}

/**
 * **跳进循环体里**那一档：这格语句表上有没有"一格循环、它体上头一层摆着某个标号、
 * 而 `goto` 到那个标号的在循环**前头**"（`games/backgammon.kc:890`、
 * `games/kenken.kc:503`）—— 有就回 `{ j, name, flag }`（`j` 是那格循环的位置）。
 */
function loopEntryAt(list) {
  for (let j = 0; j < list.length; j += 1) {
    if (!isList(list[j])) continue;
    const b = loopBodyOf(list[j]);
    if (b === undefined || !isList(b) || tag(b) !== 'block') continue;
    const at = labelAt(kids(b));
    if (at < 0) continue;
    const name = idOf(kids(kids(b)[at])[0]);
    if (!gotoNames(list.slice(0, j)).has(name)) continue;
    /* 循环体里也有人跳到它 ⇒ 那是体那一格自己的事（前/后两种落法），这儿不碰。 */
    if (gotoNames(kids(b).slice(0, at)).has(name)) continue;
    if (gotoNames(kids(b).slice(at + 1)).has(name)) continue;
    return { j, name, flag: gotoFlag(name) };
  }
  return null;
}

/**
 * 一句语句（含嵌套的 `block` / `if`）里找 `name:` 这个标号 —— 找到就回**那几段"往后的
 * 尾巴"**：标号自己那格语句表的尾，再一路上外层每格表的尾（内层在前，正是"落下来"
 * 的次序）。路上碰到循环就回 null（那要另一种落法，见 `loopEntryAt`）。
 */
function labelTails(s, name) {
  if (!isList(s)) return null;
  const t = tag(s);
  if (t === 'label') return idOf(kids(s)[0]) === name ? [] : null;
  if (t === 'block') {
    const list = kids(s);
    for (let i = 0; i < list.length; i += 1) {
      const r = labelTails(list[i], name);
      if (r !== null) return [...r, list.slice(i + 1)];
    }
    return null;
  }
  if (t === 'if') {
    for (const b of kids(s).slice(1)) {
      const r = labelTails(b, name);
      if (r !== null) return r;
    }
    return null;
  }
  return null;
}

/**
 * **往前跳进一格块里**那一档：`goto` 在这格语句表上（含嵌套）、标号在后头某一句
 * **里头**（`games/chess/chess.kc:162` 跳进 `if (n==0) {…}`、
 * `games/bowling/bowling.kc:119` 从 `if` 的这一支跳进 `else` 那一支）。
 * 回 `{ j, name, flag, region }`：`region` 是标号那儿往后要**照抄一份**的那几句。
 */
function blockEntryAt(list, C) {
  for (let j = 0; j < list.length; j += 1) {
    if (!isList(list[j])) continue;
    for (const name of gotoNames(list.slice(0, j + 1))) {
      if (C.gotoCopy.has(name)) continue;    /* 这一格正在降（下面那一层的递归）—— 别再拆一遍 */
      const tails = labelTails(list[j], name);
      if (tails === null) continue;
      const region = tails.flat();
      /* 那一段里又有人跳回这个标号 ⇒ 抄一份就不是同一件事了，留给别的落法报。 */
      if (gotoNames(region).has(name)) continue;
      return { j, name, flag: gotoFlag(name), region };
    }
  }
  return null;
}

function stmtsOf(list, C) {
  /* 标号那一刀。两个方向各一种落法，旗子那一格是同一个：
     * **往前跳**（`goto` 在标号前头）：`旗子=0;` + 前面那段整段加护卫，后面那段照常降；
     * **往后跳**（`goto` 在标号后头）：标号到这段末尾包进 `while (旗子) { 旗子=0; …护卫… }`
       —— 置旗就是"再走一趟"。放到末尾而不是精确到 `goto` 那一句：多包进来的几句在
       旗子置起来的那一趟本来就被护卫挡着，只在最后一趟跑一次，与原来同义。 */
  const at = labelAt(list);
  if (at >= 0) {
    const name = idOf(kids(list[at])[0]);
    const flag = gotoFlag(name);
    /* **这格表就是"被跳进来的循环体"**（旗子是外头那一层摆的，见 `loopEntryAt`）：
       标号前头那一段整段包进 `if (旗子 == 0) {…}`、标号这儿把旗子清掉 —— 跳进来的
       那一趟正好从标号那句开始，往后每一趟照旧从头走。 */
    if (C.loopEntry.get(name) === flag) {
      C.loopEntry.delete(name);
      const pre = stmtsOf(list.slice(0, at), C);
      return [
        ...guardStmts(bin('==', nameRef(flag), num(0)), pre),
        { kind: 'assign', target: nameRef(flag), value: num(0) },
        ...stmtsOf(list.slice(at + 1), C),
      ];
    }
    const fwd = gotoNames(list.slice(0, at)).has(name);
    const back = gotoNames(list.slice(at + 1)).has(name);
    if (fwd && back) {
      throw new Error(`eval->IR: \`${name}:\` 这个标号**两个方向都有人跳**（前后各有 goto）`
        + ' —— 这一版一个标号只接一个方向');
    }
    if (back) {
      const region = list.slice(at + 1);
      C.gotoActive.push(flag);
      const guarded = stmtsOf(region, C);
      C.gotoActive.pop();
      return [
        { kind: 'let', name: flag, type: REAL, init: num(1) },
        {
          kind: 'while',
          cond: bin('!=', nameRef(flag), num(0)),
          body: [
            { kind: 'assign', target: nameRef(flag), value: num(0) },
            ...guarded,
          ],
        },
      ];
    }
    const region = list.slice(0, at);
    if (!fwd) {
      /* 这标号这一格里没人跳（语料里有留着不用的，也有**外层跳进来**的那种）——
         标号这一句丢掉，两段照常降。**顺手把标号后头那一段登记下来**：
         外层的 `goto` 跳进来时照抄一份（见 `stmtOf1` 的 `goto` 那一格）。 */
      C.innerLabels.set(name, list.slice(at + 1));
      return [...stmtsOf(region, C), ...stmtsOf(list.slice(at + 1), C)];
    }
    C.gotoActive.push(flag);
    const guarded = stmtsOf(region, C);
    C.gotoActive.pop();
    return [
      { kind: 'let', name: flag, type: REAL, init: num(0) },
      ...guarded,
      ...stmtsOf(list.slice(at + 1), C),
    ];
  }
  /* **跳进一格循环体里**（`ls = 0; goto in2it; do { … in2it: … } while (1);`）——
     护卫那一招只退得出去、退不进去，而"跳进循环体"这件事是经典的**循环入口旗子**：
     goto 那儿置旗，循环照常进，体里标号前头那一段在旗子起着的那一趟整段跳过、
     标号那儿清旗。循环的条件上也要 OR 一格旗子 —— 原文那一跳压根没测过条件。 */
  const ent = loopEntryAt(list);
  if (ent !== null) {
    const { j, name, flag } = ent;
    C.gotoActive.push(flag);
    const pre = stmtsOf(list.slice(0, j), C);
    C.gotoActive.pop();
    C.loopEntry.set(name, flag);
    const loop = loopEntryStmt(list[j], C, flag, name);
    C.loopEntry.delete(name);
    return [
      { kind: 'let', name: flag, type: REAL, init: num(0) },
      ...pre,
      ...loop,
      ...stmtsOf(list.slice(j + 1), C),
    ];
  }
  /* **往前跳进一格块里**（`goto dowin;` … `if (n == 0) { dowin: … }`）——
     旗子那一格管"往前跳"：置旗之后这格表上到那句为止（含嵌套）每句都被护卫挡着，
     于是控制流一路退到那句**后头**；而标号那儿本该跑的那一段（含一路上外层的尾巴）
     在 goto 那儿**照抄一份**先跑掉。两件事合起来正是那一跳。 */
  const inb = blockEntryAt(list, C);
  if (inb !== null) {
    const { j, name, flag, region } = inb;
    C.gotoCopy.set(name, region);
    C.gotoActive.push(flag);
    const guarded = stmtsOf(list.slice(0, j + 1), C);
    C.gotoActive.pop();
    C.gotoCopy.delete(name);
    return [
      { kind: 'let', name: flag, type: REAL, init: num(0) },
      ...guarded,
      ...stmtsOf(list.slice(j + 1), C),
    ];
  }
  /* **往后跳进一格嵌套里**（`games/kenken.kc:909` 的 `goto back2it`：标号在两层 `if` 里头
     那格 `while` 的体上，`goto` 在这格表的末尾）—— 两格旗子合起来：
       `绕回旗` 把"标号那句起到这段末尾"包进 `while (绕回旗)`（与往后跳那一档同一招），
       `进入旗` 把**那条路上每一格判断**改成"起着就一定走"（见 `entryLower`）、标号那儿清掉。 */
  const pe = pathEntryAt(list, C);
  if (pe !== null) {
    const { j, name } = pe;
    const f = gotoFlag(name);
    const g = `${f}$back`;
    if (looseBreak(list.slice(j + 1))) {
      throw new Error(`eval->IR: \`goto ${name}\` 往后跳进嵌套里，可那一段里有 \`break\` ——`
        + ' 这一版把那一段包进一格 while，`break` 的去处就变了');
    }
    const pre = stmtsOf(list.slice(0, j), C);
    C.pathEntry.set(name, f);
    C.gotoPair.set(name, g);
    const head = entryLower(list[j], C, f, name);
    C.gotoActive.push(g);
    const rest = stmtsOf(list.slice(j + 1), C);
    C.gotoActive.pop();
    C.gotoPair.delete(name);
    C.pathEntry.delete(name);
    return [
      { kind: 'let', name: f, type: REAL, init: num(0) },
      ...pre,
      { kind: 'let', name: g, type: REAL, init: num(1) },
      {
        kind: 'while',
        cond: bin('!=', nameRef(g), num(0)),
        body: [
          { kind: 'assign', target: nameRef(g), value: num(0) },
          ...head,
          ...rest,
        ],
      },
    ];
  }
  const out = [];
  for (const s of list) out.push(...stmtOf(s, C));
  return out;
}

/** 这一段（不进更里头那层循环）里有没有"光秃秃的 `break`"。 */
function looseBreak(list) {
  for (const s of list) if (looseBreakIn(s)) return true;
  return false;
}

function looseBreakIn(x) {
  if (!isList(x)) return false;
  const t = tag(x);
  if (t === 'break') return true;
  if (t === 'while' || t === 'dowhile' || t === 'for') return false;
  return kids(x).some((k) => looseBreakIn(k));
}

/** 这一句（含嵌套）里有 `name:` 这个标号没有。 */
function hasLabel(x, name) {
  if (!isList(x)) return false;
  if (tag(x) === 'label') return idOf(kids(x)[0]) === name;
  return kids(x).some((k) => hasLabel(k, name));
}

/**
 * **往后跳进一格嵌套里**：这格表上有没有"某句里头藏着标号、而 `goto` 到它的在那句
 * **后头**"（`games/kenken.kc` 那格 `back2it`）—— 有就回 `{ j, name }`。
 */
function pathEntryAt(list, C) {
  for (let j = 0; j < list.length; j += 1) {
    if (!isList(list[j])) continue;
    for (const name of gotoNames(list.slice(j + 1))) {
      if (C.pathEntry.has(name)) continue;
      if (!hasLabel(list[j], name)) continue;
      return { j, name };
    }
  }
  return null;
}

/**
 * 把一句语句"照原样降，但**去那个标号那条路上**的每一格判断都改成'进入旗起着就一定走'"：
 * `if` 的条件 OR 上它（标号在 else 支就反过来 AND 上"旗子没起"）、循环的条件 OR 上它、
 * 一格语句表里标号前头那一段整段包进 `if (旗子 == 0)`，标号那儿把旗子清掉。
 */
function entryLower(s, C, f, name) {
  const t = tag(s);
  const on = bin('!=', nameRef(f), num(0));
  const off = bin('==', nameRef(f), num(0));
  const skipPre = (pre) => guardStmts(off, pre);
  if (t === 'block') {
    const list = kids(s);
    const at = labelAt(list);
    if (at >= 0 && idOf(kids(list[at])[0]) === name) {
      return [{
        kind: 'block',
        stmts: [
          ...skipPre(stmtsOf(list.slice(0, at), C)),
          { kind: 'assign', target: nameRef(f), value: num(0) },
          ...stmtsOf(list.slice(at + 1), C),
        ],
      }];
    }
    const i = list.findIndex((k) => hasLabel(k, name));
    return [{
      kind: 'block',
      stmts: [
        ...skipPre(stmtsOf(list.slice(0, i), C)),
        ...entryLower(list[i], C, f, name),
        ...stmtsOf(list.slice(i + 1), C),
      ],
    }];
  }
  if (t === 'if') {
    const k = kids(s);
    const inThen = hasLabel(k[1], name);
    const cond = exprOf(k[0], C, 'cond');
    return [{
      kind: 'if',
      cond: inThen ? bin('||', on, cond) : bin('&&', off, cond),
      then: inThen ? entryLower(k[1], C, f, name) : stmtsOf([k[1]], C),
      else_: k.length > 2
        ? (inThen ? stmtsOf([k[2]], C) : entryLower(k[2], C, f, name))
        : [],
    }];
  }
  if (t === 'while') {
    const k = kids(s);
    return [{
      kind: 'while',
      cond: bin('||', on, exprOf(k[0], C, 'cond')),
      body: entryLower(k[1], C, f, name),
    }];
  }
  if (t === 'dowhile') {
    const k = kids(s);
    C.doN = (C.doN ?? 0) + 1;
    const d = `pd_do${C.doN}`;
    return [
      { kind: 'let', name: d, type: REAL, init: num(1) },
      {
        kind: 'while',
        cond: bin('||', truthy(nameRef(d)), exprOf(k[1], C, 'cond')),
        body: [
          { kind: 'assign', target: nameRef(d), value: num(0) },
          ...entryLower(k[0], C, f, name),
        ],
      },
    ];
  }
  if (t === 'for') {
    const [init, cond, post, body] = kids(s);
    const some = (n) => isList(n) && tag(n) !== undefined && tag(n) !== null;
    if (some(init)) {
      throw new Error(`eval->IR: \`goto ${name}\` 那条路上有格 for 头上带初值 ——`
        + ' 原文那一跳压根没跑过它，这一版不接');
    }
    return [{
      kind: 'for',
      init: null,
      cond: some(cond) ? bin('||', on, exprOf(cond, C, 'cond')) : null,
      post: some(post) ? (exprStmtOf(post, C)[0] ?? null) : null,
      body: entryLower(body, C, f, name),
    }];
  }
  throw new Error(`eval->IR: \`goto ${name}\` 那条路上有一格 ${t} —— 这一版只接 block/if/循环`);
}

/**
 * "被跳进来的那格循环"：照常降一份，再把条件上 OR 一格旗子（跳进来的那一趟不测条件）。
 * `for` 头上有初值的不接 —— 原文那一跳没跑过初值，我们这儿跑了就不是同一件事。
 */
function loopEntryStmt(s, C, flag, name) {
  if (tag(s) === 'for') {
    const init = kids(s)[0];
    if (isList(init) && tag(init) !== undefined && tag(init) !== null) {
      throw new Error(`eval->IR: \`goto ${name}\` 跳进的那格 for 头上有初值 ——`
        + ' 原文那一跳压根没跑过它，这一版不接');
    }
  }
  const res = stmtOf1(s, C).map((st) => {
    if (st.kind !== 'while' && st.kind !== 'for') return st;
    const g = bin('!=', nameRef(flag), num(0));
    return { ...st, cond: st.cond === null ? null : bin('||', g, st.cond) };
  });
  return applyGuards(res, C);
}

/**
 * 一句语句 -> 若干句 IR。
 *
 * **护卫那一层在这儿加**（`C.gotoActive` 非空 = 正在降某个标号前头那一段）：每句外面
 * 套一层 `if (旗子 == 0)`，循环的条件上再 `&& 旗子 == 0`（见 `stmtsOf` 头上那段）。
 */
function stmtOf(s, C) {
  return applyGuards(stmtOf1(s, C), C);
}

/** 正在降的那几格旗子都套上护卫（`C.gotoActive` 空着就原样回）。 */
function applyGuards(res, C) {
  if (C.gotoActive.length === 0) return res;
  const g = C.gotoActive
    .map((f) => bin('==', nameRef(f), num(0)))
    .reduce((a, b) => bin('&&', a, b));
  return res.flatMap((st) => {
    /* 循环：条件上加一格 —— 光在外头套 `if` 退不出来（旗子是循环体里置的）。 */
    if (st.kind === 'while') return [{ ...st, cond: bin('&&', st.cond, g) }];
    if (st.kind === 'for') return [{ ...st, cond: st.cond === null ? g : bin('&&', st.cond, g) }];
    /* **声明不许关进那层 `if` 里** —— 关进去就成了那格块的局部量，后头引它的看不见
       （`do{…}while` 落出来的 `let pd_doN` 与它那格 while 就是这么被切开的：
       `games/kenken.kc` 上报"未声明的变量 pd_do3"）。这门语言里 `let` 的初值是常量或
       `anew`，多做一次没有副作用。 */
    if (st.kind === 'let') return [st];
    return [{ kind: 'if', cond: g, then: [st], else_: [] }];
  });
}

/** 一段整段包进 `if (cond) {…}`，但**声明留在外头**（同 `applyGuards` 那条理由）。 */
function guardStmts(cond, stmts) {
  const lets = stmts.filter((s) => s.kind === 'let');
  const rest = stmts.filter((s) => s.kind !== 'let');
  return [...lets, ...(rest.length === 0 ? [] : [{ kind: 'if', cond, then: rest, else_: [] }])];
}


function stmtOf1(s, C) {
  const t = tag(s);
  if (t === 'empty') return [];
  if (t === 'block') return [{ kind: 'block', stmts: stmtsOf(kids(s), C) }];
  if (t === 'retexpr') return [{ kind: 'return', values: [exprOf(kids(s)[0], C)] }];
  if (t === 'return') {
    const k = kids(s);
    /* **`return;` 不给值就是回 0**（`RScript.htm` 的关键字表：return — "Ends a function
       and returns to the caller, with an optional value. **Zero is used if no value is
       supplied**"）。这门语言里函数一律回一个 double，所以不许发空的 `(ret)` ——
       发了下游就报"这个函数要返回 real，(ret) 没给值"（语料里 7 份脚本红在这一格）。
       **主函数两条路都照发带值的那一格**：宿主设备那条路上主体落成 `eval$frame`
       （`ret: REAL` —— `.kc` 的表面脚本回的就是那一格的值）；生成出来那条 CPU 路上
       主体进的是 `(main …)`（**void**），那儿由 `voidRets()` 统一摊成"做一句 + 空返回"。
       从前是在这儿按 `C.inMain` 分的，**那是错的**：`C.needGfx` 要等 body 降完才知道
       （第一句画图调用之后才置上），而 `return` 可能出现在它前头 ⇒ 同一份脚本里两种
       形状混着发（`geeky/mandel.kc` / `geeky/gcd.kc` 就是这么红的）。 */
    return [{ kind: 'return', values: [k.length === 0 ? num(0) : exprOf(k[0], C)] }];
  }
  if (t === 'break') return [{ kind: 'break' }];
  if (t === 'continue') return [{ kind: 'continue' }];
  if (t === 'if') {
    const k = kids(s);
    return [{
      kind: 'if',
      cond: exprOf(k[0], C, 'cond'),
      then: stmtsOf([k[1]], C),
      else_: k.length > 2 ? stmtsOf([k[2]], C) : [],
    }];
  }
  if (t === 'while') {
    const k = kids(s);
    return [{ kind: 'while', cond: exprOf(k[0], C, 'cond'), body: stmtsOf([k[1]], C) }];
  }
  if (t === 'dowhile') {
    /* `do{…}while(c);` —— 标准 IR 里没有 do-while 那一格，落成**一格旗子 + while**：
     *
     *     let pd_doN = 1;  while (pd_doN != 0 || c) { pd_doN = 0; body }
     *
     * 从前是"body 抄两份（先跑一趟、再 while）"，那样有两个真问题：
     *   1. **第一份里的 `break` 不在循环里** —— 方言当场报（`geeky/mandel.kc:6` 就是
     *      `do { … if (…) break; … } while (…)`，语料里这种写法不少）；
     *   2. body 抄两份，产物大一倍，`continue` 在第一份里也是错的。
     * 旗子这一手两样都对：`break` 跳出的是同一格循环、`continue` 回去重测条件
     * （`pd_doN` 已经是 0，所以测的正是 `c` —— 与真 do-while 一致）。
     */
    const k = kids(s);
    C.doN = (C.doN ?? 0) + 1;
    const flag = `pd_do${C.doN}`;
    return [
      { kind: 'let', name: flag, type: REAL, init: num(1) },
      {
        kind: 'while',
        cond: bin('||', truthy(nameRef(flag)), exprOf(k[1], C, 'cond')),
        body: [
          { kind: 'assign', target: nameRef(flag), value: num(0) },
          ...stmtsOf([k[0]], C),
        ],
      },
    ];
  }
  if (t === 'for') {
    const [init, cond, post, body] = kids(s);
    /* `optexpr` / `optlist` 空着的时候 action 是 `()` —— 一格**空表**，`tag` 回的是
       `null`（不是 undefined）。少判一格 null 的话 `for(;j>=0;j=nj)`（`demos/minsurf.kc:196`）
       会把那格空表当表达式递下去，报"这一格表达式还没接：null"。 */
    const some = (n) => isList(n) && tag(n) !== undefined && tag(n) !== null;
    /* for 头里的**逗号表达式**（`for(v=0,i=1/256; …)`）在语法里是 `(comma e…)`：摊成一格 block。 */
    const headOf = (n) => {
      if (!some(n)) return null;
      if (tag(n) !== 'comma') return exprStmtOf(n, C)[0] ?? null;
      const ss = kids(n).flatMap((e) => exprStmtOf(e, C));
      return ss.length === 1 ? ss[0] : { kind: 'block', stmts: ss };
    };
    return [{
      kind: 'for',
      init: headOf(init),
      cond: some(cond) ? exprOf(cond, C, 'cond') : null,
      post: headOf(post),
      body: stmtsOf([body], C),
    }];
  }
  if (t === 'expr') return exprStmtOf(kids(s)[0], C);
  /* **一句里的逗号表达式**（`mx=0,my=0;`）：从左到右各做一句 —— 与 for 头里那一格同义。 */
  if (t === 'comma') return kids(s).flatMap((e) => exprStmtOf(e, C));
  /* **`auto` 那一格在这儿落**：一句 `let` 带初值 —— 数组每趟开一块新的、标量每趟摆
     一次初值。初值"按运行期算"（`RScript.htm` §Init 第三条），所以是真语句，不像
     static 那样摆进入口。 */
  if (t === 'auto' || t === 'aty') {
    return autoDecls(s).flatMap((d) => {
      const a = autoShape(C, d);
      if (a.arr !== true) {
        return [{
          kind: 'let',
          name: a.name,
          type: REAL,
          init: a.init === undefined ? num(0) : exprOf(a.init, C),
        }];
      }
      return [
        {
          kind: 'let',
          name: a.name,
          type: ARR,
          init: {
            kind: 'builtin',
            name: 'anew',
            args: [{ kind: 'type', type: ARR }, { kind: 'int', value: String(a.total) }],
          },
        },
        ...a.vals.flatMap((v, i) => (v === null ? [] : [{
          kind: 'assign',
          target: { kind: 'index', obj: nameRef(a.name), index: iNum(i) },
          value: v,
        }])),
      ];
    });
  }
  if (t === 'static' || t === 'enum' || t === 'sty' || t === 'struct') return [];
  if (t === 'label') {
    /* 标号那一格由 `stmtsOf` 拆掉（它要看见"前后两段"）。走到这儿说明它不在一格语句表的
       位置上（比如 `if (c) lab:`）—— 那种写法这一版不接。 */
    throw new Error(`eval->IR: \`${idOf(kids(s)[0])}:\` 这个标号不在一格语句表里 ——`
      + ' 这一版只接"整段语句里的标号"（`if (c) 标号:` 那种写法不接）');
  }
  if (t === 'goto') {
    const name = idOf(kids(s)[0]);
    const flag = gotoFlag(name);
    /* **往后跳进嵌套里**那一档（`pathEntryAt`）：两格旗子一起置 —— 进入旗管"那条路上
       每格判断都走"，绕回旗管"退到那句、再走一趟"。 */
    const back = C.gotoPair.get(name);
    if (back !== undefined) {
      return [
        { kind: 'assign', target: nameRef(flag), value: num(1) },
        { kind: 'assign', target: nameRef(back), value: num(1) },
      ];
    }
    if (!C.gotoActive.includes(flag)) {
      /* **跳进块里那一档**（`ken/drawcone2.pss`：`singsph:` 在 `if {}` 里头，而
         `goto singsph` 在函数体这一层）—— 标准 IR 里没有无条件跳转，护卫那一招也退不进去。
         `goto singsph` 在函数体这一层）—— 标准 IR 里没有无条件跳转，护卫那一招也退不进去。
         落法是**照抄那一段**：标号到它所在那格语句表末尾的那几句，原样在这儿降一份。
         **前提是那一段不会走到底**（末句是 `goto` 或 `return`）—— 不然抄完还要接着往下走，
         那就不是同一件事了。`drawcone2` 那一段末句正是 `goto skipcone`，
         而 `skipcone:` 在函数体这一层、`goto` 在它前头 ⇒ 抄进来那句照旧走旗子那条路。
         原处那一段**照旧留着**（顺着走下来的那条路要用），所以这一格的代价是代码多一份。 */
      const region = C.innerLabels.get(name);
      if (region !== undefined && !C.expanding.has(name) && region.length > 0) {
        const last = tag(region[region.length - 1]);
        if (last === 'goto' || last === 'return' || last === 'retexpr') {
          C.expanding.add(name);
          const copy = stmtsOf(region, C);
          C.expanding.delete(name);
          return copy;
        }
        throw new Error(`eval->IR: \`goto ${name}\` 要跳进一格块里，可那一段会**走到底**`
          + `（末句是 ${last}，不是 goto/return）—— 照抄一份就不是同一件事了`);
      }
      throw new Error(`eval->IR: \`goto ${name}\` 找不到往前跳的那个标号 ——`
        + ' 这一版只接"同一函数里、往前跳到某一格语句表上的标号"与"跳进块里那一段"');
    }
    /* 置旗。后面每一句都在 `if (旗子 == 0)` 里头（见 `stmtOf`），所以控制流一路退到标号。
       注意这一句自己也被那层护卫裹着 —— 置旗只在"还没跳"的时候发生。
       **跳进块里那一档**（`C.gotoCopy`，见 `blockEntryAt`）还要在置旗**之前**把标号那儿
       该跑的那一段照抄一份 —— 旗子只管"退到那句后头"，跑那一段是另一半。 */
    const copyRegion = C.gotoCopy.get(name);
    if (copyRegion !== undefined) {
      if (C.expanding.has(name)) {
        throw new Error(`eval->IR: \`goto ${name}\` 抄那一段的时候又碰上它自己 —— 这一版不接`);
      }
      C.expanding.add(name);
      const copy = stmtsOf(copyRegion, C);
      C.expanding.delete(name);
      return [...copy, { kind: 'assign', target: nameRef(flag), value: num(1) }];
    }
    return [{ kind: 'assign', target: nameRef(flag), value: num(1) }];

  }
  throw new Error(`eval->IR: 这一格语句还没接：${t}`);
}

/** for 头里那一格既可能是表达式、也可能是 `i++` —— 两种都走 `exprStmtOf`。 */

/** 一条"表达式语句"：赋值、自增、调用（含 `printf`）。 */
function exprStmtOf(e, C) {
  const t = tag(e);
  /* **`readmouse(&x,&y,&b)`**（`evaldraw.txt` 的输入那一族）：它是"一次读一整组"——
     三格都是**出参**。设备那一侧本来就有 `mousx`/`mousy`/`bstatus` 三格量，所以这儿
     摊成三句赋值，不往宿主面上加"能写实参"的调用（那是指针，方言里没有）。
     给几格实参就读几格（语料里 2 格与 3 格都有）。 */
  if (t === 'call' && C.gfxHost && isList(kids(e)[0]) && tag(kids(e)[0]) === 'name'
    && idOf(kids(e)[0]) === 'readmouse' && kids(e).length >= 2) {
    const qs = ['mousx', 'mousy', 'bstatus'];
    const as = kids(e).slice(1);
    if (as.length > qs.length) {
      throw new Error(`eval->IR: \`readmouse\` 最多三格出参（x / y / 键），这儿给了 ${as.length}`);
    }
    C.needGfx = true;
    return as.map((a, i) => {
      const lv = isList(a) && tag(a) === 'addr' ? kids(a)[0] : a;
      return { kind: 'assign', target: targetOf(lv, C), value: gfxCallIR(qs[i]) };
    });
  }
  /* **`bufset(dst,val,n)` / `bufcpy(dst,src,n)`**：口径是 `evaldraw.txt:1513` 那一行 ——
     "Optimized version of: for(i=0;i<n;i++) dst[i] = val"。所以这儿就摊成那个循环
     （`n` 是**元素个数**，见 `sizeof` 那一段）。它们只在语句位置有意义（回的是 0）。 */
  if (t === 'call' && isList(kids(e)[0]) && tag(kids(e)[0]) === 'name'
    && ['bufset', 'bufcpy'].includes(idOf(kids(e)[0])) && kids(e).length === 4) {
    const fn = idOf(kids(e)[0]);
    const dst = kids(e)[1];
    if (!isList(dst) || tag(dst) !== 'name' || !C.arrs.has(idOf(dst))) {
      throw new Error(`eval->IR: \`${fn}\` 的第一个实参要是一格 static 数组的名字`);
    }
    const i = C.fresh('bi');
    const cnt = toInt(exprOf(kids(e)[3], C));
    const src = fn === 'bufset' ? exprOf(kids(e)[2], C) : null;
    const from = fn === 'bufcpy' ? kids(e)[2] : null;
    if (from !== null && (!isList(from) || tag(from) !== 'name' || !C.arrs.has(idOf(from)))) {
      throw new Error('eval->IR: `bufcpy` 的第二个实参要是一格 static 数组的名字');
    }
    const idx = { kind: 'builtin', name: 'toint', args: [nameRef(i)] };
    return [
      { kind: 'let', name: i, type: REAL, init: num(0) },
      {
        kind: 'while',
        cond: bin('<', toInt(nameRef(i)), cnt),
        body: [
          {
            kind: 'assign',
            target: { kind: 'index', obj: nameRef(idOf(dst)), index: idx },
            value: fn === 'bufset' ? src
              : { kind: 'index', obj: nameRef(idOf(from)), index: idx },
          },
          { kind: 'assign', target: nameRef(i), value: bin('+', nameRef(i), num(1)) },
        ],
      },
    ];
  }
  if (t === 'assign') {
    const op = unquote(leaf(kids(e)[0]));
    /* 宿主那一侧的量先看 —— 它不是一格左值，写它是**再问设备一句**。 */
    const ht = hostTargetOf(kids(e)[1], C);
    if (ht !== null) return [hostStore(ht, op, exprOf(kids(e)[2], C), C)];
    /* **整块赋值**（`otouch[i] = ntouch[i]` / `obox = box`）：说明书里明写着的一格，
       只有 `=` 有这个意思（`+=` 那一族落不到整块上）。 */
    if (op === '=') {
      const blk = blockAssignOf(kids(e)[1], kids(e)[2], C);
      if (blk !== null) return blk;
    }
    const tgt = targetOf(kids(e)[1], C);
    const val = exprOf(kids(e)[2], C);
    if (op === '=') return [{ kind: 'assign', target: tgt, value: val }];
    /* `a %= b` 是那格按 |除数| 向下取整的模，不是 fmod、也不是整数取模。 */
    const core = op.slice(0, 1);
    const v = core === '%' ? modIR(C, tgt, val) : bin(core, tgt, val);
    return [{ kind: 'assign', target: tgt, value: v }];
  }
  if (t === 'postinc' || t === 'preinc') return [stepOf(e, C, +1)];
  if (t === 'postdec' || t === 'predec') return [stepOf(e, C, -1)];
  if (t === 'call') {
    const head = kids(e)[0];
    /* `fprintf` 与 `printf` 是**同一手**（`evaldraw.txt:1538`：它只是"也写进那份抓下来的
       文件"，而抓文件是编辑器的事）—— 语料里 42 处。 */
    if (tag(head) === 'name' && (idOf(head) === 'printf' || idOf(head) === 'fprintf')) {
      return printfOf(e, C);
    }
    return [{ kind: 'expr-stmt', expr: callOf(e, C) }];
  }
  return [{ kind: 'expr-stmt', expr: exprOf(e, C) }];
}

/**
 * `printf($fmt, …)` —— 走公共层那台格式串机器（`lower/fmt.js` 的 `fmtToStmts`）：
 * 按 `\n` 切段，带换行的段发 `print`、末段没换行发 `write`。
 * 格式串必须是字面量（旧实现那侧也是编译期就切好的）。
 */
function printfOf(e, C) {
  const args = kids(e).slice(1);
  const fmtTok = args[0];
  if (fmtTok === undefined || tag(fmtTok) !== 'str') {
    throw new Error('eval->IR: `printf` 的格式串不是字面量（运行期格式化还没接）');
  }
  const fmt = cUnescape(unquote(leaf(kids(fmtTok)[0])));
  const vals = args.slice(1).map((a) => exprOf(a, C));
  return fmtToStmts(fmt, vals, C.tyCtx(), 'eval->IR', C.fresh);
}

/* ─── 一段里被写过的名字（没有声明的语言要它） ───────────────────────── */

/** 赋值 / 自增写到的**光名字**（下标那种不算，那是数组自己的事）。 */
function writtenNames(x, out = new Set()) {
  if (!isList(x)) return out;
  const t = tag(x);
  if (t === 'assign' || t === 'postinc' || t === 'postdec' || t === 'preinc' || t === 'predec') {
    const tgt = kids(x)[t === 'assign' ? 1 : 0];
    if (isList(tgt) && tag(tgt) === 'name') out.add(idOf(tgt));
  }
  for (const k of kids(x)) writtenNames(k, out);
  return out;
}

/**
 * **整棵树里的 `enum` 都登记成编译期常量**（文件级的与函数体里的都算）。
 *
 * 为什么要整棵树走一遍而不是只看文件级：语料里 `enum` 多半就写在函数体里，
 * 紧挨着用它的那句 —— `ken/drawsph.pss:42` 是 `enum {NMAX=16}; static clut[NMAX] …`、
 * `games/breakout.kc:6` 也是这个形状。只收文件级那一档的话，`static a[NMAX]` 的长度
 * 算不出来（27 份脚本卡在这一格），而那不是"语言不支持"，是我们少走了一遍。
 *
 * 作用域：这门语言里 enum 就是**编译期的数**（`eval.c` 那侧也没有块作用域的概念），
 * 所以一律落进同一张表。**同名不同值当场报** —— 悄悄用后面那个值是"图安静地变了"的来源。
 */
function collectEnums(x, C) {
  if (!isList(x)) return;
  if (tag(x) === 'enum') {
    let next = 0;
    for (const one of kids(x)) {
      const k = kids(one);
      const n = idOf(k[0]);
      /* 值可以是**常量表达式**，也可以引用前面那格 enum（`enum {NSAMP=MAXBLKSIZ}`,
         `geeky/fft.kc:8`）—— 所以这儿走 `constOf`（它认数、enum 名与算式）。 */
      if (k.length > 1) {
        const v = constOf(k[1], C);
        if (v === null || !Number.isFinite(v)) {
          throw new Error(`eval->IR: \`enum ${n} = …\` 算不出一格编译期常量`
            + '（认的是数、前面那些 enum 名，与它们的算式）');
        }
        next = v;
      }
      const prev = C.enums.get(n);
      if (prev !== undefined && prev !== next) {
        throw new Error(`eval->IR: 两处 \`enum ${n}\` 的值不一样（${prev} 与 ${next}）——`
          + ' enum 在这门语言里是编译期的数、落在同一张表里，所以当场报');
      }
      C.enums.set(n, next);
      next += 1;
    }
    return;
  }
  for (const k of kids(x)) collectEnums(k, C);
}

/** 一段里出现过的所有名字（读也算）—— 判"这个名字是不是全局/enum"用。 */function usedNames(x, out = new Set()) {
  if (!isList(x)) return out;
  if (tag(x) === 'name') out.add(idOf(x));
  for (const k of kids(x)) usedNames(k, out);
  return out;
}

/**
 * 一段里的 `static` 声明（**函数体里的也算**）。
 *
 * EVAL 里函数体内的 `static` 与 C 的 static 局部量同义：**跨调用留值、初值只做一次**。
 * 这门语言的执行模型是"宿主每帧调一次脚本"，所以这一格正是"跨帧活的状态"——
 * `ken/*.pss` 里的相机位置、速度那些全靠它（`static rx=1, ry=0` 写在主函数里头）。
 *
 * 落法：**模块级的量 + 入口里做一次初值**（方言的 `(global 名 类型)` 不许带初值，
 * 见 `lower/lower.js` 那一段）。回的是 `[{ name, init }]`，`init` 是初值那棵 CST（可能没有）。
 */
/**
 * 一格 `static` 声明里的**数组维度**（`static a[16]`、`static planes[6][4]`）。
 *
 * `eval.txt`：**大小必须是常量或 enum 名**。多维照收 —— 旧实现把它**摊成一块**
 * （`tigrou/balls2k.pss:11` 的 `planes[6][4]`），我们也摊：总长 = 各维之积，
 * 下标 = `((i1*d2)+i2)*d3+i3…`。
 */
function dimsOf(one, C, name) {
  const d = kids(one)[1];
  const out = [];
  for (const e of kids(d)) {
    const v = constOf(e, C);
    if (v === null || !Number.isFinite(v) || v <= 0 || v !== Math.trunc(v)) {
      throw new Error(`eval->IR: \`static ${name}[…]\` 的长度要是**常量或 enum 名**`
        + '（`eval.txt` 那一行）—— 这儿算不出一格正整数');
    }
    out.push(v);
  }
  return out;
}

/** 一格**编译期常量**：数字字面量或 enum 名（数组长度只许这两种）。 */
function constOf(e, C) {
  if (!isList(e)) return null;
  if (tag(e) === 'num') {
    const raw = String(leaf(kids(e)[0]));
    return raw.length > 2 && raw[0] === '0' && (raw[1] === 'x' || raw[1] === 'X')
      ? Number(raw) : Number(raw);
  }
  if (tag(e) === 'name') {
    const n = idOf(e);
    return C.enums.has(n) ? Number(C.enums.get(n)) : null;
  }
  /* **常量表达式**也算（`static bitrev[MAXBLKSIZ/2]`、`static a[NMAX+1]`）：
     `eval.txt` 那句"常量或 enum 名"说的是"编译期算得出"，而语料里一半的长度是这种
     算式（`geeky/fft.kc:3`）。两边都折得出来才算 —— 折不出的照旧回 null 让上头报。
     **`^` 在这门语言里是幂**（不是异或，见 grammar 里 `powexp` 那段头注）。 */
  if (tag(e) === 'bin') {
    const op = unquote(leaf(kids(e)[0]));
    const a = constOf(kids(e)[1], C);
    const b = constOf(kids(e)[2], C);
    if (a === null || b === null) return null;
    if (op === '+') return a + b;
    if (op === '-') return a - b;
    if (op === '*') return a * b;
    if (op === '/') return b === 0 ? null : a / b;
    /* `%` 照 `eval.c:5141`：按 |除数| 向下取整的模（见 `needModSig`）—— 折的时候也得一样，
       不然同一个式子"编译期折出来"与"运行时算出来"两个答案。 */
    if (op === '%') {
      return b === 0 ? null : a - Math.floor(a / Math.abs(b)) * Math.abs(b);
    }
    if (op === '^') return a ** b;
    return null;
  }
  if (tag(e) === 'neg') {
    const v = constOf(kids(e)[0], C);
    return v === null ? null : -v;
  }
  return null;
}

/**
 * **下标按 EVAL 的越界规矩夹一下**（`eval.txt`："EVAL uses bounds checking for arrays"）：
 *
 * * 长度是 **2 的幂**：`下标 & (长度-1)` —— 绕回去；
 * * 别的长度：**越界的下标改成 0** 再读/写。
 *
 * 两档都在 int 上算（下标先 `toint`）。非 2 的幂那一档下标那棵树会发三份
 * （判两次 + 用一次）—— EVAL 的下标是纯算术，没有副作用，所以成立。
 */
function clampIdx(ix, n) {
  if ((n & (n - 1)) === 0) return bin('&', ix, iNum(n - 1));
  const ok = bin('&&', bin('>=', ix, iNum(0)), bin('<', ix, iNum(n)));
  return tern(ok, ix, iNum(0));
}

/** 一格 **int** 字面量（下标那一路全在 int 上算 —— 与 real 混就"两边要同型"当场报）。 */
const iNum = (v) => ({ kind: 'int', value: String(v) });

/** 一格静态数组的下标（多维摊成一格）：`a[i][j]` -> `(i*d2 + j)`，再过越界那一夹。 */
/**
 * 摊平下标：`a[i][j][k]` -> `i*d1 + j` 再 `*d2 + k`（行主序），最后过越界那一夹。
 *
 * **下标比维数少是合法的**（`ken/texture3d.pss:12` 就是 `static buf[64][64][64]` 拿
 * `buf[i]` 一路写下去，`i` 从 0 数到 64³-1）：旧实现里多维 `static` 本来就是**一块摊平的
 * double**，`a[i][j]` 只是"算下标"的糖 —— 少给几格就按给的那几格算，步长是 1。
 * 比维数**多**才是真错（那说明写的人以为它是嵌套的）。
 */
function arrIndex(chain, dims, C) {
  let flat = null;
  for (let i = 0; i < chain.length; i++) {
    const one = toInt(exprOf(chain[i], C));
    flat = flat === null ? one : bin('+', bin('*', flat, iNum(dims[i])), one);
  }
  const total = dims.reduce((a, b) => a * b, 1);
  return clampIdx(flat, total);
}

/** real -> int（下标必须是 int，见 `ir.js` 里那条注）。 */
const toInt = (e) => ({ kind: 'builtin', name: 'toint', args: [e] });

/**
 * **这个名字身上那格偏移**（`名字$o` 形参，见 `offName` 的头注）：没有就回 `null`。
 * 有的话所有下标都要加上它 —— 那正是"从第 i 格起的那一段"（`&a[i]`）的落法。
 */
const offOf = (n, C) => (C.offs.has(n) ? toInt(nameRef(C.offs.get(n))) : null);
/** 摊平下标 + 那格偏移（没有偏移就原样回）。 */
function withOff(n, idx, C) {
  const o = offOf(n, C);
  return o === null ? idx : bin('+', idx, o);
}

/**
 * 一串下标：`a[i][j]` 的树是 `(index (index a i) j)` —— 摊成 `{ base, chain }`。
 * `base` 是最里头那格（名字），`chain` 是从外到里数过来的下标（已经正过来）。
 */
function indexChain(x) {
  const chain = [];
  let cur = x;
  while (isList(cur) && tag(cur) === 'index') {
    chain.unshift(kids(cur)[1]);
    cur = kids(cur)[0];
  }
  return { base: cur, chain };
}

/**
 * 一张初值表（`{1,0,0}` / `{'A','2',,'J'}`）-> 一串 IR（空位是 `null` = 不赋值）。
 *
 * 空位（`ihole`）与**末尾那个多余的逗号**是同一件事，所以末尾的空位直接丢掉。
 */
function initVals(list, C) {
  const out = kids(list).map((e) => (tag(e) === 'ihole' ? null : exprOf(e, C)));
  while (out.length > 0 && out[out.length - 1] === null) out.pop();
  return out;
}

/**
 * 登记一格 `static` 数组：模块级的 `(arr real)` + 入口里 `a = (anew …)` 做**一次**。
 *
 * 为什么长度要编译期知道：越界那两档规矩（2 的幂按位与 / 否则改成 0）是**按长度**选的，
 * 而且多维要摊成一块 —— 两样都得在发射的时候就定下来。
 */
function declArr(C, preDecls, name, one, where) {
  if (tag(one) === 'svarl') {
    throw new Error(`eval->IR: \`static ${name} = {…}\` 少一个类型前缀 ——`
      + ' 一张初值表要么给数组（`static a[3] = {…}`），要么给结构体'
      + '（`static point3d p = {1,0,0}`）');
  }
  const dims = dimsOf(one, C, name);
  const total = dims.reduce((a, b) => a * b, 1);
  const k = kids(one);
  const vals = k.length > 2 ? initVals(k[2], C) : [];
  if (vals.length > total) {
    throw new Error(`eval->IR: \`static ${name}[…]\` 的初值表有 ${vals.length} 格，`
      + `数组只有 ${total} 格`);
  }
  C.arrs.set(name, dims);
  C.globals.set(name, ARR);
  C.staticOwner.set(name, where);
  preDecls.push({ kind: 'global', name, type: ARR });
  C.arrInits.push({ name, total, vals });
}

/* ─── 结构体（RScript 的特性）───────────────────────────────────────────
 *
 * 口径：`RScript.htm` 的关键字表那一行（"struct — Used to define a structure, which can
 * be used as a type prefix for variables"）。**不是 Ken 的 EVAL**：`polydraw_src/eval.c`
 * 里一格都没有，是 Robert Rodgers 那个第二编译器加的（`evaldraw.txt` 2010-01-28 那条：
 * "structures, #if..#endif, #define, stack arrays"）。所以细节以**语料**为准。
 *
 * 落法：**一格结构体就是一块摊平的 double**，`a[i].f` = `a[i*格数 + 字段偏移]` ——
 * 与多维数组摊平同一手（`arrIndex`），运行期一格新东西都不加。
 * 字段本身可以是数组（`struct { v[2], leng; } edge_t;`）也可以是别的结构体
 * （`games/traffic.kc:32` 的 `play_t play[MAXPLAYS];`）—— 两样都只是"偏移 + 长度"。
 */

/** 一格类型的槽数（`double` 与没登记的名字都是 1 —— 那是"一个 double"）。 */
function structSize(ty, C) {
  const s = C.structs.get(ty);
  return s === undefined ? 1 : s.size;
}

/** 一格字段项（`fld 名字 [dims]`）-> `{ name, dims }`。 */
function fieldItem(one, C) {
  const k = kids(one);
  const name = idOf(k[0]);
  const dims = k.length > 1 ? kids(k[1]).map((e) => {
    const v = constOf(e, C);
    if (v === null || !Number.isFinite(v) || v <= 0 || v !== Math.trunc(v)) {
      throw new Error(`eval->IR: 结构体字段 \`${name}[…]\` 的长度算不出一格正整数`);
    }
    return v;
  }) : [];
  return { name, dims };
}

/**
 * **整棵树里的 `struct` 都登记上**（与 enum 同一手：文件级与函数体里的都算）。
 *
 * 一格类型记成 `{ size, fields: Map(字段名 -> { off, dims, ty }) }`：
 * `off` 是槽偏移、`dims` 是这个字段自己的维度、`ty` 是它的类型（别的结构体或 null）。
 */
function collectStructs(x, C) {
  if (!isList(x)) return;
  if (tag(x) === 'struct') {
    const ks = kids(x);
    const name = idOf(ks[0]);
    const fields = new Map();
    let off = 0;
    /* 一组带类型的字段（`tgrp 类型 项…`）与光字段项（`fld …`）混着来。 */
    const addOne = (one, ty) => {
      const { name: fn, dims } = fieldItem(one, C);
      /* 字段的类型**必须已经登记**（`struct` 按先后次序读）。少了这一格检查的话，
         `col_t col;` 里那个还没见过的 `col_t` 会当成"一格 double" —— 之后所有字段的
         偏移都错，而且一声不响。 */
      if (ty !== undefined && ty !== 'double' && !C.structs.has(ty)) {
        throw new Error(`eval->IR: 结构体 \`${name}\` 的字段 \`${fn}\` 用了还没登记的类型`
          + ` \`${ty}\`（struct 要在用它之前声明）`);
      }
      const n = dims.reduce((a, b) => a * b, 1) * structSize(ty ?? 'double', C);
      if (fields.has(fn)) throw new Error(`eval->IR: 结构体 \`${name}\` 里有两个 \`${fn}\``);
      fields.set(fn, { off, dims, ty: ty === undefined || ty === 'double' ? null : ty });
      off += n;
    };
    for (const g of ks.slice(1)) {
      if (tag(g) === 'tgrp') {
        const gk = kids(g);
        const ty = idOf(gk[0]);
        for (const one of gk.slice(1)) addOne(one, ty);
      } else addOne(g, undefined);
    }
    if (C.structs.has(name)) throw new Error(`eval->IR: 两处 \`struct … ${name}\``);
    C.structs.set(name, { size: off, fields });
    return;
  }
  for (const k of kids(x)) collectStructs(k, C);
}

/**
 * 一格**带类型的 static**（`static cel_t cel[12][12];` / `static cam_t cam;`）。
 *
 * 落成一块 `(arr real)`：长度 = 各维之积 × 类型的槽数。变量的类型与维度记在
 * `C.svars` 上 —— `a[i].f` 要靠它算偏移（见 `fieldRef`）。
 */
function declTyped(C, preDecls, tyName, one, where) {
  const k = kids(one);
  const name = idOf(k[0]);
  const ty = tyName.toLowerCase();
  if (ty !== 'double' && !C.structs.has(ty)) {
    throw new Error(`eval->IR: \`static ${tyName} ${name}\` 里的 \`${tyName}\` 不是登记过的`
      + ' 结构体（`struct { … } 名字;` 要在用它之前）');
  }
  const dims = tag(one) === 'sarr' ? dimsOf(one, C, name) : [];
  const size = structSize(ty, C);
  const total = dims.reduce((a, b) => a * b, 1) * size;
  /* 初值表：`static dpoint3d pr = {1,0,0}`（`svarl`）与 `static T a[N] = {…}`（`sarr`）
     两种形状 —— 都按**槽的次序**填（结构体的字段就是那几格槽）。 */
  const listAt = tag(one) === 'svarl' ? 1 : 2;
  const vals = k.length > listAt && tag(k[listAt]) === 'init' ? initVals(k[listAt], C) : [];
  if (vals.length > total) {
    throw new Error(`eval->IR: \`static ${tyName} ${name}\` 的初值表有 ${vals.length} 格，`
      + `这一块只有 ${total} 格`);
  }
  C.arrs.set(name, [total]);
  C.svars.set(name, { ty: ty === 'double' ? null : ty, dims });
  C.globals.set(name, ARR);
  C.staticOwner.set(name, where);
  preDecls.push({ kind: 'global', name, type: ARR });
  C.arrInits.push({ name, total, vals });
}

/**
 * `vt[i].stuck` / `cam.x` / `g.play[i].x` -> `{ name, off, total }`（`off` 是**槽下标**的 IR）。
 *
 * 不是结构体那条路上的东西回 `null`（调用方照旧走普通数组/名字那一支）。
 * 走法：从最里头那个名字出发，一格一格往外吃 `[]` 与 `.`，每一步只做两件事 ——
 * 累加偏移、把"现在是什么类型、还剩几维"更新掉。
 */
function fieldRef(x, C) {
  const r = blockWalk(x, C);
  if (r === null) return null;
  if (r.dims.length > 0 || r.ty !== null) {
    throw new Error(`eval->IR: \`${r.name}\` 这一处取到的是一整块（结构体或数组），`
      + '不是一个数 —— 只有整块赋值（`a = b`）那一格接得住整块');
  }
  const total = (C.arrs.get(r.name) ?? [1])[0];
  return { name: r.name, index: clampIdx(r.off, total) };
}

/**
 * `fieldRef` 的**原料**：一路吃下 `[]` 与 `.`，回 `{ name, off, ty, dims }`。
 * 与 `fieldRef` 的差别只有一处 —— **它不要求落到一个数**，所以整块那一族
 * （`otouch[i] = ntouch[i]`、`obox = box`）也能问它要偏移与形状。
 */
function blockWalk(x, C) {
  const walk = (e) => {
    if (!isList(e)) return null;
    const t = tag(e);
    if (t === 'name') {
      const n = idOf(e);
      const sv = C.svars.get(n);
      if (sv === undefined) return null;
      return { name: n, off: iNum(0), ty: sv.ty, dims: sv.dims.slice() };
    }
    if (t === 'index') {
      const b = walk(kids(e)[0]);
      if (b === null) return null;
      if (b.dims.length === 0) {
        throw new Error(`eval->IR: \`${b.name}\` 上的下标比声明的维数多`);
      }
      const stride = b.dims.slice(1).reduce((a, c) => a * c, 1) * structSize(b.ty ?? 'double', C);
      const i = toInt(exprOf(kids(e)[1], C));
      return {
        name: b.name,
        off: bin('+', b.off, stride === 1 ? i : bin('*', i, iNum(stride))),
        ty: b.ty,
        dims: b.dims.slice(1),
      };
    }
    if (t === 'field') {
      const b = walk(kids(e)[0]);
      if (b === null) return null;
      if (b.dims.length > 0) {
        throw new Error(`eval->IR: \`${b.name}\` 是数组，取字段之前要先给下标`);
      }
      if (b.ty === null) throw new Error(`eval->IR: \`${b.name}\` 不是结构体，没有字段`);
      const st = C.structs.get(b.ty);
      const fn = idOf(kids(e)[1]);
      const f = st.fields.get(fn);
      if (f === undefined) {
        throw new Error(`eval->IR: 结构体 \`${b.ty}\` 里没有字段 \`${fn}\`（有的是 `
          + `${[...st.fields.keys()].join('/')}）`);
      }
      return {
        name: b.name,
        off: f.off === 0 ? b.off : bin('+', b.off, iNum(f.off)),
        ty: f.ty,
        dims: f.dims.slice(),
      };
    }
    return null;
  };
  return walk(x);
}

/**
 * **整块那一族的操作数**：`{ name, off, slots }`，不是整块就回 `null`。
 *
 * 口径（`RScript.htm` 的 Other notes，逐字）：「When assigning structures or passing them
 * as parameters, the compiler will allow the operation only if the size of the source and
 * destination matches.」—— 所以**整块赋值是这门语言本来就有的**，唯一的约束是
 * 两边槽数相同；语料里 `games/box.kc:43` 自己还写着注：
 * `obox=box; // copy entire array of structures :) [works for normal arrays without '[]' too]`
 * （"普通数组不带 `[]` 也一样"那半句就是下面 `C.arrs` 那一支）。
 */
function blockOperand(x, C) {
  /* 这一格在本函数里已经摊成一格 real 局部量了（见 `bodyOf` 里 `localReal` 的注）——
     那它就是个标量，不是那个同名的整块。 */
  if (isList(x) && tag(x) === 'name' && C.localReal !== undefined
    && C.localReal.has(idOf(x))) return null;
  const r = blockWalk(x, C);
  if (r !== null) {
    if (r.dims.length === 0 && r.ty === null) return null;   /* 落到一个数 -> 照旧走标量那条路 */
    const slots = r.dims.reduce((a, b) => a * b, 1) * structSize(r.ty ?? 'double', C);
    return { name: r.name, off: r.off, slots };
  }
  /* 没有类型的那一族（`static a[4]`）：整个名字就是一整块。
     这一支标成 **weak** —— 形参上的整块（`rotit (s[132], …)`）也登记在 `C.arrs` 里，
     而那张表**不分函数**，于是另一个函数里的局部标量 `s = sin(ang)`（megaminx.kc:379）
     在这儿看着也像"一整块"。所以 weak 那一支只在**右边也是一整块**时才算数。 */
  if (isList(x) && tag(x) === 'name' && C.arrs.has(idOf(x)) && !C.svars.has(idOf(x))) {
    const slots = C.arrs.get(idOf(x)).reduce((a, b) => a * b, 1);
    return slots > 1 ? { name: idOf(x), off: iNum(0), slots, weak: true } : null;
  }
  return null;
}

/** 整块那一格的槽下标：偏移 + 第 k 格，再过越界那一夹（与标量那条路同一手）。 */
function blockSlot(b, k, C) {
  const total = (C.arrs.get(b.name) ?? [1]).reduce((a, c) => a * c, 1);
  const off = k === null ? b.off : bin('+', b.off, typeof k === 'number' ? iNum(k) : k);
  return withOff(b.name, clampIdx(off, total), C);
}

/**
 * **整块赋值**（`otouch[i] = ntouch[i]` / `obox = box` / `pgs = gs`）：两边都是整块就
 * 逐槽拷一趟，不是就回 `null`（照旧走标量那条路）。
 *
 * 小块（≤ 8 槽，`point3d` 这一族是 3）摊开写 —— 这是每帧几百次的热路径；
 * 大块（整个结构体数组）走一格 while，省代码量。
 */
function blockAssignOf(lhsNode, rhsNode, C) {
  const d = blockOperand(lhsNode, C);
  if (d === null) return null;
  const s = blockOperand(rhsNode, C);
  if (s === null) {
    if (d.weak) return null;   /* 见 `blockOperand` 里 weak 那一段的注 */
    throw new Error(`eval->IR: \`${d.name}\` 这一处是一整块（${d.slots} 槽），`
      + '右边却不是同样的一块 —— 整块只能整块赋（说明书：两边大小要相同）');
  }
  if (d.slots !== s.slots) {
    throw new Error(`eval->IR: 整块赋值两边大小不同（左 ${d.slots} 槽、右 ${s.slots} 槽）`
      + ' —— 说明书只许"大小相同"那一种');
  }
  const put = (k) => ({
    kind: 'assign',
    target: { kind: 'index', obj: nameRef(d.name), index: blockSlot(d, k, C) },
    value: { kind: 'index', obj: nameRef(s.name), index: blockSlot(s, k, C) },
  });
  if (d.slots <= 8) {
    const out = [];
    for (let k = 0; k < d.slots; k++) out.push(put(k));
    return out;
  }
  const i = C.fresh('bk');
  return [
    { kind: 'let', name: i, type: REAL, init: num(0) },
    {
      kind: 'while',
      cond: bin('<', toInt(nameRef(i)), iNum(d.slots)),
      body: [
        put(toInt(nameRef(i))),
        { kind: 'assign', target: nameRef(i), value: bin('+', nameRef(i), num(1)) },
      ],
    },
  ];
}

/**
 * **`RND` / `NRND`**（`eval.txt`：RND 是 [0,1) 均匀、NRND 是 (0,1) 正态）。
 *
 * 落成**生成出来的函数**（像 `pd_fact` 那样），不走宿主 —— 于是三条腿逐字节相同，
 * 而这一族本来就"随机但可复现"（`srand(种)` 定种子）。
 *
 * 算法照 `eval.c:497` 那台 LCG（`h = h*214013 + 2531011`，MSVC 那一族的常数）+
 * `eval.c:503` 的 Box-Muller（拒绝采样 + 存住第二个值）。**位级不保证与 eval.c 相同**：
 * 那儿的 `krand` 把 32 位 long 的符号位也带进结果里（要靠 MSVC 32 位 long 的实现细节），
 * 我们这儿取非负那一半（`>>1`）—— 范围与分布照说明书。
 */
/**
 * **签名也要登记**：格式串那台机器按 `fns` 查返回类型 —— 不登记就被当 int，
 * 于是它会在已经是 real 的东西上再发一格 `(toreal …)`，方言当场报（`pd_fact` 那儿踩过）。
 */
function needRndSigs(C) {
  C.fns.set('pd_rnd', { params: [], ret: REAL });
  C.fns.set('pd_nrnd', { params: [], ret: REAL });
  C.fns.set('pd_srand', { params: [REAL], ret: REAL });
}

/**
 * **`%` 不是 `fmod`** —— 照 `eval.c:5141`（与 5709 那份逐字相同）：
 *
 *     case PERC: p0 = (*p1) - floor((*p1) / fabs(*p2)) * fabs(*p2);
 *
 * 也就是**按 |除数| 向下取整的模**，结果与除数同号无关、永远落在 `[0, |b|)`。
 * C 的 `fmod` / JS 的 `%` 是"向零截断"，被除数是负的时候给负数 —— 两者只在负数上分家，
 * 所以这一格藏得久：`town no texture.pss` 的楼高是 `(i*895 + j + 2) % 10`，
 * `i` 取到 -5 时那半边楼整个不是一个高度（我们 -8、正本 2），图上左半城全错。
 * `FMOD(a,b)` 是**另一个**东西（说明书里是 2 参函数），照旧是真 fmod —— 别混。
 *
 * 为什么要一格函数而不是当场展开：`a` 与 `b` 在式子里各出现两次，展开会把副作用
 * （`rnd % 3`、`i++ % 4`）做两遍。
 */
function needModSig(C) {
  C.needMod = true;
  C.fns.set('pd_mod', { params: [REAL, REAL], ret: REAL });
}

/** 一格 `a % b`（`%=` 那几处也走它）。 */
function modIR(C, a, b) {
  needModSig(C);
  return { kind: 'call', fn: nameRef('pd_mod'), args: [a, b] };
}

function modDecl() {
  const a = nameRef('a');
  const ab = rmath('fabs', [nameRef('b')]);
  return {
    kind: 'fn',
    name: 'pd_mod',
    params: [{ name: 'a', type: REAL }, { name: 'b', type: REAL }],
    ret: REAL,
    body: [{
      kind: 'return',
      values: [bin('-', a, bin('*', rmath('floor', [bin('/', a, ab)]), ab))],
    }],
  };
}

function rndDecls() {
  const st = nameRef('pd_rndst');
  /**
   * 一步 LCG。**照 `eval.c:497` 逐位**：
   *
   *     kholdrand = (unsigned long)((kholdrand * (214013*2) + 2531011*2) >> 1);
   *
   * 那一行的 32 位溢出 + `>>1` 合起来就是"**mod 2^31**"（`2A mod 2^32` 再右移一位
   * = `A mod 2^31`），而 `rnd` 回的是 `kholdrand / 2^31`。
   * 从前这儿是 `& 0xffffffff` 再在读的时候 `>>1` —— 那**既不是同一个状态、也不是同一个
   * 回值**（`r ≥ 2^31` 时 `floor(r/2) ≠ r mod 2^31`），于是随机那一族（7 份脚本）
   * 的序列整个对不上：`ken/mipmap.pss` 那张 256² 噪声纹理与参考完全不是一张图。
   * 参考也是照这一行写的（`c_impl/src/eval/pd_interp.c:35`），所以这一格三方一致。
   */
  const step = {
    kind: 'assign',
    target: st,
    value: bin('&', bin('+', bin('*', st, { kind: 'int', value: '214013' }),
      { kind: 'int', value: '2531011' }), { kind: 'int', value: '2147483647' }),
  };
  return [
    { kind: 'global', name: 'pd_rndst', type: INT },
    /* **`nrnd` 的第二格**：Box-Muller 一趟出两个正态数，原版把另一个存下来
       （`eval.c:504` 的 `static double srand2` + `snormstat`），**下一次调用直接回它、
       一格 `krand()` 都不再取**。我们从前每趟都重算 ⇒ 第二次起序列就与正本分家：
       `ken/balls.pss` 每个球取两次 `nrnd`（16384 个球），于是整张图每个像素都不一样
       （量出来 RMSE 26.07、非黑数只差 40 格 —— 覆盖一样、颜色全错，就是这一格）。
       `SRAND` 也要把它清掉（`ksrand` 里 `snormstat = 0`）。 */
    { kind: 'global', name: 'pd_nrnd2', type: REAL },
    { kind: 'global', name: 'pd_nrhas', type: REAL },
    {
      kind: 'fn',
      name: 'pd_srand',
      params: [{ name: 'seed', type: REAL }],
      ret: REAL,
      body: [
        {
          kind: 'assign',
          target: st,
          value: bin('&', { kind: 'builtin', name: 'toint', args: [nameRef('seed')] },
            { kind: 'int', value: '4294967295' }),
        },
        /* `ksrand` 也把 Box-Muller 那格存货清掉（`eval.c:493`）。 */
        { kind: 'assign', target: nameRef('pd_nrhas'), value: num(0) },
        { kind: 'return', values: [num(0)] },
      ],
    },
    {
      kind: 'fn',
      name: 'pd_rnd',
      params: [],
      ret: REAL,
      body: [
        step,
        {
          kind: 'return',
          values: [bin('/', { kind: 'builtin', name: 'toreal', args: [st] },
            num(2147483648))],
        },
      ],
    },
    {
      kind: 'fn',
      name: 'pd_nrnd',
      params: [],
      ret: REAL,
      body: [
        /* 上一趟存下的那一格：直接回它，一格 `krand()` 都不取（`eval.c:508-512`）。 */
        {
          kind: 'if',
          cond: bin('!=', nameRef('pd_nrhas'), num(0)),
          then: [
            { kind: 'assign', target: nameRef('pd_nrhas'), value: num(0) },
            { kind: 'return', values: [nameRef('pd_nrnd2')] },
          ],
          else_: [],
        },
        { kind: 'let', name: 'x', type: REAL, init: num(0) },
        { kind: 'let', name: 'y', type: REAL, init: num(0) },
        { kind: 'let', name: 'r', type: REAL, init: num(2) },
        {
          kind: 'while',
          cond: bin('>=', nameRef('r'), num(1)),
          body: [
            { kind: 'assign', target: nameRef('x'), value: bin('-', bin('*', num(2), { kind: 'call', fn: nameRef('pd_rnd'), args: [] }), num(1)) },
            { kind: 'assign', target: nameRef('y'), value: bin('-', bin('*', num(2), { kind: 'call', fn: nameRef('pd_rnd'), args: [] }), num(1)) },
            {
              kind: 'assign',
              target: nameRef('r'),
              value: bin('+', bin('*', nameRef('x'), nameRef('x')), bin('*', nameRef('y'), nameRef('y'))),
            },
          ],
        },
        /* `r == 0` 那一格要绕开（log(0)）：照 eval.c 的循环条件它也会被下一趟换掉，
           这儿直接当 1 用 —— 概率是 2^-62 那一档的事，但不许出 NaN。 */
        {
          kind: 'if',
          cond: bin('<=', nameRef('r'), num(0)),
          then: [{ kind: 'return', values: [num(0)] }],
          else_: [],
        },
        /* `r = sqrt(-2·ln r / r)`、存下 `x·r`、回 `y·r`（`eval.c:520-523` 的次序）。 */
        {
          kind: 'assign',
          target: nameRef('r'),
          value: rmath('sqrt', [bin('/', bin('*', num(-2),
            rmath('log', [nameRef('r')])), nameRef('r'))]),
        },
        { kind: 'assign', target: nameRef('pd_nrnd2'), value: bin('*', nameRef('x'), nameRef('r')) },
        { kind: 'assign', target: nameRef('pd_nrhas'), value: num(1) },
        { kind: 'return', values: [bin('*', nameRef('y'), nameRef('r'))] },
      ],
    },
  ];
}

/**
 * **重名的 static 改名**（`games/dragcards.kc` 里主函数与 `drawkard_init` 各有一格 `buf`）。
 *
 * 函数体里的 `static` 与 C 的 static 局部量同义 —— 它是**那个函数自己的**一格，跨调用留值。
 * 这一版把它们落在同一个平名字空间里（模块级的量），所以两个函数各写一格同名的就会共用
 * 一格 —— 原来当场报，现在按函数名加前缀分开（`drawkard_init__buf`）。
 *
 * 改名在**树上**做（原地改叶子的 value），于是后头 `declArr`/`exprOf`/`sizeof`/`bufset`
 * 那些都不必知道这件事 —— 它们看见的就是新名字。只改两种位置：
 *   * `(name a)` 里的那个叶子 —— 一切**读写**都走它；
 *   * `svar`/`svarl`/`sarr` 的第一个叶子 —— 声明处那个裸记号。
 * 别的裸叶子一律不碰：`(field 基 NAME)` 的字段名、`sty` 的类型名、`goto`/`label` 的标号
 * 都是裸的，碰了就把不相干的东西一起改了。
 */
function renameStatics(x, ren) {
  if (!isList(x)) return;
  const t = tag(x);
  const ks = kids(x);
  const hit = (a) => {
    if (a === undefined || a === null || a.kind !== 'atom') return;
    const nn = ren.get(low(a.value));
    if (nn !== undefined) a.value = nn;
  };
  if (t === 'name') { hit(ks[0]); return; }
  if (t === 'svar' || t === 'svarl' || t === 'sarr') {
    hit(ks[0]);
    for (const k of ks.slice(1)) renameStatics(k, ren);
    return;
  }
  /* `sty` 的第一个孩子是**类型名**，不是变量名。 */
  for (const k of (t === 'sty' ? ks.slice(1) : ks)) renameStatics(k, ren);
}

/**
 * 一个块里的 `static`（或 `auto`）声明清单。
 *
 * `tags` 那一格让同一台机器读两族声明：`static`/`sty` 是模块级那一档，
 * `auto`/`aty` 是**栈上**那一档（形状完全一样，只是落法不同 —— 见 `autoStmts`）。
 */
/**
 * **谁要装进一格数组里**（`C.boxed`）—— 整棵树走一遍，两处来源：
 *
 * * `&a` 形参（`pref`）—— 它拿到的就是调用方那一格数组；
 * * 实参位置的 `&x`（`addr`），且 `x` 不是本来就成块的东西（数组 / 结构体）。
 *
 * 这台机器**既算整份程序那一张**（`C.boxedAll` —— 模块级的量要不要改成 `(arr real)`
 * 得看整份程序），**也按函数各算一张**（`C.boxed`，见 `boxedFor`）：一个函数里的局部量
 * 只因为**别的**函数里有个同名的量被 `&` 过就装箱，纯是白开一格数组。
 */
function collectBoxed(x, C, out = new Set(), blocks = new Set()) {
  if (!isList(x)) return out;
  const t = tag(x);
  if (t === 'pref') { out.add(idOf(kids(x)[0])); return out; }
  if (t === 'addr') {
    const a = kids(x)[0];
    if (isList(a) && tag(a) === 'name') {
      const n = idOf(a);
      if (!C.arrs.has(n) && !C.svars.has(n) && !blocks.has(n)) out.add(n);
    }
    return out;
  }
  /* **调用点上那几格也要装箱**：被调的函数形参写着 `&x` 时，调用方**不用再写 `&`**
     （`tigrou/metaballs cube.pss:75` 是 `rotate(x, y, t/2*0.35)`，而 `:194` 的定义是
     `rotate(&x, &y, r)`）—— 那一格是"按名字传引用"，与 `&x` 同一件事，所以同样装箱。
     只认**光秃秃的名字**：`a[i]`/`p.x` 那两种本来就成块，走 `blockArg` 那条路。 */
  if (t === 'call') {
    const h = kids(x)[0];
    if (isList(h) && tag(h) === 'name') {
      const sig = C.fns.get(idOf(h));
      if (sig !== undefined) {
        const as = kids(x).slice(1);
        /* **`sig.params` 里"收整块"的那格占两位**（块 + 偏移，见 `paramInfos`）——
           所以实参与形参不是一一对应的，要自己挪那格游标。
           踩过一次：按下标直对时第二个 `&` 形参对上了偏移那一格（REAL），
           于是 `rot(x, y, r)` 里 `x` 装了箱、`y` 没装。 */
        let pi = 0;
        for (let i = 0; i < as.length && pi < sig.params.length; i++) {
          const block = sig.params[pi] === ARR;
          pi += block ? 2 : 1;
          const a = as[i];
          if (!block || !isList(a) || tag(a) !== 'name') continue;
          const n = idOf(a);
          if (!C.arrs.has(n) && !C.svars.has(n) && !blocks.has(n)) out.add(n);
        }
      }
    }
  }
  for (const k of kids(x)) collectBoxed(k, C, out, blocks);
  return out;
}

/** 这一份函数体里用到的（装箱的）名字 —— 用上头那格 `usedNames`（读也算）。 */

/**
 * **这一个函数**那张装箱名单。
 *
 * 装箱是"名字的属性"还是"那一格变量的属性"？—— 是后者：函数体里的 `x` 与别的函数里的 `x`
 * 是两格变量（这门语言没有词法闭包，局部量不出函数）。所以只收三处：
 *   * 这份函数自己的 `&x` 形参与体里的 `&x` / 按名字传引用（`collectBoxed` 走这一棵子树）；
 *   * **模块级**的量（`static`）—— 它们在 `preDecls` 里已经按整份程序那张单改成了
 *     `(arr real)`，读写必须跟着走箱子那条路，不然类型对不上；
 *   * 这份函数**收整块**的形参（`C.offs`）不在这儿 —— 那一族本来就是块。
 *
 * 收益：`tigrou/balls2k.pss` 的 `rotate(&x,&y,r)` 把 `x`/`y` 两个名字钉成了箱子，而
 * `drawsph` 里的 `x`/`y` 只是椭圆中心那两格局部量 —— 每次调用白开两格长度 1 的数组，
 * 一帧 175 个球 ⇒ 350 次 `omni_arr_f64_new`（占语言那一半 24.1% 的栈顶样本）。
 */
function boxedFor(node, C) {
  const own = collectBoxed(node, C, new Set(), C.blockNames);
  const out = new Set();
  for (const nm of C.boxedAll) {
    if (C.valParams.has(nm)) continue;
    if (own.has(nm) || C.globals.get(nm) === ARR) out.add(nm);
  }
  return out;
}

function staticDecls(x, out = [], tags = { plain: 'static', typed: 'sty' }) {
  if (!isList(x)) return out;
  /* **带类型的 static**（`static cel_t cel[12][12];`）—— 一格 `{ ty, one }`，
     由 `declTyped` 落（长度 = 各维之积 × 类型的槽数）。 */
  if (tag(x) === tags.typed) {
    const ks = kids(x);
    const ty = idOf(ks[0]);
    for (const one of ks.slice(1)) out.push({ name: idOf(kids(one)[0]), ty, one });
    return out;
  }
  if (tag(x) === tags.plain) {
    for (const one of kids(x)) {
      const k = kids(one);
      const n = idOf(k[0]);
      if (tag(one) === 'svar') {
        out.push({ name: n, init: k.length > 1 ? k[1] : undefined });
        continue;
      }
      /* `static x = {1,0,0}`（`svarl`）：**不带维度但跟着一张初值表** —— 那是结构体的初值，
         走 `declTyped` 那条路（它按槽填）。没有类型前缀就没意义，交给那边报。 */
      if (tag(one) === 'svarl') {
        out.push({ name: n, arr: one });
        continue;
      }
      /* `static a[16]`：**数组**。初值清单（`= {0}`）在 `eval.txt` 里明写"还没支持"，
         而语料里有 `clut[NMAX] = {0}` 这种"全零" —— 数组本来就是零开头，所以收下不管；
         真带非零清单的当场报（那是另一件事）。 */
      out.push({ name: n, arr: one, init: undefined, initList: k.length > 2 ? k[2] : undefined });
    }
    return out;
  }
  for (const k of kids(x)) staticDecls(k, out, tags);
  return out;
}

/** `auto`/`aty` 那一族（同一台机器，换两个标签）。 */
const autoDecls = (x, out = []) => staticDecls(x, out, { plain: 'auto', typed: 'aty' });

/**
 * **`auto` 的登记**：栈上那一档只往 `C.arrs` / `C.svars` 记形状（下标算式与 `.字段`
 * 要靠它们），**不进 `C.globals`** —— 它是函数里的一格局部量，`let` 由 `bodyOf` 补。
 *
 * 形状按名字记在同一张平表里（与 static 同一张）。同名不同形状的当场报 ——
 * 那种脚本要么真的重名，要么是我们这一版该加"按函数分名字空间"了，不能悄悄算错下标。
 */
function autoShape(C, s) {
  const isArr = s.ty !== undefined || s.arr !== undefined;
  if (!isArr) return { name: s.name, total: 0, vals: [], init: s.init };
  const ty = s.ty === undefined ? 'double' : s.ty;
  if (ty !== 'double' && !C.structs.has(ty)) {
    throw new Error(`eval->IR: \`auto ${s.ty} ${s.name}\` 里的 \`${s.ty}\` 不是登记过的结构体`);
  }
  const one = s.one ?? s.arr;
  const dims = tag(one) === 'sarr' ? dimsOf(one, C, s.name) : [];
  const size = structSize(ty, C);
  const total = dims.reduce((a, b) => a * b, 1) * size;
  const k = kids(one);
  const listAt = tag(one) === 'svarl' ? 1 : 2;
  const vals = k.length > listAt && tag(k[listAt]) === 'init' ? initVals(k[listAt], C) : [];
  if (vals.length > total) {
    throw new Error(`eval->IR: \`auto ${s.name}\` 的初值表有 ${vals.length} 格，`
      + `这一块只有 ${total} 格`);
  }
  const prev = C.arrs.get(s.name);
  if (prev !== undefined && (prev.length !== 1 || prev[0] !== total)) {
    throw new Error(`eval->IR: \`auto ${s.name}\` 与别处同名的那一格形状不同`
      + `（这儿 ${total} 格）—— 这一版的数组形状记在一张平表里，重名会算错下标`);
  }
  C.arrs.set(s.name, [total]);
  C.svars.set(s.name, { ty: ty === 'double' ? null : ty, dims });
  return { name: s.name, total, vals, arr: true };
}


/**
 * 一格函数体：顶上补 `let`（这门语言没有声明），再是语句。
 *
 * **形参与全局不补** —— 形参已经在签名里，全局（`static` / `enum`）是模块级那一格。
 *
 * `auto` 那一族**不在这儿补** —— 它的声明就发在声明那一处（`let` 带初值，见 `stmtOf`），
 * 因为"每趟调用重来"正是它与 static 的差别。这儿只把它们从 `written` 里摘掉，
 * 不然同一个名字会声明两次。
 */
function bodyOf(blk, params, C, curFn, boxInit = []) {
  const autos = autoDecls(blk).map((s) => autoShape(C, s));
  const autoNames = new Set(autos.map((a) => a.name));
  const written = writtenNames(blk);
  /**
   * **别人函数体里那格 `static` 不算这一份的全局。**
   *
   * 原版的名字表是一张平表（`eval.c:1802` 的 `newvarhash`，重名当场报"already
   * defined"），但它是**边解析边建**的：一个名字只有在**它那句 `static` 之前已经登记过**
   * 的时候才解析成那格 static，否则赋值就地造一格函数局部量。我们把所有 static 一次
   * 收齐再降级，于是"后面某个函数里的 `static v[3]`"会盖住"前面某个函数里当标量用的 `v`"
   * —— `ken/curvybuild.pss` 就是这个：第 48 行 `for(v=0,…)` 是主函数的局部标量，
   * 第 256 行 `static v[3]` 在 `drawcone` 里，我们于是报 `'v' 是 arr<real>，赋的值是 real`，
   * 整份跑不起来。
   *
   * 这一格只认**函数体里**声明的 static（`文件级` 那一档照旧是真全局 ——
   * `ken/*.pss` 里的相机状态全靠它跨函数看得见）。
   */
  const foreign = new Set();
  if (curFn !== undefined) {
    for (const n of written) {
      const owner = C.staticOwner.get(n);
      if (owner !== undefined && owner !== '文件级' && owner !== curFn) foreign.add(n);
    }
  }
  /**
   * **这一份函数里哪些名字是"量"**（形参 / `static` / 被赋过值的）——
   * 它们**盖住同名的 `enum`**。
   *
   * `enum` 那张表是**整份程序共用**的（原版也是一份全局表，`eval.c:392`），而名字
   * 大小写不敏感 ⇒ `ken/gspiral.pss` 里主函数写了 `enum {N=2^16}`，另一个函数里
   * 又有局部量 `n = min(…)`，两个名字在我们这儿是同一个。原版的次序是"先当变量看"
   * （赋值就地造一格局部量），所以这儿也得先看量、再看 enum ——
   * 不然那句赋值会落成给常量赋值（`未声明的变量 'n'`，整份跑不起来）。
   */
  C.shadow = new Set([...params, ...autoNames, ...written]);
  const lets = [];
  /* **装箱的局部量**（`&x` 传出去过的那些）：一格长度 1 的数组。形参与全局不算 ——
     形参拿到的就是调用方那一格，全局在模块级已经开好了。 */
  for (const n of usedNames(blk)) {
    if (!C.boxed.has(n) || autoNames.has(n)) continue;
    if (params.includes(n) || C.globals.has(n)) continue;
    lets.push({
      kind: 'let',
      name: n,
      type: ARR,
      init: {
        kind: 'builtin',
        name: 'anew',
        args: [{ kind: 'type', type: ARR }, { kind: 'int', value: '1' }],
      },
    });
  }
  /**
   * **这一份函数里被摊成一格 real 局部量的名字**（下面那个循环推进去的）。
   *
   * 为什么要记一笔：`C.svars` / `C.arrs` 那两张表**不分函数**，而 `static point3d r`
   * 这种"函数体里的 static"在别的函数里往往是个同名的局部标量
   * （`games/kjoust3d/kjoust3d.kc`：833 行声明 `static point3d r`，942 行另一个函数
   * 里 `r = (j*.34)%.3`）。整块那一族（`blockOperand`）只看名字会把后者也当成一整块，
   * 于是 `r = 一个数` 报"整块只能整块赋"。这张表就是那一格的判据。
   */
  const localReal = new Set();
  for (const n of written) {
    if (autoNames.has(n) || C.boxed.has(n)) continue;
    if (params.includes(n) || (C.globals.has(n) && !foreign.has(n))) continue;
    /* 宿主那一侧的量（host 模式下的 `bstatus` 那一族）不是局部：补一格 `let` 会生出个
       没人读的死变量，而写它已经落成 `(gfxcall "set…" …)` 了。 */
    if (C.gfxHost && (HOST_VARS.includes(n) || HOST_ARRS.includes(n))) continue;
    lets.push({ kind: 'let', name: n, type: REAL });
    localReal.add(n);
  }
  const prevLocalReal = C.localReal;
  C.localReal = localReal;
  const out = [...lets, ...boxInit, ...stmtsOf(kids(blk), C)];
  C.localReal = prevLocalReal;
  return out;
}

/**
 * 一张形参表 -> `[{ name, type }]`，顺手把**形状**登记上。
 *
 * 四态照 `eval.txt` 那张表（按值 / `&a` / `$a` / `a[…]`），再加 RScript 的**带类型**那一格
 * （`drawbox(box_t b)`）。数组与结构体那两格的类型是 `(arr real)` —— 这门语言里它们
 * 就是"一块摊平的 double"，形参拿到的是**同一块**（改得到调用方）。
 *
 * 维度与类型记进 `C.arrs` / `C.svars`：下标算式（多维摊平）与 `.字段`（偏移）要靠它们。
 * 没写长度的（`a[]`）不登记 —— 一维那条路不需要，`aget` 直接走。
 */
/**
 * **收整块的形参后头跟一格偏移形参**（`名字$o`，real）—— `&a[i]` / `&p.x` 那一族的落法，
 * 口径在 `docs/design/eval-realtime-gpu.md` 第 8.6 节。
 *
 * 标准 IR 里没有"带偏移的视图"，而 EVAL 里数组本来就是一段 double ⇒ 视图 = `(基, 起点)`
 * 两个数。函数体里 `a[j]` 落成 `a[a$o + j]`，调用点按实参形状算那格偏移。
 */
const offName = (n) => `${n}$o`;

/** **按值形参在入口里开箱子**那一档里，原来那格形参改的名字（见 fn 那一段的注）。 */
const valArgName = (n) => `${n}$v`;

/**
 * **入口收一整块那一档**（`(a[16])` —— EvalDraw 的"自己写乐器"模式，`insts/` 那一族
 * 五份脚本全是它）：宿主每采样调一次，那 16 格是**它传进来的寄存器**。
 *
 * 我们这边没有 MIDI 那一侧，所以在入口里**就地开一块**、按 `evaldraw.txt:1270-1296`
 * 那张表把初值填上（不是全零 —— `a[3] = 1/samprate` 要是 0，脚本里"推时间"那种循环
 * 就永远不动）。默认那三个数照说明书的例子取：`samprate = 44100`、
 * `midifrq = 60`（中央 C）、`midivol = 64`（"64 = normal"）。
 *
 *   a[0] 采样计数 0            a[1] 每采样的增量 2^((f-57)/12)*220*2π/sr
 *   a[2] 按下起的秒数 0        a[3] 1/sr
 *   a[4] 松开起的秒数 1e32     a[5] 音量系数 exp(v*.03)*512
 *   a[6] MIDI 音高 f           a[7] MIDI 音量 v         a[8..15] 草稿 0
 *
 * 值在这儿**算成字面量**（不是发 `exp`/`PI` 的算式）—— 三条腿拿到同一个数，
 * 于是出图照旧逐字节相同。偏移那一格（`a$o`）是 0：这块是就地开的，起点就是 0。
 */
function instrumentDecl(name, C) {
  const n = (C.arrs.get(name) ?? [1]).reduce((a, b) => a * b, 1);
  const sr = 44100;
  const midifrq = 60;
  const midivol = 64;
  const init = new Map([
    [1, (2 ** ((midifrq - 57) / 12)) * 220 * Math.PI * 2 / sr],
    [3, 1 / sr],
    [4, 1e32],
    [5, Math.exp(midivol * 0.03) * 512],
    [6, midifrq],
    [7, midivol],
  ]);
  const out = [{
    kind: 'let',
    name,
    type: ARR,
    init: {
      kind: 'builtin',
      name: 'anew',
      args: [{ kind: 'type', type: ARR }, { kind: 'int', value: String(n) }],
    },
  }];
  for (const [i, v] of init) {
    if (i >= n) continue;
    out.push({
      kind: 'assign',
      target: { kind: 'index', obj: nameRef(name), index: { kind: 'int', value: String(i) } },
      value: num(v),
    });
  }
  return out;
}

function paramInfos(psNode, C, register = true) {
  return kids(psNode).flatMap((p) => {
    const one = paramOne(p, C, register);
    /* 收整块的那几个后头补一格偏移形参（见 `offName` 的头注）。 */
    return one.type === ARR ? [one, { name: offName(one.name), type: REAL }] : [one];
  });
}

function paramOne(p, C, register) {
  {
    const t = tag(p);
    const k = kids(p);
    if (t === 'pty') {
      const ty = idOf(k[0]);
      const name = idOf(k[1]);
      if (ty !== 'double' && !C.structs.has(ty)) {
        throw new Error(`eval->IR: 形参 \`${idOf(k[0])} ${name}\` 里的类型不是登记过的结构体`);
      }
      const dims = k.length > 2 ? kids(k[2]).map((e) => {
        const v = constOf(e, C);
        if (v === null || !Number.isFinite(v) || v <= 0) {
          throw new Error(`eval->IR: 形参 \`${name}[…]\` 的长度算不出一格正整数`);
        }
        return v;
      }) : [];
      if (register) {
        C.arrs.set(name, [dims.reduce((a, b) => a * b, 1) * structSize(ty, C)]);
        C.svars.set(name, { ty: ty === 'double' ? null : ty, dims });
      }
      return { name, type: ARR };
    }
    if (t === 'parr') {
      const name = idOf(k[0]);
      if (k.length > 1 && register) {
        const dims = kids(k[1]).map((e) => {
          const v = constOf(e, C);
          if (v === null || !Number.isFinite(v) || v <= 0) {
            throw new Error(`eval->IR: 形参 \`${name}[…]\` 的长度算不出一格正整数`);
          }
          return v;
        });
        C.arrs.set(name, dims);
      }
      return { name, type: ARR };
    }
    /* `&a` 形参：拿到的是调用方那一格长度 1 的数组（`C.boxed` 里那一族）。 */
    if (t === 'pref') return { name: idOf(k[0]), type: ARR };
    return { name: idOf(k[0]), type: REAL };
  }
}

/**
 * **形参与别处的数组/结构体重名就改名**（`demos/planpos.kc`：`vec` 既是文件级的
 * `dpoint3d vec`、又是 `getobjectspos` 的形参 `dpoint3d vec[11]`）。
 *
 * 形状（维度、结构体类型）记在一张**平表**里（`C.arrs` / `C.svars`），所以重名会把
 * 先登记的那一格冲掉 —— 冲掉之后 `vec.x` 报"是数组，取字段之前要先给下标"。
 * 形参本来就是函数自己的，改名在语义上不动任何东西：形参那个记号 + 这一份函数体。
 */
function renameParams(psNode, body, fname, C) {
  const ren = new Map();
  for (const p of kids(psNode)) {
    const t = tag(p);
    if (t !== 'pty' && t !== 'parr') continue;
    const at = kids(p)[t === 'pty' ? 1 : 0];
    if (at === undefined || at === null || at.kind !== 'atom') continue;
    const name = low(at.value);
    if (!C.arrs.has(name) && !C.svars.has(name)) continue;
    let nn = `${fname}__${name}`;
    while (C.arrs.has(nn) || C.svars.has(nn) || C.globals.has(nn) || C.enums.has(nn)) nn = `${nn}_`;
    at.value = nn;
    ren.set(name, nn);
  }
  if (ren.size > 0) renameStatics(body, ren);
}

/* ─── 顶层 ───────────────────────────────────────────────────────────── */

/**
 * `.pss` 的树 → 标准 IR。
 *
 * 形状：`(program <文件级的 static/enum>… (main (params …) (block …)) (fn 名 (params …) (block …))…)`
 */
/**
 * 这份脚本用过 **GL 那一族**没有（整棵树扫一遍调用名）。
 *
 * 用过就**只走设备那条路**（`gfxHost`）：GL 的命令在语言这一侧变成顶点批
 * （`gl-rt.js`），2D 那几格也交给同一格设备 —— 不然一趟里会有两块帧缓冲
 * （生成出来那块 + 设备那块），出两份图。见 `docs/design/eval-realtime-gpu.md` 第 9 节。
 */
/** 树里出现过这个名字没有（`glob[]` 那一格靠它 —— 脚本从不声明它）。 */
function usesName(x, want) {
  if (!isList(x)) return false;
  if (tag(x) === 'name' && idOf(x) === want) return true;
  return kids(x).some((k) => usesName(k, want));
}

function usesGL(x, host) {
  if (!isList(x)) return false;
  if (tag(x) === 'call') {
    const head = kids(x)[0];
    if (isList(head) && tag(head) === 'name') {
      const key = `${idOf(head)}/${kids(x).length - 1}`;
      const f = host.draw?.get(key);
      if (f !== undefined && f.startsWith('gl_')) return true;
    }
  }
  return kids(x).some((k) => usesGL(k, host));
}

export function evalToIR(cst, host, src = '') {
  /* GL 那一族只在设备那条路上有（见 `usesGL` 的头注）。**着色器那一族也在里头** ——
     第四刀之后它与固定管线走的是同一条路（顶点与批在语言这一侧，见 `gl-rt.js`）。 */
  const glUsed = host.glrt === true && usesGL(cst, host);
  const C = {
    host,
    /* 画图走宿主调用（`(gfxcall …)`）还是生成出来的 CPU 光栅器 —— 见 `gfxMode()` 的头注。
       `null` 是**录制那一档**（设备只记账不画，量语言这一半与量覆盖用它）—— 它也是宿主调用。 */
    gfxHost: glUsed || ['host', 'gl', 'auto', 'null'].includes(gfxMode()),
    /* 录制那一档（`--gfx null`）：设备认所有名字 ⇒ adapter 这一层也不拦（见 callOf 那一段）。 */
    recGfx: gfxMode() === 'null',
    fns: new Map(),
    globals: new Map(),                 /* 名字 -> 类型（`static`） */
    staticInits: [],                    /* `static x = 3;` 的初值：入口里做**一次** */
    staticOwner: new Map(),             /* static 的名字 -> 哪儿声明的（重名时报得清楚） */
    enums: new Map(),                   /* 名字 -> 常量值（`enum`） */
    structs: new Map(),                 /* 结构体类型名 -> { size, fields }（见 collectStructs） */
    svars: new Map(),                   /* 带类型的变量名 -> { ty, dims }（见 declTyped） */
    strs: new Map(),                    /* 内部到的串 -> 下标（着色器名 / uniform 名） */
    shaders: [],                        /* `@v` / `@f` / `@g` 区段（原文原样） */
    arrs: new Map(),                    /* `static a[n]` 的名字 -> 各维长度（编译期就知道） */
    arrInits: [],                       /* 那几格数组的 `a = (anew …)`：入口里做一次 */
    boxed: new Set(),                   /* 被取过地址的量（`&x`）：落成一格长度 1 的数组 */
    boxedAll: new Set(),                /* 整份程序那一张（`C.boxed` 是**当前这个函数**那一张） */
    blockNames: new Set(),              /* 函数体里那些"本来就成块"的名字（`auto a[3]` / 带类型的） */
    valParams: new Set(),               /* 当前函数**按值**收的形参（`&x` 碰上它要报） */
    gotoActive: [],                     /* 正在降哪几格标号前头那一段（`goto` 的旗子名） */
    /* **块里头那些标号**（名字 -> 那一段原文语句）：外层的 `goto` 跳进来时照抄一份，
       见 `stmtOf1` 的 `goto` 那一格与 `stmtsOf` 头上那段。`expanding` 是防自套的记号。 */
    innerLabels: new Map(),
    expanding: new Set(),
    /* **跳进循环体**那一档：名字 -> 旗子（`stmtsOf` 看见这格标号时拆成"前段包一层 if"）。 */
    loopEntry: new Map(),
    /* **跳进块里**那一档：名字 -> 那几句原文（`goto` 那儿照抄一份，见 `blockEntryAt`）。 */
    gotoCopy: new Map(),
    /* **往后跳进嵌套里**那一档：名字 -> 进入旗 / 名字 -> 绕回旗（见 `pathEntryAt`）。 */
    pathEntry: new Map(),
    gotoPair: new Map(),
    needRnd: false,                     /* 用过 `RND`/`NRND`/`SRAND` 没有 */
    need3D: false,                      /* 用过 3D 那一族没有（`gfx3-rt.js`：投影在语言这一侧） */
    needNoise: false,                   /* 用过 `NOISE`/`NOISE3D` 没有（`noise-rt.js`） */
    usedGL: false,                      /* 这份脚本用过 GL 那一族没有（每帧初态要不要发） */
    /* 用到了宿主那"每帧盖一次"的哪几格（`xres`/`yres`/`mousx`/`mousy`）——
       用到的那几格各有一格模块级量，每帧开头问设备一次盖上去。 */
    hostFrame: new Set(),
    needFact: false,
    /* **收整块的形参 -> 它那格偏移形参的名字**（`名字$o`，见 `offName` 的头注）：
       一函数一张，降那一份函数体之前摆好。 */
    offs: new Map(),
    fresh: (() => { let i = 0; return (p) => `${p}_pd${i++}`; })(),
    tyCtx: () => ({
      /* 全是 double：`env.get` 一律回 real，`fns` 给格式串那台机器看返回类型。
         **例外是 `static` 数组**（`(arr real)`）—— 不回 arr 的话 `aget` 会被当 int，
         于是格式串那台机器在已经是 real 的东西上再发一格 `(toreal …)`，方言当场报。 */
      env: { get: (n) => (C.arrs.has(n) || C.boxed.has(n) ? ARR : REAL) },
      fns: C.fns,
      fields: new Map(),
    }),
  };

  const top = kids(cst);
  const mainNode = top.find((x) => tag(x) === 'main');
  if (mainNode === undefined) throw new Error('eval->IR: 这份脚本里没有主函数');

  /* `@v` / `@f` / `@g` 区段（着色器原文）：词法层把第一个 `@` 到末尾整段跳过去了，
     所以这儿从**原文**里切 —— 切出来的原样交给设备（`(gfxdef …)` 登记在入口里）。 */
  if (C.gfxHost) C.shaders = splitSections(src);

  /* **enum 先收一遍**（整棵树：文件级的与函数体里的都算）—— `static a[NMAX]` 的长度
     要用它，而语料里 enum 多半就写在用它那句的上一行。 */
  collectEnums(cst, C);
  /* **结构体也先收一遍**（同一个理由：`static cel_t cel[N]` 要知道 `cel_t` 有几格）。 */
  collectStructs(cst, C);

  /* 第一遍：登记文件级的 `static`，以及每个用户函数的签名。 */
  /**
   * **`glob[]`**：EvalDraw 的那格**全局 scratch 数组**（`evaldraw.txt:1293`；
   * `demos/lab3d.kc` / `goldball2.kc` / `rotozoom4.kc` 拿它当"不用声明的公共内存"）。
   * 脚本里从来不声明 ⇒ 用到了就登记成一格模块级 `(arr real)`，长度取 **65536**
   * （原版没写上限；语料里最大的下标是几千）。摆在 `preDecls` 前头 —— 那一格要跟着走。
   */
  const preDecls = [];
  if (usesName(cst, 'glob')) {
    C.arrs.set('glob', [65536]);
    preDecls.push({ kind: 'global', name: 'glob', type: ARR });
    C.arrInits.push({ name: 'glob', total: 65536, vals: [] });
  }
  for (const x of top) {
    if (tag(x) === 'enum' || tag(x) === 'struct') continue;   /* 上面两趟已经收过 */
    /* 带类型的 static（`static point3d p[N];`）—— 与下面那一支的差别只在"多一个类型"。 */
    if (tag(x) === 'sty') {
      const ks = kids(x);
      const ty = idOf(ks[0]);
      for (const one of ks.slice(1)) {
        const n = idOf(kids(one)[0]);
        C.staticOwner.set(n, '文件级');
        declTyped(C, preDecls, ty, one, '文件级');
      }
      continue;
    }
    if (tag(x) === 'static') {
      for (const one of kids(x)) {
        const k = kids(one);
        const n = idOf(k[0]);
        if (tag(one) === 'svar') {
          C.globals.set(n, REAL);
          C.staticOwner.set(n, '文件级');
          preDecls.push({ kind: 'global', name: n, type: REAL });
          if (k.length > 1) C.staticInits.push({ name: n, init: k[1] });
          continue;
        }
        declArr(C, preDecls, n, one, '文件级');
      }
      continue;
    }
    if (tag(x) === 'fn') {
      const name = idOf(kids(x)[0]);
      /* 这一趟只要**签名**（元数与每格的类型），形状那张表留到下头真降的时候登记 ——
         那时候才知道要不要给形参改名（`renameParams`）。 */
      const ps = paramInfos(kids(x)[1], C, false);
      C.fns.set(name, { params: ps.map((p) => p.type), ret: REAL });
    }
  }

  /* **函数体里的 `static` 也是模块级的量**：EVAL 与 C 的 static 局部量同义 ——
     跨调用留值、初值只做一次。这门语言"宿主每帧调一次脚本"的执行模型全靠它
     （`ken/*.pss` 里相机位置与速度都是主函数里的 `static`）。
     名字落在同一个平名字空间里，所以**重名的那格按函数名加前缀**（`renameStatics`）：
     先见到的那个函数留原名，后头同名的改成 `函数名__名字`。 */
  for (const x of top) {
    const isMain = tag(x) === 'main';
    if (!isMain && tag(x) !== 'fn') continue;
    const where = isMain ? '主函数' : idOf(kids(x)[0]);
    const body = isMain ? kids(x)[1] : kids(x)[2];
    const ren = new Map();
    /* 同一个函数里**同名的 static 写了两遍**（`games/backgammon.kc` 的 `dicephys` 里
       `static m[9]` 写在两处）—— 那是**同一格量**（这门语言函数里就一张平名字空间），
       只算头一格：不然改名与声明各做两遍，落出两格同名的模块级量（下游当场报重复定义）。 */
    const sdecls = [];
    const sseen = new Set();
    for (const s of staticDecls(body)) {
      if (sseen.has(s.name)) continue;
      sseen.add(s.name);
      sdecls.push(s);
    }
    for (const s of sdecls) {
      const prev = C.staticOwner.get(s.name);
      if (prev === undefined || prev === where) continue;
      let nn = `${isMain ? 'main' : where}__${s.name}`;
      while (C.staticOwner.has(nn) || C.globals.has(nn) || C.enums.has(nn)) nn = `${nn}_`;
      ren.set(s.name, nn);
      C.staticOwner.set(nn, where);
    }
    if (ren.size > 0) renameStatics(body, ren);
    for (const s of sdecls) {
      const nm = ren.get(s.name) ?? s.name;
      C.staticOwner.set(nm, where);
      /* 带类型的那一档（`static cel_t cel[12][12]` 写在函数体里）。 */
      if (s.ty !== undefined) { declTyped(C, preDecls, s.ty, s.one, where); continue; }
      if (s.arr !== undefined) { declArr(C, preDecls, nm, s.arr, where); continue; }
      if (!C.globals.has(nm)) {
        C.globals.set(nm, REAL);
        preDecls.push({ kind: 'global', name: nm, type: REAL });
      }
      if (s.init !== undefined) C.staticInits.push({ name: nm, init: s.init });
    }
  }

  /* **谁要装箱**（`&x`）—— 摆在这儿是因为它要先知道哪些名字**本来就成块**
     （文件级与函数里的数组/结构体都登记过了），那些不装箱，直接把那一块传过去。
     装箱的**全局**要从 `real` 改成一格长度 1 的 `(arr real)`：初值也跟着改成写 `x[0]`。 */
  C.blockNames = new Set(
    autoDecls(cst).filter((s) => s.ty !== undefined || s.arr !== undefined).map((s) => s.name),
  );
  C.boxedAll = collectBoxed(cst, C, new Set(), C.blockNames);
  C.boxed = C.boxedAll;
  for (const d of preDecls) {
    /* **已经成块的不许再装箱**：`C.arrs` 里那些是真有长度的数组（`static v[3]`），
       照 collectBoxed 的口径"直接把那一块传过去"。漏掉这一夹的时候
       `ken/curvybuild.pss` 的 `static v[3]`（在函数体里、又拿 `getperpvec(v,a,b)`
       传出去）会被改成长度 1 的箱子 ⇒ 跑起来 `array index out of range: 1 (length 1)`。 */
    if (d.kind === 'global' && C.boxedAll.has(d.name) && !C.arrs.has(d.name)) {
      d.type = ARR;
      C.globals.set(d.name, ARR);
      C.arrInits.push({ name: d.name, total: 1, vals: [] });
    }
  }


  const decls = [...preDecls];
  for (const x of top) {
    if (tag(x) !== 'fn') continue;
    const name = idOf(kids(x)[0]);
    renameParams(kids(x)[1], kids(x)[2], name, C);
    const ps = paramInfos(kids(x)[1], C);
    /* **装箱是按函数算的**：整份程序那张名单里，凡是本函数**按值**收的形参都不算箱子
       （`demos/planpos.kc` 里 `year` 在一处是 `&year`、在 `getday(year,…)` 里是按值的形参）。 */
    C.valParams = new Set(ps.filter((p) => p.type === REAL).map((p) => p.name));
    C.boxed = boxedFor(x, C);
    /**
     * **按值收的形参也被 `&` 取过地址**（`games/chess/chess.kc` 的 `&caststat`、
     * `geeky/…` 那一份的 `&r`）—— 从前这儿当场报"这一版不接"。
     *
     * 做法就是行注里那句"在入口里开箱子"：形参改名成 `名字$v`（照旧按值收），
     * 函数体里那个名字变成**一格长度 1 的数组**（`bodyOf` 的装箱那段自己会开它，
     * 因为改名之后它不在 `params` 里了），入口先抄一句 `名字[0] = 名字$v`。
     *
     * 这是**对的**而不是将就：EVAL 的按值形参就是调用方那个值的一份拷贝，
     * `&它` 要的只是"一格能写的地方"，写回调用方本来也不该发生。
     */
    const own = collectBoxed(x, C, new Set(), C.blockNames);
    const valBox = [...C.valParams].filter((n) => own.has(n));
    for (const n of valBox) { C.valParams.delete(n); C.boxed.add(n); }
    const psOut = ps.map((p) => (valBox.includes(p.name)
      ? { ...p, name: valArgName(p.name) } : p));
    const boxInit = valBox.map((n) => ({
      kind: 'assign', target: boxRef(n), value: nameRef(valArgName(n)),
    }));
    C.innerLabels = new Map();
    /* 这一份函数体里"收整块的形参"各自那格偏移（`名字$o`）—— 下标都要加上它。 */
    C.offs = new Map(ps.filter((p) => p.type === ARR).map((p) => [p.name, offName(p.name)]));
    decls.push({
      kind: 'fn',
      name,
      params: psOut,
      ret: REAL,
      body: bodyOf(kids(x)[2], psOut.map((p) => p.name), C, idOf(kids(x)[0]), boxInit),
    });
  }

  /* 主函数：EVAL 里它的形参是宿主传进来的（PolyDraw 不传，`()` 是常态）——
     有形参就在入口里当零值的局部量。 */
  const mainInfos = paramInfos(kids(mainNode)[0], C);
  const mainPs = mainInfos.map((p) => p.name);
  /* 按值那一族才算 `valParams`（`&x` 取地址要据此在入口里开箱子）—— 收整块的那个不算。 */
  C.valParams = new Set(mainInfos.filter((p) => p.type !== ARR).map((p) => p.name));
  C.boxed = boxedFor(mainNode, C);
  /* 上一份函数留下的偏移表不许串到这儿：入口那格整块是**就地开的**（起点 0），
     所以这儿的偏移永远是 0，不用登记。 */
  C.offs = new Map();
  C.innerLabels = new Map();
  const mainBody = [
    ...mainInfos.flatMap((p) => (p.type === ARR ? instrumentDecl(p.name, C)
      : [{ kind: 'let', name: p.name, type: REAL }])),
    ...bodyOf(kids(mainNode)[1], mainPs, C, '主函数'),
  ];
  /**
   * **每帧的 GL 初态**：PolyDraw 的宿主在调脚本之前会把 GL 摆回去
   * （`polydraw.c:3572-3579`：清 color/depth/stencil、开深度测试、
   * PROJECTION = `gluPerspective(gfov, 宽/高, 0.1, 1000)`、MODELVIEW = 单位）。
   * 所以**用了 GL 那一族的脚本**每帧开头发一格 `gl_framebegin`（生成出来那一份 ——
   * GL 的状态机在语言这一侧，设备只收顶点批与清屏，见第 9 节"只有一个模型"）。
   *
   * 只给用过 GL 的脚本发（`C.usedGL`）：纯算术的 `.pss`（`01-arith.pss`）不该因此把
   * 整摊 GL 运行时带进来。EvalDraw 那张表没有这一格 —— 它是 2D，"要不要清"是
   * 脚本自己用 `cls()` 说的。
   */
  if (C.host.frameReset === true && C.usedGL) {
    mainBody.unshift({
      kind: 'expr-stmt',
      expr: C.needGL
        ? { kind: 'call', fn: nameRef('gl_framebegin'), args: [] }
        /* 没走 `gl-rt.js` 那一份的那几门（宿主表里没有 `glrt`，例如 EvalDraw 的 GL 子集）：
           每帧初态交给设备自己做。 */
        : gfxCallIR('framebegin'),
    });
  }

  /* **每帧开头那一句 `qglsetshader(0)`**（`polydraw.c:2283` —— 就在 `gevalfunc()` 前面）：
     有 `@v`/`@f` 区段的脚本，**这一对从帧头就在用着**，不用自己调 `glsetshader`。
     `ken/interference.pss` 就是这么写的（整份脚本只有 `glBegin/glVertex/glEnd`）——
     从前我们按内建那对画，它那句 `glColor(klock(),0,0)` 在第 0 帧是黑的，
     于是整张图全黑；照这一句改过来才是参考画的那张干涉条纹。
     只在**两类区段都有**的时候发：`setshader_int` 缺一类就挑不出一对。 */
  if (C.host.frameReset === true && C.needGL
    && C.shaders.some((s) => s.kind === 'vert') && C.shaders.some((s) => s.kind === 'frag')) {
    /* 摆在 `gl_framebegin` **后面**（它刚被 unshift 到第 0 格）—— 原版也是先摆 GL 初态、
       再 `qglsetshader(0)`、再调脚本。 */
    mainBody.splice(1, 0, {
      kind: 'expr-stmt',
      expr: { kind: 'call', fn: nameRef('gl_setshader1'), args: [num(0)] },
    });
  }

  /* **宿主那"每帧盖一次"的几格**（`xres`/`yres`/`mousx`/`mousy`，见 `HOST_WRITABLE` 头注）：
     照 `polydraw.c:2276-2280`，在脚本跑之前盖上去。摆在最前面 —— 那四句在原版里
     也在 `gevalfunc()` 之前。 */
  for (const n of [...C.hostFrame].reverse()) {
    mainBody.unshift({ kind: 'assign', target: nameRef(hvName(n)), value: gfxCallIR(n) });
    C.globals.set(hvName(n), REAL);
    decls.push({ kind: 'global', name: hvName(n), type: REAL });
  }

  if (C.needFact) decls.push(factDecl());
  /* `%` 那格模（照 `eval.c:5141`，不是 fmod）。 */
  if (C.needMod) decls.push(modDecl());
  /* `RND`/`NRND`/`SRAND` 那一摊（生成出来的 LCG + Box-Muller，三条腿逐字节相同）。 */
  if (C.needRnd) decls.push(...rndDecls());
  /* **噪声那一族**（`NOISE(x[,y[,z]])` / `NOISE3D`）：照 `polydraw.c:852` 那份算法生成 ——
     纯函数，所以在语言这一侧（见 `noise-rt.js` 的头注），不进设备。 */
  if (C.needNoise) {
    decls.unshift(...noiseGlobalDecls());
    decls.push(...noiseFnDecls());
  }
  /* `static x = 3;` 的初值：**在入口里做一次**（方言的 `(global 名 类型)` 不许带初值 ——
     `lower/lower.js` 那一段写着"要非零初值就让 adapter 在入口里摆一句 set"）。
     摆在帧循环**之前**，所以它一辈子只跑一趟 —— 那正是 static 的意思。 */
  const initStmts = [
    /* `static a[n]` 的那一块：**入口里开一次**（数组从零开始，与 EVAL 一样）。
       摆在 static 标量的初值**前面** —— 初值里可能就用着数组。
       带初值表的（`static vert[24] = {0,1,3,2,…}`，`ken/heightmap.pss:1`）紧跟着按下标赋值：
       **从前这张表是收下就丢的**，于是那种脚本安静地跑在全零的数组上（查过一次才发现）。 */
    ...C.arrInits.flatMap((a) => [
      {
        kind: 'assign',
        target: nameRef(a.name),
        value: {
          kind: 'builtin',
          name: 'anew',
          args: [{ kind: 'type', type: ARR }, { kind: 'int', value: String(a.total) }],
        },
      },
      ...(a.vals ?? []).flatMap((v, i) => (v === null ? [] : [{
        kind: 'assign',
        target: { kind: 'index', obj: nameRef(a.name), index: iNum(i) },
        value: v,
      }])),
    ]),
    /* 随机数那台机器的种子：`kholdrand = 1`（`eval.c:490`）。 */
    ...(C.needRnd ? [{
      kind: 'assign', target: nameRef('pd_rndst'), value: { kind: 'int', value: '1' },
    }] : []),
    /* 噪声的置换表：`noiseinit()` 在 PolyDraw 里是开机时调一次（`polydraw.c:3538`）。 */
    ...(C.needNoise ? [{
      kind: 'expr-stmt', expr: { kind: 'call', fn: nameRef('pd_noiseinit'), args: [] },
    }] : []),
    ...C.staticInits.map((s) => ({
      kind: 'assign',
      target: C.boxed.has(s.name) ? boxRef(s.name) : nameRef(s.name),
      value: exprOf(s.init, C),
    })),
  ];
  /* **用过画图那一族就把设备带上**（`gfx-rt.js` 生成的那十几格函数 + 一块帧缓冲），
     并在入口末尾补一句 `gfx_present()` —— EvalDraw 的脚本多半不自己调 `refresh()`
     （宿主每帧替它交一次），所以"一帧画完就交出去"是这条腿上的默认。 */
  /* **只有 `@v`/`@f` 两段、一句脚本都没有**那一档（`ken/multiarb_asm.pss` 整份就是两段
     ARB 汇编）：那也是一份画图程序 —— 原版每帧照样清屏 + 交图，给出的是一张清过的图。
     不带上设备的话我们连帧循环都不生成，一张图都不出（判据记成"跑不起来"）。 */
  if (C.shaders.length > 0) C.needGfx = true;
  if (C.needGfx) {
    /* **宿主调用那条路**：设备在宿主那边，这儿什么都不用带 —— 入口变成一格**帧循环**。
       EVAL 的执行模型是"宿主每帧调脚本一次"（`evaldraw.txt` 那句 "your function is called
       once per frame"、`polydraw.c` 的主循环），所以脚本主体落成一格函数 `eval$frame`，
       入口只剩：

           while (gfxcall "nextframe" != 0) eval$frame();

       **循环在设备里**（`nextframe` 那一格）：离屏那一档画 `OMNI_FRAMES` 帧（默认 1）、
       本机 OpenGL 那一档 poll 事件 + 交换缓冲 + 窗口没关就接着画。
       `static` 是模块级的量，所以它天然跨帧活 —— 那正是 EVAL 里 `static` 的意思。 */
    if (C.gfxHost) {
      /* **GL 那一族的命令 -> 顶点批**（`gl-rt.js`）也跟着产物走：它做变换、拆 mode、
         合批，设备只收 `(gfxbatch …)`。一帧的末尾要把攒着的批交出去（`gl_flush`）——
         设备是在 `nextframe` 那一格交图的，交之前批必须已经画下去。 */
      if (C.need3D) {
        decls.unshift(...gfx3GlobalDecls());
        decls.push(...gfx3FnDecls(true));
      }
      if (C.needGL) {
        decls.unshift(...glGlobalDecls());
        decls.push(...glFnDecls());
        mainBody.push({
          kind: 'expr-stmt',
          expr: { kind: 'call', fn: nameRef('gl_flush'), args: [] },
        });
      }
      decls.push({
        kind: 'fn', name: 'eval$frame', params: [], ret: REAL, body: mainBody,
      });
      /* **登记那几格串**（一趟只做一次，摆在入口最前头）：`@v`/`@f` 区段的原文，
         以及内部到的名字（着色器名 / uniform 名）—— 运行期的调用照旧全是 double。 */
      const regs = [];
      /* **有没有几何段是整份脚本的属性**（翻译要按它给跨段量起名，见 `glsl.js` 头注）。 */
      const hasGeom = C.shaders.some((s) => s.kind === 'geom');
      for (const s of C.shaders) {
        /* **着色器原文在这儿（编译期）就翻成对齐后的主体**（`glsl.js`）——
           两档 GPU 设备收到的是同一份文本，各自只补 `#version` 那一行。
           在设备里各翻一遍就是两份实现（口径：`docs/design/eval-realtime-gpu.md` 13.2）。 */
        const text = s.kind === 'name' ? s.text
          : glslAlign(s.kind, s.text, { hasGeom, geo: s.geo });
        regs.push({ kind: 'expr-stmt', expr: gfxDefIR(s.kind, s.name, text) });
      }
      for (const [s, i] of C.strs) {
        regs.push({ kind: 'expr-stmt', expr: gfxDefIR('name', i, s) });
      }
      decls.push({
        kind: 'main',
        body: [...regs, ...initStmts, {
          /* **把每帧那一格函数交给设备**：浏览器那一档拿它做 `requestAnimationFrame`
             循环（那边产物在主线程同步跑，下面那条 while 会把页面卡死，所以它的
             `nextframe` 直接回 0）。本机那两档记下不用，照旧自己转下面那条 while。 */
          kind: 'expr-stmt',
          expr: {
            kind: 'builtin',
            name: 'gfxframefn',
            args: [{ kind: 'string', value: 'eval$frame' }],
          },
        }, {
          kind: 'while',
          cond: bin('!=', gfxCallIR('nextframe'), num(0)),
          body: [{ kind: 'expr-stmt', expr: { kind: 'call', fn: nameRef('eval$frame'), args: [] } }],
        }],
      });
      return { kind: 'module', decls };
    }
    const W = 320;
    const H = 240;
    decls.unshift(...gfxGlobalDecls());
    decls.push(...gfxFnDecls(W, H), gfxPresentDecl(irOutPath()));
    if (C.need3D) {
      decls.unshift(...gfx3GlobalDecls());
      decls.push(...gfx3FnDecls(false));
    }
    if (C.needGL) {
      decls.unshift(...glGlobalDecls());
      decls.push(...glFnDecls());
    }
    mainBody.push({
      kind: 'expr-stmt',
      expr: { kind: 'call', fn: nameRef('gfx_present'), args: [] },
    });
  }
  decls.push({ kind: 'main', body: [...initStmts, ...voidRets(mainBody)] });
  return { kind: 'module', decls };
}

/**
 * 主体进 `(main …)`（**void**）那一档：把带值的 `return v` 摊成"做一句 + 空返回"。
 *
 * 为什么不在降 `return` 那一格分：`C.needGfx`（= 走不走帧函数那条路）要等 body 降完
 * 才知道，而 `return` 可能出现在第一句画图调用前头 —— 那样同一份脚本里会混着两种形状。
 * 这一格是**收尾时统一改一遍**，所以两条路各自都只有一种形状。
 */
function voidRets(ss) {
  return ss.flatMap((s) => {
    if (s.kind === 'return' && (s.values ?? []).length > 0) {
      return [{ kind: 'expr-stmt', expr: s.values[0] }, { kind: 'return', values: [] }];
    }
    if (s.kind === 'if') {
      return [{ ...s, then: voidRets(s.then ?? []), else_: voidRets(s.else_ ?? []) }];
    }
    if (s.kind === 'while' || s.kind === 'for') return [{ ...s, body: voidRets(s.body ?? []) }];
    if (s.kind === 'block') return [{ ...s, stmts: voidRets(s.stmts ?? []) }];
    return [s];
  });
}

/** `FACT(n)`：说明书说它走 gamma，这一版只对**非负整数**成立（一格循环）。 */
function factDecl() {
  return {
    kind: 'fn',
    name: 'pd_fact',
    params: [{ name: 'n', type: REAL }],
    ret: REAL,
    body: [
      { kind: 'let', name: 'r', type: REAL, init: num(1) },
      { kind: 'let', name: 'i', type: REAL, init: num(2) },
      {
        kind: 'while',
        cond: bin('<=', nameRef('i'), nameRef('n')),
        body: [
          { kind: 'assign', target: nameRef('r'), value: bin('*', nameRef('r'), nameRef('i')) },
          { kind: 'assign', target: nameRef('i'), value: bin('+', nameRef('i'), num(1)) },
        ],
      },
      { kind: 'return', values: [nameRef('r')] },
    ],
  };
}

/* ─── 两门语言各自的入口 ─────────────────────────────────────────────── */

/** PolyDraw（`.pss`）。 */
export function polydrawToIR(cst, opts = {}) {
  return evalToIR(cst, POLYDRAW_HOST, opts.src ?? '');
}
