# ADR-0013：执行引擎分层（解释器 / 字节码 / JIT）与 C-FFI 契约

状态：已接受（阶段 1 落地中）
日期：2026-08-26
相关：ADR-0001（自举）、ADR-0006（值与容器）、ADR-0007（错误模型与 ARC）、ADR-0010（函数值）、ADR-0011（JS 降级）

## 背景

在这条 ADR 之前，"执行"只有两条路：

- node 宿主：生成 JS，`new Function` 在本进程里跑掉。**借的是 node 的引擎。**
- 原生构建：生成 C，`cc` 编一遍再执行。**借的是 clang。**

两条都不是自己的执行器。后果具体而致命：产物里的编译器要执行一段代码就必须带一个 C 编译器；
REPL 只能活在 node 宿主上；"直接解析执行"这条架构主线（ADR-0001 第 1 节）一直是空的。

所以要自己写解释器。约束由使用方给定，不是可选项：

1. **C-FFI 必须是直调**。参照 Python 的 ctypes/cffi：值就是 C 的值，调用就是 C 的调用。
   不接受 V8 那一套（handle scope / 局部句柄 / 移动式 GC / write barrier）—— 那些让每一次
   跨界调用都要过一层登记与转换，FFI 密集的程序会被这层吃掉。
2. **将来上 JIT，这条契约不变**。JIT 生成的原生代码必须能直接调同一批运行时函数，
   不需要 trampoline 去搬值。
3. **分阶段**。不追求一次做完 ES 标准；多出来的特性按阶段排。

## 决策 1：解释 OIR，不解释 JS AST

解释器的输入是 **OIR**（`hir/` 产出的那个模块），不是 JS 的语法树。

理由：

- 两个语法前端（Omni、JS）都已经降级到 OIR。解释 OIR 一次，两种语法都能解释；
  解释 JS AST 只覆盖 JS，而且要把 `lower.js` 里那套语义（truthiness、`+` 的双重含义、
  int64 用 BigInt 表示、成员派发表）重写第二遍 —— 两份实现必然分叉。
- OIR 已经被三条测试轴按逐字节口径卡住（`tests/oir` 451 例、`tests/js-roundtrip` 44 例、
  `tests/js-exec` 11 例）。解释器接在同一个位置，就能进同一套门槛：
  **`node == omni-js == omni-c == omni-interp` 四方逐字节相同。**
- 未来的字节码与 JIT 也从 OIR 起步，三级执行器共享同一个前端与同一份语义。

代价：OIR 是"已经降级过"的形态，所以解释器看不到源码级结构（比如 `for...of` 已经成了
`ForIn`）。诊断信息因此仍然来自编译期，不是运行期回溯 —— 这一条在阶段 2 用行号表补。

## 决策 2：解释器写在编译器自己的源码里

`src/core/interp/` 是普通的 JS 源码，和编译器其余部分一样，会被 JS 前端降级、被 C 后端
编译。于是：

- **node 宿主上**它是 JS，直接跑。
- **原生构建里**它是 C：解释器随编译器一起被编出来，产物里自带执行器，不需要 node，
  也不需要 cc。
- 只有一份实现，不会有"C 侧的解释器与 JS 侧的解释器不一致"这种分叉点。

这条也是不嵌第三方引擎的理由。mujs 是 ES5：没有 BigInt（我们的 int64 就是 BigInt 表示的）、
没有箭头函数 / `class` / `const`。quickjs 够完整，但那意味着**第二套值表示**与第二套
GC 语义，跨界就要搬值，正好违反约束 1。两者都读了、都值得借鉴形状，但实现自己写。

## 决策 3：C-FFI 契约（这条是硬约定，三级执行器共用）

| 项 | 约定 |
| --- | --- |
| 值 | `omni_dyn`：`{ int tag; union { bool; int64_t; double; omni_str; omni_s16; void *ref; } }`，16 字节，**按值传参与返回** |
| 载荷 | 指针指向 arena 里的对象；**永不移动**，C 侧可以长期持有 |
| 函数值 | 闭包记录指针（ADR-0010）：第一字段是函数指针，后面是按值捕获的变量；记录自己当 `self` 传进去 |
| JS 函数签名 | 只有一个：`omni_dyn (*)(omni_fn self, omni_list args)` |
| 跨界成本 | 无 handle scope、无 root 注册、无 write barrier、无移动 —— 调用就是一次 C 调用 |

