# 前端管线统一（ADR-0044）

**所有语言走同一条管线。没有例外。**

graph 不是"另一条路"，是管线里的一个可选阶段。tograph.js 全部替换成
adapter + 公共 lower。Go 的 4900 行也改，awk 的 198 行也改。

## 0. 现状与问题

### 两条路

```
路线 A（jnc/asy/omni）: 源码 → GLR → CST → lower.js → .sx text → sexpr/lower.js → OIR → 后端
路线 B（go/cpp/…11门）: 源码 → GLR → CST → tograph.js → 图 → backend-core.js → .sx text → sexpr/lower.js → OIR → 后端
```

路线 B 多了**两层中间表示**（图 + backend-core 序列化），而这两层做的事与路线 A
的 lower.js **结构上相同**：遍历语句、分派表达式、追踪作用域、收集类型、发射目标格式。

### 冗余的账

| 组件 | 行数 | 与公共 lower 重复的比例 |
|---|---|---|
| 11 份 tograph.js | 9690 | ~70%（语句/表达式/作用域/类型那四块） |
| graph/backend-core.js | 3339 | 100%（把图节点翻成 .sx 文本 = 序列化） |
| graph/types.js | 416 | 与 hir/types.js 平行的第二套类型系统 |
| graph/nodes.js | 594 | 27-op 代数 = .sx 算子的松散镜像 |
| graph/fromtree.js | 420 | CST 辅助 + 语义构造器（部分可提升为公共） |
| graph/contract.js | 461 | 图→.sx 的约定检查 |
| graph/shrink.js | 158 | 图优化（可变为 .sx 层的简化 pass） |
| **总计** | ~15000 | |

`src/lang/jnc/` 有 13333 行，`src/lang/common/` 有 791 行。把公共部分
提取出来之后，**每门语言只剩一份 adapter**（CST → 标准描述），
语义降级（标准描述 → .sx text）只有一份。

### 现有的公共层

`src/lang/common/` 已经存在：
- `sx.js`（113 行）—— .sx 算子的构造器 + 元数校验（**已经是正确的方向**）
- `place.js`（158 行）—— 可写位置的形状分派（var/ptr/agg/prop/bits/be）
- `int.js`（154 行）—— 整数宽度转换表
- `fmt.js`（367 行）—— 格式化字符串

这四份是 ADR-0031 已经走的路。这次是**把它走完**。

## 1. 统一管线

### 1.1 目标架构

```
所有语言:
  源码 → GLR → CST → adapter(语言) → 标准 IR 描述 → lower(公共) → .sx text → sexpr/lower.js → OIR → 后端
```

一条路。adapter 是每门语言的，lower 是公共的。

**graph 变成可选 stage**：`--engine graph` 时，在 `.sx text` 之后插一步
"读回成图 → 走图的后端（WAT/解释器）"。图不再是必经之路，而是一个分支。

### 1.2 标准 IR 描述（adapter 的输出）

adapter 把 CST 翻译成**标准化的 JS 对象**，不是图节点，不是 .sx 文本：

```js
// 模块
{ kind: 'module', decls: Decl[] }

// 声明
{ kind: 'fn', name, params: [{name, type}], ret: Type, body: Stmt[] }
{ kind: 'struct', name, fields: [{name, type}] }
{ kind: 'global', name, type, init: Expr | null }
{ kind: 'enum', name, values: [{name, value}] }

// 语句
{ kind: 'if', cond: Expr, then: Stmt[], else_: Stmt[] | null }
{ kind: 'while', cond: Expr, body: Stmt[] }
{ kind: 'for', init, cond, post, body: Stmt[] }
{ kind: 'for-range', name, iter: Expr, body: Stmt[] }
{ kind: 'return', values: Expr[] }
{ kind: 'break', label: string | null }
{ kind: 'continue', label: string | null }
{ kind: 'switch', value: Expr, cases: Case[], default_: Stmt[] | null }
{ kind: 'let', name, type, init: Expr }
{ kind: 'assign', target: Expr, value: Expr }
{ kind: 'expr-stmt', expr: Expr }
{ kind: 'defer', body: Stmt[] }
{ kind: 'block', stmts: Stmt[] }

// 表达式
{ kind: 'int', value }
{ kind: 'real', value }
{ kind: 'string', value }
{ kind: 'bool', value }
{ kind: 'null' }
{ kind: 'name', name }
{ kind: 'binop', op, left: Expr, right: Expr }
{ kind: 'unop', op, operand: Expr }
{ kind: 'call', fn: Expr, args: Expr[] }
{ kind: 'method', obj: Expr, name, args: Expr[] }
{ kind: 'field', obj: Expr, name }
{ kind: 'index', obj: Expr, index: Expr }
{ kind: 'ternary', cond: Expr, then: Expr, else_: Expr }
{ kind: 'cast', type: Type, expr: Expr }
{ kind: 'new-record', type, fields: [{name, value: Expr}] }
{ kind: 'new-list', type, items: Expr[] }
{ kind: 'new-map', type, pairs: [{key: Expr, value: Expr}] }
{ kind: 'slice', obj: Expr, from: Expr, to: Expr }
{ kind: 'addr-of', expr: Expr }
{ kind: 'deref', expr: Expr }

// 类型
{ kind: 'named', name }
{ kind: 'ptr', inner: Type }
{ kind: 'arr', elem: Type }
{ kind: 'map', key: Type, value: Type }
{ kind: 'fn-type', params: Type[], ret: Type }
```

