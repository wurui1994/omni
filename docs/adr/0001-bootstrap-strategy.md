# ADR-0001：自举策略 —— JS 语法前端 + C 路径

状态：已决定（2026-08-25）

## 背景

既有约束（前几轮已定）：实现层不用 C++/Rust 或任何编译慢的语言；JS 既是过渡宿主，
也是**永久**兼容层；Omni 主语法本来就与 JS 子集兼容。

现在要定的是：编译器怎么脱离 Node 独立存在。

## 决定

### 1. 语法前端加 JS，并且永久可用

JS 前端不是自举用完就扔的脚手架，它和 GLSL 前端并列，是一个正式前端。
"前端/后端分离"这件事本来就是 Omni 的架构主张，拿 JS 当第二个前端是对这个主张最便宜的验证：
如果 JS 都接不上来，那"多前端"只是口号。

### 2. 不坚持用 Omni 自己的语法重写编译器

编译器源码留在 JS。于是自举的**不动点不是**"用 Omni 写的编译器编译自己"，而是：

```
C0 = node 上跑的编译器（src/core/*.js）
C1 = C0 用 JS 前端读自己的源码，走 C 后端产出的原生可执行文件
C2 = C1 用同样的方式再产出一次
判据：C1 与 C2 产出的 C 逐字节相同
```

这比"换语法重写一遍"省掉一整轮翻译，而且**不动点判据更强** —— 重写版本的不动点只能证明
新编译器自洽，而这个不动点同时证明 JS 前端、类型检查、C 后端三者在自己身上是一致的。

代价是自举子集的闸门从"Omni 的语法子集"变成"JS 的语法子集"，见第 6 节。

### 3. js → 解析 → 生成 js 这条路径要做，虽然它本身没意义

把 JS 解析成 OIR 再发射回 JS，功能上是恒等变换，没有产品价值。保留它是因为它是前端唯一的
**免费 oracle**：

- **幂等**：`gen(parse(src))` 再 `parse` 再 `gen`，两次输出必须逐字节相同。
  不幂等说明前端丢了信息或者发射器不稳定。
- **语义一致**：`src` 与 `gen(parse(src))` 在 node 下的行为必须相同。落地时选了比"跑一个
  文件对输出"强得多的形式：**把整棵 `stage0/` 树重新生成一遍，用生成出来的编译器跑
  `tests/run.js` 与 `tests/oracle/run.js`，输出与原编译器逐字节相同**。于是"前端有没有
  理解对"变成了 36 个既有用例的问题，而不是一个新写的小测试。

没有这条轴，JS 前端的 bug 只会在 C 路径上以段错误的形式出现，而且是在几万行生成的 C 里面。
有了它，"解析前"和"生成后"直接对照，问题定位在前端而不在后端。

这条轴上线当天就抓到三个 bug，**没有一个是"解析失败"，全是"解析/生成成了错的东西"** ——
这正是只看"能不能解析通过"永远发现不了的那一类：

1. `LITERAL_WORDS` 用对象字面量存 `{null, true, false}`，而 `'toString' in obj` 会走原型链
   返回真，于是 `x.toString(16)` 里的 `toString` 被当成字面量 token，值还是
   `Object.prototype.toString` 那个函数本身。解析"成功"，AST 是错的。
2. 同一个坑在 `hir/check.js` 的内建方法表上：`name` 是用户写下的字符串，
   `a.constructor()` 摸到 `Object.prototype.constructor`，编译器当场崩在读 `sig.params` 上。
   现在是 `tests/errors/prototype_names_are_not_methods.omni`。
3. 数组空洞在发射器里多发了一个逗号：`([, r]) => ...` 生成成 `[,, r]`，元素位置整体右移
   一位。第一轮输出是**合法 JS**，所以只有幂等的第二轮（`[,, ,, r]`）才暴露 —— 这条正好
   解释了为什么幂等判据必须是"逐字节相同"而不是"还能解析"。

