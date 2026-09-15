# 节点 · 图 · 契约 —— 从十门语言的规格到一台解释器与四个后端

## 0. 这一份的位置

ADR-0033 已经给了形式：**特性 = 签名扩展 + 消去规则**（§2），**程序 = 一张图，节点 =
⟨sort, in-ports, out-ports, effects, lifetime⟩，边只有四种，次序 / 临时量 / 切段 / 释放是算出来的**（§3）。
那一份是**公理**。这一份是**账**：

- 节点**从哪儿来**（答：从 `ext/<lang>/SPEC.md` 那十份规格里量出来，不是坐在这儿设计出来）
- 哪些是**骨架**、哪些是**附属**，判据是什么
- 一门语言的每个细节特性是不是都要一个节点（答：不是，且合并有判据）
- 允不允许高级 / 辅助节点（`list` / `dict` / `map(f)` / fold）
- **求值什么时候发生** —— 为什么 `graph.eval` 本身**就是**默认解释器，为什么从此**不再拼字符串**
- node/graph 与后端（sx / js / c / ir / wasm）之间那份**契约**长什么样
- 异步与并发要的抽象节点与模型
- 信息怎么**保留到 native 那一侧**：`ptr` / `thread` / `async` / `net`
- **pipeline** 问题
- **核心后端**是哪个，以及**为什么必须补 wasm**

ADR-0033 的词汇一个都不改。这一份只做三件 ADR 没做的事：**给节点清单一个来源**、
**给"哪些节点"一条可数的判据**、**把后端从"打印器"改成"答问者"**。

## 1. 节点不是设计出来的，是从规格里量出来的

今天仓库里有一件已经量完的事实可以当证据：十门语言的语法都跑通了同一台 GLR
（`src/core/glr/`），语料覆盖率是量出来的数（chez 135/135、go 8114/8218、sbcl 1415/1433、
mojo 570/602、awk 645/700、vlang 4015/6183、freebasic 954/1722、nim 166/316、lua 52/67、
cpp 16/351）。**语法这一半的经验是：凡是我"想出来"的形状都错过，凡是"按失败分类量出来"的
形状都对。** 节点这一半没有理由例外。

所以顺序写死：

```
ext/<lang>/SPEC.md（十份，格式见 docs/EXTENSIONS.md §八）
      ↓  每份规格的"原子化特性"表里，每一行标注它需要哪几格能力
一份并集：能力清单（capability）
      ↓  一格能力至少两个提供者才算能力（ADR-0033 §5）
节点清单：一格能力对应一族节点，节点 = 五栏声明
```

**先有规格，才谈节点数**。这一条不是流程洁癖：`class` 这个词在 mojo / cpp / freebasic /
vlang 里指四样不同的东西，不看规格就数节点，数出来的一定是 C++ 的影子。

判据（可执行）：`omni nodes --source` 印每个节点是**哪几份规格的哪几行**要求的。
**没有出处的节点不许存在** —— 它要么是我想出来的，要么是从别的编译器抄来的。

## 2. 骨架节点 vs 附属节点

用户那句话是这一份最要紧的一条纪律，先把它形式化：

> 依赖没有那么简单，不是简单 type→expr→stmt→func→class。删掉一个类型，class 结构崩溃了吗？
> 没有。删掉所有类型，class 只算空类。**只有那些依附的属性节点，才是严格的依赖关系。**

### 2.1 判据：删掉它，图还连得起来吗

```
骨架节点（skeleton）：删掉它，图**断了** —— 它的位置上没有别的节点能接住那几条边。
附属节点（attached）：删掉它，图**还连着** —— 它挂在某个骨架节点的一格上，
                      挂点没了它才没了；它没了，挂点照样在。
```

翻译成 ADR-0033 §3 的话，判据是**端口方向**：

- 附属节点的**出端口只被一个宿主节点消费**，且它自己没有独立的 `region`。
  `class` 上的 `attr`（`public` / `mut` / `nogc` / `@[inline]`）、参数上的默认值、
  字段上的位宽、`fn` 上的调用约定 —— 全是这一格。**它们是真依赖**：宿主一删，它们无处可挂。
- 骨架节点的出端口**可以被任意多个节点消费**，或者它自己开一格 `region`。
  `fn-body` / `record` / `call` / `bind` / `branch` / `loop-region` —— 这一格。
  **它们之间没有依赖，只有能力**：`record` 不要求 `int` 存在，删光所有类型，
  `record` 还是一格"有 0 个字段的存储"（= 空类），图照样连得起来。

于是"删掉一个类型 class 不崩"这件事在图上是一句可检查的话：`class` 的入端口要的是
**能力 `record`**，不是**节点 `int`**。而 `mut` 那格属性删掉之后，`class` 的字段上少一格
声明 —— 它是附属的，删它只是少一个写法。

### 2.2 三条推论

1. **依赖图上只有两种边**：骨架↔骨架之间**没有边**（只有 `requires cap` / `provides cap`
   两跳，ADR-0033 §5）；附属→宿主是**一条真边**，删宿主必须连带删附属，且这一步是
   **传递闭包算出来的**，不是手写的名单。
2. **"没有显式表达式类型"的语言不特殊**。awk 与 chez 都没有一格叫 `expr` 的语法类：
   chez 的语法只有 12 条产生式，全在 datum 那一层（`ext/chez/chez.grammar`）。
   在图上它们照样有 `call` / `bind` / `branch` —— **sort 是节点声明的一栏，不是语言必须有的
   语法概念**。规格里没有 `expr` 这个词，不影响节点清单。
3. **优先级 = 骨架先，附属后**。骨架节点少（预计两位数），附属节点多（三位数），
   但附属节点**不产生新机器**：它只往宿主的五栏里加一格。所以工程顺序是
   "骨架数清 → 调度器跑通 → 附属按语言往上贴"。

## 3. 一个特性 ≠ 一个节点

合并判据一句话：**五栏声明逐格相同的两个特性，是同一个节点，只是语法不同。**

已经量过的三组（ADR-0033 §7 列出、这里给出图上的判法）：

- `defer`（go）/ `disposable`（jnc）/ `destruct`（cpp RAII）/ `drop`（mojo）：
  四家的五栏全同 —— `effects: writes`、入端口一格 `consume`、`lifetime: owns`、
  挂在 `region` 的出口。**一个节点 `scope-exit`，四种语法。**
- `interface`（go）/ `trait`（mojo）/ `virtual`（cpp）/ `sumtype` 的方法（vlang）：
  同一格 `dispatch`。
- `call/cc`（chez）/ `goroutine`+`channel`（go）/ `await`（mojo、vlang）/ `gosub`（freebasic）/
  `yield`（nim）：同一格 `suspends` 效应 + 同一台续延机器。

反过来，**不许合并**的判据也要写死：五栏里**任何一格不同**就是两个节点。典型的踩坑是
"看起来一样"的两样东西效应不同：`a[i]` 读数组（`reads`）与 `m[k]` 读 map（go 里可能
`allocates`，vlang 里返回 option）不是一个节点。**合并要靠逐格对表，不靠直觉。**

判据：`omni nodes --merged` 印每个节点的语法提供者名单。名单只有一个人的节点，
在规格里必须有一行写明"为什么它只有一家"（ADR-0033 §5 那条"只有一家的不算能力"的同一纪律）。

## 4. 高级 / 辅助节点：许，但要付一条规则

问的是 `list` / `dict` / `map(f)` / fold 这类。答案是**许**，条件两条：

1. **它必须有一条消去规则**（`R_F`），右手边只用更低秩的节点 —— 也就是说
   `map(f)` 必须能被消成 `loop-region` + `call` + `record`，而且那条规则**只写一遍**。
   于是高级节点是**方便**，不是**新语义**：任何后端不认识 `map` 都不影响正确性，
   消去掉就是了。
