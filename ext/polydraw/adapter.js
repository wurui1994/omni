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
  return m === undefined || m === null || m === '' ? 'ir' : String(m);
}

/**
 * **宿主给的那几格量**（两门语言同一份：`myext[]` 里 `XRES`/`YRES`/`NUMFRAMES`/`MOUSX`/
 * `MOUSY`/`BSTATUS` 是"名字 -> 一格 double"）。在宿主调用那条路上，读它们就是问设备一句。
 *
 * `KEYSTATUS[256]` 在那张表里是**一块 256 格的 double**（`polydraw.c:2222`），
 * 所以它在这儿是 `HOST_ARRS`：`keystatus[k]` 落成 `(gfxcall "keystatus" k)`。
 */
const HOST_VARS = ['xres', 'yres', 'numframes', 'mousx', 'mousy', 'bstatus'];
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
    const v = nameRef(n);
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
      const v = { kind: 'index', obj: nameRef(fr.name), index: fr.index };
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
        args: [nameRef(idOf(ch.base)), arrIndex(ch.chain, dims, C)],
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
    /* `&x` 只在实参位置出现（配 `&a` 形参）。这一版把它当普通的读 —— 真的"改得到调用方"
       要一格指针，记在头注的边界里。 */
    return exprOf(kids(x)[0], C);
  }
  if (t === 'postinc' || t === 'postdec' || t === 'preinc' || t === 'predec') {
    throw new Error(`eval->IR: \`${t}\` 只在语句位置接了（EVAL 一句只许一个赋值）`);
  }
  throw new Error(`eval->IR: 这一格表达式还没接：${t}`
    + `（形状：${JSON.stringify(x).slice(0, 160)}）`);
}

/* ─── 调用 ───────────────────────────────────────────────────────────── */

