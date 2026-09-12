/*
 * `probe.sx` 那几个 `(cabi …)` 的**另一端**（ADR-0022 的 J4b）。
 *
 * 刻意写成一份独立的 `.c`：这一条要证的正是「这个模块自己声明的外部符号，体在别人那儿」——
 * AOT 那一路把它链进去，JIT 那一路把它编成 dylib 再 `--lib` 装进来，两路走的是同一份体。
 */

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int64_t omni_probe_add(int64_t a, int64_t b) { return a + b; }

double omni_probe_scale(double x, int64_t n) { return x * (double)n; }

/* ptr 那一格：这个方言里地址就是一个整数，所以空指针进来是 0 —— 回 -1，
   好让「它真的按指针收了」这件事在输出上看得见。 */
int64_t omni_probe_len(const char *s) { return s == NULL ? -1 : (int64_t)strlen(s); }

void omni_probe_hi(void) { printf("hi from host\n"); }

/* 变参那一格（`(cabi f R (T ...))`，ADR-0022 的 J4d）。为什么值得有一份判据：苹果 arm64 上
   变参一律走**栈**而定参走寄存器，分界差一格就是读错地方（量出来过一次：
   `printf("hi %d\n", 7)` 把 7 当成了定参，印出 1860954544）。第一格是定参 —— 后面有几个 ——
   拿 va_arg 逐个取出来加起来，错了在输出上当场看得见。 */
int64_t omni_probe_sum(int64_t n, ...) {
  va_list ap;
  int64_t acc = 0;
  va_start(ap, n);
  for (int64_t i = 0; i < n; i++) acc += va_arg(ap, int64_t);
  va_end(ap);
  return acc;
}

/* `opaque class` 那一格（ADR-0022 的 J4b 最后一步）。形状与 jancy 一样：**对象由那一侧
   分配**，宿主只拿到指针；`Owner.method` 对着的 C 符号是 `Owner_method`，第一个形参是
   那个对象。宿主看不见对象的布局（那正是 opaque 的意思），所以状态放在自己这边一张
   小表里、拿指针当键 —— 一个真宿主对一个不透明句柄就是这么做的。 */
#define OMNI_PROBE_SLOTS 16
static void *probe_keys[OMNI_PROBE_SLOTS];
static int64_t probe_vals[OMNI_PROBE_SLOTS];

static int64_t *probe_slot(void *self) {
  for (int i = 0; i < OMNI_PROBE_SLOTS; i++) if (probe_keys[i] == self) return &probe_vals[i];
  for (int i = 0; i < OMNI_PROBE_SLOTS; i++) {
    if (probe_keys[i] == NULL) { probe_keys[i] = self; probe_vals[i] = 0; return &probe_vals[i]; }
  }
  return NULL;
}

/* 宿主面的 construct（第一百六十二刀）：`new Counter(start)` 落成"造一格 + 写 $tag +
   `(ccall Counter_construct self start)`"，符号名的约定与方法同一条。这一格把初值**记进**
   宿主自己那张表，所以后面 add 出来的数带着它 —— 那正是"construct 真跑了"的判据。 */
void Counter_construct(void *self, int64_t start) {
  int64_t *p = probe_slot(self);
  if (p != NULL) *p = start;
}

int64_t Counter_add(void *self, int64_t d) {  int64_t *p = probe_slot(self);
  if (p == NULL) return -1;
  *p += d;
  return *p;
}

/* 同名方法在**两个** opaque class 上各一条（第一百六十八刀）：`Owner.method` 对着的符号带类名，
   所以这两条是两个符号。这一格故意与 Counter_add 算得不一样（乘 2），好让"按对象挑的是哪一条"
   在输出上看得见 —— 先前那一层一个方法名只记一格主人，后声明的盖掉前面的。 */
/* `variant_t` 过来的是**一格地址**（第一百七十三刀）：指向这一层那格 variant 的表示 ——
   `(struct jnc$variant ($t int) ($n int) ($r real) ($s string))`，方言的 `int` 在原生腿上是 i64
   （ADR-0026:20 那个 `struct V { int m_tag; int64_t m_n; string_t m_s; }` 就是这个形状）。
   所以头两个字就是"标签"与"整数那一格"（标签 1 = 整数，见 lower.js 的 V_INT）。
   这一格存在的意义是**证明宿主真读得对**：光看 .sx 里发的 `(ccall … (var $vt1))` 证不了这件事。 */
