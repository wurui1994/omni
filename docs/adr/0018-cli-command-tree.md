
## 落地：`--backend` 与「前端由扩展名选」的**次序**，以及 `build --backend js`

三条都是同一处的账：**`--backend` 选的是「后半段谁来跑/谁来生成」，前端由扩展名选 ——
两件事，而次序上扩展名必须先说话。**

### 一、`--backend` 把 `.c` 的分派吃掉了（真 bug）

```
$ omni run BBP_Formula.c --backend interp --verbose
pipeline  omni（mixed） → OIR → interp          ← 错：这是 omni 的流水线
BBP_Formula.c:4:1: error: unexpected character: "#"
```

`--backend interp` 先把 `cmd` 换成了 `'interp'`，于是 `case 'run'` 里那条
「`.c` 走 C 前端」的分派**根本没轮到**。修法：把 `.c` 的分派提到 backend 翻译**之前**。

顺带把 C 那几条腿写死在明处（C 的终点是 **MIR**，不是 OIR，所以它与 omni 不是一套）：

- `native`（默认）：自带 C 前端 + 自带代码生成 + 自带链接器 —— `run` 是编+链+跑，
  `build` 是编+链
- `interp`：C -> MIR -> MIR 解释器（oracle，慢一个数量级）
- `js` / `llvm` / `jit`：**没有这条路**，明着骂并说清为什么（`backend-js` 吃的是 OIR）

```
$ omni run BBP_Formula.c --backend interp --verbose
pipeline  c → cpp → MIR → interp               ← 对了
$ omni run BBP_Formula.c --backend js
run x.c: 没有 --backend js 这一条 —— C 的终点是 MIR，只有 native（默认：编 + 链 + 跑）
与 interp（MIR 解释器，oracle）两条
```

### 二、`build x.c` 从前掉到 omni 的前端上

现在出一个可执行文件（`buildCFile`）：`-o` 没给就用源文件名（与 `build x.omni` 一个规矩），
印一行产物摘要。量：`omni build BBP_Formula.c` -> 50976 字节，`./BBP_Formula` 1.06 s。

### 三、`build --backend js` —— **JS 从来不是「不支持」，是没接到 `build` 上**

`omni emit js` 早就有（`emitJs`），自举那条门（`tests/js-roundtrip`）就是靠它把整个
编译器重新生成一遍的。缺的只是「落盘成一个产物」这一格 —— 而 `build` 的契约正是出产物。

```
$ omni build tests/cases/01_basics.omni --backend js
omni: built 01_basics.js (104794 字节，node 01_basics.js 就能跑)
$ node 01_basics.js      # 与 --backend interp 跑出来的每一行都一样
```

### 四、`build --backend interp` 该生成什么？**什么都不该生成**

`interp` 是**执行器**，不是代码生成器；`build` 的契约是「出产物」，而解释执行没有产物。
所以这一条不是「还没做」，是**不该有** —— 那句话从「还没有 --backend interp 这一条」
改成指路：

```
build: interp 是执行器，不出产物 —— 要 IR 用 `omni emit oir FILE` / `omni emit mir FILE`，
要跑用 `omni run FILE --backend interp`
```

IR 那两种形态早就在 `omni emit` 下面（`oir` / `mir` / `ast` / `sx` / `js` / `c` / `llvm` /
`spirv` / `asy`）—— `build` 不必再开一份别名。

<!-- ADR-0018 backend与扩展名的次序-END -->

## 决策：三条命令的契约，以及 `--backend interp` 到底该出什么

上一节把 `.c` 的分派修在了 `run`/`build` 两处，**漏了 `emit`** —— `omni emit mir x.c`
照旧掉到 omni 的前端上报 `unexpected character: "#"`，而上一节那句指路正好指向了它。
教训写在明处：**「前端由扩展名选」是一条规矩，它得在每一个入口都写一遍** ——
`run`、`build`、`emit` 是三个入口，漏一个就是一个假象（更糟：指路指到不通的路上）。

修完之后三条命令的契约：

- **`emit FORM FILE`** = 把某个形态**印到 stdout**（看 / 调试 / 快照比对）。
  形态由 `FORM` 选，前端仍由扩展名选。`.c` 只有 `mir` 一格 ——
  C 的终点是 MIR，**不经过 OIR**（`cMir`：预处理 -> C 前端 -> MIR）。
- **`build FILE --backend B`** = 出**B 能吃的那份产物**。
  `native`/`c` -> 可执行文件；`js` -> `.js`（`node x.js` 直接跑）；`llvm` -> 见 `build-llvm`；
  `interp` -> **IR 文件**（omni 那条腿是 OIR、`.c` 那条是 MIR）。
- **`run FILE --backend B`** = 产物（可缓存）+ 跑。

### `--backend interp` 出 IR 文件 —— **落地了**，缺的只剩「喂回去」

一开始我把它写成「interp 是执行器，不出产物」——**那句话把设计说成了结论**。
按上面的契约，`interp` 与 native/js 没有分别：**它要吃的那份东西就是它的产物**。
还有一条更硬的规矩：**`build --help` 里列了它，那它就必须落一个文件** ——
声明了却不能用，比没有更坏。

```
$ omni build BBP_Formula.c --backend interp
omni: built BBP_Formula.mir (64453 字节，MIR —— 解释器吃的就是这一层；…)
$ omni build tests/cases/01_basics.omni --backend interp
omni: built 01_basics.oir.json (64648 字节，OIR —— 解释器吃的就是这一层；…)
```

**哪一个 IR 由「那条腿的解释器吃哪一层」定**，不由命令定：omni/sx/asy/js -> OIR；
`.c` -> MIR（它不经过 OIR）。这与「有两个解释器」是同一件事，见 ADR-0013。

顺带把 `build` 的 `--backend` 清单改成**只列真有产物的那几条**：`native|c|js|llvm|interp`。
`jit` 是「就地编就地跑」（只在 `run` 上有意义）、`spirv` 现在只有 `emit` 那一档，
都从 `build --help` 里去掉了 —— 同一条规矩：声明了就得能用。

### 还差的那一格：把 IR **喂回去**

现在这两份文件是「读得懂、还喂不回去」：

- `emit oir` / `build --backend interp` 的 JSON 是**有损**的：`replacer` 丢掉
  `span`/`nameSpan`/`ast`，`i64` 变成 `"2n"` 这样的字符串。它的身份是快照与给人看。
- `mir/bytes.js` 是**摘要**（`funcBytes`/`funcHash`/`moduleHashes` —— 增量编译的 key），
  不是一份能读回来的字节形式。

要闭环（`omni run x.oir.json` / `omni run x.mir`）得答三个问题：

1. **span 怎么办**：运行期诊断（`failRt`）要位置。丢了就只能报「哪一条指令」而不是
   「哪一行源码」；不丢就得把路径 + 行列一起序列化。
2. **i64 / f64 的字面量**：JSON 里没有 i64。要么定一个编码（`"2n"` 那种，配一个 reviver），
   要么走字节形式（那就顺手把 `mir/bytes.js` 从「摘要」补成「序列化」）。
3. **先闭哪一台**：两台解释器都在用（ADR-0013），闭环从哪一层开始是同一个决定。

产物行里把这一格**明说**了（「喂回去跑还差…」）—— 不假装它已经能喂回去。

<!-- ADR-0018 三条命令的契约与interp产物-END -->