2. **它必须减少的是节点数，不是行数**。`list` 值一格、`dict` 值一格是划算的：
   十门语言里九门有列表字面量、七门有字典字面量，不给节点就要在每门语言的降级里各写一遍
   "建一格存储、逐个塞"。而 `map(f)` 这种要看：给了它，`for` 循环里的一大类形状能直接对上，
   pure 的 `f` 还能让调度器把整个 `map` 当 pure 处理（ADR-0033 §3.5 第 1 条）——
   这是**净收益**，收。

不许的形状也要说清：**不给"某门语言专属的糖"开高级节点**。V 的 `or {}`、nim 的
`case` 的范围分支、awk 的 `$0`：这些在规格里是**语法**，落到图上是已有节点的组合。
判据：高级节点的提供者数 ≥ 2 门语言，否则它是那门语言 SPEC 里的一条降级规则。

## 5. 求值：`graph.eval` 就是默认解释器

### 5.1 为什么必须先有解释器

ADR-0033 §3.5 说次序 / 临时量 / 切段 / 释放是算出来的。**"算出来"要有一个地方兑现，
否则它只是一句话。** `eval` 就是那个地方：

```
eval(graph, env) :
  按 §3.5 第 1 条算出的拓扑序遍历
  每到一个节点，按它的五栏声明取入端口的值（value / lvalue / lazy / name 四种取法）
  执行它的 kernel
  遇到 may-early-exit / suspends，按 §3.5 第 3 条切出来的续延继续
```

于是**解释器不是一个额外的后端，是调度器的直接读法**。这句话有一条硬收益：
G4（"同一张图算出来的次序逐字节相同"）第一次有了可跑的判据 —— 拿 `eval` 跑语料，
输出不同就是有人重排了。

### 5.2 不再拼接字符串

今天的实情要说明白：现在这条腿是 `ext/<lang>` 降成**核心方言文本**（`(module (fn …) …)`），
再 `lowerCoreSexpr` 进 OIR（`docs/EXTENSIONS.md` §三写着这条路）。文本这一段是要拆掉的那一段。
理由不是审美，是三笔可数的账：

1. **文本没有端口**。拼出来的 `(let $f7 (call f))` 里，"这一格是借还是夺"没地方写，
   于是释放点只能靠约定。ADR-0033 §3.1 数过的三套临时量命名就是这么长出来的。
2. **文本要被解析回来**。降级写文本、后端读文本，中间那次 parse 是纯损耗，且它会
   **默默接受**图上不合法的东西（少一条 `effect` 边，文本照样能读）。
3. **文本没法做 G3（接口相同）**。子图替换前后端口逐格对上 —— 对文本能对的只有字符串相等。

所以路线是：`ext/<lang>` 出**图**，`graph.eval` 直接跑，`sx` 从"中间语言的文本形式"
退成**图的一种序列化**（人看的、diff 用的、快照用的）。`sx` 那份承载力清单（ADR-0031）
从此是**图的能力表的投影**，跟着节点清单慢慢调整 —— 它不再是节点要迁就的上限。

## 6. 契约：后端只回答问题，不打印文本

一份契约，五个后端（sx / js / c / ir / wasm）各填一份答卷。契约里**只有问题，没有模板**：

```
backend.can(node)      → 这个节点的五栏我接得住吗（接不住给一句人话，进账）
backend.carry(port)    → 这格 sort 在我这儿落成什么（i32 / 一格 box / 一格 wasm local …）
backend.effect(e)      → reads/writes/allocates/may-early-exit/suspends/synchronizes 我怎么落
                         （最后一格见 ADR-0035：内存序就是这一问的答案）
backend.region(r)      → 一格存储域我怎么开、怎么关
backend.lower(subgraph)→ 收到一块**接口已知**的子图，出我自己的结构（不是字符串）
```

三条纪律：

- **后端不许问"上一步把它放哪儿了"**。它拿到的是端口，端口的物化由调度器定（I4 / G2）。
  这一条把今天 `emit-ctx.js` 那类"我知道它在 `$fN` 里"的耦合从接口上排除掉。
- **接不住是构建期错误，不是运行期缺口**（ADR-0033 I2）。`omni backend --gaps c` 印
  "C 后端接不住的节点清单"，那张清单就是待办，不是惊喜。
- **后端之间不比较优劣，比较覆盖**。同一张图五个后端跑出来的**可观察行为**必须一致；
  不一致的那一格要么是契约漏了一问，要么是某个后端偷偷加了语义。这是交叉验证，
  也是下面 wasm 那一节的全部理由。

## 7. 异步与并发：一格效应 + 一格能力 + 一台机器

这一族最容易做成十个节点，所以判据要最紧。

**模型（三层，层层可删）：**

```
第 1 层  suspends 效应        —— 图在这一点切段，后半段是一格续延（ADR-0033 §3.5 第 3 条）
                                十门语言里 call/cc、await、yield、channel 收发、gosub 全在这一格
第 2 层  能力 task-queue      —— "有一个地方能存住待跑的续延，并在某个时刻挑一格来跑"
                                提供者：单线程事件队列（js/wasm）、线程池（native）、
                                协程调度器（go 的 GMP 那一档）
第 3 层  能力 channel / mutex —— 续延之间的**交接**。channel = 队列 + 两个挂起点
```

- **节点数**：第 1 层 0 个新节点（它是效应栏的一格）；第 2 层 2 个（`spawn` / `join`）；
  第 3 层 3 个（`chan-new` / `chan-send` / `chan-recv`）。**总共五个**，
  十门语言的异步与并发写法全落在这五个上 —— 这是"不做原子化就永远做不完"在这一族的答案。
- **可删性**：删掉第 3 层，`spawn`/`join` 还在（go 的 goroutine 少了 channel 仍能跑
  WaitGroup 那一档）；删掉第 2 层，`suspends` 还在（生成器不需要队列）。
  **反过来不成立** —— 所以这三层是**能力依赖**，写在契约里，不是节点之间的边。
- **要仔细想的那一格**：`suspends` 与 `may-early-exit` 都切段，但**切法不同** ——
  早退的后半段只被"错误路径"用一次，挂起的后半段要**存起来**（成为一格值，有寿命）。
  所以 `suspends` 会给出端口加一格 `owns`，早退不会。这一格填错，后端会漏放续延帧。
  判据放在 G4 上：同一份语料在 `eval` 与 native 两边的挂起次数必须相同。
- **第 4 层（ADR-0035 补的）**：**跨线程的次序**。第 1–3 层管的是"什么时候切段、
  谁来跑、怎么交接"，都不管"两条线上的读写谁先谁后"。那一格是第七格效应
  `synchronizes` + 效应域（只有 `spawn` 开新域），**仍然是 `effect` 边，边还是四种**。
  §7 这三层与 ADR-0035 那一层的分工：**`suspends` 不开域**（`await` 之后的续延还在原域），
  `spawn` 才开。

## 8. 信息怎么保留到 native 那一侧

问题的实质是：**图上表达得比 js/wasm 精确的东西，不许在路上丢**。四格分开说。

- **`ptr`**：指针是 `lifetime` 栏能表达的（`borrows(in-port k)` / `owns` /
  `untracked`，五格取值见 ADR-0036），
  外加一格 `carry` 问答（`backend.carry` 里"这格 sort 在我这儿是地址还是 box"）。
  js 后端答"box"，c 后端答"地址"，wasm 答"线性内存里的 i32 偏移" —— **同一格声明，三种答案**。
  丢信息的唯一途径是有人把 `ptr` 降成"整数"，所以 `ptr` 是骨架节点，不许被别的节点消掉。
- **`thread`**：见 §7 第 2 层。native 提供线程池那个提供者，js/wasm 提供事件队列那个。
  **图上不写"线程"**，图上只写 `spawn` + 一格能力名 —— 于是"这门语言的并发在 js 上退化成
  单线程"是**提供者的性质**，不是丢信息。
