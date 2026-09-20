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

/* 按调用栈归属分配（`OMNI_MEM_DEBUG=4`）要它。只在量口那条路上用，平时一个符号都不碰。 */
#include <execinfo.h>

/* class 引用的显式空检查（`omni_nullck`）挪去 omni.h 当 static inline 了 ——
   它是生成代码里最密的一个调用，跨编译单元内联不了就只剩纯调用开销（见那儿的注）。 */

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

/* ASan 那条路上没有 arena，mark/release 就是空操作（回 -1，release 什么都不做）。 */
int64_t omni_arena_mark(void) { return -1; }
int64_t omni_arena_release(int64_t m) { (void)m; return 0; }

#else

typedef struct omni_arena_block {
  struct omni_arena_block *next;
  char *base;
} omni_arena_block;

/* mark/release 的存档点。定义提到这儿来，因为按线程分的那一份状态里要摆一摞。 */
#define OMNI_MARK_MAX 64
typedef struct {
  omni_arena_block *head;
  char *ptr;
  char *end;
} omni_arena_savepoint;

/* 四格都按线程分（见 omni.h 上 `OMNI_TLS` 那段账）：每条线程自己一条块链、自己一格
   bump 指针、自己一摞存档点，于是不必加锁。块仍旧从线程那一份状态可达，
   LeakSanitizer 不会报泄漏。 */
#ifdef OMNI_NO_TLS
/* 不认 `_Thread_local` 的编译器（我们自己的 C 前端、tcc）走 pthread 的 TSD。 */
#include <pthread.h>

typedef struct {
  omni_arena_tp tp;                          /* 头一格：omni_arena_slot 回的就是它 */
  omni_arena_block *head;
  omni_arena_savepoint marks[OMNI_MARK_MAX];
  int nmark;
} omni_arena_state;

/* 键只建一次。**没有用 pthread_once**：我们自己那条腿的 sysroot 里还没有它那格
   不透明类型，而这儿的窗口只有"进程里第一次分配"那一瞬 —— 那时只有一条线程在跑
   （go 这条腿的 worker 是 `omni_sched_init` 之后才起的，而 main 早就分配过了）。
   万一真撞上，后果是有一条线程的那份状态被丢掉重建（漏一块，不会把同一块内存
   发给两边），不是错答案。 */
static pthread_key_t omni_arena_key;
static int omni_arena_keyed = 0;

static omni_arena_state *omni_arena_get(void) {
  if (!omni_arena_keyed) {
    if (pthread_key_create(&omni_arena_key, NULL) != 0) omni_error("out of memory");
    omni_arena_keyed = 1;
  }
  omni_arena_state *s = (omni_arena_state *)pthread_getspecific(omni_arena_key);
  if (s == NULL) {
    s = (omni_arena_state *)calloc(1, sizeof *s);
    if (s == NULL) omni_error("out of memory");
    pthread_setspecific(omni_arena_key, s);
  }
  return s;
}

omni_arena_tp *omni_arena_slot(void) { return &omni_arena_get()->tp; }
#define OMNI_AHEAD (omni_arena_get()->head)
#define OMNI_AMARKS (omni_arena_get()->marks)
#define OMNI_ANMARK (omni_arena_get()->nmark)
#else
OMNI_TLS char *omni_arena_ptr = NULL;
OMNI_TLS char *omni_arena_end = NULL;
static OMNI_TLS omni_arena_block *omni_arena_head = NULL;static OMNI_TLS omni_arena_savepoint omni_marks[OMNI_MARK_MAX];
static OMNI_TLS int omni_nmark = 0;
#define OMNI_AHEAD omni_arena_head
#define OMNI_AMARKS omni_marks
#define OMNI_ANMARK omni_nmark
#endif

#define OMNI_BLOCK_MIN ((size_t)1 << 20)  /* 1 MiB：小到不浪费，大到几乎不触发慢路径 */

