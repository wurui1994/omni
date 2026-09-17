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
