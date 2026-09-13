# ext/lua —— 从 Lua 开始：**节点规则 + 组合规则**，组合的结果自己长出来

这一份是 `ext/` 的第一份设计。写它的原因写在最前面：

在 jancy 那边（`docs/adr/0029`）我做错了一件事 —— **我在处理"组合的结果"**：一次量六列、
一格一格填结论，表长到 594 格还在长。可"位置 × 要素"是一道**组合题**，组合题的解法不是把乘积
列出来，是**把每个节点处理对、把组合方法写对**；那之后每一种组合都自动是对的，剩下的只有
少量真正的边缘情形要单独修。

所以这一份的形状是：

- **每个节点一条规则**（它自己的形状、它对作用域做什么、它对值的个数做什么、它怎么降）
- **组合只有几条规则**（谁能填谁的洞、优先级/结合性、多值怎么截、作用域怎么套）
- 解析器、检查器、降级器都是**读表的驱动器**，不是手写的分支树

Lua 是验这套设计最好的语言：语法极小（一页 EBNF）、语义里恰好有**两条出名的组合规则**
（多值调整、`repeat…until` 的作用域），足够把"组合自动化"这件事验真，又不至于被特性数量埋掉。

---

## 1. 分层与目录

```
ext/lua/
  DESIGN.md        这一份
  tokens.js        词法：每类记号一条规则
  nodes.js         语法节点表：形状 + 洞的类别 + 优先级/结合性
  scope.js         作用域规则：每个节点对绑定做什么（LEX 边怎么长）
  values.js        值规则：每个节点的**元数契约**（单值 / 多值 / 截断 / 展开）
  lower.js         降级：每个节点一小步重写，落到 src/core 的 sexpr
  tests/           例子由规则生成（见第 7 节），不手写清单
ext/gsl-shell/
  DESIGN.md        Lua 之上的扩展（公式子语言 `y ~ x1 + x2 | e : cond`）
  nodes.js         只写**增量**：新节点 + 新洞 + 新组合规则
```

`ext/` 与 `src/` 平级，可以用 `src/core` 的现成件：

- `src/core/frontend-engine/scopes.js` —— `lookupEntry`（查名：候选作用域各自答，次序与歧义在引擎里）
- `src/core/frontend-engine/positions.js` —— 位置代数 + 一致性对账（`compose` / `diff`）
- `src/core/frontend-engine/casts.js` —— 转换关系那张有序表（Lua 用得上：数字/字符串互转）
- `src/core/frontend-engine/overload.js` —— 挑一条（Lua 没有重载，但元方法分派用得上同一把 `pick`）
- `src/core/sexpr` / `hir` / `mir` —— 后端那一摊照旧

---

## 2. 词法：每类记号一条规则（`tokens.js`）

```js
{ name: 'Name',    re: /[A-Za-z_]\w*/,        kind: 'word' }
{ name: 'Number',  re: /0[xX][0-9a-fA-F]*|…/, kind: 'lit' }
{ name: 'String',  quote: ['"', "'"], long: '[[', kind: 'lit' }
{ name: '..',      kind: 'op', prec: 9, assoc: 'right' }
…
```

要点只有两条：

1. **关键字是词，不是特例**：`and` / `or` / `not` 在表里与 `+` 同一档（带 `prec`），
   于是"关键字算符"不需要在语法里另开一支。
2. **长括号（`[[…]]`、`--[==[…]==]`）是记号层的一条规则**，不是解析器里的分支。

## 3. 语法：节点表（`nodes.js`）

每个节点写四样：`shape`（洞的名字与**类别**）、`prec`/`assoc`（只有算符要）、`stat`/`exp` 归属、
`text`（怎么写出来 —— 例子生成器要用它）。

洞的**类别**是这套设计的关键，它把 Lua 那几条"哪儿能放什么"的规矩变成数据：

| 类别 | 谁属于它 | 谁要它 |
|---|---|---|
| `exp` | 所有表达式 | 二元算符两边、`if` 的条件、`return` 的表… |
| `prefixexp` | `Name` / `(exp)` / `index` / `call` | `index` 的左边、`call` 的被调 |
| `var` | `Name` / `index` | 赋值的左边、`for` 的循环变量 |
| `funcbody` | 形参表 + 块 | `function` / `local function` / 方法 |
| `block` | 一串 `stat` + 可选 `laststat` | 所有带体的节点 |
| `field` | `[exp]=exp` / `Name=exp` / `exp` | 表构造 |

Lua 的语法里**只有这六类洞**。"`f().x = 1` 合法、`(f()).x = 1` 合法、`f() = 1` 不合法"
这三句话不用写三条检查 —— 它们是"赋值左边要 `var` 类，而 `call` 不属于 `var` 类"这**一条**规则
的自动结论。这就是"处理好每个节点，组合自动正确"。

节点清单（Lua 5.1 / LuaJIT 2 的全部，共 22 个）：

- 语句：`local` `assign` `call-stat` `do` `while` `repeat` `if` `for-num` `for-in`
  `function` `local-function` `return` `break` `goto`+`label`（5.2/LuaJIT 扩展）
- 表达式：`nil` `true` `false` `number` `string` `vararg`（`...`）`function-exp`
  `prefix`（`-` `not` `#`）`binop` `index` `call` `method-call` `table` `paren`

## 4. 作用域：每个节点对绑定做什么（`scope.js`）

