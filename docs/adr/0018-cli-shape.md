# ADR-0018：命令行的形状 —— 顶层与语言解耦，管线是数据

状态：进行中（第一片：命令树与 per-node `--help`）

## 背景

`src/core/cli.js` 现在是 2870 行，里头 28 条**扁平**的命令，一个 `switch` 分派。
它不是「风格不好」，是三处结构性的病：

**1. 顶层预解析必须认识全程序每一个带值开关。** `cli.js:2091-2098` 那一坨：

```js
if (a === '-o' || a === '--mode' || a === '--work' || a === '--cache'
  || a === '-I' || a === '-D' || a === '--rdata'
  || a === '-L' || a === '--target' || a === '-e' || a === '-l'
  || a === '--dylib' || a === '--libtcc1' || a === '--dll'
  || a === '--soname' || a === '--rpath' || a === '--install-name'
  || a === '--subsystem' || a === '--image-base' || a === '--stack'
  || a === '--file-align' || a === '--section-align' || a === '--dwarf'
  || a === '-MF' || a === '-U' || a === '-isystem' || a === '-include') { i++; continue; }
```

顶层要这么做只为一件事：别把 `-I dir` 里的 `dir` 当成源文件。可代价是**加一个 PE
链接器的开关就要改顶层**——`--image-base` 是 PE 独有的，`--install-name` 是 Mach-O
独有的，`-isystem` 是 C 独有的，它们全都写在这个与语言无关的位置上。这就是耦合的
物理形式，不是抽象的坏味道。

**2. 命名的语义方向不一致，而且已经出了陷阱。**

- `run-c` = 我们的语言 → C → 跑
- `c-run` = C 语言 → 跑

同一个 `c`，一次是**后端**、一次是**前端**。整张表里那个前缀有三种含义：后端
（`emit-c`、`run-llvm`、`build-llvm`）、前端（`c-mir`、`c-obj`、`c-run`）、容器格式
（`elf-r`、`elf-link`、`pe-link`、`macho-link`）。

**3. 三维的东西被压平成了点。** 真实结构是「前端 × 走到哪一步 × 后端」。28 条命令是
这个空间里手工枚举出来的一些点，所以既有 `run-llvm` 又有 `run-jit` 又有 `build-llvm`，
而「build 但走 jit」这种组合压根表达不出来。

**4. `--help` 只有一份**，两百行全量倾倒；子命令自己的开关没有单独的入口。

**5. 管线看不见。** `-v` 是散在实现里的 `vlog(名字, 毫秒)`，每个调用点自己决定印什么，
所以「前端 / 中端 / 后端 / 执行」分不出来，中间形态（AST / OIR / MIR / tokens）也不成一串。
管线长的时候（`c → cpp → MIR → x86_64 → ELF .o → 链接 → PE .exe`）尤其看不出走了哪条路。

## 决策一：顶层只有与语言无关的动词

前端仍然**由扩展名选**（`--lang` 覆盖），后端由 `--backend` 选。顶层不认识任何一门语言
特有的开关。

```
omni run     FILE [-- args...]      编译并执行
omni build   FILE -o NAME           编译成产物
omni emit    FORM FILE              打印某个中间/目标形态
omni check   FILE                   只走前端 + 检查器，不出产物
omni explain FILE                   打印将要跑的管线，然后停
omni repl                           交互
omni bootstrap                      四条不动点
```

`--backend interp|js|c|llvm|jit|native|spirv`；`emit` 的 `FORM` 是
`ast|oir|mir|sx|asy|js|c|llvm|spirv`。

于是 12 条旧命令塌进 3 个动词加 2 个枚举维度：

- `run-c` → `run --backend c`；`run-llvm` → `run --backend llvm`；`run-jit` → `run --backend jit`
- `build-llvm` → `build --backend llvm`
- `emit-js` / `emit-c` / `emit-llvm` / `emit-spirv` / `emit-asy` / `ast` / `oir` / `mir` / `sx`
  → `emit js|c|llvm|spirv|asy|ast|oir|mir|sx`

顶层**不再有** `-I`、`-D`、`-U`、`-isystem`、`-include`、`-MF`：那些是 C 与 jancy 的事实。

## 决策二：语言子树承载语言特有的面

```
omni c cpp   FILE            -I -D -U -isystem -include -MF -E -P -dM -dD
omni c mir   FILE            一遍过到 MIR（路径 B，tccgen 等价物）
omni c run   FILE [-- args]  同上再跑；退出码是 C main 的返回值
omni c obj   FILE -o NAME    --target ARCH-OS  -f elf|macho
omni c link  FILE.o... -o    --target ARCH-OS  -f elf|macho|pe  -r --shared -e -L -l
omni c tcc   ...             tcc 兼容驱动（决策三）
```