前两条的教训写进规矩：**凡是用外部字符串索引对象字面量的地方，一律用 `Map` 或
`Object.hasOwn` 护栏。** 第三条的教训是闸门的**范围**：它是把幂等从 `src/core` 扩到
`tests` 与 `bench` 之后才落进网里的。同一次扩围还逼出了 `delete` —— 我在子集文档里把它
列为"不支持"，自己的测试脚本却在用它。

这是第三条测试轴，和已有的两条并列：

- `tests/run.js` js 后端 vs c 后端 —— 发现两个后端**不一致**
- `tests/oracle/` omni vs python3/node —— 发现两个后端**一起错**
- `tests/js-roundtrip/` js vs 前端往返 —— 发现**前端**丢信息

### 4. C 路径自举是重点；性能底线是"不比 JS 宿主慢太多"

V8 是带 JIT 和分代 GC 的成熟实现，我们是 AOT + 目前连 ARC 都没有。慢一点是合理的，
慢一个数量级不行 —— 那说明架构选错了，而不是优化不够。

**只做必要优化，不做极致优化。** 必要清单，按预期收益排序：

1. **热叶子函数 `static inline`**（已做）。运行时拆成多 TU 之后，跨 TU 调用没有 LTO
   就不会内联，而 i64 回绕算术、`byte_at`、dict 的 hash/eq 全在最内层循环上。
   tcc 不支持 `-flto`，所以选 `static inline` 而不是靠链接期优化。见 `omni.h` 的文件头。
2. **字符串拼接不能退化成 O(n²)**（已做）。编译器最热的模式是 `acc = acc + piece` 和
   `out.push(piece)` + `join`。V8 靠 rope（cons string）让前者是 O(n)，朴素的 C 实现每次都
   重新分配加拷贝，是 O(n²) —— 这不是常数差距，是算法差距，正好会踩中"比 JS 慢一个数量级"。
   做法不是引入一个 builder 类型，而是利用 arena 的一个性质：如果 `a` 的末尾正好就是 arena
   的分配位置，那么它后面的字节还没被分配过，直接把 `b` 拷进去、把 arena 指针推过去就得到
   `a+b`，`a` 一个字节都不用动。**这是别名安全的**：`a` 的长度没变，我们只写它结尾之后
   那段无主内存，任何还持有 `a` 的人看到的字节完全不变（即使 `a` 只是"恰好"结束在 arena
   顶上的某个 substr 切片，结论也一样）。
   这也是为什么字符串走 `omni_alloc_bytes`（1 字节对齐）而不是 `omni_alloc`（16 字节对齐）——
   对齐填充会让"末尾正好在分配位置"永远不成立。
   实测（`acc = acc + "abcdefgh"` 循环 5 万次）：arena **4ms**，`-DOMNI_NO_ARENA` **2678ms**。
   n 再翻 4 倍到 20 万，后者要 40s 以上（第一次测量就是这样超时的）。
   另外补了 `list<string>.join(sep)`（`omni_str_join`）：一次算总长、一次分配、逐段拷贝。
3. **分配用 arena**（已做，`omni_mem.c`）。编译器是批处理进程：读源码、产出 C、退出。
   整个生命周期只需要"分配、永不单独释放、退出时整体丢掉"。malloc 每次 20-50ns，
   bump 指针 2ns 上下。这比先上 ARC 简单得多，也更快；ARC（ADR-0007）留给"用 Omni
   写长期运行的程序"那一天。
   - `omni_realloc` 换成 **`omni_grow(p, oldBytes, newBytes)`**：arena 不给每个对象加尺寸头
     （小对象上太贵），所以旧尺寸只能由知道它的容器代码传进来。副作用是正在增长的容器多半
     就是最后一次分配，那种情况直接推指针 = 真正的原地扩容，零拷贝；退化路径因为容器是
     倍增增长，被丢掉的旧缓冲总和有 2x 上界。
   - dict/set 的 `rebuild` 里索引表改成直接 `omni_alloc`：内容马上会被全部清零，没必要拷。
   - **代价与对策**：一个 arena 块里全是我们的对象，ASan 就看不见容器越界了。所以保留
     `-DOMNI_NO_ARENA`（一次一个 malloc），消毒扫描走那条路径。两条路径的可观察行为必须
     一致，差分测试同时覆盖。
