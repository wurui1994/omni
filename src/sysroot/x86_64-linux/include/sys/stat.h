/* `<sys/stat.h>` —— x86_64-linux 的那一份（交叉编译用）。
 *
 * struct stat：量到 sizeof=144。字段偏移：
 *   st_dev=0 st_ino=8 st_nlink=16 st_mode=24 st_size=48 st_mtim=88
 * 注意 nlink 在 mode **前面**（glibc 的 x86_64 那一份在 `bits/stat.h` 里把
 * `__nlink_t` 放在了 `__mode_t` 上头）。 */
#ifndef _SYS_STAT_H
#define _SYS_STAT_H

#include <sys/types.h>
#include <time.h>

struct stat {
  dev_t st_dev;             /* 0 */
  ino_t st_ino;             /* 8 */
  nlink_t st_nlink;         /* 16 */
  mode_t st_mode;           /* 24 */
  uid_t st_uid;             /* 28 */
  gid_t st_gid;             /* 32 */
  unsigned int __pad0;      /* 36 */
  dev_t st_rdev;            /* 40 */
  off_t st_size;            /* 48 */
  blksize_t st_blksize;    /* 56 */
  blkcnt_t st_blocks;      /* 64 */
  struct timespec st_atim;  /* 72 */
  struct timespec st_mtim;  /* 88 */
  struct timespec st_ctim;  /* 104 */
  long int __reserved[3];   /* 120, pad to 144 */
};

#define S_IFMT   0170000
#define S_IFDIR  0040000
#define S_IFREG  0100000
#define S_ISDIR(m) (((m) & S_IFMT) == S_IFDIR)
#define S_ISREG(m) (((m) & S_IFMT) == S_IFREG)

int stat(const char *path, struct stat *buf);
int mkdir(const char *path, mode_t mode);

#endif
