// Omni stage0 — C 的词法与预处理器（tinycc `tccpp.c` 的**行为**等价物）
//
// ADR-0017 第五刀。出处纪律与 asy 那条线相同：**照着行为与结构重写，不抄代码**，
// 每条规则在实现旁边注明 `tccpp.c:行` 作为出处。tcc 的二进制只当 oracle 用
// （`tcc -E -P` 的输出逐字节比对，见 `tests/c/`），不进产物、不进仓库。
//
// ## 为什么形状要照 tcc 抄，而不是「写一个干净的预处理器」
//
// C 的预处理不是一层独立的文本变换 —— 它与词法是**同一遍**：`#include` 会换掉输入流，
// `##` 粘出来的字节要**重新过一遍词法**（`tccpp.c:3139`），`(a)*b` 那类歧义要靠符号表，
// 而函数式宏要跨行去找它的 `(`（`tccpp.c:3163` 的 peek_file）。把它拆成「先展开成文本、
// 再词法」的两遍，上面每一条都会错，而且错得很难查。所以这里的结构与 tcc 一样：
// 一个 `nextNomacro()` 出记号，一个 `next()` 在它上面套宏展开，指令由词法器在行首
// 看见 `#` 时**回调**进 `preprocess()`（`tccpp.c:2622-2631`）。
//
// ## 记号流的表示：这里与 tcc 有一处刻意的不同
//
// tcc 把记号流存成一个 `int` 数组，带值的记号（`TOK_PPNUM`/`TOK_PPSTR`/…）把值**变宽
// 编码**在后面几格里（`tccpp.c:1079-1139` 的 tok_str_add2），于是「下一个记号在哪儿」
// 要靠 `tok_size()` 算。那是 C 里没有更好选择时的做法。
//
// 这里用**两个等长的平行数组**（`toks[i]` 与 `vals[i]`）：下标就是记号序号，没有变宽解码。
// 代价是每个不带值的记号多占一格 `null`；换来的是所有「往前看第 n 个记号」的地方
// （`##` 的处理、实参切分、`#` 后面跟的是不是形参）都变成一次数组下标，而在 tcc 那边
// 每一处都得先 `while ((t2 = ptr[n]) == ' ') ++n` 地摸过去。语义上两者等价。
//
// ## 阶段边界（刻意的，全部报错而不是给错答案）
//
// - **`__DATE__` / `__TIME__` 也认了**（第一百〇三片，`tccpp.c:3378-3393`）：每次展开现读
//   一次时钟，格式是 tcc 那两句 `snprintf` 的原样。值随时钟走，所以逐字节比对的门里不能
//   有它们 —— 与 tcc 比的是「日期那一串相同、时间差在几秒内」（`tests/c/datetime.js`）。
//   `__LINE__` / `__FILE__` / `__COUNTER__` 也都认。
// - **系统头目录有两段**（第八十八片，与 tcc 的 `sysinclude_paths` 同一形状）：
//   自带那一份在前 —— `src/include/`，对着 tcc 的 `{B}/include`；本机 SDK 的
//   `/usr/include` 在后（tcc 那边是 configure 时用 `xcrun --show-sdk-path` 定死的，
//   我们第一次用的时候找一次记下来，见 cli.js 的 `sdkUsrInclude`）。
//   自带那一份里只有**编译器必须自己给**的那四份
//   `stddef.h` / `stdarg.h` / `stdbool.h` / `float.h`（与 tcc 自带的一一对应）。
//   `stdio.h` / `stdlib.h` / `string.h` / `ctype.h` / `errno.h` 曾经也在这儿（第八刀
//   第三片的最小子集，声明的正好是 `interp/libc.js` 那张表里有的），第八十九片**删了**：
//   SDK 那几份从头到尾都能用，自带的那几份只会挡着它们。
//   搜索顺序照 tcc：`-isystem` 在这两段前头，`-I` 在最前，`-nostdinc` 把这两段一起掐掉。
//   都找不到就报 `include file '...' not found`（与 tcc 同一句）。
//   **预定义的宏也有了**（第八刀第一片，见 tccdefs.js）：`__aarch64__`、
//   `__SIZE_TYPE__`、`_Nonnull` 那五十条，顺序与值都对着 `tcc -dM -E` 抄的。
// - **`#if` 里只有整数**：`'a'` 那类字符常量认（值按 signed char 算，量过 tcc 在本机
//   是这样），字符串与浮点按 tcc 的规矩报 `invalid constant in preprocessor expression`。
// - **三字母词（trigraph）不认** —— tcc 也不认，这一格不是我们的边界。
// - **`#pragma`**：`once` / `push_macro` / `pop_macro` 认；其余**原样印回输出**
//   （`tccpp.c:1688-1694`：`tcc -E` 下未知 pragma 不消失，它是给后面的编译器看的）。

import { OmniError } from '../source/diag.js';
import {
  TOK_LAND, TOK_LOR, TOK_EQ, TOK_NE, TOK_LE, TOK_GE, TOK_LT, TOK_GT,
  TOK_DEC, TOK_INC, TOK_SHL, TOK_SAR,
  TOK_ARROW, TOK_DOTS, TOK_TWOSHARPS, TOK_PLCHLDR,
  TOK_A_ADD, TOK_A_SUB, TOK_A_MUL, TOK_A_DIV, TOK_A_MOD,
  TOK_A_AND, TOK_A_OR, TOK_A_XOR, TOK_A_SHL, TOK_A_SAR,
  TOK_CCHAR, TOK_LCHAR, TOK_CINT, TOK_CUINT, TOK_CLLONG, TOK_CULLONG,
  TOK_STR, TOK_LSTR, TOK_CFLOAT, TOK_CDOUBLE, TOK_CLDOUBLE, TOK_PPNUM, TOK_PPSTR,
  TOK_EOF, TOK_LINEFEED, TOK_IDENT, SYM_FIELD, TOK_PPJOIN, TOK_LINENUM,
  MACRO_OBJ, MACRO_FUNC, MACRO_JOIN, TOK_TWO_CHARS, IDENT_NAMES,
  TOK_DEFINE, TOK_INCLUDE, TOK_INCLUDE_NEXT, TOK_IFDEF, TOK_IFNDEF, TOK_ELIF,
  TOK_ENDIF, TOK_DEFINED, TOK_UNDEF, TOK_ERROR, TOK_WARNING, TOK_LINE, TOK_PRAGMA,
  TOK_IF, TOK_ELSE, TOK_WHILE, TOK_DO, TOK___LINE__, TOK___FILE__, TOK___DATE__, TOK___TIME__,
  TOK___VA_ARGS__, TOK___COUNTER__, TOK___HAS_INCLUDE, TOK___HAS_INCLUDE_NEXT,
  TOK_push_macro, TOK_pop_macro, TOK_once,
  TOK_pack, TOK_push, TOK_pop,
} from './tcctok.js';
import {
  predefs, COMPILE_DEFS,
} from './tccdefs.js';
// `__DATE__` / `__TIME__` 的时钟。走宿主 op 而不是 `new Date()` —— 见下面那一段。
import { localStamp } from '../host/native.js';

const CH_EOF = -1;
const SPC = 32; // ' '
const TAB = 9;
const LF = 10;

/** `__DATE__` 里的月份缩写，抄 `tccpp.c:3384` 那张 `ab_month_name`。 */
const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/* ------------------------------------------------- 字符分类
 * tcc 建了一张 `isidnum_table`（`tccpp.c:3693-3702`）：CH_EOF..127 按 is_space/isid/isnum
 * 分三类，**128..255 全算 IS_ID**（于是 UTF-8 的标识符按字节就能过）。这里读的是 JS 字符串，
 * 所以「>= 0x80 算标识符字符」是同一条规则在码位上的说法。 */

/** 空白，**不含换行** —— 这一条是 `tcc.h:1411` 的原话，而它决定了 -E 的输出里换行不会被吞。 */
function isSpaceCh(c) {
  return c === SPC || c === TAB || c === 11 || c === 12 || c === 13;
}
function isIdCh(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c >= 0x80;
}
function isNumCh(c) {
  return c >= 48 && c <= 57;
}
function isOctCh(c) {
  return c >= 48 && c <= 55;
}
function isIdNum(c) {
  return isIdCh(c) || isNumCh(c);
}
function toup(c) {
  return c >= 97 && c <= 122 ? c - 32 : c;
}

/**
 * 一段记号流（tcc 的 `TokenString`，`tcc.h:656`）。
 * `needSpc` 是 tcc 那个三态标记（`tccpp.c:1156`）：位 1 = 刚吃掉了空白，
 * 位 2 = 已经放过一个记号。两位都有（== 3）时下一个记号前补一个空格 ——
 * 于是「一串空白折成一个空格」和「开头的空白不算」都是同一条规则的推论。
 */
class TokStr {
  constructor() {
    /** @type {number[]} */
    this.toks = [];
    /** @type {(string|bigint|number|null)[]} 与 toks 等长，见文件头「记号流的表示」 */
    this.vals = [];
    this.needSpc = 0;
    /** `tok_str_add_tok` 记的「上一次记下的行号」（`tccpp.c:1147`）。0 = 一条都还没记。 */
    this.lastLine = 0;
  }

  add(t) {
    this.toks.push(t);
    this.vals.push(null);
  }

  add2(t, v) {
    this.toks.push(t);
    this.vals.push(v);
  }

  /**
   * `tok_str_add_tok`（`tccpp.c:1142`）：**带行号**地记一个记号。
   *
   * 行号与上一次记的不一样，就先塞一条 `TOK_LINENUM` 进去 —— 放回来的时候 `next()`
   * 见到它就把 `file.lineNum` 拨回去（`tccpp.c:3478`）。收起来再放一遍的那几路
   * （函数体、`for` 的步进式、`switch` 的体）全靠这条线把诊断的行号带回原处；
   * 没有它，重放期间报的每一个错都会指到那一段的**末尾**。
   */
  addTok(t, v, line) {
    if (line !== this.lastLine) {
      this.lastLine = line;
      this.add2(TOK_LINENUM, line);
    }
    this.add2(t, v);
  }

  /** `tok_str_add2_spc`（`tccpp.c:1156`） */
  add2Spc(t, v) {
    if (this.needSpc === 3) this.add(SPC);
    this.needSpc = 2;
    this.add2(t, v);
  }

  len() {
    return this.toks.length;
  }
}

/** 一个输入文件（tcc 的 `BufferedFile`，`tcc.h:634`）。include 靠 `prev` 串成栈。 */
class CFile {
  constructor(filename, text, prev) {
    this.filename = filename;
    /** `#line "别名"` 会改掉 filename；真正打开的那个路径要留着 —— include 的
     *  「当前文件所在目录」与相对的 `#line` 都按它算（tcc 的 `true_filename`） */
    this.trueFilename = filename;
    this.text = text;
    this.pos = 0;
    this.lineNum = 1;
    /** 上一次印过行标时的行号（tcc 的 `line_ref`，`BufferedFile` 是 calloc 出来的所以起手 0）。
     *  `pp_line` 拿 `lineNum - lineRef` 决定是补几个换行还是印一行行标。 */
    this.lineRef = 0;
    this.prev = prev;
    /** 进这个文件时 ifdef 栈的深度：`#endif` 少了一个就要在文件末尾报错（`tccpp.c:2580`） */
    this.ifdefBase = 0;
    /** 「整个文件被一个 #ifndef 包着」的守卫名，0 = 没有（`tccpp.c:1847`） */
    this.ifndefMacro = 0;
    this.ifndefMacroSaved = 0;
    /** 这份文件是在搜索表的第几格找到的（tcc 的 `include_next_index`）：
     *  0 = 绝对路径、1 = 「跟 include 它的那份同一个目录」、2+ = `-I` 与系统目录。
     *  `-M` 那一路靠它分「自己的头」与「系统的头」（`tccpp.c:1419`）。 */
    this.includeNextIndex = 0;
  }
}

/** `tok_flags`（`tcc.h:1352-1354`） */
const TOK_FLAG_BOL = 1; // 前面是行首
const TOK_FLAG_BOF = 2; // 前面是文件开头
const TOK_FLAG_ENDIF = 4; // 见到了与开头 #ifdef 配对的 #endif

/** `parse_flags`（`tcc.h:1356-1364`） */
const PF_PREPROCESS = 1;
const PF_TOK_NUM = 2;
const PF_LINEFEED = 4;
const PF_SPACES = 0x10;
const PF_ACCEPT_STRAYS = 0x20;
const PF_TOK_STR = 0x40;

/**
 * C 的预处理器。一个实例 = 一趟翻译单元（tcc 的 `TCCState` 里那部分状态）。
 *
 * 宿主面（文件 IO）**全靠注入**：`readFile(path)` 回 `string` 或 `null`。降级器与测试
 * 因此都不必碰 fs，而 REPL 那一路可以把内存里的几份 `.h` 直接喂进来。
 */
export class Cpp {
  /**
   * @param {{readFile: (p: string) => (string|null), includeDirs?: string[],
   *          sysIncludeDirs?: string[],
   *          dirname?: (p: string) => string, join?: (a: string, b: string) => string}} host
   */
  constructor(host) {
    this.readFile = host.readFile;
    this.includeDirs = host.includeDirs ?? [];
    /** 自带的系统头目录（tcc 的 `sysinclude_paths`）。在 `-I` **之后**试，见 `parseInclude` */
    this.sysIncludeDirs = host.sysIncludeDirs ?? [];
    /* **framework 的头文件目录**（macOS，ADR-0022 的 J4d）。`#include <OpenGL/gl.h>` 在
     * 苹果那边不是"某个目录下的 OpenGL/gl.h"，而是
     * `<F>/OpenGL.framework/Headers/gl.h` —— clang 的 `-F` 那张表管的就是它。
     * 量出来的：`<GLFW/glfw3.h>` 第 237 行 include 的正是 `<OpenGL/gl.h>`，
     * 少了这张表，一份真的 GLFW 头连预处理都过不去。 */
    this.frameworkDirs = host.frameworkDirs ?? [];

    this.dirnameOf = host.dirname ?? defaultDirname;
    this.joinPath = host.join ?? defaultJoin;
    /** 目标架构（`--arch`）。预定义宏里目标 CPU 那三条按它换，见 tccdefs 的 `CPU_DEFS` */
    this.arch = host.arch ?? 'arm64';
    /** 目标 OS（`--os`）：`linux` | `osx` | `win32`。预定义宏里 OS 那一段、数据模型、
     * `wchar_t` 那两条都按它换，见 tccdefs 的 `OS_DEFS` / `MODEL` / `WCHAR_DEFS` */
    this.os = host.os ?? 'osx';

    /* 标识符表（tcc 的 `table_ident` + `hash_ident`，`tccpp.c:463-521`）。
     * tcc 用一张 16384 桶的手写哈希表；这里用 Map —— 引擎的哈希表就是那件事，
     * 而「记号号 = 下标 + TOK_IDENT」这条（前端到处在用的）不变。 */
    this.identNames = IDENT_NAMES.slice();
    this.identMap = new Map();
    for (let i = 0; i < this.identNames.length; i++) {
      this.identMap.set(this.identNames[i], TOK_IDENT + i);
    }

    /** 当前记号与它的值（tcc 的 `tok` / `tokc`） */
    this.tok = TOK_EOF;
    this.tokc = null;

    /** @type {CFile|null} */
    this.file = null;
    /** include 栈：`level` 的变化就是 -E 里印不印文件切换标记的依据（`tccpp.c:3927`） */
    this.includeStack = [];
    /** @type {number[]} `#if` 的状态栈：位 0 = 这一支要不要编，位 1 = 已经走过 `#else` */
    this.ifdefStack = [];

    /** @type {Map<number, object>} 记号号 -> 宏定义。`{special: true}` 是 __LINE__ 那一族 */
    this.defines = new Map();
    /** @type {Map<number, object[]>} `#pragma push_macro` 的存档 */
    this.macroStash = new Map();

    /** @type {Map<string, {once: boolean, ifndefMacro: number}>} include 守卫的缓存 */
    this.cachedIncludes = new Map();

    this.parseFlags = 0;
    this.tokFlags = 0;
    this.ppCounter = 0;
    /** `-dD`（3）/ `-dM`（7）：`dflag & 7` 开「边定义边印」，`& 4` 再把记号流那一半掐掉。 */
    this.dflag = 0;
    /** `-P` 的那一格（`LINE_MACRO_OUTPUT_FORMAT`，tcc.h:1372；`Pflag = atoi(optarg) + 1`）：
     *  0 = GCC 的 `# 行号 "文件"`（**默认**）、1 = 什么都不印（`-P`）、
     *  2 = `#line 行号 "文件"`（`-P1`）、11 = `-P10`（数字一律十进制，随后当 1 用）。 */
    this.Pflag = 0;
    /** `-M`/`-MM`/`-MD`/`-MMD`（tcc 的 `gen_deps`）：把读过的头文件记下来给 make 用。
     *  `includeSysDeps` 是 `-M`/`-MD` 多带的那一下（`include_sys_deps`）—— 连系统头一起记。 */
    this.genDeps = false;
    this.includeSysDeps = false;
    /** `target_deps`：主文件在前（调用方自己 push），随后按读到的次序。重复留着，
     *  去重是印的时候做的（`gen_makedeps`，tcctools.c:625）。 */
    this.targetDeps = [];
    /** `-include 文件`（tcc 的 `cmdline_incl`）：开工前先读的那几份，按命令行次序。 */
    this.cmdlineIncls = [];
    /** `-v` 的那一格（tcc 的 `verbose`：`-v` 1、`-vv` 2、`-vvv` 3）。
     *  2 = 每打开一个文件印一行 `-> 路径`，3 = 连试不开的也印（`nf 路径`）。
     *  被守卫/`#pragma once` 挡掉的那种印 `=> 路径`（2 与 3 都印）。 */
    this.verbose = 0;
    /** 攒着的那几行 trace：`preprocessToText` 每读一个记号就把它倒进输出，
     *  于是与记号流的先后次序和 tcc 一样（那边两边都是 stdout）。 */
    this.traceOut = '';
    /** `pp_debug_tok` / `pp_debug_symv`：刚过去那一条指示是什么、动的是哪个名字。 */
    this.ppDebugTok = 0;
    this.ppDebugSymv = 0;
    /** `<command line>` 那一层里过掉的 `#define`/`#undef` 印出来的那几行（第一百〇八片）。
     *  tcc 把预定义与 `-D`/`-U` 拼成一份源码在**同一个循环里**过，`-dD`/`-dM` 的那几行
     *  就是它们经过时印的 —— 于是「后来被 `-U` 掉的预定义照印」「从没定义过的名字
     *  也印 `#undef`」这两件事都是顺带的。我们的这一层是 `cmdlineLine` 一行一行过的，
     *  所以在那儿把行攒起来，到 `preprocessToText` 一次倒出去。 */
    this.cmdlineDump = '';
    /** `-E` 那一路每出一条诊断，stdout 上先落一个**空行**（`error1`，libtcc.c:683：
     *  `if (output_type == PREPROCESS && ppfp == stdout) printf("\n")`）。
     *  诊断本身走 stderr，这个换行走 stdout，于是逐字节比 `-E` 输出时它是能看见的。
     *  攒在这儿，由印输出的那一头（`preprocessToText` / `cmdlineLine`）就地倒出去。 */
    this.ppNl = '';
    /** `-Wall`（tcc 的 `warn_all`，默认 0）：见 `warnAllMsg`。 */
    this.warnAll = false;
    /** `#if` 的求值途中（`pp_expr`）：GCC 允许宏展开出 `defined`，靠这一格放行。
     *  求值那一段里它换成 `#if`/`#elif` 本身（>1），于是又兼作 `pp_error` 的开关 */
    this.ppExpr = 0;
    /** @type {TokStr|null} 正在求值的那条记号流，出错时要整条印出来（`ppErrorMsg`） */
    this.ppExprStr = null;

    /** 宏展开用的记号流栈（tcc 的 `macro_stack` / `macro_ptr`） */
    this.macroFrame = null; // {str: TokStr, i: number}
    this.macroFrames = [];
    /** @type {string[]} 警告（tcc 的 tcc_warning：不致命） */
    this.warnings = [];
    /** 预定义的宏装过了没有（见 `installPredefs`） */
    this.predefsDone = false;
    /** `#pragma pack` 的栈（tcc 的 `pack_stack`）。栈顶是当前值，0 = 没有 pack */
    this.packStack = [0];
    /** 只预处理（`-E`）还是要编译。tcc 那边是 `output_type == TCC_OUTPUT_PREPROCESS`，
     *  它决定 `#pragma` 是**原样印回**还是**当场解释**（见 `pragmaParse`）。 */
    this.ppOnly = false;

    /* __LINE__ 那一族在 tcc 里也要有个 Sym 占位，否则 `defined(__LINE__)` 是假的
     * （`tccpp.c:3734`）。`special` 就是 tcc 的 `d == NULL`。 */
    for (const v of [TOK___LINE__, TOK___FILE__, TOK___COUNTER__, TOK___DATE__, TOK___TIME__]) {
      this.defines.set(v, { special: true });
    }
  }

