/* omni_sched.c —— 见 omni_sched.h 顶上那段对应关系与三处刻意偏差。 */

#include "omni_sched.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sched.h>

#if !defined(__aarch64__)
#error "omni sched: 切栈那一段目前只写了 arm64（x86_64 那一份照同一套路数补）"
#endif

/* ---- 切栈（= Go 的 gogo / mcall，它们在 Go 里也是手写 asm） ----
 *
 * 照 `src/core/ir/lua-rt.h` 里那份量过的：`swapcontext` 每次都走一趟 `sigprocmask`，
 * 400000 次切换 338ms；下面这段 7.7ms，44 倍。arm64 的调用约定里被调方要保住
 * x19–x28、x29/x30、d8–d15，把这 20 格连 sp 一起换掉就换了一条执行流。
 *
 * 起一条 g：在它自己的栈顶摆一个**假的保存帧** —— x19 槽放 g 指针、lr 槽放
 * `_omni_g_entry`。于是第一次切进去时那条 `ret` 直接落到跳板上。
 */
void omni_sctx_sw(void **from, void *to);
extern void omni_g_entry(void);
void omni_g_main(omni_g *gp);

__asm__(
".text\n"
".p2align 2\n"
".globl _omni_sctx_sw\n"
"_omni_sctx_sw:\n"
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
".globl _omni_g_entry\n"
"_omni_g_entry:\n"
"  mov x0, x19\n"
"  bl _omni_g_main\n"
"  brk #1\n"
);

/* ---- note（lock_sema.go 的 noteclear / notesleep / notewakeup） ---- */
void omni_noteclear(omni_note *n) {
  pthread_mutex_lock(&n->mu);
  n->woken = 0;
  pthread_mutex_unlock(&n->mu);
}
void omni_notesleep(omni_note *n) {
  pthread_mutex_lock(&n->mu);
  while (n->woken == 0) pthread_cond_wait(&n->cv, &n->mu);
  pthread_mutex_unlock(&n->mu);
}
void omni_notewakeup(omni_note *n) {
  pthread_mutex_lock(&n->mu);
  n->woken = 1;
  pthread_cond_signal(&n->cv);
  pthread_mutex_unlock(&n->mu);
}

/* ---- schedt（runtime2.go 的那格全局状态） ---- */
static struct {
  pthread_mutex_t lock;
  omni_m *midle;                  /* 空闲 M 链（mput / mget） */
  int32_t nmidle;
  int32_t mnext;                  /* 下一个 M 的 id（mReserveID） */
  omni_g *runqhead, *runqtail;    /* 全局运行队列（gQueue） */
  int32_t runqsize;
  omni_p *pidle;                  /* 空闲 P 链（pidleput / pidleget） */
  int32_t npidle;             /* 原子字段（omni_atomic_*） */
  int32_t nmspinning;         /* 原子字段 */
  omni_g *gfree;                  /* 死了的 g 回收链（gfput / gfget） */
  int64_t goidgen;            /* 原子字段 */
} sched;

static omni_p **allp;
static int32_t gomaxprocs;
static _Thread_local omni_g *tls_g;      /* Go 把 g 摆在一个寄存器里，我们用 TLS */
static omni_g *maing;                    /* 主 goroutine（它一结束整个程序就结束） */
static int32_t mainDone;      /* 原子字段 */
static omni_note mainDoneNote;           /* 主 g 结束时叫醒 omni_sched_main 那条线程 */
static int32_t numcpu_cached;

/* ---- 小工具：随机数（proc.go 的 cheaprand，每线程一份 xorshift） ---- */
static _Thread_local uint32_t rndstate;
static uint32_t cheaprand(void) {
  uint32_t x = rndstate;
  if (x == 0) x = 0x9e3779b9u ^ (uint32_t)(uintptr_t)&rndstate;
  x ^= x << 13; x ^= x >> 17; x ^= x << 5;
  rndstate = x;
  return x;
}

static void throwf(const char *s) {
  fprintf(stderr, "omni sched: %s\n", s);
  abort();
}

/* ---- g 的状态读写（proc.go 的 readgstatus / casgstatus） ---- */
static uint32_t readgstatus(omni_g *gp) {
  return omni_atomic_load32_relaxed(&gp->atomicstatus);
}
static void casgstatus(omni_g *gp, uint32_t old, uint32_t new_) {
  if (!omni_atomic_cas32(&gp->atomicstatus, old, new_)) {
    /* CAS 的 old 是传值的，失败时再读一遍当前值来报（Go 的 casgstatus 也是读 gp.atomicstatus） */
    fprintf(stderr, "omni sched: casgstatus 想把 %u 换成 %u，实际是 %u\n", old, new_, readgstatus(gp));
    abort();
  }
}

