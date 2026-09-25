/* start.c — arm64 Windows 的入口（第 win-c-backend 刀）。
 *
 * 与另两条腿的区别在「argc/argv 从哪儿来」：
 *   - Linux：内核把 argc/argv/envp 摆在栈上，`_start` 用 `__builtin_frame_address(0)` 捞
 *   - macOS：dyld 像调函数一样把三个参数递进来
 *   - Windows：**一个参数都没有**。入口只是一个 `void(void)`，命令行要自己去问
 *     （`GetCommandLineA`），而且问回来的是**一整行未拆的字符串** —— CRT 在这儿的
 *     活儿就是拆它。所以这一份比另两条腿长，长出来的全是那个拆词器。
 *
 * 拆词按 Windows 自己的规矩（CommandLineToArgvW 的简化版，够我们自己用）：
 *   - 空白（空格/制表）分隔
 *   - 双引号里空白不算分隔；`""` 成对出现就是一个空参数
 *   - 反斜杠只在引号前才有转义意义，这一份按「2n 个反斜杠 + 引号」的老规矩折
 *
 * argv 的地方从哪儿来：**不能 malloc** —— malloc 的地基 `__libc_chunk` 要 VirtualAlloc，
 * 那条路没问题，但这一步跑在任何初始化之前，越少依赖越好。所以 argv 数组与拆好的
 * 字符串都落在**静态的两块地方**（上限 `ARG_MAX_N` / `ARG_MAX_B`），超了就截断 ——
 * 编译器自己的命令行不过几十个词。
 */
#include "libc.h"

extern int main(int argc, char **argv);
extern void exit(int code);

char **environ;

/* **`_fltused`**：MSVC 的约定。`cl` 在每个用到浮点的目标文件里引一次这个符号，让链接器
 * 知道要带浮点支持；正常由 CRT 定义，而 `--cc msvc` 这条腿走 `/NODEFAULTLIB`（平台层是
 * 我们自己这份 libc），所以得自己立一次。量到的是二十多条
 *   libc-math.o : error LNK2001: unresolved external symbol _fltused
 * 值 0x9875 是历史习惯，没有代码读它 —— 存在就够。
 *
 * 只在 MSVC 编这一份时才需要（自带那台前端不发这个引用）。 */
#ifdef _MSC_VER
int _fltused = 0x9875;

/* **`_tls_index`**：MSVC 实现 C11 `_Thread_local` 时引的那个索引（`omni.h` 里那几格
 * 线程局部量）。正常由 CRT 定义并在启动时填好；我们是**单模块、没有动态 TLS 回调**的
 * 程序（自己的 `_start`、不链 CRT），所以 0 就是对的 —— 12 份 .o 都引它，量到的是
 *   omni_mem.o : error LNK2001: unresolved external symbol _tls_index */
unsigned long _tls_index = 0;

/* **`__report_rangecheckfailure`**：`/GS` 那一族的越界报告桩。给了 `/GS-` 之后 cl 在
 * 少数模式下照旧会发这个引用（量到的是 `libc-io.o` 里 `getcwd` 那一处）。与其让链接器
 * 去 CRT 里找，不如自己给一个：**当场停住**，别让越界之后还往下跑。 */
void __report_rangecheckfailure(void) {
  ExitProcess(0xC0000409u);   /* STATUS_STACK_BUFFER_OVERRUN，与 MSVC 的约定一致 */
}

#endif


#define ARG_MAX_N 256
#define ARG_MAX_B 32768

static char *__argv[ARG_MAX_N + 1];
static char __argb[ARG_MAX_B];

static int __is_space(char c) { return c == ' ' || c == '\t'; }

