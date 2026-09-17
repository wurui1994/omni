/* crt1.c — 最小的 `_start`，替代 glibc 的 crt1.o。
 *
 * 内核把控制权交到 `_start` 时栈上的布局（x86_64 SysV ABI）：
 *   [rsp]   = argc
 *   [rsp+8] = argv[0]
 *   ...
 *
 * 我们只要做一件事：调 `__libc_start_main(main, argc, argv, 0, 0, 0, 0)`
 * （后四个参数在 glibc 2.34+ 被忽略，但 ABI 上还得给）。
 *
 * 写成 C 而不是汇编：我们的 C 前端 + x86_64 代码生成能出这个 `.o`，
 * 于是交叉编译时完全不需要拷贝目标平台的二进制。
 *
 * `_start` 不能声明成普通函数（它没有返回地址）—— 但在**我们的代码生成**里
 * 这一格不要紧：入口符号由链接器的 `-e` 指，而 `__libc_start_main` 不会返回
 * （它在 `main` 返回之后自己调 `exit`）。 */
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
  /* 这一段**取不到真的 argc/argv**：C 函数的 prologue 已经动了 rsp。
   * 实际做法是用内联汇编或直接发机器码 —— 但我们的 C 前端不支持内联汇编。
   *
   * 所以这一份只是一个**占位**：编出来的 `.o` 提供 `_start` 这个符号，
   * 里头调 `__libc_start_main`；但 argc/argv 的取法需要汇编。
   *
   * **真正的解决**是在链接器那一层自己发那几条指令（与 `__dso_handle` 同一个手法：
   * 链接器合成的符号）。但这一步先让流程跑通。 */
  __libc_start_main(main, 0, (char **)0, 0, 0, 0, 0);
}
