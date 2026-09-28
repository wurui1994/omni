# ADR-0047：JS 那一半的性能重设计（AOT 底座 + 带 JIT 的解释器 + 构建）

状态：草案（2026-09-28）。上游：ADR-0011（封闭 ABI / 全 dynamic）、ADR-0020（真对象）、
ADR-0021（分文件发射）、ADR-0045（自研 JIT）、ADR-0046（切文件）。
参考源码在 **`/Users/wurui/Documents/Lang/reference`（不在本仓库里）**：quickjs-2026-06-04 /
LuaJIT / mujs / cyber / v8 的 docs / ninja。树里另有一份读码笔记
`docs/notes/jit-jancy-cyber.md`（§2.5 就是 copy-and-patch 那一节）。

> **刀号撞名，先说清**：ADR-0045 的 D1~D4 是**另一条腿**（MIR → 机器码 → 就地跳进去，
> 仿 Ken 的 `kasm87`，为的是摆脱 LLVM 那 100MB 依赖 + 1.8s 启动）。这一份 §4 的 D1~D4 是
> **JS 字节码 VM → copy-and-patch 基线 JIT**。两者的 "D2" 完全不是一件事；下文凡提 0045 的
> 刀一律写成 "0045-D<n>"。两条腿共用同一格可执行内存件（`src/jit/omni_ffi_host.c`）。

## 0. 为什么要这一份

`dist/omni` 跑一份 2MB 的 `.asy` **30s 还词法不完**，同一份活 node 腿冷 6.96s。
三刀微优化（实参 list 上栈、对象字面量一次建好、装盒按子树收紧）各自打掉一个 20~30% 的
大头之后，采样榜**变平**了：

    lexText 自用 9.66% · omni_dyn_want 7.82% · omni_js_obj_getk 含子 16.84% ·
    omni_dyn_as_ref 含子 11.49% · is_int 4.37% · omni_js_as_s16 4.20%

平就是结论：**剩下的不是几处浪费，是值表示、对象表示、调用约定这三条底座定错了。**
ADR-0011 当年明写接受它（「慢是预期的，判据是不动点不是速度」、「每个字段访问都是一次
dict 查找 —— 接受」）。这一份来还那笔债。

口径（先钉死）：**一趟 30s、冷态就是判据**；不许靠加时间，不许靠预打包/暖缓存绕过去；
目标是**不比 V8 慢**（同一份负载，我们 AOT 到 C + `clang -O2` 对 node）—— 这个目标合理：
我们有整程序信息与 AOT，V8 没有。

## 1. 现状的三条底座（都在明处、都可量）

**值**：`omni_dyn`（`src/runtime/omni.h:150`）= `{int tag; union{…}}`，对齐后 **24 字节**、
按值传递 ⇒ 每个动态值 3 个寄存器/栈槽。`omni_dyn_want`（`omni.h:1115`）是每个 `as_*` 的前缀。

> **先纠一条错**（2026-09-28，第一版草案写错了）：`omni_errorf` **早就标了 `OMNI_NORETURN`**
> （`omni.h:198`），所以"检查提不出循环"这个解释是假的。真正的解释更简单也更刺眼：
> **`build:native` 默认 `-O0`**（`cli.js:3327` 的 `optFlag()`，`OMNI_OPT` 不给就是 `-O0`）
> ⇒ 那些 `static inline`（`omni_dyn_want`/`as_*`/`is_int`）**一个都没被内联**，每次都是
> 一次真函数调用、还要按值传一个 24 字节的结构。榜上 `dyn_want` 7.82% + `is_int` 4.37% +
> `as_s16` 4.20% + `dyn_as_ref` 自用 3.79% 这四格，**大部分是 `-O0` 自己**。
> 所以刀序改了：**`OMNI_OPT=2` 重建一趟先量上限**（§8 的 G 提到第一位），
> 再决定值表示/对象/调用约定那三条要不要动、动多少。

`is_int`（`omni_js.c:528`）连 inline 都没有（`-O2` 下同一文件内可内联，跨文件要 LTO）。
INT/UINT 分两格 tag ⇒ 每个算术多问一次。

**对象**：普通对象 = `dict<string,dynamic>`（`omni_container.h:97`），≤8 格线性扫 + 逐格
`memcmp`，跨过门槛 `_rebuild` 全体重哈希；`omni_js_obj_getk`（`omni_js_obj.h:458`）在碰到
dict 之前先过 **6 组 tag+memcmp 分支**，未命中升原型那一步 `omni_s16_of_utf8(key)` 是
**一次分配**。真对象每格属性是**一条 8 元素 list**（`omni_js_obj.h:760`）。
**没有 shape、没有 inline cache**，键还在 UTF-8/UTF-16 之间来回（ADR-0021 点名"三次分配"）。

**调用**：`omni_dyn f(omni_fn self_, omni_list_dynamic a0)` —— 每次一条 `list<dynamic>`
（`js_abi.js:732`：「JS 的函数在 Omni 里只有这一个签名」），形参入口用 `js_arr_get` 逐个绑，
被捕获变量是**一格 1 元素 list**。

**还有一条**：JS 腿**不过 MIR**（`backend-c/emit.js` 是 OIR→C99），`OMNI_MIR_OPT` 那套一格
都不生效；接上也没用 —— 所有 JS 语义都是对运行时的**不透明调用**，优化器看不进去。
⇒ **优化必须发生在"发射什么"这一层。**

## 2. 我们已经有的资产（不必从零）

* **`src/core/ir/lua-rt.h`** —— lua 那条腿把四件事**都做完了**：NaN boxing（`OVal` = 8 字节、
  与 LuaJIT 同编码，且**故意砍掉 int tag**，理由在 `:20`）、**shape**（字段名→偏移、不可变、
  增键迁移、`tnext` 转移缓存，`:373`）、**IC**（`OIC{shape,meta,gen}` + 全局 `omni_ics` 数组 +
  `omni_shape_gen` 一次性失效，`:789`）、**帧 arena**（每协程一份，`vm.c:92`）。
