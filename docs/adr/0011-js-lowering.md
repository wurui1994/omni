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

### 9. 成员访问按**接收者标签**在运行期派发，派发器由表生成

`x.length`、`x.push(v)`、`m.has(k)` 的接收者是什么，静态不知道 —— 编译器源码是无标注的
JS。所以 `hir/js_abi.js` 里多两张表（`JS_PROPS` / `JS_METHODS`）：成员名 -> 每个标签用哪个
op。两个后端各自**生成**一个按标签 switch 的派发函数（`js_p_<名>` / `js_m_<名>`），
发射器里不出现任何成员名，加一个成员还是只改表。

三个连带的决定：

- **Map / Set 的 DYN 标签必须和普通对象分开。** 三样的底子都是 `dict<string, dynamic>`，
  标签一样 `o.has(k)` 就没法派发。往字典里塞隐藏标记键的做法否掉了：
  `keys()/values()/entries()/size` 全都要绕开它，迭代序也会被污染。于是
  `OMNI_DYN_MAP` / `OMNI_DYN_SET`（载荷仍是同一个 dict 指针），JS 侧对应
  `class $JsMap extends Map` / `class $JsSet extends Map`。可见行为三样一致：
  `typeof` 是 `"object"`、真假为真、相等按引用；`JSON.stringify` 对 Map/Set 给 `"{}"`。
- **派发器的形参个数取各分支里最多的那个**，缺席的实参由 lower.js 补 `js_undef`，
  每个分支只吃自己需要的前几个（`indexOf` 在 string 上带 `from`，在 list 上不带）。
  返回类型也从分支取，同名分支必须一致 —— 表写错了在 `js_abi.js` 里就炸。
- **表外的接收者走 default 分支的兜底**（见决策 12），也是将来类实例方法表
  （落地顺序 6c）接进来的位置。

### 10. 正则不是值：`/re/` 只能出现在使用点上

量过：全仓库只有 `frontend-js/gen.js:83` 一处把正则存进变量（`IDENT_KEY`），
用法全是 `IDENT_KEY.test(x)`。所以不给 dynamic 加 RegExp 标签，也不做 RegExp 对象：
lower.js 把**初始化式是正则字面量的 const 当编译期常量**传播到使用点，
`.test` / `replace` / `match` / `split` 那四个位置直接发 `js_re_*`（模式与 flags 是
普通的字符串实参，两侧按内容缓存已编译的正则）。正则值逃出这四种位置 —— 传参、
进容器、当返回值 —— 一律编译期报错，而不是悄悄换一种语义。

### 11. 被捕获的局部量一律装 cell

JS 的闭包按**引用**捕获，OIR 的闭包按**值**捕获（ADR-0010，为的是 C 与 JS 两侧给同一个
答案）。差别补法只有两种：做一遍"闭包里有没有写它"的分析，或者把被捕获的变量统一装进
一个单元素数组（cell），捕获这个数组的引用。选后者：

- 判据只有一条 —— **有内层函数提到过这个名字**（`refNames` 是过度估计的：属性名、模式里
  的名字都算）。多装一个 cell 只是多一层下标，少装就是错的语义，所以宁可多装。
- 读是 `js_arr_get(cell, 0)`，写是 `js_idx_set(cell, 0, v)`（这个 op 的值就是刚写进去的
  那个，赋值表达式的语义正好对上）。捕获项在闭包记录里的类型永远是 `dynamic`。
- 捕获是**一级一级传**的：内层闭包捕获的名字，中间那层自己也得捕获才能传下去。
- 声明分两步发（`let f = [undefined]; f[0] = 初始化式`），所以 `const f = n => f(n-1)`
  这种自递归的箭头、以及嵌套函数声明的互相递归，都不需要特别对待。
- **`for (let i = …)` 的循环变量被闭包捕获时当场报错**：JS 那里每轮是一个新绑定，而这里
  只有一个 cell。要么把它拷进循环体里的 `const`，要么用 `for-of`（`for-of` 的循环变量本来
  就声明在体内，每轮一个新 cell，捕获是安全的）。
- 具名函数表达式引用自己的名字也报错（那个名字只在体内可见，而捕获表要等体降完才知道）。

### 12. 成员派发的 default 分支是"取属性再当函数调"

对象字面量里放函数是常见写法（`{ get: () => cur }`），而 `get` / `set` / `has` / `keys`
这些名字同时又在 Map/Set 的表里。所以派发器的 default 分支不报错，而是退回 JS 本来的语义：
属性访问就是 `js_obj_get`，方法调用就是"取属性、再当函数调"。

