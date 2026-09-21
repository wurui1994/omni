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

/* ---- select（见 `omni_go.h` 上那段账） ---- */

static _Thread_local omni_scase tls_scase[OMNI_GO_SEL_MAX];
static _Thread_local int64_t tls_selval[OMNI_GO_SEL_MAX];
static _Thread_local int tls_ncase;
static _Thread_local int64_t tls_selVal;
static _Thread_local int64_t tls_selOK;

void omni_go_sel_begin(void) { tls_ncase = 0; }

static omni_scase *selSlot(void) {
  if (tls_ncase >= OMNI_GO_SEL_MAX) die("select 的 case 太多了（上限见 OMNI_GO_SEL_MAX）");
  tls_selval[tls_ncase] = 0;
  return &tls_scase[tls_ncase++];
}

void omni_go_sel_recv(void *c) {
  omni_scase *s;
  if (c == NULL) die("select 里有一格空 channel（go 里那一路永远不会被选中）");
  s = selSlot();
  s->c = (omni_hchan *)c;
  s->elem = NULL;                 /* 真地址在 `sel_go` 里指到自己栈上 */
  s->kind = OMNI_SELECT_RECV;
}

void omni_go_sel_send(void *c, int64_t v) {
  omni_scase *s;
  if (c == NULL) die("select 里有一格空 channel（go 里那一路永远不会被选中）");
  s = selSlot();
  s->c = (omni_hchan *)c;
  s->elem = NULL;
  s->kind = OMNI_SELECT_SEND;
  tls_selval[tls_ncase - 1] = v;  /* 要发的值在这一刻就求好了（与 go 的求值次序一致） */
}

void omni_go_sel_default(void) {
  omni_scase *s = selSlot();
  s->c = NULL;
  s->elem = NULL;
  s->kind = OMNI_SELECT_DEFAULT;
}

int64_t omni_go_sel_go(void) {
  /* **抄到自己栈上再进去**：park 之后 g 可能换 M，而 `omni_selectgo` 往 `elem` 里写的
     那一格必须跟着 g 走 —— g 的栈跟着 g，TLS 不跟着。 */
  omni_scase cs[OMNI_GO_SEL_MAX];
  int64_t vals[OMNI_GO_SEL_MAX];
  int n = tls_ncase;
  int i, ok = 0, idx;
  for (i = 0; i < n; i++) {
    cs[i] = tls_scase[i];
    vals[i] = tls_selval[i];
    if (cs[i].kind != OMNI_SELECT_DEFAULT) cs[i].elem = &vals[i];
  }
  idx = omni_selectgo(cs, n, &ok);
  tls_ncase = 0;
  tls_selOK = ok != 0 ? 1 : 0;
  tls_selVal = (idx >= 0 && idx < n) ? vals[idx] : 0;
  return (int64_t)idx;
}

int64_t omni_go_sel_val(void) { return tls_selVal; }
int64_t omni_go_sel_ok(void) { return tls_selOK; }

/* ---- 宿主那几格：时钟 / 核数 / 文件（口与约定见 omni_go.h 的那段注） ---- */

#include <time.h>
#include <unistd.h>

int64_t omni_go_nanotime(void) {
  struct timespec ts;
  /* 单调钟 —— `time.Since(start)` 问的是"过了多久"，而墙上钟会被调。
     `time.Now().UnixNano()` 拿它当种子也没问题（种子只要变就行）。 */
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
  return (int64_t)ts.tv_sec * 1000000000 + (int64_t)ts.tv_nsec;
}

int64_t omni_go_numcpu(void) {
  long n = sysconf(_SC_NPROCESSORS_ONLN);
  return n < 1 ? 1 : (int64_t)n;
}

/* 攒路径的那格缓冲：**一份全局的**（不是每条 M 一份，见头文件那段注）。 */
#define OMNI_GO_PATH_MAX 4096
static char go_path[OMNI_GO_PATH_MAX];
static int go_pathN = 0;

void omni_go_path_reset(void) { go_pathN = 0; go_path[0] = '\0'; }

void omni_go_path_push(int64_t b) {
  if (go_pathN >= OMNI_GO_PATH_MAX - 1) return;   /* 满了就丢 —— 4095 字节的路径不是真情形 */
  go_path[go_pathN++] = (char)(b & 0xff);
  go_path[go_pathN] = '\0';
}

/* 开着的那几格。槽号就是下标 —— 方言那侧只有整数。 */
#define OMNI_GO_FILE_MAX 64
static FILE *go_files[OMNI_GO_FILE_MAX];

int64_t omni_go_open(int64_t mode) {
  int i;
  FILE *f = fopen(go_path, mode == 1 ? "wb" : "rb");
  if (f == NULL) return -1;
  for (i = 0; i < OMNI_GO_FILE_MAX; i++) {
    if (go_files[i] == NULL) { go_files[i] = f; return (int64_t)i; }
  }
  fclose(f);
  return -1;                                      /* 槽满了 —— 与"打不开"同一格答案 */
}

void omni_go_write(int64_t h, int64_t b) {
  if (h < 0 || h >= OMNI_GO_FILE_MAX || go_files[h] == NULL) return;
  /* 一次一格字节 —— stdio 自己带缓冲，所以这不是一次系统调用。 */
  fputc((int)(b & 0xff), go_files[h]);
}

int64_t omni_go_read(int64_t h) {
  int c;
  if (h < 0 || h >= OMNI_GO_FILE_MAX || go_files[h] == NULL) return -1;
  c = fgetc(go_files[h]);
  return c == EOF ? -1 : (int64_t)c;
}

void omni_go_close(int64_t h) {
  if (h < 0 || h >= OMNI_GO_FILE_MAX || go_files[h] == NULL) return;
  fclose(go_files[h]);
  go_files[h] = NULL;
}

void omni_go_out(int64_t b) { fputc((int)(b & 0xff), stdout); }
