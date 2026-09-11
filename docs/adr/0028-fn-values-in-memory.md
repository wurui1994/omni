# ADR-0028：函数值能落进内存（当结构体字段、经指针读写）

状态：已落。四条腿（`run` / `run-llvm` / `interp` / `interp --mir`）逐字节相同，
用例 `tests/sexpr/cases/42-fn-field.sx`。

## 为什么现在做

jancy 语料的尺子上，`类型是函数指针（…）的字段` 是剩下最大的一格 —— 两行合起来 **170 对**
（`.omni-cache/test/log/jnc-sweep.log` 里 90 + 80），而且它是"方言的布局还差几格"那一族里
的最后一格：另两格（匿名 union、位域）分别由 ADR-0027 与 ADR-0016 第一百一十二刀落完了。

诊断的出处是 `src/core/hir/types.js` 的 `structLayout`：`sizeOf((fnty …))` 落到最后那句
`return 0`，于是整格结构体判"落不了地"，`(ptr S)` 也就不收。

## 先纠一处读错了的前提

落之前记的账里（含 ADR-0016 里几处、任务 #39 的描述）说函数值是 ADR-0010 那个
**胖值 `{fp, c_*}`**。**读错了。** ADR-0010 §4 选的是**一个**指针：

> `docs/adr/0010-function-values.md:84-85`：把"**记录自己当作第一个实参传进去**，而不是另外
> 传一个 env 指针。于是函数值是**一个**指针，不是'函数指针 + 环境指针'的胖值"

而胖值在同一份 ADR 的**否决清单**里（`:153`）。`{fp, c_*}` 是**堆上那条闭包记录**的布局，
不是那格值的布局 —— 值是指到那条记录的一个指针。

这一处错得要紧，因为它决定这一刀落在哪一档：胖值就是 ADR-0026（string）那一档"多个字的按值
聚合"，一个指针就是 ADR-0024（arr）那一档"引用语义的句柄，一个字"。**是后者。**

## 判据：为什么是 ADR-0024 那一档

ADR-0024 那条路走得通的前提是"在两条原生腿上它**本来就是**一个字的指针"，于是那两条腿一个字
都不用改。逐条对：

- **C**：`typedef struct omni_closure_s *omni_fn`（`src/runtime/omni.h:135-137`）—— 与 arr 那条
  `typedef struct omni_arr_i64_s *omni_arr_i64` 一模一样的形状；
- **LLVM**：`if (t.k === 'fn') return 'ptr'`（`src/core/backend-llvm/emit.js:1626`），而且那一行
  的注释**早就**写着"与'类字段'同一条：引用语义，COPY 拷的是句柄"；
- 这一层在别处也**早就按 8 算了**：`arrIsBlob` 把 `fn` 与 `class` / `arr` 放进同一桶
  （`hir/types.js` 那处），两条原生腿的数组元素步长就是 `esz = 8`
  （`backend-llvm/emit.js:1651-1652`、`:2083`）；
- `isRef` 早就把 `fn` 划进引用语义（`hir/types.js` 那处）。

对照 string（ADR-0026）：它**不**满足这个前提 —— C 那边是 `omni_str{const char* p; int64_t len;}`
（16 字节按值）、LLVM 那边是 `[2 x i64]`，所以那一刀定的是 16 而不是 8。

结论：`sizeOf((fnty …)) = 8`、`alignOf = 8`。

## 改了什么（六处，两条原生腿零改动）

1. `src/core/hir/types.js` 的 `alignOf` / `sizeOf` 各一支 → 8；
2. `src/core/interp/builtin.js` 的 `ptrLoad` / `ptrStore` 各一支 —— 一个字的句柄 id，
   对象挂在 `handles` 上，**id 0 是错**（`null reference`）；
3. `src/core/backend-js/emit.js` 的 `jsPtrLoad` / `jsPtrStore` 各一支 —— **直接复用 arr 那一对**
   `$pload_h` / `$pstore_h`：两者在这条腿上是同一件事，所以 prelude 一个字都不用加；
4. `src/core/mir/interp.js` 的 `memKind` 加 `T_AGG -> 'fn'`（外加把 `T_AGG` 加进 import）。