一个连带的规矩：派发器的形参个数是表里的最大值，所以兜底调用前要**削掉末尾的
`undefined`** —— `box.get()` 经过 `js_m_get(r, a0)` 之后不能变成 `get(undefined)`，
否则 `(...xs) => xs.length` 两边就不一样。C 侧 `omni_js_call_n`，JS 侧 `$js_call_n`。

### 13. 类降成"造实例的函数"：实例是普通对象，方法是每实例一份的闭包

量过：编译器源码里 14 个类（`Lexer` / `Parser` / `Checker` / 两个发射器 / `Scope` /
`Diagnostics` / `Session` …），每个类的实例只有 1~6 个，`static` 成员 0 处，`extends`
只出现在三个 `Error` 子类上。所以不给 dynamic 加"实例"标签、也不给 `js_obj_*` 家族加
分支，而是：

- `class C { constructor(…){…} m(…){…} }` 降成一个普通函数 `n_C(args)`：先
  `js_obj_new()`，再把每个方法当闭包 `js_obj_set` 进去，然后跑构造器体，最后返回实例。
- `this` 就是构造器栈帧里的一个 cell（决策 11），方法闭包捕获它。所以 `o.m()` 不需要
  "传接收者"这回事 —— 走成员派发的兜底（决策 12）取出闭包直接调即可。
- 代价是每个实例带 N 个闭包（宿主那边方法在原型上共享）。以实例数量看这点开销无关紧要，
  换来的是一条新路都不用开。
- 一个有意的偏差：方法是**绑好的**，`const f = o.m; f()` 在这里能用，在宿主上会丢
  `this`。丢 `this` 本来就是坏写法，不作为兼容目标（测试里也不写）。
- `static` / 类字段 / getter-setter / 计算方法名 / 类当值用 一律当场报错。5 处 getter
  改成方法（`d.hasErrors` -> `d.hasErrors()`），属于"把编译器源码改到封闭 ABI 上"那步。
- `extends` 与 `instanceof` 留给落地顺序 6d：量过它们只服务于异常路由。

### 14. throw 的传播：一个 pending 槽 + 每句之后查一下，一级一级退

C 里没有异常，两个后端又必须给同一个答案，所以沿用 ADR-0007 决定 1 的槽：`js_throw`
往里放，`js_pending` 查，`js_take_pending` 取出并清空。跳转全是 lower.js 发的普通控制流：

- **可能抛的子表达式先算进临时量**，紧跟一次 `if (js_pending()) …`。图的是精确：
  `console.log(f())` 里 f 抛了，`println` 就不该再跑。判定"可能抛"看降完的 OIR 里有没有
  `Call` / `CallFn` / `js_m_*`（派发器的兜底会调用户函数）/ 表里标了 `throws` 的 op
  （回调类的、会抛的宿主调用）。
- **惰性位置**（`&&` 的右边、`?:` 的分支、循环条件与 for 的 update）提不出来，那里保持
  内联：抛出来的表达式值是 undefined，靠语句末尾那次检查退出去。循环条件抛的情况正好
  自洽 —— 条件成了假、循环退出、循环后面那次检查接住。
- **退出的方式**：在 try 体里是 `Break`（try 体本身摊成一个只跑一遍的 `while (true)`，
  Break 正好落到 catch 前面），不在 try 体里是 `Return`。循环里的 Break 只退一层，
  循环语句后面还有一次检查 —— 一级一级地退，只用 Break 就够，不需要 goto 或标号。
- `try { A } catch (e) { B }` 就是：`while(true){ A; break; }` 之后
  `if (js_pending()) { e = js_take_pending(); B }`。`catch` 不绑名字也要取一次（不取的话
  下一次检查会把同一个错误再抛一遍）。
- **不支持 `finally`**（量过：全仓库 1 处，在 repl 里），也**不许 break/continue 跨过 try
  的边界** —— 它们会被那层合成的循环接住，语义就变了。两种都是当场报错。

### 15. 异常对象就是普通对象：`{ $cls: [类名…], message }`

`new Error(m)` 造的是 `{ $cls: ["Error"], message: m }`；`class X extends Error {}` 造的是
`{ $cls: ["X", "Error"], message }`。`x instanceof C` 就是查 `$cls` 链（`js_is_a`），
被抛出来的东西可能是任何值（字符串也行），所以不认的一律 false，不报错。

- `extends` **只允许 `extends Error`**（量过：全仓库三处，全是异常类），`instanceof` 也只
  对 Error 与它的子类有意义，别的当场报错。
