/* src/core/lua/vm.c —— **Tier 0：字节码解释器**（照 Ignition 的形状）
 *
 * 值、表、形状、内联缓存、串驻留、arena —— 全部复用 lua-rt.h（那一份是量出来的）。
 * 这儿只加三样：字节码的装载、寄存器帧、派发循环。
 *
 * 派发用 computed goto（`&&L_xxx` 那一族）：一条指令末尾直接跳下一条的标签，
 * 省掉"回到 switch 顶上再跳"那一次分支预测失败。这是解释器唯一值得先做的优化 ——
 * 别的（超指令、内联缓存）都等 Tier 1 的机器码。
 *
 * Tier 0 的判据**不是快，是跑对**：与 luajit 的输出逐字节相同。
 */
#include "../ir/lua-rt.h"
#include "bc-defs.h"

/* ---- 函数原型（递归：常量池里可以有子 Proto） ---- */

typedef struct OmniFn {
    OVal *K;
    struct OmniFn **subs;
    uint32_t nK, nSub;
    uint32_t nparams, nreg, nfb;
    uint32_t isVararg;
    int32_t icBase;
    uint8_t *code;
    uint32_t codeLen;
    void *jitFn;          /* JitFn cache: NULL = not tried, (void*)1 = tried & failed */
    uint32_t ncalls;      /* 调用计数 —— 分层的触发器（照 HotSpot/v8：热了才编） */
    uint32_t nloop;       /* 回边计数 —— 只跑一次的函数（主 chunk）靠它升层（OSR） */
    uint8_t osrTried;     /* OSR 只做一次 */
} OmniFn;

/* ---- 调用帧 ----
 *
 * 寄存器 R 是快格（LdaR / StaR 一条 load/store 就完）。**被内层闭包捕获的局部量**在
 * Closure 指令的那一刻从 R 升格到堆上的 cell（arena 分配的 OVal *）。R[idx] 在升格后
 * 不再使用 —— 但不需要改 R[idx] 的读写，因为 Closure 只在函数体的最后几条指令里出现，
 * 被捕获的量在升格后只通过闭包的 upvalue 指针访问。
 *
 * 实际上这个简化假设对 lua 不成立（`local n=0; local function inc() n=n+1 end; n=42; inc()`
 * 要让 inc 看到 42）。所以真正的做法是：
 *   - 在 Closure 的 kind==0 捕获点，如果 R[idx] 还没有对应的 cell，就**分配一格 cell 并
 *     把 R[idx] 当前值搬进去**，同时把 cell 的地址记进 Frame.cells[idx]。
 *   - 以后所有对 R[idx] 的读写都要检查 cells[idx] 是否非空 —— 非空就走 cell。
 *
 * 更简单的办法（v8 的 Context）：编译期标出所有被捕获的量，进帧时就分配 env，用 LdaEnv/StaEnv。
 * 但那需要编译器的预扫。先用 cells[] 运行期升格，后面再改编译器。
 */

#define MAX_FRAMES 256

typedef struct {
    OmniFn *fn;
    OVal *R;
    uint8_t *retPc;
    OVal **upvals;        /* 本帧看见的 upvalue（格子指针表，NULL = 没捕获任何东西） */
    OVal **cells;         /* cells[idx] != NULL → R[idx] 已升格为 arena cell */
    uint32_t nreg;
    int32_t icBase;       /* 进帧前的 vm_ic_base */
} Frame;

/* 帧栈**每协程一份**（与帧 arena 同一个道理：协程 yield 之后它的帧还活着，
   跨协程退栈不是 LIFO）。只用一份全局的会这样错：协程停在半路时 frameN 还是高的，
   主线接着 push/pop，主线的 Ret 退出去的却是协程那一格 —— R/pc/cells 全串味，
   下一条 Call 就"call 一个串"。**以前主 chunk 总是被 JIT 编掉、不进这张表，把这个 bug 盖住了。** */
static Frame vm_main_frames[MAX_FRAMES];
static Frame *frames = vm_main_frames;
static int frameN = 0;

/* ---- cells[] 的"空表"共享页 ----
 *
 * 绝大多数帧从不需要 cells（只有内层闭包捕获局部量的那一格才要）。
 * 原来每帧 calloc 一份 cells 再 free —— method.lua 里 4 次调用/轮 × 200K 轮
 * = 80 万次多余的 calloc+free。
 *
 * 做法：没捕获的帧一律指向这一格**全 NULL 的共享表**。`cells[r]` 读出来是 NULL，
 * 快路一个分支都不多；真要升格时（L_Closure 的 kind==0）才当场 calloc 一份私有的。
 * 寄存器号是 u8，所以 256 格盖住所有可能的帧。
 */
static OVal *vm_nocells[256];   /* 静态零初始化，永远全 NULL —— 不许写 */

/** 这一帧要私有的 cells 了（第一次有闭包捕获）：从共享页换成自己的一份 */
static OVal **cells_make_private(OVal **cells, uint32_t nreg) {
    if (cells != vm_nocells) return cells;      /* 已经是私有的 */
    return (OVal **)calloc(nreg ? nreg : 1, sizeof(OVal *));
}

/** 出帧时还 cells：共享页不还 */
static void cells_release(OVal **cells) {
    if (cells != vm_nocells) free(cells);
}

/* ---- 帧寄存器 R[] 的栈式 arena ----
 *
 * 每帧 calloc/free 一份 R[] 是 VM 腿上最后一块明显的分配开销
 * （smallpt 里 Vec.new / Vec.__add 每秒几十万次调用）。
 *
 * 上一趟栈式 arena 崩过（SIGABRT：arena 指针喂给了 free()），根因是**只用了一份全局
 * arena**：协程 yield 之后它的帧还活着，跨协程的退栈就不是 LIFO 的。
 * 这一趟改成**每个协程一份自己的 arena**（主线程也算一份）—— 一个协程自己的帧一定
 * 是 LIFO 的，所以抬指针/落指针就够了。
 *
 * arena 满了不搬家（里头的指针全是活的），当场退回 malloc；还的时候按"在不在本
 * arena 的区间里"判断走哪条路。
 */
typedef struct FrameArena {
    OVal  *mem;
    size_t cap;    /* OVal 的格数 */
    size_t top;
} FrameArena;

#define FRAME_ARENA_CAP (1u << 16)   /* 512KB，够一般的递归深度；不够就退回 malloc */

static FrameArena  vm_main_arena;
static FrameArena *vm_arena = &vm_main_arena;

/** JIT 的"带守卫的直接调用"要传 `OVal ***cellsp`。被调方没有 kind==0 的闭包捕获时
    它只读不写，所以所有这类调用共用这一格常量就够了（不必每次在栈上留一格）。 */
static OVal **vm_nocells_holder = vm_nocells;

/** 开一帧的 R[]：只把 [from, n) 填 nil ——
 *  前面那几格马上要被实参盖掉，填了白填（采样里 memset_pattern16 占 7%）。 */
static OVal *frame_alloc_from(uint32_t n, uint32_t from) {
    FrameArena *ar = vm_arena;
    OVal *p;
    if (ar->mem == NULL) {
        ar->cap = FRAME_ARENA_CAP;
        ar->mem = (OVal *)malloc(ar->cap * sizeof(OVal));
        ar->top = 0;
    }
    if (ar->top + n <= ar->cap) {
        p = ar->mem + ar->top;
        ar->top += n;
    } else {
        p = (OVal *)malloc(n * sizeof(OVal));   /* 溢出：退回 malloc */
    }
    for (uint32_t i = from; i < n; i++) p[i] = oval_nil();
    return p;
}

/** 全填 nil 的那一档（顶层帧、协程入口这些没有实参可省的地方） */
static OVal *frame_alloc(uint32_t n) { return frame_alloc_from(n, 0); }


/** 还一帧的 R[]：在本 arena 里就落指针，否则 free */
static void frame_free(OVal *p, uint32_t n) {
    FrameArena *ar = vm_arena;
    if (ar->mem && p >= ar->mem && p < ar->mem + ar->cap) {
        ar->top = (size_t)(p - ar->mem);   /* 落回这一帧的起点（本协程内一定是 LIFO） */
        (void)n;
        return;
    }
    free(p);
}

/* ---- 装载 ---- */

static uint32_t rd32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static OmniFn *load_proto(const uint8_t *buf, size_t len, size_t *at) {
    OmniFn *fn = (OmniFn *)calloc(1, sizeof(OmniFn));
    fn->nK = rd32(buf + *at); *at += 4;
    fn->K = (OVal *)calloc(fn->nK ? fn->nK : 1, sizeof(OVal));
    fn->subs = (OmniFn **)calloc(fn->nK ? fn->nK : 1, sizeof(OmniFn *));
    fn->nSub = 0;
    for (uint32_t i = 0; i < fn->nK; i++) {
        uint8_t t = buf[(*at)++];
        if (t == 0) fn->K[i] = oval_nil();
        else if (t == 1) fn->K[i] = oval_false();
        else if (t == 2) fn->K[i] = oval_true();
        else if (t == 3) { double d; memcpy(&d, buf + *at, 8); *at += 8; fn->K[i] = oval_from_double(d); }
        else if (t == 4) {
            uint32_t n = rd32(buf + *at); *at += 4;
            fn->K[i] = omni_str_new((const char *)(buf + *at), (int32_t)n);
            *at += n;
        } else if (t == 5) {
            /* 子 Proto：递归装，K 里存一个标记（用 TAG_FUNC << 32 | subIdx） */
            OmniFn *sub = load_proto(buf, len, at);
            uint32_t si = fn->nSub;
            fn->subs[si] = sub;
            fn->nSub++;
            fn->K[i] = ((OVal)OVAL_TAG_FUNC << 32) | (OVal)si;
        } else { fprintf(stderr, "omni-vm: 常量池里有格不认的标记 %u\n", t); exit(1); }
    }
    fn->nparams = rd32(buf + *at); *at += 4;
    fn->isVararg = rd32(buf + *at); *at += 4;
    fn->nreg = rd32(buf + *at); *at += 4;
    fn->nfb = rd32(buf + *at); *at += 4;
    fn->codeLen = rd32(buf + *at); *at += 4;
    fn->code = (uint8_t *)malloc(fn->codeLen);
    memcpy(fn->code, buf + *at, fn->codeLen);
    *at += fn->codeLen;
    return fn;
}

