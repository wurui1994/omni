/* <stdbool.h> —— 自带的那一份（ADR-0017 第八刀第二片）。
 *
 * C99 6.10.8：这份头文件里的四个名字全是宏，`bool` 就是 `_Bool`（我们的 `VT_BOOL`，
 * 存一个字节、赋值时收成 0/1）。`__bool_true_false_are_defined` 是标准点名要的那一条。 */
#ifndef _STDBOOL_H
#define _STDBOOL_H

#define bool _Bool
#define true 1
#define false 0
#define __bool_true_false_are_defined 1

#endif /* _STDBOOL_H */