推论（也是这条 ADR 最重要的一句）：**解释器造出来的函数值，与 AOT 编出来的函数值，在 C
侧不可区分。** 解释器把一个 OIR 函数包成本语言的一个 lambda，降级后它就是一条普通的闭包
记录：编译好的代码调它、C 代码调它、将来 JIT 出来的代码调它，走的都是同一条 `fp(self, args)`。
反方向同理：解释器调 `omni_js_*` 就是一次普通 C 调用（阶段 1 经过一次 `switch`，阶段 2
换成 op 索引跳表）。

内存：目前是 arena（只涨不落，ADR-0007）。长跑的解释器与 REPL 要靠 ARC 收尾，那是引用计数
而**不是**移动式收集器，所以上面那张表在 ARC 落地后逐条仍然成立；C 侧要长期持有时 retain
一次即可。这正是当初选 ARC 而不是 tracing GC 的理由之一（ADR-0007 决定 3）。

## 决策 4：三个阶段，各有验收门槛

### 阶段 1：OIR 树遍历解释器

- 形态：`src/core/interp/` 直接走 OIR 的节点。环境是"名字 -> 值"的表，函数值是本语言的
  lambda（于是自动满足决策 3 的推论）。
- 入口：`omni run --interp f`、`omni interp f`；原生构建上的 `run` 在门槛过了之后改成默认
  走解释器，`--via-c` 是逃生口。
- 门槛（已落地）：`tests/run.js` 的可执行用例轴上多一条腿 `[js==interp]`，25 个用例
  `node == omni-js == omni-interp` 逐字节相同（stdout、stderr、退出码）；
  `tests/bootstrap` 阶段 7 把原生构建也钉住：`N1 interp == C0 run`。
- 门槛（已落地）：`tests/js-exec` 这条轴也多了第三条腿，11 个真 JS 程序
  `node == omni-js == omni-c == interp` 逐字节相同，原生构建上手工复核过同样的 11 个。
  接法见决策 5 的第二半：一条通用 op `js_call_op(name, args)`，两个后端各自按表**生成**
  那个 205 路的分派函数，所以加 op 自动进解释器，没有手抄 205 份包装的余地。
- 不做：运行期回溯、字节码、优化、`generator` / `async` / `Proxy` / getter-setter /
  完整原型链。这些在阶段 1 里由**编译期**报"尚未支持"，不是悄悄给个错答案。

### 阶段 2：OIR -> 线性字节码（寄存器机）

- 形态：一趟把 OIR 摊成定长指令 + 槽位数组（槽位就是 `omni_dyn`，没有装箱）。
  `switch` 派发；C 后端在支持的编译器上换成计算 goto（`&&label` 是 GNU 扩展，clang/gcc 有，
  tcc 没有 —— 所以是编译期二选一，不是运行期）。
- 顺带解决的事：REPL 可以在原生构建上跑（一行一条编译单元，不再 `cc` 一次）；行号表进指令流，
  运行期回溯有了；ARC 的插入点在这一层是明确的（槽位生命周期就是活跃区间）。
- 门槛：阶段 1 的四方比对全部保持，且字节码执行器与树遍历执行器逐字节一致（第五方）。

### 阶段 3：baseline JIT

- 形态：拿阶段 2 的字节码，按 op 直接吐机器码（模板式，不做 SSA 优化）；调用运行时仍然是
  普通 C 调用，因为决策 3 保证了值表示不需要转换。
- 门槛：与解释器逐字节一致；`bench/` 里给出与 C 后端的差距。
- 不做：类型反馈、内联缓存、去优化。要做也在这之后，并且不允许破坏决策 3。

## 决策 5：语义只有一份 —— 解释器不重写宿主已有的东西

解释器是第三个执行器，但**不应该**成为第三份语义。凡是两代产物里已经各有一份实现的东西
（prelude 的 `$fmt_real`/`$repr_real`、runtime 的 `omni_str_real`/`omni_repr_real`），
解释器一律收成一条宿主 op，在哪个宿主上就用那个宿主的那一份：

