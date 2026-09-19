/* src/core/lua/jit-a64.c —— **Tier 1 基线 JIT**（照 Sparkplug 的形状）
 *
 * 一条字节码一段 arm64 机器码。不做优化（不改指令顺序、不合并、不做寄存器分配），
 * 只把派发开销去掉。反馈槽号在机器码里是**立即数**——以后优化层照着升。
 *
 * 寄存器约定（被调方保存，跨字节码不变）：
 *   x19 = R    寄存器文件（OVal *，从帧的 calloc 来）
 *   x20 = K    常量池（OVal *）
 *   x21 = acc  累加器（NaN-boxed OVal）
 *   x22 = cells  cells 指针（OVal **）
 *   x23 = vm_ic_base（当前帧的 IC 偏移，int32_t）
 *
 * 调用 C 辅助函数时照 AAPCS64：x0-x7 传参，x0 回值，d0-d7 浮点。
 * x19-x28 由被调方保存——我们的辅助函数不会改它们。
 *
 * 代码缓冲：mmap(MAP_JIT) + pthread_jit_write_protect_np（macOS ARM64）。
 */
/* OmniFn — defined in vm.c (this file is #include'd from there) */
/* lua-rt.h and bc-defs.h already included by vm.c */
#include <sys/mman.h>
#include <pthread.h>

/* ---- 机器码缓冲 ---- */

#define JIT_BUF_SIZE (4 * 1024 * 1024)  /* 4MB per compilation unit */

typedef struct {
    uint32_t *buf;      /* mmap'd W^X buffer */
    uint32_t *p;        /* write cursor */
    uint32_t *end;
} JitBuf;

static JitBuf jit_alloc(void) {
    void *mem = mmap(NULL, JIT_BUF_SIZE, PROT_READ | PROT_WRITE | PROT_EXEC,
                     MAP_PRIVATE | MAP_ANONYMOUS | MAP_JIT, -1, 0);
    if (mem == MAP_FAILED) { perror("mmap JIT"); exit(1); }
    JitBuf b;
    b.buf = (uint32_t *)mem;
    b.p = b.buf;
    b.end = (uint32_t *)((char *)mem + JIT_BUF_SIZE);
    return b;
}

static void jit_make_exec(JitBuf *b) {
    (void)b;
    /* On macOS, toggle W^X: we were writing, now switch to execute */
    pthread_jit_write_protect_np(1);
    /* Flush icache for the range we wrote */
    __builtin___clear_cache((char *)b->buf, (char *)b->p);
}

static void jit_make_writable(void) {
    pthread_jit_write_protect_np(0);
}

/** 放弃这一格编译：**必须把 W^X 标志恢复**，不然这条线程后面所有 MAP_JIT 页都不可执行。 */
static void jit_bail(JitBuf *b) {
    pthread_jit_write_protect_np(1);
    munmap(b->buf, JIT_BUF_SIZE);
}

/* ---- arm64 instruction encoding helpers ---- */

static inline void emit(JitBuf *b, uint32_t insn) {
    *b->p++ = insn;
}

/* MOV Xd, Xn (ORR Xd, XZR, Xn) */
static inline void emit_mov(JitBuf *b, int rd, int rn) {
    emit(b, 0xAA0003E0 | (rn << 16) | rd);
}

/* MOV Xd, #imm16 (MOVZ Xd, #imm16, LSL #0) */
static inline void emit_movz(JitBuf *b, int rd, uint16_t imm) {
    emit(b, 0xD2800000 | ((uint32_t)imm << 5) | rd);
}

/* MOVK Xd, #imm16, LSL #shift (shift = 0/16/32/48) */
static inline void emit_movk(JitBuf *b, int rd, uint16_t imm, int shift) {
    uint32_t hw = (uint32_t)(shift / 16);
    emit(b, 0xF2800000 | (hw << 21) | ((uint32_t)imm << 5) | rd);
}

/* Load 64-bit immediate into Xd */
static void emit_mov64(JitBuf *b, int rd, uint64_t val) {
    emit_movz(b, rd, (uint16_t)(val & 0xFFFF));
    if (val >> 16) emit_movk(b, rd, (uint16_t)((val >> 16) & 0xFFFF), 16);
    if (val >> 32) emit_movk(b, rd, (uint16_t)((val >> 32) & 0xFFFF), 32);
    if (val >> 48) emit_movk(b, rd, (uint16_t)((val >> 48) & 0xFFFF), 48);
}

/* LDR Xt, [Xn, #imm12*8] (unsigned offset, 64-bit) */
static inline void emit_ldr(JitBuf *b, int rt, int rn, int offset8) {
    emit(b, 0xF9400000 | ((uint32_t)(offset8 & 0xFFF) << 10) | (rn << 5) | rt);
}

/* STR Xt, [Xn, #imm12*8] */
static inline void emit_str(JitBuf *b, int rt, int rn, int offset8) {
    emit(b, 0xF9000000 | ((uint32_t)(offset8 & 0xFFF) << 10) | (rn << 5) | rt);
}

/* LDR Xt, [Xn, Xm, LSL #3] (register offset) */
static inline void emit_ldr_reg(JitBuf *b, int rt, int rn, int rm) {
    emit(b, 0xF8607800 | (rm << 16) | (rn << 5) | rt);
}

/* STR Xt, [Xn, Xm, LSL #3] */
static inline void emit_str_reg(JitBuf *b, int rt, int rn, int rm) {
    emit(b, 0xF8207800 | (rm << 16) | (rn << 5) | rt);
}

/* BL offset (offset in instructions, signed 26-bit) */
static inline void emit_bl(JitBuf *b, int32_t off) {
    emit(b, 0x94000000 | (uint32_t)(off & 0x03FFFFFF));
}

/* BR Xn */
static inline void emit_br(JitBuf *b, int rn) {
    emit(b, 0xD61F0000 | (rn << 5));
}

/* BLR Xn */
static inline void emit_blr(JitBuf *b, int rn) {
    emit(b, 0xD63F0000 | (rn << 5));
}

/* RET */
static inline void emit_ret(JitBuf *b) {
    emit(b, 0xD65F03C0);
}

/* B offset (unconditional branch, offset in instructions) */
static inline void emit_b(JitBuf *b, int32_t off) {
    emit(b, 0x14000000 | (uint32_t)(off & 0x03FFFFFF));
}

/* B.cond offset */
static inline void emit_bcond(JitBuf *b, int cond, int32_t off) {
    emit(b, 0x54000000 | ((uint32_t)(off & 0x7FFFF) << 5) | cond);
}

/* CMP Xn, Xm (SUBS XZR, Xn, Xm) */
static inline void emit_cmp(JitBuf *b, int rn, int rm) {
    emit(b, 0xEB00001F | (rm << 16) | (rn << 5));
}

/* CMP Xn, #imm12 (SUBS XZR, Xn, #imm12) */
static inline void emit_cmp_imm(JitBuf *b, int rn, uint32_t imm12) {
    emit(b, 0xF100001F | ((imm12 & 0xFFF) << 10) | (rn << 5));
}

/* LSR Xd, Xn, #imm (UBFM Xd, Xn, #imm, #63) */
static inline void emit_lsr(JitBuf *b, int rd, int rn, int imm) {
    emit(b, 0xD340FC00 | ((uint32_t)imm << 16) | (rn << 5) | rd);
}

/* ADD Xd, Xn, Xm */
static inline void emit_add(JitBuf *b, int rd, int rn, int rm) {
    emit(b, 0x8B000000 | (rm << 16) | (rn << 5) | rd);
}

/* SUB Xd, Xn, Xm */
static inline void emit_sub(JitBuf *b, int rd, int rn, int rm) {
    emit(b, 0xCB000000 | (rm << 16) | (rn << 5) | rd);
}

/* FCVTZS Xd, Dn（double → 64 位有符号，截断） */
static inline void emit_fcvtzs(JitBuf *b, int rd, int dn) {
    emit(b, 0x9E780000 | (dn << 5) | rd);
}
/* SCVTF Dd, Xn（64 位有符号 → double） */
static inline void emit_scvtf(JitBuf *b, int dd, int rn) {
    emit(b, 0x9E620000 | (rn << 5) | dd);
}
/* FCMP Dn, Dm */
static inline void emit_fcmp2(JitBuf *b, int dn, int dm) {
    emit(b, 0x1E602000 | (dm << 16) | (dn << 5));
}
/* FMOV Dd, Xn */
static inline void emit_fmov_d_x(JitBuf *b, int dd, int xn) {
    emit(b, 0x9E670000 | (xn << 5) | dd);
}

/* FMOV Xd, Dn */
static inline void emit_fmov_x_d(JitBuf *b, int xd, int dn) {
    emit(b, 0x9E660000 | (dn << 5) | xd);
}

/* FADD Dd, Dn, Dm */
static inline void emit_fadd(JitBuf *b, int dd, int dn, int dm) {
    emit(b, 0x1E602800 | (dm << 16) | (dn << 5) | dd);
}

/* FSUB Dd, Dn, Dm */
static inline void emit_fsub(JitBuf *b, int dd, int dn, int dm) {
    emit(b, 0x1E603800 | (dm << 16) | (dn << 5) | dd);
}

/* FMUL Dd, Dn, Dm */
static inline void emit_fmul(JitBuf *b, int dd, int dn, int dm) {
    emit(b, 0x1E600800 | (dm << 16) | (dn << 5) | dd);
}

/* FDIV Dd, Dn, Dm */
static inline void emit_fdiv(JitBuf *b, int dd, int dn, int dm) {
    emit(b, 0x1E601800 | (dm << 16) | (dn << 5) | dd);
}

/* FCMP Dn, Dm */
static inline void emit_fcmp(JitBuf *b, int dn, int dm) {
    emit(b, 0x1E602000 | (dm << 16) | (dn << 5));
}

/* STP Xt1, Xt2, [Xn, #imm7*8]! (pre-index) */
static inline void emit_stp_pre(JitBuf *b, int rt1, int rt2, int rn, int imm7) {
    emit(b, 0xA9800000 | ((uint32_t)(imm7 & 0x7F) << 15) | (rt2 << 10) | (rn << 5) | rt1);
}

/* LDP Xt1, Xt2, [Xn], #imm7*8 (post-index) */
static inline void emit_ldp_post(JitBuf *b, int rt1, int rt2, int rn, int imm7) {
    emit(b, 0xA8C00000 | ((uint32_t)(imm7 & 0x7F) << 15) | (rt2 << 10) | (rn << 5) | rt1);
}

/* ---- NaN-boxing helpers ---- */

#define TAG_FIRST 0xFFF80001u

/* Check if xreg is a number: high32 < TAG_FIRST.
 * Clobbers x9, x10. After: B.CC means xreg is a number. */
static void emit_check_num(JitBuf *b, int xreg) {
    emit_lsr(b, 9, xreg, 32);
    emit_mov64(b, 10, TAG_FIRST);
    emit_cmp(b, 9, 10);
}

/* ---- The bytecode → machine code compiler ----
 *
 * 遍历字节码，逐条翻译。每条字节码的 PC 偏移映射到 native code 的地址（label table），
 * 跳转先记 fixup，最后回填。
 *
 * 调用约定（进入 JIT 代码时）：
 *   x19 = R (OVal *)
 *   x20 = K (OVal *)
 *   x21 = acc
 *   x22 = cells (OVal **)
 *   x23 = icBase (int32_t, but held in register as int64)
 */

#define REG_R    19
#define REG_K    20
#define REG_ACC  21
#define REG_CELLS 22
#define REG_ICBASE 23
#define REG_UP   25       /* x25 = 本闭包的 upvalue 数组（OVal **，第五个实参） */
#define REG_OBJS 26       /* x26 = omni_objs（对象登记表基址）—— 每次 C 调用之后重装 */
#define REG_GEN  27       /* x27 = omni_shape_gen 的**当前值**（同上，只有 C 里会改它） */

/* 读字节码操作数的辅助 */
#define BC_U8(code, pc)  ((code)[(pc)])
#define BC_U16(code, pc) ((uint16_t)((code)[(pc)] | ((code)[(pc)+1] << 8)))
#define BC_I32(code, pc) ((int32_t)((uint32_t)(code)[(pc)] | ((uint32_t)(code)[(pc)+1] << 8) \
                          | ((uint32_t)(code)[(pc)+2] << 16) | ((uint32_t)(code)[(pc)+3] << 24)))

/* Forward declaration — these are defined in vm.c (we're #include'd from there) */
/* No need for extern since we're in the same compilation unit */

/* STRB Wt, [Xn, #imm12]（写一个字节） */
static inline void emit_strb(JitBuf *b, int rt, int rn, int off) {
    emit(b, 0x39000000 | ((uint32_t)off << 10) | (rn << 5) | rt);
}
/* LDRB Wt, [Xn, #imm12]（读一个字节，零扩展） */
static inline void emit_ldrb(JitBuf *b, int rt, int rn, int off) {
    emit(b, 0x39400000 | ((uint32_t)off << 10) | (rn << 5) | rt);
}
/* STR Wt, [Xn, #imm12*4]（32 位写） */
static inline void emit_str32(JitBuf *b, int rt, int rn, int offset4) {
    emit(b, 0xB9000000 | ((uint32_t)offset4 << 10) | (rn << 5) | rt);
}
/* ORR Xd, Xn, Xm */
static inline void emit_orr(JitBuf *b, int rd, int rn, int rm) {
    emit(b, 0xAA000000 | (rm << 16) | (rn << 5) | rd);
}
/* LDR Wt, [Xn, #imm12*4]（32 位读，零扩展进 X） */
static inline void emit_ldr32(JitBuf *b, int rt, int rn, int offset4) {
    emit(b, 0xB9400000 | ((uint32_t)offset4 << 10) | (rn << 5) | rt);
}

/* Helper: emit a call to a C function with 0-4 args already in x0-x3.
 * Clobbers x12. Result in x0. */
static void emit_call_c(JitBuf *b, void *fn) {
    emit_mov64(b, 12, (uint64_t)(uintptr_t)fn);
    emit_blr(b, 12);
    /* C 里可能扩过对象表（realloc 会搬），回来重新装 x26。
       放在这一格里而不是各个调用点：保证一个站点都不漏（x9-x15 本来就是调用间不保值的）。 */
    emit_mov64(b, 9, (uint64_t)(uintptr_t)&omni_objs);
    emit_ldr(b, REG_OBJS, 9, 0);
    emit_mov64(b, 9, (uint64_t)(uintptr_t)&omni_shape_gen);
    emit_ldr32(b, REG_GEN, 9, 0);
}


/* Compile one OmniFn's bytecode into native arm64 code.
 * Returns a function pointer that takes (R, K, cells, icBase) and returns acc. */
/* JitFn 的定义在 vm.c（第三个参数是 OVal ***cellsp，见那儿的注释） */


/* ---- 相邻两条字节码之间的 store→load 转发（长度不变的原地改写）----
 *
 * Tier 1 是逐条翻译，所以 `StaR t` 以 `str x21,[x19,#t]` 收尾，紧跟的下一条
 * （`Add t,f` / `LdaR t` / `GetNamed t,…`）又以 `ldr x9,[x19,#t]` 开头 —— **紧挨着的一对**。
 * 把那条 ldr 原地改写成 `mov x9,x21`（同样长度，所以所有跳转偏移与 label 都不用动）。
 *
 * 安全性三条：
 *   1. 两条指令**紧邻**，中间什么都没有，所以源寄存器一定还是刚存进去那个值；
 *   2. 下一条字节码**不是跳转落点**（否则从别处跳进来时源寄存器里不是那个值）；
 *   3. 只认 base 是 x19（帧寄存器）、偏移相同的那一对。
 * 回 1 = 改写了（可以数一数省了多少条）。
 */
/** 后趟窥孔：在一段直线码里，把"刚写进 R[] 的值又从 R[] 读回来"消掉。
 *
 * 模式：`STR Xs, [x19, #off]` … `LDR Xd, [x19, #off]` ⇒ 把 LDR 替换成 `MOV Xd, Xs`
 *  （或 NOP 如果 d==s）。限制：
 *   1. 中间不许有**另一条 STR 写同一个 #off**（被覆写了就不是同一个值）
 *   2. 中间不许有 BLR / B / B.cond / CBZ / CBNZ / RET 或对 x19 的写（流控或基址变了）
 *   3. Xs 不许被中间的指令改写（它必须还活着）
 *
 * 这件事在 Tier 1 的线性发射器里做**最划算**，因为 90% 的码都是 R[]-traffic，
 * 而 Tier 2（寄存器分配）还远。
 *
 * 为什么不在两条 bytecode 之间做（像现有的 jit_fuse_store_load）：一条 bytecode 自己发的码
 * 就有好几条 STR/LDR，最热的比如"算术那段"读 R[r] 进 x9 → 算 → 结果到 x21(acc) → 下一条
 * LdaR/StaR → 从 R[] 读回 acc"这条链横跨一整条 emit_one 的范围。
 */
static int jit_peephole(uint32_t *start, uint32_t *end) {
    int nfused = 0;
    size_t n = (size_t)(end - start);
    if (n < 2) return 0;
    /* **先把所有分支落点标出来** —— 只有"控制流一定从那条 STR 流到这条 LDR"时才敢换。
       段内有别的入口（守卫失手跳进来的慢路就是）就不许跨过去。 */
    uint8_t *bound = (uint8_t *)calloc(n + 1, 1);
    if (bound == NULL) return 0;
    for (size_t i = 0; i < n; i++) {
        uint32_t w = start[i];
        int64_t off = 0; int has = 0;
        if ((w & 0xFC000000u) == 0x14000000u) {                  /* B imm26 */
            off = (int64_t)(int32_t)((w & 0x03FFFFFFu) << 6) >> 6; has = 1;
        } else if ((w & 0xFF000010u) == 0x54000000u              /* B.cond imm19 */
                || (w & 0x7F000000u) == 0x34000000u) {           /* CBZ/CBNZ imm19 */
            off = (int64_t)(int32_t)(((w >> 5) & 0x7FFFFu) << 13) >> 13; has = 1;
        } else if ((w & 0x7F000000u) == 0x36000000u) {           /* TBZ/TBNZ imm14 */
            off = (int64_t)(int32_t)(((w >> 5) & 0x3FFFu) << 18) >> 18; has = 1;
        }
        if (has) {
            int64_t t = (int64_t)i + off;
            if (t >= 0 && t <= (int64_t)n) bound[t] = 1;
        }
    }

    #define PH_WIN 16
    struct { uint16_t off; uint8_t src; uint8_t valid; } recent[PH_WIN];
    int ri = 0;
    memset(recent, 0, sizeof(recent));

    for (size_t i = 0; i < n; i++) {
        uint32_t w = start[i];
        if (bound[i]) { memset(recent, 0, sizeof(recent)); ri = 0; }
        /* STR Xs, [x19, #imm12*8] */
        if ((w & 0xFFC00000u) == 0xF9000000u && ((w >> 5) & 31) == REG_R) {
            recent[ri].off = (uint16_t)((w >> 10) & 0xFFF);
            recent[ri].src = (uint8_t)(w & 31);
            recent[ri].valid = 1;
            ri = (ri + 1) & (PH_WIN - 1);
            continue;
        }
        /* LDR Xd, [x19, #imm12*8] */
        if ((w & 0xFFC00000u) == 0xF9400000u && ((w >> 5) & 31) == REG_R) {
            uint16_t off = (uint16_t)((w >> 10) & 0xFFF);
            uint8_t dst = (uint8_t)(w & 31);
            for (int j = 0; j < PH_WIN; j++) {
                int idx = ((ri - 1 - j) + PH_WIN) & (PH_WIN - 1);
                if (!recent[idx].valid) break;
                if (recent[idx].off == off) {
                    uint8_t src = recent[idx].src;
                    start[i] = (src == dst) ? 0xD503201Fu                 /* NOP */
                        : (0xAA0003E0u | ((uint32_t)src << 16) | (uint32_t)dst);  /* MOV Xd,Xs */
                    nfused++;
                    break;
                }
            }
            for (int j = 0; j < PH_WIN; j++)
                if (recent[j].valid && recent[j].src == dst) recent[j].valid = 0;
            continue;
        }
        /* 流控 / 基址被改 ⇒ 整窗作废 */
        int flush = 0;
        if ((w & 0xFFFFFC1Fu) == 0xD63F0000u) flush = 1;   /* BLR Xn */
        if ((w & 0xFC000000u) == 0x14000000u) flush = 1;   /* B */
        if ((w & 0xFF000010u) == 0x54000000u) flush = 1;   /* B.cond */
        if ((w & 0x7F000000u) == 0x34000000u) flush = 1;   /* CBZ/CBNZ */
        if ((w & 0x7F000000u) == 0x36000000u) flush = 1;   /* TBZ/TBNZ */
        if (w == 0xD65F03C0u) flush = 1;                   /* RET */
        if ((w & 31) == REG_R) flush = 1;                  /* 任何动 x19 的（内联体挪窗口就是） */
        if (flush) { memset(recent, 0, sizeof(recent)); ri = 0; continue; }
        /* 其余：它写了哪个寄存器，就把以那个为 src 的记录作废 */
        uint8_t wdst = (uint8_t)(w & 31);
        for (int j = 0; j < PH_WIN; j++)
            if (recent[j].valid && recent[j].src == wdst) recent[j].valid = 0;
    }
    #undef PH_WIN
    free(bound);
    return nfused;
}

