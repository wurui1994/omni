# JS 自举子集

状态：随代码演进 · 闸门实现：`tests/js-roundtrip/run.js` · 决策背景：ADR-0001

这份文档冻结 **Omni 的 JS 语法前端必须支持的 JS 子集**。范围不是"某个 ES 版本"，而是
**这个仓库里实际写过的 JS** —— 编译器（`stage0/src`）、测试脚本（`tests`）、bench（`bench`）
全算，一行不多。判定标准写死在测试里，不靠人读文档：

1. 上面三棵树里每个 `.js` 都要解析通过，且 `gen(parse(x))` 再走一轮逐字节不变。
2. 整棵 `stage0/` 树重新生成一遍之后，用**生成出来的编译器**跑 `tests/run.js` 与
   `tests/oracle/run.js`，输出与原编译器逐字节相同。

第 2 条是真正的验证。第 1 条只能说明"没崩"，第 2 条才说明"理解对了"。
把测试脚本和 bench 也纳进第 1 条不是凑数：它们是我们写的 JS，如果前端解析不了，
"支持的子集"就是靠"没去解析"撑起来的。这一扩就立刻抓到两个真 bug（见文末）。

## 支持的语法

**模块**：`import { a, b as c } from "./x.js"`、`import d from "x"`、`import * as ns from "x"`、
副作用导入 `import "x"`、`export` + 声明、`export { a as b }`、`export { a } from "x"`、
`export default e`、以及表达式位置的 `import.meta`。

**声明**：`const` / `let` / `var`（含一条语句里多个绑定）、`function`、`class`
（`extends`、`static`、方法、`get` / `set`、类字段）。

**语句**：块、空语句、表达式语句、`if` / `else`、`for`（三段式）、`for...of`、`for...in`、
`while`、`do...while`、`return`、`throw`、`break`、`continue`、`try` / `catch`（含省略参数的
`catch {}`）/ `finally`、`switch` / `case` / `default`。

**表达式**：全套二元与逻辑运算符（含 `**` 右结合、`??` 与 `&&`/`||` 不许裸混用）、
一元 `! ~ + - typeof void delete`、前后缀 `++` / `--`、条件表达式、逗号表达式、
全部复合赋值（含 `&&= ||= ??=`）、箭头函数（表达式体与块体）、函数表达式、类表达式、
`new`、调用、成员访问、可选链 `?.` / `?.[]` / `?.()`、数组与对象字面量、展开 `...`、
简写属性、计算属性名、对象方法与 getter/setter、模板字符串（含嵌套内插与
`String.raw` 这类标签模板）、正则字面量、`this`。

**模式（解构）**：标识符、数组模式（含空洞与 `...rest`）、对象模式（含 `...rest`、
重命名、默认值）、参数默认值、参数 `...rest`。声明、参数、`catch`、`for...of` 与赋值
左侧都走同一套。

**词法**：`//` 与 `/* */` 注释、hashbang（仅文件首字节，生成时原样保留）、
数字（十进制 / `0x` / `0o` / `0b` / 指数 / `_` 分隔符 / `n` 后缀的 BigInt）、
字符串（单双引号、`\x` `\u` `\u{}` 转义、行接续）、模板字符串（cooked 与 raw 都留着）、
自动分号插入（两条规则：语句末尾可省；`return`/`throw`/`break`/`continue` 的受限产生式）。

## 刻意不支持

`async` / `await`、生成器与 `yield`、标签语句与带标签的 `break`/`continue`、
`with`、`eval` 的语义、类的私有字段 `#x`、装饰器、动态 `import()`、`new.target`、
`super`（`extends` 只用来继承，stage0 里没有 `super` 调用）。

这些不是"以后再说"，是**编译器源码里不该出现**。哪天真要用，先问一句是不是能不用；
要用就同时改这份文档、前端和测试 —— `do...while` 与 `delete` 都是这么进来的：
`parser.js` 的 `varDecl` 用了前者，`tests/js-roundtrip/run.js` 自己的
`delete env.OMNI_CLI` 用了后者（写文档时还把 `delete` 列在"不支持"里，闸门当场打脸）。

## 依赖的宿主库设施

前端只管语法。**编译器源码用到的宿主库**是另一份账，而且是 C 路径自举真正的成本所在：

`Map`、`Set`、`Array`（`push` / `map` / `filter` / `find` / `findIndex` / `some` / `every` /
`forEach` / `slice` / `join` / `sort` / `flat` / `includes` / `indexOf` / `reverse` /
`Array.isArray` / 展开与解构）、`String`（`slice` / `split` / `replace` / `startsWith` /
`endsWith` / `includes` / `indexOf` / `padStart` / `repeat` / `toLowerCase` / `trim` /
`charCodeAt` / `codePointAt` / `fromCharCode` / `String.raw` / 模板拼接）、
`Object`（`entries` / `keys` / `hasOwn` / 展开）、`JSON`、`Number`（`isFinite` / `isNaN` /
`parseInt` / `parseFloat` / `toString(radix)`）、`Math`、`BigInt` 与 `BigInt.asIntN`、
`RegExp`（字面量 + `test` / `exec` / `replace` 回调）、`Error` 与 `instanceof`、
`node:fs` / `node:path` / `node:os` / `node:url` / `node:child_process` / `node:crypto`、
`process`（`argv` / `stdout.write` / `exit` / `env` / `hrtime` / `execPath`）。

## 现状与还差什么

**已完成**：词法器、语法分析器、生成器（`stage0/src/frontend-js/`），以及上面两条闸门。
19 个文件、约 52000 个 token 全部通过；第 2 条闸门重新生成 `stage0/src` 的 15 个 `.js`。

**还没做的是 JS → OIR 的降级**，也就是 ADR-0001 的 C0 → C1 → C2 不动点。拦路虎不是解析，
是**语言特性**：编译器源码需要闭包与函数值（110 个箭头函数、161 处带回调的数组方法）、
异质记录对象（AST 节点）、异常（`throw` / `try`）、以及上面那张宿主库清单在 Omni 里的对应物。
这些 Omni 都还没有。**所以 C 路径自举尚未开始，不能说"快了"。**

顺带记一笔：这条测试轴到目前抓到三个 bug，没有一个是"解析失败"，全是"解析/生成成了错的东西"：

1. `'toString' in {null:null,...}` 因为 `in` 走原型链而为真，于是 `x.toString(16)` 里的
   `toString` 被当成字面量、值还是 `Object.prototype.toString` 那个函数，生成出
   `b.function toString() { [native code] }`。
2. 同一个坑在 `check.js` 的内建方法表上：`a.constructor()` 让 `table?.[name]` 摸到原型链，
   编译器直接崩在读 `sig.params`。现在查表一律走 `Object.hasOwn`。
3. 数组空洞多发了一个逗号：`[, r]` 生成成 `[,, r]`，元素位置整体右移一位 ——
   不是"难看"，是**语义变了**。幂等第二轮才抓到（第一轮的输出本身是合法 JS）。

第 1、3 个只有靠"生成回去再逐字节比"才会现形；第 2 个是把同一类错误在别处顺手排掉的。