这不是新发明 —— 它是 tograph.js 里每份 `toNode` 函数**已经在做的事**的显式化。
从前每份 tograph.js 把 CST 翻成图节点，图节点就是这些形状的一种编码。
现在把编码去掉，直接给标准描述。

### 1.3 公共 lower（标准 IR → .sx text）

`src/core/lower/` 的模块：

| 模块 | 功能 | 来源 |
|---|---|---|
| `sx.js` | .sx 算子构造器（含字典那五格 `dnew`/`dget`/`dset`/`dhas`/`dlen`） | **已有**（`src/lang/common/sx.js`，搬过来） |
| `cst.js` | 走 GLR 那棵树的小函数（`tag`/`kids`/`leaf`/…） | 从 `graph/fromtree.js` 搬过来（旧址 re-export） |
| `place.js` | 可写位置形状分派 | **已有**（`src/lang/common/place.js`，搬过来） |
| `scope.js` | 作用域栈 | 从 `emit-ctx.js` 提取 |
| `type-env.js` | 类型注册/查找/别名 | 从 `emit-ctx.js` + `resolve-type.js` 提取 |
| `ty.js` | 类型描述 → .sx 类型文本 + **零值**（`zeroOf`） | 从 `lower.js` 拆出来（语句层也要它，摆在主入口里成环） |
| `lower.js` | **主入口**：标准 IR → .sx text | 新写（调用下面各模块） |
| `lower-stmt.js` | 语句降级 | 从 `stmt-table.js` 提取 |
| `lower-expr.js` | 表达式降级 | 从 `expr-table.js` + `emit-expr.js` 提取 |
| `drive.js` | 源码 → GLR → adapter → lower → `.sx`（接线，一格语义都不加） | 新写（替 `graph/run.js` 的 `graphOf`） |
| `lower-fn.js` | 函数签名 + 函数体 | 从 `emit-fn.js` + `emit-body.js` 提取 |
| `lower-agg.js` | struct/class → .sx | 从 `emit-agg.js` 提取 |
| `lower-global.js` | 模块级变量 | 从 `emit-global.js` 提取 |
| `int.js` | 整数宽度转换 | **已有**（`src/lang/common/int.js`，搬过来） |
| `fmt.js` | 格式化字符串 | **已有**（`src/lang/common/fmt.js`，搬过来） |

**原则**：这些模块的输入是 §1.2 的标准 IR 描述，不是 CST，不是图节点。
每门语言的特殊语义在 adapter 层处理（翻译成标准 IR 时就消化掉了），
或者通过**语义钩子**传进来（见 §1.4）。

### 1.4 语义钩子（adapter 告诉 lower 的那几件事）

不同语言有不同的语义规则。adapter 不是只给标准 IR，还给一张**语义配置表**：

