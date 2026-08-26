/**
 * MIR —— 语言中立的中层 IR（ADR-0014 决策 6）。
 *
 * 职责边界（照 ADR）：SSA、显式类型、结构化控制流、可哈希、四个后端都能消费。
 * **不做优化**：没有 pass 管线、没有寄存器分配、没有指令选择。
 *
 * 三条与 ADR 原文不同的地方，都是落地时量出来的，理由写在这里：
 *
 * 1. **可变局部量走内存槽，不做 phi**。ADR 只说了「SSA」。纯 SSA + 结构化控制流要么
 *    带 phi（就得先有 CFG 与支配树），要么给区域加块参数（MLIR/SIL 那套）。两条都要
 *    在这一层写一个 SSA 构造器，而它的产物 **LLVM 的 mem2reg 立刻会再算一遍**。
 *    所以：**表达式的值是 SSA（每条指令定义一次、不可变），可变变量是 `SLOT` +
 *    `LOAD`/`STORE`**。clang -O0 出来的 IR 就是这个形状；SPIR-V 的 Function 存储类
 *    变量也是；而闭包解释器要的恰恰是「值栈上的窗口 + 槽位」（ADR-0013 决策 3）。
 *    代价是 MIR 自己不做常量传播 —— 本来也不做。
 *
 * 2. **结构化控制流用扁平的标记指令表达**，不是嵌套的树对象：
 *    `IF/ELSE/END`、`LOOP/END`、`BR/BRIF`（按层数跳），和 wasm 的结构化编码同形。
 *    ADR 要求「结构化控制流保留到后端内部才拆」——标记法保留了全部结构信息
 *    （SPIR-V 的 merge 块、解释器要的树，都能从标记恢复），同时让指令数组仍然是
 *    **定长记录的线性表**，于是「8 字节一条」和「按字节哈希」这两条不必让步。
 *    与 wasm 的唯一区别：**操作数是显式的 ref，不是隐式的求值栈** —— 栈式编码会
 *    让「同一条指令的输入是谁」变成要模拟栈才能知道的事，四个后端都得各模拟一遍。
 *
 * 3. **一条指令是五个字段**：`op`(8) `t`(8) `a`(16) `b`(16) `aux`(16) = 8 字节。
 *    LuaJIT 的第五个字段是 `prev`（CSE 链表，`lj_ir.h:493..529`），我们不做 CSE，
 *    这 16 位改作第三个操作数位 —— 调用点要 `(函数, 实参池起点, 实参个数)` 三样。
 *
 * 抄 LuaJIT 的部分（量过 `reference/gsl-shell/luajit2`，2.0.2）：
 *   - 常量与指令共用一个 16 位下标空间，**中点 `REF_BIAS = 0x8000`**：常量往下长、
 *     指令往上长（`lj_ir.h:416..425`）。于是「是不是常量」= 一次整数比较，
 *     遍历操作数不用查操作数模式表（`:427..439` 那段注释就是这个动机）。
 *   - **opcode 的编号顺序当数据结构用**（`lj_ir.h:154..158`）：这里是 `EQ..GE` 六条
 *     连号，取反比较 = `op ^ 1`，见 `negCmp`。
 *   - 一张宏列表展开出多张表（`IRDEF`，`lj_ir.h:14..141`）：这里是 `OPS` 一张源，
 *     展开出 opcode 常量、名字表、操作数模式表。加一条 op 只改一行。
 *
 * 宿主约束：这份代码要能被编译器自己编译，所以只许用封闭 ABI 里的东西
 * （ADR-0011 决策 2）—— 没有 TypedArray/DataView，8 字节编码是**序列化时**才成型的
 * （见 mir/bytes.js），内存里是五个平行数组（SoA）。
 */

/* ------------------------------------------------------------------ 类型码
 * `t` 字段 8 位。低 5 位是种类，高 3 位是「向量宽度的对数」——
 * `vec(T,N)` 因此不需要额外的类型表：宽度 1/2/4/8/16/32/64/128 覆盖到 AVX-512。
 * 聚合（struct/class/enum/list/dict/set/fn）在 MIR 里只是「一个引用」，
 * 它的具体身份挂在指令的 `aux`（指向模块的类型池），不占 `t` 的位。
 */
