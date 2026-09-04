
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
