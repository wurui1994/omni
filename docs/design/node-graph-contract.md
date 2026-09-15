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

## 11. 落地顺序（每步一个可量产出）

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

## 12. 一句话

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

**G5 那条"提供者名单"现在真的印出来了** —— `node tests/graph/run.js --machines`
不是手写的表，是把每门语言建出来的图走一遍、按 `op` 数提供者：

```
 9 机器  bind / func / branch / prim / ref / call / const   （九门语言全有）
 8 机器  loop / set          7 机器  region / ret
 4 机器  scope-exit                       go nim sbcl vlang
 4 机器  record-new / field-get / field-set  go lua nim vlang
 7 机器  list-new / index-get / index-set    chez go lua mojo nim sbcl vlang
 5 机器  loop-exit           go lua mojo nim vlang
 2 能力  values / pick       go lua
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
