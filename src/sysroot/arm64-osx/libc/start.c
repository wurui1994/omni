/* start.c — arm64 macOS 的入口（第一百四十片第五格）。
 *
 * 内核跳到 `_start` 时 sp 指着 argc（与 Linux 同一张栈图：argc、argv…、NULL、
 * envp…、NULL，Darwin 后面还接一串 `apple[]`，我们不用）。
 *
 * 这条腿的序言一律 `stp x29, x30, [sp, #-16]!` 加 `mov x29, sp`（见
 * `arm64/from_mir.js` 的 `emitPrologue`），推完那一对之后：
 *   [x29 + 0]  = 推进去的旧 x29
 *   [x29 + 8]  = 推进去的 lr
 *   [x29 + 16] = argc          <- x86_64 那边是 [rbp + 8]，差的正是 lr 也占一格
 *   x29 + 24   = argv 的第一格
 *
 * `__builtin_frame_address(0)` 就是 x29（`OP.FPGET`），所以这一份与 x86_64 那一份
 * 只差两个偏移 —— 也正因为差这两个，start.c 是**目标专有**的，没法进公用那一半。
 */
extern int main(int argc, char **argv);
extern char **environ;
extern void exit(int code);

/* **LC_MAIN 的入口是「像 main 一样被调用的」**：argc 在 x0、argv 在 x1、envp 在 x2
 * （Darwin 那边这一格由 dyld/内核摆好，不是 Linux 那样让你自己去栈上捞）。
 * 所以这一份不用 `__builtin_frame_address` —— 直接按形参收。
 * 量出来的：按栈上捞那一版印的是 `argc=0`。 */
void _start(int argc, char **argv, char **envp) {
  environ = envp;
  exit(main(argc, argv));
  for (;;) __omni_syscall(1, 0);   /* exit —— 到不了 */
}
