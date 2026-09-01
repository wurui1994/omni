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
// - **输出格式只有 `-P` 那一种**（不发 `# 行号 "文件"` 标记）。`pp_line`（`tccpp.c:3796`）
//   那套「差 8 行以内就补空行、否则印行号标记」的逻辑要跟 include 层级联动，是独立一格。
// - **`__DATE__` / `__TIME__` 不认**：它们的值随时钟走，进不了逐字节比对的测试轴。
//   `__LINE__` / `__FILE__` / `__COUNTER__` 都认。
// - **`#include_next` 与 `__has_include` 不认**：前者要记住「上一次是在第几个搜索目录里
//   找到的」（`tccpp.c:1363` 的 include_next_index），后者要把 include 搜索接进 `#if`
//   的求值里。两条都等有真的系统头目录之后再做。
// - **没有系统头目录**：`#include <...>` 只在 `-I` 给的目录里找，找不到就报
//   `include file '...' not found`（与 tcc 同一句）。libc 的接法是第八刀。
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
  TOK_EOF, TOK_LINEFEED, TOK_IDENT, SYM_FIELD, TOK_PPJOIN,
  MACRO_OBJ, MACRO_FUNC, MACRO_JOIN, TOK_TWO_CHARS, IDENT_NAMES,
  TOK_DEFINE, TOK_INCLUDE, TOK_INCLUDE_NEXT, TOK_IFDEF, TOK_IFNDEF, TOK_ELIF,
  TOK_ENDIF, TOK_DEFINED, TOK_UNDEF, TOK_ERROR, TOK_WARNING, TOK_LINE, TOK_PRAGMA,
  TOK_IF, TOK_ELSE, TOK___LINE__, TOK___FILE__, TOK___DATE__, TOK___TIME__,
  TOK___VA_ARGS__, TOK___COUNTER__, TOK___HAS_INCLUDE, TOK___HAS_INCLUDE_NEXT,
  TOK_push_macro, TOK_pop_macro, TOK_once,
} from './tcctok.js';