/* ---- randomOrder（proc.go 的那四个方法，偷工作的走位） ---- */
static struct { uint32_t count; uint32_t *coprimes; uint32_t n; } stealOrder;
static uint32_t gcd_u32(uint32_t a, uint32_t b) { while (b) { uint32_t t = a % b; a = b; b = t; } return a; }
static void stealOrderReset(uint32_t count) {
  free(stealOrder.coprimes);
  stealOrder.coprimes = (uint32_t *)malloc(sizeof(uint32_t) * (count + 1));
  stealOrder.n = 0;
  stealOrder.count = count;
  for (uint32_t i = 1; i <= count; i++) {
    if (gcd_u32(i, count) == 1) stealOrder.coprimes[stealOrder.n++] = i;
  }
}
typedef struct { uint32_t i, count, pos, inc; } omni_renum;
static omni_renum stealOrderStart(uint32_t i) {
  omni_renum e;
  e.i = 0; e.count = stealOrder.count;
  e.pos = i % stealOrder.count;
  e.inc = stealOrder.coprimes[i / stealOrder.count % stealOrder.n];
  return e;
}
static int renumDone(omni_renum *e) { return e->i == e->count; }
static void renumNext(omni_renum *e) { e->i++; e->pos = (e->pos + e->inc) % e->count; }

/* ---- 全局运行队列（proc.go 的 globrunqput / globrunqputbatch / globrunqget）
 *      都要在持 sched.lock 的时候调。 ---- */
static void globrunqput(omni_g *gp) {
  gp->schedlink = NULL;
  if (sched.runqtail != NULL) sched.runqtail->schedlink = gp;
  else sched.runqhead = gp;
  sched.runqtail = gp;
  sched.runqsize++;
}
static void globrunqputbatch(omni_g *head, omni_g *tail, int32_t n) {
  tail->schedlink = NULL;
  if (sched.runqtail != NULL) sched.runqtail->schedlink = head;
  else sched.runqhead = head;
  sched.runqtail = tail;
  sched.runqsize += n;
}
static omni_g *globrunqpop(void) {
  omni_g *gp = sched.runqhead;
  if (gp == NULL) return NULL;
  sched.runqhead = gp->schedlink;
  if (sched.runqhead == NULL) sched.runqtail = NULL;
  gp->schedlink = NULL;
  return gp;                      /* 计数由调用方管（照 Go：gQueue.pop 不动 runqsize） */
}
/* globrunqget：Go 会按 P 的份额取一批（max = runqsize/gomaxprocs+1），我们照抄那条算式。 */
static omni_g *globrunqget(omni_p *pp, int32_t max);

/* ---- 本地运行队列：**无锁环**。内存序照 proc.go 的 LoadAcq/StoreRel/CasRel 抄。 ---- */
static int runqempty(omni_p *pp) {
  /* Go 的 runqempty 要按 head/tail/runnext 的顺序读两遍才作数（注释里那段竞态）。 */
  for (;;) {
    uint32_t head = omni_atomic_load32_acq(&pp->runqhead);
    uint32_t tail = omni_atomic_load32_acq(&pp->runqtail);
    omni_g *rn = (omni_g *)omni_atomic_loadp_acq((void *volatile *)&pp->runnext);
    if (tail == omni_atomic_load32_acq(&pp->runqtail)) {
      return head == tail && rn == NULL;
    }
  }
}

static int runqputslow(omni_p *pp, omni_g *gp, uint32_t h, uint32_t t) {
  omni_g *batch[OMNI_RUNQ_SIZE / 2 + 1];
  uint32_t n = (t - h) / 2;
  if (n != (uint32_t)(OMNI_RUNQ_SIZE / 2)) throwf("runqputslow: queue is not full");
  for (uint32_t i = 0; i < n; i++) batch[i] = pp->runq[(h + i) % OMNI_RUNQ_SIZE];
  if (!omni_atomic_cas32_rel(&pp->runqhead, h, h + n)) return 0;
  batch[n] = gp;
  for (uint32_t i = 0; i < n; i++) batch[i]->schedlink = batch[i + 1];
  pthread_mutex_lock(&sched.lock);
  globrunqputbatch(batch[0], batch[n], (int32_t)(n + 1));
  pthread_mutex_unlock(&sched.lock);
  return 1;
}

