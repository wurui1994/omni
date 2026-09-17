#!/usr/bin/env bash
# tests/x64/docker-run.sh —— 在 **x86_64 Linux** 上过一遍我们自己那台 C 工具链
#
# 为什么要它：这台开发机是 arm64 macOS，而 `omni c` 那一组的目标默认值从前写死
# `arm64` + `osx`（第一百四十七片改成跟着 `uname` 走）。「跟着这台机器走」这句话
# 只有在**另一台机器**上才验得出来，所以判据摆在容器里。
#
# 镜像：`arch_llvm`（Arch Linux + LLVM，linux/amd64；里头有 node / clang / gcc / make，
# **没有 tcc**）。挂载就指向这个仓库本身 —— 不 COPY、不 build image：
# 源码是活的，改一行立刻在容器里生效。
#
#   用法：  tests/x64/docker-run.sh              # 默认那一串检查
#           tests/x64/docker-run.sh 'node tests/c/run.js'   # 自己指定一条命令
#           OMNI_X64_IMAGE=arch_llvm:latest tests/x64/docker-run.sh
#
# 量到的（2026-09-16/17，Docker Desktop on Apple Silicon，amd64 靠模拟跑）：
#   1. `omni c obj tests/c/abi/def.c` -> **ELF x86_64 可重定位**（`7f 45 4c 46 02 01 01`
#      … `01 00 3e 00`），头 20 字节与本机 clang 出的 `.o` 逐字节相同。
#      改之前这一步出的是 Mach-O arm64 —— 本机 clang / ld 一个都不认。
#   2. `omni build bench/fib.omni` -> 编得过、链得出：2.1M、24 节、8 段、入口 0x4fe500
#      （前端 16ms + 发射 15ms + cc 821ms，via self -O0）。
#   3. **跑起来了**（`rc=0`，印 `196418` / `999794999321`）。四笔账按顺序还完，每还一笔
#      就往前挪一个符号 —— 而每一笔的落点都先去 tcc 源码里查过：
#      a. `undefined symbol: stdout` —— 链的时候一个共享库都没交进去（`cDefaultLibs`
#         在非 macOS 上回空表），于是 `elf_exe.js` 那段 copy 重定位的前提
#         「库里找得着这个名字」不成立。**已还**：`-lc`。
#         这一格后来又往下走了一步：`/usr/lib/libc.so` 是**一份 ld 脚本**
#         （`GROUP ( libc.so.6 libc_nonshared.a AS_NEEDED ( ld-linux-x86-64.so.2 ) )`），
#         从前是把这三个库名一条条写死在 `cDefaultLibs` 里猜的；现在 `elf-link`
#         自己找库、自己读脚本（`ldscript.js`，照 tcc 的 `tcc_load_ldscript`），
#         `cDefaultLibs` 只剩 `-lc`（外加找得着才带的 `-lm`）。
#         量到的 DT_NEEDED：libc.so.6、ld-linux-x86-64.so.2、libm.so.6、libmvec.so.1
#         —— 一条不多一条不少，全是那两份脚本点的。
#      b. `elf: 找不到 'fmod'` —— 数学那几个符号在这台机器上只从 `libm.so.6` 露出来。
#         **已还**：存在就一起带上。
#      c. `elf: 找不到 'atexit'` —— 欠的是一格能力：`elf-link` 从前只收 `.o` 与 `--dll`。
#         证据（`llvm-nm -D --defined-only /usr/lib/libc.so.6`）：`stdout` 在（`D`），
#         `atexit` 不在 —— 它只住在 `/usr/lib/libc_nonshared.a`（7266 字节，那份 ld
#         脚本 `GROUP` 的第二项）。**已还**：ELF 链接器接了静态库（`--ar`，按需取用，
#         照 `macho_exe.js:708` 那段抄），`cDefaultLibs` 把 `libc_nonshared.a` 交进去。
#      d. `找不到 '__dso_handle'`（接上静态库之后冒出来的下一个）与**印完才 SIGSEGV**
#         （139）。两件事都是「不链 crt 就得自己补」：
#           * `__dso_handle` —— tcc 自己给（`lib/dsohandle.c` 一行，进 `libtcc1.a` 的
#             `LIN_O`；它**不**链 `crtbegin.o`）。我们落在链接器里：只在还没有定义时才给。
#           * SIGSEGV —— 入口指着 `main`，而 ELF 上内核直接跳 `e_entry`，栈上没有返回
#             地址，`main` 一 return 就 `ret` 到 argc 那格上去。tcc 的规矩是加
#             `crt1.o`+`crti.o`（末尾 `crtn.o`）、入口查 `_start`（`tccelf.c:1761/2717`）。
#             **已还**：`cCrt()` 按这个次序交进去。
#   4. `omni run x.c` / `omni build x.c`（printf + fmod）也都跑得对：`hello 42 1.5`。
#   5. **`node tests/selfc/run.js` 在容器里 6/0** —— 我们编、我们链，跑出来与解释器
#      逐字节相同，连「我们出 `.so` + 我们链的可执行文件 `dlopen` 它」那一格都过。
#      这条轴一开始是 2/4：它自己手拼 `-lc`，而那份清单**在非 macOS 上是空表**
#      （量到 `undefined symbol: stdout` 与 `undefined symbol: dlopen`）。判据没错，
#      错在判据自己拼清单 —— 于是「默认 libc + crt」收成 `c link --stdlib` 一个词，
#      `omni build` / `omni run` / 这条轴走同一条路。
#   6. **整份编译器在容器里自己编、自己链、跑起来了**（一个外部 C 编译器都不借）：
#        OMNI_CC=self node --max-old-space-size=8192 src/cli.js build src/cli.js -o /tmp/omni-x64
#        -> 75945472 字节（72.4M）、24 节、8 段、入口 0x5e9bb0
#           C 16.6M / 326444 行；前端 2.4s + 发射 809ms + cc 36.9s（整趟 44.5s，还是模拟出来的）
#        /tmp/omni-x64 --help                          -> 印出用法
#        /tmp/omni-x64 check tests/cases/01_basics.omni -> `ok  …：6 个函数`
#      本机 arm64 那一份是 35.4M（`cli.js` 的 `selfCC`）—— 两台机器不可直接比大小
#      （x86_64 这一份没有量过 `.text` 分布），这里只记「跑得起来」。
#   7. `omni c run`（线性内存那条解释器腿）在 Linux 上从前一句都跑不了：
#        /usr/include/gnu/stubs.h:7: error: include file 'gnu/stubs-32.h' not found
#      根因不是路径 —— 那条腿的**预定义宏**写死 arm64-osx，而它读的是这台机器真的
#      glibc 头（`__x86_64__` 没定义，`stubs.h` 于是走 32 位那一支）。macOS 上两边
#      正好对得上，所以从来没露头。**已还**：预定义跟着 `--arch`/`--os`（默认这台机器）走
#      （`cli.js` 的 `cTgt`）；那条腿的 **ABI** 仍是虚拟目标（`long double` = double、
#      `wchar_t` = int、`char` 有符号），由 `lowerC` 自己钉，见那儿的注。
#      量到的（`tests/c/gen/*.c` 逐个 `c run`，数「输出里带 error:」的）：
#        本机 arm64 macOS 1 份（39-strerror，那是 strerror 自己的字串）
#        容器 x86_64 5 份 —— 多出来的四份都在**解释器自带的那份 libc** 上，各是一格：
#          33-ctype           interp: C ABI call '__ctype_b_loc' is not supported
#          35-streams         undefined symbol 'stdout'（glibc 那儿是数据符号）
#          38-bytes           undefined symbol 'stderr'（同上）
#          53-typedef-shadow  storage class specified for 'struct' member（前端，glibc 头触发）
#      这四格是**解释器的 libc 与 glibc 头对不上**，不是目标默认值的事，各自单列。
#      顺带记下：容器里 `tests/c/run.js` 的 `gen/` 一组本来就不是判据 ——
#      仓库里那份 tcc 尺子是 macOS 二进制（`Exec format error`）。
#   8. **自带 libc 跑通了**（第一百四十片：`OP.SYSCALL` + `--libc self`）。
#      地基是一条新 op —— `__omni_syscall(号, 实参…)` 降成一条 `syscall`（x86_64）/
#      `svc #0`（arm64）。为什么非得是 op：C 前端的非空 `__asm__` 模板还没到，
#      而预编译一个 `.o` 塞进仓库是「复制二进制」（不收）。字节判据在
#      `tests/c/syscall.js`（9 条，本机就跑得动）；跑起来这一半在容器里量：
#      a. 零 libc 的 hello（`write(1,…)` + `exit(7)` 两条 syscall）：
#         `c obj` + `elf-link -e _start` -> 2155 字节、15 节、8 段、入口 0x4016b8，
#         印 `hello from syscall`、`rc=7`。**容器里编的与 macOS 上交叉编的逐字节相同。**
#      b. 我们自己那份 libc（`src/sysroot/x86_64-linux/libc/`，五个 `.c`：
#         start / string / io / malloc / stdio）与用户程序一起链：
#           node src/cli.js c link tl.o --stdlib --libc self \
#             --sysroot src/sysroot/x86_64-linux -f elf --arch x86_64 --os linux
#         -> 29781 字节、16 节、8 段、入口 0x4023b8。`ldd` 说 **statically linked**
#         —— `DT_NEEDED` 一条都没有，glibc 一个字节都不沾。跑出来五格全对：
#         `hello 42 world` / `malloc: AAAAAAAAAA` / `strlen: 6` / `strcmp: 0` /
#         `memcpy: hello` / `all ok`，`rc=0`。
#      **还欠的**（明说，别当已完成）：`%f` 那一族、`atexit` 的回调、线程、`dlopen`、
#      目录遍历都还没有 —— 整份编译器自举到这份 libc 上还差这些。
#   9. **`_start` 拿到真的 argc/argv 了**（第一百四十片第二格）。从前两份 crt 都传
#      `0` / `NULL`，理由是「argc 躺在进函数那一刻的栈上，而序言已经动过 rsp」。
#      还法不是汇编，是一条 op：`__builtin_frame_address(0)`（tcc 的 `tccgen.c:5867`
#      也是这么给的）-> `OP.FPGET` -> 一句 `mov rax, rbp`。序言一律
#      `push rbp; mov rbp, rsp`，于是 `[rbp+8]` 是 argc、`rbp+16` 是 argv 的第一格。
#      两条腿都量过（容器里）：
#        --libc self ：`./argsbin one two three` -> argc=4、argv[0..3] 全对、rc=4
#                      （29317 字节、16 节、8 段、入口 0x402230）
#        --sysroot   ：`./argsglibc a bb ccc`    -> argc=4、argv[0..3] 全对、rc=4
#                      （3884 字节、18 节、8 段，NEEDED 四条：libc/libm/libpthread/libdl）
#      顺带回归：交叉编的 `bench/fib.omni`（1.6M、19 节、8 段、入口 0x478a2f）照旧
#      `196418` / `999794999321`、rc=0。
#      arm64 那条腿上 `FPGET` **明着报错** —— 那边帧基址按「这个函数动不动栈顶」在
#      x28 与 sp 之间选，x86_64 的 rbp 那条死规矩不成立，猜一个的后果是读到垃圾 argv。
#  10. **自带 libc 补齐到「整份编译器链得出来」**（第一百四十片第三格）。
#      九个 `.c`（start/string/io/malloc/stdio/strtox/file/math/misc，见
#      `src/sysroot/README.md` 那张表）。量到的：
#      a. `omni build bench/fib.omni --libc self` -> 1.7M、16 节、8 段，
#         **`readelf --dyn-syms` 里 UND 一条都没有**、`ldd` 说 statically linked，
#         跑出来 `196418` / `999794999321`、rc=0。
#      b. `setjmp`/`longjmp` 是两条新 op（`SETJMP`/`LONGJMP`）—— 要存的是**调用者的**
#         机器状态（rbx/r12-r15/rbp/rsp/返回地址），只有后端知道，与 `SYSCALL` 同一个
#         理由。判据程序（三层深处 longjmp 回来 + 「0 换成 1」）与 glibc **逐行相同**。
#      c. `printf` 的整数/字符串/宽度/对齐与 glibc **逐字节相同**；浮点那三条
#         （`%f %e %g`）17 行的对账里 7 行不同，差的**全在末位**（我们的数字是
#         「归一化 + 逐位取整」抠的，全在 double 上算）。`%f` 印 1e100 那一档只有前
#         25 位有效数字是真的 —— glibc 印的是精确展开，那要大整数。
#      d. `pthread_create` 照 POSIX 回 `EAGAIN`（不崩）—— 运行时本来就有退路
#         （`omni_js_host.c:88`）。第一版在这儿 `abort`，量到的就是 `rc=134`。
#      e. **libm 对账**：13 个函数 × 9 个点（外加 hypot/floor/tanh）共 120 个采样，
#         与 glibc 逐点比，最大相对误差 **2.18e-12** —— 而那一格是
#         `cos(3.14159265358979)`（≈3.2e-15，过零点附近，相对误差没有意义；绝对差
#         是 7e-27）。除它之外都在 1e-15 一档。
#         这一格是**量出来才对的**，中间踩了两次：
#           * `atan(0.5)` 差 1.8e-7 —— 级数只在 |x| ≤ 0.2679 够用，而 0.5 直接进去了。
#             改成半角三次（`x <- x/(1+√(1+x²))`）压到 0.1 以下。
#           * `sqrt(0.5)` 差 4.6e-8 —— 初值的指数按 C 的 `/` 往零截（`-1/2 == 0`），
#             起手相对误差 0.7，而 4 次牛顿只到 4.6e-8。改成 floor 减半 + 6 次。
#      f. **整份编译器在自带 libc 上跑起来了**：交叉编 + 链 -> 72.6M、16 节、8 段
#         （前端 1.2s + 发射 414ms + cc 13.7s），容器里
#           ./omni-self --help                          -> 印出用法，rc=0
#           ./omni-self check tests/cases/01_basics.omni -> `ok … 6 个函数`，rc=0
#         glibc 一个字节都不沾（`ldd` 说 statically linked、`DT_NEEDED` 一条没有）。
#         这一格上一版记的是「跑了 214s 不出 --help，没验上」—— **那是把症状当结论**：
#         根因是我们自己那份 malloc 死循环（整堆线性 first-fit，长堆时那截 slack
#         没有块头，扫到零头 `bsz = 0` 就原地转圈），不是模拟慢。换成「32 个箱的
#         空闲表 + 顶上切」之后同一份二进制立刻出来了。判据搬到了离病根最近的那一层：
#         `tests/c/libc-malloc.js`（本机 0.3s 跑完 20 万块；死循环那一版在那儿是 124）。
#      g. **「系统那一半」与 glibc 逐行相同**（`tests/x64/libc-sys-probe.c`，17 行输出）：
#         fopen/fwrite/fread/ftell/fseek/remove、mkdir/opendir/readdir/rmdir、
#         getenv/setenv、strftime+localtime（只比格式）、system、strerror、sscanf、
#         atexit。跑法（macOS 上交叉编，容器里比）：
#           node src/cli.js c obj tests/x64/libc-sys-probe.c --arch x86_64 --os linux -o /tmp/sp.o
#           node src/cli.js c link /tmp/sp.o -o sp --stdlib --libc self \
#             --sysroot src/sysroot/x86_64-linux -f elf --arch x86_64 --os linux
#           # 容器里：./sp > a.txt; gcc -o ref libc-sys-probe.c && ./ref > b.txt; diff a.txt b.txt
#      h. 探子后来多了一格 `pipe`（`SYSCALL2` 那一片），所以现在是 **15 行输出**，
#         而 `system` 那一行两条腿都真的跑（原先 macOS 上是 `#ifdef __APPLE__` 跳过的）。
#         两边各量了一趟，都是**逐行相同**（`diff` 无输出）、两边 rc=0：
#           x86_64-linux（容器）：`./sp_lin` 与 `gcc` 那份 —— `ldd` 说 statically linked，
#             180477 字节、16 节、8 段
#           arm64-osx（本机，不进容器）：与 Apple 的 libc 那份 —— 127728 字节、13 条加载命令
#         两行新的：`system(true) 状态字: 0`、`pipe 0: 写 7 读 7 「pipe ok」`。
#         macOS 上这两格靠 `SYSCALL2`（`fork` 的 x1 = 是不是子进程、`pipe` 的第二个 fd
#         也在 x1）—— 之前「探子后四行印两遍」的病根就在这儿。
set -euo pipefail

IMAGE="${OMNI_X64_IMAGE:-arch_llvm:latest}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# 默认那一串：三条，从「出的目标文件对不对」一路到「链出来的东西跑不跑」。
DEFAULT_CMD='
set -x
uname -m; uname -s
node src/cli.js c obj tests/c/abi/def.c -o /tmp/d.o
od -An -tx1 -N20 /tmp/d.o
clang -c tests/c/abi/def.c -o /tmp/ref.o
od -An -tx1 -N20 /tmp/ref.o
node src/cli.js c run tests/c/abi/def.c 2>&1 | tail -3 || true
node src/cli.js build bench/fib.omni -o /tmp/fib
/tmp/fib; echo "fib rc=$?"
'

CMD="${1:-$DEFAULT_CMD}"

exec docker run --rm --platform linux/amd64 \
  -v "$ROOT:/omni" -w /omni \
  "$IMAGE" bash -lc "$CMD"
