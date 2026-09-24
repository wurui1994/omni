# Windows ARM64 上打通 `--backend c`（自带 tcc 前端 + 自带 libc）

分支 `win-c-backend`，工作树 `/Users/wurui/Train/Omni-win`（主线那份 `/Users/wurui/Train/Omni` 不碰）。
客户机是 VMware Fusion 里的 Windows 11 ARM64，Node v26.7.0，工具链见
`comate-zulu-demo-1788666486216/vmomni.md`（主机目录以 SMB 挂到客户机 `Z:`，两边看同一份文件）。

目标：在 Windows ARM64 上，`omni run/build --backend c`、`--libc self`、`--profile`、
`npm run build:native` 这几格都能跑，与 macOS 上同一个口径。

## 一、现在到哪儿了（量出来的，不是推的）

客户机里跑 `Z:\`（即本工作树）：

- `node src/cli.js --help` 正常，中文不乱码。
- `node src/cli.js run tests/cases/01_basics.omni` 挂在 **`spawn /bin/sh` ENOENT** ——
  `OMNI_TIMEOUT` 那个外部看门狗（`cli.js`）用 `sh -c` 拼的 `kill -0` 轮询。
- `node tests/run.js` 挂在 **`ERR_UNSUPPORTED_ESM_URL_SCHEME`，protocol `c:`** ——
  `lang/builtin.js` 的 `require_(join(dir, entry))` 把 Windows 绝对路径当 URL 喂进了 ESM 装载器。
- 主机上交叉编译 `omni c obj x.c --arch arm64 --os win32` 报
  `MacOSX.sdk/usr/include/sys/cdefs.h: #error Unsupported architecture` ——
  **没有 `src/sysroot/arm64-win32`**，于是退回本机 SDK 的头。

已经有的（不用重做）：

- PE 那一摊齐全：`link/pe.js`（映像读写）、`pe_sections.js`、`pe_load.js`（`.def` 导入库、
  按需取用）、`pe_reloc.js`、`pe_link.js`（导入表、桩、落重定位），x86_64 与 arm64 的桩都在。
- `.o` 在所有目标上都是 ELF（`link/elf.js` 明写六个目标含 `arm64-win32`），所以对象层不用动。
- `osFmt('win32') === 'pe'`、动态库后缀 `.dll`、`chmod` 在 win32 上跳过、x86_64-win32 的
  `.pdata` 展开信息 —— `cli.js` 里都有。
- 参考实现在 `/Users/wurui/Documents/Lang/reference/tinycc`：`win32/lib/{kernel32,msvcrt,user32,gdi32,ws2_32}.def`、
  `win32/lib/{crt1.c,wincrt1.c,chkstk.S}`、`win32/include/`（精简的 mingw 头）。

## 二、缺口按层拆

