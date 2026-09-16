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
#   3. **跑起来还差一格**：`/tmp/fib: symbol lookup error: undefined symbol: stdout`
#      —— glibc 的 `stdout` 是**数据符号**，动态链接那一侧要的是 copy 重定位
#      （或者把它当 GLOB_DAT 处理），我们的 ELF 链接器还没有那一格。这是下一刀，
#      有名有姓地记在这儿。
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
