/* syscall.h — arm64 Windows：这条腿上**没有 syscall**（第 win-c-backend 刀）。
 *
 * 另两个目标（arm64-osx / x86_64-linux）的平台层踩的是 `__omni_syscall`（MIR 的
 * `SYSCALL` op，降成 `svc #0x80` / `syscall`）。Windows 上这条路走不通，而且不是
 * 「难」而是「不该」：NT 的裸调用号每个版本都可能换，官方从来没有承诺过它稳定
 * （ntdll 才是那层薄封装）。所以这一份把同一批口子架在 **kernel32 的导入函数**上 ——
 * 出来的 `.exe` 仍然只有一张导入表（kernel32.dll），那是 Windows 的地板，
 * tcc 的 win32 那一路也是这么办的。
 *
 * 于是这一份里没有一个 `SYS_*` 常量，取而代之的是 kernel32 的原型。ARM64 上只有
 * 一种调用约定（没有 stdcall/cdecl 之分、名字也不修饰），所以直接 `extern` 声明就够。
 *
 * `__libc_check` 的形状与另两条腿保持一致（回 -1、把 errno 填进 `__libc_errno_val`），
 * 只是来源从「负的返回值」换成 `GetLastError()` —— 见 `__libc_oserr`。
 */
#ifndef __OMNI_SYSCALL_H
#define __OMNI_SYSCALL_H

extern int __libc_errno_val;

/* ---- kernel32：句柄与标准流 */
void *GetStdHandle(unsigned int which);
int CloseHandle(void *h);
unsigned int GetLastError(void);
void ExitProcess(unsigned int code);
/* 崩了要能说一句话：VEH **不需要展开表**，所以这条没有 `.pdata` 的腿也用得上
 * （`start.c` 里的 `__veh`）。第二个参数是 `LONG (*)(EXCEPTION_POINTERS *)`。 */
void *AddVectoredExceptionHandler(unsigned int first, long (*fn)(void *));
/* 自己那份映像装在哪儿（参数给 0 = 问自己）。崩溃那一句要拿它把 pc 折成 RVA。 */
void *GetModuleHandleA(const char *name);

#define STD_INPUT_HANDLE   ((unsigned int)-10)
#define STD_OUTPUT_HANDLE  ((unsigned int)-11)
#define STD_ERROR_HANDLE   ((unsigned int)-12)
#define INVALID_HANDLE_VALUE ((void *)(long long)-1)

/* ---- 文件 */
void *CreateFileA(const char *name, unsigned int access, unsigned int share,
                  void *sec, unsigned int disp, unsigned int flags, void *tmpl);
int ReadFile(void *h, void *buf, unsigned int n, unsigned int *got, void *ov);
int WriteFile(void *h, const void *buf, unsigned int n, unsigned int *put, void *ov);
int SetFilePointerEx(void *h, long long off, long long *newpos, unsigned int whence);
int SetEndOfFile(void *h);
int FlushFileBuffers(void *h);
unsigned int GetFileType(void *h);
int GetFileSizeEx(void *h, long long *size);
int GetFileInformationByHandle(void *h, void *info);
unsigned int GetFileAttributesA(const char *name);
int CreateDirectoryA(const char *name, void *sec);
int RemoveDirectoryA(const char *name);
int DeleteFileA(const char *name);
int MoveFileExA(const char *from, const char *to, unsigned int flags);
unsigned int GetCurrentDirectoryA(unsigned int n, char *buf);
int SetCurrentDirectoryA(const char *name);
void *FindFirstFileA(const char *pat, void *data);
int FindNextFileA(void *h, void *data);
int FindClose(void *h);
int DuplicateHandle(void *sp, void *sh, void *tp, void **th,
                    unsigned int access, int inherit, unsigned int opts);
void *GetCurrentProcess(void);
int CreatePipe(void **rd, void **wr, void *sec, unsigned int size);

#define GENERIC_READ   0x80000000u
#define GENERIC_WRITE  0x40000000u
#define FILE_SHARE_ALL 0x00000007u
#define CREATE_ALWAYS  2u
#define OPEN_EXISTING  3u
#define OPEN_ALWAYS    4u
#define FILE_ATTRIBUTE_NORMAL    0x00000080u
#define FILE_ATTRIBUTE_DIRECTORY 0x00000010u
#define INVALID_FILE_ATTRIBUTES  0xffffffffu
#define FILE_TYPE_CHAR 0x0002u
#define MOVEFILE_REPLACE_EXISTING 0x1u
#define DUPLICATE_SAME_ACCESS 0x2u

/* ---- 内存：公用那份 malloc 的「跟系统要地方」落到 VirtualAlloc */
void *VirtualAlloc(void *at, unsigned long long size, unsigned int type, unsigned int prot);
int VirtualFree(void *at, unsigned long long size, unsigned int type);

