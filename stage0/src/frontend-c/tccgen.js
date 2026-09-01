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
//    错误）。先记在这儿不做。
//
// ## 窄整数在寄存器里是什么样（这一片最要紧的一条不变量）
//
// `char` / `short` / `_Bool` 在 MIR 里都是 `T_I32`，而且**永远处在规范形**：
// 有符号的那些符号扩展过、无符号的那些落在 0..2^n-1 里。tcc 与 wasm 都是这么做的
// （`tcc.h` 里根本没有 8/16 位的寄存器类）。这条不变量买到两件事：
//   - **整型提升不发任何指令** —— `char` 提到 `int` 只是换一个 CType，位一个都不动；
//   - 宽度只在两处看得见：存进内存（`MSTORE` 的描述符）与显式转换（`CVT_SEXT8/16`）。
// 反过来，任何产生窄类型值的地方都**必须**收口回规范形，否则「提升不发指令」这条
// 就成了错的。收口只在 `castTo` 一处，别处不许自己截。
//
// ## 这一片做到哪儿（**是路标，不是终点**）
//
// 终点是「能编译 tinycc 自己的全部源码」，所以 printf、指针、struct、变参、`setjmp`
// 一个都躲不过去 —— 下面这些不是「刻意不做」，是**还没做到那一片**。分片顺序与理由写在
// ADR-0017 第六刀的落地节里，一句话：按解锁能力排，不按语法书的章节排。
//
// 已经做到：`void`、`_Bool`、`char`/`short`/`int`/`long`/`long long` 及其 `unsigned`
// 版本、整型提升与常规算术转换、强制转换、`sizeof(类型)`、函数（互相递归随便）、
// 局部变量、C 的全部优先级、`if/else`、`while`、`do`、`for`、`break`、`continue`、`return`。
// 还没到：指针与数组（下一片，要影子栈）、struct/union/enum、typedef、浮点、
// `switch`/`goto`、全局变量、字符串字面量、外部符号与变参（printf 在那一片跑通）。
//
// 碰到还没做到的东西**当场报错**，报错文本里带「第六刀」字样 —— 一眼能看出是进度不是
// bug，而且下一片把它做掉时 `gen-bad/` 里那条用例会跟着红，于是「边界移动了」这件事
// 不会悄悄发生（第四刀前半那一节讲过这条纪律）。
//
// oracle 是 `tcc -run` 的**进程退出码** —— `main` 的返回值就是它，于是这条轴完全不需要
// libc。printf 要等外部符号那一片，到那时 oracle 升级成 stdout 逐字节。

import { OmniError } from '../source/diag.js';
import { Cpp } from './tccpp.js';
import {
  TOK_EOF, TOK_IDENT, TOK_UIDENT,
  TOK_CCHAR, TOK_LCHAR, TOK_CINT, TOK_CUINT, TOK_CLLONG, TOK_CULLONG,
  TOK_CLONG, TOK_CULONG, TOK_STR, TOK_LSTR, TOK_CFLOAT, TOK_CDOUBLE, TOK_CLDOUBLE,
  TOK_INC, TOK_DEC, TOK_SHL, TOK_SAR, TOK_LAND, TOK_LOR,
  TOK_EQ, TOK_NE, TOK_LT, TOK_GE, TOK_LE, TOK_GT, TOK_ULE, TOK_UGT,
  TOK_IF, TOK_ELSE, TOK_WHILE, TOK_FOR, TOK_DO, TOK_BREAK, TOK_CONTINUE, TOK_RETURN,
  TOK_SWITCH, TOK_CASE, TOK_DEFAULT, TOK_GOTO, TOK_SIZEOF,
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
  ctype, typeSize, typeText,
  TY_VOID, TY_INT, TY_UINT, TY_LLONG, TY_ULLONG, TY_CHAR, TY_SHORT, TY_BOOL,
} from './ctype.js';
import {
  MirModule, MirFunc, OP, T_VOID, T_I32, T_I64, T_BOOL, REF_NONE,
  CVT_SEXT, CVT_ZEXT, CVT_TRUNC, CVT_SEXT8, CVT_SEXT16,
} from '../mir/ir.js';

