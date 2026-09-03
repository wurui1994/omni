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
  constructor(mod) {
    this.mod = mod;
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
      if (e.kind === 'uniform' || e.kind === 'local' || e.kind === 'const'
        || e.kind === 'builtin-in' || e.kind === 'out' || e.kind === 'builtin-out') {
        return this.find(e.name);
      }
      if (e.kind === 'in') glslNyi('varying（in）');
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
      if (e.ty.k === 'mat') glslNyi('矩阵');
      /* 铺开：同一个值填 N 格。先绑一个 let，免得算 N 遍。 */
      const v = this.let_(glslCompTy(e.ty), of);
      const out = [];
      for (let i = 0; i < n; i++) out.push(v);
      return out;
    }
    if (e.k === 'construct') {
      if (e.ty.k === 'mat') glslNyi('矩阵构造');
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
    if (e.k === 'sel') glslNyi('三元 ? :');
    if (e.k === 'assign') return this.assign(e);
    if (e.k === 'incdec') return this.incdec(e);
    throw new OmniError(`glsl: 降不了的表达式 ${e.k}`);
  }

  bin(e) {
    if (e.a.ty.k === 'mat' || e.b.ty.k === 'mat') glslNyi('矩阵乘');
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
    if (name === 'sign' || name === 'inversesqrt' || name === 'radians'
      || name === 'degrees' || name === 'fract') {
      /* 这几条都是几行算术，但第一档一份尺子都没用到（`fract` 是第二档的）——
       * 不写比写了没人测好。 */
      glslNyi(`内建 ${name}`);
    }
    glslNyi(`内建 ${name}`);
    return [];
  }

  call(e) {
    const args = [];
    for (const a of e.args) for (const c of this.expr(a)) args.push(c);
    const n = glslNComp(e.ty);
    if (e.ty.k === 'mat') glslNyi('回矩阵的函数');
    const callTxt = `(call glsl_${e.name} ${args.join(' ')})`;
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
      if (s.ty.k === 'mat') glslNyi('矩阵局部量');
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
    if (s.k === 'if' || s.k === 'while') glslNyi(s.k === 'if' ? 'if' : 'while');
    throw new OmniError(`glsl: 降不了的语句 ${s.k}`);
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
      if (p.ty.k === 'mat') glslNyi('矩阵形参');
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
    this.out.push(`  (fn glsl_${f.name} (${ps.join(' ')}) ${ret}\n    ${body.join('\n    ')})`);
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
    if (m.stage !== 'frag') glslNyi('顶点着色器');
    if (m.outs.length !== 1) glslNyi(`${m.outs.length} 个 out（这一刀只收一个）`);
    const o = m.outs[0];
    if (!(o.ty.k === 'vec' && o.ty.n === 4)) {
      throw new OmniError(`glsl: out 得是 vec4，这儿是 ${glslTyText(o.ty)}`);
    }
    if (m.ins.length !== 0) glslNyi('varying（in）');
    const ps = ['(frag_x real)', '(frag_y real)'];
    this.push();
    this.bind('gl_FragCoord', ['(var frag_x)', '(var frag_y)', '(real 0.0)', '(real 1.0)']);
    for (const u of m.uniforms) {
      if (u.ty.k === 'mat') glslNyi('矩阵 uniform');
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

  run() {
    for (const f of this.mod.funcs) this.func(f);
    this.entry();
    const decls = [...this.structs].sort().map((n) => {
      const fs = [];
      for (let i = 0; i < n; i++) fs.push(`(c${i} real)`);
      return `  (struct ${glslStructName(n)} ${fs.join(' ')})`;
    });
    return `(module\n${[...decls, ...this.out].join('\n\n')}\n)\n`;
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
 * `glsl_v4`。跑它的那一头（把画布扫一遍、按 quad 走、写 PNG）是第四片。
 */
export function glslLower(mod) {
  return new GlslLowerer(mod).run();
}
