/* 第八刀第八片：`<errno.h>` —— 第一次因为库面而动前端。
 *
 * `errno` 得是一个**可改的左值**，所以宿主那边一个变量不行。形状照 glibc：
 * `errno` 是宏，展开成 `(*__omni_errno_location())`，那一格在 data 段里，
 * 由入口处一条 `__omni_errno_init` 把地址交给宿主 —— 与第十五片的堆同一个形状。
 *
 * 这一片把第四片欠下的那一格补上了：`strtol` 溢出时设 `ERANGE`，于是**溢出的输入
 * 现在也能与 tcc 对账**。tcc 那一侧用的是本机真的 libc 与真的 errno。
 *
 * 读 errno 之后再 printf：C 只保证库函数**可以**设 errno、不保证不设，所以
 * 每次都先把它收进一个变量再印。
 */
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>

int main(void) {
  /* ---- 出生时是 0，而且能写能读 */
  printf("start %d\n", errno);
  errno = EINVAL;
  printf("set %d %d\n", errno, errno == EINVAL);
  errno = 0;
  printf("clear %d\n", errno);

  /* ---- 那几个数（照本机的 <sys/errno.h>） */
  printf("nums %d %d %d %d %d\n", EPERM, ENOENT, ENOMEM, EDOM, ERANGE);

  /* ---- strtol 溢出：回 LONG_MAX / LONG_MIN 并设 ERANGE */
  errno = 0;
  long big = strtol("99999999999999999999", NULL, 10);
  int e1 = errno;
  printf("over %ld %d\n", big, e1 == ERANGE);

  errno = 0;
  long small = strtol("-99999999999999999999", NULL, 10);
  int e2 = errno;
  printf("under %ld %d\n", small, e2 == ERANGE);

  /* 正好在边界上：**不算**溢出，errno 不动 */
  errno = 0;
  long edge = strtol("9223372036854775807", NULL, 10);
  int e3 = errno;
  printf("edge %ld %d\n", edge, e3);

  /* 没溢出的一次也不该动它 */
  errno = 0;
  long ok = strtol("123", NULL, 10);
  int e4 = errno;
  printf("fine %ld %d\n", ok, e4);

  /* strtoul 收负号是合法的，**不设** errno */
  errno = 0;
  unsigned long neg = strtoul("-1", NULL, 10);
  int e5 = errno;
  printf("ulneg %d %d\n", neg == 18446744073709551615UL, e5);

  /* strtoul 真溢出时照样设 */
  errno = 0;
  unsigned long ubig = strtoul("99999999999999999999999", NULL, 10);
  int e6 = errno;
  printf("uover %d %d\n", ubig == 18446744073709551615UL, e6 == ERANGE);

  /* ---- errno 是左值，所以 ++ / += 这些都能用在它身上 */
  errno = 0;
  errno += 3;
  errno++;
  int *p = &errno;
  *p = *p * 2;
  printf("lvalue %d\n", errno);

  return (e1 == ERANGE) + (e2 == ERANGE) + errno;
}
