/* 析构函数：`.fini_array` 在 Mach-O 上不是一节，而是 tcc **当场生成的一段代码** ——
 * 一个 `___GLOBAL_init_65535` 函数，里头对每个析构函数调一次 `___cxa_atexit`，
 * 然后把这个函数自己挂到 `.init_array` 上。于是 `.fini_array` 那一节最后是空的。 */

#include <stdio.h>

static int v = 1;

__attribute__((constructor)) static void up(void) { v = 10; }
__attribute__((destructor)) static void down(void) { printf("down %d\n", v); }
__attribute__((destructor)) static void down2(void) { printf("down2\n"); }

int main(void) {
  printf("main %d\n", v);
  return 0;
}
