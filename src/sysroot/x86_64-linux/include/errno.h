/* `<errno.h>` —— x86_64-linux 的那一份（交叉编译用）。
 *
 * glibc 上 `errno` 是宏，展开成 `(*__errno_location())` —— 那是**每线程一格**，
 * 所以不能是一个普通的 `extern int`。macOS 那边同一件事叫 `__error()`。
 * 值照 `asm-generic/errno-base.h`（Linux 的通用那一套，与体系无关）。 */
#ifndef _ERRNO_H
#define _ERRNO_H

extern int *__errno_location(void);
#define errno (*__errno_location())

#define EPERM 1
#define ENOENT 2
#define EINTR 4
#define EIO 5
#define EAGAIN 11
#define ENOMEM 12
#define EACCES 13
#define EEXIST 17
#define ENOTDIR 20
#define EISDIR 21
#define EINVAL 22
#define EMFILE 24
#define EPIPE 32
#define ERANGE 34
#define ENAMETOOLONG 36
#define ENOTEMPTY 39

#endif