* **字节码 VM + tier1 JIT 骨架**：`src/core/lua/vm.c`（1317 行）、`jit-a64.c`（2846 行，
  `MAP_JIT` + `pthread_jit_write_protect_np` 的 W^X）、`ssa.c`、`emit-bc.js`。
* **LLVM ORC**：`src/jit/omni_jit.c`（含 `LLVMOrcLLJITAddObjectFile`：直接摆一份对象码进去）。
* **可执行内存 / 注入机器码**那条路（三种办法都在 node 里量过）。
* **ninja 引擎已经在主干**：`src/core/build/{graph,plan,run,manifest,lexer,script,api}.js`
  （与 Omni-R / Omni-Python 两棵树**逐字节相同**），入口 `omni ninja -f <build.js>`
  （`cli.js:6532`）；生产样板是 `Omni-R/ext/r/build.js`（125 条边）与
  `Omni-Python/ext/python/build.js`。

## 3. 决定一：两条腿共用一套运行时底座

**把 `lua-rt.h` 里那四件事提升成公共层 `src/core/ir/dyn-rt.h`**，JS 与 lua 共用。
理由：那四件事（值表示 / shape / IC / 帧）与语言无关，而我们已经有一份**跑通过、量过的**
实现；再写第二份就是"两份实现各自一套判据"，这棵树上已经为此交过学费。

### 3.1 值：8 字节 NaN boxing，一个 tag 面

* `OVal` 照 `lua-rt.h:1` 那份（与 LuaJIT 同编码）。**不要再分 INT/UINT**：
  `lua-rt.h:20` 记着"砍掉 int tag"的理由（`1..1e7` 求和每轮溢出掉慢路，61ms 里 53ms
  是这么来的）。JS 的数是 double，整数只是一种取值范围。
* 类型检查要能被优化器提出循环 ⇒ **报错口子必须 `noreturn`**：
  `omni_dyn_want` 改成 `if (unlikely(...)) omni_throw_type(...) /* __attribute__((noreturn)) */`。
  这一条是纯改 runtime、零语义风险，**可以第一刀就做**（不必等值表示换掉）。
* QuickJS 的一条值得抄：**tag 为负 = 带引用计数**（`quickjs.h:287`），一条符号位比较就分出
  "要不要 incref"。我们现在是 arena 不数引用，这一格留到 GC 那一节。

### 3.2 对象：shape + 旁表 IC

* shape 照 QuickJS 那份**最小可抄版本**（`quickjs.c:968`）：`JSShapeProperty` 8 字节
  （`hash_next:26 | flags:6 | atom`），**shape 自带小哈希表**，槽下标同时是 `shape->prop[]`
  与 `object->prop[]` 的下标 —— 这正是"IC 只需缓存一个整数"的根本原因。
  转移**不做 transition tree**：QuickJS 是 shape → 全局哈希表去重（`rt->shape_hash`），
  比 V8 的 TransitionArray 简单得多，够用。初始 `prop_size=2 / hash=4`，
  **不留"小对象线性数组"那一档**（我们现在的 `OMNI_DICT_SMALL=8` 线性 + memcmp 就是那一档，
  它的代价已经量在榜上）。
* IC 照 V8 的形状（`reference/v8/docs/runtime/hidden-classes-and-ics.md`）但只做第一档：
  * 缓存 `{uint32 shape_id; uint32 slot_index}` 8 字节，**monomorphic only**，miss 就覆写；
  * 放**旁表**（`omni_ics` 那种全局数组，`lua-rt.h:789` 已有），字节码/发射出来的 C 里只带
    一个**编译期常量 slot id**。选旁表不是风格问题：字节码要能放只读段，内嵌可变格子会逼
    我们把它放可写内存；JIT 也要能顺序扫 feedback。
  * 原型链上的属性**第一版不缓存**（走慢路）⇒ 可以完全跳过 V8 的 validity cell。
  * 失效：自有字段靠 shape 比较自然 miss；原型改动用一个全局 `omni_shape_gen` 自增
    （`lua-rt.h:409`/`:729` 已经这么做）。
* **键的编码边界要消掉**：属性名一律**驻留成 atom**（一个整数 id），UTF-8/UTF-16 两种视图
  各自缓存在 atom 表里，发射出来的 C 只带 atom id。ADR-0021 点的"`o.foo` 三次分配"就此消失。

### 3.3 调用：去掉"每次一条 list"

* 签名改成 **按 arity 特化**：`omni_dyn f0(omni_fn)`、`f1(omni_fn, OVal)`…… 到 `f4`，
  更多实参或 `arguments`/rest 才退回一条 list。发射端已经知道 callsite 的实参个数，
  被调方也知道自己的形参个数；不一致时由**桥接 thunk** 补 undefined / 收成 list。
  这一刀把"入口 n 次 `js_arr_get`"与"出口一条 list 的构造"一起去掉。
* 被捕获变量的盒子：**只有真被内层函数写过**才要盒子；只读捕获直接按值进闭包记录
  （现在一律装盒）。这一条是纯发射层判据，与 §3.1/§3.2 无关，可以单独上。
* `omni_fn` 记录第一字段仍是 `fp`（`omni.h:184` 那条约定不动），只是 `fp` 的类型按 arity 分。

> ADR-0011 的封闭 ABI 说"改签名要动闭包记录、MakeClosure 与两个后端的调用约定"
> （`js_abi.js:273`）。这份 ADR 就是那个"要动"的授权：三处一起改，判据是 `fix:self`
> （自己编自己逐字节相同）+ `check:self`。