#define MEM_COMMIT      0x00001000u
#define MEM_RESERVE     0x00002000u
#define MEM_RELEASE     0x00008000u
#define PAGE_READWRITE  0x00000004u

/* ---- 按线程存一格东西（TSD）。运行时的 arena 走这条：我们自己的 C 前端不认
 * `_Thread_local`，于是 `omni_mem.c` 在 `OMNI_NO_TLS` 下按 pthread 的 TSD 查
 * （账在 `runtime/omni.h` 上）。Windows 自己的那一格就是 `TlsAlloc` 一族。 */
unsigned int TlsAlloc(void);
int TlsFree(unsigned int idx);
void *TlsGetValue(unsigned int idx);
int TlsSetValue(unsigned int idx, void *val);

#define TLS_OUT_OF_INDEXES 0xffffffffu

/* ---- 动态库：`dlopen` 一族落到这三条（`omni_r3.c` 在运行期找 GL 插件走它）。 */
void *LoadLibraryA(const char *name);
void *GetProcAddress(void *mod, const char *name);
int FreeLibrary(void *mod);

/* ---- 时间、环境、进程 */
void GetSystemTimeAsFileTime(void *ft);
unsigned int GetEnvironmentVariableA(const char *name, char *buf, unsigned int n);
int SetEnvironmentVariableA(const char *name, const char *val);
char *GetEnvironmentStrings(void);
int FreeEnvironmentStringsA(char *p);
char *GetCommandLineA(void);

/* 控制台的**输出代码页**。我们所有输出都是 UTF-8 字节，而控制台默认按本地页解码
 * （简体中文机器上是 936），于是自己印出来的中文在 cmd 里是一片乱码 —— 量到的原话：
 *   omni 鈥?stage0 bootstrap compiler / 缂栬瘧骞舵墽琛?
 * 手工 `chcp 65001` 之后同一个 exe 就对了，所以坏的不是字节，是解码那一头。 */
unsigned int GetConsoleOutputCP(void);
int SetConsoleOutputCP(unsigned int cp);
int CreateProcessA(const char *app, char *cmd, void *psec, void *tsec, int inherit,
                   unsigned int flags, void *env, const char *cwd, void *si, void *pi);
unsigned int WaitForSingleObject(void *h, unsigned int ms);
int GetExitCodeProcess(void *h, unsigned int *code);
void Sleep(unsigned int ms);

/* ---- errno：Windows 的错误码映射到 POSIX 的那几个常用值。
 * 只映我们自己的 libc 会回给用户的那些 —— 没映到的一律 EIO(5)，
 * 判据里比的是「成功/失败」与 errno 的**那几个特定值**（ENOENT/EEXIST/EACCES…）。 */
#define OMNI_ERROR_FILE_NOT_FOUND    2u
#define OMNI_ERROR_PATH_NOT_FOUND    3u
#define OMNI_ERROR_ACCESS_DENIED     5u
#define OMNI_ERROR_INVALID_HANDLE    6u
#define OMNI_ERROR_NOT_ENOUGH_MEMORY 8u
#define OMNI_ERROR_FILE_EXISTS       80u
#define OMNI_ERROR_ALREADY_EXISTS    183u
#define OMNI_ERROR_DIR_NOT_EMPTY     145u
#define OMNI_ERROR_BROKEN_PIPE       109u
#define OMNI_ERROR_HANDLE_EOF        38u

static int __libc_errno_of(unsigned int w) {
  if (w == OMNI_ERROR_FILE_NOT_FOUND || w == OMNI_ERROR_PATH_NOT_FOUND) return 2;   /* ENOENT */
  if (w == OMNI_ERROR_ACCESS_DENIED) return 13;                                      /* EACCES */
  if (w == OMNI_ERROR_INVALID_HANDLE) return 9;                                       /* EBADF */
  if (w == OMNI_ERROR_NOT_ENOUGH_MEMORY) return 12;                                   /* ENOMEM */
  if (w == OMNI_ERROR_FILE_EXISTS || w == OMNI_ERROR_ALREADY_EXISTS) return 17;       /* EEXIST */
  if (w == OMNI_ERROR_DIR_NOT_EMPTY) return 39;                                       /* ENOTEMPTY */
  if (w == OMNI_ERROR_BROKEN_PIPE) return 32;                                         /* EPIPE */
  return 5;                                                                            /* EIO */
}

/** 失败了（Win32 的约定：回 0 / 回 INVALID_*）就把 errno 填好。回的是 -1，方便直接 return。 */
static long __libc_oserr(void) {
  __libc_errno_val = __libc_errno_of(GetLastError());
  return -1;
}

/** 与另两条腿同名同形：这儿只是「负数就是已经填过 errno 的失败」。 */
static long __libc_check(long r) {
  return r;
}

#endif