- **`async`**：同上，一格 `suspends`。
- **`net`**：这一格与前三格不同 —— 它是**宿主 IO**，走 `host/native.js` 那道封闭 ABI
  （ADR-0011）。图上它是一族带 `reads`/`writes` 效应的**外部调用节点**，
  没有自己的语义，只有签名。**不给它开新的边种类。**

一条通用纪律：**保留信息的办法是把它写进五栏，不是给它开一格后门。** 凡是"这个信息
五栏里没有格子放"的，先改五栏（加一栏是大事，要写进 ADR），不许在节点上挂自由字典。

## 9. pipeline 问题

"pipeline"在这份仓库里同时指两件事，分开答：

**(a) 语言里的管道**（awk 的 `cmd | getline` 与 `print > "f"`、shell 式 `|`、
V 的 `|>` 那一档、函数式的链式调用）。它在图上是**一串 `value` 边**，加上两端可能带
`suspends`（真正的进程管道要阻塞）。**不给 pipeline 开节点** —— 它是"若干节点 +
一条效应链"的形状。awk 那一格已经量过：`|&` 与 `print (a,b) > "f"` 是语法层的事
（`ext/awk/awk.grammar`），落到图上是 `call` + 外部 IO 节点。

**(b) 编译器自己的流水线**（读 → 图 → 消去 → 调度 → 后端）。这一格的问题是真的：
今天顺序散在 `lower.js` 那类文件的注释里。答案 ADR-0033 §2.3 已经给了 ——
**顺序 = 秩的拓扑排序，算出来的**。这一份只补一句工程约束：
**流水线的每一段之间传的是图，不是文本**（§5.2），于是"某一段跑不跑"是可开关的，
每一段的产出都能被 `eval` 直接跑一遍。这就是可删除测试（ADR-0033 §4）在流水线上的样子。

## 10. 核心后端是哪个，为什么必须补 wasm

**核心后端是 C（native 那一档）。** 理由只有一条且是可量的：这个项目是 stage0 自举
（`docs/bootstrap-build.md`），最终要产出一个不依赖 node 的 `dist/omni`。
能兑现这件事的只有 native 这条腿，所以它的契约答卷必须**满格**，别的后端可以有账。

**js 是尺子。** 它跑得起、错得早、语料现成，`graph.eval` 与 js 后端两边对跑是最便宜的
G4 判据。

**wasm 必须补，理由三条：**

1. **它是契约的第三种答案**。§6 说"后端只回答问题"，两个后端不足以暴露契约里的
   隐含假设 —— C 与 js 恰好在"有地址 vs 无地址"这一格上对立，容易让人把契约写成二选一。
   wasm 是**有线性内存但没有原生指针、有结构化控制流但没有 goto、有 i32/i64 但没有 GC
   （除 GC 提案）**：它对每一格都给出**第三种**答案。凡是加 wasm 要改契约的地方，
   就是契约原本写错的地方。
2. **参考实现全都有 wasm 目标**。语料这十门里，go（`GOOS=js/wasm`、tinygo）、
   cpp（emscripten）、nim（`--backend:js` 与 wasm 经 C）、vlang、mojo（MLIR 那条线）、
   lua（wasmoon/fengari）、chez/sbcl（有实验实现）—— **几乎每门编译型语言都有 wasm 落法**。
   于是 wasm 是唯一能"拿别人的输出当尺子"的公共靶子：同一份源码，我们的 wasm 与
   参考实现的 wasm **行为**能对，才算图没丢东西。
3. **它是 native 与 js 之间唯一的桥**。`ptr` / `thread` / `async` 这四格（§8）在
   wasm 上都有**受限但真实**的落法（线性内存 / threads 提案 / asyncify）。
   受限的落法比"退化成 box"更能检出信息丢失。

四个后端的分工写死：**C 是产品，js 是尺子，wasm 是契约的证明，sx 是给人看的序列化。**
`ir` 那一格是 C/wasm 共用的下半段，不单独算一个后端的立场。

**wasm 那条腿量过一遍了（还没写代码，先把路探明）。** 仓库里已经有一个 WAT 前端
（`src/core/frontend-wat/lower.js`，WAT -> OIR）与一条能在**进程内**跑起来的路：
`lowerWat(...)` -> `interpretMir(oir)`。拿手写的最小模块试过三样，结果是量出来的：

- ✓ **函数 + 调用 + return**：`(func $twice (param $n i64) (result i64) (return …))` 收得下、跑得对（42）。
- ✓ **while 的形状**：`(loop $again (if cond (then … (br $again))))` 收得下、跑得对（0/1/2）。
- ✗ **`br` 跳外层 `block`**：报 `br to a non-innermost label is not supported yet
  (OIR has no labeled break)`。

第三条当时看着是墙，**再量一遍发现墙记错了**（这一条比结论本身值钱）：
OIR 的 `Break` / `Continue` 本来就带一格 `level`（1 = 最内层），四条腿全认 ——
interp 的 `BREAK + OUTER*(level-1)`、MIR 的 `levelOf`、C 与 js 的带标签 jump。
真正没写的是 **WAT 前端**那一句 TODO（它自己的报错还写着 "OIR has no labeled break"）。
而那一份把 `block` 与 `loop` **都**降成一格 `While(true)`，所以标签的距离就是循环的层数：
`level = depth + 1`，一句话就补上了。判据是 `tests/wat/cases/04-br-outer.wat`
（从 `bad/` 挪过来的那一份 —— 边界不是"忘了做"，是**做到了就该挪**），
三个执行器逐字节相同。教训写在这儿：**"墙在哪一层"也要量，不能从报错的字面读。**

这也说明 `gaps()` 那台机器**至今是空转的**：现在三个后端（interp / sx / js）都报"没有缺口"，
因为它们都在 JS 宿主里，什么都接得住。**加 wasm 的第一份价值不是多一条腿，是让缺口清单
第一次真的有内容** —— 那是 §6 第 2 条纪律（"接不住是构建期错误，清单是算出来的待办"）
第一次被检验。

**（后续）wasm 后端已经落地** —— `src/core/graph/backend-wat.js`，第四条腿。
它的判据不是自己说的：出来的 WAT 文本交给**另一个前端**（`frontend-wat`）读、
用 `interpretMir` 真跑，输出与 interp / js 两条腿逐行相同。量出来的现状：

- 新加一个例子家族 `intmath`（期望 `15 / 120`）—— 刻意"贫瘠"：只有整数、函数、调用、
  语句位置的 `if`、`while`、打印一格整数。**九门语言各一份**，四个后端全绿 = 36 格。
  两门 Lisp 后补进来时**多接了一格**：`if` 出值（Scheme / CL 的函数体最后一格就是返回值）
  落成"一格临时量 + 两支各赋值" —— wasm 的 block 不带 result，而临时量本来就是调度器
  算出来的四样之一（ADR-0033 §3.5），所以这不是新语义，是物化。
  chez 那份因此刻意只用顶层 `define`：嵌套的 define 是闭包，那一格还在缺口清单上。
- `gaps('wat')` 现在真的印出**缺口**（不是"暂不支持"，是一句人话一条）。
  第一版 10 格 → 记录与列表上线性内存后 4 格 → 多值与切片也上去之后 3 格 →
  break/continue 与出口动作也补上之后**剩 1 格**：`conv` 的 `float`（这一批只有 i64）。
  这就是缺口清单该有的样子 —— 它会**变短**，也会因为新节点变长，而每一格都有名有姓。
- **出口动作（`scope-exit`）也上了 wasm**，办法就是那句"把 region 的出口显式化"：
  每格 `scope-exit` 配一格 i64 局部量当**注册标志**（注册那一刻置 1），
  三条出口上都贴一遍动作、**逆序**、每格看自己的标志 ——
  落到 region 末尾、`ret`、`break`/`continue` 穿出去。
  **标志不能省**：`scope-exit` 可能藏在 `if` 里，没注册过就不许在出口跑；
  静态地把动作贴到出口上会把这一条丢掉（那就是"看着绿其实错"）。
  手搭的四格图（逆序 / 早退穿过 region / 什么时候求值 / continue 照跑步进）
  现在全用**整数**，所以四条腿一起验 —— 判据能多一条腿就多一条。
