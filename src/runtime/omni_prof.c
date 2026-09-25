/* omni_prof.c — 运行期的 profiler：**收集与报告在这一份，喂法有三种**（第一百四十七片）。
 *
 * 为什么把收集器摆在运行时、而不是每种喂法各写一份：三种喂法的差别只在「谁来报数」，
 * 而「怎么聚合、怎么排、印成什么」是同一件事。摆成一处，三条腿的报告一字不差 ——
 * 于是「换个喂法再量一遍」是可比的，不然三份格式各印各的，对不上就等于没量。
 *
 * 三种喂法，**按「后端自己有没有」排优先**：
 *
 *   一、`cc` 档（默认）：**编译器自己插桩** —— `-finstrument-functions`，于是每个函数
 *       进出各调一次 `__cyg_profile_func_enter/exit`（那两个名字是 gcc 定的，clang 照抄）。
 *       为什么挑它当默认：**gcc 与 clang 都有、Linux 与 macOS 都有** —— 而 `-pg`/gprof
 *       在 Darwin 上早就不出 `gmon.out` 了（那条路只在 Linux 上成立，不是跨平台的）。
 *       而且这一格是**按翻译单元**给的：只给生成的那一份 `.c`，运行时自己不被插。
 *       **我们自己那台 C 前端也会插了**（第一百五十片第三格，`tccgen.js` 的
 *       `emitProfCall`）—— 那一路喂进来的是同一对钩子，所以这一份一个字都不用改。
 *   二、`sample` 档：定时器 + `backtrace()`。开销最低（每秒几百次，不是每次调用两次
 *       `clock_gettime`），而且**看得见调用栈**；代价是要帧指针（-O0 有，见 backtrace
 *       那一段）。精确度按采样率算，不是每一格都记。
 *   三、`stub` 档：我们自己在**发射期**插的那一对（`backend-c/emit.js` 的 `profTable`）。
 *       它按**函数序号**报数，不进这一份的表。`.c` 输入那条腿上没有"发射期"可言，
 *       所以那儿的 `stub` 与 `cc` 落到同一台机器上（都是插桩）。
 *
 * 插桩那一档的开销是量过的（emit.js 那段注释里的原话）：3.2 亿次调用 × 两次
 * `clock_gettime` = 7.9s，占了那一趟的大头。所以「要精确就插桩、要低开销就采样」
 * 这句话在这儿不是口号，是那两个数。
 *
 * 出口两处，**都不带平台字样**：
 *   - stderr：一张按自用时间排的表（前 20 行）
 *   - `OMNI_PROF_OUT=<路径>`：折叠栈（`a;b;c 计数`，Brendan Gregg 那一套）或者
 *     一行一格的 TSV。火焰图与 gprof2dot 那种点线图都吃它，所以这一层不出 SVG ——
 *     渲染那一步归 CLI（`--profile-out x.svg`）。
 *
 * 名字为什么都带 `pf_` 前缀：生成的那份 C 里有一套 `omni_prof_*` 的 **static**
 * （`stub` 档），同名会撞成 `static declaration follows non-static declaration`。
 */
/* `dladdr` / `Dl_info` 是 GNU 扩展（POSIX 里没有），glibc 要 `_GNU_SOURCE` 才露出来。
   必须在**任何头文件之前**定义 —— 后置的话 features.h 已经把口子定死了。
   Darwin 不需要（`dlfcn.h` 一律给），而那一侧我们也不走这条路。 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif

#include "omni.h"
#if defined(_WIN32) && !defined(__OMNI_LIBC__)
#include "omni_win32.h"   /* POSIX 那一小块的 Windows 替代（第 msvc 刀） */
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <signal.h>
#if !defined(_WIN32) || defined(__OMNI_LIBC__)
#include <sys/time.h>
#endif
#if !defined(_WIN32) || defined(__OMNI_LIBC__)
#include <execinfo.h>
#endif
#if !defined(__APPLE__) && (!defined(_WIN32) || defined(__OMNI_LIBC__))
#include <dlfcn.h>    /* dladdr —— 翻外部模块（libc 之类）里的地址 */
#endif

#ifdef __linux__
#include <link.h>     /* dl_iterate_phdr + ElfW —— 自己走每个模块的符号表 */
#include <elf.h>
#endif

#define PF_SLOTS  8192          /* 表长（按 2 的幂，开放寻址） */
#define PF_STK    65536         /* 影子栈：算自用时间要减掉子调用 */
#define PF_BT     40            /* 采样一帧最多记几层 */
/**
 * **插桩那一档记调用栈时最多记几层**（`cc` / `stub`）。
 *
 * 比采样那一档浅（40 -> 16）是有理由的：插桩是**每次函数返回都记一笔**，而记一笔要把
 * 那条路上的指针都哈一遍 —— 深度直接乘在热路径的开销上。16 层足够看清"这一支是从哪儿
 * 来的"，更深的那几层截掉并在报告里明说（`pf_deep`）。采样那一档一秒才几百次，
 * 记 40 层不心疼。
 */
#define PF_CC_BT  16

/* 按**函数地址**归属（`cc` 档）。 */
typedef struct {
  void *fn;
  unsigned long long calls;
  unsigned long long total;     /* 含子调用 */
  unsigned long long self;      /* 减掉子调用 */
} pf_fn;
static pf_fn pf_fns[PF_SLOTS];
static int pf_fns_used = 0;

/* 按**调用栈**归属。两档共用这一张表 —— 差别只在 `hits` 那一栏的**单位**：
 *   `sample` 档：采到的帧数（一帧 = 一次定时器打中）
 *   `cc` / `stub` 档：**纳秒**的自用时间（影子栈上算出来的，精确到每次返回）
 * 一趟只会是其中一档（`pf_instr` 记着是哪一档），写折叠栈时按它换算成微秒。
 * 与 `omni_mem.c` 那格分配采样同一个形状 —— 那一份已经证明这张表在热路径上够用
 * （开放寻址、不分配）。 */
typedef struct {
  void *fr[PF_BT];
  int n;
  unsigned long long hits;
} pf_stack;
static pf_stack pf_stacks[PF_SLOTS];
static int pf_stacks_used = 0;
static unsigned long long pf_samples = 0;
static unsigned long long pf_lost = 0;      /* 表满或者一层都没采到 */
static int pf_instr = 0;                    /* 1 = 这张表里的权重是插桩量出来的纳秒 */
static int pf_deep = 0;                     /* 有路径深过 PF_CC_BT，被截过（报告里明说） */

static int pf_on = 0;                       /* 装过没有（atexit 只挂一次） */
static int pf_sampling = 0;

/* 影子栈。`cc` 档的 enter/exit 成对来，用它把子调用的时间从父亲身上减掉。 */
static void *pf_stk_fn[PF_STK];
static unsigned long long pf_stk_t0[PF_STK];
static unsigned long long pf_stk_child[PF_STK];
static int pf_sp = 0;
static int pf_ovf = 0;

static unsigned long long pf_now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (unsigned long long)ts.tv_sec * 1000000000ull + (unsigned long long)ts.tv_nsec;
}

static pf_fn *pf_fn_slot(void *fn) {
  unsigned long long h = (unsigned long long)(size_t)fn;
  h ^= h >> 33;
  h *= 0xff51afd7ed558ccdULL;
  h ^= h >> 29;
  int slot = (int)(h & (PF_SLOTS - 1));
  for (int probe = 0; probe < PF_SLOTS; probe++) {
    pf_fn *e = &pf_fns[slot];
    if (e->fn == fn) return e;
    if (e->fn == 0) { e->fn = fn; pf_fns_used++; return e; }
    slot = (slot + 1) & (PF_SLOTS - 1);
  }
  return 0;                                 /* 表满：这一格不记（宁可少记也不乱记） */
}

/* ---- `sample` 档：定时器打一下，采一帧栈。
 *
 * 处理函数里**只碰自己那张表**：不分配、不加锁、不调 stdio —— 那三样在信号里都不安全。
 * `backtrace` 在我们自己那份 libc 上是走帧链（一格 syscall 都不问），在 glibc 上头一次
 * 会分配，所以装的时候先空跑一次把它热起来（`pf_warm`）。
 *
 * **「此刻在谁身上」只有 ucontext 里有**（量出来的一格）：帧链给的是每一层的**返回地址**，
 * 于是被打断的那个函数在链上根本不出现 —— 它的位置只在被中断的 PC 里。第一版只走帧链，
 * 一份九成时间在 `hot` 里的程序，榜首印的是 `main`（`hot` 一帧都没有），因为链上拿到的是
 * `hot` 的返回地址、也就是 main 里的调用点。所以这一版用 `SA_SIGINFO` 收三个参数，
 * 把 PC 摆在栈顶、帧链接在后面。
 *
 * 两个平台的偏移都是**量出来的**（`offsetof`，见下面每一行的注释），不是抄来的：
 *   arm64 macOS ：`uc_mcontext` 是**一个指针**，在 ucontext + 48；pc 在 mcontext + 272
 *   x86_64 Linux：mcontext **嵌在**里头，`gregs` 从 + 40 起，`REG_RIP` = 16 -> + 168
 * 别的平台回 0：那时退回帧链那一版（榜首记到调用点上，明说）。 */
