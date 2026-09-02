/* 第一层：盖住 include2 里的那一份，但还要用它 —— `#include_next` 从**我自己**
   是在哪一格找到的之后接着找，于是拿到 include2/next.h（不会又找回自己）。 */
#define NEXT_OUTER 1
#include_next <next.h>
int outer_after_inner = NEXT_INNER + 1;
