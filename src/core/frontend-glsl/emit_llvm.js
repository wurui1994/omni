// Omni — GLSL -> LLVM IR（**8 道 f32 SoA**）。ADR-0019 决策六「快路」的第 2 步。
//
// 与 `lower.js`（标量摊分量 -> 核心方言）是**两条路**，刻意的：
//
//   `lower.js`   一次一个片元、`real` 是 f64、经过核心方言 -> 五条腿。**参照实现**：
//                差分门与 oracle 靠它，JS 腿与解释器腿只有它。
//   这一份       一次 8 个片元、每格 `<8 x float>`、直接发 LLVM IR。**快路**：
//                量到的天花板 178 MPix/s（`soa_ceiling.c` 那一节），而标量路是 0.70。
//
// 为什么直接发 IR 而不是给方言加向量：三个量出来的数（决策六）——
// 我们自己的形状先丢了 45 倍、宽度值 5.5 倍、精度只值 6%。也就是说要拿的是**形状**，
// 而方言的形状是「一次一个片元 + 每片元一个结构体」，改它等于重写方言。
//
// 表示（与 clang 自己发出来的形状对齐，见 ADR「快路第一步」那一节）：
//
//   - 一个 GLSL 值 = **分量数组**，每格是一段 `<8 x float>` 的 IR 值文本
//   - 标量也是 `<8 x float>`：splat 之后一律同型，省掉「标量/向量」两套路径
//   - `min`/`max`/`sqrt` -> `llvm.minnum/maxnum/sqrt.v8f32`
//   - 常量 -> `splat (float 0x…)`；LLVM 的 `float` 字面量用 16 位十六进制（双精度位模式）
//
// 这一片**只收 `bench-simple` 那一档**（算术、swizzle、构造、`sin`/`cos`/`min`/`max`/
// `sqrt`/`length`、uniform、`gl_FragCoord.xy`、一个 `out vec4`）。别的明着抛 ——
// 快路宁可少收，不能悄悄算错：正确性由「与参照实现逐像素对账」那道门管。

import { OmniError } from '../source/diag.js';

/** 一道多少：8 道 f32 = 一个 256 位寄存器（M1 上是两条 128 位，clang 自己拆）。 */
export const GLSL_LANES = 8;

const LL_VEC = `<${GLSL_LANES} x float>`;

/** 分量个数（这一档只有标量、vecN 与平结构体）。 */
function llNComp(t) {
  if (t.k === 'vec') return t.n;
  if (t.k === 'float' || t.k === 'int' || t.k === 'bool') return 1;
  /* 结构体（施工图 B13）：各成员之和。快路这边**连类型数组都不要** —— 所有分量都是
   * `<8 x float>`，`int` 在这条路上就是「值恰好是整数的 float」，所以摊平的格数够了。 */
  if (t.k === 'struct') {
    let n = 0;
    for (const f of t.fields) n += llNComp(f.ty);
    return n;
  }
  throw new OmniError(`glsl/llvm: 这一片收不了的类型 ${t.k}`);
}

/** LLVM 的 `float` 字面量：十六进制的**双精度位模式**（末 29 位必须是 0）。 */
function llFloat(v) {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, Math.fround(v));
  const hi = b.getUint32(0).toString(16).padStart(8, '0');
  const lo = b.getUint32(4).toString(16).padStart(8, '0');
  return `0x${hi}${lo}`;
}

/** `splat (float …)`：clang 就是这么发的，读起来也短。 */
const llSplat = (v) => `splat (float ${llFloat(v)})`;

/** GLSL 内建 -> LLVM intrinsic（都有 `.v8f32` 的向量形）。 */
const LL_INTRIN = new Map([
  ['sin', 'llvm.sin'], ['cos', 'llvm.cos'], ['sqrt', 'llvm.sqrt'],
  ['abs', 'llvm.fabs'], ['floor', 'llvm.floor'], ['ceil', 'llvm.ceil'],
  ['pow', 'llvm.pow'], ['exp', 'llvm.exp'], ['log', 'llvm.log'],
  ['min', 'llvm.minnum'], ['max', 'llvm.maxnum'],
]);

