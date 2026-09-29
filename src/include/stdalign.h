/* <stdalign.h> —— 自带的那一份（C11 7.15）
 *
 * 与 `stdbool.h` 同一种性质：标准说它只是给关键字起个小写名字。我们那台前端本来就认
 * `_Alignas` / `_Alignof`（`tests/c` 里量过），缺的只是这份头 —— 于是 C11 的代码
 * `#include <stdalign.h>` 会当场停在"头文件不在"上。四个名字全是宏，真东西是那两个
 * 关键字，所以这一份只做改名，一行代码都不新增。
 *
 * 逼出它的有两家：Cython 出的那三十万行（`etree.c:7823`，按 C11 走）与 R 的
 * `src/main/memory.c`（`#include <stdalign.h>` 之后用 `alignof`）。系统里那份
 * `stdalign.h` 属于编译器自带头（clang 的 resource dir），不在 SDK 里，
 * 所以借系统的那条路走不通：这一份必须由我们给。
 */
#ifndef _OMNI_STDALIGN_H
#define _OMNI_STDALIGN_H

#ifndef __cplusplus

#define alignas _Alignas
#define alignof _Alignof

#define __alignas_is_defined 1
#define __alignof_is_defined 1

#endif /* !__cplusplus */

#endif /* _OMNI_STDALIGN_H */
