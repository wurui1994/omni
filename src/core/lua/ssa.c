/* src/core/lua/ssa.c —— **Tier 2：我们自己的优化层**（照 Go 的 cmd/compile/internal/ssa）
 *
 * 为什么不是 MLIR/LLVM：那两个是**对照**，不是我们的腿。这一层要同时拿到两样东西 ——
 *   * tcc -run 那种"编译快、直接进内存"（单遍、固定的通道表、不做迭代式的全局求解）
 *   * Go 那种"优化质量"（SSA + 逃逸分析/标量替换 + 内联 + 简单但够用的寄存器分配）
 * 只有这两样同时成立，内存里的 AOT 才是高质量的，而不是"快但差"或"好但慢"。
 *
 * 与 Tier 1（jit-a64.c）的关系：一条光谱。Tier 1 一条字节码一段机器码、不看类型；
 * 这一层把整个函数读成 SSA，**拿运行期的反馈槽当类型来源**（IC 里的形状、算术槽的类型），
 * 于是能把装箱拆掉、把 Vec 那种短命表留在寄存器里、把单态的元方法直接内联。
 *
 * 通道表（顺序固定，每个只走一遍 —— 这是"编译快"的来源）：
 *   1. build      字节码 → 基本块 + SSA（照 Braun 那篇的按需插 phi）
 *   2. typeprop   反馈槽 + 常量 → 类型格（Num / Tab(shape) / Any）
 *   3. unbox      Box/Unbox 成对消掉，浮点留在 FP 寄存器里
 *   4. sink       逃逸分析：只在本函数里读写的 AllocShaped 拆成 SSA 值（标量替换）
 *   5. dce        死代码
 *   6. regalloc   线性扫描（整数池 + 浮点池各一份）
 *   7. emit       复用 jit-a64.c 那套发射器，写进可执行内存
 *
 * 这一版落地的是 1–3（build + typeprop + liveness），加一格 dump 与逃逸分析的统计；
 * 后面几格逐个接上。emit（通道 7）是下一个 —— 它复用 Tier 1 的 `jit_emit_one`，
 * 所以 S_BC 节点零成本接入、覆盖率天生 100%；特化的节点（S_FADD 等）日后逐个替换。
 * 没接完之前 Tier 2 只观察、不发码，跑的还是 Tier 1 —— 判据始终是"输出与 luajit 逐字节相同"。
 */

/* 读字节码操作数（与 jit-a64.c 那三个同义，另起名免得两处 #define 撞） */
#define SBC_U8(code, pc)  ((code)[(pc)])
#define SBC_U16(code, pc) ((uint16_t)((code)[(pc)] | ((code)[(pc)+1] << 8)))
#define SBC_I32(code, pc) ((int32_t)((uint32_t)(code)[(pc)] | ((uint32_t)(code)[(pc)+1] << 8) \
                          | ((uint32_t)(code)[(pc)+2] << 16) | ((uint32_t)(code)[(pc)+3] << 24)))

/* ---- 类型格 ---- */
typedef enum {
    T_ANY = 0,      /* 什么都可能 */
    T_NUM,          /* 一定是数（可以拆箱进 FP 寄存器） */
    T_TAB,          /* 一定是表（形状见 shape 字段） */
    T_STR,
    T_NIL,
} SsaType;

/* ---- 指令 ---- */
typedef enum {
    /* 取值 */
    S_ARG,          /* aux = 形参号（进来时在 R[aux]） */
    S_CONST,        /* aux = OVal 的位模式 */
    S_PHI,          /* args = 各前驱来的值（与 preds 同序） */
    /* 帧寄存器当内存看（**跨块一律走内存**，块内做局部值编号）。
       这是 Go 起步时对"取过地址的变量"的做法：先正确，热点形状（元方法体、
       内层循环体都是单块）已经能在块内拿到完整的 SSA。跨块的 phi 等 codegen 落地后再加。 */
    S_LOAD_R,       /* aux = 帧寄存器号 */
    S_STORE_R,      /* aux = 帧寄存器号，args[0] = 值 */
    /* 拆箱的浮点算术（操作数都是 T_NUM） */
    S_FADD, S_FSUB, S_FMUL, S_FDIV,
    S_FLT, S_FLE, S_FEQ,
    /* 装箱/拆箱 */
    S_BOX,          /* double → OVal */
    S_UNBOX,        /* OVal → double（前提：已经守卫过是数） */
    S_GUARD_NUM,    /* 不是数就退回解释器（deopt） */
    /* 表 */
    S_GUARD_SHAPE,  /* aux = 期望的 OShape*；不符就 deopt */
    S_LOAD_FIELD,   /* args[0] = 表，aux = svals 里的下标 */
    S_STORE_FIELD,
    S_ALLOC_SHAPED, /* aux = OShape* */
    S_SET_META,     /* args[0] = 表，args[1] = 元表；对标量替换来说这是"对象上的一次写"，不是逃逸 */
    /* 落在通用路上的那些：直接调运行时 */
    S_CALL_RT,      /* aux = 运行时函数地址，args = 实参 */
    S_CALL_LUA,
    /* **没特化的那些字节码**：aux = 它的 pc，发码时照 Tier 1 那一段原样发。
       有这一格，Tier 2 就能接下**整个函数**（覆盖率 100%），而不是碰到没建模的就整函数放弃；
       特化只发生在有反馈的点上。语义上它是个屏障：可能动任何 R[]，所以块内缓存全作废。 */
    S_BC,
    S_RET,
    S_JUMP,         /* 块的终结子由 Block.kind 表示，这两个只占位 */
    S_IF,
} SsaOp;

#define SSA_MAXARG 3

typedef struct {
    SsaOp    op;
    SsaType  type;
    int32_t  args[SSA_MAXARG];   /* 值编号；-1 = 没有 */
    int64_t  aux;
    int32_t  blk;
    int32_t  reg;                /* regalloc 填；-1 = 还没分配 */
    uint8_t  nuse;               /* 用了几次（dce 与 sink 都看这个） */
    OmniFn  *ofn;                /* S_BC / S_ALLOC_SHAPED：这条码属于哪个 proto（内联体里不是最外层那个） */
    int32_t  shift;              /* 同上：它的 R[0] 落在最外层帧的哪一格 */
    uint32_t srcPc;              /* S_ALLOC_SHAPED：造它的那条 NewShaped 在 ofn 里的 pc */
} SsaVal;

typedef enum { BK_PLAIN, BK_IF, BK_RET } BlkKind;

typedef struct {
    BlkKind  kind;
    uint32_t bcStart, bcEnd;     /* 这个块盖住的字节码区间 */
    int32_t  succ[2];
    int32_t  pred[8];
    int8_t   npred;
    int32_t  ctrl;               /* BK_IF 的条件值 / BK_RET 的返回值 */
    int32_t *vals;               /* 这个块里的值编号，按序 */
    int32_t  nval, valCap;
    uint8_t  sealed;             /* 前驱都填好了吗（按需插 phi 用） */
    int32_t *rdefs;              /* 这个块里每个 R[] 寄存器当前的 SSA 值（大小 nreg） */
    int32_t  accDef;             /* acc 当前的 SSA 值 */
} SsaBlk;

typedef struct {
    OmniFn  *fn;
    SsaVal  *vals;
    int32_t  nval, valCap;
    SsaBlk  *blks;
    int32_t  nblk, blkCap;
    int32_t *bcToBlk;            /* 字节码 pc → 块号（只有块首有效，其余 -1） */
    uint32_t nreg;
    int32_t  scratchTop;         /* 内联窗口的分配水位：**只涨不落** —— 见下面那段注释 */
    uint32_t realNreg;           /* 最外层函数真正有多少格（这个数以上都是内联窗口，出块即死） */
    /* 通道 3：活跃性（只对**真帧格** + acc 做 —— 内联窗口那些格出了块就没人认得，
       按构造不可能跨块活着，所以不进这张表，位图也就只要 realNreg+1 位）。 */
    uint32_t lvWords;            /* 每个块的位图占几个 uint64 */
    uint64_t *liveIn, *liveOut;  /* nblk × lvWords */
    /* 字节码 pc → 这条码产出的 SSA 值（只对**最外层**那份码有效，shift==0）。
       发码时要靠它反查"这条 NewShaped 在图里是哪个 AllocShaped、判出来能不能拆"。 */
    int32_t *valOfPc;
} SsaFunc;

