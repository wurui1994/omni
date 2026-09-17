/* `<signal.h>` —— x86_64-linux 的那一份（交叉编译用）。
 *
 * struct sigaction：量到 sizeof=152。sa_handler=0, sa_mask=8 (sigset_t=128 bytes),
 * sa_flags=136。运行时只用 `sigaction`、`kill`、`SIGALRM`、`SIGKILL`。
 * `SA_SIGINFO` 故意不给：那要三参数的处理函数，我们那一层只翻译一参数的（明说）。 */
#ifndef _SIGNAL_H
#define _SIGNAL_H

#include <sys/types.h>

#define SIGINT  2
#define SIGKILL 9
#define SIGUSR1 10
#define SIGALRM 14
#define SIGTERM 15

#define SIG_DFL ((void (*)(int))0)
#define SIG_IGN ((void (*)(int))1)

#define SA_RESTART 0x10000000

typedef struct { unsigned long int __val[16]; } sigset_t;  /* 128 bytes */

struct sigaction {
  void (*sa_handler)(int);
  sigset_t sa_mask;               /* offset 8, size 128 */
  int sa_flags;                   /* offset 136 */
  void (*sa_restorer)(void);      /* offset 144 */
};

int sigaction(int sig, const struct sigaction *act, struct sigaction *old);
int kill(pid_t pid, int sig);
int sigemptyset(sigset_t *set);
int sigfillset(sigset_t *set);
int sigaddset(sigset_t *set, int sig);
int sigdelset(sigset_t *set, int sig);
int sigismember(const sigset_t *set, int sig);
int sigprocmask(int how, const sigset_t *set, sigset_t *old);
int sigpending(sigset_t *set);

#define SIG_BLOCK   0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2

#endif