  /* ------------------------------------------------- 报错与名字 */

  /**
   * 报错报在**哪一行**（`libtcc.c:669`）：
   *
   * ```c
   * line = f->line_num - ((tok_flags & TOK_FLAG_BOL) && !macro_ptr);
   * ```
   *
   * `lineNum` 记的是「读到哪儿了」，而换行是**读完上一行**才数的 —— 当前记号正好落在
   * 行首（`TOK_FLAG_BOL`）时，`lineNum` 已经跨过去了，要减回来一行。宏流里读记号不
   * 动 `lineNum`，所以 `macroFrame !== null` 时不减。
   *
   * 这条减法就是我们从第六刀起一直比 tcc 晚一行的原因。
   */
  errLine() {
    let n = this.file.lineNum;
    if ((this.tokFlags & TOK_FLAG_BOL) && this.macroFrame === null) n--;
    return n;
  }

  /** tcc 的 `tcc_error`：**致命**，当场停。位置形如 `a.c:12:` —— 与 tcc 的前缀同形。 */
  err(msg) {
    const where = this.file ? `${this.file.filename}:${this.errLine()}: ` : '';
    /* `#if` 求值期间出的**任何**错都换成那一条记号流的转印（`libtcc.c:677`）：
     * 展开之后的样子才是真正有用的线索，原来那句话反而没什么信息。 */
    if (this.ppExpr > 1) msg = this.ppErrorMsg();
    throw new OmniError(`${where}error: ${msg}`);
  }

  warn(msg) {
    const where = this.file ? `${this.file.filename}:${this.errLine()}: ` : '';
    this.warnings.push(`${where}warning: ${msg}`);
    if (this.ppOnly) this.ppNl += '\n';
  }

  /**
   * `tcc_warning_c(warn_all)`：只有 `-Wall` 才响的那一类（tcc 里 `warn_all` 默认 0）。
   * 两处用得上：`multi-character character constant`（`tccpp.c:2197`）与
   * `#pragma X ignored`（`tccpp.c:1759`）。这不是可有可无的一格 —— 无条件响的话
   * `-E` 输出里会多出一个空行（诊断前那个换行），逐字节比对当场抓住。
   */
  warnAllMsg(msg) {
    if (this.warnAll) this.warn(msg);
  }

  /** 攒着的那几个诊断空行倒出来（见 `ppNl`）。 */
  takePpNl() {
    const s = this.ppNl;
    this.ppNl = '';
    return s;
  }

  /** `tok_alloc`（`tccpp.c:498`）：名字 -> 记号号，没见过就登记一个新的。 */
  tokAlloc(name) {
    const t = this.identMap.get(name);
    if (t !== undefined) return t;
    const v = TOK_IDENT + this.identNames.length;
    this.identNames.push(name);
    this.identMap.set(name, v);
    return v;
  }

  /**
   * `get_tok_str`（`tccpp.c:529`）：把一个记号印回文本。
   * -E 的输出逐字节对不对，全看这一个函数 —— 所以每一支都照抄，包括那些看着奇怪的：
   * 整数常量按 `%llu` 印（于是 -1 印成 18446744073709551615），不可打印字符印成 `<\xNN>`。
   */
  tokStr(v, cv) {
    switch (v) {
      case TOK_CINT: case TOK_CUINT: case TOK_CLLONG: case TOK_CULLONG:
        // `sprintf("%llu", (unsigned long long)cv->i)`（`tccpp.c:545`）
        return BigInt.asUintN(64, /** @type {bigint} */ (cv)).toString();
      case TOK_LCHAR:
        return `L'${addChar(Number(cv))}'`;
      case TOK_CCHAR:
        return `'${addChar(Number(cv))}'`;
      case TOK_PPNUM: case TOK_PPSTR:
        return /** @type {string} */ (cv);
      case TOK_LINENUM:
        return '<linenumber>';
      case TOK_STR: case TOK_LSTR: {
        if (v === TOK_LSTR) {
          let out = 'L"';
          for (const ch of /** @type {number[]} */ (cv)) out += addChar(ch);
          return `${out}"`;
        }
        let out = '"';
        for (const ch of /** @type {string} */ (cv)) out += addChar(ch.codePointAt(0));
        return `${out}"`;
      }
      case TOK_CFLOAT: return '<float>';
      case TOK_CDOUBLE: return '<double>';
      case TOK_CLDOUBLE: return '<long double>';
      case TOK_LT: return '<';
      case TOK_GT: return '>';
      case TOK_DOTS: return '...';
      case TOK_A_SHL: return '<<=';
      case TOK_A_SAR: return '>>=';
      case TOK_EOF: return '<eof>';
      default: break;
    }
    const t = v & ~SYM_FIELD;
    if (t < TOK_IDENT) {
      for (const [s, code] of TOK_TWO_CHARS) if (code === t) return s;
      if (t >= 127 || (t < 32 && !isSpaceCh(t) && t !== LF)) {
        return `<\\x${t.toString(16).padStart(2, '0')}>`;
      }
      return String.fromCharCode(t);
    }
    const name = this.identNames[t - TOK_IDENT];
    if (name === undefined) this.err(`internal: token ${t} has no name`);
    return name;
  }

  /* ------------------------------------------------- 输入流
   * tcc 在裸指针上走，`\<换行>` 的拼接靠 handle_stray / handle_bs（`tccpp.c:681-726`）
   * 在读的时候现场吃掉。这里同样**不预处理**拼接：`splice()` 把 pos 推到下一个真字符上，
   * 顺手把行号加上。预先把 `\<换行>` 删掉会让 `__LINE__` 和报错位置全错一格以上。 */

  /** 吃掉 pos 处所有的 `\<换行>`（含 `\<回车><换行>`）。真的是一个 `\` 就原地不动。 */
  splice() {
    const s = this.file.text;
    for (;;) {
      if (s.charCodeAt(this.file.pos) !== 92) return; // '\\'
      let q = this.file.pos + 1;
      if (s.charCodeAt(q) === 13) q++;
      if (s.charCodeAt(q) !== LF) return;
      this.file.pos = q + 1;
      this.file.lineNum++;
    }
  }

  /** 当前字符，已跳过拼接。文件尽头回 CH_EOF。 */
  peekc() {
    this.splice();
    const f = this.file;
    return f.pos < f.text.length ? f.text.charCodeAt(f.pos) : CH_EOF;
  }

  /** 吃掉当前字符，回下一个（tcc 的 `ninp()`，`tccpp.c:705`）。 */
  ninp() {
    this.file.pos++;
    return this.peekc();
  }

  /** `skip_spaces`（`tccpp.c:736`）：跳过空白（不含换行），回停下来的那个字符。 */
  skipSpaces() {
    let c = this.peekc();
    while (isSpaceCh(c)) c = this.ninp();
    return c;
  }

  /** `parse_line_comment`（`tccpp.c:747`）：吃到行末，停在换行上（换行本身不吃）。 */
  parseLineComment() {
    for (;;) {
      const c = this.peekc();
      if (c === CH_EOF || c === LF) return;
      this.file.pos++;
    }
  }

  /** `parse_comment`（`tccpp.c:772`）：吃掉 `/*…*​/`，中间的换行照数。 */
  parseComment() {
    this.file.pos++; // 吃掉 '*'
    for (;;) {
      const c = this.peekc();
      if (c === CH_EOF) this.err('unexpected end of file in comment');
      if (c === LF) this.file.lineNum++;
      this.file.pos++;
      if (c === 42 /* '*' */ && this.peekc() === 47 /* '/' */) {
        this.file.pos++;
        return;
      }
    }
  }

  /**
   * `parse_pp_string`（`tccpp.c:811`）：读一段引号里的东西，**不解转义**，
   * 只把 `\x` 整对留下（于是 `"\""` 里的引号不会提前收尾）。
   * `keep === false` 时只跳过不收集（跳过区域用）。
   * 调用时 pos 停在开引号上；返回时停在闭引号之后。
   */
  parsePpString(sep, keep) {
    let out = '';
    this.file.pos++; // 吃掉开引号
    for (;;) {
      let c = this.peekc();
      if (c === sep) break;
      if (c === CH_EOF) this.err(`missing terminating ${String.fromCharCode(sep)} character`);
      if (c === LF) {
        // ACCEPT_LF_IN_STRINGS == 0（`tccpp.c:25`）：字符串不许跨行
        if (!keep) return out;
        this.err(`missing terminating ${String.fromCharCode(sep)} character`);
      }
      if (c === 92) { // '\\' —— 这里的 `\` 一定不是行拼接（splice 已经吃过了）
        out += '\\';
        this.file.pos++;
        c = this.peekc();
        if (c === CH_EOF) this.err(`missing terminating ${String.fromCharCode(sep)} character`);
        if (c === LF) this.file.lineNum++;
      }
      out += String.fromCharCode(c);
      this.file.pos++;
    }
    this.file.pos++; // 吃掉闭引号
    return out;
  }

  /* ------------------------------------------------- 词法（`next_nomacro`，tccpp.c:2542）
   * 一件事值得先说：**指令是从词法器里回调出去的**。行首看见 `#` 就地调 preprocess()
   * （`tccpp.c:2622-2631`），处理完接着往下读。所以「预处理」不是词法之前的一遍，
   * 它就在词法的中间 —— 这也是 `#include` 能换掉输入流、`__LINE__` 能拿到当前行的原因。 */

  /** `maybe_newline`（`tccpp.c:2615`）：回 true = 出了一个 LINEFEED 记号，false = 接着读 */
  maybeNewline() {
    this.tokFlags |= TOK_FLAG_BOL;
    if (!(this.parseFlags & PF_LINEFEED)) return false;
    this.tok = TOK_LINEFEED;
    return true;
  }

  /** 一个不带值的记号 */
  simple(t, eat) {
    this.file.pos += eat;
    this.tok = t;
    this.tokc = null;
  }

  nextNomacro() {
    const f = this.file;
    redo: for (;;) {
      const c = this.peekc();

      /* 空白。`PF_SPACES` 开着时**每一段空白出一个记号**（-E 要靠它复原列位置），
       * 关着时整段吃掉。两条路都不清 tok_flags —— 行首标记要能穿过空白。 */
      if (c === SPC || c === TAB) {
        this.tok = c;
        this.tokc = null;
        this.file.pos++;
        if (this.parseFlags & PF_SPACES) return;
        while (isSpaceCh(this.peekc())) this.file.pos++;
        continue redo;
      }
      if (c === 11 || c === 12 || c === 13) { // \v \f \r —— 一声不响地吃掉
        this.file.pos++;
        continue redo;
      }

      if (c === LF) {
        this.file.lineNum++;
        this.file.pos++;
        if (this.maybeNewline()) return;
        continue redo;
      }

      if (c === CH_EOF) {
        /* 文件尽头有四种结局，顺序照 `tccpp.c:2573-2606`：
         * 最后一行没有换行符时先补一个隐式换行（否则最后一行的指令会漏掉）。 */
        if (!(this.tokFlags & TOK_FLAG_BOL)) {
          if (this.maybeNewline()) return;
          continue redo;
        }
        if (!(this.parseFlags & PF_PREPROCESS)) {
          this.simple(TOK_EOF, 0);
          return;
        }
        if (this.ifdefStack.length !== this.file.ifdefBase) this.err('missing #endif');
        if (this.includeStack.length === 0) {
          this.simple(TOK_EOF, 0);
          return;
        }
        /* 「整个文件被 #ifndef 包着」这件事在这里才落账：`#endif` 恰好在文件末尾时
         * 把守卫名记进缓存，下次 include 同一个文件就整份跳过（`tccpp.c:2590-2596`）。 */
        if (this.tokFlags & TOK_FLAG_ENDIF) {
          this.cachedInclude(this.file.trueFilename, true).ifndefMacro = this.file.ifndefMacroSaved;
          this.tokFlags &= ~TOK_FLAG_ENDIF;
        }
        this.includeStack.pop();
        this.file = this.file.prev;
        if (this.maybeNewline()) return;
        continue redo;
      }

      if (c === 35) { // '#'
        this.file.pos++;
        if ((this.tokFlags & TOK_FLAG_BOL) && (this.parseFlags & PF_PREPROCESS)) {
          this.tokFlags &= ~TOK_FLAG_BOL;
          this.preprocess((this.tokFlags & TOK_FLAG_BOF) !== 0);
          if (this.maybeNewline()) return;
          continue redo;
        }
        if (this.peekc() === 35) this.simple(TOK_TWOSHARPS, 1);
        else this.simple(35, 0);
        break redo;
      }

      if (isIdCh(c)) {
        /* 标识符。`L'x'` / `L"x"` 借这一支认出来：标识符里不可能有引号，所以
         * 「名字恰好是 L 且紧跟引号」与 tcc 那个 `p[1]` 的预看等价（`tccpp.c:2710`）。 */
        let name = '';
        let cc = c;
        while (isIdNum(cc)) {
          name += String.fromCharCode(cc);
          this.file.pos++;
          cc = this.peekc();
        }
        if (name === 'L' && (cc === 39 || cc === 34)) {
          this.lexPpString(cc, true);
          break redo;
        }
        this.tok = this.tokAlloc(name);
        this.tokc = null;
        break redo;
      }

      if (isNumCh(c)) {
        this.lexPpNum(c);
        break redo;
      }

      if (c === 46) { // '.' —— 它既能起一个数，又是 `.` 与 `...`
        this.file.pos++;
        const c2 = this.peekc();
        if (isNumCh(c2)) {
          this.lexPpNumFrom('.', c2);
          break redo;
        }
        if (c2 === 46) {
          // `..` 之后必须还是 `.` 才是 `...`；不是就只出一个 `.`（第二个下次再读）
          const save = this.file.pos;
          this.file.pos++;
          if (this.peekc() === 46) {
            this.simple(TOK_DOTS, 1);
            break redo;
          }
          this.file.pos = save;
        }
        this.simple(46, 0);
        break redo;
      }

      if (c === 39 || c === 34) { // ' "
        this.lexPpString(c, false);
        break redo;
      }

      if (c === 47) { // '/' —— 注释在这里变成一个空格记号
        this.file.pos++;
        const c2 = this.peekc();
        if (c2 === 42) {
          this.parseComment();
          this.tok = SPC;
          this.tokc = null;
          if (this.parseFlags & PF_SPACES) return;
          while (isSpaceCh(this.peekc())) this.file.pos++;
          continue redo;
        }
        if (c2 === 47) {
          this.parseLineComment();
          this.tok = SPC;
          this.tokc = null;
          if (this.parseFlags & PF_SPACES) return;
          while (isSpaceCh(this.peekc())) this.file.pos++;
          continue redo;
        }
        if (c2 === 61) this.simple(TOK_A_DIV, 1);
        else this.simple(47, 0);
        break redo;
      }

      if (c === 92) { // 到这里的 `\` 一定不是行拼接（splice 已经吃过了）
        this.file.pos++;
        if (!(this.parseFlags & PF_ACCEPT_STRAYS)) this.err("stray '\\' in program");
        this.simple(92, 0);
        break redo;
      }

      if (this.lexOperator(c)) break redo;

      this.err(`unrecognized character \\x${c.toString(16).padStart(2, '0')}`);
    }
    // 出了一个真记号：行首/文件首标记到此作废（`tccpp.c:2944`）
    this.tokFlags = 0;
  }

