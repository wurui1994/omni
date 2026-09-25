/* omni_win32.h —— 在 Windows 上用 MSVC 的 CRT 编运行时那几份 .c 时，补上我们用到的
 * 那一小块 POSIX 面（第 msvc 刀）。
 *
 * 为什么需要它：自带的那条腿（`--cc self`）读的是 `sysroot/win32/include` —— 那儿的
 * `sys/wait.h` / `unistd.h` 一族是**我们自己写的**，由自带那份 libc 实现。而 `--cc msvc`
 * 让 `cl` 去编，`cl` 读的是真的 Windows SDK：那里头压根没有这些头，于是
 *   omni_fmt.c(5): fatal error C1083: Cannot open include file: 'sys/wait.h'
 *
 * 这一份只补**运行时真正用到的那几格**，不是一套 POSIX 兼容层：多补一格就多一格要维护的
 * 谎话。每一格都写清它在 Windows 上对应什么。
 */
#ifndef OMNI_WIN32_H
#define OMNI_WIN32_H

#if defined(_WIN32) && !defined(__OMNI_LIBC__)

#include <time.h>
/* `WIN32_LEAN_AND_MEAN` / `NOMINMAX`：少拉一大片（socket、OLE、RPC、shell 那几套我们一个
 * 都不用），也少一片宏。这一份头**每个翻译单元都会进来**（`omni.h` 里那一句），所以这两格
 * 既省编译时间、也少一类撞名字。 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN 1
#endif
#ifndef NOMINMAX
#define NOMINMAX 1
#endif
#include <windows.h>

/* **把 16 位时代那三个关键字的残骸拆掉**：windows.h（minwindef.h / rpcndr.h）里至今还有
 * `#define near`、`#define far`、`#define small` —— 它们把这三个名字换成空或 `char`。
 * 我们的运行时里就有叫 `near` 的局部变量，量到的是
 *   omni_js.c(295): error C2059: syntax error: '='
 * 那一行原本是 `const omni_js_list_view *near = NULL;`（`near` 被换成了空），后面跟着一串
 * 看不出因果的 C2059/C2440。这三个名字在今天的 C 里没有意义，进门就拆。 */
#undef near
#undef far
#undef small

/* ---- 进程退出状态 ----
 * POSIX 把"怎么结束的"编码进一个 int（信号/退出码/停止），要靠 `WIFEXITED`/`WEXITSTATUS`
 * 拆。Windows 没有这一层 —— `GetExitCodeProcess` 回的就是退出码本身，所以这两格是恒真与恒等。 */
#ifndef WIFEXITED
#define WIFEXITED(s) (1)
#endif
#ifndef WEXITSTATUS
#define WEXITSTATUS(s) (s)
#endif
#ifndef WIFSIGNALED
#define WIFSIGNALED(s) (0)
#endif
#ifndef WTERMSIG
#define WTERMSIG(s) (0)
#endif

/* ---- clock_gettime ----
 * UCRT 有 C11 的 `struct timespec` 与 `timespec_get`，可**没有** `clock_gettime` 与
 * `CLOCK_MONOTONIC`/`CLOCK_REALTIME`（那是 POSIX 的）。量到的是
 *   omni_fmt.c(415): error C2065: 'CLOCK_MONOTONIC': undeclared identifier
 *
 * 两条时钟在 Windows 上各有正主，不能混：
 *   单调 —— `QueryPerformanceCounter`（开机起算，不受改系统时间影响）
 *   实时 —— `GetSystemTimeAsFileTime`（1601 纪元的 100ns 刻度，减掉那个常数就是 Unix 纪元）
 *
 * `static` 而不是另编一份 .c：这一格是给"每个用到它的 TU"的，没有状态要共享
 * （频率那一格自己 cache，反正整个进程里是同一个值）。 */
#ifndef CLOCK_REALTIME
#define CLOCK_REALTIME 0
#endif
#ifndef CLOCK_MONOTONIC
#define CLOCK_MONOTONIC 1
#endif

