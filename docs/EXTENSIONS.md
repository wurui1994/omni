# 写一门自己的语言：omni 的扩展约定

omni 的核心是**机制**：驱动、注册表、中间层、四个后端与两个解释器。一门语言不是核心的一部分 ——
它是一格**扩展**：自己一个目录、自己一份自述、自己几张表。这一份说清那份契约。

心法两句：

- **核心给机制，扩展自述。** 核心不认识你的语言，也不该认识；它只按约定找、按约定装。
- **写语言 = 写表。** 词法、语法、作用域、元数、降级，各是一张表；读表的驱动器我们出。

## 一、目录形状

```
你的目录/
  omni-ext.json     自述（数据，不是代码）—— 核心靠它"知道有这么一门语言"，不必装你的代码
  omni-lang.js      入口：register 函数里调 api.register*
  ……                你的表（想怎么分文件都行）
```

放在哪儿：`OMNI_EXT_PATH`（`:` 分隔）里的任一目录，或 `<安装位置>/ext`、`$PWD/ext`、
`~/.omni/ext`。样板见这个仓库里的 `ext/lua`（Lua）与 `ext/gsl-shell`（方言 + 字符串里的 DSL）。

## 二、自述（`omni-ext.json`）

```json
{
  "name": "lua",
  "version": "0.1.0",
  "doc": "一句话说自己是什么",
  "entry": "omni-lang.js",
  "register": "registerLuaExt",
  "provides": {
    "exts": [".lua"],
    "caps": ["lua.toSx"]
  }
}
```

- `name`：诊断与 `--help` 里印的名字。**不装也要说得出来**，所以它在自述里。
- `entry` / `register`：真被问到时才装 —— `装(entry)[register](api)`。
- `provides`：你能答哪几问。四栏至少一栏非空：
  - `exts`：你认哪些后缀（`omni run x.lua` 按它挑）
  - `runnerExts`：你自己带"怎么跑"（不产 OIR 的那种，比如渲一帧图）
  - `caps`：你登记的本事（`omni emit sx x.lua` 走 `lua.toSx` 这种）
  - `targets`：你出的后端名字
- 校验不过会当场说**哪一格不对**；装完却没登记你声称的那一格，也当场响错
  （"自述与代码走散了"）。所以两处写一遍不会悄悄走散。

## 三、入口（`omni-lang.js`）

```js
import { Diagnostics, SourceFile, OmniError } from '<omni>/src/core/source/diag.js';
import { readText } from '<omni>/src/core/host/native.js';
import { lowerCoreSexpr } from '<omni>/src/core/sexpr/lower.js';

export function registerMyLangExt(api) {
  api.registerCap('mylang.toSx', (path) => toSx(path));      // 可选
  api.registerLang(['.my'], 'mylang', (path) => compile(path));
}
```

`api` 上能用的：`registerLang(exts, name, compile)`、`registerRunner(exts, name, run)`、
`registerCap(name, fn)`、`registerTarget(name, ir, emit)`、`declareProvider(claim, load)`、
`log(msg)`（`-v` 那一栏）、`incDirs(argv)`。

`compile(path)` 要交 `{ mod }`（一份 OIR）。最省的走法：把你的语言降成**核心方言**的文本
（`(module (fn …) (main …))`，见 `tests/sexpr/cases/*.sx`），再交给 `lowerCoreSexpr` ——
后端那一摊（C / JS / LLVM / SPIR-V + 两个解释器）就都通了。

**方向是单向的**：你 `import` 我们，我们不 import 你。宿主 IO 走 `host/native.js`
（封闭 ABI），别直接碰 `node:fs`。

## 四、SDK 面：写语言会用到的那几份

`src/core/frontend-engine/`（一个语言名字都没有，全是机制）：

- `syntax.js` —— `syn` 的词汇：`h`（洞）/ `l`（列表洞）/ `nm`（名字表）/ `w`（裸名字）/
  `opt` / `rep`。一个节点的具体语法就写成这么一串。
- `lexrules.js` —— 记号规则驱动器 + 通用规则件（`reRule` / `nameRule` / `numberRule` /
  `symbolRule` / `quoted`）。你的词法是**一张规则表**，不是一棵分支树。
- `language.js` —— `defineLang({name, keywords, ops, punct, unaryPrec, classes, subclass,
  nodes, tokens, scope, ctx, yields, start, str, ident})` 与 `extend(base, delta)`（方言只写增量；
  要改基语言的节点必须写 `replaces: true`，不写就当冲突炸）。
- `parse-driver.js` —— `parse(src, lang, start)`。五台机器：照 `syn` 对、按洞的类别去要、
  优先级爬升、后缀链、有序选择 + 回溯。**加一个节点不用改它一个字。**
- `render.js` —— `render(node, lang)`：读同一张 `syn` 把 AST 写回源码。
- `bind.js` —— `bind(ast, lang)`：读 `lang.scope`（每节点一条配方）与 `lang.ctx`
  （`provides` / `blocks` / `needs` / `declares` / `needsLabel`）。
- `arity.js` —— 元数契约：读 `lang.yields`；"列表只有最后一格展开、非列表的洞截成一格"
  这两条是普适的，你一格数据都不用给。

另外三份也常用：`frontend-engine/scopes.js`（查名）、`casts.js`（转换关系表）、
`overload.js`（挑一条）。

## 五、五步（照 `ext/lua` 的顺序）

1. **词法表**：`tokens.js` —— 关键字是词（带 `prec` 的进算符表）、字符串/注释各一条规则。
2. **节点表**：`nodes.js` —— 每个节点 `{name, of, syn}`。`of` 是它属于哪类洞；
   洞的类别（`exp` / `var` / `block` / …）加一条上位链（`var ⊂ prefixexp ⊂ exp`）
   就把"哪儿能放什么"变成了数据。
3. **立语言**：`lang.js` —— `defineLang({…})`。方言用 `extend`。
4. **语义两张表**：`scope.js`（配方 + 上下文）、`values.js`（谁产生多值）。
5. **降级**：`lower.js` —— 每个节点一小步，落到核心方言。收不下的**记账**
   （账号 + 一句人话），别硬凑：账是数字，硬凑是错。

## 六、尺子的约定（这一条是我们最看重的）

- **例子由规则生成**：节点 × 洞 × 那类洞的每个成员，从表里枚举，不手写用例清单。
- **期望由外部尺子给**：有参考实现就拿它当尺子（`ext/lua` 用 `luajit`：`loadstring` 判收不收、
  `luajit -bl` 的 `GGET` 判名字落在哪、跑一遍 `select('#')` 判几格值）。没有就用语料 + 写回幂等。
- **对不上就改规则或记账，不许改期望。**
- 参考量法：`ext/lua/tests/{gen,sweep,run,bench}.js`、`ext/gsl-shell/tests/formula.js`。

## 七、现状与边界

- 从源码跑的那条腿（`node src/core/cli.js`）已经按上面这套装扩展。
- **编出来的核心**（`dist/omni`）还装不进扩展：那条腿上的插件是动态库，自述里要再加一格
  `"plugin": "omni-lang-<名字>"` 与一条构建约定。这是明账，见 ADR-0030 第 4 节末。
- 同一个后缀内建与扩展都认时：**内建赢**（先声明先命中）。