function callOf(x, C) {
  const head = kids(x)[0];
  if (tag(head) !== 'name') throw new Error('eval->IR: 调用的不是一个名字（函数指针还没接）');
  const n = idOf(head);
  /* **可编程管线那一族**先看：它的实参里可能有**串**（着色器名 / uniform 名），
     而 `exprOf` 把串落成 `{kind:'string'}` —— 那格进不了宿主面（只收 double）。
     所以这儿把串内部到名字表里换成下标（表在入口里登记，见 `gfxDefIR`）。 */
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
      return gfxCallIR(n, as);
    }
  }
  /* **宿主调用的串实参一律换成名字表下标**（`glsettex(0,"earth.jpg")` 那一族）：
     宿主面只收 double，所以串在入口里内部到名字表、这儿发它的下标（与 `SHADER_FNS`
     那一段同一手 —— 那一段是"哪几格实参是串"的白名单，这一格是兜底的一般规矩）。
     只在宿主调用那条路上这么做：普通函数的串实参照旧原样递下去。 */
  const rawArgs = kids(x).slice(1);
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

  if (C.fns.has(n)) return { kind: 'call', fn: nameRef(n), args };

  /* **画图那一族**：这一门的宿主表里有的，落成生成出来的设备函数（`gfx-rt.js`）。
     设备就是一块帧缓冲 —— 清单/像素都在进程里，跨出去的只有一帧表面。 */
  const drawFn = C.host.draw?.get(`${n}/${args.length}`);
  if (drawFn !== undefined) {
    C.needGfx = true;
    /* GL 那一族（固定管线 + 着色器）用过没有 —— 每帧的 GL 初态只给用过的脚本发。 */
    if (drawFn.startsWith('gl_')) C.usedGL = true;
    /* **宿主调用那条路**：一格 `(gfxcall "名字" 实参…)`，设备在宿主那一侧。
       名字与元数原样交过去 —— 设备按 `名字/个数` 分派（与这张表同一条口径）。 */
    if (C.gfxHost) return gfxCallIR(n, args);
    /* GL 立即模式那一摊（`gl-rt.js`）只在真用到时才带上 —— 它比 2D 那一摊大得多。 */
    if (C.host.glrt === true && drawFn.startsWith('gl_')) C.needGL = true;
    return { kind: 'call', fn: nameRef(drawFn), args };
  }
  /* 宿主那边的 `KLOCK()` / `KLOCK(档)` —— 同一条路，也是问设备一句
     （`tigrou/clock.pss:10` 用的是一参那档：`klock(1)`）。 */
  if (C.gfxHost && HOST_FNS0.includes(n) && args.length <= 1) {
    C.needGfx = true;
    return gfxCallIR(n, args);
  }

  /* 画图那一族：**按这一门的宿主表判**（`C.host`）。两门语言共用这一份 adapter，
     差别只在这张表 —— PolyDraw 是 GL 立即模式（`polydraw.c:2070` 的 myext[]）、
     EvalDraw 是 `cls/setcol/setpix/moveto/lineto/drawsph/drawcone/…`（`evaldraw_ref.md`）。 */
  if (C.host.gfx.some((p) => n === p || n.startsWith(p))) {
    /* **录制那一档不拦名字**（`--gfx null`）：设备认所有名字（记一笔、回 0），
       所以这儿把它原样落成 `(gfxcall …)` —— 于是一份脚本能一路跑到底，
       账上那串名字就是"它到底要哪几格 API"。撞上第一个没接的名字就报那种查法，
       一份脚本要查十几遍才知道还缺什么（语料上量过：那是最费时间的一段）。
       **只在这一档**：默认那两档仍然当场报，不许静默回 0 把图画错。 */
    if (C.recGfx) return gfxCallIR(n, args);
    throw new Error(`${C.host.who}->IR: \`${n}\` 这一格宿主函数这条腿上没有落点`
      + '（固定管线那一档已经接了：glClear/glBegin/glEnd/glVertex/glColor/矩阵栈/gluPerspective；'
      + `**着色器与纹理那两族没有** —— 这条腿上没有可编程管线。口径是 ${C.host.spec}）`);
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
  if (tag(x) === 'name') return nameRef(idOf(x));
  if (tag(x) === 'index' || tag(x) === 'field') {
    /* 结构体那条路先看（`vt[i].stuck = 1`）—— 与读那一侧同一格 `fieldRef`。 */
    const fr = fieldRef(x, C);
    if (fr !== null) return { kind: 'index', obj: nameRef(fr.name), index: fr.index };
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
        index: arrIndex(ch.chain, dims, C),
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

function stmtsOf(list, C) {
  const out = [];
  for (const s of list) out.push(...stmtOf(s, C));
  return out;
}

function stmtOf(s, C) {
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
       **主函数反过来**：它是"每帧一次"那格函数（回 void），`return 0;` 里那个值没人要 ——
       把它当一句表达式做掉再空返回（3 份脚本写了 `return 0;`）。 */
    if (C.inMain) {
      const pre = k.length === 0 ? [] : exprStmtOf(k[0], C);
      return [...pre, { kind: 'return', values: [] }];
    }
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
    /* `do{…}while(c);` 摊成"先跑一趟、再 while" —— 标准 IR 里没有 do-while 那一格。
       **不是等价重写那么简单的地方**：body 里的 `continue` 在真 do-while 里跳到条件判断，
       摊开之后第一趟那一份里的 `continue` 会跳出。语料里没有那种写法，先这么落，记在这儿。 */
    const k = kids(s);
    const body = stmtsOf([k[0]], C);
    return [...body, { kind: 'while', cond: exprOf(k[1], C, 'cond'), body }];
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
  if (t === 'static' || t === 'enum' || t === 'sty' || t === 'struct') return [];
  if (t === 'label' || t === 'goto') {
    throw new Error('eval->IR: `goto` / `label:` 还没接（标准 IR 里没有无条件跳转）');
  }
  throw new Error(`eval->IR: 这一格语句还没接：${t}`);
}

/** for 头里那一格既可能是表达式、也可能是 `i++` —— 两种都走 `exprStmtOf`。 */

/** 一条"表达式语句"：赋值、自增、调用（含 `printf`）。 */
function exprStmtOf(e, C) {
  const t = tag(e);
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
    if (tag(head) === 'name' && idOf(head) === 'printf') return printfOf(e, C);
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

function staticDecls(x, out = []) {
  if (!isList(x)) return out;
  /* **带类型的 static**（`static cel_t cel[12][12];`）—— 一格 `{ ty, one }`，
     由 `declTyped` 落（长度 = 各维之积 × 类型的槽数）。 */
  if (tag(x) === 'sty') {
    const ks = kids(x);
    const ty = idOf(ks[0]);
    for (const one of ks.slice(1)) out.push({ name: idOf(kids(one)[0]), ty, one });
    return out;
  }
  if (tag(x) === 'static') {
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
  for (const k of kids(x)) staticDecls(k, out);
  return out;
}


/**
 * 一格函数体：顶上补 `let`（这门语言没有声明），再是语句。
 *
 * **形参与全局不补** —— 形参已经在签名里，全局（`static` / `enum`）是模块级那一格。
 */
function bodyOf(blk, params, C) {
  const written = writtenNames(blk);
  const lets = [];
  for (const n of written) {
    if (params.includes(n) || C.globals.has(n) || C.enums.has(n)) continue;
    /* 宿主那一侧的量（host 模式下的 `bstatus` 那一族）不是局部：补一格 `let` 会生出个
       没人读的死变量，而写它已经落成 `(gfxcall "set…" …)` 了。 */
    if (C.gfxHost && (HOST_VARS.includes(n) || HOST_ARRS.includes(n))) continue;
    lets.push({ kind: 'let', name: n, type: REAL });
  }
  return [...lets, ...stmtsOf(kids(blk), C)];
}

/* ─── 顶层 ───────────────────────────────────────────────────────────── */

/**
 * `.pss` 的树 → 标准 IR。
 *
 * 形状：`(program <文件级的 static/enum>… (main (params …) (block …)) (fn 名 (params …) (block …))…)`
 */
export function evalToIR(cst, host, src = '') {
  const C = {
    host,
    /* 画图走宿主调用（`(gfxcall …)`）还是生成出来的 CPU 光栅器 —— 见 `gfxMode()` 的头注。
       `null` 是**录制那一档**（设备只记账不画，量语言这一半与量覆盖用它）—— 它也是宿主调用。 */
    gfxHost: ['host', 'gl', 'auto', 'null'].includes(gfxMode()),
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
    needRnd: false,                     /* 用过 `RND`/`NRND`/`SRAND` 没有 */
    usedGL: false,                      /* 这份脚本用过 GL 那一族没有（每帧初态要不要发） */
    needFact: false,
    inMain: false,                      /* 正在降主函数体没有（`return` 那一格看它） */
    fresh: (() => { let i = 0; return (p) => `${p}_pd${i++}`; })(),
    tyCtx: () => ({
      /* 全是 double：`env.get` 一律回 real，`fns` 给格式串那台机器看返回类型。
         **例外是 `static` 数组**（`(arr real)`）—— 不回 arr 的话 `aget` 会被当 int，
         于是格式串那台机器在已经是 real 的东西上再发一格 `(toreal …)`，方言当场报。 */
      env: { get: (n) => (C.arrs.has(n) ? ARR : REAL) },
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
  const preDecls = [];
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
      const ps = kids(kids(x)[1]).map((p) => idOf(kids(p)[0]));
      C.fns.set(name, { params: ps.map(() => REAL), ret: REAL });
    }
  }

  /* **函数体里的 `static` 也是模块级的量**：EVAL 与 C 的 static 局部量同义 ——
     跨调用留值、初值只做一次。这门语言"宿主每帧调一次脚本"的执行模型全靠它
     （`ken/*.pss` 里相机位置与速度都是主函数里的 `static`）。
     名字落在同一个平名字空间里，所以**两处同名 static 当场报**，不悄悄共用一格。 */
  for (const x of top) {
    const isMain = tag(x) === 'main';
    if (!isMain && tag(x) !== 'fn') continue;
    const where = isMain ? '主函数' : idOf(kids(x)[0]);
    for (const s of staticDecls(isMain ? kids(x)[1] : kids(x)[2])) {
      const prev = C.staticOwner.get(s.name);
      if (prev !== undefined && prev !== where) {
        throw new Error(`eval->IR: 两处 \`static ${s.name}\`（${prev} 与 ${where}）——`
          + ' 这一版把 static 落在同一个平名字空间里，重名会共用一格，所以当场报'
          + '（要接就按函数名加前缀）');
      }
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

  const decls = [...preDecls];
  for (const x of top) {
    if (tag(x) !== 'fn') continue;
    const name = idOf(kids(x)[0]);
    const ps = kids(kids(x)[1]).map((p) => idOf(kids(p)[0]));
    decls.push({
      kind: 'fn',
      name,
      params: ps.map((p) => ({ name: p, type: REAL })),
      ret: REAL,
      body: bodyOf(kids(x)[2], ps, C),
    });
  }

  /* 主函数：EVAL 里它的形参是宿主传进来的（PolyDraw 不传，`()` 是常态）——
     有形参就在入口里当零值的局部量。 */
  const mainPs = kids(kids(mainNode)[0]).map((p) => idOf(kids(p)[0]));
  /* 主函数体里的 `return` 是"这一帧到此为止"（那格函数回 void）—— 见 `return` 那一段。 */
  C.inMain = true;
  const mainBody = [
    ...mainPs.map((p) => ({ kind: 'let', name: p, type: REAL })),
    ...bodyOf(kids(mainNode)[1], mainPs, C),
  ];
  C.inMain = false;
  /**
   * **每帧的 GL 初态**：PolyDraw 的宿主在调脚本之前会把 GL 摆回去
   * （`polydraw.c:3572-3579`：清 color/depth/stencil、开深度测试、
   * PROJECTION = `gluPerspective(gfov, 宽/高, 0.1, 1000)`、MODELVIEW = 单位）。
   * 所以**用了 GL 那一族的脚本**每帧开头发一格 `framebegin` —— 两档设备各自照那几行做。
   *
   * 只给用过 GL 的脚本发（`C.usedGL`）：纯算术的 `.pss`（`01-arith.pss`）不该因此把
   * 整摊 GL 运行时带进来。EvalDraw 那张表没有这一格 —— 它是 2D，"要不要清"是
   * 脚本自己用 `cls()` 说的。
   */
  if (C.host.frameReset === true && C.usedGL) {
    mainBody.unshift({ kind: 'expr-stmt', expr: C.gfxHost
      ? gfxCallIR('framebegin')
      : { kind: 'call', fn: nameRef('gl_framebegin'), args: [] } });
  }

  if (C.needFact) decls.push(factDecl());
  /* `RND`/`NRND`/`SRAND` 那一摊（生成出来的 LCG + Box-Muller，三条腿逐字节相同）。 */
  if (C.needRnd) decls.push(...rndDecls());
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
    ...C.staticInits.map((s) => ({
      kind: 'assign', target: nameRef(s.name), value: exprOf(s.init, C),
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
      decls.push({
        kind: 'fn', name: 'eval$frame', params: [], ret: REAL, body: mainBody,
      });
      /* **登记那几格串**（一趟只做一次，摆在入口最前头）：`@v`/`@f` 区段的原文，
         以及内部到的名字（着色器名 / uniform 名）—— 运行期的调用照旧全是 double。 */
      const regs = [];
      for (const s of C.shaders) {
        regs.push({ kind: 'expr-stmt', expr: gfxDefIR(s.kind, s.name, s.text) });
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
    if (C.needGL) {
      decls.unshift(...glGlobalDecls());
      decls.push(...glFnDecls());
    }
    mainBody.push({
      kind: 'expr-stmt',
      expr: { kind: 'call', fn: nameRef('gfx_present'), args: [] },
    });
  }
  decls.push({ kind: 'main', body: [...initStmts, ...mainBody] });
  return { kind: 'module', decls };
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
