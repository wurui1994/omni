// src/core/graph/backend-c.js —— **图这一层的第五个后端：C**（第一百四十六片，第一刀）
//
// ## 为什么是 C，而且为什么与 `wat` 那一格对称
//
// `wat` 那一格立住的理由是「正确性由一条互不相干的已有实现来证」：出来的文本交给
// **另一个前端**（`frontend-wat`）读、用 MIR 的解释器真跑。C 这一格走同一条路 ——
// 出来的文本交给**我们自己那台 C 前端**（`frontend-c`，ADR-0017）读、还是那台 MIR
// 解释器跑。于是这条腿不欠外部 cc 一个字，也不欠链接器一个字。
//
// 与 `wat` 一样，产物是**自足**的：宿主面只有 libc 那几格（`printf` / `malloc` /
// `snprintf` / `strtod` / `memcpy` / `strlen` / `strcmp`），没有 `omni.h`、
// 不链运行时的 `.o`。理由是对称性：`wat` 那一格的宿主面就是那四格 `print_*` 导入，
// C 这一格若反过来把整套 `omni_dyn` 运行时拽进来，两格的判据就不在同一条线上了。
//
// ## 这一刀接住的（第一批 + 早退）
//
//   const · ref · bind · set · prim（下面那 16 格内建）· branch · loop · loop-exit ·
//   region · ret
//
// 接不住的**有名有姓**（`can` 那一问逐格回答，`gaps()` 把清单算出来）：
// 函数与调用、多值、记录、列表、映射、表示转换、切片、scope-exit。它们不是「以后再说」，
// 是这一刀故意没画进来的下一刀 —— 每一格都要先有一份判据（`tests/graph/run.js`
// 那张语言 × 后端矩阵里对应的例子家族）才动。
//
// ## 值怎么落（`carry` 那一问的答案）
//
// 一格 16 字节的 `gv`：`t` 是标签、`b` 是载荷（bool 的 0/1、double 的位模式、
// 串的指针）。**16 字节**不是随便挑的：arm64 与 x86_64 的 ABI 都把它放进两个寄存器，
// 再大一格就走内存（我们自己那台后端也一样，`tests/c/abi` 那八种形状量过）。
//
// 数就是 double（与调度器同一条：图上的数是宿主的 number）。所以印法也得与
// `eval.js` 的 `showValue` 对上 —— 整数印整数，非整数印**最短能读回来的那一份**
// （`snprintf` + `strtod` 一格一格试，1..17 位），NaN / 无穷按 JS 的写法印。
// 这一格是两条腿唯一可能悄悄不一致的地方，所以判据是矩阵里逐行比输出，不是「看着像」。

import { runMirModule } from '../mir/interp.js';
import { setOutSink } from '../interp/builtin.js';
import { dirname, join } from '../host/path.js';
import { lowerC } from '../frontend-c/tccgen.js';
import { declOf } from './nodes.js';
import { node } from './graph.js';
import { PRIMS } from './prims.js';
import { Gap } from './backend-wat.js';
/* **lambda 提升那一份与 core 共用**（`src/core/graph/lift.js`）：内层函数提到顶层、
   捕获当多出来的形参、每处调用补实参。C 里没有嵌套函数，这一趟是必须的。 */
import { liftBody } from './lift.js';

/** 这一刀接得住的节点。别的一律有名有姓地报缺口（`can` 那一问）。 */
const OPS = new Set(['const', 'ref', 'bind', 'set', 'prim', 'branch', 'loop', 'loop-exit',
  'region', 'ret', 'func', 'call',
  'list-new', 'index-get', 'index-set', 'record-new', 'field-get', 'field-set',
  'map-new', 'map-get', 'map-set', 'map-has', 'values', 'pick', 'conv', 'slice',
  'scope-exit', 'assert']);

/** 这一刀接得住的内建。`prims.js` 里现有 24 格，全在这儿。 */
const C_PRIMS = new Set(['+', '-', '*', '/', '%', '^', '<', '>', '<=', '>=', '=', '!=',
  'not', 'concat', 'len', 'print', 'push', 'contains', 'fill',
  /* 位运算那六格（C 里就是 `& | ^ ~ << >>`，不需要 BigInt 那层转译）。 */
  'band', 'bor', 'bxor', 'bnot', 'shl', 'shr']);

/**
 * 产物开头那一段**固定的 C**：值的表示 + 真值观 + 印法 + 那几格内建的实现。
 *
 * 三条纪律写在这儿：
 *   1. **不 `#include` 任何东西** —— 用到的 libc 原型自己写。这样这份 C 交给谁都编得动
 *      （我们自己那台前端、tcc、clang 都试过），也不必猜宿主的头在哪儿。
 *   2. **不用编译器扩展**：没有语句表达式、没有 VLA、没有嵌套函数。理由与
 *      `backend-c/emit.js` 头上那条一样 —— 真 tcc 的 `VSTACK_SIZE` 是 256，
 *      而扩展会把「另一台 C 编译器也得编得动」这条判据废掉。
 *   3. 数按 double 走，印法与 `eval.js` 的 `showValue` **逐字符对齐**（见文件头）。
 */
const PRELUDE = `/* graph -> C —— 自足的产物：宿主面只有 libc 那七格 */
int printf(const char *, ...);
int snprintf(char *, unsigned long, const char *, ...);
double strtod(const char *, char **);
void *malloc(unsigned long);
void *realloc(void *, unsigned long);
void *memcpy(void *, const void *, unsigned long);
unsigned long strlen(const char *);
int strcmp(const char *, const char *);
void exit(int);

/* 一格值：t 是标签、b 是载荷。16 字节 —— 两个 ABI 都把它放进两个寄存器。 */
typedef struct gv { long long t; long long b; } gv;

#define GT_NIL 0
#define GT_BOOL 1
#define GT_NUM 2
#define GT_STR 3
#define GT_LIST 4
#define GT_REC 5
#define GT_MAP 6
#define GT_VALS 7

/* 骂一句再退。**不悄悄给错答案**：越界、缺键、没定的格式都走这儿 —— 与调度器那侧
 * 「当场报」同一条（eval.js 里那几处 throw）。 */
static void g_die(const char *msg) {
  printf("graph-c: %s\\n", msg);
  exit(3);
}

/* 列表与记录都是**堆上一块**（载荷里躺的是指针）。记录的键是编译期就知道的常量串，
 * 所以键那一格是 const char * 的数组 —— 与 js 后端那侧「表示与 interp 相同」同一条：
 * 两条腿的可观察行为一致就够，内部怎么摆各自定。 */
typedef struct glist { long long n; gv *v; } glist;
typedef struct grec { long long n; const char **k; gv *v; } grec;
/* 映射：键**按值**比，所以只能顺着找（g_eq）。九门语言里没有一门要求它有序，
 * 而「一格哈希表」这一层不必要 —— 例子里的映射都是几格到几十格。 */
typedef struct gmap { long long n; long long cap; gv *k; gv *v; } gmap;

static gv g_nil(void) { gv v; v.t = GT_NIL; v.b = 0; return v; }
static gv g_bool(long long x) { gv v; v.t = GT_BOOL; v.b = x != 0 ? 1 : 0; return v; }
static gv g_num(double d) { gv v; v.t = GT_NUM; memcpy(&v.b, &d, 8); return v; }
static double g_d(gv v) { double d; memcpy(&d, &v.b, 8); return d; }
static gv g_str(const char *s) { gv v; v.t = GT_STR; memcpy(&v.b, &s, 8); return v; }
static const char *g_s(gv v) { const char *s; memcpy(&s, &v.b, 8); return s; }

static glist *g_L(gv v) { glist *p; memcpy(&p, &v.b, 8); return p; }
static grec *g_R(gv v) { grec *p; memcpy(&p, &v.b, 8); return p; }
static gmap *g_M(gv v) { gmap *p; memcpy(&p, &v.b, 8); return p; }

static gv g_list_new(gv *items, long long n) {
  glist *L = (glist *)malloc(sizeof(glist));
  L->n = n;
  L->v = (gv *)malloc(sizeof(gv) * (n > 0 ? n : 1));
  long long i = 0;
  while (i < n) { L->v[i] = items[i]; i++; }
  gv v;
  v.t = GT_LIST;
  memcpy(&v.b, &L, 8);
  return v;
}

/* 多值：与列表同一块结构，只是标签不同 —— 印法（空格分隔）与取第 k 格靠标签分开。 */
static gv g_vals_new(gv *items, long long n) {
  gv v = g_list_new(items, n);
  v.t = GT_VALS;
  return v;
}

/* 取多值的第 k 格。**不是多值时第 0 格就是它自己**，别的格是 nil ——
 * 与 eval.js 的 valPick 一字不差（两个后端共用那一份的口径）。 */
static gv g_pick(gv v, long long i) {
  if (v.t != GT_VALS) return i == 0 ? v : g_nil();
  glist *L = g_L(v);
  if (i < 0 || i >= L->n) return g_nil();
  return L->v[i];
}

static gv g_rec_new(const char **keys, gv *vals, long long n) {
  grec *R = (grec *)malloc(sizeof(grec));
  R->n = n;
  R->k = keys;
  R->v = (gv *)malloc(sizeof(gv) * (n > 0 ? n : 1));
  long long i = 0;
  while (i < n) { R->v[i] = vals[i]; i++; }
  gv v;
  v.t = GT_REC;
  memcpy(&v.b, &R, 8);
  return v;
}

/* 真值观：**只有 false / nil 是假**（\`eval.js\` 的 valTruthy —— 0 与 "" 都是真）。
 * 四门语言各有一套更宽的读法，调度器给的是最保守这一档，两条腿必须同一档。 */
static long long g_truthy(gv v) {
  if (v.t == GT_NIL) return 0;
  if (v.t == GT_BOOL) return v.b;
  return 1;
}
`;

/**
 * 印法那一段。与 `eval.js` 的 `showValue` 对齐，逐条：
 *   nil -> `nil`、bool -> `true`/`false`、串 -> 它本身；
 *   数 -> 整数印整数；非整数印**最短能读回来的那一份**（1..17 位一格一格试）；
 *   NaN -> `NaN`、无穷 -> `Infinity` / `-Infinity`（JS 的写法，不是 C 的 `inf`）。
 *
 * 最短那一条不是讲究好看：`String(0.1)` 在 JS 里是 `0.1`，而 C 的 `%.17g` 会印成
 * `0.10000000000000001`。两条腿输出逐行比，这一处不对齐就是整张矩阵红。
 */
const P_SHOW = `/* ---- 印法（与调度器的 showValue 逐字符对齐） */
static char *g_dup(const char *s) {
  unsigned long n = strlen(s);
  char *p = (char *)malloc(n + 1);
  memcpy(p, s, n + 1);
  return p;
}

static char *g_num_str(double d) {
  char buf[48];
  if (d != d) return g_dup("NaN");
  if (d == 1.0 / 0.0) return g_dup("Infinity");
  if (d == -1.0 / 0.0) return g_dup("-Infinity");
  /* 整数那一档：JS 的 String() 对 |d| < 1e21 的整数印十进制整数 */
  if (d == (double)(long long)d && d < 9.0e18 && d > -9.0e18) {
    snprintf(buf, 48, "%lld", (long long)d);
    return g_dup(buf);
  }
  int p = 1;
  while (p <= 17) {
    snprintf(buf, 48, "%.*g", p, d);
    if (strtod(buf, 0) == d) break;
    p++;
  }
  return g_dup(buf);
}

/* 把两段接起来（concat 与 print 的分隔符都用它）。 */
static char *g_cat2(const char *a, const char *b) {
  unsigned long na = strlen(a);
  unsigned long nb = strlen(b);
  char *p = (char *)malloc(na + nb + 1);
  memcpy(p, a, na);
  memcpy(p + na, b, nb + 1);
  return p;
}

/* 列表印 [a, b]、记录印 {k = v, l = w} —— 与 showValue 那两句一字不差。
 * 自己套自己，所以先给一句声明。 */
static char *g_show(gv v);

static char *g_show_list(gv v) {
  glist *L = g_L(v);
  char *s = g_dup("[");
  long long i = 0;
  while (i < L->n) {
    if (i > 0) s = g_cat2(s, ", ");
    s = g_cat2(s, g_show(L->v[i]));
    i++;
  }
  return g_cat2(s, "]");
}

static char *g_show_rec(gv v) {
  grec *R = g_R(v);
  char *s = g_dup("{");
  long long i = 0;
  while (i < R->n) {
    if (i > 0) s = g_cat2(s, ", ");
    s = g_cat2(s, R->k[i]);
    s = g_cat2(s, " = ");
    s = g_cat2(s, g_show(R->v[i]));
    i++;
  }
  return g_cat2(s, "}");
}

static char *g_show_vals(gv v) {
  glist *L = g_L(v);
  char *s = g_dup("");
  long long i = 0;
  while (i < L->n) {
    if (i > 0) s = g_cat2(s, " ");
    s = g_cat2(s, g_show(L->v[i]));
    i++;
  }
  return s;
}

static char *g_show(gv v) {
  if (v.t == GT_NIL) return g_dup("nil");
  if (v.t == GT_BOOL) return g_dup(v.b != 0 ? "true" : "false");
  if (v.t == GT_STR) return g_dup(g_s(v));
  if (v.t == GT_LIST) return g_show_list(v);
  if (v.t == GT_REC) return g_show_rec(v);
  if (v.t == GT_VALS) return g_show_vals(v);
  /* **打印一格 map 没有格式**：go 印 map[a:1]、nim 印 {"a": 1}、lua 印地址 ——
   * 四门各一套，调度器不替谁选，所以这一格当场骂（调度器那侧也是 throw）。 */
  if (v.t == GT_MAP) g_die("print: 打印一格 map 的格式还没定（四门语言各不相同）");
  return g_num_str(g_d(v));
}
`;

