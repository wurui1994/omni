/**
 * GLSL 子集的**类型检查与名字解析** —— ADR-0019 第一刀第二片。
 *
 * 语法那一半是数据（`glsl.grammar`，0 处冲突）。这一份做语法**办不到**的那一半，
 * 每一条都要先知道类型：
 *
 *   - swizzle 那串字母合不合法（`vec2` 没有 `.z`；`c.xxx` 是三个都取 x，合法）
 *   - 构造的元数（`vec3(a,b)` 少一格；`vec3(0.02)` 是标量铺开，合法）
 *   - 混算的提升（向量 op 标量、`int` 隐式变 `float`）
 *   - 内建函数的重载（`min(vec3, float)` 合法，`min(vec3, vec2)` 不合法）
 *   - `gl_FragCoord` 只在片元里有、`gl_VertexID`/`gl_Position` 只在顶点里有
 *
 * 出来的是一棵**带类型的树**（下面 `Expr`/`Stmt` 那两组形状），不是在原树上挂属性。
 * 理由：降级那一侧要的是「每个节点的类型已经定了」，而原树上 `(add a b)` 的类型取决于
 * 两个子节点 —— 让降级再算一遍就是把同一套规则写两遍，而两遍必然会分叉。
 *
 * ## 模块级名字都带 `glsl` 前缀
 *
 * 自举那一版把所有模块摊进同一个作用域，模块级的名字必须全局唯一（`ty`/`check` 这种
 * 名字在别处一定撞）。所以这一份里凡是导出的、模块级的，一律 `glsl*` / `GLSL_*`。
 *
 * ## 这一片**不做**的
 *
 * 降级（那是第三片）、常量折叠、死代码、`discard`（认得，但明着拒 —— 见 `glslStmt`）。
 */

import { OmniError } from '../source/diag.js';

/* ------------------------------------------------------------------ 类型 */

/**
 * 类型的形状：
 *
 *   `{k:'void'}` `{k:'bool'}` `{k:'int'}` `{k:'float'}`
 *   `{k:'vec', n:2|3|4, base:'float'|'int'|'bool'}`
 *   `{k:'mat', cols:2|3|4, rows:2|3|4}`（只有 float 矩阵 —— GLSL 里没有整数矩阵）
 *
 * 矩阵记的是**列数与行数**，不是一个 `n`：`mat2x3` 是 2 列 3 行（规范 5.6），
 * 而 `mat2` 就是 `mat2x2`。摊平的次序始终是**列优先**，第 c 列占
 * `c*rows .. c*rows+rows-1`。
 */
export const GLSL_VOID = { k: 'void' };
export const GLSL_BOOL = { k: 'bool' };
export const GLSL_INT = { k: 'int' };
export const GLSL_FLOAT = { k: 'float' };

const glslVec = (n, base) => ({ k: 'vec', n, base });
const glslMat = (cols, rows) => ({ k: 'mat', cols, rows });

/** 打印出来给报错用。 */
export function glslTyText(t) {
  if (t.k === 'vec') {
    const p = t.base === 'float' ? 'vec' : t.base === 'int' ? 'ivec' : 'bvec';
    return `${p}${t.n}`;
  }
  if (t.k === 'mat') return t.cols === t.rows ? `mat${t.cols}` : `mat${t.cols}x${t.rows}`;
  return t.k;
}

const glslSame = (a, b) => glslTyText(a) === glslTyText(b);

/** 标量吗（`float`/`int`/`bool`）。 */
const glslIsScalar = (t) => t.k === 'float' || t.k === 'int' || t.k === 'bool';

/** 整数那一族：`int` 与 `ivecN`。位运算与移位只认它们（规范 5.9）。 */
const glslIsIntish = (t) => t.k === 'int' || (t.k === 'vec' && t.base === 'int');


/** 这个类型的**元素**类型：`vec3` -> `float`、`ivec2` -> `int`、标量 -> 自己。 */
function glslElem(t) {
  if (t.k === 'vec') return t.base === 'float' ? GLSL_FLOAT : t.base === 'int' ? GLSL_INT : GLSL_BOOL;
  if (t.k === 'mat') return GLSL_FLOAT;
  return t;
}

/** 有几格：标量 1、`vecN` N、`matCxR` C*R。 */
function glslCount(t) {
  if (t.k === 'vec') return t.n;
  if (t.k === 'mat') return t.cols * t.rows;
  return 1;
}

/** 语法树里的 `(ty-vec 3)` 一类 -> 上面那种形状。 */
function glslTyOf(node, err) {
  const h = glslHead(node);
  if (h === 'ty-void') return GLSL_VOID;
  if (h === 'ty-bool') return GLSL_BOOL;
  if (h === 'ty-int') return GLSL_INT;
  if (h === 'ty-uint') throw err(node, 'uint 这一刀不收（两份尺子里都没有）');
  if (h === 'ty-float') return GLSL_FLOAT;
  const n = Number(node.items[1].value);
  if (h === 'ty-vec') return glslVec(n, 'float');
  if (h === 'ty-ivec') return glslVec(n, 'int');
  if (h === 'ty-bvec') return glslVec(n, 'bool');
  /* `(ty-mat C R)`：C 列 R 行。`mat3` 在语法那侧就摊成了 `(ty-mat 3 3)`。 */
  if (h === 'ty-mat') return glslMat(n, Number(node.items[2].value));
  throw err(node, `认不出的类型 ${h}`);
}

/* ------------------------------------------------------------ 树的小工具 */

const glslHead = (n) => (n !== null && n !== undefined && n.kind === 'list'
  && n.items.length > 0 && n.items[0].kind === 'atom' ? n.items[0].value : null);

/** `(unit-add (unit-add (unit) a) b)` 这种左递归的链摊平成 `[a, b]`。 */
function glslFlatten(node, addHead, emptyHead) {
  const out = [];
  let cur = node;
  while (glslHead(cur) === addHead) {
    out.push(cur.items[2]);
    cur = cur.items[1];
  }
  if (glslHead(cur) !== emptyHead) {
    throw new OmniError(`glsl: ${addHead} 的链底该是 ${emptyHead}，是 ${glslHead(cur)}`);
  }
  out.reverse();
  return out;
}

const glslAtom = (n) => (n.kind === 'atom' || n.kind === 'string' ? n.value : null);

/* -------------------------------------------------------------- 内建函数 */