static void *pf_pc_of(void *uc) {
  if (uc == 0) return 0;
#if defined(__APPLE__)
  void *mc = *(void **)((char *)uc + 48);
  if (mc == 0) return 0;
  return *(void **)((char *)mc + 272);
#elif defined(__linux__) && defined(__x86_64__)
  return *(void **)((char *)uc + 168);
#else
  return 0;
#endif
}

/**
 * 把一条栈（`st[0]` 是栈顶）连着一个权重记进那张表。**两档共用这一格** ——
 * 采样那一档喂 1（一帧），插桩那一档喂这次返回算出来的自用纳秒。
 *
 * 信号安全：只碰自己那张表，不分配、不加锁、不调 stdio。
 */
static void pf_stack_add(void **st, int m, unsigned long long w) {
  if (m <= 0) { pf_lost++; return; }
  unsigned long long h = 1469598103934665603ULL;
  for (int i = 0; i < m; i++) {
    h ^= (unsigned long long)(size_t)st[i];
    h *= 1099511628211ULL;
  }
  int slot = (int)(h & (PF_SLOTS - 1));
  for (int probe = 0; probe < PF_SLOTS; probe++) {
    pf_stack *e = &pf_stacks[slot];
    if (e->n == 0) {
      memcpy(e->fr, st, sizeof(void *) * (size_t)m);
      e->n = m;
      e->hits = w;
      pf_stacks_used++;
      return;
    }
    if (e->n == m && memcmp(e->fr, st, sizeof(void *) * (size_t)m) == 0) {
      e->hits += w;
      return;
    }
    slot = (slot + 1) & (PF_SLOTS - 1);
  }
  pf_lost++;
}

static void pf_tick(int sig, void *info, void *uc) {
  (void)sig;
  (void)info;
  void *fr[PF_BT + 4];
  int got = backtrace(fr, PF_BT + 4);
  void *st[PF_BT];
  int m = 0;
  void *pc = pf_pc_of(uc);
  /* **跳掉信号那三格**（第一百六十一片，量出来的）。信号处理函数里 `backtrace()` 回来的
   * 头几格是：
   *   fr[0] 本函数（`pf_tick`）里的返回地址
   *   fr[1] **内核跳板**（glibc 是 `__restore_rt`，Darwin 是 `_sigtramp`）
   *   fr[2] 被打断的那个函数里的返回地址
   * 而 `pf_pc_of(uc)` 给的就是被打断的那一格 PC —— 比 fr[2] 更准（叶子函数可能连帧都没建）。
   * 从前只 `skip = 1`，于是每一条栈都长成 `被打断的 > 跳板 > 被打断的 > 调用者…`：
   * 跳板混在中间，被打断的那一格还重复了一次。量到的原话（Linux 上 `--profile sample`）：
   *   `u_sumTo > /usr/lib/libc.so.6 > u_sumTo`、`omni_mod > /usr/lib/libc.so.6 > omni_mod`
   * —— 那格 libc 不是真的调用关系，是 `__restore_rt` 被 `backtrace_symbols` 报成了库名。
   * macOS 上同一个形状叫 `_sigtramp`（折叠栈里一直看得见）。
   * 拿得到 pc 就跳三格（跳板 + 那一格重复），拿不到就跳两格（只跳跳板）。 */
  if (pc) st[m++] = pc;
  int skip = pc ? 3 : 2;
  if (skip > got) skip = got > 1 ? 1 : got;
  for (int i = skip; i < got && m < PF_BT; i++) st[m++] = fr[i];
  pf_samples++;
  pf_stack_add(st, m, 1);
}

static void pf_warm(void) {
  void *fr[4];
  (void)backtrace(fr, 4);
}

#if defined(_WIN32)
/**
 * Windows 上的采样：**另起一条线程**，不走信号。
 *
 * 为什么不能照抄 POSIX 那一支：这条腿上 `sigaction`/`setitimer` 一律回 -1/ENOSYS
 * （win32 sysroot 的 `libc/misc.c` 明写着），Windows 压根没有「定时器打断当前线程、
 * 在信号处理函数里看现场」这件事。对应的原生做法是 SuspendThread + GetThreadContext：
 * 采样线程定时把**主线程**冻住，拿它的 PC 与帧指针，自己走一遍帧链，再放开。
 *
 * 三条要点：
 *  - **帧链自己走**，不叫 `backtrace()`：那一份走的是**调用者自己**的栈
 *    （`libc/pure.c`），在采样线程里走出来的是采样线程的栈 —— 一帧都不是我们要的。
 *    好在两个 arch 的帧形状一样（arm64 `stp x29,x30,[sp,#-16]` / x64 `push rbp`）：
 *    `[fp]` 是上一层的 fp、`[fp+8]` 是返回地址，所以走法只有一份。
 *  - **冻住的时候只读内存、不记账**：`pf_stack_add` 虽然不分配（开放寻址的定表），
 *    可主线程可能正停在 `malloc` 里 —— 先把栈抄进本地数组，`ResumeThread` 之后再记。
 *  - 帧链要**当成脏数据来读**：fp 必须落在主线程的栈上（`Sp` 那一格量出来的下界）、
 *    8 字节对齐、且一层比一层高。少一条判据，采样线程就会自己踩出一个 0xC0000005 ——
 *    而它是没人接的（这条腿没有 SEH）。
 *
 * CONTEXT 里那几格的偏移是**按 SDK 的结构算出来的**（两个 arch 各一套）：
 *   arm64：ContextFlags 0，X0 起于 8，于是 Fp=X29 在 240、Lr=X30 在 248、Sp 256、Pc 264
 *   x64  ：P1..P6Home 48 字节，ContextFlags 在 0x30，Rsp 0x98、Rbp 0xA0、Rip 0xF8
 * 结构本身要 16 字节对齐（x64 上那片 XMM 存档区的硬要求），所以缓冲区自己对齐一次。
 */
#if defined(__aarch64__)
#define PF_W_CTXSIZE  912
#define PF_W_FLAGS    0
#define PF_W_FULL     0x00400003u   /* CONTEXT_ARM64 | CONTROL | INTEGER */
#define PF_W_FP       240
#define PF_W_LR       248
#define PF_W_SP       256
#define PF_W_PC       264
#else
#define PF_W_CTXSIZE  1232
#define PF_W_FLAGS    0x30
#define PF_W_FULL     0x00100003u   /* CONTEXT_AMD64 | CONTROL | INTEGER */
#define PF_W_FP       0xA0
#define PF_W_LR       0            /* x64 上返回地址只在栈上，没有 lr */
#define PF_W_SP       0x98
#define PF_W_PC       0xF8
#endif

/* kernel32 的那几个。**自带 libc 那条腿没有 `windows.h`**（名字都在
 * `sysroot/win32/lib/kernel32.def` 里），所以自己声明一份；MSVC 的 CRT 那条腿
 * `omni_win32.h` 已经把 `windows.h` 拉进来了，再声明一遍就是
 *   error: conflicting types for 'CreateThread'
 * —— 那边用它自己那份（签名等价，只是写法上多一层 typedef 与 `WINAPI`）。
 * 差出来的两格靠 `PF_W_FN` / `PF_W_CTX` 抹平：x64/arm64 上 `WINAPI` 是空的、
 * `DWORD` 就是 `unsigned long`，所以那两个转换是同 ABI 的改写，不是"糊过去"。 */
#ifdef __OMNI_LIBC__
void *CreateThread(void *sa, unsigned long long stack,
                   unsigned long (*fn)(void *), void *arg,
                   unsigned long flags, unsigned long *tid);
void *GetCurrentThread(void);
void *GetCurrentProcess(void);
int DuplicateHandle(void *sp, void *sh, void *tp, void **th,
                    unsigned int access, int inherit, unsigned int opts);
unsigned long SuspendThread(void *h);
unsigned long ResumeThread(void *h);
int GetThreadContext(void *h, void *ctx);
void Sleep(unsigned long ms);
int CloseHandle(void *h);
#define PF_W_FN(f)  (f)
#define PF_W_CTX(p) ((void *)(p))
#else
#define PF_W_FN(f)  ((LPTHREAD_START_ROUTINE)(void *)(f))
#define PF_W_CTX(p) ((CONTEXT *)(void *)(p))
#endif

