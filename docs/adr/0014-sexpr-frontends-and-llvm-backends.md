# ADR-0014：前端汇聚于 S 表达式，后端首选 LLVM（JIT + AOT）

状态：提议
日期：2026-08-26
取代：本文件同日的两份早稿（第一稿只谈解释器与 copy-patch JIT；第二稿把自写机器码
当主导。两处都错，见「两次错在哪」）
相关：ADR-0001（自举 / 多前端）、ADR-0013（执行引擎与 C-FFI 契约）、PLAN.md 第 1、8 节

## 两次错在哪

**第一稿**把 S 表达式当成「给解释器用的、摊平的 OIR」，位置放在 OIR **下面**。
方向和位置都错了。S 表达式的价值不在执行，在**前端**：配上 GLR 解析，加一门语言就只是
写一份 grammar 加一份映射标注 —— 否则每加一门语言都要写一份 parser、一份 lowering、
一份 emitter。PLAN.md 第 56 行写的是「同一 CST 框架，不同 grammar + **不同 lowering**」，
那个「不同 lowering」就是要被 S 表达式消掉的东西。

**第二稿**用一组实测数字（生成的 C 在 clang 上 `-O2` 21.13s）把 LLVM 判了出局，
结论是「自写机器码发射器为主导」。这个推论不成立，错在把两件事混为一谈：

> 那 21 秒是**整程序 -O2 的吞吐**，它对 **JIT 延迟**没有任何断言。
> JIT 的编译单元是**一个函数**：21.13s / 737 个函数 ≈ **28ms/函数**。
> 对 JIT 来说这是完全可接受的延迟，而我拿整程序的数字去否证按函数的延迟。

顺带把另一条也澄清清楚（这条我原来的说法方向对但幅度夸大了）：直接发 LLVM IR 而不过 C
能省掉 C 的解析（2.5s），以及一部分「替 clang 的朴素降级擦屁股」的 pass ——
SROA 4.2% + InstCombine 8.8% + MemCpyOpt 1.5% + DSE 3.5% + EarlyCSE 2.2% ≈ 20%，
约 4s。**其余的省不掉**：AArch64 指令选择 21.7%、Inliner 6.3%、寄存器分配 5.4%
是优化代码本身的价钱。所以「LLVM AOT 会和 clang 差不多贵」是真的，
但那是**要优化产物就得付**的钱，而它可以并行、可以按函数缓存（决策 5）。

「运行期不需要 cc」这条也没被 LLVM 破坏：LLVM 链进产物之后，产物**自带**执行器，
不依赖外部工具链。代价是体积（本机 `libLLVM.dylib` 157MB，`lib/` 全量 1.3G），
而它提供 C API（`libLLVM-C.dylib`）—— 正好落在我们的 C-FFI 契约上（决策 4）。

## 架构

```
每语言一份 grammar ──GLR──> CST ──grammar 里的映射标注──> S-EXPR
                                                            │  ← 前端汇聚点，语言中立
                                                            ▼
                                                          OIR   定型 + 检查（既有）
                                                            ▼
                                                          MIR   SSA + 显式类型 + 结构化控制流
                                                            │
        ┌──────────────┬──────────────┬──────────────┬──────────────┐
        ▼              ▼              ▼              ▼              ▼
   LLVM IR        LLVM IR         C（备选）     SPIR-V/GLSL    闭包解释器
   ORC JIT          AOT                                        （oracle / REPL）
```

## 决策 1：S 表达式是前端汇聚点，位置在 OIR 之上

- **形态**：语言中立的 s-expr，可打印、可读、可作为稳定文本交换格式（于是一个前端
  可以在仓库之外实现，只要能吐出这份 s-expr）。
- **加一门语言 = grammar + 映射标注**。GLR 的每次归约天然对应一个 s-expr 节点，
  所以「映射」就是在产生式上标注要构造哪个节点，不是写一遍遍历。
- **只有一份 `S-EXPR → OIR` 的降级**。语言特有的语义（JS 的数都是 f64、GLSL 的
  `in/out/uniform`）在**映射标注**里消化，或者作为 s-expr 上的 dialect 标记传下去，
  由那一份降级按 dialect 分支处理 —— 但不是每语言一份降级器。
- 现有的 `frontend-js/` 与 `parse/` 不动：它们是手写递归下降，继续作为
  自举入口与对照。**新语言走 GLR 那条路。** 两条路都必须收敛到同一份 s-expr，
  这本身就是一条测试轴（`frontend-js` 的 s-expr 输出与 GLR + JS grammar 的输出比对）。

### 已落地的形状：读取器 + WAT 前端

先做 WAT（WebAssembly 文本格式），理由是它给这条路径一份**别人写好的规格** ——
公开的词法、公开的指令表、公开的语义，还有大量现成素材。自己定一套 s-expr 方言
这些全都没有。

- `src/sexpr/read.js` —— 读取器。词法照 WAT：`;;` 与可嵌套的 `(; ;)`、WAT 的 idchar 表、
  WAT 的字符串转义。树只有三种节点（list / atom / string），**数字不在这一层解析** ——
  `0xffffffff` 在 i32 里合法在 i64 里是另一个值，读取器不该猜。
- `src/sexpr/print.js` —— 写出器。存在的理由是往返：读 → 写 → 读必须是不动点，
  这比「读取器不崩」强得多，它同时钉住词法的两端。
- `src/frontend-wat/lower.js` —— WAT → OIR。这是 **OIR 的第三个生产者**，也是把
  「只有一份降级」从口号变成可测的东西：在它之前 OIR 只有 JS 前端和 Omni 前端两个
  生产者，两者同源，接口对不对没有第三方来证。
- i32 的表示选得很关键：**始终以符号扩展后的 int64 保存**。于是无符号那一族
  （`div_u` / `shr_u` / `lt_u` …）靠一次零扩展就对了，不需要给 OIR 加无符号运算。
  i64 的无符号一族做不到，明确报错 —— 那要真正的 64 位无符号。
- `block` 与 `loop` 落到同一个形状 `while (true) { ...; break; }`，区别只在 `br`
  翻成 break 还是 continue。第一阶段只允许跳最内层（OIR 没有带标签的跳转）。

第一阶段的边界全部**报错而不是给错答案**：只认折叠形式、没有 f32、没有线性内存、
`br` 不能跳外层、`block/loop/if` 不能带 `(result ...)`。第七条测试轴 `tests/wat/`
的 `bad/` 就是逐条钉这些边界的 —— 边界是划的，不是忘了做。

有一条挡不住只能记下：**求值顺序**。wasm 是栈机，操作数必然从左到右；OIR 落到 C
之后实参顺序是 unspecified。所以同一条指令里既 `local.tee $x` 又 `local.get $x`
可以在三个执行器上给出不同答案。要挡住得做副作用分析，第一阶段不做。

### 已落地的形状：核心方言 + mini（第十三条测试轴）

WAT 前端证的是「s-expr 能当前端汇聚点」，但它降的是**别人的方言** —— wasm 的指令表 ——
语言特有的东西（栈机、位宽、`br` 的层数）全在那份降级里。所以它不是汇聚点本身，
是汇聚点的第一个使用者。`src/sexpr/lower.js` 才是汇聚点：一套语言中立的节点形状，
一份降级，谁都能往里发。

方言刻意小（`(module …)` / `fn` / `main` / `let` `set` `do` `if` `while` `ret` `print`
`expr` / `int` `real` `bool` `str` `var` `bin` `un` `call`，五个标量类型）。两条设计决定
值得单记：

- **类型不推导，只检查**。声明处写死，表达式自底向上定型，不一致就报错，不插隐式转换。
  理由与 ADR-0008 一致：「什么能悄悄转成什么」是语言设计决定，不该由汇聚层替某门语言定。
  条件位置同理 —— 必须是 `bool`，不做真值化。`tests/sexpr/bad/` 逐条钉住这些。
- **算符写成字符串**（`(bin "+" a b)`），不是每个算符一个节点。这样映射模板里可以直接
  `(bin $2 $1 $3)` 把源码里的算符原样搬过来，语法文件里不需要 switch。

配套加了 `$*k` **摊平洞**（`glr/driver.js` 的 `applyTemplate`）：`$k` 把第 k 个子节点
整个塞进去，`$*k` 把它的元素摊开。语句序列、形参表、实参表都要攒成平列表，没有它
就得在语法里写右递归再在降级里拆 —— 那就等于把 lowering 搬回语言侧了。

**mini** 是拿这套做的第一门可执行语言：C 风格花括号、显式类型、只有标量。它的全部
实现就是 `tests/glr/grammars/mini.grammar` 一个文件 —— 语法 + 映射标注，**没有一行
降级代码**。`omni glr mini.grammar x.mini` 印出核心方言，`omni run` 直接跑，
而 run / run-c / interp / interp --mir / run-llvm 五个执行器一个字都不知道 mini 存在。

于是验收门槛 1 那句「新增代码里不含任何 lowering/emit，这条要在评审里当硬指标查」
第一次变成了**自动断言**而不是评审纪律：`tests/sexpr/run.js` 里有一条 case 直接 grep
`stage0/src` 全树，出现 `mini` 这个词就红。哪天有人为了让 mini 跑通去编译器里加个特例，
那个特例必须提到语言的名字，所以拦得住。

