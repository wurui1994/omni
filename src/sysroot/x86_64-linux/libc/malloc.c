/* malloc.c — brk 上的极简分配器（第一百四十片）。
 *
 * 设计：线性 bump allocator + 每块一个 header（size + used 位）。
 * free 只标记 used=0，realloc 原地扩或重分配。没有合并、没有分桶。
 * 够我们的编译器跑起来就行 —— 真的性能优化是以后的事。
 *
 * 对齐：所有返回地址 16 字节对齐（SysV 要求 malloc 回 16 对齐）。
 */
#include "syscall.h"

/* brk(0) 返回当前堆顶；brk(addr) 设新堆顶，成功回新值，失败回旧值。 */
static unsigned long heap_start;
static unsigned long heap_end;

#define HEADER_SIZE 16   /* 8 字节 size + 8 字节对齐/标记 */
#define ALIGN16(x) (((x) + 15) & ~(unsigned long)15)

static void heap_init(void) {
  if (heap_start != 0) return;
  long cur = __omni_syscall(SYS_brk, 0);
  heap_start = (unsigned long)cur;
  heap_end = heap_start;
}

static void *heap_grow(unsigned long need) {
  unsigned long new_end = ALIGN16(heap_end + need);
  /* 一次至少长 64K，减少 brk 调用次数。 */
  if (new_end - heap_end < 65536) new_end = ALIGN16(heap_end + 65536);
  long r = __omni_syscall(SYS_brk, (long)new_end);
  if ((unsigned long)r < new_end) return (void *)0;   /* brk 失败 */
  unsigned long old = heap_end;
  heap_end = (unsigned long)r;
  return (void *)old;
}

void *malloc(unsigned long size) {
  heap_init();
  if (size == 0) size = 1;
  unsigned long total = ALIGN16(size + HEADER_SIZE);

  /* 线性扫一遍找 free 块（first-fit）。 */
  unsigned long p = heap_start;
  while (p + HEADER_SIZE <= heap_end) {
    unsigned long *hdr = (unsigned long *)p;
    unsigned long bsz = hdr[0] & ~1UL;
    int used = (int)(hdr[0] & 1);
    if (!used && bsz >= total) {
      hdr[0] = bsz | 1;
      return (void *)(p + HEADER_SIZE);
    }
    p += bsz;
  }

  /* 没有空闲块，往后长。 */
  void *base = heap_grow(total);
  if (base == (void *)0) return (void *)0;
  unsigned long *hdr = (unsigned long *)base;
  hdr[0] = total | 1;
  hdr[1] = 0;
  return (void *)((unsigned long)base + HEADER_SIZE);
}

void free(void *ptr) {
  if (ptr == (void *)0) return;
  unsigned long *hdr = (unsigned long *)((unsigned long)ptr - HEADER_SIZE);
  hdr[0] &= ~1UL;   /* 清 used 位 */
}

void *calloc(unsigned long n, unsigned long size) {
  unsigned long total = n * size;
  void *p = malloc(total);
  if (p == (void *)0) return (void *)0;
  /* memset 在 string.c 里 */
  unsigned char *b = (unsigned char *)p;
  unsigned long i = 0;
  while (i < total) { b[i] = 0; i++; }
  return p;
}

void *realloc(void *ptr, unsigned long size) {
  if (ptr == (void *)0) return malloc(size);
  if (size == 0) { free(ptr); return (void *)0; }
  unsigned long *hdr = (unsigned long *)((unsigned long)ptr - HEADER_SIZE);
  unsigned long old_total = hdr[0] & ~1UL;
  unsigned long old_usable = old_total - HEADER_SIZE;
  if (size <= old_usable) return ptr;   /* 原地够用 */
  void *nw = malloc(size);
  if (nw == (void *)0) return (void *)0;
  /* memcpy 在 string.c 里 —— 但这一份不 include string.h，手写一遍。 */
  unsigned char *dp = (unsigned char *)nw;
  unsigned char *sp = (unsigned char *)ptr;
  unsigned long i = 0;
  while (i < old_usable) { dp[i] = sp[i]; i++; }
  free(ptr);
  return nw;
}