static int clock_gettime(int which, struct timespec *ts) {
  if (ts == 0) return -1;
  if (which == CLOCK_MONOTONIC) {
    static LARGE_INTEGER freq;
    LARGE_INTEGER now;
    if (freq.QuadPart == 0) QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&now);
    ts->tv_sec = (time_t)(now.QuadPart / freq.QuadPart);
    ts->tv_nsec = (long)(((now.QuadPart % freq.QuadPart) * 1000000000LL) / freq.QuadPart);
    return 0;
  }
  FILETIME ft;
  ULARGE_INTEGER u;
  unsigned long long t;
  GetSystemTimeAsFileTime(&ft);
  u.LowPart = ft.dwLowDateTime;
  u.HighPart = ft.dwHighDateTime;
  /* 1601-01-01 到 1970-01-01 之间是 116444736000000000 个 100ns。 */
  t = u.QuadPart - 116444736000000000ULL;
  ts->tv_sec = (time_t)(t / 10000000ULL);
  ts->tv_nsec = (long)((t % 10000000ULL) * 100);
  return 0;
}

/* ---- mkdir ----
 * UCRT 里是 `_mkdir(path)`（`<direct.h>`），**只有一个参数** —— Windows 的 ACL 不是那三组
 * 权限位，所以 `mode` 那一格没有对应物，丢掉。`omni_mkdir_p` 那一路本来也不看返回值
 * （做不到就让后面的 fopen 去报，它的话更清楚）。
 *
 * 量到的（clang 这条腿）：
 *   omni_fmt.c:125:5: error: call to undeclared function 'mkdir'; ISO C99 and later do not
 *                     support implicit function declarations
 * `cl` 那条腿只当成 C4013 警告放过去了，所以这一格从前是"看着能编"的 —— 隐式声明按
 * `int mkdir()` 走，参数个数对不上，实际调的是别人。 */
#include <direct.h>
#ifndef mkdir
#define mkdir(path, mode) _mkdir(path)
#endif

/* ---- gmtime_r / localtime_r ----
 * UCRT 给的是 C11 附录 K 那一套 `gmtime_s` / `localtime_s`：**参数次序与 POSIX 反过来**
 * （先出参、后时间），回的是 `errno_t`（0 是成功）而不是指针。 */
static struct tm *gmtime_r(const time_t *t, struct tm *out) {
  return gmtime_s(out, t) == 0 ? out : 0;
}
static struct tm *localtime_r(const time_t *t, struct tm *out) {
  return localtime_s(out, t) == 0 ? out : 0;
}

/* ---- POSIX 那一批"老名字" ----
 * `open` / `close` / `read` / `write` / `isatty` / `getcwd` / `getpid` / `mkdir` 这些
 * **UCRT 自己就有**，它把它们叫"非标准名字"，一律 deprecate 到 `_open` 那种带下划线的
 * 形式上。所以这儿不必自己实现，把头包进来、把那条噪音关掉就够了。
 * 量过（clang 23.1 + UCRT 10.0.26100）：只报 deprecation 警告，编得过、跑得对。 */
#ifndef _CRT_NONSTDC_NO_WARNINGS
#define _CRT_NONSTDC_NO_WARNINGS 1
#endif
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS 1
#endif
#include <direct.h>
#include <fcntl.h>
#include <io.h>
#include <process.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

/* `ssize_t` 不在 UCRT 里（它那边叫 `SSIZE_T`，在 BaseTsd.h 的 Windows 类型里）。 */
#ifndef _SSIZE_T_DEFINED
#define _SSIZE_T_DEFINED
#ifdef _WIN64
typedef long long ssize_t;
#else
typedef int ssize_t;
#endif
#endif

/* `mode_t` / `pid_t` 同理（只有带下划线的 `_mode_t`；pid 那一格 UCRT 压根没有）。 */
#ifndef _PID_T_
#define _PID_T_
typedef int pid_t;
#endif

/* `S_ISDIR` / `S_ISREG` 是 POSIX 的宏；UCRT 只给位（`_S_IFDIR`）。 */
#ifndef S_ISDIR
#define S_ISDIR(m) (((m) & _S_IFMT) == _S_IFDIR)
#endif
#ifndef S_ISREG
#define S_ISREG(m) (((m) & _S_IFMT) == _S_IFREG)
#endif

/* `pipe`：UCRT 的 `_pipe` 多两格（缓冲大小、模式）。**二进制**——我们从管道里递的是
 * IR 与 UTF-8，文本模式会把 `\n` 翻成 `\r\n`，两条腿的输出当场分叉。 */
