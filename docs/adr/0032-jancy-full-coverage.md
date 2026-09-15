# ADR-0032：没有"不收"这回事 —— jancy 每一族特性在**单线程 + 有 GC 的宿主**上的合理化落法

## 原则（先改口径，再谈细节）

**"这一层不做某个特性"不是一个结论，是一句借口。** 一门语言的前端只有两种正当的收场：

1. **降下来** —— 按一份**说清楚的观测模型**给出合理化的语义；
2. **报一句源码的错** —— 而且是 **jancy 自己也报的那一句**（`bad` 那本账）。

"还没接"（`acct`）只是**记账的中间态**：它说的是"今天还没写到"，不是"设计上不要"。
每一条 `acct` 都必须在这份文档里有一行**落法**与一个**判据的位置**；写不出落法的那一条，
说明我们还没读懂 jancy 的源码，那就去读，而不是把它记成"边界"。

先前那批"明说不收"的话（`destruct`、`threadlocal`、`weak`、`disposable`、`async`…）
是把**宿主的欠缺**说成了**语言的边界**。真实情况是：这些特性编到 JS / arena 那几条腿上时，
**语义要按宿主的模型合理化**，而不是消失。这份文档就是那张"合理化对照表"。

## 观测模型（一次说清，往下每一条都引它）

- **只有一个线程。** 四条腿没有一条能开线程（`run` 是 arena 解释、`run-c` / `run-llvm` 是
  单线程原生、`run-jit` 是 ORC JIT 单线程）。所以"每个线程各有一份"就是"一份"，
  "并发"就是"交错的回调"。
- **对象的寿命由宿主管。** JS 那条腿上就是 JS 的 GC；`run` 那条腿上是 arena（整段一起释放）；
  原生那两条是我们自己的分配器。**没有"引用计数归零那一刻"** —— 所以 jancy 里那些
  "GC 在不确定的时刻调"的东西（`destruct`），在这一层要给一个**确定的时刻**，
  而那个时刻必须比 jancy 的**更早或相同**（早调不会让程序看见没释放的资源，晚调会）。
- **没有"模块卸载"。** 程序跑完就整个没了。所以 `destruct`（模块级的那一格）落在**程序结束前**。
- **一次编译一份模块。** 跨文件是 `import` 并进来的同一份（第六十刀），不是链接期的事。

这三条一旦写下来，"合理化"就不是随口说的：**同一个程序在 jancy 上与在这一层上，
凡是这三条能观测到的差别，都要在这份文档里点名**。

## 一、寿命那一族（destruct / disposable / nestedscope）

**jancy 的原话**：`destruct` 是"the destructor is called by the garbage collector at an
unspecified moment"（`doc/language/rst/disposable.rst:17`）；`disposable` 是一格**存储类**
（`DeclarationSpecifier.llk:117`），只能写在局部量上、那格类型自己得有 `dispose`
（`isDisposableType`，`jnc_ct_Type.cpp:844-850`），见到它就给这一格开一个
`ScopeFlag_Disposable | ScopeFlag_FinallyAhead | ScopeFlag_Finalizable` 的作用域，
**出去的时候**（正常走出去与抛出去都算）调 `dispose`（`jnc_ct_Parser.cpp:2050-2068`）；
`nestedscope:` 是"把后面那一段变成一格嵌套的可弃作用域"。

**合理化**：`unspecified moment` 是 jancy 给 GC 留的自由，**不是"可以不调"**。
这一层给它一个确定的时刻，而且比 jancy 早：

- **局部对象**（`C c;` / `disposable R r(1);`）：**出这一格作用域时调** —— 正常走出去、
  `break` / `continue` / `return` 跳出去、以及往上传错跳出去，四条出口都要调。
  这就是 jancy 的 `disposable` 那一套钩子；`destruct` 与它**共用同一套**，差别只是
  调的是 `destruct` 还是 `dispose`。
