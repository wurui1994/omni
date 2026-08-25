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
3. C 侧正则引擎（`test` / `match` / `split` / `replace`，含回调形式）
4. node 宿主面：fs / path / process / child_process / url
5. `throw` / `try` 的静态降级
6. `lower.js`：45 种节点全部降级
7. C0 → C1 → C2，验不动点，并入测试轴

每一步的出口条件与既有规矩一致：js/c 双后端差分全绿 + oracle（对照 node）+ 快照更新。

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