  /**
   * 运算符。多字符的那些按「最长匹配」展开写，顺序照 `tccpp.c:2792-2930`。
   * 回 false = 这个字符不是运算符。
   */
  lexOperator(c) {
    const two = (nc, t, fallback) => {
      this.file.pos++;
      if (this.peekc() === nc) this.simple(t, 1);
      else this.simple(fallback, 0);
    };
    switch (c) {
      case 60: { // '<'
        this.file.pos++;
        const c2 = this.peekc();
        if (c2 === 61) this.simple(TOK_LE, 1);
        else if (c2 === 60) two(61, TOK_A_SHL, TOK_SHL);
        else this.simple(TOK_LT, 0);
        return true;
      }
      case 62: { // '>'
        this.file.pos++;
        const c2 = this.peekc();
        if (c2 === 61) this.simple(TOK_GE, 1);
        else if (c2 === 62) two(61, TOK_A_SAR, TOK_SAR);
        else this.simple(TOK_GT, 0);
        return true;
      }
      case 38: { // '&'
        this.file.pos++;
        const c2 = this.peekc();
        if (c2 === 38) this.simple(TOK_LAND, 1);
        else if (c2 === 61) this.simple(TOK_A_AND, 1);
        else this.simple(38, 0);
        return true;
      }
      case 124: { // '|'
        this.file.pos++;
        const c2 = this.peekc();
        if (c2 === 124) this.simple(TOK_LOR, 1);
        else if (c2 === 61) this.simple(TOK_A_OR, 1);
        else this.simple(124, 0);
        return true;
      }
      case 43: { // '+'
        this.file.pos++;
        const c2 = this.peekc();
        if (c2 === 43) this.simple(TOK_INC, 1);
        else if (c2 === 61) this.simple(TOK_A_ADD, 1);
        else this.simple(43, 0);
        return true;
      }
      case 45: { // '-'
        this.file.pos++;
        const c2 = this.peekc();
        if (c2 === 45) this.simple(TOK_DEC, 1);
        else if (c2 === 61) this.simple(TOK_A_SUB, 1);
        else if (c2 === 62) this.simple(TOK_ARROW, 1);
        else this.simple(45, 0);
        return true;
      }
      // PARSE2（`tccpp.c:2882-2886`）：`x` 与 `x=` 两种
      case 33: two(61, TOK_NE, 33); return true; // !
      case 61: two(61, TOK_EQ, 61); return true; // =
      case 42: two(61, TOK_A_MUL, 42); return true; // *
      case 37: two(61, TOK_A_MOD, 37); return true; // %
      case 94: two(61, TOK_A_XOR, 94); return true; // ^
      // 单字符（`tccpp.c:2916-2930`）
      case 40: case 41: case 91: case 93: case 123: case 125:
      case 44: case 59: case 58: case 63: case 126: case 64:
        this.simple(c, 1);
        return true;
      default:
        return false;
    }
  }

  /** 预处理数（`TOK_PPNUM`）：值就是**原文**，不在这一步解释（`tccpp.c:2722-2751`） */
  lexPpNum(c) {
    this.file.pos++;
    this.lexPpNumFrom(String.fromCharCode(c), this.peekc());
  }

  /**
   * `parse_num`（`tccpp.c:2729`）。规则只有一条但不直观：第一个字符之后，
   * **字母、数字、`.` 都算这个数的一部分**，`+`/`-` 只在紧跟 `eEpP` 时算。
   * 于是 `0x1e+2` 是一个记号而 `1e+2` 也是一个 —— C 就是这么规定的，
   * 「这串东西合不合法」留给后面解释它的人判。
   */
  lexPpNumFrom(first, cc) {
    let t = first.charCodeAt(0);
    let s = '';
    for (;;) {
      s += String.fromCharCode(t);
      const expSign = (cc === 43 || cc === 45)
        && (t === 101 || t === 69 || t === 112 || t === 80); // e E p P
      if (!(isIdNum(cc) || cc === 46 || expSign)) break;
      t = cc;
      this.file.pos++;
      cc = this.peekc();
    }
    this.tok = TOK_PPNUM;
    this.tokc = s;
  }

  /**
   * 字符串/字符常量：`TOK_PPSTR`，值是**带引号（与 L 前缀）的原文**，转义一个都不解
   * （`tccpp.c:2776-2790`）。-E 要原样印回，而 `#include "a\b.h"` 里的 `\b` 不是退格 ——
   * 两件事都要求这一步不动手。
   */
  lexPpString(sep, isLong) {
    const pre = isLong ? 'L' : '';
    const q = String.fromCharCode(sep);
    const body = this.parsePpString(sep, true);
    this.tok = TOK_PPSTR;
    this.tokc = `${pre}${q}${body}${q}`;
  }

  /* ------------------------------------------------- 宏展开
   * 这一节是整个预处理器的难处所在。四个函数分工照 tcc：
   *   macroSubst      一段记号流里的每个名字试着展开（`tccpp.c:3408`）
   *   macroSubstTok   展开**一个**宏：函数式的话先去读实参（`tccpp.c:3237`）
   *   macroArgSubst   把形参换成实参，顺手做 `#`（字符串化）（`tccpp.c:2986`）
   *   macroTwosharps  做 `##`（粘接），粘出来的字节**重新过一遍词法**（`tccpp.c:3106`）
   * 递归防护是一条链（`nestedList`）：正在展开的宏名在链上，链上的名字遇到就打个
   * `SYM_FIELD` 的印、永远不再展开 —— 这就是 `#define REC REC` 不会死循环的原因。 */

  /** 把一段记号流压成当前输入（`begin_macro`，`tccpp.c:1053`）。
   *
   *  连**行号**一起存（tcc 的 `save_line_num`）：流里可能带着 `TOK_LINENUM`，读的时候
   *  会把 `file.lineNum` 拨到别处去；这一层读完必须拨回来，否则后面整段的诊断都跟着跑偏。 */
  beginMacro(str, i) {
    if (this.macroFrame !== null) this.macroFrames.push(this.macroFrame);
    this.macroFrame = { str, i, saveLine: this.file === null ? 0 : this.file.lineNum };
    return this.macroFrame;
  }

  endMacro() {
    if (this.file !== null && this.macroFrame !== null) {
      this.file.lineNum = this.macroFrame.saveLine;
    }
    this.macroFrame = this.macroFrames.length > 0 ? this.macroFrames.pop() : null;
  }

  /** `unget_tok`（`tccpp.c:3529`）：把当前记号推回去，换成 `lastTok`。 */
  ungetTok(lastTok) {
    const s = new TokStr();
    if (this.tok !== TOK_EOF) s.add2(this.tok, this.tokc);
    this.beginMacro(s, 0);
    this.tok = lastTok;
    this.tokc = null;
  }

  /**
   * 收一串记号存着，回头再放一遍（tcc 用同一个 `TokStr` 干这件事：inline 函数体
   * `store_inline_functions`、`#if` 的表达式、宏体，都是「先收成记号串、之后再当输入放」）。
   * 从当前记号起收，一直收到**深度 0 上**的 `endTok`（那个记号不收，留在 `tok` 上）。
   * 末尾补一个 `TOK_EOF` 当哨兵 —— `next()` 对宏流里的 EOF 是原样交出（见那里的注释），
   * 于是放的时候能知道「这一串放完了」，而不会一路读到文件里去。
   *
   * 第六刀要它是为了 `for` 的步进式：它在源码里写在**循环体前面**，却必须在循环体
   * **后面**执行。tcc 靠跳转绕过去（`tccgen.c:7326-7331`：先 `gjmp` 跳过步进，
   * 循环体末尾再跳回来），而 MIR 是结构化控制流、指令不能重排 —— 所以只能先收后放。
   */
  captureTokens(endTok) {
    const str = new TokStr();
    let depth = 0;
    for (;;) {
      if (this.tok === TOK_EOF) this.err('unexpected end of file');
      if (depth === 0 && this.tok === endTok) break;
      if (this.tok === 40 || this.tok === 91 || this.tok === 123) depth++;
      else if (this.tok === 41 || this.tok === 93 || this.tok === 125) depth--;
      str.addTok(this.tok, this.tokc, this.errLine());
      this.next();
    }
    str.add2(TOK_EOF, null);
    return str;
  }

  /** 把 `captureTokens` 收来的记号串压回输入。读到那个哨兵 EOF 就该叫 `endMacro()`。 */
  pushTokens(str) {
    this.beginMacro(str, 0);
  }

  /**
   * 收一整个 `{ … }`（**含两端的花括号**），停在 `}` 之后的那个记号上。
   *
   * 与 `captureTokens` 分成两个函数、而不是给它加一个开关：那个函数的语义是「收到某个
   * 定界符**之前**」，这个是「收一个配平的组」——「配平」在这里是收的条件本身，
   * 不是顺带的记账。tcc 也有这一路：`skip_or_save_block` 把 inline 函数体整块存成
   * `TokStr` 留到用的时候再放（`tccgen.c:8262` 一带）。
   *
   * 第六刀第三片要它：一个局部量要不要落在线性内存上，取决于函数体里有没有对它取地址 ——
   * 而那是**后面**的事。一遍过没法后看，所以函数体解析两遍：第一遍收「谁被取过地址」
   * 与帧大小的上界（发出的指令丢掉），第二遍才是真的。
   */
  captureBraced() {
    if (this.tok !== 123) this.err("'{' expected");
    const str = new TokStr();
    let depth = 0;
    for (;;) {
      if (this.tok === TOK_EOF) this.err('unexpected end of file');
      if (this.tok === 123) depth++;
      else if (this.tok === 125) depth--;
      str.addTok(this.tok, this.tokc, this.errLine());
      this.next();
      if (depth === 0) break;
    }
    str.add2(TOK_EOF, null);
    return str;
  }

  /**
   * `switch` 的体**不是**花括号那一种（第八刀第三十七片）：收一条语句，
   * 外面**替它补上一对花括号**，于是重放那一路（`scanCases` 与 `block`）一个字都不用改。
   *
   * C11 6.8.4 说的是 `switch (expr) statement` —— 花括号只是最常见的那一种语句。
   * tcctest.c:1352 自己带着注释考这一格：`switch (j) case 1: break;`。
   *
   * 「一条语句到哪儿为止」这儿按记号数：配平括号，然后在深度 0 上的 `;` 或者 `}` 收尾。
   * 两种情形要接着收 —— 后面跟着 `else`（`if (a) b; else c;`），或者深度 0 上还有一个
   * 没配对的 `do` 而后面跟着 `while`（`case 1: do { n++; } while (n < 3);` —— `do` 不一定
   * 在这条语句的**开头**，所以这儿数的是个数，不是「第一个记号是不是 do」）。
   * 别的形状都在这两条之内：标签、`case x:`、复合语句、嵌套的 if/循环都是收到自己
   * 那个 `;` / `}` 为止。
   */
  captureStmtBraced() {
    if (this.tok === 123) return this.captureBraced();
    const str = new TokStr();
    let dos = 0;
    str.addTok(123, null, this.errLine());
    let depth = 0;
    for (;;) {
      if (this.tok === TOK_EOF) this.err('unexpected end of file');
      if (this.tok === 40 || this.tok === 91 || this.tok === 123) depth++;
      else if (this.tok === 41 || this.tok === 93 || this.tok === 125) depth--;
      else if (depth === 0 && this.tok === TOK_DO) dos++;
      const t = this.tok;
      str.addTok(t, this.tokc, this.errLine());
      this.next();
      if (depth !== 0 || (t !== 59 && t !== 125)) continue;
      if (this.tok === TOK_ELSE) continue;
      if (dos > 0 && this.tok === TOK_WHILE) { dos--; continue; }
      break;
    }
    str.addTok(125, null, this.errLine());
    str.add2(TOK_EOF, null);
    return str;
  }

  defineFind(v) {    const d = this.defines.get(v);
    return d === undefined ? null : d;
  }

  /**
   * `next`（`tccpp.c:3470`）：带宏展开的取记号。
   * 先把压着的记号流放完，放完了才去读文件；从**文件**读到的标识符才试着展开
   * （从宏体里出来的那些由 macroSubst 负责，已经展开过了）。
   */
  next() {
    for (;;) {
      while (this.macroFrame !== null) {
        const fr = this.macroFrame;
        if (fr.i >= fr.str.len()) {
          this.endMacro();
          continue;
        }
        const t = fr.str.toks[fr.i];
        const v = fr.str.vals[fr.i];
        fr.i++;
        if (t === TOK_LINENUM) {
          // 收的时候记下的行号（`TokStr.addTok`），放的时候拨回去（`tccpp.c:3478`）
          this.file.lineNum = /** @type {number} */ (v);
          continue;
        }
        if (t === TOK_EOF) {
          // 宏里的 EOF 是 `#if` 求值那一路造的哨兵，原样交出去
          this.tok = TOK_EOF;
          this.tokc = null;
          return;
        }
        this.tok = t & ~SYM_FIELD; // 摘掉「不要再展开」的印（`tccpp.c:3491`）
        this.tokc = v;
        if (this.tok === 92 && !(this.parseFlags & PF_ACCEPT_STRAYS)) {
          this.err("stray '\\' in program");
        }
        this.convert();
        return;
      }

      this.nextNomacro();
      if (this.tok >= TOK_IDENT && (this.parseFlags & PF_PREPROCESS)) {
        const s = this.defineFind(this.tok);
        if (s !== null) {
          const out = new TokStr();
          this.macroSubstTok(out, { list: [] }, this.tok, s);
          this.beginMacro(out, 0);
          continue; // 回到上面把展开结果放出来（tcc 的 `goto redo`）
        }
        return;
      }
      this.convert();
      return;
    }
  }

  /**
   * `convert:`（`tccpp.c:3516`）：预处理记号 -> C 记号。
   * 只有 `#if` 那一路和 `-P10` 会开这两个开关；-E 的主路上 PPNUM/PPSTR 原样带着走，
   * 于是「`0x1p3` 印回去还是 `0x1p3`」不需要任何往回转换的代码。
   */
  convert() {
    if (this.tok === TOK_PPNUM && (this.parseFlags & PF_TOK_NUM)) {
      const r = parseNumber(/** @type {string} */ (this.tokc));
      if (r === null) this.err(`invalid number '${this.tokc}'`);
      this.tok = r.tok;
      this.tokc = r.val;
    } else if (this.tok === TOK_PPSTR && (this.parseFlags & PF_TOK_STR)) {
      this.parseStringTok(/** @type {string} */ (this.tokc));
    }
  }

