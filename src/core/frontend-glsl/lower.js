/**
 * GLSL 带类型的树 -> **核心方言文本** —— ADR-0019 第一刀第三片。
 *
 * 为什么降到核心方言而不是直接到 MIR：JS 与 C 两条腿是**白得的**（方言那一层已经有五条腿），
 * 而这条线要的正是这两条腿的性能对照。量过的三条见 ADR-0019 的「量：降级要接的那一层」。
 *
 * ## 三条形状（决策一）
 *
 * 1. **一次一个片元**：`vecN` 拆成 N 个 `real`，不借用方言的 `(vec real 4)` ——
 *    那一格是留给「一次算 4 个片元」的，混用会把两件事搅在一起。
 * 2. 片元着色器编成**一个「吃一个片元、吐一个颜色」的函数**：
 *    `(fn glsl_frag ((frag_x real) (frag_y real) (<uniform 的每一格> real)) glsl_v4 …)`。
 *    uniform 走参数而不是全局，是为了让这个函数没有隐藏输入 —— 将来 SoA 化时
 *    要换的只有参数与返回值的类型。
 * 3. 每一个中间结果都**绑一个 let**（三地址式）。不绑的话「一个向量表达式被 N 个分量各用一次」
 *    会把它算 N 遍 —— `vec2(cos(a), sin(a)) * (0.55 + 0.15*sin(u_time+fi))` 里那个标量因子
 *    就会被算两次，既错（副作用）又慢（而这条线是要量性能的）。
 *
 * ## 这一片的边界：**只有第一档**（`benchmark.py` 那两份）
 *
 * 收：`float`/`int`/`vec2..4`、构造与 swizzle、向量与标量混算、`for`、局部量、
 * 用户函数（回 `float` 或 `vecN`）、`uniform`、`out vec4`、`gl_FragCoord`，
 * 内建里的 `sin cos abs min max length smoothstep float() sqrt floor pow mod exp log`。
 *
 * 不收（**明着骂**，不悄悄绕）：`mat2` 与矩阵乘、`mix/clamp/fract/normalize/dot/step`、
 * 三元 `? :`、`if`/`while`、varying（`in`）、顶点着色器。那是第二档的事（ADR-0019 第二刀），
 * 每一条在下面都有一句 `nyi(...)`。
 *
 * ## 模块级名字都带 `glsl` 前缀
 *
 * 与 `check.js` 同一个理由（自举那一版把所有模块摊进同一个作用域）。
 */

import { OmniError } from '../source/diag.js';
import { glslTyText } from './check.js';

/** 方言里那几个结构体的名字：`vecN` 当返回值时用它（参数是摊平的 N 个 real）。 */
const glslStructName = (n) => `glsl_v${n}`;

/** 分量的方言类型。 */
function glslCompTy(t) {
  const b = t.k === 'vec' ? t.base : t.k;
  if (b === 'float') return 'real';
  if (b === 'int') return 'int';
  if (b === 'bool') return 'bool';
  throw new OmniError(`glsl: 降不了的分量类型 ${b}`);
}

/** 有几格。 */
function glslNComp(t) {
  if (t.k === 'vec') return t.n;
  if (t.k === 'mat') return t.n * t.n;
  return 1;
}

/** `rmath` 直接转手的那些：GLSL 的名字 -> 方言的名字。 */
const GLSL_RMATH = new Map([
  ['sin', 'sin'], ['cos', 'cos'], ['tan', 'tan'],
  ['asin', 'asin'], ['acos', 'acos'], ['atan', 'atan'],
  ['exp', 'exp'], ['log', 'log'], ['sqrt', 'sqrt'],
  ['abs', 'fabs'], ['floor', 'floor'], ['ceil', 'ceil'],
  ['pow', 'pow'], ['mod', 'fmod'],
]);

/** 这一片还没接的（第二档）。**报错而不是绕过去** —— 绕过去的结果是一张不一样的图。 */
function glslNyi(what) {
  throw new OmniError(`glsl: ${what} 这一片还没接（ADR-0019 第一刀只做第一档，第二档是下一刀）`);
}

class GlslLowerer {
  constructor() {
    this.mod = null;
    /** 函数名前缀。**顶点与片元是两份源码，里头的辅助函数可以同名**
     * （两边各有一个 `sdCircle` 是很正常的事），并到一个方言模块里就撞了。
     * 于是顶点那一侧加一个前缀，片元那一侧不加（片元是主角，名字好看一点）。 */
    this.prefix = '';
    this.out = [];          // 顶层那几行
    this.structs = new Set();
    this.stmts = [];        // 当前正在攒的语句
    this.tmp = 0;
    this.names = new Map(); // 局部量名字的重名计数（见 uniq）
    this.scopes = [];       // 名字 -> 分量名数组
  }

  fresh(prefix) { this.tmp++; return `${prefix}${this.tmp}`; }

  /**
   * 局部量在方言里的名字。**必须一函数一份唯一**，不能直接用 GLSL 那个名字：
   *
   *   for (int i = 0; …) { … }
   *   for (int i = 0; …) { … }
   *
   * 两个 `i` 在 GLSL 里各是一层作用域，可 `for` 落成方言的 `while` 之后，
   * `(let i_0 …)` 是摆在 `while` **外面**的 —— 于是同一层里声明了两次
   * （量过：方言当场骂 `'i_0' 在这一层已经声明过了`）。所以重名的第二个起加个号。
   */
  uniq(base) {
    const k = this.names.get(base);
    if (k === undefined) { this.names.set(base, 1); return base; }
    this.names.set(base, k + 1);
    return `${base}__${k + 1}`;
  }

  push() { this.scopes.push(new Map()); }

  pop() { this.scopes.pop(); }

  bind(name, comps) { this.scopes[this.scopes.length - 1].set(name, comps); }