/* 位图小工具（下标 [0, realNreg) = 帧格；下标 realNreg = acc） */
#define SSA_LV_ACC(f) ((int32_t)(f)->realNreg)
static inline int ssa_lv_get(const uint64_t *bm, int32_t i) {
    return (int)((bm[i >> 6] >> (i & 63)) & 1u);
}
static inline void ssa_lv_set(uint64_t *bm, int32_t i) { bm[i >> 6] |= (uint64_t)1 << (i & 63); }
static inline void ssa_lv_clr(uint64_t *bm, int32_t i) { bm[i >> 6] &= ~((uint64_t)1 << (i & 63)); }

/** 把帧格号折到位图下标：真帧格照原样，acc（= f->nreg）折到 realNreg，
    内联窗口那些格回 -1（不进位图 —— 它们出不了块）。 */
static inline int32_t ssa_lv_idx(SsaFunc *f, int64_t s) {
    if (s == (int64_t)f->nreg) return SSA_LV_ACC(f);
    if (s >= 0 && s < (int64_t)f->realNreg) return (int32_t)s;
    return -1;
}

/* ---- 小工具 ---- */

static int32_t ssa_new_val(SsaFunc *f, SsaOp op, SsaType ty, int32_t a0, int32_t a1, int64_t aux) {
    if (f->nval == f->valCap) {
        f->valCap = f->valCap ? f->valCap * 2 : 64;
        f->vals = (SsaVal *)realloc(f->vals, (size_t)f->valCap * sizeof(SsaVal));
    }
    SsaVal *v = &f->vals[f->nval];
    v->op = op; v->type = ty; v->aux = aux;
    v->args[0] = a0; v->args[1] = a1; v->args[2] = -1;
    v->blk = -1; v->reg = -1; v->nuse = 0;
    v->ofn = NULL; v->shift = 0; v->srcPc = 0;
    if (a0 >= 0 && f->vals[a0].nuse < 255) f->vals[a0].nuse++;
    if (a1 >= 0 && f->vals[a1].nuse < 255) f->vals[a1].nuse++;
    return f->nval++;
}

static void ssa_blk_push(SsaFunc *f, int32_t bi, int32_t vi) {
    SsaBlk *bb = &f->blks[bi];
    if (bb->nval == bb->valCap) {
        bb->valCap = bb->valCap ? bb->valCap * 2 : 16;
        bb->vals = (int32_t *)realloc(bb->vals, (size_t)bb->valCap * sizeof(int32_t));
    }
    bb->vals[bb->nval++] = vi;
    f->vals[vi].blk = bi;
}

static int32_t ssa_new_blk(SsaFunc *f, uint32_t bcStart) {
    if (f->nblk == f->blkCap) {
        f->blkCap = f->blkCap ? f->blkCap * 2 : 16;
        f->blks = (SsaBlk *)realloc(f->blks, (size_t)f->blkCap * sizeof(SsaBlk));
    }
    SsaBlk *bb = &f->blks[f->nblk];
    memset(bb, 0, sizeof(*bb));
    bb->kind = BK_PLAIN;
    bb->bcStart = bcStart; bb->bcEnd = bcStart;
    bb->succ[0] = bb->succ[1] = -1;
    bb->ctrl = -1; bb->accDef = -1;
    bb->rdefs = (int32_t *)malloc((size_t)(f->nreg + 1) * sizeof(int32_t));
    for (uint32_t i = 0; i <= f->nreg; i++) bb->rdefs[i] = -1;
    return f->nblk++;
}

/* acc 当成第 nreg 格"寄存器"：跨块也就跟着走内存那条路，不用单独伺候 */
#define SSA_ACC(f) ((int32_t)(f)->nreg)

/** 读一格（块内已有定义就直接用 —— 这就是块内的局部值编号） */
static int32_t ssa_read(SsaFunc *f, int32_t bi, int32_t r) {
    SsaBlk *bb = &f->blks[bi];
    if (bb->rdefs[r] >= 0) return bb->rdefs[r];
    int32_t v = ssa_new_val(f, S_LOAD_R, T_ANY, -1, -1, r);
    ssa_blk_push(f, bi, v);
    bb->rdefs[r] = v;
    return v;
}

/** 写一格：块内记住，同时落一条 S_STORE_R（跨块靠它） */
static void ssa_write(SsaFunc *f, int32_t bi, int32_t r, int32_t v) {
    int32_t st = ssa_new_val(f, S_STORE_R, T_NIL, v, -1, r);
    ssa_blk_push(f, bi, st);
    f->blks[bi].rdefs[r] = v;
}

/* ---- 通道 1：切基本块 ----
 * 块首（leader）三种：函数入口、跳转的落点、跳转/返回的下一条。
 */
static int ssa_split_blocks(SsaFunc *f) {
    OmniFn *fn = f->fn;
    uint8_t *code = fn->code;
    uint32_t n = fn->codeLen;
    uint8_t *leader = (uint8_t *)calloc(n + 1, 1);
    leader[0] = 1;
    for (uint32_t pc = 0; pc < n; ) {
        uint8_t op = code[pc];
        uint32_t len = omni_bc_len_at(code, pc);
        if (op == OP_Jump || op == OP_JumpIfTrue || op == OP_JumpIfFalse) {
            int32_t off = SBC_I32(code, pc + 1);
            uint32_t tgt = (uint32_t)((int64_t)(pc + len) + off);
            if (tgt > n) { free(leader); return 0; }      /* 越界：放弃这一格 */
            leader[tgt] = 1;
            if (pc + len <= n) leader[pc + len] = 1;
        } else if (op == OP_Ret || op == OP_RetMulti) {
            if (pc + len <= n) leader[pc + len] = 1;
        }
        pc += len;
    }
    f->bcToBlk = (int32_t *)malloc((size_t)(n + 1) * sizeof(int32_t));
    for (uint32_t i = 0; i <= n; i++) f->bcToBlk[i] = -1;
    f->valOfPc = (int32_t *)malloc((size_t)(n + 1) * sizeof(int32_t));
    for (uint32_t i = 0; i <= n; i++) f->valOfPc[i] = -1;
    /* 按字节码次序建块，块尾就是下一个块首的前一条 */
    for (uint32_t pc = 0; pc < n; ) {
        if (leader[pc]) {
            int32_t bi = ssa_new_blk(f, pc);
            f->bcToBlk[pc] = bi;
        }
        pc += omni_bc_len_at(code, pc);
    }
    /* 填每个块的字节码终点 */
    for (int32_t bi = 0; bi < f->nblk; bi++) {
        uint32_t pc = f->blks[bi].bcStart, last = pc;
        while (pc < n) {
            last = pc;
            pc += omni_bc_len_at(code, pc);
            if (pc < n && leader[pc]) break;
        }
        f->blks[bi].bcEnd = last;       /* 最后一条指令的 pc */
    }
    free(leader);
    return 1;
}

/* ---- 通道 2：块内翻译 + 类型 ----
 *
 * 类型从哪儿来：**运行期的反馈槽**。算术指令那一格 f 指向 omni_ics[icBase+f]，
 * 解释器跑过之后里头记着"这个点见过什么"；表访问那一格记着形状与偏移。
 * 这就是 Tier 1 拿不到的东西，也是能把装箱/查表拆掉的唯一依据。
 * 拿不到反馈（没跑过、见过多种）就退回 T_ANY，发通用路 —— 答案一样，只是不快。
 */

/** 这个算术点的两个操作数都只见过数吗 */
static int ssa_fb_is_num(OmniFn *fn, uint16_t f) {
    return arith_site_is_num(fn->icBase + (int32_t)f);
}

/** NewShaped 那格反馈里缓存的形状（拿到了就能把"造表"建模成 Alloc + n 次字段写） */
static int ssa_fb_newshape(OmniFn *fn, uint16_t f, void **shapeOut) {
    int32_t id = fn->icBase + (int32_t)f;
    if (id < 0 || id >= vm_ics_n) return 0;
    OIC *ic = &omni_ics[id];
    if (ic->shape == NULL || ic->gen != omni_shape_gen) return 0;
    *shapeOut = (void *)ic->shape;
    return 1;
}