/**
 * 那几格内建的实现。三处口径要与 `eval.js` 对上，各有出处：
 *   - `+` 掺进串就是**串接**（JS 的 `+`，`eval` 那侧 `a.reduce((x, y) => x + y)` 也是）；
 *   - `=`/`!=` 是 `===`：标签不同就是不等，串比内容；
 *   - `<` 一族数按数比、串按字典序比（JS 的关系算符）。
 *
 * `%` 与 `^` 是这一格唯一的**近似**，记在账上：libc 那张桥（`interp/libc.js`）里没有
 * `fmod`、也没有 `pow`。所以 `%` 用「减去整商乘除数」算（两边都是整数时精确 ——
 * 图上的数几乎都是整数），`^` 只做整数次幂（乘上去）。指数不是整数时**当场骂一句再退**，
 * 不悄悄给个错答案；那种形状在 `lower` 那一侧就报缺口（见 `C_SHAPES` 第一条）。
 */
const P_PRIM = `/* ---- 内建 */
static double g_fmod(double a, double b) {
  double q = a / b;
  double t = (double)(long long)q;
  return a - b * t;
}

static double g_pow(double a, double b) {
  double t = (double)(long long)b;
  if (t != b) g_die("^ 的指数不是整数（这一格还没接：libc 那张桥里没有 pow）");
  long long n = (long long)b;
  double r = 1.0;
  long long neg = n < 0 ? 1 : 0;
  if (neg != 0) n = -n;
  while (n > 0) { r = r * a; n--; }
  if (neg != 0) return 1.0 / r;
  return r;
}

static gv g_add(gv a, gv b) {
  if (a.t == GT_STR || b.t == GT_STR) return g_str(g_cat2(g_show(a), g_show(b)));
  return g_num(g_d(a) + g_d(b));
}

static long long g_eq(gv a, gv b) {
  if (a.t != b.t) return 0;
  if (a.t == GT_NIL) return 1;
  if (a.t == GT_STR) return strcmp(g_s(a), g_s(b)) == 0 ? 1 : 0;
  if (a.t == GT_BOOL) return a.b == b.b ? 1 : 0;
  return g_d(a) == g_d(b) ? 1 : 0;
}

/* 关系算符：串按字典序、别的按数。回 -1 / 0 / 1。 */
static long long g_cmp(gv a, gv b) {
  if (a.t == GT_STR && b.t == GT_STR) {
    int c = strcmp(g_s(a), g_s(b));
    return c < 0 ? -1 : (c > 0 ? 1 : 0);
  }
  double x = g_d(a);
  double y = g_d(b);
  return x < y ? -1 : (x > y ? 1 : 0);
}

static gv g_len(gv v) {
  if (v.t == GT_STR) return g_num((double)strlen(g_s(v)));
  if (v.t == GT_LIST) return g_num((double)g_L(v)->n);
  return g_num(0.0);
}

/* print：各格 g_show 之后用一个空格接起来，末尾一个换行。 */
static void g_print(gv *a, long long n) {
  char *s = g_dup("");
  long long i = 0;
  while (i < n) {
    if (i > 0) s = g_cat2(s, " ");
    s = g_cat2(s, g_show(a[i]));
    i++;
  }
  printf("%s\\n", s);
}

/* 一格 / 两格实参的 print：那是**绝大多数**（十门例子里数出来的），而按数组那条路要发
 * 三行（声明缓冲、逐格赋值、调）。这两格把那三行收成一行 —— 语义还是上面那一格。 */
static void g_print1(gv a) { gv b[1]; b[0] = a; g_print(b, 1); }
static void g_print2(gv a, gv b) { gv c[2]; c[0] = a; c[1] = b; g_print(c, 2); }

/* 列表追加（V 的 arr << x）：改的是那格列表本身。每次 realloc —— 这一批不给它容量那一栏
   （例子里的列表是几格到几十格；那一栏是性能的事，不是语义的事）。 */
static gv g_push(gv xs, gv x) {
  if (xs.t != GT_LIST) g_die("push: 第一格不是列表");
  glist *L = g_L(xs);
  L->v = (gv *)realloc(L->v, sizeof(gv) * (unsigned long)(L->n + 1));
  L->v[L->n] = x;
  L->n = L->n + 1;
  return g_nil();
}

/* g_fill: make([]T, n) -- n slots, each set to v (scalar only). */
static gv g_fill(gv n, gv v) {
  long long k = (long long)g_d(n);
  if (k < 0) g_die("fill: len must be >= 0");
  gv out = g_list_new((gv *)0, 0);
  long long i = 0;
  while (i < k) { g_push(out, v); i = i + 1; }
  return out;
}

/* 成员是不是在里头：列表**找元素**（线性扫，用 g_eq —— 与 map 的键比同一条）。
   串找子串**刻意不接**：没有一份判据用得上它（见 prims.js 那一行）。 */
static gv g_contains(gv c, gv x) {
  if (c.t != GT_LIST) g_die("contains: 第一格不是列表");
  glist *L = g_L(c);
  long long i = 0;
  while (i < L->n) { if (g_eq(L->v[i], x)) return g_bool(1); i++; }
  return g_bool(0);
}

/* 断言：不成立就把那句话印在同一格 print 上、然后停下来。
   "停下来"在 C 这一侧是 exit(1) —— 退出码不在图上，那是这条腿自己的样子。 */
static void g_assert(gv cond, gv msg, long long has_msg) {
  if (g_truthy(cond)) return;
  if (has_msg) printf("assert failed: %s\\n", g_show(msg));
  else printf("assert failed\\n");
  exit(1);
}
`;

const PRELUDE_ALL = () => PRELUDE + P_SHOW + P_PRIM + P_AGG;

/**
 * 列表与记录的存取。**越界与缺字段一律当场骂了再退**，不给零值、不给 nil ——
 * 与 `eval.js` 那侧一字不差（`index` 的注释里写着「越界当场报」，`field` 的
 * 「没有这一格字段」同理）。九门语言的默认值答案各不相同，调度器不替谁选，
 * 那么两条腿也都不许自己选一个。
 */
const P_AGG = `/* ---- 列表与记录的存取（越界 / 缺字段都是硬错） */
static long long g_idx(gv o, gv i) {
  if (o.t != GT_LIST) g_die("index: 不是一格列表");
  if (i.t != GT_NUM) g_die("index: 下标不是数");
  double d = g_d(i);
  long long k = (long long)d;
  if ((double)k != d) g_die("index: 下标不是整数");
  if (k < 0 || k >= g_L(o)->n) g_die("index: 下标越界");
  return k;
}

static gv g_index_get(gv o, gv i) { return g_L(o)->v[g_idx(o, i)]; }
static void g_index_set(gv o, gv i, gv x) { g_L(o)->v[g_idx(o, i)] = x; }

static long long g_key(gv o, const char *k) {
  if (o.t != GT_REC) g_die("field: 不是一格记录");
  grec *R = g_R(o);
  long long i = 0;
  while (i < R->n) {
    if (strcmp(R->k[i], k) == 0) return i;
    i++;
  }
  g_die("field: 没有这一格字段");
  return 0;
}

static gv g_field_get(gv o, const char *k) { return g_R(o)->v[g_key(o, k)]; }
static void g_field_set(gv o, const char *k, gv x) { g_R(o)->v[g_key(o, k)] = x; }

/* ---- 映射那四格。缺键**当场骂**（不给零值、不给 nil）—— 见 eval.js 那一段。 */
static void g_map_set(gv o, gv k, gv x);

static gv g_map_new(gv *ks, gv *vs, long long n) {
  gmap *M = (gmap *)malloc(sizeof(gmap));
  long long cap = n > 0 ? n : 4;
  M->n = 0;
  M->cap = cap;
  M->k = (gv *)malloc(sizeof(gv) * cap);
  M->v = (gv *)malloc(sizeof(gv) * cap);
  gv o;
  o.t = GT_MAP;
  memcpy(&o.b, &M, 8);
  long long i = 0;
  while (i < n) { g_map_set(o, ks[i], vs[i]); i++; }
  return o;
}

static long long g_map_find(gv o, gv k) {
  if (o.t != GT_MAP) g_die("map: 不是一格映射");
  gmap *M = g_M(o);
  long long i = 0;
  while (i < M->n) {
    if (g_eq(M->k[i], k) != 0) return i;
    i++;
  }
  return -1;
}

static void g_map_set(gv o, gv k, gv x) {
  long long at = g_map_find(o, k);
  gmap *M = g_M(o);
  if (at >= 0) { M->v[at] = x; return; }
  if (M->n == M->cap) {
    M->cap = M->cap * 2;
    M->k = (gv *)realloc(M->k, sizeof(gv) * M->cap);
    M->v = (gv *)realloc(M->v, sizeof(gv) * M->cap);
  }
  M->k[M->n] = k;
  M->v[M->n] = x;
  M->n = M->n + 1;
}

static gv g_map_get(gv o, gv k) {
  long long at = g_map_find(o, k);
  if (at < 0) g_die("map-get: 没有这一格键");
  return g_M(o)->v[at];
}

static gv g_map_has(gv o, gv k) { return g_bool(g_map_find(o, k) >= 0 ? 1 : 0); }

/* ---- 表示转换（conv）。目标只有四种，与 eval.js 的 convert 一条一条对：
 *   int  截断（向零）· float 就是数 · str 走 g_show · bool 走真值观。
 * 「数」这一步照 JS 的 Number()：串按 strtod、nil 是 0、真假是 1/0。
 * 列表 / 记录 / 映射转数在 JS 里是另一套（Number([]) 是 0、Number({}) 是 NaN），
 * 这一格给 NaN 并记在账上 —— 那种用法十门规格里一门都没有。 */
static double g_tonum(gv v) {
  if (v.t == GT_NUM) return g_d(v);
  if (v.t == GT_BOOL) return v.b != 0 ? 1.0 : 0.0;
  if (v.t == GT_NIL) return 0.0;
  if (v.t == GT_STR) return strtod(g_s(v), 0);
  return 0.0 / 0.0;
}

static gv g_conv_int(gv v) {
  double d = g_tonum(v);
  if (d != d) return g_num(d);
  return g_num((double)(long long)d);
}

/* ---- 切片。**只切列表**（eval.js 那侧对非列表直接报），范围越界当场骂。 */
static gv g_slice(gv o, gv from, gv to) {
  if (o.t != GT_LIST) g_die("slice: 不是一格列表");
  glist *L = g_L(o);
  long long a = from.t == GT_NIL ? 0 : (long long)g_tonum(from);
  long long b = to.t == GT_NIL ? L->n : (long long)g_tonum(to);
  if (a < 0 || b > L->n || a > b) g_die("slice: 范围越界");
  return g_list_new(L->v + a, b - a);
}
`;