一条规则的形状：`{ opens?: 'block'|'function', binds?: (node) => names, visibleFrom?: … }`

Lua 的全部作用域规矩就五条，写成节点上的属性之后再没有别的地方要管它：

1. `block` 开一层；`funcbody` 开一层并把形参（含 `...`）绑进去。
2. `local a = e`：**`e` 在绑定之前算**（所以 `local x = x` 里右边的 `x` 是外层那个）。
   写成规则：`binds: after`。
3. `local function f`：**先绑名字再算体**（递归要它）。写成 `binds: before`。
4. `for` 两种：循环变量绑在**体那一层**，每轮一格新绑定。
5. `repeat body until cond`：**`cond` 看得见 body 里的 local** —— Lua 里唯一的"块作用域漏一格"。
   写成 `until: 'inside'`。

查名直接用 `src/core/frontend-engine/scopes.js` 的 `lookupEntry`：候选作用域序列 =
本层 → 外层… → `_ENV`/全局。**全局访问在 Lua 里就是 `_ENV.x`**（5.2 的说法），
所以"找不着"不是错，是一次表查 —— 这条也写在规则里（`fallback: 'ENV'`），
而不是散在降级器里。

## 5. 值：元数契约（`values.js`）—— Lua 最需要"自动组合"的地方

Lua 的多值规则是**组合规则**的教科书例子。四条：

1. **产生多值的只有三种节点**：`call` / `method-call` / `vararg`。
2. 这三种在**表达式列表的最后一格**才展开；不在最后就截成一格。
3. `paren` 强制截成一格（`(f())` 只有一格）。
4. 需要固定元数的洞（二元算符两边、`if` 条件、`index` 的下标…）一律截成一格。

写成每个节点的一格属性：

```js
call:      { yields: 'multi' }
vararg:    { yields: 'multi' }
paren:     { yields: 1, truncates: true }
binop:     { holes: { a: { arity: 1 }, b: { arity: 1 } }, yields: 1 }
explist:   { spread: 'last' }     // 只有最后一格展开
```

于是 `f(g(), h())`、`{ g(), h() }`、`return g(), h()`、`local a, b = g()` 这些"看着不同的
组合"全落在同一条 `spread: 'last'` 上 —— 不用为每一处写一遍。**这正是"组合的结果不该手写"
的意思**。

## 6. 降级：每个节点一小步（`lower.js`）

每个节点一个 `lower(node, ctx)`，只管自己那一步，孩子由驱动器先降好（后序）。方言那边缺的
两样先记账（与 ADR-0016 的记账口径一致）：

- **表（table）**：Lua 的表既是数组又是哈希，落到方言要一格自己的对象表示 —— 第一刀先只收
  "数组部分 + 字符串键"，别的记成账。
- **元表（metatable）**：`__index` / `__add` 那一套是**分派表**，用 `overload.js` 的 `pick`
  同一把机器（Lua 的分派规则比重载简单：先左后右，各问一次）。

## 7. 例子不手写：由规则生成

`tests/` 里**不放**手写的用例清单。生成器读节点表，按"每个节点 × 每类洞的每种合法填法"
生成最小程序，再按三问对账（与 jancy 那把尺子同一套，`src/core/frontend-engine/positions.js`）：

1. **收不收**（语法/语义）；
2. **名字落在哪**（`scope.js` 的规则说的 vs 真跑出来的）；
3. **值有几格**（`values.js` 的契约说的 vs 真跑出来的）。

与 jancy 那边的区别：jancy 那张表的每一格是我**填**的；这儿每一格是**算**的 ——
规则给出预期，跑出来对不上就是一条测试失败。**边缘情形**（比如 `repeat…until` 那一格）
在规则里写成一条例外，例外的**数量**就是这套设计的成绩单。

## 8. 与 gsl-shell 的接缝

`ext/gsl-shell` 只写**增量**（见那一份的 DESIGN）：

- 记号层：加 `~` `|` `%`（公式里的 enum 前缀）三个记号的规则；
- 节点层：加 `formula`（`y ~ xs | enums : conds`）、`enum-ref`、`formula-call`；
- 洞的类别：加一类 `formula-exp`（公式里的表达式：只认 `ident` / `number` / `literal` /
  `call` / 前缀 `-` / 中缀算符 —— 出处 `expr-parse.lua:19-96`）；
- 组合规则：`formula` 只出现在**字符串参数位置**（gsl-shell 的公式是写在字符串里的 DSL，
  由 `gdt` 那一族函数解析），所以它与 Lua 的节点表**不冲突** —— 这正是"扩展语法"该有的接法：
  加节点、加洞的类别，不改 Lua 那 22 个节点的任何一条规则。

## 9. 判据（这份设计成不成，用什么衡量）

1. **规则条数 vs 组合数**：Lua 那 22 个节点 + 6 类洞 + 4 条元数规则 + 5 条作用域规则，
   要能覆盖生成器枚举出的**全部**组合；例外清单越短越好（目标：≤ 5 条，`repeat…until` 是其中一条）。
2. **加一门语言 = 加一张增量表**：gsl-shell 的接入不改 Lua 的任何一条规则（只加）。
3. **两条腿**：`run`（解释）与 `run-jit`/`emit` 至少一条编译腿，同一份源码同一结果。
4. **例子全生成**：`ext/lua/tests` 里没有手写的用例清单。