  find(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const c = this.scopes[i].get(name);
      if (c !== undefined) return c;
    }
    throw new OmniError(`glsl: 降级时找不到名字 '${name}'（检查那一步该拦住它）`);
  }

  /** 攒一句 `(let NAME TY EXPR)`，回 `(var NAME)`。 */
  let_(ty, expr) {
    const n = this.fresh('t');
    this.stmts.push(`(let ${n} ${ty} ${expr})`);
    return `(var ${n})`;
  }

  need(n) { this.structs.add(n); }

  /* ------------------------------------------------------------ 表达式 */

  /**
   * 一个带类型的 GLSL 表达式 -> **分量数组**（每一格是一段方言表达式文本）。
   * 副作用：往 `this.stmts` 里攒 `let`。
   */
  expr(e) {
    if (e.k === 'lit') {
      if (e.ty.k === 'float') return [`(real ${glslNum(e.v)})`];
      if (e.ty.k === 'int') return [`(int ${e.v})`];
      return [`(bool ${e.v ? 'true' : 'false'})`];
    }
    if (e.k === 'ref') {
      /* 每一类名字在这一层都已经绑成「分量数组」了：局部量与形参是 `let`/参数，
       * uniform 与 varying（`in`）是入口的参数，`out` 是入口里摆的格子，
       * 内建的 `gl_FragCoord`/`gl_VertexID`/`gl_Position` 也一样。所以这儿只查一遍。 */
      if (e.kind === 'uniform' || e.kind === 'local' || e.kind === 'const'
        || e.kind === 'in' || e.kind === 'out'
        || e.kind === 'builtin-in' || e.kind === 'builtin-out') {
        return this.find(e.name);
      }
      throw new OmniError(`glsl: 降不了的名字类别 ${e.kind}`);
    }
    if (e.k === 'convert' || e.k === 'cast') {
      const of = this.expr(e.of);
      const to = glslCompTy(e.ty);
      const from = glslCompTy(e.of.ty);
      if (to === from) return of;
      const op = to === 'real' ? 'toreal' : 'toint';
      return of.map((c) => this.let_(to, `(${op} ${c})`));
    }
    if (e.k === 'splat') {
      const of = this.expr(e.of)[0];
      const n = glslNComp(e.ty);
      const v = this.let_(glslCompTy(e.ty), of);
      const out = [];
      if (e.ty.k === 'mat') {
        /* `matN(x)` 是**对角线**填 x、其余 0（规范 5.4.2），不是每格都填 x。
         * 这一格填错的话 `mat2(1.0)` 会变成「四个 1」——那不是单位阵。 */
        const m = e.ty.n;
        for (let col = 0; col < m; col++) {
          for (let row = 0; row < m; row++) out.push(col === row ? v : '(real 0.0)');
        }
        return out;
      }
      /* 向量：同一个值填 N 格。先绑一个 let，免得算 N 遍。 */
      for (let i = 0; i < n; i++) out.push(v);
      return out;
    }
    if (e.k === 'construct') {
      /* 矩阵与向量同一条路：分量按**源码次序**摊平，而矩阵是列优先，
       * 所以 `mat2(a,b,c,d)` 出来正好是「第 0 列 (a,b)、第 1 列 (c,d)」。 */
      const out = [];
      for (const a of e.args) for (const c of this.expr(a)) out.push(c);
      return out;
    }
    if (e.k === 'swizzle') {
      const of = this.expr(e.of);
      /* 分量已经各自是一个 `(var tN)`，所以重排不必再绑。 */
      return e.idx.map((i) => of[i]);
    }
    if (e.k === 'neg') {
      const a = this.expr(e.a);
      return a.map((c) => this.let_(glslCompTy(e.ty), `(un "-" ${c})`));
    }
    if (e.k === 'not') {
      const a = this.expr(e.a);
      return [this.let_('bool', `(un "!" ${a[0]})`)];
    }
    if (e.k === 'bin') return this.bin(e);
    if (e.k === 'builtin') return this.builtin(e);
    if (e.k === 'call') return this.call(e);
    if (e.k === 'sel') return this.sel(e);
    if (e.k === 'assign') return this.assign(e);
    if (e.k === 'incdec') return this.incdec(e);
    throw new OmniError(`glsl: 降不了的表达式 ${e.k}`);
  }

  bin(e) {
    if (e.a.ty.k === 'mat' || e.b.ty.k === 'mat') return this.matBin(e);
    const a = this.expr(e.a);
    const b = this.expr(e.b);
    const ct = glslCompTy(e.ty);
    if (e.op === '&&' || e.op === '||') {
      /* 短路：两边都只能是「不需要 let」的表达式。这一片里 `&&`/`||` 两侧都是比较，
       * 而比较本身会绑 let —— 于是这一条会撞上。撞上就骂，不悄悄改成非短路的。 */
      glslNyi('&& 与 ||（短路语义要把右边整段搬进 if，这一片没做）');
    }
    if (e.op === '==' || e.op === '!=' || e.op === '<' || e.op === '>'
      || e.op === '<=' || e.op === '>=') {
      if (a.length !== 1 || b.length !== 1) glslNyi('向量的比较');
      return [this.let_('bool', `(bin "${e.op}" ${a[0]} ${b[0]})`)];
    }
    /* 算术：同型逐格、标量铺开。`%` 在 GLSL 里只对 int，方言的 `%` 也是。 */
    const n = Math.max(a.length, b.length);
    const out = [];
    for (let i = 0; i < n; i++) {
      const x = a.length === 1 ? a[0] : a[i];
      const y = b.length === 1 ? b[0] : b[i];
      out.push(this.let_(ct, `(bin "${e.op}" ${x} ${y})`));
    }
    return out;
  }

  /** `min`/`max`：方言没有表达式级的条件，所以落成一个 let + 一条 if。 */
  /**
   * 三元 `c ? a : b`。**两支各自的中间量要留在自己那一支里** ——
   * GLSL 的 `? :` 只算一支（规范 5.9），把两支的 `let` 都提到 if 外面就变成两支都算了。
   * 那不只是慢：`1.0/x` 那种在不该走的那一支里可能是除零。
   */
  sel(e) {
    const c = this.expr(e.c)[0];
    const n = glslNComp(e.ty);
    const ct = glslCompTy(e.ty);
    /* 先摆 N 个空格子，两支各往里写。 */
    const names = [];
    for (let i = 0; i < n; i++) {
      const nm = this.fresh('q');
      this.stmts.push(`(let ${nm} ${ct} ${glslZero(ct)})`);
      names.push(nm);
    }
    const branch = (sub) => {
      const save = this.stmts;
      this.stmts = [];
      const vals = this.expr(sub);
      for (let i = 0; i < n; i++) {
        this.stmts.push(`(set ${names[i]} ${vals.length === 1 ? vals[0] : vals[i]})`);
      }
      const body = this.stmts;
      this.stmts = save;
      return body;
    };
    const a = branch(e.a);
    const b = branch(e.b);
    this.stmts.push(`(if ${c} (do ${a.join(' ')}) (do ${b.join(' ')}))`);
    return names.map((nm) => `(var ${nm})`);
  }

  /**
   * 矩阵那几种乘法。**列优先**（GLSL 规范 5.6）：`mat2(a,b,c,d)` 的第 0 列是 `(a,b)`、
   * 第 1 列是 `(c,d)`，所以第 `col` 列第 `row` 行那一格的下标是 `col*N + row`。
   *
   * 记错这一格的后果是**转置**：`rot(a)` 变成转过来那个旋转，图往反方向转，
   * 而且一个数都不会 NaN —— 那种错只有对着图才看得出来。
   */
  matBin(e) {
    if (e.op !== '*') throw new OmniError(`glsl: 矩阵只支持 *（给的是 ${e.op}）`);
    const a = this.expr(e.a);
    const b = this.expr(e.b);
    const ta = e.a.ty;
    const tb = e.b.ty;
    const ct = 'real';
    const dot = (xs, ys) => {
      let sum = null;
      for (let i = 0; i < xs.length; i++) {
        const p = this.let_(ct, `(bin "*" ${xs[i]} ${ys[i]})`);
        sum = sum === null ? p : this.let_(ct, `(bin "+" ${sum} ${p})`);
      }
      return sum;
    };
    if (ta.k === 'mat' && (tb.k === 'float' || tb.k === 'int')) {
      return a.map((c) => this.let_(ct, `(bin "*" ${c} ${b[0]})`));
    }
    if (tb.k === 'mat' && (ta.k === 'float' || ta.k === 'int')) {
      return b.map((c) => this.let_(ct, `(bin "*" ${a[0]} ${c})`));
    }
    /* `matN * vecN`：结果第 row 格 = Σ_col m[col][row] * v[col]。 */
    if (ta.k === 'mat' && tb.k === 'vec') {
      const n = ta.n;
      const out = [];
      for (let row = 0; row < n; row++) {
        const xs = [];
        for (let col = 0; col < n; col++) xs.push(a[col * n + row]);
        out.push(dot(xs, b));
      }
      return out;
    }
    /* `vecN * matN`：结果第 col 格 = dot(v, 第 col 列)。 */
    if (ta.k === 'vec' && tb.k === 'mat') {
      const n = tb.n;
      const out = [];
      for (let col = 0; col < n; col++) {
        const ys = [];
        for (let row = 0; row < n; row++) ys.push(b[col * n + row]);
        out.push(dot(a, ys));
      }
      return out;
    }
    /* `matN * matN`：结果第 col 列 = a × (b 的第 col 列)。 */
    if (ta.k === 'mat' && tb.k === 'mat') {
      const n = ta.n;
      const out = [];
      for (let col = 0; col < n; col++) {
        for (let row = 0; row < n; row++) {
          const xs = [];
          const ys = [];
          for (let k = 0; k < n; k++) {
            xs.push(a[k * n + row]);
            ys.push(b[col * n + k]);
          }
          out.push(dot(xs, ys));
        }
      }
      return out;
    }
    throw new OmniError(`glsl: 降不了的矩阵乘（${glslTyText(ta)} * ${glslTyText(tb)}）`);
  }

  /** `min`/`max`：方言没有表达式级的条件，所以落成一个 let + 一条 if。 */
  minmax(op, x, y, ct) {
    const n = this.fresh('m');
    this.stmts.push(`(let ${n} ${ct} ${x})`);
    const cmp = op === 'min' ? '<' : '>';
    this.stmts.push(`(if (bin "${cmp}" ${y} (var ${n})) (do (set ${n} ${y})))`);
    return `(var ${n})`;
  }

  builtin(e) {
    const name = e.name;
    const ct = 'real';
    const args = e.args.map((a) => this.expr(a));
    const wide = Math.max(...args.map((a) => a.length));
    const at = (k, i) => (args[k].length === 1 ? args[k][0] : args[k][i]);
    const rm = GLSL_RMATH.get(name);
    if (rm !== undefined) {
      const out = [];
      for (let i = 0; i < wide; i++) {
        const xs = args.map((_, k) => at(k, i)).join(' ');
        out.push(this.let_(ct, `(rmath "${rm}" ${xs})`));
      }
      return out;
    }
    if (name === 'min' || name === 'max') {
      const out = [];
      for (let i = 0; i < wide; i++) out.push(this.minmax(name, at(0, i), at(1, i), ct));
      return out;
    }
    if (name === 'length') {
      /* sqrt(sum of squares)。`length(vec2)` 不用 `hypot` —— 那是另一个函数，
       * 与 GLSL 规范里 `sqrt(dot(v,v))` 的结果在最后一位上未必相同。 */
      let sum = null;
      for (const c of args[0]) {
        const sq = this.let_(ct, `(bin "*" ${c} ${c})`);
        sum = sum === null ? sq : this.let_(ct, `(bin "+" ${sum} ${sq})`);
      }
      return [this.let_(ct, `(rmath "sqrt" ${sum})`)];
    }
    if (name === 'smoothstep') {
      /* 规范 8.3：t = clamp((x-e0)/(e1-e0), 0, 1); return t*t*(3-2t)。
       * clamp 用两条 if（方言没有表达式级条件）。 */
      const out = [];
      for (let i = 0; i < wide; i++) {
        const e0 = at(0, i);
        const e1 = at(1, i);
        const x = at(2, i);
        const num = this.let_(ct, `(bin "-" ${x} ${e0})`);
        const den = this.let_(ct, `(bin "-" ${e1} ${e0})`);
        const t0 = this.let_(ct, `(bin "/" ${num} ${den})`);
        const t = this.fresh('s');
        this.stmts.push(`(let ${t} real ${t0})`);
        this.stmts.push(`(if (bin "<" (var ${t}) (real 0.0)) (do (set ${t} (real 0.0))))`);
        this.stmts.push(`(if (bin ">" (var ${t}) (real 1.0)) (do (set ${t} (real 1.0))))`);
        const tt = this.let_(ct, `(bin "*" (var ${t}) (var ${t}))`);
        const two = this.let_(ct, `(bin "*" (real 2.0) (var ${t}))`);
        const three = this.let_(ct, `(bin "-" (real 3.0) ${two})`);
        out.push(this.let_(ct, `(bin "*" ${tt} ${three})`));
      }
      return out;
    }
    /* ---- 第二档那几个（`pretty_render.py` 要的）。都是规范 8.x 里的几行算术，
     * 所以**不进 rmath**，在这儿展开 —— 展开的形状与规范逐字对着写，见每一条的注释。 */
    if (name === 'fract') {
      /* 8.3：`x - floor(x)`。 */
      return args[0].map((c) => {
        const f = this.let_(ct, `(rmath "floor" ${c})`);
        return this.let_(ct, `(bin "-" ${c} ${f})`);
      });
    }
    if (name === 'inversesqrt') {
      return args[0].map((c) => {
        const s = this.let_(ct, `(rmath "sqrt" ${c})`);
        return this.let_(ct, `(bin "/" (real 1.0) ${s})`);
      });
    }
    if (name === 'radians' || name === 'degrees') {
      /* 8.1：`radians(d) = d * pi/180`、`degrees(r) = r * 180/pi`。 */
      const k = name === 'radians' ? '0.017453292519943295' : '57.29577951308232';
      return args[0].map((c) => this.let_(ct, `(bin "*" ${c} (real ${k}))`));
    }
    if (name === 'sign') {
      /* 8.3。`(x > 0) - (x < 0)` 那种整数把戏在方言里不成立（bool 不能减），
       * 所以老实用两条 if。 */
      const out = [];
      for (const c of args[0]) {
        const nm = this.fresh('sg');
        this.stmts.push(`(let ${nm} real (real 0.0))`);
        this.stmts.push(`(if (bin ">" ${c} (real 0.0)) (do (set ${nm} (real 1.0))))`);
        this.stmts.push(`(if (bin "<" ${c} (real 0.0)) (do (set ${nm} (un "-" (real 1.0)))))`);
        out.push(`(var ${nm})`);
      }
      return out;
    }
    if (name === 'step') {
      /* 8.3：`x < edge ? 0 : 1`。 */
      const out = [];
      for (let i = 0; i < wide; i++) {
        const nm = this.fresh('st');
        this.stmts.push(`(let ${nm} real (real 1.0))`);
        this.stmts.push(`(if (bin "<" ${at(1, i)} ${at(0, i)}) (do (set ${nm} (real 0.0))))`);
        out.push(`(var ${nm})`);
      }
      return out;
    }
    if (name === 'clamp') {
      /* 8.3：`min(max(x, minVal), maxVal)`。 */
      const out = [];
      for (let i = 0; i < wide; i++) {
        const lo = this.minmax('max', at(0, i), at(1, i), ct);
        out.push(this.minmax('min', lo, at(2, i), ct));
      }
      return out;
    }
    if (name === 'mix') {
      /* 8.3：`x*(1-a) + y*a`。**照规范这个形状写**，不写成 `x + (y-x)*a` ——
       * 两者在浮点下不等价（`a == 1` 时前者精确回 y，后者不一定）。 */
      const out = [];
      for (let i = 0; i < wide; i++) {
        const a0 = at(2, i);
        const one = this.let_(ct, `(bin "-" (real 1.0) ${a0})`);
        const l = this.let_(ct, `(bin "*" ${at(0, i)} ${one})`);
        const r = this.let_(ct, `(bin "*" ${at(1, i)} ${a0})`);
        out.push(this.let_(ct, `(bin "+" ${l} ${r})`));
      }
      return out;
    }
    if (name === 'dot') {
      let sum = null;
      for (let i = 0; i < args[0].length; i++) {
        const p = this.let_(ct, `(bin "*" ${args[0][i]} ${args[1][i]})`);
        sum = sum === null ? p : this.let_(ct, `(bin "+" ${sum} ${p})`);
      }
      return [sum];
    }
    if (name === 'distance') {
      let sum = null;
      for (let i = 0; i < args[0].length; i++) {
        const d = this.let_(ct, `(bin "-" ${args[0][i]} ${args[1][i]})`);
        const p = this.let_(ct, `(bin "*" ${d} ${d})`);
        sum = sum === null ? p : this.let_(ct, `(bin "+" ${sum} ${p})`);
      }
      return [this.let_(ct, `(rmath "sqrt" ${sum})`)];
    }
    if (name === 'normalize') {
      /* 8.5：`v / length(v)`。长度算一次（绑 let），不是每格算一遍。 */
      let sum = null;
      for (const c of args[0]) {
        const sq = this.let_(ct, `(bin "*" ${c} ${c})`);
        sum = sum === null ? sq : this.let_(ct, `(bin "+" ${sum} ${sq})`);
      }
      const len = this.let_(ct, `(rmath "sqrt" ${sum})`);
      return args[0].map((c) => this.let_(ct, `(bin "/" ${c} ${len})`));
    }
    if (name === 'cross') {
      const a = args[0];
      const b = args[1];
      const mul = (x, y) => this.let_(ct, `(bin "*" ${x} ${y})`);
      const sub = (x, y) => this.let_(ct, `(bin "-" ${x} ${y})`);
      return [
        sub(mul(a[1], b[2]), mul(a[2], b[1])),
        sub(mul(a[2], b[0]), mul(a[0], b[2])),
        sub(mul(a[0], b[1]), mul(a[1], b[0])),
      ];
    }
    glslNyi(`内建 ${name}`);
    return [];
  }

  call(e) {
    const args = [];
    for (const a of e.args) for (const c of this.expr(a)) args.push(c);
    const n = glslNComp(e.ty);
    /* 回矩阵与回向量走同一条路：`(struct glsl_vN …)` 里 N = 分量个数
     * （`mat2` 是 4 格，正好与 `vec4` 用同一个结构体 —— 它俩在这一层就是「四个 real」）。 */
    const callTxt = `(call glsl_${this.prefix}${e.name} ${args.join(' ')})`;
    if (n === 1) return [this.let_(glslCompTy(e.ty), callTxt)];
    /* 回向量的函数：方言里回一个结构体（值语义），这儿当场拆成 N 格。
     * 一次调用一个 `(new)` —— 将来嫌它慢，办法是把这类函数内联，不是改这一层的形状。 */
    this.need(n);
    const s = this.fresh('r');
    this.stmts.push(`(let ${s} ${glslStructName(n)} ${callTxt})`);
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.let_('real', `(fld (var ${s}) c${i})`));
    return out;
  }

  assign(e) {
    const lhs = e.lhs;
    const target = lhs.k === 'ref' ? this.find(lhs.name)
      : lhs.k === 'swizzle' ? this.swizzleTarget(lhs) : null;
    if (target === null) throw new OmniError('glsl: 降不了的左值');
    let vals;
    if (e.op === '=') vals = this.expr(e.rhs);
    else {
      /* `a op= b` 展开成 `a = a op b`。类型已经在检查那一步核过了。 */
      vals = this.bin({ k: 'bin', ty: e.ty, op: e.op, a: lhs, b: e.rhs });
    }
    for (let i = 0; i < target.length; i++) {
      const v = vals.length === 1 ? vals[0] : vals[i];
      this.stmts.push(`(set ${glslVarName(target[i])} ${v})`);
    }
    return target;
  }

  /** `v.xy = …` 的左边：回那几格**变量名**（顺序按 swizzle）。 */
  swizzleTarget(lhs) {
    if (lhs.of.k !== 'ref') throw new OmniError('glsl: swizzle 左值的底必须是一个名字');
    const base = this.find(lhs.of.name);
    return lhs.idx.map((i) => base[i]);
  }

  incdec(e) {
    const target = this.expr(e.a);
    const one = e.a.ty.k === 'int' ? '(int 1)' : '(real 1.0)';
    const op = e.op === 'pre-inc' || e.op === 'post-inc' ? '+' : '-';
    const before = this.let_(glslCompTy(e.a.ty), target[0]);
    this.stmts.push(`(set ${glslVarName(target[0])} (bin "${op}" ${target[0]} ${one}))`);
    /* 后缀回的是**改之前**那个值；前缀回改之后的。 */
    return e.op.startsWith('post') ? [before] : target;
  }

  /* ------------------------------------------------------------ 语句 */

  stmt(s) {
    if (s.k === 'empty') return;
    if (s.k === 'block') {
      this.push();
      for (const x of s.body) this.stmt(x);
      this.pop();
      return;
    }
    if (s.k === 'expr') { this.expr(s.e); return; }
    if (s.k === 'decl') {
      const n = glslNComp(s.ty);
      const ct = glslCompTy(s.ty);
      const vals = s.init === null ? null : this.expr(s.init);
      const comps = [];
      const base = this.uniq(s.name);
      for (let i = 0; i < n; i++) {
        const name = `${base}_${i}`;
        const v = vals === null ? glslZero(ct) : (vals.length === 1 ? vals[0] : vals[i]);
        this.stmts.push(`(let ${name} ${ct} ${v})`);
        comps.push(`(var ${name})`);
      }
      this.bind(s.name, comps);
      return;
    }
    if (s.k === 'ret') {
      if (s.e === null) { this.stmts.push('(ret)'); return; }
      const vals = this.expr(s.e);
      if (vals.length === 1) { this.stmts.push(`(ret ${vals[0]})`); return; }
      this.need(vals.length);
      const sn = this.fresh('rv');
      this.stmts.push(`(let ${sn} ${glslStructName(vals.length)} (new ${glslStructName(vals.length)}))`);
      for (let i = 0; i < vals.length; i++) {
        this.stmts.push(`(fldset (var ${sn}) c${i} ${vals[i]})`);
      }
      this.stmts.push(`(ret (var ${sn}))`);
      return;
    }
    if (s.k === 'for') {
      /* `for` 落成方言的 `while`：init 在前、step 在体尾。
       * **`continue` 会跳过 step** —— 这是 C 与 GLSL 的 `for` 与这种展开的差别。
       * 这一档里 `continue` 一份尺子都没用，所以撞上就骂（见 `cont`）。 */
      this.push();
      this.stmt(s.init);
      const body = [];
      const outer = this.stmts;
      this.stmts = body;
      this.stmt(s.body);
      if (s.step !== null) this.expr(s.step);
      this.stmts = outer;
      const cond = s.c === null ? '(bool true)' : this.condIn(s.c, body);
      this.stmts.push(`(while ${cond} (do ${body.join(' ')}))`);
      this.pop();
      return;
    }
    if (s.k === 'break') { this.stmts.push('(brk)'); return; }
    if (s.k === 'continue') {
      glslNyi('continue（`for` 展成 while 之后它会跳过步进那一格）');
    }
    if (s.k === 'if') {
      /* 条件的中间量提到 `if` **外面**是对的 —— 条件本来就要算一次。
       * （三元不一样：那两支只算一支，见 `sel`。） */
      const c = this.expr(s.c)[0];
      const then = this.sub(() => this.stmt(s.then));
      if (s.else === null) {
        this.stmts.push(`(if ${c} (do ${then.join(' ')}))`);
      } else {
        const other = this.sub(() => this.stmt(s.else));
        this.stmts.push(`(if ${c} (do ${then.join(' ')}) (do ${other.join(' ')}))`);
      }
      return;
    }
    if (s.k === 'while') {
      /* 条件每一轮都要重算，所以走 `condIn`（要求它降出来是一条表达式）。 */
      const body = this.sub(() => this.stmt(s.body));
      this.stmts.push(`(while ${this.condIn(s.c)} (do ${body.join(' ')}))`);
      return;
    }
    throw new OmniError(`glsl: 降不了的语句 ${s.k}`);
  }

  /** 攒一段子语句：`f()` 往一个新的 `stmts` 里写，回那一段。 */
  sub(f) {
    const save = this.stmts;
    this.stmts = [];
    f();
    const body = this.stmts;
    this.stmts = save;
    return body;
  }

  /**
   * 循环条件。它每一轮都要重算，所以**不能**用外面攒的 `let` ——
   * 那些 `let` 只在进循环前算一次。这一档里条件都是 `i < 20` 这种（一条比较），
   * 所以要求它降出来「一条表达式、零条语句」，否则骂。
   */
  condIn(c) {
    const save = this.stmts;
    this.stmts = [];
    const v = this.expr(c);
    const extra = this.stmts;
    this.stmts = save;
    if (v.length !== 1) throw new OmniError('glsl: 循环条件不是一格');
    /* `expr` 会把比较也绑一个 let，所以这儿恰好有一条 —— 把它内联回去。 */
    if (extra.length === 1) {
      const m = /^\(let \S+ bool (.*)\)$/.exec(extra[0]);
      if (m !== null) return m[1];
    }
    if (extra.length === 0) return v[0];
    glslNyi('循环条件里有要先算的中间量（这一档的条件都是一条比较）');
    return '';
  }

  /* ------------------------------------------------------------ 顶层 */

  /** 一个 GLSL 函数 -> 一条方言 `fn`。参数摊平成 N 个 real，返回值是标量或结构体。 */
  func(f) {
    if (f.name === 'main') return;
    const ps = [];
    this.push();
    for (const p of f.params) {
      if (p.dir !== 'in') glslNyi('out/inout 形参');
      const n = glslNComp(p.ty);
      const ct = glslCompTy(p.ty);
      const comps = [];
      for (let i = 0; i < n; i++) {
        ps.push(`(${p.name}_${i} ${ct})`);
        comps.push(`(var ${p.name}_${i})`);
      }
      this.bind(p.name, comps);
    }
    const rn = glslNComp(f.ret);
    const ret = f.ret.k === 'void' ? 'void'
      : rn === 1 ? glslCompTy(f.ret) : glslStructName(rn);
    if (rn > 1) this.need(rn);
    this.stmts = [];
    this.stmt(f.body);
    const body = this.stmts;
    this.stmts = [];
    this.pop();
    this.out.push(`  (fn glsl_${this.prefix}${f.name} (${ps.join(' ')}) ${ret}\n    ${body.join('\n    ')})`);
  }

  /**
   * 片元的入口。签名是**定死**的：
   *
   *   `(fn glsl_frag ((frag_x real) (frag_y real) (<uniform 每一格>…)) glsl_v4 …)`
   *
   * `gl_FragCoord` 只给 `.xy` 两格真值，`.z`/`.w` 是 0/1（这一档没有深度、没有透视）。
   * 出来的是 `out vec4` 那一个 —— 多渲染目标这一刀不收。
   */
  entry() {
    const m = this.mod;
    if (m.stage === 'vert') return this.vertEntry();
    if (m.outs.length !== 1) glslNyi(`${m.outs.length} 个 out（这一刀只收一个）`);
    const o = m.outs[0];
    if (!(o.ty.k === 'vec' && o.ty.n === 4)) {
      throw new OmniError(`glsl: out 得是 vec4，这儿是 ${glslTyText(o.ty)}`);
    }
    const ps = ['(frag_x real)', '(frag_y real)'];
    this.push();
    this.bind('gl_FragCoord', ['(var frag_x)', '(var frag_y)', '(real 0.0)', '(real 1.0)']);
    /* varying（`in`）：**插值好的值当参数递进来**。插的那一步不在这个函数里 ——
     * 它是「一个三角形一次」的事（`a0`/`dadx`/`dady`），而这个函数是「一个片元一次」。
     * 这条分界与 llvmpipe 一样：`lp_bld_interp.c` 是独立的一块。 */
    for (const v of m.ins) {
      const n = glslNComp(v.ty);
      const ct = glslCompTy(v.ty);
      const comps = [];
      for (let i = 0; i < n; i++) {
        ps.push(`(in_${v.name}_${i} ${ct})`);
        comps.push(`(var in_${v.name}_${i})`);
      }
      this.bind(v.name, comps);
    }
    for (const u of m.uniforms) {
      const n = glslNComp(u.ty);
      const ct = glslCompTy(u.ty);
      const comps = [];
      for (let i = 0; i < n; i++) {
        ps.push(`(${u.name}_${i} ${ct})`);
        comps.push(`(var ${u.name}_${i})`);
      }
      this.bind(u.name, comps);
    }
    this.stmts = [];
    /* 模块级 const 在入口里落成局部量（这一档没有别的函数用得到它们）。 */
    for (const c of m.consts) {
      const n = glslNComp(c.ty);
      const ct = glslCompTy(c.ty);
      const vals = this.expr(c.init);
      const comps = [];
      for (let i = 0; i < n; i++) {
        this.stmts.push(`(let ${c.name}_${i} ${ct} ${vals.length === 1 ? vals[0] : vals[i]})`);
        comps.push(`(var ${c.name}_${i})`);
      }
      this.bind(c.name, comps);
    }
    /* `out vec4` 那一个：先摆四格零，`main` 里往它写。 */
    const oc = [];
    for (let i = 0; i < 4; i++) {
      this.stmts.push(`(let ${o.name}_${i} real (real 0.0))`);
      oc.push(`(var ${o.name}_${i})`);
    }
    this.bind(o.name, oc);
    const main = this.mod.funcs.find((f) => f.name === 'main');
    this.stmt(main.body);
    this.need(4);
    this.stmts.push(`(let out4 ${glslStructName(4)} (new ${glslStructName(4)}))`);
    for (let i = 0; i < 4; i++) this.stmts.push(`(fldset (var out4) c${i} ${oc[i]})`);
    this.stmts.push('(ret (var out4))');
    const body = this.stmts;
    this.stmts = [];
    this.pop();
    this.out.push(`  (fn glsl_frag (${ps.join(' ')}) ${glslStructName(4)}\n    ${body.join('\n    ')})`);
  }

  /**
   * 顶点的入口：`(fn glsl_v_vert ((vid int) (<uniform…>)) glsl_vN)`。
   *
   * 回的那一个结构体是**位置四格 + 每个 varying 的分量**（按声明序）——
   * 一个顶点算一次，插值那一步在外面（`glslTriProgram` 造的 setup 段）。
   */
  vertEntry() {
    const m = this.mod;
    const ps = ['(vid int)'];
    this.push();
    this.bind('gl_VertexID', ['(var vid)']);
    for (const u of m.uniforms) {
      const n = glslNComp(u.ty);
      const ct = glslCompTy(u.ty);
      const comps = [];
      for (let i = 0; i < n; i++) {
        ps.push(`(${u.name}_${i} ${ct})`);
        comps.push(`(var ${u.name}_${i})`);
      }
      this.bind(u.name, comps);
    }
    this.stmts = [];
    for (const c of m.consts) {
      const n = glslNComp(c.ty);
      const ct = glslCompTy(c.ty);
      const vals = this.expr(c.init);
      const comps = [];
      for (let i = 0; i < n; i++) {
        this.stmts.push(`(let ${c.name}_${i} ${ct} ${vals.length === 1 ? vals[0] : vals[i]})`);
        comps.push(`(var ${c.name}_${i})`);
      }
      this.bind(c.name, comps);
    }
    /* `gl_Position` 是内建的 out（四格）。 */
    const flat = [];
    for (let i = 0; i < 4; i++) {
      this.stmts.push(`(let gl_Position_${i} real (real 0.0))`);
      flat.push(`(var gl_Position_${i})`);
    }
    this.bind('gl_Position', flat.slice());
    /* varying（顶点这一侧的 `out`）。 */
    for (const v of m.outs) {
      const n = glslNComp(v.ty);
      const ct = glslCompTy(v.ty);
      const comps = [];
      for (let i = 0; i < n; i++) {
        this.stmts.push(`(let out_${v.name}_${i} ${ct} ${glslZero(ct)})`);
        comps.push(`(var out_${v.name}_${i})`);
      }
      this.bind(v.name, comps);
      for (const c of comps) flat.push(c);
    }
    const main = m.funcs.find((f) => f.name === 'main');
    this.stmt(main.body);
    const n = flat.length;
    this.need(n);
    this.stmts.push(`(let outv ${glslStructName(n)} (new ${glslStructName(n)}))`);
    for (let i = 0; i < n; i++) this.stmts.push(`(fldset (var outv) c${i} ${flat[i]})`);
    this.stmts.push('(ret (var outv))');
    const body = this.stmts;
    this.stmts = [];
    this.pop();
    this.out.push(`  (fn glsl_${this.prefix}vert (${ps.join(' ')}) ${glslStructName(n)}\n    ${body.join('\n    ')})`);
  }

  /** 一个模块（顶点或片元）的全部函数 + 入口。名字加 `prefix`。 */
  emitModule(mod, prefix) {
    this.mod = mod;
    this.prefix = prefix;
    this.names = new Map();
    for (const f of mod.funcs) this.func(f);
    this.entry();
  }

  /** 拼成方言文本。`mainTxt` 是要接在后面的那一段（可以是空串）。 */
  finish(mainTxt) {
    const decls = [...this.structs].sort((a, b) => a - b).map((n) => {
      const fs = [];
      for (let i = 0; i < n; i++) fs.push(`(c${i} real)`);
      return `  (struct ${glslStructName(n)} ${fs.join(' ')})`;
    });
    const body = [...decls, ...this.out].join('\n\n');
    return `(module\n${body}${mainTxt === '' ? '' : `\n\n${mainTxt}`}\n)\n`;
  }

  run() {
    this.emitModule(this.mod, '');
    return this.finish('');
  }
}

