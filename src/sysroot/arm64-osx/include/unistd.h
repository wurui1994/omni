/* `<unistd.h>` —— arm64-osx 的那一份（交叉编译用）。 */
#ifndef _UNISTD_H
#define _UNISTD_H

#include <stddef.h>
#include <sys/types.h>

#define STDIN_FILENO 0
#define STDOUT_FILENO 1
#define STDERR_FILENO 2

int close(int fd);
long read(int fd, void *buf, size_t n);
long write(int fd, const void *buf, size_t n);
int dup2(int old, int new_fd);
int pipe(int fds[2]);
pid_t fork(void);
pid_t getpid(void);
int execvp(const char *file, char *const argv[]);
int isatty(int fd);
char *getcwd(char *buf, size_t n);
unsigned int alarm(unsigned int sec);
int unlink(const char *path);
int rmdir(const char *path);
int access(const char *path, int mode);
void _exit(int code);

#endif
