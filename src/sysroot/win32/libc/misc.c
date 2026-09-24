/* misc.c — arm64 Windows 的时间、环境、进程、目录（第 win-c-backend 刀）。
 *
 * 与另两条腿（osx/linux）同一份函数表，实现全换成 kernel32：
 *   时间   GetSystemTimeAsFileTime / QueryPerformanceCounter
 *   环境   GetEnvironmentVariableA / SetEnvironmentVariableA（**表在系统那边**，
 *          所以不像另两条腿那样自己管一块 environ 的地方 —— `environ` 只在 start.c
 *          里拍一次快照，给那些直接读它的程序用）
 *   目录   FindFirstFileA / FindNextFileA（Windows 没有 getdents 那种记录流，
 *          所以 `readdir` 是「每次问系统一条」，不用缓冲区）
 *   进程   `system` 走 CreateProcessA("cmd.exe /c …")；**fork/exec 一族回 ENOSYS** ——
 *          Windows 上没有 fork，硬凑出来的都是半成品，明着说不会比悄悄骗人好。
 *
 * 信号那一族（sigaction/alarm/setitimer）在这条腿上是**空操作**：Windows 没有信号，
 * 采样 profiler 那一格改走采样线程（见 `src/runtime/omni_prof.c` 的 win32 分支）。
 */
#include "libc.h"

/* io.c 里那几个这一份也要用（`remove`/`mkdtemp`）——与另两条腿一样在这儿声明一遍，
   免得走隐式声明（那会把返回类型当 int、把指针参数当 int 传）。 */
int unlink(const char *p);
int rmdir(const char *p);
int mkdir(const char *p, unsigned int mode);

unsigned int GetCurrentProcessId(void);
unsigned int GetFullPathNameA(const char *name, unsigned int n, char *buf, char **part);

struct __timespec { long tv_sec; long tv_nsec; };

/* FILETIME 是 100ns 自 1601-01-01 起；Unix 纪元差 11644473600 秒。 */
#define OMNI_FT_EPOCH 11644473600LL

static long long __now_ft(void) {
  long long ft = 0;
  GetSystemTimeAsFileTime(&ft);
  return ft;
}

long time(long *tp) {
  long t = (long)(__now_ft() / 10000000LL - OMNI_FT_EPOCH);
  if (tp != (long *)0) *tp = t;
  return t;
}

int clock_gettime(int which, struct __timespec *ts) {
  (void)which;
  long long ft = __now_ft();
  ts->tv_sec = (long)(ft / 10000000LL - OMNI_FT_EPOCH);
  ts->tv_nsec = (long)((ft % 10000000LL) * 100);
  return 0;
}

/** `clock()`：CLOCKS_PER_SEC 这条腿按 1000000 算（与另两条腿一致）。 */
long clock(void) {
  long long ft = __now_ft();
  return (long)((ft / 10LL) % 1000000000LL);
}
/* ---- 环境。表在系统那边，`getenv` 回的指针得指向我们自己的地方，所以按名字缓存一格轮转的
   缓冲区：调用方拿去用之前不会再调 32 次 getenv（量过公用那一半的用法，四格够）。 */
#define ENV_SLOTS 4
#define ENV_SLOT_B 1024
static char __env_buf[ENV_SLOTS][ENV_SLOT_B];
static int __env_next;

char *getenv(const char *name) {
  char *slot = __env_buf[__env_next];
  unsigned int n = GetEnvironmentVariableA(name, slot, ENV_SLOT_B);
  if (n == 0 || n >= ENV_SLOT_B) return (char *)0;
  __env_next = (__env_next + 1) % ENV_SLOTS;
  return slot;
}

int setenv(const char *name, const char *val, int overwrite) {
  if (!overwrite) {
    char tmp[2];
    if (GetEnvironmentVariableA(name, tmp, 2) != 0) return 0;   /* 已经有了，不覆盖 */
  }
  if (!SetEnvironmentVariableA(name, val)) return (int)__libc_oserr();
  return 0;
}

int unsetenv(const char *name) {
  /* Win32 的约定：值给 NULL 就是删掉这一格。 */
  if (!SetEnvironmentVariableA(name, (const char *)0)) return (int)__libc_oserr();
  return 0;
}

int getpid(void) { return (int)GetCurrentProcessId(); }

