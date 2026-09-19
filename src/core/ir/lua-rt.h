// src/core/ir/lua-rt.h —— Lua 动态值的 C 运行时（NaN-boxing，与 LuaJIT 同一种编码）
//
// 每个 lua 值是一个 64 位 NaN-boxed 值：
//   - double：直接是 IEEE 754 位模式
//   - 其他类型：高 32 位是 tag（>= 0xFFF80001），低 32 位是 payload
//
// 这份运行时是 MLIR 后端的依赖：emit-mlir.js 生成的代码调用这里的函数。
// 编译方式：clang -c lua-rt.c -o lua-rt.o，然后与 MLIR 产物链接。

#ifndef OMNI_LUA_RT_H
#define OMNI_LUA_RT_H

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

// ---- 值表示 ----
//
// **数就是 double，没有 int 那一格**（Lua 5.1 / LuaJIT 的语义）。
//
// 这一条是量出来的，不是想出来的：原来有 `OVAL_TAG_INT`（32 位 payload），
// 于是 `1..1e7` 求和到 5e13 时**每一轮都溢出、每一轮都掉进慢路调运行时** ——
// loop 那个基准 61ms 里有 53ms 是这么来的（手写同形 C 是 7.6ms）。
// 改成"数只有 double"之后，算术快路是一条 `fadd`，没有溢出这回事。
//
// 代价明写：整数精度到 2^53（与 Lua 5.1 相同）。印出来要不要带小数点由
// `omni_val_print` 判（`d == (int64)d` 就印整数形）—— 那一格本来就在。

typedef uint64_t OVal;  // 所有 lua 值都是这一种

// Tag 编码（高 32 位）。**数是普通 double**（高 32 位 < 0xFFF80001）。
#define OVAL_TAG_NIL    0xFFF80001u
#define OVAL_TAG_FALSE  0xFFF80002u
#define OVAL_TAG_TRUE   0xFFF80003u
#define OVAL_TAG_STR    0xFFF80005u  // 低 32 位是堆对象登记表的下标
#define OVAL_TAG_FUNC   0xFFF80006u
#define OVAL_TAG_TAB    0xFFF80007u
/** 数与非数的分界：高 32 位 >= 这个值就不是数 */
#define OVAL_TAG_FIRST  0xFFF80001u

static inline uint32_t oval_tag(OVal v) {
    uint32_t hi = (uint32_t)(v >> 32);
    return hi >= OVAL_TAG_FIRST ? hi : 0;  // 0 = 是数（double）
}

static inline int oval_is_num(OVal v) { return oval_tag(v) == 0; }
static inline int oval_is_nil(OVal v) { return oval_tag(v) == OVAL_TAG_NIL; }

// ---- 构造 ----

static inline OVal oval_nil(void) { return (OVal)OVAL_TAG_NIL << 32; }
static inline OVal oval_true(void) { return (OVal)OVAL_TAG_TRUE << 32; }
static inline OVal oval_false(void) { return (OVal)OVAL_TAG_FALSE << 32; }

static inline OVal oval_from_double(double d) {
    union { double d; uint64_t u; } u;
    u.d = d;
    return u.u;
}
/** 整数也落成 double —— 保留这个名字是为了少改调用点 */
static inline OVal oval_from_int(int64_t i) { return oval_from_double((double)i); }

// ---- 取值 ----

static inline double oval_to_double(OVal v) {
    union { uint64_t u; double d; } u;
    u.u = v;
    return u.d;
}

static inline int64_t oval_to_int(OVal v) { return (int64_t)oval_to_double(v); }

// ---- 算术 ----
//
// **一条 fadd 就够**：两边是数就算，不是数才进慢路。
// 慢路 = 元表分派（`__add` 那一族）——见 omni_meta_arith，它在表与闭包之后定义，
// 所以这儿只留一个前向声明。**慢路是唯一的**：发射器的快路与它答案一致。
// 没有溢出检查、没有 rebox —— 那是 int tag 那一版的负担。

#define OMNI_OP_ADD 0
#define OMNI_OP_SUB 1
#define OMNI_OP_MUL 2
#define OMNI_OP_DIV 3
#define OMNI_OP_MOD 4
#define OMNI_OP_POW 5
#define OMNI_OP_UNM 6
OVal omni_meta_arith(OVal a, OVal b, int op);

OVal omni_val_add(OVal a, OVal b) {
    if (oval_is_num(a) && oval_is_num(b)) return oval_from_double(oval_to_double(a) + oval_to_double(b));
    return omni_meta_arith(a, b, OMNI_OP_ADD);
}

OVal omni_val_sub(OVal a, OVal b) {
    if (oval_is_num(a) && oval_is_num(b)) return oval_from_double(oval_to_double(a) - oval_to_double(b));
    return omni_meta_arith(a, b, OMNI_OP_SUB);
}

OVal omni_val_mul(OVal a, OVal b) {
    if (oval_is_num(a) && oval_is_num(b)) return oval_from_double(oval_to_double(a) * oval_to_double(b));
    return omni_meta_arith(a, b, OMNI_OP_MUL);
}

OVal omni_val_div(OVal a, OVal b) {
    if (oval_is_num(a) && oval_is_num(b)) return oval_from_double(oval_to_double(a) / oval_to_double(b));
    return omni_meta_arith(a, b, OMNI_OP_DIV);
}

OVal omni_val_mod(OVal a, OVal b) {
    if (oval_is_num(a) && oval_is_num(b)) {
        double da = oval_to_double(a), db = oval_to_double(b);
        // lua 的 % 是向下取整的模（不是 fmod）
        return oval_from_double(da - floor(da / db) * db);
    }
    return omni_meta_arith(a, b, OMNI_OP_MOD);
}

OVal omni_val_pow(OVal a, OVal b) {
    if (oval_is_num(a) && oval_is_num(b)) return oval_from_double(pow(oval_to_double(a), oval_to_double(b)));
    return omni_meta_arith(a, b, OMNI_OP_POW);
}

OVal omni_val_neg(OVal a) {
    if (oval_is_num(a)) return oval_from_double(-oval_to_double(a));
    return omni_meta_arith(a, a, OMNI_OP_UNM);
}

// ---- 比较 ----
//
// 这一族挪到了字符串那一节的后面 —— 串也要能比（`c >= "0"` 那一族），
// 而比串要用 OStr。见「比较（数与串）」。

// ---- 真值 ----

int omni_val_truthy(OVal v) {
    // lua: 只有 nil 和 false 为假
    uint32_t t = oval_tag(v);
    return t != OVAL_TAG_NIL && t != OVAL_TAG_FALSE;
}

// ---- 分配：一块一块推的 arena ----
//
// **没有 GC，所以 malloc 的那一半功能（free）我们一次都用不上**，剩下的只有开销。
// 量出来的账：`Point.new` 二十万次 27.9ms（每个 139ns），luajit 3.0ms。一个对象要
// 四次 malloc（OTab、哈希槽、串、串体），而每次 malloc 都要走一趟自由链 + 加锁。
// 换成往一块 1MB 里推指针之后，分配是 `add` 一条指令。
//
// 代价说清楚：**这一版不回收**。这是刻意的 —— GC 是下一刀（登记表的下标天然是根集），
// 在那之前，宁可把分配这一格做对做快，也不要把 malloc 的开销当成"动态语言就这样"。

#define OMNI_ARENA_CHUNK (1u << 20)
static char *omni_arena_p = NULL;
static size_t omni_arena_left = 0;

/* arena 的对齐粒度。8 就够：里头只有指针与 OVal（都是 8 字节），arm64 的 ldr/str/ldp/stp
   都只要 8 对齐。原来是 16，于是 88 字节的 Vec 被填成 96 —— 每次分配白付 8 字节的
   内存带宽（按量出来的 0.075 ns/字节，smallpt 上约 1.4ms）。 */
#define OMNI_ALLOC_ALIGN 8
static void *omni_alloc(size_t n) {
    n = (n + (OMNI_ALLOC_ALIGN - 1)) & ~(size_t)(OMNI_ALLOC_ALIGN - 1);
    if (n > omni_arena_left) {
        size_t sz = n > OMNI_ARENA_CHUNK ? n : OMNI_ARENA_CHUNK;
        omni_arena_p = (char *)malloc(sz);
        if (omni_arena_p == NULL) { fprintf(stderr, "omni: out of memory\n"); exit(1); }
        omni_arena_left = sz;
    }
    void *p = omni_arena_p;
    omni_arena_p += n; omni_arena_left -= n;
    return p;
}
static void *omni_alloc0(size_t n) {
    void *p = omni_alloc(n);
    /* ⚠️ 清的字节数必须与上面**留的**一样多，多一个字节就是踩下一个对象 */
    memset(p, 0, (n + (OMNI_ALLOC_ALIGN - 1)) & ~(size_t)(OMNI_ALLOC_ALIGN - 1));
    return p;
}

// ---- 堆对象登记处 ----
//
// payload 只有 32 位，装不下 64 位指针。所以堆对象放在一张全局表里，payload 是**下标**。
// 这比 LuaJIT 的 47 位指针方案笨，但可移植（wasm 那条腿也用得上），而且下标天然是
// GC 的根集索引。
//
// **表要能长**：原来是定长 65536，于是 `btree`（40×2^13 个表）与 `list`（20 万个结点）
// 直接印 `object table full` 退出 —— 那不是"慢"，是**跑不完**。
// 下标是 32 位，所以上限是 4G 个对象，够了。

/* **这三格是导出的**：发射器要在生成的代码里直接读它们（内联缓存的快路发在 MLIR 里，
   不再调运行时函数）。布局由文件末尾的 _Static_assert 钉住 —— 对不上是编译错误。 */