```js
{
  // 算子语义
  ops: Map<string, { result: Type }>,        // "+" 在 (int, int) 上返回 int
  implicitConv: [[fromType, toType, cost]],  // int → real, cost 1

  // 控制流
  hasDefer: true,                            // Go/Nim/V/jnc 有 defer
  deferOrder: 'lifo',                        // Go = LIFO, jnc 同
  hasMultiReturn: true,                      // Go 有多返回值
  breakLabel: true,                          // Go/Nim 有带标签的 break

  // 类型系统
  zeroInit: true,                            // Go 的变量有零值
  valueSemantics: ['struct'],                // Go 的 struct 是值类型
  ptrSemantics: ['slice', 'map', 'chan'],    // Go 的这些是引用类型

  // 作用域
  blockScope: true,                          // C 系都有块作用域
  closureCapture: 'by-ref',                  // Go 的闭包捕获引用
}
```

lower 读这张表决定发码细节。从前这些决定散在 11 份 tograph.js 的 if-else 里，
现在收成**数据**。

### 1.5 每门语言变成什么

| 语言 | 从前 | 以后 |
|---|---|---|
| **jnc** | `src/lang/jnc/`（13333 行 + lower.js） | `src/lang/jnc/adapter.js` + 公共 lower（jnc 有指针/位域/属性等特殊语义，adapter 最大） |
| **asy** | `src/core/lang/asy.js` → .sx → sexpr/lower | adapter + 公共 lower（asy 已经出 .sx，只需要把 lower 里的 asy 特殊逻辑搬到 adapter） |
| **go** | `ext/go/tograph.js`（4900 行） | `ext/go/adapter.js`（~1500 行） + 公共 lower |
| **vlang** | `ext/vlang/tograph.js`（1581 行） | `ext/vlang/adapter.js`（~500 行） + 公共 lower |
| **nim** | `ext/nim/tograph.js`（801 行） | `ext/nim/adapter.js`（~300 行） + 公共 lower |
| **cpp** | `ext/cpp/tograph.js`（534 行） | `ext/cpp/adapter.js`（~400 行，扩展更多 C++ 语义） + 公共 lower |
| **lua** | `ext/lua/tograph.js`（476 行）+ `omni-lang.js` | `ext/lua/adapter.js`（~200 行） + 公共 lower（删掉 omni-lang.js 那份重复） |
| **mojo** | `ext/mojo/tograph.js`（363 行） | `ext/mojo/adapter.js`（~150 行） + 公共 lower |
| **freebasic** | `ext/freebasic/tograph.js`（309 行） | `ext/freebasic/adapter.js`（~120 行） + 公共 lower |
| **sbcl** | `ext/sbcl/tograph.js`（279 行） | `ext/sbcl/adapter.js`（~100 行） + 公共 lower |
| **chez** | `ext/chez/tograph.js`（232 行） | `ext/chez/adapter.js`（~90 行） + 公共 lower |
| **awk** | `ext/awk/tograph.js`（198 行） | `ext/awk/adapter.js`（~80 行） + 公共 lower |
| **gsl-shell** | `ext/gsl-shell/tograph.js`（17 行，代理 lua） | 直接用 lua 的 adapter |

### 1.6 graph 怎么办

**graph 不保留**（2026-09-22 定的，改掉了这一版第一稿"图变成可选分支"那句话）。

第一稿说的是"`--engine graph` 留成一个分支，图从 `.sx` 反序列化"。那句话经不起一条追问：
**谁来判它**。图那一层的后端（WAT / C / 解释器）各有一套判据，而它们判的东西主管线上
已经各有一份（`.sx → OIR → MIR → 解释器`、`frontend-wat`、`frontend-c`、原生腿）。
留一条没人走的路等于留两套实现 —— 那正是这一版要去掉的东西。

所以：

```
CST → adapter → 标准 IR → lower → .sx → OIR → JS / C / 原生        （唯一的一条路）
```

- `ext/*/tograph.js`（11 份，9690 行）**全部删掉**，一门一门地删（迁一门删一份）。
- `src/core/graph/`（12250 行）**整个目录删掉**：`backend-core.js` / `backend-wat.js` /
  `backend-c.js` / `eval.js` / `nodes.js` / `types.js` / `fromtree.js` / `contract.js` /
  `shrink.js` / `stat.js` / `mapping.js` / `lift.js` / …