`omni jnc …`、`omni glr …` 同理各成一组，`-I` 落在 `omni jnc` 上。

### 格式是**目标的一个属性**，不是另一条命令

`elf-r` / `elf-link` / `pe-link` / `macho-link` 四条合成**一条** `omni c link`，
容器格式走 `-f/--format`：

- `-f elf|macho|pe` —— 容器
- 产物种类：默认可执行、`-r` 可重定位（tcc 的 `-r`，收掉 `elf-r`）、`--shared` 库

**不是** `omni c link elf` 那种再分一级。理由是这条项目里量到的事实：
**tcc 的 `-c` 在所有目标上都写 ELF**（第九刀）。所以「win32 目标 + ELF 容器」是一个
真实存在、而且我们逐字节要对的组合 —— 格式不能从 OS 推出来然后锁死，它必须能单独拨。
把它做成命令的一级，就等于宣称「格式与目标是同一件事」，那是错的。

各格式独有的开关由**这个节点自己**校验：`--image-base`/`--subsystem`/`--stack` 只
PE 有，`--install-name`/`--dylib` 只 Mach-O 有，`--soname`/`--rpath`/`--dll` 只 ELF 有。
给了但格式不对就报「`--install-name` 只在 `-f macho` 上有意义」。这是决策四换来的：
校验能落在知道上下文的地方，而不是顶层。

## 决策三：`omni c tcc` —— 等效的 tcc 子命令，它是尺子

工程终点是「我们的 tcc 能编 tinycc 全部源码，且**写出的字节与 tcc 相同**」。可现在
32 处门在手工拼 `c-obj --arch x86_64 --os linux --format elf -o …`，与尺子那边的
`x86_64-tcc -B$SRC -c x.c -o x.o` 是**两串不同的 argv**。中间那层翻译是我们自己写的，
它错了门也未必红。

所以要有一条命令，它的**界面就是 tcc 的界面**：

```
omni c tcc [-c|-E|-r|-run|-shared|-static] [-o OUT] [-I D] [-D M[=V]] [-U M]
           [-L D] [-l NAME] [-B DIR] [-b ARCH-OS] [-g|-gdwarf] [-nostdlib]
           [-v|-vv] [-P] [-dM|-dD] [-MF F] FILE...
```

于是门可以拿**同一串 argv** 喂两边，翻译那一层从测试里消失。

它自己一套解析器 —— tcc 的 `-v`/`-vv` 与 omni 的 `--verbose` 语义不同，混在一起必错。
内部把 `-b`/`-c`/`-r`/`-E` 翻译成上面那几条 `omni c *`。`--help` 直接印 tcc 的 usage
文本，好逐条对照缺哪个。

## 决策四：dispatch 换成命令树，`--help` 由走树函数生成

每个节点：

```js
{ name, brief, help, flags, positional, run, children, hidden }
```

`--help` / `-h` 在**任何一级**都由同一个函数处理 —— 走到那个节点，印它自己的那份：

```
omni --help              组与顶层动词，一屏
omni run --help          run 的开关 + backend 清单 + 例子
omni c --help            c 的子命令
omni c link --help       link 的开关，按格式分节标出哪些只对某个 -f 有效
omni c tcc --help        tcc 自己的 usage
omni help legacy         旧名到新名的对照表
```

白拿三件事：

1. **顶层预解析消失** —— 每个节点只声明自己的 flags，`{ name: '-I', arity: 1 }` 那种。
   背景那一坨 26 个 `||` 整段删掉。
2. 未知开关能在**正确的层**报错，并给出「你是不是想在 `omni c cpp` 上用 `-I`」。
3. 将来想要的机器可读形态（`omni --help --json`、shell 补全）是同一棵树上的另一个渲染器。

## 决策五：管线是**数据**，`--explain` 与 `-v` 共用一份

这是这份 ADR 里唯一一条会改变实现形状的决策：驱动在动手之前先把 **stage 列表**建出来，
`--explain` 打印后停，`-v` 边跑边打印同一份、每行补上耗时。两者永不失同步 —— 因为
它们是同一份数据的两个渲染。

一个 stage：

```js
{ phase: 'front'|'mid'|'back'|'exec',
  verb: 'read'|'parse'|'check'|'lower'|'codegen'|'emit'|'write'|'link'|'exec'|'cpp',
  in: '…', out: '…', note: '…', artifact: '…' }
```

`phase` 那一格就是「前端 / 后端分不清」的解法：它是标注，不靠人从名字猜。

显示是**一行摘要（箭头形，快读）+ 编号清单（列对齐，长管线也不糊）**：

