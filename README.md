# Omni

Omni 是一个**语言平台**。它不替你选语言，也不要求你的语言先变成它 —— 它提供一层可对接的
契约，让不同语言的程序落在同一套中间表示上，从此共享同一批优化、同一批后端、同一套工具。
愿景是**融合**：把散在各门语言里的东西（语法、类型、内存模型、并发、代码生成）变成可以
拆开重组的部件，而不是再造一门要求所有人迁移的新语言。远期目标是把这层契约做成一台
**形式化引擎** —— 程序的意义用可检查的形式写下来，翻译、优化、发码都是它上面可验证的变换，
而不是一堆互相信任的字符串处理。

## 哲学

> 常见做法是"你变成我"。omni 是"你不必变成我，我们找一层能对接的契约"。
>
> 每个元素单独都常见，因为每个元素单独看都是"一种统一路径"。
> 组合起来奇怪，因为 omni 把它们从"统一路径"改成了"可选契约层"。
>
> 他们不是在想"怎么统一所有语言"。
> 他们在想"怎么让所有语言在不统一的前提下，仍然能互相用"。
>
> 这就是"全部"这个词的真正含义：不是"所有人都一样"，而是"所有人都能连上"。

## 三十秒上手

只要 **Node ≥ 20**，没有构建步骤，改一行即刻生效。

```bash
node src/cli.js run   x.go              # 一条命令：源码 → 核心方言 → IR → 原生，跑掉
node src/cli.js build x.go -o prog      # 出一个自足的二进制（自带代码生成与链接器）
node src/cli.js run   x.c               # C：自带预处理 + 发码 + 汇编 + 链接
node src/cli.js run   x.asy -f svg      # Asymptote：出图
node src/cli.js emit  c x.go            # 看任一中间形态：ast|oir|mir|sx|asy|js|c|llvm|spirv
node src/cli.js --help                  # 命令树，每一级都有自己的 --help
```

**前端由扩展名选，后端由 `--backend` 选。** 同一份源码可以落到多条腿上，而它们的输出
必须一致（解释器 / JS / C / LLVM / 原生）—— 那是判据，不是愿望。上手细节在
[`docs/guide.md`](docs/guide.md)。

## 现在能连上什么

- **自带前端**：Omni 主语言（`.omni/.omnid/.omnis` 三种类型模式）、核心方言 `.sx`、
  C、JS 子集、WebAssembly 文本、Jancy、Asymptote、GLSL 片元着色器。
- **借语法接进来的**（`ext/` 下 11 格登记）：Go、Nim、V、Lua（含 gsl-shell 方言）、
  C++ 子集、Scheme、Common Lisp、awk、FreeBASIC、Mojo。其中 `.go` / `.nim` / `.v`
  已经接在主路上，与 `.c` 同一条规矩，一条命令到二进制
  （[ADR-0041](docs/adr/0041-one-pipeline-per-source.md)）。
- **后端**：解释器、JavaScript、C 源码、LLVM IR、原生（arm64 / x86-64，自带
  ELF / Mach-O / PE 链接器）、SPIR-V、wasm。

## 每一格都有一把外面的尺子

这棵树里的"通了"都不是自我声明，而是与一条互不相干的已有实现对账：

- **Go**：28 份端到端例子的输出与官方 `go run` **逐字节相同**；六份基准与 `go build`
  出来的二进制同机对比在 0.85x–1.81x（`node tests/go/run.js`、`node bench/go/run.js`）。
- **C**：预处理结果与 tcc 逐字节相同，目标文件字节相同（`node tests/c/run.js`）。
- **Asymptote**：与真 asy 出的 EPS 对账。**GLSL**：照 llvmpipe。
- **自举**：编译器编自己，两趟产物逐字节相同（`npm run fix:self`）。
- **跨腿一致**：同一个程序在解释器 / JS / C / LLVM / 原生上输出必须一样。

```bash
node tests/all.js            # 全部（一条红了也继续往下跑）
node tests/all.js go sexpr   # 只跑名字里含这些词的
```

## 状态

**早期。** 能跑的不少，没定的更多 —— 主语言的表层语法还在动，标准库几乎是空的，
形式化那一层还只是方向。这份仓库现在的价值在**已经量过的那些结论**：每个决定、它的代价、
以及"为什么不是另一种做法"，都带着当时量出来的数字记在 ADR 里。

还没定：包名与发布方式、主语言的最终语法、标准库边界、`dynamic` 与静态类型的交界细节。
别照现在的样子写依赖它们的代码。

## 文档入口

- [`docs/guide.md`](docs/guide.md) —— 怎么用：三条动词、各语言一分钟、常用开关
- [`PLAN.md`](PLAN.md) —— 总体规划与自举路线
- [`docs/adr/`](docs/adr/) —— 决策记录（**想知道"为什么这样"先看这里**）
- [`docs/design/`](docs/design/) —— 单点设计：契约、类型覆盖层、映射 DSL、核心方言
- [`docs/EXTENSIONS.md`](docs/EXTENSIONS.md) —— 扩展约定：一门语言怎么自述、注册、被按需装载
- [`docs/design/node-graph-contract.md`](docs/design/node-graph-contract.md) —— 借来的语言映到哪一层契约上（映射现在是手写的 `ext/<lang>/tograph.js`；DSL 化还是提案）
- [`docs/bootstrap-build.md`](docs/bootstrap-build.md) · [`docs/bootstrap-subset.md`](docs/bootstrap-subset.md) —— 自举链与它吃的子集

## 目录

```
src/cli.js      入口（薄的：驱动在 src/core/cli.js）
src/core/       编译器：frontend-*（各语言前端）、sexpr（核心方言）、hir/mir（IR）、
                backend-*（js/c/llvm/spirv）、interp（解释器）、link + x64/arm64（汇编与链接）
ext/<lang>/     借进来的语言：一份语法 + 一份映射（Go / Nim / V / Lua / C++ …）
src/lib/        随编译器发的库；src/runtime/ C 运行时；src/jit/ GLSL 的 JIT 宿主
tests/          每门语言 / 每条腿一个套件；bench/ 性能尺子
```

## 许可证

[MIT](LICENSE)。