static void *pf_w_main;              /* 主线程的句柄（复制过的，伪句柄跨线程没用） */
static volatile int pf_w_stop;
static int pf_w_ms;

static unsigned long pf_w_sampler(void *arg) {
  (void)arg;
  unsigned char raw[PF_W_CTXSIZE + 16];
  while (!pf_w_stop) {
    Sleep((unsigned long)pf_w_ms);
    if (pf_w_stop) break;
    unsigned char *ctx = raw + ((16 - ((unsigned long long)raw & 15)) & 15);
    memset(ctx, 0, PF_W_CTXSIZE);
    *(unsigned int *)(ctx + PF_W_FLAGS) = PF_W_FULL;
    if (SuspendThread(pf_w_main) == (unsigned long)-1) continue;
    void *st[PF_BT];
    int m = 0;
    if (GetThreadContext(pf_w_main, PF_W_CTX(ctx))) {
      unsigned long long pc = *(unsigned long long *)(ctx + PF_W_PC);
      unsigned long long fp = *(unsigned long long *)(ctx + PF_W_FP);
      unsigned long long sp = *(unsigned long long *)(ctx + PF_W_SP);
      if (pc) st[m++] = (void *)(size_t)pc;
#if PF_W_LR
      /* arm64：叶子函数还没建帧时返回地址只在 lr 里 —— 那一格补上，否则栈只有一层。 */
      unsigned long long lr = *(unsigned long long *)(ctx + PF_W_LR);
      if (lr && m < PF_BT) st[m++] = (void *)(size_t)lr;
#endif
      unsigned long long lo = sp;
      unsigned long long hi = sp + (64ULL << 20);   /* 主线程的栈够大也不过这个量级 */
      while (m < PF_BT && fp >= lo && fp < hi && (fp & 7) == 0) {
        unsigned long long ret = *(unsigned long long *)(size_t)(fp + 8);
        unsigned long long up = *(unsigned long long *)(size_t)fp;
        if (ret == 0) break;
        st[m++] = (void *)(size_t)ret;
        if (up <= fp) break;                        /* 栈往下长：上一层一定更高 */
        lo = fp + 16;
        fp = up;
      }
    }
    ResumeThread(pf_w_main);
    /* 放开之后再记账 —— 见上面那三条要点的第二条。 */
    if (m > 0) { pf_samples++; pf_stack_add(st, m, 1); }
    else pf_lost++;
  }
  return 0;
}

/** 起采样线程。装不起来回 0（那时这一趟就没有采样，报告里照实说）。 */
static int pf_w_start(int hz) {
  pf_w_ms = 1000 / hz;
  if (pf_w_ms < 1) pf_w_ms = 1;      /* Sleep 的分辨率就到这儿：>1000Hz 要不来 */
  if (!DuplicateHandle(GetCurrentProcess(), GetCurrentThread(),
                       GetCurrentProcess(), &pf_w_main, 0, 0,
                       0x00000002 /* DUPLICATE_SAME_ACCESS */)) {
    return 0;
  }
  void *h = CreateThread(0, 0, PF_W_FN(pf_w_sampler), 0, 0, 0);
  if (h == 0) { CloseHandle(pf_w_main); pf_w_main = 0; return 0; }
  CloseHandle(h);                    /* 线程自己跑，句柄留着也没用 */
  return 1;
}
#endif

void omni_prof_report(void);
static void pf_trap_signals(void);

/**
 * 开始采样。`hz` 是每秒几次（0 或负数按 200 算）。
 *
 * 钟挑 **ITIMER_PROF**（走的是这个进程用掉的 CPU 时间，用户 + 系统）—— 那正是
 * 「CPU 花在哪儿」要的口径；`ITIMER_REAL` 会把等 I/O 的时间也算进去。装不上就退回
 * `ITIMER_REAL`：两条腿上都试过，退路留着是因为**这两个钟不是每个内核都给全**。
 */
void omni_prof_sample_start(int hz) {
  if (pf_sampling) return;
  if (hz <= 0) hz = 200;
  if (hz > 100000) hz = 100000;             /* 再高就只是在量自己 */
  pf_warm();
#if defined(_WIN32)
  /* Windows 上换成采样线程（第 win-c-backend 刀）：`pf_sampling = 3` 是这一档的号，
   * 停表那一格按它分叉（`omni_prof_report`）。 */
  if (pf_w_start(hz)) pf_sampling = 3;
  if (pf_sampling && !pf_on) { pf_on = 1; atexit(omni_prof_report); }
  return;
#else
  /* `SA_SIGINFO`：要三个参数才拿得到 ucontext（PC 在里头）。字段名两条腿不一样
   * （`sa_sigaction` 是 POSIX 的名字，我们自己那份头里只有 `sa_handler`），而**两者在
   * 结构里是同一个偏移**（联合），所以这儿按 `sa_handler` 那一格装、把函数指针转过去 ——
   * 与 musl/glibc 里 `sa_sigaction` 的宏定义是同一件事。 */
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = (void (*)(int))(void *)pf_tick;
  sa.sa_flags = SA_RESTART | SA_SIGINFO;    /* 别让采样把 read/write 打断成 EINTR */
  long usec = 1000000L / hz;
  if (usec < 1) usec = 1;
  struct itimerval it;
  memset(&it, 0, sizeof it);
  it.it_interval.tv_usec = usec;
  it.it_value.tv_usec = usec;
  if (sigaction(SIGPROF, &sa, 0) == 0 && setitimer(ITIMER_PROF, &it, 0) == 0) {
    pf_sampling = 1;
  } else if (sigaction(SIGALRM, &sa, 0) == 0 && setitimer(ITIMER_REAL, &it, 0) == 0) {
    pf_sampling = 2;
  }
  if (pf_sampling && !pf_on) { pf_on = 1; atexit(omni_prof_report); }
  pf_trap_signals();
#endif
}

/**
 * **被强制结束也要把账交出来**（第一百五十五片）。
 *
 * 量到的原话（用户那一趟）：`OMNI_PROF=sample OMNI_PROF_OUT=/tmp/omni.folded dist/omni
 * run … -v` 撞上时限，印的只有「超时 —— 已中止」，折叠栈那份文件**一个字节都没有** ——
 * 而那一趟正是最需要它的一趟：卡在哪儿只有采样看得见。根因是两条：时限那一枪走的是
 * `_exit(124)`（跳过 atexit），外面送来的 SIGTERM 又没人接（默认动作直接死）。
 *
 * 所以这儿把三样都接上：SIGTERM（别人杀）、SIGINT（Ctrl-C）、SIGQUIT。处理函数里只做
 * 两件事：报告（`omni_prof_report` 自己保证只印一遍）、`_exit(128 + sig)`。
 * **SIGKILL 接不了**（内核不给），所以我们自己那把枪改成先 SIGTERM（`omni_js_host.c`
 * 的 `host_timeout_alarm`）—— 接得住的那一枪才有意义。
 *
 * 为什么敢在信号处理函数里 fopen/fprintf：这一趟是**要死的那一趟**，再没有别人会用那把
 * FILE*；tcc 的 `-b` 与 gprof 的 `_mcleanup` 在同一个位置做同一件事。代价写在明处：
 * 极小概率撞上正在 malloc 的那一刻（那时报告会挂住），换来的是「挂起的现场看得见」。
 */
static void pf_on_term(int sig) {
  omni_prof_report();
  /* `_Exit` 而不是 `_exit`：前者是 C99 的（stdlib.h，这份文件本来就 include 了），
     后者要 POSIX 的 unistd.h —— 我们自己那台 C 前端按 `-std=c99` 编，少那一句就是
     "隐式声明"（clang 从 C99 起当错误报）。两者做的是同一件事：不跑 atexit 直接走。 */
  _Exit(128 + sig);
}

/** 把那三个"要死了"的信号接过来（装过就不再装）。采样与插桩两档都要。 */
static void pf_trap_signals(void) {
  static int done = 0;
  if (done) return;
  done = 1;
#if defined(_WIN32) && !defined(__OMNI_LIBC__)
  /* UCRT 只有 `signal()`（没有 `sigaction`），而且它那张表里**没有 SIGQUIT** ——
   * Windows 上没有那一枪。SIGTERM/SIGINT 两格接得上（Ctrl-C 由 CRT 自己在控制台处理
   * 函数里转成 SIGINT），所以这条腿上"要死了也把报告交出来"这件事仍然成立。 */
  signal(SIGTERM, pf_on_term);
  signal(SIGINT, pf_on_term);
#else
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = pf_on_term;
  sigaction(SIGTERM, &sa, 0);
  sigaction(SIGINT, &sa, 0);
  sigaction(SIGQUIT, &sa, 0);
#endif
}

