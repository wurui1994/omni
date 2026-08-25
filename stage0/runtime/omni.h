/* Omni 运行时 —— 公共头文件
 *
 * 生成的 C 只 #include 这一个头。与 backend-js/prelude.js 一一对应：任何一边改了语义，
 * 另一边必须同步改，差分测试（tests/run.js）是这条约束的执行者。
 *
 * 为什么热的叶子函数写成 static inline 放在头里，而不是塞进 .c：
 * 运行时拆成多个翻译单元之后，跨 TU 调用没有 LTO 就不会内联，而 i64 回绕算术、字符串
 * 取字节、dict 的 hash/eq 全在最内层循环上 —— 一次函数调用的开销就足以让 C 路径比 JS
 * 宿主还慢。tcc 不支持 -flto，所以选 static inline 而不是靠链接期优化。
 * 有错误路径但主路径极短的（div/mod）也放在这里：冷路径是一次 noreturn 调用，不影响内联。
 */
#ifndef OMNI_H
#define OMNI_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdarg.h>
#include <math.h>
#include <errno.h>

#if defined(__GNUC__) || defined(__clang__)
#define OMNI_NORETURN __attribute__((noreturn))
#else
#define OMNI_NORETURN
#endif

/* string 是不可变 UTF-8 字节序列，带长度。因为不可变，substr 可以直接别名原缓冲区。 */
typedef struct { const char *p; int64_t len; } omni_str;

/* JS 的 String 是 UTF-16 码元序列（ADR-0011 第 8 节）—— 不能拿 omni_str 顶替。
   `.length` / `charCodeAt` / `slice` 全是码元口径，而编译器自己的源码里满是中文注释：
   一个汉字 3 个 UTF-8 字节、1 个 UTF-16 码元。两个口径下词法器切出的位置不同，
   C1 与 node 直接分叉。同样不可变，所以 slice 也是别名。 */
typedef struct { const uint16_t *p; int64_t len; } omni_s16;

/* dynamic：带标签的胖值。容器载荷存 void*（容器类型都是指针 typedef），
   这样 omni_dyn 可以先于任何容器实例化定义，避免定义环。

   UNDEF 与 FN 两个标签是给 JS 前端用的（ADR-0011）：JS 区分 undefined 与 null，
   而 JS 的函数是值。Omni 源码里造不出这两个标签的值 —— `json` 子集不含它们。 */
enum {
  OMNI_DYN_NULL = 0, OMNI_DYN_BOOL, OMNI_DYN_INT, OMNI_DYN_REAL,
  OMNI_DYN_STRING, OMNI_DYN_LIST, OMNI_DYN_DICT,
  OMNI_DYN_UNDEF, OMNI_DYN_FN, OMNI_DYN_STR16
};

typedef struct {
  int tag;
  union { bool b; int64_t i; double r; omni_str s; omni_s16 s16; void *ref; } u;
} omni_dyn;

/* 函数值（ADR-0010）：指向闭包记录的指针。记录的第一个字段是被调函数的地址，
   后面紧跟捕获的变量 —— 每个 lambda 有自己的记录布局，由生成的 C 定义。
   闭包记录本身当作 self 传进被调函数，所以函数只要一个参数就能同时拿到
   "去哪儿" 和 "带了什么"，调用处不需要把函数值求值两次。
   fp 声明成函数指针而不是 void*：函数指针与对象指针之间的转换在 C 里不保证，
   而函数指针之间的互转是允许的（只要按真实类型调用）。 */
typedef void (*omni_fnptr)(void);
struct omni_closure_s { omni_fnptr fp; };
typedef struct omni_closure_s *omni_fn;

/* ================================================================ 声明 */

/* omni_error.c */
OMNI_NORETURN void omni_error(const char *msg);
OMNI_NORETURN void omni_errorf(const char *fmt, ...);
OMNI_NORETURN void omni_fail(omni_str msg);

