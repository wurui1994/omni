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

/* 量口（`OMNI_MEM_DEBUG=1`）：退出时印"一共开了多少块、多少字节"。
 * arena 永不回收，所以"申请了多少"就是峰值 —— 三维那一族在 run-c 上被 OOM 杀掉时
 * （量到过：BezierPatch 7.6s 申请 43GB），先看这两个数落在哪一档。
 * 平时一个原子变量都不加：计数只在开新块那条慢路径上动，热路径（bump 指针）一个字不改。 */
static size_t omni_arena_nblock = 0;
static size_t omni_arena_bytes = 0;
static int omni_arena_reported = 0;

static void omni_arena_report(void) {
  if (omni_arena_reported) return;
  omni_arena_reported = 1;
  fprintf(stderr, "omni_mem: arena 块 %zu、字节 %zu（%.1f MiB）\n",
          omni_arena_nblock, omni_arena_bytes,
          (double) omni_arena_bytes / (double) (1u << 20));
}

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
  if (omni_arena_nblock == 0 && getenv("OMNI_MEM_DEBUG")) atexit(omni_arena_report);
  omni_arena_nblock++;
  omni_arena_bytes += cap;
  /* `OMNI_MEM_DEBUG=2`：每翻一倍就印一行。被 SIGKILL（OOM）打死时 atexit 不会跑，
   * 只有这条能看出"涨到哪一档"—— 三维那一族就是这么量出来的。 */
  {
    static size_t next = OMNI_BLOCK_MIN * 16;
    if (omni_arena_bytes >= next) {
      const char *d = getenv("OMNI_MEM_DEBUG");
      if (d && d[0] == '2')
        fprintf(stderr, "omni_mem: %.0f MiB（块 %zu）\n",
                (double) omni_arena_bytes / (double) (1u << 20), omni_arena_nblock);
      next *= 2;
    }
  }
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

/* 指针（ADR-0016）。声明与设计理由（含"真符号一律是平的"那一条）在 omni.h。
 *
 * 分配走 arena：这两条原生腿的指针是真地址，而 arena 的块是 malloc 出来的、到进程退出
 * 才丢，所以"悬垂指针不可能"这条（jancy 的 type_ptr_data.rst）在批处理进程里自动成立 ——
 * 不需要 GC 也不需要 free。
 *
 * 四条消息必须与另外三条腿逐字节相同（backend-js 的 prelude 与 interp/builtin.js 的
 * $pnew/$pchk/$tchk/$psub），否则同一份 .sx 的诊断在腿之间分叉，tests/sexpr 的判据就废了。
 */
char *omni_pnew(int64_t count, int64_t size) {
  if (count < 0) omni_errorf("pointer allocation count cannot be negative: %lld", (long long)count);
  int64_t bytes = count * size;
  char *a = omni_alloc_bytes(bytes);
  memset(a, 0, (size_t)bytes);  /* 编译器在用户代码碰到之前把每一格清零 */
  return a;
}

/* 向下取整的整除：另外三条腿的 $pchk 用 Math.floor，而 C 的 / 是向零截断。
   两者只在"负数且除不尽"时不同（-4/8：floor 给 -1，截断给 0）—— 越界消息要逐字节相同，
   所以这里补上 floor 的语义，而不是赌那种情形不出现。 */
static int64_t omni_pfloordiv(int64_t a, int64_t b) {
  int64_t q = a / b;
  if ((a % b) != 0 && ((a < 0) != (b < 0))) q -= 1;
  return q;
}

void *omni_pchk(char *a, char *b, char *e, int64_t size) {
  if (a == 0) omni_error("null pointer dereference");
  if (a < b || a + size > e) {
    /* 按元素印，不印裸地址 */
    omni_errorf("pointer out of bounds: %lld (range %lld)",
                (long long)omni_pfloordiv(a - b, size),
                (long long)omni_pfloordiv(e - b, size));
  }
  return a;
}

void *omni_tchk(char *a) {
  if (a == 0) omni_error("null pointer dereference");
  return a;
}

int64_t omni_psub(char *pa, char *pb, char *pe, char *qa, char *qb, char *qe, int64_t size) {
  if (pb != qb || pe != qe) omni_error("pointer difference across different blocks");
  return (pa - qa) / size;
}
