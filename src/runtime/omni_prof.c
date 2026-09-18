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
#include "omni.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <signal.h>
#include <sys/time.h>
#include <execinfo.h>

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
  /* 第 0 格是「处理函数要返回到哪儿」（内核那个跳板里），对谁都一样，跳掉。 */
  int skip = got > 1 ? 1 : 0;
  void *st[PF_BT];
  int m = 0;
  void *pc = pf_pc_of(uc);
  if (pc) st[m++] = pc;
  for (int i = skip; i < got && m < PF_BT; i++) st[m++] = fr[i];
  pf_samples++;
  pf_stack_add(st, m, 1);
}

static void pf_warm(void) {
  void *fr[4];
  (void)backtrace(fr, 4);
}

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
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = pf_on_term;
  sigaction(SIGTERM, &sa, 0);
  sigaction(SIGINT, &sa, 0);
  sigaction(SIGQUIT, &sa, 0);
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

/* ---- 报告。
 *
 * 符号名：`backtrace_symbols` 有就用（系统 libc 上有）；**我们自己那份 libc 上它回 0**
 * （读自己的符号表是另一件事，见 sysroot 的 README）—— 那时就印地址，由 CLI 那一层
 * 拿着二进制的符号表翻。所以这一层的输出**一律带地址**：有名字时是「名字 0x地址」，
 * 没名字时只有地址。翻名字的人在外面，格式不因为在哪条腿上跑而变。 */
static const char *pf_name_of(void *fn, char **syms, int nsym, int i) {
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
    struct itimerval off;
    memset(&off, 0, sizeof off);
    setitimer(pf_sampling == 1 ? ITIMER_PROF : ITIMER_REAL, &off, 0);
  }
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
