/* `<signal.h>` —— arm64-osx 的那一份（交叉编译用）。
 *
 * 量到的：sigset_t **4 字节**（Linux 上是 128），struct sigaction **16 字节**
 * （Linux 上 152），sa_handler=0 sa_mask=8 sa_flags=12。 */
#ifndef _SIGNAL_H
#define _SIGNAL_H

#include <sys/types.h>

#define SIGALRM 14
#define SIGKILL 9

typedef unsigned int sigset_t;

struct sigaction {
  void (*sa_handler)(int);   /* 0 */
  sigset_t sa_mask;          /* 8 */
  int sa_flags;              /* 12, sizeof = 16 */
};

int sigaction(int sig, const struct sigaction *act, struct sigaction *old);
int kill(pid_t pid, int sig);

#endif
