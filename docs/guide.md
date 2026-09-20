# Omni 上手

这份是**怎么用**。为什么这么设计、代价是什么，在 [`adr/`](adr/)；总体规划在 [`../PLAN.md`](../PLAN.md)。

下面每条命令都是在这棵树上真跑过的。仓库根目录执行，`node src/cli.js` 就是入口
（`npm run omni -- …` 等价）。

## 0. 要什么

- **Node ≥ 20**。编译器本身**只要它** —— 纯 JS，没有构建步骤，改一行即刻生效。
- 可选：`cc`/`clang`（原生那几条腿与 C 前端的链接）、`llvm-config`（LLVM 后端、GLSL 的 JIT 宿主）。
  用 `OMNI_CC` / `OMNI_CLANG` / `OMNI_LLVM_CONFIG` 指定具体路径；没有的套件会自己跳过。
- 可选：真 `asy`（Asymptote）—— 只有 asy 那条对账门要它当 oracle。

## 1. 三条动词，一张表

```
omni run   FILE     编译并执行
omni build FILE -o A  出产物
omni emit  FORM FILE  印中间/目标形态：ast|oir|mir|sx|asy|js|c|llvm|spirv
omni check FILE     只走前端与检查器
```

**前端由扩展名选**，后端由 `--backend` 选：

- `.omni` / `.omnid` / `.omnis` —— 主语言，三种类型模式（mixed / dynamic / static，ADR-0008）
- `.sx` —— 核心方言（s-expr）。它是各前端的**汇聚层**，也是最省事的手写目标
- `.asy` —— Asymptote（出 EPS / SVG）
- `.js` —— JS 子集
- `.wat` —— WebAssembly 文本
- `.jnc` —— Jancy（C 兼容 ABI、指针）
- `.c` —— C（自带预处理 + 代码生成 + 汇编器 + 链接器）
- `.frag` / `.glsl` —— GLSL 片元着色器（软件光栅）
- `.go` / `.nim` / `.v` —— **借来的语言，接在主路上**（ADR-0041）：它们与 `.c` 同一条规矩，
  译成核心方言之后走的就是上面那条路，所以 `--backend` / `--cc` / `--profile` 全都照旧

`--mode` 覆盖类型模式，`--lang` 覆盖前端。

## 2. 各语言一分钟

### 主语言与核心方言

```bash
echo 'print("hi");'                        > /tmp/a.omni
echo '(module (main (print (str "hi"))))'  > /tmp/a.sx

node src/cli.js run /tmp/a.omni                    # 默认：编成 JS，在本进程里跑
node src/cli.js run /tmp/a.omni --backend interp   # 自己的解释器
node src/cli.js run /tmp/a.omni --backend c        # 发 C，cc 编，跑
node src/cli.js run /tmp/a.omni --backend llvm     # 发 LLVM IR，跑
node src/cli.js build /tmp/a.omni -o /tmp/a && /tmp/a
node src/cli.js run /tmp/a.sx                      # 方言直接跑
```

**同一个程序在这几条腿上输出必须一样** —— `tests/sexpr` 那一轴就是拿这件事当判据的
（"五方一致"）。写新特性时这是第一道门。

### C

```bash
node src/cli.js run /tmp/a.c              # 编 + 链 + 跑（自带链接器）
node src/cli.js run /tmp/a.c --backend js # C → MIR → JS 源码，node 宿主上最快的那条
node src/cli.js c run /tmp/a.c            # 同上，退出码就是 C main 的返回值
node src/cli.js c cpp /tmp/a.c            # 只预处理（与 tcc -E -P 逐字节相同）
node src/cli.js c obj /tmp/a.c -o /tmp/a.o
node src/cli.js c link /tmp/a.o -o /tmp/a -f macho   # elf | macho | pe
node src/cli.js c tcc  -c /tmp/a.c -o /tmp/a.o       # 与 tcc 同一套开关的驱动
```

`-D` / `-U` / `-isystem` / `-include` **只在 `omni c` 这一组里** —— 它们是 C 的事实，
不该出现在与语言无关的顶层。尺子是 tcc：`omni c --help` 里每一条都写着与它比什么。

### Asymptote

```bash
node src/cli.js run /tmp/fig.asy                  # 图印到 stdout（EPS）
node src/cli.js run /tmp/fig.asy -f svg           # 印 SVG
node src/cli.js run /tmp/fig.asy -o /tmp/fig.svg  # 格式按后缀猜，图落到文件
```

格式与落地文件是**运行期的一格宿主设置**（ADR-0015）：产物缓存的印记里没有它们，
换个格式再跑不会重编。程序自己 `write(...)` 的字仍走 stdout —— 图进文件、文字进终端。

