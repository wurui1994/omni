/* <errno.h> —— 那一格与那几个数（ADR-0017 第八刀第八片）。
 *
 * C 要求 `errno` 是一个**可改的左值**（`errno = 0` 得能写），所以它不能是一个函数调用。
 * 形状照 glibc：`errno` 是宏，展开成 `(*__omni_errno_location())`，那个函数回一个指进
 * 线性内存的 `int *`。那一格由**前端**在 data 段里留（版图是前端定的），开跑前用一条
 * `__omni_errno_init` 把地址交给宿主 —— 与第十五片的堆完全同一个形状。
 *
 * 出生时是 0：线性内存出生全是 0，而 C 正好要求「程序启动时 errno 是 0」（C11 7.5）。
 *
 * 那几个数照本机的 `<sys/errno.h>` 量的（`tcc -run` 印出来对过）。**只放我们真的会设的
 * 与常用的几个** —— 一整张表有八十多个，而多出来的那些没有一个地方会写它们。
 *
 * `strerror` 在 `<string.h>` 里、`perror` 在 `<stdio.h>` 里（标准就是这么分的），
 * 那张号到文字的表在 `interp/libc.js` 里，整张都是从 oracle 上量出来的（第十三片）。
 */
#ifndef _ERRNO_H
#define _ERRNO_H

int *__omni_errno_location(void);

#define errno (*__omni_errno_location())

#define EPERM 1
#define ENOENT 2
#define EINTR 4
#define EIO 5
#define ENOMEM 12
#define EACCES 13
#define EEXIST 17
#define EINVAL 22
#define EDOM 33
#define ERANGE 34

#endif /* _ERRNO_H */