/** 变量名从 `(var x)` 里抠出来 —— `set` 要的是名字，不是表达式。 */
function glslVarName(txt) {
  const m = /^\(var (\S+)\)$/.exec(txt);
  if (m === null) throw new OmniError(`glsl: '${txt}' 不是一个可赋值的名字`);
  return m[1];
}

/** 方言里的零值。 */
const glslZero = (ct) => (ct === 'real' ? '(real 0.0)' : ct === 'int' ? '(int 0)' : '(bool false)');

/** 浮点字面量：方言要求带小数点（`(real 3)` 不是 real）。 */
function glslNum(v) {
  if (!Number.isFinite(v)) throw new OmniError(`glsl: 降不了的浮点常量 ${v}`);
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/**
 * 一个（已检查过的）GLSL 模块 -> 核心方言文本。
 *
 * 出来的模块里**没有 `main`** —— 它是一个库：`glsl_frag(x, y, uniforms…)` 回一个
 * `glsl_v4`。跑它的那一头是 `glslRenderMain`。
 */
export function glslLower(mod) {
  const L = new GlslLowerer();
  L.emitModule(mod, '');
  return L.finish('');
}

/** 三点定平面的那三个系数（`a0`/`dadx`/`dady`），一条方言函数。 */
const GLSL_PLANE_FN = `  (fn glsl_plane ((q0 real) (q1 real) (q2 real)
      (x0 real) (y0 real) (x1 real) (y1 real) (x2 real) (y2 real)) glsl_v3
    ;; 三点定平面：q = a0 + dadx*x + dady*y。llvmpipe 的 setup 算的就是这三个数
    ;; （\`lp_setup_tri.c\` 的 \`setup_tri_coefficients\`），片元那一侧只做一次仿射求值。
    (let dx1 real (bin "-" (var x1) (var x0)))
    (let dy1 real (bin "-" (var y1) (var y0)))
    (let dx2 real (bin "-" (var x2) (var x0)))
    (let dy2 real (bin "-" (var y2) (var y0)))
    (let det real (bin "-" (bin "*" (var dx1) (var dy2)) (bin "*" (var dx2) (var dy1))))
    (let q1d real (bin "-" (var q1) (var q0)))
    (let q2d real (bin "-" (var q2) (var q0)))
    (let dadx real (bin "/" (bin "-" (bin "*" (var q1d) (var dy2)) (bin "*" (var q2d) (var dy1))) (var det)))
    (let dady real (bin "/" (bin "-" (bin "*" (var q2d) (var dx1)) (bin "*" (var q1d) (var dx2))) (var det)))
    (let a0 real (bin "-" (bin "-" (var q0) (bin "*" (var dadx) (var x0))) (bin "*" (var dady) (var y0))))
    (let r glsl_v3 (new glsl_v3))
    (fldset (var r) c0 (var a0))
    (fldset (var r) c1 (var dadx))
    (fldset (var r) c2 (var dady))
    (ret (var r)))`;

/** 8 位那一步：`round(clamp(v,0,1)*255)`。 */
const GLSL_TO8_FN = `  (fn glsl_to8 ((v real)) int
    (let x real (var v))
    (if (bin "<" (var x) (real 0.0)) (do (set x (real 0.0))))
    (if (bin ">" (var x) (real 1.0)) (do (set x (real 1.0))))
    (ret (toint (rmath "round" (bin "*" (var x) (real 255.0))))))`;

/**
 * 顶点 + 片元 + 插值，一整条：**一个三角形铺满画布**那一路。
 *
 * ## 插值照 llvmpipe 的形状（决策一、ADR-0019「量：读 llvmpipe」第三条）
 *
 * 一个三角形一次的 setup 算 `a0`/`dadx`/`dady`，一个片元一次的求值是
 * `a = a0 + x*dadx + y*dady`。**透视校正**照标准做法：插 `a/w` 与 `1/w`，
 * 片元处相除 —— `w` 全是 1 时它精确退化成线性插值，所以两份尺子（全屏三角形，
 * `gl_Position.w = 1.0`）走哪条都一样，而别的三角形也不会错。
 *
 * `flat` 那一档取**第三个顶点**（GL 4.x 默认的 provoking vertex 是 last），
 * `noperspective` 走线性（不除 `oow`）。这三档是编译期定死的，与 llvmpipe 的
 * `enum lp_interp` 一样 —— 运行期没有分支。
 *
 * ## 这一段**不做覆盖判定**
 *
 * 两份尺子都是「一个三角形铺满整个视口」，所以每个像素都在里头。真正的边函数掩码
 * （llvmpipe 的 `do_block_16`/`do_block_4`，ADR-0019 那一节量过）是下一片的事 ——
 * 写在明处：现在这一段**假设三角形覆盖全画布**，喂一个不覆盖全画布的三角形，
 * 它会把外面也画上。
 */
export function glslTriProgram(vertMod, fragMod, w, h, uni) {
  const L = new GlslLowerer();
  L.emitModule(vertMod, 'v_');
  L.emitModule(fragMod, '');
  L.need(3);
  /* 顶点那一侧的 uniform 与片元那一侧的各自取值。 */
  const uniArgs = (mod) => {
    const out = [];
    for (const u of mod.uniforms) {
      const vals = uni[u.name];
      if (vals === undefined) throw new OmniError(`glsl: uniform '${u.name}' 没给值`);
      const n = glslNComp(u.ty);
      if (vals.length !== n) {
        throw new OmniError(`glsl: uniform '${u.name}' 要 ${n} 格，给了 ${vals.length}`);
      }
      for (const v of vals) {
        out.push(glslCompTy(u.ty) === 'int' ? `(int ${Math.trunc(v)})` : `(real ${glslNum(v)})`);
      }
    }
    return out;
  };
  const vUni = uniArgs(vertMod).join(' ');
  const vN = 4 + vertMod.outs.reduce((s, v) => s + glslNComp(v.ty), 0);
  /* 片元那一侧要的 varying，按**片元的声明序**去顶点那一侧找同名的。 */
  const attrs = [];
  let at = 4;
  const posOf = new Map();
  for (const v of vertMod.outs) {
    posOf.set(v.name, at);
    at += glslNComp(v.ty);
  }
  for (const v of fragMod.ins) {
    const base = posOf.get(v.name);
    if (base === undefined) {
      throw new OmniError(`glsl: 片元要的 varying '${v.name}' 顶点那边没有`);
    }
    const n = glslNComp(v.ty);
    for (let i = 0; i < n; i++) attrs.push({ name: v.name, comp: i, fld: base + i, interp: v.interp });
  }
  const s = [];
  s.push('  (main');
  /* 三个顶点。 */
  for (let k = 0; k < 3; k++) {
    s.push(`    (let v${k} ${glslStructName(vN)} (call glsl_v_vert (int ${k})${vUni === '' ? '' : ` ${vUni}`}))`);
  }
  /* 裁剪空间 -> 窗口坐标。y 往上长（`gl_FragCoord` 原点在左下，见 ADR-0019 那一节）。 */
  for (let k = 0; k < 3; k++) {
    s.push(`    (let w${k} real (fld (var v${k}) c3))`);
    s.push(`    (let oow${k} real (bin "/" (real 1.0) (var w${k})))`);
    s.push(`    (let x${k} real (bin "*" (bin "+" (bin "*" (bin "*" (fld (var v${k}) c0) (var oow${k})) (real 0.5)) (real 0.5)) (real ${glslNum(w)})))`);
    s.push(`    (let y${k} real (bin "*" (bin "+" (bin "*" (bin "*" (fld (var v${k}) c1) (var oow${k})) (real 0.5)) (real 0.5)) (real ${glslNum(h)})))`);
  }
  const XY = '(var x0) (var y0) (var x1) (var y1) (var x2) (var y2)';
  /* `1/w` 的平面（透视校正要它）。 */
  s.push(`    (let pw glsl_v3 (call glsl_plane (var oow0) (var oow1) (var oow2) ${XY}))`);
  /* 每个属性分量一份平面。`smooth` 插的是 `a/w`，`noperspective` 插 `a` 本身。 */
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i];
    if (a.interp === 'flat') continue;
    for (let k = 0; k < 3; k++) {
      const q = `(fld (var v${k}) c${a.fld})`;
      s.push(`    (let q${i}_${k} real ${a.interp === 'smooth' ? `(bin "*" ${q} (var oow${k}))` : q})`);
    }
    s.push(`    (let p${i} glsl_v3 (call glsl_plane (var q${i}_0) (var q${i}_1) (var q${i}_2) ${XY}))`);
  }
  s.push('    (let px real (real 0.0))');
  s.push('    (let py real (real 0.0))');
  /* 覆盖判定的三条边函数（llvmpipe 的 `lp_rast_plane`）。
   *
   * 边 j 从 `(xa,ya)` 到 `(xb,yb)`，用**叉积**：
   *
   *   `e_j(p) = cross(b-a, p-a) = (xb-xa)*(py-ya) - (yb-ya)*(px-xa)`
   *
   * 也就是 `dedx = -(yb-ya)`、`dedy = (xb-xa)`。三条都 `>= 0` 就在三角形里。
   *
   * **符号约定必须与 `area` 那个公式同源**：`area = cross(v1-v0, v2-v0)`，
   * 与上面那个 `e` 是同一个叉积。第一版我把 `e` 写成了 `(x-xa)*(yb-ya) - …`
   * （反的），于是全屏三角形上三条边函数**全为负**，一个像素都没画出来 ——
   * 门当场全红。反过来说，如果那时候只测「全屏三角形能画」这一条，
   * 我可能会把 `>=` 改成 `<=` 蒙过去，而那在别的绕向上又是错的。
   *
   * `sgn` 是绕向：面积为负（顺时针）时三条整体取反，于是「在内」永远是 `>= 0`。
   * llvmpipe 那边是在 setup 里把三角形拧成固定绕向（`lp_setup_tri.c`），一回事。
   *
   * **边上的归属规则还没照 GL 的 top-left 做**（现在是 `>= 0`，含边）。
   * 只有两个三角形共享一条边时才看得出来 —— 那时候那条边上的像素会画两遍。 */
  s.push('    (let area real (bin "-" (bin "*" (bin "-" (var x1) (var x0)) (bin "-" (var y2) (var y0)))'
    + ' (bin "*" (bin "-" (var x2) (var x0)) (bin "-" (var y1) (var y0)))))');
  s.push('    (let sgn real (real 1.0))');
  s.push('    (if (bin "<" (var area) (real 0.0)) (do (set sgn (un "-" (real 1.0)))))');
  const EDGES = [[0, 1], [1, 2], [2, 0]];
  for (let j = 0; j < 3; j++) {
    const [a2, b2] = EDGES[j];
    s.push(`    (let e${j}dx real (bin "*" (var sgn) (bin "-" (var y${a2}) (var y${b2}))))`);
    s.push(`    (let e${j}dy real (bin "*" (var sgn) (bin "-" (var x${b2}) (var x${a2}))))`);
    s.push(`    (let e${j} real (real 0.0))`);
    s.push(`    (let in${j} bool (bool false))`);
    /* 落在边**上**（`e == 0`）那些样本归谁：一条边只能归**一个**三角形，
     * 不然两个共享它的三角形会把那条线画两遍（第八片就是那样）。
     *
     * 判据要**对边的方向是奇的**：方向反过来结论就反过来。这样两个共享边的三角形
     * （绕向都归一之后，那条边在两边的方向正好相反）里恰好一个认领它 —— 不重不漏。
     * 用的是常见的那一套：`sdy > 0`，或者 `sdy == 0 && sdx < 0`。
     *
     * **哪一侧归谁与 GL 是否一致，还没量**（要一台有 GL 的机器）。能保证的是
     * 「不重不漏」——那是填充规则的定义性性质，不用 GL 也验得了（门里那条方块用例）。
     * 与 GL 差一个整体翻转的可能性留着，写在明处。
     *
     * `sdx`/`sdy` 乘了 `sgn`：绕向归一化只改了 `e` 的符号，边的方向没改 ——
     * 不跟着乘的话，同一片像素在两种绕向下会得到不同的归属。 */
    s.push(`    (let s${j}dx real (bin "*" (var sgn) (bin "-" (var x${b2}) (var x${a2}))))`);
    s.push(`    (let s${j}dy real (bin "*" (var sgn) (bin "-" (var y${b2}) (var y${a2}))))`);
    s.push(`    (let tl${j} bool (bin ">" (var s${j}dy) (real 0.0)))`);
    s.push(`    (if (bin "&&" (bin "==" (var s${j}dy) (real 0.0)) (bin "<" (var s${j}dx) (real 0.0)))`
      + ` (do (set tl${j} (bool true))))`);
  }
  s.push(`    (let c ${glslStructName(4)} (new ${glslStructName(4)}))`);
  L.need(4);
  /* quad 扫描（次序与第四片一样）。 */
  const QX = [0, 1, 0, 1];
  const QY = [0, 0, 1, 1];
  const evalAt = (i) => {
    const a = attrs[i];
    if (a.interp === 'flat') return `(fld (var v2) c${a.fld})`;
    const lin = `(bin "+" (bin "+" (fld (var p${i}) c0) (bin "*" (fld (var p${i}) c1) (var px)))`
      + ` (bin "*" (fld (var p${i}) c2) (var py)))`;
    if (a.interp !== 'smooth') return lin;
    const oow = '(bin "+" (bin "+" (fld (var pw) c0) (bin "*" (fld (var pw) c1) (var px)))'
      + ' (bin "*" (fld (var pw) c2) (var py)))';
    return `(bin "/" ${lin} ${oow})`;
  };
  const inner = [];
  for (let k = 0; k < 4; k++) {
    inner.push(`(set px (bin "+" (toreal (var qx)) (real ${QX[k] + 0.5})))`);
    inner.push(`(set py (bin "+" (toreal (var qy)) (real ${QY[k] + 0.5})))`);
    for (let j = 0; j < 3; j++) {
      const base = EDGES[j][0];
      inner.push(`(set e${j} (bin "+" (bin "*" (var e${j}dx) (bin "-" (var px) (var x${base})))`
        + ` (bin "*" (var e${j}dy) (bin "-" (var py) (var y${base})))))`);
      /* `in_j = (e_j > 0) || (tl_j && e_j == 0)` —— 边上那些样本按 `tl_j` 归属。 */
      inner.push(`(set in${j} (bin ">" (var e${j}) (real 0.0)))`);
      inner.push(`(if (bin "&&" (var tl${j}) (bin "==" (var e${j}) (real 0.0)))`
        + ` (do (set in${j} (bool true))))`);
    }
    const args = ['(var px)', '(var py)'];
    for (let i = 0; i < attrs.length; i++) args.push(evalAt(i));
    for (const x of uniArgs(fragMod)) args.push(x);
    /* 覆盖 **且** 在画布里才算 —— 不覆盖的像素**连片元都不调**（真的光栅化就该这样，
     * 也正好省掉那一次着色）。 */
    const cov = '(bin "&&" (bin "&&" (var in0) (var in1)) (var in2))';
    inner.push(`(if (bin "&&" ${cov} (bin "&&" (bin "<" (var px) (real ${glslNum(w)}))`
      + ` (bin "<" (var py) (real ${glslNum(h)}))))`
      + ' (do'
      + ` (set c (call glsl_frag ${args.join(' ')}))`
      + ' (print (toint (bin "-" (var px) (real 0.5))))'
      + ' (print (toint (bin "-" (var py) (real 0.5))))'
      + ' (print (call glsl_to8 (fld (var c) c0)))'
      + ' (print (call glsl_to8 (fld (var c) c1)))'
      + ' (print (call glsl_to8 (fld (var c) c2)))))');
  }
  s.push('    (let qy int (int 0))');
  s.push(`    (while (bin "<" (var qy) (int ${Math.ceil(h / 2) * 2}))`);
  s.push('      (do');
  s.push('        (let qx int (int 0))');
  s.push(`        (while (bin "<" (var qx) (int ${Math.ceil(w / 2) * 2}))`);
  s.push('          (do');
  s.push(`            ${inner.join('\n            ')}`);
  s.push('            (set qx (bin "+" (var qx) (int 2)))))');
  s.push('        (set qy (bin "+" (var qy) (int 2))))))');
  return L.finish(`${GLSL_PLANE_FN}\n\n${GLSL_TO8_FN}\n\n${s.join('\n')}`);
}