static OmniFn *omni_bc_load(const uint8_t *buf, size_t len) {
    if (len < 8 || buf[0] != 'O' || buf[1] != 'L' || buf[2] != 'B' || buf[3] != 'C') {
        fprintf(stderr, "omni-vm: bad magic\n"); exit(1);
    }
    size_t at = 8;
    return load_proto(buf, len, &at);
}

/** 走一遍 proto 树，给每个 proto 切一段独占的反馈槽；回总数 */
static int32_t assign_ic_bases(OmniFn *fn, int32_t next) {
    fn->icBase = next;
    next += (int32_t)fn->nfb;
    for (uint32_t i = 0; i < fn->nSub; i++) next = assign_ic_bases(fn->subs[i], next);
    return next;
}

/* ---- 闭包值的表示 ----
 *
 * 一格闭包 = OmniFn * + upvalue 表（OVal ** —— 每格指向一个格子，
 * 格子由 omni_cell_new 分配、直到 GC 才回收）。
 * 与 AOT 腿的 OClo 同一个 payload（函数指针换成 OmniFn *，运行时的 clo_fp / clo_env
 * 不经过 —— 调用在解释器循环里自己做），于是**闭包值的 tag 也是 OVAL_TAG_FUNC**。
 *
 * 怎么区分 AOT 的 OClo 和我们的 BCClo：看 kind 字段。这一版只有解释器，没有 AOT
 * 闭包，所以 kind 判断暂时不需要 —— 以后两条腿共存时再加。
 */
typedef struct {
    OmniFn *fn;
    uint32_t nup;
    OVal **up;       /* 每格指向一个格子（OVal *） */
    /* fn == NULL 表示这是一个 native 内建函数 */
    OVal (*native)(OVal *args, uint8_t argc);
    void *ctx;       /* 协程 step 等需要携带的上下文 */
} BCClo;

static OVal bcclo_new(OmniFn *fn, uint32_t nup, OVal **up) {
    BCClo *c = (BCClo *)omni_alloc(sizeof(BCClo));
    c->fn = fn; c->nup = nup; c->native = NULL; c->ctx = NULL;
    if (nup > 0) {
        c->up = (OVal **)omni_alloc((size_t)nup * sizeof(OVal *));
        memcpy(c->up, up, (size_t)nup * sizeof(OVal *));
    } else c->up = NULL;
    return ((OVal)OVAL_TAG_FUNC << 32) | omni_obj_reg(c);
}

static OVal bcclo_native(OVal (*native)(OVal *, uint8_t)) {
    BCClo *c = (BCClo *)omni_alloc(sizeof(BCClo));
    c->fn = NULL; c->nup = 0; c->up = NULL; c->native = native; c->ctx = NULL;
    return ((OVal)OVAL_TAG_FUNC << 32) | omni_obj_reg(c);
}

static OVal bcclo_native_ctx(OVal (*native)(OVal *, uint8_t), void *ctx) {
    BCClo *c = (BCClo *)omni_alloc(sizeof(BCClo));
    c->fn = NULL; c->nup = 0; c->up = NULL; c->native = native; c->ctx = ctx;
    return ((OVal)OVAL_TAG_FUNC << 32) | omni_obj_reg(c);
}

static BCClo *bcclo_get(OVal v) { return (BCClo *)omni_obj_at((uint32_t)v); }

/* ---- 全局 IC 表 ---- */
static OIC *vm_ics = NULL;
static int32_t vm_ics_n = 0;
static int32_t vm_ic_base = 0;       /* 当前帧的反馈槽起始偏移 */

static void vm_ic_ensure(int32_t total) {
    if (total <= vm_ics_n) return;
    vm_ics = (OIC *)realloc(vm_ics, (size_t)total * sizeof(OIC));
    memset(vm_ics + vm_ics_n, 0, (size_t)(total - vm_ics_n) * sizeof(OIC));
    vm_ics_n = total;
    omni_ics = vm_ics;
    *omni_ics_p = vm_ics;
}

/* ---- 调用点反馈（我们这边的 findHotConcreteFunctionCallee）----
   Go 的 PGO 去虚化要先知道"这个调用点主要打到哪个具体函数"。我们不需要 profile 文件：
   每个 Call 点本来就有自己一格反馈槽（emit-bc 里 p.fb() 编号，与属性 IC 同一张表、
   一格只归一个点用），把见过的被调方记在里头就是。
     shape  = 见过的那个 OmniFn*（借这个字段存指针；proto 终身不释放，不需要 gen 失效）
     holder = 见过的那个**闭包值**（OVal）—— 守卫比的是它，不是 proto：
              同一个 proto 的两个闭包 upvalue 数组不同，比闭包值才能把 upvalue 当编译期常量。
     off    = 状态：0 没见过、1 单态、2 多态/含 native（Tier 2 直接跳过）
   Tier 2 只对 off==1 的点发"比较闭包值的守卫 + 内联体"，不中就落回 jit_call_helper。 */
#define CALLSITE_NONE 0
#define CALLSITE_MONO 1
#define CALLSITE_POLY 2
#define ARITH_NUM     3   /* 算术点只见过"数 op 数" —— Tier 1 据此发不装箱的浮点串 */

static void call_site_record(int32_t slot, OmniFn *callee, OVal fv) {
    OIC *ic = &omni_ics[slot];
    if (ic->off == CALLSITE_MONO) {
        if (ic->holder != fv) ic->off = CALLSITE_POLY;
        return;
    }
    if (ic->off == CALLSITE_NONE) {
        ic->shape = (OShape *)callee; ic->holder = fv; ic->off = CALLSITE_MONO;
    }
}

/* ---- 算术点的元方法反馈（与调用点那一格同一套想法）----
   `a + b` 落在表上时走的是 __add 那条链：取元表 → 查处理函数 → 开帧 → 调。
   把"受方的形状/元表 + 查到的处理函数"记在这个算术点的反馈槽里，
   JIT 就能在这一点发"守卫 + 内联处理函数体"，整条链一次跳过。
     shape/meta/gen = 受方当初的形状与元表（守卫就比这两样）
     holder = 查到的处理函数闭包值
     off    = 1 单态 / 2 多态（受方不是表、或换过形状/处理函数）*/
static void arith_site_record(int32_t slot, OVal recv, OVal h) {
    if (slot < 0 || slot >= vm_ics_n) return;
    OIC *ic = &omni_ics[slot];
    if (ic->off == CALLSITE_POLY) return;
    if (ic->off == ARITH_NUM) { ic->off = CALLSITE_POLY; return; }  /* 数与表混着来 */
    if (oval_tag(recv) != OVAL_TAG_TAB) { ic->off = CALLSITE_POLY; return; }
    OTab *t = (OTab *)omni_objs[(uint32_t)recv];
    if (ic->off == CALLSITE_MONO) {
        if (ic->shape != t->shape || ic->meta != t->meta || ic->holder != h
            || ic->gen != omni_shape_gen) ic->off = CALLSITE_POLY;
        return;
    }
    if (t->shape == NULL) { ic->off = CALLSITE_POLY; return; }
    ic->shape = t->shape; ic->meta = t->meta; ic->holder = h;
    ic->gen = omni_shape_gen; ic->off = CALLSITE_MONO;
}

/** 这个算术点只见过"数 op 数"吗（Tier 1 的浮点串就靠它） */
static int arith_site_is_num(int32_t slot) {
    if (slot < 0 || slot >= vm_ics_n) return 0;
    return omni_ics[slot].off == ARITH_NUM;
}

/** 单态就回 1 并给出守卫要的三样 + 处理函数 */
static int arith_site_mono(int32_t slot, OShape **shapeOut, OVal *metaOut, OVal *hOut) {
    if (slot < 0 || slot >= vm_ics_n) return 0;
    OIC *ic = &omni_ics[slot];
    if (ic->off != CALLSITE_MONO || ic->shape == NULL || ic->gen != omni_shape_gen) return 0;
    *shapeOut = ic->shape; *metaOut = ic->meta; *hOut = ic->holder;
    return 1;
}

/** 单态就返回那个被调方（并给出闭包值），否则 NULL。Tier 1/2 去虚化的入口。 */
static OmniFn *call_site_mono(int32_t slot, OVal *fvOut) {
    if (slot < 0 || slot >= vm_ics_n) return NULL;
    OIC *ic = &omni_ics[slot];
    if (ic->off != CALLSITE_MONO) return NULL;
    if (fvOut) *fvOut = ic->holder;
    return (OmniFn *)ic->shape;
}

static OVal G = 0;

