/**
 * MIR -> LLVM IR（文本形式）。ADR-0014 决策 3 的第一步。
 *
 * 为什么先出**文本** IR 而不是直接调 C API 建模块：
 *
 *   - 这一层真正的工作量在**降级**（类型映射、槽位变 alloca、结构化控制流拆成基本块），
 *     跟用哪个 API 无关。文本形式让这部分能单独写、单独用快照测、单独用 `llvm-as` 校验。
 *   - JIT 那一步不需要重写它：ORC 那边用 `LLVMParseIRInContext` 读同一份文本就行，
 *     于是 AOT 与 JIT 共用一个发射器，而不是「C API 版」和「文本版」两份语义。
 *     这一条同时省掉几百个 IRBuilder 的 extern-C 声明。
 *
 * 支持面按阶段扩，边界一律**报错而不是给错答案**（与 WAT 前端同一条规矩）：
 *
 *   第一阶段：标量 i64 / f64 / bool / void。
 *   第二阶段：**字符串**。这一步的关键不在代码量，在 ABI —— `omni_str` 是
 *     `{const char *p; int64_t len;}`，16 字节，clang 在 AArch64 上把它降成
 *     `[2 x i64]` 按值传（量出来的，不是猜的：拿一份只声明这些签名的 C 过一遍
 *     `clang -emit-llvm` 看它发什么）。所以这里也必须发 `[2 x i64]`，
 *     一个字节都不能差，否则每一次字符串调用都在悄悄给错答案。
 *   还没做：dyn（24 字节，clang 走**间接传**：入参 `ptr`、返回 `sret`）、
 *     聚合、容器、闭包。它们在 MIR 里都有，缺的是这一层。
 *
 * 语义对齐的硬约束 —— 都源自同一件事：**运行时把热的叶子函数写成 `static inline`，
 * 那不是可链接符号，call 不到**，所以必须在 IR 里原地重建：
 *   - i64 的加减乘取负按无符号回绕（omni.h:325..330），LLVM 不带 nsw 正好是回绕。
 *   - `/` `%` `<<` `>>`（omni.h:329..343）：移位量 `& 63`、除零报错、INT64_MIN / -1 特判。
 *   - 字符串比较（`omni_str_cmp`，omni.h:353..358）：memcmp 前 n 字节，相同则短者在前。
 *     memcmp 本身是真符号，call 得到。
 * 少一条就是一个只在边角上出现的答案分叉，而这类分叉正是多方比对要抓的东西。
 */

import { OmniError } from '../source/diag.js';
import { utf8Bytes } from '../host/utf8.js';
import {
  OP, OP_NAMES, REF_NONE, REF_BIAS, isConstRef, isCmp, typeText, typeKind, typeLanes,
  T_VOID, T_I64, T_F64, T_BOOL, T_STR, T_AGG, T_BUF, T_ARR, T_PTR, T_TPTR, T_I32, T_F32,
  isFloatType, CVT_I2F, CVT_F2I, CVT_F2U, CVT_U2F,
  CVT_SEXT, CVT_ZEXT, CVT_TRUNC, CVT_SEXT8, CVT_SEXT16, CVT_FCVT,
  MLOAD_KINDS, MSTORE_KINDS, memKindNo, memOff, memBytes,
} from '../mir/ir.js';

/**
 * MIR 的类型码 -> LLVM 类型名。表外的一律报错（阶段边界）。
 * `[2 x i64]` 不是「一个长度 2 的数组」这种建模选择，是 clang 对 16 字节聚合的
 * 实参降级结果 —— 我们必须跟它一模一样，见文件头。
 */
const LL_TYPES = new Map([
  [T_VOID, 'void'], [T_I64, 'i64'], [T_F64, 'double'], [T_BOOL, 'i1'], [T_STR, '[2 x i64]'],
  // 机器宽度那两格（ADR-0017 第一刀）：LLVM 这边它们就是一等类型，`add i32` / `fadd float`
  // 各是一条指令 —— 回绕与舍入都由类型自己带着，不像解释器那边要显式 asIntN/fround。
  [T_I32, 'i32'], [T_F32, 'float'],
  // 缓冲：`{长度, 指针}`。这一个不是量出来的 ABI，是**我们自己定的** —— 运行时里没有
  // 任何函数收发缓冲（print 不接受缓冲），所以这条腿只要自洽就够，和 [2 x i64] 那条不同。
  [T_BUF, '{ i64, ptr }'],
  // 数组：就是一个不透明指针。头（len/cap/items）只有运行时看得见 —— 这条腿一个字段
  // 都不摸，六条指令全是 call，所以布局不构成这里与 C 那条腿之间的约定。
  [T_ARR, 'ptr'],
  // 结构体（ADR-0014 门槛 2 第十二刀）：**一个指向自己那块内存的指针**，不是 LLVM 的
  // 一等聚合值。这不是偷懒，是 MIR 决定的：`FLDSET a b` 里的 `a` 是那个聚合的**值**，
  // 指令要就地改它（两个解释器那边就是"在 JS 对象上写字段"）。一等聚合值是 SSA 的，
  // `insertvalue` 出来的是新值，改不到原处 —— 那就要在这一层反推"这个值是从哪个槽装载
  // 来的、再存回去"，一层脆弱的别名分析。值语义靠的是 from_oir 在右值位置发的 `OP.COPY`
  // （形参入口也发一条），所以"句柄可变 + 显式复制"这套在五条腿上是同一个模型。
  [T_AGG, 'ptr'],
  // 指针（ADR-0016）。fat 是 `{addr, base, end}` 的**一等聚合值**：它是值类型，任何操作
  // 都产生新值、从不原地改，所以 SSA 的 insertvalue/extractvalue 正好合身（结构体那条
  // 走句柄的理由 —— FLDSET 要就地改 —— 在这里不成立）。thin 就是一个不透明指针。
  // 这个拼法不是量出来的 ABI，是**我们自己定的**，和缓冲那一条同理：运行时里没有任何
  // 函数按值收发 fat 指针（omni.h 里的真符号一律是平的），所以这条腿只要自洽就够。
  [T_PTR, '{ ptr, ptr, ptr }'],
  [T_TPTR, 'ptr'],
]);

/**
 * 数组元素的 LLVM 拼写。`p` 是**形参/实参**位置的写法，`r` 是**返回**位置的写法 ——
 * 两者对 bool 不一样：clang 把 `bool` 的形参写成 `i1 zeroext`（属性在类型后），
 * 返回写成 `zeroext i1`（属性在类型前）。把两处都写成前者，clang 当场
 * `error: expected value token`（量过，不是查文档查来的）。
 */
const ARR_ELEMS = new Map([
  [T_I64, { p: 'i64', r: 'i64', suffix: 'i64' }],
  [T_F64, { p: 'double', r: 'double', suffix: 'f64' }],
  [T_BOOL, { p: 'i1 zeroext', r: 'zeroext i1', suffix: 'b8' }],
  [T_STR, { p: '[2 x i64]', r: '[2 x i64]', suffix: 'str' }],
]);

/**
 * 支持的运行时 op：单态名字 -> 可链接的 C 符号与签名。
 * 只列**真符号**（omni.h 里声明为函数的那些）；`static inline` 的不能出现在这里。
 */
const RT_OPS = new Map([
  ['print.int', { sym: 'omni_print_int', ret: 'void', params: ['i64'] }],
  ['print.real', { sym: 'omni_print_real', ret: 'void', params: ['double'] }],
  ['print.bool', { sym: 'omni_print_bool', ret: 'void', params: ['i1 zeroext'] }],
  ['print.string', { sym: 'omni_print_string', ret: 'void', params: ['[2 x i64]'] }],
  // `fail`：运行期错误。这条腿原先没有它 —— 补的理由是核心方言现在有 `(fail E)`
  // （被降级的语言有自己的运行期错误，比如 asy 的 angle((0,0)) 就是照搬来的），
  // 而 `omni_fail` 本来就是运行库里的真符号（omni.h），C 那条腿一直在用。
  // 这里不标 noreturn：调用点后面还跟着这一块的收尾指令，标了要另改一处控制流。
  ['fail.string', { sym: 'omni_fail', ret: 'void', params: ['[2 x i64]'] }],
  ['trunc', { sym: 'omni_trunc', ret: 'i64', params: ['double'] }],
  // 同一件事的两个名字：WAT 前端发的是 `trunc`，Omni 前端按接收者单态化成 `trunc.real`
  ['trunc.real', { sym: 'omni_trunc', ret: 'i64', params: ['double'] }],
  // 数值/布尔 -> 字符串。这三条**原先刻意没有**，理由是"没有一份 case 走得到，
  // 没测过的 ABI 断言和猜是一回事"。现在有了：核心方言的 `(tostr E)` 就走它们
  // （ADR-0014 决策 1）。三个都是 omni.h 里声明的真符号，返回 omni_str = [2 x i64]。
  ['to_string.int', { sym: 'omni_str_int', ret: '[2 x i64]', params: ['i64'] }],
  ['to_string.real', { sym: 'omni_str_real', ret: '[2 x i64]', params: ['double'] }],
  ['to_string.bool', { sym: 'omni_str_bool', ret: '[2 x i64]', params: ['i1 zeroext'] }],
  // `(tostr E N)`：按 N 位有效数字。位数是普通 i64 实参，不是常量折进符号名 ——
  // 那样每多一个位数就多一个符号，而 ABI 里多一个 i64 什么都不用改。
  ['to_string_g.real', { sym: 'omni_str_realg', ret: '[2 x i64]', params: ['double', 'i64'] }],
  // `(readtext E)`：整份读一份文本文件。omni_read_text 是 omni.h 里的真符号，
  // 收发都是 omni_str = [2 x i64]（与 to_string.* 那三条同一个拼法）。
  ['read_text.string', { sym: 'omni_read_text', ret: '[2 x i64]', params: ['[2 x i64]'] }],
  // `(getenv E)`：读宿主的一格环境设置（没设回空串）。与上一条同一个拼法。
  ['get_env.string', { sym: 'omni_get_env', ret: '[2 x i64]', params: ['[2 x i64]'] }],
  // `(writetext P E)` / `(runproc CMD)`：另外两个"对外面"的口子，回的都是 i64
  // （写进去的字节数 / 子进程的退出码）。
  ['write_text.string', { sym: 'omni_write_text', ret: 'i64', params: ['[2 x i64]', '[2 x i64]'] }],
  ['run_proc.string', { sym: 'omni_run_proc', ret: 'i64', params: ['[2 x i64]'] }],
  // `(r3render PATH NUMS)`：三维那一档的光栅化（runtime/omni_r3.c）。字符串收发同 read_text，
  // 第二个参数是 `(arr real)` —— 这条腿上数组就是 `ptr`（见 LL_TYPES 的 T_ARR）。
  ['r3_render.string', { sym: 'omni_r3_render', ret: '[2 x i64]', params: ['[2 x i64]', 'ptr'] }],
  // arena 的作用域（omni_mem.c 的 mark/release）
  ['arena_mark.int', { sym: 'omni_arena_mark', ret: 'i64', params: [] }],
  ['arena_release.int', { sym: 'omni_arena_release', ret: 'i64', params: ['i64'] }],
  // real 上的数学函数。刻意 call 运行时的包装而不是发 LLVM 的 intrinsic：`llvm.sqrt.f64`
  // 有 intrinsic，`fmod` / `round` 没有对得上的，统一走一层符号，五条腿就是同一份 libm。
  ['rmath_sqrt.real', { sym: 'omni_r_sqrt', ret: 'double', params: ['double'] }],
  ['rmath_fabs.real', { sym: 'omni_r_fabs', ret: 'double', params: ['double'] }],
  ['rmath_floor.real', { sym: 'omni_r_floor', ret: 'double', params: ['double'] }],
  ['rmath_ceil.real', { sym: 'omni_r_ceil', ret: 'double', params: ['double'] }],
  ['rmath_round.real', { sym: 'omni_r_round', ret: 'double', params: ['double'] }],
  ['rmath_pow.real', { sym: 'omni_r_pow', ret: 'double', params: ['double', 'double'] }],
  ['rmath_fmod.real', { sym: 'omni_r_fmod', ret: 'double', params: ['double', 'double'] }],
  ['rmath_sin.real', { sym: 'omni_r_sin', ret: 'double', params: ['double'] }],
  ['rmath_cos.real', { sym: 'omni_r_cos', ret: 'double', params: ['double'] }],
  ['rmath_tan.real', { sym: 'omni_r_tan', ret: 'double', params: ['double'] }],
  ['rmath_asin.real', { sym: 'omni_r_asin', ret: 'double', params: ['double'] }],
  ['rmath_acos.real', { sym: 'omni_r_acos', ret: 'double', params: ['double'] }],
  ['rmath_atan.real', { sym: 'omni_r_atan', ret: 'double', params: ['double'] }],
  ['rmath_atan2.real', { sym: 'omni_r_atan2', ret: 'double', params: ['double', 'double'] }],
  ['rmath_sinh.real', { sym: 'omni_r_sinh', ret: 'double', params: ['double'] }],
  ['rmath_cosh.real', { sym: 'omni_r_cosh', ret: 'double', params: ['double'] }],
  ['rmath_tanh.real', { sym: 'omni_r_tanh', ret: 'double', params: ['double'] }],
  ['rmath_asinh.real', { sym: 'omni_r_asinh', ret: 'double', params: ['double'] }],
  ['rmath_acosh.real', { sym: 'omni_r_acosh', ret: 'double', params: ['double'] }],
  ['rmath_atanh.real', { sym: 'omni_r_atanh', ret: 'double', params: ['double'] }],
  ['rmath_exp.real', { sym: 'omni_r_exp', ret: 'double', params: ['double'] }],
  ['rmath_expm1.real', { sym: 'omni_r_expm1', ret: 'double', params: ['double'] }],
  ['rmath_log.real', { sym: 'omni_r_log', ret: 'double', params: ['double'] }],
  ['rmath_log10.real', { sym: 'omni_r_log10', ret: 'double', params: ['double'] }],
  ['rmath_log1p.real', { sym: 'omni_r_log1p', ret: 'double', params: ['double'] }],
  ['rmath_cbrt.real', { sym: 'omni_r_cbrt', ret: 'double', params: ['double'] }],
  ['rmath_hypot.real', { sym: 'omni_r_hypot', ret: 'double', params: ['double', 'double'] }],
  // 交集的**第二条例外**（ADR-0014 第十五节）：单次舍入的 fma。三个参数，
  // 走的还是 C 的那一份（omni_r_fma）—— 与 run-c 同一个符号，两条腿自然同字节。
  ['rmath_fma.real',
    { sym: 'omni_r_fma', ret: 'double', params: ['double', 'double', 'double'] }],
  // 那个「C99 ∩ Math.*」交集的例外（ADR-0019 路 2）：libm 的 nextafter。
  // 这条腿上它照旧是一个真符号 —— 与别的 rmath 一样，没有特殊处。
  ['rmath_nextafter.real', { sym: 'omni_r_nextafter', ret: 'double', params: ['double', 'double'] }],
  // 位重解释（ADR-0019 路 1）。两个名字各来一条 —— 与 `trunc` / `trunc.real` 同一个理由
  // （按接收者单态化的那一步会给名字接一个后缀）。
  ['realbits', { sym: 'omni_r_bits', ret: 'i64', params: ['double'] }],
  ['realbits.real', { sym: 'omni_r_bits', ret: 'i64', params: ['double'] }],
  ['bitsreal', { sym: 'omni_r_frombits', ret: 'double', params: ['i64'] }],
  ['bitsreal.int', { sym: 'omni_r_frombits', ret: 'double', params: ['i64'] }],
  // 引用的身份整数（`(refid E)`）。数组在这条腿上就是 `ptr`（见 LL_TYPES 的 T_ARR），
  // 所以是一次 ptrtoint —— 但走真符号 `omni_refid`（C 那条腿上它是 omni.h 里的宏，
  // 不付调用）。单态化后的名字是 `refid.arr`（argType.k），裸名那条一起留着。
  ['refid', { sym: 'omni_refid', ret: 'i64', params: ['ptr'] }],
  ['refid.arr', { sym: 'omni_refid', ret: 'i64', params: ['ptr'] }],
  // 字符串上的三条（核心方言的 `(slen …)` / `(ssub …)` / `(sfind …)`，ADR-0014 决策 1）。
  // 全走真符号：omni_index_of 本来就是，另两个是 omni_str.c 里给 static inline 加的外壳
  // （理由写在那里 —— 取长度和取子串各只有一份实现，两条腿不会分叉）。
  ['len.string', { sym: 'omni_str_length', ret: 'i64', params: ['[2 x i64]'] }],
  ['substr.string', { sym: 'omni_str_sub', ret: '[2 x i64]', params: ['[2 x i64]', 'i64', 'i64'] }],
  ['indexOf.string', { sym: 'omni_index_of', ret: 'i64', params: ['[2 x i64]', '[2 x i64]'] }],
  // 这两条是 ADR-0016 第四刀补的（jancy 的 printf 要它们）：不换行的输出，与"码位 -> 串"。
  // 另外四条腿早就有 chr（Omni 的 `chr(65)`），漏的一直只是这一行。
  ['write.string', { sym: 'omni_write_string', ret: 'void', params: ['[2 x i64]'] }],
  ['chr.int', { sym: 'omni_chr', ret: '[2 x i64]', params: ['i64'] }],
  ['str_repeat.string', { sym: 'omni_str_repeat', ret: '[2 x i64]', params: ['[2 x i64]', 'i64'] }],
  // 这两条是 ADR-0016 第七刀补的（jancy 的 %x / %X / %o）。
  ['str_base.int', { sym: 'omni_str_base', ret: '[2 x i64]', params: ['i64', 'i64'] }],
  ['str_upper.string', { sym: 'omni_str_upper', ret: '[2 x i64]', params: ['[2 x i64]'] }],
  // 第八刀：C 的 %.Nf（就近取偶）。第三十刀：C 的 %.Ne。
  ['str_fixed.real', { sym: 'omni_str_fixed', ret: '[2 x i64]', params: ['double', 'i64'] }],
  ['str_sci.real', { sym: 'omni_str_sci', ret: '[2 x i64]', params: ['double', 'i64'] }],
  // 第三十一刀：C 的 %.Ng / %#.Ng（差别就是那个 `#`：后者不去尾随零）。
  ['str_gen.real', { sym: 'omni_str_gen', ret: '[2 x i64]', params: ['double', 'i64'] }],
  ['str_genk.real', { sym: 'omni_str_genk', ret: '[2 x i64]', params: ['double', 'i64'] }],
]);

