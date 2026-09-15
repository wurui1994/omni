# lua —— 语言规格

格式见 `docs/EXTENSIONS.md` §八。词汇见 `docs/design/node-graph-contract.md` 与 ADR-0033。

## 一、为了什么

**lua 是十门里唯一一门已经走完全程的语言 —— 从词法一路到核心方言。所以它压的是"墙在哪儿"。**

`ext/lua/` 底下有别的语言都还没有的四张表（`nodes.js` 30 个节点、`values.js` 元数表、
`scope.js` 作用域配方、`lower.js` 480 行降级）。而 `lower.js` 的头上记着 **17 条账**
（`L-001` … `L-017`），一条一句人话。**那 17 条不是 Lua 难，是拼字符串这条路的上限**：

- `L-004`（多返回值）/ `L-011`（`...`）—— 出端口只有一格的后果。图上是**多出端口**
  （ADR-0033 §3.2「多出端口是常态」），不是缺口。
- `L-005`（闭包捕获）—— `region` 与 `lifetime` 两栏没地方写的后果。
- `L-007`（`and`/`or` 交出来的是**值**不是真假）—— 入端口的求值语义（`lazy`）没地方写。
- `L-016`（`%` 要把两边各用两次，有调用就不能降）—— **临时量物化**没人管的后果，
  正是 ADR-0033 §3.5 第 2 条那条判据（"消费者用它两次以上 ⇒ 必须物化"）。
- `L-009`（`goto`）—— 控制流当成原始概念的后果（ADR-0033 §3.3：`control` 不是第五种边）。

**这 17 条里有 12 条在图上是"某一栏本来就该有的格子"。** 这是
`node-graph-contract.md` §5.2「不再拼接字符串」最硬的一份证据 —— 不是审美，是账。

第二格独有的东西：**`table` 一个结构顶三格能力**（`record` / `array` / `dict`），
外加 **metatable 是 `dispatch` 的一个提供者**。第三格：Lua 5.4 的 `<close>`
（to-be-closed 变量）给了 `scope-exit` 一个与 sbcl 完全独立的提供者。

## 二、需要什么内容

- **官方规格**：Lua 5.5 参考手册（参考树 `lua/manual/`）。与节点有关的：
  §2（值与类型 —— 八种类型，一张表）、§2.4（元表与元方法，那张 `__index` / `__add` 表）、
  §3.3（语句）、§3.4（表达式，含 §3.4.7 的运算符优先级）、**§9（完整语法，一页 EBNF）**。
  Lua 是这十门里**规格最短**的一门 —— "一张表就能放心"在它身上比 chez 还便宜。
- **参考实现里要读的三处**：
  - `lopcodes.h` —— **85 条 VM 指令**。它是"Lua 的语义到底有几件事"的下界。
    与节点有关的几条特别要看：`OP_SELF`(:259) 方法调用的隐形 self、
    `OP_SETLIST`(:335) 表构造、`OP_CLOSURE`(:337) 闭包分配、`OP_VARARG`(:339) 变长、
    `OP_TFORCALL`(:332) 迭代器三件套、**`OP_TBC`(:304) / `OP_CLOSE`(:303)**
    —— 后两条就是 `<close>` 那格 `scope-exit`。
  - `lparser.c` —— 单遍编译器，"哪些形状是语法、哪些是编译期决定"的分界。
  - `ltm.c` / `ltm.h` —— 元方法分派表（`dispatch` 的这个提供者长什么样）。
- **我们这边现成的四张表**：`nodes.js`（30 个节点 + `LUA_SUBCLASS` 那条上位链）、
  `values.js`（`LUA_YIELDS`：谁产生多值）、`scope.js`、`lower.js`（17 条账）。
  **写这份规格不许绕过它们** —— 它们是量出来的，不是设计出来的。
- **语料与现状**：`ext/lua/bench.json` = 官方 `testes/` + LuaJIT 的 `jit/*.lua` + 自带四份。
  GLR 那条腿量出来 **52/67（78%）**，`lua.grammar` 113 条产生式。
  另有 `ext/lua/tests/{gen,sweep,run,bench}.js` 那台以 `luajit` 为外部尺子的机器
  （`docs/EXTENSIONS.md` §六）。

## 三、原子化特性表

### 3.1 值与类型（手册 §2）

Lua 只有八种类型，而且**类型不出现在语法里**（没有类型标注）：

