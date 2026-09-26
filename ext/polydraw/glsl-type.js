/* ext/polydraw/glsl-type.js —— 给旧式 GLSL 补上那几个 `float(…)`
 *
 * **为什么要这一格**：脚本是按桌面 GLSL 1.20 写的，那一档 `int` 与 `float` 混着算时
 * 隐式转换（`f*f*npoints`，`npoints` 是 `uniform int` —— `ken/gspiral.pss:115`）。
 * GLSL ES 3.00（浏览器那一档）**不转**，当场报
 * `'*' : wrong operand types … 'highp float' … 'uniform mediump int'`。
 *
 * **为什么不许用文本替换糊**：把 `uniform int` 改成 `uniform float` 会把整数除法
 * （`i/j` 在 1.20 里就是整数除法）、位运算、数组下标的语义悄悄改掉，而且宿主那侧
 * `gluniform1i` 的上传口径也跟着错。所以这儿做的是**真的类型推导**：只在
 * "一边是浮点、另一边是整型"那一处补一个 `float(…)` —— 那正是 1.20 自己的规则，
 * 两边都是 `int` 的运算一个字都不动。
 *
 * 形状：词法 -> 带源码区间的表达式树（优先级爬升）-> 收一串"在这一段外面套 float()"
 * 的编辑 -> 从后往前贴回去。认不出类型就**什么都不做**（`?`）—— 这一层只做加法，
 * 不做猜测。
 */

/** 浮点那一族（含向量/矩阵）：与 `int` 混着算时，`int` 那边要套 `float()`。 */
const FLOATISH = new Set(['float', 'vec2', 'vec3', 'vec4',
  'mat2', 'mat3', 'mat4', 'mat2x2', 'mat3x3', 'mat4x4']);

/** 构造器 = 类型名（`vec3(…)` 的类型就是 `vec3`）。 */
const CTOR = new Set([...FLOATISH, 'int', 'uint', 'bool',
  'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4', 'bvec2', 'bvec3', 'bvec4']);

/** 声明里能打头的那些词（限定符 + 类型 + 精度）。 */
const QUAL = new Set(['uniform', 'varying', 'attribute', 'const', 'in', 'out', 'inout',
  'highp', 'mediump', 'lowp', 'flat', 'smooth', 'centroid', 'invariant']);
const TYPES = new Set([...CTOR, 'void',
  'sampler1D', 'sampler2D', 'sampler3D', 'samplerCube', 'sampler2DShadow']);

/** 回值就是第一个实参那个类型的内建（GLSL 的"泛型"那一族）。 */
const SAME = new Set(['abs', 'sign', 'floor', 'ceil', 'fract', 'mod', 'min', 'max',
  'clamp', 'mix', 'step', 'smoothstep', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'sinh', 'cosh', 'tanh', 'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt',
  'normalize', 'reflect', 'refract', 'faceforward', 'radians', 'degrees',
  'dFdx', 'dFdy', 'fwidth', 'trunc', 'round', 'roundEven']);
/** 回一格标量浮点的。 */
const RET_FLOAT = new Set(['length', 'dot', 'distance', 'determinant', 'noise1']);
/** 取样那一族（翻译之后一律叫 `texture*`）。 */
const RET_VEC4 = new Set(['texture', 'textureLod', 'textureProj', 'textureGrad',
  'textureProjLod', 'texelFetch', 'noise4']);

const isDigit = (c) => c >= '0' && c <= '9';
const isIdent0 = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdent = (c) => isIdent0(c) || isDigit(c);

/**
 * 词法：回一串 `{ k, v, i, j }`（k 是 'id' / 'num' / 'op'），注释与预处理行整行跳过。
 * 预处理行不进表（`#define` 里的东西按原文留着 —— 这一层不做宏展开）。
 */