/* ---- `cc` 档：编译器插的那一对（`-finstrument-functions`）。
 *
 * `this_fn` 是**被调用的那个函数**的地址，`call_site` 是调用点 —— 后者这一份不用
 * （要调用图的时候才用得上，那一格记在账上）。 */
void __cyg_profile_func_enter(void *this_fn, void *call_site);
void __cyg_profile_func_exit(void *this_fn, void *call_site);

void __cyg_profile_func_enter(void *this_fn, void *call_site) {
  (void)call_site;
  if (!pf_on) { pf_on = 1; atexit(omni_prof_report); pf_trap_signals(); }
  pf_fn *e = pf_fn_slot(this_fn);
  if (e) e->calls++;
  if (pf_sp < PF_STK) {
    pf_stk_fn[pf_sp] = this_fn;
    pf_stk_child[pf_sp] = 0;
    pf_stk_t0[pf_sp] = pf_now();
    pf_sp++;
  } else {
    pf_ovf = 1;                             /* 越界那几层的自用时间从此偏大，报告里明说 */
  }
}

void __cyg_profile_func_exit(void *this_fn, void *call_site) {
  (void)call_site;
  if (pf_sp <= 0) return;
  pf_sp--;
  unsigned long long dt = pf_now() - pf_stk_t0[pf_sp];
  unsigned long long self = dt - pf_stk_child[pf_sp];
  if (pf_stk_child[pf_sp] > dt) self = 0;   /* 钟不单调时不许出负数 */
  pf_fn *e = pf_fn_slot(pf_stk_fn[pf_sp]);
  if (e) { e->total += dt; e->self += self; }
  if (pf_sp > 0) pf_stk_child[pf_sp - 1] += dt;
  /**
   * **插桩这一档也记调用栈**（第一百四十九片第四格）。
   *
   * 从前这儿只往「按函数」那张表上加，报告里于是只有一张直方图 —— 而**影子栈就在手边**
   * （`pf_stk_fn[0..pf_sp]`）：谁调的谁、这一支从哪儿来，一格不缺，而且是**精确**的，
   * 不是采样估的。用户那句话是对的：backtrace 不是只有采样才做得到。
   *
   * 权重是这次返回的**自用纳秒**（`self`），落到栈顶那一格上 —— 与采样那一档
   * "帧落在栈顶"是同一种归属，所以两档的折叠栈能用同一段代码读。
   * 深度截在 `PF_CC_BT`：每次返回都要哈一遍这条路，深度直接乘在开销上。
   */
  if (self > 0) {
    void *st[PF_CC_BT];
    int m = 0;
    for (int i = pf_sp; i >= 0 && m < PF_CC_BT; i--) st[m++] = pf_stk_fn[i];
    if (pf_sp + 1 > PF_CC_BT) pf_deep = 1;
    pf_instr = 1;
    pf_stack_add(st, m, self);
  }
}

/* ---- MSVC 那一档的同一件事（`/Gh` / `/GH`）。
 *
 * `cl` 没有 `-finstrument-functions`，它的对应物是 `/Gh` / `/GH`：每个函数进出各调一次
 * **`_penter` / `_pexit`**，而这两个名字**要我们自己提供**，且**一个参数都不带** ——
 * 谁被插了只能从返回地址看出来（那是被插桩函数里 `call` 的下一条指令）。
 *
 * 那一对不能用 C 写（它们必须保住每一个易失寄存器，否则被插桩函数的入参与返回值当场被改
 * 掉），所以真正的入口在 `omni_prof_msvc_x64.asm` 里；那份汇编存好寄存器之后，把返回地址
 * 递给下面这两格。于是**这一档与 gcc/clang 那一档共用同一套账**（`__cyg_*` 那两个函数）。
 *
 * `call_site` 给 0：`_penter` 那一侧拿不到调用点（要走 unwind 才有），而这份收集器本来就
 * 没用那一格（上面 `(void)call_site` 两处）。
 *
 * `this_fn` 是**函数体内的一个地址**（不是函数首地址）。两处因此仍然对：按函数计数的那张表
 * 只要"同一个函数每次是同一个键"，翻名字那一侧按"不大于它的最近符号"找 —— 落在函数体内
 * 正是它要的。退出那一侧压根不看 `this_fn`（它弹的是影子栈）。 */
#if defined(_MSC_VER) && !defined(__clang__)
void omni_prof_penter_site(void *site);
void omni_prof_pexit_site(void *site);

void omni_prof_penter_site(void *site) { __cyg_profile_func_enter(site, 0); }
void omni_prof_pexit_site(void *site) { __cyg_profile_func_exit(site, 0); }
#endif

/* ---- 报告。
 *
 * 符号名：`backtrace_symbols` 有就用（系统 libc 上有）；**我们自己那份 libc 上它回 0**
 * （读自己的符号表是另一件事，见 sysroot 的 README）—— 那时就印地址，由 CLI 那一层
 * 拿着二进制的符号表翻。所以这一层的输出**一律带地址**：有名字时是「名字 0x地址」，
 * 没名字时只有地址。翻名字的人在外面，格式不因为在哪条腿上跑而变。 */
/* ---- 链接图（`OMNI_PROF_MAP`）：一行 `0x<地址> <名字>`，按地址升序，由 `c link --map` 落下。
 *
 * 为什么必须有它：ELF 可执行文件里我们**不写 `.symtab`**，而 glibc 的 `backtrace_symbols`
 * 走 `dladdr` 只看 `.dynsym` —— 于是 Linux 上这张表里每一格都是裸地址。地址 -> 名字这件事
 * 只有链接器答得出来，所以由它落一份文件、这儿读回来。macOS 上 `create_symtab` 本来就写，
 * `dladdr` 认得出来，可 `static` 函数照样进不去 —— 那一侧这份图同样有用。
 * 只在**报告期**读（不在信号处理函数里），所以用 stdio 与 malloc 都是安全的。 */
static struct pf_sym { size_t addr; size_t size; char *name; } *pf_map = 0;
static int pf_map_n = 0;
static int pf_map_cap = 0;
static size_t pf_map_hi = 0;
static size_t pf_map_base = 0;    /* PIE 修正：运行时地址 = 文件地址 + base */

/* 往图里加一格（名字自己留一份）。表里存的**一律是运行时地址**，
   谁往里加谁负责把模块的加载基址算进去 —— 这样查表只有一种口径，不必再猜。 */
static void pf_map_add(size_t addr, size_t sz, const char *name, size_t nlen) {
  if (addr == 0 || nlen == 0) return;
  if (pf_map_n == pf_map_cap) {
    int c2 = pf_map_cap == 0 ? 512 : pf_map_cap * 2;
    void *q = realloc(pf_map, sizeof *pf_map * (size_t)c2);
    if (q == 0) return;
    pf_map = (struct pf_sym *)q;
    pf_map_cap = c2;
  }
  char *copy = (char *)malloc(nlen + 1);
  if (copy == 0) return;
  memcpy(copy, name, nlen);
  copy[nlen] = 0;
  pf_map[pf_map_n].addr = addr;
  pf_map[pf_map_n].size = sz;
  pf_map[pf_map_n].name = copy;
  pf_map_n++;
}

static int pf_sym_cmp(const void *a, const void *b) {
  const struct pf_sym *x = (const struct pf_sym *)a;
  const struct pf_sym *y = (const struct pf_sym *)b;
  if (x->addr != y->addr) return x->addr < y->addr ? -1 : 1;
  return 0;
}

#ifdef __linux__
/* ---- 每个已加载模块的符号表，自己走一遍（第一百六十五片）。
 *
 * 为什么不能只靠 `dladdr`：它只看 `.dynsym`（**导出**的那些）。glibc 里
 * `start_thread` / `__libc_start_call_main` 这类是**局部符号**，`.dynsym` 里没有，
 * 于是那几帧只能印成 `libc.so.6+0x980a2`。而名字其实在两个地方可能有：
 *   1. 模块自己的 `.symtab`（没被 strip 的话；clang/gcc 编出来的默认都有）
 *   2. 被 strip 掉时，分离的 debug 文件里 —— 按 `.gnu_debuglink` 与 build-id 两条老规矩找：
 *        /usr/lib/debug/<模块所在目录>/<debuglink 名>
 *        /usr/lib/debug/.build-id/<前2位>/<其余>.debug
 *      （这两条路径就是 gdb / perf 找 debuginfo 的地方）
 * 所以这一段把每个模块的表都读进来，**连局部符号一起**，一次性建成一张按运行时地址
 * 排序的大表。读文件、malloc 都在报告期，信号安全不是问题。
 *
 * 量到的边界（这台 docker 镜像）：Arch 的 libc 被 strip 了（`nm` 回 "no symbols"），
 * 而 `glibc-debug` 没装、也没有 debuginfod —— 那 `start_thread` 的名字在这台机器上
 * **确实不存在**，退回 `libc.so.6+偏移`（perf/gdb 同样条件下印的也是这个）。
 * 装上 debug 包之后这一段会自动把它认出来，不用改代码。 */