void **omni_objs = NULL;
static uint32_t omni_objs_n = 0, omni_objs_cap = 0;

static uint32_t omni_obj_reg(void *p) {
    if (omni_objs_n >= omni_objs_cap) {
        uint32_t c = omni_objs_cap ? omni_objs_cap * 2 : 1024;
        void **nb = (void **)realloc(omni_objs, (size_t)c * sizeof(void *));
        if (nb == NULL) { fprintf(stderr, "omni: out of memory (object table)\n"); exit(1); }
        omni_objs = nb; omni_objs_cap = c;
    }
    omni_objs[omni_objs_n] = p;
    return omni_objs_n++;
}
static void *omni_obj_at(uint32_t i) { return i < omni_objs_n ? omni_objs[i] : NULL; }

// ---- 字符串 ----
//
// **短串驻留（intern）**：内容相同的短串只有一格对象。于是
//   * 比相等 = 比那格 64 位值（`c == " "` 不必 memcmp）；
//   * 做哈希 = 读一格缓存好的数（表的键查找不必每次扫一遍内容）。
// 长串（> 40 字节）不驻留 —— `strcat` 那种边拼边长的串，驻留就是每次都把
// 整条内容散一遍，O(n²)。长串的哈希**按需算一次**，算完记在 OStr 里。
// 这个分界与 lua 自己的一样（短串驻留、长串懒散列），理由也一样。

#define OMNI_INTERN_MAX 40

typedef struct {
    uint32_t len;
    char *data;
    uint32_t hash;
    uint8_t hashed, interned;
} OStr;

static inline int oval_is_str(OVal v) { return oval_tag(v) == OVAL_TAG_STR; }
static inline OStr *oval_str(OVal v) { return (OStr *)omni_obj_at((uint32_t)v); }

static uint32_t ostr_hash_bytes(const char *s, uint32_t n) {
    uint32_t h = 2166136261u;                     // FNV-1a
    for (uint32_t i = 0; i < n; i++) { h ^= (unsigned char)s[i]; h *= 16777619u; }
    return h;
}

/** 驻留表：开地址，槽里放串的 OVal（0 表示空） */
static OVal *omni_intern = NULL;
static uint32_t omni_intern_cap = 0, omni_intern_n = 0;

static OVal ostr_make(const char *s, uint32_t len, uint32_t hash, int hashed, int interned) {
    OStr *st = (OStr *)omni_alloc(sizeof(OStr));
    st->len = len;
    st->data = (char *)omni_alloc((size_t)len + 1);
    memcpy(st->data, s, (size_t)len);
    st->data[len] = 0;
    st->hash = hash; st->hashed = (uint8_t)hashed; st->interned = (uint8_t)interned;
    return ((OVal)OVAL_TAG_STR << 32) | omni_obj_reg(st);
}

static void intern_grow(void) {
    uint32_t oc = omni_intern_cap;
    OVal *os = omni_intern;
    omni_intern_cap = oc ? oc * 2 : 256;
    omni_intern = (OVal *)calloc(omni_intern_cap, sizeof(OVal));
    omni_intern_n = 0;
    for (uint32_t i = 0; i < oc; i++) {
        if (os[i] == 0) continue;
        OStr *st = oval_str(os[i]);
        uint32_t m = omni_intern_cap - 1, j = st->hash & m;
        while (omni_intern[j] != 0) j = (j + 1) & m;
        omni_intern[j] = os[i];
        omni_intern_n++;
    }
    free(os);
}

OVal omni_str_new(const char *s, int32_t slen) {
    uint32_t len = (uint32_t)slen;
    if (len > OMNI_INTERN_MAX) return ostr_make(s, len, 0, 0, 0);
    uint32_t h = ostr_hash_bytes(s, len);
    if (omni_intern_cap == 0 || (omni_intern_n + 1) * 4 > omni_intern_cap * 3) intern_grow();
    uint32_t m = omni_intern_cap - 1, i = h & m;
    for (;;) {
        OVal cur = omni_intern[i];
        if (cur == 0) break;
        OStr *st = oval_str(cur);
        if (st->hash == h && st->len == len && memcmp(st->data, s, len) == 0) return cur;
        i = (i + 1) & m;
    }
    OVal nv = ostr_make(s, len, h, 1, 1);
    omni_intern[i] = nv;
    omni_intern_n++;
    return nv;
}

/** 数 → 串（lua 的 %.14g；整数值不带小数点） */
static OVal omni_num_to_str(OVal v) {
    char buf[40];
    double d = oval_to_double(v);
    if (d == (double)(int64_t)d && fabs(d) < 1e15) snprintf(buf, sizeof buf, "%lld", (long long)(int64_t)d);
    else snprintf(buf, sizeof buf, "%.14g", d);
    return omni_str_new(buf, (int32_t)strlen(buf));
}

OVal omni_val_concat(OVal a, OVal b) {
    OVal sa = oval_is_str(a) ? a : omni_num_to_str(a);
    OVal sb = oval_is_str(b) ? b : omni_num_to_str(b);
    OStr *x = oval_str(sa), *y = oval_str(sb);
    uint32_t n = x->len + y->len;
    if (n <= OMNI_INTERN_MAX) {
        char buf[OMNI_INTERN_MAX + 1];
        memcpy(buf, x->data, x->len);
        memcpy(buf + x->len, y->data, y->len);
        return omni_str_new(buf, (int32_t)n);      // 短的走驻留
    }
    OStr *st = (OStr *)omni_alloc(sizeof(OStr));
    st->len = n;
    st->data = (char *)omni_alloc((size_t)n + 1);
    memcpy(st->data, x->data, x->len);
    memcpy(st->data + x->len, y->data, y->len);
    st->data[n] = 0;
    st->hash = 0; st->hashed = 0; st->interned = 0;
    return ((OVal)OVAL_TAG_STR << 32) | omni_obj_reg(st);
}

OVal omni_val_tostring(OVal v) {
    if (oval_is_str(v)) return v;
    uint32_t t = oval_tag(v);
    if (t == OVAL_TAG_NIL) return omni_str_new("nil", 3);
    if (t == OVAL_TAG_TRUE) return omni_str_new("true", 4);
    if (t == OVAL_TAG_FALSE) return omni_str_new("false", 5);
    return omni_num_to_str(v);
}

// ---- 比较（数与串）----
//
// **串也要能比**。原来这三格只把两边当 double 看，于是：
//   * `c >= "0"` 拿两个 NaN 位模式去比 —— 结果恒假；
//   * `c == " "` 比的是登记表下标 —— 内容相同的两格串判不等。
// 两样都是**静默的错答案**（parse 那个例子数出来的记号数会少一大截），
// 不是"慢"。所以串比较是语义前提，不是优化。

static int ostr_cmp(OVal a, OVal b) {
    OStr *x = oval_str(a), *y = oval_str(b);
    uint32_t n = x->len < y->len ? x->len : y->len;
    int c = memcmp(x->data, y->data, n);
    if (c != 0) return c;
    return x->len < y->len ? -1 : (x->len > y->len ? 1 : 0);
}

OVal omni_val_lt(OVal a, OVal b) {
    if (oval_is_str(a) && oval_is_str(b)) return ostr_cmp(a, b) < 0 ? oval_true() : oval_false();
    return oval_to_double(a) < oval_to_double(b) ? oval_true() : oval_false();
}
OVal omni_val_le(OVal a, OVal b) {
    if (oval_is_str(a) && oval_is_str(b)) return ostr_cmp(a, b) <= 0 ? oval_true() : oval_false();
    return oval_to_double(a) <= oval_to_double(b) ? oval_true() : oval_false();
}
OVal omni_val_eq(OVal a, OVal b) {
    if (a == b) return oval_true();
    if (oval_is_str(a) && oval_is_str(b)) return ostr_cmp(a, b) == 0 ? oval_true() : oval_false();
    return oval_false();
}

// ---- 串上的方法（`s:sub(i,j)` 那一族）----
//
// lua 的下标从 1 起，负数从尾数（-1 是最后一个字符），越界要夹回去。

OVal omni_str_sub(OVal s, OVal iv, OVal jv) {
    if (!oval_is_str(s)) s = omni_val_tostring(s);
    OStr *st = oval_str(s);
    int64_t n = (int64_t)st->len;
    int64_t i = (int64_t)oval_to_double(iv);
    int64_t j = oval_is_nil(jv) ? -1 : (int64_t)oval_to_double(jv);
    if (i < 0) i = n + i + 1;
    if (j < 0) j = n + j + 1;
    if (i < 1) i = 1;
    if (j > n) j = n;
    if (i > j) return omni_str_new("", 0);
    return omni_str_new(st->data + (i - 1), (int32_t)(j - i + 1));
}


// ---- Hidden class / shape ----
//
// **v8 快 10 倍的根就在这儿**：`self.x` 在 v8 里是 `ldr x, [obj + 8]`（一条指令），
// 在我们原来的里是 `omni_tab_get` → `oval_hash("x")` → 线性探测（几十条指令）。
// smallpt 的向量每条操作 6~9 次字段访问，几百万次循环 —— 这就是 10x 的来源。
//
// 做法照 v8 的 hidden class（lua 5.4 也有类似的"哈希部分预分配 + 定偏移读写"）：
//   * **shape**（形状）：一张字段名 → 偏移量的映射，用 (key[], n) 表示。
//     同一个 `setmetatable({x=_, y=_, z=_}, Vec)` 出来的表形状相同。
//   * 表的哈希部分照旧（形状里没有的键落哈希），但**形状里有的键走定偏移**。
//     读写都是一次比较（shape 指针）+ 一次偏移读写，没有哈希查找。
//   * 形状是**不可变的**（增键 = 迁移到新形状），所以一个 shape 指针就是"这张表
//     有且仅有这些字段"的静态断言。
//
// 形状的分配走 arena（没有 GC，不回收）。