- **break / continue 也上了 wasm**：`(block $B (loop $L (if cond (then (block $C 体) 步进 (br $L)))))`
  —— 中间那格 `$C` 是关键，`continue` 直接跳 `$L` 会漏掉步进（与调度器那侧把步进单列成
  `post` 端口是同一条理由）。顺带被矩阵抓出一个**会给错答案**的 bug：一元的 `-`
  当成"少一格实参的二元"就悄悄算成 `1 - 0`（nim / mojo 那两份 loopexit 印出 7 而不是 8）。
  现在少一格实参一律报缺口 —— **不许当 0 用**。
- **切片那一格顺手证了三件事**（都是量过才敢写的）：`$hp` 推的字节数可以是**算出来的**
  （运行期大小的分配）、`br` 跳**最内层**的 loop 是允许的（拷贝循环因此写得出来）、
  长度存在偏移 0 让边界检查有得读（越界落 `unreachable`，与 interp 那侧报错一一对应）。
- **多值那两格的 `carry` 答案量出来了**：wasm 的函数只有一格结果，所以多值落成
  "一块 N 格的存储 + 返回它的地址"，`pick` 就是"读第 k 格"。**长度不存** ——
  `pick` 的 k 是编译期常量（它是一格附属），与列表正相反（下标是运行期算的，所以那儿存长度）。
  于是 `examples/values.*`（CL 的 `values` / nim 的元组）四条腿全绿；
  `examples/multi.*` 当时还跳着（理由是"印成一行要运行期造串"），后来那格也补上了 ——
  见下面"三格顺手关掉的"里的第三条。
- 矩阵里因此第一次有了 **skip** 这一档：**每一格都带理由**
  （"打印一格多值要运行期长度 + 拼串" / "嵌套的函数（闭包）还没接" / "墙在 OIR 不在 wasm"）。
  跳过不是失败 —— 那正是 §6 第 2 条要的样子：待办是算出来的，不是文档里许的愿。
  现在的总账：**217 passed / 0 failed / 7 skipped**（语言例子 51 + 手搭图 5 × 后端 4），
  每条腿末尾还印一行覆盖：`interp 56/56 · sx 56/56 · js 56/56 · wat 49/56（缺口 1 格）`。
  这三个数会随每一批节点变 —— 它们是**跑出来的**，不是写下来的，所以文档里这一行
  过期就是错，改代码的那一趟必须顺手改它。
- **"还在跳的几乎全是字符串"那句话是错的 —— 数一遍就知道**。当时 21 格跳过里字符串只占 4 格
  （defer 那个家族），最大的一堆是 **7 格 `值位置上还接不住 ret`**：
  `if (a > b) { return a } else { return b }` —— 九门语言里七门的 `max2` 就是这个形状。
  接法只有两行：值位置上碰到 `ret` / `loop-exit`（**一走就不落回来**的那两格）
  当语句发一遍、值给 0（那格值没人读得到，它后面是死代码）。一格判断换回 6 个例子。
  教训与前两条同一条：**账要按跑出来的数记，不按印象记**。
- **字符串也上了 wasm**，一共三层，缺一层就只能给错答案：
  1. WAT 前端多一格宿主面 `(import "omni" "print_str" (func $p (param i32)))` ——
     它是唯一一条**要读内存**的导入：实参是地址，那里"前 8 字节是长度，正文从 +8 起"。
     降级时合成一格 OIR 函数（一格 while + `chr` + 串拼接）把字节读成串。
     **只认 ASCII**：≥ 0x80 当场 `fail` —— 多字节 UTF-8 要按码位组装，硬拼会印出乱码。
  2. 图那侧的 wat 后端把串常量发进 **data 段**（同一份布局约定），`$hp` 从它们后面起步，
     所以常量的地址是编译期定下的、与 bump 分配器互不覆盖。
  3. 打印那一步要知道"这一格装的是数还是串" —— 而图这一层**没有类型**。
     于是做一格最小的静态追踪（const / ref / bind / set 这几格），串只许待在
     "绑给局部量"与"打印"两处；流到实参、字段、元素、返回值上一律报缺口。
     同一个名字先装串后装数记成 `mix`，打印时报缺口 —— awk 那份 basics 就卡在这儿
     （`tag = "ok"` 与数值共用一格无声明的量），**这是对的**：印一格地址才是错答案。
- **落到函数末尾也是一条出口** —— CL 那份 `unwind-protect` 例子把这个漏洞钉出来了：
  出口动作贴在 `(return ...)` 后面等于没贴（印出 in / out，b 与 a 全丢）。
  现在"最后一格就是返回值"那条路也走 unwind，而且**先把返回值落进临时量再跑动作** ——
  与调度器那侧同一个顺序（出口动作看得见的是已经定下的返回值）。

**记录与列表已经上线性内存了**（上面第 1 条做完了）：一格 bump 分配器（`$hp` 从 8 起）、
值一律 8 字节、地址装在 i64 里取内存时 `i32.wrap_i64`（**wasm 有内存没有指针**的样子）、
字段名共用一张模块级偏移表、列表长度存偏移 0 元素从 8 起、越界落 `unreachable`。
`record` 与 `index` 两个家族因此四条腿全绿 —— 同一张图第一次在"有线性内存但没有 GC"
的后端上跑起来，那正是 §9 收 wasm 的第一条理由。

**还在跳的 7 格，按堆分（数是跑出来的，`node tests/graph/run.js --gaps`）：**

1. **`conv` 的 `float`，5 格**（go / vlang / nim / mojo / freebasic）—— 剩下最大的一堆。
   要的不是一格节点，是**两种数值类型**：f64 的值、f64 的算术、i64↔f64 的转换。
   前端那侧 `f64` 已经认（`OIR_TYPE` 里就有），所以墙在后端"值一律 i64"这条约定上。
2. **闭包，1 格**（chez 的 `basics`：嵌套 `define`）—— 要先定"环境怎么排"
   （线性内存里的一块 + 一格函数下标），与记录同一台机器。
3. **既装串又装数的那格量，1 格**（awk 的 `tag`）—— awk 没有声明，所以这是**真的没类型**。
   报缺口是对的，印一格地址才是错答案。要接就得有类型层（附录 A.5 的 `carry`）。

三格顺手关掉的（都不是"多写一格节点"，是**把两层的约定对上**）：

- **变参的内建**（CL 的 `(+ a b c)`）：折法与 arity 全**从 `prims.js` 那张表查** ——
  interp 用 `reduce` 左折，所以 wat 也左折；空的中性元（`+` 是 0、`*` 是 1）同一张表。
  两处各写一套折法就是两套语义，那是 §5.2 要防的东西。
- **顶层的名字落 wasm 全局量**：wasm 的局部量是函数级的，别的函数看不见 ——
  Scheme 那份 index 例子正是"顶层 `define` 一格向量、函数体里读它"（`xs`）。
  图上它与函数体里的 `bind` 是**同一格节点**，落法分两种只因为 wasm 的作用域分两层。
- **打印一格多值**（`print(f())` 那条 arity 契约）：wasm 上没有 sprintf，所以那一步是
  **运行期造串** —— 一格 `$__str_join` 辅助函数（数位数 → 从末位往前填 → 长度写偏移 0，
  与 `print_str` 的布局共用一份），格数是编译期知道的（两条 `ret` 给的格数不一样就报缺口）。
  判据多加了一格手搭图 `hand+multi-print`：**负数 · 0 · 多位数** —— lua / go 那两份
  例子印的是 1 与 2，单数位非负，把数位循环与负号两条都盖不住。