#ifndef pipe
#define pipe(fds) _pipe((fds), 65536, _O_BINARY)
#endif

/* ---- mkdtemp / realpath / setenv ----
 * 三格 POSIX 的便利函数，UCRT 各有一个形状不同的对应物：
 *   `_mktemp_s`  把模板里的 XXXXXX 换成一个没人用的名字，**但不建目录**（所以要补一句 _mkdir）
 *   `_fullpath`  与 realpath 同一件事（不解符号链接这一点两边都一样）
 *   `_putenv_s`  没有 `overwrite` 那一格（它一律覆盖），所以那一格自己判 */
static char *mkdtemp(char *tpl) {
  if (_mktemp_s(tpl, strlen(tpl) + 1) != 0) return 0;
  if (_mkdir(tpl) != 0) return 0;
  return tpl;
}

static char *realpath(const char *path, char *out) {
  /* 调用点给的都是 `char buf[4096]`（omni_js_host.c 的 fs_realpath）。 */
  return _fullpath(out, path, 4096);
}

static int setenv(const char *name, const char *val, int overwrite) {
  if (!overwrite && getenv(name) != 0) return 0;
  return _putenv_s(name, val) == 0 ? 0 : -1;
}

/* ---- dlopen 一族 ----
 * `LoadLibraryA` / `GetProcAddress` / `FreeLibrary` 一一对应。四个 `RTLD_*` 在 Windows 上
 * 没有对应物（PE 的导入解析没有"延迟到第一次用"与"进全局命名空间"这两档可选），一律 0。 */
#ifndef RTLD_NOW
#define RTLD_NOW 0
#define RTLD_LAZY 0
#define RTLD_LOCAL 0
#define RTLD_GLOBAL 0
#endif

static void *dlopen(const char *path, int flags) {
  (void)flags;
  return (void *)LoadLibraryA(path);
}

static void *dlsym(void *h, const char *name) {
  /* 函数指针 -> void*：C 里那是实现定义的，PE/Win64 上两者同宽，中间过一格整数免得警告。 */
  return (void *)(INT_PTR)GetProcAddress((HMODULE)h, name);
}

static int dlclose(void *h) { return FreeLibrary((HMODULE)h) ? 0 : -1; }

static char *dlerror(void) {
  static char buf[256];
  DWORD e = GetLastError();
  if (e == 0) return 0;
  buf[0] = '\0';
  FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                 NULL, e, 0, buf, (DWORD)sizeof buf, NULL);
  return buf[0] == '\0' ? 0 : buf;
}

/* ---- getrusage（只有 `ru_maxrss` 那一格用得上）----
 * `K32GetProcessMemoryInfo` 与 psapi 里那个 `GetProcessMemoryInfo` 是同一个实现，只是
 * **它在 kernel32 里**（Win7 起）—— 用它就不必为这一格去链 psapi.lib。
 * 结构体自己声明一份（psapi.h 没包进来）：布局是 ABI 的一部分，不能改次序。
 * 单位：Windows 给的是字节，而调用点在非 macOS 上乘 1024（POSIX 那边是 KB）——
 * 所以这儿要除回去，让那一侧的乘法算出正确的字节数。 */
typedef struct {
  DWORD cb;
  DWORD PageFaultCount;
  SIZE_T PeakWorkingSetSize;
  SIZE_T WorkingSetSize;
  SIZE_T QuotaPeakPagedPoolUsage;
  SIZE_T QuotaPagedPoolUsage;
  SIZE_T QuotaPeakNonPagedPoolUsage;
  SIZE_T QuotaNonPagedPoolUsage;
  SIZE_T PagefileUsage;
  SIZE_T PeakPagefileUsage;
} omni_w32_pmc;

__declspec(dllimport) BOOL __stdcall K32GetProcessMemoryInfo(HANDLE, omni_w32_pmc *, DWORD);

struct rusage { long ru_maxrss; };
#ifndef RUSAGE_SELF
#define RUSAGE_SELF 0
#endif

static int getrusage(int who, struct rusage *ru) {
  omni_w32_pmc pmc;
  (void)who;
  if (ru == 0) return -1;
  pmc.cb = (DWORD)sizeof pmc;
  if (!K32GetProcessMemoryInfo(GetCurrentProcess(), &pmc, (DWORD)sizeof pmc)) return -1;
  ru->ru_maxrss = (long)(pmc.PeakWorkingSetSize / 1024);
  return 0;
}