4. `-O2`。不做 LTO（tcc 没有）。

**明确不做**：NaN boxing（ADR-0006 已否）、方法内联缓存（静态类型不需要）、
自己写 Grisu/Ryu（ADR-0005 已用 15/16/17 位试探代替）、任何需要 profile 反馈的优化。

### 5. `c_runtime` 必须是真的 C 文件（已落地）

运行时以前是 `src/core/runtime/c_runtime.js` 里一个 651 行的 `String.raw` 模板。
在 C 路径自举之前这样还能凑合，之后不行：运行时会长到几千行，而藏在 JS 字符串里的 C
没有语法高亮、没有编译器检查、没法单独编译、没法单独测。

现在的布局（`src/runtime/`）：

- `omni.h` —— 唯一的公共头。生成的 `.c` 只 `#include "omni.h"`。
  里面是类型定义、非内联函数的声明、以及**热叶子函数的 `static inline` 定义**。
- `omni_error.c` / `omni_mem.c` —— 错误与分配
- `omni_int.c` —— `int(real)` 的截断与范围检查（回绕算术在头里）
- `omni_str.c` —— 要分配或要扫描的字符串操作
- `omni_fmt.c` —— 值 → 文本（`%.6g` 打印与 `repr` 序列化两套规则）
- `omni_conv.c` —— 文本 → 值（自己先校验文法，再交给 strtoll/strtod）
- `omni_dyn.c` —— dynamic 的标签名与结构相等
- `omni_hash.c` —— 键的显示形式（hash/eq 本体在头里，是热路径）
- `omni_container.h` / `omni_dyn_bridge.h` —— 单态化宏，必须在**生成的那个 TU** 里展开

`src/core/runtime/c_runtime.js` 现在只剩三件事：告诉编译器运行时在哪、生成的 `.c` 该
include 什么、以及把整个运行时拼成单文件。

两个配套决定：

- **`emit-c --amalgamate`**：把头和所有 `.c` 拼成一个翻译单元。ASan 扫一个文件、
  贴 godbolt、把编译结果发给别人时用。能这么拼是因为公共函数都是 extern，
  只有容器宏展开出来的函数是 static，而容器只在生成的代码里实例化。
- **运行时 `.o` 缓存**（`cli.js` 的 `runtimeObjects`）。不缓存就是每次 build 重编 8 个 TU：
  实测 **757ms → 73ms**。自举时编译器要反复重建自己，这条直接决定开发循环还能不能用。
  缓存键 = 编译器 + flags + 运行时目录下每个 `.c`/`.h` 的 mtime 与大小。
  先编进临时目录再整体 rename，中断或并发都不会留下半个缓存。

拆分前后的实测（`bench/compare.js`，fib + 循环）：js 后端 104ms，c 后端 **282ms → 151ms**
（含 clang `-O2`；原生二进制本身 5ms）。也就是说拆分没有让 C 路径变慢，缓存还让它变快了。

### 6. JS 自举子集是一道闸门

编译器源码**只能**用 JS 前端支持的子集。子集覆盖不到的地方，**改编译器源码，不扩前端** ——
反过来做就没有边界了，前端会被自举需求推成一个完整的 JS 实现。

先量了一遍 `src/core` 的 4485 行实际用到什么（这决定第一版前端的范围）：

- class 10 个、getter 3 个、箭头函数 110 处、`for...of` 63 处、展开 28 处、解构 72 处
- 模板字符串大量（发射器几乎全靠它）、`String.raw` 2 处
- `Map` 8 处、`Set` 23 处、数组方法（map/filter/join/…）161 处
- `?.` 11 处、`??` 19 处、try/catch 5 处、`BigInt` 16 处、`JSON.*` 4 处
- **正则字面量只有 4 个**，全是 `/[0-9]/` 这类字符类，`.test` 14 处、`.replace` 10 处

最后一条是好消息：**正则不是拦路虎**。核心路径上的 4 个字符类换成 `isDigit` /
`isIdentStart` 这样的显式判断即可；`.replace` 的那几处集中在 `cli.js` / `repl.js` /
`diag.js`，不在自举核心里。真正需要前端支持的是模板字符串、`Map`/`Set`、数组方法、
解构和展开 —— 这些都有明确的降级目标（`Map` → `dict`，`Set` → `set`，模板字符串 →
字符串 builder，数组方法 → 循环）。

