# Omni

跨语言解析 / 多后端编译架构。**一份前端 → 统一 IR → 多条腿执行**：解释器、JavaScript、C 源码、LLVM、原生目标文件与链接器（自带 ELF/Mach-O/PE），GPU 那条走 SPIR-V。

现在的实现是 **stage0：纯 JavaScript，零构建步骤**（改一行即刻生效，`node src/cli.js` 就能跑）。
往后自举到 Omni 自身，而生成的那份 JS 永久留着当兼容层。总体规划在 [`PLAN.md`](PLAN.md)，
每个决定与它的代价在 [`docs/adr/`](docs/adr/)。

## 状态

**早期。** 能跑的东西不少，没定的东西更多 —— 语言的表层语法还在动，标准库几乎是空的，
自举那条链的最后一道门还红着。这份仓库现在的价值在**已经量过的那些结论**（ADR 里那一条条
「为什么这样、代价是什么、指纹长什么样」），而不是一个能装的编译器。

## 现在能做什么

```bash
node src/cli.js run  x.omni          # 编译并执行（默认在 node 宿主里编成 JS 跑）
node src/cli.js run  x.c             # C：自带前端 + 代码生成 + 链接器，编完就跑
node src/cli.js run  x.asy -f svg    # Asymptote：出图（EPS / SVG）
node src/cli.js run  x.frag -o o.png # GLSL 片元着色器：软件光栅，渲一帧
node src/cli.js emit c x.omni        # 看某个中间/目标形态：ast|oir|mir|sx|asy|js|c|llvm|spirv
node src/cli.js --help               # 命令树；每一级都有自己的 --help
```

前端**由扩展名选**：`.omni`/`.omnid`/`.omnis`、`.js`、`.wat`、`.sx`/`.asy`、`.jnc`、`.c`、`.frag`/`.glsl`。
后端由 `--backend` 选。上手细节见 [`docs/guide.md`](docs/guide.md)。

`run` 有一格墙上时限：默认 **30 秒**，到点印一句话就中止（`--timeout SEC` 改，`--timeout 0` 撤掉）。
跑得久的例子（重的 asy 图）记得显式放宽。

## 两条纪律

这两条决定了这棵树长什么样，值得写在最前面：

1. **每一格都有一把外面的尺子。** C 那一侧比的是 tcc（预处理逐字节相同、目标文件字节相同）、
   asy 比的是真 asy 的 EPS、GLSL 照着 llvmpipe、JS 那条腿有另一份实现当 oracle。
   「五条腿同一句话」是常态判据 —— 同一个程序在解释器 / JS / C / LLVM / 原生上输出必须一致。
2. **实现层不用编译慢的语言。** 没有 C++/Rust，没有 bundler，没有生成步骤。
   类型检查是 `tsc --noEmit` 当 linter 跑（不写 `.ts`），LLVM 只作为**后端之一**存在，
   不是语言实现的依赖。

## 跑测试

```bash
node tests/all.js            # 全部（一条红了也继续往下跑）
node tests/all.js glsl sexpr # 只跑名字里含这些词的
npm run lint                 # tsc --noEmit，当 linter 用
```

需要 Node ≥ 20。C / LLVM / GLSL 那几条腿要机器上有 `cc`、`llvm-config`（`OMNI_CC`、
`OMNI_CLANG`、`OMNI_LLVM_CONFIG` 可以指定），没有的套件会自己跳过。

## 目录

```
src/cli.js      入口（薄的：驱动在 src/core/cli.js）
src/core/       编译器：frontend-*（各语言前端）、sexpr（核心方言）、hir/mir（IR）、
                backend-*（js/c/llvm/spirv）、interp（解释器）、link + x64/arm64（汇编与链接）
src/lib/        随编译器发的库（asy 的那一套在这儿）
src/runtime/    C 运行时；src/jit/ GLSL 的 JIT 宿主
tests/          每门语言 / 每条腿一个套件
docs/adr/       决策记录 —— 想知道「为什么」先看这里
docs/guide.md   上手与常用命令
PLAN.md         总体计划
```

## 还没定的

包名与发布方式、语言的最终表层语法、标准库的边界、`dynamic` 与静态类型的交界处
细节 —— 这些都还在 ADR 里讨论，别照现在的样子写依赖它们的代码。

## 许可证

[MIT](LICENSE)。
