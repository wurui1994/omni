/* `<sys/wait.h>` —— x86_64-linux 的那一份（交叉编译用）。 */
#ifndef _SYS_WAIT_H
#define _SYS_WAIT_H

#include <sys/types.h>

#define WIFEXITED(s) (((s) & 0x7f) == 0)
#define WEXITSTATUS(s) (((s) & 0xff00) >> 8)
#define WIFSIGNALED(s) (((signed char)(((s) & 0x7f) + 1) >> 1) > 0)
#define WTERMSIG(s) ((s) & 0x7f)

pid_t waitpid(pid_t pid, int *stat, int opts);

#endif