/**
 * 内建函数表。`kind` 说的是**形状**，不是一条条重载：
 *
 *   `gen1`  一个泛型参数（`float`/`vecN` 都行），回同一个类型：`sin`/`abs`/`floor`…
 *   `gen2`  两个参数，第二个可以是标量（`min(vec3, float)` 合法）：`min`/`max`/`pow`/`mod`/`step`
 *   `gen3`  三个参数，后两个（或后一个）可以是标量：`clamp`/`mix`/`smoothstep`
 *   `len`   一个泛型参数，回 `float`：`length`
 *   `dot2`  两个同型泛型参数，回 `float`：`dot`/`distance`
 *   `cross` 两个 `vec3`，回 `vec3`
 *
 * 「第二个可以是标量」这条不是我编的：GLSL 规范 8.3 里 `min`/`max`/`clamp`/`mix`/`smoothstep`
 * 都各有一组「后面几个是 float」的重载，而 `sin(x, y)` 那种不存在。
 *
 * `pow` 是从 `pretty.frag` 里量出来的（`col = pow(col, vec3(0.85))`）—— ADR 里第一版
 * 那份内建清单漏了它。
 */
const GLSL_BUILTINS = new Map([
  ['sin', 'gen1'], ['cos', 'gen1'], ['tan', 'gen1'],
  ['asin', 'gen1'], ['acos', 'gen1'], ['atan', 'gen2'],
  ['exp', 'gen1'], ['log', 'gen1'], ['exp2', 'gen1'], ['log2', 'gen1'],
  ['sqrt', 'gen1'], ['inversesqrt', 'gen1'],
  ['abs', 'gen1'], ['sign', 'gen1'], ['floor', 'gen1'], ['ceil', 'gen1'],
  ['fract', 'gen1'], ['normalize', 'gen1'], ['radians', 'gen1'], ['degrees', 'gen1'],
  ['pow', 'gen2'], ['mod', 'gen2'], ['min', 'gen2'], ['max', 'gen2'], ['step', 'gen2'],
  ['clamp', 'gen3'], ['mix', 'gen3'], ['smoothstep', 'gen3'],
  ['length', 'len'],
  ['dot', 'dot2'], ['distance', 'dot2'],
  ['cross', 'cross'],
]);

/** `atan` 与 `step` 的第一个参数也可以是标量而第二个是向量吗 —— GLSL 里可以，这儿也收。 */
function glslGenType(name, tys, node, err) {
  const kind = GLSL_BUILTINS.get(name);
  const want = kind === 'gen1' || kind === 'len' ? 1 : kind === 'gen3' ? 3 : 2;
  if (tys.length !== want) {
    throw err(node, `${name} 要 ${want} 个实参，给了 ${tys.length}`);
  }
  /* 泛型那一格：参数里最宽的那个（标量算最窄）。所有非标量的必须同型。 */
  let wide = null;
  for (const t of tys) {
    if (t.k === 'float' || t.k === 'int') continue;
    if (t.k !== 'vec' || t.base !== 'float') {
      throw err(node, `${name} 的实参只能是 float 或 vecN，给了 ${glslTyText(t)}`);
    }
    if (wide === null) wide = t;
    else if (wide.n !== t.n) {
      throw err(node, `${name} 的几个向量实参宽度不一样（${glslTyText(wide)} 与 ${glslTyText(t)}）`);
    }
  }
  const gen = wide === null ? GLSL_FLOAT : wide;
  if (kind === 'len' || kind === 'dot2') {
    if (kind === 'dot2' && !glslSame(tys[0], tys[1])) {
      /* `dot` 的两个参数必须**同型** —— 标量与向量混不了。 */
      if (!(glslIsScalar(tys[0]) && glslIsScalar(tys[1]))) {
        throw err(node, `${name} 的两个实参要同型（${glslTyText(tys[0])} 与 ${glslTyText(tys[1])}）`);
      }
    }
    return GLSL_FLOAT;
  }
  if (kind === 'cross') {
    for (const t of tys) {
      if (!(t.k === 'vec' && t.n === 3 && t.base === 'float')) {
        throw err(node, `cross 的实参要是 vec3，给了 ${glslTyText(t)}`);
      }
    }
    return glslVec(3, 'float');
  }
  /* `gen1` 的那一个参数是标量时回标量；`gen2`/`gen3` 的第一个参数定形状。 */
  if (kind === 'gen1') return gen;
  const first = tys[0];
  if (first.k === 'vec') return first;
  return gen;
}

/**
 * 向量比较那一族（规范 8.6）与 `bvecN` 上的归约。它们与上面那张泛型表分开写，
 * 因为**结果类型换了一族**：比较出 `bvecN`、`all`/`any` 出 `bool`。
 *
 *   `lessThan(vecN, vecN)` -> `bvecN`（`ivecN` 也行；`equal`/`notEqual` 还收 `bvecN`）
 *   `all(bvecN)` / `any(bvecN)` -> `bool`
 *   `not(bvecN)` -> `bvecN`
 *
 * **为什么这一族现在做得了**：GLSL 这一层的向量是**摊成分量**的，一格一个方言标量，
 * 所以「逐格比较出一串 bool」不需要方言有掩码类型。方言的掩码（ADR-0019 待办 18）
 * 要的是 LLVM 腿上的原生 `<N x i1>`，那是**性能**，不是这一族的前提。
 */
const GLSL_VEC_CMP = new Map([
  ['lessThan', '<'], ['lessThanEqual', '<='],
  ['greaterThan', '>'], ['greaterThanEqual', '>='],
  ['equal', '=='], ['notEqual', '!='],
]);

const GLSL_VEC_RED = new Set(['all', 'any']);

