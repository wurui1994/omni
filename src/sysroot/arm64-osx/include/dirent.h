/* `<dirent.h>` —— arm64-osx 的那一份（交叉编译用）。
 *
 * 量到的：sizeof(struct dirent)=**1048**（Linux 上 280），d_name 在 21，
 * 名字那一格是 1024 字节（Linux 上 256）。 */
#ifndef _DIRENT_H
#define _DIRENT_H

#include <sys/types.h>

struct DIR;
typedef struct DIR DIR;

struct dirent {
  ino_t d_ino;                /* 0  (uint64) */
  unsigned long long d_seekoff; /* 8 */
  unsigned short d_reclen;    /* 16 */
  unsigned short d_namlen;    /* 18 */
  unsigned char d_type;       /* 20 */
  char d_name[1027];          /* 21, sizeof = 1048 */
};

DIR *opendir(const char *path);
struct dirent *readdir(DIR *d);
int closedir(DIR *d);

#endif