export const T_VOID = 0;
export const T_I64 = 1;
export const T_F64 = 2;
export const T_BOOL = 3;
export const T_STR = 4;   // Omni string：UTF-8 字节序列（ADR-0005）
export const T_DYN = 5;   // omni_dyn：16 字节聚合，MIR 里不是特例
export const T_PTR = 6;   // ptr(T, addrspace)：addrspace 在 aux 的高 4 位
export const T_AGG = 7;   // struct/class/enum/容器/函数值：身份在 aux
export const T_KIND_BITS = 5;
export const T_KIND_MASK = 31;

export const TYPE_NAMES = ['void', 'i64', 'f64', 'bool', 'str', 'dyn', 'ptr', 'agg'];

/** `t` 字段：种类 + 向量宽度（1 = 标量）。宽度必须是 2 的幂。 */
export function mkType(kind, lanes) {
  const n = lanes === undefined ? 1 : lanes;
  let log = 0;
  let w = n;
  while (w > 1) { w = w / 2; log++; }
  return kind | (log << T_KIND_BITS);
}
export function typeKind(t) { return t & T_KIND_MASK; }
export function typeLanes(t) {
  let n = 1;
  let log = t >> T_KIND_BITS;
  while (log > 0) { n = n * 2; log--; }
  return n;
}
export function typeText(t) {
  const lanes = typeLanes(t);
  const base = TYPE_NAMES[typeKind(t)];
  return lanes === 1 ? base : `vec(${base},${lanes})`;
}

/* ------------------------------------------------------------------- ref
 * 16 位下标空间的中点。常量在 `[0, REF_BIAS)`，指令在 `[REF_BIAS, 0xffff]`。
 * 「是不是常量」= `ref < REF_BIAS`，一次比较。
 */
export const REF_BIAS = 0x8000;
export const REF_NONE = 0xffff;  // 「没有操作数」。指令上界因此是 0xfffe，够用：
                                 // 一个函数体超过 32766 条指令的话，那个函数本身有问题。

export function isConstRef(ref) { return ref < REF_BIAS; }
export function refText(ref) {
  if (ref === REF_NONE) return '-';
  return isConstRef(ref) ? `k${ref}` : `%${ref - REF_BIAS}`;
}

/* ------------------------------------------------------------------- op 表
 * 一张源，三种展开。每行是 `[名字, a 的角色, b 的角色, aux 的角色]`，角色取：
 *   'r' 值 ref（要跟着重编号/要被访问）   's' 槽位号
 *   'p' 实参池起点 —— **池是自描述的**：`args[起点]` 是个数，随后是那么多个 ref。
 *       个数不占 aux，于是 aux 能腾出来放类型号/访问描述符号，四个操作数的指令
 *       （`o[i] = v`、`o.f = v`）因此不必再分裂成两条。
 *   'n' 整数字面量（类型号 / 访问号 / 层数 / 标签…）   '-' 不用
 * 顺序**有意义**：EQ..GT 六条连号（`op ^ 1` 取反），LOAD/STORE 相邻。
 */