/* forward declaration */
static OVal omni_bc_call_inner(OmniFn *fn, OVal *R, OVal **cells, OVal **upvals);

/** 这条指令占几个字节 —— **Closure 是变长的**（后面跟 nup×2 字节的 upvalue 描述），
 *  omni_op_len 那张表只记了固定部分。凡是"顺着字节码往前走"的地方都必须用这个，
 *  不然一遇到带 upvalue 的 Closure 就错位（ASAN 在 queens 上抓到过一次：
 *  错位之后 LdaK 的 k 读成 1270，fn->K[1270] 越界）。 */
static inline uint32_t omni_bc_len_at(const uint8_t *code, uint32_t pc) {
    uint8_t op = code[pc];
    if (op == OP_Closure) return 4u + 2u * (uint32_t)code[pc + 3];
    return omni_op_len[op];
}

/* ---- 分层的触发器 ----
 * 解释器里数调用次数，够热才编。为什么不是一进来就编：**Tier 2 的类型来自反馈槽**，
 * 得先让解释器跑一会儿把 IC 填上，编出来的码才敢按"就是数 / 就是这个形状"发。
 * 这也是 VM-JIT 到 AOT 那条光谱上"什么时候往前走一格"的判据。 */
/* 第三个参数是**指向调用方那格 cells 变量的指针**：JIT 里的 Closure 要升格
   （从共享空页换成私有数组）时就地改写它，调用方原来那句 cells_release 也就还得对，
   不会漏。x24 专门存它（callee-saved，跨 C 调用不丢）。 */
typedef OVal (*JitFn)(OVal *R, OVal *K, OVal ***cellsp, int64_t icBase, OVal **up, OVal acc0);
static JitFn jit_compile_at(OmniFn *fn, uint32_t startPc);
static JitFn jit_compile(OmniFn *fn);
#define OMNI_JIT_HOT 64
#define OMNI_JIT_OSR 512     /* 回边计数阈值：够这个数就地升层（主 chunk 靠它） */

/* ---- VM 层的元方法分派 ----
 *
 * lua-rt.h 的 omni_meta_arith 假定闭包是 OClo（有 fp 函数指针 + arity），
 * 但 VM 里的闭包是 BCClo（有 OmniFn* 或 native）。碰到 BCClo 的元方法，
 * 必须走解释器的 Call 路径或 native 路径，不能走 OClo 的函数指针。
 *
 * 做法：重写元方法的分派。在 VM 内部，取到元方法闭包后，
 * 如果是 BCClo 就用我们自己的调用；否则 fallback 到 omni_meta_arith（不应该出现）。
 */

static const char *mm_names[] = {
    "__add", "__sub", "__mul", "__div", "__mod", "__pow", "__concat", "__neg"
};

static OVal vm_meta_call2(OVal fv, OVal a, OVal b);

/* 诊断：元方法算术是从哪些算术点来的（OMNI_JIT_DEBUG 时在出口打印前 8 名） */
static uint32_t ma_cnt[4096];
static uint64_t ma_total = 0;
static OVal vm_meta_arith(OVal a, OVal b, int op, int32_t slot) {
    if (slot >= 0 && slot < 4096) ma_cnt[slot]++;
    ma_total++;
    /* 取接收者的元表（a 没有就看 b —— lua 的规矩） */
    OVal mt = oval_nil();
    if (oval_tag(a) == OVAL_TAG_TAB) mt = ((OTab *)omni_objs[(uint32_t)a])->meta;
    if (!oval_is_tab(mt) && oval_tag(b) == OVAL_TAG_TAB) mt = ((OTab *)omni_objs[(uint32_t)b])->meta;
    if (!oval_is_tab(mt)) {
        fprintf(stderr, "omni-vm: attempt to perform arithmetic on a non-number value (op %d)\n", op);
        exit(1);
    }
    /* 名字只造一次（原来每次算子都 omni_str_new + strlen —— 采样里 omni_str_new 3%），
       而且**按元表缓存查到的处理函数**：smallpt 这种"全靠 __add/__mul"的形状里，
       同一张元表反复问同一个键，哈希查找本身是纯浪费（tab_get_raw 3%）。
       失效判据与属性 IC 同一套：元表还是那张 + omni_shape_gen 没变。 */
    static OVal mm_keys[8];
    static int mm_keys_ready = 0;
    if (!mm_keys_ready) {
        for (int i = 0; i < 8; i++)
            mm_keys[i] = omni_str_new(mm_names[i], (int32_t)strlen(mm_names[i]));
        mm_keys_ready = 1;
    }
    int oi = (op >= 0 && op < 8) ? op : 0;
    static OVal mm_cacheMt[8], mm_cacheH[8];
    static uint32_t mm_cacheGen[8];
    OVal h;
    if (mm_cacheMt[oi] == mt && mm_cacheGen[oi] == omni_shape_gen) {
        h = mm_cacheH[oi];
    } else {
        h = omni_tab_get(mt, mm_keys[oi]);
        mm_cacheMt[oi] = mt; mm_cacheH[oi] = h; mm_cacheGen[oi] = omni_shape_gen;
    }
    if (oval_is_nil(h)) {
        fprintf(stderr, "omni-vm: no metamethod '%s'\n", mm_names[oi]);
        exit(1);
    }
    arith_site_record(slot, a, h);
    return vm_meta_call2(h, a, b);
}

static OVal vm_meta_call2(OVal fv, OVal a, OVal b) {
    BCClo *clo = bcclo_get(fv);
    if (clo->native) {
        OVal args[2] = { a, b };
        return clo->native(args, 2);
    }
    /* 字节码闭包。**必须保存/恢复 vm_ic_base** —— 内层会改它。 */
    OmniFn *callee = clo->fn;
    int32_t savedIcBase = vm_ic_base;
    vm_ic_ensure(callee->icBase + (int32_t)callee->nfb);
    /* 元方法体也走分层 —— 这条路原来**永远是解释器**：smallpt 的向量算子全是
       `__add`/`__mul`，全从这儿进，采样里 omni_bc_call_inner 占 28%。
       判据与 L_Call 同一条（够热才编），编译要在 frame_alloc 之前（内联会抬 nreg）。 */
    if (callee->jitFn == NULL && ++callee->ncalls >= OMNI_JIT_HOT) {
        callee->jitFn = (void *)jit_compile(callee);
        if (callee->jitFn == NULL) callee->jitFn = (void *)(uintptr_t)1;
    }
    uint32_t nr = callee->nreg ? callee->nreg : 1;
    OVal *cR = frame_alloc(nr);
    OVal **cCells = vm_nocells;   /* 共享空表 */
    if (callee->nparams >= 1) cR[0] = a;
    if (callee->nparams >= 2) cR[1] = b;
    OVal result;
    if (callee->jitFn != NULL && callee->jitFn != (void *)(uintptr_t)1) {
        result = ((JitFn)callee->jitFn)(cR, callee->K, &cCells,
                                       (int64_t)callee->icBase, clo->up, oval_nil());
        frame_free(cR, nr);          /* 编译码不退帧，这儿退（解释器那条 L_Ret 自己退） */
        cells_release(cCells);
    } else {
        result = omni_bc_call_inner(callee, cR, cCells, clo->up);
    }
    vm_ic_base = savedIcBase;
    return result;
}

/* 把 omni_val_add 等走进 vm_meta_arith 而非 omni_meta_arith。
   `_fb` 那一族多带一个**反馈槽号**：慢路走到元方法时把"受方形状 + 处理函数"记下来，
   JIT 下一次编译这一点就能发"守卫 + 内联元方法体"。解释器与 JIT 都传得起（都有那个槽号）。 */