/** 这个字段访问点见过的形状（拿到就能把查表变成定偏移的 load） */
static int ssa_fb_shape(OmniFn *fn, uint16_t f, void **shapeOut, int32_t *offOut) {
    int32_t id = fn->icBase + (int32_t)f;
    if (id < 0 || id >= vm_ics_n) return 0;
    OIC *ic = &omni_ics[id];
    if (ic->shape == NULL || ic->gen != omni_shape_gen) return 0;
    if (ic->off < 0 || ic->holder != 0) return 0;     /* 负缓存/命中在原型上：这一版不接 */
    *shapeOut = (void *)ic->shape;
    *offOut = ic->off;
    return 1;
}

/** 一条算术字节码 → SSA 指令（拿不到"是数"的反馈就发通用路） */
static SsaOp ssa_arith_op(uint8_t op) {
    switch (op) {
    case OP_Add: return S_FADD;
    case OP_Sub: return S_FSUB;
    case OP_Mul: return S_FMUL;
    case OP_Div: return S_FDIV;
    case OP_Lt:  return S_FLT;
    case OP_Le:  return S_FLE;
    case OP_Eq:  return S_FEQ;
    default:     return S_CALL_RT;
    }
}

/* ---- 通道 0：去虚化 + 内联（照 Go 的次序，内联必须在逃逸分析之前）----
 *
 * 为什么 Tier 2 非得自己再内联一遍：**分配点藏在被调方里**。
 * `Vec.__add(a,b)` 的函数体是 `Vec.new(a.x+b.x, …)`，那个新表在 __add 自己看来是
 * `return` 出去的 —— 一定逃逸。只有把 __add（以及它里头的 Vec.new）都展进调用方，
 * 那个表的全部用处才在同一张图里，逃逸分析才看得见"其实只被读了三个字段就死了"。
 * 所以通道次序是 devirt → inline → escape → decompose → dse，不能颠倒。
 */
#define SSA_INLINE_MAX_DEPTH 4     /* 这一层只算账、不发码，比 Tier 1 放宽一点看得更全 */
#define SSA_INLINE_MAX_BC   128
#define SSA_INLINE_PAD      4096   /* 给内联窗口在帧上留的格数（每次内联占**新的一段**，不复用） */

/** 这条字节码能进内联体吗（与 jit_inline_op_ok 同一张白名单，那个在 jit-a64.c 里、还没 include） */
static int ssa_inline_op_ok(uint8_t op) {
    switch (op) {
    case OP_LdaNil: case OP_LdaTrue: case OP_LdaFalse: case OP_LdaK:
    case OP_LdaR: case OP_StaR: case OP_Mov:
    case OP_LdaGlobal: case OP_StaGlobal: case OP_LdaUp: case OP_StaUp:
    case OP_Add: case OP_Sub: case OP_Mul: case OP_Div: case OP_Mod:
    case OP_Pow: case OP_Concat: case OP_Neg: case OP_Not: case OP_Len:
    case OP_Eq: case OP_Ne: case OP_Lt: case OP_Le: case OP_Gt: case OP_Ge:
    case OP_NewTable: case OP_NewShaped:
    case OP_GetNamed: case OP_SetNamed: case OP_GetKeyed: case OP_SetKeyed:
    case OP_SetMeta: case OP_GetFields: case OP_Call: case OP_Nop:
        return 1;
    default: return 0;
    }
}

/** 这个 proto 能就地展开吗（到第一条 Ret 为止全是白名单里的直线码） */
static int ssa_inline_fn_ok(OmniFn *ce, uint32_t argc) {
    if (ce == NULL || ce->isVararg || argc != (uint32_t)ce->nparams
        || ce->codeLen > SSA_INLINE_MAX_BC) return 0;
    uint32_t q = 0;
    while (q < ce->codeLen) {
        uint8_t o = ce->code[q];
        if (o == OP_Ret) return 1;
        if (!ssa_inline_op_ok(o)) return 0;
        q += omni_bc_len_at(ce->code, q);
    }
    return 0;
}

static int jit_dummy_never_used_marker;
static int ssa_bc_write_set(SsaFunc *f, OmniFn *cf, uint32_t pc, int32_t shift,
                            int32_t *out, int max);
/** 一段直线字节码 → 块 bi 里的 SSA。
    cfn = 这段码属于哪个 proto（K 与 icBase 都从它取）；shift = 它的 R[0] 落在最外层帧的哪一格。
    inl != 0 表示这是内联体：到第一条 Ret 为止，Ret 本身不发（返回值本来就在 acc 里）。 */