static void runqput(omni_p *pp, omni_g *gp, int next) {
  /* proc.go：`if !haveSysmon && next { next = false }` —— 没有 sysmon 就没有抢占，
     runnext 会让一对 goroutine 把别人饿死。我们正是那个配置（见 .h 顶上偏差 1）。 */
  if (!OMNI_HAVE_SYSMON && next) next = 0;
  if (next) {
    for (;;) {
      omni_g *oldnext = (omni_g *)omni_atomic_loadp_relaxed((void *volatile *)&pp->runnext);
      if (omni_atomic_casp((void *volatile *)&pp->runnext, oldnext, gp)) {
        if (oldnext == NULL) return;
        gp = oldnext;                 /* 把旧的那个挤进普通队列 */
        break;
      }
    }
  }
  for (;;) {
    uint32_t h = omni_atomic_load32_acq(&pp->runqhead);
    uint32_t t = omni_atomic_load32_relaxed(&pp->runqtail);
    if (t - h < (uint32_t)OMNI_RUNQ_SIZE) {
      pp->runq[t % OMNI_RUNQ_SIZE] = gp;
      omni_atomic_store32_rel(&pp->runqtail, t + 1);
      return;
    }
    if (runqputslow(pp, gp, h, t)) return;
  }
}

static omni_g *runqget(omni_p *pp, int *inheritTime) {
  omni_g *next = (omni_g *)omni_atomic_loadp_relaxed((void *volatile *)&pp->runnext);
  if (next != NULL && omni_atomic_casp((void *volatile *)&pp->runnext, next, NULL)) {
    *inheritTime = 1;
    return next;
  }
  for (;;) {
    uint32_t h = omni_atomic_load32_acq(&pp->runqhead);
    uint32_t t = omni_atomic_load32_relaxed(&pp->runqtail);
    if (t == h) { *inheritTime = 0; return NULL; }
    omni_g *gp = pp->runq[h % OMNI_RUNQ_SIZE];
    if (omni_atomic_cas32_rel(&pp->runqhead, h, h + 1)) {
      *inheritTime = 0;
      return gp;
    }
  }
}

/* globrunqget 的本体（要持 sched.lock）。份额那条算式照 proc.go 抄。 */
static omni_g *globrunqget(omni_p *pp, int32_t max) {
  if (sched.runqsize == 0) return NULL;
  int32_t n = sched.runqsize / gomaxprocs + 1;
  if (n > sched.runqsize) n = sched.runqsize;
  if (max > 0 && n > max) n = max;
  if (n > OMNI_RUNQ_SIZE / 2) n = OMNI_RUNQ_SIZE / 2;
  sched.runqsize -= n;
  omni_g *gp = globrunqpop();
  n--;
  for (; n > 0; n--) {
    omni_g *gp1 = globrunqpop();
    if (gp1 == NULL) break;
    runqput(pp, gp1, 0);
  }
  return gp;
}

/* runqgrab（proc.go）：从 p2 偷一半。`stealRunNextG` 那一支里 Go 会 usleep(3) 让出
   一个窗口，免得把人家马上要跑的那条抢走 —— 照抄。 */
static uint32_t runqgrab(omni_p *pp, omni_g **batch, uint32_t batchHead, int stealRunNextG) {
  for (;;) {
    uint32_t h = omni_atomic_load32_acq(&pp->runqhead);
    uint32_t t = omni_atomic_load32_acq(&pp->runqtail);
    uint32_t n = t - h;
    n = n - n / 2;
    if (n == 0) {
      if (stealRunNextG) {
        omni_g *next = (omni_g *)omni_atomic_loadp_relaxed((void *volatile *)&pp->runnext);
        if (next != NULL) {
          if (omni_atomic_load32_relaxed(&pp->status) == OMNI_PRUNNING) {
            omni_m *mp = pp->m;
            if (mp != NULL) {
              omni_g *cg = mp->curg;
              if (cg == NULL || readgstatus(cg) != OMNI_GSYSCALL) usleep(3);
            }
          }
          omni_g *nn = next;
          if (!omni_atomic_casp((void *volatile *)&pp->runnext, nn, NULL)) continue;
          batch[batchHead % OMNI_RUNQ_SIZE] = next;
          return 1;
        }
      }
      return 0;
    }
    if (n > (uint32_t)(OMNI_RUNQ_SIZE / 2)) continue;   /* h 与 t 读到不一致 */
    for (uint32_t i = 0; i < n; i++) {
      batch[(batchHead + i) % OMNI_RUNQ_SIZE] = pp->runq[(h + i) % OMNI_RUNQ_SIZE];
    }
    if (omni_atomic_cas32_rel(&pp->runqhead, h, h + n)) return n;
  }
}

