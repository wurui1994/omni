# 交叉编译的 sysroot（自带的精简系统头 + 符号预设）

在**这台机器**上编出**另一个平台**能跑的二进制。用法：

```sh
omni build bench/fib.omni --arch x86_64 --os linux \
  --sysroot src/sysroot/x86_64-linux -o fib-linux
```

## 为什么要自带一份，不用本机的头

交叉编译时目标平台的头与库**不在这台机器上**。tcc 的 win32 那一路早就是这么办的：
`win32/include` 自带头、`win32/lib/*.def` 自带符号清单，于是在 Linux 上也出得了 `.exe`
（`tcc_add_library` 在 PE 上找的第一样东西就是 `%s/lib%s.def`）。这一份把同一个形式
铺到 ELF 与 Mach-O 上。

**只写用得着的那些。** 头不是完整的 libc —— 它只声明我们的运行时（`src/runtime/*.c`
那 20 份）与生成的 C 真正用到的东西。量法：

```sh
# 运行时用了哪些系统头
grep -h '^#include <' src/runtime/*.c src/runtime/*.h | sort -u
# 用了哪些外部符号（在目标机器上编一趟，看未定义符号）
llvm-nm -u .omni-cache/rt/*/*.o .omni-cache/work/c-*/a.out.c.o | awk '{print $2}' | sort -u
```

量到的：Linux 上 117 个 libc 符号、macOS 上 149 个（多出来的是 `___error`、
`___isfinite*`、`___stdinp` 一族这些 Apple 专有的名字）。

## 结构

```
src/sysroot/<arch>-<os>/
  include/         精简系统头（stdio.h / stdlib.h / string.h / math.h / …）
  lib/*.def        符号预设：库叫什么、有哪些名字（哪些是数据、多大）
  lib/crt1.c       我们自己的 `_start`（不拷目标平台的 crt1.o）
  lib/atexit.c     我们自己的 `atexit`（glibc 那份只在 libc_nonshared.a 里）
  libc/*.c         **我们自己那份 libc**（`--libc self`，见下）
```

`lib/*.c` 那两份由**我们自己的 C 前端**在链接前编成 `.o`（`cli.js` 的 `sysObj`），
所以这个目录里**一个目标平台的二进制都没有** —— 与 tcc 的 `lib/dsohandle.c`
同一个思路（它也是拿自己编，进 `libtcc1.a`）。

## `--libc self`：自己那份 libc（第一百四十片）

```sh
omni c obj x.c --arch x86_64 --os linux -o x.o
omni c link x.o -o x --stdlib --libc self \
  --sysroot src/sysroot/x86_64-linux -f elf --arch x86_64 --os linux
```

`libc/` 里那几个 `.c` 编出来的 `.o` 与用户程序一起链，**一个外部库都不要**：
出来的可执行文件 `ldd` 说 `statically linked`，`DT_NEEDED` 一条都没有。

地基是一条 MIR op —— `__omni_syscall(号, 实参…)`（`mir/ir.js` 的 `SYSCALL`），
在 x86_64 上降成一条 `syscall`、在 arm64 上降成 `svc #0`。**为什么非得是 op**：
调 libc 是循环依赖；内联汇编那条路上 C 前端的非空 `__asm__` 模板还没到；
预编译一个 `.o` 塞进仓库是「复制二进制」。所以照 `SPGET`/`FRAME` 的先例 ——
MIR 说「要什么」，摆法归后端。

十个 `.c`（量在 `tests/x64/docker-run.sh` 第 8/10 笔账）：

- `start.c`   `_start`：`__builtin_frame_address(0)` 取 argc/argv/environ，收场走 `exit`
- `string.c`  `mem*` / `str*`，零 syscall
- `io.c`      `open`/`read`/`write`/`stat`/`mkdir`… 加 `__errno_location`
- `malloc.c`  32 个箱的空闲表 + 顶上切 + **攒着做的合并**，全是 O(1) 摊还。
              判据 `tests/c/libc-malloc.js`（本机 0.3s 跑完 20 万块；第一版是
              **线性 first-fit**，在那儿 timeout）。碎片那一格是「同样的 6 万步跑两趟，
              第二趟一个字节都不许再跟系统要」：合并之前第二趟又要了 64M，之后是 0
- `stdio.c`   `printf` 一族：整数/字符串**与 glibc 逐字节相同**，浮点也是（见下面
              「浮点打印」那一节 —— 数字从位模式摊成精确的十进制）
- `strtox.c`  `strtol` 一族 + `strtod`（**正确舍入**：两个大整数的商 + 一次长除法，
              见下面「`strtod`」那一节）
