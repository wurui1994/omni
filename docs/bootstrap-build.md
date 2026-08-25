# 自举构建（`omni bootstrap`）

自举是编译器的**内置命令**，不是维护者的手艺活。一条命令跑完整条链、验完四条门槛、
把产物摆成一棵可安装的目录树。

```bash
npm run build:self          # = node stage0/src/cli.js bootstrap -o dist
node stage0/src/cli.js bootstrap -q        # 只跑 JS 侧不动点（秒级），跳过 C 路径
node stage0/src/cli.js bootstrap -o out/x  # 换个产物目录
dist/src/host/omni bootstrap stage0/src/cli.js   # 原生编译器也能执行同一条链
```

每一步都报墙上时间（`[12.4s]`），末尾报总时长。自举是分钟级的操作，"卡在哪一步"必须一眼
看得出来；计的是墙上时间而不是 CPU 时间，因为大头是 clang 与另一代编译器这些子进程：

```
  ok   layout dist  lib 1 files, runtime 23 files  [8ms]
  ok   C1 = emit-js cli.js  1746006 bytes -> dist/src/host/omni.mjs  [213ms]
  ok   fixpoint C1 == C2  40470 lines  [3.1s]
  ok   N1 = clang(emit-c cli.js) -> dist/src/host/omni  [12.4s]
  ok   fixpoint N1 emit-c cli.js == C0  2991702 bytes  [1.3s]
  ok   fixpoint N1 emit-js cli.js == C0  1746006 bytes  [1.3s]
  ok   N2 = N1 build cli.js -> dist/build/omni-n2  [12.0s]
  ok   fixpoint N1 emit-c == N2  2991702 bytes  [2.1s]
  ok   fixpoint N1 emit-js == N2  1746006 bytes  [1.8s]

9 passed, 0 failed  in 34.5s
```

## 产物

```
dist/src/host/omni.mjs   C1 —— 纯 JS 的永久兼容层（node dist/src/host/omni.mjs run f.omni）
dist/src/host/omni       N1 —— 原生编译器
dist/lib/                std（json.omni …）
dist/runtime/            C 运行时的 .c/.h（build 时要 -I 它）
dist/build/              中间产物：omni.c、c2.mjs、omni-n2、omni-n2.c
```

中间产物**不进临时目录**：链断在哪一代都要能直接翻出那份 C 或那份 JS 来 diff，而不是去
`/var/folders` 里捞一个随机名字的目录。`omni build` 因此收 `--work DIR`（生成的 C 留在
`DIR/<产物名>.c`），`bootstrap` 把每一代都指到 `dist/build`。

**布局不能改。** `installDir()` 是"运行中的程序镜像所在目录"（JS 侧是脚本所在目录，
C 侧是可执行文件所在目录），而 std 与 runtime 都相对它**固定两级上去**：

- `stage0/src/module/load.js`：`LIB_DIR = installDir()/../../lib`
- `stage0/src/runtime/c_runtime.js`：`RUNTIME_DIR = installDir()/../../runtime`

所以编译器必须待在 `<根>/src/host/` 下。把它直接扔在 `dist/` 里，它会去 `/lib` 和
`/runtime` 找东西，报的是 `no such module: 'std/json.omni'` 或
`ENOENT: cannot read directory '/runtime'` —— 那是布局错，不是编译器错。
产物里的 `lib/` 与 `runtime/` 是**复制**而不是符号链接，打包带走不会断。

产物树里没有编译器源码（那是 `stage0/`），所以让产物里的 N1 再跑一遍自举时要**显式给出源
文件**：默认值是 `installDir()/../cli.js`，在 `dist/` 里不存在，命令会直接说清这一点。

## 四条门槛

`bootstrap` 的每一项都是硬门槛，任何一项不成立就非零退出：

1. **`C1 == C2`** —— C1 再编译一次自己，输出与 C1 逐字节相同。JS 侧的不动点，说明 C1 是个
   与 C0 语义等价的编译器。
2. **`N1 emit-c == C0`** —— 原生编译器产出的 C 与 node 上的逐字节相同。
3. **`N1 emit-js == C0`** —— 同上，JS 侧。
4. **`N2 的产出 == N1 的`** —— N1 编译出下一代原生编译器 N2，两代的产出逐字节相同。
   这才是 ADR-0001 说的 stage2：不只是"N1 输出对"，而是"N1 能造出和自己等价的下一代"。

判据是**编译器的输出**，不是二进制镜像。链接每次都会写进新的 `LC_UUID`，macOS 还会对整个
镜像做 ad-hoc 签名，所以 `cmp` 两个原生二进制**必然不同**（实测同尺寸、13385 字节有差异）。
那不是自举失败。

`-q`（`--quick`）只跑第 1 条：它不需要 C 编译器，秒级完成，适合改完一行想马上确认没破坏
不动点的场合。

没有 JS 引擎（原生编译器在一台没有 node 的机器上）时第 1 条会**跳过并明说**，
而不是当成通过 —— 那台机器上这件事根本无从验证。用 `OMNI_NODE` 指定引擎路径。

## 链条的形状

```
C0 = node stage0/src/cli.js          手写的 JS 编译器（唯一的信任根）
  ├─ emit-js 自己 ──▶ C1 ──emit-js 自己──▶ C2      要求 C1 == C2
  └─ emit-c  自己 ──cc──▶ N1 ──build 自己──▶ N2     要求 N1 与 N2 的产出相同
```

注意 C0 读自己源码走的是**JS 语法前端**（ADR-0001：不用 Omni 语法重写编译器）。所以这条链
同时证明了三件事在编译器自己身上一致：JS 前端、类型检查、两个后端。

## 相关

- 决策与理由：`docs/adr/0001-bootstrap-strategy.md`
- JS → OIR 的降级：`docs/adr/0011-js-lowering.md`
- 实现：`stage0/src/bootstrap.js`（命令）、`stage0/src/cli.js`（`bootstrap` 分支）
- 测试轴：`tests/bootstrap/run.js`（逐用例 `C0 == C1` 之外，第 5 阶段直接调这个命令）
- C 编译器：默认按 tcc → clang → gcc → cc 找第一个可用的，`OMNI_CC` 可覆盖。
  开发期想要毫秒级编译就装 tcc；本机没有 bottle，实测走的是 clang `-O2`。
