/* 第八刀第二十三片：位域的**访问类型**（`adjust_bf` / `tccgen.c:4366-4436`）。
 *
 * 撞出这一格的是 `-DTCC_TARGET_MACHO` 之下的 `tccmacho.c:2142`：
 *
 *   struct dyld_chained_ptr_64_rebase { uint64_t target:36, high8:8, …; };
 *
 * `high8` 排在第 36 位，而 PCC 那句「装得下的 long long 位域按 int 算」
 * 已经把它的类型改成了 4 字节 —— 36 + 8 越过 32，按声明的类型读不出来。
 * tcc 的收尾会给它挑一个别的访问类型（这儿是 2 字节、偏移 4、位置 4）。
 */
#include <stdio.h>

/* ---- dyld 那一份，一个 64 位容器摊成五格 */
struct rebase {
  unsigned long long target : 36;
  unsigned long long high8 : 8;
  unsigned long long reserved : 7;
  unsigned long long next : 12;
  unsigned long long bind : 1;
};

/* ---- 各种宽度混在一起：容器该换的地方要换 */
struct mixed {
  unsigned long long a : 20;
  unsigned long long b : 20;
  unsigned long long c : 20;
  unsigned long long d : 4;
};

/* ---- 有符号那一格：读出来要符号扩展，而扩展按**声明的**类型 */
struct signed_bf {
  long long x : 33;
  long long y : 9;
};

int main(void) {
  int sum = 0;

  struct rebase r;
  unsigned long long cur = 0x1234567890abcdefULL;
  r.target = cur & 0xfffffffffULL;
  r.high8 = cur >> 56;
  r.reserved = 0;
  r.next = 0;
  r.bind = 1;
  printf("rebase %zu %llx %llx %llx\n", sizeof(struct rebase),
    (unsigned long long)r.target, (unsigned long long)r.high8,
    (unsigned long long)r.bind);
  /* tccmacho.c 那一句原样：拼回去要等于原来那个数的高 8 位加上 target */
  printf("back %d\n",
    (cur & ~0xffffffffffULL) == 0
      ? 0
      : (((unsigned long long)r.high8 << 56) + r.target) == (cur & 0xff0000000fffffffULL));
  sum += (int)r.high8;

  struct mixed m;
  m.a = 0xabcde;
  m.b = 0x12345;
  m.c = 0xfedcb;
  m.d = 9;
  printf("mixed %zu %llx %llx %llx %llx\n", sizeof(struct mixed),
    (unsigned long long)m.a, (unsigned long long)m.b,
    (unsigned long long)m.c, (unsigned long long)m.d);
  sum += (int)m.d;

  /* 邻居不能被写坏：一格一格写完再全读一遍 */
  m.b = 0;
  printf("after %llx %llx %llx %llx\n", (unsigned long long)m.a,
    (unsigned long long)m.b, (unsigned long long)m.c, (unsigned long long)m.d);
  sum += (int)(m.a & 0xf);

  struct signed_bf s;
  s.x = -3;
  s.y = -200;
  printf("signed %zu %lld %lld\n", sizeof(struct signed_bf),
    (long long)s.x, (long long)s.y);
  sum += (int)(-s.y);

  printf("sum=%d\n", sum);
  return sum & 0xff;
}