/* 量口（`OMNI_MEM_DEBUG=1`）：退出时印"一共开了多少块、多少字节"。
 * arena 永不回收，所以"申请了多少"就是峰值 —— 三维那一族在 run-c 上被 OOM 杀掉时
 * （量到过：BezierPatch 7.6s 申请 43GB），先看这两个数落在哪一档。
 * 平时一个原子变量都不加：计数只在开新块那条慢路径上动，热路径（bump 指针）一个字不改。 */
static size_t omni_arena_nblock = 0;
static size_t omni_arena_bytes = 0;
static int omni_arena_reported = 0;

/* 分配的量口（`OMNI_MEM_DEBUG=3`）。arena 那两个数只说得出"开了多少块"，
   而"一趟 emit-c 申请 11 GB"到底是几千万次多大的分配 —— 那张表才决定动哪一头：
   `omni_grow`（这条路上它是"新开一块、拷过去、丢掉旧的"），还是"一格小记录要五次分配"
   （AST 每个节点 / token / span 都是一格哈希表，struct + keys + vals + live + idx）。
   桶 b 覆盖 (16<<(b-1), 16<<b]，b=0 是 <=16 字节。 */
int omni_mem_count_on = 0;
static uint64_t omni_mem_calls = 0;
static uint64_t omni_mem_req = 0;
#define OMNI_MEM_NBUCKET 24
static uint64_t omni_mem_hist[OMNI_MEM_NBUCKET];

/* ---- 按**调用栈**归属（`OMNI_MEM_DEBUG=4`，采样间隔看 OMNI_MEM_EVERY，默认 1000）
 *
 * 为什么必须有这一格：大小直方图只说得出"多大"，说不出"谁"。靠"88% 是小块所以大概是
 * 实参 list"去改代码就是猜 —— 已经猜错过两次（dict 并排存哈希、实参 list 上栈），
 * 两次都只动了百分之几。这儿采样 `backtrace()` 再按栈聚合，答案是**量出来的**：
 * 哪一条 JS 级函数、经过哪几层运行时，一共分配了多少次、多少字节。
 * -O0 有帧指针，所以 backtrace 拿得到；每 N 次才采一次，热路径上只多一次取模。 */
#define OMNI_BT_DEPTH 10
#define OMNI_BT_SLOTS 8192
typedef struct {
  void *fr[OMNI_BT_DEPTH];
  int n;
  uint64_t count;
  uint64_t bytes;
} omni_bt_entry;
static omni_bt_entry omni_bt_tab[OMNI_BT_SLOTS];
static int omni_bt_used = 0;
static uint64_t omni_bt_every = 0;   /* 0 = 不采 */
static uint64_t omni_bt_seen = 0;
static uint64_t omni_bt_taken = 0;

static void omni_bt_sample(size_t n) {
  void *fr[OMNI_BT_DEPTH + 3];
  int got = backtrace(fr, OMNI_BT_DEPTH + 3);
  /* 跳掉 backtrace / omni_bt_sample / omni_mem_note 这三层 —— 它们对谁都一样 */
  int skip = got > 3 ? 3 : 0;
  int m = got - skip;
  if (m > OMNI_BT_DEPTH) m = OMNI_BT_DEPTH;
  if (m <= 0) return;
  uint64_t h = 1469598103934665603ULL;
  for (int i = 0; i < m; i++) {
    h ^= (uint64_t)(uintptr_t)fr[skip + i];
    h *= 1099511628211ULL;
  }
  omni_bt_taken++;
  int slot = (int)(h & (OMNI_BT_SLOTS - 1));
  for (int probe = 0; probe < OMNI_BT_SLOTS; probe++) {
    omni_bt_entry *e = &omni_bt_tab[slot];
    if (e->n == 0) {
      memcpy(e->fr, fr + skip, sizeof(void *) * (size_t)m);
      e->n = m;
      e->count = 1;
      e->bytes = (uint64_t)n;
      omni_bt_used++;
      return;
    }
    if (e->n == m && memcmp(e->fr, fr + skip, sizeof(void *) * (size_t)m) == 0) {
      e->count++;
      e->bytes += (uint64_t)n;
      return;
    }
    slot = (slot + 1) & (OMNI_BT_SLOTS - 1);
  }
}