static int jit_fuse_store_load(uint32_t *stAt, uint32_t *ldAt) {
    uint32_t st = *stAt, ld = *ldAt;
    if ((st & 0xFFC00000u) != 0xF9000000u) return 0;      /* STR Xt,[Xn,#imm] ? */
    if ((ld & 0xFFC00000u) != 0xF9400000u) return 0;      /* LDR Xt,[Xn,#imm] ? */
    if (((st >> 5) & 31) != REG_R || ((ld >> 5) & 31) != REG_R) return 0;
    if (((st >> 10) & 0xFFF) != ((ld >> 10) & 0xFFF)) return 0;
    int src = (int)(st & 31), dst = (int)(ld & 31);
    *ldAt = (src == dst) ? 0xD503201Fu                    /* 一样的寄存器 ⇒ NOP */
                         : (0xAA0003E0u | ((uint32_t)src << 16) | (uint32_t)dst);  /* MOV Xd,Xs */
    return 1;
}

/* 跳转的回填记录（Tier 1 与 Tier 2 共用） */
typedef struct { uint32_t *patch; uint32_t target_bc; int kind; /* 0=B, 1=B.cond */ } Fixup;

/* MOV Wd, Wn（32 位；写 W 会把高 32 位清零 —— 拿它取 OVal 的低 32 位对象号） */
static inline void emit_mov32(JitBuf *b, int rd, int rn) {
    emit(b, 0x2A0003E0 | (rn << 16) | rd);
}
/* 先发一条占位的前向分支，回它的地址（之后 jit_patch_fwd 填成"跳到这儿"） */
static inline uint32_t *jit_fwd_bcond(JitBuf *b, int cond) {
    uint32_t *at = b->p; emit_bcond(b, cond, 0); return at;
}
/* CBZ Xn, +off（占位；用 jit_patch_fwd 回填 —— 它按 B.cond 的 imm19 位置写，正好一样） */
static inline uint32_t *jit_fwd_cbz(JitBuf *b, int rn) {
    uint32_t *at = b->p; emit(b, 0xB4000000 | rn); return at;
}
static inline uint32_t *jit_fwd_b(JitBuf *b) {
    uint32_t *at = b->p; emit_b(b, 0); return at;
}
static void jit_patch_fwd(JitBuf *b, uint32_t *at) {
    int32_t off = (int32_t)(b->p - at);
    if ((*at & 0xFF000000u) == 0x54000000u        /* B.cond：imm19 在 bit5..23 */
        || (*at & 0xFF000000u) == 0xB4000000u) {  /* CBZ：imm19 也在 bit5..23 */
        *at = (*at & ~(0x7FFFFu << 5)) | (((uint32_t)off & 0x7FFFF) << 5);
    } else {                                     /* B：imm26 在 bit0..25 */
        *at = (*at & ~0x03FFFFFFu) | ((uint32_t)off & 0x03FFFFFFu);
    }
}

/* ---- 去虚化 + 内联的上下文（照 Go 的 devirtualize → inline 次序）----
 *
 * Go 那边是：PGO 找到"这个点主要打到哪个具体函数" → 发一条 `fnPC == concretePC` 的守卫 →
 * 守卫内那条调用变成直接调用，于是内联器能看进去（devirtualize/pgo.go:596 那一段）。
 * 我们的对应件：调用点反馈槽里记着**那个闭包值**，守卫就是比它；比中了被调方的
 * proto 与 upvalue 数组都是编译期常量，于是它的字节码可以就地展开。
 *
 * 展开时这三样在内联区间里换成被调方的：x19（帧基址，挪到 base+1）、x20（常量池）、
 * x23（反馈槽基址）。出了区间再换回来 —— 两边都是编译期常量，所以只是几条 mov。
 * jit_inline_up 非 NULL 时 LdaUp/StaUp 才发得出来（upvalue 地址成了常量）。
 */
static OVal **jit_inline_up = NULL;
static int jit_inline_depth = 0;
#define JIT_INLINE_MAX_BC 128    /* 被调方字节码上限 —— 照 shouldPGODevirt 的"能内联才做" */
#ifndef JIT_INLINE_MAX_DEPTH
#define JIT_INLINE_MAX_DEPTH 2   /* 内联层数（被调方里还有 Call 就再展一层） */
#endif

/** 这条字节码在内联体里发得出来吗（白名单：直线码、无调用、无闭包） */
static int jit_inline_op_ok(uint8_t op) {
    switch (op) {
        case OP_LdaNil: case OP_LdaTrue: case OP_LdaFalse: case OP_LdaK:
        case OP_LdaR: case OP_StaR: case OP_Mov:
        case OP_LdaGlobal: case OP_StaGlobal:
        case OP_LdaUp: case OP_StaUp:
        case OP_Add: case OP_Sub: case OP_Mul: case OP_Div: case OP_Mod:
        case OP_Pow: case OP_Concat: case OP_Neg: case OP_Not: case OP_Len:
        case OP_Eq: case OP_Ne: case OP_Lt: case OP_Le: case OP_Gt: case OP_Ge:
        case OP_NewTable: case OP_NewShaped:
        case OP_GetNamed: case OP_SetNamed: case OP_GetKeyed: case OP_SetKeyed:
        case OP_SetMeta: case OP_GetFields:
        case OP_Nop:
            return 1;
        case OP_Call:
            /* 内联体里还能有调用：能再内联就再展一层，不能就照旧调 jit_call_helper
               （x19 此时指着内层窗口，helper 自己另开帧，两不相干）。 */
            return 1;
        default:
            return 0;   /* 跳转、Closure、RetMulti、变长参数 —— 这一刀都不接 */
    }
}

/** 这个 Call 点内联之后，被调方一侧要占多高的窗口（含它自己再内联出来的层） */
static OmniFn *jit_inline_target(OmniFn *fn, uint32_t pc, int depth,
                                 OVal *fvOut, uint32_t *winOut);

static uint32_t jit_inline_need(OmniFn *ce, int depth) {
    uint32_t need = ce->nreg ? ce->nreg : 1;
    if (depth + 1 < JIT_INLINE_MAX_DEPTH) {
        uint32_t q = 0;
        while (q < ce->codeLen) {
            if (ce->code[q] == OP_Call) {
                uint32_t w = 0;
                if (jit_inline_target(ce, q, depth + 1, NULL, &w)) {
                    uint32_t t = (uint32_t)ce->code[q + 1] + 1 + w;
                    if (t > need) need = t;
                }
            }
            q += omni_bc_len_at(ce->code, q);
        }
    }
    return need;
}

/** 这个 proto + 闭包值能就地展开吗（与调用点无关的那部分判据）。
    能就回 1 并给出窗口高度。算术点的元方法内联复用这一格。 */
static int jit_inline_fn_ok(OmniFn *ce, OVal fv, uint32_t argc, int depth, uint32_t *winOut) {
    if (ce == NULL || ce->isVararg || argc != ce->nparams || ce->codeLen > JIT_INLINE_MAX_BC)
        return 0;
    uint32_t q = 0; int sawRet = 0;
    while (q < ce->codeLen) {
        uint8_t o = ce->code[q];
        if (o == OP_Ret) { sawRet = 1; break; }
        if (!jit_inline_op_ok(o)) return 0;
        q += omni_bc_len_at(ce->code, q);
    }
    if (!sawRet) return 0;
    BCClo *clo = bcclo_get(fv);
    if (clo->native || clo->fn != ce) return 0;
    if (winOut) *winOut = jit_inline_need(ce, depth);
    return 1;
}

/** 这个 Call 点（pc 指着 OP_Call）能内联吗？能就回被调方、那个闭包值与它要的窗口高度。
    **不查窗口是否放得下** —— 那件事 jit_compile 先按这里的结果把 fn->nreg 抬够。 */
static OmniFn *jit_inline_target(OmniFn *fn, uint32_t pc, int depth,
                                 OVal *fvOut, uint32_t *winOut) {
    const uint8_t *code = fn->code;
    uint8_t argc = code[pc + 2];
    uint16_t cf = BC_U16(code, pc + 3);
    OVal fv = 0;
    OmniFn *ce = call_site_mono(fn->icBase + (int32_t)cf, &fv);
    if (ce == NULL || ce->isVararg || argc != ce->nparams || ce->codeLen > JIT_INLINE_MAX_BC)
        return NULL;
    /* 白名单预扫：全是直线码，最后一条是 Ret，中间不许有 Ret */
    /* 白名单预扫：**到第一条 Ret 为止**全是直线码就行 —— 前缀里没有任何跳转，
       Ret 又是无条件出口，所以 Ret 之后那些码（发射器给函数末尾补的 LdaNil+Ret 之类）
       永远到不了，不必管。 */
    uint32_t q = 0; int sawRet = 0;
    while (q < ce->codeLen) {
        uint8_t o = ce->code[q];
        if (o == OP_Ret) { sawRet = 1; break; }
        if (!jit_inline_op_ok(o)) {
            if (getenv("OMNI_JIT_DEBUG"))
                fprintf(stderr, "jit: 不内联 @%u：被调方 %s@%u 不在白名单\n",
                        pc, omni_op_name[o], q);
            return NULL;
        }
        q += omni_bc_len_at(ce->code, q);
    }
    if (!sawRet) {
        if (getenv("OMNI_JIT_DEBUG"))
            fprintf(stderr, "jit: 不内联 @%u：被调方没有 Ret\n", pc);
        return NULL;
    }
    BCClo *clo = bcclo_get(fv);
    if (clo->native || clo->fn != ce) return NULL;
    if (fvOut) *fvOut = fv;
    if (winOut) *winOut = jit_inline_need(ce, depth);
    return ce;
}

/* OTab 的字段偏移（真相是 lua-rt.h 末尾那几条 _Static_assert），单位是 8 字节 */
#define TAB_META_8  4
#define TAB_SHAPE_8 5
#define TAB_SVALS_8 6

/* ---- 帧寄存器的读写：被内层闭包捕获的那几格要走 cells[] ----
 *
 * `jit_captured[r] == 0`（常态）时发的字节与直取**一模一样**，就一条 ldr/str；
 * 只有被捕获的槽才多一跳 `cells[r] ? *cells[r] : R[r]`（与解释器逐条对应）。
 * 位图由 jit_compile 预扫算出（Closure 的 upvalue 列表里 kind==0 的那些 idx），
 * 用文件级 static 传 —— 编译是单线程的，省得给 jit_emit_one 改签名。
 */
static const uint8_t *jit_captured = NULL;
static uint32_t jit_captured_n = 0;

static inline int jit_is_captured(uint32_t r) {
    return jit_captured != NULL && r < jit_captured_n && jit_captured[r];
}

static void emit_read_r(JitBuf *b, int dst, uint32_t r) {
    if (!jit_is_captured(r)) { emit_ldr(b, dst, REG_R, (int)r); return; }
    emit_ldr(b, 14, REG_CELLS, (int)r);          /* x14 = cells[r] */
    emit_cmp_imm(b, 14, 0);
    uint32_t *isNull = jit_fwd_bcond(b, 0);      /* B.EQ → 直取 */
    emit_ldr(b, dst, 14, 0);                     /* dst = *cells[r] */
    uint32_t *done = jit_fwd_b(b);
    jit_patch_fwd(b, isNull);
    emit_ldr(b, dst, REG_R, (int)r);
    jit_patch_fwd(b, done);
}

static void emit_write_r(JitBuf *b, int src, uint32_t r) {
    if (!jit_is_captured(r)) { emit_str(b, src, REG_R, (int)r); return; }
    emit_ldr(b, 14, REG_CELLS, (int)r);
    emit_cmp_imm(b, 14, 0);
    uint32_t *isNull = jit_fwd_bcond(b, 0);
    emit_str(b, src, 14, 0);
    uint32_t *done = jit_fwd_b(b);
    jit_patch_fwd(b, isNull);
    emit_str(b, src, REG_R, (int)r);
    jit_patch_fwd(b, done);
}

/**
 * **字段读的内联缓存：发成指令，不发调用** —— v8 赢的就是这一档。
 *
 * 只在这个访问点的反馈是**单态且字段在自己身上**时特化。守卫与 `omni_tab_get_ic`
 * 的快路逐条对应（是表 / shape 同 / meta 同 / gen 同），所以命中时答案一模一样；
 * 不符就落到慢路，照旧调 jit_getnamed_helper（它会重填缓存）。
 *
 * 为什么非得在这一层做：量过 —— 同样一套检查**发到 LLVM IR 里更慢**
 * （shape/gen 的 load 跨不过任何调用，CSE 不掉）。要它就得自己发机器码。
 *
 * 回 1 = 发了特化版；回 0 = 没反馈，调用方发通用版。
 */
static int jit_gn_stat[5];   /* [0]=发了 [1]=槽越界 [2]=没反馈/换过代 [3]=负缓存 [4]=偏移太大 */
static int jit_emit_getnamed_ic(JitBuf *b, OmniFn *fn, uint8_t r, uint16_t k, uint16_t f) {
    int32_t id = fn->icBase + (int32_t)f;
    if (id < 0 || id >= vm_ics_n) { jit_gn_stat[1]++; return 0; }
    OIC *ic = &omni_ics[id];
    if (ic->shape == NULL || ic->gen != omni_shape_gen) {
        jit_gn_stat[2]++;
        if (getenv("OMNI_JIT_DEBUG2")) {
            OVal kv = fn->K[k];
            const char *nm = oval_is_str(kv) ? ((OStr *)omni_objs[(uint32_t)kv])->data : "?";
            fprintf(stderr, "jit: GetNamed 无反馈 proto %p 槽 %d 键 %s（shape=%p gen=%u vs %u）\n",
                    (void *)fn, id, nm, (void *)ic->shape, ic->gen, omni_shape_gen);
        }
        return 0;
    }
    if (ic->off < 0) { jit_gn_stat[3]++; return 0; }  /* 负缓存：不特化 */
    if (ic->off > 500) { jit_gn_stat[4]++; return 0; } /* 偏移超出 imm12 能表示的范围 */
    /* holder != 0 = 命中在原型上（`obj:method()` 这一档，smallpt 里到处是）。
       holder 那张表的 OTab* 是常量（对象登记表里的格子不会搬），gen 守卫又盖住了
       "加字段/换元表"这两种变化，所以可以把它烧成立即数，取值就是两条 load。 */
    OTab *holderTab = NULL;
    if (ic->holder != 0) {
        if (oval_tag(ic->holder) != OVAL_TAG_TAB) return 0;
        holderTab = (OTab *)omni_objs[(uint32_t)ic->holder];
        if (holderTab == NULL) return 0;
    }

    uint32_t *miss[4]; int nmiss = 0;
    emit_read_r(b, 9, r);                        /* x9 = R[r] */
    emit_lsr(b, 10, 9, 32);                          /* x10 = high32(tv) */
    emit_mov64(b, 11, (uint64_t)OVAL_TAG_TAB);
    emit_cmp(b, 10, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);             /* B.NE → 慢路 */

    emit_mov32(b, 12, 9);                            /* x12 = 低 32 位 = 对象号 */
    emit_ldr_reg(b, 12, REG_OBJS, 12);               /* x12 = OTab*（x26 = omni_objs） */

    emit_ldr(b, 10, 12, TAB_SHAPE_8);
    emit_mov64(b, 11, (uint64_t)(uintptr_t)ic->shape);
    emit_cmp(b, 10, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);

    emit_ldr(b, 10, 12, TAB_META_8);
    emit_mov64(b, 11, (uint64_t)ic->meta);
    emit_cmp(b, 10, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);

    /* **holder == 0 时不必查 gen**：值就在接收方自己的 svals 里，偏移由它的 shape 决定，
       而 shape 已经比过了（G 加一个全局 / 表加一个字段都会换 shape）。
       命中在原型上那一档才要 gen —— 它是"原型那张表的形状没动过"的近似判据。 */
    if (holderTab != NULL) {
        emit_mov64(b, 11, (uint64_t)ic->gen);
        emit_cmp(b, REG_GEN, 11);                    /* x27 = omni_shape_gen 的当前值 */
        miss[nmiss++] = jit_fwd_bcond(b, 1);
    }

    if (holderTab == NULL) {
        emit_ldr(b, 10, 12, TAB_SVALS_8);            /* x10 = t->svals */
    } else {
        emit_mov64(b, 10, (uint64_t)(uintptr_t)holderTab);
        emit_ldr(b, 10, 10, TAB_SVALS_8);            /* x10 = holder->svals */
    }
    emit_ldr(b, REG_ACC, 10, ic->off);               /* acc = svals[off] */
    uint32_t *done = jit_fwd_b(b);

    for (int i = 0; i < nmiss; i++) jit_patch_fwd(b, miss[i]);
    emit_read_r(b, 0, r);
    emit_ldr(b, 1, REG_K, k);
    emit_mov(b, 2, REG_ICBASE);
    emit_movz(b, 9, f);
    emit_add(b, 2, 2, 9);
    emit_call_c(b, (void *)jit_getnamed_helper);
    emit_mov(b, REG_ACC, 0);
    jit_patch_fwd(b, done);
    jit_gn_stat[0]++;
    return 1;
}

/**
 * **GetFields 的守卫共享版**：一次守卫 + n 条定偏移 load，全发成指令。
 *
 * 这一格正是当初"per-site 内联缓存不划算"那条结论里说的**唯一出路**：
 * `a.x/a.y/a.z` 本来是三份一模一样的守卫，GetFields 把三个读并成一条字节码之后，
 * 守卫只发一遍、三个偏移都是编译期立即数。守卫条件与 omni_tab_getn_ic 的快路逐条对应。
 *
 * 前提（编译期查，差一条就回 0 走 helper）：n 格反馈槽**同形状、同元表、同代号、都命中在自己身上**。
 * 回 1 = 发了特化版。
 */