**零改动**：`backend-c/emit.js`（`PtrLoad`/`PtrStore` 本来就按 `cTypeName` 泛型发，
`fieldDecl` 早就会写 `omni_fn f_x;`）、`backend-llvm/emit.js`（`PLOAD`/`PSTORE` 按 `ty()` 泛型，
`fieldTy(fn)='ptr'` / `fieldZero(fn)='null'` 早就在）、`mir/ir.js`、`mir/verify.js`、
`sexpr/lower.js` 的字段白名单（函数类型当**按值**字段本来就收 —— `15-fnvalues.sx:58-66` 的
`fldset` 就在跑，与 ADR-0026 里"string 当值字段本来就通、卡住的只有内存那条路"一字不差）。

`ptrTargetOk` **不动**：`(ptr (fnty …))` 只从 `pfield` 出来，与 arr / string 字段同一条路。
"指到句柄自己身上"这件事 ADR-0024 与 ADR-0026 两处都明说不开，这儿照旧不开。

## 唯一比 arr 难的那一格：函数值没有自己的 MIR 类型码

`arr` 有 `T_ARR = 9`，所以那一刀直接 `T_ARR -> 'arr'`。函数值与 struct / class / enum / 容器
**共用 `T_AGG = 7`**（`mir/ir.js` 那处注释）。于是 `memKind(T_AGG)` 该回什么，要先答
"今天 `T_AGG` 会不会以别的身份走到这儿"。

**用探针答的，不是推的**，三条：

- `(pload p)` 里 p 指向结构体时 **sexpr 那一层就拒**：
  `(pload p) 的 p 指向结构体 S：整块读还没做 —— 用 (pfield p 字段名) 逐字段读`；
- `(ptr C)`（C 是一格类）**压根不是合法的指针目标**：
  `(ptr T) 的 T 只能是 int / real / bool / 结构体名 / 另一个指针 / (blk T N)，这里是 C`；
- 别的 `T_AGG`（enum / 容器）`sizeOf` 是 0，落不进内存、当不了指针目标。

所以 `T_AGG` 走到 `memKind` 只可能是函数值一种，`T_AGG -> 'fn'` 安全 —— 不用给函数值另开一个
MIR 类型码。这三条写进了那一支的注释：哪天有一条松了，那一支要跟着改。

顺带也否掉了一个担心："类的句柄当字段"要是今天已经在跑，那 `T_AGG` 早就落到 `memKind` 最后
那个 `bool` 上、是个现成的静默错答案。**没有** —— 那条路整个是关着的（第二条探针）。

## 悬空的问题：闭包记录会不会跟着栈帧走

string 与 arr 没有这个问题，函数值有：它带着**捕获**。答案是不会悬空，两条腿分别是：

- C / LLVM：闭包记录是 `omni_alloc` / `omni_ll_alloc` 出来的，也就是那块 **bump arena**
  （`src/runtime/omni_mem.c`），与结构体自己同一块内存，生命期一样长；
- JS 与两个解释器：记录是个普通对象，挂在 `$H` / `handles` 那张表上，只要 id 还在就活着。

用例里钉了这一条：在 `main` 里造 `(mkclo addk (int 100))` 存进字段，之后**换一个别的闭包进去、
再读原来那个**，两个各拿自己那一份捕获（`102` 与 `103` 两行）。

## 代价

- 与 ADR-0024 同一笔账：`$H` / `handles` 那张表**不会自己缩** —— 存进内存的每一个函数值都在表上
  占一格，那格内存被覆盖了表上那一格也不回收。记在任务 #13（arena 分阶段释放）里；
- `T_AGG -> 'fn'` 是"按排除法"得到的，靠的是上面那三条界。三条界都有测试或诊断钉着，
  可它们不在同一个文件里 —— 这是这一刀最脆的地方，所以那三条写在了 `memKind` 的注释里。

## 尺子

- `tests/sexpr/cases/42-fn-field.sx`：五条判据（普通函数、带捕获的闭包、覆盖、按字段拷一份的
  引用语义、一格结构体里两条函数值字段各自独立），四条腿逐字节相同；
- 期望值不是从实现里抄的，是手算的：`twice(21)=42`、`addk(100)(1)=101`、`twice(10)=20`、
  `thrice(21)=63`、拷过去之后 `thrice(2)=6` / `addk(100)(2)=102`、换成 `addk(7)` 之后
  `(3)=10`、原来那格 `addk(100)(3)=103`。