| 事 | node 宿主 | 编译出来的产物 |
| --- | --- | --- |
| `js_fmt_real`（print 的 `%.6g`） | `host/native.js` 的 `fmtReal` | `omni_js_fmt_real` -> `omni_str_real` |
| `js_repr_real`（repr 的 15/16/17 位往返） | `host/native.js` 的 `reprReal` | `omni_js_repr_real` -> `omni_repr_real` |
| `js_type_tag`（dynamic 的标签名） | `typeTag` | `omni_js_type_tag` |
| `js_call_op(name, args)`（按名字调任意一条 op） | 直接跑 `JS_PRELUDE` 那一份 | 后端**生成**的 205 路分派器 |
| `js_wrap_fn` / `js_call_fn`（函数值的造与调） | `wrapFn` / `callFnValue` | 转接记录 / `omni_js_call` |

这样"解释执行与编译执行打印出同一串字符"是**构造性的**，而不是三份浮点格式化代码碰巧
一致。降级后的 JS 用的宿主库那 139 个 `js_*` op 也是这么接的：不在解释器里重写一遍 JS 的
语义，而是**一条通用 op** `js_call_op(name, args)`，两个后端各自按 `JS_ALL` 表生成那个
205 路的分派函数（和生成成员分派器 `omni_js_m_*` 完全一样的做法）。要单独处理的只有三处：

- pending 标志（`js_throw` / `js_pending` / `js_take_pending` / `js_check_uncaught`）必须落在
  解释器自己的槽上，不是宿主的全局标志 —— 不然解释器和它跑的程序共用一个抛出状态。
- 输出（`js_println` / `js_proc_stdout_write`）走解释器自己的缓冲。宿主那份缓冲和这边是两个，
  交错落盘就分叉了；字符串化仍然只有一份（`js_str`）。
- `js_asFn` 是 raw op（返回的是函数值本身，过不了 dynamic 的边界），所以 `CallFn` 上那一整条
  并成宿主的 `js_call_fn` —— "不是函数"的检查和消息也就留在宿主那一份里。

### 函数值的实参口径：`js_wrap_fn` 是转接，不是恒等

JS 域的函数只有一个签名 `fn(list<dynamic>) -> dynamic`，形参**是整条实参表**；Omni 域的函数
形参是按位置绑的。解释器造出来的函数值要同时被两边调，所以：

- `MakeClosure` 按模块口径（`lower.js` 给的 `js: true`）决定把 fp 收到的那条 list 当成
  "整条实参表"（JS 域，再包一层交给唯一那个形参）还是"位置实参"（Omni 域）。
- `js_wrap_fn(f)` 造一条转接记录：宿主按 `fp(self, args)` 调它，转接把 `(self, args)` 装成
  一条表再调 `f`。**恒等是错的** —— 编译出来的两代里 `f` 自己也是"实参表"口径的函数，
  恒等会让它把 `args[0]` 当 `self`、`args[1]` 当实参表。node 宿主上那一份是
  `{ fp: (self, args) => f(self, args) }`，C 侧是 `omni_js_arr.h` 里的
  `struct omni_js_wrap_s { fp; inner; }` 加一个 trampoline（第一字段是函数指针，所以转接
  自己也是一条普通闭包记录，在 C 侧和 AOT 编出来的函数不可区分）。

### 副产物：这条纪律会当场抓出"子集违规"

解释器这份源码自己要被 JS 前端降级、被 C 后端编译，于是它是语言子集的一个重度用户。
两个已经踩到的坑，都是"node 上悄悄能跑，原生构建上运行期才炸"：

- `bigint.toString()`：封闭 ABI 里 `toString` 只挂在 `real` 上（`js_abi.js` 的
  `JS_METHODS`），int 上会退化成"取 dynamic 的 `toString` 属性"，原生构建报
  `dynamic value is int, expected dict`。用 `String(x)`（`js_str`）。
- `xs.length = 0`：`length` 只可读，写它会降级成"往 list 里按 str16 下标写"，原生构建报
  `array index must be a number, found str16`。用 `while (xs.length > 0) xs.pop()`。

顺带还抓出一个不属于子集、属于 C 后端的 bug：`??=` 这个字面量在产出的 C 里被**三字符组**
换成了 `#`（C99 的 `??=`，clang 只给个 warning 就换），于是自举出来的编译器认不出 `??=`
运算符 —— 词法器的标点表里正有它。`cString` 现在把问号一律转义成 `\?`。

