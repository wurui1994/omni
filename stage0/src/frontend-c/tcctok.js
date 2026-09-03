// Omni stage0 — C 前端的记号表（tinycc `tcctok.h` + `tcc.h:1114-1205` 的等价物）
//
// 出处纪律见 ADR-0017「借什么、不借什么」：**照着行为与结构重写，不抄代码**，每条规则在
// 实现旁边注明 tcc 的文件与行号。这一份是那条纪律里最枯燥的一格 —— 它是一张**数据表**，
// 内容是 C 的关键字拼法与一套记号编号，形状照 `tcctok.h` 的 DEF 顺序。
//
// ## 为什么编号本身要照抄
//
// tcc 的整个前端靠**区间判断**工作，不是靠枚举名字：
//   - `tok < TOK_IDENT`（256）  -> 单字符或运算符
//   - `TOK_IDENT <= tok < TOK_UIDENT` -> 关键字（`tcc.h:1204`）
//   - `tok >= TOK_UIDENT`      -> 用户标识符或只有预处理器认的名字
//   - `TOK_HAS_VALUE(t)` = `TOK_CCHAR <= t <= TOK_LINENUM`（`tcc.h:1189`）
//   - `TOK_ASSIGN(t)` = `TOK_A_ADD <= t <= TOK_A_SAR`（`tcc.h:1168`），而
//     `TOK_ASSIGN_OP(t)` = `"+-*/%&|^<>"[t - TOK_A_ADD]`（`tcc.h:1169`）—— 这一条
//     直接把「顺序」当成数据用了
// 换一套编号这些判断就得逐条改写成集合查询，而那是**另一份**代码、另一批 bug。
//
// ## 阶段边界：这张表还不全
//
// `tcctok.h` 里 attribute 名（`section`/`weak`/…）、`__builtin_*`、原子操作、
// libtcc1 的辅助函数名、以及整个 Tiny Assembler 的指令与伪指令**大半还没进来** ——
// 它们的消费者（`tccgen` 的属性一路与 `*-asm`）还不存在。于是从 `TOK___INF__` 之后，
// 编号是我们的、不是 tcc 的：pragma 那几个名字在 tcc 里排在 builtin 后面。
// 第六刀补上的只是**语句与类型关键字**那一段（它们在 KEYWORD_NAMES 里本来就有，
// 只是没导出过），那一段的编号与 tcc 一致；分岔点仍然在 `TOK___INF__` 之后。
// 第八刀第三十四片按需补了 attribute 名里的 `aligned`/`packed` 两条 —— 有真的消费者
// （struct 布局）的才进表，别的属性名走「平衡掉参数括号」那一支。

/* ------------------------------------------------- 运算符与带值记号（tcc.h:1114-1192）
 * 这些数值一个都不能动：见文件头「为什么编号本身要照抄」。 */

export const TOK_LAND = 0x90;
export const TOK_LOR = 0x91;
export const TOK_ULT = 0x92;
export const TOK_UGE = 0x93;
export const TOK_EQ = 0x94;
export const TOK_NE = 0x95;
export const TOK_ULE = 0x96;
export const TOK_UGT = 0x97;
export const TOK_LT = 0x9c;
export const TOK_GE = 0x9d;
export const TOK_LE = 0x9e;
export const TOK_GT = 0x9f;

export const TOK_DEC = 0x80;
export const TOK_MID = 0x81;
export const TOK_INC = 0x82;
export const TOK_SHR = 0x8b;
/** `<<`：tcc 借用 `'<'` 的码位（`tcc.h:1143`），于是「移位」与「小于」在字面上分不开 —— */
export const TOK_SHL = 0x3c; // '<'
/** `>>`：同上，借 `'>'`（`tcc.h:1144`）。印回文本时靠 tok_two_chars 那张表分辨。 */
export const TOK_SAR = 0x3e; // '>'

export const TOK_ARROW = 0xa0;
export const TOK_DOTS = 0xa1;
export const TOK_TWODOTS = 0xa2;
export const TOK_TWOSHARPS = 0xa3;
export const TOK_PLCHLDR = 0xa4;

export const TOK_A_ADD = 0xb0;
export const TOK_A_SUB = 0xb1;
export const TOK_A_MUL = 0xb2;
export const TOK_A_DIV = 0xb3;
export const TOK_A_MOD = 0xb4;
export const TOK_A_AND = 0xb5;
export const TOK_A_OR = 0xb6;
export const TOK_A_XOR = 0xb7;
export const TOK_A_SHL = 0xb8;
export const TOK_A_SAR = 0xb9;