/** i64 比较 -> icmp 谓词；f64 -> fcmp 谓词。顺序与 OP.EQ..OP.GT 一致。 */
const ICMP = new Map([[OP.EQ, 'eq'], [OP.NE, 'ne'], [OP.LT, 'slt'], [OP.GE, 'sge'], [OP.LE, 'sle'], [OP.GT, 'sgt'],
  // 无符号那四个（第六十一刀）：LLVM 里正好就是 ult/uge/ule/ugt —— 方言的
  // "无符号性挂在算子上"抄的就是它这一格
  [OP.ULT, 'ult'], [OP.UGE, 'uge'], [OP.ULE, 'ule'], [OP.UGT, 'ugt']]);

const FCMP = new Map([[OP.EQ, 'oeq'], [OP.NE, 'une'], [OP.LT, 'olt'], [OP.GE, 'oge'], [OP.LE, 'ole'], [OP.GT, 'ogt']]);

/**
 * 所有「这一层还没做」的报错都带上这句。
 * 它是测试轴上的断言字串（tests/llvm、tests/jit 都按它判「拒得对不对」），
 * 所以是一个常量而不是散在各处的字面量 —— 措辞改了，两条轴不会静默失配。
 */
const NOPE = 'llvm 后端目前不支持';

/* `setjmp` / `longjmp` 那一族：这一层不收。它们要的是**帧**（回到同一帧的同一条指令），
   而 IR 上这儿只有实参。emit_js 的 JS_NOJMP、interp 的 SETJMP_NAMES/LONGJMP_NAMES
   是同一张名单 —— 三条腿的边界必须一样，某条路悄悄多支持一点就是个假象。 */
const LL_NOJMP = new Set(['setjmp', '_setjmp', 'sigsetjmp', '__sigsetjmp',
  'longjmp', '_longjmp', 'siglongjmp']);

/* 线性内存的访问描述符 -> **内存里那几个字节**的 LLVM 类型（ADR-0017 第二刀）。
 * 一张表管读写两侧：`i8s`/`i8u` 与 `i8` 落到同一个 `i8`，差别只在扩展方向，
 * 而那件事由描述符名字的最后一个字母决定（见 memInsn）。 */
const MEM_LL_TY = {
  i8s: 'i8', i8u: 'i8', i16s: 'i16', i16u: 'i16', i32s: 'i32', i32u: 'i32',
  i8: 'i8', i16: 'i16', i32: 'i32', i64: 'i64', f32: 'float', f64: 'double',
};

class LlvmEmitter {
  constructor(mir) {
    this.mir = mir;
    this.out = [];
    this.needDiv = false;   // 除法/取模的辅助函数只在用到时才发
    this.needMod = false;
    this.needUDiv = false;  // 无符号那两个（第六十一刀），同一条规矩
    this.needUMod = false;
    this.f = null;          // 当前函数
    /* 外部 C 符号（`OP.CCALL`，ADR-0014 决策 4 / ADR-0022 的 J4）：名字 -> 那一格的签名。
       声明要发在模块最前面，而"用到了哪些、每个的定参类型是什么"只有发完函数体才知道 ——
       所以照 backend-c 的老手法占一行、最后回填（cabiAt）。 */
    this.cabiDecl = new Map();
    this.cabiAt = -1;
    this.tmp = 0;           // 临时值编号（%t0…），与 %v<i> 分开，不会撞
    this.labels = 0;
    this.regions = [];      // 结构化控制流的区域栈，层数语义与 wasm 相同
    this.live = false;      // 当前基本块还没被终结子关掉
    // 字符串常量的字节池。函数体里遇到才登记，模块末尾统一发 —— LLVM 不要求
    // 全局在使用之前出现，所以不必先扫一遍。键是内容，同一份字面量只发一次。
    this.strs = new Map();
    this.needStrCmp = false;
    this.needStrCat = false;
    // 用到的缓冲元素类型（类型码 -> true）。每种要发一组 new/get/set 的私有函数。
    this.bufElems = new Map();
    // 用到的数组元素类型。这一组不生成任何函数体，只 declare 运行时里已有的符号 ——
    // 数组的实现在 omni_arr.c，run-c 那条腿调的是同一个符号。
    this.arrElems = new Map();
    // 聚合元素的数组用到了没有：那一组符号与元素类型无关（按字节），一份 declare 就够
    this.needArrBlob = false;
    // 结构体用到了没有：用到就要发 arena 的那个私有分配器（缓冲那一节本来就要它）
    this.aggUsed = false;
    this.needNullck = false;   // 类的字段访问要判空，用到才 declare
    this.needFnck = false;     // 函数值的调用要判空（消息与 omni_fn_ck 逐字相同）
    // 指针用到了没有（ADR-0016）：用到就 declare omni.h 里那四个平签名的真符号。
    // run-c 那条腿调的是同一个符号的同一份机器码，所以越界与空引用的消息不可能分叉。
    this.needPtr = false;
    this.needTPtr = false;
    this.needLinMem = false;   // 线性内存那五个符号（第二刀）
  }

  line(s) { this.out.push(s); }

  /** 类型码 -> LLVM 类型。表外的报错，带上函数名与类型名 —— 边界要说得清。 */
  ty(t, what) {
    // 向量（ADR-0014 门槛 6）：`<N x 元素>`。宽度在 `t` 的高 3 位上，所以不查表 ——
    // 查表就要为 2/4/8 三种宽度各列一行，而宽度本来就是算得出来的。
    const lanes = typeLanes(t);
    if (lanes > 1) return `<${lanes} x ${this.ty(typeKind(t), what)}>`;
    const s = LL_TYPES.get(t);
    if (s === undefined) {
      throw new OmniError(`${NOPE} ${typeText(t)}：${what}`
        + `（函数 ${this.f === null ? '?' : this.f.name}）`);
    }
    return s;
  }

  /** 这条指令**结果**的类型（比较的结果是 bool，`t` 上放的是操作数类型）。 */
  resultTy(f, i) {
    const op = f.op[i];
    return isCmp(op) ? T_BOOL : f.t[i];
  }

  fresh() { const n = this.tmp; this.tmp++; return `%t${n}`; }
  label(tag) { const n = this.labels; this.labels++; return `${tag}${n}`; }

  /* --------------------------------------------------------------- 值与常量 */

  /** ref -> LLVM 里的写法。常量内联，指令是 `%v<下标>`。 */
  val(ref) {
    if (ref === REF_NONE) throw new OmniError(`llvm: 少了一个操作数（函数 ${this.f.name}）`);
    if (!isConstRef(ref)) return `%v${ref - REF_BIAS}`;
    const c = this.mir.consts.get(ref);
    if (c.t === T_I64) return c.text;
    if (c.t === T_I32) return c.text;
    if (c.t === T_BOOL) return c.text === 'true' ? 'true' : 'false';
    if (c.t === T_F64) return llFloat(c.text);
    if (c.t === T_F32) return llFloat32(c.text);
    if (c.t === T_STR) return this.strConst(c.text);
    // 空引用（OIR 的 NullRef）。方言里写不出 null，但两条路走得到它：「非 void 的函数掉出
    // 尾巴」会补一个零值 return（类的零值就是它），以及多维数组那一刀 —— `(anew (arr (arr T)) N)`
    // 的行零值是空引用（见 sexpr/lower.js 的 anew），那个常量的类型码是 T_ARR 而不是 T_AGG。
    const k = typeKind(c.t);
    if ((k === T_AGG || k === T_ARR) && c.text === 'null') return 'null';
    throw new OmniError(`${NOPE} ${typeText(c.t)} 常量（${c.text}）`);
  }

  /**
   * 字符串字面量 -> 一个 `[2 x i64]` 的**常量表达式**：{字节的地址, 字节数}。
   *
   * 之所以能内联成常量表达式（而不是在函数入口 alloca 再 store 两次），是因为
   * `ptrtoint` 作用在全局上是合法的常量表达式。于是字符串常量和整数常量在这个
   * 发射器里走同一条路 —— `val()` 的调用者不需要知道类型。
   *
   * 长度是**字节数**（UTF-8），不是字符数：ADR-0005 的 Omni string 就是字节序列。
   * 编码用的是与 C 后端同一份 utf8Bytes（host/utf8.js），落单代理项的处理也因此一致。
   */
  strConst(text) {
    let e = this.strs.get(text);
    if (e === undefined) {
      const bytes = utf8Bytes(text);
      e = { name: `@.omni_s${this.strs.size}`, bytes: bytes };
      this.strs.set(text, e);
    }
    return `[i64 ptrtoint (ptr ${e.name} to i64), i64 ${e.bytes.length}]`;
  }

  /** ref 的类型码。 */
  tyOf(ref) {
    if (isConstRef(ref)) return this.mir.consts.get(ref).t;
    return this.resultTy(this.f, this.f.at(ref));
  }

  /** `<类型> <值>`，call/store 那些地方要的形式。 */
  typed(ref) { return `${this.ty(this.tyOf(ref), 'operand')} ${this.val(ref)}`; }

  /**
   * 一个实参**按 C 的 ABI**摆（外部符号的调用点用它，ADR-0022 的 J4）。
   *
   * 唯一要动的是**胖指针**（`T_STR` -> `[2 x i64]`：地址 + 长度）：真 C 那边收的是一格
   * `const char *`，而一个 16 字节的聚合在 arm64 与 x86_64 上都要占**两格**寄存器 ——
   * 于是第二个指针实参就落错了位置。量出来的：`strlen("abcdefg")` 侥幸对（地址正好在
   * 第一格），`strcmp("abc","abc")` 直接 segfault。所以在调用点把地址抽出来。
   */
  externArg(ref) {
    const at = this.tyOf(ref);
    if (at !== T_STR) return { text: this.typed(ref), ty: this.ty(at, '外部符号的形参') };
    const a0 = this.fresh();
    this.line(`  ${a0} = extractvalue [2 x i64] ${this.val(ref)}, 0`);
    const p = this.fresh();
    this.line(`  ${p} = inttoptr i64 ${a0} to ptr`);
    return { text: `ptr ${p}`, ty: 'ptr' };
  }

  /* --------------------------------------------------------------- 基本块 */

  startBlock(name) {
    this.line(`${name}:`);
    this.live = true;
  }

  /** 发一条终结子。之后开一个新块 —— MIR 里 BR/RET 后面还可能跟着不可达的指令。 */
  term(s) {
    if (this.live) this.line(`  ${s}`);
    this.live = false;
  }

  /** 终结子之后要继续发指令时，先落一个新标签，否则 IR 不合法。 */
  ensureBlock() {
    if (!this.live) this.startBlock(this.label('dead'));
  }

  /* ------------------------------------------------------------------ 模块 */