const OPS = [
  // ---- 区域标记（结构化控制流）。END 关掉最近一个未关的 IF/ELSE/LOOP/BLOCK。
  // BR 的层数语义与 wasm 逐条相同：跳到 BLOCK = 跳到它的 END 之后（break），
  // 跳到 LOOP = 回到循环头（continue）。照抄是有理由的 —— 这个仓库已经有一个
  // WAT 前端，两处用同一套层数语义，读代码的人不用在脑子里维护两张表。
  ['BLOCK', '-', '-', '-'],
  ['LOOP', '-', '-', '-'],
  ['IF', 'r', '-', '-'],        // a = 条件（T_BOOL）
  ['ELSE', '-', '-', '-'],
  ['END', '-', '-', '-'],
  ['BR', '-', '-', 'n'],        // aux = 往外数第几层（0 = 最内层）
  ['BRIF', 'r', '-', 'n'],
  ['RET', 'r', '-', '-'],       // a = REF_NONE 表示无返回值

  // ---- 槽位与模块级变量
  ['LOAD', '-', '-', 's'],
  ['STORE', 'r', '-', 's'],     // a 存进 aux 号槽
  ['GLOAD', '-', '-', 'n'],     // 模块级变量（JS 前端的 jsGlobals）
  ['GSTORE', 'r', '-', 'n'],

  // ---- 算术。类型全在 `t` 上：i64/f64/vec 走同一条 op。
  ['ADD', 'r', 'r', '-'],       // t=T_STR 时是拼接
  ['SUB', 'r', 'r', '-'],
  ['MUL', 'r', 'r', '-'],
  ['DIV', 'r', 'r', '-'],
  ['MOD', 'r', 'r', '-'],
  ['NEG', 'r', '-', '-'],
  ['SHL', 'r', 'r', '-'],
  ['SHR', 'r', 'r', '-'],
  ['BAND', 'r', 'r', '-'],
  ['BOR', 'r', 'r', '-'],
  ['BXOR', 'r', 'r', '-'],
  ['BNOT', 'r', '-', '-'],
  ['NOT', 'r', '-', '-'],       // 逻辑非，只作用在 T_BOOL

  // ---- 比较：六条连号，`op ^ 1` 是取反（EQ<->NE, LT<->GE, LE<->GT）。
  // `t` 是**操作数**的类型，结果永远是 T_BOOL —— 这一条要记住，否则 dyn 比较会丢信息。
  ['EQ', 'r', 'r', '-'],
  ['NE', 'r', 'r', '-'],
  ['LT', 'r', 'r', '-'],
  ['GE', 'r', 'r', '-'],
  ['LE', 'r', 'r', '-'],
  ['GT', 'r', 'r', '-'],

  // ---- 转换。aux = 转换模式（CVT_* 常量）
  ['CVT', 'r', '-', 'n'],

  // ---- 聚合与容器。身份（哪个 struct / 哪种容器）在 aux -> 模块的类型池；
  // 字段访问在 aux -> 访问描述符池（类型号 + 字段名），因为 8 字节里塞不下两个 16 位。
  ['NEW', '-', '-', 'n'],       // struct/class 零值、空容器：aux = 类型号
  ['COPY', 'r', '-', 'n'],      // 值语义的深拷贝（struct/enum，ADR-0005）
  ['FLD', 'r', '-', 'n'],       // aux = 访问号
  ['FLDSET', 'r', 'r', 'n'],    // a.字段 = b
  ['MKENUM', 'n', 'p', 'n'],    // a = 标签下标，b = 载荷池，aux = 类型号（ADR-0012）
  ['ETAG', 'r', '-', 'n'],      // 读标签
  ['IDXGET', 'r', 'r', 'n'],    // aux = 接收者类型号（list 与 dict 语义不同）
  ['IDXSET', 'r', 'p', 'n'],    // a = 接收者，池 = [下标, 值]
  ['AGGLIT', '-', 'p', 'n'],    // list/set 字面量：池 = 元素；dict = [k,v,k,v…]

  // ---- 调用。实参在自描述的池里。
  ['CALL', 'n', 'p', '-'],      // a = 函数表下标
  // a = 函数值（闭包记录）。aux 记调用约定：0 = 位置实参（Omni 域），
  // 1 = 实参是**一条实参表**（JS 域的动态调用，ADR-0011 第 1 节：JS 函数只有这一个签名）。
  ['CALLFN', 'r', 'p', 'n'],
  ['CALLOP', 'n', 'p', '-'],    // a = 运行时 op 号（封闭 ABI + Omni 内建，见 MirModule.ops）
  ['CCALL', 'n', 'p', '-'],     // a = C_ABI 入口号（ADR-0014 决策 4）
  ['CLOSURE', 'n', 'p', '-'],   // a = 闭包模板号，池 = 捕获值
  ['CAPTURE', '-', '-', 'n'],   // 闭包体里读第 aux 个捕获
];

/** opcode 常量：`OP.ADD` 等。加 op 只改 OPS 一行。 */
export const OP = {};
export const OP_NAMES = [];
export const OP_MODES = [];
// 展开：`for (let i = ...)` 在模块顶层会被降级器判成「循环变量可能被闭包捕获」
// （封闭子集的保守规则），所以用 for-of + 一个显式计数器。
let opNoCounter = 0;
for (const row of OPS) {
  OP[row[0]] = opNoCounter;
  OP_NAMES.push(row[0]);
  OP_MODES.push([row[1], row[2], row[3]]);
  opNoCounter++;
}