/** 名字要能当 C 标识符用（Scheme 的 `string-append`、awk 的 `$0` 那种）。 */
const cName = (n) => `v_${String(n).replace(/[^A-Za-z0-9_]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}`;

/** 一格 struct 字段名（与 `cName` 同一套转义，前缀不同 —— 免得撞上 C 的关键字）。 */
const cField = (n) => `f_${String(n).replace(/[^A-Za-z0-9_]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}`;

/** 一格 C 串字面量。C 与 JSON 的转义不同一套，所以自己来（八进制那两格是关键）。 */
function cStr(s) {
  let out = '"';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (c < 32 || c === 127) out += `\\${c.toString(8).padStart(3, '0')}`;
    else if (c < 128) out += ch;
    else {
      /* 非 ASCII 按 UTF-8 的字节逐个八进制转义 —— 这样源码本身是纯 ASCII，
       * 谁的编译器都不会在编码上出岔子，而运行期字节与 JS 那侧的串一致。 */
      for (const b of new TextEncoder().encode(ch)) out += `\\${b.toString(8).padStart(3, '0')}`;
    }
  }
  return `${out}"`;
}

const asList = (b) => (b === undefined || b === null ? [] : (Array.isArray(b) ? b : [b]));

/** 这个节点是个**看得见的数常量**吗（`{lit}` 或 `const`）—— 是就回它，不是回 null。 */
function constNum(x) {
  if (x === null || x === undefined) return null;
  if (typeof x.lit === 'number') return x.lit;
  if (x.op === 'const' && typeof x.attrs.value === 'number') return x.attrs.value;
  return null;
}

/**
 * 一块子图**读到了哪些外面的名字** —— 捕获检测（`func` 那一格的判据）。
 *
 * 为什么要它：函数提到顶层之后，C 那侧看得见的只有形参与别的顶层函数；函数体里读一格
 * 外层的局部量（真闭包）在 C 里没有落处（要一格环境对象）。所以**先数出来、当场报缺口**，
 * 而不是发一份编不动的 C —— 缺口是账，编不动是事故。`wat` 那侧的第一条形状账是同一件事。
 *
 * `bound` 用数组而不是 Set：这一格要能被我们自己编出来的编译器编（ADR-0011 的封闭子集）。
 */
function freeRefs(x, bound, out) {
  if (x === null || x === undefined) return;
  if (Array.isArray(x)) {
    for (const y of x) freeRefs(y, bound, out);
    return;
  }
  if (x.op === undefined) return;
  if (x.op === 'ref') {
    const n = x.attrs.name;
    if (!bound.includes(n) && !out.includes(n)) out.push(n);
    return;
  }
  if (x.op === 'bind') {
    /* **绑一格函数的时候名字先坐下**：函数看得见自己（那就是"递归"这个词的意思）——
       Scheme 的内层 `define`、go/V 的具名函数都是。`chez` 那份 basics 的
       `(define (go i acc) … (go (+ i 1) …))` 就是这个形状：`go` 在自己体里不是捕获。
       原来一律"先递归进 init、再把名字记上"，于是 `go` 被数成了自由名字，
       `sumto` 当场报"捕获了外层的名字（go）—— 真闭包要一格环境对象"。
       **别的初值照旧后记**：`let x = x + 1` 里那个 `x` 是外层那一格。 */
    if (x.ins.init !== undefined && x.ins.init !== null && x.ins.init.op === 'func') {
      bound.push(x.attrs.name);
      freeRefs(x.ins.init, bound, out);
      return;
    }
    freeRefs(x.ins.init, bound, out);
    bound.push(x.attrs.name);
    return;
  }
  if (x.op === 'set') {
    const n = x.attrs.name;
    if (!bound.includes(n) && !out.includes(n)) out.push(n);
    freeRefs(x.ins.value, bound, out);
    return;
  }
  if (x.op === 'func') {
    const inner = bound.slice();
    for (const p of x.attrs.params ?? []) inner.push(p);
    freeRefs(x.ins.body, inner, out);
    return;
  }
  const ins = x.ins ?? {};
  for (const k of Object.keys(ins)) freeRefs(ins[k], bound, out);
}

/**
 * **数值窄化**（`docs/design/node-graph-shrink.md` 第五节第 3 条）：哪几格量
 * **从头到尾只装数**。它们落成 C 的 `double` 而不是 16 字节的 `gv`，
 * 于是那一族 `g_num(g_d(…))` 的往返跟着消掉。
 *
 * 这一趟同时算两样，因为它们**互相依赖**（所以是一个不动点，不是两趟）：
 *   `locals`  一个函数体（顶层那一块，或者一格 `func`）里窄成 `double` 的局部量；
 *   `params`  一格**有名字的顶层函数**，它的形参窄成 `double` ——
 *             条件是**每一个调用点递进来的都是数**（而「是数」又可能是「某格窄了的局部量」）。
 *
 * 判断只用图上现成的东西，一格新声明都不加：
 *   - 局部量：这个体里的 `bind` 绑它、初值**是数**，且这个体里对它的每一次 `set` 也**是数**；
 *   - 「是数」= 数字常量 / `len` / `conv int|float`（这三样怎么算都出数）
 *     / `+ - * / % ^` 且实参都是数（`+` 只有在实参都是数时才是加法 —— 串接那一路不算）
 *     / `ref` 一格**同样窄了**的名字（局部量或者窄了的形参）。
 *
 * 五处保守，每一处都有理由：
 *   1. **同名绑两次就不窄**：C 那侧两次 `bind` 落在两层块里各是一格声明，而这儿只有一张
 *      按名字的表 —— 分不开就不动。
 *   2. **一次调用的结果不算数**：函数回的是 `gv`，回 nil 也可能（返回值那一格没窄），
 *      而 `g_d(nil)` 是读一串没意义的字节。所以 `bind x = f()` 不窄。
 *   3. **函数名被当值用过就不窄形参**：那一路的调用点数不齐（`callOf` 里也报缺口）。
 *   4. **匿名 `func` 不窄形参**：它没名字，调用点认不出来。
 *   5. 一轮下来只**去掉**候选，不加 —— 于是必然停。
 */
const NUM_PRIMS = ['+', '-', '*', '/', '%', '^'];
function numPlan(top) {
  const bodies = [];                 /* { key, list, params } —— 一格「体」= 一个 C 函数 */
  const nameOfBody = new Map();      /* 体的 key -> 那个函数的名字（匿名的没有） */
  const namedFn = new Map();         /* 名字 -> { key, params } */
  const badFnRef = new Set();        /* 被当值用过的名字（保守第 3 条） */
  const seen = new Set();
  const walkAll = (x, inFnSlot) => {
    if (x === null || x === undefined) return;
    if (Array.isArray(x)) { for (const y of x) walkAll(y, false); return; }
    if (x.op === undefined) return;
    /* `ref` 是叶子，不去重 —— 同一格 ref 被两处引用时，"当值用过"这件事要认得出来。 */
    if (x.op === 'ref') {
      if (!inFnSlot) badFnRef.add(x.attrs.name);
      return;
    }
    if (seen.has(x.id)) return;
    seen.add(x.id);
    if (x.op === 'bind' && x.ins.init !== null && x.ins.init !== undefined
      && x.ins.init.op === 'func') {
      nameOfBody.set(x.ins.init.id, x.attrs.name);
      namedFn.set(x.attrs.name, { key: x.ins.init.id, params: x.ins.init.attrs.params ?? [] });
    }
    if (x.op === 'func') bodies.push({ key: x.id, list: asList(x.ins.body), params: x.attrs.params ?? [] });
    for (const k of Object.keys(x.ins ?? {})) {
      walkAll(x.ins[k], x.op === 'call' && k === 'fn');
    }
  };
  walkAll(top, false);
  bodies.push({ key: 'top', list: asList(top), params: [] });

  /* ---- 每个体自己那几样：绑了谁、写了谁、调了谁、`ret` 回了什么（**不进嵌套的 func 体**）。 */
  const info = new Map();
  for (const b of bodies) {
    const count = new Map();
    const inits = new Map();
    const writes = [];
    const calls = [];
    const retVals = [];
    const s = new Set();
    const scan = (x) => {
      if (x === null || x === undefined) return;
      if (Array.isArray(x)) { for (const y of x) scan(y); return; }
      if (x.op === undefined || s.has(x.id)) return;
      s.add(x.id);
      if (x.op === 'func') return;
      if (x.op === 'bind') {
        count.set(x.attrs.name, (count.get(x.attrs.name) ?? 0) + 1);
        inits.set(x.attrs.name, x.ins.init);
        scan(x.ins.init);
        return;
      }
      if (x.op === 'set') { writes.push([x.attrs.name, x.ins.value]); scan(x.ins.value); return; }
      if (x.op === 'ret') {
        retVals.push(x.ins.value === undefined ? null : x.ins.value);
        scan(x.ins.value);
        return;
      }
      if (x.op === 'call') {
        const fn = x.ins.fn;
        const args = asList(x.ins.args).filter((y) => y !== undefined);
        if (fn !== null && fn !== undefined && fn.op === 'ref') calls.push([fn.attrs.name, args]);
        for (const y of args) scan(y);
        return;
      }
      for (const k of Object.keys(x.ins ?? {})) scan(x.ins[k]);
    };
    scan(b.list);
    const cands = new Set();
    for (const [n, c] of count) {
      const init = inits.get(n);
      if (c === 1 && init !== null && init !== undefined && init.op !== 'func') cands.add(n);
    }
    /* 「体的最后一格是 `ret`」——那说明**走不到掉出去那一条路**（掉出去回的是 nil）。 */
    const last = b.list.length > 0 ? b.list[b.list.length - 1] : null;
    const tailIsRet = last !== null && last !== undefined && last.op === 'ret';
    info.set(b.key, {
      inits, writes, calls, cands, params: b.params, retVals, tailIsRet,
    });
  }

  const params = new Set();
  for (const [n, f] of namedFn) {
    if (f.params.length > 0 && !badFnRef.has(n)) params.add(n);
  }
  /**
   * **返回值也窄**的候选：有名字的顶层函数，而且
   *   - 体的最后一格是 `ret`（掉出去那条路走不到 —— 掉出去回的是 nil，那可不是数）；
   *   - 体里每一格 `ret` 都带值，而且那个值**是数**。
   * 名字被当值用过的照样出局（调用点数不齐）。
   */
  const rets = new Set();
  for (const [n, f] of namedFn) {
    const inf = info.get(f.key);
    if (inf !== undefined && inf.tailIsRet && inf.retVals.length > 0 && !badFnRef.has(n)) rets.add(n);
  }
  const numish = (x, key) => {
    if (x === null || x === undefined || Array.isArray(x)) return false;
    if (constNum(x) !== null) return true;
    if (x.op === 'ref') {
      const inf = info.get(key);
      if (inf === undefined) return false;
      if (inf.cands.has(x.attrs.name)) return true;
      const fname = nameOfBody.get(key);
      return fname !== undefined && params.has(fname) && inf.params.includes(x.attrs.name);
    }
    /* 一次调用**算数**，前提是那个函数的返回值窄了（不然回的可能是 nil）。 */
    if (x.op === 'call') {
      const fn = x.ins.fn;
      return fn !== null && fn !== undefined && fn.op === 'ref' && rets.has(fn.attrs.name);
    }
    if (x.op === 'conv') return x.attrs.to === 'int' || x.attrs.to === 'float';
    if (x.op !== 'prim') return false;
    if (x.attrs.name === 'len') return true;
    if (!NUM_PRIMS.includes(x.attrs.name)) return false;
    const args = asList(x.ins.args).filter((y) => y !== undefined);
    return args.length > 0 && args.every((y) => numish(y, key));
  };
  for (let round = 0; round < bodies.length + params.size + rets.size + 8; round++) {
    let dropped = false;
    for (const [key, inf] of info) {
      for (const n of [...inf.cands]) {
        const ok = numish(inf.inits.get(n), key)
          && inf.writes.every(([w, v]) => w !== n || numish(v, key));
        if (!ok) { inf.cands.delete(n); dropped = true; }
      }
    }
    for (const fname of [...params]) {
      const f = namedFn.get(fname);
      let ok = true;
      for (const [key, inf] of info) {
        for (const [callee, args] of inf.calls) {
          if (callee !== fname) continue;
          if (args.length !== f.params.length || !args.every((y) => numish(y, key))) ok = false;
        }
      }
      if (!ok) { params.delete(fname); dropped = true; }
    }
    for (const fname of [...rets]) {
      const f = namedFn.get(fname);
      const inf = info.get(f.key);
      const ok = inf.retVals.every((v) => v !== null && numish(v, f.key));
      if (!ok) { rets.delete(fname); dropped = true; }
    }
    if (!dropped) break;
  }
  const locals = new Map();
  for (const [key, inf] of info) locals.set(key, inf.cands);
  return {
    locals, params, rets, nameOfBody,
  };
}

