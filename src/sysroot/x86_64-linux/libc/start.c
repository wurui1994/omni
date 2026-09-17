/* start.c — 自带 libc 的入口（第一百四十片）。
 *
 * 内核跳到 `_start` 时 argc/argv 在栈上（`[rsp]` 是 argc），而 C 函数的序言已经动过
 * rsp —— 纯 C 读不回来。所以这一份**先不取 argc/argv**，传 `0` / `NULL`：
 * 真正的解法与 `__dso_handle` 同一个手法（让链接器自己发那几条指令），那要先有
 * 汇编器那一格。
 *
 * 它比 `lib/crt1.c` 强的地方在**不碰 glibc**：收场走 `exit_group` 那条 syscall，
 * 不经过 `__libc_start_main`。于是链出来的东西是纯静态的 —— 容器里量到
 * `ldd` 说 `statically linked`。
 */
extern int main(int argc, char **argv);

void _start(void) {
  int r = main(0, (char **)0);
  __omni_syscall(231, r);           /* exit_group */
  for (;;) __omni_syscall(60, r);   /* exit —— 到不了，只是让这儿没有 return */
}