static int ssa_emit_range(SsaFunc *f, int32_t bi, OmniFn *cfn, uint32_t from, uint32_t stop,
                          int32_t shift, int depth, int inl) {
    uint8_t *code = cfn->code;
    OmniFn *fn = cfn;
    const int32_t ACC = SSA_ACC(f);
    SsaBlk *bb = &f->blks[bi];
    uint32_t pc = from;
    int done = 0;
    while (!done) {
        if (pc > stop) break;
        uint8_t op = code[pc];
        if (inl && op == OP_Ret) break;
        uint32_t next = pc + omni_bc_len_at(code, pc);
        done = (!inl && pc == stop);
        pc++;
        switch (op) {
            case OP_LdaNil:
                ssa_write(f, bi, ACC, ssa_new_val(f, S_CONST, T_NIL, -1, -1,
                          (int64_t)((uint64_t)OVAL_TAG_NIL << 32)));
                break;
            case OP_LdaTrue:
                ssa_write(f, bi, ACC, ssa_new_val(f, S_CONST, T_ANY, -1, -1,
                          (int64_t)((uint64_t)OVAL_TAG_TRUE << 32)));
                break;
            case OP_LdaFalse:
                ssa_write(f, bi, ACC, ssa_new_val(f, S_CONST, T_ANY, -1, -1,
                          (int64_t)((uint64_t)OVAL_TAG_FALSE << 32)));
                break;
            case OP_LdaK: {
                uint16_t k = SBC_U16(code, pc);
                OVal kv = fn->K[k];
                SsaType ty = oval_is_num(kv) ? T_NUM : T_ANY;
                int32_t v = ssa_new_val(f, S_CONST, ty, -1, -1, (int64_t)kv);
                ssa_blk_push(f, bi, v);
                ssa_write(f, bi, ACC, v);
                break;
            }
            case OP_LdaR:
                ssa_write(f, bi, ACC, ssa_read(f, bi, shift + SBC_U8(code, pc)));
                break;
            case OP_StaR:
                ssa_write(f, bi, shift + SBC_U8(code, pc), ssa_read(f, bi, ACC));
                break;
            case OP_Mov: {
                int32_t a = shift + SBC_U8(code, pc), b2 = shift + SBC_U8(code, pc + 1);
                ssa_write(f, bi, b2, ssa_read(f, bi, a));
                break;
            }
            case OP_Add: case OP_Sub: case OP_Mul: case OP_Div:
            case OP_Lt: case OP_Le: case OP_Eq: {
                int32_t r = shift + SBC_U8(code, pc);
                uint16_t fb = SBC_U16(code, pc + 1);
                int32_t lhs = ssa_read(f, bi, r), rhs = ssa_read(f, bi, ACC);
                int isNum = ssa_fb_is_num(fn, fb)
                         || (f->vals[lhs].type == T_NUM && f->vals[rhs].type == T_NUM);
                int32_t v = isNum
                    ? ssa_new_val(f, ssa_arith_op(op), T_NUM, lhs, rhs, 0)
                    : -1;
                if (!isNum) {
                    /* 落在表上的算子：反馈槽里记着受方的形状与处理函数，单态就把处理函数体
                       也展进来 —— `Vec.__add` 里那个 `Vec.new(...)` 的分配点只有这样才进得了图。 */
                    OShape *ash = NULL; OVal ameta = 0, ah = 0;
                    if (depth + 1 < SSA_INLINE_MAX_DEPTH
                        && arith_site_mono(fn->icBase + (int32_t)fb, &ash, &ameta, &ah)) {
                        BCClo *aclo = bcclo_get(ah);
                        OmniFn *ace = aclo->native ? NULL : aclo->fn;
                        int32_t nsh = f->scratchTop;
                        uint32_t anr = ace ? (ace->nreg ? ace->nreg : 1) : 0;
                        if (ssa_inline_fn_ok(ace, 2) && nsh + (int32_t)anr <= (int32_t)f->nreg) {
                            int32_t g = ssa_new_val(f, S_GUARD_SHAPE, T_TAB, lhs, -1,
                                                    (int64_t)(uintptr_t)ash);
                            ssa_blk_push(f, bi, g);
                            ssa_write(f, bi, nsh, g);
                            ssa_write(f, bi, nsh + 1, rhs);
                            int32_t nilv = ssa_new_val(f, S_CONST, T_NIL, -1, -1,
                                                       (int64_t)((uint64_t)OVAL_TAG_NIL << 32));
                            ssa_blk_push(f, bi, nilv);
                            for (uint32_t r2 = 2; r2 < anr; r2++) ssa_write(f, bi, nsh + (int32_t)r2, nilv);
                            f->scratchTop = nsh + (int32_t)anr;
                            int ok2 = ssa_emit_range(f, bi, ace, 0, ace->codeLen - 1, nsh, depth + 1, 1);
                            /* scratchTop **只涨不落** —— 这是让每次内联得到自己独有帧区间的关键。
                               如果退回 nsh，下一次 Vec.__add 会复用同一块格子，两次造出来的表落在同
                               一个 R[] 格，逃逸分析就分不清谁是谁。只涨不落 ⇒ 每次都是新格子 ⇒
                               不可能"块内又读回来"（S_LOAD_R 读到的不会是同一格的值）。 */
                            /* f->scratchTop 保持在 nsh + anr，不复位 */
                            if (!ok2) return 0;
                            break;      /* 结果已经在 acc 里 */
                        }
                    }
                }
                if (v < 0) v = ssa_new_val(f, S_CALL_RT, T_ANY, lhs, rhs, (int64_t)op);
                ssa_blk_push(f, bi, v);
                ssa_write(f, bi, ACC, v);
                break;
            }
            case OP_GetNamed: {
                int32_t r = shift + SBC_U8(code, pc);
                uint16_t fb = SBC_U16(code, pc + 3);
                void *shape = NULL; int32_t off = -1;
                int32_t obj = ssa_read(f, bi, r);
                int32_t v;
                if (ssa_fb_shape(fn, fb, &shape, &off)) {
                    int32_t g = ssa_new_val(f, S_GUARD_SHAPE, T_TAB, obj, -1, (int64_t)(uintptr_t)shape);
                    ssa_blk_push(f, bi, g);
                    v = ssa_new_val(f, S_LOAD_FIELD, T_ANY, g, -1, off);
                } else {
                    v = ssa_new_val(f, S_CALL_RT, T_ANY, obj, -1, (int64_t)op);
                }
                ssa_blk_push(f, bi, v);
                ssa_write(f, bi, ACC, v);
                break;
            }
            case OP_SetNamed: {
                int32_t r = shift + SBC_U8(code, pc);
                uint16_t fb = SBC_U16(code, pc + 3);
                void *shape = NULL; int32_t off = -1;
                int32_t obj = ssa_read(f, bi, r), val = ssa_read(f, bi, ACC);
                if (ssa_fb_shape(fn, fb, &shape, &off)) {
                    int32_t g = ssa_new_val(f, S_GUARD_SHAPE, T_TAB, obj, -1, (int64_t)(uintptr_t)shape);
                    ssa_blk_push(f, bi, g);
                    ssa_blk_push(f, bi, ssa_new_val(f, S_STORE_FIELD, T_NIL, g, val, off));
                } else {
                    ssa_blk_push(f, bi, ssa_new_val(f, S_CALL_RT, T_NIL, obj, val, (int64_t)op));
                }
                break;
            }
            case OP_NewShaped: {
                uint8_t base = SBC_U8(code, pc + 2), n = SBC_U8(code, pc + 3);
                uint16_t fb = SBC_U16(code, pc + 4);
                void *shape = NULL;
                if (n == 0 || n > 8 || !ssa_fb_newshape(fn, fb, &shape)) goto generic;
                int32_t a = ssa_new_val(f, S_ALLOC_SHAPED, T_TAB, -1, -1, (int64_t)(uintptr_t)shape);
                ssa_blk_push(f, bi, a);
                /* 记下这个分配点的来路：(proto, pc)。发码时按这一对反查判决 ——
                   **不能只按最外层的 pc 记**：可拆的那些分配全在内联体里（属于别的 proto），
                   而且同一个 (proto,pc) 会被展开好几遍（各自 shift 不同）。 */
                f->vals[a].ofn = fn; f->vals[a].shift = shift; f->vals[a].srcPc = pc - 1;
                if (shift == 0 && f->valOfPc != NULL && pc - 1 < fn->codeLen)
                    f->valOfPc[pc - 1] = a;
                for (uint8_t i = 0; i < n; i++) {
                    int32_t val = ssa_read(f, bi, shift + base + i);
                    ssa_blk_push(f, bi, ssa_new_val(f, S_STORE_FIELD, T_NIL, a, val, i));
                }
                ssa_write(f, bi, ACC, a);
                break;
            }
            case OP_SetMeta: {
                /* setmetatable(R[r], acc)；结果 acc = R[r]。对标量替换来说这是对象上的一次写。 */
                int32_t r = shift + SBC_U8(code, pc);
                int32_t obj = ssa_read(f, bi, r), mt = ssa_read(f, bi, ACC);
                int32_t v = ssa_new_val(f, S_SET_META, T_TAB, obj, mt, 0);
                ssa_blk_push(f, bi, v);
                ssa_write(f, bi, ACC, obj);
                break;
            }
            case OP_GetFields: {
                int32_t r = shift + SBC_U8(code, pc);
                uint8_t dst = SBC_U8(code, pc + 3), n = SBC_U8(code, pc + 4);
                uint16_t fb = SBC_U16(code, pc + 5);
                void *shape = NULL; int32_t off = -1;
                if (n == 0 || !ssa_fb_shape(fn, fb, &shape, &off)) goto generic;
                int32_t obj = ssa_read(f, bi, r);
                int32_t g = ssa_new_val(f, S_GUARD_SHAPE, T_TAB, obj, -1, (int64_t)(uintptr_t)shape);
                ssa_blk_push(f, bi, g);
                for (uint8_t i = 0; i < n; i++) {
                    void *sh2 = NULL; int32_t off2 = -1;
                    if (!ssa_fb_shape(fn, (uint16_t)(fb + i), &sh2, &off2) || sh2 != shape) goto generic;
                    int32_t v = ssa_new_val(f, S_LOAD_FIELD, T_ANY, g, -1, off2);
                    ssa_blk_push(f, bi, v);
                    ssa_write(f, bi, shift + dst + i, v);
                }
                break;
            }
            case OP_Call: {
                /* **去虚化 + 内联**：调用点反馈说单态、被调方又全是直线码，就把它的码
                   接着往这个块里翻（寄存器整体挪到 base+1 那一格起）。 */
                int32_t base = shift + SBC_U8(code, pc);
                uint32_t argc = SBC_U8(code, pc + 1);
                uint16_t cf = SBC_U16(code, pc + 2);
                OVal fv = 0;
                OmniFn *ce = call_site_mono(fn->icBase + (int32_t)cf, &fv);
                /* 窗口不复用调用方的 base+1，而是从水位往上取**新的一段**（实参显式拷进去）—— 
                   同一个块里同一个 Call 点会被展开好几次，共用格子的话逃逸分析分不清谁是谁。 */
                int32_t nshift = f->scratchTop;
                if (depth + 1 >= SSA_INLINE_MAX_DEPTH || !ssa_inline_fn_ok(ce, argc)
                    || nshift + (int32_t)(ce->nreg ? ce->nreg : 1) > (int32_t)f->nreg)
                    goto generic;
                uint32_t cnr = ce->nreg ? ce->nreg : 1;
                for (uint32_t r2 = 0; r2 < argc; r2++)
                    ssa_write(f, bi, nshift + (int32_t)r2, ssa_read(f, bi, base + 1 + (int32_t)r2));
                int32_t nilv = ssa_new_val(f, S_CONST, T_NIL, -1, -1,
                                           (int64_t)((uint64_t)OVAL_TAG_NIL << 32));
                ssa_blk_push(f, bi, nilv);
                for (uint32_t r2 = argc; r2 < cnr; r2++) ssa_write(f, bi, nshift + (int32_t)r2, nilv);
                f->scratchTop = nshift + (int32_t)cnr;
                if (!ssa_emit_range(f, bi, ce, 0, ce->codeLen - 1, nshift, depth + 1, 1)) return 0;
                break;
            }
            case OP_Ret: case OP_RetMulti:
            case OP_Jump: case OP_JumpIfTrue: case OP_JumpIfFalse:
                /* 终结子：在块尾统一处理（下面那一段），这儿什么都不发 */
                break;
            default:
            generic:
                /* 没特化的：原样留一条 S_BC（发码时照 Tier 1 那一段发），并当屏障处理 —— 
                   块内那份"寄存器里现在是哪个 SSA 值"的缓存全作废，后面要读就重新 load。
                   R[] 是真相在内存里，SSA 值只是块内的缓存 —— 这样才能与 Tier 1 的码拼在一起。
                   **改进（2026-09-20）**：算准这条码写了哪些格，只作废那些 —— 其余的定义继续用。
                   这让 `LdaGlobal`（只写 acc）不会冲掉旁边 R[4] 里的 `self` 定义，
                   setmetatable 下一句读 self 时就不用 LoadR 重读。 */
                {
                    int32_t wset[16]; int nw = ssa_bc_write_set(f, fn, pc - 1, shift, wset, 16);
                    int32_t v = ssa_new_val(f, S_BC, T_ANY, -1, -1, (int64_t)(pc - 1));
                    f->vals[v].ofn = fn; f->vals[v].shift = shift;
                    ssa_blk_push(f, bi, v);
                    if (nw < 0) {
                        /* 写集说不清 ⇒ 全部作废 */
                        for (uint32_t i = 0; i <= f->nreg; i++) bb->rdefs[i] = -1;
                        bb->rdefs[ACC] = v;
                    } else {
                        for (int i = 0; i < nw; i++) {
                            if (wset[i] >= 0 && wset[i] <= (int32_t)f->nreg) bb->rdefs[wset[i]] = -1;
                        }
                        /* acc 属于被写的那一组 —— 它的 SSA 值就是这条 S_BC 的结果 */
                        for (int i = 0; i < nw; i++)
                            if (wset[i] == ACC) { bb->rdefs[ACC] = v; break; }
                    }
                }
                break;
            }
            pc = next;
    }
    return 1;
}

