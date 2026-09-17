/* `<signal.h>` —— arm64-osx 的那一份（交叉编译用）。
 *
 * 量到的：sigset_t **4 字节**（Linux 上是 128），struct sigaction **16 字节**
 * （Linux 上 152），sa_handler=0 sa_mask=8 sa_flags=12。
 * 号也与 Linux 不同：`SIGUSR1` 在这儿是 **30**（Linux 是 10）。
 * `SA_SIGINFO` 故意不给：那要三参数的处理函数，我们那一层只翻译一参数的（明说）。 */
#ifndef _SIGNAL_H
#define _SIGNAL_H

#include <sys/types.h>

#define SIGINT  2
#define SIGKILL 9
#define SIGALRM 14
#define SIGTERM 15
#define SIGUSR1 30

#define SIG_DFL ((void (*)(int))0)
#define SIG_IGN ((void (*)(int))1)

#define SA_RESTART 0x0002

typedef unsigned int sigset_t;

struct sigaction {
  void (*sa_handler)(int);   /* 0 */
  sigset_t sa_mask;          /* 8 */
  int sa_flags;              /* 12, sizeof = 16 */
};

int sigaction(int sig, const struct sigaction *act, struct sigaction *old);
int kill(pid_t pid, int sig);
int sigemptyset(sigset_t *set);
int sigfillset(sigset_t *set);
int sigaddset(sigset_t *set, int sig);
int sigdelset(sigset_t *set, int sig);
int sigismember(const sigset_t *set, int sig);

#endif
