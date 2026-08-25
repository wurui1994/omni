# 自举子集白名单（bootstrap subset）

**注意**：ADR-0001 之后，自举路径**不再是**"用 Omni 语法重写编译器"，编译器源码留在 JS。
所以真正卡自举的闸门是 `docs/js-bootstrap-subset.md`（编译器源码能用哪些 JS 特性），
不是本文件。本文件降级为"**用 Omni 写程序**时语言能力的边界"，仍然是语言演进的闸门
（往里加特性要走 ADR），但它不再决定什么时候能自举。

stage0 的能力边界与本文件一致，P3 冻结后不再扩展。

## 现状（MVP-1 已跑通，js/c 双后端差分全绿）

- 类型：`int`(i64)、`real`(f64)、`bool`、`string`、`void`、`struct`（值语义、可嵌套）
- 声明：函数（可重载、默认实参、命名实参）、`struct`、局部变量（一行多个声明符）
- 语句：`if/else`、`while`、`for`、`return`、`break`、`continue`、块、表达式语句
- 表达式：全套算术/比较/逻辑/位运算、`?:`、赋值与复合赋值、`++`/`--`（仅语句位置）、
  成员访问、函数调用、字符串 `+` 拼接
- 调用特性：重载解析（隐式转换代价择优 + 歧义报错）、默认实参、命名实参、**UFCS**
- 隐式转换：仅 `int -> real` 一条边
- 内建函数：`print`、`int()`、`real()`、`string()`
- 顶层语句自动归入合成的 `main`

## MVP-2（顺序与设计依据见 `docs/adr/0006-values-containers-class.md` 第 9 节）

1. `list<T>`：索引 + 边界检查 + **迭代协议** `for (x in c)`
2. `dict<K,V>`（**插入序**，否则 JSON 序列化在两后端不一致）+ `string` API
3. `dynamic` 值表示 + **原生 json**（解析/序列化，复用 1、2）
4. `class`（引用语义 + ARC）+ 方法降级为「第一参数为 this 的自由函数」+ UFCS 合并重载集
5. `set<T>`（复用 dict 索引，无字面量语法）
6. tagged union（ADR-0012：`enum` + `match`）+ 模块系统 `import` / `access` / `unravel`
7. 闭包 / 函数值

容器一律先做**编译器内建参数化**，用户自定义泛型推到 comptime 参数化之后。

## 明确不进自举子集（stage1 不用，留给 stage1 之后的语言演进）

- `reactor` / reactive 依赖图
- `dylayout` 动态二进制布局
- regex switch / 内建 lexer 生成器
- 多重继承、属性、`disposable`
- SIMD / kernel / GPU 相关
- comptime 元编程（stage1 自己不用，但 stage1 要**实现**它）

理由：这些特性的价值在于「用 Omni 写应用」，而不是「用 Omni 写编译器」。混进自举路径只会
延长到达不动点的时间。