#define VM_VAL_ARITH(NAME, EXPR, OPC) \
static OVal NAME##_fb(OVal a, OVal b, int32_t slot) { \
    if (oval_is_num(a) && oval_is_num(b)) { \
        double x = oval_to_double(a), y = oval_to_double(b); (void)x; (void)y; \
        return oval_from_double(EXPR); \
    } \
    return vm_meta_arith(a, b, OPC, slot); \
} \
static OVal NAME(OVal a, OVal b) { return NAME##_fb(a, b, -1); }

VM_VAL_ARITH(vm_val_add, x + y, OMNI_OP_ADD)
VM_VAL_ARITH(vm_val_sub, x - y, OMNI_OP_SUB)
VM_VAL_ARITH(vm_val_mul, x * y, OMNI_OP_MUL)
VM_VAL_ARITH(vm_val_div, x / y, OMNI_OP_DIV)
VM_VAL_ARITH(vm_val_mod, x - floor(x / y) * y, OMNI_OP_MOD)
#undef VM_VAL_ARITH

/* ---- 内建函数 ---- */

static OVal nat_setmetatable(OVal *a, uint8_t n) {
    (void)n; return omni_setmetatable(a[0], a[1]);
}
static OVal nat_math_sqrt(OVal *a, uint8_t n) { (void)n; return omni_math_sqrt(a[0]); }
static OVal nat_math_abs(OVal *a, uint8_t n) { (void)n; return omni_math_abs(a[0]); }
static OVal nat_math_sin(OVal *a, uint8_t n) { (void)n; return omni_math_sin(a[0]); }
static OVal nat_math_cos(OVal *a, uint8_t n) { (void)n; return omni_math_cos(a[0]); }
static OVal nat_math_floor(OVal *a, uint8_t n) { (void)n; return omni_math_floor(a[0]); }
static OVal nat_math_ceil(OVal *a, uint8_t n) { (void)n; return omni_math_ceil(a[0]); }
static OVal nat_math_max(OVal *a, uint8_t n) { (void)n; return omni_math_max(a[0], a[1]); }
static OVal nat_math_min(OVal *a, uint8_t n) { (void)n; return omni_math_min(a[0], a[1]); }
static OVal nat_ipairs_next(OVal *a, uint8_t n) {
    (void)n;
    OVal t = a[0];
    double i = oval_to_double(a[1]) + 1;
    OVal v = omni_tab_get(t, oval_from_double(i));
    if (oval_is_nil(v)) return oval_nil();
    return oval_from_double(i);
}
static OVal nat_ipairs(OVal *a, uint8_t n) {
    (void)n;
    return bcclo_native(nat_ipairs_next);
}
static OVal nat_math_exp(OVal *a, uint8_t n) { (void)n; return omni_math_exp(a[0]); }
static OVal nat_math_log(OVal *a, uint8_t n) { (void)n; return omni_math_log(a[0]); }

/* ---- 协程 ---- */

typedef struct BCCoro {
    void *sp, *caller_sp;
    char *stack;
    int done;
    OVal xfer;            /* yield 传出的值 */
    OVal fn;              /* 协程体（BCClo 的 OVal） */
    FrameArena arena;     /* 这个协程自己的帧 arena —— 它的帧只有它自己会退 */
    Frame *frames;        /* 同理，帧栈也得每协程一份 */
    int frameN;
    int32_t icBase;       /* 它停在哪一帧，那一帧的反馈基址 —— 见 bc_coro_resume 的注释 */
} BCCoro;

static BCCoro *bc_cur_coro = NULL;

/** 协程体的入口跳板（从栈切换后落到这儿） */
void bc_coro_main(BCCoro *co) {
    /* 调协程体——一个无参数的字节码闭包 */
    BCClo *clo = bcclo_get(co->fn);
    if (clo->native) {
        /* 不太可能，但兜底 */
        clo->native(NULL, 0);
    } else {
        OmniFn *callee = clo->fn;
        uint32_t nr = callee->nreg ? callee->nreg : 1;
        OVal *cR = frame_alloc(nr);
        OVal **cCells = vm_nocells;   /* 共享空表 */
        omni_bc_call_inner(callee, cR, cCells, clo->up);
    }
    co->done = 1;
    co->xfer = oval_nil();
    omni_ctx_sw(&co->sp, co->caller_sp);
    __builtin_trap();
}

extern void bc_coro_entry(void);
__asm__(
".text\n"
".p2align 2\n"
".globl _bc_coro_entry\n"
"_bc_coro_entry:\n"
"  mov x0, x19\n"
"  bl _bc_coro_main\n"
"  brk #1\n"
);

static OVal bc_coro_resume(BCCoro *co) {
    if (co->done) return oval_nil();
    BCCoro *prev = bc_cur_coro;
    FrameArena *prevAr = vm_arena;
    Frame *prevFrames = frames;
    int prevFrameN = frameN;
    bc_cur_coro = co;
    vm_arena = &co->arena;      /* 切到协程自己的帧 arena */
    frames = co->frames;        /* 以及它自己的帧栈（停在上次 yield 的深度） */
    frameN = co->frameN;
    /* **vm_ic_base 也必须跟着切**（这条 bug 藏了很久，靠"主 chunk 总被 JIT 编掉"盖着）：
       协程是在半条帧里停下的，它那格 vm_ic_base 还留在全局变量里；主线接着跑，
       主线的 GetNamed/Add 就按**协程的** icBase 去写反馈槽 —— 写进协程那几格里。
       下一次协程用自己的 IC 时读回来的是主线的偏移，`coroutine.yield` 就取成了一个串。 */
    int32_t prevIc = vm_ic_base;
    vm_ic_base = co->icBase;
    omni_ctx_sw(&co->caller_sp, co->sp);
    co->icBase = vm_ic_base;
    vm_ic_base = prevIc;
    co->frameN = frameN;        /* 记住它停在哪儿 */
    bc_cur_coro = prev;
    vm_arena = prevAr;
    frames = prevFrames;
    frameN = prevFrameN;
    return co->xfer;
}

static OVal bc_coro_yield(OVal v) {
    BCCoro *co = bc_cur_coro;
    if (co == NULL) { fprintf(stderr, "omni-vm: yield outside a coroutine\n"); exit(1); }
    co->xfer = v;
    omni_ctx_sw(&co->sp, co->caller_sp);
    return oval_nil();
}

/** coro step: 每次调用 resume 一步。真正的调用走 L_Call 的 ctx 分支（见那儿）。 */
static OVal nat_coro_step(OVal *a, uint8_t n) {
    (void)a; (void)n;
    fprintf(stderr, "omni-vm: coro step 不该走到这儿（L_Call 的 ctx 分支才对）\n");
    exit(1);
}

/** `coroutine.wrap(fn)` 的 native 实现 */
static OVal nat_coro_wrap(OVal *a, uint8_t n) {
    (void)n;
    OVal fn = a[0];
    BCCoro *co = (BCCoro *)calloc(1, sizeof(BCCoro));
    co->fn = fn;
    co->xfer = oval_nil();
    co->stack = (char *)malloc(OMNI_CORO_STACK);
    co->frames = (Frame *)calloc(MAX_FRAMES, sizeof(Frame));
    co->frameN = 0;
    char *top = co->stack + OMNI_CORO_STACK;
    top = (char *)((uintptr_t)top & ~(uintptr_t)15);
    top -= 0xa0;
    memset(top, 0, 0xa0);
    ((uint64_t *)top)[0] = (uint64_t)(uintptr_t)co;                   // x19 槽
    ((uint64_t *)top)[11] = (uint64_t)(uintptr_t)bc_coro_entry;       // lr 槽
    co->sp = top;
    return bcclo_native_ctx(nat_coro_step, co);
}

/** `coroutine.yield(v)` */
static OVal nat_coro_yield(OVal *a, uint8_t n) {
    OVal v = n >= 1 ? a[0] : oval_nil();
    return bc_coro_yield(v);
}

static OVal nat_str_sub(OVal *a, uint8_t n) {
    OVal j = n >= 3 ? a[2] : oval_nil();
    return omni_str_sub(a[0], a[1], j);
}
static OVal nat_str_len(OVal *a, uint8_t n) { (void)n; return omni_val_len(a[0]); }

static OVal S_bc_strlib; static int S_bc_strlib_ok = 0;
static OVal bc_strlib(void) {
    if (!S_bc_strlib_ok) {
        S_bc_strlib = omni_tab_new();
        omni_tab_set(S_bc_strlib, omni_str_new("sub", 3), bcclo_native(nat_str_sub));
        omni_tab_set(S_bc_strlib, omni_str_new("len", 3), bcclo_native(nat_str_len));
        S_bc_strlib_ok = 1;
    }
    return S_bc_strlib;
}

static void install_builtins(void) {
    omni_tab_set(G, omni_str_new("setmetatable", 12), bcclo_native(nat_setmetatable));
    omni_tab_set(G, omni_str_new("ipairs", 6), bcclo_native(nat_ipairs));

    /* math 表 */
    OVal mt = omni_tab_new();
    omni_tab_set(mt, omni_str_new("sqrt", 4),  bcclo_native(nat_math_sqrt));
    omni_tab_set(mt, omni_str_new("abs", 3),   bcclo_native(nat_math_abs));
    omni_tab_set(mt, omni_str_new("sin", 3),   bcclo_native(nat_math_sin));
    omni_tab_set(mt, omni_str_new("cos", 3),   bcclo_native(nat_math_cos));
    omni_tab_set(mt, omni_str_new("floor", 5), bcclo_native(nat_math_floor));
    omni_tab_set(mt, omni_str_new("ceil", 4),  bcclo_native(nat_math_ceil));
    omni_tab_set(mt, omni_str_new("max", 3),   bcclo_native(nat_math_max));
    omni_tab_set(mt, omni_str_new("min", 3),   bcclo_native(nat_math_min));
    omni_tab_set(mt, omni_str_new("exp", 3),   bcclo_native(nat_math_exp));
    omni_tab_set(mt, omni_str_new("log", 3),   bcclo_native(nat_math_log));
    omni_tab_set(mt, omni_str_new("pi", 2),    oval_from_double(3.14159265358979323846));
    omni_tab_set(mt, omni_str_new("huge", 4),  oval_from_double(1.0/0.0));
    omni_tab_set(G, omni_str_new("math", 4), mt);

    /* coroutine 表 */
    OVal ct = omni_tab_new();
    omni_tab_set(ct, omni_str_new("wrap", 4), bcclo_native(nat_coro_wrap));
    omni_tab_set(ct, omni_str_new("yield", 5), bcclo_native(nat_coro_yield));
    omni_tab_set(G, omni_str_new("coroutine", 9), ct);
}

/* ---- 派发 ---- */

#define RD_U8()   (*pc++)
#define RD_U16()  (pc += 2, (uint16_t)(pc[-2] | (pc[-1] << 8)))
#define RD_I32()  (pc += 4, (int32_t)((uint32_t)pc[-4] | ((uint32_t)pc[-3] << 8) \
                                    | ((uint32_t)pc[-2] << 16) | ((uint32_t)pc[-1] << 24)))

#define DISPATCH() goto *disp[*pc++]