/* 一个 ELF 文件里的 `.symtab`（没有就 `.dynsym`）搬进图里。`base` 是模块的加载基址。 */
static int pf_scan_elf(const char *path, size_t base, int want_debuglink);

/* `.gnu_debuglink` / build-id 指到的那份 debug 文件，按 gdb 的老规矩找。 */
static void pf_scan_debug_of(const char *path, size_t base,
                             const char *link, const unsigned char *bid, size_t bidn) {
  char buf[1024];
  if (bid != 0 && bidn >= 2) {
    /* /usr/lib/debug/.build-id/ab/cdef….debug */
    size_t k = 0;
    static const char hx[] = "0123456789abcdef";
    const char *pre = "/usr/lib/debug/.build-id/";
    size_t pn = strlen(pre);
    if (pn + bidn * 2 + 8 < sizeof buf) {
      memcpy(buf, pre, pn);
      k = pn;
      buf[k++] = hx[bid[0] >> 4];
      buf[k++] = hx[bid[0] & 15];
      buf[k++] = '/';
      for (size_t i = 1; i < bidn; i++) {
        buf[k++] = hx[bid[i] >> 4];
        buf[k++] = hx[bid[i] & 15];
      }
      memcpy(buf + k, ".debug", 7);
      if (pf_scan_elf(buf, base, 0)) return;
    }
  }
  if (link != 0 && link[0] != 0) {
    /* /usr/lib/debug/<模块目录>/<link> 与 <模块目录>/.debug/<link> */
    const char *slash = strrchr(path, '/');
    size_t dn = slash == 0 ? 0 : (size_t)(slash - path);
    if (dn + strlen(link) + 24 < sizeof buf) {
      snprintf(buf, sizeof buf, "/usr/lib/debug%.*s/%s", (int)dn, path, link);
      if (pf_scan_elf(buf, base, 0)) return;
      snprintf(buf, sizeof buf, "%.*s/.debug/%s", (int)dn, path, link);
      if (pf_scan_elf(buf, base, 0)) return;
    }
  }
}

static int pf_scan_elf(const char *path, size_t base, int want_debuglink) {
  if (path == 0 || path[0] != '/') return 0;
  FILE *f = fopen(path, "rb");
  if (f == 0) return 0;
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return 0; }
  long sz = ftell(f);
  if (sz <= (long)sizeof(ElfW(Ehdr)) || sz > (long)(256 << 20)) { fclose(f); return 0; }
  rewind(f);
  unsigned char *m = (unsigned char *)malloc((size_t)sz);
  if (m == 0) { fclose(f); return 0; }
  size_t got = fread(m, 1, (size_t)sz, f);
  fclose(f);
  if (got != (size_t)sz || m[0] != 0x7f || m[1] != 'E' || m[2] != 'L' || m[3] != 'F') {
    free(m);
    return 0;
  }
  ElfW(Ehdr) *eh = (ElfW(Ehdr) *)m;
  if (eh->e_shoff == 0 || eh->e_shnum == 0
    || eh->e_shoff + (size_t)eh->e_shnum * eh->e_shentsize > (size_t)sz) {
    free(m);
    return 0;
  }
  ElfW(Shdr) *sh = (ElfW(Shdr) *)(m + eh->e_shoff);
  const char *shstr = eh->e_shstrndx < eh->e_shnum
    ? (const char *)(m + sh[eh->e_shstrndx].sh_offset) : 0;
  int symi = -1;
  int dyni = -1;
  const char *dlink = 0;
  const unsigned char *bid = 0;
  size_t bidn = 0;
  for (int i = 0; i < eh->e_shnum; i++) {
    if (sh[i].sh_type == SHT_SYMTAB) symi = i;
    else if (sh[i].sh_type == SHT_DYNSYM && dyni < 0) dyni = i;
    else if (shstr != 0 && sh[i].sh_type == SHT_PROGBITS
      && strcmp(shstr + sh[i].sh_name, ".gnu_debuglink") == 0) {
      dlink = (const char *)(m + sh[i].sh_offset);
    } else if (sh[i].sh_type == SHT_NOTE && shstr != 0
      && strcmp(shstr + sh[i].sh_name, ".note.gnu.build-id") == 0) {
      /* Nhdr: namesz, descsz, type; 名字 "GNU\0" 之后就是 20 字节的 id */
      ElfW(Nhdr) *nh = (ElfW(Nhdr) *)(m + sh[i].sh_offset);
      size_t na = (nh->n_namesz + 3) & ~(size_t)3;
      bid = (const unsigned char *)(nh + 1) + na;
      bidn = nh->n_descsz;
      if (bidn > 64) { bid = 0; bidn = 0; }
    }
  }
  int use = symi >= 0 ? symi : dyni;
  int added = 0;
  if (use >= 0 && sh[use].sh_link < eh->e_shnum && sh[use].sh_entsize != 0) {
    const char *str = (const char *)(m + sh[sh[use].sh_link].sh_offset);
    size_t nsym = sh[use].sh_size / sh[use].sh_entsize;
    ElfW(Sym) *sy = (ElfW(Sym) *)(m + sh[use].sh_offset);
    for (size_t i = 0; i < nsym; i++) {
      if (ELF32_ST_TYPE(sy[i].st_info) != STT_FUNC) continue;
      if (sy[i].st_value == 0 || sy[i].st_shndx == SHN_UNDEF) continue;
      const char *nm = str + sy[i].st_name;
      size_t nl = strlen(nm);
      if (nl == 0) continue;
      pf_map_add(base + (size_t)sy[i].st_value, (size_t)sy[i].st_size, nm, nl);
      added++;
    }
  }
  /* `.symtab` 不在（被 strip 了）就去找分离的 debug 文件 —— 那才是局部符号的家。 */
  if (want_debuglink && symi < 0) pf_scan_debug_of(path, base, dlink, bid, bidn);
  free(m);
  return added > 0;
}

static int pf_phdr_cb(struct dl_phdr_info *info, size_t size, void *data) {
  (void)size;
  (void)data;
  const char *p = info->dlpi_name;
  /* 主程序那一格 `dlpi_name` 是空串 —— 用 /proc/self/exe 去读它自己。 */
  if (p == 0 || p[0] == 0) pf_scan_elf("/proc/self/exe", (size_t)info->dlpi_addr, 1);
  else pf_scan_elf(p, (size_t)info->dlpi_addr, 1);
  return 0;
}
#endif

/* 拿到自己这份可执行文件的加载基地址（Linux 上是 `/proc/self/maps` 的第一行，
   macOS 上 `_dyld_get_image_vmaddr_slide(0)` 但这条路上用不到它——Darwin 的 symtab
   天然带虚拟地址）。只在报告期调一次；信号安全不是问题。 */
static size_t pf_load_base(void) {
#ifdef __linux__
  FILE *f = fopen("/proc/self/maps", "r");
  if (f == 0) return 0;
  char line[512];
  if (fgets(line, (int)sizeof line, f) != 0) {
    /* 第一行形如 "55a3c8e00000-55a3c9200000 r--p 00000000 …"
       取第一段的低地址就是 load base。 */
    size_t a = (size_t)strtoull(line, 0, 16);
    fclose(f);
    return a;
  }
  fclose(f);
#endif
#if defined(_WIN32)
  /* Windows（第 win-c-backend 刀）：映像开了 DYNAMIC_BASE，**每趟装在哪儿都不一样**，
     而 `pe-link --map` 里落的是链接期的 VA。滑动量要靠图里那一行 `# imagebase 0x…`
     —— **不能**从自己头上读：装载器会把内存里那个 ImageBase 字段改成真实基址
     （量出来的：`declared == actual`，于是滑动量算成 0、报告里全是裸地址）。
     所以这一格在 `pf_map_load` 里读完图之后才算（见那一段）。 */
#endif
  return 0;
}

/** 图里那一行 `# imagebase 0x…` 记下来的链接期映像基址（0 = 图里没有这一行）。 */
static unsigned long long pf_map_imagebase = 0;