```
$ omni run app.omni --explain
pipeline  omni(mixed) → AST → OIR → MIR → js → node(in-process)
  #  phase   stage      in                    out                artifact
  1  front   read       app.omni (+3 imports)
  2  front   parse      .omni mixed        →  AST
  3  front   check      AST                →  AST'
  4  mid     lower      AST'               →  OIR
  5  mid     lower      OIR                →  MIR
  6  back    emit       MIR                →  JavaScript         .omni-cache/js/app.mjs
  7  exec    node       ESM graph
```

```
$ omni c tcc -c t.c -o t.o -b x86_64-win32 --explain
pipeline  c → cpp → MIR → x86_64 → ELF(.o)
  1  front   cpp        t.c  -I… -D…      →  tokens
  2  mid     lower      tokens (one pass) →  MIR      native: no linear memory
  3  back    codegen    MIR               →  x86_64   + win32 unwind table
  4  back    write      MIR/x86_64        →  ELF .o   t.o  .text/.data/.data.ro/.bss
```

```
$ omni c link a.o b.o -f pe --target x86_64-win32 -o a.exe -v
pipeline  2×ELF(.o) + libtcc1.a → merge → PE(.exe)
  1  back    read       a.o b.o libtcc1.a  →  sections           +12ms
  2  back    resolve    imports from -L    →  idata + thunks     +3ms
  3  back    layout     text<rdata<data<bss<idata<pdata          +1ms
  4  back    reloc      1183 fixups                              +7ms
  5  back    write      →  a.exe (2207232 bytes)                 +9ms
```

规矩：

- 摘要行只印**形态**，不印文件名与开关；清单行印细节。长管线靠编号列表读，不靠一行长箭头。
- 一个 stage 一行。真的要再细（每个函数、每条重定位）是 `-vv` 的事，那一层往清单行下面缩进。
- `--explain` **一个字节都不写盘、不执行**。它是「这条命令会走哪条路」的答案，不是 dry-run
  的近似。

## 决策六：旧名当**静默**别名，门迁完再删

面积量过：测试里 48 处 CLI 调用 —— `c-obj` 32、`macho-link` 6、`cpp` 6，其余零散。风险
集中在三条命令上。

别名**静默**，理由具体：有几道门（`selfpp`、`predefs`、`cpp` 那一族）是逐字节比 stdout
的，往 stdout 加一行弃用提示会直接把它们弄红；往 stderr 打也会打扰比 stderr 的那些。
所以别名不打任何东西，对照表放在 `omni help legacy` 里。

## 分片

1. **命令树 + per-node `--help` + 静默别名**。行为零变化，纯结构。背景那一坨 26 个 `||`
   在这一片消失。
2. **stage 列表 + `--explain` + `-v` 重写**。`vlog` 的调用点变成「把这一格标成完成」。
3. **`omni c tcc`**，然后把 32 处 `c-obj` 的门改成拿同一串 argv 比尺子。
4. `omni c link` 四合一；`emit`/`run`/`build` 收掉那 12 条；删别名。

## 代码摆放

```
src/core/cli.js            只剩：建树、dispatch、错误处理
src/core/cli/tree.js       节点类型、argv 解析、help 渲染
src/core/cli/stages.js     stage 列表 + --explain/-v 渲染
src/core/cli/cmd-{run,emit,c,tcc,link,jnc,glr}.js
```

约束：新文件都要留在 JS 自举子集里 —— `bootstrap.js` 拿 `cli.js` 当入口把 import 树链成
一份程序，所以分文件本身没问题（现在已经几十个模块），但里头不能用子集外的语法。

## 后果与代价

- **换来**：顶层与语言解耦（加一个 PE 开关不再碰顶层）；每一级都有 `--help`；管线可见
  且前后端分明；尺子那一路少一层自制翻译。
- **代价**：一次跨 48 处门的改名；`cli.js` 拆成七个文件（自举那条链要跟着验）；
  `--explain` 要求驱动先建列表再执行 —— 有几条路现在是边走边决定的（`run` 那条按缓存命中
  分叉），它们得把「要走哪条」提前算出来。那不是坏事：现在也没人能在跑之前说清它会走哪条。

## 落地：分片 1 —— 命令树、每一级的 `--help`、静默别名

新增两份：`src/core/cli/tree.js`（机制：走树、分开关、别名铺平、help 渲染，**不碰宿主**，
能单独测）与 `src/core/cli/cmds.js`（数据：整棵树长什么样）。`cli.js` 里那个 `switch`
一段没动 —— 每个叶子带一格 `key`，那就是 `switch` 认的标签，于是新名与旧名指向同一份实现。

