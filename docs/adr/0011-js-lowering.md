# ADR-0011：JS AST → OIR 的降级策略

状态：进行中（2026-08-25）· 相关：ADR-0001（自举）、ADR-0006（值域）、ADR-0007（错误模型）、
ADR-0008（可选类型与模式）、ADR-0010（函数值）

## 背景

ADR-0001 定的自举路线是：C0（node 上的 JS 编译器）用**自己的 JS 前端**读自己的源码，走 C
后端产出 C1，C1 再产出 C2，判据是 C1 与 C2 的 C 逐字节相同。前端（词法/语法/生成）已经落地
并被第三条测试轴钉住；缺的是**降级**：把 JS AST 变成 OIR。

先把工作量数清楚，不靠感觉。用我们自己的前端解析 `stage0/src` 全部 15 个文件，AST 里出现的
节点种类与数量：

- 表达式主体：`Ident` 8653、`Member` 5222、`Call` 2576、`Str` 2481、`This` 2022、`Binary` 781、
  `Template` 466、`Num` 458、`Object` 423、`Logical` 354、`Assign` 259、`Array` 231、
  `Cond` 157、`Arrow` 151、`Update` 128、`New` 101
- 语句：`ExprStmt` 1322、`Return` 877、`VarDecl` 823、`Block` 821、`If` 712、`Break` 82、
  `ForOf` 81、`FuncDecl` 67、`Continue` 65、`While` 50、`Switch` 37、`For` 21、`DoWhile` 1
- 需要专门决定的：`Regex` 41、`Throw` 39、`ClassDecl` 13、`Try` 7、`BigIntLit` 25、
  `Spread` 26、`ObjectPattern` 21、`ArrayPattern` 4、`ImportMeta` 2
- 宿主全局：`process`、`Map`（19 个 `new Map`）、`Set`（30 个 `new Set`）、`Error`（24 个
  `new Error` + 3 个 `extends Error` 的子类）、`String`、`Number`、`Math`、`JSON`、`Object`、
  `parseInt`、`Infinity`，以及 `node:fs / path / url / child_process / os / crypto`

## 决策

### 1. JS 的每个值都是 `dynamic`，不给 JS 做类型推断

对象 → `dict<string, dynamic>`，数组 → `list<dynamic>`，函数 → 函数值（`dynamic` 新增一个
函数标签），数字见第 5 条。

ADR-0008 已经写死"JS 子集里未标注类型的变量 = `dynamic`"。反过来做（给 JS 源码推断静态
类型）等于在 Omni 的类型系统旁边再写一个 JS 的类型系统，而且会在第一个异质对象上失败 ——
AST 节点就是异质记录。慢是预期的，**自举的判据是不动点，不是速度**；等不动点成立之后，
再用 OIR 上的 pass 把能定型的地方定型（那是 P2 的内容）。

### 2. 宿主库不在 Omni 里重写，而是一份**封闭的 Builtin ABI**

`xs.map(f)`、`s.replace(re, f)`、`new Map()` 这些不降级成 Omni 源码，而是降级成 OIR 的
`Builtin` 节点（`js_*` 一族 op）。每个 op 在两侧各实现一次：JS 后端映射到**原生 JS**，
C 后端映射到运行时 C。

三个理由：

- **JS 后端是永久兼容层（ADR-0001 第 2 节）**。把 `Array.prototype.map` 用 Omni 重写一遍，
  再生成回 JS，等于让 JS 路径绕开 V8 的原生实现 —— 又慢又容易在边角行为上和原生分叉。
- **封闭清单本身就是验收单**。"还差什么"变成一张能勾掉的表，而不是一句"宿主库还没做完"。
- **两侧行为差异有地方对齐**：每个 op 都能写 oracle 用例（omni-js vs omni-c vs node）。

代价：C 侧要把这批语义真写一遍（含正则引擎）。这是自举的必要成本，躲不掉 —— 原生编译器
不可能靠 V8 提供 `Array.prototype.sort`。

### 3. `throw` / `try` 降级成静态控制流，不用宿主异常

落实 ADR-0007 决定 1。做法：

- 一个模块级的**待决错误槽**（`dynamic`）。`throw e` = 写槽 + 立刻 `return`（返回该函数的零值）。
- 每个**可能抛**的调用之后插一次检查：错误槽非空就继续 `return`。可能抛是编译期谓词，
  按调用图传播（Jancy 的 `canStaticThrow()` 是同一手法）。
- `try { A } catch (e) { B }`：A 里的检查点跳到 handler 而不是 `return`；handler 清槽、
  把值绑给 `e`，然后跑 B。`finally` 在两条出口上各生成一份。

不用 JS 的 `throw` 是刻意的：那会让"错误"的行为依赖宿主（栈、`instanceof`、
`Error.prototype.stack`），C 侧根本没有对应物，两个后端立刻分叉。

`extends Error` 的三个子类（`OmniError`、`ResolveError`、`ExitSignal`）降级成带 `name` 字段
的普通对象，`e instanceof OmniError` 降级成比较那个字段 —— 源码里的 `instanceof` 只用来分
辨这几个类，不需要真原型链。

### 4. JS 的怪语义只出现在降级里，不进 Omni 语言

