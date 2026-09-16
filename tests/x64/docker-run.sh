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
# 量到的（2026-09-16，Docker Desktop on Apple Silicon，amd64 靠模拟跑）：
#   1. `omni c obj tests/c/abi/def.c` -> **ELF x86_64 可重定位**（`7f 45 4c 46 02 01 01`
#      … `01 00 3e 00`），头 20 字节与本机 clang 出的 `.o` 逐字节相同。
#      改之前这一步出的是 Mach-O arm64 —— 本机 clang / ld 一个都不认。
#   2. `omni build bench/fib.omni` -> 编得过、链得出：2.1M、18 节、8 段、入口 0x4feb50
#      （前端 16ms + 发射 14ms + cc 2.6s，via self -O0）。
#   3. **跑起来还差一格**，三笔账按顺序还了两笔（每还一笔就往前挪一个符号）：
#      a. `undefined symbol: stdout` —— 链的时候一个共享库都没交进去（`cDefaultLibs`
#         在非 macOS 上回空表），于是 `elf_exe.js` 那段 copy 重定位的前提
#         「库里找得着这个名字」不成立。**已还**：带上 `libc.so.6` 的真身
#         （不走 `-lc`：glibc 的 `/usr/lib/libc.so` 是一份 ld 脚本，我们不解析）。
#      b. `elf: 找不到 'fmod'` —— 数学那几个符号在这台机器上只从 `libm.so.6` 露出来。
#         **已还**：存在就一起带上。
#      c. `elf: 找不到 'atexit'` —— **还欠着，而且欠的是一格能力**。证据（容器里
#         `llvm-nm -D --defined-only /usr/lib/libc.so.6`）：`stdout` 在（`D`，数据符号，
#         `@@GLIBC_2.2.5`），`atexit` 与 `fmod` **都不在**。`fmod` 从 `libm.so.6` 补上了；
#         `atexit` 只住在 `/usr/lib/libc_nonshared.a`（7266 字节，那份 ld 脚本
#         `GROUP` 的第二项）。而 `elf-link` 那一格**只收 `.o` 与 `--dll`，不收静态库**
#         （`macho-link` 那一侧早有 `archives`）。所以下一刀是「给 ELF 链接器接静态库」，
#         不是再补一个库名。
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
/tmp/fib || echo "（跑挂了 —— 见文件头第 3 条账）"
'

CMD="${1:-$DEFAULT_CMD}"

exec docker run --rm --platform linux/amd64 \
  -v "$ROOT:/omni" -w /omni \
  "$IMAGE" bash -lc "$CMD"