**背景那一坨 26 个 `||` 删掉了**，连同那份两百行的 `USAGE` 常量（93 行）。

三处不止是搬家：

1. **顺带修了一个靠运气的地方。** `--arch`/`--os`/`--format`/`--lang`/`--engine`/`--kernel`
   从前**不在**顶层那张带值开关表里，所以 `omni c-obj --arch x86_64 x.c` 会把 `x86_64`
   当成源文件。现有的门都是 `x.c` 写在前面，所以一直没露。
2. **别名要铺平成规范名。** 底下那 28 段实现是自己在 `rest` 上找开关的
   （`rest.indexOf('--format')` 那种），不认识新加的短写法 —— 量到过：`c obj -f elf`
   出来是 Mach-O，因为那一段找不到 `--format` 就走了默认。所以 `canonicalize` 在交给
   实现之前先把别名换掉。
3. **节点级压过全局级。** `omni c cpp -v` 里那个 `-v` 是 **tcc 的 `-v`**（印版本条与头文件
   搜索路径），不是 omni 的 `--verbose`——铺平之后 `tests/c/run.js` 的
   `inc/01-include -v` 那一条直接红了。所以 `canonicalize` 先看这个节点自己声明了什么名字，
   声明过的不动；`ownsVerbose(node)` 同理决定 `-v` 要不要点亮 `VERBOSE`。这也正是
   决策三里「`omni c tcc` 要自己一套解析器」的同一条道理，只是它在 `cpp` 上就已经发生了。

`glr` 那一组要带 `key`：`omni glr FILE.grammar FILE...` 是旧的扁平写法，而 `table`/`parse`
都不会撞上一个 `.grammar` 路径 —— 于是「下一个记号不是子命令名」就落回组自己
（`git stash` = `git stash push` 那个套路）。这一条是新门逮出来的。

自举那条链也逮了一个：`tree.js` 里的 `pad` 与 `mir/print.js` 里的 `pad` 撞 —— JS 前端把
import 树链成一份程序，模块作用域的名字在整份程序里必须唯一。改名 `padCell`。

新门 `tests/cli/tree.js` 27/0，只查机制（走树、开关、别名、每一级 help、每个叶子都有
`key`、`LEGACY` 那张表两栏都真的走得通），进了 `tests/all.js`。行为那一侧靠既有的门：
`tests/run.js` 96/0、C 那一族全绿、`tcc-obj` 还是 0 字节相同 / 21 容器相同 / 89 不同。

## 落地：分片 2（前半）—— 管线表与 `--explain`

新增两份：`cli/stages.js`（管线表 + 两个渲染）与 `cli/plan-c.js`（C 那条腿的表怎么造）。
`--explain` 进了 `GLOBAL_FLAGS`，`cli.js` 里多一段「造表、印、返回 0」。

`--explain` 先覆盖 **C 那条腿**：管线最长（`c → cpp → MIR → x86_64 → ELF .o → 链接 →
PE .exe`），也是这个工程逐字节对着 tcc 量的那条 —— 「走了哪一路」在这儿最要紧。样子：

```
$ omni c obj t.c -o t.o --arch x86_64 --os win32 -f elf --explain
pipeline  c → cpp → MIR → x86_64 → ELF(.o)
  1  front  read     t.c
  2  front  cpp      text               -> tokens
  3  mid    lower    tokens             -> MIR         native：没有线性内存，地址就是真地址
  4  back   codegen  MIR                -> x86_64      代码节里还多一份共用的展开信息
  5  back   write    x86_64 + 数据三段  -> ELF ET_REL  .text/.data/.rdata/.bss  t.o
```

三条规矩落在代码里：

- `plan-c.js` **只造表、不干活**，看的是与实现同一批开关 —— 所以 `--explain` 能做到
  「一个字节都不写盘、不执行」而说得准。
- `->` 只在真的有 `out` 时印：`exec` 那一格没有产物形态，硬印一个箭头就是在骗人
  （`c run` 的最后一格）。
- 列宽按**显示列**算，不按 `.length`：汉字占两列，不算这一格带中文的注释会把后面的列
  顶歪（`x86_64 + 数据三段` 那一行）。测试里那一条也不能拿 `indexOf` 比 —— 那是 UTF-16
  码元的位置，正确的两行在它上面本来就差 4。

自举那条链又逮了一个同名：`stages.js` 的 `padTo` 与 `interp/libc.js` 的撞，改名 `padCol`。
（分片 1 是 `pad` 与 `mir/print.js` 撞。新写模块级小工具函数时这一格要先查。）

`tests/cli/tree.js` 长到 **36/0**（多了管线表那 9 条）。C 那一族与 `tests/run.js` 照旧全绿。