**L1 宿主层（Node 跑得起来）**
1. `cli.js` 的超时看门狗：win32 上不要 `sh -c`；要么关掉，要么改成进程内定时器。
2. `core/host/path.js` 明写「只做 posix 语义」：`isAbsolute` 只认 `/`、`join` 只认 `/`。
   Windows 上 `C:\`、`Z:\`、UNC 都不认。这一份还会被**编进产物**，所以只能是纯字符串计算。
3. `lang/builtin.js` 的 `require_(绝对路径)`：改成 `pathToFileURL` 或保持相对。
4. `unameOut` 探不到时已经归 `win32`，但 `--arch` 探测要确认在 ARM64 Windows 上回 `arm64`。

**L2 sysroot（`arm64-win32` / 顺带 `x86_64-win32`）**
5. `include/`：精简系统头，口径同 `arm64-osx` 那份（只声明运行时与生成的 C 真正用到的）。
6. `lib/*.def`：`kernel32.def` 是地基；`msvcrt.def` 给 `--libc system` 那一路。
7. `libc/` 平台层：`start.c` / `io.c` / `misc.c` / `syscall.h`。
   **这里是设计分岔点**：Windows 没有稳定的裸 syscall ABI，`__omni_syscall`（MIR 的 `SYSCALL` op，
   x86_64 降 `syscall`、arm64 降 `svc #0`）在 Windows 上**不能用**。所以 win32 的平台层改成
   「调 kernel32 的导入函数」：`GetStdHandle`/`ReadFile`/`WriteFile`/`CreateFileW`/`VirtualAlloc`/
   `ExitProcess`/`GetSystemTimeAsFileTime`/`GetEnvironmentStringsW`/`FindFirstFileW`…
   —— 纯静态的部分仍然纯静态，只多一个 `kernel32.dll` 的导入表（这是 Windows 的地板，tcc 也一样）。
   `start.c` 换成 PE 的入口：`mainCRTStartup` 里 `GetCommandLineW` → argv、`GetEnvironmentStringsW` → environ。
8. 公用的 `libc/*.c`（stdio/string/malloc/math/strtox/dec/file/pure）**不动** —— 它们零 syscall，
   平台差异全在 io/misc/start 那三份里。这是这套结构原本的承诺，正好在这儿验一次。

**L3 运行时（`src/runtime/*.c`，POSIX 调用要有 win32 对应）**
9. `omni_prof.c`：`sigaction(SIGPROF)+setitimer` 在 Windows 上不存在。采样档改成
   **采样线程**：`CreateThread` + `SuspendThread`/`GetThreadContext`/`ResumeThread` 取 PC 与帧链，
   频率仍由 `OMNI_PROF=sample[:hz]` 定。`.folded` 的格式与两条腿逐字节一致 —— 这是判据。
10. `omni_js_host.c`：`setitimer`（看门狗）、线程（已有「开不出线程就直接调 entry」的退路）。
11. 插件那一格：`dlopen/dlsym` → `LoadLibraryW/GetProcAddress`，后缀已经是 `.dll`。

**L4 端到端**
12. `build:native`：`omni build src/cli.js --extern --plugins -o dist/omni` 在 Windows 上要出
    `dist/omni.exe`（PE），`--plugins` 出 `.dll`。macOS 上收场那一步的 `codesign` 在 win32 上要跳过。
13. 判据：`tests/c/*` 里与 PE / libc 相关的那些轴在客户机里跑过；`--backend c` 的差分轴
    （JS 后端 vs C 后端逐字节相同）在 Windows 上也得成立。

## 三、里程碑与验收

- **M1 宿主层**：✅ 客户机里 `node src/cli.js run tests/cases/01_basics.omni` 与 Mac 逐行相同。
  改的两处：`backend-js/prelude.js` 的看门狗（win32 走 `node -e` 写的同款三步，并补
  `ch.on('error')` —— spawn 失败是异步事件，没人接就把整个进程带走）、`core/host/path.js`
  认盘符与 UNC（入口归一反斜杠 + 把「根」摘出来，中间仍走 posix 计算）。
- **M2 hello 到 .exe**：链出来了（91136 字节、4 节、33 个导入桩）。这一步顺带做了：
  - `src/sysroot/arm64-win32/`：`libc/{syscall.h,io.c,misc.c,start.c}`、`lib/kernel32.def`、
    `include/`（沿用 Linux 形状）。关键设计三条：**没有 syscall**（NT 的裸调用号官方不承诺
    稳定，所以架在 kernel32 的导入函数上）、**一张 fd 表**（Windows 只有 HANDLE，而公用那半
    的 `struct __FILE` 存 `int fd`，所以 0/1/2 绑标准句柄、其余下标存 HANDLE）、
    **`struct stat` 沿用 Linux 那套 144 字节形状**（这条腿上没有既成 ABI 要对，复用一份
    已经有判据的形状省一整轮对账）。
  - 公用那半的一处泄漏：`stdio.c` 的 `abort()` 直接发 `__omni_syscall(SYS_kill, …)`，
    win32 上一编就停。改成走 `kill`（目标专有那半），两条 Unix 腿逐字节不变。
  - **PE 的 `.got`**（M2a）：arm64 取任何符号地址一律发 `311`/`312`，而 PE 链接器没有 GOT。
    照 tcc 的路子补上（它的 `build_got` 在 `tccelf.c`，PE 与 ELF 共用，不是 PE 专有另一套）：
    `pe_sections` 扫一遍重定位表分格子、在 `.data` 里划 `8 * n` 字节、每格挂一条
    `REL_TYPE_DIRECT` 进 `.reloc`；`pe_link` 填最终地址并把格子的 VA 递给 `relocateOne`。
    **没有**走「win32 上改发 275/277」那条路 —— 那等于把 ADR-0017 已经否掉的
    局部/外部分岔又加回来。
- **M3 `--backend c` 差分**：✅ `omni build tests/cases/01_basics.omni --arch arm64 --os win32 --libc self`
  出的 `basics.exe`（684544 字节、4 节、40 个导入桩）在客户机里跑出来的 35 行与 Mac 上
  JS 腿**逐字节相同**，退出码 0。为它补的三格：
  - **TSD 是真的，不是桩**：运行时的 arena 在 `OMNI_NO_TLS`（我们的 C 前端预定义
    `__TINYC__`，于是走这条）下按 `pthread_key_create`/`getspecific`/`setspecific` 查，
    每次分配都要走一趟。win32 上照 `TlsAlloc`/`TlsGetValue`/`TlsSetValue` 实现。
  - `dlopen` 一族落到 `LoadLibraryA`/`GetProcAddress`/`FreeLibrary`（`omni_r3.c` 靠它
    在运行期找 GL 插件，找不到走 CPU 备选），`_Exit`/`setsid`/`execl` 补齐。
  - `omni_prof.c` 的 `dladdr` 那一支加 `!defined(_WIN32)`：Windows 上没有 dladdr，
    直接落到「模块 + 偏移」那一支。win32 的 `sigaction`/`setitimer` **回 -1（ENOSYS）而不是 0** ——
    回 0 会让采样档以为装上了，变成「开着采样却一个样本都没有」。
- **M4 自举**：客户机里 `npm run build:native` 出 `dist/omni.exe`，它自己再编一趟 hello 能过。

每个里程碑落一个 commit 在 `win-c-backend` 上；主线那份工作树全程不碰。

## 三之一、顺带修掉的两个真 bug

**PE 链接器对未定义符号一律回 0。** 注释写的是「弱的未定义符号在 PE 上就是 0」，
可那一句对**非弱**的也照办了 —— 于是 `pthread_key_create` 在 win32 的 sysroot 里根本没实现，
链接却静静地成功，程序跑到那一句去调地址 0：`basics.exe` 一起来就 0xC0000005。
现在落完重定位一起报（`pe: 这些符号引到了可是没有定义：…`），一次看全。
开这道闸立刻又抓出五个：`_Exit`、`dlerror`/`dlopen`/`dlsym`、`execl`、`setsid`。

**`struct timeval` 在 `<sys/time.h>` 与 `<sys/resource.h>` 里各定义了一遍。** 三个 sysroot
都有这一处。以前没撞上是因为没有一个翻译单元同时引到这两个头；`--libc self` 编整套运行时
（`omni_js_host.c` 两个都引）就是 `redefinition of 'struct timeval'`。现在 `resource.h`
改成 `#include <sys/time.h>`。顺手也给 arm64-osx 那一份修了 —— 修完那条腿往下走一步，
露出的是 `_Exit` 没定义（`--libc self` + 整套运行时在 osx 上本来也从没跑通过，
那是主线的事，这一刀不碰）。


## 三之二、两个踩坑（别再踩）

**`c obj --os win32` 不给 `-f elf` 会写出 Mach-O 的 `.o`**（默认跟着本机格式走），
而链接器读的是 ELF —— 报的是「这不是一个 ELF 文件」。`.o` 的容器一律 ELF，见 `link/elf.js` 开头。

**guest 命令在主机侧超时之后，客户机里那个进程还在跑。** 一趟超时的 `emit c` 留下的
node.exe 把 vCPU 占满，之后每条 guest 命令都跟着超时，看起来像「虚拟机挂了」。
`vmomni guest kill` 就是为这个加的。


## 五、x86_64-win32（ARM64 Windows 上跑 x64）

**先确认了兼容层是真的**：ARM64 Windows 会翻译执行 x64 的 PE（Prism），我们自己出的
x64 二进制在客户机里跑起来了 —— `ret42-x64.exe` 退出码 42、`wr-x64.exe` 退出码 7，
都对。代价是**头一趟很慢**（翻译是按需做的：同一批程序头一次跑掉了 195s，
第二次 15s），所以 x64 这条腿的用处是**兼容覆盖**，不是速度。

sysroot 不用再做一份：win32 的平台层调的是 kernel32 的导入函数（Windows 上没有稳定的
裸 syscall），头也一样 —— 两个 arch **同一份**。所以 `src/sysroot/arm64-win32` 改名成
`src/sysroot/win32`，`bundledSysroot` 多一格退路：先找 `<arch>-<os>`，找不到找 `<os>`。
另两个目标仍按 `<arch>-<os>` 放（它们的 `io.c` 里是 syscall 号，一个 arch 一套）。

链接这一侧只差一行：`pe_sections` 的 `GOT_TYPES` 给 x86_64 加上 `GOTPCREL` 一族
（9/41/42），与 `pe_reloc` 里用 `slot()` 的那几个 case 一一对应。加完
hello/ret42/basics 三个 x64 的 `.exe` 全部链得出来（basics 1.5MB，cc 19.5s）。

**调用约定已经补上了**（任务 #5，已完成）：`x64/from_mir.js` 现在按目标切 ABI ——
`IARG`/`FARG` 换成 `[rcx,rdx,r8,r9]` / `xmm0-3`，实参**按位置配槽**（第 i 个实参占
整数槽 i 或 xmm 槽 i，不是 SysV 那两条各走各的序列），第五个起摆 `rsp + 32`，
影子区那 32 字节**永远预留**。三格要记住：

- **大于 8 字节的聚合按引用传**：调用方在出参区尾部拷一份、把那一份的地址塞进槽。
  必须拷 —— 被调方可以改它手里那一份，直接递原件地址改动会漏回调用方。
- **变参靠影子区当游标**：被调方序言把四个整数寄存器泼进 `rbp + 16` 那 32 字节，于是
  「寄存器实参 + 栈上实参」在内存里连成一串，`va_list` 只是一个往前走的指针 ——
  比 SysV 那两块加两个游标简单。调用方那边浮点实参要**同时**抄进对应的整数寄存器
  （Win64 的规矩），少这一步 `printf("%f")` 印的是垃圾。SysV 的 `mov al, n` 不发。
- **返回大结构的判据跟着前端走，不是 Win64 的 8 字节线**：「要不要隐藏指针形参」是前端
  按 SysV 的 16 字节线定的（`ARGSRET`），后端只能照着摆。第一版按 Win64 的 8 字节线改了，
  于是调用方递一个被调方根本不读的指针、被调方把 struct 回在 rax/rdx 里 ——
  `01_basics` 跑到第一个字符串就 `out of memory`（拿垃圾当长度去要内存）。
  真按 Win64 改要等前端也按目标分叉。

验收：`basics-x64.exe` 在客户机里 35 行与 JS 腿**逐字节相同**；hello / write /
libcprobe（`%d %s %.6f %g` 那一串）全过。Mac 上 `x86_64-linux` 的 `main` 仍然发
`rdi/rsi/rdx`（SysV 一个字节没动），`tests/run.js basics` 2 passed。

**还踩到一个缓存的坑**：`--libc self` 的对象缓存键是 `fmt|arch|os|源文件`，
**不含编译器自己的指纹** —— 改完后端再编，`cc 800ms` 就把旧的 `.o` 又端上来了，
量出来的东西是假的。这一轮是靠 `rm -rf .omni-cache/work/libc-self-* .omni-cache/rt/*`
绕过去的；正经做法是把编译器的指纹也算进那个 hash（**已补**，见第六节第一条）。


## 六、M4：把核心自己搬上去（`build:native` / 插件 / profile）

这一节是**进行中**的一刀。分四件事，前三件已经落地并验过，第四件（核心自己在
Windows 上跑起来）还卡着一个 0xC0000005 —— 卡在哪儿、已经排除了什么，都记在下面。

### 1. 缓存键补上编译器指纹（已修）

`runtimeObjectsSelf` 与 `--libc self` 那两处缓存键现在都算上 `srcStamp()`
（`src/` 底下每份文件的 `路径:mtime:大小` 的哈希，`cli.js` 里本来就有）。
改完后端/sysroot 再编，缓存不会再把上一版的 `.o` 端上来。

### 2. 产物的名字按**目标**拼，不按这台机器（已修）

- `exeName()` / `targetOs()`（`cli.js`）：`-o dist/omni` 在 win32 目标上落成
  `dist/omni.exe` —— Windows 上没有后缀的文件**压根启动不了**，`npm run build:native`
  那一行于是一个字都不用改。
- 插件的后缀从 `dsoExt(hostOs())` 改成 `dsoExt(targetOs())`：在 macOS 上交叉编
  Windows 的插件时，从前拼出来的是 `.dylib` 而内容是 PE。
- `chmod +x` 只对非 PE 做（Windows 上能不能跑看后缀，而在 Windows 上跑的那份核心
  连 `chmod` 这个程序都没有）；`codesign` 的判据从「这台机器是 macOS」改成
  「**产物是 Mach-O**」—— 交叉编 `.dll` 时前者一样为真，签下去只会得到
  `the file … is not a valid Mach-O`。

### 3. 三样这条腿上缺的地基（已补，都验过）

- **`setjmp`/`longjmp`**：与另两条腿同一行代码（`__omni_setjmp`/`__omni_longjmp`
  两条后端 op）。**不碰 Windows 的 SEH** —— `RtlUnwind` 那一套要 `.pdata`/`.xdata`，
  我们链出来的 PE 没有。`sigsetjmp` 的 `savemask` 只能忽略（这条腿没有信号掩码）。
  少了这两个，`build src/cli.js` 直接报 `pe: 这些符号引到了可是没有定义：longjmp、setjmp`。
- **头里漏掉的五条声明**（`fgets`/`gmtime_r`/`gmtime`/`_Exit`/`setsid`/`execl`）。
  这不是洁癖：LLP64 上隐式声明按 `int` 收返回值，`fgets`/`gmtime_r` 回的**指针
  高 32 位当场丢掉**。原话是编译运行时那 21 份时的一串
  `implicit declaration of function 'gmtime_r'`。
- **512MB 的主线程栈**：PE 上那一格叫 `--stack`（`SizeOfStackReserve`），
  `buildSelf` 现在对 `fmt === 'pe'` 递 `0x20000000`；配套地
  `omni_main_stack_bytes()` 在 `_WIN32` 上走 `GetCurrentThreadStackLimits`
  （从前落到 `getrlimit` 那一支，这条腿回 -1/ENOSYS → 判「栈不够」→ 去开线程 →
  `pthread_create` 回 EAGAIN → 退回直接调用，**编译器于是跑在默认的 1MB 栈上**）。

### 4. profile 换成采样线程（已验，名字也翻得出来）

Windows 没有 `SIGPROF`/`setitimer`（这条腿一律 -1/ENOSYS），所以
`omni_prof.c` 里多了一支 `_WIN32`：**另起一条线程**，定时 `SuspendThread` 主线程、
`GetThreadContext` 拿 PC 与帧指针、**自己走一遍帧链**、`ResumeThread`，放开之后才记账。
三条要点写在代码注释里（不能叫 `backtrace()`，那走的是采样线程自己的栈；冻着的时候
只读内存不记账；帧链当脏数据读 —— fp 要落在主线程栈上、8 字节对齐、一层比一层高）。
CONTEXT 里 Fp/Sp/Pc 的偏移两个 arch 各一套（arm64 240/256/264、x64 0xA0/0x98/0xF8）。
`pf_sampling = 3` 是这一档的号，停表就是把旗子放下。

**翻名字那一格还差一条**（也量出来了）：PE 开了 DYNAMIC_BASE，采到的是运行期地址，
而 `--map` 里落的是链接期 VA，差一个滑动量。第一版想从自己头上把 `ImageBase` 读回来
算差 —— **不行**：Windows 的装载器会**把内存里那个字段改成真实基址**（探针程序量到
`declared == actual`、滑动量算成 0，于是报告里 20 行全是 `0x7ff6…`）。改法是让链接图
自己带一行 `# imagebase 0x…`（`writeLinkMap` 的第三个参数；`#` 开头老读者一律跳过），
运行期 `真实基址 - 那个数` 就是滑动量。

验收（arm64-win32，`burn.js`：`fib(30)` 三遍）：

```
omni prof: 链接图 4355 条，滑动量 0x7ff5c31c0000，图里第一条 0x140001000
omni prof（采样 CPU 时间，128 帧、128 条栈）：
   21.09%  27  is_int     14.06%  18  u_fib     12.50%  16  omni_js_cmp    9.38%  12  is_num
```

macOS 上同一份程序的前五名是同一批（`is_int` / `is_num` / `u_fib` / `omni_js_cmp` /
`to_num1`），折叠栈里 `u_fib` 的递归层次也对得上。`OMNI_PROF_DEBUG=1` 是新加的一格：
名字全印成裸地址时，它一句话分清「图没读进来」与「滑动量不对」。

### 5. 崩了要能说一句话（新工具，已验）

这条腿没有 SEH，一个 0xC0000005 从前就是「进程没了、一个字节都没有」。现在
`start.c` 在 `_start` 头上装一个 **VEH**（`AddVectoredExceptionHandler`，它不需要
展开表），崩的时候印一行：

```
omni: 崩了 code=0x00000000c0000005 pc=0x00007ff745cb1dac base=0x00007ff745cb0000 写 addr=0x0
```

配套的是 **`pe-link --map`**（`pe_link.js` 的 `mapSyms`，ELF 那条腿早就有）：
`pc - base + 映像基址` 就能在那份图里查到函数名。拿 `crash.c`（`*(int *)0 = 1`）
量过：`main` 在图里是 `0x140001da0`，崩的地方是 `0x…1dac` —— 对得上。

### 6. 找着了：**Windows 的栈要一页一页地探**（已修）

`omni-arm64.exe`（45.5MB）在客户机里启动就死、退出码 0xC0000005、一个字节都没印，
**连 VEH 那一行都没有**。用一个 95KB 的探针程序（`.winlab/stk.c`：先印
`GetCurrentThreadStackLimits`，再递归 2000 层、每层一个 64KB 的局部数组）把它缩小到了
一行代码，症状一模一样：

```
stack lo=1280000000 hi=12a0000000 size=512 MB      ← 栈**真的**有 512MB
RC=-1073741819                                     ← 还是 0xC0000005
```

原因是 Windows 的栈**按页长出来**：保留多大都行，可提交的只有头几页，紧挨着已提交区
放着一页 `PAGE_GUARD` —— 碰到那一页内核才把栈往下接一段。一个 64KB 的帧
（`sub sp, #0x10000` 之后直接写）**跳过了那一页**，写下去就是访问违例。MSVC/clang 在
这儿发的是 `__chkstk`；我们从前什么都没发。VEH 印不出来也是同一件事的后果：出事时
`sp` 已经落在未提交的地方，内核往那儿推异常帧又是一次错，进程当场没 ——
**「崩了连一行都印不出来」本身就是这个错的指纹**。

改法：两个后端的序言里，帧大于一页时先探一遍（`WIN32`/`WIN64` 才发）——
游标从 `sp` 往下每 4096 触一个字节，触到帧底为止，然后才降 `sp`。
arm64 那条 `sub` 要用移位立即数形式（`#1, lsl #12`；`imm12` 装不下 4096）。

验收：同一份 `stk.exe` 现在 `deep(2000) = 103`、`RC=0` —— 128MB 的栈真的走完了。
Mac 上 `tests/run.js basics` 2 passed，`hi.js` 的产物一字未变。

**`alloca` 那一路（`SPALLOC`）也补上了**：那儿的大小是运行期的，所以真的转一圈 ——
游标从旧 `sp` 往下每 4096 触一下、触到新 `sp`（出参区也算进去）为止。两个后端各一段。
拿 `.winlab/vla.c`（`char buf[n]`，一次 256KB，再连着八次 64KB~512KB）验过：
arm64-win32 与 x86_64-win32 印的都是 `vla(262144) = 2016` / `loop total = 15584`、`RC=0`，
与 macOS 上同一份源码的输出**逐字相同**。

### 7. 插件出 `.dll` 这一格：**卡在设计上**，不是卡在链接上

`build --plugin` 那条路在 PE 上已经通到链接器（`--shared` → `dll: true`、入口换成
`__dllstart`（win32 sysroot 的 `start.c` 里新加的 `DllMain`，只 `__env_init` 然后回 1）、
`selfLibc` 那一路只接 kernel32 —— 从前会去找不存在的 `user32.def`）。
可是**模型对不上**：插件是按「核心里那些符号留成未定义，`dlopen` 在**平坦命名空间**里
解析」设计的（ADR-0021 的 S1）。量出来是 2819 个未定义符号
（`g_ASSIGN_OPS_JS`、`g_BINARY`…）。Windows 上没有平坦命名空间，一份 DLL 的未定义
符号必须在**导入表里指名道姓**地说「从哪个模块来」。三条路，选哪条要先定：

1. **核心导出、插件按名导入**：`omni.exe` 摆一张导出表（`pe_sections` 本来就会为
   `dllexport` 的符号摆），插件生成一条指向 `omni-arm64.exe` 的导入描述符。
   最贴近现在的模型，但要把那 2819 个名字都导出（表不小）。
2. **插件自带一整份**（不给 `--bind`）：各自静态链一份核心，谁也不引谁。链得出来，
   但每格插件都是几十 MB。
3. **注册时递一张函数表**：`register` 函数收一个结构体，里头是核心那些函数的指针。
   最干净，可这是**三条腿共同的**接口改动，不属于 Windows 这一刀。

**逃生门是现成的**：`build --fat` 把那一套插件**编进核心**，于是 Windows 上一份
`omni-fat.exe` 就够（量到 86.2MB / C 37.4MB / 712403 行 / cc 1m22s，arm64-win32）。
不带插件的那份核心在客户机里跑 `emit c hi.js` 报的是
「不认识 hi.js 这种扩展名：这份 omni 里一门语言都没装」—— 命令行、扩展名分派、
报错都在，缺的只有那一格语言。所以 Windows 这条腿**先走 `--fat`**，
`.dll` 那三条路留给上面那个接口决定。

### 8. 验收：核心自己在 Windows 上编出来的 C **与 macOS 逐字节相同**

探栈补上之后，`omni-arm64.exe help` 在客户机里印出整篇用法、`RC=0`（从前是
0xC0000005 一个字节都没有）。带上 `--fat` 那份（`omni-fat.exe`，86.2MB）再往下走一步：

```
C:\Users\clover> omni-fat.exe emit c hi.js > hi-win.c      RC=0，42978 字节，18s（暖）
mac$ node src/cli.js emit c .winlab/hi.js > hi-mac.c       42978 字节
mac$ diff hi-win.c hi-mac.c                                 一行都没有
```

**42978 对 42978，逐字节相同** —— 前端、降级、C 后端这一整条在 Windows 上与 macOS
出的是同一份东西。omni 这条腿在 Windows ARM64 上于是**真的能编东西了**。

还没走到的：`build`（要把 sysroot 与 `runtime/*.c` 也摆到客户机上）。

### 8之二、**核心自己在 Windows 上编出了一份 `.exe`**（自举那一步走通了）

摆法（`bootstrap.js` 那一套装好的样子，客户机上手搭一份）：

```
C:\omni\bin\omni.exe            ← --fat 那一份（86.2MB）
C:\omni\share\{runtime,jit,runtime-gl,include}
C:\omni\sysroot\{win32,libc}
```

`C:\omni\bin\omni.exe build hi.js --arch arm64 --os win32 --libc self -o hi-selfhost.exe`
→ `RC=0`、1,179,648 字节（`cc 1m53s`，客户机上真编了那 21 份运行时 `.c`），
跑起来 `hi from js leg` / `argv=undefined [selfhosted]` / `raw-write`、`RUN-RC=0`
—— 与 macOS 上同一份源码的输出**逐字相同**。

路上四个真 bug（都在这条腿上才露出来）：

1. **`omni_host_spawn` 在 Windows 上一进门就崩**：那儿是 `fork`+`execvp`，这条腿的
   `fork` 回 ENOSYS，而报错走的是 `omni_error`（致命，JS 侧的 try/catch 拦不住）——
   `omni.exe build` 印的是 `omni: runtime error: cannot fork`，一个字节的产物都没有。
   改成 CreateProcessA 那一路：拼命令行、把三个 fd **复制成可继承的句柄**、起、等
   （`win32/libc/io.c` 的 `__libc_spawn` / `__libc_spawn_wait`）；**起不来回 127**，
   不再崩 —— 「起不来」是一种结果，编译器启动时问的那句 `uname` 在 Windows 上本来就没有。
   顺带：`hostOs()` 认 `OS=Windows_NT`/`SystemRoot`、`hostArch()` 认
   `PROCESSOR_ARCHITECTURE`，于是那一句 `uname` 在 Windows 上压根不发
   （从前落到 `x86_64`，在 ARM64 机器上是错的）。
2. **`omni_js_install_dir` 只认 POSIX 路径**：`C:\omni\bin\omni.exe` 不以 `/` 开头，
   于是被当成相对路径接在 cwd 后头、`strrchr(buf,'/')` 找到的是 cwd 里那一个 ——
   installDir 报的是**当前目录**。后果一串：`没有 arm64-win32 那一份 sysroot`、
   接着 `srcStamp()` 从 `.` 的上一层往下扫，撞上 `C:\Users\All Users\Application Data`
   这个拒绝访问的交接点，整趟 `ENOENT` 死。现在盘符与 UNC 都算绝对、两种分隔符都认；
   `host/native.js` 的 `installDir()`（node 腿）同一处也补了 `\\`。
3. **扫目录不该因为一个读不动的子目录而死**：`srcStamp()` 的 `walk` 现在跳过读不动的。
4. **`fstat` 把文件大小读错了一格**：`BY_HANDLE_FILE_INFORMATION` 里 size 的高低位在
   32/36，第一版读的是 28/32（那是卷序列号与 size 的高一半），于是那行流水账印的是
   `-7866003856960782000B`。产物本身一直是好的 —— 这种错只伤那一行，所以更该记一笔。

`--fat` 是这条腿的常态（插件那一格还卡在下面第七节那个设计选择上）。

### 8之三、`.omni` 在 Windows 上编、在 Windows 上跑，与 `.expected` 逐字节相同

用户要的那句「像在当前 mac 一样，对各种语言使用 `--backend c`」的第一格验收：

```
C:\omni\bin\omni.exe build basics.omni --arch arm64 --os win32 --libc self -o basics-win.exe
  → BUILD-RC=0（前端 58ms + 发射 21ms + cc 14.7s）
basics-win.exe > basics-win.txt   → RUN-RC=0
diff basics-win.txt <(tests/cases/01_basics.expected 里 --- stdout --- 那一段)  → 一行都没有
```

35 行、167 字节，与仓库里那份**规范输出**逐字节相同 —— 前端、类型、容器、格式化那一整条
在 Windows 上与另两条腿同一个答案。（那一行流水账印的产物大小是 `-7866…B`，
就是上面第 4 条那个 `fstat` 的错；已改，这一份核心比改动早。）

### 8之四、语言那一栏：现在能在 Windows 上编什么

| 输入 | 在 Windows 上编 | 跑出来 |
| --- | --- | --- |
| `.js` | ✅ | 与 macOS 逐字相同（`emit c` 的 C 也逐字节相同） |
| `.omni` | ✅ | 与 `tests/cases/01_basics.expected` 逐字节相同 |
| `.c` | ✅ | 与 macOS 逐字相同（`libcprobe.c` 那一串 `%d %s %.6f %g`） |
| `.asy` / `.jnc` | ❌ | **不是 Windows 的账**，见下 |

`.c` 那一栏路上补了两格（两格都是**交叉编译本来就该有**的，不只是 Windows）：

- **`sysIncDirs` 现在认 `CROSS`**：没写 `--sysroot` 但这一趟是交叉（或 `--libc self`）时，
  系统头换成目标那一份。从前读的是**本机**的头 —— mac 上 `build x.c --os win32` 撞
  macOS SDK 的 `sys/cdefs.h:1068: #error Unsupported architecture`，Windows 上更直接：
  `include file 'stdio.h' not found`。生成的那份 C 一直是对的（`buildSelf` 自己按
  `CROSS` 算），漏的一直是**用户自己那份 `.c`**。
- **`buildCFile` 把 `--libc` 与 `--sysroot` 递给 `c link`**：从前只递 arch/os，于是
  `build x.c --arch arm64 --os win32 --libc self` 落进 `c link` 的本机那一支，
  报 `pe: 找不到 x86_64-win32-libtcc1.a`（连目标都没换过去）。

**`.asy` / `.jnc` 挂在 `--fat` 上，与 Windows 无关**（在 macOS 上一样挂，所以不是这一刀的账）：

```
# 都用 --fat 那一份原生核心（macOS，88.8MB），share/ 摆好
omni-fat-mac check tests/asy/cases/01-arith.asy   → omni: runtime error: undefined is not a function
omni-fat-mac check tests/jnc/cases/02-control.jnc → 超时（看门狗停的）
omni-fat-mac check tests/cases/01_basics.omni     → ok
omni-fat-mac check hi.js                          → ok
# 同一份源码在 node 腿上：asy 2.3s ok、jnc 5.9s ok（GLR 表建得出来，437 states）
```

两门走 GLR 的语言在 `--fat` 的原生核心上坏，`.js`/`.omni` 好；node 腿全好。
Windows 上的表现与 macOS 一模一样（先建表 437 states、cache hit，然后
`undefined is not a function`）。这一格记成独立一刀（见任务表），不在 Windows 这条腿里修。

### 9. 顺带量到的两条环境坑

- **别从 SMB 共享上跑 `.exe`**：`Z:\.winlab\hi-arm64.exe` 这种跑法挂住（100s 不回，
  1.1MB 的程序也一样），同一份文件拷到 `C:\Users\clover\` 下瞬间就出结果。
  拷进去用 `vmrun copyFileFromHostToGuest`，45MB 量到 70~100s（VMCI 那条管子就这么宽）。
- **`if errorlevel 1` 判不出崩溃**：0xC0000005 当有符号数是负的，`errorlevel 1`
  于是为假 —— 看着像「退出码 0」。要 `call echo RC=%%errorlevel%%` 才看得见真数。


## 十、**遗留的两刀**（这一刀不修，写在这儿等后续）

### 10.1 插件在 Windows 上怎么出 `.dll`（卡在设计，不是卡在链接）

链接器那一侧已经通了（`--shared` → `dll: true`、入口 `__dllstart`、`selfLibc` 只接
kernel32）。卡的是**模型**：插件按「核心里的符号留成未定义、`dlopen` 在平坦命名空间里解析」
设计（ADR-0021 的 S1），量出来 2819 个未定义符号（`g_ASSIGN_OPS_JS`、`g_BINARY`…）。
Windows 上未定义符号必须在导入表里**指名模块**。三条路，选一条：

1. **核心导出、插件按名导入**：`omni.exe` 摆一张导出表（`pe_sections` 本来就会为
   `dllexport` 的符号摆，`pe-link` 还会顺手写一份 `.def`），插件生成一条指向
   `omni.exe` 的导入描述符。最贴近现在的模型；额外要改的是 `backend-c`：绑到核心的
   **全局变量**得按 `dllimport` 那层间接发码（PE 没有 copy 重定位）。
2. **插件各自静态链一份核心**（不给 `--bind`）：链得出来，每格几十 MB。
3. **注册时递一张函数表**：最干净，但这是三条腿共同的接口改动，不属于 Windows 这一刀。

在此之前 Windows 这条腿走 `--fat`（一份 86.2MB 全内建，`emit c` / `build` 都验过）。

### 10.2 `--fat` 的原生核心跑 `.asy` / `.jnc` 是坏的（**macOS 上同样坏**）

不是 Windows 的账 —— 复现只要 macOS：

```
node src/cli.js build src/cli.js --extern --fat -o /tmp/omni-fat-mac
# share/ 摆好：share/{frontend-asy/{asy.grammar,builtins.tab},frontend-jnc/jnc.grammar,lib/asy,runtime,include}
/tmp/omni-fat-mac check tests/asy/cases/01-arith.asy   → omni: runtime error: undefined is not a function
/tmp/omni-fat-mac check tests/jnc/cases/02-control.jnc → 超时（看门狗停的）
/tmp/omni-fat-mac check tests/cases/01_basics.omni     → ok
/tmp/omni-fat-mac check <任意 .js>                     → ok
# node 腿上同一批：asy 2.3s ok、jnc 5.9s ok（表建得出来，437 states）
```

线索：`-v` 印到 `grammar asy 437 states, cache hit` 与 `asy builtins 52 条绑定` 都好，
**紧接着**那一句就是 `undefined is not a function` —— 像是按名字查的那张动作表
（GLR 的 reduce 动作 / 插件注册的工厂）在 fat 模式下缺了一格。`.js`/`.omni` 不走
那条按名分派的路，所以没事。

要紧的原因：Windows 现在**只能**走 `--fat`（10.1 没定），所以 fat 一坏，
Windows 上就只有 js / omni / c 三门语言。


## 十一、还没核对的几格

- **ARM64 Windows 的调用约定**：与 AAPCS64 有出入（可变参数、结构体传递、`x18` 是平台寄存器不可用）。
  `arm64/from_mir.js` 现在按 osx/linux 的规矩发码，win32 那格要单独核对。
- **PE 的 arm64 展开信息**：x86_64-win32 已有 `.pdata`，arm64 的 `.pdata/.xdata` 格式不同；
  先不追求能被调试器回溯，只求能跑（`backtrace` 走自己的帧链，不依赖系统展开表）。
- **SMB 上的文件时间戳/大小写**：增量缓存（`.omni-cache`）按 mtime+size 判定，SMB 的时间精度
  要留神；出怪事先 `--no-incr` 排除。