/* ---- 通道 1+2 的驱动：逐块翻译 + 填终结子 ---- */
static int ssa_translate(SsaFunc *f) {
    OmniFn *fn = f->fn;
    uint8_t *code = fn->code;
    const int32_t ACC = SSA_ACC(f);
    for (int32_t bi = 0; bi < f->nblk; bi++) {
        SsaBlk *bb = &f->blks[bi];
        if (!ssa_emit_range(f, bi, fn, bb->bcStart, bb->bcEnd, 0, 0, 0)) return 0;
        uint8_t last = code[bb->bcEnd];
        uint32_t lend = bb->bcEnd + omni_bc_len_at(code, bb->bcEnd);
        if (last == OP_Ret) {
            bb->kind = BK_RET; bb->ctrl = ssa_read(f, bi, ACC);
        } else if (last == OP_Jump) {
            int32_t off = SBC_I32(code, bb->bcEnd + 1);
            bb->succ[0] = f->bcToBlk[(uint32_t)((int64_t)lend + off)];
        } else if (last == OP_JumpIfTrue || last == OP_JumpIfFalse) {
            bb->kind = BK_IF; bb->ctrl = ssa_read(f, bi, ACC);
            int32_t off = SBC_I32(code, bb->bcEnd + 1);
            bb->succ[0] = f->bcToBlk[(uint32_t)((int64_t)lend + off)];
            bb->succ[1] = (lend < fn->codeLen) ? f->bcToBlk[lend] : -1;
        } else {
            bb->succ[0] = (lend < fn->codeLen) ? f->bcToBlk[lend] : -1;
        }
    }
    return 1;
}

/** 这条 S_BC 读哪几个帧格（集合形式）。回 -1 = 说不清（调用方当它读了所有格）。
 *  与 ssa_bc_reads_slot 是同一套判据，只是这儿一次把集合给出来 —— 活跃性分析要 USE 集，
 *  一格一格去问的话是 O(nreg) 次调用（nreg 带内联窗口能到四千多）。 */
static int ssa_bc_read_set(SsaFunc *f, SsaVal *v, int32_t *out, int max) {
    (void)f;
    OmniFn *cf = v->ofn;
    if (cf == NULL) return -1;
    uint32_t pc = (uint32_t)v->aux;
    if (pc >= cf->codeLen) return -1;
    const uint8_t *code = cf->code;
    uint8_t op = code[pc];
    int32_t sh = v->shift;
    uint32_t p = pc + 1;
    int n = 0;
    #define PUSH(x) do { if (n >= max) return -1; out[n++] = (x); } while (0)
    switch (op) {
    case OP_Call: {                     /* 'rif'：读 base..base+argc */
        int32_t base = sh + (int32_t)code[p];
        for (int i = 0; i <= (int)code[p + 1]; i++) PUSH(base + i);
        return n;
    }
    case OP_CallMethod: {               /* 'rkif' */
        int32_t base = sh + (int32_t)code[p];
        for (int i = 0; i <= (int)code[p + 3]; i++) PUSH(base + i);
        return n;
    }
    case OP_CallBuiltin: {              /* 'rii' */
        int32_t base = sh + (int32_t)code[p];
        for (int i = 0; i < (int)code[p + 2]; i++) PUSH(base + i);
        return n;
    }
    case OP_RetMulti: case OP_Print: {  /* 'ri' */
        int32_t base = sh + (int32_t)code[p];
        for (int i = 0; i < (int)code[p + 1]; i++) PUSH(base + i);
        return n;
    }
    case OP_NewShaped: {                /* 'kiif'：读 i1..i1+n-1 */
        int32_t base = sh + (int32_t)code[p + 2];
        for (int i = 0; i < (int)code[p + 3]; i++) PUSH(base + i);
        return n;
    }
    case OP_GetFields: PUSH(sh + (int32_t)code[p]); return n;
    case OP_ForPrep: case OP_ForLoop: {
        int32_t base = sh + (int32_t)code[p];
        PUSH(base); PUSH(base + 1); PUSH(base + 2); return n;
    }
    case OP_Closure: return -1;         /* 捕获谁不好说 */
    default: {
        const char *sig = omni_op_sig[op];
        for (const char *c = sig; *c; c++) {
            if (*c == 'r') { PUSH(sh + (int32_t)code[p]); p += 1; }
            else if (*c == 'i') p += 1;
            else if (*c == 'k' || *c == 'f') p += 2;
            else if (*c == 'j') p += 4;
            else return -1;
        }
        return n;
    }
    }
    #undef PUSH
}

/** 这条字节码除了帧格还会读 acc 吗（acc 也当一格算活跃性）。 */
static int ssa_bc_reads_acc(SsaVal *v) {
    OmniFn *cf = v->ofn;
    if (cf == NULL) return 1;
    uint32_t pc = (uint32_t)v->aux;
    if (pc >= cf->codeLen) return 1;
    switch (cf->code[pc]) {
    /* 只写 acc、不读它的那些 */
    case OP_LdaNil: case OP_LdaTrue: case OP_LdaFalse: case OP_LdaK: case OP_LdaR:
    case OP_LdaGlobal: case OP_LdaUp: case OP_LdaEnv: case OP_NewTable:
    case OP_NewShaped: case OP_GetKeyed: case OP_GetFields: case OP_VarargTable:
    case OP_Closure: case OP_Call: case OP_CallMethod: case OP_CallBuiltin:
    case OP_Jump: case OP_Nop: case OP_Print: case OP_RetMulti:
        return 0;
    default: return 1;     /* 算术、比较、StaR/StaGlobal、SetNamed/SetKeyed、条件跳转 都拿 acc 当操作数 */
    }
}