static int jit_emit_getfields_ic(JitBuf *b, OmniFn *fn, uint8_t r, uint16_t k,
                                 uint8_t dst, uint8_t n, uint16_t f) {
    int32_t id = fn->icBase + (int32_t)f;
    if (n == 0 || id < 0 || id + (int32_t)n > vm_ics_n) return 0;
    OIC *ic0 = &omni_ics[id];
    if (ic0->shape == NULL || ic0->gen != omni_shape_gen) return 0;
    for (uint8_t i = 0; i < n; i++) {
        OIC *ic = &omni_ics[id + i];
        if (ic->shape != ic0->shape || ic->meta != ic0->meta || ic->gen != ic0->gen) return 0;
        if (ic->off < 0 || ic->off > 500) return 0;
        if (ic->holder != 0) {   /* 命中在原型上：那张表的 OTab* 是常量（见 getnamed 那格的注释） */
            if (oval_tag(ic->holder) != OVAL_TAG_TAB) return 0;
            if (omni_objs[(uint32_t)ic->holder] == NULL) return 0;
        }
    }

    uint32_t *miss[4]; int nmiss = 0;
    emit_read_r(b, 9, r);                            /* x9 = R[r] */
    emit_lsr(b, 10, 9, 32);
    emit_mov64(b, 11, (uint64_t)OVAL_TAG_TAB);
    emit_cmp(b, 10, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);

    emit_mov32(b, 12, 9);
    emit_ldr_reg(b, 12, REG_OBJS, 12);               /* x12 = OTab* */

    emit_ldr(b, 10, 12, TAB_SHAPE_8);
    emit_mov64(b, 11, (uint64_t)(uintptr_t)ic0->shape);
    emit_cmp(b, 10, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);

    emit_ldr(b, 10, 12, TAB_META_8);
    emit_mov64(b, 11, (uint64_t)ic0->meta);
    emit_cmp(b, 10, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);

    emit_mov64(b, 11, (uint64_t)ic0->gen);
    emit_cmp(b, REG_GEN, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);

    emit_ldr(b, 10, 12, TAB_SVALS_8);                /* x10 = t->svals */
    for (uint8_t i = 0; i < n; i++) {
        OIC *ici = &omni_ics[id + i];
        if (ici->holder == 0) {
            emit_ldr(b, 11, 10, ici->off);
        } else {
            OTab *ht = (OTab *)omni_objs[(uint32_t)ici->holder];
            emit_mov64(b, 11, (uint64_t)(uintptr_t)ht);
            emit_ldr(b, 11, 11, TAB_SVALS_8);
            emit_ldr(b, 11, 11, ici->off);
        }
        emit_write_r(b, 11, (uint32_t)dst + i);
    }
    uint32_t *done = jit_fwd_b(b);

    for (int i = 0; i < nmiss; i++) jit_patch_fwd(b, miss[i]);
    emit_read_r(b, 0, r);
    emit_mov64(b, 9, (uint64_t)k * 8);
    emit_add(b, 1, REG_K, 9);
    emit_movz(b, 2, n);
    emit_mov(b, 3, REG_ICBASE);
    emit_movz(b, 9, f);
    emit_add(b, 3, 3, 9);
    emit_mov64(b, 9, (uint64_t)dst * 8);
    emit_add(b, 4, REG_R, 9);
    emit_call_c(b, (void *)omni_tab_getn_ic);
    jit_patch_fwd(b, done);
    return 1;
}

/**
 * **全局读的内联缓存**：接收方是 G 那一张表，**表本身就是编译期常量**，
 * 于是守卫只剩"形状还是那个 + 元表还是那个 + gen 没变"，取值是两条 load。
 * 采样里 `omni_tab_get_ic` 独占 10%，全是 JIT'd 码每读一个全局都要过一次 C 调用。
 * 回 1 = 发了特化版。
 */
static int jit_emit_ldaglobal_ic(JitBuf *b, OmniFn *fn, uint16_t k, uint16_t f) {
    int32_t id = fn->icBase + (int32_t)f;
    if (id < 0 || id >= vm_ics_n) return 0;
    OIC *ic = &omni_ics[id];
    if (ic->shape == NULL || ic->gen != omni_shape_gen) return 0;
    if (ic->off < 0 || ic->off > 500) return 0;
    if (G == 0 || oval_tag(G) != OVAL_TAG_TAB) return 0;
    OTab *gt = (OTab *)omni_objs[(uint32_t)G];
    if (gt == NULL) return 0;
    OTab *holderTab = NULL;
    if (ic->holder != 0) {
        if (oval_tag(ic->holder) != OVAL_TAG_TAB) return 0;
        holderTab = (OTab *)omni_objs[(uint32_t)ic->holder];
        if (holderTab == NULL) return 0;
    }

    uint32_t *miss[3]; int nmiss = 0;
    emit_mov64(b, 12, (uint64_t)(uintptr_t)gt);      /* x12 = G 那张表（常量） */
    emit_ldr(b, 10, 12, TAB_SHAPE_8);
    emit_mov64(b, 11, (uint64_t)(uintptr_t)ic->shape);
    emit_cmp(b, 10, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);
    emit_ldr(b, 10, 12, TAB_META_8);
    emit_mov64(b, 11, (uint64_t)ic->meta);
    emit_cmp(b, 10, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);
    if (holderTab != NULL) {     /* 见 getnamed 那格：holder==0 不必查 gen */
        emit_mov64(b, 11, (uint64_t)ic->gen);
        emit_cmp(b, REG_GEN, 11);
        miss[nmiss++] = jit_fwd_bcond(b, 1);
    }

    if (holderTab == NULL) emit_ldr(b, 10, 12, TAB_SVALS_8);
    else { emit_mov64(b, 10, (uint64_t)(uintptr_t)holderTab); emit_ldr(b, 10, 10, TAB_SVALS_8); }
    emit_ldr(b, REG_ACC, 10, ic->off);
    uint32_t *done = jit_fwd_b(b);

    for (int i = 0; i < nmiss; i++) jit_patch_fwd(b, miss[i]);
    emit_mov64(b, 0, (uint64_t)(uintptr_t)&G);
    emit_ldr(b, 0, 0, 0);
    emit_ldr(b, 1, REG_K, k);
    emit_mov(b, 2, REG_ICBASE);
    emit_movz(b, 9, f);
    emit_add(b, 2, 2, 9);
    emit_call_c(b, (void *)omni_tab_get_ic);
    emit_mov(b, REG_ACC, 0);
    jit_patch_fwd(b, done);
    return 1;
}

/* OTab 的字节布局（真相是 lua-rt.h 末尾的 _Static_assert；单位 8 字节）：
   arr=0 alen/acap=1 slot=2 hcap/hused=3 meta=4 shape=5 svals=6 noshape/is_proto=7，sizeof=64 */
#define TAB_SIZE_BYTES 64

/**
 * **把"造一张定形状的表"发成指令**（不发调用）。
 *
 * 形状在编译期已知（反馈槽里记着，gen 守住），于是整件事就是：
 * arena 推指针 → 写 8 格头 + n 格值 → 在对象登记表里占一格 → 拼出 OVal。
 * 两条罕见路落回 helper：arena 这一块不够了、对象表要扩容。
 * 为什么值得：smallpt 里每个向量算子都造一张表，`omni_tab_new_shaped` 独占采样 13%，
 * 其中相当一部分是调用本身 + 它内部那趟 memset/拷贝。
 */
static int jit_emit_newshaped_ic(JitBuf *b, OmniFn *fn, uint16_t k, uint8_t base,
                                 uint8_t n, uint16_t f) {
    int32_t id = fn->icBase + (int32_t)f;
    if (id < 0 || id >= vm_ics_n) return 0;
    OIC *sic = &omni_ics[id];
    if (sic->shape == NULL || sic->gen != omni_shape_gen) return 0;
    if (n == 0 || n > 8) return 0;
    for (uint8_t i = 0; i < n; i++)
        if (jit_is_captured((uint32_t)base + i)) return 0;
    uint32_t size = (uint32_t)((TAB_SIZE_BYTES + (uint32_t)n * 8 + OMNI_TAB_EXTRA + (OMNI_ALLOC_ALIGN - 1))
                               & ~(uint32_t)(OMNI_ALLOC_ALIGN - 1));

    uint32_t *miss[2]; int nmiss = 0;
    /* 1) arena 推指针（与 omni_alloc 的快路逐条对应） */
    emit_mov64(b, 9, (uint64_t)(uintptr_t)&omni_arena_p);
    emit_ldr(b, 10, 9, 0);                       /* x10 = arena_p = blk */
    emit_mov64(b, 11, (uint64_t)(uintptr_t)&omni_arena_left);
    emit_ldr(b, 12, 11, 0);                      /* x12 = arena_left */
    emit_mov64(b, 13, (uint64_t)size);
    emit_cmp(b, 12, 13);
    miss[nmiss++] = jit_fwd_bcond(b, 3);         /* B.LO：这一块不够了 → 慢路 */
    emit_add(b, 14, 10, 13); emit_str(b, 14, 9, 0);      /* arena_p += size */
    emit_sub(b, 12, 12, 13); emit_str(b, 12, 11, 0);     /* arena_left -= size */

    /* 2) 表头 */
    emit_str(b, 31, 10, 0);                      /* arr = NULL */
    emit_str(b, 31, 10, 1);                      /* alen/acap = 0 */
    emit_str(b, 31, 10, 2);                      /* slot = NULL */
    emit_str(b, 31, 10, 3);                      /* hcap/hused = 0 */
    emit_mov64(b, 11, (uint64_t)oval_nil()); emit_str(b, 11, 10, 4);   /* meta = nil */
    emit_mov64(b, 11, (uint64_t)(uintptr_t)sic->shape); emit_str(b, 11, 10, 5);
    emit_mov64(b, 11, (uint64_t)TAB_SIZE_BYTES);
    emit_add(b, 11, 10, 11); emit_str(b, 11, 10, 6);     /* svals = blk + 64 */
    emit_str(b, 31, 10, 7);                      /* noshape/is_proto = 0 */

    /* 3) n 格值（直接从帧寄存器搬进 svals） */
    for (uint8_t i = 0; i < n; i++) {
        emit_read_r(b, 11, (uint32_t)base + i);
        emit_str(b, 11, 10, 8 + i);
    }

    /* 4) 在对象登记表里占一格（omni_obj_reg 的快路） */
    emit_mov64(b, 9, (uint64_t)(uintptr_t)&omni_objs_n);
    emit_ldr32(b, 12, 9, 0);                     /* w12 = omni_objs_n */
    emit_mov64(b, 11, (uint64_t)(uintptr_t)&omni_objs_cap);
    emit_ldr32(b, 13, 11, 0);                    /* w13 = cap */
    emit_cmp(b, 12, 13);
    miss[nmiss++] = jit_fwd_bcond(b, 2);         /* B.HS：要扩容 → 慢路 */
    emit_str_reg(b, 10, REG_OBJS, 12);           /* omni_objs[w12] = blk（x26） */
    emit_mov64(b, 13, 1);
    emit_add(b, 14, 12, 13);
    emit_str32(b, 14, 9, 0);                     /* omni_objs_n = w12 + 1 */

    /* 5) acc = (TAG_TAB << 32) | 对象号 */
    emit_mov64(b, 13, (uint64_t)OVAL_TAG_TAB << 32);
    emit_orr(b, REG_ACC, 13, 12);
    uint32_t *done = jit_fwd_b(b);

    /* 慢路：照旧调 helper（它会补形状、扩 arena / 对象表） */
    for (int i = 0; i < nmiss; i++) jit_patch_fwd(b, miss[i]);
    emit_mov(b, 0, REG_R);
    emit_mov64(b, 9, (uint64_t)k * 8);
    emit_add(b, 1, REG_K, 9);
    emit_movz(b, 2, base);
    emit_movz(b, 3, n);
    emit_mov(b, 4, REG_ICBASE);
    emit_movz(b, 9, f);
    emit_add(b, 4, 4, 9);
    emit_call_c(b, (void *)jit_newshaped_helper);
    emit_mov(b, REG_ACC, 0);
    jit_patch_fwd(b, done);
    return 1;
}

/* OIC 的字节布局（真相是 lua-rt.h 末尾的 _Static_assert）：
   shape=0、meta=8、holder=16、off=24(int32)、gen=28(uint32)，sizeof=32 */
#define IC_SHAPE_8   0
#define IC_META_8    1
#define IC_HOLDER_8  2
#define IC_OFF_4     6
#define IC_GEN_4     7

/**
 * **反馈槽当场读的内联缓存**（编译期没有反馈、或者形状还会变的那一档）。
 *
 * 与"把形状/偏移烧成立即数"那一版的区别：守卫的三样都是**运行期从 omni_ics[slot] 读**的，
 * 所以：编译时槽还空着也没关系（第一次执行由 helper 填上，第二次起就在这儿命中）；
 * 形状换了也没关系（helper 重填，这儿照新的走）。代价是多几条 load。
 *
 * 为什么非要有这一格：smallpt 采样里 `jit_getnamed_helper` 独占 **36%**，
 * 而它全来自"编译那一刻还没执行过、于是永远发通用调用"的那 28 个点（冷分支里的字段读）。
 * 二次编译那条路量过是中性的（见 memory 里那笔回退），这一格才是对症的。
 * 只做最常见的一档：字段在接收方自己身上（holder==0）、正偏移。其余落回 helper。
 */
static void jit_emit_getnamed_dyn_ic(JitBuf *b, OmniFn *fn, uint8_t r, uint16_t k, uint16_t f) {
    int32_t id = fn->icBase + (int32_t)f;
    uint32_t *miss[6]; int nmiss = 0;
    emit_read_r(b, 9, r);
    emit_lsr(b, 10, 9, 32);
    emit_mov64(b, 11, (uint64_t)OVAL_TAG_TAB);
    emit_cmp(b, 10, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);             /* 不是表 */
    emit_mov32(b, 12, 9);
    emit_ldr_reg(b, 12, REG_OBJS, 12);               /* x12 = OTab* */
    emit_mov64(b, 13, (uint64_t)(uintptr_t)&omni_ics[0]);
    emit_mov64(b, 14, (uint64_t)id * 32);
    emit_add(b, 13, 13, 14);                         /* x13 = &omni_ics[id] */

    emit_ldr32(b, 10, 13, IC_GEN_4);
    emit_cmp(b, 10, REG_GEN);
    miss[nmiss++] = jit_fwd_bcond(b, 1);             /* 代号变了（也覆盖"槽还空着"：gen=0） */
    emit_ldr(b, 10, 12, TAB_SHAPE_8);
    emit_ldr(b, 11, 13, IC_SHAPE_8);
    emit_cmp(b, 10, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);
    emit_ldr(b, 10, 12, TAB_META_8);
    emit_ldr(b, 11, 13, IC_META_8);
    emit_cmp(b, 10, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);
    emit_ldr32(b, 14, 13, IC_OFF_4);                 /* w14 = off（负缓存时是 0xFFFFFFFF） */
    emit_mov64(b, 11, 0x80000000ull);
    emit_cmp(b, 14, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 2);             /* B.HS：off 的符号位为 1（负缓存）→ helper */
    /* holder != 0 = 命中在原型上（`obj:method()` 这一档，smallpt 里到处是）：
       换成从原型那张表取。**这一档一定要接上** —— 不接的话方法查找全落回 helper。 */
    emit_ldr(b, 11, 13, IC_HOLDER_8);
    uint32_t *own = jit_fwd_cbz(b, 11);              /* holder == 0 → 用接收方自己 */
    emit_mov32(b, 11, 11);
    emit_ldr_reg(b, 12, REG_OBJS, 11);               /* x12 = 原型那张表 */
    jit_patch_fwd(b, own);

    emit_ldr(b, 10, 12, TAB_SVALS_8);
    emit_ldr_reg(b, REG_ACC, 10, 14);                /* acc = svals[off] */
    uint32_t *done = jit_fwd_b(b);

    for (int i = 0; i < nmiss; i++) jit_patch_fwd(b, miss[i]);
    emit_read_r(b, 0, r);
    emit_ldr(b, 1, REG_K, k);
    emit_mov(b, 2, REG_ICBASE);
    emit_movz(b, 9, f);
    emit_add(b, 2, 2, 9);
    emit_call_c(b, (void *)jit_getnamed_helper);
    emit_mov(b, REG_ACC, 0);
    jit_patch_fwd(b, done);
}

/**
 * **字段写的内联缓存**（`self.x = v` 那一族）。守卫与 `omni_tab_set_ic` 的快路逐条对应：
 * 是表 / shape 同 / meta 同 / gen 同 / **不是原型**（写原型要 `omni_shape_gen++` 让缓存作废，
 * 那一档照旧交给 C）。命中就是一条 str。
 * 反馈槽由 `ic_set_slow` 填（它只在"键在形状里"时填），所以命中即意味着 off 有效。
 */
static int jit_emit_setnamed_ic(JitBuf *b, OmniFn *fn, uint8_t r, uint16_t k, uint16_t f) {
    int32_t id = fn->icBase + (int32_t)f;
    if (id < 0 || id >= vm_ics_n) return 0;
    OIC *ic = &omni_ics[id];
    if (ic->shape == NULL || ic->gen != omni_shape_gen) return 0;
    if (ic->off < 0 || ic->off > 500 || ic->holder != 0) return 0;

    uint32_t *miss[5]; int nmiss = 0;
    emit_read_r(b, 9, r);
    emit_lsr(b, 10, 9, 32);
    emit_mov64(b, 11, (uint64_t)OVAL_TAG_TAB);
    emit_cmp(b, 10, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);
    emit_mov32(b, 12, 9);
    emit_mov64(b, 13, (uint64_t)(uintptr_t)&omni_objs);
    emit_ldr(b, 13, 13, 0);
    emit_ldr_reg(b, 12, 13, 12);                 /* x12 = OTab* */
    emit_ldr(b, 10, 12, TAB_SHAPE_8);
    emit_mov64(b, 11, (uint64_t)(uintptr_t)ic->shape);
    emit_cmp(b, 10, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);
    emit_ldr(b, 10, 12, TAB_META_8);
    emit_mov64(b, 11, (uint64_t)ic->meta);
    emit_cmp(b, 10, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);
    emit_mov64(b, 11, (uint64_t)ic->gen);
    emit_cmp(b, REG_GEN, 11);
    miss[nmiss++] = jit_fwd_bcond(b, 1);
    emit_ldrb(b, 10, 12, 57);                    /* w10 = t->is_proto */
    emit_cmp_imm(b, 10, 0);
    miss[nmiss++] = jit_fwd_bcond(b, 1);         /* B.NE：是原型 → 交给 C（它要 gen++） */

    emit_ldr(b, 10, 12, TAB_SVALS_8);
    emit_str(b, REG_ACC, 10, ic->off);
    uint32_t *done = jit_fwd_b(b);

    for (int i = 0; i < nmiss; i++) jit_patch_fwd(b, miss[i]);
    emit_read_r(b, 0, r);
    emit_ldr(b, 1, REG_K, k);
    emit_mov(b, 2, REG_ACC);
    emit_mov(b, 3, REG_ICBASE);
    emit_movz(b, 9, f);
    emit_add(b, 3, 3, 9);
    emit_call_c(b, (void *)omni_tab_set_ic);
    jit_patch_fwd(b, done);
    return 1;
}

/* OTab 里数组部分的偏移（字节）：arr=0、alen=8、acap=12 */
#define TAB_ARR_8   0
#define TAB_ALEN_4  2     /* ldr32 的单位是 4 字节 */

/**
 * **`t[i]` 的数组那一档发成指令**（整数下标、在 1..alen 之内）。
 *
 * 为什么值得：nbody 这种"几个平行数组 + 整数下标"的形状里，`omni_tab_get` 独占采样 60%、
 * `omni_tab_set` 又 13% —— 每一次 `x[i]` 都是一次 C 调用，而它干的事就是
 * 判表、判整数、比界、一条 load。判据与 `tab_arr_idx` + `tab_get_raw` 逐条对应：
 *   是表 / 键是数 / 取整能原样回来 / (i-1) 无符号地 < alen（这一条同时盖住 i<1）。
 * 不符就落回 `omni_tab_get`（它还要顺 __index 往上，语义不变）。
 * isSet=1 时发写（**只在界内覆写**；越界追加交给运行时，那儿要扩容）。
 */