引真 asy 的 `base/*.asy` 时用 `ASYMPTOTE_DIR` 指它的 base 目录。

### GLSL

```bash
node src/cli.js run /tmp/s.frag -o /tmp/s.png --size 512 \
     --set u_resolution=512,512
```

一帧一张 PNG，所以 `-o` 是必给的。`--set NAME=v,v` 给 uniform（可重复，没给的按 0）。
两条腿：**快路**是 GLSL → LLVM IR（8 道 SoA，照 llvmpipe 的 `lp_exec_mask`）在 JIT 宿主里渲；
**参考腿**是 GLSL → 核心方言 → 那五条腿，一个像素一趟。两边的像素在门里是对齐的。

### 借来的语言（Go / Nim / V / Lua / C++ …）

一份语法 + 一份映射就接进来一门（`ext/<lang>/`，怎么加见 [`EXTENSIONS.md`](EXTENSIONS.md)）。
`.go` / `.nim` / `.v` 已经接在主路上 —— 不用给 `--engine`，和 `.c` 一样按后缀选前端：

```bash
node src/cli.js run   bench/go/fib.go              # 跑掉
node src/cli.js build bench/go/pt.go -o /tmp/pt    # 原生二进制，一条命令
OMNI_MIR_OPT=1 node src/cli.js build x.go -o out   # 带公共优化管线（ADR-0039）
node src/cli.js emit c ext/nim/examples/intmath.nim # 看生成的 C
```

中间那份核心方言落在 `.omni-cache/src-sx/<内容哈希>/`，改一个字就换一格目录。

其余那几门（Lua / C++ / Scheme / Common Lisp / awk / FreeBASIC / Mojo）现在还走
`--engine graph`，那一层有自己的后端名单（interp / js / wat / c / sx）：

```bash
node src/cli.js run ext/lua/examples/basics.lua --engine graph
node src/cli.js run ext/cpp/examples/basics.cpp --engine graph --backend wat
```

### 其余

```bash
node src/cli.js run tests/wat/cases/01-numeric.wat
node src/cli.js run tests/jnc/cases/01-pointers.jnc
node src/cli.js run /tmp/a.js
```

## 3. 看里面发生了什么

```bash
node src/cli.js emit oir /tmp/a.omni        # 中间形态：ast|oir|mir|sx|asy|js|c|llvm|spirv
node src/cli.js emit c   /tmp/a.omni --explain   # 只印管线，不动手
node src/cli.js run /tmp/a.omni -v          # 每一步与它的耗时（走 stderr）
```

`--explain` 印的是一张管线表，比如：

```
pipeline  c → cpp → MIR → arm64 → MACHO(.o)
  1  front  read     a.c
  2  front  cpp      text              -> tokens
  3  mid    lower    tokens            -> MIR               native：没有线性内存，地址就是真地址
  4  back   codegen  MIR               -> arm64
  5  back   write    arm64 + 数据三段  -> Mach-O MH_OBJECT   a.o
```

它现在**还不覆盖 `run` / `build`**：那两条是边走边决定的（`.asy` 命中缓存就一步前端都不走）。
真想看那两条走了什么，用 `-v`。

## 4. 交互、增量、自举

```bash
node src/cli.js repl --lang omni --engine js   # --lang omni|sx|asy|js；--engine interp|js
node src/cli.js incr FILE --list               # 过内容寻址的缓存一个函数一个函数地编，印命中/未命中
node src/cli.js bootstrap -o dist              # 建整条自举链并查四条不动点（现在最后一道门还红着）
```

缓存都在 `.omni-cache/` 下（按内容寻址，删掉只影响速度不影响结果）：
`asy-ast/` 与 `asy-mods/` 是 asy 那两级（AST 与每个源文件一份 ESM）、`incr/` 函数级、
`glr/` 解析表、`glsl-host/` 与 `jit/` 是 JIT 宿主、`rt/` 运行时对象、`test/` 门留下的现场。

自举那条链本身有专门一份：[`bootstrap-build.md`](bootstrap-build.md)（四条门槛与产物长什么样）。

## 5. 跑测试

```bash
node tests/all.js                # 全部套件（一条红了也继续往下跑，最后一张表是结论）
node tests/all.js glsl sexpr     # 只跑名字里含这些词的
node tests/sexpr/run.js          # 单支：每个目录一个 run.js
node tests/sexpr/run.js 19       # 多数套件收「只跑名字含这个的用例」
npm run lint                     # tsc --noEmit（不进构建路径，只当 linter）
```

套件与它盯的东西：