  /** `parse_string`（`tccpp.c:2167`）：把 PPSTR 的原文解成字符常量或字符串常量。 */
  parseStringTok(text) {
    let s = text;
    let isLong = false;
    if (s.charCodeAt(0) === 76) { // 'L'
      isLong = true;
      s = s.slice(1);
    }
    const sep = s.charCodeAt(0);
    const body = parseEscapeString(s.slice(1, s.length - 1), (m) => this.err(m), isLong);
    if (sep === 39) { // 字符常量
      if (body.length < 1) this.err('empty character constant');
      if (body.length > 1) this.warnAllMsg('multi-character character constant');
      if (isLong) {
        /* `L'ab'` 的值是**最后**那个（`tccpp.c:2198-2203` 的循环对宽的是直接赋值，
         * 不像窄的那样左移八位再或）。收口按这个目标的 `wchar_t`（tcc 那边是
         * `nwchar_t`，`tcc.h:447-451`）：非 PE 上 32 位有符号（`L'\xffffffff'` 是 -1），
         * win32 上 16 位无符号。 */
        this.tok = TOK_LCHAR;
        const last = BigInt(body[body.length - 1]);
        this.tokc = this.os === 'win32' ? BigInt.asUintN(16, last) : BigInt.asIntN(32, last);
        return;
      }
      /* `c = (c << 8) | (char)byte`（`tccpp.c:2202`）—— `char` 在本机（arm64 Darwin）
       * 是**有符号**的，量过：`#if '\xff' < 0` 在 tcc 上成立。所以每个字节先按有符号取，
       * 再按 64 位两补收口：`'\xff'` = -1，`'ab'` = 24930。 */
      let c = 0n;
      for (const b of body) {
        const sb = b >= 128 ? b - 256 : b;
        c = BigInt.asIntN(64, (c << 8n) | BigInt(sb));
      }
      this.tok = TOK_CCHAR;
      this.tokc = c;
      return;
    }
    /* 窄串的值是一个 JS 字符串（一格一字节），宽串是一个**数字数组**（一格一个 wchar）——
     * 码位可以超过 0xFFFF，塞进 JS 字符串就会变成代理对、格数就错了。 */
    if (isLong) {
      this.tok = TOK_LSTR;
      this.tokc = body;
      return;
    }
    this.tok = TOK_STR;
    this.tokc = body.map((b) => String.fromCharCode(b)).join('');
  }

  /**
   * `macro_subst`（`tccpp.c:3408`）：把 `str` 从 `i` 起展开，结果追加进 `out`。
   * 回 true = 「下一个记号不要展开」（tcc 的 nosubst）—— 那是函数式宏名后面没跟 `(`
   * 的那种情况传出来的状态。
   */
  macroSubst(out, nested, str, from) {
    let i = from;
    let nosubst = false;
    for (;;) {
      if (i >= str.len()) break;
      let t = str.toks[i];
      const v = str.vals[i];
      i++;
      if (t === 0 || t === TOK_EOF) break;
      if (t >= TOK_IDENT) {
        /* 打过印的名字（`t | SYM_FIELD`）在这里查不到定义 —— tcc 靠的也是这个：
         * `define_find` 拿 `v - TOK_IDENT` 当下标，带着 SYM_FIELD 就越界回 NULL
         * （`tccpp.c:1274`）。于是「不再展开」这件事不需要第二个判断。 */
        const s = this.defineFind(t);
        if (s !== null && nested.list.indexOf(t) >= 0) {
          // 正在展开它自己：打上印，谁都别再试（`tccpp.c:3433-3436`）
          t |= SYM_FIELD;
        } else if (s !== null && !nosubst) {
          /* 函数式宏可能要把 `(` 与实参从**后面的记号流**里读走，所以先把「剩下的部分」
           * 压成当前输入，让 nextArgstream 能顺着往下摸（`tccpp.c:3438-3440`）。 */
          const fr = this.beginMacro(str, i);
          nosubst = this.macroSubstTok(out, nested, t, s);
          if (this.macroFrame !== fr) break; // 实参已经把这一层读完了
          i = fr.i;
          this.endMacro();
          continue;
        }
      } else if (t === SPC) {
        if (this.parseFlags & PF_SPACES) out.needSpc |= 1;
        continue;
      }
      out.add2Spc(t, v);
      if (nosubst && t !== 40) nosubst = false;
      if (t === TOK_DEFINED && this.ppExpr) nosubst = true; // GCC 的宽容（`tccpp.c:3457`）
    }
    return nosubst;
  }

  /**
   * `macro_subst_tok`（`tccpp.c:3237`）：展开一个宏 `v`。
   * 回 true = 它是函数式宏但后面没跟 `(` —— 那不是一次调用，名字原样留下。
   */
  macroSubstTok(out, nested, v, s) {
    if (s.special) {
      this.substSpecial(out, v);
      return false;
    }
    let mstr = s.str;
    let args = null;

    if (s.type & MACRO_FUNC) {
      const saved = this.parseFlags;
      this.parseFlags |= PF_SPACES | PF_LINEFEED | PF_ACCEPT_STRAYS;
      /* 先**预看**下一个非空白记号是不是 `(`，而且要能跨行、跨 include 边界地看
       * （`tccpp.c:3263`）。看过的空白要留着：不是调用的话它们得原样吐回去。 */
      const ws = new TokStr();
      let t = this.nextArgstream(nested, ws);
      if (t !== 40) {
        this.parseFlags = saved;
        out.add2Spc(v, null);
        if (saved & PF_SPACES) {
          for (let k = 0; k < ws.len(); k++) out.add2(ws.toks[k], ws.vals[k]);
        }
        return false;
      }
      args = this.readMacroArgs(nested, v, s);
      mstr = this.macroArgSubst(nested, mstr, args);
      this.parseFlags = saved;
    }

    let jstr = mstr;
    if (s.type & MACRO_JOIN) jstr = this.macroTwosharps(mstr);

    nested.list.push(v);
    const ret = this.macroSubst(out, nested, jstr, 0);
    if (nested.list[nested.list.length - 1] === v) nested.list.pop();
    return ret;
  }

  /** `__LINE__` / `__FILE__` / `__COUNTER__`（`tccpp.c:3363-3400`） */
  substSpecial(out, v) {
    if (v === TOK___LINE__ || v === TOK___COUNTER__) {
      /* `ppCounter++` 摊到语句上：三目的分支是**惰性求值**的位置，那儿的副作用要一个
         临时量才降得下去（自编译子集的规矩）。只有 `__COUNTER__` 那一支才动它。 */
      let n = 0;
      if (v === TOK___LINE__) {
        n = this.file.lineNum;
      } else {
        n = this.ppCounter;
        this.ppCounter++;
      }
      out.add2Spc(TOK_PPNUM, String(n));
      return;
    }
    if (v === TOK___FILE__) {
      out.add2Spc(TOK_STR, this.file.filename);
      return;
    }
    /* `__DATE__` / `__TIME__`（`tccpp.c:3378-3393`）：**每次展开都现读一次时钟**
     * （tcc 也是在这儿 `time()` 的，不是启动时算一次存着）。格式是 tcc 那两句
     * `snprintf` 的原样：`"%s %2d %d"`（月份缩写、日**空格**右对齐到两位、四位年）
     * 与 `"%02d:%02d:%02d"`，取的是**本地时间**（`localtime`）。
     *
     * 时钟从宿主 op 来（`localStamp`，14 位 YYYYMMDDHHMMSS），不是 `new Date()` ——
     * 后者不在我们自己那个 JS 前端认的构造之列，写在这儿会让自举那一路编不过。
     * 一次调用拿全六个字段，所以它们必然是同一个瞬间的（与 tcc 的一次 `time()` 同义）。
     *
     * 它们的值随时钟走，所以逐字节比对的那些门不能用它们 —— 与 tcc 比的是「日期这一
     * 串相同、时间差在几秒内」（`tests/c/datetime.js`）。 */
    if (v === TOK___DATE__ || v === TOK___TIME__) {
      const st = localStamp();
      const mo = Number.parseInt(st.slice(4, 6), 10);
      const day = Number.parseInt(st.slice(6, 8), 10);
      out.add2Spc(TOK_STR, v === TOK___DATE__
        ? `${MONTH_ABBR[mo - 1]} ${String(day).padStart(2, ' ')} ${st.slice(0, 4)}`
        : `${st.slice(8, 10)}:${st.slice(10, 12)}:${st.slice(12, 14)}`);
      return;
    }
    this.err(`'${this.tokStr(v, null)}' is not supported yet`);
  }

  /**
   * 读一次函数式宏调用的实参（`tccpp.c:3280-3330`）。
   * 三条容易写错的规矩，逐条对着 tcc：
   *   1. **空实参是合法的**，除非这个宏一个形参都没有（`F()` 对 `#define F()` 才行）；
   *   2. 括号要配平地切分逗号，`F((a,b))` 是一个实参；
   *   3. 可变实参那一格**吃掉后面所有的逗号**（`sa->type.t` 非零就不在 `,` 上断开）。
   */
  readMacroArgs(nested, v, s) {
    const args = [];
    const params = s.args ?? [];
    let pi = 0;
    let t;
    let eat = 2;
    for (;;) {
      /* 先吃掉那个 `(`，再停在第一个实参记号上。tcc 的写法是 `while (t == ' ' || --i)`
       * （`tccpp.c:3286-3288`）—— **空白不算一格**：`--i` 靠 `||` 的短路跳过去。
       * 写成「每读一个就减一」的话，`(` 前面有空白时会少读一格、把 `(` 当成实参的开头
       * （宏体里写 `B (val)` 就是这个形状，elf.h 的 `ELF64_ST_BIND` 正是这么写的）。
       * 每读完一个实参 `eat` 复位成 1（下面那一行）：往后就不再多吃一格了。 */
      do {
        t = this.nextArgstream(nested, null);
      } while (t === SPC || --eat);

      if (pi >= params.length) {
        if (t === 41) break; // `F()` 打到 `#define F()` 上
        this.err(`macro '${this.tokStr(v, null)}' used with too many args`);
      }
      for (;;) {
        const p = params[pi];
        const str = new TokStr();
        let parlevel = 0;
        while (parlevel > 0 || (t !== 41 && (t !== 44 || p.vaargs))) {
          if (t === TOK_EOF) {
            this.err(`EOF in invocation of macro '${this.tokStr(v, null)}'`);
          }
          if (t === 40) parlevel++;
          if (t === 41) parlevel--;
          if (t === SPC) str.needSpc |= 1;
          else str.add2Spc(t, this.tokc);
          t = this.nextArgstream(nested, null);
        }
        /* 每个实参的记号串以 **TOK_EOF** 收尾（tcc 也是：`macro_arg_subst` 里到处是
         * `while (*st != TOK_EOF)`）。这不是装饰 —— 它是「实参里的宏不许吃外面的记号流」
         * 那条规矩的实现：展开实参时如果末尾是个函数式宏名，`nextArgstream` 预看到的是
         * 这个 TOK_EOF 而不是外面那个 `(`，于是那个名字原样留下。tcctest.c:262
         * 的 `qq(qq)(2)` 考的正是这一格（少了它，`qq(qq)` 会把后面的 `(2)` 吃进来）。 */
        str.add(TOK_EOF);
        args.push({ v: p.v, vaargs: p.vaargs, str, expanded: null });
        pi++;
        if (t !== 41) break;
        if (pi >= params.length) return args;
        /* gcc 的宽容：可变实参那一格可以整个省掉，补一个空的（`tccpp.c:3324`）。
         * 少了这一条，`printf("x")` 打到 `#define P(f, ...)` 上会报「实参太少」。 */
        if (!params[pi].vaargs) {
          this.err(`macro '${this.tokStr(v, null)}' used with too few args`);
        }
      }
      eat = 1;
    }
    return args;
  }

  /**
   * `peek_file`（`tccpp.c:3163`）：在**文件**上预看下一个非空白字符，
   * 跳过的空白（注释算一个空格、换行算换行）收进 `ws`。pos 停在那个字符上。
   */
  peekFile(ws) {
    for (;;) {
      let c = this.peekc();
      if (c === 47) { // '/'
        const save = this.file.pos;
        this.file.pos++;
        const c2 = this.peekc();
        if (c2 === 42) {
          this.parseComment();
          c = SPC;
        } else if (c2 === 47) {
          this.parseLineComment();
          c = SPC;
        } else {
          this.file.pos = save;
          return 47;
        }
      } else if (c === SPC || c === TAB) {
        this.file.pos++;
      } else if (c === 11 || c === 12 || c === 13) {
        this.file.pos++;
        continue; // 这三个不进 ws（tcc 的 `continue`，不是 `break`）
      } else if (c === LF) {
        this.file.pos++;
        this.file.lineNum++;
        this.tokFlags |= TOK_FLAG_BOL;
      } else {
        return c;
      }
      if (ws !== null) ws.add(c);
    }
  }

  /**
   * `next_argstream`（`tccpp.c:3200`）：读（`ws === null`）或预看（否则）宏调用的下一个
   * 记号，必要时**穿过宏的层**一直摸到文件上。函数式宏的 `(` 可以在另一行、
   * 甚至在上一层宏展开的尾巴之后 —— 这个函数就是那件事。
   */
  nextArgstream(nested, ws) {
    while (this.macroFrame !== null) {
      const fr = this.macroFrame;
      let k = fr.i;
      let found = false;
      while (k < fr.str.len()) {
        const t = fr.str.toks[k];
        if (t === 0) break;
        if (ws !== null) {
          if (t !== SPC) {
            found = true;
            break;
          }
          k++;
        } else {
          this.tok = fr.str.toks[fr.i] & ~SYM_FIELD;
          this.tokc = fr.str.vals[fr.i];
          fr.i++;
          return this.tok;
        }
      }
      if (found) return fr.str.toks[k] & ~SYM_FIELD;
      this.endMacro();
      // 一层宏读完了，它的递归防护也跟着出栈（`tccpp.c:3219`）
      if (nested.list.length > 0) nested.list.pop();
    }
    if (ws !== null) return this.peekFile(ws);
    this.nextNomacro();
    // 实参里的制表符与换行都算一个空格（`tccpp.c:3227`）
    if (this.tok === TAB || this.tok === TOK_LINEFEED) this.tok = SPC;
    return this.tok;
  }

  /**
   * `macro_arg_subst`（`tccpp.c:2986`）：宏体里的形参换成实参。
   * 两处不是「换一下」那么简单：
   *   - `#x`：把实参的**原文**（未展开）串起来加引号；
   *   - 紧挨着 `##` 的形参：实参也**不展开**（C 的规定），而且
   *     `, ## __VA_ARGS__` 在实参为空时要把那个逗号一起吃掉（gcc 的老把戏）。
   * 其余位置的实参要**先整个展开一遍**再代进去，展开结果缓存在 `expanded` 里。
   */
  macroArgSubst(nested, mstr, args) {
    const out = new TokStr();
    let t0 = 0;
    let t1 = 0;
    let i = 0;
    while (i < mstr.len()) {
      const t = mstr.toks[i];
      const v = mstr.vals[i];
      i++;
      if (t === 0) break;
      if (t === 35) { // '#' —— 字符串化
        let nt = 0;
        while (i < mstr.len()) {
          nt = mstr.toks[i];
          i++;
          if (nt !== SPC) break;
        }
        const a = findArg(args, nt);
        if (a === null) this.err("macro parameter after '#' expected");
        let s = '"';
        for (let k = 0; k < a.str.len(); k++) {
          const at = a.str.toks[k];
          if (at === TOK_EOF) break;
          const text = this.tokStr(at, a.str.vals[k]);
          /* PPSTR 里的引号与反斜杠要转义，`'` 不要（`tccpp.c:3022`）——
           * 于是 `STR("a")` 得到 `"\"a\""`，而 `STR('a')` 得到 `"'a'"`。 */
          for (const ch of text) {
            if (at === TOK_PPSTR && ch !== "'") s += addChar(ch.codePointAt(0));
            else s += ch;
          }
        }
        out.add2(TOK_PPSTR, `${s}"`);
      } else if (t >= TOK_IDENT) {
        const a = findArg(args, t);
        if (a === null) {
          out.add(t);
        } else {
          let k = i;
          while (k < mstr.len() && mstr.toks[k] === SPC) k++;
          const t2 = k < mstr.len() ? mstr.toks[k] : 0;
          let src = a.str;
          let raw = true;
          if (t2 === TOK_PPJOIN || t1 === TOK_PPJOIN) {
            if (t1 === TOK_PPJOIN && t0 === 44 && a.vaargs) {
              /* `, ## __VA_ARGS__`（`tccpp.c:3053-3067`）。往回退到那个逗号，
               * 把中间的空白与 `##` 都抹掉；实参是空的就连逗号一起抹，非空则
               * 把逗号放回去、**而且把原来紧挨着 `##` 的那个空格也放回去** ——
               * 就是这一格让 tcc 印出 `printf("%d\n" , 7)` 而不是 `,7`。 */
              const lastTok = out.len() > 0 ? out.toks[out.len() - 1] : 0;
              while (out.len() > 0 && out.toks[out.len() - 1] !== 44) {
                out.toks.pop();
                out.vals.pop();
              }
              if (argEmpty(a)) {
                out.toks.pop();
                out.vals.pop();
                t0 = t1;
                t1 = t;
                continue;
              }
              if (lastTok === SPC) out.add(SPC);
              raw = false;
            } else if (argEmpty(a)) {
              out.add(TOK_PLCHLDR); // 空实参在 `##` 两侧要留一个占位（C99）
            }
          } else {
            raw = false;
          }
          if (!raw) {
            if (a.expanded === null) {
              const e = new TokStr();
              this.macroSubst(e, nested, a.str, 0);
              e.add(TOK_EOF);   // 展开过的那一份也以 TOK_EOF 收尾（`tccpp.c:3078`）
              a.expanded = e;
            }
            src = a.expanded;
          }
          for (let m = 0; m < src.len(); m++) {
            if (src.toks[m] === TOK_EOF) break;
            out.add2(src.toks[m], src.vals[m]);
          }
        }
      } else {
        out.add2(t, v);
      }
      if (t !== SPC) {
        t0 = t1;
        t1 = t;
      }
    }
    return out;
  }