## 4. 决定二：带 JIT 的 JS 解释器，分四档

前端（词法/语法/字节码/JIT 的代码生成）**全在 JS 里**；运行时那一半通过封闭 ABI/FFI 进
native host。我们已经做过的那几样（可执行内存、arm64/x64 编码器、ORC）正好各归其位。

* **D1 字节码 VM（先有正确性）**：寄存器式 + accumulator，指令表照 QuickJS 的形状（244 个
  opcode 里我们只要约 120）。分派用 **computed goto**（照 `quickjs.c:17787` 那 25 行宏，
  同时留 switch 版做调试/移植）。**不要学 LuaJIT 手写汇编解释器** —— 它快的真正原因是
  把 BASE/KBASE/PC/GL 等**八个值常驻 callee-saved 寄存器**（`vm_arm64.dasc:28`），
  C 编译器做不到；而我们有 JIT 这条更好的路。
  判据：`tests/js-exec` 全过；速度只要求"不比现在的 OIR 解释器慢"。
* **D2 基线 JIT（copy-and-patch）**：照 **cyber** 那一套（`reference/cyber/src/jit/`，两个
  架构总共 3978 行）：每条操作**用 C 写一份 stencil**、以 `[[clang::musttail]] return cont(...)`
  结尾、编成 `.o`、抽出 `__text` 的机器码 + 重定位点，运行时 `memcpy` 拼接 + patch call hole
  （a64 4 字节 / x64 5 字节）+ `mprotect`。**机器码不用手写，让 clang 生成** —— 这条路省掉
  整个指令编码器，对"前端在 JS 里"的我们代价最低。
  帧布局**与解释器逐格一致**（Sparkplug 的第一原则，`v8/docs/compiler/sparkplug`）：
  于是 debugger/异常/栈回溯不用改，**deopt 退化成"跳回解释器对应 offset"**，零状态翻译。
  复杂操作不内联，`call` 现成的 builtin。
  判据：同一批例子答案不变；热循环 ≥ 3x 于 D1。
* **D3 类型反馈 + 特化**：IC 槽里顺带记 `seen_int/seen_double/seen_obj_shape`，基线 JIT 发射
  时按反馈选快路（int 加法带溢出 guard、属性访问直接 `shape==? → 偏移读`）。
  必须有 guard 的四处：整数溢出、操作数类型、`obj->shape`、调用目标。
* **D4 方法 JIT / trace JIT（最后，可能不做）**：LuaJIT 那套 trace（record + IR + snapshot +
  side trace）约 **13900 行**（不含各架构 asm），阈值 `hotloop=56 / hotexit=10`。
  只在 D3 之后仍有明确缺口时再上，先做 method JIT（SSA + 线性扫描寄存器分配）更划算 ——
  我们已经有 `src/core/lua/ssa.c` 与 MIR 那套。

## 5. 决定三：AOT（js→c）按"性能导向"重发射

AOT 与解释器**共用 §3 的底座**，区别只在"谁生成代码"。AOT 这一侧多出四件只有它能做的事：

1. **整程序类型收窄**（我们有全部源码，V8 没有）：一遍 AST/OIR 上的抽象解释，给每个表达式
   标 `int | double | string | obj{shape} | any`。凡标死的直接发原生 C 运算，不进 `js_arith`。
   这一条是"不比 V8 慢"的**主要来源** —— V8 只能靠运行期反馈猜，我们可以证明。
2. **属性访问在编译期定 slot**：同一个构造点出来的对象形状是已知的 ⇒ `o.foo` 直接发
   `obj->prop[3]`，连 IC 都不用查（IC 只留给真多态的点）。
3. **形参/返回值不装箱**：模块内可见、且所有调用点类型一致的函数，发 `double f(double)`
   这种**单态特化版**，另留一份装箱包装给外部/动态调用点（QuickJS 做不到这一档）。
4. **`clang -O2`**：现在 `build:native` 是 `-O0`（`dist/plugins/…-O0` 那行日志）。
   `-O2` 要与 §3.1 的 `noreturn` 一起上才有意义：检查能提出循环、小函数能内联。
   代价是编译时间，正是 §6 那套构建要解决的。

**不做什么**（写在明处）：不做逃逸分析后的栈上对象（先靠 arena）、不做 GC 换代
（编译器负载一趟跑完，arena 最省，见 §7）、不把 `omni_dyn` 与 `OVal` 并存两套（一次性换掉，
`fix:self` 是判据）。

## 6. 决定四：`build:native` 走 build.js/ninja —— 但前提是先切单元

**顺序不能反**。现在的图粒度是"一份 989k 行的合并 C"，13 份产物。
`docs/design/build-system.md:417` 已经把结论写下来了：

> 接外面的 ninja 不解决这件事：我们缺的不是调度器（`build/graph.js` + `plan.js` + `run.js`
> 三层早就在），而是**上游的工件粒度** —— 只要 C 腿收到的还是"一棵合并过的树"，
> 无论谁来调度都得把整棵树重做一遍。

所以第 6 节分两半：

### 6.1 先切单元（ADR-0046 的延续）

* **一个 ES 模块 = 一个 `.c` = 一个 `.o`**。名字按模块路径，不按入口（现在是整程序一份）。
* 跨模块只见**接口**：每个模块发一份 `<mod>.d.h`（导出的符号 + 单态特化版的签名），
  下游只 include 它 ⇒ 改一个模块只重编它自己 + 直接依赖者。
* 这一步复用主干已有的隐式图（`src/core/build/modules.js` 的 `UnitIndex`/`buildUnits`、
  `modcache.js` 的 `ContentIds`/`unitKey`）：**内容哈希当身份、工具指纹进键**那套不变。
* 判据：改一行 `src/core/glr/lex.js` 之后 `build:native` 只重编 1~2 份 `.o`，
  墙上时间从 3~5 分钟降到**十几秒**。