/* omni_mem.c */
void *omni_nullck(void *p);
/* 增长：调用方必须传旧字节数 —— arena 不给每次分配加尺寸头（小对象上太贵），
   所以尺寸只能由知道它的容器代码传进来。语义等价于 realloc。 */
void *omni_grow(void *p, size_t oldBytes, size_t newBytes);

/* ---------------------------------------------------------------- 分配器
 * arena（bump 指针）。理由见 omni_mem.c 的文件头。分配是整个运行时最热的函数，
 * 所以快路径必须内联；慢路径（开新块）在 .c 里。
 * -DOMNI_NO_ARENA 换成一次一个 malloc：ASan 才能看见容器越界，消毒扫描走那条。
 */
#define OMNI_ALIGN 16

#ifdef OMNI_NO_ARENA
void *omni_alloc(size_t n);
char *omni_alloc_bytes(int64_t n);
#else
extern char *omni_arena_ptr;
extern char *omni_arena_end;
void *omni_alloc_slow(size_t n);
char *omni_alloc_bytes_slow(int64_t n);

/* 对齐的分配，给结构体和容器用 */
static inline void *omni_alloc(size_t n) {
  char *p = (char *)(((uintptr_t)omni_arena_ptr + (OMNI_ALIGN - 1)) & ~(uintptr_t)(OMNI_ALIGN - 1));
  if (p > omni_arena_end || n > (size_t)(omni_arena_end - p)) return omni_alloc_slow(n);
  omni_arena_ptr = p + n;
  return p;
}

/* 不对齐的分配，给字符串用：字符串是字节序列，不需要对齐，而且不对齐才能让
   omni_str_cat 的"在 arena 顶上原地追加"命中（见 omni_str.c） */
static inline char *omni_alloc_bytes(int64_t n) {
  if (n < 0) omni_error("negative allocation");
  if ((size_t)n > (size_t)(omni_arena_end - omni_arena_ptr)) return omni_alloc_bytes_slow(n);
  char *p = omni_arena_ptr;
  omni_arena_ptr = p + n;
  return p;
}
#endif

/* omni_int.c */
int64_t omni_trunc(double v);

/* omni_str.c */
omni_str omni_str_cat(omni_str a, omni_str b);
omni_str omni_str_join(const omni_str *items, int64_t n, omni_str sep);
omni_str omni_str_fmt(const char *fmt, ...);
int64_t omni_index_of(omni_str s, omni_str needle);
omni_str omni_chr(int64_t cp);
char *omni_cstr(omni_str s);

/* omni_fmt.c */
omni_str omni_str_int(int64_t v);
omni_str omni_str_real(double v);
omni_str omni_str_bool(bool v);
omni_str omni_str_string(omni_str v);
omni_str omni_repr_real(double v);
void omni_print_int(int64_t v);
void omni_print_real(double v);
void omni_print_bool(bool v);
void omni_print_string(omni_str v);

/* omni_conv.c */
int64_t omni_int_of_string(omni_str s);
double omni_real_of_string(omni_str s);

/* omni_dyn.c */
const char *omni_dyn_tag_name(int t);
omni_str omni_dyn_tag(omni_dyn v);
bool omni_dyn_eq(omni_dyn a, omni_dyn b);

/* omni_str16.c —— JS 的 String（UTF-16 码元序列，ADR-0011 第 8 节）。
   下标、长度、比较一律按码元；与外界（文件、print、Omni 的 string）之间只有
   omni_s16_of_utf8 / omni_s16_to_utf8 两个显式转换。
   越界与负下标的处理跟着 JS：不报错，按规范夹取或返回 NaN/undefined —— 由调用方的
   op 决定，这一层只提供"已经规范化过的下标"的原语。 */
omni_s16 omni_s16_of_utf8(omni_str s);
omni_s16 omni_s16_of_units(const uint16_t *p, int64_t len);
omni_str omni_s16_to_utf8(omni_s16 s);
/* 增量拼接：{0} 起手，add 若干次，done 收尾。replace/split/JSON 这些要在长串上
   一段段拼的地方必须用它，用 omni_s16_cat 串起来是平方级的。 */