const CH_EOF = -1;
const SPC = 32; // ' '
const TAB = 9;
const LF = 10;

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
  }

  add(t) {
    this.toks.push(t);
    this.vals.push(null);
  }

  add2(t, v) {
    this.toks.push(t);
    this.vals.push(v);
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
    this.prev = prev;
    /** 进这个文件时 ifdef 栈的深度：`#endif` 少了一个就要在文件末尾报错（`tccpp.c:2580`） */
    this.ifdefBase = 0;
    /** 「整个文件被一个 #ifndef 包着」的守卫名，0 = 没有（`tccpp.c:1847`） */
    this.ifndefMacro = 0;
    this.ifndefMacroSaved = 0;
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
   *          dirname?: (p: string) => string, join?: (a: string, b: string) => string}} host
   */
  constructor(host) {
    this.readFile = host.readFile;
    this.includeDirs = host.includeDirs ?? [];
    this.dirnameOf = host.dirname ?? defaultDirname;
    this.joinPath = host.join ?? defaultJoin;

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
    /** `#if` 的求值途中（`pp_expr`）：GCC 允许宏展开出 `defined`，靠这一格放行 */
    this.ppExpr = 0;

    /** 宏展开用的记号流栈（tcc 的 `macro_stack` / `macro_ptr`） */
    this.macroFrame = null; // {str: TokStr, i: number}
    this.macroFrames = [];
    /** @type {string[]} 警告（tcc 的 tcc_warning：不致命） */
    this.warnings = [];

    /* __LINE__ 那一族在 tcc 里也要有个 Sym 占位，否则 `defined(__LINE__)` 是假的
     * （`tccpp.c:3734`）。`special` 就是 tcc 的 `d == NULL`。 */
    for (const v of [TOK___LINE__, TOK___FILE__, TOK___COUNTER__, TOK___DATE__, TOK___TIME__]) {
      this.defines.set(v, { special: true });
    }
  }

  /* ------------------------------------------------- 报错与名字 */

  /** tcc 的 `tcc_error`：**致命**，当场停。位置形如 `a.c:12:` —— 与 tcc 的前缀同形。 */
  err(msg) {
    const where = this.file ? `${this.file.filename}:${this.file.lineNum}: ` : '';
    throw new OmniError(`${where}error: ${msg}`);
  }

  warn(msg) {
    const where = this.file ? `${this.file.filename}:${this.file.lineNum}: ` : '';
    this.warnings.push(`${where}warning: ${msg}`);
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
      case TOK_STR: case TOK_LSTR: {
        const pre = v === TOK_LSTR ? 'L' : '';
        let out = `${pre}"`;
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

  /** 把一段记号流压成当前输入（`begin_macro`，`tccpp.c:1053`） */
  beginMacro(str, i) {
    if (this.macroFrame !== null) this.macroFrames.push(this.macroFrame);
    this.macroFrame = { str, i };
    return this.macroFrame;
  }

  endMacro() {
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
      str.add2(this.tok, this.tokc);
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
      str.add2(this.tok, this.tokc);
      this.next();
      if (depth === 0) break;
    }
    str.add2(TOK_EOF, null);
    return str;
  }

  defineFind(v) {
    const d = this.defines.get(v);
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
    const body = parseEscapeString(s.slice(1, s.length - 1), (m) => this.err(m));
    if (sep === 39) { // 字符常量
      if (body.length < 1) this.err('empty character constant');
      if (body.length > 1) this.warn('multi-character character constant');
      if (isLong) {
        this.tok = TOK_LCHAR;
        this.tokc = BigInt(body[body.length - 1]);
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
    this.tok = isLong ? TOK_LSTR : TOK_STR;
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
      const n = v === TOK___LINE__ ? this.file.lineNum : this.ppCounter++;
      out.add2Spc(TOK_PPNUM, String(n));
      return;
    }
    if (v === TOK___FILE__) {
      out.add2Spc(TOK_STR, this.file.filename);
      return;
    }
    // __DATE__ / __TIME__：见文件头的阶段边界 —— 值随时钟走，进不了逐字节比对的轴
    this.err(`'${this.tokStr(v, null)}' is not supported yet: its value is not reproducible`);
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
    // 先吃掉那个 '('，再吃掉紧跟的空白（tcc 用 `i = 2` 那个计数器做这件事）
    let eat = 2;
    for (;;) {
      do {
        t = this.nextArgstream(nested, null);
        eat--;
      } while (t === SPC || eat > 0);

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
              if (a.str.len() === 0) {
                out.toks.pop();
                out.vals.pop();
                t0 = t1;
                t1 = t;
                continue;
              }
              if (lastTok === SPC) out.add(SPC);
              raw = false;
            } else if (a.str.len() === 0) {
              out.add(TOK_PLCHLDR); // 空实参在 `##` 两侧要留一个占位（C99）
            }
          } else {
            raw = false;
          }
          if (!raw) {
            if (a.expanded === null) {
              const e = new TokStr();
              this.macroSubst(e, nested, a.str, 0);
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
          this.nextNomacro();
          this.parseDefine();
          break;
        case TOK_UNDEF: {
          this.nextNomacro();
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
          this.err("'#include_next' is not supported yet");
          break;
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
          if (this.defineFind(this.tok) !== null) c ^= 1;
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
    this.defines.set(v, { type, str, args, special: false });
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
      this.next();
      return true;
    }
    if (this.tok === TOK_once) {
      this.cachedInclude(this.file.trueFilename, true).once = true;
      this.next();
      return true;
    }
    /* 其余的 pragma 在 `tcc -E` 下**原样印回输出**（`tccpp.c:1688-1694`）：
     * 它是给下一道工序看的，预处理器无权吃掉。四个 unget 倒着叠，读出来正好是
     * 换行、`#`、`pragma`、空格，然后接着读这一行剩下的部分。 */
    this.ungetTok(SPC);
    this.ungetTok(TOK_PRAGMA);
    this.ungetTok(35);
    this.ungetTok(TOK_LINEFEED);
    return true;
  }

  /** `parse_include`（`tccpp.c:1324`） */
  parseInclude() {
    const c = this.skipSpaces();
    let name;
    let kind;
    if (c === 60 || c === 34) { // '<' '"'
      name = this.parsePpString(c === 60 ? 62 : c, true);
      kind = c;
      this.nextNomacro();
    } else {
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
      kind = acc.charCodeAt(0);
      name = acc.slice(1, acc.length - 1);
    }
    this.skipToEol(true);

    /* 搜索顺序照 `tccpp.c:1364-1405`：绝对路径 -> `"..."` 才看的「当前文件所在目录」
     * -> `-I` 给的那些。系统目录这一格还没有（见文件头的阶段边界）。 */
    const tries = [];
    if (isAbsPath(name)) tries.push(name);
    if (kind === 34) tries.push(this.joinPath(this.dirnameOf(this.file.trueFilename), name));
    for (const d of this.includeDirs) tries.push(this.joinPath(d, name));

    for (const path of tries) {
      const e = this.cachedInclude(path, false);
      if (e !== null && (e.once || (e.ifndefMacro && this.defineFind(e.ifndefMacro) !== null))) {
        return; // 守卫已经定义过或者 #pragma once：整份跳过，连读都不读
      }
      const text = this.readFile(path);
      if (text === null) continue;
      if (this.includeStack.length >= 64) this.err('#include recursion too deep');
      this.includeStack.push(this.file);
      const f = new CFile(path, text, this.file);
      f.ifdefBase = this.ifdefStack.length;
      this.file = f;
      this.tokFlags = TOK_FLAG_BOL | TOK_FLAG_BOF;
      return;
    }
    this.err(`include file '${name}' not found`);
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
        const c = this.defineFind(this.tok) !== null ? 1n : 0n;
        if (paren) {
          this.next();
          if (this.tok !== 41) this.err("')' expected");
        }
        str.add2(TOK_CLLONG, c);
        continue;
      }
      if (t === TOK___HAS_INCLUDE || t === TOK___HAS_INCLUDE_NEXT) {
        this.err(`'${this.tokStr(t, null)}' is not supported yet`);
      }
      // 没定义的宏名在 `#if` 里就是 0（C 的规定）
      str.add2(TOK_CLLONG, 0n);
    }
    if (str.len() === 0) this.err(`#${this.tokStr(t0, null)} with no expression`);
    this.ppExpr = 0;

    const ev = { str, i: 0, cpp: this };
    const val = evalCond(ev);
    if (ev.i < str.len()) {
      this.err(`bad preprocessor expression: #${this.tokStr(t0, null)}`);
    }
    return val.v !== 0n;
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
  preprocessToText(filename, text) {
    this.file = new CFile(filename, text, null);
    this.file.ifdefBase = 0;
    this.parseFlags = PF_PREPROCESS | PF_LINEFEED | PF_SPACES | PF_ACCEPT_STRAYS;
    this.tokFlags = TOK_FLAG_BOL | TOK_FLAG_BOF;

    let out = '';
    let tokenSeen = TOK_LINEFEED;
    let white = '';
    for (;;) {
      this.next();
      if (this.tok === TOK_EOF) break;
      if (this.tok === SPC || this.tok === TAB) {
        white += String.fromCharCode(this.tok);
        continue;
      }
      if (this.tok === TOK_LINEFEED) {
        white = '';
        if (tokenSeen === TOK_LINEFEED) continue;
      } else if (tokenSeen === TOK_LINEFEED) {
        /* 一行的第一个记号。`-P` 下 pp_line 什么都不印，而攒下来的空白**照印** ——
         * 量过 tcc：`    int    b;` 出来还是 `    int    b;`，缩进一个字节不差。
         * （这里曾经手滑清掉了 white，于是所有缩进都消失 —— 逐字节比对当场抓住。） */
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
    this.file = new CFile(filename, text, null);
    this.file.ifdefBase = 0;
    this.parseFlags = PF_PREPROCESS | PF_TOK_NUM | PF_TOK_STR;
    this.tokFlags = TOK_FLAG_BOL | TOK_FLAG_BOF;
  }

  /** 命令行上的 `-D name[=body]`（tcc 的 `tcc_define_symbol`） */  define(name, body) {
    const src = `#define ${name}${body === undefined ? '' : ` ${body}`}\n`;
    const saved = this.file;
    this.file = new CFile('<command line>', src, null);
    this.parseFlags = PF_PREPROCESS | PF_LINEFEED;
    this.tokFlags = TOK_FLAG_BOL | TOK_FLAG_BOF;
    this.nextNomacro(); // 行首的 `#` 会把 preprocess() 叫起来
    this.file = saved;
  }
}

/* ------------------------------------------------- 模块级零件 */

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
 * `parse_escape_string`（`tccpp.c:1987`）：解字符串/字符常量里的转义，回**字节**数组。
 * `\x` 后面的十六进制**不限位数**（C 的规定，也是 tcc 的做法），八进制最多三位。
 */
function parseEscapeString(s, fail) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    let c = s.charCodeAt(i);
    if (c !== 92) { // 不是 '\\'
      // 非 ASCII 按 UTF-8 的字节进去（源码是 UTF-8，字符串常量也就是那些字节）
      if (c < 128) out.push(c);
      else for (const b of utf8Of(s.codePointAt(i))) out.push(b);
      i += String.fromCodePoint(s.codePointAt(i)).length;
      continue;
    }
    i++;
    c = s.charCodeAt(i);
    if (c === 120 || c === 88) { // x X
      i++;
      let n = 0;
      let any = false;
      for (;;) {
        const h = hexVal(s.charCodeAt(i));
        if (h < 0) break;
        n = n * 16 + h;
        any = true;
        i++;
      }
      if (!any) fail("invalid hex digit in escape sequence");
      out.push(n & 0xff);
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
      out.push(n & 0xff);
      continue;
    }
    i++;
    switch (c) {
      case 97: out.push(7); break; // \a
      case 98: out.push(8); break; // \b
      case 102: out.push(12); break; // \f
      case 110: out.push(10); break; // \n
      case 114: out.push(13); break; // \r
      case 116: out.push(9); break; // \t
      case 118: out.push(11); break; // \v
      case 101: out.push(27); break; // \e —— gcc 扩展，tcc 也认
      case 39: case 34: case 92: case 63: out.push(c); break; // ' " \ ?
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
