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

/** 分量的方言类型。矩阵的分量一律是 `float`（GLSL 里没有整数矩阵）。 */
function glslCompTy(t) {
  const b = t.k === 'vec' ? t.base : t.k === 'mat' ? 'float' : t.k;
  if (b === 'float') return 'real';
  if (b === 'int') return 'int';
  if (b === 'bool') return 'bool';
  throw new OmniError(`glsl: 降不了的分量类型 ${b}`);
}

/** 有几格。矩阵是 `cols * rows`（列优先摊平，第 c 列占 c*rows 起那 rows 格）。 */
function glslNComp(t) {
  if (t.k === 'vec') return t.n;
  if (t.k === 'mat') return t.cols * t.rows;
  /* 数组是 n 份元素接起来（B14）：第 k 格占 `k*w` 起那 w 格，w = 元素的格数。
   * 与矩阵取列是同一个公式，只是「列」换成了「元素」。 */
  if (t.k === 'array') return t.n * glslNComp(t.of);
  /* 结构体是各成员之和 —— 与 `check.js` 的 `glslCount` 同一个公式（施工图 B13）。 */
  if (t.k === 'struct') {
    let n = 0;
    for (const f of t.fields) n += glslNComp(f.ty);
    return n;
  }
  return 1;
}

/**
 * **每一格**的方言类型。
 *
 * 为什么要它：结构体的分量类型**不是一种** —— `struct Segs { vec2 s0; vec2 s1; int n; }`
 * 前四格是 `real`、第五格是 `int`。别的类型就是同一个重复 N 遍，所以在非结构体上
 * 它与 `glslCompTy` 一字不差。
 *
 * `glslCompTy` 刻意**没有**收结构体：算术那一片（`+ - * /`、比较、内建）一个都不收
 * 结构体，走到那儿就该骂。要按格取类型的只有「声明 / 赋值 / 构造 / 成员 / 形参与返回」
 * 那几处，它们走这一个。
 */
function glslCompTys(t) {
  if (t.k === 'struct') {
    const out = [];
    for (const f of t.fields) for (const x of glslCompTys(f.ty)) out.push(x);
    return out;
  }
  /* 数组（B14）：元素那一串重复 n 遍。元素是结构体时这一条要紧 —— 不然 `Segs a[2]`
   * 的第五格会被当成 `real`。 */
  if (t.k === 'array') {
    const one = glslCompTys(t.of);
    const out = [];
    for (let i = 0; i < t.n; i++) for (const x of one) out.push(x);
    return out;
  }
  const ct = glslCompTy(t);
  const out = [];
  for (let i = 0; i < glslNComp(t); i++) out.push(ct);
  return out;
}

/** `rmath` 直接转手的那些：GLSL 的名字 -> 方言的名字。 */
const GLSL_RMATH = new Map([['sin', 'sin'], ['cos', 'cos'], ['tan', 'tan'],
  ['asin', 'asin'], ['acos', 'acos'], ['atan', 'atan'],
  ['sinh', 'sinh'], ['cosh', 'cosh'], ['tanh', 'tanh'],
  ['asinh', 'asinh'], ['acosh', 'acosh'], ['atanh', 'atanh'],
  ['exp', 'exp'], ['log', 'log'], ['sqrt', 'sqrt'],
  ['abs', 'fabs'], ['floor', 'floor'], ['ceil', 'ceil'], ['round', 'round'],
  ['pow', 'pow'], ['mod', 'fmod'],
]);

/** 向量比较那一族（规范 8.6）：GLSL 的名字 -> 方言的算符。逐格比，出一串 bool。 */
const GLSL_VEC_CMP_OP = new Map([
  ['lessThan', '<'], ['lessThanEqual', '<='],
  ['greaterThan', '>'], ['greaterThanEqual', '>='],
  ['equal', '=='], ['notEqual', '!='],
]);

/** 这一片还没接的（第二档）。**报错而不是绕过去** —— 绕过去的结果是一张不一样的图。 */
function glslNyi(what) {
  throw new OmniError(`glsl: ${what} 这一片还没接（ADR-0019 第一刀只做第一档，第二档是下一刀）`);
}

/**
 * 这一段语句里有**属于当前这一层循环**的 `continue` 吗。
 *
 * 「属于当前这一层」= 不进嵌套的 `for`/`while` 去看：GLSL 的 `continue` 永远指最里那一层，
 * 所以嵌套循环里的那些与外面这一层无关。判它是为了决定 `for` 要不要套那一圈
 * 「只走一趟的 while」（见 `stmt` 里 for 那一段）—— 不需要时不套，降出来的方言与从前一样。
 */
function glslOwnContinue(s) {
  if (s === null || s === undefined) return false;
  if (s.k === 'continue') return true;
  if (s.k === 'block') return s.body.some((x) => glslOwnContinue(x));
  if (s.k === 'if') return glslOwnContinue(s.then) || glslOwnContinue(s.else);
  /* `switch` **要进去**：它接的是 `break`，不接 `continue` —— 里头的 continue 属于
   * 外面这一层循环。（`for`/`while`/`do while` 不进去：那些 continue 是它们自己的。） */
  if (s.k === 'switch') return s.groups.some((g) => g.body.some((x) => glslOwnContinue(x)));
  return false;
}

class GlslLowerer {
  constructor() {
    this.mod = null;
    /** 函数名前缀。**顶点与片元是两份源码，里头的辅助函数可以同名**
     * （两边各有一个 `sdCircle` 是很正常的事），并到一个方言模块里就撞了。
     * 于是顶点那一侧加一个前缀，片元那一侧不加（片元是主角，名字好看一点）。 */
    this.prefix = '';
    /* 导数那两格状态（见 `deriv()`）：探针调用要原样再递一遍的实参、以及站点编号。 */
    this.probeTail = '';
    this.derivN = 0;
    this.out = [];          // 顶层那几行
    this.structs = new Set();
    /** `out`/`inout` 形参那一族要的**专用返回结构体**（第二十五片）：字段类型不都是 real，
     * 所以不能借 `glsl_vN` 那几个（那几个每格都是 real）。一函数一个。 */
    this.outStructs = [];
    /** 正在降的这个函数的 out 上下文：`{ struct, retN, outs }`，没有 out 形参时是 null。 */
    this.outCtx = null;
    /** 名字 -> 函数信息（调用点要知道形参的方向）。 */
    this.fnByName = new Map();
    this.stmts = [];        // 当前正在攒的语句
    this.tmp = 0;
    this.names = new Map(); // 局部量名字的重名计数（见 uniq）
    this.scopes = [];       // 名字 -> 分量名数组
    /** 正在里头的那几层**方言循环**，最里的在最后。一项是 `{ kind }`：
     *
     *   `loop`    一层真的 GLSL 循环（`while` / `for` / `do while`）
     *   `wrap`    `for`/`do while` 给体外套的那一圈「只走一趟的 while」（`continue` 的落点）
     *   `switch`  `switch` 用来接 `break` 的那一圈（也是只走一趟）
     *
     * `break` 往外找最近的 `loop` 或 `switch`，`continue` 往外找最近的 `loop` 或 `wrap` ——
     * 数出来第几层就是方言的 `(brk N)` / `(cont N)`（第 40 刀那两条）。 */
    this.loops = [];
  }