/* ---- 进程。fork/exec 一族在 Windows 上没有对应物，回 ENOSYS(38) 而不是假装成功。 */
int fork(void) { __libc_errno_val = 38; return -1; }
int execve(const char *path, char *const argv[], char *const envp[]) {
  (void)path; (void)argv; (void)envp; __libc_errno_val = 38; return -1;
}
int execvp(const char *file, char *const argv[]) {
  (void)file; (void)argv; __libc_errno_val = 38; return -1;
}
int waitpid(int pid, int *status, int opts) {
  (void)pid; (void)status; (void)opts; __libc_errno_val = 38; return -1;
}
int wait(int *status) { return waitpid(-1, status, 0); }
int kill(int pid, int sig) { (void)pid; (void)sig; __libc_errno_val = 38; return -1; }
/* `system`：CreateProcessA 起 `cmd.exe /c CMD`，等它完，回**退出码本身**。
 * 另两条腿回的是 `waitpid` 那个原始状态字（退出码在高 8 位），这儿没有那层包装 ——
 * 公用那一半只看「是不是 0」，而这条腿上没有信号，凑一个假的状态字只会误导。 */
int system(const char *cmd) {
  if (cmd == (const char *)0) return 1;              /* 「有没有 shell」：有 */
  char line[4096];
  const char *pre = "cmd.exe /c ";
  unsigned long i = 0;
  while (pre[i] != 0) { line[i] = pre[i]; i++; }
  unsigned long j = 0;
  while (cmd[j] != 0 && i + 1 < sizeof(line)) line[i++] = cmd[j++];
  line[i] = 0;
  /* STARTUPINFOA 是 104 字节（cb 在 0），PROCESS_INFORMATION 是 24（hProcess 在 0）。
     照字节摆，省一份 Windows 头。 */
  unsigned char si[104];
  unsigned char pi[24];
  memset(si, 0, sizeof(si));
  memset(pi, 0, sizeof(pi));
  *(unsigned int *)si = (unsigned int)sizeof(si);
  if (!CreateProcessA((const char *)0, line, 0, 0, 1, 0, 0, (const char *)0, si, pi)) {
    return (int)__libc_oserr();
  }
  void *hproc = *(void **)(pi + 0);
  void *hthread = *(void **)(pi + 8);
  WaitForSingleObject(hproc, 0xffffffffu);
  unsigned int code = 1;
  GetExitCodeProcess(hproc, &code);
  CloseHandle(hthread);
  CloseHandle(hproc);
  return (int)code;
}

/* ---- 信号与定时器：Windows 上没有，所以**明着回失败**（ENOSYS），不回 0。
 * 回 0 会让调用方以为装上了：`omni_prof.c` 的采样档正是「`sigaction` 与 `setitimer`
 * 都成了就置 `pf_sampling`」，骗它一次就变成「开着采样却一个样本都没有」。
 * 回 -1 它自己会退到不采样那一支（那一段本来就写了退路）。
 * 采样在这条腿上要另走采样线程（`SuspendThread`/`GetThreadContext`），是另一刀。 */
unsigned int alarm(unsigned int sec) { (void)sec; return 0; }
int setitimer(int which, const void *nv, void *ov) {
  (void)which; (void)nv; (void)ov; __libc_errno_val = 38; return -1;
}
int getitimer(int which, void *cur) { (void)which; (void)cur; __libc_errno_val = 38; return -1; }
int sigaction(int sig, const void *act, void *old) {
  (void)sig; (void)act; (void)old; __libc_errno_val = 38; return -1;
}
int sigemptyset(void *set) { *(unsigned int *)set = 0; return 0; }
int sigfillset(void *set) { *(unsigned int *)set = ~0u; return 0; }
int sigaddset(void *set, int sig) { *(unsigned int *)set |= (1u << ((sig - 1) & 31)); return 0; }
int sigdelset(void *set, int sig) { *(unsigned int *)set &= ~(1u << ((sig - 1) & 31)); return 0; }
int sigismember(const void *set, int sig) {
  return (*(const unsigned int *)set & (1u << ((sig - 1) & 31))) != 0 ? 1 : 0;
}

/* ---- 线程：照 POSIX 回 EAGAIN —— 运行时本来就有「开不出线程就直接调 entry」的退路
   （`omni_js_host.c`）。真要线程走的是 CreateThread，那是运行时自己的事，不在 libc 里。 */
int pthread_create(void *t, const void *a, void *(*fn)(void *), void *arg) {
  (void)t; (void)a; (void)fn; (void)arg; return 11;
}
int pthread_join(unsigned long t, void **r) { (void)t; (void)r; return 3; }
unsigned long pthread_self(void) { return 1; }
int pthread_attr_init(void *a) { (void)a; return 0; }
int pthread_attr_destroy(void *a) { (void)a; return 0; }
int pthread_attr_setstacksize(void *a, unsigned long n) { (void)a; (void)n; return 0; }
int pthread_attr_getstacksize(void *a, unsigned long *n) {
  (void)a; if (n) *n = 8388608; return 0;
}