  /**
   * `macro_twosharps`（`tccpp.c:3106`）：做 `##`。
   * 关键的一步是**粘完要重新过一遍词法**：`a ## b` 粘成 `ab` 之后它是一个标识符，
   * 而 `+ ## +` 粘成 `++` 是一个记号。tcc 为此临时开一个叫 `:paste:` 的输入
   * （`tccpp.c:3139`），这里同样临时换一个 CFile —— 粘出来的东西不是一个记号时
   * （比如 `1 ## +`）按 tcc 的做法出警告、把它当两个记号，而不是报错。
   */
  macroTwosharps(mstr) {
    const out = new TokStr();
    let i = 0;
    while (i < mstr.len()) {
      let t1 = mstr.toks[i];
      let v1 = mstr.vals[i];
      i++;
      if (t1 === 0) break;
      let pasted = '';
      for (;;) {
        let k = i;
        while (k < mstr.len() && mstr.toks[k] === SPC) k++;
        if (k >= mstr.len() || mstr.toks[k] !== TOK_PPJOIN) break;
        i = k + 1;
        while (i < mstr.len() && (mstr.toks[i] === SPC || mstr.toks[i] === TOK_PPJOIN)) i++;
        const t2 = mstr.toks[i];
        const v2 = mstr.vals[i];
        i++;
        if (t2 === TOK_PLCHLDR) continue;
        if (t1 !== TOK_PLCHLDR) {
          pasted += this.tokStr(t1, v1);
          t1 = TOK_PLCHLDR;
        }
        pasted += this.tokStr(t2, v2);
      }
      if (pasted !== '') {
        for (const [t, v] of this.relex(pasted)) out.add2(t, v);
      }
      if (t1 !== TOK_PLCHLDR) out.add2(t1, v1);
    }
    return out;
  }

  /** 把一段文本重新过一遍词法，回 [tok, val] 的列表（`##` 与 `#` 之后都要走这一步） */
  relex(text) {
    const savedFile = this.file;
    const savedFlags = this.parseFlags;
    const savedTokFlags = this.tokFlags;
    const savedTok = this.tok;
    const savedTokc = this.tokc;
    this.file = new CFile(':paste:', text, null);
    this.parseFlags = 0; // 不认指令：粘出来的 `#` 不是行首的那个（`tccpp.c:3141`）
    this.tokFlags = 0;
    const outs = [];
    for (;;) {
      this.nextNomacro();
      if (this.tok === TOK_EOF) break;
      outs.push([this.tok, this.tokc]);
      if (this.file.pos >= this.file.text.length) break;
      this.warn(`pasting formed more than one token: "${text}"`);
    }
    this.file = savedFile;
    this.parseFlags = savedFlags;
    this.tokFlags = savedTokFlags;
    this.tok = savedTok;
    this.tokc = savedTokc;
    return outs;
  }

  /* ------------------------------------------------- 指令（`preprocess`，tccpp.c:1792） */

  /** `skip_to_eol`（`tccpp.c:1309`）：吃到行末。`warn` 开着时多出来的记号要出警告。 */
  skipToEol(warn) {
    if (this.tok === TOK_LINEFEED) return;
    if (warn) this.warn('extra tokens after directive');
    while (this.macroFrame !== null) this.endMacro();
    this.parseLineComment();
    this.nextNomacro();
  }

  /**
   * `preprocess_skip`（`tccpp.c:874`）：整段跳过不编的代码，一直到配对的
   * `#else` / `#elif` / `#endif`。**不做词法**（跳过的区域里可以有词法上非法的东西），
   * 只认字符串、注释与行首的 `#` —— 但嵌套的 `#if` 要数进去。
   */
  preprocessSkip() {
    let depth = 0;
    let startOfLine = true;
    for (;;) {
      const c = this.peekc();
      if (c === SPC || c === TAB || c === 11 || c === 12 || c === 13) {
        this.file.pos++;
        continue;
      }
      if (c === LF) {
        this.file.lineNum++;
        this.file.pos++;
        startOfLine = true;
        continue;
      }
      if (c === CH_EOF) this.err("#endif expected");
      if (c === 34 || c === 39) {
        this.tokFlags &= ~TOK_FLAG_BOL;
        this.parsePpString(c, false);
        startOfLine = false;
        continue;
      }
      if (c === 47) {
        this.file.pos++;
        const c2 = this.peekc();
        if (c2 === 42) this.parseComment();
        else if (c2 === 47) this.parseLineComment();
        continue;
      }
      if (c === 35) {
        this.file.pos++;
        if (startOfLine) {
          this.nextNomacro();
          if (depth === 0
            && (this.tok === TOK_ELSE || this.tok === TOK_ELIF || this.tok === TOK_ENDIF)) {
            return;
          }
          if (this.tok === TOK_IF || this.tok === TOK_IFDEF || this.tok === TOK_IFNDEF) depth++;
          else if (this.tok === TOK_ENDIF) depth--;
          else if (this.tok === TOK_LINEFEED) continue; // 空指令行
        }
        startOfLine = false;
        continue;
      }
      this.file.pos++;
      startOfLine = false;
    }
  }

  cachedInclude(filename, add) {
    let e = this.cachedIncludes.get(filename);
    if (e === undefined && add) {
      e = { once: false, ifndefMacro: 0 };
      this.cachedIncludes.set(filename, e);
    }
    return e ?? null;
  }

  /**
   * 指令的总入口。调用时 pos 已经在 `#` 之后。
   * 与 tcc 逐条对应的一件事：这里把 parse_flags 换成「认数、认串、认换行」那一套
   * （`tccpp.c:1800`），于是 `#if` 里的 `1 + 2` 拿到的是真数，而 -E 主路上不是。
   */
  preprocess(isBof) {
    const savedFlags = this.parseFlags;
    this.parseFlags = PF_PREPROCESS | PF_TOK_NUM | PF_TOK_STR | PF_LINEFEED;
    let bof = isBof;

    this.nextNomacro();
    for (;;) {
      let c;
      switch (this.tok) {
        case TOK_DEFINE:
          this.ppDebugTok = this.tok;
          this.nextNomacro();
          this.ppDebugSymv = this.tok;
          this.parseDefine();
          break;
        case TOK_UNDEF: {
          this.ppDebugTok = this.tok;
          this.nextNomacro();
          this.ppDebugSymv = this.tok;
          const s = this.defineFind(this.tok);
          if (s !== null) this.defines.delete(this.tok);
          this.nextNomacro();
          break;
        }
        case TOK_INCLUDE:
          this.parseInclude();
          this.parseFlags = savedFlags;
          return;
        case TOK_INCLUDE_NEXT:
          this.parseInclude(true);
          this.parseFlags = savedFlags;
          return;
        case TOK_IFNDEF: case TOK_IFDEF: {
          c = this.tok === TOK_IFNDEF ? 1 : 0;
          this.nextNomacro();
          if (this.tok < TOK_IDENT) {
            this.err(`invalid argument for '#if${c ? 'n' : ''}def'`);
          }
          /* 文件**第一行**就是 `#ifndef X` 的话把 X 记下来：等这个文件读完、
           * 而且 `#endif` 恰好在末尾，就把它登记成 include 守卫（`tccpp.c:1842-1848`）。
           * 这是 tcc 不用 `#pragma once` 也能跳过重复 include 的办法。 */
          if (bof && c) this.file.ifndefMacro = this.tok;
          /* `#ifdef __has_include` 也是**真**（`tccpp.c:1850-1853`，与 `defined` 那一格
           * 同一条判断）。少了这一下，macOS 的 `<sys/cdefs.h>` 会走「这编译器没有
           * `__has_include`」那一支、把它 `#define` 成一个恒回 0 的宏 —— 从那以后
           * SDK 里每一处 `__has_include(...)` 都答「没有」，整份头文件的配置全变。
           * 第一处看得见的后果：`malloc/_malloc.h:35` 因此去 `#include <stddef.h>`，
           * 于是 `offsetof` 提前有了定义，`tcc.h:107` 那个 `#ifndef offsetof` 就不成立。 */
          if (this.defineFind(this.tok) !== null
            || this.tok === TOK___HAS_INCLUDE || this.tok === TOK___HAS_INCLUDE_NEXT) {
            c ^= 1;
          }
          this.nextNomacro();
          this.ifdefStack.push(c);
          if (!(c & 1)) {
            this.skipToEol(true);
            this.preprocessSkip();
            bof = false;
            continue;
          }
          break;
        }
        case TOK_IF:
          c = this.exprPreprocess() ? 1 : 0;
          this.ifdefStack.push(c);
          if (!(c & 1)) {
            this.skipToEol(true);
            this.preprocessSkip();
            bof = false;
            continue;
          }
          break;
        case TOK_ELSE: {
          this.nextNomacro();
          if (this.ifdefStack.length === 0) this.err('#else without matching #if');
          const top = this.ifdefStack[this.ifdefStack.length - 1];
          if (top & 2) this.err('#else after #else');
          c = top ^ 3;
          this.ifdefStack[this.ifdefStack.length - 1] = c;
          if (this.ifdefStack.length === this.file.ifdefBase + 1) this.file.ifndefMacro = 0;
          if (!(c & 1)) {
            this.skipToEol(true);
            this.preprocessSkip();
            bof = false;
            continue;
          }
          break;
        }
        case TOK_ELIF: {
          if (this.ifdefStack.length === 0) this.err('#elif without matching #if');
          c = this.ifdefStack[this.ifdefStack.length - 1];
          if (c > 1) this.err('#elif after #else');
          if (c === 1) {
            // 前面那一支已经成立了：这一支连求值都不做（`tccpp.c:1875`）
            this.skipToEol(false);
            c = 0;
          } else {
            c = this.exprPreprocess() ? 1 : 0;
            this.ifdefStack[this.ifdefStack.length - 1] = c;
          }
          if (this.ifdefStack.length === this.file.ifdefBase + 1) this.file.ifndefMacro = 0;
          if (!(c & 1)) {
            this.skipToEol(true);
            this.preprocessSkip();
            bof = false;
            continue;
          }
          break;
        }
        case TOK_ENDIF:
          this.nextNomacro();
          if (this.ifdefStack.length <= this.file.ifdefBase) {
            this.err('#endif without matching #if');
          }
          this.ifdefStack.pop();
          if (this.file.ifndefMacro && this.ifdefStack.length === this.file.ifdefBase) {
            this.file.ifndefMacroSaved = this.file.ifndefMacro;
            this.file.ifndefMacro = 0;
            this.tokFlags |= TOK_FLAG_ENDIF;
          }
          break;
        case TOK_LINE:
        case TOK_PPNUM:
          this.parseLineDirective();
          break;
        case TOK_ERROR:
        case TOK_WARNING: {
          const isErr = this.tok === TOK_ERROR;
          let msg = '';
          let ch = this.skipSpaces();
          while (ch !== LF && ch !== CH_EOF) {
            msg += String.fromCharCode(ch);
            ch = this.ninp();
          }
          if (isErr) this.err(`#error ${msg}`);
          this.warn(`#warning ${msg}`);
          this.nextNomacro();
          break;
        }
        case TOK_PRAGMA:
          if (!this.pragmaParse()) {
            this.skipToEol(false);
            this.parseFlags = savedFlags;
            return;
          }
          break;
        case TOK_LINEFEED: // 空指令行 `#`
          this.parseFlags = savedFlags;
          return;
        default:
          if (this.tok === 33 && bof) {
            // `#!` 在文件开头是 shebang，忽略（`tccpp.c:1973`）
            this.skipToEol(false);
            this.parseFlags = savedFlags;
            return;
          }
          this.warn(`ignoring unknown preprocessing directive #${this.tokStr(this.tok, this.tokc)}`);
          this.skipToEol(false);
          this.parseFlags = savedFlags;
          return;
      }
      break;
    }
    this.skipToEol(true);
    this.parseFlags = savedFlags;
  }

  /** `#line N ["file"]`，以及 `# N "file"`（`tccpp.c:1910-1943`） */
  parseLineDirective() {
    if (this.tok === TOK_LINE) {
      this.parseFlags &= ~PF_TOK_NUM;
      this.next();
      if (this.tok !== TOK_PPNUM) this.err('wrong #line format');
    }
    const text = String(this.tokc);
    if (!/^[0-9]+$/.test(text)) this.err('wrong #line format');
    const n = Number(text);
    this.parseFlags &= ~PF_TOK_STR; // 文件名里的转义不解（`tccpp.c:1929`）
    this.next();
    if (this.tok !== TOK_LINEFEED) {
      if (this.tok !== TOK_PPSTR || String(this.tokc).charCodeAt(0) !== 34) {
        this.err('wrong #line format');
      }
      this.putFile(String(this.tokc).slice(1, -1));
      this.next();
      this.skipToEol(false);
    }
    this.file.lineNum = n;
  }

  /**
   * `tccpp_putfile`（`tccpp.c:1769`）：`#line N "别名"` 里的相对路径要**接在真文件
   * 所在的目录后面**，不是原样用。量过 tcc：`#line 200 "renamed.c"` 之后 `__FILE__`
   * 是 `/…/tests/c/cpp/renamed.c`，不是 `renamed.c`。
   */
  putFile(name) {
    const buf = isAbsPath(name)
      ? name
      : this.joinPath(this.dirnameOf(this.file.trueFilename), name);
    if (buf === this.file.filename) return;
    this.file.filename = buf;
  }

  /**
   * `parse_define`（`tccpp.c:1519`）。三处刻意照抄：
   *   1. `(` 必须**紧贴**宏名才是函数式宏 —— `#define F (x)` 是个对象式宏，体是 `(x)`。
   *      靠的是「读形参表之前不开 PF_SPACES」这个顺序，不是靠比较列号。
   *   2. 宏体里连续的空白折成一个（`needSpc`），首尾的空白不留 —— 于是
   *      `#define A 1` 与 `#define A   1  ` 是同一个宏（重定义检查要靠这一条）。
   *   3. `##` 不能出现在宏体的两端，两端都要报错，而且**报在同一句话上**。
   */
  parseDefine() {
    const v = this.tok;
    if (v < TOK_IDENT || v === TOK_DEFINED) {
      this.err(`invalid macro name '${this.tokStr(this.tok, this.tokc)}'`);
    }
    let type = MACRO_OBJ;
    let args = null;

    this.parseFlags |= PF_SPACES;
    this.nextNomacro();
    this.parseFlags &= ~PF_SPACES;
    if (this.tok === 40) { // '(' 紧贴宏名
      args = [];
      this.nextNomacro();
      if (this.tok !== 41) {
        for (;;) {
          let varg = this.tok;
          this.nextNomacro();
          let vaargs = false;
          if (varg === TOK_DOTS) {
            varg = TOK___VA_ARGS__;
            vaargs = true;
          } else if (this.tok === TOK_DOTS) {
            vaargs = true; // gcc 的 `args...` 写法
            this.nextNomacro();
          }
          if (varg < TOK_IDENT) this.err('bad macro parameter list');
          args.push({ v: varg, vaargs });
          if (this.tok === 41) break;
          if (this.tok !== 44 || vaargs) this.err('bad macro parameter list');
          this.nextNomacro();
        }
      }
      this.parseFlags |= PF_SPACES;
      this.nextNomacro();
      type = MACRO_FUNC;
    }

    this.parseFlags |= PF_ACCEPT_STRAYS | PF_SPACES | PF_LINEFEED;
    const str = new TokStr();
    let t0 = 0;
    while (this.tok !== TOK_LINEFEED && this.tok !== TOK_EOF) {
      if (this.tok === SPC || this.tok === TAB) {
        str.needSpc |= 1;
      } else {
        let t = this.tok;
        if (t === TOK_TWOSHARPS) {
          if (t0 === 0) this.err("'##' cannot appear at either end of macro");
          t = TOK_PPJOIN;
          type |= MACRO_JOIN;
        }
        str.add2Spc(t, this.tokc);
        t0 = t;
      }
      this.nextNomacro();
    }
    if (t0 === TOK_PPJOIN) this.err("'##' cannot appear at either end of macro");
    /* `define_push`（`tccpp.c:1252`）：**先**看有没有旧的，装上去之后再决定要不要抱怨。
     * 「一样」的判断（`macro_is_equal`）不比记号号，比的是**印出来的字符串**。量过：
     * `#define T  2` 与 `#define T 2` 不响（宏名后头那几个空格不进宏体），
     * `#define A 0x10` 与 `#define A 16` 响（`TOK_PPNUM` 存的是原文）。 */
    const o = this.defineFind(v);
    this.defines.set(v, { type, str, args, special: false });
    if (o !== null && o !== undefined && !macroIsEqual(this, o.str, str)) {
      this.warn(`${IDENT_NAMES[v] ?? this.tokStr(v, null)} redefined`);
    }
  }

