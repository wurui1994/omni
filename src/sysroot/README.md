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

九个 `.c`（量在 `tests/x64/docker-run.sh` 第 8/10 笔账）：

- `start.c`   `_start`：`__builtin_frame_address(0)` 取 argc/argv/environ，收场走 `exit`
- `string.c`  `mem*` / `str*`，零 syscall
- `io.c`      `open`/`read`/`write`/`stat`/`mkdir`… 加 `__errno_location`
- `malloc.c`  `brk` 上的 first-fit（每块一个 16 字节头，free 只清标记）
- `stdio.c`   `printf` 一族：整数/字符串**与 glibc 逐字节相同**，浮点见下
- `strtox.c`  `strtol` 一族 + `strtod`（尾数攒成 u64，最后**一次**乘 10 的幂）
- `file.c`    `FILE *` 那一层：无缓冲，`FILE` 就是一个 fd 加两位状态
- `math.c`    自己那份 libm：exp/log 用 Cody-Waite 归约 + 泰勒，sqrt 牛顿六次，
              sin/cos 折进 π/4，atan 半角三次压到 0.1 以下。与 glibc 逐点对账
              （120 个采样）最大相对误差 **2.18e-12**，而那一格是过零点附近的
              `cos(π)`；其余都在 1e-15 一档
- `misc.c`    时间（UTC，没有时区库）、`getenv`/`setenv`、进程（`fork`/`execvp`/
              `system`）、目录（`getdents64`）、`atexit`、`strerror`、`sscanf`

**还没有的**（明说）：
- 浮点打印是「归一化 + 逐位取整」，全在 double 上算 —— `%.17g` 最后一两位可能与
  glibc 差一个 ulp（17 行的对账里 7 行不同，差的都在末位）。`%f` 印很大的数时
  只有前 25 位有效数字是真的（glibc 印的是精确展开，那要大整数）。
- 线程：`pthread_create` 照 POSIX 回 `EAGAIN` —— 我们的运行时**本来就有退路**
  （`omni_js_host.c:88`：开不出线程就直接调 `entry()`）。
- `sigaction` 回 `ENOSYS`（要 `SA_RESTORER` 那个跳板，得等汇编器）；
  `backtrace` 回 0；`dlopen` 一族调到就崩（假句柄比崩坏）。

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

这一格只有 x86_64：arm64 那边帧基址按「这个函数动不动栈顶」在 x28 与 sp 之间选，
「帧指针」不是一句话说得清的东西，所以那条腿上 `FPGET` 明着报错（猜一个的后果是
crt 读到垃圾 argv）。