/* **TSD 这三条不是桩，是真的**（第 win-c-backend 刀）：运行时的 arena 按线程查
 * （`omni_mem.c` 在 `OMNI_NO_TLS` 下的 `omni_arena_get`），每次分配都要走一趟。
 * 第一版这三条**根本没有**，链接器把它们当 0 收了，于是 basics.exe 一跑就
 * 0xC0000005（调地址 0）—— 那笔账记在这儿：Windows 上没有 pthread，可 TSD 有
 * 一对一的东西（`TlsAlloc`/`TlsGetValue`/`TlsSetValue`），照它实现即可。
 * 析构函数（`dtor`）不支持：Win32 的 TLS 槽没有「线程退出时回调」那一格
 * （那要 DLL 的 `DLL_THREAD_DETACH`），而运行时传的本来就是 NULL。 */
int pthread_key_create(unsigned int *key, void (*dtor)(void *)) {
  (void)dtor;
  unsigned int idx = TlsAlloc();
  if (idx == TLS_OUT_OF_INDEXES) { __libc_errno_val = 11; return 11; }   /* EAGAIN */
  *key = idx;
  return 0;
}

int pthread_key_delete(unsigned int key) {
  return TlsFree(key) ? 0 : 22;                  /* EINVAL */
}

void *pthread_getspecific(unsigned int key) {
  return TlsGetValue(key);
}

int pthread_setspecific(unsigned int key, const void *val) {
  return TlsSetValue(key, (void *)val) ? 0 : 22;
}

int getrlimit(int which, void *rl) { (void)which; memset(rl, 0, 16); return 0; }
int getrusage(int who, void *ru) { (void)who; memset(ru, 0, 144); return 0; }

/* `_Exit`：不跑 atexit、直接走（C99）。 */
void _Exit(int code) { ExitProcess((unsigned int)code); for (;;) { } }

/* 会话与 exec 那两条这条腿上没有对应物 —— 明着回失败。 */
int setsid(void) { __libc_errno_val = 38; return -1; }
int execl(const char *path, const char *arg0, ...) {
  (void)path; (void)arg0; __libc_errno_val = 38; return -1;
}

/* `dlopen` 一族：Windows 上就是 `LoadLibraryA`/`GetProcAddress`/`FreeLibrary`。
 * `omni_r3.c` 用它在运行期找 GL 那个插件（找不到就走 CPU 备选），所以这三条
 * **不是桩** —— 回真的句柄，找不到回 0 并把话写进 `dlerror` 那一格。 */
static char __dl_err[128];

void *dlopen(const char *path, int mode) {
  (void)mode;
  if (path == (const char *)0) return GetCurrentProcess();   /* dlopen(NULL) = 自己 */
  void *h = LoadLibraryA(path);
  if (h == 0) {
    const char *m = "LoadLibraryA 失败";
    unsigned long i = 0;
    while (m[i] != 0 && i + 1 < sizeof(__dl_err)) { __dl_err[i] = m[i]; i++; }
    __dl_err[i] = 0;
  }
  return h;
}

void *dlsym(void *handle, const char *name) {
  void *p = GetProcAddress(handle, name);
  if (p == 0) {
    const char *m = "GetProcAddress 找不到这个名字";
    unsigned long i = 0;
    while (m[i] != 0 && i + 1 < sizeof(__dl_err)) { __dl_err[i] = m[i]; i++; }
    __dl_err[i] = 0;
  }
  return p;
}

int dlclose(void *handle) { return FreeLibrary(handle) ? 0 : -1; }

char *dlerror(void) {
  if (__dl_err[0] == 0) return (char *)0;
  return __dl_err;
}
/* ---- 目录。Windows 没有 getdents 那种「一口气给一段记录流」，只有
   FindFirstFileA/FindNextFileA 的「一条一条给」，所以这一份不用缓冲区。
   WIN32_FIND_DATAA 的排布（照字节读，省一份 Windows 头）：
     0 attrs、4/12/20 三个 FILETIME、28 sizeHigh、32 sizeLow、36/40 保留、
     44 cFileName[260]、304 cAlternateFileName[14] —— 一共 320 字节。 */
struct __dirent {
  unsigned long d_ino;
  long d_off;
  unsigned short d_reclen;
  unsigned char d_type;
  char d_name[1024];
};
struct __DIR {
  void *h;
  int first;
  unsigned char fd_data[320];
  struct __dirent ent;
};
typedef struct __DIR DIR;

