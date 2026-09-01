/* 阶段边界：`__has_include` 要把 include 的搜索接进 `#if` 的求值里 */
#if __has_include(<stddef.h>)
int a = 1;
#endif