/* ---- 通道 3：活跃性（反向数据流，到不动点）----
 *
 * 为什么非得有它：逃逸分析问的是"这张表落进 R[s] 之后，那一格还会不会被读"。
 * 块内能靠顺序扫出来，跨块就必须有 liveOut —— 原来一律按"真帧格就当活着"处理，
 * 于是所有落进局部量的表全判逃逸。regalloc 也要这同一份结果。
 */
static void ssa_liveness(SsaFunc *f) {
    f->lvWords = (f->realNreg + 1 + 63) / 64;
    size_t nb = (size_t)f->nblk * f->lvWords;
    f->liveIn = (uint64_t *)calloc(nb ? nb : 1, sizeof(uint64_t));
    f->liveOut = (uint64_t *)calloc(nb ? nb : 1, sizeof(uint64_t));
    uint64_t *use = (uint64_t *)calloc(nb ? nb : 1, sizeof(uint64_t));
    uint64_t *def = (uint64_t *)calloc(nb ? nb : 1, sizeof(uint64_t));
    if (!f->liveIn || !f->liveOut || !use || !def) { free(use); free(def); return; }

    /* 每个块的 USE（先读后写）与 DEF（写过） */
    int32_t rs[64];
    for (int32_t bi = 0; bi < f->nblk; bi++) {
        uint64_t *u = use + (size_t)bi * f->lvWords, *d = def + (size_t)bi * f->lvWords;
        SsaBlk *bb = &f->blks[bi];
        for (int32_t i = 0; i < bb->nval; i++) {
            SsaVal *v = &f->vals[bb->vals[i]];
            if (v->op == S_LOAD_R) {
                int32_t k = ssa_lv_idx(f, v->aux);
                if (k >= 0 && !ssa_lv_get(d, k)) ssa_lv_set(u, k);
            } else if (v->op == S_STORE_R) {
                int32_t k = ssa_lv_idx(f, v->aux);
                if (k >= 0) ssa_lv_set(d, k);
            } else if (v->op == S_BC) {
                int nr = ssa_bc_read_set(f, v, rs, 64);
                if (nr < 0) {   /* 说不清 ⇒ 当它读了所有还没写过的格 */
                    for (int32_t k = 0; k <= SSA_LV_ACC(f); k++)
                        if (!ssa_lv_get(d, k)) ssa_lv_set(u, k);
                } else {
                    for (int j = 0; j < nr; j++) {
                        int32_t k = ssa_lv_idx(f, rs[j]);
                        if (k >= 0 && !ssa_lv_get(d, k)) ssa_lv_set(u, k);
                    }
                    if (ssa_bc_reads_acc(v) && !ssa_lv_get(d, SSA_LV_ACC(f)))
                        ssa_lv_set(u, SSA_LV_ACC(f));
                }
                /* 写集：照 ssa_bc_write_set */
                int32_t ws[16];
                int nw = ssa_bc_write_set(f, v->ofn ? v->ofn : f->fn, (uint32_t)v->aux,
                                          v->shift, ws, 16);
                if (nw < 0) { for (int32_t k = 0; k <= SSA_LV_ACC(f); k++) ssa_lv_set(d, k); }
                else for (int j = 0; j < nw; j++) {
                    int32_t k = ssa_lv_idx(f, ws[j]);
                    if (k >= 0) ssa_lv_set(d, k);
                }
            }
        }
        /* 终结子读 acc（BK_IF 的条件、BK_RET 的返回值都在 acc 里） */
        if (bb->kind != BK_PLAIN && !ssa_lv_get(d, SSA_LV_ACC(f)))
            ssa_lv_set(u, SSA_LV_ACC(f));
    }

    /* 反向迭代到不动点：liveOut[b] = ∪ liveIn[succ]；liveIn[b] = use[b] ∪ (liveOut[b] − def[b]) */
    for (int iter = 0; iter < 64; iter++) {
        int changed = 0;
        for (int32_t bi = f->nblk - 1; bi >= 0; bi--) {
            uint64_t *lo = f->liveOut + (size_t)bi * f->lvWords;
            uint64_t *li = f->liveIn + (size_t)bi * f->lvWords;
            const uint64_t *u = use + (size_t)bi * f->lvWords;
            const uint64_t *d = def + (size_t)bi * f->lvWords;
            for (int s = 0; s < 2; s++) {
                int32_t sb = f->blks[bi].succ[s];
                if (sb < 0 || sb >= f->nblk) continue;
                const uint64_t *si = f->liveIn + (size_t)sb * f->lvWords;
                for (uint32_t w = 0; w < f->lvWords; w++) {
                    uint64_t nv = lo[w] | si[w];
                    if (nv != lo[w]) { lo[w] = nv; changed = 1; }
                }
            }
            for (uint32_t w = 0; w < f->lvWords; w++) {
                uint64_t nv = u[w] | (lo[w] & ~d[w]);
                if (nv != li[w]) { li[w] = nv; changed = 1; }
            }
        }
        if (!changed) break;
    }
    free(use); free(def);
}

static const char *ssa_opname(SsaOp o);

/** 这条字节码会写帧的哪几格（acc 也算一格，编号 SSA_ACC）。
 *  回 -1 = 说不清（调用方就把整份块内缓存作废）。
 *
 * 为什么要算准：`generic:` 那一格原来一律"整份作废"，于是 `Vec.new` 里那句
 * `LdaGlobal Vec`（只写 acc）把 `self` 的定义也冲掉了，下一句 setmetatable 只能
 * `LoadR` 重新读回来 —— 逃逸分析看到"这个表又从帧里读出来了"就判它逃逸。
 * smallpt 的 68 个造表点全部卡在这上面。
 */
static int ssa_bc_write_set(SsaFunc *f, OmniFn *cf, uint32_t pc, int32_t shift,
                           int32_t *out, int max) {
    const uint8_t *code = cf->code;
    uint8_t op = code[pc];
    uint32_t p = pc + 1;
    int n = 0;
    const int32_t ACC = SSA_ACC(f);
    switch (op) {
    /* 只写 acc 的那一大族 */
    case OP_LdaNil: case OP_LdaTrue: case OP_LdaFalse: case OP_LdaK: case OP_LdaR:
    case OP_LdaGlobal: case OP_LdaUp: case OP_LdaEnv:
    case OP_Add: case OP_Sub: case OP_Mul: case OP_Div: case OP_Mod: case OP_Pow:
    case OP_Concat: case OP_Neg: case OP_Not: case OP_Len:
    case OP_Eq: case OP_Ne: case OP_Lt: case OP_Le: case OP_Gt: case OP_Ge:
    case OP_NewTable: case OP_NewShaped: case OP_GetNamed: case OP_GetKeyed:
    case OP_SetMeta: case OP_VarargTable: case OP_Closure:
    case OP_Call: case OP_CallMethod: case OP_CallBuiltin:
        out[n++] = ACC; return n;
    /* 什么帧格都不写的 */
    case OP_StaGlobal: case OP_StaUp: case OP_StaEnv:
    case OP_SetNamed: case OP_SetKeyed: case OP_Print: case OP_Nop:
    case OP_Jump: case OP_JumpIfTrue: case OP_JumpIfFalse: case OP_JumpIfNil:
    case OP_JumpLoop:
        return 0;
    case OP_StaR: out[n++] = shift + (int32_t)code[p]; return n;
    case OP_Mov:  out[n++] = shift + (int32_t)code[p + 1]; return n;
    case OP_GetFields: {                /* 'rkiif'：写 i1..i1+n-1 */
        int32_t base = shift + (int32_t)code[p + 3];
        int cnt = (int)code[p + 4];
        if (cnt + 1 > max) return -1;
        for (int i = 0; i < cnt; i++) out[n++] = base + i;
        return n;
    }
    case OP_ForPrep: case OP_ForLoop: { /* 'rj'：三格 + acc */
        int32_t base = shift + (int32_t)code[p];
        if (max < 4) return -1;
        out[n++] = base; out[n++] = base + 1; out[n++] = base + 2; out[n++] = ACC;
        return n;
    }
    default: return -1;
    }
}