/** 这一族的类型规则。回 `null` 表示「这个名字不属于这一族」。 */
function glslVecCmpType(name, tys, node, err) {
  const op = GLSL_VEC_CMP.get(name);
  if (op !== undefined) {
    if (tys.length !== 2) throw err(node, `${name} 要 2 个实参，给了 ${tys.length}`);
    const [a, b] = tys;
    if (a.k !== 'vec' || b.k !== 'vec' || a.n !== b.n || a.base !== b.base) {
      throw err(node, `${name} 的两个实参要是同型的向量（${glslTyText(a)} 与 ${glslTyText(b)}）`);
    }
    /* `<` 那四条只对数字向量；`equal`/`notEqual` 连 `bvecN` 一起收（规范 8.6）。 */
    if (a.base === 'bool' && op !== '==' && op !== '!=') {
      throw err(node, `${name} 不能作用在 bvec 上（只有 equal/notEqual 可以）`);
    }
    return glslVec(a.n, 'bool');
  }
  if (GLSL_VEC_RED.has(name)) {
    if (tys.length !== 1) throw err(node, `${name} 要 1 个实参，给了 ${tys.length}`);
    if (!(tys[0].k === 'vec' && tys[0].base === 'bool')) {
      throw err(node, `${name} 的实参要是 bvecN，给了 ${glslTyText(tys[0])}`);
    }
    return GLSL_BOOL;
  }
  if (name === 'not') {
    if (tys.length !== 1) throw err(node, `not 要 1 个实参，给了 ${tys.length}`);
    if (!(tys[0].k === 'vec' && tys[0].base === 'bool')) {
      throw err(node, `not 的实参要是 bvecN，给了 ${glslTyText(tys[0])}`
        + '（标量的逻辑非写 `!x`）');
    }
    return tys[0];
  }
  return null;
}

/* ---------------------------------------------------------- 内建变量 */

/**
 * 每一档着色器**自己**的内建变量。分档不是讲究：`gl_FragCoord` 在顶点里根本不存在，
 * 混着收下来的话「顶点里读 gl_FragCoord」这种错要到运行期才现形（而那时候只是数不对）。
 */
const GLSL_VERT_IN = new Map([['gl_VertexID', GLSL_INT]]);
const GLSL_VERT_OUT = new Map([['gl_Position', glslVec(4, 'float')]]);
const GLSL_FRAG_IN = new Map([['gl_FragCoord', glslVec(4, 'float')]]);
const GLSL_FRAG_OUT = new Map([['gl_FragDepth', GLSL_FLOAT]]);

/* ------------------------------------------------------------ 检查器 */

const GLSL_SWIZZLE_SETS = ['xyzw', 'rgba', 'stpq'];

/** 赋值那一族：语法头 -> 二元算符（`assign` 自己是纯赋值，值是 `=`）。 */
const GLSL_ASSIGN_OPS = {
  assign: '=',
  'add-assign': '+', 'sub-assign': '-', 'mul-assign': '*', 'div-assign': '/',
  'mod-assign': '%', 'band-assign': '&', 'bor-assign': '|', 'bxor-assign': '^',
  'shl-assign': '<<', 'shr-assign': '>>',
};


class GlslChecker {
  /**
   * @param stage `'vert'` 或 `'frag'` —— **由调用方给**，不猜。
   *   猜是能猜的（看有没有 `gl_Position`），但猜错的那一次会把「顶点里写了 gl_FragCoord」
   *   变成「这是一份片元着色器」，错误就此消失。
   */
  constructor(stage) {
    this.stage = stage;
    this.version = null;
    this.uniforms = new Map();
    this.ins = new Map();
    this.outs = new Map();
    this.consts = new Map();
    this.funcs = new Map();
    this.scopes = [];
    this.curFunc = null;
    this.builtinIn = stage === 'vert' ? GLSL_VERT_IN : GLSL_FRAG_IN;
    this.builtinOut = stage === 'vert' ? GLSL_VERT_OUT : GLSL_FRAG_OUT;
  }

  err(node, msg) {
    const at = node !== undefined && node !== null && node.span !== undefined
      ? `${node.span.file.path}:${node.span.line}: ` : '';
    return new OmniError(`${at}glsl: ${msg}`);
  }

  /** 名字表里已经有了就骂 —— 同一个名字两处声明，后面那处会悄悄遮住前面那处。 */
  claim(name, node) {
    if (this.uniforms.has(name) || this.ins.has(name) || this.outs.has(name)
      || this.consts.has(name)) {
      throw this.err(node, `'${name}' 声明过两次`);
    }
    if (this.builtinIn.has(name) || this.builtinOut.has(name)) {
      throw this.err(node, `'${name}' 是内建变量，不能自己声明`);
    }
  }

  push() { this.scopes.push(new Map()); }

  pop() { this.scopes.pop(); }

  declare(name, ty, node) {
    const top = this.scopes[this.scopes.length - 1];
    if (top.has(name)) throw this.err(node, `'${name}' 在同一层里声明过两次`);
    top.set(name, ty);
  }