/* ---- 目录遍历（dirent）----
 * Windows 上是 `FindFirstFileA` + `FindNextFileA`：**要的是通配符**，给个目录名它只会回
 * 目录自己那一格，所以末尾补 `\*`。`readdir` 的那格 `static` 缓冲与 POSIX 一样不可重入
 * （调用点是 `omni_host_dir_next`，一次只走一格）。 */
typedef struct {
  HANDLE h;
  WIN32_FIND_DATAA fd;
  int first;
  int done;
} DIR;

struct dirent { char d_name[MAX_PATH]; };

static DIR *opendir(const char *path) {
  char pat[MAX_PATH];
  DIR *d;
  size_t n = path == 0 ? 0 : strlen(path);
  if (n == 0 || n + 3 >= sizeof pat) return 0;
  memcpy(pat, path, n);
  if (path[n - 1] == '\\' || path[n - 1] == '/') {
    pat[n] = '*';
    pat[n + 1] = '\0';
  } else {
    pat[n] = '\\';
    pat[n + 1] = '*';
    pat[n + 2] = '\0';
  }
  d = (DIR *)malloc(sizeof(DIR));
  if (d == 0) return 0;
  d->h = FindFirstFileA(pat, &d->fd);
  if (d->h == INVALID_HANDLE_VALUE) { free(d); return 0; }
  d->first = 1;
  d->done = 0;
  return d;
}

static struct dirent *readdir(DIR *d) {
  static struct dirent ent;
  if (d == 0 || d->done) return 0;
  if (!d->first && !FindNextFileA(d->h, &d->fd)) { d->done = 1; return 0; }
  d->first = 0;
  strncpy(ent.d_name, d->fd.cFileName, sizeof ent.d_name - 1);
  ent.d_name[sizeof ent.d_name - 1] = '\0';
  return &ent;
}

static int closedir(DIR *d) {
  if (d == 0) return -1;
  FindClose(d->h);
  free(d);
  return 0;
}

/* ---- 起一个子进程 ----
 * `fork` + `exec` 在 Windows 上没有对应物，对应物是 `CreateProcessA` 一格：命令行是**一条
 * 字符串**（拆回 argv 是被调方的事），三个标准句柄从 STARTUPINFO 递进去。
 *
 * 与自带 libc 那条腿（`sysroot/win32/libc/io.c` 的 `__libc_spawn`）**同一个形状**，好让
 * `omni_host_spawn` 那一处只有一份 Windows 代码。两点要紧：
 *   - 回的不是 HANDLE 而是**一格小票**（句柄表的下标+1）：那个返回值的类型是 `long`，
 *     Win64 上只有 32 位，直接塞 HANDLE 会截断。
 *   - 递进去的 fd 要先换成**可继承**的句柄（`SetHandleInformation`），并且
 *     `bInheritHandles` 要给 TRUE —— 少一格孩子就拿不到管道，读到的是 EOF。
 */
#define OMNI_W32_MAXPROC 64
static HANDLE omni_w32_procs[OMNI_W32_MAXPROC];

/* 一格参数按 Windows 的规矩引：有空白或引号才包，反斜杠只在引号前才要成对。 */
static void omni_w32_quote(char *dst, size_t cap, size_t *len, const char *a) {
  size_t i;
  int need = a[0] == '\0';
  size_t bs = 0;
  for (i = 0; a[i] != '\0'; i++) {
    if (a[i] == ' ' || a[i] == '\t' || a[i] == '"') need = 1;
  }
  if (!need) {
    for (i = 0; a[i] != '\0' && *len + 1 < cap; i++) dst[(*len)++] = a[i];
    return;
  }
  if (*len + 1 < cap) dst[(*len)++] = '"';
  for (i = 0; a[i] != '\0'; i++) {
    if (a[i] == '\\') { bs++; continue; }
    if (a[i] == '"') {
      size_t k;
      for (k = 0; k < bs * 2 + 1 && *len + 1 < cap; k++) dst[(*len)++] = '\\';
      bs = 0;
    } else {
      for (; bs > 0 && *len + 1 < cap; bs--) dst[(*len)++] = '\\';
    }
    if (*len + 1 < cap) dst[(*len)++] = a[i];
  }
  for (; bs > 0 && *len + 1 < cap; bs--) dst[(*len)++] = '\\';   /* 结尾的反斜杠要成对 */
  if (*len + 1 < cap) dst[(*len)++] = '\\';
  if (*len + 1 < cap) dst[(*len)++] = '"';
}