export const TOK_CCHAR = 0xc0;
export const TOK_LCHAR = 0xc1;
export const TOK_CINT = 0xc2;
export const TOK_CUINT = 0xc3;
export const TOK_CLLONG = 0xc4;
export const TOK_CULLONG = 0xc5;
export const TOK_CLONG = 0xc6;
export const TOK_CULONG = 0xc7;
export const TOK_STR = 0xc8;
export const TOK_LSTR = 0xc9;
export const TOK_CFLOAT = 0xca;
export const TOK_CDOUBLE = 0xcb;
export const TOK_CLDOUBLE = 0xcc;
export const TOK_PPNUM = 0xcd;
export const TOK_PPSTR = 0xce;
export const TOK_LINENUM = 0xcf;

export const TOK_EOF = -1;
export const TOK_LINEFEED = 10;
export const TOK_IDENT = 256;

/**
 * `SYM_FIELD`（`tcc.h:597`）在预处理器里只当**一个标记位**用，两处：
 *   1. `TOK_PPJOIN = TOK_TWOSHARPS | SYM_FIELD`（`tcc.h:1153`）—— 宏体里那个真的要粘的
 *      `##`，与源码里写出来的 `##` 记号区分开；
 *   2. `macro_subst` 给已经展开过的名字打「不要再展开」的印（`tccpp.c:3435`）。
 * 数值照抄是因为第 2 条要能被 `t &= ~SYM_FIELD` 摘掉（`tccpp.c:3491`）。
 */
export const SYM_FIELD = 0x20000000;
export const TOK_PPJOIN = TOK_TWOSHARPS | SYM_FIELD;

/** 宏的种类（`tcc.h:615-617`）。`JOIN` 是「这个宏体里有 `##`」的标记，省掉一趟扫描。 */
export const MACRO_OBJ = 0;
export const MACRO_FUNC = 1;
export const MACRO_JOIN = 2;

/**
 * 两字符运算符 -> 记号号（`tccpp.c:71-91` 的 `tok_two_chars`）。
 * 印回文本时要靠它：`TOK_SHL` 与 `'<'` 是同一个数（见上面），只有在这张表里
 * 才分得出「那个 0x3c 是移位」。表的顺序照 tcc，因为查表是线性的，先中先赢。
 */
export const TOK_TWO_CHARS = [
  ['<=', TOK_LE], ['>=', TOK_GE], ['!=', TOK_NE], ['&&', TOK_LAND], ['||', TOK_LOR],
  ['++', TOK_INC], ['--', TOK_DEC], ['==', TOK_EQ], ['<<', TOK_SHL], ['>>', TOK_SAR],
  ['+=', TOK_A_ADD], ['-=', TOK_A_SUB], ['*=', TOK_A_MUL], ['/=', TOK_A_DIV],
  ['%=', TOK_A_MOD], ['&=', TOK_A_AND], ['^=', TOK_A_XOR], ['|=', TOK_A_OR],
  ['->', TOK_ARROW], ['..', TOK_TWODOTS], ['##', TOK_TWOSHARPS],
];

/* ------------------------------------------------- 标识符表（tcctok.h 的 DEF 顺序）
 * 下标 i 的名字拿到记号号 TOK_IDENT + i。`KEYWORD_END` 之前的是**真关键字**
 * （tcc 的 `tok < TOK_UIDENT`），之后的是「不是关键字、只是为了好解析才预先登记」的名字
 * —— 预处理指令名、`__LINE__` 那一族、pragma 名。这条界线是 tcc.h:1204-1205 那两行。 */

const KEYWORD_NAMES = [
  // tcctok.h:3-17 —— 语句关键字与 asm 的三种拼法
  'if', 'else', 'while', 'for', 'do', 'continue', 'break', 'return', 'goto', 'switch',
  'case', 'default', 'asm', '__asm', '__asm__',
  // tcctok.h:19-42 —— 存储类与限定符。gcc 的下划线拼法各占一格：tcc 不做别名折叠，
  // 因为 `#define const` 之类的把戏要能分辨出用户写的是哪一个。
  'extern', 'static', 'unsigned', '_Atomic', 'const', '__const', '__const__',
  'volatile', '__volatile', '__volatile__', 'register',
  'signed', '__signed', '__signed__', 'auto',
  'inline', '__inline', '__inline__', 'restrict', '__restrict', '__restrict__',
  '__extension__', '_Thread_local', '__thread',
  // tcctok.h:44-45
  '_Generic', '_Static_assert',
  // tcctok.h:47-70 —— 类型关键字与 sizeof/attribute/alignof/typeof
  'void', 'char', 'int', 'float', 'double', '_Bool', '_Complex', 'short', 'long',
  'struct', 'union', 'typedef', 'enum', 'sizeof',
  '__attribute', '__attribute__',
  '__alignof', '__alignof__', '_Alignof', '_Alignas',
  'typeof', '__typeof', '__typeof__', '__label__',
];

