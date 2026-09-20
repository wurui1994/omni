# Omni

Omni 是一个语言平台。语法归语言自己，执行归平台，中间用一层契约接住。一门语言接上这层契约，
写出来的程序就能被解释着跑、编成 JavaScript、编成 C、编成一个自足的原生二进制 —— 复用的是
同一套代码生成器、同一条优化管线、同一个链接器。

接上的成本有多大，这棵树里有现成的数：Scheme 是 153 行语法加 232 行映射，Common Lisp 是
125 加 279。Go 那种体量的语言映射要 3780 行 —— 成本跟着语言的复杂度走，不跟着平台走。
已经这样接进来 11 门，目前大部分只支持了基本语法和特性：Go、Nim、V、Lua、C++ 子集、Scheme、Common Lisp、awk、FreeBASIC、Mojo。
所以"发明一门自己的语言"在这里不是一个项目，是一个下午。

不要求谁变成谁，是故意的。让所有人改用同一门语言这件事，历史上试过很多次，每次的结果都是
世界上又多了一门语言。Omni 赌的是另一边：各自留着自己的样子，但都能连上。

愿景是融合。语法、类型、内存模型、并发、发码，这些能力现在被各门语言分别锁在自己院子里；
把它们拆成能重新拼的部件，比再造第十二门语言有意思。

远期是一台形式化引擎：程序的意思用可检查的形式写下来，翻译、优化、发码都变成那上面能验证的
变换，而不是一串互相信任的字符串处理。这一步还远，但每一格判据都是照那个方向挑的。

## 能用它做什么

- **发明一门语言。** 语法一份、映射一份，后面那一整条链（IR、优化、各条后端、调试与性能
  工具）白得。从 `ext/chez/` 抄起，那是这里最小的一门。
- **让语言之间互相借东西。** 一份源码里可以用 `#lang` 切到另一门语言的读法；主语言本身就是
  这么长出来的（语法骨架借 Asymptote 与 Jancy，UFCS 借 Nim）。借的是语法与语义，不是复制
  一份运行时（[ADR-0037](docs/adr/0037-lang-directive-and-cross-language-borrowing.md)）。
- **一条命令把源码变成二进制，机器上什么都不用装。** C 前端、汇编器、ELF/Mach-O/PE
  链接器都在这棵树里，只要一个 Node —— 没有外部编译器，没有链接器依赖。
- **把语言剖开看。** `emit ast|oir|mir|sx|c|llvm|spirv` 印出每一层中间形态，`-v` 印出每一步
  的毫秒数。"我这行代码最后变成了什么"，一条命令就看得见。
- **AI 在这棵树上改东西，能自己验。** 零构建步骤，改一行即刻生效；每一步都能单独印出来；
  每条结论都对应一条可复跑的命令；报错是一句人话，不是栈回溯。

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

只要 **Node ≥ 20**。没有构建步骤，改一行即刻生效。

```bash
node src/cli.js run   x.go              # 跑一份 Go 源码（机器上不用装 go）
node src/cli.js build x.go -o prog      # 变成一个自足的二进制（不借外部编译器与链接器）
node src/cli.js run   x.c               # C 也一样：预处理、发码、汇编、链接全在树里
node src/cli.js run   x.asy -f svg      # 画张图（Asymptote）
node src/cli.js emit  c x.go            # 剖开看：ast|oir|mir|sx|asy|js|c|llvm|spirv
node src/cli.js --help                  # 命令树，每一级都有自己的 --help
```

**前端由扩展名选，后端由 `--backend` 选。** 同一份源码可以落到多条腿上，而它们的输出必须
一致（解释器 / JS / C / LLVM / 原生）—— 那是判据，不是愿望。

想加一门自己的语言：`ext/chez/` 是最小的样板，约定写在
[`docs/EXTENSIONS.md`](docs/EXTENSIONS.md)，上手命令在 [`docs/guide.md`](docs/guide.md)。

## 现在能连上什么

- **自带前端**：Omni 主语言（`.omni/.omnid/.omnis` 三种类型模式）、核心方言 `.sx`、
  C、JS 子集、WebAssembly 文本、Jancy、Asymptote、GLSL 片元着色器。
- **借语法接进来的**（`ext/` 下 11 格登记）：Go、Nim、V、Lua（含 gsl-shell 方言）、
  C++ 子集、Scheme、Common Lisp、awk、FreeBASIC、Mojo。**都按后缀走主路**，
  一条命令到二进制（[ADR-0041](docs/adr/0041-one-pipeline-per-source.md)）；
  `.lua` 有一台更全的自带读入器，所以仍归那一条。
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