/**
 * 把画布扫一遍的那一段：`glslLower` 出来的库 + 这一段 = 一个能跑的方言程序。
 *
 * ## 按 quad 走，不按扫描线（决策一第二条）
 *
 * 顺序是 llvmpipe 那一套的最内两层（`lp_bld_interp.c:53-87`）：一个 2×2 的 quad 里
 * 四个像素按 `左上、右上、左下、右下`，quad 之间按行。为什么第一刀就要这个顺序，
 * 哪怕现在一次只算一个片元：`dFdx`/`dFdy` 与纹理 LOD 天生要 quad，而 SoA 化就是
 * 把这个循环的内核换掉 —— 顺序现在定死，将来换内核时图不会变。
 *
 * 宽高不是 2 的倍数时**多算的那些像素照样算、但不印**（llvmpipe 也是这样：
 * 边上的 quad 用掩码丢掉几个像素，而不是缩小 quad）。
 *
 * ## 印的是文本，不是 PNG
 *
 * 方言这一层没有文件 IO（只有 `print`），而这是**故意**的 —— 一门中间语言不该长出
 * 文件系统。于是这一段每个像素印一行 `x y r g b`，PNG 由外面那一层（门、或者将来的
 * 驱动命令）拼。代价写在明处：`print` 的开销在小画布上就盖过着色器本身，所以
 * **性能对照不能用这条路**（那要另一个不印东西的 main，见 ADR-0019 第五片）。
 *
 * @param mod 检查过的 GLSL 模块（要拿 uniform 的名字与格数）
 * @param w 画布宽
 * @param h 画布高
 * @param uni `{名字: [每一格的数]}`——uniform 的值，由调用方给
 */
