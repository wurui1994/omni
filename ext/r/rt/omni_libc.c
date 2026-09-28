/* ext/r/rt/omni_libc.c —— libc 里**按值回 struct** 的那几个，我们自己用 C 写（第十八格）。
 *
 * 为什么要这一份：`tu` 档里按值收发 struct 的外部函数不发桩、等链接
 * （见 `tccgen.js` 的 `externThunk`）—— 它转不了手给宿主的 `callLibc`，因为那扇门只过
 * 标量。R 的 `src/main/printarray.c` 用 `div()` 算行列，于是"链得起"这件事上它是硬缺。
 *
 * `div` / `ldiv` / `lldiv` 的语义就是 C 的 `/` 与 `%`（C99 6.5.5：商向零截断、
 * 余数与被除数同号），所以身子只有两行 —— 唯一要小心的是**别自己发明边角**：
 * `INT_MIN / -1` 与除以 0 在 C 里是未定义，这儿照样交给底下的 `/`，不悄悄改答案。
 */

typedef struct { int quot; int rem; } omni_div_t;
typedef struct { long quot; long rem; } omni_ldiv_t;
typedef struct { long long quot; long long rem; } omni_lldiv_t;

omni_div_t div(int a, int b) {
  omni_div_t r;
  r.quot = a / b;
  r.rem = a % b;
  return r;
}

omni_ldiv_t ldiv(long a, long b) {
  omni_ldiv_t r;
  r.quot = a / b;
  r.rem = a % b;
  return r;
}

omni_lldiv_t lldiv(long long a, long long b) {
  omni_lldiv_t r;
  r.quot = a / b;
  r.rem = a % b;
  return r;
}

/* ---- 平台那几格**数据**符号（功能映射）--------------------------------------
 *
 * 这三个是 data 段直接引用的（宏展开出来的），不是函数 —— 转不了手给宿主的
 * `callLibc`，谁也不定义就是一个指着空白的指针（静默答错）。它们说的都是"这台机器
 * 是什么"，而我们那台机器是 JS：所以这儿给的是**这条腿上的真答案**，不是占位。
 */

/** `MB_CUR_MAX` 在 macOS 的头里展开成 `__mb_cur_max`。我们这条腿的 locale 是 C，
 *  一个字符一个字节 —— 所以 1 是真答案。换了 UTF-8 locale 这一格要跟着改。 */
int __mb_cur_max = 1;

/** `iconv` 的版本号（`platform.c` 只把它印进 `extSoftVersion()`）。
 *  0x0109 = "1.9"，与我们那侧 iconv 的行为对得上。 */
int _libiconv_version = 0x0109;

/** Mach 的"当前任务"端口。浏览器里没有 Mach，`eval.c` 拿它是为了问线程的调度优先级
 *  —— 0 是"没有这个端口"，底下那几个 `mach_*` 调用在宿主那侧明着报不支持，
 *  **不是**悄悄回一个假优先级。 */
unsigned int mach_task_self_ = 0;

/* ---- `stat` 那一族（第一百五十二片）------------------------------------------
 *
 * 宿主那侧只回一串数（`__omni_stat`，13 个 i64），**`struct stat` 由这儿填** ——
 * 那张结构的布局是平台的事（macOS 上 `st_mode` 在偏移 4、`st_size` 在 96…），
 * 让编译器按头文件算偏移，就不必在 JS 里把 ABI 抄第二遍（抄错一格是静默答错）。
 *
 * R 要它们：`InitTempDir` 问临时目录在不在（`stat` + `S_IFDIR`）、
 * `R_FileExists` / `file.info` / `R_LoadProfile` 那一路也都走这儿。
 */
#include <sys/stat.h>

long long __omni_stat(const char *path, long long *out, long long follow);

enum { OMNI_ST_MODE = 0, OMNI_ST_SIZE, OMNI_ST_MTIME, OMNI_ST_ATIME, OMNI_ST_CTIME,
       OMNI_ST_INO, OMNI_ST_NLINK, OMNI_ST_UID, OMNI_ST_GID, OMNI_ST_DEV,
       OMNI_ST_RDEV, OMNI_ST_BLKSIZE, OMNI_ST_BLOCKS, OMNI_ST_N };

static int omni_fill_stat(const char *path, struct stat *sb, long long follow) {
  long long v[OMNI_ST_N];
  unsigned char *p = (unsigned char *)sb;
  unsigned long i;
  if (__omni_stat(path, v, follow) != 0) return -1;
  for (i = 0; i < sizeof(struct stat); i++) p[i] = 0;
  sb->st_mode = (mode_t)v[OMNI_ST_MODE];
  sb->st_size = (off_t)v[OMNI_ST_SIZE];
  sb->st_mtime = (long)v[OMNI_ST_MTIME];
  sb->st_atime = (long)v[OMNI_ST_ATIME];
  sb->st_ctime = (long)v[OMNI_ST_CTIME];
  sb->st_ino = (ino_t)v[OMNI_ST_INO];
  sb->st_nlink = (nlink_t)v[OMNI_ST_NLINK];
  sb->st_uid = (uid_t)v[OMNI_ST_UID];
  sb->st_gid = (gid_t)v[OMNI_ST_GID];
  sb->st_dev = (dev_t)v[OMNI_ST_DEV];
  sb->st_rdev = (dev_t)v[OMNI_ST_RDEV];
  sb->st_blksize = (blksize_t)v[OMNI_ST_BLKSIZE];
  sb->st_blocks = (blkcnt_t)v[OMNI_ST_BLOCKS];
  return 0;
}

int stat(const char *path, struct stat *sb) { return omni_fill_stat(path, sb, 1); }
int lstat(const char *path, struct stat *sb) { return omni_fill_stat(path, sb, 0); }
