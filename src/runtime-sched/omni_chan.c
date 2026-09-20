/* omni_chan.c —— 见 omni_chan.h 顶上那段对应关系。 */

#include "omni_chan.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "omni_atomic.h"
#include <alloca.h>

static void chanthrow(const char *s) {
  fprintf(stderr, "omni chan: %s\n", s);
  abort();
}

/* ---- waitq（chan.go 的 enqueue / dequeue） ---- */
static void waitq_enqueue(omni_waitq *q, omni_sudog *sgp) {
  sgp->next = NULL;
  omni_sudog *x = q->last;
  if (x == NULL) { sgp->prev = NULL; q->first = sgp; q->last = sgp; return; }
  sgp->prev = x;
  x->next = sgp;
  q->last = sgp;
}

static omni_sudog *waitq_dequeue(omni_waitq *q) {
  for (;;) {
    omni_sudog *sgp = q->first;
    if (sgp == NULL) return NULL;
    omni_sudog *y = sgp->next;
    if (y == NULL) { q->first = NULL; q->last = NULL; }
    else { y->prev = NULL; q->first = y; sgp->next = NULL; }
    /* select 的那一格：被别的 case 叫醒过的话这条 g 已经不算在队列里了 —— 
       靠 g.selectDone 的 CAS 抢，抢不到就跳过（chan.go 里那段注释的同一件事）。 */
    if (sgp->isSelect) {
      /* CAS 的 old 传值（见 omni_atomic.h）—— 不再需要一格 zero 变量 */
      if (!omni_atomic_cas32(&sgp->g->selectDone, 0, 1)) continue;
    }
    return sgp;
  }
}

/* ---- 环上第 i 格的地址（chan.go 的 chanbuf） ---- */
static void *chanbuf(omni_hchan *c, size_t i) { return c->buf + (size_t)c->elemsize * i; }

/* full / empty（chan.go）：不持锁时的**快判**，只用来在 block=0 的路上早退。 */
static int chan_full(omni_hchan *c) {
  if (c->dataqsiz == 0) return c->recvq.first == NULL;
  return c->qcount == c->dataqsiz;
}
static int chan_empty(omni_hchan *c) {
  if (c->dataqsiz == 0) return c->sendq.first == NULL;
  return c->qcount == 0;
}

omni_hchan *omni_makechan(uint16_t elemsize, int64_t size) {
  if (size < 0) chanthrow("makechan: size out of range");
  omni_hchan *c = (omni_hchan *)calloc(1, sizeof(omni_hchan));
  c->elemsize = elemsize;
  c->dataqsiz = (size_t)size;
  if (size > 0 && elemsize > 0) c->buf = (char *)calloc((size_t)size, elemsize);
  pthread_mutex_init(&c->lock, NULL);
  return c;
}

size_t omni_chanlen(omni_hchan *c) { return c == NULL ? 0 : c->qcount; }
size_t omni_chancap(omni_hchan *c) { return c == NULL ? 0 : c->dataqsiz; }

/* gopark 的 unlockf（chan.go 的 chanparkcommit）：把 channel 的锁放掉。 */
static int chanparkcommit(omni_g *gp, void *chanLock) {
  (void)gp;
  pthread_mutex_unlock((pthread_mutex_t *)chanLock);
  return 1;
}

/* send / recv（chan.go）拆成"持锁时搬值"与"解锁后叫醒"两段。
 *
 * 为什么要拆：Go 的 `send`/`recv` 把 `unlockf()` 当实参递进去，因为**调用它的两处
 * （chansend 与 selectgo）要解的锁不是同一把** —— selectgo 手里攥着一串 channel 的锁。
 * C 里没必要造闭包：搬值这一段在持锁时做（与 Go 的 sendDirect/recvDirect 位置一样），
 * 解锁与 `goready` 交回调用方。次序也照 Go：**先解锁，再写 param/success，再 goready**。
 */
static void chan_send_copy(omni_hchan *c, omni_sudog *sg, void *ep) {
  if (sg->elem != NULL) {
    if (c->elemsize > 0) memcpy(sg->elem, ep, c->elemsize);
    sg->elem = NULL;
  }
}

