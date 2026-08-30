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
- **`(fail E)`（2026-08-27 加的）**：运行期错误，实参是 string。加它的理由不是"方言缺个
  异常"，而是被降级的语言**自己有**运行期错误，而那些错误必须照搬而不是省掉 —— 第一个
  用户是 asy 的 `angle((0,0))`（量过：真 asy 报 "taking angle of (0,0)" 并非零退出，
  而 `angle(z,false)` 给 0；libm 的 `atan2(0,0)` 是 0 不报错，所以这一刀必须在 atan2 之前）。
  OIR 里它就是 Omni 的 `fail`，所以五条腿里四条一行没改；LLVM 那条补了一行 `RT_OPS`
  （`omni_fail` 本来就是运行库的真符号，C 那条腿一直在用）。

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

**构表结果按内容寻址缓存**（`cli.js loadGrammar` + `table.js tableText/tableFromText`）。
起因是量出来的：`emit-asy` 一次 1.2s，其中 **780ms 全在项集族那一遍**（asy 那份语法 433 个
状态；FIRST/FOLLOW 4ms、归约 6ms、冲突 5ms、读语法 20ms）。而这条路是「一条用例一个进程」，
`tests/asy` 一轴上百次进程 —— 不缓存就是白烧几分钟。键 = 语法文本 + 格式版本，改语法或改
序列化形状都自动失效；缓存里只有**状态表与剩下的冲突清单**，产生式表与 FIRST/FOLLOW 每次
现算（5ms），所以文件里没有一处引用语法树节点 —— 不必序列化 span 与动作模板。格式是按行的
整数（符号名各占一行，别处一律是下标）而不是 JSON：`JSON.parse` 不在封闭 ABI 里，`split` 在。
写法是"先写临时文件再 rename"，几条腿并行跑时读不到半截文件。
实测 1.195s -> 0.229s，`tests/asy` 整轴 33s。
这里有一处**真的差点错**：nonassoc 同级不结合时那一格是**空的动作表**（"这么写非法"），
第一版编码把空表写成了"没有内容"，读回来变成一条 reduce —— `tests/glr` 新加的那一节
（跑两遍，第二遍必须命中缓存且两遍表逐字节相同）当场把它抓住了。

**第八条测试轴** `tests/glr/`：表的快照、每条输入的树、缓存与构表等价、以及两道方向相反的
门槛 —— `lookahead.grammar`（SLR 不够但语言不歧义）**必须**留下冲突且两支输入都要过，
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
   于是重载解析那一套白捡；用户算符与内建的在同一张候选表里，同签名是替换）、
   **文件级变量**（第二十四刀：核心方言加了 `(global 名字 类型)`，函数里读得到、改得到）、
   **模块**（第二十五刀：`import` / `access` / `access … as` / `from … access` ——
   一份文件一个单元，模块体成为 `asy__init<k>`，调用点就在 import 那一行）、
   **`explicit` 形参**（第二十六刀：那个槽只收类型一模一样的实参，连内建提升都挡）、
   **用户定义的转换**（第二十七刀：`T operator cast(S)` 管所有隐式位置、
   `operator ecast` 只管 `(T) x`；代价与内建提升同价，不串）、
   **`autounravel`**（第二十八刀：struct 体里带它的声明其实是**文件级**的），
   三十四份用例在五个执行器上与 `asy -noV` 逐字节相同。
   **还没做**的是给切片赋值、多维数组、
   字符串的 `reverse`/`insert`/`split`、
   自引用字段、把方法当值取出来、struct 体里的算符、函数里用文件级的 pair/记录/数组变量、
   标准库那 84 个模块（`import graph;`）与 `unravel`/`include`/参数化模块，
   与 `operator init` 剩下的两种形态
   —— 每一条都在
   `tests/asy/bad/` 里有一份带 `ASY_NOPE` 的用例钉着，不是含糊的"待办"。
   超越函数（exp/log/trig）是**另一回事**：不是没做，是量过 libm 与 V8 在最后一位就分叉，
   所以它们走 `rmath` 转手宿主、用例落在 `tests/asy/tol/` 而不是逐字节那一节；
   pair 上的 `angle`/`unit`/`dir`/`expi` 同一条路（`tol/pair`，见下面 pair 那一节）。
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

**为什么超越函数不是"补一份自己的实现"就能了事**（第二十八刀之后补量的三条，它决定了
绘图层那道门槛怎么走）：

- 分叉有多大：同一批 20 万个输入上算 `sin/cos/tan/atan/exp/log`，libm（macOS）与 V8 的
  120 万个结果里 **51.1 万个位不同**；把它们按 asy 自己的输出格式 `%.15g` 印出来，
  **还有 31.7 万个字符串不同**。也就是说"位差一点、印出来一样"这个侥幸不成立 ——
  分叉在 asy 的可见输出里。
- 那"我们自己写一份正确舍入的"行不行？不行，因为**判分的那一方自己就不是正确舍入的**：
  用 `bc -l`（scale=45）当高精度参考，400 个随机输入里 macOS libm 的 `sin` 有 **28 个**
  差 1 ULP，V8 有 **22 个**差 1 ULP（而且两边差的不是同一批）。所以任何正确舍入的实现
  都会与 `asy -noV` 在这些点上印得不一样 —— 逐字节判分这条路，对超越函数从根上走不通。
- 结论（**改过一次，见下**）：既然逐字节判分对这一族从根上不成立，就**转手宿主的数学库**
  （C 走 libm、JS 走 `Math.*`），测试契约换成**带容差**的比较 —— 腿与腿之间也按容差。
  这不是放松标准，是把"位精确"这个要求放在它真正成立的地方：它对整数、字符串、精确浮点
  运算成立，对超越函数在任何两份 libm 之间都不成立（glibc 与 macOS 也不成立）。

**走过的弯路（记下来，因为它看起来很有道理）**：上面这条结论一开始推出的是另一个形状 ——
「自己出一份可移植实现，于是六条腿彼此逐字节一致」。照这条做了三批：`exp`（Cody-Waite +
13 项泰勒）、`sin`/`cos`（Dekker double-double 归约）、`log`（二分缩放 + `2*atanh`），
每一批都量过 ULP，都进了 `stage0/lib/math.sx`。**然后被推翻了**，理由一句话：
这些是标准库的东西（C99 的 math.h、ECMA-262 的 Math），自己写就是重造轮子 ——
造出来的还更差（自己那份 `sin`/`cos` 2 ULP、`atan` 4 ULP，libm 一般 ≤1 ULP），
而且每加一个函数都是两百行 .sx 加一轮测量，与「支持一门语言的成本应该是读它的表」正好相反。
留下的教训不是那几份实现，是那个判断：**跨腿逐字节一致**这条纪律很有价值，但它值不值得
用「重写标准库」去换 —— 不值得。换成容差，加一个函数就是绑定表上一行。

那一轮里唯一留下来的是一个真 bug：`exp(-10.0)` 在 `run` 与 `run-c` 上差 1 ULP，
原因是 clang 默认 `-ffp-contract=on`，把 Horner 里的 `a + r*s` 合成了 FMA（少一次中间
舍入）。核心方言的 `(bin "*" …)` / `(bin "+" …)` 是**逐个运算**的语义，编译器不许替我们
改写，所以 C 与 LLVM 两条腿都加上了 `-ffp-contract=off` —— 这条与超越函数怎么绑无关，
是核心方言的语义要求，留着。

### 内建函数属于**绑定表**，不属于降级器

上面那份 exp 一开始是写进 `frontend-asy/lower.js` 的（一张 `ASY_MATH` 常量表加一段
HELPERS 正文）。那是**放错了层**：数学不是 asy 的语法。看一眼 asy 自己怎么组织的就清楚 ——
`builtin.cc` 里是

```cpp
addRealFunc(sin,SYM(sin));   addRealFunc(exp,SYM(exp));   addRealFunc(log,SYM(log));
```

一张「名字 -> 实现」的表（而且 `addRealFunc` 一次注册两条：`real f(real)` 与自动抬升的
`real[] f(real[])`），实现本身在 libm；再往上 84 个 `base/*.asy` 才是库。语言那边都不把
这些当语法，我们更不该按语言各写一份。**每支持一门语言就手写一大堆 lower.js，这条路不
可扩展**，所以形状是三层：

- **实现**：宿主的数学库。核心方言的 `(rmath "NAME" …)` 白名单就是 C99 math.h 与
  ECMA-262 Math 的**交集**（27 个：原来那七个加上 sin/cos/tan、反三角、双曲、
  exp/expm1/log/log10/log1p/cbrt/hypot）。C 与 LLVM 两条腿 call `omni_r_*`（`omni_math.c`
  里一层薄包装转手 libm），JS 那条腿走 prelude 的 `$r_*`，解释器走 `js_math` 的同名 op ——
  三条路都只是转手，没有一份我们自己写的算法。
- **绑定表**：`stage0/src/frontend-asy/builtins.tab`，一张数据表（名字 / 实参个数 /
  返回类型 / 实现在哪 / 符号），两种去处：`rmath`（上面那个白名单）与
  `nope`（宿主没有、要用就得自己实现，报错里说清是哪一个 —— `gamma`/`erf`/`Jn` 那一族）。
  它是**生成的** —— `gen-builtins.js` 读 asy 自己的两份数据：`runmath.in` 里带签名的声明
  （`Int ceil(real x)` / `real fmod(real x, real y)`）与 `builtin.cc` 里
  `addRealFunc(sin,SYM(sin))` 那一族，现在出 52 行。手抄一份等于把别人的表复制进我们的
  代码里，下次 asy 升级没人知道差了什么。「实现在哪」那一列是**我们的**策略（生成器里的
  `POLICY`），不是从 asy 抄的。`real f(real)` 到 `real[] f(real[])` 的自动抬升
  是这一层的**通用规则**，将来是表上加一列，不是 22 个分支。
- **库**：asy 的 `base/*.asy`（含 `plain.asy`）用我们自己的模块系统编（第二十五刀已经
  通了），不重新实现。看起来像"内建"的一大半其实在这里。

降级器只留**真正的语言语义**：名字解析的顺序、重载打分、隐式转换、语句形态。
文件 IO 仍然在驱动（cli.js）里 —— 语法表、模块、绑定表都是它读进来的数据，
降级器只拿解析好的表。这条跟 `loadGrammar` 是同一个路子，不是新机制。

第八条测试轴因此多了一节 `tests/asy/tol/`（`exp`/`log`/`sincos`/`atan` 四份）：
腿与腿之间、以及与真 asy 之间都只要求最后一位十进制差不超过 1。实测四份里三份仍然
五腿逐字节相同、也与 `asy -noV` 逐字节相同；只有 `exp(-10.0)` 一处 V8 与 libm 差
一个十进制步长（`4.53999297624848e-05` vs `…49e-05`，真 asy 跟 libm 一边）——
容差正好是为这一处买的。逐字节仍然是 `cases/` 那 34 份的契约，一点没松。

落地是"接上已有的那一份"：`omni_math.c` 的 `omni_r_*` 各包一层 libm（从七个涨到 27 个）、
JS prelude 的 `$r_*` 全部走同一个 `$js_math`（`round` 那条要自己绕过 `Math.round` 的向上
舍入：C 是**离零**舍入，`-2.5 → -3`）、解释器走 `callJsOp('js_math', …)`、LLVM 的 `RT_OPS`
补齐同样 27 条，MIR 照旧一行没改。两个后端里那段 `case 'rmath_sqrt': case …` 的名单改成
`e.name.startsWith('rmath_')` 一句 —— 名单只在核心方言（`sexpr/lower.js` 的 `RMATH`）
把关一处，加一个函数不用改四处。asy 的 `sqrt/fabs/abs/floor/ceil/round/fmod` 和 real 上的
`^` 都降到它；`floor/ceil/round` 回 **int**（量的：`int i = floor(2.7)` 编得过），所以外面
再套一层 `(toint …)`；`abs(int)` 走一个 `asy__iabs` 的纯整数比较，绕一趟 real 会在 2^53
以上丢精度。

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
所以这条边界的理由换成了"每格要造一个新的，而 anew 的零值只求一次"，见「支持面第八阶段」。
再后来这条边界整个拆了，见「多维数组」那一节：零值就是空引用，`bad/arr-nested` 退役，
换成 `cases/14-ndarrays` 与 `bad/arr-nullrow`。）

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

**判分的人不是我**：`tests/asy` 的三十四份用例（算术 / 字符串 / 两种引号 / 控制流 / 函数 /
real 的 %.15g / `? :` / 数学函数 / 数组 / pair / 切片与整数组输出 / for-each /
字符串函数 / `pair[]` / 默认实参与命名实参 / 重载解析 / struct / struct 的 pair 字段 /
struct 的数组字段 / struct 的记录字段 / `A[]` / struct 的方法 / 构造函数 /
文件级 operator init / 算符重载 / 用户算符与内建算符的关系 / 文件级变量 / 模块 /
模块里的 struct 与默认实参 / `explicit` 形参 / 用户定义的转换 / 模块里的转换 /
反方向的转换 / `autounravel`）每份都是
「五条腿逐字节相同 == `.expected` == `asy -noV` 当场重跑」。`.expected` 本身就是真 asy 的
输出生成的；机器上没装 asymptote 时那一节打印 skip，但 `.expected` 仍然把答案钉住。
用例目录里 `mod_*.asy` 不是用例而是**被 import 的模块**，三节测试都在用例文件自己的目录里
跑（cwd）—— asy 是按当前目录找模块的，量过。

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

第一刀的边界都在 `tests/asy/bad/`（22 条，每条的期望值都必须以 `ASY_NOPE` 开头 ——
"还没做"和"做错了"必须能一眼分开）：
标准库模块（`import graph;` —— 用户自己写的模块第二十五刀通了；
`operator cast` 那条第二十七刀通了，那份用例搬成了 `cases/33-castback`）、隐式缩放（`105cm`）、宿主数学库里没有的那些内建函数（`gamma`/`erf`/`Jn` 那一族 ——
C99 有 `tgamma`/`erf` 但 ECMA-262 的 `Math` 没有，要用就得自己写一份给六条腿共用；
超越函数走 `rmath` 转手宿主，用例在 `tests/asy/tol/`）、函数里用文件级的 **pair/记录/数组**变量
（标量的那些第二十四刀通了，见下面那一节；`bad/global-read.asy` 因此换成了
`bad/global-pair.asy`）、
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
所以 `strict/` 里的用例要求：我们拒，且装了 asy 的话**真 asy 也拒**。现在有二十八条：后缀
`++`、pair 上的 `<`、pair 上的 `%`（这两条 asy 报的是 "no matching function
'operator <(pair, pair)'"）、`length(int[])`（`length` 只有 string 和 pair 两个重载）、
按不存在的形参名给命名实参（asy 报 "cannot call 'void f(int a)' with parameter 'int b'"）、
**歧义的重载**（`p(real)` 与 `p(pair)` 遇上 `p(1)`：asy 报 "call of function 'p(int)' is
ambiguous"）、**引用后面才声明的函数**（asy 报 "no matching variable 'b'"）、
**`write` 一个 struct**（asy 报 "no matching function 'write(A)'"）、
**给 pair 的分量赋值**（`z.x = 5` 与 `a.p.x = 5`：asy 报 "virtual field is read-only"）、
没有 `void operator init` 时写 `A(…)`、在 struct 声明之前拿它当类型、
**记录上的大小比较**（只定义了 `operator <` 不白得 `<=`）、
**声明 `operator &&`**（asy 那边是 syntax error）、
**函数里引用后面才声明的文件级变量**（asy 报 "no matching variable of name 'g'" ——
第二十四刀加的，与"引用后面才声明的函数"、"在 struct 声明前拿它当类型"是同一条规矩的
第三处）、
**`access m;` 之后裸用模块里的名字**（asy 报 "no matching variable 'mv'" ——
第二十五刀加的：`access` 只给限定名，只有 `import` 才把名字铺成裸的）、
**给 `explicit real` 的槽喂一个 int**（asy 报 "cannot call 'void p(explicit real r)'
with parameter 'int'" —— 第二十六刀加的：explicit 连**内建提升**都挡）、
**用户转换串两次**（`A operator cast(int)` 接 `B operator cast(A)` 之后 int 到 B 不通；
只有 `V operator cast(real)` 时 int 到 V 也不通 —— asy 报 "cannot call … with
parameter 'int'"）、**隐式位置用 `operator ecast`**（asy 报 "cannot cast 'int' to 'U'"）、
**用户转换与内建提升打平**（`p(real)` 与 `p(V)` 遇上 `p(3)`：asy 报 ambiguous ——
这三条是第二十七刀加的，它们钉住的是转换的**代价与传递性**：同价、不串）、
**在 struct 前面用它体里 `autounravel` 的名字**（asy 报 "no matching variable 'auq'" ——
第二十八刀加的：`autounravel` 铺出来的名字，可见位置是那个 struct 的位置）——
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
七条 helper 里（`asy__pmul` / `pdiv` / `pabs` / `pconj` / `pneg` / `peq` / `pairstr`，
后来又加了四条：`pangle` / `punit` / `pexpi` / `pdir`），
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
- **复数幂**（2026-08-27 收进来）：asy 是**两个重载**，判据是指数的**静态类型**、不是它的值。
  这一条是量出来的，而且推翻了"看看指数是不是整数"这个想当然：`int k=30; (1,2)^k` 印
  `(-6890111163,29729597084)`（整数，精确），而 `real e=30;` 与 `pair w=(30,0);` 都印
  `(-6890111162.99996,…)`。
  - 指数是 int：反复平方（低位在前），负指数取倒数。84 组 (底,指数) 的扫描里这个形状
    对上 75 组，剩下九组差最后一两位 —— asy 那边是 libstdc++ 的 `__complex_pow_unsigned`，
    复数乘法带 NaN 修补，我们没有（`(1.1,2.3)^1000` 那种溢出点上是 `(inf,-inf)` 对
    `(inf,nan)`）。
  - 指数是 real / pair：`exp(w * log z)`，`log z = (log(abs z), angle z)`，而且 `w * log z`
    是**复数**乘法 —— 即使 w 是实数也照乘。这不是宿主的 `cpow`：`(1e200,1e200)^0.5` 在
    asy 是 `(nan,nan)`（朴素 abs 溢出成 inf），`cpow` 走 hypot 给的是
    `1.09868411346781e+100`；`(1e-200,1e-200)^0.5` 也是 `(nan,nan)`，因为虚部那一项是
    `0*(-inf)`。两条都量过，两条都是"照抄形状"才能对上的地方。
  - 零底数在前面挡一刀：`(0,0)^非零` 是 `(0,0)`、`(0,0)^(0,0)` 是 `(1,0)`。
  用例 `tol/pow`（22 行）在五条腿上与真 asy **逐字节相同** —— 落在 `tol/` 是因为上面那两
  条最后一位的分叉迟早会出现，不是因为现在就差。落地时顺手抓到一处旧的就地修改：
  `opBuiltinSig` 里的 `promote` 会**改写**操作数（int 提成 pair），所以"按指数的静态类型
  分路"必须在它之前留一份快照，否则 `pair^int` 永远走不到。
- `angle`/`unit`/`dir`/`expi` 这一族（2026-08-27 收进来）：先前它们在门外，理由是
  「量不出 `unit` 用的是乘倒数还是逐分量除」。真正的出路不是继续猜，而是**换判据** ——
  超越函数改成转手宿主数学库之后，这一族的用例落在 `tol/`（`tol/pair`，16 行与真 asy
  逐字节相同），而 `unit` 的那道分叉本来就在 `%.15g` 底下印不出来。量出来的形状：
  `unit` 是**逐分量除以朴素 `abs`**（`unit((1e200,1e200))` 因此是 `(nan,nan)`，
  不是 hypot 的 `(0.707…,0.707…)`）、`unit((0,0))` 是 `(0,0)`（不报错）、
  `expi(t)` 是 `(cos t, sin t)`、`dir(deg)` 是 `expi(deg*pi/180)`（所以 `dir(45)`
  两个分量不对称：…548 与 …547）、`dir(pair)` 就是 `unit`。
- `angle((0,0))` 是**运行期错误** "taking angle of (0,0)"，而 `angle(z,false)` 给 0。
  libm 的 `atan2(0,0)` 是 0 不报错，所以这一刀必须在 atan2 之前 —— 它是核心方言
  `(fail E)` 的第一个用户。原来那份 `bad/pair-angle` 因此退役。

顺带被自举链抓到一条封闭 ABI 规矩：模块级的名字**全局唯一**。新写的 `opText` 与
`mir/print.js` 里同名的那个撞了，`C1 = C0 emit-js` 当场红，改成 `asyOpText`。

### 已落地（triple，2026-08-27）：宽度 3 编不出来，所以垫成 4

`triple` 是核心方言的 **`(vec real 4)`，第 3 道恒为 0**。这条选择本身值得记：

- `(vec real 3)` **不合法**，而且不是"没做校验"：MIR 的类型码把向量宽度存成**对数**
  （`mir/ir.js`，8 位类型码的高 3 位），3 在那个编码里根本不存在。放开它是重画类型码，
  牵动 MIR + 三个后端 + SPIR-V —— 为一个"能用 vec4 表示"的类型付这个代价不值。
- 硬件本来就把 vec3 垫成 vec4（SIMD 寄存器、GPU 的 vec3 都按 16 字节对齐），所以这不是
  将就，是常规做法。代价写在明处：一个 triple 占 32 字节而不是 24。
- 垫出来那一道**不参与语义**：所有 helper 都逐道写死，`==` 只比前三道（`asy__teq`），
  `write` 也只印前三道（`asy__triplestr`）。

语义与 pair **不是**一套，全部量过：`+ -` 逐分量且两边必须都是 triple
（`(1,2,3)+1` 在 asy 是 "no matching function 'operator +(triple, int)'" —— 没有
int/real→triple 的隐式转换，而 pair 那边**有**）；`* /` 只有 triple 与 real 那一个重载，
逐分量乘要写 `realmult`；`abs` = `length` 是朴素平方和开根（`abs((1e200,1e200,1e200))`
是 inf，跟 pair 一致）；`dot`/`cross`/`realmult` 在 pair 上**也各有一个重载**
（`cross(pair,pair)` 回的是实数 -2）；`dir(θ,φ)`/`expi(θ,φ)` 两个实参那一族回 triple
（`expi(θ,φ) = (sinθ cosφ, sinθ sinφ, cosθ)`，逐位对上）；`.x/.y/.z` 与
`xpart/ypart/zpart` 是只读的虚字段。

落地面：字面量、默认值 `(0,0,0)`、比较、复合赋值（变量与字段）、`triple[]`（裸数组那
一整套，含切片与 for-each）、形参/返回值、struct 的 triple 字段。判据是
`cases/35-triple`（45 行，五条腿一致且与 `asy -noV` **逐字节**相同）与 `tol/triple`
（unit/dir/expi 那几条）；`strict/` 多了六条钉住 asy 自己就不收的：`triple*triple`、
`triple+int`、`triple<triple`、`t.x=5`、`zpart(pair)`、`triple t=(1,2)`。
`bad/triple` 因此退役。

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
（后话：这条边界后来整个拆了 —— 行的零值就取**空引用**，读它是运行期判空，
与 asy 的 `new real[3][]` 一致，见「多维数组」那一节。）

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

两条边界（**第一条已经在第二十七刀里落地了**，见下面那一节）：`operator cast`（asy 的隐式
转换）当时在门外，理由不是形态难认，是它会改**重载解析的打分** —— 一旦用户能加转换，
"要几次转换"就不再只由内建提升表决定，而那张表是第十一刀量出来钉死的；把打分量清
（同价、不串）之后它才进来，`bad/op-cast.asy` 也因此搬成了 `cases/33-castback`。
struct **体里**的算符还在门外，量过 asy 收这个声明但
它**不参与** `a + b`（那边照旧报 "no matching function 'operator +(V, V)'"），
量不出它能被什么调到就不猜。

`operator &&`/`operator ||` 是另一类：量过 asy 那边是 **syntax error**（camp.y 的 operator
产生式里没这两个 token），所以它是 `strict/op-logic` 而不是 `bad/` —— 这一条最初就放错了
地方，是"每条规则都得量一遍"这句话的又一个例子。

### 已落地（支持面第十三阶段：模块级变量，门槛 2 第二十四刀）

这一刀**不是**零后端改动 —— 它给核心方言加了一条形式，而且是**模块那一刀的前置**：
asy 的模块状态就是一批文件级变量（量过 `import m;` 之后 `m.counter` 与裸的 `counter`
是同一份存储、`m` 里的函数改的也是它），没有全局量就没有 import。

方言里的形式刻意只有声明，**没有初值**：

    (global NAME TYPE)      ;; 零初始化；读写就用现成的 (var NAME) / (set NAME E)

理由是「初值什么时候求」是门语言设计：asy 是**按文件顺序、在那一行**求（量过
`int t = tick();` 与前后两句 write 的顺序看得出来），别的语言可能提前、可能懒。汇聚层
不替谁定，于是 asy 前端把一句 `int counter = 7;` 降成「一个 `(global …)` + 原地一句
`(set …)`」——那条语义是**照搬**的，不是模拟的。

一路上真正改了的地方比想象中少，因为 MIR 早就有全局：`GLOAD`/`GSTORE` 两条指令、
`MirModule.globals` 池、验证器、字节哈希、打印器、MIR 解释器、OIR 解释器、JS 与 C 后端
**全都是现成的** —— JS 前端的 `jsGlobals`（ADR-0011）早就需要它。这一刀补的是四处：

- 核心方言的语法入口与「名字先局部再全局」的解析（`sexpr/lower.js` 的 `nameRef`）；
- OIR 侧一个**带类型**的全局概念（`globals` + `GlobalRef` 节点）—— 不复用 `JsGlobal`，
  那个节点的类型被硬编码成 `T_DYN`；
- MIR 的 `globalTy[]`（与 `globals[]` 同下标的类型码）。**没有**把类型塞进 `globals`
  的元素里：那个数组的元素是字符串这件事被 `bytes.js` 的哈希与 `print.js` 的清单直接
  用着，换成对象会静悄悄改掉「同一份输入两次编译逐字节相同」；
- LLVM 那条腿：`@g_名字 = internal global T zeroinitializer` 加 GLOAD/GSTORE 两条
  （`load`/`store`，与槽位那两条同一个形状，只是地址是全局符号）。

两条边界，各有一份 `bad/`：**聚合的全局**（`(global here Node)`）——聚合的身份不在 MIR 的
8 位类型码里（`(arr int)` 与 `(arr string)` 在那里是同一个码），全局池要带身份得先加
一列，那是另一刀；**kernel 里读全局**（`bad/global-kernel.sx`）——SPIR-V 的全局得挂在
某个存储类上，选哪个是接口设计，要的数据从 `(buf …)` 形参进来。

asy 那边因此只收 int/real/bool/string 的文件级变量；pair/记录/数组照旧当 `(main …)` 的
局部量（文件级还能用，函数里看不见），`bad/global-read.asy` 换成了更窄的
`bad/global-pair.asy`。顺序解析多了第三处：函数体只看得见**前面**声明的文件级变量
（量过 asy 报 "no matching variable of name 'g'"，`strict/global-fwd` 钉着）；
同一个名字声明两次是**两个变量**（量过），所以每份声明各出一个符号
`asy__g<序号>_<名字>`。

### 已落地（支持面第十四阶段：模块，门槛 2 第二十五刀）

**核心方言零改动。** 模块整个是前端的事：一份 `.asy` 文件是一个**单元**，出来的还是
一份 `(module …)`，六条腿一条都不知道有过 import。

形状四件：

- **符号前缀**。单元 k 的函数名前面挂 `asy__m<k>_`，主文件那份前缀是**空串** ——
  于是不含 import 的程序降出来的文本一字不变，老用例的 `.expected` 与「同一份输入两次
  编译逐字节相同」都不受这一刀影响。struct 名不挂前缀：class 名、方法名
  （`asy__m_<记录>_<方法>`）、构造函数名都按记录名拼，所以记录名是**全局共享**的一个
  命名空间，两个模块里同名的 struct 这一刀拒（`bad/mod-dup.asy`）。
  —— **第三十八刀改了这一条**：撞上不拒了，真名打散（见下面「遮住外面来的那个类型名」），
  那个用例升成 `cases/72-mod-dup`。
- **模块体成为一个函数**。单元 k 的顶层语句降成 `(fn asy__init<k> () void …)`，
  调用点就在**导入那一行**的语句流里 —— 于是"体在那一行跑"是照搬的。开头两句是
  `(global asy__ran<k> bool)` 门闩：量过 `import m; import m;` 只跑一遍，而同一个模块
  被两个模块导入时调用点有两处，所以这道闩得在运行期。
- **导入 = 并表**。模块的候选表/全局表/记录表并进导入方，可见位置记成**那条 import 的
  下标**。于是三条量过的语义全是白捡的：顺序解析（import 写在后面时前面看不见）、
  本地声明遮蔽、以及**传递性**（并的是模块自己的表，那张表里已经含着它导入的东西）。
  `access` 不并表只记别名（限定名走 `m.x` / `m.f(…)`），`from m access f;` 只并指名的
  那几个。方法不并：它们跟着 struct 走（按声明那个单元的表查），`import` 一个 struct
  就连方法带构造函数一起有。
- **找模块按 CWD**。量出来的：`asy -noV sub/user.asy` 里的 `import mm;` 找**不到**
  `sub/mm.asy`。所以 `tests/asy` 三节都改在用例文件自己的目录里跑，判分的真 asy 与我们
  站在同一个目录里；用例目录里 `mod_*.asy` 不是用例，是被导入的模块。

门外的（各有一份 `bad/`）：标准库那 84 个模块（`import graph;` —— 那一摞的底是绘图层）、
`unravel`、`include`、参数化模块（`from collections.map(K=int) access …`）、
`from m access *`、限定名当赋值目标（`m.x = 3`；裸名字那条通的）。
还有一条是我们语法表的窄处：`import sub.mm;`（带点的模块名）—— camp.y 的 `stridpair`
只有单个 ID 或字符串，asy 靠词法阶段的特殊处理接住带点的路径，我们的表还没有。

`strict/` 多了一条：`access m;` 之后**裸用**模块里的名字要拒（量过 asy 报
"no matching variable 'mv'"）—— 只有 `import` 才把名字铺成裸的。

### 已落地（支持面第十五阶段：`explicit` 形参，门槛 2 第二十六刀）

**核心方言零改动，降级器加了两行半。** 起因是量出来的：`math.asy` / `graph.asy` /
`three.asy` 这三份标准库模块的**第一个**拦路虎就是 `explicit` 形参。

规则四条，全是 `asy -noV` 量的：

- `void p(explicit real r)` 这个槽**只收类型一模一样的实参** —— `p(3.0)` 通，`p(3)` 报
  "cannot call 'void p(explicit real r)' with parameter 'int'"。也就是说它连**内建提升**
  都挡，不只是挡用户的 `operator cast`（第二十七刀）；
- 它**不进签名身份**：先 `void p(real)` 再 `void p(explicit real)` 是**替换**（之后
  `p(3.0)` 走后者、`p(3)` 直接报错），反序则是那份 explicit 被换掉。所以降级器里
  `params`（重载身份的 key）一个字都不用改，标记挂在 `ps[k].exp` 上；
- 一支 explicit 一支不 explicit 时，explicit 那支**根本不匹配**，另一支赢，不算歧义；
- 算符（`bool operator ==(explicit V a, V b)`）与数组形参上一样管用。

于是实现就是：`formals` 记标记、`fit` 多问一句 `实参类型 !== 形参类型 就不匹配`、
诊断里把 `explicit` 印出来（不印的话"没有能匹配的签名"会显得莫名其妙）。
`cases/30-explicit` 钉住上面前三条与后一条，`strict/explicit-int` 钉住"连内建提升都挡"。

### 已落地（支持面第十六阶段：用户定义的转换，门槛 2 第二十七刀）

**核心方言零改动。** `operator cast` 原来记在 `bad/` 里，理由写得很清楚：它会改**重载解析的
打分**，而那张打分表（`fit` 里的 `asyConvCost`）是第十一刀量出来钉死的。这一刀先把打分量清，
再动手。六条都是 `asy -noV` 量的：

- `T operator cast(S)` 在**所有隐式位置**都管用：实参、初始化、`return`、数组元素赋值、
  数组字面量、struct 字段默认值；
- `T operator ecast(S)` **只**给 `(T) x`：只写 ecast 时 `U b = 5;` 报
  "cannot cast 'int' to 'U'"，而 `(U) 5` 通；
- **代价与内建提升同价**：`void p(real)` 与 `void p(V)` 加上 `V operator cast(int)` 之后
  `p(3)` 报 "call of function 'p(int)' is ambiguous"。所以降级器里补的分是 1，不是
  "比提升贵一点" —— 给它一个更贵的分数就会偷偷分出胜负，那正是先前不敢收它的那个风险；
- **不串**：用户接用户（`A operator cast(int)` 加 `B operator cast(A)` 之后 int 到 B）
  与内建提升接用户（只有 `V operator cast(real)` 时 int 到 V）都不通。于是查表时源类型
  必须**一模一样**，一句 `c.src === from` 就够，不需要做传递闭包；
- **顺序解析**：写在调用点后面的那份不算，同一对类型写两份就是"各管后面那一段"
  （跟文件级 `operator init`、文件级变量、模块别名是同一条规矩的第四处）；
- `import` 把模块里的转换一起带进来（`from m access f;` 那种不带 —— 转换不挂在名字上，
  那张改名表管不到它，这一条没量，所以不猜）;
- **重载算符的操作数也走它**：`V operator +(V,V)` 加 `V operator cast(int)` 之后 `a + 1`
  通（量过）。这一条是白捡的 —— 算符走的是同一个 `applyCall`。

实现是四处：`castSig` 把候选按**目标类型**存（它们不进 `funcs` —— asy 里这个名字也调不到）、
`castFor` 按当前位置挑一份、`coerce` 在内建那几条之后兜底、`cast()`（`(T) x`）多收 ecast。
`cases/31-cast` 钉住八个位置与顺序解析，`cases/32-modcast` 钉住模块，
`cases/33-castback` 是原来那份 `bad/op-cast` 搬过来的（struct -> int 的反方向），
`strict/cast-chain-user`、`strict/cast-chain-promote`、`strict/cast-ecast-implicit`、
`strict/cast-tie-real` 钉住四条拒绝。

### 已落地（支持面第十七阶段：`autounravel`，门槛 2 第二十八刀）

**核心方言零改动，降级器加了三十行。** 起因是量出来的：`rational.asy` 卡在
`autounravel rational operator cast(int p)` 上 —— 那是**写在 struct 体里的文件级声明**。
先量清它到底是什么（`asy -noV`）：

- 不带 `autounravel` 的 `real operator cast(R r)` 写在体里，asy **收这个声明但不用它**
  （`real x = r;` 报 "cannot cast 'R' to 'real'"）—— 跟 struct 体里的二元算符同一回事；
- 带上 `autounravel` 就通了：`real x = a;`、`R a = 4;`、`a + 3`、`size(z)` 全都按
  **文件级**的规矩走，形参是显式的（没有 `this`）；
- 可见位置是**这个 struct 的位置**：写在 struct 前面的地方报 "no matching variable"；
- `autounravel int k = 9;`（变量）也铺到文件级 —— 这半边还没做，见 `bad/au-var`：
  它要在 struct 那一行求初值并发一个 `(global …)`，而那一行现在只走声明遍、不发语句。

于是实现就是"别把它当成员"：`auMod()` 认出 `(modified (mods "autounravel") …)`，
`recordBody` 把这样的 `fundec` 交给 `sig()`（`at` 用 struct 的下标，于是顺序解析白捡），
正文攒在 `auFns` 里由 `bodyPass` 跟文件级函数一起发。算符与 `operator cast` 因此
一并落地 —— 它们本来就是走 `sig()` 的。`cases/34-autounravel` 钉住转换、算符、普通函数、
默认实参、"真方法还是方法"与重载共表六条，`strict/au-fwd` 钉住可见位置。
量到的收益：`rational.asy` 的拦路虎从 struct 体里的 cast 前进到**多维数组**。

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

### 已落地（绘图层的分界：C++ 那一面自己做，`base/*.asy` 引真的，2026-08-27）

asy 的绘图层是**两层**，这一刀先把界划清：

- **C++ 那一面**（19 个 primitive 类型 + `run*.in` 里那些函数）在真 asy 里是运行时自带的，
  每个文件、每个模块里都看得见，`base/` 里一行都没有它的声明。我们这一侧是
  `stage0/lib/asy/asy_builtins.asy` —— **用 asy 写的**，不是前端里的特例：
  `path` 是一个 struct（`knot[] nodes` + `cyclic`，照 `path.h` 的 solvedKnot 摆），
  `--` 是 `operator --`，EPS 是拼出来的字符串。每个单元在声明遍开头隐式 import 它一次
  （`builtinsIn`）：struct 只声明一份（核心方言的 class 名全局唯一，摊进每个单元会撞名），
  类型名与函数通过 `modMerge` 进来，可见位置是 0。
- **asy 那一面**（`base/plain*.asy`、`graph.asy`…）**不抄**：那本来就是 asy 源码，
  按 `ASYMPTOTE_DIR` 引真的那些文件。模块的找法因此是「当前目录 → ASYMPTOTE_DIR
  的每一段 → 我们的 lib/asy」。

前端为此只多了四样东西，都不是绘图层的知识：

1. **模块级变量收聚合**（`(global …)` 原来只收标量）。理由原先写的是「聚合的身份不在
   MIR 的 8 位类型码里」—— 量下来那个身份**根本不需要**：class 与数组在四条腿上都是
   一个指针（LLVM 的 `T_AGG`/`T_ARR` 都是 `ptr`，两个解释器按名字存对象，C 那条腿拿的是
   OIR 的完整类型），字段与元素的身份是从**表达式**的 OIR 类型来的。
   没有初值的聚合全局要发那句 `(set g (cnew A))`：零就是 null，一读就是 null reference。
   `dotQual` 也补了第三档（局部 → this 的字段 → 文件级），不然 `currentpicture.ops` 不认。
   五条腿与真 asy 逐字节一致，`cases/37-global` 钉着；原来的 `bad/global-pair` 退役。
2. **`string(x)`**：只有 `string(Int)` 与 `string(real, Int digits=DBL_DIG)` 两条重载
   （量过，bool/pair/string 那三档 asy 自己就报 no matching function，钉在
   `strict/string-bool`）。绘图层拼 PS 文本要的就是它 —— 坐标是 `%.6g`。
3. **`include m;`**：文本级引入，在收表**之前**就把那个文件的顶层项摊进当前单元的 `rs`
   （下标就是可见位置，后面几遍一个字不改）。`base/plain.asy` 那一串
   `include plain_pens;` 全靠它。`cases/39-include` 钉着，`bad/mod-include` 退役。
4. **`cycle` 落到一个名字上**：它在词法上是 LIT（camp.l 里走 `yylval.e`），所以
   asy 源码里声明不出这个名字；前端把它解析成 `cyclepath`，绘图层里 `path cyclepath;`
   带一个 `ismark` 标志。于是 `a--cycle` 就是普通的 `operator --(path, path)`。
   这是前端与绘图层之间**唯一**约定的名字。

EPS 那一头与真 asy 逐字节对过（`asy -noV -f eps`，只差 `%%Creator` 与 `%%CreationDate`
两行，`tests/asy/draw/tri` 钉着 —— 那一节的用例是**纯 asy 源码**，判分的人是真 asy）。
对上的都是量出来的，不是猜的：

- 坐标 `%.6g`（`psfile.h:160` 的 `*out << " " << x`，ostream 默认精度 6），
  HiResBoundingBox 是 `%.9g`（`psfile.h:30` 的 `setprecision(9)`）
- `size(200)` 解的是 `s*w + 笔宽 = 200`（150 宽的图出来是 199.5 = 150*1.33），
  笔宽**不**跟着缩放，所以宽度是 s 的分段线性函数 —— asy 那边是
  `plain_bounds.asy` 里的小线性规划，我们用二分（单调，64 次折半）
- 摆放：信纸 612×792 居中再各减 0.5（那 0.5 与笔宽无关，三个尺寸两种笔宽都对上），
  `translate` 把 bbox 左下角搬过去；描边按笔宽的一半外扩、填充不外扩
- 笔的状态是**增量**发的（`psfile.cc:242` 的 `setpen`：颜色/宽/cap/join/miter 各自比
  `lastpen`），闭合路径末尾多一句回到起点的 lineto 再 `closepath`（`psfile.h:295..312`）

还没做的（下一刀按"引真的 base"这条线推）：参数化模块
（`from collections.map(K=string, V=string) access Map_K_V as Map_string_string;`，
`plain_strings.asy:260`）、struct 体里的 `using` 类型别名（`plain_filldraw.asy:93`）、
`guide` 与 `..` 的 Hobby 求解（`knot.cc` 的三对角）、`transform`、Label（要 TeX）、clip。
`access settings` / `access version`（asy 那边是 C++ 模块）这一刀做了：
`stage0/lib/asy/settings.asy` 与 `version.asy`，字段的类型逐个照 `settings.cc` 的
`addOption(new …Setting)` 抄，只放 `base/plain*.asy` 真的读到的那些（量出来的 20 个）。
于是 `import plain;` 从"第 9 行就停"推到了上面那两条 —— 这一段是引真的 base，
`plain_constants` / `plain_strings` / `plain_pens` / `plain_paths` 这些 include 都进去了。

内建面**默认就在**（`OMNI_ASY_BUILTINS=0` 关掉，调它自己时用）：真 asy 那边这一面是运行时
自带的，`size(100);` 不 import 任何东西就跑得起来，要对上就不能靠环境变量。开了之后撞出
两件事，两件都是我们这边的模型错，改的是模型不是用例：

- **内建与库里的同名函数在 asy 那边是一个重载集**（`builtin.cc` 把内建也塞进那张表），
  而我们的内建面写死在前端里。原先的判据是"有没有同名的用户函数"，于是 `int length(path)`
  一可见就把 `length("ab")` 挡在门外；改成"两边**一起打分**、谁更同型谁赢"
  （`callName` / `builtinCost` / `builtinRaw`）。中间试过"没有一个合用才回退"，那是错的：
  `length(z)`（z 是 pair）会靠一次 `pair -> path` 的 cast 走到 `length(path)`，
  印 0 而不是 sqrt(5) —— 错的答案，不是报错。
- **`--` 只留 `operator --(path, path)`，pair 那三种重载换成 `path operator cast(pair)`**
  （真 asy 那条是 `guide operator cast(pair)`）。留着的话 `1 -- 2` 会在"用户的
  `operator --(real,real)`"与"我们的 `(pair,pair)`"之间打平（各一次转换），而真 asy 走用户
  那份。走 cast 就自动对上：`int -> pair -> path` 是串两次，第二十七刀刻意不收。

聚合的模块级变量（第二十四刀原先只收标量）也在这一刀放开了 —— 那条边界的理由
（"聚合的身份不在 MIR 的 8 位类型码里，全局池要先加一列"）量过是错的：LLVM 把
`T_AGG`/`T_ARR` 一律映射成 `ptr`，两个解释器按名字存对象，C 那条腿发全局用的是 OIR 的类型，
字段/元素的身份来自表达式的 OIR 类型。放开之后抓到一处真的分叉：
`from_oir` 与 JS 后端的 `rvalue` 判"是不是左值"时**漏了 `GlobalRef`**，于是
`(let p Pt (var g))` 在这两条腿上是别名而不是拷贝（树解释器一直是对的）。
`tests/sexpr/cases/13-aggglobals` 钉着这四条，原先的 `bad/global-agg` 退役。

测试的默认档也跟着调了（迭代速度是可用性的一部分）：`tests/asy/run.js` 默认只跑
`run` 与 `run-llvm` 两条腿（`OMNI_LEGS=all` 跑齐五条，提交前那一遍用它），每一节印耗时；
C 与 LLVM 两条腿的 `clang` 默认 `-O0`（`OMNI_OPT=2` 要性能数字时开）。
量出来的：74s -> 29s（五条腿 53s），而 `-ffp-contract=off` 与档位无关，所以语义没松。

### 多维数组（`(arr (arr T))`）

量出来的理由：真 `base/` 在场时，asymptote 那 220 个 examples 里 **163 个第一个撞的就是这个**。

做法上只动了两处，其余是既有的路：`arrIsBlob(elem)` 把"元素是句柄"这件事从
"只有 vec/class"扩到 `arr`（`hir/types.js`），LLVM 后端的 `fieldInit`/`arrRep`/`val()`
跟着认 `T_ARR`（元素宽 8，零是 `ptr null`）。行的零值是**空引用**而不是空数组：
`ANEW` 把一个**求过一次**的零值复制 N 遍，空数组做零值的话 N 行会共用同一条
（`a[0]` 上 push 一格 `a[1]` 也长）—— 那是一句静默的错答案。asy 那边同一个写法
（`new real[3][]` 之后 `a[0][0]`）也是运行期错误，所以这条边界与它对齐，
`tests/sexpr/bad/arr-nullrow` 钉着它，原先的 `bad/arr-nested` 退役。

放开之后抓到第二处真的分叉：**存进数组时拷不拷不能按 `Array.isArray` 猜**。
多维之前"元素在 JS 侧是数组"只有一个意思（向量，值语义，要拷），多维之后多了
"行"（引用语义，拷了就与 C/LLVM 分叉）。改成由调用方按**元素的静态类型**给一个
`cp`（`backend-js/prelude.js` 的 `$acopy`、`interp/builtin.js` 的 `arrCopy`），
`tests/sexpr/cases/14-ndarrays` 原先 JS 两条腿答 2/925、C 与 LLVM 答 3/1225。

判空也补齐了：`omni_arr.c` 里四份单态实现与 blob 实现的 len/get/set/push/pop 开头都是
`omni_nullck`，JS 侧对应 `$alen`/`$aget`/…（ALEN 原先是内联的 `.length`，读空行冒的是
宿主的 `TypeError`，C 那条腿直接段错误）。五条腿现在都是 `omni: runtime error: null reference`。

asy 那一侧（`frontend-asy/lower.js`）落地得比预想便宜 —— 那一层的类型本来就是字符串，
`real[][]` 天然可写，`asyCore` 也早就是递归的。真正要改的只有四处：
`dimsDepth` 认 `(dims+ …)` 的层数（原先只认一层）、`arrElemOk` 对元素递归、
helper 名字过 `asyMangle`（`asy__grow_real[]` 不是标识符，`asy__grow_arr_real` 才是）、
以及 `new T[n][m]` 生一个构造器函数 `asy__anew2_real`（长度是运行期表达式，铺行要循环；
生函数而不是往 `this.pre` 摊语句，因为 `new` 能出现在 `?:` 的两支里，那里 `this.pre` 是 null）。
花括号初值套花括号初值（`new real[][] {{1,2},{3,4,5}}`）在 `arrLit` 里递归 ——
里面那一层走 `this.expr` 是看不见"我该是 `real[]`"的。

量出来的三条 asy 行为逐条对上（`tests/asy/cases/41-ndarray`，与 `asy -noV` 逐字节相同）：
`new real[2][3]` 两层铺满、`new real[2][]` 外层 2 格每格空引用、`new real[][]` 长度 0。
`bad/arr-2d` 退役。收益：`import graph` 的第一个拦路虎从多维数组前进到
**函数类型的形参**（`math.asy:446` 的 `real findroot(real f(real), …)`）—— 那要闭包，是另一刀。

### 函数值：方言四条 + LLVM 那条腿的闭包

量出来的理由：真 `base/` 在场时，asymptote 那 **304** 个 examples 里 **203 个第一个撞的
是同一行** —— `math.asy:446` 那个函数类型的形参。（其余的头几名量级小一个数量级：
`frame`/`filltype`/`marker`/`align` 这些类型 4+3+2+2 份、`guide[]` 4 份，都是绘图层的。）

OIR 那一侧闭包早就齐了（ADR-0010 的 `{fp, c_*}`，Omni 语法的 lambda 走的就是它），
缺的是两处：**方言说不出来**，**LLVM 后端不认**。

方言加了四条，形状与 OIR 一一对应，没有新语义：`(fnty (T...) R)` 是类型，
`(cfn NAME (捕获) (形参) R …)` 声明一份闭包体（体里 `(cap c)` 读捕获），
`(mkclo NAME v...)` 造一个值（捕获**按值**求一次存进记录），`(callfn E a...)` 间接调用；
另有 `(fnref NAME)` 把普通 `(fn …)` 当值用 —— 它生成一个薄适配器闭包，于是调用处不必
区分"这是闭包还是具名函数"（与 `hir/check.js` 的 funcRef 同一条决定）。闭包体与普通函数
分成两个头而不是加个标注：捕获是**记录的字段**、不是形参，这在 ABI 上是两件事。

LLVM 后端原先见到 `closureId` 就抛"不支持"。现在：记录是命名类型
`%clo_N = type { ptr, 捕获... }`（第 0 格与 `struct omni_closure_s` 同一个布局），
`make` 是一个 private 函数（`sizeof` 用 `getelementptr T, ptr null, i64 1` + ptrtoint
那个标准常量写法），`CAPTURE` 是 getelementptr + load，`CALLFN` 先过 `@omni_ll_fnck`
判空、再从第 0 格取 fp 并把记录自己当第一个实参传回去（取 fp 与传 self 共用同一个
寄存器 —— 否则被调者会被求值两次，与 C 那边 fnCallHelper 同一条理由）。
踩到的一处：记录类型必须发在**函数之前** —— .ll 的解析器对 getelementptr 的基类型是
当场校验的，命名类型还没定义时它不透明，报 "base element of getelementptr must be sized"。
MIR 的闭包表因此多带一列 `capTypes`（类型码）：C 那条腿从 OIR 取类型，LLVM 只看 MIR。

收益（量的）：`tests/cases/21_null_fn_call.omni` 进了 `tests/llvm/supported.js` ——
**Omni 语法的 lambda 现在能走 AOT 与 JIT 两条 LLVM 路**，四方（jit/aot/interp/omni-c）
逐字节相同。`tests/sexpr/cases/15-fnvalues` 五条腿一致，`bad/fn-null` 钉住那句判空
（不判就是"跳到地址 0"，那是段错误而不是一句话）。

### asy 那一侧：函数类型只是一个字符串

asy 前端的类型系统全是**字符串**（`real[]`、`real(int,string)`），这一刀因此只动了四处：
`asyIsFn`/`asyFnSplit` 认 `R(P,…)` 这个拼法（`real(real)(int)` 那种歧义拼法直接不认）、
`asyCore` 多一个分支把它翻成 `(fnty …)`、`formals()` 多认 `fundecidstart`（形参表里的
形参表，也就是 `real f(real)` 这种形参）、调用点先查一次局部量：名字若绑着函数类型的值，
就发 `(callfn (var f) …)` 而不是按名字找重载。裸函数名当值用走 `nameOf` 的兜底 ——
只有**恰好一个**可见候选时才发 `(fnref …)`，多个重载或带默认值的一律 `nope`：
真 asy 那里选哪一个要看目标类型，我们还没有那个方向的推断。

量出来的收益：`math.asy:446` 从榜上**整条消失**，第一名换成
`graph_splinetype.asy` 的 `typedef real[] splinetype(real[], real[]);`（143 份）——
还是函数类型这一家，只是隔了一层 typedef；第二名是 `three.asy` 的自引用 struct 字段（46 份）。
还在门外的是**函数值类型的变量声明**（`real g(real) = twice;`，`bad/fn-value` 钉着）：
asy 收，而且方法取出来是绑住接收者的闭包，那要 `vardec` 走 `(mkclo …)`。

### typedef：别名表，一张表就够

`graph_splinetype.asy` 的 `typedef real[] splinetype(real[], real[]);` 接着上面那一刀 ——
语法早就在（camp.y 里 typedef 借的就是 vardec 那条产生式，所以名字藏在 `decid` 里：
`decidstart` 是普通别名、`fundecidstart` 是函数类型的别名），缺的只是**语义上没有这张表**。

加的是 `tyAlias`：逐单元的一张 `名字 -> 一串 {t, at}`，`t` 是**已经解析好的 asy 类型字符串**。
于是 `type()` 一查就换掉，下游（重载挑选、`asyCore`、零值表、helper 名字）一个字都不用改 ——
这是"类型全是字符串"那条设计付的第三次利息。asy 的 typedef 本来就不造新类型（量过：
`typedef int myint;` 之后 `int f(int)` 收 `myint` 的实参），所以"换掉"就是全部语义。

两处踩到的：**存一串而不是一个** —— 同一个名字可以 typedef 多次，而名字解析是顺序的
（量过 `typedef int again; again a=1; typedef string again; again b="two";` 两句各按自己
那一份算），这与文件级变量那张表是同一个形状；以及位置那一刀（`aliasAt` 挑"此处可见的
最后一份"，一份都不可见时报 `aliasLate`）—— 不裁就比 asy 多接受一门语言，
`strict/typedef-fwd` 钉着。`using X = T;` 那条产生式落在同一张表上，顺手也就通了。

量出来的：`graph_splinetype.asy` 的第一个坎从 `splinetype`（那句 typedef 自己）挪到了
同一个文件的第 244 行 `guide hermite(…)` —— 前进了 240 行，但**examples 的计数没动**
（还是 143 份撞它），因为下一个坎是绘图层的 `guide`。真 base 那 304 个 examples 里
能整份降下来的仍然只有 2 份。这一刀的价值在"路又通了一段"，不在计数。

顺出来的一件与一个坑。顺出来的：**函数值类型的变量**经 typedef 就通了
（`typedef real realfn(real); realfn h = twice; h = halve;` 五条腿都对）—— 因为那时
类型在 `type()` 里就成形了，`vardec` 见到的是普通的 `decidstart`。裸的
`real f(real) = twice;` 那个拼法还是 `nope`（`bad/fn-value` 钉着，真 base 里量过没人这么写）。
坑：`vardec` 的零值原来是 `ZERO.get(t)`，而函数类型不在那张表里 —— 拿到 `undefined`
之后那句 `if (init === null)` 拦不住，于是 `(let g (fnty (real) real) undefined)` 这行
字面把 JS 的 `undefined` 拼进了方言文本。现在没初值的函数值变量明确拦住（它的零值是
空引用，而 `(let …)` 一定要一个初值表达式，方言里还没有那个字面量），
非函数类型的零值也补了一句 `undefined` 的守卫。

### 换一把尺子：不数"第一个坎"，数 `import graph;` 的全部诊断

"304 个 examples 的第一个错"这把尺子到这里就钝了 —— 它只看得见第一条，而第一条落在
哪个文件取决于 import 的次序，一刀下去它可能只是**往后挪一格**。换的尺子是
`import graph;` 一句话下去的**全部**诊断，量出来 193 条，按种类分：

- 认不出的类型 80：`Label` 30、`interpolate` 12、`ticks` 10、`scaleT` 9、`transform` 5、
  `frame` 4、`bool3` 3、`autoscaleT` 3、`arrowbar` 2、`scalefcn`/`align` 各 1。
  其中 `interpolate`/`ticks`/`scaleT`/`autoscaleT`/`Label`/`arrowbar` 是 base 自己声明的
  struct —— 它们认不出是**连带的**（那些 struct 的声明里有别的东西先失败了）。真正的叶子
  只有 `transform`/`frame`/`bool3`：asy 的 C++ 内建类型，按 ADR 的界该由我们用 asy 写。
- 缺的内建函数 33：`abort` 6、`sgn`/`sequence`/`search` 各 3、`times`/`copy` 各 2，
  以及 `solve`/`tridiagonal`/`interp`/`degrees`/`radians`/`norm`/`minbound`/`maxbound`/
  `clip`/`cyclic`/`piecewisestraight`/`_findroot`/`labelmargin`/`OmitTick` 各 1。
- 未声明的变量 15（`infinity` 等）、`new`（匿名函数）15、`picture` 缺字段 12 + 缺方法 4。

这张表把下一步排明白了：**大头是内建面还没写够**（类型 3 个 + 函数 20 个 + 全局量若干，
全是 `stage0/lib/asy/` 里用 asy 写的活，前端一行不用改），其次是**匿名函数带捕获**
（15 处，方言的 `(cfn …)`/`(mkclo …)` 早就齐了），`Label` 那 30 处要 TeX、排最后。

顺着这张表当场做掉两件小的：

- `guide`：两行 —— `typedef path guide; path nullpath;`（typedef 那一刀刚落地就自己派上
  用场了）。`graph_splinetype.asy` 的**签名**（`guide hermite(…)`）因此过了；它的**体**里
  那句 `..controls A and B..` 还没过，`joinExp` 至今只认 `--`。所以这不是"guide 通了"，
  只是签名那一层通了。
- 函数值类型变量的**裸拼法**（`real f(real) = twice;`，4 处）：与 typedef 拼法走同一个
  `fnTypeOf`，另外 `globalNames` 要把这种声明记成"全局量收不下"（不记就拿到 `real`，
  后面那句赋值报"要 real，这里是 real(real)"）。连带修正一条诊断：`a.get` 那种"把方法
  取出来当值"原先漏成了泛泛的"struct A 没有字段 'get'"（而 A 确实有 `get` 方法，
  只是不是字段），现在是一句带 ASY_NOPE 的实话 —— `bad/` 里每条都必须是 nope。

两件做完 193 条**没有变少**：那 4 处函数值声明过了之后，当场撞上后面的坎（`Label`/`new`/
缺的内建函数）。这正是新尺子该有的读数 —— 它不奖励"把错往后挪"。

### 内建面补第一批：数与数组（193 -> 188）

`builtins.tab` 那张表只管**实数数学函数**（68 行，转手 libm / `Math.*`）；缺的那 20 个
名字里只有 `sgn` 在表上、还标着 `nope`，其余一个都不在 —— 它们不是数学函数，该去
`stage0/lib/asy/asy_builtins.asy` 用 asy 写。按"写得起 / 写不起"分开之后，第一批补的是
`pi`、`sgn`、`degrees`（real 与 pair 两个重载）、`radians`、`copy`（real[]/int[]/bool[]）、
`search`、`sequence`（`(n)` 与 `(a,b)` 两个重载）。

每一条的行为都是量的，不是猜的，而量出来的东西有一半跟直觉不一样：
`search({1,3,5,7,9}, 6.0)` 回 **2** —— 它不是"找到就回下标、找不到回 -1"，是
"**最后一个 <= key 的下标**"，key 比首元素还小才回 -1。`degrees` 有两个重载而且**归一化
不一样**：`degrees(pair)` 落在 [0,360)（`(0,-1)` 回 270），`degrees(real)` 不归一化
（`-pi/2` 回 -90）。`sequence(a,b)` 两头都要（`sequence(3,3)` 是 `{3}`、`sequence(4,2)`
是空数组）。这些若按常识写，五条腿会一致地给出一致的错答案。

两件顺带的：我们没有泛型，所以 `copy`/`search` 按 base 实际用到的元素类型各写一份重载
（math.asy 用的是 `real[]` 与 `bool[]`）；`quotient` 在表里是 `nope`，二分里改用 asy
自己的整除算符 `#`。

量出来 193 -> **188**，桶的变化比总数更有信息：缺的内建函数 33 -> 24（少了 9），
未声明的变量 15 -> 14（`pi` 没了），而 `new` 从 15 涨到 **18** —— 那 3 处是原先根本走不到、
现在才露出来的。写不起的那两类也量清了：`abort`（6 处，单个名字里最多）要在运行期抛一句
带自定义消息的错，而内建面里现在**没有任何抛错的手段**（`omni_errorf`/`$rt_error` 都在
运行时那一层，方言里没有对应形式）—— 拿"故意越界"假装它会印错消息、破掉逐字节相同，
所以它得单独一刀给方言加 `(abort E)`；`sequence` 带函数实参的那两个重载写的是
`new real(int){…}`，卡在匿名函数那一刀上。

### 尺子还是错的：plain 一条错都没有，不是干净，是没走到

上面那张 193 条的表按文件一分就露馅了：错全在 `graph.asy`（143）、`math.asy`（30）、
`graph_splinetype.asy`（12）、`graph_settings.asy`（2），**`plain*.asy` 一条都没有**。
而 `Label` 认不出 30 次 —— Label 就在 `plain_Label.asy` 里。两件事同时成立只有一个解释：
**plain 根本没被加载**。单独量 `import plain;` 证实了：它只报**一条**错，而那不是"干净"，
是模块加载在一个单元里撞到第一条错就停 —— 后面的东西根本没被看见。

这与"数第一个坎"是同一个陷阱的两次发作：把**没量到**读成了没问题。所以每次拿到一份
诊断计数，都要先问一句"这些文件真的都走到了吗"。

那一条错是 `plain_constants.asy:73` 的 `using suffix=void(file);` —— `file` 是 asy 的
C++ I/O 类型。它挡住的是**整个 plain 树**，也就是 Label / frame / filltype / align /
marker 那一大片的来源。补一个**类型桩**（`struct file { int fd; }`，只让类型存在，
不给任何 I/O —— 核心方言里还没有文件 IO；真去读写它的地方会明确报"没有方法"，
不会悄悄给错答案），plain 就往下走了三个文件，各自停在自己的第一条：

- `plain_strings.asy:260`：参数化模块（`from collections.map(K=string,V=string) access
  Map_K_V as Map_string_string;`）—— 模板模块，最大的一件。
- `plain_paths.asy:3`：`using interpolate=guide(... guide[]);` —— 函数类型里的**变长形参**。
- `plain_filldraw.asy:93`：`using fill2=void(frame f, path[] g, pen fillpen);` ——
  **struct 体里的 `using`**。这一条本身不难（`typeDec`/`aliasOne` 现成），但要做对得让别名
  **只在这个 struct 里可见**（直接塞进单元级的 `tyAlias` 就比 asy 多接受一门语言了）；
  而且同一个 struct 里紧接着还有 `fill2 fill2;`（类型名与字段名同名，asy 两个命名空间）
  与 `static int Fill=1;`（静态字段），以及一个我们还没有的 `frame` —— 三件事叠在一起。

所以 plain 这条路上剩的不是一行能解决的了。三个里 `frame` 与静态字段是内建面/前端各一小刀，
变长形参与模板模块各是一刀。

### 内建面补 frame：并且撞名这件事第一次真的发生了

`frame` 是 asy 绘图层的第二个容器：picture 是「还没定尺寸的」，frame 是「坐标已经是最终
坐标的」。所以内建面里它就是同一个 `drawop[]`，只是量 bbox 时缩放固定为 1。行为全是
`asy -noV` 量的：空 frame 的 min/max/size 都是 `(0,0)`、`empty` 是 true；
`_draw(f,(0,0)--(10,20),currentpen)` 之后 `min=(-0.25,-0.25)`、`max=(10.25,20.25)`、
`size=(10.5,20.5)`（描边按**笔宽的一半**外扩，与 picture 那边同一条）；frame **没有字段**，
`f.min` 那边报 `no matching variable 'f.min'`，取值是 `min(f)` 这种写法。

量到一条真 asy 的怪事：`erase(g)` 之后 `empty(g)` 是 true，而 `size(g)` **还是**擦之前的
`(10.5,20.5)` —— 它的 bbox 是缓存的，erase 没清缓存。那是实现细节（看着像 bug），
`cases/46-frame` 刻意不问这一格，注释里写了原因。

这一刀真正的收获不在 frame，而在**撞名**：内建面每加一个函数名，都可能盖住前端里
写死的那一族内建。`builtinOwns` 之前只有一行 `nm === 'length'`，注释里写着"别的内建
名字将来与模块撞上时要在这里补一行" —— `erase` 一加进去，`erase("abc",1,100)` 就从
"a" 变成了 `3`（`builtinRaw` 里写死的是 `lengthOf`，字符串那一族根本没接线）。
这不是报错，是**悄悄给了错答案**，正是那条注释担心的那种。于是把三个函数都按族改：
`builtinOwns` 按「名字 + 给了几个」认（`erase(frame)` 是 1 个、字符串那份是 3 个，
元数就分得开），`builtinCost` 逐个比 `params`，`builtinRaw` 分出一个 `strRaw`
（与 `strCall` 同一份拼法，只是实参已经降好，不再求第二次）。

`add(frame,frame)` 这一刀**没写**，理由也是量出来的：一加上去，`cases/42-fntype` 里
`fold3(add, 1, 2, 3)` 就报"把有 2 个重载的 'add' 当值用" —— 用户自己的 `add(int,int)`
与内建的 `add(frame,frame)` 成了同一个重载集，而"当值用的是哪一个"要靠**期望类型**定案，
这个前端还是自底向上定型的。真 asy 收，所以这是我们缺的一刀。它现在唯一的用处在
plain_filldraw，而那个文件还引不动 —— 所以先记下来，等「按期望类型挑重载」那一刀再加回去。

尺子这边：`import graph;` 还是 **187**，一条没少。但"认不出的类型"那一桶从 80 掉到 76
（`frame` 那 4 条没了，`transform` 那 5 条上一刀就没了），掉下来的份额被 `new`（15 -> 18）
与几处更靠后的错补平了 —— 这正是"每个单元停在自己的第一个错"那条规矩的第三种表现：
把类型补齐让单元往后走，走到的地方又是新的错。**总数不动不等于没进展，也不等于有进展**，
要看的是分桶。现在剩下的第一名是 `Label`（35 条），而 Label 要 TeX。

### 按期望类型挑重载：实参位置这一半

上一刀欠的账。asy 里函数名当值用时，"是哪一份"由**期望类型**定案（量过：两份 `both`，
`useI(both)` 给 7、`useR(both)` 给 12）。我们的前端是自底向上定型的 —— `callArgs` 先把
实参逐个求出来，再拿类型去挑候选 —— 所以一个裸名字轮不到问"这里想要什么类型"。

落法是**推迟**，不是回头重写定型方向：`callArgs` 遇到"裸名字 + 多个可见重载"时不求，
塞一个带 `over`（那一串候选）的占位；`fit` 在给这个槽打分时按 `cand.ps[at].type` 挑同型
的一份，挑不到这个候选就不合用；`applyCall` / `fnValCall` 把挑中的那份落成 `(fnref …)`。
一共四处，都在原来的打分路径上，没有第二遍求值。

只认**同型**，不给任何转换余量 —— 量过 asy 也是这样：没有一份同型时它报
`cannot call … with parameter '<overloaded>'` 加 `use of variable 'both' is ambiguous`。
`tests/asy/strict/overload-value-nofit` 钉这一条。

还差的一半是**变量的初值**（`real g(real,real) = both;`，真 asy 收）：那个位置期望类型明明
写在左边，但走的不是 fit 那条路。现在报的是 nope 而不是错答案，`tests/asy/bad/
overload-value-init` 钉着。

尺子不动（`import graph;` 还是 187）—— 这一刀补的是能力，不是 base 里某个卡住的类型。
它换回来的是内建面可以自由用 asy 的真名字了：`add(frame,frame)` 就是靠它加回去的。

### 匿名函数：18 个 `new` 一次全过，代价是明写一条"捕获不了"

`new int(int x){…}` 降成一个顶层的 `(cfn 名 (捕获) (形参) 返回类型 语句…)`，用的地方是
`(mkclo 名 捕获值…)` —— 这两个头 ADR-0010 早就有了，这一刀只是把 asy 的语法接上去。

捕获**边降边收**，不先扫 AST 找自由变量：作用域换成只有形参的一层，外层那几层留在
`this.cap.outer`，体里引用到外层局部量时 `nameOf` 落到 `capOf`，回 `(cap 名)` 并记一条；
头是体降完之后才拼的。名字解析的次序照 asy：闭包自己的局部 → 外层函数的局部 → 文件级。
文件级那一档**不进捕获表** —— 它是 `(var 符号)`，本来就是活读的，与 asy 一致。

这里有一条真差别，量出来的：**asy 的捕获是按引用的**。
`int k=1; int f()=new int(){return k;}; k=2; write(f());` 那边印 2；函数里
`int m=n; …=new int(){return m;}; m=99;` 那边印的是 99 那一份。而 `(mkclo …)` 是按值抓
一次（捕获是记录的字段）。所以这一刀在 `capOf` 里加了一道静态检查：捕获的名字在**外层
函数体里被赋值过**（`=`、`+=` 那一族、`++`/`--`，`assignsTo` 保守地认名字不认作用域）就
拒。收下来印的会是旧值，那是错答案而不是少一门语言。`tests/asy/bad/anon-capref` 钉着。

顺手补了一处形状不一致：`type -> name dims` 里 array-ty 的元素是**裸的** name，而
`new int[](…)` 那两条产生式里是 celltype（多包一层 `(name-ty …)`）。`type()` 现在两种都收，
不然 `new int[](int n){…}` 报的是"带点的类型名"。

尺子：**187 -> 189**，而 `new` 那一桶 **18 -> 0**，`import graph;` 里与匿名函数有关的诊断
一条不剩 —— graph.asy 那 18 处捕获的全是没被赋值过的局部量或文件级名字，一次全过。
总数反而涨了 2：那些单元往后走了，撞上的是自己下一个错（"内建函数" 23 -> 28、
"未声明的变量" 14 -> 20、picture 缺字段 12 -> 16）。这已经是同一条规矩的第四次出现，
所以**这条尺子从此只看分桶，不看总数**。

### 剩下的桶大半够不着：picture 是 base 的，不是内建面的

补完匿名函数之后重新分桶，`import graph;` 的 189 条里最大的几个是：认不出的类型 76
（`Label` 35、`interpolate` 12、`ticks` 10、`scaleT` 9、`bool3` 3、`autoscaleT` 3、
`arrowbar` 2、`scalefcn` 1、`align` 1）、缺的内建函数 28（`abort` 7、`format` 3、
`tridiagonal` 2、`times` 2，其余都是单条）、未声明的变量 20（`infinity` 5、`right` 3、
`left` 3、`realEpsilon` 2…）、`picture` 缺字段 16（全是 `scale`）加缺方法 4。

`picture` 那 20 条看着像"内建面再补一批字段"就能过，**不是**：`struct picture` 声明在
`plain_picture.asy:203`，它是 **base 的**，我们那份只是文件头标着「**垫的**」的临时替身。
往替身上长字段就是抄 base，那条线一开始就划掉了。同理 `Label` / `ticks` / `scaleT` /
`interpolate` / `autoscaleT` / `arrowbar` 全是 base 自己的 struct。

所以这条尺子已经到顶了：`import graph;` 再往下走要先让 **plain 装得进来**。而 plain 现在
正好剩三条（`import plain;` 一句下去就这三条诊断，不多不少）：

- `plain_paths.asy:3`：`using interpolate=guide(... guide[]);` —— 函数类型里的变长形参
- `plain_filldraw.asy:93`：struct 体里的 `using` + 静态字段 + `fill2 fill2;`（类型名与
  字段名同名，asy 两个命名空间）。**匿名函数这一刀补完之后**，这个 struct 里
  `new void(frame f, path[] g, pen fillpen){…}` 那几处已经不是障碍了
- `plain_strings.asy:260`：`from collections.map(K=string,V=string) access …` —— 模板模块

### 下一刀之前先量清：static 字段就是"名字挂在 struct 上的文件级变量"

`plain_filldraw.asy` 的 filltype 里有五个 `static int Fill=1;`，`three.asy` 的
`static interaction defaultinteraction;` 也是同一条 —— 后者是 46 个 examples 的门。
动手之前先把语义量准（`asy -noV`）：

```
struct Box {
  static int n = 1;
  int x = 5;
  static int bump() {n = n + 1; return n;}
  int get() {return x + n;}
}
write(Box.n);        // 1     —— 用**类型名**取
Box a; Box b;
a.n = 7;             //        —— 用**实例**写，写的是同一格
write(Box.n);        // 7
write(b.n);          // 7     —— 另一个实例看到的也是那一格
write(a.get());      // 12    —— 实例方法里裸名字就是它（5 + 7）
write(Box.bump());   // 8
write(Box.n);        // 8
```

所以 static 字段**不是字段**：它是一个文件级变量，只是名字挂在 struct 上。这与第二十八刀
的 `autounravel` 是同一个形状（"写在体里、其实是文件级的声明"），落法应该沿用 auMod 那条路：
一个 `(global asy__sf_Box_n …)`，初值在单元的 init 里跑，四条取值路径各接一处 ——
`Box.n`（类型名限定）、`a.n`（实例限定，同一格）、方法体里的裸 `n`、以及 `Box.bump()`
（静态方法，可以先不做：filltype 只要静态**字段**）。

量这一条时踩了一个坑，值得记：第一版测试用的 struct 叫 `S`，报的是
`type 'pair' is not a structure` —— 因为 base 的 plain_constants.asy 里 `S` 是**南**那个
方向常量（N/S/E/W）。拿 base 在场的环境量语义时，测试用的名字得先躲开 base 的名字空间，
不然量到的是名字碰撞而不是语义。

### static 字段落地：第一次"数字掉下来"是真的退步

按上一节量好的语义做完了三条取值路径（`Box.n` / `a.n` / 方法体里裸的 `n`）与对应的三条赋值
路径，加上初值在单元 init 里发一句 `(set …)`。落法就是上一节说的那个：一个
`asy__sf<i>_<记录名>_<字段名>` 的文件级全局，static 成员**不占成员槽**。
`tests/asy/cases/48-static.asy` 钉着，期望文件是直接从 `asy -noV` 出来的。

然后 `import graph;` 从 189 条掉到 **1** 条。这一次不是好消息：

```
math.asy:442:1: error: asy 前端第一刀还不支持：没有字段的 struct 'rootfinder_settings'
```

`struct rootfinder_settings` 里**全是** static 成员。static 不占成员槽之后它就成了零字段
struct，撞上那条早就写在 recordBody 里的边界，`math.asy` 于是停在了比原来早得多的地方 ——
后面 188 条根本没走到。这是这把尺子第五次误报，也是第一次**掉下来的数字对应真的退步**：
前四次是"数字没动、能力涨了"，这次是"数字大降、能力降了"。两个方向都印证同一件事，
总数这个读法没有信息量，只有分桶有。

零字段这条边界原本的理由是"核心方言的 class 至少要一个字段"。放开的办法有两个：改方言让
class 收空字段表，或者补一个看不见的占位字段。选了后者 —— 方言那边的空 class 会牵到五条
后端的布局，而占位字段只是前端多塞一个 `int`：

```js
if (fields.length === 0) {
  fields.push({ name: ASY_FILLER, type: 'int', def: null, mat: mat });
  mat++;
}
```

代价是这个字段的名字（`asy__filler`）在 asy 那边是合法标识符，所以得**把它藏起来**，
不然就是收得比 asy 多。三处各加一句：`recField` 里直接当没有、错误信息里的字段清单里滤掉、
`selfField` 里方法体的裸名字也不认。`tests/asy/strict/filler-field.asy` 钉着这一条
（真 asy 报 `no matching variable 'b.asy__filler'`，我们报"没有字段"，两边都拒）。

补上占位字段之后 `import graph;` 回到 **189**，桶也回到原样（76 类型 / 28 内建函数 / 4 隐式
缩放 / 3 无名形参 / 3 数组方法 / …）；`import plain;` 还是那**三**条挡路的，一条不多一条不少。

### struct 体里的 `using`：类型名与变量名是两个名字空间

plain 那三条挡路的第二条是 `plain_filldraw.asy:93`：

```asy
struct filltype
{
  using fill2=void(frame f, path[] g, pen fillpen);
  fill2 fill2;          // ← 字段与别名同名
  ...
}
```

先量了三条（`asy -noV`）：体里的 `using` 出了 struct 就没了（外面 `fn2 g;` 报
`no type of name 'fn2'`）；同名的字段与别名并存，`b.fn2` 取的是字段；可见性**严格按体里的
书写顺序** —— 写在字段后面的别名，那个字段看不见；写在方法后面的，那个方法**体里**也看不见。

所以别名不能进文件级那张 `tyAlias`，另开一张挂在记录上（`rec.tyAlias`），
`this.recAlias = {map, bi}` 是"正在降哪个 struct 的体、走到第几项"。裁法与 selfField 那条
同一把尺子，只是刻度不是成员槽而是**体里的项序号** —— `using`、`static`、`autounravel`
都不占成员槽，共用 `mat` 会让 `using` 与紧跟着的字段撞在同一个刻度上。

两个坑，都是"开关开得不够早"：

* `type()` 里查别名的前置条件写的是 `this.tyAlias.has(nm)`，struct 体里的别名从不进那张表，
  于是分支根本不进。抽出 `aliasKnown()`（两张表都问）才通。
* `method()` 第二遍降正文时 `this.formals(...)` 在设 `recAlias` **之前**就调了 ——
  `pt shift(pt d)` 的形参因此报"类型 'pt'"。开关要挪到 formals 前面。

还有一条是诊断的成色：写在后面的别名 asy 自己也拒，所以要报 aliasLate 那条 err，
不能报"这一刀还不支持"那条 nope（strict 的纪律：拒的理由不能带 `ASY_NOPE`）。但降到那个
字段时别名还没登记，认不出"确实有这个名字、只是写在后面"。所以进体之前先扫一遍拿到
**所有别名的名字**（`aliasNames`，只要名字不解析类型），`aliasKnown` 连这张也问。
`tests/asy/strict/recusing-order.asy` 钉着。

这一刀之后 `plain_filldraw.asy:93` 的诊断换成了**函数类型的字段**：

```
struct filltype 的 void(frame,path[],pen) 字段
```

方言那边明确拒着（`(class Holder (f (fnty (int) int)))` 报"字段只能是 int / real / bool /
string、(vec T N)、(arr T) 或另一个结构体/类"），所以下一刀在方言与后端那一侧，不在前端。
`import graph;` 还是 189，桶没动。

### 函数类型的字段：三条腿本来就通，只差 LLVM 一行

上一节留下的坎在方言那边。先只把 `(class Holder (f (fnty (int) int)) (n int))` 那条禁令放开，
拿一份手写的 `.sx` 逐腿量：

```
run       42
run-llvm  llvm 后端目前不支持结构体字段的类型 fn：Holder.f
run-c     42
interp    42
```

三条腿一个字没改就通了 —— 因为函数值在 MIR 那一层就是一个句柄，`fldset`/`fld` 搬的是它，
C 后端与两个解释器都不看字段的"种类"。LLVM 那条腿要显式列出字段的 LLVM 类型，所以补两句：
`fieldTy` 里 `t.k === 'fn'` 出 `ptr`（与"内嵌的类"同一条：引用语义，存句柄），
`fieldZero` 出 `null`。

前端这边三处：

* 字段类型的白名单加上 `asyIsFn(ft)`。没写默认值**不发** `fldset` —— `(cnew …)` 已经把每一格
  铺成零值了，所以"函数值变量说不出零值字面量"那条限制在字段上不构成障碍（那条还留着，
  钉在 `real[](real[],real[]) g;` 上）。
* `fnValCall` 原来把被调者写死成 `(var nm)`，多收一个 `callee` 参数：裸名字传 `(var nm)`，
  字段传 `(fld … f)`。
* `methodCall` 里"方法找不到"那一支，同名字段是函数值时不再报"调用一个字段"，转 `fnValCall`。
  顺序是量出来的：方法与字段同名时方法赢。

`tests/asy/cases/50-fnfield.asy` 钉着（含"struct 当实参传进去改字段"那条，验的是引用语义），
`tests/sexpr/cases/15-fnvalues.sx` 加了字段那一段（含 `fnref` 存进字段、两个名字指同一格）。

`import plain;` 从三条挡路的降到**两**条：

* `plain_paths.asy:3` —— `using interpolate=guide(... guide[]);`，函数类型里的可变形参
* `plain_strings.asy:260` —— `from collections.map(K=string,V=string) access …`，参数化模块

`plain_filldraw.asy` 整份过了。`import graph;` 还是 189（它卡在 math.asy，与 plain 这条线无关）。

### 可变形参：普通函数上的那一半，以及顺手补的两条产生式

`... T[] xs`。语法那一层先补了两条：`arglist "," ELLIPSIS argument` 与
`formals "," ELLIPSIS formal` —— 原来只有不带逗号的那一种，而 `f(9, ... a)` 与
`f(int k, ... int[] x)` 真 asy 都收（量过，两种拼法结果一样）。

语义按量出来的四条落：

* 没给就是**空数组**（`total()` 印 0）。所以可变那一格永远算"给了"，不进 `missing`。
* 散着写的与展开的能**拼**（`total(9, ... a)` 是 18）。
* `... a` 是**拷**进去的：回调里改 `x[0]` 之后 `a[0]` 没变。于是不用为"只有一个展开"开
  免拷特例 —— 一律现造一条新数组，散的 `apush` 一次，展开的发一条 while 循环逐个搬
  （核心方言没有"接一条数组"的指令）。
* 重载上，**任何非可变的候选都赢**：`f(real)` 与 `f(... int[])` 撞上 `f(3)` 走前者，尽管那边
  还要一次 int->real 提升。所以贵不贵不能塞进 cost（那样会与提升的分数打架），
  另开一档 `varargs` 在 applyCall 里先比。

落法上刻意没有改 `formals()` 的返回形状：可变那一格就是 `ps` 的最后一项，多一个
`rest: true`。体里它**本来就是**一个 `T[]` 局部量，7 个调用点一个字不用改，只有 `fit` 与
`applyCall` 多看一眼。

一条比 asy **严**的边界，单独记下来：`f(... a, 9)`（展开后面还有位置实参）asy 印
"unnamed argument after rest argument" 之后**退 0** —— 真正的语法错才退 1，也就是它把这句
吞了。吞掉的语义没法照抄，所以我们直接拒。因此这一条**进不了 strict**（那条轴的判据是
"真 asy 也退非 0"）：先写了一个 strict 用例，跑出来"真 asy 居然收了"，删掉改成代码注释。

`tests/asy/cases/51-varargs.asy` 钉着上面每一条，期望文件与 `asy -noV` 逐字节一致。
`import graph;` 189 -> **187**（"关键字形参或可变形参"那 3 条没了，净减 2）。

`import plain;` 还是**两**条，因为剩下那条可变是在**函数类型**里：
`plain_paths.asy:3` 的 `using interpolate=guide(... guide[]);`。把它接上只买到一行 ——
下一行就是 `tensionSpecifier operator tension(...)`，`guide` 与 `tensionSpecifier` 都是 asy 的
C++ 内建类型，都不在我们的内建面上。所以 plain_paths 真正的墙是**内建面缺 guide**
（连着 joinExp 那一族：`..` / `controls…and…` / `tension` / `::` / `{dir}` 现在全是 nope），
不是函数类型里的那一格。这一条改了下一刀的顺序。

### 拆 lower.js：先搬"不带 this"的那两摊，5407 -> 4808

标准是「feature 多的语言，`lower.js` 至多是一个薄入口」。那个文件长到 5407 行，
其中 `class AsyLower` 一个人占 4450 行 —— 类体是大头，但**类体不是先该动的地方**。

先量了两条：仓里有没有 prototype mixin（`Object.assign(X.prototype, …)`）—— **一个都没有**；
`extends` 出现在哪 —— 只有 `extends Error` / `extends Map` 那种空体的琐碎子类。
也就是说"把一个类拆到几个文件里"这件事在自举那条路上**没有先例**，
而这个文件正好在自举路径上（`tests/bootstrap` 要用它自己编译自己）。
所以第一刀只搬**模块级**的那两摊，它们一行都不碰 `this`：

- `frontend-asy/types.js`（202 行）：类型在这一层就是字符串，这个文件是那些字符串的全部规矩 ——
  `asyIsArr`/`asyElem`/`asyMangle`/`asyIsFn`/`asyFnSplit`/`asyCore`、`ASY_PAIR_TY`/`ASY_TRIPLE_TY`、
  `asyConvCost`、算符名表、`ASY_NOPE`，以及读 `builtins.tab` 的 `parseAsyBuiltins`。
- `frontend-asy/runtime.js`（430 行）：零值表、pair/字符串内建的名字表，以及降级时按需拉进来的
  核心方言 helper 源码（`HELPERS`，300 多行）。这一摊单独成文件的理由最硬：
  helper 只有一份源码、**六条腿共用**，改一处等于改六条腿。

名字一个都没改。封闭 ABI 的那条纪律是"模块级名字全仓唯一"，改名等于换 ABI；
`ASY_NOPE` 与 `parseAsyBuiltins` 原先从 `lower.js` 导出，现在改成从 `types.js` 导出，
三个引用处（`cli.js`、`tests/asy/run.js`、`tests/repl/incremental.js`）跟着改了 import 路径 ——
**没有**用 `export { X } from './types.js'` 那种转出写法：那条在自举的模块加载器上没验过，
而三行 import 是验过的。

搬完逐行对了一遍：老文件里每一行都还在这三个文件之一，唯一的差别是 28 行多了个 `export ` 前缀。
`node tests/asy/run.js` 107/107、`node tests/bootstrap/run.js` 60/60 —— 后者是必须跑的，
因为新文件与跨文件 import 要能被它自己编译。

类体那 4450 行是下一刀：不靠 extends、不靠 mixin，而是把成组的方法改成
`函数(L, …)` 的普通函数（`L` 就是那个降级器），调用处写 `asyAssign(this, …)`。
普通函数调用在封闭子集里是保证能降级的，这也是唯一不引入新语言特性的拆法。

### 第二刀：调用与重载解析那一族搬走，4808 -> 4028

`frontend-asy/calls.js`（804 行）：`args` / `call` / `callArgs` / `visible` / `fit` / `applyCall` /
`sigText` / `methodCall` / `ctorCall` / `userCall` / `fnValCall` / `opUser` / `opBuiltinSig` /
`joinExp` / `builtinOwns` / `builtinCost` / `builtinRaw` / `strRaw` / `mathCall` / `defWrapper` ——
一个调用怎么落地，全在这一摊里。原来在类里是连着的 780 行，所以搬的是**一整段连续文本**，
注释与它管的那段代码没有被拆开。

拆法就是上一节说的那个：`fnValCall(n, nm, ft, callee)` 变成
`export function asyFnValCall(L, n, nm, ft, callee)`，体里的 `this.` 全换成 `L.`，
调用处 `this.applyCall(n, …)` 变成 `asyApplyCall(this, n, …)`。
名字全加了 `asy` 前缀 —— `args`/`call`/`fit`/`visible` 这几个放到模块级太容易撞，
而封闭 ABI 的纪律是模块级名字全仓唯一。

搬之前先量了三件事，每一件都能让这种机械改写出错：
- **有没有别的接收者**：`grep` 这 20 个名字，`this.` 之外的接收者是 **0** 个 ——
  没有 `Function.prototype.call` 这种同名陷阱，也没有 `AsySession` 从外面调它们。
- **有没有跨行的模板字面量**：写了个小状态机扫这 780 行，**0 个** ——
  所以整段退两格是安全的。有的话退格会改到方言文本里的空白。
- **有没有裸的 `this`**：有 7 处，全是方言文本里的 `(var this)` / `(let this …)` / `(this T)`，
  那是 **asy 的 `this`**，跟 JS 的没关系。所以换的是 `this.`（带点）而不是 `\bthis\b` ——
  后者会把 `(var this)` 改成 `(var L)`，那是能过语法检查、能过大部分测试、
  但会在方法调用上错的一类改动。

行为没动的证据不止测试：`import graph;` 还是 **187** 条诊断、`import plain;` 还是 **2** 条，
与搬之前一个数都不差。`tests/asy` 107/107，`tests/bootstrap` 60/60。

### 第三刀：语句那一族，4028 -> 3357

`frontend-asy/stmts.js`（702 行）：`write`（`writeStmt`/`fmtStr`/`writeArrays` —— 它在 asy 里是
语句不是表达式）、分派（`stmt`/`stmtOne`/`body`）、三种循环（`doWhile`/`forEach`/`forStmt`/
`forPart`/`loopCond`）、变量声明（`vardec`）、表达式语句（`exprStmt`），以及赋值那一整套
（`assign`/`assignFld`/`assignIndex`/`assignStat`）。同样是类里连续的 680 行。

这一刀多了一件上一刀没有的事：块里已经有**上一刀留下的**调用点（`asyArgs(this, …)`），
所以"把第一个实参从 `this` 换成 `L`"这一步要连着 calls.js 那 20 个名字一起做，
不能只做本刀新搬的 17 个。漏了就是 `asyOpUser(this, …)` 出现在一个没有 `this` 的函数里 ——
在 JS 里那是 `undefined`，而且**不报错**，只会在运行时表现成"用户算符全都不匹配"。

依赖是单向的：stmts.js 用 calls.js 的四个（`asyArgs`/`asyCall`/`asyOpUser`/`asyOpBuiltinSig`），
反过来 calls.js 一个语句函数都不调（`grep L.stmt(`/`L.body(` 是 0）—— 所以没有环。

跑之前踩过一次坑：`tests/asy/run.js` 在设了 `ASYMPTOTE_DIR` 的 shell 里跑，`bad/import`
会失败 —— 那条用例要的就是"找不到 graph 模块"。是环境不是回归，换个干净的 shell 就过。

### 第四刀：表达式那一族，3357 -> 2322。这一刀撞上"加载器禁止环"

`frontend-asy/exprs.js`（1070 行）是类里连续的 1043 行：分派与名字解析、匿名函数与捕获、
隐式转换、下标与切片、点后面那一层，pair/triple/字符串/数组的内建面，以及算符那一整段
（`binary`/`compare`/`cond`/`logic`/`unary`/`cast`）。

前三刀的依赖都是单向的，这一刀不是：`expr` 要调 `asyCall`（函数调用就是表达式），
而 calls.js 又到处调 `expr`/`coerce`。第一反应是"ESM 支持循环 import"—— 在 node 上确实支持，
函数声明会提升，调用时机又都在模块初始化之后。但**自举那条路不支持**：
`frontend-js/link.js:221` 就是一句 `import cycle through '…'`，`module/load.js` 的文件头也写着
「禁止环：报出整条环路径，而不是给一个半初始化的模块」。也就是说这个环在 node 上跑得过，
在 `tests/bootstrap` 上一定挂 —— 而这个文件正在自举路径上。

所以反向那几条边不走 import，走 lower.js 上留的**一层薄转接方法**：

```js
  expr(n) { return asyExpr(this, n); }
  coerce(v, want, node, what) { return asyCoerce(this, v, want, node, what); }
```

十七个，每个一行，全是转出去。判定"哪些要转接"不是猜的：`grep 'L\.名字('` 数 calls.js 与
stmts.js 里实际调了哪些，就是这十七个。于是依赖变成一条链
`exprs -> stmts -> calls -> types/runtime`，lower.js 在最上面 import 全部四摊 —— 是个 DAG。

代价写在明处：跨家族的调用多一层函数跳转，而且 lower.js 上多了十七个方法 ——
它不是纯粹的"薄入口"，是"薄入口 + 一张转接表"。换来的是**加载器不用改**：
放开环要动 link.js 与 load.js 的拓扑排序，那是编译器骨架，不该为了排版去动。

`tests/asy` 107/107、`tests/bootstrap` 60/60，`import graph;` 187 条、`import plain;` 2 条。

lower.js 现在剩下的是"要看符号表的那一半"：单元与 include、作用域与类型名（含 typedef
与 struct 体里的 using）、记录声明与构造、模块加载与合并，以及入口那几只。

### 第五刀：模块与顶层声明，2322 -> 1380。lower.js 到此成了入口 + 转接表

两个文件一次落地：`modules.js`（230 行，import / access / unravel / from-access）与
`decls.js`（785 行，修饰剥离、static 字段、`operator init`/`operator cast`、形参表与函数类型、
签名与方法、文件级变量、函数体，以及"声明遍 + 正文遍"那个骨架）。

这两族之间**互相**调，量出来是三对一：modules 只往 decls 要一个（`declPass` ——
加载一个模块要先给它跑一遍声明遍），decls 往 modules 要三个（`modLoad`/`modMerge`/`modStmt`）。
所以把少的那一条改成转接（`declPass(u) { return asyDeclPass(this, u); }`），
多的那三条走 import：`decls -> modules`。加上上一刀那条链，整张图是

```
lower.js（入口 + 27 个转接方法）
  └─> decls -> modules -> calls
      └─> exprs -> stmts -> calls -> runtime -> types
```

一条 DAG，没有环。转接方法一共 27 个（表达式 17 + 这一刀 10），全是一行。

到这里 lower.js 的 1380 行里有 240 行是文件头那篇"边界与差别"的说明、
27 行转接、剩下的是单元与 include、作用域与类型名、记录声明与构造，以及
`chunk`/`run`/`initFn`/`lowerAsy`/`AsySession` 那几只入口。原来的 5407 行现在是七个文件：

- `lower.js` 1380 —— 入口、单元、作用域、类型名、记录
- `exprs.js` 1070 —— 表达式
- `decls.js` 785 —— 顶层声明
- `calls.js` 804 —— 调用与重载解析
- `stmts.js` 702 —— 语句
- `runtime.js` 430 —— 零值表、内建名字表、helper 源码
- `modules.js` 230 —— 模块
- `types.js` 202 —— 类型字符串

五刀下来每一刀都是 `tests/asy` 107/107 + `tests/bootstrap` 60/60，
且 `import graph;` 一直是 187 条、`import plain;` 一直是 2 条 —— 一个数都没动过。

### 可变形参的另一半：函数类型里那一格（plain 的墙 2 -> 1）

`plain_paths.asy:3` 的 `using interpolate=guide(... guide[]);` —— 可变形参在**函数类型**里。
拼法定成"把 `... ` 留在形参的类型文本里"（`int(... int[])`），理由是这一层所有类型都是字符串，
这样类型相等还是一次 `===`：可变的只等于可变的。这一条不是我编的，是量的 ——
`using afn=int(int[]); afn g = total;` 那边报 `cannot cast 'int(... int[] xs)' to 'int(int[])'`
并退 1，所以它进 `strict/varargs-fnty-cast`（真 asy 也拒）。

核心方言那边**一个字没加**：`(fnty …)` 里那一格就降成一条普通的数组形参 —— 因为普通函数上的
可变形参本来就是"在调用处打成一条数组"（第三十三刀），两边一致。通过这种函数值调也通了，
四种形状与真 asy 逐字节相同（`f()` 是 0、`f(1,2,3)` 是 6、`f(9, ... a)` 是 18、
前面带固定格且元素做 int->real 提升的 `g(1, 2, 3.5)` 是 6.5）。

**顺手抓到一个真 bug**：函数值的类型文本原来有**两份**拼法 —— `asyCandFnType` 一份，
`asyNameOf` 里手抄了一份。加上 `... ` 之后抄的那份落后了，于是 `vfn f = total;` 报
"要 int(... int[])，这里是 int(int[])"。改成只有一份（`asyNameOf` 调 `asyCandFnType`）。
那句"与 nameOf 里那份拼法必须一致"的注释本来就在，注释挡不住抄第二遍。

数字要读对：`import plain;` 从 2 条降到 **1** 条（只剩 `plain_strings.asy:260` 的参数化模块），
但这**不等于** plain_paths 通了 —— 单独 `import plain_paths;` 还有 39 条
（`operator tension` / `operator controls` 的算符重载、重定义 `write` …）。
plain.asy 是 `include plain_strings;` 在 `include plain_paths;` **之前**，include 是拼进同一个
单元的，那个单元在 260 行就断了，所以 plain_paths 那 39 条现在根本走不到。
`import graph;` 还是 **187** —— 一点没动，也应该没动：graph 那 187 条里 35 个 `Label`、
12 个 `interpolate`、10 个 `ticks`、9 个 `scaleT` 全是 plain 没加载完的下游。

### 隐式缩放 `3cm`：量完发现它就是一条乘法

asy 的 `105cm` 语法上是 `(-> (LIT exp) (scale $1 $2))` 一条独立产生式，看着像要一套单位/量纲
的规则。量了一圈（`asy -noV`）发现**没有**任何自己的规则，它就是 `operator *(105, cm)`：

- `real cm=2.5; write(3cm)` -> `7.5`；`int k=4; write(3k)` -> `12`（int 乘 int 还是 int）
- `write(2.5cm)` -> `6.25`（左边那个字面量自己可以是 real）
- `pair p=(1,2); write(2p)` -> `(2,4)`（复数乘）；`triple t=(1,2,3); write(2t)` -> `(2,4,6)`（逐分量）
- `write(2(1,2))` -> `(2,4)`；`write(2f(3))` -> `8`；`write(2arr[1])` -> `4`（右边是括号/调用/下标都行）
- `write(-3cm)` -> `-7.5`（前缀负号在外面）；`write(3cm*2)` -> `15`（缩放比 `*` 紧）
- `string s="ab"; write(2s)` 报的是 **"no matching function 'operator *(int, string)'"**
- 自己写的 `A operator *(int, A)` 之后 `(3a).v` -> `21` —— 用户定义的算符也走同一张候选表

所以这一刀不新立规则：把 `asyBinary` 的**尾巴**（用户算符 → pair/triple → 提升 → `(bin …)`）
拆成 `asyArith(L, n, op, a, b)`，`asyScale` 降两边然后原样交给 `asyArith(…, '*', …)`。
`exprs.js` 里那句 `if (h === 'scale') return L.nope(…)` 换成 `asyScale(L, n)`，就这两处。

`tests/asy/bad/scale.asy` 跟着**删掉**：它钉的是「还没做」这件事，现在做了；剩下的
`105cm` 里 `cm` 要 plain 才有，那是"未声明的变量"那一桶（不带 `ASY_NOPE`），不值得单独钉。
新增 `tests/asy/cases/53-scale.asy`，上面那十一行全在里面，`.expected` 是 `asy -noV` 的
输出**逐字节**拷过来的。

`import graph;` **187 -> 186**：4 条 `隐式缩放` 的 nope 全没了，但其中 3 个单元往下走了一步
就撞上下一堵墙（`graph.asy:2251` `polargraph`、`graph_settings.asy:8` 未声明的 `mm`、
`graph_splinetype.asy:67` `tridiagonal`），只有 `math.asy` 是真的过了。净 -1，不是 -4 ——
这一桶本来就只有 4 个点，而且跟 graph 那 186 条的大头一样，是 plain 没加载完的下游。
`import plain;` 还是 **1** 条（模板模块，`plain_strings.asy:260`），没动，也不该动。

跑的轴：`tests/asy`（109 passed，28.7s）、`tests/bootstrap`（60 passed，77s）。
`tests/sexpr` 与 `tests/run.js` 没跑 —— 这一刀只碰 `frontend-asy/exprs.js`，方言和后端没动。

### 模板模块：`typedef import(K, V)` 与 `from m(K=…, V=…) access …`

这是 plain 的那堵墙。语法早就收下了（`(receive-typedef …)` 与 `(from-access 模块 名字表 实参表)`
那第三格），缺的是语义。先量语义（`asy -noV`，模板体里印一行、再数一个文件级计数器）：

- `from m(T=int) access …` 写两遍，模块体只跑 **一遍**；`T=string` 那一份体**再跑一遍**。
  缓存键是「模块 + 实参元组」，不是模块名。
- 两个 `T=int` 的 access 拿到的是**同一个**实例：`hits_int()` 是 2（两次调用都记在同一个
  `calls` 上），而 `hits_str()` 是 1。文件级变量是**每个实例一块**存储。
- 两个实例里的 `Box_T` 是**两个类型**（`Box_int` 与 `Box_str` 不能互相赋值）。
- 裸 `import` 一个模板模块，asy 报 "templated module access requires template parameters"。
- 顺带量到的两条：`from m access A as B;`（给 struct 改名）与 `… myint as mi;`（给 typedef
  改名）asy **都收** —— 原来这两条都被我们 nope 掉了。

落法（类型在这一层就是字符串，所以「替换类型参数」不用替换语法树）：

- **实参就是一条 typedef**。`asyModLoadAs` 在 declPass 之前把 `T -> int` 塞进那个单元的
  `tyAlias`，位置 `-1`（比第 0 项还早，于是全文件可见）。模块体里的 `T` 从此走的是
  已有的别名那条路，一行特殊逻辑都不用。
- **缓存键带实参**：`mod_tbox(T=int)`。unitNew 的 key 换成它，`byKey` 与 `loading`（禁止
  循环 import 那张表）都跟着用它，于是「同一份实参只跑一遍、不同实参是另一个实例」白捡。
- **实例里的 struct 名按 pfx 打散**。原来 `records` 那张全局表的键就是 struct 名，两个模块
  同名就 nope（记录名要全局唯一：class 名、`asy__m_<记录>_<方法>`、`asy__ctor_<记录>` 都按它拼）。
  模板实例非得例外不可，于是把两件事分开：`recVis` 的键是「**这里**叫什么」，`rec.name` 是
  「那个类型**是什么**」（实例里是 `asy__m3_Box_T`）。改了三处：`type()` 回 `rec.name` 而不是
  查表用的那个键；`recordDec` 用 `tname` 登记全局表；新方法 `recOf(nm)`（源码里的名字 -> 记录），
  `A(…)` 那条构造调用问它而不是 `isRec`。
- **改名于是白捡**：`recVis`/`tyAlias` 那两条「改名不收」的 nope 删掉了 —— 名字与类型分开之后
  它们没有理由拒。
- **带点的模块路径**：`collections.map` 走的是 `name` 规则（`(qualified (name collections) map)`），
  不是裸原子，所以加了 `asyModPath`；文件是 `collections/map.asy`，那一步在 cli.js 的 loader 里
  （先按原样找一遍，再把点换成斜杠）。

新增 `tests/asy/cases/54-template-mod.asy` + `mod_tbox.asy`（两次实例化、同一份实参再来一次、
struct/方法/文件级变量各一份，`.expected` 是 `asy -noV` 逐字节拷的）与
`tests/asy/strict/template-plain-import.asy`（裸 import 模板模块 —— asy 也拒，不带 `ASY_NOPE`）。

**墙动了，但没倒**：`import plain;` 还是 **1** 条，位置从 `plain_strings.asy:260`（那句实例化）
挪到了 `collections/map.asy:26` —— `V operator [] (K key);`，一条**语法**上还没有的产生式。
把 iter 与 genericpair 单独实例化量了一遍，挡住它们的也不再是模板这件事，而是三个各自独立的
坑：无体的方法声明（`int hash();` / `T get();`）、`unravel` 当语句、内建 `alias`。
`import graph;` 还是 **186** —— 一点没动，也应该没动（它的大头在 plain 后面）。

跑的轴：`tests/asy`（111 passed，29.7s）、`tests/bootstrap`（60 passed）。
`tests/sexpr` 与 `tests/run.js` 没跑 —— 这一刀碰的是 `frontend-asy/`（modules/lower/calls）
与 cli.js 的模块查找，方言、OIR、后端都没动。

### 无体的方法声明 `int size();` —— 量完发现它是一个函数类型的字段

`collections/iter.asy:5` 的 `T get();`、`genericpair.asy:24` 的 `int hash();`、
`map.asy:21` 的 `int size();`：看着像 C++ 的纯虚函数，量出来不是。`asy -noV`：

- `struct S { int size(); }` 之后 `s.size == null` 是 **true** —— 它是一格**存储**；
- `s.size = new int() { return 21; };` 之后 `s.size()` 给 21；
- struct 里别的方法写 `size()`，读的就是这一格（`int twice() { return 2*size(); }` 给 42）；
- `S t;` 另造一个，`t.size` 又是 null —— 每个对象一格，不是 static。

所以它就是「函数类型的字段、初值 null」，而函数类型的字段第三十刀就通了
（`typedef int F(); struct S { F f; }` 这条路两边都是 5）。语法上它是 vardec 里的
`(fundecidstart 名字 形参表)`（`decidstart` 的第三、四条产生式），所以改的是两处：

- `recordBody` 的字段那一段：`fundecidstart` 时把字段类型换成 `fnTypeOf(返回类型, 形参表)`。
  连带把「字段类型合不合法」那一问从循环**外**挪到循环**里** —— 一条 vardec 里
  `int f(); int x;` 两个 decid 的类型现在不一样了，外面那个 `ft` 只是"返回类型"，
  拿它去判合法性会把 `void advance();` 这种（`void` 不在 SCALARS 里）误拒。
- `asyCall` 里方法体的裸名字那一档后面加一条：`selfField(nm)` 是函数类型时走
  `asyFnValCall(…, '(fld (var this) nm)')`。位置在文件级候选**前面** —— 它也是个成员，
  与「方法遮住同名的文件级函数」同一条规矩。

新增 `tests/asy/cases/55-method-decl.asy`（`int size()` / `void grow(int)` /
`Box make(int)` / `int sum(int[])` 四种拼法、两个对象各一格、方法体里的裸调用，
`.expected` 逐字节拷 `asy -noV`）。

**这一刀不动 plain 的数**（还是 1）：plain 停在 `collections/map.asy:26` 的
`V operator [] (K key);` —— 那是**语法**上还没有的产生式，比这一刀早。
单独实例化 `collections.iter` 量到的是墙确实往后挪了：原来 3 条（两条无体声明 + `unravel`），
现在 5 条**别的**（`autounravel` 的 vardec、闭包捕获会被改的外层变量、for-each 走自定义
Iterable、`unravel` 当语句、`Iterable_T` 当函数值）。`import graph;` 还是 186。

跑的轴：`tests/asy`（112 passed，30.1s）、`tests/bootstrap`（60 passed）。
`tests/sexpr` 与 `tests/run.js` 没跑 —— 只碰 `frontend-asy/`（lower 的字段那一段、calls 的
一档），方言与后端没动。

### `operator []` 与 `operator [=]`：语法一行、语义一条转接、边界三条

`collections/map.asy:26/29` 的 `V operator [] (K key);` / `void operator [=] (K key, V value);`
是 plain 剩下那一条里最外面的一层，而它先是个**词法**问题：`operator` 一族靠
`(fuse ID "operator" …)` 接住，那张表里没有 `[]` 与 `[=]`（camp.l 的 opname 表里有）。
补上两项（`[=]` 排在 `[]` 前面 —— 更长的先试），`operator []` 就成了一个普通 ID。

语义量出来也不新鲜：`v[i]` 就是 `v.operator [](i)`、`v[i] = x` 就是
`v.operator [=](i, x)`，量过 `v.operator [](2)` 直呼也通。所以：

- `asyMethodSig` 放这两个名字过（原来除了 `operator init` 一概 nope）；
- 符号名里的空格与方括号方言读不出来（量到 `unexpected character "["`），
  所以 `operator []` / `operator [=]` 的符号后缀换成 `idx` / `idxset`；
- 新函数 `asyIdxOpCall(L, n, recv, mname, argNodes)`：把"实参"手攒成 applyCall 要的形状，
  重载解析、隐式转换、默认实参全跟着白捡。读侧接在 `asyIndex` 的数组那一问**前面**，
  写侧接在 `asyAssignIndex` 里。

asy 自己的三条边界也量了，而且都得抄下来 —— 不抄就是"比 asy 多接受一门语言"：

- 一个 struct 里只能有**一个** `operator []`（"multiple operator[] definitions in one struct"）；
- 只能有**一个** `operator [=]`（"multiple operator[=] definitions in one struct"）；
- `operator [=]` 必须配 `operator []`（"operator[=] defined without operator[]"）。

前两条在 `asyMethodSig` 里问（登记之前看那张候选表已经有没有），第三条要走完整个 struct 体
才看得出来，所以在 `recordBody` 的末尾。三条都进 strict：`strict/op-index-dup`、
`strict/op-index-set-only`。这一条是量出来才知道的 —— 第一版测试里我写了两个
`operator []` 的重载，跑 `asy -noV` 才发现 asy 拒。

新增 `tests/asy/cases/56-operator-index.asy`（int 下标、string 下标、`v.operator [](2)` 直呼、
struct 里别的方法用 `this[0]`）。复合赋值（`v[i] += 1`）与 `++`/`--` 还是 nope ——
那要先读再写，两个算符各自还能重载，摊法与数组那边不一样。

**墙又往后挪了一步，还是 1 条**：`collections/map.asy` 整个过了（26/29 两句都收下），
plain 现在停在 `collections/iter.asy:42` 的 `autounravel` 一个 vardec。
`import graph;` 还是 186。

跑的轴：`tests/asy`（115 passed，30.5s）、`tests/bootstrap`（60 passed）。
`tests/sexpr` 与 `tests/run.js` 没跑 —— 改的是 asy 的词法表与 `frontend-asy/`，
核心方言的语法、OIR、后端都没动。

### 无名形参：补一个**按位置定死**的名字

`graph.asy:271` 的 `pair zero(real) {return 0;}`、`math.asy:211` 的
`sequence(new real(int) {return 0;}, n)`：形参只有类型没有名字（语法上是
`(formal explicit 类型)`，三格；带名字那两条是四格五格）。这个槽在体里没法提，
所以降级时补个名字就完了。

要紧的是名字**按位置定死**（`asy__anon${i}`）而不是用递增计数器：形参表在声明遍与
正文遍各求一次，两遍拼出来的名字必须一样，用 `L.tmp++` 就会错开一格。

新增 `tests/asy/cases/57-anon-formal.asy`（文件级函数、匿名函数、混在有名形参中间、
函数类型形参里的无名形参）。`import graph;` **186 -> 185**；`import plain;` 还是 1。

### 数组的 `.delete` 与 `.insert`：三条新 helper，graph 的数一动不动

`math.asy:145/158` 的 `.delete(0)`、`:187` 的 `.insert(i,x)`。量出来的四条
（`asy -noV`，`int[] a={1,2,3,4,5}`）：

- `a.delete(1)` -> `{1,3,4,5}`（就地左移再缩长）；
- `b.delete(0, 1)` 在 `{1,2,3}` 上 -> `{3}` —— 是**闭区间**，不是半开；
- `c.delete()` 清空（`c.length` 变 0）；
- `s.insert(1, 'q', 'r')` 在 `{x,y}` 上 -> `{x,q,r,y}` —— insert 是**可变实参**的，
  等于连着在 i、i+1、… 处各插一格。

落在 `asyArrHelpers` 那个工厂里（`del` / `clear` / `ins` 三条），于是标量、pair、
**记录元素**、**数组元素**四种都白捡（记录与数组那两种是 `arrHelper` 现生的）。
三条都回 void，所以照原样当表达式发出去、语句层套 `(expr …)`；只有多值 insert 要摊语句
（接收者与下标各只能求一次，先绑临时量）。范围超尾我们截到尾，asy 那边是运行时错 ——
与"扩长填零值"是同一类差别。

新增 `tests/asy/cases/58-arr-del-ins.asy`。

**`import graph;` 一动不动，还是 185** —— 而且这次差得明白：那 3 条 nope 全没了，
紧跟着冒出 3 条别的（`math.asy:147` 的 `real[] > real[]`、`:160` 的 `null` 字面量）。
净 0。`import plain;` 还是 1。

跑的轴：`tests/asy`（117 passed，31.3s）、`tests/bootstrap`（60 passed）。

### `null`：方言里补一个 `(null TYPE)`，asy 那边补一个「类型从目标来」的记号

上一刀量完 graph 时冒出来的那条 —— `math.asy:160` 的 `null` 字面量。先量清六条腿上
到底缺什么：**什么都不缺**。OIR 的 `NullRef` / `NullFn` 本来就是类与函数的零值
（`hir/types.js` 的 `zeroValue`），多维数组那一刀还在 `(anew (arr (arr T)) N)` 的格子
零值上用过它；MIR 是 `K.nul`，JS 是 `null`、C 是 `NULL`、LLVM 是 `null`、两个解释器
也都是 `null`。缺的只有**方言里写不出来**这一件事。（上一轮的会话报告把这句说反了，
写成"要一路通到后端"，那是错的 —— 更正在此。）

于是方言侧就一条产生式：`(null TYPE)`，TYPE 只收引用类型。函数类型上发的是 `NullFn`
而不是 `NullRef`，为的是跟 `zeroValue` 出**同一个**节点 —— 同一个语义两种节点，
六条腿里迟早有一条漏。数组**没有**这条对应，`zeroValue((arr T))` 是长度 0 的空数组
（`alen`/`apush` 在任何数组上都得能答），所以 `(null (arr T))` 是一个只能显式写出来的值，
不是谁的零值。这条不对称在 `cases/16-null.sx` 里量了出来：`(cnew Box)` 之后
`b.l == (null Leaf)` 与 `b.f == (null (fnty (int) int))` 都是 true，`b.a == (null (arr int))`
是 **false**。

asy 侧的形状是：**`null` 自己没有类型**，类型从目标来。量过的四条：
`int x = null;` 报 "cannot cast 'null' to 'int'"；`write(null)` 报
"call of function 'write(null)' is ambiguous"；`null == null` 同样 ambiguous；
而 `A a = null; a == null; null == a; return null; isnil(null)` 全都通。
所以走的是与花括号初值 `{1,2,3}` 同一条路子：`asyLit` 出一个 `code` 为空的**记号**
（`ASY_NULL`），落地在三个知道目标类型的地方 —— `asyCoerce`（声明初值、赋值、
return、实参）、`asyPromote`（`x == null` 的类型从另一边来）、`fit`（重载解析里
那一格按槽的类型算同型）。记号的 `code` 故意留空：漏出去就是一处硬错，不会变成一个错答案。

三处漏点是量出来的，各补了一条：`null == null`（记号相等但定不下类型 —— 那条判断要写在
`asyPromote` 的"两边同型"**之前**）、`write(null)`、以及顺手撞出来的一个**旧洞**：
`a + a` 在 struct 上原先一路落到 `(bin "+" …)`，在 JS 后端崩成 `js.bin: + on class` ——
一处内部错，不是诊断。asy 那边它是 "no matching function 'operator +(A, A)'"，
所以补成普通错误；数组上的 `+` 是另一回事（asy 那边**逐元素**，量过 `{1,2}+{3,4}` 给
4 6），那条是 nope。

数组的 `null` 只收**声明**不收比较：`int[] r = null;` asy 通，但 `r == null` 是运行期
错误 "dereference of null array" —— 因为 asy 的 `operator ==(int[],int[])` 是逐元素的。
这一条写进了 `cases/59-null.asy` 的注释里，测试本体只声明、不比较。

新增 `tests/sexpr/cases/16-null.sx`（五方一致）、`tests/sexpr/bad/null-scalar.sx`、
`bad/null-struct.sx`（struct 是值语义，没有空引用 —— 那条线正好把 struct 与 class 分开）、
`tests/asy/cases/59-null.asy`，以及四条 strict：`null-int`、`null-both`、`null-write`、
`rec-add`。

`import graph;` **185 -> 184**，差得明白：两条 `字面量 'null'` 全没了
（`math.asy:160`、`graph_splinetype.asy:253`），紧跟着在 `graph_splinetype.asy:261`
冒出一条别的（路径连接 `..`）。`import plain;` 还是 1，墙还在 `collections/iter.asy:42`
的 `autounravel` vardec 上，没动。

跑的轴：这一刀动了**核心方言**，所以轴比前六刀多两条 —— `tests/sexpr`（51 passed，10.0s）、
`tests/run.js`（91 passed，10.2s）、`tests/asy`（122 passed，32.4s）、
`tests/bootstrap`（60 passed）。前六刀只动 `frontend-asy/`，跳掉 sexpr 与 run.js 是对的。

### `autounravel` 的变量：与 `static` 只差一条，`bad/au-var` 那面墙拆掉

`import plain;` 的那一条卡在 `collections/iter.asy:42`。量出来的语义很省事
（`asy -noV`，struct 名故意不叫 `S`，见下）：

```
struct Box { static int a = 1; autounravel int b = 2; int id = 0; }
Box.a  -> 1     Box.b -> 2     b -> 2
Box q; q.a -> 1   q.b -> 2
Box.b = 5; b -> 5     b = 6; Box.b -> 6
```

也就是说 `autounravel T n = …` 与 `static T n = …` 是**同一格**，只差"那个名字在 struct
之后的文件级也裸着可见"。所以实现就是 `asyStaticDec` 多一个 `au` 形参：登记照旧
（`rec.statics` + `L.gdecls`），`au` 为真时再把**同一个** `g` 挂进 `L.globals`，`at` 用
struct 的位置 —— 于是"写在 struct 前面看不见"这条规则白捡（量过 asy 报
"no matching variable 'k'"，我们报"声明在后面"）。初值那半边只改了一个过滤条件：
`asyStaticInit` 原先只收 `asyStMod`，现在 `static` 与 `autounravel` 都收。

`bad/au-var` 提上来变成 `cases/60-autounravel-var.asy` 的最后一段（变量与函数的
autounravel 混在同一个 struct 里），`bad/` 里那两个文件删掉 —— 与 `bad/scale` 那次同一个
做法。新的 case 覆盖三条访问路径（类型名限定 / 裸名字 / 实例限定是同一格）、
四种类型（string/real/数组/记录）、零初始化，以及方法体里的读写。

**一处自我更正**：量的过程里我先用 `struct S`，看到 `S.a` 被 asy 拒（"no matching
variable 'S.a'"），一度以为**我们比 asy 收得多**、`statQual` 那条路是错的，正要去删。
换成 `Box` 再量就通了 —— `S` 是 base 的 `plain_constants.asy` 里的**南**那个方向常量，
`S.a` 解析到的是那个 pair 变量。48-static.asy 的注释里正写着这个坑，这次真踩了一次。
没有旧洞，`statQual` 是对的。

`import plain;` 还是 1，但墙在**同一行内**往前挪了：`iter.asy:42` 现在报的是
"带维度或形参表的 autounravel 字段名" —— 那一行是
`autounravel Iterable_T operator cast(T[] items) = Iterable_T;`，形状是"声明一个函数类型的
名字、用一个重载集当初值"，也就是 `bad/overload-value-init` 钉着的那条。`import graph;`
还是 184（graph 不走 collections/）。

跑的轴：`tests/asy`（122 passed，40.8s）、`tests/bootstrap`（60 passed）。这一刀只动
`frontend-asy/`（decls.js、lower.js），没碰核心方言，所以 `tests/sexpr` 与 `tests/run.js`
跳掉。

### 重载集当值用：把「期望类型定案」从实参位置铺到别的位置

`bad/overload-value-init` 的注释里早写着差什么：「实参位置上这一条已经通了，差的是**声明**
这个位置 —— 那条路上期望类型是有的（`real g(real,real)` 就写在左边），但走的不是 fit 那一段」。
量过 asy 收（那个文件原样跑印 10）。

做法与 `null` 那一刀是**同一条**：`asyNameOf` 在多重载时不再报 nope，而是回一个
**不定案的记号**（`{code: null, type: '<nm 的重载集>', over: 候选}`，形状与 `asyOverArg`
给实参用的那个一模一样），由 `asyCoerce` 拿目标类型落成 `(fnref …)`。于是初值、赋值、
return 三个位置一起通了 —— 它们本来都走 coerce。带默认值的候选照旧一律不算
（函数值没有默认值，与 overArg 里同一条）；筛完只剩一份就直接定案。

挑不出同型的一份是**错**不是 nope（asy 报 "cannot cast expression to
'string(string, string)'"，量过），诊断里把候选的类型列出来。`write(both)` 这种
**没有**目标类型的位置也是错（asy 报 "no matching function 'write(<overloaded>)'" 加
"use of variable 'both' is ambiguous"）—— 那处漏点与 `write(null)` 是同一个，
补在同一个地方。

`bad/overload-value-init` 提上来变成 `cases/61-overload-value.asy`（初值、typedef 拼的
类型、return 位置、实参位置，以及"挑出来的那一份就是那一份"），新增两条 strict：
`overload-value-write`、`overload-value-init-nofit`（后者与既有的 `overload-value-nofit`
是一对 —— 那条是实参位置，这条是声明位置）。

**`import graph;` 与 `import plain;` 都一动不动（184 与 1）**，而且这次的理由是清楚的：
plain 的墙在 `iter.asy:42`，那一行是
`autounravel Iterable_T operator cast(T[] items) = Iterable_T;` —— 卡住的**不是**初值
那一半（这一刀刚补的就是它），而是左边：那是一个**函数类型的文件级变量**，而
`(global …)` 这一档现在只收 int/real/bool/string/pair/triple、记录与它们的一维数组
（量过我们自己报的两条：「没有初值的函数值变量」与「函数里改文件级变量」）。
下一刀该是那个。

跑的轴：`tests/asy`（124 passed，40.6s）、`tests/bootstrap`（60 passed）。只动
`frontend-asy/`（exprs.js、stmts.js），所以 sexpr 与 run.js 跳掉。

### 没有初值的函数值变量：那条 nope 的理由已经不成立了

`graph_splinetype.asy:5` 的 `real[](real[],real[]) g;`。这一条原先拦着，理由写在代码里：
「那个空函数值的字面量方言里还没有」。第三十三刀补上 `(null TYPE)` 之后这句话就不成立了，
所以这一刀只有**一行**：零值发 `(null <核心类型>)`。

量过 asy 的四条：`F f;` 之后 `f == null` 是 true、`f != null` 是 false；赋一个闭包之后
反过来；赋一个普通函数名一样；`f = null` 能把它清回去。新增
`cases/62-fnvalue-null.asy`（局部、文件级、一句里混着有初值与没初值的两项、
struct 字段当对照）。

`import graph;` **184 -> 183**，而且这次是**净减一条**：diff 只有那一行没了，没有新的冒出来。
`import plain;` 还是 1（墙在 `iter.asy:42`，与这条无关）。

顺带把边界记清楚：这一条通的是**局部**与**文件级落在入口里**的那种。真正的
**模块级函数值变量**（函数体里也看得见的那种）还在门外 —— `asyGlobalNames` 那一遍只按
节点形状认标量/聚合，`fundecidstart` 与 typedef 别名两种形状都落成 `ok:false`，
于是它退化成入口里的一个 `(let …)`。`iter.asy:42` 要的正是那个（而且名字还是
`operator cast`），所以那一刀比这一刀大。

跑的轴：`tests/asy`（125 passed，45.7s）、`tests/bootstrap`（60 passed）。只动
`frontend-asy/stmts.js`，sexpr 与 run.js 跳掉。

### 模块级的函数值变量：三处小改，一处**量出来的回退**

上一刀把边界写清楚了：函数体里也看得见的那种函数值变量还在门外。这一刀补它。
`graph.asy` 里 `ticklabel`、`axis` 这一族全是这个形状。

三处改动：

1. `asyGlobalNames`（唯一在函数体之前跑的那一遍）原先只按节点形状认标量与聚合，
   两种函数值写法都落成 `ok:false`。现在都定出类型：`fundecidstart` 走
   `L.fnTypeOf`，typedef 别名走 `L.aliasAt`（它不报诊断 —— 这一遍只收表）。
2. 调用路径上补一档：裸名字调用时，局部与成员之后、候选表之前，问一下"文件级有没有
   一个同名的函数值变量"。位置照 `nameOf` 那一档的顺序。
3. `asyCond`（`? :`）的临时量零值：函数类型原先落到 `ZERO.get(t)` 上，那是
   `undefined` —— 直接拼进方言文本。改成 `(null …)`；记录也顺手从 `(cnew T)` 换成
   `(null …)`（那行注释写的"方言里写不出 null"在第三十三刀之后就不成立了，
   换过来还省掉一次白分配）。

**回退是量出来的**：第 2 条第一版没有排除"正在声明的那个变量"，于是
`ticklabel LogFormat=LogFormat(10);`（graph.asy:267/268 与 :1124 的
`axis Bottom=Bottom()`）右边那个名字被当成了刚声明的这个变量的**间接调用**，
报"要 string(real)，这里是 string"—— `import graph;` 从 183 **涨到 186**。
asy 的规则是那个变量在自己的初值里还不可见，所以判据加了一条 `gv !== L.gvarAt(nm)`。
加上之后 graph 回到 183，与这一刀之前 diff 为空。

新增 `cases/63-fnvalue-global.asy`：两种写法、函数里赋值另一个函数里读、
以及"初值里那个名字是函数不是这个变量"那一段（就是上面那条回退的形状）。

**`import graph;` 与 `import plain;` 都是净 0（183 与 1）**。这一刀是把一条能力补齐，
不是拆墙 —— graph 里那些 fn 类型的全局本来就在别的墙后面。plain 的墙还在
`iter.asy:42`：那一行是 `autounravel` 的**函数类型字段**（名字还是 `operator cast`），
`asyStaticDec` 现在只认 `decidstart`。

跑的轴：`tests/asy`（126 passed，69.0s）、`tests/bootstrap`（60 passed）。只动
`frontend-asy/`（decls.js、calls.js、exprs.js），sexpr 与 run.js 跳掉。

### 函数值的 static / autounravel 字段：`import plain;` 那面墙倒了

`iter.asy:42` 那一行 —— `autounravel Iterable_T operator cast(T[] items) = Iterable_T;`
—— 是一个**函数值的 autounravel 字段**。上一刀补了文件级那一档，这一刀补 struct 里那一档，
两档共用同一个 `fnTypeOf`。

三处小改：`asyStaticDec` 认 `fundecidstart`（并把类型白名单里加上函数类型）；
调用路径上补两档 —— `Box.sf(3)` 走 `statQual`（位置在 dotQual 与模块别名之后），
`q.af(5)` 走 `asyMethodCall` 里字段之后的 static 那一档。量过 asy 三条访问路径都收，
而且是**同一格**（`Box.af = thrice` 之后裸的 `af` 与 `q.af` 都变）。

新增 `cases/64-fnvalue-static.asy`。

**`import plain;` 的那面墙倒了**：不再是 1 条，而是 **4 条** —— 数字涨了，但那是墙倒之后
后面的东西露出来了，不是回退。分两个桶：

- 3 条同一个根：`iter.asy:14/30/48` 都报 `'asy__m6_Pair_K_V' 在这里还不是一个类型`。
  那是**模板实例化的顺序**问题：`Pair_K_V` 作为模板实参传进 iter 时，别名坐进了表里，
  但那个 struct 的声明排在后面。
- 1 条是 `map.asy:104` 的 `keyword` 形参（早就在待办里）。

`import graph;` 还是 183（graph 不走 collections/）。

跑的轴：`tests/asy`（127 passed，38.0s）、`tests/bootstrap`（60 passed）。只动
`frontend-asy/`（decls.js、calls.js），sexpr 与 run.js 跳掉。

### 数组元素那条路：一行守卫写错在两头，`import plain;` 4 -> 1

上一刀墙倒之后新冒出来的三条诊断，根在同一行 —— `lower.js` 的 `type()` 里 `array-ty`
那一支自己解元素名，然后拿解出来的**类型文本**去问顺序解析：

```js
if (this.isRec(eel) && !this.recHere(eel)) return this.recLate(node, eel);
```

`recHere` 查的是 `recVis`（**这个单元里叫什么** -> {rec, at}），而 `eel` 已经被别名换成了
**那个类型是什么**（模板实例里是打散过的真名 `asy__m6_Pair_K_V`）。那个名字压根不是
`recVis` 的键，`e === undefined` 于是被当成"声明在后面"。`collections/iter.asy:14/30/48`
三条报的都是 `T[]`，而那个 `T` 是另一个模板的实例（`map.asy:3` 先实例化 `genericpair` 拿到
`Pair_K_V`，`map.asy:5` 再把它当实参传给 `iter`）。

改法不是加守卫，是让这一支走与下面 `name-ty` **同一条**路：别名 -> `recVis`（先按 `recHere`
裁，再换成 `rec.name`）-> 全局表（`recElsewhere`）。这么一改同时补上了另一头 —— 量出来的：

- `from mod_tbox(T=int) access Box_T as Box_int; Box_int[] a;` asy 是收的，而我们报
  "数组元素这一刀只有 int/real/…" 那条 nope。因为元素名没换成 `rec.name`，
  `records` 那张全局表里查不着 `Box_int`。

顺手量到的一个**反向漏洞**（差点被我这一刀放大）：只加守卫的那个版本会让
`access mod_m; A[] a;` 通过 —— asy 报 "no type of name 'A'"。走全套三段之后它落在
`recElsewhere`，理由也对了。`strict/access-arr-elem` 与 `strict/struct-fwd-array`
两条钉着这两头。

`import plain;` 4 -> **1**：只剩 `map.asy:104` 的 `keyword` 形参。`import graph;` 还是 183
（graph 不走 collections/）。

跑的轴：`tests/asy`（130 passed，38.2s）、`tests/bootstrap`（60 passed）。只动
`frontend-asy/lower.js` 一处，sexpr 与 run.js 跳掉。

### `keyword` 形参：语法早就读得进，缺的是「这一格只能按名字给」

`map.asy:104` 的 `void operator init(V keyword nullValue, bool keyword isNullValue(V) = null)`
是 `import plain;` 的最后一条。文法里那两条产生式（`formal-kw`）**一直都在**，
`asyFormals` 只是把它一律 nope 掉了；缺的是语义。量出来的四条：

- `void f(int keyword a); f(3);` -> `cannot call 'void f(int keyword a)' with parameter 'int'`
  （**退 1**）—— 这一格只能按名字给；
- 默认值与乱序给名照旧：`void q(int x, int keyword a = 7, int keyword b = 9)`，
  `q(1)` / `q(1, b=2)` / `q(1, b=2, a=3)` 是 17 / 10 / 6；
- **不进签名身份**（与 `explicit` 同一条）：先 `void p(int keyword a)` 再 `void p(int a)`
  是**替换** —— 之后 `p(a=5)` 与 `p(5)` 都印后者；
- `keyword` 的槽是**尾巴上一整段**：普通形参排在它后面那边报
  "normal parameter after keyword-only parameter"。

于是三处小改：`asyFormals` 里验一句 `keyword`（词法里它不是保留字）、把那个词抠掉之后
形状与普通形参一模一样、带一个 `kw` 标记出去；`asyFit` 里位置实参落到 `kw` 的槽上就
不合用；`asySigText` 里印成 `int keyword`（诊断得说清为什么不收）。

**两条比 asy 严的**，都量过：`int foo a`（那边 "expected 'keyword' here"）与
"普通形参排在 keyword 后面"，asy 报完之后**退 0**（把整句吞了）。吞掉的语义没法照抄，
所以我们直接拒 —— 也因此这两条进不了 strict（那条轴的判据是"真 asy 也退非 0"），
与 `f(... a, 9)` 那一条同一个处置。进 strict 的只有退 1 的那条：`strict/kw-positional`。

还留在门外的：**函数类型里**的 `keyword`（`typedef void F(int keyword a);` asy 是收的）。
类型文本 `void(int)` 不带形参名，按名字给就无从落地，得等类型表示这一层动。map.asy 不需要它。

`import plain;` 还是 **1** 条 —— 但不是同一条了：`keyword` 那条没了，露出来的是
`map.asy:115` 的 `map.size = new int() { return size; };`（struct 体里的表达式语句）。
这是墙往里挪了一格，不是没动。`import graph;` 还是 183。

跑的轴：`tests/asy`（132 passed，48.8s）、`tests/bootstrap`（60 passed）。只动
`frontend-asy/`（decls.js、calls.js），tests/sexpr 与 tests/run.js 跳掉 —— 核心方言与
后端这一刀没碰。

### 字段默认值看得见前面的成员：那个局部量改名叫 `this`

顺着 struct 体往里走时量到的一个**旧洞**：`struct S { int x = 1; int y = x + 1; }`
asy 印 2，我们报"未声明的变量 'x'"。隐式构造那份 `asy__new_T` 是自己攒出来的一串
`fldset`，攒的时候 `L.self` 是关着的，于是字段默认值里的裸字段名无处可查。

量出来的四条，正好就是方法体里那套 `self` 规矩：

- `int x = 1; int y = x + 1;` -> 2（**前面**的字段看得见）；
- 反序 `int y = x + 1; int x = 1;` -> `no matching variable 'x'`（退 1）；
- `int y = f(); int f() {…}` 同样 `no matching variable 'f'`（退 1）；
- 方法写在前面 `int f() {…} int y = f();` -> 7。

也就是 `selfField` 的 `f.mat < self.mat` 与 `visibleMethods` 的 `c.mat <= self.mat`
两条现成的裁法。所以落地只有一处：把 `recNew` 里那个局部量从 `o` **改名叫 `this`**，
再按这一格的成员号把 `L.self` 开着 —— 裸字段名于是走的就是方法体里那条老路
（`(fld (var this) f)`），一条新代码路径都没多。

顺带修的是**理由**：`int y = f();` 那条以前会漏到内建名单那一层，报出带 `ASY_NOPE` 的
"内建函数 'f'" —— 把"程序本来就不对"说成"我们还没做"。现在方法体那一档后面多问一句
"这个名字是不是这个 struct 里声明在后面的成员"，报 err。两条都进了 strict
（`field-def-later`、`field-def-later-method`，真 asy 也退 1）。

`import plain;` 还是 1（`map.asy:115`），`import graph;` 还是 183 —— 这一刀是补洞，
不是推墙。下一格才是 struct 体里的**语句**（量过：每个实例构造时按体内顺序跑一遍，
能裸读写字段 —— 与字段默认值同一串，所以这一刀的 `this` 是它的地基）。

跑的轴：`tests/asy`（135 passed，46.9s）、`tests/bootstrap`（60 passed）。只动
`frontend-asy/`（lower.js、calls.js），tests/sexpr 与 tests/run.js 跳掉。

### struct 体里的语句：`collections/` 整族过了，墙退到 plain 自己家里

asy 的 struct 体其实就是一个 **block**。量出来的四条：

- `struct S { int x = 1; write('body'); int y = x + 1; x = 5; }` -> `body` / `x` 是 5 /
  `y` 是 2，造第二个实例又印一遍 `body` —— 也就是**每个实例**按体内顺序跑一遍；
- 与字段默认值是**同一串**（`x = 5` 排在 `int y = x + 1` 前面，所以 y 是 2 不是 6）；
- 能裸读写前面的成员（字段与方法都算）；
- 后面的成员看不见：`struct S { write(x); int x = 4; }` 报 `no matching variable 'x'`（退 1）。

上一刀的 `this` 就是为这个铺的，所以这一刀只有三处：`recordBody` 把认不出成员的那一项
记进 `rec.stmts`（带成员号），`recNew` 按成员号把它们与字段默认值**交错**发，
外加一个 `recStmt` —— 正文直接过 `asyStmt(L, node, 'void')`，语句那一层一行没动。

`import plain;` **1 -> 7**：这是墙倒了，不是回退。`map.asy:115` 那条没了，
`collections/`（iter / genericpair / map）整族过完，露出来的 7 条全在 plain 自己的文件里：

- 2 条 `plain_scaling.asy:9/166` static 的**方法**；
- `plain_bounds.asy:92` `transformedBounds[]`（元素是 struct 的**函数字段**那一族）与
  `:657` 的 `var` 类型；
- `plain_picture.asy:95` `void()[]`（函数类型的数组）与 `:203` 重复定义的 `picture`；
- `plain.asy:67` 返回类型自己是函数类型。

`import graph;` 还是 183（graph 的 183 条在更前面就挡住了）。

跑的轴：`tests/asy`（137 passed，45.5s）、`tests/bootstrap`（60 passed）。只动
`frontend-asy/lower.js`，tests/sexpr 与 tests/run.js 跳掉。

### 函数值的数组：方言里缺的只有一句 `(arr (fnty …))`

这一刀在**方言**里，不在前端。`plain_picture.asy:95` 的 `boundRoutine[] bound;`
（`boundRoutine` 是 `void(…)` 的 typedef）是 plain 里躲不开的一族。

表示上它与**类元素**是同一档：格子里躺一个句柄（C 侧 `omni_fn` 就是一个指针，步长 8），
所以走 `arrIsBlob` 那条按字节的路，零值是空引用（`NullFn`）。四处改动：

- `sexpr/lower.js` 的 `ty`：`(arr 元素)` 认 `(fnty …)`；
- `hir/types.js` 的 `arrIsBlob`：加 `fn`；
- `backend-llvm` 的 `arrRep` 与字段 new 那两处 8 字节判断（另外三条腿一行没动 ——
  JS 与两个解释器本来就是类型擦除的，run-c 走 `cArrOps`/`arrIsBlob` 那条通用路）。

前端这边两处：`arrElemOk` 收函数类型，以及 `fs[0](5)` —— 被调的是**下标出来的那一格**。
后者只认 `subscript` 这一种形状：求值有副作用（诊断、前置语句），所以不去"先试着求一遍
看看是不是函数类型"。

量出来的一条**差别**（写在 `cases/69-fn-array.asy` 里，不假装它不存在）：
`F[] fs2 = new F[1]; fs2[0] == null` 在 asy 那边是**运行期**错误
（"read uninitialized value from array at index 0"），我们铺的是零值（空引用）所以是
`true`。与 `int[] r = null; r == null` 那条（`59-null.asy` 记着的）同一族 ——
`new T[n]` 在 asy 那边铺的是"没初始化"，这一层的差别还在门外。

`import plain;` 7 -> **6**，`import graph;` 183 -> **182**。

跑的轴：`tests/sexpr`（52 passed，15.6s）、`tests/run.js`（91 passed，16.1s）、
`tests/asy`（138 passed，52.9s）、`tests/bootstrap`（60 passed）——
这一刀动了方言与 LLVM 后端，所以四条轴一条都不能跳。

### `static` 的方法：没有接收者的那一种成员

`plain_scaling.asy:9` 的 `static coord build(real, real)` 与 `:166` 的
`static scaling build(real, real)` 是 plain 里最后两条 static 相关的墙。

量出来的五条：

- `C.make(3)`（类型名限定）、struct 的方法体里裸写 `make(…)`、**实例上** `a.make(7)`
  也通（接收者算白搭）—— 三种调用形态；
- static 的体里能调另一个 static、能读 static 字段；
- 实例字段与实例方法在 static 的体里**用不了**：asy 报 "static use of dynamic variable"
  并退 1（两条都进了 strict）。

落地就是"名字挂在 struct 上、**没有 `this` 形参**的普通函数"：符号
`asy__sm_<记录>_<名字>`，候选表还是那张 `记录名.方法名`（重载解析、默认实参、命名实参
全跟着白捡），`applyCall` 里"丢掉接收者"只有一句 —— `d.stat !== true` 才 push `recv.code`。
方法体那边 `L.self` 多带一个 `stat` 标记，`selfField` 与 `visibleMethods` 各按它裁一刀。

诊断上多问了一句（`selfInstMember` / `selfStatBad`）：不问的话"实例字段"会漏成那句泛泛的
"未声明的变量"，"实例方法"更糟 —— 会漏成上一刀那条"声明在后面"，而它明明写在前面。
拒的理由不能说错，所以这一句排在那两条**前面**。

`import plain;` 6 -> **4**（剩 `plain_bounds.asy:92` 的嵌套 static struct、`:657` 的 `var`、
`plain_picture.asy:203` 重复定义的 `picture`、`plain.asy:67` 返回函数类型）。
`import graph;` 还是 182。

跑的轴：`tests/asy`（141 passed，55.8s）、`tests/bootstrap`（60 passed）。只动
`frontend-asy/`（lower.js、decls.js、calls.js、exprs.js），tests/sexpr 与 tests/run.js
跳掉 —— 方言与后端这一刀没碰。

### 遮住外面来的那个类型名：记录的**真名**撞上就打散

`plain_picture.asy:203` 那句"重复定义的 struct 'picture'"，查下来根本不是 `include`
把项摊了两遍 —— 源码里 `struct picture` 只有一处。撞的是**我们自己的 prelude**：
`picture` 在真 asy 那边是 `base/plain_picture.asy` 里的 struct（不是 C++ 内建面），而
`stage0/lib/asy/asy_builtins.asy` 里有一份替补，好让不写 `import plain;` 的画图程序能跑。
两份同名，于是 `import plain;` 撞在第二十五刀那条"struct 名是全局共享的"上。

量过的三条（真 asy 全收、全退 0）：

- 用户文件里 `struct picture { int x=7; } picture p=new picture; write(p.x)` -> `7`；
- **C++ 内建面**那些名字也遮得住：`struct frame { int x=1; }` -> `1`；
- 两个模块里都有 `struct Dup`，两条 import 都写上时，这个名字指的是**后**一条那份 -> `5`。

所以拒是错的，改成打散：`recUniq(nm)` —— 名字没被占就还用原名（**不带 import 的程序
降出来的文本因此一字不变**），占了就按单元前缀走，前缀也撞（主文件的前缀是空串）
再加一格计数。靠的还是第三十一刀那条分家：`recVis` 的键是「在这里叫什么」，`rec.name`
是「那个类型是什么」；模板实例一直靠它活着，遮蔽跟着白捡。第二十五刀那条
"两个模块里都有 struct" 的诊断因此整条删掉，`bad/mod-dup` 升成 `cases/72-mod-dup`。

打散之后露出**两个**藏在那条诊断后面的洞：

- `asyGlobalNames`（收表那一遍）拿源码里那个名字**直接当类型文本**（`records.has(base)
  ? base : null`）。真名一变，模块级变量的类型就落在**被遮住的**那份上 ——
  量出来的样子是 `struct picture 没有字段 'x'`。改成走 `recVis`（`asyDeclTyName`，
  不报诊断、不查顺序 —— 顺序留给 vardec 那一遍）。
- `asyModMerge` 是"有了就不覆盖"，于是两条 import 里这个名字指的是**前**一条那份，
  与 asy 相反。改成 `had.at <= at` 才覆盖 —— 与 funcs/globals 那两张表同一条"后来的
  盖住先来的"。
- 覆盖这条规矩配上 REPL 就多要一句：`asyBuiltinsIn` 每一批都并一遍 prelude，第二批起
  那次并会用 prelude 的 `picture` 盖掉上一批里遮住它的那个 struct。已经并过就不再并
  （`u.bi !== null` 就回）—— 名字都还在这个单元的表里。量过：`struct picture { int x=7; }`
  与 `write(p.x + y)` 分两批喂进 `repl --lang asy`，印 7 再印 9。

门外的一条（写进 `cases/71-shadow-prelude.asy` 的注释里，不拿测试盖住）：**遮之前**
用那个名字。`picture q=currentpicture;` 写在 `struct picture` 之前，asy 指的是旧那份
（印 7），我们报 "'picture' 在这里还不是一个类型" —— `recVis` 一个名字只存一份，
遮住之后前面几行也跟着看新的。要收得对，得让每个名字存一串按位置排的类型。

`import plain;` 4 -> **4**：数没动，但墙往前挪了一格 —— `plain_picture.asy:203`
换成了 `:221` 的 `node3[]`，而那是**struct 体里的嵌套 struct 声明**（`:210`
`struct node3 {…}` 在 `struct picture` 里），跟 `plain_bounds.asy:88/92` 的
`transformedBounds` 是同一个洞。`import graph;` 还是 182。

跑的轴：`tests/asy`（142 passed，50.6s）、`tests/run.js`（asy 的 REPL 会话在那一轴）、
`tests/bootstrap`。只动 `frontend-asy/`（lower.js、decls.js、modules.js），tests/sexpr
跳掉 —— 方言与后端没碰。

### struct 体里的 struct：只在这个体里可见的类型名

上一刀之后 `import plain;` 剩的两块砖是同一个洞：`plain_bounds.asy:88` 的
`private static struct transformedBounds`、`plain_picture.asy:210` 的 `struct node3` ——
**struct 体里再声明一个 struct**。第三十六刀那条"体里的语句"把它们悄悄收进了 `rec.stmts`，
所以直到有人拿那个名字当类型（`transformedBounds[]` / `node3[]`）才炸。

量过的四条（真 asy）：

- 体里当字段、当**数组元素**、方法里 `new Inner` 全通；
- 体外裸写 `Inner` -> "no type of name 'Inner'"；
- `private` 的写 `Outer.Inner` -> "accessing private field outside of structure"；
- 不 private 的写 `new Outer.Inner` -> "allocation of struct 'Inner' is not in a valid
  scope"（后三条都退 1 —— 体外那一族仍然全拒，第一条进了 `strict/`）。

落地只有一句话：**当一条普通的记录声明降**（真名走上一刀的 `recUniq`，撞了就打散），
只是那个名字不留在单元的 `recVis` 里，而是进**外层那张体内别名表**（`rec.tyAlias`，
与 `using` 同一张、同一条"按体里项号排"的规矩）。`recVis` 那一份是 `recordDec` 塞的
（嵌套的体里要认自己的名字），所以是先让它塞、回来再撤成原来那份。

顺着这条路又拽出三件必须一起做的事，每一件都是量出来的：

- **发的顺序**。方言要求字段的类先声明，而记录是按插入顺序发的 —— 外层先进表、嵌套的
  后进，于是 `(class Outer (a Inner))` 排在 `(class Inner …)` 前面。Map 没有"重排"，
  把外层删掉再塞一遍就到末尾了。
- **字段默认值里的体内别名**。`Inner a = new Inner;` 那个 `new Inner` 走 `type()`，而
  `type()` 认体内别名要靠 `recAlias` —— 生成构造函数那一串（`recNew`）以前没摆它。
  摆上之后要按位置裁，所以字段与体里的语句都多记一个 `bi`（体里的项号）。
- **外层体里先起的名字，在嵌套的体里也认**。`plain_picture.asy:207` 那条
  `using drawerBound3=…` 紧接着就被 `struct node3` 当字段类型（`:211`）。做法是把外层
  此处可见的那几条抄进嵌套那份表、位置记 -1，于是方法体那条路（按 `cand.abi` 摆
  `recAlias`）跟着白捡。

诊断也跟着改了一句：名字在全局记录表里、但它是某个 struct 体里声明的，那句话要说
"'Inner' 是 struct Outer 体里声明的类型，体外看不见"，不能再说"另一个模块里的 struct"。

`import plain;` 4 -> **3**（`plain_picture.asy` 整个文件过了，剩 `plain_bounds.asy:111`
struct 体里的算符重载、`:657` 的 `var`、`plain.asy:67` 返回函数类型）。`import graph;`
还是 182。

跑的轴：`tests/asy`（144 passed，47.4s）、`tests/run.js`、`tests/bootstrap`。
只动 `frontend-asy/lower.js`，tests/sexpr 跳掉 —— 方言与后端没碰。

### struct 体里的算符重载：一张候选表加一条"只在这个体里"

`plain_bounds.asy:111` 的 `private static pathpen operator *(transform, pathpen)`。
量过（真 asy）四条：

- 体里认（`2 * a` 走到它），**体外不认** —— "no matching function 'operator *(int, V)'"
  并退 1（进了 `strict/struct-op-outside`）；
- `static` 与不带 `static` 的都认；
- 不带 static 的那份体里**读得着实例字段**（印 16）—— 那是绑住了接收者；
- 体里 `this + 6` 也通（算符的形参吃的是 `this`）。

落地：候选**按算符那个名字**存（不是 `记录名.方法名`），于是一元/二元算符那条解析路
一字不改；函数本身照 `static` 的方法那样降 —— 没有接收者，符号
`asy__so_<记录>_<算符>`。可见性另加一条：候选带 `inRec`，`asyVisible` 里要求
`L.self` 正是那个 struct、并且 `c.mat <= L.self.mat`（与 `visibleMethods` 同一条成员序）。

不带 static 那一份只做到"体里不碰实例成员"为止：碰了就是 `ASY_NOPE`
（`bad/struct-op-inst-field`），因为要收得对得给它造一个绑接收者的闭包 —— 与"把方法当值
取出来"是同一件事。诊断走 `selfStatBad` 里新加的 `opNonStat` 一支：不能说
"static 的方法里没有接收者"（asy 那边这一份根本不是 static），话得说对。

`import plain;` 3 -> **2**（`plain_bounds.asy` 只剩 `:657` 的 `var`；另一条是
`plain.asy:67` 返回函数类型）。`import graph;` 还是 182。

跑的轴：`tests/asy`（147 passed，92.9s —— 机器上还并着一条 bootstrap）、`tests/run.js`、
`tests/bootstrap`。只动 `frontend-asy/`（decls.js、calls.js、lower.js），tests/sexpr
跳掉 —— 方言与后端没碰。

### `var`：类型从初值来，**推的地方**是声明遍

`var` 不是一个类型，是"从初值推"。量过真 asy（`asy -noV`）：

- `var a=1, b=2.5;` 印 `1` 与 `2.5` —— **每个名字各推各的**，不是一句一个类型；
- `struct S { var n = 5; } S s; write(s.n);` 印 `5`（字段也收）；
- `void f() { var q = 7; write(q); }` 印 `7`（局部量也收）；
- `var z;` 报 `inferred variable declaration without initializer` 并退 1。

三处（文件级、struct 字段、函数体）在这一层落到两个地方。局部量最简单：`asyVardec`
里那条 `isVar` 分支把初值降一遍，`lit.type` 就是这一格的类型，`lit.code` 就是初值 ——
零值那一串 `else if` 一条都不走（`var` 一定有初值）。

**文件级那份的类型不能等到降那一句才定。** 这是这一刀里唯一一处结构性的话：一个单元的
正文里，**函数体比文件级语句先降**（`asyBodyPass` 的顺序 —— 方法体、文件级函数体，最后
才是剩下那些语句）。所以

```asy
var a=4;
int h() { return a+1; }   // h 的体先降 —— 那时候 a 必须已经有类型
write(h());
```

要通，`a` 的类型必须在**声明遍**（`asyGlobalNames`）里就定好。于是那一遍里加了一句
`probeTy(初值)`：试着把初值降一遍、只要类型、代码与诊断都丢掉。位置临时摆成这一项的
位置（`L.at = at`），所以"初值里只看得见前面声明的东西"这条顺序规矩照旧 —— 与
`recVis` / `gvarHere` / `visible()` 是同一条。降到那一句时（`asyVardec` 的
`g.ok` 分支）再把初值往 `g.type` 上收一次：两遍推出来的应该是同一个类型，收一次是为了
万一不是时报错话，而不是发一句类型不对的 `(set …)`。

struct 字段走的是 `recordBody` 里的同一个 `probeTy`。**推不动的时候要把原因说出来**：
`plain_bounds.asy:657` 的 `private var base=new freezableBounds;` 到今天还在门外，而
真正的门槛不是 `var` —— 是 `freezableBounds` 体里那句 `addPath=addPathToEmptyArray;`
（把**方法取出来当值**，还没做）。所以 `probeTy` 留了一格 `probeMsg`（丢掉的那一批诊断
里的第一条），nope 的话里带上「那一遍里报的是「未声明的变量 'addPathToEmptyArray'」」。
不带这一句的话，那条 nope 会把原因指到 `var` 上 —— 那是在自己的账上记假账。

`var z;`（没有初值）是 **err，不是 nope**：asy 自己就不收它，收下来就是比 asy 多接受
一门语言。钉在 `tests/asy/strict/var-noinit.*`（真 asy 也拒）。

外面的数：`import plain;` 4 条 → **还是 2 条**（这一刀没让它掉 —— 657 那条的门槛在
「方法当值」上，见上），`import graph;` 182 条不变。剩下那两条是
`plain_bounds.asy:657`（方法当值）与 `plain.asy:67`（返回类型自己是函数类型）。

跑的轴：`tests/asy`（149 passed，115.6s —— 多的两条是 `cases/75-var` 与
`strict/var-noinit`）、`tests/run.js`（91 passed，36.5s —— 文件级那张表动了，REPL 跨批
也量了一遍：`var a=1;` 一批、`var b=a+2.5;` 下一批，印 3.5）、`tests/bootstrap`。
只动 `frontend-asy/`（lower.js、decls.js、stmts.js），tests/sexpr 跳掉 —— 方言与后端
没碰。

### 返回类型自己是函数类型：那个"歧义"是自己想出来的

`plain.asy:66-68` 是这三句：

```asy
using restoreThunk=void();
using saveFunction=restoreThunk();
saveFunction[] saveFunctions={};
```

`saveFunction` 的类型文本是 `void()()` —— 一个函数，回来的还是一个函数。以前
`asyFnTypeOf` 里有一条 nope 拦着它，理由写的是「`real(real)(int)` 那种拼法有歧义」。
**这一刀把那条理由推翻了**：不是歧义，是 `asyFnSplit` 从**前面**数括号。

拼法照 asy 自己的，而 asy 的声明是**返回类型写在前面**：`realfn adder(real a)` 的
类型文本就是 `real(real)(real)`。所以形参表永远是**最后**那一对括号，改成从后往前数
就行了：

- `real(real)(int)` -> ret `real(real)`、params `[int]`（吃一个 int、回一个 real(real)）；
- `real(real(int))` -> ret `real`、params `[real(int)]`（吃一个函数、回一个 real）。

两者分得开 —— 参数自己的括号**嵌在**最后那一对里面。所以没有歧义，只有一个数错方向的
循环。`asyCore` 本来就是递归的（`(fnty (real) (fnty (real) real))`），一个字没改。

量出来的两条边界：

- 这种类型**只能经 typedef 拼出来**。直接写 `real(real) adder(real a) {…}` 真 asy 报
  `syntax error` 并退 1 —— camp.y 里没有那条产生式，我们的语法表照它转写，所以也是
  语法错。钉在 `tests/asy/strict/fnty-ret-inline.*`。
- 回来的那个值要能**再调一次**（`h(3)(4)`，量过 asy 印 7）。被调的东西是个 `call`
  节点，这与第三十七刀的 `fs[0](5)`（被调的是 `subscript`）是同一条路子：只在语法上
  就认得出的位置上问一次，认出来就走 `asyFnValCall`。所以那一条 nope（"调用一个不是
  普通名字的东西"）前面多了一个 `call` 分支，剩下的（方法当值、算符名）还在门外。

外面的数：`import plain;` 2 条 → **1 条**，`import graph;` 182 → **181**。剩下那一条
是 `plain_bounds.asy:657` —— 门槛在「把方法取出来当值」上（见上一刀）。

跑的轴：`tests/asy`（151 passed，73.5s —— 多的两条是 `cases/76-fn-ret-fn` 与
`strict/fnty-ret-inline`）、`tests/run.js`（91 passed，21.3s）、`tests/bootstrap`。
只动 `frontend-asy/`（types.js、decls.js、calls.js），tests/sexpr 跳掉 —— 方言与后端
没碰（`(fnty …)` 那一档方言里早就有）。

### 把方法取出来当值：一个只抓接收者的闭包；顺带发现"外面那个数"一直是虚的

`plain_bounds.asy:247` 是这一句：

```asy
void addPath(path g, pen p);        // 无体的声明 = 一格函数值字段
private void addPathToEmptyArray(path g, pen p) { … }
addPath=addPathToEmptyArray;        // 把**方法**放进那一格
```

量过 asy（`asy -noV`）：

- `int f() = a.get;` 之后 `write(f())` 印 7；接着 `a.n = 9`，再 `write(f())` 印 **9**。
  绑的是**那个对象**，不是取出来那一刻的字段值。
- `int g(int) = a.add;` 通（带形参的方法也一样）。
- struct 体里 `step = one;` 通，方法里 `step = two;` 换掉它也通（印 3 再印 4）。
- 附带量到、也纠了一条我原先写错的话：`a.get = h;` **asy 收**（那边方法就是一格
  函数值字段，赋完 `a.get()` 印新那份）。我们不收 —— 所以那条 nope 的理由改成了
  「我们的方法是多一个 this 形参的普通函数，没有那一格」，而不是原来那句"asy 也不收"。

实现是现成零件的组合：方法在这一层是 `asy__m_<记录>_<方法>(this, …)`，所以生成一个
只抓接收者的闭包 —— ADR-0010 那套 `(cfn 名 ((asy__recv 记录)) (形参…) 返回 (ret (call
方法 (cap asy__recv) 形参…)))`，用处上是 `(mkclo 名 接收者)`。一个方法只生一份包装
（`mvals` 那张表，与数组工厂 `arrGen` 同一条路子）。**"改字段看得见"这条不是模拟的**：
struct 是引用语义，`(mkclo …)` 按值抓的就是那个引用。

两个入口：`a.get`（`asyMember` 里，**字段之后**问）与 struct 体里的裸名字
（`asyNameOf` 里，`selfField` 之后问，接收者是 `(var this)`）。门外还剩三条：带默认值
的方法、可变形参的方法、**重载**的方法（那要靠目标类型定案，与裸函数名当值那一条
是同一件事，只是还没铺过来）。`tests/asy/bad/fn-value.*` 搬成
`tests/asy/cases/77-method-value.*`（asy 的输出逐字节抄）。

**这一刀最重要的产出不是这个功能，是一条要纠的账。**「`import plain;` 还剩几条」这个数
从 4 一路报到 1，读起来像"快通了"。这一刀把 657 那条拆掉之后，数字变成 **615**。
A/B 量过（`git stash` 掉这一刀的两个文件，同一份 `/tmp/p.asy`）：committed 状态 1 条，
带这一刀 615 条。也就是说**之前那个 1 不是"只差一条"，是"在第一条上就停住了"** ——
一个 struct 体在声明遍失败之后，那个记录不进表，凡是签名里提到它的东西跟着被丢掉，
而绝大多数"丢掉"是**不报诊断**的（顺手量到的一条：`struct S { int n = 一句降不动的初值; }`
如果 `S` 从没被用过，那句错根本不会印 —— 字段默认值是在**用到**时才降的）。
所以从今天起这个数的含义写清楚：**615 是正文遍第一次量到的真实面**，而 4/3/2/1 那一串
量的是"声明遍在哪一条上停下"。`import graph;` 那边 182 → 181，它自己的数还卡在更早的
位置上，同一条毛病。

顺带记一件正面的：`import plain;` 的**声明遍现在整份走通了**（plain.asy 那十几个
`include` 摊成一个单元，几千条顶层项）—— 615 条全在正文遍里，按文件分是
plain_pens 146 / plain_picture 85 / plain_paths 55 / plain.asy 41 / …；按理由分头三条是
「类型名顺序解析」（**231** 条，绝大多数是 pen/path/frame/file/transform 那几个内建面的
名字在 `recVis` 里的位置不对，看着像同一处毛病）、「内建函数还没做」（79 条）、
「未声明的变量」（26 条）。下一刀该从那 231 条查起 —— 那大概是**一处**，不是 231 处。

跑的轴：`tests/asy`（151 passed，90.1s —— `cases/77-method-value` 进来、
`bad/fn-value` 出去，条数不变）、`tests/run.js`（91 passed，16.9s）、`tests/bootstrap`。
只动 `frontend-asy/`（lower.js、exprs.js、stmts.js 的注释），tests/sexpr 跳掉 ——
`(cfn …)`/`(mkclo …)` 是方言里早有的那一档，后端一个字没碰。
















### 不再一条一条量：内建面照参考实现整批补

前面每一刀都是"量一句 `asy -noV`、改一处、跑全量测试"。到了 `import plain;` 这一档
这个节奏走不动了：那边缺的不是某一条语义，是**几百个 C++ 内建**加四五处顺序规则。
换的做法是照着参考实现读（`builtin.cc` / `run*.in` / `base/*.asy`），一批一批地补，
补完再测。

这一批里真正是"规则"的只有四条：

- **同一份类型再从别的模块进来一次，位置不后移**。`asyModMerge` 的 recVis 循环原来
  无条件按 `at` 覆盖，于是 plain 里被两条 include 路径带进来的同一个 struct 会把自己
  的可见位置推到后面，后面所有用它的地方全成了"声明在后面"。一句 `had.rec === e.rec`
  就地跳过 —— 231 条诊断是这一行换来的。
- **用户可以重载 `write`**。原来 `write` 这个名字在签名遍就被拒了（它是语句），
  改成注册成另一个符号 `asy__uwrite`，语句层先按用户候选试一遍、接不住再走内建那条。
- **声明可以出现在语句位置**：`fundec` / `recorddec` / `typedec`。函数那一种要看清楚
  它是不是闭包 —— 用到外层局部量就还是拒（`localFun` 扫一遍体里的名字）。
- **`var` 在声明遍就要推**：模块级的 `var` 在函数体之后才轮到，所以类型必须在
  `asyGlobalNames` 里用 `probeTy` 先探出来。

余下的是内建面：常量（`intMax`/`realEpsilon`/`infinity` 照 `builtin.cc:876-921`）、
`abort`/`assert`、`concat`/`minbound`/`maxbound`、笔的那一排属性槽、`rand`/`srand`、
`transform * path`。真几何与 TeX/文件/进程那两类没有机制可依，就分成三档写在 prelude
的尾巴上：**能算的算**、**没机制的给固定值或空操作**、**真几何的 `abort` 占位**。
每一条都带一句"这是哪一档、为什么"。

数字上这一批是 615 → 380（`import plain;`），graph 182 → 181。615 那个数才是第一次
**诚实**的：在这之前那 1 条是声明遍早退的假象 —— 一个记录在声明遍失败，它和所有提到
它的东西一起消失，而且多数**不发诊断**（同样量到：`struct S { int n = <坏初值>; }`
只要 `S` 没被用过就一句话都不印，因为字段默认值是用到时才降的）。

### 泛型的那几个内建：按元素类型现生；顺带把"成员遮住外层"这条改对

`import plain;` 剩下的 380 条里最大的一族是 C++ 那边**对 T 泛型**的内建：`copy` 18、
`sequence` 13、`min`/`max` 24。这个前端没有泛型，两条路：写死几个元素类型，或者按
**实参的类型现生一份 helper**。选后者 —— 与 `arrGen` 那张表同一条路子（一个类型只生
一份，名字过 `asyMangle`）：

- `copy(T[])`（`runarray.in:687` 的 copyArray，depth 默认 Int_MAX）：元素本身是数组时
  **递归**深拷。生成前先往表里塞占位，递归才不会绕回来。
- `sequence(T f(int), int n)`（`runarray.in:954`）：`{f(0),…,f(n-1)}`，元素类型就是 f
  的返回类型，体里是一句 `(callfn (var f) (var i))`。
- 挂进调度是 `asyBuiltinOwns`/`asyBuiltinCost`/`asyBuiltinRaw` 各加一条，代价记 0
  （元素类型是照实参现生的，逐个同型）。

`min`/`max` 不必现生：`builtin.cc:543` 的 `addOrderedOps` 说明它们只在**有序**的基本
类型上有（int/real/string 的两元与整份数组），照着摆在 prelude 里就是十二个短函数。
`min(path[])`/`max(path[])` 是另一回事（`runpath.in:290/314`，回 pair 的包围盒）：
每段是三次 Bezier，某个分量的极值只能出在两端或**导数为零**处，导数是二次的 ——
解那条二次就是精确解，不是采样。

顺带改对了一条规则：**struct 里的同名成员并不整片遮住外层的同名函数**。asy 的 venv 是
逐层按签名找的，成员那一层接不住这次实参就往外走。原来那一档见到有同名成员就直接
`asyUserCall` 回去了，于是 `plain_picture.asy:686` 的 `min(real,real)`（struct picture
里有 `pair min(transform)`）报"没有能匹配"。改成先试成员、试不上回滚（诊断与前置语句
一起回滚）再往下走；`cases/79-member-outer-overload` 把七种组合钉住，与真 asy 逐字节
一致。同一处还带出一个坑：内建里有**自己求实参**的那几族（pair/triple 的
`dir`/`expi`/`dot`、`string(…)`、字符串那一族、数学那一族）不走按值入口，所以
prelude 里一加 `dir(path,real)`，`dir(30,45)` 就找不到 triple 那一份了 ——
补了 `asyNamedBuiltin` 这条按名字重试的回滚路（tol/triple 那个用例当场变红，是它逼出来的）。

这一批里还顺手补齐的小件：`a[ix]`（ix 是 int[]，`runarray.in` 的 arrayIntArray，
base 里 `reverse(a)` 就是 `a[reverse(a.length)]`）、`a.append(b)`、`(string) x`
（asy 那边 int/real → string 是显式那一条）、`unit`、`identity(n)`、
`replace(string, string[][])`（`runstring.in:215` 那个"命中就从第一条规则重试"的一趟扫）、
`point(path,real)`/`dir(path,…)`、`format` 的两个内建（只做"把 % 那一格换成这个数的
默认写法"，精度/指数/千分位还没有，记在 prelude 里）、`warning`/`nowarn`。

数字：`import plain;` 380 → 309，`import graph;` 181 → 153。tests/asy 151 条、
tests/run.js 91 条都是绿的。

### 赋值是表达式：摊成语句再把左边读回来；循环条件跟着换了个编码

asy 那边赋值**是表达式**，值就是赋进去的那一个。base 里两种写法都靠这条：
`x=y=z=0`（plain_picture.asy:185）与 `while((i=find(s,d,last)) >= 0)`
（plain_strings.asy:102）。

做法是"摊成语句再读回来"：把这个赋值当语句降一遍（复用 `asyExprStmt`），
把出来的行摊进 `this.pre`，然后把**左边**当表达式读一遍作为这个表达式的值。
能这么做的前提是左边**重读一遍没有副作用**，所以加了一条 `asyRereadable`：
名字、`this`、名字的字段、名字下标（下标本身也要能重读）收，含调用的一律不收 ——
不收比"把 `f(i).n = v` 里的 f 调两次"强，那种错静悄悄。

`while` 的条件因此换了编码。原来条件里摊出语句就报错（`asyLoopCond`），理由写的是
"摊出来的只能落在循环外面，那样条件只算一次"。现在条件的 `pre` 单独收着，非空时发的是：

```
(while (bool true) (do <条件摊出来的语句…> (if (un "!" 条件) (do (brk))) <循环体…>))
```

条件的计算落在循环体的**开头**，所以每轮都重算；`continue` 跳到循环顶，也会重新算 ——
与 asy 一致（`cases/80-loop-cond-stmts` 里第三段就钉这一条：`while((j=j+1) < 5)`
里 `continue` 之后 j 照样往前走，印 8）。原来那个 `bad/cond-in-loop` 因此升成用例。

同一批还补了**限定名当赋值目标**（`settings.outformat = "pdf"`）：读那一路一直有
（`modVar`），写这一侧照 static 字段那条走 `asyAssignStat` —— 模块里的文件级变量就是一个
全局，落的是 `(set 符号 值)`。`bad/mod-qassign` 也升成用例。

数字：`import plain;` 309 → 300。tests/asy 153 条全绿。

### 捕获：抓函数值可以了；"会被改"要看位置

捕获这一档原来有三条拦法，其中两条是自己拦宽了：

- **抓一个函数值**原来一律拒（理由写的是"闭包里再套闭包是另一刀"）。其实核心方言里
  `(fnty …)` 就是一等的，捕获形参声明成 `(d (fnty (int) void))`、体里 `(callfn (cap d) …)`
  就通。base 里 plain_picture.asy:488 的
  `add(new void(frame f, transform t, …) { d(f,t*T); })` 正是这一种 —— `d` 是外层方法的
  形参。调用那一侧也要接上：`asyCall` 里在"本层局部量"之后、"文件级候选"之前问一句
  外层的函数值（asy 的名字解析由内向外，外层局部量遮住同名的文件级函数）。
- **"会被改"的判据从"整个函数体里被赋值过"改成"在这个闭包之后还被赋值过"**。
  改在闭包**之前**的，按值抓的时候已经是最新的那一份，与 asy 的按引用同一个结果 ——
  base 里 plain_picture.asy:1294 的 `if(copy) g=copy(g); pic.add(new void(…){ … g … });`
  就是这一种（11 条诊断出在这一个写法上）。位置用 span 的字节偏移比。
  循环那一条单独看：赋值写在闭包前面、但循环会让它在闭包之后再跑一遍，所以只要那个
  循环把闭包包在里面，循环里的赋值都算"之后"。改在之后的还是拒（`bad/anon-capref` 钉着）。

还修了一处漏：**方法**体这一路没有存体的 AST（`L.fnBody`），于是 capOf 见到 `body`
是 null 就一律拒 —— 文件级函数那一路一直是存的，方法漏了。这就是那 5 条 `d` 的来路
（先报"内建函数 'd'"，抓函数值那条放开之后才现出真正的原因）。

还在门外：抓外层的 `this` 与裸字段名、嵌套的匿名函数、以及"改在闭包之后"那一种
（真要做就得把那个格子装箱 —— 声明处换成一格数组，读写都走 `aget`/`aset`，
闭包抓的是那个句柄。那是下一刀）。

数字：`import plain;` 300 → 292。tests/asy 154 条、tests/run.js 91 条全绿。
新用例 `cases/82-capture`（与真 asy 逐字节一致）。

### 写到 file 上：攒成整行才交给 print；顺带撞上"双引号不认转义"

`write` 那一族在参考实现里是 `builtin.cc:474` 的 `addWrite`，形参是
`void write(file file=stdout, string s="", T x, void suffix(file)=endl, ...)`。
核心方言这一层只有 `(print …)`，而 `print` **自己补换行** —— 所以 `write(f, "a")`
这种"不换行地写一截"没法直接映上去。这一刀的做法是把 `file` 变成一个带缓冲的结构体：

```asy
struct file { int fd; string buf; }
```

写进去的东西先接到 `f.buf` 上，攒出 `\n` 才把那一整行交给 `print`。面向行的输出因此
与 asy 逐字节一样；代价是**一行没写完就退出时那一截会丢**（asy 那边退出前会 flush），
这条差别记在这儿。`input()`/`output()`/`nullFile()`（`runfile.in:45/80/149`）这一层只给
stdin/stdout/丢弃三个句柄，带名字的真文件要等方言里有 IO；`flush`/`precision` 是空壳。

suffix 那一族（`none`/`endl`/`newl`/`tab`/`comma`）就是 `void(file)` 的普通函数值，
`asy__suffix` 是它的 typedef。两个坑：

- **默认的 suffix 是 `none`，不是 `endl`。** 我按签名想当然写了 `endl`，量出来
  `write(f,"abc")` 不补换行 —— 带 `file` 的这一支与不带 `file` 的 `write(x)` 不是一条。
- `void none(file)` 必须定义在用它当默认值的那些重载**之前**：默认值的可见性是按位置来的。

`write(f, endl)` 是单独一支（只给 suffix，不给值），得有 `void write(file, asy__suffix)`
这个重载，否则重载集里最近的是 `write(file, T x)`，报出来的是"实参不能是结构体"。
bool 那一支照 asy 补尾空格（`"true "` / `"false "`，与 `string(bool)` 同一条）；
asy 自己**没有** `string(bool)`，所以这儿只能自己拼。

真正花时间的是最后那个 bug：输出成了 `one\nntwo-3\n`，每行头上多一个 `n`。原因不在缓冲
逻辑，在字面量 —— **asy 的双引号串不处理转义**，`"\n"` 是两个字节 `\` 和 `n`
（`length("one\n")` 在真 asy 是 5，`find(b,"\n")` 找到的是那个反斜杠），要真换行得用
单引号串 `'\n'`。我们的词法器这一条与 asy 一致，是我写 prelude 时按 C 的习惯写错了。

数字：`import plain;` 292 → 281，`import graph;` 153 → 151。tests/asy 155 条、
tests/run.js 91 条全绿。新用例 `cases/83-write-file`（与真 asy 逐字节一致）。

### 实参往形参上落：这一格接不住而它有默认值，就跳过去

两条都是"名字/签名怎么找"的规矩，都是照参考实现改的，不是猜的。

**一、中间那些带默认值的形参可以跳过去。** 我一直以为位置实参是一格一格顺着填的，
量出来不是：

```asy
int f(int a, int b=7, string c, string d) { return a + b + length(c) + length(d); }
write(f(1, "xy", "z"));   // 真 asy 印 11 —— b 用了默认值 7，"xy" 落到 c 上
```

参考实现在 `application.cc:205` 的 `matchArgument`：

```cpp
return matchAtSpot(index, e, source, a, evalIndex) ||
  (matchDefault() && matchArgument(e, source, a, evalIndex));
```

—— 这一格接不住就（`matchDefault`，`:154`）把默认值填上、`index` 往后挪一格再试同一个
实参。所以我们的 `asyFit` 里那一大串"接不住就 `return null`"要分成两层：一层是**这一格**
接不住（能不能跳过由外面定），一层是**这个候选**不合用。落地是把逐格的判断抽成一个
`tryAt(r, at)`，回代价或 `null`，外面照 asy 那条规矩循环。跳过去的槽记成 `'def'`，
最后算"缺了哪几个"时它算没给（走 `asyDefWrapper` 那一档）。带名字的实参不参与跳格 ——
`matchNamedArgument`（`:220`）用的是那个名字自己的槽。

**二、成员那一层"声明在后面"不能整片挡住外层。** 上一刀留下的那条"成员声明在后面就当场
报错"太急了：base 里 plain_bounds.asy:226 是

```asy
struct freezableBounds {
  … min(a, b) …          // 这里的 min 是外层（内建）的那个
  pair min();            // 成员的 min 声明在后面
}
```

asy 那边成员那一层看不见它、于是接着往外找。所以这条诊断改成**先记下来**，一路走到
最后什么都没接住时才发。原来那条 strict/ 用例（`struct S { int y = f(); int f(){} }`，
外层没有同名的 `f`）照旧被这一条接住。

数字：`import plain;` 281 → 254（成员那一条 -9，跳格那一条 -18）。`import graph;`
151 → 153：涨的这两条是真进展 —— `xlimits(picture, bool)` 原来接不住，现在接住了，
后面那段代码才第一次被看到（露出 `clip` 内建与 picture 的两个 userSet 方法）。
tests/asy 156 条、tests/run.js 91 条全绿。新用例 `cases/84-arg-slots`（与真 asy 逐字节一致）。

### 可变形参进签名身份；笔的盒子与虚线那一族

上一刀把"实参怎么落格"改对之后，剩下最大的一族是"没有能匹配的签名"（65 条），头两个是
`min(int[])` 与 `min(real[])` —— prelude 里明明有 `int min(int[] a)`，候选表里却只剩
`int(... int[])`。原因是"同签名是替换"那条比的 key 是形参类型逐个拼起来，
**可变那一格没进去**：base 里 plain_constants.asy:42 的

```asy
int min(... int[] a) {return min(a);}
```

于是"替换"掉了 prelude 那份数组 min，而它体里那个 `min(a)` 要的正是被替换掉的那一份。
asy 那边 `signature` 是带 rest 的，两者不是一份。改法就是把 key 换成带 `...` 标记的
`asySigKey(cand)`（`explicit` 与形参名照旧不进签名身份，那两条是量过的）。

顺带按参考实现补了笔那一侧的几族：

- `min(pen)` / `max(pen)`（runtime.in:339/344 → pen.h:931 的 `pen::bounds()`）：没有 nib、
  变换是恒等时走 `maxx=maxy=1、shift=(0,0)` 那一支，盒子就是 ±0.5*linewidth 的正方形。
  plain_boxes.asy:16 的 `0.5*sign*(max(p)-min(p))` 用的正是这一条。
- `defaultpen()` / `defaultpen(pen)` / `resetdefaultpen()`（runtime.in:350/355/360）。
  这里踩到一件事：asy 的 `defaultpen` 是**函数**，而我们 prelude 里一直有个同名的
  全局变量 —— 变量在名字解析里排在函数前面，所以那一格改叫 `asy__defpen`。
- `linetype(real[], real offset=0, bool scale=true, bool adjust=true)`（runtime.in:503，
  负数截成 0）与 `linetype(pen)` / `offset` / `scale` / `adjust`。pen 上多了四格存虚线，
  **EPS 那一路还没发 setdash**，所以虚线现在画出来是实线 —— 与 pen 上另外几格同一种
  "存着但没画"的差别，写在明处。
- `begingroup(frame)` / `endgroup(frame)` / `is3D(frame)`（runpicture.in:286/291/778）：
  分组是 EPS 的 gsave/grestore 那一层的事，我们的 frame 只攒 drawop，所以这两个是空的。

数字：`import plain;` 254 → 226（签名身份那一条 -5，笔那一批 -23）。`import graph;` 153
不动。tests/asy 157 条、tests/run.js 91 条全绿。新用例 `cases/85-sig-and-pen`
（与真 asy 逐字节一致）。

### 矩阵那三个乘法、`transform * frame`，与"笔只吃去掉平移的那一半"

`transform3` 在 asy 里就是 `real[][]`，所以 plain_picture.asy 里到处的 `t*(0,0,0)`
落在 `triple operator *(real[][], triple)`（runarray.in:1462）上。它是**齐次**的 ——
量出来的：

```asy
real[][] t = {{1,0,0,5},{0,2,0,6},{0,0,3,7},{0,0,0,2}};
write(t*(1,1,1));   // (3,4,5)，不是 (6,8,10) —— 除了第四行算出来的 2
```

连带补上 `real[][] * real[]`（:1399，纯矩阵乘向量，**不**除）与 `real[][] * real[][]`
（:1452）。

`transform * frame`（runtime.in:1112）是"frame 里每一笔都搬"。这一刀真正的收获是笔那一侧：

- `transform * pen`（runtime.in:1107 → pen.h 的 `transformed`）搬的是**笔自己那个变换**
  （`ret.t = p.t.isNull() ? t : t*p.t`），所以 pen 上多了一格 `pentrans`。
- 笔的盒子（pen.h:931）因此不再是"±0.5*linewidth 的正方形"：maxx/maxy 是线性部分
  **两行各自的模长**（单位圆被映出去的最大 x/y），再加上那个变换的平移。
- 而 frame 里那一笔被搬时，笔吃的是 **`shiftless(t)`**（drawelement.h:302）。这条是量出来
  才知道的：`min(shift(3,4)*f)` 是路径搬过去再 ±0.25，笔那一格**没有**跟着平移；
  一开始我照 `t*o.p` 写，盒子就被平移算了两遍（量到 (5.75,7.75) 而不是 (2.75,3.75)）。
  `xscale(2)*f` 那一头则要真吃：max 是 (2.5,2.25) 而不是 (2.25,2.25)。

还差的是笔尖本身（pen.h 的 `pen::P`，`makepen(path)` 造出来的那种）—— 它还是 abort。

数字：`import plain;` 226 → 209。`import graph;` 153 不动。tests/asy 158 条、
tests/run.js 91 条全绿。新用例 `cases/86-matrix-frame`（与真 asy 逐字节一致）。

### `for (var x : a)`：元素类型从数组推

`var` 那一档（第四十一刀）当时只做了普通声明，`for-each` 的位置漏了 —— 而 base 里 `var`
的**全部**七处用法都在 for-each 上（plain_bounds.asy 的 `for (var link : links)` 那一族）。
补法与普通声明同一条：`var` 不是类型，是"从初值推"，这儿的初值就是 `a[i]`，所以类型
就是数组的元素类型。落地上只有一处别扭：推之前得先把数组求出来，所以 `asyForEach`
里求值顺序与写死类型那一路反过来了。

顺手记两条这一刀量到、但**没做**的东西，免得下次再查一遍：

- `T.cyclic = true`（plain_paths.asy:165、plain_pens.asy:148/152、plain_strings.asy:238）
  不是"给字段赋值"，是 asy **数组自己的属性** —— 循环数组的下标按长度取模。我们的核心
  方言里数组没有这一格，所以这四条还立着。
- `write(file, ..., pen)`（plain_Label.asy:358 那一族）要的是 pen 的文字形式
  （builtin.cc:863 的 `addWrite<pen>`），那是一串 `rgb(...)+linewidth(...)` 的拼法，
  不是随手能对齐的。

数字：`import plain;` 209 → 203。tests/asy 159 条、tests/run.js 91 条全绿。
新用例 `cases/87-foreach-var`（与真 asy 逐字节一致）。

### 类型名是 typedef 别名的模块级变量

`identity4`（plain_prethree.asy）是个 `transform3` —— 而 `transform3` 是 `real[][]` 的
typedef 别名。二维数组这一格我们本来是收的，坏的是**声明遍**：`asyGlobalNames` 那一步
"照着节点看类型"只认标量与记录名，别名解不开就 `ok:false`，于是函数体里五处引用它都报
"模块级变量收 int/real/bool/…"—— 一句把"名字没解开"说成"类型不收"的错话。

改法是把那一遍里原来只给**函数类型**别名开的口子（`typedef real F(real); F f;`）放成
一般的：`ty === null` 且类型名是个别名时就解开它，再照 `arr + dims` 加维度。位置照旧
临时设成这一项的位置 —— 别名的可见性也是顺序的，`aliasAt` 不报诊断（这一遍只收表，
真正的检查在 vardec 那一遍）。

数字：`import plain;` 203 → 196。tests/asy 160 条、tests/run.js 91 条全绿。
新用例 `cases/88-alias-global`（与真 asy 逐字节一致）。

### frame 上那一批画图内建：签名抄准，做不到的体是 abort

到这一刀，`import plain;` 剩下的最大一族是"没有能匹配的签名"（45 条），里面大半是
frame 上那批画图内建：渐变的五个（lattice/axial/radial/gouraud/tensor/function shade）、
裁剪的三个（clip/beginclip/endclip）、`tex`/`postscript`/`javascript`/`deconstruct`、
`layer`/`newpage`、`min3`/`max3`。这些的语义都在 EPS/TeX 那一层，这一刀做不动。

做法是**照 runpicture.in 把签名抄准，体写 abort**（prelude 里已有的
「声明在这里、体是 abort」那一档）。这不是把错误藏起来：抄准签名之后"没做"落在
运行期那一句话上（`abort("radialshade 还没做")`），而不是编译期一堆"没有能匹配的签名"——
后者会把它后面**所有**代码挡在门外，看不见真正的下一个问题。

真做了的是 `fill(frame, path[], pen, bool)`：每条路径进一笔填充。**明写的差别**：
asy 那边一组路径连着 fillrule 是**一个**填充区域（挖洞靠它），我们是一笔一笔填，
所以带洞的图形会与真 asy 不一样。

顺带几个零碎的：`shift(transform)`（runtime.in:1169，只留平移、线性部分清零 ——
量过是 `(3,4,0,0,0,0)`）、`interp(pair,pair,real)`、`minbound/maxbound(pair[])`、
字号那一格（runtime.in:590/596 —— pen 上多一格，默认值是 **12pt 换成 bp** 的那个数，
量过 `fontsize(currentpen)` 就是 11.9551681195517 = 12*72/72.27）。

**一处自己的错话被量出来了**：`write(transform)` 我们报的是"asy 那边 write(transform)
就是 no matching function"，而真 asy 印 `(3,4,2,0,0,2)`（builtin.cc:861 的
`addWrite<transform>`）。补上之后又量到另一半：**数组那一支 asy 不收** ——
`write(new transform[]{...})` 那边报 "no matching function 'write(transform[])'"，
所以 `asyWriteArrays` 里元素是记录的一律拒（新 strict 用例
`strict/write-transform-array` 钉着这一条）。`write(pen)` / `write(guide)`
（builtin.cc:862/863）还没做，那条诊断现在说的是"还没做"，不再说"asy 也不收"。

数字：`import plain;` 196 → 173。`import graph;` 153 不动。tests/asy 162 条、
tests/run.js 91 条全绿。新用例 `cases/89-frame-builtins` 与 `strict/write-transform-array`。

### 剩下那一批 C++ 内建，与 `alias` 这个"每个类型现生一条"的算符

`import plain;` 停在 173 时最大的一族是 27 条「内建函数 'X'」。挨个查过
`/Users/wurui/Documents/Lang/reference/asymptote` 之后，这一族其实是**两件事**：

- 真的是 C++ 内建、我们一条都没给的 —— `colors` / `history` / `saveline` / `eof` /
  `error(file)` / `seconds` / `windingnumber` / `_strokepath` / `dirtime` / `prepend` /
  `_shipout` / `quotient` / `_eval` / `stripextension` / `delete` / `_cputime` /
  `_schur` / `readline` / `rename` / `straight` / `exit`；
- 根本不是内建 —— `userBoxX3`（plain_picture.asy:428 的成员）、`fitter`（:876 的静态
  函数字段）、`out`（plain_Label.asy:302 的成员）、`addMinToExtremes`
  （plain_bounds.asy:143 的 private static）。这四个是**别的**原因让名字没进表，
  与"缺内建"是两刀，这一刀不动它们。

签名一条一条量的，办法是让 asy 自己把函数类型印在诊断里：
`void g(){ int x = colors; }` → `cannot cast 'real[](pen p)' to 'int'`。重载的那几个
（`history`、`_eval`、`_schur`）回的是 `cannot cast expression`，那就回去读 `.in`：
`runhistory.in:158/191`、`runtime.in:724/737`、`runarray.in:2003/2051`。`_eval` 还有一条
`void _eval(code, bool)` —— 类型 `code` 这一刀没有，只给了 `string` 那条（少给一个重载
只会少接，不会多接）。

体分四档，写在 `asy_builtins.asy` 尾巴上：

- **照参考实现写准**：`colors`（runtime.in:413 那个 switch，按颜色空间给 0/1/3/4 道；
  量过默认笔 DEFCOLOR 是 1 道、`invisible()` 是 0 道）、`stripextension`
  （runsystem.in:204 → util.cc:265 `stripExt(name,"")`：suffix 是 `"."`、n 是 1，
  砍的是**最后一个点**，它不认目录 —— 量过 `a.b/c` 是 `a`）、`prepend(frame,frame)`
  （runpicture.in:326；asy 的 `frame` 就是 C++ 的 `picture`，与 `add` 同一族）、
  `straight(path,int)`（path.h:167：非闭合越界回 false，闭合走 imod）。
- **借已有的那条语义**：`quotient` 就是我们的 `#`（asy__quot 那份 helper 早把
  "除不尽且异号时减一"补上了，量过 `quotient(-7,2)` 是 -4），不再抄一遍。
- **照 `#else` 那一支写准**：`history` 与 `saveline` 在没有 readline 的构造里就是
  "回空表"与"什么都不做"（runhistory.in:184/195/277 那三处 `#else`）—— 我们一直是那一路，
  所以这两条**不是** abort。
- **签名抄准、体是 abort**：`eof` / `error(file)` / `seconds` / `_cputime` / `delete` /
  `dirtime` / `windingnumber` / `_strokepath` / `_shipout` / `_eval` / `_schur` /
  `readline` / `rename` / `exit`。缺的东西各自写在自己那一行（没有时钟、不动文件系统、
  要解三次方程、要 Eigen、要绕 gs 走一趟）。`exit` 那条差别值得点出来：asy 的 `exit()`
  是**状态 0 的正常退出**，而这一层只有 abort 那条越界路径（非零退出）。

一个副产品：C++ 那边 `rename` 的形参叫 `from`/`to`，而 `from` 在 asy 的**语法**里是
关键字。量过真 asy 自己也写不出这个名字（`int from=3;` 与 `rename(from="a",…)` 都是
syntax error），所以 prelude 里换成 `src`/`dst` —— 形参名换掉不改变任何**写得出来**的调用。

`alias` 是这一族里唯一进不了 prelude 的：asy 那边它不是一个函数，而是 builtin.cc 给
**每个记录类型**（:673 `addOp(run::boolMemEq, …, SYM(alias), formal(r,…), formal(r,…))`）
与**每个数组类型**（:604-614 那一段）现生的一条 `bool(T,T)`。这个前端没有泛型，于是照
那个办法在 `calls.js` 里现生：`asyBuiltinOwns` 认"两边都是记录或数组（或 `null`）而且
同型"，落地就是记录/数组上的 `==`（`(bin "==" …)`，与 `asyCmpCode` 同一条 —— 都是比身份）。
两边都是 `null` 不认：asy 那边报 `operator ==(null, null)` 歧义。函数类型上**没有**
`alias` —— 量过 `alias(g,g)` 是 "no matching function 'alias(int(int), int(int))'"，
新 strict 用例 `strict/alias-fnty` 钉着这一条，守的是"补了 alias 之后没顺手把它做成
对一切类型都通的东西"。

补完之后又冒出五条**新**的缺名（`readline` / `straight` / `rename` / `exit` / `saveline`）——
那是原来卡在前面的行终于走到了，是往前走而不是退步，所以一并补上了。

数字：`import plain;` 173 → 153。`import graph;` 153 不动。tests/asy 164 条、
tests/run.js 91 条全绿。新用例 `cases/90-more-builtins` 与 `strict/alias-fnty`。

### 点号左边那个名字也要能捕获

153 那一堆里 12 条是「调用一个不是普通名字的东西」。挨个看过去，这 12 条是**六件**
不同的事（显式调 `operator init`、`(above ? add : prepend)(…)`、部分应用的
`operator ..`、`this[k]`、`((F)map.operator init)()`，以及最大的一族 5 条），
而那 5 条根本不是"调了个奇怪的东西"—— 是 `arrowhead.arcsize(p)`
（plain_arrows.asy:364/376/392/404）与 `srcCopy.fit(…)`（plain_picture.asy:1022），
两者都在**匿名函数体里**，点号左边那个名字是**外层函数的局部量**。

`asyNameOf` 早就有那一档（局部 → 外层局部（`capOf`）→ this 的字段 → 文件级），
但 `asyDotQual` 只问了前一档：`L.lookup(base)` 落空就直接往模块别名、static 那边走，
一路走空之后由 `asyCall` 兜底报"调用一个不是普通名字的东西"。话说得偏 —— 缺的是捕获，
不是"调用形状不认识"。补的就是 `asyDotQual` 里对应位置的一句 `capOf`，次序照 `asyNameOf`。

量过 asy：`struct S { real k=3; real f(real x){return k*x;} }` 加
`fn mk(S s){ return new real(real x){ return s.f(x); }; }`，`mk(s)(4)` 印 12；
字段读（`s.k + x`）走的是同一条 `dotQual`，一并通了。新用例 `cases/91-cap-recv` 里还
钉了第三格：接收者是外层的**局部**，而且闭包之后又改了它的字段 —— struct 是引用语义，
所以"按引用捕获"与"按值抓那个引用"在这一格是同一个结果（印 14），`capOf` 那条
"会被改的外层变量不收"因此不该拦它，也确实没拦。

数字：`import plain;` 153 → 145。`import graph;` 153 → 152。tests/asy 165 条、
tests/run.js 91 条全绿。新用例 `cases/91-cap-recv`。

### `from 字段 unravel 名字;`：把一个字段上的成员借到外层 struct 上

145 里 8 条是「struct picture 没有方法 'addPath'」。addPath 在 plain 里其实不是
picture 的成员 —— plain_picture.asy:556 写的是 `from bounds unravel addPath;`
（`bounds bounds;` 是 picture 的一个字段，那边的注释说理由是"省一次函数调用"）。
从前这一句落到"struct 体里的语句"那一档，正文遍再报一句 nope；而 struct picture 的体
在更前面就已经出过错，那句 nope 于是**一次都没印出来** —— 名字悄悄地少了一个。
这一刀先把它变成有下文的东西。

落地是一张**借名字**的表：`recordBody` 见到 `(unravel (name 字段) (idpairs …))` 就往
`rec.memAlias` 里记一条"这个名字要往那个字段上走一层"，`(wildcard)` 那一种
（collections/map.asy:198 的 `from map unravel *;`）记成 `rec.memAliasAll`。
`asyMethodCall` 在自己的成员都接不住时按这张表把接收者换成 `(fld recv 字段)` 再走一遍
自己 —— 方法、函数字段、static 三档都还是那三档，所以借来的重载集不必在这里重算。

顺手补上一处**先前就有的**偏差：方法那一档从前是"有同名方法就只在方法里挑"，接不住
就直接报"没有能匹配的签名"。但 asy 的成员查找是按签名逐档找的 —— 量过 struct 里
`void note(int)` / `void note(string)` 与**无体声明**的 `void note(int,string)`
（那其实是一个函数类型的字段）并存时，`note(2,"b")` 接的是字段那一格。
plain 的 addPath 正是这个形状（struct bounds 里两条方法加一条无体声明），所以这一条
不补，借过来也只借到一半。现在方法那一档走的是**试了再回滚**（与 `asyCall` 里
"成员遮住文件级函数"那一处同一副零件），回滚之后再问字段、static、借来的名字，
三档都不适用才让方法那句诊断说话。

两处与 asy 的差别写在明处：asy 是把借来的名字**并进同一个重载集**，所以"自己的一条与
借来的一条都能接"时那边报歧义，我们是自己的先赢（plain 树里没有这种撞名）；
借来的名字在 struct 体里**裸写**还不通（只走 `recv.名字(…)` 这一档）。
从模块或类型名 unravel、带 `as` 改名、以及函数体里的 `unravel x;` 都还是各自那句 nope。

数字：`import plain;` 145 → 136。`import graph;` 152 不动。tests/asy 166 条、
tests/run.js 91 条全绿。新用例 `cases/92-unravel-field`。

### 实参位置上那个裸名字，也要先问"它是不是外层的局部量"

136 里 21 条「没有能匹配的签名」有 10 条长着同一个样子：
`latticeshade(frame, path[], bool, <fillrule 的重载集>, pen[][], transform, bool)`、
`arrow(arrowhead, path, pen, <size 的重载集>, …)`。`<X 的重载集>` 是"这个名字有多个
函数重载，等槽的类型来定案"那个记号（第三十五刀），可它出现在这里是错的：
plain_picture.asy:1319 的 `fillrule` 是 latticeshade 的**形参**（一个 pen），
只是恰好与 plain_pens.asy 里的函数 `fillrule` 同名；`size` 同理。

根因与上一刀是同一处漏：`asyOverArg` 判"这条路走不走"时问了局部量、`this` 的字段、
文件级变量，**没问外层函数的局部量**。那些调用都在 `pic.add(new void(frame f, transform t){…})`
的匿名函数体里，于是名字漏到了文件级的函数一族上。补的是一句纯粹的"在不在"——
不走 `capOf`（那会记一条捕获、还可能发诊断，而这一层只是在判路），只扫 `L.cap.outer`。

量过 asy：`int fillrule(int)` / `int fillrule(string)` 与 `vv mk(int fillrule)` 并存时，
`mk(7)()` 印 7 —— 形参赢，而且遮住之后闭包里就取不到那一族了。
新用例 `cases/93-cap-over-arg` 把这两半都钉住。

数字：`import plain;` 136 → 126。`import graph;` 152 不动。tests/asy 167 条、
tests/run.js 91 条全绿。新用例 `cases/93-cap-over-arg`。

### 形参默认值不再拦住"当函数值用"——差别缩到"通过值调时省实参"这一格

126 里 12 条是同一族：7 条「匿名函数的形参默认值」加 5 条「把带默认值的函数当值用」。
从前这两处都是一刀切地拒，理由写的是"函数值没有默认值"。回去读了一遍参考实现之后
发现这个理由**过宽**：asy 的默认值确实跟着函数值走（`application.h:76` 的 `defaultArg`
在调用处发一个 `inst::push_default`，`runtime.in:276` 的 `pushDefault` 在**被调方**把它
换成真值），但那只影响"省了实参的调用"这一件事；把这样的函数**赋给**一个函数类型的变量、
或者拿它去接一个函数类型的槽，与默认值没有关系。

而且量过 asy：默认值那一格在**赋值**上是可以忽略的 —— 两个方向都收。
`typedef real fn(real, real); fn h = f;`（f 带默认值）通；
`void p(int x=5); p = new void(int x){…};`（不带默认值的赋给带默认值的类型）也通，
只是后来 `p()` 会在被调方拿到一个没人填的 `push_default`，那时才报
"Trying to use uninitialized value"。所以我们这一层把函数类型照**全部形参**那一份记，
默认值那一格根本不进类型文本 —— `markroutine`（`void(picture pic=currentpicture, frame f,
path g)`）与 plain_markers.asy:62 那个带默认值的匿名函数于是自然对上。

改了三处，都是把拦路的那句删掉：`asyAnonFn` 里"匿名函数的形参默认值"、`asyNameOf` 与
`asyOverArg` 里"带默认值的候选不算"。差别搬到了唯一真的做不了的那一格：`asyFnValCall`
见到"给少了"时报的不再是"要 N 个给了 M 个"那句**硬错**（asy 收这种写法，说它是错的
就是说谎），而是一句 nope，把"asy 的默认值是被调方填的、我们的是调用处用
`asyDefWrapper` 填的、通过一个值调拿不到那份包装"写在明处。新 bad 用例
`bad/fnval-default` 钉着这一格（`var g=f; g(3)` —— asy 印 5）。

还有一处要写在明处：默认值的**表达式**在匿名函数这一边被丢掉了，所以它没有被查过型。
asy 那边它留在被调方的代码里，是要编译的。等"被调方自己填默认值"那一刀做了，
这两件事一起补。

数字：`import plain;` 126 → 119。`import graph;` 152 不动。tests/asy 169 条、
tests/run.js 91 条全绿。新用例 `cases/94-fnval-default` 与 `bad/fnval-default`。

### 签名对不上的那一批：rgb(pen) / size(path[]) / rand(a,b) / tensorshade 的可选那一格

119 里 10 条「没有能匹配的签名」逐条查过去，有 6 条是 prelude 那一边的签名与参考实现
不一样，不是解析出了问题：

- `pen rgb(pen)`（runtime.in:381 → pen.h:639 `torgb()`）我们只有 `rgb(real,real,real)`。
  cmyk 那一支照 pen.h:620 抄（`sat=1-k; r=(1-c)*sat` …），GRAYSCALE 与 DEFCOLOR 两档
  都走 :591 的 `greytorgb`（`r=g=b=grey`）—— 量过 `colors(rgb(currentpen)).length` 是 3，
  DEFCOLOR 也算在那一档里。
- `int size(path[])`（runpath.in:281）是各条路径的段数之和（量过是 5）。
- `int rand(int a=0, int b=intMax)`（runmath.in:206）：asy **只有这一条**，`rand()` 走的是
  两个默认值。我们原来是零实参的 `rand()`，两条并存会让 `rand()` 变歧义，所以是**换**
  而不是加。伪随机数发生器本来就与 asy 不同（数列不同，这条差别一直在），所以用例只钉
  范围，`rand()` 那一格的返回值一个字节都没动。
- `tensorshade`（runpicture.in:230）的 `path[] b=NULL` 与 `pairarray2 *z=emptyarray`
  我们写成了必填，于是 plain_picture.asy:1398 那个 7 实参的调用接不住。
- `int system(string[])`（runtime.in:663）与 `void clear(string,int,bool=false)`
  （runsystem.in:43，调试器那一族）：签名抄准，体是 abort。

剩下 4 条各是另一回事，这一刀不动：`scaleT(transform,transform)`（plain_scaling.asy 的
那个 struct）、`search(T[],T,bool(T,T))`（对 T 泛型的内建，得像 copy/sequence 那样现生
一份 helper）、`draw(…)` 那一长串，以及 `clear(string,int)` 之外的 debugger 那一族。

数字：`import plain;` 119 → 113。`import graph;` 152 不动。tests/asy 170 条、
tests/run.js 91 条全绿。新用例 `cases/95-sig-batch`。

### 同名的变量遮住函数名：要函数类型的位置上，名字是按签名查的

`plain_picture.asy:465` 的 `userBoxX3(min.x,max.x)` 报的是「内建函数 'userBoxX3'」——
一个明明在 struct picture 体里的方法，却漏到了"这是个我们没做的内建"那一格。原因不在
调用处，在**声明**处：

```asy
private using binop=real(real, real);
void userBoxX3(real min, real max, binop m=min, binop M=max) { … }   // :428
```

默认值 `m=min` 那个 `min`，作用域里已经有一个形参 `real min` 了。asy 的名字是按**签名**
查的（`varEntry` 一个名字挂多条，各带自己的类型，由目标类型定案），所以 `real min` 与文件
级的几个 `real min(real,real)` 在同一档里共存，目标是 `binop` 时查到的是**函数** min。
我们这边一个名字只有一个类型，局部量赢了，`real` 接不上 `binop` → 默认值降不下来 →
整个方法没登上 → 裸调用一路漏到最后那句泛泛的 nope。错的话说了两次：既不是内建，
也不是"这一刀没做"。

这一刀把那条查法补上，位置在 nameOf 与 coerce 之间：nameOf 命中局部量时，如果同名还有
可见的函数候选，就把它们挂在值上（`shadowFns`）；coerce 拿到**目标类型**，是函数类型
且有同型的一份时改判成 `(fnref …)`。挂在值上而不是在 coerce 里看 AST，是因为几个调用处
传给 coerce 的 `node` 是声明子句、不是那个表达式（`stmts.js:464` 传的是 `d`），看不到
名字；挂在值上则四处共用一条：形参默认值、变量初值、赋值、return。

三条边界照 asy 定：只在类型**一模一样**时改判（不串 int→real 那种）；排在用户自定义
`operator cast` **之前**（那边精确匹配得分更高）；挑不出同型的一份就当这一条不存在，
报原来那句「要 X，这里是 Y」——它是真错误，不是"还没做"。

`userBoxY3` / `userBoxZ3` 是同一格，一并通了。剩下 3 条「内建函数」不是这一格：
`fitter`（函数类型的 **static 字段**裸调用，plain_picture.asy:884）、`out` ×2
（匿名函数体里调外层 struct 的方法，要捕获 `this`）。

数字：`import plain;` 113 → 111。`import graph;` 152 不动。tests/asy 171 条、
tests/run.js 91 条全绿。新用例 `cases/96-shadow-fnty`。

### 字符串与数之间那四对显式转换：解析器写在 asy 这一侧

`builtin.cc:365-372` 一共八条：`(string) int/real/pair/triple` 与
`(int)/(real)/(pair)/(triple) string`。前四条是 `castop.h:39` 的 `stringCast<T>` ——
`precision(DBL_DIG)` 之后 `<<`，也就是 15 位有效数字，与 `write` 用的是同一份格式，
所以这一层直接复用 `asyFmtStr`（`(string) pair` 只是把 `asyCast` 里那张白名单从
int/real 扩到 int/real/pair/triple）。量过 `(string)((1/3,2/7))` 与 `write((1/3,2/7))`
逐字节相同。

后四条是 `castop.h:48` 的 `castString<T>`，走 `lexical.h:14` 的 `lexical::cast`：
`istringstream >> value`，之后要 `(is >> ws).eof()` —— 前后的空白可以有，别的字符一个
都不许剩。这一格**没有**做成核心方言的新算符，而是把解析器用 asy 写在
`stage0/lib/asy/asy_builtins.asy` 里（`real operator ecast(string)` 那一族）。理由：
加一条 `(sreal E)` 要动 OIR 加四个消费方（interp / js / c / llvm 各一份宿主符号），
而 `strtod` 这件事**能在这一层做到位**——

- 尾数按整数精确累加（超过 2^53 就 abort），10 的幂只用 0..22 这一段（`10^22 = 2^22·5^22`，
  `5^22 < 2^53`，在 double 里精确）。于是"精确的尾数 × 一次精确的 10^k"是**一次** IEEE
  运算，与 strtod 的正确舍入是同一个答案。用例里 `(real)((string) (1/3)) == 1/3` 钉着这条。
- 出了那一段（有效数字超 2^53、或 `|净指数| > 22`）要正确舍入就得做长除法：这一刀
  **不做**，当场 abort 并把边界写在消息里。`(real) "0x10"`（C++11 的 `>>` 收十六进制
  浮点，asy 给 16）同样不收。

pair / triple 那两条照 `pair.h:208` / `triple.h:310` 的 `operator >>`：括号可选，分量之间
是逗号**或**空白，无括号的 pair 可以只给 x（`(pair) "1"` 是 `(1,0)`）。逐条量过 20 种写法
（含 `(pair) "1 2"`、`(pair) "(1)"`、`(triple) "1"` 这三种**转不动**的 —— `triple` 那条是
它 peek 到 eof 就置了 failbit）。边界：逗号与空白**混着**写的那种（`(triple) "(1,2 3)"`，
asy 收）这一刀不收，一次只按一种切。

还有一处差别写在明处：asy 转不动时 push 的是 `Default`，那一格**用起来**才报
"Trying to use uninitialized value" 并退 1；这一层没有 Default，所以是**当场** abort ——
"转坏了但没用到"在 asy 那边不响，在这里响。

数字：`import plain;` 111 → 103。`import graph;` 152 不动。tests/asy 172 条、
tests/run.js 91 条全绿。新用例 `cases/97-str-cast`。

### `string s = stdin;`：从 file 读一个词是一条**隐式**转换

`builtin.cc:494-497` 在 `addUnorderedOps<T>` 里给每个 T 挂了四条
`addCast(ve, t, primFile(), read<T>)` —— T、T[]、T[][]、T[][][]。所以 asy 里
`string s=stdin;` 不是什么特殊语法，就是 file → string 的隐式转换，读一个词；
`plain_debugger.asy:6` 的 `string[] source=input(name)` 是同一条的数组版。

这一层的 file 只有 stdin/stdout 两个句柄、没有真的读，所以在 prelude 里按签名补上
`T operator cast(file)`（int/real/string/bool/pair/triple 与它们的一维数组），体是
abort。少了这几条签名，`return stdin;` / `w=stdin;` / `s += f+'\n'` 那几句根本降不下来 ——
补上之后它们各自落回自己真正的那一格（读了才响）。

顺带清掉的是同一条造成的连带错：`plain_strings.asy:13`（return）、`:154`（`file+string`
里的左操作数）、`:223`（赋值）、`plain_debugger.asy:6`（数组初值）。

数字：`import plain;` 103 → 99。`import graph;` 152 不动。tests/asy 173 条、
tests/run.js 91 条全绿。新用例 `cases/98-file-read-cast`（只声明不调用 —— 调了就该
abort，那不是这一条要钉的东西）。

### 同一层里重新声明同名的变量：asy 收，我们原来拒

量过 `int x=1; int x=2; write(x);` 在真 asy 那边印 2 —— 它是**新开一格**、把旧的那格
遮住，不是"已经声明过了"。我们原来在 `declare` 那里一律报错，于是 plain 里三处这么写的
地方（`plain_arrows.asy:70/112` 的 `path left=rotate(-angle*factor,x)*r;`、
`plain_filldraw.asy:28` 的 `real t=dirtime(g,dir);`）整段函数掉在地上。这是"比 asy 少
接受一门语言"的那种错，得改。

这一层没有"同名两格"的表示（`(var 名字)` 就是那个名字），所以类型相同时**复用同一格**，
把后一句降成 `(set 名字 初值)`：旧那一格从这一句起再也用名字取不到，而捕获是按值抓的
（`(cap …)` 在 mkclo 那一刻就抄了一份），所以看不出差别。没写初值也照发 —— 上游那几支
已经把"新声明该有的值"算好了（标量的零值 / 记录的 `new` / 函数值的 `(null T)`），
用例里 `S s; s.n=5; S s;` 之后 `s.n` 是 0 就是钉这一条。

类型**不同**的那一格（`int x=1; string x="a";`，asy 收）要真的改名，而名字的用处遍布
nameOf / dotQual / 赋值 / 捕获 —— 那是另一刀，`bad/redeclare-othertype` 钉着。

数字：`import plain;` 99 不动 —— 这三处原先是"整段函数掉在地上"，通了之后露出它们里面
本来就有的三条（`plain_filldraw.asy:41` 的字符串 reverse、`plain_arrows.asy:122` 的 `..`、
`:73` 的 `&`）。这一刀换掉的是**错的那三条理由**。tests/asy 175 条、tests/run.js 91 条
全绿。新用例 `cases/99-redeclare`、`bad/redeclare-othertype`。

### 函数体里的**具名**函数抓外层的局部量：与匿名函数共用一副零件

`localFun`（第四十六刀）把函数体里的函数声明降成一个顶层函数，抓外层局部量那一档是一句
nope。可 base 里就有四处这么写：`plain_picture.asy:979` 的 `drawAll` 抓 `oldnodes`、
`plain_pens.asy:333` 的 `value` 抓 `offset`、`plain_scaling.asy:61` 的 `dominator` 抓
`NONE`、`plain_markers.asy:64` 的 `add` 抓 `g`。

这一刀不新造机器：`asyAnonFn` 里造闭包那一段抽成 `asyCloFrom(L, n, ret, ps, 体)`，
匿名函数与具名的这一条共用 —— 两者的差别只在"造好的那个闭包绑在哪儿"。具名的这条绑在一个
**同名的局部量**上（`(let 名字 <fnty> (mkclo …))`），于是后面 `add(1)` 那句走的是
"局部量是函数类型就 callfn"那一条现成的路，调用侧一行没改。

四条边界，都是"函数值没有那一格"的直接后果：形参**默认值**（与 anonFn 同一条）、
**可变形参**、**重载**（一个名字只有一格；同名再声明走"重新声明"那条）、以及**递归**
（名字是体降完才绑上的，体里提到自己会落到"未声明的变量"，所以先扫一遍把理由说准）。
第五条是"已经在闭包里了"——`plain_markers.asy:64` 正在这一格上，套一层的捕获是另一刀。

数字：`import plain;` 99 → 98（`plain_picture.asy:979` 那处通了；另外三处各自露出下一条
真正的理由 —— `byteinv` 没有、`..` 没有、抓的是"闭包之后还会被改"的名字）。
`import graph;` 152 不动。tests/asy 176 条、tests/run.js 91 条全绿。
新用例 `cases/100-local-fn-capture`（含"不抓外层"那条老路的回归）。

### 同名的变量声明在后面时，同名的**函数**还是看得见的

`plain_arrows.asy:337` 的 `arrowbar EndArrow(…)=Arrow;` 报的是「'Arrow' 在这里还不是一个
变量 —— 文件级的 Arrow 声明在后面」。理由指错了地方：那个 `Arrow` 要的是 `:325` 的**函数**
Arrow，而同名的**变量**（`:443` 的 `Arrow=Arrow()`）确实在后面。asy 里变量与函数在同一档里
按签名分，顺序解析只挡住那个变量，挡不住早就声明了的函数。

改一行：`nameOf` 里那句 `if (L.globals.has(nm)) return L.gvarLate(…)` 加一个条件 ——
同名的可见函数候选为空时才报"还不是一个变量"，有就往下走到"裸函数名当值用"那一档
（单候选直接 `(fnref …)`，多候选交给 coerce 按目标类型定案）。顺序解析这条纪律没松：
`gvarLate` 那句对**变量**照旧。

顺带说清 asy 自己的边界（量过）：默认值里引用后面才声明的**变量**，asy 那边照样报
"no matching variable of name" —— 所以这一刀补的不是"放宽顺序"，只是"别把函数也一起挡了"。

数字：`import plain;` 98 → 95（Arrow / ArcArrow / Bar 三处）。`import graph;` 152 不动。
tests/asy 177 条、tests/run.js 91 条全绿。新用例
`cases/101-fn-before-samename-var`（含重载集那一支）。

### 数组与标量的算术：逐元素那一族，以及 `int[] → real[]`

`builtin.cc:454` 的 `addOps<T,op>` 每个算符挂**四份**：(标量,标量)、(标量,数组)、
(数组,标量)、(数组,数组)。`addBasicOps` 给 `+ -`、`times` 给 `*`、非整数的还有 `/`，
int 另有 `% #`（`:749-751`），一元的 `-` 也有数组那一份。plain 里五处在等它：
`plain.asy:153` 的 `n+sequence(m-n+1)`、`:159` 的 `n+skip*sequence(…)`、`:203` 的
`a+sequence(n+1)/n*(b-a)`、`plain_Label.asy:33` 的 `u/sqrt(norm2)`、
`plain_prethree.asy:138` 的 `abs(c-target)`。

写在 prelude 里（int/real/pair/triple 各一套，一行一条），因为它们就是普通的
`operator` 重载 —— 这一层的算符重载（第四十刀）本来就能声明数组类型的形参，前端一行没改。
长度不等时照抄 asy 那句 `operation attempted on arrays of different lengths: 2 != 1`。

同一族里还有一条**隐式**转换 `int[] → real[]`（`arrayToArray`）：`sequence(n+1)/n` 得先
变成 `real[] / real` 才落得下去（整数那一套里没有 `/`）。`int[][] → real[][]` 一并补上。

两处缺着，都是"少接不多接"：`real[] % real`（这一层的 real 上还没有 `%`，asy 那边是
`mathop.h` 的 portableMod，`plain_pens.asy:291` 也在等它）、以及二维数组那几条
（`addOpArray2` / `addArray2Op`）。

数字：`import plain;` 95 → 92。`import graph;` 152 不动。tests/asy 178 条、
tests/run.js 91 条全绿。新用例 `cases/102-array-scalar-ops`（20 行逐条与真 asy 逐字节比）。

### real 上的 `%`：portableMod，符号跟着除数

`mathop.h:244` 的 `mod<T>` 走 `mod.h:21` 的 `portableMod`：先 `fmod`，"符号不跟着除数"时
再加一个除数。量过 asy：`7.5%2=1.5`、`-7.5%2=0.5`、`7.5%-2=-0.5`。int 那一份
（`asy__mod`，第几刀那会儿就有了）本来就是同一条规则，所以这一刀只是照它再写一份 real 的
helper `asy__rmod`，`%` 那个分支从"real 上还没做"改成分派到它。

`plain_pens.asy:291` 的 `real H=(h % 360)/60;` 在等它；补上之后 `real[] % real`
（上一刀留着的那格）也一并落地。

顺带纠正一处错的诊断：`plain_pens.asy:365` 的 `a /= p.length` 原先报「int 上的 `/=`」——
其实那是 `real[] /= int`，上一刀的数组算术通了之后它自己就好了。asy 那边**真的**拒
`int x=5; x/=2;`（量过：cannot convert 'real' to 'int' in assignment），那句诊断本身没错，
只是当时贴在了不该贴的地方。

数字：`import plain;` 92 → 91。`import graph;` 152 不动。tests/asy 179 条、
tests/run.js 91 条全绿。新用例 `cases/103-real-mod`。

### 字节与十六进制那四个，以及双引号串里的反斜杠

`plain_pens.asy:333` 的 `rgb("#ff8000")` 走的是 `byteinv(hex(substr(s,2i+offset,2)))`，
一句话要 `byteinv` 与 `hex` 两个。四个一起补了：`byte`/`byteinv` 是 `runtime.in:446/451`
转手 `pen.h:143/150`，`hex`/`ascii` 是 `runstring.in:430/441`。全写在 asy 这一侧的 prelude
里，前端一行没动。

`byte` 是 `x<0 ? 0 : min((int)(x*256), 255)`；`byteinv` 是 `(unsigned char)x` 之后
`i==255 ? 1 : i/256`——所以 `byteinv(300)` 不是 1 而是 `44/256 = 0.171875`（300 截成
一个字节是 44），`byteinv(-3)` 是 0。这两格量过才写对。

顺手补上 `downcase`/`upcase`（`runstring.in:201/207`）：`hex` 要它来收 `"1A"`。这一层
没有“一个字节”这一格，按 ASCII 那 26 对换，别的字符原样过（C locale 的 `tolower` 也是
这样）。

真正卡了一下的是 `ascii` 的查表串。asy 的**双引号**串**不**处理 `\\`：量过
`length("a\\b")` 两边都是 4，那串里是**两个**反斜杠。所以第一版的可见字符表长 96 而
不是 95，`ascii("a")` 给出 98（asy 是 97）——反斜杠之后整段都错了一位。单引号串才按
C 那套转义，改成 `"…Z[" + '\\' + "]^_`…"` 之后 21 行探针与 asy 逐字节相同。

还有一处顺序：prelude 是按行可见的，`hex` 用的 `asy__skipws` 声明在文件后半段，所以
这四个函数得挪到那一段之后。

数字：`import plain;` 91 → 90。`import graph;` 152 → 150。tests/asy 180 条、
tests/run.js 91 条全绿。新用例 `cases/104-byte-hex`。

### struct 体里那句 `operator init(…)`：换一份构造，跑在**同一个**对象上

`plain_prethree.asy:195/201` 的 `light` 是这么写的：一份构造的体里直接调另一份
`operator init(…)`。原来这一句掉进「调用一个不是普通名字的东西」——`plainName` 见到
`operator ` 开头就回 null。

要紧的是它的语义。量过：`void operator init(int a)` 的体里调 `operator init(a, a+1)`，
之后那个对象的两个字段是 3 与 4 —— 改的是**同一格**，不是"再造一个对象扔掉"。我们的
构造函数降出来是两层（`asy__ctor_X` 造对象、调正文、回对象；`<sym>_body` 带 `this`、
回 void，见 asyMethod），所以这一句要调的是**里层**那个 `_body`，`this` 就是当前对象。

落法：`asyApplyCall` 多一个 `reinit` 旗子 —— 挑候选、隐式转换、命名实参、可变形参一条
不改，只有最后发调用那一句换成 `<sym>_body` 且结果类型是 void。缺实参那一档
（`asyDefWrapper`）也多这一个旗子：这时候对象**已经在手**，包装长得跟普通方法的包装
一样（`this` 是形参，不是本地量），只是调进去的是 `_body`。包装名顺手过一遍
"只留标识符字符"—— `operator init` 带空格，原样拼出来不是个名字。

这一句在**普通方法**体里也通（量过 `v.twice()` 里调 `operator init(a*2, …)` 把 v 改成
2/202/q!），所以这一档挂在 `L.self !== null` 上，不是"只有构造函数里"。

数字：`import plain;` 90 不动，`import graph;` 150 不动 —— 那两处的诊断换成了下一层的
问题（`array(int,pen)` 这个内建还没有；`:201` 要的是"跳过带默认值的形参、落进可变那一
格"，那是下一刀）。tests/asy 181 条、tests/run.js 91 条全绿。新用例 `cases/105-reinit`。

### 可变形参那一格：`... a` 不必写在最后，跳过默认值的实参也能落进包里

`plain_prethree.asy:201` 的 `operator init(diffuse,specular,background,(x,y,z))` 要匹配
`light(pen,pen,pen,real specularfactor=1, ... triple[] position)`：那个 triple 接不住
`real specularfactor`，得**跳过**它（它有默认值）落进可变那一格的包里。原来 `asyFit` 在
这一步写着「跳到可变那一格上：这一刀先不掺」，直接判这个候选接不住。

顺着量了一遍 asy 的填法（`int f(int a=1, int b=2 ... int[] xs)`）：
- `f(... new int[]{5,6})` 印 131 —— `... a` 写在第一格上照样是给可变那一格的，a、b 走默认值。
- `f(7, ... new int[]{5,6})` 印 731、`f(b=3, ... new int[]{5,6})` 印 141。
- `f(... a, 7)` 那边是**语法错**（"unnamed argument after rest argument"），所以 spread
  之后不会再有位置实参 —— 这一条省掉了"包里的顺序"那种麻烦。
- `int g(int a=1, string s="z" ... int[] xs)`：`g(9,8)` 印 17（a=9、s 走默认值、8 进包），
  `g("q",8)` 印 9（"q" 填 s、a 走默认值、8 进包）。

两处改动都在 `asyFit`：进包那一段抽成 `packCost`，然后 (1) 位置实参那一档的条件加上
`|| r.spread === true`（`... a` 不看落在第几格），(2) 跳默认值那个循环走到可变那一格上时
进包，不再 break 掉。

数字：`import plain;` 90 → 89。`import graph;` 150 不动。tests/asy 182 条、
tests/run.js 91 条全绿。新用例 `cases/106-vararg-fill`（上面量的十一行）。

### `reverse` 的五处其实是 `reverse(path)`，不是字符串的那个

`plain_arrows.asy:192/218/260/283`、`plain_filldraw.asy:41`、`plain_picture.asy:1435` 一直
报「字符串的 reverse」这条刻意的拒绝 —— 看错了：那六处的实参都是 **path**。`reverse` 这个
名字在前端的内建名单里，而 prelude 里没有 `path reverse(path)`，于是候选表是空的，一路
落到那条按名字挂的 nope 上。

补的是 prelude 里那一份，照 `path.cc:321`：结点倒着排（第 i 个取原来的 `j = len - i`）、
`pre` 与 `post` 互换、`straight` 因为挂在**左端**那个结上所以取原来第 `j-1` 段的那一格
（开路径最后一个结左边没有段，那格是 false）。闭合路径的下标是绕圈的，单独一个
`asy__nwrap`。量过：`(0,0)--(1,0)--(1,1)` 倒过来是 (1,1) (1,0) (0,0) 两段都 straight，
`(0,0)--(2,0)--(2,2)--cycle` 倒过来是 (0,0) (2,2) (2,0) 且还是 cyclic。

字符串那条拒绝**留着**（asy 按字节倒，我们的 string 是 UTF-8 字节序列），只是挪到了
"候选表里没有能接住的、而实参真是 string"这一档上 —— 不然 `reverse("abc")` 会落到
"没有能匹配 'reverse(string)'"，那句看不出是"这一刀没做"还是"asy 也没有"。

数字：`import plain;` 89 → 84（那六处里五处在 plain 的计数里）。`import graph;` 150 不动。
tests/asy 183 条、tests/run.js 91 条全绿。新用例 `cases/107-reverse-path`。

### 两个从 base 掉出来的名字：`settings.v3d` 与 `newframe`

`plain_shipout.asy:36/130` 读 `settings.v3d`，我们那份 `stage0/lib/asy/settings.asy` 里没有
它。补一行（`settings.cc:1664` 的 boolSetting，默认关）—— 那个文件的规矩是「只放
`base/plain*.asy` 真的读到的那些」，这就是又读到了一个。

`plain_picture.asy:867/892` 的 `return newframe;` 原来报「字面量 'newframe'」。它在
`camp.l:407` 是一个 **LIT**（`newPictureExp`），语义上是"一个新的空 frame"——与 `cycle`
同一条路子：词法上是字面量，语义上是绘图层的值。所以照 `ASY_CYCLE` 的办法再约定一个名字
`ASY_NEWFRAME = 'asy__newframe'`，prelude 里给出 `frame asy__newframe() { frame f; return f; }`。

差别是**它得是个函数**，不能是变量：`newframe` 每次求都要是另一个空 frame，钉成一格
全局变量的话两处 `return newframe;` 会把同一个 frame 递出去。量过 asy：两个
`frame a=newframe, b=newframe;` 里往 a 上画一笔，`empty(b)` 还是 true。

数字：`import plain;` 84 → 80（v3d 两处、newframe 两处）。`import graph;` 150 不动。
tests/asy 184 条、tests/run.js 91 条全绿。新用例 `cases/108-newframe-v3d`。

### `..`：Hobby 求解器落在 asy 这一侧，`--` 原来理解错了

`a..b..c` 的控制点是解一组线性方程来的（MetaFont 那一套，asy 在 `knot.h`/`knot.cc` 里）。
这一刀把那份代码译成 prelude 里的 asy 代码：`asy__velocity`（`knot.cc:63`，MetaPost §131）、
`asy__niceangle`/`asy__reduceangle`、`asy__thetalinear`（`ref` + `backsub`）、
`asy__thetacyclic`（`recalc` + `solveForTheta0` + `backsubCyclic`）、`asy__solvesection`、
`asy__solvecyclic`、`asy__resolve`（`curlEnds` + `controlDuplicates` + `partnerUp` +
`solveSpecified`）。张力恒为 1，所以 `alpha = beta = 1`，中间那一格的系数化简成 `1/d` 与 `2/d`。

要紧的是**表示**。asy 的 guide 是没解的规格、path 是解好的，而这一层 `guide` 就是 `path`，
所以 `struct path` 多一张 `int[] joins`：每段是 0（`--`）、1（`..`）还是 2（控制点已经定了，
照 `nodes` 里存的走）。每加一段就**把整条链重解一遍** —— 逐段解出来的控制点与整条一起解
的不一样，而 asy 是在转成 path 时一次解完的。段数与这张表对不上时（subpath / nib 那种自己
摆控制点的）一律按 2 走，所以 `transform*path` 之类不受影响。

`--` 原来理解错了：我们把它当成"钉住三等分点上的控制点"。`runtime.in:817` 的 `dashesGuide`
里写着一句 —— `a--b` 就是 `a{curl 1}..{curl 1}b`。差别在混着写的时候露出来：
`(0,0)--(1,0)..(2,1)..(3,0)--(4,0)` 里 `(1,0)` 的出向，按"钉控制点"推出来是**沿着那条直线**
（partnerUp 给一个 dir），按 curl 断点则是那一节自己解 —— asy 给的是后者（量过
`postcontrol(g,1)` 是 `(1,0.552284749830793)`，不是 `(1.55228474983079,0)`）。改成两侧各一个
curl 断点之后，`--` 那一节自己成一节、方程齐次、解出来正好是直线，与原来的形状一致。

顺带两处前端：`ASY_OPSYM` 收下 `..`（原来声明 `operator ..` 就被拒），`asyJoinExp` 把 `..`
也交给用户算符。还有一个藏了很久的洞：`asyModMerge` 里「名字带点的不并（那是记录的方法）」
把 `operator ..` 也滤掉了 —— 名字里确实有点。现在那一条只管**不是算符**的名字。

八种形状与真 asy 逐字节相同（开路径 3/4 个点、全 `..` 闭合、`--` 与 `..` 混着、
`..cycle`、重合点、单点、`--cycle`），连 `1.11022302462516e-16` 这种舍入都一样。
`precontrol`/`postcontrol` 也补进 prelude 了（钉这一刀非得有它们）。

数字：`import plain;` 80 → 77。`import graph;` 150 → 149。tests/asy 185 条、
tests/run.js 91 条全绿。新用例 `cases/109-hobby-dots`（85 行输出）。
还没做的：方向标记 `{dir}`、`controls`、`tension`、`?`——都还是明写的 nope。

### `&` 那两副面孔：路径拼接与**不短路**的 bool 与

`&` 在 asy 里是两件事。一件是 `path & path`（path.cc:1119 的 concat）：接缝那个结的
`pre` 来自左边、`point`/`post`/`straight` 来自右边，拼出来的是**已经解好**的路径 ——
`joins` 空着，每段照 nodes 里存的控制点走，不再进 Hobby 求解器。另一件是 `bool & bool`：
`&&` 短路，`&` 不短路，两边**都要算**（`f() & g()` 会把 `f`、`g` 都跑一遍）。整数没有
`&`，`5 & 3` 在真 asy 里就是 "no matching function" —— 我们照着也不给。

`p & cycle` 不是走拼接那条，它在 base 里（plain_paths.asy:240）：

```asy
return straight(p,n-1) ? subpath(p,0,n-1)--cycle :
  subpath(p,0,n-1)..controls postcontrol(p,n-1) and precontrol(p,n)..cycle;
```

也就是**末结去掉**，收口那一段接回第 0 个结。原来末段是直线，收口也是直线，控制点要按
**新的**两端重摆到三等分点；原来是曲线，末段那两个控制点原样搬过来（于是收口那一段的控制点
可能指着老远的地方 —— 真 asy 也这样，`(0,0)..(1,1)..(2,0)&cycle` 的 `precontrol(·,0)`
就是 `(2,0.552284749830793)`）。已经闭合的原样回，`n == 0`（单点）走 `p--cycle`，
`n < 0`（nullpath）回 nullpath。

顺手钉掉一个老毛病：`(5,5)--cycle` 我们原来当**没闭合**回去（`asy__join` 里那句
`nodes.length < 2` 就退）。真 asy 给的是长度 **1** 的闭合路径，两个控制点都落在这个点上，
那一段还算直线段 —— `..cycle` 也一样。解方程那套在一个结上没得解，直接摆好。

`cycleToken` 这个空 struct 只为一件事存在：让 base 里 `path operator &(path, cycleToken)`
那条声明能过。这一层的 `cycle` 是带记号的 path（见 `cyclepath`），所以那条声明永远匹配不上，
`p & cycle` 落到我们自己那份 `operator &(path, path)` 上，靠 `b.ismark` 分岔。

顺带量到一件事，记在这儿免得下次又去找：我们的 Hobby 解出来的控制点，**有些形状**跟真 asy
差 1 ulp（末位那个数字），比如 `(1,0)..(2,2)..(3,-1)` 的 `precontrol(·,2)` 我们是
`-0.131143247666052`、真 asy 是 `...053`。两条腿（`run` 与 `run-llvm`）彼此一致，所以不是
JS 的 `Math.sin` 与 libm 的差别 —— 更像是 clang 把 knot.cc 里 `-q.post*lastTheta+q.aug`
这类 `a*b+c` 收成了 FMA（默认 `-ffp-contract=fast`），一次舍入对我们的两次。要对上得在
prelude 里软实现 fma，代价与收益不成比例，先记下不做；用例挑的是不踩这一格的形状。

数字：`import plain;` 77 → 73。`import graph;` 149 → 148。tests/asy 186 条、
tests/run.js 91 条全绿。新用例 `cases/110-amp-cycle`。

### 点在不在里面：绕数、`orient`，加上三处名字解析的账

`inside(path, pair, pen)` 这一格原来是空的，于是 plain_paths.asy:303 那句
`cyclic(p) && inside(p,point(q,0),fillrule)` 接到了**外面那个** `int inside(path,path,pen)`
上（pair 靠一次 cast 变成 path），`&&` 的右边就成了 int。补法是照 path.cc 把这一族真做出来：

- `orient`（runpath.in:436 → path.cc:1150）：`detleft - detright` 那两行照抄，连 `-0` 都
  跟着（`orient((0,0),(1,0),(1,0))` 就是 `-0`；换成 `(b-a)×(c-a)` 那种等价写法会印成 `0`）。
  **明写的差别**：asy 的 det 落在误差界内时还会转去 `orient2dadapt`（Shewchuk 的自适应精确
  谓词），这一层只有第一步 —— 几乎共线的位置上符号可能差一个 ulp。
- `windingnumber(path, pair)`（path.cc:1257）：包围盒先挡一道，然后逐段走 —— 直线段进
  `checkstraight`，曲线段进 `checkcurve`（包围盒装得下就 de Casteljau 对半劈，装不下按弦算，
  深度上限是 bound.cc:15 的 `maxdepth = DBL_MANT_DIG = 53`）。点落在路径上时回**最大的奇
  整数**。`count` 那边是引用形参，这一层用一格 `int[]` 顶。
- `windingnumber(path[], pair)`（runtime.in:32）是逐条相加；`inside` 两份都照 pen.h:492 的
  `fillrule.inside` 走（evenodd 看奇偶，否则看非零）。

顺着这一刀量出 `intMax` 一直是错的：它**不是** INT64_MAX。common.h:106 在 COMPACT 下把最高
两个值留给 DefaultValue 与 Undefined，所以 `Int_MAX = INT64_MAX - 2 = 9223372036854775805`
（而 `intMin` 照旧是 INT64_MIN，不是 `-intMax-1`）。绕数那个"落在路径上"的返回值正是它。

同一刀里另外三处：

- **`? :` 两支不同型**时按用户的 `operator cast` 定案。asy 的 `? :` 是按 `T(bool,T,T)` 做
  重载解析的，允许把**一边**转过去；定案只在两支之间做，不看外面要什么 —— 量过
  `true ? (0,0) : (1,1)--(2,2)` 的类型是 guide，而 `pair z = false ? … ;` 报
  "cannot cast 'guide' to 'pair'"（新增 strict/cond-cast-branch 守这一条）。两边都能转过去
  就是歧义，照旧报"两支要同型"。
- **函数类型的局部量不整片遮住同名的函数**。asy 的 venv 是按**签名**逐层找的：
  plain_pens.asy:354 那个 `pen mean(pen[] p, real opacity(real[])=min)`，体里
  `opacity(opacity(t))` 里面那个是形参、外面那个是文件级的 `pen opacity(real,string)`。
  办法与成员那一档一样 —— 先试这一格，接不住就回滚（诊断与前置语句一起）再往下走。
- **泛型的 `array(int n, T value)`**（builtin.cc:624 → runarray.in:675 的 copyArrayValue）：
  照 copy/sequence 那个办法按元素类型现生一份 helper（`arrFillHelper`）。value 是数组时逐层
  深拷（那边默认的 depth 就是这个类型的真实深度）。第三个形参 depth 这一刀不认。
  另外补了数组上的 `abs`：`real[] abs(real[]/pair[]/triple[])`。
  **一处收多了**：`abs(int[])` 在 asy 那边是歧义（`real[](real[])` 与 `real[](pair[])` 各差
  一次 cast），我们只有 int[] → real[] 那一条，所以选中了前者。要对上得把元素上的 cast
  **抬到数组上**，那是另一刀。

数字：`import plain;` 73 → 67。`import graph;` 148 全程没动。tests/asy 188 条、
tests/run.js 91 条全绿。新用例 `cases/111-inside-array` 与 `strict/cond-cast-branch`。

### 函数名其实是一格变量：`restore = r`

asy 里 `void restore() {…}` 声明的**是一格 `void()` 类型的变量**，初值是那个函数体。所以
plain.asy 里这几句都合法：`:100` 的 `restoreThunk r=restore;`、`:106` 的 `restore=r;`、
`:113` 的 `return restore=buildRestoreThunk();`（restoredefaults 同样，`:132`/`:139`）。
save/restore 那一套就是这么搭的 —— 每次 save 把当前的 restore 存进闭包、再把 restore 换成
"还原并把旧的装回去"的那一份。我们的函数是一个没有槽的 `(fn …)`，名字上没处可写，于是这三处
一直报"未声明的变量"。

补法是照 asy 的模型来：声明遍先扫一遍这个单元里**被赋值过的裸名字**（任意深度，闭包体里也
算），凡是这样的名字又恰好只有**独一份**函数候选的，就在**那一行**另开一格文件级变量
（`asy__fs<N>_<名字>`，类型就是这个函数的类型）。函数体照旧发；填这一格的 `(set … (fnref …))`
由正文遍在函数声明那一行发出去 —— 位置是照抄的，那边这一行本来就是"声明加初值"。

不用改别处：读（nameOf）与调用（call）里 gvar 那一档都排在候选表**前面**，赋值那一档本来就
认文件级变量。重载了的名字**不给**这一格：赋的是哪一格要靠类型定案，那是另一刀。

同一刀里把"函数值那一格不整片遮住同名函数"补到另外两档上 —— 捕获进闭包的与文件级的。这两档
都有副作用或先后次序，不好"试了再回滚"，所以先按**给了几个实参**筛一遍（`asyArityBad`）。
原型是 plain.asy:125 那个 `exitfcn atupdate=atupdate();`，:130 的 `atupdate(atupdate)`
里外面那个是内建的 `void atupdate(exitfcn)`。

数字：`import plain;` 67 → 64。`import graph;` 148 没动。tests/asy 189 条、tests/run.js
91 条全绿。新用例 `cases/112-fn-name-slot`（连"一层套一层再依次还原"那个形状也钉上了）。
`plain_debugger.asy:86` 那个 `debugger` 还是报"未声明的变量" —— 它的声明用了类型 `code`，
那一格先被 nope 掉了，所以根本没有候选可以挂。

### struct 名字当值用：那一族**构造函数**

`Pair_K_V makePair(K k, V v) = Pair_K_V;`（collections/genericpair.asy:27）里右边那个
`Pair_K_V` 不是类型名，是**值** —— asy 里 struct 名字当值用就是那一族构造函数，类型是
`记录名(那份 operator init 的形参)`，是哪一份由**目标类型**定案。collections/iter.asy 的
`:42`（`autounravel Iterable_T operator cast(T[] items) = Iterable_T;`）与 `:48`
（`Iterable_T range(T[] items) = Iterable_T;`）是同一格。

落地要一个真的函数（`operator init` 的符号第一个形参是 `this`，不能直接 `(fnref …)`）。
现成的就有：`asyDefWrapper` 在 `d.ctor` 为真时生成的正是"造一个、调 init、回它"，
以前只在**缺实参**时用得上，这里拿 `missing: []` 叫它一次就是构造函数本身。
候选多于一份时回那个"不定案的重载集"记号（`over`），由 coerce 拿目标类型落地 —— 与函数名
当值用那一档同一条路。带默认值的候选不算（函数值没有默认值，同上）。

没写 `operator init` 的 struct **拿不出值**：asy 报 "no matching variable of name 'Q'"
并退 1（新增 strict/ctor-value-none 守着）—— 这一条与 `Q(…)` 那句构造调用的规矩是同一条。

数字：`import plain;` 64 → 60。`import graph;` 148 没动。tests/asy 191 条、tests/run.js
91 条全绿。新用例 `cases/113-struct-ctor-value` 与 `strict/ctor-value-none`。
collections 那一族剩下的两格是 `unravel`（把一格记录的成员摊进当前作用域）与
`for (T x : iterable)`（走 `operator iter` 那套协议）—— 各是一刀。

### `unravel x;`：摊出来的名字是**别名**，不是副本

`unravel x;` 把一格记录的成员摊进当前作用域（`collections/iter.asy:17` 的 `unravel retv;`、
`plain.asy:172` 同样）。要紧的是它**不是复制**：量过 asy 那边写 `a = 7;` 改的正是 `x.a`，
调 `f(2)` 调的正是 `x.f`。所以落法不是"新开几格再抄回去"，而是在作用域里记一条**别名**：
`declareAlias(名字, 类型, 接收者代码, 字段)` 让 `lookup` 查得到类型，另存一张
`\0al:名字 -> {recv, rty, field}`；名字解析（`asyNameOf`）、调用（`asyCall` 的函数值那支）、
赋值（`asyAssign`）三处各问一句 `aliasOf`，问着了就换成 `(fld 接收者 字段)` / 走 `asyAssignFld`。
这一句本身**发不出任何语句**（回 `[]`）—— 它只改作用域。

文件级那一份要绕一下：`unravel` 的头在 `ASY_MODSTM` 里，文件级它先落到 `asyModStmt`，
而**那一遍还没登记文件级变量**（`asyGlobalNames` 在下一个循环里），判不出 x 是不是一格记录。
于是 `asyModStmt` 见到 `unravel` 一律放过（回 `null`），改由正文那一遍的 `asyStmt` 收 ——
摊出来的别名也正好进正文那一层作用域，报错也只报这一处（`bad/mod-unravel` 的话术随之改成
"这一刀只摊一格记录变量的字段，摊模块还没做"）。

这一刀只摊**字段**，包括"没有体的方法声明"那种函数类型的字段 —— `iter.asy` 要的正是它。
摊**有体的方法**要一格绑好接收者的闭包（我们的方法是多一个 this 形参的普通函数，没有那一格），
与"给方法赋值"是同一笔账，留着。

顺带量出来一条：`unravel` 单独**并没有**解开 `collections/iter.asy`。那边 `unravel retv;` 之后
是 `advance = new void() { ++index; };` —— 闭包里改外层的 `index`。asy 的捕获是**按引用**的，
而 `(mkclo …)` 按值抓一次，所以这里照旧报"捕获会被改的外层变量"。那一刀要给被捕获且被改的
局部量装箱，是 for-each 那一族的真正前提。

数字：`import plain;` 60 → 60（`语句 'unravel'` 那 4 条换成了它后面那几条 —— `'index'` 的
按引用捕获与几处字段赋值，深了一层但没少）。`import graph;` 148 没动。tests/asy 192 条、
tests/run.js 91 条全绿。新用例 `cases/114-unravel-var`（字段别名、函数类型字段、写穿回去、
文件级那一份），`bad/mod-unravel` 的期望跟着改了话术。

### 按引用捕获：把那一格**装箱**

asy 的捕获是按引用的（量过 `int m=n; int h(int)=new int(int x){return x+m;}; m=99;`
之后 `h(1)` 是 100），而 `(mkclo …)` 是按值抓一次。上一刀之前这条差别是靠**拒绝**收窄的
（`bad/anon-capref`）；这一刀把它做出来：会被闭包抓走、而且还会被改的那一格**装箱** ——
一格长度 1 的数组（`(anew (arr T) (int 1))`），读是 `(aget (var 箱) (int 0))`、写是
`(aset (var 箱) (int 0) …)`，闭包抓走的是**那个数组**。数组在核心方言里是引用语义，
于是闭包里外看见的是同一格 —— 这就是按引用捕获，五条后端腿一句都不用改。

装不装箱由一遍**扫体**定（`needsBox`）：这个函数体里某个闭包用了这个名字，而
(a) 那个闭包自己改它，或 (b) 它在那个闭包**之后**还会被改 —— 这两种正是"按值抓"给出旧值的
两种，判据与原来 `capOf` 里那句拒绝**同一条**，所以装了箱的名字在 `capOf` 里就不再报了。
改在闭包**之前**的那种不装箱：抓的时候已经是最新的那一份，两种语义同一个结果
（`plain_picture.asy:1294` 就是这一格）—— 这样绝大多数闭包发出来的代码一个字都没变。

"闭包"算两种：匿名函数字面量，与**函数体里的具名函数**（`fundec`，那一支也降成
`cfn`+`mkclo`，见 `localFunClo`）。形参也装箱，只是没有"声明那一句"可以改，于是那两句发在
**体的最前面**（`boxParams`：先照旧收下形参，再抄进箱子）—— `plain_arrows.asy:245` 的
`position position=EndPoint` 正是这一格：闭包抓了它，函数后面又给它赋值。

箱子的名字（`asy__bx<n>_<名字>`）与源码里那个名字**故意不同**：漏改的读写路径会去引用一个
没声明的名字，核心方言那边当场报，而不是悄悄读到旧值。要改的读写路径一共五处：`nameOf`、
`dotQual`、`unravel` 的接收者、`assign`（变量那一支与"闭包里改外层"那一支）、`vardec`。
顺带把 `assignFld` 的体抽成了 `slotAssign(cur, put)` —— 复合赋值与自增那一整套规矩
（用户算符、pair/triple、`#= %= ^= /=`）字段与箱子共用一份，不再抄两遍。

数字：`import plain;` 60 → 55（`'index'` 那 3 条与两条"捕获会被改"清了）。`import graph;`
148 没动。tests/asy 192 条、tests/run.js 91 条全绿。`bad/anon-capref` 这条边界**取消**了，
改成 `cases/115-capture-byref`（改在闭包后、闭包自己改、具名嵌套函数、复合赋值、形参两种、
`iter.asy` 那个三闭包共用一格 index 的形状），输出与 `asy -noV` 逐字节一致。

### `for (T x : 可迭代的东西)`：`operator iter` 那套协议

asy 的 for-each 不只吃数组。判据在 `stm.cc:473`：**`set.operator iter()` 查得通吗**；通就摊成
（`stm.cc:512`）

    for (var i = set.operator iter(); i.valid(); i.advance()) { T x = i.get(); body }

照抄这一条：`operator iter` 只在 init 里求**一次**，`advance()` 那一句进 `L.updates`
（与数组那一路的 `++i` 同一个位置，于是 `continue` 也先走 advance），`get()` 的返回类型就是
`var` 那一档推出来的元素类型。四个名字缺一个就退回原来那句"for-each 要一个数组"
（新增 `strict/foreach-noiter` 钉着：asy 那边也拒，报 "cannot cast 'Q' to 'int[]'" 退 1）。

这一刀只认**函数类型的字段**那种 iter/get/valid/advance —— 也就是"没有体的方法声明"
（`collections/iter.asy:26` 的 `Iter_T operator iter();`、`map.asy:34` 同样，Iter_T 的
get/advance/valid 也都是），发出来是 `(callfn (fld 接收者 字段))`。有体的方法要走 `applyCall`，
而那条路会往 `L.pre` 里绑临时量，摆在循环外面就错了（`btreegeneral.asy:167` 是那一种，
不在 plain/graph 的路上）。

带出来一件必须一起做的事：`operator iter` 这个**字段名带空格**，核心方言的字段名不收
（`(class Iterable_T (operator iter …))` 当场报"一个字段是 (名字 类型)"）。于是加了一层
`asyFldSym`：算符名的字段发代码时换成 `asy__opf…`，前端自己那张表照旧按源码里的名字记 ——
查名字的都是源码里那个名字。要换的地方一共九处：`(class …)` 的字段表、字段默认值那两句
`fldset`、`nameOf`/`dotQual`/`selfField` 的读、字段赋值的 `slotAssign`、方法值与别名那三处
`fnValCall`。

数字：`import plain;` 55 → 50（`Iterable_T`/`Map_K_V` 上的 6 条 for-each 清了）。
`import graph;` 148 没动。tests/asy 194 条、tests/run.js 91 条全绿。新用例
`cases/116-foreach-iter`（写死类型、`var`、`continue`、`break` 四种，输出与 `asy -noV`
逐字节一致）与 `strict/foreach-noiter`。

### 笔、路径、变换、二维数组的**文字**形

`write(file, …)` 那一族缺了四种类型，而 base 里 `Label.write`、`write(pen[])`、
`write(guide[])`、`transform3` 都点名要它们。四份格式都是从参考实现里抄的、再用
`asy -noV` 逐字节量过：

- 笔（`pen.h:869`）：`(` + 虚线表或 `default` + 各项 `, 名=值` + `)`。项只在**不等于
  默认值**时印，判据就是各字段自己的默认值（linewidth 0.5、linecap/linejoin 1、
  miterlimit 10、fontsize/lineskip 0、fillrule/baseline 0）。数是裸 ostream 出来的，
  所以是 6 位有效数字（`ps()`，与 EPS 那一路同一档），不是 `write(real)` 的 15 位。
- 路径（`path.cc:1098`）：直段 `--`、曲段 `.. controls c0 and c1` 后面跟**换行加一个空格**
  再 `..`；空路径是 `<nullpath>`；坐标是 15 位。
- 变换：六个分量 `(x,y,xx,xy,yx,yy)`。
- `real[][]`：行内制表符、**每行末尾**一个换行。

为此给 pen 补了 `fontsizeset` / `lineskipval` 两格（`pen.h:167/168` 那两格**原样**：
没设过就是 0，印的时候才分得出"设过 9 号字"与"默认"）——原来 `fontsize()` 是拿 `font`
那一格当标记用的，现在还回去了。`pencopy` 与 `operator +` 跟着补齐：加法里"q 设过就盖住 p"
的判据照 `pen.h:790` 那一串，dash/font/fontsize/lineskip/cap/join/miter/fillrule/baseline
都算上了。颜色这一格仍是"盖住"而不是 asy 的**相加再夹**（`pen.h:749`），两支都带颜色时
结果不一样，写在明处。笔尖 `path=`、`pattern=`、`overwrite=`、`transform=` 这四项还印不出来。

数字：`import plain;` 50 → 47。`import graph;` 148 没动。tests/asy 195 条、tests/run.js
91 条全绿。新用例 `cases/117-write-text`（四种类型共 18 行，与 `asy -noV` 逐字节一致）；
`strict/string-bool` 的话术跟着改了（现在有 `string(pen)`/`string(path)`/`string(transform)`
三份用户重载，报的是"没有能匹配 string(bool) 的签名"—— 拒还是拒）。

### `code` 与 `quote{ … }`：先立一格**空壳**

`plain_debugger.asy` 一进来就要 `code`：`typedef string bpfunction(string, int, int, code)`
（:13）、`stop(...)` 的 `code s=quote{}`（:16）、`atbreakpoint(...)`（:86）。参考实现里
`code` 是内建类型（`runsystem.in:10` 的 `runnable* => primCode()`），`quote{ … }` 把花括号里
那段**语法**原样拎出来，`_eval(code)` 再拿去跑。这一层做不到"拎出来"—— 前端到 OIR 的
那一步已经把块降成核心方言了，留不下 AST。

所以这一刀只做**类型层**：prelude 里 `struct code { }` 一格空壳，`quote-exp` 直接降成
`(recinit code)` —— 花括号里那段**扔掉**；`_eval(code, bool, bool)` 里 `abort`。这样
`code` 能当变量、参数、返回值、数组元素、默认实参传来传去，唯独跑不动。
`atbreakpoint` 的签名照 `runsystem.in:132` + `:37` 那个 `breakpointFunction()` 修正成
`string(string, int, int, code)`（之前错写成 `void()`）；`breakpoint(code s=quote{})`、
`stop(string, int, code s=quote{})`、`breakpoints()`、`clear()`（`runsystem.in:137/147/155`）
四支照原型补齐，体内 `abort`。

把"编译得过、跑起来才炸"当成一档：base 里这一族只在真开调试器时才走到，挡在类型检查
这一关上反而把整个 `plain` 卡住。代价是 `quote{}` 现在是**静默**丢块 —— 谁真去
`_eval` 才看得见，看见的是一句 abort 而不是"没实现"的编译期拒绝。

数字：`import plain;` 47 → 43（`plain_debugger.asy` 那一族清空）。`import graph;` 148
没动。tests/asy 196 条、tests/run.js 91 条全绿。新用例 `cases/118-code-quote`
（六行输出，与 `asy -noV` 逐字节一致）。

### 名字后面的维度、六分量的变换，以及嵌套 struct 认得自己

四个各自独立的小口子，凑成一刀是因为它们各只值一两行：

- **维度挂在名字后面**。`void f(real x[])` 与 `real[] x` 是同一件事（量过一模一样），
  `struct S { real x[]; }`、`... object inset[]`（plain_Label.asy:577 的 `pack`）
  也一样。文件级 `real a[];` 这一条本来就有，缺的只是形参表与字段那两处：两边都
  按 `dimsDepth` 往类型上叠 `[]`。顺手把两处那句"带维度的形参名 / 带维度或形参表的
  字段名"改成"认不出的形参名 / 认不出的字段名"—— 剩下的形状才是真没做。
- **六分量字面量**。`(x,y,xx,xy,yx,yy)` 在 camp.y 里出的是一个 **transform**
  （plain_constants.asy:40 的 `zeroTransform=(0,0,0,0,0,0)`）。transform 在绘图层是
  个 struct，所以这里跟 `cycle` / `newframe` 同一条路子：约定一个名字
  （`ASY_XFORM` = `xform`，绘图层那个六参构造函数），降成对它的一次调用。
- **transform 的 `==`**。runtime.in 里它是**逐分量**比，而我们的 struct 是引用类型、
  默认的 `==` 比身份 —— 于是 base 里 `T == identity()`（plain_picture.asy:650/872/907）
  全会判错。prelude 补上 `==` / `!=` 两支。顺带补 `real identity(real)`：
  它是内建函数（builtin.cc:767/848 的 `addRealFunc`），跟 `transform identity()`
  同名不同签名，plain_picture.asy:85 的 `scaleT(identity,identity)` 要的是它。
- **嵌套 struct 的方法体里认得自己**。`bounds3 copy() { bounds3 b=new bounds3; … }`
  （plain_picture.asy:236）：嵌套那个名字原先只进**外层**记录的体内别名表，而方法体是
  后一遍才降的，那时 recAlias 已经换成了它**自己**那张。所以 recNested 现在把外层
  这一刻已声明过的体内类型连同它自己的名字一并抄进它自己那张表（bi 记 0）。

多出来的那一支 `operator ==(transform,transform)` 顺带炸出一个真 bug：`null == null`
原先靠"两边同型"那句挡住，而现在**用户写过的那一份**成了唯一候选、被挑中，`<null>`
那个空记号就漏进核心方言（跑起来是一句 "null reference"）。asy 那边报的是歧义 ——
每个 struct 都自带一份 `operator ==`，几十行候选全都能匹配；我们的 struct 没有自动
生成的那一份，所以这条得**显式**拦在用户重载之前。见 strict/null-both。

数字：`import plain;` 43 → 40。`import graph;` 148 没动。tests/asy 197 条、
tests/run.js 91 条全绿。新用例 `cases/119-dims-xform-nested`（十二行输出，与
`asy -noV` 逐字节一致）。带点的嵌套类型名（`Outer.Inner`）还是不收 —— 那是另一刀。

### 三个内建的缺口，与 stdout 那份行缓冲

- `minAfterTransform` / `maxAfterTransform`（runpath.in:338/362）：每条路径先搬一遍再取
  盒子，逐分量取最小 / 最大；空数组时 asy 报的是 `nullpath has no points`
  （path.cc:28）。这一格的诊断原先**指错了地方** —— plain_bounds.asy:316 报的是
  "内建函数 'addMinToExtremes'"，而 `addMinToExtremes` 明明在同一个 struct 里、第 312
  行刚调过；真正缺的是里层那个 `minAfterTransform`，它把实参那一格弄成了未知类型，
  于是外层那次调用连候选都数不出来。
- **static 那一格里躺着函数值**：`static frame fitter(string,picture,…);`
  （plain_picture.asy:876）是无体的 static 方法声明 —— 也就是一格 static 的函数类型字段
  （量过 `fitter == null` 是 true、`P.fitter = new …` 之后 `fitter(…)` 就通了）。
  裸名字调它是"读这一格再间接调"，跟实例那一档（`selfField`）同一个办法，只是取值
  换成 `(var 那个 static 符号)`。
- `write(x, suffix)`：asy 的内建签名是
  `void write(file file=stdout, string s="", T x, void suffix(file)=endl)` ——
  file 有默认值，**被调方**填。我们的 `write` 是前端内建的一族，那一族不收 suffix，
  所以 int/real/bool/string/pair/triple 六支得在 prelude 里显式给。
  plain_constants.asy:107 的 `write(b.value, suffix)`（bool3 那一族）是原型。

补第三条时炸出一个真 bug：stdout 那份**行缓冲**原先挂在 `file` 那一格上，而
`output()` 每次回来的是新的一格（asy 那边 `restricted file stdout=output();` 只有一个，
包的是同一个 stdout）。于是 `write(output(), "false ", none)` 那半行跟着那一格一起扔了 ——
量出来是整段没了。缓冲现在是一份模块级的 `asy__obuf`，`fd == 1` 的都往那儿攒。

留着的坎：不带 suffix 的 `write(x)` 走的是**另一条**路（前端内建降成核心方言的
`(print …)`，自带换行、不过缓冲）。同一个程序里把两条混着用，没凑满一行的那半行会
跟后面直接 print 的那句**串行**。根子是核心方言里没有"不带换行地印"这一句 ——
补它要动方言与六条腿，跟数组的 `.cyclic` 同一档，一起留着。

数字：`import plain;` 40 → 37。`import graph;` 148 没动。tests/asy 198 条、
tests/run.js 91 条全绿。新用例 `cases/120-builtin-gaps`（十三行输出，与 `asy -noV`
逐字节一致；整个文件都走带 suffix 那一路，正是为了绕开上面那道坎）。

### 算符名就是**普通名字**：当值传，也能当形参名

asy 里算符是"名字叫 `operator X` 的函数"（这条从第二十三刀起就是这一层的底子），
所以它也能出现在两个原先没铺到的位置：

- **当值传**：`maxcoords(coords, operator >=)`（plain_scaling.asy:248）。走的是裸函数名
  当值用那一条**同一条**路 —— 单个候选出 `(fnref …)`、多个候选出不定案的记号，
  由 coerce 拿目标类型落地。原先 `plainName` 见到 `operator ` 开头就回 null，于是这一格
  掉进"带点的名字或算符名"那句 nope。
- **当形参名**：`coord[] maxcoords(coord[] in, bool operator <= (coord,coord))`
  （plain_scaling.asy:41，那边源码 :43 有注释专门说这件事）。核心方言的符号得是个
  标识符，所以形参名过一遍 `asyFldSym`（`operator <=` -> `asy__opfx60x61`）——
  原先它**原样**漏进方言，`(fn pick ((in …) (operator <= …)) …)` 那一句在方言那边就散了。

第二条不补的话第一条会变成一个**不报错的错答案**：`maxcoords(coords, operator >=)`
编得过，而体里的 `a <= b` 还是去调文件级那份 `operator <=`，于是 m 与 M 算成同一个。
所以 `asyOpUser` 现在先问一句局部/形参那一格（按 `asyFldSym` 的拼法查），
有就走间接调用 —— 它遮住文件级同名的算符，与别的局部量遮住同名函数是同一条规矩。

数字：`import plain;` 37 → 36。`import graph;` 148 没动。tests/asy 199 条、
tests/run.js 91 条全绿。新用例 `cases/121-operator-name-value`（六行输出，与 `asy -noV`
逐字节一致；里头那两句 `cmp le = operator <=;` 与 `int f(int,int) = operator ^;`
量的正是"重载集靠目标类型定案"）。

### 闭包套闭包：抓不到就往上问一层

原先"匿名函数里再套一个匿名函数"是一句 nope，理由是「里层要抓的可能是外层的**捕获**，
而捕获不是局部量」。现在 `L.cap` 上多了一条 `prev`（指向外面那一层闭包），
`asyCapOf` 找不着名字时顺着它往上问一层：外层于是也跟着抓一格，回来的 `code` 就是
"在**外层那一帧**里怎么读它"，正好当里层这一格的取值 —— `(mkclo …)` 本来就是在外层
体里发的。所以捕获项从"名字 + 类型"变成"名字 + 类型 + **在定义那一帧里的读法**"
（外层是普通函数体时还是 `(var 名)`，外层也是闭包时是 `(cap 名)`）。

装了箱的那一格要**整个箱子**往下传，不是箱子里的值 —— 不然穿两层之后就变回按值抓了。

顺带松开两条原来靠"已经在闭包里"挡着的边界：

- **闭包体里的局部量也能装箱**。`asyNeedsBox` 原先见到 `L.cap !== null` 直接回 false，
  因为那时 `L.fnBody` 还是**外层函数**的体，"里层还有函数会改它"这一问问错了段。
  现在 `asyCloFrom` 把 `L.fnBody` 换成这个闭包自己的体，那一问就问对了。原型是
  plain.asy:173 的 `Iter_int`：`int index = n;` 在一个匿名函数体里，而里层三个匿名函数
  （`advance` / `get` / `valid`）都改它 —— 装箱之后三个看见的是同一格。
- **函数体里的具名函数**（`localFunClo`，也降成 cfn+mkclo）在闭包里也能抓外层的局部量。

还留着的：闭包里那个具名函数**自己递归**（plain_markers.asy:64 的 `add`）——
名字是体降完才绑上的，递归得先有那一格，是另一刀。

数字：`import plain;` 36 → 34。`import graph;` 148 没动。tests/asy 200 条、
tests/run.js 91 条全绿。新用例 `cases/122-nested-closures`（七行输出，与 `asy -noV`
逐字节一致：两层与三层的 `int(int)(int)`、穿层抓形参、闭包里装箱穿两层、
以及闭包里的具名函数抓外层）。

### 算符名的元数不限，与连接里那几个规格的类型

上一刀把算符名当值传通了，这一刀量出来它还差三处，全是同一件事的不同侧面：
**`operator X` 在 asy 里只是个名字**，跟 `foo` 没有区别。

第一处是**元数**。这一层原来钉着"算符只有一元与二元"，量下来 asy 根本不管：

```asy
int operator +(int a, int b, int c) { return a+b+c; }
write(operator +(1,2,3));          // 印 6
int operator ..(int a) { return a*2; }
write(operator ..(5));             // 印 10
```

两行都通。一元/二元那条限制是**表达式形态**上的 —— `a + b` 只会去找两个槽的那份候选，
`operator +(1,2,3)` 直呼时按三个槽找。所以那两句 nope（decls.js 的 asySig 与 asyMethod）
是我们比 asy 多拒了一门语言，删掉。内建的 `operator tension(real,real,bool)`
（runtime.in:885）本身就是三元，不删这一句 plain 连第 14 行都过不去。

第二处是**直呼**。`plainName` 对 `operator …` 回 null（它不是标识符），调用那一档于是
落到"调一个不是普通名字的东西"。补一档自己认：先问一格同名的局部/形参（形参名也能是
算符名，上一刀那条），再问文件级的重载表，再问一格模块级变量。

第三处是**当模块级变量的名字**。`interpolate operator ::=operator ..(operator tension(1,true));`
（plain_paths.asy:129）声明的是一格叫 `operator ::` 的变量，符号名原来直接拼成
`asy__g7_operator ::` —— 那不是标识符。过一遍 asyFldSym（第四十三刀给字段用的那个）
就行，表里的键还是源码里那个名字。`::` 与 `---` 也顺手进了 ASY_OPSYM：camp.y 的
basicjoin 里它们是**另外两个连接符**，跟 `..` 平级。

顺带修掉一个真错：匿名函数的类型里**丢了可变形参那一格**。`new guide(... guide[] a)`
原来记成 `guide(guide[])`，于是接不上 `typedef guide interpolate(... guide[])`
（plain_paths.asy:3/120）。asyCloFrom 里 `pts.push(p.type)` 改成看 `p.rest`。

绘图层这边立起 `tensionSpecifier` / `curlSpecifier` 两个 struct（primitives.h:36/37 是
内建类型，字段名 out/in/atLeast 与 value/side 是从 three.asy:733/739 读出来的），
加上 `operator tension` / `operator curl` / `operator spec` / `operator controls`
四份内建与两份 `guide operator cast`。asy 的 guide 是一棵树，`{z}`、`{curl c}`、
`tension`、`controls` 都是树上的结点；这一层 guide 就是 path，所以它们落成**带
spkind 记号的 path**（path 上多七格：spkind/spz0/spz1/spa/spb/spat/spside）。

**没做的那一半写在明处**：这些规格结点还没接到求解器上。asy__resolve 现在只从 joins
那张表起头，要接得给每个结点加"进/出两侧的规格"两格，并让 `a{dir}..b` 这类语法降到
上面那几个算符上（`join-out`/`join-in`/`join-both`/`join-dir` 与 `(join ".." (tension …))`
四种形状，exprs.js 现在还是一句 nope）。求解器本身其实**已经认**方向（spec.kind 2 是给定
角度）、curl（kind 1）与定死的控制点（kind 3），缺的只是张力那一档（现在恒为 1）。
所以那一刀是"接线 + 张力"，不是重写。在接上之前，asy__join 见到规格结点就 abort ——
base 里没有一处走到它（那几处只是声明），所以这一句现在谁也碰不着。

数字：`import plain;` 34 → 29（plain_paths.asy 的 14/19/118/129/130 五条一起没了）。
`import graph;` 148 没动。tests/asy 201 条、tests/run.js 91 条全绿。新用例
`cases/123-operator-name-arity`（十二行输出，与 `asy -noV` 逐字节一致：三元算符直呼、
三元不影响 `1 + 2` 走内建、两份 `operator tension` 之间的转调、`operator ::` 与
`operator ---` 当模块级变量、算符名当形参传进去再直呼、以及可变形参的匿名函数
接上 typedef 之后按四个实参调）。

### 连接里的方向、张力与控制点：接到求解器上

上一刀立了 `operator spec` / `operator curl` / `operator tension` / `operator controls`
四个算符与两个 specifier 类型，但没接线 —— 语法上的 `{dir}`、`tension …`、
`controls … and …` 还是一句 nope，asy__join 见到规格结点就 abort。这一刀接上。

**前端这半边**。camp.y:609 加 exp.h:1021 的 joinExp 说得很清楚：`a J b` 是**一次调用**，
规格夹在中间 ——

```
a{d1}..tension t..{d2}b
  -> operator ..(a, operator spec(d1,0), operator tension(t,false), operator spec(d2,1), b)
```

`0`/`1` 是 JOIN_OUT/JOIN_IN，specExp::trans（exp.cc:1476）把它当**第二个实参**传进去。
元数也照 camp.y 原样：`tension t` 是二元（binaryExp）、`tension t and u` 是三元
（ternaryExp）、`controls z` 是一元、`controls z and w` 是二元 —— 少写的那一格由 base 里
那两份转发补上（plain_paths.asy:14/19）。所以这一层一个特例都不用开。

内建的 `operator ..` 在 asy 那边是 `guide(... guide[])`（builtin.cc:421），而绘图层这边
那两份是**二元**的，于是 asyJoinFold 把那一串**从左往右折叠**成一串二元连接。等价的理由在
下一段。`::` 与 `---` 例外：base 里它们是**一格变量**（plain_paths.asy:129/130），所以照
asy 那样一次全传进去 —— 那要"用已经降好的值调一格可变形参的函数值"，asyFnValCall 是从
语法树读实参的，接不上，另写了 asyRestValCall。

**绘图层这半边**。规格不攒成一棵树，而是**边连边记**：knot 上多四组（inkind/inval、
outkind/outval、tout/tatout、tin/tatin，对应 knot.h:212 的 in/out/tin/tout），path 上多
几格 pending（下一个结的进侧规格、下一段的张力、下一段定死的控制点）—— asy 那边这份
"还没落到结上的规格"存在 flatguide 里。`asy__spjoin` 收规格，`asy__join` 在真接上一个结时
把 pending 落到接缝两侧，然后整条链重解一遍。

求解器本来就认方向（spec.kind 2）、curl（kind 1）与定死的控制点（kind 3），这一刀只把
**张力**补齐：alpha = 1/tout、beta = 1/tin（knot.h:219），三处系数（eqnprop::mid、
curlSpec::eqnOut / eqnIn）从化简回原式，velocity 的分母乘上张力、`atLeast` 那一档加上
knot.cc:82 那道上界，`encodeStraight` 在张力不是 1 时**不算直线段**（两个控制点各自往里
收 1/tension，knot.cc:606 的 else 支 —— 漏了这一条 `..tension 4 ..` 会印成 `--`）。

一个量出来的差：`(0,0){curl 3}..(1,1)..{curl 0.5}(2,0)` 那一条，三个结里有**一个控制点的
一个分量**与 asy 差 1 ulp（`0.467163152209019` 对 `…018`，第 16 位有效数字）。系数与消元
的算式逐项对过、与 knot.cc 一致，差的是三元线性系统里几步乘除的舍入落点；curl 两端同值、
单侧 curl、四结带 curl 那三种都逐字节一致。所以那一条没进 `.expected`（那个文件的判据是
**逐字节**等于真 asy），差异记在这里。

数字：`import plain;` 29 → 26（plain_paths.asy:382、plain_boxes.asy:32、
plain_arrows.asy:122 三条路径连接一起没了）。`import graph;` 148 没动。顺带修掉一个**真错**：
`..controls A and B..` 原来被**悄悄降成普通 `..`**（asyJoinExp 只看 join 那个词、把后面挂着的
规格丢了），几何是错的而且不报错。tests/asy 202 条、tests/run.js 91 条全绿。新用例
`cases/124-join-specs`（一百五十行输出，与 `asy -noV` 逐字节一致：`{dir}` 三种位置、
`{x,y}`、`{curl c}`、`tension a and b`、`tension atleast`、`controls` 的一参与二参、
`::` 折成变量调用、以及带方向标记的闭合路径）。

### 闭包抓外层的 `this`：捕获一格，进门再绑回来

`pic.add(new void(frame f, transform t) { out(f,t,position,align); })`
（plain_Label.asy:316/342）—— 那个 `out` 是外层 struct 的成员，而闭包体里
`L.self` 原来一进门就设成 null，于是它落到"内建函数 'out'"那句 nope 上。

麻烦不在"要不要抓"，在于**抓来的东西怎么读**。核心方言里捕获是 `(cap 名)`、局部量是
`(var 名)`，而前端有十来处直接发 `(var this)` / `(fld (var this) f)`（裸字段名、裸方法名、
显式 `this`、`operator init(…)` 转调、赋值给字段…）。把它们都改成"看情况发 cap 还是 var"
是十来处各改一遍，而且以后每加一处都得记得。

落法是让那十来处**一字不改**：捕获一格叫 `asy__self`（不叫 `this`，免得跟局部量撞名），
进闭包后第一句 `(let this T (cap asy__self))` 把它绑回一个同名局部量。于是闭包体里
`this` 就是个普通局部量，`L.self` 照样开着，名字解析、字段读写、方法调用全走原路。

嵌套也白捡：外层自己是闭包时它也已经把接收者绑成了同名局部量，所以"在定义处怎么读它"
永远是 `(var this)` —— 捕获项的 `val` 是个常量，不用顺着 cap.prev 往上问。

static 的方法体里没有接收者，那时 `selfRec` 是 null，与从前一字不差。

一条**语义**上要留意的：`L.self` 开着意味着闭包体里的裸名字会先问外层 struct 的成员。
这正是 asy 的规矩（那边闭包就在方法的作用域里），所以不是"多接受"，是"从前少接受"。

数字：`import plain;` 26 → 24。`import graph;` 148 没动。tests/asy 203 条、
tests/run.js 91 条全绿。新用例 `cases/125-closure-this`（八行输出，与 `asy -noV` 逐字节
一致：裸方法名、裸字段名、改字段、显式 `this.n`、同时抓一格外层局部量、两层闭包穿过去
拿接收者、以及 static 方法里那一格**不抓**）。

### 模块级变量遮住同名函数：谁上场由目标类型定

`plain_picture.asy:85` 的 `scaleT(identity, identity)` 报"没有能匹配的签名"。根子在
`plain_constants.asy:39`：

```asy
restricted transform identity;
```

一格**模块级变量**，名字叫 `identity`，与 `real identity(real)`、`real[][] identity(int)`、
`transform identity()` 同名共存。asy 的名字是**按签名**查的（venv 里一个名字挂一串
签名），所以 `transform t=identity` 拿那格变量，而要 `real(real)` 的槽上拿的是**函数**。
我们这一层是变量优先：`asyNameOf` 查到 gvar 就回，函数那几份看都不看。

改法与第六十二刀（局部量遮住函数名）是同一条 —— 那一刀已经把机关铺好了，这次只是把
gvar 那一档接上去：查到模块级变量时，若同名还有可见的函数，就把候选挂在值上
（`shadowFns`），**类型仍是那格变量的类型**，由目标类型定案：

- `asyCoerce`（exprs.js:610）：目标是函数类型且挑得出**一模一样**的一份时改判成
  `(fnref …)`。初值、赋值、return 都走这里。
- `asyFit` 的 `tryAt`（calls.js:1124 之后）：槽要函数类型时先按 `shadowFns` 挑，挑到算
  精确匹配（不加代价）。挑不到**不算接不住** —— 这个实参还是那个变量，往下按它的类型算。

两处都要"类型完全相等"才改判，不做提升、不串用户的 `operator cast`：asy 那边精确匹配
得分最高，加宽会把本该 ambiguous 的情形偷偷分出胜负。

数字：`import plain;` 24 → 23。`import graph;` 148 没动。tests/asy 204 条、
tests/run.js 91 条全绿。新用例 `cases/126-shadowed-fn-name`（八行输出，与 `asy -noV`
逐字节一致：实参位置、初值、赋值、目标类型是那格变量本身、以及直接调用那两份函数）。

### 同名再声明一次：给新那一格改个名

asy 里同一层再声明一次同名的变量是**新开一格**把旧的遮住，类型可以不同：

```asy
void g(real position) {
  pair position=(position,position+1);   // plain_Label.asy:349
  ...
}
real d=...; pair d=dot(u,u);             // plain_Label.asy:39
```

我们这一层没有"同名两格"的表示（`(var 名字)` 就是那个名字）。类型相同时早就复用同一格
了（降成赋值），类型不同复用不了，从前报的是一句 nope。

这一刀给**新那一格改个名**。作用域 Map 里再加一种记号（与 `\u0000al:`、`\u0000bx:`
同一路子）：

- `declareShadow(nm, t, boxed)`：`scopes[top]` 里把 `nm` 的类型换成新的，另存
  `\u0000sy:nm -> asy__shN_nm`；旧那一格的别名/箱子/改名三条记号一并删掉（新那一格是
  **全新的一格**）。要装箱的走 `asy__bxN_nm` 那一支。
- `symOf(nm)`：只看**找到 `nm` 的那一层**（照 `boxOf`），没改过名就回 `nm` 本身。

读（`asyNameOf`）、写（`asyAssign` 的 `sym`）、调（`calls.js` 里那两处函数值调用）、
`unravel` 的接收者四处各加一句 `symOf`。捕获那一处不能问 `symOf` —— `asyCapOf` 走的是
`L.cap.outer` 而不是 `L.scopes`，所以在同一个循环里跟类型一起取出 `\u0000sy:`。

还有一条不在 asy 那边而在**我们这边**的约束：asy 的形参与函数体是两层，而核心方言的函数体
只有一层，同名的 `(let …)` 那边当场报"已经声明过了"。所以判据不是"同一层里已经有了"，
而是 `L.lookup(nm) !== null` —— 只要遮住了外层任何一层，就一律改名。块作用域那一档改了
也没坏处：出块名字就查不到，`symOf` 回的又是外层那个符号。

名字带 `asy__sh` 前缀是保留区。漏改的读写路径会去引用一个没声明的名字，核心方言那边当场
报，而不是悄悄读到被遮住的旧值 —— 这一刀最怕的就是后者。

`tests/asy/bad/redeclare-othertype` 这条边界随之消失（那份用例删掉了，它钉的正是这句 nope）。

数字：`import plain;` 23 → 22。两句"重新声明"都没了，净减一是因为 plain_Label.asy:56
那句原先被 :39 挡住、现在才露出来（函数体里的 `conj` 抓外层的 `c`）。`import graph;` 148
没动。tests/asy 204 条（删一条 bad、加一条 case）、tests/run.js 91 条全绿。新用例
`cases/127-shadow-redeclare`（九行输出，与 `asy -noV` 逐字节一致：形参被遮住、体里连遮三次
还接着改、遮住的那一格进闭包、块里遮住出块还原、以及遮回原来那个类型）。

### 一批：数组的 `.cyclic`、autoplain、递归的误判与几处按签名定案

这一刀是**成批推**的一刀（用户要的是先快后收敛），一次落了六件事。

**数组的 `.cyclic`（4 处）。** asy 那边它是数组对象上的一格标记（array.h:21），置上之后下标
按长度取模、负数也绕回来（runarray.in:104 `if(cyclic && len > 0) n=imod(n,len);`）。我们的
数组是核心方言的裸数组，头上没有那一格 —— 加一格要动 anew/aget/aset 在解释器、
JS/C/LLVM/SPIR-V 五个后端与 MIR 那一路，十来个文件。所以标记放在**旁边**：每个数组类型
一格模块级登记册（`(arr (arr T))`，见 `cycHelper`），按**身份**查（`(bin "==" …)`，就是
asy 的 alias）。身份查过的语义与"标记在对象上"完全一样 —— 别名、传参、装进结构体都跟着走，
不像"按符号静态近似"那样会悄悄给错答案。代价是每次下标多一次调用；登记册空着时（绝大多数
类型）那一句就是一次长度比较。落点四处：`asyMember` 的读、`asyAssign` 的写、`asyIndex`
的读侧、`asyAssignIndex` 的写侧。

**autoplain（graph 148 → 99）。** graph.asy 裸用 `Label` / `ticks` / `scaleT` / `arrowbar`，
自己一句 `import plain;` 都没有 —— asy 那边每个文件开头都隐式有那一句（settings 的
autoplain）。`asyModLoadAs` 里补上，位置 0（不是 -1：recVis 的判据是 `had.at <= at`，
plain 的 `struct picture` 要盖住内建面那个同名的垫子）。三条边界：prelude 自己
（`asy_builtins`）不做 —— 那会让 plain 在 `struct file` 还不存在时就开始降；plain 自己
那一串（`plain` 与 `plain_*`）不做 —— 那会循环；**找不到 plain 时不出声**（诊断回滚）——
tests/asy/cases 里那些自己写的小模块旁边没有 plain.asy。

**"体里提到自己"不等于递归（2 处）。** `localFunClo` 原先扫一遍名字就报"递归"。可 asy 的
名字按签名查：plain_Label.asy:56 的 `pair[][] conj(pair[][] a)` 体里那句 `conj(a[j][i])`
调的是内建的 `pair conj(pair)`，plain_markers.asy:64 的 `void add(real x)` 体里那句
`add(pic,…)` 调的是 plain 的 `add(picture,frame,pair)`。改成**先降一遍**：降通了就是这种
情形，降不通且体里确实提到自己才报，连带的诊断一并回滚。真递归那一格还是 nope，
`tests/asy/bad/localfn-recursive` 钉着它。

**`shipout()` 的歧义（2 处）。** plain_shipout.asy:120 那份全是默认值，0 个实参也接得住；
prelude 里再垫一份 `void shipout()`，`shipout()` 就真的 ambiguous 了（量过 asy：
`void f(); void f(int a=2); f();` 报的正是 "call of function 'f()' is ambiguous"）。
我们的诊断是对的，垫的那两份是错的 —— 删掉，`tests/asy/draw/tri.asy` 改写成
`shipout(currentpicture)`。

**泛型 `search(T[], T, bool(T,T))`** 按元素类型现生（`searchHelper`，判据从 `a[mid] <= key`
换成 `!less(key, a[mid])`，只用 less 一个算符），以及 `_texpath` / `textpath` 两条签名
（runlabel.in:243/349，体是 abort）。

**同名的文件级变量按右边的类型挑一格**（`gvarFor` + `probeType`）：plain_Label.asy:688 的
`texpath=new path[](string s, pen p, …){…}` 赋的是 :215 那一格，不是 :589 那一格。
`probeType` 求一遍类型再回滚，右边只真求一次。

数字：`import plain;` 24 → 16，`import graph;` 148 → 99。tests/asy 206 条、tests/run.js
91 条全绿。plain 剩下那 16 条里最贵的三件是：被调方填默认值（函数值带默认值那一格）、
给方法赋值（asy 的方法就是一格函数值字段）、以及"调一个任意表达式"
（`(above ? add : prepend)(dest,src)` 要拿调用处的实参类型去定一整个条件表达式的重载）。

### autoplain 排在内建面之后，与 graph 那一批余量

上一节的 autoplain 只到 99 —— 并表的位置错了。`asyBuiltinsIn` 是在 `asyDeclPass` **开头**
跑的，而那时候 autoplain 已经并完了：内建面那份 `struct picture`（垫子）位置更靠后，
按 recVis 的 `had.at <= at` 又把 plain 的真 `picture` 盖回去了 —— graph 里
`pic.scale` / `pic.add(…)` / `pic.userMin()` 那三十来条就是这么来的。

改法是把并表挪进 `asyDeclPass`，紧跟在 `asyBuiltinsIn` **后面**、用**同一个** `off`：
```js
  asyBuiltinsIn(L, u, off);
  asyAutoPlainIn(L, u, off);
```
`asyModLoadAs` 那边只留一个记号（`u.aplain`）。plain 的初始化函数记在 `u.pi`，正文最前面
紧跟内建面那一句发出去（`u.bi` 之后）。graph 148 → 99 → 60。

余下那一批是 graph/math 裸用的 run*.in 函数，照老规矩分两档写进 prelude：答得出的写正文
（`log10`、`search(string[],string)`、`norm(real[])` / `norm(real[][])`、`find(bool[],int)`、
`piecewisestraight`），算法重而 import 时用不到的体是 abort（`cubicroots`、`solve` 两支、
`tridiagonal`、`_findroot`、`fft`）。60 → 53。

再有六条是"同名的变量遮住函数名"在 `==` 上的那一格：`scale.T == identity` 左边是
`real(real)`、右边是 plain_constants.asy:39 那格 `transform` 变量。第六十三刀的
`shadowFns` 机关只挂在 coerce 与 fit 上，比较与 `? :` 这两处是**两边互相定型**，没有
"目标类型"可问 —— 加一条 `asyShadowMatch(L, a, b)`：一边挂着候选、另一边是函数类型时，
按对面的类型挑同型的一份，原地换掉；挑不到就什么都不做，照旧报原来那句。53 → 47。

数字：`import plain;` 16（没动），`import graph;` 148 → 47。tests/asy 207 条、
tests/run.js 91 条全绿。graph 剩下那 47 条里成堆的是：可变形参的函数值
（`interpolate` = `path(... path[])`，`Spline` / `Straight` / `Hermite` / `join` 那一族）、
`axis(picture, void(picture,axisT))`、`.value` 字段，以及 plain 那 16 条漏下来的连带。

### 一批：方法形参的可见位置、内建面是弱的、数组的比较，与两处按签名定案

这一刀是一批。起点是 `import math;` 量出来 71 条 —— 比 `import plain;` 的 16 条多得多，
而 math.asy 自己只有四百来行。差的那五十几条全在 plain 里，形状是"`struct align` 声明在
后面"，可 `struct align` 明明在用它的那一行**上面**。

`asyMethod` 里 `L.at`（可见位置）原来是在 `asyFormals` **之后**才摆好的。形参与返回类型
里的记录名于是拿"上一次降级留下的 at"去问 recHere。`import plain;` 那条路上留下的碰巧是个
很大的数，一问全通，看不出来；`import math;`（plain 走 autoplain 并进来）那条路上留下的是
33，plain 里一半的 struct 就都被判成"声明在后面"。把那一对 `keepAt` / `L.at = at` 提到
formals 前面就完了 —— 71 → 24。

第二条是**内建面那一份是弱的**。asy 的内建表（builtin.cc）与 `base/plain.asy` 是两拨东西，
而我们把"内建"写成了一份 asy 源码（`stage0/lib/asy/asy_builtins.asy`），里面难免混进本该由
plain 提供的那几个 —— `int[] sequence(int,int)` 就是（asy 那边只有 plain.asy:151 一份）。
两份同签名的都可见时我们判"有多个同样合适的重载"，而 asy 压根只有一份。`asyVisible` 末尾
加一档 `asyBiWeak`：真库里出现**同签名**的一份时，内建面那一份退场。

第三条是数组上的**比较**。asy 的 runarray.in 里 `>` `>=` `<` `<=` 与 bool[] 的 `&` `|`
都是逐元素的算符函数、回 bool[]；二维数组上的 `*` 是**矩阵乘**，不是逐元素。前端的 opUser
在内建那一档之前就问，所以这些直接写进内建面就行 —— 顺带补了 `all` / `sort` / `pow10` /
`AtA` / `transpose(pair[][])` 与 `real[] -> pair[]` 那条 arrayToArray。`any` 刻意**不给**：
asy 那边报 "no matching variable 'any'"（量过）。`|` 这个算符名进了 ASY_OPSYM，bool 上那一
档与 `&` 并排（不短路）。

第四条是两处**按签名定案**。同名的一格函数值与一族函数并存时，原来一律先走那一格：
  - plain_Label.asy:1 的 `real angle(transform)` 本来不该有"那一格"—— 是
    plain_arrows.asy:98 的 `angle=min(angle*…,45)`（改的是**形参**）让 fnSlots 误判了。
    `angle(z)`（z 是 pair）于是被当成间接调用。现在那一格**接不住就回滚**，同名的函数与
    内建那一族再试一次。
  - graph.asy:268 的 `ticklabel DefaultLogFormat=DefaultLogFormat(10);` 之后
    `DefaultLogFormat(base)`（base 是 int）有两个候选：函数那份同型，刚声明的这格变量要
    `int -> real`。挑错了就回 `string`，graph.asy:695/794 的 `? :` 两支于是不同型。新的
    `asyGvarLoses`：同名函数里有**完全同型**的一份而这一格要转换时，让函数那一档上。

`_texpath` / `textpath` 的元数照 runlabel.in:243/349 改成 `path[][](string[], pen[])`
（plain_Label.asy:664 之后 `g[i][0]` / `g[i].delete(0)` 钉着二维）；`probeType` 去掉了
"pre 不是数组就不探"那道门 —— 文件级的 `texpath=new path[](…)` 要靠它挑那一格。

数字：`import plain;` 16 → 14，`import graph;` 47 → 25，`import math;` 71 → 15。
tests/asy 208 条（新增 cases/130-array-compare）、tests/run.js 91 条全绿。

### 一批：名字往外找那一格、任意表达式当被调，与循环条件里的 `? :`

这一批的四条都是**同一个毛病的四个面**：asy 把一个名字放到"函数 + 各层变量"的整个候选
面上，用**用处**（实参类型、字段名、目标类型）挑；我们这边是从里往外找、找着第一格就
定案。补法一律是那套探针：`L.diags.mark()` 加换掉 `L.pre`，成了就把攒下的语句补回去，
不成就回滚换下一档。

- **任意表达式当被调**（calls.js 的 `asyCall`）。`(above ? add : prepend)(dest,src)`
  （plain_filldraw.asy:247）、`((F) map.operator init)()`（collections/map.asy:102）：
  被调那一侧先当普通表达式降，是函数类型就走间接调用那条（与函数值同一条路）。降不出来
  就回滚、照旧报"还没做"。不是单个变量时先绑一格临时量 —— `(callfn …)` 要个值，而
  **被调先求**（asy 的次序）。
- **`? :` 两支都是重载集**（exprs.js 的 `asyOverBoth` / `asyOverSide`）：取两边签名的
  交集，只有**一个**共同签名时定案。交集里多于一个就不猜（照旧报两支不同型）—— 那要
  把调用那一侧的实参类型倒灌回来，是另一刀。
- **名字往外找那一格**（`asyMemberOuter`，读、写、当实参三处都接上）：里面那一格上没有
  这个字段时，同名的**模块级**那一格还有第二次机会。graph.asy:1134 的 `void axis(picture,
  Label, path, …)` 形参叫 `axis`，而 graph.asy:1007 的 `axisT axis;` 才是带 `.value`
  的那一格。三处落地：`asyField`、`asyDotQual` 里递归那一层（`axis.div.push(3)` 这种
  三层的点）、`asyAssign` 的字段赋值。另外给局部/形参的值挂上 `shadowVar`（与
  `shadowFns` 同一条路，`asyCoerce` 与 `asyFit.tryAt` 两个落点）：同名不同型时，实参
  位置按**目标类型**在两格之间挑。
- **`for` 与 `do-while` 的条件里能有 `? :`**（stmts.js）：`while` 本来就把条件摊出来的
  语句搬进循环体开头、判假就 `(brk)`，这两种照抄同一条。于是 `asyLoopCond` 那道门整个
  删掉 —— graph.asy:801 那句不必再报"还没做"。`continue` 先跑更新再跳到循环顶，条件也
  跟着重算，与 asy 一致。

数字：`import plain;` 14 → 13，`import graph;` 25 → 17，`import math;` 15 → 14。
tests/asy 209 条（新增 cases/131-name-sets）、tests/run.js 91 条全绿。

### 一批：函数类型上的默认值、别名当返回类型，与"没有体的成员就是一格字段"

`import plain;` 13 -> 4 的这一批。除了第一条，其余都是**照着 asy 的模型改**，不是补特例。

- **函数类型上的默认值**（decls.js 的 `asyFnTypeOf` 记 `fnDefs`，calls.js 的
  `asyFnValFit` / `asyFnValDefWrap` / `asyWrapValCall`）。`using envelope=path(frame
  dest, frame src=dest, real xmargin=0, …)`（plain_boxes.asy:75）—— asy 把默认值记在
  **类型**上。少给实参时现造一个包装：形参是"给了的那几格"，体里按**声明处**的位置与
  单元求默认值（名字用声明里那几个，`src=dest` 于是照样通），然后拿全套实参间接调。
  少给的那几格**不一定在尾巴上**：从左往右走，类型接不住这一格而它有默认值就跳过去
  （plain_boxes.asy:88 的 `e(F.f,xmargin,…)` 跳掉的正是中间那个 `frame src`）。
  **差别写在明处**：asy 补的是**被调那个函数自己**那一份（调用处压一个"用默认值"的
  记号，被调方 pushDefault 换成真值），我们补的是类型上那一份。量过
  `using env=int(int a,int b=a+1,int c=10); int f(int a,int b=0,int c=0){…}` 之后
  `e(3)`：asy 印 300，我们印 350；被调方**没有**默认值时 asy 直接报
  "Trying to use uninitialized value"。base 里这两份是一致的，所以先这么走。
- **别名当返回类型**（decls.js 的 `asyGlobalNames`）：`arrowbar EndBar(real size=0)=Bar;`
  （plain_arrows.asy:429）是一格函数类型的**变量**，返回类型那一格以前照抄源码里的名字，
  于是类型成了 `arrowbar(real)`，`asyIsFn` 认不出 —— 下一句 `EndBar(size)(pic,g,p,margin)`
  报"回来的不是函数"。改成用**上面那几步解出来的** ty（别名展开、维度接好）。
- **struct 里没有体的成员声明就是一格函数类型的字段**（calls.js 的 `asyIdxFldCall`）：
  `V operator [] (K key);` / `void operator [=] (K key, V value);`
  （collections/map.asy:43/85）。量过 `s.operator [] = new int(int k){…}` 之后 `s[3]`
  走那一格。下标算符找不着方法时再问一遍字段。
- **重载的方法当值取出来**（exprs.js 的 `mover` 一族）：以前是"还没做"，现在**先不定案**，
  与重载集同一条 —— 由目标类型挑（`scalefcn T() {return … ? postscale.T : T;}`，
  plain_picture.asy:101 两支都是这种）。`? :` 两支的公共签名多于一个时也不再直接报错：
  回一格待定的值，赋值/返回/实参的目标类型（`asyCondAt` 拿 `condWant` 重降一遍）或者
  调用处的实参来定案。
- **同一层里被遮住的那一格**（lower.js 的 `declareShadow` 记 `\u0000ov:`、`outerOf`）：
  `marginT margin=margin(b--b,p);` 之后 `draw(…,margin)` 要的是**形参**那一格
  （plain_arrows.asy:593/595）。落地与模块级那一格同一条（`shadowVar`）。
- **pair 的数组元素上的复合赋值**（stmts.js）：`A[0][0] /= D;`（plain_Label.asy:70，
  A 是 `pair[][]`）走 pair 那一族的算符。内建面另外补上 runlabel.in:214 的
  `label(frame, string, string size, transform, pair, pair, pen)`（size 是**字符串**）
  与 `labels(frame)` —— frame 上多一位 `haslabel`，这一层没有 TeX，只记"有没有"。

数字：`import plain;` 13 → 4，`import graph;` 17 → 8，`import math;` 14 → 5。
tests/asy 210 条（新增 cases/132-fnty-defaults）、tests/run.js 91 条全绿。

### 一批：asy 前端那面墙翻过去了 —— 类可以互相引用，与 access 带上 autounravel

`import plain;` / `import math;` / `import graph;` 的**前端**诊断从 4 / 5 / 8 到 **0**：
这三条 import 现在整份降得出来，剩下的错全在核心方言那一层（`.sx` 上），是另一面墙。
前端这七条一条也不是特例，都是照 asy 的模型改的。

- **`from m access X;` 带上 X 体里那些 `autounravel` 成员**（decls.js 的 `asyAuNames`
  记 `rec.au`，modules.js 的 `asyModMerge` 把 `only` 那张改名表**摊开**）。量过：
  `struct Box { autounravel Box mkBox(int)=Box; autounravel int twice(Box b){…} }`，
  另一个文件里 `from mm access Box as B;` 之后 `mkBox(5)` 与 `twice(b)` 都通（印 10）。
  名字**不跟着改** —— 改的是类型那个名字，摊出来的成员各是各的名字。
  `operator cast` / `operator ecast` 不挂在名字上（进的是 `L.casts`），按"提到了这个
  类型"认就够了。`collections/map.asy:48` 的 `Iterable(iter)` 是这一格：它是
  `collections/iter.asy:45` 那条 autounravel，而 map.asy 只 access 了 `Iterable_T`。
- **`operator init` 当方法值取出来**（lower.js 的 `methodVal`、exprs.js 的 `asyMValType`）。
  `((F)map.operator init)()`（collections/map.asy:102）。那份候选的 `ret` 记的是**记录名**、
  `sym` 是 `asy__ctor_<记录>` —— 它在重载解析里扮演的是构造函数 `M(…)`；而 asy 里
  `m.operator init` 是**绑在 m 上的那个 void 方法**（量过：调完 `m.x` 是 3，改的是 m
  自己、不是一个新对象）。所以这一档换成 `asy__ctor_<记录>_body`、返回类型算 void。
- **`(T) x` 里面那一格还没定案时，括号里那个类型就是定案的依据**（exprs.js 的 `asyCast`
  开头交给 `coerce`）。少了这一句，`castFor` 拿着 `<M.operator init 的重载集>` 那个假
  类型去问，报的是"转不了"。
- **方法体里写的 `using` 是体内一句语句**（lower.js 的 `aliasOne` 多问一句 `self`）。
  `using F = void();`（collections/map.asy:101）以前记进 `rec.tyAlias`，它的 bi 正好等于
  当前那一项的 bi，于是 `aliasAt` 里 `e.bi < bi` 不成立 —— 紧接着那一句报"typedef 写在
  后面"。语句位置的别名走文件级那张表，与语句位置的 struct / typedef 同一条。
- **`var` 也可以被 typedef 掉**（lower.js 的 `isVarTy` 先问别名表）。`simplex2.asy:16`
  是 `typedef int var;`（写在 `struct problem` 体里），之后 `var[] v = {VAR_A, VAR_B};`
  与 `var argmin;` 都是**普通声明**，不是类型推断 —— 后者按推断讲连 asy 自己都拒。
- **有体的方法被当成员赋过值，就整条摊成"一格函数类型的字段 + 一个初值是那个匿名函数
  的默认值"**（lower.js 的 `memAssigned` / `fnFldOk`，`recNew` 里那一格走 `mkClo`）。
  `filltype defaultfilltype(pen) {return FillDraw;}`（plain_arrows.asy:36）加 `:162` 的
  `TeXHead.defaultfilltype=…`。asy 那边方法**就是**一格函数值字段，所以摊完调用、取值、
  赋值三处全落在"没有体的成员就是一格字段"那条老路上。**判据只有"名字被赋过值"**
  （扫这个单元里 `X.name = …` 的 name）—— 全摊的话每个实例都要为每个方法装一个闭包，
  picture 那种几十个成员的 struct 代价看得见。跨单元赋值还接不住（那个 struct 已经降
  完了），漏出去的还是 `recField` 那句 nope，base 里没有那种写法。
- **字段默认值里的花括号数组初值要把元素类型带下去**（lower.js 的 `recNew`）：
  `var[] v = {VAR_A, VAR_B};` 是一格字段的默认值，走 `asyExpr` 那一层看不见"我该是
  int[]"。与 vardec 那一侧同一条。另外 `autounravel Iterable_T operator cast(…) = …`
  这种**函数值字段**的符号名要过一遍 `asyFldSym`：名字里带空格，不过的话发出去是
  `(global asy__sf61_..._operator cast …)`，方言那边读不出来。

**同一批里的另一半：类的字段可以互相引用、前向引用、自引用。** 上面那些把
`import plain;` 推到核心方言这一层之后，第一眼是 **526 条**，其中 281 条是同一个根因的
回声（`形参 this/pic 的类型认不出`）。方言原来的规矩是"字段类型只能是**前面已经声明
过**的结构体/类"，理由是自引用与前向引用的**零值会无限递归**。这条对**结构体**是对的
—— 它是值语义、内嵌是真的内嵌。对**类**是过严的：类在四条腿上都是**一个指针**
（LLVM 的 `t.k === 'class'` -> `ptr`、零值 -> `null`；两个解释器按名字存 JS 对象），
零值是空引用，没有递归可言。

落法是"名字先坐下、字段后填"（sexpr/lower.js 的 `chunk` 与 `structDec`）：先给每个
`(class …)` 建一格空的类型对象，再逐条**原地填**字段数组，于是提到后面那个类的字段拿到
的就是那一格。`aggLater` 那张只为诊断服务的表从此只收**结构体**名字。

逼出这一刀的三处都在 plain 里，而且怎么排都排不开：plain_bounds.asy 的
`freezableBounds` 与 `transformedBounds` 是**互相**引用的（`(link freezableBounds)` 与
`(tlinks (arr transformedBounds))`），plain_picture.asy 的 `node3` 拿 `picture` 当形参
类型而 `picture` 声明在它后面。那一格塌了之后 `picture` 整个类就没建起来，三百多条诊断
跟着刷。

数字：`import plain;` 526 → **24**，`import math;` 528 → **24**，
`import graph;` 701 → **28**（都是核心方言那一层的了，前端 0 条）。
新增 `tests/sexpr/cases/18-classcycle.sx`（前向 / 互相 / 自引用各一格，五条腿同结果）；
`bad/struct-self` 与 `bad/struct-fwd` 照旧拒，只是话说得更准（结构体那一半没动）。

跑过的轴：`tests/asy` 210、`tests/run.js` 91、`tests/sexpr` 53、`tests/oir` 451、
`tests/llvm` 22、`tests/jit` 22、`tests/gpu` 15+1 skip、`tests/js-roundtrip` 92、
`tests/oracle` 7、`tests/js-exec` 11、`tests/cabi` 4、`tests/wat` 12 —— 全绿。
`tests/mir` / `tests/glr` / `tests/incr` 在**这一刀之前就红**（量过：`git stash` 之后
同样三条红，mir 是 exprs.js↔stmts.js 那个 import 环），不算这一批的账。
`tests/bootstrap` 照旧跳过。

### 一批：plain / math / graph 三条从「编不过」到「跑完、逐字节对上」

上一刀把墙推到了核心方言那一层（前端 0 条、方言 24/24/28 条）。这一批把那 24 条读完、
改完，然后往下走到**运行期**，一直走到 `import plain;` / `import math;` / `import graph;`
三条都与 `asy -noV` 一样：**什么都不印、退 0**。

先加了一件工具：`omni sx <文件.asy>` 印 asy -> 核心方言那一步的文本。方言的诊断报的是
`<文件>.asy.sx:L:C`，而那份 `.sx` 是**虚拟的**（`SourceFile` 现造、从不落盘），以前只能
拿着行号猜。印出来的内容与 `lowerCoreSexpr` 拿到的逐字节相同，行号可以直接对 ——
这一批后面每一条都是这么找出来的。

方言那 24 条，六个根因：

- **`asyMangle` 出来的名字不一定是标识符**。函数类型在这一层是 `void()` 这样的字符串，
  于是 `void()[]` 的 copy helper 叫 `asy__acopy_void()`，方言把它读成"名字 + 一个空表"，
  报的是"返回值的类型不对"。cycHelper 与 searchHelper 早各自洗了一遍，这次把洗放进
  `asyMangle` 自己，五个 helper 一起好。函数类型的元素还要能**现生**一份（`arrHelper`
  原来只给记录与数组生，标量走 HELPERS 那张表），零值是 `(null …)`。
- **`(int 0-1)`**：searchHelper 的模板里手写错了一个 -1。
- **局部量的名字也可能是算符名**：plain_Label.asy:46 的 `pair[][] operator *(…)` 写在
  `SVD` 的函数体里，直接当符号用就是 `(let operator * …)`。过一遍 `asyFldSym`，并记一条
  `\u0000sy:` 让 `symOf` 认得；`declareShadow` 造的 `asy__sh…` / `asy__bx…` 同样洗一遍。
- **struct 可以写在函数体里**：plain_Label.asy:591 的 `struct stringfont` 就在 `texpath`
  的体内。类发出来了，`asy__ctor_stringfont` 与 `asy__m_stringfont_pen` 一个都没有 ——
  `methodDecls`/`auFns` 那两张队是在 `asyBodyPass` **开头**排一遍的，而函数体是后面才降的。
  改成记两个游标、正文降完再排一遍（`drain`）。连带露出一格内建面的空：
  `string font(pen)`（runtime.in:585）没有，补上（没设过 fontcommand 时回那串默认的
  LaTeX 字体命令，量过真 asy）。
- **写在函数体里的函数，抓的可能是接收者或外层闭包的捕获**。`localFunOuter` 原来只扫
  `this.scopes`：
  - 方法体里 `this` 是 `(this)` 这个**语法头**、不是一个名字原子，而裸字段名根本不出现在
    scopes 里 —— collections/map.asy:38 的 `this.operator iter()`、simplex2.asy 里
    `problem` 的 `validConstants`/`validVar`（裸写 `rows`/`v`/`n`）都是这一档；
  - 闭包体里 `scopes` 已经换成空的一层，外层那几层挂在 `cap.outer` 上 —— graph.asy:837 的
    `void omit(real[] A)` 写在 `new tickvalues(tickvalues v){…}` 里、用外层形参 `a`/`b`。
  两条都补上（成员那一档只算**实例**成员，而且要求真有 `this` 那一格 —— plain_bounds.asy:372
  那个写在 `static void write(extremes)` 体里的 `static void write(coord[])` 靠这一条留在顶层）。
- **`x.operator init(…)`**：collections/map.asy:110/112 的 `map.operator init(nullValue)`。
  构造函数那份候选长得像"回记录、没接收者的函数"，所以接收者一带就多一个实参。
  `asyApplyCall`/`asyDefWrapper` 里那条 `reinit`（目标换成 `…_body`、回 void）**早就写好了、
  一处都没接线**，这次接上。

还有两条是**缓存与默认值**上的：`asyDefWrapper` 造不出来时要把 `wrapNames` 里那个名字
**撤回** —— 名字是造之前登记的，留着的话后面同一份 key 命中缓存、拿到一个从没发出去的
函数（量到的是 graph 里 `未声明的函数 'asy__def37_errorbars'`，第一次失败发生在一次会
回滚的试降里）。形参的默认值也能是花括号数组初值（graph.asy:2146 的 `real[] dmx={}`），
按形参那一格的类型降，与 `T[] a = {…}` 同一条。

编过去之后是运行期，四格：

- **`makepen(path)` / `nib(pen)`**。笔尖这一格在 `struct pen` 里放不下 —— 那个 struct 排在
  `struct path` **前面**，而字段的类型只能是前面声明过的记录。所以路径存在旁边一张
  `path[] asy__nibtab` 里，笔上只带一个下标（-1 是没有，`nib` 那时回 `nullpath` ——
  量过真 asy `length(nib(currentpen))` 是 -1）。plain_pens.asy:257 的 `squarepen` 点名要它。
- **`_cputime()` 是五格**（plain.asy 读 a[0]/a[2]/a[3]/a[4]），这一层没有时钟，回五个 0。
- **`(real) "3.14git"` 不该在转的时候报错**。量过真 asy：那一句是通的，拿到的是一格
  Default，**读它**才报 "Trying to use uninitialized value"。plain.asy:42 的
  `real RELEASE=(real) split(VERSION,"-")[0];` 正好只存不读，在转的时候 abort 就把
  `import plain;` 掐断了。改成回 0，差别写在明处。
- **`asyGvarAt` 要认单元**。内建面是每个单元隐式引一次的，位置记在 `off` 上，与这个单元
  第 0 项**同一格**；于是 `lib/asy/version.asy` 里那句 `string VERSION = "3.14git";` 赋进了
  内建面那一格，`version.VERSION` 一直是空的，plain.asy:22 那句版本检查每次都发警告。
  文件级变量那张表上补一格 `unit`，`gvarAt` 先要"这个单元自己声明的"那一份。
  `lib/asy/version.asy` 的值也改成与内建面同一个（`3.14git` —— 参考树就是这一代）。

数字：`import plain;` 24 → **0**，`import math;` 24 → **0**，`import graph;` 28 → **0**，
而且三条都**跑完退 0、一个字都不印**，与 `asy -noV` 逐字节相同。
新增 `tests/asy/cases/135-fnbody-struct.asy`：上面九格各一条（函数体里的 struct、方法体里
抓接收者的两种写法、闭包体里抓外层形参、`x.operator init(…)` 带默认值的两种调法、函数体里
的算符重载、花括号默认值、函数类型元素的数组、`font`/`nib`、转不动的 `(real) s`），
`.expected` 是 `asy -noV` 的输出**原样**。

跑过的轴：`tests/asy` 213、`tests/run.js` 91、`tests/sexpr` 53、`tests/oir` 451、
`tests/llvm` 22、`tests/jit` 22、`tests/gpu` 15+1 skip、`tests/js-roundtrip` 92、
`tests/oracle` 7、`tests/js-exec` 11、`tests/cabi` 4、`tests/wat` 12 —— 全绿。
`tests/mir` / `tests/glr` / `tests/incr` 照旧红（上一刀量过：这一批之前就红，
mir 是 exprs.js↔stmts.js 那个 import 环），不算这一批的账。`tests/bootstrap` 跳过。

### 一批：主文件也隐式 import plain，与内建面在打平时让位

三条 `import` 编过去之后，拿 `reference/asymptote/examples` 那 220 个例子量了一遍：
**3 个跑完**。两个根因，都不在语言本身上：

- **主文件没有 autoplain**。真 asy 那边 plain 是自动引进来的（`write(cm);` 不用引任何
  东西就能跑，`-noplain` 才关掉）。我们只给**被加载的模块**走了这一条（asyModLoadAs 里
  那一句），主文件没有 —— 于是 `size(0,22cm)` 报"未声明的变量 'cm'"（cm 在
  plain_constants.asy 里）。补在 `chunk()` 里，名字用文件名去掉目录与 `.asy`，
  于是直接编 `plain.asy` 自己时按名字排除那一条还管用。找不到 plain.asy 时照旧回滚，
  所以不带 `ASYMPTOTE_DIR` 跑测试时行为一字不变。
- **内建面与真 plain 打平**。`asyBiWeak` 早就让内建面那份"退场"，但它只筛**签名完全
  相同**的那一种；`draw` 这一族两边的默认实参串不一样，两份都留下来，于是
  `'draw(path, pen)' 有多个同样合适的重载`。改成在 `asyApplyCall` 的 cost 打平那一档
  再判一次"谁是内建面的"：内建面那份让位，真库那份赢。asy 那边 `draw` 只有 plain 一份，
  所以这不是"多认一门语言"，是把我们自己多出来的那一份藏好。

数字：examples **3 → 29** 跑完（220 个）。剩下 191 个的下一堵墙已经量清了，按条数排：
`path3` / `object` / `guide` 这三个类型（three*.asy 与 plain_boxes 那一路），
以及 **`guide` 是 `path` 的别名**带出来的一处死循环 —— plain_arrows.asy:552 的
`draw(…, explicit path[] g, …)` 与 :561 的 `draw(…, guide[] g, …)` 在这一层签名相同，
按"同签名是替换"后一份盖掉前一份，而后一份的体正是 `draw(pic,(path[]) g,p,legend,marker)`，
于是自己调自己。要解开得让 `guide` 成为自己的类型（一层包着 path 的壳 + 两向隐式转换），
那是下一刀。

跑过的轴：`tests/asy` 213、`tests/run.js` 91、`tests/sexpr` 53、`tests/oir` 451、
`tests/llvm` 22、`tests/jit` 22、`tests/gpu` 15+1 skip、`tests/js-roundtrip` 92、
`tests/oracle` 7、`tests/js-exec` 11、`tests/cabi` 4、`tests/wat` 12 —— 全绿。
`tests/mir` / `tests/glr` / `tests/incr` 照旧红（先于这几刀），`tests/bootstrap` 跳过。

### 一批：examples 那道坡上量出来的五条（29 -> 62）

上一刀留的话是"让 `guide` 成为自己的类型是下一刀"。**先量再动**：把 220 个例子按
"第一条错误"分了个桶，`guide` 那处死循环只压着 **1** 个例子（29 -> 30），真正压着人的
是另外几条。所以这一刀不动类型系统，按条数从大到小收了五条。

**1. 可变形参那一格接下来的候选不算"同型"**（`asyOpUser`）。plain_strings.asy:125 是
`string operator +(...string[] a)`，体里 `S += s` 在 asy 那边走的是**内建的**字符串接 ——
asyFit 的头注释早写着"任何非可变的候选都比可变的合适"，只是 `exact` 那一格没跟上，
于是 `S + s` 把两格打包再调回自己。10 个例子（log / spiral / advection / cos2theta …）
就是这么崩在 `Maximum call stack size exceeded` 上的。

**2. `settings` 是内建模块**（新的 `asySettingsIn`）。真 asy 那边它是 settings.cc 那一串
addOption，任何文件里 `settings.outformat="pdf";` 直接就能写。这一层从前只有 base 里
`access settings;` 过的文件看得见 stage0/lib/asy/settings.asy。补在 `asyAutoPlainIn`
**后面** —— settings.asy 自己也会拿到 autoplain，先加载会让 plain 里那句 `access settings;`
撞上"循环 import"；内建面正在加载时整条跳过（不然 plain_constants.asy:73 的 `void(file)`
在 `struct file` 并进来之前就炸，量过）。7 个例子等它。

**3. 真几何那五个**（`asy_builtins.asy`，从 abort 变成体）：`arclength`（5 点
Gauss-Legendre + 二分细化）、`arctime`（逐段扣掉再段内二分）、`subpath` 的两份
（de Casteljau）、`intersect` / `intersections`（包围盒细分 12 层把交点圈出来，再
Newton 收到机器精度 —— 全靠细分要 30 多层，examples/coag 那种段对多的图就跑不完），
以及 `transpose(real[][])`。19 个例子等它们。算法与 asy 的不是同一个，所以**末位会差**：
量过 `arclength` 差 2 ulp、`intersect` 的时间差 ~1e-15。cases/136 只钉算得准的那几位
（直线段的弧长是闭式的、subpath 端点落在结上、两条直线的交点时间是有理数）。

**4. `operator @`**（`ASY_OPSYM` 里一格）。camp.l 的 EXTRAOPS，geometry.asy:1721 起那四份
`bool operator @(point, line)`。语法层早就收了，缺的只是这张表。

**5. 同签名相撞时留住带 `explicit` 那份**（`asyExpKeep`），**但只在两格写下来的类型名
不一样时**。这一条是 `guide` 是 `path` 的别名带出来的：plain_arrows.asy:552 的
`draw(…, explicit path[] g, …)`（真的体）与 :561 的 `draw(…, guide[] g, …)`（体就是
`draw(pic,(path[]) g,…)` 一句转发）在这一层塌成同一份，按"后来的替换"留下的是转发那份
—— 自己调自己。"写下来的名字不一样"这个条件是**必须**的：`explicit` 本身不进签名身份
（第二十六刀量过），cases/30-explicit 里的 `three` 正钉着反方向那一档（先 explicit 再
不带的是替换），第一版没这个条件当场把它踩红了。为此形参多记一格 `src`（写下来的
类型名，新的 `asyTypeSrc`）。让 `guide` 成为自己的类型仍然是正经解法，但量过不值当：
那要动 base 里 219 处，收益是 1 个例子。

数字：examples **29 -> 62** 跑完（220 个）。剩下 158 个里 **109 个是同一堵墙**：
`path3`（`import three;` 那一路，three_surface.asy:28 就报）。其余是长尾，最多一档 5 个：
`vertex`（geometry.asy:5616 的 `from triangle unravel vertex` —— struct 体里声明的类型
往外 unravel）、`real * pen`、`extension` / `_image` / `pattern` 那几个内建、
`tridiagonal`、以及 `_texpath` / `_strokepath` / `_shipout`（TeX 与 EPS 那两路本来就不在
这一层）。

跑过的轴：`tests/asy` 215（新增 cases/136-geometry 与 cases/137-varargs-op-settings，
两份 `.expected` 都是真 asy `-noV` 的逐字节输出）、`tests/run.js` 91、`tests/sexpr` 53、
`tests/oir` 451、`tests/llvm` 22、`tests/jit` 22、`tests/gpu` 15+1 skip、
`tests/js-roundtrip` 92、`tests/oracle` 7、`tests/js-exec` 11、`tests/cabi` 4、
`tests/wat` 12 —— 全绿。`tests/mir` / `tests/glr` / `tests/incr` 照旧红（先于这几刀），
`tests/bootstrap` 跳过。

### 一批：三维路径进内建面（`import three;` 147 -> 1）

上一刀量出来剩下 158 个失败例子里 **109 个压在同一堵墙上**：`path3`。这一刀翻它。

**好消息是求解那一头不用做**：asy 的 `guide3` 是**在 asy 里**解的 —— three.asy 自己写了
`struct flatguide3`（:601）与 `path3 solve(flatguide3)`（:1247），`--` / `..` 也是它自己的
（:758/:772）。所以内建面要补的只是 `path3` 这个**原始类型**与 runpath3d.in 那一批取值
函数，落点是 `path3(pre,point,post,straight,cyclic)`（three.asy:1359 里 solve 装结点用的
那份）。量过一条要紧的事：真 asy 里 `path3` **不用 `import three` 就在**（builtin.cc 注册
的 C++ 类型），所以 cases/138 能直接与 `asy -noV` 逐字节对。

补的这些（`asy_builtins.asy`，与二维那套逐行对着写、坐标换成 triple）：`struct knot3` /
`struct path3` / `nullpath3`、五数组构造、`length` / `size` / `cyclic` / `point` /
`precontrol` / `postcontrol` / `straight`、`point(path3,real)` 与两份 `dir`、`reverse`、
两份 `subpath`（de Casteljau）、`arclength` 的两份与 `arctime`、`min` / `max`（控制点凸包
的**外界** —— 真 asy 解导数零点，这两个数不一定同）、`concat`，以及
`real[][] * path3`（4x4 齐次变换作用在整条路上，three.asy:1951 的 `t*p[i]`）。

前端另加一条：**文件级 `operator init` 也能落在函数类型上**。three.asy:704 的
`guide3 operator init() {return nullpath3;}` —— `guide3` 是 `void(flatguide3)`，从前只有
struct 那份。符号名要过一遍 `asyMangle`（类型文本里有括号和逗号）。这一刀只接了**局部**
那一格（stmts.js 里函数类型那一支）；文件级变量的零值是方言那边铺的，还没走这条路 ——
cases/138 里那一段写的就是局部形态，注释里记着这个缺口。

顺手踩到的一个坑记在这儿：`path3 operator *(real[][], path3)` 的体里要
`real[][] * triple`，而那一份声明在文件更后面 —— 名字解析是顺序的，于是它落到了"数组
乘标量"那条内建路上报 `'*' 的另一边要是 int 或 real`。挪到后面就好了。

数字：`import three;` 的诊断 **147 -> 1**（两相都算）。剩下那一条是
three_arrows.asy:73 —— `struct arrowhead3` 里有 `real size(pen p)=arrowsize;` 与
`real size;` **两个同名字段**。asy 的 struct 体是个作用域，同名按签名分得开；这一层的
`class` 一个名字一格，要分开得给后一份另起槽名、再让 `.size` 按上下文（是取值还是调用）
挑一份。那是下一刀。

跑过的轴：`tests/asy` 216（新增 cases/138-path3，`.expected` 是真 asy `-noV` 的逐字节
输出）、`tests/run.js` 91、`tests/sexpr` 53、`tests/oir` 451、`tests/llvm` 22、
`tests/jit` 22、`tests/gpu` 15+1 skip、`tests/js-roundtrip` 92、`tests/oracle` 7、
`tests/js-exec` 11、`tests/cabi` 4、`tests/wat` 12 —— 全绿。`tests/mir` / `tests/glr` /
`tests/incr` 照旧红（先于这几刀），`tests/bootstrap` 跳过。

### 一批：同名两格字段、`cycle` 的第二条身份，与三维那批内建（`import three;` 134 -> 66）

先更正上一节的数字。上一节写「`import three;` 的诊断 147 -> 1」，那个 **1 是假的** ——
`three_arrows.asy:73` 那一条是 struct 声明期的错，它让那个单元当场停下，后面几个文件
根本没走到。把它修掉之后真实数字是 **134**。教训记在这里：一条声明期的错会把它后面
整片诊断压住，"只剩一条"这种话得先确认后面的确走到过。

**同名两格字段。** `struct arrowhead3` 里有 `real size(pen p)=arrowsize;`（three_arrows.asy:70）
与 `real size;`（:73）—— asy 的 struct 体是个作用域，同名按签名分得开，是**两个**成员槽；
这一层的 `class` 一个名字一格。做法是给后来那一份**另起槽名** `asy__fd<K>_<名字>`，源码里
那个名字记在 `src` 上，只让"认名字"的那几处知道这件事（`fldIs` / `fldCands`），按上下文挑：
取值挑**不是函数类型**那份（`arrowhead.size > 0`）、调用挑**函数类型**那份（`a.size(p)`）、
赋值把候选逐个试（three_arrows.asy:218 赋的是函数、:265 赋的是 real）。量过 asy 的挑法与
这一套一致（cases/139-dupfield 逐字节对得上）。**收得比 asy 多的一处**：两边都是两格时
`g.size=h.size` 在 asy 那边是 "assignment is ambiguous"，这一层挑 real 那格收下了 ——
记在这里，没往 strict 里钉。

**`cycle` 的第二条身份。** 三维那一层的 `A--B--C--cycle`（three_surface.asy:29 一族）里，
`--` 收的是 `guide3`（`void(flatguide3)`），而 `cycle` 在 asy 那边的类型是 `cycleToken`，
靠 `guide3 operator cast(cycleToken)`（three.asy:713）接上。这一层的 `cycle` 是绘图层的
一格 path，接不上那条 cast。做法是给 `cycle` 出来的值记一笔 `cyc`，在连接（`asyJoinFold`）
与 `&`／`|` 那两处接不上时**换成一格 `cycleToken` 再问一遍**。同一条路上还把
`operator controls` 的实参改成**先不定型**：绘图层那份收 pair、三维那份收 triple
（three.asy:719），哪一份由重载解析定案，接不上时才按 pair 那份报。

**那批内建。** 都是 C++ 面注册、base 里找不到定义的，照 `.in` / `.cc` 抄进内建面：
`Sin`/`Cos`/`Tan`/`aSin`/`aCos`/`aTan`（runpair.in:125+，90 度整数倍上给精确值）、
`bezier`/`bezierP`/`bezierPP`/`bezierPPP` 的 pair 与 triple 两族（runtriple.in:146+）、
`perp(triple,triple)`、`project(triple,real[][])`（runarray.in:1472）、`interp(triple,triple,real)`、
`piecewisestraight(path3)`、`determinant`/`inverse`（LU 与 Gauss-Jordan，部分选主元）、
`change2`/`minbezier`/`maxbezier`/`minratio`/`maxratio`、`transpose(triple[][])`、
`minbound`/`maxbound` 的 triple 一二维四格、`sort(triple[],bool(triple,triple))`、
`sort(real[][])`、`relativedistance`（knot.cc:61 的 velocity，MetaPost 第 131 节那一套）、
`path3 operator &(path3,path3)`（path3.cc:698 的 concat）。

**与 asy 量得出的差别一处**：`minbezier`/`maxbezier`/`minratio`/`maxratio` 在 C++ 那边是
"先拿控制点当界、再细分收紧到 Fuzz"，这一刀只到**控制点凸包**那一步。凸包界是真界（曲面
一定在里面），只是弯得厉害的面片上包围盒会比 asy 的松一点。

数字：`import three;` 的诊断 **134 -> 66**（两相都算）；`import plain;` / `import graph;` /
`import math;` 都还是 0；examples **62 -> 66** 跑完（三维那 100 多个还卡在 `import three;`
上，剩下的 66 条诊断是 surface/patch 那一层的内建与 3D 输出面 —— 那是下几刀）。

跑过的轴：`tests/asy` 217（新增 cases/139-dupfield，`.expected` 是真 asy `-noV` 的逐字节
输出）、`tests/run.js` 91、`tests/sexpr` 53、`tests/oir` 451、`tests/llvm` 22、
`tests/jit` 22、`tests/gpu` 15+1 skip、`tests/js-roundtrip` 92、`tests/oracle` 7、
`tests/js-exec` 11、`tests/cabi` 4、`tests/wat` 12 —— 全绿。`tests/mir` / `tests/glr` /
`tests/incr` 照旧红（先于这几刀），`tests/bootstrap` 跳过。

### 一批：遮挡那一档、`from T unravel <类型>`、构造与同名函数同一个重载集，与三维输出面（`import three;` 63 -> 25）

这一批是六刀合一批推的，都是从 examples 那道坡上量出来的（每条后面都记着量它的那一行）。

**遮挡那一档（第六十四刀）。** `asyFit` 现在多记一格 `shadow`：这次匹配里有几个实参是靠
**被遮住的那一格**接上的（`shadowVar` / `shadowFns` / `shadowName`，而且接的**不是**这个值
自己的类型）。`asyApplyCall` 的分档次序也跟着变成"可变形参 -> 遮挡 -> 代价 -> 内建弱"——
asy 的名字解析先看最里那一层，被遮住的那一格只是退路。量出来的形状是 bezulate.asy:64：

```asy
int bez(path[] p) { path p2=(0,0)--(1,1); path p=p2; return size(p); }
```

局部的 `path p` 遮住了形参 `path[] p`，`int size(path)` 与 `int size(path[])` 两边代价都是 0，
不分档就报"有多个同样合适的重载"。

**"接的不是自己的类型"这半句是量出来的**：`shadowName` 是 nameOf 给**每一个**文件级变量
都挂上的（同名的可能有好几格），同型时它指的就是这个值自己。少了这半句，`dot(a,b)`
（两个文件级 triple）里内建那份 shadow=2、`void dot(…, triple v, light light, …)` shadow=1，
于是代价 1 的那份反而赢了 —— graph3.asy:84 的 `dot(align,sign*locate1.dir) >= 0` 就是这么
变成 void 的。

**`from T unravel N;` 里 N 是 T 体里的类型（第六十五刀）。** geometry.asy:5616/5617 的
`side` 与 `vertex`。落法是"记一条 typedef"（`bringTy`）—— 嵌套 struct 的真名本来就记在外层
那张 `rec.tyAlias` 里（见 recNested）。要紧的是**在声明遍就落**（modules.js 的 asyModStmt
里那一句）：后面那些函数的**签名**里就要用这个名字（5658 的 `point operator cast(vertex V)`），
而签名是声明遍读的。

这一条还揭出一件事：`import geometry;` 从前印 14 条诊断，是因为 5658 那条声明遍的错**盖住了
后面所有的**。真的尾巴是 31 条 —— 上一批 ADR 里写的"masked artifact"那一课又来了一次。

**构造与同名函数在同一个重载集里（第六十六刀）。** geometry.asy:5713 的
`triangle triangle(line,line,line)` 与 struct triangle 的 `void operator init(point,point,point)`
在 asy 那边是同一个重载集；这个前端从前是"名字是函数就不看构造"，于是 `triangle(P1,P2,P3)`
报"没有能匹配的签名 —— 有的是 triangle(line, line, line)"（15 处）。现在函数那族都接不住时
再让 `asyCtorCall` 试一次（probe + 回滚）。同一条修好了 `material(pen, emissivepen=pen)`
（linearregression / genustwo / genusthree / label3zoom 四个例子）。

**struct 体里给裸名字赋值也算"当成员赋值"（第六十六刀）。** `memAssigned` 从前只认
`X.name = …`；three_surface.asy:261 的 `external=externaltriangular;` 在 patch 自己的
`void init()` 里，赋的是同一个体里**有体的方法**（:28）。只在 recorddec 的子树里认这一种 ——
整个单元都认的话，随便一个同名局部量的赋值都会把一个方法摊成字段（每个实例多一个闭包）。
配套的一条是：方法体里"读一格函数类型的字段再间接调"这一档接不住时要**回滚**再往下走，
不然 three_surface.asy:347 的 `point(external,0)` 会撞在同名的那格字段
（`triple point(real,real)`）上，而它要的是文件级的 `triple point(path3,real)`。

**没有内建形态的算符不受"内建赢"那道闸管（第六十七刀）。** `asyOpUser` 里有一条
"用户那份不同型、而内建那份接得住时让内建赢"的闸（防的是库里的重载把内建的加减乘除偷走）。
`^^` 与 `@` 根本没有内建形态，那道闸于是变成"要转换就一律拒"：
`(0,0,0)--(1,0,0) ^^ (0,1,0)--(1,1,0)` 两边是 guide3，要走一次
`path3 operator cast(guide3)` 才落到 `path3[] operator ^^(path3,path3)` 上（three.asy:2003）。
现在这两个名字进 `ASY_OPNOBI`，不给 btys。

**三维输出面（第六十七刀）。** runpicture.in:296-780 那一段：`_draw(frame,path3,…)`、
Bezier 面片与三角面片的 `draw`、NURBS 曲线与曲面、`drawSphere`/`drawCylinder`/`drawDisk`/
`drawTube`/`drawpixel`、三角网的 `draw`、`_begingroup3`/`endgroup3`/`beginTransform`/
`endTransform`，加 runpath3d.in 的 `minratio`/`maxratio`/`unstraighten` 与
`frame operator *(real[][], frame)`。asy 那边它们是往 picture 的节点表里塞一个三维绘图对象；
这一层**只记界** —— frame 上多了 `has3` / `min3v` / `max3v` / `minr` / `maxr` 五格，
后两格是 x/z、y/z 的比（picture.cc:339 的 ratio，投影层的 fit 要它）。

**代价写在明处**：三维图的**内容**这一层落不下来（EPS 写出来是空的），但整棵
three / graph3 / solids 树的正文能跑到底，界与投影算得出真数。真出图是另一刀。

**那批内建。** `map`（runarray.in:979 的 arrayFunction，asy 那边是一格泛型内建，这里按真用到
的七组类型各写一份）、`gamma`（Lanczos g=7 那组系数，负半轴走反射公式）、`abs2`、
`bool operator ^`（异或）、`newton` 的两格（runarray.in:1622/1670 逐句照抄）、`sum` 五格、
`concat` 的 pen/triple/bool 三格、`mintimes`/`maxtimes`（path 与 path3），
以及 `dot(pair,pair)` / `dot(triple,triple)` —— 后两个从**写死在前端里**挪进了内建面，
理由见上面遮挡那一段。`_image` 与 `_labelpath` 只给声明、体是 abort（图像与沿路径排字要真的
输出层）：有了声明，palette / labelpath 这两个模块才装得上。

`settings` 补了 20 格（`keep` / `paperwidth` / `paperheight` / `digits` / `prerender` /
`toolbar` / `twosided` / `thick` / `autobillboard` / `ibl` / `image` / `hyperrefOptions` …），
类型与默认值逐个照 settings.cc 的行号抄。

**`gamma` 那条边界挪了。** `tests/asy/bad/gamma` 从前钉的是"宿主数学库里没有的内建就报错"；
这一批用 asy 自己写了一份 Lanczos，六条腿共用，所以那个 case 撤了，值改由
`cases/142-unravelty` 与真 asy 对齐（`gamma(5)` / `gamma(2.5)` / `gamma(0.5)` / `gamma(-1.5)`
四个点）。

**量出来的一件事要记下来**：examples 那道坡从前是按"有没有 `文件:行:列` 那样的诊断"数的，
而 `abort` 与运行期错误**不长这个样子**（退出码 70，输出是 `abort: …`）。这一批起改成
"诊断 / 非零退出码 / 干净跑完"三分，数字因此比从前保守。

按这把新尺子重量一遍 220 个例子：**干净跑完 74、还在报诊断 136、跑起来但非零退出 10**
（8 个是 `abort:`，多半是三维那几格只给声明的输出内建；2 个退 1）。模块那一层，
`import plain / graph / math` 三条 0 诊断，`import three;` 63 -> 25、`import geometry;`
31 -> 4、`import graph3;` 71 -> 42、`import solids;` 77 -> 47、`import palette;` 4、
`import bezulate;` 0。

### 一批：量得快的那把尺（9 分钟 -> 3.7 秒）、快照漏回去的那一格，与 `? :` 按目标类型定案

这一批的主角是**工具**：`tests/asy/sweep.js`。220 个例子从前是一个进程一个 —— prelude 与
plain/graph/three 那一摞每次重降一遍，跑完 9 分钟，"改一刀量一遍"的循环没法用。现在
语法表、AST、以及热身那一摞模块的降级结果都只做一次，每个例子从同一张镜像的一份拷贝起降：
**220 个 3.7s，最慢一个 241ms**（不用并发）。

**热身要用 `access` 而不是 `import`。** 这一条是量出来的：`import stats;` 会把 stats 的名字
摊进 0 号单元，它的 `N`、`E` 遮住 plain 的同名量，例子里于是冒出三十来条
`label(string,pair,real[])` 匹配不上的**假**诊断。`access` 只把模块降出来（缓存住）、不摊名字，
这才与"一个例子一个进程"那一趟对得上。

**快照漏回去的那一格（真 bug，REPL 也吃它）。** `AsySession.snapshot()` 里
`globals: new Map(u.globals)` 是**浅**的 —— 那张表的值是数组，而声明是
`list = m.get(k) ?? []; list.push(g); m.set(k, list)` 这么攒的，push 进去的那一格于是从快照的
背面漏了回去。量出来的样子：`NURBSsphere.asy` 里的 `real[] W` 到 `equilateral.asy` 还看得见，
`label("$B$",b,W)` 报"没有能匹配 `label(string, pair, real[])`"。它还有一层障眼法 —— 位置解析
（`g.at <= L.at`）让漏进来的那一格只在**后面几句**才可见，所以同样的代码短了一句就复现不了。
现在 funcs / globals / casts / oinits / tyAlias 五张都按数组拷（`copyAsyLists`），
另外补了一个 `cloneSnap(s)`：同一张快照要回滚多次时先拷一份（快扫正是这么用的）。
这一刀单独把例子那一面从 **干净 145 抬到 174** —— 之前那 29 条是量错了，不是真诊断。

**`? :` 按用处那一侧给的目标类型定案（第七十四刀）。** asy 那边这是两条路：有目标类型时走
`conditionalExp::transToType`（exp.cc:1280）—— 两支**各自**转到目标去，根本不求公共类型；
没有目标才求 `promote`（:1357）。这个前端从前只有后一条，于是
`bool3 branch(...) { return b ? true : default; }`（examples/oneoverx.asy:13）报"两支要同型"：
bool 与 bool3 **两个方向**的 cast 都在（plain_constants.asy:118 与 :123），求公共类型就是歧义。
现在 `asyCondPick` 先问 `condWant`（探一遍两支能不能都转过去，诊断与前置语句都丢掉），
定不下来又没有目标类型时**回一格待定的值**，等 `asyCoerce` / `asyCall` 那一侧拿目标类型
重降一遍（`asyCondAt`）。量过真 asy：两个方向都能转的一对记录，`A f(…){return c?x:y;}` 与
`B g(…){return c?x:y;}` 都收，回的类型跟着**返回类型**走 —— `cases/131-cond-target-type`
就是这一条（floor / gamma / oneoverx 三个例子）。

**复数上的 sin / cos（runpair.in:208 与 :213）。** `pair sin(explicit pair)` /
`pair cos(explicit pair)` 两格，逐句照抄。`explicit` 那一格是要紧的：不带它就把 `sin(2.0)`
抢过去了（asy 那边同名注册两格正是为这个）。`cases/132-pair-sincos` 与真 asy 逐字节一致
（sin3 / cos3 两个例子）。

跑齐的轴：`node tests/asy/run.js` 221/221（run 与 run-llvm 两条腿，新增 131/132 两条 case）；
`tests/asy/sweep.js` 例子面 **干净 179 / 有诊断 41**（3.7s，最慢 241ms）；模块面
`import plain / graph / math` 各 0、`import three;` 5、`graph3` 5、`solids` 5、geometry 3、
contour 2、palette 4、stats 3、patterns 1。没跑的轴：输出层的逐字节比对（EPS/SVG）还没做，
`shipout3` 那两条仍在名单上。

### 一批：内建的名字当函数值、同一层里同名的局部函数（例子面 179 -> 183）

**`abs` 摆进内建面（第七十五刀）。** 这个前端本来把 `abs` 写死在调用那一层（calls.js 的
mathCall 里三条 `if`），于是它**没有符号**、当不了函数值：`s.map(abs)`
（examples/cheese.asy:11、pOrbital.asy:25、sphericalharmonic.asy:13）报"要 real(triple)，
而这个名字的那几个重载里没有同型的一份"。现在内建面里摆四格真函数（int/real/pair/triple，
`abs(pair)`/`abs(triple)` 就是模，量过与 `length` 同值），名字于是有候选、`(fnref …)` 拿得到。
直接调那一层照旧先挑这里的精确匹配 —— `abs(-3)` 还是 int（`cases/134` 连这一条一起钉住）。

**同一层里同名的局部函数按签名分（第七十五刀）。** contour3.asy:229 与 :245 是两个
`setupweighted`（六个形参与两个形参），:279 那些调用在**里层** `checkpyr` 的体里。
asy 的 venv 是按签名逐层找的，同名两格能共存；这个前端的局部量是一格一个名字，
第二份声明把第一份遮住了（declareShadow 记下了被遮的那一格），于是六个实参那句报
"'setupweighted' 是 weighted(triple,int[])，要 2 个实参，给了 6 个"。两处都补上了：

- 同一层里直接调：先试当前那一格，接不住**回滚**再试 ov 那一格（与"形参遮住同名函数"
  那一档同一个路子）。
- 里层闭包里调：`asyCapSlot` —— 被遮的那一格也能抓，捕获那一栏给它一个**新名字**
  （`asy__ovN_…`），不然两格撞在同一个键上、抓到的是遮住它的那一份。挑哪一格是**硬数
  形参个数**：`asyArityBad` 在"没有同名的文件级候选"时是直接放行的（它防的是另一件事），
  这一档数不了它，所以自己数一遍（`asyPlainArgc`）。

`cases/133-localfn-overload` 把两处一起钉住（同层直接调 + 里层抓进来调），与真 asy 逐字节一致。

跑过的轴：`node tests/asy/run.js` 223/223（run + run-llvm 两条腿；新增 cases/133、134）；
`tests/asy/sweep.js` 例子面 **干净 183 / 有诊断 37**；模块面 `import plain / graph / math`
各 0、three 5、graph3 5、solids 5、geometry 3 -> **2**、contour 2、palette 4、stats 3、patterns 1。
没跑的轴：输出层的逐字节比对（EPS/SVG）还没做。

### 一批：函数值上的命名实参、两格局部函数按类型挑，与 `from T unravel <static>`（例子面 183 -> 188）

**命名实参也能通过函数值传（第七十六刀）。** asy 的函数**类型**是带形参名的
（`typedef void ticks3(…, bool opposite=false, bool primary=true, projection P);`，
graph3.asy:69），所以 `ticks(d,t,"",…,opposite=true,primary=false,P)`（grid3.asy:205）
调的是一个值也照样按名字落格。这个前端从前在那一档直接报"函数值没有形参名"。现在先拿
`asyFnValFit`（它读的正是 `L.fnDefs` 里那份形参名）排一遍，一格不缺时按排好的顺序发调用；
排不出来才照旧报那句。三个例子（elevation / projectelevation / smoothelevation）到齐，
顺手把 three_arrows.asy 的 `forwards=` 那一条也带出去了 —— 模块面的 three_arrows 归零。

**同一层里两格局部函数按**类型**挑（第七十六刀）。** 上一批那一刀只会数形参个数，而
smoothcontour3.asy:95 与 :109 的两个 `addtocoeff` 形参个数一样（都是 4 个），只有最后那一格
分得开（triple / real）。现在给两格各打一次分（`asyValFitCost`：同型 0、内建提升 1+、
用户 cast 3，接不住 -1），分低的赢；实参类型是 `probeType` 探出来的（诊断与前置语句都回滚）。

**`from T unravel x;` 里 x 也可以是体里的一格 static（第七十六刀）。** static 那一格本来
就是一个全局（asyStaticDec 的 `g`），所以摊出来就是往文件级挂**同一格** —— 与 `autounravel`
那一条落在同一个地方，位置换成这一句的位置。smoothcontour3.asy:35-38 那个"拿 struct 当
命名空间"的写法靠它（`private from pathwithnormals_settings unravel wildnessweight;`），
genustwo 与 genusthree 两个例子到齐。`cases/136` 连"改了摊出来那一格，`T.x` 那边看见的是
同一个值"一起钉住。

顺带一条**诊断指向**：局部那一格函数接不住、而文件级同名候选一个都没有时，把这一格的诊断
照原样发出来。不然会一路落到"内建函数 '…'（这一刀只有 write 和你自己定义的函数）"上 ——
量出来的样子是 smoothcontour3.asy:193 报"内建函数 'addtocoeff'"，而真正接不住的是第 4 个实参
（那时 `wildnessweight` 还没摊进来）。

跑过的轴：`node tests/asy/run.js` 225/225（run + run-llvm 两条腿；新增 cases/135、136，
两条都与真 asy 逐字节一致）；`tests/asy/sweep.js` 例子面 **干净 188 / 有诊断 32**；模块面
`import plain / graph / math` 各 0、three 7、geometry 2、contour 2、palette 4、stats 3、
patterns 1（three_arrows 归零）。没跑的轴：输出层的逐字节比对（EPS/SVG）还没做。

### 一批：记录里放自己那一格（自引用字段，例子面 188 -> 189）

**`struct N { N next; }` 收了（第七十七刀）。** 从前拦在字段类型那一关，理由写在
`bad/struct-self` 里：隐式 `operator init` 要把内嵌的记录**造出来**，自引用就是无限递归。
量过 `asy -noV`：asy 的字段是懒的，`N a;` 之后 `a.next` 就是 null，`a.next.next == null`
也是 `true`。所以这一刀不是去做懒构造，而是**在生成构造函数的过程里记一笔**：`recNew` 往
`recBusy` 里放当前这个记录名，字段那一档改成 `if (this.isRec(f.type) && !this.recBusy.has(f.type))`
—— 正在造的那个类型的字段不预造，留 null；`(ret (var this))` 之后把它从 `recBusy` 摘掉。
`recBusy` 记的是**这一条生成路径**（一个栈，不是单个名字），所以嵌套着造也不会漏。
两个记录互相指是量不出来的：asy 没有 `struct A;` 这种前向声明（`asy -noV` 报 syntax error，
我们这边同样拒），所以自引用只有"自己指自己"这一种形状。核心方言那边本来就接得住
（`{ v: 0n, next: null }`），不用动。

拦那一关时是"字段类型不合法"，现在这条边界挪成了"字段的**值**默认是 null"，语义与 asy 对上：
bsp.asy:151（`node[] out`，里面又指回 `node`）和 drawtree.asy:9 都是这个写法。treetest 到齐，
colorplanes 往前走到 bsp.asy:138 的 `operator --(pair[])`；模块面 three / graph3 / solids
各少一条（都是 three.asy 里那个自引用的结构）。`bad/struct-self` 这条负例连同它自己写的
"等哪一刀把空引用做进来，这条边界才该挪"一起退役，正例挪进 `cases/137`（自引用那一格排在
前头、排在后头、以及通过 `T[] kids` 绕一圈的三种都钉住）。

跑过的轴：`node tests/asy/run.js` 225/225（run + run-llvm 两条腿；新增 cases/137 与真 asy
逐字节一致，退役 `bad/struct-self`，所以总数不变）；`tests/asy/sweep.js` 例子面
**干净 189 / 有诊断 31**（2.2s，最慢 159ms —— 两条速度线都还在）；模块面
`import plain / graph / math` 各 0、three 4、graph3 4、solids 4、geometry 2、contour 2、
palette 4、stats 3、patterns 1。没跑的轴：输出层的逐字节比对（EPS/SVG）还没做。

### 一批：两个漏了的内建 `straightness` 与 `nurb`（例子面 189 -> 191）

**"递归"那句诊断指错了地方。** tube.asy:16 的 `Split` 报的是"抓外层的 `f`，而它自己是
递归的"，可把 `localFunClo` 里那次回滚临时关掉一量，真正接不住的是体里第一句
`straightness(z0,c0,c1,z1)` —— 这个内建在这一份内建面里根本没有。同理 three.asy:1368 的
`nurb`：那个局部 `nurb(triple×4)` 压根不是递归的，它体里调的是**内建的**
`nurb(pair×4, real×4, int)`，而内建那一格也没有，于是落到"没有能匹配"上、再被外面那层
当成递归失败。教训是一样的：探测式回滚把真因藏起来了，所以这两刀都是先把回滚掀开看一眼。

**straightness（第七十八刀）。** 两格，照 runpath3d.in:183/189 与 triple.h:398 的
`Straightness`：`v=(z1-z0)/3`，取 `|c0-v-z0|²` 与 `|z1-v-c1|²` 里大的那个（是**平方**，
不开根）；`straightness(path3,int)` 那一格直段直接 0。

**nurb（第七十八刀）。** path.cc:1310 那一份原样搬：有理三次 Bézier 按 m 等份采样出
m+1 个点，两头的控制点是 `2/3·z + 1/3·邻点`，中间那些结把 pre/post 摆成过该点的**同一条
方向**上（`dir=unit(pos-pre)`，两侧各留原来的长度）。结点直接 push 进 `path.nodes`、
`joins` 空着 —— 按 struct path 那条约定（joins 与段数不齐时一律按"控制点已定"走），
正合适。逐字节量过 4 段那一例的 point / precontrol / postcontrol。

pipes 与 trefoilknot 两个例子到齐（都停在 tube.asy:16），模块面 three / graph3 / solids
又各少一条。`cases/138` 把两个内建的数都钉住。

跑过的轴：`node tests/asy/run.js` 226/226（run + run-llvm 两条腿；新增 cases/138 与真 asy
逐字节一致）；`tests/asy/sweep.js` 例子面 **干净 191 / 有诊断 29**；模块面
`import plain / graph / math` 各 0、three 3、graph3 3、solids 3、geometry 2、contour 2、
palette 4、stats 3、patterns 1。速度这一趟本机负载高（load average 8~9，另有两个进程各占
满一核），所以拿 HEAD 与改后交错各跑两趟对照：HEAD 4.7s/7.8s、改后 2.9s/4.5s —— 慢的是
机器不是这一刀。没跑的轴：输出层的逐字节比对（EPS/SVG）还没做。

### 一批：`slant` / 变换的幂 / 内建的形参名 / 数组对标量比（例子面 191 -> 195）

四刀都小，都是量出来照抄：

- **`slant(real)`**（runtime.in:1219）：`(0,0,1,s,0,1)`。triangle 到齐。
- **变换的幂 `t^n`**：n 次复合，负数先求逆。要紧的是**从 identity 起乘**而不是从 t 起 ——
  量出来 `shift((1,2))^-1` 是 `(-1,-2,1,0,0,1)`，而 `inverse(shift((1,2)))` 是
  `(-1,-2,1,-0,-0,1)`，差在那个 `-0` 上（identity 乘一遍时 `-0 + 0` 就成了 `+0`）。
  fjortoft 到齐。
- **内建也有形参名**：C++ 那边的内建是带 `formal(…, "n")` 的，所以 `array(n=6,value=1)`
  （SierpinskiSponge.asy:42）在 asy 那边照样落格。这一层的内建没有形参名那份表，于是只把
  量出来要的那一个记进 `ASY_BLT_NAMES`（`array` 的 `n` / `value`），名字都对得上时
  `asyBuiltinKeyed` **就地**把 raw 排成位置序，往后的路与不带名字那一档一模一样。
- **数组对一个标量的 `==` / `!=`**：`>` / `<` 那一族早就有标量档了，`==` / `!=` 漏了。
  pdb.asy:34 的 `find(Element == e)` 就是这一格。

**顺带修一条真错：`记录 != null` 被重载抢走。** 加完上面那一族之后 genustwo / genusthree
反而炸了：smoothcontour3.asy:529 有 `string operator cast(positionedvector)`，于是 :1096 的
`xdirzeros[i][j][k] != null` 去匹配了 `bool[] operator !=(string, string[])`（左边 cast 成
string、右边 null 当 string[]），答成了 `bool[]`。asy 那边这一句是**身份比较**，所以在
`asyCompare` 里把这一档拦在用户重载之前：一支是 null、另一支是引用类型（记录/数组/函数）时
直接走 `asyCmpCode`。`cases/139` 把这条也钉住（带一格到 string 的 cast 的记录）。

**没做的那一刀（说清为什么）：`a.initialized(i)`。** splitpatch.asy:29 要它，写起来也就十几行
（runarray.in:799 的规则：cyclic 且非空时先 imod、越界 false、界内问这一格空不空）。但这一层
长数组时把空档填成了**造好的零值**（`arrHelper` 的 zero：记录 `(cnew …)`、数组 `(anew … 0)`），
不是空引用 —— 空档与真放过值的那一格在运行期分不开，而 splitpatch 要的恰好是空档那一档。
量过：写出来 `a.initialized(0)` 会答 true 而 asy 答 false。所以这一刀**收回**了，只把诊断
换成说得准的那一句；等哪一刀把"空槽"做进方言（asy 那边读空档是运行期错），这条才该开。

跑过的轴：`node tests/asy/run.js` 227/227（run + run-llvm 两条腿；新增 cases/139 与真 asy
逐字节一致）；`tests/asy/sweep.js` 例子面 **干净 195 / 有诊断 25**（2.5s，最慢 291ms ——
两条速度线都在）；模块面 `import plain / graph / math` 各 0、three 3、graph3 3、solids 3、
geometry 2、contour 2、palette 4、stats 3、patterns 1（这一批模块面没动）。
没跑的轴：输出层的逐字节比对（EPS/SVG）还没做。

### 一批：文件级循环里的闭包也能抓循环变量（例子面 195 -> 196）

装箱（长度 1 的数组、读写都穿过去 —— 那是 asy 的按引用捕获）从第七十二刀起就有了，但只在
**函数体里**发生：判据 `asyNeedsBox` 一上来就问 `L.fnBody`，而文件级那一档它是 null，于是
`capOf` 里 `L.cap.body === null` 一律拒。这一刀只补那一段"给判据看的体"：`asyForStmt` 与
`asyForEach` 在 `L.fnBody` 为空时把**循环节点本身**当那一段（init / test / upd / body 都在
里面，正好覆盖"闭包自己改它"与"闭包之后再改它"两问），出去时还原。

两种循环落到的档不一样，都对：

- C 式 `for(int i=0;…;++i)`：`++i` 在循环节点里，`asyNeedsBox` 答"要装箱" —— 于是
  `i` 成了一格箱子，闭包抓走箱子，里外同一格。soccerball.asy:57 靠它。
- `for(T x : a)`：循环变量是**每轮新绑一格**的（`(let nm … (aget …))` 在体里面），
  扫下来一处赋值都没有，于是照旧按值抓 —— 一样对，而且不多一层间接。

truncatedIcosahedron 往前走过了这一关，停在 `operator --(...triple[])`（与 colorplanes 的
`operator --(pair[])` 同一族，另一刀）。

跑过的轴：`node tests/asy/run.js` 228/228（run + run-llvm 两条腿；新增 cases/140 与真 asy
逐字节一致，把两种循环各钉一格）；`tests/asy/sweep.js` 例子面 **干净 196 / 有诊断 24**
（2.1s，最慢 132ms）；模块面 `import plain / graph / math` 各 0、three 3、graph3 3、
solids 3、geometry 2、contour 2、palette 4、stats 3、patterns 1（这一批模块面没动）。
没跑的轴：输出层的逐字节比对（EPS/SVG）还没做。

### 一批：`... a` 整份接进可变形参时也走数组级的 cast（例子面 196 -> 198）

asy 给每一对 `operator cast(A)->B` 顺带生一份 `B[] operator cast(A[])`（arrayToArray 那一族），
所以 `operator --(... pair[])`（bsp.asy:138）在那边接得住 —— 元素是 pair、形参那一格要
`guide[]`。这一层从前在 `packCost` 里写的是"`... a` 的类型得与那一格**一模一样**"，把这一句
拦了。改成拿那一格的**数组类型**去问 `castFor`：`path[] operator cast(pair[])` 就在这一层的
内建面里（asy_builtins.asy:2982），于是接得住。colorplanes 与 truncatedIcosahedron 到齐。

**只问 cast、不问内建提升**，这一条是量出来的边界：`total(... int[])` 落在
`real total(... real[])` 上 asy 收（元素级提升），但这一层的 coerce 还不会逐格提升一个数组 ——
认下来只会在核心方言那边炸。所以那一档照旧不接（asy 收我们拒，写在这里）。反过来
`sum(... real[])` 落在 `int sum(... int[])` 上两边都拒。用户自己写的 `operator cast` 也**不**
顺带生数组那一份（量过：`int total(... W[])` 收不下 `... int[]`，asy 报
"cannot call … with parameter '... int[]'"），与这一层一致。

**顺带一处真错。** 打开这条路之后立刻炸了：`asyUserCall` 那个包实参的分支里，`... a`
是**原样**塞进包的（`packed.push({ code: r.v.code, spread: true })`），只把类型改了名、
码没转 —— 于是核心方言那边报 `arr<path> 的初值是 arr<vec<real,2>>`。补上一遍 coerce
（另一处 `asyFnValCall` 的包分支本来就有）。

顺带记一条**尺子的盲点**：`tests/asy/sweep.js` 数的是**前端**那一层的诊断，核心方言那一层
的错（`xxx.asy.sx:行:列`）它不数 —— 所以上面那处真错在例子面上看不见（那两个例子照旧
"干净"）。这一批是靠单文件手跑撞见的。要补的话得让 sweep 也把 `.sx` 那一层的错算进去。

跑过的轴：`node tests/asy/run.js` 229/229（run + run-llvm 两条腿；新增 cases/141 与真 asy
逐字节一致）；`tests/asy/sweep.js` 例子面 **干净 198 / 有诊断 22**（1.5s，最慢 132ms）；
模块面 `import plain / graph / math` 各 0、three 3、graph3 3、solids 3、geometry 2、
contour 2、palette 4、stats 3、patterns 1。这两个例子端到端跑还停在 three.asy:2755
（模块面那 3 条里的一条），也就是说"例子面干净"目前只等于"例子自己那一份没诊断"。
没跑的轴：输出层的逐字节比对（EPS/SVG）还没做。

### 一批：尺子补上核心方言那一层（`OMNI_SWEEP_SX=1`，例子面 198 里真能过的只有 170）

上一批末尾记的那个盲点补上了：`tests/asy/sweep.js` 从前只数**前端**那一层的诊断，
"前端认下来、核心方言那边才炸"的错在例子面上看不见。加一档 `OMNI_SWEEP_SX=1`：例子的
前端那一趟干净之后，把降出来的那份 `.sx` 再过一遍 `lowerCoreSexpr`。

两处坑都是量出来的：

- **只检查增量会冒出一堆假错。** `sess.add` 回的是这一趟的增量文本，记录类型那些声明在
  热身那一段里 —— 单独读增量，方言那边报的是"类型只能是 …"。所以要把热身那一段
  接在前面（`spliceMod`）。
- **两份都带 `(main …)` 时只会报一条。** 一份模块"(main …) 只能有一个"，接起来之后
  每个例子都只报这一条，底下真正的错一条也看不见。所以 `modHead` 剪掉热身那一份的
  `(main …)`（顶层形式顶在 2 个空格那一列，按 `\n  (main` 找最后一处）；热身那一段
  **整份**的方言错另算一行报（现在 18 条），例子的错按行号（`warmLineN`）与它分开。

量出来的结果值得记：例子面"干净 198"里，**核心方言那一层过得去的只有 170** —— 差的 28 个
全是同一个根：`未声明的函数 asy__m23_asy__ov1_palette`（25 个）、`asy__m23_asy__ov2_palette`、
`asy__m23_asy__ov2_image`、`asy__m23_asy__ov6_image`、`asy__m22_asy__ov4_contour` 各 1。
palette.asy 与 contour.asy 里那 4+2 条模块诊断把这几个函数的**体**降没了（体没降出来就
没有那一份 `(fn …)`），例子照旧把调用发出去，于是方言那边找不到人。也就是说
"模块面那几条"不是孤立的，它挡着 28 个例子 —— 下一批的头号目标。

这一档慢一档（每个例子都要重读几万行方言文本）：220 个 55s、最慢 708ms，所以**不是默认**。
默认那一趟照旧 1.3s、最慢 90ms，10s 的线没动。

跑过的轴：`node tests/asy/run.js` 229/229（run + run-llvm 两条腿）；`tests/asy/sweep.js`
默认档例子面 **干净 198 / 有诊断 22**（1.3s，最慢 tvgen.asy 90ms），模块面
three 6、geometry 2、contour 2、palette 4、stats 3、patterns 1（热身那一趟按文件报的口径）；
`OMNI_SWEEP_SX=1` 那一档 **干净 170 / 有诊断 50**（54.5s），模块面方言那一层 18 条。
没跑的轴：这一批只改尺子、没动前端，所以没有新的 `tests/asy/cases`；输出层的逐字节比对
（EPS/SVG）还没做。

### 一批：二维的 `min`/`max` 与"被遮住的那一格才是函数"（方言那一层 170 -> 196）

上一批那把新尺子指的地方：palette.asy 那 4 条模块诊断挡着 25 个例子。这一批把它砍到 1 条。

**二维的 `min`/`max`。** builtin.cc:543 的 `addOrderedOps` 对每个有序基本类型摆的是**四份**
（两元、一维、二维、三维），这一层从前只摆了前两份。palette.asy:75 与 :270 的 `min(f)`、
`max(f)` 要的是二维那一份（`real[][]`）。补 int/real/string 三对，语义照 arrayop.h:90 的
`binopArray2`：**空的那一行跳过**，一行值都没有才算空数组 —— 所以
`min(new real[][] {new real[], new real[] {1}})` 是 1，不是报错。三维那一份 base 里没人用，
照旧不摆。

**被遮住的那一格才是函数。** palette.asy:300 的
`void palette(…, axis axis=Right, pen[] palette, …)` 体里第 309 行又写了一句 `axisT axis;`，
紧接着 :310 是 `axis(pic,axis)` —— 被**调**的是形参那一格（函数类型 `axis`），当**实参**的
才是刚声明的 `axisT` 那一格。asy 的 venv 是按签名逐层找的：一个有签名、一个没有，两格共存，
取哪一格看用处。这一层的 `declareShadow` 早就把被遮住那一格记在 `\u0000ov:` 里了，但
calls.js 里只在"**这一格自己**是函数类型"时才去试 ov，于是这一句落到文件级的
`void axis(picture, Label, path, …)` 上，报"没有能匹配 `axis(picture, axisT)` 的签名"。
补一档对称的：这一格不是函数、ov 那一格是函数时，拿 ov 那一格试一遍（照旧是探一次、
接不住就回滚）。

量出来的差：方言那一层 **170 -> 196**，只剩 Gouraudcontour 与 imagehistogram 两个 ——
它们与 palette/contour 剩下的那两条诊断同一个根：内建 `triangulate`（Delaunay.cc 那一份）
还没有。contour.asy:478 的"捕获会被改的外层变量 `edge`"是另一件事。

跑过的轴：`node tests/asy/run.js` **230/230**（run + run-llvm 两条腿；新增 cases/142 与真
asy 逐字节一致）；`tests/asy/sweep.js` 默认档例子面 **干净 198 / 有诊断 22**（1.7s，最慢
genusthree.asy 155ms）；`OMNI_SWEEP_SX=1` 那一档 **干净 196 / 有诊断 24**（58.8s），
模块面方言那一层 18 -> 17 条；模块面前端诊断 three 6、geometry 2、contour 2、
**palette 4 -> 1**、stats 3、patterns 1。没跑的轴：输出层的逐字节比对（EPS/SVG）还没做。

### 一批：内建 `Floor` 与"`unravel` 摊进来的那一条也是按签名遮的"（stats 3 -> 0、geometry 2 -> 1）

**`Floor`**（runmath.in:243 → path.h:31 `(Int) floor(Intcap(t))`）：与 `floor` 的差别只在
**超出 int 范围时不报错** —— 先按 Intcap（path.h:21）夹到两端再取整。stats.asy:78/114/132
的分桶用它，少了它 `histogram` 那三个函数的体一份都降不出来。
夹过头那一档**不逐字节跟**，写在代码注释里：asy 那边 `(double)intMax` 舍成 2^63、转回 Int 是
UB，落到 common.h:106 留给 Undefined 的那一格上，于是**用**那个值时报 "Trying to use
uninitialized value"（量过 `write(Floor(1e30))` 就是这一句，而 `floor(1e30)` 报的是
"Integer overflow"）。这一层照 Intcap 的原意回 intMax / intMin。`Ceil` 与 `Round` base 里
一处都没用，照旧留在 builtins.tab 的 nope 那一档。

**`unravel` 摊进来的那一条也是按签名遮的。** geometry.asy:347 的 `unravel R;` 把 coordsys
的字段 `real dot(pair,pair)` 摊了进来，:355 那句 `dot(pic, O, dotpen)` 要的却是
plain_markers.asy:329 的 `void dot(picture, pair, pen, filltype)`。calls.js 里 alias 那一支
从前是**直接 return**（"调的是 x 那个字段里的函数值"），于是报
"'dot' 是 real(pair,pair)，要 2 个实参，给了 3 个"。改成与它下面那两支同一个办法：先试这一格，
接不住就回滚往下走文件级候选。

顺带量清了两条边界：

- `explicit` 形参**不收 cast**（application.cc:30 `castable`：`target.Explicit ?
  equivalent(...) : e.castable(...)`）—— 这一层的模型与它一致，逐字节量过一个最小例子
  （`int f(explicit A a)` 收不下 `B`，两边都报错）。
- `unravel` 摊**方法**（不是函数类型的字段）这一层还不支持：`struct S { int f(int a){…} } S s;
  unravel s; f(3)` asy 回 4，这一层报"内建函数 'f'"。geometry 那一处是**字段**，所以这一批不
  碰它；记在这里当已知的洞（诊断也指错了地方，将来一起修）。

geometry.asy:1588 的 `unit(M) * l.A`（`vector * point`）还剩一条：asy 收下了，而
geometry 里 37 条 `operator *` 里没有 `(vector, point)` 那一条，能沾上的 `point
operator *(explicit point, explicit point)`（:630）两边都是 `explicit`、按上面那条规则不收
`vector`。asy 到底落在哪一条还没量出来，先不猜 —— 它眼下不挡任何例子（深一格那一档里
geometry 一个例子都没炸）。

跑过的轴：`node tests/asy/run.js` **232/232**（run + run-llvm 两条腿；新增 cases/143、144
与真 asy 逐字节一致）；默认档快扫例子面 **干净 198 / 有诊断 22**（3.1s，最慢
genusthree.asy 202ms —— 这台机器当时 load 17，同一份代码空载时是 1.7s/155ms）；
`OMNI_SWEEP_SX=1` 那一档 **干净 196 / 有诊断 24**，模块面方言那一层 **17 -> 12 条**；
模块面前端诊断 three 6、**geometry 2 -> 1**、contour 2、palette 1、**stats 3 -> 0**、patterns 1。
没跑的轴：输出层的逐字节比对（EPS/SVG）还没做。

### 一批：核心方言加一个 `(readtext E)`（读文件的唯一一个口子）

asy 那 5 个停在文件输入上的例子（worldmap、filesurface、fequlogo、galleon、triceratops）
要的是 `file in=input("worldmap.dat").line();` 那一族。里面**只有一件事**方言办不到 ——
把字节拿到手；分词、注释字符、eof 都是字符串处理，在 asy 那一侧搭得起来。所以这一批只加
一个原语，asy 那一侧留到下一批。

`(readtext E)`：string -> string，整份读一份文本文件。语义在三处写成一份：
`$read_text`（backend-js/prelude.js）、`omni_read_text`（runtime/omni_fmt.c，omni.h 里的
真符号，LLVM 那条腿按 `[2 x i64]` 收发）、`readTextOrFail`（interp/builtin.js，MIR 解释器
也走它）。读不到就是**运行期错误**，不回空串 —— 那样"空文件"与"没这个文件"分不开。

刻意没有的：流式读、写文件、stat。路径相对**进程的工作目录**（方言里没有 argv、没有
"这份源文件在哪"的概念）。

顺带改了尺子一处：`tests/sexpr/run.js` 把子进程的 cwd 钉在仓库根上 —— 新用例
（cases/19-readtext）要读一份相对仓库根的数据文件，而那份 run.js 可能从任何目录被叫起来。

跑过的轴：`node tests/sexpr/run.js` **54/54**（新用例 cases/19-readtext 在
run / run-c / interp / interp --mir / run-llvm **五条腿**上逐字节一致）；
`node tests/run.js` 91/91（JS 与 C 后端差分）；`node tests/asy/run.js` 232/232。
**红着的一条**：`node tests/bootstrap/run.js` 0/1 —— 理由与这一批无关，是
`frontend-asy/exprs.js` 与 `stmts.js` 互相 import（拆文件那一刀 7e63733 带进来的环，
自举那条腿不收 import 环）。这一条下一批修，不含在这批的改动里。
没跑的轴：输出层的逐字节比对（EPS/SVG）还没做。

### 一批：自举那条腿重新变绿（六处越界，五处在编译器自己的源码上）

上一批留的红：`node tests/bootstrap/run.js` 0/1。修完是 **60/60**（含 N1/N2 那 9 条内层）。
六处互不相干，都是**编译器自己的源码越出了它自己能编的子集**（ADR-0011 决策 2 的封闭 ABI
与语言子集）—— 值得记的是这六处里只有一处是"编不出来"，另一处是**编得出来、跑起来才炸**：

- `frontend-asy/exprs.js` 与 `stmts.js` 互相 import（7e63733 拆文件带进来的环，加载器不收环）。
  修法不是搬代码，是在 `lower.js` 上开一格 `needsBox(nm)` 转发到 `asyNeedsBox` ——
  环上少一条边，两份文件各自的内容不动。
- `cli.js` 的 AST 磁盘缓存用了 `JSON.parse`（不在封闭 ABI 里，C 侧的 omni_js_json.h 只有
  stringify）。读那一半现在写在 `host/json_read.js` 里（`parseJson`，只收我们自己
  stringify 出来的那一份）。对着盘上现有的 **769** 份缓存与 JSON.parse 逐份比过：
  `JSON.stringify` 出来的文本全等，转义/`\uXXXX`/数/空容器/末尾垃圾的边角也对齐。
- `cli.js` 的缓存键用了 `Math.round`（同样不在 ABI 里）。改成直接把 `mtimeMs(p)` 插进键 ——
  同一次 stat 的浮点值逐位一样，取整这一步本来就不需要（333 行那一处一直是这么写的）。
- `frontend-asy/calls.js` 的 `new Array(n).fill(null)`（子集里没有）→ 一句 push 的循环。
- `frontend-asy/exprs.js` 的 `new WeakMap()`（子集里只有 Map/Set）→ Map。这张备忘表挂在 L 上，
  一次降解完跟着 L 一起扔，多留住的是这一次本来就活着的那棵树。
- `frontend-asy/calls.js` 里一个 for 变量与被闭包抓住的 `ai` 同名 → 改叫 `qi`。

**编得出来、跑起来才炸的那一处**：`sexpr/lower.js` 的 `this.preClass.clear()`。`clear` 不在
`hir/js_abi.js` 的成员表（JS_PROPS）里，而查不到的成员会退成"通用取属性" —— 于是自举出来的
两代都在这一句上报 `dynamic value is Set, expected dict`（C1 那一代的说法是
`Set is not an object`），一口气带倒 8 条 N1 的用例（sexpr 的 llvm/c、两个 spirv、run mini.sx）。
改成换一格新的 `new Set()`。**没有**顺手把 `clear` 加进 ABI：全仓库就这一处用它，而加一个成员
要在 js_abi/prelude/运行时 C/LLVM 的符号表四处同时落地。留下的教训写在那一句上方：
成员表外的方法，静态检查不拦，尺子只在自举那条腿上看得见。

跑过的轴：`node tests/bootstrap/run.js` **60/60**（C1/C2 定点、N1 = clang(emit-c)、N2 = N1
自编，以及 N1 与 C0 在 llvm/c/spirv/jit/incr 上的逐字节比对）；`node tests/asy/run.js`
**232/232**（`OMNI_LEGS=all` 五条腿，310.1s —— 这一条同时是 AST 缓存**读**那条路的尺子：
232 份用例每份都命中 `parseJson`）；`node tests/sexpr/run.js` 54/54；`node tests/run.js` 91/91；
快扫 `tests/asy/sweep.js` 例子面仍是 **198 干净 / 22 有诊断**，220 个共 **1.8s**、最慢
genusthree.asy **110ms**（没有并行；口径与前几批同）。
没跑的轴：`OMNI_SWEEP_SX=1` 那一趟（这一批没碰降级那一层）、输出层的逐字节比对（EPS/SVG）。

### 一批：asy 那一侧的 `struct file`（真的读文件，例子面 198 -> 203）

上一批只加了原语 `(readtext E)`；这一批把 asy 的读文件那一族搭在它上面，全在
`stage0/lib/asy/asy_builtins.asy` 里（前端只多一个口子）。这样例子面从 **198 干净 / 22 有诊断**
到 **203 / 17**，降级那一层（`OMNI_SWEEP_SX=1`）从 196 到 **201**。

搭法：`struct file` 里存**整份内容按 '\n' 切开的行**加一个 `(li, ci)` 位置，`input()` 用新的
前端口子 `_readlines(name)` 一次读完，`.line()` / `.word()` / `.csv()` 是记录上的方法
（asy 那边它们是内建类型上的**虚字段** —— runfile.in:209 的 lineSet 回一个 callable，
所以 `input(…).word().line()` 是"取字段再调"，方法回 `this` 就串得起来）。
读一格与读一片分成两层，照 asy 的分法：`file::read`（fileio.h:188）不碰 nexteol，
**标量的 cast**（castop.h:95 的 read<T>）读完在 line 模式下 nexteol 一次，数组那一族
（castop.h:116 的 readArray）自己在循环里 nexteol。

三条量出来、不看源码想不到的（都进了用例 `tests/asy/cases/145-file-input`）：
- 标量读完那一次 nexteol 会把紧跟着的**空行一起吃掉**：`.line()` 模式下连着读，
  `1 2 3` / `4 5 6` / 空行 / `7\t8` 出来的第三份是 `7\t8`，空行没了。
- nexteol 撞到连着的第二个换行时置 nullfield，而下一次读**不解析**、直接给零值 ——
  空行读成 `real[]` 是 **一格 0**、读成 `string[]` 是 **一格空串**，不是"没有值"。
- 字符串那一支**不跳注释**（fileio.h:174 的 `ignoreComment(string&) {}` 是空的）：
  注释是在 Read(string) 里从行内截掉的，`##` 是一个字面的 `#`。

**切行不能用 asy 的 `split`**：那一条走 asy__sfindp，而它是 `sfind(substr(s,p))` ——
每找一次把尾巴整份拷一遍。量过：1.2MB / 6 万行的 worldmap.dat 那样跑 **37s**。
所以切行是新 helper `asy__lines`（一遍扫描、每行一次 ssub），`worldmap.asy` 整份从
**43s 到 10.9s**。真正的修法是给核心方言的 `(sfind E T)` 加个起点（indexOf 在四条腿上
都只收两个参数），那是另一批 —— 快扫本身只降级不执行，所以这条不在速度那道门槛上。

刻意没做/记下来的分歧：csv 模式的引号与空字段、`>>` 只吃"数字前缀"那一手（我们要求整个词
是一个数）、二进制/XDR 模式（`input(…,mode="xdrgz")` 当"打不开"）、`\v` 与 `\f` 不算空白、
`check=false` 一律当"打不开"（这一层没有"文件在不在"这个原语；plain.asy:261 那句问的正是
输出文件在不在，通常不在，所以两边一样）。另外量到真 asy 的一个洞：`close(f); eof(f);`
是 **Segmentation fault**（流已经 delete 了），我们回 eof=true，用例里因此不测那一格。

`(real) s` 用的是这个文件里本来就有的 `real operator ecast(string)`（那份文法与"认不出就是 0"
都是量过的）。它声明在读文件那一段**后面**，而名字是顺序解析的，所以读那一族里留了一格函数值
`asy__num`，在 ecast 之后填上 —— 比把两百行搬来搬去稳。

顺带量到、**没在这一批修**的一条：`ASYMPTOTE_DIR` 指到真 base/ 时，`write("hi")` 落到
plain_Label.asy:459 的 `write(file=stdout, Label, suffix)`（走 string -> Label 那条用户转换），
印出来带引号；asy 那边内建的 `write<string>` 是**同型**的一条，它赢。也就是"内建那一族要和
用户重载一起参与挑选、同型优先"这一条还没做 —— 例子的**输出**受影响（诊断不受影响，
所以快扫看不见），下一批。

跑过的轴：`node tests/asy/run.js` **233/233**（新用例 145-file-input 与 `asy -noV` 逐字节
一致：33 行里 line/word/real/real[][]/eof/eol/error/close 与字符串转数都在里面；`OMNI_LEGS=all`
五条腿 247.3s）；`node tests/sexpr/run.js` 54/54；`node tests/run.js` 91/91；
`node tests/bootstrap/run.js` **60/60**；快扫 `tests/asy/sweep.js` **203 干净 / 17 有诊断**
（220 个共 1.7s、最慢 genusthree.asy 162ms，无并行），深快扫 `OMNI_SWEEP_SX=1`
**201 干净**（48.2s、最慢 genustwo.asy 423ms），模块那一份不变（three 6、geometry 1、
contour 2、palette 1、patterns 1；核心方言那一层 12 条）。
没跑的轴：输出层的逐字节比对（EPS/SVG）还没做。

### 一批：内建的 `write` 与用户重载谁赢（同型的那一条先说话）

上一批末尾记下的那一条：`ASYMPTOTE_DIR` 指到真 base/ 时 `write("hi")` 印出来带引号。
查出来是**顺序**问题 —— `frontend-asy/stmts.js` 的 write 分支一律先问用户重载，于是
`write("hi")` 落到 plain_Label.asy:459 的 `write(file=stdout, Label, suffix)`
（走 `string -> Label` 那条用户转换），而 asy 那边内建的那一条一次转换都不用、它赢。

改法是把顺序变成"看形状"：实参落在内建那条**不带可变形参**的签名上时先问内建，
别的形状照旧先问用户重载（两条路都是"试一遍，不行就把诊断与前置语句都丢掉"）。
"不带可变形参的签名"是量出来的两种形状 —— 内建那条是
`write(file file=stdout, string s="", T x, void suffix(file)=endl)`（builtin.cc:499 的
addWrite，T = int/real/string/bool/pair/triple），**只有一个 T**：
- 一个实参，类型是那六个之一；
- 两个实参，第一个是 string（前缀）、第二个是那六个之一。

多于两个实参走的是可变形参那一条（builtin.cc:501 的 `addRestFunc(writeArray)`），
而**可变形参那条输给同型的普通重载** —— 量过：自己定义 `void write(string,int,int)`
之后 `write("s",1,2)` 印的是用户那条（`three:s12`），不是内建的 `s1\t2`。这条tie-break
就是新用例 `tests/asy/cases/146-write-overload` 的最后一行。

数组、结构体、带 file、带 suffix 的形状都不在这两种里，所以那些仍旧先问用户重载 ——
base 里 `void write(file, T)` 那一族（plain_constants.asy:82 起）管的正是它们。

跑过的轴：`node tests/asy/run.js` **234/234**（新用例 146-write-overload 与 `asy -noV`
逐字节一致：内建赢的两种形状、用户的 `operator cast` 那两格、可变形参输给同型重载那一格；
`OMNI_LEGS=all` 五条腿 281.9s）；`node tests/sexpr/run.js` 54/54；`node tests/run.js` 91/91；
`node tests/bootstrap/run.js` **60/60**；快扫 **203 干净 / 17 有诊断**（220 个共 2.7s、
最慢 cheese.asy 159ms，无并行），模块那一份不变。
没跑的轴：深快扫（`OMNI_SWEEP_SX=1`，这一批没碰降级出来的形状，只改了挑哪一条）、
输出层的逐字节比对（EPS/SVG）。

### 一批：`three.asy` 那 6 条清零（三处"同名按签名分得开"，加虚线的 `adjust`）

`import three;` 上剩的 6 条诊断这一批全清了（模块那一份的 `three.asy 6` 整行消失）。
四件事，前三件是同一个根：**asy 里同名的东西按签名分得开，遮不遮得住要看是不是函数类型**。

1. `three.asy:2755` 的 `f=pic.fit3(…)`（85 个例子停在这条上）。`frame f` 是 struct scene
   的字段，而那个块里又声明了 `real f(pair a, pair b){…}`。挑格那一路（stmts.js 的
   `asyAssign`）本来就写了"当前这一格接不住就试字段那一格"，但它问的是 `L.selfField(nm)` ——
   而那个函数**开头就有一句** `if (this.lookup(nm) !== null) return null;`（局部量优先），
   于是在"有局部量"这一档里它恒为 null，那一支是死码。给 `selfField` 加了第三个参数
   `shadowed`：为真时不看局部量那一格。**只在局部量是函数类型时传它** —— 量过
   `struct S { int x; void go() { string x="a"; x=5; } }` 那边报的是
   "cannot convert 'int' to 'string' in assignment"，不是函数的那一格是真的遮住。
   两边各一条用例：`cases/147-fnslot-shadow` 的 (1) 与 `strict/field-shadow-var`。
2. `three.asy:3235` 的 `fit=new frame[](…)`：赋的是 **plain_arrows.asy:618** 那一格
   （`import` 进来的函数名）。`asyFnSlots`（decls.js）本来有 `c.unit !== u.id` 一句挡着 ——
   那一格的初值是"在函数声明那一行发 `(set 槽 (fnref 函数))`"，而别的单元早降完了。
   放开的办法是初值改由**这个单元**在体的最前面填（`u.fsInit`，排在内建面与 autoplain
   之后）：`(fn …)` 是全局的，`(fnref …)` 那时就取得到。差别记一笔：asy 那边两边是同一块
   存储，改完**那个模块自己**的调用也走新的一格；这里那个模块已经编成直呼原函数了，
   只有这个单元（以及之后 `import` 它的）看得见这一改。
3. `three.asy:12` 的 `Embed=embed.embedplayer`：模块限定的**函数**当值用。`asyModVar`
   原来只翻那个单元的 `globals`，翻不到就是 nope；现在翻不到再翻 `funcs`，落地与裸函数名
   当值用完全同一条（一份出 `(fnref …)`、好几份出不定案的重载集记号）。
4. `three.asy:2302` 的 `adjust(q,arclength(g),cyclic(g))`：`pen adjust(pen,real,bool)`
   （runtime.in:535 -> drawpath.cc:52 的 `adjustdash`，`PatternLength` 在同一文件 :21）
   逐句照抄进 `lib/asy/asy_builtins.asy`。10 个形状（缩放/不缩放、adjust=false、奇数项、
   cyclic、arclength=0、花样比弧长长）与 `asy -noV` 逐字节一致。一处对不上要说清：那边
   `q.linetype()` 在 `line.isdefault` 时回的是 defaultpen 的那一份，这一层的笔没有
   isdefault 这一格，读的一律是笔自己那一格。

另外补上了 `shipout3` 的两条签名（runpicture.in:486/512）与 `defaultformat3`，体是
`abort` —— 与 `_shipout` / `_texpath` / `_eval` 同一档：签名在，那三句才降得下来。

第 2 件差点漏掉的一个坑，值得记：`u.fsInit` 挂在**单元对象**上，而 `snapshot`/`restore`
里单元对象是同一份（快照只拷它那几张表）。不每遍换一格空的，上一趟的 `(set …)` 会跟着
下一趟一起发，而那一格 `(global …)` 已经随 `gdecls` 回滚掉了 —— 深快扫里几十个例子一起报
`未声明的变量 'asy__fs649_viewportmargin'`，干净数从 201 掉到 103。现在 `asyFnSlots` 每遍
开头 `u.fsInit = []`。

跑过的轴：`node tests/asy/run.js` **236/236**（新用例 147-fnslot-shadow 与 `asy -noV`
逐字节一致，新 strict 用例 field-shadow-var 两边都拒；`OMNI_LEGS=all` 五条腿 300.4s）；
`node tests/sexpr/run.js` 54/54；`node tests/run.js` 91/91；`node tests/bootstrap/run.js`
**60/60**；快扫 **203 干净 / 17 有诊断**（220 个共 1.6s、最慢 tvgen.asy 99ms，无并行），
模块那一份 **three.asy 6 -> 0**（剩 geometry 1、contour 2、palette 1、patterns 1）；
深快扫（`OMNI_SWEEP_SX=1`）**201 干净 / 19 有诊断**，模块那一层 3 条 —— 都与上一批持平。
没跑的轴：输出层的逐字节比对（EPS/SVG，`shipout3` 这一批只补了签名）。

### 一批：`triangulate`（Delaunay 那一格，palette 清零、深快扫 201 -> 203）

`import palette;` 与 `import contour;` 各卡在一句 `triangulate(z)` 上（runarray.in:2102，
体是 Delaunay.cc:44 的 `Triangulate`：Paul Bourke 那份逐点插入的 Delaunay，John Bowman
改过健壮性）。两百来行，逐句照抄进 `lib/asy/asy_builtins.asy`：顶点表用 px/py/pi 三个
平行数组（C 那边是 `XYZ[]`），三角形表用 t1/t2/t3 加一格"算完了"的旗子，边表按 nedge
记长度、按 push 长。

两处**不是**照抄就够的地方，都量过：

1. **presort 那一趟**。C 那边是 `qsort(pxyz,nv,sizeof(XYZ),XYZCompare)`，而那个比较函数
   只看 x、**等 x 回 0** —— 于是等 x 的点排成什么次序全看 libc 的 qsort 怎么走，而输入里
   等 x 的点很多（规则网格就是一列好几个）。先写了个稳定插入排，量出来 3x3 网格上 8 个
   三角形的连法全不一样。所以这里照抄的是 BSD/Apple libc 那份 qsort（三点取中的快排、
   `n > 40` 再取九点的中、等元素往两头拨、一趟没换过就转插入排、`n < 7` 直接插入排、
   右半用循环代替递归）。拿一段 C（`clang` + 真的 `qsort`）把网格 4/9/16/25/36/49/64/81
   个点的置换打出来对：**除了 49 那一格**全部一致。
2. **几何谓词**。真 asy 走 predicates.cc（Shewchuk 的自适应精确谓词：浮点先算一遍，
   落在误差界内再用展开式算术重算）。这一层只照抄了前一半 —— 那两千八百行展开式算术
   没做。整数坐标的小网格上浮点这一半本来就是精确的，所以这一条影响的是"误差界内定不了案"
   的形状。

量出来的一致性（`asy -noV` 逐字节）：不规则点集、伪随机点集（8/21/34/47/60 个点，
`n<7`、`n>7`、`n>40` 三条路都走到）、共线、重点、一整列同 x、三点、四点共圆的正方形，
以及规则网格的 2x2/5x5/6x6 —— 全部一致（新用例 `tests/asy/cases/148-triangulate` 钉着）。
对不上的三格：3x3 与 4x4 是**三角形集合相同、输出次序不同**（那两格的 qsort 置换与真
asy 一样，所以差在谓词那一侧），7x7 是连法不同（三角形个数一样；那一格 qsort 的置换
本身也不一样）。用例里没收这三格，差别写在用例头上与这里。

结果：模块那一份 `palette.asy 1 -> 0`、`contour.asy 2 -> 1`（剩下那条是 :478 的
"捕获会被改的外层变量"）。深快扫里 Gouraudcontour 与 imagehistogram 两个例子转干净 ——
它们是"前端认下来、核心方言那边才炸"的那两个，于是**深快扫与快扫的干净数第一次一样**
（都是 203），核心方言那一层的模块诊断 3 -> 2。

跑过的轴：`node tests/asy/run.js` **237/237**（新用例与 `asy -noV` 逐字节一致，419 行；
`OMNI_LEGS=all` 五条腿 312.9s）；`node tests/sexpr/run.js` 54/54；`node tests/run.js` 91/91；
`node tests/bootstrap/run.js` **60/60**；快扫 **203 干净 / 17 有诊断**（220 个共 2.4s、
最慢 genusthree.asy 212ms，无并行）；深快扫 **203 干净 / 17 有诊断**（模块那一层 2 条）。
没跑的轴：输出层的逐字节比对（EPS/SVG —— Gouraudcontour 那一路画出来长什么样还没对过）。

### 一批：`gsave` 与"两边各自转到同一个内建型"（模块那一份只剩 contour 那一条）

两条小的，一条一句话、一条要说清规则。

**`gsave`/`grestore`（runpicture.in:276/281）**：往 frame 里塞一条 EPS 的图形状态存/取。
这一层的 frame 只攒 drawop、没有"往里塞一段 PostScript 正文"这一层（`postscript(frame,…)`
是 abort 的那一档），所以这两个是空的 —— 与 `begingroup`/`endgroup` 同一条。用它的只有
patterns.asy:16 的 `tiling`，那一句下面紧跟着 `postscript()`，真跑到那儿会在 postscript
上 abort，不会悄悄画错。`patterns.asy 1 -> 0`。

**geometry.asy:1588 的 `unit(M) * l.A`**（左是 `vector`、右是 `point`）。上一轮记的是
"asy 收它，而参考实现里找不到匹配的算符，别猜"。这一批量清楚了：接住它的是**内建**的
`pair operator *(pair, pair)` —— `pair operator cast(explicit vector)`（geometry.asy:901）
与 `pair operator cast(point)`（:505）各转**一边**。同文件 :630 的
`point operator *(explicit point, explicit point)` 接不住：两个形参都是 explicit，
vector 转不进去。量过 asy 那边算的就是复数乘法（`unit((3,4)) * (1,2)` 是 `(-1,2)`），
我们现在一字不差。

我们原来判它"歧义"，根子在 `asyPromote` 的最后一步是**把一边转到另一边**：
`vector -> point`（:877）与 `point -> vector`（:892）两条都在，于是两条都通、回 null。
asy 的重载解析不是这么做的 —— 它在 `operator *` 的**候选**上做，"两边各自转到同一个内建型"
照样算匹配。所以在 `+ - *` 那一路的最后加了一步 `asyCommonBuiltin`：只在**有一边是记录**
时问（内建型之间那几条 asyPromote 已经管完了），按 `pair / triple / real / int / string`
的顺序取第一个两边都转得动的（试一遍、不行就把诊断与前置语句都丢掉）。位置是"原来就要报错"
的那一格之前，所以先前量过的形状一条都没动。差别记一笔：一个记录同时能转到两个内建型时
asy 报的是歧义，这里挑的是顺序里靠前的那一个。

模块那一份于是只剩 `contour.asy 1`（:478 的"捕获会被改的外层变量 `edge`" —— asy 的捕获
按引用，而 `(mkclo …)` 是按值抓一次）。核心方言那一层的模块诊断 2 -> 1。

跑过的轴：`node tests/asy/run.js` **238/238**（新用例 149-common-builtin 与 `asy -noV`
逐字节一致：两边各转一边的 `* + -`、explicit 真的挡得住那一格、`gsave`/`grestore` 降得下来；
`OMNI_LEGS=all` 五条腿 284.3s）；`node tests/sexpr/run.js` 54/54；`node tests/run.js` 91/91；
`node tests/bootstrap/run.js` **60/60**；快扫 **203 干净 / 17 有诊断**（220 个共 3.5s、
最慢 cheese.asy 449ms，无并行）；深快扫 **203 干净 / 17 有诊断**（模块那一层 1 条）。
没跑的轴：输出层的逐字节比对（EPS/SVG）。

### 一批：闭包体里的形参也要装箱（模块那一份归零）

最后那一条模块诊断：contour.asy:478 的 `edge=f(I+i,J+j,false)` —— "捕获会被改的外层变量
'edge'"。形状是 contour.asy:444 的 `void follow(int f(int,int,bool), int edge)`：它是**函数
体里的具名函数**（这一层也降成 `cfn` + `mkclo`），而它里面的 `void search()` 会改 `edge`
与 `I`、`J`。asy 的捕获按引用，里层改完外层看得见。

装箱这一套本来就有（长度 1 的数组，读写都穿过去，闭包抓走的是那个数组本身），**形参**那一格
也有（`asyBoxParams`，plain_arrows.asy:245 的 `position position=EndPoint` 是原型）——
漏的是**调用它的地方**：只有顶层函数（`asyFunc`）与方法那两处调了，闭包体那一条路
（`asyCloFrom`）没调。`edge` 是 `follow` 的形参，而 `follow` 走的正是闭包那条路。
补上一行就通了：形参声明完、体降之前问一遍 `asyBoxParams`，回来的那两句
（`(let 箱 …)` 与 `(aset 箱 0 (var 形参))`）插在体的最前面，排在 `(let this …)` 之后。

**于是 `模块那一份：0 条`** —— `plain`/`graph`/`three`/`graph3`/`solids`/`geometry`/
`contour`/`palette`/`math`/`stats`/`patterns` 这一摞在前端与核心方言两层都不再报一条诊断。
从"三个 6、geometry 2、contour 2、palette 1、patterns 1"数下来，这条线走完了。

跑过的轴：`node tests/asy/run.js` **239/239**（新用例 150-box-clo-param 与 `asy -noV`
逐字节一致：具名内层函数改形参、匿名闭包改形参、套两层改同一格；`OMNI_LEGS=all` 五条腿
288.5s）；`node tests/sexpr/run.js` 54/54；`node tests/run.js` 91/91；
`node tests/bootstrap/run.js` **60/60**；快扫 **203 干净 / 17 有诊断**（220 个共 2.1s、
最慢 tvgen.asy 153ms，无并行）、模块那一份 **0 条**；深快扫 **203 干净 / 17 有诊断**、
模块那一层也 **0 条**。
没跑的轴：输出层的逐字节比对（EPS/SVG）—— 例子面剩下的 17 条都是单件的语言特性
（gsl、`join-exp`、函数值省实参、赋值当表达式、`gamma`、裸 `map(f,x)`、do-while 的
`continue`、`graph(<重载集>,int,int)`、`operator ::` 的可变实参、`Ticks(…)`、
`void().fit(…)`、`usersetting()` 歧义、`.initialized`、`pattern`、`write(real,int,int,int)`、
RKTableau 的方法赋值），不再有模块那一侧的阻塞。

### 一批：do-while 的 continue、同签名再声明一遍、被遮住那格压不住数学那族

三条都是"顺序"这件事的不同侧面，落在例子面的 lmfit1 与 interpolate1 上。

**do-while 里的 `continue`**（lmfit.asy:574）。这一层把 `do S while(c)` 降成
`while(true){ S; if(!c) break; }`，条件检查在**体的末尾**，所以体里的 `continue` 直接
`(cont)` 会把它跳过去 —— 原来见到就报 nope。改法是让 `continue` 那一句**就地把条件再算一遍**：
假就 `(brk)`、真才 `(cont)`。量过 asy 就是这个意思：
`int n=0,calls=0; bool cond(){++calls; return n<4;}` 配
`do {++n; if(n%2==0) continue; write("odd",n);} while(cond());` 印 odd1 / odd3 / **calls4**
—— continue 那两轮条件照样被调了一次。条件因此要**先降**（`continue` 那一格要用它的代码），
顺序反过来不改可见性：asy 里条件看不见体里声明的名字（`do { int j=1; } while (j==1);` 报
`no matching variable 'j'`）。`(cont)` 归谁靠 `L.updates` 那个栈分清：内层循环自己压一层，
函数体那条路把它清空。

**同一个单元里同签名再声明一遍**。asy 那边这是**又一格新变量**，不是覆盖：先写的那份在
"它之后、后一份之前"那一段照样看得见。量法是 `real f(real x){return x+1;} … map(f,a)` 印 2 3，
再写一份 `+10` 之后 `map(f,a)` 印 11 12。interpolate1.asy 正是这个形状 —— 七个
`real f(real x)` 挨在一个文件里，每个 `y=map(f,x);` 用的都是它上面最近那一份。原来
`asyDeclFn` 撞上同签名是**原地替换**，于是第 18 行那句 `map(f,x)` 看到的是第 41 行那份的
位置、被 `c.at > L.at` 裁掉，报"未声明的变量 'f'"。改成两份都留、各打一个 `dup` 记号，
由 `asyVisible` 在当前位置只留最近那一份（`asyDupLast`）。两处要紧的细节：
`asyCandAt` 得把 `dup` 带过去（import 并进来那几份 `at` 全是那条 import 的位置、分不出先后，
只能按表里的次序 —— `asy_builtins.asy` 里成对出现的
`real[][] operator *(real[][],real[][])`（3452 与 4160）就是这么在 `m*n` 上报 ambiguous 的，
cases/86 钉着）；分组**不看返回类型**（签名身份里就没有它 —— `int s(int)` 之后
`real s(int)` 是替换、`s(5)` 印 2.5，cases/16 钉着）。

**被遮住的那一格压不住数学那一族**。`real[] x,y;` 之后 `real f(real x){return sin(x);}`：
候选表里只有内建面那份 `real[] sin(real[])`，它靠文件级那格 `real[] x` 接上（`fit` 记的
`shadow` 1），而标量 `sin` 是写死在这个前端里的（`L.math`）、不在候选表里 —— 于是那一句报
"return 的值：要 real，这里是 real[]"。asy 那边形参把文件级那格遮住了，走的是标量 sin
（印 0.479425538604203）。补的是一条次序：挑出来最好那份的 `shadow > 0` 而这个名字又在
数学那一族里时，先让数学那份试一次（带回滚），不成再照原样走下去。这一条是第五十一刀
（"内建面注册了数组那份之后标量那份要再试一次"）的另一面。

跑过的轴：新用例 151-dowhile-continue（continue 跳条件、break 仍跳出、内外层各归各、
条件里要摊语句的那一路、嵌在 for 里、套两层 do-while）与 152-dup-decl（三份同签名、
返回类型不同那一对、真重载不受影响、形参遮住文件级数组那一格）都与 `asy -noV` 逐字节一致；
回归的 16-overload 与 86-matrix-frame 也一致；`tests/asy/cases` 与 `tests/asy/strict`
全量按 `run` 那一条腿逐个比对，无差异；快扫 **205 干净 / 15 有诊断**
（220 个共 2.2s、最慢 genusthree.asy 219ms，无并行）、模块那一份 **0 条**。
没跑的轴：`run-llvm` 与 `OMNI_LEGS=all` 那三条腿、`tests/sexpr`、`tests/run.js`、
`tests/bootstrap`、深快扫（`OMNI_SWEEP_SX=1`）、输出层的 EPS/SVG —— 全量那一遍攒几批跑一次，
每批都跑的话一步要等四分钟。
例子面剩下的 15 条：gsl、`join-exp`、函数值省实参、赋值当表达式、`gamma`、
`graph(<重载集>,int,int)`、`operator ::` 的可变实参、`Ticks(…)`、`void().fit(…)`、
`usersetting()` 歧义、`.initialized`、`pattern`、`write(real,int,int,int)`、
RKTableau 的方法赋值（odetest 与 slope 是同一条）。

### 一批：write 的实参不必同型、模块别名的可见位置取早的那一次

两条都是 tvgen.asy 一个文件里的（它是这一摞例子里最长的那个）。

**`write` 的实参不必同型**。原来这一层判"要同型"，只给 pair 开了个口子（`write(3,(1,2))` 印
`(3,0) TAB (1,2)`）。这是**错的**：量过 `write(1.5,2,3,4)` 印 `1.5 TAB 2 TAB 3 TAB 4`、
`write(2,1.5)` 印 `2 TAB 1.5` —— int 与 real 混着时那个 T 是 real，int 那几格走一次提升。
tvgen.asy:912 的 `write(y*1000, round(R*1000), round(G*1000), round(B*1000))` 正是这一种，
真 asy 编得过，而我们报"asy 那边 write(real, int, int, int) 就是 no matching function"——
**那句话本身是假的**（这一层的诊断里凡是说"asy 那边也这样"的，都该有量过的依据）。
只有 int/real 这一对如此：`write(real,triple)`、`write(pair,triple)`、`write(bool,int)`、
`write(int,string)`、`write(string,string,int)` 在 asy 那边都真的是 no matching function
（一条条量过，钉在 cases/153 的注释里）。报诊断时说的类型是**写下来那几个**，
不是提升之后的（`write(1.5,2,"a")` 要说 `write(real, int, string)`）。

**模块别名的可见位置取早的那一次**。声明遍是整个单元先走一趟，所以晚的那一句
`access m;` 会把早先记的那格别名盖掉，前面几行反倒看不见它了。tvgen.asy 的形状：
`settings` 那格别名由 `asySettingsIn` 以 `at -1` 记好（从第一句起可见），而第 1047 行
有一句 `access settings;` —— 盖成 1047 之后，第 27 行的 `int verbose=settings.verbose;`
就落到"带点的名字或算符名"上去了。改法是 `L.mods.set` 之前问一句：同一个名字指着
**同一个单元**、而且已经记着一个更早的位置时，不动它。指着别的单元那一种（真的遮盖）
要一串按位置排的别名，这一刀没做。

于是例子面 **205 → 206 干净**（tvgen 清零）。

跑过的轴：新用例 153-write-mixed（int/real 混、前缀串、pair 那一档、`import` 之后再
`access` 同一个模块）与 `asy -noV` 逐字节一致；`tests/asy/cases` 与 `tests/asy/strict`
全量按 `run` 那条腿逐个比对，无差异；快扫 **206 干净 / 14 有诊断**（220 个共 2.2s、
最慢 genusthree.asy 154ms，无并行）、模块那一份 **0 条**。
没跑的轴：与上一批同（`run-llvm`、`OMNI_LEGS=all` 那三条腿、`tests/sexpr`、
`tests/run.js`、`tests/bootstrap`、深快扫、EPS/SVG）。

**试了又撤掉的一条**（记下来免得再走一遍）：`usersetting()`（slidedemo.asy:14）报
"有多个同样合适的重载"，因为 plain.asy:237 与 slide.asy:176 各有一份 `void usersetting()`，
两条 import 都把它并进来了 —— asy 那边是"后 import 的盖住先来的"。照上一批那套
`dup` 记号往 `asyModMerge` 里加"同形参就打记号"之后，模块那一份从 0 条涨到 7 条
（`min(real[])` / `max(real[])` 那一族被误伤 —— 按形参那串分组挡不住同名不同元素类型的
那几份），所以撤掉了。这条要做得先把"并进来的候选按类型排序遮盖"那套补全。

### 一批：同名的文件级变量有好几格时，调用按签名挑

`fermi.asy` 停在 feynman.asy:579 的 `currentmomarrow = EndArrow(momarrowsize());` ——
报"通过函数值调 'EndArrow' 时省了实参（它是 `bool(picture,path,pen,margin)`，要 4 个，
给了 1 个）"。这句诊断指错了人：`EndArrow` 在 plain_arrows.asy 里有**两格**同名的文件级变量，
:335 那格是 `arrowbar EndArrow(arrowhead arrowhead=DefaultHead, real size=0, real
angle=arrowangle, filltype filltype=null, position position=EndPoint)=Arrow;`
（函数类型的变量，形参名与默认值记在**类型**上，也就是这一层的 `L.fnDefs`），
:444 那张声明表里又有一格 `EndArrow=Arrow()`，类型光是 `arrowbar`。降出来的两格是
`(global asy__g341_EndArrow (fnty (arrowhead real real filltype position) …))` 与
`(global asy__g347_EndArrow (fnty (picture path pen (fnty (path pen))) …))`，都在。

原来这一层只问 `gvarHere`（**最近**那一格），拿到的是 :444 那格，于是把
`EndArrow(2.0)` 当成对 `bool(picture,path,pen,margin)` 的间接调用。asy 是按签名挑的 ——
`(real)` 只有 :335 那格接得住，少给的四格由类型上那几个默认值填（那套包装
`asyFnValDefWrap` 早就有了，只是从来没轮到它）。改法：把可见的同名文件级变量按
**从近到远**排一串，逐格试（原来那两条守卫 `asyArityBad` / `asyGvarLoses` 与"真降下去
接不住就回滚"一格不动），一格接住就用它；一格都没接住而且没有同名的函数候选可退时，
让**最近**那一格去报诊断（那句话比"没有能匹配的签名"准）。

于是例子面 **206 → 207 干净**（fermi 清零）。

跑过的轴：新用例 154-gvar-many-call（`ab EA(real size=0)=mk;` 与 `ab EA=mk(3.0);`
两格同名，`EA(2.0)` / `EA()` 走前一格、`EA(5)` / `EA(1)` 走后一格）与 `asy -noV`
逐字节一致；`tests/asy/cases` 全量按 `run` 那条腿逐个比对，无差异；
快扫 **207 干净 / 13 有诊断**（220 个共 1.7s、最慢 genusthree.asy 117ms，无并行）、
模块那一份 **0 条**。
没跑的轴：与上一批同（`run-llvm`、`OMNI_LEGS=all` 那三条腿、`tests/sexpr`、
`tests/run.js`、`tests/bootstrap`、深快扫、EPS/SVG）。

### 一批：默认值那一段里的闭包（`ode.asy` 那条链上的三格）

`odetest.asy` / `slope.asy` 卡在 ode.asy 上，一条链上三格，逐格量出来的：

**一、`this.f = f` 也算"这个名字被赋过值"。** ode.asy:34 在 `RKTableau` 的
`operator init` 体里写 `this.stepDependence=stepDependence;`。带体的方法只有在"这个名字
在别处被赋过值"时才降成**函数类型的字段**（`fnFldOk` / `memAssigned`），否则留在顶层
当多一个 `this` 形参的函数。原来 `memAssigned` 只认 `(name-exp …)` 那种左边，
`(field X name)` 这种一格没算，于是 `stepDependence` 还是顶层函数、`this.…=…` 落不下去。
补上 `(field X name)` 这一支（取字段名那一格）。

**二、`real dot(real[], real[])`。** ode.asy:317 的
`h*dot(tableau.a.weights[i], predictions)` 要 runarray.in 里那格数组版的 `dot`
（这一层的内建只有 pair / triple 那两格）。补在 `asy_builtins.asy` 里，长度不同时
与别的逐元素运算同一句错（`asy__samelen`）。

**三、默认值那一段里的匿名函数要有"外层体"可看。** ode.asy:25 的
`real[] steps=sequence(new real(int i){return sum(weights[i]);}, weights.length)`
抓的是同一张形参表里的 `weights`。捕获这一层要判"这个名字在闭包之后还会不会被改"
（asy 是按引用捕获，`(mkclo …)` 是按值抓一次），判据要一段体去扫；`L.cap.body` 就是
`L.fnBody`，而它只在降**函数体 / 方法体**时才有值。默认值是在 `asyDefWrapper` 里降的，
那儿 `L.fnBody` 是 null —— 于是 `L.cap.body === null` 那一条把它一律拒了。
改法：`asyDefWrapper` 降默认值时把 `L.fnBody` 换成**被调方自己的体**（`d.node.items[4]`，
用完还回去）。这一格是对的：默认值在调用处先求、体随后才跑，所以"体里有没有
`weights = …`"正是两种语义会不会分岔的那个判据（ode.asy 那儿只有 `a.weights=weights;`，
改的是字段，不是形参）。

于是例子面 **207 → 209 干净**（odetest、slope 一起清零）。

跑过的轴：新用例 155-defarg-clo（默认值里的闭包抓前一格形参、`operator init` 那一路、
`this.f = f` 之后 `t.f(3)` 与 `real g(real) = t.f;`、`dot` 两格）与 `asy -noV`
逐字节一致；`tests/asy/cases` 全量按 `run` 那条腿逐个比对，无差异；
快扫 **209 干净 / 11 有诊断**（220 个共 2.4s、最慢 genusthree.asy 173ms，无并行）、
模块那一份 **0 条**。
没跑的轴：与上一批同（`run-llvm`、`OMNI_LEGS=all` 那三条腿、`tests/sexpr`、
`tests/run.js`、`tests/bootstrap`、深快扫、EPS/SVG）。

### 一批：赋值当表达式时左边重读不了那一格、那一格在自己的初值里还不可见

`fin.asy` 两格，都是 asy 的名字/求值规则里那种"顺序"的东西：

**一、`A[i][f(m)] = A[i][g(m)] = 1`（fin.asy:51）。** 赋值在 asy 那边是表达式，值就是
赋进去的那一个。这一层的做法是"把它摊成语句，再把左边读一遍当值"，所以原来只收
"左边重读一遍没有副作用"的那几种形状（`asyRereadable`）—— 下标里带调用的这一格被拒了。
其实数组下标那一路早就把数组与下标都绑成了临时量（`asy__d…` / `asy__i…`），
写完原地读回来一次都不多求。改法：那一路把"怎么读回来"记在 `L.avout`
（连着那句赋值的节点一起记，里外套几层时认得出人），表达式那一档在左边重读不了时用它。
量过一致：`A[idx(1)] = A[idx(2)] = 1;` 之后 idx 只被叫了 2 次，`++C[idx(0)]` 当表达式
出的是加过之后那一格。

**二、`real[] T=…; real[][] T={T[0:13],T[13:26],T[0:13]};`（fin.asy:84）。**
初值里那三项说的是**前面**那个 `real[] T`：asy 的名字解析是顺序的，正在声明的那一格
在自己的初值里还不可见（量过 `int x = x + 1;` 报 "no matching variable 'x'"，
`int fact(int) = new int(int n){… fact(n-1) …};` 也报同一句）。而**同一句里前面那几个
声明子**是可见的（`real a=1, b=a+1;` 印 2）—— 所以挡法按**名字**（`L.selfHide`），
不按位置：`gvarHere` / `gvarFor` 在挑格子时，名字正是这一格、位置正好是这一句、
单元也是这一个时跳过去。只圈"求初值"那两处，别的支上还有几条早回的路。

于是例子面 **209 → 210 干净**（fin 清零）。

跑过的轴：新用例 156-assign-exp-selfhide 与 `asy -noV` 逐字节一致；
`tests/asy/cases` 全量按 `run` 那条腿逐个比对，无差异；
快扫 **210 干净 / 10 有诊断**（220 个共 1.6s、最慢 tvgen.asy 105ms，无并行）、
模块那一份 **0 条**。
没跑的轴：与上一批同（`run-llvm`、`OMNI_LEGS=all` 那三条腿、`tests/sexpr`、
`tests/run.js`、`tests/bootstrap`、深快扫、EPS/SVG）。

### 一批：语句位置的任意表达式、名字叫 `operator --` 的那一格变量

`controlsystem.asy:20` 那个闭包里写的是

```asy
blockconnector operator --=blockconnector(pic,t);
block(0,0)--Label("$u$",align=N)--Arrow--sum1--Arrow--delay--Arrow--…;
```

三格都在这一句上：

**一、语句位置的表达式。** 原来只认赋值/自增/调用/`? :` 那几种，别的报"语句位置的表达式
'join-exp'"。asy 收**任何**表达式当语句、值丢掉（量过 `1+2;`、`f()+f();`、`s+"b";`、`n;`
都编得过，副作用照发）。所以最后补一步"按表达式降、包一层 `(expr …)`" —— 前置语句
`L.expr` 自己就推进 `L.pre` 了，而核心方言的 `(expr …)` 收任何表达式。

**二、名字叫 `operator --` 的一格局部量。** 那一句原样降出来是
`(let operator -- (fnty (int int) int) …)` —— 两个词，方言里不成一个符号（一直是这样，
只是从来没有例子走到过）。局部那几支的名字过一遍 `asyFldSym`（`asy__opfx45x45`），
那也正是 opUser 查"局部那一格算符"用的键。文件级那一支不动：那边表里的键是源码里的名字。

**三、局部那一格与文件级那几份算符是同一个重载集。** 原来局部那一格一旦元数对得上就
"接不住就报错"，于是同一句里的 `block -- Label`（走 flowchart.asy:508 的
`block operator --(block, Label)`）被那格 `block(block,block)` 挡住了。改成试不成就
回滚诊断、往下走候选表。

于是例子面 **210 → 211 干净**（controlsystem 清零）。

还差一格没做：**文件级**那一格名字叫 `operator --` 的变量（`conn operator -- = mk(1);`
之后 `5 -- 6`）—— asy 收（量过印 507），这一层还是报"内建的 '--' 是 guide 的"。
例子里没有走到它的，所以留着。

跑过的轴：新用例 157-stm-exp-opvar 与 `asy -noV` 逐字节一致；`tests/asy/cases` 全量按
`run` 那条腿逐个比对，无差异；快扫 **211 干净 / 9 有诊断**（220 个共 1.9s、最慢
cheese.asy 119ms，无并行）、模块那一份 **0 条**。
没跑的轴：与上一批同（`run-llvm`、`OMNI_LEGS=all` 那三条腿、`tests/sexpr`、
`tests/run.js`、`tests/bootstrap`、深快扫、EPS/SVG）。

### 一批：跨单元同签名按位置压、点号左边挑得出人、pen 那三个内建

`slidedemo.asy` 与 `poster.asy` 这一串（四格，一格接一格量出来的）：

**一、跨单元同签名从来不是 ambiguous。** slidedemo.asy:14 的 `usersetting()` ——
plain.asy:237 与 slide.asy:176 各一份 `void usersetting()`，这一层报"有多个同样合适的
重载"。在 /tmp 里搭了三个小模块量：`import ua; import ub;`（ub 里 `import ua;` 之后又
定义了同签名的 h）印 B；`import ua; import uc;`（两个模块互不相干、各一份 `void h()`）
印 C。也就是**一律按位置压**，后并进来的遮住先并进来的。落在 `asyVisible` 里
（`asyUnitLast`）：按形参那串分组，一组里出现了不同单元时只留 `at` 最大的那一份。
上一批那句"这条要先把类型排序的遮盖补全"于是不必了 —— 关键是这一步要在**用的地方**做
（那时 `at` 已经把不该看见的裁掉了），不是在 import 合并的时候做（那会连别处该看见的
一起删掉，就是上一次撤掉的那个改法）。

**二、点号左边那个名字有好几格时，挑能有这个成员的那一格。** slide.asy:32 是
`picture background;`、:96 是 `void background()`，而 :98 写的是 `background.empty()`
（poster.asy:16 的 `background.fit()` 同一形）。原来 `dotQual` 只问 `gvarHere`（最近那
一格），拿到的是那个函数、于是报"void() 上的方法调用"。改法：最近那一格**自己不可能有
成员**（不是记录、不是数组）时，往回找一格身上真有这个字段/方法的。反过来不找 ——
那会把 `a.length` 从数组身上抢到"某个记录也有 length 字段"那一格上去。

**三、pen 上那三个内建。** 逐个照 `asy -noV` 量了再写：
- `string colorspace(pen)`：默认笔与 `gray(0.3)` 是 `gray`、`red` 是 `rgb`、
  `cmyk(red)` 是 `cmyk`、`invisible` 与 `nullpen` 是空串（与 `colors(pen)` 同一套分档）。
- `pen colorless(pen)`：颜色那几格清回"没设过"，别的属性照旧 —— 量过
  `colorless(red+2bp)` 之后 colorspace 是 gray、一道、值 0，宽度还是 2；
  `colorless(invisible)` 也回到 gray 那一档。
- `real lineskip(pen)`：设过就是设的那格，没设过是字号的 1.2 倍（`lineskip(currentpen)`
  是 14.346201743462、`lineskip(fontsize(20))` 是 24、`lineskip(fontsize(10,15))` 是 15）。

于是例子面 **211 → 213 干净**（poster、slidedemo 一起清零）。

跑过的轴：新用例 158-unit-last-dotpick（连 mod_sha / mod_shb / mod_shc 三个小模块）与
`asy -noV` 逐字节一致；pen 那三个按 `import plain;` 的探针逐字节一致（那一支要
`ASYMPTOTE_DIR` 指到真 base/，所以没进 cases）；`tests/asy/cases` 全量按 `run` 那条腿
逐个比对，无差异；快扫 **213 干净 / 7 有诊断**（220 个共 2.1s、最慢 genusthree.asy
136ms，无并行）、模块那一份 **0 条**。
没跑的轴：与上一批同（`run-llvm`、`OMNI_LEGS=all` 那三条腿、`tests/sexpr`、
`tests/run.js`、`tests/bootstrap`、深快扫、EPS/SVG）。

### 一批：pen 上的图案（`pattern`）

`tiling.asy:6` 的 `filldraw(unitcircle,pattern("checker"))` 要 runtime.in 那两条
`pattern`。图案在 pen.h 里**就是一种颜色空间**，所以 `struct pen` 上多一格
`string patternval`（空串是没设过），别的三处跟着：`pencopy` 抄它、`+` 那边"右边设过就
盖住左边"、`colors` / `colorspace` 在它非空时给 0 道 / 空串。

逐条量的（`asy -noV`）：`pattern(red+pattern("chk"))` 与 `pattern(pattern("chk")+red)`
都是 `chk`（两个方向都盖得住），`pattern(pattern("x")+pattern("y"))` 是 `y`（右边赢），
`colors(pattern("chk")).length` 与 `colors(red+pattern("chk")).length` 都是 0、
`colorspace(red+pattern("chk"))` 是空串，`pattern(colorless(pattern("chk")))` 还是 `chk`
（colorless 清颜色、不清图案），`pattern(gray(0.2))` 是空串。

于是例子面 **213 → 214 干净**（tiling 清零）。

顺手量出来的一格差别（**没动**，记在这儿）：`new T[2]`（T 是 struct）在 asy 那边是
**没初始化**的两格，读它报运行期错 "read uninitialized value from array at index 0" ——
这一层填的是造好的零值。`splitpatch.asy:29` 的 `pt.tree.initialized(i)` 问的正是那一格
标记，所以那一条还得先把"数组每格有没有初始化过"这件事表示出来才能做。

跑过的轴：pattern 那两条按 `import plain;` 的探针与 `asy -noV` 逐字节一致；
`tests/asy/cases` 全量按 `run` 那条腿逐个比对，无差异；
快扫 **214 干净 / 6 有诊断**（220 个共 2.0s、最慢 genusthree.asy 148ms，无并行）、
模块那一份 **0 条**。
没跑的轴：与上一批同（`run-llvm`、`OMNI_LEGS=all` 那三条腿、`tests/sexpr`、
`tests/run.js`、`tests/bootstrap`、深快扫、EPS/SVG）。

### 一批：按名字给的实参先配槽

`markregular.asy:19` 的

```asy
Ticks(scale(.7)*Label(align=E),NoZero,begin=false,beginlabel=false,
      end=false,endlabel=false,Step=1,step=.25,Size=1mm,size=.5mm,pTick=black,ptick=gray)
```

接不住 graph.asy:931 那份 `ticks Ticks(Label format="", ticklabel ticklabel=null,
bool beginlabel=true, bool endlabel=true, int N=0, int n=0, real Step=0, real step=0,
bool begin=true, bool end=true, tickmodifier modify=None, …)`。

`NoZero` 是 `tickmodifier`（也就是 `tickvalues(tickvalues)`），要**跳过**中间那一串带
默认值的槽落到 `modify` 上 —— 跳过这件事早就有（asy 的 matchArgument / matchDefault），
坏在**次序**：这一层按写下来的次序一个个配，位置那一路一边跳一边把跳过的槽记成"填了
默认值"，于是把后面 `begin=`/`beginlabel=`/… 要用的那几格也占掉了，那几个名字再来时
撞在"这格已经填过"上。asy 是**先配按名字给的**那几个（application.cc 的 matchSignature），
剩下的槽再按位置配。改成两趟就对上了。

九行的探针（量过 `asy -noV`）：

```asy
void g(string fmt="", string lab="", bool b1=true, bool b2=true,
       int N=0, real Step=0, mod m=keep, real Size=0) { … }
g("f", keep, b1=false, Step=1, Size=2);
```

出来是 `f` / 空 / false / true / 0 / 1 / 3 / 2 —— `keep` 跳过 lab/b1/b2/N/Step 落到 `m`。
`slot`（哪个实参落在哪个槽上）改成按 raw 下标记的定长数组，"求值次序要不要摊成临时量"
（reordered）配完两趟之后按**写下来的次序**扫一遍算。

于是例子面 **214 → 215 干净**（markregular 清零）。

跑过的轴：新用例 159-named-first 与 `asy -noV` 逐字节一致；`tests/asy/cases` 全量按 `run`
那条腿逐个比对，无差异；快扫 **215 干净 / 5 有诊断**（220 个共 1.8s、最慢 genusthree.asy
161ms，无并行）、模块那一份 **0 条**。
没跑的轴：与上一批同（`run-llvm`、`OMNI_LEGS=all` 那三条腿、`tests/sexpr`、
`tests/run.js`、`tests/bootstrap`、深快扫、EPS/SVG）。

### 一批：数学那一族当函数值、跨单元的文件级 `operator init`

`logdown.asy:10` 的 `draw(graph(exp,-5,5))`。两处，前一处挡住后一处：

**一、`exp` 当函数值取不到。** 数学那一族（sin/exp/floor/…）写死在调用那一步
（calls.js 的 `mathCall` 直接发 `(rmath "exp" …)`），于是这个名字**没有符号** ——
候选表里只剩内建面 asy_builtins.asy 里那份数组版 `real[] exp(real[])`，
`g(exp,1.0)` 报"要 real(real)，有的是 real[](real[])"。asy 那边 builtin.cc 的
`addRealFunc(exp,…)` 一次注册标量与数组两格，两格与同名的别的重载在**同一个集**里。

补法是按需现生一份包装进 `wraps`：

```
(fn asy__mv_exp ((asy__x0 real)) real
  (ret (rmath "exp" (var asy__x0))))
```

回一个候选记号（`{sym, params, ps, ret}`，与 nameOf 里构造函数那一族同型），
`nameOf` 与 `overArg` 两处都补 —— 后者是实参位置那条路（`sin` 有两格候选
`real[](real[])` 与 `pair(pair)`，走的是 overArg 不是 nameOf）。已经有**同型**的一份时
不补：`abs` 的标量四格摆在 asy_builtins.asy 里（第七十五刀）。九行的探针量过 `asy -noV`：
`g(exp,1.0)` 2.71828182845905、`h(floor,2.5)` 2、`k(atan2,1.0,2.0)` 0.463647609000806、
`real f2(real)=log; f2(1.0)` 0 —— arity 1 与 2、回 int 的那几个都能当值用。

**二、`Linear.T` 是 null。** `graph.asy:5` 的 `scaleT Linear;` 靠的是
`plain_picture.asy:83` 的 `scaleT operator init()`（它给 `T=Tinv=identity`）。
跨单元那一支（`recInit` 里换到声明 struct 的那个单元）把位置**拨到了 struct 声明处**
（`rec.at` = plain_picture.asy:65），而那份 operator init 在 :83 —— 按声明处问就看不见它，
于是拿到 T/Tinv 都是 null 的一份，`Linear.T(x)` 在运行时报
"call of a null function value"。量过 asy：`import graph; scaleT s; s.T(3.0)` 印 3。
`import` 把整份模块的名字都带过来、位置不参与，所以文件级 `operator init` 改成按
**那个单元整份**问（`unitIn` 给的 `u.at` 就是单元末尾）；字段默认值那一份照旧按 struct
声明处（问完 oinit 再把 `at` 拨回 `rec.at`）。

于是例子面 **215 → 216 干净**（logdown 清零）。

跑过的轴：新用例 160-mathval-oinit（带 mod_oi.asy）与 `asy -noV` 逐字节一致；
`tests/asy/cases` 全量按 `run` 那条腿逐个比对，无差异（130.4s）；快扫 **216 干净 / 4 有诊断**
（220 个共 2.3s、最慢 genusthree.asy 128ms，无并行）、模块那一份 **0 条**；
另外量过：例子面只多发一份 `asy__mv_exp`（`abs` 那一格照旧走内建面里那份真函数），
新用例里八个名字各一份、没有多出来的。
没跑的轴：`OMNI_LEGS=all` 那四条腿（run-c / interp / interp --mir / run-llvm）、
`tests/sexpr`、`tests/run.js`、`tests/bootstrap`、深快扫（`OMNI_SWEEP_SX=1`）、EPS/SVG 逐字节
—— 这一份与下一批一起跑。

### 一批：同名的文件级算符变量按签名挑、笔查询的默认实参、循环三对角解法

`logo3.asy:18` 的 `path A=(a,0){dir(10)}::{dir(89.5)}(0,y2);`。一条链上三处：

**一、`operator ::` 是一格变量，而同名的有好几格。** base 里它不是函数：
`plain_paths.asy:129` 是 `interpolate operator ::=operator ..(operator tension(1,true));`，
`three.asy:793` 又来一格 `interpolate3 operator ::=join3(…)`。`asyJoinVar` 问的是
`gvarHere`，那只回**最后一格** —— `import three;` 之后 2D 那两句于是报
"'operator ::' 的可变实参：要 void(flatguide3)，这里是 path"。asy 按**签名**分得开，
量过（`asy -noV`，从 `$R/base` 跑）：

```asy
typedef int conn(int,int);
conn operator ::=new int(int a,int b){return a*100+b;};
import three;
path A=(0,0){dir(10)}::{dir(80)}(1,2);
path3 B=(0,0,0)::(1,1,1);
guide h=(0,0)---(1,1)---(2,0);
```

出来是 304 / 1 / 1 / 2 —— 用户那一格写在 `import three;` **前面**，`3 :: 4` 照样走它，
所以判据只有签名、与"哪一格更近"无关。改成逐格试：新的先试（后 import 的压住前一份），
接不住就回滚诊断试下一格；一格都接不住时让**最后一格**照原样报（说的是最近那一份）。
带可变形参那一格走 `restValCall`，定长的按签名逐个 coerce 出 `(callfn (var 符号) …)`。

**二、笔的查询那一族不带实参时是 `currentpen`。** `logo3.asy:29` 的 `0.25*linewidth()`。
runtime.in 里这十份都写成 `T f(pen p=CURRENTPEN)`（:514 linetype、:545 linecap、
:555 linejoin、:565 miterlimit、:575 linewidth、:585 font、:596 fontsize、:601 lineskip、
:612 overwrite、:622 basealign），内建面里少了那一格默认值。量过不带实参的八个：
0.5 / 1 / 1 / 0 / 11.9551681195517 / 14.346201743462 / 那串默认字体命令 / 0，
`currentpen=linewidth(2)+fontsize(20)` 之后是 2 / 20 / 24。

顺手改掉一处**内建面自己的错**：`font()` 回的那串写成了 `"\\usefont{…}"`。asy 的
`"…"` 里**反斜杠不是转义**（量过：`write("a\\b")` 印 `a\\b`、`length("a\\b")` 是 4），
所以那样写出来是两个反斜杠，与真 asy 差一半。改成写一个。

**三、`tridiagonal` 从"还没做"改成真做。** 清掉 `::` 之后 logo3 落到运行时的
`abort: tridiagonal 还没做` 上 —— three.asy:932 的 `aim`（3D 的 Hobby 求解）要它。
照抄 runarray.in:1524 那份（四条分支：零 Dirichlet 边界、n==1、n==2、一般的循环情形），
次序与括号都跟着。

**这一处的差别写在明处**：n==4 的循环情形上真 asy 印 `-0.0833333333333333`，
这一层印 `-0.0833333333333334`。拿 node 按**同一次序**单独算一遍是后者 —— 也就是说
差不在这份转写上，而在真 asy 那个二进制：arm64 上 `a - b*c` 会融合成一条 `fnmsub`
（中间不舍入）。差一个 ulp，所以这份用例摆在 `tests/asy/tol/tridiagonal.asy`
（那一节的契约是最后一位十进制差不超过 1），不摆 `cases/`。

于是例子面 **216 → 217 干净**：logo3 的诊断清零（它还跑不完 —— `texpath` 那一头要
真 TeX，现在停在 "null reference"，与 asy 那边画出来的东西不是一回事，这条留着）。
剩下三个：AiryDisk（`gsl` 模块）、gamma3（复数 gamma）、splitpatch（`.initialized`）。

跑过的轴：新用例 161-opvar-pick-penq 与 `asy -noV` 逐字节一致、
tol/tridiagonal 与 `asy -noV` 在容差内一致（那一格差 1 ulp，理由在用例头上）；
`tests/asy/cases` 全量按 `run` 那条腿逐个比对，无差异；快扫 **217 干净 / 3 有诊断**
（220 个共 2.1s、最慢 genusthree.asy 132ms，无并行）、模块那一份 **0 条**。
没跑的轴：`OMNI_LEGS=all` 那四条腿（run-c / interp / interp --mir / run-llvm）、
`tests/sexpr`、`tests/run.js`、`tests/bootstrap`、深快扫（`OMNI_SWEEP_SX=1`）、EPS/SVG 逐字节。

### 一批：复数 gamma（连复数 exp / log 与复数幂）

`gamma3.asy:12` 的 `gamma(z)`（z 是 pair）。asy 那边它不是 GSL，是 runpair.in:28 里
**自己写的一份** Lanczos（g=7、九个系数），照抄过来：

```asy
pair gamma(explicit pair z) {
  if (z.x < 0.5) return pi / (sin(pi * z) * gamma(1.0 - z));
  pair w = z - 1.0;
  pair x = (asy__lanczos[0], 0);
  for (int i = 1; i < n; ++i) x += asy__lanczos[i] / (w + i);
  pair t = n - 1.5 + w;
  return sqrt(2 * pi) * asy__cpow(t, w + 0.5) * exp(-t) * x;
}
```

要的三格也一起补：`pair exp(explicit pair)`（runpair.in:22）、`pair log(explicit pair)`
（:203），以及复数幂 —— `std::pow(complex,complex)` 就是 `exp(w*log(t))`（libc++ 与
libstdc++ 都是这一句），所以写成一个 private 的 `asy__cpow`。

**`explicit` 这一格必须写**（与已有的 `sin(explicit pair)` 同一条，理由更硬）：内建面的
`real exp(real)` 是写死在调用那一层的（calls.js 的 mathCall），**根本不在候选表里** ——
不加 `explicit` 的话 `exp(1.0)` 会落到复数这一格上、回一个 pair。asy 那边 runpair.in 的
`pair exp(pair)` 没写 explicit，因为它那边标量那份是真候选、逐个同型时赢得过。

**量出来两格超出容差**，记在明处：`gamma((1.5,0.5))` 的虚部 asy 是 0.0274250854138825、
这一层 0.0274250854138827；`gamma((5,2))` 的虚部 asy 是 1.0575920372152、这一层
1.05759203721522（差 2e-14，也就是印出来最后一位差 2，而这一节的容差是 1.5 个步长）。
差不在这份转写上 —— 这一族是**超越函数的复合**（exp / log / atan2 各转手一次宿主的
数学库），误差会攒。所以 `tests/asy/tol/cgamma.asy` 只钉容差之内的那几格，超出的那两个
点写在用例头上。

顺手修了容差比较自己的一处**盲点**：`tolSame` 按空白切词，而 pair 印出来是
`(0.79…,0.027…)` 一整块 —— `Number()` 得到 NaN，两边只差最后一位也会判成"不同"。
切词改成把 `(` `,` `)` 也当分隔符**并且留在词里**（照旧逐字节比），所以
`tolSame("(1,2)", "1 2")` 还是 false。

于是例子面 **217 → 218 干净**（gamma3 的诊断清零）。剩下两个：AiryDisk（`gsl` 模块）、
splitpatch（`.initialized`）。

跑过的轴：新用例 tol/cgamma 与 `asy -noV` 逐字节一致（那两个超容差的点没进用例，
理由写在用例头上）；`tests/asy/cases` 全量按 `run` 那条腿逐个比对，无差异；
快扫 **218 干净 / 2 有诊断**（220 个共 2.6s、最慢 genusthree.asy 145ms，无并行）、
模块那一份 **0 条**。
没跑的轴：`OMNI_LEGS=all` 那四条腿（run-c / interp / interp --mir / run-llvm）、
`tests/sexpr`、`tests/run.js`、`tests/bootstrap`、深快扫（`OMNI_SWEEP_SX=1`）、EPS/SVG 逐字节。

### 量过之后决定不做：AiryDisk 的 `gsl` 模块（Bessel J）

`AiryDisk.asy:2` 的 `import gsl;`，要的只有一个 `J(1,r)`。asy 那边 `gsl` 不是 .asy 文件，
是 gsl.cc 注册的一个内建模块：`J` 是 `addGSLRealRealFunc<gsl_sf_bessel_Jnu>`，也就是
**实数阶** Bessel Jν。模块这一头这边现成 —— 模块搜索路径里已经有 `stage0/lib/asy`
（cli.js:196），摆一份 `gsl.asy` 就能 import 上。卡的是**精度**：

- 宿主数学库的**交集**里没有 Bessel。libm 有 `j0/j1/jn`（POSIX 扩展），V8 没有 ——
  所以它进不了 `(rmath …)` 那张白名单（那张表的判据就是"两边都有"），只能用 asy 自己写。
- 自己写的两条常规路子都量过了（拿 `asy -noV` 的 `J(0,x)`/`J(1,x)` 当参考，
  x 取 0.5…21.3 十一个点，相对差）：
  - 升幂级数：x ≤ 7.5 上 2e-16…6e-15（够），x=10 是 3e-13、x=15 是 2e-11、
    x=21.3 是 8e-9 —— 交替求和的抵消，补偿求和（Kahan）救不回来（量过，几乎不变：
    误差在**逐项相乘**里，不在求和里）。
  - Hankel 渐近展开：x ≥ 12.5 上 1e-13…2e-15（够），x=7.5 是 4e-8、x=5 是 1e-5 —— 不够。
  - 两条拼起来（在 x≈11 换手）最坏还是 **1e-12 量级**，落在 x∈(7.5,12.5) 那一段。

这一节的容差契约是"印出来最后一位差不超过 1"（≈1e-15），1e-12 比它松三个数量级。
GSL 那边够是因为它用的是**Chebyshev 拟合表**加分段渐近，那是一整套数据。
所以这一格**先不做**，理由记在这儿：不是漏了，是"照这个精度门槛，得先搬 GSL 的拟合表"。
AiryDisk 只画一张面、不印数，真要放行的话代价是"画出来的东西与 asy 差 1e-12 量级"——
那要单独决定，不在这一刀里顺手做。

### 一批：`gsl` 模块的 Bessel J（上一节那个"先不做"是量法不对）

上一节记的结论**推翻**，因为那次量的东西不对：拿 double 写级数、再拿渐近展开去补，
最坏 1e-12 —— 那是**方法**不够，不是这件事不能做。换成**双-双**（double-double，
Dekker 拆分，只要 `+ - *`，不要 FMA，所以两个宿主都写得出来）之后：

- 项与和都带一截低位，等效 ~32 位十进制；交替级数那 1e8 的抵消吃掉的是低位那一截，
  高位不动。**一条分支**就够，用不着渐近展开、也用不着换手点。
- 量法：`asy -noV` 的 gsl `J(1,x)`，x 取 0.25…21.2133 二十八个点。相对差最坏
  **3.7e-15 @ x=7** —— 而那一点回头拿 mpmath 40 位当真值一对，差的是 **GSL**：
  真值 `-0.004682823482345832699`，这边 `-0.00468282348234583`（对），
  asy/GSL `-0.00468282348234585`。`J(0,21)` 也一样，这边对、那边末位差 1。
- `J(5,10)`、`J(20,21)` 与 asy **逐字节一样**。

`stage0/lib/asy/gsl.asy`（新文件，模块搜索路径里已经有这个目录，见 cli.js:196）。
只给 `J`，别的（Y、I、K、Ai、Bi、椭圆积分、ζ…）没给 —— 220 个例子里只有
AiryDisk.asy:2 用 gsl，用的就是 `J(1,r)`。阶只做**整数**（含负整数，
J_{-n} = (-1)^n J_n）：非整数阶要 Γ(k+ν+1) 那条路（量过 asy 给
`J(0.5,2)` = 0.513016136561827），没做的事当场 abort，不猜。x ≤ 0 asy 报
"domain error"（量过 `J(1,0.0)` 与 `J(1,-3.0)` 都是），这一层没有那一格错误类型，
所以 abort 并把话说明白。

双-双用 `pair` 装（x 高位、y 低位），不用 `real[2]` —— 省掉每一步一次数组分配；
注意代码里**没有**一处用 pair 自己的 `+`/`*`，那是复数运算，全是显式函数。

例子那一头：AiryDisk **降级干净了**，220 个里干净 **219**（只剩 splitpatch），
模块那一份 0 条，快扫 1.7s、最慢 genusthree.asy 101ms。但它**跑**起来还死在
`null reference` —— 那一条与 gsl 无关：把 `J(1,r)` 换成 `sin(r)` 一样死（量过），
是 graph3 的 `surface(f,…,Spline)` 那条路上的另一个坑，另一刀的事。

新增 `tests/asy/tol/besselJ.asy`（不是 cases/：末位差一两个）。有两个点故意没放进去，
理由写在文件头上：`J1(7)` 与 `J0(21.2133)` 差的是 GSL 或者是"零点旁边只剩绝对精度"，
"末位差不超过 1"这条判据表达不了它们。

跑过的轴：快扫（219/220 干净、模块 0 条、1.7s、最慢 101ms）、`tests/asy/run.js besselJ`
五条腿全过（run / run-c / interp / interp --mir / run-llvm，5.5s）、oracle 对照
（`J(0,·)`/`J(1,·)`/`J(2,3)`/`J(5,10)`/`J(20,21)`/`J(-1,2)`/`J(-2,3)`）、
mpmath 40 位交叉验证。
没跑的轴：全量 `tests/asy/run.js`（这一批只新增了一个模块文件与一个 tol 例，
上一趟五条腿全量刚过：**252 过 0 败**，857.5s；`node tests/run.js` 也刚过 **91 过 0 败**）、
`tests/sexpr`、`tests/bootstrap`、深快扫（`OMNI_SWEEP_SX=1`）、EPS/SVG 逐字节。

### 一批：`new T[n][]` 外层每格是一条空数组（`import three;` 跑起来死在这儿）

先前这一格记反了，而且反得很贵：`asyNewArray` 的注释写着"`new real[2][]` 外层铺 2 格、
每格是**空引用**（`a[0][0]` 报 dereference of null array）"。重新量了一遍 asy，
四个数都不支持那个说法：

- `real[][] a=new real[2][]; write(a[0].length);` → **0**（读得出来，不是空引用）；
- `a.initialized(0)` → **true**；
- `a[0][0]` 报的是 `reading array of length 0 with out-of-bounds index 0`，
  **不是** null 那一句；
- `a[0].push(3.5)` 照样能用，而且 `a[1].length` 还是 0 —— 每格是**各自独立**的一条。

也就是 asy 的 `new T[n][]` 是"外层 n 格、每格一条新的空数组"。`new real[2][3][]` 也一样
（量过 `c[1][2].length` 是 0），元素类型是数组 typedef 的 `new rarr[3]` 也一样（量过是 0）。

这条不是纸面上的差别 —— **`import three;` 跑起来就死在它上面**：
three_surface.asy:460 `S.P=new triple[s.P.length][]`，紧接着 :463 `triple[] Si=S.P[i];`。
铺空引用时那一读就是 `null reference`，于是 three / graph3 那一族**一个都跑不起来**
（`import three; write(1);` 都死）。降级那一头一直是干净的，所以快扫看不见它。

改法（`stage0/src/frontend-asy/exprs.js` 的 `asyNewArray`）：把判据从"给了几个长度"
换成"**这个数组的元素自己是不是数组**"——

    let cell = t; let dims = 0;
    while (asyIsArr(cell)) { cell = asyElem(cell); dims++; }
    if (dims === 1) return { code: `(anew ${asyCore(t)} ${vals[0]})`, type: t };
    // 缺的那几维按长度 0 补进去
    let z = counts.length; while (z < dims) { as = `${as} (int 0)`; z++; }
    return { code: `(call ${L.arrNewHelper(cell, dims)}${as})`, type: t };

`arrNewHelper` 本来就是"逐行 aset 一条新的"，把缺的维数按 0 传进去，长度 0 的那一层
再往里也没有格子 —— 与 asy 的"每格一条空数组"逐格对上。顺带把 typedef 出来的数组元素
（`rarr[] e=new rarr[3]`）也一起接住了：判据看的是 `t` 的真实维数，不是写法。

`import three;` 于是往前走到了下一道墙：`abort: intersections(path,pair,pair) 还没做`
（模块初始化里就会调）。那是另一刀。

还有两样**没动**，写在 `asyNewArray` 的注释与新例子的头上：`new real[2][3]` 两层都铺满
之后读 `d[1][2]`，asy 报未初始化、这一层给 0；`new S[2]`（S 是记录）读 `f[0].x`，
asy 报未初始化、这一层是空引用报 null reference。那两条要等"空槽"进方言。

新增 `tests/asy/cases/162-new-outerdim.asy`（逐字节一样）：两维/三维/typedef、
push 进某一行之后另一行不受影响、两层都给时的长度。

跑过的轴：快扫（219/220 干净、模块 0 条、2.3s、最慢 genusthree.asy 143ms）、
oracle 逐字节对照（新例子与 6 个 /tmp 探针）、全量 `node tests/asy/run.js`（两条腿，
结果见下一段）。
没跑的轴：`OMNI_LEGS=all` 那三条额外的腿（run-c / interp / interp --mir）、
`tests/run.js`、`tests/sexpr`、`tests/bootstrap`、深快扫（`OMNI_SWEEP_SX=1`）、
EPS/SVG 逐字节。

### 一批：`intersections(path,pair,pair)` 与 `cubicroots`（`import three;` 跑通了）

上一刀把 `new T[n][]` 修好之后，`import three;` 往前走到了这一格：
`abort: intersections(path,pair,pair) 还没做`。它不在例子里，在**模块初始化**里 ——
`three_surface` 的 `regularize` → plain_paths.asy:318 的 `pair inside(path, pen)`
→ `intersections(p, z, z+I*dir)`。也就是说这一格不给，three / graph3 那一族
一个都跑不起来。

两个正文都是照抄 path.cc，不是另想一套：

- `cubicroots`（原来是 abort 桩）= path.cc:154 的解析解。三个分支：系数 a 在数值无穷远
  那一档时退成二次、d 在数值零那一档时挑出 t=0 再解二次、剩下走 Q/R/D 那套判别式
  （D>0 一个实根、否则三个，用 `cbrtsqrt1pxm` 与 `costhetapi3` 那两个防掉精度的展开）。
  连同 path.cc:46 的二次求根一起抄了一份**按重数**报的私有版（`asy__qroots`）——
  公开的 `quadraticroots` 报的是 distinct 那一套，cubicroots 看的是 roots，
  x == -1 那一格是重根（roots=2、t1=t2），两份不能共用一个正文。
- `intersections(path,pair,pair)` = runpath.in:235 + path.cc:815 的 `lineintersections`
  （endpoints=false 那一路）+ path.cc:897 的 `add`。每一段把三次贝塞尔投到"到直线的
  有向距离"上得一个三次多项式，解实根，落在 [0,1] 内且 `online` 认的才收，
  再**按点**去重、升序。默认 fuzz 也照抄（`BigFuzz * max(…)`）。

这一层没有 `cbrt`（宿主交集里没有，`(rmath …)` 那张白名单进不去），用 `^` 带符号顶上；
末位可能差一两个 ulp，但下面这些点上没露头。

量法是**两个方向都对**：
1. 先把这份 asy 代码拿到**真 asy** 上跑，与内建的 `intersections(p,a,b)` 对 ——
   8 个探针（三次样条闭路 / 圆 / 折线；水平、竖直、斜线、不相交、与一条边重合、
   切过顶点）**逐字节一样**，说明抄对了；
2. 再把同一份放进这一层跑，与 asy 跑同一份对 —— 也**逐字节一样**，说明
   `point(p,t)`/`postcontrol`/`precontrol`/`sort`/`^` 这几样在两边一致。
`cubicroots` 另有 10 个探针（一根 / 三根 / 重根 / 退化到二次 / 系数在数值零那一档），
与 asy 逐字节一样。

结果：**`import three; write(1);` 跑出 1**，`import graph3;` 也跑得通，
`surface(f,(-1,-1),(1,1),2)` 的 `s.s.length` 与 asy 一样是 4。

新增 `tests/asy/cases/163-lineix-cubicroots.asy`（逐字节一样，18 组）。
`import three` 那一路进不了 cases/ —— run.js 不给 ASYMPTOTE_DIR，模块要真 base。

跑过的轴：快扫（219/220 干净、模块 0 条、2.4s、最慢 genusthree.asy 135ms）、
oracle 双向逐字节对照（8 + 10 个探针，见上）、`import three` / `import graph3` /
surface 三个 /tmp 冒烟、全量 `node tests/asy/run.js`（两条腿，结果见下一段）。
没跑的轴：`OMNI_LEGS=all` 那三条额外的腿（run-c / interp / interp --mir）、
`tests/run.js`、`tests/sexpr`、`tests/bootstrap`、深快扫（`OMNI_SWEEP_SX=1`）、
EPS/SVG 逐字节。

### 一批：一个源文件一份 ESM 产物（分离编译、增量、库的正文不重降）

`import three;` 跑通之后，挡在"220 个例子全跑起来"前面的不是语义，是**时间**：一趟
`run 例子.asy` 要 1.8–2.2s，而其中真正属于这个例子的活儿不到 5%。这一批把它拆开。

**一、核心方言能分离编译了。** 加了一个只声明不定义的形式：

```
(sig "出处" (fn 名 (形参) 返回类型))
(sig "出处" (global 名 类型))   (sig "出处" (class 名 (字段 类型)…))   (sig "出处" (cfn …))
```

`sexpr/lower.js` 把 `(sig …)` 收进一张"只有签名"的表（`sigOnly`），装配时跳过它们的
定义与零初始化；带出处的那些同时记进 `imports`，后端据此发**真的 `import`**。
于是一份核心方言模块只要知道别人的签名就能单独编成 JS。

**二、名字不能再依赖加载顺序。** 这是"一个库一份产物"的前提，也是这一批里最烦的一半：

- 单元前缀从 `asy__m<第几个被加载的>_` 改成 `asy__m<身份哈希>_`（`unitNew` 按 `key`
  取哈希）。以前同一个 `plain_pens.asy` 在 `import graph` 的例子里与在 `import three`
  的例子里编出来的符号名不一样，那份产物就没法给另一个例子用。
- 每个单元自己一套编号计数器（`nsym`/`ntmp`），不再用全程序那一个。
- 闭包改成 `omni_clo_<名>` / `omni_mk_<名>`，fnRef 适配器 `omni_clo_ref_<名>`，
  方法值 `asy__mvw_<候选符号>` —— 都是**内容决定名字**。
- 默认实参的包装名从计数器改成「被调方的符号 + 缺的那几格槽号」
  （`…_shipout__d0_2_3`）。

**三、`omni_weak`：名字由内容定、成员由程序定的那一档。** HELPERS、元素是记录的数组
工厂、cyclic 登记处、内建数学包装、隐式构造、默认实参包装、函数类型上的默认值包装 ——
这些**生不生取决于有没有人这么调**，放进库里那个库的产物就跟着调用方变。量出来的：
`import graph` 与 curve.asy 两个入口底下，plain 那一份只差一条 `shipout__d0_2_3…`，
别的 6 份逐字节一样。把它们挪进 `omni_weak` 之后，库那几份**跨入口逐字节相同**。

**四、链接（`frontend-asy/link.js`）。** 输入是 `lower.js` 按单元分好的段，输出是
一份份独立的核心方言模块：自己的定义照原样发，用到的别人家的名字发成
`(sig "出处" …)`。「谁定义了这个名字」是从**发出去的文本自己**读出来的（每条顶层项的
第一行就是它的签名），所以签名不可能与定义不一致。两处是量出来才补上的：

- **两个名字空间**（类型 / 值）。asy 里一个 struct 的构造函数就叫 struct 自己的名字，
  合一张表后者盖前者，那一格类就没有字段，接着刷几百条"类 X 没有字段 Y"。
- **签名要闭包到不动点**。`(class autoscaleT (scale scaleT) …)` 里的 `scaleT` 又是一个类。

**五、产物与增量。** `.omne-cache/asy-mods` 一层平铺、**按源文件名只换后缀**
（`plain.asy` -> `plain.sx`/`plain.js`/`plain.stamp`），模板实例化后缀一段身份哈希
（`iter__8a0a8a29`）。印记不哈希那一大坨文本，只记「编译器 + 它自己那个源文件 +
它引到的那几个源文件」的 `路径:改动时间:字节数`（stat 是常数时间；哈希 1.3MB 要 172ms）。
每份产物是**真 ESM**：`export` 定义、`import` 别人的名字；asy 有跨文件赋值，所以 esm
模式下每个全局装箱（`export const g_X = { v: undefined }`）。`omni_rt.js` 把前奏与
分派器 `Object.assign` 到 globalThis，生成的模块里 `$print`/`$W` 就还能裸着用。

**六、清单快路。** 产物缓存只砍掉"核心方言 -> JS"那一段，而大头在前端 —— 判断"能不能
用"这件事本身必须便宜。`main-<入口>.dep` 记下这个入口用到哪几份产物、每份对应的源文件
及其改动时间/字节数；下一趟只 stat 那几十个文件，成立就**整个前端一步都不走**。
量出来的：同一入口重跑 2.045s -> 0.374s。

**七、库的产物还在就不降它的正文。** 上面那些让"换个入口"少编了几份 JS，但一个**新**
入口（220 个例子每个都是新入口）还是 1.0–1.3s。CPU profile 说清了钱花在哪
（unitcircle.asy，AST 缓存与产物都热）：

```
asyText（整个 asy 前端）    645ms
  ├ asyDeclPass(root)      221ms   递归加载 13 个库 + 声明遍（AST 读回 47ms 在内）
  └ asyBodyPass ×13        368ms   库的**正文降级**
asyLink                   ~110ms
lowerCoreSexpr             40ms   只编新的那 2 份
spawnSync（跑出来的程序）  273ms
glrParse                    3.8ms  语法分析早就不在账上了
```

`--verbose` 那些行会骗人：`vStep` 的 delta 记在**打印这一行之前**那段活儿上，所以
`omni: asy module simplex2 [352ms]` 说的不是 simplex2（它 1356 个 token，AST 读回 3ms），
而是"走到 plain_scaling.asy:204 那句 `from simplex2 access problem;` 之前"的那一段。

白付的是 **asyBodyPass 那 368ms**：它降出来的东西逐字节等于盘上已经躺着的
`plain.sx`/`plain_bounds.sx`/…。所以：**一个库的 `.stamp` 还对得上，就不跑它的
asyBodyPass**（`lower.js` 的 `skipBody` / `cli.js` 的 `asyModsSkip`）。声明遍那 221ms
省不掉 —— 入口要那些表才编得动，而表只能由 declPass 现算。

一份产物旁边因此多了三格（都是"原文件名，只换后缀"）：

- `<名>.sec`：它定义的名字与签名（每条顶层项的第一行）。别人引它时要发的 `(sig …)`
  就从这儿来 —— 不降正文也知道它有什么。
- `<名>.wk`：它引到的那些 **weak 项的正文**。那一档按程序生成，跳过它的正文就没人生了，
  而它的 `.js` 里 import 着。要**闭包**：weak 项自己也会引别的 weak 项。
- `<名>.dep`：复用它时**还得把哪几份也带上**。这一格是被 `class problem` 逼出来的 ——
  `plain_scaling.asy:204` 那句 import 在**函数体里**，跳过 plain_bounds 的正文之后
  simplex2 这个单元压根不存在，而 plain_bounds 的 `.js` 引着它。

三处顺带修掉的坑，都是量出来的：

1. **`omni_weak` 是按程序生成的，名字却必须固定**（库的 `.js` 里写死 `'./omni_weak.js'`，
   不然一个库的产物就跟着入口变）。于是换个入口跑就把它盖掉，而清单快路只看源文件没动
   —— `run tri`、`run curve`、再 `run tri`，第三趟命中清单却拿着 curve 那份 weak，报
   `s_…_shipout__d0_2_3_4_5_6_7_8_9` 不是它的导出。现在清单里多一行
   `w|<omni_weak 的印记>`，对不上就老实重来。
2. **正文被跳过的单元不能再用它的编号计数器**（`asy__anon<n>`）。那个编号只有"整份正文
   都降一遍"时才确定；跳过之后替它生的那几段（默认实参里的匿名函数 —— 降它时
   `L.unit` 换成被调方）会占到盘上那份已经用过的号，两段不同的代码撞成一个名字。
   量出来的样子是 filesurface（graph3 那一路）报
   `捕获 'asy__self' 要 …_picture，这里是 Label`。frozen 的单元改按**位置**取名
   （`genSym`）：同一个源文件里位置唯一，与降级顺序无关。
3. **入口那一份不出 `.sec`/`.wk`/`.dep`**。入口单元的前缀是空串，顶层名字是裸的
   （`cardioid.asy` 里那个 `real f(real t)` 就叫 `f`），而 `refsOf` 是往多了算的 ——
   别的程序算"还要带哪几份"时把某个库 weak 项里出现的 `f` 认成"cardioid 定义的"，
   于是 `main-label3.js` 里多出一句 `omni_init_cardioid()`，label3 与 gamma3 双双死在
   `$alen`（跑的是另一个例子的初始化）。同一条的另一半在链接那层：**入口的名字只有
   入口自己与 weak 能引**，库那一份引到就报"未声明"（看得见），不再悄悄把入口
   import 进库的产物里。

量出来的账（缓存全热）：

- 新入口：2.0s -> **0.61–0.75s**；核心方言这一趟只拼 169KB（从前 1.28MB）。
- 同一入口重跑：**0.27s**（清单快路，前端一步不走）。
- 一个库改了：只重编它自己那一份与 weak，别的原样留着（`touch settings.asy` -> 新编 2、复用 11）。

同一批里还有三件小的：`tests/asy/draw/` 补了 colors / curve / implicit / xform 四个
用例（隐式 shipout 那条钉在 implicit.asy 上）、`run.js` 每个例子加了 ≤30s 的超时、
cyclic 那一路的拷贝。

跑过的轴：快扫（220 个例子、219 干净、模块 0 条、2.5s、最慢 genusthree.asy 188ms）、
tests/asy/draw 五个用例的**两条路逐字节对照**（单体路 vs 模块路）并**交错跑三轮**
（换入口、再换回来 —— 上面第 1 条就是这么量出来的）、examples 前 60 个两条路逐字节对照、
`OMNI_ASY_MODS=1` 与不开时的产物复用统计。
没跑的轴：全量 `node tests/asy/run.js`、`OMNI_LEGS=all`、`tests/run.js`、
`tests/sexpr`、`tests/bootstrap`、深快扫（`OMNI_SWEEP_SX=1`）、EPS/SVG 逐字节。

`OMNI_ASY_MODS=1` 仍然是开关，还没变成 `run` 的默认。

### 一批：库的**接口索引**（换个入口不再重走声明遍）

上一节把库的**正文**省了，声明遍那 221ms 还在。换个入口跑 tri.asy（20 行，16 行是注释，
真代码 4 行）量出来是：声明遍 367ms、这个例子自己的正文 16ms。**23 倍的白付**。

第一版想歪了：给 AST 做裁剪（`astPrune` / `.dast`）。被一句话点醒 ——「巨大的 C 语言库，
导入时需要巨大的头吗？不是。需要的只是变量名或函数名，匹配」。裁剪还是要读、要解析；
真正该问的是**声明表里到底哪几格被用到**。

于是把库的候选表用 Proxy 毒一遍，数谁真被摸：

```
候选项 c.node（整棵函数体 AST）  14234 棵 = 61MB   全程只摸 2–8 次，都在 calls.js:1993
默认实参表达式 p.d               6913 条  = 441KB  重载定型时必须现算
record 正文语句 rec.stmts        44 条            recNew 要按 mat 与字段交错
```

61MB 里被用到的是 **8 次**。所以一份库不再存 AST，改存一格 `<名>.aif` ——
**接口索引**：函数 / 全局量 / record 可见性 / 类型别名 / 转换 / 运算初值全是**标量表**
（名字、签名、符号、槽位），只有四处存打包过的 AST 片段：默认实参、record 字段的
`def`/`fnbody`、struct 正文语句、以及默认实参里出现 `new-function` 时那个被调方的正文。
`stage0/src/frontend-asy/iface.js` 是这一格的全部（`asyIfaceDump` / `asyIfaceLoad`），
读回时由 `lower.js` 的新 `unitStub` 造一个**没有正文**的单元。

两个把索引撑爆的坑，都是量出来才知道：

1. **只能导出"自己这份定义的"**。第一版把合并后的整张表倒出来 —— 17MB，比它要替掉的
   7.7MB AST 还大。改成按 `c.unit !== u.id` 滤掉借来的，再存一条 **import 重放表**
   （`u.imps`，五个合并点全部收口到 `asyModMerge`）：读回时照原样重放一遍 import，
   借来的名字自然又长回去。3.0MB。
2. **闭包型默认实参**要连被调方的正文一起带（`new-function` 在里面）。只对含
   `new-function` 的片段存那一份 → **1.0MB**（20 份库合起来 1.1M）。

读回路上五个坑，全是"少存了一格"或"存回来的形状不对"，都由报错钉到位：

1. 少了 `rec.statics` → picture / filltype / projection 报「取字段 `.keepAspect`」。
2. 少了 `casts` / `oinits` → `bool3` 三目「两支的公共签名里没有同型的一份」、
   `transform * string`。
3. `fnbody` 存回来是 `null` 而不是 `undefined` → `recNew` 的守卫
   （lower.js:2436 那句 `f.fnbody !== undefined`）放过去，cos2theta / integraltest 死在
   `null.items`。
4. `rec.stmts` 只存了长度、内容是 null → alignedaxis 死在 lower.js:2428 的 `sts[si].mat`。
   得把打包过的语句连 `mat` 一起存（`recNew` 拿 `mat` 跟字段默认值交错）。
5. 造出来的 SourceFile 存根得像个真文件：`lineText` 缺了 `diag.js:91` 崩、`lineCol`
   返回 0 行 0 列 `diag.js:94` 报 `Invalid count value: -1`。

量出来的账（coag.asy，删掉清单强制走前端，同一个例子连跑三趟）：

```
             源码路              接口索引路
总时长       706 / 620 / 516ms   404 / 403 / 471ms
编译那半     ~465ms              ~130ms
跑出来的程序 ~275ms              ~275ms      （这一半跟前端无关）
```

oracle（`/opt/homebrew/bin/asy -noV`）同一个例子 370ms。

### 第七十九刀：产物名只取基名 —— 一个"跑错程序"的缓存，以及它伪造出来的一次测量

这一刀本来只想量清楚"改一个字符为什么还要 640ms"，量出来的是一个**正确性**问题。

复现是一句话：

```
$ omni run /tmp/tri2.asy          # 文件里一句画图都没有，全是 write(...)
asy mods 命中   15 份产物一份没动
%!PS-Adobe-3.0 EPSF-3.0           # ← 一份 EPS
...
```

一步前端都不走，跑出来的是**另一个程序**。`/tmp/asyfp/tri2.asy` 是我为了量指纹随手放的一份
画图的例子，它与 `/tmp/tri2.asy` 只有目录不同。三处名字都只取**基名**：

- AST 缓存 `.omni-cache/asy-ast/tri2.ast`；
- 每个源文件一份产物的 `tri2.js`/`tri2.sx`/`tri2.stamp`；
- 入口清单 `main-tri2.dep`。

那份 `.stamp` 里确实记了全路径，代码注释也写着"撞了就是印记不一致，退化成不命中"——
**那句话是错的**。`inpOk(field)` stat 的是 field 里**记着的**那个路径，不是这一趟要的这个：

```js
const c3 = field.lastIndexOf(':'); …
const p = field.slice(0, c1);      // 印记里那个路径
if (`${m}` === … && `${n}` === …) return { ok: true, … };
```

`/tmp/asyfp/tri2.asy` 没动过，于是"命中"，于是拿它的树、拿它的产物、拿它的清单。
撞名字不是退化成不命中，是**静静地编译并运行另一个程序**。

改法与 rustc 的 `-C metadata`、Cargo 的 fingerprint 一样：**身份进名字**。
产物名成了 `<基名>__<8 位哈希>`，哈的是「解析到的真文件 + 模块身份」两样
（模块身份那一半留着，同一个 `iter.asy` 的三次模板实例化仍然是三份产物）；AST 缓存那一格
按路径哈希起名，并且命中前先核一遍 `inpPath(印记) === 这一趟的路径`。

顺着这条线又抓出两处让**接口索引整片死掉**的错：

- `iface.js` 的 `asyIfaceLoad` 第一行写死 `if (obj.v !== 1) return null;`，而 dump 那边早就
  写 `v: 2` 了。于是 `OMNI_ASY_IFACE=1` 打开也一条 `asy 接口索引` 都不打 —— 我从前记进
  注释的"开 617/674/690ms、关 635/642/640ms，一点不省"，**两趟量的是同一条路**。
- 产物名里带源文件路径的哈希之后，"这个库的产物还能用吗"这一问发生在**加载之前**，
  而 `pathOf` 从前只认加载过的模块（`fe.paths` 是 loader 一路 push 的），那时回 `undefined`。
  名字于是算成 `asy_builtins__<key 的哈希>`，与盘上的 `asy_builtins__<路径的哈希>` 对不上，
  13 份里只有 2 份找得到 `.aif`。把"找文件"从 loader 里摘成一个只 stat 的 `resolve` 就好了。

两处修好之后，改一个字符那一趟的日志里**一条 `asy module` 都没有** —— 10 个库全走索引，
一份库源码都不解析。安静环境下量（`/tmp/tri2.asy` 改一个字符，三趟三趟）：

```
                     关索引            开索引
run（编译 + 跑）     885/738/623ms     551/502/477ms
asy-units（只编译）  537/517/508ms     406/333/273ms
```

于是 `OMNI_ASY_IFACE` **默认打开**（`=0` 关掉，对照用）。两个入口交替跑（tri ↔ implicit）
现在是 167–207ms 一趟、八趟没有一次尖峰 —— 用户最初报的 0.24s/0.94s/1.27s 那种周期性
不再出现。

代价与还没做的：产物目录里的名字都带了一段哈希，肉眼不再能直接认出"这份是谁"（基名还在，
够用）；这一刀把整个 `.omni-cache` 作废了一次（它是缓存，重建一遍就是）。剩下的 273–406ms
里，语法表 29ms、十份接口索引 51ms、入口自己降 16ms、链接与切段 59ms、发 JS 35ms，
其余是 node 自己起来那一段 —— 要再往下走得靠 ADR-0015 第 5 步（接口按**条**存）。

### 第八十刀：接上 oracle 的 EPS 那一轴，顺手量出接口索引"快但还不对"

主线的判分从这一刀起换成**画出来的东西**：`asy -noV -f eps` 给 220 个例子各出一份参考
（`/tmp/epsref`，其中 28 份真 asy 自己也出不了 —— NURBS/PRC/三维那一族要外部工具），
剩下 192 份逐个与我们 stdout 上那份比。比法不是逐字节：把注释与空白去掉、切成
「数 + 运算符」的流，运算符逐个相等、数按 1e-3 比（两边的字体前言、日期、Creator 都不同）。

第一趟的数字很难看，而且**难看在一个我自己刚打开的开关上**：

```
接口索引默认开：出图 15 份   一样 2   结构不同 13   没出图 177
```

把"没出图"那 177 份的第一条错按次数排一遍，头一条占了 101 份：
`asy 前端第一刀还不支持：带点的名字或算符名`，报在 `plain.asy:1:1`。关掉索引同一个例子
就出图。三处根因，都是"接口读回来之后，某一格没跟着回来"：

1. **`access m;` 只建别名、不并名字**。`imps` 那张重放表是在 `asyModMerge` 里记的，而
   access 根本不走 merge —— 读回来 `L.mods` 是空的，接口里存的默认值表达式里那些
   `settings.tex`、`version.VERSION` 于是落到 exprs.js 的"带点的名字"上。
   改法：`.aif` 里多存一张 `mods`（别名 -> 那个库的 key/mname/模板实参 + 可见位置），
   读回来先按它把每个别名重新加载并坐进 `L.mods`。**101 份 → 0 份**。
2. **读回来的单元又被重新 dump 了一遍**。`chunk()` 里只看 `skipped`，而接口单元既不在
   `skipped` 里、又确实"这一趟没降正文"，于是每趟都重写一份 `.aif`。这个来回是**有损**的：
   dump 只留 `unit === u.id` 的候选，而读回来之后有些格子的来源已经换成了替身单元，
   存一代掉一点。量到的样子极干净 —— `AiryDisk` 单独反复跑一直好，中间夹一个别的例子
   再跑就报 `'texpath' 在这里还看不见`。改法：接口单元打 `fromIface`，不再重 dump，
   盘上那份原样留着。**72 份 → 34 份**。
3. 顺带的两处（上一刀记过）：版本门写死成 1、名字算在加载之前。

修完三处，出图 15 → **44** 份。但把开关关掉再量一遍，答案是 **55** 份 —— 索引这条路
**还欠 11 份**，而且还剩两族只有它才有的错：34 份 `'X' 在这里还看不见`、
19 份 `字段 'X' 的默认值：不能把 null 当成 T`。

所以 `OMNI_ASY_IFACE` **改回默认关**。这不是把上一刀的结论推翻：那三处修的都是真 bug，
打开之后改一个字符确实是 273–406ms（关是 508–537ms）。但"快"不能拿"少画 11 张图"换，
而这两族错的根子是"接口按**整份**存"——一份库的表里混着别人家的格子，来回一趟就掉。
按条存（ADR-0015 第 5 步）之后再打开，判据就是这一轴的出图数追平 55 份并继续往上走。

关索引那一档的 137 份没出图里，头一条占了 **107 份**：

```
 107  omni: runtime error: array index out of range: N (length N)
  16  没有错误输出（退出 null）        例：cones cylinder hyperboloid
   3  omni: runtime error: cannot read '…': ENOENT
   2  模块找不到（lowupint / spring —— 例子自己带的 .asy 不在 examples 目录里）
```

一条运行期的越界占了四分之三 —— 下一刀从它开始。

### 第八十一刀：空 frame 的三维界、LU 解方程、二分夹插值求根

上一刀那个"占四分之三的越界"是**假的**：`array index out of range: 0 (length 0)` 是
`abort` 之后**接着**印出来的第二条，真正的第一条在 stdout 上的 `abort:` 那一行。归类改成
优先取 `abort:` 之后，队伍才露出真面目 —— 这一刀按队头三格往下削。

**一、`min3(frame)` / `max3(frame)` 空 frame 不该报错。** 从前这两格的体是
`abort("没有三维的东西")`，是我自己编的。量的（`import three; frame f; write(min3(f));`）：
真 asy 印 `(0,0,0)` 两行、退出码 0。而 three.asy 里到处是"先量一遍界再决定投影"
（2461/2617/2883…），于是 **29 个例子当场停在这一句**。改成空 frame 回原点之后
AiryDisk / BezierPatch / BezierTriangle / RiemannSurface 那一族才走到 `tensorshade` 与 `solve`。

**二、`solve(real[][], real[])` 与 `solve(real[][], real[][])`（runarray.in:1267/1320）。**
照抄 runarray.in:520 的 `LUdecompose`（Crout，Numerical Recipes 的 ludcmp）：矩阵行优先
**平铺**成一条 `real[]`，隐式缩放向量 `vv`、部分选主元用 `>=`（并列取后者）、"先把 j 列上三角
那几格算完再在同一列找主元"的次序都跟着 —— 换个次序浮点尾数就不一样，EPS 就对不上。
`asy__flat2` 顺手把 arrayop.h:556 那两句错误也抄了。量出来的三格（`asy -noV`，与我们逐字一样）：

```
solve({{1,2},{2,4}}, {1,2})        → sv.asy: 3.5: Singular matrix        （warn 默认 true）
solve({{1,2},{2,4}}, {1,2}, false) → 空数组（.length 印 0）
solve({{1,2,3},{2,4,5}}, {1,2})    → sv2.asy: 3.6: matrix must be square
solve({{2,1},{1,3}}, {3,5})        → 0.8	1.4
```

**三、`_findroot`（runarray.in:1758）。** 那份 C++ 自己注明是 Charles Staats III 的 asy 版的
移植：二分**夹着**一步二次插值。两处细节不能省 —— 先把函数整体翻成"a 端为负"（`sign`），
以及插值落到端点 `(b-a)*1e-3` 以内时往里推一倍。少了后者根会贴边，迭代次数与最终尾数都变。
插值那一步调的是这一层已有的 `quadraticroots(real,real,real)`（它回的根已排序，正好对上
C++ 那个 struct 的 `t1`/`t2`）。量（`import math;`，三份逐位一样）：

```
findroot(x^2-2, 0, 2)        → 1.41421356237309
findroot(cos(x)-x, 0, 1)     → 0.739085133211431
findroot(x^3-x-1, 1, 2, 1e-10) → 1.32471795724475
```

原来卡在这两格的 11 个例子（AiryDisk arrows3 bars3 cos3 exp3 fin gamma3 genusthree
genustwo pipes sin3）全部走过去了，各自停在下一层：`_texpath` 5 份、`tensorshade` 1 份、
运行期越界 2 份、bezulate 的 JS 错 1 份，AiryDisk 与 arrows3 超 3s 归到"慢"。

**没跟着改的两格记一笔**：`determinant` 与 `inverse` 这一层还是自己那套 Gauss（部分选主元 /
Gauss-Jordan），而 C++ 那边 `determinant` 走的正是这一刀新加的 `LUdecompose`、`inverse` 在
n==2/n==3 上有闭式、n>=4 走**全**选主元。选主元策略不同 → 尾数不同。没动的理由是这一轴
按 1e-3 比数值，这点差落不到判定上；真要逐位对齐时再换。

三条回归轴：`tests/asy/run.js` 259 passed / 0 failed；220 例扫一遍 219 干净、1.3s、最慢
controlsystem.asy 73ms（速度合同没破）。

### 第八十二刀：`fill(path)` 画到了没人印的那张图上；渐变、裁剪与摆放

这一刀开头以为要做的是"渐变那 47 份"，做完才发现队伍里混着一条**更要紧的**：

**一、`fill(circle(…))` 那一笔凭空消失。** 这一层为"不 import plain 时也能画"备了几格短路：
`void fill(path g)` / `void fill(picture pic, path g, pen p)` …，画进的是**内建面自己那个
`currentpicture`**。而 plain 里那份是 `void fill(picture pic=currentpicture, path[] g,
pen p=currentpen)` —— 收的是 `path[]`，要过一次 `path[] operator cast(path)`（plain_paths.asy:44，
真 asy 那边这条 cast 也在 plain 里、不在 C++ 内建面）。重载解析按转换代价挑，于是
`fill(g)` 落在**这一层**那格上：画进了没人印的那张图，那一笔就没了。`draw(g)` 与 `size(…)`
没事，因为 plain 那两份的形参类型是精确匹配，打平之后取后声明的（plain 的）。

改法：内建面也备一份 `path[] operator cast(path)`，短路那几格全改收 `path[]` ——
两边于是都要过一次转换、打平、取 plain 那份。量到的样子（yingyang.asy）：改之前
`currentpicture.nodes.length` 在三条语句后是 0 / 1 / 1，真 asy 是 1 / 2 / 3。

**二、渐变与网格填充那一族**（`latticeshade` / `axialshade` / `radialshade` /
`gouraudshade` / `tensorshade`，队里 47 份）。drawop 上多一格 `shadeinfo`（只有渐变那一档
才有，其余是 null），出图那一段照 drawfill.h:75 的 `drawShade::draw`：`gsave`、整条超路径
当裁剪、`clip`、发 PostScript 的那一段字典、`grestore`。四份字典逐字照 psfile.cc 抄
（`/ShadingType 1/2/3/4/7`、`FunctionType 0/2`、lattice 的十六进制采样表、tensor 那 12 个
边界控制点**倒着走**加 Coons 的内部点公式、颜色按一族笔里最大的那一档升）。
`functionshade` 还是 abort（要把用户那段 PostScript 当函数塞进字典里），透明度也还没发。

**三、`clip(frame)`**（队里 10 份）。runpicture.in:256 是 `f->enclose`：头上插一格、尾上追
一格，所以之后再画的东西不受裁剪。界要按 drawclipbegin.h:37 与 drawclipend.h:28 那两段用
**一个栈**算：进裁剪压"到这里为止的界"与"裁剪路径的界"，出裁剪先交后并。还有 picture.cc:301
那个"两格 endclip 挨着就把前一格的 gsave/grestore 省掉"的优化 —— 它发在**量界那一趟**里，
所以这一层也放在 `opsbox` 里做（少了它 colorplanes.asy 会多出一对 gsave/grestore）。

**四、摆放那个 `max` 不能省。** picture.cc:1187：`bboxshift = (-b.left,-b.bottom)` 再加半格
"多出来的纸"，而 `xexcess = max(paperwidth-(宽+1), 0)`。从前这一层写的是 `(612-宽)/2-0.5`，
图比纸宽时给出负的左边界（yingyang.asy 宽 708.66，参考是 0、我们是 -49）。

**五、`gsave`/`grestore` 连"上一支笔"一起存取**（psfile.h:303/310 那两句 `pens.push` /
`pens.top`）。裁剪或渐变段里改过的笔出来之后不算数，下一笔要把那五行重新发一遍 ——
yingyang.asy 与 Sierpinski.asy 的最后一处差就是它。

这一批之后，**能出图的 76 个例子里逐字一样的从 6 涨到 18**（渐变那 47 份与裁剪那 10 份
不再 abort）。剩下的 54 份结构不同**绝大多数是同一件事**：参考里有 TeX 排出来的文字
（`/TeXDict` 那一段），我们这一层只画得出几何，界也就跟着差几个单位 —— 那一格要等
`_texpath` 那一路，不是这一刀能收的。

跑过的轴：`tests/asy/run.js` 259 passed / 0 failed、220 例扫一遍 219 干净（2.0s、最慢
genusthree.asy 139ms）、EPS 那一轴在 76 个能出图的例子上。
没跑：EPS 全量（按"先修够了再跑"办）。

### 第八十三刀：两支笔相加是**加颜色**，而颜色只印 6 位

PythagoreanTree.asy 的 `fill(pic, …, 1/(n+1)*green + n/(n+1)*brown)` 露了两处：

**一、`operator +(pen,pen)` 的颜色是"相加再夹"，不是"右边盖住左边"**（pen.h:739 那个
switch）：颜色空间取两支里大的那一档（DEFCOLOR<INVISIBLE<GRAYSCALE<RGB<CMYK<PATTERN），
灰的那一支先升上去（greytorgb / greytocmyk / rgbtocmyk），分量逐个相加，超饱和了整体缩回来
（rgbrange / cmykrange 是**按最大分量缩**，不是逐道截断）。从前这一层是"右边盖住"，于是
`1/13*green` 那一支凭空消失 —— 参考印 `0.461538 0.0769231 0`，我们印 `0.461538 0 0`。

**二、颜色只印 6 位有效数字。** psfile.cc:186 的 setcolor 先把三/四道攒进一个**新的**
`ostringstream buf`，新流的 precision 是默认的 6；而坐标、笔宽、setmiterlimit 那些是直接写
`out`，那个流在印 `%%HiResBoundingBox` 时被 `setprecision(9)` 粘住了（第五十二刀量到的那件事）。
所以同一份 EPS 里两种精度并存：`0.461538 0.0769231 0 setrgbcolor` 与 `-73.2079403 … curveto`。
渐变字典里的颜色是 psfile.cc:279 的 `write(pen)`、直接写 out，仍是 9 位 —— 这一层的 `wpen`
用 `ps`、`colorof` 用新加的 `ps6`，两条路分开。

PythagoreanTree.asy 这一下变成逐字一样。EPS 那一轴：**能出图的 76 个例子里 18 -> 19**，
全量口径 **21 份逐字一样**（194 份有参考的里）。
`tests/asy/run.js` 259 passed / 0 failed（draw/colors 那一份钉的数在两种精度下印出来一样，
所以它没能挡住这个错 —— 这一条记在明处）。

### 第八十四刀：`guide` 与 `path` 的差别是"解没解过"，以及一个又骗了我一次的缓存

roundpath.asy 的圆角全是直线。roundedpath.asy:37/49 攒路径的写法是

```asy
path RoundPath;                       // 写的是 path
RoundPath = RoundPath -- scale(S)*LocalPair;
RoundPath = RoundPath .. scale(S)*LocalPair;
```

**量出来的三份图**（同一串 knot，三种写法，真 asy 出三种结果）：

- `path r=(0,0); r=r--(10,0); r=r..(20,10); r=r--(20,30); r=r..(10,40);`
  → 两个 `..` 是 `curveto`；
- 同样五句但 `guide g` → 全是 `lineto`；
- 一句写完的 `path p=(0,0)--(10,0)..(20,10)--(20,30)..(10,40);` → 也全是 `lineto`。

道理是 asy 的 `guide` 是**还没解**的规格（一棵树）、`path` 是解好的（控制点定死）。写 path 的
变量每一句赋值都做一次 guide→path 的 cast，也就是解一次；接缝那个结的进侧于是是"已定控制点"，
下一段的出侧由它推出方向（partnerUp）。写 guide 的那份整条链一起解，`--` 是两侧 curl 断点，
夹在中间的 `..` 解出来正好是直线。第四十五刀的注里写着「量过 asy 那边'摊平成 flatguide 再一次
解完'与'每步重解'落在同一个地方」—— 那句话在这一格上是错的，现在改了。

这一层 `guide` 是 `path` 的别名（`typedef path guide;`，把它拆成两个类型要动 base 里 219 处，
第四十七刀量过不值当），所以那次 cast 落成一格函数：`asy__solid` 把 joins 全改成"照已经解出来的
控制点走"、清掉结上挂着的规格。前端在**写着 path** 的变量存值时插它（asyVardec 的初值、
asySlotAssign 与 asyAssign 的那三条落点），写着 `guide` 的记一条记号跳过（局部量记在作用域里的
`\u0000gd:名字`、文件级记在那条全局记录的 `gd` 上、形参看 `p.src === 'guide'`）。
**内建面 asy_builtins.asy 整片豁免** —— 它演的是 asy 的 C++ 层，那边两个类型本来分得开，
不豁免的话 `asy__solid` 体里那句 `path h = pathcopy(g);` 会自己调自己（量到过栈溢出）。

顺带两格：

**颜色分量进来要削**（pen.h:188/192 的 pos0 与 rgbrange）。roundpath.asy:29 那一圈
`rgb(i*0.024, 1-i*0.024, 0)`，i 过 41 之后绿分量是负的：真 asy 印一次 `1 0 0` 之后
**七圈一句颜色都不印**（削完全都一样，psfile 省掉了），我们印 `1 -0.0310078 0` 一路下去。
gray/rgb/cmyk 三个构造都补上"负的当 0、饱和度超 1 按 1/sat 整组缩"。

**又一个跑错程序的缓存**（与第七十九刀同一类）。`cli.js` 的 `srcStamp()` 注释写着"stage0/src
底下每个文件"，代码走的却是 `installDir()` —— 那是 `stage0/src/host`。于是改了 frontend-asy
底下任何一处降级器，产物缓存的键都不动：同一份探针在改完前端之后**仍然出旧图**，
`rm -rf .omni-cache/asy-js` 之后才对。往上走一级走全 `stage0/src`，键里存整条路径而不是基名。
（`tests/asy/eps.js` 自己那份 `srcStamp` 一直是对的 —— 它走 `stage0/src` 与 `stage0/lib`。）

**摇骰子的那七个不计分**：random.cc:10 用 `std::random_device` 播种 `std::mt19937_64`，
真 asy 自己两趟都不一样（量过：polardatagraph 连跑两趟，`%%BoundingBox` 从
`259 345 352 446` 变成 `256 345 355 446`）。delu / Gouraudcontour / imagehistogram /
pathintersectsurface / polardatagraph / randompath3 / floatingdisk 逐个连跑两趟真 asy 对比，
七个全不稳定 —— 这条对照本身不成立，所以 eps.js 里单列一档 `DICE`，不算失败也不算通过。

**这一刀的账**：参考里既不带 TeX 也不走光栅那一路的 28 个例子（axialshade circumcircle
colorplanes Coons dragon fermi fractaltree grid latticeshading lines PythagoreanTree quilt
rainbow roundpath shade shadestroke Sierpinski star strokepath strokeshade tensor textpath
tiling transparency triangle worldmap yingyang 与两个 silhouette），**22 份逐字一样、
结构差 0、数值差 0**；剩下 5 个是没出图（fermi 数组越界、strokepath 要绕 gs、textpath 要 TeX、
tiling 要 `postscript`、worldmap 缺数据文件），2 个超 3s。
`tests/asy/run.js` 259 passed / 0 failed；sweep 220 个里干净 219、3.9s，最慢 tvgen 303ms。

### 第八十五刀：结点下标越界要**夹住**；以及"剩下那 163 个"到底卡在哪，量清楚

fermi.asy 报 `array index out of range: 4 (length 4)`。出处是 feynman.asy:165 的
`point(p, size(p))` —— 开路径上 `size(p)` 正好是结点数，那个下标一定越界。asy 那边
path.h:44 的 `adjustedIndex` 对开路径**两头夹住**（`i < 0` 回 0、`i >= n` 回 n-1），
只有空路径才报错（`nullpath has no points`，量过错话一致）。这一层的 `asy__nwrap`
从前只处理闭合那一支、开路径原样返回，于是直接撞到数组边界。改成照抄 adjustedIndex。
fermi.asy 这一下逐字一样。

**剩下那些卡在哪（194 份参考逐个数过的账）**：

- 100 份参考里有 `/ImageType 1`（ASCII85 + Flate 的位图）—— 三维那一族默认走 asy 的
  **光栅**那条路（glrender 出一张图再嵌进 EPS）。逐字复现一张 OpenGL 渲出来的位图
  这一层做不到，这 100 个（其中 4 个同时带 TeX）先记在明处；
- 63 份带 `/TeXDict` 而不带位图 —— 那些 EPS **不是 asy 自己写的**，是 dvips 写的。
  用 `asy -k` 留下中间文件看清了整条链：asy 先把**不含标签的那张图**写成一份普通
  EPS（`名字_0.eps`，就是这一层已经会写的那种），再写一份 `名字_.tex`（固定的前言 +
  `\includegraphics{名字_0.eps}` + 每个标签一句
  `\ASYalign(x,y)(alignx,aligny){正文}`），然后
  `latex 名字_.tex` → `dvips -R -Pdownload35 -D600 -O<偏移> -T612bp,792bp -q` → 最后
  那份 EPS。判据这一轴把 `%` 开头的行全去掉，所以 dvips 头里的日期不参与比较 ——
  也就是说**这 63 个是能对上的**，前提是三样：一个"起进程"的原语（这一层还没有）、
  texfile.cc 那份 tex 的逐字复现、以及标签尺寸的度量（`\kern -100.375pt` 与
  `bb=… 10.240331` 那几个数是 TeX 量出来的，asy 另跑一趟 latex 问的）。这条是主线上
  最大的一块，单独一刀做；
- 31 份既没 TeX 也没位图 —— 这一批之后 **23 份逐字一样**。剩 8 个：tiling 要
  `postscript()`（生 PS pattern 字典，只这一个例子用 patterns.asy）、strokepath 要
  `_strokepath`（asy 自己是绕 gs 走一趟）、textpath 要 TeX、worldmap 的数据文件在
  examples 目录里而这一层的 `_readlines` 只按 CWD 找（asy 还会找**主文件所在目录**）、
  两个 silhouette 各自超 120s（真 asy 秒出，这是我们自己的性能问题，量在明处）。

`tests/asy/run.js` 259 passed / 0 failed；sweep 220 个里干净 219、2.1s，最慢
genusthree 123ms。

### 第八十六刀：`intersect` 只要**第一个**交点 —— 别把整棵细分树展开

上一刀量出来的 8 个卡口里，两个 silhouette 是**我们自己的**性能问题：真 asy 0.33s，
我们超 120s。位置在 `solids.asy:14` 的 tangent —— 它拿**相距 epsilon 的两片切片**去问
`intersect(p, q, fuzz)`。这一对是两条几乎重合的 192 段投影圆。

原来这一层写的是"把全部交点算出来，取头一个"：

```asy
real[] intersect(path p, path q, real fuzz=-1) {
  real[][] all = intersections(p, q, fuzz);   // ← 这一句就回不来了
  if (all.length == 0) return new real[];
  return all[0];
}
```

两条曲线几乎重合的时候，`asy__ixrec` 每一层的四个孩子**界盒全都相交**，谁也剪不掉：
12 层就是 $4^{12} \approx 1.7\times10^7$ 次调用，再乘上段对数。

真 asy 不卡，因为它这一路根本不求全部。`runpath.in:245` 的 `intersect` 传的是
`single=true`，`path.cc:1053` 那句是

```cpp
if(single || depth <= mindepth) return true;
```

—— 第一个交点一出来，整个递归栈立刻回去；另有 `maxcount=9`（path.cc:1050）给单对段上的
候选数封顶。照这个意思改：

- `asy__ixrec` 多一个 `int cap` 参数。`0` = 不封顶（`intersections` 那一路要全部，
  仍旧传 `0`），`>0` = 攒够 `cap` 个就层层返回（开头一句 `if (cap > 0 && out.length >= cap) return;`）；
- `intersect` 不再借道 `intersections`，自己按 `(i, j)` 扫段对（也就是 p 上时间从小到大，
  与"全求出来排序取头一个"是同一个答案），每对段上 `cap = 9`，头一个 Newton 收得住的就
  返回。

量出来的：hyperboloidsilhouette 从 >120s 到 **28.2s**，spheresilhouette 到 **20.9s**
（真 asy 仍是 0.33s —— 差 60~80 倍，这是解释器那一层的账，留在明处）。EPS 那一轴上这两个
从「超时」变成「结构不同」，头一处差别也随之能看见了：hyperboloidsilhouette 是
`%%BoundingBox` 就差 2bp（212 vs 214），spheresilhouette 是第 826 个词起分叉。**这一刀
只解开了死结，没有让它们变成一样** —— 剩下的界盒/描边差异是下一刀的事。

改的是 `intersect` 的公共行为，所以把 23 份逐字一样的重跑了一遍确认没退
（roundedpath.asy:31/43 的 roundpath 正是走这一句）：仍旧 23 份一样。

跑了：EPS 那一轴的 25 个点名（23 same + 2 silhouette，`OMNI_EPS_FRESH=1`）、
`tests/asy/run.js`（259 passed / 0 failed，两条腿）、sweep（220 里干净 219、1.6s，
最慢 genusthree 128ms）。**跳过**：EPS 全量（照约定，先大批修不对的，不跑全量）、
`OMNI_LEGS=all` 的另外三条腿。

### 第八十七刀：194 份参考里 67 份的字节是 dvips 写的 —— 方言开两个口子

先把"剩下的到底是什么"量清楚。拿 `/TeXDict`（dvips 前言的记号）在 194 份参考里筛一遍：
**67 份是 dvips 写的**，不是 asy 自己的 EPS 写手写的。这 67 份里 50 份我们已经出图
（只是"结构不同"），16 份还出不来，1 份慢。也就是说 EPS 那一轴上最大的一块就是这条管子。

再量"底图是不是已经画对了"。asy 加 `-k` 会留下中间产物：`<名>_0.eps`（**没有标签**的
底图）、`<名>_.tex`（固定前言 + `\includegraphics` + 每个标签一句 `\ASYalign`）、
`<名>_.dvi`、`<名>_.ps`。拿 equilateral 比：

```
asy 的 equilateral_0.eps    %%HiResBoundingBox: -14.589213 -5.58019925 268.875354 233.708044
                            newpath 127.274393 220.445715 moveto …
我们的 stdout               %%HiResBoundingBox: 163.767717 272.722748 447.232283 518.277252
                            gsave  164.017717 272.972748 translate
                            newpath 141.482283 245.054503 moveto …
```

两处差别，性质完全不同：

- `gsave / translate` 那一对：`_0.eps` **不摆**（dvips 用 `-O35.3677bp,151.056bp` 去摆），
  而最终那份非 TeX 的 EPS 是摆的 —— 我们那 23 份逐字一样的正是后者。这不是错。
- 坐标差一个 1.11163 倍：`141.482283 * 2 + 0.5 = 283.46 = 10cm`，也就是**我们让路径占满了
  整个 size()**，而 asy 那边路径只有 254.55 宽，剩下的 28.9bp 是**标签占掉的**。
  与 dvips 那一份的最终界一比更清楚：横向 `163.767717..447.232283` 我们**逐字一样**，
  只有纵向差着标签的高度。

结论是硬的：这一组不是"再抠一个 PostScript 算符"能过的 —— 标签的尺寸**回流进 size() 的
定标**，所以非得真去问一趟 TeX。asy 自己也是这么干的（execution 中途跑 latex 量
`\ASYbox`）。

这一刀只做管子的第一段：**方言开两个口子**，与原有的 `(readtext E)` 并列。

```
(writetext P E)   把 string 整份写成一份文本文件，回写进去的字节数（UTF-8 字节数）
(runproc CMD)     `/bin/sh -c CMD`，回退出码
```

七处真站点，与 `readtext` 一处不差地对齐：`sexpr/lower.js`（两个新头 + 类型检查）、
`interp/builtin.js`、`backend-js/{emit,prelude}.js`、`backend-c/emit.js`、
`backend-llvm/emit.js` 的 `RT_OPS`、`runtime/omni.h` + `omni_fmt.c`。

两条纪律写进了语义里：

- **子进程的两个流一律丢掉**。这一层的 stdout 就是产物本身（asy 那边是 EPS），latex 的
  絮絮叨叨混进去当场把图弄坏。要子进程的输出，就让它自己写文件、我们再 `readtext`
  读回来 —— dvips 的 `-o<文件>` 本来就是这么用的。
- **命令行是字符串，拼的人自己负责引号**。走 shell 而不是 argv 数组，是因为方言里还没有
  `string[]` 实参的 ABI，而这条路上的命令行全是我们自己拼的（latex/dvips 加一个文件名）。

C 那一侧踩到一个真坑，值得记：`system("CMD >/dev/null 2>&1")` **管不住整条命令表**。
量出来的两处 ——

- `echo LEAK; echo LEAK 1>&2 >/dev/null 2>&1`：第一个 `echo` 照样印到我们的 stdout 上
  （而且因为它不缓冲、我们缓冲，它排在最前面）；
- `printf ok > f >/dev/null 2>&1`：后一个重定向赢了，`f` 里什么都没有。

所以要套一层子 shell：`( CMD\n) >/dev/null 2>&1`。`(` 与 `)` 之间垫一个换行，是因为
CMD 末尾要是个 `#注释`，`)` 会被注掉。这条差异五条腿的对照当场就红了（run-c 与 run-llvm
印出 LEAK、丢了 ok），不是想出来的。

新增 `tests/sexpr/cases/20-writetext.sx`：字节数（`"hello 一二三"` 是 15 个字节而不是
9 个字符）、退出码原样回来、没这个程序回 127、`echo LEAK` 不许漏进 stdout、
"让子进程写文件再读回来"。五条腿逐字节一致。

跑了：`tests/sexpr/run.js`（55 passed / 0 failed，五条腿）、`tests/asy/run.js`
（259 passed / 0 failed）、sweep（220 里干净 219、1.5s）。**跳过**：EPS 那一轴
（这一刀不碰 asy 的行为，一个字节都不会变）、`OMNI_LEGS=all` 的另外三条腿。

下一刀才是真的把 `.tex` 生出来、跑 latex 问尺寸。

### 第八十八刀：标签的尺寸真去问 latex —— equilateral 的界与 dvips 那一份逐字一样了

上一刀把口子开好了，这一刀把标签接上。原来这一层是**整条丢掉**的：

```asy
void label(frame f, string s, string size, transform t, pair position, pair align, pen p) {
  f.haslabel = true;      // 只留"有没有"这一位
}
```

现在 frame 里多一格 `labelrec[] labs`，把 s / size / transform / position / align / pen
都攒下来（`labelrec` 得声明在 `frame` 前面 —— 字段的类型只能是前面声明过的记录）。

**量尺寸**：asy 是与一个活的 latex 进程对话 —— drawlabel.cc:62 `\setbox\ASYbox=\hbox{…}`，
接着 :38 那句 `\immediate\write16{>dim(\the\wd\ASYbox)dim}` 一个标签问三次（wd/ht/dp），
从管子里读回来。这一层没有双向管子，于是把**一整批**标签写成一份 .tex、跑一趟
`latex -interaction=nonstopmode`、再从 `.log` 里按次序把那些 `>dim(…pt)dim` 捞回来。
问的是同一个 TeX、同一个 `\hbox`、同一个 `\the\wd`，只是攒着一次问完。单位乘
`72/72.27`（settings.h 的 tex2ps）。`havebounds` 那一位照 drawlabel.cc:95 短路。

**折进界**：`framebox` 现在在 `opsbox` 之后再把每条标签的框加进去，那段算式是
drawlabel.cc:106-135 逐句照抄的 —— `inverse(T)*align` 归一到 0.5、减 (0.5,0.5)、
按 `(width, height+depth)` 缩、再 `T*` 回去，四个角各留
`fuzz = fontsize*0.1+0.3` 的余量（`pen::size()` 是**字号**不是线宽，pen.h:433）。

结果，equilateral：

```
dvips 那一份   %%HiResBoundingBox: 163.767717 275.855878 447.232283 515.144122
我们           %%HiResBoundingBox: 163.767717 275.855878 447.232283 515.144122
```

**逐字一样**。之前是 `272.722748 .. 518.277252`（高了 3.97bp）—— 差的正好是四个 `$A$`
占掉的地方。

踩到一个很能骗人的坑，记下来：asy 的**双引号串是照字面的**（只有 `\"` 特殊），
单引号串才过转义 —— 量过，真 asy 与我们都是 `"x\\y"` 4 个字符、`'p\nq'` 3 个。
第一版按 C 的习惯写了 `"\\documentclass"` 加 `"\n"`，生出来的 .tex **整份是一行字面量**，
`latex` 照样退出 0、`.log` 里也照样有 `>dim(` 这个记号，只是括号里是
`\\the\\wd\\ASYbox` 而不是数 —— 三个数全解析成 0。而 0 尺寸的标签框仍带着 fuzz，
界于是"往对的方向动了一点"（`272.72` -> `273.87`，目标 `275.86`）。差一点点比差很多难查。
所以那一段现在用 `nl = '\n'` 拼，反斜杠写一个就是一个。

`latex` 跑不起来（没装）就把三个数当 0 收，与 `-tex none` 那一路一个意思
（drawlabel.cc:124 直接 `b += position`）—— 至少还能出图。

代价量在明处：`tests/asy/run.js` 从 204s 到 **306s** —— 带标签的例子现在真的会
spawn 一趟 latex。

跑了：EPS 点名 24 个（23 份逐字一样的重跑**没退**，equilateral 界对上了但整份仍是
"结构不同" —— 还没生 dvips 那一段字节）、`tests/asy/run.js` 259 passed / 0 failed、
sweep（220 里干净 219、1.6s）。**跳过**：EPS 全量、`OMNI_LEGS=all` 的另外三条腿。

下一刀：生 `<名>_0.eps` 与 `<名>_.tex`、跑 latex + dvips、把出来的字节印出来。

### 第八十九刀：latex + dvips 那条管子接通 —— equilateral 与 circles 逐字节一样

三段都补齐了（picture.cc:490-612）：

- **底图** `<前缀>_0.eps`：与 shipout 那份只差两处 —— 界是 `bx` 原样（不是居中之后的，
  所以 llx 是负的），没有那对 `gsave/translate`（摆放交给 dvips 的 `-O`）。
  为此 EPS 的每一行改从 `asy__out` 出去，它按 `asy__tobuf` 决定攒进字符串还是印到
  stdout —— 83 处调用点，机械替换。
- **`<前缀>_.tex`**：前言照 texfile.h:63-120 写死（它不含随例子变的东西）。正文是
  `\textheight = h+17`、`\textwidth = w+18`、`\includegraphics[bb=…]`、
  `\kern -{w/tex2ps}pt`，再每个标签一句
  `\ASYalign((z-bx左下)/tex2ps)(texAlign){正文}`（texfile.cc:294 那两行，
  `hoffset()` 就是 `box.left`）。数全是**定点 6 位**（`fixed` + `setprecision(6)`），
  所以多了一个 `asy__f6` —— `string(x, n)` 是有效数字，两回事。
- **dvips**：`-R -Pdownload35 -D600 -O…bp,…bp -T612bp,792bp -q`。偏移不是魔数：
  代进 bboxshift（正是我们的居中平移）之后 `b.left`/`b.bottom` 全消掉，剩
  `hoffset = -128.4 + ox`、`voffset = -124.8 + 792 - (h+1) - oy`。对过 asy 自己写在
  产物里那行 `%DVIPSCommandLine`：它 `-O35.3677bp,151.056bp`，我们 35.367717 / 151.055878。
- 出来的是**整页** PS，再过一遍 asy 那个过滤（picture.cc:552-612）：换掉
  `%!PS-Adobe-` 那行、把第一处 `%%BoundingBox` 换成自己算的界、扔掉
  `%%DocumentPaperSizes:` 与 `%%BeginPaperSize:`..`%%EndPaperSize`（asy 另外把 DVIPSRC
  指到 base/nopapersize.ps 让 dvips 干脆别发，这一层不认识 base 在哪，靠过滤达到同一结果）。

**踩到的那个坑值得单独记**：dvips 把 dvi 的文件名写进产物**正文**
（`TeXDict begin 40258584 52099344 1000 600 600 (equilateral_.dvi)`），不是注释，
所以名字必须对。于是加了 `_mainname()`（主文件基名，`lower.js:2662` 的 rootModName）。
第一次量：equilateral 对上了，其余八个产物里全写着 `(equilateral_.dvi)` ——
**单元那一级的产物是按"源码没变就复用"来的**，而 `_mainname()` 是降成字面量的，
asy_builtins 那一份于是带着上一个例子的名字被下一个例子拿去用。这是"缓存跑了错的程序"
那一类的第三次（前两次是 4b3df7b 与第八十四刀的 srcStamp）。修法：印记 `cs` 里带上主文件名
（cli.js:826）。代价是单元产物不再跨例子共用，写在明处；量出来 `tests/asy/run.js`
反而从 306s 回到 252s（每个用例本来就是自己的主文件）。

结果：点名的 9 个 TeX 例子里 **equilateral 与 circles 逐字节一样**，剩下的差别第一次
全是**内容**上的，不再是名字或结构：fano 2 处数值、ring 4 处（`%%BoundingBox` 差 1bp）、
coag / venn3 长度差、hierarchy 的界差 14bp、buildcycle 与 spiral 是**字体选错**
（参考 `FontDirectory/CMR12`，我们 `CMMI12` —— `\usefont` 只在第一条标签发了，
asy 那边是"字体变了就发"，setlatexfont 的条件还没照抄）。

跑了：EPS 点名 9 个 TeX 例子（2 同）+ 23 份原本逐字一样的重跑（**没退**，仍 23）、
`tests/asy/run.js` 259 passed / 0 failed（252.4s）、sweep（220 里干净 219、1.3s）。
**跳过**：EPS 全量、`OMNI_LEGS=all` 的另外三条腿。

### 第九十刀：标签跟着 frame 走 —— UnFill 的白底、裁剪里的字、texpreamble

上一刀把管子接通了，这一刀补的是**标签在 frame 之间怎么流动**。四处都是量出来的：

- **`add` 与 `prepend` 都要搬 `labs`**。第一个现场是 buildcycle：参考的
  `%%DocumentFonts` 有 CMR12，我们只有 CMMI12，长度 2547 对 2976。顺着看下去，
  `buildcycle.asy:22` 的 `label("$f > 0$",…,UnFill)` 整条没了 —— 那个 `0` 是全篇唯一
  要 CMR12 的字。先改了 `add`，还是没有；再往下才看清 plain_filldraw.asy:243-248：
  `add(dest,src,filltype)` 的 `above` 默认是 `filltype.type != UnFill`，UnFill 那一支走的是
  **prepend**，不是 add。两个都搬上才对。
- **`transform*frame` 照 drawlabel.cc:200-204 的 transformed 搬**：`T` 与 `position` 整个
  吃下变换，`align` 只吃去掉平移的那一半再归回原长（`length(align)*unit(shiftless(t)*align)`）。
  量出来的三个尺寸原样带过去 —— 它们只由正文与笔的字号决定，asy 那边是新对象、会再问一趟
  latex，问回来是同一组数，这一趟省掉。
- **裁剪要在标签那一列里留一份影子**。真 asy 的 frame 只有**一列** drawElement，标签与
  clipbegin/clipend 混在一起；写 .tex 时按原序走一遍，裁剪那两格发的是
  `\special{ps:gsave}` + `\begin{picture}(w·ps2tex, h·ps2tex)` + 原始路径 + `eoclip`，
  配对的尾巴发 `\end{picture}` + `\kern -w·ps2tex pt` + `\special{ps:grestore}`
  （drawclipbegin.h:66-79、drawclipend.h:51-56、texfile.cc:215-241）。这一层把标签拆成了
  第二列，所以 `clip(frame,…)` 往两列都记一格（`labelrec.kind` 1/2）。三处细节量出来才对：
  - 路径坐标要按 `(-bx.l,-bx.b)` **平移**（writeshiftedpath，texfile.cc:190-193）：
    参考的 `_0.eps` 里是 `-0.75`，`.tex` 里是 `-0.500000`，差的正好是 `(0.25,0.25)`。
  - `\begin{picture}` 只在**最外一层**发（texfile.h:268 的 toplevel），嵌套的裁剪只加层数。
  - `gsave`/`grestore` 省不省照 picture.cc:301-308：两个 endclip 挨着时前面那个与它配对的头
    都不发。那个标记是 `opsbox` 走 ops 时打的，得**按序号**搬到 labs 那一列去（两列里裁剪的
    先后完全同序）。不搬的话 venn3 的 intersection123（连着两个 clip）多出一对
    gsave/grestore —— 首处结构差就停在那儿。
- **`texpreamble(s)` 从空动作改成真的存下来**，而且要进**两趟** latex（量尺寸那一趟与出图
  那一趟），插的位置是 `\let\paperwidth\paperwidthsave` 之后（texdefines）。hierarchy 的
  `\def\Ham{…}`：没有它 latex 直接未定义控制序列，texship 退回不带标签那条路，出来 212 个词
  对参考的 3095。补上之后 hierarchy **逐字节一样**。

顺手修掉两处"印到了图里"：

- `warning(...)` 从前走 `write()`，也就是 **stdout**，而 `-o -` 那一路 EPS 也从 stdout 出去 ——
  于是 `warning: cannot fit picture to xsize 200...enlarging...` 成了 EPS 的第一行
  （logdown、spline）。asy 的 `em.warning` 印到 cerr。这一层没有 stderr 的口子，
  借 `_writetext("/dev/stderr", …)`（字符设备，truncate 是空动作）。
- 例子**自己**印的东西同理。真 asy 是 `-f eps -o <名>`，图进文件、程序的 `write` 走 stdout，
  两者天然分开；我们两样都在 stdout 上。这一处不对等在 eps.js 里补：第一行 `%!PS-Adobe`
  之前的全扔掉，之后一个字不动（xstitch 的 `histogram:`、lmfit1 的 `P_0 = `）。

**上一刀有一处写错了，这里改正**：`\textheight` 是 `h+18`，不是 `h+17`
（texfile.cc:106 的 `height+18.0`，`height = box.top-box.bottom`）。当时它没被抓住是因为
612×792 的纸上差 1bp 的页高不挪动任何东西 —— 一个不影响结果的错值最难发现。
对着 equilateral 的参考 `.tex` 量：`bb` 的高 239.288243 + 18 = 257.288243，逐字对上。
同一处还有一个格式的坑：`.tex` 里那句 `\special{ps:… setgray}` 的颜色是**定点 6 位**，
不是 `%g` 的 6 位有效数字（texfile 那个流构造时就按 fixed/precision(6) 粘住了，坐标与
对齐量同一个流）—— 黑笔参考写 `0.000000 setgray`，走 psfile 那条路写成 `0 setgray`。

量到了、这一刀**没修**的：

- `.tex` 里有一处末位差：`20.225563` 对参考 `20.225562`。我们算 `x / (72/72.27)`，
  asy 算 `x * (72.27/72)`，末几位不同。差不到 1e-6 pt，在 dvips 的 1/600 in 之下。
- **`setdash` 一直没发过**（asy_builtins.asy:376 早就写在明处）。limit、polararea、sacone、
  sacylinder、xstitch 五份的首处差全是参考 `[…] 0 setdash` 对我们 `stroke`。下一刀就是它。
- `\usefont` 仍然只在第一条标签发。asy 那边是 settexfont（texfile.h:216-224）：
  **字体串变了就发**。只有笔上带显式 `font(...)` 的例子才会碰到。

结果：**逐字节一样的从 25 份到 31 份**（新增 buildcycle、venn3、hierarchy，加上点名之外
本来就对上的 Pythagoras、labelbox、lever）。dvips 写的那 67 份里现在 8 份逐字一样，
剩下的差别按第一处归类：界差 1bp 的一批（cardioid / fjortoft / log / polarcircle /
cosaddition / ring）、缺 setdash 的一批（上面五份）、graph 那一路还缺东西的一批
（spline / lmfit1 / logdown 的界小一大截）。

跑了：EPS 点名 31 份（**全部逐字一样**，无退化）+ dvips 写的那 67 份整组过了一遍、
`tests/asy/run.js` 259 passed / 0 failed（300.7s）、sweep（220 里干净 219、2.7s，
最慢 AiryDisk.asy 175ms）、`tests/sexpr/run.js` 55 passed / 0 failed。
**跳过**：EPS 全量（220）、`OMNI_LEGS=all` 的另外三条腿。

### 第九十一刀：虚线真的发出去了 —— setdash 与按弧长收节拍

`asy_builtins.asy:376` 那条"存着但没发"的注在这儿结掉。

- **发什么**：pattern 或 offset 变了就发一句 `[a b …] offset setdash`（psfile.cc:266-274）。
  数是**定点 9 位** —— 那三行把流临时切成 `fixed`，而流的 precision 早先被
  `%%HiResBoundingBox` 那一处按 9 粘住了（与 TeX 那一侧的定点 6 位不是一回事）。
- **第一支笔那一格与别的几项不一样**。颜色/宽/cap/join/miter 第一次一定发，因为
  psfile 的 initialpen 那几项是不可能的值（-2、-1、INVISIBLE）；而它的 LineType 是
  `LineType(array(0), 0.0, …)`（pen.h:411）—— 空 pattern、offset 0，与实线一模一样，
  所以**第一条实线不发 setdash**。量出来的：sacylinder 的参考里第一句 setdash 在第 1057 行，
  前面那些实线的描边一句都没有。
- 空 pattern 那一句 `[] 0.000000000 setdash` 反过来**不能省**：前一支笔留下的花样
  会一直粘着后面所有的描边。
- **描边前先按弧长收节拍**（drawpath.cc:198-201 的 adjustdash）。`adjust(pen,real,bool)`
  与 `asy__patlen` 早就照抄好了，一直没人调用 —— 因为名字解析是顺着来的：`emitop` 在前，
  `arclength(path)` 与 `adjust` 都在后。修法是留两个函数变量当桩（`asy__arclenfn` /
  `asy__dashadjfn`），等真货定义好再接上（搜 `asy__dashhook`）。这一层的函数就是变量、
  可以重新赋值，量过一份最小样例确认。
- 弧长按**均匀缩放线性**处理：`arclength(scale(s)*g) == s*arclength(g)`，所以桩只量原坐标
  那一份，emitop 再乘 `s`。与那边差一处：asy 量的是 `p.transformed(inverse(笔的变换))`，
  这一层的笔基本没有自己的变换。

最小对照（`draw(dashed)` + `draw()` + `draw(dotted)` 三条）出来的 EPS 与真 asy
**逐字一样**，包括 `[3.980000000 3.980000000]`（8 × 0.5 再按弧长收）与 dotted 的
`[0.000000000 1.989502624]`。

结果：sacone、sacylinder、xstitch 三份从"结构不同"变成**逐字一样**（31 → 34）；
limit 与 polararea 从结构不同降到只剩数值差。

**顺手量清了"界差 1bp"那一批的根，但没修**：cardioid / fjortoft / log / polarcircle /
cosaddition / ring 的 `%%HiResBoundingBox` 与参考一字不差，差的只有取整那一行。
最小复现（ring 剥到只剩必要的）：`size(0,100)` 的图里放一条 label 之后，
`currentpicture.calculateTransform().xx` 我们是 `25 + 3.55e-15`（正好一个 ulp），
参考是**正好 25**，于是 `floor(-50-ε)` 给 -51 而不是 -50。那个缩放是
plain_scaling.asy:202 加 simplex2.asy 解出来的 —— **两边跑的是同一份 asy 源码**，
所以差别在下面某个原语（`real[]` 的 `*` / `+=`，或者 `maxcoords` 排完之后行的先后
决定了主元序列）。这一刀只量到这儿。

跑了：EPS 点名 34 份（**全部逐字一样**，无退化）+ setdash 与 1bp 那两组 14 份、
`tests/asy/run.js` 259 passed / 0 failed（288.7s）、sweep（220 里干净 219、1.9s）、
`tests/sexpr/run.js` 55 passed / 0 failed。
**跳过**：EPS 全量（220）、`OMNI_LEGS=all` 的另外三条腿。

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
- clang `-O0`：编 3.5s，跑 2.39s；但**自举过不去** —— 这么编出来的 N1 一跑
  `emit-c cli.js` 就 SIGSEGV（深递归的降级 + `-O0` 的大栈帧，撞 8MB 主线程栈）。
  所以 `tests/bootstrap` 自己把 `OMNI_OPT` 钉在 2；`cli.js` 的默认是 `-O0`（迭代速度）。
  真正的修法是给那个进程要一条更大的栈，那是另一刀。
- tcc（本地快照 0.9.28rc，现编）：编 **0.41s**，跑 4.97s；
  端到端全量自构建 1.80s 冷 / 0.99s 热；`emit-c` 与 C0 逐字节相同

`-O2` 的 pass 分布（`-ftime-report`，平的，无病态热点）：AArch64 指令选择 21.7%、
InstCombine 8.8%、Inliner 6.3%、Greedy 寄存器分配 5.4%、SROA 4.2%、DSE 3.5%；
前端（parse + sema + IRGen）2.5s。

本机 LLVM：22.1.8，`libLLVM.dylib` 157MB，提供 `libLLVM-C.dylib`。