`if (x)` 的 truthiness、`+` 的"数字加还是字符串拼"、`==` 的强制转换、`undefined` 与 `null`
的区分 —— 这些是**JS 前端的语义**，降级时显式发射成 `js_truthy(x)` / `js_add(a, b)` 这类
op。ADR-0008 第 5 节拒绝的是"Omni 的 `if (dynamic)` 引入 truthiness"，那条不变：Omni 源码
里 `if (d)` 仍然要求标签是 bool。同一个 `dynamic` 值域，两套运算规则，规则写在降级里而不是
写在值域里。

### 5. 数字：`number` → `real`，`BigInt` → `int`

编译器源码里 BigInt 就是拿来表示 i64 的（`BigInt.asIntN(64)` 到处都是），`number` 才是浮点。
所以这个映射不是近似，而是**恢复源码的本意**。代价：JS 里 `BigInt` 是任意精度，Omni 的
`int` 是 i64 —— 只要源码不依赖超出 i64 的中间值就等价，而它不依赖（它本来就在模拟 i64）。

数组下标、`length` 这类 `number` 出现在整数位置的地方，降级时按 `real` 处理再取整，语义与
JS 一致（JS 自己也是 f64 下标）。

### 6. `new Function(code)()` 是一个 op，不是 eval

`cli.js` 与 `repl.js` 用它在进程内跑生成的 JS。这是"在 JS 后端上执行"这件事本身，不是通用
eval。降级成 `js_run_module(code)`：JS 后端 = `new Function(code)()`，C 后端 = 写临时文件
+ 起 `node`。两边都诚实 —— 原生编译器要"在 JS 后端上跑"，本来就需要一个 node。

### 7. class 降级成"对象 + 闭包方法"

13 个 `class` 声明。实例是 `dict<string, dynamic>`，方法是闭包，构造函数把方法塞进对象。
不做原型链、不做共享方法表：源码里没有原型操作，也没有 `super` 调用（`extends` 只出现在
三个 Error 子类上，见第 3 条）。方法里的 `this` 是显式捕获的那个对象。

代价：每个实例都持有自己的方法闭包（内存换简单）。`new Scope()` 这类高频构造会因此变重，
等不动点成立后再用共享方法表优化。

### 8. JS 的 string 是 **UTF-16 码元序列**，不是 Omni 的 UTF-8 字节串

这条是在盘宿主 ABI 时发现的，而且是必须的，不是洁癖。

Omni 的 `string` 按 UTF-8 字节索引（ADR-0005）；JS 的 `String` 按 UTF-16 码元索引。
`.length`、`charCodeAt`、`slice`、`indexOf` 全都是码元口径。词法器就是靠下标切源码的，
而**编译器自己的源码里满是中文注释** —— 一个汉字是 3 个 UTF-8 字节、1 个 UTF-16 码元。
两个口径下 `lexer` 对同一个文件切出的 token 位置不同，C1 与 node 直接分叉，谈不上不动点。

所以 JS 降级出来的字符串不复用 `omni_str`，而是一个独立的运行时类型：`omni_js_str16`
（长度 + `uint16_t*`）。字面量在降级时就从源文件的 UTF-8 转成 UTF-16 存进常量表；只有在
真的要和外界打交道时（写文件、`print`）才转回 UTF-8。

代价：C 侧多一套字符串实现，而且每次 IO 都要转码。**接受** —— 这是"JS 语义"的一部分，
不是可以省的开销。反过来说也划得来：`charCodeAt` / `slice` 变成 O(1) 的定长索引，
比在 UTF-8 上模拟码元下标要快也要简单。

`js_*` 的字符串 op 一律收发 `omni_js_str16`；`omni_str` 只出现在 `js_str` 之外的、
Omni 自己的那半个世界里。两者之间只有两个显式的转换 op：`js_str16_of_utf8` /
`js_str16_to_utf8`。

## 落地顺序

1. `dynamic` 扩成完整 JS 值域：函数标签 + 动态调用（实参个数运行期检查）+ `js_*` 运算 op
2. 宿主 ABI 第一批：Array / String / Map / Set / Object / JSON / Number / Math
3. C 侧正则引擎（`test` / `exec` / `replace` 带回调）
4. node 宿主面：fs / path / process / child_process / url
5. `throw` / `try` 的静态降级
6. `lower.js`：45 种节点全部降级
7. C0 → C1 → C2，验不动点，并入测试轴

每一步的出口条件与既有规矩一致：js/c 双后端差分全绿 + oracle（对照 node）+ 快照更新。

## 已知风险

- **正则**是最大的一块未知：41 个字面量用到哪些特性要逐个核对，C 侧引擎的行为必须和 V8 在
  这些用法上一致（不是"实现一个正则引擎"，是"在这 41 个用法上等价"）。
- **`sort` 的稳定性与比较器语义**、**Map/Set 的迭代序**、**`toString`/数字格式化**这些细节
  是不动点的常见杀手：两次产出的 C 只要有一个字节不同就算没自举。
- 全 `dynamic` 会让 C1 明显慢于 C0（每个字段访问都是一次 dict 查找）。**接受**：先不动点，
  再优化。