**还没做的**：`--explain` 还没覆盖我们自己那门语言那几条（`run`/`build`/`emit`），那要先把
「按缓存命中分叉」那一路的决定提前算出来。

## 落地：目录改名与薄层入口

```
stage0/src/…                          ->  src/core/…     编译器那一整棵树
stage0/{lib,include,runtime,gpu,jit}  ->  src/{…}
（新）src/cli.js                                          命令行入口
```

改名为什么是安全的，值得写下来：`installDir()`（`host/native.js`）是从**它自己的
`import.meta.url`** 算的，不是从进程入口算的，而 `stage0/src/host` 与 `src/core/host`
**深度相同** —— 于是那七处 `join(installDir(), '..', …)`（`include`、`lib/asy`、
`.omni-cache`、两份 `.grammar`、`builtins.tab`、自举的源）一处都不用动。新加的
`src/cli.js` 在第一层，也不影响它 —— 因为它压根不参与那个计算。

`src/cli.js` 现在只有一句 `import './core/cli.js'`。薄得有意，但它**不该永远这么薄**：
`core/cli.js` 眼下既是驱动又是入口（末尾自己 `setExitCode(main(procArgs()))`），所以它
**不能被 import 而不执行**。把「取 argv、定退出码、印错误」这几件进程级的事挪上来，
`core/cli.js` 就能当普通模块用 —— 门里直接 `main([...])` 在进程内跑一趟，不必 spawn。
那一步要连着把 62 处门的 `cli` 常量指过来，所以与这一片分开做。

145 个文件的路径引用跟着改；`package.json` 的 `bin` 与 `scripts` 指向新入口。

门：C 那一族全绿（`run` 207/0、`native` 227/0、`native-gen` 83/0、`tcc-link` 83/0、
`sym-size` 12/0、`selfsrc` 13/0、`selfcross` 12/0、`tcc-obj` 21 容器相同）、
`tests/run.js` 96/0、`js-roundtrip` 200/0、`oir` 607/0、`glr` 20/0、`wat` 15/0、
`cli/tree` 36/0。

`mir`/`incr`/`bootstrap` 这三条**改名之前就是红的**，而且红在同一处：编译器自己那棵树里
有 JS 子集不收的东西（`arm64/asm.js` 与 `from_mir.js` 的 `import * as`、`errText` 与
`isSpace` 各在两个模块里同名）。改名之前那几条报的是同样的话，只是路径写着 `stage0/src`。
那是另一笔账。

## 量：`omni c tcc` 的 `-B`（接上它之前要先知道的）

`-B` 眼下是**明着骂**的（不接就不假装接了）。要接上，量到这些：

探针 `#include <stdarg.h>`，`tcc -B$TOPSRC -vv -E`：

```
-> /tmp/…/t.c
-> $TOPSRC/include/stdarg.h
```

所以 `-B DIR` 就是把 **`DIR/include`** 放进搜索路径 —— 那一份是 tinycc 自带的头
（`{B}/include`，与 `{B}/libtcc1.a` 同一个根）。

**还没量准的**：它与 `-I` 的先后。我那一趟 `-B$TOPSRC -I /tmp/omni-B` 里
`/tmp/omni-B` 底下压根没有同名的头，所以那个探针**证不出**谁压过谁 —— 要接上 `-B`
就得先补一个探针：两边都放一份同名头，看 `-vv` 打出来走的是哪一个。

### 补上了：`-I` 与 `-isystem` 都压过 `{B}/include`

探针：`/tmp/omni-P/mine/stdarg.h` 里 `#define WHO "from_-I"`，源码
`#include <stdarg.h>` 之后 `char *w = WHO;`——`$TOPSRC/include/stdarg.h` 里没有 `WHO`，
所以谁赢一眼看得出。

```
tcc -B$TOPSRC -I /tmp/omni-P/mine -vv -E -P
  -> /tmp/omni-P/mine/stdarg.h        <- 走的是 -I 那一份
  char *w = "from_-I";

tcc -B$TOPSRC -isystem /tmp/omni-P/mine -E -P
  char *w = "from_-I";                 <- -isystem 也一样赢
```

所以搜索序是 **`-I` / `-isystem` 在前，`{B}/include` 在后**。接 `-B` 就是把
`DIR/include` 追加到那两批**之后**。

### 上一条里我记错了一句，改过来