### 6.2 再上显式图（`build.js` + ninja）

* 入口：`build/native.js`（照 `Omni-R/ext/r/build.js` 那个样板），`omni ninja -f build/native.js`。
* 边的形状：`js2c`（一个模块 → 一份 `.c`，`restat = true`）、`cc`（`.c` → `.o`）、
  `ar`/`dylib`（插件）、`link`（`dist/omni`）、`gen`（数据/表/`.d.h`）。
* **引擎欠的四样，按优先级补**（都在 `src/core/build/` 里，不引外部 ninja）：
  1. **并行执行** —— 现在 `run.js:92` 明写"进程是一条一条起的"，`-j` 只限"一轮取几条"。
     照 ninja 的 `GuessParallelism` + 池；这是 13 份产物 3~5 分钟里最大的一格。
  2. **`deps_log`（`.ninja_deps` 那种二进制日志）** —— `build-system.md:126` 已点名值得照抄
     （"路径 → 稠密 id + 追加写 + 偶尔 recompact"，同时解决"中途被打断"与"启动一次读完"）。
     我们的 `js2c` 边天然知道自己读了哪些模块 ⇒ 直接吐结构化依赖，**不要 Makefile 风格 depfile**。
  3. **rspfile** —— 989k 行 C / 13 份产物的链接命令行迟早爆。
  4. **dyndep** —— `graph.js:61` 已预留（"`omni build` 在一趟里可能要重算两遍"）。
* 保持 `build-system.md` 那条纪律：**显式图只管"隐式图答不出来的活"**（生成器、打包、
  跨语言次序、判据），语言内部的模块依赖仍走隐式图。

## 7. GC：先不换

编译器这种负载是"一趟跑完就退出" ⇒ **arena（bump + 整棵释放）最省**，现在就是这样。
QuickJS 的引用计数 + 循环检测是为长驻进程准备的，我们只在 **Studio 的常驻工人** 那一档需要，
那一档已经靠"一个程序一个 arena、跑完整棵扔"解决。
⇒ 这一节只留一条：§3.1 里 QuickJS 那个"tag 负数 = 带引用计数"的位面**预留**，真要做 RC 时
不必再动值表示。

## 8. 刀序与判据（每一刀都能单独量）

口径一律 `OMNI_TIMEOUT=30` + `OMNI_PROF=sample:997`，靶子 `./dist/omni run tests/asy/cases/01-arith.asy`
（现在：跑不完）与 `tests/js-exec`（答案）。**每刀之后 `check:self` + `fix:self` 必须绿。**

| 刀 | 内容 | 预期 | 风险 |
|---|---|---|---|
| A0 | **`OMNI_OPT=2` 重建**（一行环境变量，先量上限） | `dyn_want`/`is_int`/`as_s16`/`as_ref` 四格 | 无（只是构建更慢） |
| A | `is_int`/`is_num` 进头文件 inline + INT/UINT 合并（A0 之后还剩多少再定） | 余下的那部分 | 低（纯 runtime） |
| B | 只读捕获不装盒 | 盒子分配再降一档 | 低（发射层判据） |
| C | 属性名驻留成 atom（消掉 UTF-8/16 边界） | `as_s16` 4.2% + 原型链那一次分配 | 中 |
| D | shape + monomorphic IC（`dyn-rt.h` 提升为公共层） | `obj_getk` 含子 16.8% | 高（对象表示） |
| E | 调用约定按 arity 特化 | 入口 n 次 `arr_get` + 出口构造 | 高（ABI） |
| F | 值表示换 8 字节 `OVal` | 24→8 字节的搬运 | 高（全树） |
| G | `-O0` → `clang -O2`（配 A） | 未量，需 A 先落 | 低 |
| H | 切单元（§6.1）+ 并行 + deps_log（§6.2） | 3~5 分钟 → 十几秒 | 中 |
| I | D1 字节码 VM → D2 copy-and-patch 基线 JIT | 另一条腿，判据独立 | 高（新件） |

**A/B/C/G 与 H 可以并行推进**（互不碰同一处），D/E/F 是一条链（顺序不能换：先 shape、
再调用约定、最后值表示 —— 每一步都要 `fix:self` 过）。

## 9. 当下就能做的那一刀（下一轮从这儿开始）

刀 **A0**：`OMNI_OPT=2 npm run build:native`（不改一行代码），然后 30s 口径量一次。
这一刀回答的问题是"那四格（`dyn_want` 7.82 / `is_int` 4.37 / `as_s16` 4.20 / `as_ref` 3.79）
里有多少只是 `-O0`"。代价是 cc 变慢（`-O0` 那趟 cc 2m48，`-O2` 预计翻几倍）——**这恰好是
§6 那套构建（切单元 + 并行 + deps_log）的第一个真实动机**：`-O2` 要成为默认档，构建就必须
是增量的。

量完之后才决定 A/C/D/E/F 各要不要动、动多少。如果 A0 就把那四格压到 2% 以下，
那么下一刀应该直接跳到 **D（shape + IC）**——`obj_getk` 含子 16.84% 是唯一不会被 `-O2`
自动改善的结构问题（哈希查找就是哈希查找）。

## 10. A0 量完了：`-O2` 换掉了榜，露出真正的结构问题（2026-09-28）

`OMNI_OPT=2 npm run build:native`（987277 行 C，cc **1m13**，比 `-O0` 那趟还短 —— 机器闲了）。
30s 口径**仍然超时**（32.74s），但**榜彻底换了**：

    -O0 那一趟                              -O2 这一趟
    lexText 自用 9.66%                      dict_string_dynamic_find 自用 25.50%（含子 31.94%）
    omni_dyn_want 7.82%                     dict_set_h 13.05%
    omni_js_obj_getk 含子 16.84%            lexText 自用 4.31%
    omni_dyn_as_ref 含子 11.49%             memcmp 3.53% · find_h 3.53% · eq_string 2.24%
    is_int 4.37% · as_s16 4.20%             omni_dyn_want **2.78%** · obj_getk 含子 **36.20%**

