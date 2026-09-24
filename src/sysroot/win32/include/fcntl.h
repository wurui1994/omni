/* `<fcntl.h>` —— win32 的那一份（两个 arch 共用）（交叉编译用；形状沿用 Linux 那一套，见 ../README.md）。
 *
 * 值照 `asm-generic/fcntl.h`（x86 那一支就是通用那一份）：`O_CREAT` 0100、
 * `O_TRUNC` 01000 —— 与 macOS 的 0x0200 / 0x0400 不同，这正是「头必须按目标走」
 * 的一格实例。 */
#ifndef _FCNTL_H
#define _FCNTL_H

#include <sys/types.h>

#define O_RDONLY 0
#define O_WRONLY 1
#define O_RDWR   2
#define O_CREAT  0100
#define O_TRUNC  01000
#define O_APPEND 02000

int open(const char *path, int flags, ...);

#endif