/* fd -> 可继承的句柄。fd 给 -1 就用父进程自己那一格标准句柄。 */
static HANDLE omni_w32_inherit(int fd, DWORD std) {
  HANDLE h = fd < 0 ? GetStdHandle(std) : (HANDLE)(INT_PTR)_get_osfhandle(fd);
  if (h == INVALID_HANDLE_VALUE || h == NULL) return INVALID_HANDLE_VALUE;
  SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  return h;
}

static long omni_w32_spawn(const char *cmd, char *const argv[], int fd0, int fd1, int fd2) {
  char line[32768];
  size_t len = 0;
  int i;
  int slot = -1;
  STARTUPINFOA si;
  PROCESS_INFORMATION pi;
  for (i = 0; i < OMNI_W32_MAXPROC; i++) {
    if (omni_w32_procs[i] == NULL) { slot = i; break; }
  }
  if (slot < 0) return -1;
  omni_w32_quote(line, sizeof line, &len, cmd);
  for (i = 1; argv != 0 && argv[i] != 0; i++) {
    if (len + 1 < sizeof line) line[len++] = ' ';
    omni_w32_quote(line, sizeof line, &len, argv[i]);
  }
  line[len] = '\0';
  memset(&si, 0, sizeof si);
  memset(&pi, 0, sizeof pi);
  si.cb = (DWORD)sizeof si;
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = omni_w32_inherit(fd0, STD_INPUT_HANDLE);
  si.hStdOutput = omni_w32_inherit(fd1, STD_OUTPUT_HANDLE);
  si.hStdError = omni_w32_inherit(fd2, STD_ERROR_HANDLE);
  if (!CreateProcessA(NULL, line, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) return -1;
  CloseHandle(pi.hThread);
  omni_w32_procs[slot] = pi.hProcess;
  return (long)(slot + 1);
}

static int omni_w32_spawn_wait(long tok) {
  DWORD code = 127;
  HANDLE h;
  if (tok < 1 || tok > OMNI_W32_MAXPROC) return 127;
  h = omni_w32_procs[tok - 1];
  if (h == NULL) return 127;
  WaitForSingleObject(h, INFINITE);
  GetExitCodeProcess(h, &code);
  CloseHandle(h);
  omni_w32_procs[tok - 1] = NULL;
  return (int)code;
}

/* ---- backtrace ----
 * `CaptureStackBackTrace` 是同一件事（在 kernel32 里，不必另链 dbghelp）。
 *
 * `backtrace_symbols` 那一格**不接**：把返回地址翻成函数名要 DbgHelp 加一份 PDB，那是另一笔
 * 账（而这一格只服务 `OMNI_MEM_DEBUG=4` 那条量口）。回 0 —— 调用点（omni_mem.c 里那张表）
 * 本来就按"翻不出名字就跳过这一行"写的（`if (syms == NULL) continue;`）。 */
static int backtrace(void **buf, int n) {
  if (buf == 0 || n <= 0) return 0;
  return (int)CaptureStackBackTrace(0, (DWORD)n, buf, NULL);
}

static char **backtrace_symbols(void *const *buf, int n) {
  (void)buf;
  (void)n;
  return 0;
}

/* ---- stdout / stderr 走二进制 ----
 * MSVC 的 CRT 默认把这两格开成**文本模式**：每一个 `\n` 出门都变成 `\r\n`。于是 C 这条腿
 * 与 JS 那条腿的输出逐字节比起来会全不一样 —— 量到的是 `01_basics` 的 35 行输出 35 行全
 * 报不同，而每一行的可见内容其实一模一样，差的只是行尾那一个字节。
 *
 * 我们发出去的字节本来就是**最终字节**（UTF-8 + `\n`，行尾归语言那一侧管，不归 CRT），
 * 所以两格都摆成二进制。自带 libc 那条腿压根没有这层翻译，本来就是这个样子。 */
static void omni_w32_binary_stdio(void) {
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stderr), _O_BINARY);
}

#endif /* _WIN32 */
#endif /* OMNI_WIN32_H */