function lex(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let bol = true;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { bol = true; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (bol && c === '#') { while (i < n && src[i] !== '\n') i += 1; continue; }
    bol = false;
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const s = i;
      let float = false;
      while (i < n && (isDigit(src[i]) || src[i] === '.')) { if (src[i] === '.') float = true; i += 1; }
      if (i < n && (src[i] === 'e' || src[i] === 'E')) {
        float = true;
        i += 1;
        if (src[i] === '+' || src[i] === '-') i += 1;
        while (i < n && isDigit(src[i])) i += 1;
      }
      if (i < n && (src[i] === 'f' || src[i] === 'F')) { float = true; i += 1; }
      if (i < n && (src[i] === 'u' || src[i] === 'U')) i += 1;
      out.push({ k: 'num', v: float ? 'float' : 'int', i: s, j: i });
      continue;
    }
    if (isIdent0(c)) {
      const s = i;
      while (i < n && isIdent(src[i])) i += 1;
      out.push({ k: 'id', v: src.slice(s, i), i: s, j: i });
      continue;
    }
    /* 运算符：先试三字符再两字符（`<<=` / `>>=` / `++` / `<=` …）。 */
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    const OPS3 = ['<<=', '>>='];
    const OPS2 = ['++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '^^',
      '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='];
    if (OPS3.includes(three)) { out.push({ k: 'op', v: three, i, j: i + 3 }); i += 3; continue; }
    if (OPS2.includes(two)) { out.push({ k: 'op', v: two, i, j: i + 2 }); i += 2; continue; }
    out.push({ k: 'op', v: c, i, j: i + 1 });
    i += 1;
  }
  return out;
}

/* ── 类型的小算术 ───────────────────────────────────────────────────────────── */

/** `vec3` -> 3；不是向量回 0。 */
const vecN = (t) => (/^(?:i|u|b)?vec([234])$/.exec(t) ? Number(/([234])$/.exec(t)[1]) : 0);
/** 向量的分量类型（`ivec3` -> `int`）。 */
const compOf = (t) => (t.startsWith('ivec') ? 'int'
  : (t.startsWith('uvec') ? 'uint' : (t.startsWith('bvec') ? 'bool' : 'float')));
/** 同一族里换个长度（`int` + 3 -> `ivec3`）。 */
const vecOf = (comp, n) => {
  if (n === 1) return comp;
  const p = comp === 'int' ? 'i' : (comp === 'uint' ? 'u' : (comp === 'bool' ? 'b' : ''));
  return `${p}vec${n}`;
};
/** 下标一次之后是什么（数组剥一层、向量取分量、矩阵取一列）。 */
function indexed(t) {
  if (t.endsWith('[]')) return t.slice(0, -2);
  const n = vecN(t);
  if (n !== 0) return compOf(t);
  const m = /^mat([234])(?:x([234]))?$/.exec(t);
  if (m !== null) return `vec${m[2] ?? m[1]}`;
  return '?';
}
/** `.xyz` / `.rg` 那一格。 */
function swizzled(t, name) {
  const n = vecN(t);
  if (n === 0 || !/^[xyzwrgbastpq]+$/.test(name) || name.length > 4) return '?';
  return vecOf(compOf(t), name.length);
}

/**
 * 混着算那一格的规矩（**就是 GLSL 1.20 自己的规矩**）：一边浮点、另一边整型时
 * 整型那边转成浮点。回 `'l'` / `'r'` 说该给哪一边套 `float(…)`，`null` = 不用动。
 */
function needCast(lt, rt) {
  const li = lt === 'int' || lt === 'uint';
  const ri = rt === 'int' || rt === 'uint';
  if (li && FLOATISH.has(rt)) return 'l';
  if (ri && FLOATISH.has(lt)) return 'r';
  return null;
}

/** 两边算完是什么类型（向量/矩阵那边赢；都是标量就看有没有浮点）。 */
function binType(lt, rt) {
  if (lt === '?' || rt === '?') return '?';
  if (vecN(lt) !== 0 || lt.startsWith('mat')) return lt;
  if (vecN(rt) !== 0 || rt.startsWith('mat')) return rt;
  if (lt === 'float' || rt === 'float') return 'float';
  return lt === rt ? lt : '?';
}

