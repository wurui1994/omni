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
//        自带后端那条路上它会退回成一条跳转。
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
// ## 内存的版图
//
// 页 0（0..64K）整页留空 —— C 的 `NULL` 于是**一定**访问不到。data 段从 64K 往上长
// （字符串字面量与全局量）；影子栈接在它后面，`$sp`（一个 i64 全局）从栈顶往下长。
// 全局量的地址是编译期常量，所以它们不用影子栈；**没有初始化式的全局量不写一个字节
// data** —— 线性内存出生时全是 0，而 C 正好规定静态存储期零初始化。
// 指针就是**线性内存里的字节偏移**（`T_I64`），不是 ADR-0016 的 `T_PTR`/`T_TPTR` ——
// 那两个带范围检查、一块一块地分配，而 C 要的是一整片可寻址的字节。
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
// **外部符号（`unit()` 末尾的转发桩）与变参调用（printf/sprintf 那一族已经跑通）**。
// 还没到：struct/union/enum、聚合初始化器、带括号的声明符（`int (*a)[3]`、函数指针）、
// 浮点（含 printf 的 `%f/%e/%g`）、`switch`/`goto`、`malloc` 那一族（要堆）、
// 变参函数的**定义**（要 `va_list`/`va_arg`）。
//
// 碰到还没做到的东西**当场报错**，报错文本里带「第六刀」字样 —— 一眼能看出是进度不是
// bug，而且下一片把它做掉时 `gen-bad/` 里那条用例会跟着红，于是「边界移动了」这件事
// 不会悄悄发生（第四刀前半那一节讲过这条纪律）。
//
// oracle 原先只是 `tcc -run` 的**进程退出码**（`main` 的返回值，8 位）；printf 通了之后
// 升级成「退出码 **加 stdout 逐字节相同**」—— 一次比较从 1 字节变成几百字节，同一份用例
// 能钉住的东西多了两个数量级。有两格**不能**跟 tcc 对：`%p`（地址空间不同）与浮点。

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
  isAssignOp, assignOpOf,
} from './tcctok.js';
import {
  VT_VOID, VT_BYTE, VT_SHORT, VT_INT, VT_LLONG, VT_BOOL, VT_PTR, VT_FUNC,
  VT_UNSIGNED, VT_DEFSIGN, VT_LONG, VT_FLOAT, VT_DOUBLE,
  VT_EXTERN, VT_STATIC, VT_TYPEDEF, VT_INLINE, VT_CONSTANT, VT_VOLATILE, VT_STORAGE,
  btype, isInteger, isFloat, isUnsigned, isPtr, isArray, isFunc,
  ctype, mkPointer, mkArray, typeSize, typeText, sameType,
  TY_VOID, TY_INT, TY_UINT, TY_LLONG, TY_ULLONG, TY_CHAR, TY_SHORT, TY_BOOL,
} from './ctype.js';
import {
  MirModule, MirFunc, OP, T_VOID, T_I32, T_I64, T_BOOL, REF_NONE,
  CVT_SEXT, CVT_ZEXT, CVT_TRUNC, CVT_SEXT8, CVT_SEXT16, memDesc, MEM_PAGE,
} from '../mir/ir.js';

/* 线性内存的访问描述符号（`MLOAD_KINDS` / `MSTORE_KINDS` 的下标，ir.js:383）。
 * 写成常量是为了 `loadKindOf` 读起来像一张表 —— 下标写字面量的话改一次表就全错。 */
const MK_I8S = 0;
const MK_I8U = 1;
const MK_I16S = 2;
const MK_I16U = 3;
const MK_I32S = 4;
const MK_I64 = 6;
const SK_I8 = 0;
const SK_I16 = 1;
const SK_I32 = 2;
const SK_I64 = 3;

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
  return MK_I64;   // long / long long / 指针
}