/** 取反比较：靠编号算术，不用 switch（LuaJIT `lj_ir.h:154..158` 的做法）。 */
export function negCmp(op) {
  if (op < OP.EQ || op > OP.GT) throw new Error(`negCmp: ${OP_NAMES[op]} 不是比较`);
  return op ^ 1;
}

/** 开一个区域的 op（要配一条 END）。 */
export function opensRegion(op) {
  return op === OP.BLOCK || op === OP.LOOP || op === OP.IF;
}

/* ---------------------------------------------------------------- 转换模式 */
export const CVT_I2F = 0;   // int -> real
export const CVT_F2I = 1;   // trunc
export const CVT_BOX = 2;   // T -> dyn
export const CVT_UNBOX = 3; // dyn -> T（带标签检查，检查由运行时做）
export const CVT_BITCAST = 4;
export const CVT_NAMES = ['i2f', 'f2i', 'box', 'unbox', 'bitcast'];

/* ------------------------------------------------------------------ 常量池
 * 常量也是「有类型的记录」，因为 `t` 只在指令上。池按 (类型码, 文本) 去重 ——
 * 去重是**哈希稳定性**的前提：同一个函数体两次编译要得到同一串字节（ADR-0014 决策 5）。
 */
export class ConstPool {
  constructor() {
    this.items = [];      // {t, kind:'int'|'real'|'str'|'bool'|'null', text}
    this.index = new Map();
  }

  intern(t, kind, text) {
    const key = `${t}|${kind}|${text}`;
    const hit = this.index.get(key);
    if (hit !== undefined) return hit;
    const ref = this.items.length;
    if (ref >= REF_BIAS) throw new Error('mir: 常量池超过 32768 条');
    this.items.push({ t, kind, text });
    this.index.set(key, ref);
    return ref;
  }

  int(v) { return this.intern(T_I64, 'int', String(v)); }
  real(text) { return this.intern(T_F64, 'real', text); }
  bool(v) { return this.intern(T_BOOL, 'bool', v ? 'true' : 'false'); }
  str(s) { return this.intern(T_STR, 'str', s); }
  nul(t) { return this.intern(t, 'null', 'null'); }
  get(ref) { return this.items[ref]; }
}

/* -------------------------------------------------------------- 函数与模块 */

/**
 * 一个函数的 MIR。指令是五个平行数组（SoA）—— 见文件头第 3 条：
 * 「8 字节一条」是序列化时的事实，内存里 SoA 更适合宿主是 JS 的这一代。
 */
export class MirFunc {
  constructor(name, params, ret) {
    this.name = name;
    this.params = params;    // [{name, t, slot}]
    this.ret = ret;          // 类型码
    this.op = [];
    this.t = [];
    this.a = [];
    this.b = [];
    this.aux = [];
    this.slots = [];         // [{name, t}]，下标就是槽号
    this.args = [];          // 实参池：一串 ref，指令用 (起点, 个数) 指进来
    this.closureId = undefined;  // 闭包体：第一个隐含形参是闭包记录
  }

  /** 指令条数。刻意是方法而不是 getter —— 访问器不在语言子集里（ADR-0011）。 */
  count() { return this.op.length; }

  /** 追加一条指令，返回它的 ref。 */
  emit(op, t, a, b, aux) {
    const i = this.op.length;
    if (i + REF_BIAS >= REF_NONE) throw new Error(`mir: 函数 ${this.name} 超过 32766 条指令`);
    this.op.push(op);
    this.t.push(t);
    this.a.push(a === undefined ? REF_NONE : a);
    this.b.push(b === undefined ? REF_NONE : b);
    this.aux.push(aux === undefined ? 0 : aux);
    return i + REF_BIAS;
  }

  /** 指令 ref -> 下标。常量 ref 传进来是调用方的 bug，所以直接炸。 */
  at(ref) {
    if (isConstRef(ref)) throw new Error(`mir: ${refText(ref)} 是常量，没有指令`);
    return ref - REF_BIAS;
  }

  opOf(ref) { return this.op[this.at(ref)]; }

