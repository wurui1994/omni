/* `<unistd.h>` —— win32 的那一份（两个 arch 共用）（交叉编译用；形状沿用 Linux 那一套，见 ../README.md）。 */
#ifndef _UNISTD_H
#define _UNISTD_H

#include <stddef.h>
#include <sys/types.h>

#define STDIN_FILENO 0
#define STDOUT_FILENO 1
#define STDERR_FILENO 2

int close(int fd);
long int read(int fd, void *buf, size_t n);
long int write(int fd, const void *buf, size_t n);
int dup2(int old, int new);
int pipe(int fds[2]);
pid_t fork(void);
pid_t getpid(void);
int execvp(const char *file, char *const argv[]);
/* `setsid` / `execl` 在这条腿上都只回 -1/ENOSYS（`libc/misc.c`），但**声明要有** ——
 * `omni_js_host.c` 里那两句否则是隐式声明。 */
int setsid(void);
int execl(const char *path, const char *arg0, ...);
int isatty(int fd);
char *getcwd(char *buf, size_t n);
unsigned int alarm(unsigned int sec);
int unlink(const char *path);
int rmdir(const char *path);
int access(const char *path, int mode);
void _exit(int code);

#endif