  /** `#pragma pack(N)` 里那个 N：1/2/4/8/16 之一（tcc 的 `val < 1 || val > 16 || 非 2 的幂`）。 */
  packNumber() {
    if (this.tok !== TOK_CINT) this.err('malformed #pragma directive');
    const val = Number(this.tokc);
    if (val < 1 || val > 16 || (val & (val - 1)) !== 0) this.err('malformed #pragma directive');
    this.next();
    return val;
  }

  /** `#pragma`（`tccpp.c:1654`）。回 false = 这一行原样跳过。 */
  pragmaParse() {
    this.nextNomacro();
    if (this.tok === TOK_push_macro || this.tok === TOK_pop_macro) {
      const isPush = this.tok === TOK_push_macro;
      this.next();
      if (this.tok !== 40) this.err('malformed #pragma directive');
      this.next();
      if (this.tok !== TOK_STR) this.err('malformed #pragma directive');
      const v = this.tokAlloc(String(this.tokc));
      this.next();
      if (this.tok !== 41) this.err('malformed #pragma directive');
      if (isPush) {
        const stack = this.macroStash.get(v) ?? [];
        stack.push(this.defineFind(v));
        this.macroStash.set(v, stack);
      } else {
        const stack = this.macroStash.get(v);
        if (stack === undefined || stack.length === 0) {
          this.warn('unbalanced #pragma pop_macro');
        } else {
          const prev = stack.pop();
          if (prev === null) this.defines.delete(v);
          else this.defines.set(v, prev);
        }
      }
      this.ppDebugTok = isPush ? TOK_push_macro : TOK_pop_macro;
      this.ppDebugSymv = v;
      this.next();
      return true;
    }
    if (this.tok === TOK_once) {
      this.cachedInclude(this.file.trueFilename, true).once = true;
      this.next();
      return true;
    }
    /* **只预处理时，下面这些 pragma 一律原样印回**（`tccpp.c:1688-1694`）——
     * 注意这一支在 tcc 那边排在 `pack` **前面**：`tcc -E` 不解释 `#pragma pack`，
     * 它是给下一道工序看的。四个 unget 倒着叠，读出来正好是换行、`#`、`pragma`、
     * 空格，然后接着读这一行剩下的部分。 */
    if (this.ppOnly) {
      this.ungetTok(SPC);
      this.ungetTok(TOK_PRAGMA);
      this.ungetTok(35);
      this.ungetTok(TOK_LINEFEED);
      return true;
    }
    /* `#pragma pack`（`tccpp.c:1696-1735`）：**它改的是 struct 的布局**，所以必须
     * 真的实现，不能吃掉也不能原样印回。五种写法：
     *   `pack(N)` 设成 N、`pack()` 回默认、`pack(push)` 压栈、`pack(push,N)` 压栈并设、
     *   `pack(pop)` 弹栈。
     * 0 = 「没有 pack」（按类型自己的对齐来）。macOS 的 `<sys/fcntl.h>` 用 `pack(4)`。 */
    if (this.tok === TOK_pack) {
      this.next();
      if (this.tok !== 40) this.err('malformed #pragma directive');
      this.next();
      if (this.tok === TOK_pop) {
        this.next();
        if (this.packStack.length <= 1) this.err('out of pack stack');
        this.packStack.pop();
      } else {
        let val = 0;
        if (this.tok !== 41) {
          if (this.tok === TOK_push) {
            this.next();
            val = this.packStack[this.packStack.length - 1];
            this.packStack.push(val);
            if (this.tok === 44) { // ','
              this.next();
              val = this.packNumber();
            }
          } else {
            val = this.packNumber();
          }
        }
        this.packStack[this.packStack.length - 1] = val;
      }
      if (this.tok !== 41) this.err('malformed #pragma directive');
      this.next();
      return true;
    }
    /* 编译那一路上，认不出的 pragma **警告一句然后整行丢掉**
     * （`tccpp.c:1758-1760`）。不能原样印回 —— 那些记号会漏进语法分析器，
     * 而 `#pragma GCC diagnostic …` 不是一个声明。那一句是 `-Wall` 才响的。 */
    this.warnAllMsg(`#pragma ${this.tokStr(this.tok, this.tokc)} ignored`);
    return false;
  }

  /** `parse_include`（`tccpp.c:1324`）。`doNext` = `#include_next`。 */
  parseInclude(doNext = false) {
    const { name, kind } = this.parseIncludeName();
    this.skipToEol(true);

    for (const t of this.includeTries(name, kind, doNext)) {
      const e = this.cachedInclude(t.path, false);
      if (e !== null && (e.once || (e.ifndefMacro && this.defineFind(e.ifndefMacro) !== null))) {
        /* 守卫已经定义过或者 `#pragma once`：整份跳过，连读都不读。
         * `-vv[v]` 下印一行 `=>`（`tccpp.c:1398`）—— 这是「省了一次读」的凭据。 */
        if ((this.verbose | 1) === 3) this.traceLine('=>', t.path);
        return;
      }
      const text = this.readFile(t.path);
      if (text === null) {
        /* `-vvv` 连试不开的也印（`nf` = not found，libtcc.c:784）。 */
        if (this.verbose === 3) this.traceLine('nf', t.path);
        continue;
      }
      if (this.verbose >= 2) this.traceLine('->', t.path);
      if (this.includeStack.length >= 64) this.err('#include recursion too deep');
      this.includeStack.push(this.file);
      const f = new CFile(t.path, text, this.file);
      f.ifdefBase = this.ifdefStack.length;
      f.includeNextIndex = t.i;
      this.file = f;
      /* `-M` 那一路记一笔（`tccpp.c:1418`）。「在 include 它的那份的目录里找到的」
       * （`i === 1`）自己算不清是不是系统头 —— 顺着 `prev` 往上找到第一个不是 1 的
       * 下标，拿祖先的身份当自己的。于是系统头旁边的 `"foo.h"` 也算系统头。 */
      if (this.genDeps) {
        let i = t.i;
        let bf = f;
        while (i === 1 && (bf = bf.prev) !== null && bf !== undefined) i = bf.includeNextIndex;
        if (this.includeSysDeps || i - 2 < this.includeDirs.length) this.targetDeps.push(t.path);
      }
      this.tokFlags = TOK_FLAG_BOL | TOK_FLAG_BOF;
      return;
    }
    this.err(`include file '${name}' not found`);
  }

  /**
   * 头文件名那一段（`parse_include` 的前半，`tccpp.c:1326-1357`）。**读的是原始字符**，
   * 不是记号 —— `<sys/types.h>` 里那些斜杠与点在记号层面不是一个东西。
   *
   * 单独拆出来是因为 `__has_include(...)` 要的正是同一段（tcc 那边是同一个函数的
   * `do_test` 分支）：名字怎么读、按什么顺序找，两处必须一个字不差。
   */
  parseIncludeName() {
    const c = this.skipSpaces();
    if (c === 60 || c === 34) { // '<' '"'
      const name = this.parsePpString(c === 60 ? 62 : c, true);
      this.nextNomacro();
      return { name, kind: c };
    }
    /* 「算出来的 include」：`#include HEADER`，宏展开之后拼成 `"a.h"` 或 `<a.h>`
     * （`tccpp.c:1337-1357`）。拼的是**印回文本**，所以中间的空格会进去 —— tcc 如此。 */
    this.parseFlags = PF_PREPROCESS | PF_LINEFEED;
    let acc = '';
    for (;;) {
      this.next();
      const n = acc.length - 1;
      if (n > 0
        && ((acc[0] === '"' && acc[n] === '"') || (acc[0] === '<' && acc[n] === '>'))) break;
      if (this.tok === TOK_LINEFEED) this.err("'#include' expects \"FILENAME\" or <FILENAME>");
      acc += this.tokStr(this.tok, this.tokc);
    }
    return { name: acc.slice(1, acc.length - 1), kind: acc.charCodeAt(0) };
  }

  /**
   * 一个头文件名摊成一串候选路径，顺序照 `tccpp.c:1364-1405`：绝对路径 ->
   * `"..."` 才看的「当前文件所在目录」-> `-I` 给的那些 -> **系统目录**
   * （`sysinclude_paths`，第八刀第二片）。系统目录在最后，而且 `"..."` 也会走到那儿 ——
   * tcc 就是这个顺序，于是 `#include "stddef.h"` 与 `#include <stddef.h>` 都能找到
   * 自带的那一份。
   *
   * 回的每一格都带上 tcc 的那个下标 `i`：0 = 绝对路径、1 = 当前文件所在目录、
   * `2 + j` = 第 j 个 `-I`、再往后是系统目录。跳过的格子**也占号**（`i` 是照着
   * `for(;;) ++i` 数的），因为 `-M` 拿 `i - 2 < nb_include_paths` 分自己的头与系统的头。
   *
   * `doNext`（`#include_next` / `__has_include_next`）：从**当前这份文件是在哪一格
   * 找到的**之后接着数（`i = file->include_next_index` 起步，`tccpp.c:1363`）。
   * 于是 `-I a -I b` 下 `a/x.h` 里的 `#include_next <x.h>` 会拿到 `b/x.h` ——
   * 「盖一层但还要用底下那一层」就是这么写的。
   */
  includeTries(name, kind, doNext = false) {
    const from = doNext ? this.file.includeNextIndex + 1 : 0;
    const tries = [];
    const put = (i, path) => { if (i >= from) tries.push({ path, i }); };
    if (isAbsPath(name)) put(0, name);
    if (kind === 34) put(1, this.joinPath(this.dirnameOf(this.file.trueFilename), name));
    let i = 2;
    for (const d of this.includeDirs) put(i++, this.joinPath(d, name));
    for (const d of this.sysIncludeDirs) put(i++, this.joinPath(d, name));
    /* framework（macOS）：`Foo/Bar.h` -> `<F>/Foo.framework/Headers/Bar.h`。
       排在最后，与 clang 一样 —— 普通目录里真有一个 `OpenGL/gl.h` 时那一份优先。
       名字里没有斜杠就不是 framework 的写法（`<stdio.h>` 不该去试 `stdio.framework`）。 */
    const slash = name.indexOf('/');
    if (slash > 0 && this.frameworkDirs.length > 0) {
      const fw = name.slice(0, slash);
      const rest = name.slice(slash + 1);
      for (const d of this.frameworkDirs) {
        put(i++, this.joinPath(this.joinPath(d, `${fw}.framework`), this.joinPath('Headers', rest)));
      }
    }
    return tries;
  }

  /**
   * `__has_include(<x.h>)`（tcc 的 `parse_include(s1, 0, 1)`，`tccpp.c:1480`）：
   * 只问「找不找得到」，不打开、不进 include 栈、不碰守卫缓存。
   * macOS 的 `<Availability.h>` 一进门就用它。
   */
  hasInclude(doNext = false) {
    const { name, kind } = this.parseIncludeName();
    for (const t of this.includeTries(name, kind, doNext)) {
      /* tcc 的 test 模式也是真开一次再关掉（`parse_include(…, 1)` -> `tcc_open`），
       * 所以 `-vv[v]` 的那几行照印。 */
      if (this.readFile(t.path) !== null) {
        if (this.verbose >= 2) this.traceLine('->', t.path);
        return true;
      }
      if (this.verbose === 3) this.traceLine('nf', t.path);
    }
    return false;
  }

  /* ------------------------------------------------- `#if` 的求值
   * tcc 把这件事交给 tccgen 的 `expr_const()`（`tccpp.c:1501`）—— 它复用了整个 C 的
   * 表达式解析器。我们这里还没有那个东西，所以自带一个只管整数的求值器。
   * 这**不是**偷懒：`#if` 的算术在标准里就只有 intmax_t，浮点与字符串都要报错。
   * 宽度固定 64 位，无符号性会沿着运算传播 —— 与 C 的常量表达式规则一致。 */

  /** `expr_preprocess`（`tccpp.c:1435`）：先把整行展开成记号流，再求值。 */
  exprPreprocess() {
    const t0 = this.tok;
    const str = new TokStr();
    this.ppExpr = 1;
    for (;;) {
      this.next();
      let t = this.tok;
      if (t < TOK_IDENT) {
        if (t === TOK_LINEFEED || t === TOK_EOF) break;
        if (t >= TOK_STR && t <= TOK_CLDOUBLE) {
          this.err('invalid constant in preprocessor expression');
        }
        str.add2(t, this.tokc);
        continue;
      }
      if (t === TOK_DEFINED) {
        /* `defined X` 与 `defined(X)`：这中间**不能**展开宏，所以要临时关掉
         * PF_PREPROCESS（`tccpp.c:1453`）。少了这一下，`defined(FOO)` 里的 FOO
         * 会先被展开成它的值，`defined` 就永远是假的。 */
        this.parseFlags &= ~PF_PREPROCESS;
        this.next();
        const paren = this.tok === 40;
        if (paren) this.next();
        this.parseFlags |= PF_PREPROCESS;
        if (this.tok < TOK_IDENT) this.err("identifier expected after 'defined'");
        /* `defined(__has_include)` 是**真**（`tccpp.c:1464-1467`）：它不是一个宏，
         * 但要装成「有这个宏」，否则头文件会走「这编译器没有 __has_include」那一支。 */
        const c = (this.defineFind(this.tok) !== null
          || this.tok === TOK___HAS_INCLUDE || this.tok === TOK___HAS_INCLUDE_NEXT) ? 1n : 0n;
        if (paren) {
          this.next();
          if (this.tok !== 41) this.err("')' expected");
        }
        str.add2(TOK_CLLONG, c);
        continue;
      }
      if (t === TOK___HAS_INCLUDE || t === TOK___HAS_INCLUDE_NEXT) {
        /* `__has_include(<x.h>)`（`tccpp.c:1474-1483`）。名字那一段读的是**原始字符**，
         * 所以这儿的形状照 tcc：先 `next()` 拿到 `(`，再让 `hasInclude()` 从文件里
         * 往下读，读完它已经把 `)` 摆在 `this.tok` 上。
         * tcc 那边两条是同一句 `parse_include(s1, t - TOK___HAS_INCLUDE, 1)` —— 差别
         * 只在「从第几格接着找」。 */
        this.next();
        if (this.tok !== 40) this.err("'(' expected");
        const c = this.hasInclude(t === TOK___HAS_INCLUDE_NEXT) ? 1n : 0n;
        if (this.tok !== 41) this.err("')' expected");
        str.add2(TOK_CLLONG, c);
        continue;
      }
      // 没定义的宏名在 `#if` 里就是 0（C 的规定）
      str.add2(TOK_CLLONG, 0n);
    }
    if (str.len() === 0) this.err(`#${this.tokStr(t0, null)} with no expression`);

    /* 求值这一段里 `ppExpr` 记的是 `#if` / `#elif` 本身（tcc 的 `pp_expr = t0`，
     * `tccpp.c:1496`）—— 它同时是「出错要转印记号流」的开关，见 `err`。 */
    this.ppExpr = t0;
    this.ppExprStr = str;
    const ev = { str, i: 0, cpp: this };
    const val = evalCond(ev);
    if (ev.i < str.len()) this.err('bad preprocessor expression');
    this.ppExpr = 0;
    this.ppExprStr = null;
    return val.v !== 0n;
  }

  /**
   * `pp_error`（`tccpp.c:1510`）：`#if` 求值出的错不报原话，改印**整条展开后的记号流**。
   *
   * `#if ! 0 || ! 0 ( 0 )` 这样的东西是一串宏套出来的，源码那一行长得完全不一样；
   * 对账的时候唯一有用的线索就是这一串。所以 tcc 宁可丢掉具体的错因。
   */
  ppErrorMsg() {
    let s = `bad preprocessor expression: #${this.tokStr(this.ppExpr, null)}`;
    const str = this.ppExprStr;
    for (let i = 0; str !== null && i < str.len(); i++) {
      s += ` ${this.tokStr(str.toks[i], str.vals[i])}`;
    }
    return s;
  }

  /* ------------------------------------------------- 输出（`tcc_preprocess`，tccpp.c:3891） */