/** 关键字到此为止 —— 这就是 `TOK_UIDENT`（`tcc.h:1205`）那条线。 */
export const KEYWORD_END = KEYWORD_NAMES.length;

const PP_NAMES = [
  // tcctok.h:75-96 —— 预处理指令名。它们**不是关键字**：`int define;` 是合法 C，
  // 而 `#define` 里那个 `define` 只在指令位置上有意义。所以它们排在 TOK_UIDENT 之后。
  'define', 'include', 'include_next', 'ifdef', 'ifndef', 'elif', 'endif',
  'defined', 'undef', 'error', 'warning', 'line', 'pragma',
  '__LINE__', '__FILE__', '__DATE__', '__TIME__', '__FUNCTION__', '__VA_ARGS__',
  '__COUNTER__', '__has_include', '__has_include_next',
  // tcctok.h:99-104
  '__func__', '__nan__', '__snan__', '__inf__',
  // tcctok.h:168-185 的 builtin 那一段。**它们不是关键字**（`int __builtin_expect;`
  // 是合法 C），所以与 tcc 一样排在 TOK_UIDENT 之后：只在 `unary` 里按记号号认出来。
  // 这一片只要 arm64 上那两个（`tcctok.h:181-182`，`TCC_TARGET_ARM64` 那一支）——
  // `__builtin_va_list` 在 tcc 那边是 tccdefs.h 里的一个 typedef，不是记号，
  // 我们照它办（见 tccgen.js 构造函数里那条 typedef）。
  // `__builtin_expect`（`tcctok.h:169`）是第二十片补的：tinycc 自己的源码里
  // `PROBE_INLINE` 一带在用，而它在 tcc 那边就是「算两边、留左边」的空操作。
  '__builtin_va_start', '__builtin_va_arg', '__builtin_va_end', '__builtin_va_copy',
  '__builtin_expect', '__builtin_types_compatible_p',
  // tcctok.h:207-220 的 pragma 名。**这里编号与 tcc 分岔**（见文件头的阶段边界）：
  // tcc 在这之前还有 attribute 与 builtin 两大段。
  'pack', 'push', 'pop', 'comment', 'lib', 'push_macro', 'pop_macro', 'once', 'option',
  // tcctok.h:106-166 的 attribute 名（第八刀第三十四片）。tcc 那边这一整段排在 builtin
  // 之前，我们的编号从 `__inf__` 之后就分岔了（见文件头），所以这儿只登记**真的要认**
  // 的那几个：`aligned` / `packed`（改布局）、`weak`（改符号绑定，第一百〇四片）与
  // `alias`（一个名字发两条符号，第一百〇五片），各带 gcc 的下划线拼法。别的属性名仍然是
  // 普通标识符（`section`、`format`…），`parseAttrs` 在 default 那一支把它们的参数括号
  // 平衡掉 —— 与 tcc 的 `skip_param` 同一支。
  'aligned', '__aligned__', 'packed', '__packed__', 'weak', '__weak__', 'alias', '__alias__',
];

/** 全表：下标 i <-> 记号号 `TOK_IDENT + i`。 */
export const IDENT_NAMES = KEYWORD_NAMES.concat(PP_NAMES);

/** 按名字取记号号（只对预先登记的名字有效，用户标识符走 TokenTable）。 */
function fixed(name) {
  const i = IDENT_NAMES.indexOf(name);
  if (i < 0) throw new Error(`tcctok: '${name}' is not in the table`);
  return TOK_IDENT + i;
}

export const TOK_UIDENT = fixed('define');

