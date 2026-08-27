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