  /**
   * 把一份 `.c` 预处理成文本。**格式与 `tcc -E -P` 逐字节相同** —— 那是这一刀的
   * 主测试轴（`tests/c/`）。
   *
   * 三条规矩全在这个循环里，一条都不能少：
   *   1. 空白**按源码原样**带过去（连续的多个空格是多个空格），但一行开头的空白丢掉；
   *   2. 连续的空行折成一个换行（`-P` 不补空行，也不发行号标记）；
   *   3. 相邻两个记号如果贴在一起会粘成另一个记号，就插一个空格 —— `ppNeedSpace()`。
   *      这一条是「输出还能再被读一遍」的全部保证。
   */
  /**
   * `tok_print`（`tccpp.c:3772`）：把一条记号流印成一行，末尾带换行。
   *
   * 空格那一格容易看反：tcc 写的是 `fprintf(fp, &" %s"[s], …)` —— `s === 0` 指向
   * `" %s"`（**带**前导空格），`s === 1` 跳过那个空格。头一个记号 `s` 是 0，所以
   * `#define A` 后面那个空格是从这儿来的；之后一律不加空格，只有 `ppNeedSpace`
   * 说「这两个挨着会粘成一个记号」时才把 `s` 拨回 0 补一个。
   *
   * 宏体里**本来就有的**空格是 `add2Spc` 存进去的 `SPC` 记号，与这一层无关。
   */
  tokPrint(str, prefix) {
    let out = prefix;
    let s = 0;
    let t0 = 0;
    const toks = str === null || str === undefined ? [] : str.toks;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === 0 || t === TOK_EOF) break;
      if (ppNeedSpace(t0, t)) s = 0;
      out += (s === 0 ? ' ' : '') + (t === TOK_PLCHLDR ? '<>' : this.tokStr(t, str.vals[i]));
      s = 1;
      t0 = t;
    }
    return `${out}\n`;
  }

  /** `define_print`（`tccpp.c:3817`）：`__LINE__` 那一族没有宏体（`s->d == NULL`），不印。 */
  definePrint(v) {
    const s = this.defineFind(v);
    if (s === null || s === undefined || s.special === true) return '';
    let head = `#define ${IDENT_NAMES[v] ?? this.tokStr(v, null)}`;
    if ((s.type & MACRO_FUNC) !== 0) {
      head += `(${(s.args ?? []).map((a) => this.tokStr(a.v, null)).join(',')})`;
    }
    return this.tokPrint(s.str, head);
  }

  /** `pp_debug_defines`（`tccpp.c:3843`）：刚过去那一条指示印成一行。 */
  ppDebugDefines() {
    const t = this.ppDebugTok;
    if (t === 0) return '';
    const v = this.ppDebugSymv;
    const vs = IDENT_NAMES[v] ?? this.tokStr(v, null);
    this.ppDebugTok = 0;
    if (t === TOK_DEFINE) return this.definePrint(v);
    if (t === TOK_UNDEF) return `#undef ${vs}\n`;
    if (t === TOK_push_macro) return `#pragma push_macro("${vs}")\n`;
    if (t === TOK_pop_macro) return `#pragma pop_macro("${vs}")\n`;
    return '';
  }

  /**
   * `-vv[v]` 的一行（libtcc.c:785）：`printf("%s %*s%s\n", 记号, 深度, "", 路径)` ——
   * 记号、一个空格、**按 include 深度补的那几个空格**、路径。深度是压栈**之前**的
   * （tcc 那边 `_tcc_open` 在 `*include_stack_ptr++` 之前跑），所以主文件与它直接
   * include 的那几份都是 0 个空格。
   */
  traceLine(mark, path) {
    this.traceOut += `${mark} ${' '.repeat(this.includeStack.length)}${path}\n`;
  }

  /** 攒着的 trace 倒出来（`preprocessToText` 每读一个记号叫一次）。 */
  takeTrace() {
    const s = this.traceOut;
    this.traceOut = '';
    return s;
  }

  /**
   * `pp_line`（`tccpp.c:3796`）：把「现在在哪个文件的哪一行」交代给下游。
   *
   * 四种走法（`Pflag`）：不印、补几个换行、`#line`、`# 行号 "文件"`。
   * 要紧的是**第二支在第三四支前面**：只要 `level === 0`（没进出文件）、这个文件先前印过
   * 行标（`lineRef !== 0`）、而且落后不到 8 行，就**补换行而不是印行标** —— 行号靠数行
   * 对上，输出比行标干净。差 8 行以上才值得印一行。
   *
   * `level`：> 0 = 刚进一个文件（行尾 ` 1`），< 0 = 刚出来（` 2`），0 = 同一个文件里跳。
   * `-dM`（`dflag & 4`）一进来就返回 —— 那一路连 `lineRef` 都不动。
   */
  ppLine(f, level) {
    if ((this.dflag & 4) !== 0) return '';
    let out = '';
    let d = f.lineNum - f.lineRef;
    if (this.Pflag === 1) {
      // LINE_MACRO_OUTPUT_FORMAT_NONE：一个字不印
    } else if (level === 0 && f.lineRef !== 0 && d < 8) {
      while (d > 0) { out += '\n'; d--; }
    } else if (this.Pflag === 2) {
      out = `#line ${f.lineNum} "${f.filename}"\n`;
    } else {
      out = `# ${f.lineNum} "${f.filename}"${level > 0 ? ' 1' : ''}${level < 0 ? ' 2' : ''}\n`;
    }
    f.lineRef = f.lineNum;
    return out;
  }

  preprocessToText(filename, text) {
    this.ppOnly = true;
    this.installPredefs(filename);
    /* 主文件那一行 trace。它有**两个**出处，量过 tcc 才看得见：`-v`（verbose 1）
     * 是 `tcc.c:380` 在开工前对每个命令行上的输入文件印的（`if (1 == s->verbose)
     * printf("-> %s\n", f->name)`，没有缩进那一格）；`-vv[v]` 那一行则是 `_tcc_open`
     * 印的，深度 0 —— 两处印出来的字节正好一样，于是这儿一条就够。
     * 正文由调用方读进来交给我们，所以这一行只能在这儿补。 */
    if (this.verbose >= 1) this.traceLine('->', filename);
    this.file = new CFile(filename, text, null);
    this.file.ifdefBase = 0;
    this.parseFlags = PF_PREPROCESS | PF_LINEFEED | PF_SPACES | PF_ACCEPT_STRAYS;
    /* `-P10`（Pflag 11）：数字当场解成有类型的常量再印回去 —— 于是十六进制与浮点都成了
     * 十进制。Bellard 当年拿这一路让 tcc 编译自己（`tccpp.c:3904` 那段注释）。
     * 认过一次之后它就当 1（什么行标都不印）用。 */
    if (this.Pflag === 11) {
      this.parseFlags |= PF_TOK_NUM;
      this.Pflag = 1;
    }
    this.tokFlags = TOK_FLAG_BOL | TOK_FLAG_BOF;
    this.pushCmdlineFile();

    let out = this.takeTrace();
    let tokenSeen = TOK_LINEFEED;
    let white = '';
    /* 开工先交代一次「现在在哪」。`file.prev` 非空是「主文件本身就是被 include 进来的」
     * 那一路（tcc 里 `<command line>` 那份预定义源码就是这么挂上去的）。 */
    let level = 0;
    if (this.file.prev !== null && this.file.prev !== undefined) {
      out += this.ppLine(this.file.prev, level++);
    }
    out += this.ppLine(this.file, level);
    /* `<command line>` 那一层过掉时攒下的行：`-dD`/`-dM` 的 `#define`/`#undef`，以及
     * 诊断前那个换行。tcc 是在**循环里**读那份缓冲时印的，所以它们排在上面两行行标
     * 之后 —— 量过 `tcc -E -D__TINYC__=1`：那个空行正落在 `<command line>" 1` 与
     * 回到主文件的 `" 2` 之间。
     *
     * `-dD`/`-dM` 印出来的次序就是**命令行次序**：预定义、`__BASE_FILE__`、再按次序
     * 一条条 `-D`/`-U`。两处能看见差别：被 `-U` 掉的预定义照印一遍 `#define`（它确实
     * 定义过），从没定义过的名字也照印 `#undef`（那一条指示确实过去了）。 */
    out += this.cmdlineDump;
    this.ppDebugTok = 0;
    for (;;) {
      const iptr = this.includeStack.length;
      this.next();
      /* `-vv[v]` 的那几行在 tcc 那边是 `next()` 里头印的，所以排在行标**前面**。 */
      if (this.verbose >= 2) out += this.takeTrace();
      /* 诊断前那个空行也是 `next()` 里头落的（`error1`），同样排在行标前面。 */
      out += this.takePpNl();
      if (this.tok === TOK_EOF) break;
      /* 这一个记号是不是把我们带进/带出了一个文件？带进来的话先给**来处**补一行
       * （`pp_line(*iptr, 0)`：`iptr` 那一格里放的正是压栈时的当前文件），再给新文件印
       * 一行带 ` 1`；出来只印一行带 ` 2`。 */
      level = this.includeStack.length - iptr;
      if (level !== 0) {
        if (level > 0) out += this.ppLine(this.includeStack[iptr], 0);
        out += this.ppLine(this.file, level);
      }
      /* `-dD`/`-dM`：刚过去那一条 `#define`/`#undef`/`#pragma *_macro` 印成一行。
       * `-dM`（`& 4`）连记号流那一半都不印 —— 输出就只剩这些行。 */
      if ((this.dflag & 7) !== 0) {
        out += this.ppDebugDefines();
        if ((this.dflag & 4) !== 0) continue;
      }
      if (this.tok === SPC || this.tok === TAB) {
        white += String.fromCharCode(this.tok);
        continue;
      }
      if (this.tok === TOK_LINEFEED) {
        white = '';
        if (tokenSeen === TOK_LINEFEED) continue;
        /* 真印出去的那个换行也要记一笔 —— 否则 `pp_line` 会以为落后了一行。 */
        this.file.lineRef++;
      } else if (tokenSeen === TOK_LINEFEED) {
        /* 一行的第一个记号：先交代行号。`-P` 下 `pp_line` 什么都不印，而攒下来的空白
         * **照印** —— 量过 tcc：`    int    b;` 出来还是 `    int    b;`，缩进一个字节不差。
         * （这里曾经手滑清掉了 white，于是所有缩进都消失 —— 逐字节比对当场抓住。） */
        out += this.ppLine(this.file, 0);
      } else if (white === '' && ppNeedSpace(tokenSeen, this.tok)) {
        white = ' ';
      }
      const s = this.tokStr(this.tok, this.tokc);
      out += white + s;
      white = '';
      tokenSeen = ppCheckHe0xE(this.tok, s);
    }
    if (this.ifdefStack.length !== 0) this.err('missing #endif');
    return out;
  }

  /**
   * 给**编译**那一路开工（`tccgen_compile`，`tccgen.c:417`）。
   * 开关与 tcc 那一行一模一样：`PREPROCESS | TOK_NUM | TOK_STR` —— 三个都在，于是
   *   - 宏照展开（PREPROCESS），
   *   - `TOK_PPNUM` 当场变成有类型的整数/浮点常量（TOK_NUM，见 convert），
   *   - `TOK_PPSTR` 当场解成字符/字符串常量（TOK_STR）。
   * **没有** LINEFEED 与 SPACES：空白与换行在这一路上根本不出现在记号流里，
   * 所以语法分析器不必自己滤空白 —— 这是 tcc 一遍过的前提之一。
   * 调用方随后自己叫一次 `next()`（tcc 也是这么排的：`parse_flags = …; next(); decl(…)`）。
   */
  startParse(filename, text) {
    this.installPredefs(filename, false);
    this.file = new CFile(filename, text, null);
    this.file.ifdefBase = 0;
    this.parseFlags = PF_PREPROCESS | PF_TOK_NUM | PF_TOK_STR;
    this.tokFlags = TOK_FLAG_BOL | TOK_FLAG_BOF;
    this.pushCmdlineFile();
  }

  /** 命令行上的 `-D name[=body]`（tcc 的 `tcc_define_symbol`） */  define(name, body) {
    this.cmdlineLine(`#define ${name}${body === undefined ? '' : ` ${body}`}\n`);
  }

  /**
   * 命令行上的 `-U name`（tcc 的 `tcc_undefine_symbol`，libtcc.c:863）。
   * tcc 把 `-D` 与 `-U` **写进同一个缓冲**，所以它们共用一条顺序 ——
   * `-DX=1 -UX` 与 `-UX -DX=1` 结果不同，这一格就是这么来的。
   */
  undefine(name) {
    this.cmdlineLine(`#undef ${name}\n`);
  }

  /**
   * `<command line>` 那一层（tcc 的 `preprocess_start`，`tccpp.c:3653-3666`）。
   *
   * tcc 把**预定义 + `-D`/`-U` + `-include`** 拼成一份源码，压在主文件上面开出来
   * ——「命令行」在 tcc 那儿是一个真的 include 层，读完了才回到主文件。我们的预定义与
   * `-D` 是直接进宏表的（见 `installPredefs`/`define`），可这一层的**存在**是能观察到的：
   * `-E` 的行标里它占两行（`# 1 "<command line>" 1` 与回到主文件的 ` 2`）。
   * 所以这一层照旧开 —— 里头只放 `-include` 那几行，可能是空的（第一百〇七片）。
   *
   * 于是 `"..."` 那一格（下标 1）算的是 `<command line>` 的目录 = 当前工作目录，
   * 再往后才是 `-I`。找不到就报错，与 `#include` 同一句话。
   */
  pushCmdlineFile() {
    const src = this.cmdlineIncls.map((n) => `#include "${n}"\n`).join('');
    this.includeStack.push(this.file);
    const f = new CFile('<command line>', src, this.file);
    f.ifdefBase = this.ifdefStack.length;
    this.file = f;
    this.tokFlags = TOK_FLAG_BOL | TOK_FLAG_BOF;
  }

  /** 一行「假装是 `<command line>` 里的」指示：装上去，读完还原。 */
  cmdlineLine(src) {    const saved = this.file;
    this.file = new CFile('<command line>', src, null);
    this.parseFlags = PF_PREPROCESS | PF_LINEFEED;
    this.tokFlags = TOK_FLAG_BOL | TOK_FLAG_BOF;
    this.nextNomacro(); // 行首的 `#` 会把 preprocess() 叫起来
    this.file = saved;
    /* 这一条过去时攒下的输出：诊断前那个空行（`-E` 才有），以及 `-dD`/`-dM` 要的那一行。
     * 次序照 tcc：警告是 `parse_define` 里当场出的，`pp_debug_defines` 在它之后印。
     * `-dD` 的开关必须在装预定义**之前**拨好 —— 否则预定义那一段就漏了
     * （cli.js 里 `dflag` 排在 `installPredefs` 前面）。 */
    this.cmdlineDump += this.takePpNl();
    if ((this.dflag & 7) !== 0) this.cmdlineDump += this.ppDebugDefines();
  }

  /**
   * 目标的自述（`tcc_predefs` + `tcc_new` 里按目标补的那几条，见 tccdefs.js）。
   * 顺序照 tcc，最后一条是 `__BASE_FILE__` = 主输入文件 —— 与 tcc 同一个位置。
   *
   * 谁来叫：**想让 `-D` 盖掉预定义的调用方自己先叫一次**（tcc 的顺序：预定义在前，
   * 命令行在后）。没叫过的话 `preprocessToText` / `startParse` 会补上 —— 于是
   * 「忘了装预定义」这种事不会悄悄发生，而 REPL 那一路也不必知道这回事。
   *
   * `forPP`：这一路是只预处理（`-E`）还是要编译。tcc 靠 `__TCC_PP__` 这一条区分，
   * 而 tccdefs.h 里一大半（内建、`__uint128_t`）都在 `#ifndef __TCC_PP__` 里面 ——
   * 也就是说**两条路装的预定义本来就不是同一份**。见 tccdefs.js 的三张表。
   */
  installPredefs(baseFile, forPP = true) {
    if (this.predefsDone) return;
    this.predefsDone = true;
    for (const [name, body] of predefs(this.arch, this.os, forPP)) {
      this.define(name, body);
    }
    if (!forPP) for (const [name, body] of COMPILE_DEFS) this.define(name, body);
    this.define('__BASE_FILE__', `"${baseFile}"`);
  }
}

/* ------------------------------------------------- 模块级零件 */

/**
 * `macro_is_equal`（`tccpp.c:1232`）：两个宏体一样不一样。
 *
 * 比的不是记号号，是**逐个记号印出来的字符串** —— tcc 那边一个 `cstr_cat(get_tok_str(…))`
 * 一个 `strcmp`。这个写法有个能看见的后果：数在宏体里存的是值，`#define A 0x10` 与
 * `#define A 16` 印出来仍是 `0x10` 与 `16`（`TOK_PPNUM` 存的是原文），所以照样不一样。
 * 哪一边没有宏体（`__LINE__` 那一族，`s->d == NULL`）就算一样，一句不响。
 */
function macroIsEqual(cpp, a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return true;
  const live = (str, i) => i < str.toks.length && str.toks[i] !== 0 && str.toks[i] !== TOK_EOF;
  let i = 0;
  for (; live(a, i) && live(b, i); i++) {
    if (cpp.tokStr(a.toks[i], a.vals[i]) !== cpp.tokStr(b.toks[i], b.vals[i])) return false;
  }
  return !(live(a, i) || live(b, i));
}

/**
 * `add_char`（`tccpp.c:441`）：把一个字节印成 C 源码里的写法。
 * `'`/`"`/`\` 加反斜杠，可打印的原样，其余按**八进制三位**（`\n` 特例成 `\n`）。
 * 八进制而不是十六进制是有讲究的：`"\x41" "1"` 拼起来会被读成 `\x411`，八进制不会。
 */