- **`new` 出来的对象**：这一层不知道谁最后放手，**所以落在"程序结束前"** —— 一张
  "造出来还没销的对象"清单（造对象那一处 `apush`），`main` 的尾巴上倒着走一遍调 `destruct`。
  这比 jancy 的 GC **晚**，可它是**确定的**，而且"晚"这一头在单进程程序里观测不到差别
  （进程结束时资源本来也要还）。清单要**倒序**：后造的先销（与 C++ / jancy 的次序一致）。
- **模块级 / 静态那几格对象**：同上，排在那张清单的最前头（所以最后销）。
- **`nestedscope:`**：就是"这一段是一格作用域"，出口那一套钩子与上面同一份。

**落法**：一份"作用域出口"的公共机制（这是这一族的**前置**）：每一格作用域记下
"出去时要跑哪几句"，`break` / `continue` / `return` / 往上传错四处各插一遍。
`try` / `catch` / `finally` 那一族用的也是它 —— 所以这一件事做完，`finally` 跟着就有了。

**判据**：`cases/` 里一格 `destruct` 的次序判据（两格局部对象 + 一格 `new` 出来的，
印出来的顺序钉住"后造先销"）；`disposable` 一格（正常出口 + `return` 出口两条）；
`nestedscope` 一格。

## 二、`threadlocal`（已落，第二百五十八刀）

**jancy 的原话**：`decl_storage.rst:15` —— "each thread in program has its own copy"，
外加两条限制（不许有初值、不许是聚合体）。

**合理化**：只有一个线程 ⇒ "每个线程一份"就是"一份"，与 `static` 落地是同一件事
（`src/lang/jnc/types.js` 的 `STATIC_WORDS`）。那两条限制照 jancy 报**源码的错**。

**还差的一格**：`threadlocal once`（`cflow_once.rst:41-46`，每个线程跑一遍）——
单线程下它就是普通 `once`，落法与 `once` 同一份。

## 三、`weak` 指针（有 GC 的宿主上是可表达的）

**jancy 的原话**：`weak` 换的是**指针的种类** —— 类指针 `ClassPtrKind_Weak`、函数指针
`FunctionPtrKind_Weak`、属性指针 `PropertyPtrKind_Weak`（`jnc_ct_DeclTypeCalc.cpp:667/676/688`）；
弱指针不算一条引用，GC 收了对象之后它自己变 null（`samples/jnc/05_WeakClassPtr.jnc`）。

**合理化**：这一层的对象**不会在程序跑着的时候被收**（arena 整段释放、JS 那条腿上我们
还持着强引用），所以"弱指针变 null"这件事**在这一层观测不到** —— 于是 `weak` 落成
**一格普通指针**是**正确的**（不是"收下不看"）：程序里 `wc == null` 为假，与 jancy 在
"对象还活着"时的答案一模一样。差别只在 jancy 跑过一轮 GC 之后，而这一层没有那一刻。

**这一条必须写进文档而不是记成账**：`05_WeakClassPtr.jnc` 那种"故意等 GC 收掉再看"的
样例，在这一层印出来的数与 jancy 不同 —— 那是**观测模型的差别**（上面第二条），
不是错。判据里把这句话钉住：一格 `weak` 指针，对象活着时与强指针**一模一样**。

## 四、`async` / `await` / `std.Promise` / `jnc.Scheduler`（单线程 = 一格事件队列）

**jancy 的原话**：`async` 是一格类型修饰符（`TypeModifier_Async` →
`FunctionTypeFlag_Async`，`jnc_ct_DeclTypeCalc.cpp:519-520`），它**换掉返回类型**：
写出来的那个挪去 `m_asyncReturnType`，函数真正回一格 `std.Promise*`
（`jnc_ct_TypeMgr.cpp:664-672`）；体那一半拆成一台能在 `await` 处停下、被 resume
之后接着跑的状态机；派谁去 resume 是 `jnc.Scheduler`（`jnc_Scheduler.jnc`）。

