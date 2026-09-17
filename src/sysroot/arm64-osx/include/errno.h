/* `<errno.h>` —— arm64-osx 的那一份（交叉编译用）。
 *
 * macOS 上 `errno` 是宏，展开成 `(*__error())`（glibc 那边叫 `__errno_location`）。
 * 值照 `sys/errno.h`：`EPIPE` 32、`ERANGE` 34 与 Linux 一样，但**别的不一定** ——
 * 这一份只列运行时用到的那几个。 */
#ifndef _ERRNO_H
#define _ERRNO_H

extern int *__error(void);
#define errno (*__error())

#define EPERM 1
#define ENOENT 2
#define EINTR 4
#define EIO 5
#define EAGAIN 35
#define ENOMEM 12
#define EACCES 13
#define EEXIST 17
#define ENOTDIR 20
#define EISDIR 21
#define EINVAL 22
#define EMFILE 24
#define EPIPE 32
#define ERANGE 34
#define ENAMETOOLONG 63
#define ENOTEMPTY 66

#endif