两条结论：

1. **`dyn_want`/`is_int`/`as_s16`/`as_ref` 那四格里的大部分只是 `-O0` 没内联**
   （`dyn_want` 7.82% → 2.78%）。§1 里"这四格是值表示的错"那个判断要按这个修正：
   值表示的账是 24 字节的搬运，不是 tag 检查本身。⇒ 刀 A（inline/合并 tag）**降级**，
   刀 F（换 8 字节 `OVal`）的收益也要重新估。
2. **属性查找就是第一名**：`obj_getk` 含子 36.20%，其中 `dict_find` 自用 25.50% ——
   那是"小表线性扫 + 逐格 EQ"（`-O2` 把 EQ 内联进去了，所以计在 `find` 自用上）。
   ⇒ **刀 D（shape + IC）从"以后再说"变成"唯一还剩的大头"**，而且路上有一格更便宜的：

### 10.1 `OMNI_DICT_SMALL` 这个门槛是在 `-O0` 下量的

`omni_container.h:95` 那三条理由（"整串哈希比四次长度比较贵"）成立的前提是**哈希函数没被
内联**。`-O2` 下 `omni_hash_string` 被内联、`memcmp` 也被展开，八格线性扫的代价反而更高。
所以门槛改成可调（`#ifndef OMNI_DICT_SMALL`，默认先降到 **2**），重新量一趟。
这一刀一行常量、零语义风险，而且直接命中榜首 —— **量的结果无论哪边赢，都把"这个门槛该多少"
从 2026-07 那次 `-O0` 的测量里解放出来。**

### 10.2 口径补一条（写进 memory 了）

**以后量原生腿一律 `OMNI_OPT=2`**。`-O0` 那张榜会把"没被内联的 static inline"顶到前排，
照它改就是在优化编译器的内联开关，不是在优化程序。（这一条也解释了为什么上一轮那三刀
虽然各自有效、总时间却没动：它们打掉的是真浪费，而榜上排在它们后面的那些"税"其实是 `-O0`。）

## 11. 有尺子了，而且它把刀序翻了过来（2026-09-28）

### 11.1 尺子：`bench/js/run.mjs`

在这之前这一轴唯一的尺子是"重建整个编译器（1m13）再跑一份 asy"。那量得动"总时间变没变"，
量不动"属性查找这一层值多少" —— 于是任何结构改动都没法迭代。

现在：同一份 `.js`，**node（V8）** 与 **我们这条 AOT 腿**各跑一趟，报比值。四份程序各压一件事
（单态属性 / 多态属性 / 纯整数算术 / 方法调用）。三条口径都是踩过才写下的：
**量二进制不量 `omni run`**（node 空跑就 0.42s）、**`OMNI_OPT=2`**（§10.2）、
**交错跑各取最小**（这台机器抖 ±5%，比一刀的收益还大）。每份程序印校验和，
**答案不同的那一栏不许上榜**。

    程序            node(V8)     我们     倍数   构建
    int-loop         380ms  27500ms   72.4x   2089ms
    method-call      212ms   6118ms   28.9x   2221ms
    prop-mono        118ms   3053ms   25.9x    946ms
    prop-poly        188ms   3054ms   16.2x   1261ms

### 11.2 头一条结论：**最慢的那份一个属性都不碰**

`int-loop` 只有 `+ - * >> | <=` 与一个局部变量，**72.4x**，比属性那两份都差。
所以 §10 那句"属性查找就是第一名"只在**编译器自己那个负载**上成立（它是串与字典密集的）；
**普通 JS 数值代码上第一名是另一件事**。拿采样器照那份二进制量一趟（`OMNI_PROF=sample:997`）：

    is_int              自用 26.58%     <- 一个 tag 检查
    to_num1             自用 10.47%  (含子 18.32%)
    to_i32              自用 10.40%  (含子 21.36%)
    omni_js_arith       自用  8.50%  (含子 29.08%)
    is_num              自用  6.09%
    omni_js_bitop       自用  4.91%  (含子 30.94%)
    want_num 4.36% · omni_js_cmp 4.35% · omni_js_add 4.03% · omni_dyn_of_real 3.91%
    js_objlike          自用  2.80%     <- 一个"是不是对象"的检查，而这循环里没有对象

**一行整数算术都没有。** 时间全花在"每个运算符一次运行时调用 + 在那里头重新看一遍 tag"上。

两件事就此定下来（都是量出来的，不是推的）：

1. **`is_int` 在 `-O2` 下仍然是 26.58% 的自用** ⇒ 它**没被内联**。运行时那二十来份 `.o`
   与生成的那份 C 是分开编的、没有 LTO，所以"header 里的 static inline"这条路对它们无效。
   ⇒ 刀 A（把 tag 检查做成真正能内联的）**从"降级"回到前排** —— §10 结论 1 那句
   "那四格里的大部分只是 `-O0`"只对**生成的那份 C 里的**调用成立，对运行时那几份 `.o`
   里的互相调用不成立。
2. **真正的大头是"发射层放弃了所有已知类型"**：`s + i * 3` 明明两边都是整数、`s` 明明是个
   局部变量，我们照旧发 `omni_js_arith(...)`。⇒ §5.1（整程序类型收窄）不是"以后再说的优化"，
   **它就是这一轴的主干**。这也是"我们能不比 V8 慢"的唯一理由：V8 只能靠运行期反馈猜，
   我们有全部源码、可以证明。

### 11.3 刀序按这个改

