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

现在有的（量在 `tests/x64/docker-run.sh` 第 8 笔账）：
`printf` / `fprintf` / `snprintf`（`%d %u %x %s %c %p`，带宽度与零填充）、
`malloc`/`free`/`calloc`/`realloc`（brk 上的 first-fit）、
`mem*` 与 `str*` 那一族、`open`/`read`/`write`/`close`/`stat` 一路文件 IO、
`exit`/`_exit`/`abort`。

**还没有的**：`%f` 那一族、`atexit` 的回调、线程、`dlopen`、目录遍历。
整份编译器自举到这份 libc 上还差这些。

`libc/*.c` 只吃 `libc/syscall.h`，**看不见** `include/` 里那份给用户程序的头 ——
那边的 `FILE` 是 glibc 的形状，与我们的 `struct __FILE { int fd; }` 是两回事。

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

## 还欠的一格

`lib/crt1.c` 里那个 `_start` **取不到真的 argc/argv**：内核把它们放在栈上
（`[rsp]` 是 argc），而 C 函数的 prologue 已经动过 rsp，纯 C 读不回来。我们的 C 前端
还不支持非空的 `__asm__` 模板（`tccgen.js`：「第八刀：非空的 __asm__ 模板还没到」），
所以这一份先传 `0` / `NULL`。

后果：交叉编译出来的程序**读不到命令行参数**。不读 argv 的程序（`bench/fib.omni`
这种）跑得对；要读的还欠着。真正的解法与 `__dso_handle` 同一个手法 ——
让链接器自己发那几条指令，那要先有汇编器那一格。
