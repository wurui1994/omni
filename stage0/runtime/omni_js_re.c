/* JS 的 RegExp：手写回溯匹配器（ADR-0011 "已知风险" 第一条）
 *
 * 为什么是手写回溯，而不是引一个正则引擎、也不是编 NFA/DFA：
 * 用编译器自己的 JS 词法器把源码里的正则字面量数过一遍 —— 49 个，去重后 35 条，全部很短。
 * 用到的特性是一张封闭的清单：字符类（含范围与取反）、锚点、量词、捕获组、几个转义、
 * flags 里的 g/m/i。**一个 `|` 都没有**，没有 lookahead、没有反向引用、没有 unicode
 * 属性转义。既然被量出来是最小的一块而不是最大的一块，那正确的代价就是几百行回溯，
 * 不是一个正则引擎项目：DFA 要处理子表达式捕获，代码量与出错面都比这大一个数量级，
 * 而 JS 的 "最左 + 最早候选" 语义本来就是回溯语义，照着 ECMA-262 的 Matcher 写反而最不容易分叉。
 *
 * 在 UTF-16 定长码元上做这件事比在 UTF-8 上简单（ADR-0011 第 8 节）：`lastIndex`、
 * 捕获组的 `[起, 止)` 全是码元下标，直接就是数组下标，不需要在字节流上模拟码元口径。
 * 所有位置量一律是码元下标 —— 代理对被当成两个码元，跟没有 `u` flag 的 JS 一致。
 *
 * 实现形状：解析成 arena 上的节点数组（用下标而不是指针互指，省掉一层间接，也省掉
 * "谁 free" 的问题），匹配是带 continuation 的递归函数。continuation 显式建模成一条
 * 栈上的链（re_kont），因为 "组结束要把捕获的止点写回" 与 "量词的下一轮迭代" 这两件事
 * 都是 ECMA-262 里 Matcher 的闭包，链式 continuation 是它最直白的 C 对应物。
 *
 * 刻意不做的（用到就 omni_errorf 报错，而不是悄悄匹配错 —— 后者会让 C1 与 node 分叉
 * 到一个极难定位的地方去）：
 *   - lookahead / lookbehind / 反向引用 / 命名组 / `\b` / `\x` / `\c`
 *   - flags 里的 `s` `u` `y` `v` `d`
 *   - unicode 属性转义 `\p{...}`
 *   - `i` 只折 ASCII（A-Z <-> a-z）。C 侧没有大小写表，而 prelude.js 那边用的是宿主
 *     完整的 Unicode 折叠：真要对齐就得两边都搬一张表进来。现在的选择是两边都只折
 *     ASCII —— 两个后端必须一样不完整，否则不完整本身就变成了分叉点。编译器源码里的
 *     `i` 只用在十六进制数字与 ASCII 标识符上（`[0-9a-fA-F]`、`[A-Za-z_]`），
 *     真需要更多时测试轴会先炸出来。
 */
#include "omni.h"

/* ---------------------------------------------------------------- 节点表示 */

enum {
  RE_CHAR,   /* 单个码元 */
  RE_ANY,    /* `.` —— 除行终止符以外的任意码元（没有 `s` flag 的 JS 语义） */
  RE_CLASS,  /* [...] / [^...] / \d \w \s 那一批 */
  RE_BOL,    /* ^ */
  RE_EOL,    /* $ */
  RE_WB,     /* \b / \B（negate 区分）—— 零宽断言，两侧"是不是单词码元"不同即成立 */
  RE_GROUP,  /* (...) 与 (?:...) */
  RE_ALT,    /* a|b|c */
  RE_REP     /* 量词 */
};

typedef struct { uint16_t lo, hi; } re_range;

/* 一个量词体里最多认多少个捕获组：每轮迭代都要保存/清空它们（见 re_rep_body），
   固定上界换来一个栈上数组，不必为每轮迭代去 arena 上要内存（迭代数是无界的，
   那样会让一次匹配把 arena 撑起来）。实测集里最多 1 个，32 是纯粹的余量。 */
#define RE_MAX_REP_GROUPS 32

typedef struct {
  int kind;
  int next;        /* 同一序列里的下一个节点；-1 = 这条序列到头了 */
  uint16_t ch;     /* RE_CHAR */
  int negate;      /* RE_CLASS：[^...] */
  int rlo, rn;     /* RE_CLASS：ranges[rlo .. rlo+rn) */
  int child;       /* RE_GROUP / RE_REP：子表达式的头节点 */
  int group;       /* RE_GROUP：捕获组号（1 起），-1 = (?:) 不捕获 */
  int *alts;       /* RE_ALT：各候选的头节点 */
  int nalts;
  int64_t min, max; /* RE_REP：max < 0 表示无上限 */
  int lazy;        /* RE_REP：`?` 后缀 */
  int glo, ghi;    /* RE_REP：体内捕获组号区间 [glo, ghi) */
} re_node;