## 11. 可删除测试：删掉一格特性，剩下的程序照旧跑

这一节回答的是 `target.md` 里问得最重的那一句：

> 怎么保证我删了一个重要特性后，源码不需要到处改动？比如我删了 class 特性，
> 影响了一大批特性，你能确保符合剩下特性的程序正常运行吗？…不做可删除测试，你怎么保证。

**在这一层，"一格特性"的载体就是一格节点**（`src/core/graph/nodes.js` 的五栏声明）。
于是"删掉一格特性"是**一处**改动：把它从 `NODES` 里拿掉。判据三条，全是机械的
（`tests/graph/delete.js`）：

1. **不用它的例子必须照旧全绿** —— 这就是"源码不需要到处改动"的可执行版本。
2. **用了它的例子必须报"没有这一格节点"**（`no such node: X`），而且要报在建图那一步。
   报别的错（unbound name / 跑出别的答案 / 改去要另一格节点）一律算失败 ——
   那说明删这一格会让**别处**崩，级联算漏了。
3. **级联半径是数出来的**，不是手写的文档。

现状：**37 样 × 51 份例子，37 passed / 0 failed**（节点 23 格 + 附属 14 格）。
数出来的半径（删了它，几份例子要它）：

```
骨架那一层
  prim 42/42 · ref 41 · bind 41 · const 40 · call 33 · func 33 · loop 28
  set 27 · branch 27 · region 24 · ret 19
  list-new / index-get / index-set / loop-exit 各 7 · scope-exit 5
  record-new / field-get / field-set 各 4 · values / pick 各 2
附属那一层
  prim.name 42 · ref.name 41 · bind.name 41 · const.value 40 · func.params 33 · func.name 33
  set.name 27 · loop-exit.kind 7 · record-new.names / field-get.field / field-set.field 各 4
  bind.keepMulti 2 · pick.index 2
```

这张表就是 target.md 要的"特性 DAG 排序"的可量版本，而且它比 DAG 说得更准：
**上面那 11 格是骨架**（半径 ≥ 19，删了就没程序可跑），**下面那 10 格想删就能删** ——
删掉 `record-new` 那三格，另外 38 份例子一行不改照旧全绿；删掉 `values`/`pick`，40 份照旧。
这才是"原子化"真正的样子：不是"分层分得细"，是**删了不牵连**。

附属那一轮还顺手给出一条**判"是不是附属"的可量标准**：拿"删节点"与"删它的附属"
两个半径比一比。`bind` 41 而 `bind.keepMulti` 2 —— 差 39，`keepMulti` 是**真附属**；
`prim` 与 `prim.name` 都是 42 —— 一格不差，说明 `name` 根本不是附属，
它就是那格节点**自己的选择器**（"算符没有节点，全落 `prim`"那句话的另一面）。
§2 的骨架 / 附属之分从此不靠直觉，靠这两个数。

为什么它能成立，只有一条理由：ADR-0033 把节点之间的关系限成"端口 + 效应"，
**没有"节点 A 认识节点 B"这种硬连接**。所以删一格节点，别的节点没有一行要改 ——
这条判据跑绿，那句话才算兑现；跑红，就是架构漏了。
附属那一轮也不用新机制：`node()` 建节点时对不上声明就报 `has no attr`，
那是 G1"边完整"检查顺手给的。

还欠的（明说）：**"删掉一门语言的某条语法"还没进这台机器** —— 那是同一条纪律的
另一条轴（删一条产生式，其余那批文件必须照旧过）。

## 12. 落地顺序（每步一个可量产出）

1. **十份 `ext/<lang>/SPEC.md`**（格式见 `docs/EXTENSIONS.md` §八）。
   顺序按"对节点清单的约束力"：chez → sbcl → lua → awk → go → nim → vlang → mojo →
   freebasic → cpp。产出：一张能力并集表。
2. **数骨架节点**（§2 判据），只写五栏声明，一格实现不写。
   产出：`omni nodes --source`（每个节点的规格出处）与 `--merged`（提供者名单）。
   验收：**骨架节点数是两位数**；不是就说明合并判据没用足。
3. **`graph.eval`**（§5）。先只覆盖第 2 步数出来的骨架，跑 chez 的语料
   （135/135 已经读得进来，是最便宜的第一枪）。产出：第一次有 G4 判据。
4. **契约的五个问题 + C 与 js 两份答卷**（§6）。产出：`omni backend --gaps`。
5. **wasm 答卷**（§10）。产出：契约被改动的每一处 —— 那就是这一步的价值。
6. **附属节点按语言往上贴**；`sx` 跟着调整（§5.2）。

## 13. 一句话

**节点从规格里量出来，不从设计里想出来；骨架与附属靠"删掉它图还连不连"分开；
特性合并靠五栏逐格对表；`graph.eval` 就是默认解释器，所以从此不拼字符串；
后端只回答"我接不接得住"，不打印文本；异步全族落在一格效应、一格能力、五个节点上；
C 是产品，js 是尺子，wasm 是契约的证明。**
每一小句都对应一条可跑的检查或一份可印的清单 —— 没有清单的那一句不算写完。

## 附录 A：十份规格的并集（第一版，量出来的）

十份 `ext/<lang>/SPEC.md` 写完之后，§11 第 1 步那张"能力并集表"就有了。
**这是第一版，会随实现调整** —— 但它已经能回答"需要多少节点"。
判据照 ADR-0033 §5：**至少两个提供者才配叫能力。**

### A.1 能力成立（≥2 个提供者）

- `bind`、`region`、`branch`、`callable`、`indirect-call` —— **十门全有**
  （`region` 一门例外，见 A.4 第 1 条）。
- `loop-region` —— lua / awk / go / nim / vlang / mojo / freebasic / cpp（8）。
  chez / sbcl 靠递归与 `tagbody`，不需要它 —— **所以它是能力，不是骨架的必需项**。
- `record` + `layout` —— sbcl / lua / go / nim / vlang / mojo / freebasic / cpp / chez（9）。
- `array` —— chez（四种向量）/ sbcl / lua / go / nim / vlang / mojo / freebasic / cpp。
- `dict` —— lua（table）/ awk（关联数组）/ go（map）/ vlang（map）（4）。
- `dispatch` —— sbcl（CLOS 多分派）/ lua（metatable）/ go（interface）/ nim（method）/
  vlang（interface）/ mojo（trait）/ freebasic（virtual）/ cpp（virtual）（8）。
- **`scope-exit` —— 8 个提供者**：sbcl（7 种 cleanup）/ lua（`<close>`）/ go（`defer`）/
  nim（`=destroy` + `defer`）/ vlang（`defer` + **`lock`**）/ mojo（`__deinit__` + `with`）/
  freebasic（`Destructor` + `Scope`）/ cpp（RAII）。**这是清单上最稳的一格。**
- `task-queue` —— go / nim / vlang / mojo / lua（协程）（5）。
- `channel` —— go / vlang（2）。
- `monomorphize` —— go / nim / vlang / mojo / cpp（5）。
- `stage`（编译期规则引擎）—— chez / sbcl / nim / vlang / mojo / cpp（6）。
- **`text-stage`（记号级预处理）—— freebasic / cpp（2，刚够）。明确不进图。**
- **`property` —— jnc / freebasic（2，刚够）。** ADR-0033 §2.2 拿它当例子，
  这一版第一次数够了提供者。
- **`raw-union` —— freebasic / cpp（2）**；`tagged-union` —— nim / vlang / sbcl（3）。
  **两格，不是一格。**
- `named-type` —— go / nim（`distinct`）/ cpp（typedef）/ chez（3+）。
- `enum` —— go / nim / vlang / freebasic / cpp（5）。
- `ptr` —— go / nim / vlang / mojo / freebasic / cpp / lua（userdata）（7）。
- `foreign-call` —— chez（`foreign`/`fcallable`）/ sbcl / nim / vlang / mojo /
  freebasic / cpp（7）。