**合理化**：单线程 ⇒ 这一整套就是 **JS 的 `async`/`await` 那个模型**：
一格微任务队列 + 每个 `async` 函数一台状态机。三件事分开做：

1. **`std.Promise` 那一格对象**：这一层自己合成一格（`$state` / `$value` /
   `$onCompleted` 那格多播），`.wait(f)` 是往多播上加一格听众、`.complete(v)` 是
   置值 + 通知一遍。多播那一套第七十三刀就有了，所以这一格只是"照 jancy 的接口拼名字"。
2. **`await` 那一刀 = 把体切成几段**：`await p;` 之后的那一段落成一格**续延函数**
   （`$k<N>`，形参是"这台状态机那一格"），`await` 那一句落成
   `p.wait(那格续延的闭包壳)`。闭包壳与反应器那一族（第二百五十六刀）用的是同一份
   `(cfn … (cap …))`。状态机那一格的"局部量"要提到那格对象上（跨段活着的那几个）——
   这一步与"取过地址就提到堆上"是同一条（第九刀）。
3. **调度**：`jnc.Scheduler` 落成一格**队列 + 一格泵**。泵在哪儿跑？`main` 的尾巴上
   （程序把队列跑干再退出，与 node 的事件循环一致）。所以 `main` 的结构变成
   "序幕 → 体 → 把队列跑干"，`destruct` 那张清单排在最后（上面第一条）。

**次序**：这一族要排在"作用域出口"（第一条）与"闭包壳"（已有）之后 —— 而它自己是
**标准库能不能整份降下来的关键**（`io_*.jnc` 那一批全是 `async`）。

**判据**：一格 `async` 函数 + `await` 两段（印出来的次序钉住"await 之后那一段是回调"）；
一格 `std.Promise` 手写的 `wait` / `complete`；一格 `Scheduler` 上排两件事的次序。

## 五、抛出去那一族（dynamic throw / try / catch / finally）

**jancy 的原话**：不写 `try` 调 `errorcode`、而当前函数自己不是 `errorcode`、外面也没有
`try` —— jancy 走**运行期的 dynamic throw**（`jnc_ct_ControlFlowMgr_Eh.cpp:108-111`
那一格 ASSERT 说的是"抛出去那一跳没有去处"）。

**合理化**：这一层的"抛"落成**一格模块级的错误槽 + 一次早退**（`errorcode` 那一族
第五十八刀已经是这么落的）。`dynamic throw` 就是同一件事的**没有静态去处**那一种：
往错误槽里写、然后**一路早退到最近的一格 `try`**；一格都没有就退到 `main` 的尾巴
（印一句 + 非零退出码，与 `assert` 落到同一格 `(fail …)`）。

**`finally`** 就是第一条那套"作用域出口"的另一个用户 —— 做完那一格，`finally` 是顺带的。

**判据**：一格 `throw` 穿过两层函数被最外面的 `try` 接住；一格 `throw` 一个 `try` 都没有
（退出码 + 那句话）；一格 `finally` 在三条出口上都跑。

## 六、正则那一族（`case "…"` / `r"\d+"` / `switch` 的正则分支）

**jancy 的原话**：`samples/jnc/70_RegexSwitch.jnc` 的 `case "foo+"` / `case r"\d+"` ——
jancy 自己带一格正则引擎（仓库里那棵 `re2s/`），`switch` 的每一格 `case` 是一条模式，
编译期编成一台 DFA，运行期喂字符。

**合理化**：这一层**同样编译期编 DFA** —— 那是纯粹的编译期工作（读模式、造状态表），
与宿主一点关系都没有。落法：每一格 `switch` 一张状态表（一格模块级的
`(blk int N)`），运行期一格 `while` 喂字符、按状态表走，落到哪一格 `case` 就跳哪儿。
`re2s` 那棵树是**读法的出处**（模式语法收哪几样），DFA 那一段是我们自己写的
（`src/lang/common/` 下一格新零件 —— 别的语言的 lexer 也用得上）。