function addChar(c) {
  let out = '';
  if (c === 39 || c === 34 || c === 92) out += '\\';
  if (c >= 32 && c <= 126) return out + String.fromCharCode(c);
  if (c === LF) return `${out}\\n`;
  const o = c & 0x1ff;
  return `${out}\\${((o >> 6) & 7).toString()}${((o >> 3) & 7).toString()}${(o & 7).toString()}`;
}

/**
 * `pp_need_space`（`tccpp.c:3873`）：a 与 b 贴在一起会不会粘出别的东西。
 * 四条，一条都不多：`E` 后面的 `+`/`-`（`1e+5` 那种），`+` 后面的 `+`/`++`，
 * `-` 后面的 `-`/`--`，以及两个都是「名字或数」的情况。
 */
function ppNeedSpace(a, b) {
  if (a === 69) return b === 43 || b === 45; // 'E'
  if (a === 43) return b === TOK_INC || b === 43;
  if (a === 45) return b === TOK_DEC || b === 45;
  if (a >= TOK_IDENT || a === TOK_PPNUM) return b >= TOK_IDENT || b === TOK_PPNUM;
  return 0;
}

/** `pp_check_he0xE`（`tccpp.c:3883`）：`0x1e` 结尾那个 E 要当成 'E' 记着，下一步好判空格 */
function ppCheckHe0xE(t, s) {
  if (t === TOK_PPNUM && toup(s.charCodeAt(s.length - 1)) === 69) return 69;
  return t;
}

function findArg(args, v) {
  for (const a of args) if (a.v === v) return a;
  return null;
}

/** 这个实参是不是空的。串以 TOK_EOF 收尾（见 `readMacroArgs`），所以「空」不是长度 0。 */
function argEmpty(a) {
  return a.str.len() === 0 || a.str.toks[0] === TOK_EOF;
}

function isAbsPath(p) {
  return p.length > 0 && p[0] === '/';
}

function defaultDirname(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}

function defaultJoin(a, b) {
  if (a === '' || a === '.') return b;
  return a.endsWith('/') ? a + b : `${a}/${b}`;
}

/**
 * `parse_escape_string`（`tccpp.c:1987`）：解字符串/字符常量里的转义。
 * `\x` 后面的十六进制**不限位数**（C 的规定，也是 tcc 的做法），八进制最多三位，
 * `\u` 要四位、`\U` 要八位（少一位就是错，不是「有几位算几位」）。
 *
 * `isLong`（`L'…'` / `L"…"`）改的是**一格装什么**：窄的一格是一个字节，宽的一格是一个
 * `wchar_t`（非 PE 上 4 字节带符号、win32 上 2 字节无符号）。于是宽的那一路不截到 8 位，
 * 源码里的非 ASCII 字符也不按 UTF-8 铺开、而是一个码位一格；`\u`/`\U` 反过来 ——
 * 窄的要按 UTF-8 编码，宽的直接就是那个值（tcc 的 `add_hex_or_ucn` 与 `cstr_u8cat`
 * 那两条岔路）。装不下的高位在**摆字节**那一步才掉（tcc 那边就是往 `nwchar_t` 里赋值）。
 */
function parseEscapeString(s, fail, isLong = false) {
  const out = [];
  const add = (c) => out.push(isLong ? c : c & 0xff);
  let i = 0;
  while (i < s.length) {
    let c = s.charCodeAt(i);
    if (c !== 92) { // 不是 '\\'
      const cp = s.codePointAt(i);
      // 窄的：源码是 UTF-8，字符串常量也就是那些字节。宽的：一个码位一格。
      if (isLong) out.push(cp);
      else if (c < 128) out.push(c);
      else for (const b of utf8Of(cp)) out.push(b);
      i += String.fromCodePoint(cp).length;
      continue;
    }
    i++;
    c = s.charCodeAt(i);
    if (c === 120 || c === 88 || c === 117 || c === 85) { // x X u U
      const want = c === 117 ? 4 : c === 85 ? 8 : 0;      // \u 四位、\U 八位、\x 不限
      i++;
      let n = 0;
      let k = 0;
      for (;;) {
        const h = hexVal(s.charCodeAt(i));
        if (h < 0) break;
        n = (n * 16 + h) >>> 0;
        k++;
        i++;
        if (want > 0 && k === want) break;
      }
      if (want > 0 ? k < want : k === 0) {
        fail(want > 0
          ? 'more hex digits in universal-character-name expected'
          : 'invalid hex digit in escape sequence');
      }
      // `\u`/`\U` 在窄字符串里是**一个字符**、按 UTF-8 铺开；`\x` 从来不铺。
      if (want > 0 && !isLong) for (const b of utf8Of(n)) out.push(b);
      else add(n);
      continue;
    }
    if (isOctCh(c)) {
      let n = 0;
      let k = 0;
      while (k < 3 && isOctCh(s.charCodeAt(i))) {
        n = n * 8 + (s.charCodeAt(i) - 48);
        i++;
        k++;
      }
      add(n);
      continue;
    }
    i++;
    switch (c) {
      case 97: add(7); break; // \a
      case 98: add(8); break; // \b
      case 102: add(12); break; // \f
      case 110: add(10); break; // \n
      case 114: add(13); break; // \r
      case 116: add(9); break; // \t
      case 118: add(11); break; // \v
      case 101: add(27); break; // \e —— gcc 扩展，tcc 也认
      case 39: case 34: case 92: case 63: add(c); break; // ' " \ ?
      case LF: break; // 行拼接：什么都不产出
      default:
        fail(`unknown escape sequence: '\\${String.fromCharCode(c)}'`);
    }
  }
  return out;
}

function hexVal(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

function utf8Of(cp) {
  const out = [];
  if (cp < 0x80) out.push(cp);
  else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
  else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  else {
    out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
      0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

/**
 * 十六进制浮点字面量（`0x1.8p3`，C99 6.4.4.2）。`Number()` 不认它，所以自己算：
 * 尾数按 16 进制读、小数点后每一位是 4 个二进制位，指数是**二**的幂。
 * 分开算尾数与 2 的幂再乘，于是只有最后那一次乘法舍入 —— 与 strtod 的结果一致。
 */
function hexFloatValue(text) {
  const m = /^0[xX]([0-9a-fA-F]*)(?:[.]([0-9a-fA-F]*))?(?:[pP]([-+]?[0-9]+))?$/.exec(text);
  if (m === null) return null;
  const int = m[1] === undefined ? '' : m[1];
  const frac = m[2] === undefined ? '' : m[2];
  if (int === '' && frac === '') return null;
  let mant = 0;
  for (const c of int + frac) mant = mant * 16 + parseInt(c, 16);
  const exp = (m[3] === undefined ? 0 : Number(m[3])) - frac.length * 4;
  return mant * Math.pow(2, exp);
}

/**
 * `parse_number`（`tccpp.c:2243`）。回 `{tok, val}`：整数的 val 是 bigint，
 * 浮点的 val 是宿主的 double（第六刀第十四片起真的算值 —— 它要进 MIR 的常量池）。
 *
 * `#if` 里浮点照旧是错（`invalid constant in preprocessor expression`，与 tcc 同一句）：
 * 那一格看的是记号号，不是值，所以算不算值都一样。
 *
 * 整数的类型只分「有没有符号」两档，不区分 int / long / long long：`#if` 的算术全在
 * intmax_t 上做，宽度不可观测，**只有无符号性可观测**（它改比较与除法）。
 */
export function parseNumber(text) {
  let s = text;
  let base = 10;
  if (s.length > 1 && s[0] === '0') {
    const c1 = s[1];
    if (c1 === 'x' || c1 === 'X') {
      base = 16;
      s = s.slice(2);
    } else if (c1 === 'b' || c1 === 'B') {
      base = 2; // gcc 扩展，tcc 也认
      s = s.slice(2);
    } else {
      /* 八进制：**前缀那个 0 不摘**。摘了 `0u` 就只剩 `u`，一个数字都没有 ——
       * 而 `0u` 是合法的（值 0、无符号）。留着它，`010` 在八进制下照样是 8。 */
      base = 8;
    }
  }
  const digits = base === 16 ? /^[0-9a-fA-F]+/ : base === 8 ? /^[0-7]+/ : base === 2 ? /^[01]+/ : /^[0-9]+/;
  const m = digits.exec(s);
  const body = m === null ? '' : m[0];
  let rest = s.slice(body.length);

  // 浮点：十进制里的 `.`/`e`，十六进制里的 `.`/`p`
  const isFloat = base === 16
    ? /^[.]|^[pP]/.test(rest) || (body === '' && /^[.]/.test(s))
    : /^[.]|^[eE]/.test(rest) || (base === 8 && /[89]/.test(body));
  if (isFloat || (base === 10 && /^[.]/.test(text))) {
    if (!/^([0-9]*[.]?[0-9]*([eE][-+]?[0-9]+)?|0[xX][0-9a-fA-F]*[.]?[0-9a-fA-F]*([pP][-+]?[0-9]+)?)[fFlL]*$/.test(text)) {
      return null;
    }
    /* 后缀（C11 6.4.4.2）：`f` 是 float、`l` 是 long double、没有就是 double。
     * 只许一个 —— `1.0fl` 不合法。 */
    const sfx = /[fFlL]*$/.exec(text)[0];
    if (sfx.length > 1) return null;
    const num = text.slice(0, text.length - sfx.length);
    const val = base === 16 ? hexFloatValue(num) : Number(num);
    if (val === null || Number.isNaN(val)) return null;
    const c = sfx.toLowerCase();
    return {
      tok: c === 'f' ? TOK_CFLOAT : c === 'l' ? TOK_CLDOUBLE : TOK_CDOUBLE,
      /* f32 的字面量要**先舍到单精度**：`0.1f` 在 C 里是那个单精度数，
       * 而 `Number('0.1')` 是双精度的 0.1，两者不等。少这一次 fround，
       * `float x = 0.1f; x == 0.1f` 在解释器里会判假。 */
      val: c === 'f' ? Math.fround(val) : val,
    };
  }
  if (body === '') return null;

  let unsigned = false;
  let long = false;
  const suffix = rest;
  for (let i = 0; i < suffix.length; i++) {
    const c = suffix[i];
    if (c === 'u' || c === 'U') {
      if (unsigned) return null;
      unsigned = true;
    } else if (c === 'l' || c === 'L') {
      long = true;
      if (suffix[i + 1] === c) i++; // ll / LL
    } else {
      return null;
    }
  }

  let val = 0n;
  const b = BigInt(base);
  for (const ch of body) val = val * b + BigInt(hexVal(ch.charCodeAt(0)));
  /* 十进制的无后缀常量放不进 intmax_t 时 C 说它是无符号的；十六进制/八进制更早
   * 就会跳到无符号。两种情况都在 64 位这一档上判 —— 这条线就是 tcc 在本机的行为。 */
  if (!unsigned && val > 0x7fffffffffffffffn) unsigned = true;
  val = unsigned ? BigInt.asUintN(64, val) : BigInt.asIntN(64, val);
  const big = long || val > 0x7fffffffn || val < -0x80000000n;
  const tok = unsigned ? (big ? TOK_CULLONG : TOK_CUINT) : (big ? TOK_CLLONG : TOK_CINT);
  return { tok, val };
}

/* ------------------------------------------------- `#if` 的表达式求值
 * 值是 `{v: bigint, u: boolean}`：64 位 + 有没有符号。每一步都按 C 的规矩收口，
 * 于是 `#if -1 < 0u` 是**假**（-1 转成无符号）—— 这一条不实现的话没人会发现，
 * 直到某个真实的头文件用它做特性判断。 */

function num(v, u) {
  return { v: u ? BigInt.asUintN(64, v) : BigInt.asIntN(64, v), u };
}

function evalNext(e) {
  e.i++;
}

function evalTok(e) {
  return e.i < e.str.len() ? e.str.toks[e.i] : 0;
}

function evalPrimary(e) {
  const t = evalTok(e);
  if (t === TOK_CINT || t === TOK_CLLONG || t === TOK_CCHAR || t === TOK_LCHAR) {
    const v = /** @type {bigint} */ (e.str.vals[e.i]);
    evalNext(e);
    return num(v, false);
  }
  if (t === TOK_CUINT || t === TOK_CULLONG) {
    const v = /** @type {bigint} */ (e.str.vals[e.i]);
    evalNext(e);
    return num(v, true);
  }
  if (t === 40) {
    evalNext(e);
    const v = evalCond(e);
    if (evalTok(e) !== 41) e.cpp.err("')' expected in preprocessor expression");
    evalNext(e);
    return v;
  }
  if (t === 33) { evalNext(e); return num(evalUnary(e).v === 0n ? 1n : 0n, false); }
  if (t === 126) { evalNext(e); const a = evalUnary(e); return num(~a.v, a.u); }
  if (t === 45) { evalNext(e); const a = evalUnary(e); return num(-a.v, a.u); }
  if (t === 43) { evalNext(e); return evalUnary(e); }
  e.cpp.err('bad preprocessor expression');
  return num(0n, false);
}

function evalUnary(e) {
  return evalPrimary(e);
}

/** 二元运算符的优先级，数字越大越紧。0 = 不是二元运算符。 */
function binPrec(t) {
  switch (t) {
    case 42: case 47: case 37: return 10; // * / %
    case 43: case 45: return 9; // + -
    case TOK_SHL: case TOK_SAR: return 8; // << >>
    case TOK_LT: case TOK_GT: case TOK_LE: case TOK_GE: return 7;
    case TOK_EQ: case TOK_NE: return 6;
    case 38: return 5; // &
    case 94: return 4; // ^
    case 124: return 3; // |
    case TOK_LAND: return 2;
    case TOK_LOR: return 1;
    default: return 0;
  }
}

function evalBin(e, minPrec) {
  let lhs = evalUnary(e);
  for (;;) {
    const t = evalTok(e);
    const p = binPrec(t);
    if (p === 0 || p < minPrec) return lhs;
    evalNext(e);
    /* `&&` 与 `||` 要短路：`#if defined(X) && X > 2` 在 X 没定义时右边不能求值。
     * 这里右边**照样解析**（要把记号吃掉）但结果丢掉 —— 与 C 的短路在
     * 「有没有副作用」上等价，因为 `#if` 里根本没有副作用，只有除零。 */
    if (t === TOK_LAND || t === TOK_LOR) {
      const skip = t === TOK_LAND ? lhs.v === 0n : lhs.v !== 0n;
      const saved = e.skip;
      e.skip = saved || skip;
      const rhs = evalBin(e, p + 1);
      e.skip = saved;
      const b = skip ? (t === TOK_LAND ? 0n : 1n) : (rhs.v !== 0n ? 1n : 0n);
      lhs = num(b, false);
      continue;
    }
    const rhs = evalBin(e, p + 1);
    lhs = evalApply(e, t, lhs, rhs);
  }
}

function evalApply(e, t, a, b) {
  // 通常算术转换：任一边无符号，两边都按无符号算（C 的规矩，也是 `#if` 里唯一
  // 能观测到的类型效应）
  const u = a.u || b.u;
  const x = u ? BigInt.asUintN(64, a.v) : a.v;
  const y = u ? BigInt.asUintN(64, b.v) : b.v;
  switch (t) {
    case 42: return num(x * y, u);
    case 47: case 37:
      if (y === 0n) {
        if (e.skip) return num(0n, u); // 短路掉的那一边不许因为除零而报错
        e.cpp.err('division by zero in preprocessor expression');
      }
      // C 的整数除法向零截断；BigInt 的 / 与 % 正好也是这个语义
      return num(t === 47 ? x / y : x % y, u);
    case 43: return num(x + y, u);
    case 45: return num(x - y, u);
    case TOK_SHL: return num(x << (y & 63n), u);
    // 有符号右移补符号位，无符号补零 —— BigInt 的 >> 是算术移位，所以只有无符号要先收口
    case TOK_SAR: return num(u ? BigInt.asUintN(64, x) >> (y & 63n) : x >> (y & 63n), u);
    case TOK_LT: return num(x < y ? 1n : 0n, false);
    case TOK_GT: return num(x > y ? 1n : 0n, false);
    case TOK_LE: return num(x <= y ? 1n : 0n, false);
    case TOK_GE: return num(x >= y ? 1n : 0n, false);
    case TOK_EQ: return num(x === y ? 1n : 0n, false);
    case TOK_NE: return num(x !== y ? 1n : 0n, false);
    case 38: return num(x & y, u);
    case 94: return num(x ^ y, u);
    case 124: return num(x | y, u);
    default:
      e.cpp.err('bad operator in preprocessor expression');
      return num(0n, false);
  }
}

function evalCond(e) {
  const c = evalBin(e, 1);
  if (evalTok(e) !== 63) return c; // '?'
  evalNext(e);
  const saved = e.skip;
  e.skip = saved || c.v === 0n;
  const a = evalCond(e);
  e.skip = saved;
  if (evalTok(e) !== 58) e.cpp.err("':' expected in preprocessor expression");
  evalNext(e);
  e.skip = saved || c.v !== 0n;
  const b = evalCond(e);
  e.skip = saved;
  return c.v !== 0n ? a : b;
}
