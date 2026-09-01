// Omni stage0 — C 的降级器（tinycc `tccgen.c` 的等价物，ADR-0017 第六刀第一片）
//
// 出处纪律同第五刀：**照行为与结构重写，不抄代码**，每条规则旁边注 `tccgen.c:行`。
//
// ## 一遍过，没有 AST
//
// tcc 的 `tccgen.c` 与 `tccpp.c` 是**同一遍**：语法分析器一边从 `next()` 取记号，一边
// 直接发目标码，中间不存在一棵树。这一份照这个结构来：`Cpp` 是记号源，`CGen` 一边解析
// 一边 `f.emit(...)` 往 MIR 里发指令。这是路径 B（`tcc_target.md`：「重点提供和 tinycc
// 完全相同的解析路径」）；路径 A 的 GLR 文法是第七步的事，两条路要能互相对账。
//
// ## 三处刻意的偏离（与第五刀的「记号流表示」同一性质）
//
// 1. **没有 `vtop` 值栈。** tcc 的 `SValue` 栈存在的理由是**延迟寄存器分配**：一个值
//    可能还在常量里、还在内存里、还是一个待求值的比较，`gv(rc)` 才把它塞进寄存器。
//    MIR 没有寄存器 —— 一条指令的 ref **就是**那个值，SSA 形式本身就是「延迟」。
//    所以解析函数**返回值**（一个 `SVal` 记录），不往全局栈上压。保留的只有真正带
//    语义的那两格：`VT_LVAL`（左值，`gv` 时才发 LOAD）与 `VT_CMP`（比较结果不急着
//    变成 0/1，`tccgen.c:1028` 的 `vset_VT_CMP`）—— 它们不是寄存器分配的产物，
//    丢掉会让 `if (a < b)` 多出一次「变成整数再与 0 比」。
//
// 2. **控制流是结构化的，不是跳转加回填。** tcc 用 `gjmp()` 发一条待回填的跳转、
//    `gsym()` 回填（`tccgen.c:167`）。MIR 只有 wasm 那套区域标记（BLOCK/LOOP/IF/END
//    加往外数的层数），指令**不能重排、不能回填**。于是：
//      - `if` / `while` / `do` 的形状照 `mir/from_oir.js` 已经钉好的那几套（同一套层数
//        语义，两个降级器发一样的形状，读代码的人只需要记一份）；
//      - `for` 的步进式在源码里写在循环体前、要在循环体后执行，只能**先把记号收起来、
//        循环体之后再放一遍**（`Cpp.captureTokens`）。这是 MIR 换来的代价，明写在这儿。
//
// 3. **不折常量。** tcc 的 `gen_opic`（`tccgen.c:2600` 一带）在解析时就把
//    `1+2*3` 算成 7，因为它要发机器码、少一条就是少一条。这里不折：MIR 的两个消费者
//    （闭包解释器与 LLVM）本来就会折，而折叠是**语义可见**的（`1/0` 折了就成编译期
//    错误、不折就是运行期错误）。第一片先不折，把这一格记在这儿。
//
// ## 这一片做到哪儿（**是路标，不是终点**）
//
// 终点是「能编译 tinycc 自己的全部源码」，所以 printf、指针、struct、变参、`setjmp`
// 一个都躲不过去 —— 下面这些不是「刻意不做」，是**还没做到那一片**。分片顺序与理由写在
// ADR-0017「第六刀第一片」的落地节里，一句话：按解锁能力排，不按语法书的章节排。
//
// 这一片：类型只有 `int`（MIR 的 `T_I32`）与 `void`；函数（互相递归随便）、局部变量、
// 整型表达式（C 的全部优先级）、`if/else`、`while`、`do`、`for`、`break`、`continue`、
// `return`。碰到还没做到的东西**当场报错**，报错文本里带「第六刀」字样 ——
// 一眼能看出是进度不是 bug，而且下一片把它做掉时，`gen-bad/` 里那条用例会跟着红，
// 于是「边界移动了」这件事不会悄悄发生（第四刀前半那一节讲过这条纪律）。
//
// 这一片的 oracle 是 `tcc -run` 的**进程退出码** —— `main` 的返回值就是它，于是这条轴
// 完全不需要 libc。printf 要等第 5 片（外部符号 + 变参 + 解释器的 libc 垫片），
// 到那时 oracle 升级成 stdout 逐字节。


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
  TOK_INT, TOK_VOID, TOK_SIGNED, TOK_UNSIGNED, TOK_CHAR, TOK_SHORT, TOK_LONG,
  TOK_FLOAT, TOK_DOUBLE, TOK_STRUCT, TOK_UNION, TOK_ENUM, TOK_TYPEDEF,
  TOK_EXTERN, TOK_STATIC, TOK_CONST, TOK_REGISTER, TOK_AUTO, TOK_VOLATILE, TOK_INLINE,
  isAssignOp, assignOpOf,
} from './tcctok.js';
import {
  MirModule, MirFunc, OP, T_VOID, T_I32, T_BOOL, REF_NONE,
} from '../mir/ir.js';