export function glslRenderMain(mod, w, h, uni) {
  const args = ['(var px)', '(var py)'];
  for (const u of mod.uniforms) {
    const vals = uni[u.name];
    if (vals === undefined) throw new OmniError(`glsl: uniform '${u.name}' 没给值`);
    const n = glslNComp(u.ty);
    if (vals.length !== n) {
      throw new OmniError(`glsl: uniform '${u.name}' 要 ${n} 格，给了 ${vals.length}`);
    }
    for (const v of vals) {
      args.push(glslCompTy(u.ty) === 'int' ? `(int ${Math.trunc(v)})` : `(real ${glslNum(v)})`);
    }
  }
  const call = `(call glsl_frag ${args.join(' ')})`;
  /* quad 里那四格的偏移，顺序照 llvmpipe 的 `quad_offset_x/y`。 */
  const QX = [0, 1, 0, 1];
  const QY = [0, 0, 1, 1];
  const inner = [];
  for (let k = 0; k < 4; k++) {
    inner.push(`(set px (bin "+" (toreal (var qx)) (real ${QX[k] + 0.5})))`);
    inner.push(`(set py (bin "+" (toreal (var qy)) (real ${QY[k] + 0.5})))`);
    inner.push(`(set c ${call})`);
    /* 出了画布的那几格照样算（上面那三句），只是不印 —— 见函数头。
     * 一格一个 `print`，不拼成一行：方言的 `+` 是「同型相加」，`int + string`
     * 不在它的规矩里，而绕过去（先 `toreal` 再拼）只会让这段更难看。 */
    inner.push(`(if (bin "&&" (bin "<" (var px) (real ${glslNum(w)}))`
      + ` (bin "<" (var py) (real ${glslNum(h)})))`
      + ' (do'
      + ' (print (toint (bin "-" (var px) (real 0.5))))'
      + ' (print (toint (bin "-" (var py) (real 0.5))))'
      + ' (print (call glsl_to8 (fld (var c) c0)))'
      + ' (print (call glsl_to8 (fld (var c) c1)))'
      + ' (print (call glsl_to8 (fld (var c) c2)))))');
  }
  return `  (fn glsl_to8 ((v real)) int
    (let x real (var v))
    (if (bin "<" (var x) (real 0.0)) (do (set x (real 0.0))))
    (if (bin ">" (var x) (real 1.0)) (do (set x (real 1.0))))
    (ret (toint (rmath "round" (bin "*" (var x) (real 255.0))))))

  (main
    (let c ${glslStructName(4)} (new ${glslStructName(4)}))
    (let px real (real 0.0))
    (let py real (real 0.0))
    (let qy int (int 0))
    (while (bin "<" (var qy) (int ${Math.ceil(h / 2) * 2}))
      (do
        (let qx int (int 0))
        (while (bin "<" (var qx) (int ${Math.ceil(w / 2) * 2}))
          (do
            ${inner.join('\n            ')}
            (set qx (bin "+" (var qx) (int 2)))))
        (set qy (bin "+" (var qy) (int 2))))))
`;
}