- `super(msg)` 的作用就是把 `message` 填上；不写构造器时，第一个实参就是 message。
- 与宿主的两处偏差，都不作为兼容目标：宿主的 `message` / `name` 是不可枚举的，所以
  `JSON.stringify(err)` 在那边是 `"{}"`、`String(err)` 是 `"Error: m"`；这边分别是把
  `$cls` / `message` 也打出来、和普通对象一样。异常对象不进 JSON、也不靠 `String()` 打印。

### 16. 模块在降级之前就链接掉（不给 OIR 加模块）

两个后端都只发**一个编译单元**（一个 `.c` / 一个 `.mjs`），而 ESM 在这一层的语义只是
"哪个名字来自哪个文件"。所以 `frontend-js/link.js` 在 parse 之后、lower 之前把整棵
import 树拼成一个 `Program`：后序遍历（依赖排在前面）、拆掉 import/export 的外壳、
`import { a as b }` 摊成模块级的 `const b = a;`。lower.js 因此完全不知道模块这回事
（它见到 `import` 仍然报错，那是安全网）。

- **模块级的名字跨文件重名就报错**：拼在一起之后它们本来就是同一个作用域。带作用域的
  重写要多做一遍完整的名字解析，而改源码只是一次性的事 —— 量过：整个编译器
  （入口 `cli.js`，13 个模块、125 条顶层语句）只有 1 处重名。
- 默认导入 / `* as` / `export default` / `export … from …` / 循环导入：一律报错。
  量过：仓库里一处都没有（循环导入也没有）。
- `node:*` 的导入报错，让它去走封闭 ABI。量过：12 处，都在"把编译器源码改到封闭 ABI 上"
  那步里换掉。

### 17. 宿主原生面是一个"不被链接进来的模块"

编译器源码今天要能被 node 直接跑，明天要能被降级 —— 所以宿主调用不能写成
`import { readFileSync } from 'node:fs'`（降级那边没有 node），也不能只写在 ABI 里
（node 那边没有 op）。做法是一个特别的模块 `src/host/native.js`：

- 它导出的每个名字在 `link.js` 的 `NATIVE_OPS` 表里对应一个 ABI op。链接器见到从这个
  文件的导入，**不加载、不拼进程序**，只登记"名字 -> op"，交给 lower.js 当调用降下去。
- node 上跑的就是 native.js 里那份用 `process.getBuiltinModule` 写的实现。于是同一语义
  有三份实现（native.js / prelude.js 的 `$js_*` / runtime 的 C），第五条测试轴
  （`tests/js-exec/cases/11-host-native.js`）逼它们三份逐字节一致。
- 这些名字**只能被调用**，当值用当场报错 —— 它们不是函数值，是 op。
- 判据只有一条：真的要问操作系统才进这个文件。路径计算（`host/path.js`）与 sha256
  是纯计算，写成普通模块，链接器照常拼进来。

### 18. 自举把值域钉死的几条（第 7 步量出来的）

C0 → C1 → C2 走通之前，编译器自己的源码里有一批"JS 能跑、这个值域里不成立"的写法。
它们不是降级器的缺口，是**语言的边界**，所以改的是源码，不是降级器：

- **list 带不了属性**。`tokens.hashbang = h` 这类"顺手挂一个字段"要改成返回
  `{ tokens, hashbang }`。同理 `xs.length = n` 不是截断而是给 list 写属性 ——
  诊断的试探性回滚因此改成 `Diagnostics.mark()` / `rollback()`（内部 pop）。
- **Map / Set 的键是值，没有对象标识**。`new Set(astNodes)` 这种靠引用去重的写法当场报错
  （`cannot use a dict as a Map/Set key`），要改成按某个标量键去重。
- **位运算只在 `int` 上**。`(lo + hi) >> 1` 里两边是 `real`，要写 `Math.floor(…/2)`。
- **`int` 是 int64**，所以源码里不能出现越界字面量，十六进制的 bigint 字面量也要换成十进制常量。
- **`BigInt(string)` 不是十进制的 `int_of_string`**：它认 `0x`/`0o`/`0b` 与正负号，
  越界要报错。两个运行时各实现了一份（`$js_str_to_int` / `js_str_to_int`）。
- **可变实参的 `push`** 定长 op 表达不了，单独给一个 `js_arr_push_all`；
  对象展开、`new Map(pairs)` / `new Set(list)` 同理各占一个 op。