**判据**：一格三条模式的 `switch`（含 `r"…"` 与普通串），喂几个输入把每一条都打中一次。

## 七、字节与布局那一族（整数带宽度是这一族的前置）

**jancy 的原话**：`sizeof` / `countof` 是编译期常量；`dynamic sizeof` / `dynamic offsetof` /
`dylayout (layout) { … }` 是**动态布局**那一整套（块里的字段按运行期读到的字节一格一格摆，
读的是 `jnc.DynamicLayout` 上那格 validator）；`void*` 是没有元素类型的数据指针；
串字面量与 `0x"…"` 都是**一段字节**（第二百六十二 / 二百六十四刀已按"一格一格"落了）。

**合理化 —— 但这一族有一个真前置**：方言的 `int` 今天**没有宽度**
（`src/core/hir/types.js:4` 就一行 `export const INT = { k: 'int' }`），于是
`char[4]` 落成四格 64 位的槽。这不影响"逐格抄"那几件事（判据都对得上），可它让
**`sizeof` 说不出真数**、`(uint8_t*)p` 说不出"按字节走"。所以次序是死的：

1. **先给方言的整数上宽度**（ADR-0031 §8.1 那一程：`int` 长出 `w` / `u`，
   `(pload …)` / `(pstore …)` 按宽度读写，四条腿各自的读写那一处照宽度发）；
2. `sizeof` / `offsetof` 跟着就是**按布局算出来的编译期常量**；
3. `void*` / `uint8_t*` 那一族才真成"按字节看"（今天是"按格看"，差别记在
   `cases/201-ptrcast.jnc` 的注释里）；
4. `dylayout` 那一套是"运行期读字节 + 按读到的数摆字段" —— 它要的是 3 那一格，
   本身只是一格循环 + 一张偏移表。

**这一族里**唯一**真·不该落成"跑得动"的东西是 `%p`**（印裸地址）：四条腿上指针是两套
实现（arena 的块内偏移 vs 真地址），同一格指针印出来不是同一个数。可就算这一格也不是
"不收" —— 它是**一句源码的错**（`bad/printf-conv-p.jnc` 那条话要改成"这一层刻意不给可观测
的裸地址，能观测的是 `p == null` / `*p` / `p[i]` / `p - q`"，那是**设计决策**，写在
ADR-0016 决策一里，不是"还没接"）。

## 八、宿主面那一族（`opaque class` / `import … with "h"` / `.jncx`）

**jancy 的原话**：`opaque class` 的对象由宿主分配、方法的体在宿主的 C/C++ 里
（`opaque.rst:15-29`，登记走 `JNC_BEGIN_CLASS` 那一串，`abi.rst:60-70`）；
非 opaque 的类拿 opaque 的当基类挡住继承的是 `OpaqueNonCreatable`（`ClassType.cpp:318-320`）；
`.jncx` 是**编译好的扩展库**（一个 zip：`.jnc` 声明 + 动态库）。

**合理化**：这一族**旧降级已经落好了**（ADR-0022 的 J4b / J4d：方法降成
`(ccall Owner_method self …)`、`import "libfoo.dylib" with "foo.h"` 从 C 头文件收声明）。
所以这里没有"要不要"的问题，只有"**搬**"的问题 —— 规则那条路上照旧发同一份 `(cabi …)`。
`.jncx` 那一格是"解一个 zip、把里头的 `.jnc` 当 import、把动态库交给 `(lib …)`"，
`import "…" with` 那一半的机制已经在了。

**这是今天欠着的债**（ADR-0031 §8 记着）：`tests/llvm` 上两处 `.jnc` 还钉着 `JNC_RULES=0`。

## 九、属性那一族剩下的几格

**jancy 的原话**：带下标的属性（`prop_indexed.rst:15`：`int property g_slot(int i);`
声明的那一串是下标，不是形参）、静态属性、**属性指针**（`int property* p` —— 那一格里
存的是"取/存两个函数 + 那个对象"）。