- `dec.c`     基 10^9 的大整数 —— 浮点的两头（打印与解析）共用这一份
- `file.c`    `FILE *` 那一层：无缓冲，`FILE` 就是一个 fd 加两位状态、再加一格
              `ungetc` 的退回位；`fscanf` 借公用的 `__libc_vsscanf`（它回「吃了多少
              字符」）把文件位置退回去。判据 `tests/c/libc-stdio.js`（26 行，两条腿
              都与平台 libc 一行不差）
- `math.c`    自己那份 libm：exp/log 用 Cody-Waite 归约 + 泰勒，sqrt 牛顿六次，
              sin/cos 折进 π/4（π/2 拆**三段**；|x| > 2^45 走 **Payne-Hanek** ——
              拿 400 位的 π 去除，而那 400 位是用 Machin 级数**自己算**的，
              不抄常数表），atan 半角三次压到 0.1 以下。
              与平台 libm 逐点对账（395 个采样，判据 `tests/c/libc-libm.js`）：
              **最大误差 5.4e-15**，302 个点逐字节相同
- `misc.c`    时间（UTC，没有时区库）、`getenv`/`setenv`、进程（`fork`/`execvp`/
              `system`）、目录（`getdents64`）
- `pure.c`    纯计算的杂项：`strerror`、`atexit`、`gmtime_r`/`strftime`、`sscanf`、
              `qsort`（堆排序：不 malloc、不递归、最坏也是 O(n log n)）、`bsearch`。
              这一族与 `string.c`/`stdio.c` 的边角由 `tests/c/libc-str.js` 逐行对账
              （22 行，两条腿都与平台 libc 一行不差）；日历那一格另有
              `tests/c/libc-time.js`（14 个时刻 × 九个字段 + 七种格式，两条腿各 113 行
              一行不差 —— 秒数掰年月日走 civil_from_days 那条封闭公式，没有分支可错，
              这条判据是**为了守住它**，不是为了顺错）。`localtime_r` 就是 `gmtime_r`
              （没有时区库），`%Z` 印 `UTC`。

**还没有的**（明说）：
- 线程：`pthread_create` 照 POSIX 回 `EAGAIN` —— 我们的运行时**本来就有退路**
  （`omni_js_host.c:88`：开不出线程就直接调 `entry()`）。
- `backtrace` 回 0（诊断用）；`dlopen` 一族调到就崩（假句柄比崩坏）。
- macOS 那条腿的 `sigaction` 还回 `ENOSYS`：Darwin 的 `sigaction(46)` 要用户自己给
  `sa_tramp`，那个跳板得保住 x1/x4/x5 再走 `sigreturn(184)`—— 与 Linux 那 9 个字节
  不是一回事，另开一格。

**信号那一格（x86_64-linux，第十五格）已经是真的**：`sigaction` 走 `rt_sigaction(13)`，
`SA_RESTORER` 要的那个跳板**运行时自己写**（`mmap` 一页 → 填
`48 c7 c0 0f 00 00 00 | 0f 05`（`mov rax,15; syscall`）→ `mprotect` 成可执行），
所以不用等汇编器。用户那份 `struct sigaction`（`{handler, mask[128], flags@136,
restorer@144}`）与内核那份（`{handler, flags, restorer, mask}`，还要第四个参数
`sigsetsize=8`）在这一层翻译。顺带把两处**假话**改真：`alarm` 原先「收下就扔」
（现在是号 37），`sigemptyset`/`sigaddset` 原先「回 0 什么都不做」（现在是真的位算术，
外加 `sigfillset`/`sigdelset`/`sigismember`）。判据 `tests/x64/libc-signal-probe.c`
自己判自己，12 格全 ok —— 我们那份与 gcc 那份尺子**逐行相同**。

## 浮点打印：与平台 libc **一行不差**（第一百四十片第九格）

一个 double 就是 `m × 2^e`，而它的十进制展开**是有限的** —— 所以「精确」不用 dragon4
那套循环，只要一个大整数乘法（`stdio.c` 的 `decExpand`）：

```
e ≥ 0：值就是整数 m·2^e，小数位 0            （最多 309 位）
e < 0：m / 2^k = m·5^k / 10^k —— 算 m·5^k，小数点往左退 k 位（最多 1074 位）
```

大整数用**基 10^9 的节**，于是「摊成数字串」就是逐节印九位，一次除法都不用；
一个节乘 `2^29` 或 `5^12` 还在 u64 里，所以幂是成块吃的。收位那一步是**半到偶**
（glibc 默认那一档）。这条路上**一次浮点运算都没有** —— 位模式进来，整数出去。