#define OMNI_SHAPE_MAX_FIELDS 16
#define OMNI_SHAPE_MAX_TRANS 8

typedef struct OShape {
    OVal keys[OMNI_SHAPE_MAX_FIELDS];   // 驻留串的 OVal，按插入顺序
    uint8_t n;                           // 字段数
    /* **转移缓存**（v8 的 transition tree）：这个形状加一格键 → 哪个形状。
       没有它，每次 `{x=,y=,z=}` 都要把键数组散列一遍再探测形状表 ——
       量出来 shape_intern 占 9%（smallpt 的每个 Vec 都走三趟）。 */
    uint8_t tn;
    OVal tkeys[OMNI_SHAPE_MAX_TRANS];
    struct OShape *tnext[OMNI_SHAPE_MAX_TRANS];
} OShape;

/* **形状对象各自分配**（arena），表里存的是 `OShape *`。
   原来是一整块 realloc 的数组 + 存指针进去 —— 一扩容，所有表手上的 shape 指针
   就全成了野指针。这一格是**内存损坏**，不是慢。 */
static OShape **omni_shapes = NULL;
static uint32_t omni_shapes_n = 0, omni_shapes_cap = 0;
/** **结构变动的代号**：往原型身上写字段时 +1。内联缓存拿它当"我还有效吗"的判据。 */
uint32_t omni_shape_gen = 1;

/** 形状的查找表：开地址，按(keys,n)散列。不大：程序里不同的"表的形状"通常几十个。 */
static uint32_t *omni_shape_ht = NULL;     // 0 = 空，>0 = 1+index
static uint32_t omni_shape_htcap = 0;

static uint32_t shape_hash(const OVal *keys, uint8_t n) {
    uint32_t h = 0x811c9dc5u;
    for (uint8_t i = 0; i < n; i++) { h ^= (uint32_t)keys[i]; h *= 16777619u; }
    return h;
}

static int shape_eq(const OShape *s, const OVal *keys, uint8_t n) {
    if (s->n != n) return 0;
    for (uint8_t i = 0; i < n; i++) if (s->keys[i] != keys[i]) return 0;
    return 1;
}

static void shape_ht_grow(void) {
    uint32_t oc = omni_shape_htcap;
    uint32_t *os = omni_shape_ht;
    omni_shape_htcap = oc ? oc * 2 : 64;
    omni_shape_ht = (uint32_t *)calloc(omni_shape_htcap, sizeof(uint32_t));
    for (uint32_t i = 0; i < oc; i++) {
        if (os[i] == 0) continue;
        OShape *s = omni_shapes[os[i] - 1];
        uint32_t h = shape_hash(s->keys, s->n), m = omni_shape_htcap - 1;
        uint32_t j = h & m;
        while (omni_shape_ht[j] != 0) j = (j + 1) & m;
        omni_shape_ht[j] = os[i];
    }
    free(os);
}

static OShape *shape_intern(const OVal *keys, uint8_t n) {
    if (omni_shape_htcap == 0 || (omni_shapes_n + 1) * 2 > omni_shape_htcap) shape_ht_grow();
    uint32_t h = shape_hash(keys, n), m = omni_shape_htcap - 1, i = h & m;
    for (;;) {
        uint32_t e = omni_shape_ht[i];
        if (e == 0) break;
        OShape *s = omni_shapes[e - 1];
        if (shape_eq(s, keys, n)) return s;
        i = (i + 1) & m;
    }
    if (omni_shapes_n >= omni_shapes_cap) {
        uint32_t c = omni_shapes_cap ? omni_shapes_cap * 2 : 32;
        OShape **nb = (OShape **)realloc(omni_shapes, (size_t)c * sizeof(OShape *));
        omni_shapes = nb; omni_shapes_cap = c;
    }
    OShape *s = (OShape *)omni_alloc0(sizeof(OShape));
    s->n = n; s->tn = 0;
    for (uint8_t k = 0; k < n; k++) s->keys[k] = keys[k];
    omni_shapes[omni_shapes_n++] = s;
    omni_shape_ht[i] = omni_shapes_n;        // 1-based
    return s;
}

/** 在形状里找一格键（驻留串 ⇒ 比指针就行），回偏移量；-1 = 没有 */
static int shape_find(const OShape *s, OVal key) {
    for (uint8_t i = 0; i < s->n; i++) if (s->keys[i] == key) return (int)i;
    return -1;
}

/**
 * 形状 + 一格新键 → 下一个形状。**先查转移缓存**（几条比较），只有第一次才去
 * 散列 + 驻留。`{x=,y=,z=}` 这种构造于是走的是三次指针比较，不是三次散列探测。
 */
static OShape *shape_add(OShape *s, OVal key) {
    if (s != NULL) {
        for (uint8_t i = 0; i < s->tn; i++) if (s->tkeys[i] == key) return s->tnext[i];
    }
    OVal keys[OMNI_SHAPE_MAX_FIELDS];
    uint8_t n = 0;
    if (s != NULL) { for (; n < s->n; n++) keys[n] = s->keys[n]; }
    keys[n++] = key;
    OShape *ns = shape_intern(keys, n);
    if (s != NULL && s->tn < OMNI_SHAPE_MAX_TRANS) {
        s->tkeys[s->tn] = key; s->tnext[s->tn] = ns; s->tn++;
    }
    return ns;
}

/** 空形状加一格键的那一档（表还没有形状时用；也走转移缓存） */
static OShape *omni_shape_root = NULL;
static OShape *shape_first(OVal key) {
    if (omni_shape_root == NULL) omni_shape_root = shape_intern(NULL, 0);
    return shape_add(omni_shape_root, key);
}


typedef struct { OVal k, v; } OPair;
/* 量"分配足迹本身值多少钱"的旋钮：每张定形状表多要这么多字节（不写、不读，纯占地方）。
   `-DOMNI_TAB_EXTRA=64` 之类重编一份就能量出 字节数 → 时间 的斜率。 */
#ifndef OMNI_TAB_EXTRA
#define OMNI_TAB_EXTRA 0
#endif
typedef struct {
    OVal *arr; uint32_t alen, acap;      // 数组部分：1..alen（lua 从 1 起）
    OPair *slot; uint32_t hcap, hused;   // 哈希部分：开地址，空槽的 k 是 nil
    OVal meta;                           // 元表（没有就是 nil）
    OShape *shape;                       // 形状（NULL = 没有形状，走老路哈希）
    OVal *svals;                         // 形状字段的值（shape->n 格，shape 非 NULL 时才用）
    uint8_t noshape;                     // 1 = 曾经溢出过形状上限，别再试了
    uint8_t is_proto;                    // 1 = 当过元表 / __index 目标（写它会让缓存作废）
} OTab;

static inline int oval_is_tab(OVal v) { return oval_tag(v) == OVAL_TAG_TAB; }
static inline OTab *oval_tab(OVal v) { return (OTab *)omni_obj_at((uint32_t)v); }

OVal omni_tab_new(void) {
    OTab *t = (OTab *)omni_alloc0(sizeof(OTab));
    t->meta = oval_nil();                // 清零出来的 0 是 double 0.0，不是 nil
    t->shape = NULL; t->svals = NULL;
    return ((OVal)OVAL_TAG_TAB << 32) | omni_obj_reg(t);
}

static int oval_key_eq(OVal a, OVal b) {
    if (a == b) return 1;
    if (oval_is_str(a) && oval_is_str(b)) {
        OStr *x = oval_str(a), *y = oval_str(b);
        if (x->interned && y->interned) return 0;      // 驻留过的：不同对象就是不同内容
        return x->len == y->len && memcmp(x->data, y->data, x->len) == 0;
    }
    // 数字键：都是 double，直接比数值
    if (oval_is_num(a) && oval_is_num(b))
        return oval_to_double(a) == oval_to_double(b);
    return 0;
}

/**
 * 键的散列。**串按内容散**（不按登记表下标）—— 不然 `t["k1"]` 与另一格内容相同的
 * 串会落到不同的槽，`hash` 那个例子就会查不着。
 * 算过的记在 OStr 里：字段名那一族（`self.x`）于是只读一格数。
 */
static uint32_t oval_hash(OVal k) {
    if (oval_is_str(k)) {
        OStr *s = oval_str(k);
        if (!s->hashed) { s->hash = ostr_hash_bytes(s->data, s->len); s->hashed = 1; }
        return s->hash;
    }
    uint64_t u = k;                                // 数与别的：散位模式
    u ^= u >> 33; u *= 0xff51afd7ed558ccdULL;
    u ^= u >> 33; u *= 0xc4ceb9fe1a85ec53ULL;
    u ^= u >> 33;
    return (uint32_t)u;
}

static void tab_hash_put(OTab *t, OVal k, OVal v);

/** 整数键？（不限范围） */
static int tab_int_key(OVal k, int64_t *out) {
    if (!oval_is_num(k)) return 0;
    double d = oval_to_double(k);
    if (d != (double)(int64_t)d) return 0;
    *out = (int64_t)d;
    return 1;
}

static uint32_t ceil_log2_u32(uint32_t n) {           // n>=1；回最小的 i 使 n <= 2^i
    uint32_t i = 0;
    while (((uint32_t)1 << i) < n) i++;
    return i;
}

/**
 * **把成片的整数键搬进数组部分**（lua 自己的 rehash 就是这一招）。
 *
 * 为什么非做不可：`for i = 2, N do f[i] = 1 end` 的第一个键是 2，而"追加"只认
 * `alen+1`，于是**两百万个整数键全躺在哈希里**。哈希槽 16 字节、随机落点，
 * 2e6 个键 = 几十 MB 的随机访问 —— sieve 量出来 427ms，luajit 21ms（20 倍）。
 * 那不是常数差，是**数据结构选错了**。
 *
 * 判据照 lua：找最大的 n = 2^i，使 [1, n] 里的整数键个数 **超过 n/2**（用了一半以上
 * 才值得摊平）。然后把这些键搬进数组部分，剩下的留在哈希。
 */