/**
 * **形状推断落到 C**（`docs/design/node-graph-shrink.md` 第五节第 2 条）：字段名编译期就
 * 知道的记录，落成 C 的 `struct`，而不是「堆上一块 + 按名字线性找键」。
 *
 * 哪一格记录动得了，三个条件（**都能在图上问出来**，一格新声明都不加）：
 *   1. 一格 `bind` 的初值就是 `record-new`，字段名是那一格的附属（编译期已知）；
 *   2. 那格 `record-new` 在整张图里**只被这一处用**（共享出去了就说不清谁的存储）；
 *   3. 这个名字的每一次 `ref`，都长在 `field-get` / `field-set` 的 `obj` 槽上，
 *      而且字段在那张名单里 —— **一处跑出去（当实参、进列表、被 print、被 return）就不动**。
 *      理由：跑出去之后那一格要是 `gv`（宿主面只认 `gv`），而 struct 不是 `gv`。
 *
 * 回的是「体的 key -> (名字 -> 形状)」。形状按**字段名单**去重，于是两格同形的记录共用
 * 一格 `struct`（`r1` / `r2` … 的编号是登记顺序，所以同一张图两次出来逐字节相同）。
 */
function recPlan(top) {
  /* ---- 一趟：数每格节点被用了几次（**不去重** —— 共享要认得出来），并收集体。 */
  const uses = new Map();
  const bodies = [];
  const walk = (x, depth) => {
    if (x === null || x === undefined || depth > 400) return;
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
    if (x.op === undefined) return;
    uses.set(x.id, (uses.get(x.id) ?? 0) + 1);
    if (uses.get(x.id) > 1) return;                 /* 已经走过一遍，只把次数记上 */
    if (x.op === 'func') bodies.push({ key: x.id, list: asList(x.ins.body) });
    for (const k of Object.keys(x.ins ?? {})) walk(x.ins[k], depth + 1);
  };
  walk(top, 0);
  bodies.push({ key: 'top', list: asList(top) });

  const shapes = new Map();                          /* 字段名单 -> struct 名 */
  const out = new Map();
  for (const b of bodies) {
    const cands = new Map();                         /* 名字 -> record-new 节点 */
    const bad = new Set();
    const seen = new Set();
    const scan = (x, slot) => {
      if (x === null || x === undefined) return;
      if (Array.isArray(x)) { for (const y of x) scan(y, null); return; }
      if (x.op === undefined) return;
      if (x.op === 'ref') {
        /* 条件 3：只认这两个槽，别的地方一出现就作废。 */
        if (slot !== 'field-obj') bad.add(x.attrs.name);
        return;
      }
      if (seen.has(x.id)) return;
      seen.add(x.id);
      if (x.op === 'func') return;
      if (x.op === 'bind') {
        const init = x.ins.init;
        if (init !== null && init !== undefined && init.op === 'record-new'
          && Array.isArray(init.attrs.names) && init.attrs.names.length > 0
          && uses.get(init.id) === 1 && !cands.has(x.attrs.name)) {
          cands.set(x.attrs.name, init);
        } else bad.add(x.attrs.name);
        scan(init, null);
        return;
      }
      if (x.op === 'set') { bad.add(x.attrs.name); scan(x.ins.value, null); return; }
      if (x.op === 'field-get' || x.op === 'field-set') {
        scan(x.ins.obj, 'field-obj');
        if (x.op === 'field-set') scan(x.ins.value, null);
        return;
      }
      for (const k of Object.keys(x.ins ?? {})) scan(x.ins[k], null);
    };
    scan(b.list, null);
    /* 字段名对不上名单的也作废（`p.z` 那种 —— 报错归运行期，别在这儿改语义）。 */
    const chk = (x) => {
      if (x === null || x === undefined) return;
      if (Array.isArray(x)) { for (const y of x) chk(y); return; }
      if (x.op === undefined) return;
      if (x.op === 'func') return;
      if ((x.op === 'field-get' || x.op === 'field-set')
        && x.ins.obj !== null && x.ins.obj !== undefined && x.ins.obj.op === 'ref') {
        const n = x.ins.obj.attrs.name;
        const c = cands.get(n);
        if (c !== undefined && !c.attrs.names.includes(x.attrs.field)) bad.add(n);
      }
      for (const k of Object.keys(x.ins ?? {})) chk(x.ins[k]);
    };
    chk(b.list);
    for (const n of bad) cands.delete(n);
    const got = new Map();
    for (const [n, rec] of cands) {
      const key = rec.attrs.names.join('|');
      if (!shapes.has(key)) shapes.set(key, `r${shapes.size + 1}`);
      got.set(n, { names: rec.attrs.names, tag: shapes.get(key) });
    }
    if (got.size > 0) out.set(b.key, got);
  }
  return { locals: out, shapes };
}

/**
 * 一格 C 的 double 字面量。**要能一位不差地读回来**：整数写 `3.0`，别的写 17 位有效数字
 * （IEEE 754 双精度的往返位数）。无穷与 NaN 用 `1.0/0.0` 这一族写 —— C 里没有它们的
 * 字面量，而 `<math.h>` 的 `INFINITY` 要 `#include`（这份产物一个头都不 include）。
 */