| 特性 | 一句话 | 能力 | 出处 |
| --- | --- | --- | --- |
| `nil` | "没有"是一格值，且它是**假**的两个值之一 | `const` + `nullable` | 手册 §2.1；`lower.js` L-013 |
| `boolean` | 只有 `nil` 与 `false` 为假 —— **`0` 与 `""` 为真** | `truthiness` | 手册 §2.1；L-007 |
| `number` | 5.3 起分整数与浮点两个子类型，**同一个类型** | `number-tower` | 手册 §2.1 |
| `string` | 不可变字节串，带内部化 | `bytes` | 手册 §2.1 |
| `table` | **唯一的复合结构** —— 数组、记录、字典都是它 | `record` + `array` + `dict` | 手册 §2.1；`OP_SETLIST` |
| `function` | 一等，闭包，尾调用是**规定**（不是优化） | `callable` + `tail-call` | 手册 §3.3.6 |
| `userdata` | 宿主的一格不透明数据 | `opaque` + `ptr` | 手册 §2.1 |
| `thread` | 协程 —— **不是 OS 线程** | `suspends` + `task-queue` | 手册 §2.6 |

三条要立刻记下的：

1. **`table` 一格顶三格能力，是"能力粒度"这门手艺的最好考题。** 按 ADR-0033 §5
   的纪律，`record` 要至少两个提供者 —— go 的 struct、cpp 的 class 都提供，合格；
   而 Lua 这一门里三格能力**同一个提供者**。这说明能力与提供者不是一对一，
   **一个提供者可以答多格能力**。这一条要写进契约。
2. **`truthiness` 是一格真能力**：Lua（`nil`/`false` 假）、awk（`0`/`""` 假）、
   go（只收 `bool`）、cpp（`0`/`nullptr` 假）四家答案各不同。
   它不产生代码，只改 `branch` 那个入端口的解释 —— **附属，挂在 `branch` 上。**
3. **`thread` 是协程，落在 `suspends`**（`node-graph-contract.md` §7 第 1 层）。
   Lua 的协程是**非对称**的（`resume`/`yield` 成对），go 的 goroutine 是对称的 ——
   这个差别落在第 2 层能力 `task-queue` 的提供者上，**不新增节点**。

### 3.2 语句与表达式（手册 §3，我们的 `nodes.js` 已经量过）

`nodes.js` 那 30 个节点按骨架 / 附属分：

**骨架（归并后 11 族）**

| 特性 | 一句话 | 能力 | 出处（`nodes.js`） |
| --- | --- | --- | --- |
| `name` | 取名字。**局部 / upvalue / 全局是三种落法，一个节点** | `bind` | :35；L-003 |
| `index` | `a.b` 与 `a["b"]` 是**同一个节点**（`dot` 只是写法） | `dict` / `array` | :39-44 |
| `call` / `method-call` | 调用；`o:m()` 多一格隐形 self | `indirect-call` | :45-54；`OP_SELF` |
| `binop` / `prefix` | 二元 / 一元。`and`/`or` **不是** binop（它们的第二个入端口是 `lazy`） | 各自的算子 | :56-57；L-007 |
| `table` | 表构造：三种格（`field-index`/`field-name`/`field-item`） | `record`+`array`+`dict` | :61-69 |
| `funcbody` / `function-exp` | 函数。形参表 + 可选 vararg | `callable` | :58,:72-75 |
| `block` / `do` | 一格域 | `region` | :76,:81 |
| `local` / `assign` | 声明 / 赋值。**赋值左边要 `var` 类** —— `f() = 1` 不合法是这条的自动结论 | `bind` | :80,:112 |
| `if` / `while` / `repeat` | 分支与两种循环（`repeat` 的条件能看见体里的局部量） | `branch` + `loop-region` | :82-89 |
| `for-num` / `for-in` | 数值循环 / 迭代器三件套 | `loop-region`（+ `indirect-call`） | :90-98；`OP_TFORCALL` |
| `return` / `break` / `goto` / `label` | 出口四种写法 | `may-early-exit` 效应 | :106-109；L-009 |

**附属**

| 特性 | 挂在谁身上 | 一句话 | 出处 |
| --- | --- | --- | --- |
| `attrib`（`<const>` / `<close>`） | `local` 的一个名字 | `<close>` 就是 `scope-exit`；`<const>` 是一格检查 | `lua.grammar` 的 `attname`；`OP_TBC` |
| `vararg`（`...`） | `funcbody` | 变长形参 = `callable` 的一格附属，**不是新节点** | :34,:74；L-011 |
| `paren` | 一格表达式 | **Lua 里唯一"括号有语义"的地方**：把多值掐成一格 | :55；`values.js`:13 |
| `synDot` | `index` | 同一节点的第二种写法（渲染时要还原） | :43 |
| `method` 名 | `method-call` / `function` | `function a.b:m()` 的那一格 | :53,:104 |
| 多值（`LUA_YIELDS`） | `call` / `method-call` / `vararg` | 谁产生多值、谁掐断 | `values.js`:9-15；L-004 |

**metatable 那一族（手册 §2.4）** 单独算一格特性：`__index` / `__add` / `__call` / `__gc` …
—— 它是 `dispatch` 的一个提供者，且它把**几乎所有算子**都变成"可能是一次调用"。
账已经记着（L-002）。这一格是 lua 对图的最大压力：**`+` 的效应栏不再是 pure**。

## 四、分层 · 组合 · 依赖