/** 这条 S_BC（照 Tier 1 原样发的那一格）可能读帧的第 s 格吗。
 *
 * 为什么非得算准：原来"有屏障就当逃逸"太粗。一条字节码真正读的帧格就是它
 * 签名里那几个 'r' 操作数（调用那几条读的是 base..base+argc 那一段窗口），
 * 与它无关的格子它碰不到。
 */
static int ssa_bc_reads_slot(SsaFunc *f, SsaVal *v, int64_t s) {
    OmniFn *cf = v->ofn ? v->ofn : f->fn;
    uint32_t pc = (uint32_t)v->aux;
    if (pc >= cf->codeLen) return 1;
    const uint8_t *code = cf->code;
    uint8_t op = code[pc];
    int64_t sh = v->shift;
    uint32_t p = pc + 1;
    switch (op) {
    case OP_Call: {                     /* 'rif'：读 base..base+argc（函数值 + 实参） */
        int64_t base = sh + code[p];
        return s >= base && s <= base + (int64_t)code[p + 1];
    }
    case OP_CallMethod: {               /* 'rkif'：读 base..base+argc */
        int64_t base = sh + code[p];
        return s >= base && s <= base + (int64_t)code[p + 3];
    }
    case OP_CallBuiltin: {              /* 'rii'：读 base..base+n-1 */
        int64_t base = sh + code[p];
        return s >= base && s < base + (int64_t)code[p + 2];
    }
    case OP_RetMulti: case OP_Print: {  /* 'ri'：读 r..r+n-1 */
        int64_t base = sh + code[p];
        return s >= base && s < base + (int64_t)code[p + 1];
    }
    case OP_NewShaped: {                /* 'kiif'：读 i1..i1+n-1 */
        int64_t base = sh + code[p + 2];
        return s >= base && s < base + (int64_t)code[p + 3];
    }
    case OP_GetFields:                  /* 'rkiif'：只读 r（i1.. 那几格是写） */
        return s == sh + (int64_t)code[p];
    case OP_ForPrep: case OP_ForLoop: { /* 'rj'：r/r+1/r+2 三格都动 */
        int64_t base = sh + code[p];
        return s >= base && s <= base + 2;
    }
    case OP_Closure:
        return 1;                       /* 捕获谁不好说（kind==0 直接抓本帧的格）—— 保守 */
    default: {
        /* 其余的按签名走：每个 'r' 操作数就是一格 */
        const char *sig = omni_op_sig[op];
        for (const char *c = sig; *c; c++) {
            if (*c == 'r') { if (s == sh + (int64_t)code[p]) return 1; p += 1; }
            else if (*c == 'i') p += 1;
            else if (*c == 'k' || *c == 'f') p += 2;
            else if (*c == 'j') p += 4;
            else return 1;              /* 不认识的操作数类型 —— 保守 */
        }
        return 0;
    }
    }
}

/** 块 bi 里，第 at 条之后帧的第 s 格还活着吗。
    回 0 = 块内就死了（拆得动）；1 = 后面还读回来；2 = 中间有屏障；3 = 活到块尾。
    这三档要分开数 —— 只有"屏障"那一档能靠**不跨屏障的就地转发**吃掉。 */
static int ssa_slot_live_after(SsaFunc *f, int32_t bi, int32_t at, int64_t s) {
    SsaBlk *bb = &f->blks[bi];
    for (int32_t i = at + 1; i < bb->nval; i++) {
        SsaVal *v = &f->vals[bb->vals[i]];
        if (v->op == S_LOAD_R && v->aux == s) return 1;
        if (v->op == S_STORE_R && v->aux == s) return 0;    /* 被覆写，之后与我无关 */
        /* S_BC / 调用 是屏障：它们可能直接读 R[]（helper 就是照帧取实参的）。
           但一条字节码真正读的只有它签名里那几个 'r' —— 与 s 不相干的屏障可以穿过去。 */
        if (v->op == S_BC && !ssa_bc_reads_slot(f, v, s)) continue;
        if (v->op == S_BC || v->op == S_CALL_RT || v->op == S_CALL_LUA) return 2;
    }
    /* 活到块尾：这时候才真的要问 liveOut —— 后继块会不会读这一格。
       内联窗口那些格不在位图里（出了块没人认得）⇒ ssa_lv_idx 回 -1 ⇒ 死。
       liveIn/liveOut 还没算（通道 3 没跑）时退回老的保守判据。 */
    if (f->liveOut == NULL) return s < (int64_t)f->realNreg ? 3 : 0;
    int32_t k = ssa_lv_idx(f, s);
    if (k < 0) return 0;
    return ssa_lv_get(f->liveOut + (size_t)bi * f->lvWords, k) ? 3 : 0;
}

/* ---- 通道 4a：冗余形状守卫的账（GuardShape 的 CSE 能省多少）----
 *
 * 一条 GuardShape 在机器码里是五条（取 tag、比 TAG_TAB、取 OTab*、比 shape、比 meta、比 gen）。
 * 同一个块里对**同一个值 + 同一个形状**再守一遍是白守 —— 前一条守住了，中间没有
 * 能改形状的东西（只有 C 调用会动 omni_shape_gen / 换形状）就一定还成立。
 * 这一格先只算账：能消几条。消掉它不需要 deopt、不需要 regalloc，是 emit 特化里最便宜的一刀。
 */
static void ssa_guard_cse_count(SsaFunc *f, int *nguardOut, int *nredundantOut) {
    int ng = 0, nr = 0;
    for (int32_t bi = 0; bi < f->nblk; bi++) {
        SsaBlk *bb = &f->blks[bi];
        /* 已经守过的 (值, 形状) 对；碰到屏障就整份作废 */
        struct { int32_t obj; int64_t shape; } seen[32];
        int nseen = 0;
        for (int32_t i = 0; i < bb->nval; i++) {
            SsaVal *v = &f->vals[bb->vals[i]];
            if (v->op == S_GUARD_SHAPE) {
                ng++;
                int hit = 0;
                for (int j = 0; j < nseen; j++)
                    if (seen[j].obj == v->args[0] && seen[j].shape == v->aux) { hit = 1; break; }
                if (hit) nr++;
                else if (nseen < 32) { seen[nseen].obj = v->args[0]; seen[nseen].shape = v->aux; nseen++; }
                continue;
            }
            /* C 里才会改形状/代号 ⇒ 只有真的出去过一趟 C 才需要作废。
               SetMeta 也算（它会把目标表标成原型、动 gen）。 */
            if (v->op == S_BC || v->op == S_CALL_RT || v->op == S_CALL_LUA || v->op == S_SET_META)
                nseen = 0;
        }
    }
    *nguardOut = ng; *nredundantOut = nr;
}

/* ---- 通道 4：逃逸分析（这一版只**算账**，不改图）----
 *
 * 一个 AllocShaped 算"不逃逸"的条件：它的每一处用处都是
 *   * 读它自己的字段（LoadField）/ 写它自己的字段（StoreField 的 args[0]）
 *   * 给它挂元表（SetMeta 的 args[0]）
 *   * 形状守卫（GuardShape）—— 形状是编译期已知的，这条守卫本身也能消掉
 *   * 落进帧的某一格（StoreR）—— 真把它拆了的话这一句跟着消
 * 反过来，凡是**被当成值传出去**的（进 CallRT/CallLua/Bc 的实参、当 StoreField 的值
 * 写进别的表、当块的返回值）都算逃逸。
 *
 * ⚠️ StoreR 算"不逃逸"是**乐观**的：跨块（或跨 S_BC 屏障）再从那一格读回来时，
 *    真要拆就得有 deopt 时把对象**重新造出来**的能力。所以这个数是**上界**。
 */