function cNum(v) {
  if (Number.isNaN(v)) return '(0.0 / 0.0)';
  if (v === Infinity) return '(1.0 / 0.0)';
  if (v === -Infinity) return '(-1.0 / 0.0)';
  if (Number.isInteger(v) && Math.abs(v) < 9.0e18) return `${v}.0`;
  const s = v.toPrecision(17);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

/**
 * 图 -> C。**一格值一格临时量**：控制流落到值位置上时（`branch` / `region` 有出端口），
 * C 里没有语句表达式可用（那是 GCC 扩展，见 `PRELUDE` 第 2 条纪律），所以一律
 * 「先声明一格 `gv`、在块里赋值、再用它」。多出来的临时量交给编译器，不是问题。
 */
class CGen {
  constructor() {
    this.lines = [];
    this.n = 0;
    this.depth = 1;
    /** 提到顶层的那些函数：`{ cname, params, lines }`。 */
    this.fns = [];
    /** 图上的名字 -> 顶层 C 函数名。 */
    this.fnOf = new Map();
    /** 顶层的 `bind`（不是函数的那些）名字集合——它们在 C 里是模块级 `static gv`，
        函数提升时不算捕获（任何函数都看得见）。 */
    this.topBinds = new Set();
    /** 那里头**真被某个顶层函数体读到**的那几格 —— 只有它们要落成模块级 static
        （别的照旧当 `main` 的局部量，产物一个字节不动）。 */
    this.hoisted = new Set();
    /** 现在落的是顶层那一块吗（`hoisted` 那几格的声明与赋值要分开只在这一层）。 */
    this.atTop = false;
    /** 正在生成的是**函数体**吗（`ret` 要回值，而 `main` 里 `ret` 回退出码 0）。 */
    this.inFn = 0;
    /** 文件级的那几行（记录的键那种编译期常量数组）。 */
    this.decls = [];
    /**
     * 区域栈：`{ kind: 'region'|'loop'|'fn', exits, cond }`。`exits` 是那一层
     * **静态就看得见**的 scope-exit 动作（见 `stmt` 里那一格）。
     */
    this.frames = [];
    /** 现在嵌在几层条件/循环里 —— scope-exit 只认「区域自己那一层」注册的。 */
    this.cond = 0;
    /**
     * 这一个函数体里**窄成 `double` 的那几格名字**（`numLocals` 算的）。
     * 一进一出一格函数体就换一张（见 `liftFunc` 与 `emitC`）—— 名字是按体算的。
     */
    this.num = new Set();
    /** 窄化那张全局的计划（`numPlan`）：哪个体窄了哪几格、哪个函数的形参 / 返回值窄了。 */
    this.np = {
      locals: new Map(), params: new Set(), rets: new Set(), nameOfBody: new Map(),
    };
    /** 正在生成的这个函数**回 double** 吗（`ret` 与那格尾巴临时量要跟着换）。 */
    this.rnum = false;
    /** 这个体里落成 C `struct` 的那几格记录（`recPlan` 算的：名字 -> { names, tag }）。 */
    this.rec = new Map();
    /** 记录那张全局的计划。 */
    this.rp = { locals: new Map(), shapes: new Map() };
  }

  /**
   * 一格节点的**不装箱的 double 形态**，没有就回 `null`。
   *
   * 这是窄化那一半的落点：`ref` 一格窄了的名字直接是那个 C 变量，常量直接是字面量，
   * 算术是把两边的 double 形态拼起来。拼不出来的（调用、字段、串…）回 `null`，
   * 调用方再退回 `g_d(<装箱的那份>)`。
   *
   * **只拼 `+ - * /`**：`^` 那格有一条「指数不是整数就报缺口」的规矩（见 `prim`），
   * 从这儿绕过去就把那条规矩丢了；`%` 与 `len` 交给退路，多一趟 `g_d` 不值得再抄一遍语义。
   * 这里也**不发语句** —— 认得的这几样都是纯表达式，所以不会漏掉谁的副作用。
   */
  dOf(x) {
    if (x === null || x === undefined || Array.isArray(x)) return null;
    const k = constNum(x);
    if (k !== null) return cNum(k);
    if (x.op === 'ref' && this.num.has(x.attrs.name)) return cName(x.attrs.name);
    /* 一次调用：那个函数**回 double** 而且实参也都拼得出 double 形态时，就是一段裸调用。
     * 「实参也拼得出来」这条不只是省事 —— `dOf` **一行语句都不许发**（它会被试着调、
     * 结果被丢掉），而 `valOf` 是会发语句的（列表、print 那种）。 */
    if (x.op === 'call') {
      const fn = x.ins.fn;
      if (fn === null || fn === undefined || fn.op !== 'ref') return null;
      const nm2 = fn.attrs.name;
      if (!this.np.rets.has(nm2) || !this.fnOf.has(nm2)) return null;
      const as = asList(x.ins.args).filter((y) => y !== undefined).map((y) => this.dOf(y));
      if (as.some((d) => d === null)) return null;
      if (!this.np.params.has(nm2) && as.length > 0) return null;   /* 那边收 gv，递不进去 */
      return `${this.fnOf.get(nm2)}(${as.join(', ')})`;
    }
    if (x.op !== 'prim') return null;
    const nm = x.attrs.name;
    if (nm !== '+' && nm !== '-' && nm !== '*' && nm !== '/') return null;
    const args = asList(x.ins.args).filter((y) => y !== undefined).map((y) => this.dOf(y));
    if (args.length === 0 || args.some((d) => d === null)) return null;
    if (nm === '-' && args.length === 1) return `(-${args[0]})`;
    return args.reduce((a, b) => `(${a} ${nm} ${b})`);
  }

  /** 一格节点的 double 形态，拼不出来就退回「装箱的那份再拆一次」。 */
  dVal(x) {
    return this.dOf(x) ?? `g_d(${this.valOf(x)})`;
  }

  /**
   * 一格**条件**的 C 形态（int 值），拼不出来回 `null`。
   *
   * 为什么值得单列一格：`while i <= n` 现在落成
   * `if (g_truthy(g_bool(g_cmp(g_num(v_i), v_n) <= 0)) == 0) break;` ——
   * 一趟装箱（`g_num`）、一趟比较、一趟再装箱（`g_bool`）、一趟拆箱（`g_truthy`），
   * 而两边都是数的时候这四趟就是 `v_i <= v_n` 一条指令。
   *
   * 每一条都对着序言里那格函数**逐句**看过（这份不许"看起来一样"）：
   *   `<` 一族  `g_cmp` 在两边都不是串时算的就是 `x < y`（见 `g_cmp`）
   *   `=` 一族  `g_eq` 在同型且是数时算的就是 `g_d(a) == g_d(b)`（见 `g_eq`）
   *   `not`     `g_truthy` 的反面
   *   常量      真值观**只有 false / nil 是假**（`g_truthy`）—— 所以 `0` 也真
   */
  condOf(x) {
    if (x === null || x === undefined || Array.isArray(x)) return null;
    if (x.lit !== undefined || (x.op === 'const' && x.attrs.value !== undefined)) {
      const v = x.lit !== undefined ? x.lit : x.attrs.value;
      if (v === false || v === null) return '0';
      return '1';
    }
    if (x.op !== 'prim') return null;
    const nm = x.attrs.name;
    const args = asList(x.ins.args).filter((y) => y !== undefined);
    if (nm === 'not' && args.length === 1) {
      const c = this.condOf(args[0]);
      return c === null ? null : `(!(${c}))`;
    }
    const REL = { '<': '<', '>': '>', '<=': '<=', '>=': '>=', '=': '==', '!=': '!=' };
    if (REL[nm] === undefined || args.length !== 2) return null;
    const a = this.dOf(args[0]);
    const b = this.dOf(args[1]);
    return a === null || b === null ? null : `(${a} ${REL[nm]} ${b})`;
  }

  /** 条件位置：拼得出 C 的条件就用它，拼不出来才走 `g_truthy(<装箱的那份>)`。 */
  cCond(x) {
    return this.condOf(x) ?? `g_truthy(${this.valOf(x)})`;
  }

  /** 开一层区域。 */
  pushFrame(kind) { this.frames.push({ kind, exits: [], cond: this.cond }); }

  /**
   * 关一层区域：把这一层注册的动作**逆序**跑一遍（与 `eval.js` 的 `runExits`、
   * js 后端的 `finally` 同一条口径）。
   */
  popFrame() {
    const f = this.frames.pop();
    for (let i = f.exits.length - 1; i >= 0; i--) this.stmt(f.exits[i]);
  }

  /**
   * 早退（`ret` / `break` / `continue`）要**先把路上每一层的动作跑掉**：C 里没有
   * finally，所以这几条动作在每个出口各发一份。`stop` 是走到哪一层为止 ——
   * `ret` 走到函数边界（`fn`），`break`/`continue` 走到最近的那圈循环。
   */
  emitExits(stop) {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      for (let k = f.exits.length - 1; k >= 0; k--) this.stmt(f.exits[k]);
      /* **先跑这一层再停**：`ret` 要连函数自己那一层的动作一起跑掉（那一层正是
       * 「函数体」这个区域）。先停后跑漏的就是它 —— 量出来的症状是四门语言的
       * defer 例子印出 `in / out`，中间那两行没了。 */
      if (f.kind === stop) break;
    }
  }

  /** 路上（走到 `stop` 那一层为止）有没有出口动作要跑 —— 没有的话早退不必先落一格临时量。 */
  hasExits(stop) {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      if (f.exits.length > 0) return true;
      if (f.kind === stop) break;
    }
    return false;
  }

  emit(s) { this.lines.push(`${'  '.repeat(this.depth)}${s}`); }

  fresh() { this.n += 1; return `t${this.n}`; }

  /** 这格节点这一刀接不接得住 —— 接不住当场报缺口（有名有姓，不是静默的错答案）。 */
  chk(op) {
    if (!OPS.has(op)) throw new Gap(`c 后端还没接这格节点：${op}`);
  }

  /**
   * **先给顶层那些函数派好 C 名字**，再生成任何一行 —— 这样「A 调后面定义的 B」不会
   * 被当成捕获（`freeRefs` 数出来的名字里，已经是顶层函数的那些不算）。
   */
  plan(list) {
    for (const x of list) {
      if (x !== null && x !== undefined && x.op === 'bind') {
        if (x.ins.init !== undefined && x.ins.init !== null && x.ins.init.op === 'func') {
          this.n += 1;
          this.fnOf.set(x.attrs.name, `fn${this.n}_${cName(x.attrs.name).slice(2)}`);
        } else {
          /* 顶层的非函数 bind —— 登记进 `topBinds`（提升时不算捕获）。 */
          this.topBinds.add(x.attrs.name);
        }
      }
    }
    /* **哪几格顶层变量真被函数体读到** —— 只有那几格要落成模块级 `static`。
       C 里 `main` 的局部量别的函数看不见，而图上顶层 `bind` 与函数体里的 `bind` 是**同一格
       节点**（落法分两种只因为 C 的作用域分两层，与 wat 那侧 `(global …)` 同一条）。 */
    for (const x of list) {
      if (x === null || x === undefined || x.op !== 'bind') continue;
      if (x.ins.init === undefined || x.ins.init === null || x.ins.init.op !== 'func') continue;
      const free = [];
      freeRefs(x.ins.init.ins.body, (x.ins.init.attrs.params ?? []).slice(), free);
      for (const n of free) if (this.topBinds.has(n)) this.hoisted.add(n);
    }
  }

  /**
   * 把一格 `func` 提到顶层：出一个 `static gv fnN(gv p1, …)`，回它的 C 名字。
   *
   * **捕获当场报缺口**（`freeRefs`）：函数提上去之后 C 那侧看得见的只有形参与别的顶层
   * 函数，读一格外层的局部量在 C 里没有落处（要一格环境对象 + 一格间接调用）。
   * `wat` 那侧第一条形状账记的是同一件事 —— 两条腿欠的是同一格能力。
   */
  liftFunc(x, name) {
    let cname = name === undefined ? undefined : this.fnOf.get(name);
    if (cname === undefined) {
      this.n += 1;
      cname = `fn${this.n}_${name === undefined ? 'anon' : cName(name).slice(2)}`;
      if (name !== undefined) this.fnOf.set(name, cname);
    }
    const params = x.attrs.params ?? [];
    /* 形参窄不窄是**按函数名**定的（`numPlan` 里那半个不动点）：窄了就连形参一起进
     * `this.num`，于是体里读它是那个 double、当值用时才 `g_num` 装回去。 */
    const pnum = this.np.params.has(this.np.nameOfBody.get(x.id));
    /* 返回值窄不窄（`numPlan` 的第三格）：体的最后一格是 `ret`、每格 `ret` 都回数。 */
    const rnum = this.np.rets.has(this.np.nameOfBody.get(x.id));
    const free = [];
    freeRefs(x.ins.body, params.slice(), free);
    /* 不算捕获的那些：**顶层函数**（已经在 `fnOf` 里了）**和顶层的 `bind`**（它们在 C 里
       是**模块级 static 变量**——不在这格函数的形参里、可在全局名字空间看得见）。
       `go+vardecl` 的 `var start = 10; func firstOf[T any](xs []T) T { return xs[0] }`
       就是这个形状：`start` 不是 `firstOf` 的形参，而是模块级变量，C 那边 `static gv g_start;`
       任何函数都看得见。`freeRefs` 把它数成了自由名字（因为它不在形参列表里），
       可它不是捕获 —— 不需要环境对象。 */
    const cap = free.filter((n) => !this.fnOf.has(n) && !this.topBinds.has(n));
    if (cap.length > 0) {
      throw new Gap(`c 后端：这格 func 捕获了外层的名字（${cap.join('、')}）—— 真闭包要一格环境对象`);
    }
    const outer = this.lines;
    const outerDepth = this.depth;
    const outerNum = this.num;
    this.lines = [];
    this.depth = 1;
    this.inFn += 1;
    /* 窄化是**按函数体**算的（`numPlan` 一趟算齐，这儿只取那一份）。 */
    this.num = new Set(this.np.locals.get(x.id) ?? []);
    if (pnum) for (const p of params) this.num.add(p);
    const outerRec = this.rec;
    this.rec = this.rp.locals.get(x.id) ?? new Map();
    const outerRnum = this.rnum;
    this.rnum = rnum;
    const t = this.fresh();
    /* 尾巴那格临时量：回 double 而且体的最后一格就是 `ret` 时，它是**走不到的一条路** ——
     * 那就别发那一格声明了，末尾直接 `return 0.0;`（C 要有个返回值可回，仅此而已）。 */
    const lastNode = asList(x.ins.body).length > 0
      ? asList(x.ins.body)[asList(x.ins.body).length - 1] : null;
    const tailRet = lastNode !== null && lastNode !== undefined && lastNode.op === 'ret';
    const dead = rnum && tailRet;
    if (!dead) this.emit(rnum ? `double ${t} = 0.0;` : `gv ${t} = g_nil();`);
    this.pushFrame('fn');
    this.body(asList(x.ins.body), dead ? null : t);
    this.popFrame();
    this.emit(dead ? 'return 0.0;' : `return ${t};`);
    this.inFn -= 1;
    const lines = this.lines;
    this.lines = outer;
    this.depth = outerDepth;
    this.num = outerNum;
    this.rec = outerRec;
    this.rnum = outerRnum;
    this.fns.push({
      cname, params: params.map(cName), pnum, rnum, lines,
    });
    return cname;
  }

  /** 一格调用。名字指向顶层函数、或者当场摆着一格 `func` —— 别的（按值调用）报缺口。 */
  callOf(x) {
    const raw = asList(x.ins.args).filter((y) => y !== undefined);
    const fn = x.ins.fn;
    if (fn !== undefined && fn !== null && fn.op === 'ref' && this.fnOf.has(fn.attrs.name)) {
      /* 形参窄了的那几个函数：**递 double**（`numPlan` 已经证过每个调用点都是数）。 */
      const num = this.np.params.has(fn.attrs.name);
      const as = raw.map((y) => (num ? this.dVal(y) : this.valOf(y)));
      return `${this.fnOf.get(fn.attrs.name)}(${as.join(', ')})`;
    }
    const args = raw.map((y) => this.valOf(y));
    if (fn !== undefined && fn !== null && fn.op === 'func') {
      return `${this.liftFunc(fn, undefined)}(${args.join(', ')})`;
    }
    throw new Gap('c 后端：按值调用（函数从一格变量里来）还没接 —— 要一格函数指针表');
  }

  lit(v) {
    if (v === null || v === undefined) return 'g_nil()';
    if (typeof v === 'boolean') return `g_bool(${v ? 1 : 0})`;
    if (typeof v === 'number') return `g_num(${cNum(v)})`;
    if (typeof v === 'string') return `g_str(${cStr(v)})`;
    throw new Gap(`c 后端还没接这种常量：${typeof v}`);
  }

  /**
   * 这一格的**值位置**落成 C 时会不会先发几行语句？
   *
   * 为什么要问：`branch` 落在值位置上现在是「先声明一格临时量、两个分支各赋一次」五行。
   * 两边都发不出语句时，那五行就是一格三目（`c ? a : b`）—— 而**只要有一边要先发语句，
   * 三目就不能用**：那几行会**无条件**先跑，而分支的规矩是只跑一边。
   * 所以这儿是一张**白名单**（认得的才算发不出语句），宁可少收一格，不许算错。
   */
  noEmit(x) {
    if (x === null || x === undefined) return true;
    if (Array.isArray(x)) return false;
    if (x.lit !== undefined) return true;
    const op = x.op;
    if (op === 'const' || op === 'ref') return true;
    if (op === 'field-get' || op === 'conv' || op === 'pick') {
      return this.noEmit(x.ins.obj ?? x.ins.value ?? x.ins.from);
    }
    if (op === 'index-get' || op === 'map-get' || op === 'map-has') {
      return this.noEmit(x.ins.obj) && this.noEmit(x.ins.index ?? x.ins.key);
    }
    if (op === 'slice') {
      return this.noEmit(x.ins.obj) && this.noEmit(x.ins.from) && this.noEmit(x.ins.to);
    }
    const argsOk = () => asList(x.ins.args ?? []).filter((y) => y !== undefined)
      .every((y) => this.noEmit(y));
    /* `print` 是要发语句的那一格（缓冲 + 调）—— 内建里就它与它一族的例外。 */
    if (op === 'prim') return x.attrs.name !== 'print' && argsOk();
    if (op === 'call') return argsOk();
    return false;                     /* branch / region / loop / list-new / record-new … */
  }

  /** 值位置。回一段 C 表达式（要发语句的先发，再回那格临时量的名字）。 */
  valOf(x) {
    if (x === null || x === undefined) return 'g_nil()';
    if (Array.isArray(x)) {
      /* **值位置上摆着一串节点**：前面几格是语句、**末尾那格是值**。
         那条规矩不是这儿新编的 —— `fnBody` 的"掉到函数尾也是一条出口"、core 的 `arm`
         （表达式位置上的 branch 两支各赋值）说的都是同一句话。图上会长出这个形状是因为
         `branch` 的 `then`/`else` 是 `lazy` 端口：那两格里躺的可能是一串语句
         （nim / mojo / freebasic 的 `if` 当值用就是）。
         空的一串没有值 —— `g_nil()`。末尾那格要真是一句话（`print` 那种），
         后面 `valOf` 自己会报一格有名有姓的缺口。 */
      const list = x.filter((y) => y !== undefined && y !== null);
      if (list.length === 0) return 'g_nil()';
      const last = list[list.length - 1];
      /* **末尾那格是 `ret`**：这一支根本不交值出来 —— 它从整个函数里走了
         （nim / mojo 的 `if c: return a else: return b` 当值用就是这个形状）。
         所以整串都当语句发，回一格 `g_nil()` 占位 —— 那一格赋值**到不了**。 */
      if (last !== null && last.op === 'ret') {
        for (const y of list) this.stmt(y);
        return 'g_nil()';
      }
      for (const y of list.slice(0, -1)) this.stmt(y);
      return this.valOf(last);
    }
    if (x.lit !== undefined) return this.lit(x.lit);
    this.chk(x.op);
    if (x.op === 'const') return this.lit(x.attrs.value ?? null);
    /* 窄成 `double` 的那几格：值位置上要**装回去**（这一格就是窄化的全部代价）。 */
    if (x.op === 'ref') {
      return this.num.has(x.attrs.name) ? `g_num(${cName(x.attrs.name)})` : cName(x.attrs.name);
    }
    if (x.op === 'prim') return this.prim(x);
    if (x.op === 'call') {
      /* 回 double 的那几个函数：这儿是**值位置**，所以装回去（与窄了的名字同一条规矩）。 */
      const fn = x.ins.fn;
      const t = this.callOf(x);
      if (fn !== null && fn !== undefined && fn.op === 'ref' && this.np.rets.has(fn.attrs.name)
        && this.fnOf.has(fn.attrs.name)) {
        return `g_num(${t})`;
      }
      return t;
    }
    if (x.op === 'list-new') {
      const items = asList(x.ins.items).filter((y) => y !== undefined).map((y) => this.valOf(y));
      const a = `a${this.fresh()}`;
      this.emit(`gv ${a}[${items.length > 0 ? items.length : 1}];`);
      for (let i = 0; i < items.length; i++) this.emit(`${a}[${i}] = ${items[i]};`);
      return `g_list_new(${a}, ${items.length})`;
    }
    if (x.op === 'index-get') {
      return `g_index_get(${this.valOf(x.ins.obj)}, ${this.valOf(x.ins.index)})`;
    }
    if (x.op === 'record-new') {
      const names = x.attrs.names ?? [];
      const vals = asList(x.ins.fields).filter((y) => y !== undefined).map((y) => this.valOf(y));
      /* 键是编译期就知道的常量 -> 一格文件级的静态数组（记录一多，这样比每次都造省）。 */
      const kn = `gk${this.fresh()}`;
      this.decls.push(`static const char *${kn}[${names.length > 0 ? names.length : 1}] = { ${names.length > 0 ? names.map(cStr).join(', ') : '0'} };`);
      const a = `a${this.fresh()}`;
      this.emit(`gv ${a}[${vals.length > 0 ? vals.length : 1}];`);
      for (let i = 0; i < vals.length; i++) this.emit(`${a}[${i}] = ${vals[i]};`);
      return `g_rec_new(${kn}, ${a}, ${names.length})`;
    }
    if (x.op === 'field-get') {
      /* 落成 struct 的那几格记录：字段就是**一格偏移**，不是按名字线性找键。 */
      const o = x.ins.obj;
      if (o !== null && o !== undefined && o.op === 'ref' && this.rec.has(o.attrs.name)) {
        return `${cName(o.attrs.name)}.${cField(x.attrs.field)}`;
      }
      return `g_field_get(${this.valOf(x.ins.obj)}, ${cStr(x.attrs.field)})`;
    }
    if (x.op === 'map-new') {
      const ks = asList(x.ins.keys).filter((y) => y !== undefined).map((y) => this.valOf(y));
      const vs = asList(x.ins.vals).filter((y) => y !== undefined).map((y) => this.valOf(y));
      const n = ks.length;
      const ka = `mk${this.fresh()}`;
      const va = `mv${this.fresh()}`;
      this.emit(`gv ${ka}[${n > 0 ? n : 1}];`);
      this.emit(`gv ${va}[${n > 0 ? n : 1}];`);
      for (let i = 0; i < n; i++) this.emit(`${ka}[${i}] = ${ks[i]};`);
      for (let i = 0; i < n; i++) this.emit(`${va}[${i}] = ${vs[i]};`);
      return `g_map_new(${ka}, ${va}, ${n})`;
    }
    if (x.op === 'map-get') return `g_map_get(${this.valOf(x.ins.obj)}, ${this.valOf(x.ins.key)})`;
    if (x.op === 'map-has') return `g_map_has(${this.valOf(x.ins.obj)}, ${this.valOf(x.ins.key)})`;
    if (x.op === 'values') {
      const items = asList(x.ins.args).filter((y) => y !== undefined).map((y) => this.valOf(y));
      const a = `w${this.fresh()}`;
      this.emit(`gv ${a}[${items.length > 0 ? items.length : 1}];`);
      for (let i = 0; i < items.length; i++) this.emit(`${a}[${i}] = ${items[i]};`);
      return `g_vals_new(${a}, ${items.length})`;
    }
    if (x.op === 'pick') return `g_pick(${this.valOf(x.ins.from)}, ${Number(x.attrs.index ?? 0)})`;
    if (x.op === 'conv') {
      const v = this.valOf(x.ins.value);
      const to = x.attrs.to;
      if (to === 'int') return `g_conv_int(${v})`;
      if (to === 'float') return `g_num(g_tonum(${v}))`;
      if (to === 'str') return `g_str(g_show(${v}))`;
      if (to === 'bool') return `g_bool(g_truthy(${v}))`;
      throw new Gap(`c 后端：conv 还没接这个目标：${to}`);
    }
    if (x.op === 'slice') {
      const o = this.valOf(x.ins.obj);
      const a = x.ins.from === undefined ? 'g_nil()' : this.valOf(x.ins.from);
      const b = x.ins.to === undefined ? 'g_nil()' : this.valOf(x.ins.to);
      return `g_slice(${o}, ${a}, ${b})`;
    }
    if (x.op === 'func') {
      throw new Gap('c 后端：`func` 当值用（不是当场调用、也不是绑给一个名字）还没接');
    }
    if (x.op === 'branch') {
      /* 两边都发不出语句 -> 一格三目（省下「声明 + 两次赋值」那五行）。 */
      if (this.noEmit(x.ins.then) && this.noEmit(x.ins.else)) {
        const a = this.valOf(x.ins.then);
        const b = x.ins.else === undefined ? 'g_nil()' : this.valOf(x.ins.else);
        return `(${this.cCond(x.ins.cond)} ? ${a} : ${b})`;
      }
      const t = this.fresh();
      this.emit(`gv ${t};`);
      this.emit(`if (${this.cCond(x.ins.cond)}) {`);
      this.depth += 1;
      this.cond += 1;
      this.emit(`${t} = ${this.valOf(x.ins.then)};`);
      this.cond -= 1;
      this.depth -= 1;
      this.emit('} else {');
      this.depth += 1;
      this.cond += 1;
      this.emit(`${t} = ${x.ins.else === undefined ? 'g_nil()' : this.valOf(x.ins.else)};`);
      this.cond -= 1;
      this.depth -= 1;
      this.emit('}');
      return t;
    }
    if (x.op === 'region') {
      const t = this.fresh();
      this.emit(`gv ${t} = g_nil();`);
      this.emit('{');
      this.depth += 1;
      this.pushFrame('region');
      this.body(asList(x.ins.body), t);
      this.popFrame();
      this.depth -= 1;
      this.emit('}');
      return t;
    }
    throw new Gap(`c 后端：${x.op} 落不到值位置上`);
  }

  /**
   * 一格内建。`+` 掺串就串接（走 `g_add`），别的算术一律按 double。
   * `print` 是这里唯一**发语句**的一格：先把各格摆进一小块数组，再交给 `g_print`
   * （C 里没有 JS 那种 `[...].map(show).join(' ')`，而变参函数在这一层不必要）。
   */
  prim(x) {
    const name = x.attrs.name;
    if (!C_PRIMS.has(name)) throw new Gap(`c 后端还没接这格内建：${name}`);
    const p = PRIMS.get(name);
    const raw = asList(x.ins.args).filter((y) => y !== undefined);
    /* `^` 的指数不是整数就当场报缺口（`C_SHAPES` 第一条的证物走这儿）：libc 那张桥里
     * 没有 `pow`，而「乘上去」只对整数次幂成立。看得见是常量就当场说，不等到运行期。 */
    if (name === '^' && raw.length === 2) {
      const e = constNum(raw[1]);
      if (e !== null && !Number.isInteger(e)) {
        throw new Gap(`c 后端：\`^\` 的指数是 ${e}（不是整数）—— libc 那张桥里没有 pow`);
      }
    }
    const args = raw.map((y) => this.valOf(y));
    if (p.arity >= 0 && args.length !== p.arity) {
      throw new Gap(`内建 ${name} 收 ${p.arity} 格实参，这张图给了 ${args.length}`);
    }
    /**
     * **别装了又拆**（`docs/design/node-graph-shrink.md` 第二节那一行「最扎眼的」账）：
     * 算术这几格本来就按数算（下面每一处都套着 `g_d`），所以实参是编译期就知道的数时
     * 直接发那个 double —— `g_d(g_num(1.0))` 变回 `1.0`。
     *
     * 等价性是显然的一句话：`g_d(g_num(k)) == k`（那两格就是 memcpy 的一来一回，
     * 见这份序言里的 `g_num` / `g_d`）。所以这一格不动语义，只少一趟往返。
     * 只管**常量**：变量那一侧要少这趟往返得先把局部量窄成 `double`，那是另一刀。
     */
    const dArg = (i) => this.dOf(raw[i]) ?? `g_d(${args[i]})`;
    const num2 = (op) => args.map((_, i) => dArg(i)).reduce((a, b) => `g_num(${a} ${op} ${b})`);
    const rel = (op) => `g_bool(g_cmp(${args[0]}, ${args[1]}) ${op})`;
    if (name === '+') return args.length === 0 ? 'g_num(0.0)' : args.reduce((a, b) => `g_add(${a}, ${b})`);
    if (name === '-') return args.length === 1 ? `g_num(-${dArg(0)})` : num2('-');
    if (name === '*') return args.length === 0 ? 'g_num(1.0)' : num2('*');
    if (name === '/') return num2('/');
    if (name === '%') return `g_num(g_fmod(${dArg(0)}, ${dArg(1)}))`;
    if (name === '^') return `g_num(g_pow(${dArg(0)}, ${dArg(1)}))`;
    if (name === '<') return rel('< 0');
    if (name === '>') return rel('> 0');
    if (name === '<=') return rel('<= 0');
    if (name === '>=') return rel('>= 0');
    if (name === '=') return `g_bool(g_eq(${args[0]}, ${args[1]}))`;
    if (name === '!=') return `g_bool(g_eq(${args[0]}, ${args[1]}) == 0)`;
    if (name === 'not') return `g_bool(g_truthy(${args[0]}) == 0)`;
    if (name === 'len') return `g_len(${args[0]})`;
    if (name === 'push') return `g_push(${args[0]}, ${args[1]})`;
    if (name === 'contains') return `g_contains(${args[0]}, ${args[1]})`;
    if (name === 'fill') return `g_fill(${args[0]}, ${args[1]})`;
    /* 位运算那六格：**值先取成 double 再折成 long long**（这一层的值是 `gv`，
       数那一格里装的是 double —— 与别的算术走同一条路），算完再包回 `g_num`。
       头一版直接把 `gv` 当 long long 转，C 那侧当场报"cannot convert 'struct gv'"。 */
    const iArg = (i) => `(long long)(${dArg(i)})`;
    if (name === 'band') return `g_num((double)(${iArg(0)} & ${iArg(1)}))`;
    if (name === 'bor') return `g_num((double)(${iArg(0)} | ${iArg(1)}))`;
    if (name === 'bxor') return `g_num((double)(${iArg(0)} ^ ${iArg(1)}))`;
    if (name === 'bnot') return `g_num((double)(~${iArg(0)}))`;
    if (name === 'shl') return `g_num((double)(${iArg(0)} << ${iArg(1)}))`;
    if (name === 'shr') return `g_num((double)(${iArg(0)} >> ${iArg(1)}))`;
    if (name === 'concat') {
      if (args.length === 0) return 'g_str("")';
      return args.reduce((a, b) => `g_str(g_cat2(g_show(${a}), g_show(${b})))`);
    }
    /* print */
    if (args.length === 0) {
      this.emit('g_print((gv *)0, 0);');
      return 'g_nil()';
    }
    /* 一格 / 两格实参走那两个专门的（省下「声明缓冲 + 逐格赋值」那两行）。 */
    if (args.length <= 2) {
      this.emit(`g_print${args.length}(${args.join(', ')});`);
      return 'g_nil()';
    }
    const buf = `p${this.fresh()}`;
    this.emit(`gv ${buf}[${args.length}];`);
    for (let i = 0; i < args.length; i++) this.emit(`${buf}[${i}] = ${args[i]};`);
    this.emit(`g_print(${buf}, ${args.length});`);
    return 'g_nil()';
  }

  /** 语句位置。 */
  stmt(x) {
    if (x === null || x === undefined) return;
    if (Array.isArray(x)) { for (const y of x) this.stmt(y); return; }
    if (x.lit !== undefined) return;
    this.chk(x.op);
    if (x.op === 'bind') {
      /* 绑给一个名字的 `func`：提到顶层，这一格不发局部量（C 里没有嵌套函数）。 */
      if (x.ins.init !== undefined && x.ins.init !== null && x.ins.init.op === 'func') {
        this.liftFunc(x.ins.init, x.attrs.name);
        return;
      }
      /* **模块级那几格**（顶层、且真被某个函数体读到）：声明摆到模块头上、这儿只赋值。 */
      const hoist = this.atTop && this.hoisted.has(x.attrs.name);
      /* 窄了的那几格落 `double`（判据 3）：值一路都是 double，只在被人当值用时才装回去。 */
      if (this.num.has(x.attrs.name)) {
        if (hoist) {
          this.decls.push(`static double ${cName(x.attrs.name)};`);
          this.emit(`${cName(x.attrs.name)} = ${this.dVal(x.ins.init)};`);
          return;
        }
        this.emit(`double ${cName(x.attrs.name)} = ${this.dVal(x.ins.init)};`);
        return;
      }
      /* 落成 C `struct` 的那几格记录（判据 2）：一格声明 + 逐个字段赋值。
       * 不用 `{ … }` 初始化式：字段的值可能要先发几行语句（列表、调用…），
       * 而那几行必须在这一格声明**之后**才轮到它 —— 逐个赋值就没有这个次序问题。 */
      const shape = this.rec.get(x.attrs.name);
      if (shape !== undefined) {
        const vals = asList(x.ins.init.ins.fields).filter((y) => y !== undefined);
        if (hoist) this.decls.push(`static struct ${shape.tag} ${cName(x.attrs.name)};`);
        else this.emit(`struct ${shape.tag} ${cName(x.attrs.name)};`);
        for (let i = 0; i < shape.names.length; i++) {
          this.emit(`${cName(x.attrs.name)}.${cField(shape.names[i])} = ${this.valOf(vals[i])};`);
        }
        return;
      }
      if (hoist) {
        this.decls.push(`static gv ${cName(x.attrs.name)};`);
        this.emit(`${cName(x.attrs.name)} = ${this.valOf(x.ins.init)};`);
        return;
      }
      this.emit(`gv ${cName(x.attrs.name)} = ${this.valOf(x.ins.init)};`);
      return;
    }
    if (x.op === 'set') {
      if (this.num.has(x.attrs.name)) {
        this.emit(`${cName(x.attrs.name)} = ${this.dVal(x.ins.value)};`);
        return;
      }
      this.emit(`${cName(x.attrs.name)} = ${this.valOf(x.ins.value)};`);
      return;
    }
    if (x.op === 'ret') {
      /* 函数体里 `ret` 就是 C 的 `return`。顶层（`main`）那一格回退出码 0：图的值不是
       * 进程的退出码，矩阵比的是印出来的那几行。值照旧算一遍 —— 它可能有副作用。 */
      if (this.inFn > 0) {
        /* 路上没有出口动作时**直接回**：那一格临时量本来是为了「先算值、再跑出口动作」
         * 才有的（那些动作可能改到值里读的那几个名字）。没有动作，它就是白发一行。 */
        const noExits = !this.hasExits('fn');
        if (this.rnum) {
          const v = x.ins.value === undefined ? '0.0' : this.dVal(x.ins.value);
          if (noExits) { this.emit(`return ${v};`); return; }
          const t = this.fresh();
          this.emit(`double ${t} = ${v};`);
          this.emitExits('fn');
          this.emit(`return ${t};`);
          return;
        }
        const v = x.ins.value === undefined ? 'g_nil()' : this.valOf(x.ins.value);
        if (noExits) { this.emit(`return ${v};`); return; }
        const t = this.fresh();
        this.emit(`gv ${t} = ${v};`);
        this.emitExits('fn');
        this.emit(`return ${t};`);
        return;
      }
      if (x.ins.value !== undefined) this.emit(`gv ${this.fresh()} = ${this.valOf(x.ins.value)};`);
      this.emitExits('fn');
      this.emit('return 0;');
      return;
    }
    if (x.op === 'prim') {
      const e = this.prim(x);
      if (e !== 'g_nil()') this.emit(`gv ${this.fresh()} = ${e};`);
      return;
    }
    if (x.op === 'branch') {
      this.emit(`if (${this.cCond(x.ins.cond)}) {`);
      this.depth += 1;
      this.cond += 1;
      this.stmt(asList(x.ins.then));
      this.cond -= 1;
      this.depth -= 1;
      if (x.ins.else === undefined) { this.emit('}'); return; }
      this.emit('} else {');
      this.depth += 1;
      this.cond += 1;
      this.stmt(asList(x.ins.else));
      this.cond -= 1;
      this.depth -= 1;
      this.emit('}');
      return;
    }
    if (x.op === 'region') {
      this.emit('{');
      this.depth += 1;
      this.pushFrame('region');
      this.stmt(asList(x.ins.body));
      this.popFrame();
      this.depth -= 1;
      this.emit('}');
      return;
    }
    if (x.op === 'scope-exit') {
      /* **只认「区域自己那一层」注册的动作**：C 里没有 finally，这几条动作是在每个
       * 出口各发一份的（`emitExits`），所以那份名单必须**静态就定下来**。
       * 注册在条件或循环里（`if (c) scope-exit …`）时名单是运行期才知道的 ——
       * 那要一格运行期的动作表 + 函数指针 + 捕获，正是这条腿还欠的同一格能力，报缺口。 */
      const f = this.frames[this.frames.length - 1];
      if (f === undefined) throw new Gap('c 后端：scope-exit 不在任何 region 里');
      if (this.cond !== f.cond) {
        throw new Gap('c 后端：scope-exit 注册在条件/循环里 —— 那份名单运行期才知道，'
          + '要一格动作表（函数指针 + 捕获）');
      }
      f.exits.push(asList(x.ins.action));
      return;
    }
    if (x.op === 'loop') return this.loop(x);
    if (x.op === 'index-set') {
      this.emit(`g_index_set(${this.valOf(x.ins.obj)}, ${this.valOf(x.ins.index)}, ${this.valOf(x.ins.value)});`);
      return;
    }
    if (x.op === 'field-set') {
      const o = x.ins.obj;
      if (o !== null && o !== undefined && o.op === 'ref' && this.rec.has(o.attrs.name)) {
        this.emit(`${cName(o.attrs.name)}.${cField(x.attrs.field)} = ${this.valOf(x.ins.value)};`);
        return;
      }
      this.emit(`g_field_set(${this.valOf(x.ins.obj)}, ${cStr(x.attrs.field)}, ${this.valOf(x.ins.value)});`);
      return;
    }
    if (x.op === 'map-set') {
      this.emit(`g_map_set(${this.valOf(x.ins.obj)}, ${this.valOf(x.ins.key)}, ${this.valOf(x.ins.value)});`);
      return;
    }
    if (x.op === 'loop-exit') {
      this.emitExits('loop');
      this.emit(x.attrs.kind === 'continue' ? 'continue;' : 'break;');
      return;
    }
    /* 断言：条件与那句话各一格端口。没给消息时第三格传 0 —— C 这边没有"可有可无的实参"。 */
    if (x.op === 'assert') {
      const c = this.valOf(x.ins.cond);
      const m = x.ins.msg === undefined ? 'g_nil()' : this.valOf(x.ins.msg);
      this.emit(`g_assert(${c}, ${m}, ${x.ins.msg === undefined ? 0 : 1});`);
      return;
    }
    /* 剩下的都是「有值但摆在语句位置」的那些：算一遍、扔掉。 */
    this.emit(`gv ${this.fresh()} = ${this.valOf(x)};`);
  }

  /**
   * 循环。**步进那一格摆在顶上、用一格「第一圈」标志挡住**，不是缀在体的末尾 ——
   * 缀在末尾的写法会让 `continue` 漏掉步进（`for` 的更新段在 JS/C 里都照跑，
   * js 后端那侧的注释记着同一笔账）。C 的 `for` 更新段只收表达式，而这一层的步进
   * 可能要发好几条语句，所以用标志这一形，两条腿的可观察行为才一致。
   */
  loop(x) {
    const post = asList(x.ins.post);
    let first = null;
    if (post.length > 0) {
      first = `f${this.fresh()}`;
      this.emit(`long long ${first} = 1;`);
    }
    this.emit('while (1) {');
    this.depth += 1;
    this.pushFrame('loop');
    this.cond += 1;
    if (first !== null) {
      this.emit(`if (${first} == 0) {`);
      this.depth += 1;
      this.stmt(post);
      this.depth -= 1;
      this.emit('}');
      this.emit(`${first} = 0;`);
    }
    this.emit(`if (!(${this.cCond(x.ins.cond)})) break;`);
    this.stmt(asList(x.ins.body));
    this.cond -= 1;
    this.popFrame();
    this.depth -= 1;
    this.emit('}');
  }

  /**
   * 一块体。**最后一格有值出端口，它就是这块的值** —— 判据是 `out-ports` 那一栏
   * （不是 sort、也不是猜），与 js 后端那侧 `jsFnBody` 同一条口径：
   * CL 的 `(let (…) … acc)` 最后一格是 `region`，sort 是 stat 但有值出端口。
   */
  body(list, t) {
    if (list.length === 0) return;
    for (let i = 0; i < list.length - 1; i++) this.stmt(list[i]);
    const last = list[list.length - 1];
    const hasValue = last !== null && last !== undefined
      && (last.lit !== undefined || (last.op !== undefined && declOf(last.op).outs.length > 0));
    if (t !== null && hasValue) this.emit(`${t} = ${this.valOf(last)};`);
    else this.stmt(last);
  }
}