struct omni_re_s {
  re_node *nodes;
  re_range *ranges;
  int head;        /* 整个模式的头节点，-1 = 空模式（匹配空串） */
  int ngroups;
  bool global, multiline, icase;
};

/* ---------------------------------------------------------------- 字符谓词 */

/* JS 的 LineTerminator。`.` 不匹配这四个，`m` 下的 ^ $ 认这四个。 */
static bool re_is_lt(uint16_t c) {
  return c == 0x0a || c == 0x0d || c == 0x2028 || c == 0x2029;
}

/* \b 认的"单词码元"就是 \w 那一套：[A-Za-z0-9_]（非 unicode 模式的 JS 语义） */
static bool re_is_wordc(uint16_t c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

/* ---------------------------------------------------------------- 解析 */

typedef struct {
  const uint16_t *p;
  int64_t n, i;
  re_node *nodes;
  int nn, ncap;
  re_range *ranges;
  int nr, rcap;
  int ngroups;
} re_parse;

OMNI_NORETURN static void re_err(re_parse *ps, const char *msg) {
  omni_errorf("regexp: %s (at index %lld of the pattern)", msg, (long long)ps->i);
}

static int re_new(re_parse *ps, int kind) {
  if (ps->nn >= ps->ncap) omni_error("regexp: internal: node table overflow");
  re_node *nd = &ps->nodes[ps->nn];
  nd->kind = kind;
  nd->next = -1;
  nd->ch = 0;
  nd->negate = 0;
  nd->rlo = nd->rn = 0;
  nd->child = -1;
  nd->group = -1;
  nd->alts = NULL;
  nd->nalts = 0;
  nd->min = 0;
  nd->max = -1;
  nd->lazy = 0;
  nd->glo = nd->ghi = 0;
  return ps->nn++;
}

static void re_add_range(re_parse *ps, uint32_t lo, uint32_t hi) {
  if (ps->nr >= ps->rcap) omni_error("regexp: internal: range table overflow");
  ps->ranges[ps->nr].lo = (uint16_t)lo;
  ps->ranges[ps->nr].hi = (uint16_t)hi;
  ps->nr++;
}

/* \s 的成员：JS 的 WhiteSpace + LineTerminator。这张表必须和 omni_str16.c 里
   omni_s16_trim 用的 ws() 一字不差 —— 同一份规范里的同一个集合分成两处写，
   迟早会漂；漂了之后 trim 与 /\s+/ 对同一个字符给不同答案，两个后端一起错还算好，
   一边错一边对就是不动点的死法。 */
static void re_add_space(re_parse *ps) {
  re_add_range(ps, 0x09, 0x0d);   /* TAB LF VT FF CR */
  re_add_range(ps, 0x20, 0x20);
  re_add_range(ps, 0xa0, 0xa0);
  re_add_range(ps, 0x1680, 0x1680);
  re_add_range(ps, 0x2000, 0x200a);
  re_add_range(ps, 0x2028, 0x2029);
  re_add_range(ps, 0x202f, 0x202f);
  re_add_range(ps, 0x205f, 0x205f);
  re_add_range(ps, 0x3000, 0x3000);
  re_add_range(ps, 0xfeff, 0xfeff);
}

static void re_add_digit(re_parse *ps) { re_add_range(ps, '0', '9'); }

static void re_add_word(re_parse *ps) {
  re_add_range(ps, 'A', 'Z');
  re_add_range(ps, 'a', 'z');
  re_add_range(ps, '0', '9');
  re_add_range(ps, '_', '_');
}

/* 认得的类转义。返回 true 表示 c 是 \d \D \s \S \w \W 之一，范围已经追加好。 */
static bool re_esc_set(re_parse *ps, uint16_t c, int *rlo, int *rn, int *neg) {
  *rlo = ps->nr;
  *neg = 0;
  switch (c) {
    case 'D': *neg = 1; /* fallthrough */
    case 'd': re_add_digit(ps); break;
    case 'S': *neg = 1; /* fallthrough */
    case 's': re_add_space(ps); break;
    case 'W': *neg = 1; /* fallthrough */
    case 'w': re_add_word(ps); break;
    default: return false;
  }
  *rn = ps->nr - *rlo;
  return true;
}

static int re_hex(uint16_t c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* 单码元转义（\ 已经吃掉，c 是它后面那个码元）。清单之外一律报错：
   悄悄把 \b 当成 "字面 b" 或 "退格" 都比当场失败糟得多。 */
static uint16_t re_esc_char(re_parse *ps, uint16_t c) {
  switch (c) {
    case 'n': return 0x0a;
    case 'r': return 0x0d;
    case 't': return 0x09;
    case 'v': return 0x0b;
    case 'f': return 0x0c;
    case '0':
      /* \0 是 NUL；\0 后面跟数字是遗留八进制转义，不认 */
      if (ps->i < ps->n && ps->p[ps->i] >= '0' && ps->p[ps->i] <= '9') {
        re_err(ps, "legacy octal escape is not supported");
      }
      return 0x00;
    case '\\': case '/': case '.': case '+': case '*': case '?':
    case '(': case ')': case '[': case ']': case '{': case '}':
    case '|': case '^': case '$': case '-':
      return c;
    case 'u': {
      /* 只认定长的 \uXXXX。`\u{...}` 要 `u` flag，而 `u` flag 本身不支持。 */
      if (ps->i + 4 > ps->n) re_err(ps, "\\u escape needs 4 hex digits");
      uint32_t v = 0;
      for (int k = 0; k < 4; k++) {
        int h = re_hex(ps->p[ps->i + k]);
        if (h < 0) re_err(ps, "\\u escape needs 4 hex digits");
        v = (v << 4) | (uint32_t)h;
      }
      ps->i += 4;
      return (uint16_t)v;
    }
    case 'b': return 0x08;   /* 只有类里面会走到这儿：`[\b]` 在 JS 里是退格 */
    case 'B': return 'B';    /* `[\B]` 是身份转义（Annex B） */
    case 'x': re_err(ps, "\\xNN escape is not supported, use \\uXXXX");
    case 'c': re_err(ps, "\\cX control escape is not supported");
    case 'p': re_err(ps, "\\p{...} unicode property escape is not supported");
    case 'P': re_err(ps, "\\P{...} unicode property escape is not supported");
    case 'k': re_err(ps, "\\k<name> backreference is not supported");
    default:
      if (c >= '1' && c <= '9') re_err(ps, "backreference is not supported");
      re_err(ps, "unknown escape");
  }
}

/* [...] / [^...]。空类 `[]` 保留成 "永不匹配"、`[^]` 成 "匹配任意码元" ——
   这是 JS 的定义，取反标志加在空集上自然就对。 */
static int re_class(re_parse *ps) {
  int node = re_new(ps, RE_CLASS);
  ps->i++;  /* '[' */
  if (ps->i < ps->n && ps->p[ps->i] == '^') { ps->nodes[node].negate = 1; ps->i++; }
  int rlo = ps->nr;
  while (ps->i < ps->n && ps->p[ps->i] != ']') {
    uint16_t c = ps->p[ps->i];
    bool is_set = false;
    uint16_t lo = 0;
    if (c == '\\') {
      ps->i++;
      if (ps->i >= ps->n) re_err(ps, "trailing backslash");
      uint16_t e = ps->p[ps->i++];
      int srlo, srn, sneg;
      if (re_esc_set(ps, e, &srlo, &srn, &sneg)) {
        if (sneg) {
          /* [\D] 这类要求 "范围集合的补" 参与并集，而这里的表示只有一个取反位。
             实测集里没有，所以拒绝而不是硬凑 —— 硬凑出来的语义很难验。 */
          re_err(ps, "negated class escape (\\D \\S \\W) inside [...] is not supported");
        }
        (void)srlo; (void)srn;
        is_set = true;
      } else {
        lo = re_esc_char(ps, e);
      }
    } else {
      lo = c;
      ps->i++;
    }
    if (is_set) continue;
    /* 范围：`-` 后面还有东西且不是收尾的 `]` 时才当范围，否则 `-` 是字面量 */
    if (ps->i + 1 < ps->n && ps->p[ps->i] == '-' && ps->p[ps->i + 1] != ']') {
      ps->i++;  /* '-' */
      uint16_t hi;
      if (ps->p[ps->i] == '\\') {
        ps->i++;
        if (ps->i >= ps->n) re_err(ps, "trailing backslash");
        uint16_t e = ps->p[ps->i++];
        int srlo, srn, sneg;
        if (re_esc_set(ps, e, &srlo, &srn, &sneg)) {
          re_err(ps, "class escape as a range endpoint is not supported");
        }
        hi = re_esc_char(ps, e);
      } else {
        hi = ps->p[ps->i++];
      }
      if (hi < lo) re_err(ps, "range out of order in character class");
      re_add_range(ps, lo, hi);
    } else {
      re_add_range(ps, lo, lo);
    }
  }
  if (ps->i >= ps->n) re_err(ps, "unterminated character class");
  ps->i++;  /* ']' */
  ps->nodes[node].rlo = rlo;
  ps->nodes[node].rn = ps->nr - rlo;
  return node;
}

static int re_alt(re_parse *ps);

static int re_atom(re_parse *ps) {
  uint16_t c = ps->p[ps->i];
  switch (c) {
    case '^': ps->i++; return re_new(ps, RE_BOL);
    case '$': ps->i++; return re_new(ps, RE_EOL);
    case '.': ps->i++; return re_new(ps, RE_ANY);
    case '[': return re_class(ps);
    case '*': case '+': case '?': re_err(ps, "nothing to repeat");
    case '{': re_err(ps, "unescaped '{' is not supported, write \\{");
    case '(': {
      ps->i++;
      int group = -1;
      if (ps->i < ps->n && ps->p[ps->i] == '?') {
        uint16_t k = ps->i + 1 < ps->n ? ps->p[ps->i + 1] : 0;
        if (k == ':') {
          ps->i += 2;
        } else if (k == '=' || k == '!') {
          re_err(ps, "lookahead is not supported");
        } else if (k == '<') {
          uint16_t k2 = ps->i + 2 < ps->n ? ps->p[ps->i + 2] : 0;
          if (k2 == '=' || k2 == '!') re_err(ps, "lookbehind is not supported");
          re_err(ps, "named capture group is not supported");
        } else {
          re_err(ps, "unsupported group modifier after '(?'");
        }
      } else {
        group = ++ps->ngroups;
      }
      int node = re_new(ps, RE_GROUP);
      ps->nodes[node].group = group;
      ps->nodes[node].child = re_alt(ps);
      if (ps->i >= ps->n || ps->p[ps->i] != ')') re_err(ps, "unterminated group");
      ps->i++;
      return node;
    }
    case '\\': {
      ps->i++;
      if (ps->i >= ps->n) re_err(ps, "trailing backslash");
      uint16_t e = ps->p[ps->i++];
      /* \b / \B 是**断言**，不是码元，所以在这里分流（类里面的 `[\b]` 仍然是退格，
         那条走 re_esc_char）。零宽，位置不动。 */
      if (e == 'b' || e == 'B') {
        int node = re_new(ps, RE_WB);
        ps->nodes[node].negate = (e == 'B');
        return node;
      }
      int rlo, rn, neg;
      if (re_esc_set(ps, e, &rlo, &rn, &neg)) {
        int node = re_new(ps, RE_CLASS);
        ps->nodes[node].rlo = rlo;
        ps->nodes[node].rn = rn;
        ps->nodes[node].negate = neg;
        return node;
      }
      int node = re_new(ps, RE_CHAR);
      ps->nodes[node].ch = re_esc_char(ps, e);
      return node;
    }
    default: {
      /* `]` 与 `}` 落单时是字面量（node 也这么认），其余都是普通码元 */
      int node = re_new(ps, RE_CHAR);
      ps->nodes[node].ch = c;
      ps->i++;
      return node;
    }
  }
}

/* 量词。g0 是解析 atom 之前的捕获组计数：体内的组区间要记在 RE_REP 上，
   每轮迭代前清成 -1（JS 的 RepeatMatcher 就是这么定的，见 re_rep_body）。 */
static int re_quant(re_parse *ps, int atom, int g0) {
  if (ps->i >= ps->n) return atom;
  int64_t lo, hi;
  uint16_t c = ps->p[ps->i];
  if (c == '*') { lo = 0; hi = -1; ps->i++; }
  else if (c == '+') { lo = 1; hi = -1; ps->i++; }
  else if (c == '?') { lo = 0; hi = 1; ps->i++; }
  else if (c == '{') {
    int64_t save = ps->i;
    ps->i++;
    if (ps->i >= ps->n || ps->p[ps->i] < '0' || ps->p[ps->i] > '9') {
      ps->i = save;
      re_err(ps, "malformed quantifier: '{' must be followed by a number");
    }
    lo = 0;
    while (ps->i < ps->n && ps->p[ps->i] >= '0' && ps->p[ps->i] <= '9') {
      lo = lo * 10 + (ps->p[ps->i++] - '0');
      if (lo > 1000000) re_err(ps, "quantifier bound is too large");
    }
    if (ps->i < ps->n && ps->p[ps->i] == ',') {
      ps->i++;
      if (ps->i < ps->n && ps->p[ps->i] == '}') {
        hi = -1;  /* {n,} */
      } else {
        hi = 0;
        if (ps->i >= ps->n || ps->p[ps->i] < '0' || ps->p[ps->i] > '9') {
          re_err(ps, "malformed quantifier");
        }
        while (ps->i < ps->n && ps->p[ps->i] >= '0' && ps->p[ps->i] <= '9') {
          hi = hi * 10 + (ps->p[ps->i++] - '0');
          if (hi > 1000000) re_err(ps, "quantifier bound is too large");
        }
      }
    } else {
      hi = lo;  /* {n} */
    }
    if (ps->i >= ps->n || ps->p[ps->i] != '}') re_err(ps, "malformed quantifier");
    ps->i++;
    if (hi >= 0 && hi < lo) re_err(ps, "quantifier range out of order");
  } else {
    return atom;
  }

  int kind = ps->nodes[atom].kind;
  if (kind == RE_BOL || kind == RE_EOL || kind == RE_WB) re_err(ps, "quantifier after an anchor is not supported");

  int lazy = 0;
  if (ps->i < ps->n && ps->p[ps->i] == '?') { lazy = 1; ps->i++; }
  if (ps->i < ps->n && (ps->p[ps->i] == '*' || ps->p[ps->i] == '+' || ps->p[ps->i] == '?')) {
    re_err(ps, "nothing to repeat (a quantifier cannot follow a quantifier)");
  }

  int node = re_new(ps, RE_REP);
  ps->nodes[node].child = atom;
  ps->nodes[node].min = lo;
  ps->nodes[node].max = hi;
  ps->nodes[node].lazy = lazy;
  ps->nodes[node].glo = g0 + 1;
  ps->nodes[node].ghi = ps->ngroups + 1;
  if (ps->ngroups - g0 > RE_MAX_REP_GROUPS) {
    re_err(ps, "too many capture groups inside one quantifier");
  }
  return node;
}

/* 一条候选：atom 串成 next 链。空候选返回 -1（`(a|)` 是合法的）。 */
static int re_seq(re_parse *ps) {
  int head = -1, tail = -1;
  while (ps->i < ps->n && ps->p[ps->i] != '|' && ps->p[ps->i] != ')') {
    int g0 = ps->ngroups;
    int a = re_quant(ps, re_atom(ps), g0);
    if (head < 0) head = a; else ps->nodes[tail].next = a;
    tail = a;
  }
  return head;
}

static int re_alt(re_parse *ps) {
  int first = re_seq(ps);
  if (ps->i >= ps->n || ps->p[ps->i] != '|') return first;
  /* 候选数以剩余模式长度为上界，一次分配到位 —— 模式都是几十个码元，不值得增长数组 */
  int cap = (int)(ps->n - ps->i) + 2;
  int *alts = (int *)omni_alloc((size_t)cap * sizeof(int));
  int n = 0;
  alts[n++] = first;
  while (ps->i < ps->n && ps->p[ps->i] == '|') {
    ps->i++;
    if (n >= cap) omni_error("regexp: internal: alternative table overflow");
    alts[n++] = re_seq(ps);
  }
  int node = re_new(ps, RE_ALT);
  ps->nodes[node].alts = alts;
  ps->nodes[node].nalts = n;
  return node;
}

omni_re omni_re_compile(omni_s16 pattern, omni_s16 flags) {
  struct omni_re_s *re = (struct omni_re_s *)omni_alloc(sizeof *re);
  re->global = re->multiline = re->icase = false;
  for (int64_t k = 0; k < flags.len; k++) {
    uint16_t f = flags.p[k];
    switch (f) {
      case 'g':
        if (re->global) omni_error("regexp: duplicate flag 'g'");
        re->global = true; break;
      case 'm':
        if (re->multiline) omni_error("regexp: duplicate flag 'm'");
        re->multiline = true; break;
      case 'i':
        if (re->icase) omni_error("regexp: duplicate flag 'i'");
        re->icase = true; break;
      case 's': omni_error("regexp: flag 's' (dotAll) is not supported");
      case 'u': omni_error("regexp: flag 'u' (unicode) is not supported");
      case 'v': omni_error("regexp: flag 'v' (unicodeSets) is not supported");
      case 'y': omni_error("regexp: flag 'y' (sticky) is not supported");
      case 'd': omni_error("regexp: flag 'd' (hasIndices) is not supported");
      default: omni_errorf("regexp: unknown flag (code unit %u)", (unsigned)f);
    }
  }

  if (pattern.len > (1 << 20)) omni_error("regexp: pattern is too long");

  re_parse ps;
  ps.p = pattern.p;
  ps.n = pattern.len;
  ps.i = 0;
  /* 上界：每个模式码元最多产出一个节点（`a{2}` 6 个码元产出 2 个），范围最多 16 个
     （`\s` 一个转义展成 10 段）。一次分配到位，省掉增长逻辑。 */
  ps.ncap = (int)(2 * pattern.len + 8);
  ps.nodes = (re_node *)omni_alloc((size_t)ps.ncap * sizeof(re_node));
  ps.nn = 0;
  ps.rcap = (int)(16 * pattern.len + 32);
  ps.ranges = (re_range *)omni_alloc((size_t)ps.rcap * sizeof(re_range));
  ps.nr = 0;
  ps.ngroups = 0;

  re->head = re_alt(&ps);
  if (ps.i != ps.n) re_err(&ps, "unmatched ')'");

  re->nodes = ps.nodes;
  re->ranges = ps.ranges;
  re->ngroups = ps.ngroups;
  return re;
}

int omni_re_groups(omni_re re) { return re->ngroups; }
bool omni_re_global(omni_re re) { return re->global; }
bool omni_re_multiline(omni_re re) { return re->multiline; }

/* ---------------------------------------------------------------- 匹配 */

enum {
  RE_K_DONE,  /* 整个模式匹配成功 */
  RE_K_NODE,  /* 接着匹配 node（候选跑完之后回到 alt 的后继） */
  RE_K_GRP,   /* 组体跑完：把捕获的止点写回，再接着匹配 node */
  RE_K_REP    /* 量词体的一轮跑完：判空转、再决定下一轮还是退出 */
};

typedef struct re_kont_s {
  int kind;
  int node;
  int grp;
  int rep, count;
  int64_t iter_start;
  const struct re_kont_s *up;
} re_kont;

/* 步数与深度的两道闸。
   步数防的是指数回溯（`(a*)*b` 之类）：不设闸就是挂住，设了闸是当场报错，
   后者在自举流水线里可定位得多。上界跟着输入长度走，因为扫描本身是 O(len)。
   深度防的是爆栈：量词的每一轮迭代是一层 C 递归，长输入上的贪婪量词会一路加深。
   两个都是 "宁可响亮地失败" —— 悄悄给错答案才是真的贵。 */
#define RE_MAX_DEPTH 20000

typedef struct {
  omni_re re;
  const uint16_t *s;
  int64_t slen;
  int64_t *caps;
  int64_t steps, limit;
  int64_t depth;
} re_mc;

static bool re_m(re_mc *cx, int node, int64_t pos, const re_kont *k);
static bool re_rep_try(re_mc *cx, int rep, int count, int64_t pos, const re_kont *up);

static uint16_t re_fold(uint16_t c) {
  return (c >= 'A' && c <= 'Z') ? (uint16_t)(c + 32) : c;
}

static bool re_eq(re_mc *cx, uint16_t a, uint16_t b) {
  return cx->re->icase ? re_fold(a) == re_fold(b) : a == b;
}

static bool re_cls_in(re_mc *cx, const re_node *nd, uint16_t c) {
  const re_range *r = cx->re->ranges + nd->rlo;
  for (int i = 0; i < nd->rn; i++) {
    if (c >= r[i].lo && c <= r[i].hi) return true;
  }
  return false;
}

/* `i` 下拿 c 与它的 ASCII 对偶各试一遍，而不是把类里的范围折过来 ——
   范围折叠会把 `[A-_]` 这种跨越大小写边界的区间搞错，逐字符试两次不会。
   取反在 "两次都没中" 之后再取，跟 ECMA-262 的 CharacterSetMatcher 一致。 */
static bool re_cls_hit(re_mc *cx, const re_node *nd, uint16_t c) {
  bool hit = re_cls_in(cx, nd, c);
  if (!hit && cx->re->icase) {
    uint16_t o = c;
    if (c >= 'A' && c <= 'Z') o = (uint16_t)(c + 32);
    else if (c >= 'a' && c <= 'z') o = (uint16_t)(c - 32);
    if (o != c) hit = re_cls_in(cx, nd, o);
  }
  return nd->negate ? !hit : hit;
}

/* 量词的一轮迭代。进体之前把体内的捕获组清成 -1：JS 的 RepeatMatcher 每轮都清，
   所以 `(?:(a)|b)` 加星号匹配 "ab" 之后第 1 组是 undefined（最后一轮走的是 b 那条）。
   失败要原样还原，否则回溯之后捕获会带着一轮失败迭代的残留。 */
static bool re_rep_body(re_mc *cx, int rep, int count, int64_t pos, const re_kont *up) {
  const re_node *nd = &cx->re->nodes[rep];
  int64_t save[2 * RE_MAX_REP_GROUPS];
  int ng = nd->ghi - nd->glo;
  for (int i = 0; i < ng; i++) {
    int g = nd->glo + i;
    save[2 * i] = cx->caps[2 * g];
    save[2 * i + 1] = cx->caps[2 * g + 1];
    cx->caps[2 * g] = -1;
    cx->caps[2 * g + 1] = -1;
  }
  re_kont kk;
  kk.kind = RE_K_REP;
  kk.node = -1;
  kk.grp = -1;
  kk.rep = rep;
  kk.count = count + 1;
  kk.iter_start = pos;
  kk.up = up;
  if (re_m(cx, nd->child, pos, &kk)) return true;
  for (int i = 0; i < ng; i++) {
    int g = nd->glo + i;
    cx->caps[2 * g] = save[2 * i];
    cx->caps[2 * g + 1] = save[2 * i + 1];
  }
  return false;
}

/* 贪婪先试再来一轮、懒惰先试退出；没到 min 之前没有选择权。
   这个顺序就是 "最左匹配之后按最早候选" 的全部内容 —— JS 不是 POSIX 最长匹配。 */
static bool re_rep_try(re_mc *cx, int rep, int count, int64_t pos, const re_kont *up) {
  const re_node *nd = &cx->re->nodes[rep];
  if (++cx->steps > cx->limit) {
    omni_error("regexp: too many backtracking steps (pattern is pathological)");
  }
  bool can_more = (nd->max < 0) || (count < nd->max);
  if (count < nd->min) return re_rep_body(cx, rep, count, pos, up);
  if (nd->lazy) {
    if (re_m(cx, nd->next, pos, up)) return true;
    return can_more ? re_rep_body(cx, rep, count, pos, up) : false;
  }
  if (can_more && re_rep_body(cx, rep, count, pos, up)) return true;
  return re_m(cx, nd->next, pos, up);
}

static bool re_kdo(re_mc *cx, const re_kont *k, int64_t pos) {
  switch (k->kind) {
    case RE_K_DONE:
      cx->caps[1] = pos;
      return true;
    case RE_K_NODE:
      return re_m(cx, k->node, pos, k->up);
    case RE_K_GRP: {
      int g = k->grp;
      int64_t old = -1;
      if (g > 0) { old = cx->caps[2 * g + 1]; cx->caps[2 * g + 1] = pos; }
      if (re_m(cx, k->node, pos, k->up)) return true;
      if (g > 0) cx->caps[2 * g + 1] = old;
      return false;
    }
    case RE_K_REP: {
      const re_node *nd = &cx->re->nodes[k->rep];
      /* 空转保护，照抄 ECMA-262 的 RepeatMatcher：这一轮开始时剩余 min 已经是 0，
         而这一轮又没吃掉任何码元，就让它失败 —— 于是 `(a*)*` 退出循环而不是转圈。 */
      int64_t min_at = nd->min - (k->count - 1);
      if (min_at < 0) min_at = 0;
      if (min_at == 0 && pos == k->iter_start) return false;
      return re_rep_try(cx, k->rep, k->count, pos, k->up);
    }
    default:
      omni_error("regexp: internal: bad continuation kind");
  }
}

/* 单个节点。串行的那几种（字面量、类、锚点）用循环往下走而不是递归：
   一条几十个码元的字面量序列不该占几十层 C 栈，深度只留给真正需要回溯的地方。 */
static bool re_m1(re_mc *cx, int node, int64_t pos, const re_kont *k) {
  for (;;) {
    if (++cx->steps > cx->limit) {
      omni_error("regexp: too many backtracking steps (pattern is pathological)");
    }
    if (node < 0) return re_kdo(cx, k, pos);
    const re_node *nd = &cx->re->nodes[node];
    switch (nd->kind) {
      case RE_CHAR:
        if (pos >= cx->slen || !re_eq(cx, cx->s[pos], nd->ch)) return false;
        node = nd->next; pos++; continue;
      case RE_ANY:
        if (pos >= cx->slen || re_is_lt(cx->s[pos])) return false;
        node = nd->next; pos++; continue;
      case RE_CLASS:
        if (pos >= cx->slen || !re_cls_hit(cx, nd, cx->s[pos])) return false;
        node = nd->next; pos++; continue;
      case RE_BOL:
        if (!(pos == 0 || (cx->re->multiline && re_is_lt(cx->s[pos - 1])))) return false;
        node = nd->next; continue;
      case RE_EOL:
        if (!(pos == cx->slen || (cx->re->multiline && re_is_lt(cx->s[pos])))) return false;
        node = nd->next; continue;
      /* \b：左右两侧"是不是单词码元"不同就成立（串首/串尾当非单词侧）。\B 取反。
         零宽 —— pos 不动，所以量词后缀在解析期就拒了。 */
      case RE_WB: {
        bool before = pos > 0 && re_is_wordc(cx->s[pos - 1]);
        bool after = pos < cx->slen && re_is_wordc(cx->s[pos]);
        bool at = before != after;
        if (nd->negate ? at : !at) return false;
        node = nd->next; continue;
      }
      case RE_ALT: {
        re_kont kk;
        kk.kind = RE_K_NODE;
        kk.node = nd->next;
        kk.grp = -1;
        kk.rep = kk.count = 0;
        kk.iter_start = 0;
        kk.up = k;
        for (int i = 0; i < nd->nalts; i++) {
          if (re_m(cx, nd->alts[i], pos, &kk)) return true;
        }
        return false;
      }
      case RE_GROUP: {
        int g = nd->group;
        int64_t os = -1, oe = -1;
        if (g > 0) {
          os = cx->caps[2 * g];
          oe = cx->caps[2 * g + 1];
          cx->caps[2 * g] = pos;
        }
        re_kont kk;
        kk.kind = RE_K_GRP;
        kk.node = nd->next;
        kk.grp = g;
        kk.rep = kk.count = 0;
        kk.iter_start = 0;
        kk.up = k;
        if (re_m(cx, nd->child, pos, &kk)) return true;
        if (g > 0) { cx->caps[2 * g] = os; cx->caps[2 * g + 1] = oe; }
        return false;
      }
      case RE_REP:
        return re_rep_try(cx, node, 0, pos, k);
      default:
        omni_error("regexp: internal: bad node kind");
    }
  }
}

static bool re_m(re_mc *cx, int node, int64_t pos, const re_kont *k) {
  if (++cx->depth > RE_MAX_DEPTH) {
    omni_error("regexp: match recursion too deep (pattern or input is pathological)");
  }
  bool r = re_m1(cx, node, pos, k);
  cx->depth--;
  return r;
}

/* 从 start 起逐位置试，第一个成功的位置就是答案（最左匹配）。
   上界是 s.len 而不是 s.len-1：空匹配可以落在串尾（`/x*$/` 需要它）。 */
bool omni_re_search(omni_re re, omni_s16 s, int64_t start, int64_t *caps) {
  if (start < 0) start = 0;
  if (start > s.len) return false;

  re_mc cx;
  cx.re = re;
  cx.s = s.p;
  cx.slen = s.len;
  cx.caps = caps;
  cx.steps = 0;
  cx.depth = 0;
  /* 扫描本身就是 O(len)，所以闸门跟着长度走；常数项给短串留出回溯余量 */
  cx.limit = 4000000 + 256 * s.len;

  re_kont done;
  done.kind = RE_K_DONE;
  done.node = -1;
  done.grp = -1;
  done.rep = done.count = 0;
  done.iter_start = 0;
  done.up = NULL;

  int ncap = 2 * (re->ngroups + 1);
  for (int64_t at = start; at <= s.len; at++) {
    for (int i = 0; i < ncap; i++) caps[i] = -1;
    caps[0] = at;
    cx.depth = 0;
    if (re_m(&cx, re->head, at, &done)) return true;
  }
  return false;
}

/* ---------------------------------------------------------------- 编译缓存 */

/* 模式与 flags 都来自源码里的正则字面量，生成的 C 里是同一个 static 字符串，
   所以指针本身就是身份 —— 直接拿指针当键，命中就不必重新解析。
   词法器里 `/[A-Za-z0-9_]/.test(...)` 是每个字符一次的热路径，没有缓存的话
   每个字符都要重新解析一遍模式。
   开放寻址，满了就整表丢掉重来：条目数是源码里正则字面量的条数（量过 35 条），
   撑不到需要淘汰策略的地步，而"丢掉重来"比"退化成不缓存"更容易解释。 */
/* 缓存的键是模式与 flags 的**内容**，不是指针。
   一开始按字面量指针做键，是因为源码里的正则全是字面量；但 `const IDENT_KEY = /re/`
   这种把正则存进变量再用的写法也是量出来的，那时模式串是运行期拼出来的对象字段，
   指针每次都不同。按内容做键两种写法都命中，代价只是一次哈希 + 一次比较。 */
#define RE_CACHE_N 128

typedef struct {
  omni_s16 pat;
  omni_s16 flags;
  omni_re re;
} re_cache_ent;

static re_cache_ent re_cache[RE_CACHE_N];
static int re_cache_count;

omni_re omni_js_re_get(omni_dyn pattern_d, omni_dyn flags_d) {  omni_s16 pattern = omni_js_as_s16(pattern_d);
  omni_s16 flags = omni_js_as_s16(flags_d);
  size_t h = (size_t)omni_s16_hash(pattern) * 31u + (size_t)omni_s16_hash(flags);
  for (int probe = 0; probe < 8; probe++) {
    re_cache_ent *e = &re_cache[(h + (size_t)probe) % RE_CACHE_N];
    if (!e->re) break;
    if (omni_s16_eq(e->pat, pattern) && omni_s16_eq(e->flags, flags)) return e->re;
  }
  omni_re re = omni_re_compile(pattern, flags);
  if (omni_re_groups(re) > OMNI_RE_MAX_CAPS - 1) omni_error("regexp: too many capturing groups");
  if (re_cache_count >= RE_CACHE_N / 2) {
    memset(re_cache, 0, sizeof re_cache);
    re_cache_count = 0;
  }
  for (int probe = 0; probe < 8; probe++) {
    re_cache_ent *e = &re_cache[(h + (size_t)probe) % RE_CACHE_N];
    if (e->re) continue;
    e->pat = pattern;
    e->flags = flags;
    e->re = re;
    re_cache_count++;
    break;
  }
  return re;
}

/* 正则当值（ADR-0011 决策 10 的第二半）：造一格正则对象。编译产物不存在这里 ——
   exec 每次照旧问 omni_js_re_get 要，缓存键就是 (source, flags)。
   这里先编译一次：模式不合法要在**造它的那一刻**报错，与 JS 的
   `new RegExp(bad)` 一样，不能等到第一次 exec 才响。 */
omni_dyn omni_js_re_new(omni_dyn source, omni_dyn flags) {
  omni_js_re_obj *r = (omni_js_re_obj *)omni_alloc((int64_t)sizeof(omni_js_re_obj));
  omni_js_re_get(source, flags);
  r->src = omni_js_as_s16(source);
  r->flags = omni_js_as_s16(flags);
  r->li = 0;
  return omni_dyn_of_ref((void *)r, OMNI_DYN_RE);
}

/* test：仓库里所有 `.test()` 的正则都没有 g（量过），所以没有 lastIndex 这回事，
   永远从 0 开始找。真出现带 g 的 test，语义会和 JS 分叉，所以那种情况直接报错。 */
bool omni_js_re_test(omni_dyn pattern, omni_dyn flags, omni_dyn s) {
  omni_re re = omni_js_re_get(pattern, flags);
  if (omni_re_global(re)) omni_error("regexp: .test on a /g/ regexp is not supported (lastIndex has no home here)");
  int64_t caps[2 * OMNI_RE_MAX_CAPS];
  return omni_re_search(re, omni_js_as_s16(s), 0, caps);
}