/** 拆 `GetCommandLineA()` 那一行，回 argc。 */
static int __split(char *cmd) {
  int argc = 0;
  unsigned long bi = 0;
  char *p = cmd;
  while (*p != 0) {
    while (__is_space(*p)) p++;
    if (*p == 0) break;
    if (argc >= ARG_MAX_N || bi + 1 >= ARG_MAX_B) break;
    __argv[argc++] = &__argb[bi];
    int inq = 0;
    while (*p != 0 && (inq || !__is_space(*p))) {
      if (*p == '\\') {
        /* 数一串反斜杠：后面跟引号时两个折一个，不跟引号时原样留着。 */
        unsigned long n = 0;
        while (*p == '\\') { n++; p++; }
        if (*p == '"') {
          for (unsigned long k = 0; k < n / 2 && bi + 1 < ARG_MAX_B; k++) __argb[bi++] = '\\';
          if (n % 2 == 1) { if (bi + 1 < ARG_MAX_B) __argb[bi++] = '"'; p++; }
          else { inq = !inq; p++; }
        } else {
          for (unsigned long k = 0; k < n && bi + 1 < ARG_MAX_B; k++) __argb[bi++] = '\\';
        }
        continue;
      }
      if (*p == '"') { inq = !inq; p++; continue; }
      if (bi + 1 < ARG_MAX_B) __argb[bi++] = *p;
      p++;
    }
    __argb[bi++] = 0;
  }
  __argv[argc] = (char *)0;
  return argc;
}

/* environ：`GetEnvironmentStrings` 回的是 `K=V\0K=V\0\0`，拆成指针数组。
 * 这块地方是系统给的，**不释放**（整个进程都在用）。 */
#define ENV_MAX_N 512
static char *__envp[ENV_MAX_N + 1];

static void __env_init(void) {
  char *e = GetEnvironmentStrings();
  int n = 0;
  if (e != 0) {
    char *p = e;
    while (*p != 0 && n < ENV_MAX_N) {
      __envp[n++] = p;
      while (*p != 0) p++;
      p++;
    }
  }
  __envp[n] = (char *)0;
  environ = __envp;
}

/* ---- 崩溃时至少说一句话（第 win-c-backend 刀）。
 *
 * 这条腿**没有 SEH**（我们链出来的 PE 没有 `.pdata`/`.xdata`，也不链 msvcrt 的那一套），
 * 于是一个 0xC0000005 就是「进程没了、一个字节都没印」—— 量到过：45MB 的
 * `omni-arm64.exe help` 静静地退，退出码 -1073741819，别的什么都没有。
 *
 * `AddVectoredExceptionHandler` 是**不需要展开表**的那一格（VEH 在调度异常的最前面被叫，
 * 与 SEH 的展开链无关），所以这条腿也用得上。处理函数里只做一件事：把异常号、出事的
 * 指令地址、（访问违例的）目标地址按十六进制写到 stderr，然后 `ExitProcess`。
 * 地址配着 `--map`（`pe-link --map`）就能翻回函数名。
 *
 * 只认几个「真的是我们出错」的号，别的原样放过（回 0 = 继续找下一个处理函数）。 */
static void *__veh_stderr(void) { return GetStdHandle(STD_ERROR_HANDLE); }

static void __veh_puts(const char *s) {
  unsigned int n = 0;
  const char *p = s;
  while (*p != 0) { p++; n++; }
  unsigned int wrote = 0;
  WriteFile(__veh_stderr(), s, n, &wrote, 0);
}

static void __veh_hex(unsigned long long v) {
  char buf[19];
  buf[0] = '0'; buf[1] = 'x';
  for (int i = 0; i < 16; i++) {
    unsigned int d = (unsigned int)((v >> ((15 - i) * 4)) & 15);
    buf[2 + i] = (char)(d < 10 ? '0' + d : 'a' + (d - 10));
  }
  buf[18] = 0;
  __veh_puts(buf);
}