我先前在这儿写「我们自带那份头排在 `-isystem` 之前，与 tcc 方向相反」——**那是错的**。
`cli.js` 的 `cSysInclude()` 头上本来就写着「`-isystem` 给的排在这两段前头」：
自带的 `src/include` 只是在 `cSysInclude()` **自己那两段里**排第一（在 SDK 的
`/usr/include` 之前），而整条搜索序里它仍在 `-isystem` 之后。**与 tcc 同向。**
我把「函数内部的次序」看成了「整条搜索序里的次序」。

于是 `-B` 接上了（`cmd-tcc.js`）：`-B DIR` 转成 `-isystem DIR/include`，而且**push 在
所有 `-I`/`-isystem` 之后** —— 正好落在量到的那个位置上。

留着的一处差别，写在明处：tcc 那边 `{B}/include` **就是**它自带的那一份，给了 `-B` 就
没有别的了；我们这边 `src/include` 还在搜索序的尾巴上。于是「两边都有的头」走 `-B`
那一份（对），「只有我们有的头」我们还找得到、tcc 找不到（差别）。要抹掉这一格得让
`cSysInclude()` 能被换掉，那是 `cli.js` 那一侧的事。

## 落地：分片 2（后半）—— `-v` 接上同一张表


`-v` 从前是 56 处散着的 `vStep(自由文本)`。这一片让它**接过 `--explain` 造的那张表**：

```
$ omni c obj t.c -o t.o --arch x86_64 --os linux -f elf -v
pipeline  c → cpp → MIR → x86_64 → ELF(.o)
  1  front  read     t.c  ⋯
  2  front  cpp      text               -> tokens  ⋯
  3  mid    lower    tokens             -> MIR         native：没有线性内存…  +13ms（这 3 格一起量）
  4  back   codegen  MIR                -> x86_64  +7ms
  5  back   write    x86_64 + 数据三段  -> ELF ET_REL  .text/.data/.data.ro/.bss  t.o  +3ms
```

与上面 `--explain` 印的**逐字相同**（列宽也一样，因为是同一份 plan），只多了耗时。三处设计：

- `vBegin(plan)` 接表、`vNext(verb)` 标完成。表是 `plan-c.js` 造的、叫的是实现 ——
  **`vNext` 要核对 `verb`**：两边各改一处就会错位，而错位之后印出来的每一行都在骗人。
  对不上就直接骂（只在 `-v` 上；不开 `-v` 那条路上一个字节都不多）。
- 好几格只能一起量的情形：`lowerCNative` 一趟就把读文件、预处理、降级全做了，拆不开。
  那就 `vNext('read','cpp','lower')`——**耗时只挂在最后一格上**并注明「这 3 格一起量」，
  前面两格印 `⋯` 而不是编一个数出来。这是这一片唯一一处「显示与实现的粒度不一致」，
  写在明处比悄悄平摊诚实。
- 造不出表的命令（还没覆盖的那些）`LIVE` 是 `null`，照旧走老的 `vStep` —— 一次改 56 处
  才是真的危险。

这一片只接了 `c obj` 那一条（32 处门在用它，也是管线最长的）。`cpp`/`c mir`/`c run` 与
四条链接器还是老的 `vStep`，是下一片。

门照旧：`tests/cli/tree.js` 36/0、C 那一族全绿、`tests/run.js` 96/0、
`tcc-obj` 0 字节相同 / 21 容器相同 / 89 不同。


## 落地：门迁移（分片 3 的收益）—— 迁到第九处就抓到一个真错

把门从手拼 `c-obj --arch … --os … --format elf` 改成与尺子**同一串 argv**。已迁十二处：

`sym-size`（12/0）、`sym-order`（18/0）、`rela-order`（6/0）、`char-sign`（6/0）、
`rodata-sec`（27/0）、`str-rodata`（72/0）、`rdata-name`（3/0）、`weak-sym`（2/0）、
`vis-sym`（2/0）、`alias-sym`（4/0）、`dm-order`（7/0）、`datetime`（4/0）。

形状两种：

- **交叉那一族**：`const ARGS = [B, '-c', c]`，尺子吃 `[...ARGS, '-o', ro]`，
  我们吃 `['c','tcc','-b',`${arch}-${os}`, ...ARGS, '-o', mo]` —— 只差一个 `-b`。
- **本机那一族**（`weak-sym`/`vis-sym`/`alias-sym`/`dm-order`/`datetime`）：
  `['-B', TCC_DIR, '-c', src]`，连 `-b` 都不用给（默认就是本机那一支）。

迁移本身就是**加强**：从前我们这一侧不吃 `-B`，读的是自带的头；现在两边读的是同一份
tinycc 头。

**它当场抓到一个真错。** `dm-order` 一迁就从 7/0 变成 6/1：

```
tcc :  #undef __TINYC__ / #undef __APPLE__ / #undef NEVER / #define FOO 2
ours:  #define FOO 2 / #undef __TINYC__ / #undef __APPLE__ / #undef NEVER
```