/** 自己这份映像现在装在哪儿（只有 Windows 这条腿要，别的腿回 0）。 */
static size_t pf_module_base(void) {
#if defined(_WIN32)
#ifdef __OMNI_LIBC__
  void *GetModuleHandleA(const char *name);
#endif
  return (size_t)GetModuleHandleA(0);
#else
  return 0;
#endif
}

static void pf_map_load(void) {
  static int done = 0;
  if (done) return;
  done = 1;
  pf_map_base = pf_load_base();
#ifdef __linux__
  /* **先把每个已加载模块的符号表读进来**（主程序 + libc + 各个 .so）——
     连局部符号一起，所以 `start_thread` 这类只要文件里有就认得出来。
     表里存的是**运行时地址**（模块基址 + st_value），与 `backtrace()` 给的同一口径。 */
  dl_iterate_phdr(pf_phdr_cb, 0);
#endif
  /* 再叠上 `c link --map` 那一份（我们自己那台链接器不写 `.symtab`，只有它知道名字）。
     那份图里落的是**最终虚拟地址**（非 PIE），与运行时地址相同，直接进表。 */
  const char *path = getenv("OMNI_PROF_MAP");
  FILE *f = path == 0 || *path == 0 ? 0 : fopen(path, "rb");
  if (f != 0) {
    char line[512];
    while (fgets(line, (int)sizeof line, f) != 0) {
      /* `0x<地址> 0x<长度> <名字>`。长度那一格是后加的，缺了也认（当 0）—— 旧的
         两段式 map 还读得动，只是那时候界只能靠"下一格"。 */
      char *p = line;
      /* `# imagebase 0x…`（PE 那条腿写的头一行）：链接期的映像基址。`#` 开头的行
         只有这一条有意义，别的一律跳过。 */
      if (p[0] == '#') {
        char *k = p + 1;
        while (*k == ' ' || *k == '\t') k++;
        if (strncmp(k, "imagebase", 9) == 0) {
          k += 9;
          while (*k == ' ' || *k == '\t') k++;
          pf_map_imagebase = strtoull(k, 0, 16);
        }
        continue;
      }
      size_t a = (size_t)strtoull(p, &p, 16);
      if (p == line) continue;
      while (*p == ' ' || *p == '\t') p++;
      size_t sz = 0;
      if (p[0] == '0' && p[1] == 'x') {
        char *q = p;
        sz = (size_t)strtoull(p, &q, 16);
        if (q != p) { p = q; while (*p == ' ' || *p == '\t') p++; }
      }
      size_t n = strlen(p);
      while (n > 0 && (p[n - 1] == '\n' || p[n - 1] == '\r')) p[--n] = 0;
      pf_map_add(a, sz, p, n);
    }
    fclose(f);
  }
  /* 两份并到一起，按地址排好 —— 查表要的是有序（`pf_map_at` 是二分）。 */
  if (pf_map_n > 1) qsort(pf_map, (size_t)pf_map_n, sizeof *pf_map, pf_sym_cmp);
  if (pf_map_n > 0) pf_map_hi = pf_map[pf_map_n - 1].addr;
  /* ASLR 的滑动量（PE 那条腿）：真实基址 - 图里记的链接期基址。`pf_map_name` 本来就是
     「原样查一遍、不中再减掉 base 查一遍」，所以填进 `pf_map_base` 正好对上。 */
  if (pf_map_imagebase != 0) {
    size_t mb = pf_module_base();
    if (mb != 0 && (unsigned long long)mb >= pf_map_imagebase) {
      pf_map_base = (size_t)((unsigned long long)mb - pf_map_imagebase);
    }
  }
  /* `OMNI_PROF_DEBUG=1`：说一句「图里几条、滑动量多少」。名字全印成裸地址时，
     要分的就是这两件事 —— 图没读进来（0 条），还是滑动量不对（PIE/ASLR 那一格）。 */
  const char *dbg = getenv("OMNI_PROF_DEBUG");
  if (dbg != 0 && dbg[0] != 0 && dbg[0] != '0') {
    fprintf(stderr, "omni prof: 链接图 %d 条，滑动量 0x%llx，图里第一条 0x%llx\n",
            pf_map_n, (unsigned long long)pf_map_base,
            pf_map_n > 0 ? (unsigned long long)pf_map[0].addr : 0ull);
  }
}

/* 在图里二分：最后一个不大于 a 的那一格，**而且 a 要真落在它里头**。
 *
 * 那句"真落在它里头"是必须的（第一百六十五片量出来的教训）。libc 被 strip 之后
 * 只剩 `.dynsym`（导出的那 2891 个），条目之间隔着几百上千字节的局部函数。
 * 光取"最近的前一个"会把 `start_thread`（0x980a2）报成 `pthread_condattr_setpshared`
 * ——那是 1458 字节之前的**另一个**函数。第一版就是这么错的，量到过一串假名字：
 * `erand48_r` / `timer_settime` / `__pthread_get_minstack` / `vfprintf`。
 * **confidently wrong 比 `libc.so.6+偏移` 坏得多**：前者会把人带到完全无关的函数上。
 *
 * 界怎么定：符号自己的 `st_size` 优先（ELF 里函数的长度）；`st_size == 0` 的
 * （汇编写的桩、我们自己那份 `--map` 里的条目）用**下一格的地址**当界 —— 表是密的，
 * 那个界就是对的。两个都没有就退 4 KiB，宁可少认不要认错。 */
static const char *pf_map_at(size_t a) {
  if (pf_map_n == 0 || a < pf_map[0].addr) return 0;
  int lo = 0;
  int hi = pf_map_n - 1;
  int best = -1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    if (pf_map[mid].addr <= a) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return 0;
  size_t end;
  if (pf_map[best].size != 0) end = pf_map[best].addr + pf_map[best].size;
  else if (best + 1 < pf_map_n) end = pf_map[best + 1].addr;
  else end = pf_map[best].addr + 4096;
  return a < end ? pf_map[best].name : 0;
}

/* 一个地址翻成名字。
 *
 * **两种图都要认，而且不能靠猜是哪一种**（第一百六十三片量出来的）：
 *   - 我们自己那台链接器出的是**非 PIE**，`c link --map` 里落的是最终虚拟地址
 *     （`0x50cd60 u_fib`）——`backtrace()` 给的就是它，直接查。
 *   - 外部 cc（clang/gcc）默认出 **PIE**，`nm -n` 落的是**文件地址**（`0x3910 u_fib`），
 *     而运行时地址是它加上加载基地址。量到过：不修正的话 `--cc clang` 那一趟整张表
 *     全是 `a.out+0x3970` 这种，名字一个都翻不出来。
 * 所以**先按原样查一遍，不中再减掉 base 查一遍**：哪一种图命中哪一条，不必事先判断，
 * 也不会因为判错而把非 PIE 的地址减坏。 */
static const char *pf_map_name(void *p) {
  if (pf_map_n == 0) return 0;
  size_t a = (size_t)p;
  const char *m = pf_map_at(a);
  if (m) return m;
  if (pf_map_base != 0 && a >= pf_map_base) return pf_map_at(a - pf_map_base);
  return 0;
}

