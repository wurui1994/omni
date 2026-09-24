/* io.c — arm64 Windows 的文件 IO 与「跟系统要地方」（第 win-c-backend 刀）。
 *
 * 与另两条腿（osx/linux）逐个函数对应：名字、签名、错误约定都一样，公用那一半
 * （stdio.c / file.c / malloc.c）一个字都不用改。差别只有一处，但是根本性的：
 *
 *   **Windows 没有小整数 fd，只有 HANDLE（一个指针宽的东西）。**
 *
 * 而公用那一半里 `struct __FILE` 存的是 `int fd`。所以这一份自己拿一张
 * **fd 表**：下标就是 fd，格子里是 HANDLE。0/1/2 开机时绑到三个标准句柄上 ——
 * 于是 `write(1, …)` 与 `printf` 走的是同一条路，`dup2(fd, 1)` 也仍然有意义。
 *
 * 表是定长的（`FD_MAX`）：这条腿上要的是「编译器自己跑起来」，同时开着的文件
 * 不过十几个；开满了回 EMFILE(24)，不去搞可增长的表 —— 那需要 malloc，而 malloc
 * 的地基（`__libc_chunk`）就在这一份里，循环依赖。
 */
#include "libc.h"

int __libc_errno_val;

/* 三条标准流的**对象与指针**都在公用的 stdio.c 里（`stdin`/`stdout`/`stderr` 这三个
 * 名字与 glibc 一样是真的数据符号）—— 所以这一份**不再定义一遍**。
 * 第一版在这儿照 Darwin 那条腿的样子又定义了三个指针，链的时候报的是
 * 「符号 'stdin' 定义了两次」：Darwin 那边要自己定义是因为它的名字叫 `__stdinp`，
 * 而这条腿沿用 Linux 的形状，公用那一半已经给全了。 */

#define FD_MAX 64
static void *__fd_tab[FD_MAX];
static int __fd_ready;

static void __fd_init(void) {
  if (__fd_ready) return;
  __fd_ready = 1;
  __fd_tab[0] = GetStdHandle(STD_INPUT_HANDLE);
  __fd_tab[1] = GetStdHandle(STD_OUTPUT_HANDLE);
  __fd_tab[2] = GetStdHandle(STD_ERROR_HANDLE);
}

/** fd -> HANDLE。不认的 fd 回 0（调用方填 EBADF）。 */
static void *__fd_get(int fd) {
  __fd_init();
  if (fd < 0 || fd >= FD_MAX) return 0;
  void *h = __fd_tab[fd];
  return (h == INVALID_HANDLE_VALUE) ? 0 : h;
}

/** 找一格空的装 HANDLE，回 fd；满了回 -1（EMFILE）。 */
static int __fd_put(void *h) {
  __fd_init();
  for (int i = 3; i < FD_MAX; i++) {
    if (__fd_tab[i] == 0) {
      __fd_tab[i] = h;
      return i;
    }
  }
  CloseHandle(h);
  __libc_errno_val = 24;              /* EMFILE */
  return -1;
}
long write(int fd, const void *buf, unsigned long n) {
  void *h = __fd_get(fd);
  if (h == 0) { __libc_errno_val = 9; return -1; }
  unsigned int put = 0;
  if (!WriteFile(h, buf, (unsigned int)n, &put, 0)) return __libc_oserr();
  return (long)put;
}

long read(int fd, void *buf, unsigned long n) {
  void *h = __fd_get(fd);
  if (h == 0) { __libc_errno_val = 9; return -1; }
  unsigned int got = 0;
  if (!ReadFile(h, buf, (unsigned int)n, &got, 0)) {
    /* 管道对面关了在 Windows 上是**错误**（ERROR_BROKEN_PIPE），在 POSIX 上是
       「读到 0 字节」。公用那一半按 POSIX 读，所以这儿折过来。 */
    if (GetLastError() == OMNI_ERROR_BROKEN_PIPE) return 0;
    return __libc_oserr();
  }
  return (long)got;
}