typedef struct { uint16_t *p; int64_t len, cap; } omni_s16_buf;
void omni_s16_buf_add(omni_s16_buf *b, omni_s16 s);
void omni_s16_buf_add_unit(omni_s16_buf *b, uint16_t u);
omni_s16 omni_s16_buf_done(omni_s16_buf *b);
omni_s16 omni_s16_cat(omni_s16 a, omni_s16 b);
omni_s16 omni_s16_slice(omni_s16 s, int64_t start, int64_t end);
omni_s16 omni_s16_repeat(omni_s16 s, int64_t n);
omni_s16 omni_s16_pad_start(omni_s16 s, int64_t want, omni_s16 fill);
omni_s16 omni_s16_lower(omni_s16 s);
omni_s16 omni_s16_upper(omni_s16 s);
omni_s16 omni_s16_of_code_unit(int64_t u);
omni_s16 omni_s16_of_code_point(int64_t cp);
int omni_s16_cmp(omni_s16 a, omni_s16 b);
bool omni_s16_eq(omni_s16 a, omni_s16 b);
uint64_t omni_s16_hash(omni_s16 s);
int64_t omni_s16_index_of(omni_s16 s, omni_s16 needle, int64_t from);
int64_t omni_s16_last_index_of(omni_s16 s, omni_s16 needle);
bool omni_s16_starts_with(omni_s16 s, omni_s16 pre);
bool omni_s16_ends_with(omni_s16 s, omni_s16 suf);
/* 只按 JS 的 WhiteSpace + LineTerminator 定义裁剪，不做 Unicode 全集 */
omni_s16 omni_s16_trim(omni_s16 s, bool left, bool right);

/* omni_js.c —— JS 前端的运算语义（ADR-0011 第 4 节）。
   JS 的 truthiness / `+` 的双重含义 / `==` 的强制转换只活在这里，Omni 语言本身不受影响。 */
bool omni_js_truthy(omni_dyn v);
omni_dyn omni_js_typeof(omni_dyn v);
omni_dyn omni_js_str(omni_dyn v);
void omni_js_println(omni_dyn v);
omni_dyn omni_js_add(omni_dyn a, omni_dyn b);
omni_dyn omni_js_arith(int op, omni_dyn a, omni_dyn b);
omni_dyn omni_js_bitop(int op, omni_dyn a, omni_dyn b);
omni_dyn omni_js_bitnot(omni_dyn a);
bool omni_js_cmp(int op, omni_dyn a, omni_dyn b);
bool omni_js_eq(bool strict, omni_dyn a, omni_dyn b);
omni_dyn omni_js_neg(omni_dyn a);

/* omni_js_str.c —— JS 的 String 方法。收发都是 dynamic（谓词返回 bool）。
   碰容器的那几个（split / join / match）不在这里：list<dynamic> 是生成 TU 里的
   宏实例，运行时的翻译单元看不见，只能长在宏里。 */
omni_dyn omni_js_s16(omni_str s);
omni_dyn omni_js_str_len(omni_dyn s);
omni_dyn omni_js_str_index(omni_dyn s, omni_dyn i);
omni_dyn omni_js_str_at(omni_dyn s, omni_dyn i);
omni_dyn omni_js_str_char_code_at(omni_dyn s, omni_dyn i);
omni_dyn omni_js_str_code_point_at(omni_dyn s, omni_dyn i);
omni_dyn omni_js_str_slice(omni_dyn s, omni_dyn a, omni_dyn b);
omni_dyn omni_js_str_repeat(omni_dyn s, omni_dyn n);
omni_dyn omni_js_str_pad_start(omni_dyn s, omni_dyn n, omni_dyn fill);
omni_dyn omni_js_str_trim(int side, omni_dyn s);
omni_dyn omni_js_str_lower(omni_dyn s);
omni_dyn omni_js_str_upper(omni_dyn s);
omni_dyn omni_js_str_index_of(omni_dyn s, omni_dyn needle, omni_dyn from);
omni_dyn omni_js_str_last_index_of(omni_dyn s, omni_dyn needle);
bool omni_js_str_includes(omni_dyn s, omni_dyn needle);
bool omni_js_str_starts_with(omni_dyn s, omni_dyn pre, omni_dyn pos);
bool omni_js_str_ends_with(omni_dyn s, omni_dyn suf);
omni_dyn omni_js_str_of_char_code(omni_dyn u);
omni_dyn omni_js_str_of_code_point(omni_dyn cp);

