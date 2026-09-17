/* `<sys/stat.h>` —— arm64-osx 的那一份（交叉编译用）。
 *
 * 量到的：sizeof=144，字段偏移
 *   st_dev=0 st_mode=4 st_nlink=6 st_ino=8 st_mtimespec=48 st_size=96
 * 与 Linux 那一份**完全不同**（那边 st_mode 在 24、st_size 在 48、时间戳叫 st_mtim）——
 * 这正是「头必须按目标走」最直白的一格。 */
#ifndef _SYS_STAT_H
#define _SYS_STAT_H

#include <sys/types.h>
#include <time.h>

struct stat {
  dev_t st_dev;                    /* 0  (int32) */
  mode_t st_mode;                  /* 4  (uint16) */
  nlink_t st_nlink;                /* 6  (uint16) */
  ino_t st_ino;                    /* 8  (uint64) */
  uid_t st_uid;                    /* 16 */
  gid_t st_gid;                    /* 20 */
  dev_t st_rdev;                   /* 24 */
  int __pad0;                      /* 28 */
  struct timespec st_atimespec;    /* 32 */
  struct timespec st_mtimespec;    /* 48 */
  struct timespec st_ctimespec;    /* 64 */
  struct timespec st_birthtimespec;/* 80 */
  off_t st_size;                   /* 96 */
  blkcnt_t st_blocks;              /* 104 */
  blksize_t st_blksize;            /* 112 */
  unsigned int st_flags;           /* 116 */
  unsigned int st_gen;             /* 120 */
  int st_lspare;                   /* 124 */
  long long st_qspare[2];          /* 128, sizeof = 144 */
};

#define S_IFMT   0170000
#define S_IFDIR  0040000
#define S_IFREG  0100000
#define S_ISDIR(m) (((m) & S_IFMT) == S_IFDIR)
#define S_ISREG(m) (((m) & S_IFMT) == S_IFREG)

int stat(const char *path, struct stat *buf);
int mkdir(const char *path, mode_t mode);

#endif