- `--engine graph` 这个开关**跟着没有**（`run.js` / `cmds.js` 里那一摊接线一起走）。
- 语言登记处（`langs.js`）不是图的东西 —— 它搬到图外面（最后一门迁完那一笔）。
- 图那几条腿的判据**不在图上重建**：WAT 由 `tests/wat` + `frontend-wat` 接、C 由
  `tests/c` + `frontend-c` 接、解释那条由 `.sx` 那条主路接。`tests/graph/` 底下那 3706 行
  随图一起退役，语言例子那张矩阵搬到 `tests/lower/run.js`（迁一门搬一行）。
- `.mapping`（go / lua 那两份声明式映射）与 `tests/lib/mapping-check.js` 一起走。

**迁移期里两条路并存**，判据是登记处那一格：一门语言有 `toIR` 就走公共降级器
（`tests/lower/run.js` 判它），有 `toGraph` 就还在图上（`tests/graph/` 判它）。
**一门语言不许同时有两格** —— `toIR` 一落地，那门的 `tograph.js` 当场删。

**`.mapping` 文件**的迁移：现有的 `go.mapping`（205 行）和 `lua.mapping`（87 行）
是声明式的 CST → 图节点映射。它们的内容被**吸收进 adapter**——
adapter 本身就是 CST → 标准 IR 的映射，只是写成 JS 函数而不是 S-expression 规则。
声明式的形态以后可以在 adapter 层重新引入（如果有多门语言共享同一种 CST 标签到标准 IR 的映射），
但那是**优化**，不是第一步。

## 2. 实施次序

**从最小的开始，逐个验证，最后才动 Go。**

### 第一片：公共 lower 骨架 + sx.js 搬家

1. `src/core/lower/` 目录，搬入 `sx.js`/`place.js`/`int.js`/`fmt.js`
2. 写 `lower.js`（主入口）、`scope.js`、`type-env.js`
3. 写 `lower-stmt.js`、`lower-expr.js`、`lower-fn.js`、`lower-agg.js`
4. jnc 改成 import `src/core/lower/`（jnc adapter + 公共 lower）
5. **判据**：`tests/cases` 全部逐字节不变

### 第二片：最小的那几门迁移

按从小到大的次序：**awk ✓ → chez ✓ → sbcl ✓ → freebasic ✓**（2026-09-22 四门迁完）→ mojo → lua

每一门：
1. 写 `ext/<lang>/adapter.js`（**内容多的语言不许堆在一份文件里** —— 见下面那条）
2. 删 `ext/<lang>/tograph.js`（adapter 替代了它）
3. 改登记处（`langs.js`）：那一门的 `toGraph` 换成 `toIR` + `hooks`
4. 把那门语言的例子从 `tests/graph/cases.js` 那张矩阵搬到 `tests/lower/run.js`
   （**不手抄第二张名单**：矩阵按"有没有 `toGraph`"过滤，搬的只是 `MIGRATED` 那一行）
5. **判据**：那几个家族的输出与迁移前**逐字节相同**

**一门语言一个目录，不是一份文件**：adapter 超过 ~400 行就按关注点拆
（`adapter/expr.js` / `adapter/index.js` / …），`ext/<lang>/adapter.js` 只留一格入口（awk 那种
200 行的小门就一份文件）。go（4900 行的 tograph）与 cpp / vlang / lua 都归这一条 ——
9690 行搬进四五份"什么都装"的大文件不是统一，是把冗余换了个地方。

**这三门迁下来长出的公共零件**（下一门直接用，不必再写）：
- `src/core/lower/ty-of.js` —— 标准 IR 的表达式 → 类型（无类型语言那半笔账的公共部分）；
- `lower.js` 的**语句槽**（`ctx.sink` / `ctx.emit` / `ctx.fresh`）—— 表达式位置上要先跑几句时
  往槽里放，`lowerStmts` 摆在那条语句前面；
- `lower-expr.js` 的 `if-expr` / `block-expr` / `new-record` / `builtin` / `type` 五格 ——
  Lisp 那一族"什么都是表达式"与"造一格记录要临时量"就靠它们；
- `lower-stmt.js` 的 `builtin-stmt`（`dset` / `aset` / `apush` 只当语句用）与
  `withPostBeforeContinue`（三段式 `for` 里的 `continue` 要先跑步进）；
- `ty.js` 的 `zeroOf`（含具名记录：引用语义 `cnew`、值语义 `new`）；
- `sx.js` 补齐了数组五格、记录四格、字典五格。