DIR *opendir(const char *path) {
  char pat[1024];
  unsigned long n = strlen(path);
  if (n + 3 >= sizeof(pat)) { __libc_errno_val = 36; return (DIR *)0; }   /* ENAMETOOLONG */
  memcpy(pat, path, n);
  if (n > 0 && pat[n - 1] != '\\' && pat[n - 1] != '/') pat[n++] = '\\';
  pat[n++] = '*';
  pat[n] = 0;
  DIR *d = (DIR *)malloc(sizeof(DIR));
  if (d == (DIR *)0) { __libc_errno_val = 12; return (DIR *)0; }
  d->h = FindFirstFileA(pat, d->fd_data);
  if (d->h == INVALID_HANDLE_VALUE) {
    free(d);
    __libc_oserr();
    return (DIR *)0;
  }
  d->first = 1;
  return d;
}

struct __dirent *readdir(DIR *d) {
  if (!d->first) {
    if (!FindNextFileA(d->h, d->fd_data)) return (struct __dirent *)0;
  }
  d->first = 0;
  unsigned int attrs = *(unsigned int *)(d->fd_data + 0);
  const char *name = (const char *)(d->fd_data + 44);
  unsigned long n = strlen(name);
  if (n > 1023) n = 1023;
  memcpy(d->ent.d_name, name, n);
  d->ent.d_name[n] = 0;
  d->ent.d_ino = 0;
  d->ent.d_off = 0;
  d->ent.d_reclen = (unsigned short)sizeof(struct __dirent);
  /* d_type 用 POSIX 的号：DT_DIR=4、DT_REG=8（调用方按这两个分叉）。 */
  d->ent.d_type = (attrs & FILE_ATTRIBUTE_DIRECTORY) ? 4 : 8;
  return &d->ent;
}

int closedir(DIR *d) {
  FindClose(d->h);
  free(d);
  return 0;
}

int remove(const char *path) {
  unsigned int attrs = GetFileAttributesA(path);
  if (attrs == INVALID_FILE_ATTRIBUTES) return (int)__libc_oserr();
  return (attrs & FILE_ATTRIBUTE_DIRECTORY) ? rmdir(path) : unlink(path);
}

char *realpath(const char *path, char *out) {
  /* out 给 NULL 时按 POSIX 自己要一块（调用方 free）。GetFullPathNameA 只做字符串
     规整（不查存在性），与另两条腿的 realpath 差这一点 —— 需要查存在性的地方
     自己 stat，那也是它们本来就在做的。 */
  char *buf = out;
  if (buf == (char *)0) {
    buf = (char *)malloc(1024);
    if (buf == (char *)0) { __libc_errno_val = 12; return (char *)0; }
  }
  unsigned int n = GetFullPathNameA(path, 1024, buf, (char **)0);
  if (n == 0 || n >= 1024) {
    if (out == (char *)0) free(buf);
    __libc_oserr();
    return (char *)0;
  }
  return buf;
}

char *mkdtemp(char *tmpl) {
  /* 模板尾巴是六个 X。拿 pid 加一个自增数填 —— 与另两条腿同一个做法。 */
  static unsigned int seq;
  unsigned long n = strlen(tmpl);
  if (n < 6) { __libc_errno_val = 22; return (char *)0; }
  for (int tries = 0; tries < 128; tries++) {
    unsigned int v = GetCurrentProcessId() * 131u + (seq++) * 7919u + (unsigned int)tries;
    for (int k = 0; k < 6; k++) {
      tmpl[n - 6 + k] = (char)('a' + (int)((v >> (k * 5)) % 26u));
    }
    if (mkdir(tmpl, 0700) == 0) return tmpl;
  }
  return (char *)0;
}

/* ---- `setjmp`/`longjmp`：与另两条腿**同一行代码**，差别全在后端（`OP.SETJMP`/
 * `OP.LONGJMP` 存被调用者保存的那几格 + 调用者的帧指针/栈顶/返回地址，见
 * `arm64/from_mir.js` 与 `x64/from_mir.js`）。这条路**不碰 Windows 的 SEH**：
 * `RtlUnwind` 那一套要 `.pdata`/`.xdata`，我们链出来的 PE 没有那两节。
 * `jmp_buf` 在这条腿上 200 字节（`include/setjmp.h`）：arm64 用头 168、x64 用头 64。 */
int setjmp(void *env) { return __omni_setjmp(env); }
void longjmp(void *env, int val) { __omni_longjmp(env, val); }

/* `sigsetjmp`/`siglongjmp`：Windows 上**没有信号掩码**（`sigaction` 一族在这条腿
 * 一律回 -1/ENOSYS，见文件头那张表），`savemask` 只能忽略 —— 旗子照样写 0 进偏移
 * 168（arm64 用到 167 为止，装得下），好让读 `jmp_buf` 的人看见「没存」。 */
int sigsetjmp(void *env, int savemask) {
  unsigned char *e = (unsigned char *)env;
  (void)savemask;
  *(long long *)(e + 168) = 0;
  return __omni_setjmp(env);
}
void siglongjmp(void *env, int val) { __omni_longjmp(env, val); }