export const TOK_ASM1 = fixed('asm');
export const TOK_DEFINE = fixed('define');
export const TOK_INCLUDE = fixed('include');
export const TOK_INCLUDE_NEXT = fixed('include_next');
export const TOK_IFDEF = fixed('ifdef');
export const TOK_IFNDEF = fixed('ifndef');
export const TOK_ELIF = fixed('elif');
export const TOK_ENDIF = fixed('endif');
export const TOK_DEFINED = fixed('defined');
export const TOK_UNDEF = fixed('undef');
export const TOK_ERROR = fixed('error');
export const TOK_WARNING = fixed('warning');
export const TOK_LINE = fixed('line');
export const TOK_PRAGMA = fixed('pragma');
export const TOK_IF = fixed('if');
export const TOK_ELSE = fixed('else');
export const TOK___LINE__ = fixed('__LINE__');
export const TOK___FILE__ = fixed('__FILE__');
export const TOK___DATE__ = fixed('__DATE__');
export const TOK___TIME__ = fixed('__TIME__');
export const TOK___VA_ARGS__ = fixed('__VA_ARGS__');
/* `__func__`（C99 6.4.2.2）与 GNU 的 `__FUNCTION__` 是同一件事，tcc 也是同一支
 * （`tccgen.c:5656`，`case TOK___FUNCTION__` 落到 `case TOK___FUNC__`）。
 * `__PRETTY_FUNCTION__` 不是记号 —— 它在 tccdefs.h 里是 `#define … __FUNCTION__`，
 * 我们照它办（见 tccdefs.js 的那一条）。 */
export const TOK___FUNCTION__ = fixed('__FUNCTION__');
export const TOK___FUNC__ = fixed('__func__');
export const TOK___COUNTER__ = fixed('__COUNTER__');
export const TOK___HAS_INCLUDE = fixed('__has_include');
export const TOK___HAS_INCLUDE_NEXT = fixed('__has_include_next');
export const TOK_push_macro = fixed('push_macro');
export const TOK_pop_macro = fixed('pop_macro');
export const TOK_once = fixed('once');
/* `#pragma pack(push, 4)`（第八刀第十八片）。`push`/`pop` 在 tcc 那边是汇编器的记号
 * （`TOK_ASM_push`），这儿单独两条 —— 我们还没有汇编器那张表。 */
export const TOK_pack = fixed('pack');
export const TOK_push = fixed('push');
export const TOK_pop = fixed('pop');

/* `__attribute__((aligned(16)))` / `((packed))`（第八刀第三十四片，`tcctok.h:118`/`:120`）。
 * 两种拼法各占一格 —— 与别的关键字同一条理由：tcc 不做别名折叠。 */
export const TOK_ALIGNED1 = fixed('aligned');
export const TOK_ALIGNED2 = fixed('__aligned__');
export const TOK_PACKED1 = fixed('packed');
export const TOK_PACKED2 = fixed('__packed__');
/* `__attribute__((weak))`（第一百〇四片，`tcctok.h:114-115`）：改的是符号的**绑定**
 * —— ELF 里 STB_WEAK、Mach-O 里 N_WEAK_DEF。 */
export const TOK_WEAK1 = fixed('weak');
export const TOK_WEAK2 = fixed('__weak__');
/* `__attribute__((alias("目标")))`（第一百〇五片，`tcctok.h:116-117`）：这个名字与
 * 目标名指着**同一个地址**，符号表里两条。 */
export const TOK_ALIAS1 = fixed('alias');
export const TOK_ALIAS2 = fixed('__alias__');

/* ------------------------------------------------- tccgen 要用的那些（第六刀）
 * 语句关键字与类型关键字。之前只有预处理器在用这张表，所以只导出了指令名那一段。 */

export const TOK_WHILE = fixed('while');
export const TOK_FOR = fixed('for');
export const TOK_DO = fixed('do');
export const TOK_CONTINUE = fixed('continue');
export const TOK_BREAK = fixed('break');
export const TOK_RETURN = fixed('return');
export const TOK_GOTO = fixed('goto');
export const TOK_SWITCH = fixed('switch');
export const TOK_CASE = fixed('case');
export const TOK_DEFAULT = fixed('default');

export const TOK_EXTERN = fixed('extern');
export const TOK_STATIC = fixed('static');
export const TOK_UNSIGNED = fixed('unsigned');
export const TOK_SIGNED = fixed('signed');
export const TOK_CONST = fixed('const');
export const TOK_REGISTER = fixed('register');
export const TOK_AUTO = fixed('auto');
export const TOK_VOLATILE = fixed('volatile');
export const TOK_INLINE = fixed('inline');

/* gcc 的下划线拼法各占一格（tcc 不做别名折叠，见 KEYWORD_NAMES 那儿的理由），
 * 所以要用的时候得一个一个报出来。真的系统头里这些到处都是（第八刀第十六片）。 */