static void tab_rehash_arr(OTab *t) {
    uint32_t nums[32];
    for (uint32_t i = 0; i < 32; i++) nums[i] = 0;
    for (uint32_t i = 0; i < t->alen; i++)
        if (!oval_is_nil(t->arr[i])) nums[ceil_log2_u32(i + 1)]++;
    for (uint32_t i = 0; i < t->hcap; i++) {
        OVal k = t->slot[i].k;
        if (oval_is_nil(k) || oval_is_nil(t->slot[i].v)) continue;
        int64_t ik;
        if (!tab_int_key(k, &ik) || ik < 1 || ik > (int64_t)1 << 30) continue;
        nums[ceil_log2_u32((uint32_t)ik)]++;
    }
    uint32_t best = 0, acc = 0;
    for (uint32_t i = 0, twoi = 1; i <= 30; i++, twoi <<= 1) {
        acc += nums[i];
        if (acc > twoi / 2) best = twoi;
    }
    if (best <= t->alen) return;

    OVal *na = (OVal *)omni_alloc((size_t)best * sizeof(OVal));
    for (uint32_t i = 0; i < best; i++) na[i] = (i < t->alen) ? t->arr[i] : oval_nil();
    t->arr = na; t->acap = best; t->alen = best;
    for (uint32_t i = 0; i < t->hcap; i++) {        OVal k = t->slot[i].k;
        if (oval_is_nil(k) || oval_is_nil(t->slot[i].v)) continue;
        int64_t ik;
        if (!tab_int_key(k, &ik) || ik < 1 || ik > (int64_t)best) continue;
        t->arr[ik - 1] = t->slot[i].v;
        t->slot[i].v = oval_nil();          // 逻辑上删掉（下一趟重散时丢弃）
    }
}

/** 负载过 0.75 就翻倍重散（先试着把整数键摊进数组部分） */
static void tab_hash_grow(OTab *t) {
    tab_rehash_arr(t);
    uint32_t live = 0;
    for (uint32_t i = 0; i < t->hcap; i++)
        if (!oval_is_nil(t->slot[i].k) && !oval_is_nil(t->slot[i].v)) live++;
    uint32_t oc = t->hcap;
    OPair *os = t->slot;
    /* 搬走之后剩下的活键少了 ⇒ 不必翻倍，照活键数定容量 */
    uint32_t want = 4;
    while ((live + 1) * 4 > want * 3) want <<= 1;
    t->hcap = want;
    t->slot = (OPair *)omni_alloc0((size_t)t->hcap * sizeof(OPair));
    for (uint32_t i = 0; i < t->hcap; i++) t->slot[i].k = oval_nil();
    t->hused = 0;
    for (uint32_t i = 0; i < oc; i++)
        if (!oval_is_nil(os[i].k) && !oval_is_nil(os[i].v)) tab_hash_put(t, os[i].k, os[i].v);
}

static void tab_hash_put(OTab *t, OVal k, OVal v) {
    if (t->hcap == 0 || (t->hused + 1) * 4 > t->hcap * 3) {
        tab_hash_grow(t);
        /* **重散可能把数组部分撑大了**，而手上这个键正好落进去了 —— 那就得写数组。
           不补这一格的话，写进哈希的值会被数组里的 nil 挡住（**静默丢写**）：
           queens 因此少数出一大半的解（932 而不是 2680）。 */
        int64_t ik;
        if (tab_int_key(k, &ik) && ik >= 1 && (uint32_t)ik <= t->alen) {
            t->arr[ik - 1] = v;
            return;
        }
    }
    uint32_t m = t->hcap - 1, i = oval_hash(k) & m;
    for (;;) {
        if (oval_is_nil(t->slot[i].k)) { t->slot[i].k = k; t->slot[i].v = v; t->hused++; return; }
        if (oval_key_eq(t->slot[i].k, k)) { t->slot[i].v = v; return; }
        i = (i + 1) & m;
    }
}

static OVal tab_hash_get(OTab *t, OVal k) {
    if (t->hcap == 0) return oval_nil();
    uint32_t m = t->hcap - 1, i = oval_hash(k) & m;
    for (;;) {
        if (oval_is_nil(t->slot[i].k)) return oval_nil();
        if (oval_key_eq(t->slot[i].k, k)) return t->slot[i].v;
        i = (i + 1) & m;
    }
}

/** 数字键落在数组部分吗（1..alen+1 的正整数） */
static int tab_arr_idx(OTab *t, OVal k, uint32_t *out) {
    if (!oval_is_num(k)) return 0;
    double d = oval_to_double(k);
    if (d != (double)(int64_t)d) return 0;
    int64_t i = (int64_t)d;
    if (i < 1 || i > (int64_t)t->alen + 1) return 0;
    *out = (uint32_t)i;
    return 1;
}

/** 原始取值（不顺元表）—— **形状里有的键走定偏移** */
static OVal tab_get_raw(OVal tv, OVal k) {
    OTab *t = oval_tab(tv);
    if (!t) return oval_nil();
    if (t->shape != NULL && oval_is_str(k)) {
        int off = shape_find(t->shape, k);
        if (off >= 0) return t->svals[off];
    }
    uint32_t i;
    if (tab_arr_idx(t, k, &i) && i <= t->alen) return t->arr[i - 1];
    return tab_hash_get(t, k);
}

static OVal index_key(void);

/**
 * 取值 —— **查不着就顺 `__index` 往上**（lua 的元表语义）。
 * 没有元表时多一次 tag 判断就退出，所以热路径（`t[i]`）没有变慢。
 * `__index` 是函数的那一档还没做：那时候回 nil，不装作查着了。
 */
OVal omni_tab_get(OVal tv, OVal k) {
    OVal cur = tv;
    for (int d = 0; d < 64; d++) {
        OTab *t = oval_tab(cur);
        if (!t) return oval_nil();
        OVal v = tab_get_raw(cur, k);
        if (!oval_is_nil(v)) return v;
        OVal mt = t->meta;
        if (!oval_is_tab(mt)) return oval_nil();
        OVal idx = tab_get_raw(mt, index_key());
        if (!oval_is_tab(idx)) return oval_nil();
        cur = idx;
    }
    return oval_nil();
}

/** 数组部分扩到至少 need 格（arena 里没有 realloc，就是新开一块搬过去） */
static void tab_arr_reserve(OTab *t, uint32_t need) {    if (need <= t->acap) return;
    uint32_t c = t->acap ? t->acap : 8;
    while (c < need) c <<= 1;
    OVal *na = (OVal *)omni_alloc((size_t)c * sizeof(OVal));
    for (uint32_t i = 0; i < t->alen; i++) na[i] = t->arr[i];
    t->arr = na; t->acap = c;
}

void omni_tab_set(OVal tv, OVal k, OVal v) {
    OTab *t = oval_tab(tv);
    if (!t) return;
    /* **形状字段走定偏移写**。没有形状的表，第一次写串键就**开一格形状**；
       字段数超上限（或曾经溢出过）才退回哈希 —— `noshape` 记的就是"别再试了"。 */
    if (oval_is_str(k) && !t->noshape) {
        /* 往**原型**身上写字段 ⇒ 内联缓存里那些"值在原型第 n 格"的记录可能过期了。
           代号 +1 让它们全部作废。构造新对象时不会走到这儿（新表不是原型），
           所以热循环里的缓存不会被这一格打掉。 */
        if (t->is_proto) omni_shape_gen++;
        /* `T.__index = T` 这一句让被指的那张表成为原型 */
        if (oval_is_tab(v) && oval_is_str(k) && k == index_key()) {
            OTab *pt = oval_tab(v);
            if (pt) pt->is_proto = 1;
        }
        if (t->shape == NULL) {
            OShape *ns = shape_first(k);
            OVal *nv = (OVal *)omni_alloc(sizeof(OVal));
            nv[0] = v;
            t->shape = ns; t->svals = nv;
            return;
        }
        int off = shape_find(t->shape, k);
        if (off >= 0) { t->svals[off] = v; return; }
        /* 形状里没有 —— **迁移到新形状**（加一格字段，走转移缓存） */
        if (t->shape->n < OMNI_SHAPE_MAX_FIELDS) {
            OShape *old = t->shape;
            OShape *ns = shape_add(old, k);
            OVal *nv = (OVal *)omni_alloc((size_t)ns->n * sizeof(OVal));
            for (uint8_t j = 0; j < old->n; j++) nv[j] = t->svals[j];
            nv[ns->n - 1] = v;
            t->shape = ns; t->svals = nv;
            return;
        }
        /* 超过上限：把形状字段倒进哈希，从此这张表不再用形状 */
        for (uint8_t j = 0; j < t->shape->n; j++) tab_hash_put(t, t->shape->keys[j], t->svals[j]);
        t->shape = NULL; t->svals = NULL; t->noshape = 1;
        tab_hash_put(t, k, v);
        return;
    }
    uint32_t i;
    if (tab_arr_idx(t, k, &i)) {
        if (i <= t->alen) { t->arr[i - 1] = v; return; }
        // 追加一格（i == alen+1）
        tab_arr_reserve(t, t->alen + 1);
        t->arr[t->alen++] = v;
        /* 追加之后，哈希里可能正躺着 alen+1 那一格（`t[3]` 先存、`t[2]` 后存的情形）——
           把它们接着搬进数组部分，`#t` 才是对的。 */
        for (;;) {
            OVal nk = oval_from_double((double)(t->alen + 1));
            OVal nv = tab_hash_get(t, nk);
            if (oval_is_nil(nv)) break;
            tab_arr_reserve(t, t->alen + 1);
            t->arr[t->alen++] = nv;
            tab_hash_put(t, nk, oval_nil());       // 逻辑上删掉（留个墓碑槽）
        }
        return;
    }
    if (oval_is_nil(v) && t->hcap == 0) return;    // 存 nil 到空表：什么都不做
    tab_hash_put(t, k, v);
}