static void jit_emit_keyed_arr(JitBuf *b, uint8_t ra, uint8_t rk, int isSet) {
    uint32_t *miss[4]; int nmiss = 0;
    emit_read_r(b, 9, ra);                       /* x9 = 表 */
    emit_read_r(b, 10, rk);                      /* x10 = 键 */

    emit_lsr(b, 11, 9, 32);
    emit_mov64(b, 12, (uint64_t)OVAL_TAG_TAB);
    emit_cmp(b, 11, 12);
    miss[nmiss++] = jit_fwd_bcond(b, 1);         /* 不是表 */

    emit_lsr(b, 11, 10, 32);
    emit_mov64(b, 12, (uint64_t)OVAL_TAG_FIRST);
    emit_cmp(b, 11, 12);
    miss[nmiss++] = jit_fwd_bcond(b, 2);         /* 键不是数 */

    emit_fmov_d_x(b, 0, 10);                     /* d0 = 键 */
    emit_fcvtzs(b, 13, 0);                       /* x13 = (int64)d0 */
    emit_scvtf(b, 1, 13);                        /* d1 = (double)x13 */
    emit_fcmp2(b, 0, 1);
    miss[nmiss++] = jit_fwd_bcond(b, 1);         /* 不是整数（NaN 也走这儿） */

    emit_mov32(b, 11, 9);
    emit_ldr_reg(b, 12, REG_OBJS, 11);           /* x12 = OTab*（x26） */
    emit_mov64(b, 11, 1);
    emit_sub(b, 13, 13, 11);                     /* x13 = i - 1 */
    emit_ldr32(b, 14, 12, TAB_ALEN_4);           /* w14 = alen */
    emit_cmp(b, 13, 14);
    miss[nmiss++] = jit_fwd_bcond(b, 2);         /* B.HS：i-1 >= alen（含 i<1 那一档） */

    emit_ldr(b, 11, 12, TAB_ARR_8);              /* x11 = t->arr */
    if (isSet) emit_str_reg(b, REG_ACC, 11, 13);
    else       emit_ldr_reg(b, REG_ACC, 11, 13);
    uint32_t *done = jit_fwd_b(b);

    for (int i = 0; i < nmiss; i++) jit_patch_fwd(b, miss[i]);
    emit_mov(b, 0, 9);
    emit_mov(b, 1, 10);
    if (isSet) {
        emit_mov(b, 2, REG_ACC);
        emit_call_c(b, (void *)omni_tab_set);
    } else {
        emit_call_c(b, (void *)omni_tab_get);
        emit_mov(b, REG_ACC, 0);
    }
    jit_patch_fwd(b, done);
}

/* 算术点内联元方法体时用的暂存窗口（编译期按各点需要算出来，放在帧的最上面） */
static uint32_t jit_arith_scratch = 0;   /* 暂存窗口的**绝对**起点（相对函数帧底） */
static uint32_t jit_arith_win = 0;       /* 每一层暂存窗口要多少格 */
static uint32_t jit_shift_total = 0;     /* x19 相对函数帧底已经挪了多少格（内联体里非 0） */
static uint32_t jit_root_nreg = 0;       /* **最外层**那个函数的帧有多少格（内联体里 fn 是被调方，它的 nreg 不作数） */

/** 这个算术点（pc 指着 OP_Add 等，操作数是 r + f）的元方法能就地展开吗。
    能就回处理函数的 proto，并给出守卫要的形状/元表、那个闭包值与窗口高度。 */
static OmniFn *jit_arith_inline_target(OmniFn *fn, uint32_t pc, int depth,
                                       OShape **shOut, OVal *metaOut, OVal *hOut,
                                       uint32_t *winOut) {
    uint16_t fb = BC_U16(fn->code, pc + 2);
    OShape *sh = NULL; OVal meta = 0, h = 0;
    if (!arith_site_mono(fn->icBase + (int32_t)fb, &sh, &meta, &h)) return NULL;
    BCClo *clo = bcclo_get(h);
    if (clo->native) return NULL;
    OmniFn *ce = clo->fn;
    if (!jit_inline_fn_ok(ce, h, 2, depth, winOut)) return NULL;
    *shOut = sh; *metaOut = meta; *hOut = h;
    return ce;
}

static uint32_t jit_emit_one(JitBuf *b, OmniFn *fn, uint32_t pc, Fixup *fixups, int *nfixup);
static uint32_t jit_emit_seq(JitBuf *b, OmniFn *fn, uint32_t pc,
                             const uint8_t *isTarget, Fixup *fixups, int *nfixup);
static int jit_emit_direct_call(JitBuf *b, OmniFn *fn, uint8_t base, uint8_t argc, int32_t slot);

/**
 * **就地展开一个被调方的字节码**（调用点与算术点的元方法点共用这一格）。
 *
 * winBase = 被调方的 R[0] 落在调用方帧的哪一格（调用点是 base+1，算术点是暂存窗口）。
 * 进来之前调用方要先把实参写进 [winBase, winBase+argc)；
 * 这儿负责：剩下的局部量填 nil、acc 归 nil、x19/x20/x23 换成被调方的那一套、
 * 发到第一条 Ret（**Ret 不发** —— 返回值本来就在 acc 里）、再把三样换回来。
 * 回 0 = 中间有发不出来的码（调用方应当整函数放弃）。
 */
static int jit_emit_inline_body(JitBuf *b, OmniFn *fn, OmniFn *ce, BCClo *clo,
                                uint32_t winBase, uint32_t win, uint32_t argc,
                                Fixup *fixups, int *nfixup) {
    uint32_t cnr = ce->nreg ? ce->nreg : 1;
    emit_mov64(b, 9, (uint64_t)oval_nil());
    for (uint32_t r = argc; r < cnr; r++)
        emit_str(b, 9, REG_R, (int)(winBase + r));
    emit_mov64(b, REG_ACC, (uint64_t)oval_nil());

    emit_mov64(b, 9, (uint64_t)winBase * 8);
    emit_add(b, REG_R, REG_R, 9);
    emit_mov64(b, REG_K, (uint64_t)(uintptr_t)ce->K);
    emit_mov64(b, REG_ICBASE, (uint64_t)(uint32_t)ce->icBase);

    const uint8_t *savedCap = jit_captured;
    uint32_t savedCapN = jit_captured_n;
    OVal **savedUp = jit_inline_up;
    jit_captured = savedCap ? savedCap + winBase : NULL;
    jit_captured_n = win;
    jit_inline_up = clo->up;
    jit_inline_depth++;
    jit_shift_total += winBase;          /* x19 又往上挪了 winBase 格 */

    int emitted = 1;
    uint32_t q = 0;
    uint32_t *lastInsn = NULL;
    while (q < ce->codeLen && ce->code[q] != OP_Ret) {
        /* 内联体里没有跳转（白名单保证），所以 isTarget 传 NULL —— 也因此
           **这里可以无条件做 store→load 转发**（没有落点能跳进两条码中间）。
           原来漏了这一格：Tier 2 的 walk 里有、Tier 1 的内联体里没有，
           A/B 出来 Tier 2 快 2~3% 就是这个差。 */
        uint32_t *firstInsn = b->p;
        uint32_t nq = jit_emit_seq(b, ce, q, NULL, fixups, nfixup);
        if (nq == 0) { emitted = 0; break; }
        if (lastInsn != NULL && firstInsn == lastInsn + 1 && b->p > firstInsn)
            jit_fuse_store_load(lastInsn, firstInsn);
        lastInsn = (b->p > firstInsn) ? b->p - 1 : lastInsn;
        q = nq;
    }

    jit_inline_depth--;
    jit_shift_total -= winBase;
    jit_inline_up = savedUp;
    jit_captured = savedCap; jit_captured_n = savedCapN;

    emit_mov64(b, 9, (uint64_t)winBase * 8);
    emit_sub(b, REG_R, REG_R, 9);
    emit_mov64(b, REG_K, (uint64_t)(uintptr_t)fn->K);
    emit_mov64(b, REG_ICBASE, (uint64_t)(uint32_t)fn->icBase);
    return emitted;
}

/* **发一条字节码的机器码** —— Tier 1 的逐条翻译，单独抽出来是为了 **Tier 2 复用**：
 * ssa.c 里没特化的节点（S_BC）直接调这一格，于是 Tier 2 = Tier 1 + 有反馈处特化，
 * 覆盖率天生 100%，不会"碰到没建模的指令就整函数放弃"。
 * 回下一条的 pc；回 0 = 这条发不了。 */