  emit() {
    this.line('; Omni stage0 — MIR -> LLVM IR（ADR-0014 决策 3）');
    this.line('');
    for (const op of usedRtOps(this.mir)) {
      const d = RT_OPS.get(op);
      this.line(`declare ${d.ret} @${d.sym}(${d.params.join(', ')})`);
    }
    this.line('declare void @omni_host_init(i32, ptr)');
    this.line('declare void @omni_run_entry(ptr)');
    this.line('declare i32 @omni_host_exit_code()');
    this.line('declare void @omni_js_check_uncaught()');
    this.line('declare i32 @fflush(ptr)');
    /* 外部 C 符号的声明位（回填，见构造器里那格 cabiDecl）。 */
    this.cabiAt = this.out.length;
    this.line('');
    this.line('');
    // 结构体的命名类型。按类型池的顺序发，与用到没用到无关 —— 判断"用到了"要先扫一遍
    // 函数体，而多一个没人用的 `type` 在 LLVM 里没有代价，扫一遍的那点代码却要维护。
    // 字段偏移交给 LLVM 算（getelementptr 的第三个下标就是字段号），这一层不自己算字节。
    //
    // 一个命名类型的**字段**里可能提到另一个命名类型（内嵌的结构体、或者内嵌的一整块
    // 结构体 —— 第二十二刀），而那一个未必在类型池里：池子是按**指令**用到的类型攒的，
    // 而 `(pfield …)` 到了 MIR 已经化成字节偏移了。所以这里补一遍闭包 —— LLVM 要求
    // `%s_Row = type { [2 x %s_P], i64 }` 里的 `%s_P` 有体，没体的命名类型是 opaque，
    // 算不出尺寸（`base element of getelementptr must be sized`）。只顺着**内嵌**递归：
    // 类字段是一个 `ptr`（见 fieldTy），不需要体，也因此不会绕出环来。
    let sawStruct = false;
    const emittedAgg = new Set();
    const emitAgg = (ot) => {
      const key = `%${ot.k === 'class' ? 'c' : 's'}_${ot.name}`;
      if (emittedAgg.has(key)) return;
      emittedAgg.add(key);
      for (const fd of ot.fields) {
        let ft = fd.type;
        while (ft.k === 'blk') ft = ft.el;
        if (ft.k === 'struct') emitAgg(ft);
      }
      const fs = ot.fields.map((fd) => this.fieldTy(fd.type, `${ot.name}.${fd.name}`));
      this.line(`${key} = type { ${fs.join(', ')} }`);
      sawStruct = true;
    };
    for (const t of this.mir.types) {
      if (t.kind !== 'struct' && t.kind !== 'class') continue;
      emitAgg(t.oir);
    }
    if (sawStruct) this.line('');
    if (this.mir.closures.length > 0) this.closureTypes();
    // 模块级变量（第二十四刀）：一个 internal global，零初始化。真正的初值是
    // omni_main 最前面那几句 store —— 字符串的零是池子里的空串，不是常量表达式。
    let sawGlobal = false;
    for (let i = 0; i < this.mir.globals.length; i++) {
      const t = this.mir.globalTy[i];
      this.line(`@g_${this.mir.globals[i]} = internal global ${this.ty(t, `模块级变量 ${this.mir.globals[i]}`)} zeroinitializer`);
      sawGlobal = true;
    }
    if (sawGlobal) this.line('');

    for (const f of this.mir.funcs) this.func(f);

    // 闭包（ADR-0010）。记录的第 0 格是函数指针，与 `struct omni_closure_s` 同一个布局，
    // 后面是**按值**抓的捕获 —— C 那条腿发的是一个 struct 加一个 make 函数，这里发的是
    // 一个命名类型加一个 make 函数，同一份布局的两种拼写。放在函数之后发：
    // 记录类型在 IR 里是模块级的，前后无所谓，而 make 要引用被提升出来的那个函数名。
    if (this.mir.closures.length > 0) this.closureMakes();

    if (this.needDiv) this.line(DIV_HELPER);
    if (this.needMod) this.line(MOD_HELPER);
    if (this.needUDiv) this.line(UDIV_HELPER);
    if (this.needUMod) this.line(UMOD_HELPER);
    if (this.needFnck) this.line(FNCK_HELPER);
    // `omni_error` 有三个用户（除零、取模、函数值判空），declare 只能有一句。
    const anyDiv = this.needDiv || this.needMod || this.needUDiv || this.needUMod;
    if (anyDiv || this.needFnck) {
      this.line('declare void @omni_error(ptr)');
      if (anyDiv) {
        this.line('@.omni_divzero = private unnamed_addr constant [17 x i8] c"division by zero\\00"');
      }
      if (this.needFnck) {
        this.line('@.omni_nullfn = private unnamed_addr constant [30 x i8] '
          + 'c"call of a null function value\\00"');
      }
      this.line('');
    }
    if (this.needStrCmp) {
      this.line(STRCMP_HELPER);
      this.line('declare i32 @memcmp(ptr, ptr, i64)');
      this.line('');
    }
    if (this.needStrCat) {
      this.line('declare [2 x i64] @omni_str_cat([2 x i64], [2 x i64])');
      this.line('');
    }
    // 缓冲与结构体都从 arena 里拿内存：分配器的两个指针是真符号，所以这条腿分配到的
    // 内存和 C 那条腿在同一个池里（见 ALLOC_HELPER 的注释）。谁先用到就谁把它发出来。
    if (this.bufElems.size > 0 || this.aggUsed) {
      this.line('declare ptr @omni_alloc_slow(i64)');
      this.line('@omni_arena_ptr = external global ptr');
      this.line('@omni_arena_end = external global ptr');
      this.line('');
      this.line(ALLOC_HELPER);
    }
    if (this.needNullck) {
      this.line('declare ptr @omni_nullck(ptr)');
      this.line('');
    }
    if (this.bufElems.size > 0) {
      this.line('declare void @omni_errorf(ptr, ...)');
      this.line(llCStr('@.omni_boob', 'buffer index out of range: %lld (length %lld)'));
      this.line(llCStr('@.omni_bneg', 'buffer length cannot be negative: %lld'));
      this.line('');
      for (const t of this.bufElems.keys()) {
        this.line(t === T_F64 ? bufHelpers('double', 8, '0.0') : bufHelpers('i64', 8, '0'));
      }
    }
    // 数组：只 declare，不生成。六条指令全是 call 运行时符号，所以这一节没有一行 IR 逻辑。
    for (const t of this.arrElems.keys()) {
      const e = ARR_ELEMS.get(t);
      const s = e.suffix;
      this.line(`declare ptr @omni_arr_${s}_new(i64, ${e.p})`);
      this.line(`declare i64 @omni_arr_${s}_len(ptr)`);
      this.line(`declare ${e.r} @omni_arr_${s}_get(ptr, i64)`);
      this.line(`declare ${e.r} @omni_arr_${s}_set(ptr, i64, ${e.p})`);
      this.line(`declare ${e.r} @omni_arr_${s}_push(ptr, ${e.p})`);
      this.line(`declare ${e.r} @omni_arr_${s}_pop(ptr)`);
    }
    if (this.needArrBlob) {
      this.line('declare ptr @omni_arr_blob_new(i64, i64, ptr)');
      this.line('declare i64 @omni_arr_blob_len(ptr)');
      this.line('declare ptr @omni_arr_blob_at(ptr, i64)');
      this.line('declare ptr @omni_arr_blob_push(ptr)');
      this.line('declare ptr @omni_arr_blob_pop(ptr)');
    }
    // 指针：也是只 declare，不生成 —— 分配、范围检查、指针差都在 omni_mem.c 里，
    // 与 run-c 同一个符号。加法（PADD）没有检查，就地一条 getelementptr，所以没有符号。
    if (this.needPtr) {
      this.line('declare ptr @omni_pnew(i64, i64)');
      this.line('declare ptr @omni_pchk(ptr, ptr, ptr, i64)');
      this.line('declare i64 @omni_psub(ptr, ptr, ptr, ptr, ptr, ptr, i64)');
    }
    if (this.needTPtr) {
      this.line('declare ptr @omni_tchk(ptr)');
    }
    // 线性内存（第二刀）：四个符号，与 run-c 那条腿调的是同一份 omni_linmem.c
    if (this.needLinMem || this.mir.mem !== null) {
      this.line('declare void @omni_lin_init(i64, i64)');
      this.line('declare void @omni_lin_data(i64, ptr, i64)');
      this.line('declare i64 @omni_lin_size()');
      this.line('declare i64 @omni_lin_grow(i64)');
      this.line('declare ptr @omni_lin_at(i64, i64)');
    }
    // data 段的字节：与字符串字面量同一个形状（private constant），顺序按声明顺序。
    if (this.mir.mem !== null) {
      let di = 0;
      for (const d of this.mir.mem.data) {
        const bs = d.bytes.map((b) => `i8 ${b}`).join(', ');
        this.line(`@omni_data_${di} = private unnamed_addr constant [${d.bytes.length} x i8] [${bs}]`);
        di++;
      }
    }
    // 字符串字面量的字节。放在最后是因为它们是函数体发到一半才登记的；
    // 顺序按登记顺序，所以同一份输入两次发出来逐字节相同（快照轴要这个）。
    for (const e of this.strs.values()) {
      const bs = e.bytes.map((b) => `i8 ${b}`).join(', ');
      this.line(`${e.name} = private unnamed_addr constant [${e.bytes.length} x i8] [${bs}]`);
    }
    if (this.strs.size > 0) this.line('');

    /* 包装的 main 只在**模块自己没有 main** 时发。
     *
     * C 那条腿上程序自己的 `main` 就是进程入口（`c obj` 那条路也是这么链的：真 crt +
     * 用户的 main，没有包装），而这一层的包装也叫 `main` —— 两个撞在一起，clang 直接报
     * `invalid redefinition of function 'main'`。顺带一个旁证：原生 C 的 MIR 里
     * `entry` 是**文件路径**（`@/tmp/x.c`），压根不是一个函数 —— 那条腿没有"入口函数"
     * 这回事，所以包装里那句 `omni_run_entry(@entry)` 对它本来就无意义。
     */
    const hasOwnMain = this.mir.funcs.some((g) => g.name === 'main' && g.extern !== true);
    if (hasOwnMain) {
      this.line('; 模块自己带 main（C 那条腿），不发包装 —— 见上面那段');
      this.line('');
    } else {
      // main 与 C 后端那一行逐句对应（backend-c/emit.js:152）：argc/argv 要存下来，
      // 退出码是 omni_host_exit_code 里的槽，不是 omni_main 的返回值。
      this.line('define i32 @main(i32 %argc, ptr %argv) {');
      this.line('entry:');
      this.line('  call void @omni_host_init(i32 %argc, ptr %argv)');
      // 内存要在入口之前就位（第二刀）：先建、再拷 data 段，与 wasm 的 instantiate 同序。
      if (this.mir.mem !== null) {
        this.line(`  call void @omni_lin_init(i64 ${this.mir.mem.min}, i64 ${this.mir.mem.max})`);
        let di = 0;
        for (const d of this.mir.mem.data) {
          this.line(`  call void @omni_lin_data(i64 ${d.off}, ptr @omni_data_${di}, i64 ${d.bytes.length})`);
          di++;
        }
      }
      this.line(`  call void @omni_run_entry(ptr @${this.mir.entry})`);
      this.line('  call void @omni_js_check_uncaught()');
      this.line('  %fl = call i32 @fflush(ptr null)');
      this.line('  %code = call i32 @omni_host_exit_code()');
      this.line('  ret i32 %code');
      this.line('}');
    }
    /* 外部 C 符号的声明回填（见构造器里那格 cabiDecl）：签名是从**调用点**收上来的，
       所以只能等函数体全发完。一个都没有时把占位那一行**抽掉**而不是留成空行 ——
       否则整份 IR 的行号平移一行，tests/llvm 的快照当场红（就是这么被抓着的）。 */
    const decls = [];
    for (const [name, sig] of this.cabiDecl) {
      const paren = sig.indexOf(' (');
      decls.push(`declare ${sig.slice(0, paren)} @${name}${sig.slice(paren + 1)}`);
    }
    if (this.cabiAt >= 0) {
      if (decls.length === 0) this.out.splice(this.cabiAt, 1);
      else this.out[this.cabiAt] = decls.join('\n');
    }
    return this.out.join('\n') + '\n';
  }

  /* ------------------------------------------------------------------ 闭包 */

  /**
   * 每个闭包模板发两样东西：记录的命名类型，与造它的 make 函数。
   * 类型必须发在**函数之前** —— .ll 的解析器对 getelementptr 的基类型是当场校验的，
   * 命名类型还没定义时它是不透明的，于是报 "base element of getelementptr must be sized"。
   * `sizeof` 在 IR 里没有关键字，用的是 `getelementptr T, ptr null, i64 1` 再 ptrtoint
   * 这个标准写法 —— 它是常量表达式，LLVM 当场折成一个字面量。
   */
  closureTypes() {
    let i = 0;
    while (i < this.mir.closures.length) {
      const ts = this.capTys(i);
      this.line(`%clo_${i} = type { ptr${ts.length > 0 ? `, ${ts.join(', ')}` : ''} }`);
      i++;
    }
    this.line('');
  }

  /** 捕获的 LLVM 拼写。记录布局与 make 的形参表都从这一份来，所以只有一处。 */
  capTys(no) {
    const c = this.mir.closures[no];
    const ts = [];
    let k = 0;
    while (k < c.capTypes.length) {
      ts.push(this.ty(c.capTypes[k], `捕获 ${c.captures[k]}`));
      k++;
    }
    return ts;
  }

  closureMakes() {
    this.aggUsed = true;   // make 要从 arena 拿内存（ALLOC_HELPER）
    let i = 0;
    while (i < this.mir.closures.length) {
      const c = this.mir.closures[i];
      const ts = this.capTys(i);
      const ps = [];
      let k = 0;
      while (k < ts.length) { ps.push(`${ts[k]} %c${k}`); k++; }
      const rec = `%clo_${i}`;
      // 带 `single` 的那一格（`(fnref f)` 的薄适配器）发**单件**：同一个具名函数取出来的
      // 值必须是同一个东西，不然 `f == g` 这种按身份比的式子永远为假。与另外几条腿同一条规矩。
      const single = c.single === true && ts.length === 0;
      if (single) this.line(`@one_${c.make} = private global ptr null`);
      this.line(`define private ptr @${c.make}(${ps.join(', ')}) {`);
      this.line('entry:');
      if (single) {
        this.line(`  %o = load ptr, ptr @one_${c.make}`);
        this.line('  %z = icmp eq ptr %o, null');
        this.line('  br i1 %z, label %mk, label %hit');
        this.line('hit:');
        this.line('  ret ptr %o');
        this.line('mk:');
      }
      this.line(`  %szp = getelementptr ${rec}, ptr null, i64 1`);
      this.line('  %sz = ptrtoint ptr %szp to i64');
      this.line('  %e = call ptr @omni_ll_alloc(i64 %sz)');
      this.line(`  %fpp = getelementptr ${rec}, ptr %e, i64 0, i32 0`);
      this.line(`  store ptr @${c.funcName}, ptr %fpp`);
      k = 0;
      while (k < ts.length) {
        this.line(`  %p${k} = getelementptr ${rec}, ptr %e, i64 0, i32 ${k + 1}`);
        this.line(`  store ${ts[k]} %c${k}, ptr %p${k}`);
        k++;
      }
      if (single) this.line(`  store ptr %e, ptr @one_${c.make}`);
      this.line('  ret ptr %e');
      this.line('}');
      this.line('');
      i++;
    }
  }

  /* ------------------------------------------------------------------ 函数 */

