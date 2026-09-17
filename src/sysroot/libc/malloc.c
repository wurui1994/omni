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
 *   - free 只把块推回它那个箱（LIFO）。**合并是攒着做的**（第十四格）：free 不合并，
 *     等「箱子里找不到、就要跟系统要地方」那一步，如果这中间攒够了 4096 次 free，
 *     就按地址走一遍每块地方、把连着的空闲块并成一块、把箱子整个重建（`sweepMerge`）。
 *     这么摆有两条理由，都是量出来的：free 里合并要边界标记加双向表（每块多 16 字节）；
 *     而「有人 free 过就合并」那一版**超时**（碎片那一格每步都 free，等于每次 malloc
 *     走一遍块表，又回到 O(n²)）。攒够再走，摊到每次 free 上是块数 / 4096。
 *   - 从高一档的箱里取块时**切零头**（`takeBlock`）—— 一个 4096 的块不整块给 17 字节的请求。
 *   - 地方从 `__libc_chunk` 要（Linux 的 `brk` / macOS 的 `mmap` —— 那儿没有 brk）。
 *     **两次要来的地方不一定连着**，所以这一份只在「当前那一块」里往上切，切不动了
 *     再要一块，旧那块剩下的尾巴推回箱里不丢。
 *
 * 试过并**否掉**的一格：把步长的上限从 64M 压到 8M（想少占地方）。判据第一格确实好看 ——
 * 堆 63.0M -> 47.0M、时间 0.29s -> 0.05s；但第二格当场破了：「free 一半再要回来，堆还长了
 * 8388608 字节」，正好一整块 8M。原因是要回来的那些块散在各个箱里、凑不出连着的一大段，
 * 而步长越小、`moreCore` 越频繁地跨到新块上去。**「同样的负载跑第二趟一个字节都不要」这条
 * 性质比峰值小 16M 值钱**，所以留 64M。
 */
#include "libc.h"

#define HDR       16
#define ALIGN16(x) (((x) + 15) & ~(unsigned long)15)
#define NBIN      32

static unsigned long curPos;        /* 当前这块地方切到哪儿了 */
static unsigned long curEnd;        /* 当前这块地方的尽头 */
static unsigned long chunkStep = 1048576;
static unsigned long bins[NBIN];    /* 每个箱的表头（0 = 空） */

/* 每一块跟系统要来的地方都记下来 —— **合并那一趟要按地址走**（见 `sweepMerge`）。
 * 64 格够：每块至少 1M 且步长翻倍，64 格能覆盖到 2^63。 */
#define NCHUNK 64
static unsigned long chunkBase[NCHUNK];
static unsigned long chunkEnd[NCHUNK];
static int nchunk;
static int freedSince;              /* 上次合并之后放掉过多少块（0 就不用白走一趟） */

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
  /* 旧那块剩下的尾巴不丢：够一个块头就推回箱里。这一步同时让旧那块**被块铺满** ——
   * 合并那一趟按地址往下走，靠的就是「每个字节都属于某个有头的块」。 */
  if (curEnd > curPos && curEnd - curPos >= HDR + 16) binPush(curPos, curEnd - curPos);
  curPos = ALIGN16(p);
  curEnd = p + got;
  if (nchunk < NCHUNK) { chunkBase[nchunk] = curPos; chunkEnd[nchunk] = curEnd; nchunk++; }
  if (chunkStep < 67108864UL) chunkStep *= 2;   /* 长到 64M 一步为止 */
  return 0;
}

/* **合并相邻的空闲块**（第一百四十片第十四格）。
 *
 * 判据（`malloc_probe.c` 第五格）量到的病：2 万个槽反复换 16..4096 字节的块，
 * 跑完一趟 6 万步之后**再跑一趟同样的**，堆又跟系统要了 64M —— 活着的字节一样多，
 * 长的全是碎片。原因写在文件头上：箱子只按大小分，free 只把块推回箱里，**不合并**，
 * 于是池子慢慢碎成「比常见请求都小」的一堆。
 *
 * 这一版的合并**不加任何每块开销**（不要边界标记、不要双向表）：按地址把每块地方
 * 走一遍，把连着的空闲块并成一块，然后把箱子整个重建。代价是 O(块数)，
 * 但只在「箱子里找不到、马上就要跟系统要地方」那一步走 —— 那一步本来就要发 syscall。
 *
 * 能这么走的前提是上面那一条：**每块地方都被有头的块铺满**（当前那块到 `curPos` 为止）。 */