/* 单字符记号的码位。写成常量是为了读得出来 —— `this.tok === 40` 谁也认不出是 `(`。 */
const LPAR = 40;
const RPAR = 41;
const LBRACK = 91;
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
 * 一个 C 值。三种形态，对应 tcc 的 `SValue` 里真正带语义的那三格：
 *   - 普通值：`ref` 是产出它的那条 MIR 指令（或常量池的 ref）
 *   - 左值（`VT_LVAL`）：`slot` 是那个局部变量的槽号，`ref` 是 null —— 取值要发 LOAD，
 *     赋值直接发 STORE。**不预先 LOAD** 是有用的：`a = 5` 于是不多出一条没人读的 LOAD。
 *   - 比较（`VT_CMP`，`tccgen.c:1028`）：`ref` 是一个 `T_BOOL`，`cmp` 为真。
 *     当条件用（`if`/`while`/`&&`）就直接用；当整数用才摊成 0/1，见 `gv`。
 */
function sVal(ty, ref) { return { ty, ref, slot: null, cmp: false }; }
function sLval(ty, slot) { return { ty, ref: null, slot, cmp: false }; }
function sCmp(ref) { return { ty: TY_INT, ref, slot: null, cmp: true }; }

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

export class CGen {
  /**
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
    const info = { no, f, defined: false, params: null, ret: TY_INT };
    this.funcs.set(name, info);
    return info;
  }

  /** 声明一个局部变量：占一个槽，登记进最内层作用域。同名遮蔽是 C 的规矩。 */
  declareLocal(name, ty) {
    if (btype(ty.t) === VT_VOID) this.err(`variable '${name}' has void type`);
    const slot = this.f.slot(name, mirTypeOf(ty));
    this.scopes[this.scopes.length - 1].set(name, { slot, ty });
    return slot;
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
   * **不发任何指令** —— 因为窄整数在寄存器里永远是规范形（见文件头那一节）。
   * 无符号的窄类型也一样：`unsigned char` 的取值落在 0..255，当 `int` 读还是同一个数。
   * 这就是那条不变量买到的东西；它也意味着任何产生窄值的地方必须自己收口，
   * 而收口只在 `castTo` 一处。
   */
  promote(v) {
    const b = btype(v.ty.t);
    if (b === VT_BOOL || b === VT_BYTE || b === VT_SHORT) {
      return { ty: TY_INT, ref: v.ref, slot: v.slot, cmp: v.cmp };
    }
    return v;
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
  castTo(v, ty) {
    const f = this.f;
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
    if (target.slot === null) this.err('lvalue expected');
    const cv = this.castTo(v, target.ty);
    const r = this.gv(cv);
    this.f.emit(OP.STORE, T_VOID, r, REF_NONE, target.slot);
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
  genOp(op, a, b) {
    const f = this.f;
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

  /** `unary`（`tccgen.c:5595`）。前缀与后缀都在这儿，与 tcc 一样。 */
  unary() {
    const t = this.tok;

    // 带值的记号：整数与字符常量。`next()` 会毁掉 tokc，所以先取（`tccgen.c:7185`）
    if (tokHasValue(t)) {
      const cv = this.tokc;
      if (t === TOK_CFLOAT || t === TOK_CDOUBLE || t === TOK_CLDOUBLE) {
        this.todo('浮点常量还没到');
      }
      if (t === TOK_STR || t === TOK_LSTR) {
        this.todo('字符串字面量还没到（要 data 段，下一片）');
      }
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
    if (t === STAR || t === AMP) {
      this.todo('指针还没到（`*` 与 `&` 要影子栈，下一片）');
    }
    if (t === TOK_SIZEOF) {
      this.next();
      return this.sizeofExpr();
    }

    if (t >= TOK_UIDENT) {
      const name = this.identName();
      const local = this.lookup(name);
      if (local !== null) return this.postfix(sLval(local.ty, local.slot));
      /* 不是局部变量：那就只能是函数（这一片没有全局变量）。tcc 在这里走
       * `external_global_sym`，我们同样先建符号 —— 但只在紧跟着 `(` 时才算调用，
       * 否则是「取函数地址」，那要指针。 */
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
      if (t === LBRACK) this.todo('下标运算还没到（要数组与指针，下一片）');
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
    if (target.slot === null) this.err('lvalue expected');
    const f = this.f;
    const mt = mirTypeOf(target.ty);
    const old = f.emit(OP.LOAD, mt, REF_NONE, REF_NONE, target.slot);
    const one = sVal(TY_INT, this.mod.consts.i32(1));
    const nv = this.genOp(op, sVal(target.ty, old), one);
    const stored = this.gv(this.castTo(nv, target.ty));
    f.emit(OP.STORE, T_VOID, stored, REF_NONE, target.slot);
    return sVal(target.ty, post ? old : stored);
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
    if (info.params !== null) {
      if (info.params.length !== vals.length) {
        this.err(`too ${vals.length < info.params.length ? 'few' : 'many'} arguments to function '${name}'`);
      }
    }
    const refs = [];
    for (let i = 0; i < vals.length; i++) {
      const want = info.params === null ? this.promote(vals[i]).ty : info.params[i].ty;
      refs.push(this.gv(this.castTo(vals[i], want)));
    }
    if (info.params === null) {
      info.params = vals.map((v, i) => ({ name: `$p${i}`, ty: this.promote(v).ty }));
    }
    const rt = mirTypeOf(info.ret);
    const ref = this.f.emit(OP.CALL, rt, info.no, this.f.pushArgs(refs), 0);
    return sVal(info.ret, ref);
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
    if (v.slot === null) this.err('lvalue expected');
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
          this.f.emit(OP.RET, mirTypeOf(this.funcRet), this.gv(cv), REF_NONE, 0);
        } else {
          if (btype(v.ty.t) !== VT_VOID) this.cpp.warn('void function returns a value');
          this.f.emit(OP.RET, T_VOID, REF_NONE, REF_NONE, 0);
        }
      } else if (hasVal) {
        /* `int f() { return; }` —— tcc 只警告（`tccgen.c:7272`），返回值是垃圾。
         * MIR 要一个值，补 0；这与「垃圾」不同，所以照 tcc 出一条警告。 */
        this.cpp.warn("'return' with no value");
        this.f.emit(OP.RET, mirTypeOf(this.funcRet),
          this.konst(this.funcRet, 0), REF_NONE, 0);
      } else {
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

  /** 当前记号是不是一个类型的开头（tcc 靠 `parse_btype` 试着读一遍来判断）。 */
  isTypeStart(t) {
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
    const setBt = (b) => {
      if (bt !== -1) this.err('two or more data types in declaration specifiers');
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
      if (t === TOK_CONST) { quals = quals | VT_CONSTANT; any = true; this.next(); continue; }
      if (t === TOK_VOLATILE) { quals = quals | VT_VOLATILE; any = true; this.next(); continue; }
      // `auto` / `register` 在这一片没有可观察的效果，吃掉
      if (t === TOK_AUTO || t === TOK_REGISTER) { any = true; this.next(); continue; }
      if (t === TOK_FLOAT || t === TOK_DOUBLE) this.todo('浮点还没到');
      if (t === TOK_STRUCT || t === TOK_UNION) this.todo('struct / union 还没到');
      if (t === TOK_ENUM) this.todo('enum 还没到');
      if (t === TOK_TYPEDEF) this.todo('typedef 还没到');
      break;
    }
    if (!any) this.expect('declaration');

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
   * 类型名（`(int)x` 里那个、`sizeof(long)` 里那个）：基本类型加抽象声明符。
   * 抽象声明符现在只可能是空的 —— 指针与数组是下一片。
   */
  typeName() {
    const ty = this.parseBtype();
    if (this.tok === STAR) this.todo('指针还没到（下一片）');
    if (this.tok === LBRACK) this.todo('数组还没到（下一片）');
    return ty;
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
      const base = this.parseBtype();
      any = true;
      if (this.tok === SEMI) { this.next(); continue; }
      let wasBody = false;
      for (;;) {
        if (this.tok === STAR) this.todo('指针还没到（下一片）');
        const name = this.identName();
        if (this.tok === LPAR) {
          if (this.funcDecl(global, name, base)) { wasBody = true; break; }
        } else if (this.tok === LBRACK) {
          this.todo('数组还没到（下一片）');
        } else if (!global) {
          /* 存储类去掉再登记：`static int x;` 的类型是 `int`，`static` 不是类型的一部分
           * （tcc 靠 `VT_STORAGE` 掩码做同一件事，`tcc.h:1093`）。 */
          const ty = ctype(base.t & ~VT_STORAGE, base.ref);
          const slot = this.declareLocal(name, ty);
          if (this.tok === ASSIGN) {
            this.next();
            /* 初始化式是**赋值表达式**，不是逗号表达式（`int a = 1, b = 2;` 里那个
             * 逗号是声明的分隔符）—— 这一格错了整行都会读歪。 */
            const v = this.exprEq();
            const cv = this.castTo(v, ty);
            this.f.emit(OP.STORE, T_VOID, this.gv(cv), REF_NONE, slot);
          }
        } else {
          this.todo(`全局变量还没到（'${name}'）`);
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
        this.paramList(params);
      }
    } else {
      this.paramList(params);
    }
    return this.finishFunc(global, info, name, ctype(ret.t & ~VT_STORAGE, ret.ref), params);
  }

  paramList(params) {
    for (;;) {
      const pt = this.parseBtype();
      if (this.tok === STAR) this.todo('指针还没到（下一片）');
      if (btype(pt.t) === VT_VOID) this.err('parameter has void type');
      // 形参名可以省（原型里），那就给它一个占位名
      const pn = this.tok >= TOK_UIDENT ? this.identName() : `$p${params.length}`;
      if (this.tok === LBRACK) this.todo('数组形参还没到（下一片）');
      /* 形参**保留声明的类型**（`char c` 就是 char）。「实参提升」（`char` -> `int`）
       * 只对**没有原型**的函数与变参的可变部分成立（C11 6.5.2.2 第 6 段）——
       * 有原型时是**调用方**把实参转成声明的类型，见 funcCall。
       * 这一格搞反过一次：形参提成 int 之后 `int f(char c){return c;}` 里的 c 不再收口，
       * 于是 `f(300)` 回 300 而不是 44。 */
      params.push({ name: pn, ty: ctype(pt.t & ~VT_STORAGE, pt.ref) });
      if (this.tok !== COMMA) break;
      this.next();
    }
    this.skip(RPAR);
  }

  finishFunc(global, info, name, ret, params) {
    if (info.params !== null && info.params.length !== params.length) {
      this.err(`conflicting types for '${name}'`);
    }
    info.params = params;
    info.ret = ret;
    info.f.ret = mirTypeOf(ret);

    if (this.tok !== LBRACE) return false;          // 只是个原型，`;` 交给 decl
    if (!global) this.err('nested function definition');
    if (info.defined) this.err(`redefinition of '${name}'`);
    info.defined = true;

    const f = info.f;
    const outer = this.f;
    this.f = f;
    this.funcRet = ret;
    this.funcName = name;
    this.scopes = [new Map()];
    this.regions = [];
    /* 形参就是前几个槽 —— MIR 的解释器按这个约定填帧（interp.js:274 的注释）。 */
    for (const p of params) {
      const mt = mirTypeOf(p.ty);
      const slot = f.slot(p.name, mt);
      f.params.push({ name: p.name, t: mt, slot });
      this.scopes[0].set(p.name, { slot, ty: p.ty });
    }
    this.block();  // 当前记号是 `{`
    /* 落到函数尾：C 里非 void 函数不 return 是 UB（tcc 让返回值是垃圾）。MIR 要
     * 每条路都有 RET 才良构，所以无条件补一条 —— 前面已经 RET 的路走不到这里。 */
    if (f.ret === T_VOID) f.emit(OP.RET, T_VOID, REF_NONE, REF_NONE, 0);
    else f.emit(OP.RET, f.ret, this.konst(ret, 0), REF_NONE, 0);
    this.f = outer;
    return true;
  }

  /** 一个翻译单元（`tccgen_compile`，`tccgen.c:417-419`）。 */
  unit() {
    this.next();
    while (this.tok !== TOK_EOF) {
      if (!this.decl(true)) this.expect('declaration');
    }
    for (const [name, info] of this.funcs) {
      if (!info.defined) this.err(`undefined symbol '${name}'`);
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

  const info = gen.funcs.get('main');
  if (info === undefined) throw new OmniError(`${path}: error: undefined symbol 'main'`);
  if (info.params !== null && info.params.length !== 0) {
    throw new OmniError(`${path}: error: 第六刀：'int main(argc, argv)' 还没到（要指针）`);
  }
  const entry = new MirFunc('omni_main', [], T_I32);
  mod.addFunc(entry);
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