**合理化**：三格都是**表的事**，不是宿主的事：
- 带下标的属性：读 `p[i]` 是 `(call g_slot$get i)`、写是 `(call g_slot$set i v)` ——
  取/存那两个函数的形参表最前面多那一串（成员那一格前面还有 `this`）。**当表达式用**
  （`bad/mod-indexed.jnc`）也是同一条，只是那一格值要落成临时。
- 静态属性：与静态字段同一条（没有 `this`）。
- 属性指针：落成**一格两字的结构体**（取的函数值 + 存的函数值 + 那个对象 = 三个字，
  与多播那一格 `(arr (fnty …))` 同一类）；调它就是取那一格再 `(callind …)`。

## 十、模块的 `construct` / `destruct`

**jancy 的原话**：顶层直接写 `construct() { … }` / `destruct() { … }`
（`samples/jnc/86_ModuleConstructors.jnc`）—— 装载时 / 卸载时各跑一遍。

**合理化**：`construct` 落成一格普通函数，在模块那段序幕的**最后**叫一次（模块级那几格量
的初值先就位，再跑它的体 —— 与 jancy 的次序同）；`destruct` 落在**程序结束前**
（`main` 的尾巴上，排在第一条那张"待销对象"清单之后）。**都不是"不收"**。

## 做的次序（谁解锁谁）

一条链，前面那格是后面那格的前置：

1. **作用域出口那一套钩子**（正常出去 / `break` / `continue` / `return` / 往上传错）——
   解锁：`destruct`、`disposable`、`nestedscope`、`finally`。
2. **待销清单 + `main` 的尾巴**（销毁的次序、模块 `destruct`、事件队列的泵都挂在这儿）。
3. **续延与状态机**（`await` 切段 + 闭包壳已有）—— 解锁：`async` / `Promise` / `Scheduler`，
   也就是**标准库那一整批 `io_*.jnc`**。
4. **方言的整数带宽度**（ADR-0031 §8.1）—— 解锁：`sizeof` / `offsetof`、真字节视图、
   `dylayout`、`bytes` 那一族。
5. **正则那台 DFA**（纯编译期）—— 解锁：`switch` 的正则分支；顺带给别的语言的 lexer 用。
6. **宿主面搬家**（旧降级已有的那份 `(cabi …)` / `(ccall …)` 搬到规则那条路）——
   解锁：`opaque class`、`import … with`、`.jncx`，也就是 `tests/llvm` 上那两笔债。
7. **属性那三格**（带下标 / 静态 / 属性指针）—— 与上面几条无关，随时可以插进去。

## 尺子跟着换口径

- **`bad/` 里的每一行都要重新归类**：只有两种合法的行 —— **jancy 自己也报的那一句错**、
  以及**设计决策**（`%p` 那一格：不许观测裸地址，出处 ADR-0016 决策一）。
  凡是"这一层没有 X 所以不收"的话，都要按这份文档改成落法，然后从 `bad/` 升进 `cases/`。
- **`bad/xfail.txt` 的意思也变了**：它现在是"**旧降级画的墙里，按这份文档该重画成特性的**"
  那一份清单 —— 每消一行，`cases/` 里多一格判据。
- **真语料那把尺子**（`tests/lib/jnc-rules-sweep.js --jancy`）是唯一的进度表：
  今天 662 份里降得下来 153（23.1%）。上面那七步做完，剩下的账应该只有
  "跨文件/宿主面"那一类（那要 `--libs` 那一档，也就是标准库整份降下来）。

## 这份文档自己的验收

每落一格，回来做三件事：把上面那一节的"落法"改成"已落 + 判据在哪儿"、把 `bad/` 里对应的
行升进 `cases/`、把真语料那个数更新。**这份文档不许出现"不收"两个字**——
它只该有"已落"、"这一步的前置是谁"、以及"jancy 自己报的那句错"。