/* 有缓冲时要按 Go 那样**先把环里最老的一格交给收方、再把发方的值放进那一格**
   （环因此保序，sendx 跟着 recvx 走）。 */
static void chan_recv_copy(omni_hchan *c, omni_sudog *sg, void *ep) {
  if (c->dataqsiz == 0) {
    if (ep != NULL && c->elemsize > 0) memcpy(ep, sg->elem, c->elemsize);
  } else {
    void *qp = chanbuf(c, c->recvx);
    if (ep != NULL && c->elemsize > 0) memcpy(ep, qp, c->elemsize);
    if (c->elemsize > 0) memcpy(qp, sg->elem, c->elemsize);
    c->recvx++;
    if (c->recvx == c->dataqsiz) c->recvx = 0;
    c->sendx = c->recvx;
  }
  sg->elem = NULL;
}

/* 解锁之后把对面叫醒（Go 的 send/recv 尾巴那三句）。 */
static void chan_handoff_ready(omni_sudog *sg) {
  omni_g *gp = sg->g;
  gp->param = sg;
  sg->success = 1;
  omni_goready(gp, 1);
}

/* ---- chansend（chan.go）：三条路 —— 直接交手 / 进环 / 挂起 ---- */
int omni_chansend(omni_hchan *c, void *ep, int block) {
  if (c == NULL) {
    if (!block) return 0;
    omni_gopark(NULL, NULL, 0);          /* 往 nil channel 发 = 永远挂着 */
    chanthrow("unreachable");
  }
  /* 不阻塞那一路的快判：没关、而且满 ⇒ 直接说没成（不加锁） */
  if (!block && c->closed == 0 && chan_full(c)) return 0;

  pthread_mutex_lock(&c->lock);
  if (c->closed != 0) {
    pthread_mutex_unlock(&c->lock);
    chanthrow("send on closed channel");
  }
  omni_sudog *sg = waitq_dequeue(&c->recvq);
  if (sg != NULL) {
    chan_send_copy(c, sg, ep);
    pthread_mutex_unlock(&c->lock);
    chan_handoff_ready(sg);
    return 1;
  }

  if (c->qcount < c->dataqsiz) {
    void *qp = chanbuf(c, c->sendx);
    if (c->elemsize > 0) memcpy(qp, ep, c->elemsize);
    c->sendx++;
    if (c->sendx == c->dataqsiz) c->sendx = 0;
    c->qcount++;
    pthread_mutex_unlock(&c->lock);
    return 1;
  }
  if (!block) { pthread_mutex_unlock(&c->lock); return 0; }

  omni_g *gp = omni_getg();
  omni_sudog *mysg = omni_acquireSudog();
  mysg->elem = ep;
  mysg->waitlink = NULL;
  mysg->g = gp;
  mysg->isSelect = 0;
  mysg->c = c;
  gp->waiting = mysg;
  gp->param = NULL;
  waitq_enqueue(&c->sendq, mysg);
  omni_gopark(chanparkcommit, &c->lock, 0);
  /* 醒了：`success` 说明是真发出去了还是被 close 叫醒的 */
  if (mysg != gp->waiting) chanthrow("G waiting list is corrupted");
  gp->waiting = NULL;
  int closed = !mysg->success;
  gp->param = NULL;
  mysg->c = NULL;
  mysg->elem = NULL;
  omni_releaseSudog(mysg);
  if (closed) {
    if (c->closed == 0) chanthrow("chansend: spurious wakeup");
    chanthrow("send on closed channel");
  }
  return 1;
}