两条都不是解释器的 bug，是子集的边界。挡住它们的是 `tests/bootstrap` 阶段 7 —— 只有
在原生构建上真跑一遍解释器，这类分歧才会暴露。

## 决策 6：REPL 的执行引擎是可换的一格，每条腿都得自己增量

REPL 的驱动（读行、续行、回显、命令、失败回滚）与"哪个运行期跑这一批"是两件事，接缝就是
两个方法：`install(delta)` 把一批新增的 OIR 并进常驻状态，`runEntry(name)` 跑这一批的入口
并把运行期失败收成 `{failed, err}`。`--engine` 选的就是这一格（`src/core/repl.js` 的
`newEngine`）：

- `interp`（默认）：`interp/eval.js` 的 `InterpSession`。函数表/全局量/**顶层 Env** 常驻，
  每批的入口函数跑在同一个 Env 里，所以第 1 批的 `x` 第 2 批还在。
- `js`：`repl.js` 的 `JsSession`。运行时那一份（prelude + 两张派发表）只装一次，每批只发
  这一批的片段（`emitJs(delta, {repl: true})`），装进**同一个全局作用域**。

两条腿对的是**同一份会话快照**（`tests/repl/session*.expected`，每个引擎各跑一遍）：引擎换了，
会话的可见行为一个字节都不该变。增量性另有结构性判据（`tests/repl/incremental.js`）——
解释器那几段钉"每批新检查的函数个数是常数"，js 这段钉"每批 install 的字节数是常数"。

JS 这条腿上有三件事必须专门解决，它们都是"一批一段、装进同一个全局"这个形态逼出来的：

- **模块级名字要跨批活着**：间接 eval（不是 `new Function`，也不是直接 eval）——
  只有它让片段里的函数声明与 `var` 落在全局上。`var g_x;`（不带初值）在那里的语义正好是
  "没有就建、已经有就保留原值"，所以第 2 批重新声明不会清掉第 1 批的值；`let` 只活在那一段
  片段里，下一批根本看不见。
- **会话的顶层变量不是全局量，是入口函数最外层的局部量**（解释器靠常驻 Env 让它活着）。
  JS 上函数体就是函数作用域，所以最外层那几条 `Local` 得提成模块级的 `var`
  （`backend-js/emit.js` 的 `hoistTop`）。只提最外层：`for` 体里的同名局部量仍然是 `let`，
  它在解释器那边也是子 Env。
- **运行期错误不能退进程**：`$rt_error` 默认是"打一行、退 70"，那在 REPL 里等于杀掉会话。
  prelude 因此留了 `$js_set_error_hook`；钩子把消息放进一个全局槽再 throw，于是**跨回驱动
  那一侧的只有字符串** —— 宿主的异常对象在这个值域里不是 dict，漏进来就是一句莫名的
  "function is not an object"。钩子存在运行时模块自己的词法槽里，不是 globalThis 上的副本。

`js` 这一格要的是**能直接吃一段 JS 文本的引擎**，不是"JS 能力"。这两件事必须分开说：
原生构建里 JS *源码* 照样能编能跑（前端 + 任一后端；`tests/js-exec` 那条轴在自举出来的
编译器上也过，`omni run x.js` 在原生二进制上就是走 C 路径），缺的只是"把一段 JS 文本当
程序直接跑"的那一步 —— 所以 `newEngine` 在那种宿主上报的是这句话，而不是"这边没有 JS"。

要把这一格也补齐，路子是让**后端的产物落回前端**：generated JS 走 frontend-js -> OIR ->
解释器。已经量过差什么了 —— 带标签的 `break L` / `continue L` 已经收进子集（降级成 OIR 的
多层 Break/Continue，见 frontend-js 的 `labelLevel`；`tests/js-exec/cases/02-control.js`
钉住），还差 `Object.is`、`>>>`、`process.exit`、`2^64` 这个字面量，以及一张"prelude 的
`$` 辅助名字 -> 运行时原语"的表。补完之后原生构建上的 `--engine js` 就不是一句错误，
而是"JS 后端发的产物，由自己的 JS 前端 + 解释器执行"。

其余方向（`mir` / `c` / `jit`）在原生与 node 上都成立，待做：`mir` 要给 `mir/interp.js`
一个会话（今天只有整程序的 `interpretMir`），`c` 是常驻宿主 + 每批 dlopen 一个增量模块，
`jit` 是把 `src/jit/omni_jit.c` 改成能收多份 `.ll` 的常驻宿主。

## 借鉴与对照

量过 `reference/quickjs-2026-06-04` 的源码之后，逐条对照（行号是那份快照里的）：

- **值表示**：64 位平台上 quickjs 用的就是 `struct { union {...}; int64_t tag; }`，16 字节
  两个字，**按值传参与返回**（`quickjs.h:216..282`）；NaN boxing 只在 32 位平台上自动开启
  （`quickjs.h:56..65`）。也就是说我们的 `omni_dyn` 和它在 64 位上是同一个形状 —— 这条不是
  巧合，16 字节结构体在 SysV AMD64 / AArch64 上走两个寄存器不落栈，是选它的直接动机。
  一处刻意的差别：quickjs 把 tag 编号排成"带引用计数的全为负"，于是 `需不需要 refcount`
  是一次无分支比较（`quickjs.h:287`）。我们阶段 1 靠 arena，用不上；等 ARC 落地时值得抄。
- **不移动**：没有 copying/compacting，环收集器只 free 不搬。但要分清两层 ——
  **对象本体（`JSObject *`）永不移动，对象内部的属性数组会 realloc**，所以源码里到处是
  `/* Note: this call can reallocate the properties of 'p' */`（`quickjs.c:9439`）。
  我们的约定比这条更强：载荷在 arena 里，**连内部数组都不搬**（决策 3），C 侧因此可以长期
  持有任何一层指针，而不只是对象头。
- **refcount 放在 malloc 块头里**（用户指针之前，`quickjs.h:682..685`、`quickjs.c:270..280`），
  `mark` 位与 `gc_obj_type` 一起塞进块头的位域 —— 对象自身为 GC 元数据付 0 字节。ARC 落地
  时这是现成的答案。
- **原生函数约定**：`(ctx, this_val, argc, argv)`，`JSValueConst` 就是 `JSValue`（不是句柄、
  不是引用，`quickjs.h:149`），返回值按值，异常走 `JS_EXCEPTION` 哨兵值 + `current_exception`
  边带（`quickjs.h:294`）。最后这条与我们的"待决错误标志 + 普通跳转"（ADR-0007）是同一个
  形状 —— 一个完整 JS 实现走的也是这条路，不是异常展开。
  值得抄的一处细节：**实参数组零拷贝** —— `arg_buf = argv` 直接复用调用者求值栈上的连续
  slot，只有实参少于声明形参时才 `alloca` 一份补 `undefined`（`quickjs.c:17616`）。这样
  C 函数总能安全读满声明的形参数，省掉了每个 C 函数里的 `argc` 边界检查。我们阶段 1 每次
  调用都新建一个 args 列表，阶段 2 应该换成"args 是槽位数组上的一个窗口"。
- **mujs**：一个可读的 ES5 解释器，值表示与字符串 interning 值得看；但 ES5 这条线对我们
  没用（int64 = BigInt）。

这两条进阶段 2 的清单：

- 分派用 `SWITCH/CASE/DEFAULT/BREAK` 四个宏抽象，**同一份 opcode 实现同时编译成 switch 与
  计算 goto**（`quickjs.c:17787..17811`）—— 正好对上我们"编译期二选一，不是运行期"的要求。
- 分派表 `static const void *dispatch_table[256]`，用 range designator 把 `OP_COUNT..255`
  全填成 `case_default`，于是**一个字节的 opcode 永远索引到合法目标，分派不需要范围检查**。
  表和 label 都由 X-macro 从 opcode 列表生成，编号与顺序天然同步。

## 后果

- 产物里的编译器从此**自带执行器**：`run` 与 `repl` 不再需要 node，也不再需要 cc。
- 语义实现从两份变三份（JS 后端、C 后端、解释器）。这是刻意的：三份互相对照，任何一份写错
  都会在四方比对里当场暴露。代价是每加一个 op 要动三处，和封闭 ABI 的既有纪律一致。
- 阶段 2 之前，解释器的性能不是卖点：树遍历比 C 后端慢一到两个数量级，`run` 之外的场合
  仍然该用 `build`。

## 量过的数字（阶段 1，M 系列 macOS）

基准负载："用编译器自己 link + lower + emit-js 一遍 `frontend-js/lexer.js`"（317 个 OIR
函数，输出 115 KB JS）。墙上时间在这台机器上抖动很大，所以主看 `instructions retired`。

- node 直接跑这段 JS：0.19s，0.77e9 条指令
- node 里跑解释器：2.4s，15.5e9 条（≈ 20x）
- 原生构建里跑解释器：9~14s，40.7e9 条（≈ 53x node 直跑，≈ 2.6x node 托管的同一份解释器）
- 原生构建走 `run`（发 C + clang + 执行）：clang 16.8s，**执行 61ms**

两条要说清楚的：

1. 同一份解释器，编译成 C 之后比 V8 上多花 2.6 倍指令。差距不在树遍历本身，在封闭 ABI 的
   代价：每次调用新建一条实参 list、每个值装成 16 字节 `omni_dyn`、OIR 节点当 dict 读。
   V8 把这些都 JIT 掉了，C 后端老老实实每次都做。
2. `interp` 在这个负载上端到端**快过** `run`，但那只是因为 clang 要 17s。真正执行只要 61ms
   —— 编译执行与解释执行之间是 200 倍，这就是阶段 2（字节码）与阶段 3（JIT）的空间。

原生构建上做过的优化，按收益排（每条都是"把运行期的活挪到编译期"）：

- **字符串字面量池**：`js_s16("kind")` 从"每次求值转一遍 UTF-8→UTF-16 并在 arena 里分配"
  变成一个 `static const omni_s16`。101s → 21s。
- **op 名按 UTF-16 分派**：`js_call_op` 的 205 路 `switch` 不再把名字转回 UTF-8 比字节，
  按长度分组后直接比码元。21s → 12s。
- **属性键的 UTF-8 孪生体**：字典的键口径是 UTF-8，池子里顺带存一份算好的，
  `omni_js_obj_getk` 直接吃它，`omni_js_prop` 那次转换和分配彻底消失。
- **取属性只探一次哈希**：原来 `contains` + `get` 是两次 `_find`。74.9e9 → 61.3e9 条指令。
- **`x === "字面量"` 特化**：`switch` 降下来是 if-else 链，而编译器自己满是 `switch (e.kind)`
  这种四十路的字符串分派 —— 四十次 `omni_js_eq` 调用换成能内联的一句
  `omni_js_eq_s16k`（比标签 + 比长度就短路了）。61.3e9 → 48.1e9。
- **常量下标特化**：`arr_get(args, 0)` 是每次调用读形参都要走的一步，
  `omni_js_arr_geti` 省掉装成 `omni_dyn` 与 NaN/范围检查。48.1e9 → 40.1e9。

后三条不只解释器受益，编译器自己走 C 后端也一样 —— 生成的 C 反而小了 5%（4.02MB → 3.83MB）。

阶段 1 的两条边界（都不是 bug，是"树遍历 + 只涨不回收的 arena"的必然）：

- **宿主栈**。整个自编译（`interp cli.js`）在 node 上要 `--stack-size=40000` 才跑得完
  （32s，输出与 node 直跑逐字节相同）；默认栈大小下每层解释调用要吃十几个宿主栈帧，
  `depth > 4000` 那个守卫来不及触发，先炸的是 V8。
- **内存**。同一件事在原生构建上被 OOM 杀掉：arena 不回收，中等负载已经 520MB 常驻，
  整个自编译是它的二十倍。阶段 2 的"实参是槽位数组上的一个窗口"直接冲的就是这条。



## 量：MIR 解释器为什么慢 —— profile 摆在这儿（下一刀的入口）

尺子：`BBP_Formula.c`（1000 位 pi，纯整数 + 少量 double，`~/Workspace/history/.../CalculatePi`）。
同一台机器、同一份源码，三条路：

```
clang -O0 编出来的                      0.4 s
自带 C 前端 + 自带链接器（omni run x.c）  1.0 s（编 1.4 s 另计）
MIR 解释器（omni c tcc -run）           24.7 s     ← 慢 25 倍 / 62 倍
```

`node --prof` 的结果（22141 个 tick）：

```
21.2%  libnode.dylib                      ← BigInt 的分配与 GC 全在这儿
19.1%  interp.js:492  binOp(o, kind, …)   ← 通用的 64 位那条
11.8%  interp.js:490  bin32 的那个闭包
13.9%  interp.js:315  callFunc
10.7%  interp.js:445  LOAD
 6.9%  interp.js:124  bin32 自己
 5.4%  interp.js:512  比较
 4.6%  interp.js:448  STORE