闸门文件：`docs/js-bootstrap-subset.md`（待写，和 `docs/bootstrap-subset.md` 同等地位）。

### 7. 原生编译器的栈不能由环境决定

入口不留在主线程上：`main` 只做 `omni_host_init`，然后把 entry 交给 `omni_run_entry`
（`runtime/omni_js_host.c`），那里开一条**栈 512MB** 的线程去跑。C 后端与 LLVM 后端发的
`main` 都走这一层，两条腿于是同一个栈口径。

为什么非这样不可：主线程的栈大小是链接期定死的（macOS 上 8MB），而这条链上最深的递归
就是编译器自己 —— `emit-c cli.js` 是 16 万行 JS 过词法、语法、降级三遍，全是递归下降。
在 8MB 上它只剩一点余量：**同一份代码、同一条命令**，早一刻通过、晚一刻就 `Segmentation
fault: 11`（`___chkstk_darwin` 上的 `EXC_BAD_ACCESS`），看起来像随机故障。把 `ulimit -s`
抬到 64MB 就好了 —— 这恰恰说明判据错在哪：**编译器需要多少栈，不该由跑它的那个 shell 决定**。

512MB 只是**保留**地址空间，页要用到才落地，所以小程序不为此付一分钱。开不出线程就退回
直接调用 entry：那种机器上小程序照旧跑，只是没有这份余量。链接要 `-pthread`（macOS 上
pthread 就在 libSystem 里、这个开关等于空操作；glibc 2.34 起也已并进 libc）。

**画出来的边界**：这不是"栈够不够"的最终答案 —— 递归深度还是与输入规模成正比。真正的
答案是把那三遍里最深的那一遍改成显式栈；在那之前，512MB 是一条量得出来的余量，而不是
一个猜的数。

### 8. 装好的那一份是完整的：数据文件跟着走，布局不靠命名约定

`bootstrap` 铺 `dist/` 时，除了编译器自己，还要把**运行时真正会读的数据文件**一起拷过去：
`frontend-asy/asy.grammar` 与 `builtins.tab`、`frontend-jnc/jnc.grammar`、`lib/asy/*.asy`
（`runtime/*.{c,h}` 与 `jit/*` 本来就在拷）。少了它们，装好的那份能起来、能编译 JS，
一跑 asy 就 `找不到 asy 语法文件：…/dist/src/frontend-asy/asy.grammar` —— 一个只在
装好之后才现形的洞。所以 layout 那一格现在**六个计数全部必须 > 0** 才算过
（`lib 1+4 files, runtime 26 files, jit 1 files, grammar 2+1 files`），而不是只看目录建出来了。

第二条同源的错更隐蔽：产物缓存的键要走一遍 `src/core` 底下所有文件，从前**按"名字里有没有
点"分目录与文件**。这在源码树里恰好成立（目录都没后缀、文件都有），而装好的那份里编译器
自己就叫 `dist/src/host/omni`、没有后缀 —— 于是它被当成目录走进去，`readdir` 一个普通文件：
`ENOTDIR: not a directory, scandir '…/dist/src/host/omni'`。改成问文件系统（新的
`js_fs_is_dir`，闭 ABI 里六处齐备）。**判据**：一条"在我们这棵树里恰好成立"的命名约定，
不能当成布局的判据 —— 布局的事只有文件系统说了算。

**画出来的边界**：`dist/` 的完整性只由 layout 那一格与"装好的那份跑一遍 asy"守着，
还没有一格"把 dist 挪到别的路径再跑"——路径无关性没被量过。

## 量：自编译现在拦在哪儿（248 条红是两类，不是一片）

`tests/all.js` 里有 6 组红（`bootstrap`、`mir`、`incr`、`js-exec`、`js-roundtrip`、`cabi`），
前五组都从**同一处**来：JS 前端把 `src/core` 的 import 树链成一份程序时报 **248 条**错误。
数一遍，它们只有**两类**：