void omni_mem_note(size_t n) {
  int b = 0;
  while (b + 1 < OMNI_MEM_NBUCKET && n > ((size_t)16 << b)) b++;
  omni_mem_calls++;
  omni_mem_req += (uint64_t)n;
  omni_mem_hist[b]++;
  if (omni_bt_every != 0 && ++omni_bt_seen % omni_bt_every == 0) omni_bt_sample(n);
}

/* 只印一个函数名：backtrace_symbols 那一行是
   "3   omni   0x0000000100a24f98 omni_js_arr_of + 52"，取倒数第三段。 */
static void omni_bt_print_frame(const char *sym) {
  const char *plus = strrchr(sym, '+');
  const char *end = plus ? plus : sym + strlen(sym);
  while (end > sym && (end[-1] == ' ' || end[-1] == '\t')) end--;
  const char *beg = end;
  while (beg > sym && beg[-1] != ' ' && beg[-1] != '\t') beg--;
  fprintf(stderr, "%.*s", (int)(end - beg), beg);
}

static void omni_bt_report(void) {
  if (omni_bt_taken == 0) return;
  /* 按次数排：只印前 24 条栈，尾巴太长没人看 */
  int order[OMNI_BT_SLOTS];
  int m = 0;
  for (int i = 0; i < OMNI_BT_SLOTS; i++) if (omni_bt_tab[i].n != 0) order[m++] = i;
  for (int i = 1; i < m; i++) {
    int k = order[i], j = i - 1;
    while (j >= 0 && omni_bt_tab[order[j]].count < omni_bt_tab[k].count) { order[j + 1] = order[j]; j--; }
    order[j + 1] = k;
  }
  fprintf(stderr, "omni_mem: 调用栈归属（每 %llu 次采一次，共采到 %llu 条、%d 个不同的栈）\n",
          (unsigned long long)omni_bt_every, (unsigned long long)omni_bt_taken, m);
  int top = m < 24 ? m : 24;
  for (int i = 0; i < top; i++) {
    omni_bt_entry *e = &omni_bt_tab[order[i]];
    double pct = 100.0 * (double)e->count / (double)omni_bt_taken;
    fprintf(stderr, "omni_mem: [%2d] %5.1f%%  约 %llu 次  约 %.0f MiB\n", i + 1, pct,
            (unsigned long long)(e->count * omni_bt_every),
            (double)(e->bytes * omni_bt_every) / (double)(1u << 20));
    char **syms = backtrace_symbols(e->fr, e->n);
    if (syms == NULL) continue;
    fprintf(stderr, "omni_mem:      ");
    for (int k = 0; k < e->n; k++) {
      if (k > 0) fprintf(stderr, " < ");
      omni_bt_print_frame(syms[k]);
    }
    fprintf(stderr, "\n");
    free(syms);
  }
}

static void omni_mem_count_report(void) {
  if (omni_mem_calls == 0) return;
  fprintf(stderr, "omni_mem: 分配 %llu 次、请求 %.1f MiB（平均 %.1f 字节）\n",
          (unsigned long long)omni_mem_calls,
          (double)omni_mem_req / (double)(1u << 20),
          (double)omni_mem_req / (double)omni_mem_calls);
  for (int b = 0; b < OMNI_MEM_NBUCKET; b++) {
    if (omni_mem_hist[b] == 0) continue;
    fprintf(stderr, "omni_mem:   <=%-9llu %10llu 次  %6.1f%%\n",
            (unsigned long long)((size_t)16 << b),
            (unsigned long long)omni_mem_hist[b],
            100.0 * (double)omni_mem_hist[b] / (double)omni_mem_calls);
  }
  omni_bt_report();
}

