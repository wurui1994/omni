/* omni_sched.h —— G/M/P 的 M:N 调度器，**照 go/src/runtime 严格实现**。
 *
 * **为什么住在 `src/runtime-sched/` 而不是 `src/runtime/`**（与 `jit/`、`runtime-gl/`
 * 同一条理由，写在 `core/runtime/c_runtime.js` 顶上）：`runtimeSources()` 把
 * `src/runtime/` 下**每一个 .c** 都喂给 cc，混进去就等于**所有腿强制依赖**它 ——
 * 而这一份我们自己那台 C 前端还编不过。所以它单独一格目录，用到并发的程序才编它。
 *
 * **还差什么才能搬进 `src/runtime/`（#76）**，2026-09-20 量出来的账：
 *   * ~~`<stdatomic.h>`~~ —— **已经不欠了**：换成了 `omni_atomic.h`（照 Go 的
 *     `runtime/internal/atomic`：字段是普通字段、要原子就显式调那几个函数）。
 *     `omni c mir` 现在能过那一段。
 *   * `<pthread.h>` —— 我们的 sysroot 里**本来就有**（各目标的 `include/pthread.h`）。
 *   * **剩下的那一堵**：`omni_sctx_sw` 那段 arm64 的 `__asm__`。现在报的是
 *     `第八刀：非空的 __asm__ 模板还没到（等自带汇编器）`。Go 那边这一段也是汇编
 *     （`asm_arm64.s` 的 `gogo` / `mcall`），所以这不是"简化"，是我们那台前端还欠一格内联汇编。
 *   * `__atomic_*` 那几个内建也还没验过（头解析得过，真调到时会不会报另一句 ——
 *     被 `__asm__` 那一句挡在前面，量不到）。
 *
 * 对应关系（一格一格对着抄的，不是照着想法写的）：
 *   runtime2.go  g / m / p / schedt / sudog、_G* 与 _P* 那两串 iota 常量
 *   proc.go      newproc / runqput / runqputslow / runqget / runqgrab / runqsteal /
 *                globrunqput / globrunqget / schedule / execute / findRunnable /
 *                stealWork / randomOrder / gopark / park_m / ready / goready /
 *                wakep / startm / stopm / mstart / goexit0
 *   lock_*.go    note（一次性唤醒）：noteclear / notesleep / notewakeup
 *
 * 明写三处**刻意的偏差**（都是"我们还没有那台机器"，不是简化判据）：
 *   1. **没有 sysmon**，所以没有抢占。Go 自己也有这一档 —— `runqput` 里那句
 *      `if !haveSysmon && next { next = false }`，理由与我们一样（没有抢占时
 *      runnext 会让一对 goroutine 把别人饿死）。我们把 `OMNI_HAVE_SYSMON` 设成 0，
 *      走的是 Go 在那个配置下的同一条分支。
 *   2. **栈不会长**（Go 有 morestack + copystack）。所以每条 g 一上来就给
 *      `OMNI_G_STACK` 这么大的一块，越界就是崩 —— 不是"以后再说"，是这一版的边界。
 *   3. **没有 GC**，所以 gcwaiting / gcstopm / 标记工作者那几支全不在。
 *
 * 切栈用的是 `lua-rt.h` 里那份已经量过的路数（arm64 手写 asm，比 ucontext 快 44 倍），
 * 它对应 Go 的 `gogo` 与 `mcall` —— Go 那两个也是手写 asm，同一件事。
 */
#ifndef OMNI_SCHED_H
#define OMNI_SCHED_H

#include <stddef.h>
#include <stdint.h>
#include "omni_atomic.h"
#include <pthread.h>

/* ---- g 的状态（runtime2.go:37 起的那串 iota，值必须一样） ---- */
#define OMNI_GIDLE      0
#define OMNI_GRUNNABLE  1
#define OMNI_GRUNNING   2
#define OMNI_GSYSCALL   3
#define OMNI_GWAITING   4
#define OMNI_GDEAD      6

/* ---- p 的状态（runtime2.go:122 起） ---- */
#define OMNI_PIDLE      0
#define OMNI_PRUNNING   1
#define OMNI_PSYSCALL   2
#define OMNI_PGCSTOP    3
#define OMNI_PDEAD      4

/* p.runq 的长度。Go 是 `runq [256]guintptr`，`runqputslow` 的批量与
   `runqgrab` 的 n/2 都按这个数算，所以不能随便改。 */
#define OMNI_RUNQ_SIZE  256

/* 每条 g 的栈。Go 从 8KB 起、靠 morestack 长；我们不长栈（见文件头偏差 2）。 */
#define OMNI_G_STACK    (1u << 20)

/* 见文件头偏差 1：没有 sysmon。`runqput` 里要照 Go 在这个配置下的分支走。 */
#define OMNI_HAVE_SYSMON 0

typedef struct omni_g omni_g;
typedef struct omni_m omni_m;
typedef struct omni_p omni_p;
typedef struct omni_sudog omni_sudog;

/* note —— 一次性唤醒（lock_futex.go / lock_sema.go 的那三个口）。 */
typedef struct {
  pthread_mutex_t mu;
  pthread_cond_t cv;
  int woken;
} omni_note;

void omni_noteclear(omni_note *n);
void omni_notesleep(omni_note *n);
void omni_notewakeup(omni_note *n);