static omni_g *runqsteal(omni_p *pp, omni_p *p2, int stealRunNextG) {
  uint32_t t = omni_atomic_load32_relaxed(&pp->runqtail);
  uint32_t n = runqgrab(p2, pp->runq, t, stealRunNextG);
  if (n == 0) return NULL;
  n--;
  omni_g *gp = pp->runq[(t + n) % OMNI_RUNQ_SIZE];
  if (n == 0) return gp;
  uint32_t h = omni_atomic_load32_acq(&pp->runqhead);
  if (t - h + n >= (uint32_t)OMNI_RUNQ_SIZE) throwf("runqsteal: runq overflow");
  omni_atomic_store32_rel(&pp->runqtail, t + n);
  return gp;
}

/* ---- 空闲 P / 空闲 M 的两条链（proc.go 的 pidleput/pidleget/mput/mget，都要持锁） ---- */
static void pidleput(omni_p *pp) {
  if (!runqempty(pp)) throwf("pidleput: P has non-empty run queue");
  pp->link = sched.pidle;
  sched.pidle = pp;
  omni_atomic_xadd32(&sched.npidle, 1);
}
static omni_p *pidleget(void) {
  omni_p *pp = sched.pidle;
  if (pp != NULL) {
    sched.pidle = pp->link;
    pp->link = NULL;
    omni_atomic_xadd32(&sched.npidle, -1);
  }
  return pp;
}
static void mput(omni_m *mp) {
  mp->schedlink = sched.midle;
  sched.midle = mp;
  sched.nmidle++;
}
static omni_m *mget(void) {
  omni_m *mp = sched.midle;
  if (mp != NULL) { sched.midle = mp->schedlink; mp->schedlink = NULL; sched.nmidle--; }
  return mp;
}

/* ---- M 与 P 的交接（proc.go 的 acquirep / releasep / dropg） ---- */
static void acquirep(omni_m *mp, omni_p *pp) {
  if (pp == NULL) throwf("acquirep: NULL p");
  if (pp->m != NULL) throwf("acquirep: p->m != nil");
  if (omni_atomic_load32_relaxed(&pp->status) != OMNI_PIDLE) {
    throwf("acquirep: invalid p state");
  }
  mp->p = pp;
  pp->m = mp;
  omni_atomic_store32_relaxed(&pp->status, OMNI_PRUNNING);
}
static omni_p *releasep(omni_m *mp) {
  omni_p *pp = mp->p;
  if (pp == NULL) throwf("releasep: invalid arg");
  mp->p = NULL;
  pp->m = NULL;
  omni_atomic_store32_relaxed(&pp->status, OMNI_PIDLE);
  return pp;
}
static void dropg(omni_m *mp) {
  if (mp->curg != NULL) mp->curg->m = NULL;
  mp->curg = NULL;
}

static void schedule(omni_m *mp);
static void *m_thread(void *arg);

/* newm（proc.go）：造一条 M 并起一个 OS 线程。M = pthread。 */
static void newm(int spinning, omni_p *pp, int32_t id) {
  omni_m *mp = (omni_m *)calloc(1, sizeof(omni_m));
  mp->id = id;
  mp->spinning = spinning;
  pthread_mutex_init(&mp->park.mu, NULL);
  pthread_cond_init(&mp->park.cv, NULL);
  mp->g0 = (omni_g *)calloc(1, sizeof(omni_g));
  mp->g0->m = mp;
  omni_atomic_store32(&mp->g0->atomicstatus, OMNI_GRUNNING);
  mp->nextp = pp;
  pthread_attr_t at;
  pthread_attr_init(&at);
  pthread_attr_setdetachstate(&at, PTHREAD_CREATE_DETACHED);
  pthread_attr_setstacksize(&at, 1u << 20);
  if (pthread_create(&mp->thread, &at, m_thread, mp) != 0) throwf("newm: pthread_create 失败");
  pthread_attr_destroy(&at);
}

/* stopm（proc.go）：把自己挂进空闲 M 链，睡在 note 上；醒了接住 nextp。 */
static void stopm(omni_m *mp) {
  if (mp->locks != 0) throwf("stopm holding locks");
  if (mp->p != NULL) throwf("stopm holding p");
  if (mp->spinning) throwf("stopm spinning");
  pthread_mutex_lock(&sched.lock);
  mput(mp);
  pthread_mutex_unlock(&sched.lock);
  omni_noteclear(&mp->park);
  omni_notesleep(&mp->park);
  acquirep(mp, mp->nextp);
  mp->nextp = NULL;
}