- **`?.` 的短路是整条链的**：`a?.b.find(f)` 里 a 为空，`.b`、`find` 都不发生。
  判空要提到"链上剩下部分"的外面（`lower.js` 的 `onObject`），就地包住一个成员访问是错的。
- **跨文件的模块级名字在链接后共用一个作用域**（决策 16），重名是硬错 ——
  前端里的 `Parser` / `lex` / `KEYWORDS` 之类因此都带上了 `Js` 后缀。

安装布局也在这一步定下来：**std 的根是 `installDir()/../../lib`**，`installDir()` 是
程序镜像所在目录。所以换个位置放的编译器要按这个布局摆，`tests/bootstrap/run.js` 就是这么摆的。

## 落地顺序

1. `dynamic` 扩成完整 JS 值域：函数标签 + 动态调用（实参个数运行期检查）+ `js_*` 运算 op
2. 宿主 ABI 第一批：Array / String / Map / Set / Object / JSON / Number / Math
3. C 侧正则引擎（`test` / `match` / `split` / `replace`，含回调形式）
4. node 宿主面：fs / path / process / child_process / url
5. `throw` / `try` 的静态降级
6. `lower.js`：45 种节点全部降级
7. C0 → C1 → C2，验不动点，并入测试轴（`tests/bootstrap/run.js`，第六条轴）

每一步的出口条件与既有规矩一致：js/c 双后端差分全绿 + oracle（对照 node）+ 快照更新。

### throw / try 的降级形状（第 5 步）

运行时只有一个"待处理错误"的槽（`js_throw` / `js_pending` / `js_take_pending`），
跳转全是 OIR 里已有的结构化控制流 —— OIR **没有 goto/label**，只有 If / While /
Break / Continue / Return，所以形状是定下来的：

- `throw v` → `js_throw(v)` 之后立刻 `return <零值>`。
- 可能出错的调用点之后插 `if (js_pending()) { <传播> }`；函数里的传播就是 `return 零值`。
- `try { A } catch (e) { B }` → 用一次性循环当作 try 的作用域：
  `while (true) { A（每个可能出错的步骤后 break）; break; }`
  之后 `if (js_pending()) { e = js_take_pending(); B }`。
  A 里嵌套的循环要在每一层循环后补一次 `if (js_pending()) break;` —— 无标签的 break
  只跳一层。
- `finally` 放在一次性循环之后、catch 分派之前/之后按 JS 的次序排：正常边与出错边
  都会流过它。
- 未捕获：生成的 main 在入口返回后查一次，打**一行** `omni: uncaught: <值>` 到 stderr、
  退出码 70。宿主的栈回溯 C 侧打不出来，所以两侧都不打（`tests/oir` 的
  `uncaught/exit-70-and-one-line` 钉住这条）。

两处 lower.js 必须**报错而不是猜**的地方（量过：仓库里 0 处）：
- `break` / `continue` 跨过 try 边界 —— 一次性循环会把它吃掉。
- `return` 出现在带 `finally` 的 try 里 —— 一次性循环拦不住 return，finally 会被跳过。

## 已量过的宿主面

盘过一遍才发现几处必须改设计的地方，记在这里免得下一刀又按猜的做：

- **`startsWith` 有两实参形式**（`src.startsWith(op, i)`，两个词法器的标点匹配都用它，在热
  路径上）。ABI 里 `js_str_starts_with` 因此收三个参数，不是两个。
- **有两张 Map 用数字键**：`Map<number, Set<number>>`，模块 id -> 它导入的模块 id
  （`module/load.js` 与 `hir/check.js` 各一处）。其余 Map 全是字符串键，没有对象键，
  没有 `WeakMap`/`WeakSet`。所以 Map 不能直接摊成 `dict<string, dynamic>` —— 键要先
  规范化成带标签的字符串（`n:1` / `s:foo`），并且把原键存下来供 `.keys()` 返回。
- **`substring` / `substr` / `replaceAll` / `trimStart` 一次都没用**，不进 ABI。
- **`replace` 的模式全是正则**，没有一次是字符串；替换串里**没有任何 `$1`**；只有两处用
  回调（都是 `gm` + 一个捕获组）。`split` 只有一处用正则（还带 limit=2，在 REPL 里）。
- **字符串负下标只有三处**，都是 `op.slice(0, -1)`（把复合赋值的 `=` 削掉）。

碰容器的 op（`split` / `join` / `Object.keys` / 数组那一批）**不能放在运行时的 .c 里**：
`list<dynamic>` 与 `dict<string, dynamic>` 是生成 TU 里的宏实例，运行时的翻译单元看不见
它们。这批只能像 `omni_dyn_bridge.h` 那样长在宏里，在生成的文件里展开。

