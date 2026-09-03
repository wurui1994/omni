# ADR-0018：命令行的形状 —— 顶层与语言解耦，管线是数据

状态：进行中（第一片：命令树与 per-node `--help`）

## 背景

`stage0/src/cli.js` 现在是 2870 行，里头 28 条**扁平**的命令，一个 `switch` 分派。
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
stage0/src/cli.js            只剩：建树、dispatch、错误处理
stage0/src/cli/tree.js       节点类型、argv 解析、help 渲染
stage0/src/cli/stages.js     stage 列表 + --explain/-v 渲染
stage0/src/cli/cmd-{run,emit,c,tcc,link,jnc,glr}.js
```

约束：新文件都要留在 JS 自举子集里 —— `bootstrap.js` 拿 `cli.js` 当入口把 import 树链成
一份程序，所以分文件本身没问题（现在已经几十个模块），但里头不能用子集外的语法。

## 后果与代价

- **换来**：顶层与语言解耦（加一个 PE 开关不再碰顶层）；每一级都有 `--help`；管线可见
  且前后端分明；尺子那一路少一层自制翻译。
- **代价**：一次跨 48 处门的改名；`cli.js` 拆成七个文件（自举那条链要跟着验）；
  `--explain` 要求驱动先建列表再执行 —— 有几条路现在是边走边决定的（`run` 那条按缓存命中
  分叉），它们得把「要走哪条」提前算出来。那不是坏事：现在也没人能在跑之前说清它会走哪条。