// ---- 内联缓存（每个字段访问点一格）----
//
// 形状把"查哈希"降成了"扫一遍 keys 比指针"，但 v8 比这还少一步：**它把偏移量
// 缓存在访问点上**。第二次起就是「比一次形状 + 一次定偏移读」，没有循环。
// 量出来的账（method 那个例子）：哈希 58ms → 形状 33ms → 这一刀之后见下面的数。
//
// 缓存放在运行时的一张数组里（每个访问点一格，id 由发射器编号），
// 发射器只传一个常量 id —— 它不必知道 OIC 的布局，也不必会摆 MLIR 的数组全局。
//
// **怎么保证不会答错**：
//   * `shape` 与 `meta` 都要与当初填缓存时相同（换元表会改 meta）；
//   * `gen` 是全局的"结构变动代号"—— 有新形状诞生或 setmetatable 就 +1，
//     于是原型链上后来加的字段不会被旧缓存挡住。热身之后 gen 不再变，缓存全程有效。
//   * `holder`：命中在原型上时记住那张表（方法查找就是这一档）。

typedef struct {
    OShape *shape;      // 接收者当初的形状
    OVal meta;          // 接收者当初的元表
    OVal holder;        // 0 = 值在接收者自己身上；否则是原型那张表
    int32_t off;        // 形状里的偏移量；-1 = 查不着（负缓存）
    uint32_t gen;       // 填缓存时的结构代号
} OIC;

static OIC *omni_ics = NULL;
OIC **omni_ics_p = &omni_ics;      /* 发射器通过这一格拿到缓存表的基址 */
static int32_t omni_ics_n = 0;
OVal omni_method_get(OVal obj, OVal key);      // 串的方法表在下面那一节

void omni_ic_reserve(int32_t n) {
    if (n <= omni_ics_n) return;
    omni_ics = (OIC *)calloc((size_t)n, sizeof(OIC));
    omni_ics_n = n;
}

/** 慢路：完整查找（顺 __index），并把结果填进缓存。**只在接收者有形状时调**。 */
static __attribute__((noinline)) OVal ic_fill_get(OTab *t, OVal tv, OVal k, OIC *ic) {
    OVal cur = tv;
    for (int d = 0; d < 64; d++) {
        OTab *ct = oval_tab(cur);
        if (!ct) break;
        if (ct->shape != NULL && oval_is_str(k)) {
            int off = shape_find(ct->shape, k);
            if (off >= 0) {
                ic->shape = t->shape; ic->meta = t->meta; ic->gen = omni_shape_gen;
                ic->off = off; ic->holder = (cur == tv) ? 0 : cur;
                return ct->svals[off];
            }
        }
        /* 形状里没有：可能在哈希/数组里（那一档不缓存，键不是定偏移的） */
        OVal v = tab_get_raw(cur, k);
        if (!oval_is_nil(v)) return v;
        OVal mt = ct->meta;
        if (!oval_is_tab(mt)) break;
        OVal idx = tab_get_raw(mt, index_key());
        if (!oval_is_tab(idx)) break;
        cur = idx;
    }
    /* 一路查不着 ⇒ 负缓存（`obj.field` 常态性地取 nil 的那一族） */
    ic->shape = t->shape; ic->meta = t->meta; ic->gen = omni_shape_gen;
    ic->off = -1; ic->holder = 0;
    return oval_nil();
}

/** 慢路的另一半：不是表 / 没形状 / 缓存没命中（拆出去，好让快路小到能内联） */
static __attribute__((noinline)) OVal ic_get_slow(OVal tv, OVal k, int32_t id) {
    if (oval_tag(tv) != OVAL_TAG_TAB) {
        if (oval_is_str(tv)) return omni_method_get(tv, k);   // 串的方法表
        return oval_nil();
    }
    OTab *t = oval_tab(tv);
    OIC *ic = &omni_ics[id];
    /* 命中在原型上 / 负缓存 —— 这两档也算命中，但放在慢路里（每次方法调用一次，
       不像字段读那样一个表达式里来三回） */
    if (t->shape == ic->shape && t->meta == ic->meta && ic->gen == omni_shape_gen) {
        if (ic->off < 0) return oval_nil();
        if (ic->holder != 0) return oval_tab(ic->holder)->svals[ic->off];
        return t->svals[ic->off];
    }
    /* **没有形状的表不进缓存**：它的串键可能躺在哈希里（形状溢出那一档），
       而"形状 + 偏移"这套判据只在"串键全在形状里"时才是准的。
       不守这一条会出静默的错答案：另一张同样没形状的表会命中别人的负缓存。 */
    if (t->shape == NULL) return omni_tab_get(tv, k);
    return ic_fill_get(t, tv, k, ic);
}

/**
 * 字段读的**快路**。命中的三档都在这儿：字段在自己身上、命中在原型上（方法查找
 * 就是这一档）、负缓存。**别把原型那一档挪去慢路** —— 量过：挪走之后每次方法
 * 查找从"一次调用"变成"两次调用"，smallpt 反而慢 4%。
 */
OVal omni_tab_get_ic(OVal tv, OVal k, int32_t id) {
    OIC *ic = &omni_ics[id];
    if (oval_tag(tv) == OVAL_TAG_TAB) {
        OTab *t = (OTab *)omni_objs[(uint32_t)tv];
        if (t->shape == ic->shape && t->meta == ic->meta && ic->gen == omni_shape_gen) {
            if (ic->off < 0) return oval_nil();
            if (ic->holder == 0) return t->svals[ic->off];
            return ((OTab *)omni_objs[(uint32_t)ic->holder])->svals[ic->off];
        }
    }
    return ic_get_slow(tv, k, id);
}

/**
 * **同一张表的 n 个具名字段，一次调用取完**（n = 2/3/4）。
 *
 * 为什么要这一格：采样里 `omni_tab_get_ic` 占 29%，而热点里的形状是
 * `Vec.new(a.x + b.x, a.y + b.y, a.z + b.z)` —— 同一张表连着读三个键，
 * 于是同一个形状检查做了三遍、调用也发了三次。合成一次之后
 * **形状只查一遍、调用少三分之二**，命中时三个值就是三次 load。
 *
 * 缓存怎么放：还是用现成的 OIC，**连着占 n 格**（id .. id+n-1）。
 * 这一族槽只由这一个调用点填，而且**一次填一组**（都来自同一张表），
 * 所以"第 0 格的形状命中"就意味着后面几格的 off 也是这张表的 —— 不用逐格再比。
 *
 * 顺序：Lua 不规定同一个表达式里子表达式的求值次序，所以把同一张表的几个读
 * 提到一块儿是合法的。**但不许跨 and/or 提**（那边有短路），发射器负责这一条。
 */
/**
 * **同一张表的 n 个具名字段一次取完**（GetFields 那条字节码的实现）。
 * 守卫只做一遍：命中就按 n 格缓存里的偏移各发一次 load。这一族槽只由这一个点填、
 * 而且一次填一组（都来自同一张表），所以"第 0 格命中"就意味着后面几格的 off 也是这张表的。
 */
void omni_tab_getn_ic(OVal tv, const OVal *keys, int32_t n, int32_t id, OVal *out) {
    if (oval_tag(tv) == OVAL_TAG_TAB) {
        OTab *t = (OTab *)omni_objs[(uint32_t)tv];
        OIC *ic0 = &omni_ics[id];
        if (t->shape == ic0->shape && t->meta == ic0->meta && ic0->gen == omni_shape_gen) {
            for (int32_t i = 0; i < n; i++) {
                OIC *ic = ic0 + i;
                if (ic->off < 0) out[i] = oval_nil();
                else if (ic->holder == 0) out[i] = t->svals[ic->off];
                else out[i] = ((OTab *)omni_objs[(uint32_t)ic->holder])->svals[ic->off];
            }
            return;
        }
    }
    for (int32_t i = 0; i < n; i++) out[i] = ic_get_slow(tv, keys[i], id + i);
}

void omni_tab_get3_ic(OVal tv, OVal k0, OVal k1, OVal k2, int32_t id, OVal *out) {
    if (oval_tag(tv) == OVAL_TAG_TAB) {
        OTab *t = (OTab *)omni_objs[(uint32_t)tv];
        OIC *ic0 = &omni_ics[id];
        if (t->shape == ic0->shape && t->meta == ic0->meta && ic0->gen == omni_shape_gen) {
            for (int32_t i = 0; i < 3; i++) {
                OIC *ic = ic0 + i;
                if (ic->off < 0) out[i] = oval_nil();
                else if (ic->holder == 0) out[i] = t->svals[ic->off];
                else out[i] = ((OTab *)omni_objs[(uint32_t)ic->holder])->svals[ic->off];
            }
            return;
        }
    }
    /* 没命中：逐格照原来那条路填/取（填完之后这一组就同形状了） */
    out[0] = ic_get_slow(tv, k0, id);
    out[1] = ic_get_slow(tv, k1, id + 1);
    out[2] = ic_get_slow(tv, k2, id + 2);
}

