/* 分配器：**arena**（bump 指针），不是 malloc。
 *
 * 为什么（ADR-0001 第 4 节）：编译器是批处理进程 —— 读源码、产出 C、退出。整个生命周期
 * 只需要"分配、永不单独释放、退出时整体丢掉"。malloc 每次要 20-50ns（要走 size class、
 * 要维护 freelist、要考虑多线程），bump 指针 2ns 上下。编译一遍几百万次小分配，差的是数量级。
 * 这也是 ADR-0001 把 arena 排在 ARC 之前的原因：ARC 的价值在长期运行的程序上，
 * 为自举先做 ARC 是把难的事放前面而收益在后面。
 *
 * 块整个 malloc 出来并挂在 omni_arena_head 上，所以从全局可达 —— LeakSanitizer 不会报泄漏。
 *
 * 代价与对策：一个 arena 块里全是我们的对象，ASan 就看不见容器越界了（越界只会静默写坏
 * 邻居）。所以保留 -DOMNI_NO_ARENA：那条路径每次分配都是独立 malloc，ASan 的检测力完好，
 * 消毒扫描走这条。两条路径的可观察行为必须一致，差分测试同时覆盖。
 */
#include "omni.h"

/* class 引用的显式空检查：C 侧不能让它变成段错误，否则和 JS 后端的诊断分叉 */
void *omni_nullck(void *p) {
  if (!p) omni_error("null reference");
  return p;
}

#ifdef OMNI_NO_ARENA

void *omni_alloc(size_t n) {
  void *p = malloc(n ? n : 1);
  if (!p) omni_error("out of memory");
  return p;
}

char *omni_alloc_bytes(int64_t n) {
  if (n < 0) omni_error("negative allocation");
  return (char *)omni_alloc((size_t)n);
}

void *omni_grow(void *p, size_t oldBytes, size_t newBytes) {
  (void)oldBytes;
  void *q = realloc(p, newBytes ? newBytes : 1);
  if (!q) omni_error("out of memory");
  return q;
}

#else

typedef struct omni_arena_block {
  struct omni_arena_block *next;
  char *base;
} omni_arena_block;

static omni_arena_block *omni_arena_head = NULL;
char *omni_arena_ptr = NULL;
char *omni_arena_end = NULL;

#define OMNI_BLOCK_MIN ((size_t)1 << 20)  /* 1 MiB：小到不浪费，大到几乎不触发慢路径 */

/* 开一个新块。请求超过块大小时按请求开（大数组也走 arena，不另设 large-object 路径）。 */
static void omni_arena_new_block(size_t n) {
  size_t cap = n + OMNI_ALIGN > OMNI_BLOCK_MIN ? n + OMNI_ALIGN : OMNI_BLOCK_MIN;
  char *base = (char *)malloc(cap);
  if (!base) omni_error("out of memory");
  omni_arena_block *b = (omni_arena_block *)malloc(sizeof *b);
  if (!b) omni_error("out of memory");
  b->base = base;
  b->next = omni_arena_head;
  omni_arena_head = b;  /* 保持全局可达，LeakSanitizer 才不会把它当泄漏 */
  omni_arena_ptr = base;
  omni_arena_end = base + cap;
}

void *omni_alloc_slow(size_t n) {
  omni_arena_new_block(n);
  return omni_alloc(n);
}

char *omni_alloc_bytes_slow(int64_t n) {
  if (n < 0) omni_error("negative allocation");
  omni_arena_new_block((size_t)n);
  return omni_alloc_bytes(n);
}

/*
 * 增长：调用方传旧大小（arena 自己不记每次分配的尺寸，记了就要每个对象加头，小对象上很贵）。
 * 正在增长的容器多半就是最后一次分配，那种情况下直接把 arena 指针往前推 = 真正的原地扩容，
 * 零拷贝。否则退化成"新分配 + 拷旧内容"，因为容器是倍增增长，被丢掉的旧缓冲总和不超过
 * 最终大小，浪费有 2x 上界。
 */
void *omni_grow(void *p, size_t oldBytes, size_t newBytes) {
  if (!p || newBytes <= oldBytes) return p ? p : omni_alloc(newBytes);
  size_t more = newBytes - oldBytes;
  if ((char *)p + oldBytes == omni_arena_ptr && more <= (size_t)(omni_arena_end - omni_arena_ptr)) {
    omni_arena_ptr += more;
    return p;
  }
  void *q = omni_alloc(newBytes);
  memcpy(q, p, oldBytes);
  return q;
}

#endif /* OMNI_NO_ARENA */