```
requires（骨架 → 能力）
  name / local / assign     → bind
  block / do                → region
  if                        → branch（+ truthiness 附属）
  while / repeat / for-*     → loop-region, branch
  for-in                    → loop-region, indirect-call
  call / method-call        → indirect-call
  table / index             → record, array, dict
  funcbody / function-exp   → callable, region
  return/break/goto/label   → （may-early-exit 效应）
  coroutine（库函数）        → suspends 效应, task-queue
  metatable                 → dispatch

attached-to（真依赖）
  attrib <const>/<close>  → local 的一个名字（<close> 同时是 scope-exit 的提供者）
  vararg / 多值            → funcbody / call
  paren                   → 一格表达式（掐断多值）
  truthiness              → branch
  synDot                  → index
```

**这一节要证明的三句话：**

1. **删光所有类型，`table` 还在。** Lua 连类型标注都没有 —— `nodes.js` 那 30 个节点里
   **一个都不提类型**。所以"`type→expr→stmt→func→class` 这条依赖链"在 lua 上是空的：
   删掉 `number`，`table` 与 `function` 一个字不用改。
2. **`goto` 不是骨架。** 它与 `return` / `break` 落在同一格 `may-early-exit`。
   Lua 的 `goto` 有约束（只能往前跳到同层或外层标签、不许跳进局部量的作用域）——
   **那约束正好是 `region` 的边界**，所以它在图上是"跨 region 的早退"，零新节点。
   L-009 那条账在图上自动还掉。
3. **`repeat … until` 的条件能看见体里的局部量。** 这一条说明 `loop-region` 的
   `region` 边界与"体"不重合 —— 是这门语言送给 `region` 那一栏的一道好题。

## 五、优先级和顺序

1. **多值（`multi-value`）** —— 排第一。Lua 是十门里多值语义最细的一门
   （谁产生、谁掐断、列表里只有最后一格展开），而 `values.js` + SDK 的 `arity.js`
   **已经把这套契约写成表了**。把它接到"多出端口"上，L-004 / L-011 两条账一起还。
2. **入端口的求值语义（`lazy`）** —— `and` / `or` / `truthiness`。还 L-007 / L-014 / L-017。
   这一格与 chez 的 `if` 是同一格能力，两门对账。
3. **临时量物化** —— 直接拿 L-016（`%` 要把两边各用两次）当判据：
   调度器插了临时量，这条账就该自动消失。**这是 ADR-0033 §9 第 2 步"净减行数"的第一枪**，
   而且 lua 这边有现成的 `luajit` 尺子（输出逐字比对）。
4. **`region` + 闭包捕获** —— 还 L-005。`OP_CLOSURE` / `OP_CLOSE` 那两条指令是现成的对照。
5. **`table`（`record`+`array`+`dict` 三格能力一个提供者）** —— 还 L-001。
   这一步要把"一个提供者答多格能力"写进契约（§3.1 第 1 条）。
6. **`scope-exit`（`<close>`）** —— 与 sbcl 的 `cleanup` 对账。
   两门语言、两套语法、同一台机器：G5 的第一次真验收。
7. **metatable（`dispatch`）** —— 还 L-002。排在这儿是因为它要 `table` 先在。
8. **协程** —— 与 chez 的 `call/cc` 同一台续延机器，放在 go 的 channel 之后一起做。
9. **`goto`** —— 最后，因为它要 `region` 边界已经稳（§4 第 2 条）。

## 六、明说的不足（不猜）

1. **17 条账在 `lower.js:20-36`**，一条一句人话。这份规格没有替它们改结论 ——
   只标注了哪几条在图上是"某一栏本来就该有的格子"（§一）。
2. **GLR 那条腿 52/67**，差 15 份。没有逐份分类，所以不说原因。
   注意这一门有**两条腿**（`frontend-engine` 那条已经跑通、GLR 那条 78%），
   两条腿的覆盖率**不是一回事**，别混着报。
3. **`__gc` 与弱表没读**：它们要 `gc-lifetime` 能力（ADR-0033 §5 已列名），
   与我们"释放点靠图上最后一次使用算"的做法**冲突** —— 这一格是真问题，现在只记账。
4. **字符串库的模式匹配（`string.find` 那套）不进语法也不进节点**：它是库，
   不是语言。写在这儿免得后面有人想给它开节点。
5. **整数与浮点两个子类型**（5.3 起）没进 §3.1 那张表的细节：`//` 与 `/` 的区别、
   溢出回绕、`math.type` —— 这些落在 `number-tower` 那格能力的提供者上，
   要等 go（有明确整数宽度）与 awk（只有 double）一起看才定得下来。
6. **`_ENV`**：Lua 5.2 起全局名字是 `_ENV.x` 的语法糖（L-003）。
   这意味着"全局变量"在 lua 上**不是一格能力**，是一次表查 —— 与别的语言不同，
   取并集的时候要小心别把它并成同一格。