| 刀 | 内容 | 判据（`bench/js/run.mjs`） |
|---|---|---|
| **J1** | 发射层给能证明的整数/浮点运算发原生 C 运算（§5.1 的最小可用版：局部变量 + 字面量 + `\|0`/`>>` 那一族） | `int-loop` 72.4x -> 目标个位数 |
| **J2** | 局部变量不装箱（只读捕获不装盒那一条的延伸） | `int-loop` 再降；`method-call` 跟着降 |
| **J3** | 调用约定按 arity 特化（§3.3） | `method-call` 28.9x |
| **J4** | shape + monomorphic IC（原刀 D） | `prop-mono` 25.9x / `prop-poly` 16.2x |
| **J5** | 值表示换 8 字节（原刀 F） | 全表 |

**"把我们那台 C 前端当 JIT 用"（`omni c jit`，ADR-0045）不在这张表里** —— 那一格解决的是
"不依赖 LLVM、启动快"，它发的码与 `omni build` 出的**是同一批字节**，所以它的性能上限
就是上面那张表。两件事各有各的账，别混。

## 12. 尺子第二次纠错：那张表一直在多算 750ms（2026-09-28 晚）

§11 那张表（9.9x / 16~72x）里有**两个都不是被测程序的东西**：

1. **只量了我们自带的后端**（§11 已改：加了 `clang -O2` 一栏）；
2. **`spawnSync(..., { encoding: 'utf8' })` 每趟白加约 750ms** —— 量出来：同一份二进制
   真实 ~280ms，收 stdout 那种报 **1047~1106ms**，`stdio: 'ignore'` 报 **284ms**。
   四份程序一度在表上都是 "~1020ms"（**与程序无关的常数**），那个"巧合"就是它。
   现在计时那几趟一律 `stdio: 'ignore'`，校验和单独跑一趟不计时。

改完之后（J1 + 位运算快路都在里头，min of 3，丢掉第一圈）：

    程序           node(V8)   clang-O2    vs V8
    int-loop         273ms     220ms      0.8x      <- 我们更快
    method-call      214ms     681ms      3.2x
    prop-mono        197ms     460ms      2.3x
    prop-poly        182ms     119ms      0.7x      <- 我们更快

**结论要改两条：**

* "我们比 V8 慢一个数量级"**不成立**。纯数值那一族（int-loop / prop-poly）已经追平甚至更快 ——
  那是 AOT 这一侧的结构优势（V8 只能靠运行期反馈猜类型，我们在编译期就把单态那一格发出来了）。
* 剩下的两格是**属性与调用**：`prop-mono` 2.3x（哈希查属性 ⇒ 刀 J4 shape+IC）、
  `method-call` 3.2x（每次一条 list 的调用约定 ⇒ 刀 J3）。刀序不变，但**预期收益要下调**：
  这是 2~3 倍的事，不是 10 倍。

**口径补两条（都写进 memory 了）：**
* 判"我这一刀有没有用"用 `bench/lua/ab.js` 交错比**两份二进制**，别看表上的绝对值 ——
  node 那一栏跟着机器负载飘（同一份程序量到过 134~438ms）；
* 计时的 spawn 一律 `stdio: 'ignore'`。要 stdout 就另跑一趟不计时的。

## 13. 属性那一轴：`memcmp` 那一格（2026-09-28 晚，J4 的前哨）

`method-call` 与 `prop-mono` 的采样长一个样，而且**都不是调用约定的错**：

    omni_js_obj_getk                自用 38.36%（含子 72.87%）
    omni_dict_string_dynamic_find_h 自用 25.04%
    _platform_memcmp                自用 13.00%
    omni_js_call_this               自用  2.89%   <- 调用本身很便宜

⇒ **刀 J3（调用约定按 arity 特化）的预期收益要下调**，J4（属性）才是这两行的共同瓶颈。

先捡了 J4 路上最便宜的一格：`omni_eq_string` 对 **≤8 字节的键不叫 `memcmp`**，逐字节比。
属性名几乎都是 1~8 字节，那 13% 全是调用开销、不是比较本身。判据是"与 memcmp 逐位同义"
（长度已相等 ⇒ 逐字节全等 ⇔ memcmp == 0），新判据 `tests/js-exec/cases/61-prop-key-shapes.js`
压 22 种长度/形状（含 >8 字节、只差最后一字节、非 ASCII、删键之后）。

    交错 A/B（method-call）：564.8 -> 449.0ms，B/A = 0.795

整张表（min of 3）：

    程序           node(V8)   clang-O2    vs V8      （这一刀之前）
    int-loop         255ms     197ms      0.8x        0.8x
    prop-poly        198ms     130ms      0.7x        0.7x
    prop-mono        222ms     280ms      **1.3x**    2.3x
    method-call      181ms     391ms      **2.2x**    3.2x

**小表那一档（`icap == 0`，n ≤ `OMNI_DICT_SMALL`）是线性扫 + 逐格 EQ**，所以短键比较
在属性密集的负载上是直接命中榜首的一格。剩下的两行还差 1.3x / 2.2x，那才是真的
shape + IC（每个调用点缓存 `(dict, ver, slot)`，命中就是两次比较 + 一次定偏移读）。

## 14. J4 的具体形状（属性读的单态 IC）—— 设计，下一轮照这个做

> **已落地**（2026-09-28 晚）。落地后的形状与这一节有三处不一样，账与理由在 §15。

这一节写在**机器忙的时候**（load 8.51，同一对二进制 A/B 连跑三趟给 1.127 / 1.209 / 0.875
—— 仪器 ±20%，量不了 10% 量级的刀）。所以这一轮不改性能代码，把下一刀的形状定死。

### 14.1 为什么是它