/**
 * 解释器主循环。**可重入** —— 元方法（`__add` 那一族）落在字节码闭包上时，
 * 从 vm_meta_call2 递归进来。`baseFrame` 记住进来时的帧深度，
 * L_Ret 退到这一格就交出 acc（而不是一路退到 0）。
 */
static OVal omni_bc_call_inner(OmniFn *topFn, OVal *R0, OVal **cells0, OVal **up0) {
    static const void *disp[OP__COUNT] = {
#define OPL(name) [OP_##name] = &&L_##name
        OPL(LdaNil), OPL(LdaTrue), OPL(LdaFalse), OPL(LdaK), OPL(LdaR), OPL(StaR), OPL(Mov),
        OPL(LdaGlobal), OPL(StaGlobal), OPL(LdaUp), OPL(StaUp),
        OPL(LdaEnv), OPL(StaEnv),
        OPL(Add), OPL(Sub), OPL(Mul), OPL(Div), OPL(Mod), OPL(Pow), OPL(Concat),
        OPL(Neg), OPL(Not), OPL(Len),
        OPL(Eq), OPL(Ne), OPL(Lt), OPL(Le), OPL(Gt), OPL(Ge),
        OPL(NewTable), OPL(NewShaped), OPL(GetNamed), OPL(SetNamed), OPL(GetKeyed), OPL(SetKeyed), OPL(SetMeta),
        OPL(Call), OPL(CallMethod), OPL(CallBuiltin), OPL(Ret), OPL(RetMulti),
        OPL(Jump), OPL(JumpIfTrue), OPL(JumpIfFalse), OPL(JumpIfNil), OPL(JumpLoop),
        OPL(ForPrep), OPL(ForLoop), OPL(Closure), OPL(GetFields),
        OPL(Print), OPL(Nop), OPL(VarargTable),
        /* ⚠️ 加了新字节码就必须在这张表里补一格 —— 漏了的话那一格是 NULL，
              `goto *NULL` 直接跳零页（ASAN 报 "pc points to the zero page"）。踩过一次。 */
#undef OPL
    };

    const int baseFrame = frameN;

    /* 当前帧的活状态 */
    OmniFn *fn = topFn;
    uint32_t curNreg = fn->nreg ? fn->nreg : 1;
    OVal *R = R0;
    OVal **cells = cells0;
    OVal acc = oval_nil();
    OVal *K = fn->K;
    uint8_t *pc = fn->code;
    OVal **curUp = up0;

    vm_ic_ensure((int32_t)(fn->nfb ? fn->nfb : 1));
    vm_ic_base = fn->icBase;

    DISPATCH();

L_LdaNil:   acc = oval_nil();   DISPATCH();
L_LdaTrue:  acc = oval_true();  DISPATCH();
L_LdaFalse: acc = oval_false(); DISPATCH();
L_LdaK:     { uint16_t k = RD_U16(); acc = K[k]; DISPATCH(); }
L_LdaR:     { uint8_t r = RD_U8(); acc = cells[r] ? *cells[r] : R[r]; DISPATCH(); }
L_StaR:     { uint8_t r = RD_U8(); if (cells[r]) *cells[r] = acc; else R[r] = acc; DISPATCH(); }
L_Mov:      { uint8_t a = RD_U8(), b = RD_U8(); R[b] = R[a]; DISPATCH(); }

/* 全局读写也走内联缓存：全局表就是一张普通表，键是串、有形状 ——
   原来每次读一个全局都是一次哈希查找（smallpt 里 `Vec`/`setmetatable`/`radiance` 都在热路上）。 */
L_LdaGlobal: { uint16_t k = RD_U16(); uint16_t f = RD_U16();
               acc = omni_tab_get_ic(G, K[k], vm_ic_base + (int32_t)f); DISPATCH(); }
L_StaGlobal: { uint16_t k = RD_U16(); uint16_t f = RD_U16();
               omni_tab_set_ic(G, K[k], acc, vm_ic_base + (int32_t)f); DISPATCH(); }
L_LdaUp:    { uint8_t i = RD_U8(); acc = *curUp[i]; DISPATCH(); }
L_StaUp:    { uint8_t i = RD_U8(); *curUp[i] = acc; DISPATCH(); }
L_LdaEnv:   { uint8_t i = RD_U8(); acc = omni_extra_slot[i]; DISPATCH(); }
L_StaEnv:   { (void)RD_U8(); DISPATCH(); }     /* TODO */

/* 算术 */
#define BIN(NAME, EXPR, SLOW) \
L_##NAME: { uint8_t r = RD_U8(); uint16_t fb = RD_U16(); \
    OVal x = cells[r] ? *cells[r] : R[r]; \
    if (oval_is_num(x) && oval_is_num(acc)) { \
        double a = oval_to_double(x), b = oval_to_double(acc); \
        acc = oval_from_double(EXPR); \
        /* 反馈：这个点只见过数（只有解释器记这一笔，JIT 的快路不写内存） */ \
        { OIC *aic = &omni_ics[vm_ic_base + (int32_t)fb]; \
          if (aic->off == CALLSITE_NONE) aic->off = ARITH_NUM; } \
    } else acc = SLOW##_fb(x, acc, vm_ic_base + (int32_t)fb); \
    DISPATCH(); }
    BIN(Add, a + b, vm_val_add)
    BIN(Sub, a - b, vm_val_sub)
    BIN(Mul, a * b, vm_val_mul)
    BIN(Div, a / b, vm_val_div)
#undef BIN
L_Mod: { uint8_t r = RD_U8(); uint16_t fb = RD_U16();
    acc = vm_val_mod_fb(R[r], acc, vm_ic_base + (int32_t)fb); DISPATCH(); }
L_Pow: { uint8_t r = RD_U8(); (void)RD_U16(); acc = omni_val_pow(R[r], acc); DISPATCH(); }
L_Concat: { uint8_t r = RD_U8(); (void)RD_U16(); acc = omni_val_concat(R[r], acc); DISPATCH(); }
L_Neg: { (void)RD_U16(); acc = omni_val_neg(acc); DISPATCH(); }
L_Not: { acc = omni_val_not(acc); DISPATCH(); }
L_Len: { (void)RD_U16(); acc = omni_val_len(acc); DISPATCH(); }

#define CMP(NAME, COND, SLOWEXPR) \
L_##NAME: { uint8_t r = RD_U8(); (void)RD_U16(); \
    OVal x = cells[r] ? *cells[r] : R[r]; \
    if (oval_is_num(x) && oval_is_num(acc)) { \
        double a = oval_to_double(x), b = oval_to_double(acc); \
        acc = (COND) ? oval_true() : oval_false(); \
    } else acc = (SLOWEXPR); \
    DISPATCH(); }
    CMP(Eq, a == b, omni_val_eq(x, acc))
    CMP(Ne, a != b, omni_val_not(omni_val_eq(x, acc)))
    CMP(Lt, a < b,  omni_val_lt(x, acc))
    CMP(Le, a <= b, omni_val_le(x, acc))
    CMP(Gt, a > b,  omni_val_lt(acc, x))
    CMP(Ge, a >= b, omni_val_le(acc, x))
#undef CMP

L_NewTable: { (void)RD_U8(); acc = omni_tab_new(); DISPATCH(); }
L_NewShaped: { uint16_t k = RD_U16(); uint8_t base = RD_U8(), n = RD_U8(); uint16_t f = RD_U16();
              /* 一次分配、形状只求一次。形状指针借**这一格反馈槽的 shape 字段**存
                 （每个构造点一格，与 IC 同一套生命周期：omni_shape_gen 变了就重求）。 */
              OIC *sic = &omni_ics[vm_ic_base + (int32_t)f];
              OVal vals[16];
              for (uint8_t i = 0; i < n && i < 16; i++) vals[i] = cells[base+i] ? *cells[base+i] : R[base+i];
              void *slot = (sic->gen == omni_shape_gen) ? (void *)sic->shape : NULL;
              acc = omni_tab_new_shaped(&slot, &K[k], vals, (int32_t)n);
              sic->shape = (OShape *)slot; sic->gen = omni_shape_gen;
              DISPATCH(); }
L_GetNamed: { uint8_t r = RD_U8(); uint16_t k = RD_U16(); uint16_t f = RD_U16();
              OVal tv = cells[r] ? *cells[r] : R[r];
              if (oval_tag(tv) == OVAL_TAG_TAB) {
                  acc = omni_tab_get_ic(tv, K[k], vm_ic_base + (int32_t)f);
              } else if (oval_tag(tv) == OVAL_TAG_STR) {
                  acc = omni_tab_get(bc_strlib(), K[k]);
              } else {
                  acc = oval_nil();
              }
              DISPATCH(); }
L_SetNamed: { uint8_t r = RD_U8(); uint16_t k = RD_U16(); uint16_t f = RD_U16();
              OVal tv = cells[r] ? *cells[r] : R[r];
              omni_tab_set_ic(tv, K[k], acc, vm_ic_base + (int32_t)f); DISPATCH(); }
L_GetFields: { uint8_t r = RD_U8(); uint16_t k = RD_U16(); uint8_t dst = RD_U8(), n = RD_U8();
              uint16_t f = RD_U16();
              OVal tv = cells[r] ? *cells[r] : R[r];
              OVal tmp[16];
              if (n > 16) n = 16;
              omni_tab_getn_ic(tv, &K[k], (int32_t)n, vm_ic_base + (int32_t)f, tmp);
              for (uint8_t i = 0; i < n; i++) {
                  if (cells[dst+i]) *cells[dst+i] = tmp[i]; else R[dst+i] = tmp[i];
              }
              DISPATCH(); }