  /** 往外数第几层（1 起）能碰到 `kinds` 里的一种；碰不到回 0。 */
  levelOf(kinds) {
    for (let i = this.loops.length - 1; i >= 0; i--) {
      if (kinds.includes(this.loops[i].kind)) return this.loops.length - i;
    }
    return 0;
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
    if (e.k === 'tex') {
      /* 纹理取样（规范 8.7）。数学在两个方言助手里（`GLSL_TEX_FNS`），这儿只把
       * 「采样器那三格（w/h/off）+ 坐标」递进去。采样器的名字在入口处绑的正是那三格。
       * 纹素数据是一格共用的 `(buf real)` 形参 —— 一个模块里所有采样器共用一片，
       * 各自的 `off` 区分（与快路那边 `%tex` 那一片的摆法一模一样）。 */
      const s = this.expr(e.args[0]);
      const c = this.expr(e.args[1]);
      this.need(4);
      const r = this.fresh('tx');
      const call = c.length === 1
        ? `(call glsl_tex1d (var glsl_texbuf) ${s[0]} ${s[2]} ${c[0]})`
        : `(call glsl_tex2d (var glsl_texbuf) ${s[0]} ${s[1]} ${s[2]} ${c[0]} ${c[1]})`;
      this.stmts.push(`(let ${r} ${glslStructName(4)} ${call})`);
      const out = [];
      for (let i = 0; i < 4; i++) out.push(this.let_('real', `(fld (var ${r}) c${i})`));
      return out;
    }
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
      const subj = this.expr(e.of);
      const to = glslCompTy(e.ty);
      const from = glslCompTy(e.of.ty);
      if (to === from) return subj;
      const op = to === 'real' ? 'toreal' : 'toint';
      return subj.map((c) => this.let_(to, `(${op} ${c})`));
    }
    if (e.k === 'splat') {
      /* 局部量**不能叫 `of`** —— 那是自编译子集词法里的关键字（`for … of`）。
       * 节点属性叫 `e.of` 没关系，受限的只有绑定名。 */
      const subj = this.expr(e.of)[0];
      const n = glslNComp(e.ty);
      const v = this.let_(glslCompTy(e.ty), subj);
      const out = [];
      if (e.ty.k === 'mat') {
        /* `matN(x)` 是**对角线**填 x、其余 0（规范 5.4.2），不是每格都填 x。
         * 这一格填错的话 `mat2(1.0)` 会变成「四个 1」——那不是单位阵。
         * 非方阵也是同一条：`mat2x3(1.0)` 的对角是 (0,0) 与 (1,1)，第三行全 0。 */
        for (let col = 0; col < e.ty.cols; col++) {
          for (let row = 0; row < e.ty.rows; row++) out.push(col === row ? v : '(real 0.0)');
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
      const subj = this.expr(e.of);
      /* 分量已经各自是一个 `(var tN)`，所以重排不必再绑。 */
      return e.idx.map((ix) => subj[ix]);
    }
    if (e.k === 'field') {
      /* 结构体的成员（施工图 B13）：分量表里连着的那一段 —— 起始格号由检查那一侧算好
       * 放在 `at` 上（`glslCount` 与这边的 `glslNComp` 是同一个公式）。
       * 与 `matcol` 是同一个套路：切片，不必再绑。
       *
       * 构造那一条不用改：它本来就是「按源码次序把实参的分量摊平接起来」，
       * 而结构体的构造正好是一个实参对一个成员。 */
      const subj = this.expr(e.of);
      return subj.slice(e.at, e.at + glslNComp(e.ty));
    }
    if (e.k === 'matcol') {
      /* `m[col]`：矩阵是**列优先**摊平的（`mat2(a,b,c,d)` = 第 0 列 (a,b)、第 1 列 (c,d)），
       * 所以第 col 列就是分量表里连着的那 `rows` 格 —— 下标 `col*rows .. +rows-1`。
       * 与 `matBin` 里那条 `col*rows + row` 是同一个公式（规范 5.6）。 */
      const subj = this.expr(e.of);
      const rows = e.of.ty.rows;
      return subj.slice(e.col * rows, e.col * rows + rows);
    }
    if (e.k === 'aindex') {
      /* 数组取一格（B14）。**常量下标就是切片**，与 `matcol`／`field` 一个样。 */
      const subj = this.expr(e.of);
      const w = glslNComp(e.ty);
      if (e.at.k === 'lit') return subj.slice(e.at.v * w, e.at.v * w + w);
      return this.dynIndex(subj, w, e);
    }
    if (e.k === 'neg') {
      const a = this.expr(e.a);
      return a.map((c) => this.let_(glslCompTy(e.ty), `(un "-" ${c})`));
    }
    if (e.k === 'not') {
      const a = this.expr(e.a);
      return [this.let_('bool', `(un "!" ${a[0]})`)];
    }
    if (e.k === 'bnot') {
      /* 方言里没有一元 `~`，用 `x ^ -1` —— 二补数下两者逐位相同。
       * 不必再截 32 位：`~x = -x-1`，x 在 int32 范围里时结果也在范围里。 */
      const a = this.expr(e.a);
      return a.map((c) => this.let_('int', `(bin "^" ${c} (un "-" (int 1)))`));
    }
    if (e.k === 'bin') return this.bin(e);
    if (e.k === 'comma') {
      /* 逗号：左边**照样降**（副作用要留下：`i++, j` 里的自增是要发生的），值丢掉。 */
      this.expr(e.a);
      return this.expr(e.b);
    }

    if (e.k === 'builtin') return this.builtin(e);
    if (e.k === 'bits') {
      /* 位转换（规范 8.4）：逐格走方言的位重解释（ADR-0019 路 1）。
       *
       * **这一层是 64 位的**，不是规范说的 32 位 —— 参照腿的 `real` 是 f64。理由与
       * 「两张参考图对着两种宽度」那一条一起写在 `check.js` 的调用处。 */
      const a = this.expr(e.args[0]);
      const op = e.name === 'floatBitsToInt' ? 'realbits' : 'bitsreal';
      const ct = e.name === 'floatBitsToInt' ? 'int' : 'real';
      return a.map((c) => this.let_(ct, `(${op} ${c})`));
    }
    if (e.k === 'call') return this.call(e);
    if (e.k === 'sel') return this.sel(e);
    if (e.k === 'assign') return this.assign(e);
    if (e.k === 'incdec') return this.incdec(e);
    throw new OmniError(`glsl: 降不了的表达式 ${e.k}`);
  }

  bin(e) {
    if (e.a.ty.k === 'mat' || e.b.ty.k === 'mat') return this.matBin(e);
    /* 短路那两个要在**算右边之前**接住：下面两行一执行，右边的中间量就已经落进外层
     * 语句流了 —— 那就是「两边都算」，正是短路要避免的。 */
    if (e.op === '&&' || e.op === '||') return this.andor(e);
    const a = this.expr(e.a);
    const b = this.expr(e.b);
    const ct = glslCompTy(e.ty);
    if (e.op === '^^') {
      /* 逻辑异或（GLSL 有，C 没有）。bool 上 `a != b` 就是它，而且不涉及短路。 */
      return [this.let_('bool', `(bin "!=" ${a[0]} ${b[0]})`)];
    }
    if (e.op === '==' || e.op === '!=' || e.op === '<' || e.op === '>'
      || e.op === '<=' || e.op === '>=') {
      if (a.length === 1 && b.length === 1) {
        return [this.let_('bool', `(bin "${e.op}" ${a[0]} ${b[0]})`)];
      }
      /* 整个向量比：`==` 是「每一格都等」、`!=` 是「有一格不等」（规范 5.9 —— 回的是
       * **一个** bool，不是掩码；逐格出掩码的是 `equal`/`notEqual` 那一族）。
       * 折起来用 `&&`/`||`：两边都是算好的 `(var …)`，短路与否看不出差别。 */
      if (e.op !== '==' && e.op !== '!=') glslNyi('向量上的大小比较（要用 lessThan 那一族）');
      if (a.length !== b.length) throw new OmniError('glsl: 比较的两个向量宽度不一样');
      const fold = e.op === '==' ? '&&' : '||';
      let acc = null;
      for (let i = 0; i < a.length; i++) {
        const one = this.let_('bool', `(bin "${e.op}" ${a[i]} ${b[i]})`);
        acc = acc === null ? one : this.let_('bool', `(bin "${fold}" ${acc} ${one})`);
      }
      return [acc];
    }
    /* 算术与位运算：同型逐格、标量铺开。`%` 在 GLSL 里只对 int，方言的 `%` 也是。
     *
     * **`<<` 要截回 32 位**：GLSL 的 `int` 是 32 位二补数，方言的 `int` 是 64 位 ——
     * `1 << 31` 在方言里是 2147483648，在 GL 上是 -2147483648。`(x << 32) >> 32`
     * 那一手在三条腿上量过，都是算术右移（JS 的 BigInt、C 的 int64_t、LLVM 的 ashr）。
     * `& | ^ >>` 不必截：它们在 int32 范围里是闭的。`+ - *` 的溢出回绕**还没做** ——
     * 那一格在 ADR-0019 的施工图里单列（要连着 `uint` 一起做）。 */
    const n = Math.max(a.length, b.length);
    const out = [];
    for (let i = 0; i < n; i++) {
      const x = a.length === 1 ? a[0] : a[i];
      const y = b.length === 1 ? b[0] : b[i];
      const v = `(bin "${e.op}" ${x} ${y})`;
      out.push(this.let_(ct, e.op === '<<' ? `(bin ">>" (bin "<<" ${v} (int 32)) (int 32))` : v));
    }
    return out;
  }

  /**
   * `a && b` / `a || b` —— **短路**（规范 5.9）。落法：左边算出来存一个格子，
   * 右边**整段**（连它的中间量一起）搬进一个 `if`，只有该算的时候才算：
   *
   *   a && b -> (let m bool A) (if (var m)        (do …B 的中间量… (set m B)))
   *   a || b -> (let m bool A) (if (un "!" (var m)) (do …B 的中间量… (set m B)))
   *
   * 为什么非得短路：`x != 0.0 && 1.0/x > 2.0` 在 GLSL 里是**安全**写法，改成两边都算
   * 就会在 x=0 那一格上算出 Inf。这与 `sel()` 是同一件事的同一种落法。
   *
   * 快路（`emit_llvm.js`）那条**没得选**：8 道里两支都可能要走，所以它两边都算、
   * 靠 `select` 逐道取值挡住。两条路的语义差别只在「不该走的那支有没有副作用」上，
   * 而 GLSL 的表达式里没有副作用能逃出这一层（赋值与自增都是语句化过的）。
   */
  andor(e) {
    const m = this.fresh('m');
    const a = this.expr(e.a)[0];
    this.stmts.push(`(let ${m} bool ${a})`);
    const save = this.stmts;
    this.stmts = [];
    const b = this.expr(e.b)[0];
    this.stmts.push(`(set ${m} ${b})`);
    const body = this.stmts;
    this.stmts = save;
    const cond = e.op === '&&' ? `(var ${m})` : `(un "!" (var ${m}))`;
    this.stmts.push(`(if ${cond} (do ${body.join(' ')}))`);
    return [`(var ${m})`];
  }

  /**
   * 三元 `c ? a : b`。**两支各自的中间量要留在自己那一支里** ——   * GLSL 的 `? :` 只算一支（规范 5.9），把两支的 `let` 都提到 if 外面就变成两支都算了。
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
    /* `matCxR * vecC`：结果第 row 格 = Σ_col m[col][row] * v[col]，长度是**行数**。 */
    if (ta.k === 'mat' && tb.k === 'vec') {
      const out = [];
      for (let row = 0; row < ta.rows; row++) {
        const xs = [];
        for (let col = 0; col < ta.cols; col++) xs.push(a[col * ta.rows + row]);
        out.push(dot(xs, b));
      }
      return out;
    }
    /* `vecR * matCxR`：结果第 col 格 = dot(v, 第 col 列)，长度是**列数**。 */
    if (ta.k === 'vec' && tb.k === 'mat') {
      const out = [];
      for (let col = 0; col < tb.cols; col++) {
        const ys = [];
        for (let row = 0; row < tb.rows; row++) ys.push(b[col * tb.rows + row]);
        out.push(dot(a, ys));
      }
      return out;
    }
    /* `matAxB * matCxD`（要 A == D）：出 `matCxB`，第 col 列 = a × (b 的第 col 列)。 */
    if (ta.k === 'mat' && tb.k === 'mat') {
      const out = [];
      for (let col = 0; col < tb.cols; col++) {
        for (let row = 0; row < ta.rows; row++) {
          const xs = [];
          const ys = [];
          for (let k = 0; k < ta.cols; k++) {
            xs.push(a[k * ta.rows + row]);
            ys.push(b[col * tb.rows + k]);
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

  /**
   * `determinant` 与 `inverse`（规范 8.5，只对方阵）。两个共用一段：
   * 都是**按余子式展开**，2/3/4 阶不写三份公式。
   *
   * 摊平是列优先，所以 `A(row, col) = m[col*n + row]`。
   *
   *   det(A)      = Σ_col (-1)^col · A(0,col) · det(去掉第 0 行与第 col 列)
   *   A⁻¹(row,col) = (-1)^(row+col) · det(去掉第 col 行与第 row 列) / det(A)
   *
   * 第二条是「伴随矩阵的转置除以行列式」那一句话的下标形式 —— 转置那一格容易写反，
   * 所以门里查的是 `m * inverse(m) == 单位阵`，不是某个数（写反了单位阵就不对）。
   */
  matDetInv(name, m, n) {
    const ct = 'real';
    const A = (row, col) => m[col * n + row];
    /* 递归的余子式行列式：`rows`/`cols` 是还留着的下标。 */
    const det = (rows, cols) => {
      if (rows.length === 1) return A(rows[0], cols[0]);
      let sum = null;
      for (let i = 0; i < cols.length; i++) {
        /* 闭包捕的必须是**体内的一个 const**，不是循环变量本身：JS 的 `let` 每轮一个新
         * 绑定，C 那边不是 —— 自编译那侧按这条骂，而且骂得对。 */
        const ci = i;
        const sub = det(rows.slice(1), cols.filter((_, j) => j !== ci));
        const p = this.let_(ct, `(bin "*" ${A(rows[0], cols[ci])} ${sub})`);
        const signed = ci % 2 === 0 ? p : this.let_(ct, `(un "-" ${p})`);
        sum = sum === null ? signed : this.let_(ct, `(bin "+" ${sum} ${signed})`);
      }
      return sum;
    };
    const all = [];
    for (let i = 0; i < n; i++) all.push(i);
    const d = det(all, all);
    if (name === 'determinant') return [d];
    const out = [];
    for (let col = 0; col < n; col++) {
      for (let row = 0; row < n; row++) {
        const cc = col;
        const rr = row;
        const minor = det(all.filter((r) => r !== cc), all.filter((c) => c !== rr));
        const signed = (rr + cc) % 2 === 0 ? minor : this.let_(ct, `(un "-" ${minor})`);
        out.push(this.let_(ct, `(bin "/" ${signed} ${d})`));
      }
    }
    return out;
  }

  /**
   * 一格导数（规范 8.9）：`dFdx` / `dFdy` / `fwidth` 的**一个分量**。
   *
   * 这一腿是一个像素一趟的标量代码，邻居的值拿不到 —— 所以办法是**再跑一趟这个着色器**：
   * 入口多两个形参（`quad_x`/`quad_y`：这个像素所在 2×2 quad 左下那格的中心坐标）
   * 加一个 `probe`（要探第几处导数的操作数，`-1` 是真跑那一趟）。真跑那一趟走到第 k 处
   * 导数时，用 `(quad_x+1, frag_y)` 与 `(quad_x, frag_y)` 各调一次自己（`probe = k`）；
   * 被调那一趟走到第 k 处就把操作数的值放进 `glsl_probe` 那一格全局，差一下就是 `dFdx`。
   * `dFdy` 同理，换成 `(frag_x, quad_y+1)` 与 `(frag_x, quad_y)`。
   *
   * 与快路对得上的两点（那边是一次 `shufflevector`，见 emit_llvm.js 的道号表）：
   *   - 取的是 **fine** 那一档：x 方向用自己那一行（`frag_y` 不动）、y 方向用自己那一列；
   *   - 差的是**quad 的两列 / 两行**，不是"自己与右边一个"。所以同一个 quad 里左右两个
   *     像素拿到的是同一个值 —— 那正是 quad 的语义，也是快路 shuffle 出来的东西。
   *
   * 代价：一处导数两次（`fwidth` 四次）整份着色器重跑。这一腿是**尺子**不是性能路径，
   * 那笔账认了；快路那边一次 shuffle。
   * 嵌套导数（探针那一趟里又遇到导数）回 0 —— 规范里那本来就是未定义的。
   */
  deriv(name, comp) {
    if (this.mod.ins.length > 0) {
      glslNyi('导数 + varying（插值在入口外头，探针那一趟拿不到邻居的插值结果）');
    }
    const k = this.derivN;
    this.derivN = this.derivN + 1;
    const d = this.fresh('dd');
    this.stmts.push(`(let ${d} real (real 0.0))`);
    /* 探针那一趟：走到这一处就把操作数放进那一格全局。 */
    this.stmts.push(`(if (bin "==" (var probe) (int ${k})) (do (set glsl_probe ${comp})))`);
    const call = (x, y) => `(expr (call glsl_frag ${x} ${y} ${this.probeTail} (int ${k})))`;
    const qxR = '(bin "+" (var quad_x) (real 1.0))';
    const qyU = '(bin "+" (var quad_y) (real 1.0))';
    const body = [];
    const dx = this.fresh('px');
    const dy = this.fresh('py');
    if (name === 'dFdx' || name === 'fwidth') {
      body.push(call(qxR, '(var frag_y)'));
      body.push(`(let ${dx} real (var glsl_probe))`);
      body.push(call('(var quad_x)', '(var frag_y)'));
      body.push(`(set ${dx} (bin "-" (var ${dx}) (var glsl_probe)))`);
    }
    if (name === 'dFdy' || name === 'fwidth') {
      body.push(call('(var frag_x)', qyU));
      body.push(`(let ${dy} real (var glsl_probe))`);
      body.push(call('(var frag_x)', '(var quad_y)'));
      body.push(`(set ${dy} (bin "-" (var ${dy}) (var glsl_probe)))`);
    }
    if (name === 'dFdx') body.push(`(set ${d} (var ${dx}))`);
    else if (name === 'dFdy') body.push(`(set ${d} (var ${dy}))`);
    else {
      body.push(`(set ${d} (bin "+" (rmath "fabs" (var ${dx})) (rmath "fabs" (var ${dy}))))`);
    }
    this.stmts.push(`(if (bin "<" (var probe) (int 0)) (do ${body.join(' ')}))`);
    return `(var ${d})`;
  }

  builtin(e) {
    const name = e.name;
    const ct = 'real';
    const args = e.args.map((a) => this.expr(a));
    /* `Math.max(...xs)` 的展开自编译子集不收 —— 显式取最大。 */
    let wide = 0;
    for (const a of args) if (a.length > wide) wide = a.length;
    /* `at` 的两个形参**刻意不叫 `k`/`i`**：自编译那侧「闭包捕获循环变量」那条检查是按
     * **函数**粒度 + 按名字判的，箭头里出现 `i` 就会把这个函数里所有 `for (let i …)`
     * 一起骂（量过：`emit_llvm.js` 里改个名字，14 条错变 2 条）。错开就没这回事。 */
    const at = (ak, ai) => (args[ak].length === 1 ? args[ak][0] : args[ak][ai]);
    /* 导数那三条（规范 8.9）。这一腿是**一个像素一趟的标量代码**，所以邻居的值只能
     * "再跑一趟着色器"拿 —— 这一格就是那个探针（`glslDeriv`）。
     * 为什么不能像快路那样一次 shuffle：那边一批 8 道本来就是两个 quad，邻居在同一批里。 */
    if (name === 'dFdx' || name === 'dFdy' || name === 'fwidth') {
      const out = [];
      for (let i = 0; i < wide; i++) out.push(this.deriv(name, at(0, i)));
      return out;
    }
    /* 向量比较那一族（规范 8.6）。这一层的向量是**摊成分量**的，所以「逐格比出一串 bool」
     * 就是它 —— 不需要方言有掩码类型。`all`/`any` 用 `&&`/`||` 把那串折起来：
     * 两边都是已经算好的 `(var …)`，短路与否看不出差别（GLSL 那两个算符在这一层
     * 仍然是明着骂的，因为源码里的右边可能带副作用）。 */
    const cmp = GLSL_VEC_CMP_OP.get(name);
    if (cmp !== undefined) {
      const out = [];
      for (let i = 0; i < wide; i++) out.push(this.let_('bool', `(bin "${cmp}" ${at(0, i)} ${at(1, i)})`));
      return out;
    }
    if (name === 'all' || name === 'any') {
      const op = name === 'all' ? '&&' : '||';
      let acc = null;
      for (const c of args[0]) acc = acc === null ? c : this.let_('bool', `(bin "${op}" ${acc} ${c})`);
      return [acc === null ? '(bool true)' : acc];
    }
    if (name === 'not') {
      return args[0].map((c) => this.let_('bool', `(un "!" ${c})`));
    }
    /* `isnan`/`isinf`（规范 8.3）。两条都只用**已有的算符**，方言一个新算子都不加：
     *
     *   isnan(x) = x != x
     *   isinf(x) = x == x && (x - x) != 0
     *
     * 第二条的读法：有限数减自己是 0；±Inf 减自己是 NaN（`!= 0` 成立）；NaN 被前一半
     * 挡掉。**特意不写成 `|x| > 最大有限值`** —— 方言的 `real` 是 f64、GLSL 的 highp
     * float 是 f32，那个阈值在两种宽度下不是同一个数，而上面这两条在任何宽度上都成立。
     *
     * 造 NaN/Inf 在语言里是直接可写的：**报错的只有整数除零**（`04_div_zero`），
     * 实数除零走 IEEE —— `1.0/0.0` 是 `inf`、`0.0/0.0` 是 `nan`，三条腿量过都一样。
     * （这一段的第一版写的是「方言造不出它们」，那句是错的。） */
    if (name === 'isnan') {
      return args[0].map((c) => this.let_('bool', `(bin "!=" ${c} ${c})`));
    }
    if (name === 'isinf') {
      return args[0].map((c) => {
        const d = this.let_(ct, `(bin "-" ${c} ${c})`);
        const ord = this.let_('bool', `(bin "==" ${c} ${c})`);
        const nz = this.let_('bool', `(bin "!=" ${d} (real 0.0))`);
        return this.let_('bool', `(bin "&&" ${ord} ${nz})`);
      });
    }
    const rm = GLSL_RMATH.get(name);
    if (rm !== undefined && !(name === 'atan' && args.length === 2)) {
      const out = [];
      for (let i = 0; i < wide; i++) {
        /* 这儿刻意**不写** `args.map((_, k) => at(k, i))`：那是**真**捕获了 `for` 的循环
         * 变量（JS 的 `let` 每轮一个新绑定，C 那边不是），自编译那侧骂得对。显式循环取。 */
        const lane = [];
        for (let k = 0; k < args.length; k++) lane.push(at(k, i));
        out.push(this.let_(ct, `(rmath "${rm}" ${lane.join(' ')})`));
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
    /* ---- 第二十三片：8.1/8.3 剩下的标量几条 + 8.4 几何三条 + 8.5 矩阵五条 ---- */
    if (name === 'atan' && args.length === 2) {
      /* `atan(y, x)` 是**两参**那一支（规范 8.1），落到 `atan2`。
       * 从前这儿把它当一参的 `atan` 发出去，方言当场骂「要 1 个参数」——
       * 也就是说 `atan(y,x)` 一直是坏的，这一片才修上。 */
      const out = [];
      for (let i = 0; i < wide; i++) out.push(this.let_(ct, `(rmath "atan2" ${at(0, i)} ${at(1, i)})`));
      return out;
    }
    if (name === 'exp2' || name === 'log2') {
      /* 方言的 rmath 没有这两个（名单是「libm 与 Math.* 的交集里必然一致的那些」）。
       * `exp2(x) = pow(2, x)`；`log2(x) = log(x) * (1/ln2)` —— 后者是各家 GLSL
       * 实现常见的落法，不是我们自己发明的近似。 */
      return args[0].map((c) => (name === 'exp2'
        ? this.let_(ct, `(rmath "pow" (real 2.0) ${c})`)
        : this.let_(ct, `(bin "*" (rmath "log" ${c}) (real 1.4426950408889634))`)));
    }
    if (name === 'trunc') {
      /* 8.3：往**零**的方向截。`floor` 对负数是往下取，所以要分符号。 */
      const out = [];
      for (const c of args[0]) {
        const nm = this.fresh('tr');
        this.stmts.push(`(let ${nm} real (rmath "floor" ${c}))`);
        this.stmts.push(`(if (bin "<" ${c} (real 0.0)) (do (set ${nm} (rmath "ceil" ${c}))))`);
        out.push(`(var ${nm})`);
      }
      return out;
    }
    if (name === 'roundEven') {
      /* 8.3：`roundEven` 是「一半的时候取偶」，与 C 的 `round`（一半往远离零）**不同**。
       * 落法：f = x - floor(x)；f > 0.5 进位、f < 0.5 舍去、正好 0.5 时取偶。 */
      const out = [];
      for (const c of args[0]) {
        const fl = this.let_(ct, `(rmath "floor" ${c})`);
        const f = this.let_(ct, `(bin "-" ${c} ${fl})`);
        const nm = this.fresh('re');
        this.stmts.push(`(let ${nm} real ${fl})`);
        this.stmts.push(`(if (bin ">" ${f} (real 0.5)) (do (set ${nm} (bin "+" ${fl} (real 1.0)))))`);
        /* 正好 0.5：`floor` 是奇数就再进一格（`fmod(floor, 2) != 0`）。 */
        const half = this.let_('bool', `(bin "==" ${f} (real 0.5))`);
        const odd = this.let_('bool', `(bin "!=" (rmath "fmod" ${fl} (real 2.0)) (real 0.0))`);
        this.stmts.push(`(if (bin "&&" ${half} ${odd}) (do (set ${nm} (bin "+" ${fl} (real 1.0)))))`);
        out.push(`(var ${nm})`);
      }
      return out;
    }
    if (name === 'reflect') {
      /* 8.4：`I - 2 * dot(N, I) * N`。 */
      const I = args[0];
      const N = args[1];
      let d = null;
      for (let i = 0; i < I.length; i++) {
        const p = this.let_(ct, `(bin "*" ${N[i]} ${I[i]})`);
        d = d === null ? p : this.let_(ct, `(bin "+" ${d} ${p})`);
      }
      const two = this.let_(ct, `(bin "*" (real 2.0) ${d})`);
      return I.map((c, ix) => {
        const s = this.let_(ct, `(bin "*" ${two} ${N[ix]})`);
        return this.let_(ct, `(bin "-" ${c} ${s})`);
      });
    }
    if (name === 'refract') {
      /* 8.4 逐字：k = 1 - eta² (1 - dot(N,I)²)；k < 0 回全 0，否则
       * `eta * I - (eta * dot(N,I) + sqrt(k)) * N`。 */
      const I = args[0];
      const N = args[1];
      const eta = args[2][0];
      let d = null;
      for (let i = 0; i < I.length; i++) {
        const p = this.let_(ct, `(bin "*" ${N[i]} ${I[i]})`);
        d = d === null ? p : this.let_(ct, `(bin "+" ${d} ${p})`);
      }
      const dd = this.let_(ct, `(bin "*" ${d} ${d})`);
      const one = this.let_(ct, `(bin "-" (real 1.0) ${dd})`);
      const e2 = this.let_(ct, `(bin "*" ${eta} ${eta})`);
      const k = this.let_(ct, `(bin "-" (real 1.0) (bin "*" ${e2} ${one}))`);
      const neg = this.let_('bool', `(bin "<" ${k} (real 0.0))`);
      const out = [];
      for (let i = 0; i < I.length; i++) {
        const nm = this.fresh('rf');
        const ei = this.let_(ct, `(bin "*" ${eta} ${I[i]})`);
        const ed = this.let_(ct, `(bin "*" ${eta} ${d})`);
        const sk = this.let_(ct, `(rmath "sqrt" ${k})`);
        const coef = this.let_(ct, `(bin "+" ${ed} ${sk})`);
        const sub = this.let_(ct, `(bin "*" ${coef} ${N[i]})`);
        this.stmts.push(`(let ${nm} real (bin "-" ${ei} ${sub}))`);
        this.stmts.push(`(if ${neg} (do (set ${nm} (real 0.0))))`);
        out.push(`(var ${nm})`);
      }
      return out;
    }
    if (name === 'faceforward') {
      /* 8.4：`dot(Nref, I) < 0 ? N : -N`。 */
      const N = args[0];
      const I = args[1];
      const Nref = args[2];
      let d = null;
      for (let i = 0; i < I.length; i++) {
        const p = this.let_(ct, `(bin "*" ${Nref[i]} ${I[i]})`);
        d = d === null ? p : this.let_(ct, `(bin "+" ${d} ${p})`);
      }
      const lt = this.let_('bool', `(bin "<" ${d} (real 0.0))`);
      const out = [];
      for (let i = 0; i < N.length; i++) {
        const nm = this.fresh('ff');
        this.stmts.push(`(let ${nm} real (un "-" ${N[i]}))`);
        this.stmts.push(`(if ${lt} (do (set ${nm} ${N[i]})))`);
        out.push(`(var ${nm})`);
      }
      return out;
    }
    if (name === 'matrixCompMult') {
      /* 8.5：**逐格**乘，不是矩阵乘。摊平之后就是两串一格一格乘起来。 */
      return args[0].map((c, ix) => this.let_(ct, `(bin "*" ${c} ${args[1][ix]})`));
    }
    if (name === 'outerProduct') {
      /* 8.5：`c` 长 R、`r` 长 C，结果是 `matCxR`，第 col 列 = c * r[col]（列优先摊平）。 */
      const c = args[0];
      const r = args[1];
      const out = [];
      for (let col = 0; col < r.length; col++) {
        for (let row = 0; row < c.length; row++) out.push(this.let_(ct, `(bin "*" ${c[row]} ${r[col]})`));
      }
      return out;
    }
    if (name === 'transpose') {
      /* 8.5：`matCxR` -> `matRxC`。摊平之后就是换一个下标次序，一次乘法都不用。 */
      const m = args[0];
      const cols = e.args[0].ty.cols;
      const rows = e.args[0].ty.rows;
      const out = [];
      for (let col = 0; col < rows; col++) {
        for (let row = 0; row < cols; row++) out.push(m[row * rows + col]);
      }
      return out;
    }
    if (name === 'determinant' || name === 'inverse') {
      return this.matDetInv(name, args[0], e.args[0].ty.cols);
    }
    glslNyi(`内建 ${name}`);
    return [];
  }

  call(e) {
    const f = this.fnByName.get(e.name);
    const hasOut = f !== undefined && f.params.some((p) => p.dir !== 'in');
    if (hasOut) return this.callWithOut(e, f);
    const args = [];
    for (const a of e.args) for (const c of this.expr(a)) args.push(c);
    const callTxt = `(call glsl_${this.prefix}${e.name} ${args.join(' ')})`;
    /* **void 的函数**：没有值，所以它是一条语句，不是一个中间量。方言里语句位的表达式
     * 是 `(expr E)` 那一条。少这一格的时候，`glslCompTy(void)` 当场骂"降不了的分量类型
     * void" —— 而 vispy 那种 `void clip(...)`（里头 discard）正是这一档。
     * 快路上没有这个坑：那边函数是**内联**的，压根没有"调用的类型"这回事。 */
    if (e.ty.k === 'void') {
      this.stmts.push(`(expr ${callTxt})`);
      return [];
    }
    const n = glslNComp(e.ty);
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

  /**
   * 调一个带 `out`/`inout` 形参的函数（第二十五片）。三步：
   *
   *   1. 递进去的只有 `in` 与 `inout` 那些格（`out` 不递 —— 它在被调那头从零起）
   *   2. 接住那个专用结构体
   *   3. **写回去**：out 那几格按声明次序对上实参的分量，逐格 `set`
   *
   * 写回发生在**调用返回之后**，所以 `f(x, x)` 那种「同一个变量递给两个 out」的次序
   * 与 GLSL 的 copy-out 一致（后写的赢）。实参必须是左值 —— 那一条在检查那侧拦。
   */
  callWithOut(e, f) {
    const args = [];
    const backs = [];
    e.args.forEach((a, ax) => {
      const p = f.params[ax];
      const comps = this.expr(a);
      if (p.dir === 'in' || p.dir === 'inout') for (const c of comps) args.push(c);
      if (p.dir !== 'in') {
        /* 写回的落点：`ref` 就是那几个变量名，`swizzle` 是挑出来的那几格。 */
        const target = a.k === 'ref' ? this.find(a.name)
          : a.k === 'swizzle' ? this.swizzleTarget(a) : null;
        if (target === null) throw new OmniError(`glsl: ${e.name} 的第 ${ax + 1} 个实参不是左值`);
        for (const t of target) backs.push(t);
      }
    });
    const retN = e.ty.k === 'void' ? 0 : glslNComp(e.ty);
    const sn = `glsl_r_${this.prefix}${e.name}`;
    const s = this.fresh('ro');
    this.stmts.push(`(let ${s} ${sn} (call glsl_${this.prefix}${e.name} ${args.join(' ')}))`);
    const out = [];
    for (let i = 0; i < retN; i++) {
      out.push(this.let_(glslCompTy(e.ty), `(fld (var ${s}) c${i})`));
    }
    backs.forEach((t, k) => {
      this.stmts.push(`(set ${glslVarName(t)} (fld (var ${s}) c${retN + k}))`);
    });
    return out;
  }

  /**
   * 数组的**变量**下标（B14）。摊平模型里没有内存，所以取一格落成「n 条 `if`」：
   *
   *   (let a0 real 0.0) (let a1 real 0.0)          ← 元素有几格就几个格子
   *   (if (== idx 0) (do (set a0 s_0) (set a1 s_1)))
   *   (if (== idx 1) (do (set a0 s_2) (set a1 s_3)))
   *   …
   *
   * 为什么是 `if` + `set` 而不是「表达式级的 select」：方言里没有表达式级条件，
   * `sign`/`trunc`/`refract` 那几个内建也都是这个手法。**快路**那一层才落成掩码 + select
   * （SoA 下八个像素的 idx 不一样，不能分支）—— 两边的答案一样，形状不一样。
   *
   * 下标越界时一格都不写：读出来是 0，而不是读到别人的格子。GLSL 规范里越界是未定义，
   * 这个选择的好处是**可复现**（三条腿都给 0），坏处是与真 GL 上的垃圾值不同 ——
   * 而拿垃圾值比像素本来就没意义。
   */
  dynIndex(subj, w, e) {
    const idx = this.expr(e.at)[0];
    const cts = glslCompTys(e.ty);
    const n = e.of.ty.n;
    const names = [];
    for (let j = 0; j < w; j++) {
      const nm = this.fresh('ai');
      this.stmts.push(`(let ${nm} ${cts[j]} ${glslZero(cts[j])})`);
      names.push(nm);
    }
    for (let k = 0; k < n; k++) {
      const sets = [];
      for (let j = 0; j < w; j++) sets.push(`(set ${names[j]} ${subj[k * w + j]})`);
      this.stmts.push(`(if (bin "==" ${idx} (int ${k})) (do ${sets.join(' ')}))`);
    }
    const out = [];
    for (const nm of names) out.push(`(var ${nm})`);
    return out;
  }

  assign(e) {
    const lhs = e.lhs;
    /* 数组的**变量**下标没有静态落点 —— 那条路要按元素逐个 `if` 地写回去。
     * `s[i] = v` 与 `m[cnt - 1].y = v` 都在里面（后者是 swizzle 套在 aindex 上）。 */
    if (this.isDynLhs(lhs)) return this.dynAssign(e);
    const target = lhs.k === 'ref' ? this.find(lhs.name)
      : lhs.k === 'swizzle' ? this.swizzleTarget(lhs)
        : lhs.k === 'aindex' ? this.constIndexTarget(lhs) : null;
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

  /** 左边是「数组 + 变量下标」吗（自己是，或者 swizzle 的底是）。 */
  isDynLhs(lhs) {
    if (lhs.k === 'aindex') return lhs.at.k !== 'lit';
    if (lhs.k === 'swizzle' && lhs.of.k === 'aindex') return lhs.of.at.k !== 'lit';
    return false;
  }

  /** `s[K] = …`（K 是常量）的左边：分量表里连着的那 w 格。 */
  constIndexTarget(lhs) {
    if (lhs.of.k !== 'ref') throw new OmniError('glsl: 数组左值的底必须是一个名字');
    const base = this.find(lhs.of.name);
    const w = glslNComp(lhs.ty);
    return base.slice(lhs.at.v * w, lhs.at.v * w + w);
  }

  /**
   * `s[i] = v` / `m[i].y = v`（i 是算出来的）。落成 n 条 `if`，每条把值写进那一个元素。
   * 越界时哪条都不成立，于是一格都不改 —— 与 `dynIndex` 读那一侧是同一个选择。
   */
  dynAssign(e) {
    const lhs = e.lhs;
    const ai = lhs.k === 'aindex' ? lhs : lhs.of;
    if (ai.of.k !== 'ref') throw new OmniError('glsl: 数组左值的底必须是一个名字');
    const base = this.find(ai.of.name);
    const w = glslNComp(ai.ty);
    const lanes = [];
    if (lhs.k === 'aindex') for (let j = 0; j < w; j++) lanes.push(j);
    else for (const ix of lhs.idx) lanes.push(ix);
    /* 下标先算（源码次序：左边在右边之前），再算右边。 */
    const idx = this.expr(ai.at)[0];
    let vals;
    if (e.op === '=') vals = this.expr(e.rhs);
    else vals = this.bin({ k: 'bin', ty: e.ty, op: e.op, a: lhs, b: e.rhs });
    const n = ai.of.ty.n;
    for (let k = 0; k < n; k++) {
      const sets = [];
      for (let li = 0; li < lanes.length; li++) {
        const v = vals.length === 1 ? vals[0] : vals[li];
        sets.push(`(set ${glslVarName(base[k * w + lanes[li]])} ${v})`);
      }
      this.stmts.push(`(if (bin "==" ${idx} (int ${k})) (do ${sets.join(' ')}))`);
    }
    return vals;
  }

  /** `v.xy = …` 的左边：回那几格**变量名**（顺序按 swizzle）。 */
  swizzleTarget(lhs) {
    /* 底可以是一个名字，也可以是「数组 + 常量下标」（`s[0].y = …`）。
     * 变量下标那一支不走这儿 —— 见 `isDynLhs`。 */
    const base = lhs.of.k === 'ref' ? this.find(lhs.of.name)
      : lhs.of.k === 'aindex' ? this.constIndexTarget(lhs.of) : null;
    if (base === null) throw new OmniError('glsl: swizzle 左值的底必须是一个名字');
    return lhs.idx.map((ix) => base[ix]);
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
    /* 一条声明里多个变量（B15）：就是几条 `decl` 挨着走。**不压作用域** ——
     * 那几个名字绑在当前这一层，跟单个声明一样。 */
    if (s.k === 'multi') {
      for (const d of s.list) this.stmt(d);
      return;
    }
    if (s.k === 'decl') {
      const n = glslNComp(s.ty);
      /* 按格取类型：结构体的分量类型不是一种（`glslCompTys` 上面那段）。 */
      const cts = glslCompTys(s.ty);
      const vals = s.init === null ? null : this.expr(s.init);
      const comps = [];
      const base = this.uniq(s.name);
      for (let i = 0; i < n; i++) {
        const name = `${base}_${i}`;
        const v = vals === null ? glslZero(cts[i]) : (vals.length === 1 ? vals[0] : vals[i]);
        this.stmts.push(`(let ${name} ${cts[i]} ${v})`);
        comps.push(`(var ${name})`);
      }
      this.bind(s.name, comps);
      return;
    }
    if (s.k === 'ret') {
      /* 带 out 形参的函数：返回值与 out 一起装进专用结构体（第二十五片）。 */
      if (this.outCtx !== null) {
        this.packRet(s.e === null ? null : this.expr(s.e));
        return;
      }
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
    if (s.k === 'discard') {
      /* `discard`（规范 6.4）：这一腿一个像素一趟、标量代码，所以它只是**一格模块级
       * bool**（`glsl_killed`）。为什么不当场 `(ret …)`：`discard` 常写在用户函数里
       * （vispy 的 `antialias/cap*.glsl` 就是），那里 `ret` 只出得了那个函数，出不了这个
       * 像素。设一格标志则不管写在多深都对：出图那一头见它是真就不写这个像素。
       * 设过之后后面照算 —— 不可观测（这个像素根本不写回），而快路那边是把那些道掩掉，
       * 两条腿的**输出**因此一模一样。 */
      this.stmts.push(this.mod.deriv === true
        ? '(if (bin "<" (var probe) (int 0)) (do (set glsl_killed (bool true))))'
        : '(set glsl_killed (bool true))');
      return;
    }
    if (s.k === 'for') {
      /* `for` 落成方言的 `while`：init 在前、step 在体尾。
       *
       * **`continue` 在这种展开里会跳过 step** —— 那是 C/GLSL 的 `for` 与
       * 「init + while + 体尾 step」之间真实存在的差别，直接落就是错的。
       * 办法是给体外套一圈**只走一趟**的 while：
       *
       *   (while COND (do (while (bool true) (do BODY (brk)))
       *                   STEP))
       *
       * 于是体里的 `continue` = 那一圈的 `(brk)`（跳到 step 前面，**step 照走**），
       * 体里的 `break` 要往外数两层 `(brk 2)`。只在**这一层的体里真有 continue** 时才套
       * （`glslOwnContinue`）—— 没有的话多一层 while 是白付的代价，而且降出来的方言
       * 会与从前不同（那会让一串门的字节对账无谓地动）。 */
      const wrapped = glslOwnContinue(s.body);
      this.push();
      this.stmt(s.init);
      const body = [];
      const outer = this.stmts;
      this.stmts = body;
      this.loops.push({ kind: 'loop' });
      if (wrapped) {
        this.loops.push({ kind: 'wrap' });
        const inner = this.sub(() => this.stmt(s.body));
        this.loops.pop();
        inner.push('(brk)');
        this.stmts.push(`(while (bool true) (do ${inner.join(' ')}))`);
      } else {
        this.stmt(s.body);
      }
      this.loops.pop();
      if (s.step !== null) this.expr(s.step);
      this.stmts = outer;
      const cond = s.c === null ? '(bool true)' : this.condIn(s.c, body);
      this.stmts.push(`(while ${cond} (do ${body.join(' ')}))`);
      this.pop();
      return;
    }
    if (s.k === 'break' || s.k === 'continue') {
      /* `break` 认最近的 `loop`/`switch`，`continue` 认最近的 `loop`/`wrap` ——
       * 数出来的层号直接就是方言的 `(brk N)` / `(cont N)`。第 1 层不写号，
       * 是为了让从前那些门降出来的方言一个字都不动。 */
      const n = s.k === 'break' ? this.levelOf(['loop', 'switch']) : this.levelOf(['loop', 'wrap']);
      if (n === 0) throw new OmniError(`glsl: '${s.k}' 不在循环里`);
      const inner = this.loops[this.loops.length - n];
      /* `continue` 落到套的那一圈上时是 `(brk)`：跳出内圈 = 跳到 step 前面。 */
      const head = s.k === 'break' || inner.kind === 'wrap' ? 'brk' : 'cont';
      this.stmts.push(n === 1 ? `(${head})` : `(${head} ${n})`);
      return;
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
      /* 条件每一轮都要重算，所以走 `condIn`（要求它降出来是一条表达式）。
       * `while` 不用套那一圈 —— 它没有 step，`continue` 直接是方言的 `(cont)`。 */
      this.loops.push({ kind: 'loop' });
      const body = this.sub(() => this.stmt(s.body));
      this.loops.pop();
      this.stmts.push(`(while ${this.condIn(s.c)} (do ${body.join(' ')}))`);
      return;
    }
    if (s.k === 'dowhile') {
      /* `do BODY while (C);` —— 方言里没有它，落成「永真的 while + 体尾判条件」：
       *
       *   (while (bool true) (do BODY  <C 的中间量>  (if (un "!" C) (do (brk)))))
       *
       * 条件那一段**摆在体尾**，所以它可以有中间量（不像 `while` 那条得挤成一条表达式）。
       * 体里有 `continue` 时照 `for` 那个办法套一圈只走一趟的 while：`continue` 要跳到
       * **判条件之前**，不是跳过判条件。 */
      const wrapped = glslOwnContinue(s.body);
      const body = [];
      const outer = this.stmts;
      this.stmts = body;
      this.loops.push({ kind: 'loop' });
      if (wrapped) {
        this.loops.push({ kind: 'wrap' });
        const inner = this.sub(() => this.stmt(s.body));
        this.loops.pop();
        inner.push('(brk)');
        this.stmts.push(`(while (bool true) (do ${inner.join(' ')}))`);
      } else {
        this.stmt(s.body);
      }
      const c = this.expr(s.c);
      if (c.length !== 1) throw new OmniError('glsl: do while 的条件不是一格');
      this.stmts.push(`(if (un "!" ${c[0]}) (do (brk)))`);
      this.loops.pop();
      this.stmts = outer;
      this.stmts.push(`(while (bool true) (do ${body.join(' ')}))`);
      return;
    }
    if (s.k === 'switch') return this.switchStmt(s);
    throw new OmniError(`glsl: 降不了的语句 ${s.k}`);
  }

  /**
   * `switch` -> 「只走一趟的 while + 一个匹配标志位」。
   *
   *   (while (bool true) (do
   *     <选择子>
   *     (let none bool (un "!" <任一标签命中>))    ;; 只有带 default 时才要
   *     (let m bool (bool false))
   *     (if (bin "||" (var m) <本组的标签命中>) (do (set m (bool true)) <本组的体>))
   *     …
   *     (brk)))
   *
   * 三件事一次落清：
   *
   *   - **穿落**靠 `m`：一组匹配上就置真，后面每组的条件都带一个 `(var m)`，
   *     于是从匹配的那一组起一直往下走 —— 与 C 的规矩一样。
   *   - **`break`** 就是那一圈的 `(brk)`（`loops` 里记的是 `switch` 那一层）。
   *   - **`default` 摆在中间**也对：它的条件是「一个标签都没命中」，那一格
   *     在进入任何组**之前**先算出来（`none`），不受 `m` 影响。
   *
   * 为什么不落成 if/else 链：穿落落不出来。为什么不用跳转表：方言里没有 switch，
   * 而这一层的目的是语义对，不是快 —— 真要快该在 MIR 那一层认这个形状。
   */
  switchStmt(s) {
    const sel = this.expr(s.sel);
    if (sel.length !== 1) throw new OmniError('glsl: switch 的选择子不是一格');
    const body = [];
    const outer = this.stmts;
    this.stmts = body;
    this.push();
    this.loops.push({ kind: 'switch' });
    const hit = (l) => `(bin "==" ${sel[0]} ${l < 0 ? `(un "-" (int ${-l}))` : `(int ${l})`})`;
    let none = null;
    if (s.hasDefault) {
      let any = null;
      for (const g of s.groups) {
        for (const l of g.labels) {
          if (l === null) continue;
          any = any === null ? hit(l) : `(bin "||" ${any} ${hit(l)})`;
        }
      }
      none = any === null ? '(bool true)' : this.let_('bool', `(un "!" ${any})`);
    }
    const m = this.fresh('sw');
    this.stmts.push(`(let ${m} bool (bool false))`);
    for (const g of s.groups) {
      let guard = `(var ${m})`;
      for (const l of g.labels) guard = `(bin "||" ${guard} ${l === null ? none : hit(l)})`;
      const inner = this.sub(() => {
        this.stmts.push(`(set ${m} (bool true))`);
        for (const x of g.body) this.stmt(x);
      });
      this.stmts.push(`(if ${guard} (do ${inner.join(' ')}))`);
    }
    this.loops.pop();
    this.pop();
    this.stmts = outer;
    this.stmts.push(`(while (bool true) (do ${body.join(' ')} (brk)))`);
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

  /** 一个 GLSL 函数 -> 一条方言 `fn`。参数摊平成 N 个标量，返回值是标量或结构体。
   *
   * `out`/`inout` 形参（第二十五片）：方言里没有引用参数，所以**从返回值那一头回来**。
   * 一个带 out 形参的函数落成「返回一个专用结构体」：字段是「返回值那几格 + 每个
   * out/inout 形参那几格」，按声明次序。调用点拆开、写回去（见 `call`）。
   *
   *   - `out`   形参：**不是**方言参数，函数里是一个从零起的局部量
   *   - `inout` 形参：是方言参数，进来先抄成局部量（抄一份是为了「写回去」这件事只发生
   *     在返回那一刻 —— 与 GLSL 的 copy-in/copy-out 语义一样，不是引用语义）
   */
  func(f) {
    if (f.name === 'main') return;
    const ps = [];
    const pre = [];
    const outs = [];
    this.push();
    for (const p of f.params) {
      const n = glslNComp(p.ty);
      /* 按格取类型（见 `glslCompTys`）：结构体形参摊成 N 个标量，各自的类型可以不同。 */
      const cts = glslCompTys(p.ty);
      const comps = [];
      for (let i = 0; i < n; i++) {
        const ct = cts[i];
        const local = `${p.name}_${i}`;
        if (p.dir === 'in') {
          ps.push(`(${local} ${ct})`);
        } else {
          if (p.dir === 'inout') {
            ps.push(`(${p.name}_in_${i} ${ct})`);
            pre.push(`(let ${local} ${ct} (var ${p.name}_in_${i}))`);
          } else {
            pre.push(`(let ${local} ${ct} ${glslZero(ct)})`);
          }
          outs.push({ name: local, ct });
        }
        comps.push(`(var ${local})`);
      }
      this.bind(p.name, comps);
    }
    const retN = f.ret.k === 'void' ? 0 : glslNComp(f.ret);
    /* 返回一个结构体时，返回值装的是方言的 `glsl_vN` —— 那是 **N 个 real**。分量类型不全
     * 一样的结构体（`Segs` 前四格 real、第五格 int）塞进去会把 int 悄悄变成 real，
     * 所以明着骂。要收它得给那个专用结构体逐格写类型，是下一格的事。 */
    if (f.ret.k === 'struct') {
      const rcts = glslCompTys(f.ret);
      if (rcts.some((x) => x !== rcts[0])) {
        glslNyi(`返回分量类型不一样的结构体（${f.ret.name} 摊平是 ${rcts.join(' / ')}）`);
      }
    }
    let ret;
    if (outs.length === 0) {
      ret = retN === 0 ? 'void' : retN === 1 ? glslCompTy(f.ret) : glslStructName(retN);
      if (retN > 1) this.need(retN);
      this.outCtx = null;
    } else {
      /* 专用结构体：字段类型逐格写清（返回值那几格 + out 那几格）。 */
      const fs = [];
      const rct = retN === 0 ? null : glslCompTy(f.ret);
      for (let i = 0; i < retN; i++) fs.push(`(c${i} ${rct})`);
      outs.forEach((o, k) => fs.push(`(c${retN + k} ${o.ct})`));
      const sn = `glsl_r_${this.prefix}${f.name}`;
      this.outStructs.push(`  (struct ${sn} ${fs.join(' ')})`);
      ret = sn;
      this.outCtx = { struct: sn, retN, outs };
    }
    this.stmts = [];
    for (const s of pre) this.stmts.push(s);
    this.stmt(f.body);
    if (this.outCtx !== null) {
      /* 掉出函数尾的那一路也得把 out 带回去（void 函数最常见）。
       * 前面已经 `return` 过的话这一条是死代码 —— 无害，而少了它就是「out 丢了」。 */
      this.packRet(null);
    }
    const body = this.stmts;
    this.stmts = [];
    this.outCtx = null;
    this.pop();
    this.out.push(`  (fn glsl_${this.prefix}${f.name} (${ps.join(' ')}) ${ret}\n    ${body.join('\n    ')})`);
  }

  /** 带 out 形参的函数里的 `return`：把「返回值那几格 + out 那几格」装进专用结构体。 */
  packRet(vals) {
    const cx = this.outCtx;
    const sn = this.fresh('rv');
    this.stmts.push(`(let ${sn} ${cx.struct} (new ${cx.struct}))`);
    for (let i = 0; i < cx.retN; i++) {
      /* `return;` 出现在**非** void 函数里是检查那一步的事，这儿只管有值就装。 */
      const v = vals === null ? null : vals[i];
      if (v !== null) this.stmts.push(`(fldset (var ${sn}) c${i} ${v})`);
    }
    cx.outs.forEach((o, k) => {
      this.stmts.push(`(fldset (var ${sn}) c${cx.retN + k} (var ${o.name}))`);
    });
    this.stmts.push(`(ret (var ${sn}))`);
  }

  /**
   * 片元的入口。签名是**定死**的：
   *
   *   `(fn glsl_frag ((frag_x real) (frag_y real) (<uniform 每一格>…)) glsl_v4 …)`
   *
   * `gl_FragCoord` 只给 `.xy` 两格真值，`.z`/`.w` 是 0/1（这一档没有深度、没有透视）。
   * 出来的是 `out vec4` 那一个 —— 多渲染目标这一刀不收。
   *
   * 用了导数（`mod.deriv`）时多三个形参：`quad_x`/`quad_y`（这个像素所在 2×2 quad
   * 左下那格的中心）与 `probe`（探第几处导数，-1 是真跑那一趟）—— 见 `deriv()`。
   * **只有用了才加**：没用导数的着色器降出来的字节与从前一字不差。
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
    if (m.deriv === true) ps.push('(quad_x real)', '(quad_y real)');
    /* 探针那一趟要把这些原样再递一遍：quad 的基准与每一格 uniform（`probe` 单独在最后）。 */
    const tail = m.deriv === true ? ['(var quad_x)', '(var quad_y)'] : [];
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
      /* 采样器（规范 4.1.7）：**三格**参数 —— 宽、高、这张图在共用那片纹素里的起点。
       * 名字绑到那三格上，`texture` 那一处就直接把它们递给助手（见 `expr` 的 `tex`）。
       * 为什么不是"一格句柄"：方言里没有不透明句柄这回事，而三个数就够定位一张图。 */
      if (u.ty.k === 'sampler') {
        const cs = [];
        for (const part of ['w', 'h', 'off']) {
          ps.push(`(${u.name}_${part} real)`);
          cs.push(`(var ${u.name}_${part})`);
          tail.push(`(var ${u.name}_${part})`);
        }
        this.bind(u.name, cs);
        continue;
      }
      const n = glslNComp(u.ty);
      const ct = glslCompTy(u.ty);
      const comps = [];
      for (let i = 0; i < n; i++) {
        ps.push(`(${u.name}_${i} ${ct})`);
        comps.push(`(var ${u.name}_${i})`);
        tail.push(`(var ${u.name}_${i})`);
      }
      this.bind(u.name, comps);
    }
    /* 纹素数据是**一片共用的缓冲**（各张图靠 `off` 区分）—— 与快路那边 `%tex` 一样。 */
    if (m.tex === true) {
      ps.push('(glsl_texbuf (buf real))');
      tail.push('(var glsl_texbuf)');
    }
    /* `probe` 排在**最后**：探针那一趟只换它一个（见 `deriv()`）。 */
    if (m.deriv === true) ps.push('(probe int)');
    this.probeTail = tail.join(' ');
    this.derivN = 0;
    this.stmts = [];
    /* `discard` 那一格：每个像素进来先清零。它是模块级的（跨函数要看得见），
     * 而这个函数**一个像素调一次** —— 不清的话上一个像素的 kill 会粘到下一个，
     * 指纹是"第一个被杀的像素之后整幅图全空"。
     * 探针那一趟（`probe >= 0`）**不许动它**：那一趟是替真跑的那个像素去看邻居的，
     * 邻居被 discard 与这个像素写不写回无关。 */
    if (m.discard === true) {
      this.stmts.push(m.deriv === true
        ? '(if (bin "<" (var probe) (int 0)) (do (set glsl_killed (bool false))))'
        : '(set glsl_killed (bool false))');
    }
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
    /* 模块级变量（B16）在**参照腿**上还没接。快路那边它就是 `main` 那一层的一个落点
     * （函数内联之后自然看得见，ADR-0019 决策十第 5 步），但这一层的函数是**真的方言
     * 函数**，所以要的是方言的全局（`tests/sexpr` 的 `12-globals` 那一档）——
     * 那是另一格，不是这一格。明着骂，别悄悄漏。 */
    const gvs = mod.globals === undefined ? [] : mod.globals;
    /* 纹理取样（规范 8.7）：真取样在三个方言助手里（`GLSL_TEX_FNS`），只有用了才发。 */
    if (mod.tex === true) {
      this.need(4);
      this.out.push(GLSL_TEX_FNS);
    }
    if (gvs.length > 0) {
      throw new OmniError(`glsl: 模块级变量（'${gvs[0].name}'）在参照腿上还没接 ——`
        + ' 这一层的函数是真的方言函数，要的是方言的全局（ADR-0019 决策十第 5 步）');
    }
    this.mod = mod;
    this.prefix = prefix;
    this.names = new Map();
    this.fnByName = new Map();
    for (const f of mod.funcs) this.fnByName.set(f.name, f);
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
    /* `discard` 那一格（只有模块里真有它才出现）。方言的全局是**零初始化**的，
     * bool 的零是 false —— 正好是"这个像素还活着"。 */
    const gs = this.mod !== undefined && this.mod !== null && this.mod.discard === true
      ? ['  (global glsl_killed bool)'] : [];
    /* 导数的探针把操作数的值放这一格里带回来（见 `deriv()`）。同样只有用了才出现。 */
    if (this.mod !== undefined && this.mod !== null && this.mod.deriv === true) {
      gs.push('  (global glsl_probe real)');
    }
    const body = [...decls, ...gs, ...this.outStructs, ...this.out].join('\n\n');
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
 * 纹理取样（规范 8.7）：**双线性 + clamp-to-edge**，没有 mip。
 *
 * 三个助手，只有模块真用了 `texture` 一族时才发：
 *   `glsl_texclamp(i, n)`             纹素下标夹到 [0, n-1]
 *   `glsl_texel(t, off, w, i, j, c)`  一个纹素的一个通道（RGBA 连着放，行优先）
 *   `glsl_tex2d(t, w, h, off, u, v)`  双线性；`glsl_tex1d` 就是 h=1、v=0.5 的它
 *
 * 纹素中心在 `(i+0.5)/w`，所以 `x = u*w - 0.5` 之后 `floor` 出左边那一格 ——
 * 这与 GL 的 `GL_LINEAR` 一字对应，也是快路那边同一份公式（两条腿各写一遍，由门对账）。
 *
 * 通道那一层是一个 `while` 加四个 `if`：方言的 `fldset` 要**字面**字段名，
 * 拿不到"第 c 格"这种写法。四份展开更长，但那是方言的规矩，不是这儿的选择。
 */
const GLSL_TEX_FNS = `  (fn glsl_texclamp ((i int) (n int)) int
    (if (bin "<" (var i) (int 0)) (do (ret (int 0))))
    (if (bin ">" (var i) (bin "-" (var n) (int 1))) (do (ret (bin "-" (var n) (int 1)))))
    (ret (var i)))

  (fn glsl_texel ((t (buf real)) (off int) (w int) (i int) (j int) (c int)) real
    (ret (bget (var t) (bin "+" (var off)
      (bin "+" (bin "*" (bin "+" (bin "*" (var j) (var w)) (var i)) (int 4)) (var c))))))

  (fn glsl_tex2d ((t (buf real)) (w real) (h real) (off real) (u real) (v real)) glsl_v4
    (let x real (bin "-" (bin "*" (var u) (var w)) (real 0.5)))
    (let y real (bin "-" (bin "*" (var v) (var h)) (real 0.5)))
    (let x0 real (rmath "floor" (var x)))
    (let y0 real (rmath "floor" (var y)))
    (let fx real (bin "-" (var x) (var x0)))
    (let fy real (bin "-" (var y) (var y0)))
    (let iw int (toint (var w)))
    (let ih int (toint (var h)))
    (let o int (toint (var off)))
    (let i0 int (call glsl_texclamp (toint (var x0)) (var iw)))
    (let i1 int (call glsl_texclamp (bin "+" (toint (var x0)) (int 1)) (var iw)))
    (let j0 int (call glsl_texclamp (toint (var y0)) (var ih)))
    (let j1 int (call glsl_texclamp (bin "+" (toint (var y0)) (int 1)) (var ih)))
    (let r glsl_v4 (new glsl_v4))
    (let c int (int 0))
    (while (bin "<" (var c) (int 4)) (do
      (let a real (call glsl_texel (var t) (var o) (var iw) (var i0) (var j0) (var c)))
      (let b real (call glsl_texel (var t) (var o) (var iw) (var i1) (var j0) (var c)))
      (let d real (call glsl_texel (var t) (var o) (var iw) (var i0) (var j1) (var c)))
      (let f real (call glsl_texel (var t) (var o) (var iw) (var i1) (var j1) (var c)))
      (let top real (bin "+" (var a) (bin "*" (var fx) (bin "-" (var b) (var a)))))
      (let bot real (bin "+" (var d) (bin "*" (var fx) (bin "-" (var f) (var d)))))
      (let val real (bin "+" (var top) (bin "*" (var fy) (bin "-" (var bot) (var top)))))
      (if (bin "==" (var c) (int 0)) (do (fldset (var r) c0 (var val))))
      (if (bin "==" (var c) (int 1)) (do (fldset (var r) c1 (var val))))
      (if (bin "==" (var c) (int 2)) (do (fldset (var r) c2 (var val))))
      (if (bin "==" (var c) (int 3)) (do (fldset (var r) c3 (var val))))
      (set c (bin "+" (var c) (int 1)))))
    (ret (var r)))

  (fn glsl_tex1d ((t (buf real)) (w real) (off real) (u real)) glsl_v4
    (ret (call glsl_tex2d (var t) (var w) (real 1.0) (var off) (var u) (real 0.5))))`;

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
  /* 导数在这条路上要重新插值一遍邻居的 varying，而插值住在入口**外面**（一个三角形
   * 一次的 setup）——探针那一趟拿不到。明着骂，不给一个悄悄错的答案。 */
  if (fragMod.deriv === true) {
    glslNyi('导数 + 三角形那条路（邻居的 varying 要重新插值，探针拿不到）');
  }
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
     *
     * 方向是**量出来的**（ADR-0019 第十一片）：拿一个斜边穿过画布的三角形与真 GL 比，
     * 斜边上那 16 个像素中心 GL 判**在外**。所以判据是
     * `sdy < 0`，或者 `sdy == 0 && sdx > 0` —— 与第九片写的正好反一个方向。
     * 第九片当时明写着「差一个整体翻转的可能性留着」，这一片把它量掉了。
     *
     * 注意这一格对齐的是**本机那台 GL**（Apple M1）。GL 规范只要求「边上的样本
     * 恰好归一个三角形」，没规定归哪个 —— 所以 llvmpipe 那边要再量一次。
     *
     * `sdx`/`sdy` 乘了 `sgn`：绕向归一化只改了 `e` 的符号，边的方向没改 ——
     * 不跟着乘的话，同一片像素在两种绕向下会得到不同的归属。 */
    s.push(`    (let s${j}dx real (bin "*" (var sgn) (bin "-" (var x${b2}) (var x${a2}))))`);
    s.push(`    (let s${j}dy real (bin "*" (var sgn) (bin "-" (var y${b2}) (var y${a2}))))`);
    s.push(`    (let tl${j} bool (bin "<" (var s${j}dy) (real 0.0)))`);
    s.push(`    (if (bin "&&" (bin "==" (var s${j}dy) (real 0.0)) (bin ">" (var s${j}dx) (real 0.0)))`
      + ` (do (set tl${j} (bool true))))`);
  }
  s.push(`    (let c ${glslStructName(4)} (new ${glslStructName(4)}))`);
  L.need(4);
  /* quad 扫描（次序与第四片一样）。 */
  const QX = [0, 1, 0, 1];
  const QY = [0, 0, 1, 1];
  const evalAt = (ax) => {
    const a = attrs[ax];
    if (a.interp === 'flat') return `(fld (var v2) c${a.fld})`;
    const lin = `(bin "+" (bin "+" (fld (var p${ax}) c0) (bin "*" (fld (var p${ax}) c1) (var px)))`
      + ` (bin "*" (fld (var p${ax}) c2) (var py)))`;
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
    /* `discard`：着色器已经调了（覆盖度是光栅化的事，kill 是着色器的事，两回事），
     * 所以这一格是**印之前**再问一句。没有 discard 时印那一段照旧直接跟在调用后面。 */
    const pr = ' (print (toint (bin "-" (var px) (real 0.5))))'
      + ' (print (toint (bin "-" (var py) (real 0.5))))'
      + ' (print (call glsl_to8 (fld (var c) c0)))'
      + ' (print (call glsl_to8 (fld (var c) c1)))'
      + ' (print (call glsl_to8 (fld (var c) c2)))';
    inner.push(`(if (bin "&&" ${cov} (bin "&&" (bin "<" (var px) (real ${glslNum(w)}))`
      + ` (bin "<" (var py) (real ${glslNum(h)}))))`
      + ' (do'
      + ` (set c (call glsl_frag ${args.join(' ')}))`
      + (fragMod.discard === true ? ` (if (un "!" (var glsl_killed)) (do${pr}))` : pr)
      + '))');
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
/**
 * uniform 的实参（参考腿的两个 main 共用）。
 *
 * 数值 uniform 就是它那几格数。**采样器**是三格 —— 宽、高、这张图在共用纹素缓冲里的
 * 起点（与入口那侧 `(<名>_w) (<名>_h) (<名>_off)` 一一对应）。纹素本身推进 `texData`，
 * 由调用方在 main 开头铺成一个 `(buf real)`。
 *
 * `uni[名字]` 对采样器给的是 `{ w, h, data: [每个纹素四格 RGBA…] }`（1D 的 h 是 1）。
 */
function glslUniArgs(mod, uni, args, texData) {
  for (const u of mod.uniforms) {
    if (u.ty.k === 'sampler') {
      const t = uni[u.name];
      if (t === undefined || t.data === undefined) {
        throw new OmniError(`glsl: 采样器 '${u.name}' 没给纹理（要 { w, h, data }）`);
      }
      const tw = t.w;
      const th = u.ty.dim === 1 ? 1 : t.h;
      if (t.data.length !== tw * th * 4) {
        throw new OmniError(`glsl: 采样器 '${u.name}' 要 ${tw * th * 4} 个数`
          + `（${tw}×${th} 的 RGBA），给了 ${t.data.length}`);
      }
      args.push(`(real ${glslNum(tw)})`);
      args.push(`(real ${glslNum(th)})`);
      args.push(`(real ${glslNum(texData.length)})`);
      for (const v of t.data) texData.push(v);
      continue;
    }
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
}

/** 那片共用纹素缓冲的建法（`texData` 空就一行都不发）。 */
function glslTexBufLines(texData) {
  if (texData.length === 0) return [];
  const out = [`(let glsl_texbuf (buf real) (bnew (buf real) (int ${texData.length})))`];
  for (let i = 0; i < texData.length; i++) {
    out.push(`(bset (var glsl_texbuf) (int ${i}) (real ${glslNum(texData[i])}))`);
  }
  return out;
}

export function glslRenderMain(mod, w, h, uni) {
  const args = ['(var px)', '(var py)'];
  /* 用了导数的着色器：入口多两个 quad 基准（见 `deriv()`）。`qx`/`qy` 正是这一段
   * 循环里的 quad 左下角像素下标，加 0.5 就是它的中心 —— 这段本来就按 quad 走。 */
  if (mod.deriv === true) {
    args.push('(bin "+" (toreal (var qx)) (real 0.5))');
    args.push('(bin "+" (toreal (var qy)) (real 0.5))');
  }
  const texData = [];
  glslUniArgs(mod, uni, args, texData);
  if (mod.tex === true) args.push('(var glsl_texbuf)');
  /* 真跑那一趟：`probe = -1`（探针那几趟由 `deriv()` 自己发，见那儿）。 */
  if (mod.deriv === true) args.push('(int -1)');
  const call = `(call glsl_frag ${args.join(' ')})`;
  /* quad 里那四格的偏移，顺序照 llvmpipe 的 `quad_offset_x/y`。 */
  const QX = [0, 1, 0, 1];
  const QY = [0, 0, 1, 1];  /* 在画布里 —— 出了界的那几格照样算，只是不印（见函数头）。 */
  const bounds = `(bin "&&" (bin "<" (var px) (real ${glslNum(w)}))`
    + ` (bin "<" (var py) (real ${glslNum(h)})))`;
  /* `discard` 掉的像素也不印 —— 那正是"不写回帧缓冲"在这一腿上的样子（快路那边是驱动
   * 看覆盖度那一格跳过它）。没有 discard 的着色器这个条件与从前一字不差。 */
  const cond = mod.discard === true
    ? `(bin "&&" ${bounds} (un "!" (var glsl_killed)))` : bounds;
  const inner = [];
  for (let k = 0; k < 4; k++) {
    inner.push(`(set px (bin "+" (toreal (var qx)) (real ${QX[k] + 0.5})))`);
    inner.push(`(set py (bin "+" (toreal (var qy)) (real ${QY[k] + 0.5})))`);
    inner.push(`(set c ${call})`);
    /* 一格一个 `print`，不拼成一行：方言的 `+` 是「同型相加」，`int + string`
     * 不在它的规矩里，而绕过去（先 `toreal` 再拼）只会让这段更难看。 */
    inner.push(`(if ${cond}`
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
    ${glslTexBufLines(texData).join('\n    ')}
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
  /* 与 `glslRenderMain` 同一套：用了导数就多两个 quad 基准，`probe = -1` 在最后。 */
  if (mod.deriv === true) {
    args.push('(bin "+" (toreal (var qx)) (real 0.5))');
    args.push('(bin "+" (toreal (var qy)) (real 0.5))');
  }
  const texData = [];
  glslUniArgs(mod, uni, args, texData);
  if (mod.tex === true) args.push('(var glsl_texbuf)');
  if (mod.deriv === true) args.push('(int -1)');
  const call = `(call glsl_frag ${args.join(' ')})`;
  const QX = [0, 1, 0, 1];
  const QY = [0, 0, 1, 1];
  const bnd = `(bin "&&" (bin "<" (var px) (real ${glslNum(w)}))`
    + ` (bin "<" (var py) (real ${glslNum(h)})))`;
  /* `discard` 掉的像素不进校验和 —— 与 `glslRenderMain` 那边"不印"是同一件事，
   * 两条路算的还是同一个东西（那条门比的就是"校验和 == 印出来那些数的和"）。 */
  const bcond = mod.discard === true
    ? `(bin "&&" ${bnd} (un "!" (var glsl_killed)))` : bnd;
  const inner = [];
  for (let k = 0; k < 4; k++) {
    inner.push(`(set px (bin "+" (toreal (var qx)) (real ${QX[k] + 0.5})))`);
    inner.push(`(set py (bin "+" (toreal (var qy)) (real ${QY[k] + 0.5})))`);
    inner.push(`(set c ${call})`);
    inner.push(`(if ${bcond}`
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
    ${glslTexBufLines(texData).join('\n    ')}
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