static void omni_arena_report(void) {
  if (omni_arena_reported) return;
  omni_arena_reported = 1;
  fprintf(stderr, "omni_mem: arena 块 %zu、字节 %zu（%.1f MiB）\n",
          omni_arena_nblock, omni_arena_bytes,
          (double) omni_arena_bytes / (double) (1u << 20));
  omni_mem_count_report();
}

/* 开一个新块。请求超过块大小时按请求开（大数组也走 arena，不另设 large-object 路径）。 */
static void omni_arena_new_block(size_t n) {
  size_t cap = n + OMNI_ALIGN > OMNI_BLOCK_MIN ? n + OMNI_ALIGN : OMNI_BLOCK_MIN;
  char *base = (char *)malloc(cap);
  if (!base) omni_error("out of memory");
  omni_arena_block *b = (omni_arena_block *)malloc(sizeof *b);
  if (!b) omni_error("out of memory");
  b->base = base;
  b->next = OMNI_AHEAD;
  OMNI_AHEAD = b;  /* 保持全局可达，LeakSanitizer 才不会把它当泄漏 */
  omni_arena_ptr = base;
  omni_arena_end = base + cap;
  if (omni_arena_nblock == 0 && getenv("OMNI_MEM_DEBUG")) {
    const char *d = getenv("OMNI_MEM_DEBUG");
    /* `=3` 连每次分配一起数（热路径上多一格分支，见 omni.h 的 omni_alloc）
       `=4` 再加上按调用栈采样归属 —— 大小直方图说得出"多大"，说不出"谁"。 */
    if (d[0] == '3' || d[0] == '4') omni_mem_count_on = 1;
    if (d[0] == '4') {
      const char *ev = getenv("OMNI_MEM_EVERY");
      long v = ev == NULL ? 0 : strtol(ev, NULL, 10);
      omni_bt_every = v > 0 ? (uint64_t)v : 1000;
    }
    atexit(omni_arena_report);
  }
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

/* ------------------------------------------------------------------ mark/release
 * arena 本来"永不单独释放"，代价是**回标量的深递归**会把垃圾一路堆上去：
 * 量到过 —— asy 的面片求界（asy__sbound，四叉递归、每层新建 15 个数组）在
 * BezierPatch 上堆到 32 GiB 被 OOM 杀掉，而同一份代码在 JS 腿上有 GC 就没事。
 * 所以开一格"作用域"：mark 记下当前位置，release 把之后开的块整块还回去。
 * **契约**：release 之后，那一段里分配的东西一律不能再碰 —— 只用在"回标量"的地方
 * （asy__sbound 回一个 real，什么都不逃逸）。嵌套用栈，满了就退化成"不回收"（回 -1）。
 * mark/release 也按线程分：它记的是**这条线程**的 arena 位置（存档点的类型与那一摞
 * 在文件头上按线程分那一段里）。 */
int64_t omni_arena_mark(void) {
  if (OMNI_ANMARK >= OMNI_MARK_MAX) return -1;
  int i = OMNI_ANMARK;
  OMNI_AMARKS[i].head = OMNI_AHEAD;
  OMNI_AMARKS[i].ptr = omni_arena_ptr;
  OMNI_AMARKS[i].end = omni_arena_end;
  OMNI_ANMARK = i + 1;
  return (int64_t)i;
}

int64_t omni_arena_release(int64_t m) {
  if (m < 0 || m >= (int64_t)OMNI_ANMARK) return 0;
  omni_arena_savepoint *k = &OMNI_AMARKS[(int)m];
  while (OMNI_AHEAD != k->head) {
    omni_arena_block *b = OMNI_AHEAD;
    OMNI_AHEAD = b->next;
    free(b->base);
    free(b);
  }
  omni_arena_ptr = k->ptr;
  omni_arena_end = k->end;
  OMNI_ANMARK = (int)m;
  return 0;
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