class GlslLlvmEmitter {
  constructor(mod) {
    this.mod = mod;
    this.n = 0;                 // SSA 计数
    this.body = [];             // 函数体那几行
    this.scopes = [new Map()];  // 名字 -> 分量数组
    this.need = new Set();      // 要 declare 的 intrinsic
  }

  fresh() { this.n++; return `%v${this.n}`; }

  /** 发一条指令，回它的结果名。 */
  emit(txt) {
    const r = this.fresh();
    this.body.push(`  ${r} = ${txt}`);
    return r;
  }

  bind(name, comps) { this.scopes[this.scopes.length - 1].set(name, comps); }

  /** 赋值要改**声明它的那一层**。写进当前层的话，出了 `{}` 就丢 ——
   * `out` 是在函数那一层绑的，而 `main` 的体是一个 block（第一版就栽在这儿：
   * 快路输出全 0，因为 `fragColor = …` 只改了内层那一份）。 */
  assignTo(name, comps) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) { this.scopes[i].set(name, comps); return; }
    }
    throw new OmniError(`glsl/llvm: 赋值给没见过的名字 '${name}'`);
  }


  find(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const c = this.scopes[i].get(name);
      if (c !== undefined) return c;
    }
    throw new OmniError(`glsl/llvm: 找不到名字 '${name}'`);
  }

  bin(op, a, b) {
    const ins = op === '+' ? 'fadd' : op === '-' ? 'fsub' : op === '*' ? 'fmul' : 'fdiv';
    return this.emit(`${ins} ${LL_VEC} ${a}, ${b}`);
  }

  call1(fn, args) {
    this.need.add(fn);
    const as = args.map((a) => `${LL_VEC} ${a}`).join(', ');
    return this.emit(`call ${LL_VEC} @${fn}.v${GLSL_LANES}f32(${as})`);
  }

  /* ---- bool 在快路里是「值只取 0.0 / 1.0 的 <8 x float>」 -----------------------
   *
   * 为什么不是 `<${GLSL_LANES} x i1>`：这一份从头到尾的表示是「一个分量 = 一段
   * `<8 x float>` 的值文本」（标量也 splat 成同型，就为了省掉两套路径）。给 bool 单开
   * 一种宽度就得给每个分量带上类型标签，那是把这二十来处全改一遍。
   *
   * 代价是不是真的：`select(c, 1.0, 0.0)` 后面紧跟 `fcmp une …, 0.0` 是 InstCombine
   * 的标准折叠，会还原成 `c` 本身 —— 也就是说这种表示在 -O2 / ORC 之后大多不留痕迹。
   * 「大多」不是「一定」，所以这一格的代价由**下限门**盯着（`fast.js` 那条 100 MPix/s）：
   * 真掉下去了就说明折叠没发生，那时候再加类型标签，而不是现在先猜。
   *
   * 逻辑算符在这个表示下是算术：`&&` 是乘、`||` 是 max、`!` 是 `1 - x`。两边都是
   * 0.0/1.0，所以在 f32 上全部精确，也不会有 NaN 冒出来（值只从 select 来）。 */

  /** 一个 float-bool 分量 -> `<8 x i1>` 掩码。 */
  mask(c) {
    return this.emit(`fcmp une ${LL_VEC} ${c}, ${llSplat(0)}`);
  }

  /** `<8 x i1>` 掩码 -> float-bool 分量。 */
  fromMask(m) {
    return this.emit(`select <${GLSL_LANES} x i1> ${m}, ${LL_VEC} ${llSplat(1)}, ${LL_VEC} ${llSplat(0)}`);
  }

  /** 比较：`==`/`!=` 用**无序**那一档（与 C 的 `==`/`!=` 对 NaN 的结果一致）。 */
  cmp(op, a, b) {
    const pred = { '<': 'olt', '<=': 'ole', '>': 'ogt', '>=': 'oge', '==': 'oeq', '!=': 'une' }[op];
    return this.fromMask(this.emit(`fcmp ${pred} ${LL_VEC} ${a}, ${b}`));
  }

  /** 一个表达式 -> 分量数组（每格一段 `<8 x float>` 的值文本）。 */
  expr(e) {
    if (e.k === 'lit') {
      if (e.ty.k === 'bool') return [llSplat(e.v ? 1 : 0)];
      return [llSplat(Number(e.v))];
    }
    if (e.k === 'ref') return this.find(e.name);
    if (e.k === 'swizzle') {
      /* 局部量**不能叫 `of`** —— 那是自编译子集词法里的关键字（`for … of`）。
       * 节点属性叫 `e.of` 没关系，受限的只有绑定名。 */
      const subj = this.expr(e.of);
      return e.idx.map((ix) => subj[ix]);
    }
    if (e.k === 'splat') {
      const v = this.expr(e.of)[0];
      const out = [];
      for (let i = 0; i < llNComp(e.ty); i++) out.push(v);
      return out;
    }
    if (e.k === 'field') {
      /* 结构体的成员（施工图 B13）：分量表里连着的那一段，起始格号由检查那一侧算好放在
       * `at` 上。与 `lower.js` 那条是同一个切片，只是这边每格是 `<8 x float>`。 */
      const subj = this.expr(e.of);
      return subj.slice(e.at, e.at + llNComp(e.ty));
    }
    if (e.k === 'construct') {
      const out = [];
      for (const a of e.args) for (const c of this.expr(a)) out.push(c);
      return out;
    }
    if (e.k === 'cast' || e.k === 'convert') {
      /* 这一档只有 int <-> float，而两边都已经是 `<8 x float>` —— 整数在这条路上
       * 就是「值恰好是整数的 float」。`int` 的位运算不在这一片里（明着不收）。
       *
       * bool 那两个方向都不用发指令：`float(b)` 要的 1.0/0.0 正好就是 float-bool 的
       * 表示；`bool(x)` 只有 `x` 不是 0.0/1.0 时才要归一 —— 那一条走 `mask` 再回来。 */
      const v = this.expr(e.of);
      if (e.ty.k === 'bool' && e.of.ty !== undefined && e.of.ty.k !== 'bool') {
        return v.map((c) => this.fromMask(this.mask(c)));
      }
      return v;
    }
    if (e.k === 'neg') {
      return this.expr(e.a).map((c) => this.emit(`fneg ${LL_VEC} ${c}`));
    }
    if (e.k === 'bin') {
      /* 比较与逻辑：结果是 float-bool（见 `mask`/`cmp` 上面那段）。
       * `&&`/`||` 在这里**两边都算** —— SIMD 上没有短路这回事（llvmpipe 也一样：
       * 两支都算、靠掩码取）。值只取 0.0/1.0，所以 `*`/`max` 就是与/或。 */
      if (e.op === '<' || e.op === '<=' || e.op === '>' || e.op === '>='
        || e.op === '==' || e.op === '!=') {
        const a = this.expr(e.a);
        const b = this.expr(e.b);
        if (a.length === 1 && b.length === 1) return [this.cmp(e.op, a[0], b[0])];
        /* 向量的 `==`/`!=` 回一个标量 bool：逐格比完折起来（`==` 用与、`!=` 用或）。 */
        const n = Math.max(a.length, b.length);
        let acc = null;
        for (let i = 0; i < n; i++) {
          const c = this.cmp(e.op, a.length === 1 ? a[0] : a[i], b.length === 1 ? b[0] : b[i]);
          acc = acc === null ? c
            : (e.op === '==' ? this.bin('*', acc, c) : this.call1('llvm.maxnum', [acc, c]));
        }
        return [acc];
      }
      if (e.op === '&&') {
        return [this.bin('*', this.expr(e.a)[0], this.expr(e.b)[0])];
      }
      if (e.op === '||') {
        return [this.call1('llvm.maxnum', [this.expr(e.a)[0], this.expr(e.b)[0]])];
      }
      if (e.op === '^^') {
        return [this.cmp('!=', this.expr(e.a)[0], this.expr(e.b)[0])];
      }
      if (e.op !== '+' && e.op !== '-' && e.op !== '*' && e.op !== '/') {
        throw new OmniError(`glsl/llvm: 这一片只收 + - * / 与比较、逻辑，给的是 ${e.op}`);
      }
      const a = this.expr(e.a);
      const b = this.expr(e.b);
      const n = Math.max(a.length, b.length);
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push(this.bin(e.op, a.length === 1 ? a[0] : a[i], b.length === 1 ? b[0] : b[i]));
      }
      return out;
    }
    if (e.k === 'not') return [this.bin('-', llSplat(1), this.expr(e.a)[0])];
    if (e.k === 'sel') {
      /* `c ? a : b` -> 一条 `select`。**两支都算** —— 与 `lower.js` 那条路不同
       * （那边刻意只算一支，理由写在它的 `sel()` 头上）。这一层没得选：8 道里可能
       * 有的走这支、有的走那支。所以「不该走的那一支里有除零」在快路上会真的算出
       * Inf/NaN —— 但 `select` 是逐道取值，算出来的那一格不会被选中，传不出去。 */
      const m = this.mask(this.expr(e.c)[0]);
      const a = this.expr(e.a);
      const b = this.expr(e.b);
      const n = Math.max(a.length, b.length);
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push(this.emit(`select <${GLSL_LANES} x i1> ${m}, `
          + `${LL_VEC} ${a.length === 1 ? a[0] : a[i]}, ${LL_VEC} ${b.length === 1 ? b[0] : b[i]}`));
      }
      return out;
    }
    if (e.k === 'builtin') return this.builtin(e);
    /* 赋值是**表达式**（`fragColor = …` 出来是 `{k:'expr', e:{k:'assign'}}`）。 */
    if (e.k === 'assign') return this.assign(e);

    throw new OmniError(`glsl/llvm: 这一片收不了的表达式 ${e.k}`);
  }

  builtin(e) {
    const name = e.name;
    const args = e.args.map((a) => this.expr(a));
    /* `Math.max(...xs)` 的展开自编译子集不收 —— 显式取最大。 */
    let wide = 0;
    for (const a of args) if (a.length > wide) wide = a.length;
    /* `at` 的两个形参**刻意不叫 `k`/`i`**：自编译那侧的「闭包捕获循环变量」是按
     * **函数**粒度 + 按名字判的，箭头函数里出现 `i` 就会把这个函数里所有
     * `for (let i …)` 都骂一遍（量过：改个名字 13 条错变 9 条）。形参名错开就没这回事。 */
    const at = (ak, ai) => (args[ak].length === 1 ? args[ak][0] : args[ak][ai]);
    const fn = LL_INTRIN.get(name);
    if (fn !== undefined) {
      const out = [];
      for (let i = 0; i < wide; i++) {
        /* 这儿刻意**不写** `args.map((_, k) => at(k, i))`：闭包捕获 `for` 的循环变量，
         * 自编译那个子集不收（JS 的 `let` 每轮一个新绑定，C 那边不是）。显式循环取。 */
        const lane = [];
        for (let k = 0; k < args.length; k++) lane.push(at(k, i));
        out.push(this.call1(fn, lane));
      }
      return out;
    }
    if (name === 'length' || name === 'distance' || name === 'dot') {
      const a = args[0];
      const b = name === 'dot' || name === 'distance' ? args[1] : null;
      let sum = null;
      for (let i = 0; i < a.length; i++) {
        const x = name === 'distance' ? this.bin('-', a[i], b[i]) : a[i];
        const y = name === 'dot' ? b[i] : x;
        const p = this.bin('*', x, y);
        sum = sum === null ? p : this.bin('+', sum, p);
      }
      return [name === 'dot' ? sum : this.call1('llvm.sqrt', [sum])];
    }
    if (name === 'fract') {
      return args[0].map((c) => this.bin('-', c, this.call1('llvm.floor', [c])));
    }
    if (name === 'clamp') {
      const out = [];
      for (let i = 0; i < wide; i++) {
        const lo = this.call1('llvm.maxnum', [at(0, i), at(1, i)]);
        out.push(this.call1('llvm.minnum', [lo, at(2, i)]));
      }
      return out;
    }
    if (name === 'mix') {
      /* 照规范那个形状：`x*(1-a) + y*a`（不写成 x + (y-x)*a —— 浮点下不等价）。 */
      const out = [];
      for (let i = 0; i < wide; i++) {
        const a0 = at(2, i);
        const one = this.bin('-', llSplat(1), a0);
        out.push(this.bin('+', this.bin('*', at(0, i), one), this.bin('*', at(1, i), a0)));
      }
      return out;
    }
    if (name === 'normalize') {
      let sum = null;
      for (const c of args[0]) {
        const p = this.bin('*', c, c);
        sum = sum === null ? p : this.bin('+', sum, p);
      }
      const len = this.call1('llvm.sqrt', [sum]);
      return args[0].map((c) => this.bin('/', c, len));
    }
    if (name === 'smoothstep') {
      const out = [];
      for (let i = 0; i < wide; i++) {
        const num = this.bin('-', at(2, i), at(0, i));
        const den = this.bin('-', at(1, i), at(0, i));
        let t = this.bin('/', num, den);
        t = this.call1('llvm.maxnum', [t, llSplat(0)]);
        t = this.call1('llvm.minnum', [t, llSplat(1)]);
        const tt = this.bin('*', t, t);
        const three = this.bin('-', llSplat(3), this.bin('*', llSplat(2), t));
        out.push(this.bin('*', tt, three));
      }
      return out;
    }
    if (name === 'step') {
      /* 掩码 + select：`x < edge ? 0 : 1`。这一片里唯一用到比较的地方。 */
      const out = [];
      for (let i = 0; i < wide; i++) {
        const m = this.emit(`fcmp olt ${LL_VEC} ${at(1, i)}, ${at(0, i)}`);
        out.push(this.emit(`select <${GLSL_LANES} x i1> ${m}, ${LL_VEC} ${llSplat(0)}, ${LL_VEC} ${llSplat(1)}`));
      }
      return out;
    }
    if (name === 'isnan') {
      /* NaN 是唯一「无序于自己」的值 —— 一条 `fcmp uno`。 */
      return args[0].map((c) => this.fromMask(this.emit(`fcmp uno ${LL_VEC} ${c}, ${c}`)));
    }
    if (name === 'isinf') {
      /* `|x| == +Inf`。参照实现那条路写的是 `x == x && (x-x) != 0` —— 那是因为方言的
       * `real` 是 f64，写死「最大有限值」会跟 f32 差一个数。这里宽度是定的（f32），
       * 直接与 +Inf 比，两条在数学上完全等价，所以对账门照旧成立。 */
      return args[0].map((c) => this.fromMask(
        this.emit(`fcmp oeq ${LL_VEC} ${this.call1('llvm.fabs', [c])}, ${llSplat(Infinity)}`)));
    }
    const vcmp = { lessThan: '<', lessThanEqual: '<=', greaterThan: '>', greaterThanEqual: '>=', equal: '==', notEqual: '!=' }[name];
    if (vcmp !== undefined) {
      const out = [];
      for (let i = 0; i < wide; i++) out.push(this.cmp(vcmp, at(0, i), at(1, i)));
      return out;
    }
    if (name === 'all' || name === 'any') {
      let acc = null;
      for (const c of args[0]) {
        acc = acc === null ? c
          : (name === 'all' ? this.bin('*', acc, c) : this.call1('llvm.maxnum', [acc, c]));
      }
      return [acc === null ? llSplat(name === 'all' ? 1 : 0) : acc];
    }
    if (name === 'not') return args[0].map((c) => this.bin('-', llSplat(1), c));
    throw new OmniError(`glsl/llvm: 这一片还没接的内建 ${name}`);
  }

  stmt(s) {
    if (s.k === 'empty') return;
    if (s.k === 'block') {
      this.scopes.push(new Map());
      for (const x of s.body) this.stmt(x);
      this.scopes.pop();
      return;
    }
    if (s.k === 'expr') { this.expr(s.e); return; }
    if (s.k === 'decl') {
      /* SSA：局部量就是「当前那几格值」。没有 `alloca` —— 这一片不收循环里的赋值，
       * 所以不需要 phi（要收的时候连着循环一起做，见开工单第 2 步的「for 只收常量次数」）。 */
      const n = llNComp(s.ty);
      const vals = s.init === null ? null : this.expr(s.init);
      const comps = [];
      for (let i = 0; i < n; i++) {
        comps.push(vals === null ? llSplat(0) : (vals.length === 1 ? vals[0] : vals[i]));
      }
      this.bind(s.name, comps);
      return;
    }
    if (s.k === 'assign') { this.assign(s.e); return; }
    if (s.k === 'if') { this.ifStmt(s); return; }
    throw new OmniError(`glsl/llvm: 这一片收不了的语句 ${s.k}`);
  }

  /**
   * `if` —— **没有分支**，落成掩码 + `select`（llvmpipe 也是这么干的）。
   *
   * 做法：算出掩码，两支各跑一遍（各自压一层作用域，所以支内的声明出不来），
   * 然后把**两支之后不一样的那些绑定**逐分量 `select` 回来。
   *
   *   if (c) x = a; else x = b;   ->  %m = fcmp …；x = select %m, a, b
   *
   * 为什么必须两支都算：8 道里可能有的走这支、有的走那支。代价与语义都写在 `sel()`
   * 上面那段里 —— 不该走的那支会真算出 Inf/NaN，但那一格选不中。
   *
   * `break`/`continue`/`return`/`discard` 在支里现在**明着不收**：那些要的是「掩码
   * 一路带下去」（llvmpipe 的 exec mask 栈），不是一条 `select` 能兑的。循环也一样。
   */
  ifStmt(s) {
    const m = this.mask(this.expr(s.c)[0]);
    const snap = () => {
      const out = new Map();
      for (let i = 0; i < this.scopes.length; i++) {
        for (const [k, v] of this.scopes[i]) out.set(`${i}\u0000${k}`, v);
      }
      return out;
    };
    const put = (state) => {
      for (const [key, v] of state) {
        const cut = key.indexOf('\u0000');
        this.scopes[Number(key.slice(0, cut))].set(key.slice(cut + 1), v);
      }
    };
    const before = snap();
    const runBranch = (sub) => {
      this.scopes.push(new Map());
      if (sub !== null && sub !== undefined) this.stmt(sub);
      this.scopes.pop();
      const st = snap();
      put(before);
      return st;
    };
    const yes = runBranch(s.then);
    const no = runBranch(s.else);
    /* 合并：两支给的分量数组一样（同一个字符串）就不发指令 —— `if` 只改了几格的话，
     * 别的名字一条 `select` 都不该多出来。 */
    for (const [key, tv] of yes) {
      const ev = no.get(key);
      if (ev === undefined || ev === tv) continue;
      const merged = tv.map((c, i) => (c === ev[i] ? c
        : this.emit(`select <${GLSL_LANES} x i1> ${m}, ${LL_VEC} ${c}, ${LL_VEC} ${ev[i]}`)));
      const cut = key.indexOf('\u0000');
      this.scopes[Number(key.slice(0, cut))].set(key.slice(cut + 1), merged);
    }
  }

  assign(e) {
    if (e.op !== '=') throw new OmniError(`glsl/llvm: 这一片只收 =，给的是 ${e.op}`);
    const vals = this.expr(e.rhs);
    if (e.lhs.k === 'ref') {
      const cur = this.find(e.lhs.name);
      const next = cur.map((_, i) => (vals.length === 1 ? vals[0] : vals[i]));
      this.assignTo(e.lhs.name, next);
      return next;
    }
    if (e.lhs.k === 'swizzle' && e.lhs.of.k === 'ref') {
      const cur = [...this.find(e.lhs.of.name)];
      e.lhs.idx.forEach((ix, k) => { cur[ix] = vals.length === 1 ? vals[0] : vals[k]; });
      this.assignTo(e.lhs.of.name, cur);
      return vals;
    }
    throw new OmniError('glsl/llvm: 这一片的左值只收名字与它的 swizzle');
  }

  /**
   * 片元入口。签名**只有两个指针**（驱动那一侧照这个声明）：
   *
   *   void glsl_frag8(ptr in, ptr out)
   *
   *   `in`  指向连着的 `<8 x float>`：`[x, y, uniform 的每一格…]`
   *   `out` 指向连着的四格（r/g/b/a）
   *
   * **为什么全走指针**：第一版把 `<8 x float>` 直接当参数传，结果读出来整体错位一格 ——
   * 32 字节向量在 AArch64 上不是原生寄存器类型（NEON 是 16 字节），它要拆成两个 q
   * 或者走内存，而「IR 里的 `<8 x float>` 参数」与「C 里的 `ext_vector_type(8)` 参数」
   * 在这一格上不必一致。指针没有这个问题：ABI 面只剩一个地址。
   * 入口多几条 `load` —— 一批 8 个像素，摊下来看不见。
   */
  run() {
    const m = this.mod;
    if (m.stage !== 'frag') throw new OmniError('glsl/llvm: 这一片只收片元');
    if (m.outs.length !== 1) throw new OmniError(`glsl/llvm: 只收一个 out（给了 ${m.outs.length}）`);
    if (m.funcs.length !== 1 || m.funcs[0].name !== 'main') {
      throw new OmniError('glsl/llvm: 这一片只收「只有 main」的着色器（自定义函数下一片）');
    }
    /* 入口那几条 load：`in` 的第 0/1 格是 x/y，后面依次是每个 uniform 的每一格。 */
    /* 形参**刻意不叫 `i`**：见 `builtin()` 里 `at` 上面那段（闭包捕获那条检查是按
     * 函数粒度 + 按名字判的）。 */
    const load = (slotIx) => {
      const p = slotIx === 0 ? '%in' : this.emit(`getelementptr ${LL_VEC}, ptr %in, i64 ${slotIx}`);
      return this.emit(`load ${LL_VEC}, ptr ${p}, align 4`);
    };
    let slot = 0;
    const x = load(slot++);
    const y = load(slot++);
    this.bind('gl_FragCoord', [x, y, llSplat(0), llSplat(1)]);
    for (const u of m.uniforms) {
      const comps = [];
      for (let i = 0; i < llNComp(u.ty); i++) comps.push(load(slot++));
      this.bind(u.name, comps);
    }
    for (const c of m.consts) this.bind(c.name, this.expr(c.init));
    const o = m.outs[0];
    const on = llNComp(o.ty);
    this.bind(o.name, new Array(on).fill(llSplat(0)));
    this.stmt(m.funcs[0].body);
    /* 写回：四格连着存。 */
    const vals = this.find(o.name);
    for (let i = 0; i < on; i++) {
      const p = i === 0 ? '%out' : this.emit(`getelementptr ${LL_VEC}, ptr %out, i64 ${i}`);
      this.body.push(`  store ${LL_VEC} ${vals[i]}, ptr ${p}, align 4`);
    }
    const decls = [...this.need].sort()
      .map((f) => `declare ${LL_VEC} @${f}.v${GLSL_LANES}f32(${new Array(f === 'llvm.pow' || f === 'llvm.minnum' || f === 'llvm.maxnum' ? 2 : 1).fill(LL_VEC).join(', ')})`);
    return `; GLSL -> LLVM IR（${GLSL_LANES} 道 f32 SoA）—— ADR-0019 决策六快路\n`
      + `; in = [x, y, uniform 每一格…]；out = [r, g, b, a]，都是 ${LL_VEC}\n`
      + `define void @glsl_frag8(ptr %in, ptr %out) {\n${this.body.join('\n')}\n  ret void\n}\n\n`
      + `${decls.join('\n')}\n`;
  }
}

/** GLSL 的 checked 模块 -> 一份 `.ll` 文本（只含 `@glsl_frag8` 与它要的 declare）。 */
export function glslEmitLlvm(mod) {
  return new GlslLlvmEmitter(mod).run();
}
