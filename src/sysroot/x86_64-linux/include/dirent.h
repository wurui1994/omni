/* `<dirent.h>` —— x86_64-linux 的那一份（交叉编译用）。
 *
 * struct dirent：量到 sizeof=280，字段偏移 d_ino=0 d_off=8 d_reclen=16
 * d_type=18 d_name=19。运行时只读 `d_name`。
 * `DIR` 不透明 —— 只经指针传。 */
#ifndef _DIRENT_H
#define _DIRENT_H

#include <sys/types.h>

struct __dirstream;
typedef struct __dirstream DIR;

struct dirent {
  ino_t d_ino;                  /* 0 */
  off_t d_off;                  /* 8 */
  unsigned short int d_reclen;  /* 16 */
  unsigned char d_type;         /* 18 */
  char d_name[257];             /* 19, sizeof = 280 */
};

DIR *opendir(const char *path);
struct dirent *readdir(DIR *d);
int closedir(DIR *d);

#endif