L_GetKeyed: { uint8_t a = RD_U8(), b = RD_U8(); (void)RD_U16();
              OVal ta = cells[a] ? *cells[a] : R[a];
              OVal tb2 = cells[b] ? *cells[b] : R[b];
              acc = omni_tab_get(ta, tb2); DISPATCH(); }
L_SetKeyed: { uint8_t a = RD_U8(), b = RD_U8(); (void)RD_U16();
              OVal ta = cells[a] ? *cells[a] : R[a];
              OVal tb2 = cells[b] ? *cells[b] : R[b];
              omni_tab_set(ta, tb2, acc); DISPATCH(); }
L_SetMeta: { uint8_t r = RD_U8(); acc = omni_setmetatable(R[r], acc); DISPATCH(); }

/* ---- Call：开新帧 ---- */
L_Call: {
    uint8_t base = RD_U8();
    uint8_t argc = RD_U8();
    uint16_t cf = RD_U16();   /* 调用点反馈槽 */
    OVal fv = R[base];
    if (!oval_is_fn(fv)) {
        fprintf(stderr, "omni-vm: attempt to call a non-function (base=%u tag=%u val=0x%llx pc=%u fn=%p codeLen=%u frameN=%d)\n",
                base, oval_tag(fv), (unsigned long long)fv,
                (uint32_t)(pc - fn->code), (void *)fn, fn->codeLen, frameN);
        exit(1);
    }
    BCClo *clo = bcclo_get(fv);
    if (clo->native) {
        /* native 混进来的点不做去虚化 */
        omni_ics[vm_ic_base + (int32_t)cf].off = CALLSITE_POLY;
        /* 内建 native 函数：直接调，不开新帧 */
        OVal args[16];
        for (uint8_t i = 0; i < argc && i < 16; i++) args[i] = R[base + 1 + i];
        /* 对有 ctx 的 native（如协程 step），保存当前 BCClo 供它取上下文 */
        if (clo->ctx) {
            BCCoro *co = (BCCoro *)clo->ctx;
            acc = bc_coro_resume(co);
        } else {
            acc = clo->native(args, argc);
        }
        DISPATCH();
    }
    OmniFn *callee = clo->fn;
    call_site_record(vm_ic_base + (int32_t)cf, callee, fv);
    /* 够热就编，编出来的当 native 那样直接调（不进解释器的帧栈） */
    if (callee->jitFn == NULL && ++callee->ncalls >= OMNI_JIT_HOT) {
        callee->jitFn = (void *)jit_compile(callee);
        if (callee->jitFn == NULL) callee->jitFn = (void *)(uintptr_t)1;
    }
    if (callee->jitFn != NULL && callee->jitFn != (void *)(uintptr_t)1) {
        uint32_t cnr = callee->nreg ? callee->nreg : 1;
        OVal *cR = frame_alloc_from(cnr, (uint32_t)(argc < callee->nparams ? argc : callee->nparams));
        for (uint8_t i = 0; i < argc && i < callee->nparams; i++) cR[i] = R[base + 1 + i];
        if (callee->isVararg) {
            if (argc > callee->nparams) {
                omni_extra_n = (int32_t)(argc - callee->nparams);
                if (omni_extra_n > OMNI_EXTRA_MAX) omni_extra_n = OMNI_EXTRA_MAX;
                for (int32_t i = 0; i < omni_extra_n; i++)
                    omni_extra_slot[i] = R[base + 1 + callee->nparams + i];
            } else omni_extra_n = 0;
        }
        int32_t savedIc = vm_ic_base;
        vm_ic_ensure(callee->icBase + (int32_t)callee->nfb);
        OVal **cCells = vm_nocells;
        acc = ((JitFn)callee->jitFn)(cR, callee->K, &cCells, (int64_t)callee->icBase, clo->up, oval_nil());
        frame_free(cR, cnr);
        cells_release(cCells);
        vm_ic_base = savedIc;
        DISPATCH();
    }
    if (frameN >= MAX_FRAMES) { fprintf(stderr, "omni-vm: stack overflow\n"); exit(1); }
    /* 保存当前帧 */
    frames[frameN].fn = fn;
    frames[frameN].R = R;
    frames[frameN].retPc = pc;
    frames[frameN].upvals = curUp;
    frames[frameN].cells = cells;
    frames[frameN].nreg = curNreg;
    frames[frameN].icBase = vm_ic_base;
    frameN++;
    /* 切到被调方 */
    fn = callee;
    K = fn->K;
    curNreg = fn->nreg ? fn->nreg : 1;
    R = frame_alloc_from(curNreg, (uint32_t)(argc < fn->nparams ? argc : fn->nparams));
    cells = vm_nocells;   /* 共享的全 NULL 表；真有捕获时 L_Closure 换成私有的 */
    /* 实参拷进新帧的 r0..r(argc-1) */
    for (uint8_t i = 0; i < argc && i < fn->nparams; i++) R[i] = frames[frameN - 1].R[base + 1 + i];
    /* 变长参数：超过 nparams 的实参放进 extra_slot */
    if (fn->isVararg && argc > fn->nparams) {
        omni_extra_n = (int32_t)(argc - fn->nparams);
        if (omni_extra_n > OMNI_EXTRA_MAX) omni_extra_n = OMNI_EXTRA_MAX;
        for (int32_t i = 0; i < omni_extra_n; i++)
            omni_extra_slot[i] = frames[frameN - 1].R[base + 1 + fn->nparams + i];
    } else if (fn->isVararg) {
        omni_extra_n = 0;
    }
    pc = fn->code;
    curUp = clo->up;
    /* 确保被调方的反馈槽也有地方 */
    vm_ic_base = callee->icBase;
    vm_ic_ensure(vm_ic_base + (int32_t)fn->nfb);
    DISPATCH();
}

L_CallMethod: { (void)RD_U8(); (void)RD_U16(); (void)RD_U8(); (void)RD_U16(); fprintf(stderr, "omni-vm: CallMethod TODO\n"); exit(1); }
L_CallBuiltin: { (void)RD_U8(); (void)RD_U8(); (void)RD_U8(); fprintf(stderr, "omni-vm: CallBuiltin TODO\n"); exit(1); }

/* ---- Ret：回到调用方 ---- */
L_Ret: {
    frame_free(R, curNreg);
    cells_release(cells);
    if (frameN == baseFrame) return acc;     /* 回到调用者 */
    frameN--;
    fn = frames[frameN].fn;
    R = frames[frameN].R;
    pc = frames[frameN].retPc;
    K = fn->K;
    curUp = frames[frameN].upvals;
    cells = frames[frameN].cells;
    curNreg = frames[frameN].nreg;
    vm_ic_base = frames[frameN].icBase;
    /* acc 已经是返回值（单返回值就在 acc 里，与 Ignition 同一个约定） */
    DISPATCH();
}
L_RetMulti: {
    uint8_t base = RD_U8(), n = RD_U8();
    /* 第一个返回值在 acc，后续放 extra slot */
    if (n >= 1) acc = cells[base] ? *cells[base] : R[base];
    for (uint8_t i = 1; i < n; i++) {
        OVal v = cells[base+i] ? *cells[base+i] : R[base+i];
        omni_extra_set((int32_t)(i - 1), v);
    }
    omni_extra_n = n > 1 ? (int32_t)(n - 1) : 0;
    frame_free(R, curNreg);
    cells_release(cells);
    if (frameN == baseFrame) return acc;
    frameN--;
    fn = frames[frameN].fn;
    R = frames[frameN].R;
    pc = frames[frameN].retPc;
    K = fn->K;
    curUp = frames[frameN].upvals;
    cells = frames[frameN].cells;
    curNreg = frames[frameN].nreg;
    vm_ic_base = frames[frameN].icBase;
    DISPATCH();
}

L_Jump: { int32_t j = RD_I32(); pc += j; DISPATCH(); }
L_JumpIfTrue: { int32_t j = RD_I32(); if (omni_val_truthy(acc)) pc += j; DISPATCH(); }
L_JumpIfFalse: { int32_t j = RD_I32(); if (!omni_val_truthy(acc)) pc += j; DISPATCH(); }
L_JumpIfNil: { int32_t j = RD_I32(); if (oval_is_nil(acc)) pc += j; DISPATCH(); }
L_JumpLoop: { int32_t j = RD_I32(); pc += j;
    /* 回边：数热度。只跑一次的函数（主 chunk 那一类）永远等不到"调用够热"，
       但它的循环可以热 —— 数够了就**在这儿升层**（OSR，见下面 L_OSR）。 */
    if (fn->jitFn == NULL && !fn->osrTried && ++fn->nloop >= OMNI_JIT_OSR) goto L_OSR;
    DISPATCH(); }

L_ForPrep: { uint8_t base = RD_U8(); int32_t j = RD_I32();
    double i = oval_to_double(R[base]), lim = oval_to_double(R[base + 1]), st = oval_to_double(R[base + 2]);
    if (st >= 0 ? (i > lim) : (i < lim)) pc += j;
    DISPATCH(); }
L_ForLoop: { uint8_t base = RD_U8(); int32_t j = RD_I32();
    double i = oval_to_double(R[base]) + oval_to_double(R[base + 2]);
    double lim = oval_to_double(R[base + 1]), st = oval_to_double(R[base + 2]);
    R[base] = oval_from_double(i);
    if (st >= 0 ? (i <= lim) : (i >= lim)) {
        pc += j;
        if (fn->jitFn == NULL && !fn->osrTried && ++fn->nloop >= OMNI_JIT_OSR) goto L_OSR;
    }
    DISPATCH(); }

