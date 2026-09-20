# ADR-0041 一份源码一条路：`.go` / `.nim` / `.v` 就是这条链的前端

日期 2026-09-21 · 状态 已落地

## 事实（先说量出来的）

`omni run -v --engine graph pt.go` 走的是**解释器**：`graph/run.js:466` 的默认后端是
`interp`，也就是 `eval.js`。`--backend core` 也不往下走 —— `backend-core.js` 的 `runCore`
出了 `.sx` 文本之后当场 `interpret(mod)`（OIR 解释器）。`--backend c` 是另一套语义
（一个 16 字节的 `gv`、全动态），交给我们自己那台 C 前端读成 MIR 再跑。

也就是说：**命令行上没有一条路能从 `.go` 走到二进制**。真正在用的那条只存在于
`bench/go/run.js` 里的两条命令：

    omni build --engine graph --lang go --backend core pt.go -o pt.sx
    omni build pt.sx -o pt

后一条属于另一台引擎（lower -> OIR -> MIR -> arm64 + 自己的链接器）。这条线没有名字、
没有帮助、没有判据 —— 只有手敲。

## 决定

`.go` / `.nim` / `.v` 与 `.c` **同一条规矩：前端按扩展名选**。`cli.js` 在动词分派之前把
这几种源码译成核心方言（`coreSxText`），落到 `.omni-cache/src-sx/<内容哈希>/x.sx`，
再把 `path` 换成那份 `.sx` —— 下游一个字都不改。

于是这些全都白得，因为它们本来就长在 `.sx` 那条输入上：

    omni run  bench/go/fib.go
    omni build bench/go/pt.go -o pt        # 原生，一条命令
    omni emit c bench/go/pt.go
    --backend / --cc / --profile / OMNI_MIR_OPT / 摇树 / 增量暖存

`--engine graph` 保持原样：那是**点名要另一层的后端**（interp / js / wat / c / sx），
它们各有自己的判据（`tests/graph/run.js` 的语言 × 后端矩阵）。

## 为什么不是别的两种做法

- **给图那一层加一格 `native` 后端**：那会让"从源码到二进制"有两份实现（一份在
  contract 的 `lower` 里、一份在 cli 的 `case 'build'` 里），而后者已经带着 `--cc`、
  交叉编译、暖存、profile 全套。多一格后端只是把同一件事抄第二遍。
- **在 bench 脚本里留着两步**：那等于尺子量的是用户量不到的东西。已经删掉
  （`bench/go/run.js`）。

## 判据

- `omni build bench/go/pt.go -o pt` 出二进制，输出与 `go run` 相同（`938480769`；
  go 的 `println` 写 stderr，两边都要合流取）。
- `node bench/go/run.js` 六份全过，答案先验再计时（fib ×1.19 / loop ×0.85 /
  pt ×1.81 / raytrace ×1.20 / slice ×1.62 / vec ×1.43，与两步手动路径同一档）。
- `node tests/go/run.js` 28/28 与 `go run` 逐字节相同（这套仍走 `--engine graph`，
  因为它比的是前端那一层）。
- `npm run check:self` 绿。

## 顺带记下来的两笔账

- **图那条 c 腿的真闭包没做**（`__box_T__I` 抓着 `__self` 那一格）。它与这条路无关：
  那是另一套动态语义的腿，pt 的原生性能不从那儿来。半成品在 `git stash`
  （"graph c 后端的真闭包"）。
- 往模板串里写反引号会把宿主文件切开 —— 这一次在 `backend-c.js` 与 `cmds.js` 上
  各踩一遍（`SyntaxError: Unexpected identifier` / `Invalid left-hand side`）。
