// Omni stage0 — C 的降级器（tinycc `tccgen.c` 的等价物，ADR-0017 第六刀）
//
// 出处纪律同第五刀：**照行为与结构重写，不抄代码**，每条规则旁边注 `tccgen.c:行`。
//
// ## 一遍过，没有 AST
//
// `tccgen.c` 与 `tccpp.c` 是**同一遍**：语法分析器一边从 `next()` 取记号，一边直接发
// 目标码，中间不存在一棵树。这一份照这个结构来：`Cpp` 是记号源，`CGen` 一边解析一边
// `f.emit(...)` 往 MIR 里发指令。这是路径 B（`tcc_target.md`：「重点提供和 tinycc
// 完全相同的解析路径」）；路径 A 的 GLR 文法是第七步的事，两条路要能互相对账。
//
// ## 三处刻意的偏离
//
// 1. **没有 `vtop` 值栈。** tcc 的 `SValue` 栈存在的理由是**延迟寄存器分配**：一个值
//    可能还在常量里、还在内存里、还是一个待求值的比较，`gv(rc)` 才把它塞进寄存器。
//    MIR 没有寄存器 —— 一条指令的 ref **就是**那个值，SSA 形式本身就是「延迟」。
//    所以解析函数**返回值**（一个 `SVal` 记录），不往全局栈上压。保留的只有真正带
//    语义的那两格：`VT_LVAL`（左值，`gv` 时才发 LOAD）与 `VT_CMP`（比较结果不急着
//    变成 0/1，`tccgen.c:1028` 的 `vset_VT_CMP`）—— 它们不是寄存器分配的产物。
//
// 2. **控制流是结构化的，不是跳转加回填。** tcc 用 `gjmp()` 发一条待回填的跳转、
//    `gsym()` 回填（`tccgen.c:167`）。MIR 只有 wasm 那套区域标记（BLOCK/LOOP/IF/END
//    加往外数的层数），指令**不能重排、不能回填**。于是：
//      - `if` / `while` / `do` 的形状照 `mir/from_oir.js` 已经钉好的那几套；
//      - `for` 的步进式在源码里写在循环体前、要在循环体后执行，只能**先把记号收起来、
//        循环体之后再放一遍**（`Cpp.captureTokens`）。这是 MIR 换来的代价，明写在这儿；
//        自带后端那条路上它会退回成一条跳转；
//      - `switch` 是「层层嵌套的 block，一个标签关掉一层」（`switchStmt`）；
//      - `goto` 是「函数那一层一圈 LOOP + 一个状态槽 + 一条分派链」（`gotoStmt` 头上
//        那一段）—— 结构化控制流里**往回跳只有这一种写法**，而「跳进去」靠每层语句
//        各出一小段（跳过头、进对的那一半）。代价是往前跳与往回跳一样贵。
//
// 3. **不折常量。** tcc 的 `gen_opic` 在解析时就把 `1+2*3` 算成 7。这里不折：MIR 的
//    消费者本来就会折，而折叠是**语义可见**的（`1/0` 折了成编译期错误、不折是运行期
//    错误）。先记在这儿不做。**唯一的例外**是数组维度那种「C 要求必须是常量」的位置 ——
//    那里有一个独立的小求值器（`constExpr`），它只认常量，见不到变量。
//
// 4. **函数体解析两遍。** `&x` 要求 `x` 落在线性内存上，而「谁被取过地址」在一遍过里
//    没法提前知道。tcc 不需要知道（它把所有局部量都上栈，帧大小最后**回填**进序言），
//    MIR 不能回填。所以函数体的记号先整块收下来，放一遍收集信息（输出丢掉）、再放一遍
//    才是真的。理由与代价写在 `finishFunc` 头上。
//
// ## 窄整数在寄存器里是什么样（这一片最要紧的一条不变量）
//
// `char` / `short` / `_Bool` 在 MIR 里都是 `T_I32`，而且**永远处在规范形**：
// 有符号的那些符号扩展过、无符号的那些落在 0..2^n-1 里。tcc 与 wasm 都是这么做的
// （`tcc.h` 里根本没有 8/16 位的寄存器类）。这条不变量买到两件事：
//   - **整型提升不发任何转换指令** —— `char` 提到 `int` 只是换一个 CType，位一个都不动；
//   - 宽度只在两处看得见：访问内存（`MLOAD`/`MSTORE` 的描述符）与显式转换（`CVT_SEXT8/16`）。
// 反过来，任何产生窄类型值的地方都**必须**收口回规范形，否则「提升不发指令」这条
// 就成了错的。收口只在 `castTo` 一处，别处不许自己截。
//
// 「宽度只在访问那一刻有意义」还有一条推论：提升一个**左值**必须先按原类型取值，
// 换完类型码再取就会按 `int` 的宽度读内存。这一格错过一次，见 `promote`。
//
// ## 位域信息只能挂在左值上（第二条不变量）
//
// 位域的「第几位、几位宽」和 tcc 一样挤在 CType 的位里（`mkBitfield`），于是它跟着
// 类型走，不必给 SValue 加一格。代价是一条纪律：**一旦取过值，类型上就不能再带着它**
// —— 否则下一次 `gv` 会以为自己还得去内存里读一遍，而手上已经没有地址了。所以
// `promote` / `castTo` / `incdec` 三处都要先过 `bfValTypeOf`。这一格错过一次，
// printf 的实参上当场炸（报「位域左值不在内存上」）。
//
// ## 内存的版图
//
// 页 0（0..64K）整页留空 —— C 的 `NULL` 于是**一定**访问不到。data 段从 64K 往上长
// （字符串字面量与全局量）；影子栈接在它后面，`$sp`（一个 i64 全局）从栈顶往下长。
// 全局量的地址是编译期常量，所以它们不用影子栈；**没有初始化式的全局量不写一个字节
// data** —— 线性内存出生时全是 0，而 C 正好规定静态存储期零初始化。
// 指针就是**线性内存里的字节偏移**（`T_I64`），不是 ADR-0016 的 `T_PTR`/`T_TPTR` ——
// 那两个带范围检查、一块一块地分配，而 C 要的是一整片可寻址的字节。
// 堆（第十五片）在影子栈之上的下一个页边界起，往上长、不够就 `MGROW`；分配器在
// `interp/libc.js` 里，**簿记全在线性内存上**，而堆的起点由入口函数用一条
// `__omni_heap_init` 交给它 —— 宿主那边不猜版图，没用到堆的模块也不发那条。
// `errno`（第八刀第八片）是同一个形状的第二例：data 段末尾 4 个字节，
// 地址由 `__omni_errno_init` 交过去，用到 `<errno.h>` 才留、才发。
//
// ## 调用约定里聚合类型那一格（第十一片）
//
// MIR 的实参与返回值都是**标量**，而 C 能按值传一整个 struct。前端这一层的约定：
//   - **传值传地址**，拷贝由**被调方**在入口处做（`runBody`）。一次调用于是只有一次拷贝，
//     而且那一次正是 C 要求的那一次（形参是实参的一份可改的拷贝，C11 6.9.1 第 10 段）。
//   - **返回走隐藏的第一个形参**：调用方在自己帧上划一块、把地址传进去，被调方拷进去
//     再把这个地址返回（SysV 用 rax 回同一个东西）。于是 RET 照旧只带一个 i64。
// 真的 ABI（arm64 ≤16 字节走两个寄存器之类）是后端那几步的事；这一层只需要地址。
// 这个约定**只在自家人之间成立** —— 外部符号那一侧的 struct 传值还没到（`externThunk`）。
//
// ## 函数指针的值是什么（第十三片）
//
// **函数表下标 + 1**，不是线性内存里的偏移（编码定在 `ir.js` 的 `CALLI` 上，0 留给
// 空指针）。这与 wasm 一致：那边的函数也不在线性内存里，`call_indirect` 拿的是表下标。
// 于是 `(void *)fp` 这种「把函数指针当数据指针用」的写法在这条路上没有意义 ——
// C 本来也没定义它。
//
// 前端这一侧只有一条纪律：**函数指示符是一个函数类型的内存左值**，它的「地址」就是
// 那个函数指针值。于是 `f`、`&f`、`*f`、`f(x)`、`fp(x)`、`(*fp)(x)` 六种写法共用
// `gv` / `decay` / `addrOf` / `postfix` 里各一行，一个特例都不用写。
// 直接调用照旧发 `CALL`（下标是编译期常量），只有真的经过指针才发 `CALLI`。
//
// ## 这一片做到哪儿（**是路标，不是终点**）
//
// 终点是「能编译 tinycc 自己的全部源码」，所以 printf、struct、变参、`setjmp`
// 一个都躲不过去 —— 下面这些不是「刻意不做」，是**还没做到那一片**。分片顺序与理由写在
// ADR-0017 第六刀的落地节里，一句话：按解锁能力排，不按语法书的章节排。
//
// 已经做到：`void`、`_Bool`、`char`/`short`/`int`/`long`/`long long` 及其 `unsigned`
// 版本、整型提升与常规算术转换、强制转换、`sizeof`、函数（互相递归随便）、局部变量、
// C 的全部优先级、`if/else`、`while`、`do`、`for`、`break`、`continue`、`return`、
// 指针（`&`/`*`/算术/比较）、数组（含多维）、下标、影子栈、字符串字面量、常量表达式、
// 全局量（data 段，常量初始化式）、`typedef`、`extern` 与「用过但没定义」的诊断、
// 外部符号（`unit()` 末尾的转发桩）与变参调用（printf/sprintf 那一族已经跑通）、
// **struct/union/enum、`.` 与 `->`、整块的 struct 赋值、不完整类型的指针、位域、
// 聚合初始化器（含指定初始化器（**串起来的也行**）、不定长数组（**元素是聚合、里层花括号
// 省掉了也数得对**）、省掉里层花括号的嵌套写法）、`switch`
// （含贯穿、`BRTABLE`/比较链两条路）、
// `goto` 与语句标签（**跳到哪儿都行**：跳进兄弟块、跳进循环体、标签长在 `if` 里；
// 函数那一层一台状态机 + 一条分派链）、struct 的**传值与返回**（传地址 +
// 隐藏的返回指针）、带括号的声明符（`int (*a)[3]`、`int (*f(int))[3]`）、**函数指针**
// （调用、回调、函数指针表、当静态初始化式）、**浮点**（`float`/`double`、与整型互转、
// 静态初始化式、printf 的 `%f/%e/%g`）、**堆**（`malloc`/`calloc`/`realloc`/`free`/
// `strdup`，簿记全在线性内存上）、**变参函数的定义**（`va_list`/`va_start`/`va_arg`/
// `va_end`/`va_copy`，签名定死成「固定形参 + 一个变参区指针」，**通过函数指针调也行**）、
// **`exit`**（宿主抛一个信号，从任意深处一路退出去）、**函数类型的 typedef**
// （`typedef int cb(int);`，之后能当声明符的基本类型用）、**`long double`**（在这个目标上
// 就是 double，见 `tcc.h:237-241`）、**常量表达式里的浮点**（整型与浮点合成一份求值器：
// `int n = 1.9;` 是 1、`(int)2.9` 也认）、printf 的 `%a`、**变参里的 struct**（写侧摊进
// 变参区、`va_arg` 回一个左值）、**`goto` 跳到哪儿都行**（一台函数级状态机 +
// 一条分派链换掉「每个块一台」，**语句标签长在 `switch` 里也行** —— case 的段界与
// 标签的段界摆在同一串嵌套 `BLOCK` 上），**`case` 标签长在里层的控制结构里也行**
// （真的 Duff's device：那种 case 在状态机眼里就是一个没有名字的标签，分派那边发一小段
// 蹦床「写状态、回函数那圈 LOOP」，第八刀第十五片）**。
// 还没到：**外部**函数上的 struct 传值/返回（要真的 ABI）。
//
// 碰到还没做到的东西**当场报错**，报错文本里带「第六刀」字样 —— 一眼能看出是进度不是
// bug，而且下一片把它做掉时 `gen-bad/` 里那条用例会跟着红，于是「边界移动了」这件事
// 不会悄悄发生（第四刀前半那一节讲过这条纪律）。
//
// oracle 原先只是 `tcc -run` 的**进程退出码**（`main` 的返回值，8 位）；printf 通了之后
// 升级成「退出码 **加 stdout 逐字节相同**」—— 一次比较从 1 字节变成几百字节，同一份用例
// 能钉住的东西多了两个数量级。有一格**不能**跟 tcc 对：`%p`（地址空间不同）。浮点原先
// 也在这一格里，第十四片之后它进了对账范围 —— `%f/%e/%g` 逐字节相同，只有「正好落在两个
// 十进制数正中间」的舍入还有分歧（libc.js 的 `fText` 记着这件事，用例避开那些值）。


import { OmniError } from '../source/diag.js';
import { Cpp } from './tccpp.js';
import { COMPILE_PREAMBLE } from './tccdefs.js';
import {
  TOK_EOF, TOK_IDENT, TOK_UIDENT,
  TOK_CCHAR, TOK_LCHAR, TOK_CINT, TOK_CUINT, TOK_CLLONG, TOK_CULLONG,
  TOK_CLONG, TOK_CULONG, TOK_STR, TOK_LSTR, TOK_CFLOAT, TOK_CDOUBLE, TOK_CLDOUBLE,
  TOK_INC, TOK_DEC, TOK_SHL, TOK_SAR, TOK_LAND, TOK_LOR,
  TOK_EQ, TOK_NE, TOK_LT, TOK_GE, TOK_LE, TOK_GT, TOK_ULE, TOK_UGT,
  TOK_IF, TOK_ELSE, TOK_WHILE, TOK_FOR, TOK_DO, TOK_BREAK, TOK_CONTINUE, TOK_RETURN,
  TOK_SWITCH, TOK_CASE, TOK_DEFAULT, TOK_GOTO, TOK_SIZEOF, TOK_DOTS, TOK_STATIC_ASSERT,
  TOK_INT, TOK_VOID, TOK_BOOL, TOK_SIGNED, TOK_UNSIGNED, TOK_CHAR, TOK_SHORT, TOK_LONG,
  TOK_FLOAT, TOK_DOUBLE, TOK_STRUCT, TOK_UNION, TOK_ENUM, TOK_TYPEDEF,
  TOK_EXTERN, TOK_STATIC, TOK_CONST, TOK_REGISTER, TOK_AUTO, TOK_VOLATILE, TOK_INLINE,
  TOK_CONST1, TOK_CONST2, TOK_VOLATILE1, TOK_VOLATILE2, TOK_SIGNED1, TOK_SIGNED2,
  TOK_INLINE1, TOK_INLINE2, TOK_RESTRICT, TOK_RESTRICT1, TOK_RESTRICT2,
  TOK_EXTENSION, TOK_ATOMIC, TOK_THREAD_LOCAL, TOK_THREAD,
  TOK_ATTRIBUTE1, TOK_ATTRIBUTE2, TOK_ASM1, TOK_ASM2, TOK_ASM3,
  TOK_ALIGNED1, TOK_ALIGNED2, TOK_PACKED1, TOK_PACKED2, TOK_WEAK1, TOK_WEAK2,
  TOK_ALIAS1, TOK_ALIAS2,
  TOK_ALIGNOF1, TOK_ALIGNOF2, TOK_ALIGNOF3,
  TOK_TYPEOF1, TOK_TYPEOF2, TOK_TYPEOF3, TOK_LABEL,
  TOK_BUILTIN_VA_START, TOK_BUILTIN_VA_ARG, TOK_BUILTIN_VA_END, TOK_BUILTIN_VA_COPY,
  TOK_BUILTIN_EXPECT, TOK_BUILTIN_TYPES_COMPATIBLE_P,
  TOK___FUNCTION__, TOK___FUNC__, TOK_LINENUM,
  isAssignOp, assignOpOf,
} from './tcctok.js';
import {
  VT_VOID, VT_BYTE, VT_SHORT, VT_INT, VT_LLONG, VT_BOOL, VT_PTR, VT_FUNC, VT_STRUCT,
  VT_BTYPE, VT_UNSIGNED, VT_DEFSIGN, VT_LONG, VT_FLOAT, VT_DOUBLE,
  VT_EXTERN, VT_STATIC, VT_TYPEDEF, VT_INLINE, VT_CONSTANT, VT_VOLATILE, VT_STORAGE, VT_ENUM,
  btype, isInteger, isFloat, isUnsigned, isPtr, isArray, isFunc, isStruct, isUnion, isEnum,
  isBitfield, bitPosOf, bitSizeOf, mkBitfield, bitfieldBase, bfAccess,
  ctype, mkPointer, mkArray, mkStruct, mkEnum, enumBase, mkFunc, typeSize, typeText, sameType,
  sameTypeUnqual, mkVla, isVla, compareTypes,
  TY_VOID, TY_INT, TY_UINT, TY_LLONG, TY_ULLONG, TY_CHAR, TY_UCHAR, TY_SHORT, TY_BOOL,
  TY_FLOAT, TY_DOUBLE, TY_LDOUBLE, VT_LDOUBLE, sseEightbytes,
} from './ctype.js';
import {
  MirModule, MirFunc, OP, T_VOID, T_I32, T_I64, T_BOOL, T_F32, T_F64, REF_NONE,
  CVT_SEXT, CVT_ZEXT, CVT_TRUNC, CVT_SEXT8, CVT_SEXT16, CVT_I2F, CVT_U2F, CVT_F2I, CVT_F2U,
  CVT_FCVT, memDesc, MEM_PAGE, fnPtr, isConstRef, memArgAux,
} from '../mir/ir.js';

/* 线性内存的访问描述符号（`MLOAD_KINDS` / `MSTORE_KINDS` 的下标，ir.js:383）。
 * 写成常量是为了 `loadKindOf` 读起来像一张表 —— 下标写字面量的话改一次表就全错。 */
const MK_I8S = 0;
const MK_I8U = 1;
const MK_I16S = 2;
const MK_I16U = 3;
const MK_I32S = 4;
const MK_I64 = 6;
const MK_F32 = 7;
const MK_F64 = 8;
const SK_I8 = 0;
const SK_I16 = 1;
const SK_I32 = 2;
const SK_I64 = 3;
const SK_F32 = 4;
const SK_F64 = 5;

/* 逐字节拷贝（struct 赋值）用的宽度表。读一律用**无符号/满宽**的那格：搬字节的时候
 * 符号扩展是有害的 —— 8 位那格若用 `i8s`，0x80 会被扩成 0xffffff80，存回去时低 8 位
 * 仍然对，但中间那条指令的值不再是「一个字节」。用 `i8u` 让每一步都只是搬运。 */
const COPY_MK = { 1: MK_I8U, 2: MK_I16U, 4: MK_I32S, 8: MK_I64 };
const COPY_SK = { 1: SK_I8, 2: SK_I16, 4: SK_I32, 8: SK_I64 };

/**
 * 从内存里读一个这种类型的值，用哪个宽度符号。
 *
 * **满宽的读没有无符号变体**：`unsigned int` 也走 `i32s`。理由在 ir.js:376 与
 * verify.js:161 —— T_I32 的规范形是符号扩展过的，而无符号性挂在算子上
 * （ADR-0016 第六十一刀）。写成 `i32u` 会被 verifier 当场骂。
 */
function loadKindOf(ty) {
  const b = btype(ty.t);
  if (b === VT_BOOL) return MK_I8U;
  if (b === VT_BYTE) return isUnsigned(ty.t) ? MK_I8U : MK_I8S;
  if (b === VT_SHORT) return isUnsigned(ty.t) ? MK_I16U : MK_I16S;
  if (b === VT_INT) return MK_I32S;
  if (b === VT_FLOAT) return MK_F32;
  if (b === VT_DOUBLE || b === VT_LDOUBLE) return MK_F64;
  return MK_I64;   // long / long long / 指针
}

/** 往内存里写：只是「把低若干位拍进去」，没有符号可言（load 有 `_s`/`_u`，store 没有）。 */
function storeKindOf(ty) {
  const b = btype(ty.t);
  if (b === VT_BOOL || b === VT_BYTE) return SK_I8;
  if (b === VT_SHORT) return SK_I16;
  if (b === VT_INT) return SK_I32;
  if (b === VT_FLOAT) return SK_F32;
  if (b === VT_DOUBLE || b === VT_LDOUBLE) return SK_F64;
  return SK_I64;
}

/** 向上对齐。`a` 是 2 的幂，但这里不假设 —— 一句除法比一句位运算好读。 */
function alignUp(n, a) {
  const r = n % a;
  return r === 0 ? n : n + (a - r);
}

/** 影子栈的对齐：一律 8（arm64 的 ABI 要 16，但我们只在内存里放标量与小聚合）。 */
const FRAME_ALIGN = 8;

/**
 * 用到这几个名字之一，就说明这个单元要一个堆（第六刀第十五片）。
 * 分配器本身在 `interp/libc.js` 里，簿记全在线性内存上；前端在这儿要做的只有两件事：
 * 版图上给堆留出位置、在入口处把堆的起点交过去。
 */
const HEAP_FNS = new Set(['malloc', 'calloc', 'realloc', 'free', 'strdup', 'getenv']);

/**
 * 用到这两个名字之一，就说明这个单元要一格 `errno`（第八刀第八片）。
 * `<errno.h>` 里 `errno` 是宏，展开成一次调用再解引用 —— 因为 C 要求 `errno` 是一个
 * **可改的左值**，而函数回不出左值、只能回一个指针。名字随系统走：macOS SDK 那份是
 * `(*__error())`，glibc 那份是 `(*__errno_location())`。
 * 那一格**必须由前端在版图上留**：宿主临时去堆上要一格的话，一个没用到 `malloc`
 * 的程序连堆都没有（第八十九片踩过）。
 * 前端要做的与堆那条一样两件事：data 段里留 4 个字节、在入口处把地址交过去。
 */
const ERRNO_FNS = new Set(['__error', '__errno_location']);

/**
 * `strerror` 要一块地方（第八刀第十三片）：它回一个 `char *`，而那些串必须落在线性
 * 内存里。macOS 上量出来的是「一号一格、互不干扰，只有表外的号共用一格」，所以这块
 * 地方是 **109 格 × 48 字节**（108 个号 + 表外那一格；最长的那句 46 个字符 + 结尾的 0
 * 是 47，48 让每格 8 对齐）。宿主一侧的 `STRERR_SLOT` 与这个数对得上，对不上会当场骂。
 * 前端要做的与 errno 那一格一样两件事：data 段里留出来、在入口处把地址与大小交过去。
 */
const STRERROR_FN = 'strerror';
const STRERROR_BYTES = 109 * 48;

/**
 * **宿主提供的全局量**（第八刀第十七片）。SDK 的 `<stdio.h>` 里三条标准流是
 *
 * ```c
 * extern FILE *__stdinp, *__stdoutp, *__stderrp;
 * #define stdout __stdoutp
 * ```
 *
 * 也就是说它们不是函数调用，而是三个**外部全局量**。所以这一片要的是「一个 extern 的
 * 全局量由宿主填」：data 段里那一格照旧由前端留（`declareGlobal` 已经留了，
 * `FILE *` 是 8 个字节），入口处一条 `__omni_stream_init(地址, 第几条)` 让宿主把自己
 * 那个句柄写进去 —— 与 `errno` 那一格同一个形状，方向相反（那一格是宿主写别人读，
 * 这一格是宿主写自己读）。
 *
 * 值是几由**宿主**说（`interp/libc.js` 的 `F_STDIN`/`F_STDOUT`/`F_STDERR`），
 * 前端只交地址与序号 —— 前端不该知道句柄长什么样。
 */
const STREAM_GVARS = new Map([['__stdinp', 0], ['__stdoutp', 1], ['__stderrp', 2]]);

/**
 * 影子栈的大小。1 MiB —— 与 tcc 在本机上的默认线程栈同一个量级，而递归深度超出它时
 * 得到的是「内存越界」（memChk 会喊），不是静悄悄踩别的东西。写死是因为这一片没有
 * `-Wl,-z,stacksize` 那类开关；将来要调就是一个命令行参数。
 */
const C_STACK_BYTES = 1024 * 1024;


/* 单字符记号的码位。写成常量是为了读得出来 —— `this.tok === 40` 谁也认不出是 `(`。 */
const LPAR = 40;
const RPAR = 41;
const LBRACK = 91;
const RBRACK = 93;
const LBRACE = 123;
const RBRACE = 125;
const SEMI = 59;
const COMMA = 44;
const COLON = 58;
const QUEST = 63;
const DOT = 46;
const STAR = 42;
const PLUS = 43;
const MINUS = 45;
const TILDE = 126;
const BANG = 33;
const ASSIGN = 61;
const AMP = 38;
const PIPE = 124;
const CARET = 94;
const PERCENT = 37;
const SLASH = 47;
const TOK_ARROW = 0xa0;

/** 带值的记号（`TOK_HAS_VALUE`，`tcc.h:1189`）：`TOK_CCHAR <= t <= TOK_LINENUM`。 */
function tokHasValue(t) {
  return t >= TOK_CCHAR && t <= TOK_CLDOUBLE;
}

/**
 * C 类型 -> MIR 类型码。**这条映射只有这一处**（ctype.js 头也说了这件事）：
 * 窄整数在寄存器里就是 i32，指针是线性内存里的字节偏移（i64）。
 */
function mirTypeOf(ty) {
  const b = btype(ty.t);
  if (b === VT_VOID) return T_VOID;
  if (b === VT_BYTE || b === VT_SHORT || b === VT_INT || b === VT_BOOL) return T_I32;
  if (b === VT_LLONG || b === VT_PTR || b === VT_FUNC) return T_I64;
  if (b === VT_FLOAT) return T_F32;
  if (b === VT_DOUBLE || b === VT_LDOUBLE) return T_F64;
  /* `long double` 在这个目标上**就是 double**（`tcc.h:237-241`：MACHO + ARM64 与 PE
   * 都开 `TCC_USING_DOUBLE_FOR_LDOUBLE`）。x86_64 那边它是 80 位/16 字节，
   * 到那条后端上再说 —— 那时它需要一个真的 f80，而 MIR 现在没有。 */
  /* struct/union/数组在 MIR 里**只以地址的形态出现**（第十一片的 ABI：传值传地址、
   * 返回走隐藏的返回指针）。所以它们的 MIR 类型就是指针的类型。 */
  return T_I64;
}

/** 一个整型在 C 里的位宽。指针按 64 位（LP64）。 */
function intBitsOf(ty) {
  const b = btype(ty.t);
  if (b === VT_BOOL) return 1;
  if (b === VT_BYTE) return 8;
  if (b === VT_SHORT) return 16;
  if (b === VT_INT) return 32;
  return 64;   // long / long long / 指针
}

/**
 * 浮点类型的**等级**（C11 6.3.1.8 里 "greater rank" 的那个序）。只用来比大小，
 * 数值本身没有意义 —— 所以 `long double` 是 2 而不是 80 或 128：它在这一片
 * 还没到（`parseBtype` 那儿报边界），但序里留着它的位置，将来加进来时
 * `usualArith` 一个字都不用改。
 */
function floatRankOf(ty) {
  const b = btype(ty.t);
  if (b === VT_FLOAT) return 0;
  if (b === VT_DOUBLE) return 1;
  return 2;   // VT_LDOUBLE
}

/** 一个 double / float 的 IEEE 754 位模式（小端，与线性内存同一个字节序）。 */
function floatBits(x, size) {
  const buf = new DataView(new ArrayBuffer(8));
  if (size === 4) {
    buf.setFloat32(0, x, true);
    return BigInt(buf.getUint32(0, true));
  }
  buf.setFloat64(0, x, true);
  return buf.getBigUint64(0, true);
}

/**
 * 一个 C 值。四种形态，对应 tcc 的 `SValue` 里真正带语义的那几格：
 *   - 普通值：`ref` 是产出它的那条 MIR 指令（或常量池的 ref）
 *   - 槽左值（`VT_LVAL` + 寄存器）：`slot` 是 MIR 槽号。取值发 LOAD，赋值发 STORE。
 *     **不预先 LOAD** 是有用的：`a = 5` 于是不多出一条没人读的 LOAD。
 *   - 内存左值（`VT_LVAL` + `VT_LOCAL`）：`mem = {addr, off}`，地址是线性内存里的字节
 *     偏移。取值发 MLOAD、赋值发 MSTORE，静态偏移进访问描述符（于是 `p->f` 不多一条加法）。
 *   - 比较（`VT_CMP`，`tccgen.c:1028`）：`ref` 是一个 `T_BOOL`，`cmp` 为真。
 *     当条件用（`if`/`while`/`&&`）就直接用；当整数用才摊成 0/1，见 `gv`。
 */
function sVal(ty, ref) { return { ty, ref, slot: null, mem: null, cmp: false, name: null }; }
function sLval(ty, slot, name) {
  return { ty, ref: null, slot, mem: null, cmp: false, name: name === undefined ? null : name };
}
function sMem(ty, addr, off) {
  return { ty, ref: null, slot: null, mem: { addr, off }, cmp: false, name: null };
}
function sCmp(ref) { return { ty: TY_INT, ref, slot: null, mem: null, cmp: true, name: null }; }

/** 是不是左值（能赋值、能取地址）。 */
function isLval(v) { return v.slot !== null || v.mem !== null; }

/** 退化之后的类型（**不发指令**，只回类型）。`T[N]` -> `T*`，别的原样。 */
/* 数组与函数在表达式里都**退化成指针**（C11 6.3.2.1 第 3、4 段）：数组退成「指向元素」，
 * 函数退成「指向这个函数」。两条并排放在这儿，于是「问类型」与「真的取值」（`decay`）
 * 用的是同一套规则。 */
function decayedType(ty) {
  if (isArray(ty.t)) return mkPointer(ty.ref);
  if (isFunc(ty.t)) return mkPointer(ty);
  return ty;
}

/** 一条函数登记（`funcs` 里那个 info）-> 它的 C 函数类型。 */
function funcTypeOf(info) {
  return mkFunc(info.ret, info.params === null ? [] : info.params, info.variadic);
}

/**
 * 位域**取过值之后**是什么类型 —— 也就是 `gvBitfield` 那两条移位所用的容器类型：
 * 宽度跟着**访问类型**（`long long` 的按 64 位，别的按 32 位），符号性跟着**声明的**
 * 类型（`_Bool` 按无符号）。
 *
 * 两处来源不同不是笔误，`tccgen.c:1859-1868` 就是这么分的：符号性在 `adjust_bf`
 * **之前**从声明的类型上取，宽度在 `adjust_bf` **之后**读 `vtop->type.t` —— 那时
 * 基类型已经被换成访问类型了。换过访问类型的位域，它的位置是相对新容器算的
 * （比如 `b:20` 排在第 20 位、访问类型换成 8 字节），按声明的 32 位去移就错。
 *
 * 这个函数存在的另一个理由是一条不变量：**位域信息只能挂在左值上**。一旦取过值，
 * 类型上再带着「第几位、几位宽」就会骗人 —— 下一次 `gv` 会以为它还得去内存里读一遍，
 * 而它手上已经没有地址了。所以凡是「把左值变成值」的地方（`promote`、`castTo`、
 * `incdec`）都要在这儿过一道。这一格错过一次，printf 的实参上当场炸。
 */
function bfValTypeOf(ty) {
  if (!isBitfield(ty.t)) return ty;
  const base = bitfieldBase(ty);
  const w64 = btype(bfAccess(ty).t) === VT_LLONG;
  const uns = isUnsigned(base.t) || btype(base.t) === VT_BOOL;
  return w64 ? (uns ? TY_ULLONG : TY_LLONG) : (uns ? TY_UINT : TY_INT);
}

/**
 * 默认实参提升之后的类型（**不发指令**）。只问类型的地方用它，别叫 `promote`。
 *
 * 整型提升那一半（`_Bool`/`char`/`short` -> `int`）之外还有一条：`float` -> `double`
 * （C11 6.5.2.2 第 6 段）。少这一条，`printf("%f", 1.5f)` 会往变参里放 4 个字节，
 * 而 `%f` 那边按 8 个字节读 —— 印出来是一个随便的数，而且只在 `float` 上错。
 */
function promotedType(ty0) {
  const ty = bfValTypeOf(ty0);
  const b = btype(ty.t);
  if (b === VT_BOOL || b === VT_BYTE || b === VT_SHORT) return TY_INT;
  if (b === VT_FLOAT) return TY_DOUBLE;
  return ty;
}

/**
 * 去掉存储类（`static int x;` 的类型是 `int`；tcc 用 `VT_STORAGE` 掩码做同一件事，
 * `tcc.h:1093`）。`count` 要手工带着走 —— 它挂在 CType 对象上而不在 `t` 里，
 * 少这一句 `typedef int V[4]; static V a;` 就退化成指针。
 */
function stripStorage(ty) {
  const r = ctype(ty.t & ~VT_STORAGE, ty.ref);
  if (ty.count !== undefined) r.count = ty.count;
  return r;
}


/**
 * 二元运算符的记号 -> MIR 的 op。`uns` 挑无符号那一套（ADR-0016 第六十一刀把无符号性
 * 放在**算子**上，不放在类型码上 —— 补码下加减乘与位运算两种解释的位一模一样，
 * 所以只有除、模、右移、四个比较需要分岔）。
 */
function binOpOf(t, uns) {
  if (t === PLUS) return OP.ADD;
  if (t === MINUS) return OP.SUB;
  if (t === STAR) return OP.MUL;
  if (t === SLASH) return uns ? OP.UDIV : OP.DIV;
  if (t === PERCENT) return uns ? OP.UMOD : OP.MOD;
  if (t === AMP) return OP.BAND;
  if (t === PIPE) return OP.BOR;
  if (t === CARET) return OP.BXOR;
  if (t === TOK_SHL) return OP.SHL;
  // C 的 `>>`：有符号是算术右移、无符号是逻辑右移。这一格分岔靠的是**左操作数**的
  // 符号性（右操作数不参与常规算术转换），见 genOp。
  if (t === TOK_SAR) return uns ? OP.USHR : OP.SHR;
  return null;
}

function cmpOpOf(t, uns) {
  if (t === TOK_EQ) return OP.EQ;    // 相等比较两种解释的位相同，不分岔
  if (t === TOK_NE) return OP.NE;
  if (t === TOK_LT) return uns ? OP.ULT : OP.LT;
  if (t === TOK_GE) return uns ? OP.UGE : OP.GE;
  if (t === TOK_LE) return uns ? OP.ULE : OP.LE;
  if (t === TOK_GT) return uns ? OP.UGT : OP.GT;
  return null;
}

/**
 * 优先级表（`tccgen.c:6506-6524` 的 `precedence`）。数字**照抄** —— 它们是
 * `expr_infix` 的唯一输入，改一个数就是改一门语言的结合性。
 * tcc 那边把关系运算符写成两段（`TOK_ULT/TOK_UGE` 与 `TOK_ULE..TOK_GT` 的区间），
 * 这里照原样判：那两段之间有编号空隙，写成一条 `>=` 会把空隙里的东西也当成关系运算符。
 */
function precedence(t) {
  if (t === TOK_LOR) return 1;
  if (t === TOK_LAND) return 2;
  if (t === PIPE) return 3;
  if (t === CARET) return 4;
  if (t === AMP) return 5;
  if (t === TOK_EQ || t === TOK_NE) return 6;
  if (t >= TOK_ULE && t <= TOK_GT) return 7;  // 关系：ULE/UGT 与 LT/GE/LE/GT 同一段
  if (t === TOK_SHL || t === TOK_SAR) return 8;
  if (t === PLUS || t === MINUS) return 9;
  if (t === STAR || t === SLASH || t === PERCENT) return 10;
  return 0;
}

/**
 * 常量表达式里的二元运算（`constExpr` 用）。全在 JS 的 bigint 上算 ——
 * 常量表达式的中间结果按 C 的规矩是 `intmax_t`，bigint 更宽，而维度最后要收成 Number，
 * 所以宽一点不会让谁看出差别。除以零在这儿是**编译期错误**，见 constExpr 的注释。
 */
function ceApply(t, a, b, err) {
  if (t === PLUS) return a + b;
  if (t === MINUS) return a - b;
  if (t === STAR) return a * b;
  if (t === SLASH || t === PERCENT) {
    /* 除以零在这儿是编译期错误 —— 但**短路掉的那一半**里不是（`2 || 1 / 0` 是合法的，
     * 见 `ceInfix` 的 dead 那一格）。那时 `err` 不抛，于是这儿得有个回得出去的值。 */
    if (b === 0n) {
      err('division by zero in constant expression');
      return 0n;
    }
    return t === SLASH ? a / b : a % b;
  }
  if (t === AMP) return a & b;
  if (t === PIPE) return a | b;
  if (t === CARET) return a ^ b;
  if (t === TOK_SHL) return a << b;
  if (t === TOK_SAR) return a >> b;
  if (t === TOK_LAND) return (a !== 0n && b !== 0n) ? 1n : 0n;
  if (t === TOK_LOR) return (a !== 0n || b !== 0n) ? 1n : 0n;
  if (t === TOK_EQ) return a === b ? 1n : 0n;
  if (t === TOK_NE) return a !== b ? 1n : 0n;
  if (t === TOK_LT) return a < b ? 1n : 0n;
  if (t === TOK_GE) return a >= b ? 1n : 0n;
  if (t === TOK_LE) return a <= b ? 1n : 0n;
  if (t === TOK_GT) return a > b ? 1n : 0n;
  err('invalid operator in constant expression');
  return 0n;
}

/**
 * 常量表达式的算子，**有一边是浮点**那一支（`ceApply` 是两边都是整数那一支）。
 * 分岔的理由就是 C 的常规算术转换：`%` 与位运算/移位在浮点上不存在（`genOp` 那儿是
 * 同一条规则），而比较与逻辑运算的**结果是 int**，所以那几格回的是 BigInt。
 */
function cefApply(t, x, y, err) {
  if (t === PLUS) return x + y;
  if (t === MINUS) return x - y;
  if (t === STAR) return x * y;
  if (t === SLASH) return x / y;
  if (t === TOK_LAND) return (x !== 0 && y !== 0) ? 1n : 0n;
  if (t === TOK_LOR) return (x !== 0 || y !== 0) ? 1n : 0n;
  if (t === TOK_EQ) return x === y ? 1n : 0n;
  if (t === TOK_NE) return x !== y ? 1n : 0n;
  if (t === TOK_LT) return x < y ? 1n : 0n;
  if (t === TOK_GE) return x >= y ? 1n : 0n;
  if (t === TOK_LE) return x <= y ? 1n : 0n;
  if (t === TOK_GT) return x > y ? 1n : 0n;
  err('invalid operands to binary operator (floating point)');
  return 0;
}

/**
 * 两条同名全局声明的类型能不能合成一条（C11 6.9.2 的**试探性定义**，第三十九片）。
 * 回合成后的类型，合不了回 null。
 *
 * 规则就一条：数组的长度**谁写了算谁的**（`static int t[]; static int t[10];`）。
 * 别的差异一律是 `conflicting types` —— 我们不做完整的「类型兼容」那一套
 * （C11 6.2.7：形参表里 `int f()` 与 `int f(int)` 也算兼容），撞上了再说。
 *
 * 数组那一格必须**先**判：`sameType` 比数组长度时**有一边没写就算相容**
 * （`compareTypes`，照 tcc 的 `compare_types` —— C 里 `int[]` 与 `int[10]` 确实相容）。
 * 所以先问 `sameType(a, b)` 会让 `int t[]; int t[10];` 直接回第一条的
 * 「没长度」类型，长度就永远补不上了。
 */
function mergeTentative(a, b) {
  if (isArray(a.t) && isArray(b.t) && sameType(a, b)) {
    if (a.count === b.count || b.count < 0) return a;
    if (a.count < 0) return b;
    return null; /* 两条都写了长度，而且不一样 */
  }
  if (sameType(a, b)) return a;
  return null;
}

export class CGen {  /**
   * @param {Cpp} cpp 记号源（已经 startParse 过）
   * @param {MirModule} mod 往里发指令的模块
   */
  constructor(cpp, mod, opts) {
    this.cpp = cpp;
    this.mod = mod;
    /* native 这条腿（第九刀第十九片）：**没有线性内存**，局部量的地址是 `FRAME` 回来的
     * 真地址。除此之外整个前端一字不改 —— 帧的布局、`&x` 是 `fp + 偏移`、聚合体怎么摆，
     * 两条腿共用同一段代码，差的只有「`fp` 从哪来」这一处。 */
    this.native = opts === undefined ? false : opts.native === true;
    /** 当前记号（tcc 的全局 `tok` / `tokc`）。镜像一份是为了代码读起来像 tccgen。 */
    this.tok = TOK_EOF;
    this.tokc = null;

    /** @type {MirFunc|null} 正在生成的函数 */
    this.f = null;
    /** 当前函数的返回类型（tcc 的 `func_vt`） */
    this.funcRet = TY_VOID;
    this.funcName = '';
    /** @type {object[]} 收着的 `inline` 函数体（tcc 的 `inline_fns`），读完单元才发 */
    this.inlineFns = [];
    /** `sizeof (` 那一次「这个括号里可能是类型名」的标记（tcc 的 `TOK_SOTYPE`） */
    this.soType = false;
    /** @type {Map<string,{slot:number,ty:object}>[]} 作用域栈（tcc 的 `local_stack`） */
    this.scopes = [];
    /** @type {string[]} 区域标签栈：BR 的层数按它算，与 from_oir 同一套记账 */
    this.regions = [];
    /** @type {Map<string,{no:number,f:MirFunc,defined:boolean,params:object[]|null,ret:object}>} */
    this.funcs = new Map();

    /* ---- 影子栈与线性内存（第六刀第三片）。
     * 一个 i64 全局 `$sp` 往下长；只有**被取过地址的**局部量与聚合落在它上面，其余照旧
     * 在槽里。`fp` 是当前帧的基址（`$sp` 减掉帧大小之后的值），一个 ref 用到底 ——
     * MIR 是 SSA，函数顶层发的那条指令在整个函数体里都可用。 */
    this.spNo = -1;
    /** 帧基址的 ref（没有帧就是 REF_NONE） */
    this.fpRef = REF_NONE;
    /** 进函数时的 `$sp`，每条 RET 前写回去 */
    this.spSave = REF_NONE;
    /** 返回 struct 时那个隐藏的返回指针（第十一片的 ABI，见 `runBody`） */
    this.sretRef = REF_NONE;
    /** 变参函数里那个隐藏的**变参区指针**（第十六片的 ABI，见 `runBody` 与 `vaBlock`） */
    this.vaRef = REF_NONE;
    this.frameSize = 0;
    /** 帧内的下一个空位。**不回收** —— 见 finishFunc 头上「平铺的帧」那一节 */
    this.frameOff = 0;
    /** 第一遍（收集期）吗 */
    this.pass1 = false;
    /** @type {Set<string>} 第一遍收到的「被取过地址的名字」 */
    this.addrTaken = new Set();
    /** @type {{name:string,size:number,align:number}[]} 第一遍见到的标量声明 */
    this.declScalars = [];
    /** @type {Set<string>} 第二遍要落在内存上的名字（= 第一遍的 addrTaken） */
    this.frameNames = new Set();
    /** 现在这一处声明符里，`[…]` 里可以是**运行期**的长度吗（变长数组，第四十九片）。
     * 0 = 不行（文件作用域、形参表、以及一切不是声明的地方）；
     * 2 = 行（函数体里、没有存储类的那一种）；
     * 1 = 只有**穿过一层指针**才行 —— `static int (*p)[h]` 合法而 `static int a[h]` 不合法，
     *     因为存储类说的是「那个对象」，而 `[h]` 说的是它**指向**的东西。tcc 的那一句
     *     `post_type(post, ad, post != ret ? 0 : storage, …)`（`tccgen.c:5313`）就是这条规矩：
     *     声明符里有指针链的话，存储类在后缀这一步被丢掉。 */
    this.vlaMode = 0;
    /** @type {{sp:number,regionLen:number}[]} 每层作用域一格：这一层里第一个变长数组
     * 之前的 `$sp` 存在哪个槽上（-1 = 这一层没有变长数组），以及它开在第几层 MIR 区域里
     * （`break`/`continue` 跳出去时要知道自己越过了哪些层，见 `vlaLeave`）。 */
    this.vlaStack = [];
    /** 这个函数里有变长数组吗 —— 有的话序言/收场那一对必须发（不然 `$sp` 收不回来） */
    this.vlaSeen = false;
    /** @type {object|null} 当前**函数体**那个 MirFunc。`sizeof` 会把 `this.f` 换成一个
     * 用完就丢的函数（操作数不求值），可是变长数组的长度**必须真的算**
     * （`sizeof(char[1+2*a])`，tcctext.c:3162）—— 那几条指令要落在这儿。 */
    this.bodyF = null;
    /** data 段的下一个空位。页 0 整页留空，于是 C 的 `NULL` 一定访问不到 */
    this.dataOff = MEM_PAGE;
    /** @type {Map<string,number>} 字符串字面量去重（同一份文本一份 data） */
    this.strs = new Map();
    /** @type {Map<string,number>} 宽字符串字面量去重（键是那串 wchar 的值） */
    this.wstrs = new Map();
    /** @type {{off:number,bytes:number[]}[]} 攒着的 data 段（内存要等 dataOff 定了才能声明） */
    this.pendingData = [];
    /**
     * native：初值里的**地址**（第九刀第二十八片）。`off` 是那块暂存区上的绝对偏移，
     * 八个字节宽；`kind`/`no` 是它指着的符号（`g` 全局 / `f` 函数 / `s` 串常量）。
     * 加数照旧写进 `pendingData` 的那八个字节里 —— 目标文件里 `POINTER64` 就是
     * 「原地那几个字节 + 符号的地址」，所以这两半合起来正好。
     * @type {{off:number,kind:string,no:number,add:bigint}[]}
     */
    this.pendingFix = [];
    /**
     * native：文件作用域上那些**没有名字**的静态块（静态的复合字面量，第三十三片之后
     * 的第三十四片）。前端照旧在暂存区里给它们划地方，这张表让最后那一步把每一块
     * 切成一个匿名的全局符号，并且让「值恰好是块里某个地址」的初值落成重定位。
     * @type {{name:string,gno:number,addr:number,size:number,align:number}[]}
     */
    this.anonStatics = [];
    /** @type {Map<number,{off:number,bytes:number[]}>} 静态位域按地址找那一条记录（见 `emitBitfield`） */
    this.statBits = new Map();
    /** 这个单元用到堆了吗（`malloc` 那一族）。用到才发那条 `__omni_heap_init` */
    this.heapUsed = false;
    /** 这个单元用到 `errno` 了吗。用到才在 data 段留一格、才发 `__omni_errno_init` */
    this.errnoUsed = false;
    this.strerrorUsed = false;
    /** @type {{addr:number,which:number}[]} 宿主提供的全局量（三条标准流，见 STREAM_GVARS） */
    this.streamGvars = [];
    /** @type {Map<string,object>} `typedef` 的名字表（tcc 用 `VT_TYPEDEF` 挂在符号上） */
    this.typedefs = new Map();
    /* `__builtin_va_list`：tcc 在 arm64 上把它定在 tccdefs.h 里（本机是
     * `struct { void *__stack; }`），而不是一个记号。我们照它的位置办 —— 一条预置的
     * typedef —— 但形态取 `void *`：程序只把它当不透明的东西传给那几个内建，
     * 而我们的变参区就是一串 8 字节的格子，一个指针足够走完它（见 `vaBlock`）。 */
    this.typedefs.set('__builtin_va_list', mkPointer(TY_VOID));
    /* typedef 名是**普通标识符**（C11 6.2.3），所以它跟变量一样分作用域、而且能被
     * 同名的变量遮住（`mytype1 mytype2; mytype2 = 2;` —— tcctest.c:655 那两行）。
     * 于是这张表也是一叠：一层一个 Map，值是 `null` 表示「这一层有个普通标识符
     * 占了这个名字」。tcc 那边不需要这一叠，因为它的 typedef 与变量本来就在同一张
     * 符号表里（`VT_TYPEDEF` 只是那条符号上的一个位）。 */
    this.tdefStack = [this.typedefs];
    /** 常量表达式里「被短路掉的那一半」有多深（`ceInfix` 的 dead）。非 0 时算子上的
     *  错（除以零）不报 —— 那一段按 C 根本不求值。 */
    this.ceDead = 0;
    /** 最后一次引用到的符号自己写的 `aligned(N)`（0 = 没写）。只有 `alignofExpr` 读它。 */
    this.symAlign = 0;
    /** 正在解析的语句表达式（`({ … })`，第三十七片之后那一片）。栈是因为它能嵌套。 */
    this.seStack = [];
    /** 语句表达式里那台局部状态机在位时，外面那台的标签表（用来把「跳出去」报清楚）。 */
    this.seOuterIds = null;
    /** @type {Map<number,Map<string,number>>} 语句序号 -> 那个语句表达式的局部标签表。 */
    this.seLabels = new Map();
    /** @type {Map<string,{ty:object,addr:number,defined:boolean,used:boolean}>} 全局量 */
    this.gvars = new Map();
    /* C 有**四个独立的名字空间**（C11 6.2.3）：普通标识符、struct/union/enum 的 tag、
     * 成员名、语句标签。所以 `struct S { int S; } S;` 三个 S 互不相干。tag 这一个
     * 必须与 typedefs/gvars 分开存 —— 合到一起的话上面那行会互相覆盖。 */
    /** @type {Map<string,object>} `struct S` / `union U` / `enum E` 的 tag（文件作用域） */
    this.tags = new Map();
    /* tag 也是**分作用域**的（C11 6.2.1 第 7 段：tag 的作用域就是那个块），而且
     * 这一条对我们尤其硬：函数体要走两遍（`genFuncBody`），块里定义的 `struct S {…}`
     * 第二遍会再看见一次 —— 不分作用域的话第二遍必然报「redefinition」。
     * 最外一层就是 `this.tags` 自己，进块推一层、出块弹掉，与 `this.scopes` 同步。 */
    /** @type {Map<string,object>[]} tag 的作用域栈，`[0]` 是文件作用域 */
    this.tagStack = [this.tags];
    /** @type {Map<string,{ty:object,val:bigint}>} 枚举常量（它们是**普通标识符**） */
    this.enumConsts = new Map();
    /* 枚举常量也分作用域 —— 它们是普通标识符，块里的 `enum {E_IN = 5}` 出了块就没了，
     * 而且与 tag 同理：函数体走两遍，第二遍会再登记一次。 */
    /** @type {Map<string,{ty:object,val:bigint}>[]} 枚举常量的作用域栈 */
    this.ecStack = [this.enumConsts];
    /** @type {{left:number}[]} 正在解析的 switch（嵌套时是一叠），见 `switchStmt` */
    this.swStack = [];

    /* ---- 语句标签与 goto（第六刀第十片 + 第二十四片）。见 `gotoStmt` 头上那一段。
     * 语句在两遍里的**序号**是同一个（两遍走同一串记号），于是第一遍量出来的
     * 「这条语句里面有哪些标签」第二遍能按序号取回 —— `goto` 的前向引用就有了答案，
     * 而不必再收一遍记号。 */
    /** 当前函数里第几条语句（两遍各自从 0 数起） */
    this.stmtNo = 0;
    /** @type {{lo:number,hi:number,kids:object[],thenHi:number}[]} 语句序号 -> 它的标签区间 */
    this.stmtRanges = [];
    /** @type {object[]} 第一遍：当前语句的**带标签的直接子语句**（`block` 的包装在收） */
    this.kids = [];
    /** @type {Map<string,number>} 标签名 -> 编号（1 起，按定义的源码顺序） */
    this.labelIds = new Map();
    /** 这个函数里的标签个数（= 最大编号） */
    this.labelCount = 0;
    /** 第二遍：状态槽的槽号；-1 = 这个函数里没有标签，整台状态机都不摆 */
    this.gotoSlot = -1;
    /** @type {?{slot:number,ty:object,labels:object[]}} switch 交给函数体那台分派的选择子 */
    this.pendingSwitch = null;
    /** 语句的嵌套深度（`block()` 的层数）。`case` 靠它判断自己是不是直接子语句 */
    this.blockDepth = 0;
  }

  /* ------------------------------------------------------------ 记号与报错 */

  /** `next()`：把 Cpp 的当前记号搬到自己身上。 */
  next() {
    this.cpp.next();
    this.tok = this.cpp.tok;
    this.tokc = this.cpp.tokc;
  }

  err(msg) {
    this.cpp.err(msg);
  }

  /** 还没做到的东西。前缀统一，于是 `gen-bad/` 那一组一眼能与真错误分开。 */
  todo(what) {
    this.cpp.err(`第六刀：${what}`);
  }

  /** `expect`（`tccgen.c` 里到处在用）：报「期望某个东西」。 */
  expect(what) {
    this.err(`${what} expected`);
  }

  /** `skip(c)`（`tccpp.c:100`）：当前记号必须是 `c`，然后往前走一格。 */
  skip(t) {
    if (this.tok !== t) {
      this.err(`'${this.cpp.tokStr(t, this.tokc)}' expected (got '${this.cpp.tokStr(this.tok, this.tokc)}')`);
    }
    this.next();
  }

  /** 当前记号是标识符的话，取它的名字。 */
  identName() {
    if (this.tok < TOK_UIDENT) this.expect('identifier');
    const name = this.cpp.tokStr(this.tok, null);
    this.next();
    return name;
  }

  /* -------------------------------------------------------------- 符号与槽 */

  /**
   * 函数符号。**一遍过意味着可以先调用后定义**（C 本来就允许），所以第一次见到一个
   * 名字（不管是声明、定义还是调用）就给它建一个 MirFunc 占位，定义时再把形参、
   * 返回类型和函数体填进去。tcc 那边是 `external_global_sym`（`tccgen.c:1143`）
   * 建一个待重定位的符号，链接时补上 —— 同一件事，我们的「链接」是 `funcIndex`。
   */
  funcSym(name) {
    const hit = this.funcs.get(name);
    if (hit !== undefined) return hit;
    const f = new MirFunc(name, [], T_I32);
    const no = this.mod.addFunc(f);
    const info = {
      no, f, params: null, ret: TY_INT,
      defined: false,     // 这个单元里有函数体
      declared: false,    // 这个单元里见过原型或定义（没见过就是隐式声明）
      variadic: false,    // 形参表里有 `...`
      /* 这个单元里**引用过**（调用、取地址、当常量用）。只有引用过的外部符号才发桩：
       * 系统头文件一份 `<stdlib.h>` 就声明上百个函数，一个不落地发桩的话，`div` 那种
       * 返回 struct 的会当场撞上「外部函数返回 struct 还没到」——而那份程序根本没用它。
       * 真的编译器也是这样：没引用的声明不产生任何符号引用。 */
      used: false,
    };
    this.funcs.set(name, info);
    return info;
  }

  /**
   * 这个类型**必须**落在线性内存上吗。
   * 数组与 struct/union 没有「装在一个寄存器里」的形态：`a[i]` 与 `s.f` 都要能算地址。
   * 标量则相反 —— 只有被 `&` 取过地址才不得不落到内存，那一问由第一遍回答。
   */
  needsMem(ty) {
    return isArray(ty.t) || isStruct(ty.t);
  }

  /**
   * 「拿一个不完整类型当对象」要报错（C11 6.7 第 7 段）。`struct S *p;` 合法，
   * `struct S s;` 不合法 —— 差别只在这一问，而问的时机是**声明的那一刻**：
   * 一遍过时后面才出现的 `struct S {…}` 补不上这一格，tcc 也是当场报。
   */
  needComplete(name, ty) {
    let t = ty;
    while (isArray(t.t)) t = t.ref;
    if (isStruct(t.t) && t.ref.fields === null) {
      this.err(`'${name}' has incomplete type '${typeText(t)}'`);
    }
  }

  /**
   * 在当前帧里划一块，回帧内偏移。**不回收**（见 finishFunc 头上「平铺的帧」）。
   * `align` 非 0 就用它 —— `__attribute__((aligned(N)))` 写在变量上的那一格。
   */
  frameAlloc(ty, align = 0, extra = 0) {
    const s = typeSize(ty);
    this.frameOff = alignUp(this.frameOff, align !== 0 ? align : s.align);
    const off = this.frameOff;
    const total = s.size + extra;
    this.frameOff += total === 0 ? 1 : total;
    return off;
  }

  /**
   * 声明一个局部变量。登记进最内层作用域（同名遮蔽是 C 的规矩），回那条登记。
   * 两种落法二选一：帧上的偏移（`off >= 0`）或者 MIR 的槽（`slot >= 0`）。
   */
  declareLocal(name, ty, align = 0, extra = 0) {
    if (btype(ty.t) === VT_VOID) this.err(`variable '${name}' has void type`);
    this.needComplete(name, ty);
    /* 这个名字要是外面某层的 typedef，从这儿起它是个变量（C11 6.2.1 第 4 段）——
     * `mytype1 mytype2; mytype2 = 2;` 的第二行于是是表达式而不是声明。 */
    this.tdefShadow(name);
    const scope = this.scopes[this.scopes.length - 1];
    /* 变长数组：帧上划不出来（长度是运行期的数），所以这个名字本身是一个**指针槽**，
     * 那块地方在运行期从 `$sp` 上切（tcc 用 `alloca`，同一件事）。于是它是唯一一种
     * 「既在内存上、又不占帧」的局部量 —— `entryLval` 那儿多一格就是为了它。 */
    if (isVla(ty)) {
      const e = { ty, slot: this.f.slot(name, T_I64), off: -1, vla: true };
      scope.set(name, e);
      this.vlaAlloc(e);
      return e;
    }
    if (this.needsMem(ty) || this.frameNames.has(name) || align !== 0) {
      const e = { ty, slot: -1, off: this.frameAlloc(ty, align, extra), align };
      scope.set(name, e);
      return e;
    }
    /* 第一遍：把标量声明记下来，等这一遍读完、知道谁被取过地址了，再算帧大小的上界。 */
    if (this.pass1) {
      const s = typeSize(ty);
      this.declScalars.push({ name, size: s.size, align: s.align });
    }
    const e = { ty, slot: this.f.slot(name, mirTypeOf(ty)), off: -1 };
    scope.set(name, e);
    return e;
  }

  /**
   * 块里带 `static` 的变量（第五十七片，tcc 的 `decl_initializer_alloc` 里
   * `r & VT_SYM` 那一路）：**存储期是整个程序**，所以东西在 data 段上，与全局量走同一路；
   * 名字只在这一层可见，所以登记还是压在当前作用域里，指向那条全局登记。
   *
   * data 段里的名字要**加料**：两个函数里各有一个 `static int n;` 是两个不同的对象。
   * 料是「函数名 + 这个函数里的第几条 static」—— 序号在两遍里数出来一样（函数体解析
   * 两遍，偏离 4），于是第二遍找到的是第一遍划的那块地方，不会划两次。
   */
  declareStaticLocal(name, ty, align, extra = 0) {
    if (btype(ty.t) === VT_VOID) this.err(`variable '${name}' has void type`);
    this.tdefShadow(name);
    const key = `${this.funcName}.${name}.${this.staticNo++}`;
    let g = this.gvars.get(key);
    if (g === undefined) g = this.declareGlobal(key, ty, false, align, extra);
    else g.ty = ty;
    /* 块里的 `static` 也是内部链接（第九十二片）—— 名字里带了函数名，可两个翻译单元
     * 里各有一个 `f.buf.0` 还是会撞，所以照 `static` 全局那样标成局部符号。 */
    g.isStatic = true;
    const e = { ty, slot: -1, off: -1, align, gvar: g };
    this.scopes[this.scopes.length - 1].set(name, e);
    return e;
  }

  /**
   * 块里的 `extern int x;`：说的是**文件作用域**那个对象（C11 6.2.2 第 4 段），
   * 所以查/建的是同一条全局登记，只是把名字也摆进这一层作用域里。
   */
  declareExternLocal(name, ty, hasInit, align) {
    this.tdefShadow(name);
    const g = this.declareGlobal(name, ty, !hasInit, align);
    const e = { ty, slot: -1, off: -1, align, gvar: g };
    this.scopes[this.scopes.length - 1].set(name, e);
    return e;
  }

  /** 一条作用域登记 -> 一个左值。 */
  entryLval(name, e) {
    /* `__alignof__(x)` 要的是**符号**那一份对齐（第三十五片）。tcc 的做法是回头去看
     * 刚压进去的那个 SValue 上挂的 Sym（`tccgen.c:5802` 那句注释就写着 hack），
     * 我们这儿记「最后一次引用到的符号带的对齐」—— 同一个意思，同样只在紧接着问的
     * 时候才有意义。 */
    this.symAlign = e.align || 0;
    /* 块里带 `static`（或 `extern`）的那一种：名字只在这一层可见，东西却住在 data 段
     * （第五十七片）。所以这条登记只是一个转手 —— 真的地址在那条全局登记上。 */
    if (e.gvar !== undefined) return this.gvarLval(e.gvar);
    /* 变长数组：槽里放的是**那块地方的地址**，所以要先读出来再当内存左值的基址。
     * 「读一次」发生在每一次引用上 —— 那个槽从声明之后就不再变，读几次都一样。 */
    if (e.vla === true) {
      return sMem(e.ty, this.f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, e.slot), 0);
    }
    if (e.off >= 0) return sMem(e.ty, this.fpRef, e.off);
    return sLval(e.ty, e.slot, name);
  }

  /** 变长数组的字节数：那个槽读出来。`-1` 是「形参上的，还没算」（见 `vlaParamCode`）。 */
  vlaSizeRef(ty) {
    if (ty.vla < 0) this.err('internal: 变长形参的长度还没算');
    return this.f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, ty.vla);
  }

  /**
   * 变长数组的那块地方：在运行期从 `$sp` 上切下来（tcc 的 `gen_vla_alloc`，也就是
   * `alloca`）。`$sp` 往下长，切完还要对回 16 —— 帧的对齐是 16（`genFuncBody` 里
   * `alignUp(est, 16)`），切一刀之后不对回去的话后面所有 8 字节访问都可能骑在边界上。
   *
   * 这一层还负责「这一层作用域退出时把 `$sp` 收回去」的**存**那一半：第一个变长数组
   * 之前的 `$sp` 存进一个槽，`popScope` 拿它写回（tcc 的 `cur_scope->vla.locorig`）。
   * 存在**第一个**变长数组之前而不是作用域开头：作用域开头还不知道里面有没有 VLA，
   * 而 MIR 不能回填（文件头偏离 4）。
   */
  vlaAlloc(e) {
    const f = this.f;
    /* native（第三十六片）：栈顶是**机器的** `sp`，动它要走 `SPGET`/`SPALLOC`。
     * 形状与下面线性内存那一路一模一样 —— 存一次旧栈顶、切一块、把基址写进槽。 */
    if (this.native) {
      const cur0 = this.vlaStack[this.vlaStack.length - 1];
      if (cur0 !== undefined && cur0.sp < 0) {
        cur0.sp = this.temp(T_I64, 'vlasp');
        f.emit(OP.STORE, T_VOID, f.emit(OP.SPGET, T_I64, REF_NONE, REF_NONE, 0),
          REF_NONE, cur0.sp);
      }
      f.emit(OP.STORE, T_VOID, this.nativeAlloca(this.vlaSizeRef(e.ty)), REF_NONE, e.slot);
      return;
    }
    const spNo = this.spGlobal();
    const cur = this.vlaStack[this.vlaStack.length - 1];
    if (cur !== undefined && cur.sp < 0) {
      cur.sp = this.temp(T_I64, 'vlasp');
      f.emit(OP.STORE, T_VOID, f.emit(OP.GLOAD, T_I64, REF_NONE, REF_NONE, spNo),
        REF_NONE, cur.sp);
    }
    const sp = f.emit(OP.GLOAD, T_I64, REF_NONE, REF_NONE, spNo);
    const sz = this.vlaSizeRef(e.ty);
    const base = f.emit(OP.BAND, T_I64, f.emit(OP.SUB, T_I64, sp, sz, 0),
      this.mod.consts.int(-16n), 0);
    f.emit(OP.GSTORE, T_VOID, base, REF_NONE, spNo);
    f.emit(OP.STORE, T_VOID, base, REF_NONE, e.slot);
  }

  /** 把一个存着的 `$sp` 写回去（tcc 的 `gen_vla_sp_restore`）。 */
  spRestore(slot) {
    const f = this.f;
    if (this.native) {
      f.emit(OP.SPSET, T_VOID, f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, slot), REF_NONE, 0);
      return;
    }
    f.emit(OP.GSTORE, T_VOID, f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, slot),
      REF_NONE, this.spGlobal());
  }

  /**
   * native：切一块栈下来，回它的基址（第三十六片）。
   *
   * 凑成 16 的倍数这一步放在**前端**：两条腿要的是同一个数，而 `SPALLOC` 的约定就是
   * 「实参已经是 16 的倍数」。让开出参区那一步反过来留给后端 —— 那笔账两条 ABI 不同，
   * 而且只有后端知道本函数最费的那次调用要几个字节。
   */
  nativeAlloca(nRef) {
    const f = this.f;
    const up = f.emit(OP.ADD, T_I64, nRef, this.mod.consts.int(15n), 0);
    const n16 = f.emit(OP.BAND, T_I64, up, this.mod.consts.int(-16n), 0);
    return f.emit(OP.SPALLOC, T_I64, n16, REF_NONE, 0);
  }

  /**
   * `break` / `continue` 跳出去时把 `$sp` 收回来（tcc 的 `vla_leave`，`tccgen.c:7065`）。
   * 作用域退出那一路是 `popScope` 发的一条 GSTORE，而 `BR` 会**跳过**它 —— 所以跳之前
   * 得自己发一条。少了这一格，`for(…){ int a[n]; continue; }` 每一圈都往下切一块，
   * `$sp` 一路掉到内存外面去。
   *
   * 收的是**被跳出去的那些层里最外面那一层**存的值：`$sp` 只往下走，所以恢复最外面
   * 那一格就把里面所有的都一起收回来了。
   */
  vlaLeave(lv) {
    const ti = this.regions.length - 1 - lv;
    for (const s of this.vlaStack) {
      if (s.sp >= 0 && s.regionLen > ti) { this.spRestore(s.sp); return; }
    }
  }

  /** `goto` 那一路：跳到哪儿说不清，所以收到函数里最外面那一格（tcc 也是 locorig）。 */
  vlaLeaveAll() {
    for (const s of this.vlaStack) {
      if (s.sp >= 0) { this.spRestore(s.sp); return; }
    }
  }

  /** 查一个名字（由内往外）。查不到回 null —— 调用方要区分「函数名」与「未声明」。 */
  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const hit = this.scopes[i].get(name);
      if (hit !== undefined) return hit;
    }
    return null;
  }

  /* ------------------------------------------------------------ 区域与层数 */

  open(op, label, a) {
    this.f.emit(op, T_VOID, a, REF_NONE, 0);
    this.regions.push(label);
  }

  close() {
    this.regions.pop();
    this.f.emit(OP.END, T_VOID, REF_NONE, REF_NONE, 0);
  }

  /** `IF` 的另一半：ELSE 不开新层，所以标签要先摘再放（与 from_oir 同一手法）。 */
  elseHalf() {
    this.regions.pop();
    this.f.emit(OP.ELSE, T_VOID, REF_NONE, REF_NONE, 0);
    this.regions.push('if');
  }

  /** 往外数第几层能找到这个标签（0 = 最内层）。找不到回 -1（`break` 在循环外）。 */
  levelOf(label) {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      if (this.regions[i] === label) return this.regions.length - 1 - i;
    }
    return -1;
  }

  /** 匿名临时槽（`&&`、`?:`、比较摊平都要落在槽上，见 ir.js 头第 1 条）。 */
  temp(t, why) {
    return this.f.slot(`$${why}${this.f.slots.length}`, t);
  }

  /**
   * i32 / i64 的常量。
   *
   * **一律收成 MIR 的规范形（有符号两补）** —— T_I32 / T_I64 的规范形是符号扩展过的
   * 值（`ir.js:75`），无符号性挂在**算子**上（ADR-0016 第六十一刀），不挂在位上。
   * 所以 `18446744073709551615ULL` 进常量池是 `-1`，`4294967295u` 是 i32 的 `-1`。
   *
   * 这一格错过一次：字面量按 `asUintN` 存进去，于是 `(long long)ull == -1` 在
   * 解释器里比的是 `18446744073709551615n` 与 `-1n`，判假。逐位比对当场抓住。
   */
  konst(ty, v) {
    const mt = mirTypeOf(ty);
    /* 浮点也从这儿走：`gtst` 与「掉出函数尾巴的隐式 return」都是 `konst(ty, 0)`，
     * 而 `double` 的那个 0 必须是 `f64 0`，不是 `i32 0` —— MIR 的算术两侧同类型，
     * 类型码错了会在 verifier 那儿炸，而不是在这儿。 */
    if (mt === T_F64 || mt === T_F32) return this.fkonst(ty, Number(v));
    const bv = BigInt(v);
    return mt === T_I64
      ? this.mod.consts.int(BigInt.asIntN(64, bv))
      : this.mod.consts.i32(BigInt.asIntN(32, bv));
  }

  /**
   * 一个 ref 背后的整数常量，不是整数常量就回 null。
   * 「这个值在编译期就知道」这件事在好几处要问（转换的常量折叠、`offsetof` 的展开式），
   * 而常量池是按 (类型码, 文本) 存的，所以问法只此一处。
   */
  kintOf(ref) {
    if (ref === REF_NONE || !isConstRef(ref)) return null;
    const k = this.mod.consts.get(ref);
    return k.kind === 'int' ? BigInt(k.text) : null;
  }

  /**
   * native：一个 ref 背后的**地址常量**（`符号 + 加数`），不是就回 null。
   *
   * C 的静态初始化式里指针的值只能是「某个对象或函数的地址，可加可减一个整型常量」
   * （C11 6.6 第 9 段）。线性内存那条腿上这整件事是一个数（地址就是编译期常量），
   * native 上它算不出来 —— 得留给链接器。于是这儿把刚才那个用完就丢的函数里
   * 攒下来的几条指令**反着读一遍**：`GADDR`/`FADDR`/串常量是根，`ADD`/`SUB` 一个
   * 整数常量往上摞。摞不出来（读了内存、乘了什么）就不是地址常量。
   *
   * 为什么不在表达式一路上顺手带个 `sym` 字段（tcc 的 `vtop->sym` 就是那样）：
   * 那要让每一处造 `SValue` 的地方都记得传它，而漏掉一处的后果是**静静地**丢掉
   * 符号、只剩加数 —— 一个指着 0 的指针。反着读只此一处，漏不掉。
   */
  symConstOf(f, ref) {
    if (ref === REF_NONE) return null;
    if (isConstRef(ref)) {
      return this.mod.consts.get(ref).kind === 'str' ? { kind: 's', no: ref, add: 0n } : null;
    }
    const i = f.at(ref);
    const op = f.op[i];
    if (op === OP.GADDR) return { kind: 'g', no: f.aux[i], add: 0n };
    if (op === OP.FADDR) return { kind: 'f', no: f.aux[i], add: 0n };
    if (op === OP.ADD || op === OP.SUB) {
      const base = this.symConstOf(f, f.a[i]);
      if (base === null) return null;
      const k = this.kfoldOf(f, f.b[i]);
      if (k === null) return null;
      return { kind: base.kind, no: base.no, add: op === OP.ADD ? base.add + k : base.add - k };
    }
    return null;
  }

  /**
   * 那一小段指令里能在编译期算出来的整数：常量本身，或几个常量之间的 `+ - *`。
   * 算不出来回 null。
   *
   * 只给 `symConstOf` 用。为什么需要它：`arr + 2` 里那个「乘元素大小」是一条真的
   * `MUL`（文件头偏离 3：这一层不做常量折叠），所以加数不是一个常量 ref 而是一小棵树。
   * 折叠放在**这儿**而不是放回 `genPtrOp`：那一层多折一次会改掉每个函数体里的指令，
   * 而这一格只影响「静态初始化式认不认这个加数」。
   */
  kfoldOf(f, ref) {
    const k = this.kintOf(ref);
    if (k !== null) return k;
    if (ref === REF_NONE || isConstRef(ref)) return null;
    const i = f.at(ref);
    const op = f.op[i];
    if (op !== OP.ADD && op !== OP.SUB && op !== OP.MUL) return null;
    const a = this.kfoldOf(f, f.a[i]);
    if (a === null) return null;
    const b = this.kfoldOf(f, f.b[i]);
    if (b === null) return null;
    if (op === OP.ADD) return a + b;
    if (op === OP.SUB) return a - b;
    return a * b;
  }

  /**
   * native：往暂存区的 `addr` 上放一个「符号 + 加数」的八字节（第二十八片）。
   * 加数走 `emitBytes` 进那八个字节，符号进 `pendingFix` —— 两半在目标文件里
   * 由一条 `POINTER64` 合起来。
   */
  putSymBytes(addr, fix) {
    this.emitBytes(addr, 8, BigInt.asUintN(64, fix.add));
    this.pendingFix.push({ off: addr, kind: fix.kind, no: fix.no, add: fix.add });
  }

  /**
   * native：一个算出来的地址常量落在某个匿名静态块里吗（第三十四片）。
   *
   * 静态的复合字面量在这条腿上照旧先摆进暂存区，所以 `&(struct P){71,72}` 与
   * `(int []){3,2,1}` 算出来的是**暂存区里的一个数**。那个数不能就这么写进目标文件
   * （它指着 64K 那一带），可它也不是「不是常量」—— 它是「那个匿名符号 + 偏移」。
   *
   * 按**地址区间**认而不是在表达式一路上多带一个字段：那一路上地址会经过下标、
   * 成员、指针算术好几手，每一手都记得捎上「我来自哪一块」是行不通的。
   */
  anonFixOf(k) {
    const at = Number(k);
    for (const b of this.anonStatics) {
      if (at >= b.addr && at < b.addr + b.size) {
        return { kind: 'g', no: b.gno, add: BigInt(at - b.addr) };
      }
    }
    return null;
  }

  /**
   *
   * 文本用 JS 的 `String(number)`：它是**往回读得回同一个 double** 的最短十进制
   * （ECMA-262 Number::toString），所以常量池按文本去重不会把两个不同的 double
   * 合成一个。`f32` 那一格先 `fround` 再取文本 —— 池子那边说了「造它的人负责 fround」
   * （`ir.js:453`），不 fround 的话 `0.1f` 会以 double 的文本进池，再往 f32 上读一次，
   * 而那两个数在 `x == 0.1f` 上就不相等了。
   */
  fkonst(ty, x) {
    if (mirTypeOf(ty) === T_F32) {
      const s = Math.fround(x);
      return this.mod.consts.f32(String(s));
    }
    return this.mod.consts.real(String(x));
  }


  /* ---------------------------------------------------------------- 取值
   * `gv` 与 `gvtst` 的等价物（`tccgen.c:1844` / `gvtst`）。两条路的分工：
   *   gv   —— 「我要一个值」：左值发 LOAD，比较摊成 0/1
   *   gtst —— 「我要一个条件」：比较原样用，别的变成「!= 0」
   * 分成两条正是 tcc 保留 `VT_CMP` 的全部收益：`if (a < b)` 一条比较就够。 */

  gv(v) {
    /* 数组的**值**是它首元素的地址（C11 6.3.2.1 第 3 段）。落在这儿而不是只落在
     * `decay` 里，是因为 gv 是所有「我要一个值」的必经之路 —— 漏一处就会 MLOAD 一个
     * 数组，而那条 MLOAD 的宽度是元素的宽度，错得很像对。 */
    if (isArray(v.ty.t)) return this.addrOf(v);
    /* 函数指示符的**值**是指向它的指针（C11 6.3.2.1 第 4 段）。与数组那一条同一个位置、
     * 同一个理由：gv 是「我要一个值」的必经之路，漏一处就会 MLOAD 一个函数。 */
    if (isFunc(v.ty.t)) return this.addrOf(v);
    /* struct 的**值**在这一片没有形态：MIR 的一条指令只产出一个标量。传参、返回、
     * 比较都要 ABI 的那套（按大小决定寄存器还是隐藏指针），是下一片的事。
     * 赋值不走这儿 —— `vstore` 在调 gv 之前就分岔去 `structCopy` 了。 */
    if (isStruct(v.ty.t)) this.todo('struct 当值用还没到（传参、返回、比较）');
    if (isBitfield(v.ty.t)) return this.gvBitfield(v);
    if (v.mem !== null) {
      /* 内存左值：静态偏移进访问描述符，于是 `a[3]` 与 `p->f` 不多一条加法。 */
      return this.f.emit(OP.MLOAD, mirTypeOf(v.ty), v.mem.addr, REF_NONE,
        memDesc(loadKindOf(v.ty), v.mem.off));
    }
    if (v.slot !== null) {
      return this.f.emit(OP.LOAD, mirTypeOf(v.ty), REF_NONE, REF_NONE, v.slot);
    }
    if (v.cmp) {
      /* 比较当整数用：C 规定是 0 或 1。MIR 的区域**不产出值**，所以只能落到槽上
       * （`from_oir.js` 的 logic/ternary 同一套）。这条路只有真的把比较当数用时才走 ——
       * `x = a < b` 走，`if (a < b)` 不走。 */
      const slot = this.temp(T_I32, 'cmp');
      const f = this.f;
      this.open(OP.IF, 'if', v.ref);
      f.emit(OP.STORE, T_VOID, this.mod.consts.i32(1), REF_NONE, slot);
      this.elseHalf();
      f.emit(OP.STORE, T_VOID, this.mod.consts.i32(0), REF_NONE, slot);
      this.close();
      return f.emit(OP.LOAD, T_I32, REF_NONE, REF_NONE, slot);
    }
    if (btype(v.ty.t) === VT_VOID) this.err('void value not ignored as it ought to be');
    return v.ref;
  }

  /**
   * 读一个位域（`gv` 里 `VT_BITFIELD` 那一支，`tccgen.c:1850`）。
   *
   * **两条移位就够**：先左移把要的那几位顶到最高位，再右移回来 —— 有符号用算术右移，
   * 于是符号扩展是免费的（`int a:3` 里存 7，读出来是 -1）。写成
   * `(x >> pos) & mask` 也对，但那样有符号的还要另写一次符号扩展，两条路。
   *
   * 容器只有两种宽度：`long long` 的位域按 64 位，别的都按 32 位（tcc 同样只有这两种）。
   * 布局那一侧保证了一个位域不会跨过它自己的容器，所以这里没有「按字节读」那条路 ——
   * 那条只有 `__attribute__((packed))` 才用得上，而 packed 还没到。
   */
  gvBitfield(v) {
    if (v.mem === null) this.err('internal: 位域左值不在内存上');
    const pos = bitPosOf(v.ty.t);
    const bits = bitSizeOf(v.ty.t);
    const base = bitfieldBase(v.ty);
    /* 拿几个字节读是**访问类型**说的事（`adjust_bf`）：多数时候就是声明的那个类型，
     * 越过容器的那些由布局的收尾挑过一个（见 `fixBitfields`）。 */
    const acc = bfAccess(v.ty);
    if (pos + bits > typeSize(acc).size * 8) {
      this.err('internal: 位域跨过了它的容器（要 packed 那条按字节读的路）');
    }
    /* 符号性跟着**声明的**类型；`_Bool` 位域按无符号（`tccgen.c:1860`）。 */
    const uns = isUnsigned(base.t) || btype(base.t) === VT_BOOL;
    const cont = bfValTypeOf(v.ty);
    /* 移位的宽度按**容器**来 —— 而容器的宽度跟着访问类型（见 `bfValTypeOf`）。 */
    const W = btype(cont.t) === VT_LLONG ? 64 : 32;
    const f = this.f;
    const mt = mirTypeOf(cont);
    /* 容器整个读出来（宽度按访问类型，于是 `char c:3` 只读一个字节），
     * 再转成容器类型 —— `castTo` 顺手把窄类型那条收口规则也用上了。 */
    let r = this.gv(this.castTo(sMem(acc, v.mem.addr, v.mem.off), cont));
    const up = W - (pos + bits);
    if (up > 0) r = f.emit(OP.SHL, mt, r, this.konst(cont, up), 0);
    const down = W - bits;
    if (down > 0) r = f.emit(uns ? OP.USHR : OP.SHR, mt, r, this.konst(cont, down), 0);
    return r;
  }

  /**
   * 数组 -> 指向首元素的指针（`gen_cast` 之前 tcc 靠 `VT_ARRAY` 与 `VT_PTR` 同在一格
   * 免了大部分这类代码，见 ctype.js 头）。**值**不变，只是类型从 `T[N]` 变成 `T*` ——
   * 所以这里没有指令，只有一次 `addrOf`（它本身可能发一条 ADD）。
   */
  decay(v) {
    if (isArray(v.ty.t)) {
      /* 数组退化成「指向头一个元素」的指针，也就是它的地址。
       *
       * 没有地址的数组值只有一种来源：**返回类型是数组的函数**
       * （`char f()[] { … }`，tcctest.c:1560，第四十二片）。那个值在寄存器里，
       * tcc 那边也是这么处理的 —— 它的 `gen_cast` 直接把 VT_ARRAY 位抹掉、
       * 剩下的就是指针，而寄存器里那个数照原样用。 */
      if (v.mem === null && v.slot === null) return sVal(mkPointer(v.ty.ref), v.ref);
      return sVal(mkPointer(v.ty.ref), this.addrOf(v));
    }
    /* 函数指示符退化成「指向这个函数」的指针（C11 6.3.2.1 第 4 段）。它的地址就是
     * 那个函数指针值本身（第十三片：值是函数表下标 + 1，见 ir.js 的 `CALLI`）。 */
    if (isFunc(v.ty.t)) return sVal(mkPointer(v.ty), this.addrOf(v));
    return v;
  }

  /**
   * 取地址（`&x`，tcc 的 `VT_LLOCAL`/`gaddrof`）。
   *
   * 内存左值：帧基址加帧内偏移，**一条 ADD**（偏移是 0 时连这条也没有）。
   * 槽左值：在**第一遍**里只把名字记下来（那一遍的输出要丢掉），第二遍这个名字已经
   * 落在内存上了，所以再走到这儿就是 bug —— 报出来，别静悄悄发一个错地址。
   */
  addrOf(v) {
    /* 位域没有地址（C11 6.5.3.2 第 1 段：`&` 的操作数不能是位域）—— 它连整字节都不占。 */
    if (isBitfield(v.ty.t)) this.err("cannot take address of bit-field");
    if (v.mem !== null) {
      if (v.mem.off === 0) return v.mem.addr;
      /* 地址本身是常量（全局量、字符串字面量）时把偏移**折进去**：`&st.b` 于是也是一个
       * 编译期常量，静态初始化式那一路要它（第四十八片）。函数体里这一折省一条 ADD。 */
      const k = this.kintOf(v.mem.addr);
      if (k !== null) {
        return this.mod.consts.int(BigInt.asUintN(64, k + BigInt(v.mem.off)));
      }
      return this.f.emit(OP.ADD, T_I64, v.mem.addr,
        this.mod.consts.int(BigInt(v.mem.off)), 0);
    }
    if (v.slot !== null) {
      if (this.pass1) {
        if (v.name !== null) this.addrTaken.add(v.name);
        return this.mod.consts.int(0n);
      }
      this.err(`internal: 取 '${v.name}' 的地址，但第二遍里它还在槽上`);
    }
    this.err("lvalue required as unary '&' operand");
    return REF_NONE;
  }

  gtst(v) {
    if (v.cmp) return v.ref;
    const r = this.gv(v);
    return this.f.emit(OP.NE, mirTypeOf(v.ty), r, this.konst(v.ty, 0), 0);
  }

  /** 「我要 0 或 1」：`&&` / `||` 与 `!` 的结果，以及转成 `_Bool` 都要它。 */
  gvBool(v) {
    return this.gv(sCmp(this.gtst(v)));
  }

  /* ---------------------------------------------------------------- 类型转换 */

  /**
   * 整型提升（C11 6.3.1.1）。`_Bool`/`char`/`short` -> `int`。
   *
   * **不发任何转换指令** —— 因为窄整数在寄存器里永远是规范形（见文件头那一节）。
   * 无符号的窄类型也一样：`unsigned char` 的取值落在 0..255，当 `int` 读还是同一个数。
   * 这就是那条不变量买到的东西；它也意味着任何产生窄值的地方必须自己收口，
   * 而收口只在 `castTo` 一处。
   *
   * 但**左值要先取出来**：宽度只在「访问那一刻」有意义（内存左值的 MLOAD 描述符按
   * 声明的类型选，槽的 LOAD 也是）。先换类型码再取值，就会按 `int` 的宽度去读 ——
   * `char *t; t[1]` 于是读了 4 个字节。这一格错过一次，MIR 里印出来是
   * `mload i32 %5 i32s`（该是 `i8s`），而 `t[1]` 的值变成了后面三个字节拼出来的数。
   */
  promote(v0) {
    /* 位域先取出来：位域信息只能挂在左值上（见 `bfValTypeOf`）。取出来之后它已经是
     * 容器那个宽度（int / long long），所以下面那条窄类型的提升不会再动它。 */
    const v = isBitfield(v0.ty.t) ? sVal(bfValTypeOf(v0.ty), this.gv(v0)) : v0;
    const b = btype(v.ty.t);
    if (b !== VT_BOOL && b !== VT_BYTE && b !== VT_SHORT) return v;
    return sVal(TY_INT, this.gv(v));
  }

  /**
   * 常规算术转换（C11 6.3.1.8）。这一片只有整型，所以规则收成三句：
   *   1. 两边先做整型提升；
   *   2. 取较宽的那个宽度；
   *   3. 32 位上「有一个无符号就无符号」；64 位上只看**本来就是 64 位**的那个的符号性
   *      —— `unsigned int` 与 `long long` 相遇是 `long long`（它装得下全部 uint），
   *      而 `unsigned long long` 与 `long long` 相遇是无符号。
   * 第 3 条那两种情形分开写，是因为合成一句就会把 `(uint, ll)` 判成无符号 —— 那是错的，
   * 而它错的时候只有在 `-1` 那种边界值上才看得出来。
   */
  usualArith(a, b) {
    const x = this.promote(a);
    const y = this.promote(b);
    /* 浮点先收：C11 6.3.1.8 第 1 段是「有一边是浮点，就都转到较宽的那个浮点」——
     * 整型那三句一句都用不上（`double` 与 `unsigned long long` 相遇是 `double`）。
     * `float + float` 留在 `float`：C 不要求中间算成 double（那是 K&R 的规则），
     * 而 tcc 也是按声明的类型算的。 */
    if (isFloat(x.ty.t) || isFloat(y.ty.t)) {
      const fx = isFloat(x.ty.t) ? floatRankOf(x.ty) : -1;
      const fy = isFloat(y.ty.t) ? floatRankOf(y.ty) : -1;
      const ty = (fx > fy ? x.ty : y.ty);
      return { ty, a: this.castTo(x, ty), b: this.castTo(y, ty) };
    }
    const bx = intBitsOf(x.ty);
    const by = intBitsOf(y.ty);
    const bits = bx > by ? bx : by;
    let uns;
    if (bits === 32) uns = isUnsigned(x.ty.t) || isUnsigned(y.ty.t);
    else uns = (bx === 64 && isUnsigned(x.ty.t)) || (by === 64 && isUnsigned(y.ty.t));
    let ty;
    if (bits === 64) ty = uns ? TY_ULLONG : TY_LLONG;
    else ty = uns ? TY_UINT : TY_INT;
    return { ty, a: this.castTo(x, ty), b: this.castTo(y, ty) };
  }

  /**
   * `gen_cast`（`tccgen.c` 的 `gen_cast`）的整型这一片。**唯一会截宽度的地方**。
   *
   * 三步，顺序有讲究：先在 MIR 的两个宽度之间挪（i32 <-> i64），再收口到 C 的位宽。
   * 反过来做会在 `(char)(long long)x` 上少截一次。
   */
  castTo(v0, ty) {
    const f = this.f;
    /* 源侧先退化：`char *p = "abc"` 与 `int *q = a`（a 是数组）走的是同一条路。 */
    const v = this.decay(v0);
    /* **目标侧**是数组的话，去掉「数组」这一层，剩下的是「指向元素的指针」。
     *
     * 这不是我们编的规则：tcc 的 `gen_cast` 最后一句就是
     * `vtop->type.t &= ~(VT_CONSTANT | VT_VOLATILE | VT_ARRAY | VT_TLS)`
     * （`tccgen.c:3490`），而它的数组是 `VT_PTR | VT_ARRAY` —— 去掉 VT_ARRAY 剩下的
     * 正好是指针。转成数组类型这件事只在几个边角上出现，`char f()[] { return 0; }`
     * （tcctest.c:1560，第四十二片）是一个：返回类型是 `char[]`，`return 0` 于是是
     * 「0 转成 char*」。 */
    if (isArray(ty.t)) return this.castTo(v, mkPointer(ty.ref));
    const tb = btype(ty.t);
    if (tb === VT_VOID) return sVal(TY_VOID, REF_NONE);
    // 转成 `_Bool`：C 规定「非零就是 1」，不是「截低位」。`(_Bool)256` 是 1，不是 0。
    if (tb === VT_BOOL) return sVal(ty, this.gvBool(v));

    /* 源侧是位域就先取出来 —— 位域信息只能挂在左值上（见 `bfValTypeOf`）。
     * 不在这儿收口的话，`castTo` 会回一个「带着位域信息但没有地址」的值，
     * 下一次 gv 当场炸。printf 的实参上踩过这一格。 */
    if (isBitfield(v.ty.t)) {
      return this.castTo(sVal(bfValTypeOf(v.ty), this.gv(v)), ty);
    }

    const from = v.ty;
    if (isFloat(from.t) || isFloat(ty.t)) return this.castFloat(v, ty);
    if (isStruct(from.t) || isStruct(ty.t)) {
      /* 同类型的 struct 往 struct 走一定是「当值用」（传参、返回、`?:` 的两臂），
       * 不是转换 —— 报「还没到」而不是「转不了」，否则报错文本会写成
       * `cannot convert 'struct P' to 'struct P'`，看着像 bug 而不是进度。 */
      if (sameType(from, ty)) this.todo('struct 当值用还没到（传参、返回、比较）');
      this.err(`cannot convert '${typeText(from)}' to '${typeText(ty)}'`);
    }
    if (!isInteger(from.t) && !isPtr(from.t)) {
      this.err(`cannot convert '${typeText(from)}' to '${typeText(ty)}'`);
    }

    let r = this.gv(v);
    /* 常量折叠。tcc 的 `gen_cast` 在 `VT_CONST` 上也是当场算完（`tccgen.c:2135` 一带），
     * 不发指令 —— 而这不只是省一条指令：`offsetof` 展开出来的 `&((T*)0)->f` 要靠
     * 「`(T*)0` 还是个常量」才是常量表达式（见 `ceUnary` 的 `&` 那一格）。
     * 截断规则与 `ceCastTo` 同一套：先按目标宽度回绕，再进 `konst` 收成规范形。 */
    const kv = this.kintOf(r);
    if (kv !== null) {
      const bits = isPtr(ty.t) ? 64 : intBitsOf(ty);
      return sVal(ty, this.konst(ty,
        isUnsigned(ty.t) ? BigInt.asUintN(bits, kv) : BigInt.asIntN(bits, kv)));
    }
    const srcMir = mirTypeOf(from);
    const dstMir = mirTypeOf(ty);
    if (srcMir === T_I32 && dstMir === T_I64) {
      // 扩宽：看**源**的符号性。`(long long)(unsigned)-1` 是 4294967295，不是 -1。
      r = f.emit(OP.CVT, T_I64, r, REF_NONE, isUnsigned(from.t) ? CVT_ZEXT : CVT_SEXT);
    } else if (srcMir === T_I64 && dstMir === T_I32) {
      r = f.emit(OP.CVT, T_I32, r, REF_NONE, CVT_TRUNC);
    }
    return sVal(ty, this.narrow(r, ty));
  }

  /**
   * 有浮点参与的转换（`gen_cast` 里浮点那几支，`tccgen.c:2100` 一带）。
   *
   * 四条路，每条一两条指令：
   *   - 浮点 -> 浮点：宽度一样就什么都不发，不一样发一条 `CVT_FCVT`。
   *   - 整型 -> 浮点：**先把整数扩到 64 位**，再发 `CVT_I2F` / `CVT_U2F`。
   *     那次扩宽不是多余的：`CVT_U2F` 在 MIR 里是「把这 64 位当无符号读」
   *     （`interp.js:485` 的 `asUintN(64, ...)`），而 `unsigned int` 的规范形是
   *     **符号扩展过的** i32（见文件头那条不变量）—— 直接喂给 U2F，
   *     `(double)(unsigned)-1` 会算成 1.8446744073709552e19 而不是 4294967295。
   *     扩宽走整型那条 `castTo`，于是符号性那一格只在一处判。
   *   - 浮点 -> 整型：一条 `CVT_F2I`（朝零截尾，C11 6.3.1.4 第 1 段）再收口窄宽度。
   *     无符号目标**不走**同一条（第九十五片）：硬件那两条转有符号的指令在越界处饱和，
   *     所以 64 位的走 `CVT_F2U`、32 位及以下的先转 i64 再截 —— 见下面那段注释。
   *   - 浮点 <-> 指针：C 里不存在，报错。静悄悄按位走会让 `(void*)1.5` 编过。
   *
   * `_Bool` 与 `void` 不到这儿 —— `castTo` 在前面就分岔了，所以「非零就是 1」
   * 对浮点也自动是对的（`gtst` 与 `0.0` 比）。
   */
  castFloat(v, ty) {
    const f = this.f;
    const from = v.ty;
    if (isPtr(from.t) || isPtr(ty.t) || isStruct(from.t) || isStruct(ty.t)) {
      this.err(`cannot convert '${typeText(from)}' to '${typeText(ty)}'`);
    }
    const srcMir = mirTypeOf(from);
    const dstMir = mirTypeOf(ty);
    if (isFloat(from.t) && isFloat(ty.t)) {
      const r = this.gv(v);
      if (srcMir === dstMir) return sVal(ty, r);
      return sVal(ty, f.emit(OP.CVT, dstMir, r, REF_NONE, CVT_FCVT));
    }
    if (isFloat(ty.t)) {
      if (!isInteger(from.t)) this.err(`cannot convert '${typeText(from)}' to '${typeText(ty)}'`);
      const w = isUnsigned(from.t) ? TY_ULLONG : TY_LLONG;
      const r = this.gv(this.castTo(v, w));
      return sVal(ty, f.emit(OP.CVT, dstMir, r, REF_NONE,
        isUnsigned(from.t) ? CVT_U2F : CVT_I2F));
    }
    if (!isInteger(ty.t)) this.err(`cannot convert '${typeText(from)}' to '${typeText(ty)}'`);
    /* 目标是**无符号**的话，硬件那条「转成有符号」不能直接用：它在越界处**饱和**
     * （`(unsigned long long)9223372036854775808.0` 会得 `0x7fff…`）。两种宽度两种办法
     * （第九十五片）：
     *   64 位 -> 一条 `CVT_F2U`（`fcvtzu` / x86 上分两路）；
     *   32 位及以下 -> 先转成 **i64**（u32 的每个值都装得进有符号 64 位），再截到 32 位。
     *     `(unsigned)3000000000.0` 直接走 32 位那条会饱和成 `0x7fffffff`。 */
    if (isUnsigned(ty.t)) {
      if (dstMir === T_I64) {
        return sVal(ty, f.emit(OP.CVT, T_I64, this.gv(v), REF_NONE, CVT_F2U));
      }
      const wide = f.emit(OP.CVT, T_I64, this.gv(v), REF_NONE, CVT_F2I);
      return sVal(ty, this.narrow(f.emit(OP.CVT, T_I32, wide, REF_NONE, CVT_TRUNC), ty));
    }
    const r = f.emit(OP.CVT, dstMir, this.gv(v), REF_NONE, CVT_F2I);
    return sVal(ty, this.narrow(r, ty));
  }

  /**
   * 收口到 C 的位宽（8 / 16 位；32 与 64 位由 MIR 的类型码本身保证）。
   * 有符号走 `CVT_SEXT8`/`SEXT16`（wasm 的 `i32.extend8_s`），无符号走一次按位与 ——
   * 没有 `ZEXT8` 那种模式，因为「零扩展 8 位」就是 `& 0xff`，MIR 已经有 BAND 了。
   */
  narrow(r, ty) {
    const f = this.f;
    const b = btype(ty.t);
    if (b === VT_BYTE) {
      if (isUnsigned(ty.t)) return f.emit(OP.BAND, T_I32, r, this.mod.consts.i32(255), 0);
      return f.emit(OP.CVT, T_I32, r, REF_NONE, CVT_SEXT8);
    }
    if (b === VT_SHORT) {
      if (isUnsigned(ty.t)) return f.emit(OP.BAND, T_I32, r, this.mod.consts.i32(65535), 0);
      return f.emit(OP.CVT, T_I32, r, REF_NONE, CVT_SEXT16);
    }
    return r;
  }

  /** 把一个值存进左值（`vstore`，`tccgen.c:3690`）。赋值表达式的值是**转换之后**的值。 */
  vstore(target, v) {
    if (!isLval(target)) this.err('lvalue expected');
    if (isArray(target.ty.t)) this.err('assignment to expression with array type');
    if (isStruct(target.ty.t)) return this.structCopy(target, v);
    if (isBitfield(target.ty.t)) return this.storeBitfield(target, v);
    const cv = this.castTo(v, target.ty);
    const r = this.gv(cv);
    if (target.mem !== null) {
      /* MSTORE 的 `t` 是**值**的类型，宽度在描述符里（ir.js:293）。窄类型于是
       * 「存低若干位、读回来重新收口」—— 那条不变量（见文件头）在内存这一侧是免费的。 */
      this.f.emit(OP.MSTORE, mirTypeOf(target.ty), target.mem.addr, r,
        memDesc(storeKindOf(target.ty), target.mem.off));
    } else {
      this.f.emit(OP.STORE, T_VOID, r, REF_NONE, target.slot);
    }
    return sVal(target.ty, r);
  }

  /**
   * struct / union 的赋值（`vstore` 里 `VT_STRUCT` 那一支，`tccgen.c:3690`）。
   *
   * C 规定它是**整块字节的拷贝**（6.5.16.1），padding 里是什么不指定。tcc 在这里发一次
   * `memcpy` 的等价物；这一片大小是**编译期常量**，所以直接摊成几条 8/4/2/1 字节的
   * load + store：没有循环、没有对 libc 的依赖，也不必给 MIR 加一条块拷贝指令。
   * 12 字节的 struct 是三条 store，一个 `memcpy` 调用换不来这个。
   *
   * 两侧都必须是内存左值 —— `needsMem` 保证了 struct 变量一定落在帧或 data 段上，
   * 所以这条前提不是巧合。真走到 else 那支就是别处漏了 `needsMem`，报内部错。
   *
   * 不按 struct 自己的对齐去切：线性内存允许非对齐访问（wasm 与我们的解释器都允许），
   * 所以全 `char` 的 struct 也照样八字节一步走。
   */
  structCopy(target, v) {
    if (!sameTypeUnqual(target.ty, v.ty)) {
      this.err(`cannot assign '${typeText(v.ty)}' to '${typeText(target.ty)}'`);
    }
    if (target.mem === null || v.mem === null) {
      this.err('internal: struct 赋值的两侧都该是内存左值');
      return target;
    }
    const size = typeSize(target.ty).size;
    const f = this.f;
    for (let done = 0; done < size;) {
      const left = size - done;
      const w = left >= 8 ? 8 : left >= 4 ? 4 : left >= 2 ? 2 : 1;
      const mt = w === 8 ? T_I64 : T_I32;
      const r = f.emit(OP.MLOAD, mt, v.mem.addr, REF_NONE,
        memDesc(COPY_MK[w], v.mem.off + done));
      f.emit(OP.MSTORE, mt, target.mem.addr, r,
        memDesc(COPY_SK[w], target.mem.off + done));
      done += w;
    }
    /* 赋值表达式的值是「赋完之后的左边」。struct 没有寄存器形态，所以回那个左值本身 ——
     * 于是 `a = b = c` 与 `(a = b).f` 都对，而且不多一次拷贝。 */
    return target;
  }

  /**
   * 写一个位域（`vstore` 里 `VT_BITFIELD` 那一支，`tccgen.c:3748`）。
   *
   * 读改写：`容器 = (容器 & ~(mask << pos)) | ((值 & mask) << pos)`。掩码运算一律按
   * **无符号**做 —— 有符号的 `~mask` 在算术上是负数，虽然位一样，但按无符号写就不必
   * 每次都想一遍「这里会不会被符号扩展带歪」。
   *
   * 回的是**左值本身**，不是那个存进去的值：`x = s.a = 300` 里 `s.a` 只有 3 位，
   * 表达式的值该是截断后的 4 而不是 300。回左值让读那一侧走 `gvBitfield`，
   * 于是「截断」这件事只在一处实现（tcc 靠 `vdup` 把左值留在栈上，同一个用意）。
   */
  storeBitfield(target, v) {
    if (target.mem === null) this.err('internal: 位域左值不在内存上');
    const pos = bitPosOf(target.ty.t);
    const bits = bitSizeOf(target.ty.t);
    /* 读改写都按**访问类型**（`vstore` 里也是先 `adjust_bf` 再 `gen_cast`，
     * 于是掩码的宽度、那条 load、那条 store 用的都是它）。 */
    const acc = bfAccess(target.ty);
    const w64 = btype(acc.t) === VT_LLONG;
    const cont = w64 ? TY_ULLONG : TY_UINT;
    const mt = mirTypeOf(cont);
    const f = this.f;
    const mask = (1n << BigInt(bits)) - 1n;

    let r = this.gv(this.castTo(v, acc));
    r = f.emit(OP.BAND, mt, r, this.konst(cont, mask), 0);
    if (pos > 0) r = f.emit(OP.SHL, mt, r, this.konst(cont, pos), 0);

    let old = this.gv(sMem(acc, target.mem.addr, target.mem.off));
    old = f.emit(OP.BAND, mt, old, this.konst(cont, ~(mask << BigInt(pos))), 0);
    const nv = f.emit(OP.BOR, mt, old, r, 0);
    /* MSTORE 的 `t` 是**值**的类型，宽度在描述符里 —— 描述符按访问类型选，
     * 于是 `char c:3` 只写回那一个字节，不会碰到旁边的成员。 */
    f.emit(OP.MSTORE, mt, target.mem.addr, nv,
      memDesc(storeKindOf(acc), target.mem.off));
    return target;
  }

  /* ------------------------------------------------------------ 表达式 */

  /**
   * `gen_op`（`tccgen.c:3042`）的整型这一片。
   *
   * 两处与「两边都做常规算术转换」不同，都是 C 明文规定的：
   *   - **移位**：两边**各自**做整型提升，不做常规算术转换。结果类型是左操作数提升后的
   *     类型，而「算术右移还是逻辑右移」看的是**左**操作数的符号性。合并到 usualArith
   *     里会让 `(unsigned char)x >> 1` 变成无符号右移 —— 提升之后它是 `int`，该是算术右移。
   *   - **比较**：操作数照常规算术转换，但结果是 `int`（我们回一个 VT_CMP，不摊平）。
   */
  genOp(op, a0, b0) {
    const f = this.f;
    const a = this.decay(a0);
    const b = this.decay(b0);
    if (isPtr(a.ty.t) || isPtr(b.ty.t)) return this.genPtrOp(op, a, b);
    /* 浮点上没有的那几个运算符（C11 6.5.5 第 2 段要求 `%` 的两侧是整型，
     * 6.5.7 / 6.5.10-12 要求移位与位运算的两侧是整型）。在这儿拦而不是让
     * `usualArith` 出来的浮点类型撞上 `OP.MOD`：撞上去是 verifier 的内部错，
     * 而这是用户代码里的一个普通错误，该有普通的报错文本。 */
    if (isFloat(a.ty.t) || isFloat(b.ty.t)) {
      if (op === PERCENT || op === AMP || op === PIPE || op === CARET
        || op === TOK_SHL || op === TOK_SAR) {
        this.err(`invalid operands to binary '${this.cpp.tokStr(op, null)}' (floating point)`);
      }
    }

    if (op === TOK_SHL || op === TOK_SAR) {
      const l = this.promote(a);
      const r = this.promote(b);
      const mop = binOpOf(op, isUnsigned(l.ty.t));
      // 位移量要与被移的值同宽（MIR 的算术两个操作数同类型）
      const rr = this.gv(this.castTo(r, l.ty));
      return sVal(l.ty, f.emit(mop, mirTypeOf(l.ty), this.gv(l), rr, 0));
    }
    const cmp = cmpOpOf(op, false);
    if (cmp !== null) {
      const u = this.usualArith(a, b);
      const cop = cmpOpOf(op, isUnsigned(u.ty.t));
      /* 比较指令的 `t` 是**操作数**的类型（ir.js:187），结果永远是 bool。 */
      return sCmp(f.emit(cop, mirTypeOf(u.ty), this.gv(u.a), this.gv(u.b), 0));
    }
    const u = this.usualArith(a, b);
    const mop = binOpOf(op, isUnsigned(u.ty.t));
    if (mop === null) this.err(`internal: binary operator ${this.cpp.tokStr(op, null)}`);
    return sVal(u.ty, f.emit(mop, mirTypeOf(u.ty), this.gv(u.a), this.gv(u.b), 0));
  }

  /** 一个操作数当 i64 用：指针本来就是 i64（字节偏移），整数先转过去。 */
  asI64(v) {
    if (isPtr(v.ty.t)) return this.gv(v);
    return this.gv(this.castTo(v, TY_LLONG));
  }

  /**
   * 指针参与的运算（`gen_op` 里 `VT_PTR` 那几支，`tccgen.c:3042` 一带）。
   * 指针在 MIR 里是线性内存的**字节偏移**（i64），于是三条规则各自只有一两条指令：
   *   - `p + n` / `p - n`：n 转成 i64，乘元素大小，再加/减。元素是 1 字节时不发那条
   *     MUL —— 那不是常量折叠（文件头偏离 3 说不折叠），是不发一条无操作。
   *   - `p - q`：两个偏移相减再除以元素大小。结果类型是 `ptrdiff_t`，LP64 上是 long。
   *   - 比较：比两个偏移。用**无符号**比较 —— C 只定义同一个对象内的指针比较，而同一个
   *     对象内的偏移都是正数；无符号这一选择也要与将来的后端一致（地址不是负数）。
   * `p + q`（两个指针相加）与 `p * n` 之类是错的，报出来 —— 静悄悄按整数算会让
   * `p * 2` 编过，而那是一个几乎不可能查出来的错。
   */
  genPtrOp(op, a, b) {
    const f = this.f;
    const pa = isPtr(a.ty.t);
    const pb = isPtr(b.ty.t);
    const cop = cmpOpOf(op, true);
    if (cop !== null) return sCmp(f.emit(cop, T_I64, this.asI64(a), this.asI64(b), 0));
    if (op !== PLUS && op !== MINUS) {
      this.err(`invalid operands to binary '${this.cpp.tokStr(op, null)}' (pointer)`);
    }
    if (pa && pb) {
      if (op !== MINUS) this.err("invalid operands to binary '+' (two pointers)");
      /* 元素是变长的（`int (*)[n]`，也就是 `int a[2][n]` 退化出来的那个）：一格多大
       * 要在运行期读（tcc 的 `vpush_type_size` 就是这一格）。 */
      if (isVla(a.ty.ref)) {
        const d0 = f.emit(OP.SUB, T_I64, this.gv(a), this.gv(b), 0);
        return sVal(TY_LLONG, f.emit(OP.DIV, T_I64, d0, this.vlaSizeRef(a.ty.ref), 0));
      }
      const es = typeSize(a.ty.ref).size;
      if (es === 0) this.err('arithmetic on a pointer to an incomplete type');
      const d = f.emit(OP.SUB, T_I64, this.gv(a), this.gv(b), 0);
      if (es === 1) return sVal(TY_LLONG, d);
      return sVal(TY_LLONG, f.emit(OP.DIV, T_I64, d, this.mod.consts.int(BigInt(es)), 0));
    }
    // 一个指针一个整数。`n - p` 是错的（`p - n` 才对），所以减法只认指针在左
    if (op === MINUS && !pa) this.err("invalid operands to binary '-'");
    const p = pa ? a : b;
    const n = pa ? b : a;
    if (!isInteger(n.ty.t)) this.err("invalid operands to binary '+'");
    /* 同上：`a[i]` 里那一步「加 i 格」在元素变长时是一次乘法而不是一个常量。 */
    if (isVla(p.ty.ref)) {
      const step = f.emit(OP.MUL, T_I64, this.asI64(n), this.vlaSizeRef(p.ty.ref), 0);
      return sVal(p.ty, f.emit(op === PLUS ? OP.ADD : OP.SUB, T_I64, this.gv(p), step, 0));
    }
    const es = typeSize(p.ty.ref).size;
    if (es === 0) this.err('arithmetic on a pointer to an incomplete type');
    let k = this.asI64(n);
    /* 两边都是常量就**在编译期算完**，一条指令都不发。`int *rel1 = &reltab[1];`
     * （tcctest.c:2900，第四十八片）要靠这一条：全局量的地址在我们这儿是个编译期常量
     * （data 段里的偏移），于是「常量 + 常量」折完之后那个静态初始化式就是一个数。
     * tcc 那边这是一条重定位（`.data` 里写 `reltab + 4`）；我们的「链接」是一个数，
     * 所以折叠**就是**那条重定位。 */
    const nk = this.kintOf(k);
    const pk = p.mem === null && p.slot === null ? this.kintOf(p.ref) : null;
    if (nk !== null && pk !== null) {
      const d = nk * BigInt(es);
      return sVal(p.ty, this.mod.consts.int(
        BigInt.asUintN(64, op === PLUS ? pk + d : pk - d)));
    }
    if (es !== 1) k = f.emit(OP.MUL, T_I64, k, this.mod.consts.int(BigInt(es)), 0);
    return sVal(p.ty, f.emit(op === PLUS ? OP.ADD : OP.SUB, T_I64, this.gv(p), k, 0));
  }

  /**
   * 字符串字面量进 data 段，回它的地址。
   * 同一份文本只进一次 —— C 没规定字面量是否共享，但共享省 data 段，而且
   * 「同一份输入两次编译逐字节相同」要求这张表是确定的（Map 按插入序，是）。
   * 函数体解析两遍（见 finishFunc），所以这个去重同时也保证第二遍不再多占 data。
   */
  strData(bytes) {
    /* native 上串常量不走 data 段（第二十片走的是 MIR 的串常量）。还能到这儿的只有
     * **全局的初值**里那种（`char *p = "x";` 在文件作用域）—— 那要在数据段里放一笔
     * 指向另一个符号的重定位，我们的目标文件写出还没有这一格。 */
    if (this.native) this.todo('native：全局的初值里的字符串字面量（要数据段里的重定位）');
    const hit = this.strs.get(bytes);
    if (hit !== undefined) return hit;
    const addr = this.dataOff;
    const raw = [];
    for (let i = 0; i < bytes.length; i++) raw.push(bytes.charCodeAt(i) % 256);
    raw.push(0);
    this.strs.set(bytes, addr);
    this.dataOff = alignUp(addr + raw.length, 8);
    this.pendingData.push({ off: addr, bytes: raw });
    return addr;
  }

  /**
   * native：一个 C 串字面量在 MIR 常量池里的那一条（第三十片）。
   *
   * 全是 ASCII 就用 `str`（文本，后端按 UTF-8 写出去 —— 对 ASCII 是恒等），
   * 有 0x80 以上的字节就用 `bytes`。分开而不是一律用 `bytes`：`str` 是另外几条腿
   * 也在用的那一种，印出来也是可读的。挑法只看字节内容，所以去重照旧成立。
   */
  strConst(bytes) {
    let ascii = true;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes.charCodeAt(i) > 127) { ascii = false; break; }
    }
    if (ascii) return this.mod.consts.str(bytes);
    const bs = [];
    for (let i = 0; i < bytes.length; i++) bs.push(bytes.charCodeAt(i) % 256);
    return this.mod.consts.bytes(bs);
  }

  /**
   * 一个字符串字面量当**表达式**用。类型是 `char[N+1]`（含结尾的 0）而不是 `char *`，
   * 所以 `sizeof("abc")` 是 4，用在表达式里再退化成指针 —— 用指针的话 sizeof 会变成 8，
   * 而那是最难发现的那种错。
   */
  strLit(bytes) {
    /* native（第九刀第二十片）：字节进 `__DATA` 的一个**符号**，值是那个符号的地址 ——
     * 编译期算不出来（要等链接），所以只能是 MIR 的串常量，后端把它发成
     * `omni_str_<ref>` 加一笔重定位。去重靠常量池，与线性内存那边的 `this.strs`
     * 是同一个效果。 */
    if (this.native) {
      return sMem(mkArray(TY_CHAR, bytes.length + 1), this.strConst(bytes), 0);
    }
    return sMem(mkArray(TY_CHAR, bytes.length + 1),
      this.mod.consts.int(BigInt(this.strData(bytes))), 0);
  }

  /** 宽字符串字面量的那一块 data：一格四字节小端，末尾补一个 0。 */
  wstrData(vals) {
    /* native（第三十三片）：宽串照旧不走线性内存 —— 还能到这儿的只有「把它的地址当成
     * 整型常量」那一种（`(uintptr_t)L"ab"`），那要在编译期知道地址，而 native 上
     * 地址要等链接。窄串那一路的 `strData` 同理。 */
    if (this.native) this.todo('native：宽串字面量的地址当整型常量用（地址要等链接）');
    const key = vals.join(',');
    const hit = this.wstrs.get(key);
    if (hit !== undefined) return hit;
    const addr = this.dataOff;
    const raw = [];
    for (const v of [...vals, 0]) {
      const u = v >>> 0;
      raw.push(u & 255, (u >>> 8) & 255, (u >>> 16) & 255, (u >>> 24) & 255);
    }
    this.wstrs.set(key, addr);
    this.dataOff = alignUp(addr + raw.length, 8);
    this.pendingData.push({ off: addr, bytes: raw });
    return addr;
  }

  /**
   * 一个宽字符串字面量当表达式用。类型是 `wchar_t[N+1]` —— 而 `wchar_t` 在这个目标上
   * 就是 `int`（tcc 那边是 `nwchar_t`，非 PE 目标上 `typedef int`），所以
   * `sizeof(L"ab")` 是 12。
   */
  wstrLit(vals) {
    /* native（第三十三片）：与窄串同一个办法 —— 字节进 `__DATA` 的一个符号，值是那个
     * 符号的地址。一格四字节小端、末尾一格 0，与线性内存那边 `wstrData` 铺的一样。 */
    if (this.native) {
      return sMem(mkArray(TY_INT, vals.length + 1), this.wstrConst(vals), 0);
    }
    return sMem(mkArray(TY_INT, vals.length + 1),
      this.mod.consts.int(BigInt(this.wstrData(vals))), 0);
  }

  /** native：一个宽串字面量在 MIR 常量池里的那一条（第三十三片）。一律 `bytes`。 */
  wstrConst(vals) {
    const raw = [];
    for (const v of [...vals, 0]) {
      const u = v >>> 0;
      raw.push(u & 255, (u >>> 8) & 255, (u >>> 16) & 255, (u >>> 24) & 255);
    }
    return this.mod.consts.bytes(raw);
  }

  /**
   * 收当前这一串字符串字面量的字节。**相邻的要拼起来**（C11 6.4.5 第 5 段）：
   * `"a" "b"` 是一个 `char[3]`。tcc 在 `parse_string` 之后同样靠一个循环吃掉后续的
   * TOK_STR。进来时当前记号是第一个 TOK_STR，`v` 是它的字节串。
   */
  readStrTok(v) {
    let s = String(v);
    this.next();
    while (this.tok === TOK_STR) {
      s += String(this.tokc);
      this.next();
    }
    return s;
  }

  /**
   * 宽字符串那一路（`L"a" L"b"`）。一格是一个 `wchar_t`，所以值是一串数字而不是文本。
   *
   * 宽窄混着拼（`L"abc" "def"`）tcc 认：它在**字节**层面接（`tccgen.c:8075-8083`
   * 那个循环对两种记号都 `cstr_cat`），于是窄的那半截字节被当成 wchar 读。那是一次
   * 「按表示接、不按元素接」的巧合，不是一条能解释的规则 —— 这一格明着报错，
   * 而 tinycc 自己的 `tcctest.c` 把这种写法关在 `#if 0` 里，oracle 也问不到。
   */
  readWStrTok(v) {
    const vals = Array.from(/** @type {number[]} */ (v));
    this.next();
    for (;;) {
      if (this.tok === TOK_LSTR) {
        for (const x of /** @type {number[]} */ (this.tokc)) vals.push(x);
      } else if (this.tok === TOK_STR) {
        this.todo('第八刀：宽窄字面量混着拼还没到（tcc 是按字节接的）');
      } else break;
      this.next();
    }
    return vals;
  }

  /**
   * 往 data 段写一个整数（小端）。全局量的初始化式走这儿 —— 值在**编译期**就算出来了
   * （`constExpr`），所以运行期一条指令都没有，与 tcc 把它放进 `.data` 是同一件事。
   */
  emitBytes(addr, size, value) {
    const v = BigInt.asUintN(size * 8, value);
    const raw = [];
    for (let i = 0; i < size; i++) raw.push(Number((v >> BigInt(i * 8)) & 255n));
    this.pendingData.push({ off: addr, bytes: raw });
  }

  /** 往 data 段写一串现成的字节（字符串初始化数组走这儿）。 */
  emitRaw(addr, bytes) {
    if (bytes.length > 0) this.pendingData.push({ off: addr, bytes });
  }

  /**
   * 按位往 data 段里**并**（静态位域的初始化式，第四十五片）。
   *
   * 与 `emitBytes` 的区别是它**回头改**同一条记录：一个访问单元里的几个位域来自好几条
   * 初始化式，后来的不能把先前的盖掉。所以按地址记住那一条 `pendingData`、往它的字节里
   * 或进去 —— 没写到的位保持 0，正是 C 要的（静态存储期先零初始化）。
   */
  emitBitfield(addr, size, value) {
    let e = this.statBits.get(addr);
    if (e === undefined || e.bytes.length !== size) {
      e = { off: addr, bytes: new Array(size).fill(0) };
      this.statBits.set(addr, e);
      this.pendingData.push(e);
    }
    const v = BigInt.asUintN(size * 8, value);
    for (let i = 0; i < size; i++) {
      e.bytes[i] |= Number((v >> BigInt(i * 8)) & 255n);
    }
  }

  /**
   * 全局量：住在 data 段里，地址是**编译期常量**。没有初始化式就不写 data ——
   * 线性内存出生时全是 0，而 C 正好规定静态存储期的对象零初始化（C11 6.7.9 第 10 段）。
   * 这一条让「几千个全局量」不多一个字节的 data 段。
   */
  declareGlobal(name, ty, isExtern, align = 0, extra = 0) {
    const hit = this.gvars.get(name);
    if (hit !== undefined) {
      /* 同一个名字声明好几遍是合法的（C11 6.9.2 的**试探性定义**，第三十九片）——
       * `int cinit1; int cinit1;`，以及数组「先不写长度、后面补上」那一对。
       * 合并的规则只有一条：数组的长度谁写了算谁的。 */
      const m = mergeTentative(hit.ty, ty);
      if (m === null) this.err(`incompatible types for redefinition of '${name}'`);
      hit.ty = m;
      if (!isExtern) hit.defined = true;
      if (extra > 0) hit.extra = extra;
      // 长度补上了才划地方（试探性那一条当时没划）
      if (hit.addr < 0 && !(isArray(m.t) && m.count < 0)) this.allocGlobal(hit);
      return hit;
    }
    if (btype(ty.t) === VT_VOID) this.err(`variable '${name}' has void type`);
    /* `extern` 只是「别处有」，尺寸不必现在知道 —— 系统头里满地都是
     * `extern char *sys_errlist[];`。真用起来会在 extern 那一关被拦（没有定义）。
     *
     * 「不完整」要按类型问，不能按「尺寸是 0」问：`int gz[0];` 的尺寸也是 0，
     * 而那是合法的（GNU 的零长数组，tcc 收）。 */
    if (!isExtern) this.needComplete(name, ty);
    const e = { name, ty, addr: -1, defined: !isExtern, used: false, align, extra };
    /* 没写长度的数组是一条**试探性定义**：现在不划地方，等后面那条同名声明补上长度。
     * 一直没补上就是错，而那条错在**用**它的地方报（`gvarLval`），与 tcc 一样。 */
    if (!(isArray(ty.t) && ty.count < 0)) this.allocGlobal(e);
    this.gvars.set(name, e);
    return e;
  }

  /** 给一条全局量的登记在 data 段里划地方。试探性定义要等长度补上才叫。
   * `extra` 是柔性数组成员的初始化式多要的那几个字节（第六十二片）—— 它不进 `sizeof`。 */
  allocGlobal(e) {
    const s = typeSize(e.ty);
    this.dataOff = alignUp(this.dataOff, e.align !== 0 ? e.align : s.align);
    e.addr = this.dataOff;
    this.dataOff += s.size + (e.extra === undefined ? 0 : e.extra);
  }

  /** 一个全局量 -> 左值。地址是常量，静态偏移 0（`p->f` 那种偏移进描述符是后面的事）。 */
  gvarLval(e) {
    /* 试探性定义的长度一直没补上：tcc 也是在**用**它的地方报，而且是这句话
     * （`static int t[]; sizeof(t)` -> `unknown type size`）。 */
    if (e.addr < 0) this.err('unknown type size');
    e.used = true;
    this.symAlign = e.align || 0;
    /* native（第二十一片）：全局量的地址是一个**符号的地址**，编译期算不出来 ——
     * 一条 `GADDR`。往下一切照旧（成员、下标、`&g` 都是「基址 + 偏移」）。
     * 每次用都发一条：这一层的两个后端把每个值都落在栈位上，多一条 `adrp`/`lea`
     * 不改语义，而「把它缓存起来」要先有支配关系的账本，那是窥孔那一片的事。 */
    if (this.native) return sMem(e.ty, this.gaddr(e), 0);
    return sMem(e.ty, this.mod.consts.int(BigInt(e.addr)), 0);
  }

  /** native：一个全局量的地址（`GADDR`）。MIR 的全局号第一次用到才登记。 */
  gaddr(e) {
    if (this.f === null) {
      this.todo('native：全局的初值里出现了地址（要数据段里的重定位）');
    }
    if (e.gno === undefined) e.gno = this.mod.globalNo(e.name);
    return this.f.emit(OP.GADDR, T_I64, REF_NONE, REF_NONE, e.gno);
  }

  /**
   * 初始化式（`decl_initializer`，`tccgen.c:7990` 一带）。
   *
   * **一份代码同时管静态与自动**，这是这一片的核心决定。静态（全局量）要往 data 段写
   * 字节、值必须是常量表达式（C11 6.7.9 第 4 段）；自动（局部量）要发 MSTORE、值是
   * 任意表达式。两者不同的只有**最里面那一层怎么落地**，而「怎么走这棵嵌套结构」
   * 完全一样。tcc 也是这么合的（它靠 `c >= 0` 区分 data 与代码）—— 分成两份的代价是
   * `{{1,2},{3,4}}` 那套遍历规则要写两遍，而它们迟早会在某个边角上不一致。
   *
   * `dest` 三种形状：
   *   `{ stat: true, addr }`  —— data 段，addr 是绝对地址
   *   `{ stat: false, addr }` —— 线性内存，addr 是基址的 ref，`off` 是它上面的偏移
   *   `{ slot }`              —— MIR 的槽（只可能是标量，没被取过地址的局部量）
   */
  initializer(dest, off, ty) {
    // `char s[4] = "ab"`：字符串直接铺进数组（不是「指针赋值」）
    if (isArray(ty.t) && this.tok === TOK_STR) {
      this.initString(dest, off, ty, this.readStrTok(this.tokc));
      return;
    }
    /* `wchar_t s[4] = L"ab"` 同理。类型不对（`char s[] = L"ab"`）就**不**走这一路 ——
     * tcc 那儿的条件也是「元素类型是 wchar_t 才当字符串铺，否则当 (w)char* 表达式」
     * （`tccgen.c:8064-8070` 那个 if 的注释）。 */
    if (isArray(ty.t) && this.tok === TOK_LSTR && btype(ty.ref.t) === VT_INT) {
      this.initWString(dest, off, ty, this.readWStrTok(this.tokc));
      return;
    }
    /* `struct S x = (struct S){61,62};`（第八刀第四十片，tcctest.c:1478）：复合字面量
     * 初始化一个**同类型**的对象时，它与「直接写那对花括号」等价 —— 那个字面量的存储
     * 谁都看不见（地址没被取），所以不必真的划一块再拷一遍。静态那一侧尤其要这样：
     * 拷贝要么是一条重定位、要么得把刚写进 data 的字节再读出来，两样都比这一行贵。
     *
     * `(` 后面不是类型名就把它放回去 —— 那是 `struct S x = (b);` 那一种。 */
    if (this.tok === LPAR && (isArray(ty.t) || isStruct(ty.t))) {
      this.next();
      if (this.isTypeStart(this.tok)) {
        const lty = this.typeName();
        this.skip(RPAR);
        if (this.tok !== LBRACE || !sameType(lty, ty)) {
          this.err(`invalid initializer for '${typeText(ty)}'`);
        }
        return this.initializer(dest, off, ty);
      }
      this.ungetWith(LPAR, null);
    }
    if (this.tok === LBRACE) {
      if (isArray(ty.t) || isStruct(ty.t)) {
        /* `{ "abc" }`：一对花括号裹着的字符串照旧是「铺进数组」（C11 6.7.9 第 14 段）。
         * 但 `{ "xy" "z"[2], 0 }` 不是 —— 那个字面量只是一个更大表达式的开头。
         * tcc 的判法（`tccgen.c:8086`）：把相邻的字面量并完之后看下一格，
         * 是 `}` 或 `,` 才算「孤零零的一个字面量」，否则把并好的串塞回去按表达式走。 */
        if (isArray(ty.t) && btype(ty.ref.t) === VT_BYTE) {
          const bytes = this.tryBracedStr();
          if (bytes !== null) {
            this.initString(dest, off, ty, bytes);
            return;
          }
        }
        if (isArray(ty.t) && btype(ty.ref.t) === VT_INT) {
          // `wchar_t w[3] = { L"ab" };` —— 同一条规则的宽版本。
          const vals = this.tryBracedStr(TOK_LSTR);
          if (vals !== null) {
            this.initWString(dest, off, ty, vals);
            return;
          }
        }
        return this.initBraced(dest, off, ty);
      }
      /* 标量外面套一层花括号是合法的：`int x = { 5 };`（C11 6.7.9 第 11 段）。 */
      this.next();
      this.initializer(dest, off, ty);
      if (this.tok === COMMA) this.next();
      this.skip(RBRACE);
      return;
    }
    if (isArray(ty.t)) this.err(`invalid initializer for '${typeText(ty)}'`);
    if (isStruct(ty.t)) {
      /* `struct P a = b;` —— 这不是聚合初始化器，是一次整块拷贝。 */
      if (dest.stat) this.err('initializer element is not constant');
      this.structCopy(sMem(ty, dest.addr, off), this.exprEq());
      return;
    }
    this.initScalar(dest, off, ty);
  }

  /**
   * 试着把 `{ "…" }` 整个读掉（第八刀第二十八片）。回并好的字节，不是这个形状就把
   * 记号**原样放回去**、回 null。宽的那一路（`{ L"…" }`）传 `TOK_LSTR`，回的是
   * 一串 wchar 的值。
   *
   * 不定长数组要它：`char a[] = { "abc" };` 的大小是 strlen + 1，而数格子那一遍
   * （`sizeFromInit`）会把这一整格数成 1 个元素。判「是不是这个形状」照 tcc
   * （`tccgen.c:8086`）：并完相邻的字面量之后下一格是 `}` 或 `,` 才算。
   */
  tryBracedStr(kind = TOK_STR) {
    if (this.tok !== LBRACE) return null;
    this.next();
    if (this.tok !== kind) {
      this.ungetWith(LBRACE, null);
      return null;
    }
    const merged = kind === TOK_LSTR
      ? this.readWStrTok(this.tokc) : this.readStrTok(this.tokc);
    if (this.tok === RBRACE || this.tok === COMMA) {
      if (this.tok === COMMA) this.next();
      this.skip(RBRACE);
      return merged;
    }
    /* 不是孤零零的一个字面量（`{ "xy" "z"[2], 0 }`）：把并好的串与那个 `{` 都放回去。 */
    this.ungetWith(kind, merged);
    this.ungetWith(LBRACE, null);
    return null;
  }

  /** 把当前记号推回输入、换上 `t`（`tokc` 一起换）。`ungetTok` 只管记号号。 */
  ungetWith(t, val) {
    this.cpp.ungetTok(t);
    this.cpp.tokc = val;
    this.tok = this.cpp.tok;
    this.tokc = this.cpp.tokc;
  }

  /**
   * 从 data 段里**读回**已经写好的字节（小端，回一个 bigint）。
   *
   * 静态初始化式里「值住在 data 段里」的那几格要它（第四十八片）：静态的复合字面量、
   * 拿另一个全局量当初始化式。没写过的字节是 0 —— 线性内存出生就是 0，与静态存储期的
   * 零初始化是同一件事。`pendingData` 是按追加顺序生效的，所以后写的盖前写的。
   */
  staticRead(addr, size) {
    const raw = new Array(size).fill(0);
    for (const d of this.pendingData) {
      const lo = Math.max(d.off, addr);
      const hi = Math.min(d.off + d.bytes.length, addr + size);
      for (let i = lo; i < hi; i++) raw[i - addr] = d.bytes[i - d.off];
    }
    let v = 0n;
    for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(raw[i] & 255);
    return v;
  }

  /** 最里面那一层：一个标量落地。静态写字节、自动发 store。 */
  initScalar(dest, off, ty) {
    if (dest.slot !== undefined) {
      this.vstore(sLval(ty, dest.slot, null), this.exprEq());
      return;
    }
    if (!dest.stat) {
      /* `vstore` 认得位域（`storeBitfield`），所以 `struct{int a:3;} x = {5};`
       * 在自动这一侧不用多写一行。 */
      this.vstore(sMem(ty, dest.addr, off), this.exprEq());
      return;
    }
    if (isBitfield(ty.t)) {
      /* 静态位域的初始化式（`struct { unsigned bit:1, bits31:31; } x = { .bit = 1 };`，
       * tcctest.c:1817，第四十五片）：同一个访问单元里的几个位域来自**好几条**初始化式，
       * 所以不能像别的标量那样「一格覆盖一格」—— 得按位并进同一块字节里去。 */
      const pos = bitPosOf(ty.t);
      const bits = bitSizeOf(ty.t);
      const acc = bfAccess(ty);
      const mask = (1n << BigInt(bits)) - 1n;
      const v = (BigInt.asUintN(64, this.constExpr()) & mask) << BigInt(pos);
      this.emitBitfield(dest.addr + off, typeSize(acc).size, v);
      return;
    }
    if (this.tok === TOK_STR) {
      /* `char *s = "abc";` —— 值是那个字面量在 data 段里的地址。真的目标文件里这是
       * 一条重定位；我们的「链接」是一个常量，所以它就是 8 个字节。
       *
       * 但只有**孤零零的一个字面量**才是这个意思：`"ab"[1]` 也以字符串开头，而它是
       * 一个整型常量表达式（第八刀第二十八片）。判法与 tcc 一样（`tccgen.c:8086`）——
       * 并完相邻的字面量之后看下一格。 */
      const bytes = this.readStrTok(this.tokc);
      if (this.tok === COMMA || this.tok === RBRACE || this.tok === SEMI) {
        if (!isPtr(ty.t)) this.err(`invalid initializer for '${typeText(ty)}'`);
        /* native（第二十八片）：这个字面量是 MIR 常量池里的一条，后端给它一个符号
         * （`omni_str_<ref>`），这儿只留一条「指着它」的记录。 */
        if (this.native) {
          this.putSymBytes(dest.addr + off, { kind: 's', no: this.strConst(bytes), add: 0n });
          return;
        }
        const addr = this.strData(bytes);
        this.emitBytes(dest.addr + off, 8, BigInt(addr));
        return;
      }
      /* 是个更大的表达式的开头：把并好的串放回去，交给常量求值器。 */
      this.ungetWith(TOK_STR, bytes);
    }
    if (this.tok === TOK_LSTR) {
      /* `wchar_t *p = L"ab";` —— 同一件事，指向的是宽串那一块。
       * `L"ab"[1]` 那种（下标）留给常量求值器。 */
      const vals = this.readWStrTok(this.tokc);
      if (this.tok === COMMA || this.tok === RBRACE || this.tok === SEMI) {
        if (!isPtr(ty.t)) this.err(`invalid initializer for '${typeText(ty)}'`);
        /* native（第三十三片）：那一块的地址要等链接，所以落成一笔重定位。 */
        if (this.native) {
          this.putSymBytes(dest.addr + off, { kind: 's', no: this.wstrConst(vals), add: 0n });
          return;
        }
        this.emitBytes(dest.addr + off, 8, BigInt(this.wstrData(vals)));
        return;
      }
      this.ungetWith(TOK_LSTR, vals);
    }
    if (isPtr(ty.t)) {
      /* 指针的静态初始化式：值是一个**地址常量**（C11 6.6 第 9 段）——
       * `int *rel1 = &reltab[1];` / `int *rel3 = reltab + 2;` / `char *p = "abc" + 1;`
       * （tcctest.c:2900 一带，第四十八片）。
       *
       * 这一格**借表达式一路**，而不是教常量求值器认全局量：指针算术要按元素大小缩放、
       * 数组要退化、`&s.f` 要加成员偏移 —— 这三件事表达式一路都已经会了，而常量求值器
       * 只认记号、没有类型。在一个用完就丢的函数里解析（与 `sizeof`、`&` 那两格同一
       * 手法），拿到的 ref 是常量就是那个地址；不是常量就是「初始化式不是常量」。 */
      const scratch = new MirFunc('$ptr', [], T_VOID);
      const outer = this.f;
      this.f = scratch;
      let k = null;
      let fix = null;
      try {
        const v = this.decay(this.exprEq());
        const kaddr = v.mem !== null ? this.kintOf(v.mem.addr) : null;
        if (kaddr !== null) {
          /* 值**住在 data 段里**、而地址是常量（静态的复合字面量 `(void*){…}`、
           * 另一个全局量）：把那几个字节读回来。tcc 在这一格也是从 section 里拷
           * （`init_putv` 的 `VT_LVAL` 那一支），而不是发一条 load。 */
          k = this.staticRead(Number(kaddr) + v.mem.off, typeSize(v.ty).size);
        } else {
          const ref = this.gv(this.castTo(v, ty));
          k = this.kintOf(ref);
          /* native（第二十八片）：算不出数的那一格里可能是「符号 + 加数」——
           * `&g`、`arr + 2`、`&s.f`、一个函数名。那不是「不是常量」，那是一条重定位。 */
          if (k === null && this.native) fix = this.symConstOf(scratch, ref);
          /* native（第三十四片）：**算出来了**也可能是一条重定位 —— 静态的复合字面量
           * 落在暂存区里，算出来的是那一块里的一个地址。 */
          if (k !== null && this.native) fix = this.anonFixOf(k);
        }
      } finally {
        this.f = outer;
      }
      if (fix !== null) {
        this.putSymBytes(dest.addr + off, fix);
        return;
      }
      if (k === null) this.err('initializer element is not constant');
      this.emitBytes(dest.addr + off, 8, k);
      return;
    }
    if (isFloat(ty.t)) {
      /* 静态的浮点初始化式：**在这儿就把它编码成 IEEE 754 的那几个字节**。
       * 整型那一侧写的是数值，这儿写的是位模式 —— 因为 data 段就是字节，
       * 而「浮点数怎么变成字节」是一张定死的表（`floatBits`），不是一次转换。 */
      const size = typeSize(ty).size;
      this.emitBytes(dest.addr + off, size, floatBits(this.constFloatExpr(), size));
      return;
    }
    this.emitBytes(dest.addr + off, typeSize(ty).size, this.constExpr());
  }

  /**
   * 字符串铺进 char 数组。`bytes` **不含**结尾的 0，那个 0 由这儿补。
   * `char s[3] = "abc"` 是合法的：装不下的那个结尾 0 直接丢掉（C11 6.7.9 第 14 段）——
   * 少这一条会把一个常见的写法判成错。
   */
  initString(dest, off, ty, bytes) {
    if (btype(ty.ref.t) !== VT_BYTE) {
      this.err(`array of '${typeText(ty.ref)}' cannot be initialized from a string`);
    }
    const n = ty.count < 0 ? bytes.length + 1 : ty.count;
    if (bytes.length > n) this.err('initializer-string is too long');
    const raw = [];
    for (let i = 0; i < n; i++) {
      raw.push(i < bytes.length ? bytes.charCodeAt(i) % 256 : 0);
    }
    if (dest.stat) {
      this.emitRaw(dest.addr + off, raw);
      return;
    }
    /* 自动这一侧一个字节一条 store。整块的 data 段那种「一次拷进去」要有一条
     * 把 data 搬到栈上的指令，MIR 没有 —— 而这里长度是编译期常量，摊开就完了。 */
    for (let i = 0; i < n; i++) {
      this.f.emit(OP.MSTORE, T_I32, dest.addr, this.mod.consts.i32(BigInt(raw[i])),
        memDesc(SK_I8, off + i));
    }
  }

  /**
   * 宽字符串铺进 `wchar_t` 数组（`wchar_t s[] = L"ab"`）。与 `initString` 同一条规则，
   * 只是一格四字节：装不下的那个结尾 0 照样可以丢（`wchar_t s[2] = L"ab"`）。
   */
  initWString(dest, off, ty, vals) {
    if (btype(ty.ref.t) !== VT_INT) {
      this.err(`array of '${typeText(ty.ref)}' cannot be initialized from a wide string`);
    }
    const n = ty.count < 0 ? vals.length + 1 : ty.count;
    if (vals.length > n) this.err('initializer-string is too long');
    for (let i = 0; i < n; i++) {
      const v = BigInt(i < vals.length ? vals[i] >>> 0 : 0);
      if (dest.stat) this.emitBytes(dest.addr + off + i * 4, 4, v);
      else {
        this.f.emit(OP.MSTORE, T_I32, dest.addr, this.mod.consts.i32(v),
          memDesc(SK_I32, off + i * 4));
      }
    }
  }

  /**
   * `{…}` 铺进聚合。数组与 struct/union **合成一份**，因为「省掉里层花括号」这条规则
   * （C11 6.7.9 第 20 段）是跨着两者的：`struct S a[2] = {1,2,3,4}` 一层是数组、
   * 一层是 struct，而「上一层没吃完的东西交给下一层接着吃」的走法只有一套。
   *
   * 做法是一个**下降栈**，不是递归：栈顶是「现在正在填的那一层」，每层记着类型、
   * 这一层在 dest 上的偏移、下一个要填的序号。
   *   - 要填的东西是聚合、而记号不是 `{` → 省了花括号，往里**下降**一层。
   *   - 一层填满 → 往外**回卷**一格（外层的序号 +1）。
   *   - 逗号**只由花括号那一层吃**。省花括号的层不碰分隔符，于是不存在「吃多了要还回去」
   *     那种回退 —— 一遍过的降级器里能不回退就别回退。
   *
   * 指定初始化器（`[3] =` / `.f =`）只作用在花括号那一层（C11 6.7.9 第 7 段说的
   * current object 就是它），所以碰到它先把下降出来的那些层全弹掉。
   *
   * 范围那种（`[0 ... 3] =`）只填**头一格**，剩下几格由 `initRange` 复制字节。
   */
  initBraced(dest, off, ty) {
    this.next();      // `{`
    const stack = [{ ty, off, i: 0 }];
    while (this.tok !== RBRACE) {
      if (this.tok === TOK_EOF) this.err("'}' expected");
      /* 串起来的指定初始化器（`.i.b = 3`）填完之后，**下一项从花括号那一层的下一格接着
       * 排** —— 也就是 `.i` 的后面那个成员，而不是 `.i.b` 的后面那个。这是照 tcc 的行为
       * 定的（`{ .i.b = 3, 4 }` 里的 4 进 `d`）；clang 与 gcc 把它放进 `i.c`，标准正文
       * 那一段（C11 6.7.9 第 17-18 段）两种读法都能站得住。oracle 是 tcc，所以跟 tcc。 */
      let chainAt = -1;
      let nb = 1;
      if (this.tok === LBRACK || this.tok === DOT) {
        while (stack.length > 1) stack.pop();
        nb = this.initDesignators(stack);
        if (stack.length > 1) chainAt = stack[0].i;
      }
      for (;;) {
        const el = this.initElem(stack[stack.length - 1]);
        if (this.tok === LBRACE) break;                          // 花括号写全了
        if (isArray(el.ty.t) && (this.tok === TOK_STR || this.tok === TOK_LSTR)) break;
        if (!isArray(el.ty.t) && !isStruct(el.ty.t)) break;       // 标量，到底了
        if (isStruct(el.ty.t) && el.ty.ref.fields === null) {
          this.err(`'${typeText(el.ty)}' is an incomplete type`);
        }
        stack.push({ ty: el.ty, off: el.off, i: 0 });
      }
      const lv = stack[stack.length - 1];
      const at = this.initElem(lv);
      const mark = this.pendingData.length;
      this.initializer(dest, at.off, at.ty);
      if (nb > 1) {
        this.initRange(dest, at.off, at.ty, nb, mark);
        lv.i += nb - 1;
      }
      this.initBump(lv);
      while (stack.length > 1 && this.initFull(stack[stack.length - 1])) {
        stack.pop();
        this.initBump(stack[stack.length - 1]);
      }
      if (chainAt >= 0) {
        while (stack.length > 1) stack.pop();
        stack[0].i = chainAt;
        this.initBump(stack[0]);
      }
      if (this.tok !== COMMA) break;
      this.next();
    }
    this.skip(RBRACE);
  }

  /**
   * 范围指定初始化器的后几格：把**头一格的字节**复制过去。
   *
   * tcc 也是复制字节、不是把初始化式再解析一遍（`tccgen.c:7768-7787`：把栈顶那个值
   * 当成一个 `elem_size` 大的 struct，反复 `init_putv` 出去）。这条选择是有观察差别的 ——
   * `int a[3] = { [0 ... 2] = f() }` 只叫一次 `f`。「把记号收下来放三遍」会叫三次，
   * 那是另一门语言，所以这里跟着 tcc 走。
   *
   * 静态那一侧要复制的就是刚追加进 `pendingData` 的那几条（`mark` 之后），偏移整体挪
   * 一格；自动那一侧是 load + store，与 `structCopy` 同一手法。整块清零在前面已经做过，
   * 所以头一格没写到的那些字节是 0，一起复制过去正好。
   */
  initRange(dest, off, ty, nb, mark) {
    const size = typeSize(ty).size;
    if (size === 0) return;
    if (dest.stat) {
      /* 只挪**落在这一格里**的那几条。`[0 ... 1] = "BB"` 除了那个指针，还往 data 段
       * 另一处写了字符串本身 —— 那一块是共享的，跟着挪就会踩别人。 */
      const lo = dest.addr + off;
      const fresh = this.pendingData.slice(mark)
        .filter((d) => d.off >= lo && d.off + d.bytes.length <= lo + size);
      /* 初值里的地址（第二十八片）也要跟着复制 —— 落在这一格里的那几条。
       * 按**偏移**挑而不是按 `mark` 挑：这一格是刚清零刚写的，别人的地址不会落在里面。
       * 漏掉这一句的症状是 `char *gs[4] = {[0 ... 1] = "BB"}` 的第二格是空指针。 */
      const freshFix = this.pendingFix.filter((x) => x.off >= lo && x.off + 8 <= lo + size);
      for (let k = 1; k < nb; k++) {
        for (const d of fresh) {
          this.pendingData.push({ off: d.off + k * size, bytes: d.bytes });
        }
        for (const x of freshFix) {
          this.pendingFix.push({ off: x.off + k * size, kind: x.kind, no: x.no, add: x.add });
        }
      }
      return;
    }
    const f = this.f;
    for (let k = 1; k < nb; k++) {
      for (let done = 0; done < size;) {
        const left = size - done;
        const w = left >= 8 ? 8 : left >= 4 ? 4 : left >= 2 ? 2 : 1;
        const mt = w === 8 ? T_I64 : T_I32;
        const r = f.emit(OP.MLOAD, mt, dest.addr, REF_NONE,
          memDesc(COPY_MK[w], off + done));
        f.emit(OP.MSTORE, mt, dest.addr, r,
          memDesc(COPY_SK[w], off + k * size + done));
        done += w;
      }
    }
  }

  /** 填完一格：序号 +1。union 例外 —— 它只初始化**一个**成员（C11 6.7.9 第 17 段），
   *  所以直接跳到「满」，后面再来东西就是 excess 而不是悄悄盖掉第一个。 */
  initBump(lv) {
    lv.i++;
    if (isUnion(lv.ty.t)) lv.i = lv.ty.ref.fields.length;
  }

  /** 这一层填满了吗（不定长数组永远没满，它的长度是数出来的）。 */
  initFull(lv) {
    if (isArray(lv.ty.t)) return lv.ty.count >= 0 && lv.i >= lv.ty.count;
    return lv.i >= lv.ty.ref.fields.length;
  }

  /** 这一层的第 `i` 格是什么类型、在哪儿。满了还要就是 excess。 */
  initElem(lv) {
    if (isArray(lv.ty.t)) {
      if (lv.ty.count >= 0 && lv.i >= lv.ty.count) {
        this.err('excess elements in array initializer');
      }
      return { ty: lv.ty.ref, off: lv.off + lv.i * typeSize(lv.ty.ref).size };
    }
    const fields = lv.ty.ref.fields;
    if (fields === null) this.err(`'${typeText(lv.ty)}' is an incomplete type`);
    if (lv.i >= fields.length) {
      this.err(`excess elements in ${isUnion(lv.ty.t) ? 'union' : 'struct'} initializer`);
    }
    const fd = fields[lv.i];
    return { ty: fd.ty, off: lv.off + fd.off };
  }

  /**
   * 一串指定初始化器（`[3] =` / `.f =` / 串起来的 `.a.b =`、`[1][2] =`，C99 6.7.9 第 6 段）。
   *
   * 它作用在**花括号那一层**的 current object 上，所以调用方已经把省花括号下降出来的层
   * 全弹掉了。串起来的那种就是「挪一格之后再往里下降一层，接着挪」—— 于是它与省花括号
   * 用的是同一个下降栈，`initBraced` 的回卷那一步一行都不用改。
   *
   * `[0 ... 3] =` 是范围（GNU 扩展，`tccgen.c:7696-7710`）：回**这一串管几格**，
   * 调用方据此复制字节、并把序号一次挪过去。范围只许出现在**最后一个**指定符上
   * （tcc 那边是 `while (nb_elems == 1 && …)` 这个循环条件），后面必须是 `=`。
   */
  initDesignators(stack) {
    for (;;) {
      const lv = stack[stack.length - 1];
      if (this.tok === LBRACK) {
        if (!isArray(lv.ty.t)) this.err('array index in non-array initializer');
        this.next();
        const k = Number(this.constExpr());
        let last = k;
        if (this.tok === TOK_DOTS) {
          this.next();
          last = Number(this.constExpr());
        }
        this.skip(RBRACK);
        /* tcc 的那一条检查（`tccgen.c:7703`）把三件事合成一句话：负下标、越界、空范围。
         * 长度未知的那种（`int a[] = {[3]=1}`）现在还走不到这儿（`sizeFromInit` 里
         * 有一条明写的 todo），所以只在长度已知时比上界。 */
        if (k < 0 || last < k || (lv.ty.count >= 0 && last >= lv.ty.count)) {
          this.err('index exceeds array bounds or range is empty');
        }
        lv.i = k;
        if (last > k) {
          this.skip(ASSIGN);
          return last - k + 1;
        }
      } else if (this.tok === DOT) {
        if (!isStruct(lv.ty.t)) this.err('field name not in record or union initializer');
        this.next();
        const nm = this.identName();
        const k = lv.ty.ref.fields.findIndex((x) => x.name === nm);
        if (k < 0) this.err(`'${typeText(lv.ty)}' has no member named '${nm}'`);
        lv.i = k;
      } else {
        this.skip(ASSIGN);
        return 1;
      }
      if (this.tok !== LBRACK && this.tok !== DOT) continue;
      const el = this.initElem(lv);
      if (!isArray(el.ty.t) && !isStruct(el.ty.t)) {
        this.err(`cannot designate into '${typeText(el.ty)}'`);
      }
      stack.push({ ty: el.ty, off: el.off, i: 0 });
    }
  }

  /**
   * 把一块内存清零。聚合的初始化式**只覆盖写出来的那些**，剩下的按 C 要零
   * （C11 6.7.9 第 21 段）。静态那一侧免费（线性内存出生就是 0），自动这一侧要发指令。
   *
   * 先整块清零、再写给出的那些 —— 而不是「算出哪些没被覆盖再补零」。后者省几条指令，
   * 但要在指定初始化器与嵌套之下维护一张「覆盖到哪儿了」的表，那张表是错误的温床。
   */
  autoZero(addr, off, size) {
    const f = this.f;
    for (let done = 0; done < size;) {
      const left = size - done;
      const w = left >= 8 ? 8 : left >= 4 ? 4 : left >= 2 ? 2 : 1;
      const mt = w === 8 ? T_I64 : T_I32;
      const zero = w === 8 ? this.mod.consts.int(0n) : this.mod.consts.i32(0n);
      f.emit(OP.MSTORE, mt, addr, zero, memDesc(COPY_SK[w], off + done));
      done += w;
    }
  }

  /**
   * `int a[] = {…}` / `char s[] = "…"` 的长度由初始化式定（C11 6.7.9 第 22 段）。
   *
   * 一遍过时这是个鸡生蛋：要先知道长度才能划地方，而长度写在后面。tcc 的办法是把
   * 初始化式的记号收下来先跑一遍「只数大小」（`decl_initializer_alloc`），这里也一样。
   *
   * 数的那一遍**用真的语法分析器**（第四十一片起改的）：把收下来的记号放一遍，走
   * `initBraced` 那同一套下降栈与指定初始化器，只是每一项的值整段跳掉、什么都不落地。
   * 原先是生扫记号数逗号 —— 那样数不了 `[3] = 1` 这种指定初始化器（下标是个常量
   * **表达式**，得真的求值），而指定初始化器恰恰是「长度由初始化式定」的常客
   * （`char const *const t[] = { [0 ... 1] = "BB" }`，tcctest.c:1474）。
   *
   * 回 `{ ty, body }`：body 非 null 时调用方要用 `replayBraced` 把它放一遍。
   */
  sizeFromInit(ty) {
    if (this.tok !== LBRACE) this.err(`array size missing`);
    const body = this.cpp.captureBraced();
    let n = 0;
    this.replayBraced(body, () => { n = this.countBraced(ty); });
    return { ty: mkArray(ty.ref, n), body };
  }

  /**
   * struct 的最后一个成员是不是**柔性数组**（`int b[];`，count < 0）。回那个成员，
   * 不是就回 null。union 不算（tcc 的 `u == VT_STRUCT` 那个条件）。
   */
  flexField(ty) {
    if (!isStruct(ty.t) || isUnion(ty.t)) return null;
    const fs = ty.ref === null ? null : ty.ref.fields;
    if (fs === null || fs.length === 0) return null;
    const f = fs[fs.length - 1];
    if (!isArray(f.ty.t) || !(f.ty.count < 0)) return null;
    return f;
  }

  /**
   * 柔性数组成员配初始化式时**要多划几个字节**（第六十二片）。
   *
   * `sizeof` 不变（还是不含柔性成员的那个数），但那块地方得真的够大 —— 否则后面那个
   * 全局量就被压在同一段字节上。tcc 在 `decl_initializer_alloc` 里也是分两步：
   * 先 `DIF_SIZE_ONLY` 干跑一遍把柔性成员的格数算出来，再
   * `size += flexible_array->type.ref->c * pointed_size(...)`（`tccgen.c:8336-8340`），
   * 跑完还把那个格数改回 -1，好让后面同样的声明重新算。
   *
   * 我们这儿量的是「初始化式碰到的最大字节偏移」，同一个数、少一处状态。
   * 回 `{ extra, body }` —— body 要由调用方 `replayBraced` 放一遍。
   */
  flexInit(ty) {
    const body = this.cpp.captureBraced();
    let end = 0;
    this.replayBraced(body, () => { end = this.measureBraced(ty); });
    const size = typeSize(ty).size;
    return { extra: end > size ? end - size : 0, body };
  }

  /**
   * 量一个 `{…}` 碰到的最大字节偏移（只量，不落地）。走法与 `countBraced` 同一份，
   * 差别是记的东西：那边记「顶层第几格」，这边记「到哪个字节为止」。
   */
  measureBraced(ty) {
    this.next();      // `{`
    const stack = [{ ty, off: 0, i: 0 }];
    let end = 0;
    while (this.tok !== RBRACE) {
      if (this.tok === TOK_EOF) this.err("'}' expected");
      let chainAt = -1;
      let nb = 1;
      if (this.tok === LBRACK || this.tok === DOT) {
        while (stack.length > 1) stack.pop();
        nb = this.initDesignators(stack);
        if (stack.length > 1) chainAt = stack[0].i;
      }
      for (;;) {
        const el = this.initElem(stack[stack.length - 1]);
        if (this.tok === LBRACE) break;
        if (isArray(el.ty.t) && (this.tok === TOK_STR || this.tok === TOK_LSTR)) break;
        if (!isArray(el.ty.t) && !isStruct(el.ty.t)) break;
        if (isStruct(el.ty.t) && el.ty.ref.fields === null) {
          this.err(`'${typeText(el.ty)}' is an incomplete type`);
        }
        stack.push({ ty: el.ty, off: el.off, i: 0 });
      }
      const lv = stack[stack.length - 1];
      const at = this.initElem(lv);
      /* 到底的那一格是**没写长度的数组**（也就是那个柔性成员）时，`typeSize` 回 0，
       * 量不出东西来 —— 所以这一格自己数：花括号那一种交给 `countBraced`，
       * 字符串那一种就是「字节数 + 1」。别的照 `typeSize` 算。 */
      let span = typeSize(at.ty).size;
      if (isArray(at.ty.t) && at.ty.count < 0) {
        const es = typeSize(at.ty.ref).size;
        if (this.tok === LBRACE) {
          span = this.countBraced(at.ty) * es;
        } else if (this.tok === TOK_STR) {
          span = (this.readStrTok(this.tokc).length + 1) * es;
        } else if (this.tok === TOK_LSTR) {
          span = (this.readWStrTok(this.tokc).length + 1) * es;
        } else {
          this.skipInitItem();
        }
      } else {
        this.skipInitItem();
      }
      if (at.off + span > end) end = at.off + span;
      if (nb > 1) lv.i += nb - 1;
      this.initBump(lv);
      while (stack.length > 1 && this.initFull(stack[stack.length - 1])) {
        stack.pop();
        this.initBump(stack[stack.length - 1]);
      }
      if (chainAt >= 0) {
        while (stack.length > 1) stack.pop();
        stack[0].i = chainAt;
        this.initBump(stack[0]);
      }
      if (this.tok !== COMMA) break;
      this.next();
    }
    this.skip(RBRACE);
    return end;
  }

  /**
   * 数一个 `{…}` 顶层有几格（只数，不落地）。
   *
   * 与 `initBraced` 是同一份走法 —— 同一个下降栈、同一个 `initDesignators`、
   * 同一条回卷规则，差别只有两处：每一项的值用 `skipInitItem` 整段跳掉，
   * 以及顶层那一层的长度是未知的（`count = -1`，于是它永远填不满）。
   *
   * 长度是**见过的最大格号**，不是「格数」：指定初始化器可以往回跳
   * （`{ [4] = 5, [0] = 1 }` 的长度是 5）。
   */
  countBraced(ty) {
    this.next();      // `{`
    const stack = [{ ty: mkArray(ty.ref, -1), off: 0, i: 0 }];
    let n = 0;
    while (this.tok !== RBRACE) {
      if (this.tok === TOK_EOF) this.err("'}' expected");
      let chainAt = -1;
      let nb = 1;
      if (this.tok === LBRACK || this.tok === DOT) {
        while (stack.length > 1) stack.pop();
        nb = this.initDesignators(stack);
        if (stack.length > 1) chainAt = stack[0].i;
      }
      for (;;) {
        const el = this.initElem(stack[stack.length - 1]);
        if (this.tok === LBRACE) break;
        if (isArray(el.ty.t) && (this.tok === TOK_STR || this.tok === TOK_LSTR)) break;
        if (!isArray(el.ty.t) && !isStruct(el.ty.t)) break;
        if (isStruct(el.ty.t) && el.ty.ref.fields === null) {
          this.err(`'${typeText(el.ty)}' is an incomplete type`);
        }
        stack.push({ ty: el.ty, off: el.off, i: 0 });
      }
      const lv = stack[stack.length - 1];
      this.initElem(lv);              // 越界那一条检查照旧
      this.skipInitItem();
      if (nb > 1) lv.i += nb - 1;
      this.initBump(lv);
      while (stack.length > 1 && this.initFull(stack[stack.length - 1])) {
        stack.pop();
        this.initBump(stack[stack.length - 1]);
      }
      if (chainAt >= 0) {
        while (stack.length > 1) stack.pop();
        stack[0].i = chainAt;
        this.initBump(stack[0]);
      }
      /* 还停在里层就说明顶层那一格填了一半 —— 半格也算一格
       * （`int a[][2] = {1,2,3}` 是 2）。 */
      const seen = stack[0].i + (stack.length > 1 ? 1 : 0);
      if (seen > n) n = seen;
      if (this.tok !== COMMA) break;
      this.next();
    }
    this.skip(RBRACE);
    return n;
  }

  /** 数格子那一遍里，把当前这一项的记号整段跳掉（到顶层的 `,` 或 `}` 为止）。 */
  skipInitItem() {
    let depth = 0;
    for (;;) {
      if (this.tok === TOK_EOF) this.err("'}' expected");
      if (depth === 0 && (this.tok === COMMA || this.tok === RBRACE)) return;
      if (this.tok === LPAR || this.tok === LBRACK || this.tok === LBRACE) depth++;
      else if (this.tok === RPAR || this.tok === RBRACK || this.tok === RBRACE) depth--;
      this.next();
    }
  }

  /**
   * 把收好的 `{…}` 放一遍。与函数体那两遍（`finishFunc`）同一手法、同一理由：
   * 一遍过没法后看，只能把记号留着再走一次。
   */
  replayBraced(body, fn) {
    const afterTok = this.cpp.tok;
    const afterVal = this.cpp.tokc;
    this.cpp.pushTokens(body);
    this.next();
    fn();
    if (this.tok !== TOK_EOF) this.err('internal: 初始化式没读完');
    this.cpp.endMacro();
    this.cpp.tok = afterTok;
    this.cpp.tokc = afterVal;
    this.tok = afterTok;
    this.tokc = afterVal;
  }

  /**
   * 复合字面量 `(T){…}`（C11 6.5.2.5，第八刀第四十片）。回一个**左值** ——
   * 它是一个真的对象，有地址（`&(struct S){1,2}` 是合法的）。
   *
   * 存储期按它写在哪儿分（第 5 段）：函数里是自动的（这一层块结束就没了），
   * 文件作用域上是静态的。于是这一格与 `decl` 里那一段几乎一样，只差「没有名字」——
   * 划地方、跑一遍 `initializer`、把那块内存当左值交出去。
   *
   * 我们的帧不回收（见 `finishFunc` 头上「平铺的帧」），所以「这一层块结束就没了」
   * 在我们这儿只体现为「谁都不会再引用它」—— 循环里的复合字面量每一圈是同一块内存，
   * 而 C 也允许这样（同一个块里那个对象只有一个）。
   */
  compoundLiteral(ty) {
    let vty = ty;
    let body = null;
    let strBytes = null;
    let wstrVals = null;
    if (isArray(vty.t) && vty.count < 0) {
      /* `(char []){ "abcd" }` —— 花括号裹着一个字面量，长度是 strlen + 1（**不是**
       * 「1 个元素」）。与 `char a[] = { "abc" };` 是同一格（第二十八片）。 */
      if (btype(vty.ref.t) === VT_BYTE && (strBytes = this.tryBracedStr()) !== null) {
        vty = mkArray(vty.ref, strBytes.length + 1);
      } else if (btype(vty.ref.t) === VT_INT
        && (wstrVals = this.tryBracedStr(TOK_LSTR)) !== null) {
        vty = mkArray(vty.ref, wstrVals.length + 1);
      } else {
        /* `(int []){3,2,1}` —— 长度由初始化式定，与 `int a[] = {…}` 同一段代码。 */
        const r = this.sizeFromInit(vty);
        vty = r.ty;
        body = r.body;
      }
    }
    this.needComplete('compound literal', vty);
    /* 文件作用域：静态存储期，落在 data 段里。这一路没有 `this.f`，也发不出指令 ——
     * 初始化式里必须全是常量，而 `initializer` 的静态那一侧正是这么要求的。 */
    if (this.scopes.length <= 1) {
      const e = { ty: vty, addr: -1, defined: true, used: true, align: 0 };
      this.allocGlobal(e);
      /* native（第三十四片）：这一块要成为数据段里一个**匿名的**符号。名字按出现顺序
       * 编，于是「同一份输入两次编译逐字节相同」照旧成立。地址照旧是暂存区里那个数 ——
       * 下面 `initializer` 的一整套（含 `staticRead` 把字节读回来那一格）一字不改，
       * 而「那个数其实是一个符号加偏移」这件事由 `anonFixOf` 在写指针时补上。 */
      if (this.native) {
        const s = typeSize(vty);
        const name = `$cl$${this.anonStatics.length}`;
        this.anonStatics.push({
          name, gno: this.mod.globalNo(name), addr: e.addr, size: s.size, align: s.align,
        });
      }
      const dest = { stat: true, addr: e.addr };
      if (strBytes !== null) this.initString(dest, 0, vty, strBytes);
      else if (wstrVals !== null) this.initWString(dest, 0, vty, wstrVals);
      else if (body !== null) this.replayBraced(body, () => this.initializer(dest, 0, vty));
      else this.initializer(dest, 0, vty);
      return sMem(vty, this.mod.consts.int(BigInt(e.addr)), 0);
    }
    const off = this.frameAlloc(vty);
    const dest = { stat: false, addr: this.fpRef };
    /* 花括号只覆盖写出来的那些，剩下的按 C 要是 0 —— 与 `decl` 里那一格同一条理由。 */
    this.autoZero(this.fpRef, off, typeSize(vty).size);
    if (strBytes !== null) this.initString(dest, off, vty, strBytes);
    else if (wstrVals !== null) this.initWString(dest, off, vty, wstrVals);
    else if (body !== null) this.replayBraced(body, () => this.initializer(dest, off, vty));
    else this.initializer(dest, off, vty);
    return sMem(vty, this.fpRef, off);
  }

  /** `unary`（`tccgen.c:5595`）。前缀与后缀都在这儿，与 tcc 一样。 */  unary() {
    const t = this.tok;
    /* `sizeof (` 的那一次标记（见 `sizeofType`）。一次性：取下来就清掉，于是里层的
     * 括号是普通括号 —— tcc 那边是「换掉那一个记号」，效果一样。 */
    const soType = this.soType;
    this.soType = false;

    /* `__func__` 与 `__FUNCTION__`（`tccgen.c:5656-5666`）：tcc 把记号**换成**一个
     * TOK_STR、内容是 `funcname`，再落到字符串那一支 —— 于是它的类型是 `char[N+1]`、
     * 相邻字面量照样拼、`sizeof(__func__)` 是名字长度加一。我们照这个次序办。 */
    if (t === TOK___FUNC__ || t === TOK___FUNCTION__) {
      this.next();
      let s = this.funcName;
      while (this.tok === TOK_STR) {
        s += String(this.tokc);
        this.next();
      }
      return this.postfix(this.strLit(s));
    }

    /* `&&label`（GNU 的「标签当值」）：一个 `void *`，值是那个标签的编号。
     * 词法上它就是 `&&` 那个记号 —— 一元位置上的 `&&` 只可能是这个意思。 */
    if (t === TOK_LAND) {
      this.next();
      const name = this.identName();
      const pv = mkPointer(TY_VOID);
      return this.postfix(sVal(pv, this.konst(pv, BigInt(this.labelValue(name)))));
    }

    // 带值的记号：整数与字符常量。`next()` 会毁掉 tokc，所以先取（`tccgen.c:7185`）
    if (tokHasValue(t)) {
      const cv = this.tokc;
      if (t === TOK_CFLOAT || t === TOK_CDOUBLE || t === TOK_CLDOUBLE) {
        /* 浮点字面量。`tokc` 在这一格是宿主的 number（`parseNumber` 那边算好的，
         * `f` 后缀已经 fround 过），所以这里只是挑类型再进常量池。
         * `1.5L` 的类型是 `long double` —— 在这个目标上它与 double 同一个表示，
         * 但类型要留着（`sizeof`、`_Generic` 那些看的是类型不是表示）。 */
        this.next();
        const fty = t === TOK_CFLOAT ? TY_FLOAT : t === TOK_CDOUBLE ? TY_DOUBLE : TY_LDOUBLE;
        return this.postfix(sVal(fty, this.fkonst(fty, /** @type {number} */ (cv))));
      }
      if (t === TOK_LSTR) return this.postfix(this.wstrLit(this.readWStrTok(cv)));
      if (t === TOK_STR) return this.postfix(this.strLit(this.readStrTok(cv)));
      this.next();
      /* 字面量的类型由后缀定（`parseNumber` 已经按 tcc 的规则挑好了记号号）。
       * `'a'` 在 C 里是 **int**，不是 char —— 这一格错了 `sizeof('a')` 就是 1 而不是 4。
       * `L'a'` 也是 int（`tccgen.c:5614` 那一支在非 PE 目标上就落到 `t = VT_INT`）。 */
      let ty = TY_INT;
      if (t === TOK_CUINT) ty = TY_UINT;
      else if (t === TOK_CLLONG || t === TOK_CLONG) ty = TY_LLONG;
      else if (t === TOK_CULLONG || t === TOK_CULONG) ty = TY_ULLONG;
      const bits = intBitsOf(ty);
      const n = isUnsigned(ty.t)
        ? BigInt.asUintN(bits, /** @type {bigint} */ (cv))
        : BigInt.asIntN(bits, /** @type {bigint} */ (cv));
      return this.postfix(sVal(ty, this.konst(ty, n)));
    }

    if (t === LPAR) {
      this.next();
      /* 强制转换 `(int)x` 与括号表达式在这儿分岔（`tccgen.c:5620`）。 */
      if (this.isTypeStart(this.tok)) {
        const ty = this.typeName();
        this.skip(RPAR);
        /* `(T){…}` 是**复合字面量**，不是强制转换（第八刀第四十片）。两者在语法上只差
         * `)` 后面跟的是 `{` 还是一个表达式，所以这一问要摆在转换前面 ——
         * `sizeof((int[]){1,2,3})` 于是也走这一路（12，而不是「int[] 的大小」）。 */
        if (this.tok === LBRACE) return this.postfix(this.compoundLiteral(ty));
        /* `sizeof (类型名)`：只要类型，**不进后缀循环** —— `sizeof(int)[0]` 不是
         * 「int 数组的第 0 项」，它就是个语法错。 */
        if (soType) return sVal(ty, REF_NONE);
        return this.castTo(this.unary(), ty);
      }
      /* GNU 的语句表达式 `({ …; x; })`（`tccgen.c:5715`）。 */
      if (this.tok === LBRACE) {
        const v = this.stmtExpr();
        this.skip(RPAR);
        return this.postfix(v);
      }
      const v = this.gexpr();
      this.skip(RPAR);
      return this.postfix(v);
    }

    if (t === PLUS) {
      // 一元 `+` 只做整型提升（不是空操作：`+(char)x` 的类型是 int）
      this.next();
      return this.promote(this.unary());
    }
    if (t === MINUS) {
      this.next();
      const v = this.promote(this.unary());
      return sVal(v.ty, this.f.emit(OP.NEG, mirTypeOf(v.ty), this.gv(v), REF_NONE, 0));
    }
    if (t === TILDE) {
      this.next();
      const v = this.promote(this.unary());
      // `~` 的操作数必须是整型（C11 6.5.3.3 第 4 段）；浮点在这儿拦，
      // 否则 `BNOT` 拿到一个 f64 会变成 verifier 的内部错
      if (!isInteger(v.ty.t)) this.err(`invalid type argument of unary '~' ('${typeText(v.ty)}')`);
      return sVal(v.ty, this.f.emit(OP.BNOT, mirTypeOf(v.ty), this.gv(v), REF_NONE, 0));
    }
    if (t === BANG) {
      /* `!x` 就是 `x == 0`（tcc 也走比较那条路）。于是 `if (!x)` 一条 EQ 就够，
       * 不必先把 x 变成 bool 再取反。结果类型是 `int`。 */
      this.next();
      const v = this.unary();
      const r = this.gv(v);
      return sCmp(this.f.emit(OP.EQ, mirTypeOf(v.ty), r, this.konst(v.ty, 0), 0));
    }
    if (t === TOK_INC || t === TOK_DEC) {
      // `++x` = `x += 1`（`tccgen.c:5680`：inc(0, tok)）
      this.next();
      const target = this.unary();
      return this.incdec(target, t === TOK_INC ? PLUS : MINUS, false);
    }
    if (t === AMP) {
      this.next();
      const v = this.unary();
      /* `&a`（a 是数组）的类型是「指向数组的指针」，不是「指向元素的指针」——
       * 两者的**值**相同，但 `sizeof(*&a)` 差一个数量级。所以这里不退化。
       * 函数也走这一条：`&f` 与 `f` 的值一模一样（C11 6.5.3.2 第 3 段），
       * 而 `addrOf` 对函数指示符回的就是那个函数指针值。 */
      return sVal(mkPointer(v.ty), this.addrOf(v));
    }
    if (t === STAR) {
      this.next();
      const v = this.decay(this.unary());
      if (!isPtr(v.ty.t)) this.err(`invalid type argument of unary '*' ('${typeText(v.ty)}')`);
      const et = v.ty.ref;
      if (btype(et.t) === VT_VOID) this.err("dereferencing 'void *'");
      /* `*p` 是一个**内存左值**：地址是 p 的值，静态偏移 0。于是 `*p = 5` 与 `p[0] = 5`
       * 走的是同一条 vstore，一条 MSTORE，没有中间的临时。 */
      return this.postfix(sMem(et, this.gv(v), 0));
    }
    if (t === TOK_SIZEOF) {
      this.next();
      return this.sizeofExpr();
    }
    /* `__alignof__` / `__alignof` / `_Alignof`（第三十五片，`tccgen.c:5789`）。
     * 与 `sizeof` 同一支（同一个「类型名或者表达式」的读法），只是回的数不同。 */
    if (t === TOK_ALIGNOF1 || t === TOK_ALIGNOF2 || t === TOK_ALIGNOF3) {
      this.next();
      return this.alignofExpr();
    }
    /* 变参那四个内建。它们**不是函数**（`va_arg` 的第二个实参是个类型名，函数写不出来），
     * 所以与 tcc 一样在这儿按记号号认出来（`tccgen.c:5943` 一带的 arm64 那一支）。
     * 位置必须在下面那条「标识符」之前 —— 它们的记号号在 `TOK_UIDENT` 之后
     * （tcc 也是：`int __builtin_expect;` 是合法 C，所以它们不是关键字）。 */
    if (t === TOK_BUILTIN_VA_START || t === TOK_BUILTIN_VA_ARG
      || t === TOK_BUILTIN_VA_END || t === TOK_BUILTIN_VA_COPY) {
      return this.vaBuiltin(t);
    }
    /* `__builtin_expect(x, c)`：分支预测的提示，在 tcc 那边就是**空操作**
     * （`tccgen.c:5811`：`parse_builtin_params(0, "ee"); vpop();`）—— 两个操作数都
     * 求值，只留左边那个。tinycc 自己的源码里在用它。 */
    if (t === TOK_BUILTIN_EXPECT) {
      this.next();
      this.skip(LPAR);
      const v = this.exprEq();
      this.skip(COMMA);
      this.exprEq();
      this.skip(RPAR);
      return this.postfix(v);
    }
    /* `__builtin_types_compatible_p(T1, T2)`（`tccgen.c:5816`）：一个**编译期**的问句 ——
     * 两个**类型名**（不是表达式），相容就是 1。tcc 把两边最外层的 `const`/`volatile`
     * 抹掉再问 `is_compatible_types`，也就是 `compareTypes(a, b, 1)`：与赋值问的是同一句，
     * 所以这一片不新写「什么算一样」，只是把那一句接出来。值是常量（`vpushi(n)`）。 */
    if (t === TOK_BUILTIN_TYPES_COMPATIBLE_P) {
      this.next();
      this.skip(LPAR);
      const a = this.typeName();
      this.skip(COMMA);
      const b = this.typeName();
      this.skip(RPAR);
      /* 只有一边是枚举时问的是**那个枚举的底层类型**（`compareTypes` 第一段就把枚举
       * 换成它的底层位）—— 第五十九片把底层类型真的算出来之后，这一问不再需要那条
       * 「只有一边是枚举就报错」的边界：全非负的枚举与 `unsigned int` 相容。 */
      return this.postfix(sVal(TY_INT, this.konst(TY_INT, compareTypes(a, b, 1) ? 1 : 0)));
    }

    if (t >= TOK_UIDENT) {
      const name = this.identName();
      const local = this.lookup(name);
      if (local !== null) return this.postfix(this.entryLval(name, local));
      /* 枚举常量是**普通标识符**，所以查在这一格：局部量之后（局部量能遮蔽它），
       * 全局量之前。它不是左值 —— `A = 1` 该报错，而 `sVal` 天然不是左值。 */
      const ec = this.ecLookup(name);
      if (ec !== undefined) {
        return this.postfix(sVal(ec.ty, this.konst(ec.ty, ec.val)));
      }
      const gv = this.gvars.get(name);
      if (gv !== undefined) return this.postfix(this.gvarLval(gv));
      /* 既不是局部量也不是全局量：那就只能是函数。tcc 在这里走 `external_global_sym`
       * （`tccgen.c:1143`）建一个待重定位的符号，我们同样先建 —— 但只在紧跟着 `(`
       * 时才算调用，否则是「取函数地址」，那要函数指针。 */
      if (this.tok !== LPAR) {
        /* 函数名不跟着 `(` 就是「函数指示符」（C11 6.3.2.1 第 4 段：它退化成指针）。
         * 表示成一个**内存左值**：类型是函数类型，「地址」是那个函数指针值 ——
         * 与 `*fp` 得到的东西一模一样，于是 `f`、`&f`、`*f`、`(*f)(x)`、`f(x)` 五种写法
         * 走的都是同一条路，一个特例都不用写（`gv` / `decay` / `addrOf` 各一行）。 */
        const fn = this.funcs.get(name);
        if (fn === undefined || !fn.declared) this.err(`'${name}' undeclared`);
        fn.used = true;
        /* 函数指针的**值**：线性内存那条腿上是「函数号 + 1」（一个只有解释器认得的小
         * 整数，`CALLI` 按它查表）；native 上是那个符号的**真地址**，靠一条 `FADDR`
         * （第二十七片）。两边随后都归一成「函数类型 + 一个指针值」这一个形状，于是
         * `f`、`&f`、`*f`、`(*f)(x)` 四种写法照旧一条路走完。
         *
         * 一个例外要明着拒：**外部的变参函数**（`pf *fp = printf;`）。native 上变参外部
         * 符号没有桩（桩装不下「实参个数各不相同」的调用点，第二十二片），于是我们的
         * `.o` 里那个名字只剩一条 `RET` —— 取它的地址会拿到一个什么都不做的函数。
         * 要做对得让「没有函数体的名字」在目标文件里变成**未定义符号**，那是下一片。 */
        /* 一个例外：**外部的变参函数**（`pf *fp = printf;`）。native 上变参外部符号
         * 没有桩（桩装不下「实参个数各不相同」的调用点，第二十二片），于是我们的 `.o`
         * 里那个名字只剩一条 `RET` —— 取它的地址会拿到一个什么都不做的函数。
         * 要取的是**真 libc 里那个符号**的地址，而那个符号在这个 `.o` 里是未定义的，
         * 于是与「住在 dylib 里的外部全局量」是同一件事：过 GOT（第三十一片）。
         * 所以登记一个同名的外部全局量，地址就是一条 `GADDR`（第三十五片）。
         * 大小写 8 只是占个形状 —— 这一格从来只取地址，一个字节都不读写。 */
        let fptr;
        if (this.native && fn.variadic && !fn.defined) {
          const gno = this.mod.globalNo(name);
          if (this.mod.globalBlob[gno] === null) this.mod.setGlobalExtern(gno, 8, 8);
          fptr = this.f.emit(OP.GADDR, T_I64, REF_NONE, REF_NONE, gno);
        } else {
          fptr = this.native
            ? this.f.emit(OP.FADDR, T_I64, REF_NONE, REF_NONE, fn.no)
            : this.mod.consts.int(fnPtr(fn.no));
        }
        return this.postfix(sMem(funcTypeOf(fn), fptr, 0));

      }
      return this.postfix(this.funcCall(name));
    }

    if (t < TOK_IDENT) this.expect('expression');
    // 关键字落到这儿：`int` 之类出现在表达式位置
    this.err(`unexpected keyword '${this.cpp.tokStr(t, null)}' in expression`);
    return sVal(TY_VOID, REF_NONE);
  }

  /**
   * `sizeof`。两种写法：`sizeof(类型名)` 与 `sizeof 表达式`。
   *
   * 后者要「算出类型但**不求值**」—— tcc 用全局的 `nocode_wanted` 计数器
   * （`tccgen.c` 到处在加减它）。这里的等价物是**把 `this.f` 换成一个用完就丢的
   * MirFunc**：表达式照样解析、指令照样发，只是发进了一个没人要的函数里。
   * 比一个 `nocode_wanted` 标志好的地方是不必给每个 emit 加分支；代价是槽号会白涨，
   * 而那个函数马上被丢掉，所以不涨真的。
   */
  sizeofExpr() {
    const ty = this.sizeofType();
    /* 变长数组的 `sizeof` 是**运行期**的一次读（tcc 的 `vpush_type_size` 在 VT_VLA 上
     * 压的正是那个存着字节数的位置，`tccgen.c:3551`）。长度在声明那一刻就定住了 ——
     * 所以 `int a[n]; n = n - 1; sizeof a` 还是原来那个数。 */
    if (isVla(ty)) {
      return sVal(TY_ULLONG, this.vlaSizeRef(ty));
    }
    /* `sizeof` 的类型是 `size_t`（LP64 上是 `unsigned long`，8 字节）。 */
    const n = typeSize(ty).size;
    return sVal(TY_ULLONG, this.konst(TY_ULLONG, n));
  }

  /**
   * `__alignof__` 的值（`tccgen.c:5789-5806`）。
   *
   * 操作数的读法与 `sizeof` **完全一样**（类型名或者表达式，都不求值），差别只有两处：
   *   - 取的是 `align` 而不是 `size`；
   *   - 操作数是一个**符号**且那个符号自己写了 `aligned(N)` 时，回的是**符号**那一份
   *     （tcc 在这儿回头去看刚压进去的 SValue 上挂的 Sym，注释里自称 hack）。
   *     所以 `__alignof__(altest7)` 是 16 而 `__alignof__(struct aligntest7)` 是 4。
   */
  alignofExpr() {
    this.symAlign = 0;
    const ty = this.sizeofType();
    const n = this.symAlign !== 0 ? this.symAlign : typeSize(ty).align;
    return sVal(TY_ULLONG, this.konst(TY_ULLONG, n));
  }

  /**
   * `sizeof` 后面那个操作数的类型。表达式一路与常量表达式一路（`ceUnary`）共用这一段 ——
   * 于是 `sizeof(默认调试表) / sizeof(表[0])` 这种数组长度算式在两边都是同一个数。
   */
  sizeofType() {
    /* `sizeof` 的操作数**总是**一个 unary（`tccgen.c:5796` 的 `expr_type(&type, unary)`），
     * 类型名那一种是 unary 里 `(` 那一格的特例。tcc 的办法是把那个 `(` 记号换成
     * `TOK_SOTYPE`（`tccgen.c:5794`）：只有**这一个**括号会被当成可能的类型名，而且
     * 认出类型名之后 `return`、不进后缀循环（`tccgen.c:5708`）。
     *
     * 换记号我们做不到（记号是数），所以用一个一次性的标志。少了这一层就会把
     * `sizeof ((Stab_Sym*)0)->n_value` 读成 `sizeof((Stab_Sym*)0)` 再剩一个 `->` ——
     * 里层那个 `(` 是真的强制转换，外层那个才是「可能的类型名」。 */
    const scratch = new MirFunc('$sizeof', [], T_VOID);
    const outer = this.f;
    this.f = scratch;
    /* `sizeof(char[1+2*a])` —— 类型名里也能有变长数组，而且那个长度**要真的算**
     * （tcctest.c:3160 那句注释）。`arrayPost` 会把那几条指令发到 `bodyF` 上，
     * 所以这儿只管把「这儿允许变长」这一格打开。 */
    const saveVla = this.vlaMode;
    if (this.scopes.length > 0) this.vlaMode = 2;
    if (this.tok === LPAR) this.soType = true;
    const ty = this.unary().ty;
    this.soType = false;
    this.vlaMode = saveVla;
    this.f = outer;
    return ty;
  }

  /** 后缀：`x++` / `x--`、`a[i]`、`s.f`、`p->f`。（`(…)` 那种函数指针调用还没到） */
  postfix(v) {
    let cur = v;
    for (;;) {
      const t = this.tok;
      if (t === TOK_INC || t === TOK_DEC) {
        this.next();
        cur = this.incdec(cur, t === TOK_INC ? PLUS : MINUS, true);
        continue;
      }
      if (t === LPAR) {
        /* 通过函数指针调用。`cur` 有两副面孔，而它们指的是同一件事：
         *   - 函数指示符（`f`、`*fp`、`**fp`）—— 一个函数类型的内存左值；
         *   - 函数指针的值（`fps[i]`、`s.cb` 取过值之后）。
         * 两条都归一成「函数类型 + 一个指针值的 ref」，然后发 CALLI。 */
        if (isFunc(cur.ty.t)) {
          cur = this.indirectCall(cur.ty, this.gv(cur));
          continue;
        }
        if (isPtr(cur.ty.t) && isFunc(cur.ty.ref.t)) {
          cur = this.indirectCall(cur.ty.ref, this.gv(cur));
          continue;
        }
        this.err(`called object is not a function or function pointer`
          + ` ('${typeText(cur.ty)}')`);
      }
      if (t === LBRACK) {
        /* `a[i]` **就是** `*(a + i)`（C11 6.5.2.1 第 2 段）。照这一句写而不是另开一条
         * 地址计算：于是 `i[a]` 自动对、数组与指针自动一视同仁、多维数组自动是
         * 「先退化外层再退化内层」—— 三件事一行代码都不用多写。 */
        this.next();
        const idx = this.gexpr();
        this.skip(RBRACK);
        const p = this.genOp(PLUS, cur, idx);
        if (!isPtr(p.ty.t)) this.err('subscripted value is not an array or pointer');
        cur = sMem(p.ty.ref, this.gv(p), 0);
        continue;
      }
      if (t === DOT || t === TOK_ARROW) {
        /* `s.f` 与 `p->f` 是**同一段代码**：C11 6.5.2.3 第 4 段说 `p->f` 就是 `(*p).f`，
         * 所以只在开头把箭头那一侧先解引用，剩下的一模一样。 */
        this.next();
        let base = cur;
        if (t === TOK_ARROW) {
          const p = this.decay(base);
          if (!isPtr(p.ty.t)) {
            this.err(`invalid type argument of '->' ('${typeText(base.ty)}')`);
          }
          base = sMem(p.ty.ref, this.gv(p), 0);
        }
        if (!isStruct(base.ty.t)) {
          this.err(`request for member in something not a structure or union`
            + ` ('${typeText(base.ty)}')`);
        }
        const info = base.ty.ref;
        if (info.fields === null) {
          this.err(`'${typeText(base.ty)}' is an incomplete type`);
        }
        const fname = this.identName();
        const fld = info.fields.find((x) => x.name === fname);
        if (fld === undefined) {
          this.err(`'${typeText(base.ty)}' has no member named '${fname}'`);
          return cur;
        }
        if (base.mem === null) this.err('internal: struct 左值不在内存上');
        /* 成员偏移**加进静态偏移**，不发一条 ADD。于是 `a.b.c.d` 与 `p->f` 都是
         * 一条 MLOAD —— 这正是把静态偏移放进访问描述符（sMem 的 off）换来的东西，
         * 而 `&s.f` 那一侧由 `addrOf` 统一发那条加法。 */
        cur = sMem(fld.ty, base.mem.addr, base.mem.off + fld.off);
        continue;
      }
      return cur;
    }
  }

  /**
   * `inc`（`tccgen.c:3863`）：`++x` / `x++`。
   * 后缀的值是**旧值**，所以要先把旧值取出来。tcc 靠 vdup + vrott 在值栈上倒腾，
   * 这里就是一条 LOAD 加一次算术。
   *
   * 类型：`x` 是 `char` 时 `x++` 的值是 **char**（不是提升后的 int）—— 所以存回去
   * 要经 `vstore` 收口，而回出去的旧值也是 char。
   */
  incdec(target, op, post) {
    if (!isLval(target)) this.err('lvalue expected');
    /* 取过值之后类型上不能再带位域信息（见 `bfValType`）—— 否则那个「旧值」下一次
     * 被 gv 时会以为自己还要去内存里读一遍，而它手上没有地址。 */
    const ty = bfValTypeOf(target.ty);
    const old = this.gv(target);
    const nv = this.genOp(op, sVal(ty, old), sVal(TY_INT, this.mod.consts.i32(1)));
    const stored = this.vstore(target, nv);
    return sVal(ty, post ? old : this.gv(stored));
  }

  /** 调用：`名字 ( 实参… )`。名字已经吃掉，当前记号是 `(`。 */
  funcCall(name) {
    /* `alloca`（第六十三片）。tcc 那边它是运行时库里的一个真函数（`lib/alloca.S`：
     * 一句 `sub sp` 就完了），只在边界检查那一路上被特判（`tccgen.c:1701`）。我们没有
     * FFI（ADR-0014 决策 4：解释器不假装能做 FFI），所以在这儿把它编成「在 `$sp` 上
     * 切一刀」—— 与变长数组（第四十九片）**同一刀**，区别只有「什么时候还」：
     * VLA 出作用域就还，alloca 那一块要活到函数返回。
     *
     * 这个单元里真的定义了一个叫 alloca 的函数时不拦（那就是它自己的函数）。 */
    if (name === 'alloca' || name === '__builtin_alloca') {
      const hit = this.funcs.get(name);
      if (hit === undefined || !hit.defined) return this.allocaCall();
    }
    const info = this.funcSym(name);
    info.used = true;
    const a = this.callArgs(`function '${name}'`, info.params, info.variadic, info.ret,
      info.old === true);
    if (info.params === null) {
      info.params = a.vals.map((v, i) => ({
        name: `$p${i}`, ty: promotedType(decayedType(v.ty)),
      }));
    }
    const rt = mirTypeOf(info.ret);
    /* native 上的变参调用**不走桩**：一个桩装不下「实参个数各不相同」的调用点，
     * 而真的 ABI 要求实参就在寄存器与栈上（第二十二片）。所以这儿直接发 CCALL，
     * 分界记在 aux 上。 */
    const r = this.native && info.variadic
      ? this.f.emit(OP.CCALL, rt, this.mod.cabiNo(name),
        this.f.pushArgs(a.refs), a.nfixed + 1)
      : this.f.emit(OP.CALL, rt, info.no, this.f.pushArgs(a.refs), 0);
    /* 回的是那块地方的地址（SysV 的 rax 也是这么回的）。用**回来的**那个 ref 而不是
     * 手上的 `sret`：两者一定相等，而用回来的那个把「返回值在哪儿」这件事记在数据流里。 */
    if (a.sret !== null) return sMem(info.ret, r, 0);
    return this.retNarrow(info.ret, r);
  }

  /**
   * `alloca(n)`：在 `$sp` 上切 n 个字节，回那块地方的地址。
   *
   * 与 `vlaAlloc` 的三条指令一模一样（读 `$sp`、减、按 16 对齐、写回），少的是
   * 「把切之前的 `$sp` 存起来」那一步 —— 因为没人要把它还回来。还回来的只有函数
   * 收场那一条（`emitEpilogue`），所以这儿借 `vlaSeen` 那条规矩：这个函数必须有
   * 序言/收场那一对，不然递归调用一圈就把栈走穿了。
   *
   * 同一个作用域里既有 VLA 又有 alloca 时，那个作用域退出会把 alloca 切的这一块
   * 也一起收回去 —— 那不是我们的取舍，tcc 的 `gen_vla_sp_restore` 也是这个效果。
   */
  allocaCall() {
    this.skip(LPAR);
    const n = this.castTo(this.exprEq(), TY_ULLONG);
    this.skip(RPAR);
    const f = this.f;
    this.vlaSeen = true;
    /* native（第三十六片）：与 `vlaAlloc` 同一条路，少的是「存一次旧栈顶」——
     * 没人要把它还回来（还回来的只有作用域退出与函数收场）。 */
    if (this.native) {
      return this.postfix(sVal(mkPointer(TY_VOID), this.nativeAlloca(this.gv(n))));
    }
    const spNo = this.spGlobal();
    const sp = f.emit(OP.GLOAD, T_I64, REF_NONE, REF_NONE, spNo);
    const base = f.emit(OP.BAND, T_I64, f.emit(OP.SUB, T_I64, sp, this.gv(n), 0),
      this.mod.consts.int(-16n), 0);
    f.emit(OP.GSTORE, T_VOID, base, REF_NONE, spNo);
    return this.postfix(sVal(mkPointer(TY_VOID), base));
  }

  /**
   * PROMOTE_RET（`tccgen.c:6372-6379` 立旗、`force_charshort_cast`（`tccgen.c:3236`）
   * 兑现，`arm64-gen.c:47` / `x86_64-gen.c:109` 都开着它）：声明的返回类型是
   * `char`/`short`/`_Bool` 时，**调用方**把回来的那一格按窄类型截一刀。
   *
   * 被调的那一侧如果也是我们编的，它 `return` 那一步已经截过了，这一刀于是白挨一下。
   * 露出来的是**函数指针的类型与真实函数不符**那一种（tcctest.c 的 `csf`：`__csf` 回
   * `int`，却按「回 `unsigned char` 的函数」调），那时寄存器里全是 32 位，谁截由 ABI
   * 说了算 —— tcc 说调用方截，所以 `csf(unsigned char, 0x89898989)` 是 137 而不是
   * 0x89898989。
   *
   * `_Bool` 那一格照 `force_charshort_cast` 里那句 `dbt == VT_BOOL ? VT_BYTE|VT_UNSIGNED`：
   * 按**无符号 char** 截，不是「非零就是 1」—— 所以 `csf(_Bool, 0x33221100)` 是 0、
   * `0x33221101` 是 1，而按 `!= 0` 算两个都会是 1。
   */
  retNarrow(ret, r) {
    const b = btype(ret.t);
    if (b !== VT_BYTE && b !== VT_SHORT && b !== VT_BOOL) return sVal(ret, r);
    const nt = b === VT_BOOL ? TY_UCHAR
      : ctype(ret.t & (VT_BTYPE | VT_UNSIGNED | VT_DEFSIGN), null);
    return sVal(ret, this.gv(this.castTo(sVal(TY_INT, r), nt)));
  }

  /**
   * 通过函数指针调用（第十三片）。`fnTy` 是**函数类型**（不是指针），`callee` 是
   * 函数指针值的 ref。直接调用照旧发 `CALL`（下标是常量，一条指令就够）——
   * 只有这里发 `CALLI`。
   *
   * 变参也走这一条（第十九片）：第十六片把变参函数的签名定死成「固定形参 + 一个变参区
   * 指针」之后，间接调用与直接调用的实参形状就是同一个，这儿只要把 `variadic` 那一位
   * 交给 `callArgs`。
   */
  indirectCall(fnTy, callee) {
    const fi = fnTy.ref;
    const a = this.callArgs('function pointer', fi.params, fi.variadic, fi.ret,
      fi.old === true);
    /* native（第三十五片）：变参的分界也要交给后端 —— 苹果的 arm64 上变参一律走栈，
     * 按指针调 `printf` 与直接调它必须摆成同一个样子。解释器那条腿不看这一格。 */
    const vafix = this.native && fi.variadic ? a.nfixed + 1 : 0;
    const r = this.f.emit(OP.CALLI, mirTypeOf(fi.ret), callee,
      this.f.pushArgs(a.refs), vafix);
    if (a.sret !== null) return sMem(fi.ret, r, 0);
    return this.retNarrow(fi.ret, r);
  }

  /**
   * 实参那一段（直接调用与间接调用共用）：读实参、按原型转换、struct 的两条 ABI。
   * 回 `{refs, sret, vals}` —— `vals` 只有「先调用后定义」那条路要（拿它回填形参表）。
   */
  callArgs(what, params, variadic, ret, old) {
    this.skip(LPAR);
    /** @type {object[]} */
    const vals = [];
    if (this.tok !== RPAR) {
      for (;;) {
        vals.push(this.exprEq());
        if (this.tok !== COMMA) break;
        this.next();
      }
    }
    this.skip(RPAR);
    /* 形参个数与类型：声明过就核对并**按声明的类型转换实参**（C 的原型就是干这个的）。
     * 没声明过（先调用后定义）就只记个数，定义时反过来核对。 */
    const np = params === null ? -1 : params.length;
    if (np >= 0) {
      /* 老式的函数（`int f(a, b) {…}`）没有原型可核对：多给的实参 tcc 照旧算、
       * 照旧传，被调方不看（`tccgen.c:5352`）。少给的仍然是错 —— 形参会读到垃圾。 */
      const bad = old === true ? vals.length < np
        : (variadic ? vals.length < np : vals.length !== np);
      if (bad) {
        this.err(`too ${vals.length < np ? 'few' : 'many'} arguments to ${what}`);
      }
    }
    const refs = [];
    /* struct 的返回：调用方先在自己的帧上划一块，把地址当**第一个**实参传进去
     * （第十一片的 ABI，见 `runBody`）。划这一块在两遍里都做，于是第一遍数出来的帧
     * 一定装得下它。 */
    let sret = null;
    if (isStruct(ret.t)) {
      sret = sMem(ret, this.fpRef, this.frameAlloc(ret));
      refs.push(this.addrOf(sret));
    }
    /** @type {{ty:object,ref:number}[]} `...` 后面那些实参（进变参区，不进实参表） */
    const extra = [];
    for (let i = 0; i < vals.length; i++) {
      /* 固定形参按**声明的类型**转（原型的作用）；`...` 后面那些按**默认实参提升**
       * （C11 6.5.2.2 第 6 段）：窄整数提到 int、`float` 提到 double、
       * 数组与函数退化成指针。用 `promotedType` 而不是 `promote`：后者会真的取一次值，
       * 这里只想问类型。 */
      const fixed = np >= 0 && i < np;
      /* 老式函数多给的那些实参：算，但**不进变参区** —— 被调方没有变参区那一格
       * （它不是变参函数），塞进去签名就对不上了。tcc 那边它们进寄存器、没人读。 */
      const drop = old === true && !fixed;
      const want = fixed ? params[i].ty : promotedType(decayedType(vals[i].ty));
      /* 传值的 struct 传的是**地址**，拷贝由被调方在入口处做（`runBody`）。
       * 于是一次调用只有一次拷贝，而且那次拷贝是 C 要求的那一次
       * （形参是实参的一份可改的拷贝，C11 6.9.1 第 10 段）。 */
      if (isStruct(want.t)) {
        if (!sameType(want, vals[i].ty)) {
          this.err(`cannot pass '${typeText(vals[i].ty)}' as '${typeText(want)}'`);
        }
        if (fixed) {
          refs.push(this.addrOf(vals[i]));
          continue;
        }
        /* `...` 后面的 struct 是**摊在变参区里**的一份拷贝，不是一个地址（第二十二片）：
         * `va_arg(ap, struct P)` 只知道自己要的类型，拿不到「这一格里放的是地址还是
         * 内容」这条额外信息 —— 所以内容必须直接躺在格子里。arm64/SysV 的变参区
         * 也是这么放的（小的摊开，只有超大的才改成地址，而那一格由 ABI 定死）。 */
        extra.push({ ty: want, val: vals[i] });
        continue;
      }
      const r = this.gv(this.castTo(vals[i], want));
      if (fixed) refs.push(r);
      else if (!drop) extra.push({ ty: want, ref: r });
    }
    /* 变参：`...` 后面的实参不进实参表，进帧上的一块「变参区」，地址当**最后一个**
     * 实参传进去（第十六片的 ABI）。于是变参函数的 MIR 签名是**定死的**
     * （固定形参 + 一个 i64），自家的与外部的一个形状 —— 调用点因此不必知道
     * 这个名字最后有没有定义，照旧发 CALL。
     *
     * native（第二十二片）不能这么做：真的 `printf` 按真 ABI 读实参，读不到我们自己摆的
     * 变参区。所以变参就**跟在固定实参后面**一起传，由后端按 ABI 分寄存器与栈 ——
     * 分界（固定实参个数）记在 `CCALL` 的 aux 上。 */
    let nfixed = -1;
    if (variadic) {
      if (this.native) {
        nfixed = refs.length;
        for (const e of extra) {
          /* struct 进可变部分（第三十九片）：发一条 `ARGMEM`（内容的地址 + 字节数），
           * 由后端按 ABI 把那几个字节拷进格子里。前端这一层不知道那一格在哪儿 ——
           * 苹果 arm64 上一律在栈上，SysV 上还要分类，那都是后端的账。 */
          if (e.val !== undefined) {
            refs.push(this.f.emit(OP.ARGMEM, T_I64, this.addrOf(e.val), REF_NONE,
              this.memArgAuxOf(e.ty)));
            continue;
          }
          refs.push(e.ref);
        }
      } else {
        refs.push(this.vaBlock(extra));
      }
    }
    return { refs, sret, vals, nfixed };
  }

  /**
   * 变参区：一格至少 8 字节，顺序照实参，回它的地址（第十六片的 ABI）。
   *
   * 格子等宽（8 的整数倍）而不是「按类型的宽度紧排」，是因为读的那一侧（`va_arg`）只
   * 知道**它自己要的类型**，不知道写的时候是什么 —— 格子按同一条规则算大小，两边才
   * 能落在同一个位置。标量那一格只写它自己那几个字节（`int` 写 4 个），读的时候也按
   * 要的类型读；struct 是**整份摊进去**（第二十二片），占 `对齐到8(sizeof)` 个字节。
   * 这与 arm64/SysV 的变参区是同一条规则（栈上一格一格，只用得着的那几个字节有效）。
   *
   * 一个实参都没有时也划一格：`printf("hi")` 的变参区不会被读，但「地址」得有一个。
   * 划在帧上而不是别处，是因为它必须活到被调方读完 —— 而调用结束前帧一直在。
   */
  vaBlock(extra) {
    const at = [];
    let total = 0;
    for (const e of extra) {
      at.push(total);
      total += alignUp(typeSize(e.ty).size, 8);
    }
    const off = this.frameAlloc(mkArray(TY_LLONG, total === 0 ? 1 : total / 8));
    for (let i = 0; i < extra.length; i++) {
      const e = extra[i];
      if (e.val !== undefined) {
        this.structCopy(sMem(e.ty, this.fpRef, off + at[i]), e.val);
        continue;
      }
      this.f.emit(OP.MSTORE, mirTypeOf(e.ty), this.fpRef, e.ref,
        memDesc(storeKindOf(e.ty), off + at[i]));
    }
    return this.addrOf(sMem(TY_LLONG, this.fpRef, off));
  }

  /**
   * `__builtin_va_start` / `__builtin_va_arg` / `__builtin_va_end` /
   * `__builtin_va_copy`（`tccgen.c:5943` 一带 arm64 那一支）。当前记号是那个内建的名字。
   *
   * 四个都不是函数：`va_arg` 的第二个实参是**类型名**，而另外三个要的是「一个左值」。
   * tcc 那边 `va_end`/`va_copy` 是 tccdefs.h 里的宏（`(void)(ap)` 与 `(dest)=(src)`），
   * 这里做成内建 —— 少一份要与头文件同步的东西，可观察的行为一模一样。
   */
  vaBuiltin(t) {
    this.next();
    this.skip(LPAR);
    const ap = this.exprEq();
    if (t === TOK_BUILTIN_VA_END) {
      /* `(void)(ap)`：什么都不做。**照旧要求它是个左值**（C 的 `va_end(ap)` 里 ap 是
       * 那个 va_list），于是拼错名字仍然当场被抓住。 */
      this.skip(RPAR);
      if (!isPtr(ap.ty.t)) this.err('__builtin_va_end expects a va_list');
      return sVal(TY_VOID, REF_NONE);
    }
    this.skip(COMMA);
    if (t === TOK_BUILTIN_VA_ARG) {
      const ty = this.typeName();
      this.skip(RPAR);
      return this.postfix(this.vaArg(ap, ty));
    }
    if (t === TOK_BUILTIN_VA_COPY) {
      const src = this.exprEq();
      this.skip(RPAR);
      /* native（第三十二片）：`va_list` 在这条腿上的内容归后端 —— arm64 上它就是那个
       * 游标（直接赋值恰好对），SysV 上它是**指向**那个 24 字节结构的指针，抄指针会让
       * 两个 ap 共用一个游标。所以这儿只发一条 `VACOPY`，两个实参都是**那两个 va_list
       * 变量的地址**（后端要就地写 dest）。 */
      if (this.native) {
        if (!isPtr(ap.ty.t) || !isPtr(src.ty.t)) this.err('__builtin_va_copy expects two va_list');
        this.f.emit(OP.VACOPY, T_I64, this.addrOf(ap), this.addrOf(src), 0);
        return sVal(TY_VOID, REF_NONE);
      }
      this.vstore(ap, src);
      return sVal(TY_VOID, REF_NONE);
    }
    /* `va_start(ap, last)`：把隐藏的那个变参区指针写进 ap。`last` 按 C 的规定是最后一个
     * 固定形参，这一片**不核对**（tcc 也只在注释里写了「xx check types」）—— 但要读掉，
     * 否则括号对不上。 */
    this.exprEq();
    this.skip(RPAR);
    if (!isPtr(ap.ty.t)) this.err('__builtin_va_start expects a va_list');
    /* native（第二十五片）：`va_list` 的形状归后端 —— 这儿只发一条 `VASTART`，
     * 实参是**那个 va_list 变量的地址**（后端要就地写它）。取地址这一下顺带让
     * 两遍过的机制把它落到内存上（第一遍记名字、第二遍它就在帧上了）。 */
    if (this.native) {
      if (!this.f.variadic) {
        this.err('__builtin_va_start used in a function with fixed arguments');
      }
      this.f.emit(OP.VASTART, T_I64, this.addrOf(ap), REF_NONE, 0);
      return sVal(TY_VOID, REF_NONE);
    }
    if (this.vaRef === REF_NONE) {
      this.err('__builtin_va_start used in a function with fixed arguments');
    }
    this.vstore(ap, sVal(mkPointer(TY_VOID), this.vaRef));
    return sVal(TY_VOID, REF_NONE);
  }

  /**
   * 一块内容（变参里的 struct）的 aux：字节数 + SSE 位图（第四十片）。
   *
   * 位图是一条**类型事实**（"前两个八字节里哪几整格只装浮点"），不是 ABI 决定 ——
   * 可是要它的只有 SysV（分类要它），而 MIR 不分架构，所以只能在这儿算好带下去。
   * 超过 16 字节的一律进内存，位图没有意义，填 0。
   */
  memArgAuxOf(ty) {
    const s = typeSize(ty);
    return memArgAux(s.size, s.size > 16 ? 0 : sseEightbytes(ty));
  }

  /**
   * `va_arg(ap, T)`：读走一格、把 ap 推到下一格。
   *
   * **先读后推**，而且读的宽度按 T（一格 8 字节里只有 T 那几个字节有效，见 `vaBlock`）。
   * 回的是一个**值**不是左值 —— C 的 `va_arg` 是一个表达式的值（`va_arg(ap,int) = 3`
   * 不合法），而且它有副作用，所以不能让别人再取一次。
   */
  vaArg(ap, ty) {
    if (isArray(ty.t) || isFunc(ty.t)) {
      this.err(`'${typeText(ty)}' cannot be an argument type`);
    }
    /* native（第二十五片）：一格在哪儿由后端按真 ABI 找 —— 这儿只发一条 `VAARG`，
     * 实参照旧是**那个 va_list 变量的地址**（后端要就地把它推到下一格）。 */
    if (this.native) {
      /* struct 那一格（第三十九片）：内容整份躺在变参区里，所以回的是**指向那一份的
       * 左值** —— 要拷贝的话由赋值那一步去拷（`structCopy`），取成员就直接读。
       * 与线性内存那条腿、以及 struct 返回，都是同一个手法。 */
      if (isStruct(ty.t)) {
        const at = this.f.emit(OP.VAARG, T_I64, this.addrOf(ap), REF_NONE,
          this.memArgAuxOf(ty));
        return sMem(ty, at, 0);
      }
      const mt = mirTypeOf(ty);
      if (mt === T_F32) this.todo('va_arg 取 float（C 的默认提升本来就让它过不来）');
      const v = this.f.emit(OP.VAARG, mt, this.addrOf(ap), REF_NONE, 0);
      /* 后端只按 i32/i64/f64 三种宽度取。比 int 窄的类型（`va_arg(ap, char)`）取回来的是
       * **提升之后**那个 int，所以再削一刀回到 C 说的类型上 —— 削与不削的差别在
       * 「取回来的值当 char 用」时才现形。 */
      if (mt === T_I32 && intBitsOf(ty) < 32) return this.castTo(sVal(TY_INT, v), ty);
      return sVal(ty, v);
    }
    const f = this.f;
    const cur = this.gv(ap);
    /* 游标按**格子的大小**往前走，而格子的大小与写的那一侧（`vaBlock`）同一条规则。 */
    const step = this.mod.consts.int(BigInt(alignUp(typeSize(ty).size, 8)));
    const next = () => this.vstore(ap, sVal(ap.ty, f.emit(OP.ADD, T_I64, cur, step, 0)));
    if (isStruct(ty.t)) {
      /* struct 整份摊在变参区里，所以这儿回的是**指向那一份的左值** —— 要拷贝的话由
       * 赋值那一步去拷（`structCopy`），取成员就直接读。与 struct 返回同一个手法。 */
      next();
      return sMem(ty, cur, 0);
    }
    const v = f.emit(OP.MLOAD, mirTypeOf(ty), cur, REF_NONE, memDesc(loadKindOf(ty), 0));
    next();
    return sVal(ty, v);
  }

  /**
   * 外部函数的转发桩。这个翻译单元里没有函数体的名字就是外部符号 —— 真的编译器把它交给
   * 链接器，我们给它一个桩：读进形参、发一条 CCALL、把结果返回。
   *
   * 为什么是桩、而不是在调用点直接发 CCALL：一遍过里**调用点可能出现在定义之前**，
   * 那时还不知道这个名字最后有没有定义。桩把这个问题推到读完整个单元之后 —— 与
   * 「undefined symbol」那条检查同一个位置，而调用点照旧发 CALL，一条都不用改。
   *
   * 变参函数走的是同一条路（第十六片起）：它的 MIR 签名是**定死的**（固定形参 +
   * 一个变参区指针），所以一个桩装得下所有调用点。宿主那边的变参函数因此也从
   * 那块变参区里读实参 —— 与真的 ABI 是同一件事（见 `interp/libc.js` 的 `vaCursor`）。
   */
  externThunk(name, info) {
    const f = info.f;
    /* native（第二十片）：桩**不能与它转发的符号同名** —— `_strlen` 里 `call _strlen`
     * 是无穷递归，症状是段错误，而现场（栈满）离原因（同名）很远。改名成 `$ext$strlen`，
     * 调用点照旧按函数号 CALL 它，它再 CCALL 真的 `strlen`。
     * 线性内存那条腿上不存在这个问题：那边的 CCALL 落到宿主的 JS 实现上，不是符号。 */
    if (this.native) {
      this.mod.renameFunc(info.no, `$ext$${name}`);
      /* 桩的符号是**局部**的（第九十二片）：每份 `.o` 里都有一个 `$ext$printf`，
       * 外部符号的话十二份一起链就是十二次 `duplicate symbol`。 */
      f.local = true;
    }
    const params = info.params === null ? [] : info.params;
    const refs = [];
    /* 桩要把实参**原样**转给宿主，而我们的 struct 传的是自家线性内存里的一个偏移 ——
     * 宿主读不到（第五片证明「转手宿主 libc」不成立，同一个理由）。所以外部符号上的
     * struct 传值/返回是边界，不是错误。 */
    if (isStruct(info.ret.t)) {
      this.todo(`外部函数 '${name}' 返回 struct 还没到（要真的 ABI）`);
    }
    for (const p of params) {
      if (isStruct(p.ty.t)) this.todo('外部函数按值收 struct 还没到（要真的 ABI）');
      const mt = mirTypeOf(p.ty);
      const slot = f.slot(p.name, mt);
      f.params.push({ name: p.name, t: mt, slot });
      refs.push(f.emit(OP.LOAD, mt, REF_NONE, REF_NONE, slot));
    }
    if (info.variadic) {
      const slot = f.slot('$va', T_I64);
      f.params.push({ name: '$va', t: T_I64, slot });
      refs.push(f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, slot));
    }
    const rt = mirTypeOf(info.ret);
    const r = f.emit(OP.CCALL, rt, this.mod.cabiNo(name), f.pushArgs(refs), 0);
    if (rt === T_VOID) f.emit(OP.RET, T_VOID, REF_NONE, REF_NONE, 0);
    else f.emit(OP.RET, rt, r, REF_NONE, 0);
  }

  /**
   * `expr_infix`（`tccgen.c:6536`）：优先级爬升。**结构照抄**，包括那个
   * 「先 unary、看下一个运算符的优先级更高才递归」的写法 —— 换成经典的
   * 「while 里套 while」也能对，但那就不是同一份代码的形状了。
   *
   * 与 tcc 唯一的差别：它拿 `vtop` 当隐含的「左边」，我们要显式传（见文件头偏离 1）。
   */
  exprInfix(left, p) {
    let acc = left;
    let t = this.tok;
    for (;;) {
      const p2 = precedence(t);
      if (p2 < p) break;
      if (t === TOK_LOR || t === TOK_LAND) {
        acc = this.exprLandor(t, acc);
      } else {
        this.next();
        let right = this.unary();
        if (precedence(this.tok) > p2) right = this.exprInfix(right, p2 + 1);
        acc = this.genOp(t, acc, right);
      }
      t = this.tok;
    }
    return acc;
  }

  /** `expr_lor()`（`tccgen.c:6504` 的宏）：`unary(), expr_infix(1)` */
  exprLor() {
    return this.exprInfix(this.unary(), 1);
  }

  /**
   * `expr_landor`（`tccgen.c:6570`）：`&&` / `||`。
   * 短路是**控制流**（from_oir.js:618 那句话在这儿同样成立）：结果落在一个临时槽上。
   * tcc 那边这个函数还兼着常量折叠与「把两边的跳转目标并起来」的优化，这一片不做。
   *
   * 结果类型是 C 的 `int`（0 或 1），所以槽是 T_I32 —— 而不是 bool。这一格错过一次的
   * 后果是 `x = a && b` 存进去一个 bool，MIR 的 verifier 不查，但 LLVM 那条腿会发
   * `store i1` 到 i32 的槽上。
   */
  exprLandor(op, left) {
    const f = this.f;
    const slot = this.temp(T_I32, op === TOK_LAND ? 'land' : 'lor');
    let acc = left;
    /* 一层一层套 IF：`a && b && c` 是 `if (a) { if (b) { slot = c!=0 } }`。
     * 套的层数就是运算符个数，所以数着，最后一次性关掉。 */
    let depth = 0;
    for (;;) {
      if (op === TOK_LAND) {
        f.emit(OP.STORE, T_VOID, this.mod.consts.i32(0), REF_NONE, slot);
        this.open(OP.IF, 'if', this.gtst(acc));
      } else {
        f.emit(OP.STORE, T_VOID, this.mod.consts.i32(1), REF_NONE, slot);
        this.open(OP.IF, 'if', this.gtst(acc));
        this.elseHalf();
      }
      depth++;
      this.next();
      /* 右边只吃比自己**紧**的那一段（`expr_landor_next`，`tccgen.c:6503`）：
       * `&&` 的右边不吃 `||`，于是 `a || b && c` 是 `a || (b && c)`。 */
      acc = this.exprInfix(this.unary(), precedence(op) + 1);
      if (this.tok !== op) break;
    }
    /* 最里层：把「右边到底真不真」写进槽 —— 0/1 由 gvBool 保证，
     * 因为 `x = 1 && 2` 在 C 里是 1，不是 2。 */
    f.emit(OP.STORE, T_VOID, this.gvBool(acc), REF_NONE, slot);
    for (let i = 0; i < depth; i++) this.close();
    return sVal(TY_INT, f.emit(OP.LOAD, T_I32, REF_NONE, REF_NONE, slot));
  }

  /**
   * `expr_cond`（`tccgen.c:6608`）：`? :`。同样落在临时槽上。
   * 两支的类型走常规算术转换（`combine_types` 在整型上就是这件事）—— 但两支的求值
   * 分别在两个区域里，所以「先算出公共类型再各自转换」办不到：只能先解析第一支、
   * 记住它的类型，等第二支出来后**在各自的区域里**转。这里的做法是把公共类型定成
   * 「第一支提升后的类型与第二支提升后的类型的常规转换结果」，而为了在第一支的区域里
   * 就知道它，先按第一支的类型开槽，第二支若更宽则整条重来 —— 重来的代价太大，
   * 所以退一步：**槽按 i64 开**，两支各自转成公共类型之后存进去，读出来再转回公共类型。
   * i64 装得下这一片的每一种整型，于是不损失精度；无符号性靠最后那次转换恢复。
   *
   * 浮点进来之后 i64 那个槽不够了（`c ? 1.5 : 2.5` 存进 i64 就成了 1）。办法是**再开一个
   * f64 的槽**，算术类型的那一支往两个槽里各存一份（一次 F2I、一次 I2F 或恒等），
   * 最后按公共类型挑一个读。多出来的那条 store 只在 `? :` 上，而它买到的是
   * 「不必知道第二支的类型就能给第一支开槽」—— 也就是不必为此再扫一遍记号。
   * f64 装得下 float 的每一个值，所以公共类型是 `float` 时最后那次 FCVT 是精确的。
   */
  exprCond() {
    const v = this.exprLor();
    if (this.tok !== QUEST) return v;
    this.next();
    const f = this.f;
    /* GNU 的 `x ? : y`（第三十六片，tcctest.c:1304）：中间那一项省掉就是
     * 「x 非 0 就用 x，否则 y」，而 **x 只求值一次** —— `f() ? : 0` 只调一次 f。
     * 所以先把它落进一个槽，条件与第一支读的是同一格（tcc 用 `vdup()` 复制 vtop，
     * 同一个意思：那个值已经在手上了，别再算一遍）。 */
    let mid = null;
    if (this.tok === COLON) {
      const dup = this.temp(mirTypeOf(v.ty), 'dup');
      f.emit(OP.STORE, T_VOID, this.gv(v), REF_NONE, dup);
      mid = sLval(v.ty, dup, '$dup');
    }
    const c = this.gtst(mid === null ? v : mid);
    const slot = this.temp(T_I64, 'sel');
    const fslot = this.temp(T_F64, 'fsel');
    /** 一支落地：整型/指针进 i64 那个槽，算术类型**另外**再进 f64 那个槽。 */
    const put = (x) => {
      /* 两支都是 `void` 时结果也是 void（C11 6.5.15 第 5 段）—— 没有值可存。
       * tinycc 自己的 `c ? vdup() : gv_dup();`（tccgen.c:1804）就是这一形状：
       * 整条 `? :` 当一条语句用，两支都是返回 void 的调用。
       * 只有一支是 void 的那种在下面报错（tcc 也报 `cannot convert 'void' to …`）。 */
      if (btype(x.ty.t) === VT_VOID) return;
      if (isFloat(x.ty.t)) {
        f.emit(OP.STORE, T_VOID, this.gv(this.castTo(x, TY_DOUBLE)), REF_NONE, fslot);
        return;
      }
      f.emit(OP.STORE, T_VOID, this.gv(this.castTo(x, TY_LLONG)), REF_NONE, slot);
      /* 整型那一支也要往 f64 里存一份：另一支可能是浮点，而那时公共类型是浮点，
       * 读的就是这个槽。反过来不必 —— 浮点那一支存进 i64 只会被丢掉。 */
      if (isInteger(x.ty.t)) {
        f.emit(OP.STORE, T_VOID, this.gv(this.castTo(x, TY_DOUBLE)), REF_NONE, fslot);
      }
    };
    this.open(OP.IF, 'if', c);
    const a = mid === null ? this.gexpr() : mid;
    put(a);
    this.elseHalf();
    this.skip(COLON);
    const b = this.exprCond();
    put(b);
    this.close();
    /* 两支都是 void：整条表达式是 void。只有一支是 void 的是一条错 —— 那个值没法产生
     * （tcc 是在**用**它的地方报 `cannot convert 'void' to …`，我们提前到这儿报，
     * 同一句话）。 */
    const va = btype(a.ty.t) === VT_VOID;
    const vb = btype(b.ty.t) === VT_VOID;
    if (va && vb) return sVal(TY_VOID, REF_NONE);
    if (va || vb) {
      this.err(`cannot convert 'void' to '${typeText(va ? b.ty : a.ty)}'`);
    }
    /* 有一支是浮点：公共类型是两支里等级高的那个浮点（C11 6.5.15 第 5 段走的是
     * 常规算术转换），值从 f64 那个槽里读。 */
    if (isFloat(a.ty.t) || isFloat(b.ty.t)) {
      const fa = isFloat(a.ty.t) ? floatRankOf(a.ty) : -1;
      const fb = isFloat(b.ty.t) ? floatRankOf(b.ty) : -1;
      const fty = fa > fb ? a.ty : b.ty;
      const got = sVal(TY_DOUBLE, f.emit(OP.LOAD, T_F64, REF_NONE, REF_NONE, fslot));
      return this.castTo(got, fty);
    }
    const wide = sVal(TY_LLONG, f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, slot));

    /* 有一支是指针（或数组）：结果类型照 C11 6.5.15 第 6 段那三条走（tcc 的
     * `gen_op`/`? :` 那一支，`tccgen.c:2931-2999`）。放在整型那套规则**之前**，
     * 因为 intBitsOf(指针) 是 64，落到下面会算出 `long long` —— 于是 `(c?p:q)[0]`
     * 会说「下标用在了不是数组也不是指针的东西上」，而错的其实是这一格。 */
    const pa = decayedType(a.ty);
    const pb = decayedType(b.ty);
    if (isPtr(pa.t) || isPtr(pb.t)) {
      return this.castTo(wide, this.condPtrType(a, b, pa, pb));
    }
    // 公共类型：两支提升后做常规算术转换。两支的类型在这一点上都已知了。
    const bits = intBitsOf(a.ty) > intBitsOf(b.ty) ? intBitsOf(a.ty) : intBitsOf(b.ty);
    let uns;
    if (bits === 32) uns = isUnsigned(a.ty.t) || isUnsigned(b.ty.t);
    else {
      uns = (intBitsOf(a.ty) === 64 && isUnsigned(a.ty.t))
        || (intBitsOf(b.ty) === 64 && isUnsigned(b.ty.t));
    }
    let ty;
    if (bits === 64) ty = uns ? TY_ULLONG : TY_LLONG;
    else ty = uns ? TY_UINT : TY_INT;
    return this.castTo(wide, ty);
  }

  /**
   * 空指针常量（tcc 的 `is_null_pointer`，`tccgen.c:2814`）：**常量 0**，类型是
   * `int`/`long long`，或者是套了一层 `void *`（不带限定符）的那种 —— `(void *)0`。
   *
   * 「是不是常量」在我们这儿只能问 ref 是不是常量池里的一条（偏离 2：主表达式那条路
   * 不折常量）。所以 `(void *)0` 认不认得出来，取决于那次强制转换有没有落成一条常量；
   * 落不成的话这一问回 false，于是走的是「两支都是指针」那条规则 —— 对 `(void *)0`
   * 与 `T *` 这一对来说答案一样（`void *` 那一支优先），所以不影响结果。
   */
  nullPtrConst(v) {
    if (v.ref === null || !isConstRef(v.ref)) return false;
    const c = this.mod.consts.get(v.ref);
    if (c === undefined || c.kind !== 'int' || BigInt(c.text) !== 0n) return false;
    const b = btype(v.ty.t);
    if (isArray(v.ty.t)) return false;
    if (b === VT_INT || b === VT_LLONG) return true;
    if (b !== VT_PTR || v.ty.ref === null) return false;
    return btype(v.ty.ref.t) === VT_VOID
      && (v.ty.ref.t & (VT_CONSTANT | VT_VOLATILE)) === 0;
  }

  /**
   * `? :` 两支里有指针时的结果类型（C11 6.5.15 第 6 段 / `tccgen.c:2931-2999`）。
   * 三条，顺序照 tcc：
   *   1. 一支是**空指针常量** -> 结果是另一支的类型（`0 ? 0 : s` 是 `struct S *`）；
   *   2. 一支是指针、另一支是整数（而且不是 0）-> 结果是那个指针类型（tcc 只警告）；
   *   3. 两支都是指针 -> **指向 `void` 的优先**，否则取第二支；两边指向的东西上的
   *      限定符要**并起来**（`const char *` 与 `char *` -> `const char *`），
   *      而「指向长度未定的数组」要让位给写了长度的那一个。
   */
  condPtrType(a, b, pa, pb) {
    if (this.nullPtrConst(b)) return pa;
    if (this.nullPtrConst(a)) return pb;
    if (isPtr(pa.t) !== isPtr(pb.t)) return isPtr(pa.t) ? pa : pb;
    const p1 = pa.ref;
    const p2 = pb.ref;
    if (p1 === null || p2 === null) return pa;
    /* tcc 那句是 `type = *((pbt1 == VT_VOID) ? type1 : type2)` —— 先整份拷过来
     * （外层那一层的限定符跟着走），再动「指向的东西」。 */
    const outer = btype(p1.t) === VT_VOID ? pa : pb;
    let tgt = outer.ref;
    const newq = (p1.t | p2.t) & (VT_CONSTANT | VT_VOLATILE);
    if ((~tgt.t & newq) !== 0) tgt = { ...tgt, t: tgt.t | newq };
    if (isArray(p1.t) && isArray(p2.t) && !(tgt.count > 0)
      && (p1.count > 0 || p2.count > 0)) {
      tgt = { ...tgt, count: p1.count > 0 ? p1.count : p2.count };
    }
    return tgt === outer.ref ? outer : { ...outer, ref: tgt };
  }

  /** `expr_eq`（`tccgen.c:6738`）：赋值。**右结合**，所以递归调自己。 */  exprEq() {
    const v = this.exprCond();
    const t = this.tok;
    if (t !== ASSIGN && !isAssignOp(t)) return v;
    if (!isLval(v)) this.err('lvalue expected');
    this.next();
    if (t === ASSIGN) return this.vstore(v, this.exprEq());
    /* `a += b` = `a = a + b`。tcc 在这儿 `vdup()` 复制左值、算完再 `vstore`
     * （`tccgen.c:6749-6753`），而 `TOK_ASSIGN_OP(t)` 从编号算出那个二元运算符。 */
    const rhs = this.exprEq();
    return this.vstore(v, this.genOp(assignOpOf(t), v, rhs));
  }

  /** `gexpr`（`tccgen.c:6757`）：逗号表达式。前面那些的值丢掉。 */
  gexpr() {
    let v = this.exprEq();
    while (this.tok === COMMA) {
      this.next();
      v = this.exprEq();
    }
    return v;
  }

  /* -------------------------------------------------------------- 语句 */

  /**
   * 一条语句。
   *
   * 这一层只做一件事：给语句**编号**，并在第一遍量出「这条语句里面有哪些标签」。
   * 两遍走的是同一串记号，所以同一条语句在两遍里是同一个号码；第二遍据此就知道
   * 「这条语句里有没有标签」「哪些直接子语句里有标签」—— 那是 `goto` 那台状态机
   * 唯一需要的前向信息（见 `gotoStmt` 头上那一段）。
   *
   * 标签编号按**定义的源码顺序**从 1 起，于是一条语句里的标签编号一定是一段
   * **连续区间** `(lo, hi]` —— 「状态落在谁里面」这个判断就只是一次比较。
   */
  block() {
    /* 语句的**嵌套深度**（第八刀第十五片）：`case` 标签要靠它判断自己是不是 switch
     * 函数体的直接子语句 —— 长在里层的（Duff's device）走状态机那条路。
     * 数的是 `block()` 的层数，所以 `switch(x){ { case 1: … } }` 里那个 case 也算
     * 「里层」：多一层花括号就多一层，那条路虽然慢一点但是对的。 */
    this.blockDepth++;
    this.blockBody();
    this.blockDepth--;
  }

  blockBody() {
    const sn = this.stmtNo++;
    if (this.pass1) {
      const r = { lo: this.labelCount, hi: this.labelCount, kids: [], thenHi: 0, isCase: false };
      this.stmtRanges[sn] = r;
      const outer = this.kids;
      this.kids = r.kids;
      this.stmt(r);
      this.kids = outer;
      r.hi = this.labelCount;
      if (r.hi > r.lo || r.isCase) outer.push(r);
      return;
    }
    const r = this.stmtRanges[sn];
    if (r === undefined) this.err('internal: 两遍的语句序号不一致');
    this.stmt(r);
  }

  /** 第二遍：这条语句要不要「被状态机重新进入」的那一套（有标签在里面才要）。 */
  reentry(r) {
    return !this.pass1 && this.gotoSlot >= 0 && r.hi > r.lo;
  }

  /**
   * `block`（`tccgen.c:7177`）。分派的顺序照 tcc：`if` / `while` / `{` / `return` /
   * `break` / `continue` / `for` / `do`，最后落到表达式语句。
   */
  stmt(r) {
    const t = this.tok;
    /* 带值的记号不能先 next()：`next()` 会毁掉 tokc（`tccgen.c:7185-7188`）。 */
    if (tokHasValue(t)) {
      this.exprStmt();
      return;
    }

    if (t === TOK_IF) {
      this.next();
      this.skip(LPAR);
      /* 里面有标签的 `if`：被状态机重新进入时**不能算条件**（那会重跑副作用），
       * 得直接进对的那一半。于是条件变成「state == 0 ? cond : state <= thenHi」——
       * 结构化控制流里没有 select，所以借一个 bool 槽把两条路合起来。
       * `thenHi` 是 then 那一半里最大的标签号，第一遍量的（见下面 pass1 那一行）。 */
      let c;
      if (this.reentry(r)) {
        const f = this.f;
        const sel = this.temp(T_BOOL, 'ifsel');
        const st = f.emit(OP.LOAD, T_I32, REF_NONE, REF_NONE, this.gotoSlot);
        const nz = f.emit(OP.NE, T_I32, st, this.mod.consts.i32(0), 0);
        const inThen = f.emit(OP.LE, T_I32, st, this.mod.consts.i32(r.thenHi), 0);
        this.open(OP.BLOCK, 'seldone', REF_NONE);
        this.open(OP.BLOCK, 'selre', REF_NONE);
        f.emit(OP.BRIF, T_VOID, nz, REF_NONE, 0);
        f.emit(OP.STORE, T_VOID, this.gtst(this.gexpr()), REF_NONE, sel);
        f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, 1);
        this.close();                     // selre
        f.emit(OP.STORE, T_VOID, inThen, REF_NONE, sel);
        this.close();                     // seldone
        c = f.emit(OP.LOAD, T_BOOL, REF_NONE, REF_NONE, sel);
      } else {
        c = this.gtst(this.gexpr());
      }
      this.skip(RPAR);
      this.open(OP.IF, 'if', c);
      this.pushScope();
      this.block();
      this.popScope();
      /* then 那一半读完了 —— 这儿正是 `thenHi` 的定义：编号到此为止的都在 then 里。 */
      if (this.pass1) r.thenHi = this.labelCount;
      if (this.tok === TOK_ELSE) {
        this.next();
        this.elseHalf();
        this.pushScope();
        this.block();
        this.popScope();
      }
      this.close();
      return;
    }

    if (t === TOK_WHILE) {
      // BLOCK{ LOOP{ BRIF !cond ^break; body; BR ^continue } } —— 与 from_oir.js:251 同形
      this.next();
      this.open(OP.BLOCK, 'break', REF_NONE);
      this.open(OP.LOOP, 'continue', REF_NONE);
      /* 里面有标签：被重新进入时要**跳过测条件**，直接落进循环体。测条件在 LOOP 里面，
       * 所以这个跳过每一圈都重新判断 —— 到了标签那儿状态清零，下一圈就照常测。 */
      const skip = this.headSkip(r);
      this.skip(LPAR);
      const c = this.gtst(this.gexpr());
      this.skip(RPAR);
      const nc = this.f.emit(OP.NOT, T_BOOL, c, REF_NONE, 0);
      this.f.emit(OP.BRIF, T_VOID, nc, REF_NONE, this.levelOf('break'));
      if (skip) this.close();
      this.pushScope();
      this.block();
      this.popScope();
      this.f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('continue'));
      this.close();
      this.close();
      return;
    }

    if (t === LBRACE) {
      this.next();
      /* 里面有标签的复合语句要一台**分派**：状态落在哪个直接子语句的区间里，就把控制
       * 送到那条子语句的开头（`openSegs`/`segCut`）。它没有「头」要跳过，所以状态 0
       * 与状态非 0 走的是同一台分派。
       * switch 的函数体多一件事：case 的那台分派也在这儿发（`switchStmt` 把选择子
       * 挂在 `pendingSwitch` 上交过来），于是两台分派共用同一串嵌套 `BLOCK`。 */
      const sw = this.pendingSwitch;
      this.pendingSwitch = null;
      const d = this.reentry(r) ? this.openSegs(r, sw) : null;
      if (sw !== null && d === null) this.err('internal: switch 的段界没接上');
      this.pushScope();
      /* tcc 的复合语句循环（`tccgen.c:7243-7248`）：先试声明，不是声明才当语句。
       * 「声明和语句可以交替出现」（C99）就是这个循环的形状带来的。 */
      while (this.tok !== RBRACE) {
        this.decl(false);
        if (this.tok !== RBRACE) {
          if (d !== null) this.segCut(d);
          this.block();
        }
      }
      this.next();
      this.popScope();
      if (d !== null) this.closeSegs(d);
      return;
    }

    if (t === TOK_RETURN) {
      this.next();
      const hasVal = btype(this.funcRet.t) !== VT_VOID;
      if (this.tok !== SEMI) {
        const v = this.gexpr();
        if (isStruct(this.funcRet.t)) {
          /* 返回 struct：拷进调用方划好的那块地方，再把那个地址返回（第十一片的 ABI）。
           * 拷贝在 `emitEpilogue` **之前** —— 返回值可能就在自己的帧上（`return s;`），
           * 先把 `$sp` 还回去再拷会拷一块已经归还的栈。 */
          const dst = sMem(this.funcRet, this.sretRef, 0);
          this.structCopy(dst, v);
          this.emitEpilogue();
          this.f.emit(OP.RET, T_I64, this.sretRef, REF_NONE, 0);
        } else if (hasVal) {
          // `gen_assign_cast(&func_vt)`（`tccgen.c:7263`）：按返回类型转换
          const cv = this.castTo(v, this.funcRet);
          const r = this.gv(cv);
          /* 收场在 RET **之前**：返回值已经算完了（它可能读了帧上的东西），
           * 这时把 `$sp` 还回去才安全。反过来（先还再算）会让 `return *&x` 读到
           * 已经归还的那段栈 —— 那种错在解释器上看不出来，在真的栈上是随机的。 */
          this.emitEpilogue();
          this.f.emit(OP.RET, mirTypeOf(this.funcRet), r, REF_NONE, 0);
        } else {
          if (btype(v.ty.t) !== VT_VOID) this.cpp.warn('void function returns a value');
          this.emitEpilogue();
          this.f.emit(OP.RET, T_VOID, REF_NONE, REF_NONE, 0);
        }
      } else if (hasVal) {
        /* `int f() { return; }` —— tcc 只警告（`tccgen.c:7272`），返回值是垃圾。
         * MIR 要一个值，补 0；这与「垃圾」不同，所以照 tcc 出一条警告。 */
        this.cpp.warn("'return' with no value");
        this.emitEpilogue();
        this.f.emit(OP.RET, mirTypeOf(this.funcRet),
          this.konst(this.funcRet, 0), REF_NONE, 0);
      } else {
        this.emitEpilogue();
        this.f.emit(OP.RET, T_VOID, REF_NONE, REF_NONE, 0);
      }
      this.skip(SEMI);
      return;
    }

    if (t === TOK_BREAK) {
      this.next();
      const lv = this.levelOf('break');
      if (lv < 0) this.err('cannot break');
      this.vlaLeave(lv);
      this.f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, lv);
      this.skip(SEMI);
      return;
    }

    if (t === TOK_CONTINUE) {
      this.next();
      const lv = this.levelOf('continue');
      if (lv < 0) this.err('cannot continue');
      this.vlaLeave(lv);
      this.f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, lv);
      this.skip(SEMI);
      return;
    }

    if (t === TOK_FOR) {
      this.forStmt(r);
      return;
    }

    if (t === TOK_DO) {
      // BLOCK{ LOOP{ BLOCK{ body }; BRIF cond ^loop } } —— continue 落在里层 BLOCK 的
      // 末尾，于是它先去测条件，正是 do-while 的 continue 语义。
      this.next();
      this.open(OP.BLOCK, 'break', REF_NONE);
      this.open(OP.LOOP, 'loop', REF_NONE);
      this.open(OP.BLOCK, 'continue', REF_NONE);
      this.pushScope();
      this.block();
      this.popScope();
      this.close();
      this.skip(TOK_WHILE);
      this.skip(LPAR);
      const c = this.gtst(this.gexpr());
      this.skip(RPAR);
      this.skip(SEMI);
      this.f.emit(OP.BRIF, T_VOID, c, REF_NONE, this.levelOf('loop'));
      this.close();
      this.close();
      return;
    }

    if (t === TOK_SWITCH) return this.switchStmt(r);
    if (t === TOK_CASE || t === TOK_DEFAULT) {
      /* `case v:` / `default:` 自己就是一条语句，而且它是一处**段界** —— 与「里面有标签的
       * 子语句」同一件事，所以两者共用 `kids`（见 `block` 那个包装与 `openSegs`）。 */
      r.isCase = true;
      return this.caseLabel(t);
    }

    if (t === TOK_GOTO) {
      this.next();
      /* `goto *表达式`（GNU 的计算跳转）：状态槽本来就是「下一个要去的标签编号」，
       * 所以这一格就是「把算出来的那个值写进状态槽」—— 与写死的 `goto name` 只差
       * 编号是常量还是算出来的。 */
      if (this.tok === STAR) {
        this.next();
        const v = this.gexpr();
        this.skip(SEMI);
        this.gotoPtr(v);
        return;
      }
      const name = this.identName();
      this.skip(SEMI);
      this.gotoStmt(name);
      return;
    }

    if (t === SEMI) {
      this.next();
      return;
    }

    /* `__asm__(…)` 当语句（`tccgen.c:7465`）。它在语句这一层，不是表达式 —— 所以要在
     * 落到 `exprStmt()` 之前认掉。 */
    if (t === TOK_ASM1 || t === TOK_ASM2 || t === TOK_ASM3) {
      this.asmInstr();
      return;
    }

    /* GNU 的**块局部标签**声明 `__label__ a, b;`（`tccgen.c:7226` 一带）。
     * 我们的标签是**函数一份**的编号（见 `gotoStmt` 头上那段），所以这儿只把名字读掉。
     * 可观察的差别只有「同名标签在两个块里各算一个」那一种 —— 那要给标签也摆一层
     * 作用域，还没到；撞上了会是「重复的标签」，不会静悄悄跳错地方。 */
    if (t === TOK_LABEL) {
      this.next();
      for (;;) {
        this.identName();
        if (this.tok !== COMMA) break;
        this.next();
      }
      this.skip(SEMI);
      return;
    }

    /* `name :` 是语句标签（`tccgen.c:7376`：tcc 也是看下一个记号是不是 `:`）。
     * 猜错了要把名字**交回去**，`ungetTok` 就是为这一格存在的（funcDecl 的 `(void)`
     * 同一手法）。标识符自己没有 tokc，所以推回去不丢信息。 */
    if (t >= TOK_UIDENT) {
      const name = this.cpp.tokStr(t, null);
      this.next();
      if (this.tok === COLON) {
        this.next();
        this.labelStmt(name);
        /* 标签后面**必须**跟一条语句（C11 6.8.1），`}` 之前的 `foo: }` 不合法；
         * 但 `foo: ;` 合法而且常见，所以这儿只是照常读下一条。
         *
         * 语句表达式的值靠「深度」认（`exprStmt`），而 `({ lab: q; })` 的值就是 `q` ——
         * tcc 那边这是自然的（值是「vtop 上剩的那个」，标签不动栈），我们是结构化地数层，
         * 所以把**那一帧记的深度**往里挪一格，让被标着的那条语句照样算「直接长在这一层」。
         * 挪的是帧、不是 `blockDepth`：后者还被 `case` 的「是不是 switch 的直接子语句」
         * （第十五片）与那台 case 预扫描用着，`_default: default:` 那种写法一动就错。 */
        if (this.tok === RBRACE) this.expect('statement');
        const se = this.seStack.length === 0 ? null : this.seStack[this.seStack.length - 1];
        const bump = se !== null && se.depth === this.blockDepth;
        if (bump) se.depth++;
        this.block();
        if (bump) se.depth--;
        return;
      }
      this.cpp.ungetTok(t);
      this.tok = this.cpp.tok;
      this.tokc = this.cpp.tokc;
    }

    this.exprStmt();
  }

  /* ---------------------------------------------------------- 标签与 goto
   *
   * ## 为什么它是这一刀里最绕的一个
   *
   * `goto` 是**任意跳转**，而我们没有跳转（文件头偏离 2）。wasm 那套结构化控制流里能
   * 表达它的只有一个形状：一台**状态机** —— 一个 `LOOP`、一个状态槽，
   * `goto Li` = 「写状态、回到循环开头」，循环开头按状态把控制送回去。
   *
   * 第十片只做到「标签直接长在某个复合语句的语句层上，而且 `goto` 在那个块里面」：
   * 每个带标签的块自己一台状态机，一个标签关掉一层 `BLOCK`。两条边界卡在那儿 ——
   * 跳到兄弟块里的标签（`goto inner` 进一个 for 的循环体），以及标签长在里层的
   * `if`/`while` 里（Duff's device 那种）。这一片（第二十四片）把它们一起补掉。
   *
   * ## 一台状态机 + 一条分派链
   *
   * 关键的换法有两处：
   *
   * 1. **状态机只有一台，在函数那一层**（`runBody`）。`goto` 不再挑「哪个外围块」，
   *    永远是「写状态、`BR` 到函数那圈 `LOOP`」。往前跳、往后跳、跳进跳出，一个形状。
   * 2. **每条「里面有标签」的语句都要能被重新进入**。函数那一层的分派只能把控制送到
   *    函数体的直接子语句上，再往里就得靠下一层自己接。于是每种语句各出一小段：
   *    - 复合语句：一台分派（`openSegs`/`segCut`），状态落在哪个子语句的区间里就送到
   *      那条子语句的开头。这就是第十片那台状态机，只是**段的边界从「标签」变成
   *      「里面有标签的子语句」**，而且它不再自带 `LOOP`。
   *    - `while` / `for`：把「测条件」（和 `for` 的初始化）**跳过**（`headSkip`），
   *      直接落进循环体 —— 重新进入时不能重跑那些副作用。
   *    - `if`：条件变成「state == 0 ? cond : state <= thenHi」，于是能直接进对的那一半。
   *    - `L: 语句`：到了就把状态清零（`labelStmt`），此后一切照常。
   *    - `do-while`：循环体就在最前面，什么都不用跳过。
   *    - `switch`（第二十五片）：case 的段界与标签的段界摆在**同一串**嵌套 `BLOCK` 上，
   *      两台分派都由函数体那一层发（`openSegs`）；选择子落在一个槽上，重新进入时整段
   *      求值跳过。
   *
   * 「状态落在谁里面」为什么只是一次比较：标签编号按**定义的源码顺序**从 1 起，
   * 而一条语句占一段连续的源码，所以它里面的标签编号一定是连续区间 `(lo, hi]`
   * （见 `block` 那个包装）。同一层的兄弟子语句的区间又是**递增且相接**的，
   * 于是分派就是一串 `state <= hi_i`。
   *
   * 代价是诚实的：`goto` 一次要重走一遍分派链（深度那么多次比较），而
   * tinycc 里那些 `goto redo;` 都很浅。前向引用照旧**白拿**函数体本来就有的那两遍
   * （见 `finishFunc`）：第一遍量区间，第二遍按同一个语句序号取回来。
   */

  /**
   * 里面有标签的复合语句开场：摆好 k+1 层 `BLOCK`、发分派、关掉 `entry`。
   *
   * `r.kids` 是第一遍量出来的**段界**：里面有标签的直接子语句，加上 `case`/`default`
   * （它们也是直接子语句）。第 i 个段界的层数是 `i+1`，最里层（0）是第一处段界之前那一段。
   *
   * 分派分两截：
   *   1. 状态非 0 -> 按区间送到那条带标签的子语句。区间判断用一次**无符号**比较：
   *      `(unsigned)(state - 1) <= hi_i - 1`。状态 0 会变成 0xFFFFFFFF，一条都不中，
   *      于是「状态 0」不必单独测一次。
   *   2. 落到这儿说明状态是 0（正常进来）：switch 就发 case 那台分派（它末尾是无条件的），
   *      不是 switch 就 `BR` 到 `entry`。
   */
  openSegs(r, sw) {
    const f = this.f;
    const kids = r.kids;
    const k = kids.length;
    if (k === 0) this.err('internal: 有标签的块却没有段界');
    /* 比较全在**开 BLOCK 之前**发：MIR 是 SSA，区域外面发的 ref 在里面照样可用，
     * 反过来（在一个已经关掉的区域里发）就要读者自己去论证支配关系了。 */
    const st = f.emit(OP.LOAD, T_I32, REF_NONE, REF_NONE, this.gotoSlot);
    const d = f.emit(OP.SUB, T_I32, st, this.mod.consts.i32(1), 0);
    const tests = [];
    for (let i = 0; i < k; i++) {
      if (kids[i].hi <= kids[i].lo) { tests.push(-1); continue; }
      tests.push(f.emit(OP.ULE, T_I32, d, this.mod.consts.i32(kids[i].hi - 1), 0));
    }
    let selRef = REF_NONE;
    if (sw !== null) selRef = f.emit(OP.LOAD, mirTypeOf(sw.ty), REF_NONE, REF_NONE, sw.slot);

    for (let i = 0; i <= k; i++) this.open(OP.BLOCK, 'seg', REF_NONE);
    for (let i = 0; i < k; i++) {
      if (tests[i] >= 0) f.emit(OP.BRIF, T_VOID, tests[i], REF_NONE, i + 1);
    }
    if (sw === null) {
      f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, 0);
    } else {
      /* case 的层数：源码顺序里第 j 个 case 标签，就是第 j 个 `isCase` 段界 ——
       * 这是「直接长在 switch 函数体上」的那些。
       *
       * 长在里层的（Duff's device，第十五片）没有自己的段界，改用一层**蹦床**：
       * 蹦床开在 entry 里面（分派在最里层发），跳到它 = 「写状态、`BR` 回函数那圈
       * LOOP」，此后就与一条 `goto` 走的是同一条路 —— 函数体那条分派链一层一层把控制
       * 送进去，到了那个 case 处 `arriveLabel` 把状态清零。
       *
       *   BLOCK t0            ← 第一个里层 case
       *    BLOCK t1
       *      分派（要么送到段界，要么送到某层蹦床）
       *    END t1  → state = id1; BR gotoloop
       *   END t0   → state = id0; BR gotoloop
       *
       * 多开了 T 层，所以段界的层数要 +T（那几条区间判断在开蹦床**之前**就发完了，
       * 不受影响）。 */
      const nest = sw.nest ?? [];
      const T = nest.length;
      for (let j = 0; j < T; j++) this.open(OP.BLOCK, 'tramp', REF_NONE);
      const caseAt = [];
      for (let i = 0; i < k; i++) if (kids[i].isCase) caseAt.push(i + 1 + T);
      if (caseAt.length + T !== sw.labels.length) {
        this.err('internal: case 的段界数与扫出来的不符');
      }
      const trampOf = new Map();
      for (let j = 0; j < T; j++) trampOf.set(nest[j].idx, T - 1 - j);
      let defLevel = this.levelOf('break');
      let at = 0;
      for (let j = 0; j < sw.labels.length; j++) {
        const lv = trampOf.has(j) ? trampOf.get(j) : caseAt[at++];
        sw.labels[j].lv = lv;
        if (sw.labels[j].def) defLevel = lv;
      }
      this.dispatch(selRef, sw.ty, sw.labels, defLevel, sw.labels.length);
      for (let j = T - 1; j >= 0; j--) {
        this.close();
        f.emit(OP.STORE, T_VOID, this.mod.consts.i32(nest[j].id), REF_NONE, this.gotoSlot);
        f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('gotoloop'));
      }
    }
    this.close();                     // entry：立刻关掉
    return { kids, next: 0 };
  }

  /** 下一条语句是一处段界（里面有标签，或者它是 `case`/`default`）-> 关掉一层。 */
  segCut(d) {
    const nr = this.stmtRanges[this.stmtNo];
    if (nr === undefined || (nr.hi <= nr.lo && !nr.isCase)) return;
    if (d.next >= d.kids.length) this.err('internal: 段数与第一遍量的不符');
    d.next++;
    this.close();
  }

  /** 收场：k+1 层里 `entry` 与 k 个段各关过一次，所以这儿只对账。 */
  closeSegs(d) {
    if (d.next !== d.kids.length) this.err('internal: 段数与第一遍量的不符');
  }

  /**
   * 「被状态机重新进入时跳过这一段」：开一层 `BLOCK`，状态非 0 就直接跳到它的末尾。
   * 回 true 表示开了一层，调用方读完那一段要 `close()`。
   */
  headSkip(r) {
    if (!this.reentry(r)) return false;
    const f = this.f;
    const st = f.emit(OP.LOAD, T_I32, REF_NONE, REF_NONE, this.gotoSlot);
    const nz = f.emit(OP.NE, T_I32, st, this.mod.consts.i32(0), 0);
    this.open(OP.BLOCK, 'skiphead', REF_NONE);
    f.emit(OP.BRIF, T_VOID, nz, REF_NONE, 0);
    return true;
  }

  /** `name :` —— 第一遍给它编号，第二遍是「到了就把状态清零」。 */
  labelStmt(name) {
    if (this.pass1) {
      if (this.labelIds.has(name)) this.err(`duplicate label '${name}'`);
      this.labelIds.set(name, ++this.labelCount);
      return;
    }
    this.arriveLabel(this.labelIds.get(name));
  }

  /**
   * 「控制到了编号为 id 的这个标签处」。语句标签（`labelStmt`）与长在里层的 `case`
   * （第十五片）共用它 —— 后者在状态机眼里就是一个没有名字的标签。
   */
  arriveLabel(id) {
    if (this.gotoSlot < 0) this.err('internal: 有标签却没摆状态机');
    const f = this.f;
    /* 状态正好是这个标签 = 「分派把控制送到这儿了」，清零，此后一切照常。
     * 状态是别的（更里层的标签）就原样留着，交给里面那一层的分派。
     * 顺着掉进来（状态本来就是 0）走的是同一条路，什么都不做。 */
    const st = f.emit(OP.LOAD, T_I32, REF_NONE, REF_NONE, this.gotoSlot);
    const ne = f.emit(OP.NE, T_I32, st, this.mod.consts.i32(id), 0);
    this.open(OP.BLOCK, 'arrive', REF_NONE);
    f.emit(OP.BRIF, T_VOID, ne, REF_NONE, 0);
    f.emit(OP.STORE, T_VOID, this.mod.consts.i32(0), REF_NONE, this.gotoSlot);
    this.close();
  }

  /** `goto name;` —— 写状态、回到函数那圈 `LOOP` 的开头，让分派链把控制送过去。 */
  gotoStmt(name) {
    if (this.pass1) return;
    const id = this.labelIds.get(name);
    if (id === undefined) {
      /* 语句表达式自带一台状态机（见 `stmtExpr`），跳到外面那台上的标签它做不到。 */
      if (this.seOuterIds !== null && this.seOuterIds.has(name)) {
        this.err(`goto '${name}' out of a statement expression is not supported`);
      }
      this.err(`label '${name}' used but not defined`);
      return;
    }
    this.vlaLeaveAll();
    this.f.emit(OP.STORE, T_VOID, this.mod.consts.i32(id), REF_NONE, this.gotoSlot);
    this.f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('gotoloop'));
  }

  /** `goto *p;` —— 同上，只是编号是算出来的（状态槽是 i32，所以那个「地址」要收口）。 */
  gotoPtr(v) {
    if (this.pass1) return;
    if (this.gotoSlot < 0) this.err('internal: 计算跳转却没摆状态机');
    const st = this.gv(this.castTo(v, TY_INT));
    this.vlaLeaveAll();
    this.f.emit(OP.STORE, T_VOID, st, REF_NONE, this.gotoSlot);
    this.f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('gotoloop'));
  }

  /**
   * `&&label` 的值（第八刀第三十一片）。我们的 `goto` 是「状态槽 + 分派链」，标签本来
   * 就有一个编号（`labelIds`），所以这个「地址」就是那个编号 —— 于是它是**编译期常量**，
   * `static void *t[] = { &&l1, &&l2 };` 也就跟着成立，不需要往 data 段里放重定位。
   *
   * 第一遍还在给标签编号（`labelStmt`），这时候前向引用的那些还没有号 —— 回 0。
   * 第一遍发出来的指令是丢掉的，所以 0 不会被谁看见。
   */
  labelValue(name) {
    if (this.pass1) return 0;
    const id = this.labelIds.get(name);
    if (id === undefined) {
      this.err(`label '${name}' used but not defined`);
      return 0;
    }
    return id;
  }

  /**
   * `switch`（`tccgen.c` 的 `TOK_SWITCH` 那一支 + `gcase`）。
   *
   * ## 为什么它是这一片里最不一样的一个
   *
   * tcc 的 switch 是「先把每个 case 记成一条待回填的跳转，最后统一 patch」。我们**没有
   * 跳转也不回填**（文件头偏离 2），所以要另一个形状 —— wasm 那个「层层嵌套的 block」：
   *
   * ```
   * BLOCK break
   *  BLOCK L3          ← 第三个标签
   *   BLOCK L2
   *    BLOCK L1        ← 第一个标签，最里层
   *      分派（BRTABLE 或者一串比较）
   *    END             ← 跳到这儿 = 第一个标签的代码
   *    第一个标签的代码
   *   END              ← 第二个标签
   *   第二个标签的代码
   *  END
   *  第三个标签的代码
   * END                ← break 跳到这儿
   * ```
   *
   * 妙处是**贯穿（fallthrough）自动就对**：第一个标签的代码走完自然落到 `END L2`
   * 后面，也就是第二个标签的代码。C 的 switch 默认贯穿，而这个形状不用为它写一行。
   * 「一个标签 = 关掉一层 block」于是成了 `caseLabel` 的全部内容。
   *
   * 代价是**分派要在函数体之前发**，而那时还不知道有几个标签 —— 一遍过又撞上同一堵墙。
   * 办法还是第三片那一套：函数体的记号整块收下来，先扫一遍收标签，再放一遍真的做。
   * 扫那一遍**只走记号**（`scanCases`），所以不声明局部量、不占帧、不发指令。
   */
  switchStmt(r) {
    /* 里面有语句标签的 switch 走**合流**那一路（第二十五片）：case 的段界与标签的段界
     * 摆在同一串嵌套 `BLOCK` 上，两台分派都由函数体那一层发（`openSegs`）。这儿要多做
     * 两件事：选择子落在一个槽上（重新进入时那一段被跳过，SSA 的 ref 就不能用了），
     * 以及被重新进入时**跳过选择子的求值**（不能重跑副作用）。 */
    const merged = this.reentry(r);
    this.next();
    this.skip(LPAR);
    if (merged) this.open(OP.BLOCK, 'break', REF_NONE);
    const skipSel = merged ? this.headSkip(r) : false;
    /* 控制表达式先做整型提升（C11 6.8.4.2 第 5 段），case 的值随后按这个类型收口。
     * 在开 block **之前**求值：它只在分派里用一次，而放在外面读起来就是 tcc 的顺序。 */
    const sel = this.promote(this.gexpr());
    if (!isInteger(sel.ty.t)) {
      this.err(`switch quantity is not an integer ('${typeText(sel.ty)}')`);
    }
    const selRef = this.gv(sel);
    let selSlot = -1;
    if (merged) {
      selSlot = this.temp(mirTypeOf(sel.ty), 'sel');
      this.f.emit(OP.STORE, T_VOID, selRef, REF_NONE, selSlot);
    }
    if (skipSel) this.close();
    this.skip(RPAR);

    /* 体不是花括号也行（C11 6.8.4：`switch (expr) statement`）—— `captureStmtBraced`
     * 替它补一对花括号，下面这一整套（扫标签、再放一遍）于是一个字都不用改。 */
    const body = this.cpp.captureStmtBraced();
    const afterTok = this.cpp.tok;
    const afterVal = this.cpp.tokc;

    // ---- 扫一遍：标签按**源码顺序**排成一列
    const labels = this.scanCases(body, sel.ty);
    const k = labels.length;

    if (!merged) {
      /* 兜底跳到哪儿：有 `default` 就是它那一层，没有就是 break 那一层（= 跳出去）。 */
      let defLevel = k;
      for (let i = 0; i < k; i++) if (labels[i].def) defLevel = i;
      // ---- 摆好 block，发分派
      this.open(OP.BLOCK, 'break', REF_NONE);
      for (let i = k - 1; i >= 0; i--) this.open(OP.BLOCK, 'case', REF_NONE);
      this.dispatch(selRef, sel.ty, labels, defLevel, k);
    } else {
      /* 长在里层的那些 case（第十五片）：它们在第一遍里已经领到了标签编号，
       * 现在把编号交给 `openSegs` —— 那儿给每个这样的 case 发一小段蹦床
       * 「写状态、`BR` 回函数那圈 LOOP」。 */
      this.pendingSwitch = { slot: selSlot, ty: sel.ty, labels, nest: r.caseNest ?? [] };
    }

    // ---- 再放一遍：真的做
    this.swStack.push({ left: k, merged, k, r, childDepth: this.blockDepth + 2, nested: 0 });
    this.cpp.pushTokens(body);
    this.next();
    this.block();
    if (this.tok !== TOK_EOF) this.err('internal: switch 的函数体没读完');
    this.cpp.endMacro();
    const st = this.swStack.pop();
    if (st.left !== 0) this.err('internal: switch 的标签数与扫出来的不符');
    /* 第一遍的形状是假的（发出去的指令扔掉），可**区域要平**：长在里层的 case 没有
     * 关掉自己那一层，剩下的在这儿一起关。第二遍不欠 —— 那儿根本没开这些层。 */
    if (this.pass1) for (let i = 0; i < st.nested; i++) this.close();

    this.close();      // break
    this.cpp.tok = afterTok;
    this.cpp.tokc = afterVal;
    this.tok = afterTok;
    this.tokc = afterVal;
  }

  /**
   * `case v:` / `default:` —— 在上面那个形状里，一个标签**就是**「关掉一层 block」。
   * 值在扫那一遍已经收过了，这一遍只需要把记号吃掉。
   */
  caseLabel(t) {
    const st = this.swStack[this.swStack.length - 1];
    if (st === undefined) {
      this.err(`'${t === TOK_CASE ? 'case' : 'default'}' label not within a switch`);
      return;
    }
    this.next();
    if (t === TOK_CASE) {
      this.constExpr();
      // `case 1 ... 5:` 的上界也要读掉（值在扫那一遍收过了，第四十七片）
      if (this.tok === TOK_DOTS) {
        this.next();
        this.constExpr();
      }
    }
    this.skip(COLON);
    /* 直接长在 switch 函数体上的 case = 「关掉一层 block」（上面那个形状）。
     * 长在里层的 `if`/`while`/`do` 里（Duff's device，第十五片）就不行 —— 那一层不是
     * 它的。这种 case 在状态机眼里**就是一个没有名字的标签**：第一遍领一个编号
     * （于是外面每一层「里面有标签」的语句都自动变得可以被重新进入），
     * 第二遍是「到了就把状态清零」，而分派那边由 `openSegs` 发一小段蹦床送过来。 */
    const nested = this.blockDepth !== st.childDepth;
    const idx = st.k - st.left;
    st.left--;
    if (this.pass1) {
      if (nested) {
        const id = ++this.labelCount;
        st.nested++;
        if (st.r.caseNest === undefined) st.r.caseNest = [];
        st.r.caseNest.push({ idx, id });
      } else if (!st.merged) {
        this.close();
      }
      return;
    }
    if (nested) {
      const e = (st.r.caseNest ?? []).find((x) => x.idx === idx);
      if (e === undefined) this.err('internal: 里层的 case 在第一遍没领到编号');
      this.arriveLabel(e.id);
      return;
    }
    /* 合流那一路上「关掉一层」已经由 `segCut` 在解析这条语句**之前**做过了。 */
    if (!st.merged) this.close();
  }

  /**
   * 分派：把控制表达式的值送到某一层。两条路，和 tcc 的密集化判断同一个判断
   * （`tccgen.c` 的 `gcase`：值排好序之后看「一段连续区间里够不够密」）。
   *
   *   - **密**：`BRTABLE`。下标是 `v - min`，表里第 i 格是「值 min+i 该去哪一层」，
   *     没有 case 的格子填兜底。BRTABLE 的下标按**无符号**与表长比（ir.js:301），
   *     所以 `v < min` 会绕成一个大数、自动落到兜底 —— 但我们还是先发一条区间检查：
   *     64 位的值截到 32 位下标时，差 2^32 的两个值会撞在同一格。
   *   - **疏**：一串 `BRIF (v == ci) -> 那一层`，最后一条 `BR -> 兜底`。
   *     `case 1: case 1000000:` 走这条 —— 密集表会是 4 MB。
   */
  dispatch(selRef, ty, labels, defLevel, k) {
    const f = this.f;
    const mt = mirTypeOf(ty);
    const vals = [];
    for (let i = 0; i < k; i++) {
      /* 层数默认就是下标（第十片那个形状：一个标签一层）。合流那一路上段界里还夹着
       * 语句标签，层数不再等于下标，于是由调用方填 `lv`（见 `openSegs`）。 */
      if (!labels[i].def) {
        vals.push({
          v: labels[i].val,
          /* `case 1 ... 5:` 收成闭区间（第四十七片）；单个值就是 `hi === v`。 */
          hi: labels[i].hi === undefined ? labels[i].val : labels[i].hi,
          lv: labels[i].lv === undefined ? i : labels[i].lv,
        });
      }
    }
    if (vals.length === 0) {
      f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, defLevel);
      return;
    }
    let min = vals[0].v;
    let max = vals[0].hi;
    let covered = 0n;
    for (const c of vals) {
      if (c.v < min) min = c.v;
      if (c.hi > max) max = c.hi;
      covered += c.hi - c.v + 1n;
    }
    const span = max - min + 1n;
    /* 密集的门槛：表不超过 1024 格，而且平均每格至少有 1/8 个 case。两个数都是取舍，
     * 写在这儿而不是散在判断里 —— 改门槛只改这两个字面量。数的是**覆盖到的值**
     * 而不是标签数：`case 0 ... 99:` 一条标签就把 100 格填满了。 */
    const dense = span <= 1024n && span <= covered * 8n;
    if (dense) {
      const uty = isUnsigned(ty.t) ? ty : (mt === T_I64 ? TY_ULLONG : TY_UINT);
      let d = selRef;
      if (min !== 0n) d = f.emit(OP.SUB, mt, selRef, this.konst(ty, min), 0);
      // 区间检查：`(unsigned)(v - min) > span - 1` 就走兜底
      const over = f.emit(OP.UGT, mt, d, this.konst(uty, span - 1n), 0);
      f.emit(OP.BRIF, T_VOID, over, REF_NONE, defLevel);
      // 下标收成 i32：区间检查过了，所以截断是安全的
      const idx = mt === T_I64 ? f.emit(OP.CVT, T_I32, d, REF_NONE, CVT_TRUNC) : d;
      const table = [];
      for (let i = 0n; i < span; i++) {
        let lv = defLevel;
        for (const c of vals) if (c.v <= min + i && min + i <= c.hi) lv = c.lv;
        table.push(lv);
      }
      f.emit(OP.BRTABLE, T_VOID, idx, f.pushLevels(table), defLevel);
      return;
    }
    const uty = isUnsigned(ty.t) ? ty : (mt === T_I64 ? TY_ULLONG : TY_UINT);
    for (const c of vals) {
      if (c.v === c.hi) {
        const eq = f.emit(OP.EQ, mt, selRef, this.konst(ty, c.v), 0);
        f.emit(OP.BRIF, T_VOID, eq, REF_NONE, c.lv);
        continue;
      }
      /* 稀疏的那一路上一个区间是**一次**无符号比较（`(unsigned)(v - lo) <= hi - lo`），
       * 不是摊成 hi-lo+1 个相等比较 —— `case 0 ... 1000000:` 真实代码里有。 */
      let d = selRef;
      if (c.v !== 0n) d = f.emit(OP.SUB, mt, selRef, this.konst(ty, c.v), 0);
      const inRange = f.emit(OP.ULE, mt, d, this.konst(uty, c.hi - c.v), 0);
      f.emit(OP.BRIF, T_VOID, inRange, REF_NONE, c.lv);
    }
    f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, defLevel);
  }

  /**
   * 扫一遍 switch 的函数体，把标签按源码顺序收成一列。
   *
   * **只走记号**：不解析语句，于是不声明局部量、不占帧、不发一条指令 —— 这一点很要紧，
   * 因为帧的大小是在函数那一层的两遍里数出来的，这儿多数一次就会数歪。唯一真的要解析
   * 的是 `case` 后面那个常量表达式，而 `constExpr` 本来就不发指令。
   *
   * 里层 switch 的 case 属于它自己，所以整块跳过。
   */
  scanCases(body, ty) {
    const out = [];
    const bits = intBitsOf(ty);
    const uns = isUnsigned(ty.t);
    const seen = [];
    let hasDef = false;
    this.cpp.pushTokens(body);
    this.next();
    while (this.tok !== TOK_EOF) {
      const t = this.tok;
      if (t === TOK_SWITCH) {
        this.next();
        this.skipBalanced(LPAR, RPAR);
        this.skipStmtToks();
        continue;
      }
      if (t === TOK_CASE) {
        this.next();
        /* case 的值按控制表达式提升之后的类型收口（C11 6.8.4.2 第 5 段）——
         * 不收的话 `switch ((char)x) { case 256: }` 会挑不出重复。 */
        const raw = this.constExpr();
        const v = uns ? BigInt.asUintN(bits, raw) : BigInt.asIntN(bits, raw);
        /* `case 1 ... 5:` —— GNU 的范围（tcctest.c:1968，第四十七片）。收成一个闭区间，
         * 单个值就是 `lo === hi` 的那一种，于是分派那一步只有一套代码。 */
        let hi = v;
        if (this.tok === TOK_DOTS) {
          this.next();
          const raw2 = this.constExpr();
          hi = uns ? BigInt.asUintN(bits, raw2) : BigInt.asIntN(bits, raw2);
          if (hi < v) this.err('empty range in case');
        }
        this.skip(COLON);
        for (const s of seen) {
          if (v <= s.hi && s.lo <= hi) this.err(`duplicate case value '${v}'`);
        }
        seen.push({ lo: v, hi });
        out.push({ def: false, val: v, hi });
        continue;
      }
      if (t === TOK_DEFAULT) {
        this.next();
        this.skip(COLON);
        if (hasDef) this.err('multiple default labels in one switch');
        hasDef = true;
        out.push({ def: true, val: 0n });
        continue;
      }
      this.next();
    }
    this.cpp.endMacro();
    return out;
  }

  /** 吃掉一组配平的 `(…)` / `{…}`。当前记号必须是开的那个。 */
  skipBalanced(open, close) {
    if (this.tok !== open) this.expect(String.fromCharCode(open));
    let depth = 0;
    for (;;) {
      if (this.tok === TOK_EOF) this.err('unexpected end of file');
      if (this.tok === open) depth++;
      else if (this.tok === close) depth--;
      this.next();
      if (depth === 0) break;
    }
  }

  /**
   * 跳过一条语句（只走记号）。里层 switch 的体不是花括号时要它 ——
   * 规则与 `Cpp.captureStmtBraced` 那一份**同一套**：配平括号，深度 0 上的 `;` 或 `}`
   * 收尾，除非后面跟着 `else`，或者这条是 `do` 开头而后面跟着 `while`。
   */
  skipStmtToks() {
    if (this.tok === LBRACE) { this.skipBalanced(LBRACE, RBRACE); return; }
    let dos = 0;
    let depth = 0;
    for (;;) {
      if (this.tok === TOK_EOF) this.err('unexpected end of file');
      if (this.tok === LPAR || this.tok === LBRACK || this.tok === LBRACE) depth++;
      else if (this.tok === RPAR || this.tok === RBRACK || this.tok === RBRACE) depth--;
      else if (depth === 0 && this.tok === TOK_DO) dos++;
      const t = this.tok;
      this.next();
      if (depth !== 0 || (t !== SEMI && t !== RBRACE)) continue;
      if (this.tok === TOK_ELSE) continue;
      if (dos > 0 && this.tok === TOK_WHILE) { dos--; continue; }
      break;
    }
  }

  /**
   * GNU 的**语句表达式** `({ …; x; })`（`tccgen.c:5715`）：一整个复合语句当表达式用，
   * 值是**最后那条直接长在里面的表达式语句**的值；一条都没有就是 `void`。
   * 进来时 `(` 已经吃掉、`{` 在手上；出去时 `}` 已经吃掉（`)` 由调用方读）。
   *
   * 复合语句本身照原样交给 `stmt` 那一支去解析 —— 于是里面的声明、循环、标签、
   * 嵌套的 switch 全都免费。这一片要加的只有「把值捞出来」，而那一格在 `exprStmt` 里：
   * 它看栈顶那一帧记的深度，只有**直接**长在这一层的表达式语句才留值。
   *
   * 值能这么直接留下来，是因为没有标签的复合语句**不开 MIR 的 block**（见 `stmt` 的
   * `LBRACE` 那一支）：里面发的指令就在外面这条指令流上，所以最后那条表达式的 ref
   * 出了花括号照样能用。里面有标签、于是真开了 block 的那一种在下面钉住边界。
   *
   * tcc 在**常量表达式**里见到它是 `expect("constant")`；`sizeof(({…}))` 例外，
   * 那时不求值。我们的 `sizeof` 走的也是这条路（在一个用完就丢的函数里解析），
   * 所以这儿不必分辨 —— 常量那一路根本到不了这儿（`ceUnary` 见到 `{` 就报错）。
   */
  stmtExpr() {
    if (this.scopes.length <= 1) this.err('statement expression outside of function');
    /* `depth + 2`：下面那次 `block()` 把深度加到 +1（复合语句本身），
     * 它里面的每条子语句再各加一层，于是直接子语句落在 +2 上。 */
    const frame = {
      v: sVal(TY_VOID, REF_NONE), depth: this.blockDepth + 2,
      slotted: false, slot: -1, ty: TY_VOID, mt: T_VOID,
    };
    /* 里面有标签的复合语句要开一层 MIR block 摆那条分派链（第二十四片），而**块里定义的
     * ref 出了块就不能用**（MIR 是结构化控制流上的 SSA）。所以那一种得让值**落在槽上**：
     * 块里写、块外读 —— 槽是函数一份的，跨得过 END。
     *
     * 「里面有没有标签」第一遍就数好了（`stmtRanges`），第二遍在这儿提前问一次：
     * `block()` 用的序号正是现在的 `stmtNo`（它自己 `stmtNo++`），所以这一问不动它。 */
    /* 里面有标签的那一种要**自带一台状态机**（而不是挂在函数那台上），理由有两条：
     *
     * 1. 第一遍是 `blockBody` 把「有标签的子语句」push 进**外面那个块**的 `kids` 的，
     *    于是外面那个块会以为自己多了一条带标签的子语句、要给它切一段（`segCut`）——
     *    可是语句表达式长在**声明的初始化式**里，第二遍走不到那条语句的分派点上，
     *    两遍数出来的段数于是不一样。让它自己开一份 `kids`，外面就看不见了。
     * 2. gcc 明令禁止**跳进**语句表达式，所以里面的标签只可能被里面的 `goto` 用 ——
     *    一台局部的机器就够，而且它开的 `BLOCK`/`LOOP` 正好嵌在这一层里。
     *
     * 反过来「从里面跳到外面的标签」是 gcc 允许的：那要跨出这一层 `LOOP`，我们的
     * 状态机做不到（状态槽都不是同一个），所以下面把它明确报出来。 */
    const outerKids = this.kids;
    const outerIds = this.labelIds;
    const outerCount = this.labelCount;
    const outerSlot = this.gotoSlot;
    /* 「里面有没有标签」第一遍就数好了：`stmtRanges[stmtNo]` 正是下面那次 `block()`
     * 要用的那一条（它自己 `stmtNo++`），所以提前问一次不动它。
     * 那张局部标签表也得**跨两遍**活着（编号是第一遍给的、第二遍才用），所以按语句
     * 序号存在 `seLabels` 里 —— 跟 `stmtRanges` 一样的活法。 */
    const sn = this.stmtNo;
    const r = this.pass1 ? undefined : this.stmtRanges[this.stmtNo];
    const labeled = r !== undefined && r.hi > r.lo;
    frame.slotted = labeled;
    this.kids = [];
    if (this.pass1) {
      this.labelIds = new Map();
      this.seLabels.set(sn, this.labelIds);
    } else {
      const m = this.seLabels.get(sn);
      if (m === undefined) this.err('internal: 语句表达式的标签表丢了');
      this.labelIds = m;
    }
    this.labelCount = 0;
    this.gotoSlot = -1;
    this.seOuterIds = outerIds;
    if (labeled) {
      this.gotoSlot = this.temp(T_I32, 'state');
      this.f.emit(OP.STORE, T_VOID, this.mod.consts.i32(0), REF_NONE, this.gotoSlot);
      this.open(OP.BLOCK, 'gotoend', REF_NONE);
      this.open(OP.LOOP, 'gotoloop', REF_NONE);
    }
    this.seStack.push(frame);
    this.block();
    this.seStack.pop();
    if (labeled) {
      this.f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('gotoend'));
      this.close();      // gotoloop
      this.close();      // gotoend
    }
    this.kids = outerKids;
    this.labelIds = outerIds;
    this.labelCount = outerCount;
    this.gotoSlot = outerSlot;
    this.seOuterIds = null;
    if (!frame.slotted) return frame.v;
    if (frame.slot < 0) return sVal(TY_VOID, REF_NONE);
    const ld = this.f.emit(OP.LOAD, frame.mt, REF_NONE, REF_NONE, frame.slot);
    /* 聚合的那一种落在槽上的是**地址**（那块地方在帧上，帧不回收，所以出了块还在）。 */
    if (isStruct(frame.ty.t) || isArray(frame.ty.t)) return sMem(frame.ty, ld, 0);
    return sVal(frame.ty, ld);
  }

  /** 表达式语句：算完把值丢掉（`tccgen.c` 的 `expr: gexpr(); vpop();`）。 */
  exprStmt() {
    const v = this.gexpr();
    /* 语句表达式（`({ …; x; })`）里**直接**长在那一层的表达式语句要把值留下 ——
     * 最后一条留下的那个就是整条的值（tcc 的做法是 `vpop(); gexpr();`，
     * `tccgen.c:7511`：先丢掉上一条的，于是最后剩的自然是最后一条的）。 */
    const se = this.seStack.length === 0 ? null : this.seStack[this.seStack.length - 1];
    if (se !== null && se.depth === this.blockDepth) {
      if (!se.slotted) se.v = v;
      else if (btype(v.ty.t) !== VT_VOID) {
        /* 落在槽上的那一种（见 `stmtExpr`）：聚合存**地址**，标量存值。每条都新开一个槽 ——
         * 类型可以不一样（`({ 1; 1.5; })`），而只有最后一条那个会被读。 */
        const agg = isStruct(v.ty.t) || isArray(v.ty.t);
        const mt = agg ? T_I64 : mirTypeOf(v.ty);
        const slot = this.temp(mt, 'se');
        this.f.emit(OP.STORE, T_VOID, agg ? this.addrOf(v) : this.gv(v), REF_NONE, slot);
        se.slot = slot;
        se.ty = v.ty;
        se.mt = mt;
      }
    }
    this.skip(SEMI);
  }

  /**
   * `for`（`tccgen.c:7305`）。形状照 from_oir.js:266：
   *   BLOCK'break'{ init; LOOP'loop'{ BRIF !cond ^break; BLOCK'continue'{ body }; step; BR ^loop } }
   * 步进式**先收记号、循环体之后再放**（见文件头偏离 2 与 `Cpp.captureTokens`）。
   */
  forStmt(r) {
    const f = this.f;
    this.next();
    this.skip(LPAR);
    this.pushScope();
    this.open(OP.BLOCK, 'break', REF_NONE);

    /* 里面有标签：被重新进入时初始化式与测条件都要**跳过**。初始化式那一跳在循环
     * 外面（只可能发生一次），测条件那一跳在 LOOP 里面（每一圈都重新判断，
     * 到了标签那儿状态清零，下一圈就照常测）。 */
    const skipInit = this.headSkip(r);
    // 初始化：可以是声明（C99），也可以是表达式
    if (this.tok !== SEMI) {
      if (!this.decl(false)) this.exprStmt();
      // decl 自己吃掉了 `;`
    } else {
      this.next();
    }
    if (skipInit) this.close();

    this.open(OP.LOOP, 'loop', REF_NONE);
    const skipCond = this.headSkip(r);
    if (this.tok !== SEMI) {
      const c = this.gtst(this.gexpr());
      const nc = f.emit(OP.NOT, T_BOOL, c, REF_NONE, 0);
      f.emit(OP.BRIF, T_VOID, nc, REF_NONE, this.levelOf('break'));
    }
    if (skipCond) this.close();
    this.skip(SEMI);

    const stepStr = this.tok === RPAR ? null : this.cpp.captureTokens(RPAR);
    if (stepStr !== null) {
      // captureTokens 停在 `)` 上，它动的是 Cpp 的 tok —— 同步一下
      this.tok = this.cpp.tok;
      this.tokc = this.cpp.tokc;
    }
    this.skip(RPAR);

    this.open(OP.BLOCK, 'continue', REF_NONE);
    this.pushScope();
    this.block();
    this.popScope();
    this.close();

    if (stepStr !== null) this.replayStep(stepStr);
    f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('loop'));
    this.close();
    this.close();
    this.popScope();
  }

  /** 把收起来的步进式放回来解析一遍，然后把当前记号还原。 */
  replayStep(stepStr) {
    const savedTok = this.tok;
    const savedVal = this.tokc;
    this.cpp.pushTokens(stepStr);
    this.next();
    if (this.tok !== TOK_EOF) this.gexpr();
    if (this.tok !== TOK_EOF) this.err('internal: for 的步进式没读完');
    this.cpp.endMacro();
    this.cpp.tok = savedTok;
    this.cpp.tokc = savedVal;
    this.tok = savedTok;
    this.tokc = savedVal;
  }

  /* -------------------------------------------------------------- 声明 */

  /**
   * 当前记号是不是一个类型的开头（tcc 靠 `parse_btype` 试着读一遍来判断）。
   * 标识符要查 `typedef` 表 —— 这是 C 的语法**不是上下文无关**的那一处：`(T)*x` 是
   * 强制转换还是乘法，取决于 T 是不是一个类型名。路径 A 的 GLR 到这儿会两条都留着，
   * 而路径 B（这一条）与 tcc 一样靠符号表当场断。
   */
  isTypeStart(t) {
    if (t >= TOK_UIDENT) return this.tdefLookup(this.cpp.tokStr(t, null)) !== null;
    return t === TOK_INT || t === TOK_VOID || t === TOK_BOOL || t === TOK_SIGNED
      || t === TOK_UNSIGNED || t === TOK_CHAR || t === TOK_SHORT || t === TOK_LONG
      || t === TOK_FLOAT || t === TOK_DOUBLE || t === TOK_STRUCT || t === TOK_UNION
      || t === TOK_ENUM || t === TOK_TYPEDEF || t === TOK_EXTERN || t === TOK_STATIC
      || t === TOK_CONST || t === TOK_REGISTER || t === TOK_AUTO || t === TOK_VOLATILE
      || t === TOK_INLINE
      /* gcc 的拼法与那几个「吃掉就行」的（第八刀第十六片）。它们也能**打头** ——
       * `__attribute__((…)) int f(void);` 与 `__extension__ typedef …` 系统头里都有。 */
      || t === TOK_CONST1 || t === TOK_CONST2
      || t === TOK_VOLATILE1 || t === TOK_VOLATILE2
      || t === TOK_SIGNED1 || t === TOK_SIGNED2
      || t === TOK_INLINE1 || t === TOK_INLINE2
      || t === TOK_RESTRICT || t === TOK_RESTRICT1 || t === TOK_RESTRICT2
      || t === TOK_EXTENSION || t === TOK_ATOMIC
      || t === TOK_THREAD_LOCAL || t === TOK_THREAD
      /* `typeof(x) y;` 也是一条声明的开头，而 `(typeof(x))v` 是一次强制转换 ——
       * 两处都靠这一问（第五十一片）。 */
      || t === TOK_TYPEOF1 || t === TOK_TYPEOF2 || t === TOK_TYPEOF3
      || t === TOK_ATTRIBUTE1 || t === TOK_ATTRIBUTE2;
  }

  /**
   * tag 表里查/建一条（`struct_find` 与 `struct_add` 的合体，`tccgen.c:4269` 一带）。
   *
   * **一个 tag 只有一个 info 对象，全程不换**。这条纪律买到的是不完整类型：
   * `struct S *p;` 先拿到一个 `fields: null` 的空壳，后来 `struct S {…}` 往**同一个
   * 对象**里填成员，`p` 手上那份 CType 自动变完整。换成「定义时新建一个对象」就得
   * 回头去修所有已经发出去的类型 —— 一遍过时那是做不到的。
   */
  tagOf(kind, name, defining) {
    if (name !== null) {
      /* 定义（后面就是 `{`）只看**当前**这一层：外层有同名的 tag 也照样新建一个，
       * 那是 C 的遮蔽（`struct S` 在文件作用域，函数里再 `struct S {…}` 是两个类型）。
       * 引用则从里往外找 —— 这就是「作用域」这两个字的全部内容。 */
      const from = defining ? this.tagStack.length - 1 : 0;
      for (let i = this.tagStack.length - 1; i >= from; i--) {
        const hit = this.tagStack[i].get(name);
        if (hit !== undefined) {
          if (hit.kind !== kind) this.err(`'${name}' defined as wrong kind of tag`);
          return hit;
        }
      }
    }
    const info = {
      kind, name: name === null ? '<anonymous>' : name,
      anon: name === null,   // 没有 tag —— 「匿名成员」那一条要问它
      fields: null, size: 0, align: 1,
    };
    if (name !== null) this.tagStack[this.tagStack.length - 1].set(name, info);
    return info;
  }

  /** 进一层块：普通标识符、tag、枚举常量各推一层。三个必须同步，所以只有这一个入口。 */
  pushScope() {
    this.scopes.push(new Map());
    this.tagStack.push(new Map());
    this.ecStack.push(new Map());
    this.tdefStack.push(new Map());
    this.vlaStack.push({ sp: -1, regionLen: this.regions.length });
  }

  /** 出一层块。这一层里划过变长数组的话，`$sp` 在这儿收回去。 */
  popScope() {
    const v = this.vlaStack.pop();
    if (v !== undefined && v.sp >= 0) this.spRestore(v.sp);
    this.scopes.pop();
    this.tagStack.pop();
    this.ecStack.pop();
    this.tdefStack.pop();
  }

  /** 现在这一层的 typedef 表。 */
  tdefScope() {
    return this.tdefStack[this.tdefStack.length - 1];
  }

  /**
   * 这个名字现在是不是一个类型名。从里往外找，头一个有这个名字的那一层说了算 ——
   * 值是 `null` 就是「被一个普通标识符占了」，也就是**不是**类型名。
   */
  tdefLookup(name) {
    for (let i = this.tdefStack.length - 1; i >= 0; i--) {
      const hit = this.tdefStack[i].get(name);
      if (hit !== undefined) return hit;
    }
    return null;
  }

  /** 一个普通标识符占了这个名字 -> 在这一层把同名的 typedef 遮掉。 */
  tdefShadow(name) {
    if (this.tdefLookup(name) !== null) this.tdefScope().set(name, null);
  }

  /** 当前这一层的枚举常量表（登记与「重复的枚举常量」都只看这一层）。 */
  ecScope() {
    return this.ecStack[this.ecStack.length - 1];
  }

  /** 从里往外找一个枚举常量。 */
  ecLookup(name) {
    for (let i = this.ecStack.length - 1; i >= 0; i--) {
      const hit = this.ecStack[i].get(name);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  /**
   * `struct` / `union`（`struct_decl`，`tccgen.c:4269`）。进来时 `struct` 已经吃掉。
   *
   * 这一层只**收成员**（名字、类型、位域宽度、成员自己的属性），排布交给
   * `structLayout` —— 分开的理由见下面收成员那一段的注释：尾置的 `packed` 长在
   * 成员后面。
   */
  structDecl(union) {
    const kind = union ? 'union' : 'struct';
    /* tag 之前也能挂属性：`struct __attribute__((aligned(16))) S { … };`
     * （`tccgen.c:4459`，`struct_decl` 一进门就 `parse_attribute`）。 */
    const ad = { aligned: 0, packed: false };
    this.parseAttrs(ad);
    const name = this.tok >= TOK_UIDENT ? this.identName() : null;
    const info = this.tagOf(kind, name, this.tok === LBRACE);
    if (this.tok !== LBRACE) {
      /* 只是引用（`struct S x;` / `struct S *p;`）。不完整也照样给出去 —— 指针不需要
       * 大小，而「拿不完整类型当变量」由 declareLocal / declareGlobal 抓。 */
      if (name === null) this.err(`'${kind}' has no tag and no member list`);
      return mkStruct(info, union);
    }
    if (info.fields !== null) this.err(`redefinition of '${kind} ${info.name}'`);
    this.next();

    /* 成员**先收下来、后排布**（tcc 就是这个形状：`struct_decl` 收 `Sym` 链，
     * `}` 与尾置属性都读完了才叫 `struct_layout`，`tccgen.c:4688`）。第三十四片必须
     * 这么分：`struct { … } __attribute__((packed));` 的 packed 长在成员**后面**，
     * 边读边排的话前面那些成员的 off 已经定死了。 */
    /** @type {{name:string|null,ty:object,bits:number,anon:boolean,aligned:number,packed:boolean}[]} */
    const mems = [];
    const names = new Set();
    const dup = (n) => {
      if (names.has(n)) this.err(`duplicate member '${n}'`);
      names.add(n);
    };
    while (this.tok !== RBRACE) {
      if (this.tok === TOK_EOF) this.err("'}' expected");
      /* 成员表里认不出类型的那几格（`tccgen.c:4585-4592`）：`_Static_assert` 收下，
       * 孤零零的分号读掉（`struct empty_mem { ; int x; };` —— tcctest.c:700 那一格），
       * 别的就是 `';' expected`。 */
      if (this.tok === TOK_STATIC_ASSERT) {
        this.staticAssert();
        continue;
      }
      if (!this.isTypeStart(this.tok)) {
        this.skip(SEMI);
        continue;
      }
      /* 说明符那一段上的属性（`__attribute__((aligned(8))) int i, j;`）管**这一行的
       * 所有声明符**（tcc 的 `parse_btype` 收在同一个 `ad` 里，`tccgen.c:4919`）。 */
      const sad = { aligned: 0, packed: false };
      const spec = this.parseBtype(sad);
      if ((spec.t & VT_STORAGE) !== 0) {
        this.err(`storage class specified for '${kind}' member`);
      }
      const base = stripStorage(spec);
      /* 没有声明符就分号（`struct { … };` 长在另一个 struct 里面）：
       *   - 有 tag 的（`struct S { … };`）只是在这儿**声明了一个 tag**，不产生成员；
       *   - 没有 tag 的就是 C11 6.7.2.1 第 13 段的**匿名成员** —— 它自己按自己的对齐
       *     占一块，而它的字段名**摊进外层**（`s.jtrue` 直接可用）。tinycc 自己的
       *     `SValue`（tcc.h:488）就是这么写的，所以这一格是「编 tinycc」的必经之路。 */
      if (this.tok === SEMI) {
        if (!isStruct(base.t)) this.err('declaration does not declare anything');
        if (base.ref.fields === null) this.err(`field has incomplete type '${typeText(base)}'`);
        if (!base.ref.anon) { this.skip(SEMI); continue; }
        for (const f of base.ref.fields) dup(f.name);
        mems.push({ name: null, ty: base, bits: -1, anon: true, aligned: 0, packed: false });
        this.skip(SEMI);
        continue;
      }
      for (;;) {
        /* 成员自己也能挂 `aligned`/`packed`（`int i __attribute__((aligned(8)));`）——
         * 声明符那一路把它们收在 `mad` 里（tcc 的 `ad1`，`tccgen.c:4681`）。 */
        const mad = { aligned: sad.aligned, packed: sad.packed };
        /* 匿名位域（`int : 3;` 只占位、`int : 0;` 换一个存储单元）没有声明符，
         * 所以「有没有名字」要在进 declarator 之前问。 */
        let fname = null;
        let fty = base;
        if (this.tok !== COLON) {
          const d = this.declarator(base, 'need', mad);
          fname = /** @type {string} */ (d.name);
          fty = d.ty;
        }

        let bits = -1;
        if (this.tok === COLON) {
          this.next();
          bits = Number(this.constExpr());
          if (!isInteger(fty.t)) {
            this.err(`bit-field has non-integral type '${typeText(fty)}'`);
          }
          if (bits < 0) this.err('negative width in bit-field');
          const w = typeSize(fty).size * 8;
          if (bits > w) this.err(`width of bit-field exceeds its type (${w} bits)`);
          if (bits > 63) this.todo('64 位宽的位域还没到（宽度只有 6 位存放，tcc.h:1088）');
          if (bits === 0 && fname !== null) {
            this.err("named bit-field with zero width");
          }
          // 宽度后面还能再挂属性（`int i : 3 __attribute__((packed));`，`tccgen.c:4637`）
          this.parseAttrs(mad);
        }
        if (fname === null && bits < 0) {
          this.err('declaration does not declare anything');
        }
        if (fname !== null) {
          dup(fname);
          if (isStruct(fty.t) && fty.ref.fields === null) {
            this.err(`field '${fname}' has incomplete type '${typeText(fty)}'`);
          }
          /* 柔性数组成员（`char buf[];`，C11 6.7.2.1 第 18 段，第四十三片）不必特判：
           * 它的 `count < 0`，而 `typeSize` 对没写长度的数组回 0 —— 于是它**占 0 个
           * 字节、照样抬整体的对齐**，正是 tcc 量出来的那几个数
           * （`struct { char c; double d[]; }` 的 sizeof 是 8）。
           * `char buf[0]` 那种老写法走的是同一条路（第三十三片的长度 0 数组）。 */
        }
        mems.push({
          name: fname, ty: fty, bits, anon: false,
          aligned: mad.aligned, packed: mad.packed,
        });
        if (this.tok !== COMMA) break;
        this.next();
      }
      this.skip(SEMI);
    }
    this.next();       // `}`
    // 尾置属性：`struct S { … } __attribute__((packed));`（`tccgen.c:4689`）
    this.parseAttrs(ad);
    this.structLayout(info, union, mems, ad);
    return mkStruct(info, union);
  }

  /**
   * `struct_layout`（`tccgen.c:4190`）：成员表 -> 每个成员的 off + 整体的 size/align。
   *
   * 布局照 System V / arm64 AAPCS 的规则，也就是 tcc 在本机上的规则：成员按声明顺序
   * 排，每个成员对齐到自己的对齐，整体的对齐是成员里最大的那个，整体大小向上对齐到它。
   * 这几句是**数据**，`sizeof` 与 oracle 逐位对账靠它 —— 差一格 `sizeof(struct)` 就不同。
   * union 是同一段代码的另一支：每个成员偏移 0，大小取最大。
   *
   * 三样东西能改一个成员的对齐，优先级照 tcc（`tccgen.c:4215-4235`）：
   *   - `packed`（这个成员自己的、或者整个 struct 的）-> 按 1 排；
   *   - `#pragma pack(N)` -> 比它小就按 N，而且**连带把单个成员的 aligned 也抹掉**；
   *   - 成员自己的 `aligned(N)` -> 直接就是 N（比自然对齐小也算，那是压紧）。
   */
  structLayout(info, union, mems, ad) {
    const fields = [];
    /* 布局的状态就两格，与 `struct_layout`（`tccgen.c:4190`）一样：
     *   c       —— 已经排到第几个字节
     *   bitPos  —— 从 c 起，当前这一串位域已经用掉几位（非位域成员一进来就把它冲掉）
     * 两格而不是一格是位域的全部难点：`int a:3; int b:5;` 两个成员的 `off` 相同，
     * 差别只在 bitPos。 */
    let c = 0;
    let bitPos = 0;
    let maxalign = 1;
    const pragmaPack = this.cpp.packStack[this.cpp.packStack.length - 1];
    for (const m of mems) {
      let fty = m.ty;
      const bits = m.bits;
      let { size, align } = typeSize(fty);
      /* 这个成员自己写的 `aligned(N)`。0 = 没写。 */
      let a = m.aligned;
      let packed = false;
      if (bits === 0) {
        // PCC 模式下宽度 0 的位域不受 packing 影响（`tccgen.c:4215`）
      } else {
        if (m.packed || ad.packed) { align = 1; packed = true; }
        /* `#pragma pack(N)`（第八刀第十八片，`tccgen.c:4224-4228`）：N 比这个成员自己的
         * 对齐小就按 N 排，而且在 PCC 模式下**连单个成员的 aligned 也一起抹掉**。
         * pack 值从预处理器那边问 —— 它是**当前**那一格（`#pragma pack` 有栈）。 */
        if (pragmaPack !== 0) {
          packed = true;
          if (pragmaPack < align) align = pragmaPack;
          if (pragmaPack < a) a = 0;
        }
      }
      if (a !== 0) align = a;

      if (m.anon) {
        /* 匿名 struct/union 成员：自己按自己的对齐占一块，字段名摊进外层。 */
        let at;
        if (union) {
          at = 0;
          if (size > c) c = size;
        } else {
          c += (bitPos + 7) >> 3;
          c = alignUp(c, align);
          at = c;
          c += size;
          bitPos = 0;
        }
        if (align > maxalign) maxalign = align;
        for (const f of fty.ref.fields) fields.push({ name: f.name, ty: f.ty, off: at + f.off });
        continue;
      }

      let off;
      if (union) {
        /* union 里的位域一律从第 0 位起（tcc 干脆不给它填 bitPos，`tccgen.c:4238`），
         * 大小按宽度进位到整字节。**位域标记还是要打上** —— 少这一句 `u.a`
         * 就成了一个普通的 unsigned 成员，读出来是整个容器而不是低 3 位。 */
        if (bits >= 0) {
          size = (bits + 7) >> 3;
          fty = mkBitfield(fty, 0, bits);
        }
        off = 0;
        if (size > c) c = size;
      } else if (bits < 0) {
        // 普通成员：先把没排完的那一串位冲成整字节，再按自己的对齐排
        c += (bitPos + 7) >> 3;
        c = alignUp(c, align);
        off = c;
        if (size > 0) c += size;
        bitPos = 0;
      } else {
        /* PCC（也就是 gcc）的位域布局：紧挨着前一个位域放，除了三种情形要换一个新的
         * 存储单元 —— 宽度是 0、这个成员自己写了 aligned、或者放下去会**越过它自己的
         * 基类型容器**（而且没有 packing）。第三种那句判断照抄（`tccgen.c:4274`）：
         * 它算的是「从当前位置起，这个位域要横跨几个 align 单位」，超过基类型本来占
         * 几个单位就得换。 */
        let newUnit = bits === 0 || m.aligned !== 0;
        if (!newUnit && !packed) {
          const a8 = align * 8;
          const ofs = Math.floor(((c * 8 + bitPos) % a8 + bits + a8 - 1) / a8);
          if (ofs > size / align) newUnit = true;
        }
        if (newUnit) {
          c = alignUp(c + ((bitPos + 7) >> 3), align);
          bitPos = 0;
        }
        /* PCC 模式下装得下的 `long long` 位域按 `int` 算（`tccgen.c:4280`）——
         * 这一句直接改成员的**类型**，于是后面读写用的是 4 字节的访问。 */
        if (size === 8 && bits <= 32) {
          fty = ctype((fty.t & ~VT_BTYPE) | VT_INT, fty.ref);
          size = 4;
        }
        while (bitPos >= align * 8) {
          c += align;
          bitPos -= align * 8;
        }
        off = c;
        /* 匿名位域**不影响**整体的对齐（`tccgen.c:4290`）。少这一句
         * `struct { char c; int :0; }` 的对齐会从 1 变成 4。 */
        if (m.name === null) align = 1;
        fty = mkBitfield(fty, bitPos, bits);
        bitPos += bits;
      }
      if (align > maxalign) maxalign = align;
      if (m.name !== null) fields.push({ name: m.name, ty: fty, off });
    }

    // 末尾那一串没排完的位也要占字节（`tccgen.c:4344`）
    c += (bitPos + 7) >> 3;

    /* 整体的对齐：`aligned(N)` 与成员里最大的那个**取大**（`tccgen.c:4346`）——
     * 也就是说 `aligned` 只抬不压，压是 `packed` 的事。 */
    let a = ad.aligned !== 0 ? ad.aligned : 1;
    if (a < maxalign) a = maxalign;
    info.fields = fields;
    info.align = a;
    info.size = alignUp(c, a);
    this.fixBitfields(fields, info.size);
  }

  /**
   * 布局那一遍的收尾（`tccgen.c:4365-4436`）：**能不能按声明的类型访问每个位域**。
   *
   * 不能的那些换一个访问类型。会撞上这一格的正是 PCC 那句「装得下的 `long long`
   * 位域按 `int` 算」：
   *
   * ```c
   * struct { unsigned long long target:36, high8:8, …; };   // dyld 的 chained rebase
   * ```
   *
   * `high8` 排在第 36 位，而它的类型已经被改成 4 字节的 `int` —— 36 + 8 越过 32。
   * 这个循环把偏移挪到第 4 个字节、位置变成 4，访问类型记成 1 字节，于是
   * 4 + 8 落在一个字节里。
   *
   * 那个 `for(;;)`（照抄 `tccgen.c:4390-4408`）是在**找一个不动点**：按当前的对齐
   * 算出容器的起点 `cx`，据此算出需要几个字节、挑一个类型，那个类型的对齐又会改变
   * `cx` —— 直到 `cx` 不再变。
   */
  fixBitfields(fields, total) {
    for (const fd of fields) {
      if (!isBitfield(fd.ty.t)) continue;
      /* `ref` 指回这条成员（`tccgen.c:4372` 的 `f->type.ref = f`）：访问类型要跟着
       * 类型一起传，而标量的 `ref` 本来空着。默认 -1 = 按声明的类型访问。 */
      fd.aux = -1;
      fd.ty = ctype(fd.ty.t, fd);
      const bits = bitSizeOf(fd.ty.t);
      if (bits === 0) continue;
      const pos = bitPosOf(fd.ty.t);
      const decl = typeSize(bitfieldBase(fd.ty));
      if (pos + bits <= decl.size * 8 && fd.off + decl.size <= total) continue;

      let c0 = -1;
      let s = 1;
      let align = 1;
      let tt = VT_BYTE;
      let px = 0;
      let cx = 0;
      for (;;) {
        px = fd.off * 8 + pos;
        cx = (px >> 3) & -align;
        px -= cx * 8;
        if (c0 === cx) break;
        s = (px + bits + 7) >> 3;
        tt = s > 4 ? VT_LLONG : s > 2 ? VT_INT : s > 1 ? VT_SHORT : VT_BYTE;
        const ts = typeSize(ctype(tt, null));
        s = ts.size;
        align = ts.align;
        c0 = cx;
      }

      if (px + bits > s * 8 || cx + s > total) {
        /* tcc 这时退到**按字节读写**（`f->auxtype = VT_STRUCT`，`load_packed_bf`）。
         * 那条路只有 `__attribute__((packed))` 才走得到，而 packed 还没到 —— 所以
         * 这儿是一条声明出来的边界，不是一个错答案。 */
        this.todo('位域要按字节读写那条路（packed）还没到');
      }
      fd.off = cx;
      fd.aux = tt;
      /* 声明的类型**不动**（值的符号性与容器宽度还按它算，`tccgen.c` 只改 `auxtype`）；
       * 变的是偏移与位置，以及 `aux` 上那个访问类型。 */
      fd.ty = mkBitfield(ctype(fd.ty.t, fd), px, bits);
    }
  }

  /**
   * `enum`（`struct_decl` 里 `TOK_ENUM` 那一支）。进来时 `enum` 已经吃掉。
   *
   * 枚举常量是**普通标识符**（与 tag 不在同一个名字空间），而且它们的作用域是
   * 包着这个 enum 的作用域 —— 不是「enum 内部」。所以 `enum {A, B = A + 2}` 里
   * 的 `A` 要立刻可见：一边登记一边求值，共用 `constExpr`。
   *
   * 底层类型**不一定是 int**（第五十九片）：见 `enumBase`。所以枚举常量的类型要等
   * 读完 `}` 才定得下来 —— 与 tcc 一样，先按 int 登记，读完再回头改那一条链
   * （`tccgen.c:4564-4576` 的 `for (ss = s->next; ss; ss = ss->next)`）。
   */
  enumDecl() {
    const name = this.tok >= TOK_UIDENT ? this.identName() : null;
    const info = this.tagOf('enum', name, this.tok === LBRACE);
    const ty = mkEnum(info);
    if (this.tok !== LBRACE) {
      if (name === null) this.err("'enum' has no tag and no enumerator list");
      if (info.fields === null) this.err(`'enum ${info.name}' is incomplete`);
      return ty;
    }
    if (info.fields !== null) this.err(`redefinition of 'enum ${info.name}'`);
    this.next();

    const names = [];
    let val = 0n;
    /* 最小的与最大的枚举值（tcc 的 `nl` / `pl`，都从 0 起算 —— 也就是说
     * 「有没有负的」问的是 `nl < 0`，空枚举与全非负的枚举一样）。 */
    let nl = 0n;
    let pl = 0n;
    while (this.tok !== RBRACE) {
      if (this.tok === TOK_EOF) this.err("'}' expected");
      const en = this.identName();
      if (this.ecScope().has(en)) this.err(`redefinition of enumerator '${en}'`);
      if (this.tok === ASSIGN) {
        this.next();
        val = this.constExpr();
      }
      /* 收成 **64 位**有符号（tcc 的 `expr_const64`）：枚举值先按 long long 存着，
       * 到底是 int / unsigned / long long 由下面 `enumBase` 一处说了算。 */
      val = BigInt.asIntN(64, val);
      this.ecScope().set(en, { ty, val });
      names.push(en);
      if (val < nl) nl = val;
      if (val > pl) pl = val;
      val = val + 1n;
      if (this.tok !== COMMA) break;
      this.next();
    }
    this.skip(RBRACE);
    info.fields = names;
    info.bt = enumBase(nl, pl);
    const sz = typeSize(mkEnum(info));
    info.size = sz.size;
    info.align = sz.align;
    /* 每个枚举常量**自己**的类型（`tccgen.c:4564-4576`）：装得进 int 的就是 int，
     * 哪怕整个枚举是无符号的；装不进就跟着枚举走一格。 */
    for (const en of names) {
      const e = this.ecScope().get(en);
      let bits = VT_INT;
      if (e.val !== BigInt.asIntN(32, e.val)) {
        if ((info.bt & VT_UNSIGNED) !== 0) {
          bits = VT_INT | VT_UNSIGNED;
          if (e.val !== BigInt.asUintN(32, e.val)) bits = VT_LLONG | VT_LONG | VT_UNSIGNED;
        } else {
          bits = VT_LLONG | VT_LONG;
        }
      }
      e.ty = ctype(bits | VT_ENUM, info);
    }
    return mkEnum(info);
  }

  /**
   * `parse_btype`（`tccgen.c:4711` 一带）的整型这一片。
   *
   * 形状照 tcc：**一个循环，见到一个说明符就往 `t` 上按位或**。说明符可以乱序
   * （`unsigned long int` 与 `int long unsigned` 是同一个类型），这个循环天然支持 ——
   * 换成「按顺序匹配」的写法就得为每种排列写一条规则。
   *
   * `long` 数个数：LP64 上 `long` 与 `long long` 都是 64 位（本机 arm64 Darwin 与
   * tcc 的选择一致，`sizeof` 必须跟着它，否则与 oracle 分岔）。`VT_LONG` 那一位留着，
   * 只为报错消息印得对。
   */
  /**
   * `parse_attribute`（`tccgen.c:3914`）：`__attribute__((…))` 的记号流。
   *
   * 第十六片起这儿是「整块跳过」，因为那时没有一个属性有可观察的效果。第三十四片
   * 起它是一台**真的分派** —— `aligned` 与 `packed` 改 struct 的布局，`sizeof` 就跟着变。
   * 别的属性名（`weak`、`section`、`__printflike`、`__dead2`…）落在最后那一支：
   * 有参数就把括号平衡掉（tcc 的 `skip_param`，`tccgen.c:4119`）。
   *
   * 形状照 tcc 那一份，包括三处细节：
   *   - 括号是**成对的两层**（`skip('(') skip('(')`），不是「平衡数括号」；
   *   - 里面是**逗号分隔的表**（`aligned(4), packed`）；
   *   - 收尾 `goto redo` —— `__attribute__((a)) __attribute__((b))` 连着写也算一处。
   * tcc 对不认识的属性发 `-Wunsupported` 警告，那一档默认是关的，所以我们**不发** ——
   * 诊断逐字节对账靠这一点。
   *
   * @param {{aligned:number,packed:boolean}|null} ad 收结果的地方；null = 只读过去
   */
  parseAttrs(ad = null) {
    while (this.tok === TOK_ATTRIBUTE1 || this.tok === TOK_ATTRIBUTE2) {
      this.next();
      this.skip(LPAR);
      this.skip(LPAR);
      while (this.tok !== RPAR) {
        if (this.tok < TOK_IDENT) this.expect('attribute name');
        const t = this.tok;
        this.next();
        if (t === TOK_ALIGNED1 || t === TOK_ALIGNED2) {
          /* `aligned` 不带参数时是这个目标的最大对齐（`MAX_ALIGN`，arm64-gen.c:39 = 16）。
           * 带参数的必须是**正的 2 的幂** —— tcc 把它存成 log2+1，所以别的值存不下。 */
          let n = 16;
          if (this.tok === LPAR) {
            this.next();
            n = Number(this.constExpr());
            if (n <= 0 || (n & (n - 1)) !== 0) {
              this.err('alignment must be a positive power of two');
            }
            this.skip(RPAR);
          }
          if (ad !== null) ad.aligned = n;
        } else if (t === TOK_PACKED1 || t === TOK_PACKED2) {
          if (ad !== null) ad.packed = true;
        } else if (t === TOK_WEAK1 || t === TOK_WEAK2) {
          /* `weak`（第一百〇四片）：不带参数，改的是这个名字在符号表里的**绑定**。
           * tcc 那边是 `ad->a.weak = 1`（`tccgen.c:4017-4019`），一路带到
           * `put_extern_sym` 的 `STB_WEAK`。 */
          if (ad !== null) ad.weak = true;
        } else if (t === TOK_ALIAS1 || t === TOK_ALIAS2) {
          /* `alias("目标")`（第一百〇五片，`tccgen.c:3974-3981`）：参数是一个字符串
           * 字面量（相邻的要拼起来 —— tcc 走的是 `parse_mult_str`）。 */
          this.skip(LPAR);
          if (this.tok !== TOK_STR) this.expect('alias("target")');
          const target = this.readStrTok(this.tokc);
          this.skip(RPAR);
          if (ad !== null) ad.aliasTarget = target;
        } else if (this.tok === LPAR) {
          let depth = 0;
          do {
            if (this.tok === TOK_EOF) this.err("')' expected");
            if (this.tok === LPAR) depth++;
            else if (this.tok === RPAR) depth--;
            this.next();
          } while (depth > 0);
        }
        if (this.tok !== COMMA) break;
        this.next();
      }
      this.skip(RPAR);
      this.skip(RPAR);
    }
  }

  /** `parse_attribute(NULL)`：读过去、什么都不收。 */
  skipAttrs() {
    this.parseAttrs(null);
  }

  /**
   * 声明符后面的 `__asm("_name")`（第八刀第十六片）：**符号改名**。
   *
   * glibc 的 `__REDIRECT` 与 macOS 的 `__DARWIN_ALIAS` 都靠它把 `fopen` 指到
   * `_fopen$UNIX2003` 之类的真符号上。我们这一侧的 libc 是**按 C 的名字**查表的
   * （`interp/libc.js` 的那张表），所以这儿读掉那个串、**不改名** —— 改了反而找不到。
   * 自带后端那条路上真的要链接时，这一格会变成一次真的改名。
   */
  skipAsmName() {
    if (this.tok !== TOK_ASM1 && this.tok !== TOK_ASM2 && this.tok !== TOK_ASM3) return;
    this.next();
    this.skip(LPAR);
    while (this.tok !== RPAR) {
      if (this.tok === TOK_EOF) this.err("')' expected");
      this.next();
    }
    this.skip(RPAR);
  }

  /**
   * `asm_instr`（`tccasm.c:1327`）：`__asm__` 当**一条语句**。
   *
   * 自带汇编器还没到（ADR-0017 第九到十一步），所以这一格只认一种形状：**模板是空串、
   * 没有操作数**的那种 —— `__asm__ __volatile__("" ::: "memory")`，一条编译屏障。
   * 它说的是「别把内存访问搬过这一行」，而我们既不重排也不把内存缓进寄存器（每次访问
   * 都是一条 LOAD/STORE），所以**什么都不发**就是它的正确实现。
   * macOS SDK 的 `dispatch_compiler_barrier()`（`dispatch/base.h:195`）就是这一条，
   * `dispatch/once.h` 的两个 inline 函数里各有一次 —— 编 tinycc 的源码时撞上的正是它。
   *
   * 模板非空、或者带了操作数的，报错并钉住边界（`gen-bad/asm-stmt`）：那些要真的发指令。
   *
   * 与 tcc 一样**不吃掉那个 `;`**（`tccasm.c:1420` 的注释），只检查它在 —— 留给外面
   * 当一条空语句读掉。
   */
  asmInstr() {
    this.next();
    while (this.tok === TOK_VOLATILE || this.tok === TOK_VOLATILE1
      || this.tok === TOK_VOLATILE2 || this.tok === TOK_GOTO) {
      this.next();
    }
    this.skip(LPAR);
    if (this.tok !== TOK_STR) this.expect('string constant');
    // `parse_asm_str`：相邻的字符串字面量接成一个模板（`readStrTok` 顺手往前走）
    const tmpl = this.readStrTok(this.tokc);
    if (tmpl !== '') this.err('第八刀：非空的 __asm__ 模板还没到（等自带汇编器）');
    /* `: 输出 : 输入 : 破坏列表` —— 形状照抄 tcc（`tccasm.c:1352-1380`）：
     * 「下一个不是 `:`」才算这一段有东西。真的有操作数就是边界；不是操作数的东西
     * （比如 `("" :)` 里的 `)`）与 tcc 一样报 `string constant expected`。
     * 第三段是一串逗号分隔的字符串（寄存器/内存的破坏列表），对我们没有意义，读掉。 */
    if (this.tok === COLON) {
      this.next();
      this.asmOperands('输出');
      if (this.tok === COLON) {
        this.next();
        if (this.tok !== RPAR) {
          this.asmOperands('输入');
          if (this.tok === COLON) {
            this.next();
            for (;;) {
              if (this.tok === COLON) break;
              if (this.tok !== TOK_STR) this.expect('string constant');
              this.readStrTok(this.tokc);
              if (this.tok !== COMMA) break;
              this.next();
            }
          }
        }
      }
    }
    while (this.tok !== RPAR) {
      if (this.tok === TOK_EOF) this.expect("')'");
      this.next();
    }
    this.skip(RPAR);
    if (this.tok !== SEMI) this.expect("';'");
  }

  /**
   * `parse_asm_operands`（`tccasm.c:1268`）的边界版：一段操作数表。
   *
   * tcc 那边「下一个不是 `:`」就当这一段有操作数、去读 `[名字] "约束" (表达式)`。
   * 我们读不了 —— 那要把值搬进指定的寄存器。所以：看着**像**操作数（`[` 或字符串）的
   * 报边界；别的与 tcc 一样报 `string constant expected`。
   */
  asmOperands(which) {
    if (this.tok === COLON) return;
    if (this.tok === LBRACK || this.tok === TOK_STR) {
      this.err(`第八刀：__asm__ 的${which}操作数还没到（等自带汇编器）`);
    }
    this.expect('string constant');
  }

  parseBtype(ad = null) {
    let bt = -1;
    let longs = 0;
    let shorts = 0;
    let sign = 0;        // 1 = signed，2 = unsigned
    let storage = 0;
    let quals = 0;
    let any = false;
    /** @type {object|null} `typedef` 名带来的整个类型（可能是指针、数组） */
    let tdef = null;
    const setBt = (b) => {
      if (bt !== -1 || tdef !== null) {
        this.err('two or more data types in declaration specifiers');
      }
      bt = b;
    };
    for (;;) {
      const t = this.tok;
      if (t === TOK_VOID) { setBt(VT_VOID); any = true; this.next(); continue; }
      if (t === TOK_BOOL) { setBt(VT_BOOL); any = true; this.next(); continue; }
      if (t === TOK_CHAR) { setBt(VT_BYTE); any = true; this.next(); continue; }
      if (t === TOK_INT) { setBt(VT_INT); any = true; this.next(); continue; }
      if (t === TOK_SHORT) { shorts++; any = true; this.next(); continue; }
      if (t === TOK_LONG) { longs++; any = true; this.next(); continue; }
      if (t === TOK_SIGNED) {
        if (sign !== 0) this.err('two or more sign specifiers');
        sign = 1; any = true; this.next(); continue;
      }
      if (t === TOK_UNSIGNED) {
        if (sign !== 0) this.err('two or more sign specifiers');
        sign = 2; any = true; this.next(); continue;
      }
      if (t === TOK_EXTERN) { storage = storage | VT_EXTERN; any = true; this.next(); continue; }
      if (t === TOK_STATIC) { storage = storage | VT_STATIC; any = true; this.next(); continue; }
      if (t === TOK_INLINE || t === TOK_INLINE1 || t === TOK_INLINE2) {
        storage = storage | VT_INLINE; any = true; this.next(); continue;
      }
      if (t === TOK_TYPEDEF) { storage = storage | VT_TYPEDEF; any = true; this.next(); continue; }
      if (t === TOK_CONST || t === TOK_CONST1 || t === TOK_CONST2) {
        quals = quals | VT_CONSTANT; any = true; this.next(); continue;
      }
      if (t === TOK_VOLATILE || t === TOK_VOLATILE1 || t === TOK_VOLATILE2) {
        quals = quals | VT_VOLATILE; any = true; this.next(); continue;
      }
      /* 真的系统头里到处都是的那几个（第八刀第十六片）。它们在这一层**没有可观察的
       * 效果**，所以吃掉就行：
       *   - `restrict` 是一个**承诺**（不别名），只影响优化，不影响语义；
       *   - `__extension__` 是「别为下面这个 gcc 扩展警告」；
       *   - `_Atomic` / `_Thread_local` / `__thread` 我们是单线程一条腿；
       *   - `__attribute__((…))` 整块跳过（`skipAttrs`）。
       * 吃掉不等于装作没看见：`_Atomic` 真要做的话是另一件事，那时这一行会变成一条
       * 真的实现，而不是「原来漏了」。 */
      if (t === TOK_RESTRICT || t === TOK_RESTRICT1 || t === TOK_RESTRICT2
          || t === TOK_EXTENSION || t === TOK_ATOMIC
          || t === TOK_THREAD_LOCAL || t === TOK_THREAD) {
        any = true; this.next(); continue;
      }
      if (t === TOK_ATTRIBUTE1 || t === TOK_ATTRIBUTE2) { any = true; this.parseAttrs(ad); continue; }
      if (t === TOK_SIGNED1 || t === TOK_SIGNED2) {
        if (sign !== 0) this.err('two or more sign specifiers');
        sign = 1; any = true; this.next(); continue;
      }
      // `auto` / `register` 在这一片没有可观察的效果，吃掉
      if (t === TOK_AUTO || t === TOK_REGISTER) { any = true; this.next(); continue; }
      if (t === TOK_FLOAT) { setBt(VT_FLOAT); any = true; this.next(); continue; }
      if (t === TOK_DOUBLE) { setBt(VT_DOUBLE); any = true; this.next(); continue; }
      if (t === TOK_STRUCT || t === TOK_UNION || t === TOK_ENUM) {
        /* struct/union/enum 走 `tdef` 那一格：它们和 typedef 名一样是「一整个类型」，
         * 不是一位说明符，所以不能与 `short`/`long`/`signed` 同时出现。 */
        if (bt !== -1 || tdef !== null || sign !== 0 || longs > 0 || shorts > 0) {
          this.err('two or more data types in declaration specifiers');
        }
        this.next();
        tdef = t === TOK_ENUM ? this.enumDecl() : this.structDecl(t === TOK_UNION);
        any = true;
        continue;
      }
      /* GNU 的 `typeof`（第五十一片，`tccgen.c:4926`）：与 struct/typedef 名一样是
       * 「一整个类型」，所以走 `tdef` 那一格。 */
      if (t === TOK_TYPEOF1 || t === TOK_TYPEOF2 || t === TOK_TYPEOF3) {
        if (bt !== -1 || tdef !== null || sign !== 0 || longs > 0 || shorts > 0) {
          this.err('two or more data types in declaration specifiers');
        }
        this.next();
        tdef = this.typeofType();
        any = true;
        continue;
      }
    if (t >= TOK_UIDENT) {
        /* `typedef` 名当基本类型用（tcc 在符号表里找带 `VT_TYPEDEF` 的那条，
         * `tccgen.c:4880` 一带）。**只在还没有基本类型时**才吃它 —— 否则
         * `int x;` 里的 `x` 会被当成类型名（如果恰好有一个同名 typedef 的话）。
         * 这正是 C 那条著名的「typedef 名与标识符不可分辨」，tcc 与我们都靠
         * 「先看有没有基本类型」来断。 */
        if (bt !== -1 || tdef !== null || sign !== 0 || longs > 0 || shorts > 0) break;
        const td = this.tdefLookup(this.cpp.tokStr(t, null));
        if (td === null) break;
        tdef = td; any = true; this.next(); continue;
      }
      break;
    }
    if (!any) this.expect('declaration');

    if (tdef !== null) {
      /* `typedef` 名不能再被 `short`/`long`/`signed` 修饰（`typedef int T; unsigned T x;`
       * 是错的）—— 上面的循环已经保证这几个不会与它同时出现，这里只把限定词与存储类合上。
       * `count` 要手工带过去：它挂在 CType 对象上而不在 `t` 里（ctype.js:129），
       * 所以 `typedef int V[4];` 少了这一句就变成 `int *`，`sizeof(V)` 从 16 变 8。 */
      const r = ctype(tdef.t | quals | storage, tdef.ref);
      if (tdef.count !== undefined) r.count = tdef.count;
      /* typedef 上的 `aligned(N)`（第六十一片）：tcc 把属性存在那条 typedef 的 `Sym`
       * 上，用到它时 `sym_to_attr` 并进当前这一份 `ad`（`tccgen.c:4970`），而并的规则是
       * `merge_symattr`：**当前没写才用 typedef 那一份**。`talign` 顺着带下去，
       * 于是 `typedef unaligned_u64 X;` 这样接一层也还在。 */
      if (tdef.talign !== undefined) {
        r.talign = tdef.talign;
        if (ad !== null && !(ad.aligned > 0)) ad.aligned = tdef.talign;
      }
      return r;
    }

    if (shorts > 1) this.err("too many 'short' specifiers");
    if (longs > 2) this.err("too many 'long' specifiers");
    if (shorts > 0 && longs > 0) this.err("'short' and 'long' together");
    if (bt === -1) bt = VT_INT;   // `unsigned` / `long` 单独出现就是 int 系
    /* `long double`：在**这个目标**上它就是 `double`（`tcc.h:237-241`：MACHO+ARM64 与
     * PE 都开 `TCC_USING_DOUBLE_FOR_LDOUBLE`）。类型码仍然分开 —— `sizeof` 与
     * `typeText` 看的是类型，而 x86_64（80 位）与 riscv64（128 位）那两条后端上
     * 表示会不一样，那时改的只有 `typeSize` 与 `mirTypeOf` 两处。
     * `long` 那一票**在这儿就用掉**（`longs = 0`）—— 否则下面「short/long 只能配 int」
     * 与「longs>0 就是 long long」两条会把它按整型处理。 */
    if (longs > 0 && bt === VT_DOUBLE) { bt = VT_LDOUBLE; longs = 0; }

    if ((bt === VT_FLOAT || bt === VT_DOUBLE) && (sign !== 0 || shorts > 0 || longs > 0)) {
      this.err(`'${typeText(ctype(bt))}' cannot be signed or sized`);
    }
    if ((shorts > 0 || longs > 0) && bt !== VT_INT) {
      this.err(`'short'/'long' cannot be used with '${typeText(ctype(bt))}'`);
    }
    if (bt === VT_VOID && (sign !== 0 || shorts > 0 || longs > 0)) {
      this.err("'void' cannot be signed or sized");
    }

    let t = bt;
    if (shorts > 0) t = VT_SHORT;
    else if (longs > 0) t = VT_LLONG;
    if (sign === 2) t = t | VT_UNSIGNED | VT_DEFSIGN;
    else if (sign === 1) t = t | VT_DEFSIGN;
    if (longs === 1) t = t | VT_LONG;
    return ctype(t | quals | storage);
  }

  /**
   * 类型名（`(int *)x` 里那个、`sizeof(char[4])` 里那个）：基本类型加**抽象**声明符。
   */
  typeName() {
    const base = this.parseBtype();
    return this.declarator(stripStorage(base), 'none').ty;
  }

  /**
   * `typeof(…)` 括号里那一坨的类型（`parse_expr_type`，`tccgen.c:6810`）。
   * 里面可以是**类型名**也可以是**表达式**，表达式那一种**不求值** —— 与 `sizeof` 是
   * 同一件事，所以同一个手法：发进一个用完就丢的 MirFunc。
   *
   * 存储类要剥掉（tcc 那句 `type1.t &= ~(VT_STORAGE&~VT_TYPEDEF)`）：`typeof(x)` 里的
   * `x` 可能是个 `static` 的东西，而那说的是**那个对象**，不是它的类型。
   */
  typeofType() {
    this.skip(LPAR);
    let ty;
    if (this.isTypeStart(this.tok)) {
      ty = this.typeName();
    } else {
      const scratch = new MirFunc('$typeof', [], T_VOID);
      const outer = this.f;
      this.f = scratch;
      ty = this.gexpr().ty;
      this.f = outer;
    }
    this.skip(RPAR);
    return stripStorage(ty);
  }

  /**
   * 声明符（`type_decl` 与 `post_type`，`tccgen.c:5049` 一带）。
   *
   * 顺序是这一段唯一的难点：**先吃前缀的 `*`，再吃后缀的 `[]` 与 `(…)`，而后缀绑得
   * 更紧**。于是 `int *a[3]` 是「3 个 `int *` 的数组」而不是「指向 `int[3]` 的指针」，
   * `int *f(void)` 是「回 `int *` 的函数」。
   *
   * 带括号的那一层（`int (*a)[3]`、`int (*fp)(int)`）要把「已经攒了一半的类型」往里传。
   * tcc 的办法是先建一个带**洞**的类型、解析完外层再把洞补上（`type_decl` 那次递归）；
   * 我们的 CType 不改已经建好的对象，所以反过来：里层回一个**函数** `wrap`，
   * 外层把自己攒出来的类型喂给它。同一件事，只是洞在函数里而不在数据里。
   *
   * @param {object} base 基本类型（**存储类已经剥掉**）
   * @param {'need'|'opt'|'none'} want 名字：必须有 / 可省（原型里的形参）/ 不能有
   * @param {{aligned:number,packed:boolean}|null} ad 声明符上挂的属性收在这儿
   */
  declarator(base, want, ad = null) {
    const d = this.declaratorParts(want, ad);
    return { ty: d.wrap(base), name: d.name };
  }

  /**
   * 声明符的形状（名字 + 一个「把基本类型套成最终类型」的函数）。
   *
   * 一层里的三段：前缀的 `*`、里层的 `(…)`（或者名字）、后缀的 `[]` / `(形参表)`。
   * 套的次序是**前缀 -> 后缀（倒着）-> 交给里层**：
   *   - `int *a[3]`      pre=1, posts=[[3]]      -> ptr(int) 再 arr3  = 3 个 int*
   *   - `int (*a)[3]`    外层 posts=[[3]]，里层 pre=1 -> arr3(int) 交给里层 -> ptr
   *   - `int (*f[3])(v)` 外层 posts=[(v)]，里层 pre=1+posts=[[3]] -> 3 个函数指针
   */
  declaratorParts(want, ad = null) {
    /* 声明符**前面**也能挂 attribute（`__attribute__((…)) *p`），系统头里有。 */
    this.parseAttrs(ad);
    let pre = 0;
    while (this.tok === STAR) {
      this.next();
      /* 指针自己的限定词（`char * const p`、`char * __restrict p`）：吃掉，
       * 这一片没有可观察的效果。系统头里 `__restrict` 几乎每个 `char *` 后面都有。 */
      for (;;) {
        const q = this.tok;
        if (q === TOK_CONST || q === TOK_CONST1 || q === TOK_CONST2
            || q === TOK_VOLATILE || q === TOK_VOLATILE1 || q === TOK_VOLATILE2
            || q === TOK_RESTRICT || q === TOK_RESTRICT1 || q === TOK_RESTRICT2
            || q === TOK_ATOMIC) {
          this.next();
          continue;
        }
        if (q === TOK_ATTRIBUTE1 || q === TOK_ATTRIBUTE2) { this.parseAttrs(ad); continue; }
        break;
      }
      pre++;
    }

    /** @type {{name:string|null,wrap:(ty:object)=>object}|null} */
    let inner = null;
    let name = null;
    if (this.tok === LPAR && this.isGroupParen()) {
      this.next();
      inner = this.declaratorParts(want, ad);
      this.skip(RPAR);
    } else if (this.tok >= TOK_UIDENT) {
      if (want === 'none') this.err('unexpected identifier in type name');
      name = this.identName();
    } else if (want === 'need') {
      this.expect('identifier');
    }

    /* 后缀：从左往右收进一个表。维度**倒着**套（`int a[2][3]` 是「2 个 `int[3]`」；
     * 顺着套会得到「3 个 `int[2]`」—— 大小一样，`sizeof(a[0])` 不一样），而函数与
     * 数组混在一起时同一个次序也正好对：`int (*f[3])(void)` 的里层是 `[3]` 套在 ptr 上。 */
    const posts = [];
    for (;;) {
      if (this.tok === LBRACK) {
        const top = posts.length === 0;
        this.next();
        if (this.tok === RBRACK) {
          this.next();
          posts.push({ k: 'arr', n: -1, top });
          continue;
        }
        /* 函数体里的声明才可能是**变长数组**（`int a[n]`，第四十九片）。那儿的读法是
         * 「先收下这一段记号，用常量求值器试一遍」：试成了就是普通数组（与从前一个字
         * 都不差），试不成才当变长的、把这段记号留到 `wrap` 里当运行期表达式再读一遍。
         *
         * tcc 那边不必试：它的表达式解析器自己就折常量，所以局部量的维度一律走
         * `gexpr()`，折完看 `vtop` 上还是不是 `VT_CONST`（`tccgen.c:5167-5188`）。
         * 我们主路上不折（文件头偏离 3），于是「是不是常量」只有常量求值器答得出来。 */
        if (this.vlaMode === 3
          || (this.scopes.length > 0
            && (this.vlaMode === 2 || (this.vlaMode === 1 && (pre > 0 || inner !== null))))) {
          const dim = this.cpp.captureTokens(RBRACK);
          // captureTokens 停在 `]` 上，它动的是 Cpp 的 tok —— 同步一下
          this.tok = this.cpp.tok;
          this.tokc = this.cpp.tokc;
          this.skip(RBRACK);
          const n = this.tryConstDim(dim);
          posts.push(n === null ? { k: 'arr', n: -1, dim, top } : { k: 'arr', n, top });
          continue;
        }
        posts.push({ k: 'arr', n: Number(this.constExpr()), top });
        this.skip(RBRACK);
        continue;
      }
      if (this.tok === LPAR) {
        posts.push({ k: 'fn', ...this.funcParams() });
        continue;
      }
      break;
    }
    /* 声明符**后面**的属性（`int i __attribute__((aligned(8)));`，`tccgen.c:5317`
     * 那一句 `parse_attribute(ad)`）。`decl` 那边还会再吃一轮 —— 那儿要与
     * `__asm("_name")` 交替，这儿吃的是成员表那一路要收下的那一份。 */
    this.parseAttrs(ad);

    const wrap = (base) => {
      let ty = base;
      for (let i = 0; i < pre; i++) ty = mkPointer(ty);
      for (let i = posts.length - 1; i >= 0; i--) {
        const p = posts[i];
        if (p.k === 'fn') {
          ty = mkFunc(ty, p.params, p.variadic);
          /* 「老式」这一格跟着函数类型走：`{` 之前那串形参声明要认得它
           * （`tccgen.c:8814`），而调用点也靠它决定「实参提升」那一套。 */
          if (p.old === true) ty.ref.old = true;
          continue;
        }
        /* 长度 0 的数组是 GNU 扩展，tcc 照收（`post_type` 那儿对 0 没有任何检查）：
         * `struct S { double a[0]; }` 的 sizeof 是 0、对齐还是 8 —— 老代码拿它当
         * 「只要对齐、不要空间」的垫片，tinycc 自己的 tcctest.c 也考这一格（985 行）。 */
        ty = this.arrayPost(ty, p);
      }
      return inner === null ? ty : inner.wrap(ty);
    };
    return { name: inner === null ? name : inner.name, wrap };
  }

  /**
   * 声明符里的一维 `[…]` -> 一个数组类型。三种：
   *   - 长度是常量、元素也是定长的：一个普通数组，一条指令都不发；
   *   - 长度是运行期的（`int a[n]`）：那段记号在这儿当表达式读一遍，字节数存进一个槽；
   *   - 长度是常量但**元素是变长的**（`int a[2][n]`）：外面这一层也得是变长的 ——
   *     字节数 = 2 × 里层那个槽（tcc 的 `t1 |= type->t & VT_VLA`，`tccgen.c:5200`）。
   *
   * 「长度在声明那一刻就定住了」正是这一步的意思：算出来的字节数**存进槽**，之后改
   * `n` 不会动那个槽。tcc 存的是「元素个数 × 元素大小」同一个数（`tccgen.c:5208-5216`）。
   */
  arrayPost(elem, p) {
    const vlaElem = isVla(elem);
    if (p.dim === undefined && !vlaElem) {
      if (p.n < -1) this.err('array size must not be negative');
      return mkArray(elem, p.n);
    }
    /* `int a[][n]` —— 外面那一维省了、里面是变长的：谁都算不出「一格多大」。
     * tcc 报的就是这一句（`tccgen.c:5205`），而且**只在里层**报（`td & TYPE_NEST`）——
     * 最外面那一维在形参上本来就要退化成指针，谁也不问它多大（`int arr[][3][--s]`，
     * tcctest.c:3091）。 */
    if (p.dim === undefined && p.n < 0) {
      if (p.top !== true) this.err('need explicit inner array size in VLAs');
      if (this.vlaMode !== 3) this.err('array size missing');
    }
    /* 形参上的那一种（第五十片）：这时候形参**还没有值**，长度只能留到函数体的开头
     * 才算 —— 所以这儿只把那段记号挂在类型上，`vlaParamCode` 进函数时再放一遍。
     * tcc 挂在 Sym 的 `vla_array_str` 上（`tccgen.c:5232`），同一件事。 */
    if (this.vlaMode === 3) {
      const ty = mkVla(elem, -1);
      ty.vlaToks = p.dim === undefined ? null : p.dim;
      ty.vlaCount = p.n < 0 ? 0 : p.n;
      return ty;
    }
    /* 这几条指令要落在**函数体**那个 MirFunc 上，哪怕我们正在 `sizeof` 的那个用完就丢的
     * 函数里：`sizeof(char[1+2*a])` 的长度是真的要算的（tcctest.c:3162 那句注释）。 */
    const outerF = this.f;
    if (this.bodyF !== null) this.f = this.bodyF;
    const f = this.f;
    const esz = vlaElem
      ? f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, elem.vla)
      : this.mod.consts.int(BigInt(typeSize(elem).size));
    let cnt;
    if (p.dim === undefined) cnt = this.mod.consts.int(BigInt(p.n));
    else {
      const v = this.replayDim(p.dim);
      if (!isInteger(v.ty.t)) this.err('size of variable length array should be an integer');
      cnt = this.gv(this.castTo(v, TY_LLONG));
    }
    const slot = this.temp(T_I64, 'vlasz');
    f.emit(OP.STORE, T_VOID, f.emit(OP.MUL, T_I64, cnt, esz, 0), REF_NONE, slot);
    this.vlaSeen = true;
    this.f = outerF;
    return mkVla(elem, slot);
  }

  /**
   * `[…]` 里那段记号用常量求值器**试**一遍：是常量就回那个数，不是就回 null。
   *
   * 试不成的那一路要求「什么都没发生」—— 记号流拨回原处（宏栈连帧一起还原，
   * 报错是从中间抛出来的，`endMacro` 那一条路走不到），于是调用方可以当作没读过。
   */
  tryConstDim(dim) {
    const cpp = this.cpp;
    const afterTok = cpp.tok;
    const afterVal = cpp.tokc;
    const frame = cpp.macroFrame;
    const depth = cpp.macroFrames.length;
    const line = cpp.file === null ? 0 : cpp.file.lineNum;
    cpp.pushTokens(dim);
    this.next();
    let n = null;
    try {
      const v = this.constExpr();
      if (this.tok === TOK_EOF) n = Number(v);
    } catch (e) {
      if (!(e instanceof OmniError)) throw e;
      n = null;
    }
    cpp.macroFrames.length = depth;
    cpp.macroFrame = frame;
    if (cpp.file !== null) cpp.file.lineNum = line;
    cpp.tok = afterTok;
    cpp.tokc = afterVal;
    this.tok = afterTok;
    this.tokc = afterVal;
    return n;
  }

  /** 收着的那段维度记号放回来当表达式读一遍（与 `replayStep` 同一手法）。 */
  replayDim(dim) {
    const savedTok = this.tok;
    const savedVal = this.tokc;
    this.cpp.pushTokens(dim);
    this.next();
    const v = this.gexpr();
    if (this.tok !== TOK_EOF) this.err('internal: 数组维度没读完');
    this.cpp.endMacro();
    this.cpp.tok = savedTok;
    this.cpp.tokc = savedVal;
    this.tok = savedTok;
    this.tokc = savedVal;
    return v;
  }

  /**
   * 形参上那些变长的维度，进函数时算一遍（tcc 的 `func_vla_arg_code`，`tccgen.c:8518`）。
   *
   * 位置必须在形参**绑好之后**：长度里写的就是别的形参（`int arr[s][3][4]` 里的 `s`）。
   * 顺序是**由里往外**：外面那一层的「一格多大」等于里面那一层的字节数，所以先递归
   * 到底再往回算 —— 与 `arrayPost` 在声明符里的顺序是同一个道理。
   *
   * 那段记号是**真的求值**，不是抄一个数：`int arr[][3][--s]`（tcctest.c:3091）会真的
   * 把 `s` 减一。
   */
  vlaParamCode(ty) {
    if (ty === null || ty === undefined) return;
    if (!isPtr(ty.t) && !isArray(ty.t)) return;
    this.vlaParamCode(ty.ref);
    /* `vlaToks` 在不在，才是「这一层是形参上待算的」的判据 —— **不能**看 `ty.vla` 是不是
     * 还等于 -1：函数体解析两遍（见 finishFunc），而类型对象只有一份，第一遍算完留在
     * 上面的槽号是**第一遍那个函数**的槽。两遍各算一次，各自的槽号才对得上。 */
    if (!isArray(ty.t) || ty.vlaToks === undefined) return;
    const elem = ty.ref;
    const esz = isVla(elem)
      ? this.vlaSizeRef(elem)
      : this.mod.consts.int(BigInt(typeSize(elem).size));
    let cnt;
    if (ty.vlaToks === null) cnt = this.mod.consts.int(BigInt(ty.vlaCount));
    else {
      const v = this.replayDim(ty.vlaToks);
      if (!isInteger(v.ty.t)) this.err('size of variable length array should be an integer');
      cnt = this.gv(this.castTo(v, TY_LLONG));
    }
    const slot = this.temp(T_I64, 'vlasz');
    this.f.emit(OP.STORE, T_VOID, this.f.emit(OP.MUL, T_I64, cnt, esz, 0), REF_NONE, slot);
    ty.vla = slot;
  }

  /**
   * 当前的 `(` 是**分组**还是形参表。
   *
   * 位置本来就能分开这两件事：形参表只会跟在名字（或者里层那一组）**后面**，而这儿是
   * 声明符的开头。抽象声明符是唯一的例外 —— `int (*)(void)` 里的第一个 `(` 是分组，
   * `int (void)`（一个函数类型）里的那个是形参表。所以只在这一处看一格：
   * 后面是类型的开头或者 `)` 的话就是形参表，别的都是分组。
   */
  isGroupParen() {
    this.next();
    const t = this.tok;
    const group = !(t === RPAR || t === TOK_DOTS || this.isTypeStart(t));
    this.cpp.ungetTok(LPAR);
    this.tok = this.cpp.tok;
    this.tokc = this.cpp.tokc;
    return group;
  }

  /**
   * 形参表：`(` 已经在手上。回 `{params, variadic}`。
   * `(void)` 是「没有形参」；`()` 是「形参没说」（老式声明），这一片当没有形参处理。
   */
  funcParams() {
    this.skip(LPAR);
    /* 形参上的 `[n]`（`void f(int n, int a[n])`）是**另一件事**：最外面那一维按 C 的
     * 规矩变成指针（`paramList` 那一句 `mkPointer`），里面那些维度的长度要留到函数体的
     * 开头才求值 —— 那时形参才有值。所以形参表里是第三种模式：照样先试常量，试不成就
     * 把那段记号挂在类型上（tcc 的 `vla_array_str`），不当场发指令。 */
    const saveVla = this.vlaMode;
    this.vlaMode = 3;
    try {
      return this.funcParamsBody();
    } finally {
      this.vlaMode = saveVla;
    }
  }

  funcParamsBody() {
    /** @type {{name:string,ty:object}[]} */
    const params = [];
    /* `int f()` —— 括号里**什么都没写**：这不是「没有形参」，而是「形参没说」
     * （C11 6.7.6.3 第 14 段），tcc 记的也是 `FUNC_OLD`（`post_type` 里 `l == 0` 那一支）。
     * 于是它与任何形参表相容（`compareTypes` 的函数那一支），调用点也不核对个数。
     * 「真的没有形参」是 `int f(void)`，那一种在下面。 */
    if (this.tok === RPAR) {
      this.next();
      return { params, variadic: false, old: true };
    }
    if (this.tok === TOK_VOID) {
      // `(void)` = 没有形参；`(void *p)` 之类要交回去按普通形参走
      this.next();
      if (this.tok === RPAR) {
        this.next();
        return { params, variadic: false };
      }
      this.cpp.ungetTok(TOK_VOID);
      this.tok = this.cpp.tok;
      this.tokc = this.cpp.tokc;
    }
    /* K&R 的**标识符表**（`tccgen.c:5077-5082`）：`int op(a, b)` 里括号中是名字，
     * 不是类型。类型一律先当 int，真正的类型在 `{` 之前那串声明里
     * （`oldParamDecls`）—— 没有那串的话 int 就是最终答案。 */
    if (this.tok >= TOK_UIDENT && !this.isTypeStart(this.tok)) {
      for (;;) {
        if (this.tok < TOK_UIDENT) this.expect('identifier');
        params.push({ name: this.identName(), ty: ctype(VT_INT, null) });
        if (this.tok !== COMMA) break;
        this.next();
      }
      this.skip(RPAR);
      return { params, variadic: false, old: true };
    }
    return { params, variadic: this.paramList(params) };
  }

  /**
   * 常量表达式（`expr_const`，`tccgen.c:6795`）：数组的维度、`case` 标签、位域宽度、
   * 枚举值、静态初始化式都要它。
   *
   * tcc 那边是**同一套**表达式解析器加常量折叠 —— 它的 `vtop` 上带着 `VT_CONST`，
   * `gen_op` 顺手就折了。这一片没有折叠（文件头偏离 3：折叠是语义可见的），所以这里
   * 是一个独立的小求值器：只认常量，见到变量就报错。代价是「运算符怎么算」有两份，
   * 收益是主路上一行折叠代码都没有 —— 而 `1/0` 在数组维度里该是编译错、在表达式里
   * 该是运行时错，两份代码正好各自说对一半。
   *
   * 一个值在这儿有**两种宿主表示**：整数是 BigInt、浮点是 number —— 也就是 C 的
   * 「整型常量」与「浮点常量」这两类，原样带着走（第二十一片起整型与浮点合成一份）。
   * `constExpr` 要的是整型：落在 number 上就按 C 的规则**向零截断**
   * （C11 6.3.1.4 第 1 段），于是 `int n = 1.9;` 是 1、`char c = 65.7;` 是 'A'。
   *
   * 优先级表**共用** `precedence()`，所以结合性不会与主路分岔。
   */
  constExpr() {
    const v = this.ceCond();
    if (typeof v === 'bigint') return v;
    if (!Number.isFinite(v)) this.err('constant expression is not finite');
    return BigInt(Math.trunc(v));
  }

  /**
   * 常量表达式里的 `?:`（C11 6.6 第 3 段允许它）。macOS 的 `<sys/_types/_fd_def.h>` 靠它
   * 算 `fd_set` 的数组维度：`__DARWIN_howmany(x,y)` 展开成
   * `((((x) % (y)) == 0) ? ((x) / (y)) : (((x) / (y)) + 1))` —— 少了这一格，
   * `#include <sys/select.h>` 的那条路整条走不通。
   *
   * **两边都会算**（不是短路）。真的编译器在死的那一支上不求值，所以
   * `1 ? 0 : 1/0` 在 tcc 那边是合法的，在我们这儿会骂「除以零」。这一格记在这儿：
   * 要修就得给这台求值器一个「只读记号不算数」的模式，与 `sizeof` 那边的
   * 「发进一个用完就丢的函数」是同一个手法。
   */
  ceCond() {
    const c = this.ceInfix(this.ceUnary(), 1);
    if (this.tok !== QUEST) return c;
    this.next();
    /* 没走到的那一支同样**不求值**（C11 6.5.15 第 4 段）：`int a = 1 ? 3 : 1 / 0;`
     * 是合法的。与 `||` / `&&` 同一个计数器（`ceInfix` 的 dead）。 */
    const taken = typeof c === 'bigint' ? c !== 0n : c !== 0;
    /* GNU 的 `x ? : y`（第三十六片）：中间那一项省掉就是「x 非 0 就用 x」。
     * 常量这一路没有求值次数的问题 —— 值已经在手上了，直接当那一支。 */
    let a = c;
    if (this.tok !== COLON) {
      if (!taken) this.ceDead++;
      a = this.ceCond();
      if (!taken) this.ceDead--;
    }
    this.skip(COLON);
    if (taken) this.ceDead++;
    const b = this.ceCond();
    if (taken) this.ceDead--;
    return taken ? a : b;
  }

  /**
   * 常量表达式的**浮点**出口（静态的 `double x = 1.5 * 2;` 要它）：同一个求值器，
   * 只是最后不截断。`double x = 1 / 2;` 因此是 0.0 而不是 0.5 —— 两边都是整数就
   * **在整数里算**，转换发生在最后，不在中间。
   */
  constFloatExpr() {
    return Number(this.ceCond());
  }

  /**
   * 常量表达式里的一次转换（`(int)2.9`，也是 `constExpr` 最后那一步的通用版）。
   * 整型目标：先向零截断（C11 6.3.1.4 第 1 段），再按目标宽度回绕（6.3.1.3 第 2 段）。
   * `_Bool` 是例外：它只有「零与非零」（6.3.1.2）。
   */
  ceCastTo(ty, v) {
    if (isFloat(ty.t)) {
      const x = Number(v);
      return btype(ty.t) === VT_FLOAT ? Math.fround(x) : x;
    }
    if (!isInteger(ty.t) && !isPtr(ty.t)) this.err('invalid cast in constant expression');
    if (btype(ty.t) === VT_BOOL) return (typeof v === 'bigint' ? v !== 0n : v !== 0) ? 1n : 0n;
    let bv;
    if (typeof v === 'bigint') {
      bv = v;
    } else {
      if (!Number.isFinite(v)) this.err('constant expression is not finite');
      bv = BigInt(Math.trunc(v));
    }
    const bits = isPtr(ty.t) ? 64 : intBitsOf(ty);
    return isUnsigned(ty.t) ? BigInt.asUintN(bits, bv) : BigInt.asIntN(bits, bv);
  }

  /** 常量表达式的算子报错。被短路掉的那一半里**不报**（见 `ceInfix` 的 dead）。 */
  ceErr(msg) {
    if (this.ceDead === 0) this.err(msg);
  }

  ceInfix(left, p) {
    let acc = left;
    let t = this.tok;
    for (;;) {
      const p2 = precedence(t);
      if (p2 < p) break;
      this.next();
      /* `||` / `&&` 在常量表达式里也**短路**（C11 6.5.13/6.5.14：右边那一半不求值）。
       * 记号照旧要读掉，但那一段里的错不算 —— `int sinit24 = 2 || 1 / 0;`
       * （tcctest.c:1813，注释原话「exception in constant but unevaluated context」）
       * 是合法的。tcc 靠 `nocode_wanted` 压掉那条除零，我们靠这个计数器。 */
      const truthy = typeof acc === 'bigint' ? acc !== 0n : acc !== 0;
      const dead = (t === TOK_LOR && truthy) || (t === TOK_LAND && !truthy);
      if (dead) this.ceDead++;
      let right = this.ceUnary();
      if (precedence(this.tok) > p2) right = this.ceInfix(right, p2 + 1);
      if (dead) {
        this.ceDead--;
        acc = t === TOK_LOR ? 1n : 0n;
        t = this.tok;
        continue;
      }
      acc = typeof acc === 'bigint' && typeof right === 'bigint'
        ? ceApply(t, acc, right, (m) => this.ceErr(m))
        : cefApply(t, Number(acc), Number(right), (m) => this.ceErr(m));
      t = this.tok;
    }
    return acc;
  }

  ceUnary() {
    const t = this.tok;
    if (t === TOK_CINT || t === TOK_CUINT || t === TOK_CLLONG || t === TOK_CULLONG
      || t === TOK_CLONG || t === TOK_CULONG || t === TOK_CCHAR) {
      const v = BigInt(/** @type {bigint} */ (this.tokc));
      this.next();
      return v;
    }
    if (t === TOK_CFLOAT || t === TOK_CDOUBLE || t === TOK_CLDOUBLE) {
      const v = Number(this.tokc);
      this.next();
      return v;
    }
    if (t === TOK_STR) {
      /* 字符串字面量的下标是个常量（第八刀第二十八片）：`"ab"[1]` 就是 `'b'`。
       * 相邻的字面量先并起来（`"xy" "z"[2]` 是 `"xyz"[2]`，也就是 `'z'`），
       * 所以并完再取下标 —— 次序反了会得到 `"z"[2]`（越界）。
       *
       * 类型是 `char`，这个目标上带符号，于是 `"\xff"[0]` 是 -1。
       * 越过末尾那个 0 才是越界；正好落在它上面是 0（那个 0 属于这个数组）。
       *
       * 顺带一句量出来的数：**tcc 在静态初始化式里这一格是按目标类型的宽度读的** ——
       * `int n = "abcde"[1];` 在 tcc 那儿是 0x65646362（"bcde" 四个字节），clang/gcc
       * 与运行期的 tcc 都是 98。这是 tcc 的一个 bug（它把那个左值当成一块内存整读），
       * 而且读到的是 data 段里紧跟着的字节 —— 复现它就得连 data 段的排布一起复现。
       * 这一格我们照 C 来（读一个字节），并把这条差别记在这儿。 */
      const bytes = this.readStrTok(this.tokc);
      /* 孤零零的一个字面量是个**地址常量**（`uintptr_t cinit3 = (uintptr_t)"AA";`，
       * tcctest.c:1473）：把它铺进 data 段，值就是那个地址。带下标的那一种（`"ab"[1]`）
       * 才是整型常量，走下面那一段。 */
      if (this.tok !== LBRACK) return BigInt(this.strData(bytes));
      this.next();
      const i = Number(this.constExpr());
      this.skip(RBRACK);
      if (i < 0 || i > bytes.length) this.err('string literal index out of range');
      return BigInt.asIntN(8, BigInt(i === bytes.length ? 0 : bytes.charCodeAt(i) % 256));
    }
    if (t === TOK_LSTR) {
      // 宽的那一路同理，一格是一个带符号的 `wchar_t`（这个目标上就是 int）。
      const vals = this.readWStrTok(this.tokc);
      if (this.tok !== LBRACK) return BigInt(this.wstrData(vals));
      this.next();
      const i = Number(this.constExpr());
      this.skip(RBRACK);
      if (i < 0 || i > vals.length) this.err('string literal index out of range');
      return BigInt.asIntN(32, BigInt(i === vals.length ? 0 : vals[i]));
    }
    if (t === TOK_LAND) {
      /* `static void *t[] = { &&l1 };` —— 标签的编号就是那个「地址」，是个常量。 */
      this.next();
      return BigInt(this.labelValue(this.identName()));
    }
    // 一元 `+` / `-` 在 BigInt 与 number 上是同一个写法，所以这两格不分岔
    if (t === PLUS) { this.next(); return this.ceUnary(); }
    if (t === MINUS) { this.next(); return -this.ceUnary(); }
    if (t === TILDE) {
      this.next();
      const v = this.ceUnary();
      if (typeof v !== 'bigint') this.err("invalid operand to unary '~' (floating point)");
      return ~(/** @type {bigint} */ (v));
    }
    if (t === BANG) {
      // `!` 在浮点上是合法的（C11 6.5.3.3 第 5 段），结果是 int
      this.next();
      const v = this.ceUnary();
      return (typeof v === 'bigint' ? v === 0n : v === 0) ? 1n : 0n;
    }
    if (t === LPAR) {
      this.next();
      /* `(int)2.9` —— 常量表达式里的强制转换（数组维度与 `case` 标签上都常见）。
       * 括号后面是类型名就按转换走，否则一律当分组。 */
      if (this.isTypeStart(this.tok)) {
        const ty = this.typeName();
        this.skip(RPAR);
        /* `(T){…}` —— 静态初始化式里的复合字面量（第八刀第四十片）。
         *
         * 标量的那一种**不必真的划地方**：`int cinit4 = (int){44};` 的值就是里面那一项，
         * 那个对象的地址谁都看不见。取了地址的那一种（`&(void*){(void*)52}`）走的是
         * 下面 `&` 那一格 —— 它借表达式一路，于是会真的在 data 段里划一块。 */
        if (this.tok === LBRACE && !isArray(ty.t) && !isStruct(ty.t)) {
          this.next();
          const v = this.ceCastTo(ty, this.ceCond());
          if (this.tok === COMMA) this.next();
          this.skip(RBRACE);
          return v;
        }
        /* 聚合的那一种（`int *cinit2 = (int []){3,2,1};`）：真的划一块、按常量铺好，
         * 值是它的地址 —— 数组退化成指针正是这个数。与 `&` 那一格同一手法：
         * 借表达式一路，拿到的左值地址本身就是常量。 */
        if (this.tok === LBRACE) {
          const scratch = new MirFunc('$cl', [], T_VOID);
          const outer = this.f;
          this.f = scratch;
          const v = this.compoundLiteral(ty);
          this.f = outer;
          const k = this.mod.consts.get(v.mem.addr);
          if (k.kind !== 'int') this.err('constant expression expected');
          return BigInt(k.text) + BigInt(v.mem.off);
        }
        return this.ceCastTo(ty, this.ceUnary());
      }
      /* 分组：回的是原样值 —— 不在这儿提前截断，否则 `(1.5 + 1) * 2` 会算成 4。
       * 走 `ceCond` 而不是 `ceInfix`：括号里可以有 `?:`。 */
      const v = this.ceCond();
      this.skip(RPAR);
      return v;
    }
    if (t === TOK_SIZEOF) {
      /* 类型名与表达式两种写法都走 `sizeofType` —— 与表达式一路同一段代码。
       * `sizeof(表)/sizeof(表[0])` 这种数组长度算式于是在数组维度、`case` 标签、
       * 位域宽度这些「必须是常量」的位置上也能用（tccdbg.c 的 `N_DEFAULT_DEBUG`）。 */
      this.next();
      const sty = this.sizeofType();
      /* 变长数组的 `sizeof` 不是常量（那个数在运行期才有）。这一句报出来之后，数组维度
       * 那一路（`tryConstDim`）会接着把它当变长的读一遍 —— `int b[sizeof a]` 于是也是
       * 一个变长数组，正是 C 说的那样。 */
      if (isVla(sty)) this.err('constant expression expected');
      return BigInt(typeSize(sty).size);
    }
    /* `__alignof__` 也要能出现在「必须是常量」的位置上（`_Alignas`、数组维度、
     * `_Static_assert` 里都有）。符号那一份对齐同样算进来。 */
    if (t === TOK_ALIGNOF1 || t === TOK_ALIGNOF2 || t === TOK_ALIGNOF3) {
      this.next();
      this.symAlign = 0;
      const ty = this.sizeofType();
      return BigInt(this.symAlign !== 0 ? this.symAlign : typeSize(ty).align);
    }
    if (t === AMP) {
      /* `offsetof(T, f)` 展开出来就是这个形状（tccdefs.h 的 `__builtin_offsetof`：
       * `((__SIZE_TYPE__)&((T*)0)->f)`）。tcc 那边它一点都不特殊 —— `(T*)0` 是个
       * VT_CONST 的 0，`->f` 只是往上加一个偏移，于是它自然是常量。
       *
       * 我们的常量求值器是**另一台**机器（只认记号，不建值），所以这一格借表达式一路：
       * 在一个用完就丢的函数里解析（与 `sizeof` 同一手法），拿到的内存左值如果地址
       * 本身是个常量，那「地址常量 + 静态偏移」就是这个常量表达式的值。
       * 地址不是常量（`&某个全局`）的那一种还没到 —— 那要真的重定位。 */
      this.next();
      const scratch = new MirFunc('$addr', [], T_VOID);
      const outer = this.f;
      this.f = scratch;
      const v = this.unary();
      this.f = outer;
      if (v.mem !== null && isConstRef(v.mem.addr)) {
        const k = this.mod.consts.get(v.mem.addr);
        if (k.kind === 'int') return BigInt(k.text) + BigInt(v.mem.off);
      }
      this.err('constant expression expected');
    }
    if (t >= TOK_UIDENT) {
      const nm = this.cpp.tokStr(t, null);
      /* 枚举常量。`enum {A, B = A + 2}` 里的 `A` 走这一格 —— 也就是说 enumDecl 一边
       * 登记一边求值这件事在这里闭环。查不到就落到下面报「要一个常量表达式」。 */
      const ec = this.ecLookup(nm);
      if (ec !== undefined) {
        this.next();
        return ec.val;
      }
      /* 函数名是一个**地址常量**（C11 6.6 第 9 段），所以它能当静态初始化式：
       * `static int (*tab[])(int) = { twice, thrice };` —— tinycc 自己的源码里到处是
       * 这种表。真的目标文件里这是一条重定位；我们的「链接」是一个数，所以它就是
       * 那个函数指针值（函数号 + 1，见 ir.js 的 `CALLI`）。 */
      const fn = this.funcs.get(nm);
      if (fn !== undefined && fn.declared) {
        this.next();
        fn.used = true;
        return fnPtr(fn.no);
      }
    }
    this.err('constant expression expected');
    return 0n;
  }

  /**
   * `_Static_assert(表达式, "话")`（`tccgen.c:8704`）：假就当场报那句话。
   * macOS 的 `<mach/message.h>` 拿它钉住 mach 消息那几个结构体的尺寸 ——
   * 也就是说这一格顺手在**考我们的 struct 布局**（位域 + `#pragma pack(4)`）。
   * 声明那一层与 struct 的成员表里都能出现（tcc 两处都收）。
   */
  staticAssert() {
    this.next();
    this.skip(LPAR);
    const c = this.constExpr();
    let msg = '_Static_assert fail';
    if (this.tok === COMMA) {
      this.next();
      if (this.tok !== TOK_STR) this.expect('string constant');
      msg = this.readStrTok(this.tokc);
    }
    this.skip(RPAR);
    if (c === 0n) this.err(msg);
    this.skip(SEMI);
  }

  /**
   * `decl`（`tccgen.c:8747`）。回 `true` 表示「读掉了至少一个声明」——
   * 复合语句的循环与 `for` 的初始化都靠这个返回值区分声明与语句（`tccgen.c:7311`）。
   * @param {boolean} global 顶层（可以有函数定义）还是块内
   */
  decl(global) {
    let any = false;
    for (;;) {
      /* 多余的分号（`tccgen.c:8761-8765`）：顶层的 `;` 读掉就算。系统头里到处是 ——
       * macOS 的 `<os/object.h>` 那些宏在非 Objective-C 下展开成空，
       * `OS_WORKGROUP_SUBCLASS_DECL_PROTO(…);` 整行就只剩一个分号。
       * 块内也一样（那是一条空语句，`stmt` 那边照旧认）—— 所以这一格只在顶层收。 */
      if (global && this.tok === SEMI) {
        this.next();
        any = true;
        continue;
      }
      /* 顶层的 `__asm__(…)`（`asm_global_instr`，`tccgen.c:8774`）。与语句那一层
       * 同一个界：空模板放过，非空的报错。 */
      if (global && (this.tok === TOK_ASM1 || this.tok === TOK_ASM2 || this.tok === TOK_ASM3)) {
        this.asmInstr();
        this.skip(SEMI);
        any = true;
        continue;
      }
      /* `_Static_assert(表达式, "话")`（`tccgen.c:8704`）：假就当场报那句话。
       * macOS 的 `<mach/message.h>` 拿它钉住 mach 消息那几个结构体的尺寸 ——
       * 也就是说这一格顺手在**考我们的 struct 布局**（位域 + `#pragma pack(4)`）。 */
      if (this.tok === TOK_STATIC_ASSERT) {
        this.staticAssert();
        any = true;
        continue;
      }
      /* 顶层一个**光头的标识符**开头：K&R 的「省掉 int」（`tccgen.c:8777-8781`）。
       * `f() { … }` 与 `kr_func1(a, b) { … }` 都是这一格 —— 类型默认 int。
       * 只在文件作用域成立：块里那样开头的是表达式语句，不是声明。 */
      const oldint = global && !this.isTypeStart(this.tok) && this.tok >= TOK_UIDENT;
      if (!oldint && !this.isTypeStart(this.tok)) break;
      /* `typedef_and_label:` —— 一个 typedef 名后面跟 `:` 是**语句标签**，不是声明的
       * 开头（tcc 的那一格在 `block` 里：`if (tok == ':' && t >= TOK_UIDENT)` 先判，
       * 所以标签比声明先赢）。这儿只往前看一格再把名字交回去。 */
      if (!global && this.tok >= TOK_UIDENT && this.isTypeStart(this.tok)) {
        const t0 = this.tok;
        this.next();
        const isLabel = this.tok === COLON;
        this.cpp.ungetTok(t0);
        this.tok = this.cpp.tok;
        this.tokc = this.cpp.tokc;
        if (isLabel) break;
      }
      const sad = { aligned: 0, packed: false, weak: false };
      const spec = oldint ? ctype(VT_INT, null) : this.parseBtype(sad);
      const isTypedef = (spec.t & VT_TYPEDEF) !== 0;
      const isExtern = (spec.t & VT_EXTERN) !== 0;
      const isInline = (spec.t & VT_INLINE) !== 0;
      /* 存储类**先剥掉**再进声明符：`static int a[3];` 的类型是 `int[3]`，而「剥」
       * 必须在套数组之前 —— 套完再剥就得重建一个 CType，而 `count` 挂在对象上
       * （ctype.js:129），重建时最容易掉的正是它。 */
      const base = stripStorage(spec);
      /* 变长数组只在**函数体里**成立（tcc 的判据是 `local_stack`，`tccgen.c:5168`）。
       * 带存储类的那一种降一级：`static int a[n]` 要常量，而 `static int (*p)[n]` 不要 ——
       * 见 `vlaMode` 头上那段。 */
      const canVla = !isTypedef && !isExtern && (spec.t & VT_STATIC) === 0;
      const vlaMode = global ? 0 : (canVla ? 2 : 1);
      any = true;
      if (this.tok === SEMI) { this.next(); continue; }
      let wasBody = false;
      for (;;) {
        const dad = { aligned: sad.aligned, packed: sad.packed, weak: sad.weak === true };
        this.vlaMode = vlaMode;
        const d = this.declarator(base, 'need', dad);
        this.vlaMode = 0;
        const name = /** @type {string} */ (d.name);
        /* 声明符后面还能挂两样东西（第八刀第十六片，系统头里全是）：
         *   `__asm("_name")` —— 符号改名，读掉不改名（见 `skipAsmName`）；
         *   `__attribute__((…))` —— 整块跳过。
         * 顺序两种都有（`int f(void) __asm("_f") __attribute__((weak));`），所以
         * 交替着吃到不是它们为止。 */
        for (;;) {
          const t2 = this.tok;
          if (t2 === TOK_ASM1 || t2 === TOK_ASM2 || t2 === TOK_ASM3) {
            this.skipAsmName();
            continue;
          }
          if (t2 === TOK_ATTRIBUTE1 || t2 === TOK_ATTRIBUTE2) { this.parseAttrs(dad); continue; }
          break;
        }

        if (isTypedef) {
          /* `typedef` 不声明对象，只给一个类型起名。重复的 typedef 是合法的（C11
           * 6.7 第 3 段：同一个类型可以说两遍），不同类型的重名才是错。
           * 只跟**这一层**比：里层的同名 typedef 是遮住外层，不是重定义。 */
          const prev = this.tdefScope().get(name);
          if (prev !== undefined && prev !== null && !sameType(prev, d.ty)) {
            this.err(`typedef '${name}' redefined with a different type`);
          }
          this.tdefScope().set(name, d.ty);
          /* `typedef unsigned long long __attribute__((aligned(4))) T;`（第六十一片）：
           * 属性跟着**名字**走（tcc 的 `sym->a = ad.a`，`tccgen.c:8926`），下次用到这个
           * 名字时再并进那一份 `ad`。挂在类型对象上是因为我们的 typedef 表存的就是类型
           * —— 与 `count` 同一个位置、同一种带法。 */
          if (dad.aligned > 0) d.ty.talign = dad.aligned;
        } else if (isFunc(d.ty.t)) {
          if (this.funcDecl(global, name, d.ty, isInline, (spec.t & VT_STATIC) !== 0,
            dad.weak === true, dad.aliasTarget)) {
            wasBody = true; break;
          }
        } else {
          /* 局部量与全局量走**同一段**代码：不同的只有「往哪儿落地」（一个 dest 对象），
           * 遍历嵌套结构那套规则在 `initializer` 里只有一份。 */
          const hasInit = this.tok === ASSIGN;
          /* `extern int x = 1;`（tcctest.c:1827，第四十六片）在**文件作用域**上是一条
           * 定义 —— `extern` 那个存储类被初始化式压过去了（C11 6.9.2 的脚注；gcc 只警告
           * 一句，tcc 一声不响地收）。块里那一种 tcc 连那个 `=` 都不认，报的是
           * `';' expected` —— 所以要在吃掉它之前判。 */
          if (hasInit && isExtern && !global) this.skip(SEMI);
          if (hasInit) this.next();
          /* 变长数组不能有初始化式（C11 6.7.9 第 3 段；tcc 的
           * `variable length array cannot be initialized`）—— 铺初始化式要先知道有几格。 */
          if (hasInit && isVla(d.ty)) this.err('variable length array cannot be initialized');

          /* 不定长数组（`int a[] = {…}`）的类型要等初始化式才定得下来 —— 于是这儿
           * 「定类型」与「划地方」的顺序是反的：先看初始化式，再声明。 */
          let vty = d.ty;
          let body = null;
          let strBytes = null;
          let wstrVals = null;
          const braced = hasInit && this.tok === LBRACE;
          if (isArray(vty.t) && vty.count < 0 && !isVla(vty)) {
            if (!hasInit) {
              /* `extern const char *const sys_errlist[];`（第八刀第十六片）——
               * `extern` 的数组可以是**不完整类型**（C11 6.7.6.2 第 4 段）：大小在别的
               * 翻译单元里。这儿按 0 个元素登记：不占 data 段，`sizeof` 会得到 0
               * （真的编译器那儿是一条错误 —— 那一格还没到）。
               *
               * 文件作用域上不带 `extern` 的那一种是**试探性定义**（C11 6.9.2，
               * 第三十九片）：`static int t[];` 合法，长度由后面同名的那一条补上。
               * 所以那时**留着** count < 0 交给 `declareGlobal` —— 它登记一条
               * 「还没划地方」的登记。局部量没有这一说，照旧报错。 */
              if (!global && !isExtern) this.err(`array size missing in '${name}'`);
              if (!global || isExtern) vty = mkArray(vty.ref, 0);
            } else if (this.tok === TOK_STR) {
              /* 相邻的字面量要拼起来（`char s[] = "a" "b"`），所以只能真的读一遍；
               * 读完记号已经吃掉，字节留在手上。 */
              strBytes = this.readStrTok(this.tokc);
              vty = mkArray(vty.ref, strBytes.length + 1);
            } else if (this.tok === TOK_LSTR && btype(vty.ref.t) === VT_INT) {
              /* `wchar_t s[] = L"ab"` —— 同一件事，一格四字节。 */
              wstrVals = this.readWStrTok(this.tokc);
              vty = mkArray(vty.ref, wstrVals.length + 1);
            } else if (btype(vty.ref.t) === VT_BYTE
              && (strBytes = this.tryBracedStr()) !== null) {
              /* `char a[] = { "abc" };`（第八刀第二十八片）—— 与上一格同一件事，
               * 只是外面多一对花括号。大小照样是 strlen + 1，而**不是**「1 个元素」。 */
              vty = mkArray(vty.ref, strBytes.length + 1);
            } else if (btype(vty.ref.t) === VT_INT
              && (wstrVals = this.tryBracedStr(TOK_LSTR)) !== null) {
              vty = mkArray(vty.ref, wstrVals.length + 1);
            } else {
              const r = this.sizeFromInit(vty);
              vty = r.ty;
              body = r.body;
            }
            if (vty.count === 0 && hasInit) this.err(`zero-sized array '${name}'`);
          }

          /* 柔性数组成员配初始化式（第六十二片）：`sizeof` 不变，但这块地方要真的够大 ——
           * 不然后面那个全局量就压在同一段字节上（tcctest.c 的 `cix2` / `arrtype3`
           * 两行错的就是这个）。 */
          let extra = 0;
          if (braced && this.flexField(vty) !== null) {
            const r = this.flexInit(vty);
            extra = r.extra;
            body = r.body;
          }

          /* 变量自己写的 `__attribute__((aligned(N)))`（tcctest.c:1007 的
           * `struct aligntest7 altest7[2] __attribute__((aligned(16)));`）：
           * 它抬的是**这一个符号**的对齐，不是类型的 —— 所以只喂给分配那一步。
           *
           * 「往哪儿落地」有四种（第五十七片）：文件作用域、块里的 `static`、块里的
           * `extern`、真的局部量。前三种都在 data 段上，所以初始化式走的是静态那一路。 */
          const hasStatic = (spec.t & VT_STATIC) !== 0;
          const inData = global || hasStatic || isExtern;
          let e;
          if (global && dad.aliasTarget !== undefined) {
            /* 数据的别名（第一百〇五片）：`extern int b __attribute__((alias("a")));`
             * 不占新的字节 —— 它是 `a` 那块地方的第二个名字。登记复制一份目标的
             * （地址、类型都跟着目标），另记一条 `aliasOf` 让封盘那步别再切一块数据出来。 */
            const tgt = this.gvars.get(dad.aliasTarget);
            if (tgt === undefined || tgt.defined !== true || tgt.addr < 0) {
              this.err('unsupported forward __alias__ attribute');
            }
            const tno = tgt.gno === undefined
              ? this.mod.globalNo(dad.aliasTarget) : tgt.gno;
            this.mod.addAlias(name, 'g', tno, dad.weak === true);
            /* `gno` 明着写成**目标的**号：同一个单元里用这个别名（`GADDR`）取的就是目标
             * 那一格的地址，不会另外登记一个空的全局。 */
            e = { ...tgt, name, gno: tno, aliasOf: dad.aliasTarget };
            this.gvars.set(name, e);
          } else if (global) {
            e = this.declareGlobal(name, vty, isExtern && !hasInit, dad.aligned, extra);
            /* `static` 的全局量是内部链接（第九十二片）。记在登记上、封盘那一步才用 ——
             * 与函数那一侧同一个道理：先写 `static int x;` 后写 `int x = 1;` 是合法的。 */
            if (hasStatic) e.isStatic = true;
            /* `weak`（第一百〇四片）：与 `static` 同一种带法 —— 记在登记上，封盘那一步
             * 才变成符号的绑定。属性写在哪一条声明上都算（`__attribute__((weak)) int x;`
             * 与 `int x __attribute__((weak));` 都有人写），所以只往上加不往下抹。 */
            if (dad.weak === true) e.weak = true;
          } else if (isExtern) e = this.declareExternLocal(name, vty, hasInit, dad.aligned);
          else if (hasStatic) e = this.declareStaticLocal(name, vty, dad.aligned, extra);
          else e = this.declareLocal(name, vty, dad.aligned, extra);
          if (hasInit) {
            let dest;
            let base;
            if (inData) {
              dest = { stat: true, addr: e.addr !== undefined ? e.addr : e.gvar.addr };
              base = 0;
            } else if (e.off >= 0) {
              dest = { stat: false, addr: this.fpRef };
              base = e.off;
            } else {
              dest = { slot: e.slot };
              base = 0;
            }
            /* 花括号的初始化式只覆盖写出来的那些，剩下的按 C 要是 0。静态那一侧免费
             * （线性内存出生就是 0），自动这一侧先整块清零。 */
            if (braced && !inData && e.off >= 0) {
              this.autoZero(this.fpRef, e.off, typeSize(vty).size + extra);
            }
            if (strBytes !== null) this.initString(dest, base, vty, strBytes);
            else if (wstrVals !== null) this.initWString(dest, base, vty, wstrVals);
            else if (body !== null) {
              this.replayBraced(body, () => this.initializer(dest, base, vty));
            } else this.initializer(dest, base, vty);
          }
        }
        if (this.tok !== COMMA) break;
        this.next();
      }
      // 函数**定义**的 `}` 已经吃掉了，后面不跟 `;`（`int f(){} int g(){}` 是合法的）
      if (wasBody) continue;
      this.skip(SEMI);
    }
    return any;
  }

  /** 函数声明或定义。当前记号是 `(`。回 true 表示读掉了一个**函数体**。 */
  funcDecl(global, name, fnTy, isInline, isStatic, isWeak = false, aliasTarget = undefined) {
    /* 别名（第一百〇五片）：`int f2(int) __attribute__((alias("f1")));` 不是一条外部声明
     * —— 它是**同一个地址的第二个名字**。所以在 `funcSym` 之前拦下来：不建 MirFunc、
     * 不发桩，只把名字接到目标那一格上，再记一条别名让写目标文件那步发符号。
     *
     * 目标必须**已经定义**（tcc 也是这一条：`tccgen.c:8978-8980` 找不到 elfsym 就报
     * `unsupported forward __alias__ attribute` —— 别名得跟着目标一起发出去，而一遍过的
     * 编译器在目标出现之前不知道它落在哪儿）。 */
    if (aliasTarget !== undefined) {
      const tgt = this.funcs.get(aliasTarget);
      if (tgt === undefined || !tgt.defined) {
        this.err('unsupported forward __alias__ attribute');
      }
      const prev = this.funcs.get(name);
      if (prev !== undefined && prev.defined) this.err(`redefinition of '${name}'`);
      this.funcs.set(name, tgt);
      this.mod.addAlias(name, 'f', tgt.no, isWeak === true);
      return false;
    }
    const info = this.funcSym(name);
    /* `weak`（第一百〇四片）：写在原型上算，写在定义上也算 —— 与 `static` 同一种带法。
     * tcc 那边是 `merge_symattr` 把两条声明的属性并起来。 */
    if (isWeak === true) info.f.weak = true;
    /* `static` 的函数是**内部链接**（C11 6.2.2）：符号只在这个翻译单元里有效。
     * 记在 `info` 上而不是当场用 —— 原型上写了 `static`、定义时省掉的写法是合法的，
     * 内部链接跟着第一次那个声明（第九十二片）。 */
    if (isStatic === true) info.isStatic = true;
    /* `inline` 也是局部符号 —— 这一格是量出来的，不是推出来的：tcc 那边判的是
     * `if (sym->type.t & (VT_STATIC | VT_INLINE)) sym_bind = STB_LOCAL`
     * （tccgen.c:478 与 534，两处一样），`inline` 与 `static` 同一个待遇。
     *
     * 为什么非它不可：macOS 的 `sys/cdefs.h:375` 那串条件对我们成立
     * （`__STDC_VERSION__` 是 199901L、没有 `__GNUC__`），于是 `__header_inline`
     * 展成的是**光秃秃的 `inline`**，`__sputc` 这种头里的函数身上没有 `static`。
     * 当外部符号发的话，十二个翻译单元一链就是十二个 `___sputc`。 */
    if (this.native && (info.isStatic === true || isInline === true)) info.f.local = true;
    /* K&R 的形参声明串（`tccgen.c:8811-8819`）：`)` 与 `{` 之间那几行。
     * 只有老式的函数、而且在文件作用域才认 —— 与 tcc 同一个条件。 */
    if (global && fnTy.ref.old === true) this.oldParamDecls(fnTy.ref.params);
    /* 形参表已经在声明符里读完了（第十二片：`(…)` 是声明符的后缀，不是函数定义的
     * 一部分）—— 这儿只把函数类型拆开交给 `finishFunc`。`inline` 从 `decl` 传进来：
     * 存储类在进声明符之前就剥掉了（`stripStorage`），函数类型上已经没有它。 */
    return this.finishFunc(global, info, name, stripStorage(fnTy.ref.ret),
      fnTy.ref.params, fnTy.ref.variadic, isInline, fnTy.ref.old === true);
  }

  /**
   * K&R 的形参声明串：`void f(a, b) int a; double b; { … }` 里中间那一段。
   *
   * 它不声明新东西，只是**给已经在标识符表里的那些名字定类型**（`tccgen.c:8897-8912`）：
   * 名字对不上是错，重复声明同一个形参是错，带存储类是错。类型照形参的规则退化
   * （数组/函数 -> 指针），而老式形参里的 `float` 要提成 `double`
   * （`tccgen.c:8867-8870` —— 调用方按「实参提升」传的就是 double）。
   */
  oldParamDecls(params) {
    const done = new Set();
    while (this.isTypeStart(this.tok) && this.tok !== LBRACE) {
      const spec = this.parseBtype();
      if ((spec.t & VT_STORAGE) !== 0) {
        this.err('storage class specified for parameter');
      }
      const base = stripStorage(spec);
      for (;;) {
        const d = this.declarator(base, 'need');
        if (d.name === null) this.expect('identifier');
        const p = params.find((x) => x.name === d.name);
        if (p === undefined) {
          this.err(`declaration for parameter '${d.name}' but no such parameter`);
        }
        if (done.has(d.name)) this.err(`redefinition of parameter '${d.name}'`);
        done.add(d.name);
        let ty = d.ty;
        if (isArray(ty.t)) ty = mkPointer(ty.ref);
        if (isFunc(ty.t)) ty = mkPointer(ty);
        if (btype(ty.t) === VT_VOID) this.err('parameter has void type');
        /* 老式形参上的 float 就是 double —— 调用方那一侧提升过了，
         * 形参再按 float 收会把一个 double 的位模式当 float 读。 */
        if (btype(ty.t) === VT_FLOAT) ty = ctype((ty.t & ~VT_BTYPE) | VT_DOUBLE, null);
        this.needComplete(d.name, ty);
        p.ty = ty;
        if (this.tok !== COMMA) break;
        this.next();
      }
      this.skip(SEMI);
    }
  }

  paramList(params) {
    let variadic = false;
    for (;;) {
      if (this.tok === TOK_DOTS) {
        /* `...`：变参。C 要求它前面至少有一个具名形参（C11 6.7.6.3 第 4 段）——
         * 因为 `va_start` 要一个「从谁之后开始」的锚。 */
        if (params.length === 0) this.err("at least one parameter before '...'");
        this.next();
        variadic = true;
        break;
      }
      const spec = this.parseBtype();
      const d = this.declarator(stripStorage(spec), 'opt');
      let ty = d.ty;
      /* 形参上的数组**就是**指针（C11 6.7.6.3 第 7 段）：`int f(int a[])` 与
       * `int f(int *a)` 是同一个函数。所以这里退化，而不是让 declareLocal 去帧上划
       * 一块 —— 那块地方永远也填不上，因为实参传进来的是一个地址。 */
      if (isArray(ty.t)) ty = mkPointer(ty.ref);
      /* 形参上的函数类型**就是**函数指针（C11 6.7.6.3 第 8 段）：`int f(int g(void))`
       * 与 `int f(int (*g)(void))` 是同一个函数。 */
      if (isFunc(ty.t)) ty = mkPointer(ty);
      if (btype(ty.t) === VT_VOID) this.err('parameter has void type');
      /* 传值的 struct 传的是**地址**（第十一片的 ABI，见 `runBody` 与 `funcCall`）：
       * 调用方给出实参那个对象的地址，被调方在入口处拷进自己的帧。arm64/x64 真的 ABI
       * 里 ≤16 字节还能走寄存器，那是后端那几步的事 —— 前端这一层只需要地址。 */
      this.needComplete(d.name === null ? 'parameter' : d.name, ty);
      // 形参名可以省（原型里），那就给它一个占位名
      const pn = d.name === null ? `$p${params.length}` : d.name;
      /* 形参**保留声明的类型**（`char c` 就是 char）。「实参提升」（`char` -> `int`）
       * 只对**没有原型**的函数与变参的可变部分成立（C11 6.5.2.2 第 6 段）——
       * 有原型时是**调用方**把实参转成声明的类型，见 funcCall。
       * 这一格搞反过一次：形参提成 int 之后 `int f(char c){return c;}` 里的 c 不再收口，
       * 于是 `f(300)` 回 300 而不是 44。 */
      params.push({ name: pn, ty });
      if (this.tok !== COMMA) break;
      this.next();
    }
    this.skip(RPAR);
    return variadic;
  }

  /**
   * 函数定义（`gen_function`，`tccgen.c:8020` 一带）加**帧的两遍解析**。
   *
   * ## 为什么函数体要解析两遍
   *
   * `&x` 要求 `x` 有地址，也就是落在线性内存上。哪些局部量被取过地址，一遍过里**没法
   * 提前知道** —— 声明在前，`&` 在后。tcc 不需要知道：它把所有局部量都放在栈帧上
   * （`loc -= size`），而「帧有多大」是在函数体读完之后**回填**进序言的
   * （`gfunc_prolog` 与 `gfunc_epilog` 之间那次回填）。
   *
   * MIR 不能回填（文件头偏离 2），序言里那个常量必须在发它之前就定下来。办法：函数体
   * 的记号先整块收下来（`Cpp.captureBraced`），放一遍**把输出丢掉**（发进一个用完就扔
   * 的 MirFunc，与 `sizeofExpr` 同一手法），收集「谁被取过地址」与帧大小的上界；
   * 再放一遍才是真的。
   *
   * 代价是函数体解析两遍。换来的是绝大多数局部量仍然留在 MIR 的槽上（后端能把它们分到
   * 寄存器），只有真被取地址的那些落到内存 —— 这与 tcc 那种「全部上栈」在生成的代码上
   * 差得很远，而我们没有它的回填能力。
   *
   * ## 平铺的帧
   *
   * 帧里**一个声明一个偏移，兄弟块之间不复用**。复用能省空间，但要在块结束时回退分配
   * 指针；循环体里那样做的话 `$sp` 每轮都动，`&x` 在两轮之间就不是同一个地址。
   * C 允许它不同，可那会让「循环里取地址」变成一件说不清的事。平铺让每个声明的地址在
   * 整个函数里恒定，代价是帧大一点。
   */
  finishFunc(global, info, name, ret, params, variadic, isInline, old) {
    if (info.params !== null && info.params.length !== params.length) {
      this.err(`conflicting types for '${name}'`);
    }
    info.params = params;
    info.ret = ret;
    info.variadic = variadic === true;
    /* 老式的（`FUNC_OLD`）：调用点不核对实参个数（`gfunc_param_typed`，
     * `tccgen.c:5352` —— 没有原型就没有可核对的东西）。 */
    info.old = old === true;
    info.declared = true;
    info.f.ret = mirTypeOf(ret);

    if (this.tok !== LBRACE) return false;          // 只是个原型，`;` 交给 decl
    if (!global) this.err('nested function definition');
    if (info.defined) this.err(`redefinition of '${name}'`);
    info.defined = true;

    const body = this.cpp.captureBraced();
    const afterTok = this.cpp.tok;
    const afterVal = this.cpp.tokc;

    if (isInline) {
      /* `inline` 的函数体**先收着**，读完整个单元再看谁真被引用过才发
       * （`tccgen.c:8873-8883`：「static inline 函数只是一种宏」）。
       *
       * 这不是优化。macOS 的 `math.h` 里有一串 `__header_always_inline` 的定义，
       * 其中 `__sincosf` 的体里调 `__sincosf_stret` —— 一个返回 struct 的外部符号。
       * body 一进来就分析的话，那个名字当场被标成「引用过」，于是一份根本没用到
       * 三角函数的程序会撞上「外部函数返回 struct 还没到」。tcc 编得过，正是因为
       * 它连体都还没读。
       *
       * `filename` 要记下来：诊断的行号靠记号串里的 `TOK_LINENUM`（第十九片）复原，
       * 但文件名不在记号里，而这时早已经读到主文件的末尾了。 */
      this.inlineFns.push({
        name, info, ret, params,
        body,
        filename: this.cpp.file === null ? '<inline>' : this.cpp.file.filename,
      });
      this.cpp.tok = afterTok;
      this.cpp.tokc = afterVal;
      this.tok = afterTok;
      this.tokc = afterVal;
      return true;
    }

    this.genFuncBody(body, info, name, ret, params);

    // 记号还原（`replayStep` 同一手法）：函数体是从记号串里读的，读完要回到文件流上
    this.cpp.tok = afterTok;
    this.cpp.tokc = afterVal;
    this.tok = afterTok;
    this.tokc = afterVal;
    return true;
  }

  /**
   * 一个收好的函数体 -> 两遍。第一遍只为了知道帧要多大，第二遍才是真的发指令。
   * 普通函数在 `finishFunc` 里当场走这儿，`inline` 的等到 `genInlineFuncs`。
   */
  genFuncBody(body, info, name, ret, params) {
    // ---- 第一遍：只为了知道谁要落在内存上、帧要多大。输出丢掉
    this.pass1 = true;
    this.addrTaken = new Set();
    this.declScalars = [];
    this.frameNames = new Set();
    this.frameSize = 0;
    this.frameOff = 0;
    this.vlaSeen = false;
    this.stmtRanges = [];
    this.labelIds = new Map();
    this.labelCount = 0;
    this.seLabels = new Map();
    this.fpRef = this.mod.consts.int(0n);
    this.runBody(body, new MirFunc(`$scan$${name}`, [], mirTypeOf(ret)), ret, name, params,
      info.variadic);

    let est = this.frameOff;   // 数组之类「非落内存不可」的已经算在里面了
    for (const d of this.declScalars) {
      if (this.addrTaken.has(d.name)) est += alignUp(d.size, FRAME_ALIGN);
    }
    /* 有变长数组的函数**必须**有序言与收场那一对：那块地方是运行期从 `$sp` 上切的，
     * 不把 `$sp` 在返回前还回去，递归调用一圈就把栈走穿了。帧本身一格都不用，
     * 所以只要让 `frameSize` 非 0（`runBody` 与 `emitEpilogue` 都以它为准）。 */
    if (this.vlaSeen && est === 0) est = FRAME_ALIGN;
    this.pass1 = false;
    this.frameNames = this.addrTaken;

    // ---- 第二遍：真的
    this.frameSize = alignUp(est, 16);
    this.frameOff = 0;
    this.runBody(body, info.f, ret, name, params, info.variadic);
  }

  /**
   * 收着的那些 `inline` 函数体（`gen_inline_functions`，`tccgen.c:8661`）。
   *
   * 循环到不再有新的为止：一个被引用的 inline 函数体里可以调另一个 inline 函数，
   * 而那一次引用发生在这一轮**之后** —— tcc 那边同样是 `do { } while (inline_generated)`。
   *
   * 一次都没被引用的：tcc 什么都不发。我们的 MirFunc 已经登记在模块里、拿不掉，
   * 所以给它一条 `RET` 收口 —— 谁都不会调到它，只是让模块自洽。
   */
  genInlineFuncs() {
    for (;;) {
      let any = false;
      for (const fn of this.inlineFns) {
        if (fn.done || !fn.info.used) continue;
        fn.done = true;
        any = true;
        const saveName = this.cpp.file === null ? null : this.cpp.file.filename;
        if (this.cpp.file !== null) this.cpp.file.filename = fn.filename;
        this.genFuncBody(fn.body, fn.info, fn.name, fn.ret, fn.params);
        if (saveName !== null) this.cpp.file.filename = saveName;
      }
      if (!any) break;
    }
    for (const fn of this.inlineFns) {
      if (fn.done) continue;
      const f = fn.info.f;
      if (f.ret === T_VOID) f.emit(OP.RET, T_VOID, REF_NONE, REF_NONE, 0);
      else f.emit(OP.RET, f.ret, this.konst(fn.ret, 0), REF_NONE, 0);
    }
  }

  /**
   * 把收好的函数体放一遍，发进 `f`。序言、收场、形参落位都在这儿 ——
   * 两遍走**同一段**代码，于是第一遍数出来的帧与第二遍分配出来的帧一定是同一套规则。
   */
  runBody(body, f, ret, name, params, variadic) {
    const outer = this.f;
    this.f = f;
    this.bodyF = f;
    this.funcRet = ret;
    this.funcName = name;
    this.scopes = [new Map()];
    /* 函数体这一层的 tag 也要新的一份：两遍走同一串记号，第二遍必须重新认识块里
     * 定义的那些 `struct S {…}` —— 第一遍留下的那份成员已经填好了。 */
    this.tagStack = [this.tags, new Map()];
    this.ecStack = [this.enumConsts, new Map()];
    /* typedef 名同理：形参与函数体里的变量可以遮住外面的 typedef，而那只在这个函数里算。 */
    this.tdefStack = [this.typedefs, new Map()];
    this.regions = [];
    this.swStack = [];
    /* 变长数组的那本账跟着函数走：形参那一层（`scopes[0]`）不经过 `pushScope`，
     * 而函数体的 `{` 会自己推一层 —— 所以这儿是空的。 */
    this.vlaStack = [];
    /* 两遍各自从 0 数起，于是同一条语句在两遍里是同一个序号（`block` 那个包装）。 */
    this.stmtNo = 0;
    /* 块里那些 `static` 在 data 段上的名字带着这个序号（`declareStaticLocal`）——
     * 同样是「两遍数出来一样」，于是第二遍找到的是第一遍划的那块地方。 */
    this.staticNo = 0;
    this.kids = [];
    this.pendingSwitch = null;

    if (!this.pass1) {
      this.spSave = REF_NONE;
      this.fpRef = REF_NONE;
      if (this.frameSize > 0) {
        /* native（第十九片）：一条 `FRAME` 就是整个帧 —— 前端算出来的 `frameSize` 原样
         * 交给 MIR，后端把它摆在自己的帧里（arm64 `add x, sp, #off`、x86_64
         * `lea r, [rbp - off]`）。**没有收场**：帧跟着函数走，`ret` 一收全收。
         * 帧的对齐要 16：里头可能摆 `long double`/`double` 与聚合体，而前端算偏移时
         * 假定基址至少 16 对齐（`FRAME_ALIGN` 是 8，但聚合体的对齐可以是 16）。 */
        if (this.native) {
          this.fpRef = f.emit(OP.FRAME, T_I64, REF_NONE, REF_NONE,
            f.frame('$frame', this.frameSize, 16));
        } else {
          /* 序言：`$sp -= frameSize`。`$sp` 是一个往下长的 i64 全局（ADR-0017 第三刀：
           * MIR 没有 `ADDR`，取地址靠影子栈）。帧基址就是减完那条指令的 ref —— MIR 是
           * SSA，函数顶层发的指令在整个函数体里都可用，不必再存进一个槽。 */
          const spNo = this.spGlobal();
          const sp0 = f.emit(OP.GLOAD, T_I64, REF_NONE, REF_NONE, spNo);
          const nsp = f.emit(OP.SUB, T_I64, sp0,
            this.mod.consts.int(BigInt(this.frameSize)), 0);
          f.emit(OP.GSTORE, T_VOID, nsp, REF_NONE, spNo);
          this.spSave = sp0;
          this.fpRef = nsp;
        }
      }
    }

    /* 返回 struct 的函数多一个**隐藏的第一个形参**：调用方划好的那块地方的地址
     * （第十一片的 ABI）。`return` 把返回值拷进去、再把这个地址返回，于是 MIR 那条 RET
     * 照旧只带一个 i64 —— 与 SysV 用 rax 回那个隐藏指针是同一件事。 */
    this.sretRef = REF_NONE;
    if (isStruct(ret.t)) {
      const slot = f.slot('$sret', T_I64);
      f.params.push({ name: '$sret', t: T_I64, slot });
      this.sretRef = f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, slot);
    }

    /* 形参就是前几个槽 —— MIR 的解释器按这个约定填帧（interp.js:274 的注释）。
     * 被取过地址的形参**两处都有**：ABI 那个槽照旧（值从调用方来），再拷一份到帧上，
     * 名字绑帧上那份。少了这次拷贝，`&x` 指向的是一块没人写过的内存。 */
    for (const p of params) {
      const mt = mirTypeOf(p.ty);
      const slot = f.slot(p.name, mt);
      f.params.push({ name: p.name, t: mt, slot });
      if (isStruct(p.ty.t)) {
        /* 传值的 struct：进来的是**调用方那个对象的地址**，而形参是它的一份可改的拷贝
         * （C11 6.9.1 第 10 段）。所以拷贝落在**被调方**这一侧 —— 一次调用于是只有
         * 一次拷贝，而且它正是 C 要求的那一次。 */
        const off = this.frameAlloc(p.ty);
        this.scopes[0].set(p.name, { ty: p.ty, slot: -1, off });
        if (!this.pass1) {
          this.structCopy(sMem(p.ty, this.fpRef, off),
            sMem(p.ty, f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, slot), 0));
        }
        continue;
      }
      if (!this.pass1 && this.frameNames.has(p.name)) {
        const off = this.frameAlloc(p.ty);
        this.scopes[0].set(p.name, { ty: p.ty, slot: -1, off });
        f.emit(OP.MSTORE, mt, this.fpRef,
          f.emit(OP.LOAD, mt, REF_NONE, REF_NONE, slot),
          memDesc(storeKindOf(p.ty), off));
      } else {
        this.scopes[0].set(p.name, { ty: p.ty, slot, off: -1 });
        if (this.pass1) {
          const s = typeSize(p.ty);
          this.declScalars.push({ name: p.name, size: s.size, align: s.align });
        }
      }
    }

    /* 变参函数多一个**隐藏的最后一个形参**：调用方那块变参区的地址（第十六片的 ABI，
     * 见 `vaBlock`）。`va_start` 就是把它取出来 —— 也就是说 `va_list` 在这一片里
     * 就是一个指针，而「走到下一个实参」是加 8。位置在固定形参**之后**，
     * 与调用点那一侧（`callArgs` 末尾那条 push）是同一个顺序。 */
    this.vaRef = REF_NONE;
    if (variadic === true) {
      /* native（第二十五片）：这一侧什么都不加 —— 实参在寄存器里还是栈上由**后端**按真
       * ABI 说（`VASTART`/`VAARG`，见 MIR 那两条）。前端只在函数上按一位「我是变参的」，
       * 后端照它决定序言要不要泼寄存器。 */
      if (this.native) f.setVariadic();
      else {
        const slot = f.slot('$va', T_I64);
        f.params.push({ name: '$va', t: T_I64, slot });
        this.vaRef = f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, slot);
      }
    }

    /* 形参上那些变长的维度在这儿算（第五十片，tcc 的 `func_vla_arg`，`tccgen.c:8627`）：
     * 必须在形参都绑好之后 —— 长度里写的就是别的形参。 */
    for (const p of params) this.vlaParamCode(p.ty);

    /* 这个函数里有标签 -> 摆那台**唯一**的状态机（第二十四片，见 `gotoStmt` 头上那段）：
     * 一个状态槽、一圈 `LOOP`。`goto` = 「写状态、`BR` 回这圈 LOOP 的开头」，
     * 剩下的由函数体那条分派链把控制送到位。走完函数体要**出去**而不是掉回循环开头。 */
    this.gotoSlot = -1;
    if (!this.pass1 && this.labelCount > 0) {
      this.gotoSlot = this.temp(T_I32, 'state');
      f.emit(OP.STORE, T_VOID, this.mod.consts.i32(0), REF_NONE, this.gotoSlot);
      this.open(OP.BLOCK, 'gotoend', REF_NONE);
      this.open(OP.LOOP, 'gotoloop', REF_NONE);
    }

    this.cpp.pushTokens(body);
    this.next();
    this.block();  // 当前记号是 `{`

    if (this.gotoSlot >= 0) {
      f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('gotoend'));
      this.close();      // gotoloop
      this.close();      // gotoend
    }
    if (this.tok !== TOK_EOF) this.err('internal: 函数体没读完');
    this.cpp.endMacro();

    /* 落到函数尾：C 里非 void 函数不 return 是 UB（tcc 让返回值是垃圾）。MIR 要
     * 每条路都有 RET 才良构，所以无条件补一条 —— 前面已经 RET 的路走不到这里。
     * 返回 struct 的函数补的是那个隐藏指针：回 0 会让调用方去读地址 0（页 0 是空的，
     * 当场炸），而 tcc 那边只是一块没写过的内存 —— 补指针更像它。 */
    this.emitEpilogue();
    if (f.ret === T_VOID) f.emit(OP.RET, T_VOID, REF_NONE, REF_NONE, 0);
    else if (isStruct(ret.t)) f.emit(OP.RET, T_I64, this.sretRef, REF_NONE, 0);
    else f.emit(OP.RET, f.ret, this.konst(ret, 0), REF_NONE, 0);
    this.f = outer;
    this.bodyF = null;
    /* 回到文件作用域：tag 与枚举常量的栈要收回去，不然函数**之后**的
     * `struct rec { … };` 会落在这个函数体那一层里，下一个函数就看不见它了。 */
    this.tagStack = [this.tags];
    this.ecStack = [this.enumConsts];
    this.tdefStack = [this.typedefs];
    /* tcc 在 `gen_function` 之后把 `funcname` 收回 `""`（`tccgen.c:8610`）：
     * 函数外面的 `__func__` 于是是空串，而不是上一个函数的名字。 */
    this.funcName = '';
  }

  /** `$sp` 的全局号。第一次用到才登记 —— 没有函数要帧的模块于是不多一个全局。
   *
   * native 上**一格都不能有**：那条腿没有线性内存，影子栈无从谈起。到这儿来的只剩
   * 变长数组与 `alloca`（它们在运行期切栈顶）—— 那是往后的一片，现在明着报。 */
  spGlobal() {
    if (this.native) this.todo('native：变长数组与 alloca 还要动栈顶（影子栈那套在这条腿上不成立）');
    if (this.spNo < 0) {
      this.spNo = this.mod.globalNo('$sp');
      this.mod.setGlobalTy(this.spNo, T_I64);
    }
    return this.spNo;
  }

  /** 收场：把 `$sp` 还回去。**每条 RET 之前都要**，所以单独一个函数。
   * native 上没有这一步 —— 帧是 `FRAME` 要的一块，`ret` 一收全收。 */
  emitEpilogue() {
    if (this.pass1 || this.native || this.frameSize === 0) return;
    this.f.emit(OP.GSTORE, T_VOID, this.spSave, REF_NONE, this.spNo);
  }

  /**
   * 主文件之前先读的那一小份（tccdefs.h 里的声明部分，见 tccdefs.js 的
   * `COMPILE_PREAMBLE`）。只读声明，读完**不做**那两轮收尾检查 —— 「外部符号有没有
   * 定义」要等整个单元读完才答得了，而这一份只是主文件的前半段。
   */
  preamble(text) {
    this.cpp.startParse('<tccdefs>', text);
    this.next();
    while (this.tok !== TOK_EOF) {
      if (!this.decl(true)) this.expect('declaration');
    }
  }

  /**
   * native 收尾：**不能让没有函数体的名字变成我们定义的符号**（第二十二片）。
   *
   * 每个声明过的函数在模块里都已经有一个 MirFunc（一遍过：调用点可能在定义之前）。
   * 没有函数体的那些如果留着原名，后端就会把它们当函数发出去 —— 于是我们的 `.o` 里
   * 定义了一个空的 `_snprintf`，链接器拿它盖掉 libc 那个，调用回来一堆垃圾。
   * 这个 bug 的症状离原因很远（返回值像个截断的指针），所以在这儿一次收干净：
   * 改名成 `$ext$名字`，再给一条 `RET` 收口（谁都不会调它）。
   *
   * 有桩的那些（非变参的外部函数）在 `externThunk` 里已经改过名，这儿只剩两类：
   * 变参的（调用点直接 CCALL，见 `funcCall`）与声明了却没用过的。
   */
  sealExternSymbols() {
    for (const [name, info] of this.funcs) {
      if (info.defined) continue;
      const f = info.f;
      if (f.count() !== 0) continue;
      if (f.name === name) this.mod.renameFunc(info.no, `$ext$${name}`);
      /* 与 `externThunk` 那一条同一个理由（第九十二片）：这个名字每份 `.o` 里都有。 */
      f.local = true;
      if (f.ret === T_VOID) f.emit(OP.RET, T_VOID, REF_NONE, REF_NONE, 0);
      else f.emit(OP.RET, f.ret, this.konst(info.ret, 0), REF_NONE, 0);
    }
  }

  /** 一个翻译单元（`tccgen_compile`，`tccgen.c:417-419`）。 */
  unit() {
    this.next();
    while (this.tok !== TOK_EOF) {
      if (!this.decl(true)) this.expect('declaration');
    }
    /* `decl` 读完才发那些 inline 的体（`tccgen.c:420`：`decl(VT_CONST)` 紧跟着
     * `gen_inline_functions(s1)`）。次序要紧：它可能新标出一批「引用过」的外部符号，
     * 所以必须在下面那两轮收尾检查之前。 */
    this.genInlineFuncs();
    for (const [name, info] of this.funcs) {
      if (info.defined) continue;
      /* 声明了但一次都没引用：真的编译器不为它产生任何符号引用，我们也不发桩。
       * 系统头文件一份就声明上百个函数，这一条是「能编系统头」的前提。 */
      if (!info.used) continue;
      /* 这个单元里没有函数体 = 外部符号。C99 起「隐式声明」是错，tcc 只警告（并且当
       * `int f()`）—— 照 tcc，因为它是 oracle。 */
      if (!info.declared) this.cpp.warn(`implicit declaration of function '${name}'`);
      /* 用到堆的模块要在入口处把堆的起点交给宿主（见 `lowerC` 末尾）。在这儿问而不是
       * 在调用点问：外部符号的清单正好在这个循环里，而「有没有用到」就是「它是不是
       * 这个单元里的一个外部符号」。 */
      /* 堆那几个名字只在**线性内存**那条腿上要宿主帮忙（那边 `malloc` 是宿主用一块
       * 线性内存实现的）。native 上它们就是普通的外部 C 函数 —— 走桩、`CCALL` 到真的
       * libc，一格都不用留（第九刀第二十三片）。 */
      if (!this.native) {
        if (HEAP_FNS.has(name)) this.heapUsed = true;
        if (ERRNO_FNS.has(name)) this.errnoUsed = true;
        if (name === STRERROR_FN) this.strerrorUsed = true;
      }
      /* native 上 `__omni_*` 一律明着报（第三十一片）：那几个名字是**线性内存那条腿的
       * 宿主接口**，真的 libc 里没有；放过去只会得到一条 `ld: symbol not found`，
       * 那时线索只剩一个名字。第八十九片删掉自带的那几份 libc 头之后，程序拿到的是
       * SDK 的写法（`__error`、`__stdoutp`），这条路上一个都不该再出现。 */
      if (this.native && name.startsWith('__omni_')) {
        this.todo(`native：宿主那几格（${name}）—— 还没落到真 libc 上`);
      }
      /* native 上变参函数没有桩（调用点直接 CCALL，见 `funcCall`）—— 发一个反而会
       * 定义一个签名对不上的符号。 */
      if (this.native && info.variadic) continue;
      this.externThunk(name, info);
    }
    /* `extern int x;` 之后没有定义：真的编译器要等链接期才知道。我们只有一个翻译单元，
     * 所以「用过但没定义」当场就是错。地址仍然分配过（一遍过里引用发生在定义之前，
     * 代码得先有个地址可发），所以这一问只能等到这儿再答 —— 与 `funcs` 那一条同一个理由。 */
    for (const [name, e] of this.gvars) {
      if (e.defined || !e.used) continue;
      /* native（第三十一片）：没定义**就是**外部符号，交给链接器 —— 目标文件里它落进
       * 「未定义的外部符号」那一段（`setGlobalExtern`）。这是真编译器的行为，
       * 而我们从前只有一个翻译单元、没有链接器可指望，所以只能当场报错。 */
      if (this.native) continue;
      /* 宿主提供的那几个（三条标准流，见 `STREAM_GVARS`）：不是「没定义」，是**别人定的**。
       * 记下来，入口处一条 `__omni_stream_init` 让宿主把句柄写进那一格。 */
      const which = STREAM_GVARS.get(name);
      if (which !== undefined) {
        this.streamGvars.push({ addr: e.addr, which });
        continue;
      }
      this.err(`undefined symbol '${name}'`);
    }
  }
}

/**
 * 一个 JS 串 -> 它的 UTF-8 字节（`argv` 那几个串走这儿）。
 *
 * 字符串字面量那条路（`strData`）是 `charCodeAt % 256` —— 源文件的字节在预处理器里
 * 就已经是「一个字符一个字节」了，那儿不需要再编码。命令行上的串不一样：它是 node
 * 解码过的 JS 串，要还原成字节才能写进线性内存。
 */
function utf8Bytes(s) {
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63),
        0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return out;
}

/**
 * 入口：一份 `.c` -> 一个 MIR 模块。
 *
 * MIR 的入口函数必须叫 `omni_main`（LLVM 后端自己会发一个 C 的 `main`，撞名字
 * clang 当场报重定义）。所以 C 的 `main` 照原名进模块，另外发一个
 * `omni_main`：`RET CALL main()` —— 它的返回值就是进程退出码，与 `tcc -run`
 * 的语义逐条相同（那也是这一刀的 oracle）。
 *
 * @param {string} path
 * @param {string} text
 * @param {{readFile: (p: string) => (string|null), includeDirs?: string[],
 *          dirname?: (p: string) => string, join?: (a: string, b: string) => string}} host
 * @param {{name: string, body?: string}[]} [defs] 命令行上的 `-D`
 * @param {string[]} [args] 被跑的程序自己的命令行实参（`argv[1]` 起；`argv[0]` 是 `path`）
 */
export function lowerC(path, text, host, defs, args) {
  const cpp = new Cpp(host);
  cpp.installPredefs(path, false);
  for (const d of defs ?? []) {
    if (d.body === null) cpp.undefine(d.name);   // `-U`
    else cpp.define(d.name, d.body);
  }
  const mod = new MirModule('omni_main');
  const gen = new CGen(cpp, mod);
  gen.preamble(COMPILE_PREAMBLE);
  cpp.startParse(path, text);
  gen.unit();

  /* 线性内存的版图（ADR-0017 第六刀第三片，第十五片在末尾加了堆）：
   *   [0, 64K)            页 0 整页留空 —— C 的 `NULL` 于是**一定**访问不到，
   *                       而不是「碰巧落在别的东西上」
   *   [64K, dataOff)      data 段：字符串字面量与全局量，往上长；末尾还摆着 `argv`
   *                       那几个串与那张指针表、`errno` 那一格、`strerror` 那 109 格
   *                       （都只在用到时才留）
   *   [栈底, 栈顶)        影子栈：16 对齐，`$sp` 从栈顶往下长
   *   [堆底, …)           堆：从栈顶之上的**下一个页边界**起，往上长，不够就 `MGROW`
   * `mem.min` 按栈顶（用到堆时按堆底加一页）算出页数。上界不设（0）。
   * 堆按页边界起是为了「先给整整一页」，于是 `__omni_heap_init` 写第一个字节时
   * 内存一定已经够 —— 那条初始化不必自己先长内存。 */
  /* `main` 的形参表要在**摆版图之前**问 —— `argv` 那几个串与那张指针表也住 data 段。 */
  const info = gen.funcs.get('main');
  if (info === undefined) throw new OmniError(`${path}: error: undefined symbol 'main'`);
  const mainParams = info.params ?? [];
  if (mainParams.length !== 0 && mainParams.length !== 2) {
    throw new OmniError(`${path}: error: 第八刀：'main' 只认 () 与 (int, char **)`
      + `（这份有 ${mainParams.length} 个形参）`);
  }
  if (mainParams.length === 2) {
    if (!isInteger(mainParams[0].ty.t)) {
      throw new OmniError(`${path}: error: first argument of 'main' should be 'int'`);
    }
    if (!isPtr(mainParams[1].ty.t)) {
      throw new OmniError(`${path}: error: second argument of 'main' should be 'char **'`);
    }
  }

  /* `argv`（第八刀第十一片）：命令行上的那几个串与 `argv` 那张指针表都住在 **data 段**
   * 里 —— 地址在编译期就定了，于是入口处一条写内存的指令都不必发。tcc 那边 argv 在真的
   * 进程栈上；「argv 住 data 段」是同一件事在线性内存上的写法。
   *   `argv[0]` 是**命令行上写的那个源文件名**，`argv[argc]` 是 NULL —— 两条都是从
   *   `tcc -run x.c aa bb` 上量出来的。后者不写一个字节：data 段出生全是 0。
   * 这几个串**不去重**（不走 `strData`）：C11 5.1.2.2.1 第 2 段要求 argv 的那些串是
   * **可改的**，与某个字符串字面量共享一份就会让改一个把另一个也改了。 */
  const argvStrs = mainParams.length === 2 ? [path, ...(args ?? [])] : [];
  let argvAddr = 0;
  if (mainParams.length === 2) {
    const ptrs = [];
    for (const s of argvStrs) {
      const at = gen.dataOff;
      const raw = utf8Bytes(s);
      raw.push(0);
      gen.pendingData.push({ off: at, bytes: raw });
      gen.dataOff = at + raw.length;
      ptrs.push(at);
    }
    argvAddr = alignUp(gen.dataOff, 8);
    gen.dataOff = argvAddr + (ptrs.length + 1) * 8;
    for (let i = 0; i < ptrs.length; i++) gen.emitBytes(argvAddr + i * 8, 8, BigInt(ptrs[i]));
  }
  /* `errno` 那一格（第八刀第八片）：data 段末尾 4 个字节，**只在用到时才留**。
   * 不写一个字节 data —— 线性内存出生全是 0，而 C 正好要求「程序启动时 errno 是 0」
   * （C11 7.5 第 3 段）。地址在入口处用一条 `__omni_errno_init` 交给宿主。 */
  let errnoAddr = 0;
  if (gen.errnoUsed) {
    errnoAddr = alignUp(gen.dataOff, 4);
    gen.dataOff = errnoAddr + 4;
  }
  /* `strerror` 那块共用的缓冲（第八刀第十三片），同样只在用到时才留。 */
  let strerrAddr = 0;
  if (gen.strerrorUsed) {
    strerrAddr = alignUp(gen.dataOff, 8);
    gen.dataOff = strerrAddr + STRERROR_BYTES;
  }
  const stackBase = alignUp(gen.dataOff, 16);
  const stackTop = stackBase + C_STACK_BYTES;
  const heapBase = alignUp(stackTop, MEM_PAGE);
  const pages = gen.heapUsed
    ? heapBase / MEM_PAGE + 1
    : Math.ceil(stackTop / MEM_PAGE);
  mod.setMem(pages, 0);

  for (const d of gen.pendingData) mod.addData(d.off, d.bytes);

  const entry = new MirFunc('omni_main', [], T_I32);
  mod.addFunc(entry);
  /* `$sp` 的初值在入口里写 —— 解释器的全局初值是 undefined（interp.js:216），
   * 而 wasm 那边的 `(global $sp (mut i64) (i64.const …))` 是同一件事的静态写法。
   * 没有任何函数要帧时 spNo 还是 -1，这条也就不发。 */
  if (gen.spNo >= 0) {
    entry.emit(OP.GSTORE, T_VOID, mod.consts.int(BigInt(stackTop)), REF_NONE, gen.spNo);
  }
  /* 堆的起点交给宿主那份分配器（`interp/libc.js`）。**只有用到堆才发** —— 没用到的
   * 模块不该多一个外部符号（将来自带后端那条路上它是一次真的链接）。 */
  if (gen.heapUsed) {
    entry.emit(OP.CCALL, T_VOID, mod.cabiNo('__omni_heap_init'),
      entry.pushArgs([mod.consts.int(BigInt(heapBase))]), 0);
  }
  /* `errno` 那一格的地址，同理 —— 用到 `<errno.h>` 才发。 */
  if (gen.errnoUsed) {
    entry.emit(OP.CCALL, T_VOID, mod.cabiNo('__omni_errno_init'),
      entry.pushArgs([mod.consts.int(BigInt(errnoAddr))]), 0);
  }
  /* `strerror` 那块缓冲的地址**与大小**，同理 —— 用到 `strerror` 才发。 */
  if (gen.strerrorUsed) {
    entry.emit(OP.CCALL, T_VOID, mod.cabiNo('__omni_strerror_init'),
      entry.pushArgs([mod.consts.int(BigInt(strerrAddr)),
        mod.consts.int(BigInt(STRERROR_BYTES))]), 0);
  }
  /* 宿主提供的全局量（第十七片）：三条标准流那几格。地址与序号交过去，宿主把自己的
   * 句柄写进去 —— 前端不知道句柄长什么样，宿主不知道版图长什么样。 */
  for (const s of gen.streamGvars) {
    entry.emit(OP.CCALL, T_VOID, mod.cabiNo('__omni_stream_init'),
      entry.pushArgs([mod.consts.int(BigInt(s.addr)), mod.consts.i32(s.which)]), 0);
  }
  const rt = mirTypeOf(info.ret);
  /* `main` 的实参：要么一个都没有，要么就是 `argc` 与 `argv`（上面只放过这两种）。
   * `argc` 按形参声明的类型给（`int` 是 i32，`long` 之类是 i64）。 */
  const mainArgs = mainParams.length === 0 ? [] : [
    mirTypeOf(mainParams[0].ty) === T_I32
      ? mod.consts.i32(argvStrs.length)
      : mod.consts.int(BigInt(argvStrs.length)),
    mod.consts.int(BigInt(argvAddr)),
  ];
  if (rt === T_VOID) {
    entry.emit(OP.CALL, T_VOID, info.no, entry.pushArgs(mainArgs), 0);
    entry.emit(OP.RET, T_I32, mod.consts.i32(0), REF_NONE, 0);
  } else {
    let v = entry.emit(OP.CALL, rt, info.no, entry.pushArgs(mainArgs), 0);
    // `main` 声明成 long 之类时把它收到 i32（退出码只有 8 位，但入口的类型要对得上）
    if (rt === T_I64) v = entry.emit(OP.CVT, T_I32, v, REF_NONE, CVT_TRUNC);
    entry.emit(OP.RET, T_I32, v, REF_NONE, 0);
  }
  return { mod, warnings: cpp.warnings };
}

/**
 * C -> MIR，**native 口径**（ADR-0017 第九刀第十九片）。
 *
 * 与 `lowerC` 的差别只有一件事，但它是整条腿的分水岭：**没有线性内存**。
 *   - 局部量的帧是一条 `FRAME`（真地址），不是 `$sp` 上切出来的偏移；
 *   - 于是没有版图、没有影子栈、没有堆、没有 `argv` 那一摊，`mod.mem` 是 null；
 *   - 也**没有 `omni_main` 包装**：这条路的产物是一个 `.o`，谁链它谁写 `main`
 *     （`tests/c/native.js` 就是这么验的）。`main` 不必存在。
 *
 * 还没落到这条腿上的东西（字符串字面量、全局量、变长数组、`alloca`、堆、`errno`）
 * 一律**明着报**：它们现在都要线性内存，悄悄发出去会得到一个指着 64K 的指针。
 * 一片片往下接就是把这些逐个搬到「符号」上。
 *
 * @param {string} path
 * @param {string} text
 * @param {{readFile: (p: string) => (string|null), includeDirs?: string[],
 *          dirname?: (p: string) => string, join?: (a: string, b: string) => string}} host
 * @param {{name: string, body?: string}[]} [defs] 命令行上的 `-D`
 */
export function lowerCNative(path, text, host, defs) {
  const cpp = new Cpp(host);
  cpp.installPredefs(path, false);
  for (const d of defs ?? []) {
    if (d.body === null) cpp.undefine(d.name);   // `-U`
    else cpp.define(d.name, d.body);
  }
  const mod = new MirModule(path);
  mod.setNative();
  const gen = new CGen(cpp, mod, { native: true });
  gen.preamble(COMPILE_PREAMBLE);
  cpp.startParse(path, text);
  gen.unit();
  gen.sealExternSymbols();

  /* 全局量（第二十一片）：前端照旧在**一块暂存的线性地址**上摆它们（`allocGlobal` 与
   * 整套初值代码一字不改），这里再把每一块切出来交给 MIR 的全局。于是「初值怎么算」
   * 那几百行两条腿共用，差别只在最后这一步：一边是 data 段里的偏移，一边是一个符号。 */
  const stage = new Map();   // 暂存区：绝对偏移 -> 字节
  for (const d of gen.pendingData) {
    for (let k = 0; k < d.bytes.length; k++) stage.set(d.off + k, d.bytes[k]);
  }
  /* 初值里的地址（第二十八片）：也按绝对偏移攒着，切全局的时候一起切出来。 */
  const fixes = new Map();   // 绝对偏移 -> {kind, no, add}
  for (const fx of gen.pendingFix) fixes.set(fx.off, fx);
  for (const [name, e] of gen.gvars) {
    /* 别名（第一百〇五片）：它与目标同址，数据由目标那一格切 —— 这儿跳过，
     * 符号由 `mod.aliases` 那张表在后端发。 */
    if (e.aliasOf !== undefined) continue;
    if (e.addr < 0) continue;   // 试探性定义没补上长度：用它的地方已经报过了
    const s0 = typeSize(e.ty);
    if (!e.defined) {
      /* 外部的全局量（第三十一片）：数据段里不占字节、不定义符号 —— 它落进目标文件的
       * 「未定义的外部符号」那一段，由链接器去找。前端照旧给它留过一块暂存地址
       * （一遍过里引用发生在定义之前），那块地方这儿**不认领**、下面 `stage` 的账
       * 也不该算它，所以顺手把那几个字节丢掉。 */
      const no0 = e.gno === undefined ? mod.globalNo(name) : e.gno;
      mod.setGlobalExtern(no0, s0.size, s0.align);
      for (let k = 0; k < s0.size; k++) stage.delete(e.addr + k);
      continue;
    }
    const s = s0;
    const size = s.size + (e.extra === undefined ? 0 : e.extra);
    const al = e.align !== 0 ? e.align : s.align;
    if (al > 4096) {
      throw new OmniError(`${path}: error: 全局量 '${name}' 要 ${al} 字节对齐`
        + `（__data 这一节最多 4096）`);
    }
    const bytes = [];
    for (let k = 0; k < size; k++) {
      const b = stage.get(e.addr + k);
      bytes.push(b === undefined ? 0 : b);
      stage.delete(e.addr + k);
    }
    const fixups = [];
    for (let k = 0; k < size; k++) {
      const fx = fixes.get(e.addr + k);
      if (fx === undefined) continue;
      fixups.push({ off: k, kind: fx.kind, no: fx.no, add: fx.add });
      fixes.delete(e.addr + k);
    }
    const no = e.gno === undefined ? mod.globalNo(name) : e.gno;
    if (e.isStatic === true) mod.markGlobalLocal(no);
    if (e.weak === true) mod.markGlobalWeak(no);
    mod.setGlobalData(no, size, al, bytes, fixups);
  }
  /* 匿名的静态块（第三十四片）：静态的复合字面量。与有名字的那些一模一样地切 ——
   * 差别只在名字是编出来的，而且没有「试探性定义」「外部的」这两种情况。 */
  for (const b of gen.anonStatics) {
    const bytes = [];
    for (let k = 0; k < b.size; k++) {
      const v = stage.get(b.addr + k);
      bytes.push(v === undefined ? 0 : v);
      stage.delete(b.addr + k);
    }
    const fixups = [];
    for (let k = 0; k < b.size; k++) {
      const fx = fixes.get(b.addr + k);
      if (fx === undefined) continue;
      fixups.push({ off: k, kind: fx.kind, no: fx.no, add: fx.add });
      fixes.delete(b.addr + k);
    }
    /* 匿名块的名字（`$cl$3`）是**按出现顺序编**的，于是每个翻译单元里都有一个
     * `$cl$0` —— 局部符号（第九十二片）。 */
    mod.markGlobalLocal(b.gno);
    mod.setGlobalData(b.gno, b.size, b.align, bytes, fixups);
  }
  /* 暂存区里没人认领的字节：那是还落在线性内存上的东西（`argv`、宿主那几格，
   * 或者哪个初值偷偷要了一块地方）。放过去会得到一个指着 64K 的指针。 */
  if (stage.size !== 0) {
    throw new OmniError(`${path}: error: native 这条腿上有 ${stage.size} 个字节还落在线性内存上`);
  }
  /* 没人认领的地址：那说明它不在任何全局的字节里 —— 放过去会得到一个指着 0 的指针。 */
  if (fixes.size !== 0) {
    throw new OmniError(`${path}: error: native 这条腿上有 ${fixes.size} 个初值里的地址`
      + `不在任何全局量里`);
  }
  if (gen.heapUsed) throw new OmniError(`${path}: error: native 这条腿还没有堆（malloc 那一摊）`);
  return { mod, warnings: cpp.warnings };
}