  /**
   * 一个 ref **产出的值**的类型。
   *
   * 注意与 `t` 字段的区别：比较指令的 `t` 是**操作数**的类型（`dyn` 比较靠它才认得出来），
   * 产出的却永远是 bool。这两者混起来过一次 —— verifier 拿 `t` 当结果类型，于是
   * 每个 `if (a < b)` 都被判成「条件不是 bool」。所以：读结果类型一律走这个方法，
   * 只有真的要看操作数类型时才碰 `t`。
   */
  typeOf(ref, consts) {
    if (isConstRef(ref)) return consts.get(ref).t;
    const i = this.at(ref);
    const op = this.op[i];
    if (op >= OP.EQ && op <= OP.GT) return T_BOOL;
    return this.t[i];
  }

  slot(name, t) {
    this.slots.push({ name, t });
    return this.slots.length - 1;
  }

  /** 把一串 ref 放进实参池，返回起点。池是自描述的：起点处先放个数。 */
  pushArgs(refs) {
    const at = this.args.length;
    this.args.push(refs.length);
    for (const r of refs) this.args.push(r);
    return at;
  }

  /** 读回池里那一串 ref。 */
  argsOf(at) {
    const n = this.args[at];
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.args[at + 1 + i]);
    return out;
  }
}

/** 一个模块的 MIR。类型池收「MIR 不关心内部结构，但后端要认得」的那些身份。 */
export class MirModule {
  constructor(entry) {
    this.entry = entry;
    this.consts = new ConstPool();
    this.funcs = [];
    this.funcIndex = new Map();   // 名字 -> 下标（CALL 的 a 字段）
    this.types = [];              // [{kind, name, fields?}]，AGG 的身份
    this.typeIndex = new Map();
    this.globals = [];            // 模块级变量名，GLOAD/GSTORE 的 aux
    this.globalIndex = new Map();
    this.ops = [];                // {name, lits}：运行时 op，CALLOP 的 a
    this.opIndex = new Map();
    this.accs = [];               // {type, field}：字段访问描述符，FLD/FLDSET 的 aux
    this.accIndex = new Map();
    this.cabi = [];               // C_ABI 入口名，CCALL 的 a
    this.cabiIndex = new Map();
    this.closures = [];           // {make, funcName, captures:[名字]}
  }

  addFunc(f) {
    this.funcIndex.set(f.name, this.funcs.length);
    this.funcs.push(f);
    return this.funcs.length - 1;
  }

  funcNo(name) {
    const i = this.funcIndex.get(name);
    if (i === undefined) throw new Error(`mir: 没有这个函数 ${name}`);
    return i;
  }

  /** 类型身份去重。key 用 OIR 的 typeKey，保证同一个类型只进一次。 */
  typeNo(key, info) {
    const hit = this.typeIndex.get(key);
    if (hit !== undefined) return hit;
    const i = this.types.length;
    this.types.push(info);
    this.typeIndex.set(key, i);
    return i;
  }

  globalNo(name) {
    const hit = this.globalIndex.get(name);
    if (hit !== undefined) return hit;
    const i = this.globals.length;
    this.globals.push(name);
    this.globalIndex.set(name, i);
    return i;
  }

  /**
   * 运行时 op。名字是**单态**的（`len.list`、`print.int`）—— MIR 不带 OIR 的
   * recvType/argType 字段，多态信息进名字，于是后端与解释器查一次表就够。
   * `lits` 是编译期常量实参（封闭 ABI 里 `lit:` 那些，见 hir/js_abi.js）。
   */
  opNo(name, lits) {
    const ls = lits === undefined ? [] : lits;
    const key = `${name}|${JSON.stringify(ls)}`;
    const hit = this.opIndex.get(key);
    if (hit !== undefined) return hit;
    const i = this.ops.length;
    this.ops.push({ name, lits: ls });
    this.opIndex.set(key, i);
    return i;
  }

  /** 字段访问描述符：(类型号, 字段名)。名字而非下标 —— enum 的载荷是按变体摊平的。 */
  accNo(type, field) {
    const key = `${type}.${field}`;
    const hit = this.accIndex.get(key);
    if (hit !== undefined) return hit;
    const i = this.accs.length;
    this.accs.push({ type, field });
    this.accIndex.set(key, i);
    return i;
  }

  cabiNo(entry) {
    const hit = this.cabiIndex.get(entry);
    if (hit !== undefined) return hit;
    const i = this.cabi.length;
    this.cabi.push(entry);
    this.cabiIndex.set(entry, i);
    return i;
  }
}