/* omni_js_re.c —— JS 的 RegExp（手写回溯匹配器，ADR-0011）。
   编译器源码里的正则全是字面量，而且没有一处读写 lastIndex（`.test` 用的都是无 g 的
   常量正则），所以这一层不需要 RegExp 对象：模式与 flags 当普通字符串参数传进来，
   编译结果按字面量指针缓存（见 omni_js_re_get）。
   caps 的布局：caps[2i] / caps[2i+1] 是第 i 组的 [起, 止)，i=0 是整个匹配，
   没参与匹配的组是 -1。 */
typedef struct omni_re_s *omni_re;
/* caps 数组的固定上界：整个匹配算第 0 组，所以最多 OMNI_RE_MAX_CAPS-1 个捕获组。
   宏里的 match / split / replace 也照这个上界开栈上数组，超了在编译模式时就报错。 */
#define OMNI_RE_MAX_CAPS 33
omni_re omni_re_compile(omni_s16 pattern, omni_s16 flags);
int omni_re_groups(omni_re re);
bool omni_re_global(omni_re re);
bool omni_re_multiline(omni_re re);
bool omni_re_search(omni_re re, omni_s16 s, int64_t start, int64_t *caps);
omni_re omni_js_re_get(omni_str pattern, omni_str flags);
bool omni_js_re_test(omni_str pattern, omni_str flags, omni_dyn s);

/* omni_js_num.c —— JS 的 Number / Math / BigInt。
   toPrecision 与 toString(radix) 是自举的关键路径：编译器自己用它们把 double 与字节
   写进生成的 C，格式差一个字符，两代产出的 C 就不一样。 */
bool omni_js_num_is_nan(omni_dyn v);
bool omni_js_num_is_finite(omni_dyn v);
bool omni_js_num_is_integer(omni_dyn v);
omni_dyn omni_js_num_of(omni_dyn v);
omni_dyn omni_js_bigint_of(omni_dyn v);
omni_dyn omni_js_bigint_as_int_n(omni_dyn bits, omni_dyn v);
omni_dyn omni_js_math(int op, omni_dyn a, omni_dyn b);
omni_dyn omni_js_num_to_precision(omni_dyn v, omni_dyn digits);
omni_dyn omni_js_num_to_string(omni_dyn v, omni_dyn radix);

/* omni_hash.c —— 键的显示形式，只在 "key not found" 的错误消息里用，都是冷路径 */
omni_str omni_kstr_int(int64_t k);
omni_str omni_kstr_real(double k);
omni_str omni_kstr_bool(bool k);
omni_str omni_kstr_string(omni_str s);

/* ================================================ 热路径：static inline */

/* i64 算术：C 的有符号溢出是 UB，这里全部走无符号回绕，
   以便和 JS 后端的 BigInt.asIntN(64) 逐位一致 */
static inline int64_t omni_add(int64_t a, int64_t b) { return (int64_t)((uint64_t)a + (uint64_t)b); }
static inline int64_t omni_sub(int64_t a, int64_t b) { return (int64_t)((uint64_t)a - (uint64_t)b); }
static inline int64_t omni_mul(int64_t a, int64_t b) { return (int64_t)((uint64_t)a * (uint64_t)b); }
static inline int64_t omni_neg(int64_t a) { return (int64_t)(0u - (uint64_t)a); }
static inline int64_t omni_shl(int64_t a, int64_t b) { return (int64_t)((uint64_t)a << (b & 63)); }
static inline int64_t omni_shr(int64_t a, int64_t b) { return a >> (b & 63); }