/* ---- OSR：从当前这条字节码进编译码 ----
 *
 * 为什么这一格是必须的：编译时机必须晚于"反馈攒够"（调用点要知道被调方是谁、算术点要知道是不是数），
 * 而主 chunk 只被调一次 —— 它永远不会"调用够热"。热的是它的**循环**。
 * 为什么这一格在我们这儿很便宜：Tier 1 里 **R[] 就是内存之实**，没有跨字节码的寄存器分配，
 * 于是"从第 pc 条进去"只是跳到那条码的机器码起点（jit_compile_at 在序言后加一跳）。
 * acc 是唯一在寄存器里的活值，当第六个实参传进去。
 */
L_OSR: {
    fn->osrTried = 1;
    if (getenv("OMNI_JIT_DEBUG"))
        fprintf(stderr, "jit: OSR 升层 fn=%p pc=%u（%u 条码、协程里=%d）\n",
                (void *)fn, (uint32_t)(pc - fn->code), fn->codeLen,
                vm_arena != &vm_main_arena);
    JitFn jf = jit_compile_at(fn, (uint32_t)(pc - fn->code));
    if (jf == NULL) DISPATCH();      /* 编不出来就继续解释（与老行为相同） */
    /* 编译可能为了内联窗口把 nreg 抬高了 —— 这一帧是按老的 nreg 分的，得换一格更宽的 */
    uint32_t nn = fn->nreg ? fn->nreg : 1;
    OVal *nR = R;
    if (nn > curNreg) {
        nR = frame_alloc(nn);
        memcpy(nR, R, (size_t)curNreg * sizeof(OVal));
    }
    OVal **cl = cells;
    acc = jf(nR, K, &cl, (int64_t)vm_ic_base, curUp, acc);
    if (nR != R) frame_free(nR, nn);
    cells = cl;                      /* 编译码里造闭包可能把 cells 升格成私有的 */
    goto L_Ret;                      /* 编译码跑到 Ret 才返回 —— 这一帧已经结束了 */
}

/* ---- Closure：从子 Proto + upvalue 描述造一个闭包值 ---- */
L_Closure: {
    uint16_t ki = RD_U16();
    uint8_t nup = RD_U8();
    /* K[ki] 里存的是 TAG_FUNC|subIdx ——取出子 Proto */
    uint32_t si = (uint32_t)fn->K[ki];
    OmniFn *sub = fn->subs[si];
    /* 读 nup 对 (kind, idx)，建 upvalue 表 */
    OVal *ups[256];
    for (uint8_t i = 0; i < nup; i++) {
        uint8_t kind = RD_U8(), idx = RD_U8();
        if (kind == 0) {
            /* local：升格为 cell。**这一帧从此要私有的 cells 表** ——
               之前指的是那格全 NULL 的共享页，不许往里写。 */
            cells = cells_make_private(cells, curNreg);
            if (!cells[idx]) {
                cells[idx] = omni_cell_new(R[idx]);
            }
            ups[i] = cells[idx];
        } else {
            /* up：从本帧自己的 upvalue 表里透传 */
            ups[i] = curUp[idx];
        }
    }
    acc = bcclo_new(sub, (uint32_t)nup, ups);
    DISPATCH();
}

L_Print: { uint8_t base = RD_U8(), n = RD_U8();
    if (n == 0) printf("\n");
    else for (uint8_t i = 0; i < n; i++) omni_val_write(R[base + i], i + 1 == n);
    DISPATCH(); }
L_Nop: DISPATCH();

/* VarargTable: 变长参数打包成表 —— `local t = {...}` */
L_VarargTable: {
    /* 变长参数在 extra_slot[0..extra_n-1]（调用方通过 Call 时多传的那些实参，
       超过 nparams 的部分在 extra 里）。*/
    OVal tbl = omni_tab_new();
    for (int32_t i = 0; i < omni_extra_n; i++) {
        omni_tab_set(tbl, oval_from_double((double)(i + 1)), omni_extra_slot[i]);
    }
    acc = tbl;
    DISPATCH();
}
}

/* ---- JIT 用的 C 辅助函数 ----
 *
 * JIT 出来的机器码不自己管调用帧（那要在机器码里重建整套帧切换），
 * 而是**调回这几个 C 函数**。Sparkplug 也是这个形状：基线 JIT 只去掉派发开销，
 * 复杂的语义（开帧、造闭包、顺 __index）仍然走运行时。
 */

/* ---- 帧的分配 ----
 *
 * 眼下是 calloc/free 每帧一对（R[] + cells[]）。这是 VM-JIT 腿可量到的一块开销
 * （smallpt 里 Vec.__add / Vec.new 每秒几十万次调用），**但换成栈式 arena 要先解决
 * 协程那一格**：协程 yield 之后帧还活着，退栈不是 LIFO 的。踩过一次（SIGABRT：
 * arena 指针喂给了 free()）。先留着 calloc，等协程的帧栈分开之后再换。
 */

/* forward declaration for JIT types */
/* 第三个参数是**指向调用方那格 cells 变量的指针**：JIT 里的 Closure 要升格
   （从共享空页换成私有数组）时就地改写它，调用方原来那句 cells_release 也就还得对，
   不会漏。x24 专门存它（callee-saved，跨 C 调用不丢）。 */
typedef OVal (*JitFn)(OVal *R, OVal *K, OVal ***cellsp, int64_t icBase, OVal **up, OVal acc0);
static JitFn jit_compile_at(OmniFn *fn, uint32_t startPc);
static JitFn jit_compile(OmniFn *fn);

/** JIT 的 Call：与 L_Call 同一套语义，但作为独立函数。
    fbSlot 是这个调用点的**绝对**反馈槽号（编译期就是常量：fn->icBase + f），<0 表示不记。 */
static OVal jit_call_helper(OVal *R, uint32_t base, uint32_t argc, int32_t fbSlot) {
    OVal fv = R[base];
    if (!oval_is_fn(fv)) {
        fprintf(stderr, "omni-vm(jit): attempt to call a non-function (base=%u tag=%u)\n",
                base, oval_tag(fv));
        exit(1);
    }
    BCClo *clo = bcclo_get(fv);
    if (clo->native) {
        if (fbSlot >= 0 && fbSlot < vm_ics_n) omni_ics[fbSlot].off = CALLSITE_POLY;
        if (clo->ctx) return bc_coro_resume((BCCoro *)clo->ctx);
        OVal args[16];
        for (uint32_t i = 0; i < argc && i < 16; i++) args[i] = R[base + 1 + i];
        return clo->native(args, (uint8_t)argc);
    }
    OmniFn *callee = clo->fn;
    if (fbSlot >= 0 && fbSlot < vm_ics_n) call_site_record(fbSlot, callee, fv);
    int32_t saved = vm_ic_base;
    vm_ic_ensure(callee->icBase + (int32_t)callee->nfb);

    /* 递归 JIT：子函数也尝试走 JIT。**要够热才编**（与 L_Call 同一条判据）：
       原来这里是"第一次调用就编"，结果编的时候反馈槽全是空的 —— 调用点不知道被调方是谁、
       算术点不知道是不是数。那样 Tier 2 拿不到任何 profile，去虚化/内联根本无从下手。
       前 OMNI_JIT_HOT 次走解释器，正好把反馈填上；这点开销在热函数上摊到看不见。
       **必须在 frame_alloc 之前编** —— 内联会把 callee->nreg 抬高，帧要按新的分。 */
    if (callee->jitFn == NULL && ++callee->ncalls >= OMNI_JIT_HOT) {
        callee->jitFn = (void *)jit_compile(callee);
        if (callee->jitFn == NULL) callee->jitFn = (void *)(uintptr_t)1; /* failed sentinel */
    } else if (callee->jitFn == NULL) {
        /* OMNI_JIT_EAGER=1 退回"第一次调用就编"（老行为），留着做 A/B */
        static int eager = -1;
        if (eager < 0) eager = getenv("OMNI_JIT_EAGER") ? 1 : 0;
        if (eager) {
            callee->jitFn = (void *)jit_compile(callee);
            if (callee->jitFn == NULL) callee->jitFn = (void *)(uintptr_t)1;
        }
    }

    uint32_t nr = callee->nreg ? callee->nreg : 1;
    OVal *cR = frame_alloc_from(nr, (uint32_t)(argc < callee->nparams ? argc : callee->nparams));
    for (uint32_t i = 0; i < argc && i < callee->nparams; i++) cR[i] = R[base + 1 + i];
    if (callee->isVararg) {
        if (argc > callee->nparams) {
            omni_extra_n = (int32_t)(argc - callee->nparams);
            if (omni_extra_n > OMNI_EXTRA_MAX) omni_extra_n = OMNI_EXTRA_MAX;
            for (int32_t i = 0; i < omni_extra_n; i++)
                omni_extra_slot[i] = R[base + 1 + callee->nparams + i];
        } else omni_extra_n = 0;
    }
    OVal ret;
    OVal **cCells = vm_nocells;   /* 共享空表；L_Closure 真要捕获时换私有 */
    if (callee->jitFn != NULL && callee->jitFn != (void *)(uintptr_t)1) {
        JitFn jfn = (JitFn)callee->jitFn;
        ret = jfn(cR, callee->K, &cCells, (int64_t)callee->icBase, clo->up, oval_nil());
        frame_free(cR, nr); cells_release(cCells);
    } else {
        ret = omni_bc_call_inner(callee, cR, cCells, clo->up);
    }
    vm_ic_base = saved;
    return ret;
}

