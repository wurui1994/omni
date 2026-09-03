# ADR-0012：tagged union（`enum`）与 `match`

状态：已落地 · 日期：2026-08-26 · 相关：ADR-0005（值语义）、ADR-0006（容器与 class）、
ADR-0008（可选类型与三模式）、ADR-0009（模块与可见性）

## 为什么现在做

PLAN 的「接下来」把它排在 ARC 之前，理由是**异质记录的底座**。在它之前，"这个值可能是
A 也可能是 B" 只有两条路：塞进 `dynamic`（丢掉静态类型，且值域被限死在 JSON 那七种），
或者用一个带 `int kind` 字段的 struct 手工维护"哪些字段此刻有效"（编译器帮不上任何忙）。
两条都不行，所以语言必须自己有一个带标签的和类型。

顺带解决的一件事：ADR-0008 第 4 节写死了"**不做联合类型**（`list<int|string>`）"，
理由之一是"按元素带标签等于把 tagged union 提前塞进容器"。现在 tagged union 有了名字、
有了声明位置，那条理由仍然成立 —— 用户想要异质就显式声明一个 `enum`，而不是让类型
推断替他造一个匿名的和类型。

## 决策

### 1. 一个关键字 `enum`，载荷可选

```
enum Shape {
  Circle(real r),
  Rect(real w, real h),
  Empty,
}
```

无载荷的变体退化成 C 风格枚举（`enum Color { Red, Green, Blue }`），所以不需要第二个
关键字。**`union` 被留给将来那个与 C ABI 兼容的无标签 union**（Jancy 的 FFI 需要它）——
如果现在用 `union` 表示"带标签"，那个词就废了。

载荷是**具名字段**而不是位置元组（`Circle(real r)` 而不是 `Circle(real)`）。位置元组
写起来短，但 `case Circle(x)` 里的 `x` 就再没有任何东西能说明它是什么；具名之后，
将来加 `Shape.Circle(r: 1.0)` 这类构造也不用改语法。

### 2. 变体名**不进作用域**，只能写 `类型.变体`

`Shape.Circle(2.0)` / `Shape.Empty`。不做 Rust 的 `use Shape::*`，也不做 Asymptote
`unravel` 那种把成员灌进当前作用域的动作。

理由是名字污染的代价不对称：`Empty` / `Node` / `Red` 都是普通词，一旦变体名进了作用域，
它们就和函数名、变量名抢同一张表 —— 而且抢的时机是"某个模块加了一个变体"，导入方的
源码里一个字都没动。ADR-0009 已经为模块名字定了同样的调子（不做隐式注入），这里保持一致。

代价是啰嗦。可接受：读的人不用回头找 `Circle` 是哪个类型的。

一个例外要写清楚：`Shape.Circle` 里的 `Shape` 只在**当前作用域没有同名变量**时才被
当作类型名。局部变量优先遮蔽类型名，否则一个叫 `Shape` 的局部量会突然改变旁边那行的含义。

### 3. 解构只有 `match` 一条路，并且**必须穷尽**

```
match (s) {
  case Circle(r): return 3.0 * r * r;
  case Rect(w, h): return w * h;
  case Empty: return 0.0;
}
```

- 覆盖不全且没有 `default` 是**编译错误**，错误消息里列出漏掉的变体。加一个变体就让
  所有不完整的 `match` 亮起来 —— 这是和类型最主要的收益，放弃它就只剩语法糖。
- 重复的 `case`、不存在的变体、绑定个数与载荷不符，都是编译错误。
- 绑定名可以与载荷字段名不同（`case Leaf(pt, col)`），作用域是这一个分支。
- **没有 fallthrough**。一个分支的语句收到下一个 `case` / `default` / `}` 为止，
  不需要 `break` 收尾。

**不提供 `s.tag` / `s is Circle` / 载荷的直接读取**。只有 `match` 能拿到载荷，
所以"读了错误变体的载荷"这件事在语言层面不存在，不需要运行期检查，也就没有对应的开销。

### 4. `match` 在检查器里就降级成 `if / else if` 链

后端完全不认识 `match`：`src/core/hir/check.js` 的 `matchStmt()` 直接产出
`Local`（主语只求值一次）+ 一串 `If`，两个后端只多认三个表达式节点
（`MakeEnum` / `EnumTag` / `EnumPayload`）与一个零值节点（`ZeroEnum`）。

**刻意不生成 C 的 `switch`**：那样分支里的 `break` 会被 switch 接住，而 Omni 的 `break`
只有一个意思 —— 跳出最近的循环。用 if 链之后这条性质自动成立，不需要在两个后端各写一遍
"这个 break 是给谁的"。代价是密集整数标签上少了跳转表；标签是连续的小整数，
`-O2` 下 clang 自己会把 if 链认回 switch。

主语的临时槽名字以数字开头（`0match`，生成出来是 `v_0match`）。Omni 的标识符不能以数字
开头，所以这个槽在生成的 C/JS 里不可能与用户变量撞名 —— 于是不需要 gensym 表，也不会
意外遮蔽分支体里引用的外层名字。

