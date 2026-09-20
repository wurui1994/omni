/* omni_go.c —— `omni_go.h` 那几个口的实现（见那儿的三条理由）。 */
#include "omni_go.h"

#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "omni_chan.h"
#include "omni_sched.h"

/* 方言的函数值：一格**闭包对象**，第 0 格是代码地址
   （`src/runtime/omni.h:157-159` 的 `struct omni_closure_s`）。
   调用约定也照那儿：`fp(self, 实参…)`（`src/core/backend-c/emit.js` 的 `omni_call_*`
   发的就是 `((RET (*)(omni_fn, …))f->fp)(f, …)`）。
   **那两处改了这儿要跟着改** —— 这一格是两边约定的唯一接缝。 */
typedef struct { void (*fp)(void); } omni_goclos;

typedef void (*omni_go_fn0)(void *);
typedef void (*omni_go_fn1)(void *, int64_t);
typedef void (*omni_go_fn2)(void *, int64_t, int64_t);
typedef void (*omni_go_fn3)(void *, int64_t, int64_t, int64_t);

static void die(const char *what) {
  fprintf(stderr, "omni_go: %s\n", what);
  fflush(stderr);
  abort();
}

/* ---- 主 g ---- */

static void runMain(void *fnv) {
  omni_goclos *c = (omni_goclos *)fnv;
  ((omni_go_fn0)c->fp)(fnv);
}

void omni_go_run(void *fnv) {
  if (fnv == NULL) die("main 那一格函数值是空的");
  omni_sched_init(0);
  omni_sched_main(runMain, fnv);
}

/* ---- go f(x) ---- */

/* 一格 goroutine 的实参包。`omni_newproc` 只递一格 `void *`，所以函数值与实参
   要装在一起 —— 蹦床跑完就还（Go 那边是把实参抄到新 g 的栈上，同一件事）。 */
typedef struct { void *fnv; int64_t arg; } omni_gopack;
static void runSpawned(void *p) {
  omni_gopack pack = *(omni_gopack *)p;   /* 先抄出来再还，体里不再碰这块堆 */
  free(p);
  omni_goclos *c = (omni_goclos *)pack.fnv;
  ((omni_go_fn1)c->fp)(pack.fnv, pack.arg);
}

void omni_go_spawn(void *fnv, int64_t arg) {
  if (fnv == NULL) die("go 的那一格函数值是空的");
  omni_gopack *p = (omni_gopack *)malloc(sizeof(omni_gopack));
  if (p == NULL) die("实参包分不出来");
  p->fnv = fnv;
  p->arg = arg;
  omni_newproc(runSpawned, p);
}

/* 不带实参那一格：函数值本身就够当 `arg`，不用打包（也就不用还）。 */
static void runSpawned0(void *fnv) {
  omni_goclos *c = (omni_goclos *)fnv;
  ((omni_go_fn0)c->fp)(fnv);
}

void omni_go_spawn0(void *fnv) {
  if (fnv == NULL) die("go 的那一格函数值是空的");
  omni_newproc(runSpawned0, fnv);
}

/* 两格与三格实参：包与蹦床各一份。**不拿变参凑** —— 蹦床要按真签名的函数指针类型去调，
   个数说不准就是读错寄存器（见 `omni_go.h` 上 `spawn0` 那段同一条理由）。 */
typedef struct { void *fnv; int64_t a, b, c; } omni_gopack3;

static void runSpawned2(void *p) {
  omni_gopack3 pk = *(omni_gopack3 *)p;
  free(p);
  ((omni_go_fn2)((omni_goclos *)pk.fnv)->fp)(pk.fnv, pk.a, pk.b);
}

static void runSpawned3(void *p) {
  omni_gopack3 pk = *(omni_gopack3 *)p;
  free(p);
  ((omni_go_fn3)((omni_goclos *)pk.fnv)->fp)(pk.fnv, pk.a, pk.b, pk.c);
}

static omni_gopack3 *pack3(void *fnv, int64_t a, int64_t b, int64_t c) {
  omni_gopack3 *p;
  if (fnv == NULL) die("go 的那一格函数值是空的");
  p = (omni_gopack3 *)malloc(sizeof(omni_gopack3));
  if (p == NULL) die("实参包分不出来");
  p->fnv = fnv;
  p->a = a;
  p->b = b;
  p->c = c;
  return p;
}

void omni_go_spawn2(void *fnv, int64_t a, int64_t b) {
  omni_newproc(runSpawned2, pack3(fnv, a, b, 0));
}

void omni_go_spawn3(void *fnv, int64_t a, int64_t b, int64_t c) {
  omni_newproc(runSpawned3, pack3(fnv, a, b, c));
}

/* ---- channel ---- */

void *omni_go_chan_new(int64_t cap) {
  if (cap < 0) die("channel 的缓冲是负的");
  return (void *)omni_makechan(8, cap);
}

void omni_go_chan_send(void *c, int64_t v) {
  if (c == NULL) die("往一格空 channel 上发（go 里那是永久阻塞）");
  omni_chansend((omni_hchan *)c, &v, 1);
}

int64_t omni_go_chan_recv(void *c) {
  int64_t v = 0;
  int got = 0;
  if (c == NULL) die("从一格空 channel 上收（go 里那是永久阻塞）");
  omni_chanrecv((omni_hchan *)c, &v, 1, &got);
  /* `got == 0` = 是被 close 叫醒的：go 里那一格是元素类型的零值，这儿就是 0。 */
  return got == 0 ? 0 : v;
}

/* `v, ok := <-c` 那两句（见 `omni_go.h` 上那段账）。ok 摆在**这条 M 的 TLS** 里 ——
   两句之间没有 park，所以 g 不会换 M，读到的一定是自己刚写的那一格。
   与 `omni_sched.c` 的 `tls_g` 同一条路数（Go 把 g 摆在寄存器里，我们用 TLS）。 */
static _Thread_local int64_t tls_recvOK;

int64_t omni_go_chan_recv2(void *c) {
  int64_t v = 0;
  int got = 0;
  if (c == NULL) die("从一格空 channel 上收（go 里那是永久阻塞）");
  omni_chanrecv((omni_hchan *)c, &v, 1, &got);
  tls_recvOK = got == 0 ? 0 : 1;
  return got == 0 ? 0 : v;
}

int64_t omni_go_chan_ok(void) { return tls_recvOK; }

void omni_go_chan_close(void *c) {  if (c == NULL) die("close 一格空 channel");
  omni_closechan((omni_hchan *)c);
}

int64_t omni_go_chan_len(void *c) {
  return c == NULL ? 0 : (int64_t)omni_chanlen((omni_hchan *)c);
}
