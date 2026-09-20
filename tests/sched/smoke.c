/* 调度器的最小判据：起 N 条 g，每条自增一格计数并让出几次；主 g 等它们全完。 */
#include "omni_sched.h"
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdatomic.h>

static _Atomic int done_count;
static _Atomic long sum;
static int NG = 200;

static void worker(void *arg) {
  long id = (long)(intptr_t)arg;
  long acc = 0;
  for (int i = 0; i < 1000; i++) {
    acc += id;
    if ((i & 127) == 0) omni_gosched();
  }
  atomic_fetch_add(&sum, acc);
  atomic_fetch_add(&done_count, 1);
}

static void mainfn(void *arg) {
  (void)arg;
  for (long i = 0; i < NG; i++) omni_newproc(worker, (void *)(intptr_t)i);
  while (atomic_load(&done_count) < NG) omni_gosched();
}

int main(int argc, char **argv) {
  if (argc > 1) NG = atoi(argv[1]);
  omni_sched_init(0);
  printf("GOMAXPROCS=%d NumCPU=%d\n", omni_gomaxprocs(), omni_numcpu());
  omni_sched_main(mainfn, NULL);
  long want = 0;
  for (long i = 0; i < NG; i++) want += i * 1000;
  printf("done=%d sum=%ld want=%ld %s\n", atomic_load(&done_count), atomic_load(&sum), want,
         atomic_load(&sum) == want ? "ok" : "FAIL");
  return atomic_load(&sum) == want ? 0 : 1;
}