`tccTranslate` 的 `passIncs()` 是「先所有 `-D` 再所有 `-U`」攒出来的，把**命令行次序**
弄丢了 —— 而 `-DA=1 -UA` 与 `-UA -DA=1` 结果相反，这不是排版问题。改成按次序攒一串
`defs`（`-I`/`-isystem` 仍按类分堆：tcc 那边这两类是两张表，类内次序才是有意义的那一格）。

这正是分片 3 要的东西：**中间那层翻译是我们自己写的，它错了门也未必红**。从前门绕开
翻译层直接喂 `cpp -E -DA=1 -UA`，次序自然对；换成同一串 argv，翻译层的错就露出来了。
于是 `tests/cli/tree.js` 也补了四格称翻译本身的（36/0 → 41/0），包括正反两串 `-D`/`-U`。

还剩 19 处调用（`grep -c "'c-obj'" tests/c/*.js`），其中两处是我们单侧的
（`alias-sym`/`weak-sym` 里编 `main.c` 那一步，尺子那边没有对应的一趟），不在这条线上。


## 落地：门迁移收尾 —— 对着比的那些全迁完了

又迁六处，其中最要紧的是**称字节那一道**：

- `wchar`（30/0）、`rela-text`（22/0/1）、`pdata-x64`（11/0）、`eh-frame-x64`（8/0）
- `tcc-obj` —— 工程终点那道门。从前它这一侧手拼 `c-obj --arch … --format elf --os …`，
  与尺子那边的 `-B… -c … -o …` 是两串不同的东西。**称字节的门自己不同源，这件事最不该留。**
  迁完数字不动：0 字节相同 / 21 容器相同 / 89 不同 / 0 我们还编不出 —— 说明这一路的
  翻译本来是对的（`dm-order` 那一处不是）。

**剩下的 `c-obj` 调用一处都不迁**，它们是**我们单侧**的，不存在「同一串 argv」这回事：

- `selfobj`/`selfsrc`/`selfcross`/`selfboot` —— 编 tinycc 的源码出我们的 `.o`，
  参照物是**事先建好的** tcc 可执行文件，不是同一时刻的一趟 `tcc -c`
- `tcc-link` —— 先出我们的 `.o` 再链起来跑，比的是**跑出来的结果**
- `arch-defs`/`native-gen`/`ldouble-x64` —— clang 那一条腿（称的是前端与 ABI）
- `eh-frame-x64`/`pdata-x64` 各有一格「这个目标上**不该**有这一节」——尺子那边没有对应的一趟
- `alias-sym`/`weak-sym` 里编 `main.c` 那一步

硬要给它们套上 `c tcc` 反而会引进假东西：`c tcc -c` 一律写 ELF（量过的事实），
而 `selfobj` 第一段要的是 Mach-O，得额外补一个 `-f macho` —— 那是为了形式一致去改
一串本来对的 argv，收益是零。

## 落地：分片 4（第一片）—— 不认识的开关直接骂

分片 1 在 `splitArgv` 里留了一句话：

> **不认识的开关先放过**（当 arity 0）：这一片的承诺是「行为零变化」……等这棵树上每个
> 节点都把自己的开关声明齐了（分片 4），再把这儿改成报错。

现在把它兑了。**放过的代价有两层**，第二层是真会咬人的：

1. 打错一个开关名会**悄悄按默认走**。门这时候比的是「我们自己两趟」，两趟都错得一样，
   于是绿 —— 这与第一百三十九片那一格是同一个病。
2. 带值的开关不认识时，**它那个值会被当成位置参数**（= 一个源文件 / 一个输入 `.o`）。
   在链接器上尤其毒：多一个输入文件，符号表就多一份。

### 顺着这一刀量出来的

- **`interp` 不认识 `--mir`、`run` 不认识 `--interp`/`--mir`**。这三格实现里一直在读
  （`cli.js` 的 `rest.includes('--mir')`），可树上没声明 —— 从前靠「放过」活着。
- **`cpp` 不认识 `-M`/`-MM`/`-MD`/`-MMD`/`-MP`**。同上（`-MF` 声明了，一家人里少了五个）。
- **`-vvv` 没法进表**。tcc 的 `-v` 是数出来的（`do ++verbose; while (*optarg++ == 'v')`），
  表里列到 `-vv` 就够印 `--help`，但**认**得一直往上 —— 所以这条规则写在 `matchFlag` 里，
  不是往表里加 `-vvv`/`-vvvv`。
