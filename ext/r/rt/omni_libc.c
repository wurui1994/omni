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

/* ---- `inet_ntoa`：又一个**按值收 struct** 的（第三十八格）------------------
 *
 * `utils/src/utils.c:158` 的 `nsl()` 用它把地址印成点分十进制。按值收 struct 的外部
 * 函数在 `tu` 档里不发桩（同 `div` 那条），所以宿主那扇只过标量的门接不住它 ——
 * 症状是 `undefined symbol 'inet_ntoa'`（loud，不是静默答错）。
 *
 * 身子是**纯计算**：`struct in_addr` 里那个 32 位按网络字节序拆成四段。回的是静态
 * 缓冲区 —— 这正是 POSIX 说的样子（下一次调用会盖掉），不自己发明别的。
 */
struct omni_in_addr { unsigned int s_addr; };

char *inet_ntoa(struct omni_in_addr in) {
  static char buf[16];
  unsigned int a = in.s_addr;
  unsigned char *b = (unsigned char *)&a;
  char *p = buf;
  int i;
  for (i = 0; i < 4; i++) {
    unsigned int v = b[i];
    if (i > 0) *p++ = '.';
    if (v >= 100) *p++ = (char)('0' + v / 100);
    if (v >= 10) *p++ = (char)('0' + (v / 10) % 10);
    *p++ = (char)('0' + v % 10);
  }
  *p = '\0';
  return buf;
}

/* ---- `glob` / `globfree`：目录展开（第三十八格）--------------------------------
 *
 * 撞它的是 base 的 `.libPaths()` —— `etc/Renviron` 把 `R_LIBS` 摆上之后才走到这一步
 * （所以第三十七格补完 Renviron 才冒出来），指纹是 `glob: libc: 没有这个函数`。
 *
 * 分工：**找名字**那件事在宿主那一侧（`__omni_glob`，一级一级往下走、列目录），
 * **摆进 `glob_t`** 这件事在这儿 —— 那张结构的布局是平台的事（`gl_pathc` / `gl_pathv`
 * 的偏移），让编译器按 `<glob.h>` 算，就不必在 JS 里把 ABI 抄第二遍（抄错一格是静默答错）。
 *
 * 门只过标量，所以宿主回的是"一串用 0 隔开的名字"+ 个数。R 只读 `gl_pathc`/`gl_pathv`。
 */
#include <glob.h>

long long __omni_glob(const char *pat, char *buf, long long cap);
void *malloc(unsigned long);
void free(void *);
char *strcpy(char *, const char *);
unsigned long strlen(const char *);

int glob(const char *pat, int flags, int (*errfunc)(const char *, int), glob_t *g) {
  static char names[65536];
  long long n, i;
  char *p = names;
  (void)flags;
  (void)errfunc;
  g->gl_pathc = 0;
  g->gl_matchc = 0;
  g->gl_offs = 0;
  g->gl_flags = 0;
  g->gl_pathv = 0;
  n = __omni_glob(pat, names, (long long)sizeof names);
  if (n < 0) return GLOB_NOSPACE;
  if (n == 0) return GLOB_NOMATCH;
  g->gl_pathv = (char **)malloc(sizeof(char *) * (unsigned long)(n + 1));
  if (g->gl_pathv == 0) return GLOB_NOSPACE;
  for (i = 0; i < n; i++) {
    unsigned long len = strlen(p);
    char *s = (char *)malloc(len + 1);
    if (s == 0) return GLOB_NOSPACE;
    strcpy(s, p);
    g->gl_pathv[i] = s;
    p += len + 1;
  }
  g->gl_pathv[n] = 0;
  g->gl_pathc = (unsigned long)n;
  g->gl_matchc = (int)n;
  return 0;
}

void globfree(glob_t *g) {
  unsigned long i;
  if (g->gl_pathv == 0) return;
  for (i = 0; i < g->gl_pathc; i++) free(g->gl_pathv[i]);
  free(g->gl_pathv);
  g->gl_pathv = 0;
  g->gl_pathc = 0;
}

/* ---- `localtime` / `gmtime`：把一个时刻拆成 `struct tm`（第三十八格）--------
 *
 * 撞它的是 `pdf()` —— `devPS.c` 要往 PDF 里写 `/CreationDate`。
 *
 * 分工与 `stat` 那格一样：**算**在宿主那一侧（`__omni_localtime`，九个整数），
 * **摆进 `struct tm`** 在这儿 —— 那张结构的布局（macOS 上还多两格 `tm_gmtoff`/
 * `tm_zone`）交给编译器按 `<time.h>` 算，不在 JS 里抄第二遍。
 *
 * `tm_zone` 摆成 NULL：这条腿上**没有时区库**，与其编一个名字出来，不如空着 ——
 * 谁真去印 `%Z` 会当场看见 NULL，而不是拿到一个假的"CST"。
 */
#include <time.h>

long long __omni_localtime(long long t, long long *out, long long utc);

static struct tm omni_tm;

static struct tm *omni_fill_tm(long long t, long long utc) {
  long long v[9];
  unsigned char *p = (unsigned char *)&omni_tm;
  unsigned long i;
  if (__omni_localtime(t, v, utc) != 0) return 0;
  for (i = 0; i < sizeof(struct tm); i++) p[i] = 0;
  omni_tm.tm_sec = (int)v[0];
  omni_tm.tm_min = (int)v[1];
  omni_tm.tm_hour = (int)v[2];
  omni_tm.tm_mday = (int)v[3];
  omni_tm.tm_mon = (int)v[4];
  omni_tm.tm_year = (int)v[5];
  omni_tm.tm_wday = (int)v[6];
  omni_tm.tm_yday = (int)v[7];
  omni_tm.tm_isdst = (int)v[8];
  return &omni_tm;
}

struct tm *localtime(const time_t *t) { return omni_fill_tm((long long)*t, 0); }
struct tm *gmtime(const time_t *t) { return omni_fill_tm((long long)*t, 1); }