/** 往内存里写：只是「把低若干位拍进去」，没有符号可言（load 有 `_s`/`_u`，store 没有）。 */
function storeKindOf(ty) {
  const b = btype(ty.t);
  if (b === VT_BOOL || b === VT_BYTE) return SK_I8;
  if (b === VT_SHORT) return SK_I16;
  if (b === VT_INT) return SK_I32;
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
  if (b === VT_FLOAT) return T_I32;   // 到不了这儿（浮点还没做），留着让 switch 完整
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
function decayedType(ty) { return isArray(ty.t) ? mkPointer(ty.ref) : ty; }

/** 整型提升之后的类型（**不发指令**）。只问类型的地方用它，别叫 `promote`。 */
function promotedType(ty) {
  const b = btype(ty.t);
  if (b === VT_BOOL || b === VT_BYTE || b === VT_SHORT) return TY_INT;
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
    /** @type {Map<string,object>} `typedef` 的名字表（tcc 用 `VT_TYPEDEF` 挂在符号上） */
    this.typedefs = new Map();
    /** @type {Map<string,{ty:object,addr:number,defined:boolean,used:boolean}>} 全局量 */
    this.gvars = new Map();
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
   * 数组（以后还有 struct/union）没有「装在一个寄存器里」的形态：`a[i]` 要能算地址。
   * 标量则相反 —— 只有被 `&` 取过地址才不得不落到内存，那一问由第一遍回答。
   */
  needsMem(ty) {
    return isArray(ty.t);
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
    const bv = BigInt(v);
    return mirTypeOf(ty) === T_I64
      ? this.mod.consts.int(BigInt.asIntN(64, bv))
      : this.mod.consts.i32(BigInt.asIntN(32, bv));
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
   * 数组 -> 指向首元素的指针（`gen_cast` 之前 tcc 靠 `VT_ARRAY` 与 `VT_PTR` 同在一格
   * 免了大部分这类代码，见 ctype.js 头）。**值**不变，只是类型从 `T[N]` 变成 `T*` ——
   * 所以这里没有指令，只有一次 `addrOf`（它本身可能发一条 ADD）。
   */
  decay(v) {
    if (isArray(v.ty.t)) return sVal(mkPointer(v.ty.ref), this.addrOf(v));
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
  promote(v) {
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

    const from = v.ty;
    if (isFloat(from.t) || isFloat(ty.t)) this.todo('浮点还没到');
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
   * 全局量的初始化式。**必须是常量表达式**（C11 6.7.9 第 4 段）—— 这正好与
   * 「没有常量折叠」那条偏离和解：折叠不在主路上，但 C 本来就要求这些位置是常量，
   * 所以这儿走 `constExpr` 那个独立的小求值器。
   */
  globalInit(e) {
    const ty = e.ty;
    if (this.tok === LBRACE) this.todo('聚合初始化器 `{…}` 还没到');
    if (isArray(ty.t)) this.todo('数组的初始化器还没到（`char s[] = "…"`）');
    if (this.tok === TOK_STR) {
      /* `char *s = "abc";` —— 值是那个字面量在 data 段里的地址。这在真的目标文件里是
       * 一条重定位；我们的「链接」是一个常量，所以它就是一个 8 字节的数。 */
      if (!isPtr(ty.t)) this.err(`invalid initializer for '${typeText(ty)}'`);
      const addr = this.strData(this.readStrTok(this.tokc));
      this.emitBytes(e.addr, 8, BigInt(addr));
      return;
    }
    this.emitBytes(e.addr, typeSize(ty).size, this.constExpr());
  }

  /** `unary`（`tccgen.c:5595`）。前缀与后缀都在这儿，与 tcc 一样。 */
  unary() {
    const t = this.tok;

    // 带值的记号：整数与字符常量。`next()` 会毁掉 tokc，所以先取（`tccgen.c:7185`）
    if (tokHasValue(t)) {
      const cv = this.tokc;
      if (t === TOK_CFLOAT || t === TOK_CDOUBLE || t === TOK_CLDOUBLE) {
        this.todo('浮点常量还没到');
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
      if (isFunc(v.ty.t)) this.todo('取函数地址还没到（要函数指针与 call_indirect）');
      /* `&a`（a 是数组）的类型是「指向数组的指针」，不是「指向元素的指针」——
       * 两者的**值**相同，但 `sizeof(*&a)` 差一个数量级。所以这里不退化。 */
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

    if (t >= TOK_UIDENT) {
      const name = this.identName();
      const local = this.lookup(name);
      if (local !== null) return this.postfix(this.entryLval(name, local));
      const gv = this.gvars.get(name);
      if (gv !== undefined) return this.postfix(this.gvarLval(gv));
      /* 既不是局部量也不是全局量：那就只能是函数。tcc 在这里走 `external_global_sym`
       * （`tccgen.c:1143`）建一个待重定位的符号，我们同样先建 —— 但只在紧跟着 `(`
       * 时才算调用，否则是「取函数地址」，那要函数指针。 */
      if (this.tok !== LPAR) {
        this.err(`'${name}' undeclared`);
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

  /** 后缀：`x++` / `x--`。（`->`、`.`、`[]` 是后面几片的事） */
  postfix(v) {
    let cur = v;
    for (;;) {
      const t = this.tok;
      if (t === TOK_INC || t === TOK_DEC) {
        this.next();
        cur = this.incdec(cur, t === TOK_INC ? PLUS : MINUS, true);
        continue;
      }
      if (t === LPAR) this.todo('函数指针调用还没到');
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
      if (t === DOT || t === TOK_ARROW) this.todo('struct 还没到');
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
    const old = this.gv(target);
    const nv = this.genOp(op, sVal(target.ty, old), sVal(TY_INT, this.mod.consts.i32(1)));
    const stored = this.vstore(target, nv);
    return sVal(target.ty, post ? old : stored.ref);
  }

  /** 调用：`名字 ( 实参… )`。名字已经吃掉，当前记号是 `(`。 */
  funcCall(name) {
    const info = this.funcSym(name);
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
    const np = info.params === null ? -1 : info.params.length;
    if (np >= 0) {
      const bad = info.variadic ? vals.length < np : vals.length !== np;
      if (bad) {
        this.err(`too ${vals.length < np ? 'few' : 'many'} arguments to function '${name}'`);
      }
    }
    const refs = [];
    for (let i = 0; i < vals.length; i++) {
      /* 固定形参按**声明的类型**转（原型的作用）；`...` 后面那些按**默认实参提升**
       * （C11 6.5.2.2 第 6 段）：窄整数提到 int、数组与函数退化成指针。
       * 用 `promotedType` 而不是 `promote`：后者会真的取一次值，这里只想问类型。 */
      const want = (np >= 0 && i < np)
        ? info.params[i].ty
        : promotedType(decayedType(vals[i].ty));
      refs.push(this.gv(this.castTo(vals[i], want)));
    }
    if (info.params === null) {
      info.params = vals.map((v, i) => ({
        name: `$p${i}`, ty: promotedType(decayedType(v.ty)),
      }));
    }
    const rt = mirTypeOf(info.ret);
    if (info.variadic) {
      /* 变参函数：**每个调用点的实参个数都不同**，所以不能像非变参那样在 `unit()` 末尾
       * 造一个转发桩（一个桩只装得下一副形参）。直接在调用点发 CCALL。
       * 这一片里变参函数一定是外部的 —— 在 C 里**定义**一个变参函数要 `va_arg`，还没到。 */
      return sVal(info.ret, this.f.emit(OP.CCALL, rt,
        this.mod.cabiNo(name), this.f.pushArgs(refs), 0));
    }
    return sVal(info.ret, this.f.emit(OP.CALL, rt, info.no, this.f.pushArgs(refs), 0));
  }

  /**
   * 外部函数的转发桩。这个翻译单元里没有函数体的名字就是外部符号 —— 真的编译器把它交给
   * 链接器，我们给它一个桩：读进形参、发一条 CCALL、把结果返回。
   *
   * 为什么是桩、而不是在调用点直接发 CCALL：一遍过里**调用点可能出现在定义之前**，
   * 那时还不知道这个名字最后有没有定义。桩把这个问题推到读完整个单元之后 —— 与
   * 「undefined symbol」那条检查同一个位置，而调用点照旧发 CALL，一条都不用改。
   *
   * 变参函数是例外（见 funcCall），它们的桩因此是死代码 —— 就当它是 PLT 里那条
   * 永远走不到的项。留着而不是删掉，是因为删一个函数会挪动 `funcIndex`，
   * 而那些下标已经发在别人的 CALL 里了。
   */
  externThunk(name, info) {
    const f = info.f;
    const params = info.params === null ? [] : info.params;
    const refs = [];
    for (const p of params) {
      const mt = mirTypeOf(p.ty);
      const slot = f.slot(p.name, mt);
      f.params.push({ name: p.name, t: mt, slot });
      refs.push(f.emit(OP.LOAD, mt, REF_NONE, REF_NONE, slot));
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
   */
  exprCond() {
    const v = this.exprLor();
    if (this.tok !== QUEST) return v;
    this.next();
    const f = this.f;
    const c = this.gtst(v);
    const slot = this.temp(T_I64, 'sel');
    this.open(OP.IF, 'if', c);
    const a = this.gexpr();
    f.emit(OP.STORE, T_VOID, this.gv(this.castTo(a, TY_LLONG)), REF_NONE, slot);
    this.elseHalf();
    this.skip(COLON);
    const b = this.exprCond();
    f.emit(OP.STORE, T_VOID, this.gv(this.castTo(b, TY_LLONG)), REF_NONE, slot);
    this.close();
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
      this.scopes.push(new Map());
      /* tcc 的复合语句循环（`tccgen.c:7243-7248`）：先试声明，不是声明才当语句。
       * 「声明和语句可以交替出现」（C99）就是这个循环的形状带来的。 */
      while (this.tok !== RBRACE) {
        this.decl(false);
        if (this.tok !== RBRACE) this.block();
      }
      this.next();
      this.scopes.pop();
      return;
    }

    if (t === TOK_RETURN) {
      this.next();
      const hasVal = btype(this.funcRet.t) !== VT_VOID;
      if (this.tok !== SEMI) {
        const v = this.gexpr();
        if (hasVal) {
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

    if (t === TOK_SWITCH || t === TOK_CASE || t === TOK_DEFAULT) {
      this.todo('switch 还没到（MIR 的 BRTABLE 已经有了，缺前端这侧的密集化判断）');
    }
    if (t === TOK_GOTO) this.todo('goto 还没到（结构化控制流下它要另一套办法）');

    if (t === SEMI) {
      this.next();
      return;
    }

    this.exprStmt();
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
      if (t === TOK_FLOAT || t === TOK_DOUBLE) this.todo('浮点还没到');
      if (t === TOK_STRUCT || t === TOK_UNION) this.todo('struct / union 还没到');
      if (t === TOK_ENUM) this.todo('enum 还没到');
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
   * 顺序是这一段唯一的难点：**先吃前缀的 `*`，再吃后缀的 `[]`，而后缀绑得更紧**。
   * 于是 `int *a[3]` 是「3 个 `int *` 的数组」而不是「指向 `int[3]` 的指针」，
   * `int *f(void)` 是「回 `int *` 的函数」。`int (*a)[3]` 要在括号里再来一层，
   * 那要把「已经攒了一半的类型」当参数往里传（tcc 的 `type_decl` 递归就是干这个的），
   * 这一片还没做。
   *
   * @param {object} base 基本类型（**存储类已经剥掉**）
   * @param {'need'|'opt'|'none'} want 名字：必须有 / 可省（原型里的形参）/ 不能有
   */
  declarator(base, want) {
    let ptr = 0;
    while (this.tok === STAR) {
      this.next();
      ptr++;
      // 指针自己的限定词（`char * const p`）：吃掉，这一片没有可观察的效果
      while (this.tok === TOK_CONST || this.tok === TOK_VOLATILE) this.next();
    }
    if (this.tok === LPAR) {
      this.todo('带括号的声明符还没到（`int (*a)[3]`、函数指针）');
    }
    let name = null;
    if (this.tok >= TOK_UIDENT) {
      if (want === 'none') this.err('unexpected identifier in type name');
      name = this.identName();
    } else if (want === 'need') {
      this.expect('identifier');
    }
    /* 维度先收进一个表、再**倒着**套：`int a[2][3]` 是「2 个 `int[3]`」。
     * 顺着套会得到「3 个 `int[2]`」—— 大小一样，`sizeof(a[0])` 不一样（8 vs 12）。 */
    const dims = [];
    while (this.tok === LBRACK) {
      this.next();
      if (this.tok === RBRACK) dims.push(-1);
      else dims.push(Number(this.constExpr()));
      this.skip(RBRACK);
    }
    let ty = base;
    for (let i = 0; i < ptr; i++) ty = mkPointer(ty);
    for (let i = dims.length - 1; i >= 0; i--) {
      if (dims[i] === 0) this.err('zero-sized array');
      if (dims[i] < -1) this.err('array size must not be negative');
      ty = mkArray(ty, dims[i]);
    }
    return { ty, name };
  }

  /**
   * 常量表达式（`expr_const`，`tccgen.c:6795`）：数组的维度要它，以后 `case` 标签与
   * 位域宽度也要。
   *
   * tcc 那边是**同一套**表达式解析器加常量折叠 —— 它的 `vtop` 上带着 `VT_CONST`，
   * `gen_op` 顺手就折了。这一片没有折叠（文件头偏离 3：折叠是语义可见的），所以这里
   * 是一个独立的小求值器：只认常量，见到变量就报错。代价是「运算符怎么算」有两份，
   * 收益是主路上一行折叠代码都没有 —— 而 `1/0` 在数组维度里该是编译错、在表达式里
   * 该是运行时错，两份代码正好各自说对一半。
   *
   * 优先级表**共用** `precedence()`，所以结合性不会与主路分岔。
   */
  constExpr() {
    return this.ceInfix(this.ceUnary(), 1);
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
      acc = ceApply(t, acc, right, (m) => this.err(m));
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
    if (t === PLUS) { this.next(); return this.ceUnary(); }
    if (t === MINUS) { this.next(); return -this.ceUnary(); }
    if (t === TILDE) { this.next(); return ~this.ceUnary(); }
    if (t === BANG) { this.next(); return this.ceUnary() === 0n ? 1n : 0n; }
    if (t === LPAR) {
      this.next();
      const v = this.constExpr();
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
          if (this.tok === LPAR) this.todo('函数类型的 typedef 还没到');
          /* `typedef` 不声明对象，只给一个类型起名。重复的 typedef 是合法的（C11
           * 6.7 第 3 段：同一个类型可以说两遍），不同类型的重名才是错。 */
          const prev = this.typedefs.get(name);
          if (prev !== undefined && !sameType(prev, d.ty)) {
            this.err(`typedef '${name}' redefined with a different type`);
          }
          this.typedefs.set(name, d.ty);
        } else if (this.tok === LPAR) {
          if (this.funcDecl(global, name, d.ty)) { wasBody = true; break; }
        } else if (!global) {
          if (isArray(d.ty.t) && d.ty.count < 0) {
            this.err(`array size missing in '${name}'`);
          }
          const e = this.declareLocal(name, d.ty);
          if (this.tok === ASSIGN) {
            this.next();
            if (this.tok === LBRACE) this.todo('聚合初始化器 `{…}` 还没到');
            if (isArray(d.ty.t)) this.todo('数组的初始化器还没到（`char s[] = "…"`）');
            /* 初始化式是**赋值表达式**，不是逗号表达式（`int a = 1, b = 2;` 里那个
             * 逗号是声明的分隔符）—— 这一格错了整行都会读歪。 */
            this.vstore(this.entryLval(name, e), this.exprEq());
          }
        } else {
          if (isArray(d.ty.t) && d.ty.count < 0) {
            this.err(`array size missing in '${name}'`);
          }
          const e = this.declareGlobal(name, d.ty, isExtern);
          if (this.tok === ASSIGN) {
            this.next();
            if (isExtern) this.err(`'${name}' has both 'extern' and initializer`);
            this.globalInit(e);
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
  funcDecl(global, name, ret) {
    const info = this.funcSym(name);
    this.skip(LPAR);
    /** @type {{name:string,ty:object}[]} */
    const params = [];
    let variadic = false;
    if (this.tok === RPAR) {
      // 老式的 `f()`：形参没说。这一片当「没有形参」处理
      this.next();
    } else if (this.tok === TOK_VOID) {
      // `(void)` = 没有形参；`(void *p)` 之类要交回去按普通形参走
      this.next();
      if (this.tok === RPAR) {
        this.next();
      } else {
        this.cpp.ungetTok(TOK_VOID);
        this.tok = this.cpp.tok;
        this.tokc = this.cpp.tokc;
        variadic = this.paramList(params);
      }
    } else {
      variadic = this.paramList(params);
    }
    return this.finishFunc(global, info, name, stripStorage(ret), params, variadic);
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
      if (btype(ty.t) === VT_VOID) this.err('parameter has void type');
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
    if (info.variadic) this.todo('变参函数的**定义**还没到（要 va_list / va_arg）');
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
    this.fpRef = this.mod.consts.int(0n);
    this.runBody(body, new MirFunc(`$scan$${name}`, [], mirTypeOf(ret)), ret, name, params);

    let est = this.frameOff;   // 数组之类「非落内存不可」的已经算在里面了
    for (const d of this.declScalars) {
      if (this.addrTaken.has(d.name)) est += alignUp(d.size, FRAME_ALIGN);
    }
    this.pass1 = false;
    this.frameNames = this.addrTaken;

    // ---- 第二遍：真的
    this.frameSize = alignUp(est, 16);
    this.frameOff = 0;
    this.runBody(body, info.f, ret, name, params);

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
  runBody(body, f, ret, name, params) {
    const outer = this.f;
    this.f = f;
    this.funcRet = ret;
    this.funcName = name;
    this.scopes = [new Map()];
    this.regions = [];

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

    /* 形参就是前几个槽 —— MIR 的解释器按这个约定填帧（interp.js:274 的注释）。
     * 被取过地址的形参**两处都有**：ABI 那个槽照旧（值从调用方来），再拷一份到帧上，
     * 名字绑帧上那份。少了这次拷贝，`&x` 指向的是一块没人写过的内存。 */
    for (const p of params) {
      const mt = mirTypeOf(p.ty);
      const slot = f.slot(p.name, mt);
      f.params.push({ name: p.name, t: mt, slot });
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

    this.cpp.pushTokens(body);
    this.next();
    this.block();  // 当前记号是 `{`
    if (this.tok !== TOK_EOF) this.err('internal: 函数体没读完');
    this.cpp.endMacro();

    /* 落到函数尾：C 里非 void 函数不 return 是 UB（tcc 让返回值是垃圾）。MIR 要
     * 每条路都有 RET 才良构，所以无条件补一条 —— 前面已经 RET 的路走不到这里。 */
    this.emitEpilogue();
    if (f.ret === T_VOID) f.emit(OP.RET, T_VOID, REF_NONE, REF_NONE, 0);
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

  /* 线性内存的版图（ADR-0017 第六刀第三片）：
   *   [0, 64K)            页 0 整页留空 —— C 的 `NULL` 于是**一定**访问不到，
   *                       而不是「碰巧落在别的东西上」
   *   [64K, dataOff)      data 段：字符串字面量（以后还有全局量），往上长
   *   [栈底, 栈顶)        影子栈：16 对齐，`$sp` 从栈顶往下长
   * `mem.min` 按栈顶算出页数。上界不设（0）—— 这一片没人调 `MGROW`。 */
  const stackBase = alignUp(gen.dataOff, 16);
  const stackTop = stackBase + C_STACK_BYTES;
  mod.setMem(Math.ceil(stackTop / MEM_PAGE), 0);
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





