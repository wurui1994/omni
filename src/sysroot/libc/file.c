/* file.c — `FILE *` 那一层（第一百四十片）。
 *
 * `FILE` 就是一个 fd 加两位状态（见 `libc.h`），**无缓冲** —— 每次 `fread`/`fwrite`
 * 都是一条 syscall。慢，但少一整套刷新与「读写混用要 seek」的账，而且 `fflush`
 * 于是是真的空操作，不会有「攒着没吐出去」这种走查不出来的错。
 *
 * O_* 那几个常量是**量出来的**（x86_64 Linux 的 `asm-generic/fcntl.h`）：
 * O_RDONLY 0、O_WRONLY 1、O_RDWR 2、O_CREAT 0100、O_TRUNC 01000、O_APPEND 02000。
 */
#include "libc.h"

#define O_RDONLY  0
#define O_WRONLY  1
#define O_RDWR    2
#define O_CREAT   0100
#define O_TRUNC   01000
#define O_APPEND  02000

FILE *fopen(const char *path, const char *mode) {
  int flags = O_RDONLY;
  if (mode[0] == 'r') flags = (mode[1] == '+' || (mode[1] == 'b' && mode[2] == '+'))
    ? O_RDWR : O_RDONLY;
  else if (mode[0] == 'w') flags = O_WRONLY | O_CREAT | O_TRUNC;
  else if (mode[0] == 'a') flags = O_WRONLY | O_CREAT | O_APPEND;
  int fd = open(path, flags, 0644);
  if (fd < 0) return (FILE *)0;
  FILE *f = (FILE *)malloc(sizeof(FILE));
  if (f == (FILE *)0) { close(fd); return (FILE *)0; }
  f->fd = fd; f->eof = 0; f->err = 0;
  return f;
}

FILE *fdopen(int fd, const char *mode) {
  (void)mode;
  FILE *f = (FILE *)malloc(sizeof(FILE));
  if (f == (FILE *)0) return (FILE *)0;
  f->fd = fd; f->eof = 0; f->err = 0;
  return f;
}

int fclose(FILE *f) {
  if (f == (FILE *)0) return -1;
  int r = close(f->fd);
  if (f != stdin && f != stdout && f != stderr) free(f);
  return r;
}

int fileno(FILE *f) { return f->fd; }

unsigned long fread(void *buf, unsigned long size, unsigned long n, FILE *f) {
  unsigned long total = size * n;
  if (total == 0) return 0;
  unsigned char *p = (unsigned char *)buf;
  unsigned long got = 0;
  while (got < total) {
    long r = read(f->fd, p + got, total - got);
    if (r < 0) { f->err = 1; break; }
    if (r == 0) { f->eof = 1; break; }
    got += (unsigned long)r;
  }
  return size == 0 ? 0 : got / size;
}

unsigned long fwrite(const void *buf, unsigned long size, unsigned long n, FILE *f) {
  unsigned long total = size * n;
  if (total == 0) return 0;
  const unsigned char *p = (const unsigned char *)buf;
  unsigned long put = 0;
  while (put < total) {
    long r = write(f->fd, p + put, total - put);
    if (r <= 0) { f->err = 1; break; }
    put += (unsigned long)r;
  }
  return size == 0 ? 0 : put / size;
}

int fseek(FILE *f, long off, int whence) {
  if (lseek(f->fd, off, whence) < 0) { f->err = 1; return -1; }
  f->eof = 0;
  return 0;
}
long ftell(FILE *f) { return lseek(f->fd, 0, 1 /* SEEK_CUR */); }
void rewind(FILE *f) { lseek(f->fd, 0, 0); f->eof = 0; f->err = 0; }

int fgetc(FILE *f) {
  unsigned char c;
  long r = read(f->fd, &c, 1);
  if (r == 0) { f->eof = 1; return -1; }
  if (r < 0) { f->err = 1; return -1; }
  return (int)c;
}
int getc(FILE *f) { return fgetc(f); }

char *fgets(char *buf, int n, FILE *f) {
  if (n <= 0) return (char *)0;
  int k = 0;
  while (k < n - 1) {
    int c = fgetc(f);
    if (c < 0) break;
    buf[k++] = (char)c;
    if (c == '\n') break;
  }
  if (k == 0) return (char *)0;
  buf[k] = 0;
  return buf;
}

int feof(FILE *f) { return f->eof; }
int ferror(FILE *f) { return f->err; }
void clearerr(FILE *f) { f->eof = 0; f->err = 0; }
/* 无缓冲，所以这两条无事可做（`setvbuf` 回 0 = 「照办了」）。 */
int setvbuf(FILE *f, char *buf, int mode, unsigned long size) {
  (void)f; (void)buf; (void)mode; (void)size;
  return 0;
}
void setbuf(FILE *f, char *buf) { (void)f; (void)buf; }