### node 宿主面（量完之后的四个决定）

编译器自己只有 6 个文件碰宿主（`cli.js` / `repl.js` / `module/load.js` /
`runtime/c_runtime.js` / `backend-c/emit.js` / `source/diag.js`），量完得出四条：

- **`path` 与 `crypto` 不进 ABI**。`join`/`dirname`/`basename`/`resolve`/`relative`/
  `isAbsolute` 是纯字符串计算，sha256 也是纯计算；写在编译器自己的源码里
  （`stage0/src/host/path.js`）两个后端一起用，进 ABI 反而多出一处"宿主实现与我的实现
  是否逐字符一致"的分叉点。ABI 里只留真的要问操作系统的 `cwd`。
- **`readline` 换成阻塞读**。`rl.on('line')` 是全编译器唯一的事件驱动 API，C 侧没有
  对应物；`js_proc_read_line()` 读一行、EOF 返回 `undefined`，两侧都成立，REPL 的驱动
  改成 while 循环。
- **`spawnSync` 的结果是三元数组 `[status, stdout, stderr]`**，mode 只有量出来的三种：
  `'c'` 全捕获 / `'o'` stdout 直通 / `'i'` 全直通。
- **`import.meta.url` 换成 `js_install_dir()`**："运行中的程序镜像所在目录"，JS 侧是
  `dirname(process.argv[1])`，C 侧是 `dirname(argv[0])`（刻意不过 realpath —— node 不解
  符号链接，解了就会在 `/var` 与 `/private/var` 上分叉）。从这个目录怎么走到 `runtime/`
  与 `lib/` 是调用方的事：C0 是 `stage0/src` 下的脚本，C1 是一个可执行文件，两代的布局
  本来就不同，得靠往上找 `runtime/omni.h` 来定位，不能写死相对层数。
- **`new Function(code)()` 没有 C 侧对应物**（`omni run` 的 JS 快路径）。原生编译器上的
  `omni run` 只能走"编成 C 再执行"那条路，这条快路径要挂在能力检查后面。
  顺带：prelude 里因此不能出现 `import` —— 它整段也会被 `new Function` 吃进去，
  宿主模块一律走 `process.getBuiltinModule`。

## 已知风险

- **正则**原以为是最大的一块未知，用自己的 JS 词法器数完之后反而是最小的一块：49 个字面量，
  去重后 35 条，全部很短。用到的特性只有：字符类（含范围与 `[^...]`）、锚点 `^ $`、
  量词 `* + ? {n} {n,m}`、捕获组、转义 `\. \n \r \s \d \/`、flags 里的 `g` 与 `m`。
  **一个 `|` 都没有**，没有 lookahead、没有反向引用、没有懒惰量词、没有 unicode 属性转义。
  所以 C 侧要的是一个几百行的回溯匹配器，不是一个正则引擎。（顺带：在 UTF-16 定长码元上
  写回溯比在 UTF-8 上简单，见第 8 条。）
  已落地（`runtime/omni_js_re.c` 引擎 + `omni_js_re.h` 的 match/split/replace）。
  落地时定下的四件事，都是"宁可响亮地失败"而不是悄悄分叉：
  - **没有 RegExp 对象**：模式与 flags 当普通字符串实参传，两侧各按字面量做编译缓存
    （C 侧的键就是字面量指针）。前提是量过的事实 —— 没有一处读写 `lastIndex`，
    所有 `.test` 的正则都不带 `g`。带 `g` 的 `.test` 与不带 `g` 的 `.match` 直接报错。
  - **只借宿主 `exec` 当匹配原语**，`match`/`split`/`replace` 的算法两侧各写一遍
    （空匹配推进、`$` 替换、split 插捕获组与 limit），不走 `String.prototype` 那几个 ——
    否则边角就有两套语义。
  - **`i` 只折 ASCII**：两个后端一样不完整，否则"不完整"本身就是分叉点。
  - `[\s\S]` 这类**类内的取反转义**不支持（会报错）。量过：仓库里 0 处。

- **`sort` 的稳定性与比较器语义**、**Map/Set 的迭代序**、**`toString`/数字格式化**这些细节
  是不动点的常见杀手：两次产出的 C 只要有一个字节不同就算没自举。其中数字格式化已经按
  ECMA-262 复刻并对照 node 验过（`tests/oir` 的 `num/*`）。
- 全 `dynamic` 会让 C1 明显慢于 C0（每个字段访问都是一次 dict 查找）。**接受**：先不动点，
  再优化。
