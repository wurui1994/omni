/* channel 那一格的判据：pt 的那个形状（N 条 g 往 `chan int, H` 里发，主 g 收 H 次）
   加上无缓冲的乒乓、close 的语义、select 的两路。 */
#include "omni_chan.h"
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdatomic.h>

static int fails = 0;
static void check(const char *what, long got, long want) {
  if (got == want) printf("  ok   %s [%ld]\n", what, got);
  else { printf("  FAIL %s [得 %ld、该 %ld]\n", what, got, want); fails++; }
}

/* ---- 一、pt 的形状：ncpu 条 g 按行扫，每扫完一行往 ch 发一格；主 g 收 h 次 ---- */
#define H 240
static omni_hchan *ch;
static int NCPU = 8;
static void row_worker(void *arg) {
  int i = (int)(intptr_t)arg;
  for (int y = i; y < H; y += NCPU) {
    int one = 1;
    omni_chansend(ch, &one, 1);
  }
}
static _Atomic long rows;
static void t_rows(void *a) {
  (void)a;
  ch = omni_makechan(sizeof(int), H);
  for (int i = 0; i < NCPU; i++) omni_newproc(row_worker, (void *)(intptr_t)i);
  for (int i = 0; i < H; i++) {
    int v = 0, ok = 0;
    omni_chanrecv(ch, &v, 1, &ok);
    if (ok) atomic_fetch_add(&rows, v);
  }
}

/* ---- 二、无缓冲的乒乓（每一格都要真交手） ---- */
static omni_hchan *pa, *pb;
static void pong(void *a) {
  (void)a;
  for (int i = 0; i < 2000; i++) {
    int v = 0;
    omni_chanrecv(pa, &v, 1, NULL);
    v++;
    omni_chansend(pb, &v, 1);
  }
}
static long pingsum;
static void t_ping(void *a) {
  (void)a;
  pa = omni_makechan(sizeof(int), 0);
  pb = omni_makechan(sizeof(int), 0);
  omni_newproc(pong, NULL);
  for (int i = 0; i < 2000; i++) {
    int v = i, r = 0;
    omni_chansend(pa, &v, 1);
    omni_chanrecv(pb, &r, 1, NULL);
    pingsum += r - v;                 /* 每一趟该正好差 1 */
  }
}

/* ---- 三、close：收方要拿到 ok=0，环里剩的货要先收完 ---- */
static long closed_ok, closed_vals;
static void t_close(void *a) {
  (void)a;
  omni_hchan *c = omni_makechan(sizeof(int), 4);
  for (int i = 1; i <= 3; i++) omni_chansend(c, &i, 1);
  omni_closechan(c);
  for (;;) {
    int v = 0, ok = 0;
    omni_chanrecv(c, &v, 1, &ok);
    if (!ok) break;
    closed_ok++;
    closed_vals += v;
  }
  /* 关了之后再收还是立刻回、ok=0 */
  int v = 0, ok = 1;
  omni_chanrecv(c, &v, 1, &ok);
  if (ok) closed_ok = -1;
}

/* ---- 四、select：一路能收、一路满，加 default ---- */
static long sel_hit[3];
static void feeder(void *a) { omni_hchan *c = (omni_hchan *)a; int v = 7; omni_chansend(c, &v, 1); }
static void t_select(void *a) {
  (void)a;
  omni_hchan *c1 = omni_makechan(sizeof(int), 0);
  omni_hchan *c2 = omni_makechan(sizeof(int), 0);
  /* 没人喂 ⇒ 该走 default */
  int v1 = 0, v2 = 0;
  omni_scase cs[3] = {
    { c1, &v1, OMNI_SELECT_RECV }, { c2, &v2, OMNI_SELECT_RECV }, { NULL, NULL, OMNI_SELECT_DEFAULT },
  };
  int ok = 0;
  int k = omni_selectgo(cs, 3, &ok);
  sel_hit[0] = (k == 2) ? 1 : 0;
  /* 有人喂 c2 ⇒ 阻塞那一路要醒在第 1 格 */
  omni_newproc(feeder, c2);
  omni_scase cs2[2] = { { c1, &v1, OMNI_SELECT_RECV }, { c2, &v2, OMNI_SELECT_RECV } };
  k = omni_selectgo(cs2, 2, &ok);
  sel_hit[1] = (k == 1 && ok && v2 == 7) ? 1 : 0;
  /* 挑一格能发的 */
  omni_hchan *c3 = omni_makechan(sizeof(int), 1);
  int sv = 5;
  omni_scase cs3[2] = { { c1, &sv, OMNI_SELECT_SEND }, { c3, &sv, OMNI_SELECT_SEND } };
  k = omni_selectgo(cs3, 2, NULL);
  sel_hit[2] = (k == 1 && omni_chanlen(c3) == 1) ? 1 : 0;
}

/* 四格判据全在**同一条主 goroutine** 里跑完 —— `omni_sched_main` 只能调一次
   （主 g 一结束整个调度器就收摊，与 Go 的 main 一样）。 */
static void allfn(void *a) {
  t_rows(a); t_ping(a); t_close(a); t_select(a);
}

int main(void) {
  omni_sched_init(0);
  omni_sched_main(allfn, NULL);
  check("pt 的形状（240 行 / 8 条 g）", atomic_load(&rows), H);
  check("无缓冲乒乓 2000 趟", pingsum, 2000);
  check("close：收完剩货", closed_ok, 3);
  check("close：剩货的和", closed_vals, 6);
  check("select default", sel_hit[0], 1);
  check("select 阻塞后被唤醒", sel_hit[1], 1);
  check("select 挑一格能发的", sel_hit[2], 1);
  printf("%s\n", fails == 0 ? "chan ok" : "chan FAIL");
  return fails == 0 ? 0 : 1;
}