/* `open` 的 flags 用的是 POSIX 的那几位（见 include/fcntl.h）：
     O_RDONLY 0 / O_WRONLY 1 / O_RDWR 2 / O_CREAT 0100 / O_TRUNC 01000 / O_APPEND 02000 */
int open(const char *path, int flags, ...) {
  unsigned int acc = ((flags & 3) == 0) ? GENERIC_READ
    : ((flags & 3) == 1) ? GENERIC_WRITE : (GENERIC_READ | GENERIC_WRITE);
  unsigned int disp = OPEN_EXISTING;
  if (flags & 01000) disp = CREATE_ALWAYS;          /* O_TRUNC */
  else if (flags & 0100) disp = OPEN_ALWAYS;        /* O_CREAT */
  void *h = CreateFileA(path, acc, FILE_SHARE_ALL, 0, disp, FILE_ATTRIBUTE_NORMAL, 0);
  if (h == INVALID_HANDLE_VALUE) return (int)__libc_oserr();
  if (flags & 02000) SetFilePointerEx(h, 0, 0, 2);  /* O_APPEND：定位到尾 */
  return __fd_put(h);
}

int close(int fd) {
  void *h = __fd_get(fd);
  if (h == 0) { __libc_errno_val = 9; return -1; }
  __fd_tab[fd] = 0;
  if (fd <= 2) return 0;                            /* 标准流不真关 */
  if (!CloseHandle(h)) return (int)__libc_oserr();
  return 0;
}

long lseek(int fd, long off, int whence) {
  void *h = __fd_get(fd);
  if (h == 0) { __libc_errno_val = 9; return -1; }
  long long pos = 0;
  if (!SetFilePointerEx(h, (long long)off, &pos, (unsigned int)whence)) return __libc_oserr();
  return (long)pos;
}
/* `struct stat` 的**形状沿用 Linux 那一套**（`include/sys/stat.h`，sizeof=144）：
 * 这条腿上没有既成的 ABI 要对，而复用一份已经有判据的形状比另造一份省一整轮对账。
 * 只填真有人读的三格，按偏移写（省掉在这儿再引一份头）：
 *   st_mode = 24（unsigned int）、st_size = 48（long long）、st_mtim.tv_sec = 88（long long）
 * Windows 的 FILETIME 是 100ns 自 1601-01-01 起，换成 Unix 秒要减那 11644473600 秒。 */
#define OMNI_ST_MODE_OFF 24
#define OMNI_ST_SIZE_OFF 48
#define OMNI_ST_MTIM_OFF 88

static long long __ft_to_unix(long long ft) {
  return ft / 10000000LL - 11644473600LL;
}

static void __st_fill(void *buf, unsigned int attrs, long long size, long long ft) {
  unsigned char *p = (unsigned char *)buf;
  memset(p, 0, 144);
  *(unsigned int *)(p + OMNI_ST_MODE_OFF) =
    (attrs & FILE_ATTRIBUTE_DIRECTORY) ? 0040755u : 0100644u;
  *(long long *)(p + OMNI_ST_SIZE_OFF) = size;
  *(long long *)(p + OMNI_ST_MTIM_OFF) = __ft_to_unix(ft);
}

/* BY_HANDLE_FILE_INFORMATION 的摆法（数清楚，别再错一格）：
     0  dwFileAttributes   4 ftCreationTime   12 ftLastAccessTime   20 ftLastWriteTime
     28 dwVolumeSerialNumber   32 nFileSizeHigh   36 nFileSizeLow   40 nNumberOfLinks
   第一版把大小读成了 28/32 —— 那是**卷序列号**与 size 的高一半，于是 Windows 上
   `omni build` 报的产物大小是 `-7866003856960782000B`（产物本身是好的，只有那一行是胡话）。 */
