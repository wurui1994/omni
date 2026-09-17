/* malloc_probe.c —— 压我们自己那份 malloc（第一百四十片第四格）。
 *
 * 不进容器、不发 syscall：把「跟系统要地方」那一条（`__libc_chunk`）换成一块静态
 * 数组，把公用的 `src/sysroot/libc/malloc.c` **原样 include** 进来 —— 于是这份判据
 * 量的就是真的那份实现，改一行立刻反映在这儿。
 *
 * 为什么要它：第一版 malloc 在这儿**十秒出不来**（`timeout` 回 124）。根因是
 * 「整堆线性 first-fit」加「长堆时那一大截 slack 没有块头」：扫到零头 `bsz = 0`，
 * `p += bsz` 原地转圈。那一格在容器里的症状是「72M 的编译器跑 214s 不出 `--help`」——
 * 离病根隔着模拟器与二进制大小两层，所以判据摆在这儿。
 *
 * 顺带钉住公用那一半的一条约定：**两次要来的地方不许假设是连着的**（macOS 那边是
 * `mmap`，一块块散着）。这儿故意每块之间留 4096 字节空隙 —— 连着的假设一旦回来，
 * 立刻在「不重叠」那一格上露出来。
 *
 * 由 `tests/c/libc-malloc.js` 拿 `cc` 编出来跑。
 */
#include <stdio.h>
#include <string.h>

/* 挡掉 libc.h（malloc.c 只从它拿几个声明，这儿由 <string.h> 给） */
#define __OMNI_LIBC_H

static unsigned char FAKE[256u << 20];
static unsigned long fakePos;
static unsigned long fakeGiven;

static unsigned long __libc_chunk(unsigned long least, unsigned long *got) {
  unsigned long want = (least + 15) & ~15UL;
  unsigned long base = ((unsigned long)FAKE + fakePos + 15) & ~15UL;
  unsigned long off = base - (unsigned long)FAKE;
  if (off + want + 4096 > sizeof(FAKE)) return 0;
  fakePos = off + want + 4096;        /* 空隙：下一块**不接着**这一块 */
  fakeGiven += want;
  *got = want;
  return base;
}

#include "../../../src/sysroot/libc/malloc.c"

#define N 200000
static void *ps[N];
static unsigned long szs[N];

static unsigned long rnd(void) {
  static unsigned long s = 88172645463325252UL;
  s ^= s << 13; s ^= s >> 7; s ^= s << 17;
  return s;
}

static unsigned long heapUsed(void) {
  return fakeGiven;
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
  unsigned long before = fakeGiven;
  for (int i = 0; i < N; i += 2) {
    ps[i] = malloc(szs[i]);
    if (ps[i] == 0) { printf("FAIL 复用那一趟第 %d 次回 0\n", i); return 1; }
    memset(ps[i], 0xab, szs[i]);
  }
  if (fakeGiven != before) {
    printf("FAIL free 一半再要回来，堆还长了 %lu 字节\n", fakeGiven - before);
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

  /* 5. 混着大小的碎片压力（第一百四十片第十四格）。
   *
   * 前四格量的是「对不对」，这一格量的是**碎片会不会一直长**：2 万个槽位反复换成
   * 16..4096 字节之间的块（大小由一个定死的 LCG 给，所以每次跑都是同一串），
   * 边换边写签名再验回来。跑两趟同样的 6 万步 —— 判据是
   * **第二趟一个字节都不许再跟系统要**：活着的字节数在两趟里是同一个分布，
   * 堆还长就说明回收的块进不了合适的箱（碎片攒着）。
   *
   * 为什么不量「峰值堆 / 活着的字节」这个比：量过，**那个数量的是别的东西** ——
   * `chunkStep` 每次要地方翻一倍（64K → … → 64M，为的是少发 syscall），
   * 于是那个比值 3.42 倍几乎全是这条增长策略的账，加不加「切零头」都一样。
   * 判据要能分辨改动，就得挑一个不被那条策略盖住的量。 */
  {
    const int SLOTS = 20000;
    static void *ps2[20000];
    static unsigned long szs[20000];
    unsigned long seed = 12345;
    for (int i = 0; i < SLOTS; i++) { ps2[i] = 0; szs[i] = 0; }
    unsigned long afterPass[2];
    for (int pass = 0; pass < 2; pass++) {
      for (int step = 0; step < 60000; step++) {
        seed = seed * 1103515245UL + 12345UL;
        int idx = (int)((seed >> 16) % (unsigned long)SLOTS);
        seed = seed * 1103515245UL + 12345UL;
        unsigned long want = 16 + (seed >> 17) % 4081;      /* 16..4096 */
        if (ps2[idx] != 0) {
          /* 先验签名，再放掉 —— 重叠或写花在这儿露出来 */
          unsigned char *q = (unsigned char *)ps2[idx];
          if (q[0] != (unsigned char)(idx & 0xff) || q[szs[idx] - 1] != (unsigned char)(idx >> 8)) {
            printf("FAIL 碎片压力：第 %d 号槽的签名坏了\n", idx);
            return 1;
          }
          free(ps2[idx]);
        }
        unsigned char *p = (unsigned char *)malloc(want);
        if (p == 0) { printf("FAIL 碎片压力：第 %d 步要不到 %lu 字节\n", step, want); return 1; }
        p[0] = (unsigned char)(idx & 0xff);
        p[want - 1] = (unsigned char)(idx >> 8);
        ps2[idx] = p;
        szs[idx] = want;
      }
      afterPass[pass] = fakeGiven;
    }
    printf("ok   混着大小 6 万步 × 两趟：堆 %.1f MB -> %.1f MB\n",
      (double)afterPass[0] / 1048576.0, (double)afterPass[1] / 1048576.0);
    if (afterPass[1] != afterPass[0]) {
      printf("FAIL 第二趟又跟系统要了 %lu 字节（碎片在攒）\n", afterPass[1] - afterPass[0]);
      return 1;
    }
  }
  return 0;
}