static inline int64_t omni_div(int64_t a, int64_t b) {
  if (b == 0) omni_error("division by zero");
  if (a == INT64_MIN && b == -1) return INT64_MIN;  /* 与 C 的溢出行为对齐 */
  return a / b;
}

static inline int64_t omni_mod(int64_t a, int64_t b) {
  if (b == 0) omni_error("division by zero");
  if (a == INT64_MIN && b == -1) return 0;
  return a % b;
}

/* --- 字符串：构造与取字节在 lexer 那类循环里是最内层 --- */

static inline omni_str omni_str_new(const char *p, int64_t len) {
  omni_str s; s.p = p; s.len = len; return s;
}

static inline int64_t omni_str_len(omni_str s) { return s.len; }

/* 按字节比较（UTF-8 字节序 == 码点序）；前缀相同时短者在前 */
static inline int omni_str_cmp(omni_str a, omni_str b) {
  int64_t n = a.len < b.len ? a.len : b.len;
  int c = n ? memcmp(a.p, b.p, (size_t)n) : 0;
  if (c) return c;
  return a.len == b.len ? 0 : (a.len < b.len ? -1 : 1);
}

static inline int64_t omni_byte_at(omni_str s, int64_t i) {
  if (i < 0 || i >= s.len) {
    omni_errorf("string index out of range: %lld (length %lld)", (long long)i, (long long)s.len);
  }
  return (int64_t)(unsigned char)s.p[i];
}

static inline omni_str omni_substr(omni_str s, int64_t start, int64_t len) {
  if (start < 0 || len < 0 || start + len > s.len) {
    omni_errorf("substring out of range: start %lld, length %lld (string length %lld)",
                (long long)start, (long long)len, (long long)s.len);
  }
  return omni_str_new(s.p + start, len);
}

/* --- dynamic：构造与取值全是几条指令，必须内联 --- */

static inline omni_dyn omni_dyn_null(void) { omni_dyn d; d.tag = OMNI_DYN_NULL; d.u.i = 0; return d; }
static inline omni_dyn omni_dyn_undef(void) { omni_dyn d; d.tag = OMNI_DYN_UNDEF; d.u.i = 0; return d; }
static inline omni_dyn omni_dyn_of_fn(omni_fn f) { omni_dyn d; d.tag = OMNI_DYN_FN; d.u.ref = (void *)f; return d; }

static inline omni_dyn omni_dyn_of_bool(bool v) { omni_dyn d; d.tag = OMNI_DYN_BOOL; d.u.b = v; return d; }
static inline omni_dyn omni_dyn_of_int(int64_t v) { omni_dyn d; d.tag = OMNI_DYN_INT; d.u.i = v; return d; }
static inline omni_dyn omni_dyn_of_real(double v) { omni_dyn d; d.tag = OMNI_DYN_REAL; d.u.r = v; return d; }
static inline omni_dyn omni_dyn_of_string(omni_str v) { omni_dyn d; d.tag = OMNI_DYN_STRING; d.u.s = v; return d; }
static inline omni_dyn omni_dyn_of_s16(omni_s16 v) { omni_dyn d; d.tag = OMNI_DYN_STR16; d.u.s16 = v; return d; }
static inline omni_dyn omni_dyn_of_ref(void *v, int tag) { omni_dyn d; d.tag = tag; d.u.ref = v; return d; }

static inline void omni_dyn_want(omni_dyn v, int tag) {
  if (v.tag != tag) {
    omni_errorf("dynamic value is %s, expected %s", omni_dyn_tag_name(v.tag), omni_dyn_tag_name(tag));
  }
}