int fstat(int fd, void *buf) {
  void *h = __fd_get(fd);
  if (h == 0) { __libc_errno_val = 9; return -1; }
  unsigned char info[56];
  if (!GetFileInformationByHandle(h, info)) return (int)__libc_oserr();
  unsigned int attrs = *(unsigned int *)(info + 0);
  long long wr = *(long long *)(info + 20);
  unsigned int hi = *(unsigned int *)(info + 32);
  unsigned int lo = *(unsigned int *)(info + 36);
  __st_fill(buf, attrs, ((long long)hi << 32) | (long long)lo, wr);
  return 0;
}

int stat(const char *path, void *buf) {
  unsigned int attrs = GetFileAttributesA(path);
  if (attrs == INVALID_FILE_ATTRIBUTES) return (int)__libc_oserr();
  if (attrs & FILE_ATTRIBUTE_DIRECTORY) {
    __st_fill(buf, attrs, 0, 0);
    return 0;
  }
  /* 文件：为了拿到大小与时间还是得开一次（只要读属性的权限，access = 0 就够）。 */
  void *h = CreateFileA(path, 0, FILE_SHARE_ALL, 0, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, 0);
  if (h == INVALID_HANDLE_VALUE) return (int)__libc_oserr();
  int fd = __fd_put(h);
  if (fd < 0) return -1;
  int r = fstat(fd, buf);
  close(fd);
  return r;
}
int mkdir(const char *path, unsigned int mode) {
  (void)mode;                                       /* Windows 上没有 mode 位 */
  if (!CreateDirectoryA(path, 0)) return (int)__libc_oserr();
  return 0;
}

int unlink(const char *path) {
  if (!DeleteFileA(path)) return (int)__libc_oserr();
  return 0;
}

int rmdir(const char *path) {
  if (!RemoveDirectoryA(path)) return (int)__libc_oserr();
  return 0;
}

int rename(const char *old, const char *new_) {
  /* POSIX 的 rename 是**覆盖**的，Win32 默认不覆盖 —— 所以要那个标志。 */
  if (!MoveFileExA(old, new_, MOVEFILE_REPLACE_EXISTING)) return (int)__libc_oserr();
  return 0;
}

int access(const char *path, int mode) {
  (void)mode;                                       /* 只答「在不在」；W_OK 这条腿不查 ACL */
  if (GetFileAttributesA(path) == INVALID_FILE_ATTRIBUTES) return (int)__libc_oserr();
  return 0;
}

int dup2(int old, int new_) {
  void *h = __fd_get(old);
  if (h == 0 || new_ < 0 || new_ >= FD_MAX) { __libc_errno_val = 9; return -1; }
  void *dup = 0;
  if (!DuplicateHandle(GetCurrentProcess(), h, GetCurrentProcess(), &dup,
                       0, 1, DUPLICATE_SAME_ACCESS)) return (int)__libc_oserr();
  if (__fd_tab[new_] != 0 && new_ > 2) CloseHandle(__fd_tab[new_]);
  __fd_tab[new_] = dup;
  return new_;
}

int pipe(int fd[2]) {
  void *rd = 0, *wr = 0;
  if (!CreatePipe(&rd, &wr, 0, 0)) return (int)__libc_oserr();
  int a = __fd_put(rd);
  if (a < 0) { CloseHandle(wr); return -1; }
  int b = __fd_put(wr);
  if (b < 0) { close(a); return -1; }
  fd[0] = a;
  fd[1] = b;
  return 0;
}

int isatty(int fd) {
  void *h = __fd_get(fd);
  if (h == 0) return 0;
  return GetFileType(h) == FILE_TYPE_CHAR ? 1 : 0;
}
char *getcwd(char *buf, unsigned long size) {
  unsigned int n = GetCurrentDirectoryA((unsigned int)size, buf);
  if (n == 0) { __libc_oserr(); return (char *)0; }
  if (n > size) { __libc_errno_val = 34; return (char *)0; }   /* ERANGE */
  return buf;
}

