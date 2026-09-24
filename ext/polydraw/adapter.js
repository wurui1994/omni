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
 * **脚本写得动的那两格**。说明书里"消掉一次点击/一次按键"就是往它们上写：
 * `if (bstatus%2) { bstatus--; }`（`polydraw.txt:381`）、
 * `if (keystatus[0xc8]) { keystatus[0xc8] = 0; }`（`polydraw.txt:388`）。
 * 写落成 `(gfxcall "setbstatus" v)` / `(gfxcall "setkeystatus" k v)` —— 一格 op 不变。
 */
const HOST_WRITABLE = new Set(['bstatus', 'keystatus']);

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
  /* 纹理坐标与顶点属性那几格（**串只在 `glgetattribloc` 那一格**）。 */
  ['gltexcoord/2', []],
  ['gltexcoord/3', []],
  ['gltexcoord/4', []],
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
  const flush = () => {
    if (kind === null) return;
    out.push({ kind, name: name === null ? `$${anon++}` : name, text: buf.join('\n') });
    buf = [];
  };
  for (const line of String(src).split('\n')) {
    const t = line.trim();
    if (t.startsWith('@')) {
      const m = /^@([vgfh]?)(?::([A-Za-z0-9_$]+))?/.exec(t);
      if (m !== null) {
        flush();
        const k = m[1] === '' ? kind : ({ v: 'vert', g: 'geom', f: 'frag', h: 'host' })[m[1]];
        kind = k;
        name = m[2] === undefined ? null : m[2];
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
    /* `enum` 是**编译期常量**（`eval.txt`：数组长度可以用它）—— 就地换成那个数。 */
    if (C.enums.has(n)) return num(C.enums.get(n));
    /* 宿主的那批常量（PolyDraw 的 `GL_TRIANGLE_FAN` 之类：`myext[]` 里它们是
       "名字 -> 一格 double"）。值照 `GL/gl.h`，不是我们自己编的号。 */
    if (C.host.consts?.has(n)) return num(C.host.consts.get(n));
    /* **宿主给的那几格量**（`xres` / `yres` / `numframes`）：在宿主调用那条路上，
       读它们就是问设备一句 —— 每帧都可能不一样，所以不能折成常量。 */
    if (C.gfxHost && HOST_VARS.includes(n)) {
      C.needGfx = true;
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
    /* `^` 是幂、`%` 是 fmod（不是整数取模）。两格都可能**直接站在条件位置**
       （`if (bstatus % 2)` 就是说明书里"消一次点击"的写法）—— 所以也要按位置补 truthy。 */
    if (op === '^' || op === '%') {
      const v = op === '^'
        ? rmath('pow', [exprOf(a, C), exprOf(b, C)])
        : rmath('fmod', [exprOf(a, C), exprOf(b, C)]);
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
      if (ch.chain.length !== dims.length) {
        throw new Error(`eval->IR: \`${idOf(ch.base)}\` 是 ${dims.length} 维的数组，`
          + `这儿给了 ${ch.chain.length} 格下标（旧实现把多维摊成一块，所以维数要对齐）`);
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
      const as = raw.map((a, i) => {
        if (strAt.includes(i) && isList(a) && tag(a) === 'str') {
          return num(internStr(C, cUnescape(unquote(leaf(kids(a)[0])))));
        }
        return exprOf(a, C);
      });
      const glFn = C.host.glrt === true ? C.host.draw?.get(`${n}/${as.length}`) : undefined;
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
      if (ch.chain.length !== dims.length) {
        throw new Error(`eval->IR: \`${idOf(ch.base)}\` 是 ${dims.length} 维的数组，`
          + `这儿给了 ${ch.chain.length} 格下标`);
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
      + '（能写的只有 `bstatus` 与 `keystatus[k]` —— polydraw.txt:381/:388）');
  }
  C.needGfx = true;
  let v = val;
  if (op !== '=') {
    const read = ht.index === null ? gfxCallIR(ht.name) : gfxCallIR(ht.name, [ht.index]);
    const core = op.slice(0, 1);
    v = core === '%' ? rmath('fmod', [read, val]) : bin(core, read, val);
  }
  const args = ht.index === null ? [v] : [ht.index, v];
  return { kind: 'expr-stmt', expr: gfxCallIR(`set${ht.name}`, args) };
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
 * 这一版不接 —— 那要把那一段变成真循环，判据是"哪几句在环里"，另一笔账。
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
      /* 这标号没人跳（语料里有留着不用的）—— 丢掉就是。 */
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
  const out = [];
  for (const s of list) out.push(...stmtOf(s, C));
  return out;
}

/**
 * 一句语句 -> 若干句 IR。
 *
 * **护卫那一层在这儿加**（`C.gotoActive` 非空 = 正在降某个标号前头那一段）：每句外面
 * 套一层 `if (旗子 == 0)`，循环的条件上再 `&& 旗子 == 0`（见 `stmtsOf` 头上那段）。
 */
function stmtOf(s, C) {
  const res = stmtOf1(s, C);
  if (C.gotoActive.length === 0) return res;
  const g = C.gotoActive
    .map((f) => bin('==', nameRef(f), num(0)))
    .reduce((a, b) => bin('&&', a, b));
  return res.map((st) => {
    /* 循环：条件上加一格 —— 光在外头套 `if` 退不出来（旗子是循环体里置的）。 */
    if (st.kind === 'while') return { ...st, cond: bin('&&', st.cond, g) };
    if (st.kind === 'for') return { ...st, cond: st.cond === null ? g : bin('&&', st.cond, g) };
    return { kind: 'if', cond: g, then: [st], else_: [] };
  });
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
    if (!C.gotoActive.includes(flag)) {
      throw new Error(`eval->IR: \`goto ${name}\` 找不到往前跳的那个标号 ——`
        + ' 这一版只接"同一函数里、往前跳到某一格语句表上的标号"');
    }
    /* 置旗。后面每一句都在 `if (旗子 == 0)` 里头（见 `stmtOf`），所以控制流一路退到标号。
       注意这一句自己也被那层护卫裹着 —— 置旗只在"还没跳"的时候发生。 */
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
    const tgt = targetOf(kids(e)[1], C);
    const val = exprOf(kids(e)[2], C);
    if (op === '=') return [{ kind: 'assign', target: tgt, value: val }];
    /* `a %= b` 是 fmod，不是整数取模。 */
    const core = op.slice(0, 1);
    const v = core === '%' ? rmath('fmod', [tgt, val]) : bin(core, tgt, val);
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
    if (op === '%') return b === 0 ? null : a % b;
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
  const r = walk(x);
  if (r === null) return null;
  if (r.dims.length > 0 || r.ty !== null) {
    throw new Error(`eval->IR: \`${r.name}\` 这一处取到的是一整块（结构体或数组），`
      + '不是一个数 —— 这门语言里结构体不能整块赋值/传值');
  }
  const total = (C.arrs.get(r.name) ?? [1])[0];
  return { name: r.name, index: clampIdx(r.off, total) };
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

function rndDecls() {
  const st = nameRef('pd_rndst');
  const step = {
    kind: 'assign',
    target: st,
    value: bin('&', bin('+', bin('*', st, { kind: 'int', value: '214013' }),
      { kind: 'int', value: '2531011' }), { kind: 'int', value: '4294967295' }),
  };
  return [
    { kind: 'global', name: 'pd_rndst', type: INT },
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
          values: [bin('/', { kind: 'builtin', name: 'toreal', args: [bin('>>', st, { kind: 'int', value: '1' })] },
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
        {
          kind: 'return',
          values: [bin('*', nameRef('y'), rmath('sqrt', [bin('/', bin('*', num(-2),
            rmath('log', [nameRef('r')])), nameRef('r'))]))],
        },
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
 * 名单是**整份程序一张**（与 `C.arrs` 同一手的平名字空间）：同一个名字在别的函数里
 * 也会跟着装箱 —— 多开一格长度 1 的数组，语义不变。
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
  for (const k of kids(x)) collectBoxed(k, C, out, blocks);
  return out;
}

/** 这一份函数体里用到的（装箱的）名字 —— 用上头那格 `usedNames`（读也算）。 */

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
function bodyOf(blk, params, C) {
  const autos = autoDecls(blk).map((s) => autoShape(C, s));
  const autoNames = new Set(autos.map((a) => a.name));
  const written = writtenNames(blk);
  const lets = [];
  /* **装箱的局部量**（`&x` 传出去过的那些）：一格长度 1 的数组。形参与全局不算 ——
     形参拿到的就是调用方那一格，全局在模块级已经开好了。 */
  for (const n of usedNames(blk)) {
    if (!C.boxed.has(n) || autoNames.has(n)) continue;
    if (params.includes(n) || C.globals.has(n) || C.enums.has(n)) continue;
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
  for (const n of written) {
    if (autoNames.has(n) || C.boxed.has(n)) continue;
    if (params.includes(n) || C.globals.has(n) || C.enums.has(n)) continue;
    /* 宿主那一侧的量（host 模式下的 `bstatus` 那一族）不是局部：补一格 `let` 会生出个
       没人读的死变量，而写它已经落成 `(gfxcall "set…" …)` 了。 */
    if (C.gfxHost && (HOST_VARS.includes(n) || HOST_ARRS.includes(n))) continue;
    lets.push({ kind: 'let', name: n, type: REAL });
  }
  return [...lets, ...stmtsOf(kids(blk), C)];
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
    valParams: new Set(),               /* 当前函数**按值**收的形参（`&x` 碰上它要报） */
    gotoActive: [],                     /* 正在降哪几格标号前头那一段（`goto` 的旗子名） */
    needRnd: false,                     /* 用过 `RND`/`NRND`/`SRAND` 没有 */
    need3D: false,                      /* 用过 3D 那一族没有（`gfx3-rt.js`：投影在语言这一侧） */
    needNoise: false,                   /* 用过 `NOISE`/`NOISE3D` 没有（`noise-rt.js`） */
    usedGL: false,                      /* 这份脚本用过 GL 那一族没有（每帧初态要不要发） */
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
    for (const s of staticDecls(body)) {
      const prev = C.staticOwner.get(s.name);
      if (prev === undefined || prev === where) continue;
      let nn = `${isMain ? 'main' : where}__${s.name}`;
      while (C.staticOwner.has(nn) || C.globals.has(nn) || C.enums.has(nn)) nn = `${nn}_`;
      ren.set(s.name, nn);
      C.staticOwner.set(nn, where);
    }
    if (ren.size > 0) renameStatics(body, ren);
    for (const s of staticDecls(body)) {
      C.staticOwner.set(s.name, where);
      /* 带类型的那一档（`static cel_t cel[12][12]` 写在函数体里）。 */
      if (s.ty !== undefined) { declTyped(C, preDecls, s.ty, s.one, where); continue; }
      if (s.arr !== undefined) { declArr(C, preDecls, s.name, s.arr, where); continue; }
      if (!C.globals.has(s.name)) {
        C.globals.set(s.name, REAL);
        preDecls.push({ kind: 'global', name: s.name, type: REAL });
      }
      if (s.init !== undefined) C.staticInits.push({ name: s.name, init: s.init });
    }
  }

  /* **谁要装箱**（`&x`）—— 摆在这儿是因为它要先知道哪些名字**本来就成块**
     （文件级与函数里的数组/结构体都登记过了），那些不装箱，直接把那一块传过去。
     装箱的**全局**要从 `real` 改成一格长度 1 的 `(arr real)`：初值也跟着改成写 `x[0]`。 */
  C.boxedAll = collectBoxed(cst, C, new Set(), new Set(
    autoDecls(cst).filter((s) => s.ty !== undefined || s.arr !== undefined).map((s) => s.name),
  ));
  C.boxed = C.boxedAll;
  for (const d of preDecls) {
    if (d.kind === 'global' && C.boxedAll.has(d.name)) {
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
    C.boxed = new Set([...C.boxedAll].filter((nm) => !C.valParams.has(nm)));
    /* 这一份函数体里"收整块的形参"各自那格偏移（`名字$o`）—— 下标都要加上它。 */
    C.offs = new Map(ps.filter((p) => p.type === ARR).map((p) => [p.name, offName(p.name)]));
    decls.push({
      kind: 'fn',
      name,
      params: ps,
      ret: REAL,
      body: bodyOf(kids(x)[2], ps.map((p) => p.name), C),
    });
  }

  /* 主函数：EVAL 里它的形参是宿主传进来的（PolyDraw 不传，`()` 是常态）——
     有形参就在入口里当零值的局部量。 */
  const mainPs = paramInfos(kids(mainNode)[0], C).map((p) => p.name);
  C.valParams = new Set(mainPs);
  C.boxed = new Set([...C.boxedAll].filter((nm) => !C.valParams.has(nm)));
  /* 主函数的形参都是按值的 real —— 上一份函数留下的偏移表不许串到这儿。 */
  C.offs = new Map();
  const mainBody = [
    ...mainPs.map((p) => ({ kind: 'let', name: p, type: REAL })),
    ...bodyOf(kids(mainNode)[1], mainPs, C),
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

  if (C.needFact) decls.push(factDecl());
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
      for (const s of C.shaders) {
        /* **着色器原文在这儿（编译期）就翻成对齐后的主体**（`glsl.js`）——
           两档 GPU 设备收到的是同一份文本，各自只补 `#version` 那一行。
           在设备里各翻一遍就是两份实现（口径：`docs/design/eval-realtime-gpu.md` 13.2）。 */
        const text = s.kind === 'name' ? s.text : glslAlign(s.kind, s.text);
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
    decls.push(...gfxFnDecls(W, H), gfxPresentDecl('.omni-cache/gfx/frame.png'));
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