`method-call` 与 `prop-mono` 的采样（memcmp 那一刀之后）：

    omni_js_obj_getk                自用 44.33%（含子 69.46%）
    omni_dict_string_dynamic_find_h 自用 27.09%
    _platform_memmove               自用  7.88%
    omni_js_call_this               自用  <3%     <- 调用本身不是问题

`a.dot(b)` 每次是**两趟 dict find**：自己那格 miss（线性扫 2 个键）、原型那格 hit。
IC 命中之后这两趟都不做 —— 这是这两行剩下的 1.3x / 2.2x 的主体。

### 14.2 IC 那一格存什么

**按调用点一格**（`static` 变量，emitter 发），只做单态：

```c
struct omni_js_ic_s {
  void *own;        /* 当时那个对象的 dict 指针（不是对象本身：dict 才是键住的地方） */
  int64_t own_n;    /* 当时 own->n（条目数，含墓碑） */
  void *hold;       /* 真正找着的那格 dict（可能就是 own，也可能是原型链上的某一格） */
  int64_t hold_n;   /* 当时 hold->n */
  int64_t slot;     /* hold->keys[slot] / hold->vals[slot] */
};
```

命中的判据（**全是整数/指针比较，一个哈希与 memcmp 都不做**）：

```c
d == ic->own && d->n == ic->own_n
  && H->n == ic->hold_n && H->live[ic->slot]
  && H->keys[ic->slot].p == key.p          /* 常量键：同一格静态串，指针相等 */
```

### 14.3 为什么 `n` 够用（不必给 dict 加版本号）

* `n` 只在**插入**时涨（删除只把 `live[i]` 置假、`n` 不动）⇒ `n` 不变 ⇒ 没插过新键
  ⇒ `keys[i]` 的身份没变（rehash 只重建 `idx[]`，不动 `keys[]`）；
* 删除用 `live[slot]` 那一格挡住；
* 键的身份用**指针相等**挡住（常量键来自同一格静态串池，见 `s16PoolLines`）。
  指针不等就当没命中、走慢路 —— 那是保守的方向，不会答错。

⇒ **不动 `omni_container.h` 的结构**（那是十一门语言共用的），风险只在 `omni_js_obj.h`
与发射层。这一条是选这个形状的主要理由。

### 14.4 发射层那一半

`backend-c/emit.js` 里 `js_obj_get` 的常量键那一支（`constKey(e.args[1])` 那格，现在发
`omni_js_obj_getk(o, "k")`）改发：

```c
static struct omni_js_ic_s ic_37;      /* 文件作用域，一个调用点一格 */
... omni_js_obj_getk_ic(o, "k", &ic_37) ...
```

`this.x` / `o.x` / `a.dot` 全走这一支。**非常量键不给 IC**（那一格本来就要先把键算出来）。

### 14.5 判据

* 正确性：`tests/js-exec/cases/61-prop-key-shapes.js` 之外再加一份**打 IC 的**：
  同一处代码先读 A 形状、再读 B 形状（多态 ⇒ IC 每次失效、答案必须照旧）、
  中间 `delete` 一个键、中间给对象**加**一个键（`n` 变 ⇒ 必须失效）、原型上改一格方法。
  少任何一格，IC 都可能"答旧值"，而那是最难查的一类错。
* 性能：`bench/lua/ab.js` 交错比两份二进制，**等 load < 2 再量**。
  目标：`prop-mono` 1.3x -> ≈1.0x、`method-call` 2.2x -> ≤1.5x。

## 15. J4 落地了，而且形状与 §14 的设计有三处不一样（2026-09-28 晚）

代码：`omni_js_obj.h` 的 `struct omni_js_ic_s` + `omni_js_obj_getk_ic`、
`backend-c/emit.js` 的 `js_obj_get` 常量键那一支（发 `&omni_ic_N`，声明发在池子那一段）。

### 15.1 量出来的（`bench/lua/ab.js` 交错、各取最小、`OMNI_CC=clang OMNI_OPT=2`）

* `prop-mono`   286.0 -> 169.5 ms（B/A = **0.593**）；对 node **1.3x -> 0.81x**
* `method-call` 477.0 -> 275.7 ms（B/A = **0.578**）；对 node **2.2x -> 1.43x**
* `prop-poly`   214.5 -> 119.8 ms（B/A = **0.559**）
* 三份答案与改之前、与 node 全相同（30000000 / 44000000 / 9000000）——
  先验答案再看时间，这一条是 `feedback_perf_ruler_checks_answer` 那次踩出来的。

load 7.1 时量的（±20% 那种噪声在这里不起作用：0.56~0.59 的差是两倍量级）。
§14.5 定的两个目标（`prop-mono` ≈1.0、`method-call` ≤1.5）都到了。

### 15.2 与设计不同的三处

1. **自有那一格不认对象身份，只认下标**（设计里写的是 `d == ic->own`）。
   判据换成"拿缓存的 `slot` 去**当前**这个对象的槽表里把键验一遍"——
   一张 dict 里键是唯一的，所以"这一格的键就是它"本身即证明。
   于是 **同一个构造器出来的所有实例都命中**，而且压根不需要失效协议。
   意外的收获：`prop-poly` 那三种形状的 `x` 都落在第 0 格 ⇒ **多态站点也全命中**
   （V8 在这儿要一条 ≤4 个 Map 的线性试）。这一格是这一刀里最值钱的判断。
2. **原型那一格限深度 ≤ 1**。它必须证明"自己身上没有这个名字"，而那件事验不出来，
   只能认对象身份（`own` 指针 + `own_n` 不变）外加 `pr` 身份。深度 ≥ 2 的链**不进缓存**：
   中间那一格插了同名键就会答旧值，而那一格没人守（判据 62 的第 5 格就是这种链）。
