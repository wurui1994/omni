# ADR-0047：JS 那一半的性能重设计（AOT 底座 + 带 JIT 的解释器 + 构建）

状态：草案（2026-09-28）。上游：ADR-0011（封闭 ABI / 全 dynamic）、ADR-0020（真对象）、
ADR-0021（分文件发射）、ADR-0045（自研 JIT）、ADR-0046（切文件）。
参考源码都在 `/Users/wurui/Documents/Lang/reference`（quickjs-2026-06-04 / LuaJIT / mujs /
cyber / v8 的 docs / ninja）。

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
