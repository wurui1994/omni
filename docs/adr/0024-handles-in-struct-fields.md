# ADR-0024：引用语义的句柄能不能放进一格结构体字段

- 状态：**S1 + S2 已落**（判据 1/2/3 五条腿全绿），S3/S4/S5 还没落
- 起因：jancy 前端第八十二刀之后，尺子上排在前面的两条账都堵在同一堵墙上
- 相关：ADR-0014（方言与四个后端）、ADR-0016（jancy 前端，第五十五 / 五十七 / 七十三 / 七十四刀）

## 背景：一堵墙，两条账，量出来的

`.omni-cache/test/log/jnc-sweep.log`（655 份语料）上这两条：

- `113  N 类里的事件 '…'（那一格是一格数组的句柄，方言的结构体字段还放不下它）`
- `104  N 类的成员上的 bindable 属性（那格事件在 jancy 那边是类里的一格字段…）`

加起来 **217 对** (文件, 拦路项)。再往后 `reactor`（`修饰符 '…'` 那 160 对里的大头，语料里
167 处）也要先有"类里的事件"—— 它的依赖发现就是"记下这一趟碰过哪些 bindable 属性"。

墙的位置**只有一处**，量过：

```
$ node src/core/cli.js run /tmp/arrfield.sx
error: 变量 b：结构体 'Box' 里有落不进内存的字段，指不到它身上（见 hir/types.js 的 structLayout）
      (let b (ptr Box) (pnew (ptr Box) (int 1)))
```

- `sizeOf((arr T))` 落到 `return 0`（`src/core/hir/types.js:142-159`），`alignOf` 同
  （`types.js:127-140`）；
- `structLayout` 见到 size 或 align 是 0 就回 null（`types.js:162-176`，判在 169 行）；
- 于是 `(ptr Box)` 被拒（`src/core/sexpr/lower.js:297-303`）。

注意**不是**"结构体不收数组字段"：`(struct Box (a (arr int)))` 今天就编得过 ——
`(arr T)` 本来就在字段类型的白名单里（`sexpr/lower.js:817-823`）。拦住的是**指向它** ，
而 jancy 的类在这一层恰恰是 `(ptr 根)`（ADR-0016 第五十二刀）。所以这一格是"类的字段"
与"结构体的字段"之间唯一的差别。

理由写在 `types.js:84-85`：string / arr / buf / class / fn 是**宿主句柄**（JS 侧是对象、
C 侧是指针），"没有可寻址的字节"。这句话对不对，是这一份要回答的问题。

## 四条腿现在拿 `(arr T)` 当什么（都是量过的）

- **C**：`cTypeName((arr int))` 就是 `omni_arr_i64`，而那是个**指针的 typedef** ——
  `typedef struct omni_arr_i64_s *omni_arr_i64;`（`src/runtime/omni.h:322-344`），
  len/cap/items 在被指向的头里。它**今天就已经是 C 结构体的字段**
  （`backend-c/emit.js:887-910` 的 `fieldDecl` 发的就是 `omni_arr_i64 f_a;`），
  只是没人能对那个结构体取 `(ptr S)`。
- **LLVM**：`T_ARR -> 'ptr'`（`backend-llvm/emit.js:56-58`），字段类型也已经是 `ptr`
  （`emit.js:1616-1618`，那儿的注释还明写了"数组字段存的是句柄，所以逐字段拷出来的两个
  结构体共用同一条数组"）。六条数组指令全是 `call`，一个字段都不摸。
- **MIR**：`T_ARR = 9`，注释就写着"**一个指针**"（`mir/ir.js:63-66`）；`PLOAD`/`PSTORE`
  带着目标类型与字节数（`ir.js:292-293`），`verify.js` 里没有目标类型的白名单。
- **JS 与两个解释器**：`(arr T)` 是一个**普通的 JS 数组**（`backend-js/prelude.js:353-372`、
  `interp/builtin.js:621-634`，两个解释器共用后者）。而指针的那一格内存是一块
  `ArrayBuffer` + `DataView`（`prelude.js:183-190`、`builtin.js:405-416`），
  load/store 只认 int / real / ptr / tptr，别的**默默当 bool**
  （`backend-js/emit.js:39-42`、`builtin.js:436-457`）。

**所以这堵墙不是四条腿共同的限制，是 JS 那一族的**：C / LLVM / MIR 三条腿把
`sizeOf` 改成 8 之后一个字都不用动（`PtrLoad` 会展开成
`*(omni_arr_i64 *)omni_pchk(p, 8)`，合法 C；LLVM 那边是 `load ptr` / `store ptr`）。
JS 与两个解释器过不去的原因很具体：**一个 JS 数组塞不进 ArrayBuffer**。

## 决策要回答的那一个问题

给 JS 那一族一格"把宿主对象放进那块内存"的表示。两条路：

### 甲：句柄表（arena 里存一个整数 id，对象在旁边的表里）

- `$anew` 之后给对象派一个 id，`$handles[id] = obj`；字段里存的是那个 id（8 字节整数）；
- `pload` 那一格按 `arr` 取出 id 再查表，`pstore` 反过来；
- **代价说清**：那张表**不会自己缩**。一个对象只要进过某格字段就永远在表里 —— 除非再加
  一格引用计数或者"这块 arena 释放时把它名下的 id 一起划掉"。后者与 ADR-0013 那格
  arena 的分阶段释放（任务 #13）是同一件事，可以合起来做。