static long __veh(void *info) {
  unsigned char **pp = (unsigned char **)info;
  unsigned char *rec = pp[0];
  unsigned int code = *(unsigned int *)rec;
  if (code != 0xC0000005u      /* 访问违例 */
      && code != 0xC00000FDu   /* 栈溢出 */
      && code != 0xC000001Du   /* 非法指令 */
      && code != 0xC0000094u   /* 整数除零 */
      && code != 0xC0000096u) {/* 特权指令 */
    return 0;
  }
  __veh_puts("\nomni: 崩了 code=");
  __veh_hex(code);
  __veh_puts(" pc=");
  __veh_hex((unsigned long long)*(void **)(rec + 16));
  /* **映像基址也要印**：这份 PE 开了 DYNAMIC_BASE，每趟装载的地址都不一样，
   * 而链接图（`--map`）里记的是链接期那个基址上的地址 —— 没有这一格，上面那个 pc
   * 翻不回函数名。`pc - base` 就是 RVA。 */
  __veh_puts(" base=");
  __veh_hex((unsigned long long)GetModuleHandleA(0));
  unsigned long long nparam = (unsigned long long)*(unsigned int *)(rec + 24);
  if (code == 0xC0000005u && nparam >= 2) {
    __veh_puts(*(unsigned long long *)(rec + 32) == 0 ? " 读" : " 写");
    __veh_puts(" addr=");
    __veh_hex(*(unsigned long long *)(rec + 40));
  }
  __veh_puts("\n（地址配 `pe-link --map` 那份图翻函数名）\n");
  ExitProcess(3);
  return 0;
}

/* PE 的入口。名字用 `_start` 与另两条腿一致（`pe-link` 的 `-e` 由 cli.js 给），
 * 不叫 `mainCRTStartup` —— 那个名字属于 msvcrt 那一路的约定，我们不链它。 */
/* **控制台代码页**：这一份 libc 写出去的都是 UTF-8 字节（源码、诊断、帮助文本都是），
 * 而 Windows 的控制台按自己的输出代码页解码 —— 简体中文机器上默认 936，于是
 * `dist\omni.exe` 的帮助是一片乱码，手工 `chcp 65001` 之后同一个 exe 就正常。
 *
 * 所以开工先把输出页切成 65001（CP_UTF8），**退出时还回去**：`SetConsoleOutputCP`
 * 改的是那个控制台、不是我们这个进程 —— 不还的话每跑一趟就把用户的 shell 留在
 * 65001 上，那是编译器不该留下的痕迹。崩溃那一路不还（VEH 里只管把现场印出来）。
 *
 * 管道/重定向那一头这一格帮不上忙（那时解码的人不是控制台）—— 真要全面正确得在
 * 写那一层判 `GetFileType`、是控制台就走 `WriteConsoleW` + UTF-16，那是另一刀。 */
static unsigned int __con_cp_old;

static void __con_init(void) {
  __con_cp_old = GetConsoleOutputCP();
  if (__con_cp_old != 0 && __con_cp_old != 65001) SetConsoleOutputCP(65001);
}

static void __con_fini(void) {
  if (__con_cp_old != 0 && __con_cp_old != 65001) SetConsoleOutputCP(__con_cp_old);
}

void _start(void) {
  AddVectoredExceptionHandler(1, __veh);
  __env_init();
  int argc = __split(GetCommandLineA());
  __con_init();
  int __rc = main(argc, __argv);
  __con_fini();
  exit(__rc);
  for (;;) { }
}

/* 共享库（`--shared`，插件那一路）的入口。**不能用 `_start`**：那一条会去调 `main`，
 * 而 DLL 里没有 main —— 被加载的一刻就跑起一整个程序，谁都受不了。
 *
 * 名字是 `pe_load.js` 的 `peStart` 定的（`o.dll === true` 那一支找 `__dllstart`），
 * 与 tcc 的 PE 那一路同一个名字。签名是 Windows 的 `DllMain(hinst, reason, reserved)`，
 * 回非零 = 「装好了」（回 0 加载器会当场把这个模块卸掉）。
 *
 * 为什么这儿还要 `__env_init()`：`--libc self` 的插件里有**自己那一份 libc**
 * （静态链进去的，与核心里那一份不是同一份），它的 `environ` 得自己立起来。
 * reason == 1 是 DLL_PROCESS_ATTACH，只在那一次做。 */
int __dllstart(void *inst, unsigned int reason, void *reserved) {
  (void)inst;
  (void)reserved;
  if (reason == 1) __env_init();
  return 1;
}
