/* `<sys/types.h>` —— arm64-osx 的那一份（交叉编译用）。
 *
 * 量到的（`src/sysroot/offsets.c` 在这台机器上跑）：`long` 8、指针 8、
 * `long double` **8**（arm64 macOS 上它就是 double —— 与 x86_64 的 80 位不同）。
 * 类型的底层宽窄照 SDK 的 `sys/_types/`：`ino_t` 是 64 位、`dev_t` 是 **int32**、
 * `mode_t` 是 **uint16** —— 与 glibc 那一份都不一样，`struct stat` 的布局就是这么来的。 */
#ifndef _SYS_TYPES_H
#define _SYS_TYPES_H

#include <stddef.h>

typedef int dev_t;
typedef unsigned long long ino_t;
typedef unsigned short mode_t;
typedef unsigned short nlink_t;
typedef unsigned int uid_t;
typedef unsigned int gid_t;
typedef long long off_t;
typedef int pid_t;
typedef int blksize_t;
typedef long long blkcnt_t;
typedef long time_t;
typedef unsigned long clock_t;
typedef int suseconds_t;

#endif