// ---- 带形状的表构造（`{x=..., y=..., z=...}` 那一族）----
//
// 采样量出来的账：构造一个 Vec 原来是 **5 次分配 + 3 次形状迁移 + 3 次 set 调用**
// （omni_tab_new 9% + omni_tab_set 21% + shape_add/alloc 3%）。
// C 基线是**零分配**（结构体在寄存器里），所以这一格是 19.6x 里的大头。
//
// 这一刀：发射器在编译期就知道那几个键，于是
//   * 形状只在**第一次**求（结果缓存在调用点的一格全局里）；
//   * OTab 与字段值**一块儿分配**（一次 arena 推指针）；
//   * 字段值直接 memcpy 进去，一次 set 都不调。

OVal omni_tab_new_shaped(void **shapeSlot, const OVal *keys, const OVal *vals, int32_t n) {
    OShape *sh = (OShape *)*shapeSlot;
    if (sh == NULL) {
        sh = shape_intern(keys, (uint8_t)n);
        *shapeSlot = (void *)sh;
    }
    /* OTab 与 svals 一块儿分配（arena 是推指针，所以"一块儿"就是少一次推）。
       **不要 alloc0**：清 88 字节会调 `memset`，采样里那一格自己占 12%。
       逐格写反而便宜 —— 何况大半格子马上就要被覆盖。 */
    char *blk = (char *)omni_alloc(sizeof(OTab) + (size_t)n * sizeof(OVal) + OMNI_TAB_EXTRA);
    OTab *t = (OTab *)blk;
    t->arr = NULL; t->alen = 0; t->acap = 0;
    t->slot = NULL; t->hcap = 0; t->hused = 0;
    t->noshape = 0; t->is_proto = 0;
    t->meta = oval_nil();
    t->shape = sh;
    t->svals = (OVal *)(blk + sizeof(OTab));
    for (int32_t i = 0; i < n; i++) t->svals[i] = vals[i];
    return ((OVal)OVAL_TAG_TAB << 32) | omni_obj_reg(t);
}

/** `setmetatable({…}, X)` 这一句合成一格：少一次调用、少一趟 is_proto 判定 */
OVal omni_tab_new_shaped_meta(void **shapeSlot, const OVal *keys, const OVal *vals,
                              int32_t n, OVal meta) {
    OVal tv = omni_tab_new_shaped(shapeSlot, keys, vals, n);
    OTab *t = (OTab *)omni_objs[(uint32_t)tv];
    t->meta = meta;
    OTab *m = (OTab *)((oval_tag(meta) == OVAL_TAG_TAB) ? omni_objs[(uint32_t)meta] : NULL);
    if (m) m->is_proto = 1;
    return tv;
}

/** 字段写的慢路（noinline，让快路能内联） */
static __attribute__((noinline)) void ic_set_slow(OVal tv, OVal k, OVal v, OIC *ic) {
    if (!oval_is_tab(tv)) return;
    OTab *t = oval_tab(tv);
    omni_tab_set(tv, k, v);
    if (t->shape != NULL && oval_is_str(k)) {
        int off = shape_find(t->shape, k);
        if (off >= 0) {
            ic->shape = t->shape; ic->meta = t->meta; ic->gen = omni_shape_gen;
            ic->off = off; ic->holder = 0;
        }
    }
}

void omni_tab_set_ic(OVal tv, OVal k, OVal v, int32_t id) {
    OIC *ic = &omni_ics[id];
    if (oval_tag(tv) == OVAL_TAG_TAB) {
        OTab *t = (OTab *)omni_objs[(uint32_t)tv];
        /* 写只认"字段就在这张表自己身上"那一档（lua 的语义：写总是写到自己身上） */
        if (t->shape != NULL && ic->shape == t->shape && ic->holder == 0
            && ic->off >= 0 && ic->gen == omni_shape_gen && !t->is_proto) {
            t->svals[ic->off] = v;
            return;
        }
    }
    ic_set_slow(tv, k, v, ic);
}

// ---- 长度（`#`）----

/**
 * 长度（`#`）。数组部分可能有洞（rehash 把成片的整数键摊进来之后），
 * 所以照 lua 的做法**找一个边界**：`t[n]` 非 nil 而 `t[n+1]` 是 nil。
 */
static uint32_t tab_border(OTab *t) {
    if (t->alen == 0) return 0;
    if (!oval_is_nil(t->arr[t->alen - 1])) return t->alen;
    uint32_t lo = 0, hi = t->alen;            // arr[lo-1] 非 nil（lo=0 视作真），arr[hi-1] 是 nil
    while (hi - lo > 1) {
        uint32_t m = (lo + hi) / 2;
        if (oval_is_nil(t->arr[m - 1])) hi = m; else lo = m;
    }
    return lo;
}

OVal omni_val_len(OVal v) {
    if (oval_is_str(v)) return oval_from_int((int32_t)oval_str(v)->len);
    if (oval_is_tab(v)) return oval_from_int((int32_t)tab_border(oval_tab(v)));
    return oval_from_int(0);
}

// ---- 取反（`not`）----

OVal omni_val_not(OVal v) {
    uint32_t t = oval_tag(v);
    return (t == OVAL_TAG_NIL || t == OVAL_TAG_FALSE) ? oval_true() : oval_false();
}

// ---- 数值 for 的继续条件 ----
//
// lua 的 `for i = a, b, st`：步长为正时条件是 `i <= b`，为负时是 `i >= b`。
// 方向在运行期才知道（步长可以是变量），所以这一格判断归运行时，不归发射器。
// 这正是「把一格处理对」——发射器不必生成两套分支。

int omni_for_cont(OVal i, OVal limit, OVal step) {
    double si = oval_to_double(i), sl = oval_to_double(limit), ss = oval_to_double(step);
    return ss >= 0 ? (si <= sl) : (si >= sl);
}

// ---- 闭包（一等函数）----
//
// lua 的函数是值，捕获是**按引用**的（`counter()` 回的那格函数改的是同一个 `n`）。
// 于是两样东西：
//   * **格子**（cell）：被内层函数捕获的局部量搬到堆上，读写都过这格指针。
//     外层栈帧没了格子还在 —— upvalue 能活下来就靠这一格。
//   * **闭包**：函数指针 + 一张格子指针表。
//
// 调用约定：编出来的函数第一个形参是那张表（`!llvm.ptr`），后面才是实参（i64）。
// 顶层具名函数不走这条路（直接 call，没有间接那一跳），所以这一层只给
// 匿名函数 / 嵌套函数 / 方法用。
//
// **实参个数不符不装作没事**：lua 的语义是补 nil / 丢多余，这一版还没做，
// 所以 omni_clo_fp 直接报错退出 —— 宁可响，不要静默的错答案。

typedef struct { void *fp; uint32_t arity; uint32_t nup; OVal **up; } OClo;

static inline int oval_is_fn(OVal v) { return oval_tag(v) == OVAL_TAG_FUNC; }
static inline OClo *oval_clo(OVal v) { return (OClo *)omni_obj_at((uint32_t)v); }

OVal *omni_cell_new(OVal init) {
    OVal *c = (OVal *)omni_alloc(sizeof(OVal));
    *c = init;
    return c;
}

OVal omni_clo_new(void *fp, int32_t arity, int32_t nup, OVal **up) {
    OClo *c = (OClo *)omni_alloc(sizeof(OClo));
    c->fp = fp; c->arity = (uint32_t)arity; c->nup = (uint32_t)nup;
    if (nup > 0) {
        c->up = (OVal **)omni_alloc((size_t)nup * sizeof(OVal *));
        memcpy(c->up, up, (size_t)nup * sizeof(OVal *));   // 表在调用方栈上，要抄一份
    } else {
        c->up = NULL;
    }
    return ((OVal)OVAL_TAG_FUNC << 32) | omni_obj_reg(c);
}

void *omni_clo_fp(OVal f, int32_t argc) {
    if (!oval_is_fn(f)) { fprintf(stderr, "omni: attempt to call a non-function\n"); exit(1); }
    OClo *c = oval_clo(f);
    if ((int32_t)c->arity != argc) {
        fprintf(stderr, "omni: arity mismatch (called with %d, function takes %u)\n", argc, c->arity);
        exit(1);
    }
    return c->fp;
}

OVal **omni_clo_env(OVal f) { return oval_clo(f)->up; }

// ---- 元表与方法查找 ----
//
// `p:add(q)` 与 `self.x` 走的是同一台机器：**查表，查不着就顺 `__index` 往上**。
// 串也当"有元表的对象"看 —— 它的方法表是内建的那一格（`s:sub(i,j)`）。
// 于是发射器那一层只需要「查一格方法 + 间接调用」，类型分派全在这儿。

static OVal S_index_key; static int S_index_ok = 0;
static OVal index_key(void) {
    if (!S_index_ok) { S_index_key = omni_str_new("__index", 7); S_index_ok = 1; }
    return S_index_key;
}

OVal omni_setmetatable(OVal tv, OVal mt) {
    OTab *t = oval_tab(tv);
    if (t) t->meta = mt;
    /* 这张元表从此是**原型**：往它身上写字段会让内联缓存作废（见 omni_shape_gen） */
    OTab *m = oval_tab(mt);
    if (m) m->is_proto = 1;
    return tv;                          // lua 的 setmetatable 回那张表
}

OVal omni_getmetatable(OVal tv) {
    OTab *t = oval_tab(tv);
    return t ? t->meta : oval_nil();
}

static OVal str_sub_fn(OVal **up, OVal self, OVal i, OVal j) { (void)up; return omni_str_sub(self, i, j); }
static OVal str_len_fn(OVal **up, OVal self) { (void)up; return omni_val_len(self); }