- **244 条是模块作用域重名**（去重后 **136 个名字**）。JS 前端把整棵 import 树链成一份
  程序，于是模块作用域的名字在**整份程序里**必须唯一。撞的都是「两边各写了一份同名小工具」：
  `arm64/from_mir.js` 与 `x64/from_mir.js` 的 `widthOf`/`widthKey`/`nyi`/`outArgsBytes`、
  `arm64/encode.js` 与 `x64/encode.js` 的 `ret`/`nop`、`link/macho.js` 与 `link/elf.js`
  的 `writeObject`、`interp/libc.js` 与 `frontend-c/tccpp.js` 的 `utf8Of`/`hexVal`……
  **每一条都是纯改名**，不动语义。
- **4 条是 `import * as`**（`arm64/asm.js`、`arm64/from_mir.js`、`x64/asm.js`、
  `x64/from_mir.js` 全都是 `import * as … from './encode.js'`）。这一类**改不动名字**
  就解决：要么前端支持命名空间导入，要么这四处改成具名导入
  （`encode.js` 的导出面很宽，具名列表会很长）。

**这两类的性质不同，所以该分开决定：**

- 重名那 136 个是**机械的**，可以一次扫过去（也可以顺手立一条门：新加的模块作用域名字
  不许与已有的撞 —— 现在这一格是靠自编译那条链**间接**发现的，所以每次都是一大把）。
- `import * as` 那 4 处是**语言子集的边界**（`docs/js-bootstrap-subset.md` 冻结的那一份），
  动它等于动子集的定义。

顺带记一笔：写这一节的同一天我自己**新造了一个**（`cli/plan-c.js` 与 `cli/plan-omni.js`
各有一个 `opt`）—— 当场改成 `planOpt`。这说明「没有门」的代价不是「有一笔旧债」，
而是**债会持续长出来**：只要自编译那条链是红的，新的重名就没人当场拦。

### 于是先立一个棘轮：`tests/bootstrap/ratchet.js`

债什么时候还是另一件事，**这一门管的是它不许长大**。只走链那一步
（`omni emit-js src/core/cli.js`，0.5 秒，不编 C 不跑），三条断言：

1. 重名那一类不许多（基线 **243**）
2. `import * as` 那一类不许多（基线 **4**）
3. **不许出现第三类错误** —— 新的拦路虎混在两百多条旧账里就没人看见了

少了也骂（「把基线调下来」：棘轮只往一个方向转，基线跟着走才有意义）；
链通了（exit 0）也骂 —— 那时候该把这一门删掉，换成真的自编译门。

验过它会红：往 `plan-omni.js` 里加一个与别处同名的 `padCell`，那一门当场
`重名多了：243 -> 244` 并把最后几条打出来。它排在 `bootstrap/run.js` **前面**
（`tests/all.js`）—— 棘轮红了说明新长了债，那比旧债要紧。

### 然后还了第一类的大头：243 -> 22

`tests/bootstrap/dedup.js` 是配套的还债工具。它只做**能证明安全**的那一部分：

- 只改**一个文件**里的名字，而且那个名字**两边都没有 `export`** ——
  别的文件引不到它，所以词边界改名不会漏改任何引用
- 同一个文件里的**局部遮蔽照旧成立**：声明与它的引用是一起改的
- 还剩哪些重名，问的是**前端自己**（`emit-js` 的报错），不另写一份规则

`UPPER_SNAKE` 前面加 `前缀_`，别的加 `前缀` + 首字母大写 —— 读起来还是原来那个词
（`ALWAYS_GOTPLT` -> `MO_ALWAYS_GOTPLT`、`targetConf` -> `moTargetConf`）。

扫了十一个文件（`link/` 那八个 + `arm64|x64/from_mir.js` + `interp/libc.js` +
`frontend-jnc/lower.js`），**243 -> 22**。撞的确实都是「两边各写一份同名小工具」：
ELF/Mach-O/PE 三份写出器各有一套 `SHT_*`/`ARCH`/`sectionClass`，
arm64 与 x64 各有一套 `widthOf`/`nyi`/`outArgsBytes`。