/* ── 表达式那一层（优先级爬升） ─────────────────────────────────────────────── */

/** 二元运算符的优先级（大的先结合）；只列这门语言里有的。 */
const PREC = new Map(Object.entries({
  '||': 1, '^^': 2, '&&': 3, '|': 4, '^': 5, '&': 6,
  '==': 7, '!=': 7, '<': 8, '>': 8, '<=': 8, '>=': 8,
  '<<': 9, '>>': 9, '+': 10, '-': 10, '*': 11, '/': 11, '%': 11,
}));
/** 混着算要转的只有这几个（位运算与逻辑运算两边本来就该同类，不碰）。 */
const MIX = new Set(['+', '-', '*', '/', '%', '<', '>', '<=', '>=', '==', '!=']);
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=']);

/**
 * 一份着色器 -> 补过 `float(…)` 的同一份文本。
 *
 * `pre` 是"外面注入的那几格"的类型（`a_pos` / `u_mvp` / `v_col0` …）——
 * 它们的声明是 `glslAlign` 随后贴在前头的，这一层看不到，所以由调用方给。
 */
export function glslFloatFix(src, pre = {}) {
  const toks = lex(src);
  if (toks.length === 0) return src;
  const edits = [];
  /* 作用域：一层一格 Map（`{` 进、`}` 出）。函数形参进函数体那一层。 */
  const scopes = [new Map(Object.entries(pre))];
  const fns = new Map();
  /** 刚吃过的那格形参表（下一个 `{` 收它）。 */
  let pending = null;
  let p = 0;
  const tk = (k = 0) => toks[p + k] ?? null;
  const vis = (k = 0) => (toks[p + k] ?? { v: '' }).v;
  const lookup = (name) => {
    for (let i = scopes.length - 1; i >= 0; i -= 1) {
      const t = scopes[i].get(name);
      if (t !== undefined) return t;
    }
    return '?';
  };
  const declare = (name, t) => { scopes[scopes.length - 1].set(name, t); };
  const wrap = (node) => {
    if (node === null || node.i === undefined) return;
    edits.push({ i: node.i, j: node.j });
  };

  /** 一格实参表：`(` 已经吃掉，吃到配对的 `)`；回每格实参的类型。 */
  const args = () => {
    const ts = [];
    if (vis() === ')') { p += 1; return ts; }
    for (;;) {
      const e = expr();
      ts.push(e === null ? '?' : e.t);
      if (vis() === ',') { p += 1; continue; }
      if (vis() === ')') { p += 1; break; }
      /* 认不出来就地收摊（这一层只做加法，宁可少补不许补错）。 */
      break;
    }
    return ts;
  };

  const primary = () => {
    const t0 = tk();
    if (t0 === null) return null;
    if (t0.v === '(') {
      const open = t0.i;
      p += 1;
      const e = expr();
      let close = e === null ? open + 1 : e.j;
      if (vis() === ')') { close = tk().j; p += 1; }
      return { t: e === null ? '?' : e.t, i: open, j: close };
    }
    if (t0.k === 'num') { p += 1; return { t: t0.v, i: t0.i, j: t0.j }; }
    if (t0.k === 'id') {
      if (t0.v === 'true' || t0.v === 'false') { p += 1; return { t: 'bool', i: t0.i, j: t0.j }; }
      p += 1;
      if (vis() === '(') {
        p += 1;
        const ts = args();
        const end = (toks[p - 1] ?? t0).j;
        const nm = t0.v;
        let t = '?';
        if (CTOR.has(nm)) t = nm;
        else if (SAME.has(nm)) t = ts[0] ?? '?';
        else if (RET_FLOAT.has(nm)) t = 'float';
        else if (RET_VEC4.has(nm)) t = 'vec4';
        else if (nm === 'cross') t = 'vec3';
        else t = fns.get(nm) ?? '?';
        return { t, i: t0.i, j: end };
      }
      return { t: lookup(t0.v), i: t0.i, j: t0.j };
    }
    return null;
  };

  /** 后缀：下标、`.xyz`、`++` / `--`。 */
  const postfix = () => {
    let e = primary();
    if (e === null) return null;
    for (;;) {
      const v = vis();
      if (v === '[') {
        p += 1;
        expr();
        let end = e.j;
        if (vis() === ']') { end = tk().j; p += 1; }
        e = { t: indexed(e.t), i: e.i, j: end };
        continue;
      }
      if (v === '.' && tk(1) !== null && tk(1).k === 'id') {
        const nm = tk(1).v;
        const end = tk(1).j;
        p += 2;
        e = { t: swizzled(e.t, nm), i: e.i, j: end };
        continue;
      }
      if (v === '++' || v === '--') { e = { t: e.t, i: e.i, j: tk().j }; p += 1; continue; }
      break;
    }
    return e;
  };

  const unary = () => {
    const v = vis();
    if (v === '-' || v === '+' || v === '!' || v === '~' || v === '++' || v === '--') {
      const s = tk().i;
      p += 1;
      const e = unary();
      if (e === null) return null;
      return { t: v === '!' ? 'bool' : e.t, i: s, j: e.j };
    }
    return postfix();
  };

  /** 优先级爬升；**混着算那一处就在这儿补** `float(…)`。 */
  const bin = (min) => {
    let l = unary();
    if (l === null) return null;
    for (;;) {
      const v = vis();
      const pr = PREC.get(v);
      if (pr === undefined || pr < min) break;
      p += 1;
      const r = bin(pr + 1);
      if (r === null) return l;
      if (MIX.has(v)) {
        const side = needCast(l.t, r.t);
        if (side === 'l') wrap(l);
        else if (side === 'r') wrap(r);
      }
      const t = MIX.has(v) && (v === '<' || v === '>' || v === '<=' || v === '>='
        || v === '==' || v === '!=') ? 'bool' : binType(l.t, r.t);
      l = { t, i: l.i, j: r.j };
    }
    return l;
  };

  /** 三目 + 赋值（右结合）。`float f = i;` 这一格 ES 3.00 也不肯，所以一并补。 */
  function expr() {
    const l = bin(1);
    if (l === null) return null;
    const v = vis();
    if (v === '?') {
      p += 1;
      const a = expr();
      if (vis() === ':') { p += 1; } else return { t: '?', i: l.i, j: l.j };
      const b = expr();
      const end = b === null ? (a === null ? l.j : a.j) : b.j;
      return { t: a === null ? '?' : a.t, i: l.i, j: end };
    }
    if (ASSIGN.has(v)) {
      p += 1;
      const r = expr();
      if (r === null) return l;
      if (needCast(l.t, r.t) === 'r') wrap(r);
      return { t: l.t, i: l.i, j: r.j };
    }
    return l;
  }

  /* ── 语句那一层：只为了**收集声明**与找到每格表达式的起点 ─────────────────── */

  /** 这儿是不是一句声明的开头（限定符/类型 接一个名字）？ */
  const declHere = () => {
    let k = 0;
    while (tk(k) !== null && tk(k).k === 'id' && QUAL.has(tk(k).v)) k += 1;
    const t = tk(k);
    if (t === null || t.k !== 'id') return -1;
    if (!TYPES.has(t.v)) return -1;
    const nx = tk(k + 1);
    if (nx === null || nx.k !== 'id') return -1;
    return k;
  };

  /** 吃一句声明（也可能是函数定义）。 */
  const decl = (k) => {
    const base = tk(k).v;
    p += k + 1;
    /* 函数定义/原型：`TYPE name ( … )`。 */
    if (tk(1) !== null && tk(1).v === '(') {
      fns.set(tk().v, base);
      p += 2;
      /* 形参进的是**函数体那一层**（下面那个 `{` 才压）—— 不然它们会漏成全局。 */
      const ps = new Map();
      for (;;) {
        if (tk() === null || vis() === ')') { p += 1; break; }
        let q = 0;
        while (tk(q) !== null && tk(q).k === 'id' && QUAL.has(tk(q).v)) q += 1;
        const ty = tk(q);
        const nm = tk(q + 1);
        if (ty !== null && nm !== null && ty.k === 'id' && nm.k === 'id') {
          ps.set(nm.v, TYPES.has(ty.v) ? ty.v : '?');
          p += q + 2;
        } else p += 1;
        if (vis() === ',') p += 1;
        else if (vis() === ')') { p += 1; break; }
      }
      pending = ps;
      return;
    }
    /* 变量：`TYPE a, b[3] = …, c;` */
    for (;;) {
      const nm = tk();
      if (nm === null || nm.k !== 'id') break;
      p += 1;
      let t = base;
      while (vis() === '[') {
        t = `${t}[]`;
        p += 1;
        expr();
        if (vis() === ']') p += 1;
      }
      declare(nm.v, t);
      if (vis() === '=') {
        p += 1;
        const e = expr();
        /* `float f = 3;` 这一格：给右边套 `float(…)`。 */
        if (e !== null && needCast(t, e.t) === 'r') wrap(e);
      }
      if (vis() === ',') { p += 1; continue; }
      break;
    }
    if (vis() === ';') p += 1;
  };

  /** 跟在 `if` / `while` / `for` 后头那一对括号：里头按 `;` `,` 分段各自成表达式。 */
  const head = () => {
    if (vis() !== '(') return;
    p += 1;
    let depth = 1;
    for (;;) {
      const t = tk();
      if (t === null) return;
      if (t.v === ')') { depth -= 1; p += 1; if (depth === 0) return; continue; }
      if (t.v === ';' || t.v === ',') { p += 1; continue; }
      const k = declHere();
      if (k >= 0) { decl(k); continue; }
      const before = p;
      expr();
      if (p === before) p += 1;
    }
  };

  const KW = new Set(['if', 'else', 'while', 'do', 'for', 'switch', 'case', 'default',
    'break', 'continue', 'discard', 'return', 'struct', 'precision', 'layout']);

  while (p < toks.length) {
    const t = tk();
    if (t.v === '{') {
      scopes.push(pending ?? new Map());
      pending = null;
      p += 1;
      continue;
    }
    if (t.v === '}') { if (scopes.length > 1) scopes.pop(); p += 1; continue; }
    if (t.v === ';' || t.v === ',' || t.v === ':') { p += 1; continue; }
    const k = declHere();
    if (k >= 0) { decl(k); continue; }
    if (t.k === 'id' && KW.has(t.v)) {
      p += 1;
      if (t.v === 'if' || t.v === 'while' || t.v === 'for' || t.v === 'switch') head();
      else if (t.v === 'precision' || t.v === 'struct' || t.v === 'layout') {
        while (tk() !== null && vis() !== ';' && vis() !== '{') p += 1;
      }
      continue;
    }
    const before = p;
    expr();
    if (p === before) p += 1;
  }

  if (edits.length === 0) return src;
  /* 从后往前贴，前面的区间就不会被挪动。重叠的只留外面那一层（内层已经被它盖住）。 */
  edits.sort((a, b) => (a.i - b.i) || (b.j - a.j));
  const keep = [];
  let lastJ = -1;
  for (const e of edits) {
    if (e.i < lastJ) continue;
    keep.push(e);
    lastJ = e.j;
  }
  let out = src;
  for (let i = keep.length - 1; i >= 0; i -= 1) {
    const e = keep[i];
    out = `${out.slice(0, e.i)}float(${out.slice(e.i, e.j)})${out.slice(e.j)}`;
  }
  return out;
}