int fcntl(int fd, int cmd, ...) {
  (void)cmd;
  /* 这条腿上 `fcntl` 只用来「问这个 fd 还在不在」（公用那一半就用到这些）。 */
  if (__fd_get(fd) == 0) { __libc_errno_val = 9; return -1; }
  return 0;
}

long readlink(const char *path, char *buf, unsigned long n) {
  (void)path; (void)buf; (void)n;
  /* Windows 的重解析点这条腿不碰：回 EINVAL（POSIX 里「不是符号链接」就是这个）。 */
  __libc_errno_val = 22;
  return -1;
}

void _exit(int code) {
  ExitProcess((unsigned int)code);
  for (;;) { }                                      /* 到不了 */
}

int *__errno_location(void) { return &__libc_errno_val; }
int *__error(void) { return &__libc_errno_val; }     /* Darwin 名字：一起给，省一处分叉 */

/* 公用那份 malloc 跟系统要地方走这一条（约定见 `libc.h`）。
 * Windows 上是 VirtualAlloc：一次 COMMIT|RESERVE、可读可写。页是 4K，但**保留的粒度
 * 是 64K**（SYSTEM_INFO 的 dwAllocationGranularity）—— 所以按 64K 上取整，
 * 免得每次要 4K 都白扔 60K 的地址空间。两次要来的地方不连着，公用那一份不假设连着。
 *
 * 类型是 `__libc_usize`（和指针一样宽）而不是 `unsigned long` —— **Windows 是 LLP64，
 * `long` 只有 4 字节**，用它当地址会把高 32 位截掉（账记在 `libc.h` 那个 typedef 上）。 */