static inline bool omni_dyn_as_bool(omni_dyn v) { omni_dyn_want(v, OMNI_DYN_BOOL); return v.u.b; }
static inline int64_t omni_dyn_as_int(omni_dyn v) { omni_dyn_want(v, OMNI_DYN_INT); return v.u.i; }
static inline double omni_dyn_as_real(omni_dyn v) { omni_dyn_want(v, OMNI_DYN_REAL); return v.u.r; }
static inline omni_str omni_dyn_as_string(omni_dyn v) { omni_dyn_want(v, OMNI_DYN_STRING); return v.u.s; }
static inline void *omni_dyn_as_ref(omni_dyn v, int tag) { omni_dyn_want(v, tag); return v.u.ref; }

/* --- 函数值：调用前的空值检查（两个后端消息一致，不让 C 侧退化成段错误） --- */
static inline omni_fn omni_fn_ck(omni_fn f) {
  if (!f) omni_error("call of a null function value");
  return f;
}

/* JS 前端：从 dynamic 取回函数值。JS 的函数在 Omni 里只有一个签名
   `fn(list<dynamic>) -> dynamic`（实参个数由被调方自己看，和 JS 一样），
   所以这里不需要按签名分派。 */
static inline omni_fn omni_js_as_fn(omni_dyn v) {
  if (v.tag != OMNI_DYN_FN) omni_errorf("%s is not a function", omni_dyn_tag_name(v.tag));
  return (omni_fn)v.u.ref;
}

/* JS 前端：从 dynamic 取回 String。这一层不做隐式 ToString —— 需要转换的地方
   降级时会显式插一个 js_str，免得"哪里悄悄转了"变成两个后端的分叉点。 */
static inline omni_s16 omni_js_as_s16(omni_dyn v) {
  if (v.tag != OMNI_DYN_STR16) omni_errorf("%s is not a string", omni_dyn_tag_name(v.tag));
  return v.u.s16;
}

/* --- 键的 hash / eq：dict 的每一次查找都要走，全在最内层 ---
   eq 语义对齐 JS 的 SameValueZero：NaN 等于自身，+0 等于 -0 */

static inline int64_t omni_hash_int(int64_t k) {
  uint64_t x = (uint64_t)k;
  x ^= x >> 33; x *= 0xff51afd7ed558ccdULL;
  x ^= x >> 33; x *= 0xc4ceb9fe1a85ec53ULL;
  x ^= x >> 33;
  return (int64_t)x;
}
static inline bool omni_eq_int(int64_t a, int64_t b) { return a == b; }

static inline int64_t omni_hash_real(double k) {
  double d = (k == 0.0) ? 0.0 : k;
  uint64_t bits;
  if (isnan(d)) return omni_hash_int(0x7ff8000000000000LL);
  memcpy(&bits, &d, sizeof bits);
  return omni_hash_int((int64_t)bits);
}
static inline bool omni_eq_real(double a, double b) { return a == b || (isnan(a) && isnan(b)); }

static inline int64_t omni_hash_bool(bool k) { return omni_hash_int(k ? 1 : 0); }
static inline bool omni_eq_bool(bool a, bool b) { return a == b; }

static inline int64_t omni_hash_string(omni_str s) {
  uint64_t h = 1469598103934665603ULL;  /* FNV-1a 64 */
  for (int64_t i = 0; i < s.len; i++) { h ^= (unsigned char)s.p[i]; h *= 1099511628211ULL; }
  return (int64_t)h;
}
static inline bool omni_eq_string(omni_str a, omni_str b) { return omni_str_cmp(a, b) == 0; }

static inline int64_t omni_hash_dyn(omni_dyn v) { return omni_hash_int(v.tag); }
static inline bool omni_eq_dyn(omni_dyn a, omni_dyn b) { return omni_dyn_eq(a, b); }
static inline bool omni_eq_ref(void *a, void *b) { return a == b; }

#include "omni_container.h"
#include "omni_dyn_bridge.h"
#include "omni_js_arr.h"
#include "omni_js_obj.h"
#include "omni_js_json.h"
#include "omni_js_re.h"

#endif /* OMNI_H */