/**
 * **提升那一趟**（与 core 共用一份，见 `lift.js`）：把函数体里 `bind` 出来的那格 `func`
 * 提到顶层 —— 借的那几格名字变成多出来的形参、每处调用补上实参。
 *
 * 分两拨与 core 那侧一字不差：顶层的 `bind`+`func` 是"已经在顶层了"（只提它们的**体**），
 * 别的顶层语句当一层（`owner` 叫 `main`）。不算捕获的名字 = 顶层函数名 + 顶层绑定的名字
 * （后者在 C 里落成模块级 `static`，见 `plan` 的 `topBinds`）。
 *
 * 回来的是一张**新的顶层清单**：提上来的那几格排在前头（函数定义没有次序问题 ——
 * `plan` 先把名字全派好），顶层语句照原样在后。
 */
function liftTop(top0) {
  const gapC = (why) => { throw new Gap(`c 后端：${why}`); };
  const raw = [];
  const rest0 = [];
  for (const it of top0) {
    if (it !== null && it !== undefined && it.op === 'bind'
      && it.ins.init !== undefined && it.ins.init !== null && it.ins.init.op === 'func') {
      raw.push(it);
    } else rest0.push(it);
  }
  const taken = new Set(raw.map((f) => f.attrs.name));
  const modNames = new Set();
  for (const it of rest0) {
    if (it !== null && it !== undefined && it.op === 'bind') modNames.add(it.attrs.name);
  }
  const known = new Set([...taken, ...modNames]);
  const liftedAll = [];
  const tops = [];
  for (const it of raw) {
    const fn = it.ins.init;
    const r = liftBody(fn.ins.body, it.attrs.name, known, taken, gapC);
    for (const gg of r.lifted) liftedAll.push(gg);
    tops.push({ name: it.attrs.name, params: (fn.attrs.params ?? []).map((q) => String(q)), body: r.body });
  }
  const rt = liftBody(rest0, 'main', known, taken, gapC);
  for (const gg of rt.lifted) liftedAll.push(gg);
  const mk = (f) => node('bind', {
    init: node('func', { body: f.body }, { params: f.params, name: f.name }),
  }, { name: f.name });
  return [...liftedAll.map(mk), ...tops.map(mk), ...rt.body];
}