/* gobuf —— Go 里是 {sp,pc,g,ctxt,lr,bp}；我们切栈那一版把被调方要保的寄存器
   连返回地址一起摆在**它自己的栈上**，所以这儿只剩一个 sp。换回来时
   `omni_ctx_sw` 的 `ret` 就落回当初切出去的那一条指令后面 —— pc 不必单独记。 */
typedef struct { void *sp; } omni_gobuf;

struct omni_g {
  omni_gobuf sched;
  char *stack;                    /* malloc 出来的那一块（低地址端） */
  size_t stacksize;
  uint32_t atomicstatus;      /* 原子字段：读写都走 omni_atomic_*（与 Go 一样是普通字段） */
  omni_g *schedlink;              /* 队列里的下一条（runq 用数组，全局队列用这个） */
  omni_m *m;                      /* 正在跑它的 M（不跑的时候是 NULL） */
  void (*fnptr)(void *);          /* goroutine 体 */
  void *arg;
  omni_sudog *waiting;            /* 这条 g 正挂在哪几个 channel 上（chan.go 用） */
  void *param;                    /* 唤醒方递过来的东西（ready 之前设） */
  int64_t goid;
  uint32_t selectDone;        /* select 抢唤醒用（sudog.isSelect 那一路）；原子字段 */
};

struct omni_m {
  omni_g *g0;                     /* 调度用的那条 g（跑在这个 pthread 自己的栈上） */
  omni_g *curg;                   /* 正在跑的用户 g */
  omni_p *p;                      /* 当前占着的 P */
  omni_p *nextp;                  /* startm 交过来的 P（stopm 醒了之后接住） */
  int32_t id;
  int spinning;                   /* 正在找活（findRunnable 的那一档） */
  omni_note park;
  omni_m *schedlink;              /* sched.midle 链 */
  pthread_t thread;
  /* gopark 的三格（Go 放在 m 上，理由一样：不能在切栈之前动 g） */
  int (*waitunlockf)(omni_g *, void *);
  void *waitlock;
  int locks;                      /* acquirem/releasem 的计数（禁抢占，我们只用来自检） */
  /* **为什么要这一格**（这是与 Go 形状上唯一的差别，语义一样）：
     Go 的 `mcall(fn)` 把"切到 g0 之后要干什么"当函数指针递过去（park_m / goexit0 /
     gosched_m 各一个）。我们的切栈原语 `omni_sctx_sw` 是对称的 —— g 切回 g0 时，
     控制流是从 `execute()` 里那一句 `omni_sctx_sw` **返回**的，所以"要干什么"不能靠
     函数指针，只能靠一格理由码，由 g0 上的调度循环照着分流。落点与 Go 一样：
     那几件事都在 g0 的栈上做。 */
  int switchreason;
};

/* omni_m.switchreason：g 为什么切回 g0（对应 Go 的 mcall(park_m/goexit0/gosched_m)） */
#define OMNI_SW_PARK   1
#define OMNI_SW_YIELD  2
#define OMNI_SW_DEAD   3

struct omni_p {
  int32_t id;
  uint32_t status;            /* 原子字段 */
  omni_m *m;
  uint32_t schedtick;             /* 每次非 inheritTime 的 execute 加一（findRunnable 的 %61） */
  /* 本地运行队列：**无锁环**，头尾各自的内存序照 proc.go 抄（LoadAcq / StoreRel / CasRel） */
  uint32_t runqhead;          /* 原子字段 */
  uint32_t runqtail;          /* 原子字段 */
  omni_g *runq[OMNI_RUNQ_SIZE];
  omni_g *runnext;            /* 原子字段（指针） */
  omni_p *link;                   /* sched.pidle 链 */
};

/* sudog（runtime2.go）—— "一条 g 挂在某个等待队列上"的那一格。
 * 一条 g 可能同时挂在好几个 channel 上（select），所以它与 g 是多对一，
 * 不能把这些字段直接摆进 g 里 —— 这是 Go 那段注释给的理由，照搬。 */
struct omni_sudog {
  omni_g *g;
  omni_sudog *next, *prev;
  void *elem;                     /* 要收/要发的那个值的地址（可能在 g 的栈上） */
  int isSelect;                   /* 这条 g 正在 select ⇒ 唤醒要靠 selectDone 抢 */
  int success;                    /* 1 = 真收发到了；0 = 是被 close 叫醒的 */
  omni_sudog *waitlink;           /* g.waiting 那条链（select 把几格串起来） */
  void *c;                        /* 挂在哪个 channel 上（omni_hchan *） */
  uint16_t caseIndex;             /* select 里这是第几格 case */
};

omni_sudog *omni_acquireSudog(void);
void omni_releaseSudog(omni_sudog *s);

/* ---- 对外那几个口（前端/运行时别处只看这些） ---- */
void omni_sched_init(int32_t nprocs);   /* nprocs <= 0 = 按核数 */
void omni_newproc(void (*fn)(void *), void *arg);   /* = go f(arg) */
void omni_sched_main(void (*fn)(void *), void *arg);/* 主 goroutine 跑完就回 */
omni_g *omni_getg(void);                /* 当前 g（没有就是 NULL） */
void omni_gopark(int (*unlockf)(omni_g *, void *), void *lock, uint32_t reason);
void omni_goready(omni_g *gp, int next);
void omni_gosched(void);                /* runtime.Gosched */
int32_t omni_gomaxprocs(void);
int32_t omni_numcpu(void);

#endif /* OMNI_SCHED_H */