static uint32_t jit_emit_one(JitBuf *b, OmniFn *fn, uint32_t pc, Fixup *fixups, int *nfixup) {
    uint8_t *code = fn->code;
    uint8_t op = code[pc];
    pc++;
        switch (op) {
        case OP_LdaNil:
            emit_mov64(b, REG_ACC, (uint64_t)OVAL_TAG_NIL << 32);
            break;
        case OP_LdaTrue:
            emit_mov64(b, REG_ACC, (uint64_t)OVAL_TAG_TRUE << 32);
            break;
        case OP_LdaFalse:
            emit_mov64(b, REG_ACC, (uint64_t)OVAL_TAG_FALSE << 32);
            break;
        case OP_LdaK: {
            uint16_t k = BC_U16(code, pc); pc += 2;
            /* acc = K[k]; LDR x21, [x20, #k*8] */
            emit_ldr(b, REG_ACC, REG_K, k);
            break;
        }
        case OP_LdaR: {
            uint8_t r = code[pc++];
            /* acc = R[r]; LDR x21, [x19, #r*8] */
            emit_read_r(b, REG_ACC, r);
            break;
        }
        case OP_StaR: {
            uint8_t r = code[pc++];
            /* R[r] = acc; STR x21, [x19, #r*8] */
            emit_write_r(b, REG_ACC, r);
            break;
        }
        case OP_Mov: {
            uint8_t a = code[pc++], d = code[pc++];
            /* R[d] = R[a] */
            emit_read_r(b, 9, a);
            emit_write_r(b, 9, d);
            break;
        }

        /* ---- Arithmetic (fast path: both numbers → fp op; slow path → C call) ---- */
        case OP_Add: case OP_Sub: case OP_Mul: case OP_Div: {
            uint32_t opPc = pc - 1;
            uint8_t r = code[pc++];
            uint16_t afb = BC_U16(code, pc); pc += 2;
            int32_t aslot = fn->icBase + (int32_t)afb;
            /* x9 = R[r] */
            emit_read_r(b, 9, r);
            /* Both numbers fast path: OR their bits; if high32 < TAG_FIRST, both are numbers.
               ⚠️ 这一档是**近似**的：OR 可能把两个数的指数域凑满（`1.5 | 4096.0`）而假失手，
               白走一次 C 调用。逐个判量过：smallpt/nbody −0.8%/−1.5%，但 btree +2.2%、
               mandel +1.3%（多一条 cmp 是所有算术都付，假失手只有混量级的浮点才踩）。
               **净是一场平手，所以单条这儿保留 OR 那一档**；融成一串那儿 OR 的是 3~5 个值，
               假失手概率高得多，那边改成逐个判（量到 smallpt 从 +3.6% 翻成 −2.7%）。 */
            emit(b, 0xAA090000 | (REG_ACC << 5) | 10); /* ORR x10, x21, x9 */
            emit_lsr(b, 11, 10, 32); /* x11 = high32(x9 | acc) */
            emit_mov64(b, 12, TAG_FIRST);
            emit_cmp(b, 11, 12);
            uint32_t *slow = b->p;
            emit_bcond(b, 2, 0); /* B.CS → slow */
            /* Both are numbers — do FP operation */
            emit_fmov_d_x(b, 0, 9);         /* d0 = R[r] as double */
            emit_fmov_d_x(b, 1, REG_ACC);   /* d1 = acc as double */
            switch (op) {
            case OP_Add: emit_fadd(b, 0, 0, 1); break;
            case OP_Sub: emit_fsub(b, 0, 0, 1); break;
            case OP_Mul: emit_fmul(b, 0, 0, 1); break;
            case OP_Div: emit_fdiv(b, 0, 0, 1); break;
            }
            emit_fmov_x_d(b, REG_ACC, 0);   /* acc = result */
            uint32_t *skip = b->p;
            emit_b(b, 0); /* skip over slow path */
            /* Slow path */
            uint32_t *slow_start = b->p;
            *slow = 0x54000000 | ((uint32_t)((int32_t)(slow_start - slow) & 0x7FFFF) << 5) | 2;

            /* ---- 元方法的去虚化 + 内联 ----
               `v1 + v2` 这种落在表上的算子，原来每次都是：调 vm_val_add → 取元表 →
               查 __add → 开一帧 → 调处理函数。反馈槽记着受方的形状/元表与处理函数之后，
               这儿就能发"守卫 + 处理函数体"，整条链一次跳过。
               守卫只看**受方**（a）—— 元方法是从 a 的元表取的，b 是什么不影响取哪个处理函数。 */
            uint32_t *inlDone = NULL;
            {
                static int noInlineA = -1;
                if (noInlineA < 0) noInlineA = getenv("OMNI_JIT_NOINLINE") ? 1 : 0;
                OShape *sh = NULL; OVal meta = 0, hv = 0; uint32_t win = 0;
                OmniFn *ce = NULL;
                /* **内联体里的算术点也要做**：`Vec:norm` 里那句 `self * (1/len)` 就是最热的一个，
                   而 norm 自己是被内联进来的 —— 原来卡在 depth==0 这条限制上，
                   那一个点独占了元方法算术调用的 52%（22 万次）。
                   每一层用自己的暂存窗口（预扫时按层数留好），偏移要减掉 x19 已经挪过的量。 */
                if (jit_inline_depth < JIT_INLINE_MAX_DEPTH && !noInlineA && jit_arith_scratch != 0)
                    ce = jit_arith_inline_target(fn, opPc, jit_inline_depth, &sh, &meta, &hv, &win);
                uint32_t scAbs = jit_arith_scratch + (uint32_t)jit_inline_depth * jit_arith_win;
                int32_t scRel = (int32_t)scAbs - (int32_t)jit_shift_total;
                int fits = (ce != NULL && win <= jit_arith_win && scRel >= 0
                            && scAbs + win <= jit_root_nreg);
                if (ce != NULL && !fits && getenv("OMNI_JIT_DEBUG2"))
                    fprintf(stderr, "jit: 算术内联放不下 @%u 层%d：win=%u/%u scAbs=%u shift=%u rootNreg=%u\n",
                            opPc, jit_inline_depth, win, jit_arith_win, scAbs,
                            jit_shift_total, jit_root_nreg);
                if (fits) {
                    uint32_t sc = (uint32_t)scRel;
                    emit_mov(b, 14, 9);                          /* x14 = a（守卫要用掉 x9~x13） */
                    uint32_t *miss[4]; int nmiss = 0;
                    emit_lsr(b, 10, 9, 32);
                    emit_mov64(b, 11, (uint64_t)OVAL_TAG_TAB);
                    emit_cmp(b, 10, 11);
                    miss[nmiss++] = jit_fwd_bcond(b, 1);
                    emit_mov32(b, 12, 9);
                    emit_ldr_reg(b, 12, REG_OBJS, 12);           /* x12 = OTab*（x26） */
                    emit_ldr(b, 10, 12, TAB_SHAPE_8);
                    emit_mov64(b, 11, (uint64_t)(uintptr_t)sh);
                    emit_cmp(b, 10, 11);
                    miss[nmiss++] = jit_fwd_bcond(b, 1);
                    emit_ldr(b, 10, 12, TAB_META_8);
                    emit_mov64(b, 11, (uint64_t)meta);
                    emit_cmp(b, 10, 11);
                    miss[nmiss++] = jit_fwd_bcond(b, 1);
                    emit_mov64(b, 11, (uint64_t)omni_shape_gen);
                    emit_cmp(b, REG_GEN, 11);
                    miss[nmiss++] = jit_fwd_bcond(b, 1);
                    /* 实参写进暂存窗口：处理函数的 (a, b) */
                    emit_str(b, 14, REG_R, (int)sc);
                    emit_str(b, REG_ACC, REG_R, (int)(sc + 1));
                    BCClo *hclo = bcclo_get(hv);
                    int emitted = jit_emit_inline_body(b, fn, ce, hclo, sc, win, 2,
                                                       fixups, nfixup);
                    if (!emitted) return 0;
                    inlDone = jit_fwd_b(b);
                    for (int i = 0; i < nmiss; i++) jit_patch_fwd(b, miss[i]);
                    emit_mov(b, 9, 14);                          /* 慢路要的 a 还在 x14 */
                    if (getenv("OMNI_JIT_DEBUG"))
                        fprintf(stderr, "jit: 内联元方法 @%u → proto %p（%u 条码，烧进的 gen=%u）\n",
                                opPc, (void *)ce, ce->codeLen, omni_shape_gen);
                }
            }

            /* Call vm_val_add/sub/mul/div_fb(R[r], acc, slot) */
            emit_mov(b, 0, 9);       /* x0 = R[r] */
            emit_mov(b, 1, REG_ACC); /* x1 = acc */
            emit_mov64(b, 2, (uint64_t)(uint32_t)aslot);
            void *target;
            switch (op) {
            case OP_Add: target = (void *)vm_val_add_fb; break;
            case OP_Sub: target = (void *)vm_val_sub_fb; break;
            case OP_Mul: target = (void *)vm_val_mul_fb; break;
            case OP_Div: target = (void *)vm_val_div_fb; break;
            default: target = (void *)vm_val_add_fb; break;
            }
            emit_mov64(b, 12, (uint64_t)(uintptr_t)target);
            emit_blr(b, 12);
            emit_mov(b, REG_ACC, 0); /* acc = return value */
            /* 这一格是手写的 blr（不走 emit_call_c），x26 要自己重装：
               vm_val_*_fb 会走元方法，元方法里可能建表 ⇒ 对象登记表可能 realloc 搬走。 */
            emit_mov64(b, 9, (uint64_t)(uintptr_t)&omni_objs);
            emit_ldr(b, REG_OBJS, 9, 0);
            emit_mov64(b, 9, (uint64_t)(uintptr_t)&omni_shape_gen);
            emit_ldr32(b, REG_GEN, 9, 0);
            if (inlDone) jit_patch_fwd(b, inlDone);
            /* Patch skip */
            *skip = 0x14000000 | (uint32_t)((int32_t)(b->p - skip) & 0x03FFFFFF);
            break;
        }

        case OP_Ret:
            /* Return acc in x0 */
            emit_mov(b, 0, REG_ACC);
            /* Epilogue（次序与序言里的压栈**严格相反**） */
            emit_ldp_post(b, 27, 28, 31, 2);
            emit_ldp_post(b, 25, 26, 31, 2);
            emit_ldp_post(b, 23, 24, 31, 2);
            emit_ldp_post(b, 21, 22, 31, 2);
            emit_ldp_post(b, 19, 20, 31, 2);
            emit_ldp_post(b, 29, 30, 31, 2);
            emit_ret(b);
            break;

        case OP_ForPrep: {
            uint8_t base = code[pc++];
            int32_t j = BC_I32(code, pc); pc += 4;
            uint32_t target_pc = pc + j;
            /* double i = R[base], lim = R[base+1], st = R[base+2]
             * if (st >= 0 ? i > lim : i < lim) goto target */
            emit_read_r(b, 9, base);       /* x9 = R[base] = i */
            emit_read_r(b, 10, base + 1);  /* x10 = lim */
            emit_read_r(b, 11, base + 2);  /* x11 = step */
            emit_fmov_d_x(b, 0, 9);    /* d0 = i */
            emit_fmov_d_x(b, 1, 10);   /* d1 = lim */
            emit_fmov_d_x(b, 2, 11);   /* d2 = step */
            /* check step sign: FCMP d2, #0 */
            emit(b, 0x1E602018 | (2 << 5)); /* FCMP D2, #0.0 */
            /* B.LT → step < 0 → check i < lim → if yes stay, if i >= lim → skip */
            uint32_t *neg_branch = b->p;
            emit_bcond(b, 11, 0); /* B.LT, placeholder */
            /* step >= 0: skip if i > lim (FCMP d0, d1; B.GT → target) */
            emit_fcmp(b, 0, 1);
            fixups[(*nfixup)++] = (Fixup){ b->p, target_pc, 1 };
            emit_bcond(b, 12, 0); /* B.GT, placeholder */
            uint32_t *join = b->p;
            emit_b(b, 0); /* skip neg path */
            /* neg path: step < 0: skip if i < lim */
            *neg_branch = 0x54000000 | ((uint32_t)((int32_t)(b->p - neg_branch) & 0x7FFFF) << 5) | 11;
            emit_fcmp(b, 0, 1);
            fixups[(*nfixup)++] = (Fixup){ b->p, target_pc, 1 };
            emit_bcond(b, 4, 0); /* B.MI (LT), placeholder */
            /* Patch join */
            *join = 0x14000000 | (uint32_t)((int32_t)(b->p - join) & 0x03FFFFFF);
            break;
        }

        case OP_ForLoop: {
            uint8_t base = code[pc++];
            int32_t j = BC_I32(code, pc); pc += 4;
            uint32_t target_pc = pc + j;
            /* i += step; if (step >= 0 ? i <= lim : i >= lim) goto target; R[base] = i */
            emit_read_r(b, 9, base);       /* i */
            emit_read_r(b, 10, base + 1);  /* lim */
            emit_read_r(b, 11, base + 2);  /* step */
            emit_fmov_d_x(b, 0, 9);
            emit_fmov_d_x(b, 1, 10);
            emit_fmov_d_x(b, 2, 11);
            emit_fadd(b, 0, 0, 2);  /* i += step */
            emit_fmov_x_d(b, 9, 0); /* x9 = new i as OVal */
            emit_write_r(b, 9, base); /* R[base] = new i */
            /* check step sign */
            emit(b, 0x1E602018 | (2 << 5)); /* FCMP D2, #0.0 */
            uint32_t *neg_branch = b->p;
            emit_bcond(b, 11, 0); /* B.LT */
            /* step >= 0: continue if i <= lim */
            emit_fcmp(b, 0, 1);
            fixups[(*nfixup)++] = (Fixup){ b->p, target_pc, 1 };
            emit_bcond(b, 13, 0); /* B.LE → continue */
            uint32_t *join = b->p;
            emit_b(b, 0);
            /* neg */
            *neg_branch = 0x54000000 | ((uint32_t)((int32_t)(b->p - neg_branch) & 0x7FFFF) << 5) | 11;
            emit_fcmp(b, 0, 1);
            fixups[(*nfixup)++] = (Fixup){ b->p, target_pc, 1 };
            emit_bcond(b, 10, 0); /* B.GE → continue */
            *join = 0x14000000 | (uint32_t)((int32_t)(b->p - join) & 0x03FFFFFF);
            break;
        }

        case OP_Jump: {
            int32_t j = BC_I32(code, pc); pc += 4;
            uint32_t target_pc = pc + j;
            fixups[(*nfixup)++] = (Fixup){ b->p, target_pc, 0 };
            emit_b(b, 0);
            break;
        }
        case OP_JumpLoop: {
            int32_t j = BC_I32(code, pc); pc += 4;
            uint32_t target_pc = pc + j;
            fixups[(*nfixup)++] = (Fixup){ b->p, target_pc, 0 };
            emit_b(b, 0);
            break;
        }
        case OP_JumpIfFalse: {
            int32_t j = BC_I32(code, pc); pc += 4;
            uint32_t target_pc = pc + j;
            /* if !truthy(acc) → branch. Truthy = not nil and not false.
             * nil  = TAG_NIL<<32 = 0xFFF80001_00000000
             * false= TAG_FALSE<<32 = 0xFFF80002_00000000 */
            emit_mov64(b, 9, (uint64_t)OVAL_TAG_NIL << 32);
            emit_cmp(b, REG_ACC, 9);
            fixups[(*nfixup)++] = (Fixup){ b->p, target_pc, 1 };
            emit_bcond(b, 0, 0); /* B.EQ → is nil → jump */
            emit_mov64(b, 9, (uint64_t)OVAL_TAG_FALSE << 32);
            emit_cmp(b, REG_ACC, 9);
            fixups[(*nfixup)++] = (Fixup){ b->p, target_pc, 1 };
            emit_bcond(b, 0, 0); /* B.EQ → is false → jump */
            break;
        }
        case OP_JumpIfTrue: {
            int32_t j = BC_I32(code, pc); pc += 4;
            uint32_t target_pc = pc + j;
            /* if truthy(acc) → branch */
            emit_mov64(b, 9, (uint64_t)OVAL_TAG_NIL << 32);
            emit_cmp(b, REG_ACC, 9);
            uint32_t *isnil = b->p;
            emit_bcond(b, 0, 0); /* B.EQ → skip (nil not truthy) */
            emit_mov64(b, 9, (uint64_t)OVAL_TAG_FALSE << 32);
            emit_cmp(b, REG_ACC, 9);
            uint32_t *isfalse = b->p;
            emit_bcond(b, 0, 0); /* B.EQ → skip (false not truthy) */
            /* truthy → branch */
            fixups[(*nfixup)++] = (Fixup){ b->p, target_pc, 0 };
            emit_b(b, 0);
            /* patch skips */
            uint32_t *here = b->p;
            *isnil = 0x54000000 | ((uint32_t)((int32_t)(here - isnil) & 0x7FFFF) << 5) | 0;
            *isfalse = 0x54000000 | ((uint32_t)((int32_t)(here - isfalse) & 0x7FFFF) << 5) | 0;
            break;
        }
        case OP_JumpIfNil: {
            int32_t j = BC_I32(code, pc); pc += 4;
            uint32_t target_pc = pc + j;
            emit_mov64(b, 9, (uint64_t)OVAL_TAG_NIL << 32);
            emit_cmp(b, REG_ACC, 9);
            fixups[(*nfixup)++] = (Fixup){ b->p, target_pc, 1 };
            emit_bcond(b, 0, 0); /* B.EQ */
            break;
        }

        case OP_Print: {
            uint8_t base = code[pc++], n = code[pc++];
            for (uint8_t i = 0; i < n; i++) {
                emit_read_r(b, 0, base + i);
                emit_movz(b, 1, i + 1 == n ? 1 : 0);
                emit_call_c(b, (void *)omni_val_write);
            }
            if (n == 0) {
                emit_mov64(b, 0, (uint64_t)(uintptr_t)"\n");
                emit_call_c(b, (void *)printf);
            }
            break;
        }

        /* ---- Comparisons: fast path both-num → FCMP; slow path → C call ---- */
        case OP_Eq: case OP_Ne: case OP_Lt: case OP_Le: case OP_Gt: case OP_Ge: {
            uint8_t r = code[pc++]; pc += 2; /* skip feedback */
            emit_read_r(b, 9, r);
            /* 两个都是数吗 —— 逐个判（OR 那一档会假失手，见算术那儿的注释） */
            emit_mov64(b, 12, TAG_FIRST);
            emit_lsr(b, 11, 9, 32);
            emit_cmp(b, 11, 12);
            uint32_t *slowB = b->p;
            emit_bcond(b, 2, 0);
            emit_lsr(b, 11, REG_ACC, 32);
            emit_cmp(b, 11, 12);
            uint32_t *slow = b->p;
            emit_bcond(b, 2, 0); /* B.CS → slow */
            /* Fast: FP compare */
            emit_fmov_d_x(b, 0, 9);
            emit_fmov_d_x(b, 1, REG_ACC);
            emit_fcmp(b, 0, 1);
            /* Set acc to true/false based on condition */
            uint64_t tv = (uint64_t)OVAL_TAG_TRUE << 32;
            uint64_t fv = (uint64_t)OVAL_TAG_FALSE << 32;
            emit_mov64(b, REG_ACC, fv); /* default: false */
            /* csel-like: load true if cond met */
            /* arm64 CSEL doesn't work with 64-bit imm, use conditional branch */
            int cond;
            switch (op) {
            case OP_Eq: cond = 0; break;  /* EQ */
            case OP_Ne: cond = 1; break;  /* NE */
            case OP_Lt: cond = 11; break; /* LT (MI) */
            case OP_Le: cond = 13; break; /* LE */
            case OP_Gt: cond = 12; break; /* GT */
            case OP_Ge: cond = 10; break; /* GE */
            default: cond = 0; break;
            }
            uint32_t *no_set = b->p;
            emit_bcond(b, cond ^ 1, 0); /* skip if NOT cond */
            emit_mov64(b, REG_ACC, tv);
            uint32_t *here = b->p;
            *no_set = 0x54000000 | ((uint32_t)((int32_t)(here - no_set) & 0x7FFFF) << 5) | (cond ^ 1);
            uint32_t *skip_slow = b->p;
            emit_b(b, 0);
            /* Slow path */
            uint32_t *slow_start = b->p;
            *slow = 0x54000000 | ((uint32_t)((int32_t)(slow_start - slow) & 0x7FFFF) << 5) | 2;
            *slowB = 0x54000000 | ((uint32_t)((int32_t)(slow_start - slowB) & 0x7FFFF) << 5) | 2;
            emit_mov(b, 0, 9);
            emit_mov(b, 1, REG_ACC);
            void *cmp_fn;
            switch (op) {
            case OP_Eq: cmp_fn = (void *)omni_val_eq; break;
            case OP_Ne: cmp_fn = (void *)omni_val_eq; break; /* negate after */
            case OP_Lt: cmp_fn = (void *)omni_val_lt; break;
            case OP_Le: cmp_fn = (void *)omni_val_le; break;
            case OP_Gt: cmp_fn = (void *)omni_val_lt; break; /* swap */
            case OP_Ge: cmp_fn = (void *)omni_val_le; break; /* swap */
            default: cmp_fn = (void *)omni_val_eq; break;
            }
            if (op == OP_Gt || op == OP_Ge) {
                /* swap args: lt(acc, R[r]) or le(acc, R[r]) */
                emit_mov(b, 0, REG_ACC);
                emit_mov(b, 1, 9);
            }
            emit_call_c(b, cmp_fn);
            if (op == OP_Ne) {
                /* negate: call omni_val_not */
                emit_call_c(b, (void *)omni_val_not);
            }
            emit_mov(b, REG_ACC, 0);
            *skip_slow = 0x14000000 | (uint32_t)((int32_t)(b->p - skip_slow) & 0x03FFFFFF);
            break;
        }

        case OP_Neg: {
            pc += 2; /* skip feedback */
            emit_mov(b, 0, REG_ACC);
            emit_call_c(b, (void *)omni_val_neg);
            emit_mov(b, REG_ACC, 0);
            break;
        }
        case OP_Not: {
            emit_mov(b, 0, REG_ACC);
            emit_call_c(b, (void *)omni_val_not);
            emit_mov(b, REG_ACC, 0);
            break;
        }
        case OP_Len: {
            pc += 2; /* skip feedback */
            emit_mov(b, 0, REG_ACC);
            emit_call_c(b, (void *)omni_val_len);
            emit_mov(b, REG_ACC, 0);
            break;
        }
        case OP_Mod: {
            uint8_t r = code[pc++]; pc += 2;
            emit_read_r(b, 9, r);
            emit_mov(b, 0, 9);
            emit_mov(b, 1, REG_ACC);
            emit_call_c(b, (void *)vm_val_mod);
            emit_mov(b, REG_ACC, 0);
            break;
        }
        case OP_Pow: {
            uint8_t r = code[pc++]; pc += 2;
            emit_read_r(b, 9, r);
            emit_mov(b, 0, 9);
            emit_mov(b, 1, REG_ACC);
            emit_call_c(b, (void *)omni_val_pow);
            emit_mov(b, REG_ACC, 0);
            break;
        }
        case OP_Concat: {
            uint8_t r = code[pc++]; pc += 2;
            emit_read_r(b, 9, r);
            emit_mov(b, 0, 9);
            emit_mov(b, 1, REG_ACC);
            emit_call_c(b, (void *)omni_val_concat);
            emit_mov(b, REG_ACC, 0);
            break;
        }

        /* ---- Globals ---- */
        case OP_LdaGlobal: {
            uint16_t k = BC_U16(code, pc); pc += 2;
            uint16_t f = BC_U16(code, pc); pc += 2;
            /* 先试"发成指令"那一档（G 是常量表，守卫只剩形状/元表） */
            {
                static int noGIC = -1;
                if (noGIC < 0) noGIC = (getenv("OMNI_JIT_NOIC") || getenv("OMNI_JIT_NOGIC")) ? 1 : 0;
                if (!noGIC && jit_emit_ldaglobal_ic(b, fn, k, f)) break;
            }
            /* acc = omni_tab_get_ic(G, K[k], icBase + f) —— 全局也走内联缓存 */
            emit_mov64(b, 0, (uint64_t)(uintptr_t)&G);
            emit_ldr(b, 0, 0, 0); /* x0 = G */
            emit_ldr(b, 1, REG_K, k); /* x1 = K[k] */
            emit_mov(b, 2, REG_ICBASE);
            emit_movz(b, 9, f);
            emit_add(b, 2, 2, 9);
            emit_call_c(b, (void *)omni_tab_get_ic);
            emit_mov(b, REG_ACC, 0);
            break;
        }
        case OP_StaGlobal: {
            uint16_t k = BC_U16(code, pc); pc += 2;
            uint16_t f = BC_U16(code, pc); pc += 2;
            emit_mov64(b, 0, (uint64_t)(uintptr_t)&G);
            emit_ldr(b, 0, 0, 0);
            emit_ldr(b, 1, REG_K, k);
            emit_mov(b, 2, REG_ACC);
            emit_mov(b, 3, REG_ICBASE);
            emit_movz(b, 9, f);
            emit_add(b, 3, 3, 9);
            emit_call_c(b, (void *)omni_tab_set_ic);
            break;
        }

        /* ---- Table ops (all go through C runtime) ---- */
        case OP_NewTable: {
            pc += 1; /* skip size hint */
            emit_call_c(b, (void *)omni_tab_new);
            emit_mov(b, REG_ACC, 0);
            break;
        }
        case OP_GetNamed: {
            uint8_t r = code[pc++];
            uint16_t k = BC_U16(code, pc); pc += 2;
            uint16_t f = BC_U16(code, pc); pc += 2;
            /* **默认开**（`OMNI_JIT_NOIC=1` 关掉可复量）。
               ⚠️ 这一格的结论翻过一次：内联 + OSR 之前量它是**严格中性**（1.001），
               当时的判断是"守卫的四次比较 ≈ 它替掉的那次调用，收益只能来自守卫共享"。
               内联 + 元方法升层落地之后重量：**smallpt 0.946（-5.4%）**、method 1.002。
               道理是环境变了 —— 现在字段读占采样 37%（jit_getnamed_helper 单项 17%），
               热路径上少一次 C 调用就真省了。**同一刀在不同底子上收益不同，要重量。** */
            static int icOn = -1;
            if (icOn < 0) icOn = getenv("OMNI_JIT_NOIC") ? 0 : 1;
            if (icOn && jit_emit_getnamed_ic(b, fn, r, k, f)) break;
            /* 编译期没反馈（冷分支里的读）就发"当场读反馈槽"那一版 —— 一次执行之后
               helper 把槽填上，第二次起就在这儿命中，不必再进 C。 */
            if (icOn) { jit_emit_getnamed_dyn_ic(b, fn, r, k, f); break; }
            /* **必须走 jit_getnamed_helper**：接收方是串时（`s:sub(i,j)`）要查串方法表，
               直接调 omni_tab_get_ic 会把 OStr 当 OTab 用 —— 段错误。踩过一次。 */
            emit_read_r(b, 0, r);
            emit_ldr(b, 1, REG_K, k);
            emit_mov(b, 2, REG_ICBASE);
            emit_movz(b, 9, f);
            emit_add(b, 2, 2, 9);
            emit_call_c(b, (void *)jit_getnamed_helper);
            emit_mov(b, REG_ACC, 0);
            break;
        }
        case OP_SetNamed: {
            uint8_t r = code[pc++];
            uint16_t k = BC_U16(code, pc); pc += 2;
            uint16_t f = BC_U16(code, pc); pc += 2;
            {
                static int noIC2 = -1;
                if (noIC2 < 0) noIC2 = getenv("OMNI_JIT_NOIC") ? 1 : 0;
                if (!noIC2 && jit_emit_setnamed_ic(b, fn, r, k, f)) break;
            }
            emit_read_r(b, 0, r);
            emit_ldr(b, 1, REG_K, k);
            emit_mov(b, 2, REG_ACC);
            emit_mov(b, 3, REG_ICBASE);
            emit_movz(b, 9, f);
            emit_add(b, 3, 3, 9);
            emit_call_c(b, (void *)omni_tab_set_ic);
            break;
        }
        case OP_GetKeyed: {
            uint8_t a = code[pc++], kb = code[pc++]; pc += 2;
            jit_emit_keyed_arr(b, a, kb, 0);
            break;
        }
        case OP_SetKeyed: {
            uint8_t a = code[pc++], kb = code[pc++]; pc += 2;
            jit_emit_keyed_arr(b, a, kb, 1);
            break;
        }
        case OP_SetMeta: {
            uint8_t r = code[pc++];
            /* `omni_setmetatable` 就两条 store 加一次 tag 判断，发成指令比调它便宜
               （x26 已经是 omni_objs，取 OTab* 只剩一条 ldr）。采样里它占 smallpt 7%：
               每造一个 Vec 就调一次。 */
            emit_read_r(b, 9, r);                        /* x9 = 那张表 */
            emit_mov64(b, 11, (uint64_t)OVAL_TAG_TAB);
            emit_lsr(b, 10, 9, 32);
            emit_cmp(b, 10, 11);
            uint32_t *sk1 = jit_fwd_bcond(b, 1);
            emit_mov32(b, 12, 9);
            emit_ldr_reg(b, 12, REG_OBJS, 12);
            emit_str(b, REG_ACC, 12, TAB_META_8);        /* t->meta = acc */
            jit_patch_fwd(b, sk1);
            emit_lsr(b, 10, REG_ACC, 32);
            emit_cmp(b, 10, 11);
            uint32_t *sk2 = jit_fwd_bcond(b, 1);
            emit_mov32(b, 12, REG_ACC);
            emit_ldr_reg(b, 12, REG_OBJS, 12);
            emit_mov64(b, 13, 1);
            emit_strb(b, 13, 12, 57);                    /* 元表从此是原型：is_proto = 1 */
            jit_patch_fwd(b, sk2);
            emit_mov(b, REG_ACC, 9);                     /* lua 的 setmetatable 回那张表 */
            break;
        }
        case OP_LdaUp: {
            uint8_t i = code[pc++];
            /* 内联体里 upvalue 数组是编译期常量（守卫比过闭包值了）：地址直接烧进码。
               不在内联体里就走 x25（第五个实参传进来的 clo->up）。
               OMNI_JIT_NOUP=1 退回老行为（这条发不了、整函数交给解释器），留着做 A/B。 */
            static int noUp = -1;
            if (noUp < 0) noUp = getenv("OMNI_JIT_NOUP") ? 1 : 0;
            if (noUp && jit_inline_up == NULL) return 0;
            if (jit_inline_up != NULL) {
                emit_mov64(b, 9, (uint64_t)(uintptr_t)&jit_inline_up[i]);
                emit_ldr(b, 9, 9, 0);                /* x9 = up[i]（格子指针） */
            } else {
                emit_ldr(b, 9, REG_UP, i);           /* x9 = up[i] */
            }
            emit_ldr(b, REG_ACC, 9, 0);              /* acc = *up[i] */
            break;
        }
        case OP_StaUp: {
            uint8_t i = code[pc++];
            if (jit_inline_up != NULL) {
                emit_mov64(b, 9, (uint64_t)(uintptr_t)&jit_inline_up[i]);
                emit_ldr(b, 9, 9, 0);
            } else {
                emit_ldr(b, 9, REG_UP, i);
            }
            emit_str(b, REG_ACC, 9, 0);              /* *up[i] = acc */
            break;
        }
        case OP_LdaEnv: {
            uint8_t i = code[pc++];
            /* Read extra_slot[i] */
            emit_mov64(b, 9, (uint64_t)(uintptr_t)omni_extra_slot);
            emit_ldr(b, REG_ACC, 9, i);
            break;
        }
        case OP_StaEnv: {
            pc++; /* skip */
            break;
        }

        /* ---- Call / Closure / RetMulti / VarargTable: all go through C helpers ---- */
        case OP_Call: {
            uint8_t base = code[pc++];
            uint8_t argc = code[pc++];
            uint16_t cf = BC_U16(code, pc); pc += 2;
            int32_t slot = fn->icBase + (int32_t)cf;

            /* ---- 去虚化 + 内联：单态、被调方短、直线码，就把它就地展开 ---- */
            static int noInline = -1;
            if (noInline < 0) noInline = getenv("OMNI_JIT_NOINLINE") ? 1 : 0;
            if (jit_inline_depth < JIT_INLINE_MAX_DEPTH && !noInline) {
                OVal fv = 0;
                uint32_t win = 0;
                OmniFn *ce = jit_inline_target(fn, pc - 5, jit_inline_depth, &fv, &win);
                uint32_t cnr = ce ? (ce->nreg ? ce->nreg : 1) : 0;
                int ok = ce != NULL
                         && (uint32_t)base + 1u + win <= (fn->nreg ? fn->nreg : 1);
                if (ok) {
                    /* 被调方那一段窗口在调用方这儿不许是"被捕获"的格子 */
                    for (uint32_t r = (uint32_t)base + 1; ok && r < (uint32_t)base + 1 + win; r++)
                        if (jit_is_captured(r)) ok = 0;
                }
                BCClo *clo = ok ? bcclo_get(fv) : NULL;
                if (ok) {
                    (void)cnr;
                    /* 守卫：R[base] 还是当初那个闭包值吗 */
                    emit_read_r(b, 9, base);
                    emit_mov64(b, 10, (uint64_t)fv);
                    emit_cmp(b, 9, 10);
                    uint32_t *miss = jit_fwd_bcond(b, 1);   /* B.NE → 慢路（照旧调 helper） */

                    /* 实参已经在 [base+1, base+1+argc) 了（Call 的约定），直接展开 */
                    int emitted = jit_emit_inline_body(b, fn, ce, clo,
                                                       (uint32_t)base + 1, win, argc,
                                                       fixups, nfixup);
                    if (!emitted) return 0;   /* 保守：整个函数放弃（缓冲区会被丢掉） */

                    uint32_t *done = jit_fwd_b(b);
                    jit_patch_fwd(b, miss);
                    emit_mov(b, 0, REG_R);
                    emit_movz(b, 1, base);
                    emit_movz(b, 2, argc);
                    emit_mov64(b, 3, (uint64_t)(uint32_t)slot);
                    emit_call_c(b, (void *)jit_call_helper);
                    emit_mov(b, REG_ACC, 0);
                    jit_patch_fwd(b, done);
                    if (getenv("OMNI_JIT_DEBUG"))
                        fprintf(stderr, "jit: 内联 @%u → proto %p（%u 条码）\n",
                                pc - 5, (void *)ce, ce->codeLen);
                    break;
                }
            }

            /* 内联不成 → 试"带守卫的直接调用"（跳过 helper 的一整套分发） */
            {
                static int noDC = -1;
                if (noDC < 0) noDC = getenv("OMNI_JIT_NODC") ? 1 : 0;
                if (!noDC && jit_inline_depth == 0
                    && jit_emit_direct_call(b, fn, base, argc, slot)) break;
            }
            /* jit_call_helper(R, base, argc, fbSlot) → acc
               fbSlot 是绝对槽号，编译期常量（这一段码只服务这一个 proto）。 */
            emit_mov(b, 0, REG_R);
            emit_movz(b, 1, base);
            emit_movz(b, 2, argc);
            emit_mov64(b, 3, (uint64_t)(uint32_t)slot);
            emit_call_c(b, (void *)jit_call_helper);
            emit_mov(b, REG_ACC, 0);
            break;
        }
        case OP_Closure: {
            uint16_t ki = BC_U16(code, pc); pc += 2;
            uint8_t nup = code[pc++];
            /* Save upvalue descriptor bytes pointer */
            uint8_t *descs = &code[pc];
            pc += nup * 2;
            /* jit_closure_helper(fn, ki, nup, descs, R, cellsp, curUp) */
            /* fn pointer: we need the OmniFn*. Store it as 64-bit immediate. */
            emit_mov64(b, 0, (uint64_t)(uintptr_t)fn);
            emit_movz(b, 1, ki);
            emit_movz(b, 2, nup);
            emit_mov64(b, 3, (uint64_t)(uintptr_t)descs);
            /* remaining args go on stack or we use more regs */
            /* x4 = R, x5 = cellsp, x6 = curUp（kind==1 的描述子要从它取） */
            emit_mov(b, 4, REG_R);
            emit_mov(b, 5, 24);          /* x5 = cellsp */
            emit_mov(b, 6, REG_UP);      /* x6 = 本闭包的 upvalue 数组 */
            emit_call_c(b, (void *)jit_closure_helper);
            emit_mov(b, REG_ACC, 0);
            emit_ldr(b, REG_CELLS, 24, 0);   /* 升格过就换成私有那份 */
            break;
        }
        case OP_RetMulti: {
            uint8_t base = code[pc++], n = code[pc++];
            /* jit_retmulti_helper(R, base, n) */
            emit_mov(b, 0, REG_R);
            emit_movz(b, 1, base);
            emit_movz(b, 2, n);
            emit_call_c(b, (void *)jit_retmulti_helper);
            /* acc = R[base] */
            emit_read_r(b, REG_ACC, base);
            /* Return acc */
            emit_mov(b, 0, REG_ACC);
            emit_ldp_post(b, 27, 28, 31, 2);
            emit_ldp_post(b, 25, 26, 31, 2);
            emit_ldp_post(b, 23, 24, 31, 2);
            emit_ldp_post(b, 21, 22, 31, 2);
            emit_ldp_post(b, 19, 20, 31, 2);
            emit_ldp_post(b, 29, 30, 31, 2);
            emit_ret(b);
            break;
        }
        case OP_VarargTable: {
            emit_call_c(b, (void *)jit_vararg_table_helper);
            emit_mov(b, REG_ACC, 0);
            break;
        }
        case OP_Nop: {
            break;
        }
        case OP_CallMethod: {
            /* Skip operands and fallback */
            pc += 1 + 2 + 1 + 2;
            return 0;   /* 这条发不了：调用方放弃整个函数 */
        }
        case OP_CallBuiltin: {
            pc += 3;
            return 0;   /* 这条发不了：调用方放弃整个函数 */
        }
        case OP_NewShaped: {
            uint16_t k = BC_U16(code, pc); pc += 2;
            uint8_t base = code[pc++], n = code[pc++];
            uint16_t f = BC_U16(code, pc); pc += 2;
            /* 形状已知就整段发成指令（`OMNI_JIT_NOALLOC=1` 关掉可复量） */
            {
                static int noAlloc = -1;
                if (noAlloc < 0) noAlloc = getenv("OMNI_JIT_NOALLOC") ? 1 : 0;
                if (!noAlloc && jit_emit_newshaped_ic(b, fn, k, base, n, f)) break;
            }
            emit_mov(b, 0, REG_R);
            emit_mov64(b, 9, (uint64_t)k * 8);
            emit_add(b, 1, REG_K, 9);          /* x1 = &K[k] */
            emit_movz(b, 2, base);
            emit_movz(b, 3, n);
            emit_mov(b, 4, REG_ICBASE);
            emit_movz(b, 9, f);
            emit_add(b, 4, 4, 9);
            emit_call_c(b, (void *)jit_newshaped_helper);
            emit_mov(b, REG_ACC, 0);
            break;
        }
        case OP_GetFields: {
            uint8_t r = code[pc++];
            uint16_t k = BC_U16(code, pc); pc += 2;
            uint8_t dst = code[pc++], n = code[pc++];
            uint16_t f = BC_U16(code, pc); pc += 2;
            /* 被捕获的槽走不了内联版（要经 cells），那种情况让整条退回逐个 GetNamed。 */
            for (uint8_t i = 0; i < n; i++) if (jit_is_captured((uint32_t)(dst + i))) return 0;
            /* **尝试守卫共享版**（一次守卫 + n 条定偏移 load，全发成指令） */
            if (jit_emit_getfields_ic(b, fn, r, k, dst, n, f)) break;
            /* 通用版：调 omni_tab_getn_ic */
            emit_read_r(b, 0, r);
            emit_mov64(b, 9, (uint64_t)k * 8);
            emit_add(b, 1, REG_K, 9);           /* x1 = &K[k] */
            emit_movz(b, 2, n);
            emit_mov(b, 3, REG_ICBASE);
            emit_movz(b, 9, f);
            emit_add(b, 3, 3, 9);
            emit_mov64(b, 9, (uint64_t)dst * 8);
            emit_add(b, 4, REG_R, 9);           /* x4 = &R[dst] */
            emit_call_c(b, (void *)omni_tab_getn_ic);
            break;
        }
        default:
            /* 没实现的字节码：放弃整个函数（解释器给同一个答案） */
            if (getenv("OMNI_JIT_DEBUG"))
                fprintf(stderr, "jit: 放弃（%s@%u 没实现）\n", omni_op_name[op], pc - 1);
            return 0;
        }
    return pc;
}

