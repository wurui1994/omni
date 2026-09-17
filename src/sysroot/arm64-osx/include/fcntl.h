/* `<fcntl.h>` —— arm64-osx 的那一份（交叉编译用）。
 * 量到的：`O_CREAT` **512**（0x200）、`O_TRUNC` **1024**（0x400）——
 * Linux 上是 0100 / 01000，一格都对不上。 */
#ifndef _FCNTL_H
#define _FCNTL_H

#include <sys/types.h>

#define O_RDONLY 0
#define O_WRONLY 1
#define O_RDWR   2
#define O_CREAT  512
#define O_TRUNC  1024
#define O_APPEND 8

int open(const char *path, int flags, ...);

#endif