/* startm（proc.go）：给 pp 找一条 M 去跑。lockheld 那一格我们只有 0 这一种用法。 */
static void startm(omni_p *pp, int spinning) {
  pthread_mutex_lock(&sched.lock);
  if (pp == NULL) {
    if (spinning) throwf("startm: P required for spinning=true");
    pp = pidleget();
    if (pp == NULL) { pthread_mutex_unlock(&sched.lock); return; }
  }
  omni_m *nmp = mget();
  if (nmp == NULL) {
    int32_t id = sched.mnext++;
    pthread_mutex_unlock(&sched.lock);
    newm(spinning, pp, id);
    return;
  }
  pthread_mutex_unlock(&sched.lock);
  if (nmp->spinning) throwf("startm: m is spinning");
  if (nmp->nextp != NULL) throwf("startm: m has p");
  if (spinning && !runqempty(pp)) throwf("startm: p has runnable gs");
  nmp->spinning = spinning;
  nmp->nextp = pp;
  omni_notewakeup(&nmp->park);
}

/* wakep（proc.go）：有活了，看要不要再拉一条 M 起来转。 */
static void wakep(void) {
  if (omni_atomic_loadi32(&sched.nmspinning) != 0
      || !omni_atomic_casi32(&sched.nmspinning, 0, 1)) return;
  pthread_mutex_lock(&sched.lock);
  omni_p *pp = pidleget();
  if (pp == NULL) {
    if (omni_atomic_xadd32(&sched.nmspinning, -1) - 1 < 0) throwf("wakep: negative nmspinning");
    pthread_mutex_unlock(&sched.lock);
    return;
  }
  pthread_mutex_unlock(&sched.lock);
  startm(pp, 1);
}

/* stealWork（proc.go）：四轮；最后一轮才允许偷别人的 runnext。 */
static omni_g *stealWork(omni_m *mp, int *inheritTime) {
  omni_p *pp = mp->p;
  const int stealTries = 4;
  for (int i = 0; i < stealTries; i++) {
    int stealRunNextG = (i == stealTries - 1);
    for (omni_renum e = stealOrderStart(cheaprand()); !renumDone(&e); renumNext(&e)) {
      omni_p *p2 = allp[e.pos];
      if (pp == p2) continue;
      omni_g *gp = runqsteal(pp, p2, stealRunNextG);
      if (gp != NULL) { *inheritTime = 0; return gp; }
    }
  }
  return NULL;
}

/* becomeSpinning / resetspinning（proc.go） */
static void becomeSpinning(omni_m *mp) {
  mp->spinning = 1;
  omni_atomic_xadd32(&sched.nmspinning, 1);
}
static void resetspinning(omni_m *mp) {
  if (!mp->spinning) throwf("resetspinning: not a spinning m");
  mp->spinning = 0;
  if (omni_atomic_xadd32(&sched.nmspinning, -1) - 1 < 0) throwf("findRunnable: negative nmspinning");
  /* M 醒着而有空闲 P ⇒ 再拉一条起来（Go 在这儿就是这一句） */
  if (omni_atomic_loadi32(&sched.npidle) > 0) wakep();
}

/* findRunnable（proc.go）：顺序照抄，GC / trace / netpoll / timer 那几支我们没有（见 .h 偏差 3）。 */
static omni_g *findRunnable(omni_m *mp, int *inheritTime) {
top:;
  omni_p *pp = mp->p;
  if (mp->spinning
      && ((omni_g *)omni_atomic_loadp_relaxed((void *volatile *)&pp->runnext) != NULL
          || omni_atomic_load32_relaxed(&pp->runqhead)
             != omni_atomic_load32_relaxed(&pp->runqtail))) {
    throwf("schedule: spinning with local work");
  }
  /* 每 61 次调度看一眼全局队列 —— 不然本地队列忙起来会把全局那些饿死。 */
  if (pp->schedtick % 61 == 0 && sched.runqsize > 0) {
    pthread_mutex_lock(&sched.lock);
    omni_g *gp = globrunqget(pp, 1);
    pthread_mutex_unlock(&sched.lock);
    if (gp != NULL) { *inheritTime = 0; return gp; }
  }
  { omni_g *gp = runqget(pp, inheritTime); if (gp != NULL) return gp; }
  if (sched.runqsize > 0) {
    pthread_mutex_lock(&sched.lock);
    omni_g *gp = globrunqget(pp, 0);
    pthread_mutex_unlock(&sched.lock);
    if (gp != NULL) { *inheritTime = 0; return gp; }
  }
  if (mp->spinning
      || 2 * omni_atomic_loadi32(&sched.nmspinning) < gomaxprocs - omni_atomic_loadi32(&sched.npidle)) {
    if (!mp->spinning) becomeSpinning(mp);
    omni_g *gp = stealWork(mp, inheritTime);
    if (gp != NULL) return gp;
  }
  /* 真没活了：放掉 P、把自己停下来。醒了从头再找。 */
  if (omni_atomic_loadi32(&mainDone)) return NULL;
  pthread_mutex_lock(&sched.lock);
  if (sched.runqsize != 0) {
    omni_g *gp = globrunqget(pp, 0);
    pthread_mutex_unlock(&sched.lock);
    if (gp != NULL) { *inheritTime = 0; return gp; }
  } else {
    pthread_mutex_unlock(&sched.lock);
  }
  if (mp->spinning) {
    mp->spinning = 0;
    if (omni_atomic_xadd32(&sched.nmspinning, -1) - 1 < 0) throwf("findRunnable: negative nmspinning");
  }
  pthread_mutex_lock(&sched.lock);
  omni_p *rp = releasep(mp);
  pidleput(rp);
  pthread_mutex_unlock(&sched.lock);
  stopm(mp);
  goto top;
}