- `overload` —— nim / mojo / freebasic / cpp（4）。
- `primitive`（内建不是语言结构）—— chez（`pr`）/ sbcl（primref）/ go（23 格）/
  awk / lua / freebasic（自带词序的语句）（6）。
- `truthiness` —— lua / awk / cpp / freebasic（4，**四家答案各不同**）。
- `zero-init` / `nullable` —— go（零值）/ lua（`nil`）/ awk（取用即存在）/
  vlang（无 null）/ nim（4+）。
- `number-tower` —— chez / sbcl / lua / go / awk / freebasic（6）。
- `bytes` —— lua / awk / go / vlang / freebasic（四种串表示）（5）。
- `multi-value` —— lua / go / sbcl（`values`）/ nim（元组解包）（4）。
- `gc-lifetime` —— chez / sbcl / lua（`__gc`）/ nim（ORC）/ vlang（autofree）（5）。
  **这一格与"释放点靠图上最后一次使用算"冲突，见 A.5。**
- `sexpr-read` / `graph-literal`（datum 标签）—— chez / sbcl（各 2）。
- `mutex` —— vlang（`lock`）/ cpp（`std::mutex` 是库，但语义在语言里）/ go（同）。
  **算 1.5 家，待第二个真正的语法级提供者** —— 现在按 vlang 那条落法
  （`region` + `scope-exit`），零新节点。

### A.2 只有一个提供者（不算能力）

按纪律，这些**不进公共清单**，各留在自己那门的 `ext/<lang>/` 里，且必须有一条消去规则：

- awk：`record-loop`（隐式主循环）、`field-view`（`$0` 与 `$1..$NF` 两种视图）、`regex`。
- sbcl：`read-time-cond`（`#+`）、`read-time-eval`（`#.`）、`host-path`（`#P"…"`）。
- chez：`cell`（`#&` 箱）—— 待第二家。
- cpp：`runtime-type`（`dynamic_cast` / `typeid`）—— go 的类型 switch 与 vlang 的
  sumtype 可能是第二、三家，**没定**。
- freebasic：**"方言要有按宽度读写内存"** —— 这不是能力，是**对方言的要求**
  （ADR-0031 那笔账的答案，见 `ext/freebasic/SPEC.md` §3.3）。

### A.3 求解器（不是节点，也不是能力）

ADR-0033 §10 保留的那一类零件，十份规格里点到的全部：

- **重载决议 + ADL**（cpp 最难，nim / freebasic / mojo 也要）
- **作用域查名**（十门全要；ADR-0029 的作用域图已落）
- **模板实参推导 / SFINAE**（cpp）、**trait / interface 满足性判定**（go 结构式、
  mojo、nim 的 `concept`）
- **UFCS 的候选集**（nim）、**隐式转换偏序**（freebasic 最宽、go 两张表、cpp 转换序列）

规则里以"副作用自由的查询"形式调它们，**每个特性的文档要写明它用了哪个求解器**。

### A.4 不进图（五类，各有出处）

1. **后端自己的节点**：sbcl 的 `jump-table` / `vop-jumper`、go 的 17 格
   （`OITAB` / `OMAKEFACE` / `OJUMPTABLE` …）、V 的 `CTempVar` / `Likely`、
   mojo 的 `__mlir_op.*`、`Asm` 块（V / freebasic / cpp）。
   —— **后端可以有自己的节点，不许倒灌进契约。**
2. **宿主语言里嵌的另一门语言**：V 的 `sql`（4 格 AST）、mojo 的 Python 互操作、
   gsl-shell 的"字符串里的 DSL"。整块当外部调用。
3. **记号级预处理**：freebasic 的 `#define`/`#macro`、cpp 的预处理（`text-stage`）——
   读树之前就消掉了。
4. **只检查不产生代码的特性**：mojo 的 exclusivity 与 origin 检查、vlang 的 `mut`、
   nim 的 `requires`/`ensures`、cpp 的访问控制、freebasic 的 `BoundChk`/`PtrChk`。
   —— ADR-0033 §7 已把这一类列为"不产生代码的特性"。
5. **什么都不是**：cpp 的拷贝省略（prvalue 直接接到消费者的入端口上，
   本来就没有那次拷贝）。

### A.5 十份规格问出来的四笔账（两笔已定，两笔还欠）

**这四笔比任何一格节点都要紧，因为它们是五栏或四种边的漏洞：**

1. ~~跨线程的次序在图上没有表达方式。~~ **已定：ADR-0035。**
   go 的 `go_mem.html` 与 cpp 的 `memory_order` 指到同一处。决定是：
   效应域升成一等（只有 `spawn` 开新域）、加第七格效应 `synchronizes`、
   跨域次序仍是 `effect` 边（**边还是四种**）、内存序是后端那一问的答案、
   竞争检查是一次可达性。
2. ~~`gc-lifetime` 与"释放点靠图上最后一次使用算"冲突。~~ **已定：ADR-0036。**
   lua 的 `__gc`/弱表、nim 的 `=trace`/ORC、vlang 的 autofree 三门指到同一处。
   决定是：`lifetime` 栏扩到五格（`owns` / `borrows(k)` / `static` / **`managed`** /
   **`untracked`**），**一格值不许被两套机制同时管**；跨界只经 `hand-to-host` / `pin`
   两格节点；`managed` 的值图只出根集与 trace 边。
   —— 第 3 笔账（`lifetime` 要几格取值）一并在这一份里定了，
   cpp 的"临时量延长"落成 `borrows(k)` 上的附属 `extends`，释放点计算一个字不改。
3. **驱动器缺一格"回问"机制（还欠）。** cpp 判不了"声明还是表达式"、判不了 `<`/`>`
   （要问"这个名字登记成类型了吗"），nim 的 `optInd` 要问"这一格的列号"。
   **两门语言指向 `driver.js` 同一格缺口** —— 这比任何一门自己的欠账都值钱，
   而且它是**语法侧**唯一还剩的机制欠账（cpp 16/351 与 nim 那 28 份都卡在它上面）。
4. **`suspends` 的两种切段还没对账（还欠）。** `may-early-exit` 的后半段只被错误路径
   用一次，`suspends` 的后半段要**存起来**（成为一格值，有寿命）——
   §7 末尾那条判据（"`eval` 与 native 两边的挂起次数必须相同"）还没跑过。

### A.6 骨架节点候选清单（26 格，两位数，达标）

从 A.1 直接推出来的第一版。每格都能指到至少两门语言的规格行：

```
值与名字   const · ref · set
调用       call · primitive
算子       binop · unop（&& / || / ?: 的第二个入端口是 lazy）
分支与循环 branch · loop-region
域与绑定   region · bind
函数       func（元数分派是附属，见 ext/chez/SPEC.md §3.2 第 2 条）
数据       record-new · field-get · field-set · index-get · index-set · slice
表示       conv（go 12 格 Op 塌成的这一格）
分配       alloc（make / new / 闭包分配 —— 与 allocates 效应的粒度待定）
出口       scope-exit · init
并发       spawn · chan-new · chan-send · chan-recv
语言私有   record-loop · field-view（**只在 ext/awk/**，不算公共格）
```

公共格 **26**（不含最后两格 awk 私有的）。对照三份别人量好的表：
chez 的 `Lsrc` 骨架 17 种（归成 11 族）、go 的 151 格 `Op` 塌成约 25、
V 的 83 格 AST 塌成约 23、fbc 的 45 格 `AST_NODECLASS`。
**四个独立来源都落在 20–30 这一档 —— 这就是"需要多少节点"的答案。**

### A.6.1 第一批（13 格）已经落地 —— 量出来的现状

