/* 线性内存（ADR-0017 第二刀）。**一个进程一块**，按字节寻址，长度是 64KB 页的整数倍。
 *
 * 形状照 wasm 规范：`omni_lin_grow` 只增不减、加不了回 -1（不报错，让调用方查），
 * 越界访问是运行期错误。第 0 页整页保留不用 —— C 的空指针要能与地址 0 区分。
 *
 * 与 omni_mem.c 的 arena 是两件事：arena 是"编译器自己怎么分配"，这一块是**被编译的程序**
 * 看见的那片字节。所以它不走 omni_alloc：它要能 grow（realloc 语义），而 arena 从不释放。
 *
 * 与另外两份实现（interp/builtin.js 的 memChk/MEM_LD/MEM_ST、backend-js 的 prelude）
 * 的判据是 tests/sexpr 那一轴：同一段 sx 在五条腿上输出逐字节相同，**越界那句话也逐字节
 * 相同** —— 所以下面这条消息的格式（`memory access out of bounds: 地址+字节数 (size 总数)`）
 * 三处不许分叉。
 *
 * 字节序：这条腿是**本机字节序**（直接按类型指针读写），而 wasm 与 JS 那两条腿是固定小端。
 * 在小端机上两者一致，这是当下所有目标（x86_64 / arm64）的情形。大端机上要改的是这里 ——
 * 每条访问加一次字节翻转。`omni_lin_init` 里有一句显式的检查，别让那天静悄悄地过去。
 */
#include "omni.h"

#define OMNI_LIN_PAGE ((int64_t)65536)
#define OMNI_LIN_MAX_PAGES ((int64_t)65536) /* wasm32 的天花板：4GB */

unsigned char *omni_lin_base = NULL;
static int64_t omni_lin_bytes = 0;
static int64_t omni_lin_max = 0; /* 页上界；0 = 不设 */

void omni_lin_init(int64_t minPages, int64_t maxPages) {
  /* 小端检查：这条腿按本机字节序读写，另外两条固定小端。大端机上两者会分叉，
     而那种分叉在测试里表现成"某个字段读出来是反的"，极难定位 —— 所以当场停下。 */
  uint32_t probe = 1;
  if (*(unsigned char *)&probe != 1) omni_error("linear memory requires a little-endian host");
  omni_lin_bytes = minPages * OMNI_LIN_PAGE;
  omni_lin_max = maxPages;
  omni_lin_base = (unsigned char *)calloc((size_t)(omni_lin_bytes ? omni_lin_bytes : 1), 1);
  if (!omni_lin_base) omni_error("out of memory");
}

void omni_lin_data(int64_t off, const unsigned char *bytes, int64_t n) {
  if (!omni_lin_base) omni_error("memory access without a memory");
  if (off < 0 || off + n > omni_lin_bytes) {
    omni_errorf("data segment does not fit in memory: %lld+%lld (size %lld)",
                (long long)off, (long long)n, (long long)omni_lin_bytes);
  }
  memcpy(omni_lin_base + off, bytes, (size_t)n);
}

int64_t omni_lin_size(void) { return omni_lin_bytes / OMNI_LIN_PAGE; }

int64_t omni_lin_grow(int64_t add) {
  if (!omni_lin_base) omni_error("memory access without a memory");
  int64_t old = omni_lin_bytes / OMNI_LIN_PAGE;
  if (add < 0) return -1;
  int64_t want = old + add;
  if (want > OMNI_LIN_MAX_PAGES) return -1;
  if (omni_lin_max != 0 && want > omni_lin_max) return -1;
  if (add == 0) return old;
  unsigned char *nb = (unsigned char *)realloc(omni_lin_base, (size_t)(want * OMNI_LIN_PAGE));
  if (!nb) return -1; /* 加不了就是加不了 —— 与 JS 那两条腿同一个立场，不报错 */
  memset(nb + omni_lin_bytes, 0, (size_t)((want - old) * OMNI_LIN_PAGE));
  omni_lin_base = nb;
  omni_lin_bytes = want * OMNI_LIN_PAGE;
  return old;
}

/* 越界检查 + 算地址。回的是可以直接读写的指针，于是每条访问只多一次调用、
   不必把宽度与符号也带进运行时（那些在生成的代码里是编译期常量）。 */
void *omni_lin_at(int64_t addr, int64_t bytes) {
  if (!omni_lin_base) omni_error("memory access without a memory");
  if (addr < 0 || addr + bytes > omni_lin_bytes) {
    omni_errorf("memory access out of bounds: %lld+%lld (size %lld)",
                (long long)addr, (long long)bytes, (long long)omni_lin_bytes);
  }
  return omni_lin_base + addr;
}