/* ---- g 的回收（proc.go 的 gfput / gfget；Go 是每个 P 一条链 + 全局一条，
 *      我们先只做全局那条，多一把锁，少一处出错的地方） ---- */
static omni_g *gfget(void) {
  pthread_mutex_lock(&sched.lock);
  omni_g *gp = sched.gfree;
  if (gp != NULL) sched.gfree = gp->schedlink;
  pthread_mutex_unlock(&sched.lock);
  if (gp != NULL) { gp->schedlink = NULL; return gp; }
  gp = (omni_g *)calloc(1, sizeof(omni_g));
  void *st = NULL;
  if (posix_memalign(&st, 16, OMNI_G_STACK) != 0) throwf("gfget: 栈分不出来");
  gp->stack = (char *)st;
  gp->stacksize = OMNI_G_STACK;
  omni_atomic_store32(&gp->atomicstatus, OMNI_GIDLE);
  return gp;
}
static void gfput(omni_g *gp) {
  gp->fnptr = NULL; gp->arg = NULL; gp->waiting = NULL; gp->param = NULL;
  omni_atomic_store32(&gp->selectDone, 0);
  pthread_mutex_lock(&sched.lock);
  gp->schedlink = sched.gfree;
  sched.gfree = gp;
  pthread_mutex_unlock(&sched.lock);
}

/* ---- execute / schedule / 切回来之后那三件事 ---- */
static void execute(omni_m *mp, omni_g *gp, int inheritTime) {
  mp->curg = gp;
  gp->m = mp;
  casgstatus(gp, OMNI_GRUNNABLE, OMNI_GRUNNING);
  if (!inheritTime) mp->p->schedtick++;
  tls_g = gp;
  omni_sctx_sw(&mp->g0->sched.sp, gp->sched.sp);   /* = Go 的 gogo(&gp.sched) */
  tls_g = mp->g0;
}

/* park_m（proc.go）。回 1 = waitunlockf 说"别挂"，这条 g 要马上接着跑
   （Go 那儿是 `execute(gp, true)` 且不返回，我们只能把它交回调度循环）。 */
static int park_m(omni_m *mp, omni_g *gp) {
  casgstatus(gp, OMNI_GRUNNING, OMNI_GWAITING);
  dropg(mp);
  int (*fn)(omni_g *, void *) = mp->waitunlockf;
  if (fn != NULL) {
    int ok = fn(gp, mp->waitlock);
    mp->waitunlockf = NULL;
    mp->waitlock = NULL;
    if (!ok) {
      casgstatus(gp, OMNI_GWAITING, OMNI_GRUNNABLE);
      return 1;
    }
  }
  return 0;
}

/* goschedImpl（proc.go）：让出 —— 状态回 runnable，扔进**全局**队列
   （Go 就是扔全局的，理由是别让它在本地队列里插队）。 */
static void gosched_m(omni_m *mp, omni_g *gp) {
  casgstatus(gp, OMNI_GRUNNING, OMNI_GRUNNABLE);
  dropg(mp);
  pthread_mutex_lock(&sched.lock);
  globrunqput(gp);
  pthread_mutex_unlock(&sched.lock);
}

/* goexit0（proc.go）：g 跑完了。主 goroutine 一结束整个程序就结束（Go 的 main 也是）。 */
static void goexit0(omni_m *mp, omni_g *gp) {
  casgstatus(gp, OMNI_GRUNNING, OMNI_GDEAD);
  dropg(mp);
  int isMain = (gp == maing);
  gfput(gp);
  if (isMain) {
    omni_atomic_storei32(&mainDone, 1);
    omni_notewakeup(&mainDoneNote);
  }
}

