/* omni_chan.h —— channel，**照 go/src/runtime/chan.go 严格实现**。
 *
 * 对应关系：
 *   hchan / waitq / waitq.enqueue / waitq.dequeue（含 isSelect 抢唤醒那一格）
 *   makechan / chansend / chanrecv / send / recv / closechan / full / empty / chanbuf
 *   select.go 的 selectgo（乱序加锁 + 两趟轮询）
 *
 * 一处偏差：Go 搬值靠 `typedmemmove(elemtype, …)`（带 GC 写屏障），我们没有 GC，
 * 所以是按 `elemsize` 的 `memcpy`。语义一样（Go 在没有指针的元素上也就是 memmove）。
 */
#ifndef OMNI_CHAN_H
#define OMNI_CHAN_H

#include <stddef.h>
#include <stdint.h>
#include <pthread.h>
#include "omni_sched.h"

typedef struct { omni_sudog *first, *last; } omni_waitq;

typedef struct omni_hchan {
  size_t qcount;                  /* 环里现在有几个 */
  size_t dataqsiz;                /* 环有几格（0 = 无缓冲） */
  char *buf;                      /* dataqsiz * elemsize 的一块 */
  uint16_t elemsize;
  uint32_t closed;
  size_t sendx, recvx;            /* 环的写/读下标 */
  omni_waitq recvq, sendq;        /* 等着收 / 等着发的那些 g */
  pthread_mutex_t lock;           /* 护住上面全部字段，以及挂在它上面那些 sudog 的几格 */
} omni_hchan;

omni_hchan *omni_makechan(uint16_t elemsize, int64_t size);
/* block = 0 ⇒ 不阻塞（select 的 case 与 `v, ok := <-c` 那种）。回 1 = 成功。 */
int omni_chansend(omni_hchan *c, void *ep, int block);
/* 回 `selected`；`*received` 是 `v, ok := <-c` 里那个 ok。ep 可以是 NULL（丢掉那个值）。 */
int omni_chanrecv(omni_hchan *c, void *ep, int block, int *received);
void omni_closechan(omni_hchan *c);
size_t omni_chanlen(omni_hchan *c);
size_t omni_chancap(omni_hchan *c);

/* ---- select（select.go 的 selectgo） ---- */
#define OMNI_SELECT_SEND    0
#define OMNI_SELECT_RECV    1
#define OMNI_SELECT_DEFAULT 2

typedef struct {
  omni_hchan *c;
  void *elem;                     /* 发：要发的值；收：收到哪儿（可 NULL） */
  uint16_t kind;                  /* OMNI_SELECT_* */
} omni_scase;

/* 回选中的那一格下标（default 那一格也算）；`*recvOK` 是收那一路的 ok。 */
int omni_selectgo(omni_scase *cases, int ncases, int *recvOK);

#endif /* OMNI_CHAN_H */
