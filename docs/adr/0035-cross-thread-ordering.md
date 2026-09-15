# ADR-0035：跨线程的次序 —— 效应域 · `synchronizes` · 仍然只有四种边

## 决定

**效应域（effect domain）升成一等概念；加第七格效应 `synchronizes`；跨域的次序仍然写成
`effect` 边，但只许连在两个声明了 `synchronizes` 的节点之间。**

- 边**不加第五种**（ADR-0033 §3.3 那条"`control` 刻意不单列"的同一条纪律）。
- 节点**不加**"内存屏障"那一类。内存序（`seq_cst` / `acquire` / `release` / `relaxed`）
  是 `synchronizes` 节点上的**一格附属**，由后端在 `backend.effect('synchronizes')`
  那一问里答（`docs/design/node-graph-contract.md` §6）。
- 效应栏从六格变**七格**：
  `reads · writes · allocates · may-early-exit · suspends · unordered · synchronizes`。

## 为什么现在做，而不是等实现

这一格不是"以后要补"，是**十份语言规格里两门独立指出来的空洞**：

- `ext/go/SPEC.md` §六第 2 条：Go 的内存模型（`doc/go_mem.html`）规定 happens-before，
  而我们的 `effect` 边按 ADR-0033 §3.3 的定义只表达"**同一格效应域内**的次序边"。
- `ext/cpp/SPEC.md` §六第 3 条：`std::atomic` 的 `memory_order` 与 `volatile` 同上。

两门语言、两套完全不同的语法，指到同一处 —— 按这个项目的规矩（`ext/*/SPEC.md` 里
反复出现的那条），**两家独立指向同一格缺口时，那格缺口就是真的**。

而"等实现再说"在这一格特别贵：调度器读效应栏算次序（ADR-0033 §3.5 第 1 条），
**效应栏少一格的后果是"调度器合法地把两个有依赖的节点重排了"** ——
那正是 ADR-0033 §10 自己点出的最严重的新错误面。跨线程的重排在单线程语料上
**测不出来**，所以它不会被 G4（次序逐字节相同）抓到。**必须先把格子留出来。**

## 三条定义

### 1. 效应域：谁开一格新的

```
一格效应域 = 一串"必须按次序发生"的效应的宿主。

开新域的只有一处：spawn（ADR/§7 第 2 层那个节点）。
  —— go 的 `go f()`、vlang 的 `spawn`/`go`、nim 的 `createThread`、mojo 的 async task、
     lua 的 coroutine.create、cpp 的 std::thread
不开新域的：region、loop-region、branch、call、suspends 切段。
```

`suspends` 那一条要说清：**挂起不开新域**。`await` 之后的续延仍在原域里 ——
它只是"晚一点跑"，不是"另一条线上跑"。这一条把协程与线程分开，
而这两样在 `node-graph-contract.md` §7 里本来就是第 1 层与第 2 层。

### 2. `synchronizes`：跨域次序的唯一通道

声明了这格效应的节点，就是 happens-before 的**接缝**。十门语言里的全部提供者：

- `chan-send` / `chan-recv`（go、vlang）—— 发生在接收之前
- `chan-new` 的关闭（`close`）与"从关闭的通道读"
- `spawn` 本身（父域在 spawn 之前的效应 happens-before 子域的一切）
- `join` / `thread.wait()`（vlang 的 `thread T` 句柄、go 的 WaitGroup、cpp 的 `join`）
- mutex 的取与放（vlang 的 `lock x { … }`；按
  `ext/vlang/SPEC.md` §3.2 它是 `region` + `scope-exit`，**这两格上各挂一格
  `synchronizes`**，不新增节点）
- 原子读写（cpp 的 `std::atomic`、freebasic 的 `Atomic` 字段、go 的 `sync/atomic`）

**规则（静态可检查）**：一条 `effect` 边的两端在不同效应域 ⇒ 两端都必须声明
`synchronizes`。否则是构建期错误。这一条把"谁跟谁能排次序"钉死在声明上，
而不是靠后端记得插屏障。

### 3. 数据竞争 = 图上一次可达性计算

两个不同域的节点，一个 `writes`、另一个 `reads`/`writes`，作用在同一格存储上，
且它们之间**没有一条经过 `synchronizes` 的路径** ⇒ 竞争。

这一格是**可选的检查**，落在 ADR-0033 §7 那类"不产生代码的特性"里
（与 mojo 的 exclusivity、vlang 的 `mut`、nim 的 `gcsafe` 同一类）。
**不做推断、不做全局证明** —— 只做这一次可达性，报出来给人看。

## 为什么不是别的做法

- **不加第五种边（`sync` 边）**：happens-before 的两端本来就是效应，
  加一种边等于把同一件事写在两处，然后每台机器都要对齐两处。
  ADR-0033 §3.3 已经为 `control` 付过这笔学费。
- **不把内存序做成节点**（屏障节点）：屏障是**后端的落法**。
  同一格 `synchronizes` 在 x86 上多半什么都不用发、在 arm 上要 `dmb`、
  在 wasm 上要 `atomic.fence`——这正是 `backend.effect` 那一问该答的
  （`node-graph-contract.md` §6、§10 第 1 条：wasm 对每一格都给第三种答案）。
- **不做效应推断**（ADR-0033 §8 已经写死："只声明 + 检查，不要推断"）。
  `synchronizes` 必须写在节点声明里；没写就是没有。
- **不用"unordered"顶替**：`unordered` 是"调度器可以自由重排"，
  `synchronizes` 是"这一点上两条域接上了" —— 方向相反，不能合并。

## 代价

1. **效应栏多一格，所有节点声明要重新过一遍**。多数节点答"没有"，
   但这一遍必须真过 —— 漏一格 `synchronizes` 的后果与漏一格 `writes` 同级
   （ADR-0033 §10 那条"新的错误面"）。
2. **`spawn` 的语义变重**：它现在同时是"一格节点"与"一格域的开端"。
   这是有意的：域的边界必须能从图上看出来，而不是靠命名约定。
3. **测不出来的部分仍然测不出来**。G4 抓不住跨线程重排（§为什么现在做）。
   这一格的判据只能是**静态的**：§2 那条"跨域的 effect 边两端必须声明
   `synchronizes`"是构建期检查，§3 那条竞争检查是一次可达性。
   **不承诺运行期能测出竞争。**

## 判据（可执行）

- **S1**：跨域 `effect` 边两端都声明 `synchronizes` —— 构建期检查，违者编不过。
- **S2**：`omni nodes --sync` 印全部 `synchronizes` 提供者名单。
  按 ADR-0033 §5 的门槛，名单里至少要有 chan（go/vlang 两家）与 mutex（vlang）
  与 join 三族；只有一家的那一族要在规格里写明为什么。
- **S3**：拿 go 的内存模型文档（`go_mem.html`）里列的 happens-before 条款逐条对表：
  每一条要么落在 §2 那六格提供者上，要么记一笔账。**对不上的条数就是这一步的产出。**
- **S4**：竞争检查在 go 语料上跑一遍，报出来的每一处人工看一眼 ——
  这一步的目的不是"零报告"，是**确认报的是真东西**（假阳性率有多高决定这格检查值不值得开）。

## 一句话

**域是 `spawn` 开的，接缝是 `synchronizes` 声明的，次序还是 `effect` 边，
屏障是后端的事，竞争是一次可达性。** 七格效应，四种边，零个新节点。