/**
 * **一串连着的浮点算术只装箱一次**（Tier 1 里最接近"值留在寄存器"的一刀）。
 *
 * 逐条发的时候每个算子都是：ldr 操作数 → OR 起来判是不是数 → fmov 两次 → 一条浮点 →
 * fmov 回去，约 10 条指令干一件 1 条指令的事。连着 k 个算子（`a*b + c*d` 那种）时，
 * 把**所有操作数一次装进整数寄存器、一起判一次类型**，中间结果就留在 d0 里，
 * 最后才装箱一次：约 6k+6 条 → 省掉 k-1 次装箱/拆箱与 k-1 次类型判。
 *
 * 判据来自**解释器攒的算术反馈**（`ARITH_NUM`：这个点只见过数 op 数）。判失手不会错答案：
 * 守卫全部在动 acc 之前做完，不中就跳到后面那份**逐条发的原版**。
 * 回 0 = 这儿没有可融的串（调用方照旧逐条发）。
 */
static uint32_t jit_emit_arith_run(JitBuf *b, OmniFn *fn, uint32_t pc,
                                   const uint8_t *isTarget, Fixup *fixups, int *nfixup) {
    static int noRun = -1;
    if (noRun < 0) noRun = getenv("OMNI_JIT_NORUN") ? 1 : 0;
    if (noRun) return 0;

    const uint8_t *code = fn->code;
    uint8_t ops[4]; uint8_t regs[4]; uint32_t pcs[4];
    int k = 0;
    uint32_t q = pc;
    while (k < 4 && q + 4 <= fn->codeLen) {
        uint8_t o = code[q];
        if (o != OP_Add && o != OP_Sub && o != OP_Mul && o != OP_Div) break;
        if (k > 0 && isTarget != NULL && isTarget[q]) break;     /* 跳转落点：串到这儿断 */
        uint8_t r = code[q + 1];
        uint16_t fb = BC_U16(code, q + 2);
        if (!arith_site_is_num(fn->icBase + (int32_t)fb)) break;
        if (jit_is_captured(r)) break;
        ops[k] = o; regs[k] = r; pcs[k] = q;
        k++;
        q += 4;
    }
    if (k < 2) return 0;

    /* 1) 操作数一次全装进 x9.. ，**每个单独判**是不是数。
          ⚠️ 不能像单条那样"OR 起来判一次"：OR 会把几个数的指数位凑满 ——
          `1.5 | 4096.0` 的指数域就是全 1，再带上一个负数的符号位就成了 0xFFF8xxxx，
          判成"不是数"而白走慢路。smallpt 里 1e5 与 ~1 的量级混着用，这一档踩得很准
          （量到过 +3.6%）。逐个判只多 k-1 条指令，但一次假失手都没有。 */
    for (int i = 0; i < k; i++) emit_ldr(b, 9 + i, REG_R, (int)regs[i]);
    emit_mov64(b, 13, (uint64_t)OVAL_TAG_FIRST);
    uint32_t *miss[5]; int nmiss = 0;
    emit_lsr(b, 14, REG_ACC, 32);
    emit_cmp(b, 14, 13);
    miss[nmiss++] = jit_fwd_bcond(b, 2);         /* B.CS → 不是数 */
    for (int i = 0; i < k; i++) {
        emit_lsr(b, 14, 9 + i, 32);
        emit_cmp(b, 14, 13);
        miss[nmiss++] = jit_fwd_bcond(b, 2);
    }

    /* 2) 中间结果留在 d0：acc = R[r] op acc（ISA 里寄存器是左操作数） */
    emit_fmov_d_x(b, 0, REG_ACC);
    for (int i = 0; i < k; i++) {
        emit_fmov_d_x(b, 1, 9 + i);
        switch (ops[i]) {
        case OP_Add: emit_fadd(b, 0, 1, 0); break;
        case OP_Sub: emit_fsub(b, 0, 1, 0); break;
        case OP_Mul: emit_fmul(b, 0, 1, 0); break;
        default:     emit_fdiv(b, 0, 1, 0); break;
        }
    }
    emit_fmov_x_d(b, REG_ACC, 0);
    uint32_t *done = jit_fwd_b(b);

    /* 3) 慢路：把这一串的描述表烧成指针，调一次 helper 走通用语义。
          （守卫在动 acc 之前做完，所以跳过来时 R[]/acc 都还是原样。
           不逐条重发是因为那份副本比省下的还大 —— 量过 smallpt +4%。） */
    for (int i = 0; i < nmiss; i++) jit_patch_fwd(b, miss[i]);
    ArithRun *d = (ArithRun *)calloc(1, sizeof(ArithRun));
    d->k = (uint8_t)k;
    for (int i = 0; i < k; i++) {
        d->ops[i] = ops[i]; d->regs[i] = regs[i];
        d->slots[i] = fn->icBase + (int32_t)BC_U16(code, pcs[i] + 2);
    }
    emit_mov(b, 0, REG_R);
    emit_mov(b, 1, REG_ACC);
    emit_mov64(b, 2, (uint64_t)(uintptr_t)d);
    emit_call_c(b, (void *)jit_arith_run_helper);
    emit_mov(b, REG_ACC, 0);
    jit_patch_fwd(b, done);
    return q;
}

/* FrameArena 的字节布局：mem=0、cap=8、top=16（单位 8 字节：0/1/2） */
#define ARENA_MEM_8  0
#define ARENA_CAP_8  1
#define ARENA_TOP_8  2

/**
 * **带守卫的直接调用**（内联不了的被调方：有分支的大函数，radiance/intersect 那一族）。
 *
 * 守卫比闭包值；命中就自己开帧（arena 推指针）、搬实参、直接 `blr` 被调方的 jitFn，
 * 跳过 `jit_call_helper` 的一整套分发（取闭包、判 native、记反馈、判热度、
 * `vm_ic_ensure`、`cells_release`、恢复 vm_ic_base）。采样里 jit_call_helper 占 smallpt 20%。
 *
 * 前提（差一条就回 0 走原来那条路）：
 *   单态 / 非 vararg / argc==nparams / 被调方**没有 kind==0 的闭包捕获**（于是 cells
 *   永远是那页共享空表，不必在栈上留可写的一格、也不必 cells_release）/ 帧放得下。
 * jitFn 是**运行期从 `&callee->jitFn` 读**的：编译这一格时被调方可能还没编（自递归就是这样），
 * 读到 0 或失败哨兵 1 就落慢路，编好之后自然就走快路。
 */
static int jit_emit_direct_call(JitBuf *b, OmniFn *fn, uint8_t base, uint8_t argc,
                                int32_t slot) {
    OVal fv = 0;
    OmniFn *ce = call_site_mono(slot, &fv);
    if (ce == NULL || ce->isVararg || argc != ce->nparams) return 0;
    BCClo *clo = bcclo_get(fv);
    if (clo->native || clo->fn != ce) return 0;
    /* 被调方里有"从本帧捕获局部量"的闭包吗（那样 cells 会被升格成私有的） */
    uint32_t q = 0;
    while (q < ce->codeLen) {
        if (ce->code[q] == OP_Closure) {
            uint32_t at = q + 3; uint8_t nup = ce->code[at]; at++;
            for (uint8_t u = 0; u < nup; u++) { if (ce->code[at] == 0) return 0; at += 2; }
        }
        q += omni_bc_len_at(ce->code, q);
    }
    uint32_t cnr = ce->nreg ? ce->nreg : 1;
    if (cnr > 200) return 0;

    uint32_t *miss[3]; int nmiss = 0;
    emit_read_r(b, 9, base);
    emit_mov64(b, 10, (uint64_t)fv);
    emit_cmp(b, 9, 10);
    miss[nmiss++] = jit_fwd_bcond(b, 1);             /* 不是当初那个闭包 */
    emit_mov64(b, 11, (uint64_t)(uintptr_t)&ce->jitFn);
    emit_ldr(b, 12, 11, 0);                          /* x12 = callee->jitFn */
    emit_cmp_imm(b, 12, 1);
    miss[nmiss++] = jit_fwd_bcond(b, 9);             /* B.LS：0（没编）或 1（编失败）→ 慢路 */

    /* 开帧：arena 推指针（与 frame_alloc_from 的快路逐条对应） */
    emit_mov64(b, 13, (uint64_t)(uintptr_t)&vm_arena);
    emit_ldr(b, 13, 13, 0);                          /* x13 = vm_arena */
    emit_ldr(b, 14, 13, ARENA_TOP_8);                /* x14 = top */
    emit_ldr(b, 10, 13, ARENA_CAP_8);                /* x10 = cap */
    emit_mov64(b, 11, (uint64_t)cnr);
    emit_add(b, 11, 14, 11);                         /* x11 = top + cnr */
    emit_cmp(b, 11, 10);
    miss[nmiss++] = jit_fwd_bcond(b, 8);             /* B.HI：这一块不够 → 慢路 */
    emit_str(b, 11, 13, ARENA_TOP_8);                /* top += cnr */
    emit_ldr(b, 10, 13, ARENA_MEM_8);                /* x10 = mem */
    emit_mov64(b, 11, 3);
    emit(b, 0x9AC02000 | (11 << 16) | (14 << 5) | 0);/* LSLV x0, x14, x11（top*8） */
    emit_add(b, 0, 10, 0);                           /* x0 = cR = mem + top*8 */

    /* 实参：R[base+1+i] → cR[i]；余下的格子填 nil */
    for (uint32_t i = 0; i < argc; i++) {
        emit_ldr(b, 9, REG_R, (int)((uint32_t)base + 1 + i));
        emit_str(b, 9, 0, (int)i);
    }
    emit_mov64(b, 9, (uint64_t)oval_nil());
    for (uint32_t i = argc; i < cnr; i++) emit_str(b, 9, 0, (int)i);

    emit_mov64(b, 1, (uint64_t)(uintptr_t)ce->K);
    emit_mov64(b, 2, (uint64_t)(uintptr_t)&vm_nocells_holder);
    emit_mov64(b, 3, (uint64_t)(uint32_t)ce->icBase);
    emit_mov64(b, 4, (uint64_t)(uintptr_t)clo->up);
    emit_mov64(b, 5, (uint64_t)oval_nil());
    emit_blr(b, 12);
    emit_mov(b, REG_ACC, 0);
    /* 还帧：top -= cnr（我们那一格一定是最后分出去的） */
    emit_mov64(b, 13, (uint64_t)(uintptr_t)&vm_arena);
    emit_ldr(b, 13, 13, 0);
    emit_ldr(b, 14, 13, ARENA_TOP_8);
    emit_mov64(b, 11, (uint64_t)cnr);
    emit_sub(b, 14, 14, 11);
    emit_str(b, 14, 13, ARENA_TOP_8);
    /* 手写的 blr：x26/x27 自己重装（被调方里跑过 C） */
    emit_mov64(b, 9, (uint64_t)(uintptr_t)&omni_objs);
    emit_ldr(b, REG_OBJS, 9, 0);
    emit_mov64(b, 9, (uint64_t)(uintptr_t)&omni_shape_gen);
    emit_ldr32(b, REG_GEN, 9, 0);
    uint32_t *done = jit_fwd_b(b);

    for (int i = 0; i < nmiss; i++) jit_patch_fwd(b, miss[i]);
    emit_mov(b, 0, REG_R);
    emit_movz(b, 1, base);
    emit_movz(b, 2, argc);
    emit_mov64(b, 3, (uint64_t)(uint32_t)slot);
    emit_call_c(b, (void *)jit_call_helper);
    emit_mov(b, REG_ACC, 0);
    jit_patch_fwd(b, done);
    return 1;
}