static void schedule(omni_m *mp) {
  omni_g *pending = NULL;
  int pendingInherit = 0;
  for (;;) {
    omni_g *gp;
    int inheritTime = 0;
    if (pending != NULL) { gp = pending; inheritTime = pendingInherit; pending = NULL; }
    else {
      gp = findRunnable(mp, &inheritTime);
      if (gp == NULL) return;                  /* mainDone：收摊 */
      if (mp->spinning) resetspinning(mp);
    }
    execute(mp, gp, inheritTime);
    switch (mp->switchreason) {
      case OMNI_SW_PARK:
        if (park_m(mp, gp)) { pending = gp; pendingInherit = 1; }
        break;
      case OMNI_SW_YIELD: gosched_m(mp, gp); break;
      case OMNI_SW_DEAD:  goexit0(mp, gp); break;
      default: throwf("schedule: 从 g 切回来的理由不明");
    }
    if (omni_atomic_loadi32(&mainDone)) return;
  }
}

/* ---- g 的入口：跳板落到这儿（对应 Go 的 goexit 那一层包装） ---- */
void omni_g_main(omni_g *gp) {
  gp->fnptr(gp->arg);
  omni_m *mp = gp->m;
  mp->switchreason = OMNI_SW_DEAD;
  omni_sctx_sw(&gp->sched.sp, mp->g0->sched.sp);
  __builtin_trap();                   /* 死了的 g 不会被切回来 */
}

/* newproc（proc.go）：造一条 g、摆好它的假保存帧、扔进当前 P 的队列、拉一条 M。 */
static omni_g *newproc1(void (*fn)(void *), void *arg) {
  omni_g *newg = gfget();
  newg->fnptr = fn;
  newg->arg = arg;
  newg->goid = omni_atomic_xadd64(&sched.goidgen, 1) + 1;
  /* 假保存帧：偏移照上面那段 asm —— x19 在 +0x00、x30(lr) 在 +0x58。 */
  char *top = newg->stack + newg->stacksize;
  top -= 0xa0;
  memset(top, 0, 0xa0);
  ((void **)top)[0] = newg;                        /* x19 槽：g 自己 */
  ((void **)top)[11] = (void *)omni_g_entry;       /* x30 槽：第一次 ret 落到跳板 */
  newg->sched.sp = top;
  omni_atomic_store32(&newg->atomicstatus, OMNI_GRUNNABLE);
  return newg;
}

void omni_newproc(void (*fn)(void *), void *arg) {
  omni_g *newg = newproc1(fn, arg);
  omni_g *cur = tls_g;
  omni_m *mp = (cur != NULL) ? cur->m : NULL;
  if (mp == NULL || mp->p == NULL) throwf("newproc: 还没 omni_sched_init");
  runqput(mp->p, newg, 1);
  wakep();
}

/* ---- gopark / goready / Gosched ---- */
void omni_gopark(int (*unlockf)(omni_g *, void *), void *lock, uint32_t reason) {
  (void)reason;
  omni_g *gp = tls_g;
  omni_m *mp = gp->m;
  if (readgstatus(gp) != OMNI_GRUNNING) throwf("gopark: bad g status");
  mp->waitlock = lock;
  mp->waitunlockf = unlockf;
  mp->switchreason = OMNI_SW_PARK;
  omni_sctx_sw(&gp->sched.sp, mp->g0->sched.sp);   /* = mcall(park_m) */
}

void omni_goready(omni_g *gp, int next) {
  if (readgstatus(gp) != OMNI_GWAITING) throwf("bad g->status in ready");
  casgstatus(gp, OMNI_GWAITING, OMNI_GRUNNABLE);
  omni_g *cur = tls_g;
  omni_m *mp = cur->m;
  runqput(mp->p, gp, next);
  wakep();
}

void omni_gosched(void) {
  omni_g *gp = tls_g;
  omni_m *mp = gp->m;
  mp->switchreason = OMNI_SW_YIELD;
  omni_sctx_sw(&gp->sched.sp, mp->g0->sched.sp);   /* = mcall(gosched_m) */
}

omni_g *omni_getg(void) { return tls_g; }
int32_t omni_gomaxprocs(void) { return gomaxprocs; }

/* ---- M 的线程入口（proc.go 的 mstart / mstart1） ---- */
static void *m_thread(void *arg) {
  omni_m *mp = (omni_m *)arg;
  tls_g = mp->g0;
  /* mp->spinning 由 newm/startm 设好，nmspinning 的计数在 wakep 里已经加过 —— 
     Go 的 mspinning 也只是 `getg().m.spinning = true`，不再动计数。 */
  acquirep(mp, mp->nextp);
  mp->nextp = NULL;
  schedule(mp);
  return NULL;
}

/* ---- sudog 的取还（proc.go 的 acquireSudog / releaseSudog；Go 是每个 P 一格缓存
 *      加一条全局链，我们先只做全局那条） ---- */