量出来的（`tests/x64/libc-float-probe.c`，30 个值 × 五种格式 + 大数与 `%.20f`，155 行；
判据 `tests/c/libc-float.js` 与容器里那一趟）：

```
改之前   41 行不同 / 155      （归一化 + 逐位取整，全在 double 上算）
改之后    0 行不同 / 155      arm64-osx 与 Apple 的 libc、x86_64-linux 与 glibc
```

盯住的难点：`0.1` 的 `%.17g`（`0.10000000000000001`）、`1/3`、`-0`（符号看**位模式**，
`-0.0 < 0.0` 是假的）、`9007199254740992` 与 `4503599627370497` 这两个 2^53 边界上的
半到偶、`5e-324`、`1e±300`、以及 `%f` 印 `1.7976931348623157e308` 那 309 位数字。

**也记一条负结果**：先前试过「只除一次」那一版（`v / 10^(e10-16)` 一次取 17 位），
更差 —— 28 个采样 17 个不同，而且 `2.2250738585072014e-308` 印成
`4.4674407370955161e-306`（那个 10 的幂自己就溢了）。没收。

## `strtod`：反方向也精确（第十格）

同一个大整数（`dec.c`）反着用：一串十进制就是两个大整数的商 `N / Den`（`10^dexp`
往哪边乘看指数的符号），把商挪进 `[2^52, 2^53)` 再做**一次长除法** —— 商是 53 位尾数、
余数决定末位。**一次浮点运算都没有**。

判据 `tests/c/libc-strtod.js`（探子 `tests/x64/libc-strtod-probe.c`）比的是 `%016llx`
**位模式**，而不是印出来的样子：差一个 ulp 在十进制上常常看不见、在位上藏不住。
31 个串 + 21 个往返（印 17 位再读回来）：

```
改之前   21 / 31 位不同、21 个往返里 8 个回不来
         1.7976931348623157e308 -> inf（中间那次乘法自己溢了）、5e-324 -> 0
改之后    0 / 31、往返 0 个不同   arm64-osx 与 Apple 的 libc、x86_64-linux 与 glibc
```

**收位只许收一次**：先收成 53 位再为非规格化右移是**两次舍入** —— 量到过
`2.2250738585072011e-308`（glibc 那个著名样本）读成最小的规格化数
`0x0010000000000000`，而正确答案是最大的非规格化数 `0x000fffffffffffff`。
现在长除法只交回「截断的 53 位 + 余数在哪一档」，收位在 `decBits` 里做，一次。

## 整份编译器跑在自带 libc 上（两条腿都量过）

```
x86_64-linux（容器里）  72.9M   ./omni --help / check / emit mir  三条 rc=0
                        ldd 说 statically linked，DT_NEEDED 一条都没有
                        （76453421 字节、16 节、8 段；前端 1.5s + 发射 1.1s + cc 20.0s）
arm64-osx（本机）       43.2M   OMNI_CC=self omni build src/cli.js --extern \
                                  --libc self --sysroot src/sysroot/arm64-osx
                        C 16.8M / 334626 行，前端 1.2s + 发射 394ms + cc 9.2s
                        otool -L **一行都不印** —— 连 libSystem 都不沾
                        ./omni check 五份用例，输出与 node 那条腿逐字相同
```

两条腿都是在**这一版 libc**（精确的浮点打印与 strtod、Payne-Hanek、补齐的
qsort/bsearch/ungetc/fscanf 那一批）上重新量的。

macOS 那一趟顺出三笔账，都是「按 Linux 的形状照抄」踩出来的：

- `___isfinited` 一族没定义。Darwin 的 `<math.h>` 把 `isnan`/`isfinite` 展开成
  `__isnand`/`__isfinited`（glibc 是 `__isnan`/`__finite`）。**判断一份都没重写** ——
  八个名字在 `arm64-osx/libc/misc.c` 里接到公用 `math.c` 上。
- `___stderrp` 没定义。三条流在 Darwin 上叫 `__stdinp`/`__stdoutp`/`__stderrp`。
  FILE **那三个对象**移到公用 `stdio.c` 里导出，两套名字指同一份 —— 各开一份的后果是
  `printf` 与用户的 `fprintf(stderr, …)` 各攒一半。
