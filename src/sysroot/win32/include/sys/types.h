/* `<sys/types.h>` —— x86_64-linux 的那一份（交叉编译用，见 `src/sysroot/README.md`）。
 *
 * 只留我们的运行时用得着的那些 typedef，底层类型照 glibc 的 x86_64 那一支
 * （`bits/typesizes.h`：`__SLONGWORD_TYPE` 一族在 LP64 上都是 long）。 */
#ifndef _SYS_TYPES_H
#define _SYS_TYPES_H

/* `ssize_t`：POSIX 的"能带 -1 的大小"。我们这套头里一直没有它 —— 自带那台 C 前端
 * 自己预定义（tcc 的那批内建 typedef），所以从来没露出来。`--cc msvc` 那条腿换了
 * 编译器，这一格就得自己说：LLP64 上是 64 位有符号。 */
#ifdef _MSC_VER
#ifndef _SSIZE_T_DEFINED
#define _SSIZE_T_DEFINED
typedef long long ssize_t;
#endif
#endif


#include <stddef.h>

typedef unsigned long int dev_t;
typedef unsigned long int ino_t;
typedef unsigned int mode_t;
typedef unsigned long int nlink_t;
typedef unsigned int uid_t;
typedef unsigned int gid_t;
typedef long int off_t;
typedef int pid_t;
typedef long int blksize_t;
typedef long int blkcnt_t;
typedef long int time_t;
typedef long int clock_t;
typedef long int suseconds_t;

#endif