**剩下的 22 条是导出的名字**（`writeObject`、`typeText`、`utf8Bytes`……），
改它们要动调用方，得一处一处看 —— 不在 `dedup.js` 的范围里，也不该由一支脚本代劳。

#### 量：`export { 新名 as 老名 }` **不是**一条捷径

看到那 22 条时，第一个想法是「把声明改名、导出名不动」，这样一处调用方都不用动：

```js
function arm64Ret() { … }
export { arm64Ret as ret };     // 调用方照旧 import { ret }
```

读了链接器（`frontend-js/link.js`）之后知道这条路走不通，而且理由正是这个链接器的
**核心设计**：它**一个名字都不重命名**。整棵 import 树的模块体**原样接起来**成一份程序，
import 的别名摊成一句模块级的 `const 本地名 = 导出名`（`link.js:291-302`，
注释写着「不重命名，也就不需要作用域分析」）。

于是：

- 导出名在拼出来的那份程序里**根本不是一个绑定** —— 只有声明的那个名字是。
  `import { ret }` 会引到一个不存在的 `ret`。
- 就算给导出别名也补一句 `const ret = arm64Ret;`，那个 `ret` **立刻又是一个模块作用域
  的名字**，与 x64 那个 `ret` 照旧撞 —— 一步都没往前走。

`link.js:194-196` 现在明着拒 `export { a as b }`（「renaming an export is not supported」），
那句拒绝不是没写完，**是对的**：在「不重命名」这个模型里它没有正确的实现。

所以那 22 条只有一条路：**改导出名 + 改调用方**（`cli.js` 里那几处已经是
`import { genModule as genArm64 }` 的形状，所以改的是 `imported` 那一半），
而且门里也有引用（`tests/arm64/link.js` 这类直接 import `genModule` 的）。
机械但要一处一处过，不是脚本活。

#### 再收 12 条：判据错了一格（22 -> 10）

上一段说「那 22 条都是导出的名字」——**不准**。`dedup.js` 第一版的守卫是
「**两边**有没有一边导出」，太粗。正确的判据是「**要改的这一边**导没导出」：
另一边导不导出与这一次改名无关，我们改的是这个文件里的声明与它自己的引用。

按这个判据分开数，22 条里 **12 条只有一边导出**，改**没导出**那一边、
调用方一处都不用动：

- `frontend-jnc/lower.js`：`isPtr`/`isStruct`/`isEnum`（`frontend-c/ctype.js` 导出它们）
- `frontend-c/tccgen.js`：`TOK_ARROW`/`utf8Bytes`/`floatBits`（`tcctok.js`/`host/utf8.js`/
  `arm64/from_mir.js` 导出）
- `arm64/encode.js`：`chkReg`；`arm64/from_mir.js`：`FCMP`
- `link/pe.js`：`align`/`HDR_SIZE`；`link/elf_exe.js`：`sectionClass`
- `interp/builtin.js`：`udiv`

扫完 **22 -> 10**（166 处引用）。剩下的 10 条**两边都导出**：
`ret`/`nop`/`fcmp`（arm64|x64 的 `encode.js`）、`RELOC`/`CodeBuf`（`asm.js`）、
`genModule`/`genFunc`/`codeOf`（`from_mir.js`）、`writeObject`（`macho.js`|`elf.js`）、
`typeText`（`ctype.js`|`mir/ir.js`）—— 共 **37 处 import** 要跟着改，其中有门里的。

> 这一格的教训与「量而不是猜」是同一条：我把「有一边导出」当成了「不能改」，
> 于是自己给自己少算了 12 条。判据写错一格，剩下的活就凭空多了一半。

#### 第一类清了：10 -> 0

剩下那 10 条两边都导出的，用**同一个手法**一批批收掉：**改导出名 + 只改调用方
`import` 那一行的导出名那一半**，别名照旧（`import { genArm64Module as genArm64 }`），
于是调用方的**正文一个字都不动**。

- `elf.js` 的 `writeObject` -> `writeElfObject`（只有 `cli.js` 引它，而且那行本来就
  写着 `as writeElfObject` —— 改完更短）