这条轴另外三件事：cases/*.sx 四方逐字节相同（方言本身能跑）、mini/*.mini 经 grammar
出来的文本同样四方（标量那份五方）相同、bad/ 里的每份都拒在正确的理由上。
自举链里加了一条门槛：N1 的 `glr mini` 输出必须与 C0 逐字节相同，且两代 `run` 那份
`.sx` 输出相同 —— 分两条断言，因为文本对不上是摊平错了，文本对了输出不对是降级错了。

## 决策 2：GLR 驱动抄 bison 的图结构栈，并接受它的硬边界

量过 `reference/bison` 的 GLR 骨架（`data/skeletons/glr.c`，2764 行）。可抄的与必须
明说的：

- **GSS 是一个 bump 分配的「带标签联合」数组**，不是逐节点堆分配
  （`glr.c:505..590` 的 `yyGLRState` / `yySemanticOption` / `yyGLRStackItem`；
  `yynewGLRStackItem` 在 `:1120..1133` 就是挪一下 `yynextFree`）。分裂时
  **不复制栈内容**，新分支共享全部前驱（`yysplitStack`，`:1560..1604`）。
- **`yysplitPoint == NULL` 时退化成确定性 LR**，快路径原地弹栈、零复制
  （`:1449..1460`）。这条决定了「不歧义的语言不该为 GLR 付钱」。
- **语义动作必须延迟**，因为分支可能死掉。一个待定动作就是一个 `yySemanticOption`
  （`:1139..1160`），只在退回单栈时统一求值（`:2593..2599`）。注意它要**快照当时的
  lookahead**（`yyrawchar`/`yylval`），因为延迟动作以后可能读它 —— 这是个容易漏的坑。
- **硬边界，必须写进 grammar 规范**：没有 `%merge` / `%dprec` 的真歧义
  **不是「挑第一个」，是整个解析 abort**（`yypreference` 返回 0 → `yyreportAmbiguity`
  → `yyabort`，`:1682..1702`、`:1911..1916`）。bison 文档自己也这么写
  （`doc/bison.texi:1321..1325`）。所以我们的 grammar 格式必须**强制**每个可能冲突的
  产生式带消歧策略，并且在生成表的时候就报出来，而不是等运行时炸。
- **`%dprec` 也要抄**（改过一次主意，见下）。原先写的是「`%merge`/`%dprec` 我们不要」，
  jancy 把这条推翻了：`C1* c;` 既是「声明一个 C1 指针」又是「C1 乘 c 这条语句」，
  **任何 LR 语法都分不开** —— 要分开必须知道 `C1` 是不是类型名，那是符号表的事，
  jancy 自己也是这么干的（`DeclarationSpecifier.llk:258..278` 里调 `findType()`）。
  C 系语言全都绕不开。`%dprec` 是 GLR 下唯一的**声明式**手段，所以照收，写成 `(prefer N)`。
  `%merge`（把两棵树合成一棵）仍然不要 —— 那才是真的猜。
- **延迟动作的求值是沿 `yypred` 递归的**（`:1713..1725`），长延迟区意味着深递归 ——
  这是宿主栈风险，我们已经在解释器上被这个咬过一次（ADR-0013 附记），要用显式栈重写。

不抄的：bison 的 m4 骨架生成方式、C++ 骨架、以及它的错误恢复（我们的诊断是
编译期 span 制，见 `source/diag.js`）。

### 已落地的形状：语法即数据

四个文件，都在 `stage0/src/glr/`：

- `grammar.js` —— 语法文件本身写成 S 表达式，读它用的就是 `sexpr/read.js`，不另起一个
  词法层。`(tokens ...)` / `(prec left ...)` / `(start N)` / `(lex ...)` / `(rule N (-> (RHS...) 模板))`。
  动作是**纯 s-expr 模板**（`$1`..`$n`），这是与 bison 最大的分野：动作没有副作用，
  于是分叉后不必延迟求值，`yySemanticOption` 那整套机器（含 lookahead 快照与
  沿 `yypred` 的深递归）一条都不需要。上面那两条「必须明说的坑」因此不适用于我们。
- `lex.js` —— 数据驱动的词法器。**不用正则**：封闭 ABI 里只有从字面量降下来的
  `js_re_test/match/split/replace`，`new RegExp(str)` 不在表里，而语法文件里的模式是
  运行期才知道的字符串。于是模式语言是一把字符类原语（`digit/alpha/alnum/hex/space/any`、
  `(set ..)` `(not ..)` `(or ..)` `(seq ..)` `(* ..)` `(+ ..)` `(? ..)`），贪心不回溯 ——
  flex 生成的 DFA 也不回溯，这不是能力上的退让。规矩照 flex：最长匹配优先，等长则声明在前的赢。
- `table.js` —— SLR(1) + bison 那套优先级消歧。**选 SLR 而不是 LALR** 的理由写在文件头：
  在 GLR 驱动下两者接受的语言完全相同，差别只是「错的那支什么时候死」，也就是速度。
- `driver.js` —— 单前驱 GSS，逐 token「归约到不动点 → 接受检查 → 移进」。合并条件比
  bison 严一点：状态、前驱、**值**三者都相同才算同一支；值不同就两支都留，最后才好说清楚
  是哪两棵树。硬边界照收：两支都活到接受就报错，不猜。

CLI 两条命令：`omni glr-table F.grammar [--brief]`、`omni glr F.grammar F`。

**第八条测试轴** `tests/glr/`：表的快照、每条输入的树、以及两道方向相反的门槛 ——
`lookahead.grammar`（SLR 不够但语言不歧义）**必须**留下冲突且两支输入都要过，
`dangling.grammar`（真歧义）**必须**撞上硬边界。

**自举链阶段 9** 让原生编译器自己跑一遍 `glr-table` / `glr` / 真歧义报错，三者与 C0 逐字节
相同。这道门槛当场抓出四处封闭 ABI 违规（`new Map(map)`、`splice`、`unshift`、`Infinity`），
全都是 node 上照跑、原生构建里才炸的那一类。

### 已落地的形状：第一门真实语言（asymptote）

`tests/glr/grammars/asy.grammar` 是从 `camp.y`（bison LALR(1)，721 行）与 `camp.l`
（flex，450 行）转写的：**78 终结符 / 55 非终结符 / 220 产生式 / 433 状态**，对上 bison
自己报的 77/54/216/427。转写做了七处实质改动，每处都在文件头写明理由；其中五处是把
bison **隐式**的选择写成**显式**的优先级声明 —— 悬垂 else、`f(x=1)` 里「命名实参
还是赋值表达式」、`(string)(n/2)` 是转换还是调用、`new real[]{1,2}` 里的花括号是数组初值
还是方向标。camp.y 靠 `%expect 4` 容忍这四处冲突，再吃 bison「冲突默认移进」的兜底；
我们没有那条兜底，所以必须写下来。SLR 留下 43 处冲突（LALR 只剩 4 处），差额全由运行期
分叉解决：`cases/asy.cases` 里 34 条真实片段（含路径连接 `..controls..and..`、
隐式缩放 `105cm`、C 式强制转换、命名实参、算符重载）全部只出一棵树。

**覆盖率是量出来的，不是挑出来的**：`tests/glr/run.js` 第 4 节把 asymptote 自带的
**84 个 `.asy` 模块**整批喂进去，每份都必须出且只出一棵树 —— 现在 84/84。这道门槛比
`cases/asy.cases` 硬得多，因为片段是我自己挑的，挑不到的地方正好就是漏掉的地方：第一次
量只有 **32/84**，缺口的绝大多数是 `operator` 一族（语料里 `operator init` 109 次、
`operator cast` 104 次、`operator *` 62 次……）。

那一族是**词法层**的事，这一点是照 camp.l 来的：它有一个 `opname` 起始条件，`operator`
把后面那个算符名吃掉，回一个名字叫 `operator +` 的 ID —— 于是 asymptote 的语法层根本不提
算符重载，而 `fold(operator +, a)`「把算符当值传」也顺带成立。我们的词法器没有起始条件
（那要求它带状态机），但这个模式只需要「前缀词 + 跨过空白 + 一个候选项」，够小，就照这个
形状加了一条规则：`(fuse ID "operator" "init" "cast" "+" ...)`，出来的 token 文本规范化成
`operator +`，跟 asymptote 内部的符号名一致。语料从 32/84 直接跳到 52/84。

剩下的 32 个模块栽在两处**真歧义**上（20 个报「两棵树」—— 16 个是花括号、4 个是
`(T)(e)`；另外 10 个因为分叉翻倍撞了 `MAX_PARSES`），就是上面第 5、6 条那两处；
补完优先级到 82/84。最后 2 个是
`from collections.iter(T=int) access ...` —— 参数化模块名带点，camp.y 那四条模板声明
写的是 `strid`，放宽成 `name` 就齐了。三步下来 32 → 52 → 82 → 84，冲突数始终 43。

`glr` 多了一个 `--count`：只印一行摘要（token 数 + 节点数）而不印树。理由是量出来的 ——
84 个模块的树印出来是 133 MB，排版占掉 33 秒里的大半，而这道门槛要的只是「都出且只出一棵」，
节点数就够当那棵树的指纹。加上它之后这一节 1.8 秒。

**「完整等效实现 + 执行全部 asy 模块」这句话的四道门槛**，按依赖排，每道都要可量：

1. **解析覆盖 84/84** —— 已落地（上面这一节）。这是唯一「现在就能量」的一道，也是
   后三道的前提：树出不来，谈执行没有意义。
2. **非绘图部分的执行**，与真正的 `asy` 二进制逐字节比对：pair/triple、数组与切片、
   struct + `operator init`、重载解析、`write`。`asy` 装在机器上，所以这道门槛有现成的
   oracle —— 跟 `tests/oracle` 那条轴同一个口径。**第一刀已落地**（`tests/asy` 那一节）：
   int/real 算术与输出（含 `%.15g`）、两种引号的字符串、bool、控制流（含 `? :`）、函数、
   `write`、七个内建数学函数与 real 上的 `^`、**一维数组**（`new T[n]`、`{…}`、下标读写与
   自动扩长、`.length`/`.push`/`.pop`、数组当形参与返回值、**切片** `a[i:j]`、
   **`write` 一整个数组**、**for-each**）、**pair**（复数四则、
   `.x`/`.y`/`xpart`/`ypart`、`abs`/`length`/`conj`、int/real 到 pair 的隐式转换、
   `(x,y)` 的印法）、**字符串函数**（`length`/`substr`/`find`/`rfind`/`replace`/`erase`）、
   **`pair[]`**（数组那一整套操作在 pair 上一条不少）、**默认实参与命名实参**、
   **重载解析**（同型优先、转换算分、并列即歧义、候选按声明顺序可见）、
   **struct**（引用语义、隐式 `operator init`、字段默认值每次构造重求、`== !=` 比身份）、
   **pair 字段与数组字段**（第十五、十六刀：核心方言的类字段收 `(vec T N)` 与 `(arr T)`）、
   **内嵌记录字段**（第十七刀：`struct B { A a; }`、`b.a.x` 读写、任意层的点）、
   **`A[]`**（第十九刀：asy 的 struct 是引用类型，所以这是"一串句柄"；裸数组那一整套
   在它上面一条不少）、
   **struct 的方法**（第二十刀：`a.get()`，降成"多一个 this 形参的普通函数"；重载、
   默认实参、递归与普通函数同一条路）、
   **构造函数**（第二十一刀：struct 体里的 `void operator init(…)` 给出 `A(…)`）、
   **文件级的 `T operator init()`**（第二十二刀：换掉 `T t;` 的隐式构造，内嵌记录字段
   一并管）、
   **算符重载**（第二十三刀：`V operator +(V,V)` 降成叫 `asy__op_add` 的普通函数，
   于是重载解析那一套白捡；用户算符与内建的在同一张候选表里，同签名是替换），
   二十六份用例在五个执行器上与 `asy -noV` 逐字节相同。
   **还没做**的是给切片赋值、多维数组、复数幂、triple、`operator cast`、
   字符串的 `reverse`/`insert`/`split`、
   自引用字段、把方法当值取出来、struct 体里的算符，与 `operator init` 剩下的两种形态
   —— 每一条都在
   `tests/asy/bad/` 里有一份带 `ASY_NOPE` 的用例钉着，不是含糊的"待办"。
   超越函数（exp/log/trig）是**另一回事**：不是没做，是量过 libm 与 V8 在最后一位就分叉，
   收进来这条轴必然有一天变红，所以按边界拒掉（`tests/asy/bad/sin.asy`；pair 上的
   `angle`/`dir`/`expi` 同理，见下面 pair 那一节）。
3. **绘图层**：path/guide 的 Bezier（含 tension / 方向求解）、pen、transform、
   picture 的延迟绘制、EPS 输出。「执行全部 asy 模块」的大头在这里。**还没做。**
4. **jancy 核心语法与执行** —— 语法已经有（下一节），执行**还没做**；而且要先有一份
   jancy 源码树，否则 case 只能是我手写的片段，跟 asy 这边有 84 个真模块的处境不一样。

写下来是为了不含糊：第 1 道成立，第 2 道只成立到「标量 + 控制流 + 函数」这一刀，
第 3、4 道一个都没开始。语法覆盖率不等于「等效实现」。

**语法文件搬了家**：`asy.grammar` 从 `tests/glr/grammars/` 移到
`stage0/src/frontend-asy/`。理由是它不再只是这条轴的夹具 —— 第 2 道门槛要的
`omni run x.asy` 得读同一份文件，语法就是那门语言前端的一部分。`tests/glr` 照旧管它
（表快照 / cases / 语料覆盖三节），只是路径过一层 `gpathOf`。

**第 2 道门槛的口径是量出来的，不是照文档抄的**（`asy -noV` 逐条问出来的）：

- 实数默认输出是 `%.15g`：`1/3` → `0.333333333333333`，`sqrt(2)` → `1.4142135623731`，
  `0.1+0.2` → `0.3`。核心方言的 `print` 是 `%.6g`（ADR-0005），**对不上** ——
  所以这道门槛要么给核心方言加一个「按有效位数格式化」的节点，要么走 `js_str`。
- `bool` 输出后面**总带一个空格**：`true ` / `false `。（第一次量的时候只试了 `true`，
  记成了「补到 5 个字符」—— 那是错的，`write(false)` 是 6 字节。后来 `od -c` 逐字节看了
  `write("a",false)` → `afalse `，才定下"算符自带尾空格"这条。）
- 整数除法是 `#` 且**向下取整**，`%` 的符号跟着除数：`-7#3 = -3`、`-7%3 = 2`、
  `7%-3 = -2`。核心方言的 `/` 是截断、`%` 是 C 语义（量过：`-7/3 = -2`、`-7%3 = -1`），
  所以这两个算符要降成小 helper 函数，不能直接映射。
- `/` 作用在两个 int 上得到 **real**（`1/3` 不是 0）。整数商只能写 `#`。
- `^` 是幂而不是异或（`2^10` → `1024`），核心方言的 `^` 是异或 —— 同样要降成 helper。
- `write` 的形状是 `write(string s="", T x, T[] more..., suffix=endl)`：`s` 与第一个 T
  之间**没有**分隔符，T 与 T 之间是**制表符**，而所有 T 必须**同型**。逐条量过：
  `write("a",1,2)` → `a1⇥2`、`write("a","b","c")` → `ab⇥c`（第一个串被前缀吃掉了，
  剩下两个才是 T=string）、`write("s",true,false)` → `strue ⇥false `；而
  `write(1,"b",2)` / `write("a","b",1)` / `write(true,"x")` 都是
  `no matching function` —— 这些错也是要复现的行为。
- 双引号串是 **verbatim** 的：只有 `\"` 是转义，`\t` 就是反斜杠加 t（asy 要把串直接塞给
  TeX）；单引号串才走 C 转义。`\\` 是特殊的一对：两个反斜杠都留在值里，但它不让后面那个
  引号变成转义 —— `"\\"` 是 2 字节且正常收尾，`"a\\\"b"` 是 5 字节 `a\\"b`。
- 前向声明**不是**前向声明：`bool odd(int n);` 声明的是一个函数类型的变量并初始化成 null，
  跑到就是 `dereference of null function`。所以 asy 里写不出互递归（这条是写用例时撞出来的）。

按这些量出来的口径，第 2 道门槛的第一刀（int / bool / string + 控制流 + 函数 + 单参
`write`）需要核心方言补两处，两处都是「C 系语言都要的」而不是为 asy 特设的，**都已落地**：

- `(brk)` / `(cont)`：OIR 早有 `Break` / `Continue`，方言一直没开口。实现只有
  「构造器一个 `loopDepth`、`while` 前后加减、判它是不是 0」三处。
- `(tostr E)`：数值/布尔 → 字符串。OIR 的 `to_string` 也早就在，四个消费方都认；
  加它是因为「把数拼进一句话里」在这一层原先写不出来，而那是任何语言的
  `write("x = ", x)` 都要的。刻意**不**做隐式转换：`+` 两边照旧必须同型。
  它同时补掉了 LLVM 后端里一处刻意留白 —— `RT_OPS` 原来没有 `to_string.{int,real,bool}`，
  理由写的是「没有一份 case 走得到，没测过的 ABI 断言和猜是一回事」。现在有 case 了，
  三条按 `omni_str = [2 x i64]` 那条规则加上，五条腿输出逐字节相同（量过，不是推的）。

**real 的格式对上了**：`(tostr E N)` 按 **N 位有效数字**格式化（N 只收 1..17 的字面量：
位数是格式的一部分，不是运行期才知道的东西）。asy 那边就是 `(tostr E (int 15))`，逐条量过
都相同：`1/3` → `0.333333333333333`、`sqrt(2)` → `1.4142135623731`、`1e-5` → `1e-05`、
`-0.0` → `-0`、`1.23456789012346e+17`。这一刀动了六个地方，都是"接上已有的那一份"而不是
新写一份浮点格式化：`omni_str_realg`（C 运行时的 `%.*g`）、`$str_real_g`（JS prelude 的
`$fmt_g`）、`fmtRealG`（node 宿主）、`js_fmt_real_g`（js_abi，给解释器）、LLVM 的
`RT_OPS['to_string_g.real']`、以及 MIR ——  MIR 的 `CALLOP` 名字是从 OIR 直接带过去的，
所以那条腿一行没改就通了。默认的 `(tostr E)` 仍然是 `%.6g`（ADR-0005 那条"看值用的"规则
没动）。

**real 上的数学函数**：`(rmath "NAME" A [B])`，白名单只有七个 —— `sqrt` / `fabs` /
`floor` / `ceil` / `round` / `pow` / `fmod`。白名单不是保守，是**量出来的**：这条轴要求五条
腿逐字节相同，而宿主的 libm 和 V8 并不是同一份实现。量的结果是 `sqrt` 相同（IEEE 规定它
唯一正确）、`fabs`/`floor`/`ceil`/`round`/`fmod` 相同（都是精确运算）、`pow` 80 组随机
输入 0 差异；而 `atan`/`tan`/`log`/`cos` **在最后一位（1 ULP）就分叉**，所以 exp/log/trig
一个都没收。收进来会得到一份"大多数输入都对"的实现，那比拒掉难查得多。

第一次量出来的 pow/fmod"差异"是假的：C 那边用表达式算输入，clang 合成了 FMA，两边比的
根本不是同一个 double。用 `float.hex()` 的位精确字面量重跑才是 0 差异 —— 记在这里是因为
这类"测量方法本身有 bug"的坑会重复踩。

落地同样是"接上已有的那一份"：`omni_math.c` 的七个 `omni_r_*` 包一层 libm、JS prelude 的
`$r_*` 全部走同一个 `$js_math`（`round` 那条要自己绕过 `Math.round` 的向上舍入：C 是**离零**
舍入，`-2.5 → -3`）、解释器走 `callJsOp('js_math', …)`、LLVM 补七条 `RT_OPS`，MIR 照旧
一行没改。asy 的 `sqrt/fabs/abs/floor/ceil/round/fmod` 和 real 上的 `^` 都降到它；
`floor/ceil/round` 回 **int**（量的：`int i = floor(2.7)` 编得过），所以外面再套一层
`(toint …)`；`abs(int)` 走一个 `asy__iabs` 的纯整数比较，绕一趟 real 会在 2^53 以上丢精度。

**可增长数组**：`(arr int|real|bool|string)` 加六条 —— `(anew TYPE N)` / `(aget a i)` /
`(alen a)` / `(apop a)` 是表达式，`(aset a i v)` / `(apush a v)` 是语句。加它的理由只有一个：
asy 的 `T[]` 在那 84 个模块里无处不在，门槛 2 的下一刀绕不过去。

**字符串的三条原语**：`(slen E)` / `(ssub E I N)` / `(sfind E T)`。这一条最便宜，
理由值得记下来：OIR 里 `len` / `substr` / `indexOf` 三个 Builtin **本来就在**（JS 前端
一直在用），方言只是没开口。于是四条腿（run / run-c / interp / interp --mir）**一行执行
代码都没加**就通了 —— 特别是 MIR 那条：`mir/from_oir.js` 把 Builtin 降成带单态化名字的
`CALLOP`（`len.string`、`substr.string`），`mir/interp.js` 再把它路回 OIR 解释器同一个
`applyBuiltin`。所以"加一个内建"的成本只在 **LLVM** 那条腿上。

LLVM 那边要三行 `RT_OPS`（`len.string` → `omni_str_length`、`substr.string` →
`omni_str_sub`、`indexOf.string` → `omni_index_of`，签名按 `omni_str = [2 x i64]`
那条规则），外加 `omni_str.c` 里**两个真符号**：`omni_str_len` 和 `omni_substr` 在
`omni.h` 里是 `static inline`，C 后端内联掉它们，但 LLVM 发的是 `call` —— 链接期就没有
这个符号。所以补了 `omni_str_length` / `omni_str_sub` 两个薄包装。`omni_str_cmp` 不用管：
那条路径 LLVM 直接发 memcmp。这类"C 后端能用而 LLVM 不能用"的静态内联是 ADR-0011 那条
封闭 ABI 的一个副作用，写在这里免得下次再撞。

**数组的元素放宽到向量**（`(arr (vec real 2))`，第八刀的 `pair[]`）。这一条的难点不在
前端那行检查，在**元素的 C 结构体是逐形状生成在生成的 .c 里的**，而 `omni_arr.c` 是
预编译的运行时 —— 上面那四份 X 宏单态在那里展开不出 `omni_vec_real_2`。两条看起来能走
的路各有一个坑：

- "让 C 后端逐形状生成一整份数组实现"（像 `buf` 那样）：run-llvm 那条腿只能 `call`
  运行时里的符号，于是增长逻辑、越界消息会有两份 —— 正是 `omni_arr.c` 开头说的
  "必然分叉的地方"。
- "把向量结构体挪进 omni.h"：形状是开放的（2/4/8 道 × int/real），运行时不该知道
  上层用了哪几种。

落地的是第三条：运行时多**一份按字节的实现** `omni_arr_blob_*`，头里多一个 `esz`，
`_at`/`_push`/`_pop` 回的是**格子的地址**，值从不经过运行时。长度、容量、倍增、
三句错误消息都还是只有一份（与标量那四份逐字相同）；元素的读写落到两条腿各自的
一条 load / 一条 store 上 —— 而那用的就是它们发局部变量读写的同一份类型映射，
"数组里的向量和局部变量里的向量不一样"这种分叉在结构上不成立。C 那条腿是
`arrLines()` 逐形状发六个 static inline 包在 blob 外面，LLVM 那条腿是
`arrBlobInsn` 直接发 call + load/store（`anew` 的零值要一个地址，承载它的 alloca
一律发在**入口块**、每种元素类型一个 —— 发在 `anew` 那一行的话，循环里的 `anew`
每转一圈就多一块栈）。

**`(arr (arr T))` 仍然拒**，理由是 MIR：那一层元素类型只有**一个 8 位类型码**，
`(arr (arr int))` 与 `(arr (arr string))` 在那里是同一个码 —— 不是"少写几行"，是
类型身份丢了。向量元素能收恰恰因为道数就在那个码的高位上（`mkType(T_F64, 2)`）。
所以多维数组要等 MIR 有一处能带聚合身份的地方，`tests/sexpr/bad/arr-nested.sx`
把这条边界钉住了。（后话：那处地方在第十八刀有了 —— 数组指令的 aux 现在是数组类型号，
所以这条边界的理由换成了"每格要造一个新的，而 anew 的零值只求一次"，见「支持面第八阶段」。）

顺带修掉一处在标量元素下**不可观测**的隐患：两个 JS 侧的实现（`interp/builtin.js` 与
`backend-js/prelude.js`）把元素**原样**存进 JS 数组，而向量在 JS 侧就是一个 JS 数组 ——
C/LLVM 存的是 16 字节副本，JS 存的会是别名。现在存进去之前拷一份（判据是
`Array.isArray`：能当元素的类型里只有向量在 JS 侧是数组）。`anew` 里"同一个零值 push
N 次"是同一个问题的另一半。眼下没有"就地改一道"的操作，所以两者都还观测不到 ——
但这种"靠没人碰它才对"的正确性不该留着。

这一刀撞到一条**封闭 ABI 的新坑**，记在这里：`a.concat(b, c)`（多实参 concat）在 node 上
照跑，而 `js_abi.js` 里 `concat` 的 arity 是 **2** —— 自举出来的编译器上第三个实参不是
"再接一段"。症状离原因很远：`tests/bootstrap` 的 `N1 emit-c cli.js` 报
"dynamic value is list, expected dict"，而 15 条其他轴全绿。写成两次 `.concat(...)` 就好。
同类的坑（`new Map(map)`、`splice`、`unshift`、`Infinity`）上面那一节（自举那道门槛）
已经抓出过四处，这条是第五处：**能在 node 上跑通不等于在封闭子集里合法**。

**为什么不复用 buf**：buf 是按值传的 `{长度, 指针}`，引用语义靠"副本里的指针指向同一段
存储"得来 —— 但 push 要改**长度**，而长度在每份副本里各有一个，别名看不到。所以数组的
句柄必须是指针，len/cap/items 都在被指向的头里。buf 的形状一个字节都没动：GPU 那条腿
（StorageBuffer 里的 runtime array）要的正是按值的 `{len, ptr}`，而数组在 SPIR-V 上直接
被拒（堆增长在设备上没有对应物，`spirv 后端目前不支持 arr 形参`）。

**为什么不复用 `list<T>`**：list 是 `.omni` 那门语言的容器，带装箱进 dynamic、UFCS 方法表、
值语义拷贝规则一整套；更关键的是 **LLVM 那条腿根本没实现过 list**（`backend-llvm/emit.js`
里 grep 不到一处）。数组收成六条，五条腿就都能实现。

**实现只有一份，这是刻意的**：七个符号在 `stage0/runtime/omni_arr.c` 里按元素单态化成四份
（X 宏展开，源码一份），`run-c` 与 `run-llvm` 调的是**同一个符号的同一份机器码** ——
越界检查、倍增策略、错误消息都不存在"两条腿各写一份"的可能。buf 那边是"逐形状生成的
static inline C + 另写一份 IR 助手"，是两份实现；这次不重复那个决定。两个解释器共用
`interp/builtin.js` 的一份，JS 后端走 prelude 里同名的四个函数，消息文本与 C 那份逐字对齐。
量过：`array index out of range: 5 (length 2)`、`pop from empty array`、
`array length cannot be negative: -1` 三条在五条腿上逐字节相同。

踩到的一处 ABI：`bool` 在 LLVM 里，**形参写 `i1 zeroext`（属性在类型后）、返回写
`zeroext i1`（属性在类型前）**。两处都写成前者，clang 当场 `error: expected value token`。
这条记下来是因为它只在 `bool[]` 上出现，而四种元素里只有它这样。

### 已落地的形状：asy 前端第一刀（第十五条测试轴 `tests/asy/`，28 条）

`stage0/src/frontend-asy/lower.js`（约 1340 行）把 asy 语法树降成核心方言的**文本**，
`omni emit-asy x.asy` 印出那份文本，`omni run/run-c/interp/interp --mir/run-llvm x.asy`
直接跑它。为什么这里有一份手写的降级、而只靠 grammar 的那门玩具语言没有：语法那一半
确实一行代码都没写（asy.grammar 是从 camp.y 转写的），但 asy 的**语义**要类型 ——
`1/3` 是实数除法而 `1#3` 是整数商、`3 == 3.0` 要提左边、`write` 的分隔符取决于第一个
实参是不是字符串。类型是符号表的事，动作模板里没有符号表。

**判分的人不是我**：`tests/asy` 的二十六份用例（算术 / 字符串 / 两种引号 / 控制流 / 函数 /
real 的 %.15g / `? :` / 数学函数 / 数组 / pair / 切片与整数组输出 / for-each /
字符串函数 / `pair[]` / 默认实参与命名实参 / 重载解析 / struct / struct 的 pair 字段 /
struct 的数组字段 / struct 的记录字段 / `A[]` / struct 的方法 / 构造函数 /
文件级 operator init / 算符重载 / 用户算符与内建算符的关系）每份都是
「五条腿逐字节相同 == `.expected` == `asy -noV` 当场重跑」。`.expected` 本身就是真 asy 的
输出生成的；机器上没装 asymptote 时那一节打印 skip，但 `.expected` 仍然把答案钉住。

这一刀顺手改对了三处**先前记错或没做对的东西**，每处都是量出来才发现的：

- bool 的尾空格（见上）。原来照"补到 5 个字符"写的 helper 在 `write(false)` 上就差一个字节。
- `write` 的重载形状。原来的规则是"第一个实参之后不许再出现字符串"，被 `write("a","b","c")`
  当场推翻（真 asy 印 `ab⇥c`）。现在的规则是量出来的那条：第一个串是前缀，**其余实参必须同型**。
- 双引号串的 verbatim 语义。这条要动通用词法器：`(string NAME "Q" verbatim)` 多了一个
  可选标记，`\Q` 是转义、`\\` 是一对、别处的反斜杠原样留着。加它之前 84 个模块里的
  `"\ "` 和 `{'\n',"\\"}` 会把词法器带偏（当场从 84/84 掉到 54/84，这也是 `tests/glr`
  那条语料断言的第一次真正发挥作用）。这个标记是语言中立的：任何"给 TeX/正则用的原样串"
  都要它，不是为 asy 开的后门。

**`? :` 降成了语句**。核心方言里条件表达式不存在，于是前端摊成一个临时量加一条 if/else，
两支各自的前置语句放进各自那一支里 —— 嵌套的 `? :` 因此也不会被提到 if 外面，短路语义
（只算中选那支）跟着编码保住。代价写在明处：**循环条件里的 `? :` 直接报错**，因为那些
赋值只能落在循环外面，条件就只算一次了。这条边界在 `tests/asy/bad/cond-in-loop.asy` 里。

第一刀的边界都在 `tests/asy/bad/`（18 条，每条的期望值都必须以 `ASY_NOPE` 开头 ——
"还没做"和"做错了"必须能一眼分开）：triple、复数幂、`operator cast`、
模块（import/access）、隐式缩放（`105cm`）、超越函数（`sin`、pair 上的 `angle` ——
理由是上面那条 ULP 测量）、函数里读文件级变量（核心方言没有全局量）、
循环条件里的 `? :`、给切片赋值（`a[0:2] = b`）、多维数组、
字符串的 `reverse`/`insert`/`split`、struct 的三条（自引用字段 / 把方法当值取出来 /
`operator init` 剩下的两种形态：带形参的文件级那份、非 void 的那份）。

**for-each 的两条语义也是量出来的**：循环变量是**复制**（体里 `x = 99` 不动数组），
而迭代是**活的** —— `int[] g={1,2}; int n=0; for(int x:g){++n; if(n<5) g.push(9);}`
走了 **6** 轮、末了 `g.length` 是 6。所以降级绑的是数组**句柄**、每轮重读 `(alen …)`；
"先拷一份快照再走"那种实现只会走 2 轮，这条用例就是为了把那种实现挡在外面
（`cases/12-foreach.asy`）。`continue` 走的还是 C 式 for 那套「先跑更新再跳」。

**字符串函数的越界语义全是量出来的，而且跟直觉相反。** 直觉写法是"钳到合法区间"
（`substr("abc",-1,2)` 给 `"ab"`），真 asy 不是：越界的**起点**让整个调用静静地失败，
只有过长的**长度**才钳。逐条量的结果（`asy -noV`，24 行覆盖到每个负数与溢出组合）：

- `substr("abc",-1,2)` → `""`（不是 `"ab"`）；`substr("abc",1,-1)` → `""`（负长度不当
  "到末尾"）；`substr("abc",5,1)` → `""`；`substr("abc",1,99)` → `"bc"`（长度钳到末尾）。
- `find("abc","b",-5)` → `-1`（不是 `1` —— 负起点不当 0）；`find("abc","",3)` → `3`。
- `erase("abc",-1,2)` → `"abc"`（原串不动）。
- `replace("aaa","aa","b")` → `"ba"`（从左往右**不重叠**地替换）；空针不换。
- `length(int[])` 在 asy 那边是 `no matching function` —— `length` 只有 string 和 pair
  两个重载，数组的长度写 `a.length`。这一条落在 `strict/length-array`（第四节，不是 bad/：
  它不是"我们还没做"，是 asy 自己就没有）。

所以 helper 是照量出来的写的，六条腿共用同一份。`reverse` 刻意在门外：它是**按字节**倒的，
而 Omni 的 string 是 UTF-8 字节序列（ADR-0005）—— 非 ASCII 倒出来是一串坏字节，C 那条腿
原样吐、JS 那条腿看宿主怎么处理，"逐字节相同"这句话就保不住了。`insert`（越界行为还没量全）
和 `split`（要 `string[]` 的返回值，跟 `pair[]` 是同一道坎）同样在门外，各有一份 bad/。

**第四节 `strict/`：asy 自己就不收的，我们也不能收。** 这一节是数组这一刀顺手加的，起因是
一次测量：`int b=1; b++;` 在真 asy 上直接编不过（"postfix expressions are not allowed"），
而我们的降级器照收。这类漏洞**不会让任何用例输出不同** —— 它只让"等价"这两个字变虚。
所以 `strict/` 里的用例要求：我们拒，且装了 asy 的话**真 asy 也拒**。现在有十三条：后缀
`++`、pair 上的 `<`、pair 上的 `%`（这两条 asy 报的是 "no matching function
'operator <(pair, pair)'"）、`length(int[])`（`length` 只有 string 和 pair 两个重载）、
按不存在的形参名给命名实参（asy 报 "cannot call 'void f(int a)' with parameter 'int b'"）、
**歧义的重载**（`p(real)` 与 `p(pair)` 遇上 `p(1)`：asy 报 "call of function 'p(int)' is
ambiguous"）、**引用后面才声明的函数**（asy 报 "no matching variable 'b'"）、
**`write` 一个 struct**（asy 报 "no matching function 'write(A)'"）、
**给 pair 的分量赋值**（`z.x = 5` 与 `a.p.x = 5`：asy 报 "virtual field is read-only"）、
没有 `void operator init` 时写 `A(…)`、在 struct 声明之前拿它当类型、
**记录上的大小比较**（只定义了 `operator <` 不白得 `<=`）、
**声明 `operator &&`**（asy 那边是 syntax error）——
中间那两条是重载这一刀加的，第二条尤其要紧：我们是两遍降级，不专门裁一刀就会比 asy
多接受一门语言。`write(struct)` 与 `z.x = 5` 是 struct 与 pair 字段那两刀加的，
它们守的不只是"拒"：
`write(struct)` 不在 asy 这层拦，漏出去的是核心方言那句
`(tostr E) 只接受 int / real / bool`——拒对了但理由指着错的一层。
最后两条是算符重载那一刀加的，都是我们先前**真的多收了**：`<=` 在记录上会 promote 回
记录名然后直接发 `(bin "<=" …)`（跑起来撞 JS 那条腿的 `< on class`），
而 `operator &&` 我们原来把它当"还没做"记在 `bad/` 里 —— 直到量了一次才知道 asy 的语法
本身就没有这个 token，于是那份用例整个搬到 `strict/`，诊断也去掉了 `ASY_NOPE`。

**默认实参是"每次调用求一次、只在没给时求"**，而且**能引用前面的形参** —— 两条都是量出来的
（`void d(int x = bump())`：`d(); d(); d(99);` 之后计数器是 2；`void q(int a, int b = a + 10)`：
`q(1)` 印 11）。所以默认值不能在调用点展开：它要在**被调方的作用域**里求。落法是按
"这次调用缺了哪几个实参"生成一个包装函数，形参就是给了的那几个，体里逐个
`(let 缺的 T 默认值)` 再调真函数 —— 前面的形参在那儿天然可见，没给才走包装。
同一形状只生一份，顺序按第一次用到，所以同一份输入两次降出来的文本逐字节相同。
命名实参乱序时（`two(b=show(1), a=show(2))`）先按**源码顺序**把每个实参绑到临时量再按
形参顺序传，否则核心方言的 `(call f a b)` 会把求值顺序改掉 —— 量过 asy 是源码顺序。

**重载解析（第十一刀）：候选表 + 打分 + 按声明顺序裁。** 核心方言没有重载，所以同名的第 2 个
及以后的候选在降级时改名成 `asy__ov<i>_<名>`（第一个保留原名，绝大多数函数不重载，输出的
文本因此跟以前一样好读）。挑哪一个是量出来的三条规则：

- **同型优先，一次隐式转换算一分，取最小**：`f(int)` 与 `f(real)` 都在时 `f(1)` 走 int 那份、
  `f(1.0)` 走 real 那份；只有 `h(real)` 时 `h(3)` 走提升。
- **并列就是歧义**：`p(real)` 与 `p(pair)` 遇上 `p(1)` 两边各要一次转换，asy 报
  "call of function 'p(int)' is ambiguous"，我们也报（`strict/overload-ambiguous`）。
- **同一份签名写两次是替换，不是错**：`int s(int x)` 之后 `real s(int x)`，`s(5)` 给 `2.5`。
  所以 `sig()` 里同签名是覆盖，而 `func()` 认候选按**节点身份**认 —— 被覆盖掉的那份不发。

实参**只求一次**：先按源码顺序把每个实参（连它摊出来的语句）求出来攒着，再拿类型去挑候选，
挑定了才把语句放回去。求两次会让 `g(show(1))` 那种带输出的实参印两遍。重载与默认实参是**一起**
解析的：候选的"缺了哪几个"由 `fit()` 给出，缺的那几个走上面那套包装函数。

**asy 的名字解析是顺序的**，这一条不改就会比 asy 多接受一门语言 —— 量出来的两条证据：
`int a(int n){ return b(n)+1; } int b(int n){...}` 报 "no matching variable 'b'"；
`int rec(int n){ ... rec(n-1,2) ... } int rec(int,int)` 报 "cannot call 'int rec(int n)'
with parameters 'int, int'"。我们是两遍降级（先收签名再降体），天然看得见后面的声明，所以每个
候选记一个声明下标，降每个函数体/每条主语句时记住"现在在第几项"，`visible()` 只交出
`c.at <= this.at` 的候选。等号是故意的：一个函数看得见自己，单函数递归 asy 允许。连带的一条
好处是内建名字的遮蔽也对了 —— 用户把 `sqrt` 定义在后面时，前面那句 `sqrt(...)` 走的还是内建
的那个，因为 callExpr 问的是"此处可见的候选"，不是"整个文件有没有同名函数"。
两条边界在 `strict/forward-ref` 与 `strict/overload-ambiguous` 里。

**struct（第十四刀）：asy 的 struct 是引用类型，所以降的是 `class` 而不是 `struct`。** 这一条
不量就一定写错 —— C/C++ 的直觉是值语义。逐条量的证据（`asy -noV`）：

- `A a; A b = a; b.x = 1;` 之后 `a.x` 也变了；`void f(A p){ p.x = 9; }` 改得到外面那个对象。
- `==`/`!=` 比的是**身份**：`a == b` 是 false、`a == a` 是 true、别名之间是 true。
- `write(a)` 编不过（"no matching function 'write(A)'"）——asy 自己也不给 struct 印。

核心方言那一层刚好有两种聚合：`(struct …)` 的值语义只由 `from_oir` 里显式的 `OP.COPY` 给，
而 `(class …)` 不发 COPY。所以 asy 的 struct 对应的是后者，五条腿的引用语义是白捡的，前端
一行拷贝代码都没有。

**`A a;` 隐式跑一遍 `operator init`**，等于 `new A` 加上字段默认值；而字段默认值是**每次构造**
求一次 —— 量法是把默认值写成一个带输出的函数调用，构造两次就印两次。所以有默认值的类型会
生成一个 `asy__new_<T>` 包装（每个类型只生一份，`recInits` 记着），`A a;` 降成对它的调用；
没有默认值的类型直接降 `(cnew A)`，不多生一个函数。

**字段这一刀只收 int/real/bool/string**，五条边界各有一份 `bad/`：pair 字段、数组字段、
嵌套 struct 字段、成员函数、`A[]`。前三条卡在核心方言而不是 asy 前端 —— 每条腿的"类零值"
各是一个只认标量的小函数（`backend-js` 的 `zero`、`backend-c` 的 `zeroExpr`、`interp` 的
`zeroOf`），要放开就得同时改三处，那是下一刀的事。
（后话：这五条在第十五、十六、十七、十九、二十刀依次全放开了，见下面「支持面第五到第九
阶段」；留在门外的只剩第十七刀新划的**自引用**与第二十刀收窄出来的"把方法当值取出来"。）

**复合赋值的接收者只求一次**：`a.x += f()` 里 `a` 不能求两遍，所以 `(field …)` 形式的左值在
`assignFld` 里单独走一条路（先绑接收者再 `(fldset …)`），而 `(field …)` 出现在需要重复求值的
位置时直接 `nope` —— 不猜。


**数组这一刀的语义全是量出来的**（`asy -noV`，逐条问）：

- `a.push(v)` **返回压进去的那个值**（`int x = c.push(9);` 编得过且 x 是 9）；`a.pop()` 返回
  被摘掉的那个。核心方言里 `(apush …)` 是语句，所以前端摊成"绑临时量 + apush + 用临时量"。
- **写下标会把长度顶到 下标+1**：`int[] e; e[2]=5;` 之后 `e.length` 是 **3**。所以每个下标写
  前面都插一次 `asy__grow_元素`（四种元素各一份 helper）。
- 数组和下标都**只算一次**：复合赋值要读一次写一次，`a[f()] += 1` 里的 f 不能调两遍，
  所以两者都先绑临时量（用 `? :` 那套 `this.pre`）。
- `a.length` 在语法上不是 `(field …)` 而是**带点的名字**（camp.y 的 `name -> name "." ID`），
  `c.push(8)` 同理是"调用一个带点的名字"。这不是猜的，是照着树写的。
- **一处明写的差别**：asy 的每个格子带"写过没有"的标记，`new int[2]` 之后读 `a[0]` 是运行期
  错误（"read uninitialized value from array at index 0"）；我们填零值。这类程序本来就有
  bug，但差别写在明处（`frontend-asy/lower.js` 的文件头与 `cases/09-arrays.asy` 的注释里）。

**整数组的输出与切片**（`cases/11-arrays2.asy`，还是量出来的）：

- `write(a)` 每行是「下标 `:` TAB 值」；`write("P",a)` 的前缀**自己占一行**（不是贴在第一行
  前面 —— 这跟标量那条规则不一样）；多个数组**并排**印，行数按最长那个，短的到头就不印了；
  空数组什么都不印；`write(a,5)` 是 no matching function（数组不跟标量混）。
  这一条刻意不发 helper 函数而是摊成语句：数组个数是变的，helper 要按个数各发一份。
- 切片是**复制不是视图**（`b=a[0:2]; b[0]=99;` 之后 `a[0]` 还是 10），半开区间，
  右边界超长截到末尾（`a[2:100]` 给到末尾）。四种形状（`[i:j]`/`[i:]`/`[:j]`/`[:]`）落到
  两条 helper 上，接收者只印一遍 —— `f()[1:]` 不能把 f 调两次。
- 形状要按**项数**分不能只看头：语法里 `[:]` 与 `[i:j]` 的头都是 `slice`。
- 两条边界检查是明写的差别：`a[3:1]` asy 报 "slice ends before it begins"，我们给空数组；
  `a[-1:2]` asy 报 "invalid negative index in slice of non-cyclic array"，我们落到 `(aget …)`
  的越界检查上（也是运行期错误，只是话不一样）。

两处**明写的语义差**（不是漏，是这一刀不打算做那条运行期检查）：整数溢出按位回绕而不报错；
`2^-1` 返回 0，而 asy 报 "Only 1 and -1 can be raised to negative exponents as integers"。
第三处是这一刀量到的：**除以零**在 asy 是运行期错误，而且**实数除法也报**
（`1.0/0.0`、`(1,2)/0`、`(1,2)/(0,0)` 全是 "Divide by zero"），我们按 IEEE 出 inf/nan。

**pair 就是核心方言的 `(vec real 2)`**，没有为它加类型。第 0 道是 x，第 1 道是 y ——
向量的 `+ -` 本来就是逐道的，`(vlit …)` 是"造一个"，`(lane …)` 是"取一个分量"，
正好对上 pair 的构造与 `.x`/`.y`。剩下的是 **asy 的语义**、不是"向量"的语义，落在这一层的
七条 helper 里（`asy__pmul` / `pdiv` / `pabs` / `pconj` / `pneg` / `peq` / `pairstr`），
六条腿共用同一份文本，所以不会分叉。代价写在明处：`pair[]` 没有（`(arr T)` 的元素只收标量）。

**每条语义都是量出来的，而且推翻了两个想当然**：

- `*` 和 `/` 是**复数**乘除（`(1,2)*(3,-4)` 是 `(11,2)`，`(1,2)/(3,-4)` 是 `(-0.2,0.4)`）。
- 用的是**朴素**公式，不是防溢出的 Smith 算法：`(1,1)/(1e200,1e200)` 是 `(0,0)`
  （分母平方和溢出成 inf），`abs((1e200,1e200))` 是 `inf`（所以也不是 hypot）。
  两条都要照抄那个形状，否则最后一位甚至整个量级都会差。
- **asy 没有 `pair op real` 这一族重载**：实数先被隐式转成 `(v,0)`，再走复数运算。
  判据是 `(1e300,1)/1e300` 印 `(nan,0)` —— 逐分量除法给的会是 `(1,1e-300)`。
  `2*(1e308*10,1)` 印 `(inf,nan)` 也是同一条（逐分量会是 `(inf,2)`）。
  这条一开始是按"有标量重载"写的，被这两次测量推翻。
- `write` 的 T 也跟着这条隐式转换走：`write(3,(1,2))` 印的是 `(3,0)⇥(1,2)`。
- `realpart`/`imagpart` **asy 自己就没有**（"no matching variable 'realpart'"），所以这里
  也没有 —— 补上就是比 asy 多接受一门语言。取分量只有 `z.x`/`z.y`/`xpart`/`ypart`。
- `unit` **能**用 sqrt 加除法写出来，但量不出 asy 用的是"乘倒数"还是"逐分量除"：
  两者在 `%.15g` 底下印得一样（找到的分叉点 `unit((758,188))` 也只差最后一位，印出来仍相同）。
  所以宁可不收也不猜 —— 猜错了，这条轴不会红，但"等价"是假的。

顺带被自举链抓到一条封闭 ABI 规矩：模块级的名字**全局唯一**。新写的 `opText` 与
`mir/print.js` 里同名的那个撞了，`C1 = C0 emit-js` 当场红，改成 `asyOpText`。

### 已落地的形状：第二门真实语言（jancy），以及为什么 `%dprec` 非要不可

`tests/glr/grammars/jnc.grammar` 是从 7 份 `.llk`（LL(2) + 外部 graco 生成器）转写的：
**176 终结符 / 63 非终结符 / 368 产生式 / 632 状态**，SLR 留下 1420 处冲突全交给运行期分叉。

jancy 值得单独记一段，不是因为规模，是因为它**推翻了本 ADR 原来的一条决定**。

它的 12 处 `resolver(...)` 里，9 处是 LL(2) 的补丁 —— 只能看两个 token，分不出
`{ x = 1 }` 里的 `x =` 是命名初始化项还是赋值表达式之类。这 9 处在这份语法里**一条都
没有对应物**：LR 的项集天生同时带着两条路，读到能区分的 token 时错的那条自己死。

剩下 3 处不是 LL 的毛病，是**语言真歧义**：

- `C1* c;` —— 声明一个指针，还是 `C1` 乘 `c` 这条语句？
- `(io.Role)(i & 1)` —— 强制转换，还是调用一个括号里的函数？
- `C1 c(x)` —— 构造实参，还是「形参是无名的 x 类型」？

三处都要求知道「这个名字是不是类型」。那是符号表的事，**任何 LR 语法都办不到**，
jancy 自己也是拿 `findType()` 去问符号表的。于是补上 `(prefer N)`（= bison 的 `%dprec`）：
偏好写在**规则上**，驱动本身仍然不猜 —— 没声明过偏好的两棵树照旧报错。实现只有三处：
`grammar.js` 多读一个标注、顶点上多一个沿栈累加的 `pref`、归约不动点之后按
`(状态, 前驱)` 分组剪掉严格低的那些（不剪会怎样是量出来的：七行连着写 `T* x;`
分叉翻到 128 支，撞 `MAX_PARSES`）。

另外记两处**代价明写下来**的取舍：

- 强制转换的偏好会让 `(a) - b` 判成「把 `-b` 转成 a 类型」。jancy 靠 `findType` 分，
  这一层分不了。
- jancy 的赋值是不对称的（左边只能是 `unary_expr`，右边是完整级联），所以那边
  `a + b = c` 是 `a + (b = c)`。一个 `expr` 加一块优先级表达不出这种不对称，这里取 C 的
  规矩（赋值最低、右结合），于是那一句变成 `(a + b) = c`。量过：528 份源码里没有一处依赖它。

覆盖率是这条决策目前唯一的硬数字：**jancy 自带的 528 份 `.jnc`（samples/ 51 + test/ 477）
里 526 份分析出唯一一棵树，0 处歧义**。剩两份，一份源码本身少了分号，一份是格式化字面量
`$"...$(f(x, "a:b"))"` 里嵌了带引号的子表达式 —— 后者是**明写的阶段边界**：`$"..."` 整块
当一个 token，内部不解析（jancy 自己也是先整块存 token 串等第二遍再展开）。

顺带记一处诊断上的改进：真歧义报错现在会指出**最小的那处分歧**
（`one parse says (var-decl ...), the other (expr-stmt ...)`）。只说「有两棵树」没法改语法。
这条是在调 jancy 语法时逼出来的，同时改掉了一个真 bug —— 模板节点原先带着**语法文件**的
span，于是报错会指到 `jnc.grammar:339` 那种地方去。

## 决策 3：LLVM 是 JIT 与 AOT 的首选后端；自写机器码不是主导
- **JIT**：ORC v2。按函数惰性编译，延迟量级 ~28ms/函数（上文推算，落地后要实测替换
  这个数）。抄 jancy 的集成形状（见借鉴与对照），但**不抄它的调用约定层** ——
  那十六个手写 CallConv 类是因为它要在 IR 层重做 sret/byval/coerce；
  我们的 ABI 只有一个（ADR-0013 决策 3 的单一 JS 签名 + `omni_dyn` 按值传），
  用 LLVM 默认的 C 调用约定就够。
- **AOT**：同一份 MIR → LLVM IR → 目标码。这是发布路径，取代现在的「发 C 再叫 clang」。
- **自写机器码降级为可选的第三档**（无 LLVM 的极小构建、或将来嫌 ORC 启动慢时的
  tier 0）。copy-patch 那套设计保留在文档里，但**不排进主线**。这是对第二稿的直接否定。
- LLVM 也给我们两样白拿的东西：**向量类型与合法化**（`<8 x float>` 由 LLVM 拆到 NEON，
  第二稿里我自己写的那个合法化 pass 只剩「C 备选路径标量化」这一个用途）、
  以及**SPIR-V 后端**（近几个版本转正，落地前需核对本机 LLVM 22 的支持范围）。

### 已落地（`stage0/src/backend-llvm/emit.js`，`omni emit-llvm / run-llvm / build-llvm`）

第一阶段是 **MIR → 文本 IR → clang**，只降标量 i64 / f64 / bool / void。

为什么先出文本 IR 而不是直接调 C API 建模块：这一层真正的工作量在**降级** ——
类型映射、槽位变 `alloca`、结构化控制流拆成基本块、`br` 的层数变具体标签。这部分与
用哪个 API 无关。而 ORC 那一步读的正是同一份文本（`LLVMParseIRInContext`），
于是 **AOT 与 JIT 共用一个发射器**，不会出现「C API 版」和「文本版」两份语义，
顺带省掉几百个 IRBuilder 的 extern-C 声明。「运行期不需要 cc」这条**还没兑现**，
它是明说的阶段边界。

语义对齐上有两处只能这么做：

- i64 的 `+ - * neg` 是**无符号回绕**（`omni.h:325..330`），LLVM 不带 nsw 的 `add`/`mul`
  正好是回绕，直接发指令即可。
- `/ % << >>` 在运行时是 `static inline`（`omni.h:329..343`），**不是可链接符号**，
  call 不到。所以移位量的 `& 63`、除零报错、`INT64_MIN / -1` 特判都在 IR 里原地重建
  （除零那条发成 IR 内的私有函数 `@omni_ll_div`，让 LLVM 自己决定内不内联）。
  少一条就是一个只在边角上出现的答案分叉，而这类分叉正是四方比对要抓的东西。

第十二条测试轴 `tests/llvm/`（7 条）钉两件事：能降的那五份 **`run-llvm` == `interp` ==
`run-c`**（stdout / stderr / 退出码三样都比，除零那份走的就是错误路径，三方同为 70）；
降不了的 22 份**必须报错且报在阶段边界上** —— 支持面写成一张显式清单，扩大时必须改表，
不能让它悄悄漂移。另有一份 IR 快照钉控制流的形状（层数算错、汇合点接错、死块漏标签
这三类错都只在 IR 文本里看得见）。

### 已落地（第二阶段：ORC JIT，`stage0/jit/omni_jit.c` + `omni run-jit`）

「运行期不需要 cc」兑现了：文本 IR 直接进 `LLVMParseIRInContext`，ORC 惰性物化，
查到地址就跳进去 —— 磁盘上不落目标文件、不链接、不 exec 新二进制。第十四条测试轴
`tests/jit/` 有一条断言专门盯这件事（`--work` 目录里跑完只该剩那份 `.ll`），
因为光比输出区分不了 AOT 和 JIT。

发射器**一行没改**。这是当初选文本 IR 而不是 C API 建模块的全部回报，也是两条轴
共用一张 `SUPPORTED` 表的理由：同一个发射器，支持面必须是同一张表，分开维护的话
某条路悄悄多支持一点没人拦得住。

**一处必须承认的边界，而且它不是偷懒：** ORC 那一段是一个独立的 C 程序，
node 与原生两侧都是 spawn 它，而不是编译器自己 in-process 调 libLLVM-C。
原因不是决策 4 那条 FFI 机制不够 —— 出参可以用 `malloc` + 一条 peek 绕，
真正拦住的是**封闭 C_ABI 里没有「按一个 ptr 间接调用」这条操作**，而 JIT 的
最后一步恰恰就是它。补上它等于把任意函数指针交给 JS 域，那是 ADR 级别的能力扩张，
不该顺手做。所以现在的分界是：**编译**这一半已经不需要 cc，**宿主**那一半还是 C。
形状上与 jancy 同构（它的 ORC 集成也只有 345 行），区别是我们连它那十六个
CallConv 类都不需要 —— 我们只有一个调用约定。

运行时符号（`omni_print_int` 之类）**不逐个注册**（jancy 的 `createBareJITDylib`
那条路要手写几十条）：运行时的 `.o` 就链在宿主进程里，交给 ORC 的
`LLVMOrcCreateDynamicLibrarySearchGeneratorForProcess`。macOS 上要加
`-Wl,-export_dynamic`，否则可执行文件的符号不进动态符号表，ORC 找不到。
这条正好是 ADR-0013 那个 C-FFI 主张的现场证明：**JIT 出来的代码直接 call 到 C，
中间没有一层胶水、没有一次装箱** —— 换成 v8 那种 GC 堆，这里必须有一层。

`LLVMInitializeNativeTarget` 一族是 `Target.h` 里的 static inline，不可链接；
宿主是 C 所以直接用宏。（这与第一阶段 `omni_add`/`omni_div` 那条坑同源：
LLVM 与我们的运行时都爱把热函数写成 static inline，跨语言用的时候都得留意。）

宿主本身要编一次（约 1s），按 `[cc, LLVM 版本, 源文件, 运行时 .o]` 做内容寻址缓存，
和 `runtimeObjects` 同一套路。自举链第 10 阶段加一条 `N1 run-jit == C0`；
环境里没有 libLLVM 就跳过 —— 这条不该让整条自举链变成"必须装 LLVM"。

**还没做的**：验收门槛 5 要的是六方比对 + 同进程内解释与 JIT 混合执行 +
单函数 JIT 延迟上界。现在只有四方（jit / aot / interp / omni-c）和整模块粒度。
混合执行要先有 in-process 宿主（即上面那条能力扩张），延迟上界要先有按函数
物化的入口 —— 两件都排在后面。

### 已落地（支持面第二阶段：字符串）

「阶段」在这条决策下有两个互不相干的轴，别混：**支持面**（能降 MIR 的哪些类型）
与**装载方式**（AOT 走 clang / JIT 走 ORC）。上一小节是后者的第二步，这一小节是前者的。

支持面第二阶段的关键不在代码量（发射器多了 60 行），在 **ABI 必须量出来而不是猜**。
`omni_str` 是 `{const char *p; int64_t len;}`，16 字节；clang 在 AArch64 上把它降成
`[2 x i64]` 按值传。这不是建模选择，是必须复刻的事实 —— 做法是写一份只调那几个
运行时函数的 C，过一遍 `clang -S -emit-llvm` 看它发什么签名。顺带量到了下一步的答案：
`omni_dyn` 是 24 字节（`int tag` + 16 字节 union + padding），**超过 16 就走间接传** ——
入参是 `ptr`，返回是 `sret`。所以 dyn 不是"再加一个类型码"，是另一套调用形状。

字符串常量发成一段 `[N x i8]` 私有全局，值是一个**常量表达式**
`[2 x i64] [i64 ptrtoint(ptr @.omni_s0 to i64), i64 N]`。能这么写（而不是在函数入口
alloca 再 store 两次）是因为 `ptrtoint` 作用在全局上是合法常量表达式；于是字符串常量
和整数常量在发射器里走同一条路，`val()` 的调用者不需要知道类型。

UTF-8 编码提到了 `host/utf8.js`，**两个后端共用一份**。原本它是 `backend-c` 的模块内
函数；复制第二份的下场可预见：某天一边改了落单代理项的处理另一边没改，症状是
「同一份源码在 C 与 LLVM 两条腿上印出不同字节」，而那正是多方比对要抓的东西。

`omni_str_cmp` 又踩到第一阶段那个坑的同一处：它是 `static inline`，call 不到。
所以在 IR 里重建成私有函数 `@omni_ll_strcmp`（memcmp 前 `min(len)` 字节，相同则
短者在前），逐句对着 omni.h:353..358。`memcmp` 本身是真符号。
相等/不等本可以短路成「长度不同直接 false」，**故意没这么写** —— 那会变成第二条语义
路径，与 C 那边不再是同一份代码，而这一层的全部风险就在边角上的分叉。

支持面的效果：**核心 s-expr 方言整套降得下来了**（它只有四个标量 + string，
没有容器也没有 dyn，正好是这一阶段的边界）。于是第十三条轴从四方一致升成
**五方**（run / run-c / interp / interp --mir / run-llvm），而这条轴顺带变成
「后端支持面覆盖整个汇聚层」的断言：方言加了新节点而 LLVM 没跟上，它立刻红。
tests/llvm 与 tests/jit 也各多两份 case（`01-core.sx`、`02-strings.sx`，
后者专门放了 CJK 与 emoji）。

阶段边界的报错字串统一成一个常量 `NOPE`（`llvm 后端目前不支持`），
两条轴按它判「拒得对不对」—— 措辞改了不会静默失配。
自举链加一条 `N1 emit-llvm sexpr/02-strings == C0`：非 ASCII 才走得到 utf8Bytes 的
多字节几支，而那几支只用加乘取模写（封闭 ABI 没有位运算），两代分叉的症状是
「原生编译器发的 IR 里字符串是乱码」，node 上永远看不出来。

### 已落地（支持面第三阶段：结构体，门槛 2 第十二刀）

核心方言这一刀开了 `(struct NAME (字段 类型)...)` / `(new NAME)` / `(fld E 字段)` /
`(fldset E 字段 E)` 四条，五条腿里有四条**一行没改** —— OIR 早就有 `ZeroStruct` / `Field` /
`Assign(Field)` 三个节点，解释器、JS 后端、C 后端、MIR 都各有一份现成实现（`.omni` 那门
语言一直在用）。这一刀真正的工作量全在 LLVM 那条腿，它之前对聚合是零支持。

**结构体在 LLVM 里是"一个指向自己那块内存的指针"，不是一等聚合值。** 这不是建模偏好，
是 MIR 定的：`FLDSET a b` 里的 `a` 是那个聚合的**值**，指令要就地改它（两个解释器那边
就是"在 JS 对象上写字段"）。一等聚合值是 SSA 的，`insertvalue` 出来的是新值，改不到原处 ——
要用它就得在发射器里反推"这个值是从哪个槽装载来的、再存回去"，一层脆弱的别名分析。
值语义不靠表示，靠 `from_oir` 在**右值位置**（含形参入口）发的 `OP.COPY`，所以
"句柄可变 + 显式复制"这套在五条腿上是同一个模型。

内存来自 **arena**（`@omni_ll_alloc`，缓冲那一节本来就要它），不是入口块的 alloca。
理由是返回值：`(fn mk () Point (ret (new Point)))` 里那块内存要活过 mk 的栈帧，
alloca 出来的会悬空。arena 从不回收，这与数组/字符串/class 一样，不是这一刀新引入的取舍。

字段偏移**交给 LLVM 算**：每个结构体发一条 `%s_Point = type { double, double }`，
访问是 `getelementptr %s_Point, ptr %p, i32 0, i32 <字段号>`，字段号就是声明顺序。
自己算字节偏移的版本要在这一层重建一份布局规则，而 C 那条腿用的是编译器的布局 ——
两份布局规则迟早在某个字段类型上分叉。`sizeof` 同理用 `getelementptr (T, ptr null, i32 1)`
再 `ptrtoint`，是常量表达式，不占指令。

**字段类型这一刀只收 int / real / bool / string。** 卡在这里的不是 LLVM，是另外三条腿：
每条腿的"结构体零值"都是各自一个小函数（JS 后端的 `zero`、C 后端的 `zeroExpr`、
解释器的 `zeroOf`），它们今天只认标量；数组字段还要先定"复制结构体时复制的是句柄还是
内容"（JS 后端的 `$cp_S` 是逐字段浅拷，asy 的 `T[]` 也是引用，两边一致，但那要写进用例
才算定下来）。`tests/sexpr/bad/struct-field-arr.sx` 与 `struct-in-struct.sx` 钉着这条边界。
（后话：这三条在第十五/十六/十七刀依次放开了，那两份 bad/ 也因此**通过**了，于是删掉
换成更窄的两条 —— `bad/struct-self.sx`（字段类型就是它自己）与 `bad/struct-fwd.sx`
（字段类型声明在后面）。「边界因为功能落地而通过」时删掉重划，而不是留着当摆设。）

顺带被推出来一件事：**`tests/cases/01_basics.omni` 整份能降了**（它原先被拒只是因为里面有
struct），输出与 run / interp / omni-c 逐字节相同，于是它进了 `SUPPORTED`，tests/llvm 变成
三方一致、tests/jit 变成四方一致的第一份 `.omni` case。这条不是我去加的，是 tests/llvm
第 2 节那句断言逼出来的 ——「降下来了却不在表里」和「其实支持却假装不支持」是同一个洞的
两半，那一节两半都盯。

### 已落地（支持面第四阶段：类，门槛 2 第十三刀）

方言又加了两条：`(class NAME (字段 类型)...)` 与 `(cnew NAME)`，`(fld …)` / `(fldset …)` 两条
读写复用。**与结构体只差一件事：引用语义** —— `from_oir` 的 `rvalue` 只给 struct 与 enum 发
`OP.COPY`，class 一条不发，所以赋值/传参/返回都不复制。

为什么两种都要：**asy 的 struct 是引用语义的**。量过 `struct A { int x; } A a = new A;
a.x = 5; A b = a; b.x = 7;` 之后 `a.x` 是 **7**，`void f(A q) { q.x = 99; } f(a);` 之后
`a.x` 是 **99**，而 `A c;`（不写 `new`）之后 `c == null` 是 **false**（asy 给结构体变量
隐式跑一次 `operator init`）。所以 asy 的 struct 对应 OIR 的 **class**，不是 OIR 的 struct；
把它降成值语义的那个会在"改了副本还是改了本体"上静静地给错答案。两个构造名字刻意分开
（`(new …)` / `(cnew …)`）：值语义和引用语义要一眼分得开，而不是回头去查那个名字是
`struct` 还是 `class` 声明的。`tests/sexpr/bad/cnew-struct.sx` 与 `new-class.sx` 是这条的两半。

LLVM 那条腿多的只有一处：**类的字段访问要判空**，`call ptr @omni_nullck(ptr %o)` 之后再
`getelementptr`。判空不在 MIR 里（没有 NULLCK 指令），C 那条腿也是发射时插的，所以这里
跟着插 —— 两条腿的行为才是同一份，而不是"一条腿段错误、另一条腿有诊断"。命名类型上
class 用 `%c_Foo`、struct 用 `%s_Foo`，与 C 后端的 `c_` / `s_` 前缀对齐。
`val()` 还补了一条：类的空引用常量（OIR 的 `NullRef`）发成 `null` —— 方言里写不出 null，
但"非 void 的函数掉出尾巴"会补一个零值 return，那条路走得到。

于是 `tests/cases/11_null_reference.omni` 也整份能降了（三条腿的 stdout / stderr / 退出码
逐字节相同：`1` / `omni: runtime error: null reference` / 70），进了 `SUPPORTED`。它盯的正是
「空引用在 C 那条腿上必须显式检查，否则是段错误、和 JS 的诊断分叉」，现在这句话对
LLVM 那条腿也成立了。

### 已落地（支持面第五阶段：向量字段，门槛 2 第十五刀）

结构体/类的字段从"四种标量"放宽到"四种标量 + `(vec T N)`"。**动机是门槛 3**：asy 的
`struct { pair p; }` 要它，而绘图层的 `transform`（六个 real）、`pen`、`path` 的控制点都是
同一个形状。这一刀是**四个"零值"函数各补一条臂**，不是新的 IR：

- JS 后端 `zero` → `$vsplat(零, N)`；C 后端 `zeroExpr` → `omni_vec_real_2_splat(0.0)`；
  解释器 `zeroOf` → 一个长度 N 的数组；LLVM `fieldZero` → `zeroinitializer`。
- LLVM `fieldTy` → `<N x T>`，与这条腿别处的向量表示是同一个；对齐不必操心，
  arena 后面就是 malloc。
- MIR 一个字节都没改：向量的宽度就在那 8 位类型码的高 3 位上，`FLD` 的 `t` 自带宽度，
  而字段类型仍然从类型池的 `oir` 元数据上取。

**一处真实的洞是这一刀补的**：JS 后端的 `$cp_S` 原来对非 struct 字段一律 `v.f`，
而向量在那条腿上的宿主表示是普通数组 —— 拷出来会**共用同一条道**，C/LLVM 那边拷的是
16 字节副本。现在 `$cp_S` 走的是 `copyOf`（enum 早就走它），向量字段发 `$vcopy`。
`tests/sexpr/cases/08-vecfields.sx` 里「复制之后原件与副本各写一道」那一段就是为了把
那种实现挡在外面，它同时进了 `tests/llvm/supported.js`（五方一致）。

**数组字段仍然在门外**，理由收窄到一句话：向量的零值是**常量**，数组的零值是一次
运行时调用（`omni_arr_*_new(0, 零值)`），而 LLVM 那条腿的 `OP.NEW` 现在只会
`store 一个常量`。嵌套聚合另外还欠"复制要递归下去"。`tests/sexpr/bad/struct-field-arr.sx`
与 `struct-in-struct.sx` 写着这两句（两份都在后面两刀里被删了 —— 功能落地，边界重划）。

asy 那一侧同一刀落地的是 **pair 字段**（`cases/18-structpair.asy`，与 `asy -noV` 逐字节
相同）。pair 上那一整套在字段上一条不少，两处是这一刀新发现的：

- `s.p.x` 是**三层的点**。词法上点是名字的一部分（`name -> name "." ID`），所以
  `dotQual` 原来只认"一层变量 + 一个字段"，遇到 `a.p.x` 直接报"认不出的带点名字"。
  现在它递归下去（接收者只可能是变量读或字段读，两者都没有副作用，所以重复求值无害）。
- `a.p *= 2` 必须走**复数**乘法。量过 `(4,5) *= 2` 是 `(8,10)`；`assignFld` 原来缺 pair
  那条臂，会先把 `2` 提成 `(2,0)` 再逐分量乘，给出 `(8,0)` —— 一条静默的错答案。
  现在字段复合赋值与变量复合赋值走同一个 `pairArith`。

反过来一条是**对齐**：pair 的分量是只读的虚字段（asy 报 "virtual field is read-only"），
所以 `a.p.x = 5` 要拒，且理由不能带 `ASY_NOPE`（那是"还没做"的意思）——
`tests/asy/strict/pair-field-set` 钉着它。

### 已落地（支持面第六阶段：数组字段，门槛 2 第十六刀）

字段再放宽一格：`(arr T)`。与向量字段正好相反，数组字段是**引用语义** —— 复制结构体
搬的是句柄，两个副本共用同一条数组。这一条五条腿是**白捡**的，因为每条腿的"拷一个
结构体"本来就是按字段类型分派的：解释器/JS 的 `copyOf` 对 `arr` 原样返回、C 是结构体
赋值拷指针、MIR 的 `OP.COPY` 走同一个 `copyOf`、LLVM 是逐字段 load/store 一个 `ptr`。

LLVM 那条腿多的是**一件真正不同的事**：数组的零值不是常量。所以 `fieldZero` 之外多了
一个 `fieldInit` —— 它可以往当前基本块里发指令，数组字段那一路发的是
`call ptr @omni_arr_<后缀>_new(i64 0, <元素零值>)`（向量元素走 blob 那份：
`omni_arr_blob_new(i64 0, i64 元素字节数, ptr null)`）。传 `null` 不是偷懒：
`omni_arr.c` 里那个 memcpy 循环跑 n 次，长度 0 时一次也不跑，所以零值那个指针没人读 ——
这句契约现在明写在 `omni_arr_blob_new` 的定义上方。不这样做的话，这条路要为一个
没人读的零值在入口块预扫一遍 `NEW` 再开 alloca。

asy 那一侧落地的是 `struct S { int[] xs; pair[] pts; }`（`cases/19-structarr.asy`，与
`asy -noV` 逐字节相同）。字段上那一整套数组操作 —— `push`/`pop`/`.length`/下标读写/
复合赋值/切片/for-each/`write` 整条数组 —— 与裸数组走同一条路，因为 `(fld …)` 出来的
就是那个句柄；第十五刀的 `dotQual` 递归正好把 `a.xs.push(…)`、`a.xs.length` 这些
"三层的点"也一并接上了。量到的两层共用（对象一层、句柄一层）写在用例里：
`S b = a; b.xs.push(1000);` 之后 `a.xs.length` 也变了。

**只剩两条边界**：struct 套 struct（复制要递归下去，而 LLVM 的 COPY 是逐字段
load/store）与成员函数（要 this 与闭包）。`tests/sexpr/bad/struct-in-struct.sx` 与
`tests/asy/bad/struct-nested.asy` / `struct-method.asy` 钉着。
（后话：这两条在第十七刀与第二十刀依次放开了，那三份 bad/ 也因此**通过**了，所以删掉 ——
成员函数并不需要闭包，只需要"多一个 this 形参"这层糖；真需要闭包的是把方法**当值**
取出来，`tests/asy/bad/fn-value.asy` 现在钉的是那一条。）

### 已落地（支持面第七阶段：内嵌聚合，门槛 2 第十七刀）

字段最后一格：**另一个结构体/类**。`(struct Line (a Point) (b Point))`、
`(class Node (p Point))` 都收，`(fld …)` / `(fldset …)` / `OP.COPY` 一路照走。
动机还是门槛 3：`path` 是一串控制点、`transform` 装在 `pen` 里，绘图层没有一层是平的。

LLVM 那条腿这一刀有**一个真正新的表示决定**：内嵌结构体字段就是**那个命名类型本身**
（`%s_Line = type { %s_Point, %s_Point }`），不是指向它的指针。三件事因此变简单：

- `FLD` 变成一条**光秃秃的 `getelementptr`**，后面不跟 `load` —— 取出来的就是那块内存的
  地址，而这条腿的"结构体值"本来就是"指向 arena 的指针"，两者是同一件东西。
- `COPY` 于是是 `load %s_Point` / `store %s_Point`，LLVM 的**头等聚合**替我把递归复制
  展开了；我不必在发射器里写一遍"逐字段递归下去"。
- `NEW` 的零值靠 `aggZero` 递归：内嵌字段就 GEP 进去再往下铺一层，不是发一次
  `omni_ll_alloc`。所以一个 `(new Line)` 仍然只有一次分配。

反过来的代价写在明处：内嵌是**值语义**（那一格就在父对象里），所以内嵌一个 `class`
字段仍然是 `ptr` + 访问点判空 —— 两种语义在字段上也分得开，跟 `(new …)` / `(cnew …)`
那对构造名同一条理由。

字段类型只收**前面已经声明过**的那个：自引用与前向引用的零值会无限递归。核心方言这边
为此在 `run()` 里先扫一遍所有聚合名（`aggLater`），好让"声明在后面"和"根本没这个类型"
给出不同的诊断 —— `tests/sexpr/bad/struct-self.sx` 与 `struct-fwd.sx` 是这两半。

asy 那一侧落地的是 `struct B { A a; }`（`cases/20-structnest.asy`，与 `asy -noV` 逐字节
相同）。三件事是量出来才对上的：

- **内嵌记录要跑 `operator init`**：量过 `struct B { A a; }` 之后 `b.a.y` 是 A 的字段
  默认值，不是空引用。所以"有记录字段"和"有默认值"一样会逼出 `asy__new_<T>` 包装，
  里面把内嵌对象一个个造出来。
- **`f(x).字段 = v` asy 收**（struct 是引用类型，返回的就是句柄），所以 `assign` 不再
  只认"普通变量的字段"；复合赋值先把接收者绑成临时量，免得函数调两次。
- **`?:` 的两支是记录时**要一个临时量的初值，而记录的"零值"只能是一个对象 ——
  发的是 `(cnew T)`（不跑默认值：那个对象一定会被两支之一覆盖，语义上看不见）。
- 反过来一条是**差别**，不是对齐：`struct A { A next; }` **asy 收**（量过印 0 退 0，
  它的字段是懒的），我们拒。`tests/asy/bad/struct-self.asy` 钉着，理由带 `ASY_NOPE`。

`tests/asy/bad/struct-nested.asy` 因为这一刀**通过**了，所以删掉换成上面那份自引用；
`tests/cases/03_structs.omni` 同理整份能降了，进了 `tests/llvm/supported.js`（四条腿
stdout/stderr/退出码逐字节相同）—— 又一次是 tests/llvm 第 2 节那句双向断言逼出来的。

### 已落地（支持面第八阶段：类元素的数组，门槛 2 第十八/十九刀）

`(arr T)` 的元素从"四种标量 + `(vec T N)`"放宽到"再加一个**类**"。动机是 asy 的 `A[]`
（asy 的 struct 是引用类型，所以那就是一串句柄）与门槛 3 的 picture（一串绘图命令）。

这一刀先要改 **MIR**，因为原来的编码在这里第一次不够用了：数组的元素类型只有指令的
那 8 位类型码，而 T_AGG 里 **struct（值语义）与 class（引用语义）是同一个码**。照那个码
发指令就只能猜"格子里躺的是内容还是句柄"，猜错是静默的错答案。改法是把数组那五条
（ANEW / AGET / ASET / APUSH / APOP，ALEN 不看元素）的 `aux` 变成**数组类型号** ——
指向模块的类型池，元素的完整 OIR 类型挂在池项的 `oir` 上。三处配套：
`bytes.js` 的 `auxDigest` 把这五条也算进"aux 是类型号"那一支（否则增量哈希会退化成
按数字比，`type:arr_Node` 这个事实进不了哈希）、`verify.js` 加同一句越界检查、
`ir.js` 的 op 表把 aux 的角色写清。**这同时是多维数组的前置条件**：身份从此不缺了，
`tests/sexpr/bad/arr-nested.sx` 的理由因此换了一条（见下）。

五条腿的代价很不对称：

- **JS / 两个解释器 / C：一行没改。** 类元素是引用语义，`arrCopy` 那句
  `Array.isArray(v) ? v.slice() : v` 对一个对象原样返回 —— 要的正是这个；C 那边元素的
  C 类型是 `c_Node`（`OMNI_REF_DECL` 早就把它 typedef 成指针了），blob 的
  `sizeof(c_Node)` 就是 8，赋值就是拷指针。
- **LLVM：一处新表示。** 元素走的还是那份按字节的 blob，但步长是**一个指针**（8），
  元素的读写是 `load ptr` / `store ptr`。分派不再看类型码的道数，改成问类型池：
  `arrRep(aux)` 回 `{blob, ety, esz}`，向量那一支是 `<N x T>` / 道数×8，类元素这一支是
  `ptr` / 8。入口块那些承载"零值地址"的 alloca 也跟着按 `ety` 去重（原来按类型码）。

**结构体元素仍然在门外**，理由收窄到一句话：那是值语义，格子里躺的是内容，于是
`anew`（零值铺满 N 格）、`aset`、`apush` 三处都要按元素类型拷一份 —— C 与 LLVM 白捡
（结构体赋值 / 按字节 memcpy），但 JS 与解释器那两条腿的 `arrCopy` 是**类型擦除**的，
拷不动一个普通对象。`tests/sexpr/bad/arr-elem-struct.sx` 写着这句。
**多维数组**的理由也换了：身份有了，缺的是"每格造一个新的" —— `anew` 的零值是一个
**求过一次**的操作数，复制 N 遍得到的是 N 个别名。类元素要的正是这个（空引用铺满），
多维数组要的却是 N 条各自独立的行，收进来就是 `a[0]` 上 push 一格之后 `a[1]` 也长了。

asy 那一侧落地的是 `A[]`（`cases/21-structarr.asy`，与 `asy -noV` 逐字节相同）。裸数组
那一整套在它上面一条不少，因为句柄进数组不用拷；三条量出来的语义都对上了：句柄进数组
不拷、同一个对象进两格改一次两处都变、**切片复制的是数组而不是对象**（`part[0].x = 555`
之后 `a[0].x` 也是 555）。前端这一刀顺手把三条数组 helper（扩长 / 切片 / `a[i:]`）改成
一个**工厂**：标量那五份仍是模块级静态文本，记录元素逐类型生成一份 —— 正文一字不差，
只有元素类型与"扩长填什么"两处不同（填 `(cnew T)`，因为方言里写不出空引用；asy 那边
那些格子是"未初始化"、读就报错，这条差别记在 lower.js 的文件头）。
`tests/asy/bad/struct-arr.asy` 因此**通过**了，所以删掉：asy 那边 struct 的边界只剩
自引用字段与"把方法当值取出来"两条（后一条是第二十刀收窄出来的）。

### 已落地（支持面第九阶段：struct 的方法，门槛 2 第二十刀）

这一刀**没动核心方言，也没动任何后端** —— 方法是纯粹的**前端糖**，写在这里是因为
"要闭包"这句话我先前记错了，而记错的东西必须改在明处（上面第六阶段那段后话）。

降级形状：`struct P { int get() { … } }` 出一个 `asy__m_P_get`，形参表头上多一个
`(this P)`；`a.get()` 就是 `(call asy__m_P_get (var a))`。因为 asy 的 struct 是引用类型
（第十四刀量的），`this` 传的是句柄，方法里改字段改的就是接收者那个对象 —— 值语义那
一层的 `OP.COPY` 根本不参与，所以四条腿加 LLVM 全是白捡的。重载与默认实参也是白捡：
它们走的是第十、十一刀那两套（`userCall` / `defWrapper`），只是候选表按 `<记录>.<名>`
索引、参数表前面多塞一个接收者，`asy__ov<i>_` 与 `asy__def…` 包装照样生成。

方法体里的名字解析是这一刀唯一真需要想的地方，六条都量过（`asy -noV`）：

- 裸名字先找局部量与形参，再找**前面声明的**字段（`x` -> `(fld (var this) x)`）——
  往后引用报 "no matching variable"。**struct 体内部的可见性也是顺序的**，与文件级
  那一刀同理，只是裁的下标从"声明序号"换成"成员序号"（`selfField` / `visibleMethods`
  里的 `mat`）。
- **成员遮住同名的文件级名字**：文件级有 `int who()`、struct 里也有，方法里那句
  `who()` 走成员那个（量过：印 2 不是 1）。所以查找顺序是局部量 -> 成员 -> 文件级/内建。
- `this` 与 `this.x` 都认，`return this` 回来的是同一个对象（`a.self().bump(100)`
  改得到 `a`）。
- 接收者可以是任意表达式：`mk(7).get()`、`ps[1].bump(30)`、`bx.inner.get()`（第十七、
  十九刀那两格正好在这里合流）。
- 递归（`fact`）与普通函数一样：一个方法看得见自己。

留在门外的一条收窄成了 `tests/asy/bad/fn-value.asy`：**把方法当值取出来**
（`int f() = a.get;`，asy 收，那是绑住接收者的闭包）。核心方言里函数不是值，所以
这一条要等闭包，跟"成员函数"整件事无关。顺手补的诊断是"函数值类型的变量声明"
（`fundecidstart`），先前它漏成一句不带 `ASY_NOPE` 的"认不出的声明项" ——
那种报错当不了 bad/ 用例，因为分不出"还没做"和"做错了"。

### 已落地（支持面第十阶段：构造函数，门槛 2 第二十一刀）

又是**零后端改动**的一刀，而且是真实 asy 模块里最常见的那个形态：数了一遍
`/opt/homebrew/share/asymptote/*.asy`，`operator init` 里压倒性多数是 struct 体里的
`void operator init(…)`（`plain_picture`、`plain_bounds`、`plain_Label`、`plain_pens`
每份都有），也就是构造调用 `A(…)`。

降级分两层，分层不是为了好看：

- `asy__ctor_A_body`：正文，就是第二十刀那个"多带一个 `this` 的 void 方法"。
- `asy__ctor_A`：外层，造对象（字段默认值在这里铺）、调正文、`return this`。

分开是因为体里的 `return;` 在 void 那份里是合法的一条 `(ret)`，塞进一个"要回记录"的
函数里就不合法了。而候选表里那份 `cand` 刻意长得像**回记录、没有接收者的普通函数**
（`ret` 是记录名，`rec` 只用来开 `this.self`），于是重载解析、命名实参、默认实参三套
一字不改就能用 —— `A(x = 9)`、`A(3, bonus = 4)`、`A(2.7)` 与 `A(2.7, 10)` 分别落到四份
不同的 `operator init` 上，全在 `cases/23-ctor.asy` 里。

量出来的四条，头两条反直觉：

- **`A a;` 不走构造函数**。体里赋 `x = 42` 之后 `A a; write(a.x)` 印的还是 0。换掉
  `A a;` 的是**文件级**的 `A operator init()`（量过：它连内嵌记录字段一起管），那一条
  是第二十二刀收的，见下一节。同名的两个东西是两件事。
- **非 void 的 `operator init` 不给构造函数**。`int operator init(int)` 之后 `A(3)` 在
  asy 那边报 "no matching variable 'A'"。我们连声明一起拒（`bad/ctor-nonvoid.asy`）。
- 字段默认值在体**之前**就铺好（`int z = 8;` 加体里 `z = z + 1` 出来是 9）。
- **默认实参能引用字段**（`void operator init(int n = x)` 拿到的是字段 `x` 的默认值）——
  所以默认值是在对象造好之后求的。这条逼出 `defWrapper` 里一条构造分支：那里的 `this`
  不是形参而是**本地量**，对象先造、默认值再求、最后回它。

反过来的两条落在 `strict/`：struct 里根本没有 `void operator init` 时 `A(…)` asy 自己
就拒（"no matching variable 'A'"），所以我们的诊断**不带** `ASY_NOPE` —— 不是"还没做"，
是这个程序不对。另一条是这一刀顺手补上的**漏**：`A a;` 写在 `struct A` 前面 asy 报
"no type of name 'A'"，而我们先前收下了 —— 记录是第一遍全收的，`type()` 只问"有没有
这个名字"。类型名跟函数候选一样是顺序解析的，现在按声明下标裁（`recHere`），struct 体里
则按**这个 struct 的位置**裁。这类漏洞不会让任何用例变红，只有 `strict/struct-fwd` 盯得住 ——
这一节存在的理由就是它。

### 已落地（支持面第十一阶段：文件级 operator init，门槛 2 第二十二刀）

第三刀零后端改动。上一节那句"`A a;` 与 `A(…)` 是两件事"里的另一件：**文件级**的
`T operator init()` 换掉 `T t;` 的隐式构造（`plain_pens` 的 `scaleT operator init()`
就是这个形态）。

降级只是"多问一句"：`recInit(t)` 先问此处可见的那份 operator init，没有才走 `recNew(t)`
（原来那份"字段默认值 + 内嵌记录"的构造）。分界是量出来的，而且反直觉的那半在这里：

- `A a;` 与**内嵌记录字段**走 operator init；
- `new A`（显式）与构造调用 `A(…)` 走 `recNew` —— 量过 `A(3)` 拿到的是**字段默认值**，
  `A r = new A;` 同理。这条不是细节：正因为 `new A` 不走 operator init，那份 operator
  init 的体里写 `A r = new A;`（最常见的写法）才不会无限递归。
- 内嵌记录字段那一格按**那个 struct 声明处**的可见性定，不是按用它的地方：量过
  `struct B { A a; }` 写在 operator init 前面时 `b.a.x` 是字段默认值，写在后面才是
  operator init 的结果。所以 `asy__new_B` 那份正文只生成一次仍然是对的 —— 生成时把 `at`
  挪到 B 的声明处就够了。
- 顺序解析照旧：两份 operator init 就是各管后面那一段（量过印 1 再印 2）。

数组元素仍然不走它（asy 那边 `new A[2]` 的格子是未初始化的，读就报错），这条差别本来
就记在 `lower.js` 的文件头。

留在门外的收窄成一条：**带形参**的文件级 `operator init`。asy 收这个声明，但它不是隐式
转换（量过 `A a = 7;` 报 "cannot cast 'int' to 'A'"），既然量不出它到底能拿来干什么，
就不猜 —— `tests/asy/bad/oinit-args.asy` 钉着。`bad/ctor-toplevel.asy` 因为这一刀**通过**
了，所以删掉换成它。

### 已落地（支持面第十二阶段：算符重载，门槛 2 第二十三刀）

第四刀零后端改动，而且是四刀里最便宜的一刀：**`operator +` 只是个名字奇怪的函数**。
`V operator +(V a, V b)` 登记成候选名 `operator +`、降级符号名 `asy__op_add`
（`ASY_OPSYM` 那张表把算符映到标识符片段，因为核心方言的函数名得是标识符），
于是第十刀的默认/命名实参、第十一刀的重载解析与顺序裁候选**一行新逻辑都不用写**。
表达式那一侧只在 `binary`/`compare`/`unary`/三条复合赋值路径上各加一句 `opUser(…)`。

量出来的四条，钉在 `cases/25-opover.asy` 与 `26-opbuiltin.asy` 里：

- 用户算符与**内建算符在同一张候选表里**，而且签名与内建那一档**逐个相同**时是**替换**
  （重载规则 6）：`int operator *(int,int) { return a + b; }` 之后 `3 * 4` 印 **7**。
  同型优先仍然管着 —— 只写了 `real operator +(real,real)` 时 `2 + 3` 还是内建的 int 加法
  （用户那份要两次转换），但 `2 + 1.5` 走用户那份，因为 real+real 那一档已经被它换掉了。
  第一版实现猜的是"用户只在**精确匹配**时才赢"，`2 + 1.5` 一量就露了：那样出来是 3.5
  （内建的 real 加法），而 asy 印 **0.5**。
- asy **不派生**任何算符：定义 `==` 不白得 `!=`，定义 `<` 不白得 `<=`。
- 复合赋值摊成 `a = a + b`，所以 `a += mk(4)` 自动落到用户那份 —— 没有这一条时它漏到
  后端，撞的是 JS 那条腿的 `+ on class`。
- `--` 是 guide 的**连接产生式**（`a -- b`），内建的那份要等绘图层；但自己定义一份
  `operator --` 是通的，走的就是这张表。

两条边界：`operator cast`（asy 的隐式转换）在门外，理由不是形态难认，是它会改**重载解析
的打分** —— 一旦用户能加转换，"要几次转换"就不再只由内建提升表决定，而那张表是第十一刀
量出来钉死的（`bad/op-cast.asy`）；struct **体里**的算符也在门外，量过 asy 收这个声明但
它**不参与** `a + b`（那边照旧报 "no matching function 'operator +(V, V)'"），
量不出它能被什么调到就不猜。

`operator &&`/`operator ||` 是另一类：量过 asy 那边是 **syntax error**（camp.y 的 operator
产生式里没这两个 token），所以它是 `strict/op-logic` 而不是 `bad/` —— 这一条最初就放错了
地方，是"每条规则都得量一遍"这句话的又一个例子。

## 决策 4：调用 LLVM 需要 extern-C FFI —— 这是新要求，也是 dogfood

编译器源码是 JS 子集降到 C（ADR-0011 决策 2 的封闭 ABI），要调 `libLLVM-C` 就必须有
一条**声明外部 C 符号**的机制。这条以前不存在，现在必须加：

- 形态：一个 `native` 声明（函数签名 + 库名），降级时发成 `extern` 声明与直调，
  JS 宿主上则由 `host/native.js` 提供等价实现或直接不可用。
- 它正是 ADR-0013 立的 C-FFI 契约的第一个真实使用者 —— 一直到现在，那份契约只被
  我们自己的运行时用过。**拿 LLVM 当第一个外部 FFI 用户，是对契约最硬的验证。**
- 自举顺序上的后果：LLVM 后端**只存在于原生构建**。node 宿主继续用 JS 后端。
  这和现在「C 后端只在原生构建上完整」的分工同构，不新增复杂度。

### 已落地的形状

机制本身做完了，落成六个件：

- `src/hir/c_abi.js` —— 封闭表 `C_ABI`，和 `JS_ABI` 同一条纪律：表里没有的名字不许调。
  类型词汇刻意只有七个标量（`i32/i64/f64/bool/cstr/ptr/void`），聚合一律不支持 ——
  要它们的时候再开 ADR，因为那牵扯 ABI 的实参分类，jancy 为此手写了十六个调用约定类。
- `runtime/omni_cabi.h` —— marshal 层，每类型一进一出。三条口径：JS 的数是 `REAL`、
  Omni 的是 `INT`，两种都收；`cstr` 靠 `omni_s16_to_utf8` 已经补的 NUL；
  `ptr` 用 **INT** 标签承载地址（double 只有 53 位尾数，地址是 64 位）。
- `src/host/native_c.js` —— 声明面。node 宿主上每条都抛错，于是 `emit-js` 仍能把整个
  编译器发出来（自举不动点依赖这一点），只是真去调 C 的那一刻当场停下。
- `link.js` 认这条 import 路径并查表，`lower.js` 发 `CCall` 并把用到的条目记在模块上
  （`mod.cabi`），C 后端据此发 `extern` 原型、`cli.js` 据此加 `-l`。
- 实参个数必须**正好**对上原型，展开实参不许用 —— C 没有「缺席就是 undefined」这回事。
- `std: true` 的条目**不发** extern 原型：libc 的真原型用 `size_t`/`int`，我们表里写
  `i64`/`i32`，重复声明成不同类型在 C 里是硬错误（不是警告）。调用处的隐式转换是合法的。

第六条测试轴 `tests/cabi/` 量的就是它。这条轴**不能**建立在「多方逐字节相同」上 ——
node / omni-js / interp 三条腿按设计都抛错，只有 omni-c 真调到了 libc，所以参照是
`.expected` 而不是 node。三条腿必须失败、而且失败在正确的理由上，这后半条才是防退化的
那一半：少了它，一个把 `CCall` 悄悄降成 `undefined` 的 bug 会让三条腿都「通过」。
表里留了 `c_getpid`（POSIX，在 `<unistd.h>` 里，生成的翻译单元看不到那份原型）专门用来
钉住 `cAbiExterns()` 那条路 —— 第三方库走的全是它，而 libc 那几条一条都不发。

## 决策 5：增量 —— 函数级编译单元 + 内容哈希 + 缓存目标码

不变的部分（第二稿已定，与 LLVM 正交）：

- 哈希 = `hash(函数的 MIR 字节 + 它调用的那些函数的**签名**哈希)`。签名而非函数体，
  所以改实现不失效调用者；内联记显式依赖。
- 缓存条目 = **目标码 buffer** + 重定位/符号信息。

因为 LLVM 才成立的部分：

- 缓存的是**编译产物**，所以命中时**完全不跑优化管线**。ORC 的
  `RTDyldObjectLinkingLayer` 可以直接加载目标 buffer（jancy 就是这么搭的，
  `jnc_ct_OrcJit.cpp:104..164`），于是「改一个函数」= 重编一个函数 + 加载 N-1 个缓存对象。
- JIT 与 AOT 共用这份缓存：跑过一遍再构建几乎免费。
- 符号解析用一张**构建期从 `JS_ALL` 生成**的字符串→函数指针表（抄 jancy 的
  `m_symbolMap`，`jnc_ct_Jit.h:26..28`、`:74..92`），不需要运行期逐条注册，
  也不需要 jancy 那份手工 libcall 清单（`:94..143`）—— 我们不用 bare JITDylib，
  挂进程符号解析生成器即可。

### 已落地（`stage0/src/incr/cache.js`，`omni incr`）

缓存层与后端解耦：`compileIncremental(mir, tag, cache, emitFunc)`，`emitFunc` **只在
未命中时**被调用。命中数、未命中数、真正发出的次数都数出来，`omni incr` 印成一行 ——
门槛 4 要的是计数，而 `emit=0` 就是「命中时完全不跑编译管线」的可观测形式。

**一处必须改的**：决策 5 原话是 `hash(函数的 MIR 字节 + 被调者签名哈希)`，
而**直接哈希字节是错的**。指令的 `a`/`b`/`aux` 有一半是池下标 —— CALL 的函数下标、
GLOAD 的全局下标、AGGLIT 的类型下标，还有落在 `REF_BIAS` 以下的常量池下标。
下标依赖整个模块的构造顺序，于是「在文件开头插一个新函数」会让它后面**每一个**函数的
字节都变，增量当场退化成全量。所以哈希的输入是字节的**规范化文本**：函数内的编号
（指令 ref、槽位号、`br` 层数）原样保留，跨函数的一切按**名字**，常量按**值**。
字节形式本身不动 —— 它仍然是持久化与「同一份源码两次降级逐字节相同」的对象。

现在缓存的产物是 **JS 后端的单函数文本**（`emitJsFunc`）。选它的理由不是它有用，
而是它是今天**唯一内容寻址成立**的产物：C 后端的函数体里写着 `omni_s16_7` 这种模块级
字符串池下标，同一个函数搬到另一个模块里文本就变了。这从反面说明了决策 5 里
「缓存条目 = 目标码 buffer + **重定位信息**」的必要性 —— 重定位就是把「按下标引用」
换成「按符号引用」的那一步。LLVM 那条路进来时要换的只有 `emitFunc`，键与计数不动。

验收门槛 4 已满足（第十一条测试轴 `tests/incr/`，8 条）：冷全 miss / 热全 hit（跨进程，
缓存在磁盘上）、改一个函数体 miss 恰好为 1（调用者不失效）、在开头插一个带新常量的函数
原有函数照样命中、被调者**签名**变则调用者失效而**函数体**变则不失效、缓存里的产物逐段
出现在整模块产物里（否则命中就是拿假货换真编译）。编译器自己那份 1024 个函数：
冷全 miss，热全 hit。

## 决策 6：MIR 只做「语言中立 + 可哈希 + 四后端可消费」，不做优化

优化交给 LLVM。MIR 的职责因此比第二稿小得多：

- SSA、显式类型（标量 / `vec(T,N)` / `ptr(T,addrspace)` / 聚合）、结构化终结子。
- `omni_dyn` 在 MIR 里是普通的 16 字节聚合，不是特例 —— JS 域与 Omni 域降到同一份 IR。
- **结构化控制流保留到后端内部才拆**：SPIR-V 要 merge 块、闭包解释器要树，
  只有 LLVM/机器码那条想要平的 CFG。这是否决「字节码 + 计算 goto」的真正理由 ——
  那条路一走，GPU 后端再也接不上。OIR 现在就是结构化的（`If`/`While`/`For`/`Block`/
  `Break`/`Continue`，无 goto），别在中途丢掉。
- 不写 pass 管线、不写寄存器分配、不写指令选择。唯一的合法化是「C 备选路径上把
  向量标量化」。

### 已落地的形状（`stage0/src/mir/`，四个文件 + 第九条测试轴）

写下来的时候有三处与上面那几条不同，都是落地量出来的，理由记在这里：

- **可变变量走内存槽，不做 phi。** 上面只写了「SSA」。纯 SSA + 结构化控制流要么带
  phi（就得先有 CFG 与支配树），要么给区域加块参数（MLIR/SIL 那套）；两条都要在这一层
  写一个 SSA 构造器，而它的产物 **LLVM 的 `mem2reg` 立刻会再算一遍**。所以落地的形状是
  **表达式的值是 SSA（每条指令定义一次、不可变），可变变量是 `SLOT` + `LOAD`/`STORE`**。
  clang -O0 出来的 IR 就是这个形状，SPIR-V 的 Function 存储类变量也是，而闭包解释器
  要的恰恰是「值栈上的窗口 + 槽位」（决策 7）。代价是 MIR 自己不做常量传播 —— 本来也不做。
- **结构化控制流用扁平的标记指令**：`BLOCK`/`LOOP`/`IF`/`ELSE`/`END` + 按层数跳的
  `BR`/`BRIF`，**层数语义与 wasm 逐条相同**（跳 BLOCK = 跳到它的 END 之后，跳 LOOP =
  回到循环头）。这样结构信息一条不丢（SPIR-V 的 merge 块、解释器要的树都能恢复），
  而指令表仍然是**定长记录的线性表** —— 「8 字节一条」与「按字节哈希」不必让步。
  与 wasm 的唯一区别是**操作数是显式 ref，不是隐式求值栈**：栈式编码会让「这条指令的
  输入是谁」变成要模拟栈才知道的事，四个后端得各模拟一遍。这个仓库已经有 WAT 前端，
  层数语义共用一套，读代码的人不用在脑子里维护两张表。
- **一条指令五个字段**：`op`(8) `t`(8) `a`(16) `b`(16) `aux`(16) = 8 字节。LuaJIT 的
  第五个字段是 `prev`（CSE 链表），我们不做 CSE，那 16 位改作第三个操作数位 —— 调用点
  要 `(函数, 实参池起点, 实参个数)` 三样。实参池**自描述**（起点处先放个数），于是
  `o[i] = v`、`o.f = v` 这种四操作数的指令不必分裂成两条。
- **`t` 只到「种类 + 向量宽度」**（低 5 位种类、高 3 位宽度的对数，覆盖到 vec(T,128)）。
  聚合的身份（哪个 struct / 哪种容器）挂在 `aux` -> 模块类型池；字段访问挂在
  `aux` -> 访问描述符池 `(类型号, 字段名)`。用名字而不是字段下标，因为 enum 的载荷是
  按变体摊平的（ADR-0012），下标在那里没有唯一含义。
- **多态收进 op 名字**：OIR 的 `len` 靠 `recvType` 区分 list/string，MIR 里是
  `len.list` / `len.string`。后端与解释器因此只需要一张平表，不必各自再实现一次
  「按接收者类型选实现」。
- **有独立的 verifier**（`mir/verify.js`，默认开着，不是调试开关）。OIR 那层没有
  ——`hir/check.js` 本身就是降级器。MIR 不一样：它有四个消费者，而它的不变量是结构性的
  （区域配对、ref 的支配关系、下标范围、条件必须是 bool）。一条破了不变量的指令在四个
  后端会各自表现成不同的错答案，一次查掉比在四处 debug 便宜。**支配关系不需要支配树**：
  结构化控制流下「定义它的区域此刻还开着」与「支配」是同一件事，一个栈就够。
- **哈希里出现的是名字，不是池下标**（`mir/bytes.js`）。下标依赖整个模块的构造顺序，
  名字只依赖这个函数引用了谁 —— 带下标的话改任何一个函数都会让它后面所有函数的哈希
  变化，增量就退化成全量。测试轴里有一条断言直接钉这个性质：改 `g` 的函数体，
  `f` 的 body 哈希不动，`g` 的签名哈希也不动。

量出来的规模：仓库里 21 份 case（.omni/.omnid/.omnis/.wat）加**编译器自己**全部降得下来
并通过 verifier —— 编译器自己是 **939 个函数 / 180401 条指令 / 1.44 MB 字节形式**，
比所有 case 加起来大一个量级。第九条测试轴（`tests/mir/`）跑三件事：降级 + verify、
四份形状快照、内容哈希的两条性质。

**IR 的编码抄 LuaJIT**（量过 `reference/gsl-shell/luajit2`，2.0.2）：

- **一条指令 8 字节定长**，`op1`/`op2` 是 16 位的**指令下标**而非指针
  （`lj_ir.h:493..529`、`:411..414`）。
- **常量往下长、指令往上长，中点 `REF_BIAS = 0x8000`**（`lj_ir.h:416..425`）。
  真正的动机写在紧随的注释里（`:427..439`）：字面量也被压到 bias 之下，于是
  **「是不是常量」退化成一次整数比较 `ref < 0x8000`**，遍历操作数完全不用查
  操作数模式表。
- **opcode 的编号顺序当数据结构用**，静态断言钉死（`lj_ir.h:154..158`）：
  取反比较是 `op ^ 1`，有序↔无序是 `op ^ 4`，load→store 是加一个常量。
  用编号算术代替 switch，这条我们的 205 路 op 分派也用得上。
- **`TRef` 把类型抄进引用的高 8 位**（`lj_ir.h:441..458`），于是记录期做类型判断
  不用回表读指令。便宜且收益大。
- **guard 不是独立指令，是类型字节上的一个 bit**（`IRT_GUARD = 0x80`，`lj_ir.h:306..313`；
  构造宏 `IRTG` 在 `:324..325`）。机器码里的成本是 **1 条 cmp + 1 条 jcc**
  （`lj_asm_x86.h:1475..1486`），不占寄存器、不建栈帧。
- 一个宏列表（`IRDEF`，`lj_ir.h:14..141`，94 条 opcode）同时展开出 enum、模式表、
  类型尺寸表 —— 和我们从 `JS_ALL` 生成两个后端的分派器是同一个套路。

### 已落地（SIMD 第一阶段：`vec(int|real, 2|4|8)`，六个执行器）

门槛 6 要的是「LLVM 向量路径与 C 备选的标量化路径**逐位相同**」。落地时的关键取舍：

- **向量放在 OIR，不只放 MIR。** C 后端与 JS 后端消费的是 OIR，只有 LLVM 与 MIR 解释器
  消费 MIR。向量只进 MIR 的话，要比对的那条 C 腿根本看不见向量，门槛无从谈起。
  于是 `vecType(elem, lanes)` 进了 `hir/types.js`，OIR 多了四种节点
  （`VecSplat` / `VecLit` / `VecLane` / `VecHsum`）。零值刻意复用 `VecSplat` 而不新开
  一个 `ZeroVec` —— 每多一种节点，三个 OIR 消费者就各多一处分支。
- **hsum 在 OIR -> MIR 那一步就展开成「逐道 `VEXT` + 严格左到右的 `ADD` 链」。**
  MIR 因此**没有** HSUM 指令。这是门槛 6 里「浮点固定求值顺序」的落点：求值树成了
  MIR 里看得见的指令序列，两个 MIR 消费者没有"各挑一个规约形状"的余地。
  同样的理由，LLVM 那条腿刻意**不发** `llvm.vector.reduce.fadd` —— 那条 intrinsic 的
  规约顺序由目标决定，用它等于把「固定顺序」交给后端心情。
- **每一道上的运算与标量运算是同一份发射代码。** 三个后端都把 `bin` 拆成了
  `binCode(op, 类型, 左, 右)`（操作数是代码串），向量路径拿 `a.l[i]` / `x, y` 这样的
  串再调它一次。于是 int 的回绕、除零的消息文本不可能在"向量道"和"标量"之间分叉 ——
  这不是复用，是**取消**分叉的可能性。
- **C 那条腿是 `typedef struct { T l[N]; }` + `static inline` 助手，不是编译器的
  向量扩展。** `__attribute__((vector_size))` 会把「两条腿逐位相同」的责任交给 clang 的
  自动向量化，而它不承诺求值顺序。取一道也走函数（形参是左值）：`f(x).l[2]` 是在
  非左值结构体的数组成员上取下标，C99 里没定义。
- **宽度不占类型池**：MIR 的 `t` 高 3 位早就为宽度的对数留好了（见决策 6），所以
  向量在 MIR 里是"带宽度的标量"，`VSPLAT` / `VINS` / `VEXT` 三条 op 不需要 aux 指类型池。
  verifier 顺带多查一条：道号必须小于宽度（越界的道在 LLVM 里是 poison、在 C 里是越界读，
  两条腿会给出不同的错答案）。
- 第一阶段刻意**只有** splat / vlit / lane / hsum 与逐元素 `+ - * /`。向量比较要引入
  掩码类型、select 要引入三目、shuffle 要引入常量掩码 —— 每一条都要在六个执行器上各写
  一次且答案逐位相同，所以挡在降级层而不是给个近似答案。
  整数向量的 `/` 在 LLVM 腿上是**标量化**的：除零报错与 `INT64_MIN / -1` 特判都在
  `@omni_ll_div` 里，而它是标量签名。

`tests/sexpr/cases/03-simd.sx` 是这条门槛的度量点，六条腿逐字节相同
（`run` / `run-c` / `interp` / `interp --mir` / `run-llvm` / `run-jit`）。它最后一行是
`(hsum (vlit (vec real 4) 1e16 1.0 -1e16 1.0))`：左到右得 1，两两配对得 0 ——
**印出来的那个数本身就是「两条腿用了同一棵求值树」的断言**。自举链上多两条门槛
（`emit-llvm` / `emit-c` 的文本在两代之间相同），因为宽度的编解码只能用乘除取模写
（封闭 ABI 的位运算只对 bigint 成立），而算错宽度的症状是"原生编译器发的 IR 里
`<4 x double>` 变成 `<1 x double>`"，node 上永远看不出来。

### 已落地（缓冲 + kernel/dispatch：门槛 7 的 CPU 那一半）

门槛 7 要的是「`kernel` 的 SPIR-V 输出与**同一份 MIR 在 CPU 上**的结果一致」。所以这一步
先把「CPU 上的那个答案」做出来，而且是在六个执行器上都做出来 —— 否则"一致"没有参照物。

- **缓冲是新类型 `buf<T>`，不是 `list<T>`。** list 带长度/容量/增删和一整套按值语义的
  拷贝规则；把它映到 GPU 等于把 Omni 的容器 ABI 搬进 SPIR-V。`buf<int|real>` 只有
  `bnew` / `bget` / `bset` / `blen`：一段连续的元素 + 一个运行期长度，引用语义，
  不能装箱进 dynamic。这个形状和 StorageBuffer 里的 runtime array 是对应的。
- **kernel 在 OIR 里就是普通 void 函数，隐含第一个形参是 gid**；`(gid)` 读它，
  `(dispatch k 网格 实参...)` 在**降级期**就展开成「临时量 + while + 普通调用」。
  于是 CPU 那五条腿一行都不用改，而 `kernel: true` 只是给 SPIR-V 那条腿挑函数用的标注。
  循环是"没有 GPU 时怎么执行"的定义，不是语义的一部分。
- **越界在 CPU 上是运行期错误，消息与 list 那句逐字对齐**（`omni_container.h:50`）。
  GPU 上没有这条路径 —— 约定是 kernel 自己用 `blen` 守门（`03-simd` 之外
  `04-buffers.sx` 的网格刻意 6 > 4 就是在测这件事）。这是刻意的不对称：越界要在
  CPU 上暴露，而不是在设备上变成随机内存。
- MIR 只加一个类型码 `T_BUF` 与四条 op（`BNEW`/`BLEN`/`BGET`/`BSET`）。`T_BUF` 里
  **不带元素类型**：LLVM 的指针早就是不透明的，元素只在 `BNEW` 的 aux 与
  `BGET`/`BSET` 的 `t` 上出现，所以「一个缓冲」一个码就够。
- LLVM 那条腿把 `omni_alloc` 的 bump 快路径（omni.h:98..103，又一条 `static inline`）
  在 IR 里重建，慢路径调真符号 `omni_alloc_slow`、arena 的两个指针是 extern 全局 ——
  **不换分配器**：换一个的话缓冲的地址来自另一个池，同一个程序里就有两套内存管理。
  越界与负长度走变参的 `omni_errorf`，格式串与实参和 C 那条腿逐字相同，于是 stderr 也一致。

`tests/sexpr/cases/04-buffers.sx` 六条腿逐字节相同。

### 已落地（SPIR-V：门槛 7 的 GPU 那一半，`stage0/src/backend-spirv/emit.js`）

`omni emit-spirv FILE [--kernel NAME]`：一个 kernel 一份 SPIR-V **汇编文本**。

- **发汇编文本，不打包二进制字。** 和 LLVM 那条腿同一个理由：这一层真正的工作量在降级，
  跟谁来打包字无关。文本让它能被 `spirv-as --target-env vulkan1.1` + `spirv-val`
  单独校验 —— 那是官方工具，它们认了就说明字是对的，不必自己再实现一遍二进制布局。
- **一个模块一个入口。** SPIR-V 允许多个 `OpEntryPoint`，但每个入口有自己的接口与
  描述符布局，合在一起只会让「这份模块对应哪次 dispatch」变模糊，而 Vulkan 那边
  一个 pipeline 就是一个入口。所以有多个 kernel 时必须 `--kernel` 指名。
- 映射都用 GPU 本来就有的东西：`buf<T>` 形参 → StorageBuffer 描述符（set 0，binding
  按缓冲形参序），类型是 `OpTypeStruct { OpTypeRuntimeArray T }` + `Block` + `ArrayStride 8`；
  标量形参 → push constant 块的成员（每个 8 字节，偏移 = 序号 × 8）；`(gid)` →
  `GlobalInvocationId` 的第 0 分量；槽位 → Function 存储类的 `OpVariable`；
  `blen` → **`OpArrayLength`**，所以长度不必另传一个 uniform，宿主绑多长就是多长。
- **MIR 把结构化控制流留到后端才拆，这一步是它的兑现**：`IF/ELSE/END` 直接成
  `OpSelectionMerge` + 显式 merge 块，不必先建 CFG 再找汇合点。
- **循环**：MIR 里 `while` 的形状是 `BLOCK{ LOOP{ BRIF 跳出; 体; BR 回头 } }`，SPIR-V 要的是
  `OpLoopMerge` 同时给 merge 块与 continue 目标。两条硬规矩决定了映射的形状：**回边只许
  从 continue 目标出发**（所以「BR 到 LOOP」发的是跳 continue，回边是 continue 块里那一条）、
  **跳出一个构造只许跳它的 merge 块**（所以外层 `BLOCK` 的出口标签必须*就是*这个循环的
  merge 块 —— LOOP 见到自己是刚开的 BLOCK 里第一条东西时直接借用那个标签）。
  拿不到这个借用的 `BLOCK`（多层 break 那种）一律报错，而不是发一份 validator 恰好放过、
  语义却漂了的模块。
- **`T_BUF` 不带元素类型这件事在这里第一次要付代价**：描述符必须在函数体之前声明，
  所以这条腿先扫一遍「谁读写了哪个槽」反推元素类型。从没被读写的缓冲形参因此发不出来 ——
  那不是"支持不了"，是信息不在 MIR 里，与其猜一个发出去，不如报错说清（`tests/gpu/bad/unused-buf.sx`）。
- 刻意不支持、一律报错的：**整数 `/` `%`**（CPU 那几条腿要在除零时报错、`INT64_MIN / -1`
  要特判，而设备上没有报错这条路径 —— 给个"差不多"的答案就等于让门槛 7 变成摆设）、
  `bnew`（设备上没有 arena）、print/字符串/dyn/容器/调用/闭包/向量、越界检查。
  每一条在 `tests/gpu/bad/` 里有一份 case，且**同一份源在 CPU 那条腿上照跑** ——
  边界是这一层的，不是语言的。

第十五条测试轴 `tests/gpu`：清单里的每个 kernel 过 `spirv-as` + `spirv-val`（工具不在
就 skip，不该成为 `npm test` 的硬依赖），加一份汇编快照，加上面那些拒绝。自举门槛比的是
`emit-spirv` 的文本在两代之间相同 —— 原生构建里 Map 与字符串是另一套实现，两代发出
不同的 id 编号或装饰顺序，症状会是「spirv-as 不认」或者更糟：认了，但描述符绑到了
别的 binding 上。

还差的只剩「有设备时真跑一遍」—— 下一小节就是它。

### 已落地（真设备上跑一遍：`stage0/gpu/omni_vk.c`）

`omni_vk MODULE.spv ENTRY --grid N [--buf i64:v,...] [--push i64:v]`：把一份模块在设备上
跑一遍，把缓冲的内容印出来。**它是测试轴的工具，不是后端的一部分** —— `dispatch` 在
CPU 那五条腿上是降级期展开的循环，main 本来就在 CPU 上跑，要上设备的只有 kernel 那一段。

- **参照物怎么来的**：`tests/gpu/cases/*.sx` 在 dispatch **前后各把整个缓冲印一遍**。
  于是一份源同时给出「设备该拿什么当输入」（前一半）和「设备该算出什么」（后一半）。
  `tests/gpu/kernels.js` 的 `DEVICE` 表写的初值必须与前一半逐字相同，测试轴会核对 ——
  表和 case 因此不会各说一套，而那正是这类比对最容易烂掉的地方。
- **模块自述，不靠约定**：宿主自己走一遍 SPIR-V 的字，从 `OpCapability` 读出要不要
  Float64 / Int64，从 `OpExecutionMode` 的 `LocalSize` 读出工作组多大。所以工作组大小
  只在发射器里定义一次，宿主不会和它各记一份。
- **组数 = ceil(grid / LocalSize.x)**：设备上实际起的调用数被向上取整到 64 的倍数，
  而 CPU 那边跑的是恰好 grid 次。**两边能对上正是因为守门条件是 `blen` 而不是网格** ——
  门槛 7 那条「kernel 自己用 blen 守门」的约定在这里第一次变成可观测的东西。
- **量出来的平台事实**：Apple M1 + MoltenVK 报 `shaderInt64=1`、**`shaderFloat64=0`**
  （Metal 没有双精度）。所以 `01-bump`（int 道，含循环与 `INT64_MAX + 2` 的回绕）在真 GPU 上
  与 CPU 逐个数值相同，而 `02-saxpy`（real 道）在这台机器上必然 skip，理由由宿主印出来：
  「模块要 Float64=1；设备 0（Apple M1）给 shaderFloat64=0」。这是平台的边界，
  不是降级出了错 —— 换一台有双精度的设备，同一份 case 不改一个字就能跑。
- **另一条量出来的平台事实（Apple 编译器的坑）**：循环体里**累加另一个归纳变量**
  （`s = s + k`，两个都是 64 位）会让 Metal 的着色器编译服务在 `vkCreateComputePipelines`
  时死掉：`XPC_ERROR_CONNECTION_INTERRUPTED ... after multiple retries`。缩小到最小差别
  才敢这么说 —— 同样的循环把它换成常量增量（`s = s + 1`）就跑得过，圈数与道号有关也跑得过，
  只有「在循环里累加变量」这一条会崩；而 `spirv-val` 接受那份模块，MoltenVK 生成的 MSL
  肉眼看也是对的（`while (!(!(_22 < (_20 + 1l)))) { _21 += _22; _22 += 1l; }`）。
  所以设备侧的 case 刻意避开这个形状，而不是把它记成"我们的 bug"或者悄悄不测循环。
- **`.sx` 只是把中间形式钉住的最小份量**：核心方言是汇聚层，不是写例子的语言（决策 1）。
  所以整数那条路只有一份 case、一个 kernel，把缓冲读写 / push constant / `gid` / `blen`
  守门 / 循环 / 回绕全压在里面。GPU 这条腿真正缺的不是更多 `.sx`，是**从一门真实语法
  写得出 kernel** —— 那要么走 Omni 自己的前端，要么走一份 grammar，届时这些文本是生成的。

## 决策 7：闭包编译解释器保留，身份是 oracle 与 REPL

- 装载期把每条 MIR 指令编成一个函数值（ADR-0013 决策 3 的闭包记录），执行是
  `n->fp(n, frame)`，分派只付一次。
- 调用帧是值栈上的窗口，实参写槽位，读形参一次数组访问；帧布局照 Cyber
  （`src/vm.h:203` 的 `CALL_ARG_START 5`，`CallInfo` 打包进一个 `Value`：
  `src/fiber.zig:543..559`）。这条同时缓解现在整个自编译被 OOM 杀掉的问题。
- **它是唯一不涉及机器码的执行路径，所以所有后端的正确性都对着它比。**

### 已落地（`stage0/src/mir/interp.js`，`omni interp --mir`）

- 装载期把每条指令编成一个闭包，运行期是 `prog[pc](F)`，返回**下一个 pc**。区域配对与
  每条 `BR` 的层数在装载期一次扫描就解析成具体 pc —— 于是运行期**没有区域栈、也没有
  信号值往上传**（OIR 那份要靠 NEXT/BREAK/CONTINUE/RETURN 逐层返回）。
- 帧 = 值窗口 `F.v` + 槽位窗口 `F.s`。形参就是前几个槽，读形参是一次数组访问。
  （Cyber 那种把 `CallInfo` 打进一个 `Value` 的紧凑帧还没做，值窗口先按指令数铺满 ——
  封闭 ABI 里 list 的下标写入必须落在长度内，不能靠自动扩张。）
- **语义一份**：值表示、内建 op、成员派发、宿主库那 138 条 op 全部走
  `interp/builtin.js` 已有的那一份（为此把 `builtinOp` 拆出了值层入口 `applyBuiltin`）。
  复用的动机不是省代码，是**不让语义分叉** —— 两个解释器给出不同答案，「五方逐字节相同」
  这条门槛就成了摆设。`applyBuiltin` 的负缓存挂在装载期造的描述符对象上，所以
  「分派只付一次」对这条路径同样成立。
- 一处必须特殊处理的：`js_asFn` 是 raw op（返回函数值本身，过不了 dynamic 边界），
  降级时不发它 —— `CALLFN` 的 `aux=1` 记「JS 域的动态调用，实参是一条实参表」。

验收门槛 3 已满足：`js-exec` 十一份用例上 **node == omni-js == omni-c == interp ==
interp-mir** 五方逐字节相同；主轴的 25 份 Omni 用例、WAT 轴的 12 份也都加上了这条腿。

## 决策 8：FFI 便宜的原因是特化，不是值表示 —— 记下来，暂不动

LuaJIT 的教训：`ffi.C.foo(x)` 之所以是一条直调，不是因为它的值表示 C 兼容
（它是 8 字节 NaN boxing，恰恰**不**兼容），而是因为 **JIT 在记录期就把这次调用
特化掉了** —— 参数在寄存器里是拆箱状态，跨 FFI 边界不重新装箱。

这对 ADR-0013 决策 3（16 字节 `omni_dyn` 按值传，为的是 C-FFI 直调）是一个真实的
反例：如果有 JIT 特化，值表示就不必为 FFI 让步。**但现在不改**，理由有两条：
一是解释器路径没有特化，值表示必须自己扛；二是 ADR-0013 的契约是当前一切的地基，
换它要另开一条 ADR 并重跑全部比对。**先记下，等 JIT 落地后拿实测说话。**

## 决策 9：C 后端是备选，tcc 是止血

- C 后端保留三个用途：新目标兜底、产物可读、差分 oracle。**不再是性能路径。**
- tcc 接上（`cli.js:108` 本来就是 tcc 优先，只是没装），因为它把全量自举从约 50s
  变成 **1.80s 冷 / 0.99s 热**，不动点逐字节成立。**明确标为过渡**：
  它不解决增量、不做 SIMD、没有 GPU。

## 验收门槛

1. **S 表达式汇聚**：`frontend-js` 与「GLR + JS grammar」两条路产出的 s-expr 逐字节
   相同；`S-EXPR → OIR` 是纯函数，进快照轴。加第二门语言时，新增代码里**不含
   任何 lowering/emit**，只有 grammar 与映射标注 —— 这条要在评审里当硬指标查。
   **后半句已达成且已自动化**（mini 只有 grammar，`tests/sexpr/run.js` grep 全树；
   见决策 1 的第二个落地小节）。前半句仍未做：JS 那条路还没有 grammar 版本。
2. **GLR**：grammar 生成表时若存在无消歧策略的冲突，**生成阶段就报错**；
   延迟动作求值用显式栈，深度不受宿主栈限制。
3. **MIR + 解释器**：`js-exec` 从四方扩到五方逐字节相同。**已达成**（见决策 7 的落地小节）。
4. **增量**：改一个函数体，重编只发生在那一个函数上，用**缓存命中/未命中计数**断言，
   不靠计时。**已达成**（见决策 5 的落地小节）。
5. **LLVM JIT**：六方比对；同一进程内解释与 JIT 混合执行结果一致；
   单函数 JIT 延迟有上界断言（先用 28ms 当草稿值，实测后替换）。
   **部分达成**：`run-jit` 与 aot / interp / omni-c 四方逐字节相同，运行期不需要 cc
   （见决策 3 的第二个落地小节）。混合执行与延迟上界都还没做，两者都要先有
   in-process 宿主。
6. **SIMD**：LLVM 向量路径与 C 备选的标量化路径结果**逐位相同**
   （浮点固定求值顺序，禁 fast-math）。
   **第一阶段已达成**：`vec(int|real, 2|4|8)` 上的 splat / vlit / lane / hsum 与逐元素
   `+ - * /`，六条腿逐字节相同，求值顺序由「MIR 里展开成左到右的 ADD 链」保证
   （见决策 6 的 SIMD 落地小节）。还没做：向量比较与掩码、select、shuffle、
   从容器加载向量、宽度 16 及以上。
7. **GPU**：`kernel` 的 SPIR-V 输出与同一份 MIR 在 CPU 上的结果一致；
   无 GPU 时至少过官方 validator。
   **两句都达成，但前一句受这台设备的精度所限**：`buf` + `kernel`/`dispatch` 在六条腿上
   逐字节相同（CPU 那一半）；每个 kernel 过 `spirv-as --target-env vulkan1.1` + `spirv-val`；
   整数 kernel 在 Apple M1（MoltenVK）上与 CPU 逐个数值相同，含 `INT64_MAX + 1` 的回绕。
   real 的 kernel 在这台机器上过不了设备 —— Metal 没有双精度（量出来的：`shaderFloat64=0`），
   宿主以退出码 3 报出「模块要什么、设备给什么」，测试轴记 skip。
   还没做：整数 `/` `%`、工作组大小可配、多入口、把 dispatch 真正接到 GPU 上
   （现在设备只在测试轴里跑，`omni run` 走的还是 CPU 循环）；以及**最要紧的一条：
   从一门真实语法写得出 kernel** —— 核心方言是汇聚层，不是写例子的地方（决策 1），
   所以 `.sx` 的 case 只留钉住中间形式的最小份量。

## 借鉴与对照（本地快照，行号是这些快照里的）

- **Bison**（`reference/bison`）：GLR 骨架 `data/skeletons/glr.c` 2764 行，LALR 基线
  `yacc.c` 2211 行。可抄：bump 分配的 GSS、`yysplitPoint` 的确定性快路、延迟动作。
  必须接受：无消歧策略的真歧义直接 abort。
- **LuaJIT 2.0.2**（`reference/gsl-shell/luajit2`）：IR 编码（8 字节定长、16 位下标
  操作数、`REF_BIAS` 中点、`TRef` 带类型、guard 是一个 bit、opcode 编号算术）。
  **纠正两条我的记忆错误**：这棵树只有 x86/x64/ARM32/PPC/MIPS 四个后端，
  **没有 arm64**（那是 2.1 才有）；**DynASM 只用于写解释器 VM（`vm_*.dasc`），
  JIT 后端是手写 C 直接往 `MCode*` 塞字节**。
- **Jancy**（`reference/jancy`）：ORC 集成形状 —— ExecutionSession + IRCompileLayer +
  RTDyldObjectLinkingLayer + JITDylib，345 行（`jnc_ct_OrcJit.cpp:104..164`）；
  运行时符号用显式哈希表（`jnc_ct_Jit.h:26..28`）。**不抄**：`createBareJITDylib`
  导致的手工 libcall 清单（`:94..143`）、十六个手写调用约定类
  （`jnc_ct_CallConv.h:27..44`）、`setOpaquePointers(false)` 那笔上游债
  （`jnc_ct_Module.cpp:201..211`）。
- **Cyber**（`reference/cyber`）：帧布局与 `CallInfo` 打包；ARC 为主 + 只对可能成环的
  对象标记清扫（`src/arc.zig:222..241`），根靠编译期 unwind 表走栈找（`:329..355`），
  **无 write barrier、无 handle scope**。它的 "JIT" 是构建期选中的整程序 copy-patch
  后端，不是分层 JIT ——「抄 cyber 的分层 JIT」这个说法本身是个误解。
- **TinyCC**（`reference/tinycc`）：现在只作为「第三档自写后端」的量级参考
  （`x86_64-gen.c` 2313 行、`arm64-gen.c` 2209 行、`get_reg` 38 行在
  `tccgen.c:1489..1527`），以及 tcc 这个止血工具本身。
- **wasm / SBCL / Chez / SPIR-V**：本地无源码快照。引用的是公开做法（s-expr 作为
  规范输入形态、先验证后执行、类型驱动特化、编译成闭包、结构化控制流要求）。
  落地前需各自找一份核对，本文不当作读码所得。

## 后果与代价

- **依赖 LLVM**：本机 `libLLVM.dylib` 157MB。产物变大，但仍然自带执行器、
  不依赖外部 cc。极小构建走 C 后端或第三档自写后端。
- **必须先做 extern-C FFI**（决策 4）。它是 LLVM 后端的前置条件，也是 C-FFI 契约的
  第一个外部用户。
- **GLR 是一个新组件**，量级参考 bison 的 2764 行骨架 + 表生成。这笔投入换的是
  「以后每加一门语言只写 grammar」，第二门语言就该回本。
- **语义仍然只有一份**：所有后端发的都是对 `omni_js_*` 的调用（ADR-0013 决策 5）。
  后端多了不增加语义分叉点，只增加执行机制的 bug，而那种 bug 逐字节比对当场抓。
- **arena 回收另开一条 ADR**：当前解释器在整个自编译上被 OOM 杀掉；决策 7 的值栈只
  解决「每次调用一条 list」。

## 附录：实测数据（M 系列 macOS，本机）

生成的自编译器 C：3831922 字节 / 61483 行 / 单 TU / 737 个函数。

- clang `-O2`：编 24.6s（`-c` 21.13s），编出来的编译器跑 `link + lower cli.js` 0.86s
- clang `-O1`：18.13s ——「降一档优化」基本无用
- clang `-O0`：编 3.5s，跑 2.39s
- tcc（本地快照 0.9.28rc，现编）：编 **0.41s**，跑 4.97s；
  端到端全量自构建 1.80s 冷 / 0.99s 热；`emit-c` 与 C0 逐字节相同

`-O2` 的 pass 分布（`-ftime-report`，平的，无病态热点）：AArch64 指令选择 21.7%、
InstCombine 8.8%、Inliner 6.3%、Greedy 寄存器分配 5.4%、SROA 4.2%、DSE 3.5%；
前端（parse + sema + IRGen）2.5s。

本机 LLVM：22.1.8，`libLLVM.dylib` 157MB，提供 `libLLVM-C.dylib`。
