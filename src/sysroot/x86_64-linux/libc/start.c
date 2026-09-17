/* start.c — 自带 libc 的入口（第一百四十片）。
 *
 * 内核跳到 `_start` 时栈上的布局（x86_64 SysV ABI）：`[rsp]` 是 argc、`rsp+8` 起是
 * argv。**没有返回地址** —— 内核是跳过来的，不是 call 过来的。
 *
 * 序言一律 `push rbp; mov rbp, rsp`（见 `x64/from_mir.js` 文件头「一、帧靠 rbp」），
 * 推那一格之后 rbp 指着它，于是：
 *   [rbp]    = push 进去的那一格（`_start` 里是内核留的垃圾）
 *   [rbp+8]  = argc
 *   rbp+16   = argv 的第一格
 *
 * `__builtin_frame_address(0)` 就是 rbp（tcc 那边也是：`vset(&type, VT_LOCAL, 0)`，
 * `tccgen.c:5867`）。于是这一份用**纯 C** 就把 argc/argv 找回来了 —— 不欠汇编器。
 *
 * 收场走 `exit_group` 那条 syscall，不经过 `__libc_start_main`：链出来的东西于是是
 * 纯静态的（容器里量到 `ldd` 说 `statically linked`）。
 */
extern int main(int argc, char **argv);

void _start(void) {
  char *fp = (char *)__builtin_frame_address(0);
  int argc = *(int *)(fp + 8);
  char **argv = (char **)(fp + 16);
  int r = main(argc, argv);
  __omni_syscall(231, r);           /* exit_group */
  for (;;) __omni_syscall(60, r);   /* exit —— 到不了 */
}