  func(f) {
    /* **这个模块里没有它的函数体**（MirFunc.extern，第九刀第一百二十八片）：只发 `declare`，
       而声明的签名是从**调用点**收上来的（externDecl，与 CCALL 共用那一格）—— 原生那条腿
       的外部函数记录上没有 params，所以签名只能从调用处得到。
       从前这儿照常发 `define`，出来的是 `define i64 @strlen() { ret i64 0 }`：形参丢了、
       体是假的 —— 一份把 libc 的 strlen 覆盖掉的假实现。 */
    if (f.extern === true) return;
    this.f = f;
    this.tmp = 0;
    this.labels = 0;
    this.regions = [];
    // 闭包体的第一个形参是闭包记录自己（ADR-0010），与 C 那条腿的 `omni_fn self_` 同一个
    // 约定。它**不占槽**：MIR 里捕获是 OP.CAPTURE（按下标从记录里读），不是形参。
    const ps = [];
    if (f.closureId !== undefined) ps.push('ptr %self');
    let pi = 0;
    while (pi < f.params.length) {
      ps.push(`${this.ty(f.params[pi].t, `参数 ${f.params[pi].name}`)} %a${pi}`);
      pi++;
    }
    this.line(`define ${this.ty(f.ret, '返回值')} @${f.name}(${ps.join(', ')}) {`);
    this.startBlock('entry');
    // 槽位一律 alloca：MIR 不做 mem2reg，那是 LLVM 的活（ADR-0014 决策 6 的三处偏离之一）
    let s = 0;
    while (s < f.slots.length) {
      this.line(`  %s${s} = alloca ${this.ty(f.slots[s].t, `槽位 ${f.slots[s].name}`)}`);
      s++;
    }
    // 形参占前几个槽（from_oir 里 declare(p.name) 就是这么排的），入口处存进去
    let p = 0;
    while (p < f.params.length) {
      const t = this.ty(f.params[p].t, 'param');
      this.line(`  store ${t} %a${p}, ptr %s${p}`);
      p++;
    }
    // 聚合元素的 `anew` 要把零值的**地址**交给运行时（blob 那份实现按字节拷）。
    // 承载它的 alloca 一律发在入口块、每种元素类型一个：发在 anew 那一行的话，
    // 循环里的 anew 每转一圈就多一块栈 —— alloca 不出循环，栈就一直长。
    // 键是元素的 LLVM 拼写（`<2 x double>` / `ptr`）：第十八刀起元素类型从类型池上取，
    // 那里的 key 是 OIR 类型对象，而同一种拼写共用一块栈就够了。
    this.blobZero = new Map();
    let z = 0;
    while (z < f.count()) {
      if (f.op[z] === OP.ANEW) {
        const rep = this.arrRep(f.aux[z], 'anew 的元素');
        if (rep.blob && !this.blobZero.has(rep.ety)) {
          const name = `%zb${this.blobZero.size}`;
          this.blobZero.set(rep.ety, name);
          this.line(`  ${name} = alloca ${rep.ety}`);
        }
      }
      z++;
    }
    let i = 0;
    while (i < f.count()) { this.insn(f, i); i++; }
    // 掉出函数体：void 就 ret void，有返回值的补一个零值 —— 让它确定，而不是随机
    if (this.live) {
      const rt = this.ty(f.ret, '返回值');
      this.term(rt === 'void' ? 'ret void' : `ret ${rt} ${rt === 'double' ? '0.0' : '0'}`);
    }
    this.line('}');
    this.line('');
  }

  /* ---------------------------------------------------------------- 一条指令 */

  insn(f, i) {
    const op = f.op[i];
    // 终结子之后的指令在 MIR 里是可达性上的死码（`BR` 后面还跟着 END 之类），
    // 但 IR 要求每条指令都在某个块里 —— 补一个标签，让 LLVM 自己删。
    if (!this.live && op !== OP.END && op !== OP.ELSE) this.ensureBlock();
    const dst = `%v${i}`;
    const t = f.t[i];

    if (op === OP.BLOCK) { this.regions.push({ kind: 'block', end: this.label('bend'), head: null, els: null, seenElse: false }); return; }
    if (op === OP.LOOP) {
      const head = this.label('lhead');
      this.term(`br label %${head}`);
      this.startBlock(head);
      this.regions.push({ kind: 'loop', end: this.label('lend'), head: head, els: null, seenElse: false });
      return;
    }
    if (op === OP.IF) {
      const then = this.label('then');
      const els = this.label('else');
      const end = this.label('ifend');
      this.term(`br i1 ${this.val(f.a[i])}, label %${then}, label %${els}`);
      this.startBlock(then);
      this.regions.push({ kind: 'if', end: end, head: null, els: els, seenElse: false });
      return;
    }
    if (op === OP.ELSE) {
      const r = this.regions[this.regions.length - 1];
      this.term(`br label %${r.end}`);
      this.startBlock(r.els);
      r.seenElse = true;
      return;
    }
    if (op === OP.END) {
      const r = this.regions.pop();
      this.term(`br label %${r.end}`);
      // 没有 ELSE 的 IF：else 那一支还是要有个块，直接跳到汇合点
      if (r.kind === 'if' && !r.seenElse) { this.startBlock(r.els); this.term(`br label %${r.end}`); }
      this.startBlock(r.end);
      return;
    }
    if (op === OP.BR || op === OP.BRIF) {
      const r = this.regions[this.regions.length - 1 - f.aux[i]];
      if (r === undefined) throw new OmniError(`llvm: BR 的层数越界（函数 ${f.name}）`);
      // wasm 的层数语义：跳到 LOOP 是回循环头，跳到 BLOCK/IF 是跳到它的汇合点
      const target = r.kind === 'loop' ? r.head : r.end;
      if (op === OP.BR) { this.term(`br label %${target}`); return; }
      const next = this.label('brnext');
      this.term(`br i1 ${this.val(f.a[i])}, label %${target}, label %${next}`);
      this.startBlock(next);
      return;
    }
    // 跳表（ADR-0017 第三刀）。LLVM 的 `switch` 收的是「值 -> 标签」，MIR 的表是
    // 「下标 -> 层数」—— 下标本来就是 0..n-1，所以这一步是逐项配一个常量，不用再算什么。
    // 多个下标指向同一层是允许的（LLVM 只要求 case 的**值**互不相同）。
    // 越界走 default，这与 wasm 的语义逐条相同，所以这条腿上不必自己补范围判断。
    if (op === OP.BRTABLE) {
      const levels = f.levelsOf(f.b[i]);
      const labelOf = (lv) => {
        const r = this.regions[this.regions.length - 1 - lv];
        if (r === undefined) throw new OmniError(`llvm: BRTABLE 的层数越界（函数 ${f.name}）`);
        return r.kind === 'loop' ? r.head : r.end;
      };
      const it = this.ty(this.tyOf(f.a[i]), 'BRTABLE 的下标');
      const arms = [];
      let n = 0;
      for (const lv of levels) { arms.push(`${it} ${n}, label %${labelOf(lv)}`); n++; }
      this.term(`switch ${it} ${this.val(f.a[i])}, label %${labelOf(f.aux[i])} [ ${arms.join(' ')} ]`);
      return;
    }
    if (op === OP.RET) {
      if (f.a[i] === REF_NONE) this.term('ret void');
      else this.term(`ret ${this.typed(f.a[i])}`);
      return;
    }
    this.dataInsn(f, i, op, dst, t);
  }

  /* -------------------------------------------------- 数据指令（不改控制流） */