/* 单字符记号的码位。写成常量是为了读得出来 —— `this.tok === 40` 谁也认不出是 `(`。 */
const LPAR = 40;
const RPAR = 41;
const LBRACE = 123;
const RBRACE = 125;
const SEMI = 59;
const COMMA = 44;
const COLON = 58;
const QUEST = 63;
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

/** C 类型（这一片只有两个）。做成数字是为了往后能长成 tcc 的 `CType.t` 位域。 */
const CT_VOID = 0;
const CT_INT = 1;

/** 带值的记号（`TOK_HAS_VALUE`，`tcc.h:1189`）：`TOK_CCHAR <= t <= TOK_LINENUM`。 */
function tokHasValue(t) {
  return t >= TOK_CCHAR && t <= TOK_CLDOUBLE;
}

/**
 * 一个 C 值。三种形态，对应 tcc 的 `SValue` 里真正带语义的那三格：
 *   - 普通值：`ref` 是产出它的那条 MIR 指令（或常量池的 ref）
 *   - 左值（`VT_LVAL`）：`slot` 是那个局部变量的槽号，`ref` 是 null —— 取值要发 LOAD，
 *     赋值直接发 STORE。**不预先 LOAD** 是有用的：`a = 5` 于是不多出一条没人读的 LOAD。
 *   - 比较（`VT_CMP`，`tccgen.c:1028`）：`ref` 是一个 `T_BOOL`，`cmp` 为真。
 *     当条件用（`if`/`while`/`&&`）就直接用；当整数用才摊成 0/1，见 `gv`。
 */
function sVal(ct, ref) { return { ct, ref, slot: null, cmp: false }; }
function sLval(ct, slot) { return { ct, ref: null, slot, cmp: false }; }
function sCmp(ref) { return { ct: CT_INT, ref, slot: null, cmp: true }; }

/**
 * 二元运算符的记号 -> MIR 的 op。`null` 表示这是**比较**（结果是 bool，要走 sCmp）。
 * 只列这一片支持的：有符号 int 的那一套。
 */
function binOpOf(t) {
  if (t === PLUS) return OP.ADD;
  if (t === MINUS) return OP.SUB;
  if (t === STAR) return OP.MUL;
  if (t === SLASH) return OP.DIV;
  if (t === PERCENT) return OP.MOD;
  if (t === AMP) return OP.BAND;
  if (t === PIPE) return OP.BOR;
  if (t === CARET) return OP.BXOR;
  if (t === TOK_SHL) return OP.SHL;
  if (t === TOK_SAR) return OP.SHR;
  return null;
}

function cmpOpOf(t) {
  if (t === TOK_EQ) return OP.EQ;
  if (t === TOK_NE) return OP.NE;
  if (t === TOK_LT) return OP.LT;
  if (t === TOK_GE) return OP.GE;
  if (t === TOK_LE) return OP.LE;
  if (t === TOK_GT) return OP.GT;
  return null;
}

