# ADR-0016：jancy 前端与方言里的指针

状态：进行中（asy 那一路转为次要，空闲时推进）

## 背景

asy 那条线证的是「一门真实语言能照原样搬到这个管线上」——语法从 camp.y/camp.l 转写、
语义每一条都对着 `/opt/homebrew/bin/asy` 量。它现在停在一个明确的位置：220 个例子全部编译通过、
75 个 EPS 逐记号一样，剩下的两族（参考是光栅位图、V8 与 libm 差 1 ulp）是天生对不上的。

jancy 接上来当主线，理由不是"再搬一门语言"，而是它逼着方言长出**这条管线现在没有的那一格：
指针**。asy 全程没有指针（它的数组是句柄、结构体是引用），所以方言里 `(arr T)` / `(buf T)` /
`(class …)` 三种引用都是**不可算术**的句柄。jancy 的核心创新恰恰是"**安全的**数据指针 +
安全的指针算术"（doc/language/rst/type_ptr_data.rst），没有指针就没有 jancy。

## 借什么、不借什么

**借**：完整的语法与形式。转写源是

- 语法：`src/jnc_ct/jnc_ct_Parser/*.llk` 八份，共 4335 行（LL(k)，带手写消歧）
- 词法：`src/jnc_ct/jnc_ct_Lexer.rl`
- 语义说明：`doc/language/rst/` 四十余页（指针那一族在 `type_ptr*.rst`）
- 语料：`test/jnc/*.jnc` 158 个、7169 行

**不借**：oracle。jancy 的 `jnc` 要 LLVM + axl 才编得出来，而这一路的目标是"这门语法与形式
在这个管线上跑起来"，不是"逐字节复刻 tibbo 的实现"。所以：

> **这一路没有 oracle。**期望输出由我们自己写在测试里，理由写在测试旁边（引哪一条文档、
> 哪一个 `.llk` 规则）。这与 asy 那条线是**两条不同的纪律**——asy 那边"每一条都要量"，
> 这边是"每一条都要有出处"。哪一天真需要量某一条语义，再单独决定编不编 `jnc`。

## 决策一：指针在方言里的形状

两种指针，与 jancy 一一对应：

- `(ptr T)`——**fat**（jancy 的默认指针）。带范围，解引用与算术都查范围。
- `(tptr T)`——**thin**（jancy 的 `thin*`）。只有地址，不查。只在 `unsafe` 里可达。

fat 的表示是**三字内联** `{addr, base, size}`：

- 查范围是两次比较，不查表、不间接。jancy 自己在 doc 里把 fat 指针说成"indirectly contain
  information about the allowed range"，实现上是 `{p, validator*}`；我们选内联三字，
  因为这一层没有 GC、也没有 validator 那张表，多一次间接换不来任何东西。
- 代价写在明处：`(ptr T)` 占三个字，装进结构体时也是三个字。

## 决策二：两套实现，一套语义

- **JS / 两个解释器**：`arena` 模拟。一整块 `ArrayBuffer`，地址是**字节偏移**（0 是 null，
  所以真正的分配从 1 开始）。读写走 `DataView`，字节序**固定小端**——不跟宿主走，
  否则两条腿的 `.eps`/输出会不一样。
- **C / LLVM**：真指针。fat 是一个三字段结构体，thin 就是 `T*`。

选"两套"而不是"五条腿共用一个 arena"的理由：FFI。这门语言的用处一半在"把协议头结构体
盖在缓冲上"，另一半在"和外面的 C 库互操作"（`type_ptr_data.rst` 最后一段说 thin 指针存在
的两个理由之一就是 interoperability）。arena 里的偏移递不出去，真指针才递得出去。

**这条选择的后果必须写在纪律里**：

> 指针的**数值**在两套实现里不一样，所以任何测试都**不许观测裸地址**。
> 能观测的只有三种：`p == null`、两个指针的差（`(psub p q)`，以元素为单位）、
> 解引用出来的值。哪一天某个测试印了地址，那不是"腿之间不一致"，是那个测试写错了。

## 决策三：`unsafe` 是方言里的一个作用域

