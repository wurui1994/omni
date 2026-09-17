/* `<signal.h>` —— x86_64-linux 的那一份（交叉编译用）。
 *
 * struct sigaction：量到 sizeof=152。sa_handler=0, sa_mask=8 (sigset_t=128 bytes),
 * sa_flags=136。运行时只用 `sigaction`、`kill`、`SIGALRM`、`SIGKILL`。 */
#ifndef _SIGNAL_H
#define _SIGNAL_H

#include <sys/types.h>

#define SIGALRM 14
#define SIGKILL 9

typedef struct { unsigned long int __val[16]; } sigset_t;  /* 128 bytes */

struct sigaction {
  void (*sa_handler)(int);
  sigset_t sa_mask;               /* offset 8, size 128 */
  int sa_flags;                   /* offset 136 */
  void (*sa_restorer)(void);      /* offset 144 */
};

int sigaction(int sig, const struct sigaction *act, struct sigaction *old);
int kill(pid_t pid, int sig);

#endif