3. **只管真对象（`OMNI_DYN_OBJ`）**。对象字面量是 `OMNI_DYN_DICT`，那一支原样交回慢路。
   这是下一刀里最大的一格：我们**自己这个编译器**在 C 腿上跑的时候，`e.kind` 这类
   读的正是 dict（`omni_js_obj.h` 里那条"解释器把 OIR 节点当 dict 读"的注）。

### 15.3 踩到的坑（同一个坑第二次）

`emit.js` 的 `fillMembers` 靠**扫发出来的文本**决定要不要把原型成员表登记进去，
而那一条写的是 `ln.includes('omni_js_obj_getk(')` —— 带左括号，认不出
`omni_js_obj_getk_ic(`。于是 `typeof xs.at` 整行变 undefined、`at.call` 报 TypeError
（`tests/js-exec/cases/44-proto-member-values.js` 当场逮到，症状与那条注里记的**一模一样**）。
改成不带括号。教训：**按文本认函数名的开关，改函数名时要一起看**。

### 15.4 判据

`tests/js-exec/cases/62-prop-ic-invalidation.js` 从六格加到 **十格**，后四格是照落地后
这两种形态补的：一批同构实例 + 同名键落在别的下标上的那一格、`defineProperty` 把数据槽
**原地**换成访问器、`setPrototypeOf` 换掉原型、同一处代码上先读真对象再读**代理**。
外加过了 07 / 25 / 28 / 29 / 35 / 43 / 44 / 46 / 49 / 53 / 54 / 60 / 61 与 `check:self`。

### 15.5 下一刀

* **J4b**：`OMNI_DYN_DICT` 也带 IC（键不带前缀，别的一样）。冲我们自己的编译器。
* **J6（真隐藏类）**：原型那一格要"按形状"而不是"按对象"，就得给 `omni_js_objv` 加一格
  shape（键集的身份）。那才是 V8 的形状层，也是 `method-call` 剩下那 1.43x 的主体。

## 16. J4b：对象字面量（DICT）那一支也带上 IC（2026-09-28 晚）

`prop-dict` 是为这一格新加的尺子（`bench/js/progs/prop-dict.js`）：形状照**我们自己这个
编译器**来 —— 一棵节点树、按 `e.kind` 派发、字段名落在不同的下标上。

* `prop-dict` 122.1 -> 82.1 ms（B/A = **0.672**）；对 node **0.379**
* 答案不变（1200000），与 node 相同

形状最简单的一种：DICT 的键**不带前缀**、值就是值（带属性位的字面量是真对象，见
`omni_js_obj_slots` 那条注），所以只要一格"按下标验键"的自有缓存（`kind == 3`），
与 §15.2 第 1 条同一个自证判据。原型上那一支（`({}).hasOwnProperty`）照旧走慢路。

判据：62 那一份加到 **14 格**（字面量的名字落在不同下标、`delete`、加键使 `n` 变、
读到原型上去），外加 03 / 19 / 34 / 53 与 `check:self`。

剩下的还是 §15.5 的 J6（真隐藏类）：`method-call` 的 1.43x 主体在"原型那一格只能认
对象身份"这件事上。

## 17. J4c：命中那一段不拼前缀键（2026-09-28 晚）

装上 IC 之后重新采样 `method-call`（`OMNI_PROF=sample:997` 直接跑二进制）：

    omni_js_obj_getk_ic  自用 42.21%
    omni_eq_string       自用 22.66%
    l_fn                      9.07%
    _platform_memmove         6.23%
    omni_js_call_this         2.83%     <- 调用本身照旧不是问题

也就是说**IC 的命中路自己成了热点**，而里头最大的两格是"拼一份带前缀的键 + 比一遍"。
槽表里的键形如 `'s' + 名字`，发射层给的是名字本身 —— 拼那一份是白搬一趟字节。
换成 `omni_js_pkeq_(表里那个键, 裸键)`：长度差 1、首字节是 `'s'`、其余逐字节比
（>8 字节才 memcmp，理由与 §13 那一刀相同）。拼那一份只留在**没命中**那条路上
（`DT##_find` 要一格完整的键）。

* `prop-mono`   163.4 -> 122.5 ms（B/A = **0.750**）；对 node ≈ **0.50x**
* `method-call` 268.2 -> 232.3 ms（B/A = **0.866**）；对 node ≈ **1.24x**
* 答案不变（30000000 / 44000000）

判据：62（14 格）/ 07 / 44 / 61 与 `check:self`。

## 18. J4d 试过了，**更慢**，已退回（2026-09-28 晚）

想法照 J1 的经验来：把 IC 的命中那一半做成 `static inline` 长在调用点上，只有没命中才真叫
一次 `..._slow`。理由看着很硬 —— J4c 之后的采样里 `omni_js_obj_getk_ic` 自用 47.30% +
`omni_js_pkeq_` 19.37%，而它做的事只有几条整数比较，那点时间"应该"是调用本身。

量出来是反的，而且**两个方向都量了**（防次序偏差）：

    method-call  新/旧 = 1.065 ；旧/新 = 0.821   ⇒ 内联那份慢
    prop-dict    新/旧 = 1.052                    ⇒ 同向

所以这一格退回原样（答案两边都对，退的理由是"量不出收益"而且是"量出了退步"）。
为什么 J1 的经验不搬得过来：J1 那一刀在常见情形下**真的少发一次调用**（两个 REAL 当场算完
就返回）；这儿不管命中还是不命中，`_slow` 那条路都还在，而守卫那三十来条指令会**抄到每一个
属性读的调用点上** —— 一份程序里那种点成百上千，I-cache 的账比省下的一次调用更贵。

⇒ `method-call` 剩下的 1.24x 只能靠 **J6（真隐藏类）**：守卫从"比一次键"变成"比一次指针"，
并且原型那一格也能变成按形状（自有形状本身就证明了"自己身上没有这个名字"）。