static omni_sudog *sudogfree;
omni_sudog *omni_acquireSudog(void) {
  pthread_mutex_lock(&sched.lock);
  omni_sudog *s = sudogfree;
  if (s != NULL) sudogfree = s->next;
  pthread_mutex_unlock(&sched.lock);
  if (s == NULL) s = (omni_sudog *)calloc(1, sizeof(omni_sudog));
  else memset(s, 0, sizeof(omni_sudog));
  return s;
}
void omni_releaseSudog(omni_sudog *s) {
  if (s->elem != NULL) throwf("runtime: sudog with non-nil elem");
  if (s->isSelect) throwf("runtime: sudog with non-false isSelect");
  if (s->next != NULL || s->prev != NULL) throwf("runtime: sudog with non-nil next/prev");
  if (s->c != NULL) throwf("runtime: sudog with non-nil c");
  if (s->g == NULL) throwf("runtime: sudog with nil g");
  s->g = NULL;
  pthread_mutex_lock(&sched.lock);
  s->next = sudogfree;
  sudogfree = s;
  pthread_mutex_unlock(&sched.lock);
}

/* ---- 起摊子（proc.go 的 schedinit + procresize） ---- */
int32_t omni_numcpu(void) {
  if (numcpu_cached == 0) {
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    numcpu_cached = (n > 0) ? (int32_t)n : 1;
  }
  return numcpu_cached;
}

static omni_m *m0;

void omni_sched_init(int32_t nprocs) {
  if (allp != NULL) return;                     /* 只起一次 */
  pthread_mutex_init(&sched.lock, NULL);
  pthread_mutex_init(&mainDoneNote.mu, NULL);
  pthread_cond_init(&mainDoneNote.cv, NULL);
  if (nprocs <= 0) nprocs = omni_numcpu();
  gomaxprocs = nprocs;
  allp = (omni_p **)calloc((size_t)nprocs, sizeof(omni_p *));
  for (int32_t i = 0; i < nprocs; i++) {
    omni_p *pp = (omni_p *)calloc(1, sizeof(omni_p));
    pp->id = i;
    omni_atomic_store32(&pp->status, OMNI_PIDLE);
    allp[i] = pp;
  }
  stealOrderReset((uint32_t)nprocs);
  /* m0 = 当前这条 OS 线程。它的 g0 用**线程自己的栈**（stack = NULL）。 */
  m0 = (omni_m *)calloc(1, sizeof(omni_m));
  m0->id = 0;
  sched.mnext = 1;
  pthread_mutex_init(&m0->park.mu, NULL);
  pthread_cond_init(&m0->park.cv, NULL);
  m0->g0 = (omni_g *)calloc(1, sizeof(omni_g));
  m0->g0->m = m0;
  omni_atomic_store32(&m0->g0->atomicstatus, OMNI_GRUNNING);
  tls_g = m0->g0;
  /* **全部 P 一上来都挂在 pidle 上**，m0 不占 P。见下面 omni_sched_main 那段账。 */
  for (int32_t i = 0; i < nprocs; i++) pidleput(allp[i]);
}

/**
 * 跑主 goroutine，等它结束再回来。
 *
 * **与 Go 的一处形状差别**（刻意的，理由在这儿）：Go 的 m0 自己就跑 main，main 一 return
 * 就 `exit(0)` —— 整个进程结束，不必"回到调用方"。我们是嵌在别人的 `main()` 里的一格
 * 运行时，必须能回去，于是 m0 这条线程只当**等待者**：主 g 扔进全局队列、`wakep()` 拉一条
 * M 起来跑，m0 睡在 `mainDoneNote` 上。
 *
 * 为什么不让 m0 也去跑调度：主 g 完全可能在**另一条 M** 上结束（它 park 过一次就会换 M），
 * 那时 m0 正睡在 `stopm` 的 note 上 —— 而 note 是一次性的，`noteclear` 与 `notesleep`
 * 之间来的那一次唤醒会丢，m0 就永远醒不过来。少一条能干活的线程，换掉整类竞态。
 */
void omni_sched_main(void (*fn)(void *), void *arg) {
  if (allp == NULL) omni_sched_init(0);
  if (maing != NULL) throwf("omni_sched_main 只能调一次（主 g 一结束整个调度器就收摊，与 Go 的 main 一样）");
  omni_g *newg = newproc1(fn, arg);
  maing = newg;
  pthread_mutex_lock(&sched.lock);
  globrunqput(newg);
  pthread_mutex_unlock(&sched.lock);
  omni_noteclear(&mainDoneNote);
  wakep();
  omni_notesleep(&mainDoneNote);
}

