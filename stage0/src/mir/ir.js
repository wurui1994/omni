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
export const T_PTR = 6;   // fat 指针（ADR-0016）：三个字 {addr, base, end}，一个码管所有目标类型 ——
                          // 目标只在 PLOAD/PSTORE 的 `t` 上出现，与缓冲同一条理由。
                          // （原来这一格写的是"ptr(T, addrspace)"，那时没有指针，是占位。
                          //  addrspace 真要用的时候再另立一格：模拟指针这一路根本没有它。）
export const T_AGG = 7;   // struct/class/enum/容器/函数值：身份在 aux
export const T_BUF = 8;   // 缓冲：{长度, 指针}（ADR-0014 门槛 7）。元素类型**不在这个码里** ——
                          // 指针在 LLVM 里早就是不透明的，元素只在 BGET/BSET 的 `t` 上出现，
                          // 于是「一个缓冲」这件事一个码就够，不必按元素分裂成两个码。
export const T_ARR = 9;   // 可增长数组：**一个指针**（长度会变，所以长度不能跟着值走）。
                          // 元素类型同样不在这个码里：种类在 AGET/ASET/APOP 的 `t` 上，
                          // **完整的**元素类型（含 struct/class 的身份）在 aux 指的类型池项
                          // 的 `oir.elem` 上 —— 第十八刀加的，见 OPS 里数组那一段。
export const T_TPTR = 10; // thin 指针（ADR-0016）：**一个字**。与 T_PTR 分成两个码而不是在 aux
                          // 上加一位，因为它们在 LLVM 那条腿上是真正不同的类型（三字结构体
                          // vs 一个 i8*），而 aux 已经被步长占了。指针的胖瘦于是从 `t` 就看得出，
                          // 不必回头查操作数是怎么产生的。
// ---- 机器宽度的两格（ADR-0017 第一刀）。C 与 wasm 要的是**真的 32 位**，不是
// 「存成符号扩展的 64 位、每步再回绕」——`frontend-wat/lower.js:61` 那招在 wasm 的小子集里
// 够用，但 C 里每一个 `int` 运算都要回绕，等于给每条算术加两条指令，吞吐和码质量一起赔。
// `float` 更没得商量：它的舍入与 double 不同，用 double 冒充会在与 tcc/clang 的三方比对里露馅。
export const T_I32 = 11;  // 32 位整数。**规范形是符号扩展后的值**（宿主表示仍是 bigint）：
                          // 无符号那一族（UDIV/USHR/ULT…）照旧靠零扩展一步做对，与 T_I64 同一条路数。
export const T_F32 = 12;  // 单精度。宿主表示是 Number，但每一步之后要 Math.fround ——
                          // 「算完再舍入一次」与硬件的 single 运算等价（IEEE-754 的双舍入
                          // 在 double 中间值 + fround 这一组合下不会发生，见 f32 那组用例）。
export const T_KIND_BITS = 5;
export const T_KIND_MASK = 31;
export const T_KIND_SPAN = 32;   // = 2^T_KIND_BITS。位运算不可用，见 mkType

export const TYPE_NAMES = ['void', 'i64', 'f64', 'bool', 'str', 'dyn', 'ptr', 'agg', 'buf', 'arr', 'tptr', 'i32', 'f32'];

/** 是不是整数类型（i32/i64）。宽度见 intBits。 */
export function isIntType(t) { const k = typeKind(t); return k === T_I64 || k === T_I32; }
/** 是不是浮点类型（f32/f64）。 */
export function isFloatType(t) { const k = typeKind(t); return k === T_F64 || k === T_F32; }
/** 整数的位宽。非整数返回 0 —— 调用方拿它当"要不要回绕"的开关。 */
export function intBits(t) {
  const k = typeKind(t);
  if (k === T_I64) return 64;
  if (k === T_I32) return 32;
  return 0;
}

/**
 * `t` 字段：种类 + 向量宽度（1 = 标量）。宽度必须是 2 的幂。
 *
 * 布局是位域，但**这里只能用乘除取模**：封闭 ABI 的 `js_bitop` 只对 bigint 成立
 * （ADR-0011 决策 2），而这些量在 JS 子集里全是 real —— `kind | (log << 5)` 在 node 上
 * 照跑，在原生构建里当场报「bitwise '>' requires bigint operands」。
 * 这个洞是 `omni incr` 那条自举门槛抓出来的：在它之前 MIR 从没在原生构建里跑过。
 */