  dataInsn(f, i, op, dst, t) {
    const lanes = typeLanes(t);
    // f32 也是浮点（ADR-0017 第一刀）：`fadd float` 与 `fadd double` 同一条通路，
    // 类型由 ty() 给出。写成 `=== T_F64` 的话 f32 会掉进整数那一支，发出 `add float`。
    const isF = isFloatType(t);
    // 32 位整数：算术那一族与 i64 同一条通路（`add i32`），但**除法与移位不是** ——
    // 除零/溢出的那两个辅助函数是 i64 签名，移位掩码也是 63。见下面 i32 的两处分流。
    const is32 = typeKind(t) === T_I32;
    if (op === OP.LOAD) {
      this.line(`  ${dst} = load ${this.ty(t, 'slot')}, ptr %s${f.aux[i]}`);
      return;
    }
    if (op === OP.STORE) {
      const st = this.ty(f.slots[f.aux[i]].t, 'slot');
      this.line(`  store ${st} ${this.val(f.a[i])}, ptr %s${f.aux[i]}`);
      return;
    }
    // 模块级变量（第二十四刀）：与槽位那两条同一个形状，只是地址是 `@g_名字` 而不是
    // `%s号`。类型从全局池取（GLOAD 的 `t` 也是它，两处必须一致 —— verify 盯着这条）。
    if (op === OP.GLOAD) {
      this.line(`  ${dst} = load ${this.ty(t, 'global')}, ptr @g_${this.mir.globals[f.aux[i]]}`);
      return;
    }
    if (op === OP.GSTORE) {
      const gt = this.ty(this.mir.globalTy[f.aux[i]], 'global');
      this.line(`  store ${gt} ${this.val(f.a[i])}, ptr @g_${this.mir.globals[f.aux[i]]}`);
      return;
    }
    // 结构体四条（ADR-0014 门槛 2 第十二刀）：NEW/COPY 从 arena 拿一块，FLD/FLDSET 是
    // getelementptr + load/store。身份全在 aux 上（类型池 / 访问描述符池），所以这条腿
    // 不需要"槽位上的聚合类型"这种东西 —— MIR 刻意没有它，见 mir/ir.js 的类型码那一节。
    if (op === OP.NEW || op === OP.COPY || op === OP.FLD || op === OP.FLDSET) {
      this.aggInsn(f, i, op, dst, t);
      return;
    }
    // 缓冲四条：三条走私有函数（越界检查带分支，展开会搅乱区域记账），BLEN 就地取字段
    if (op === OP.BNEW || op === OP.BLEN || op === OP.BGET || op === OP.BSET) {
      this.bufInsn(f, i, op, dst, t);
      return;
    }
    // 数组六条：全是 call 运行时符号，没有一处 IR 逻辑
    if (op === OP.ANEW || op === OP.ALEN || op === OP.AGET || op === OP.ASET
        || op === OP.APUSH || op === OP.APOP) {
      this.arrInsn(f, i, op, dst, t);
      return;
    }
    // 指针九条（ADR-0016）
    if (op === OP.PNEW || op === OP.PNULL || op === OP.PISNULL || op === OP.PTHIN
        || op === OP.PLOAD || op === OP.PSTORE || op === OP.PADD || op === OP.PSUB
        || op === OP.PEQ) {
      this.ptrInsn(f, i, op, dst, t);
      return;
    }
    // 线性内存四条（ADR-0017 第二刀）
    if (op === OP.MSIZE || op === OP.MGROW || op === OP.MLOAD || op === OP.MSTORE) {
      this.memInsn(f, i, op, dst, t);
      return;
    }
    // 向量三条 + 向量上的四则运算。分流要在标量表之前：`add <4 x i64>` 是合法的，
    // 但 `/`（整数）和 `& 63` 那些辅助函数是标量签名，落进去会发出对不上的 IR。
    // 条件里刻意**不是**"只要 t 是向量"：返回向量的 CALL、装载向量的 LOAD 的 `t` 也是向量，
    // 而它们的发射方式与元素类型无关，走下面那条通路就对。
    if (op === OP.VSPLAT || op === OP.VINS || op === OP.VEXT
      || (lanes > 1 && (BIN_LL.has(op) || op === OP.NEG))) {
      this.vecInsn(f, i, op, dst, t);
      return;
    }
    // 字符串要**在标量表之前**分流：`t` 是 T_STR 时 isF 为假，落到 BIN_LL 会发出
    // `add [2 x i64]` 这种既不合法又语义全错的东西。先拦住。
    // 只截运算与比较 —— CALL / CALLOP 的 `t` 也可能是 T_STR（返回字符串的函数），
    // 那两条走下面的通路，类型由 ty() 统一映射。
    if (t === T_STR && (op === OP.ADD || (op >= OP.EQ && op <= OP.GT))) {
      this.strInsn(f, i, op, dst);
      return;
    }
    if (BIN_LL.has(op)) {
      const kind = BIN_LL.get(op);
      const ll = isF ? kind[1] : kind[0];
      // null = 这个类型上没有一条指令能直接用（i64 的 `/` `%`），交给下面的分支
      if (ll !== null) {
        this.line(`  ${dst} = ${ll} ${this.ty(t, OP_NAMES[op])} ${this.val(f.a[i])}, ${this.val(f.b[i])}`);
        return;
      }
    }
    // i32 的除法与无符号除法（ADR-0017 第一刀）：**扩到 64 位借那四个辅助函数，再截回来**。
    // 不为 i32 另写四个辅助函数的理由是语义要一条：除零那句错误消息、
    // INT32_MIN / -1 的回绕（借 i64 算出 2147483648 再 trunc 就是 INT32_MIN），
    // 与解释器的 bin32 逐条对上。多一份辅助函数就多一处两条腿会分叉的地方。
    if (is32 && (op === OP.DIV || op === OP.MOD || op === OP.UDIV || op === OP.UMOD)) {
      const un = op === OP.UDIV || op === OP.UMOD;
      const cast = un ? 'zext' : 'sext';
      const a64 = this.fresh();
      const b64 = this.fresh();
      const wide = this.fresh();
      this.line(`  ${a64} = ${cast} i32 ${this.val(f.a[i])} to i64`);
      this.line(`  ${b64} = ${cast} i32 ${this.val(f.b[i])} to i64`);
      let sym = '@omni_ll_div';
      if (op === OP.MOD) sym = '@omni_ll_mod';
      if (op === OP.UDIV) sym = '@omni_ll_udiv';
      if (op === OP.UMOD) sym = '@omni_ll_umod';
      if (op === OP.DIV) this.needDiv = true;
      if (op === OP.MOD) this.needMod = true;
      if (op === OP.UDIV) this.needUDiv = true;
      if (op === OP.UMOD) this.needUMod = true;
      this.line(`  ${wide} = call i64 ${sym}(i64 ${a64}, i64 ${b64})`);
      this.line(`  ${dst} = trunc i64 ${wide} to i32`);
      return;
    }
    // i32 的移位：掩码是 **31**（wasm 的 `i32.shl` 是 count mod 32；C 那边 tcc 同样掩码）
    if (is32 && (op === OP.SHL || op === OP.SHR || op === OP.USHR)) {
      const m = this.fresh();
      const ins = op === OP.SHL ? 'shl' : (op === OP.SHR ? 'ashr' : 'lshr');
      this.line(`  ${m} = and i32 ${this.val(f.b[i])}, 31`);
      this.line(`  ${dst} = ${ins} i32 ${this.val(f.a[i])}, ${m}`);
      return;
    }
    // `/` `%` 走辅助函数：除零要报错、INT64_MIN/-1 要特判，与 omni.h:332..343 逐条对应
    if (op === OP.DIV && !isF) {
      this.needDiv = true;
      this.line(`  ${dst} = call i64 @omni_ll_div(i64 ${this.val(f.a[i])}, i64 ${this.val(f.b[i])})`);
      return;
    }
    if (op === OP.MOD && !isF) {
      this.needMod = true;
      this.line(`  ${dst} = call i64 @omni_ll_mod(i64 ${this.val(f.a[i])}, i64 ${this.val(f.b[i])})`);
      return;
    }
    // 无符号那两个（第六十一刀）：除零那句话与上面两个共用，溢出特判没有
    if (op === OP.UDIV) {
      this.needUDiv = true;
      this.line(`  ${dst} = call i64 @omni_ll_udiv(i64 ${this.val(f.a[i])}, i64 ${this.val(f.b[i])})`);
      return;
    }
    if (op === OP.UMOD) {
      this.needUMod = true;
      this.line(`  ${dst} = call i64 @omni_ll_umod(i64 ${this.val(f.a[i])}, i64 ${this.val(f.b[i])})`);
      return;
    }
    // 移位量先 `& 63`：C 那边是 `b & 63`，而 LLVM 里移过位宽是 poison。
    // `u>>` 是逻辑右移（lshr）—— 与 `>>` 的算术右移（ashr）差的就是补符号位还是补零。
    if (op === OP.SHL || op === OP.SHR || op === OP.USHR) {
      const m = this.fresh();
      const ins = op === OP.SHL ? 'shl' : (op === OP.SHR ? 'ashr' : 'lshr');
      this.line(`  ${m} = and i64 ${this.val(f.b[i])}, 63`);
      this.line(`  ${dst} = ${ins} i64 ${this.val(f.a[i])}, ${m}`);
      return;
    }
    if (op === OP.NEG) {
      if (isF) this.line(`  ${dst} = fneg ${this.ty(t, 'neg')} ${this.val(f.a[i])}`);
      else this.line(`  ${dst} = sub ${this.ty(t, 'neg')} 0, ${this.val(f.a[i])}`);
      return;
    }
    if (op === OP.BNOT) { this.line(`  ${dst} = xor ${this.ty(t, 'bnot')} ${this.val(f.a[i])}, -1`); return; }
    if (op === OP.NOT) { this.line(`  ${dst} = xor i1 ${this.val(f.a[i])}, true`); return; }
    if (isCmp(op)) {
      const pred = isF ? FCMP.get(op) : ICMP.get(op);
      const cmp = isF ? 'fcmp' : 'icmp';
      this.line(`  ${dst} = ${cmp} ${pred} ${this.ty(t, 'compare')} ${this.val(f.a[i])}, ${this.val(f.b[i])}`);
      return;
    }
    if (op === OP.CVT) {
      const mode = f.aux[i];
      // 整数 <-> 浮点那三条：源类型看操作数、目标类型看 `t`，所以 i32/f32 不用另立模式
      const st = this.ty(f.typeOf(f.a[i], this.mir.consts), 'cvt 源');
      const rt = this.ty(t, 'cvt 目标');
      if (mode === CVT_I2F) { this.line(`  ${dst} = sitofp ${st} ${this.val(f.a[i])} to ${rt}`); return; }
      // 位当无符号读再转（第六十一刀）：sitofp 换 uitofp，一条指令的差别
      if (mode === CVT_U2F) { this.line(`  ${dst} = uitofp ${st} ${this.val(f.a[i])} to ${rt}`); return; }
      if (mode === CVT_F2I) { this.line(`  ${dst} = fptosi ${st} ${this.val(f.a[i])} to ${rt}`); return; }
      /* 浮点 -> 无符号（第九十五片）：`fptoui`。与 `fptosi` 差的是越界那一带 ——
       * 2^63 以上只有 `fptoui` 给得出正确的位。 */
      if (mode === CVT_F2U) { this.line(`  ${dst} = fptoui ${st} ${this.val(f.a[i])} to ${rt}`); return; }
      // ---- 宽度转换（ADR-0017 第一刀）
      if (mode === CVT_SEXT) { this.line(`  ${dst} = sext ${st} ${this.val(f.a[i])} to ${rt}`); return; }
      if (mode === CVT_ZEXT) { this.line(`  ${dst} = zext ${st} ${this.val(f.a[i])} to ${rt}`); return; }
      if (mode === CVT_TRUNC) { this.line(`  ${dst} = trunc ${st} ${this.val(f.a[i])} to ${rt}`); return; }
      // 低 8/16 位的符号扩展：LLVM 没有一条"就地扩展"的指令，是 trunc 到窄宽再 sext 回来。
      // 这两条在 arm64 上会被折成一条 sxtb/sxth —— 我们不替它做，那是它的活。
      if (mode === CVT_SEXT8 || mode === CVT_SEXT16) {
        const nb = mode === CVT_SEXT8 ? 'i8' : 'i16';
        const cut = this.fresh();
        this.line(`  ${cut} = trunc ${st} ${this.val(f.a[i])} to ${nb}`);
        this.line(`  ${dst} = sext ${nb} ${cut} to ${rt}`);
        return;
      }
      if (mode === CVT_FCVT) {
        const ins = t === T_F32 ? 'fptrunc' : 'fpext';
        this.line(`  ${dst} = ${ins} ${st} ${this.val(f.a[i])} to ${rt}`);
        return;
      }
      throw new OmniError(`${NOPE} CVT ${mode}（函数 ${f.name}）`);
    }
    if (op === OP.CALL) {
      const g = this.mir.funcs[f.a[i]];
      const refs = f.argsOf(f.b[i]);
      const rt = this.ty(g.ret, `${g.name} 的返回值`);
      /* 被调者的体不在这个模块里（`MirFunc.extern`）：实参按 C 的 ABI 摆（胖指针要抽地址，
         见 externArg），签名从**这个调用点**收上来，与 CCALL 共用那一格回填 ——
         原生腿的外部函数记录上没有 params。 */
      if (g.extern === true) {
        const as = refs.map((r) => this.externArg(r));
        const sig = `${rt} (${as.map((a) => a.ty).concat(g.variadic === true ? ['...'] : []).join(', ')})`;
        const was = this.cabiDecl.get(g.name);
        if (was === undefined) this.cabiDecl.set(g.name, sig);
        else if (was !== sig) {
          throw new OmniError(`llvm: ${g.name} 在两处的签名不一样（${was} vs ${sig}）—— `
            + '同一个外部符号只能有一份声明');
        }
        const cargs = as.map((a) => a.text).join(', ');
        const call = g.variadic === true
          ? `call ${sig} @${g.name}(${cargs})`
          : `call ${rt} @${g.name}(${cargs})`;
        this.line(rt === 'void' ? `  ${call}` : `  ${dst} = ${call}`);
        return;
      }
      const args = refs.map((r) => this.typed(r));
      const call = `call ${rt} @${g.name}(${args.join(', ')})`;
      this.line(rt === 'void' ? `  ${call}` : `  ${dst} = ${call}`);
      return;
    }
    if (op === OP.CALLOP) {
      const entry = this.mir.ops[f.a[i]];
      const d = RT_OPS.get(entry.name);
      if (d === undefined) {
        throw new OmniError(`${NOPE} op '${entry.name}'（函数 ${f.name}）`);
      }
      const refs = f.argsOf(f.b[i]);
      if (refs.length !== d.params.length) {
        throw new OmniError(`llvm: ${entry.name} 要 ${d.params.length} 个实参，实得 ${refs.length}`);
      }
      const args = refs.map((r, k) => `${d.params[k]} ${this.val(r)}`);
      const call = `call ${d.ret} @${d.sym}(${args.join(', ')})`;
      this.line(d.ret === 'void' ? `  ${call}` : `  ${dst} = ${call}`);
      return;
    }
    /**
     * 外部 C 符号（ADR-0014 决策 4 / ADR-0022 的 J4）：`a` 是 C_ABI 入口号，
     * `aux` 是**变参分界** —— 0 表示不是变参，否则就是定参个数（与 `CALLI` 同一个编码）。
     *
     * 这一层不做 marshal：MIR 到这儿的实参已经是**机器上的值**了（cstr 是 ptr、
     * int 是 i32/i64）。JS 那条腿要在门口装卸 BigInt，是因为那条腿的整数是 BigInt，
     * 与这一格无关（见 mir/emit_js.js 的 CCALL）。
     *
     * `setjmp` / `longjmp` 这一层不收：它们要的是**帧**，而 IR 上这儿只有实参。
     * emit_js 那侧同一格拒（JS_NOJMP），理由一模一样 —— 两条腿的边界必须一样。
     */
    if (op === OP.CCALL) {
      const entry = this.mir.cabi[f.a[i]];
      if (LL_NOJMP.has(entry)) {
        throw new OmniError(`${NOPE} ${entry}（它要回到同一帧的同一条指令，`
          + 'IR 上这儿只有实参）—— 用 --backend interp');
      }
      const refs = f.argsOf(f.b[i]);
      const as = refs.map((r) => this.externArg(r));
      const rt = this.ty(t, `${entry} 的返回值`);
      const nfixed = f.aux[i];
      const variadic = nfixed !== 0;
      /* 声明只按**定参**发：同一个变参函数在不同调用点的实参个数不同，而定参那几格一样。 */
      const fixed = as.slice(0, variadic ? nfixed : as.length).map((a) => a.ty);
      const sig = `${rt} (${fixed.concat(variadic ? ['...'] : []).join(', ')})`;
      const was = this.cabiDecl.get(entry);
      if (was === undefined) this.cabiDecl.set(entry, sig);
      else if (was !== sig) {
        throw new OmniError(`llvm: ${entry} 在两处的签名不一样（${was} vs ${sig}）—— `
          + '同一个外部符号只能有一份声明');
      }
      /* 变参的调用点必须写出函数类型（LLVM 要靠它知道哪几格是定参）；不是变参的照常写。 */
      const cargs = as.map((a) => a.text).join(', ');
      const call = variadic
        ? `call ${sig} @${entry}(${cargs})`
        : `call ${rt} @${entry}(${cargs})`;
      this.line(rt === 'void' ? `  ${call}` : `  ${dst} = ${call}`);
      return;
    }
    if (op === OP.CAPTURE) {      const p = this.fresh();
      this.line(`  ${p} = getelementptr %clo_${this.f.closureId}, ptr %self, i64 0, i32 ${f.aux[i] + 1}`);
      this.line(`  ${dst} = load ${this.ty(t, 'capture')}, ptr ${p}`);
      return;
    }
    if (op === OP.CLOSURE) {
      const c = this.mir.closures[f.a[i]];
      const args = f.argsOf(f.b[i]).map((r) => this.typed(r));
      this.line(`  ${dst} = call ptr @${c.make}(${args.join(', ')})`);
      return;
    }
    // 间接调用。被调者在**记录的第 0 格**（与 struct omni_closure_s 同一个布局），
    // 记录自己当第一个实参传回去。取 fp 与传 self 用的是同一个寄存器 ——
    // 不这么写的话 `f` 会被求值两次（C 那条腿的 fnCallHelper 是同一条理由）。
    if (op === OP.CALLFN) {
      if (f.aux[i] !== 0) throw new OmniError(`${NOPE} JS 域的动态调用（函数 ${f.name}）`);
      this.needFnck = true;
      const ck = this.fresh();
      const fp = this.fresh();
      this.line(`  ${ck} = call ptr @omni_ll_fnck(ptr ${this.val(f.a[i])})`);
      this.line(`  ${fp} = load ptr, ptr ${ck}`);
      const args = [`ptr ${ck}`];
      for (const r of f.argsOf(f.b[i])) args.push(this.typed(r));
      const rt = this.ty(t, 'callfn 的返回值');
      const call = `call ${rt} ${fp}(${args.join(', ')})`;
      this.line(rt === 'void' ? `  ${call}` : `  ${dst} = ${call}`);
      return;
    }
    throw new OmniError(`${NOPE} ${OP_NAMES[op]}（函数 ${f.name}）`);
  }

  /* -------------------------------------------------------------- 字符串 */

  /**
   * `t` 是 T_STR 的运算与比较。
   *
   * 拼接是真符号（`omni_str_cat`），直接 call。比较不是 —— `omni_str_cmp` 在
   * omni.h 里是 static inline，所以在 IR 里重建成一个私有函数（见 STRCMP_HELPER），
   * 语义逐句对着那八行抄。相等/不等本可以短路成「长度不同直接 false」，
   * **故意不这么写**：那是另一条语义路径，与 C 那边就不再是同一份代码了，
   * 而这一层的全部风险就在「两条腿在边角上分叉」。
   */
  strInsn(f, i, op, dst) {
    if (op === OP.ADD) {
      this.needStrCat = true;
      this.line(`  ${dst} = call [2 x i64] @omni_str_cat([2 x i64] ${this.val(f.a[i])}, `
        + `[2 x i64] ${this.val(f.b[i])})`);
      return;
    }
    this.needStrCmp = true;
    const c = this.fresh();
    this.line(`  ${c} = call i32 @omni_ll_strcmp([2 x i64] ${this.val(f.a[i])}, `
      + `[2 x i64] ${this.val(f.b[i])})`);
    this.line(`  ${dst} = icmp ${ICMP.get(op)} i32 ${c}, 0`);
  }

  /**
   * 结构体四条（门槛 2 第十二刀）。值是**指向自己那块内存的指针**（见 LL_TYPES 的注释）。
   *
   *   NEW    从 arena 拿一块，逐字段写零值
   *   COPY   再拿一块，逐字段 load/store —— 这就是 ADR-0005 的值语义在这条腿上的落点
   *   FLD    getelementptr + load
   *   FLDSET getelementptr + store
   *
   * 内存来自 **arena**（omni_ll_alloc），不是入口块的 alloca。理由是返回值：
   * `(fn mk () Point (ret (new Point)))` 里那块内存要活过 mk 的栈帧，alloca 出来的会悬空。
   * arena 从不回收 —— 这与运行时其它部分（数组、字符串、class）一样，不是这一刀新引入的
   * 取舍，见 runtime/omni.h 的分配器那一节。
   *
   * 逐字段而不是 memcpy：字段类型这一层本来就要认（零值要按类型写），而 memcpy 要多
   * declare 一个 intrinsic、还要自己算大小。逐字段的另一个好处是"复制到底多深"这件事
   * 在 IR 里看得见 —— 数组/字符串字段复制的是句柄，与 JS 后端的 `$cp_S` 逐字段拷同一个意思。
   */
  aggInsn(f, i, op, dst, t) {
    if (op === OP.FLD || op === OP.FLDSET) {
      const acc = this.access(f.aux[i]);
      let obj = this.val(f.a[i]);
      // 类是引用类型，可能是空引用：两个后端都在**访问点**显式判空，消息也是同一句
      // （运行时的 omni_nullck，omni.h:76）。判空不在 MIR 里 —— MIR 没有 NULLCK 指令，
      // C 那条腿也是在发射时插的，所以这里跟着插，两条腿的行为才是同一份。
      if (acc.isClass) {
        const p = this.fresh();
        this.needNullck = true;
        this.line(`  ${p} = call ptr @omni_nullck(ptr ${obj})`);
        obj = p;
      }
      // 内嵌的结构体字段（第十七刀）：它的存储就在父对象那块内存里，所以"字段的值"
      // 就是那个地址本身 —— 一条 getelementptr，没有 load。这正是 struct 的值语义能
      // 落在这条腿上的原因：`(fld …)` 交出去的指针指着父对象，而 from_oir 在需要值的
      // 地方会先发 OP.COPY。
      const inner = acc.field.type.k === 'struct' ? `%s_${acc.field.type.name}` : null;
      if (op === OP.FLD && inner !== null) {
        this.line(`  ${dst} = getelementptr ${acc.type}, ptr ${obj}, i32 0, i32 ${acc.index}`);
        return;
      }
      const g = this.fresh();
      this.line(`  ${g} = getelementptr ${acc.type}, ptr ${obj}, i32 0, i32 ${acc.index}`);
      if (op === OP.FLD) this.line(`  ${dst} = load ${this.ty(t, 'field')}, ptr ${g}`);
      else if (inner !== null) {
        // 往内嵌字段里赋值：搬的是**内容**，不是指针（右边那个 ptr 指着另一块内存）
        const v = this.fresh();
        this.line(`  ${v} = load ${inner}, ptr ${this.val(f.b[i])}`);
        this.line(`  store ${inner} ${v}, ptr ${g}`);
      } else this.line(`  store ${this.typed(f.b[i])}, ptr ${g}`);
      return;
    }
    const ty = this.aggType(f.aux[i]);
    this.aggUsed = true;
    this.line(`  ${dst} = call ptr @omni_ll_alloc(i64 ptrtoint `
      + `(ptr getelementptr (${ty.name}, ptr null, i32 1) to i64))`);
    if (op === OP.NEW) { this.aggZero(ty.name, ty.fields, dst, ty.plain); return; }
    let k = 0;
    while (k < ty.fields.length) {
      const fd = ty.fields[k];
      const g = this.fresh();
      this.line(`  ${g} = getelementptr ${ty.name}, ptr ${dst}, i32 0, i32 ${k}`);
      // 内嵌结构体字段也走这一条：`load %s_Point` 是一次首类聚合读，搬的是那几个字节 ——
      // 递归的深拷贝因此不必手写，而里面的数组/字符串字段搬的仍然是句柄（引用语义）。
      const lt = this.fieldTy(fd.type, `${ty.plain}.${fd.name}`);
      const s = this.fresh();
      const v = this.fresh();
      this.line(`  ${s} = getelementptr ${ty.name}, ptr ${this.val(f.a[i])}, i32 0, i32 ${k}`);
      this.line(`  ${v} = load ${lt}, ptr ${s}`);
      this.line(`  store ${lt} ${v}, ptr ${g}`);
      k++;
    }
  }