- 好处：C / LLVM 那两条腿一个字不用改，四条腿看到的**语义**一样（引用语义、共用同一条数组）。

### 乙：让这类字段一律经一格"侧车"结构（arena 里只存索引，对象挂在一格对象数组上）

与甲的差别只是表的所有权在哪儿（每个 arena 一张，还是全局一张）。省下"全局表不缩"这一条，
但要求每一处 `pfield` 都知道自己属于哪个 arena —— 而 fat 指针里本来就有 base，所以做得到。

**倾向甲**（一张全局表 + 与 #13 一起做释放），理由是它不动指针的表示；乙要给 fat 指针
再加一格含义。

## 判据（落地时必须同时成立）

1. `tests/sexpr` 里加一份 `.sx`：结构体带一格 `(arr int)` 字段、对它取 `(ptr Box)`、
   `pstore` 进去再 `pload` 出来 `aget` —— **五条腿逐字节相同**。这一条是整件事的本体：
   四条腿的表示不一样，逐字节相同才说明"句柄"这个概念在四条腿上是同一个东西。
2. 引用语义要**被钉住**：把那个结构体按值拷一份（`COPY` 那条逐字段 load/store），两份共用
   同一条数组 —— 改一份另一份看得见。LLVM 那边的注释已经承诺了这条行为
   （`backend-llvm/emit.js:1616-1618`），所以这是"把已有的承诺写成测试"。
3. 空句柄要报得出来：`pnew` 出来的那一格是零，读它必须是"null reference"那一句
   （`omni.h:356` 的 `omni_err_null` 已经有），五条腿同一句 —— 与 tests/sexpr 的 rt/ 那组
   同一条规矩。
4. `tests/jnc` 那边：`bad/class-event.jnc` 从 bad/ 搬进 cases/，六条腿逐字节相同。
5. 那张句柄表不许成为**静默的**内存泄漏：要么这一刀就接上释放，要么在 ADR-0013 里
   记一条"已知会涨"的账并给出量（一趟 tests/all 之后表里剩多少格）。

## 分步

- **S1**（已落）：`sizeOf`/`alignOf` 给 `arr` 定成 8/8（`hir/types.js`）。C / LLVM / MIR
  三条腿**一个字都没改** —— 与上面量出来的一致：`omni_arr_i64` 本来就是指针的 typedef、
  LLVM 那边 `T_ARR -> ptr`、MIR 的 `PLOAD`/`PSTORE` 本来就带类型与字节数。
- **S2**（已落）：句柄表落到 `interp/builtin.js`（两个解释器共用，`handles`/`handleId`）
  与 `backend-js/prelude.js`（`$H`/`$hid`/`$pload_h`/`$pstore_h`）。
- **S3**：jnc 那边把"类里的事件"接上（第七十四刀留的账），判据 4。
- **S4**：`bindable` 的成员属性（尺子上那 104 对）跟着 S3 一起过。
- **S5**：`reactor` 才有前提（那是自己一刀，不在这一份里）。

### S1/S2 落下来时踩到的两格「静默的默认」

两处都是"链式三元表达式的最后一格是 bool"，加一种能落进内存的类型时**忘了加一支就会被
默默当 bool 读写**。这不是这一刀引进的，是这一刀撞上的 —— 记在这儿，下次加类型先看这两处：

1. `backend-js/emit.js` 的 `jsPtrLoad` / `jsPtrStore`：`int / real / ptr / tptr` 之后
   直接 `'$pload_b'`。
2. `mir/interp.js` 的 `memKind`：同样的形状，最后一格 `'bool'`。量出来的症状不是红，是
   **宿主的 TypeError**（`arrLen` 拿到 `undefined`，`Cannot convert undefined to a BigInt`）——
   一句用户看不懂、也不指向真问题的话。

第三处顺手确认了不用改：`hir/types.js` 的 `ptrTargetOk` 仍然拒 `(ptr (arr T))`
（`types.js:98-101`）—— 那是"指向句柄自己"，与"句柄当字段"是两件事（见「不做的」）。

### S1/S2 的验收（都跑过了）

- `tests/sexpr/cases/39-handle-field.sx` + `rt/handle-null.sx`：**五条腿**逐字节相同
  （`OMNI_LEGS=all node tests/sexpr/run.js` -> 85/0）。判据 1、2、3 全在这两份里：
  存取、按字段拷一份之后两份共用同一条数组（`5 7 9 1 2 11 1`）、空句柄五条腿同一句
  `null reference`。
- 改的是汇聚层（`hir/types.js`），所以按 ADR-0023 那条规矩跑了 `all`：
  **17/17 个套件通过，252.9s**（跳过 1 条：输入没变）。
- 判据 5（那张表不许成为静默的泄漏）：**还没做** —— 现在它只涨不缩，账记在这儿与任务 #13。

## 不做的

- **不**给 string / buf / fn / class 一起放开。它们各有各的账：`buf` 是**按值**的
  `{len, ptr}`（`omni.h:322-324` 那段注释明写了与 arr 的差别），`class` 的 size 是 0 但
  jnc 的类引用在这一层本来就是 `(ptr 根)`、不是 class 那一格。一次只放一格，判据才说得清。
- **不**把 `(ptr (arr T))` 放开（`types.js:98-101`）。那是"指向句柄自己"，与"句柄当字段"
  是两件事。