/** 一张图 -> 一份自足的 `.c`。顶层那一块落成 `main`，`func` 一律提到顶层。 */
export function emitC(g) {
  const gen = new CGen();
  const top = liftTop(asList(g !== null && g.kind === 'graph' ? g.body : g));
  gen.plan(top);
  gen.np = numPlan(top);
  gen.rp = recPlan(top);
  gen.rec = gen.rp.locals.get('top') ?? new Map();
  /* 字段名编译期就知道的记录 -> 一格 `struct`（判据 2）。同形的共用一格，
   * 编号按登记顺序 —— 所以同一张图两次出来逐字节相同。 */
  for (const [names, tag] of gen.rp.shapes) {
    gen.decls.push(`struct ${tag} { ${names.split('|').map((f) => `gv ${cField(f)};`).join(' ')} };`);
  }
  /* **落成模块级的那几格不窄化**：窄化（`gv` -> `double`）是**一层作用域里**的账
     （`numPlan` 数的是 'top' 那一层的读写），可这几格现在要给别的函数读，那边看见的是 `gv`。
     两处对不上的代价量过：`cannot assign 'double' to 'struct gv'`（`vlang+decls`）。 */
  gen.num = new Set([...(gen.np.locals.get('top') ?? [])].filter((n) => !gen.hoisted.has(n)));
  gen.pushFrame('fn');
  gen.atTop = true;
  gen.body(top, null);
  gen.atTop = false;
  gen.popFrame();
  /* 原型先摆一遍：这样「A 调后面定义的 B」与互相递归都不必管定义次序。
   * 形参窄了的那几个收 `double`（`numPlan` 证过每个调用点递的都是数）。 */
  const sig = (f) => (f.params.length === 0 ? 'void'
    : f.params.map((p) => `${f.pnum === true ? 'double' : 'gv'} ${p}`).join(', '));
  /* 返回值窄了的那几个回 `double`（`numPlan` 证过：体的最后一格是 `ret`、每格 ret 都回数）。 */
  const rty = (f) => (f.rnum === true ? 'double' : 'gv');
  const protos = gen.fns.map((f) => `static ${rty(f)} ${f.cname}(${sig(f)});`);
  const bodies = gen.fns.map((f) => `static ${rty(f)} ${f.cname}(${sig(f)}) {\n${f.lines.join('\n')}\n}\n`);
  const prog = `/* ---- 编译期就知道的那几格常量 */
${gen.decls.join('\n')}

/* ---- 提到顶层的那些函数 */
${protos.join('\n')}

${bodies.join('\n')}
/* ---- 顶层那一块 */
int main(void) {
${gen.lines.join('\n')}
  return 0;
}
`;
  /* 序言按这份程序用到的那几族裁（第七节第 1 条）—— 漏留一格的后果是编不动，当场红。 */
  return `${trimPrelude(PRELUDE_ALL(), prog)}
${prog}`;
}

