/* 第二份对照程序（ADR-0013）：**内存密集**的那一形状。
 *
 * `fib.c` 量的是算术与调用；这一份量的是**线性内存的读写** —— 而那正是 JS 那两条路
 * （编成 JS / 解释器）与本机差得最多的地方：一次 `MLOAD` 在 JS 侧是
 * `DataView.getInt32` 加一次越界检查，在本机上是一条 `ldr`。
 *
 * 三段，都只用 stdio：
 *   - 埃拉托斯特尼筛（2e6）：连续的字节写 + 跳步写。
 *   - 一遍字符串处理：`memcpy` / `strlen` 那一族走的是同一块线性内存。
 *   - 一次自己写的插入排序：随机访问 + 交换。
 * 输出必须与别的路逐字节相同（对照测试的本体是「答案一样」）。
 */
#include <stdio.h>
#include <string.h>

#define N 2000000
static char sieve[N + 1];

static int primes(void) {
  int count = 0;
  for (int i = 2; i <= N; i++) sieve[i] = 1;
  for (int i = 2; (long long)i * i <= N; i++) {
    if (!sieve[i]) continue;
    for (int j = i * i; j <= N; j += i) sieve[j] = 0;
  }
  for (int i = 2; i <= N; i++) count += sieve[i];
  return count;
}

/* 字符串那一段：抄进缓冲、量长度、按字节求和。走的是 memcpy/strlen 的那条 libc 边界。 */
static unsigned long strwork(void) {
  char buf[64];
  unsigned long acc = 0;
  for (int i = 0; i < 200000; i++) {
    snprintf(buf, sizeof(buf), "row-%d-%d", i, i % 7);
    size_t n = strlen(buf);
    for (size_t k = 0; k < n; k++) acc += (unsigned char)buf[k];
  }
  return acc;
}

/* 插入排序：随机访问 + 交换，1500 个元素（O(n²) 约 110 万次比较）。 */
static long long sortwork(void) {
  int a[1500];
  for (int i = 0; i < 1500; i++) a[i] = (i * 7919 + 13) % 100003;
  for (int i = 1; i < 1500; i++) {
    int v = a[i];
    int j = i - 1;
    while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; }
    a[j + 1] = v;
  }
  long long s = 0;
  for (int i = 0; i < 1500; i++) s += (long long)a[i] * (i + 1);
  return s;
}

int main(void) {
  printf("%d\n", primes());
  printf("%lu\n", strwork());
  printf("%lld\n", sortwork());
  return 0;
}
