#include "omni_sched.h"
#include <stdio.h>
#include <stdatomic.h>
#include <stdint.h>
#include <time.h>
#include <stdlib.h>
static _Atomic int done;
static _Atomic double acc;
static int NG = 8;
static void burn(void *a) {
  (void)a; double s = 0;
  for (long i = 1; i <= 60000000L; i++) s += 1.0 / (double)i;
  acc = acc + s;
  atomic_fetch_add(&done, 1);
}
static void mainfn(void *a) { (void)a;
  for (int i = 0; i < NG; i++) omni_newproc(burn, NULL);
  while (atomic_load(&done) < NG) omni_gosched();
}
int main(void) {
  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  omni_sched_init(getenv("P") ? atoi(getenv("P")) : 0);
  omni_sched_main(mainfn, NULL);
  clock_gettime(CLOCK_MONOTONIC, &t1);
  printf("%d 条 g、GOMAXPROCS=%d：%.0f ms\n", NG, omni_gomaxprocs(),
    (t1.tv_sec - t0.tv_sec) * 1e3 + (t1.tv_nsec - t0.tv_nsec) / 1e6);
  return 0;
}