static OVal S_strlib; static int S_strlib_ok = 0;
static OVal strlib(void) {
    if (!S_strlib_ok) {
        S_strlib = omni_tab_new();
        omni_tab_set(S_strlib, omni_str_new("sub", 3), omni_clo_new((void *)str_sub_fn, 3, 0, NULL));
        omni_tab_set(S_strlib, omni_str_new("len", 3), omni_clo_new((void *)str_len_fn, 1, 0, NULL));
        S_strlib_ok = 1;
    }
    return S_strlib;
}

OVal omni_method_get(OVal obj, OVal key) {
    if (oval_is_str(obj)) return omni_tab_get(strlib(), key);
    if (oval_is_tab(obj)) return omni_tab_get(obj, key);      // omni_tab_get 已经顺 __index
    fprintf(stderr, "omni: attempt to index a non-table value\n");
    exit(1);
}

// ---- 算子的元方法（`__add` 那一族）----
//
// 发射器的**慢路就是这儿**：两边不都是数时才来。于是 `Vec + Vec` 这种
// 运算符重载不需要发射器知道任何事情 —— 它照样只发「一次 tag 检查 + 两条路」。
// smallpt 那个例子（向量全靠 `__add`/`__sub`/`__mul`/`__mod`）走的就是这条。

void omni_extra_set(int32_t i, OVal v);       // 边槽在下面那一节，这儿先声明

static OVal S_mm[7]; static int S_mm_ok = 0;
static OVal mm_key(int op) {
    if (!S_mm_ok) {
        S_mm[OMNI_OP_ADD] = omni_str_new("__add", 5);
        S_mm[OMNI_OP_SUB] = omni_str_new("__sub", 5);
        S_mm[OMNI_OP_MUL] = omni_str_new("__mul", 5);
        S_mm[OMNI_OP_DIV] = omni_str_new("__div", 5);
        S_mm[OMNI_OP_MOD] = omni_str_new("__mod", 5);
        S_mm[OMNI_OP_POW] = omni_str_new("__pow", 5);
        S_mm[OMNI_OP_UNM] = omni_str_new("__unm", 5);
        S_mm_ok = 1;
    }
    return S_mm[op];
}

static OVal meta_field(OVal v, OVal key) {
    if (!oval_is_tab(v)) return oval_nil();
    OTab *t = oval_tab(v);
    if (!oval_is_tab(t->meta)) return oval_nil();
    return tab_get_raw(t->meta, key);
}

/**
 * **算子元方法的解析缓存**（直接映射，键是"元表 + 哪个算子"）。
 *
 * 采样的账：`Vec + Vec` 每次都要 `meta_field` → `tab_get_raw` → `shape_find`
 * （Vec 的元表有八个字段，线性扫），再加 `oval_is_fn` / arity 两道检查。
 * 那一族在 smallpt 里占 ~6%（meta_field 143 + meta_arith 69 / 3400 样本）。
 *
 * 失效判据与内联缓存同一条：`omni_shape_gen`（往原型身上写字段就 +1）。
 * 缓存里记的是**解析结果**（那格闭包），所以键必须含元表本身 ——
 * 不同元表的同名算子当然是不同的函数。
 */
typedef struct { OVal meta; uint32_t gen; uint32_t op; OClo *clo; } OMMC;
static OMMC omni_mmc[128];

OVal omni_meta_arith(OVal a, OVal b, int op) {
    /* 取接收者的元表（a 没有就看 b —— lua 的规矩） */
    OVal mt = oval_nil();
    if (oval_tag(a) == OVAL_TAG_TAB) mt = ((OTab *)omni_objs[(uint32_t)a])->meta;
    if (!oval_is_tab(mt) && oval_tag(b) == OVAL_TAG_TAB) mt = ((OTab *)omni_objs[(uint32_t)b])->meta;

    uint32_t slot = (uint32_t)((mt >> 3) ^ (uint32_t)(op * 31u)) & 127u;
    OMMC *e = &omni_mmc[slot];
    if (e->meta == mt && e->gen == omni_shape_gen && e->op == (uint32_t)op && e->clo != NULL) {
        OClo *c = e->clo;
        OVal (*fp)(OVal **, OVal, OVal) = (OVal (*)(OVal **, OVal, OVal))c->fp;
        return fp(c->up, a, b);
    }

    OVal key = mm_key(op);
    OVal h = meta_field(a, key);
    if (oval_is_nil(h)) h = meta_field(b, key);
    if (!oval_is_fn(h)) {
        fprintf(stderr, "omni: attempt to perform arithmetic on a non-number value (op %d)\n", op);
        exit(1);
    }
    OClo *c = oval_clo(h);
    if (c->arity != 2) {
        fprintf(stderr, "omni: metamethod takes %u args, arithmetic passes 2\n", c->arity);
        exit(1);
    }
    if (oval_is_tab(mt)) {
        e->meta = mt; e->gen = omni_shape_gen; e->op = (uint32_t)op; e->clo = c;
    }
    OVal (*fp)(OVal **, OVal, OVal) = (OVal (*)(OVal **, OVal, OVal))c->fp;
    return fp(c->up, a, b);
}

/**
 * **单态化守卫没过时走这儿**：顺手看看能不能把守卫武装起来，然后照常算。
 *
 * 发射器在算术点上发的是「a 的元表 == 我等的那张 && 结构代号没变 ⇒ 直接调那格函数」。
 * 第一次来、或者代号变过之后，就落到这儿：确认"那张元表的这个算子确实是那格函数"，
 * 确认得了就把当前代号写进 okSlot（守卫从此命中，直到下一次结构变动）。
 */
OVal omni_mm_slow(OVal a, OVal b, int32_t op, OVal expectTab, void *fp, uint32_t *okSlot) {
    OVal am = (oval_tag(a) == OVAL_TAG_TAB) ? ((OTab *)omni_objs[(uint32_t)a])->meta : oval_nil();
    if (am == expectTab && oval_is_tab(expectTab)) {
        OVal h = meta_field(a, mm_key(op));
        if (oval_is_fn(h) && oval_clo(h)->fp == fp) *okSlot = omni_shape_gen;
    }
    return omni_meta_arith(a, b, op);
}

// ---- math 那几格 ----
//
// 不是一张"库函数清单"：这些是**内建**（没有副作用、就是一条指令或一次 libm 调用），
// 发射器按名字直接发 call，不经表查找。带副作用的那一族（io / os）不在这儿。

OVal omni_math_sqrt(OVal x) { return oval_from_double(sqrt(oval_to_double(x))); }
OVal omni_math_abs(OVal x)  { return oval_from_double(fabs(oval_to_double(x))); }
OVal omni_math_sin(OVal x)  { return oval_from_double(sin(oval_to_double(x))); }
OVal omni_math_cos(OVal x)  { return oval_from_double(cos(oval_to_double(x))); }
OVal omni_math_tan(OVal x)  { return oval_from_double(tan(oval_to_double(x))); }
OVal omni_math_exp(OVal x)  { return oval_from_double(exp(oval_to_double(x))); }
OVal omni_math_log(OVal x)  { return oval_from_double(log(oval_to_double(x))); }
OVal omni_math_floor(OVal x){ return oval_from_double(floor(oval_to_double(x))); }
OVal omni_math_ceil(OVal x) { return oval_from_double(ceil(oval_to_double(x))); }
OVal omni_math_fmod(OVal a, OVal b) { return oval_from_double(fmod(oval_to_double(a), oval_to_double(b))); }
OVal omni_math_pow(OVal a, OVal b)  { return oval_from_double(pow(oval_to_double(a), oval_to_double(b))); }
OVal omni_math_max(OVal a, OVal b) {
    double x = oval_to_double(a), y = oval_to_double(b);
    return oval_from_double(x > y ? x : y);
}
OVal omni_math_min(OVal a, OVal b) {
    double x = oval_to_double(a), y = oval_to_double(b);
    return oval_from_double(x < y ? x : y);
}

// ---- ipairs ----
//
// lua 的泛型 for 拿的是**三样东西**：迭代函数 f、状态 s、控制变量 ctrl，
// 每步算 `f(s, ctrl)`，回的第一个值是新的 ctrl，是 nil 就停。
// `ipairs(t)` 就回这三样（迭代函数是无状态的，所以同一张表可以同时被多个循环走）。

static OVal ipairs_step(OVal **up, OVal s, OVal ctrl) {
    (void)up;
    double i = oval_to_double(ctrl) + 1;
    OVal v = omni_tab_get(s, oval_from_double(i));
    if (oval_is_nil(v)) return oval_nil();
    omni_extra_set(0, v);                     // 第二个返回值：元素
    return oval_from_double(i);
}

static OVal S_ipairs_fn; static int S_ipairs_ok = 0;

/** 回迭代函数；状态与初值由发射器按约定取（s = 那张表、ctrl = 0） */
OVal omni_ipairs(OVal t) {
    (void)t;
    if (!S_ipairs_ok) { S_ipairs_fn = omni_clo_new((void *)ipairs_step, 2, 0, NULL); S_ipairs_ok = 1; }
    omni_extra_set(0, t);                     // 第二个返回值：状态 = 那张表
    omni_extra_set(1, oval_from_double(0));   // 第三个：控制变量初值
    return S_ipairs_fn;
}

// ---- 协程（自己切栈，不用 ucontext）----
//
// **为什么不用 ucontext**：量过。`swapcontext` 每次都要走一趟 `sigprocmask` 系统调用，
// 200000 次 yield（= 400000 次切换）在这台机器上 **338ms**；下面这段自己切栈的
// **7.7ms**，44 倍。这一条是先写了两版再量出来的，不是想出来的 ——
// cyber / luajit 的 fiber 都是自己切栈，理由就是这个。
//
// 切的是什么：arm64 的调用约定里被调方要保住 x19–x28、x29/x30、d8–d15。
// 把这 20 格连 sp 一起换掉，就换了一条执行流。栈是 malloc 出来的 1MB。
//
// 起一条协程：在它自己的栈顶**摆一个假的保存帧** —— x19 槽放协程指针，
// lr 槽放入口跳板的地址。于是第一次切进去时，`ret` 直接落到跳板上。

