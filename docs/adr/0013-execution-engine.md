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

`stage0/src/interp/` 是普通的 JS 源码，和编译器其余部分一样，会被 JS 前端降级、被 C 后端
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

- 形态：`stage0/src/interp/` 直接走 OIR 的节点。环境是"名字 -> 值"的表，函数值是本语言的
  lambda（于是自动满足决策 3 的推论）。
- 入口：`omni run --interp f`、`omni interp f`；原生构建上的 `run` 在门槛过了之后改成默认
  走解释器，`--via-c` 是逃生口。
- 门槛（已落地）：`tests/run.js` 的可执行用例轴上多一条腿 `[js==interp]`，25 个用例
  `node == omni-js == omni-interp` 逐字节相同（stdout、stderr、退出码）；
  `tests/bootstrap` 阶段 7 把原生构建也钉住：`N1 interp == C0 run`。
- 门槛（未落地）：`tests/js-exec/cases`（11 个真 JS 程序）还没进这条轴 —— 降级后的 JS
  用的是宿主库那 139 个 `js_*` op，解释器里还没接（见决策 5），碰到就报
  "not in the interpreter yet"。刻意报错而不是给个错答案。
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

这样"解释执行与编译执行打印出同一串字符"是**构造性的**，而不是三份浮点格式化代码碰巧
一致。同一条理由指向阶段 1 之后的下一步：降级后的 JS 用的是宿主库那 139 个 `js_*` op，
解释器要接的方式也是这个 —— 在 `host/native.js` 里给出 node 的那一份、在 `link.js` 的
`NATIVE_OPS` 里连到同名 op，而**不是**在解释器里再实现一遍 JS 的语义。

### 副产物：这条纪律会当场抓出"子集违规"

解释器这份源码自己要被 JS 前端降级、被 C 后端编译，于是它是语言子集的一个重度用户。
两个已经踩到的坑，都是"node 上悄悄能跑，原生构建上运行期才炸"：

- `bigint.toString()`：封闭 ABI 里 `toString` 只挂在 `real` 上（`js_abi.js` 的
  `JS_METHODS`），int 上会退化成"取 dynamic 的 `toString` 属性"，原生构建报
  `dynamic value is int, expected dict`。用 `String(x)`（`js_str`）。
- `xs.length = 0`：`length` 只可读，写它会降级成"往 list 里按 str16 下标写"，原生构建报
  `array index must be a number, found str16`。用 `while (xs.length > 0) xs.pop()`。

两条都不是解释器的 bug，是子集的边界。挡住它们的是 `tests/bootstrap` 阶段 7 —— 只有
在原生构建上真跑一遍解释器，这类分歧才会暴露。

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