/** 发一条 —— 先看看这儿能不能融一串浮点算术 */
static uint32_t jit_emit_seq(JitBuf *b, OmniFn *fn, uint32_t pc,
                             const uint8_t *isTarget, Fixup *fixups, int *nfixup) {
    uint32_t n = jit_emit_arith_run(b, fn, pc, isTarget, fixups, nfixup);
    if (n) return n;
    return jit_emit_one(b, fn, pc, fixups, nfixup);
}

/* ---- 通道 7：发码（复用 Tier 1 的 jit_emit_one）----
 *
 * 为什么能复用：`jit_emit_one(b, fn, pc, fixups, nfixup)` 从字节码发到 JitBuf，
 * 只看 fn->code[pc] 与几个文件级 static（jit_captured、jit_inline_depth 等）。
 * S_BC 节点就是"这条字节码 Tier 2 不接，照 Tier 1 原样发"—— 所以直接调它。
 *
 * 第一个里程碑（**纯 S_BC**）：图里所有节点都当 S_BC 发（包括 S_FADD 那些已经特化的）。
 * 这样产出的码应当**与 Tier 1 逐字节相同**（判据），证明"建图→发码"这条管道没有漏洞。
 * 后面逐个把 S_FADD / S_GUARD_SHAPE / S_ALLOC_SHAPED 换成特化的码。
 *
 * ⚠️ 内联展开过的 S_BC：`SsaVal.shift != 0` 或 `SsaVal.ofn != fn`（属于内联进来的 proto）。
 *    第一个里程碑里 Tier 2 的内联关掉（`SSA_INLINE_MAX_DEPTH` 只影响 ssa.c 内部，
 *    Tier 1 自己还是照旧做），图里不会有异 proto 的 S_BC，所以暂时不用挪 x19。
 */

/** 给 Tier 2 建一份干净的图（不内联），然后逐块走 S_BC 发码。
 *  回 NULL = 放弃（碰到了没建模的东西、缓冲溢出等）；否则回 JitFn。 */
/* ---- Tier 2 发码的上下文 ----
 *
 * 为什么要成一个结构 + 递归函数：**标量替换必须看得见内联体里的 NewShaped**。
 * `Vec.__add` 里那句 `Vec.new(...)` 造出来的表，只有在"内联过的图"里才判得出可拆
 * （在 `Vec.new` 自己的图里它是 return 出去的，一定逃逸）。而要让这一层的 walk
 * 看见它，就得**由这一层自己展开内联体**（挪 x19），不能交给 `jit_emit_one` 整段发。
 *
 * 帧格号一律用**绝对**的（shift + r）—— sunk 跟踪、读写集核对都按这个来。
 */
#define T2_SINK_MAX 8
#define T2_INLINE_MAX_DEPTH 2

typedef struct {
    JitBuf   *b;
    OmniFn   *rootFn;
    SsaFunc  *f;
    uint8_t  *sinkable;
    uint32_t **labels;
    Fixup    *fixups;
    int      *nfixup;
    uint8_t  *isTarget;
    /* 帧格 → 装着第几个被拆对象（-1 = 没有）。按绝对格号索引。 */
    int8_t   *slotSunk;
    int32_t   nslot;
    struct { int32_t val; uint8_t n; uint16_t kbase; int32_t fieldBase; OmniFn *kfn; }
              sunk[T2_SINK_MAX];
    int       nsunk;
    int       accSunk;
    int       bail;        /* 1 = 碰到没建模的用法，整函数放弃 */
    int       nsunkDone;   /* 统计：真拆了几处 */
    int       ninl;        /* 统计：Tier 2 自己展开了几个 Call */
    /* 可拆的分配点按 (proto, pc) 记，**每一遍都判可拆**才敢拆。
       ⚠️ 量出来这条规则太粗：`Vec.new` 只有一个分配点，在 radiance 里被展开 43 遍、
       只有 1 遍可拆 ⇒ AND 下来永远是 0。要用上逐遍的判决，就得让"发码时的这一遍"
       与"图里的那一遍"对得上号 —— 而图用的是单调水位窗口、发码用的是 Tier 1 的 base+1，
       两者对不上。**正解是发码改成按图走**（见文件头那段），不是继续修这张表。 */
    struct { OmniFn *fn; uint32_t pc; uint8_t ok; } site[64];
    int       nsite;
} T2Ctx;

/** (proto, pc) 这个分配点可拆吗 */
static int t2_site_ok(T2Ctx *c, OmniFn *cfn, uint32_t pc) {
    for (int i = 0; i < c->nsite; i++)
        if (c->site[i].fn == cfn && c->site[i].pc == pc) return c->site[i].ok;
    return 0;
}

/** 这条字节码（cfn@pc，帧底已挪了 shift 格）读的帧格里，有没有装着被拆的对象。
    有就说明逃逸分析看漏了 ⇒ 让调用方放弃。 */
static int t2_touches_sunk(T2Ctx *c, OmniFn *cfn, uint32_t pc, int32_t shift) {
    int32_t rs[64];
    SsaVal probe;
    memset(&probe, 0, sizeof(probe));
    probe.op = S_BC; probe.aux = (int64_t)pc; probe.ofn = cfn; probe.shift = shift;
    int nr = ssa_bc_read_set(c->f, &probe, rs, 64);
    if (nr < 0) {
        for (int32_t i = 0; i < c->nslot; i++) if (c->slotSunk[i] >= 0) return 1;
    } else {
        for (int j = 0; j < nr; j++)
            if (rs[j] >= 0 && rs[j] < c->nslot && c->slotSunk[rs[j]] >= 0) return 1;
    }
    if (c->accSunk >= 0 && ssa_bc_reads_acc(&probe)) return 1;
    return 0;
}

/** 这条字节码写了哪些帧格 ⇒ 那几格里原来装的被拆对象就不在那儿了。 */
static void t2_kill_written(T2Ctx *c, OmniFn *cfn, uint32_t pc, int32_t shift) {
    int32_t ws[16];
    int nw = ssa_bc_write_set(c->f, cfn, pc, shift, ws, 16);
    if (nw < 0) { memset(c->slotSunk, -1, (size_t)c->nslot); c->accSunk = -1; return; }
    for (int j = 0; j < nw; j++)
        if (ws[j] >= 0 && ws[j] < c->nslot) c->slotSunk[ws[j]] = -1;
}

/** **Tier 2 的发码主循环**（递归：内联体由这一层自己展开）。
    cfn = 这段码属于哪个 proto；shift = 它的 R[0] 落在最外层帧的哪一格；
    inl != 0 表示这是内联体（到第一条 Ret 为止，Ret 不发）。
    回 0 = 放弃（调用方清理并退回 Tier 1）。 */
static int t2_emit_range(T2Ctx *c, OmniFn *cfn, uint32_t from, uint32_t stop,
                         int32_t shift, int depth, int inl) {
    JitBuf *b = c->b;
    const uint8_t *code = cfn->code;
    uint32_t *lastInsn = NULL;
    uint32_t pc = from;
    while (pc <= stop && pc < cfn->codeLen) {
        if (c->bail) return 0;
        uint8_t op = code[pc];
        if (inl && op == OP_Ret) break;
        if (depth == 0) c->labels[pc] = b->p;
        uint32_t *firstInsn = b->p;
        if (b->p + 16384 > b->end) return 0;
        uint32_t oplen = omni_bc_len_at(code, pc);

        /* ---- 被拆对象相关的那几条，自己发 ---- */
        int handled = 0;
        int32_t abs1 = (pc + 1 < cfn->codeLen) ? shift + (int32_t)code[pc + 1] : -1;
        int inRange1 = (abs1 >= 0 && abs1 < c->nslot);

        if (op == OP_NewShaped) {
            uint8_t base = code[pc + 3], n = code[pc + 4];
            if (t2_site_ok(c, cfn, pc) && c->nsunk < T2_SINK_MAX
                && n > 0 && (int32_t)c->rootFn->nreg + n < c->nslot) {
                int32_t fb = (int32_t)c->rootFn->nreg;
                c->rootFn->nreg += n;
                for (uint8_t i = 0; i < n; i++) {
                    emit_read_r(b, 9, (uint32_t)(base + i));
                    emit_str(b, 9, REG_R, fb + i);
                }
                c->sunk[c->nsunk].val = -1; c->sunk[c->nsunk].n = n;
                c->sunk[c->nsunk].kbase = BC_U16(code, pc + 1);
                c->sunk[c->nsunk].fieldBase = fb; c->sunk[c->nsunk].kfn = cfn;
                c->accSunk = c->nsunk; c->nsunk++; c->nsunkDone++;
                handled = 1;
            }
        } else if (op == OP_StaR && c->accSunk >= 0 && inRange1) {
            c->slotSunk[abs1] = (int8_t)c->accSunk; handled = 1;
        } else if (op == OP_LdaR && inRange1 && c->slotSunk[abs1] >= 0) {
            c->accSunk = c->slotSunk[abs1]; handled = 1;
        } else if (op == OP_Mov && inRange1 && c->slotSunk[abs1] >= 0) {
            int32_t d = shift + (int32_t)code[pc + 2];
            if (d >= 0 && d < c->nslot) { c->slotSunk[d] = c->slotSunk[abs1]; handled = 1; }
        } else if (op == OP_SetMeta && inRange1 && c->slotSunk[abs1] >= 0) {
            /* 元表是编译期常量、被拆的对象没人看得到它 ⇒ 整句不发；语义上 acc = R[r] */
            c->accSunk = c->slotSunk[abs1]; handled = 1;
        } else if ((op == OP_GetNamed || op == OP_GetFields) && inRange1
                   && c->slotSunk[abs1] >= 0) {
            int si = c->slotSunk[abs1];
            uint16_t k = BC_U16(code, pc + 2);
            int nread = (op == OP_GetFields) ? (int)code[pc + 4] : 1;
            uint8_t dst = (op == OP_GetFields) ? code[pc + 3] : 0;
            handled = 1;
            for (int j = 0; j < nread && handled; j++) {
                int fi = -1;
                for (uint8_t i2 = 0; i2 < c->sunk[si].n; i2++)
                    if (c->sunk[si].kfn->K[c->sunk[si].kbase + i2] == cfn->K[k + j]) { fi = i2; break; }
                if (fi < 0) { c->bail = 1; return 0; }
                if (op == OP_GetFields) {
                    emit_ldr(b, 9, REG_R, c->sunk[si].fieldBase + fi);
                    emit_write_r(b, 9, (uint32_t)(dst + j));
                } else {
                    emit_ldr(b, REG_ACC, REG_R, c->sunk[si].fieldBase + fi);
                }
            }
        }
        if (handled) { pc += oplen; lastInsn = NULL; continue; }

        /* ---- Tier 2 自己展开的 Call 内联 ---- */
        if (op == OP_Call && depth + 1 < T2_INLINE_MAX_DEPTH
            && !getenv("OMNI_SSA_NOINL")) {
            uint8_t base = code[pc + 1], argc = code[pc + 2];
            OVal fv = 0; uint32_t win = 0;
            OmniFn *ce = jit_inline_target(cfn, pc, depth, &fv, &win);
            int32_t wb = shift + (int32_t)base + 1;
            if (ce != NULL && wb + (int32_t)win < c->nslot
                && wb + (int32_t)win <= (int32_t)c->rootFn->nreg) {
                uint32_t cnr = ce->nreg ? ce->nreg : 1;
                BCClo *clo = bcclo_get(fv);
                /* 实参里带着被拆对象的话，跟踪跟着搬过去（窗口就是 base+1 起那几格，
                   与 Tier 1 的布局一致，所以实参本来就在位上） */
                emit_mov64(b, 9, (uint64_t)oval_nil());
                for (uint32_t r2 = argc; r2 < cnr; r2++) {
                    emit_str(b, 9, REG_R, (int)(base + 1 + r2));
                    if (wb + (int32_t)r2 < c->nslot) c->slotSunk[wb + (int32_t)r2] = -1;
                }
                emit_mov64(b, REG_ACC, (uint64_t)oval_nil());
                c->accSunk = -1;

                emit_mov64(b, 9, (uint64_t)(base + 1) * 8);
                emit_add(b, REG_R, REG_R, 9);
                emit_mov64(b, REG_K, (uint64_t)(uintptr_t)ce->K);
                emit_mov64(b, REG_ICBASE, (uint64_t)(uint32_t)ce->icBase);

                const uint8_t *savedCap = jit_captured;
                uint32_t savedCapN = jit_captured_n;
                OVal **savedUp = jit_inline_up;
                jit_captured = savedCap ? savedCap + (base + 1) : NULL;
                jit_captured_n = win;
                jit_inline_up = clo->up;
                jit_inline_depth++;
                jit_shift_total += (uint32_t)(base + 1);

                c->ninl++;
                int ok = t2_emit_range(c, ce, 0, ce->codeLen - 1, wb, depth + 1, 1);

                jit_inline_depth--;
                jit_shift_total -= (uint32_t)(base + 1);
                jit_inline_up = savedUp;
                jit_captured = savedCap; jit_captured_n = savedCapN;

                emit_mov64(b, 9, (uint64_t)(base + 1) * 8);
                emit_sub(b, REG_R, REG_R, 9);
                emit_mov64(b, REG_K, (uint64_t)(uintptr_t)cfn->K);
                emit_mov64(b, REG_ICBASE, (uint64_t)(uint32_t)cfn->icBase);
                if (!ok) return 0;
                pc += oplen; lastInsn = NULL; continue;
            }
        }

        /* ---- 其余：先核对"有没有碰到被拆的对象"，再交给 Tier 1 发 ---- */
        if (c->nsunk > 0) {
            if (t2_touches_sunk(c, cfn, pc, shift)) { c->bail = 1; return 0; }
            t2_kill_written(c, cfn, pc, shift);
            c->accSunk = -1;
        }
        uint32_t next = jit_emit_seq(b, cfn, pc, depth == 0 ? c->isTarget : NULL,
                                     c->fixups, c->nfixup);
        if (next == 0) return 0;
        if (lastInsn != NULL && (depth != 0 || !c->isTarget[pc])
            && firstInsn == lastInsn + 1 && b->p > firstInsn)
            jit_fuse_store_load(lastInsn, firstInsn);
        lastInsn = (b->p > firstInsn) ? b->p - 1 : lastInsn;
        pc = next;
    }
    return 1;
}

/** Tier 2 的入口：建图（**带内联的预算**）→ 逃逸判决 → 递归发码。
 *  回 NULL = 接不下，照旧走 Tier 1。 */
static JitFn ssa_emit(OmniFn *fn) {
    SsaFunc f;
    memset(&f, 0, sizeof(f));
    f.fn = fn;
    /* **要带内联的预算**：`Vec.new` 造的那张表只有在内联过的图里才判得出可拆 */
    f.nreg = (fn->nreg ? fn->nreg : 1) + SSA_INLINE_PAD;
    f.realNreg = fn->nreg ? fn->nreg : 1;
    f.scratchTop = (int32_t)(fn->nreg ? fn->nreg : 1);
    if (!ssa_split_blocks(&f) || !ssa_translate(&f)) { ssa_free(&f); return NULL; }
    ssa_liveness(&f);

    uint8_t *sinkable = (uint8_t *)calloc((size_t)(f.nval ? f.nval : 1), 1);
    int nalloc = 0, nfield = 0, nsink = 0, why3[3] = {0, 0, 0};
    ssa_escape_count(&f, &nalloc, &nfield, &nsink, why3, sinkable);
    static int noSink = -1;
    if (noSink < 0) noSink = getenv("OMNI_SSA_NOSINK") ? 1 : 0;
    if (noSink) { memset(sinkable, 0, (size_t)(f.nval ? f.nval : 1)); nsink = 0; }

    JitBuf jb = jit_alloc();
    JitBuf *b = &jb;
    jit_make_writable();

    uint8_t *code = fn->code;
    uint32_t codeLen = fn->codeLen;

    /* 序言（必须与 Tier 1 逐条相同 —— JitFn 的 ABI 就是这几行定的） */
    emit_stp_pre(b, 29, 30, 31, -2);
    emit_stp_pre(b, 19, 20, 31, -2);
    emit_stp_pre(b, 21, 22, 31, -2);
    emit_stp_pre(b, 23, 24, 31, -2);
    emit_stp_pre(b, 25, 26, 31, -2);
    emit_stp_pre(b, 27, 28, 31, -2);
    emit_mov(b, REG_R, 0);
    emit_mov(b, REG_K, 1);
    emit_mov(b, 24, 2);
    emit_ldr(b, REG_CELLS, 24, 0);
    emit_mov(b, REG_ICBASE, 3);
    emit_mov(b, REG_UP, 4);
    emit_mov64(b, 9, (uint64_t)(uintptr_t)&omni_objs);
    emit_ldr(b, REG_OBJS, 9, 0);
    emit_mov64(b, 9, (uint64_t)(uintptr_t)&omni_shape_gen);
    emit_ldr32(b, REG_GEN, 9, 0);
    emit_mov(b, REG_ACC, 5);

    uint32_t **labels = (uint32_t **)calloc(codeLen + 1, sizeof(uint32_t *));
    Fixup *fixups = (Fixup *)calloc(codeLen, sizeof(Fixup));
    int nfixup = 0;

    /* 跳转落点：**必须传给 jit_emit_seq**，不然融合算术串会跨过落点 */
    uint8_t *isTarget = (uint8_t *)calloc(codeLen + 1, 1);
    for (uint32_t q = 0; q < codeLen; ) {
        uint8_t op = code[q];
        uint32_t len = omni_bc_len_at(code, q);
        if (op == OP_Jump || op == OP_JumpIfTrue || op == OP_JumpIfFalse
            || op == OP_JumpIfNil || op == OP_JumpLoop || op == OP_ForPrep || op == OP_ForLoop) {
            int32_t off = BC_I32(code, q + len - 4);
            uint32_t tgt = (uint32_t)((int64_t)(q + len) + off);
            if (tgt <= codeLen) isTarget[tgt] = 1;
        }
        q += len;
    }

    T2Ctx c;
    memset(&c, 0, sizeof(c));
    c.b = b; c.rootFn = fn; c.f = &f; c.sinkable = sinkable;
    c.labels = labels; c.fixups = fixups; c.nfixup = &nfixup; c.isTarget = isTarget;
    /* 帧格位图要覆盖到"抬完 nreg + 所有被拆对象的窗口"为止 */
    /* 逐值判决 → 按 (proto, pc) 归并：同一个点展开多遍，全可拆才算可拆 */
    for (int32_t v = 0; v < f.nval; v++) {
        if (f.vals[v].op != S_ALLOC_SHAPED || f.vals[v].ofn == NULL) continue;
        int k = -1;
        for (int i = 0; i < c.nsite; i++)
            if (c.site[i].fn == f.vals[v].ofn && c.site[i].pc == f.vals[v].srcPc) { k = i; break; }
        if (k < 0) {
            if (c.nsite >= 64) continue;
            k = c.nsite++;
            c.site[k].fn = f.vals[v].ofn; c.site[k].pc = f.vals[v].srcPc; c.site[k].ok = 1;
        }
        if (!sinkable[v]) c.site[k].ok = 0;
    }
    if (getenv("OMNI_SSA_SITES"))
        for (int i = 0; i < c.nsite; i++)
            fprintf(stderr, "jit: 分配点 proto %p pc %u 可拆=%d（root %p）\n",
                    (void *)c.site[i].fn, c.site[i].pc, (int)c.site[i].ok, (void *)fn);
    c.nslot = (int32_t)fn->nreg + T2_SINK_MAX * 8 + 8;
    c.slotSunk = (int8_t *)malloc((size_t)c.nslot);
    memset(c.slotSunk, -1, (size_t)c.nslot);
    c.accSunk = -1;

    uint32_t *codeStart = b->p;
    int ok = t2_emit_range(&c, fn, 0, codeLen - 1, 0, 0, 0);
    labels[codeLen] = b->p;

    if (!ok) {
        free(labels); free(fixups); free(isTarget); free(sinkable); free(c.slotSunk);
        ssa_free(&f); jit_bail(&jb);
        return NULL;
    }

    /* 回填跳转（窥孔必须在这之后 —— 之前占位分支偏移还是 0，扫不出真落点） */
    for (int i = 0; i < nfixup; i++) {
        uint32_t *patch = fixups[i].patch;
        uint32_t *target = labels[fixups[i].target_bc];
        if (target == NULL) continue;
        int32_t off = (int32_t)(target - patch);
        if (fixups[i].kind == 0)
            *patch = 0x14000000 | (uint32_t)(off & 0x03FFFFFF);
        else {
            uint32_t cond = *patch & 0xF;
            *patch = 0x54000000 | ((uint32_t)(off & 0x7FFFF) << 5) | cond;
        }
    }
    jit_peephole(codeStart, b->p);

    if (getenv("OMNI_SSA_SITES"))
        fprintf(stderr, "jit: Tier 2 自展开 Call %d 个、拆掉造表 %d 处（proto %p）\n",
                c.ninl, c.nsunkDone, (void *)fn);
    if (c.nsunkDone && getenv("OMNI_JIT_DEBUG"))
        fprintf(stderr, "jit: Tier 2 拆掉了 %d 处造表（proto %p）\n", c.nsunkDone, (void *)fn);

    free(labels); free(fixups); free(isTarget); free(sinkable); free(c.slotSunk);
    jit_make_exec(b);
    ssa_free(&f);
    return (JitFn)(void *)jb.buf;
}