export const TOK_CONST1 = fixed('__const');
export const TOK_CONST2 = fixed('__const__');
export const TOK_VOLATILE1 = fixed('__volatile');
export const TOK_VOLATILE2 = fixed('__volatile__');
export const TOK_SIGNED1 = fixed('__signed');
export const TOK_SIGNED2 = fixed('__signed__');
export const TOK_INLINE1 = fixed('__inline');
export const TOK_INLINE2 = fixed('__inline__');
export const TOK_RESTRICT = fixed('restrict');
export const TOK_RESTRICT1 = fixed('__restrict');
export const TOK_RESTRICT2 = fixed('__restrict__');
export const TOK_EXTENSION = fixed('__extension__');
export const TOK_ATOMIC = fixed('_Atomic');
export const TOK_THREAD_LOCAL = fixed('_Thread_local');
export const TOK_THREAD = fixed('__thread');
export const TOK_ATTRIBUTE1 = fixed('__attribute');
export const TOK_ATTRIBUTE2 = fixed('__attribute__');
export const TOK_ASM2 = fixed('__asm');
export const TOK_ASM3 = fixed('__asm__');

export const TOK_VOID = fixed('void');
export const TOK_CHAR = fixed('char');
export const TOK_INT = fixed('int');
export const TOK_BOOL = fixed('_Bool');
export const TOK_FLOAT = fixed('float');
export const TOK_DOUBLE = fixed('double');
export const TOK_SHORT = fixed('short');
export const TOK_LONG = fixed('long');
export const TOK_STRUCT = fixed('struct');
export const TOK_UNION = fixed('union');
export const TOK_TYPEDEF = fixed('typedef');
export const TOK_ENUM = fixed('enum');
export const TOK_SIZEOF = fixed('sizeof');
/* `__alignof__` / `__alignof` / `_Alignof`（第八刀第三十五片，`tcctok.h:64-66`）。
 * 三种拼法在 tcc 那边是 `TOK_ALIGNOF1/2/3`，一条 case 三个入口。 */
export const TOK_ALIGNOF1 = fixed('__alignof');
export const TOK_ALIGNOF2 = fixed('__alignof__');
export const TOK_ALIGNOF3 = fixed('_Alignof');
/* GNU 的 `typeof`（第八刀第五十一片，`tcctok.h:67-69`）。三种拼法，一条 case 三个入口；
 * C23 把它写进了标准（`typeof`），系统头里用的多半是 `__typeof__`。 */
export const TOK_TYPEOF1 = fixed('typeof');
export const TOK_TYPEOF2 = fixed('__typeof');
export const TOK_TYPEOF3 = fixed('__typeof__');
/* GNU 的块局部标签声明 `__label__ a, b;`（第八刀第五十二片，`tcctok.h:70`）。 */
export const TOK_LABEL = fixed('__label__');
/* `_Static_assert(sizeof(t) == 12, "…")`（第八刀第十八片）。macOS 的 `<mach/message.h>`
 * 用它把 mach 消息那几个结构体的尺寸钉住 —— 也就是说它同时在考我们的 struct 布局。 */
export const TOK_STATIC_ASSERT = fixed('_Static_assert');

/* arm64 上 `va_start` / `va_arg` 是**编译器内建**（`tcctok.h:181-182`）：它们要的不是
 * 函数调用，是「按调用约定去形参区里走」的代码。`va_end` / `va_copy` 在 tcc 那边是
 * tccdefs.h 里的两个宏（`(void)(ap)` 与 `(dest)=(src)`）—— 我们没有那份头文件，
 * 所以把它们也做成内建，可观察的行为一模一样。 */
export const TOK_BUILTIN_VA_START = fixed('__builtin_va_start');
export const TOK_BUILTIN_VA_ARG = fixed('__builtin_va_arg');
export const TOK_BUILTIN_VA_END = fixed('__builtin_va_end');
export const TOK_BUILTIN_VA_COPY = fixed('__builtin_va_copy');
export const TOK_BUILTIN_EXPECT = fixed('__builtin_expect');
export const TOK_BUILTIN_TYPES_COMPATIBLE_P = fixed('__builtin_types_compatible_p');

/**
 * `TOK_ASSIGN(t)`（`tcc.h:1168`）与 `TOK_ASSIGN_OP(t)`（`tcc.h:1169`）。
 * 后者把**顺序当数据用**：`"+-*\/%&|^<>"[t - TOK_A_ADD]` 直接得到那个二元运算符的记号号，
 * 因为 `<<`/`>>` 借的正是 `'<'`/`'>'` 的码位（见上面 TOK_SHL）。所以照抄这张字符串，
 * 不写 switch —— 换成 switch 就多了一份要与编号同步维护的东西。
 */
export const TOK_ASSIGN_CHARS = '+-*/%&|^<>';
export function isAssignOp(t) { return t >= TOK_A_ADD && t <= TOK_A_SAR; }
export function assignOpOf(t) { return TOK_ASSIGN_CHARS.charCodeAt(t - TOK_A_ADD); }