`src/core/graph/nodes.js` 里那 13 格：
`const · ref · bind · set · binop · unop · call · prim · branch · loop · region · func · ret`。
选它们的判据是"够跑通一门语言含全部基础要素的完整例子"，而**四样刻意不给节点**
（文件头写着出处）：type 是端口的 sort、stmt 是 `effect` 边、decl 就是 `bind`、
**print 是 `prim` 的一格**。

配套四份：`graph.js`（建节点时对着声明查每一格入端口 = G1）、
`eval.js`（调度器 + 默认解释器，`lazy` 端口与 `may-early-exit` 切段都在这儿）、
`contract.js`（契约五问 + `interp` / `sx` / `js` 三份答卷 + 算出来的 `gaps()`）、
`tests/graph/run.js`（**语言 × 后端的矩阵**）。

九门语言各一份 `ext/<lang>/examples/basics.*` + `ext/<lang>/tograph.js`，期望输出
只有一份（`15 / 120 / 7 / ok`）：**9 × 3 = 27 格全绿**。缺的第十门是 cpp ——
它连 7 行的例子都过不了语法（附录 A.5 第 3 笔账，驱动器缺"回问"机制），
所以不进矩阵，理由记在测试文件头。

矩阵抓出来的三处真差别（都不是"某门语言的特例"，都是判据写错）：
1. 拿 `sort` 当"是不是值"的判据 —— Scheme 的函数体最后一格表达式就是值、
   CL 的 `region` sort 是 stat 但有值出端口。改成读 **out-ports**，两门一起对。
2. `(else …)` 是个包装 —— go / V / awk 三处同一个坑。
3. **形参装在一格无名的表里**（mojo / nim）—— 无名表的孩子是全部 items。
   少这一条，每个函数的第一个形参被当成标签吃掉。

**第二批：多值（`values` / `pick`）已落地** —— 11 → 13 格。判据是第二个例子家族
（`ext/{lua,go}/examples/multi.*`，期望输出 `3 / 7 / 1 2`）：`return a, b` 落 `values`、
`x, y := f()` 落"一格临时 bind + 一串 pick"（`destructure` 五门语言共用）、
`print(f())` 验 arity 契约那一条（**列表里只有最后一格展开**）。
端口那一栏因此多一格 `multi`：`pick.from` 与 `ret.value` 原样收多值，别的端口"只要一格"
（lua / go / CL 都是这条规矩）；`bind` 多一格附属 `keepMulti` —— 装住整格多值的那格
临时量用它，没有它的话"`local x = f()` 只取第一格"与"装住多值"两件事分不开。

**第三批：`scope-exit` 已落地** —— 13 → 14 格，**一格节点收下八个提供者**。
判据是第三个例子家族（`ext/go/examples/defer.go` 与 `ext/sbcl/examples/defer.lisp`，
期望输出 `in / b / a / out`）：go 的两条 `defer` 与 CL 的嵌套 `unwind-protect`
落**同一格节点**，三条语义全由调度器给 —— 注册那一刻记下动作、宿主 region 出口时
**逆序**跑、**早退（return）也跑**。
两个后端各自的落法：interp 用 `Env.exits` + `finally`，js 用每层 region 一格 `const __ex`
+ `try/finally`（"最近的那一格 region"靠 JS 的块作用域天然给）。

**这一格后来量出一句写错的话，改在这儿**（比结论值钱的又一条）：当初写的第 1 句是
"注册的那一刻记下动作，**实参当场求值** —— go 的 defer 就是这条"。手搭一格图量过
（`tests/graph/run.js` 的 `hand+exit-when`：`x = 1; scope-exit{ print x }; x = 2`），
interp 与 js **都印 2** —— 也就是说动作里的值是**到出口那一刻才求**的。
这样对 CL 的 `unwind-protect`（清理表在出口求值）与 nim 的 `defer:`（块作用域）是对的，
对 go / V 的 `defer f(x)` **不对**（它们该印 1）。
要两家都对，`scope-exit` 得把 `action` 拆成"被调者 + 实参各一格端口"，注册时把实参
算进临时量 —— 那是一笔记下来的账，四门语言的映射都要跟着改，所以不在这一批里做。
四份 `examples/defer.*` 之所以没抓住它：它们 defer 的都是**常量实参**的打印。

**G5 那条"提供者名单"现在真的印出来了** —— `node tests/graph/run.js --machines`
不是手写的表，是把每门语言建出来的图走一遍、按 `op` 数提供者：

```
 9 机器  bind / func / branch / prim / ref / call / const   （九门语言全有）
 8 机器  loop / set          7 机器  region / ret
 4 机器  scope-exit                       go nim sbcl vlang
 4 机器  record-new / field-get / field-set  go lua nim vlang
 7 机器  list-new / index-get / index-set    chez go lua mojo nim sbcl vlang
 5 机器  loop-exit           go lua mojo nim vlang
 4 机器  values / pick       go lua nim sbcl
```

`scope-exit` 补上了 nim 与 V 的 `defer`（各多一个 `examples/defer.*`，与 go/CL 共用
同一份期望输出 `in / b / a / out`），四个提供者，够 G5 的"机器"线。

**第四批：记录（`record-new` / `field-get` / `field-set`）已落地** —— 14 → 17 格。
判据是第四个例子家族（`ext/{go,lua,vlang,nim}/examples/record.*`，期望输出 `1 / 5 / 6`），
四门语言的四种记号落**同一格** `record-new`：go 的 `(kv …)`、lua 的 `(named …)`、
V 的 `(f …)`、nim 的 `T(x: 1)`；取字段那一格收下两种标签（`sel` 与 `dot`）。

这一批最要紧的一条是**类型不参与**：lua 的 `{x = 1}` 没有类型、go 的 `Point{x: 1}` 有，
落到的是同一格节点，类型名根本不进图 —— 附录 A 那句"删光所有类型，`record` 还是一格
有 0 个字段的存储"第一次有了可跑的证据。

两格没有合并的理由也写在声明里：`field-get`（字段名编译期已知，lower 成偏移量）与
`index-get`（下标运行期算，lower 要边界检查）**不是一格**。

新记的一笔账：nim 的 `T(x: 1)`（对象构造）与 `f(x = 1)`（命名实参）在树上是同一格 `kv`，
这一批按"实参全是 kv"判 —— 分开它们要驱动器能回问"这名字登记成类型了吗"，
**与 cpp 那笔账是同一笔**（A.5 第 3 笔）。一笔账现在有两个欠款人，优先级因此上调。

**第五批：列表与下标（`list-new` / `index-get` / `index-set`）已落地** —— 17 → 20 格。
判据是第五个例子家族（`ext/{go,lua,vlang,nim}/examples/index.*`，期望输出 `10 / 30 / 45`）。
四种列表字面量落同一格：lua `{10,20,30}`、go `[]int{…}`、V `[…]`、nim `@[…]`；
取下标那一格收下两种标签（`index` 与 nim 的 `bracket`）。

`list` 是**高级节点**，收它的理由就是 §4 那两条：九门语言有列表字面量，不给节点
就要在每门语言的降级里各写一遍"建一格存储、逐个塞"；而它有消去规则
（`list-new` → 一格存储 + 一串 `index-set`），所以后端不认识它也不影响正确性。

这一批量出来的那条界限值得单独记：**下标的起点不是节点的事**。lua 从 1 起、
其余三门从 0 起 —— 图上 `index-get` 一律 0 起，lua 的映射里一格 `zeroBased`
把差的那一格减掉（字面量当场算，别的减一格算符）。这与真值观是同一条纪律：
语言之间答案不同的东西，答案由那门语言的映射给，不进节点。

同一条纪律也划出了**没有做**的那一格：`m[k]`（map 读）不进 `index-get` ——
go 的 map 读可能 `allocates`、V 的返回 option，效应那一栏不同就是另一格节点（§3）。
`t[k]`（lua 的任意键）因此也留着，与 map 一起做。