### 第三片：中等的三门

nim → vlang → cpp

每一门同上。cpp 同时扩展更多 C++ 语义。

### 第四片：Go

Go 最后动。它的 adapter 最大（4900 行的 tograph.js 要翻译成 adapter + 公共 lower），
而且它有 goroutine/channel/select 等特殊语义需要在 adapter 里处理。

1. `ext/go/adapter.js`
2. 删 `ext/go/tograph.js`
3. 删 `ext/go/go.mapping`（吸收进 adapter）
4. **判据**：52/52 包全通、pt 基准逐字节相同

### 第五片：清理（**graph 整个拆掉**）

1. 删 `src/core/graph/` 整个目录（12250 行）
2. 语言登记处（`langs.js`）搬到图外面（`src/core/lang/registry.js`），`borrowedExts()` 跟着搬
3. 去掉 `--engine graph` 这个开关（`cli.js` / `cmds.js` / `studio` 那几处接线）
4. 删 `tests/graph/`（3706 行）与 `tests/lib/mapping-check.js`、`ext/*/*.mapping`、`bench/tograph.js`
5. **判据**：`tests/lower/run.js` 十一门全绿 + 全量判据不变（wat / c / 原生那几条腿归主管线判）

### 第六片：Lab v2 语义层

1. `/api/emit` 加 `annotate` 选项
2. 公共 lower 输出语义标注（类型、作用域、绑定点）
3. Lab 管线面板显示标注
4. Lab "规则"tab

## 3. 判据策略

**每一门迁移的判据是两条**：

1. **输出不变**：`omni run x.<ext>` 的 stdout 与迁移前**逐字节相同**（这一条是硬的）。
2. **中间产物出得来**：`omni emit sx x.<ext>` 不报、不空。

第一稿这儿写的第二条是"`.sx` 逐字节相同"—— 那条**做不到而且不该要**：从前那份 `.sx` 是
`backend-core.js` 印出来的（一格函数挤一行、类型是它自己按图猜的），公共降级器印的是另一种
排版、类型由 adapter 定。要求文本逐字节相同等于要求新路复刻旧路的排版与猜法，那是把
"两套实现"钉进判据里。**判的是行为，不是文本**。

第一稿的第三条（"图那条路仍然走得通"）跟着 §1.6 一起作废：迁过来的语言在图那一层
**不存在**了 —— `--engine graph` 对它们报的是一句人话（"这门已经迁到公共降级器"）。

### awk 那一门量出来的（2026-09-22）

5 份例子（basics / intmath / loopexit / dict / unary）stdout 逐字节相同，判据在
`tests/lower/run.js`。两处**比从前好**、一处明写的取舍：

- 从前"变量当条件"（`while (n)` / `if (s)`）在 `backend-core.js` 里是报缺口的，
  现在 adapter 按 awk 的真值观发 `!= 0` / `!= ""`；
- 三段式 `for` 里的 `continue` 从前靠图的 loop post 端口，现在公共降级器把它改写成
  "步进一格再 continue"（`lower-stmt.js` 的 `withPostBeforeContinue`）—— 少这一手会死循环，
  那是"把 for 摊成 while"这条路上唯一的坑；
- awk 的数只有 double，这一批仍按 `int` 走（与从前那条路同一个取舍，例子里全是整数）。

## 4. 工程量估算

| 片 | 新/改代码 | 删代码 | 判据 |
|---|---|---|---|
| 公共 lower 骨架 | ~1200 行 | 0 | tests/cases 全通 |
| 6 小语言迁移 | ~750 行 adapter | ~2050 行 tograph | tests/graph 对应族全通 |
| 3 中等语言迁移 | ~1200 行 adapter | ~2916 行 tograph | tests/graph 对应族全通 |
| Go 迁移 | ~1500 行 adapter | ~5100 行 tograph+mapping | 52/52 包 + pt 基准 |
| 清理 | ~200 行 | ~4400 行 backend-core+mapping+fromtree 部分 | 全量判据 |
| Lab v2 | ~400 行 | 0 | serve 判据 |
| **总计** | ~5250 行 | ~14466 行 | |

**净减约 9000 行**。而且剩下的那 5250 行里，公共 lower 只有一份——
以后加一门新语言只需要写一份 adapter。