`(unsafe STMT...)`。里面才允许：`(taddr …)`（取 thin 地址）、`(pthin …)`（把 fat 降成 thin）、
thin 指针的解引用与算术、以及 fat 指针**跳过范围检查**的那一族。

不做成"每个操作各带一个 unsafe 标记"的理由：jancy 自己就是块级的
（`unsafe { … }`，`test50.jnc` 是唯一用到它的语料），而且块级在检查层只要一格布尔状态。

## 分步

1. **方言的指针类型与八条形式**（`(ptr T)` / `(tptr T)`；`addr` / `taddr` / `pload` /
   `pstore` / `padd` / `psub` / `pnull` / `pthin`），加上 `(unsafe …)`。落在
   `stage0/src/hir/types.js`、`stage0/src/sexpr/lower.js`、`stage0/src/hir/check.js`。
2. **JS 后端的 arena**：`$mem` / `$mem_alloc` / `$pload_*` / `$pstore_*` 与范围检查。
3. **C 后端的真指针**：fat 三字段结构体。
4. **两个解释器**：照 JS 那一套 arena（`run` 与 `interp` 必须逐字节一样）。
5. **LLVM 后端**：真指针，跟在 C 后面。
6. **`tests/sexpr/` 的指针那一组**：五条腿输出一致，越界与 null 解引用各有一条拒绝用例。
7. **`stage0/src/frontend-jnc/` 与 `jnc.grammar`**：从八份 `.llk` 转写，一处改动一条理由
   （与 asy.grammar 文件头同一个写法）。
8. **`tests/jnc/`**：语料从 `test/jnc/*.jnc` 挑，期望输出自己写、注明出处。

第一刀的门槛：一个 `.jnc` 里 `struct` + `int*` + 指针算术 + 越界报错，在五条腿上给同一个答案。

## 已经落地的（第一刀，只到 JS 那条腿）

方言那一层齐了：

- 类型 `(ptr T)` / `(tptr T)`，`hir/types.js` 里 `ptrTargetOk` / `alignOf` / `sizeOf` /
  `structLayout` 四个（布局由这一层定死，各条腿不许自己算）
- 九条形式：`pnew` / `pnull` / `pload` / `pstore` / `padd` / `psub` / `pisnull` /
  `pfield` / `pthin`，加上 `(unsafe …)`
- **刻意还没做的两格**，各有理由写在代码里：
  - `(addr 局部量)`——要求局部量可寻址（jancy 是"取了 fat 地址的局部量被提到 GC 堆"），
    那要动每条腿的局部量表示，单独一刀
  - `(pload p)` / `(pstore p v)` 在 **p 指向结构体**时不给——整块读写要四条腿各一份
    marshalling，而这门语言真正的用法是 `(pfield …)` 逐字段

JS 那条腿（arena）量过的：`tests/sexpr/pending/25-pointers.sx` 十九格全对，包括

- `pnew` 是零初始化的；`padd` 走出块外不报错、走回来照旧能读（只有解引用才查）
- `psub` 按元素；`pfield` 的步长说明 `sizeof(Hdr)` 是 24（int 8 + real 8 + bool 1 补到 24）
- 指针穿过函数、别名共享同一块；`unsafe` 里 thin 与 fat 看到的是同一段内存
- 运行期两条错：`pointer out of bounds: 5 (range 2)`（**按元素**印，不印裸地址）、
  `null pointer dereference`

**这份 case 现在放在 `tests/sexpr/pending/` 而不是 `cases/`**：`cases/` 那一轴的判据是
"五条腿逐字节相同"，而 C / LLVM / 两个解释器还没有指针。等那三步做完再挪进去——
在此之前把它放进 `cases/` 会让那一轴红着，那是自欺。

编译期那一条已经进轴了：`tests/sexpr/bad/thin-outside-unsafe.sx`（56/0）。

## 后果与代价

- 方言从"没有可算术的引用"变成"有"。这一格会渗到 MIR 与四个后端，改不回去。
- fat 指针三字内联：结构体里放指针就胖三倍。可接受——这一层没有 ABI 兼容负担。
- 两套实现意味着**两处都要验**。纪律靠"不许观测裸地址"这一条守住。
- 没有 oracle 意味着错了不会被自动抓住。纪律靠"每条期望都有出处"这一条守住。