/** 库 + 扫描那一段，拼成一个完整的方言程序。 */
export function glslProgram(mod, w, h, uni) {
  const lib = glslLower(mod).trimEnd();
  return `${lib.slice(0, -1)}\n${glslRenderMain(mod, w, h, uni)})\n`;
}

/**
 * 量性能那一段：**一个字节都不印**（只在最后印一个校验和）。
 *
 * 为什么不能拿 `glslRenderMain` 量：那一段一个像素五个 `print`，量出来的是 `print`
 * 的耗时不是着色器的（小画布上前者就盖过后者）。
 *
 * 为什么要有校验和：不攒一个用得到的结果，整个循环会被后端当死代码扔掉 ——
 * 那时量出来的是「什么都不做要多久」。攒的是**每个像素三格 8 位值的和**，
 * 与 `glslRenderMain` 印出来的那些数一一对应，所以这两条路算的是同一件事
 * （门里对过：同一尺寸下校验和 == 印出来那些数的和）。
 *
 * 迭代 `iters` 遍，为的是把一次进程启动的固定开销摊薄 —— 与 `benchmark.py` 那边
 * 「先 warmup 一帧再量 N 帧」同一个道理。
 */
export function glslBenchMain(mod, w, h, uni, iters) {
  const args = ['(var px)', '(var py)'];
  for (const u of mod.uniforms) {
    const vals = uni[u.name];
    if (vals === undefined) throw new OmniError(`glsl: uniform '${u.name}' 没给值`);
    for (const v of vals) {
      args.push(glslCompTy(u.ty) === 'int' ? `(int ${Math.trunc(v)})` : `(real ${glslNum(v)})`);
    }
  }
  const call = `(call glsl_frag ${args.join(' ')})`;
  const QX = [0, 1, 0, 1];
  const QY = [0, 0, 1, 1];
  const inner = [];
  for (let k = 0; k < 4; k++) {
    inner.push(`(set px (bin "+" (toreal (var qx)) (real ${QX[k] + 0.5})))`);
    inner.push(`(set py (bin "+" (toreal (var qy)) (real ${QY[k] + 0.5})))`);
    inner.push(`(set c ${call})`);
    inner.push(`(if (bin "&&" (bin "<" (var px) (real ${glslNum(w)}))`
      + ` (bin "<" (var py) (real ${glslNum(h)})))`
      + ' (do'
      + ' (set acc (bin "+" (var acc) (call glsl_to8 (fld (var c) c0))))'
      + ' (set acc (bin "+" (var acc) (call glsl_to8 (fld (var c) c1))))'
      + ' (set acc (bin "+" (var acc) (call glsl_to8 (fld (var c) c2))))))');
  }
  return `  (fn glsl_to8 ((v real)) int
    (let x real (var v))
    (if (bin "<" (var x) (real 0.0)) (do (set x (real 0.0))))
    (if (bin ">" (var x) (real 1.0)) (do (set x (real 1.0))))
    (ret (toint (rmath "round" (bin "*" (var x) (real 255.0))))))

  (main
    (let c ${glslStructName(4)} (new ${glslStructName(4)}))
    (let px real (real 0.0))
    (let py real (real 0.0))
    (let acc int (int 0))
    (let it int (int 0))
    (while (bin "<" (var it) (int ${iters}))
      (do
        (let qy int (int 0))
        (while (bin "<" (var qy) (int ${Math.ceil(h / 2) * 2}))
          (do
            (let qx int (int 0))
            (while (bin "<" (var qx) (int ${Math.ceil(w / 2) * 2}))
              (do
                ${inner.join('\n                ')}
                (set qx (bin "+" (var qx) (int 2)))))
            (set qy (bin "+" (var qy) (int 2)))))
        (set it (bin "+" (var it) (int 1)))))
    (print (var acc)))
`;
}

/** 库 + 量性能那一段。 */
export function glslBenchProgram(mod, w, h, uni, iters) {
  const lib = glslLower(mod).trimEnd();
  return `${lib.slice(0, -1)}\n${glslBenchMain(mod, w, h, uni, iters)})\n`;
}


