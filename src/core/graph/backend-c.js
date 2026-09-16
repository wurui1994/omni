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

/** 这一刀接得住的节点。别的一律有名有姓地报缺口（`can` 那一问）。 */
const OPS = new Set(['const', 'ref', 'bind', 'set', 'prim', 'branch', 'loop', 'loop-exit',
  'region', 'ret']);

/** 这一刀接得住的内建。`prims.js` 里现有 16 格，全在这儿。 */
const C_PRIMS = new Set(['+', '-', '*', '/', '%', '^', '<', '>', '<=', '>=', '=', '!=',
  'not', 'concat', 'len', 'print']);

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

static gv g_nil(void) { gv v; v.t = GT_NIL; v.b = 0; return v; }
static gv g_bool(long long x) { gv v; v.t = GT_BOOL; v.b = x != 0 ? 1 : 0; return v; }
static gv g_num(double d) { gv v; v.t = GT_NUM; memcpy(&v.b, &d, 8); return v; }
static double g_d(gv v) { double d; memcpy(&d, &v.b, 8); return d; }
static gv g_str(const char *s) { gv v; v.t = GT_STR; memcpy(&v.b, &s, 8); return v; }
static const char *g_s(gv v) { const char *s; memcpy(&s, &v.b, 8); return s; }

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