static const char *pf_name_of(void *fn, char **syms, int nsym, int i) {
  /* 链接图优先：它是**链接器自己说的**，比 `backtrace_symbols` 猜得准（static 函数也在）。 */
  {
    const char *m = pf_map_name(fn);
    if (m) return m;
  }
#if !defined(__APPLE__) && !defined(_WIN32)
  /* Windows 上没有 `dladdr`（模块里最近的符号得自己走 PE 的导出表或 dbghelp，
   * 那是另一刀），所以这条腿直接落到下面「模块 + 偏移」那一支。 */
  /* **外部模块（libc 之类）里的地址：问 `dladdr`**（第一百六十四片）。
   *
   * `backtrace_symbols` 在拿不到名字时只给 `路径(+偏移)`，而 `dladdr` 答的是两格：
   * 这个地址属于哪个模块（`dli_fname`）、模块里最近的那个符号（`dli_sname` / `dli_saddr`）。
   * 于是同一个地址能印成 `pthread_condattr_setpshared+0x42` 而不是 `libc.so.6+0x980a2` ——
   * 名字是 `.dynsym` 里真有的那一个，偏移是"离它多远"。
   *
   * **为什么有些还是只有偏移**：这台机器上 `nm /usr/lib/libc.so.6` 回的是 "no symbols"
   * —— Arch 把 libc **strip 了**，`.symtab` 整节不在，只剩 `.dynsym`（导出的那些）。
   * `start_thread`、`__libc_start_call_main` 这类是**局部符号**，两张表都没有它们，
   * 文件里根本不存在那个名字（`.gnu_debuglink` 指着 `libc.so.6.debug`，那是
   * `glibc-debug` 包里的东西，没装）。这种情况 perf / gdb 印的也是
   * `libc.so.6[+0x980a2]` —— 这是系统上能拿到的全部信息，不是我们少做了一步。
   * 所以这一支的口径是：**`.dynsym` 里有最近的符号就用「符号+偏移」，没有才退回「模块+偏移」**。 */
  {
    Dl_info di;
    if (dladdr(fn, &di) != 0 && di.dli_sname != 0 && di.dli_sname[0] != 0) {
      static char dbuf[256];
      size_t off = di.dli_saddr != 0 && (size_t)fn >= (size_t)di.dli_saddr
        ? (size_t)fn - (size_t)di.dli_saddr : 0;
      if (off == 0) {
        size_t n = strlen(di.dli_sname);
        if (n > sizeof(dbuf) - 1) n = sizeof(dbuf) - 1;
        memcpy(dbuf, di.dli_sname, n);
        dbuf[n] = 0;
      } else {
        snprintf(dbuf, sizeof dbuf, "%s+0x%llx", di.dli_sname, (unsigned long long)off);
      }
      return dbuf;
    }
  }
#endif
  if (syms == 0 || i >= nsym || syms[i] == 0) return 0;
  /* `backtrace_symbols` 那一行长这样（Darwin）：
   *   "3   omni   0x0000000100a24f98 omni_js_arr_of + 52"
   * 取「地址后面、`+` 前面」那一段。glibc 那边是 "./a.out(fn+0x12) [0x…]" —— 两种都
   * 只认「最后一个 `+` 之前的那个词」，于是一份代码认两种。 */
  (void)fn;
  const char *s = syms[i];
  const char *plus = strrchr(s, '+');
  const char *end = plus ? plus : s + strlen(s);
  while (end > s && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '(')) end--;
  const char *beg = end;
  while (beg > s && beg[-1] != ' ' && beg[-1] != '\t' && beg[-1] != '(') beg--;
  if (end <= beg) return 0;
  /* **路径不是函数名**（第一百六十三片，量出来的）。没有符号可查时 glibc 给的是
     `/路径/a.out(+0x10cdec) [0x50cdec]` —— 上面那几句削完剩下的是**那个路径**。
     认下来的后果最难看：`--cc clang` 那一趟（外部编译器链的，我们没落 `--map`）
     整张表五行全是同一个字符串 `/omni/.omni-cache/work/…/a.out`，调用树里每一层
     也都是它 —— 看着像"插桩没做好"，其实插桩的计数（635621 / 2000000 / 1）全是对的，
     坏的只是翻名字这一步。
     改成印 `文件名+偏移`（`a.out+0x10cdec` / `libc.so.6+0x89e40`）：至少**每个地址
     不一样**，栈能读、能拿去 addr2line；而真有符号的那一路（`libc.so.6(printf+0x5f)`）
     取到的是 `printf`，不带 `/`，这一支碰不到它。 */
  if (memchr(beg, '/', (size_t)(end - beg)) != 0) {
    static char pbuf[256];
    const char *base = end;
    while (base > beg && base[-1] != '/') base--;
    size_t bn = (size_t)(end - base);
    if (bn > sizeof(pbuf) - 24) bn = sizeof(pbuf) - 24;
    memcpy(pbuf, base, bn);
    pbuf[bn] = 0;
    /* `(+0x…)` 里那个偏移：有就接上，没有（Darwin 那种格式）就只留文件名。 */
    if (plus && plus[1] == '0' && plus[2] == 'x') {
      size_t k = bn;
      pbuf[k++] = '+';
      for (const char *q = plus + 1; *q && *q != ')' && *q != ' ' && k < sizeof(pbuf) - 1; q++) {
        pbuf[k++] = *q;
      }
      pbuf[k] = 0;
    }
    return pbuf;
  }
  /* **`[0x…]` 不是名字**。glibc 在没有符号可查时给的是 `./a.out(+0x10cdec) [0x50cdec]`：
     最后一个 `+` 之前那个词是 `./a.out(`，被上面那几句削成空，于是退到 `[0x50cdec]`
     这一格上 —— 它看着像名字，实际是同一个地址换了个写法。认下来的后果是 CLI 那一层
     （它按"裸地址就去查链接图"翻名字）根本认不出这是地址，于是 Linux 上 `--profile cc`
     与 `--profile sample` 印出来的每一格都是 `[0x50cdec]`（量到过，五个函数全是）。
     这一句把它挡掉，让这一帧退回"只有地址"，翻名字的事交给外面那张 `--map`。 */
  if (*beg == '[' || (beg[0] == '0' && beg[1] == 'x')) return 0;
  static char buf[256];
  size_t n = (size_t)(end - beg);
  if (n > sizeof(buf) - 1) n = sizeof(buf) - 1;
  memcpy(buf, beg, n);
  buf[n] = 0;
  return buf;
}

static int pf_cmp_self(const void *a, const void *b) {
  const pf_fn *x = (const pf_fn *)a;
  const pf_fn *y = (const pf_fn *)b;
  if (x->self != y->self) return x->self > y->self ? -1 : 1;
  return 0;
}

/* 折叠栈：`底;…;顶 计数`（Brendan Gregg 那一套）。火焰图与 gprof2dot 都吃它。
 * 栈是**倒着印**的：`backtrace` 回来是「顶在前」，而折叠栈要「底在前」。
 *
 * 权重的单位跟着档走：采样那一档是**帧数**，插桩那一档是**微秒**（表里存的是纳秒，
 * 这儿除 1000）。CLI 那一层按档告诉那几张表该怎么读（`--unit`）—— 折叠栈这个格式
 * 自己不带单位，所以两边说的必须是同一句话。 */
static void pf_write_folded(const char *path) {
  FILE *f = fopen(path, "w");
  if (f == 0) return;
  if (pf_stacks_used > 0) {
    for (int i = 0; i < PF_SLOTS; i++) {
      pf_stack *e = &pf_stacks[i];
      if (e->n == 0) continue;
      char **syms = backtrace_symbols(e->fr, e->n);
      for (int j = e->n - 1; j >= 0; j--) {
        const char *nm = pf_name_of(e->fr[j], syms, e->n, j);
        if (nm) fprintf(f, "%s", nm);
        else fprintf(f, "0x%llx", (unsigned long long)(size_t)e->fr[j]);
        if (j > 0) fprintf(f, ";");
      }
      unsigned long long w = pf_instr ? e->hits / 1000ull : e->hits;
      if (pf_instr && w == 0) w = 1;          /* 不满 1µs 的那些别整格消失 */
      fprintf(f, " %llu\n", w);
      if (syms) free(syms);
    }
  } else {
    /* 一条栈都没记下来时退化成一层（`self` 全是 0 的那种极短程序）—— 照样喂得进
     * 火焰图，形状上诚实：那时我们确实没有调用链。 */
    for (int i = 0; i < PF_SLOTS; i++) {
      pf_fn *e = &pf_fns[i];
      if (e->fn == 0 || e->self == 0) continue;
      char **syms = backtrace_symbols(&e->fn, 1);
      const char *nm = pf_name_of(e->fn, syms, 1, 0);
      if (nm) fprintf(f, "%s %llu\n", nm, e->self);
      else fprintf(f, "0x%llx %llu\n", (unsigned long long)(size_t)e->fn, e->self);
      if (syms) free(syms);
    }
  }
  fclose(f);
}

