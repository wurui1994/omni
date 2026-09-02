/* 真的系统头（macOS SDK 那一摊），第九刀第八十八片。
 *
 * 这一组的尺子是 `tcc -E -P`：同一份 `.c`，两边各自**自己去找** `<stdint.h>` ——
 * 谁都没有 `-I`。找到的必须是同一份文件，读进来的宏、`#if` 分支、`__has_include`
 * 的答案也必须一模一样，输出才会逐字节相同（这一份展开出来一百多行）。
 *
 * 刻意只用 SDK 里独有的头：`<stddef.h>` 一族我们自己带（与 tcc 的 `{B}/include`
 * 同一格），而做尺子的那个 tcc 是**没装**的（`/usr/local/lib/tcc/include` 不存在），
 * 于是它那一格会落空、一路掉到 SDK 上 —— 拿 `-B` 指一个 `include/` 真在的树，
 * 它就跟我们一样先用自己那份。差的是「装没装」，不是搜索顺序。 */
#include <stdint.h>

int32_t i32 = -1;
uint64_t u64 = 2;
intptr_t ip = 0;
int8_t small = INT8_MAX;
uint32_t wide = UINT32_MAX;