- `ctype.js` 的 `typeText` -> `cTypeText`（只有 `tccgen.js` 引，44 处引用。另一边
  `mir/ir.js` 的 `typeText` 被七八个后端引，动它贵得多）
- arm64 那三个：`genModule`/`genFunc`/`codeOf` -> `genArm64Module`/`genArm64Func`/
  `codeOfArm64`（`cli.js`、`tests/c/native.js`、`tests/arm64/{from-mir,link}.js` 各一行）
- `asm.js` 的 `RELOC`/`CodeBuf` -> `RELOC_ARM64`/`Arm64CodeBuf`
  （`link/{macho,link,elf}.js` 与两支 arm64 门各一行）
- `encode.js` 的 `ret`/`nop`/`fcmp` -> `retArm64`/`nopArm64`/`fcmpArm64`。这三个走
  `import * as`，所以改的是 **`a.ret` 这种属性访问**——`tests/arm64/run.js` 里 `'ret'`
  是**期望的反汇编文本**，一把梭的词边界改名会把那些字符串一起改坏。

**重名 243 -> 0。** 剩下的只有 `import * as` 那 4 处（全是 `from './encode.js'`），
它是**子集定义的边界**：自编译现在就剩这一格挡着，它一开，
`bootstrap`/`mir`/`incr`/`js-exec`/`js-roundtrip` 那五组红才有机会一起转绿。

每一批都跑了门：`ratchet` 3/0、`arm64/run` 207/0（含反汇编逐条）、`arm64/from-mir` 88/0、
`arm64/link` 21/0、`x64/run` 188/0、`x64/from-mir` 90/0、`x64/link` 21/0、`c/run` 207/0、
`c/native` 227/0、`tcc-link` 83/0、`macho-tcc` 4/0、`macho-libc` 180/0、
`pe-exe`/`elf-merge`/`elf-roundtrip` 全 0 不同、`rela-text` 24/0、`core` 133/0、`sexpr` 78/0。

#### 量：`import * as` 那 4 处该怎么开（第二类的全部）

先把它量清。四处全是 `from './encode.js'`，用到的成员与引用数：

- `arm64/asm.js`（`e`）：9 个成员、12 处引用
- `arm64/from_mir.js`（`a`）：50 个成员、126 处引用
- `x64/asm.js`（`x`）：6 个成员、9 处引用
- `x64/from_mir.js`（`x`）：39 个成员、172 处引用

两条路都能走，这里的分歧不是"能不能"，是**代价落在哪儿**：

- **让链接器支持它**：`import * as ns` 摊成 `const ns = { a, b, … }`。子集**确实**表达得出来
  —— `lower.js:1276` 的 `objectLit` 走 `js_obj_new` / `js_obj_set`。但摊出来之后
  `ns.f(x)` 就从"直接调一个函数"变成"属性查一次 + 通过函数值间接调"，而这 319 处引用
  全在两个后端**最热**的路径上。为了 4 行 import 把 `wrapFn` 拖进汇编器内环，不划算。
- **改成具名导入**：`e.addImm(…)` -> `addImm(…)`。

选后者。挡在前面的只有一个问题："裸名会不会被同名的局部东西遮住？"量法是**先剥掉字符串
和注释**再找裸用（`'push'`、`'lea'`、`'b'` 这些助记符文本一大把，不剥就是 16 处假警报），
剩下 7 处：`arm64/asm.js` 的 `adr`/`b`/`bcond`/`bl`/`cbnz`/`cbz` 与 `x64/from_mir.js`
的 `fcmp`。逐条看过去，**7 处全是类方法名**：

```js
adr(rd, l) { return this.toLabel(l, (off) => e.adr(rd, off)); }   // asm.js:116
```

方法名不在模块作用域里绑名字，所以它遮不住导入 —— `e.adr` 换成裸 `adr` 之后，方法体里
那个 `adr` 仍然指导入的那一个。也就是说：**真正的遮蔽，一处都没有**。

另有 4 处 `a.kind` / `a.name` / `a.no` / `a.weak` 不能一起改：`encode.js` 没有这四个导出，
那个 `a` 是别的局部对象。判据因此是"**这个名字在 encode.js 的导出表里**"，不是"`a.` 打头"
—— 与上面收重名时同一个教训：判据错一格，就会改坏一批。