  /** 零值：往 `base` 那块内存里逐字段铺一遍。内嵌结构体字段递归下去 —— 不发
   *  `zeroinitializer`，因为字符串字段的零是常量池里那份空串、数组字段的零是一次
   *  运行时调用，两者都不是全零位。 */
  aggZero(tyName, fields, base, plain) {
    let k = 0;
    while (k < fields.length) {
      const fd = fields[k];
      const g = this.fresh();
      this.line(`  ${g} = getelementptr ${tyName}, ptr ${base}, i32 0, i32 ${k}`);
      const what = `${plain}.${fd.name}`;
      if (fd.type.k === 'struct') this.aggZero(`%s_${fd.type.name}`, fd.type.fields, g, fd.type.name);
      else this.line(`  store ${this.fieldTy(fd.type, what)} ${this.fieldInit(fd.type, what)}, ptr ${g}`);
      k++;
    }
  }

  /** 类型池的第 n 项 -> `{name: '%s_Foo', plain: 'Foo', fields, isClass}`。只认 struct 与 class。 */
  aggType(n) {
    const t = this.mir.types[n];
    if (t === undefined || (t.kind !== 'struct' && t.kind !== 'class')) {
      throw new OmniError(`${NOPE}聚合 ${t === undefined ? n : t.kind}`
        + `（函数 ${this.f === null ? '?' : this.f.name}）`);
    }
    const cls = t.kind === 'class';
    return { name: `%${cls ? 'c' : 's'}_${t.name}`, plain: t.name, fields: t.oir.fields, isClass: cls };
  }

  /** 访问描述符的第 n 项 -> `{type: '%s_Foo', index, isClass, field}`。字段号就是声明顺序。 */
  access(n) {
    const acc = this.mir.accs[n];
    if (acc === undefined) throw new OmniError(`llvm: 没有第 ${n} 个字段访问描述符`);
    const ty = this.aggType(acc.type);
    let k = 0;
    while (k < ty.fields.length) {
      if (ty.fields[k].name === acc.field) {
        return { type: ty.name, index: k, isClass: ty.isClass, field: ty.fields[k] };
      }
      k++;
    }
    throw new OmniError(`llvm: ${ty.plain} 没有字段 ${acc.field}`);
  }

  /** 字段的 LLVM 类型。四种标量、向量（第十五刀）、数组（第十六刀，就是个不透明指针）、
   *  内嵌的结构体与类（第十七刀），表外的报错（阶段边界，与 ty() 同一条规矩）。 */
  fieldTy(t, what) {
    if (t.k === 'int') return 'i64';
    if (t.k === 'real') return 'double';
    if (t.k === 'bool') return 'i1';
    if (t.k === 'string') return '[2 x i64]';
    // 向量字段就是原生的 `<N x T>` —— 与这条腿别处的向量表示同一个（见 ty()）。
    // 对齐不用操心：`omni_ll_alloc` 后面就是 malloc，而 malloc 保证的对齐够 16 字节。
    if (t.k === 'vec') return `<${t.lanes} x ${this.fieldTy(t.elem, what)}>`;
    // 数组字段存的是**句柄**（一个指针）。所以 COPY 那条逐字段 load/store 拷出来的
    // 两个结构体共用同一条数组 —— 引用语义，与"数组当形参"是同一条规则。
    if (t.k === 'arr') return 'ptr';
    // 内嵌的结构体（值语义）：**摊在父对象里**，所以字段类型就是那个命名类型本身 ——
    // 一次 `load %s_Point` 就是把那几个字节搬走，深拷贝不用手写。
    if (t.k === 'struct') return `%s_${t.name}`;
    // 内嵌的类（引用语义）：只存一个指针，与裸的类变量同一个表示。
    if (t.k === 'class') return 'ptr';
    // 函数值字段（闭包）：也只存一个指针 —— 指向那条 `%clo_<n>` 记录，第 0 格是函数指针
    // （见 closureTypes）。与"类字段"同一条：引用语义，COPY 拷的是句柄。
    if (t.k === 'fn') return 'ptr';
    // 指针字段（第十七刀之后）：与这条腿别处的指针表示同一个 —— fat 是那个一等聚合
    // `{addr, base, end}`（LL 表里 T_PTR 那一条），thin 是一个不透明指针。都是**值**，
    // 所以 COPY 那条 `load %s_S` / `store %s_S` 把三个字一起搬走，不用另写一条。
    if (t.k === 'ptr') return '{ ptr, ptr, ptr }';
    if (t.k === 'tptr') return 'ptr';
    // 定长内存的字段（第二十二刀）：LLVM 自己就有这个类型 —— `[N x T]`，**摊在父对象里**，
    // 与内嵌结构体同一档。多维就是嵌套的 `[2 x [3 x i64]]`，尺寸与对齐跟 C 一致。
    if (t.k === 'blk') return `[${t.n} x ${this.fieldTy(t.el, what)}]`;
    throw new OmniError(`${NOPE}结构体字段的类型 ${t.k}：${what}`);
  }

  /**
   * 字段的**初始值**。标量与向量是常量（fieldZero），数组不是：它的零值是一次运行时
   * 调用 `omni_arr_*_new(0, 元素零值)`，所以这个函数可以往当前基本块里发指令，
   * 回来的是那个值的名字。NEW 之外没人用它 —— COPY 走的是 load/store。
   */
  fieldInit(t, what) {
    if (t.k !== 'arr') return this.fieldZero(t, what);
    const dst = this.fresh();
    // 向量元素与类元素都走运行时那份按字节的 blob 实现 —— 步长各来自一处，与 arrRep 同一套：
    // 向量的格子里躺内容（道数 × 8），类的格子里躺句柄（一个指针 = 8）。
    // 长度 0 时 blob_new **不会**碰零值那个指针（omni_arr.c 里那个 memcpy 循环跑 n 次），
    // 所以这里传 null，不为它开一块 alloca —— 开的话还要在入口块预扫一遍 NEW，
    // 而这条路上零值本来就没人读。
    if (t.elem.k === 'vec' || t.elem.k === 'class' || t.elem.k === 'arr' || t.elem.k === 'fn') {
      const esz = t.elem.k === 'vec' ? t.elem.lanes * 8 : 8;
      this.needArrBlob = true;
      this.line(`  ${dst} = call ptr @omni_arr_blob_new(i64 0, i64 ${esz}, ptr null)`);
      return dst;
    }
    const e = this.noteArrElem(this.fieldElem(t.elem, what));
    this.line(`  ${dst} = call ptr @omni_arr_${e.suffix}_new(i64 0, ${e.p} ${this.fieldZero(t.elem, what)})`);
    return dst;
  }

  /** 数组字段的元素类型：OIR 的类型 -> MIR 的 8 位类型码（ARR_ELEMS 认的就是这个码） */
  fieldElem(t, what) {
    if (t.k === 'int') return T_I64;
    if (t.k === 'real') return T_F64;
    if (t.k === 'bool') return T_BOOL;
    if (t.k === 'string') return T_STR;
    throw new OmniError(`${NOPE}数组字段的元素类型 ${t.k}：${what}`);
  }

  /** 字段的零值。字符串走 strConst('')，与常量池里那份空串**同一条路** —— 不另造一个
   *  `zeroinitializer`（空指针 + 长度 0 在运行时是另一种东西，不必去试它对不对）。
   *  向量反过来正好用 `zeroinitializer`：它就是逐道的零，没有第二种表示。 */
  fieldZero(t, what) {
    if (t.k === 'int') return '0';
    if (t.k === 'real') return '0.0';
    if (t.k === 'bool') return 'false';
    if (t.k === 'string') return this.strConst('');
    if (t.k === 'vec') return 'zeroinitializer';
    // 内嵌的类：零值是空引用。结构体走不到这里 —— 它的零值是 aggZero 递归铺的。
    if (t.k === 'class') return 'null';
    // 函数值字段：零值也是空引用（与 fieldTy 里那条对应）。调它是未定义行为，
    // 与"调一个空的类引用取字段"同一级 —— 那条也没有运行时检查。
    if (t.k === 'fn') return 'null';
    // 指针字段的零 = 空指针。fat 的三个字全零就是它（PNULL 那条发的 insertvalue 折出来
    // 也是这个常量），thin 就是 null —— 这里在常量位置，不必借 SSA 那两条指令。
    if (t.k === 'ptr') return 'zeroinitializer';
    if (t.k === 'tptr') return 'null';
    // 定长内存的字段（第二十二刀）：`[N x T]` 的全零就是 zeroinitializer。元素是 string
    // 那种"零不是全零位"的类型走不到这里 —— blkTy 那道闸门只放行 ptrTargetOk 的那几种。
    if (t.k === 'blk') return 'zeroinitializer';
    throw new OmniError(`${NOPE}结构体字段的零值 ${t.k}：${what}`);
  }

  /**
   * 缓冲四条（门槛 7 第一阶段）。`{i64, ptr}` 里第 0 个字段是长度，第 1 个是数据。
   * new/get/set 都调私有函数（见 bufHelpers）：越界检查带分支，而调用点在结构化控制流的
   * 中间，就地展开会把 live/regions 那套记账搅乱。BLEN 没有分支，所以就地取字段。
   */
  bufInsn(f, i, op, dst, t) {
    if (op === OP.BLEN) {
      this.line(`  ${dst} = extractvalue { i64, ptr } ${this.val(f.a[i])}, 0`);
      return;
    }
    // BNEW 的元素类型在 aux 上（结果类型是缓冲本身）；get/set 的元素类型就是 `t`
    const el = op === OP.BNEW ? f.aux[i] : t;
    const s = this.noteBufElem(el);
    if (op === OP.BNEW) {
      this.line(`  ${dst} = call { i64, ptr } @omni_ll_bnew_${s}(i64 ${this.val(f.a[i])})`);
      return;
    }
    const et = this.ty(el, 'buffer element');
    if (op === OP.BGET) {
      this.line(`  ${dst} = call ${et} @omni_ll_bget_${s}({ i64, ptr } ${this.val(f.a[i])}, `
        + `i64 ${this.val(f.b[i])})`);
      return;
    }
    const args = f.argsOf(f.b[i]);
    this.line(`  ${dst} = call ${et} @omni_ll_bset_${s}({ i64, ptr } ${this.val(f.a[i])}, `
      + `i64 ${this.val(args[0])}, ${et} ${this.val(args[1])})`);
  }

  /**
   * 指针八条（ADR-0016）。带检查的三处（分配、解引用、指针差）全是 call 运行时符号 ——
   * 与数组那六条同一条理由：run-c 调的是同一个符号的同一份机器码，所以越界与空引用的
   * 消息不可能在两条原生腿之间分叉。不带检查的（PNULL/PISNULL/PTHIN/PADD）就地发 IR。
   *
   * fat 指针在这里是一等聚合值 `{addr, base, end}`，靠 insertvalue/extractvalue 拆装。
   * 它不跨 C 边界（omni.h 里的真符号一律是平的），所以这个拼法只需自洽。
   */
  ptrInsn(f, i, op, dst, t) {
    const P = '{ ptr, ptr, ptr }';
    const x = f.aux[i];
    if (op === OP.PNULL) {
      // 空指针也得是**这条指令定义的名字**（SSA），所以不能直接写 null：
      // thin 借一条零偏移的 gep，fat 借一条 insertvalue。两者都会被 opt 折成常量。
      if (t === T_TPTR) this.line(`  ${dst} = getelementptr i8, ptr null, i64 0`);
      else this.line(`  ${dst} = insertvalue ${P} zeroinitializer, ptr null, 0`);
      return;
    }
    if (op === OP.PNEW) {
      this.needPtr = true;
      const n = this.val(f.a[i]);
      const base = this.fresh();
      const bytes = this.fresh();
      const end = this.fresh();
      const p0 = this.fresh();
      const p1 = this.fresh();
      // omni_pnew 只回块首（负数个数在那里报错），三个字在这里拼 —— 这样它就不必返回聚合
      this.line(`  ${base} = call ptr @omni_pnew(i64 ${n}, i64 ${x})`);
      this.line(`  ${bytes} = mul i64 ${n}, ${x}`);
      this.line(`  ${end} = getelementptr i8, ptr ${base}, i64 ${bytes}`);
      this.line(`  ${p0} = insertvalue ${P} zeroinitializer, ptr ${base}, 0`);
      this.line(`  ${p1} = insertvalue ${P} ${p0}, ptr ${base}, 1`);
      this.line(`  ${dst} = insertvalue ${P} ${p1}, ptr ${end}, 2`);
      return;
    }
    if (op === OP.PISNULL) {
      let a = this.val(f.a[i]);
      if (!this.ptrIsThin(f, f.a[i])) a = this.ptrWord(a, 0);
      this.line(`  ${dst} = icmp eq ptr ${a}, null`);
      return;
    }
    if (op === OP.PTHIN) {
      this.line(`  ${dst} = extractvalue ${P} ${this.val(f.a[i])}, 0`);
      return;
    }
    if (op === OP.PLOAD || op === OP.PSTORE) {
      const ad = this.ptrDeref(f, f.a[i], x);
      const et = this.ty(t, '指针的目标');
      if (op === OP.PLOAD) { this.line(`  ${dst} = load ${et}, ptr ${ad}`); return; }
      this.line(`  store ${et} ${this.val(f.b[i])}, ptr ${ad}`);
      // 这条指令的结果是"存进去的那个值"（另外三条腿也是）。回读一次而不是把操作数当结果：
      // dst 必须由这条指令自己定义，SSA 里不能把别人的 %v 改名。
      this.line(`  ${dst} = load ${et}, ptr ${ad}`);
      return;
    }
    if (op === OP.PADD) {
      const off = this.fresh();
      this.line(`  ${off} = mul i64 ${this.val(f.b[i])}, ${x}`);
      if (t === T_TPTR) {
        this.line(`  ${dst} = getelementptr i8, ptr ${this.val(f.a[i])}, i64 ${off}`);
        return;
      }
      // 走出块外不是错误（错误只在解引用处报），所以这里只动 addr 那一格，范围原样带着
      const a = this.ptrWord(this.val(f.a[i]), 0);
      const na = this.fresh();
      this.line(`  ${na} = getelementptr i8, ptr ${a}, i64 ${off}`);
      this.line(`  ${dst} = insertvalue ${P} ${this.val(f.a[i])}, ptr ${na}, 0`);
      return;
    }
    // 只比**地址那一个字**。fat 是个 SSA 聚合，LLVM 里聚合之间没有 icmp。
    if (op === OP.PEQ) {
      let a = this.val(f.a[i]);
      let b = this.val(f.b[i]);
      if (!this.ptrIsThin(f, f.a[i])) { a = this.ptrWord(a, 0); b = this.ptrWord(b, 0); }
      this.line(`  ${dst} = icmp eq ptr ${a}, ${b}`);
      return;
    }
    // PSUB
    if (this.ptrIsThin(f, f.a[i])) {
      const ia = this.fresh();
      const ib = this.fresh();
      const d = this.fresh();
      this.line(`  ${ia} = ptrtoint ptr ${this.val(f.a[i])} to i64`);
      this.line(`  ${ib} = ptrtoint ptr ${this.val(f.b[i])} to i64`);
      this.line(`  ${d} = sub i64 ${ia}, ${ib}`);
      this.line(`  ${dst} = sdiv i64 ${d}, ${x}`);
      return;
    }
    this.needPtr = true;
    const p = this.val(f.a[i]);
    const q = this.val(f.b[i]);
    const w = [this.ptrWord(p, 0), this.ptrWord(p, 1), this.ptrWord(p, 2),
      this.ptrWord(q, 0), this.ptrWord(q, 1), this.ptrWord(q, 2)];
    this.line(`  ${dst} = call i64 @omni_psub(${w.map((s) => `ptr ${s}`).join(', ')}, i64 ${x})`);
  }

