/* 三份 POSIX 的头叠起来（第八十八片）：`<sys/types.h>` 里那一堆 `sys/_types/*.h`
 * 是一层套一层的守卫，`<unistd.h>` 与 `<fcntl.h>` 又都要它 —— 也就是说
 * `#pragma once` / `#ifndef` 守卫认不准的话，这一份立刻会多印出几百行。 */
#include <sys/types.h>
#include <unistd.h>
#include <fcntl.h>

pid_t self;
off_t where;
mode_t how;
ssize_t n;