static JitFn jit_compile_at(OmniFn *fn, uint32_t startPc) {
    /* 调用点反馈的现状（OMNI_JIT_DEBUG=1 看）：单态的点才有资格做去虚化+内联。
       这是 Go 的 findHotConcreteFunctionCallee 那一步的产物，只是我们的 profile 是
       解释阶段（前 OMNI_JIT_HOT 次调用）在反馈槽里攒的。 */
    if (getenv("OMNI_JIT_DEBUG")) {
        uint32_t nc = 0, nmono = 0, p = 0;
        while (p < fn->codeLen) {
            if (fn->code[p] == OP_Call) {
                uint16_t cf = BC_U16(fn->code, p + 3);
                OmniFn *c = call_site_mono(fn->icBase + (int32_t)cf, NULL);
                nc++;
                if (c) {
                    nmono++;
                    fprintf(stderr, "jit: 调用点 @%u 单态 → proto %p（%u 条码、%u 个寄存器）\n",
                            p, (void *)c, c->codeLen, c->nreg);
                } else {
                    fprintf(stderr, "jit: 调用点 @%u 槽 %d 状态 %d（非单态）\n",
                            p, fn->icBase + (int32_t)cf,
                            (int)omni_ics[fn->icBase + (int32_t)cf].off);
                }
            }
            p += omni_bc_len_at(fn->code, p);
        }
        if (nc) fprintf(stderr, "jit: 调用点 %u 个，单态 %u 个\n", nc, nmono);
    }

    /* Tier 2（ssa.c）先看一眼：它接得下就用它的码，接不下照旧走下面的基线。
       现在它只建图、不发码，所以这一句等于观察点（OMNI_SSA=1 打印）。 */
    if (ssa_try(fn, "jit")) { /* 以后这里拿 Tier 2 的函数指针 */ }

    /* 帧要按"放得下内联窗口"来分配：先看一遍哪些 Call 点要内联，把 fn->nreg 抬到够用。
       为什么可以就地改 nreg：所有给 JIT 码用的帧都是**编译之后**才按 fn->nreg 分配的
       （L_Call 与 jit_call_helper 都在编译之后才读 nreg —— 这个次序是必须的）；
       正在解释器里跑的那些旧帧只被解释器用，它读写的下标永远 < 老的 nreg。 */
    {
        uint32_t need = fn->nreg ? fn->nreg : 1;
        uint32_t p2 = getenv("OMNI_JIT_NOINLINE") ? fn->codeLen : 0;
        while (p2 < fn->codeLen) {
            if (fn->code[p2] == OP_Call) {
                uint32_t win = 0;
                if (jit_inline_target(fn, p2, 0, NULL, &win)) {
                    uint32_t w = (uint32_t)fn->code[p2 + 1] + 1 + win;
                    if (w > need) need = w;
                }
            }
            p2 += omni_bc_len_at(fn->code, p2);
        }
        /* 算术点的元方法内联要一格**暂存窗口**（实参 a/b 得先落到帧里）。
           放在所有内联窗口之上，一整个函数共用一格 —— 算术点之间不会同时活着，
           而且只在 depth==0 做（内联体里的算术都是数+数的快路）。 */
        jit_arith_scratch = 0;
        if (!getenv("OMNI_JIT_NOINLINE")) {
            uint32_t maxWin = 0, p3 = 0;
            while (p3 < fn->codeLen) {
                uint8_t o3 = fn->code[p3];
                if (o3 == OP_Call) {
                    /* 被内联进来的那个 proto 里的算术点也要算进窗口大小 */
                    uint32_t wdummy = 0; OVal fvd = 0;
                    OmniFn *cd = jit_inline_target(fn, p3, 0, &fvd, &wdummy);
                    if (cd) {
                        uint32_t q4 = 0;
                        while (q4 < cd->codeLen) {
                            uint8_t o4 = cd->code[q4];
                            if (o4 == OP_Add || o4 == OP_Sub || o4 == OP_Mul || o4 == OP_Div) {
                                OShape *sh2; OVal mt2, hv2; uint32_t w2 = 0;
                                if (jit_arith_inline_target(cd, q4, 1, &sh2, &mt2, &hv2, &w2)
                                    && w2 > maxWin) maxWin = w2;
                            }
                            q4 += omni_bc_len_at(cd->code, q4);
                        }
                    }
                }
                if (o3 == OP_Add || o3 == OP_Sub || o3 == OP_Mul || o3 == OP_Div) {
                    OShape *sh; OVal mt, hv; uint32_t w = 0;
                    int okA = jit_arith_inline_target(fn, p3, 0, &sh, &mt, &hv, &w) != NULL;
                    if (okA && w > maxWin) maxWin = w;
                    if (getenv("OMNI_JIT_DEBUG2")) {
                        int32_t sl = fn->icBase + (int32_t)BC_U16(fn->code, p3 + 2);
                        OIC *aic = (sl >= 0 && sl < vm_ics_n) ? &omni_ics[sl] : NULL;
                        fprintf(stderr, "jit: 算术点 proto %p pc %u 槽 %d：内联=%d（off=%d shape=%p）\n",
                                (void *)fn, p3, sl, okA, aic ? (int)aic->off : -99,
                                aic ? (void *)aic->shape : NULL);
                    }
                }
                p3 += omni_bc_len_at(fn->code, p3);
            }
            if (maxWin) {
                jit_arith_scratch = need;
                jit_arith_win = maxWin;
                need += maxWin * JIT_INLINE_MAX_DEPTH;   /* 每一层一份 */
            }
        }
        if (need > fn->nreg) {
            if (getenv("OMNI_JIT_DEBUG"))
                fprintf(stderr, "jit: 为内联窗口把 nreg %u → %u\n", fn->nreg, need);
            /* 进帧时只填到老的 nreg：上面那段是内联窗口，内联体进去前自己填 nil。
               不记这一格的话，每次调用都要白填十几格（采样里 memset_pattern16 4%）。 */
            fn->nreg = need;
        }
        jit_root_nreg = fn->nreg ? fn->nreg : 1;
    }

    /* 安全守卫：预扫字节码，发现 Closure 指令带 kind==0（从本帧捕获局部量）就放弃。
       JIT 的 LdaR/StaR 不走 cells[] 间接，会破坏 upvalue 共享。
       这条守卫保证了热数值循环（sieve/mandel/matmul/nbody）走 JIT，
       含闭包的函数（queens/btree/qsort/hof/closure）安全地 fallback 到解释器。 */
    uint32_t nregs = fn->nreg ? fn->nreg : 1;
    uint8_t *captured = (uint8_t *)calloc(nregs, 1);
    {
        uint32_t pc2 = 0;
        while (pc2 < fn->codeLen) {
            uint8_t op = fn->code[pc2];
            if (op == OP_Closure) {
                /* Closure ki(u16) nup(u8) [nup × (kind,idx)] */
                uint32_t at = pc2 + 1 + 2; /* skip opcode + ki */
                uint8_t nup = fn->code[at]; at++;
                for (uint8_t u = 0; u < nup; u++) {
                    uint8_t kind = fn->code[at], idx = fn->code[at + 1];
                    if (kind == 0 && idx < nregs) {
                        /* `OMNI_JIT_NOCELLS=1` 退回老行为（整函数不编），留着做 A/B */
                        static int noCells = -1;
                        if (noCells < 0) noCells = getenv("OMNI_JIT_NOCELLS") ? 1 : 0;
                        if (noCells) { free(captured); return NULL; }
                        captured[idx] = 1;   /* 这一格要走 cells */
                    }
                    at += 2;
                }
            }
            pc2 += omni_bc_len_at(fn->code, pc2);
        }
    }
    const uint8_t *savedCap = jit_captured; uint32_t savedCapN = jit_captured_n;
    jit_captured = captured; jit_captured_n = nregs;
    #define JIT_CAP_RESTORE() do { jit_captured = savedCap; jit_captured_n = savedCapN; free(captured); } while (0)

    /* **Tier 2 发码**（`OMNI_SSA_EMIT=1` 打开；只接 startPc==0 那一档）。
       挂在这儿是因为 `jit_captured` 必须先设好 —— emit_read_r/emit_write_r 要看它。
       接不下就回 NULL，照旧走下面的 Tier 1 基线。 */
    {
        static int t2 = -1;
        if (t2 < 0) t2 = getenv("OMNI_SSA_EMIT") ? 1 : 0;
        if (t2 && startPc == 0) {
            JitFn t2fn = ssa_emit(fn);
            if (t2fn != NULL) {
                if (getenv("OMNI_JIT_DEBUG"))
                    fprintf(stderr, "jit: **Tier 2 发码**接下了 proto %p\n", (void *)fn);
                JIT_CAP_RESTORE();
                return t2fn;
            }
            if (getenv("OMNI_JIT_DEBUG"))
                fprintf(stderr, "jit: Tier 2 接不下 proto %p，退回 Tier 1\n", (void *)fn);
        }
    }

    int gnNoFbBefore = jit_gn_stat[2];
    JitBuf jb = jit_alloc();
    JitBuf *b = &jb;
    jit_make_writable();

    uint8_t *code = fn->code;
    uint32_t codeLen = fn->codeLen;

    /* Label table: bc_pc → native instruction pointer */
    uint32_t **labels = (uint32_t **)calloc(codeLen + 1, sizeof(uint32_t *));

    /* Fixup table for jumps */
    Fixup *fixups = (Fixup *)calloc(codeLen, sizeof(Fixup));
    int nfixup = 0;

    /* Prologue: save callee-saved registers, set up our register convention.
     * Arguments come in x0=R, x1=K, x2=cells, x3=icBase */
    /* STP x29, x30, [sp, #-16]! */
    emit_stp_pre(b, 29, 30, 31, -2);
    /* STP x19, x20, [sp, #-16]! */
    emit_stp_pre(b, 19, 20, 31, -2);
    /* STP x21, x22, [sp, #-16]! */
    emit_stp_pre(b, 21, 22, 31, -2);
    /* STP x23, x24, [sp, #-16]! (x24 unused but keep sp aligned) */
    emit_stp_pre(b, 23, 24, 31, -2);
    /* STP x25, x26, [sp, #-16]!（x25 = upvalue 数组；x26 = omni_objs） */
    emit_stp_pre(b, 25, 26, 31, -2);
    /* STP x27, x28, [sp, #-16]!（x27 = omni_shape_gen；x28 只为对齐） */
    emit_stp_pre(b, 27, 28, 31, -2);

    emit_mov(b, REG_R, 0);      /* x19 = R */
    emit_mov(b, REG_K, 1);      /* x20 = K */
    emit_mov(b, 24, 2);         /* x24 = cellsp（指向调用方那格 cells 变量） */
    emit_ldr(b, REG_CELLS, 24, 0);  /* x22 = *cellsp */
    emit_mov(b, REG_ICBASE, 3); /* x23 = icBase */
    emit_mov(b, REG_UP, 4);     /* x25 = up（本闭包的 upvalue 数组） */
    emit_mov64(b, 9, (uint64_t)(uintptr_t)&omni_objs);
    emit_ldr(b, REG_OBJS, 9, 0);  /* x26 = omni_objs */
    emit_mov64(b, 9, (uint64_t)(uintptr_t)&omni_shape_gen);
    emit_ldr32(b, REG_GEN, 9, 0); /* x27 = omni_shape_gen */
    emit_mov(b, REG_ACC, 5);    /* acc = 第六个实参（正常调用传 nil；OSR 进来时是解释器那格 acc） */

    /* OSR：入口先跳到 startPc 那条字节码的机器码起点。整段码照旧从 pc=0 发
       （回边可能跳到 startPc 之前），只是**进门那一跳**落在中间。
       Tier 1 里 R[] 就是内存之实、没有跨字节码的寄存器分配，所以这一跳是安全的。 */
    if (startPc != 0) {
        fixups[nfixup].patch = b->p;
        fixups[nfixup].target_bc = startPc;
        fixups[nfixup].kind = 0;
        nfixup++;
        emit_b(b, 0);
    }

    /* 哪些 pc 是跳转落点（store→load 转发不许跨过它们） */
    uint8_t *isTarget = (uint8_t *)calloc(codeLen + 1, 1);
    for (uint32_t q = 0; q < codeLen; ) {
        uint8_t op = code[q];
        uint32_t len = omni_bc_len_at(code, q);
        if (op == OP_Jump || op == OP_JumpIfTrue || op == OP_JumpIfFalse
            || op == OP_JumpIfNil || op == OP_JumpLoop || op == OP_ForPrep || op == OP_ForLoop) {
            /* 这几条的跳转偏移都在操作数的最后 4 字节 */
            int32_t off = BC_I32(code, q + len - 4);
            uint32_t tgt = (uint32_t)((int64_t)(q + len) + off);
            if (tgt <= codeLen) isTarget[tgt] = 1;
        }
        q += len;
    }

    /* Walk bytecodes */
    uint32_t pc = 0;
    uint32_t *codeStart = b->p;  /* 后趟窥孔从这儿开始（序言不碰） */
    uint32_t *lastInsn = NULL;   /* 上一条字节码发出来的最后一条机器指令 */
    int nfused = 0;
    while (pc < codeLen) {
        labels[pc] = b->p;
        uint32_t *firstInsn = b->p;
        /* 缓冲快满就放弃（内联会把码放大好几倍；emit() 本身不查边界，
           写过 4MB 那块 mmap 就是内存破坏）。留 64KB 余量：一条字节码最多也就几 KB。 */
        if (b->p + 16384 > b->end) {
            if (getenv("OMNI_JIT_DEBUG"))
                fprintf(stderr, "jit: 放弃（码超过 4MB 缓冲）\n");
            free(labels); free(fixups); free(isTarget);
            jit_bail(&jb); JIT_CAP_RESTORE(); return NULL;
        }
        uint32_t next = jit_emit_seq(b, fn, pc, isTarget, fixups, &nfixup);
        if (next == 0) {
            free(labels); free(fixups); free(isTarget);
            jit_bail(&jb); JIT_CAP_RESTORE(); return NULL;
        }
        if (lastInsn != NULL && !isTarget[pc] && firstInsn == lastInsn + 1 && b->p > firstInsn)
            nfused += jit_fuse_store_load(lastInsn, firstInsn);
        lastInsn = (b->p > firstInsn) ? b->p - 1 : lastInsn;
        pc = next;
    }
    free(isTarget);
    if (getenv("OMNI_JIT_DEBUG") && nfused)
        fprintf(stderr, "jit: store→load 转发 %d 处\n", nfused);
    if (getenv("OMNI_JIT_DEBUG"))
        fprintf(stderr, "jit: GetNamed 内联缓存 发了 %d / 槽越界 %d / 没反馈 %d / 负缓存 %d / 偏移大 %d\n",
                jit_gn_stat[0], jit_gn_stat[1], jit_gn_stat[2], jit_gn_stat[3], jit_gn_stat[4]);
    (void)gnNoFbBefore;
    labels[codeLen] = b->p;

    /* Fixup jumps */
    for (int i = 0; i < nfixup; i++) {
        uint32_t *patch = fixups[i].patch;
        uint32_t *target = labels[fixups[i].target_bc];
        if (target == NULL) {
            /* target not yet compiled — shouldn't happen for valid bytecode */
            fprintf(stderr, "jit: fixup target %u not found\n", fixups[i].target_bc);
            continue;
        }
        int32_t off = (int32_t)(target - patch);
        if (fixups[i].kind == 0) {
            /* B offset */
            *patch = 0x14000000 | (uint32_t)(off & 0x03FFFFFF);
        } else {
            /* B.cond — preserve cond bits */
            uint32_t cond = *patch & 0xF;
            *patch = 0x54000000 | ((uint32_t)(off & 0x7FFFF) << 5) | cond;
        }
    }

    /* **后趟窥孔**：必须放在**回填之后** —— 回填之前那些占位分支的偏移还是 0，
       扫不出它们真正的落点，于是"控制流一定从这条 STR 流到那条 LDR"这个前提就假了
       （循环的回边最典型）。第一版放在回填之前，22/22 掉成 20/22。
       NOP/MOV 替换不增删指令、不动任何分支偏移，所以放在回填之后完全安全。 */
    {
        int nph = jit_peephole(codeStart, b->p);
        if (getenv("OMNI_JIT_DEBUG") && nph)
            fprintf(stderr, "jit: 后趟窥孔 %d 处\n", nph);
    }

    free(labels);
    free(fixups);
    jit_make_exec(b);
    JIT_CAP_RESTORE();

    return (JitFn)(void *)jb.buf;
}

static JitFn jit_compile(OmniFn *fn) { return jit_compile_at(fn, 0); }