- **值粘在名字后面的写法整个没处理**（`-Ia`、`-DM=1`、`-UX`）。tcc 两种都收，
  `cli.js` 的 `incDirs`/`defArgs` 也一直在拆这种 —— 只有 `splitArgv` 不知道。
  从前它们落进「不认识」那一支被放过，于是**碰巧**能用；改成报错的第一刻就露了。
- **`c tcc` 排在 `splitArgv` 后面**。那个节点故意不声明 flags（tcc 的 `-v`/`-r`/`-f`
  与 omni 的不同义，它自己一套解析器），于是新规则会先把它自己的 argv 挡下来。
  把那一段挪到 `splitArgv` **之前**。
- **一处旧的赋值把新的盖掉了**：`VERBOSE = … ownsVerbose(node) …` 后面还留着上一版的
  `VERBOSE = rest.includes('--verbose') || rest.includes('-v')`，于是 `ownsVerbose` 那一格
  等于没有。没门抓到它 —— `omni c cpp -v` 的门只比 stdout，而 `--verbose` 写 stderr。
- **`-I` 不只是 C 的事** —— 这一条得改决策二里那句话。`omni c --help` 上写着「`-I` / `-D`
  / `-U` / `-isystem` / `-include` 这些**只在这一组里**」，可 **jancy 的 `import` 也按 `-I`
  找**（第六十二刀），而 jnc 走的是与语言无关的 `run`/`build`/`emit`/`check`。
  量出来的样子：`tests/jnc` 里那条「找不着 import」的门报的不是它该报的话，而是
  「不认识的开关 '-I'」。所以 `-I` 加在顶层那四条上（外加对应的 14 条隐藏别名 ——
  它们与新名走同一段实现，少一条就是那一条把目录当源文件）。

  这不推翻决策二：`-D`/`-U`/`-isystem`/`-include` 仍然只在 C 那一组里。变的是
  「`-I` 是谁的」这一格 —— 它是**「上哪儿找源文件」**，与语言无关。

### 门

`tests/cli/tree.js` **48/0**（原 41）：新加六条 —— 不认识的开关要骂且列出认识的、
不认识的带值开关不会把值悄悄变成源文件、`-Ia`/`-DM=1`/`-UX` 三种粘着写、`-vvv`。

跑过的：`tests/run.js` 96/0、`c/run.js` 207/0/1、`sexpr` 78/0、`llvm` 22/0、`jit` 22/0、
`glsl` 8/8、`oracle` 7/0、`oir` 607/0、`glr` 20/0、`gpu` 17/0/1、`asy` 259/0（五条腿）、
`jnc` 145/0，以及 `c/` 那一堆门：
`tcc-link` 83/0、`pe-tcc`/`pe-exe`/`pe-dll`/`macho-tcc`/`macho-libc`/`elf-merge` 全 0 不同、
`selfboot` 4/0、`selfpp` 29/0、`predefs` 12/0、`wchar` 30/0、`sym-order` 18/0、
`rela-order` 6/0、`str-rodata` 72/0、`inc-path` 4/0。

**还没做的**（分片 4 剩下的）：`emit`/`run`/`build` 那 12 条隐藏别名还在；`--explain`
只覆盖 C 那一条腿（`omni run --explain` 现在明着说「还没覆盖」——那句话是对的，
它没装作能行）。（`check` 在下一片里接上了。）

<!-- 分片 4 第一片-END -->

## 落地：分片 4（第二片）—— `check` 真接上了

`omni check FILE` 从前是一句「还没到（分片 4）；现在用 `omni emit oir FILE`」。
那句替代方案是**坏的**：它让人为了知道「这份源码有没有错」把一份十几 MB 的 JSON
印到终端上。

接上之后它就是「前端 + 检查器，到此为止」：前端由扩展名选（与别处同一条规矩，
`compileFront`），`.c` 走 C 那一路的一遍过（`cMir` 里就带 `verifyMir`——C 没有 OIR
这一层）。印一行摘要，错误照旧由抛出来的 `OmniError` 负责（退出码 1）。

### 门：不写新夹具，拿已有的两批用例钉

`tests/run.js` **133/0**（原 96）。新那一段一个夹具都没加：

- `cases/` 里的都编得过 -> `check` 必须回 0、必须印一行 `ok `
- `errors/` 里的都是**编译期**错误（上面那一段是拿 `run` 的非零退出码钉的）
  -> `check` 也必须非零

第二条是这一段的**重点**：`check` 要是在某一份 `errors/` 上回了 0，就说明它走的路
比编译那条**短** —— 那它不是「只走前端与检查器」，而是「少查了几样」。
一条「少查了几样」的 `check` 比没有 `check` 更坏：它会让人以为查过了。

<!-- 分片 4 第二片-END -->