#define OMNI_CORO_STACK (1u << 20)

typedef struct OCoro {
    void *sp, *caller_sp;
    char *stack;
    int done;
    OVal xfer;          // 传出的值（yield 的实参 / 结束时的 nil）
    OVal fn;            // 协程体（一格函数值）
} OCoro;

void omni_ctx_sw(void **from, void *to);
void omni_coro_main(OCoro *co);
extern void omni_coro_entry(void);

#if !defined(__aarch64__)
#error "omni lua-rt: 协程的栈切换目前只写了 arm64 那一份"
#endif

__asm__(
".text\n"
".p2align 2\n"
".globl _omni_ctx_sw\n"
"_omni_ctx_sw:\n"
"  sub sp, sp, #0xa0\n"
"  stp x19, x20, [sp, #0x00]\n"
"  stp x21, x22, [sp, #0x10]\n"
"  stp x23, x24, [sp, #0x20]\n"
"  stp x25, x26, [sp, #0x30]\n"
"  stp x27, x28, [sp, #0x40]\n"
"  stp x29, x30, [sp, #0x50]\n"
"  stp d8,  d9,  [sp, #0x60]\n"
"  stp d10, d11, [sp, #0x70]\n"
"  stp d12, d13, [sp, #0x80]\n"
"  stp d14, d15, [sp, #0x90]\n"
"  mov x9, sp\n"
"  str x9, [x0]\n"
"  mov sp, x1\n"
"  ldp x19, x20, [sp, #0x00]\n"
"  ldp x21, x22, [sp, #0x10]\n"
"  ldp x23, x24, [sp, #0x20]\n"
"  ldp x25, x26, [sp, #0x30]\n"
"  ldp x27, x28, [sp, #0x40]\n"
"  ldp x29, x30, [sp, #0x50]\n"
"  ldp d8,  d9,  [sp, #0x60]\n"
"  ldp d10, d11, [sp, #0x70]\n"
"  ldp d12, d13, [sp, #0x80]\n"
"  ldp d14, d15, [sp, #0x90]\n"
"  add sp, sp, #0xa0\n"
"  ret\n"
".p2align 2\n"
".globl _omni_coro_entry\n"
"_omni_coro_entry:\n"
"  mov x0, x19\n"
"  bl _omni_coro_main\n"
"  brk #1\n"
);

static OCoro *omni_cur_coro = NULL;

void omni_coro_main(OCoro *co) {
    OClo *c = oval_clo(co->fn);
    OVal (*fp)(OVal **) = (OVal (*)(OVal **))c->fp;
    fp(c->up);                       // 协程体：0 个实参
    co->done = 1;
    co->xfer = oval_nil();
    omni_ctx_sw(&co->sp, co->caller_sp);   // 回调用方，再不回来
    __builtin_trap();
}

static OVal omni_coro_resume(OCoro *co) {
    if (co->done) return oval_nil();
    OCoro *prev = omni_cur_coro;
    omni_cur_coro = co;
    omni_ctx_sw(&co->caller_sp, co->sp);
    omni_cur_coro = prev;
    return co->xfer;
}

OVal omni_coro_yield(OVal v) {
    OCoro *co = omni_cur_coro;
    if (co == NULL) { fprintf(stderr, "omni: yield outside a coroutine\n"); exit(1); }
    co->xfer = v;
    omni_ctx_sw(&co->sp, co->caller_sp);
    return oval_nil();               // resume 往回传值那一档还没做
}

/** wrap 出来的那格函数：泛型 for 会拿 (state, ctrl) 两个实参调它，两个都不用 */
static OVal coro_step(OVal **up, OVal a, OVal b) {
    (void)a; (void)b;
    OCoro *co = (OCoro *)(uintptr_t)(uint64_t)*up[0];
    return omni_coro_resume(co);
}

OVal omni_coro_wrap(OVal fn) {
    OCoro *co = (OCoro *)calloc(1, sizeof(OCoro));
    co->fn = fn;
    co->xfer = oval_nil();
    co->stack = (char *)malloc(OMNI_CORO_STACK);
    char *top = co->stack + OMNI_CORO_STACK;
    top = (char *)((uintptr_t)top & ~(uintptr_t)15);
    top -= 0xa0;
    memset(top, 0, 0xa0);
    ((uint64_t *)top)[0] = (uint64_t)(uintptr_t)co;                  // x19 槽
    ((uint64_t *)top)[11] = (uint64_t)(uintptr_t)omni_coro_entry;    // lr 槽
    co->sp = top;
    OVal *cell = (OVal *)malloc(sizeof(OVal));
    *cell = (OVal)(uintptr_t)co;
    OVal *upv[1]; upv[0] = cell;
    return omni_clo_new((void *)coro_step, 2, 1, upv);
}


//
// 我们的调用约定只回一格 i64。第二个及往后的返回值放在这一格**边槽**里：
// 被调方返回前写进去，调用方紧接着读出来。中间不能夹别的调用 —— 发射器保证
// 「调用 → 立刻取边槽」是连着发的。
//
// 这是 lua C API 那条栈的极简版。不是终局（协程进来之后每条协程要各自一份），
// 但足以把 `return a, b` 与 `local x, y = f()` 做对，而不是静默丢掉第二格。

#define OMNI_EXTRA_MAX 8
static OVal omni_extra_slot[OMNI_EXTRA_MAX];
static int32_t omni_extra_n = 0;

void omni_extra_set(int32_t i, OVal v) {
    if (i < 0 || i >= OMNI_EXTRA_MAX) return;
    omni_extra_slot[i] = v;
    if (i + 1 > omni_extra_n) omni_extra_n = i + 1;
}
OVal omni_extra_get(int32_t i) {
    return (i >= 0 && i < omni_extra_n) ? omni_extra_slot[i] : oval_nil();
}

/** `{...}` 那一格：抄一份数组部分（变长实参表只有数组部分） */
OVal omni_tab_clone(OVal tv) {
    OVal nv = omni_tab_new();
    OTab *s = oval_tab(tv), *d = oval_tab(nv);
    if (!s) return nv;
    if (s->alen > 0) {
        d->acap = s->alen; d->alen = s->alen;
        d->arr = (OVal *)omni_alloc((size_t)s->alen * sizeof(OVal));
        memcpy(d->arr, s->arr, (size_t)s->alen * sizeof(OVal));
    }
    for (uint32_t i = 0; i < s->hcap; i++)
        if (!oval_is_nil(s->slot[i].k)) tab_hash_put(d, s->slot[i].k, s->slot[i].v);
    return nv;
}

// ---- IO ----
//
// `print(a, b)` 在 lua 里是**一行、制表符隔开**。原来每个实参各印一行，
// 与参考实现对不上（单实参的例子看不出来）。所以分成 write + 结尾两格。

static void oval_write(OVal v) {
    uint32_t t = oval_tag(v);
    if (t == 0) {
        double d = oval_to_double(v);
        if (d == (double)(int64_t)d && fabs(d) < 1e15) printf("%lld", (long long)(int64_t)d);
        else printf("%.14g", d);
    } else if (t == OVAL_TAG_NIL) {
        printf("nil");
    } else if (t == OVAL_TAG_TRUE) {
        printf("true");
    } else if (t == OVAL_TAG_FALSE) {
        printf("false");
    } else if (t == OVAL_TAG_STR) {
        OStr *s = oval_str(v);
        if (s) printf("%.*s", (int)s->len, s->data);
        else printf("<str?>");
    } else if (t == OVAL_TAG_TAB) {
        printf("table: 0x%08x", (uint32_t)v);
    } else if (t == OVAL_TAG_FUNC) {
        printf("function: 0x%08x", (uint32_t)v);
    } else {
        printf("<val 0x%016llx>", (unsigned long long)v);
    }
}

/** print 的一格实参：last != 0 时收尾换行，否则打制表符 */
void omni_val_write(OVal v, int32_t last) {
    oval_write(v);
    printf(last ? "\n" : "\t");
}

void omni_val_print(OVal v) { omni_val_write(v, 1); }

/* ---- 布局的钉子 ----
 *
 * 发射器（src/core/ir/emit-mlir.js 的 LAYOUT）把这些偏移量写死在生成的 MLIR 里，
 * 因为内联缓存的快路是**直接发指令**的，不经运行时函数。
 * 两边对不上就是**静默的错答案**（读错字段），所以在这儿钉住 ——
 * 改了结构体而没改 LAYOUT，是编译错误，不是运行时惊喜。
 */
_Static_assert(sizeof(OVal) == 8, "OVal 必须是 8 字节");
_Static_assert(offsetof(OTab, meta) == 32, "LAYOUT.tabMeta 要跟着改");
_Static_assert(offsetof(OTab, shape) == 40, "LAYOUT.tabShape 要跟着改");
_Static_assert(offsetof(OTab, svals) == 48, "LAYOUT.tabSvals 要跟着改");
_Static_assert(sizeof(OIC) == 32, "LAYOUT.icSize 要跟着改");
_Static_assert(offsetof(OIC, shape) == 0, "LAYOUT.icShape 要跟着改");
_Static_assert(offsetof(OIC, meta) == 8, "LAYOUT.icMeta 要跟着改");
_Static_assert(offsetof(OIC, holder) == 16, "LAYOUT.icHolder 要跟着改");
_Static_assert(offsetof(OIC, off) == 24, "LAYOUT.icOff 要跟着改");
_Static_assert(offsetof(OIC, gen) == 28, "LAYOUT.icGen 要跟着改");

#endif // OMNI_LUA_RT_H