static void sweepMerge(void) {
  for (int b = 0; b < NBIN; b++) bins[b] = 0;
  for (int i = 0; i < nchunk; i++) {
    unsigned long p = chunkBase[i];
    unsigned long lim = (i == nchunk - 1) ? curPos : chunkEnd[i];
    while (p + HDR <= lim) {
      unsigned long *h = (unsigned long *)p;
      unsigned long bsz = h[0] & ~1UL;
      if (bsz < HDR + 16 || p + bsz > lim) break;      /* 头不像样：这一块不再往下走 */
      if ((h[0] & 1) != 0) { p += bsz; continue; }     /* 在用的跳过 */
      unsigned long end = p + bsz;
      while (end + HDR <= lim) {                       /* 把紧跟着的空闲块并进来 */
        unsigned long *nh = (unsigned long *)end;
        unsigned long nsz = nh[0] & ~1UL;
        if (nsz < HDR + 16 || end + nsz > lim || (nh[0] & 1) != 0) break;
        end += nsz;
      }
      binPush(p, end - p);
      p = end;
    }
  }
  freedSince = 0;
}

/* 从块 p（总字节 bsz）里取 total 出来，**多出来的切下来推回箱子**（第十四格）。
 *
 * 少了这一步：箱子按 2 的幂分，从高一档弹出来的块整块给出去 —— 一个 4096 的块
 * 服务 17 字节的请求也占满。碎片那一格的判据（`tests/c/libc/malloc_probe.c` 第五格：
 * 2 万个槽反复换 16..4096 字节的块）量到峰值堆是活着字节的 **3.42 倍**。
 * 切下来的零头至少要装得下一个头加 16 字节，否则不值当。 */
static void *takeBlock(unsigned long p, unsigned long bsz, unsigned long total) {
  unsigned long *h = (unsigned long *)p;
  if (bsz - total >= HDR + 16) {
    binPush(p + total, bsz - total);
    h[0] = total | 1;
  } else {
    h[0] = bsz | 1;
  }
  h[1] = 0;
  return (void *)(p + HDR);
}

/* 箱子里找一块 ≥ total 的。找不到回 0。 */
static void *fromBins(unsigned long total) {
  /* 从「装得下 total 的那个箱」起往上 —— 箱 k 里最小的块是 2^k，所以 k > binOf(total)
   * 那些箱里的块一定够大（binOf 是向下取的，所以 binOf(total) 那一箱里可能有比 total
   * 小的，得挑一下）。 */
  int k = binOf(total);
  int b = k;
  while (b < NBIN) {
    unsigned long p = bins[b];
    /* 高一档的箱子里**每一块都够大**，所以直接弹表头。只有 binOf(total) 那一箱要挑 ——
     * 而那一挑最多看 8 格就走，不然一条长表能把 malloc 拖回 O(n)（第一版就是被「扫」
     * 拖死的，这儿不许再留一条扫的路）。 */
    if (b > k) {
      if (p != 0) {
        unsigned long *h = (unsigned long *)p;
        bins[b] = h[1];
        return takeBlock(p, h[0] & ~1UL, total);
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
        return takeBlock(p, bsz, total);
      }
      prev = p;
      p = h[1];
      look++;
    }
    b++;
  }
  return (void *)0;
}

void *malloc(unsigned long size) {
  if (size == 0) size = 1;
  unsigned long total = ALIGN16(size + HDR);
  /* 1. 箱子里找。 */
  void *r = fromBins(total);
  if (r != (void *)0) return r;
  /* 2. 找不到、而且**攒够了 free**：先合并一趟再找（见 `sweepMerge`）。
   *
   * 门槛不能是「有人 free 过就走」—— 那一版量到的是**超时**（判据 20 秒跑不完）：
   * 碎片那一格每步都 free，于是几乎每次 malloc 都走一遍块表，又回到 O(n²)。
   * 攒够 4096 次再走，摊到每次 free 上就是块数 / 4096，那条路数才站得住。 */
  if (freedSince >= 4096) {
    sweepMerge();
    r = fromBins(total);
    if (r != (void *)0) return r;
  }
  /* 3. 当前那块地方的顶上切。切不动就再要一块。 */
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
  freedSince++;                          /* 合并那一趟看它决定要不要走 */
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