  /** 取 fat 指针的第 n 个字（0 = addr、1 = base、2 = end），回临时名。 */
  ptrWord(p, n) {
    const v = this.fresh();
    this.line(`  ${v} = extractvalue { ptr, ptr, ptr } ${p}, ${n}`);
    return v;
  }

  /** 解引用前的检查，回一个可以直接 load/store 的地址。fat 查空 + 查范围，thin 只查空。 */
  ptrDeref(f, ref, size) {
    const p = this.val(ref);
    if (this.ptrIsThin(f, ref)) {
      this.needTPtr = true;
      const v = this.fresh();
      this.line(`  ${v} = call ptr @omni_tchk(ptr ${p})`);
      return v;
    }
    this.needPtr = true;
    const a = this.ptrWord(p, 0);
    const b = this.ptrWord(p, 1);
    const e = this.ptrWord(p, 2);
    const r = this.fresh();
    this.line(`  ${r} = call ptr @omni_pchk(ptr ${a}, ptr ${b}, ptr ${e}, i64 ${size})`);
    return r;
  }

  /** 一个指针操作数是 thin 还是 fat：看它那条指令的 `t`。指针不会从常量池来（空指针是
   *  PNULL 一条指令），所以这里只认指令 ref —— 与 mir/interp.js 的同名助手同一条判据。 */
  ptrIsThin(f, ref) {
    if (ref === REF_NONE || isConstRef(ref)) return false;
    return f.t[ref - REF_BIAS] === T_TPTR;
  }

  /* ------------------------------------------------------- 线性内存（第二刀）
   * 形状与指针那一路刻意一致：**先调运行时查一次界、拿到一个真地址，然后就地 load/store**。
   * 于是越界的那句话只有一份（omni_linmem.c 里那一句），run-c 与 run-llvm 调的是同一个
   * 符号的同一份机器码，不可能分叉。宽度与符号是编译期常量，所以扩展/截断发在 IR 里 ——
   * 运行时不需要知道"读的是 i32 还是 f64"。
   *
   * `align 1`：wasm 允许非对齐访问，而这一块的地址是程序算出来的。不写 align 1 的话
   * LLVM 会假定自然对齐，在 arm64 上生成的指令对非对齐地址是未定义行为。
   */
  memInsn(f, i, op, dst, t) {
    this.needLinMem = true;
    if (op === OP.MSIZE) { this.line(`  ${dst} = call i64 @omni_lin_size()`); return; }
    if (op === OP.MGROW) {
      this.line(`  ${dst} = call i64 @omni_lin_grow(i64 ${this.val(f.a[i])})`);
      return;
    }
    const isLoad = op === OP.MLOAD;
    const x = f.aux[i];
    const kind = (isLoad ? MLOAD_KINDS : MSTORE_KINDS)[memKindNo(x)];
    const off = memOff(x);
    const bytes = memBytes(x, isLoad);
    let a = this.val(f.a[i]);
    if (off !== 0) {
      const s = this.fresh();
      this.line(`  ${s} = add i64 ${a}, ${off}`);
      a = s;
    }
    const p = this.fresh();
    this.line(`  ${p} = call ptr @omni_lin_at(i64 ${a}, i64 ${bytes})`);
    const nt = MEM_LL_TY[kind];              // 内存里那几个字节的类型
    const rt = this.ty(t, '线性内存访问');    // MIR 上这条指令的类型
    if (isLoad) {
      if (nt === rt) { this.line(`  ${dst} = load ${nt}, ptr ${p}, align 1`); return; }
      const raw = this.fresh();
      this.line(`  ${raw} = load ${nt}, ptr ${p}, align 1`);
      if (kind.charCodeAt(0) === 102) this.line(`  ${dst} = fpext ${nt} ${raw} to ${rt}`);
      else if (kind.endsWith('u')) this.line(`  ${dst} = zext ${nt} ${raw} to ${rt}`);
      else this.line(`  ${dst} = sext ${nt} ${raw} to ${rt}`);
      return;
    }
    const v = this.val(f.b[i]);
    let w = v;
    if (nt !== rt) {
      w = this.fresh();
      if (kind.charCodeAt(0) === 102) this.line(`  ${w} = fptrunc ${rt} ${v} to ${nt}`);
      else this.line(`  ${w} = trunc ${rt} ${v} to ${nt}`);
    }
    this.line(`  store ${nt} ${w}, ptr ${p}, align 1`);
    // 这条指令的结果是**存进去之前的那个值**（另外三条腿也是），不是回读 —— 存 i8 的 300
    // 回读得到 44，那就与解释器分叉了。`select i1 true` 是恒等且对 -0.0 安全的写法
    // （`fadd 0.0` 会把 -0.0 变成 0.0），LLVM 当场折掉它。
    this.line(`  ${dst} = select i1 true, ${rt} ${v}, ${rt} ${v}`);
  }

  /** 记下用到的元素类型，返回助手名字的后缀。表外的报错 —— 缓冲只装 int/real。 */
  noteBufElem(t) {
    if (t !== T_I64 && t !== T_F64) {
      throw new OmniError(`${NOPE} ${typeText(t)} 的缓冲（函数 ${this.f.name}）`);
    }
    this.bufElems.set(t, true);
    return t === T_F64 ? 'f64' : 'i64';
  }

  /**
   * 数组六条。跟缓冲那四条的差别就一句话：**这里一行 IR 逻辑都没有**，六条全是
   * call 到 omni_arr.c 里的符号，而 run-c 那条腿调的是同一个符号的同一份机器码。
   * 越界检查、倍增、错误消息因此不存在"两条腿各写一份"的可能。
   */
  arrInsn(f, i, op, dst, t) {
    // ALEN 不看元素：长度存在 blob 与那四份单态**共用的同一个头**里（omni_arr.c），
    // 所以它没有 aux，走哪一份 `_len` 都是同一段机器码。其余五条的 aux 是**数组类型号**
    // （第十八刀）：元素的完整类型在池项的 `oir` 上，因为 `t` 那 8 位分不出
    // struct（值语义）与 class（引用语义）—— 两者都是 T_AGG。
    if (op !== OP.ALEN) {
      const rep = this.arrRep(f.aux[i], '数组的元素');
      if (rep.blob) { this.arrBlobInsn(f, i, op, dst, rep); return; }
    }
    const el = op === OP.ANEW
      ? this.fieldElem(this.arrRep(f.aux[i], 'anew 的元素').el, 'anew 的元素')
      : t;
    const e = this.noteArrElem(el);
    const s = e.suffix;
    const a = this.val(f.a[i]);
    if (op === OP.ANEW) {
      this.line(`  ${dst} = call ptr @omni_arr_${s}_new(i64 ${a}, ${e.p} ${this.val(f.b[i])})`);
      return;
    }
    if (op === OP.ALEN) {
      this.line(`  ${dst} = call i64 @omni_arr_${s}_len(ptr ${a})`);
      return;
    }
    if (op === OP.AGET) {
      this.line(`  ${dst} = call ${e.r} @omni_arr_${s}_get(ptr ${a}, i64 ${this.val(f.b[i])})`);
      return;
    }
    if (op === OP.APUSH) {
      this.line(`  ${dst} = call ${e.r} @omni_arr_${s}_push(ptr ${a}, ${e.p} ${this.val(f.b[i])})`);
      return;
    }
    if (op === OP.APOP) {
      this.line(`  ${dst} = call ${e.r} @omni_arr_${s}_pop(ptr ${a})`);
      return;
    }
    const args = f.argsOf(f.b[i]);
    this.line(`  ${dst} = call ${e.r} @omni_arr_${s}_set(ptr ${a}, i64 ${this.val(args[0])}, `
      + `${e.p} ${this.val(args[1])})`);
  }

  /**
   * 聚合元素的数组：运行时那一份按字节的 blob 实现管长度/容量/增长/越界消息，
   * `_at`/`_push`/`_pop` 回的是**格子的地址** —— 元素的读写在这里发一条 load / 一条 store，
   * 与这条腿发局部变量读写用的是同一份类型映射。C 那条腿是同一个符号加一层
   * static inline，两边不可能分叉。
   *
   * 两种元素走这里，步长各来自一处（`arrRep`）：
   *   - 向量（第八刀，asy 的 `pair[]`）：格子里躺**内容**，步长 = 道数 × 8。
   *   - 类（第十八刀，asy 的 `A[]`）：格子里躺**句柄**，步长 = 一个指针 = 8。
   */
  arrBlobInsn(f, i, op, dst, rep) {
    this.needArrBlob = true;
    const ety = rep.ety;
    const esz = rep.esz;
    const a = this.val(f.a[i]);
    if (op === OP.ANEW) {
      const zp = this.blobZero.get(ety);
      this.line(`  store ${ety} ${this.val(f.b[i])}, ptr ${zp}`);
      this.line(`  ${dst} = call ptr @omni_arr_blob_new(i64 ${a}, i64 ${esz}, ptr ${zp})`);
      return;
    }
    if (op === OP.ALEN) {
      this.line(`  ${dst} = call i64 @omni_arr_blob_len(ptr ${a})`);
      return;
    }
    if (op === OP.AGET) {
      const p = this.fresh();
      this.line(`  ${p} = call ptr @omni_arr_blob_at(ptr ${a}, i64 ${this.val(f.b[i])})`);
      this.line(`  ${dst} = load ${ety}, ptr ${p}`);
      return;
    }
    if (op === OP.APUSH) {
      const p = this.fresh();
      const v = this.val(f.b[i]);
      this.line(`  ${p} = call ptr @omni_arr_blob_push(ptr ${a})`);
      this.line(`  store ${ety} ${v}, ptr ${p}`);
      this.line(`  ${dst} = load ${ety}, ptr ${p}`);
      return;
    }
    if (op === OP.APOP) {
      const p = this.fresh();
      this.line(`  ${p} = call ptr @omni_arr_blob_pop(ptr ${a})`);
      this.line(`  ${dst} = load ${ety}, ptr ${p}`);
      return;
    }
    const args = f.argsOf(f.b[i]);
    const p = this.fresh();
    this.line(`  ${p} = call ptr @omni_arr_blob_at(ptr ${a}, i64 ${this.val(args[0])})`);
    this.line(`  store ${ety} ${this.val(args[1])}, ptr ${p}`);
    this.line(`  ${dst} = load ${ety}, ptr ${p}`);
  }

  /**
   * aux 上的**数组类型号** -> 这条腿要的元素表示（第十八刀）。
   * `t` 那 8 位只说得清元素的种类，而 T_AGG 里 struct 与 class 是同一个码 ——
   * 值语义与引用语义在这一层分不开就只能猜，所以身份走类型池的 `oir`。
   */
  arrRep(n, what) {
    const ty = this.mir.types[n];
    if (ty === undefined || ty.kind !== 'arr') {
      throw new OmniError(`${NOPE}数组类型号 ${n}（函数 ${this.f === null ? '?' : this.f.name}）`);
    }
    const el = ty.oir.elem;
    // 向量元素：格子里躺内容，步长 = 道数 × 8（向量的元素只有 int/real，都是 8 字节）
    if (el.k === 'vec') return { el, blob: true, ety: this.fieldTy(el, what), esz: el.lanes * 8 };
    // 类元素与**数组元素**：格子里躺句柄（一个指针 = 8）。后者是多维数组那一刀 ——
    // 行的零值是空引用（见 sexpr/lower.js 的 anew），所以"复制零值 N 遍"不会让 N 行共享。
    // **结构体元素还不收** —— 那是值语义，格子里躺的是内容，于是 anew/aset/apush 三处都要
    // 按元素类型拷一份，而 JS 与解释器那两条腿的 `arrCopy` 是类型擦除的（只认
    // Array.isArray），拷不动一个普通对象。
    // 函数值元素（第三十七刀）：C 侧是 `omni_fn`，同样是一个指针，所以与类元素同一档。
    if (el.k === 'class' || el.k === 'arr' || el.k === 'fn') return { el, blob: true, ety: 'ptr', esz: 8 };
    return { el, blob: false };
  }

  /** 记下用到的数组元素类型。表外的报错（阶段边界）——  方言只许四种标量。 */
  noteArrElem(t) {
    const e = ARR_ELEMS.get(t);
    if (e === undefined) {
      throw new OmniError(`${NOPE} ${typeText(t)} 的数组（函数 ${this.f.name}）`);
    }
    this.arrElems.set(t, true);
    return e;
  }