#### 第二类也清了：4 -> 0，然后第三类露出来了（而且先露出来一个假的）

四处按上面的判据改完，319 处引用全变成裸名，`x64`/`arm64` 六支门原样绿：
`x64/run` 188/0、`x64/from-mir` 90/0、`x64/link` 21/0、`arm64/run` 207/0（含反汇编逐条）、
`arm64/from-mir` 88/0、`arm64/link` 21/0。

**两类一清，第三类当场就露出来了 —— 266 条。** 而它是**假的**：

```js
const NATIVE_SUFFIX = 'src/host/native.js';       // link.js:25，真路径是 src/core/host/native.js
```

`endsWith` 一直不成立，于是"这个文件不拼进程序、只登记名字 -> op"那一段**从来没走过** ——
node 宿主那份实现（`process.getBuiltinModule`、`Buffer`、`process.env`…）被当成普通模块
拼进去降级，报了两百多条。`CABI_SUFFIX` 同一个毛病，`cabi` 那组红大概就是它。

这条 bug 能活这么久，是因为**它躲在旧债后面**：链子在更早一步就断了，这一段的死活没人量得到。
换句话说，棘轮把 243 条重名收到 0 的真实收益不是"少了 243 条错"，是**让下一格的错误可见**。

改成 `core/host/native.js` 之后剩 **8 处 / 5 个名字**，这是真债：
`readBinary`、`writeBinary`、`removeFile`、`stdoutBytes`、`stderrBytes` 在
`host/native.js` 里有 node 实现，但封闭 ABI（决策 2）的 op 表里没有对应项 —— 也就没有
运行时那一头。要开这一格，得三条腿一起加：C 运行时、JS prelude、解释器。

棘轮因此从三条断言变成四条：`BASE_DUP = 0`、`BASE_NS = 0`、`BASE_ABI = 8`，外加"不许出现
第四类"。

## 落地顺序

1. ✅ 运行时出 JS，变成真的 C 文件树 + `.o` 缓存 + `--amalgamate`
2. ✅ 字符串拼接 O(n)（arena 原地追加 + `join`）与 arena 分配（第 4 节第 2、3 项）
3. ✅ JS 前端第一版（`src/core/frontend-js/`：词法器 + 语法分析器 + 生成器），
   `src/core` 全部文件解析通过，未覆盖的语法一律报错
4. ✅ `tests/js-roundtrip/`：幂等 + 语义一致两条断言都立起来了。语义一致那条是
   "整棵树重新生成，用生成出来的编译器跑 `tests/run.js` 与 `tests/oracle/run.js`，
   输出逐字节相同"（30 + 6 个用例）。当天抓到两个"解析成了错的东西"的 bug，见第 3 节。
5. ✅ 写 `docs/js-bootstrap-subset.md`，冻结子集（提前到第 6 项之前做，因为闸门 4 一立起来
   子集就已经被测试钉死了，文档只是把它写下来）
6. JS AST → OIR 的降级，然后打通 C0 → C1 → C2，验不动点。
   **这一步还没开始**，而且拦路虎不在前端：闭包 / 函数值已经落地（ADR-0010），还差异质
   记录对象、异常，以及一批宿主库设施（清单在 `docs/js-bootstrap-subset.md`）。

## 被否掉的方案

- **用 Omni 语法重写编译器再自举**：多一整轮翻译，而且不动点更弱（只证明新编译器自洽，
  证不了 JS 前端和 C 后端一致）。我们也不需要"Omni 写的编译器"来证明语言可用 ——
  能编译 4485 行 JS 已经是同等强度的证据。
- **自举走 JS 后端**（生成 JS 再用 node 跑）：那不是自举，只是换个方式调用 node。
- **先做 ARC 再自举**：编译器是批处理，arena 更简单也更快。ARC 的价值在长期运行的程序上，
  为自举做 ARC 是把难的事放在前面而收益在后面。
- **靠 LTO 而不是 `static inline`**：tcc 不支持，而 tcc 是我们想要的"毫秒级 C 编译"路径。