- `tests/run.js`（core）、`oir`、`js-exec`、`js-roundtrip` —— 主语言与 JS 那条腿
- `sexpr` —— 核心方言，**五条腿逐字节一致**
- `c` —— C 前端；oracle 是 tcc。`cabi`、`x64`/`arm64`（在 `c` 里）、`llvm`、`jit`
- `asy` —— 与真 asy 的 EPS 对账（`eps.js`）、SVG 那一轴（`svg.js`）
- `glsl` —— 17 组：解析/检查/降级/光栅/快路/vispy 语料
- `jnc`、`wat`、`glr`、`mir`、`incr`、`gpu`、`bootstrap`
- `oracle` —— 拿外面的实现当参照的那一批

有些套件认环境变量：`OMNI_VISPY` 指 vispy 的 glsl 目录、`ASYMPTOTE_DIR` 指真 asy 的 base、
`OMNI_LEGS=all` 让 asy 那一轴跑齐五条腿。

## 6. 读代码的路线

```
src/cli.js              入口（薄）
src/core/cli.js         驱动：命令树 → 管线（ADR-0018）
src/core/parse/         主语言的手写解析器
src/core/hir/           检查 + OIR
src/core/sexpr/         核心方言（汇聚层）—— 想加一个新前端，先看这里
src/core/mir/           C 那一路的 IR（不经过 OIR）+ MIR → JS
src/core/backend-{js,c,llvm,spirv}/
src/core/interp/        解释器
src/core/link/ + x64/ + arm64/   汇编器与 ELF/Mach-O/PE
src/core/frontend-{js,c,asy,jnc,wat,glsl}/
src/core/glr/           GLR 解析器（asy 与 glsl 的语法用它）
src/core/host/          与宿主打交道的那一层（封闭 ABI，ADR-0011）
```

**加一门语言**的最短路径：写一份语法（`*.grammar`，GLR）或手写解析器 → 降到核心方言文本
（`emit sx` 能看）→ 剩下五条腿全都免费。asy 与 GLSL 都是这么接上去的。

**改动的纪律**（这棵树上到处是这条）：一格特性配一把外面的尺子，或者至少配一条"五条腿
输出相同"的门。所有 ADR 里的"量出来的"都是这个意思 —— 不是猜的。

## 7. 常见坑

- **找不到 `llvm-config`**：brew 装的 llvm 是 keg-only，不在 PATH 上。`OMNI_LLVM_CONFIG` 指过去。
- **asy 的例子报找不到文件**：那些例子引真 asy 的 `base/`，要 `ASYMPTOTE_DIR`。
- **`tests/all.js` 里 `bootstrap/run.js` 是红的**：自举那条链的最后一道门还没过，
  旁边的 `bootstrap/ratchet.js` 是棘轮（新长的债会让它红，旧债不会）。
- **`tests/mir` 里 `lower/cli.js` 是红的**：编译器自己还有几处**不在自举子集里**
  （`>>>`、accessor 那一族）。子集的定义与它的闸门在
  [`js-bootstrap-subset.md`](js-bootstrap-subset.md) —— 往里加特性要走 ADR。
- **改了 `.omni`/`.asy` 却看不到变化**：先 `-v` 看是不是命中了缓存；真要排除，删 `.omni-cache/`。

## 8. 还想读点什么

- [`../PLAN.md`](../PLAN.md) —— 目标、非目标、自举策略
- [`adr/0018-cli-command-tree.md`](adr/0018-cli-command-tree.md) —— 命令树为什么长这样
- [`adr/0013-execution-engine.md`](adr/0013-execution-engine.md) —— 解释器 / 编成 JS 之间的账
- [`adr/0014-sexpr-frontends-and-llvm-backends.md`](adr/0014-sexpr-frontends-and-llvm-backends.md) —— 核心方言与"加一门语言"
- [`adr/0017-c-frontend-wasm-memory-and-asm.md`](adr/0017-c-frontend-wasm-memory-and-asm.md) —— C 前端、链接器、与 tcc 的对账
- [`adr/0019-glsl-and-software-raster.md`](adr/0019-glsl-and-software-raster.md) —— GLSL 与软件光栅（照着 llvmpipe）
- [`adr/0011-js-lowering.md`](adr/0011-js-lowering.md) —— 封闭 ABI：与宿主打交道只有那一层
- [`js-bootstrap-subset.md`](js-bootstrap-subset.md)、[`bootstrap-subset.md`](bootstrap-subset.md)、[`bootstrap-build.md`](bootstrap-build.md)

ADR 是**按刀记的**：每条都写着"量到了什么、为什么这样定、代价是什么、错法的指纹长什么样"。
想改一处行为，先在对应那份里找有没有量过 —— 大概率有。