void Counter_tag(void *self, const void *v) {
  const int64_t *p = (const int64_t *)v;
  (void)self;
  printf("tag %lld %lld\n", (long long)p[0], (long long)p[1]);
}

int64_t Other_add(void *self, int64_t d) {
  (void)self;
  return d * 2;
}

int64_t Counter_value(void *self) {
  int64_t *p = probe_slot(self);
  return p == NULL ? -1 : *p;
}

/* `variant_t` **从宿主面回来**（第一百七十四刀）：照 jancy 自己的调用约定，按内存回的那一格
   变成**最前面一个**指针形参、函数自己回 `void`（jnc_ct_CdeclCallConv_arm.cpp:71-80 那一段
   `j = 1` 说的就是"缓冲区那格摆在对象那格之前"）。所以这一格的 C 声明是
   `void Counter_last(jnc_Variant *ret, void *self)` —— 那块内存由**调用方**备好，宿主只往里写。
   写的形状与 Counter_tag 读的那一格是同一张表：头两个字是标签与整数那一格。 */
void Counter_last(void *ret, void *self) {
  int64_t *p = (int64_t *)ret;
  int64_t *q = probe_slot(self);
  p[0] = 1; /* V_INT */
  p[1] = q == NULL ? -1 : *q;
}

/* 属性的取值器回 `variant_t` 也是同一条：`Owner_get_p(ret, self)`。 */
void Counter_get_m_last(void *ret, void *self) { Counter_last(ret, self); }

/* **没写 `opaque` 的类**里那格只有原型的方法（第一百八十三刀）：符号名的约定与 opaque 那一支
   一模一样（`Owner_method`，第一个形参是那个对象）—— `opaque` 在 jancy 里说的是"布局不透明"，
   管的不是"体在哪儿"。这一格存在的意义是把那条约定**真跑一遍**。 */
int64_t Plain_twice(void *self, int64_t x) {
  (void)self;
  return x * 2;
}

/* 同一条约定也管那格只有原型的 `construct`（第一百八十四刀）：`new Plain(7)` 落成
   "造一格 + `(ccall Plain_construct self 7)`"。这一格把初值记进宿主自己那张表，
   于是后面 twice 出来的数带着它 —— 那正是"construct 真跑了"的判据。 */
void Plain_construct(void *self, int64_t seed) {
  int64_t *p = probe_slot(self);
  if (p != NULL) *p = seed;
}

int64_t Plain_seeded(void *self) {
  int64_t *p = probe_slot(self);
  return p == NULL ? -1 : *p;
}

/* `opaque class` 上那格**属性**的取/存（第一百六十刀）。jancy 里属性体内只写原型
   （`property m_scale { long get(); void set(long); }`，ui_PropertyGrid.jnc:78-88 那个形状）
   时，体也在宿主这边；符号名的约定与方法同一条，只是中间多一段 `get_` / `set_`：
   `Owner.m_p` 的取值器是 `Owner_get_m_p`、存值器是 `Owner_set_m_p`，第一个形参照旧是那个对象。
   这一格刻意**不是**单纯的读写：存的时候乘 10，好让"真走了宿主这两个函数"在输出上看得见。 */
static int64_t probe_scale[OMNI_PROBE_SLOTS];

static int64_t *probe_scale_slot(void *self) {
  for (int i = 0; i < OMNI_PROBE_SLOTS; i++) if (probe_keys[i] == self) return &probe_scale[i];
  for (int i = 0; i < OMNI_PROBE_SLOTS; i++) {
    if (probe_keys[i] == NULL) { probe_keys[i] = self; probe_scale[i] = 0; return &probe_scale[i]; }
  }
  return NULL;
}

int64_t Counter_get_m_scale(void *self) {
  int64_t *p = probe_scale_slot(self);
  return p == NULL ? -1 : *p;
}

void Counter_set_m_scale(void *self, int64_t v) {
  int64_t *p = probe_scale_slot(self);
  if (p != NULL) *p = v * 10;
}