/* ---- chanrecv（chan.go） ---- */
int omni_chanrecv(omni_hchan *c, void *ep, int block, int *received) {
  if (received != NULL) *received = 0;
  if (c == NULL) {
    if (!block) return 0;
    omni_gopark(NULL, NULL, 0);
    chanthrow("unreachable");
  }
  /* 不阻塞那一路的快判（chan.go 里那段两次读 closed 的账：先看空、再看关） */
  if (!block && chan_empty(c)) {
    if (omni_atomic_load32(&c->closed) == 0) return 0;
    if (chan_empty(c)) {
      if (ep != NULL && c->elemsize > 0) memset(ep, 0, c->elemsize);
      return 1;
    }
  }

  pthread_mutex_lock(&c->lock);
  if (c->closed != 0) {
    if (c->qcount == 0) {
      pthread_mutex_unlock(&c->lock);
      if (ep != NULL && c->elemsize > 0) memset(ep, 0, c->elemsize);
      return 1;                        /* selected = 1、received = 0 */
    }
    /* 关了但环里还有货：照常收 */
  } else {
    omni_sudog *sg = waitq_dequeue(&c->sendq);
    if (sg != NULL) {
      chan_recv_copy(c, sg, ep);
      pthread_mutex_unlock(&c->lock);
      chan_handoff_ready(sg);
      if (received != NULL) *received = 1;
      return 1;
    }
  }
  if (c->qcount > 0) {
    void *qp = chanbuf(c, c->recvx);
    if (ep != NULL && c->elemsize > 0) memcpy(ep, qp, c->elemsize);
    if (c->elemsize > 0) memset(qp, 0, c->elemsize);
    c->recvx++;
    if (c->recvx == c->dataqsiz) c->recvx = 0;
    c->qcount--;
    pthread_mutex_unlock(&c->lock);
    if (received != NULL) *received = 1;
    return 1;
  }
  if (!block) { pthread_mutex_unlock(&c->lock); return 0; }

  omni_g *gp = omni_getg();
  omni_sudog *mysg = omni_acquireSudog();
  mysg->elem = ep;
  mysg->waitlink = NULL;
  mysg->g = gp;
  mysg->isSelect = 0;
  mysg->c = c;
  gp->waiting = mysg;
  gp->param = NULL;
  waitq_enqueue(&c->recvq, mysg);
  omni_gopark(chanparkcommit, &c->lock, 0);
  if (mysg != gp->waiting) chanthrow("G waiting list is corrupted");
  gp->waiting = NULL;
  int success = mysg->success;
  gp->param = NULL;
  mysg->c = NULL;
  mysg->elem = NULL;
  omni_releaseSudog(mysg);
  if (received != NULL) *received = success;
  return 1;
}

/* ---- closechan（chan.go）：两条等待队列全叫醒，success = 0 ---- */
void omni_closechan(omni_hchan *c) {
  if (c == NULL) chanthrow("close of nil channel");
  pthread_mutex_lock(&c->lock);
  if (c->closed != 0) {
    pthread_mutex_unlock(&c->lock);
    chanthrow("close of closed channel");
  }
  c->closed = 1;
  /* 先把两条队列摘成一条本地链，**解锁之后**才 goready —— chan.go 里那段
     "别在持 hchan.lock 的时候改别的 g 的状态"的规矩。 */
  omni_g *glist = NULL;
  for (;;) {
    omni_sudog *sg = waitq_dequeue(&c->recvq);
    if (sg == NULL) break;
    if (sg->elem != NULL) {
      if (c->elemsize > 0) memset(sg->elem, 0, c->elemsize);
      sg->elem = NULL;
    }
    omni_g *gp = sg->g;
    gp->param = sg;
    sg->success = 0;
    gp->schedlink = glist;
    glist = gp;
  }
  for (;;) {
    omni_sudog *sg = waitq_dequeue(&c->sendq);
    if (sg == NULL) break;
    sg->elem = NULL;
    omni_g *gp = sg->g;
    gp->param = sg;
    sg->success = 0;
    gp->schedlink = glist;
    glist = gp;
  }
  pthread_mutex_unlock(&c->lock);
  while (glist != NULL) {
    omni_g *gp = glist;
    glist = gp->schedlink;
    gp->schedlink = NULL;
    omni_goready(gp, 1);
  }
}

/* dequeueSudoG（chan.go）：把一条 sudog 从队列里摘掉。
   x == y == NULL 有两种可能 —— 它是队列里唯一一个，或者**已经被别人摘走了**；
   靠 q->first 分辨。少这一问会把队列改坏（Go 那段注释写着同一件事）。 */
static void waitq_dequeueSudoG(omni_waitq *q, omni_sudog *sgp) {
  omni_sudog *x = sgp->prev, *y = sgp->next;
  if (x != NULL) {
    if (y != NULL) { x->next = y; y->prev = x; sgp->next = NULL; sgp->prev = NULL; return; }
    x->next = NULL; q->last = x; sgp->prev = NULL; return;
  }
  if (y != NULL) { y->prev = NULL; q->first = y; sgp->next = NULL; return; }
  if (q->first == sgp) { q->first = NULL; q->last = NULL; }
}