__libc_usize __libc_chunk(__libc_usize least, __libc_usize *got) {
  __libc_usize want = (least + 0xffffULL) & ~0xffffULL;
  void *p = VirtualAlloc(0, (unsigned long long)want,
                         MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  if (p == 0) return 0;
  *got = want;
  return (__libc_usize)p;
}

/* ---- 起子进程（第 win-c-backend 刀）。
 *
 * `fork` + `execvp` 在 Windows 上没有对应物（`fork` 这条腿一律 ENOSYS），而运行时那一层
 * 真的要起子进程（`omni_host_spawn`：跑 cc、跑编出来的程序、问 `uname`…）。这儿给的是
 * **这条腿专用**的两格：起一个、等一个。签名是给 `omni_js_host.c` 用的，不进任何标准头。
 *
 *   `__libc_spawn(cmd, argv, fd0, fd1, fd2)`：fd 给 -1 就让孩子继承父进程那一格。
 *      回一个「进程句柄当数」的值（>0），起不来回 -1（**不崩**：起不来是一种结果，
 *      调用方按退出码 127 处理）。
 *   `__libc_spawn_wait(h)`：等它、回退出码、关句柄。
 *
 * 两处要小心：
 *  - **句柄要可继承**：`pipe()` 造出来的那两头是不可继承的（`CreatePipe` 的 sec 给了 0），
 *    所以这儿按需 `DuplicateHandle(..., inherit=1)` 复制一份给孩子，起完就关掉复制品。
 *    不改 `pipe()` 是故意的 —— 那会让**每一个**管道都漏进随后起的每一个子进程。
 *  - **命令行要自己拼**：Windows 上进程收到的是一整行字符串，拆词是 CRT 的活
 *    （我们自己那份拆词器在 `start.c`）。所以这儿按同一套规矩反着拼：带空白或引号的
 *    参数加引号、引号前的反斜杠成对翻倍。
 */
static unsigned long __sp_need_quote(const char *s) {
  if (*s == 0) return 1;
  for (const char *p = s; *p != 0; p++) {
    if (*p == ' ' || *p == '\t' || *p == '"') return 1;
  }
  return 0;
}

static unsigned long __sp_arg(char *dst, unsigned long at, unsigned long cap, const char *s) {
  const unsigned long q = __sp_need_quote(s);
  if (q && at + 1 < cap) dst[at++] = '"';
  for (const char *p = s; *p != 0;) {
    if (*p == '\\') {
      unsigned long n = 0;
      while (*p == '\\') { n++; p++; }
      /* 引号前（或串尾且要收引号）的反斜杠要翻倍，别的原样。 */
      const unsigned long dbl = (*p == '"' || (*p == 0 && q)) ? 2 : 1;
      for (unsigned long k = 0; k < n * dbl && at + 1 < cap; k++) dst[at++] = '\\';
      continue;
    }
    if (*p == '"') { if (at + 2 < cap) { dst[at++] = '\\'; dst[at++] = '"'; } p++; continue; }
    if (at + 1 < cap) dst[at++] = *p;
    p++;
  }
  if (q && at + 1 < cap) dst[at++] = '"';
  return at;
}

long __libc_spawn(const char *cmd, char *const argv[], int fd0, int fd1, int fd2) {
  static char line[32768];
  unsigned long at = __sp_arg(line, 0, sizeof(line), cmd);
  for (int i = 1; argv != 0 && argv[i] != 0; i++) {
    if (at + 1 < sizeof(line)) line[at++] = ' ';
    at = __sp_arg(line, at, sizeof(line), argv[i]);
  }
  line[at < sizeof(line) ? at : sizeof(line) - 1] = 0;
  /* 三个标准流：给了 fd 就复制一份可继承的句柄，没给就把自己那一格递下去。 */
  void *self = GetCurrentProcess();
  void *hs[3];
  void *dups[3];
  const int fds[3] = { fd0, fd1, fd2 };
  const unsigned int which[3] = { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE };
  for (int i = 0; i < 3; i++) {
    dups[i] = 0;
    void *src = fds[i] < 0 ? GetStdHandle(which[i]) : __fd_get(fds[i]);
    if (src == 0 || src == INVALID_HANDLE_VALUE) { hs[i] = 0; continue; }
    void *d = 0;
    if (DuplicateHandle(self, src, self, &d, 0, 1, 0x00000002 /* SAME_ACCESS */)) {
      dups[i] = d;
      hs[i] = d;
    } else {
      hs[i] = 0;
    }
  }
  /* STARTUPINFOA 照字节摆（与 `system()` 那一段同一个做法）：cb 在 0、dwFlags 在 60、
     hStdInput/Output/Error 在 80/88/96。`STARTF_USESTDHANDLES` 是 0x100。 */
  unsigned char si[104];
  unsigned char pi[24];
  memset(si, 0, sizeof(si));
  memset(pi, 0, sizeof(pi));
  *(unsigned int *)si = (unsigned int)sizeof(si);
  *(unsigned int *)(si + 60) = 0x00000100u;
  *(void **)(si + 80) = hs[0];
  *(void **)(si + 88) = hs[1];
  *(void **)(si + 96) = hs[2];
  const int ok = CreateProcessA((const char *)0, line, 0, 0, 1, 0, 0, (const char *)0, si, pi);
  for (int i = 0; i < 3; i++) if (dups[i] != 0) CloseHandle(dups[i]);
  if (!ok) { __libc_oserr(); return -1; }
  void *hthread = *(void **)(pi + 8);
  if (hthread != 0) CloseHandle(hthread);
  return (long)(long long)*(void **)(pi + 0);
}

int __libc_spawn_wait(long h) {
  void *hproc = (void *)(long long)h;
  if (hproc == 0) return -1;
  WaitForSingleObject(hproc, 0xffffffffu);
  unsigned int code = 1;
  GetExitCodeProcess(hproc, &code);
  CloseHandle(hproc);
  return (int)code;
}