export function mkType(kind, lanes) {
  const n = lanes === undefined ? 1 : lanes;
  let log = 0;
  let w = n;
  while (w > 1) { w = w / 2; log++; }
  return kind + log * T_KIND_SPAN;
}
export function typeKind(t) { return t % T_KIND_SPAN; }
export function typeLanes(t) {
  let n = 1;
  let log = (t - (t % T_KIND_SPAN)) / T_KIND_SPAN;
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

  // ---- 向量（ADR-0014 决策 6 / 门槛 6 第一阶段）。宽度已经在 `t` 的高 3 位上，
  // 所以这三条不用类型池：`t` 自己就说清了"哪种向量"。
  // **刻意没有 HSUM**：水平求和在 OIR -> MIR 那一步就展开成「逐道 VEXT + 左到右的 ADD 链」，
  // 于是求值树是 MIR 里看得见的指令序列，两个 MIR 消费者（LLVM、闭包解释器）
  // 没有"各挑一个规约形状"的余地 —— 那正是门槛 6 要钉的东西。
  ['VSPLAT', 'r', '-', '-'],    // t = 向量类型，a = 标量（铺满所有道）
  ['VINS', 'r', 'r', 'n'],      // a = 向量，b = 标量，aux = 第几道
  ['VEXT', 'r', '-', 'n'],      // a = 向量，aux = 第几道；t = **元素**类型（= 结果类型）

  // ---- 缓冲（ADR-0014 门槛 7 第一阶段）。`{长度, 指针}`，引用语义。
  // 越界在 CPU 那几条腿上是运行期错误；GPU 上约定 kernel 自己用 BLEN 守门。
  ['BNEW', 'r', '-', 'n'],      // a = 长度，t = T_BUF，aux = 元素类型码（要按它算步长与零值）
  ['BLEN', 'r', '-', '-'],      // a = 缓冲，t = T_I64
  ['BGET', 'r', 'r', '-'],      // a = 缓冲，b = 下标；t = 元素类型（= 结果类型）
  ['BSET', 'r', 'p', '-'],      // a = 缓冲，池 = [下标, 值]；t = 元素类型

  // ---- 数组（ADR-0014 门槛 2 第四刀）。一个指针，引用语义，长度会变。
  // 六条都落到运行时的 omni_arr_* 符号上（run-c 与 run-llvm 调同一个），
  // 所以越界与空 pop 的消息在两条腿上不可能分叉。
  // **aux = 数组类型号**（-> 模块的类型池，第十八刀改的）：元素的种类原来只有 `t` 那 8 位，
  // 而 T_AGG 里 struct（值语义，格子躺内容）与 class（引用语义，格子躺句柄）是同一个码 ——
  // 后端照那个码发指令就只能猜。类型池上挂着 `oir`，元素类型于是是**完整的**。
  ['ANEW', 'r', 'r', 'n'],      // a = 长度，b = 元素零值，t = T_ARR，aux = 数组类型号
  ['ALEN', 'r', '-', '-'],      // a = 数组，t = T_I64（长度不看元素，所以这条不用身份）
  ['AGET', 'r', 'r', 'n'],      // a = 数组，b = 下标；t = 元素类型（= 结果类型）
  ['ASET', 'r', 'p', 'n'],      // a = 数组，池 = [下标, 值]；t = 元素类型
  ['APUSH', 'r', 'r', 'n'],     // a = 数组，b = 值；t = 元素类型
  ['APOP', 'r', '-', 'n'],      // a = 数组；t = 元素类型

  // ---- 指针（ADR-0016）。`t` 是 T_PTR（fat，三个字）或 T_TPTR（thin，一个字）；
  // 读写那两条的 `t` 是**目标**类型（= 结果类型），与缓冲同一条路数。
  // **aux 一律是字节步长**，不放胖瘦（胖瘦在 `t` 上）。
  // 刻意没有 PFIELD：字段地址就是 `PADD(p, 常量偏移, 步长=1)` —— 多一条 op 就多一处
  // 两个消费者可能各自解释的地方，而这条恒等式在两条腿上都是同一句加法。
  ['PNEW', 'r', '-', 'n'],      // a = 个数，t = T_PTR，aux = 元素字节数（按它算总字节并清零）
  ['PNULL', '-', '-', '-'],     // 空指针，t = T_PTR 或 T_TPTR
  ['PISNULL', 'r', '-', '-'],   // a = 指针，t = T_BOOL（不解引用，所以不检查范围）
  ['PTHIN', 'r', '-', '-'],     // a = fat 指针，t = T_TPTR（把范围丢掉：只许在 unsafe 里）
  ['PLOAD', 'r', '-', 'n'],     // a = 指针，t = 目标类型，aux = 步长（= 检查用的字节数）
  ['PSTORE', 'r', 'r', 'n'],    // a = 指针，b = 值，t = 目标类型，aux = 步长
  ['PADD', 'r', 'r', 'n'],      // a = 指针，b = 元素个数（i64），aux = 步长；t 跟着 a
  ['PSUB', 'r', 'r', 'n'],      // a、b = 同一块里的两个指针，aux = 步长，t = T_I64
  // 指针相等。不走 CMP：那一条按 `t` 上的类型比值，而 fat 是三个字（C 里结构体没有
  // `==`、JS 里数组比的是引用）。只比**地址那一个字** —— 那件事在 arena 与真指针
  // 两套实现下都有定义。刻意没有 PLT 之类：块间的次序两套实现不一样。
  ['PEQ', 'r', 'r', '-'],       // a、b = 两个同型指针，t = T_BOOL；跨块也有定义（不等）

  // ---- 无符号那七条（ADR-0016 第六十一刀）。方言只有一格整数、规范形是有符号 64 位；
  // 无符号性挂在**算子**上（LLVM 的 udiv/sdiv、icmp ult/slt 是同一条路子）。
  // 补码下 ADD/SUB/MUL/BAND/BOR/BXOR/SHL/EQ/NE 两种解释的位一模一样，所以只多这七条。
  // **接在表尾**而不是插在 DIV / LT 旁边：opcode 是这张表的下标，插进去要把后面全部重编号。
  ['UDIV', 'r', 'r', '-'],
  ['UMOD', 'r', 'r', '-'],
  ['USHR', 'r', 'r', '-'],
  // 四条连号，`op ^ 1` 照旧是取反（ULT<->UGE, ULE<->UGT）—— 见 negCmp。
  ['ULT', 'r', 'r', '-'],
  ['UGE', 'r', 'r', '-'],
  ['ULE', 'r', 'r', '-'],
  ['UGT', 'r', 'r', '-'],

  // ---- 线性内存（ADR-0017 第二刀）。**一整个模块一块**，按字节寻址，长度是 64KB 页的
  // 整数倍。形状照 wasm 规范，不自创：`MGROW` 只增不减、失败回 -1（不抛错）；越界访问
  // 是运行期错误。地址 0 是合法字节，但第 0 页整页保留不用 —— C 的空指针要能与它区分。
  //
  // 与 T_PTR/T_TPTR（ADR-0016）的关系：那两个是「一块一块的分配」加范围检查，
  // 这一块是「一整片可寻址的字节」。C 前端要的是后者（`&x`、`memcpy`、影子栈都在这片上），
  // 模拟实现里 fat 指针的 addr 本来就是 arena 的字节偏移，两者是同一件事的两种视角。
  //
  // 访问描述符全在 aux 上（`memDesc` 打包：静态偏移 * 16 + 宽度符号号），所以
  // `i64.load32_u` 那一族**不是**几十条 op，而是这两条 + 一个描述符。
  ['MSIZE', '-', '-', '-'],     // t = T_I64，当前页数
  ['MGROW', 'r', '-', '-'],     // a = 要加的页数，t = T_I64；回**旧**页数，失败回 -1
  ['MLOAD', 'r', '-', 'n'],     // a = 地址，t = 结果类型，aux = 描述符（MLOAD_KINDS）
  ['MSTORE', 'r', 'r', 'n'],    // a = 地址，b = 值，t = 值类型，aux = 描述符（MSTORE_KINDS）
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

/**
 * 是不是一条比较（有符号那六个 EQ..GT，加第六十一刀的无符号四个 ULT..UGT）。
 * 比较的产出类型永远是 bool，`t` 是**操作数**的类型 —— 分成两段连号之后"是不是比较"
 * 这一问就不再是一条区间判断了，所以收在这儿一处：漏掉一段的后果是每个
 * `if (a u< b)` 都被 verifier 判成「条件不是 bool」（第六十一刀真踩过）。
 */
export const isCmp = (op) => (op >= OP.EQ && op <= OP.GT) || (op >= OP.ULT && op <= OP.UGT);

/**
 * 取反比较：靠编号算术，不用 switch（LuaJIT `lj_ir.h:154..158` 的做法）。
 * 它那边是 `op ^ 1`，这里只能是「偶数 +1、奇数 -1」—— 同一件事，理由见 mkType。
 */
export function negCmp(op) {
  if (!isCmp(op)) throw new Error(`negCmp: ${OP_NAMES[op]} 不是比较`);
  // 两段都是连号的偶奇对，所以同一句算术管两段 —— 前提是 ULT 落在偶数上，
  // 而它落在哪儿由表尾的位置定，所以这儿断言一下，别让以后加 op 的人踩着。
  if (op >= OP.ULT && OP.ULT % 2 !== 0) throw new Error('negCmp: ULT 要落在偶数号上');
  return op % 2 === 0 ? op + 1 : op - 1;
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
// 位当无符号 64 位读再转 real（ADR-0016 第六十一刀）。与 CVT_I2F 差的只有"怎么读那 64 位"：
// LLVM 是 uitofp 对 sitofp、C 是 `(double)(uint64_t)` 对 `(double)`。
export const CVT_U2F = 5;
// ---- 宽度转换（ADR-0017 第一刀）。**只有整数之间与浮点之间需要模式**：
// 整数与浮点之间那三条（I2F / F2I / U2F）已经能靠"操作数的类型 + `t`（结果类型）"分辨
// 到底是 i32 还是 i64、f32 还是 f64 —— 所以不为它们再分裂模式。
// 整数扩宽必须给模式：从 i32 到 i64，符号扩展与零扩展是两件事，光看类型分不出来。
export const CVT_SEXT = 6;    // 整数扩宽，符号扩展（i32 -> i64）
export const CVT_ZEXT = 7;    // 整数扩宽，零扩展（i32 -> i64，把它当无符号读）
export const CVT_TRUNC = 8;   // 整数变窄，回绕（i64 -> i32；结果是符号扩展后的规范形）
// 低 8 / 16 位的符号扩展。wasm 的 `i32.extend8_s` / `extend16_s`，也是 C 的
// `(signed char)x` / `(short)x`。**没有 8/16 位的类型码** —— char 与 short 在寄存器里
// 就是 i32（tcc 与 wasm 都是这么做的），只在存进内存和这两条上才看得见宽度。
export const CVT_SEXT8 = 9;
export const CVT_SEXT16 = 10;
export const CVT_FCVT = 11;   // 浮点之间（f32 <-> f64，方向由 `t` 定）
export const CVT_NAMES = ['i2f', 'f2i', 'box', 'unbox', 'bitcast', 'u2f',
  'sext', 'zext', 'trunc', 'sext8', 'sext16', 'fcvt'];

/* -------------------------------------------- 线性内存的访问描述符（第二刀）
 * wasm 的 `i32.load8_s` / `i64.load32_u` / `f32.store` 那一族，在这里是
 * 「一条 op + 一个描述符」。描述符两格：**宽度加符号**（下面两张表的下标）与
 * **静态偏移**（wasm 的 `offset=` 立即数；C 的 `p->field` 就落在这一格上）。
 *
 * 为什么读侧九个、写侧六个：读的时候「4 个字节怎么变成结果类型的值」要说清符号
 * （`i32u` 是零扩展、`i32s` 是符号扩展），写的时候只是「把低若干位拍进内存」，
 * 没有符号可言 —— 这与 wasm 的指令表一模一样（load 有 `_s`/`_u`，store 没有）。
 *
 * 对齐提示**刻意不进描述符**：wasm 里它只是给引擎的优化提示，不改语义，而我们两套
 * 实现（DataView 与 memcpy）都不要求对齐。留着不做比留一格没人读的字段好。
 */
export const MLOAD_KINDS = ['i8s', 'i8u', 'i16s', 'i16u', 'i32s', 'i32u', 'i64', 'f32', 'f64'];
export const MLOAD_BYTES = [1, 1, 2, 2, 4, 4, 8, 4, 8];
export const MSTORE_KINDS = ['i8', 'i16', 'i32', 'i64', 'f32', 'f64'];
export const MSTORE_BYTES = [1, 2, 4, 8, 4, 8];

/** 描述符打包。低 4 位是宽度符号号（两张表都不到 16 项），其余是静态偏移。 */
export function memDesc(kindNo, off) {
  if (kindNo < 0 || kindNo > 15) throw new Error(`mir: 内存访问号 ${kindNo} 越界`);
  if (off < 0 || !Number.isInteger(off)) throw new Error(`mir: 静态偏移 ${off} 不合法`);
  return off * 16 + kindNo;
}
export function memKindNo(aux) { return aux % 16; }
export function memOff(aux) { return (aux - (aux % 16)) / 16; }
/** 打印用：`i32u@8`（静态偏移为 0 时不带 `@`）。 */
export function memDescText(aux, isLoad) {
  const names = isLoad ? MLOAD_KINDS : MSTORE_KINDS;
  const off = memOff(aux);
  const nm = names[memKindNo(aux)];
  return off === 0 ? nm : `${nm}@${off}`;
}
export function memBytes(aux, isLoad) {
  return (isLoad ? MLOAD_BYTES : MSTORE_BYTES)[memKindNo(aux)];
}
/** 一页 64KB —— wasm 的页大小，两套实现共用这一个常量。 */
export const MEM_PAGE = 65536;

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
  // i32 的常量也存**符号扩展后的十进制**（规范形，见 T_I32）：常量池是按 (类型码, 文本)
  // 去重的，所以 `i32 -1` 与 `i64 -1` 是两条，不会互相顶掉。
  i32(v) { return this.intern(T_I32, 'int', String(v)); }
  real(text) { return this.intern(T_F64, 'real', text); }
  // f32 的常量文本是**已经 fround 过的那个 double 的十进制**（造它的人负责 fround）——
  // 池按文本去重，所以 `f32 0.1` 与 `f64 0.1` 也是两条不同的常量。
  f32(text) { return this.intern(T_F32, 'real', text); }
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
    // GPU 核（ADR-0014 门槛 7）。**标注，不是语义**：六条 CPU 腿完全不看它，
    // SPIR-V 那条腿按它挑要发哪个函数。放在 MirFunc 上而不是另开一张表，是因为
    // 「这个函数是个 kernel」和「它的形参是什么」是同一件事的两半。
    this.kernel = false;
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
    if (isCmp(op)) return T_BOOL;
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
    // 与 globals 同下标的类型码（第二十四刀）。JS 前端那批全是 T_DYN，核心方言的
    // `(global …)` 是真类型。**没有**把类型塞进 globals 的元素里：那个数组的元素是
    // 字符串这件事被 bytes.js 的哈希与 print.js 的清单直接用着，换成对象会静悄悄
    // 改掉「同一份输入两次编译逐字节相同」。
    this.globalTy = [];
    this.ops = [];                // {name, lits}：运行时 op，CALLOP 的 a
    this.opIndex = new Map();
    this.accs = [];               // {type, field}：字段访问描述符，FLD/FLDSET 的 aux
    this.accIndex = new Map();
    this.cabi = [];               // C_ABI 入口名，CCALL 的 a
    this.cabiIndex = new Map();
    this.closures = [];           // {make, funcName, captures:[名字]}
    // 线性内存（第二刀）。`null` = 这个模块不用内存 —— 于是既有的五个前端一个字节都不多发。
    // `{min, max, data}`：页数下界/上界（`max === 0` 表示不设上界），data 是
    // `[{off, bytes:[…]}]`，编译期算好、运行期一次拷进内存。**一个模块一块**（wasm 的
    // MVP 就是这样），所以不用池、不用下标。
    this.mem = null;
  }

  /** 声明线性内存。重复声明是降级器的 bug（一个模块只有一块）。 */
  setMem(min, max) {
    if (this.mem !== null) throw new Error('mir: 线性内存已经声明过了');
    this.mem = { min, max, data: [] };
  }

  /** 加一段初始字节。`bytes` 是 0..255 的数组。 */
  addData(off, bytes) {
    if (this.mem === null) throw new Error('mir: 没有线性内存，data 段无处可放');
    this.mem.data.push({ off, bytes });
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
    this.globalTy.push(T_DYN);
    this.globalIndex.set(name, i);
    return i;
  }

  /** 给一个已登记的全局钉上类型（核心方言的 `(global …)`；不叫就还是 T_DYN）。 */
  setGlobalTy(i, t) { this.globalTy[i] = t; }

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