/* ---- select（select.go 的 selectgo） ----
 *
 * 三样东西照抄：
 *   - **pollorder**：随机排列（不然总是第一格中，饿死后面的）；
 *   - **lockorder**：按 channel 地址排序后加锁（不然两个 select 交叉加锁会死锁）；
 *   - 挂起那一路：给每一格开一条 sudog 串成 `g.waiting`，醒来靠 `g.param` 认出
 *     是哪一格中的，别的几格逐个摘掉。抢唤醒靠 `sudog.isSelect` + `g.selectDone`
 *     的 CAS（`waitq_dequeue` 里那一段）。
 */
static int selparkcommit(omni_g *gp, void *unused) {
  (void)unused;
  omni_hchan *lastc = NULL;
  for (omni_sudog *sg = gp->waiting; sg != NULL; sg = sg->waitlink) {
    if (sg->c != lastc && lastc != NULL) pthread_mutex_unlock(&lastc->lock);
    lastc = (omni_hchan *)sg->c;
  }
  if (lastc != NULL) pthread_mutex_unlock(&lastc->lock);
  return 1;
}

int omni_selectgo(omni_scase *cases, int ncases, int *recvOK) {
  if (recvOK != NULL) *recvOK = 0;
  int ndefault = -1;
  int n = 0;
  int *pollorder = (int *)alloca(sizeof(int) * (size_t)(ncases > 0 ? ncases : 1));
  int *lockorder = (int *)alloca(sizeof(int) * (size_t)(ncases > 0 ? ncases : 1));
  for (int i = 0; i < ncases; i++) {
    if (cases[i].kind == OMNI_SELECT_DEFAULT) { ndefault = i; continue; }
    if (cases[i].c == NULL) continue;            /* nil channel 那一格永远不就绪 */
    pollorder[n++] = i;
  }
  if (n == 0 && ndefault < 0) {                  /* select{} / 全是 nil ⇒ 永远挂着 */
    omni_gopark(NULL, NULL, 0);
    chanthrow("unreachable");
  }
  /* pollorder：Fisher-Yates（select.go 里那一段） */
  for (int i = n - 1; i > 0; i--) {
    uint32_t r = (uint32_t)rand() % (uint32_t)(i + 1);
    int t = pollorder[i]; pollorder[i] = pollorder[r]; pollorder[r] = t;
  }
  /* lockorder：按 channel 地址排序（插入排序，n 一般只有两三格） */
  for (int i = 0; i < n; i++) lockorder[i] = pollorder[i];
  for (int i = 1; i < n; i++) {
    int k = lockorder[i], j = i - 1;
    while (j >= 0 && (uintptr_t)cases[lockorder[j]].c > (uintptr_t)cases[k].c) {
      lockorder[j + 1] = lockorder[j]; j--;
    }
    lockorder[j + 1] = k;
  }
  /* 加锁：同一个 channel 出现两次只锁一次 */
  omni_hchan *prev = NULL;
  for (int i = 0; i < n; i++) {
    omni_hchan *c = cases[lockorder[i]].c;
    if (c != prev) pthread_mutex_lock(&c->lock);
    prev = c;
  }
  #define SELUNLOCK() do { omni_hchan *p_ = NULL; \
    for (int i_ = n - 1; i_ >= 0; i_--) { omni_hchan *c_ = cases[lockorder[i_]].c; \
      if (c_ != p_) pthread_mutex_unlock(&c_->lock); p_ = c_; } } while (0)

  /* ---- 第一趟：有谁现在就能成吗 ---- */
  for (int k = 0; k < n; k++) {
    int casi = pollorder[k];
    omni_scase *cas = &cases[casi];
    omni_hchan *c = cas->c;
    if (cas->kind == OMNI_SELECT_RECV) {
      omni_sudog *sg = waitq_dequeue(&c->sendq);
      if (sg != NULL) {
        chan_recv_copy(c, sg, cas->elem);
        SELUNLOCK();
        chan_handoff_ready(sg);
        if (recvOK != NULL) *recvOK = 1;
        return casi;
      }
      if (c->qcount > 0) {
        void *qp = chanbuf(c, c->recvx);
        if (cas->elem != NULL && c->elemsize > 0) memcpy(cas->elem, qp, c->elemsize);
        if (c->elemsize > 0) memset(qp, 0, c->elemsize);
        c->recvx++;
        if (c->recvx == c->dataqsiz) c->recvx = 0;
        c->qcount--;
        SELUNLOCK();
        if (recvOK != NULL) *recvOK = 1;
        return casi;
      }
      if (c->closed != 0) {
        if (cas->elem != NULL && c->elemsize > 0) memset(cas->elem, 0, c->elemsize);
        SELUNLOCK();
        return casi;                        /* recvOK = 0 */
      }
    } else {
      if (c->closed != 0) { SELUNLOCK(); chanthrow("send on closed channel"); }
      omni_sudog *sg = waitq_dequeue(&c->recvq);
      if (sg != NULL) {
        chan_send_copy(c, sg, cas->elem);
        SELUNLOCK();
        chan_handoff_ready(sg);
        return casi;
      }
      if (c->qcount < c->dataqsiz) {
        void *qp = chanbuf(c, c->sendx);
        if (c->elemsize > 0) memcpy(qp, cas->elem, c->elemsize);
        c->sendx++;
        if (c->sendx == c->dataqsiz) c->sendx = 0;
        c->qcount++;
        SELUNLOCK();
        return casi;
      }
    }
  }
  if (ndefault >= 0) { SELUNLOCK(); return ndefault; }

  /* ---- 第二趟：每一格挂一条 sudog，然后挂起 ---- */
  omni_g *gp = omni_getg();
  gp->waiting = NULL;
  omni_sudog **nextp = &gp->waiting;
  for (int i = 0; i < n; i++) {
    int casi = lockorder[i];
    omni_scase *cas = &cases[casi];
    omni_hchan *c = cas->c;
    omni_sudog *sg = omni_acquireSudog();
    sg->g = gp;
    sg->isSelect = 1;
    sg->elem = cas->elem;
    sg->c = c;
    sg->caseIndex = (uint16_t)casi;
    *nextp = sg;
    nextp = &sg->waitlink;
    if (cas->kind == OMNI_SELECT_SEND) waitq_enqueue(&c->sendq, sg);
    else waitq_enqueue(&c->recvq, sg);
  }
  gp->param = NULL;
  omni_gopark(selparkcommit, NULL, 0);     /* selparkcommit 会把那几把锁全放掉 */

  /* ---- 第三趟：醒了，认出中的那一格，别的摘掉 ---- */
  prev = NULL;
  for (int i = 0; i < n; i++) {
    omni_hchan *c = cases[lockorder[i]].c;
    if (c != prev) pthread_mutex_lock(&c->lock);
    prev = c;
  }
  omni_sudog *winner = (omni_sudog *)gp->param;
  omni_atomic_store32(&gp->selectDone, 0);
  int casi = -1;
  int ok = 0;
  omni_sudog *sglist = gp->waiting;
  gp->waiting = NULL;
  while (sglist != NULL) {
    omni_sudog *next = sglist->waitlink;
    omni_hchan *c = (omni_hchan *)sglist->c;
    if (sglist == winner) {
      casi = (int)sglist->caseIndex;
      ok = sglist->success;
    } else {
      if (cases[sglist->caseIndex].kind == OMNI_SELECT_SEND) waitq_dequeueSudoG(&c->sendq, sglist);
      else waitq_dequeueSudoG(&c->recvq, sglist);
    }
    sglist->waitlink = NULL;
    sglist->isSelect = 0;
    sglist->elem = NULL;
    sglist->c = NULL;
    omni_releaseSudog(sglist);
    sglist = next;
  }
  SELUNLOCK();
  gp->param = NULL;
  if (casi < 0) chanthrow("selectgo: bad wakeup");
  if (cases[casi].kind == OMNI_SELECT_SEND && !ok) chanthrow("send on closed channel");
  if (recvOK != NULL) *recvOK = ok;
  return casi;
  #undef SELUNLOCK
}

