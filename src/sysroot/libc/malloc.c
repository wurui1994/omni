/* malloc.c — 分箱的空闲表 + 顶上切（第一百四十片，第二版）。
 *
 * 第一版是「整堆线性 first-fit」，两个错，都是要命的：
 *
 * 一、**死循环**。`heap_grow` 一次至少长 64K，而只有「这次要的那一块」写了块头，
 *     后面那一大截 slack 是**零**。下一次 malloc 扫到那儿：`bsz = 0`，既不满足
 *     `bsz >= total`，`p += bsz` 又不动 —— 原地转圈。72M 那份编译器在容器里跑了
 *     214s 出不来就是这一格（不是模拟慢）。
 * 二、**O(n²)**。每次 malloc 从堆底扫一遍。编译器一趟几十万次分配，扫的总量是
 *     块数的平方。
 *
 * 这一版：
 *   - 每块一个 16 字节头：`[0]` = 块的总字节数（含头）| used 位，`[8]` = 空闲表的下一格。
 *   - 32 个箱子按 2 的幂分（箱 k 装 [2^k, 2^(k+1)) 字节的块）。malloc 从「够大的
 *     那个箱」往上找第一个非空的，弹出表头；一个都没有就从顶上切一块。都是 O(1)。
 *   - free 只把块推回它那个箱（LIFO）。**不合并** —— 明写在这儿：一块 1M 的空闲块
 *     只服务 ≥ 512K 的请求。合并要边界标记加双向表，那是下一步的事；这一版先把
 *     「不死循环、不平方」这两件事钉住。
 *   - 地方从 `__libc_chunk` 要（Linux 的 `brk` / macOS 的 `mmap` —— 那儿没有 brk）。
 *     **两次要来的地方不一定连着**，所以这一份只在「当前那一块」里往上切，切不动了
 *     再要一块，旧那块剩下的尾巴推回箱里不丢。
 */
#include "libc.h"

#define HDR       16
#define ALIGN16(x) (((x) + 15) & ~(unsigned long)15)
#define NBIN      32

static unsigned long curPos;        /* 当前这块地方切到哪儿了 */
static unsigned long curEnd;        /* 当前这块地方的尽头 */
static unsigned long chunkStep = 1048576;
static unsigned long bins[NBIN];    /* 每个箱的表头（0 = 空） */

/* 块大小 -> 箱号：最高位的位置（`total` 至少 32，所以箱号至少 5）。 */
static int binOf(unsigned long total) {
  int k = 0;
  while ((total >> k) > 1) k++;     /* k = floor(log2 total) */
  return k >= NBIN ? NBIN - 1 : k;
}

/* 把一块地方推回箱里（`moreCore` 收旧尾巴、`free` 都走它）。 */
static void binPush(unsigned long p, unsigned long bsz) {
  unsigned long *h = (unsigned long *)p;
  h[0] = bsz;                       /* used 位是 0 */
  int b = binOf(bsz);
  h[1] = bins[b];
  bins[b] = p;
}

/* 再要一块地方。要不到回 -1。 */
static int moreCore(unsigned long need) {
  unsigned long want = need;
  if (want < chunkStep) want = chunkStep;
  unsigned long got = 0;
  unsigned long p = __libc_chunk(want, &got);
  if (p == 0 || got < need) return -1;
  /* 旧那块剩下的尾巴不丢：够一个块头就推回箱里。 */
  if (curEnd > curPos && curEnd - curPos >= HDR + 16) binPush(curPos, curEnd - curPos);
  curPos = ALIGN16(p);
  curEnd = p + got;
  if (chunkStep < 67108864UL) chunkStep *= 2;   /* 长到 64M 一步为止 */
  return 0;
}

void *malloc(unsigned long size) {
  if (size == 0) size = 1;
  unsigned long total = ALIGN16(size + HDR);
  /* 1. 箱子里找。从「装得下 total 的那个箱」起往上 —— 箱 k 里最小的块是 2^k，
   *    所以 k >= binOf(total) 那些箱里的块一定够大（binOf 是向下取的，所以
   *    binOf(total) 那一箱里可能有比 total 小的，得挑一下）。 */
  int k = binOf(total);
  int b = k;
  while (b < NBIN) {
    unsigned long p = bins[b];
    /* 高一档的箱子里**每一块都够大**（箱 b 里最小的块是 2^b ≥ total），所以直接弹表头。
     * 只有 binOf(total) 那一箱要挑 —— 而那一挑最多看 8 格就走，不然一条长表能把
     * malloc 拖回 O(n)（第一版就是被「扫」拖死的，这儿不许再留一条扫的路）。 */
    if (b > k) {
      if (p != 0) {
        unsigned long *h = (unsigned long *)p;
        bins[b] = h[1];
        h[0] = (h[0] & ~1UL) | 1;
        h[1] = 0;
        return (void *)(p + HDR);
      }
      b++;
      continue;
    }
    unsigned long prev = 0;
    int look = 0;
    while (p != 0 && look < 8) {
      unsigned long *h = (unsigned long *)p;
      unsigned long bsz = h[0] & ~1UL;
      if (bsz >= total) {
        if (prev == 0) bins[b] = h[1];
        else ((unsigned long *)prev)[1] = h[1];
        h[0] = bsz | 1;
        h[1] = 0;
        return (void *)(p + HDR);
      }
      prev = p;
      p = h[1];
      look++;
    }
    b++;
  }
  /* 2. 当前那块地方的顶上切。切不动就再要一块。 */
  if (curEnd == 0 || curPos + total > curEnd) {
    if (moreCore(total) < 0) return (void *)0;
  }
  unsigned long blk = curPos;
  curPos += total;
  unsigned long *h = (unsigned long *)blk;
  h[0] = total | 1;
  h[1] = 0;
  return (void *)(blk + HDR);
}

void free(void *ptr) {
  if (ptr == (void *)0) return;
  unsigned long p = (unsigned long)ptr - HDR;
  unsigned long *h = (unsigned long *)p;
  unsigned long bsz = h[0] & ~1UL;
  if (bsz < HDR + 16) return;            /* 不像我们发出去的块：不碰 */
  binPush(p, bsz);
}

void *calloc(unsigned long n, unsigned long size) {
  unsigned long total = n * size;
  void *p = malloc(total);
  if (p == (void *)0) return p;
  memset(p, 0, total);
  return p;
}

void *realloc(void *ptr, unsigned long size) {
  if (ptr == (void *)0) return malloc(size);
  if (size == 0) { free(ptr); return (void *)0; }
  unsigned long *h = (unsigned long *)((unsigned long)ptr - HDR);
  unsigned long old = (h[0] & ~1UL) - HDR;
  if (size <= old) return ptr;
  void *nw = malloc(size);
  if (nw == (void *)0) return nw;
  memcpy(nw, ptr, old);
  free(ptr);
  return nw;
}

/* 这一份用得着的两条（`string.c` 里那两个是同一份实现，这儿只是声明在 libc.h 上）。 */