### 5. 值语义，载荷按值内联；**按值绕回自己是错误**

`enum` 和 `struct` 一样是值类型（ADR-0005）：赋值/传参/返回都拷贝。

- C 侧：`struct { int64_t tag; union { struct {...} v_Circle; ... } u; }`。
  `tag` 用 `int64_t` 而不是 `int`，因为 `EnumTag` 在 OIR 里的类型就是 `int`（= i64），
  比较不需要任何转换。无载荷的变体不进 union（C99 没有空结构体）；全都无载荷时连 union
  都不发。构造走一个个生成的 `omni_mk_E_<类型>_<变体>()` 函数，而不是复合字面量 +
  指定初始化 —— 后者在 `-Wextra` 下会为 union 里没提到的成员报一片
  missing-field-initializers。
- JS 侧：一个扁平对象 `{ $t: 0n, r: 2.0 }`。`$t` 与 C 的 `tag` 是同一个值域（BigInt）。
  载荷字段摊在同一层是安全的：同一时刻只有一个变体活着，两个变体的同名字段不会同时存在。
  值语义的拷贝 `$cp_E<类型>` 要先看 `$t` 才知道有哪些字段要拷。
- **`enum List { Cons(int, List), Nil }` 是编译错误**：载荷内联在 union 里，大小无解。
  报的是一条诊断（含整条名字链），不是编译器崩溃 —— C 后端的拓扑排序遇到环会 `throw`，
  所以检查器必须先拦。struct 字段可以是 enum、enum 载荷可以是 struct，所以环的检测和
  C 后端的拓扑排序都是**两种聚合体一起做**的。
  递归数据结构等指针（ADR-0006 记在案，排在自举之后）。

### 6. 零值 = 第一个变体

`Shape s;` 得到 `Circle(0.0)`。不造一个"invalid / uninitialized"标签：那会让每一个
`match` 都要处理一个源码里根本不存在的状态，穷尽性检查也就跟着变成噪音。

代价是"第一个变体"成了声明顺序的一部分。可接受，而且这本来就是标签值的来源
（变体下标 = 运行期标签，声明顺序决定，不依赖任何哈希）。

## 明确不做（现在）

- **`match` 作为表达式**（`int n = match (s) { ... }`）。语句形态先落地，表达式形态要先
  决定"每个分支的类型怎么统一"，那是 ADR-0006 那张转换图上的另一个问题。
- **`==` 比较两个 enum 值**。逐变体比载荷是可以生成的，但要先回答"载荷里有容器时比什么"
  （引用还是内容），而 ADR-0006 对容器相等本来就还没定调。
- **`print(enum)` / 装箱进 `dynamic`**。dynamic 的值域是 JSON 的七种标签（ADR-0008），
  没有"带标签的用户类型"这一种。要打印就在 `match` 里自己拼字符串。
- **载荷的模式嵌套**（`case Circle(Point(x, y))`）、守卫（`case x if cond`）、
  `_` 占位符。都属于模式匹配的第二层，等有真实需求。
- **变体上的方法**。方法是"第一参数为 this 的自由函数"（ADR-0006 第 5 节），所以
  `real area(Shape s)` 加上 UFCS 已经能写 `s.area()`，不需要新机制。

## 落地情况

- `src/core/parse/lexer.js`：关键字 `enum` / `match` / `case` / `default`。
- `src/core/parse/parser.js`：`parseEnum()` / `parseMatch()` / `parseCaseBody()`；
  `enum` 名进预扫描表（前向引用的类型也能识别）；`private enum` 进 `CAN_HIDE`。
- `src/core/hir/types.js`：`enumType()`、`typeKey` 用 `E<名>`、`cTypeName` 用
  `e_<名>`、零值 `ZeroEnum`。
- `src/core/hir/check.js`：变体与载荷解析、按值环检测（`valueCycle`）、
  `enumRef()` / `makeEnum()`（构造）、`matchStmt()`（降级成 if 链 + 穷尽性检查）。
- `src/core/backend-js/emit.js`：`$new_E*` / `$cp_E*`，`MakeEnum` / `EnumTag` /
  `EnumPayload`，形参与左值的按值拷贝。
- `src/core/backend-c/emit.js`：`sortAggregates()`（struct 与 enum 同一张拓扑序）、
  `enumBody()` / `enumNew()` / `enumMakers()`。
- 测试：`tests/cases/25_enum.omni`（js==c 差分：载荷含 struct/容器/另一个 enum、
  值语义、零值、`break` 不被 match 吃掉、变体里的容器仍是引用语义）、
  `tests/errors/enum_rules.omni`（13 条诊断，上面每条规矩都在里面）。
- 自举顺带逮到一件事：检查器的方法本来叫 `match`，而 JS 自举子集里 `x.match(...)`
  是"字符串的正则匹配"那个方法（`frontend-js` 只认正则字面量实参），于是 C1 生成不出来。
  改名 `matchStmt` —— 这正是第三条测试轴该起的作用。
