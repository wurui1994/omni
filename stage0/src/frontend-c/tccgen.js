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
//      - `goto` 是「一圈 LOOP + 一个状态槽 + 开头分派」（`openLabels`）—— 结构化控制流
//        里**往回跳只有这一种写法**。代价是往前跳与往回跳一样贵。
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
// `goto` 与语句标签（外围块上的，前向后向都行）、struct 的**传值与返回**（传地址 +
// 隐藏的返回指针）、带括号的声明符（`int (*a)[3]`、`int (*f(int))[3]`）、**函数指针**
// （调用、回调、函数指针表、当静态初始化式）、**浮点**（`float`/`double`、与整型互转、
// 静态初始化式、printf 的 `%f/%e/%g`）、**堆**（`malloc`/`calloc`/`realloc`/`free`/
// `strdup`，簿记全在线性内存上）、**变参函数的定义**（`va_list`/`va_start`/`va_arg`/
// `va_end`/`va_copy`，签名定死成「固定形参 + 一个变参区指针」，**通过函数指针调也行**）、
// **`exit`**（宿主抛一个信号，从任意深处一路退出去）、**函数类型的 typedef**
// （`typedef int cb(int);`，之后能当声明符的基本类型用）、**`long double`**（在这个目标上
// 就是 double，见 `tcc.h:237-241`）、**常量表达式里的浮点**（整型与浮点合成一份求值器：
// `int n = 1.9;` 是 1、`(int)2.9` 也认）、printf 的 `%a`、**变参里的 struct**（写侧摊进
// 变参区、`va_arg` 回一个左值）**。
// 还没到：`goto` 跳到不在外围块上的标签（relooper 那一路）、标签长在里层控制结构里
// （Duff's device）、**外部**函数上的 struct 传值/返回（要真的 ABI）、
// 串起来的指定初始化器（`.a.b = 3`）、不定长数组配省掉里层花括号（`int a[][2] = {1,2,3,4}`）。
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
import {
  TOK_EOF, TOK_IDENT, TOK_UIDENT,
  TOK_CCHAR, TOK_LCHAR, TOK_CINT, TOK_CUINT, TOK_CLLONG, TOK_CULLONG,
  TOK_CLONG, TOK_CULONG, TOK_STR, TOK_LSTR, TOK_CFLOAT, TOK_CDOUBLE, TOK_CLDOUBLE,
  TOK_INC, TOK_DEC, TOK_SHL, TOK_SAR, TOK_LAND, TOK_LOR,
  TOK_EQ, TOK_NE, TOK_LT, TOK_GE, TOK_LE, TOK_GT, TOK_ULE, TOK_UGT,
  TOK_IF, TOK_ELSE, TOK_WHILE, TOK_FOR, TOK_DO, TOK_BREAK, TOK_CONTINUE, TOK_RETURN,
  TOK_SWITCH, TOK_CASE, TOK_DEFAULT, TOK_GOTO, TOK_SIZEOF, TOK_DOTS,
  TOK_INT, TOK_VOID, TOK_BOOL, TOK_SIGNED, TOK_UNSIGNED, TOK_CHAR, TOK_SHORT, TOK_LONG,
  TOK_FLOAT, TOK_DOUBLE, TOK_STRUCT, TOK_UNION, TOK_ENUM, TOK_TYPEDEF,
  TOK_EXTERN, TOK_STATIC, TOK_CONST, TOK_REGISTER, TOK_AUTO, TOK_VOLATILE, TOK_INLINE,
  TOK_BUILTIN_VA_START, TOK_BUILTIN_VA_ARG, TOK_BUILTIN_VA_END, TOK_BUILTIN_VA_COPY,
  isAssignOp, assignOpOf,
} from './tcctok.js';
import {
  VT_VOID, VT_BYTE, VT_SHORT, VT_INT, VT_LLONG, VT_BOOL, VT_PTR, VT_FUNC, VT_STRUCT,
  VT_BTYPE, VT_UNSIGNED, VT_DEFSIGN, VT_LONG, VT_FLOAT, VT_DOUBLE,
  VT_EXTERN, VT_STATIC, VT_TYPEDEF, VT_INLINE, VT_CONSTANT, VT_VOLATILE, VT_STORAGE,
  btype, isInteger, isFloat, isUnsigned, isPtr, isArray, isFunc, isStruct, isUnion,
  isBitfield, bitPosOf, bitSizeOf, mkBitfield, bitfieldBase,
  ctype, mkPointer, mkArray, mkStruct, mkEnum, mkFunc, typeSize, typeText, sameType,
  TY_VOID, TY_INT, TY_UINT, TY_LLONG, TY_ULLONG, TY_CHAR, TY_SHORT, TY_BOOL,
  TY_FLOAT, TY_DOUBLE, TY_LDOUBLE, VT_LDOUBLE,
} from './ctype.js';
import {
  MirModule, MirFunc, OP, T_VOID, T_I32, T_I64, T_BOOL, T_F32, T_F64, REF_NONE,
  CVT_SEXT, CVT_ZEXT, CVT_TRUNC, CVT_SEXT8, CVT_SEXT16, CVT_I2F, CVT_U2F, CVT_F2I,
  CVT_FCVT, memDesc, MEM_PAGE, fnPtr,
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
const HEAP_FNS = new Set(['malloc', 'calloc', 'realloc', 'free', 'strdup']);

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
 * `long long` 的位域按 64 位，别的都按 32 位；符号性跟着声明的类型（`_Bool` 按无符号）。
 *
 * 这个函数存在的理由是一条不变量：**位域信息只能挂在左值上**。一旦取过值，类型上
 * 再带着「第几位、几位宽」就会骗人 —— 下一次 `gv` 会以为它还得去内存里读一遍，而
 * 它手上已经没有地址了。所以凡是「把左值变成值」的地方（`promote`、`castTo`、
 * `incdec`）都要在这儿过一道。这一格错过一次，printf 的实参上当场炸。
 */
function bfValTypeOf(ty) {
  if (!isBitfield(ty.t)) return ty;
  const base = bitfieldBase(ty);
  const w64 = btype(base.t) === VT_LLONG;
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
    if (b === 0n) err('division by zero in constant expression');
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

export class CGen {  /**
   * @param {Cpp} cpp 记号源（已经 startParse 过）
   * @param {MirModule} mod 往里发指令的模块
   */
  constructor(cpp, mod) {
    this.cpp = cpp;
    this.mod = mod;
    /** 当前记号（tcc 的全局 `tok` / `tokc`）。镜像一份是为了代码读起来像 tccgen。 */
    this.tok = TOK_EOF;
    this.tokc = null;

    /** @type {MirFunc|null} 正在生成的函数 */
    this.f = null;
    /** 当前函数的返回类型（tcc 的 `func_vt`） */
    this.funcRet = TY_VOID;
    this.funcName = '';
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
    /** data 段的下一个空位。页 0 整页留空，于是 C 的 `NULL` 一定访问不到 */
    this.dataOff = MEM_PAGE;
    /** @type {Map<string,number>} 字符串字面量去重（同一份文本一份 data） */
    this.strs = new Map();
    /** @type {{off:number,bytes:number[]}[]} 攒着的 data 段（内存要等 dataOff 定了才能声明） */
    this.pendingData = [];
    /** 这个单元用到堆了吗（`malloc` 那一族）。用到才发那条 `__omni_heap_init` */
    this.heapUsed = false;
    /** @type {Map<string,object>} `typedef` 的名字表（tcc 用 `VT_TYPEDEF` 挂在符号上） */
    this.typedefs = new Map();
    /* `__builtin_va_list`：tcc 在 arm64 上把它定在 tccdefs.h 里（本机是
     * `struct { void *__stack; }`），而不是一个记号。我们照它的位置办 —— 一条预置的
     * typedef —— 但形态取 `void *`：程序只把它当不透明的东西传给那几个内建，
     * 而我们的变参区就是一串 8 字节的格子，一个指针足够走完它（见 `vaBlock`）。 */
    this.typedefs.set('__builtin_va_list', mkPointer(TY_VOID));
    /** @type {Map<string,{ty:object,addr:number,defined:boolean,used:boolean}>} 全局量 */
    this.gvars = new Map();
    /* C 有**四个独立的名字空间**（C11 6.2.3）：普通标识符、struct/union/enum 的 tag、
     * 成员名、语句标签。所以 `struct S { int S; } S;` 三个 S 互不相干。tag 这一个
     * 必须与 typedefs/gvars 分开存 —— 合到一起的话上面那行会互相覆盖。 */
    /** @type {Map<string,object>} `struct S` / `union U` / `enum E` 的 tag */
    this.tags = new Map();
    /** @type {Map<string,{ty:object,val:bigint}>} 枚举常量（它们是**普通标识符**） */
    this.enumConsts = new Map();
    /** @type {{left:number}[]} 正在解析的 switch（嵌套时是一叠），见 `switchStmt` */
    this.swStack = [];

    /* ---- 语句标签与 goto（第六刀第十片）。见 `openLabels` 头上那一段。
     * 复合语句在两遍里的**序号**是同一个，于是第一遍收下来的「这个块里有哪些标签」
     * 第二遍能按序号取回 —— `goto` 的前向引用就有了答案，而不必再收一遍记号。 */
    /** 当前函数里第几个复合语句（两遍各自从 0 数起） */
    this.blockNo = 0;
    /** @type {string[][]} 块序号 -> 那个块**自己那一层**上的标签名（源码顺序） */
    this.blockLabels = [];
    /** @type {string[][]} 第一遍：正在收标签的那些数组，栈顶是最内层的块 */
    this.labelSink = [];
    /** @type {Set<string>} 第一遍：这个函数里出现过的所有标签名 */
    this.funcLabels = new Set();
    /** @type {{names:string[],slot:number,loopIdx:number,seen:number}[]} 第二遍：外围的带标签块 */
    this.gotoStack = [];
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

  /** `skip(c)`：当前记号必须是 `c`，然后往前走一格。 */
  skip(t) {
    if (this.tok !== t) this.expect(`'${this.cpp.tokStr(t, null)}'`);
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

  /** 在当前帧里划一块，回帧内偏移。**不回收**（见 finishFunc 头上「平铺的帧」）。 */
  frameAlloc(ty) {
    const s = typeSize(ty);
    this.frameOff = alignUp(this.frameOff, s.align);
    const off = this.frameOff;
    this.frameOff += s.size === 0 ? 1 : s.size;
    return off;
  }

  /**
   * 声明一个局部变量。登记进最内层作用域（同名遮蔽是 C 的规矩），回那条登记。
   * 两种落法二选一：帧上的偏移（`off >= 0`）或者 MIR 的槽（`slot >= 0`）。
   */
  declareLocal(name, ty) {
    if (btype(ty.t) === VT_VOID) this.err(`variable '${name}' has void type`);
    this.needComplete(name, ty);
    const scope = this.scopes[this.scopes.length - 1];
    if (this.needsMem(ty) || this.frameNames.has(name)) {
      const e = { ty, slot: -1, off: this.frameAlloc(ty) };
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

  /** 一条作用域登记 -> 一个左值。 */
  entryLval(name, e) {
    if (e.off >= 0) return sMem(e.ty, this.fpRef, e.off);
    return sLval(e.ty, e.slot, name);
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
   * `float` / `double` 的常量。
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
    if (pos + bits > typeSize(base).size * 8) {
      this.err('internal: 位域跨过了它的容器（要 packed 那条按字节读的路）');
    }
    const w64 = btype(base.t) === VT_LLONG;
    /* 符号性跟着**声明的**类型；`_Bool` 位域按无符号（`tccgen.c:1860`）。 */
    const uns = isUnsigned(base.t) || btype(base.t) === VT_BOOL;
    const cont = bfValTypeOf(v.ty);
    const W = w64 ? 64 : 32;
    const f = this.f;
    const mt = mirTypeOf(cont);
    /* 容器整个读出来（宽度按声明的类型，于是 `char c:3` 只读一个字节），
     * 再转成容器类型 —— `castTo` 顺手把窄类型那条收口规则也用上了。 */
    let r = this.gv(this.castTo(sMem(base, v.mem.addr, v.mem.off), cont));
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
    if (isArray(v.ty.t)) return sVal(mkPointer(v.ty.ref), this.addrOf(v));
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
   *     无符号目标也走同一条：`F2I` 出来的是两补的位，而无符号在 MIR 里挂在算子上，
   *     不挂在位上（第六十一刀）。
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
    if (!sameType(target.ty, v.ty)) {
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
    const base = bitfieldBase(target.ty);
    const w64 = btype(base.t) === VT_LLONG;
    const cont = w64 ? TY_ULLONG : TY_UINT;
    const mt = mirTypeOf(cont);
    const f = this.f;
    const mask = (1n << BigInt(bits)) - 1n;

    let r = this.gv(this.castTo(v, base));
    r = f.emit(OP.BAND, mt, r, this.konst(cont, mask), 0);
    if (pos > 0) r = f.emit(OP.SHL, mt, r, this.konst(cont, pos), 0);

    let old = this.gv(sMem(base, target.mem.addr, target.mem.off));
    old = f.emit(OP.BAND, mt, old, this.konst(cont, ~(mask << BigInt(pos))), 0);
    const nv = f.emit(OP.BOR, mt, old, r, 0);
    /* MSTORE 的 `t` 是**值**的类型，宽度在描述符里 —— 描述符按声明的类型选，
     * 于是 `char c:3` 只写回那一个字节，不会碰到旁边的成员。 */
    f.emit(OP.MSTORE, mt, target.mem.addr, nv,
      memDesc(storeKindOf(base), target.mem.off));
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
    const es = typeSize(p.ty.ref).size;
    if (es === 0) this.err('arithmetic on a pointer to an incomplete type');
    let k = this.asI64(n);
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
   * 一个字符串字面量当**表达式**用。类型是 `char[N+1]`（含结尾的 0）而不是 `char *`，
   * 所以 `sizeof("abc")` 是 4，用在表达式里再退化成指针 —— 用指针的话 sizeof 会变成 8，
   * 而那是最难发现的那种错。
   */
  strLit(bytes) {
    return sMem(mkArray(TY_CHAR, bytes.length + 1),
      this.mod.consts.int(BigInt(this.strData(bytes))), 0);
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
   * 全局量：住在 data 段里，地址是**编译期常量**。没有初始化式就不写 data ——
   * 线性内存出生时全是 0，而 C 正好规定静态存储期的对象零初始化（C11 6.7.9 第 10 段）。
   * 这一条让「几千个全局量」不多一个字节的 data 段。
   */
  declareGlobal(name, ty, isExtern) {
    const hit = this.gvars.get(name);
    if (hit !== undefined) {
      if (!sameType(hit.ty, ty)) this.err(`conflicting types for '${name}'`);
      if (!isExtern) hit.defined = true;
      return hit;
    }
    if (btype(ty.t) === VT_VOID) this.err(`variable '${name}' has void type`);
    const s = typeSize(ty);
    if (s.size === 0) this.err(`storage size of '${name}' isn't known`);
    this.dataOff = alignUp(this.dataOff, s.align);
    const e = { ty, addr: this.dataOff, defined: !isExtern, used: false };
    this.dataOff += s.size;
    this.gvars.set(name, e);
    return e;
  }

  /** 一个全局量 -> 左值。地址是常量，静态偏移 0（`p->f` 那种偏移进描述符是后面的事）。 */
  gvarLval(e) {
    e.used = true;
    return sMem(e.ty, this.mod.consts.int(BigInt(e.addr)), 0);
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
    if (this.tok === LBRACE) {
      if (isArray(ty.t) || isStruct(ty.t)) return this.initBraced(dest, off, ty);
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
    if (isBitfield(ty.t)) this.todo('静态位域的初始化式还没到（要按位往 data 里并）');
    if (this.tok === TOK_STR) {
      /* `char *s = "abc";` —— 值是那个字面量在 data 段里的地址。真的目标文件里这是
       * 一条重定位；我们的「链接」是一个常量，所以它就是 8 个字节。 */
      if (!isPtr(ty.t)) this.err(`invalid initializer for '${typeText(ty)}'`);
      const addr = this.strData(this.readStrTok(this.tokc));
      this.emitBytes(dest.addr + off, 8, BigInt(addr));
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
      if (this.tok === LBRACK || this.tok === DOT) {
        while (stack.length > 1) stack.pop();
        this.initDesignators(stack);
        if (stack.length > 1) chainAt = stack[0].i;
      }
      for (;;) {
        const el = this.initElem(stack[stack.length - 1]);
        if (this.tok === LBRACE) break;                          // 花括号写全了
        if (isArray(el.ty.t) && this.tok === TOK_STR) break;      // 字符串铺进 char 数组
        if (!isArray(el.ty.t) && !isStruct(el.ty.t)) break;       // 标量，到底了
        if (isStruct(el.ty.t) && el.ty.ref.fields === null) {
          this.err(`'${typeText(el.ty)}' is an incomplete type`);
        }
        stack.push({ ty: el.ty, off: el.off, i: 0 });
      }
      const lv = stack[stack.length - 1];
      const at = this.initElem(lv);
      this.initializer(dest, at.off, at.ty);
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
   */
  initDesignators(stack) {
    for (;;) {
      const lv = stack[stack.length - 1];
      if (this.tok === LBRACK) {
        if (!isArray(lv.ty.t)) this.err('array index in non-array initializer');
        this.next();
        const k = Number(this.constExpr());
        this.skip(RBRACK);
        if (k < 0) this.err('negative array designator');
        lv.i = k;
      } else if (this.tok === DOT) {
        if (!isStruct(lv.ty.t)) this.err('field name not in record or union initializer');
        this.next();
        const nm = this.identName();
        const k = lv.ty.ref.fields.findIndex((x) => x.name === nm);
        if (k < 0) this.err(`'${typeText(lv.ty)}' has no member named '${nm}'`);
        lv.i = k;
      } else {
        this.skip(ASSIGN);
        return;
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
   * 初始化式的记号收下来先跑一遍「只数大小」（`decl_initializer_alloc`）；这里同样收，
   * 但只数**顶层元素个数** —— 那在记号层面就数完了，不必真的解析一遍表达式。
   *
   * 回 `{ ty, body }`：body 非 null 时调用方要用 `replayBraced` 把它放一遍。
   */
  sizeFromInit(ty) {
    if (this.tok !== LBRACE) this.err(`array size missing`);
    const body = this.cpp.captureBraced();
    /* 分格照 `initBraced` 的下降栈来（第二十三片起）：顶层是一个**长度未知**的数组，
     * 每一格喂一个「项」，填满就回卷。于是省掉里层花括号的写法也数得对
     * （`int a[][2] = {1,2,3,4}` 是 2）—— 记号层面数逗号只对元素是标量的那一种。 */
    const stack = [{ ty: mkArray(ty.ref, -1), off: 0, i: 0 }];
    for (const head of this.initHeads(body.toks)) {
      if (head === LBRACK || head === DOT) {
        this.todo('不定长数组配指定初始化器还没到（`int a[] = {[3]=1}`）');
      }
      for (;;) {
        const el = this.initElem(stack[stack.length - 1]);
        if (head === LBRACE) break;                             // 花括号写全了
        if (isArray(el.ty.t) && head === TOK_STR) break;         // 字符串铺进 char 数组
        if (!isArray(el.ty.t) && !isStruct(el.ty.t)) break;      // 标量，到底了
        if (isStruct(el.ty.t) && el.ty.ref.fields === null) {
          this.err(`'${typeText(el.ty)}' is an incomplete type`);
        }
        stack.push({ ty: el.ty, off: 0, i: 0 });
      }
      this.initBump(stack[stack.length - 1]);
      while (stack.length > 1 && this.initFull(stack[stack.length - 1])) {
        stack.pop();
        this.initBump(stack[stack.length - 1]);
      }
    }
    /* 还停在里层就说明顶层那一格填了一半 —— 半格也算一格（`int a[][2] = {1,2,3}` 是 2）。 */
    const n = stack[0].i + (stack.length > 1 ? 1 : 0);
    return { ty: mkArray(ty.ref, n), body };
  }

  /**
   * 一串记号里，**最外层那对花括号里每一项的头一个记号**。
   * 头一个记号就够了：`{` 与字符串是「整格」，别的都是「往里下降到标量」——
   * 而这一遍要的只有这个区分。项里面的东西（表达式、里层的花括号）整段跳过。
   */
  initHeads(toks) {
    const heads = [];
    let depth = 0;
    let fresh = true;
    for (const t of toks) {
      if (t === TOK_EOF) break;
      if (t === RBRACE || t === RPAR || t === RBRACK) {
        depth--;
        if (depth === 0) break;
        continue;
      }
      if (depth === 1) {
        if (t === COMMA) { fresh = true; continue; }
        if (fresh) { heads.push(t); fresh = false; }
      }
      if (t === LBRACE || t === LPAR || t === LBRACK) depth++;
    }
    return heads;
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

  /** `unary`（`tccgen.c:5595`）。前缀与后缀都在这儿，与 tcc 一样。 */
  unary() {
    const t = this.tok;

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
      if (t === TOK_LSTR) this.todo('宽字符串字面量还没到');
      if (t === TOK_STR) return this.postfix(this.strLit(this.readStrTok(cv)));
      if (t === TOK_LCHAR) this.todo('宽字符常量还没到');
      this.next();
      /* 字面量的类型由后缀定（`parseNumber` 已经按 tcc 的规则挑好了记号号）。
       * `'a'` 在 C 里是 **int**，不是 char —— 这一格错了 `sizeof('a')` 就是 1 而不是 4。 */
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
        return this.castTo(this.unary(), ty);
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
    /* 变参那四个内建。它们**不是函数**（`va_arg` 的第二个实参是个类型名，函数写不出来），
     * 所以与 tcc 一样在这儿按记号号认出来（`tccgen.c:5943` 一带的 arm64 那一支）。
     * 位置必须在下面那条「标识符」之前 —— 它们的记号号在 `TOK_UIDENT` 之后
     * （tcc 也是：`int __builtin_expect;` 是合法 C，所以它们不是关键字）。 */
    if (t === TOK_BUILTIN_VA_START || t === TOK_BUILTIN_VA_ARG
      || t === TOK_BUILTIN_VA_END || t === TOK_BUILTIN_VA_COPY) {
      return this.vaBuiltin(t);
    }

    if (t >= TOK_UIDENT) {
      const name = this.identName();
      const local = this.lookup(name);
      if (local !== null) return this.postfix(this.entryLval(name, local));
      /* 枚举常量是**普通标识符**，所以查在这一格：局部量之后（局部量能遮蔽它），
       * 全局量之前。它不是左值 —— `A = 1` 该报错，而 `sVal` 天然不是左值。 */
      const ec = this.enumConsts.get(name);
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
        return this.postfix(sMem(funcTypeOf(fn), this.mod.consts.int(fnPtr(fn.no)), 0));
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
    let ty;
    if (this.tok === LPAR) {
      this.next();
      if (this.isTypeStart(this.tok)) {
        ty = this.typeName();
        this.skip(RPAR);
      } else {
        // `sizeof (x)` —— 括号是表达式的括号，不是类型名的
        const scratch = new MirFunc('$sizeof', [], T_VOID);
        const outer = this.f;
        this.f = scratch;
        ty = this.gexpr().ty;
        this.f = outer;
        this.skip(RPAR);
      }
    } else {
      const scratch = new MirFunc('$sizeof', [], T_VOID);
      const outer = this.f;
      this.f = scratch;
      ty = this.unary().ty;
      this.f = outer;
    }
    /* `sizeof` 的类型是 `size_t`（LP64 上是 `unsigned long`，8 字节）。 */
    const n = typeSize(ty).size;
    return sVal(TY_ULLONG, this.konst(TY_ULLONG, n));
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
    const info = this.funcSym(name);
    const a = this.callArgs(`function '${name}'`, info.params, info.variadic, info.ret);
    if (info.params === null) {
      info.params = a.vals.map((v, i) => ({
        name: `$p${i}`, ty: promotedType(decayedType(v.ty)),
      }));
    }
    const rt = mirTypeOf(info.ret);
    const r = this.f.emit(OP.CALL, rt, info.no, this.f.pushArgs(a.refs), 0);
    /* 回的是那块地方的地址（SysV 的 rax 也是这么回的）。用**回来的**那个 ref 而不是
     * 手上的 `sret`：两者一定相等，而用回来的那个把「返回值在哪儿」这件事记在数据流里。 */
    if (a.sret !== null) return sMem(info.ret, r, 0);
    return sVal(info.ret, r);
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
    const a = this.callArgs('function pointer', fi.params, fi.variadic, fi.ret);
    const r = this.f.emit(OP.CALLI, mirTypeOf(fi.ret), callee, this.f.pushArgs(a.refs), 0);
    if (a.sret !== null) return sMem(fi.ret, r, 0);
    return sVal(fi.ret, r);
  }

  /**
   * 实参那一段（直接调用与间接调用共用）：读实参、按原型转换、struct 的两条 ABI。
   * 回 `{refs, sret, vals}` —— `vals` 只有「先调用后定义」那条路要（拿它回填形参表）。
   */
  callArgs(what, params, variadic, ret) {
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
      const bad = variadic ? vals.length < np : vals.length !== np;
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
      else extra.push({ ty: want, ref: r });
    }
    /* 变参：`...` 后面的实参不进实参表，进帧上的一块「变参区」，地址当**最后一个**
     * 实参传进去（第十六片的 ABI）。于是变参函数的 MIR 签名是**定死的**
     * （固定形参 + 一个 i64），自家的与外部的一个形状 —— 调用点因此不必知道
     * 这个名字最后有没有定义，照旧发 CALL。 */
    if (variadic) refs.push(this.vaBlock(extra));
    return { refs, sret, vals };
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
      this.vstore(ap, src);
      return sVal(TY_VOID, REF_NONE);
    }
    /* `va_start(ap, last)`：把隐藏的那个变参区指针写进 ap。`last` 按 C 的规定是最后一个
     * 固定形参，这一片**不核对**（tcc 也只在注释里写了「xx check types」）—— 但要读掉，
     * 否则括号对不上。 */
    this.exprEq();
    this.skip(RPAR);
    if (this.vaRef === REF_NONE) {
      this.err('__builtin_va_start used in a function with fixed arguments');
    }
    if (!isPtr(ap.ty.t)) this.err('__builtin_va_start expects a va_list');
    this.vstore(ap, sVal(mkPointer(TY_VOID), this.vaRef));
    return sVal(TY_VOID, REF_NONE);
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
    const params = info.params === null ? [] : info.params;
    const refs = [];
    /* 桩要把实参**原样**转给宿主，而我们的 struct 传的是自家线性内存里的一个偏移 ——
     * 宿主读不到（第五片证明「转手宿主 libc」不成立，同一个理由）。所以外部符号上的
     * struct 传值/返回是边界，不是错误。 */
    if (isStruct(info.ret.t)) this.todo('外部函数返回 struct 还没到（要真的 ABI）');
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
    const c = this.gtst(v);
    const slot = this.temp(T_I64, 'sel');
    const fslot = this.temp(T_F64, 'fsel');
    /** 一支落地：整型/指针进 i64 那个槽，算术类型**另外**再进 f64 那个槽。 */
    const put = (x) => {
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
    const a = this.gexpr();
    put(a);
    this.elseHalf();
    this.skip(COLON);
    const b = this.exprCond();
    put(b);
    this.close();
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

    /* 有一支是指针（或数组）：结果就是那个指针类型。放在整型那套规则**之前**，
     * 因为 intBitsOf(指针) 是 64，落到下面会算出 `long long` —— 于是 `(c?p:q)[0]`
     * 会说「下标用在了不是数组也不是指针的东西上」，而错的其实是这一格。 */
    const pa = decayedType(a.ty);
    const pb = decayedType(b.ty);
    if (isPtr(pa.t) || isPtr(pb.t)) return this.castTo(wide, isPtr(pa.t) ? pa : pb);
    // 公共类型：两支提升后做常规算术转换。两支的类型在这一点上都已知了。
    const bits = intBitsOf(a.ty) > intBitsOf(b.ty) ? intBitsOf(a.ty) : intBitsOf(b.ty);
    let uns;
    if (bits === 32) uns = isUnsigned(a.ty.t) || isUnsigned(b.ty.t);
    else {
      uns = (intBitsOf(a.ty) === 64 && isUnsigned(a.ty.t))
        || (intBitsOf(b.ty) === 64 && isUnsigned(b.ty.t));
    }
    let ty;
    if (btype(a.ty.t) === VT_VOID && btype(b.ty.t) === VT_VOID) ty = TY_VOID;
    else if (bits === 64) ty = uns ? TY_ULLONG : TY_LLONG;
    else ty = uns ? TY_UINT : TY_INT;
    if (btype(ty.t) === VT_VOID) return sVal(TY_VOID, REF_NONE);
    return this.castTo(wide, ty);
  }

  /** `expr_eq`（`tccgen.c:6738`）：赋值。**右结合**，所以递归调自己。 */
  exprEq() {
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
   * `block`（`tccgen.c:7177`）。分派的顺序照 tcc：`if` / `while` / `{` / `return` /
   * `break` / `continue` / `for` / `do`，最后落到表达式语句。
   */
  block() {
    const t = this.tok;
    /* 带值的记号不能先 next()：`next()` 会毁掉 tokc（`tccgen.c:7185-7188`）。 */
    if (tokHasValue(t)) {
      this.exprStmt();
      return;
    }

    if (t === TOK_IF) {
      this.next();
      this.skip(LPAR);
      const c = this.gtst(this.gexpr());
      this.skip(RPAR);
      this.open(OP.IF, 'if', c);
      this.scopes.push(new Map());
      this.block();
      this.scopes.pop();
      if (this.tok === TOK_ELSE) {
        this.next();
        this.elseHalf();
        this.scopes.push(new Map());
        this.block();
        this.scopes.pop();
      }
      this.close();
      return;
    }

    if (t === TOK_WHILE) {
      // BLOCK{ LOOP{ BRIF !cond ^break; body; BR ^continue } } —— 与 from_oir.js:251 同形
      this.next();
      this.open(OP.BLOCK, 'break', REF_NONE);
      this.open(OP.LOOP, 'continue', REF_NONE);
      this.skip(LPAR);
      const c = this.gtst(this.gexpr());
      this.skip(RPAR);
      const nc = this.f.emit(OP.NOT, T_BOOL, c, REF_NONE, 0);
      this.f.emit(OP.BRIF, T_VOID, nc, REF_NONE, this.levelOf('break'));
      this.scopes.push(new Map());
      this.block();
      this.scopes.pop();
      this.f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('continue'));
      this.close();
      this.close();
      return;
    }

    if (t === LBRACE) {
      this.next();
      /* 复合语句在两遍里的**序号**（`blockNo`）是同一个 —— 两遍走的是同一串记号。
       * 于是第一遍收下来的「这个块里有哪些标签」在第二遍能按序号取回，`goto` 的
       * 前向引用就有了答案，而不必再收一遍记号。 */
      const bn = this.blockNo++;
      let names;
      if (this.pass1) {
        names = [];
        this.blockLabels[bn] = names;
        this.labelSink.push(names);
      } else {
        names = this.blockLabels[bn] === undefined ? [] : this.blockLabels[bn];
      }
      const g = (!this.pass1 && names.length > 0) ? this.openLabels(names) : null;
      this.scopes.push(new Map());
      /* tcc 的复合语句循环（`tccgen.c:7243-7248`）：先试声明，不是声明才当语句。
       * 「声明和语句可以交替出现」（C99）就是这个循环的形状带来的。 */
      while (this.tok !== RBRACE) {
        this.decl(false);
        if (this.tok !== RBRACE) this.block();
      }
      this.next();
      this.scopes.pop();
      if (this.pass1) this.labelSink.pop();
      if (g !== null) this.closeLabels(g);
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
      this.f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, lv);
      this.skip(SEMI);
      return;
    }

    if (t === TOK_CONTINUE) {
      this.next();
      const lv = this.levelOf('continue');
      if (lv < 0) this.err('cannot continue');
      this.f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, lv);
      this.skip(SEMI);
      return;
    }

    if (t === TOK_FOR) {
      this.forStmt();
      return;
    }

    if (t === TOK_DO) {
      // BLOCK{ LOOP{ BLOCK{ body }; BRIF cond ^loop } } —— continue 落在里层 BLOCK 的
      // 末尾，于是它先去测条件，正是 do-while 的 continue 语义。
      this.next();
      this.open(OP.BLOCK, 'break', REF_NONE);
      this.open(OP.LOOP, 'loop', REF_NONE);
      this.open(OP.BLOCK, 'continue', REF_NONE);
      this.scopes.push(new Map());
      this.block();
      this.scopes.pop();
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

    if (t === TOK_SWITCH) return this.switchStmt();
    if (t === TOK_CASE || t === TOK_DEFAULT) return this.caseLabel(t);

    if (t === TOK_GOTO) {
      this.next();
      const name = this.identName();
      this.skip(SEMI);
      this.gotoStmt(name);
      return;
    }

    if (t === SEMI) {
      this.next();
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
         * 但 `foo: ;` 合法而且常见，所以这儿只是照常读下一条。 */
        if (this.tok === RBRACE) this.expect('statement');
        this.block();
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
   * 表达它的只有一个形状：把带标签的那个块变成一台**状态机** —— 一个 `LOOP` 套着
   * 层层嵌套的 `BLOCK`，循环开头按状态分派，`goto Li` = 「写状态、回到循环开头」。
   *
   * ```
   * BLOCK gotoend
   *  LOOP gotoloop
   *   BLOCK Lk ... BLOCK L1 BLOCK entry
   *     BRTABLE state -> [entry, L1, ..., Lk]
   *   END(entry)         ← 状态 0 落在这儿 = 第一个标签**之前**那一段
   *   seg0
   *   END(L1) seg1 ... END(Lk) segk
   *   BR gotoend         ← 走完最后一段，出去
   *  END(gotoloop)
   * END(gotoend)
   * ```
   *
   * 与 switch 是同一个「一个标签关掉一层 block」的骨架（`switchStmt` 头上那张图），
   * 多出来的只有外面那圈 `LOOP` 与那个状态槽 —— switch 只往前跳，`goto` 要能往回跳，
   * 而结构化控制流里**往回跳只有一种写法**：跳到一个 `LOOP` 的开头。
   *
   * 于是 `goto` 的代价是诚实的：往前跳与往后跳一样贵（一次写状态、一次分派），而
   * tinycc 里那些 `goto redo;` 恰好都是往回跳。
   *
   * 前向引用怎么办：分派要在块的**第一条语句之前**发，那时还没见到后面的标签。
   * 答案不是再收一遍记号，而是**白拿**函数体本来就有的那两遍（见 `finishFunc`）：
   * 第一遍把每个块自己那一层的标签按序号记下来，第二遍按同一个序号取回来。
   */

  /**
   * 一个带标签的块开场：状态清零、摆好 `LOOP` 与 k+1 层 `BLOCK`、发分派。
   * 回一个记账对象（`closeLabels` 与 `labelStmt` 要它）。
   */
  openLabels(names) {
    const f = this.f;
    const k = names.length;
    const slot = this.temp(T_I32, 'state');
    f.emit(OP.STORE, T_VOID, this.mod.consts.i32(0), REF_NONE, slot);
    this.open(OP.BLOCK, 'gotoend', REF_NONE);
    this.open(OP.LOOP, 'gotoloop', REF_NONE);
    const loopIdx = this.regions.length - 1;
    for (let i = 0; i <= k; i++) this.open(OP.BLOCK, 'label', REF_NONE);
    /* 表里第 i 格 = 状态 i 该去哪一层。最里层（层数 0）是 `entry`，往外一层一个标签，
     * 所以状态 i 的层数正好是 i。分派是无条件的，表已经覆盖了全部状态，
     * 兜底那一格填 0（= entry）只是 BRTABLE 要一个值。 */
    const table = [];
    for (let i = 0; i <= k; i++) table.push(i);
    const st = f.emit(OP.LOAD, T_I32, REF_NONE, REF_NONE, slot);
    f.emit(OP.BRTABLE, T_VOID, st, f.pushLevels(table), 0);
    this.close();                       // entry：立刻关掉，后面就是第一个标签之前那一段
    const g = { names, slot, loopIdx, seen: 0 };
    this.gotoStack.push(g);
    return g;
  }

  /** 带标签的块收场：最后一段走完要**出去**，而不是掉回循环开头。 */
  closeLabels(g) {
    if (g.seen !== g.names.length) this.err('internal: 标签数与第一遍收的不符');
    this.gotoStack.pop();
    this.f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('gotoend'));
    this.close();      // gotoloop
    this.close();      // gotoend
  }

  /** `name :` —— 第一遍只记名字，第二遍是「关掉一层 block」。 */
  labelStmt(name) {
    if (this.pass1) {
      const sink = this.labelSink[this.labelSink.length - 1];
      if (sink === undefined) return;          // 到不了：函数体本身就是一个块
      if (this.funcLabels.has(name)) this.err(`duplicate label '${name}'`);
      this.funcLabels.add(name);
      sink.push(name);
      return;
    }
    const g = this.gotoStack[this.gotoStack.length - 1];
    /* 标签必须直接长在它所在复合语句的语句层上。长在里层的 `if`/`while` 里（Duff's
     * device 那种）会让「关掉一层」关错对象 —— 与 `caseLabel` 同一个判断、同一个理由。 */
    if (g === undefined || this.regions[this.regions.length - 1] !== 'label'
      || g.names[g.seen] !== name) {
      this.todo('标签长在里层的控制结构里还没到（Duff\'s device）');
      return;
    }
    g.seen++;
    this.close();
  }

  /** `goto name;` —— 写状态、回到那个块的 `LOOP` 开头，让分派把控制送过去。 */
  gotoStmt(name) {
    if (this.pass1) return;
    for (let i = this.gotoStack.length - 1; i >= 0; i--) {
      const g = this.gotoStack[i];
      const j = g.names.indexOf(name);
      if (j < 0) continue;
      this.f.emit(OP.STORE, T_VOID, this.mod.consts.i32(j + 1), REF_NONE, g.slot);
      this.f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE,
        this.regions.length - 1 - g.loopIdx);
      return;
    }
    /* 标签在这个函数里有、但不在外围的块上（兄弟块里，或者更里层）。C 允许
     * （标签的作用域是整个函数），可这个形状表达不了 —— 当场说清楚是哪一种。 */
    if (this.funcLabels.has(name)) {
      this.todo(`goto 跳到不在外围块上的标签（'${name}'）还没到`);
      return;
    }
    this.err(`label '${name}' used but not defined`);
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
  switchStmt() {
    this.next();
    this.skip(LPAR);
    /* 控制表达式先做整型提升（C11 6.8.4.2 第 5 段），case 的值随后按这个类型收口。
     * 在开 block **之前**求值：它只在分派里用一次，而放在外面读起来就是 tcc 的顺序。 */
    const sel = this.promote(this.gexpr());
    if (!isInteger(sel.ty.t)) {
      this.err(`switch quantity is not an integer ('${typeText(sel.ty)}')`);
    }
    const selRef = this.gv(sel);
    this.skip(RPAR);
    if (this.tok !== LBRACE) this.todo('switch 的函数体不是花括号还没到');

    const body = this.cpp.captureBraced();
    const afterTok = this.cpp.tok;
    const afterVal = this.cpp.tokc;

    // ---- 扫一遍：标签按**源码顺序**排成一列
    const labels = this.scanCases(body, sel.ty);
    const k = labels.length;
    /* 兜底跳到哪儿：有 `default` 就是它那一层，没有就是 break 那一层（= 跳出去）。 */
    let defLevel = k;
    for (let i = 0; i < k; i++) if (labels[i].def) defLevel = i;

    // ---- 摆好 block，发分派
    this.open(OP.BLOCK, 'break', REF_NONE);
    for (let i = k - 1; i >= 0; i--) this.open(OP.BLOCK, 'case', REF_NONE);
    this.dispatch(selRef, sel.ty, labels, defLevel, k);

    // ---- 再放一遍：真的做
    this.swStack.push({ left: k });
    this.cpp.pushTokens(body);
    this.next();
    this.block();
    if (this.tok !== TOK_EOF) this.err('internal: switch 的函数体没读完');
    this.cpp.endMacro();
    const st = this.swStack.pop();
    if (st.left !== 0) this.err('internal: switch 的标签数与扫出来的不符');

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
    if (t === TOK_CASE) this.constExpr();
    this.skip(COLON);
    /* 标签必须直接长在 switch 的函数体上。长在里层的 `if`/`while` 里（Duff's device
     * 那种）会让「关掉一层」关错对象 —— 当场报出来，别悄悄生成一个形状不同的东西。 */
    if (this.regions[this.regions.length - 1] !== 'case') {
      this.todo('case 标签长在里层的控制结构里还没到（Duff\'s device）');
    }
    st.left--;
    this.close();
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
    for (let i = 0; i < k; i++) if (!labels[i].def) vals.push({ v: labels[i].val, lv: i });
    if (vals.length === 0) {
      f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, defLevel);
      return;
    }
    let min = vals[0].v;
    let max = vals[0].v;
    for (const c of vals) {
      if (c.v < min) min = c.v;
      if (c.v > max) max = c.v;
    }
    const span = max - min + 1n;
    /* 密集的门槛：表不超过 1024 格，而且平均每格至少有 1/8 个 case。两个数都是取舍，
     * 写在这儿而不是散在判断里 —— 改门槛只改这两个字面量。 */
    const dense = span <= 1024n && span <= BigInt(vals.length) * 8n;
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
        for (const c of vals) if (c.v === min + i) lv = c.lv;
        table.push(lv);
      }
      f.emit(OP.BRTABLE, T_VOID, idx, f.pushLevels(table), defLevel);
      return;
    }
    for (const c of vals) {
      const eq = f.emit(OP.EQ, mt, selRef, this.konst(ty, c.v), 0);
      f.emit(OP.BRIF, T_VOID, eq, REF_NONE, c.lv);
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
    const seen = new Set();
    let hasDef = false;
    this.cpp.pushTokens(body);
    this.next();
    while (this.tok !== TOK_EOF) {
      const t = this.tok;
      if (t === TOK_SWITCH) {
        this.next();
        this.skipBalanced(LPAR, RPAR);
        if (this.tok !== LBRACE) this.todo('switch 的函数体不是花括号还没到');
        this.skipBalanced(LBRACE, RBRACE);
        continue;
      }
      if (t === TOK_CASE) {
        this.next();
        /* case 的值按控制表达式提升之后的类型收口（C11 6.8.4.2 第 5 段）——
         * 不收的话 `switch ((char)x) { case 256: }` 会挑不出重复。 */
        const raw = this.constExpr();
        const v = uns ? BigInt.asUintN(bits, raw) : BigInt.asIntN(bits, raw);
        this.skip(COLON);
        if (seen.has(v)) this.err(`duplicate case value '${v}'`);
        seen.add(v);
        out.push({ def: false, val: v });
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

  /** 表达式语句：算完把值丢掉（`tccgen.c` 的 `expr: gexpr(); vpop();`）。 */
  exprStmt() {
    this.gexpr();
    this.skip(SEMI);
  }

  /**
   * `for`（`tccgen.c:7305`）。形状照 from_oir.js:266：
   *   BLOCK'break'{ init; LOOP'loop'{ BRIF !cond ^break; BLOCK'continue'{ body }; step; BR ^loop } }
   * 步进式**先收记号、循环体之后再放**（见文件头偏离 2 与 `Cpp.captureTokens`）。
   */
  forStmt() {
    const f = this.f;
    this.next();
    this.skip(LPAR);
    this.scopes.push(new Map());
    this.open(OP.BLOCK, 'break', REF_NONE);

    // 初始化：可以是声明（C99），也可以是表达式
    if (this.tok !== SEMI) {
      if (!this.decl(false)) this.exprStmt();
      // decl 自己吃掉了 `;`
    } else {
      this.next();
    }

    this.open(OP.LOOP, 'loop', REF_NONE);
    if (this.tok !== SEMI) {
      const c = this.gtst(this.gexpr());
      const nc = f.emit(OP.NOT, T_BOOL, c, REF_NONE, 0);
      f.emit(OP.BRIF, T_VOID, nc, REF_NONE, this.levelOf('break'));
    }
    this.skip(SEMI);

    const stepStr = this.tok === RPAR ? null : this.cpp.captureTokens(RPAR);
    if (stepStr !== null) {
      // captureTokens 停在 `)` 上，它动的是 Cpp 的 tok —— 同步一下
      this.tok = this.cpp.tok;
      this.tokc = this.cpp.tokc;
    }
    this.skip(RPAR);

    this.open(OP.BLOCK, 'continue', REF_NONE);
    this.scopes.push(new Map());
    this.block();
    this.scopes.pop();
    this.close();

    if (stepStr !== null) this.replayStep(stepStr);
    f.emit(OP.BR, T_VOID, REF_NONE, REF_NONE, this.levelOf('loop'));
    this.close();
    this.close();
    this.scopes.pop();
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
    if (t >= TOK_UIDENT) return this.typedefs.has(this.cpp.tokStr(t, null));
    return t === TOK_INT || t === TOK_VOID || t === TOK_BOOL || t === TOK_SIGNED
      || t === TOK_UNSIGNED || t === TOK_CHAR || t === TOK_SHORT || t === TOK_LONG
      || t === TOK_FLOAT || t === TOK_DOUBLE || t === TOK_STRUCT || t === TOK_UNION
      || t === TOK_ENUM || t === TOK_TYPEDEF || t === TOK_EXTERN || t === TOK_STATIC
      || t === TOK_CONST || t === TOK_REGISTER || t === TOK_AUTO || t === TOK_VOLATILE
      || t === TOK_INLINE;
  }

  /**
   * tag 表里查/建一条（`struct_find` 与 `struct_add` 的合体，`tccgen.c:4269` 一带）。
   *
   * **一个 tag 只有一个 info 对象，全程不换**。这条纪律买到的是不完整类型：
   * `struct S *p;` 先拿到一个 `fields: null` 的空壳，后来 `struct S {…}` 往**同一个
   * 对象**里填成员，`p` 手上那份 CType 自动变完整。换成「定义时新建一个对象」就得
   * 回头去修所有已经发出去的类型 —— 一遍过时那是做不到的。
   */
  tagOf(kind, name) {
    if (name !== null) {
      const hit = this.tags.get(name);
      if (hit !== undefined) {
        if (hit.kind !== kind) this.err(`'${name}' defined as wrong kind of tag`);
        return hit;
      }
    }
    const info = {
      kind, name: name === null ? '<anonymous>' : name,
      fields: null, size: 0, align: 1,
    };
    if (name !== null) this.tags.set(name, info);
    return info;
  }

  /**
   * `struct` / `union`（`struct_decl`，`tccgen.c:4269`）。进来时 `struct` 已经吃掉。
   *
   * 布局照 System V / arm64 AAPCS 的规则，也就是 tcc 在本机上的规则：成员按声明顺序
   * 排，每个成员对齐到自己的对齐，整体的对齐是成员里最大的那个，整体大小向上对齐到它。
   * 这几句是**数据**，`sizeof` 与 oracle 逐位对账靠它 —— 差一格 `sizeof(struct)` 就不同。
   * union 是同一段代码的另一支：每个成员偏移 0，大小取最大。
   */
  structDecl(union) {
    const kind = union ? 'union' : 'struct';
    const name = this.tok >= TOK_UIDENT ? this.identName() : null;
    const info = this.tagOf(kind, name);
    if (this.tok !== LBRACE) {
      /* 只是引用（`struct S x;` / `struct S *p;`）。不完整也照样给出去 —— 指针不需要
       * 大小，而「拿不完整类型当变量」由 declareLocal / declareGlobal 抓。 */
      if (name === null) this.err(`'${kind}' has no tag and no member list`);
      return mkStruct(info, union);
    }
    if (info.fields !== null) this.err(`redefinition of '${kind} ${info.name}'`);
    this.next();

    const fields = [];
    /* 布局的状态就两格，与 `struct_layout`（`tccgen.c:4190`）一样：
     *   c       —— 已经排到第几个字节
     *   bitPos  —— 从 c 起，当前这一串位域已经用掉几位（非位域成员一进来就把它冲掉）
     * 两格而不是一格是位域的全部难点：`int a:3; int b:5;` 两个成员的 `off` 相同，
     * 差别只在 bitPos。 */
    let c = 0;
    let bitPos = 0;
    let maxalign = 1;
    while (this.tok !== RBRACE) {
      if (this.tok === TOK_EOF) this.err("'}' expected");
      const spec = this.parseBtype();
      if ((spec.t & VT_STORAGE) !== 0) {
        this.err(`storage class specified for '${kind}' member`);
      }
      const base = stripStorage(spec);
      if (this.tok === SEMI) this.todo('匿名的 struct/union 成员还没到（C11 6.7.2.1 第 13 段）');
      for (;;) {
        /* 匿名位域（`int : 3;` 只占位、`int : 0;` 换一个存储单元）没有声明符，
         * 所以「有没有名字」要在进 declarator 之前问。 */
        let fname = null;
        let fty = base;
        if (this.tok !== COLON) {
          const d = this.declarator(base, 'need');
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
        }
        if (fname === null && bits < 0) {
          this.err('declaration does not declare anything');
        }
        if (fname !== null) {
          if (fields.some((x) => x.name === fname)) {
            this.err(`duplicate member '${fname}'`);
          }
          if (isStruct(fty.t) && fty.ref.fields === null) {
            this.err(`field '${fname}' has incomplete type '${typeText(fty)}'`);
          }
          if (isArray(fty.t) && fty.count < 0) {
            this.todo('柔性数组成员还没到（`char buf[];`）');
          }
        }

        let { size, align } = typeSize(fty);
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
          /* PCC（也就是 gcc）的位域布局：紧挨着前一个位域放，除了两种情形要换一个新的
           * 存储单元 —— 宽度是 0，或者放下去会**越过它自己的基类型容器**。第二种那句
           * 判断照抄（`tccgen.c:4274`）：它算的是「从当前位置起，这个位域要横跨几个
           * align 单位」，超过基类型本来占几个单位就得换。 */
          let newUnit = bits === 0;
          if (!newUnit) {
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
          if (fname === null) align = 1;
          fty = mkBitfield(fty, bitPos, bits);
          bitPos += bits;
        }
        if (align > maxalign) maxalign = align;
        if (fname !== null) fields.push({ name: fname, ty: fty, off });
        if (this.tok !== COMMA) break;
        this.next();
      }
      this.skip(SEMI);
    }
    this.next();       // `}`

    // 末尾那一串没排完的位也要占字节（`tccgen.c:4344`）
    c += (bitPos + 7) >> 3;

    info.fields = fields;
    info.align = maxalign;
    info.size = alignUp(c, maxalign);
    return mkStruct(info, union);
  }

  /**
   * `enum`（`struct_decl` 里 `TOK_ENUM` 那一支）。进来时 `enum` 已经吃掉。
   *
   * 枚举常量是**普通标识符**（与 tag 不在同一个名字空间），而且它们的作用域是
   * 包着这个 enum 的作用域 —— 不是「enum 内部」。所以 `enum {A, B = A + 2}` 里
   * 的 `A` 要立刻可见：一边登记一边求值，共用 `constExpr`。
   *
   * 底层类型就是 `int`（tcc 也是这么选的），`VT_ENUM` 那一位只用来印错误消息。
   */
  enumDecl() {
    const name = this.tok >= TOK_UIDENT ? this.identName() : null;
    const info = this.tagOf('enum', name);
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
    while (this.tok !== RBRACE) {
      if (this.tok === TOK_EOF) this.err("'}' expected");
      const en = this.identName();
      if (this.enumConsts.has(en)) this.err(`redefinition of enumerator '${en}'`);
      if (this.tok === ASSIGN) {
        this.next();
        val = this.constExpr();
      }
      /* 收成 32 位有符号：枚举常量的类型是 `int`，而 `konst` 要的是规范形。
       * 不收的话 `enum {BIG = 0x80000000}` 会带着一个 33 位的数走下去。 */
      val = BigInt.asIntN(32, val);
      this.enumConsts.set(en, { ty, val });
      names.push(en);
      val = val + 1n;
      if (this.tok !== COMMA) break;
      this.next();
    }
    this.skip(RBRACE);
    info.fields = names;
    info.size = 4;
    info.align = 4;
    return ty;
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
  parseBtype() {
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
      if (t === TOK_INLINE) { storage = storage | VT_INLINE; any = true; this.next(); continue; }
      if (t === TOK_TYPEDEF) { storage = storage | VT_TYPEDEF; any = true; this.next(); continue; }
      if (t === TOK_CONST) { quals = quals | VT_CONSTANT; any = true; this.next(); continue; }
      if (t === TOK_VOLATILE) { quals = quals | VT_VOLATILE; any = true; this.next(); continue; }
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
      if (t >= TOK_UIDENT) {
        /* `typedef` 名当基本类型用（tcc 在符号表里找带 `VT_TYPEDEF` 的那条，
         * `tccgen.c:4880` 一带）。**只在还没有基本类型时**才吃它 —— 否则
         * `int x;` 里的 `x` 会被当成类型名（如果恰好有一个同名 typedef 的话）。
         * 这正是 C 那条著名的「typedef 名与标识符不可分辨」，tcc 与我们都靠
         * 「先看有没有基本类型」来断。 */
        if (bt !== -1 || tdef !== null || sign !== 0 || longs > 0 || shorts > 0) break;
        const td = this.typedefs.get(this.cpp.tokStr(t, null));
        if (td === undefined) break;
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
   */
  declarator(base, want) {
    const d = this.declaratorParts(want);
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
  declaratorParts(want) {
    let pre = 0;
    while (this.tok === STAR) {
      this.next();
      pre++;
      // 指针自己的限定词（`char * const p`）：吃掉，这一片没有可观察的效果
      while (this.tok === TOK_CONST || this.tok === TOK_VOLATILE) this.next();
    }

    /** @type {{name:string|null,wrap:(ty:object)=>object}|null} */
    let inner = null;
    let name = null;
    if (this.tok === LPAR && this.isGroupParen()) {
      this.next();
      inner = this.declaratorParts(want);
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
        this.next();
        posts.push({ k: 'arr', n: this.tok === RBRACK ? -1 : Number(this.constExpr()) });
        this.skip(RBRACK);
        continue;
      }
      if (this.tok === LPAR) {
        posts.push({ k: 'fn', ...this.funcParams() });
        continue;
      }
      break;
    }

    const wrap = (base) => {
      let ty = base;
      for (let i = 0; i < pre; i++) ty = mkPointer(ty);
      for (let i = posts.length - 1; i >= 0; i--) {
        const p = posts[i];
        if (p.k === 'fn') {
          ty = mkFunc(ty, p.params, p.variadic);
          continue;
        }
        if (p.n === 0) this.err('zero-sized array');
        if (p.n < -1) this.err('array size must not be negative');
        ty = mkArray(ty, p.n);
      }
      return inner === null ? ty : inner.wrap(ty);
    };
    return { name: inner === null ? name : inner.name, wrap };
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
    /** @type {{name:string,ty:object}[]} */
    const params = [];
    if (this.tok === RPAR) {
      this.next();
      return { params, variadic: false };
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
    const v = this.ceInfix(this.ceUnary(), 1);
    if (typeof v === 'bigint') return v;
    if (!Number.isFinite(v)) this.err('constant expression is not finite');
    return BigInt(Math.trunc(v));
  }

  /**
   * 常量表达式的**浮点**出口（静态的 `double x = 1.5 * 2;` 要它）：同一个求值器，
   * 只是最后不截断。`double x = 1 / 2;` 因此是 0.0 而不是 0.5 —— 两边都是整数就
   * **在整数里算**，转换发生在最后，不在中间。
   */
  constFloatExpr() {
    return Number(this.ceInfix(this.ceUnary(), 1));
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

  ceInfix(left, p) {
    let acc = left;
    let t = this.tok;
    for (;;) {
      const p2 = precedence(t);
      if (p2 < p) break;
      this.next();
      let right = this.ceUnary();
      if (precedence(this.tok) > p2) right = this.ceInfix(right, p2 + 1);
      acc = typeof acc === 'bigint' && typeof right === 'bigint'
        ? ceApply(t, acc, right, (m) => this.err(m))
        : cefApply(t, Number(acc), Number(right), (m) => this.err(m));
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
        return this.ceCastTo(ty, this.ceUnary());
      }
      /* 分组：回的是原样值 —— 不在这儿提前截断，否则 `(1.5 + 1) * 2` 会算成 4。 */
      const v = this.ceInfix(this.ceUnary(), 1);
      this.skip(RPAR);
      return v;
    }
    if (t === TOK_SIZEOF) {
      this.next();
      this.skip(LPAR);
      if (!this.isTypeStart(this.tok)) this.todo('常量表达式里的 sizeof 只支持类型名');
      const ty = this.typeName();
      this.skip(RPAR);
      return BigInt(typeSize(ty).size);
    }
    if (t >= TOK_UIDENT) {
      const nm = this.cpp.tokStr(t, null);
      /* 枚举常量。`enum {A, B = A + 2}` 里的 `A` 走这一格 —— 也就是说 enumDecl 一边
       * 登记一边求值这件事在这里闭环。查不到就落到下面报「要一个常量表达式」。 */
      const ec = this.enumConsts.get(nm);
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
        return fnPtr(fn.no);
      }
    }
    this.err('constant expression expected');
    return 0n;
  }

  /**
   * `decl`（`tccgen.c:8747`）。回 `true` 表示「读掉了至少一个声明」——
   * 复合语句的循环与 `for` 的初始化都靠这个返回值区分声明与语句（`tccgen.c:7311`）。
   * @param {boolean} global 顶层（可以有函数定义）还是块内
   */
  decl(global) {
    let any = false;
    for (;;) {
      if (!this.isTypeStart(this.tok)) break;
      const spec = this.parseBtype();
      const isTypedef = (spec.t & VT_TYPEDEF) !== 0;
      const isExtern = (spec.t & VT_EXTERN) !== 0;
      /* 存储类**先剥掉**再进声明符：`static int a[3];` 的类型是 `int[3]`，而「剥」
       * 必须在套数组之前 —— 套完再剥就得重建一个 CType，而 `count` 挂在对象上
       * （ctype.js:129），重建时最容易掉的正是它。 */
      const base = stripStorage(spec);
      any = true;
      if (this.tok === SEMI) { this.next(); continue; }
      let wasBody = false;
      for (;;) {
        const d = this.declarator(base, 'need');
        const name = /** @type {string} */ (d.name);
        if (isTypedef) {
          /* `typedef` 不声明对象，只给一个类型起名。重复的 typedef 是合法的（C11
           * 6.7 第 3 段：同一个类型可以说两遍），不同类型的重名才是错。 */
          const prev = this.typedefs.get(name);
          if (prev !== undefined && !sameType(prev, d.ty)) {
            this.err(`typedef '${name}' redefined with a different type`);
          }
          this.typedefs.set(name, d.ty);
        } else if (isFunc(d.ty.t)) {
          if (this.funcDecl(global, name, d.ty)) { wasBody = true; break; }
        } else {
          /* 局部量与全局量走**同一段**代码：不同的只有「往哪儿落地」（一个 dest 对象），
           * 遍历嵌套结构那套规则在 `initializer` 里只有一份。 */
          const hasInit = this.tok === ASSIGN;
          if (hasInit) this.next();
          if (isExtern && hasInit) this.err(`'${name}' has both 'extern' and initializer`);

          /* 不定长数组（`int a[] = {…}`）的类型要等初始化式才定得下来 —— 于是这儿
           * 「定类型」与「划地方」的顺序是反的：先看初始化式，再声明。 */
          let vty = d.ty;
          let body = null;
          let strBytes = null;
          const braced = hasInit && this.tok === LBRACE;
          if (isArray(vty.t) && vty.count < 0) {
            if (!hasInit) this.err(`array size missing in '${name}'`);
            if (this.tok === TOK_STR) {
              /* 相邻的字面量要拼起来（`char s[] = "a" "b"`），所以只能真的读一遍；
               * 读完记号已经吃掉，字节留在手上。 */
              strBytes = this.readStrTok(this.tokc);
              vty = mkArray(vty.ref, strBytes.length + 1);
            } else {
              const r = this.sizeFromInit(vty);
              vty = r.ty;
              body = r.body;
            }
            if (vty.count === 0) this.err(`zero-sized array '${name}'`);
          }

          const e = global ? this.declareGlobal(name, vty, isExtern)
            : this.declareLocal(name, vty);
          if (hasInit) {
            let dest;
            let base;
            if (global) {
              dest = { stat: true, addr: e.addr };
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
            if (braced && !global && e.off >= 0) {
              this.autoZero(this.fpRef, e.off, typeSize(vty).size);
            }
            if (strBytes !== null) this.initString(dest, base, vty, strBytes);
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
  funcDecl(global, name, fnTy) {
    const info = this.funcSym(name);
    /* 形参表已经在声明符里读完了（第十二片：`(…)` 是声明符的后缀，不是函数定义的
     * 一部分）—— 这儿只把函数类型拆开交给 `finishFunc`。 */
    return this.finishFunc(global, info, name, stripStorage(fnTy.ref.ret),
      fnTy.ref.params, fnTy.ref.variadic);
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
  finishFunc(global, info, name, ret, params, variadic) {
    if (info.params !== null && info.params.length !== params.length) {
      this.err(`conflicting types for '${name}'`);
    }
    info.params = params;
    info.ret = ret;
    info.variadic = variadic === true;
    info.declared = true;
    info.f.ret = mirTypeOf(ret);

    if (this.tok !== LBRACE) return false;          // 只是个原型，`;` 交给 decl
    if (!global) this.err('nested function definition');
    if (info.defined) this.err(`redefinition of '${name}'`);
    info.defined = true;

    const body = this.cpp.captureBraced();
    const afterTok = this.cpp.tok;
    const afterVal = this.cpp.tokc;

    // ---- 第一遍：只为了知道谁要落在内存上、帧要多大。输出丢掉
    this.pass1 = true;
    this.addrTaken = new Set();
    this.declScalars = [];
    this.frameNames = new Set();
    this.frameSize = 0;
    this.frameOff = 0;
    this.blockLabels = [];
    this.funcLabels = new Set();
    this.fpRef = this.mod.consts.int(0n);
    this.runBody(body, new MirFunc(`$scan$${name}`, [], mirTypeOf(ret)), ret, name, params,
      info.variadic);


    let est = this.frameOff;   // 数组之类「非落内存不可」的已经算在里面了
    for (const d of this.declScalars) {
      if (this.addrTaken.has(d.name)) est += alignUp(d.size, FRAME_ALIGN);
    }
    this.pass1 = false;
    this.frameNames = this.addrTaken;

    // ---- 第二遍：真的
    this.frameSize = alignUp(est, 16);
    this.frameOff = 0;
    this.runBody(body, info.f, ret, name, params, info.variadic);

    // 记号还原（`replayStep` 同一手法）：函数体是从记号串里读的，读完要回到文件流上
    this.cpp.tok = afterTok;
    this.cpp.tokc = afterVal;
    this.tok = afterTok;
    this.tokc = afterVal;
    return true;
  }

  /**
   * 把收好的函数体放一遍，发进 `f`。序言、收场、形参落位都在这儿 ——
   * 两遍走**同一段**代码，于是第一遍数出来的帧与第二遍分配出来的帧一定是同一套规则。
   */
  runBody(body, f, ret, name, params, variadic) {
    const outer = this.f;
    this.f = f;
    this.funcRet = ret;
    this.funcName = name;
    this.scopes = [new Map()];
    this.regions = [];
    this.swStack = [];
    /* 两遍各自从 0 数起，于是同一个复合语句在两遍里是同一个序号（`openLabels` 头）。 */
    this.blockNo = 0;
    this.labelSink = [];
    this.gotoStack = [];

    if (!this.pass1) {
      this.spSave = REF_NONE;
      this.fpRef = REF_NONE;
      if (this.frameSize > 0) {
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
      const slot = f.slot('$va', T_I64);
      f.params.push({ name: '$va', t: T_I64, slot });
      this.vaRef = f.emit(OP.LOAD, T_I64, REF_NONE, REF_NONE, slot);
    }

    this.cpp.pushTokens(body);
    this.next();
    this.block();  // 当前记号是 `{`

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
  }

  /** `$sp` 的全局号。第一次用到才登记 —— 没有函数要帧的模块于是不多一个全局。 */
  spGlobal() {
    if (this.spNo < 0) {
      this.spNo = this.mod.globalNo('$sp');
      this.mod.setGlobalTy(this.spNo, T_I64);
    }
    return this.spNo;
  }

  /** 收场：把 `$sp` 还回去。**每条 RET 之前都要**，所以单独一个函数。 */
  emitEpilogue() {
    if (this.pass1 || this.frameSize === 0) return;
    this.f.emit(OP.GSTORE, T_VOID, this.spSave, REF_NONE, this.spNo);
  }

  /** 一个翻译单元（`tccgen_compile`，`tccgen.c:417-419`）。 */
  unit() {
    this.next();
    while (this.tok !== TOK_EOF) {
      if (!this.decl(true)) this.expect('declaration');
    }
    for (const [name, info] of this.funcs) {
      if (info.defined) continue;
      /* 这个单元里没有函数体 = 外部符号。C99 起「隐式声明」是错，tcc 只警告（并且当
       * `int f()`）—— 照 tcc，因为它是 oracle。 */
      if (!info.declared) this.cpp.warn(`implicit declaration of function '${name}'`);
      /* 用到堆的模块要在入口处把堆的起点交给宿主（见 `lowerC` 末尾）。在这儿问而不是
       * 在调用点问：外部符号的清单正好在这个循环里，而「有没有用到」就是「它是不是
       * 这个单元里的一个外部符号」。 */
      if (HEAP_FNS.has(name)) this.heapUsed = true;
      this.externThunk(name, info);
    }
    /* `extern int x;` 之后没有定义：真的编译器要等链接期才知道。我们只有一个翻译单元，
     * 所以「用过但没定义」当场就是错。地址仍然分配过（一遍过里引用发生在定义之前，
     * 代码得先有个地址可发），所以这一问只能等到这儿再答 —— 与 `funcs` 那一条同一个理由。 */
    for (const [name, e] of this.gvars) {
      if (!e.defined && e.used) this.err(`undefined symbol '${name}'`);
    }
  }
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
 */
export function lowerC(path, text, host, defs) {
  const cpp = new Cpp(host);
  for (const d of defs ?? []) cpp.define(d.name, d.body);
  const mod = new MirModule('omni_main');
  const gen = new CGen(cpp, mod);
  cpp.startParse(path, text);
  gen.unit();

  /* 线性内存的版图（ADR-0017 第六刀第三片，第十五片在末尾加了堆）：
   *   [0, 64K)            页 0 整页留空 —— C 的 `NULL` 于是**一定**访问不到，
   *                       而不是「碰巧落在别的东西上」
   *   [64K, dataOff)      data 段：字符串字面量与全局量，往上长
   *   [栈底, 栈顶)        影子栈：16 对齐，`$sp` 从栈顶往下长
   *   [堆底, …)           堆：从栈顶之上的**下一个页边界**起，往上长，不够就 `MGROW`
   * `mem.min` 按栈顶（用到堆时按堆底加一页）算出页数。上界不设（0）。
   * 堆按页边界起是为了「先给整整一页」，于是 `__omni_heap_init` 写第一个字节时
   * 内存一定已经够 —— 那条初始化不必自己先长内存。 */
  const stackBase = alignUp(gen.dataOff, 16);
  const stackTop = stackBase + C_STACK_BYTES;
  const heapBase = alignUp(stackTop, MEM_PAGE);
  const pages = gen.heapUsed
    ? heapBase / MEM_PAGE + 1
    : Math.ceil(stackTop / MEM_PAGE);
  mod.setMem(pages, 0);

  for (const d of gen.pendingData) mod.addData(d.off, d.bytes);

  const info = gen.funcs.get('main');
  if (info === undefined) throw new OmniError(`${path}: error: undefined symbol 'main'`);
  if (info.params !== null && info.params.length !== 0) {
    throw new OmniError(`${path}: error: 第六刀：'int main(argc, argv)' 还没到（要变参与 argv）`);
  }
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
  const rt = mirTypeOf(info.ret);
  if (rt === T_VOID) {
    entry.emit(OP.CALL, T_VOID, info.no, entry.pushArgs([]), 0);
    entry.emit(OP.RET, T_I32, mod.consts.i32(0), REF_NONE, 0);
  } else {
    let v = entry.emit(OP.CALL, rt, info.no, entry.pushArgs([]), 0);
    // `main` 声明成 long 之类时把它收到 i32（退出码只有 8 位，但入口的类型要对得上）
    if (rt === T_I64) v = entry.emit(OP.CVT, T_I32, v, REF_NONE, CVT_TRUNC);
    entry.emit(OP.RET, T_I32, v, REF_NONE, 0);
  }
  return { mod, warnings: cpp.warnings };
}