  /** 名字 -> `{ty, kind}`。找不到就骂 —— GLSL 没有隐式声明。 */
  lookup(name, node) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const t = this.scopes[i].get(name);
      if (t !== undefined) return { ty: t, kind: 'local' };
    }
    if (this.consts.has(name)) return { ty: this.consts.get(name).ty, kind: 'const' };
    if (this.uniforms.has(name)) return { ty: this.uniforms.get(name), kind: 'uniform' };
    if (this.ins.has(name)) return { ty: this.ins.get(name).ty, kind: 'in' };
    if (this.outs.has(name)) return { ty: this.outs.get(name).ty, kind: 'out' };
    if (this.builtinIn.has(name)) return { ty: this.builtinIn.get(name), kind: 'builtin-in' };
    if (this.builtinOut.has(name)) return { ty: this.builtinOut.get(name), kind: 'builtin-out' };
    /* 另一档的内建变量：单独一句话，比「没见过这个名字」有用得多。 */
    const other = this.stage === 'vert' ? GLSL_FRAG_IN : GLSL_VERT_IN;
    const other2 = this.stage === 'vert' ? GLSL_FRAG_OUT : GLSL_VERT_OUT;
    if (other.has(name) || other2.has(name)) {
      throw this.err(node, `'${name}' 是${this.stage === 'vert' ? '片元' : '顶点'}着色器的内建变量，`
        + `这是一份${this.stage === 'vert' ? '顶点' : '片元'}着色器`);
    }
    throw this.err(node, `没见过的名字 '${name}'`);
  }

  /* ---------------------------------------------------------- 顶层 */

  unit(tree) {
    for (const d of glslFlatten(tree, 'unit-add', 'unit')) this.decl(d);
    if (!this.funcs.has('main')) throw this.err(null, '没有 main');
    const m = this.funcs.get('main');
    if (m.ret.k !== 'void' || m.params.length !== 0) {
      throw this.err(null, 'main 得是 void main()');
    }
    return {
      stage: this.stage,
      version: this.version,
      uniforms: [...this.uniforms].map(([name, ty]) => ({ name, ty })),
      ins: [...this.ins].map(([name, v]) => ({ name, ty: v.ty, interp: v.interp })),
      outs: [...this.outs].map(([name, v]) => ({ name, ty: v.ty, interp: v.interp })),
      consts: [...this.consts].map(([name, v]) => ({ name, ty: v.ty, init: v.init })),
      funcs: [...this.funcs.values()],
    };
  }

  decl(node) {
    const h = glslHead(node);
    if (h === 'version') {
      const line = glslAtom(node.items[1]);
      const m = /^#version\s+(\d+)/.exec(line);
      if (m === null) throw this.err(node, `读不懂的版本行 '${line}'`);
      const v = Number(m[1]);
      /* 认不出的版本**要骂**：悄悄按 330 编，等于把「这份源码用了 400 的东西」藏起来。 */
      if (v !== 330) throw this.err(node, `只收 #version 330，给的是 ${v}`);
      this.version = v;
      return;
    }
    if (h === 'uniform') {
      const name = glslAtom(node.items[2]);
      this.claim(name, node);
      this.uniforms.set(name, glslTyOf(node.items[1], (n, m) => this.err(n, m)));
      return;
    }
    if (h === 'in-var' || h === 'out-var') {
      const name = glslAtom(node.items[3]);
      this.claim(name, node);
      const ty = glslTyOf(node.items[2], (n, m) => this.err(n, m));
      /* 插值方式：`flat`/`smooth`/`noperspective`，没写就是 `smooth`（GLSL 的默认）。
       * llvmpipe 那边这一格是 `enum lp_interp`，是编 shader 变体时定死的常量。 */
      const q = glslHead(node.items[1]);
      const interp = q === 'interp-flat' ? 'flat'
        : q === 'interp-linear' ? 'linear' : 'smooth';
      (h === 'in-var' ? this.ins : this.outs).set(name, { ty, interp });
      return;
    }
    if (h === 'const-decl') {
      const name = glslAtom(node.items[2]);
      this.claim(name, node);
      const ty = glslTyOf(node.items[1], (n, m) => this.err(n, m));
      this.push();
      const init = this.coerce(this.expr(node.items[3]), ty, node);
      this.pop();
      this.consts.set(name, { ty, init });
      return;
    }
    if (h === 'func' || h === 'func-proto') {
      const name = glslAtom(node.items[2]);
      const ret = glslTyOf(node.items[1], (n, m) => this.err(n, m));
      const params = glslFlatten(node.items[3], 'params-add', 'params').map((p) => ({
        dir: glslHead(p.items[1]) === 'dir-out' ? 'out'
          : glslHead(p.items[1]) === 'dir-inout' ? 'inout' : 'in',
        ty: glslTyOf(p.items[2], (n, m) => this.err(n, m)),
        name: glslAtom(p.items[3]),
      }));
      if (h === 'func-proto') {
        if (!this.funcs.has(name)) this.funcs.set(name, { name, ret, params, body: null });
        return;
      }
      if (GLSL_BUILTINS.has(name) || GLSL_VEC_CMP.has(name) || GLSL_VEC_RED.has(name)
        || name === 'not') {
        throw this.err(node, `'${name}' 是内建函数，不能重定义`);
      }

      const had = this.funcs.get(name);
      if (had !== undefined && had.body !== null) throw this.err(node, `'${name}' 定义了两次`);
      const f = { name, ret, params, body: null };
      /* 先登记再查体：GLSL 里递归是**非法**的，但登记在前才能让「递归」这件事在
       * 名字解析这一层就被看见（现在的表现是「函数体里调到自己」——留到降级那一侧拦，
       * 因为那儿才知道调用图）。 */
      this.funcs.set(name, f);
      this.curFunc = f;
      this.push();
      for (const p of params) this.declare(p.name, p.ty, node);
      f.body = this.block(node.items[4]);
      this.pop();
      this.curFunc = null;
      return;
    }
    if (h === 'global') throw this.err(node, '模块级变量这一刀不收（尺子里没有；要的是 uniform 或 const）');
    throw this.err(node, `认不出的顶层声明 ${h}`);
  }

  /* ---------------------------------------------------------- 语句 */

  block(node) {
    this.push();
    const out = glslFlatten(node.items[1], 'stmts-add', 'stmts').map((s) => this.stmt(s));
    this.pop();
    return { k: 'block', body: out };
  }

  stmt(node) {
    const h = glslHead(node);
    if (h === 'empty') return { k: 'empty' };
    if (h === 'block') return this.block(node);
    if (h === 'expr-stmt') return { k: 'expr', e: this.expr(node.items[1]) };
    if (h === 'local' || h === 'local-init' || h === 'local-const') {
      const ty = glslTyOf(node.items[1], (n, m) => this.err(n, m));
      const name = glslAtom(node.items[2]);
      const init = node.items.length > 3 ? this.coerce(this.expr(node.items[3]), ty, node) : null;
      if (h === 'local-const' && init === null) throw this.err(node, `const '${name}' 没有初值`);
      this.declare(name, ty, node);
      return { k: 'decl', name, ty, init, isConst: h === 'local-const' };
    }
    if (h === 'ret') {
      const f = this.curFunc;
      if (f.ret.k === 'void') throw this.err(node, `${f.name} 是 void，return 不能带值`);
      return { k: 'ret', e: this.coerce(this.expr(node.items[1]), f.ret, node) };
    }
    if (h === 'ret-void') {
      if (this.curFunc.ret.k !== 'void') {
        throw this.err(node, `${this.curFunc.name} 要回一个 ${glslTyText(this.curFunc.ret)}`);
      }
      return { k: 'ret', e: null };
    }
    if (h === 'brk') return { k: 'break' };
    if (h === 'cont') return { k: 'continue' };
    if (h === 'discard') {
      /* 语法里有这一条**就是为了在这儿骂**：不收的话它会被当成一个变量名悄悄收下。 */
      throw this.err(node, 'discard 这一刀不收（两份尺子里都没有）');
    }
    if (h === 'if' || h === 'if-else') {
      const c = this.cond(node.items[1], node);
      return {
        k: 'if',
        c,
        then: this.stmt(node.items[2]),
        else: h === 'if-else' ? this.stmt(node.items[3]) : null,
      };
    }
    if (h === 'while') {
      return { k: 'while', c: this.cond(node.items[1], node), body: this.stmt(node.items[2]) };
    }
    if (h === 'do-while') {
      /* 体先走一趟才判条件 —— 与 `while` 的差别只在这一格，但语义上是「至少一趟」。 */
      const body = this.stmt(node.items[1]);
      return { k: 'dowhile', c: this.cond(node.items[2], node), body };
    }
    if (h === 'switch') return this.switchStmt(node);
    if (h === 'for') {
      /* `for` 自己一层作用域：`for (int i = ...)` 里的 `i` 出了循环就没了。 */
      this.push();
      const init = this.stmt(node.items[1]);
      const c = glslHead(node.items[2]) === 'none' ? null : this.cond(node.items[2], node);
      const step = glslHead(node.items[3]) === 'none' ? null : this.expr(node.items[3]);
      const body = this.stmt(node.items[4]);
      this.pop();
      return { k: 'for', init, c, step, body };
    }
    throw this.err(node, `认不出的语句 ${h}`);
  }

  /** 条件那一格必须是 `bool` —— GLSL 不像 C，整数不能当条件。 */
  cond(node, at) {
    const e = this.expr(node);
    if (e.ty.k !== 'bool') {
      throw this.err(at, `条件要是 bool，这儿是 ${glslTyText(e.ty)}`
        + '（GLSL 不像 C，整数不能当条件）');
    }
    return e;
  }

  /**
   * `switch`。规范 6.4：选择子是 `int`（或 `uint`），标签是**常量表达式**，
   * 穿落照 C 的规矩，`default` 可以摆在中间。
   *
   * 这儿把体拆成**按次序的组**：连着的标签算同一组，后面跟到下一个标签之前的语句就是
   * 那一组的体。分组之后穿落与 `default` 的位置都由降级那一侧一次算清（那儿有个
   * 「匹配过了」的标志位）—— 检查这一侧只管三条：选择子类型、标签重不重、
   * 第一个标签之前有没有语句。
   */
  switchStmt(node) {
    const sel = this.expr(node.items[1]);
    if (sel.ty.k !== 'int') {
      throw this.err(node, `switch 的选择子要是 int，这儿是 ${glslTyText(sel.ty)}`);
    }
    const items = glslFlatten(node.items[2], 'sw-items-add', 'sw-items');
    const groups = [];
    const seen = new Set();
    let hasDefault = false;
    this.push();
    for (const it of items) {
      const ih = glslHead(it);
      if (ih === 'sw-case' || ih === 'sw-default') {
        const label = ih === 'sw-default' ? null : this.caseLabel(it.items[1], it);
        if (label === null) {
          if (hasDefault) throw this.err(it, 'switch 里 default 出现了两次');
          hasDefault = true;
        } else {
          if (seen.has(label)) throw this.err(it, `switch 里 case ${label} 出现了两次`);
          seen.add(label);
        }
        /* 上一组已经开始收语句了，就另起一组；否则并进去（连着的标签共用一个体）。 */
        const last = groups[groups.length - 1];
        if (last === undefined || last.body.length > 0) groups.push({ labels: [label], body: [] });
        else last.labels.push(label);
        continue;
      }
      if (groups.length === 0) {
        throw this.err(it, 'switch 的第一个 case/default 之前不能有语句（规范 6.4）');
      }
      groups[groups.length - 1].body.push(this.stmt(it));
    }
    this.pop();
    return { k: 'switch', sel, groups, hasDefault };
  }

  /** case 的标签：常量整数。`-1` 那种一元负号在这儿折掉，别的常量表达式暂不收。 */
  caseLabel(node, at) {
    const e = this.expr(node);
    if (e.k === 'lit' && e.ty.k === 'int') return e.v;
    if (e.k === 'neg' && e.a.k === 'lit' && e.a.ty.k === 'int') return -e.a.v;
    throw this.err(at, 'case 的标签要是整数常量（这一刀只折字面量与它的负号）');
  }

  /* ---------------------------------------------------------- 表达式 */

  /**
   * `from` 的类型能不能当 `want` 用。GLSL 330 只有**一条**隐式转换：`int` -> `float`
   * （规范 4.1.10；`ivecN` -> `vecN` 也在里头）。别的一律不转 —— 不转就骂，
   * 悄悄转的话 `float f = someVec3;` 这种错会变成「取第一格」。
   */
  coerce(e, want, at) {
    if (glslSame(e.ty, want)) return e;
    if (want.k === 'float' && e.ty.k === 'int') return { k: 'convert', ty: want, of: e };
    if (want.k === 'vec' && want.base === 'float'
      && e.ty.k === 'vec' && e.ty.base === 'int' && e.ty.n === want.n) {
      return { k: 'convert', ty: want, of: e };
    }
    throw this.err(at, `要一个 ${glslTyText(want)}，给的是 ${glslTyText(e.ty)}`);
  }

  expr(node) {
    const h = glslHead(node);
    if (h === 'int-lit') return { k: 'lit', ty: GLSL_INT, v: Number(glslAtom(node.items[1])) };
    if (h === 'float-lit') {
      const raw = glslAtom(node.items[1]);
      return { k: 'lit', ty: GLSL_FLOAT, v: Number(raw.replace(/[fF]$/, '')) };
    }
    if (h === 'bool-lit') {
      return { k: 'lit', ty: GLSL_BOOL, v: glslAtom(node.items[1]) === '1' };
    }
    if (h === 'name') {
      const name = glslAtom(node.items[1]);
      const r = this.lookup(name, node);
      return { k: 'ref', ty: r.ty, name, kind: r.kind };
    }
    if (h === 'paren') return this.expr(node.items[1]);
    if (h === 'member') return this.swizzle(node);
    if (h === 'construct') return this.construct(node);
    if (h === 'call') return this.call(node);
    if (h === 'neg' || h === 'lnot' || h === 'bnot') return this.unary(node, h);
    if (h === 'pre-inc' || h === 'pre-dec' || h === 'post-inc' || h === 'post-dec') {
      const a = this.lvalue(node.items[1], node);
      if (a.ty.k !== 'int' && a.ty.k !== 'float') {
        throw this.err(node, `++/-- 只对 int 与 float，这儿是 ${glslTyText(a.ty)}`);
      }
      return { k: 'incdec', ty: a.ty, op: h, a };
    }
    if (h === 'cond') {
      const c = this.cond(node.items[1], node);
      const a = this.expr(node.items[2]);
      const b = this.expr(node.items[3]);
      /* 两支的类型必须能对齐。`? :` 在 GLSL 里是**表达式**，两支不同型没有意义。 */
      if (glslSame(a.ty, b.ty)) return { k: 'sel', ty: a.ty, c, a, b };
      if (a.ty.k === 'int' && b.ty.k === 'float') {
        return { k: 'sel', ty: GLSL_FLOAT, c, a: this.coerce(a, GLSL_FLOAT, node), b };
      }
      if (a.ty.k === 'float' && b.ty.k === 'int') {
        return { k: 'sel', ty: GLSL_FLOAT, c, a, b: this.coerce(b, GLSL_FLOAT, node) };
      }
      throw this.err(node, `? : 两支的类型对不齐（${glslTyText(a.ty)} 与 ${glslTyText(b.ty)}）`);
    }
    if (GLSL_ASSIGN_OPS[h] !== undefined) {
      const lhs = this.lvalue(node.items[1], node);
      if (h === 'assign') {
        return { k: 'assign', ty: lhs.ty, op: '=', lhs, rhs: this.coerce(this.expr(node.items[2]), lhs.ty, node) };
      }
      const op = GLSL_ASSIGN_OPS[h];
      /* `col *= rot(a)` 这种（`vec2 *= mat2`）合法，所以复合赋值先按二元算类型，
       * 再要求算出来的类型**就是**左边那个 —— 与 GLSL 规范 5.8 同一句话。 */
      const b = this.binTy(op, lhs.ty, this.expr(node.items[2]).ty, node);
      if (!glslSame(b, lhs.ty)) {
        throw this.err(node, `${op}= 的结果是 ${glslTyText(b)}，装不进 ${glslTyText(lhs.ty)}`);
      }
      return { k: 'assign', ty: lhs.ty, op, lhs, rhs: this.expr(node.items[2]) };
    }
    const BIN = {
      add: '+', sub: '-', mul: '*', div: '/', mod: '%',
      band: '&', bor: '|', bxor: '^', shl: '<<', shr: '>>',
      lt: '<', gt: '>', le: '<=', ge: '>=', eq: '==', ne: '!=',
      land: '&&', lor: '||', lxor: '^^',
    };
    if (BIN[h] !== undefined) return this.binary(node, BIN[h]);
    if (h === 'index') return this.index(node);
    throw this.err(node, `认不出的表达式 ${h}`);
  }

  /**
   * `m[K]`（矩阵取**列**）与 `v[K]`（向量取一格）。
   *
   * 下标**必须是整数字面量**：动态下标要方言里有真数组才做得对，这一刀没有 ——
   * 不挡住的话它只会在某个下标上悄悄取错一格。
   *
   * 矩阵是**列优先**（规范 5.6）：`m[0]` 是第 0 列，也就是 `mat2(a,b,c,d)` 里的 `(a,b)`。
   * 记成行就是转置，而转置在图上看不出「错」，只看得出「转过来了」。
   */
  index(node) {
    /* 局部叫 `subj` 而不是 `of`：`of` 在自举子集的词法里是关键字
     * （`docs/js-bootstrap-subset.md`），当变量名会让 `tests/js-roundtrip` 红。
     * 节点上的**属性**仍然叫 `of` —— 属性名不受那条限制。 */
    const subj = this.expr(node.items[1]);
    const at = this.expr(node.items[2]);
    if (at.k !== 'lit' || at.ty.k !== 'int') {
      throw this.err(node, '下标必须是整数字面量（动态下标要方言里有真数组，这一刀没有）');
    }
    const k = at.v;
    if (subj.ty.k === 'mat') {
      if (k < 0 || k >= subj.ty.cols) {
        throw this.err(node, `${glslTyText(subj.ty)} 只有 ${subj.ty.cols} 列，取不到第 ${k} 列`);
      }
      /* 取出来的是一**列**，长度是**行数** —— `mat2x3[0]` 是 vec3，不是 vec2。 */
      return { k: 'matcol', ty: glslVec(subj.ty.rows, 'float'), of: subj, col: k };
    }
    if (subj.ty.k === 'vec') {
      if (k < 0 || k >= subj.ty.n) {
        throw this.err(node, `${glslTyText(subj.ty)} 只有 ${subj.ty.n} 格，取不到第 ${k} 格`);
      }
      /* 向量那一侧就是 swizzle 的一格 —— 降级那边不必多认一种节点。 */
      return { k: 'swizzle', ty: glslElem(subj.ty), of: subj, idx: [k] };
    }
    throw this.err(node, `${glslTyText(subj.ty)} 不能取下标`);
  }

  /** 能不能赋值。`uniform`/`in`/内建的输入都不能写 —— 那是 GLSL 的规矩，不是我们的选择。 */
  lvalue(node, at) {
    const e = this.expr(node);
    if (e.k === 'ref') {
      if (e.kind === 'uniform') throw this.err(at, `uniform '${e.name}' 不能赋值`);
      if (e.kind === 'in') throw this.err(at, `in '${e.name}' 不能赋值`);
      if (e.kind === 'const') throw this.err(at, `const '${e.name}' 不能赋值`);
      if (e.kind === 'builtin-in') throw this.err(at, `内建输入 '${e.name}' 不能赋值`);
      return e;
    }
    if (e.k === 'swizzle') {
      /* `v.xy = ...` 合法，但同一格不能出现两次（`v.xx = ...` 是错的）。 */
      const seen = new Set(e.idx);
      if (seen.size !== e.idx.length) throw this.err(at, 'swizzle 里同一格出现两次，不能当左值');
      return e;
    }
    throw this.err(at, '左边这个东西不能赋值');
  }

  /**
   * swizzle 与成员。这一刀只有 swizzle（没有结构体），所以 `.` 后面那串必须是
   * 同一套字母（`xyzw` / `rgba` / `stpq` 不能混用 —— 规范 5.5 的原话）。
   */
  swizzle(node) {
    const of = this.expr(node.items[1]);
    const s = glslAtom(node.items[2]);
    if (of.ty.k !== 'vec') {
      throw this.err(node, `'.${s}' 只能取向量的分量，这儿是 ${glslTyText(of.ty)}`);
    }
    if (s.length < 1 || s.length > 4) throw this.err(node, `'.${s}' 长度只能是 1..4`);
    const set = GLSL_SWIZZLE_SETS.find((z) => [...s].every((c) => z.includes(c)));
    if (set === undefined) {
      throw this.err(node, `'.${s}' 里的字母不是同一套（xyzw / rgba / stpq 不能混用）`);
    }
    const idx = [...s].map((c) => set.indexOf(c));
    const over = idx.find((i) => i >= of.ty.n);
    if (over !== undefined) {
      throw this.err(node, `${glslTyText(of.ty)} 没有第 ${over + 1} 格（'.${s}'）`);
    }
    const ty = idx.length === 1 ? glslElem(of.ty) : glslVec(idx.length, of.ty.base);
    return { k: 'swizzle', ty, of, idx };
  }

  /**
   * 构造。三条规则，都是规范 5.4 里的：
   *
   *   1. 一个标量实参 -> **铺开**（`vec3(0.02)`、`mat2(1.0)` 是单位阵的对角）
   *   2. 标量目标一个实参 -> 转换（`float(i)`、`int(f)`）
   *   3. 其余：把实参的格数**摊平**数，必须**正好**够（多了也是错 —— 规范里多了是错，
   *      少了更是错；只有「一个标量」那条例外）
   */
  construct(node) {
    const ty = glslTyOf(node.items[1], (n, m) => this.err(n, m));
    const args = glslFlatten(node.items[2], 'args-add', 'args').map((a) => this.expr(a));
    if (ty.k === 'void') throw this.err(node, 'void 不能构造');
    if (glslIsScalar(ty)) {
      if (args.length !== 1) throw this.err(node, `${glslTyText(ty)}(...) 要正好一个实参`);
      const a = args[0];
      if (!glslIsScalar(a.ty)) {
        throw this.err(node, `${glslTyText(ty)}(...) 的实参要是标量，给了 ${glslTyText(a.ty)}`);
      }
      return { k: 'cast', ty, of: a };
    }
    if (args.length === 1 && glslIsScalar(args[0].ty)) {
      return { k: 'splat', ty, of: args[0] };
    }
    let have = 0;
    for (const a of args) {
      if (a.ty.k === 'mat') throw this.err(node, '拿矩阵当构造实参这一刀不收');
      have += glslCount(a.ty);
    }
    const want = glslCount(ty);
    if (have !== want) {
      throw this.err(node, `${glslTyText(ty)}(...) 要 ${want} 格，实参一共 ${have} 格`);
    }
    /* 每一格的**元素类型**也得对上：`vec3(0, 2, 4)` 三个都是 int 字面量，在 GLSL 里
     * 合法（规范 5.4.2：构造器对每个实参各做一次标量转换）。转换在这儿落成显式的
     * `cast`/`convert`，降级那一侧就不必再猜「这个 0 是 int 还是 float」。 */
    const el = glslElem(ty);
    const fixed = args.map((a) => {
      if (glslIsScalar(a.ty)) return glslSame(a.ty, el) ? a : { k: 'cast', ty: el, of: a };
      if (a.ty.k === 'vec' && a.ty.base !== el.k) {
        return { k: 'cast', ty: glslVec(a.ty.n, el.k), of: a };
      }
      return a;
    });
    return { k: 'construct', ty, args: fixed };
  }

  call(node) {
    const name = glslAtom(node.items[1]);
    const args = glslFlatten(node.items[2], 'args-add', 'args').map((a) => this.expr(a));
    const vty = glslVecCmpType(name, args.map((a) => a.ty), node, (n, m) => this.err(n, m));
    if (vty !== null) {
      /* 这一族**不提升实参**：`lessThan(ivec2, ivec2)` 是整数比较，
       * 悄悄提成 float 会把 `-1 < 0` 这种在极端值上算错。 */
      return { k: 'builtin', ty: vty, name, args };
    }
    if (GLSL_BUILTINS.has(name)) {
      const ty = glslGenType(name, args.map((a) => a.ty), node, (n, m) => this.err(n, m));
      /* 内建里 `int` 实参一律先提成 `float`（`sin(1)` 在 GLSL 里合法）。 */
      const fixed = args.map((a) => (a.ty.k === 'int' ? this.coerce(a, GLSL_FLOAT, node) : a));
      return { k: 'builtin', ty, name, args: fixed };
    }
    const f = this.funcs.get(name);
    if (f === undefined) throw this.err(node, `没见过的函数 '${name}'`);
    if (f.params.length !== args.length) {
      throw this.err(node, `${name} 要 ${f.params.length} 个实参，给了 ${args.length}`);
    }
    const fixed = args.map((a, i) => this.coerce(a, f.params[i].ty, node));
    return { k: 'call', ty: f.ret, name, args: fixed };
  }

  unary(node, h) {
    const a = this.expr(node.items[1]);
    if (h === 'lnot') {
      if (a.ty.k !== 'bool') throw this.err(node, `! 要一个 bool，这儿是 ${glslTyText(a.ty)}`);
      return { k: 'not', ty: GLSL_BOOL, a };
    }
    if (h === 'bnot') {
      /* `~` 只对整数（规范 5.9）。`ivecN` 逐格取反也合法。 */
      if (!glslIsIntish(a.ty)) {
        throw this.err(node, `~ 只对 int 或 ivecN，这儿是 ${glslTyText(a.ty)}`);
      }
      return { k: 'bnot', ty: a.ty, a };
    }
    if (a.ty.k === 'bool' || (a.ty.k === 'vec' && a.ty.base === 'bool')) {
      throw this.err(node, '负号不能作用在 bool 上');
    }
    return { k: 'neg', ty: a.ty, a };
  }

  /**
   * 二元运算的类型。这一段是这一份里最要紧的规则，逐条对着规范 5.9：
   *
   *   - 同型 -> 同型
   *   - 向量 op 标量、标量 op 向量 -> 向量（标量铺开）
   *   - `matN * vecN` -> `vecN`、`vecN * matN` -> `vecN`、`matN * matN` -> `matN`、
   *     `matN * float` -> `matN`
   *   - `%` **只对整数**（GLSL 里 float 取模要用 `mod()`）
   *   - 比较（`< > <= >=`）**只对标量**，回 `bool`
   *   - `== !=` 同型即可，回 `bool`
   *   - `&& ||` 只对 `bool`
   */
  binTy(op, a, b, node) {
    if (op === '&&' || op === '||' || op === '^^') {
      if (a.k !== 'bool' || b.k !== 'bool') {
        throw this.err(node, `${op} 两边要是 bool（${glslTyText(a)} 与 ${glslTyText(b)}）`);
      }
      return GLSL_BOOL;
    }
    if (op === '&' || op === '|' || op === '^') {
      /* 位运算只对整数（规范 5.9）。两边同型，或者一边是标量铺开。 */
      if (!glslIsIntish(a) || !glslIsIntish(b)) {
        throw this.err(node, `${op} 只对 int 或 ivecN（${glslTyText(a)} 与 ${glslTyText(b)}）`);
      }
      if (a.k === 'vec' && b.k === 'vec' && a.n !== b.n) {
        throw this.err(node, `${op} 两边的宽度不一样（${glslTyText(a)} 与 ${glslTyText(b)}）`);
      }
      return a.k === 'vec' ? a : b;
    }
    if (op === '<<' || op === '>>') {
      /* 移位的**结果类型由左边定**（规范 5.9）：右边只说移几位。
       * 左边是标量时右边也必须是标量 —— 不然「一个数移出一个向量」没有意思。 */
      if (!glslIsIntish(a) || !glslIsIntish(b)) {
        throw this.err(node, `${op} 只对 int 或 ivecN（${glslTyText(a)} 与 ${glslTyText(b)}）`);
      }
      if (a.k === 'int' && b.k === 'vec') {
        throw this.err(node, `${op} 左边是标量时右边也要是标量（右边是 ${glslTyText(b)}）`);
      }
      if (a.k === 'vec' && b.k === 'vec' && a.n !== b.n) {
        throw this.err(node, `${op} 两边的宽度不一样（${glslTyText(a)} 与 ${glslTyText(b)}）`);
      }
      return a;
    }
    if (op === '==' || op === '!=') {
      if (!glslSame(a, b) && !(glslIsScalar(a) && glslIsScalar(b))) {
        throw this.err(node, `${op} 两边要同型（${glslTyText(a)} 与 ${glslTyText(b)}）`);
      }
      return GLSL_BOOL;
    }
    if (op === '<' || op === '>' || op === '<=' || op === '>=') {
      if (!glslIsScalar(a) || !glslIsScalar(b) || a.k === 'bool' || b.k === 'bool') {
        throw this.err(node, `${op} 只比标量（${glslTyText(a)} 与 ${glslTyText(b)}）`
          + '；向量要逐格比得用 lessThan 那一族（这一刀没有）');
      }
      /* 回的是 **bool** —— 不是两边提升出来的那个类型。这一格第一版写错过：
       * 写成 `int` 的话 `for (int i = 0; i < 20; i++)` 的条件就不是 bool，
       * 而条件那道检查会把它骂成「整数不能当条件」，错得离题。 */
      return GLSL_BOOL;
    }
    if (op === '%') {
      if (a.k !== 'int' || b.k !== 'int') {
        throw this.err(node, `% 只对 int（float 取模要用 mod()）`);
      }
      return GLSL_INT;
    }
    /* 算术。矩阵那几格只有 `*` 有意义。尺寸规矩照规范 5.10：
     *
     *   `matAxB * matCxD` 要 A == D，出 `matCxB`（左边的列数 = 右边的行数）
     *   `matCxR * vecC`   出 `vecR`；`vecR * matCxR` 出 `vecC`
     *   `matCxR * float`  出同型
     */
    if (a.k === 'mat' || b.k === 'mat') {
      if (op !== '*') throw this.err(node, `矩阵只支持 *（给的是 ${op}）`);
      if (a.k === 'mat' && b.k === 'mat') {
        if (a.cols !== b.rows) {
          throw this.err(node, `${glslTyText(a)} * ${glslTyText(b)} 尺寸不对`
            + `（左边 ${a.cols} 列要等于右边 ${b.rows} 行）`);
        }
        return glslMat(b.cols, a.rows);
      }
      const m = a.k === 'mat' ? a : b;
      const v = a.k === 'mat' ? b : a;
      if (v.k === 'float' || v.k === 'int') return m;
      if (v.k === 'vec' && v.base === 'float') {
        /* `m * v` 要 v 的长度 = 列数，出行数那么长；`v * m` 反过来。 */
        if (a.k === 'mat' && v.n === m.cols) return glslVec(m.rows, 'float');
        if (b.k === 'mat' && v.n === m.rows) return glslVec(m.cols, 'float');
      }
      throw this.err(node, `${glslTyText(a)} * ${glslTyText(b)} 尺寸不对`);
    }
    if (glslSame(a, b)) {
      if (a.k === 'bool' || (a.k === 'vec' && a.base === 'bool')) {
        throw this.err(node, `${op} 不能作用在 bool 上`);
      }
      return a;
    }
    if (glslIsScalar(a) && glslIsScalar(b)) return a.k === 'float' || b.k === 'float' ? GLSL_FLOAT : GLSL_INT;
    const vec = a.k === 'vec' ? a : b.k === 'vec' ? b : null;
    const other = a.k === 'vec' ? b : a;
    if (vec !== null && glslIsScalar(other) && other.k !== 'bool') {
      if (vec.base === 'bool') throw this.err(node, `${op} 不能作用在 bvec 上`);
      /* `ivec2 * float` -> `vec2`（整数向量被提成浮点向量）。 */
      if (vec.base === 'int' && other.k === 'float') return glslVec(vec.n, 'float');
      return vec;
    }
    if (a.k === 'vec' && b.k === 'vec' && a.n !== b.n) {
      throw this.err(node, `${op} 两边的向量宽度不一样（${glslTyText(a)} 与 ${glslTyText(b)}）`);
    }
    throw this.err(node, `${op} 收不下 ${glslTyText(a)} 与 ${glslTyText(b)}`);
  }

  binary(node, op) {
    const a = this.expr(node.items[1]);
    const b = this.expr(node.items[2]);
    const ty = this.binTy(op, a.ty, b.ty, node);
    return { k: 'bin', ty, op, a, b };
  }
}

/**
 * 一棵 GLSL 语法树 -> 带类型的模块。
 *
 * @param tree `glrParse` 出来的那棵
 * @param stage `'vert'` 或 `'frag'`——**由调用方给**，见 `GlslChecker` 的构造器
 */
export function glslCheck(tree, stage) {
  if (stage !== 'vert' && stage !== 'frag') {
    throw new OmniError(`glsl: stage 要是 'vert' 或 'frag'，给的是 '${stage}'`);
  }
  return new GlslChecker(stage).unit(tree);
}