/**
 * 优先级表（`tccgen.c:6506-6524` 的 `precedence`）。数字**照抄** —— 它们是
 * `expr_infix` 的唯一输入，改一个数就是改一门语言的结合性。
 * tcc 那边把关系运算符写成两段（`TOK_ULT/TOK_UGE` 与 `TOK_ULE..TOK_GT` 的区间），
 * 是因为无符号那几个的编号插在中间；这一片没有无符号，但区间照原样判，
 * 省得第二片补无符号时又要动这一处。
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

    /** @type {MirFunc|null} 正在生成的函数（tcc 的 `cur_text_section` + `func_ind`） */
    this.f = null;
    this.funcRet = CT_VOID;
    this.funcName = '';
    /** @type {Map<string,{slot:number,ct:number}>[]} 作用域栈（tcc 的 `local_stack`） */
    this.scopes = [];
    /** @type {string[]} 区域标签栈：BR 的层数按它算，与 from_oir 同一套记账 */
    this.regions = [];
    /** @type {Map<string,{no:number,f:MirFunc,defined:boolean,nparams:number,ret:number}>} */
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
    const info = { no, f, defined: false, nparams: -1, ret: CT_INT };
    this.funcs.set(name, info);
    return info;
  }

  /** 声明一个局部变量：占一个槽，登记进最内层作用域。同名遮蔽是 C 的规矩。 */
  declareLocal(name, ct) {
    if (ct === CT_VOID) this.err(`variable '${name}' has void type`);
    const slot = this.f.slot(name, T_I32);
    this.scopes[this.scopes.length - 1].set(name, { slot, ct });
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

  /** 往外数第几层能找到这个标签（0 = 最内层）。找不到就是 `break` 在循环外。 */
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

  /* ---------------------------------------------------------------- 取值
   * `gv` 与 `gvtst` 的等价物（`tccgen.c:1844` / `gvtst`）。两条路的分工：
   *   gv   —— 「我要一个整数」：左值发 LOAD，比较摊成 0/1
   *   gtst —— 「我要一个条件」：比较原样用，整数变成「!= 0」
   * 分成两条正是 tcc 保留 `VT_CMP` 的全部收益：`if (a < b)` 一条比较就够。 */

  gv(v) {
    if (v.slot !== null) return this.f.emit(OP.LOAD, T_I32, REF_NONE, REF_NONE, v.slot);
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
    if (v.ct === CT_VOID) this.err('void value not ignored as it ought to be');
    return v.ref;
  }

  gtst(v) {
    if (v.cmp) return v.ref;
    return this.f.emit(OP.NE, T_I32, this.gv(v), this.mod.consts.i32(0), 0);
  }

  /** 「我要 0 或 1」：`&&` / `||` 的结果与 `!` 之后再当数用的地方都要它。 */
  gvBool(v) {
    return this.gv(sCmp(this.gtst(v)));
  }

  /** 把一个值存进左值（`vstore`，`tccgen.c:3690`）。赋值表达式的值是被赋的那个值。 */
  vstore(target, v) {
    if (target.slot === null) this.err('lvalue expected');
    const r = this.gv(v);
    this.f.emit(OP.STORE, T_VOID, r, REF_NONE, target.slot);
    return sVal(target.ct, r);
  }

  /* ------------------------------------------------------------ 表达式 */

  /**
   * `gen_op`（`tccgen.c:3042`）的这一片：两个 `int`。
   * 比较**不摊平**，回一个 `VT_CMP` 值 —— 这一条是 tcc 那边整个 `vset_VT_CMP` 机制
   * 的用处所在。
   */
  genOp(op, a, b) {
    const cmp = cmpOpOf(op);
    if (cmp !== null) {
      /* 比较指令的 `t` 是**操作数**的类型（ir.js:187），结果永远是 bool。 */
      return sCmp(this.f.emit(cmp, T_I32, this.gv(a), this.gv(b), 0));
    }
    const mop = binOpOf(op);
    if (mop === null) this.err(`internal: binary operator ${this.cpp.tokStr(op, null)}`);
    return sVal(CT_INT, this.f.emit(mop, T_I32, this.gv(a), this.gv(b), 0));
  }

  /** `unary`（`tccgen.c:5595`）。前缀与后缀都在这儿，与 tcc 一样。 */
  unary() {
    const t = this.tok;

    // 带值的记号：整数与字符常量。`next()` 会毁掉 tokc，所以先取（`tccgen.c:7185`）
    if (tokHasValue(t)) {
      const cv = this.tokc;
      if (t === TOK_CINT || t === TOK_CUINT || t === TOK_CLLONG || t === TOK_CULLONG
        || t === TOK_CLONG || t === TOK_CULONG || t === TOK_CCHAR) {
        this.next();
        /* `int` 是 32 位，字面量按两补收口到 32 位有符号 —— 这就是 T_I32 的规范形。 */
        const n = BigInt.asIntN(32, /** @type {bigint} */ (cv));
        return this.postfix(sVal(CT_INT, this.mod.consts.i32(n)));
      }
      if (t === TOK_CFLOAT || t === TOK_CDOUBLE || t === TOK_CLDOUBLE) {
        this.err('第六刀第一片只有 int：浮点常量还没到');
      }
      if (t === TOK_STR || t === TOK_LSTR) {
        this.err('第六刀第一片没有字符串常量（要线性内存里的 data 段，第二片）');
      }
      if (t === TOK_LCHAR) this.err('第六刀第一片没有宽字符常量');
      this.err('internal: token with value has no handler');
    }

    if (t === LPAR) {
      this.next();
      /* 强制转换 `(int)x` 与括号表达式在这儿分岔（`tccgen.c:5620`）。这一片只有
       * `(int)`，而 `(int)` 在 int 上是恒等，所以认出来直接吃掉。 */
      if (this.isTypeStart(this.tok)) {
        const ct = this.parseBtype();
        this.skip(RPAR);
        const v = this.unary();
        if (ct === CT_VOID) return sVal(CT_VOID, REF_NONE);
        return sVal(CT_INT, this.gv(v));
      }
      const v = this.gexpr();
      this.skip(RPAR);
      return this.postfix(v);
    }

    if (t === PLUS) { this.next(); return sVal(CT_INT, this.gv(this.unary())); }
    if (t === MINUS) {
      this.next();
      return sVal(CT_INT, this.f.emit(OP.NEG, T_I32, this.gv(this.unary()), REF_NONE, 0));
    }
    if (t === TILDE) {
      this.next();
      return sVal(CT_INT, this.f.emit(OP.BNOT, T_I32, this.gv(this.unary()), REF_NONE, 0));
    }
    if (t === BANG) {
      /* `!x` 就是 `x == 0`（`tccgen.c:5720` 一带走的也是比较那条路）。于是
       * `if (!x)` 一条 EQ 就够，不必先把 x 变成 bool 再取反。 */
      this.next();
      const v = this.unary();
      return sCmp(this.f.emit(OP.EQ, T_I32, this.gv(v), this.mod.consts.i32(0), 0));
    }
    if (t === TOK_INC || t === TOK_DEC) {
      // `++x` = `x += 1`（`tccgen.c:5680`：inc(0, tok)）
      this.next();
      const target = this.unary();
      return this.incdec(target, t === TOK_INC ? PLUS : MINUS, false);
    }
    if (t === STAR || t === AMP) {
      this.err('第六刀第一片没有指针（`*` 与 `&` 要影子栈，第二片）');
    }
    if (t === TOK_SIZEOF) {
      this.err('第六刀第一片没有 sizeof（它要一张完整的类型表）');
    }

    if (t >= TOK_UIDENT) {
      const name = this.identName();
      const local = this.lookup(name);
      if (local !== null) return this.postfix(sLval(local.ct, local.slot));
      /* 不是局部变量：那就只能是函数（这一片没有全局变量）。tcc 在这里会走
       * `external_global_sym`，我们同样先建符号 —— 但只在紧跟着 `(` 时才算调用，
       * 否则是「取函数地址」，那要指针，属于边界。 */
      if (this.tok !== LPAR) {
        this.err(`第六刀第一片只认「函数名紧跟 (」：'${name}' 不是局部变量`);
      }
      return this.postfix(this.funcCall(name));
    }

    if (t < TOK_IDENT) this.expect('expression');
    // 关键字落到这儿：`int` 之类出现在表达式位置
    this.err(`unexpected keyword '${this.cpp.tokStr(t, null)}' in expression`);
    return sVal(CT_VOID, REF_NONE);
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
      if (t === LPAR) this.err('第六刀第一片只能调用有名字的函数（函数指针是后面的事）');
      if (t === 91) this.err('第六刀第一片没有下标运算（要数组与指针）');
      if (t === 46 || t === 0xa0) this.err('第六刀第一片没有 struct');
      return cur;
    }
  }

  /**
   * `inc`（`tccgen.c:3863`）：`++x` / `x++`。
   * 后缀的值是**旧值**，所以要先把旧值取出来存住 —— tcc 靠 vdup + vrott 在值栈上
   * 倒腾，这里就是一条 LOAD 加一个临时槽。
   */
  incdec(target, op, post) {
    if (target.slot === null) this.err('lvalue expected');
    const old = this.f.emit(OP.LOAD, T_I32, REF_NONE, REF_NONE, target.slot);
    const mop = op === PLUS ? OP.ADD : OP.SUB;
    const nv = this.f.emit(mop, T_I32, old, this.mod.consts.i32(1), 0);
    this.f.emit(OP.STORE, T_VOID, nv, REF_NONE, target.slot);
    return sVal(target.ct, post ? old : nv);
  }

  /** 调用：`名字 ( 实参… )`。名字已经吃掉，当前记号是 `(`。 */
  funcCall(name) {
    const info = this.funcSym(name);
    this.skip(LPAR);
    const refs = [];
    if (this.tok !== RPAR) {
      for (;;) {
        refs.push(this.gv(this.exprEq()));
        if (this.tok !== COMMA) break;
        this.next();
      }
    }
    this.skip(RPAR);
    /* 形参个数：声明过就核对（tcc 在 `gfunc_param_typed` 那一路做同样的事）。
     * 没声明过（先调用后定义）就记下来，定义时反过来核对。 */
    if (info.nparams >= 0 && info.nparams !== refs.length) {
      this.err(`too ${refs.length < info.nparams ? 'few' : 'many'} arguments to function '${name}'`);
    }
    const rt = info.ret === CT_VOID ? T_VOID : T_I32;
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
   * 结果类型是 C 的 `int`（0 或 1），所以槽是 T_I32 —— 而不是 bool。
   * 这一格错过一次的后果是 `x = a && b` 存进去一个 bool，MIR 的 verifier 不查，
   * 但 LLVM 那条腿会发 `store i1` 到 i32 的槽上。
   */
  exprLandor(op, left) {
    const f = this.f;
    const slot = this.temp(T_I32, op === TOK_LAND ? 'land' : 'lor');
    let acc = left;
    /* 一层一层套 IF：`a && b && c` 是 `if (a) { if (b) { slot = c!=0 } }`。
     * 套的层数就是运算符个数，所以先数出来，最后一次性关掉。 */
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
    return sVal(CT_INT, f.emit(OP.LOAD, T_I32, REF_NONE, REF_NONE, slot));
  }

  /** `expr_cond`（`tccgen.c:6608`）：`? :`。同样落在临时槽上。 */
  exprCond() {
    const v = this.exprLor();
    if (this.tok !== QUEST) return v;
    this.next();
    const f = this.f;
    const c = this.gtst(v);
    const slot = this.temp(T_I32, 'sel');
    this.open(OP.IF, 'if', c);
    const a = this.gexpr();
    f.emit(OP.STORE, T_VOID, this.gv(a), REF_NONE, slot);
    this.elseHalf();
    this.skip(COLON);
    const b = this.exprCond();
    f.emit(OP.STORE, T_VOID, this.gv(b), REF_NONE, slot);
    this.close();
    return sVal(CT_INT, f.emit(OP.LOAD, T_I32, REF_NONE, REF_NONE, slot));
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
      const hasVal = this.funcRet !== CT_VOID;
      if (this.tok !== SEMI) {
        const v = this.gexpr();
        if (hasVal) this.f.emit(OP.RET, T_I32, this.gv(v), REF_NONE, 0);
        else this.f.emit(OP.RET, T_VOID, REF_NONE, REF_NONE, 0);
      } else if (hasVal) {
        /* `int f() { return; }` —— tcc 只警告（`tccgen.c:7272`），返回值是垃圾。
         * MIR 要一个值，补 0；这与「垃圾」不同，所以照 tcc 出一条警告。 */
        this.cpp.warn("'return' with no value");
        this.f.emit(OP.RET, T_I32, this.mod.consts.i32(0), REF_NONE, 0);
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
      this.err('第六刀第一片没有 switch（MIR 有 BRTABLE 了，密集化是第三片的事）');
    }
    if (t === TOK_GOTO) this.err('第六刀第一片没有 goto（结构化控制流下它要另一套办法）');

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
      if (!this.decl(false)) {
        this.gexpr();
        this.skip(SEMI);
      }
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
      // captureTokens 停在 `)` 上，此时 this.tok 还是收之前那个 —— 同步一下
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
    if (this.tok !== TOK_EOF) this.err("internal: for 的步进式没读完");
    this.cpp.endMacro();
    this.cpp.tok = savedTok;
    this.cpp.tokc = savedVal;
    this.tok = savedTok;
    this.tokc = savedVal;
  }

  /* -------------------------------------------------------------- 声明 */

  /** 当前记号是不是一个类型的开头（tcc 靠 `parse_btype` 试着读一遍来判断）。 */
  isTypeStart(t) {
    return t === TOK_INT || t === TOK_VOID || t === TOK_SIGNED || t === TOK_UNSIGNED
      || t === TOK_CHAR || t === TOK_SHORT || t === TOK_LONG || t === TOK_FLOAT
      || t === TOK_DOUBLE || t === TOK_STRUCT || t === TOK_UNION || t === TOK_ENUM
      || t === TOK_TYPEDEF || t === TOK_EXTERN || t === TOK_STATIC || t === TOK_CONST
      || t === TOK_REGISTER || t === TOK_AUTO || t === TOK_VOLATILE || t === TOK_INLINE;
  }

  /**
   * `parse_btype`（`tccgen.c:4711` 一带）的这一片：只认 `int` / `void`，
   * 加上几个**不改类型**的限定符与存储类。见得到但没做的每一个都当场报边界。
   */
  parseBtype() {
    let ct = -1;
    for (;;) {
      const t = this.tok;
      if (t === TOK_INT) {
        if (ct === CT_VOID) this.err('two or more data types in declaration');
        ct = CT_INT;
        this.next();
        continue;
      }
      if (t === TOK_VOID) {
        if (ct !== -1) this.err('two or more data types in declaration');
        ct = CT_VOID;
        this.next();
        continue;
      }
      if (t === TOK_SIGNED) {
        // `signed` 单独出现也是 int
        if (ct === -1) ct = CT_INT;
        this.next();
        continue;
      }
      // 不改类型的那些：吃掉。`static` 在这一片没有可观察的效果（没有全局变量，
      // 函数也全在一个模块里），所以吃掉是对的，不是偷懒。
      if (t === TOK_CONST || t === TOK_VOLATILE || t === TOK_REGISTER || t === TOK_AUTO
        || t === TOK_EXTERN || t === TOK_STATIC || t === TOK_INLINE) {
        this.next();
        continue;
      }
      if (t === TOK_UNSIGNED || t === TOK_CHAR || t === TOK_SHORT || t === TOK_LONG
        || t === TOK_FLOAT || t === TOK_DOUBLE) {
        this.err(`第六刀第一片只有 int 与 void：'${this.cpp.tokStr(t, null)}' 还没到`);
      }
      if (t === TOK_STRUCT || t === TOK_UNION || t === TOK_ENUM || t === TOK_TYPEDEF) {
        this.err(`第六刀第一片没有 '${this.cpp.tokStr(t, null)}'`);
      }
      break;
    }
    if (ct === -1) this.expect('declaration');
    return ct;
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
        if (this.tok === STAR) this.err('第六刀第一片没有指针');
        const name = this.identName();
        if (this.tok === LPAR) {
          if (this.funcDecl(global, name, base)) { wasBody = true; break; }
        } else if (!global) {
          const slot = this.declareLocal(name, base);
          if (this.tok === ASSIGN) {
            this.next();
            /* 初始化式是**赋值表达式**，不是逗号表达式（`int a = 1, b = 2;` 里那个
             * 逗号是声明的分隔符）—— 这一格错了整行都会读歪。 */
            const v = this.exprEq();
            this.f.emit(OP.STORE, T_VOID, this.gv(v), REF_NONE, slot);
          }
        } else {
          this.err(`第六刀第一片没有全局变量（'${name}'）`);
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
    /** @type {{name:string,ct:number}[]} */
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
    return this.finishFunc(global, info, name, ret, params);
  }

  paramList(params) {
    for (;;) {
      const pt = this.parseBtype();
      if (this.tok === STAR) this.err('第六刀第一片没有指针');
      if (pt === CT_VOID) this.err('parameter has void type');
      // 形参名可以省（原型里），那就给它一个占位名
      const pn = this.tok >= TOK_UIDENT ? this.identName() : `$p${params.length}`;
      params.push({ name: pn, ct: pt });
      if (this.tok !== COMMA) break;
      this.next();
    }
    this.skip(RPAR);
  }

  finishFunc(global, info, name, ret, params) {
    if (info.nparams >= 0 && info.nparams !== params.length) {
      this.err(`conflicting types for '${name}'`);
    }
    info.nparams = params.length;
    info.ret = ret;
    info.f.ret = ret === CT_VOID ? T_VOID : T_I32;

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
      const slot = f.slot(p.name, T_I32);
      f.params.push({ name: p.name, t: T_I32, slot });
      this.scopes[0].set(p.name, { slot, ct: p.ct });
    }
    this.block();  // 当前记号是 `{`
    /* 落到函数尾：C 里非 void 函数不 return 是 UB（tcc 让返回值是垃圾）。MIR 要
     * 每条路都有 RET 才良构，所以无条件补一条 —— 前面已经 RET 的路走不到这里。 */
    if (f.ret === T_VOID) f.emit(OP.RET, T_VOID, REF_NONE, REF_NONE, 0);
    else f.emit(OP.RET, T_I32, this.mod.consts.i32(0), REF_NONE, 0);
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
  if (info.nparams !== 0) {
    throw new OmniError(`${path}: error: 第六刀第一片只认 'int main(void)'（argc/argv 要指针）`);
  }
  const entry = new MirFunc('omni_main', [], T_I32);
  mod.addFunc(entry);
  if (info.ret === CT_VOID) {
    entry.emit(OP.CALL, T_VOID, info.no, entry.pushArgs([]), 0);
    entry.emit(OP.RET, T_I32, mod.consts.i32(0), REF_NONE, 0);
  } else {
    const v = entry.emit(OP.CALL, T_I32, info.no, entry.pushArgs([]), 0);
    entry.emit(OP.RET, T_I32, v, REF_NONE, 0);
  }
  return { mod, warnings: cpp.warnings };
}
