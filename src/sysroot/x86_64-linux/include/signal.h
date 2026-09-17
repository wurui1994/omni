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
/* 采样 profiler 用的那两个（`ITIMER_VIRTUAL`/`ITIMER_PROF` 各自的信号）。
 * 这两个号**两条腿一样**（26/27），少见的一格。 */
#define SIGVTALRM 26
#define SIGPROF 27

#define SIG_DFL ((void (*)(int))0)
#define SIG_IGN ((void (*)(int))1)

#define SA_RESTART 0x10000000
/* `SA_SIGINFO`：三个参数的处理函数（`(sig, siginfo *, ucontext *)`）。采样 profiler 要它
 * —— 「此刻在谁身上」只有 ucontext 里那个 PC 说得出来（见 `omni_prof.c`）。
 * 我们那一层只把 `sa_handler` 抄进内核结构，所以三参数的处理函数**装得上**：
 * 内核按 flags 决定调几个参数，libc 这一侧不掺和。 */
#define SA_SIGINFO 4

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
