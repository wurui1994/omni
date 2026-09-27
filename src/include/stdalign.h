/* <stdalign.h> —— 自带的那一份（ADR-0047 第十五格）。
 *
 * C11 7.15：这份头里**四个名字全是宏**，真东西是 `_Alignas` / `_Alignof` 两个关键字
 * （我们的 `TOK_ALIGNAS` / `TOK_ALIGNOF3`，早就认）。所以这一份只做改名，一行代码都不新增。
 *
 * 逼出它的是 R 的 `src/main/memory.c`（`#include <stdalign.h>` 之后用 `alignof`）——
 * 系统那份 `<stdalign.h>` 在 clang 的资源目录里（`/…/lib/clang/17/include`），
 * 那不是 SDK 的 `usr/include`，我们的搜索路径上没有它。自带一份比去猜 clang 的版本目录稳。 */
#ifndef _STDALIGN_H
#define _STDALIGN_H

#define alignas _Alignas
#define alignof _Alignof
#define __alignas_is_defined 1
#define __alignof_is_defined 1

#endif /* _STDALIGN_H */