- **`getcwd` 那个调用号在 arm64 macOS 上无效**：326 调下去收 SIGSYS
  （`Bad system call: 12`），而且**Apple 自己的 `syscall(326, …)` 也一样崩** ——
  所以不是我们摆错寄存器，是那个号不通。改走 libSystem 那条路：打开 `.` 再
  `fcntl(F_GETPATH)`。这一格整份编译器一起来就死，判据搬到了最近的一层：一份
  15 行的探子挨个调（time/clock_gettime/getcwd/isatty/access/stat/readlink/
  getrlimit/getrusage/sigaction/kill/realpath/pthread_*），死在第几行就是第几格。

这条腿上**做得到与做不到，量过一遍**（43.2M 那个二进制，本机 macOS）：

```
omni --help                                  rc=0
omni check tests/cases/*.omni（五份）         与 node 那条腿逐字相同
omni emit ast|oir|mir 01_basics.omni         三格都出，rc=0（这三格在核心里）
omni cpp x.c                                 「c 没装：这份 omni 里没有 'c.preprocess'」
omni run x.omni                              「cgen 没装」
```

分界线很干净：**核心里的走得通，要插件的走不通** —— 插件是 `dlopen` 装的，而自带 libc
里 `dlopen` 一族是崩的（见上面「还没有的」）。所以现在成立的是「前端 + 检查器 +
中间形态」，与 Linux 那一趟同一档。

## 两个目标各自的那一半（第一百四十片第五格）

```
src/sysroot/libc/                公用：一行 syscall 都没有的八份
                                 string math strtox stdio file malloc pure dec + libc.h
src/sysroot/x86_64-linux/libc/   syscall.h io.c misc.c start.c
src/sysroot/arm64-osx/libc/      同上四份，内容各不同
```

差在哪儿（都是量出来的）：

- **摆法**：Linux 号进 x8 + `svc #0`；Darwin 号进 **x16** + `svc #0x80`，而且号要带
  类别位（BSD 是 `2 << 24`）。这一格归后端（`arm64/from_mir.js` 看 `mod.os`）。
- **出错**：Linux 回 `-errno`；Darwin **置进位标志**、x0 里是**正的** errno。
  op 的约定只有一条「回负数就是 -errno」，所以 Darwin 那一支后端多发一条
  `cneg x0, x0, cs`。少了它 `open("/nope")` 回的 2 与 fd 2 分不开。
- **入口**：Linux 的 `_start` 从栈上捞 argc/argv（`__builtin_frame_address(0)` +
  偏移）；macOS 的 `LC_MAIN` 入口是**像 main 一样被调用的**（argc 在 x0、argv 在 x1、
  envp 在 x2）。按栈上捞那一版在 macOS 上量到的是 `argc=0`。
- **要内存**：Linux 是 `brk`；Darwin **没有 brk**，只能 `mmap`（页 16K）。所以公用的
  malloc 只跟目标要 `__libc_chunk`，**不假设两次要来的地方连着**。
- **目录**：`getdents64` 与 `getdirentries64` 的记录不一样 —— 名字一个在第 19 字节、
  一个在第 21（Darwin 多一格 `d_namlen`）。
- **两个返回值**：Darwin 的 `fork` 交回 x0 = pid、**x1 = 是不是子进程**（父 0、子 1），
  `pipe` 的两个 fd 也都在 x0/x1 上。只看 x0 的话父子都以为自己是父 —— 量到过：探子的
  后四行印了**两遍**。所以有了 `SYSCALL2`（`__omni_syscall2(号, &第二个返回值, 实参…)`）：
  池的第一格是「x1 写到哪儿」的地址，后端在 `svc` 之后补一条 `str x1, [x9]`。
  Linux 那条腿上**没有**这个用户（`fork` 只交回 rax、`pipe2` 写用户给的数组），
  所以 x86_64 的 `SYSCALL2` 明着报错，不写没人用的码。
- **macOS 上的 `setjmp`**：与 Linux 那一份**同一行 C**（`__omni_setjmp(env)`），差别全在
  后端：存的是 x19-x28 与 d8-d15（不是那边的 rbx/r12-r15），加调用者的 x29 / sp /
  返回地址，一共 168 字节（`jmp_buf` 是 192）。x28 那一格不是凑数 —— 它就是帧基址
  `FB`，跳回一个有变长数组的函数时要它。`longjmp` 的值放 **x0 而不是内部那个 `RES`
  （x8）**：落点是调用者 `bl` 的下一条，它按 ABI 从 x0 取值。量到过：写到 x8 上那一版
  控制流全对、`setjmp` 却回了个地址（47923552）—— 最难查的那一种。

量到的（都是本机 arm64 macOS 上直接跑，不进容器）：

