/* crt1.c — 最小的 `_start`，替代 glibc 的 crt1.o。
 *
 * 内核把控制权交到 `_start` 时 argc/argv 躺在栈上（`[rsp]` 是 argc），**没有返回地址**
 * —— 内核是跳过来的，不是 call 过来的。我们的序言一律 `push rbp; mov rbp, rsp`
 * （见 `x64/from_mir.js` 文件头「一、帧靠 rbp」），推那一格之后 rbp 指着它，于是
 * `[rbp+8]` 是 argc、`rbp+16` 是 argv 的第一格。
 *
 * `__builtin_frame_address(0)` 就是 rbp（tcc 那边也是：`tccgen.c:5867` 的
 * `vset(&type, VT_LOCAL, 0)`），所以这一份**用纯 C 就把 argc/argv 找回来了**
 * —— 不欠汇编器（第一百四十片第二格；在这之前它传的是 `0` / `NULL`）。
 *
 * 后四个实参 glibc 2.34+ 忽略，但 ABI 上还得给。写成 C 而不是汇编：我们的 C 前端
 * 加 x86_64 代码生成能出这个 `.o`，于是交叉编译时不需要拷贝目标平台的二进制。
 */
extern int main(int argc, char **argv);
extern int __libc_start_main(
  int (*main)(int, char **),
  int argc,
  char **argv,
  void (*init)(void),
  void (*fini)(void),
  void (*rtld_fini)(void),
  void *stack_end);

void _start(void) {
  char *fp = (char *)__builtin_frame_address(0);
  int argc = *(int *)(fp + 8);
  char **argv = (char **)(fp + 16);
  __libc_start_main(main, argc, argv, 0, 0, 0, 0);
}