static void ssa_escape_count(SsaFunc *f, int *nallocOut, int *nfieldOut, int *nsinkOut, int *why3,
                             uint8_t *sinkable /* 可为 NULL；非空时按值编号填 1 = 拆得动 */) {
    int nalloc = 0, nfield = 0, nsink = 0;
    for (int32_t a = 0; a < f->nval; a++) {
        if (f->vals[a].op != S_ALLOC_SHAPED) continue;
        nalloc++;
        int escaped = 0, valueUse = 0;      /* escaped=帧那一关；valueUse=被当成值传出去 */
        int liveWorst = 0;                  /* 1=块内又读回来 2=卡在屏障 3=活到块尾 */
        SsaOp why = S_RET; int64_t whyAux = -1;
        for (int32_t i = 0; i < f->nval; i++) {
            SsaVal *v = &f->vals[i];
            for (int k = 0; k < SSA_MAXARG; k++) {
                if (v->args[k] != a) continue;
                switch (v->op) {
                case S_LOAD_FIELD: case S_GUARD_SHAPE:
                    break;
                case S_STORE_R: {
                    /* 落进帧的第 aux 格。这一格在块内还被读回来（或活到块尾、或中间有屏障
                       可能照帧取值）的话，要拆它就得有 deopt 重造的能力 —— 这一刀不接。 */
                    int32_t bi2 = v->blk, at = -1;
                    if (bi2 < 0) { escaped = 1; break; }
                    for (int32_t j = 0; j < f->blks[bi2].nval; j++)
                        if (f->blks[bi2].vals[j] == i) { at = j; break; }
                    if (at < 0) { escaped = 1; break; }
                    int lv = ssa_slot_live_after(f, bi2, at, v->aux);
                    if (lv) {
                        escaped = 1; why = v->op; whyAux = v->aux;
                        if (lv > liveWorst) liveWorst = lv;
                    }
                    break;
                }
                case S_STORE_FIELD: case S_SET_META:
                    if (k != 0) { valueUse = 1; why = v->op; whyAux = v->aux; }
                    break;
                default:
                    valueUse = 1; why = v->op; whyAux = v->aux;
                }
            }
        }
        for (int32_t bi = 0; bi < f->nblk; bi++)
            if (f->blks[bi].ctrl == a) { valueUse = 1; why = S_RET; }   /* return 出去了 */
        if (!valueUse) nfield++;
        if (!valueUse && !escaped) { nsink++; if (sinkable) sinkable[a] = 1; }
        else if (!valueUse && liveWorst >= 1 && liveWorst <= 3) why3[liveWorst - 1]++;
        if ((valueUse || escaped) && getenv("OMNI_SSA_WHY"))
            fprintf(stderr, "   v%d（造表）逃逸：卡在 %s [aux=%lld]（活性档 %d）\n",
                    a, ssa_opname(why), (long long)whyAux, liveWorst);
    }
    *nallocOut = nalloc; *nfieldOut = nfield; *nsinkOut = nsink;
}

/* ---- dump（OMNI_SSA=1 打开）---- */

static const char *ssa_opname(SsaOp o) {
    switch (o) {
    case S_ARG: return "Arg"; case S_CONST: return "Const"; case S_PHI: return "Phi";
    case S_LOAD_R: return "LoadR"; case S_STORE_R: return "StoreR";
    case S_FADD: return "FAdd"; case S_FSUB: return "FSub";
    case S_FMUL: return "FMul"; case S_FDIV: return "FDiv";
    case S_FLT: return "FLt"; case S_FLE: return "FLe"; case S_FEQ: return "FEq";
    case S_BOX: return "Box"; case S_UNBOX: return "Unbox";
    case S_GUARD_NUM: return "GuardNum"; case S_GUARD_SHAPE: return "GuardShape";
    case S_LOAD_FIELD: return "LoadField"; case S_STORE_FIELD: return "StoreField";
    case S_ALLOC_SHAPED: return "AllocShaped"; case S_SET_META: return "SetMeta";
    case S_CALL_RT: return "CallRT"; case S_CALL_LUA: return "CallLua";
    case S_BC: return "Bc";
    case S_RET: return "Ret"; default: return "?";
    }
}

static void ssa_dump(SsaFunc *f, const char *why) {
    fprintf(stderr, "== ssa %s: nreg=%u blocks=%d values=%d (%s)\n",
            why, f->nreg, f->nblk, f->nval, f->fn ? "ok" : "-");
    for (int32_t bi = 0; bi < f->nblk; bi++) {
        SsaBlk *bb = &f->blks[bi];
        fprintf(stderr, "  b%d [bc %u..%u]", bi, bb->bcStart, bb->bcEnd);
        if (bb->kind == BK_RET) fprintf(stderr, " ret v%d", bb->ctrl);
        else if (bb->kind == BK_IF) fprintf(stderr, " if v%d -> b%d else b%d", bb->ctrl, bb->succ[0], bb->succ[1]);
        else fprintf(stderr, " -> b%d", bb->succ[0]);
        fprintf(stderr, "\n");
        for (int32_t i = 0; i < bb->nval; i++) {
            int32_t vi = bb->vals[i];
            SsaVal *v = &f->vals[vi];
            fprintf(stderr, "    v%-3d = %-11s", vi, ssa_opname(v->op));
            for (int a = 0; a < SSA_MAXARG; a++) if (v->args[a] >= 0) fprintf(stderr, " v%d", v->args[a]);
            if (v->op == S_LOAD_R || v->op == S_STORE_R) fprintf(stderr, " [r%lld]", (long long)v->aux);
            else if (v->op == S_BC) fprintf(stderr, " [%s@%lld]", omni_op_name[f->fn->code[v->aux]], (long long)v->aux);
            else if (v->op == S_LOAD_FIELD) fprintf(stderr, " [+%lld]", (long long)v->aux);
            else if (v->op == S_CONST) fprintf(stderr, " =%#llx", (unsigned long long)v->aux);
            if (v->type == T_NUM) fprintf(stderr, " :num");
            else if (v->type == T_TAB) fprintf(stderr, " :tab");
            fprintf(stderr, " (%u uses)\n", v->nuse);
        }
    }
}

static void ssa_free(SsaFunc *f) {
    for (int32_t bi = 0; bi < f->nblk; bi++) { free(f->blks[bi].vals); free(f->blks[bi].rdefs); }
    free(f->blks); free(f->vals); free(f->bcToBlk);
    free(f->liveIn); free(f->liveOut); free(f->valOfPc);
}

/** Tier 2 的入口。
 *  回 0 = 这个函数 Tier 2 接不了，照旧走 Tier 1/解释器。 */
static int ssa_try(OmniFn *fn, const char *name) {
    /* 还不发码 ⇒ 建图纯粹是编译期的白工（method 那种 11ms 的例子上量得到 +2.4%）。
       等 emit 那一格接上再默认打开；现在只在 OMNI_SSA=1 时建。 */
    static int on = -1;
    if (on < 0) on = getenv("OMNI_SSA") ? 1 : 0;
    if (!on) return 0;
    SsaFunc f;
    memset(&f, 0, sizeof(f));
    f.fn = fn;
    /* 内联出来的被调方窗口也要有帧格可占 —— 这一层不发码，多留一截不花钱 */
    f.nreg = (fn->nreg ? fn->nreg : 1) + SSA_INLINE_PAD;
    f.realNreg = fn->nreg ? fn->nreg : 1;
    f.scratchTop = (int32_t)(fn->nreg ? fn->nreg : 1);
    int ok = ssa_split_blocks(&f) && ssa_translate(&f);
    if (ok) ssa_liveness(&f);
    if (ok && getenv("OMNI_SSA")) {
        int nalloc = 0, nfield = 0, nsink = 0, why3[3] = {0, 0, 0};
        ssa_escape_count(&f, &nalloc, &nfield, &nsink, why3, NULL);
        ssa_dump(&f, name ? name : "fn");
        fprintf(stderr, "== ssa 逃逸：造表点 %d 个；只被读字段的 %d 个；连帧那一关也过的 %d 个"
                        "（卡住的：块内又读 %d、屏障 %d、活到块尾 %d）\n",
                nalloc, nfield, nsink, why3[0], why3[1], why3[2]);
        int ng = 0, nr = 0;
        ssa_guard_cse_count(&f, &ng, &nr);
        if (ng) fprintf(stderr, "== ssa 形状守卫 %d 条，其中 %d 条是白守的（同块同值同形状，中间没出去过 C）\n",
                        ng, nr);
    }
    ssa_free(&f);
    return 0;      /* 还不发码 */
}