**第七批：表示转换（`conv`）已落地** —— 21 → 22 格。判据是第八个例子家族
（`ext/{go,vlang,nim,mojo,freebasic}/examples/conv.*`，期望输出 `2 / 3.5`），五个提供者。
go 的 12 格 `Op`（OCONV / OCONVIFACE / OCONVNOP …）塌成这一格。

量出来一条值得记的：**五门语言的转换在树上全是"调用"的形状**
（`int(x)` / `f64(x)` / `CInt(x)` / `Int(x)`）—— 连 go 也是（它的 `conv` 产生式只管
`[]byte(x)` 那种带类型语法的）。所以"这是调用还是转换"只能靠一张**名字表**分，
而那张表是**语言的事**（`convs()` 在 fromtree，公共的只有 `int`/`float`/`str`/`bool` 四格）。
这与"算符名的公共表"是同一条纪律：写法归语言，格子归节点。

两笔差别明写在账上：`int` 是**截断**（FB 的 `CInt` 是四舍五入 —— 例子刻意用 7/3 绕开，
真要对上得由 FB 的映射自己套一格 round）；wat 那条腿整格跳过，理由是
"这一批只有 i64，`float` 要 f64 与两种数值类型的算术"。

**多值那两格补到了四个提供者（过了 G5 的"机器"线）**：CL 的 `values` /
`multiple-value-bind` 与 nim 的**元组**（`return (a, b)` / `let (lo, hi) = f()`）。
两家都是"加语言不加节点" —— 消费侧共用 `destructure`，生产侧共用 `values`。
它们单开了一个家族（`examples/values.*`，期望 `3 / 7`），理由写在那份例子的文件头里：
`examples/multi.*` 还压着"实参表里只有最后一格展开"，而 CL 的 `princ` 遇到多值只印第一格、
nim 的 `echo` 印的是元组 —— **硬凑成同一份输出就是替它们编语义**。

**第八批：切片（`slice`）已落地** —— 22 → 23 格。判据是第九个例子家族
（`ext/{go,vlang,nim,mojo}/examples/slice.*`，期望输出 `20 / 30`），四个提供者。
四种写法（`xs[1:3]` / `xs[1..3]` / `xs[1 .. 2]` / `xs[1:3]`）落同一格；
图上的规矩只有两条：**上界不含、下标 0 起** —— nim 那个"含上界"的 +1 由 nim 的映射做。

为什么不与 `index-get` 合并：它出的是**一格新存储**（`allocates` + `owns`），
`index-get` 出的是宿主里的一格值（`borrows`）—— 效应与寿命两栏都不同，
按 §3 那条"五栏里任何一格不同就是两个节点"，它们本来就是两格。

顺带量到一条：**取一格与取一段在四门语言的树上都分得清**（go 的 `slice3`、V 的 `slice`、
nim 的 `(bin "..")`、mojo 的 `(slice …)`）—— 不用回问类型。这与 map/array 那笔账正好相反，
所以这一批做得成、那一批做不成，差别不在"难"，在**语法有没有把话说全**。

下一批：map / dict 那一族（效应要先对表），以及 `scope-exit` 还欠的四个提供者
（lua 的 `<close>`、mojo 的 `with`、freebasic 的 `Scope`、cpp 的 RAII）——
这四个都要先有"方法调用 / 析构"那台机器，不是这一批能硬凑的。

**同一个家族又加了三门（七个提供者）**：Scheme 的 `(vector …)` / `vector-ref` /
`vector-set!`、CL 的 `vector` / `aref` / **`setf` 的广义位置**、mojo 的 `[…]` 与 `xs[i]`。
这三门加进来一行新节点都没有 —— 这是"加语言不加节点"最干净的一次：
两门 Lisp 那三样写起来像函数调用（`(vector-ref xs 0)`），落到的却是同一格 `index-get`，
与 `display` 落 `prim print` 是同一条纪律（**写成什么样是语法的事**）。
CL 的 `(setf (aref xs 1) 5)` 值得单记一笔：左边是**一格形式**而不是名字，
而它落的正是 go 的 `xs[1] = 5` 那一格 —— 广义位置不是新节点，是"左边那格是什么"的事。

**第六批：循环的早退（`loop-exit`）已落地** —— 20 → 21 格。判据是第六个例子家族
（`ext/{go,lua,vlang,nim,mojo}/examples/loopexit.*`，期望输出 `12 / 6 / 8`）。
`break` 与 `continue` 是**同一格节点**：五栏逐格相同，差的只有一格附属 `kind` ——
与 `prim` 收下所有内建、`scope-exit` 收下八种语法是同一条纪律。lua 只有 `break`
（它的 continue 是 `goto`），一格节点两个 kind，不是两格节点。

它是第一格**函数边界之外**的 `may-early-exit`（`ret` 切到函数出口，它切到最近那格
`loop`）—— eval 文件头那句"这一批只有函数边界这一种早退"的账，到这儿还上了一半。

这一批**改了 `loop` 的端口**：步进单列一格 `post`，不再缀在体的末尾。理由是量出来的：
`continue` 要跳过体的剩下部分却**照跑步进**，缀在末尾的写法一加 continue 就是死循环。
js 后端因此在有 `post` 时落 `for (; cond; post)`（JS 的 `for` 在 continue 时照跑更新段），
`post` 里的语句要能写成表达式 —— 接不住的形状当场报（`jsUpdate`）。

**测试多了一格"手搭的图"**（`tests/graph/run.js` 的 `HAND`）：两条调度器自己的语义，
不经过任何一门语言 —— break 穿过一格 region 时那格的 `scope-exit` 照跑
（`in / cleanup / out`）、continue 照跑步进（`0 / 2 / done`）。
**为什么不写成语言例子**：go / V 的 `defer` 是**函数**作用域、nim 的是**块**作用域，
而图上 `scope-exit` 挂的是"最近的一格 region" —— 拿谁的语法当例子都会写歪一门的语义。
这是一笔新账：`scope-exit` 要不要一格附属说"挂到哪一层"（函数 / 块），得等真做 defer
在循环里那一类例子时再定。现在的例子（defer 在函数体顶层）两种口径**恰好一致**，
所以那四份 `examples/defer.*` 是对的 —— 但它们证明不了一般情形。

### A.7 附属节点（不逐个列，按挂点分七类）

1. **挂在一条 `value` 边上**：sbcl 的 `cast` 与 8 个 `lvar-*-annotation`、
   awk 的 `strnum`（值的来历）、cpp 的**值类别**、nim 的类型标注。
2. **挂在一格 `callable` 上**：效应签名（nim 的 `raises`/`tags`、mojo/cpp 的
   `noexcept`）、形参的 `borrow`/`consume`（mojo 五种约定、freebasic 的 `Byref`/`Byval`、
   awk 的"数组按引用标量按值"）、元数与多值、调用约定。
3. **挂在一格声明上**：nim 的 `pragma`（总入口）、V 的 `@[…]`、cpp 的 `[[…]]`、
   mojo 的装饰器、go 的 struct tag、freebasic 的 `Align`/`Field`。
4. **挂在一格 `branch` 上**：`truthiness`（四家答案不同）。
5. **挂在宿主结构上**：awk 的 `BEGIN`/`END`（挂 `record-loop`）、
   freebasic 的 `With` 块里的 `.field`（我们量出 +80 份的那一格）、
   go 的嵌入字段、chez 的 `clause`。
6. **挂在一格类型上**：nim 的七个 `=hook`、mojo 的 origin、cv 限定。
7. **纯注解（删了不影响任何东西）**：chez 的 `profile` / `pariah` /
   `cte-optimization-loc` / `moi`、go 的 `OPAREN`、V 的 `Comment`。

**第 7 类的存在本身就是判据**：它们全是"删掉它，图还连得起来"——
`node-graph-contract.md` §2.1 那条判据在别人的代码库里已经被验证过四遍。