- `argc/argv`：`./a-osx one two three` -> `argc=4`、四行 argv 全对、rc=4
- 「系统那一半」（`tests/x64/libc-sys-probe.c`，17 行，含 `system("true")`、`pipe`、
  `setjmp`/`longjmp`）：与 Apple 的 libc **逐行相同**（`diff` 无输出），两边 rc=0。
  同一份探子在 x86_64-linux 容器里与 glibc 也逐行相同。
- libm 对账（120 个采样）：最大相对误差 **2.18e-12**，与 Linux 那一趟同一个数
  （math.c 是同一份文件）

`libc/*.c` 只吃 `libc/syscall.h` 与 `libc/libc.h`，**看不见** `include/` 里那份给用户
程序的头 —— 那边的 `FILE` 是 glibc 的形状，与我们的 `struct __FILE` 是两回事。
内部符号一律 `__libc_` 前缀，不许用 `__omni_`：那个前缀是**线性内存那条腿的宿主接口**，
C 前端在 native 上见到它就明着报错（`tccgen.js:7933`）。

## `.def` 的形状

```
; 注释（`;` 或 `#` 起头）
LIBRARY libc.so.6          ; 装载时要的那个名字（DT_NEEDED / LC_LOAD_DYLIB）
EXPORTS
printf                     ; 函数
stdout DATA 8              ; 数据符号：ELF 上要 copy 重定位，得知道多大
```

- 名字**照目标格式的写法**：Mach-O 上前面那条下划线要自己带（`_printf`），ELF 上不带。
- `DATA <字节数>` 不是装饰：ELF 上数据符号要在可执行文件自己的 `.bss` 里划一块、
  放一条 `R_*_COPY`，划多大得从库里问。真的 `.so` 里那是 `st_size`，没有库可问的时候
  只能由这一份说。量到过：`stdout` 少了这一格，装载时报 `undefined symbol: stdout`。

## 量出来的几处「必须按目标走」

| 东西 | x86_64-linux | arm64-osx |
|---|---|---|
| 三条标准流 | `extern FILE *stdout`（数据符号） | `__stdoutp`（宏指向它） |
| `errno` | `(*__errno_location())` | `(*__error())` |
| `O_CREAT` / `O_TRUNC` | `0100` / `01000` | `0x0200` / `0x0400` |
| `RTLD_LOCAL` | 0 | 4 |
| `struct stat` | 144 字节，`st_mtim` 在 88 | 布局不同，`st_mtimespec` |
| `ru_maxrss` 单位 | KB | 字节 |
| `isnan` 一族 | `__isnan` / `__finite` / `__signbit` | `___isnand` / `___isfinited` |
| `pthread_main_np` | 没有（走 `getrlimit`） | 有 |

结构体的字节数与字段偏移都是**量出来的**（`src/sysroot/offsets.c`，在目标机器上
`gcc -o offsets offsets.c && ./offsets`），不是照文档抄。

## `_start` 怎么拿到 argc/argv（第一百四十片第二格，已还）

内核跳到 `_start` 时 argc/argv 躺在栈上（`[rsp]` 是 argc），**没有返回地址** ——
内核是跳过来的，不是 call 过来的。序言一律 `push rbp; mov rbp, rsp`，推那一格之后
rbp 指着它，于是 `[rbp+8]` 是 argc、`rbp+16` 是 argv 的第一格。

`__builtin_frame_address(0)` 就是 rbp（tcc 那边也是：`tccgen.c:5867` 的
`vset(&type, VT_LOCAL, 0)`），我们把它降成一条 `OP.FPGET`。于是 `lib/crt1.c` 与
`libc/start.c` 都用**纯 C** 写得出来 —— 不欠汇编器，也不欠链接器合成代码。

量到的（容器里）：

```
./argsbin one two three   # --libc self
argc=4 / argv[0]=./argsbin / argv[1]=one / argv[2]=two / argv[3]=three   rc=4
./argsglibc a bb ccc      # --sysroot（glibc 那条）
argc=4 / argv[0]=./argsglibc / argv[1]=a / argv[2]=bb / argv[3]=ccc      rc=4
```

arm64 上这一格**不是同一件事**：`FPGET` 现在也实现了（一句 `mov x0, x29` —— 这条腿的
序言一律 `stp x29, x30, [sp, #-16]!` + `mov x29, sp`，x29 从来就是个真的帧指针；曾经
报错的理由说的是帧基址 `FB`，那是另一个寄存器），可 macOS 上**用不着它**：`LC_MAIN` 的
入口是**像 main 一样被调用的**，argc 在 x0、argv 在 x1、envp 在 x2。按栈上捞那一版在
macOS 上量到的是 `argc=0`，所以 `arm64-osx/libc/start.c` 直接把三个当形参收下。
