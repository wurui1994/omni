/* `#include_next` 与 `__has_include_next`（第九刀第八十四片）。
   两个 `-I`：`include` 在前、`include2` 在后，两边都有 `next.h`。
   前一份里的 `#include_next <next.h>` 拿到后一份 —— 从「我自己是在第几格找到的」
   之后接着数，所以不会又找回自己。期望值不写在这里：它是 tcc 的输出。 */
#include <next.h>

/* 主文件那一格是 0（tcc 那边是 calloc 出来的），所以这儿的 `__has_include_next` 只
   跳过「绝对路径」那一格，照旧从第一个 `-I` 数起 —— 真。 */
#if __has_include_next(<next.h>)
int main_has_next = 1;
#else
int main_has_next = 0;
#endif

int total = NEXT_OUTER + NEXT_INNER;