  /**
   * 向量（ADR-0014 门槛 6 第一阶段）。这条腿走 LLVM 的原生向量类型 `<N x T>`，
   * C 那条腿是标量化 —— 两者必须逐位相同，所以这里只用**逐道语义确定**的指令：
   *
   *   - `+ - *`：`add`/`fadd` 等在向量上就是逐道；i64 不带 nsw，回绕与 C 的 omni_add 一致。
   *   - `/`：f64 直接 `fdiv`（IEEE 逐道，无 fast-math）；**i64 要标量化** ——
   *     除零要报错、INT64_MIN/-1 要特判，那些在 @omni_ll_div 里，而它是标量签名。
   *   - splat：`insertelement` + 全零掩码的 `shufflevector`，clang 发的就是这个形状。
   *   - hsum 不在这里：它在 OIR -> MIR 那步就成了「VEXT + 左到右 ADD 链」，
   *     所以求值顺序是 MIR 的事实，不是这一层的选择（这正是门槛 6 要的）。
   *
   * 刻意**不发** `llvm.vector.reduce.fadd`：那条 intrinsic 的规约顺序由目标决定，
   * 用它就等于把「固定求值顺序」交给后端心情。
   */
  vecInsn(f, i, op, dst, t) {
    const lanes = typeLanes(t);
    const isF = typeKind(t) === T_F64;
    if (op === OP.VSPLAT) {
      const el = this.ty(typeKind(t), 'splat 的元素');
      const vt = this.ty(t, 'splat');
      const one = this.fresh();
      this.line(`  ${one} = insertelement ${vt} poison, ${el} ${this.val(f.a[i])}, i64 0`);
      this.line(`  ${dst} = shufflevector ${vt} ${one}, ${vt} poison, <${lanes} x i32> zeroinitializer`);
      return;
    }
    if (op === OP.VINS) {
      const el = this.ty(typeKind(t), 'insert 的元素');
      this.line(`  ${dst} = insertelement ${this.ty(t, 'insert')} ${this.val(f.a[i])}, `
        + `${el} ${this.val(f.b[i])}, i64 ${f.aux[i]}`);
      return;
    }
    if (op === OP.VEXT) {
      // `t` 是元素类型（结果类型）；被取的向量类型看操作数
      this.line(`  ${dst} = extractelement ${this.typed(f.a[i])}, i64 ${f.aux[i]}`);
      return;
    }
    if (op === OP.DIV && !isF) {
      this.needDiv = true;
      const vt = this.ty(t, 'div');
      let acc = 'poison';
      let k = 0;
      while (k < lanes) {
        const la = this.fresh();
        const lb = this.fresh();
        const q = this.fresh();
        const ins = k + 1 === lanes ? dst : this.fresh();
        this.line(`  ${la} = extractelement ${vt} ${this.val(f.a[i])}, i64 ${k}`);
        this.line(`  ${lb} = extractelement ${vt} ${this.val(f.b[i])}, i64 ${k}`);
        this.line(`  ${q} = call i64 @omni_ll_div(i64 ${la}, i64 ${lb})`);
        this.line(`  ${ins} = insertelement ${vt} ${acc}, i64 ${q}, i64 ${k}`);
        acc = ins;
        k++;
      }
      return;
    }
    if (BIN_LL.has(op)) {
      const kind = BIN_LL.get(op);
      const ll = isF ? kind[1] : kind[0];
      if (ll !== null) {
        this.line(`  ${dst} = ${ll} ${this.ty(t, OP_NAMES[op])} ${this.val(f.a[i])}, ${this.val(f.b[i])}`);
        return;
      }
    }
    if (op === OP.NEG) {
      const vt = this.ty(t, 'neg');
      if (isF) this.line(`  ${dst} = fneg ${vt} ${this.val(f.a[i])}`);
      else this.line(`  ${dst} = sub ${vt} zeroinitializer, ${this.val(f.a[i])}`);
      return;
    }
    throw new OmniError(`${NOPE} 向量上的 ${OP_NAMES[op]}（函数 ${f.name}）`);
  }
}

/**
 * 二元指令表：`[i64 用哪条, f64 用哪条]`。null = 这个类型上没有对应指令（要么报错，
 * 要么在 dataInsn 里单独处理，比如 i64 的 `/` `%` 要走辅助函数）。
 * 键是数字（opcode），所以是 Map 而不是普通对象 —— 封闭 ABI 里普通对象是 dict<string,dynamic>。
 */
const BIN_LL = new Map([
  [OP.ADD, ['add', 'fadd']],
  [OP.SUB, ['sub', 'fsub']],
  [OP.MUL, ['mul', 'fmul']],
  [OP.DIV, [null, 'fdiv']],
  [OP.MOD, [null, 'frem']],
  [OP.BAND, ['and', null]],
  [OP.BOR, ['or', null]],
  [OP.BXOR, ['xor', null]],
]);

/** 这个模块用到的运行时 op（按名字去重后排序，`declare` 的顺序才是确定的）。 */
function usedRtOps(mir) {
  const seen = new Set();
  for (const f of mir.funcs) {
    let i = 0;
    while (i < f.count()) {
      if (f.op[i] === OP.CALLOP) {
        const nm = mir.ops[f.a[i]].name;
        if (RT_OPS.has(nm)) seen.add(nm);
      }
      i++;
    }
  }
  const out = [];
  for (const x of seen) out.push(x);
  out.sort();
  return out;
}

/**
 * f64 字面量。LLVM 的解析是正确舍入的，所以 17 位有效数字能精确往返
 * （与 C 后端的 cReal 同一条理由）。inf/nan 只能走十六进制形式。
 */
function llFloat(text) {
  const v = Number(text);
  if (Number.isNaN(v)) return '0x7FF8000000000000';
  if (v === Infinity) return '0x7FF0000000000000';
  if (v === -Infinity) return '0xFFF0000000000000';
  // 负零：`toPrecision` 把符号丢了（JS 里 `(-0).toPrecision(17)` 是 `"0.0000…"`）。
  // 它看得见（`(sfix … (int 2))` 印 `-0.00`），所以走位模式那一路，与 inf/nan 同。
  if (v === 0 && 1 / v < 0) return '0x8000000000000000';
  const s = v.toPrecision(17);
  return s.includes('.') || s.includes('e') || s.includes('E') ? s : `${s}.0`;
}

/**
 * f32 字面量（ADR-0017 第一刀）。**一律走 64 位十六进制形式**：LLVM 只在字面量对该类型
 * 精确时才接受十进制，而 `0.1f` 的十进制拼法是 `0.10000000149011612` 这种 —— 靠
 * `toPrecision(17)` 撞对它是运气。十六进制是双精度的位模式，float 那边只要值本身是
 * float 能精确表示的（我们的 f32 常量都 fround 过，所以恒成立）就合法。
 */
function llFloat32(text) {
  const v = Math.fround(Number(text));
  if (Number.isNaN(v)) return '0x7FF8000000000000';
  if (v === Infinity) return '0x7FF0000000000000';
  if (v === -Infinity) return '0xFFF0000000000000';
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, v, false);
  let hex = '';
  let i = 0;
  while (i < 8) {
    const b = buf.getUint8(i);
    hex += (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
    i++;
  }
  return `0x${hex}`;
}

/* `/` 与 `%` 的语义（omni.h:332..343）：除零报错，INT64_MIN / -1 不走硬件除法。
 * 发成 IR 里的私有函数而不是在每个调用点展开 —— 调用点少一半行，LLVM 会自己内联。 */
const DIV_HELPER = `define private i64 @omni_ll_div(i64 %a, i64 %b) {
entry:
  %z = icmp eq i64 %b, 0
  br i1 %z, label %err, label %chk
err:
  call void @omni_error(ptr @.omni_divzero)
  unreachable
chk:
  %m1 = icmp eq i64 %b, -1
  %mn = icmp eq i64 %a, -9223372036854775808
  %ov = and i1 %m1, %mn
  br i1 %ov, label %sat, label %ok
sat:
  ret i64 -9223372036854775808
ok:
  %r = sdiv i64 %a, %b
  ret i64 %r
}
`;

const MOD_HELPER = `define private i64 @omni_ll_mod(i64 %a, i64 %b) {
entry:
  %z = icmp eq i64 %b, 0
  br i1 %z, label %err, label %chk
err:
  call void @omni_error(ptr @.omni_divzero)
  unreachable
chk:
  %m1 = icmp eq i64 %b, -1
  %mn = icmp eq i64 %a, -9223372036854775808
  %ov = and i1 %m1, %mn
  br i1 %ov, label %sat, label %ok
sat:
  ret i64 0
ok:
  %r = srem i64 %a, %b
  ret i64 %r
}
`;

/* 无符号那两个（ADR-0016 第六十一刀）。除零那句话与有符号那两个共用同一条字符串常量，
 * 所以五条腿上是同一句；INT64_MIN/-1 那道特判这儿**没有** —— 无符号除法不会溢出。 */
const UDIV_HELPER = `define private i64 @omni_ll_udiv(i64 %a, i64 %b) {
entry:
  %z = icmp eq i64 %b, 0
  br i1 %z, label %err, label %ok
err:
  call void @omni_error(ptr @.omni_divzero)
  unreachable
ok:
  %r = udiv i64 %a, %b
  ret i64 %r
}
`;

const UMOD_HELPER = `define private i64 @omni_ll_umod(i64 %a, i64 %b) {
entry:
  %z = icmp eq i64 %b, 0
  br i1 %z, label %err, label %ok
err:
  call void @omni_error(ptr @.omni_divzero)
  unreachable
ok:
  %r = urem i64 %a, %b
  ret i64 %r
}
`;

/* 函数值调用前的判空（omni.h:467..470 的 omni_fn_ck，又一条 static inline）。
 * 消息与 C 那条腿逐字相同 —— 空函数值在两条腿上必须是同一句话，不是一边报错一边段错误。 */
const FNCK_HELPER = `define private ptr @omni_ll_fnck(ptr %f) {
entry:
  %z = icmp eq ptr %f, null
  br i1 %z, label %err, label %ok
err:
  call void @omni_error(ptr @.omni_nullfn)
  unreachable
ok:
  ret ptr %f
}
`;

/* 字符串比较（omni.h:353..358 的 omni_str_cmp，也是 static inline 所以 call 不到）：
 * 前 min(len) 字节走 memcmp，相同则短者在前。memcmp 是真符号。
 * `%lt` 在 entry 里算好，bylen 里再用 —— entry 支配全图，合法。 */
const STRCMP_HELPER = `define private i32 @omni_ll_strcmp([2 x i64] %a, [2 x i64] %b) {
entry:
  %ai = extractvalue [2 x i64] %a, 0
  %an = extractvalue [2 x i64] %a, 1
  %bi = extractvalue [2 x i64] %b, 0
  %bn = extractvalue [2 x i64] %b, 1
  %ap = inttoptr i64 %ai to ptr
  %bp = inttoptr i64 %bi to ptr
  %lt = icmp slt i64 %an, %bn
  %n = select i1 %lt, i64 %an, i64 %bn
  %pos = icmp sgt i64 %n, 0
  br i1 %pos, label %cmp, label %tail
cmp:
  %c = call i32 @memcmp(ptr %ap, ptr %bp, i64 %n)
  %nz = icmp ne i32 %c, 0
  br i1 %nz, label %diff, label %tail
diff:
  ret i32 %c
tail:
  %eq = icmp eq i64 %an, %bn
  br i1 %eq, label %same, label %bylen
same:
  ret i32 0
bylen:
  %s = select i1 %lt, i32 -1, i32 1
  ret i32 %s
}
`;

/** 一个 C 字符串常量（只用于 ASCII 的格式串）。长度算出来，不手数 —— 数错就 IR 不合法。 */
function llCStr(name, text) {
  return `${name} = private unnamed_addr constant [${text.length + 1} x i8] c"${text}\\00"`;
}

/* arena 的 bump 快路径（omni.h:98..103 的 omni_alloc，又一条 static inline，call 不到）。
 * 慢路径 omni_alloc_slow 与两个 arena 指针都是真符号 —— 所以这里重建的是那六行，
 * 不是另换一个分配器：换一个的话缓冲的地址来自别的池，同一个程序里两套内存管理。 */
const ALLOC_HELPER = `define private ptr @omni_ll_alloc(i64 %n) {
entry:
  %cur = load ptr, ptr @omni_arena_ptr
  %ci = ptrtoint ptr %cur to i64
  %a1 = add i64 %ci, 15
  %al = and i64 %a1, -16
  %end = load ptr, ptr @omni_arena_end
  %ei = ptrtoint ptr %end to i64
  %over = icmp ugt i64 %al, %ei
  br i1 %over, label %slow, label %chk
chk:
  %room = sub i64 %ei, %al
  %big = icmp ugt i64 %n, %room
  br i1 %big, label %slow, label %fast
fast:
  %np = add i64 %al, %n
  %p = inttoptr i64 %al to ptr
  %newp = inttoptr i64 %np to ptr
  store ptr %newp, ptr @omni_arena_ptr
  ret ptr %p
slow:
  %r = call ptr @omni_alloc_slow(i64 %n)
  ret ptr %r
}
`;

/**
 * 一种元素类型的缓冲三条：new / get / set。发成私有函数而不是在调用点展开 ——
 * 越界检查带分支，而调用点在结构化控制流里，展开会把 this.live/regions 那套记账搅乱。
 *
 * 越界与负长度的消息走 `omni_errorf`（真符号，变参）：格式串与实参和 C 那条腿**逐字相同**
 * （backend-c 的 bufLines / omni_container.h:50），所以两条腿的 stderr 是同一串字节。
 */
function bufHelpers(elem, sizeOf, zero) {
  const s = elem === 'double' ? 'f64' : 'i64';
  return `define private { i64, ptr } @omni_ll_bnew_${s}(i64 %n) {
entry:
  %neg = icmp slt i64 %n, 0
  br i1 %neg, label %err, label %chk
err:
  call void (ptr, ...) @omni_errorf(ptr @.omni_bneg, i64 %n)
  unreachable
chk:
  %z = icmp eq i64 %n, 0
  br i1 %z, label %empty, label %alloc
empty:
  %e0 = insertvalue { i64, ptr } undef, i64 0, 0
  %e1 = insertvalue { i64, ptr } %e0, ptr null, 1
  ret { i64, ptr } %e1
alloc:
  %bytes = mul i64 %n, ${sizeOf}
  %p = call ptr @omni_ll_alloc(i64 %bytes)
  br label %loop
loop:
  %i = phi i64 [ 0, %alloc ], [ %i1, %body ]
  %done = icmp sge i64 %i, %n
  br i1 %done, label %fin, label %body
body:
  %sl = getelementptr ${elem}, ptr %p, i64 %i
  store ${elem} ${zero}, ptr %sl
  %i1 = add i64 %i, 1
  br label %loop
fin:
  %b0 = insertvalue { i64, ptr } undef, i64 %n, 0
  %b1 = insertvalue { i64, ptr } %b0, ptr %p, 1
  ret { i64, ptr } %b1
}

define private ${elem} @omni_ll_bget_${s}({ i64, ptr } %b, i64 %i) {
entry:
  %n = extractvalue { i64, ptr } %b, 0
  %p = extractvalue { i64, ptr } %b, 1
  %lo = icmp slt i64 %i, 0
  %hi = icmp sge i64 %i, %n
  %oob = or i1 %lo, %hi
  br i1 %oob, label %err, label %ok
err:
  call void (ptr, ...) @omni_errorf(ptr @.omni_boob, i64 %i, i64 %n)
  unreachable
ok:
  %sl = getelementptr ${elem}, ptr %p, i64 %i
  %v = load ${elem}, ptr %sl
  ret ${elem} %v
}

define private ${elem} @omni_ll_bset_${s}({ i64, ptr } %b, i64 %i, ${elem} %v) {
entry:
  %n = extractvalue { i64, ptr } %b, 0
  %p = extractvalue { i64, ptr } %b, 1
  %lo = icmp slt i64 %i, 0
  %hi = icmp sge i64 %i, %n
  %oob = or i1 %lo, %hi
  br i1 %oob, label %err, label %ok
err:
  call void (ptr, ...) @omni_errorf(ptr @.omni_boob, i64 %i, i64 %n)
  unreachable
ok:
  %sl = getelementptr ${elem}, ptr %p, i64 %i
  store ${elem} %v, ptr %sl
  ret ${elem} %v
}
`;
}

/** MIR 模块 -> LLVM IR 文本。 */
export function emitLlvm(mir) {
  return new LlvmEmitter(mir).emit();
}