/** JIT 的 Closure：造闭包（含 upvalue 的 cell 升格） */
static OVal jit_closure_helper(OmniFn *fn, uint32_t ki, uint32_t nup,
                               const uint8_t *descs, OVal *R, OVal ***cellsp, OVal **curUp) {
    uint32_t si = (uint32_t)fn->K[ki];
    OmniFn *sub = fn->subs[si];
    OVal *ups[256];
    for (uint32_t i = 0; i < nup; i++) {
        uint8_t kind = descs[i * 2], idx = descs[i * 2 + 1];
        if (kind == 0) {
            /* 捕获本帧的局部量：**先把 cells 换成私有的**（原来可能是那页共享的全 NULL，
               不许写），再把 R[idx] 装进格子。改写的是调用方那格变量，所以它出帧时照旧释放。 */
            *cellsp = cells_make_private(*cellsp, fn->nreg ? fn->nreg : 1);
            if (!(*cellsp)[idx]) (*cellsp)[idx] = omni_cell_new(R[idx]);
            ups[i] = (*cellsp)[idx];
        } else {
            ups[i] = curUp[idx];
        }
    }
    return bcclo_new(sub, nup, ups);
}

/** JIT 的 GetNamed：串的方法表那一档也照顾到 */
/* 诊断：数一数 helper 是从哪些反馈槽被调的（OMNI_JIT_DEBUG 时在出口打印前 8 名） */
static uint32_t gn_call_cnt[4096];
static uint64_t gn_call_total = 0;
static OVal jit_getnamed_helper(OVal tv, OVal key, int32_t icSlot) {
    if (icSlot >= 0 && icSlot < 4096) gn_call_cnt[icSlot]++;
    gn_call_total++;
    if (oval_tag(tv) == OVAL_TAG_TAB) {
        /* **把 omni_tab_get_ic 的快路抄在这儿**，省掉第二层调用 ——
           采样里 jit_getnamed_helper 自占 23%、omni_tab_get_ic 又占 5%，
           JIT 每读一个字段要过两次 call。命中的三档与那边逐条一致（改那边记得改这儿）。 */
        OTab *t = (OTab *)omni_objs[(uint32_t)tv];
        OIC *ic = &omni_ics[icSlot];
        if (t->shape == ic->shape && t->meta == ic->meta && ic->gen == omni_shape_gen) {
            if (ic->off < 0) return oval_nil();
            if (ic->holder == 0) return t->svals[ic->off];
            return ((OTab *)omni_objs[(uint32_t)ic->holder])->svals[ic->off];
        }
        return ic_get_slow(tv, key, icSlot);
    }
    if (oval_tag(tv) == OVAL_TAG_STR) return omni_tab_get(bc_strlib(), key);
    return oval_nil();
}

/** JIT 的 RetMulti：把后续值写进 extra 槽 */
static void jit_retmulti_helper(OVal *R, uint32_t base, uint32_t n) {
    for (uint32_t i = 1; i < n; i++) omni_extra_set((int32_t)(i - 1), R[base + i]);
    omni_extra_n = n > 1 ? (int32_t)(n - 1) : 0;
}

/** JIT 的 VarargTable */
static OVal jit_vararg_table_helper(void) {
    OVal tbl = omni_tab_new();
    for (int32_t i = 0; i < omni_extra_n; i++)
        omni_tab_set(tbl, oval_from_double((double)(i + 1)), omni_extra_slot[i]);
    return tbl;
}

/* ---- 融成一串的浮点算术：守卫不中时走这一格 ----
   逐条发那份"慢路"每个算子要 9 条指令（搬参数 + 立即数 + blr），k 个算子就是一整份副本，
   代码量比省下的还多（smallpt 上量到 +4%）。改成把这一串的描述表烧成一个指针，
   不中就调这一格：调用点只剩 4 条指令。 */
typedef struct { uint8_t k; uint8_t ops[4]; uint8_t regs[4]; int32_t slots[4]; } ArithRun;

static OVal jit_arith_run_helper(OVal *R, OVal acc, const ArithRun *d) {
    for (uint8_t i = 0; i < d->k; i++) {
        OVal x = R[d->regs[i]];
        switch (d->ops[i]) {
        case OP_Add: acc = vm_val_add_fb(x, acc, d->slots[i]); break;
        case OP_Sub: acc = vm_val_sub_fb(x, acc, d->slots[i]); break;
        case OP_Mul: acc = vm_val_mul_fb(x, acc, d->slots[i]); break;
        default:     acc = vm_val_div_fb(x, acc, d->slots[i]); break;
        }
    }
    return acc;
}

/** JIT 的 NewShaped（形状借这一格反馈槽存，与解释器那条路同一套） */
static uint64_t ns_cnt = 0;      /* 量分配量用（只在 OMNI_JIT_NOALLOC=1 时才全走这儿） */
static OVal jit_newshaped_helper(OVal *R, OVal *keys, uint64_t base, uint64_t n, int32_t icSlot) {
    ns_cnt++;
    OIC *sic = &omni_ics[icSlot];
    if (n > 16) n = 16;
    /* 直接把 &R[base] 当 vals 传下去 —— 原来先拷进一个临时数组再让它拷进 svals，
       白走一趟（JIT 这条路上 R[base..] 就是连号的帧寄存器）。 */
    void *slot = (sic->gen == omni_shape_gen) ? (void *)sic->shape : NULL;
    OVal t = omni_tab_new_shaped(&slot, keys, &R[base], (int32_t)n);
    sic->shape = (OShape *)slot; sic->gen = omni_shape_gen;
    return t;
}

/* ---- Tier 2（我们自己的优化层，照 Go 的 ssa）---- */
#include "ssa.c"

/* ---- Tier 1 JIT（照 Sparkplug）---- */
#include "jit-a64.c"

/* ---- 入口包装 ---- */

static void omni_bc_run(OmniFn *topFn) {
    if (G == 0) {
        G = omni_tab_new();
        install_builtins();
    }
    int32_t totalIc = assign_ic_bases(topFn, 0);
    vm_ic_ensure(totalIc > 0 ? totalIc : 1);

    /* **主 chunk 不再一上来就编**：那时一格反馈都没有（调用点不知道被调方是谁），
       编出来的码只能全是通用慢路。改成先解释，回边够热了在 L_OSR 那儿升层。
       `OMNI_JIT_EAGERTOP=1` 退回老行为，留着做 A/B。 */
    if (getenv("OMNI_JIT_EAGERTOP")) {
        JitFn jfn = jit_compile(topFn);
        if (jfn) {
            uint32_t nr0 = topFn->nreg ? topFn->nreg : 1;
            OVal *R0 = frame_alloc(nr0);
            OVal **cells0 = vm_nocells;
            jfn(R0, topFn->K, &cells0, (int64_t)topFn->icBase, NULL, oval_nil());
            frame_free(R0, nr0);
            cells_release(cells0);
            return;
        }
    }
    uint32_t nr = topFn->nreg ? topFn->nreg : 1;
    OVal *R = frame_alloc(nr);
    OVal **cells = vm_nocells;
    omni_bc_call_inner(topFn, R, cells, NULL);
}

/* ---- 入口 ---- */

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "omni-vm <prog.olbc>\n"); return 2; }
    FILE *f = fopen(argv[1], "rb");
    if (!f) { fprintf(stderr, "omni-vm: cannot open %s\n", argv[1]); return 2; }
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *buf = (uint8_t *)malloc((size_t)len);
    if (fread(buf, 1, (size_t)len, f) != (size_t)len) { fprintf(stderr, "omni-vm: read error\n"); return 2; }
    fclose(f);
    OmniFn *top = omni_bc_load(buf, (size_t)len);
    omni_bc_run(top);
    if (getenv("OMNI_JIT_DEBUG")) {
        fprintf(stderr, "jit: 结束时 omni_shape_gen = %u\n", omni_shape_gen);
        fprintf(stderr, "jit: NewShaped 走 helper %llu 次（OMNI_JIT_NOALLOC=1 时 = 全部造表次数）\n",
                (unsigned long long)ns_cnt);
        fprintf(stderr, "jit: 元方法算术共 %llu 次；前 8 个槽：", (unsigned long long)ma_total);
        for (int t = 0; t < 8; t++) {
            int best = -1; uint32_t bc = 0;
            for (int i = 0; i < 4096; i++) if (ma_cnt[i] > bc) { bc = ma_cnt[i]; best = i; }
            if (best < 0 || bc == 0) break;
            fprintf(stderr, " [槽%d:%u]", best, bc);
            ma_cnt[best] = 0;
        }
        fprintf(stderr, "\n");
        fprintf(stderr, "jit: getnamed helper 共调 %llu 次；前 8 个槽：",
                (unsigned long long)gn_call_total);
        for (int t = 0; t < 8; t++) {
            int best = -1; uint32_t bc = 0;
            for (int i = 0; i < 4096; i++) if (gn_call_cnt[i] > bc) { bc = gn_call_cnt[i]; best = i; }
            if (best < 0 || bc == 0) break;
            fprintf(stderr, " [槽%d:%u]", best, bc);
            gn_call_cnt[best] = 0;
        }
        fprintf(stderr, "\n");
    }
    return 0;
}