/**
 * **序言按用到的那几族裁**（`docs/design/node-graph-shrink.md` 第七节第 1 条）。
 *
 * 重量那一节量到的原话：`basics.lua` 那 435 行里**固定序言占 361 行（83%）**。它是常数，
 * 源码一长就摊薄 —— 可小例子上它就是那份产物的绝大部分，而一份只印两个串的程序**用不着**
 * 映射那一族、列表那一族、`g_pow`…
 *
 * 做法是**按名字传递地留**（一格土生土长的摇树）：
 *   1. 序言切成一格格定义（这份文本是我们自己写的，格式规整：定义都从第 0 列起，
 *      花括号配平，一行注释跟着它下面那格定义走）；
 *   2. 名字认得出来的（`static … g_xxx(`）才可能被裁；`#include` / `typedef` /
 *      `#define` / libc 的那几行原型**一律留**（它们是地基，也就几行）；
 *   3. 根是**这份程序自己那一段**里出现的 `g_*`，然后按每格定义里引用的 `g_*` 传递地留。
 *
 * 为什么敢裁：漏留一格的后果是**编不动**（我们自己那台 C 前端当场报「不认得这个名字」），
 * 而那条路上有 98 份例子在跑（`tests/graph/run.js` 的 c 那一列）—— 漏了当场红，不会
 * 悄悄给个错答案。
 */
function trimPrelude(text, rootText) {
  const chunks = [];
  let cur = [];
  let depth = 0;
  for (const ln of text.split('\n')) {
    cur.push(ln);
    for (const ch of ln) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    const t = ln.trim();
    /* 一格定义在**深度回到 0 且这一行以 `}` 或 `;` 收尾**时算完。注释与空行不收尾，
     * 于是它们跟着下面那格定义走 —— 裁掉一格函数，它头上那段注释跟着走。 */
    if (depth === 0 && (t.endsWith('}') || t.endsWith(';') || t.startsWith('#'))) {
      chunks.push(cur.join('\n'));
      cur = [];
    }
  }
  if (cur.length > 0) chunks.push(cur.join('\n'));

  const ids = (s) => {
    const out = new Set();
    const m = s.match(/\bg_[A-Za-z0-9_]+/g);
    if (m !== null) for (const x of m) out.add(x);
    return out;
  };
  const defs = chunks.map((c) => {
    /* 名字：`static <类型…> g_xxx(` 那一格（原型与定义同名，两格一起留或者一起裁）。 */
    const m = c.match(/static[^\n(]*?\b(g_[A-Za-z0-9_]+)\s*\(/);
    const name = m === null ? null : m[1];
    return { text: c, name, deps: ids(c) };
  });
  const keep = new Set();
  for (const x of ids(rootText)) keep.add(x);
  /* 传递闭包：留下来的定义里引用到的名字也要留。只加不减，所以最多转 defs.length 轮。 */
  for (let round = 0; round < defs.length + 1; round++) {
    let grew = false;
    for (const d of defs) {
      if (d.name === null || !keep.has(d.name)) continue;
      for (const dep of d.deps) {
        if (!keep.has(dep)) { keep.add(dep); grew = true; }
      }
    }
    if (!grew) break;
  }
  return defs.filter((d) => d.name === null || keep.has(d.name)).map((d) => d.text).join('\n');
}

/** `can` 那一问：这格节点接不接得住（接不住给一句人话 —— 那句话就是账）。 */
export function cCan(op) {
  if (OPS.has(op)) return true;
  return `c 后端还没接：${op}`;
}

/**
 * 形状上的账。每一条都要有**证物**（一份当场触发它的小图）—— 判据在
 * `tests/graph/run.js`：证物不报缺口的那条账当场红（说明那条账已经不欠了，该删）。
 */
export const C_SHAPES = [
  {
    what: '`^` 的指数不是整数',
    why: 'libc 那张桥（`interp/libc.js`）里没有 `pow`，而这一层的 `g_pow` 是「乘上去」——'
      + ' 只对整数次幂成立。指数是常量时当场报，不等到运行期给个错答案',
    witness: () => ({
      kind: 'graph',
      body: [node('prim', { args: [node('prim', { args: [{ lit: 2 }, { lit: 0.5 }] }, { name: '^' })] },
        { name: 'print' })],
    }),
  },
  {
    what: '`func` **捕获了外层的名字**（真闭包）',
    why: '函数一律提到顶层，C 那侧看得见的只有形参、别的顶层函数**与模块级那几格变量**；'
      + '读一格**外层函数的局部量**要一格环境对象 + 一格间接调用。'
      + '`wat` 那侧第一条形状账是同一件事 —— 两条腿欠的是同一格能力',
    /* **证物得借一格"外层函数的局部量"**，不能借顶层那一格：顶层的 `bind` 在 C 里落成
       模块级 `static`（`hoisted` 那一刀），任何函数都看得见 —— 那不是捕获。
       原来这份证物借的就是顶层的 `a`，于是那一刀落地之后它**不报了**，判据当场说
       "这条账已经不欠了" —— 那正是这一格该做的事（证物过期得被抓住）。 */
    witness: () => ({
      kind: 'graph',
      body: [
        node('bind', {
          init: node('func', {
            body: [
              node('bind', { init: { lit: 1 } }, { name: 'a' }),
              node('prim', {
                args: [node('call', {
                  fn: node('func', {
                    body: [node('ret', { value: node('ref', {}, { name: 'a' }) })],
                  }, { params: [] }),
                  args: [],
                })],
              }, { name: 'print' }),
            ],
          }, { params: [] }),
        }, { name: 'outer' }),
        node('call', { fn: node('ref', {}, { name: 'outer' }), args: [] }),
      ],
    }),
  },
  {
    what: '**按值调用**（函数从一格变量里来，不是当场摆着也不是一个顶层名字）',
    why: '要一格函数指针表 + 按元数分的签名。与上一条同一格能力的另一半：'
      + '有了环境对象与间接调用，这一条跟着就通',
    witness: () => ({
      kind: 'graph',
      body: [
        node('bind', { init: node('list-new', { items: [{ lit: 1 }] }) }, { name: 'g' }),
        node('prim', { args: [node('call', { fn: node('ref', {}, { name: 'g' }), args: [] })] },
          { name: 'print' }),
      ],
    }),
  },
  {
    what: '`scope-exit` **注册在条件或循环里**',
    why: 'C 里没有 finally，所以那几条动作是在每个出口各发一份的（`emitExits`）——'
      + '那份名单必须静态就定下来。注册在 `if` 里时名单运行期才知道，要一格动作表',
    witness: () => ({
      kind: 'graph',
      body: [node('region', {
        body: [node('branch', {
          cond: { lit: true },
          then: [node('scope-exit', { action: [node('prim', { args: [{ lit: 'x' }] }, { name: 'print' })] })],
        })],
      })],
    }),
  },
];

/**
 * 跑一份产物：交给**我们自己那台 C 前端**读成 MIR，再用 MIR 的解释器跑。
 *
 * 与 `runWat` 对称（那一格交给 `frontend-wat`）：正确性由一条互不相干的已有实现来证，
 * 而且**一个外部工具都不借** —— 不 spawn cc、不链接、不落盘。
 * 产物一个头都不 include，所以 `readFile` 那一格回 null 就够（前端根本不会去找文件）。
 */
export function runC(text) {
  const { mod } = lowerC('graph.c', text, {
    readFile: () => null,
    includeDirs: [],
    sysIncludeDirs: [],
    dirname,
    join,
  }, [], []);
  const out = [];
  let buf = '';
  const prev = setOutSink((s) => { buf += String(s); });
  try {
    /* `interpretMir` 收的是 **OIR**（它自己先降一遍）；C 这条腿手里已经是 MIR，
     * 所以走 `runMirModule` —— 与 `omni c run` 同一格入口（`cli.js` 那一处）。 */
    runMirModule({ structs: [], enums: [], classes: [], js: false }, mod);
  } finally {
    setOutSink(prev);
  }
  for (const line of buf.split('\n')) if (line !== '') out.push(line);
  return { value: null, out };
}
