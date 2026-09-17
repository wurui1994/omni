/* malloc_probe.c —— 压我们自己那份 malloc（第一百四十片第四格）。
 *
 * 不进容器、不发 syscall：把 `brk` 换成一块静态数组，把
 * `src/sysroot/x86_64-linux/libc/malloc.c` **原样 include** 进来 —— 于是这份判据
 * 量的就是真的那份实现，改一行立刻反映在这儿。
 *
 * 为什么要它：第一版 malloc 在这儿**十秒出不来**（`timeout` 回 124）。根因是
 * 「整堆线性 first-fit」加「长堆时那一大截 slack 没有块头」：扫到零头 `bsz = 0`，
 * `p += bsz` 原地转圈。那一格在容器里的症状是「72M 的编译器跑 214s 不出 `--help`」——
 * 离病根隔着模拟器与二进制大小两层，所以判据摆在这儿。
 *
 * 由 `tests/c/libc-malloc.js` 拿 `cc` 编出来跑。
 */
#include <stdio.h>
#include <string.h>

/* 挡掉 libc.h（malloc.c 只从它拿几个声明，这儿由 <string.h> 给） */
#define __OMNI_LIBC_H
#define SYS_brk 12

static unsigned char FAKE[256u << 20];
static unsigned long fakeBrk;

static long fake_sys(long n, long a) {
  (void)n;
  if (a == 0) {
    if (fakeBrk == 0) fakeBrk = ((unsigned long)FAKE + 15) & ~15UL;
    return (long)fakeBrk;
  }
  unsigned long want = (unsigned long)a;
  unsigned long cap = (unsigned long)FAKE + sizeof(FAKE);
  if (want > cap) return (long)fakeBrk;      /* 长不动：与 brk 失败同一个约定 */
  fakeBrk = want;
  return (long)fakeBrk;
}
#define __omni_syscall(...) fake_sys(__VA_ARGS__)

#include "../../../src/sysroot/x86_64-linux/libc/malloc.c"

#define N 200000
static void *ps[N];
static unsigned long szs[N];

static unsigned long rnd(void) {
  static unsigned long s = 88172645463325252UL;
  s ^= s << 13; s ^= s >> 7; s ^= s << 17;
  return s;
}

static unsigned long heapUsed(void) {
  return fakeBrk - (((unsigned long)FAKE + 15) & ~15UL);
}

int main(void) {
  /* 1. 一路 malloc、各写各的、再逐个查 —— 检「块不重叠」 */
  for (int i = 0; i < N; i++) {
    unsigned long n = 8 + (rnd() % 400);
    szs[i] = n;
    ps[i] = malloc(n);
    if (ps[i] == 0) { printf("FAIL 第 %d 次 malloc 回 0（要 %lu）\n", i, n); return 1; }
    memset(ps[i], (int)(i & 0xff), n);
  }
  for (int i = 0; i < N; i++) {
    unsigned char *p = (unsigned char *)ps[i];
    for (unsigned long j = 0; j < szs[i]; j++) {
      if (p[j] != (unsigned char)(i & 0xff)) { printf("FAIL 第 %d 块被踩了\n", i); return 1; }
    }
  }
  printf("ok   %d 块各写各的：没有重叠（堆 %.1f MB）\n", N, (double)heapUsed() / 1048576.0);

  /* 2. 隔一个 free 再要回来 —— 检「空闲表真的在复用」（堆一个字节都不该长） */
  for (int i = 0; i < N; i += 2) free(ps[i]);
  unsigned long before = fakeBrk;
  for (int i = 0; i < N; i += 2) {
    ps[i] = malloc(szs[i]);
    if (ps[i] == 0) { printf("FAIL 复用那一趟第 %d 次回 0\n", i); return 1; }
    memset(ps[i], 0xab, szs[i]);
  }
  if (fakeBrk != before) {
    printf("FAIL free 一半再要回来，堆还长了 %lu 字节\n", fakeBrk - before);
    return 1;
  }
  printf("ok   free 一半再要回来：复用 %d 块、堆没长\n", N / 2);

  /* 3. realloc 一路加长，内容要跟着走 */
  char *r = (char *)malloc(16);
  strcpy(r, "abc");
  for (int i = 0; i < 2000; i++) {
    r = (char *)realloc(r, 16 + (unsigned long)i * 8);
    if (r == 0 || strcmp(r, "abc") != 0) { printf("FAIL realloc 第 %d 次丢了内容\n", i); return 1; }
  }
  printf("ok   realloc 2000 次：内容没丢\n");

  /* 4. calloc 要真的是零 */
  unsigned char *c = (unsigned char *)calloc(1000, 3);
  for (int i = 0; i < 3000; i++) {
    if (c[i] != 0) { printf("FAIL calloc 没清零\n"); return 1; }
  }
  printf("ok   calloc 3000 字节：全零\n");
  return 0;
}