void omni_prof_report(void) {
  /* **只印一遍**（第一百五十五片）：现在有三个人会叫它 —— atexit、时限那一枪
     （`omni_js_host.c` 的 `host_timeout_alarm`）、外面送来的 SIGTERM/SIGINT。
     哪一条先到都算，后到的那几条直接回。挂起时的那一趟正是最要紧的那一趟：
     死循环与超时的现场只有它看得见。 */
  static volatile int pf_reported = 0;
  if (pf_reported) return;
  pf_reported = 1;
  if (pf_sampling) {
#if defined(_WIN32)
    /* 采样线程那一档（3 号）：把旗子放下就行 —— 它自己会在下一轮 `Sleep` 之后退出。
     * 不等它（`WaitForSingleObject`）：这一趟可能是**要死的那一趟**（时限那一枪），
     * 而它最多还会记一帧，那一帧记进表里也不碍事。 */
    pf_w_stop = 1;
#else
    struct itimerval off;
    memset(&off, 0, sizeof off);
    setitimer(pf_sampling == 1 ? ITIMER_PROF : ITIMER_REAL, &off, 0);
#endif
  }
  /* **先停表，再读链接图**。反了的话 `pf_map_load` 自己的 `fopen`/`fgets` 会被采进去
     （量到过：`omni_prof_report > pf_map_load > fgets` 真出现在热路径里）—— 收集器
     不该出现在自己的报告里。 */
  pf_map_load();
  const char *out = getenv("OMNI_PROF_OUT");
  if (out && out[0]) pf_write_folded(out);
  /**
   * 印哪张表按**这一趟是哪一档**分，不按"那张栈表里有没有东西"分（第一百四十九片第四格
   * 量到的一格）：插桩那一档现在也往栈表里记（那是它精确的调用栈），于是从前那个
   * `pf_stacks_used > 0` 的判据把 `cc` 档也认成采样，印出来是
   * 「采样 CPU 时间，0 帧、3 条栈」加三行 `0.00%` 与一串纳秒 —— 而**调用次数**那一栏
   * （采样永远给不出的那一栏）整格没了。两张表各答各的问题，谁也替不了谁。
   */
  if (pf_sampling && !pf_instr) {
    /* **按名字并**，不按 PC 并（量出来的一格）：采样采到的是**指令地址**，同一个函数里
     * 几十条不同的指令就是几十条不同的栈 —— 第一版直接按栈排，一份九成时间在 `hot` 里的
     * 程序印出来是 `hot 48%` / `hot 13%` / `hot 11%`… 十五行，每行都是它。折叠栈那一份
     * 不用管（火焰图工具本来就把同名的行加起来），要并的只是这张榜。 */
    fprintf(stderr, "\nomni prof（采样 %s，%llu 帧、%d 条栈%s）：按帧数排前 20 个函数\n",
      pf_sampling == 2 ? "墙上时间" : "CPU 时间", pf_samples, pf_stacks_used,
      pf_lost ? "，有丢帧" : "");
    /* **帧数少就把误差说出来**（第一百六十二片）。占比是从 n 帧里估的比例，2σ 约
       `1/sqrt(n)`：46 帧上 ±15%，240 帧上 ±6.5%，1000 帧上 ±3%。不说的话那张表看着
       和精确计数一样可信 —— 量到过一趟 46 帧的报告被当成"采样实现得不准"，而同一份
       程序采到 240 帧时与墙上时间的账对得上（fib 那一半 11.25% vs 墙上 8.8%）。
       门槛定在 400：再往上 2σ 就进 5% 以内了。 */
    if (pf_samples > 0 && pf_samples < 400) {
      /* 整数开方，不拉 `math.h`/`-lm` 进来（运行时这一份要能给 tcc 与我们自己那台
         C 前端编，少一个依赖少一处麻烦）。n < 400 所以最多转 19 圈。 */
      unsigned long long r = 1;
      while ((r + 1) * (r + 1) <= pf_samples) r++;
      fprintf(stderr, "  注：只有 %llu 帧，每个占比的 2σ 误差约 ±%llu%% —— "
        "要更细就提频率（`--profile sample:9973`）或者加大工作量\n",
        pf_samples, 100ull / r);
    }
#define PF_TOPN 256
    static char pf_top_name[PF_TOPN][128];
    static unsigned long long pf_top_hits[PF_TOPN];
    int tn = 0;
    for (int i = 0; i < PF_SLOTS; i++) {
      pf_stack *e = &pf_stacks[i];
      if (e->n == 0) continue;
      char **syms = backtrace_symbols(e->fr, e->n);
      const char *nm = pf_name_of(e->fr[0], syms, e->n, 0);
      char key[128];
      if (nm) {
        size_t n = strlen(nm);
        if (n > sizeof(key) - 1) n = sizeof(key) - 1;
        memcpy(key, nm, n);
        key[n] = 0;
      } else {
        snprintf(key, sizeof(key), "0x%llx", (unsigned long long)(size_t)e->fr[0]);
      }
      if (syms) free(syms);
      int at = -1;
      for (int j = 0; j < tn; j++) if (strcmp(pf_top_name[j], key) == 0) { at = j; break; }
      if (at < 0 && tn < PF_TOPN) { at = tn++; memcpy(pf_top_name[at], key, strlen(key) + 1); pf_top_hits[at] = 0; }
      if (at >= 0) pf_top_hits[at] += e->hits;
    }
    for (int i = 0; i < tn; i++) {
      for (int j = i + 1; j < tn; j++) {
        if (pf_top_hits[j] > pf_top_hits[i]) {
          unsigned long long th = pf_top_hits[i]; pf_top_hits[i] = pf_top_hits[j]; pf_top_hits[j] = th;
          char tb[128];
          memcpy(tb, pf_top_name[i], sizeof(tb));
          memcpy(pf_top_name[i], pf_top_name[j], sizeof(tb));
          memcpy(pf_top_name[j], tb, sizeof(tb));
        }
      }
    }
    int lim = tn < 20 ? tn : 20;
    for (int i = 0; i < lim; i++) {
      double pct = pf_samples ? 100.0 * (double)pf_top_hits[i] / (double)pf_samples : 0.0;
      fprintf(stderr, "  %6.2f%%  %8llu  %s\n", pct, pf_top_hits[i], pf_top_name[i]);
    }
  } else if (pf_fns_used > 0) {
    fprintf(stderr, "\nomni prof（编译器插桩 -finstrument-functions，%d 个函数%s）："
      "按自用时间排前 20 行\n", pf_fns_used, pf_ovf ? "，影子栈越过界（自用时间偏大）" : "");
    static pf_fn sorted[PF_SLOTS];
    int n = 0;
    for (int i = 0; i < PF_SLOTS; i++) if (pf_fns[i].fn != 0) sorted[n++] = pf_fns[i];
    qsort(sorted, (size_t)n, sizeof(pf_fn), pf_cmp_self);
    int lim = n < 20 ? n : 20;
    fprintf(stderr, "  %10s %10s %12s  %s\n", "自用 ms", "含子 ms", "调用次数", "函数");
    for (int i = 0; i < lim; i++) {
      pf_fn *e = &sorted[i];
      char **syms = backtrace_symbols(&e->fn, 1);
      const char *nm = pf_name_of(e->fn, syms, 1, 0);
      fprintf(stderr, "  %10.3f %10.3f %12llu  %s",
        (double)e->self / 1e6, (double)e->total / 1e6, e->calls, nm ? nm : "");
      if (!nm) fprintf(stderr, "0x%llx", (unsigned long long)(size_t)e->fn);
      fprintf(stderr, "\n");
      if (syms) free(syms);
    }
    /* **观察者效应要说出来**（第一百六十二片，量出来的）。这一档每次进/出都调两个钩子，
       量到的单次成本约 600ns —— 对一个函数体只有几纳秒的小函数，"自用时间"里几乎全是
       钩子。同一份程序（fib(32) + sumTo(2e7)）：不插桩 205ms，插桩之后 11515ms，**56 倍**；
       `u_fib` 报 4270ms / 7049155 次 = 606ns 一次，正好是钩子的价钱。
       墙上时间的对账（两半分开跑）说的是 fib 占 8.8%，而 sample 那一档报 11.25% —— 对得上；
       这一档报 37%，对不上。所以「调用次数大」的那几行要按这一句读。 */
    {
      unsigned long long mx = 0;
      for (int i = 0; i < lim; i++) if (sorted[i].calls > mx) mx = sorted[i].calls;
      if (mx >= 100000ull) {
        fprintf(stderr, "  注：这一档每次调用插两个钩子（量到约 600ns 一次）。"
          "上面调用次数大的那几行，自用时间里**主要是钩子**，不是函数体 —— "
          "要看真实占比用 `--profile sample`\n");
      }
    }
  }
  if (out && out[0]) fprintf(stderr, "  折叠栈写到了 %s\n", out);
}

/**
 * 一进门就问一句：环境里让不让采样。`OMNI_PROF=sample[:hz]` 打开采样档
 * （`OMNI_PROF=sample:997` 是每秒 997 次 —— 挑质数是老规矩，免得与程序自己的周期共振）。
 * 别的值（`cc` / `stub`）这一层不管：那两档由编译期决定，运行期没有开关。
 */
void omni_prof_env_init(void) {
  const char *v = getenv("OMNI_PROF");
  if (v == 0 || v[0] == 0) return;
  if (strncmp(v, "sample", 6) != 0) return;
  int hz = 0;
  const char *colon = strchr(v, ':');
  if (colon) {
    for (const char *p = colon + 1; *p >= '0' && *p <= '9'; p++) hz = hz * 10 + (*p - '0');
  }
  omni_prof_sample_start(hz);
}