```

### 两个原因，量级不同

1. **整数是 BigInt**（`F.v[i] = 0n`、`W32 = BigInt.asIntN(32, x)`）。BigInt 的每一次
   运算都在**堆上分配**一个对象 —— 那 21% 的 libnode 就是它加上 GC。这是**量级**那一档
   （2～5 倍），而不是常数因子。
   要动它得先答一个问题：i32 用 Number 表示之后，回绕（`asIntN(32)`）、无符号比较、
   与线性内存 / libc 边界上的换算，各处都得跟着改 —— 而这条腿的身份是 **oracle**
   （它给的答案是别的腿的标准），所以「快一点」不能换来「答案不一样」。
2. **每执行一次就在字符串上 switch**：`binOp(op, kind, a, b)` 先比两次 `kind` 再 switch
   `op`。这是**常数因子**那一档（估 10～20%）：闭包在**编译期**就该把那一格运算挑好
   （`bin32` 已经按类型分了一次，但 op 还是运行期挑）。

### 基线该是什么

用户给的口径：**编译成 JS 之后的执行速度**。这条口径对 C 现在还落不下来 ——
C 的终点是 MIR，而 `backend-js` 吃的是 OIR，中间没有那一段。所以要么
(a) 拿 `.sx`/`.omni` 写同一个算法，量「JS 后端 vs MIR 解释器」的比值；
要么 (b) 给 MIR 加一条 JS 后端。**(a) 是量，(b) 是新腿** —— 先量再定。

<!-- ADR-0013 MIR解释器profile-END -->

### 开工单：把 `binOp` 变成**闭包工厂**（那 19% 的入口）

profile 里 `interp.js:492` 的 `binOp(o, kind, l(F), r(F))` 占 19.1% —— 它每执行一次
都要「比两次 `kind` + switch 一次 `op`」。而 MIR 的每条指令**类型和运算在编译期就定了**，
这两层判断本该只做一次。

形状（`interp/builtin.js`）：

```js
/** (op, kind) -> 一个两参数的函数。算术本身一处不动，动的只是「什么时候挑」。 */
export function binFn(op, kind) { … switch … return (a, b) => …; }
/** 老口子照旧（OIR 那条腿还在用），实现改成走上面那个。 */
export function binOp(op, kind, a, b) { return binFn(op, kind)(a, b); }
```

三条要注意的：

1. **`binOp` 不能因此变慢** —— OIR 解释器的热路也在它上面。所以 `binFn` 要按
   `kind + op` 缓存（`Map`），不然每次调用多一个闭包分配。
2. **两条腿必须仍然逐位相同**：立一条门，把每个 `(op, kind)` × 一组边界操作数
   （0、±1、INT_MIN、INT_MAX、移位 0/31/32/63、除零）都拿 `binFn` 与 `binOp` 对一遍。
   这不是多余的 —— 「dispatch 抄错一格」是静默的错答案，而这条腿是 **oracle**。
3. 同样的做法适用于 `cmpOp`（5.4%）与 `bin32`（6.9% + 11.8%）。

**预期收益 10～20%**（常数因子那一档）。真正的量级还是「i32 别用 BigInt」——
那一格要先答「oracle 的答案不能变」，见上一节。

<!-- ADR-0013 binOp闭包工厂开工单-END -->

### 量：那 19% **不是 dispatch** —— 工厂做了，一点没快，撤了

上面那张开工单照做了一遍：`binOp`/`cmpOp`/`bin32`/`bin32f`/`cmp32` 五处全改成
「装载期挑一次」的闭包工厂（`binFn(op, kind)` / `bin32Fn(op)` / `cmp32Fn(op)` …），
`binOp` 自己改成走 `binFn` —— 所以**没有两份算术**，第 2 条那扇门也就不必立了
（分叉的可能性从根上没有）。

**量出来：24.9 s（基线 24.7 s）—— 一点没快。代码撤了。**

为什么会猜错：**profile 的行号说的是「时间花在这一行上」，不是「花在 dispatch 上」**。
V8 把内联进来的被调者的时间记在调用点上，所以 `interp.js:492` 那 19.1% 里绝大部分是
`W(a + b)` 那个 **BigInt 加法与它的堆分配**，不是 `switch (op)`。字符串 switch 在 V8 上
本来就便宜（形状单一、内联缓存直接命中）。

留下来的三条：

- **常数因子那一档在这条腿上没有便宜可捡**。dispatch 不是瓶颈；`callFunc`（13.9%）与
  LOAD/STORE（10.7% + 4.6%）同理，它们的时间也是「BigInt 值在数组之间搬」。
- **唯一的量级仍来自「i32 别用 BigInt」**。上一节那条注意仍然成立，只是入口不是
  `binOp` 的 switch，而是**值的表示**：`F.v[]` 里放 Number，回绕用 `|0`，
  与线性内存 / libc 边界上各自换算。
- 方法上与「掩码记账那 27% 不是冗余」（ADR-0019）是同一条教训：**先量，改完再量一次**。
  两次都是「看着像冗余，其实不是」——而两次都是靠**改完再量**才发现的，不是靠读代码。

<!-- ADR-0013 dispatch特化的负结果-END -->

### 量：i32 换成 Number 的**天花板是 10 倍**（在解释器那个形状上）

上面说「唯一的量级来自值的表示」——那到底值多少？不改代码先量一把微基准：
两种形状 × 两种表示，各 2000 万次。

```
裸循环        BigInt 430 ms   Number  12 ms   ->  35.8x
过闭包 + 数组  BigInt 281 ms   Number  27 ms   ->  10.4x
```

第二行才是**解释器的形状**（值从 `F.v[]` 里读、在闭包里算、写回数组）——
`10.4x`。裸循环那 35.8x 是给 V8 完全内联后的上限，我们这条腿吃不到。

所以：**i32 从 BigInt 换成 Number，整数密集的程序上限是 10 倍左右**。BBP 那 24.7 s 里
不全是整数运算（还有 f64、调用、线性内存与 printf），所以落地大概是 3～8 s 这一档 ——
仍然是「量级」，与 clang -O0 的 0.4 s 差 10 倍上下，与「编成 JS」那个基线口径也就
终于能比了。

**这一量不说的事**（别拿它当工期）：难的从来不是加法，是那些**边界**——
`asIntN(32)` 换成 `| 0`、无符号比较、`>>> `与 `>>`、i64 那半边仍然得是 BigInt
（Number 装不下 64 位）、线性内存的读写、libc 边界上的换算、以及 `i32 <-> i64` 的每一处
转换。工作量在这些格子上，而每一格错了都是**静默的错答案** —— 这条腿是 oracle。

所以下一刀的形状应该是：**先立一条「i32 全域」的门**（把 `tests/c` 那 207 份 + `tests/mir`
在换表示前后逐字节对一遍），再动表示。门先立，改后再量一次 —— 这一节上面那两次
（掩码记账、dispatch）都是这么发现自己猜错的。

<!-- ADR-0013 i32换Number的天花板-END -->

### 一句要写在明处的：**有两个解释器，性能是两处的账**

`run --backend interp` 在不同语言上落到**不同的引擎**：

- omni / sx / asy / js（前端 -> OIR）-> **OIR 解释器**（`interp/*.js`，`runInterp`）
- C（前端 -> MIR，不经过 OIR）-> **MIR 解释器**（`mir/interp.js`）

上面那些量（BBP 24.7 s、profile、i32 换 Number 的 10 倍天花板）量的是**MIR 那台**。
而「整数用 BigInt」这件事**两台都有**：OIR 那台在 `binOp('int', …)` 上（64 位回绕），
MIR 那台在 `W32`/`W` 上。所以值表示这一刀要**一起动**，不然会出现「同一个程序在两条腿上
一快一慢」，而两条腿又都是别人的 oracle。

这也是为什么 `--backend interp` 的产物问题（ADR-0018）不是纯 CLI 的事：
「哪一个 IR 是可回读的那一个」与「哪一台解释器是主力」是同一个决定。

<!-- ADR-0013 两个解释器-END -->