static char *g_show(gv v) {
  if (v.t == GT_NIL) return g_dup("nil");
  if (v.t == GT_BOOL) return g_dup(v.b != 0 ? "true" : "false");
  if (v.t == GT_STR) return g_dup(g_s(v));
  return g_num_str(g_d(v));
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
static void g_die(const char *msg) {
  printf("graph-c: %s\\n", msg);
  exit(3);
}

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
`;

const PRELUDE_ALL = () => PRELUDE + P_SHOW + P_PRIM;

/** 名字要能当 C 标识符用（Scheme 的 `string-append`、awk 的 `$0` 那种）。 */
const cName = (n) => `v_${String(n).replace(/[^A-Za-z0-9_]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}`;

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
  }

  emit(s) { this.lines.push(`${'  '.repeat(this.depth)}${s}`); }

  fresh() { this.n += 1; return `t${this.n}`; }

  /** 这格节点这一刀接不接得住 —— 接不住当场报缺口（有名有姓，不是静默的错答案）。 */
  chk(op) {
    if (!OPS.has(op)) throw new Gap(`c 后端还没接这格节点：${op}`);
  }

  lit(v) {
    if (v === null || v === undefined) return 'g_nil()';
    if (typeof v === 'boolean') return `g_bool(${v ? 1 : 0})`;
    if (typeof v === 'number') return `g_num(${cNum(v)})`;
    if (typeof v === 'string') return `g_str(${cStr(v)})`;
    throw new Gap(`c 后端还没接这种常量：${typeof v}`);
  }

  /** 值位置。回一段 C 表达式（要发语句的先发，再回那格临时量的名字）。 */
  valOf(x) {
    if (x === null || x === undefined) return 'g_nil()';
    if (Array.isArray(x)) throw new Gap('c 后端：值位置上摆着一串节点');
    if (x.lit !== undefined) return this.lit(x.lit);
    this.chk(x.op);
    if (x.op === 'const') return this.lit(x.attrs.value ?? null);
    if (x.op === 'ref') return cName(x.attrs.name);
    if (x.op === 'prim') return this.prim(x);
    if (x.op === 'branch') {
      const t = this.fresh();
      this.emit(`gv ${t};`);
      this.emit(`if (g_truthy(${this.valOf(x.ins.cond)})) {`);
      this.depth += 1;
      this.emit(`${t} = ${this.valOf(x.ins.then)};`);
      this.depth -= 1;
      this.emit('} else {');
      this.depth += 1;
      this.emit(`${t} = ${x.ins.else === undefined ? 'g_nil()' : this.valOf(x.ins.else)};`);
      this.depth -= 1;
      this.emit('}');
      return t;
    }
    if (x.op === 'region') {
      const t = this.fresh();
      this.emit(`gv ${t} = g_nil();`);
      this.emit('{');
      this.depth += 1;
      this.body(asList(x.ins.body), t);
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
    const num2 = (op) => args.reduce((a, b) => `g_num(g_d(${a}) ${op} g_d(${b}))`);
    const rel = (op) => `g_bool(g_cmp(${args[0]}, ${args[1]}) ${op})`;
    if (name === '+') return args.length === 0 ? 'g_num(0.0)' : args.reduce((a, b) => `g_add(${a}, ${b})`);
    if (name === '-') return args.length === 1 ? `g_num(-g_d(${args[0]}))` : num2('-');
    if (name === '*') return args.length === 0 ? 'g_num(1.0)' : num2('*');
    if (name === '/') return num2('/');
    if (name === '%') return `g_num(g_fmod(g_d(${args[0]}), g_d(${args[1]})))`;
    if (name === '^') return `g_num(g_pow(g_d(${args[0]}), g_d(${args[1]})))`;
    if (name === '<') return rel('< 0');
    if (name === '>') return rel('> 0');
    if (name === '<=') return rel('<= 0');
    if (name === '>=') return rel('>= 0');
    if (name === '=') return `g_bool(g_eq(${args[0]}, ${args[1]}))`;
    if (name === '!=') return `g_bool(g_eq(${args[0]}, ${args[1]}) == 0)`;
    if (name === 'not') return `g_bool(g_truthy(${args[0]}) == 0)`;
    if (name === 'len') return `g_len(${args[0]})`;
    if (name === 'concat') {
      if (args.length === 0) return 'g_str("")';
      return args.reduce((a, b) => `g_str(g_cat2(g_show(${a}), g_show(${b})))`);
    }
    /* print */
    if (args.length === 0) {
      this.emit('g_print((gv *)0, 0);');
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
      this.emit(`gv ${cName(x.attrs.name)} = ${this.valOf(x.ins.init)};`);
      return;
    }
    if (x.op === 'set') {
      this.emit(`${cName(x.attrs.name)} = ${this.valOf(x.ins.value)};`);
      return;
    }
    if (x.op === 'ret') {
      /* 这一刀里 `func` 还没接，所以 `ret` 只会出现在顶层 —— 落成 `main` 的返回。
       * 值照旧算一遍（它可能有副作用，`ret print(1)` 那种），只是不当退出码用：
       * 矩阵比的是印出来的那几行，退出码是另一件事。 */
      if (x.ins.value !== undefined) this.emit(`gv ${this.fresh()} = ${this.valOf(x.ins.value)};`);
      this.emit('return 0;');
      return;
    }
    if (x.op === 'prim') {
      const e = this.prim(x);
      if (e !== 'g_nil()') this.emit(`gv ${this.fresh()} = ${e};`);
      return;
    }
    if (x.op === 'branch') {
      this.emit(`if (g_truthy(${this.valOf(x.ins.cond)})) {`);
      this.depth += 1;
      this.stmt(asList(x.ins.then));
      this.depth -= 1;
      if (x.ins.else === undefined) { this.emit('}'); return; }
      this.emit('} else {');
      this.depth += 1;
      this.stmt(asList(x.ins.else));
      this.depth -= 1;
      this.emit('}');
      return;
    }
    if (x.op === 'region') {
      this.emit('{');
      this.depth += 1;
      this.stmt(asList(x.ins.body));
      this.depth -= 1;
      this.emit('}');
      return;
    }
    if (x.op === 'loop') return this.loop(x);
    if (x.op === 'loop-exit') {
      this.emit(x.attrs.kind === 'continue' ? 'continue;' : 'break;');
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
    if (first !== null) {
      this.emit(`if (${first} == 0) {`);
      this.depth += 1;
      this.stmt(post);
      this.depth -= 1;
      this.emit('}');
      this.emit(`${first} = 0;`);
    }
    this.emit(`if (g_truthy(${this.valOf(x.ins.cond)}) == 0) break;`);
    this.stmt(asList(x.ins.body));
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

/** 一张图 -> 一份自足的 `.c`。顶层那一块落成 `main`。 */
export function emitC(g) {
  const gen = new CGen();
  gen.body(asList(g !== null && g.kind === 'graph' ? g.body : g), null);
  return `${PRELUDE_ALL()}
/* ---- 顶层那一块 */
int main(void) {
${gen.lines.join('\n')}
  return 0;
}
`;
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
