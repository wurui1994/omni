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
   `src/core/hir/types.js`、`src/core/sexpr/lower.js`、`src/core/hir/check.js`。
2. **JS 后端的 arena**：`$mem` / `$mem_alloc` / `$pload_*` / `$pstore_*` 与范围检查。
3. **C 后端的真指针**：fat 三字段结构体。
4. **两个解释器**：照 JS 那一套 arena（`run` 与 `interp` 必须逐字节一样）。
5. **LLVM 后端**：真指针，跟在 C 后面。
6. **`tests/sexpr/` 的指针那一组**：五条腿输出一致，越界与 null 解引用各有一条拒绝用例。
7. **`src/core/frontend-jnc/` 与 `jnc.grammar`**：从八份 `.llk` 转写，一处改动一条理由
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

**这份 case 后来挪进了 `cases/`**（见下面第二刀）。第一刀写它的时候它在
`tests/sexpr/pending/`，理由是 `cases/` 那一轴的判据是"五条腿逐字节相同"，而当时
C / LLVM / 两个解释器还没有指针 —— 在那之前把它放进 `cases/` 会让那一轴红着，那是自欺。

编译期那一条已经进轴了：`tests/sexpr/bad/thin-outside-unsafe.sx`（56/0）。

### 第二刀：另外四条腿 —— 平签名的真符号，与"两套实现只剩三句话可比"

分步 3、4、5、6 一次做完，因为它们其实是同一个问题的四个面。落地的顺序与量出来的东西：

1. **C 那条腿（真指针）**：`omni.h` 里 `omni_ptr` 是三字段结构体 `{a, b, e}`，`omni_mem.c`
   里四个真符号。分配走 arena —— 那些块是 malloc 出来的、到进程退出才丢，所以"悬垂指针
   不可能"（`type_ptr_data.rst`）在批处理进程里自动成立，不需要 GC 也不需要 free。
2. **两个解释器**：`interp/builtin.js` 里一份 arena（`ptrNew`/`ptrChk`/`ptrTChk`/`ptrLoad`/
   `ptrStore`/`ptrAdd`/`ptrSub`），OIR 解释器与 MIR 解释器**共用这一份**。
   MIR 那边加了两个类型码 `T_PTR` / `T_TPTR` 与八条 op（`PNEW`/`PNULL`/`PISNULL`/`PTHIN`/
   `PLOAD`/`PSTORE`/`PADD`/`PSUB`）。
3. **LLVM 那条腿**：fat 是**一等聚合值** `{ptr, ptr, ptr}`，靠 `insertvalue`/`extractvalue`
   拆装。结构体那边走句柄的理由（`FLDSET` 要就地改）在这里不成立 —— 指针是值类型，
   任何操作都产生新值。
4. **`cases/25-pointers.sx` 挪进轴**（十九格，五条腿逐字节相同），另加一组新的 `rt/`。

**这一刀真正的发现是第 3 步逼出来的一次返工**：`omni_pnew` 原先返回 `omni_ptr`、
`omni_pchk`/`omni_psub` 原先按值收 `omni_ptr`。C 那条腿这样写没问题，但 LLVM 那条腿要调
**同一批符号**，而"24 字节结构体怎么传"是平台 ABI 的事（x86-64 与 aarch64 上都走内存，
返回还要 sret）—— 让那条腿去猜就是在赌。于是改成：

> **真符号一律是平的**（只收发 `char *` 与 `int64_t`）。`omni_pnew` 只回**块首**：刚分配
> 出来的块 `addr == base`、`end == base + count*size`，三个字调用方自己拼得出来，于是它
> 不必返回聚合。`omni_ptr` 退回 C 这一侧当便利类型，包在 `omni_pnew_fat` / `omni_pderef` /
> `omni_pdiff` 三个 `static inline` 里。

这条纪律与数组那六条同源（"run-c 与 run-llvm 调同一个符号，所以越界消息不可能分叉"），
只是数组那边的签名天生是平的，指针这边要专门捏平。

另外两处量出来的细节：

- **`Math.floor` 与 C 的 `/` 不一样**。越界消息里的元素下标是 `(addr - base) / size`，
  JS 那三条腿用 `Math.floor`，而 C 的 `/` 向零截断 —— 只在"负数且除不尽"时分叉
  （`-4/8`：floor 给 −1，截断给 0）。`omni_mem.c` 里补了一个 `omni_pfloordiv`，
  而不是赌那种情形不出现。
- **`PSTORE` 在 LLVM 里要回读一次**。这条指令的结果是"存进去的那个值"（另外四条腿都是），
  但 SSA 里 `dst` 必须由这条指令自己定义，不能把操作数改个名字当结果。所以是
  `store` 之后再 `load` 一次 —— 那块内存是我们自己的、非 volatile，opt 会把它折掉。
- **`PFIELD` 在 MIR 里不存在**。字段地址就是"步长 1 的 `PADD` + 一个常量偏移"，
  多一条 op 就多一处两个消费者可能各自解释的地方。

**新立的一组轴：`tests/sexpr/rt/`**。与 `bad/` 的差别是"什么时候错"：`bad/` 是编译期
拒绝（一条腿就问得清），`rt/` 是跑起来才报的错，而那句话在五条腿上**各有一份实现**
（`prelude.js` 的 `$rt_error`、`interp/builtin.js` 的 `rtError`、`omni_error.c` 的
`omni_error`/`omni_errorf`）。指针这一刀之后这一组才立得起来 —— 那三句消息是两套指针
实现之间**唯一还能观测到的东西**，逐字节相同不是巧合，是判据。现在两条：
`pointer out of bounds: 5 (range 2)`、`null pointer dereference`。

跑过的轴：`tests/sexpr/run.js` **59 passed, 0 failed**（56 → 59：cases 多一份、rt 多两份）。
另外单独对过三处：`25-pointers.sx` 在五条腿上都是同一行十九个值；两条运行期错误在五条腿上
逐字节相同；`run-c` 在改成平签名前后输出没变。

**跳过的轴**（照旧，「不要浪费时间在无意义的全量上面了」）：`tests/asy/run.js` 的五条腿、
EPS 全量、`sweep.js`、`svg.js`、自举。这一刀一行 asy 的代码都没动，那几条轴问不出新东西。
`tests/jit` 也没跑 —— `run-jit` 要 libLLVM，而这一刀的 LLVM 那条腿走的是 `clang` 那条路。

**还差什么**：分步 7（`frontend-jnc/` 与 `jnc.grammar`）与 8（`tests/jnc/`）——
见下面第三刀。第一刀的门槛那句话——"一个 `.jnc` 里 `struct` + `int*` + 指针算术 +
越界报错，在五条腿上给同一个答案"——现在方言这一侧已经全部就位，缺的只有前端。

### 第三刀：前端接上，与一条新纪律 —— **jancy 不向方言妥协**

分步 7 与 8 一起落地：`src/core/frontend-jnc/lower.js`（jnc 树 -> 核心方言）、`.jnc`
接进 `cli.js`（`compileJnc` / `jncText` / `omni sx x.jnc`）、新轴 `tests/jnc/`。
语法那一半原先就在（`jnc.grammar`，526/528 份真实源码唯一成树，由 `tests/glr` 的
`cases/jnc` 那一组量），这一刀只补降级。

第一刀的门槛达成：`tests/jnc/cases/01-pointers.jnc` 里有 `struct` + `int*` + 指针算术 +
逐字段读写，五条腿逐字节相同；`tests/jnc/rt/oob.jnc` 的越界消息五条腿同一句
（`pointer out of bounds: 5 (range 3)`）。

**这一刀真正的收获是一条纪律，不是代码。** 第一版降级器里我把六处"jancy 有、方言没有"
的东西写成了报错，还给每一处编了理由。那是反了：**遇到对不上，动的是方言。** 借的是
jancy 的完整语法与形式，不是"jancy 里能塞进现有方言的那个子集"——后者会长成一门看着
像 jancy、语义悄悄偏掉的方言，而偏在哪儿没人说得清。

按这条纪律，方言这一刀长出两条形式：

- **`(sel c 甲 乙)`** —— 条件表达式，惰性（只算取中的那一支）。代价近乎零：汇聚层
  下面**早就有** `Ternary`（Omni 自己的 `?:` 就是它），五条腿与 MIR 都认
  （`from_oir.js` 的 `ternary()`：开一个槽、IF/ELSE 各存一次、再读回来）。缺的一直
  只是一个表面形式。原先想的"拆成临时量加一条 if"只在语句位置成立——一旦 `?:` 出现在
  `&&` 的右边、实参里、或另一个 `?:` 的分支里，拆出来的语句就跑到了不该跑的地方。
- **`(peq p q)`** —— 指针相等。不能走 `(bin "==" …)`：fat 是三个字，C 那边结构体
  之间没有 `==`、JS 那边比数组是比引用（两个指向同一格的指针各是一份拷贝，永远不等）。
  只比**地址那一个字**——那件事在 arena 与真指针两套实现下都有定义。刻意不给 `<` `>`：
  块间的次序两套实现不一样。与 `psub` 的差别写在代码里：**跨块比相等有定义**（答案是
  "不等"），跨块相减是运行期错误。

另外三处不用动方言，因为它们在 jancy 那边本来就是"隐式转换"或"已有算符的组合"，
这一层把它们**显式写出来**就对了：

- **真值化**：`if (n)` -> `(bin "!=" n (int 0))`、`if (p)` -> `(un "!" (pisnull p))`，
  `!x` 与 `&& ||` 的两侧同样。方言仍然只收 bool（ADR-0014 决策 1 不动），转换发生在
  前端且看得见。
- **`~x`** -> `(bin "^" x (int -1))`（补码）。
- **`printf("%d", 布尔)`** -> `(tostr (sel b (int 1) (int 0)))`：jancy 的 `bool`
  底下是 int8，印 1 / 0 而不是 true / false。

**还没长出来、因此当场报错的**（每一条都记着该怎么长，按这个次序）：

1. `printf` 的完整格式（宽度、精度、`%x`、`%c`，以及不以 `\n` 收尾的那种）——
   要方言里有一条"不换行的输出"加一份格式化。`%c` 尤其：这一层没有"整数 -> 一个字符
   的串"，`tostr` 会印出数字。
2. `&x` —— 要局部量可寻址（jancy 那边是"提到 GC 堆上"）。**第九刀做掉了**，照抄 jancy 的
   办法，方言没动；剩下的是 `&p`（`int**`）—— 那条真要方言能把 fat 指针（三个字）当内存里的值搬。
   当初写在它旁边的"整个结构体的 pload/pstore"**第十二刀做掉了**，而且同样不需要那一格：
   结构体每格是一段自己的 `pnew` 内存，抄一份就是逐字段抄。
3. 真数组 `int a[3]` —— jancy 的数组是**值**类型，方言的 `(arr T)` 是引用语义；
   要方言有值语义的定长数组。**第十刀做掉了**，但结论与这条当初的判断相反：不需要那一格 ——
   数组就是一段 `pnew` 出来的内存，而能看出"值还是引用"的那几处操作，jancy 自己也没有。
4. 定宽整数——jancy 的 `int` 是 32 位、`char` 8 位，这一层全按 64 位。溢出会不一样，
   这是目前**唯一一处会静默给出不同答案**的地方，所以排在这份名单里而不是"不收"里。
   （第六刀做掉了：位宽是前端的账，方言一个字没改。）
5. `return 非 0`（退出码）、标准库、格式化字面量、class / union / enum / property /
   reactor、异常、namespace / import。

**测试轴**：`tests/jnc/`（`cases/` 五条腿一致 + 对上期望、`rt/` 五条腿同一句错误、
`bad/` 拒绝且理由正确），11 -> 10 条（真值化与 `?:` 那两条从 `bad/` 转成了 `cases/`）。
`tests/sexpr` 56 -> 60：`25-pointers.sx` 补了 `peq` 五问，新增 `26-sel.sx`（惰性用
"没取中的那一支会崩"来观测，比印两个数强）。

**跑过的轴**：`tests/jnc`（新，10/0）、`tests/sexpr`（60/0）、`tests/glr`（20/0）、
`tsc --noEmit`。**没跑的**：`tests/asy` 五条腿与 EPS 全量、`sweep.js`、`svg.js`、
自举、`tests/jit`、`tests/mir`、`tests/llvm`——这一刀没动 asy，MIR 那一格加的是一条
表驱动的 op（`PEQ`），`tests/sexpr` 的五方一致已经把它走过一遍。

### 第四刀：printf 那一格 —— 方言长出"不换行的输出"

第三刀留下的名单第一条：`printf` 不以 `\n` 收尾的写法，与 `%c`。两条原先都被拒了，
理由分别是"方言里没有不换行的输出"与"方言里没有整数 -> 一个字符的串"。按第三刀立下的
纪律，这是**方言的欠账**，不是 jancy 的边界。

- **`(write E)`** —— 印一个 string，不加换行。新符号，五条腿各一份：JS 那边接现成的
  `$print_raw`、解释器那边接现成的 `printRaw`（两者本来就与 print 共用缓冲区）、
  C 那边新加 `omni_write_string`、LLVM 那边一行 `write.string` ABI。
  **只有 string 一个签名**：要印数就先 `(tostr …)`。与 print 收所有标量不同 ——
  那一条有历史（Omni 的 `print` 本来就是多态内建），这一条是新的，于是选"五条腿各一个
  符号"而不是"各四个"。
- **`(chr E)`** —— 码位 -> 一个字符的串。**没有新实现**：另外四条腿早就有它（Omni 的
  `chr(65)`），漏的一直只是 LLVM 那一行 ABI。与 `slen`/`ssub`/`sfind` 同一个路子。

jancy 侧的 printf 于是变成：按 `\n` 把格式串切段，带换行的段发 `print`，末尾不带换行的
那段发 `write`。收 `%d` / `%i` / `%f` / `%s` / `%c` / `%%`。

**这一刀真正要盯的是缓冲顺序**，不是"能不能印出来"。`write` 与 `print` 必须写同一个
输出缓冲区——分开缓冲的话，直写的那段会插到已经缓冲、还没落盘的输出前面去，而那种错
只在两种调用**交替**时才看得见。所以 `tests/sexpr/cases/27-write.sx` 与
`tests/jnc/cases/05-printf.jnc` 都刻意交替调用。

**这一刀刻意没做**（下面第五刀补上了第一条）：`(srep S N)`（重复一个串，printf 的宽度
要它）。封闭 ABI 里确实有个 `js_str_repeat`，但它收发的是 `omni_dyn`——从这条按类型走的
路上用它要装箱拆箱两次。对的形状是在运行时里加 `omni_str_repeat(omni_str, int64_t)`。
`%.Nf`（精度）与 `%x`/`%o` 留着：两者都要先做一个数值上的决定。

**跑过的轴**：`tests/jnc`（10/0，`bad/printf-tail` 转成了 `cases/05-printf`）、
`tests/sexpr`（60 -> 61，新增 `27-write.sx`）。**没跑的**：`tests/asy` 全部、
`sweep.js`、`svg.js`、自举、`tests/jit`、`tests/mir`、`tests/llvm`——这一刀加的是一条
builtin 与一行 ABI，`tests/sexpr` 的五方一致把两者都走过了。

### 第五刀：printf 的宽度 —— 与 C 的 printf 逐字节对上

`(srep S N)`：把 S 重复 N 遍。新符号 `omni_str_repeat(omni_str, int64_t)`，五条腿各一份
（C 一份实现、JS 的 `$str_repeat`、解释器的一行、LLVM 一行 ABI）。

**`N <= 0` 回空串，不报错**——这是这条形式唯一需要定的语义。宽度就是"补到至少 N 个
字符"，而 `max(0, N - 长度)` 常常是 0 或负数，那是正常情形而不是错误。JS 的
`String.prototype.repeat` 在负数上抛异常，所以 JS 那一侧也得先夹住；夹的位置在两边
同一处，写在同一段注释里。

jancy 侧的 printf 于是接上了标志与宽度：`%5d` / `%-5d` / `%05d` / `%5s` / `%5c` / `%8f`。
两处值得记下来：

- **`%05d` 印负数是 `-0042`**，零补在**符号后面**。这是 C 的规矩（`printf '[%05d]' -42`
  量过），不是我们编的。第一版想偷懒退回补空格，那样差别是"少补了个零"；改成分一支
  把符号摘出来之后，六种写法与 C 的 printf **逐字节相同**（对照命令写在
  `tests/jnc/cases/05-printf.jnc` 的注释里）。
- **实参只算一遍**。宽度那一格要多次读那段文本（量长度、再拼上去），直接内联的话
  `printf("[%5d]", bump(c))` 里的 `bump` 会被调两遍（补零那一支四遍）。所以降级时先把
  它落成一个 `(let $fN string …)`。落在 print 之前而不是别处：jancy 与 C 一样在调用前
  算完所有实参，先算一步更贴。`cases/05-printf.jnc` 里那个计数器就是在盯这件事——
  `calls=1`。

`%*d`（宽度从实参来）不收：那要在运行期才知道宽度，与"格式串必须是字面量"同一处边界。

**还差的两条**（都要先做一个决定，没有决定就不动手）：

- `%.Nf`（精度）——要定死 C 的 `%.*f` 与 JS 的 `toFixed` 在**恰好一半**上怎么对齐。
  两者不一样：`0.125` 到两位，C 给 `0.12`（就近取偶），JS 给 `0.13`（ECMA-262 规定取较大
  的那个）。挑哪一边都行，但必须挑一边并在两侧都实现它。（第八刀挑了 C 那一边。）
- `%x` / `%o`——要定死负数怎么印。C 把它当 unsigned，于是**位宽直接改答案**：jancy 的
  `int` 是 32 位（`-1` 印 `ffffffff`），而这一层原先只有 64 位的 int。所以这一条挂在
  "定宽整数"那一格上，得先有它。（第六刀给了位宽，第七刀做掉了这一条。）

**跑过的轴**：`tests/jnc`（10/0）、`tests/sexpr`（61/0）。**没跑的**：`tests/asy` 全部、
`sweep.js`、`svg.js`、自举、`tests/jit`、`tests/mir`、`tests/llvm`——同上，加的是一条
builtin 与一行 ABI。

### 第六刀：定宽整数 —— **唯一一处会静默给出不同答案**的地方，补上

这一条排在名单最前面不是因为它大，是因为它**不出声**：jancy 的 `int` 是 32 位、`char` 8 位、
`short` 16、`long` 与 `intptr` 64（Lexer.rl 的关键字表 + Type.cpp 的 `TypeKind_Int8..Int64`），
而这一层原先把它们全按 64 位办。`100000 * 100000` 在 jancy 里是 `1410065408`，在这儿是
`10000000000` —— 不报错、不警告，就是**另一个答案**。前五刀里所有的边界都会当场喊出来，
只有这一条不会，所以它先做。

**方言一个字都没改。** 位宽是**这一层的账**：存储一律用方言那个 64 位 int，而每个值都保持在
它那一格的范围里（**符号扩展后的规范形**），窄格运算之后补一次回卷：

```
(bin "-" (bin "^" (bin "&" X (int 255)) (int 128)) (int 128))     ; 回卷到 8 位
```

掩到 w 位、把最高位当符号位摊开。两条腿上都成立：JS 那侧 int 是 BigInt
（`-1n & 255n === 255n`），C 那侧是补码的 `int64_t`（`(-1LL) & 255 == 255`）—— 同一串算符给
同一个数。这与 `~x` -> `x ^ -1`、真值化是同一类事：**jancy 侧的一次隐式动作，这一层把它
显式写出来**。所以这一刀没有新的核心形式、没有新的 ABI 符号、没有 MIR 改动。

关键的那一条不变式：**只要两个操作数都是规范形，`% & | ^ >> == <` 的结果天然还在范围里**，
只有 `+ - * / <<` 与一元 `-` 会溢出。于是回卷恰好发生在这六处，加上"赋值/实参/返回/强制
转换到更窄的一格"。加宽**不发一个字** —— 规范形里"8 位的 -1"与"64 位的 -1"是同一个数。

跟着 C 的四条规矩（jancy 也是照 C 来的），一条都没省：

- **整型提升**：比 32 位窄的先提到 32 位。所以 `char x = 100, y = 100; x * y` 是 `10000`
  而不是在 8 位里溢出；`char z = x * y` 才收窄成 `16`。
- **常用算术转换**：两边取较宽的那一格。`int + long` 是 `long`。
- **移位的结果宽度只看左边**：`1 << 31` 在 `int` 上是 `-2147483648`，在 `long` 上是
  `2147483648`。右边不参与转换。
- **字面量装得下就是 `int`，装不下就是 `long`**。这条有个众所周知的后果，照抄不改：
  `-2147483648` 是 `long`（一元减在字面量之外，而 `2147483648` 已经装不下 32 位）。

**`unsigned` 从"静默忽略"改成"当场拒"**。以前忽略它看不出差别；有了位宽之后
`unsigned char c = 200` 该印 200，忽略修饰符按有符号 8 位算会印 -56 —— 那正是这一刀要
消掉的那种错。要接它得先有无符号那一半：回卷变成 `x & M`（不摊符号位），`/` `%` `>>` `<`
都换成无符号那一版。记在名单里，`bad/unsigned.jnc` 是它的本体。

> **第三十三刀更正**：这条边界落地了一大半 —— 8 / 16 / 32 位的无符号接上了，`bad/unsigned.jnc`
> 删掉，`cases/32-unsigned.jnc` 是它的本体。上面"要先有无符号那一半"这句量下来只对 64 位那一格
> 成立：u8 / u16 / u32 的规范形装得进方言的有符号 64 位，`/` `%` `>>` `<` 用现成的有符号版就是
> 对的。剩下的边界收窄成 `bad/unsigned-long.jnc`。

**一处刻意留下的差别**：`sizeof` 意义上的**存储**宽度。四种位宽在方言里都占一个 64 位的槽
（`char*` 与 `int*` 是同一个方言类型），所以 `new char[n]` 占 8n 字节。这一格从**语义**上
看不见 —— 指针算术按元素走，而 `sizeof` / `offsetof` 都不收 —— 所以它不在待办名单里；
要真接 `sizeof` 才要动。

**期望输出的出处**：C 的那四条规矩，逐条对照一份 `cc -O0` 编出来的 C
（那份 C 抄在 `tests/jnc/cases/06-widths.jnc` 的头注里）。23 行**逐字节相同**，五条腿一致。
两处写法上的差别不是语义差别：C 那边 `char` 的符号性由实现定，所以对照的那份写
`signed char`；C 那边 64 位实参要 `%lld`，而这一层的 `%d` 四种位宽都收（值已经是规范形，
照印就是 C 的样子）。

`int` 除以 `-1` 那一处溢出（`INT_MIN / -1`）**没有**写进期望：C 那边它是 UB，没有可引的
答案。我们的实现给回卷后的 `INT_MIN`，两套实现一致，但没有出处就不进 `.expected`。

**跑过的轴**：`tests/jnc`（12/0，新增 `cases/06-widths` 与 `bad/unsigned`）、`tests/sexpr`
（61/0）、`tests/glr`（20/0）。**没跑的**：`tests/asy` 全部、`sweep.js`、`svg.js`、自举、
`tests/jit`、`tests/mir`、`tests/llvm` —— 这一刀只动了 `frontend-jnc/lower.js` 一份文件，
方言、MIR、四个后端与运行时一个字都没改。

### 第七刀：`%x` / `%X` / `%o` —— 方言长出"按进制印"，与一条 ASCII-only 的大写

第六刀给了位宽，这一刀才轮到它上面那条：`%x`。这一格真正的难处不是"印十六进制"，是
**多少位**——C 把 `%x` 的实参当 unsigned 读，而位数是**默认实参提升之后**那一格。所以
`char d = -56; printf("%x", d)` 是 `ffffffc8`（提到 int 之后按 32 位无符号读），不是 `c8`。
没有第六刀就没法说出这句话，这也是那两条为什么是这个次序。

方言长出两条形式：

- **`(sbase E 进制)`**——把 E 按某个进制印出来。两条定死的语义：
  - **E 的位当无符号 64 位读**。`(sbase (int -1) (int 16))` 是 16 个 f。要 32 位的答案就在
    上一层先掩一次（`x & 0xFFFFFFFF`）——**位宽是降级那一层的账**，这条形式不管。这样分
    是因为方言里只有一个 64 位的 int，让它去猜"你其实是 32 位的"就是把前端的账记到方言头上。
  - **数字小写**（`0-9a-z`）。
  - **进制要写成字面量**。printf 里它永远是字面量；收运行期值就得多一条"进制不在 2..36"的
    运行期错误路径（四条腿各一份消息）。这条限制在降级期一次说清，便宜得多。
- **`(supper S)`**——**只把 ASCII 的 a-z 换成大写**，别的字节一个不动。刻意不是 Unicode 的
  `toUpperCase`：JS 那侧 `"ß".toUpperCase()` 是 `"SS"`（长度都变了），C 那侧 `toupper` 还看
  locale——两条路在那上面根本对不上。定成 ASCII-only 之后四条腿是同一个函数。

**为什么是两条形式而不是 `(sbase E 进制 大写?)` 一条**：多一个标志位就多一种参数形状
（那条 ABI 会是三个参数里夹一个布尔），而只省一次调用。`%X` 降成 `(supper (sbase …))`，
`supper` 顺带是个能单独用的东西。

新符号两个：`omni_str_base(int64_t, int64_t)` 与 `omni_str_upper(omni_str)`，五条腿各一份
（C 各一份实现、JS 的 `$str_base` / `$str_upper`、解释器两行、LLVM 两行 ABI）。`(sbase …)`
用 `argType: INT` 单态化成 `str_base.int`，`(supper …)` 用 `recvType: STRING` 成
`str_upper.string`——与 `chr` / `srep` 同一个路子。

**期望输出的出处**：C。`tests/sexpr/cases/28-sbase.sx` 盯方言那一层的两条语义（含
`(int -9223372036854775808)` 这个边界，C 后端的字面量也过得去）；
`tests/jnc/cases/07-hex.jnc` 逐条对照一份 `cc -O0` 编出来的 C（那份 C 抄在头注里），
16 行**逐字节相同**，五条腿一致。与那份 C 的两处写法差别不是语义差别：`signed char`
（C 那边 char 的符号性由实现定）与 `%llx`（C 那边 64 位实参要长度修饰符，而这一层的 `%x`
位数从**类型**上取）。

**printf 只剩一条没做**：精度 `%.Nf`。它要先定死 C 的 `%.*f` 与 JS 的 `toFixed` 在恰好
一半上怎么对齐（`0.125` 到两位，C 给 `0.12`、JS 给 `0.13`），挑哪边都行但要两侧都实现。
`%*d`（宽度从实参来）不算——那与"格式串必须是字面量"是同一处边界。

**跑过的轴**：`tests/jnc`（13/0，新增 `cases/07-hex`）、`tests/sexpr`（62/0，新增
`cases/28-sbase`）、`tests/glr`（20/0）。**没跑的**：`tests/asy` 全部、`sweep.js`、`svg.js`、
自举、`tests/jit`、`tests/mir`、`tests/llvm`——加的是两条 builtin 与两行 ABI，MIR 的 op 表
一行没动（`CALLOP` 的实参池本来就收任意元数）。

### 第八刀：`%f` 与 `%.Nf` —— 挑一边舍入，与顺手抓出来的负零

这一刀补的是**一处静默的差别**，而且它一直明写在测试的注释里：第八刀之前 `%f` 降成方言的
`tostr`（也就是 `%.6g`），于是 `printf("%f", 1.5)` 印 `1.5` 而 C 印 `1.500000`、
`double d = 3` 印 `3` 而 C 印 `3.000000`。C 的 `%f` 是 **`%.6f`**（默认精度 6），不是"把这个
数印出来"。写在 `02-control.jnc` 头注里的那句"要真的 `%f` 就得先在方言里加格式化"，就是这一刀。

方言长出 `(sfix E N)`：小数点后**正好 N 位**。与 `(tostr E N)` 是两件事——那一条是 `%.Ng`
（N 位**有效数字**、去尾随零），这一条不去零。位数要写成 0..30 的字面量（printf 里它永远是
字面量，上界让 C 那侧的缓冲有个头）。

**要挑的那一边：就近取偶（C）。** 这一格必须挑，因为两条实现路子在**恰好一半**上本来不一样：

- C 的 printf：就近取偶，也就是 IEEE-754 的默认舍入。`%.2f` 的 `0.125` 是 `0.12`。
- JS 的 `toFixed`：ECMA-262 规定"两个都最近时取较大的 n"。同一个输入是 `0.13`。

挑 C 的理由是 jancy —— 它的 printf 底下就是 C 的 printf，而纪律是「jancy 不向方言妥协」，
要的是 jancy 的答案。**代价落在 JS 那一侧：它不能用 `toFixed`。** 于是那边按**精确值**算：
double 就是 `m * 2^e`（m、e 都是整数），所以 `|x| * 10^N` 是一个精确的有理数 `num / den`，
取整与判"是否正好一半"全用 BigInt 做，没有一丝浮点误差（`native.js` 的 `fmtFixed` 与
`prelude.js` 的 `$str_fixed`，同一份算法两处）。C 那一侧就是 `snprintf("%.*f")` 本身 ——
它才是那个出处。

新符号一个：`omni_str_fixed(double, int64_t)`。

**顺手抓出来的一处旧错：负零。** 写平局那几行的时候顺带写了 `-0.0`，于是发现
`(print (real -0.0))` 在**五条腿里只有解释器印 `-0`**，另外四条印 `0`。根子是
`String(-0) === "0"` —— real 常量出 OIR / MIR 的时候符号就掉了，而解释器直接拿 JS 的值、
不经那一步。四处各补一句：`from_oir` 的 `realText`、`backend-js` 的 `fmtRealLit`、
`backend-c` 的 `cReal`（`(-0).toPrecision(17)` 也丢符号）、`backend-llvm` 的 `llFloat`
（走位模式 `0x8000000000000000`，与 inf/nan 同一路）。这一条与 jancy 无关，是**方言自己的
五方一致**，只是没有一条 case 能看见它 —— `(sfix … (int 2))` 印 `-0.00` 才让它露出来。

**期望输出的出处**：C。`tests/sexpr/cases/29-sfix.sx` 是那八个平局加边界（负零、`N = 0`、
`1e21`、`%.20f` 的 `0.1`、`%.30f` 的 `1/3`）；`tests/jnc/cases/08-fixed.jnc` 逐条对照一份
`cc -O0` 编出来的 C（抄在头注里），17 行**逐字节相同**。四份旧的 `.expected` 跟着改了 ——
改的都是 `%f`，每一行都拿 C 量过（`1.5` -> `1.500000`、`0.5` -> `0.500000`、
`3.0` -> `3.000000`、`[%8f]` -> `[1.500000]`）。

**printf 到这里收齐了**，只剩两条**不收**（都不是"还没做"，是边界）：`%*d`（宽度从实参来，
要在运行期才知道宽度，与"格式串必须是字面量"同一处）；整数与 `%s` 上的精度（`%.3d` 是
"至少三位数字"、`%.5s` 是"最多五个字符"——与小数无关的两件事，各要自己的一段）。后一条
明着拒而不是忽略掉：忽略的话 `%.3d` 会印 `7` 而 C 印 `007`，那又是一处静默的差别
（`bad/int-precision.jnc` 是它的本体）。

> **第二十七刀更正**：两条都落了，`bad/int-precision.jnc` 删掉，边界收窄到 `%.*f`
> （`bad/printf-star-prec-f.jnc`）。`%*d` 那条的**理由记错了** —— 补空格那一步本来就是运行期
> 算的，`padTo` 的宽度从数字换成一段方言代码就够，一个零件都不用新加。另外这一节说的
> "照 C 的 printf"当时没写出处；第二十七刀量到 jancy 的 printf **就是** C 库的 `vsnprintf`
> （`jnc_std_StdLib.cpp:733` -> `axl_sl_StringDetails.h:390`），所以孪生程序是一等的出处。

**跑过的轴**：`tests/jnc`（15/0，新增 `cases/08-fixed` 与 `bad/int-precision`）、
`tests/sexpr`（63/0，新增 `cases/29-sfix`）、`tests/glr`（20/0）、`tests/asy`。asy 那条这次
**要跑** —— 负零那一处改的是四个后端共用的 real 常量，不是 jancy 独有的那一格。
**没跑的**：`sweep.js`、`svg.js`、自举、`tests/jit`、`tests/mir`、`tests/llvm`。

### 第九刀：`&x` —— 局部量提到堆上，方言一个字没改

`&x` 一直是 `bad/` 里的一条：方言的局部量是 SSA 里的一个值，没有地址。第一刀的头注里写的是
"要它就得先给方言加一格栈上的槽"。这一刀没加那一格 —— **jancy 自己就不是那么做的**。
`type_ptr_data.rst` 里那句 "any local taken fat address of, is being lifted to GC heap"
就是它的办法：被取过 fat 地址的局部量不留在栈上，提到堆上去。照抄它，于是

```
int x = 1;  int* p = &x;
```

降成

```
(let x$c (ptr int) (pnew (ptr int) (int 1)))
(pstore (var x$c) (int 1))
(let p (ptr int) (var x$c))
```

`x` 这个名字在方言里**根本不出现**，出现的是一格长度 1 的堆内存 `x$c`。之后对 `x` 的读写全走
`(pload (var x$c))` / `(pstore (var x$c) …)`，`&x` 就是 `(var x$c)` 本身。方言的 `pnew` /
`pload` / `pstore` 是第一刀就有的，所以**这一刀方言一个字没改**，后端、MIR、运行时也都没动。

**要哪些名字提上去，是进函数前先扫一遍决定的**（`collectAddrTaken`）：函数体里所有
`(addr (name X))` 的 X 收进一个集合，然后 `localDecl` 与 `lvalue` / `expr0` 的名字分支
按这个集合分岔。形参也要提 —— 形参在方言里同样是个值，所以被取地址的形参在函数开头
多两句：开一格、把传进来的值存进去。

**四种取地址落到同一条规则上。** `lvalue()` 返回 `ptr` 种类时，它的 `code` **已经就是地址**：
`*p` 的 lvalue 是 `p`、`p[i]` 的是 `(padd p i)`、`p->f` 的是 `(pfield p f)`。所以 `addrOf`
只有一句"取 lvalue，是 `ptr` 种就把 code 当值返回、类型套一层 `ptr`"，`&*p` -> `p`、
`&p[i]` -> `(padd p i)`、`&p->f` -> `(pfield p f)` 全是它的推论，一条特例都不用写。
不是 `ptr` 种的（比如 `&42`、`&f()`）报错。

**新的边界：`&p`（`int**`）。** `ptrTargetOk` 只放行 int / real / bool / struct，所以
对指针取地址当场被挡住。这不是漏的 —— fat 指针是三个字，而 `pload` / `pstore` 现在只搬一个
字。它与"整个结构体的 `pload` / `pstore`"是**同一格**：方言要能把多字的值当内存里的东西搬。
两条一起记在债务表里。同理，被取地址的形参/局部量只收可提的三类（int / real / bool），
struct 的那一条并进上面同一格。

**期望输出的出处**：C。`tests/jnc/cases/09-addr.jnc` 对照一份 `cc -O0` 编出来的 C（抄在头
注里），13 行逐字节相同，覆盖 `&x` 读写、`&` 形参、`&*p`、`&p[i]`、`&p->f`、取地址的量同时
参与 `++` 与复合赋值、以及 double / bool 的那两格。`bad/addr-of.jnc` 跟着删掉 —— 那条边界
不存在了，本体转到 `cases/09-addr.jnc`（第三到第五刀也是这么搬的）。

**跑过的轴**：`tests/jnc`（15/0，新增 `cases/09-addr`、删掉 `bad/addr-of`）、
`tests/sexpr`（63/0）、`tests/glr`（20/0）。
**没跑的**：`tests/asy` 全部（这一刀只碰 `frontend-jnc/lower.js`，四个后端与运行时一行没动）、
`sweep.js`、`svg.js`、自举、`tests/jit`、`tests/mir`、`tests/llvm`。`npm run lint` 这台机器上
没有 typescript，跑不了。

### 第十刀：定长数组 —— 债务表上那条判断是错的，方言仍然一个字没改

债务表第 3 条写着"jancy 的数组是值类型，方言的 `(arr T)` 是引用语义，要方言有值语义的定长
数组"。做的时候发现**那条判断本身站不住**，而且不是因为将就 —— 是因为先去读了 jancy 的源码。

jancy 的数组照抄 C/C++：定长，长度写在声明符上（decl_simple.rst："in C/C++
compiler-generated arrays are fixed-sized … Since being able to copy-paste C/C++ declarations
of network protocol headers was crucial, Jancy adopts C/C++ model"）。而它**根本不是**能整份
搬来搬去的值：`CastOp_Array.cpp` 里 `Cast_Array::llvmCast` 的函数体只有一句

```cpp
err::setError("CCast_Array::LlvmCast is not yet implemented");
```

也就是说数组之间的转换只在 `constCast`（编译期常量折叠）那条路上存在。"值语义"能被看出来的
地方一共就那么几处 —— 赋一份拷贝、当实参传、当返回值、当结构体字段 —— 而这几处 jancy 自己
都没有（前三处要那次未实现的转换，第四处要嵌进结构体布局）。剩下的操作里"值"与"一段内存"
**观察不出差别**。

> **这一段错了，第二十一刀改过来了。** `llvmCast` 不是那条路上的唯一关口：`castOperator`
> 在它之前有一条 `opType->isEqual(type)` 的恒等捷径（`jnc_ct_OperatorMgr.cpp:527`），
> 而 `Cast_Array` 的 `OpFlag_LoadArrayRef` 恰好在那之前把整块载成了一个值。所以**同型**
> 数组的赋一份拷贝、当实参传、当返回值这三处 jancy 都是通的，`llvmCast` 只挡不同型的。
> 上面那句"这几处 jancy 自己都没有"只有第四处（结构体字段）成立。

于是这一刀的形状是：`T a[N]` 的存储就是 `(pnew (ptr T) (int N))`，一段长度 N 的堆内存。

```
int a[3] = { 1, 2, 3 };
```

降成

```
(let a (ptr int) (pnew (ptr int) (int 3)))
(pstore (padd (var a) (int 0)) (int 1))
(pstore (padd (var a) (int 1)) (int 2))
(pstore (padd (var a) (int 2)) (int 3))
```

三件事因此免费得到，而且都正好是 jancy 的语义：

- **越界检查**。范围就在那个 fat 指针里，所以 `a[i]` 走的是 `pload`/`pstore` 本来那一条 ——
  正是 type_ptr_data.rst 里的例子（"Range is checked on both **array accesses** and pointer
  dereferences"，`rt/arr-oob.jnc` 把那段例子照抄了下来，`foo(3)` 在五条腿上报同一句）。
- **退化成指针**。`int* p = a;`（同一份文档 31 行）在这一层**不发一个字的代码** —— 数组本来
  就是那个 fat 指针，退化只改类型。这一条落在 `expr()` 里一句 `decay(...)`：expr 是所有取值
  的唯一入口，所以下标、printf、实参、比较、算术全都跟着对。
- **零初始化**。`int c[2];` 印 `0 0`，因为 `pnew` 出来的那一段是零（五条腿都量过）。这一条的
  出处不是 C（C 里那是未定值）而是 jancy："Jancy compiler zeros every variable before any
  user code can touch it"。

花括号初值那一格照 jancy：`[]` 的长度 = 项数；项数少于长度时剩下的是零（`Cast_Array::constCast`
里那句 `if (dstSize > srcSize) memset(dst, 0, dstSize)`，而 `pnew` 已经是零，所以少写的那几格
一个字都不用发）；项数多于长度是错（同一处的 `srcElementCount <= dstElementCount`）；空项
`{ 1, , 3 }` 算一项、跳过不写（84_CurlyInitializers.jnc:45 那行是七项，其中四项是空的）。

（"`[]` 的长度 = 项数"这一句第十四刀查出来是错的：jancy 数的是**非空**项，见那一节。）

**长度只认十进制整数字面量。** jancy 那边它是编译期常量表达式，我们没有常量折叠 —— 与其偷偷
接受一个求值不出来的东西，不如明着拒。

**边界五条，都是同一格**：多维数组 `int a[10][20]`（元素是 `int[20]`，而 `ptrTargetOk` 只放行
int / real / bool / struct）、数组之间的赋值、数组形参与返回、数组字段、`&a`（`T(*)[N]`）。它们
与 `&p`（第九刀留下的那条）、整个结构体的 `pload`/`pstore` 是**一格**：要方言能把多个字的值当
内存里的东西搬。`bad/array-2d.jnc` 与 `bad/array-copy.jnc` 是前两条的本体。

**期望输出的出处**：C，一份 `cc -O0` 编出来的程序抄在 `cases/10-arrays.jnc` 的头注里，12 行
逐字节相同；第 13 行（空项那一格）与 `int c[2];` 那一行的出处是 jancy 的文档与语法，头注里
分开注明了 —— C 表达不出前者、后者在 C 里是未定值。`bad/array-decl.jnc` 删掉，本体转到
`cases/10-arrays.jnc`。

**跑过的轴**：`tests/jnc`（18/0，新增 `cases/10-arrays`、`rt/arr-oob`、`bad/array-2d`、
`bad/array-copy`，删掉 `bad/array-decl`）、`tests/sexpr`（63/0）、`tests/glr`（20/0）。
**没跑的**：`tests/asy` 全部（这一刀只碰 `frontend-jnc/lower.js`）、`sweep.js`、`svg.js`、自举、
`tests/jit`、`tests/mir`、`tests/llvm`。`npm run lint` 这台机器上没有 typescript，跑不了。

### 第十一刀：模块级变量 —— 顺序照 jancy 的 module.construct，方言现成

`(global 名字 类型)` 是方言第二十四刀就有的东西，而且零初始化、读写用 `(var …)` / `(set …)`
都是现成的。所以这一刀真正要定的只有一件事：**初值什么时候跑**。

出处不是文档而是 jancy 的源码。`Module::createConstructor`（`jnc_ct_Module.cpp:869`）里
`module.construct` 的顺序写得很直白：

1. 把所有 static 变量 `zeroInitialize`；
2. 跑 primer（class 的那一批）；
3. 按声明序跑各自的 **initializer**；
4. 跑构造函数。

然后才轮到用户代码。方言这边正好对得上：第 1 步方言自己做（`(global …)` 出来就是零），
第 3 步就是 `(main …)` 开头的几句 `(set …)`，按声明序发。第 2、4 步这一刀没有对应物
（还没有 class）。

存储类照 `decl_storage.rst`：**不写就是 static**（"If storage specifier is omitted, then
global variables get assigned static storage class"），所以 `static int g = 7;` 与
`int g = 7;` 在顶层是同一件事，照收。`threadlocal` 拒 —— 它要线程本地存储，而文档自己也说
它带两条限制（不能有初值、不能是聚合），接它得连那两条一起接。

**顺带修掉的一处顺序依赖**：`run()` 现在分三遍走顶层 —— 命名类型、模块级变量、函数体。
jancy 的命名空间成员**不看声明顺序**，所以

```
int readLater() { return later; }
int later = 42;
```

是合法的（C 里不是）。函数本身仍然按源码顺序降，所以"调用后面定义的函数"照旧不收 ——
那一条与这一刀无关，单独记进了名单。

**四条边界。** `static` 的**局部量**（那是另一回事：程序启动时分配 + 初值**只跑一次**，
后一半在 jancy 那边是 `once` 的机制，cflow_once.rst 那一节就是它；悄悄当普通局部量会给错
答案，所以明着拒，`bad/static-local.jnc` 是它的本体）、`threadlocal`、`&g`、结构体的模块级
变量（与结构体的局部量同一格）。

> **第二十六刀更正**：`static` 的局部量落了，`bad/static-local.jnc` 删掉，边界收窄到
> `threadlocal`（`bad/threadlocal.jnc`）。这一条记的理由没错（当普通局部量会给错答案），
> 但"要 `once` 的机制"这句话把它说重了 —— 量下来 jancy 的 `once` 在**局部**这一格上就是
> 一道布尔闸门，就地包在声明这一处，见下面第二十六刀那一节。

`&g` 这一条值得单说：它是**方言这一侧**的边界，不是 jancy 的。jancy 的全局本来就有地址，
而第九刀给局部量装的那格 `pnew` 对全局不适用 —— 全局在方言里不在一段可寻址的内存里。
要接就得让全局也落在一段内存上，那会动到 MIR 的全局号与四条腿上全局的发法，单独一刀。

> **这一段的理由错了，第二十四刀改过来了。** 全局装得下一个**指针**（第十六刀之后），
> 所以不必"让全局落在内存里"—— 把那一格换成 `(ptr T)`、值放进一段 `pnew` 内存就行，
> 方言与四个后端一个字没改。MIR 的全局号根本没碰。见第二十四刀。

**期望输出的出处**：C，一份 `cc -O0` 编出来的程序抄在 `cases/11-globals.jnc` 的头注里，
前 9 行逐字节相同；第 10 行（`later` 那条顺序依赖）的出处是 jancy 的命名空间规则，C 表达
不出来。

**跑过的轴**：`tests/jnc`（21/0，新增 `cases/11-globals`、`bad/static-local`、
`bad/addr-global`）、`tests/sexpr`（63/0）、`tests/glr`（20/0）。
**没跑的**：`tests/asy` 全部（这一刀只碰 `frontend-jnc/lower.js`）、`sweep.js`、`svg.js`、自举、
`tests/jit`、`tests/mir`、`tests/llvm`。`npm run lint` 这台机器上没有 typescript，跑不了。

### 第十二刀：值语义的结构体 —— 与数组同一个套路，方言又是一个字没改

jancy 的 struct 是 POD **值**类型，所以 `t = s` 抄一份、不共享同一段。债务表上"整个结构体的
`pload` / `pstore`"这一条当初的判断与数组那条一样：以为要方言先能整块搬。**不用。**

做法与第十刀同一个套路：每格结构体是一段自己的 `(pnew (ptr S) (int 1))` 内存，名字里放的
**就是**那段内存的地址。于是四件事一起落下来：

- `s.f` 与 `p->f` 落在同一句 `(pfield … f)` 上（`lvalue` 的 `field` 分支现在去问 `s` 的地址，
  以前它是一句"结构体只能经指针到达"的拒绝）；
- `&s` **不发一个字**（名字里放的就是地址），`&s.in` / `&a[i]` 同理；
- `t = s` 逐字段抄（`copyAgg`，嵌套的结构体字段递归下去）；
- `S a[3]` 就是长度 3 的那段内存，`a[i].f` 是 `(pfield (padd a i) f)` —— 第十刀那条"元素只能是
  int / real / bool"的限制因此对结构体解除了。

`pnew` / `pfield` / `padd` / `pload` / `pstore` 都是第一刀就有的，而且这四条在五条腿上先量过
（零初始化、嵌套 pfield 链、struct 指针上的 padd 按元素走）才动手。

**新增的一格：lvalue 的第三种 kind `agg`。** `var` 的 code 是名字、`ptr` 的 code 是地址且读写
走 `pload` / `pstore`，`agg` 的 code 是地址但**不 pload** —— 结构体的"值"在这一层一律用它那段
内存的地址表示。`read()` 对它返回 code 本身，赋值那一处对它走 `copyAgg`。

顺带把两处旧注释改对了：`liftable` 里"这一刀的结构体还不能当局部量"不成立了（结构体本来就是
一段内存，不用再提一次；`lvalue` / `expr0` 的名字分支里 `isStruct` 要排在 `lifted` **之前**，
不然 `&s` 会去找一格不存在的 `s$c` —— 这是实现时踩到的唯一一个坑）；`localDecl` 里"结构体的
零值方言里没有一条形式"也不成立了。

**三条边界。** 按值传形参、按值回返回值 —— 抄一份的机制有了，缺的是**调用约定**那一半：谁来开
被调那一格、什么时候抄。直接把地址传过去就变成按引用，改形参会改到调用方那一份，与 C/jancy 正好
相反（那是**给错答案**，不是拒不了），所以明着拒，写 `S*` 传。第三条是结构体的花括号初值
（`S s = { 1, 2 }` 与 `new S { m_y = 2000 }`，decl_curly.rst 那一节，位置项与命名项各要一段）。

（前两条第十三刀做掉了 —— 「谁来开那一格」的答案是**被调自己开**，见下一节。花括号初值那一条
第十四刀做掉了，只剩 `new S { … }`。）

**期望输出的出处**：C，一份 `cc -O0` 编出来的程序抄在 `cases/12-structs.jnc` 的头注里，9 行
逐字节相同。C 那份里两处补了 `= { 0, 0 }`：`Inner a;` 与 `Inner arr[3];` 的零在 C 里是未定值，
在 jancy 那边是定义好的（"zeros every variable before any user code can touch it"）。

**跑过的轴**：`tests/jnc`（23/0，新增 `cases/12-structs` 与 `bad/struct-param`）、
`tests/sexpr`（63/0）、`tests/glr`（20/0）。
**没跑的**：`tests/asy` 全部（这一刀只碰 `frontend-jnc/lower.js`）、`sweep.js`、`svg.js`、自举、
`tests/jit`、`tests/mir`、`tests/llvm`。`npm run lint` 这台机器上没有 typescript，跑不了。

### 第十三刀：结构体按值传与按值回 —— 抄一份挪到被调那一侧

上一刀把两条按值的路记成"缺调用约定那一半"。真正缺的只有一句话：**谁来开被调那一格。**
一旦答案定成"被调自己开"，方言又是一个字没改。

**形参。** 签名里写 `(v (ptr P))` —— 传过去的是调用方那段内存的地址。函数一进门先开一格自己的、
逐字段抄进来，然后 `alias` 把这个名字改指自己那格，之后函数体里所有 `v` 都落在 `v$v` 上：

```
(fn show ((v (ptr P))) void
  (let v$v (ptr P) (pnew (ptr P) (int 1)))
  (pstore (pfield (var v$v) x) (pload (pfield (var v) x)))
  (pstore (pfield (var v$v) y) (pload (pfield (var v) y)))
  (pstore (pfield (var v$v) x) (int 100))          ;; 改的是自己那份
  …)
```

这与第九刀"被取地址的标量形参提一份拷贝"是同一个道理，只是抄的东西大一点 —— `pre` 那一段前奏本来
就在，加一个分支而已。嵌套的结构体字段由 `copyAgg` 递归下去（`boxSum` 里能看到 `b.p.x` 那两层
`pfield`）。

**为什么是被调那一侧，不是调用方那一侧。** 调用方那一侧要"先开一格临时的、抄进去、再把地址当实参"
——这是三条**语句**，而实参是在**表达式**里算的。这一层的表达式降级返回的是一个字符串（`{code, type}`），
没有"顺带发几条语句"的通道。改成有那个通道是一次贯穿全文件的重构；挪到被调那一侧是一个分支。
两者的可观察语义相同（改形参不影响调用方），所以选便宜的那个。

**返回。** 返回类型写 `(ptr P)`，`return r;` 就是 `(ret (var r))` —— 回的是被调自己那格的地址。
`retStmt` 与 `callExpr` 因此**一个字没改**：`expr()` 对结构体值给出的 `code` 本来就是地址，`sameTy`
本来就比结构体名。抄一份由**接收**那一侧做（声明、赋值），而第十二刀留下的 `aggSource()` 保证一个
`(call …)` 只算一次：

```
(let $s1 (ptr P) (call make (int 8) (int 9)))     ;; 先钉成一格
(pstore (pfield (var t) x) (pload (pfield (var $s1) x)))
(pstore (pfield (var t) y) (pload (pfield (var $s1) y)))
```

`s = twice(s)` 也因此对：右边先算完钉住，才逐字段抄回左边。

**唯一新长出来的一格：右值上的 `.`。** `make(11, 12).y` 以前会撞在 `lvalue` 的"这里要一个可以赋值
的位置"上 —— 那是个**误报**，jancy 那边它合法。结构体的值就是一段内存的地址，所以取字段与左值那一侧
是同一句 pfield，只是这段内存没名字：`(pload (pfield (call make (int 11) (int 12)) y))`。

**一处刻意不抄的**：`g(f())` 把 `f` 那格的地址直接当实参给 `g`，中间不抄 —— 因为 `g` 进门就会抄一份，
再抄一次是白抄。可观察语义相同（那格临时内存没有别的人指它）。

**期望输出的出处**：C，一份 `cc -O0` 编出来的程序抄在 `cases/13-struct-args.jnc` 的头注里，11 行
逐字节相同。覆盖：改形参不动调用方、嵌套结构体形参、按值回进声明、按值回进赋值、右值上的 `.`、
一串穿过去（`sum(twice(make(2, 3)))`）、自己喂自己（`s = twice(s)`）。

**跑过的轴**：`tests/jnc`（23/0，新增 `cases/13-struct-args`，删掉 `bad/struct-param` —— 那条边界
不在了，本体升成 cases，与 `bad/addr-of` -> `cases/09-addr` 同一个先例）、`tests/sexpr`（63/0）、
`tests/glr`（20/0）。
**没跑的**：`tests/asy` 全部（这一刀只碰 `frontend-jnc/lower.js`）、`sweep.js`、`svg.js`、自举、
`tests/jit`、`tests/mir`、`tests/llvm`。`npm run lint` 这台机器上没有 typescript，跑不了。

### 第十四刀：花括号初值 —— 它不是一个聚合常量，是一个游标

`{ … }` 在 jancy 里**不是**"造一个聚合值再赋过去"，而是**按格子写**：一个游标从 0 起，位置项写
一格挪一格，命名项 `f = v` 直接点名那个字段。四条语义逐字照 `CurlyInitializer`
（jnc_ct_Parser.cpp:3312..3395）：

- 空项（`{ ,, 3 }` 里那些空的）**只挪游标、不写那一格** —— `skipCurlyInitializerItem` 里只有一句
  `m_index++`。声明那一处那格刚 `pnew` 出来是零；**赋值那一处保留原值**，所以
  `point = { , 200, 300 }` 之后 `m_x` 还是上一次那个数。
- 命名项把游标设成 -1，之后**不能再写位置项** —— `prepareCurlyInitializerIndexedItem` 那句
  "indexed-based initializer cannot be used after named-based initializer"。所以
  `{ 10, m_z = 30 }` 合法、`{ m_x = 1, 2 }` 不合法（`bad/curly-after-named.jnc` 是它的本体）。
- 一项本身可以再是一对花括号（嵌套的结构体字段、结构体数组的元素）。
- 一项都没写是错（"empty curly initializer"）。

**一份引擎，四个入口。** `curlyPlan` 走一遍项、出一张"往哪个格子写什么"的单子，`curlyEmit` 照单
写下去。局部量、模块级变量、赋值语句都调它，数组与结构体也都走它 —— 目标是"一段能按格子写的
内存"，而这一层的数组与结构体本来就都是那个（第十刀与第十二刀）。第十刀那段专给数组的循环因此
整段没了。

**为什么要分两步。** 声明那一处目标那格的 `(let …)` 必须发在**所有初值之后** ——
`int a[2] = { a, 1 }` 里右边那个 `a` 指的是外层那个，可 `(let a …)` 一发出来就把它遮住了。所以
初值先降（此时目标还没进作用域），提到目标名字的那几项钉成临时量（`pin`：只在初值里出现
`(var 目标名)` 时才钉，别的项照原样），然后发 `(let …)`，最后照单子写。

**债务表上"`[]` 的长度 = 项数"这一句是错的。** jancy 数的是**非空**项：
`getAutoSizeArrayElementCount_curly`（jnc_ct_OperatorMgr_New.cpp:454）那个循环只在见过非空项之后
才 `elementCount++`。于是 `int a[] = { 1, , 3 }` 在 jancy 那边是**两格**，而写值的游标会走到第三
格 —— 它自己那两半在这一处对不上。这一层照它数长度，越界那一下当场报错（`curlyMember`），而不是
挑一边圆过去。

**语法长了一条。** `curly-item -> ID "=" curly`：命名项的值本身可以是一对花括号
（Expr.llk:1028 那条 `ID '=' (curly_initializer | expression)`），而 `initializer` 里刻意不含裸
花括号，所以它得单列一格。`jnc.table` 从 351 条规则 632 个状态变成 352 / 633，正好这一条。

**两条边界。** `new T { … }`（decl_curly.rst 最后那一格）：花括号初值是**几条语句**，而这一层的
表达式降级只交出一段文字，没有"顺带发几条语句"的通道 —— `while (new T { … })` 那种位置连"提到
前面去"都不成立（条件每一圈都要重算）。声明与赋值是语句位置，所以那两处收。第二条是
`char buffer[] = { 10, 20, "null-terminated", … }`：char 数组里混字面量要"一格一个字节"的存储
宽度，与那处刻意留下的差别（四种位宽都占一个 64 位槽）是同一格。

> **第一条第二十五刀收了。** 那条"语句通道"确实立不住 —— 换的办法是把那几条语句**抬成一个
> 函数**，项的值当实参在调用方求，于是 `new T { … }` 仍旧是一个表达式。`bad/curly-new.jnc`
> 因此删掉，重划到 `new T[n] { … }` 上（只记在边界表里）。见第二十五刀。

**期望输出的出处**：前 11 行是 C（`cc -O0 -std=c99`，抄在 `cases/14-curly.jnc` 的头注里，逐字节
相同）—— jancy 的 `m_z = 30` 与 C99 的 `.m_z = 30` 是同一件事，jancy 的空项对应 C 的 `[i] =`。
后 6 行 C **写不出来**（C 的 `p = (Point){ … }` 是整块盖过去、剩下的补零，jancy 不是），所以那
几行的出处是 jancy 的源码：`skipCurlyInitializerItem` 只把游标 ++。

**跑过的轴**：`tests/jnc`（26/0，新增 `cases/14-curly`、`bad/curly-after-named`、`bad/curly-new`）、
`tests/sexpr`（63/0）、`tests/glr`（20/0，`snapshots/jnc.table` 照那一条新规则刷了一次）。
**没跑的**：`tests/asy` 全部（这一刀只碰 `frontend-jnc/` 那两份）、`sweep.js`、`svg.js`、自举、
`tests/jit`、`tests/mir`、`tests/llvm`。`npm run lint` 这台机器上没有 typescript，跑不了。

### 第十五刀：不看顺序的名字 —— 签名先过一遍

jancy 的命名空间成员**不看顺序**：解析那一遍只把名字登记进命名空间，函数体排进
`m_compileArray`，**解析完了**才由 `Module::processCompileArray`（jnc_ct_Module.cpp:809）一个个
编 —— 编到某个体的时候整份模块的名字早就齐了。所以 `isEven` 调后面的 `isOdd`、模块级变量的初值
调后面的 `later`，在 jancy 那边都合法，而这一层以前是按源码顺序降的，调后面的函数会撞在
"没有这个函数"上。

**改动只有一处**：`fnDef` 拆成 `fnSig` + `fnDef`。前者算说明符、声明符与形参表，登记
`this.fns`，结果按节点存进 `this.sigs`；后者拿回去降函数体。`run` 于是是**四遍**：命名类型 ->
**函数签名** -> 模块级变量 -> 函数体。签名那一遍排在模块级变量之前，所以 `int g = later(2);`
也成立（第十一刀那条"初值按声明序跑在用户代码之前"不变）。

**方言那一侧本来就不看顺序** ——`(module (fn a () int (ret (call b))) (fn b () int (ret (int 7))) …)`
在五条腿上都给 7，先量过才动手。所以这一刀方言又是一个字没改。

顺带把 `int main()` 的查重从"`mainBody` 还是 null 吗"改成一格 `mainSeen`：那一格现在要在签名
那一遍就判（那时候还没有任何函数体）。

**期望输出的出处**：C，一份 `cc -O0` 编出来的程序抄在 `cases/15-forward.jnc` 的头注里，前 4 行
逐字节相同 —— C 那份得多写三条原型，那正是这一刀去掉的东西。第 5 行（`g=20`）C 里写不出来
（`int g = later(2);` 在 C 里不是常量初值），它的出处是第十一刀那一条。

**跑过的轴**：`tests/jnc`（27/0，新增 `cases/15-forward`）、`tests/sexpr`（63/0）、
`tests/glr`（20/0）。
**没跑的**：`tests/asy` 全部（这一刀只碰 `frontend-jnc/lower.js`）、`sweep.js`、`svg.js`、自举、
`tests/jit`、`tests/mir`、`tests/llvm`。`npm run lint` 这台机器上没有 typescript，跑不了。

### 第十六刀：指针的地址 —— 这一次是**方言**长出来的一格

前十五刀方言一个字没改。这一刀改了：`(ptr T)` 的 T 以前不收指针，理由记在 `ptrTargetOk` 上 ——
"fat 指针自己（三个字）落不进内存"。现在它落得进。

**长出来的东西只有布局那一句。** `hir/types.js`：`ptrTargetOk` 放行 `ptr` / `tptr`，
`sizeOf(ptr) = 24`、`sizeOf(tptr) = 8`、两者 `alignOf = 8`。三个字的次序就是 `{addr, base, end}`，
五条腿一致 —— JS 与两个解释器写的是 arena 里的偏移、C 与 LLVM 写的是真地址，**值不同但格子数
与次序相同**，所以按字节算的东西（`psub`、结构体字段偏移）在两套实现里对得上。

**五条腿各加一格读写**：
- `backend-js`：`$pload_p` / `$pstore_p`（三个 `getBigInt64` / `setBigInt64`，读回来转 Number ——
  这条腿的三元组里放的是 Number）、`$pload_t` / `$pstore_t`（一个字）。
- 两个解释器：`interp/builtin.js` 的 `ptrLoad` / `ptrStore` 各加 `ptr` / `tptr` 两个 kind；
  `mir/interp.js` 里 PLOAD/PSTORE 的 kind 从 `kindOf`（那一份的"其余"是"不是四种标量"）换成
  新的 `memKind`（这一份的"其余"是 bool）——**两处的默认值本来就不是一回事**，混用是个坑。
- C 与 LLVM：**一个字没改**。`cTypeName(ptr)` 早就是 `omni_ptr`，C 里结构体之间有赋值；
  LLVM 那边 `T_PTR` 是 `{ ptr, ptr, ptr }` 的一等聚合值，`load` / `store` 直接吃它。

**jnc 那一侧也只改了一个字**：`liftable` 也收指针。于是 `&p` 与第九刀的 `&x` 走同一条路
（把 p 提到一格 `(pnew (ptr (ptr int)) (int 1))` 上），`int**` / `int***` / `**pp` / `*pp = q` /
`new int*[n]` / 把 `&p` 当出参传，全都跟着落地 —— 一条新规则都没写。

**当时没顺带开的一格：结构体的指针字段。** `(struct S (p (ptr int)))` 撞的是 `sexpr/lower.js`
里字段类型那张白名单，与 `ptrTargetOk` 是两处闸门。链表那一族（`Node* m_next`）要的是它 ——
单列成了下面的第十七刀。

**期望输出的出处**：两处。方言那一层是 `tests/sexpr/cases/30-ptrptr.sx`（17 行，五条腿逐字节
相同）—— 其中最硬的一条是 `psub`：它跨块是**运行期错误**，指针从内存里读回来之后 psub 不报错，
说明三个字（不只是地址那一个）都回来了。jancy 那一层是 `cases/16-ptrptr.jnc`，9 行，出处是
一份 `cc -O0` 的 C 程序（用 `calloc` 对上 jancy 的零初始化）。

**跑过的轴**：`tests/sexpr`（64/0，新增 `cases/30-ptrptr`）、`tests/jnc`（28/0，新增
`cases/16-ptrptr`）、`tests/glr`（20/0）、`tests/asy/run.js`（这一刀动了**共享**的类型层与两个
解释器，所以那条轴这次必须跑，不能像前七刀那样以"只碰 frontend-jnc"为由跳过）。
**没跑的**：`tests/asy` 的 `sweep.js` 与 `svg.js`、自举、`tests/jit`、`tests/mir`、`tests/llvm`。
`npm run lint` 这台机器上没有 typescript，跑不了。

### 第十七刀：结构体的指针字段 —— 两处闸门里的第二处，与"名字先坐下"

`Node* m_next`。这一刀方言又长了一格，但**不是**上一刀那一格：上一刀开的是"`(ptr T)` 的 T 能是
指针"（`ptrTargetOk`），这一刀开的是"指针能躺在结构体的**字段**里"（`sexpr/lower.js` 的
`structDec` 里那张白名单）。两处闸门是分开的，量过 —— 第十六刀落地之后
`(struct Cell (link (ptr int)))` 仍旧被拒。

**方言这一侧改了三处。** 一是字段白名单收 `ptr` / `tptr`。二是**结构体的名字也"先坐下、字段
后填"**：`(struct Node (next (ptr Node)))` 里的 Node 要在自己的体里查得着，落法与类那一刀
（第六十二刀的 `preClass`）同一套 —— 先给每个 `(struct …)` 建一格**空**的类型对象，再**原地**
填字段数组，于是指针字段拿到的和后来填满的是同一个对象。三是那张"自己/后面"的诊断从
`aggLater` 改问 `preStruct`（还没填字段的那些），因为名字先坐下之后 `this.structs.has(tn)`
已经为真了。

**为什么自引用在指针后面摊得开，直接内嵌却不行。** 指针是**三个字**，它的尺寸与目标的布局
无关（`sizeOf(ptr) = 24`，`structLayout` 都不用问），零值是空指针 —— 没有递归。直接内嵌是真的
内嵌，`(struct A (n A))` 的零值要铺一份 A 才能铺完 A。所以那一条约束**留着**，只是诊断多说了
一句"隔一层指针可以"：`tests/sexpr/bad/struct-self.sx` 与 `struct-fwd.sx` 两条钉的还是这一半。

> **后半句第二十三刀改过来了。** "直接内嵌不行"只对"绕回自己"这一半 —— 内嵌一个**声明在
> 后面**的结构体是行的（名字先坐下、字段就地填，等这一遍走完布局自然算得出来）。
> `struct-fwd.sx` 那条边界因此删掉了，改成好用例 `cases/34-embed-order.sx`；剩下的那一半
> 由 `bad/struct-self.sx` 与新的 `bad/struct-mutual.sx` 钉着。见第二十三刀。

**顺带补上的一个次序问题**：`(ptr S)` 收下来的那一刻 S 可能还空着（自引用），所以"S 里有落不
进内存的字段（比如 `string`），指不到它身上"这一问在 `ty()` 里问不动了 —— 挪到所有结构体都填
完之后补一遍。

**五条腿各补一格零值**，读写一格都没加（`pfield` 回来的是 `(ptr (ptr T))`，`pload` 走的就是
第十六刀那一格）：
- C：`zeroExpr` 加 `ptr -> omni_pnull()` / `tptr -> ((char *)0)`。这条腿会为**每个**声明过的
  结构体发一份 `omni_new_S_*`，所以哪怕源码里没写 `(new Node)` 也得有这一格 —— 那正是这一刀
  第一次跑 `run-c` 时炸的地方（`c.zero: ptr`）。
- LLVM：`fieldTy` 加 `ptr -> { ptr, ptr, ptr }` / `tptr -> ptr`，`fieldZero` 加
  `zeroinitializer` / `null`。COPY 那条 `load %s_S` / `store %s_S` 把三个字一起搬走，
  不用另写一条。
- JS 与两个解释器：**一个字没改**。JS 那条腿有自己的 `zero`，两个解释器**共用** `interp/builtin.js`
  的 `zeroOf`（`mir/interp.js` 是 import 过去的），而那两份里 `ptr -> [0,0,0]` / `tptr -> 0` 两条
  **早就写着**了（注释上就写着"这一条是结构体的指针字段要的"）—— 上一刀铺路时顺手留下的，
  这一刀才走到。顺带确认了一件事：JS 那条腿的 `$cp_S` 是**浅**拷（`{ f: v.f }`），指针字段因此
  两份共用同一个三元组数组 —— 这没问题，因为 fat 指针在这条腿上**从不原地改**
  （`$padd` / `$psub` / `$pstore_p` 都是回一个新数组），与 LLVM 那边"它是值类型"是同一条。

**jnc 那一侧只多了一遍**：`typeName`（名字先坐下）。字段类型本来就走 `tyText`，`Node*` 写出来
就是 `(ptr Node)`；`memberOf` 是在函数体降级时才查那张表的，那时候字段早填完了。于是
`n->next->val`、`&c[i]`、循环里往头上插、`Node t = c[0]`（值语义的复制**连指针那三个字一起
抄**，两份因此指同一格）全都跟着落地 —— 一条新规则都没写。

**期望输出的出处**：两处。方言那一层是 `tests/sexpr/cases/31-struct-ptr-field.sx`（五条腿逐字节
相同）；jancy 那一层是 `cases/17-linked.jnc`，出处是一份 `cc -O0` 的 C 程序（`calloc` 对上
jancy 的零初始化），逐字节相同 —— 最有意思的一行是 `copy=10 77 1`：抄完之后两份的 `val` 各自
一份、`next` 指同一格。

**仍旧是一条真差别**：**直接内嵌**的结构体字段还要求"前面已经声明过"，而 jancy 的名字不看
顺序（`struct Seg { Point a; }` 写在 `struct Point` 之前，我们拒、jancy 收）。要补的是方言那
一侧"内嵌的零值按拓扑序铺"，与这一刀开的指针字段是两回事。量过了才写进边界表的：
`/tmp/order.jnc` 上拒的那一句就是方言发出来的。

> **这条差别第二十三刀补掉了。** 不需要"按拓扑序铺零"—— 名字先坐下之后布局本来就算得出来，
> 那条约束是多余的。见第二十三刀。

**跑过的轴**：`tests/sexpr`（65/0，新增 `cases/31-struct-ptr-field`，两条 bad 的期望文字跟着
诊断改了）、`tests/jnc`（29/0，新增 `cases/17-linked`）、`tests/glr`（20/0）、`tests/asy/run.js`
（259/0，281.7s —— 这一刀动了**共享**的 `sexpr/lower.js` 与 C/LLVM 两个后端，所以那条轴必须跑）。
**没跑的**：`tests/asy` 的 `sweep.js` 与 `svg.js`、自举、`tests/jit`、`tests/mir`、`tests/llvm`。
`npm run lint` 这台机器上没有 typescript，跑不了。

### 第十八刀：一段 N 格的定长内存 —— 方言先长出来，前端下一刀再接

数组那一族剩下的四条（多维数组、数组形参与返回、数组字段、`&a`）要的都是同一格方言：
`(ptr T)` 的 T 能是**一段 N 格的定长内存**。这一刀只做方言这一侧 —— 长出那一格并把它钉住，
前端换过去是下一刀（理由在末尾）。

**新增两样，都很小。** 类型 `(blk T N)`：N 格 T，`alignOf` 是元素的对齐、`sizeOf` 是
`N × 元素步长`。表达式 `(pelem p)`：`(ptr (blk T N))` -> `(ptr T)`，**地址与范围一个字都不动**，
变的只有"接下来的 `padd` 一步跨多少"。于是 `int a[3][4]` 就是 `(ptr (blk int 4))` 上的 3 格，
`a[i][j]` 是 `(padd (pelem (padd a i)) j)` —— 行主序不用另外定，它是这两条的算术结果。

**`(blk T N)` 不是一个值。** 它只在 `(ptr …)` / `(tptr …)` 的目标位置认（所以 `blkTy` 不从
`ty()` 里走），`pload` / `pstore` 撞它是**当场报错**而不是"以后再说"：没有能装一整块的槽，
四条腿上都没有。两条 bad 钉着这一半，而且钉的是诊断的**指向** ——「用 `(pelem p)` 退成元素
指针再读/写」，而不是「换个值」。`pstore` 那一条特意排在 `sameCoreType` **之前**：不然报出来
的是「指向 int[4]、写进去的是 int」，那句话把人往换值的方向带，而真正要换的是指针。

**运行期它是恒等的，所以 MIR 上连一条新指令都没有。** 四个 OIR 消费者各加一行，全是"把操作数
交出去"：`backend-js` 与 `backend-c` 回同一个值，`interp/eval.js` 回同一个三元组，
`mir/from_oir.js` 回同一个 ref（两边的 MIR 类型都是 `T_PTR`，跨多少字节在**下一条** `padd` 的
aux 上）。**MIR 解释器与 LLVM 后端一个字没改** —— 它们看不见这一步。这也是选 `pelem` 而不是
"让 `padd` 自己认 blk"的理由：后者要在每条腿的 padd 上分情况，前者只在类型层面走一步。

**为什么前端留到下一刀。** 这一层现在的数组是"一段 `pnew` 出来的内存 + 一条 `(ptr 元素)`"，
换成"一块 `(ptr (blk 元素 N))`"要同时动六处：declarator（后缀得**从右往左**套 ——
`int a[10][20]` 的元素是 `int[20]`，现在那个循环是从左往右叠的）、`decay`、下标、花括号初值、
`&a[i]`、数组形参。混在一刀里，一旦五条腿有一条对不上就分不清是方言那一格错了还是换表示错了。
所以先把方言这一格单独钉住 —— `cases/32-blk.sx` 已经把多维、三维、行内与跨行的 `psub`、
`peq` 都量在五条腿上了。

**期望输出的出处**：`tests/sexpr/cases/32-blk.sx`，五条腿逐字节相同。行主序那一条的依据是 C 的
多维数组布局（jancy 没改它 —— 它的 `int a[10][20]` 元素类型就是 `int[20]`），零初始化那一条是
type_ptr_data.rst。刻意不印任何裸地址。

**跑过的轴**：`tests/sexpr`（68/0，新增 `cases/32-blk` 与两条 bad）、`tests/jnc`（29/0 ——
这一层三处 nope 的话改了，从"要方言的指针能指向数组"改成"方言那一格有了、这一层还没换过去"）、
`tests/glr`（20/0）、`tests/asy/run.js`（259/0，283.5s —— 这一刀动了共享的 `hir/types.js`、
`sexpr/lower.js` 与四个 OIR 消费者，所以那条轴必须跑）。
**没跑的**：`tests/asy` 的 `sweep.js` 与 `svg.js`、自举、`tests/jit`、`tests/mir`、`tests/llvm`。
`npm run lint` 这台机器上没有 typescript，跑不了。

### 第十九刀：多维数组 —— 一格数组里躺的是**一整块**的地址

上一刀开了方言那一格，这一刀把这一层的数组换过去 —— 方言**一个字没改**。

**换的是那一格里躺什么。** 以前 `int a[3]` 是"一段 `pnew` 出来的 3 格内存 + 一条
`(ptr int)`"；现在是"**一整块**的地址"：`(pnew (ptr (blk int 3)) (int 1))`。一维时这两种表示
的地址与范围完全一样（都是那 3 格的头，范围 24 字节），所以现有的 12 条 case 一条没动 ——
换表示在一维上是**不可观测的**，这也是敢换的理由。多维就分得开了：`int a[3][4]` 是
`(ptr (blk (blk int 4) 3))`，`a[i]` 是块里的第 i 格，它自己又是一块 `int[4]`。

**动了五处，都很短。**
- `tyText`：`arr` -> `(ptr (blk …))`，配一个 `blkText` 在元素也是数组时递归（多维）。
- `decay`：退化从"只改类型、不发一个字"变成方言的一句 `(pelem …)` —— 地址与范围仍旧一个字
  不动，变的只有"接下来 `padd` 一步跨多少"。多维退一层就是一行。
- `declarator`：方括号先攒进 `dims`，出了循环**从右往左**套。C 与 jancy 的
  `int a[10][20]` 元素是 `int[20]`，从左往右叠会得到 `int[20][10]` —— 一维时看不出差别，
  多维就错了。顺带钉住"只有最外那一维能写成 `[]`"（里层的长度是元素的尺寸，数不出来）。
- lvalue 的 `index`：那一格里躺的是数组时 kind 是 `agg` 而不是 `ptr` —— 与结构体同一档，
  读它**不发** `pload`（那一块不是一个值，方言会当场报错，见第十八刀的两条 bad）。
- `curlyEmit`：下标那一步从 `(padd acc i)` 变成 `(padd (pelem acc) i)`。嵌套的花括号初值
  （`int b[2][3] = { { 1, 2, 3 }, { 4, 5, 6 } }`）因此不用另写一条 —— 它本来就是"步骤"折出来的。
- 三处 `pnew` 的个数：数组也是**一格**了，一律 1。

**期望输出的出处**：`cases/18-array2d.jnc`，出处是一份 `cc -O0` 的 C 程序，逐字节相同。
量在里面的有：四角与中间、一行退化成 `int*` 传给函数、把整块当一条连起来的内存看
（`flat[4]` 就是 `a[1][0]`，行主序）、经行指针写回去原数组跟着变（退化不复制）、嵌套花括号、
写不满时余下的格子是零、三维。C 那份用 `long long` 是为了对上这一层的存储宽度。
删掉了 `bad/array-2d` —— 那条现在**通**了。

**跑过的轴**：`tests/jnc`（29/0，新增 `cases/18-array2d`，五条腿逐字节相同）。
**没跑的**：`tests/sexpr` / `tests/glr` / `tests/asy` —— 这一刀只动了
`src/core/frontend-jnc/lower.js` 一个文件，共享面一个字没碰。
自举、`tests/jit`、`tests/mir`、`tests/llvm` 照旧没跑；`npm run lint` 这台机器上没有 typescript。

### 第二十刀：数组的地址 —— 一个字都不用发，与一个 jancy 自己说不出的名字

上一刀把数组那一格换成了"**一整块**的地址"，这一刀的结论因此是**空的**：`&a` 要的正是那一格
里已经躺着的东西。所以这一层**一个字都不用发** —— `&a` 就降成 `(var a)`。

**为什么是空的。** C 里 `a` 与 `&a` 值相同、类型不同（`int*` 对 `int(*)[3]`）。到了方言，
`int[3]` 与 `int(*)[3]` 是**同一个写法** `(ptr (blk int 3))` —— 那一格本来就是块地址，
"退一层"是 `(pelem …)`，"不退"就是原样。差别整个落在这一层的类型账上，运行时零成本。

**这一条要排在 lvalue 之前。** `addrOf` 开头先看"目标是不是一个局部数组名"，命中就直接回
`(var a)`。绕开 lvalue 是必须的：数组名在那儿会被当赋值目标处理，而数组之间没有赋值
（`a = b` 是拒的），`&a` 却合法。顺带把 `expr0` 的名字分支与 lvalue 的 `indirect` 里
数组与结构体归成一档（`agg`：不发 `pload`），并删掉声明处两处"提到堆上"的旧拒绝
—— 那两条是第九刀为"标量取地址要提堆"写的，数组本来就在堆上，不需要提。

**量出来的边界：`int(*pa)[3]` 这种声明，jancy 自己的语法里就没有。**
`jnc_ct_Declarator.llk:402` 的 `declarator_prefix` 只有 `'*' type_modifier*`，
整条 `declarator` 是 `declarator_prefix* declarator_name declarator_suffix* declarator_constructor?`
—— **没有 C 那种带括号的声明符分组**。所以 `T(*)[N]` 在 jancy 里是个**说不出名字**的类型，
`&a` 只能就地用。按"jancy 不向方言妥协"的反面：jancy 没有的东西，我们也不替它长出来。
这条与第十九刀量出的"数组之间的赋值不是我们欠的"归在同一栏 —— 不过那一条**只对了一半**，
下一刀把它改过来了（同型数组的赋值 jancy 是通的，见第二十一刀）。

**期望输出的出处**：`cases/19-addr-array.jnc`，出处是一份 `cc -O0` 的 C 程序，逐字节相同。
量在里面的有：`(*&a)[i]` 读、经它写回去原数组跟着变、`*&a` 退化成 `int*` 传给函数、
二维时 `&a` 与行指针的关系、`&a == &a`。

**跑过的轴**：`tests/jnc`（30/0，新增 `cases/19-addr-array`，五条腿逐字节相同）。
**没跑的**：`tests/sexpr` / `tests/glr` / `tests/asy` —— 这一刀又只动了
`src/core/frontend-jnc/lower.js` 一个文件，共享面一个字没碰。
自举、`tests/jit`、`tests/mir`、`tests/llvm` 照旧没跑；`npm run lint` 这台机器上没有 typescript。

### 第二十一刀：数组是**按值**的一整块 —— 并纠正前两刀记错的一条边界

**先纠错。** 第十刀起我一直写着"数组之间的赋值 jancy 自己也只在常量折叠那条路上有
（`Cast_Array::llvmCast` 里写着未实现）"，还照这条写了 `bad/array-copy`。这条**是错的**。
`castOperator`（`jnc_ct_OperatorMgr.cpp:473`）在挑到 `Cast_Array` 之后先按它的
`m_opFlags = OpFlag_LoadArrayRef`（`jnc_ct_CastOp_Array.h:26`）走 `prepareOperand`，那一步
`loadDataRef` 把**整块**载成一个值（`jnc_ct_OperatorMgr_DataRef.cpp:72` 的 `createLoad`）；
紧接着第 527 行的 `opType->isEqual(type)` 恒等捷径成立，载出来的值**直接交出去**，
`llvmCast` 根本没被叫到。所以**同型**数组之间是通的，`llvmCast` 那句"未实现"只挡长度不一样、
或元素是同宽的另一种整数那些。`bad/array-copy` 因此删掉，换成
`bad/array-copy-len`（`int b[5] = a;`）。

**于是这一刀要的是"按值"。** 而且方向与我原先记的**相反**：`Parser::createFormalArg`
（`jnc_ct_Parser.cpp:2507`）算完声明符类型后，`TypeKind_Array` 那一支**只**在
`ArrayTypeFlag_AutoSize` 时报错（2528 那句 "function cannot accept auto-size array"），
别的数组原样存进 `FunctionArg` —— jancy **不做 C 那种"形参退化成 `T*`"**，
`void f(int v[3])` 拿到的是**一整块的一份拷贝**。返回也是：`prepareReturnType`
（`jnc_ct_DeclTypeCalc.cpp:425`）只拒 class / function / property 与长度省掉的那种，
`int g() [3]` 是合法的。这一条上 jancy 与 C **给出不同答案**，所以这一份的期望输出
**不能**拿 `cc -O0` 做孪生 —— 每一行的出处只能是它的源码。

**落到这一层，就是"数组与结构体归成一档"。** 结构体那三刀（值语义、按值传、按值回）已经把
路铺好了：一格聚合就是一段自己的 `pnew` 内存，「抄一份」在这一层展开成若干 pload/pstore，
按值传把那一下挪到**被调**那一侧。数组只是把"逐字段"换成"逐格"：
- `copyVal(dst, src, type)` 是新的分发口 —— 结构体走 `copyAgg`、数组走 `copyArr`、
  别的就是一句 `pstore` + `pload`。`copyAgg` 的字段循环也改成调它，于是嵌套（结构体里的
  结构体、数组的元素是结构体）自然递归下去。
- 退化那一句从"总退"变成"**要的不是数组就退**"：jancy 的退化不在"取值"那一步，是在
  "转成目标类型"那一步（`Cast_DataPtr_FromArray`，`jnc_ct_CastOp_DataPtr.cpp:24`）。
  所以 `expr` 里只加了一个条件：`want` 是 `T[N]` 时不退。这一条改完，实参、返回、赋值
  三处**同时**对了 —— 它们本来都往 `expr` 里传 `want`。
- `fnSig` 的两条拒绝换成了 jancy 自己的那两条（长度省不掉），`fnDef` 的形参前奏多认一种，
  lvalue 的名字分支里数组与结构体同为 `agg`，花括号初值的一项也可以是一整块
  （plan 里的 `struct` 字段变成 `agg`，存类型而不是名字）。

方言**一个字没改** —— `(ptr (blk T N))` 本来就能当形参、当返回、当全局的槽。

**期望输出的出处**：`cases/20-array-value.jnc`，每一行都注着 jancy 的哪一处。量在里面的有：
形参里改了不动调用方、按值传进去再读出来、`int b[3] = a` 与 `c = a` 抄一份、二维形参、
结构体数组的形参（逐格再逐字段）、`int rows[2][3] = { a, b }`、模块级 `int h[3] = g`、
`int g() [3]` 回一整块且两次调用互不相干。另外两条 bad：`array-copy-len`（长度不一样）、
`array-param-autosize`（`int a[]` 当形参，jancy 自己就拒）。

**跑过的轴**：`tests/jnc`（32/0 —— 新增 `cases/20-array-value` 与两条 bad，删掉
`bad/array-copy`，五条腿逐字节相同）。
**没跑的**：`tests/sexpr` / `tests/glr` / `tests/asy` —— 这一刀第三次只动了
`src/core/frontend-jnc/lower.js` 一个文件，共享面一个字没碰。
自举、`tests/jit`、`tests/mir`、`tests/llvm` 照旧没跑；`npm run lint` 这台机器上没有 typescript。

### 第二十二刀：数组字段 —— 两处闸门里的第一处，与"这一块不是一个值"

第十七刀开的是字段类型白名单里的**指针**，这一刀开的是**定长内存**：`(struct S (v (blk int 4)))`。
布局那一层从第十八刀起就已经会算它了（`hir/types.js` 的 `alignOf` / `sizeOf` /
`structLayout` 都有 `blk` 那一支），所以方言这一侧缺的只有两样：那张白名单，
和字段位置上对 `(blk …)` 的分发（它不在 `ty()` 的表里 —— 第十八刀只在指针目标那一处认它）。

**"不是一个值"这条线在字段上仍然成立。** `(fld …)` / `(fldset …)` 走的是"结构体是一个值"
那条路，而 `(blk T N)` 没有能装它的槽（与 `bad/blk-load` / `bad/blk-store` 同一条理由）。
所以两处都当场拒，话里带着出路：`(pelem (pfield p v))`。内嵌那 N 格只能**在内存里**碰。
类的字段也不收 —— 类是引用，字段在堆上那一格里，内嵌一整块要另一套零值。

**五条腿各加一格零值。** 这是"结构体当**值**"那条路要的（`(new S)` / C 的
`omni_new_S_*`），jnc 程序其实从不走它，但 C 后端对每个声明过的结构体都会发那个函数 ——
第十七刀就在这儿被绊过一次。
- JS 后端与解释器：结构体的值是一个带命名字段的对象，blk 字段留一格 N 个元素零值的数组。
  这一格**观察不到**（整块读写方言不给、`fld` 也拒），留着只是让"逐字段铺零"处处有东西可写。
- C 后端：字段声明的方括号跟在**名字后面**，所以 `cTypeName` 拼不出来 —— 多出一个
  `fieldDecl`，而且多维**摊平成一维**（`int64_t v[2][3]` 与 `v[6]` 同尺寸同对齐，
  而 arena 那一侧是字节 + 偏移、根本不经过这个 C 类型）。铺零是一个 `for`：C 里数组不能整块赋值。
- LLVM 后端：LLVM 自己就有这个类型 —— `[N x T]`，摊在父对象里，零值是 `zeroinitializer`。

**元素是结构体的那一块，顺带逼出两处早就该有的修补。** `P ps[2]` 这个字段在 C 里是
`s_P ps[2]`、在 LLVM 里是 `[2 x %s_P]`，两处都要求 `P` **先是完整类型**：
- C 后端的 `sortAggregates` 收依赖时只看字段类型本身，`(blk P 2)` 里的 `P` 会被漏掉 ——
  改成先把 blk 剥到元素那一层。
- LLVM 后端的命名类型是按**类型池**发的，而池子是按指令用到的类型攒的：`P` 只出现在
  `Row` 的字段里与 `(pfield …)` 上（后者到 MIR 已经是字节偏移），所以它根本不在池里，
  `%s_Row` 引到一个没体的 `%s_P` 就成了 opaque，clang 报
  `base element of getelementptr must be sized`。改成沿着**内嵌**关系补一遍闭包
  （类字段是 `ptr`，不跟进去 —— 也因此不会绕出环）。这一处对**内嵌的结构体字段**本来就
  漏着，只是以前那种程序总会顺带把内层类型用进池子里，一直没露出来。
- 而且元素结构体必须是**前面已经声明过**的那个（`blkTy` 里新加的一条）：与直接内嵌同一条
  规矩。这一问要看 `preStruct`（"名字先坐下、字段还空着"），不能看 `structLayout` ——
  空结构体的 layout 不是 null，是 `{fields: [], size: 0}`。

> **这一条第二十三刀撤了。** "前面已经声明过"这条约束把真毛病（按值绕回自己）与
> 顺序问题混在了一起，而后者根本不是毛病 —— 见下面第二十三刀。

**前端这一侧只有三处。** `typeDecl` 不再拒数组字段；字段的类型文本走新的 `fieldText`
（结构体是 `S`、数组是 `(blk T N)` —— 都是内嵌，与 `slotText` 正好相反的两处）；
`memberOf` 里数组字段与结构体字段同为 `agg`。**抄一份不用改**：第二十一刀的 `copyVal`
本来就按字段类型分发，数组字段自然递归到 `copyArr`，所以 `Box c = b;` 是深抄。

**期望输出的出处**：`cases/21-array-field.jnc`，出处是一份 `cc -O0` 的 C 孪生程序，逐字节相同
——字段这一侧 jancy 与 C 一致（第二十一刀量出的"jancy 不是 C"只关形参与返回）。量在里面的有：
刚出来全零、`b.m_v[i]` 与 `b->m_v[i]` 读写、二维字段行主序、字段那一块退化成 `int*` 后
写回去原对象跟着变、`Box c = b` 深抄、花括号初值里嵌花括号、写不满时余下是零。
方言那一侧是 `cases/33-blk-field.sx`（五条腿逐字节相同，含 `(new S)` 那条铺零的路、
与元素是结构体的那一块 `P ps[2]`）与 `bad/blk-fld.sx`。

**跑过的轴**：`tests/sexpr`（70/0，新增 `cases/33-blk-field` 与 `bad/blk-fld`）、
`tests/jnc`（33/0，新增 `cases/21-array-field`）、`tests/glr`（20/0）、`tests/asy`（259/0 ——
这一刀动了共享面：`sexpr/lower.js` 与四个后端/解释器的零值，所以这一轴必须重跑）。
**没跑的**：自举、`tests/jit`、`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第二十三刀：直接内嵌不看顺序 —— 撤掉一条自己立的规矩，换一条真的

债务表上挂了六刀的那一条差别：`struct Seg { Point a; }` 写在 `struct Point` 之前，jancy 收、
我们拒。补法本来记成"内嵌的零值按拓扑序铺" —— **量了一遍发现根本不用**。

**为什么不用。** 第十七刀为了指针字段已经把结构体改成"名字先坐下、字段后填"：`run()` 先扫一遍
`(struct …)` 把每个名字连一个**空的**字段数组放进 `this.structs`，再逐条填。而那一格是
**就地填**的（`pre.fields.push(f)`，不是换一格新的），所以 `Seg` 的字段里存的 `Point` 与后面
那条声明填的是同一个对象 —— 等这一遍走完，`structLayout(Seg)` 顺着字段问下去，尺寸自然算得出来。
那条"只收前面声明过的那个"从落地起就是多余的：它挡的是**中间那一刻**（`Point` 还空着、
`sizeOf` 算出来是 0），而那一刻根本没人问尺寸。

**剩下真的解不出来的只有一种：按值绕回自己。** `(struct S (v S))` 与
`(struct A (b B)) (struct B (a A))` 的大小都是"自己加一点"。原来那条规矩把这一种与顺序问题
混在了一起，所以撤掉它就得单独补一遍环检测：新的 `cutValueCycles(forms)` 是一趟 DFS，
按值那些边（结构体字段，以及 `(blk T N)` 剥到元素之后是结构体的那些）往下走，撞回**栈上**
还在走的那个就报。指针、类、`(arr T)` 都隔了一层（三个字 / 一个引用），不是内嵌边。

**报完还要把闭环那条字段摘掉**（`st.fields.splice(i, 1)`）。这不是"修好"，是因为 `chunk()`
从来不在第一条诊断上停 —— 后面还要走 `structLayout` / `sizeOf` 与各后端的排序，那几处都顺着
字段递归，图上留着环就不是报错而是**挂住**。摘完这张图无环，后面那些照常走完、诊断照常汇总。
报的位置是**这个结构体自己那条声明**（环上没有"第一处"，而声明才是用户要改的那一行）。

**顺带把第二十二刀的一处 next-pass 一起挪了。** `(blk S N)` 收下来的那一刻 `S` 也可能还空着，
所以"S 里有落不进内存的字段（比如 `string`），排不成一段定长内存"这一问也得挪到字段都填完
之后 —— 就是第十七刀给 `(ptr S)` 开的那同一遍后置检查，这一刀给它加了 blk 那一支。

**这一刀的出处在 jancy 自己的实现里，而且两半都在同一个函数上。** `Type::prepareLayout`
（`jnc_ct_Type.cpp:221`）是**按需**算布局的 —— 真要用到尺寸的那一刻才 `calcLayout()`，
名字解析走的是命名空间（不看顺序）。而它的第一句就是另一半：`TypeFlag_InCalcLayout` 已经
置上时报 `can't calculate layout of '%s' due to recursion`（`:225`）。换句话说 jancy 的
分界线正是"绕回自己拒、声明在后面收"，与这一刀改成的样子逐条对上 —— 这一次不是"方言让一步"，
是我们原来那条线画错了地方。

**前端一个字没改。** jnc 那侧的 `typeName` / `typeDecl` 早就是两遍（第十七刀），
`(struct A (b B))` 这样的文本本来就发得出来 —— 之前是方言把它拒了。

**期望输出的出处**：`cases/22-embed-order.jnc`，出处是一份 `cc -O0` 的 C 孪生程序，
逐字节相同 —— 但孪生程序里两条 struct 声明得**换过来**（C 要求被内嵌者先是完整类型），
换顺序不改任何一个值。量在里面的有：刚出来全零、内嵌那一格读写、`Seg t = s` 深抄、
元素是后面才声明的结构体的那一块（`Cell m_cs[2]`）、那一块退化成 `Cell*` 后写回去原对象跟着变。
方言那一侧是 `cases/34-embed-order.sx`（五条腿逐字节相同，含 `(new Seg)` / `(new Box)` 那条
铺零的路，与两个字段之间的 `psub` —— 偏移算对了才对得上）。边界是 `bad/struct-self.sx`
（改了诊断文字）与新的 `bad/struct-mutual.sx`；`bad/struct-fwd.sx` **删掉**了 ——
「边界因为功能落地而通过」时删掉重划，它拒的那个程序现在是 `cases/34-embed-order.sx` 的开头几句。

**跑过的轴**：`tests/sexpr`（71/0，新增 `cases/34-embed-order` 与 `bad/struct-mutual`，
删掉 `bad/struct-fwd`）、`tests/jnc`（34/0，新增 `cases/22-embed-order`）、`tests/glr`（20/0）、
`tests/asy`（259/0 —— 这一刀动的是**共享**的 `sexpr/lower.js`，那条轴必须跑）。
**没跑的**：`tests/asy` 的 `sweep.js` 与 `svg.js`、自举、`tests/jit`、`tests/mir`、`tests/llvm`；
`npm run lint` 这台机器上没有 typescript。

### 第二十四刀：`&g` —— 债务表上记着"要动方言"，量完发现一个字都不用改

`&g` 从第九刀起就挂在边界表上，理由记的是「全局不在一段可寻址的内存里，要接就得让方言的全局
也走 `pnew`，那会动到 MIR 的全局号与四条腿上全局的发法，单独一刀」。**那条理由是错的。**

**先量了一句**：`(module (global gp (ptr int)) (main (set gp (pnew (ptr int) (int 1))) …))`
在五条腿上都跑得通 —— 指针类型的全局方言本来就收（MIR 那个 8 位类型码里指针早就有一格，
第十六刀让 fat 指针落得进内存时顺带把这一格填上了）。既然全局装得下一个指针，
"全局有地址"就不用方言操心了：**把那一格本身换成指针**就行。

**于是这一刀落在前端，与第九刀是同一套办法。** 被 `&` 取过地址的**标量**模块级变量：

```
int g = 5;  int* p = &g;    ->    (global g (ptr int))
                                  (main (set g (pnew (ptr int) (int 1)))     ; 阶段一
                                        (pstore (var g) (int 5))             ; 阶段二
                                        (let p (ptr int) (var g)) …)
```

读写全走那一格（`(pload (var g))` / `(pstore (var g) …)`），`&g` 就是 `(var g)` 自己 ——
别名是真的。判定复用第九刀的 `collectAddrTaken`，只是这一遍在 `run()` 里对**整份源码**数一次：
`&g` 出现在函数体里，而 `(global …)` 得在那之前发。保守的代价也一样 —— 同名的局部量会把全局
一起带上，多一次 `pnew`，没有可观测差别。"那一格"不用另起名字（局部量那边是 `x$c`），
因为全局自己就是那一格。

**数组与结构体的模块级变量本来就能取地址**，`addrOf` 里那条 `!r.global` 是多余的：
`int t[3]` / `P s` 的全局那一格里放的**就是**一段 `pnew` 内存的地址（第十二刀 / 第十九刀），
`&t` / `&s` 一个字都不用发。去掉那半个条件就通了。

**顺带把两阶段的顺序摆正。** jancy 的 `module.construct` 是"先把所有 static 零初始化，
再按声明序跑各自的 initializer"。我们这边"要一段自己的内存"的那些 `pnew` 以前是**混在**
初值语句里按声明序发的，于是"初值里调的函数读另一个全局"会读到空指针而不是零。现在
`pnew` 全排在初值之前（`globalCells` 与 `globalInit` 两个列表）—— 与 jancy 那两阶段对齐了。

**剩下的那一半仍旧是方言的边界**：`string` 的模块级变量取不到地址，因为 `liftable` 不收它
（方言的 `(ptr T)` 目标只要落得进内存的那些，见 `ptrTargetOk`）。`bad/addr-global.jnc`
换成了钉这一条 —— 原来那条（`int g`）因为功能落地而通过了，删掉重划。

**期望输出的出处**：`cases/23-addr-global.jnc`，出处是一份 `cc -O0` 的 C 孪生程序
（全局写成 `static`，取地址在 C 里是同一件事），逐字节相同。量在里面的有：`&g` 与直接读写
互为别名两个方向、没写初值的那一格、指针全局的 `&gp`（`int**`，`*pp = &h` 改的是全局本身）、
`real` 与 `bool` 那两格、`&t[1]` 与 `(*&t)[0]`、`&s` 之后经 `ps->m_x` 写回去。
刻意避开了求值顺序未定的写法（不在同一个 `printf` 里既改一格又读它）。

**跑过的轴**：`tests/jnc`（35/0，新增 `cases/23-addr-global`，`bad/addr-global` 重划）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy` —— 这一刀**只**动了
`frontend-jnc/lower.js`，方言与四个后端一个字没改，那三条轴都不经过这个文件；
自举、`tests/jit`、`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第二十五刀：`new T { … }` —— 那几条语句抬成一个函数，与顺带落地的"`.` 就是 `->`"

`new T { … }`（`samples/jnc/84_CurlyInitializers.jnc:66`：
`Point* point2 = new Point { m_y = 2000, m_z = 3000 }`）挂在边界表上的理由是对的：花括号初值
是**几条语句**，而这一层的表达式降级只交出一段文字。但记的补法（"在表达式降级里开一条语句
通道"）**立不住** —— 那条通道要把语句提到当前语句之前，而 `while (new T { … })` 的条件每一圈
都要重算，提出去就只算了一次。

**换的办法是把那几条语句抬成一个函数。** 项的值在**调用方**这一侧求（顺序与作用域都还是原来
那个），`pnew` 与逐格写在被调那一侧：

```
new Point { 1, twice(k), { 7, 8 } }
  ->  (fn $newc0 (($i0 int) ($i1 int) ($i2 int) ($i3 int)) (ptr Point)
        (do (let $p (ptr Point) (pnew (ptr Point) (int 1)))
            (pstore (pfield (var $p) m_x) (var $i0)) …
            (ret (var $p))))
      (call $newc0 (int 1) (call twice (var k)) (int 7) (int 8))
```

于是整个 `new T { … }` 就是**一个表达式**，放哪儿都成立，每次求值都真的新开一格 —— 惰性位置
上也对。方言一个字没改。项的值当实参传进去正好解掉两件事：一是"在调用方求值"，二是名字的
作用域（被调那一侧只看得见形参，不会误捕调用方的局部量）。聚合的那些项传的是那一格的地址
（`slotText`），抄一份由被调里的 `copyVal` 做 —— 与第十三刀"抄在被调那一侧"是同一条。

**顺带落地的是"`.` 与 `->` 在 jancy 里是同一个算符"。** 那份 sample 第 67 行写的是
`point2.m_x`，而 `point2` 是 `Point*` —— 我们以前报「'.' 的左边不是结构体：Point*」。落法是
一个 `structBehind(t)`：结构体那一格与"指到结构体的指针"都算，两者的 code 都是那一段内存的
地址，差别只是后者多一次 `pload`。顺带把 `.` 的左边不是**可写形状**的那些（`f().x`、
`(new T { … }).x`、`mk(20).m_in.m_b`）合到同一条路上：不是可写形状就当右值求一次值，
回来的那一格也是一段内存的地址。expr0 那边因此少了一个分支 —— 全落到 `lvalue` 上。

**边界重划。** `bad/curly-new.jnc` 删了（功能落地）。剩下的那一条是 `new T[n] { … }`：
jancy 的语法把个数**折进类型名**（`new_operator_type : type_name_impl<&type, &elementCount>`，
`jnc_ct_Expr.llk:726`），我们的语法把 `new T[n]` 与 `new T curly` 分成了两条产生式，合不到
一起。而且它写哪一格也**量不出来**（`new_operator_curly_initializer` 是先 `*p` 再套花括号，
个数 >1 时那一格只是第一格）—— 语义没量清的不硬接，只记在边界表上。

**期望输出的出处**：`cases/24-new-curly.jnc`，出处是一份 `cc -O0` 的孪生程序（`calloc` 对上
jancy 的零初始化、写不满时余下的格子是零），逐字节相同。量在里面的有四种位置（声明的初值、
实参、`while` 的条件、项本身是一整格聚合的 deep copy）加 `.` 的四种用法（读、写、
右值上的 `.`、直接在 `new` 上取字段）。

**跑过的轴**：`tests/jnc`（35/0，新增 `cases/24-new-curly`，删掉 `bad/curly-new`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy` —— 这一刀又只动了
`frontend-jnc/lower.js`；自举、`tests/jit`、`tests/mir`、`tests/llvm`；
`npm run lint` 这台机器上没有 typescript。

### 第二十六刀：`static` 的局部量 —— "初值只跑一次"量下来就是一道布尔闸门

第十一刀把 `static` 的局部量拒了，理由记的是「要 `once` 的机制」。这一刀先去量 jancy 到底
怎么落它 —— 结果是两处代码，加起来比那句话轻得多。

**存储那一半。** `decl_storage.rst` 说 static 是"the memory for variable is allocated at the
program start and it stays there until the program terminates"，而 local 是"every time
intruction pointer goes through a variable declaration, this will be a **new** copy"。所以那
一格就是**模块级的一格槽**，方言里早就有：`(global 名字 T)`。名字上带一个计数（`名字$sN`）躲
开同名 —— `$` 不在 jancy 的标识符里，撞不上用户写的名字。作用域还是那个块：它进的是
`this.scopes`，只是那一格上多记一条"我在方言里叫别的名字、而且是模块级的"。这一条落在
`push` / `lookupRef` 上（条目从裸类型变成 `{t, d, s}`），三处解析名字的地方都过一遍它。

**初值那一半。** 关键的一句在 `jnc_ct_VariableMgr.cpp:209` —— 一个变量的初值只有在
`parentNamespace` 是**全局**的时候才进 `m_globalVariableInitializeArray`。也就是说 static
**局部**量的初值**不在** `module.construct` 里跑。那它在哪儿跑？`jnc_ct_Parser.cpp:2452`：

```
onceStmt_Create / onceStmt_PreBody / initializeVariable / onceStmt_PostBody
```

四句，**就地**包在声明这一处。而且 2454 行还有一条：`variable->m_initializer.isEmpty()` 时这
四句一句都不发。所以落法是一格布尔闸门加一句

```
(if (un "!" (var 名字$sN$1)) (do (set 名字$sN$1 (bool true)) …初值…))
```

第一次走到这儿才跑，之后每次都跳过；没写初值的一个字都不发（`(global …)` 出来就是零，与
jancy 那边"初值空着就不包 once"是同一件事）。**方言一个字都没改** —— 与第二十四刀一样，
债务表上"要某种机制"那句话，量完发现现成的零件就够。

**取地址与聚合都是老零件。** `&c` 走第二十四刀那条：被 `&` 取过地址的标量提到一段自己的内存
里（`(global c$sN (ptr int))` 加一句 `pnew`），跟着 `globalCells` 在程序开头分配好。static 的
数组与结构体本来就是"一格里放地址"，同一条路。花括号初值那条产生式另有一条尾巴
（`staticLocalCurly`）：`curlyPlan` / `curlyEmit` 一个字不改，只是发到闸门里面去。

**顺手抓到一处名字漏改。** `aggTarget`（`a = { … }` 的左边）以前直接用源码里的名字发
`(var a)`，既没过 `dialectName`（结构体形参那份拷贝的别名，第十三刀）也不知道 static 换了
名字。这一刀把它改成与 `lvalue` 同一条 `dname` 计算 —— `cases/25-static-local.jnc` 的
`arrset()` 就是它的本体。

**`once` 里那半句刻意没接。** cflow_once.rst 说编译器生成的是"a thread-safe wrapper"。这一层
没有线程（四条腿里没有一条能开线程），所以那道闸门是**裸的**布尔，不是原子的 —— 这不是偷懒，
是"没有线程"这个前提下唯一说得清的落法。`threadlocal` 同理，边界收窄到它
（`bad/threadlocal.jnc`）：一格线程一份存储这一层给不出来，而文档自己还给它记了"不能有初值、
不能是聚合"两条限制，接它得连那两条一起接。

**期望输出的出处**：`cases/25-static-local.jnc`，出处是一份 `cc -O0` 的孪生程序 —— C 的
static 局部量就是同一件事。两处 C 说不出来的写法在孪生里显式手写：`lazy()` 的**非常量**初值
（把 once 的闸门写出来）、`arrset()` 的 `b = { … }`（逐格写的那两句 store）。逐字节相同。量在
里面的有：计数器、非常量初值（`mkinit()` 只被调一次 —— 这一条正是"只跑一次"与"每次重算"的
分水岭）、`&` 取地址、static 的数组与结构体、`a = { … }` 的左边、没写初值的（出来是零）、
以及 static 在**内层块**里（走不到就不初始化，但只初始化一次）。

**跑过的轴**：`tests/jnc`（36/0，新增 `cases/25-static-local` 与 `bad/threadlocal`，
删掉 `bad/static-local`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy` —— 这一刀又只动了
`frontend-jnc/lower.js`（加 `tests/jnc/run.js` 的头注释）；自举、`tests/jit`、`tests/mir`、
`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第二十七刀：printf 的精度与 `*` —— 债务表上那两条，出处是 C 库自己

第八刀做了 `%f` 的精度，同时把"整数与 `%s` 上的精度"记成边界（`bad/int-precision.jnc`），
理由是"与小数无关的两件事，各要自己的一段"。`%*d` 也记着，理由是"宽度运行期才知道，
与'格式串必须是字面量'同一处"。这一刀把两条都做掉，顺带把**出处**这件事说清。

**出处升级成一等。** 以前 printf 这一族的期望输出写的是"照 C 的 printf"。这一刀去量了
jancy 到底怎么印：`jnc_std_StdLib.cpp:733` 的 `std::printf` 只有一句
`sl::formatString_va(formatString, va)`，而那一路（`axl_sl_StringDetails.h:390/401`）就是
**C 库的 `vsnprintf`**。所以 jancy 的 printf 语义**逐字**是 C 的，`cc -O0` 的孪生程序不是
"近似"而是同一份实现 —— 这一族的所有期望值都可以这么定，而且是可复核的。

**`%*d` 那条记错了。** "宽度运行期才知道"确实对，但补空格那一步本来就是运行期算的
（`(srep (str " ") (bin "-" w (slen s)))`）—— `w` 从一个字面量换成一段表达式，一个零件都不用
新加。所以 `padTo` 的 `w` 参数从数字改成一段方言代码，`%*d` 就通了。C 的一条边角也照收：
**宽度实参是负数等于写了 `-` 标志、宽度取绝对值**（C99 7.19.6.1），那是运行期一个 `sel`。

**整数上的精度不是"零补到宽度"。** `%.3d` 是"**至少**三位**数字**"—— 零补在符号**后面**，
而且它与宽度是两件事：`%8.3d` 先补到三位数字、再补到八个字符宽。所以它不能借 `padTo`
（那一格算的是**总长**），得单独一段 `precInt`。两条边角：精度是 0 而值是 0 时**一个字符都
不印**（C99 7.19.6.1 那句 "The result of converting a zero value with a precision of zero is
no characters."）；整数上**一写精度 `0` 标志就作废**（`%08.3d` 补的是空格）。后一条还牵出一处
连带的：宽度 1 平时不用补，可精度能把那段变成空串，所以 `%1.0d` 印 0 得是一格空格。

**`.*` 的负数等于"没写精度"。** 整数那一路自己就成立（负的个数进 `srep` 回空串），`%s` 那一路
要显式挡一下（`(ssub …)` 不夹范围，越界是运行期错误）。而 `%0*.*d` 是唯一要**运行期判 `0`
标志**的一格：精度一写出来 `0` 就作废，而实参是负数等于精度没写、那时 `0` 又活着 ——
`padTo` 的 `zero` 因此收三种值（`false` / `true` / 一段运行期的 bool）。`sel` 降成 Ternary
（两支各一个基本块），所以嵌一层不会把两边都算一遍。

**两条拒得起的。** `%.*f` 卡在**方言这一侧**：`(sfix E N)` 现在要求 N 写成字面量
（`sexpr/lower.js` 那句"(sfix E N) 的位数要写成字面量 (int N)"），要接就得动方言的类型检查
加五条腿上四份实现，单独一刀（`bad/printf-star-prec-f.jnc`）。`%c` 上的精度在 C 里是
**未定义行为**（clang 直说 "precision used with 'c' conversion specifier, resulting in
undefined behavior"）—— 没有可对的答案，所以拒；这一条不是"我们少做一件事"。

> **第二十八刀更正**：`%.*f` 落了（方言真的长了一格），`bad/printf-star-prec-f.jnc` 删掉，
> printf 的边界收窄到**转换字符**那一族（`%e` / `%g` / `%u` / `%p`，`bad/printf-conv-e.jnc`）。
> 这一节说"要动五条腿上四份实现"—— 量下来那四份**本来就是按值收 N 的**，一个字都没改。
>
> **第三十刀再更正**：`%e` / `%E` 也落了（方言长出 `(ssci E N)`），边界再收窄成
> `%g` / `%u` / `%p`（`bad/printf-conv-g.jnc`）。这一句里"`%e` / `%g` 要方言里一条按 C 的
> `%e` / `%g` 排版的算子"是对的，可它把两条并成一条说了 —— 量下来它们不是同一条：`%e` 只要
> "小数点固定在第一位后面"，`%g` 还要"两种样式里挑短的、去尾随零、而 `#` 又不去"。

**期望输出的出处**：`cases/26-printf-prec.jnc`，一份 `cc -O0` 的孪生程序，逐字节相同（五条腿
也各自与它逐字节相同）。孪生里只删掉了 `%.3c` 那一行 —— clang 明说它是 UB，UB 不能当出处。

**跑过的轴**：`tests/jnc`（37/0，新增 `cases/26-printf-prec` 与 `bad/printf-star-prec-f`，
删掉 `bad/int-precision`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy` —— 这一刀又只动了
`frontend-jnc/lower.js`（加 `tests/jnc/run.js` 的头注释），方言一个字没改；自举、`tests/jit`、
`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第二十八刀：`%.*f` —— 这一刀方言真的长了一格，而四条腿一个字都没改

第二十七刀把 printf 的标志、宽度、精度收齐了，只剩 `%.*f`，记的理由是"方言的 `(sfix E N)`
要求 N 写成字面量，要接得动方言与五条腿上四份实现"。这一刀先去量那四份 —— 结果是
**它们本来就是按值收 N 的**：

- JS 后端：`$str_fixed(x, p)`（prelude），p 是个 BigInt，`Number(p)` 之后照算
- C 运行时：`omni_str_fixed(double v, int64_t p)` -> `omni_str_fmt("%.*f", n, v)`
- LLVM 后端：同一个 `omni_str_fixed`（`params: ['double', 'i64']`）
- 两个解释器：`fmtFixed(a[0], a[1])`

"位数要写成字面量"这条限制**只在** `sexpr/lower.js` 的那一处检查里，理由写的是
"printf 里它永远是字面量"—— 那句话在 `%.*f` 面前就是错的。所以这一刀方言长的是**那一处
检查**：N 是字面量时照旧当场判范围（诊断更早、更准），不是字面量时收一段 int 表达式。

**范围那一条落到运行期，四份实现同一句话。** 0..30 的上界要留着（它让 C 那侧 `%.*f` 的缓冲
有个头），可位数是运行期值时只能运行期判。这儿有个真的选择：**夹一下**还是**报错**。C 运行时
以前就是夹的（`if (n > 30) n = 30`，注释写着"这里只兜底"）—— 但夹会给一个**错的答案**：
C 那边 `%.40f` 是真印 40 位的。所以四处都改成当场停，同一句
`sfix precision out of range: 40 (0..30)`（`rt/sfix-range.jnc` 量的正是"同一句"）。
这也把那条注释里"方言限死、这里只兜底"的分工写清了：字面量归降级期，表达式归运行期。

**前端那一侧只多一个 `sel`。** C 里精度实参是负数等于"没写精度"，`%f` 没写精度就是 6 ——
所以 `(sfix v (sel (bin "<" p (int 0)) (int 6) p))`。

**期望输出的出处**：`cases/27-printf-star-prec.jnc`，一份 `cc -O0` 的孪生程序，逐字节相同
（五条腿也各自与它相同）。量在里面的：三种位数、负数（回到 6）、**就近取偶还在**
（`%.2f` 印 0.125 是 `0.12` —— JS 的 `toFixed` 会给 `0.13`，这条不变式不能因为位数变成运行期
值就丢）、动态宽度配动态精度、以及位数是个变量。

**跑过的轴**：`tests/jnc`（39/0，新增 `cases/27-printf-star-prec`、`rt/sfix-range`、
`bad/printf-conv-e`，删掉 `bad/printf-star-prec-f`）、`tests/sexpr`（71/0，`cases/29-sfix`
末尾多了运行期位数那一段）。sexpr 这次**要跑** —— 这一刀动了方言。
**没跑的**：`tests/glr`（语法一个字没改）、`tests/asy`（asy 那一侧压根不发 `sfix`，
grep 过）；自举、`tests/jit`、`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有
typescript。

### 第二十九刀：`+` / 空格 / `#` —— 难处不是多印一个加号，是前缀与补零的先后

C 的五个标志到这儿齐了（`-` 与 `0` 是第八刀那会儿的）。上一刀把这三个记成"还没接"，
并且把 C 那一边先量了下来 —— 这一刀照那份量出来的表落。

**真正的难处。** `0` 补的零在 C 里排在**前缀后面**：`%+05d` 是 `+0042`（不是 `00+42`）、
`%#08x` 是 `0x0000ff`。而前缀的长度**不定**：符号一个字符、`0x` / `0X` 两个。原先 `padTo`
是"看第一个字符是不是 `-`，是就把它摘出来"—— 那个形状在 `+` / 空格 / `0x` 面前就不够了。
所以这一刀把 piece 拆成**前缀 + 主体**两段拿着：`padTo(pfx, code, …)`，`precInt` 也只收
不带符号的那几位。拆开之后三条规则各归其位，不再互相打结：

- 符号在**精度外面**：`%+.3d` 是 `+007`；`%+.0d` 印 0 是**光一个 `+`**（数字那截空了，
  前缀还在）
- 符号也在**补零外面**：`%+05d` / `% 05d`
- `#` 的 `0x` 同样在补零外面：`%#08x` 是 `0x0000ff`

**三条 `#` 各是一件事，出处都在 C 那边量过。** `%#x` / `%#X` 是 `0x` / `0X` 前缀，可
**值为 0 时不加**（`%#x` 印 0 还是 `0`）—— 所以那一判要在补零**之前**做（补过之后 `0000`
就看不出值是不是 0）。`%#o` 是"逼出一个前导 0"，C99 的说法是"把精度提到让第一位是 0"，
所以它在精度**之后**：`%#o` 印 8 是 `010`，而 `%#.4o` 是 `0010`（已经以 0 开头，不再加）。
`%#f` 是"小数点一定印"：`%#.0f` 印 1 是 `1.`。

**`+` 与空格同时写时 `+` 赢**（clang: "flag ' ' is ignored when flag '+' is present"）。

**新拒的三处是另一种拒。** `%+x` / `% x`（`+` 与空格是有符号转换的事，而 `%x` 把实参当无符号
读）、`%#d` / `%#s` / `%#c`、以及早先那条 `%c` 上的精度 —— clang 对每一条都直说
"results in undefined behavior"。**没有可对的答案的东西不猜**，这与"还没长出来"
（`%e` / `%g` / `%u` / `%p`）是两种不同的拒，`tests/jnc/run.js` 的头注释把这一分类记下了。

> **第三十刀更正**：那一族里的 `%e` / `%E` 落了，"还没长出来"这一半现在是 `%g` / `%u` / `%p`
> （`bad/printf-conv-g.jnc`）。分成两种拒这件事没变。

**期望输出的出处**：`cases/28-printf-flags.jnc`，一份 `cc -O0` 的孪生程序，15 行刁钻组合
逐字节相同（五条腿也各自与它相同）。

**跑过的轴**：`tests/jnc`（41/0，新增 `cases/28-printf-flags` 与 `bad/printf-plus-hex`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy` —— 这一刀只动了 `frontend-jnc/lower.js`
（加 `tests/jnc/run.js` 的头注释），方言一个字没改；自举、`tests/jit`、`tests/mir`、
`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第三十刀：`%e` / `%E` —— 方言长的这一格，难处在"进位会把指数顶上去"

printf 的**转换字符**那一族第一次被打开。`%e` / `%E` 是 C 的 `%.6e`：`d.dddde±dd`，整数部分
正好一位、指数至少两位、符号一定印。

**方言长了一格**：`(ssci E N)`。它与第八刀的 `(sfix E N)`（`%.Nf`）是同一族的另一格 ——
舍入（就近取偶）、位数范围（0..30）、"N 不必是字面量"三条一字不差，所以在 `sexpr/lower.js`
里两条走**同一段代码**，只差一个内建名字。C 运行时那份就是 `omni_str_fmt("%.*e", …)` 一行，
它才是出处；另外三份（`$str_sci`、`fmtSci`、以及 LLVM 那条腿的 ABI 一行）照它写。

**这一格独有的两处难处**，都不是"多印一个 e"：

**一是进位会把指数顶上去**。`%.2e` 印 `9.999` 是 `1.00e+01` —— 舍入之后那 N+1 位数字变成了
N+2 位，指数得跟着加一。这一步在方言那一层做（四份实现里都有"顶到 `10^(N+1)` 就除十、指数
加一"），因为它是"这个数怎么排版"的一部分，不是 printf 的事。

**二是十进制那一位在哪，不能用 `Math.log10` 数**。10 的整数次幂附近它会差一格，而这一格差了
整个输出就错了。JS 那两份按精确值数：`e >= 0` 时 `m * 2^e` 本身是整数，位数一数就有；`e < 0`
时 `m / 2^f = m * 5^f / 10^f`，于是 `m * 5^f` 的位数减去 `f` 就是答案。`5^1074` 是个七百多位
的 BigInt，但只算一次。

**`#` 这一格在 frontend 做，不在方言做**。C 里 `%#.0e` 印 1.5 是 `2.e+00` —— 小数点要插在 `e`
**前面**，与 `%f` 的"补在末尾"不是同一件事。所以这一层先找 `e` 在哪再插；`nan` / `inf` 那两支
没有 `e`，先挡掉（`ssub` 越界是运行期错误，不挡就是一次崩）。大写照 `%X` 那条分工走
`(supper …)`：`ssci` 只给小写。

**边界收窄成 `%g` / `%u` / `%p`**（`bad/printf-conv-g.jnc`）。`%g` 看着最近 —— 方言的
`(tostr E N)` 就是 `%.Ng`，量下来平常那些值上逐字节相同。可它不是同一个算子，有三处量出来的
差别：`%#g` **不去尾随零**（C 印 `1.50000`，`tostr` 给 `1.5`）；C 里精度 0 **等于 1**
（`%.0g` 印 1.5 是 `2`），而 `(tostr E 0)` 不是那个意思、现在的实现在那一格上直接抛
（`toExponential(-1)`）；`(tostr E N)` 的 N 只收字面量，所以 `%.*g` 落不下来。**所以 `%g` 要
方言再长一格，不是把 `tostr` 拿来用。**

> **第三十一刀更正**：`%g` / `%G` 落了（方言长出 `(sgen E N)` 与 `(sgenk E N)` 两格 —— 上面说
> "再长一格"，实际是两格，因为 `#` 改的是"去不去尾随零"、那是排版本身的一部分）。边界收窄成
> `%u` / `%p`。上面这三处差别一条没错，可它漏了第四处，也就是真正难的那一处：`%g` 选样式看的
> 是**舍入之后**的指数。

**期望输出的出处**：`cases/29-printf-sci.jnc` 与 `tests/sexpr/cases/30-ssci.sx`，各有一份
`cc -O0` 的孪生程序，逐字节相同（五条腿也各自与它相同）。越界那句话有 `rt/ssci-range`
（与 `rt/sfix-range` 是一对，两条各有自己的名字，不共用一句）。

**跑过的轴**：`tests/jnc`（43/0，新增 `cases/29-printf-sci`、`rt/ssci-range`、
`bad/printf-conv-g`，删掉落地了的 `bad/printf-conv-e`）；`tests/sexpr`（72/0，新增
`cases/30-ssci`）—— 这一刀动了方言，所以这条轴必须跑。
**没跑的**：`tests/glr`（语法一个字没改）、`tests/asy`（`(ssci …)` 是新加的一格，asy 那边
没人用它，`sfix` 那一路一个字没动）；自举、`tests/jit`、`tests/mir`、`tests/llvm`；
`npm run lint` 这台机器上没有 typescript。

### 第三十一刀：`%g` / `%G` —— 它是定义在 `%e` 与 `%f` 之上的，所以先有那两格才能有它

转换字符那一族里最后一格浮点。C99 7.19.6.1 定义 `%g` 的方式很特别：它**不直接说怎么排版**，
而是说"用 `%e` 还是 `%f`、精度各是多少"。所以这一刀能这么便宜，全靠第八刀与第三十刀已经把
那两格做对了 —— 顺序反过来是做不成的。

**方言长了两格**：`(sgen E N)` = `%.Ng`，`(sgenk E N)` = `%#.Ng`。为什么是两个名字而不是加
一个 bool 参数：`#` 在格式串里是**编译期**就定了的，而方言的每一格都是表达式 —— 加一个 bool
参数等于给方言引入一条新惯例，换来的只是省一个名字。

**那四条规则**（每一条都先在 C 那边量过）：`P = N == 0 ? 1 : N`；`X` 是"按 `%.{P-1}e` 印会用的
指数"；`-4 <= X < P` 用 `%.{P-1-X}f`、否则用 `%.{P-1}e`；没写 `#` 时去掉小数部分的尾随零。

**第二条里"舍入之后"那四个字是这一刀的全部难处**。`%.2g` 印 `99.9` 是 `1e+02` 而不是 `1e+02`
以外的任何东西 —— 它先舍成 `1.0e+02`，X 因此从 1 变成 2，于是从 `%f` 那一支跳到了 `%e` 那一支。
所以 X 不能算，只能**先真的印一遍 `%e` 再读它的指数**。旁边那一行 `%.2g` 印 `9.99` 是 `10`
（舍成 `1.0e+01`，X 还是 1、留在 `%f` 那一支），两行放一起才说得清。

**`#` 那一支还捎带着 `%f` / `%e` 上"小数点一定印"那条**：`%#.0g` 印 1.5 是 `2.`、`%#.1g` 印 100
是 `1.e+02`。第一版漏了它，孪生程序当场把两处都指出来了。

**JS 那侧顺手拆了一层**：`%g` 选中 `%f` 那一支时位数能到 `N-1-X`（X 最小 -4），也就是 33 ——
比方言给 `sfix` 的上界 30 还大。所以 prelude 里把 `$str_fixed` / `$str_sci` 各拆成"查范围的
外壳"与"按普通数收位数的内层"，`$str_gen` 用内层。native.js 那份本来就是那个形状。

**`(tostr E N)` 与 `sgen` 现在有重叠**：那一条就是 `sgen`（永远去零）的子集，只是 N 只收字面量、
范围 1..17。**这一刀不动它** —— asy 那边在用，合并是另一件事。这是这一刀留下的一笔债。

**边界收窄成 `%u` / `%p`**（`bad/printf-conv-u.jnc`），而这两条不是同一种：`%u` 量下来
**不要方言长任何东西**（C 把实参当无符号读、位数是提升之后那一格 —— 与 `%x` 一字不差，
`char c = -56; printf("%u", c)` 是 `4294967240`，而 `(sbase E 进制)` 本来就把实参当无符号 64 位
读、进制也不限于 8 / 16），它只是**下一刀**的事；`%p` 是**这一层不做** —— 它要观测裸地址，
而那在五条腿上根本不是同一个数（决策一）。

> **第三十二刀更正**：`%u` 落了，边界只剩 `%p`。上面那句"不要方言长任何东西"量准了 ——
> 这一刀方言真的一个字没改。

**期望输出的出处**：`cases/30-printf-gen.jnc` 与 `tests/sexpr/cases/31-sgen.sx`，各有一份
`cc -O0` 的孪生程序，逐字节相同（五条腿也各自与它相同）。越界那两句话有 `rt/sgen-range` 与
`rt/sgenk-range`。

**跑过的轴**：`tests/jnc`（46/0，新增 `cases/30-printf-gen`、`rt/sgen-range`、
`rt/sgenk-range`、`bad/printf-conv-u`，删掉落地了的 `bad/printf-conv-g`）；`tests/sexpr`
（73/0，新增 `cases/31-sgen`）—— 这一刀动了方言，这条轴必须跑。
**没跑的**：`tests/glr`（语法一个字没改）、`tests/asy`（`sgen` / `sgenk` 是新加的两格，asy 那边
没人用；`tostr` / `sfix` 那两路一个字没动 —— prelude 里 `$str_fixed` 拆成两层是纯粹的搬家，
外壳的签名与那句越界的话都没变）；自举、`tests/jit`、`tests/mir`、`tests/llvm`；
`npm run lint` 这台机器上没有 typescript。

### 第三十二刀：`%u` —— 量下来它就是第七刀那条路，进制换成 10

转换字符那一族收尾。这一刀**方言一个字都没长**，frontend 里净增的也只有三处：白名单加个
`u`、`intConv` 加个 `u`、`(sbase … (int 进制))` 那一格从"8 还是 16"变成"8 / 10 / 16"。

**为什么这么便宜**：C 的 `%u` 与 `%x` 是**同一条**规则 —— 把实参当 unsigned 读，位数是默认
实参提升之后那一格。`char d = -56;` 上 `%x` 给 `ffffffc8`、`%u` 给 `4294967240`，是同一个
32 位数的两种写法（都量过）。而方言的 `(sbase E 进制)` 本来就把实参当无符号 64 位读、进制
那一格也不限于 8 / 16。第七刀把难的那一半（掩到 `promo(位宽)` 位）做完了，这一刀只是又用了它。

**顺手钉的一条 UB**：`%#u` 在 C 里是未定义行为（clang: "flag '#' results in undefined
behavior with 'u' conversion specifier"），`bad/printf-alt-u.jnc`。`+` / 空格 那一半本来就
被 `bad/printf-plus-hex` 那条规则挡着（`%u` 不是有符号转换）。

**边界只剩 `%p`**（`bad/printf-conv-p.jnc`），而它是**第三种拒**：不是"还没长出来"，是
**这一层不做**。裸地址在五条腿上不是同一个数（三条 arena 模拟、两条真指针），而"不许观测裸
地址"这条纪律正是那两套实现能一直逐字节对上的原因 —— 为 `%p` 破掉它，换来的是整条轴失去意义。
`tests/jnc/run.js` 的头注释因此从"两种拒"改成了"三种拒"。

**printf 的表面到这儿齐了**：五个标志、宽度、精度、`*` / `.*`、`d i u o x X e E f g G c s %`。
剩下的是**长度修饰符**（`%ld` / `%llu` / `%hhd` 那一族）—— 这一层的位数从**类型**上取，所以
C 那边要写修饰符的地方这边不写；真遇到 jancy 源码里写了修饰符，那是下一条边界。

**期望输出的出处**：`cases/31-printf-u.jnc`，一份 `cc -O0 -std=c99` 的孪生程序，逐字节相同
（五条腿也各自与它相同）。与那份 C 的两处写法差别与 `07-hex.jnc` 那两处同：`signed char`
与 `%llu`。

**跑过的轴**：`tests/jnc`（48/0，新增 `cases/31-printf-u`、`bad/printf-conv-p`、
`bad/printf-alt-u`，删掉落地了的 `bad/printf-conv-u`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy` —— 这一刀只动了 `frontend-jnc/lower.js`
（加 `tests/jnc/run.js` 的头注释），方言一个字没改；自举、`tests/jit`、`tests/mir`、
`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第三十三刀：无符号 —— 边界划在 64 位，理由是"规范形"

第六刀把 `unsigned` 从"静默忽略"改成"当场拒"，名单上记的是"要接它得先有无符号那一半：`/` `%`
`>>` `<` 都换成无符号那一版"。这一刀量下来，那句话只对 **64 位**那一格成立。

**为什么 8 / 16 / 32 位不欠方言任何东西**：这一层每个整数值都以**规范形**存着 —— 声明的那格宽度
里那个真实的数。`unsigned char c = 200` 存的就是 200，`unsigned int u = 4294967295` 存的就是
4294967295。这些数全都装得进方言的有符号 64 位，而且**都是非负的**，于是有符号的除、取模、右移、
比较给出的答案与无符号版逐位相同。真正要改的只是**回卷**：有符号是
`(x & M) ^ S - S`（摊符号位），无符号是 `x & M`（不摊）。

u64 装不进去：`4000000000 * 4` 那种数在方言里只能以负数的样子存着，于是 `/` `%` `>>` `<` 全都
会给有符号的答案。所以边界收窄成 `bad/unsigned-long.jnc`，接它要方言先长出无符号算子。

**类型格子从"位宽"变成"位宽 × 符号性"**。`INTS` 那张表从 4 格变 8 格，`mkInt(w, u)` 取代
`mkInt(w)`，`sameTy` / `tyName` 都跟着看 `u`。两条规则照抄 jancy：

- **提升**：比 32 位窄的一律先提到 32 位（`jnc_ct_UnOp_Arithmetic.cpp:23`）。
- **两边取哪一格**：取 **TypeKind 大**的那个，再过一遍提升
  （`jnc_ct_UnOp_Arithmetic.h:38`）。jancy 的 TypeKind 顺序里同宽度是"有符号在前、无符号在后"，
  所以 `kindIdx = w*2 + (u?1:0)` 就是它 —— `int` 与 `unsigned int` 相遇取后者，这正是 C 那条
  「`-1 < 1u` 是假」的来处，我们照它给假。

**别名**。jancy 的 `uint_t` / `dword_t` / `byte_t` / `word_t` / `qword_t` / `uchar_t` /
`ushort_t` / `ulong_t` 与 `intN_t` / `uintN_t` 一族都在 `INT_ALIASES` 里落到同一批格子上。

**期望输出的出处**：`cases/32-unsigned.jnc`，一份 `cc -O0 -std=c99` 的孪生程序，18 行逐字节相同
（五条腿也各自与它相同）。写法上的差别记在这里：孪生那边 `bool` 要 `<stdbool.h>`，jancy 独有的
`byte_t` / `word_t` / `uint_t` / `dword_t` 要 `typedef`；还有一处 —— 孪生里 `4294967295u` 带
`u` 后缀，`.jnc` 那边不能带，因为**整数字面量后缀这一层还不认**（`numLit` 的四条正则只吃纯数字）。
两边都改成先声明 `unsigned int m = 4294967295;` 再比，语义相同、出处仍在。那条后缀是**新记下的
一条边界**，还没有本体。

> **第三十四刀更正**：量了 jancy 的词法机之后这条"边界"作废 —— jancy 的整数字面量规则里
> **根本没有后缀**（`jnc_ct_Lexer.rl:429-434` 六条，全是纯数字加前缀）。`4294967295u` 在 jancy
> 里会被拆成 `4294967295` 与标识符 `u` 两个 token。所以后缀不是"还没长出来"，是**不欠 jancy 的**，
> 从名单里划掉。同一次量出来的真问题在下一刀。

**跑过的轴**：`tests/jnc`（49/0，新增 `cases/32-unsigned` 与 `bad/unsigned-long`，删掉落地了的
`bad/unsigned`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy` —— 这一刀只动了 `frontend-jnc/lower.js`
（加 `tests/jnc/run.js` 的头注释），方言、MIR、四个后端与运行时一个字都没改；自举、`tests/jit`、
`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第三十四刀：字面量的进制 —— 这一刀不是长功能，是修一个**错答案**

上一刀写孪生程序时顺手量了 jancy 的词法机，撞出一件比后缀严重得多的事：**打头那个 `0` 我们一直
在忽略**。`0755` 我们读成十进制 755，jancy 读它是 493。

`jnc_ct_Parser/jnc_ct_Lexer.rl:429-434` 六条规则连基数一起写着，`createIntegerToken(radix,
left)` 的 `left` 是"从第几个字符开始读"：

- `'0' oct+` → 基数 8、`left` 是 0，也就是**整串**按八进制读
- `dec+` → 基数 10
- `'0' [xX] hex+` / `'0' [oO] oct+` / `'0' [bB] bin+` → 16 / 8 / 2，`left` 是 2
- `'0' [nNdD] dec+` → 基数 10，`left` 是 2（显式写成十进制的那一格）

我们只有后四条里的三条。前两条撞在一起时**是错的**，而且是**静默**的错。

**语料里真这么写**：`test/ioninja/plugins/SerialMon/SerialMonProcessor_lnx.jnc:44` 的
`CBAUD = 0010017` —— Linux termios 那套八进制掩码，值是 4111，我们以前给 10017。这一条不是
造出来的极端例子。

**两处照 jancy、不照 C**。`08` 与 `0778` 在 C 里是错（八进制里没有 8 / 9）；在 jancy 里
`'0' oct+` 匹配不满整个 token，ragel 的扫描器取**更长**的那个匹配，于是落到 `dec+` 上 ——
`08` 是 10，`0778` 是 778。这两行没有 C 孪生可对，出处就是那条 ragel 语义本身。剩下几行 C 一致
（`0755` → 493、`010` → 8、`0010017` → 4111、`0644 | 0100` → 484 / `%o` 744），量过。

**`0n` / `0d` 那一格要动语法**：以前 `0n42` 连 token 都成不了（报 `unexpected ID 'n42'`）。
`jnc.grammar` 里加一条 `(token INTEGER "0" (or "n" "N" "d" "D") (+ digit))`，放在
`0d"…"` 那条 LITERAL 之后 —— 新规则要求前缀之后至少一位数字，所以 `0d"127.0.0.1"`
（JLinkRttSession.jnc:201）抢不走。

**顺手撞见但不在这一刀里**：`|=` 这一族位运算复合赋值前端还不收（`mask |= 0100` 当场报"复合赋值
'|='"），这条早就在名单上，本例改写成 `mask = mask | 0100`。

> **第三十五刀更正**：下一刀就把它接了。查下去发现它连"名单上的边界"都算不上 —— 语法那一半早就
> 齐了，缺的只是 `lower.js` 里一条白名单。`cases/33-radix.jnc` 里那行仍写作 `mask = mask | 0100`，
> 没改回去：这一格由 `cases/34-bitassign.jnc` 专门量。

**跑过的轴**：`tests/jnc`（50/0，新增 `cases/33-radix`）、`tests/glr`（20/0）、jancy 语料整份重扫
（这一刀动了 `jnc.grammar`，所以要重量一遍）：参考树里 662 份 `.jnc` 有 634 份唯一成树，与改之前
**同一批** 28 份不过 —— 拿 `git show HEAD:…/jnc.grammar` 把那 28 份逐个又跑了一遍，一份都没变，
所以这条新 token 没有回归。那 28 份是早就在名单上的两族：`thin` 当函数修饰符
（io_SocketAddress.jnc:121）与 `stdt_*` 那一整套模板。
**没跑的**：`tests/sexpr`、`tests/asy` —— 方言、MIR、四个后端与运行时一个字都没改；自举、
`tests/jit`、`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第三十五刀：`&= |= ^= <<= >>=` —— 语法早就有，只有降级那层没接

上一刀写例子时想写 `mask |= 0100`，当场被拒（「复合赋值 '|='」）。查下去发现语法那一半**早就
齐了**：`jnc.grammar:144-167` 五个 punct、`587-591` 五条产生式，转写自 `jnc_ct_Lexer.rl:369-373`。
缺的只是 `lower.js` 里那条白名单 —— 第一刀只放了 `+= -= *= /= %=`。

**语义就一条**：`lv op= v` 等于 `lv = (T)(lv op v)`，中间那一格照常用算术转换来。这条第三十三刀
已经写好了（那一刀为了 `i /= (unsigned)2` 把"中间那一次真的转"补上了），所以位运算那三个
（`&= |= ^=`）直接落在同一段代码上，一个字都不用加。

**移位要单独一格**：`<<=` / `>>=` 的中间那一格**只看左边**，右边不参与常用算术转换。这与二元
`<<` / `>>` 是同一条规矩（第三十三刀在二元那边已经写了），复合赋值这边得再写一次：

```js
const shift = bin === '<<' || bin === '>>';
const rt = shift ? arith(lv.type) : common(lv.type, v.type);
const y = shift ? intConv(v, arith(v.type)) : intConv(v, rt);
```

不这么写就会错：`int j = -8; unsigned one = 1; j >>= one;` 应当是 -4；要是让右边那个无符号把
结果那一格拖成 u32，`-8` 会先变成 4294967288，答案成 536870911。

**顺手补一条类型诊断**：位运算与移位只在整数上有定义，所以 `double x; x &= 1;` 现在拒在**类型**
上（以前拒在"还没接"上）。`bad/bitassign-real.jnc` 是它的本体，属于"jancy 自己也拒"那一类。
指针上那条早就在（「指针上的 '&='」）。

**期望输出的出处**：`cases/34-bitassign.jnc`，一份 `cc -O0 -std=c99` 的孪生程序，17 行逐字节相同
（五条腿也各自与它相同）。写法差别与前几刀同：`signed char`、`%lld`。

孪生里**去掉过一行**：本来写了 `signed char h = 1; h <<= 10;`。clang 会警告
`shift count >= width of type`，而那一行的答案要靠"超范围的有符号转换"（C 里那是
implementation-defined），没有可引的答案。换成 `signed char h = -128; h >>= 3;` —— 中间那一格
提到 32 位有符号，所以是算术移位，-16，完全有定义。

**跑过的轴**：`tests/jnc`（52/0，新增 `cases/34-bitassign` 与 `bad/bitassign-real`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy` —— 这一刀只动了 `frontend-jnc/lower.js`
（加 `tests/jnc/run.js` 的头注释），语法、方言、MIR、四个后端与运行时一个字都没改；自举、
`tests/jit`、`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第三十六刀：`switch` —— 方言里没有它，所以摊成"派发下标 + 一串 `<=` 守卫"

第三十五刀那个"语法早就齐了、只有降级没接"的发现值钱，所以这一刀开头先**成批探**了一遍：
`switch`、`enum`、`typedef`、`const`、`bool` 当 `int` 用、`for` 里的逗号串。结果是
`const` 与逗号串本来就通，另外四条各是一格。`switch` 最值钱，先做它。

**摊法**（形状写在 `switchStmt` 的头注里）：

```
(let $sv0 int COND)
(let $sk0 int (int 缺省组))       ;; 谁都不中时指向"组的个数"
(if (bin "==" (var $sv0) (int k)) (do (set $sk0 (int 组号))))   ;; 每个 case 一条
(while (bool true)
  (do
    (if (bin "<=" (var $sk0) (int 0)) (do 第0组))
    (if (bin "<=" (var $sk0) (int 1)) (do 第1组))
    …
    (brk)))
```

三件事同时靠这个形状成立：

- **贯穿**。case 的值互不相同，所以派发那几条 `if` 顺序无关；守卫是 `<=`，从第 j 组进去就会
  接着跑 j+1、j+2 ……，直到撞上 `break`。这正是 C 与 jancy 的贯穿（cflow_switch.rst:29 明写
  "no problem even when we fall-through from previous case label"）。
- **`break` 跳出整个 switch**。那圈 `while` 的体末尾就是 `(brk)`，所以只跑一遍；里面的
  `(brk)` 自然落到 switch 之外。case 里套的循环有它自己的一层，`break` 归那个循环 ——
  `g=` 那一组量的就是这一点。
- **每组一层作用域**。jancy 给每个 case 块隐式开一层（cflow_switch.rst:15），所以
  `case 1: int i = 10;` 与 `case 2: int i = 20;` 不冲突；这里每组包一个 `(do …)`。

**`default` 的位置不影响语义**：它只是"谁都不中时 `$sk0` 指哪儿"。所以夹在中间也对，
`c=` 那一组把它放在 `case 1` 与 `case 3` 之间量了。

**case 的标签要在语法树上算**，不能看降出来的文本。`case -1:` 的树是 `(unary "-" 1)`，降完是
`(bin "-" (bin "^" (bin "&" (un "-" (int 1)) …)))`（一元减带着回卷），照文本认不出来。所以
新写了个 `constInt`：只认整数字面量与它前面的一元 `+` / `-`（`constant_integer_expr`，
Stmt.llk:181）。常量折叠（`case 1 + 2:`）与命名常量（`case Request.Terminate:`）要更大的一格。

**这一刀留下的边界，两条都写清了理由**：

- **switch 里的 `continue`**。那圈 `while` 是合成的，`cont` 会跳到它头上 —— 死循环。当场拒
  （`bad/switch-continue.jnc`）。要接它得给方言加**带层号**的 `cont`；jancy 自己就有
  `break2` / `continue2`（cflow_switch.rst:37 演示的正是 `break2` 从 switch 里穿到外层循环），
  所以那一格本来就欠着，下一刀该做它。
- **标签的值超出条件那一格**。C 会先把标签转成条件的类型（`signed char` 上的 `case 255`
  变成 -1），这一层在提升之后那一格里比、不做那次转换。孪生里原本就写了 `case 255`，clang 报
  "overflow converting case value to switch condition type"，两边都换成了 `case 5` 绕开。

**顺手撞见的一处旧债**（不在这一刀里修）：方言允许 `(if C (set …))` 这种**不带 `(do …)`** 的
单语句分支，而 `backend-js/emit.js:313` 直接取 `s.then.stmts` —— 于是它当场 `stmts is not
iterable`。派发那几条本来就是这个形状，改成 `(if C (do (set …)))` 就过了。真正该修的是那两处
之一（要么方言拒单语句分支，要么后端认它），记在这儿。

**期望输出的出处**：`cases/35-switch.jnc`，一份 `cc -O0 -std=c99` 的孪生程序，18 行逐字节相同
（五条腿也各自与它相同）。

**跑过的轴**：`tests/jnc`（54/0，新增 `cases/35-switch` 与 `bad/switch-continue`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy` —— 这一刀只动了 `frontend-jnc/lower.js`
（加 `tests/jnc/run.js` 的头注释），语法、方言、MIR、四个后端与运行时一个字都没改；自举、
`tests/jit`、`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第三十七刀：bool 参与整数运算 —— 这一刀也是修错，不是长功能

上一刀开头那次成批探留下四条，这是最便宜的一条，而且**以前的答案是错的**：`int b = a > 0;`
当场报「初值的类型是 bool，声明的是 int」，可 jancy 那边这一行合法。

两条出处都在 jancy 源里：

- **bool -> 整数是隐式的**。1 位那一格走零扩展（`m_ext_u`，`jnc_ct_CastOp_Int.cpp:354`），
  而扩展这一族的 `getCastKind` 返回的就是 `CastKind_Implicit`（`jnc_ct_CastOp_Int.h:63`）。
- **bool 参与算术时提到 32 位有符号**。`jnc_ct_UnOp_Arithmetic.cpp:23` 那张表的头两行是
  `TypeKind_Bool1 -> TypeKind_Int32`、`TypeKind_Bool8 -> TypeKind_Int32`。这张表第三十三刀
  已经抄过一遍，当时只看了整数那几行，头两行漏掉了。

**接的位置只有两处**。一处是 `expr(n, want)` —— 所有"要一个具体类型"的取值都从那儿过（初值、
赋值、实参、返回值四个地方一次接完），旁边就是既有的 `int -> real` 隐式加宽，同一个形状。
另一处是二元运算里 bool 与整数相遇的那一格。两个 bool 比相等是例外，不绕道整数：方言的 bool
比较本来就精确。

**反过来那一次早就有了**：整数 -> bool 在 jancy 里也是隐式的（真值化），这一层走 `truthy`
（`if (n)` 那条路，第五刀）。`double d = a > 0;` 没量过，还是拒的。

**期望输出的出处**：`cases/36-bool-int.jnc`，一份 `cc -O0 -std=c99` 的孪生程序，11 行逐字节相同
（五条腿也各自与它相同）。写法差别：`bool` 要 `<stdbool.h>`、`signed char`、`%lld`。

**上一刀那次探剩下的两条**（都还没有本体）：`enum`（报"带体的命名类型（只收 struct）"）与
`typedef`（报"顶层的 'typedef'"）。`enum` 值钱得多 —— 语料里到处是它，而且它与
`case Request.Terminate:` 要的是同一格编译期求值。

**跑过的轴**：`tests/jnc`（55/0，新增 `cases/36-bool-int`）。这一刀动的是 `expr` 这个热路径，
所以那 55 条全绿本身就是没回归的证据。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy` —— 只动了 `frontend-jnc/lower.js`
（加 `tests/jnc/run.js` 的头注释），语法、方言、MIR、四个后端与运行时一个字都没改；自举、
`tests/jit`、`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第三十八刀：`typedef` —— 它在 jancy 里是个**存储类**，不是独立的语法

`DeclarationSpecifier.llk:83` 那条动作只有一句：`$.m_storageKind = StorageKind_Typedef`。
知道这一点之后这一刀就小了 —— `typedef` 后面跟的是**普通的声明符串**，所以
`typedef int* pint, box[3];` 一次起两个名字，指针与数组那几层照常由声明符带，不用另写一套。
实现就是拿现成的 `specs` + `declarator` 走一遍，把 `名字 -> 解出来的那一格` 存进一张表，
再在 `specs` 解类型名的地方多查一次。

**别名不是新类型**。表里存的就是解出来的那一格，所以 `myint` 与 `int` 同型，`sameTy` 看到的
两边一模一样 —— `g=` 那行把两者混着算，一次转换都没有。

**那一遍排在哪儿要紧**：放在"结构体的名字坐下"（第十七刀那一遍）之后、"结构体的体解出来"
之前。于是两个方向都通 —— 别名能引结构体的名字（`typedef Node* pnode`），结构体的字段也能
用别名（`myint v`）。

**边界**：函数类型的 typedef（`typedef int F(int);`）当场拒，`bad/typedef-fn.jnc`。语法那一半
能过（声明符可以带函数后缀），拒在降级这一层 —— 要接它得先有函数指针那一格。

**期望输出的出处**：`cases/37-typedef.jnc`，一份 `cc -O0 -std=c99` 的孪生程序，7 行逐字节相同
（五条腿也各自与它相同）。写法差别：C 那边结构体要写 `struct Node`；`byte8` 那条 typedef 在
孪生里是 `signed char`。

**上一刀那次成批探到此清完三条，只剩 `enum`**。它值钱得多也大得多：命名空间、`bitflag`、
基类型，还要与 `case Request.Terminate:` 共用一格编译期求值。

> **下一刀的量已经做完了**（`type_enum.rst` 全文 + `jnc_ct_CastOp_Int.cpp:295-311`），记在这儿
> 免得重查：
>
> - **成员是带命名空间的**：`Color.Red`，不往父命名空间里漏（type_enum.rst:17）。
> - **可以指定基类型**：`enum IcmpType: uint8_t { … }`（同上，21 行那个例子）。
> - **自动取值** 0、1、2……；写了显式值之后从那儿接着数。
> - **`enum -> 整数` 是隐式的**：`getArithmeticOperatorResultType` 见到 `TypeKind_Enum` 会递归到
>   基类型（`jnc_ct_UnOp_Arithmetic.cpp:39`）。
> - **`整数 -> enum` 要显式**：`state = 100;` 在文档里就标着 "error: cast int->enum must be
>   explicit"（type_enum.rst:60）。`Cast_Enum::getCastKind` 只在"源是本枚举的基枚举"或
>   "bitflag 且值是 0"这两种情况下给 `CastKind_Implicit`，别的都是 `CastKind_Explicit`
>   （`jnc_ct_CastOp_Int.cpp:306-310`）。
> - **`bitflag enum` 是另一格**：自动取值是 1、2、4、8……；两个同型 bitflag 的 `|` 还是那个
>   枚举；bitflag 与整数的 `&` 还是那个枚举；`0` 可以直接赋给它（type_enum.rst:66-73）。
> - **`pragma(ExposedEnums, true)`** 把成员漏进父命名空间，是为了移植 C 代码（type_enum.rst:43）。
>
> 按这个量，规矩的 enum 先做，`bitflag` 与 `pragma(ExposedEnums)` 各划一条边界。

**跑过的轴**：`tests/jnc`（57/0，新增 `cases/37-typedef` 与 `bad/typedef-fn`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy` —— 只动了 `frontend-jnc/lower.js`
（加 `tests/jnc/run.js` 的头注释），语法、方言、MIR、四个后端与运行时一个字都没改；自举、
`tests/jit`、`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第三十九刀：`enum` —— 一个字的标量，外加一张编译期的成员表

上一刀量出来的那七条里，规矩的那部分这一刀落地。顶层写 `enum` 以前当场报「带体的命名类型
（只收 struct）」。

**它在方言里是什么**：什么都不是——`tyText` 对枚举返回 `'int'`。枚举值在运行期就是个 32 位
（或按基类型）的整数，一个字。名字与成员表只活在前端的类型里：`{ k:'enum', name, base }`。
所以四个后端、MIR、方言一个字都没改。

**三处不一样，都在前端**：

- **成员是编译期常量**。`this.enums: name -> { base, members: Map(name -> BigInt) }`。
  `Color.Green` 走 `enumMember`，直接吐 `(int 5)` —— 不是一次读内存。取值 0、1、2……，
  见到显式值就从那儿接着数，每一步按基类型回卷（`wrapVal`：`Small: uint8_t` 里
  `C = 250` 之后 `D` 是 251，再往下就会绕回 0）。
- **`enum -> 整数`隐式，反向拒**。隐式那一半塞在 `expr(n, want)` 那个唯一的收口处：
  `want` 是整数而值是枚举时，按 `v.type.base` 走一次 `intConv`。反向不给：
  `Color c = 5;` 报「初值的类型是 int，声明的是 Color」——这是 jancy 自己也拒的一格
  （type_enum.rst:60 的原话 "cast int->enum must be explicit"）。
- **同型枚举的比较不掉基类型**，别的二元运算两边都掉到 `.base`。`sameTy` 对枚举比的是
  `a.name === b.name`，所以 `Color` 与 `Small` 不通用。

**顺带长的一格**：`Color arr[3]` 一开始被 `declarator` 的元素类型白名单拒了。加 `isEnum(t)`
放行，理由是它的 `tyText` 就是 `int` —— 一个字的标量元素，与 `int[3]` 同一格，不碰"多个字的
元素"那条真边界（那条还留着，`&p` 与它同格）。

**为什么 `constInt` 要认 `(field …)`**：`case Color.Green:` 的标号得在编译期折出 5 来。
第三十六刀那个从 AST 折常量的 `constInt` 因此多认一条 `field` 分支，调 `enumMember` 拿值。
（第三十六刀已经说过为什么不能从降级后的文本里 pattern-match：一元负号被 `wrapTo` 包着。）

**两条边界**：`bitflag enum`（取值 1/2/4/8、`|` 与 `&` 的结果类型另有规矩、`0` 可隐式赋值——
得连着一起接，`bad/enum-bitflag`）与 `pragma(ExposedEnums, true)`（把成员漏进父命名空间）。

> 第四十七刀把 `bitflag enum` 做掉了，`bad/enum-bitflag` 按规矩删掉、换成三条更窄的。
> 上面那句「它是另一格」**判重了**：落地之后 `enums` 那张表只多了一个 `bits` 布尔位 ——
> 是同一格上的一个开关。另外这一刀还留下两处漏，都是"枚举当整数用"漏的：枚举不能当条件用
> （jancy 那边 `case TypeKind_Enum` 走 `m_fromZeroCmp`），一元算子没落到基整数上
> （`~Color.Red` 报错）。二元那一侧这一刀做对了，一元与真值化那两处忘了 —— 第四十七刀补齐。

> 还有一处：`bad/enum-from-int` 记的边界该读成「**隐式**的 int 到枚举」。jancy 的
> `Cast_Enum::getCastKind` 里"隐式"与"显式"是同一个 return 的两条分支
> （`jnc_ct_CastOp_Int.cpp:295-311`），这一刀只抄了隐式那一条，于是 `(Color)2` 这种**写了
> cast 的**也一起拒了 —— 那是抄漏，不是边界。第五十刀补上，`bad/enum-from-int` 本身照旧
> 有效（它拒的就是没写 cast 那一种）。

**期望输出的出处**：一份 `cc -O0 -std=c99` 的孪生，10 行逐字节相同。三处写法差别记在
`cases/38-enum.jnc` 的头注释里：C 那边成员名是裸的、类型要写 `enum Color`、`Small` 的基类型
写不出来（这几个值在 `int` 里印出来一样，不影响对比）。

**跑过的轴**：`tests/jnc`（60/0，新增 `cases/38-enum`、`bad/enum-from-int`、`bad/enum-bitflag`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy` —— 只动了 `frontend-jnc/lower.js`
（加 `tests/jnc/run.js` 的头注释），语法、方言、MIR、四个后端与运行时一个字都没改；自举、
`tests/jit`、`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第四十刀：多层 `(brk N)` / `(cont N)` —— 这一刀长的是**方言**，不是 jancy 前端

这是"jancy 不向方言妥协"这条纪律第一次逼着方言在**控制流**上长东西。jancy 有 `break2` /
`continue2`（`'break' [1-9]`，jnc_ct_Lexer.rl:317-320，`break1` 就是 `break`；文档见
cflow_break.rst 与 samples/jnc/83_BreakN.jnc），而方言只有单层的 `(brk)` / `(cont)` ——
第三十六刀因此欠了一条边界（`bad/switch-continue`：switch 里的 `continue` 要跳过我合成的
那圈一次性循环，正是"往外数第二层"）。

**为什么改动比想象的小**：MIR 那一层**本来就是按层号跳的** —— `OP.BR` 的第三个操作数就是
"往外数几层区域"，`levelOf('break')` 只是一直在找最近的那一层。所以 MIR、两个 SSA 后端
（LLVM / SPIR-V）与 MIR 解释器一个字都没改，只把 `levelOf` 加了个"第几个同名标签"的参数。

**改的是四处**：

- `sexpr/lower.js`：`(brk N)` / `(cont N)`，N 是 1..9 的一位数字，`N` 省掉就是 1。层数不够
  当场拒，与"一层都没有"分成两句话（`bad/brk-outside` 与新的 `bad/brkn-too-deep`）。
- `hir/check.js`：`Break` / `Continue` 带上 `level`，别的前端造的节点没有这个字段，所以到处
  都补默认 1。
- `interp/eval.js`：信号值编成 `base + 4 * (N-1)`。循环见到 `sig >= 4` 就知道"这不是给我的"，
  减掉一层往外抛；`for` 在往外抛时**不走步进**。刻意不用异常做控制流（ADR-0007 那条规矩）。
- 两个结构化后端要**标签**。JS 是 `break L` / `continue L`；C 里没有带标签的 break，只能
  `goto`，而且要**两个**标签：`break` 的落点在循环之后，`continue` 的落点在循环体**末尾**
  （落到那儿再自然往下走，`for` 的步进与 for-in 的 `i++` 就还会跑 —— 这三种循环的步进都在
  头部，所以这一条对三种都成立）。

哪一层要标签，由 `hir/types.js` 里新的 `loopLabelNeeds` 一份判断答，两条腿共用：**判错了会
静默地跳错地方**，各写一份迟早分叉。判据是"body 里存在一条 Break/Continue，它所在的嵌套
循环层数 d > 0 且 level === d + 1"。用不上的标签不发，免得 C 那边 `-Wunused-label`。

**验的方式**：`tests/sexpr/cases/35-brkn.sx` 三个函数各钉一格（`(brk 2)`、`(cont 2)`、三层里
`(brk 3)` 与单层 `(brk)` 混写），答案 24 / 6 / 8 手算得出，五条腿逐字节相同。`(cont 2)` 那格
的证据是外层 body 里那句 `+100` 每轮都被跳过 —— 要是它只跳了内层，答案里就会有 100 的倍数。
生成的 C 里确认只有被指着的那一层带标签（`omni_brk0` / `omni_cont2` / `omni_brk4`）。

**下一刀欠的**：jancy 前端还没把 `breakN` / `continueN` 接到这一格上，`bad/switch-continue`
那条边界也还留着 —— 那是第四十一刀的事。

**跑过的轴**：`tests/sexpr`（75/0，新增 `cases/35-brkn` 与 `bad/brkn-too-deep`）、`tests/jnc`
（60/0）、`tests/oir`（451/0）、`tests/asy`（259/0）。
**没跑的**：`tests/glr`（语法一个字没改）、自举、`tests/jit`、`tests/llvm`；`npm run lint`
这台机器上没有 typescript。`tests/mir` 这台机器上本来就红 —— 自举的重名检查撞在
`frontend-jnc/lower.js` 的 `zeroOf` 与 `interp/builtin.js` 的 `zeroOf` 上，那是第一刀
（8cc16be）就欠下的债，与这一刀无关，记在这里免得下次重查。

> **第四十三刀把重名这一格清了**：`frontend-jnc/lower.js` 里的 `zeroOf` 改名 `zeroText`、
> 九个 `T_*` 改名 `J_*`。`tests/mir` 还是红的，但撞的换成了下一格债 —— `fmtFixed` /
> `fmtSci` / `fmtGen` 不在 `frontend-js/link.js` 的 `NATIVE_OPS` 里。

### 第四十一刀：`break2` / `continue2` 接上层号，顺手抓出一处**词法**上的静默错

上一刀方言长出了层号，这一刀把 jancy 那一头接上去，并且删掉第三十六刀欠的
`bad/switch-continue`。

**语法那一半早就写好了** —— `jnc.grammar:480-485` 把 `break2;` 摊成 `(break 2)`。但它一直
没被走到：那一行 `(keyword ID INTEGER "break2" "break3" "continue2" "continue3" "basetype2")`
里的 `INTEGER` 不是"这几个词是整数后缀"的意思，而是**把这个 ID 改判成 INTEGER token**
（`glr/lex.js:222-226`：第三项若又是个名字，它就是改判目标）。于是 `break2;` 被当成一条
**表达式语句**，`(expr-stmt break2)`。这是一处静默错：语料照旧成树（526/528 没变），
golden 文件里还把错的形状记成了期望值（`tests/glr/cases/jnc.cases` 三行）。改成
`(keyword ID "break2" …)`，三行 golden 一起改回正确形状，`table/jnc` 快照不变（这几个词
本来就是终结符，动的只是词法改判），受影响的 12 份语料文件逐个重解都还成树。

**层号怎么对上**：前端记一个循环栈 `this.loops`，每层一格 `{ sw, step }` —— 真循环
`sw: false`，switch 摊出来的那圈合成循环 `sw: true`。两条规矩，都是量出来的：

- **`break N` 数全部**。jancy 把 switch 也算一层（cflow_switch.rst:37：`break2` 是"出
  switch 再出循环"），而合成的那圈在方言里正好也是一层 —— 一一对应，层号直接搬。
- **`continue N` 只数真循环**（与 C 同）。所以 switch 里的 `continue` 落到方言里是
  `(cont 2)`：跳过合成的那圈，回到外面那个真循环。这正是第三十六刀拒掉的那一格。

这一格顺手把 `swGuard`（布尔）与 `forStep`（能兼作标志的步进串）两个字段并成了一个栈 ——
它们记的本来就是"最近那一层是什么"，而层号一进来，"最近"就不够用了。

**剩下的那条边界重画得更窄**：`bad/switch-continue` 删掉，换成 `bad/for-continue` ——
带步进的 `for` 里的 `continue` 还是拒，因为方言里没有 `for`，步进被摊到了体的末尾，而 `cont`
跳的是循环头。落地要给 for 的体套一圈**一次性**循环（`(while (bool true) (do <体> (brk)))`），
让 `continue` 变成那圈的 `(brk)` —— 落点正好在步进之前。多层 `(brk N)` 已经有了，所以现在
只差"什么时候套"这一个判断。（注意这条边界现在也拦着 `continue2` 指向一个带步进的外层 for。）

**期望输出的出处**：一份 `cc -O0 -std=c99` 的孪生，四行逐字节相同（24 / 6 / 204 / 8）。
唯一的写法差别是 C 没有 `break2`，多层跳只能写 `goto` —— jancy 的文档正是拿"不必写 goto"
当卖点的（samples/jnc/83_BreakN.jnc 开头那段）。

**跑过的轴**：`tests/jnc`（61/0，新增 `cases/39-breakn` 与 `bad/for-continue`，删掉
`bad/switch-continue`）、`tests/glr`（20/0，三行 golden 改回正确形状）、语料里带
`break2`/`break3`/`continue2`/`continue3`/`basetype2` 的 12 份文件逐个重解（12/12 成树）。
**没跑的**：`tests/sexpr`、`tests/asy`（方言、MIR、四个后端与运行时一个字都没改 —— 只动了
`frontend-jnc/` 的降级与语法，加两处测试头注释）；自举、`tests/jit`、`tests/mir`、
`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第四十二刀：带步进的 `for` 里的 `continue` —— 给体套一圈**一次性**循环

这是三刀连着的最后一格。方言里没有 `for`：这一层把它摊成 `while`，步进搬到体的末尾，而 `cont`
跳的是循环头 —— 所以 `for (int i = 0; i < 5; i++) { if (…) continue; … }`（真实 jancy 代码里
最常见的那一格）一直是当场拒的。

**落地的形状**：

```
(while COND
  (do
    (while (bool true) (do BODY (brk)))    ;; 一次性：体走完就跳出去
    STEP))
```

`continue` 变成那圈一次性循环的 `(brk)`，落点正好在 `STEP` 之前 —— 与 C 的 `for` 逐格一致。
这一格之所以现在才做得成，是因为多层 `(brk N)`（第四十刀）：`break` 在体里得跳出**两层**
（一次性那圈 + 真循环那圈），没有层号就写不出来。

**只在需要时套**：`steps.length > 0 && contTargets(body, 0)`。白套一圈会让别处的层号无谓变长。
`contTargets` 在 **AST** 上走，数的规矩与 `continue N` 一致（只数真循环，switch 不算）：体里
存在一条 `continue N`、它所在的嵌套真循环层数 d 满足 `N === d + 1`，就是指着我。必须在 AST 上
走 —— 降级后的文本里 `(brk)` 与 `(cont)` 已经分不出是谁的了。

**层号怎么数**：循环栈的每一格现在带 `kind`：`loop`（真循环）、`switch`（switch 摊出来的合成
循环）、`oneshot`（for 体外套的那圈）。

- `break N` 数 `loop` 与 `switch`，**不数** `oneshot`；找到目标那一格之后，方言层号是"到栈顶
  的距离"，一次性那几圈自然被数进去。所以带步进的 for 里一句 `break` 是 `(brk 2)`。
- `continue N` 只数 `loop`。找到目标之后看它上面一格是不是 `oneshot`：是就跳那圈的 `brk`
  （层号少一），不是就 `cont` 到它头上。

嵌起来也对：两层带步进的 for，里层写 `continue2`，栈是
`[loop, oneshot, loop, oneshot]`，目标是最外那个 `loop`，它上面那格 `oneshot` 距栈顶 3 ——
`(brk 3)`，落点正好在外层的 `STEP` 之前。

**边界删了，没有再画**：`bad/for-continue` 删掉。原来那条 `nope` 变成了一句"内部错"——
走到那儿说明 `forStmt` 该套却没套，那是编译器自己的 bug，不许静默跳错地方。

**期望输出的出处**：一份 `cc -O0 -std=c99` 的孪生，七行逐字节相同（8 / 50 / 6 / 46 / 8 / 433 /
12）。七格分别钉：最常见那一格、步进是一串（`i++, k += 2`，`continue` 之后两条都要跑）、内层
while 里 `continue2` 指着外层 for、两层带步进的 for 里 `continue2` 与 `continue` 混写、`break`
还是出**整个** for、switch 在带步进的 for 里、没有步进的 for 走老路。唯一的写法差别：C 没有
`continue2`，那两格只能写 `goto`。

**跑过的轴**：`tests/jnc`（61/0，新增 `cases/40-forcont`，删掉 `bad/for-continue`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy` —— 只动了 `frontend-jnc/lower.js`
（加 `tests/jnc/run.js` 的头注释），语法、方言、MIR、四个后端与运行时一个字都没改；自举、
`tests/jit`、`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第四十三刀：自举的重名 —— `frontend-jnc` 让位，顺手把下一格债量清

这一刀不长功能，只把 `tests/mir` 整条轴上那道拦路的重名清掉。自举那一遍要求**模块级的名字
全局唯一**（同一个名字在两个模块里都定义就报错），而 jancy 前端第一刀（8cc16be）带进来五个
撞名：`zeroOf`（与 `interp/builtin.js` 的同名函数）与 `T_VOID` / `T_I64` / `T_BOOL` / `T_STR`
（与 `mir/ir.js` 的 MIR 类型标签）。

改名的一边选 `frontend-jnc/lower.js`，因为它的这几个名字**全是文件内私有的** —— 整个仓库只有
`cli.js` 从这个模块 import 一个 `lowerJnc`。`zeroOf` 改成 `zeroText`（它回的是方言**文本**，
而 `builtin.js` 那个造的是运行期的值 —— 名字撞在一起本来就说明两者容易被看混）；九个 `T_*`
一起改成 `J_*`（只改四个撞名的会让 `T_I32` 与 `J_BOOL` 并排，那更难读）。

**`tests/mir` 还是红的**，但撞的换成了下一格：`fmtFixed` / `fmtSci` / `fmtGen` 不在
`frontend-js/link.js` 的 `NATIVE_OPS` 里（那张表把 `host/native.js` 的每个导出对应到一条
`js_*` 运行时 op）。那是第二十九到第三十一刀（`sfix` / `ssci` / `sgen`）欠下的：解释器直接
从宿主 import 了这三个，而自举要求它们在四条腿上都有一份实现与一个 op 名。这不是改名能解决的，
要单独一刀，记在这儿免得下次从头查。

**跑过的轴**：`tests/jnc`（61/0 —— 改名只动了这一个前端）、`tests/mir`（还是红，但错的那一句
换了，见上）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy`（一个字都没碰到它们的路径）、自举、
`tests/jit`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第四十四刀：printf 的长度修饰 —— 让格式串能盖掉"位数从类型上取"

`printf("%lld", x)` 以前当场报「printf 的转换 '%l'」：解析走到 `l` 就不认了。

**量出来的口径**：语料里真用的只有 `ll` 那一档（`%lld` 15 处、`%llx` 3 处、`%llu` 1 处；
`%ld` / `%lu` / `%hd` / `%hhd` / `%zd` / `%zu` / `%jd` / `%Lf` **各 0 处**）。但 `hh` / `h` /
`l` / `ll` 是同一个机制的四档，一起收比只收一档更省事，所以四档全收。

**它在这一层是什么意思**：C 里长度修饰定的是"实参是哪一格整数"，而这一层没有 C 的变参提升
（方言里整数就一个 64 位的格），所以它定的是**这次转换按多少位读** —— `hh` = 8、`h` = 16、
`l` / `ll` = 64（jancy 的 `long` 就是 64 位，macOS 的 C 同）。不写修饰时位数从**实参的类型**
上取，那是第七刀定下的约定；这一刀只是让格式串能盖掉它。落地就是两处各多一行：`%d` / `%i`
那条的 `intConv` 目标宽度、`%x` / `%X` / `%o` / `%u` 那条的掩码宽度。

于是 `%hhd` 印 300 是 44、`%hu` 印 -1 是 65535、`%llx` 印 -1 是 `ffffffffffffffff` ——
与 C 逐字节相同（八行孪生量过）。`%lf` 收成"`l` 被忽略"，那也是 C 的规矩。

**边界**：`%zd` / `%jd` / `%td`（宽度是平台 typedef 定的 —— 收它得先决定 `size_t` 是什么）、
`%Lf`（long double）、`%llf`（C 里本身没定义）、`%lc` / `%ls`（宽字符那一族）。语料里这几个
一处都没有，所以这条边界不欠 jancy 什么。`bad/printf-len-z.jnc` 记着它。

> 写这一格时踩了一次：`z` 也走进了"整数转换 + 有修饰"那条判断，于是 `%zd` 静默印出了 42。
> 判据要**先看修饰本身在不在四档里**，再看它配的转换 —— 少了前一半就成了"什么修饰都收"。

**期望输出的出处**：一份 `cc -O0 -std=c99` 的孪生，八行逐字节相同。与它的写法差别两处：
jancy 的 `long` 就是 64 位（C 那边写 `long long`）；jancy 没有 `unsigned long`（还是边界），
所以 `%llu` / `%lu` 那两处在 jancy 里就是"拿有符号的 64 位当无符号印"，C 里要显式转一下才算
有定义。`h` / `hh` 不用转 —— C99 7.19.6.1 说带 `h` 的实参"按整数提升传进来，印之前转成
short / unsigned short"，所以 `printf("%hu", -1)` 本身就有定义。

**跑过的轴**：`tests/jnc`（63/0，新增 `cases/41-printf-len` 与 `bad/printf-len-z`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy` —— 只动了 `frontend-jnc/lower.js` 的 printf
那一段（加 `tests/jnc/run.js` 的头注释），语法、方言、MIR、四个后端与运行时一个字都没改；
自举、`tests/jit`、`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第四十五刀：`countof` 落地，`sizeof` 明说不收 —— 一族里的两个，卡点不在同一处

这一刀的选题是**量出来的**，不是猜的：把 662 份语料逐份过一遍 `sx`，把每一句「还不收：…」
按出现次数排了个序。表达式那一族里最前面两个就是
`sizeof`（30 处）与 `countof`（23 处），后面才是 `dynamic-cast`（7）、`dynamic-sizeof`（6）。
两个的语法早就在（`jnc.grammar:646-647`），拒它们的只有降级那一层 —— 又是"批量探针"那个形状。

**它们在 jancy 里是一件事**：`sizeofOperator` / `countofOperator` 都只用操作数问**类型**
（`prepareOperandType(..., OpFlag_LoadArrayRef)`），然后 `setConstSizeT(...)` ——
一个编译期的 size_t 常量，操作数**不求值**（`jnc_ct_OperatorMgr.cpp:931-987`）。
所以这一层也不该发出操作数的代码：`countofExpr` 只走 lvalue 那几种形状（名字/下标/字段/
`*p`），别的形状（`countof(f())`）当场说不收，而不是求一遍值再把它丢掉。
`countof(a[0])` 正好落在 lvalue 的 index 支上 —— 多维数组在那儿退一维，元素个数就是里层那个。

**可两个的卡点不在同一处**，所以这一刀只落地一个：

- `countof` 给的是**元素个数**，与一格占几个字节无关，所以它是纯的：数组类型里那个 `n`
  照抄成 `(int N)`，类型按 size_t（这个前端把 `size_t` 当 64 位）。
- `sizeof` 给的是**字节数**，而字节数两边对不上：jancy 的表是 int8=1 / int16=2 / int32=4 /
  int64=8 / double=8（`setupPrimitiveType`，`jnc_ct_TypeMgr.cpp:1727-1736`，与 C 同），
  方言这边一格整数**一律 8 字节**（`hir/types.js:144` —— 决策二"一套语义、两套实现"要求
  尺寸由那一层定死）。于是 `sizeof(int)` 照 jancy 是 4、照真布局是 8。挑哪个都会错一处：
  `sizeof(buffer) - 1` 当的是"这块内存有多大"（`90_SslSocket.jnc:121`），必须与真布局一致；
  而 `printf("sizeof (d) = %d", sizeof(d))`（`60_HexLiterals.jnc:53`）要的是 jancy 印出来
  的那个数。两个同时对的前提是**方言的布局先认整数宽度** —— 那要动 `sizeOf`/`alignOf`、
  DataView 的读写宽度、C 那条腿的结构体、`psub`，五条腿一起，是独立的一刀。

这一格是「jancy 支持不可向方言妥协」的一个**新形状**：以前的冲突都在语法上，方言长一格就完了；
这一次冲突在**内存模型**上，长的那一格要动五条腿。所以这一刀的做法是明说不收、把理由与那两条
出处写在 `bad/sizeof.jnc` 里，而不是悄悄挑一个数糊过去 —— 后者会让 30 处语料**静默**地错。

**边界**：`sizeof`（同上）、`dynamic countof` / `dynamic sizeof`（jancy 那边是运行期调用
`StdFunc_DynamicCountOf`，读 fat 指针自己带的 validator 范围，`jnc_ct_OperatorMgr.cpp:968-977`；
方言的 fat 指针本来就带 `{addr, base, end}` 三个字，缺的只是"(end - base) / 元素步长"那一句 ——
元素步长要 `sizeof` 那一刀）、`countof` 作用在指针上（**jancy 自己也拒**，它的那一句就是
"'countof' operator is only applicable to arrays"）。三条各有一份 `bad/`。

> 落地之后回头量了一次"这一刀真放行了什么"：语料里**有 `main`** 的 207 份里，原先有 4 份
> 只剩 `countof` 这一个拦路的。做完之后 `samples/jnc/83_BreakN.jnc` 与
> `samples/jnc/84_CurlyInitializers.jnc` 整份降完并跑出来了 —— 前者印
> `negative item found at [1] [2]: -7`，对得上它自己那张 `int a[3][4]` 表里 `a[1][2] = -7`
> （83_BreakN.jnc:25-28）；它同时也是第四十一刀 `break2` 的那份样例，两刀凑齐才走通。
> 另两份换成了别的拦路：`10_DataPtrRange.jnc:34` 的 `p < end`（**指针上的 `<`**，下一格），
> `test110.jnc:5` 的 `0d"-1 -1 -1 -1"`（十进制的那种块字面量）。

**期望输出的出处**：一份 `cc -O0 -std=c99 -Wall` 的孪生，七行逐字节相同。**写法差异**一处：
jancy 写 `countof(x)`，C 里写 `sizeof(x)/sizeof(x[0])` —— 算的是同一件事；C 那边 `%d` 配
size_t 还要一次显式 `(int)`。

**跑过的轴**：`tests/jnc`（67/0，新增 `cases/42-countof` 与 `bad/countof-ptr`、`bad/sizeof`、
`bad/dynamic-countof`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy`、`tests/oir` —— 只在
`frontend-jnc/lower.js` 的表达式派发上加了两支（加 `tests/jnc/run.js` 的头注释），
语法一个字没改（`countof` 那条产生式本来就在）、方言、MIR、四个后端与运行时也没动；
自举、`tests/jit`、`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第四十六刀：指针比大小 —— 方言早就写好了正路，照它走

`for (; p < end; p++)` 以前报「还不收：指针上的 `<`」。这是上一刀量出来的下一格：
`countof` 落地之后 `samples/jnc/10_DataPtrRange.jnc` 就只剩这一个拦路的。

**jancy 那边的口径**：两个指针都当 `TypeKind_IntPtr` 比
（`getPtrCmpOperatorOperandType`，`jnc_ct_BinOp_Cmp.cpp:22-29`）—— 也就是**比裸地址**。
六个比较算子里 `==` / `!=` 第十六刀已经收了（`peq`），这一刀补剩下四个。

**可这一层不能照着"比裸地址"落**，理由与我们拒 `%p` 是同一条：块之间的次序在 arena 模拟与
真指针两套实现下不是同一个数。而方言那边早就把这件事想过一遍，注释里连正路都写好了：

> 刻意**不给** `<` `>`：块间的次序在两套实现下不一样，那种比较只在同一块内有意义，
> 而"是不是同一块"要用 `psub`（它会替你报错）。 —— `sexpr/lower.js:1761-1762`

所以这一刀**方言一个字没改**，降级就是一句：`p < q` -> `(bin "<" (psub p q) (int 0))`。

- **同一块内**：`psub` 是按元素的有符号差，符号就是次序 —— 五条腿上一致。
- **跨块**：`psub` 当场报「pointer difference across different blocks」。C 那边跨块比大小
  是**未定义行为**（C99 6.5.8p5：只有指向同一个数组对象的指针之间才有次序），jancy 那边
  答案取决于两块内存在地址空间里的先后 —— 我们把它换成一句五条腿上都一样的错。
  `rt/ptrcmp-cross.jnc` 记着它。

这一格值得单独记一句：**方言的"刻意不给"不是欠债，是把选择推到了该做选择的那一层**。
前端知道"这两个指针是同型的 `T*`"，所以它能把 `<` 翻成一句有定义的 `psub`；方言不知道，
所以它不该给一个在两套实现下答案不同的 `<`。第四十刀（层号）那一刀是反过来的：那件事
前端**做不了**，所以方言长了一格。两刀合起来才是「不可向方言妥协」的完整用法 ——
先问"这一格该长在哪一层"，再决定长不长。

**边界**：不同型的两个指针比大小（`bad/ptrcmp-mixed.jnc`）。**jancy 那边这条其实过得去** ——
它自己的 `// TODO: check that we don't compare pointers of different typekinds`
（`jnc_ct_BinOp_Cmp.cpp:26`）就记着这个检查没做。这一层拒它是降级形式带来的：`psub` 按
**元素**算差，两边元素不一样大时"差几个元素"没有意义。与 `==` 那两条同一条规矩（第十六刀
就要求同型）。

**期望输出的出处**：一份 `cc -O0 -std=c99 -Wall` 的孪生，十行逐字节相同。**写法差异**两处：
`countof(a)` 在 C 里写 `sizeof(a)/sizeof(a[0])`；C 的比较结果是 int、jancy 是 bool，`%d`
印出来同为 0/1。那份孪生上 `-Wall` 对 `q <= q` 那三个报 self-comparison —— 故意的，
量的就是自反那一格。

**放行了什么**：`samples/jnc/10_DataPtrRange.jnc` 整份跑通（三行 `*p =` 加三行 `a [i] =`，
对得上它自己那段注释说的"先按指针走一遍、再按下标走一遍"）。

**跑过的轴**：`tests/jnc`（70/0，新增 `cases/43-ptrcmp`、`rt/ptrcmp-cross`、
`bad/ptrcmp-mixed`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy`、`tests/oir` —— 只在
`frontend-jnc/lower.js` 的二元算子那一段加了一支（加 `tests/jnc/run.js` 的头注释），
语法、方言、MIR、四个后端与运行时一个字都没改；自举、`tests/jit`、`tests/mir`、
`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第四十七刀：`bitflag enum` —— 一个开关带出四条规矩，外加两处"枚举当整数用"的漏

第三十九刀收 `enum` 时把 `bitflag enum` 记成了边界，理由写的是「它是另一格」。量下来它不是
另一格，是**同一格上的一个开关** —— 落地之后 `enums` 那张表只多了一个 `bits` 布尔位。

**选题**照上一刀那份语料排序：语料里 `bitflag enum` 22 处，有 `main` 的 207 份里有 4 份
只剩它这一个拦路的 —— 在 `class`（12 份）之后是最前面的一档，而 `class` 是另一个数量级。

**四条规矩，出处都在 jancy 自己的实现里**：

1. **取值序列**：起始 1，之后 `value = value ? 2 << sl::getHiBitIdx64(value) : 1`
   （`calcBitflagEnumConstValues`，`jnc_ct_EnumType.cpp:286-306`）。这一句**不是乘二** ——
   是"最高位再往上一位"。所以 `Exclusive = 0x20` 之后 `DeleteOnClose` 是 `0x40`（文档那个
   例子的注释就这么写），而显式写 `0x30`（两个位）之后下一个**也是** `0x40`。照抄的话这条
   差别是免费的；自己想当然写 `*2` 就会在第二种情形上错。
2. **`&` 的结果类型**：**任一边**是 bitflag 枚举，结果就是那个枚举
   （`getBitFlagEnumBwAndResultType`，`jnc_ct_BinOp_Arithmetic.cpp:356-370`）。
3. **`|` / `^` 的结果类型**：**两边都**得是同型的 bitflag 枚举，否则回 NULL、落回整数那条路
   （同文件 372-388）。文档只提了 `|`，实现里 `^` 与它同一条。
4. **0 可以隐式赋进去**：`(flags & EnumTypeFlag_BitFlag) && opValue.isZero()` 时是
   `CastKind_Implicit`（`jnc_ct_CastOp_Int.cpp:306-311`）。注意它问的是 `opValue.isZero()`
   —— **编译期常量零**，所以 `flags = 0` 收、`flags = x` 不收（哪怕 x 这一趟正好是 0）。

**顺带补了两处漏**，都不只对 bitflag，是第三十九刀留下的：

- **枚举能当条件用**：`Cast_Bool::getCastOperator` 里 `case TypeKind_Enum` 走的就是
  `m_fromZeroCmp`（`jnc_ct_CastOp_Bool.cpp:181`）—— 与整数同一条"跟 0 比"。
  逼出它的是 `if (flags & OpenFlags.ReadOnly)`：`&` 的结果是枚举，直接落在条件位置上。
- **一元算子落到基整数上**：`getArithmeticOperatorResultType` 见到 TypeKind_Enum 就递归到
  基类型（`jnc_ct_UnOp_Arithmetic.cpp:39`）。二元那一侧第三十九刀已经这么做了，一元这一侧
  漏了 —— `~OpenFlags.Exclusive`（type_enum.rst:87）就落在这儿。

**外加一格是语料逼出来的**：`x.M` ——**从一格值上问成员**。`getEnumTypeMember` 查到成员之后
发一次二元运算：bitflag 发 `BinOpKind_BwAnd`、普通枚举发 `BinOpKind_Eq`
（`jnc_ct_OperatorMgr_Member.cpp:592-618`）。于是 `flags.ReadOnly` 是"这一位置上了吗"、
`st.Busy` 是"是不是它"。这一格不是我想出来的：做完前四条之后 `test55.jnc:22` 的
`if (flags.ReadOnly)` 报的是「'.' 的左边不是结构体」—— 一句**错的**诊断，因为那句代码合法。
这是那份语料排序的第二个用处：它不只挑选题，还在每刀之后告诉你漏了什么。

**边界**三条：`bitflag enum` 里的**负值**（jancy 那句 `2 << getHiBitIdx64(-1)` 在 C++ 里是
移位越界 —— 与 `%+x` 同一类：没有可对的答案）、非 0 的整数隐式赋进去（**jancy 自己也拒**，
文档里那句 `flags = 200; // error: cast int->bitflag enum must be explicit`）、
从一个**要先求值**的东西上问成员（`pick().A` —— jancy 收，这一层还不收：降级要把左边的 code
串用两次，先求值的形状得先落进一格临时量；语料里左边一直是个名字）。

**期望输出的出处**：一份 `cc -O0 -std=c99 -Wall` 的孪生，十五行逐字节相同。**写法差异**两处：
C 里没有 bitflag 枚举，那串自动取值要照上面第 1 条算出来写死；C 里也没有 `x.M`，要摊成
`x & M` / `x == M`。

**放行了什么**：`test/jnc/test26.jnc` 与 `test/jnc/test55.jnc` 整份跑通（后者印
`read-only is true`）。另两份换成了别的拦路：`test104.jnc:4` 的"枚举成员的值不是整数字面量"
（要编译期常量折叠那一格 —— 它同时也拦着"数组长度不是字面量"与"case 的标签不是字面量"，
下一格该是它），`test71.jnc:22` 的 `rand`（要 stdlib）。

**跑过的轴**：`tests/jnc`（73/0，新增 `cases/44-bitflag` 与 `bad/bitflag-neg`、
`bad/bitflag-from-int`、`bad/enum-val-member-call`；删掉 `bad/enum-bitflag` —— 功能落地了，
按规矩换成上面那三条更窄的）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy`、`tests/oir` —— 只动了
`frontend-jnc/lower.js` 里枚举与二元 / 一元算子那几段（加 `tests/jnc/run.js` 的头注释），
语法一个字没改（`bitflag enum` 那个 token 本来就在），方言、MIR、四个后端与运行时也没动；
自举、`tests/jit`、`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第四十八刀：编译期整数求值 —— 三处边界原来是同一格

`enum { Bridged = Opened + 1 }`、`int a[2 * 3]`、`case 1 + 2:` 以前各报一句"不是整数字面量"。
三条边界，一格东西：jancy 那边这三处走的都是 `parseConstIntegerExpression`
（枚举成员 `jnc_ct_EnumType.cpp:271` 与 `:296`、数组长度 `jnc_ct_ArrayType.cpp:175`）。

**它的口径**比"是不是字面量"宽得多也简单得多：把那一段当**一整条表达式**解出来，只要求结果是
`ValueKind_Const` 且类型带 `TypeKindFlag_Integer`（`jnc_ct_OperatorMgr_New.cpp:379-403`）。
也就是说在 jancy 那边"能不能写"等于"编译器折得动吗"。照着它收，`constInt` 从"字面量加一元
正负"长成一个小求值器：一元 `+ - ~ !`、二元 `+ - * / % & | ^ << >>` 与六个比较、枚举成员。

**两处照抄才对得上的细节**（都是量出来的，不是想出来的）：

- **bool 带 Integer 这个位**：`jnc_Type.cpp:38-48` 那张 flag 表里 Bool1 与 Bool8 都有
  `jnc_TypeKindFlag_Integer`。所以 `C = false` 是 0、`Cmp = 3 > 2` 是 1 —— 都合法。
  语料里真这么写：`test/jnc/test104.jnc:4`。这一条不查表就会拒错。
- **光一个名字指的是同一个枚举里已经定下的成员**：成员住在枚举自己的命名空间里
  （type_enum.rst:17），而初值就在那个命名空间里解，所以 `Bridged = Opened + 1` 不用写全名。
  语料：`test/jnc/test56.jnc:15`（还有 `All = ReadOnly | Exclusive` —— 一句话同时踩了这一条
  与 bitflag 的 `|`）。落地是一格 `this.constEnum`：只在解那个枚举的体时非 null。

**不回卷**是这一处的一个决定：求值在 BigInt 上做，落进哪一格由调用方决定 —— 枚举成员走
`wrapVal(…, info.base)`（那一句本来就在），数组长度要 1..1000000。这样求值器不用带类型。

**边界**：移位量不在 0..63（`1 << 64`）与除以 0。前者在 C 里是未定义行为（C99 6.5.7p3），
后者 jancy 也是报错而不是折出个数来 —— 与 `%+x`、负 bitflag 同一类：**没有可对的答案**。
`bad/const-shift-wide.jnc` 记着这两条（同一句诊断）。`&&` / `||` 也留在外面：它们回 bool、
同样带 Integer 位，但短路在常量位置上没有意义，语料里一处都没有。

**期望输出的出处**：一份 `cc -O0 -std=c99 -Wall` 的孪生，六行逐字节相同。**写法差异**三处：
C 的枚举成员是裸名；`bitflag enum` 的自动取值在 C 里要写死；`countof(a)` 在 C 里是
`sizeof(a)/sizeof(a[0])`。

**放行了什么**：`test/jnc/test56.jnc`（印 `State.Bridged = 2` 与 `Flags.All = 0x3`）与
`test/jnc/test104.jnc` 整份跑通 —— 后者是上一刀量出来的下一格。

**跑过的轴**：`tests/jnc`（75/0，新增 `cases/45-constfold` 与 `bad/const-shift-wide`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy`、`tests/oir` —— 只动了
`frontend-jnc/lower.js` 的 `constInt` 与三个用它的地方（加 `tests/jnc/run.js` 的头注释），
语法、方言、MIR、四个后端与运行时一个字都没改；自举、`tests/jit`、`tests/mir`、`tests/llvm`；
`npm run lint` 这台机器上没有 typescript。

### 第四十九刀：`assert` —— 那句话是切出来的，不是拼出来的

语料里 `assert` 出现 39 处、19 份文件卡在它上面，而它在 jancy 那边不是内建函数，是一条语句：

```
assert_stmt
  :  TokenKind_Assert '(' expression_pass1 (',' TokenKind_Literal $m)? ')' ';'
```

（`jnc_ct_Stmt.llk:414-419`）降级在 `Parser::assertStmt`（`jnc_ct_Parser.cpp:3779-3827`）：建
`assert_fail` / `assert_continue` 两个块，条件真去后者、假去前者，前者调
`assertionFailure(文件, 行, 条件文本, 话)`。那个函数是 jancy 自己写的
（`jnc_rtl_CoreLib.cpp:527-542`）：

```cpp
string.format("%s(%d): assertion failure: %s", fileName, line + 1, condition);
if (message)
	string.appendFormat(" (%s)", message);
```

**方言这一次一个字都不用加**：`(fail E)` 就是"印一句、退 70"，五条腿都有
（`sexpr/lower.js:922-929`，那一条本来是为 asy 的运行期错误加的）。于是整条落成

```
(if (un "!" C)
  (do
    (fail (str "文件(行): assertion failure: 条件文本 (话)"))))
```

—— 与 jancy 的两个块一一对上。

**这一刀真正要拿准的是"条件文本"**。上一次遇到"要复现源码"这种事（第四十四刀的 `%p`）是
拒掉的，这次不用拒：jancy 也**不重排**。`Token::getText(list)` 取头 token 的起点到尾 token 的
终点，**没有换行就直接返回那一段源码**；有换行则把 `\n` 及其后的连续空白换成单个空格
（`axl_lex_RagelLexer.h:52-84`）。结点的 span 里有 `file.text` 与两个 offset，照着切就行，
一个字节都不用猜 —— `srcText` 那七行就是这一条。跨行的 `assert` 因此印的是 `x < 10`。

行号同理：`conditionTokenList->getHead()->m_pos`（`jnc_ct_Parser.cpp:3787`）是**条件第一个
token** 的位置，0 起的 `m_line` 印成 `line + 1`。所以那份跨行的用例报的是 `x` 那一行、不是
`assert` 那一行，而 `lineCol()` 本来就是 1 起的，直接印。

**两处明写的差别**：

- **jancy 的 assert 是开关点亮的**：`-a`/`--assert`（`CmdLine.h:181-184` →
  `CmdLine.cpp:90-92` → `jnc_ct_Parser.cpp:3784`），没开就**整条丢掉**、条件都不求值
  （`ModuleCompileFlag_StdFlags = 0`，`jnc_Module.h:63` —— 默认是关的）。这一层没有开关机构，
  选的是**一直开着**：反过来那头意味着断言失败静静地过，而这条线是靠"跑起来对不对"往前走的，
  那种沉默最不能要。
- **"抛"换成"停"**：jancy 那边是 `err::setError` + `dynamicThrow()`，`try` 接得住；这一层
  还没有异常（`try`/`throw` 都还在边界上），所以断言失败是到此为止。`rt/assert-fail.jnc`
  记着这件事：`after` 印不出来，五条腿同一句。

**边界一条**：`assert(C, 一个表达式)`。jancy 那条产生式里第二个实参写死是
`TokenKind_Literal`，拿的是 `$m.m_data.m_string`，编译期就进静态字面量表
（`jnc_ct_Parser.cpp:3814`）—— "运行期才知道那句话"在 jancy 里写不出来。这一层的文法比它松
（收的是 `expr`），于是拦在降级那步，`bad/assert-msg-expr.jnc`。

> 顺带改掉一处**看错了的注释**：`jnc.grammar` 原先写着「assert 后面不带分号 —— jancy 的
> assert_stmt 就是读到 `)` 为止（Stmt.llk:416..436，那条产生式末尾没有 `';'`）」。产生式末尾
> **是有** `';'` 的（`Stmt.llk:415`），行号也不对。这里的两条产生式因此比 jancy 松两处：分号
> 由空语句收、第二个实参收 expr。松的那一半在降级那步拦回来，所以"能跑的都合法"仍然成立。

**期望输出的出处**：一份 `cc -O0 -std=c99 -Wall` 的孪生，两行逐字节相同。**写法差异**两处：
C 的 `assert` 只收一个实参，所以 `assert(x, "话")` 在孪生件里写成 `assert(x)`；C 的函数定义
要写 `int bump(void)`。用例里那个 `assert(bump() == 7)` 是量"条件求值一次"的 —— `g` 印出来是 1。

**放行了什么**：`test/jnc/test12.jnc` 整份跑通（`(*p)[i]` 取到 6，断言通过）。剩下 18 份都
还有别的卡点，扫出来的下一批是：`'class'` 4 份、`variant_t` 3 份、`jnc.Regex` 2 份、
int 转枚举的显式 cast 2 份（`test154/155.jnc:8` 的 `(SerialTapProStatusLines)0x12`）、
`async` / `function` / `errorcode` 三个修饰符、结构体基类、顶层 `import`，外加一处**诊断不对**：
`test69.jnc:12` 的 `enum: uint64_t {`（匿名枚举带显式底类型）报的是「认不出的枚举名字」，
那句话把"没做"说成了"你写错了"。

**跑过的轴**：`tests/jnc`（78/0，新增 `cases/46-assert`、`rt/assert-fail`、
`bad/assert-msg-expr`），外加五条腿逐条对过同一句断言失败消息。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy`、`tests/oir` —— 只在
`frontend-jnc/lower.js` 加了 `assertStmt`/`srcText` 与 `stmt` 里的一支分派，语法文件只改注释，
方言、HIR、MIR、四个后端与运行时一个字都没改；自举、`tests/jit`、`tests/mir`、`tests/llvm`；
`npm run lint` 这台机器上没有 typescript。

### 第五十刀：int 到枚举的显式转换 —— 一段代码的两条分支，之前只抄了一条

`Color c = 2;` 该拒（第三十九刀记着，`bad/enum-from-int`），可 `Color c = (Color)2;` **该收** ——
这两件事在 jancy 那边是同一个函数的两条分支：

```cpp
return
	opType->getTypeKind() == TypeKind_Enum && ((EnumType*)type)->isBaseType((EnumType*)opType) ||
	(type->getFlags() & EnumTypeFlag_BitFlag) && opValue.isZero() ?
		CastKind_Implicit :
		CastKind_Explicit;
```

（`Cast_Enum::getCastKind`，`jnc_ct_CastOp_Int.cpp:295-311`）隐式只有两条 —— 枚举到它的**基枚举**、
字面 0 到 bitflag 枚举 —— 其余全是 `CastKind_Explicit`，也就是"写了 cast 就行"。上两刀把隐式那
两条抄了（第三十九、第四十七），显式这一条漏了，于是显式写法反而落在 `cast()` 末尾那句
「把 int 转成 Color」上。这一刀补上。

**转法照它写**（`getCastOperators`，:313-334）：先用 `StdCast_Int` 把源转成枚举的**根类型**
（`getRootType()`，:323），再 `StdCast_Copy` 原样拷过去。`StdCast_Int` 就是 `Cast_Int`，它的源
不止整数 —— 实数与 bool 都收。所以 `(Color)3.9`（向零截断成 3）与 `(Color)true` 照 jancy 也是
能写的，这一刀一起收了；照"借 jancy 就借它完整的形"这一条，不挑着抄。

**顺带改掉一处诊断**：`enum Derived: Base` 原先报「枚举的基类型要是整数，这里是 Base」——
那句话把"没做"说成了"你写错了"。jancy 是**收**这个的：`EnumType::isBaseType` 头一句就是
`m_baseType->getTypeKind() != TypeKind_Enum` 的快速退出（`jnc_ct_EnumType.cpp:106-121`），
而"派生枚举到基枚举"正是上面那两条隐式里的第一条。这一层的枚举只有一格整数底类型、没有基类链，
所以改成"还不收"，记在 `bad/enum-base-enum.jnc` —— 这是这一刀划出的边界：**隐式那两条里
剩下的一条，要先有基类链才谈得上**。

**期望输出的出处**：一份 `cc -O0 -std=c99 -Wall` 的孪生，四行逐字节相同。**写法差异**三处：
C 的枚举成员是裸名且要 `typedef enum`；C 没有 `bitflag enum`，那六个值在孪生件里写死；
C99 里给枚举指定底类型（`: int8_t`）没有可移植写法，孪生件里省掉 —— 那一段的值都在 int8_t 里
放得下，省掉不改答案。

**放行了什么**：`test/jnc/test154.jnc` 与 `test155.jnc` 整份跑通（都印
`lines: 0x12, mask: 0x12` 且断言通过 —— 断言是上一刀刚做的，这两份文件因此是**两刀一起**才
放行的）。顺带量到一件事：那两份的枚举是 `bitflag enum ... : int8_t`，声明写在 `main`
**后面**，所以底类型与不看顺序的名字（第十五刀）在这条路上也一起对上了。

**跑过的轴**：`tests/jnc`（80/0，新增 `cases/47-enumcast` 与 `bad/enum-base-enum`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy`、`tests/oir` —— 只动了
`frontend-jnc/lower.js` 的 `cast()` 与 `enumDecl` 的底类型那一句（加 `tests/jnc/run.js` 的
头注释），语法、方言、HIR、MIR、四个后端与运行时一个字都没改；自举、`tests/jit`、`tests/mir`、
`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第五十一刀：`namespace` —— 挑它不是为了分数，是为了**看得见**

语料里 197 份文件卡在 `顶层的 'namespace'` 上，可其中只有 3 份带 `int main`。按"能跑几份"排，
这一刀几乎不值得做。真正的理由是另一条：**那 197 份的命名空间体根本没被走进去**，所以它们
"只有一个卡点"是假象 —— 尺子在这儿是坏的，而后面每一刀都要靠这把尺子挑。

**jancy 那边它只是名字的作用域**：命名空间不生成任何东西，查名是"从当前命名空间一层层往外退
到全局"（`NamespaceMgr::findItem` 那一族），同名的可以**重开、内容合并**
（`openNamespace` 找得到就复用那一格）。

落法照这个形状：`nsFlat` 把树摊成一串 `{ns, it}`，`run` 的每一遍先把 `this.ns` 摆到那一条
所在的那一格；登记走 `qual`（加前缀），查名走 `resolve`（从里往外退）。**重开与合并自然成立**——
两段都往同一个前缀底下登记，摊平之后看不出它们原来是两段。

**内部的分隔符是 `$` 而不是点**：这五张表（`structs` / `enums` / `aliases` / `globals` /
`fns`）的键**同时**就是方言里的名字，而点不是方言里合法的标识符字符，`$` 是（第九刀的
`x$c`、第三十六刀的 `$sv0` 早就在用）。所以 `namespace a` 里的 `S` 落成 `(struct a$S …)`，
报错时再由 `shown` 换回点 —— 那才是源码里写的样子。

**两条照抄的细节**：枚举成员**不往外漏**（type_enum.rst:17，第三十九刀就在了 —— 命名空间
不改它，`namespace a` 里也得写 `Kind.Two`）；命名空间里的 `main` **不是**入口（jancy 的入口是
全局那一个，所以 `isMain` 要先看 `this.ns === ''`）。

**顺带掉下来三件**（都不是这一刀瞄着的，是同一个 `qname` 带出来的）：`qname` 以前对限定名
一律回 null，改成认 `qualified` 之后，「这种类型说明符」（`jnc.Regex` 那种）少了 **125** 份、
「限定名或特殊名的声明符」（`void a.f() {}` —— jancy 收这种"往那个命名空间里放"的定义）少了
**99** 份；再加表达式位置上的 `dotted`（`a.b.deep()` 在语法树里是一串 `field`，不是
`qualified`），「不是直接调一个名字的调用」少了 **72** 份。

**边界一条**：`using namespace`（`bad/using-namespace.jnc`）。这一刀做的是"从里往外退"这条
**线性**的路，而 `using` 往当前这一格里塞一条别的查名路径 —— 线变成图，撞名还要报歧义。
同一档的 `using extension` 与 `friend` 各有前置（extension、访问控制），都还没有。

**期望输出的出处**：一份 `cc -O0 -std=c99 -Wall` 的孪生，七行逐字节相同。**写法差异**两处：
C 没有命名空间，孪生件里写 `a_g` / `a_b_deep` 这种前缀形（这一层内部也是这么落的，只是
分隔符用 `$`）；C 的枚举成员是裸名、类型要 `typedef enum`。

**放行了什么 —— 以及量出来的那件正事**：`test/jnc/test129.jnc` 整份跑通（这一刀唯一放行的
runnable 文件）。尺子那一头的收成是：全量扫一遍，**新露出 382 条**(文件, 卡点)，其中
`opaque class` 71、64 位无符号 57、`class` 52、间接调用 26、函数原型 16、`label` 15 ——
这些以前全藏在一句"顶层的 namespace"后面。`sys_Timer.jnc` 与 `sys_Thread.jnc` 就是样本：
它们从"卡在 namespace"变成"卡在 `opaque class`"，那才是真话。

**跑过的轴**：`tests/jnc`（82/0，新增 `cases/48-namespace` 与 `bad/using-namespace`）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy`、`tests/oir` —— 只动了
`frontend-jnc/lower.js`（`nsFlat`/`qual`/`resolve`/`dotted`/`nameLv` 加各处登记与查名，
`tyName` 里两句 `shown`），语法、方言、HIR、MIR、四个后端与运行时一个字都没改；自举、
`tests/jit`、`tests/mir`、`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第五十二刀：`class` —— 引用语义不用方言长东西，"变量里放地址"就是它

按"只有一个卡点、而且带 `int main`"排，上一刀之后 `'class'（只收 struct）` 是第一名（22 份），
全量里它是 232 条(文件, 卡点)。挑它还有第二条理由：类里的东西一份都没被走进去，所以它后面
藏着的那些卡点全是暗的 —— 与上一刀挑 `namespace` 是同一个道理。

**先读，再决定长不长方言**。方言里**本来就有** `(class …)` / `(cnew …)` / `(fld …)`
（`tests/sexpr/cases/07-classes.sx` 逐行证过引用语义），可这一刀**没用它**：那一格的字段还不收
`(blk T N)`（那份用例自己记着这条边界），而 jancy 的类里数组字段一大把。走的是另一条 ——
**类在方言里就是一格 `(struct …)`，引用语义由"变量里放的是地址"给出**。于是 `pfield` /
`pload` / `pstore` 那一整套原样可用，方言一个字没改。

**`C` 与 `C*` 是同一个表示**，这不是我们的简化，是照抄：`calcPtrType` 对 `TypeKind_Class` 走的是
`getClassPtrType`（jnc_ct_DeclTypeCalc.cpp:226-229）—— 类上的那个 `*` 不再套一层数据指针。
所以这一层的类型就一格 `{k:'class', name}`，另带一个 `own` 标记"源码里写的是不带 `*` 的那一种"。
`own` 只管三件事，同型判定不看它：

- **声明要不要造对象**：`C1 a;` 在 jancy 那边就是造一个（01_Classes.jnc:90-92；文档里更直白：
  局部的那些 "allocated on heap (same as: `C1* a = heap new C1;`)"），`C* p;` 不造（空引用）。
  模块级的静态分配 —— 落成 `globalCells` 里那句 pnew，排在所有初值之前。
- **赋不了值**：type_class.rst:19 那句 "You **cannot assign** varibles or fields of class
  types"。类指针照旧可以赋 —— 那是换个引用，不是拷贝对象。
- **jancy 自己拒的那三条**照抄它的话：形参（"function cannot accept '%s' as an argument"，
  jnc_ct_Parser.cpp:2537-2545）、返回（"function cannot return '%s'"，
  jnc_ct_DeclTypeCalc.cpp:432-441）、数组元素（"cannot create array of '%s'"，同一份 384-390）。

**方法：类是一层命名空间，于是它连一行新机制都不用**。jancy 的 `ClassType` 派生自 `Namespace`，
而方法体**体内写与体外写任选其一**（type_class.rst:41-59）。所以 `nsFlat` 把类体里的 `fn-def`
当成"命名空间是这个类"的顶层条目提出来 —— 名字于是与体外写的 `void C.foo() {}` 落在**同一格**
（`C$foo`，第五十一刀的 `qual` 早就会把点换成 `$`）。落地形状是一个自由函数、`this` 当第一个
形参（方言里叫 `$this`：`this` 是 JS 的关键字，而 JS 后端把方言的名字原样发出去）。裸写的字段名
（`m_x`）由 `selfField` 接成 `(pfield (var $this) m_x)`，裸写的方法名（`foo()`）由 `resolve`
在类那一层里找着、`this` 隐式补上 —— 两条都是"类是一层命名空间"的直接后果。

**嵌套类型是同一条**（`class C { struct S { … } }` 里的 S 就是 `C.S`）：一并提到顶层，登记成
`C$S`。它逼出两处 ns 的摆放：类体里查名要从**这个类**那一层起（`S1 foo();`，test97.jnc:8），
而**体外写的方法签名也要**（`S1 C.foo()`，同一份 15 行）—— 后者用的是新的 `nsExtra` 而不是
`this.ns`，因为登记那一处要的是源码里写的 `C.foo`，`qual` 不能再叠一次前缀。

**一处顺手补的、也是量出来才发现的**：`class T {}` jancy 收（test124.jnc:18、test151.jnc:21），
而方言的结构体至少要一个字段。类这边发一格 `$hdr` 占位 —— 理由不是"糊过去"：jancy 的类
**本来就有对象头**（01_Classes.jnc:12-14："Actual user fields are preceded with a header
containing meta-data such as type, vtable pointer, root object pointer, GC-related flags"），
一格占位比"零字节的对象"更贴它。**struct 那边不补**：jancy 的 struct 没有头，补一格就是在
布局上说假话 —— 所以空 struct 记成一条边界（`bad/empty-struct`，卡在方言那一侧）。

**边界三条**：类的基类（`bad/class-base`，要对象头与虚表：`basetype1..9` 加
`virtual`/`abstract`/`override`）、类里的 `construct`/`destruct`/`get`/`set`
（`bad/class-construct`，构造要"造完接着调"、析构要"作用域退出按逆序"、`static construct` 要
一格模块级闸门 —— 三样各是一刀的量，半条构造比没有构造更糟）、类**值**的字段
（内嵌的对象，要"父对象造出来时把它也造出来"）。加一条 jancy 自己也拒的：给类的变量赋值
（`bad/class-var-assign`）。

> 更正（第五十三刀）：这一条里说"析构要作用域退出按逆序"是**错的** —— jancy 自己的文档说
> 析构归 GC，时机不确定（disposable.rst:17）。第五十三刀把 `construct` 与 `static construct`
> 收了，`bad/class-construct` 因此删掉，边界重画成更窄的两条：`bad/class-destruct`（引那一句
> 文档）与 `bad/ctor-overload`（构造的重载要重载决议）。`get`/`set` 归"属性那一套"。

**这一层比 jancy 松的一处**：`public:` / `protected:` 照收，但**不做可见性检查**
（type_class.rst:23-27，默认 public）。松的方向是"能跑的程序行为不变"，所以先记着。

**期望输出的出处**：一份 `cc -O0 -std=c99 -Wall` 的孪生，八行逐字节相同。**写法差异**三处：
C 没有引用类型（孪生件里 `struct` + `calloc` + 满地 `->`）、没有方法（写成"第一个形参是
self"的自由函数，这一层的落法正是它）、类变量不会自己造对象（孪生件要显式 `calloc`）。

**放行了什么**：`test/jnc/test24.jnc`、`test124.jnc`、`test151.jnc` 三份整份跑通（五腿一致）；
`test97.jnc` 只剩空 struct 那一条。尺子那一头：`'class'（只收 struct）` 那 232 条清零，
**新露出 605 条**(文件, 卡点)、去掉 331 条，新露的头几名是类的基类 131、`opaque class` 74、
`try` 与 `? :` 当语句 65、类里的 `construct` 45、修饰符 `override` 45、`property` 19。
"只有一个卡点、带 `int main`"那张榜现在是：`import` 13、printf 的格式串不是字面量 7、
修饰符 `bigendian` 3、`opaque class` 2 —— 类那一族从榜首整片消失了。

**跑过的轴**：`tests/jnc`（87/0，新增 `cases/49-class` 与 `bad/class-base`、
`bad/class-construct`、`bad/class-var-assign`、`bad/empty-struct`）、`tests/sexpr`（75/0）、
`tests/glr`（20/0）。**没跑的**：`tests/asy`、`tests/oir` —— 只动了
`frontend-jnc/lower.js`（类型那一格、`nsFlat`/`aggHoist`、`typeName`/`typeDecl`、
`fnSig`/`fnDef`、`callExpr`/`methodCallee`、`localDecl`/`globalDecl`、`binary`/`truthy`/`null`），
语法、方言、HIR、MIR、四个后端与运行时一个字都没改；自举、`tests/jit`、`tests/mir`、
`tests/llvm`；`npm run lint` 这台机器上没有 typescript。

### 第五十三刀：`construct` / `static construct` —— 造出来那一格之后，还有一句要跑

**挑它是挑第二名**。"只有一个卡点、带 `int main`"那张榜的第一名是 `import`（13 份），可那 13 份
里 12 份 import 的是 stdlib 单元（`io_*.jncx` / `std_*.jnc` / `sys_*.jnc`），而那些单元自己满是
`opaque class` 与 `property` —— 接了 `import` 那 12 份照样跑不起来，只是把卡点换成别人的名字。
构造这一族在全量里是 67 条(文件, 卡点)（`construct` 45、`destruct` 15、限定名/特殊名的声明符里
一大半、C++ 式的构造声明符 9、`static construct` 3），而且 28 份带 `int main` 的文件提到它。

**两件事，一句话分完**。实例构造就是"一格方法"，第五十二刀那条路整条复用：类是一层命名空间，
所以体内写的 `construct(int x) {}` 与体外写的 `C.construct() {}` 经 `aggHoist` 落在**同一格**
名字上（`C$construct`），`this` 当第一个形参。静态构造是"整个类一次"，落成一格模块级 `bool`
加一句 `if` —— 与第二十六刀 `static` 局部量那道 once 闸门同一个形状。

**时机不是编的，是读出来的**。静态构造在**实例构造的开头**调（`Parser::finalizeConstructor`
那四句：基类构造 → 静态构造 → 字段初值 → 属性构造，jnc_ct_Parser.cpp:3005-3009），"只一次"
是 `MemberBlock::callStaticConstructor` 里的 `ModuleItemFlag_Constructed`。还有一条不读就会漏：
类**只有**静态构造、没有实例构造时 jancy 自己合成一个（`DerivableType::createDefaultMethods`）
—— 不然那段代码永远跑不着。所以 `Reg r1;` 也要把 `Reg.static construct()` 里那句 printf 打出来，
`cases/50-construct.jnc` 里量的正是这一条。

**三种写法，语法只加一条**。`C1 a(100)` 与 `C1 g_a construct()` 在声明符尾巴上早就有 `(ctor …)`
那一格（`jnc.grammar` 的 `ctor` 规则），之前 declarator 把它整条拒成"C++ 式的构造声明符"；这一刀
把它接进 `info.ctor`。加的唯一一条产生式是 `new C1 construct(20)` —— jancy 那边它与 `new C1(30)`
**是同一条**（`TokenKind_Construct?` 是可选的一个词，jnc_ct_Expr.llk:726-734），所以这里也归到
同一个 `(new 类型 实参)` 上：那个词只把"这括号是构造实参"写明白，没有别的意思。
出处是 type_class.rst:125-149 那一整段（`C1 a();` 的歧义正是它要躲的）。

**`new C(…)` 仍旧是一个表达式**。pnew 一格再调一句构造是**两句**，而 `new` 可以出现在惰性位置上
（每次求值都得真造一格）—— 所以照第二十五刀 `newCurly` 那条路，把这两句抬成一个函数
（`$newoN`），实参在调用方求值、传进去。方言一个字没改。

**顺手堵了三处静默**：字段后面的构造实参（内嵌那一格还不收，实参会被丢掉）、`static` 的类局部量
（`zeroText` 会把它当标量、只发一格空引用出来 —— 那是在骗人）、非类类型后面挂构造实参
（`new int(3)` / `int x(5)`）。三条都是"以前一个字不说、现在明说"。

**边界两条**（都引 jancy 自己的话）：`bad/class-destruct` —— 析构归 GC，时机不确定
（disposable.rst:17："destructors in garbage-collected world are not called deterministically"），
出作用域调会比它早、不调会漏副作用，两种都是编的；`bad/ctor-overload` —— 构造可以重载
（type_class.rst:63），但那是**重载决议**那一整套（一个名字挂多份签名 + 按实参挑），要接就得连
普通函数的重载一起接。原来那条 `bad/class-construct` 删掉了：它记的东西落地了。

**这一层比 jancy 松的一处**：特殊成员的声明符不看说明符（语法给的是空的 `(specs)`），所以
`void C.construct()` 也收，而 jancy 那边构造不写返回类型。松的方向是"能跑的程序行为不变"。

**期望输出的出处**：一份 `cc -O0 -std=c99 -Wall` 的孪生，九行逐字节相同。写法差异与第五十二刀
那份相同的两条（struct + calloc + `->`、方法写成"第一个形参是 self"的自由函数），加一条：静态构造
那道闸门在孪生件里是一格 `static int`，这一层落的是一格模块级 bool —— 同一个东西。

**放行了什么**：`test/jnc/test25.jnc` 整份跑通（五腿逐字节一致：`new OpaqueTest(100, 200)`
加两次方法调用）。尺子那一头：全量 1707 → 1689 条(文件, 卡点)，**去掉 96 条**（`construct` 45、
限定名或特殊名的声明符 20、`destruct` 15、C++ 式的构造声明符 9、`static construct` 3、
`set`/`get` 各 2），**新露出 78 条**（`set` 19、`destruct` 19、"不是直接调一个名字的调用" 10、
`get` 9、`%p` 5、把 `C2` 转成 `I0*`..`I3*`/`C0*`/`C1*` 各 1、形参的默认值 1）。
"只有一个卡点、带 `int main`"那张榜从 39 份变成 42 份：`import` 12、printf 的格式串不是字面量 7、
`bigendian` 3、`opaque class` 2、`destruct` 2，剩下的都是 1。"一条卡点都没有、带 `int main`"
仍是 56 份 —— 但成员换了两个：`test25.jnc` 进来，`test138.jnc` 出去。后者顶层写了个
`destruct() {}`（模块析构），以前 `fnSig` 在那个空 `(specs)` 上报的是一句**错话**
（「这种类型说明符」，而且没有位置）—— 它压根就没在这把尺子上，因为尺子只数"还不收"；
现在它是一条老实的还不收。这不是回退，是把一处哑的错话换成了记在名单上的边界。

**跑过的轴**：`tests/jnc`（89/0，新增 `cases/50-construct` 与 `bad/class-destruct`、
`bad/ctor-overload`，删掉 `bad/class-construct`）、`tests/glr`（20/0，语法加了一条产生式，
金表重生成：352→353 条规则、633→637 个状态、留给 GLR 驱动的冲突 1420→1421）、
`tests/sexpr`（75/0）。**没跑的**：`tests/asy`、`tests/oir` —— 只动了
`frontend-jnc/lower.js` 与 `jnc.grammar`（`aggHoist`/`typeDecl`/`declarator`/`fnSig0`/`fnDef`/
`run` 的签名后那一遍/`localDecl`/`globalDecl`/`staticLocal`/`newPtr`），方言、HIR、MIR、
四个后端与运行时一个字都没改；自举、`tests/jit`、`tests/mir`、`tests/llvm`；
`npm run lint` 这台机器上没有 typescript。

### 第五十四刀：相邻字面量的拼接 —— 一句说错了原因的诊断

**这一刀是尺子读出来的一处错话**。上一刀之后"只有一个卡点、带 `int main`"那张榜的第二名是
`printf 的格式串不是字面量（要它就得在运行期解释格式）`（7 份，全量 18 条）。可把那 18 条一条条
看下来，一多半根本不是"运行期"：

```
	printf(
		"system info:\n"
		"\tcpu:       %s\n"
		…
```

这是 C 的相邻字面量拼接（test107.jnc:3、93_HidEnum.jnc:29、13_DynamicCast.jnc:78），
**编译期**就定下来了。语法早就把它归成了 `(concat …)`（jnc.grammar 的 literal 规则，
`literal_atom+`），是降级这一侧只认"一个 string 词法节点"。那句诊断因此不只是"还不收"，
它还把原因说错了。

**落法一行**：`litFold` 递归折平 `(concat …)`，折出来的还是一格字面量 —— printf 的格式串、
表达式里的字符串值、`assert` 的第二个实参三处共用它。出处是 literals.rst:90 那句
"all literal kinds can be concatenated and combined. If the combination does not include
formatting literals, then the result is a statically allocated const char array" —— 界正好
划在"不含格式化字面量"这里，所以这一刀的边界不是我们挑的，是那句话本身给的。

**折不动的三格，各自记成一条边界，诊断也照着说**（`litWhy`）：

- 格式化字面量 `$"…"`（`bad/lit-fmt`）：它产出的是**动态**的 char 数组（literals.rst:62），
  `$x` 与 `%1` 这一层拼得出来（就是字符串相加），可 `$(expr; spec)` 里那一格是一整条表达式
  —— 语法把 `$"…"` 整块当**一个** token、里面一个字没解析（jancy 自己也是这样，它在编译期对
  那段文字再跑一遍词法与表达式解析）。要收它得先有"在降级里回头解析一小段源码"的路。
- 二进制字面量 `0x"61 62"`（`bad/lit-binary`）：literals.rst:33 说的是**逐字节**的一块
  const char，而方言里一格整数占 64 位 —— 与 `sizeof` 卡在同一处（决策二那处刻意留下的差别）。
- `__FILE__` / `__DIR__` / `__FUNC__` / `__LINE__` / `__DATE__` / `__TIME__`（`bad/lit-macro`）：
  词法层的预定义宏，值要靠编译期环境；后两个连"每次跑出来一样"都做不到，期望输出没法写。

顺带把 `r"…"`（原始字面量）从「认不出的字面量」那句错话改成一条老实的"还不收"。

**期望输出的出处**：相邻拼接是 C 自己的规矩，所以孪生件与 `cases/51-litcat.jnc` **逐字一样**
（只有 `string_t` 写成 `const char*`），`cc -O0 -std=c99 -Wall`，四行逐字节相同。

**放行了什么 —— 说清楚：不是新文件，是诊断**。全量 1689 → 1691 条(文件, 卡点)：去掉 17 条
（`printf 的格式串不是字面量` 13、表达式 `fmt` 2、表达式 `concat` 2），新露出 19 条 —— 而新露的
每一条都是**同一处**换了个说得准的名字（`printf 的格式串是格式化字面量` 9、格式化字面量当值 2、
原始字面量 2、拼接里有格式化字面量/二进制字面量各 1、二进制字面量 1、格式串是 `__FILE__` /
`__DIR__` / 二进制字面量各 1）。"只有一个卡点、带 `int main`"从 42 份变 43 份，其中
`printf 的格式串` 那一行从 7 降到 4。"一条 `还不收` 都没有、带 `int main`"56 → 55，
`test107.jnc` 进来、`71_MixedLanguageRecognition.jnc` 与 `test110.jnc` 出去 —— 出去的两份本来
就卡在**硬错**上（`没有这个类型 'Language'`、`未声明的变量 'ipTable'`），新的 nope 只是把
字面量那一格也说出来了；进来的 test107.jnc 也**照旧跑不起来**：它要 `sys.g_systemInfo`，
标准库这一刀不接。所以这一刀的账要这么记：语料里 13 处 printf 的格式串从"被错话拒掉"变成
能编，剩下的每一处都归到了对的名下 —— 没有新文件整份跑通。

**跑过的轴**：`tests/jnc`（93/0，新增 `cases/51-litcat` 与 `bad/lit-fmt`、`bad/lit-binary`、
`bad/lit-macro`）。**没跑的**：`tests/glr`（语法一个字没动）、`tests/sexpr`、`tests/asy`、
`tests/oir`、自举、`tests/jit`、`tests/mir`、`tests/llvm` —— 这一刀只动了
`frontend-jnc/lower.js`（`litFold`/`litWhy`、`expr0` 的 concat 与 fmt 两支、`printf` 的格式串、
`numLit` 的兜底、`assertStmt` 的第二个实参）；`npm run lint` 这台机器上没有 typescript。

### 第五十五刀：函数指针 —— jancy 的 fat 指针与方言的函数值本来就是同一个东西

**为什么是它**。上一刀量完，排在第二的是「类的基类」（131 条(文件, 卡点)），而 `override` 在
语料里出现 450 次、`virtual` 41 次 —— 单继承接了却不做虚派发，编得过但派发到错的那一个，
那是骗人，所以基类那一刀必须**连虚派发一起**。虚派发要的是"一格里放着一个函数、运行期决定
调哪个"，于是先问方言有没有这一格：有 —— `(fnty (T…) R)` / `(cfn …)` / `(mkclo …)` /
`(callfn …)` / `(fnref …)` 是 ADR-0010 定下、ADR-0014 那条 asy 线上落地并五腿验过的一档
（`tests/sexpr/cases/15-fnvalues.sx` 是它的本体，量它的理由也在那儿：真 base 在场时 304 个
asy examples 里 203 个第一个撞的就是 math.asy:446 那个函数类型的形参）。

再问 jancy 那一侧叫什么 —— 叫 `R function* p(形参)`，而 type_ptr_function.rst 开头那句把两边
钉在了一起："a fat function pointer consists of a pointer to the function and a closure
object"。**那就是 ADR-0010 的 `{fp, c_*}`**：不是"能模拟"，是同一个模型。所以这一刀不是为
虚表铺路才做的，它本来就该在类那一族之前 —— 只是量出来才知道它已经躺在方言里了。

**语法那一半在哪**（`glr` 打出来的树，探针 `/tmp/p55.jnc`）：`function` 是**类型修饰符**，
落在 `specs` 的第二组 mods 里（`function` 是 mods 关键字，jnc.grammar:264）；`*` 在声明符的
`ptrs` 里；形参表是名字后面的 `fn-suffix`，里面的项多是 `formal-anon`（无名形参）。三块分在
三处，拼起来才是一格类型 —— 所以 `declarator` 在 `sp.fnptr` 为真时**整条走开**（`fnPtrDcl`），
不进原来那套"数组后缀 + 函数后缀"的循环：那套会把这对括号当成"这是个函数声明"。

**落法**：新一格类型 `{k:'fnptr', params, ret, thin}`，`tyText` 就是 `(fnty (…) …)`。剩下的
四处各一行：`= foo` 是 `(fnref foo)`（`expr0` 的 name 那支，原来那句「把函数 'x' 当值用」的
"还不收"删了）、`p(…)` 是 `(callfn (var p) …)`（`fnCallee` 先问一句 `lookupRef`，纯的，
所以同名的局部量照样遮住模块级的函数）、形参与返回位置什么都不用做（`slotText` 一路通到
`(fn f ((op (fnty (int int) int))) …)`）、`f(…)(…)` 也收（回一格函数指针的函数，见下）。

**`c.foo` 那一格**：jancy 的 fat 指针捕的就是那个对象，方言里"带捕获的函数"是 `(cfn …)` +
`(mkclo …)`，所以这一层给每个被当值用的方法抬一段 thunk：

```
(cfn Counter$bump$clo (($self (ptr Counter))) (($a0 int)) int
  (ret (call Counter$bump (cap $self) (var $a0))))
```

`c.bump` 就是 `(mkclo Counter$bump$clo (var c))`。一个方法一段（`this.clos` 记着），
`d.bump` 是**另一格** `mkclo`、捕的是 d —— 测例里 `b(5)` 两次把 c 从 100 推到 110、
`e(1)` 把 d 从 7 推到 8 而 c 不动，五条腿上逐字节相同。

**方言一个字没改，语法一个字没改**（上一刀动过 jnc.grammar，这一刀没有，所以 `tests/glr` 的
金表也没动）。

**边界四条，都记成了 bad case**：

- `bad/fnptr-nozero`：没写初值的**局部**函数指针。方言的函数值那一格**没有空值** ——
  `(let …)` 要一个初值，而"空的函数指针"发不出来，跟着 `if (p)` 与 `p == null` 也立不住。
  模块级的那一格不在里面：`(global g (fnty …))` 五条腿都收（测例里的 `g_op` 就是它），
  只是赋值之前调它未定义 —— 与空的类引用同级。
- `bad/fnptr-field`：函数指针的**字段**。量出来的：`(struct Box (f (fnty (int) int)))` 在五条
  腿上都被拒（「落不进内存的字段」，hir/types.js 的 `structLayout`），而方言的 **class** 字段
  收它（15-fnvalues.sx 的 Holder）。这一层的类与结构体都落成 `(struct …)` + `pfield`
  （第五十二刀是这么选的：方言的 `(class …)` 字段放不下 `(blk T N)`），所以两边各缺一半。
  **虚表要落的正是这一格** —— 下一刀的第一件事是量这两条补法哪条便宜。
- `bad/fnptr-ptrptr`：`function**` 与它的数组（文档末尾那个 `int function** f5[]`）。要方言
  能对函数值那一格取地址，与上一条挨着。
- `bad/fnptr-partial`：`~()` 的部分应用（`foo~(10)`）。顺带把它那句诊断从「表达式
  'call-operator-new'」（照 jancy 产生式起的名字，与 `new` 没关系）改成说得准的那一句
  —— 与上一刀那件事同一个毛病。

还有两条没单独立文件：`function weak*` 落在 `specs` 那句「修饰符 'weak'」上（要 GC 那侧的
弱引用），显式转换生成 thunk 落在 `specsTy` 新加的那句上（没有形参表的 `function` 类型）。

**顺带白拿的两格**：`typedef int function* BinOp(int, int);`（第三十八刀那一层本来就是"直接拿
解出来的类型当 base"）与"回一格函数指针的函数"（`BinOp pick(int k)`，返回类型走 typedef
那个名字）。所以 `bad/typedef-fn` 那条边界的**理由**要改：它记的是"函数类型"自己当一格名字
（`typedef int F(int);`），不是函数指针 —— 原来那句"这一层还没有函数指针那一格"已经过期，
就地改掉了。

**期望输出的出处**：`/tmp/e55.c`，`cc -O0 -std=c99 -Wall`。fat 指针那一段在 C 里写成
`struct { int (*fp)(Counter*, int); Counter* obj; }` 加一个 `callfn` —— 那正是 jancy 那句
"函数 + 那个对象"的字面写法，所以孪生件算的是同一串数。十五行逐字节相同。

**放行了什么 —— 又一次要说清楚：没有新文件整份跑通**。全量 1691 → 1688 条(文件, 卡点)：
去掉 5 条（**全是**「修饰符 'function'」），新露出 2 条（21_WeakFunctionPtr.jnc 的
「修饰符 'weak'」、test139.jnc 的「void function*() 的局部量不写初值」）。"只有一个卡点、带
`int main`" 43 → 43，"一条 `还不收` 都没有、带 `int main`" 55 → 55 —— **两个都没动**。

为什么这么少：语料里带 `function*` 的有 34 份（58 处），可其中只有 5 份是**它**当着卡点 ——
另外 29 份里那一行根本没读到说明符就被更外面那一层拒了，量出来的排行是 `opaque class` 22、
顶层的 `import` 20、类的基类 7，再往下是 `override` / `errorcode` / `async` 各 3。去掉的那 5 份
正好是函数指针那一族的样例，各自还差什么也量出来了：

- `20_FunctionPtr.jnc`：只剩「字段的默认值」与「语句 'typedef'」（函数体里的 typedef）。
- `21_WeakFunctionPtr.jnc`：`weak` 与字段默认值。
- `22_ScheduleOperator.jnc`：`override` + 基类 + 「不是直接调一个名字的调用」。
- `23_Multicasts.jnc`：`event` 与 `multicast`。
- `test139.jnc`：`sizeof`、`pragma`，加上面那条没写初值的。

`f(…)(…)`（回一格函数指针再调）是收工前补的一支，补完**重新全量扫了一遍**：与上一遍逐字
相同（1688 条，diff 空）—— 语料里那 45 条「不是直接调一个名字的调用」一条都不是这个形状，
它们是从字段/表达式上调。所以这一支是为完整性收的，不是为分数。

**跑过的轴**：`tests/jnc`（98/0，新增 `cases/52-fnptr` 与 `bad/fnptr-nozero`、`bad/fnptr-field`、
`bad/fnptr-ptrptr`、`bad/fnptr-partial`）、`tests/sexpr`（75/0）、`tests/glr`（20/0 —— 语法没动，
跑它是为了证明没动）。**没跑的**：`tests/asy`、`tests/oir`、自举、`tests/jit`、`tests/mir`
（那条本来就红：`fmtFixed`/`fmtSci`/`fmtGen` 不在 `frontend-js/link.js` 的 `NATIVE_OPS` 里）、
`tests/llvm` —— 这一刀只动了 `frontend-jnc/lower.js`（`tFn`/`isFn` 与 `tyText`/`tyName`/
`sameTy` 三处分支、`specs` 的 `function` 修饰符、`declarator` 分岔出的 `fnPtrDcl`、`specsTy`、
`expr0` 的 name 与 field 两支加 `call-operator-new`、`fnCallee`/`callThrough`/`fnValue`/
`methodThunk`/`methodRef`、字段那处与 `localDecl` 的两条拒）；`npm run lint` 这台机器上
没有 typescript。

### 第五十六刀：单继承 —— 一整条链共用一格结构体，于是上转是零条指令

**卡在哪**。jancy 的类只能经引用到达，`B* b = d;` 是它到处在用的写法 —— 而方言的指针**没有
类型重解释**那一格（`pnew` / `pnull` / `pload` / `padd` / `psub` / `pisnull` / `pfield` /
`pthin` / `pelem` / `peq` 就这几个，见 sexpr/lower.js:1646）。前一刀把类落成"一格
`(struct C …)` + 变量里放地址"，于是 `D*` 与 `B*` 是两个不同的方言类型，上转发不出来。

两条路：给方言长一格指针的重解释，或者**让整条继承链共用一格结构体**。选了后者：一条链一格
`(struct 根 …)`，字段是链上所有类的**并集**，于是 `D*` 与 `B*` 本来就是同一个方言类型 ——
上转发**零条指令**，方言一个字没长。方法照旧是带前缀的自由函数，`Derived$construct` 的第一个
形参就写成 `(ptr Base)`：

```
(struct Base (m_x int) (m_y int) (m_z int))
(fn Derived$construct (($this (ptr Base)) (x int) (y int)) void
  (expr (call Base$construct (var $this) (var x)))
  (pstore (pfield (var $this) m_y) (var y)))
```

**代价说清**：一格对象的大小是**整条链里最大那个**（同一条链上的兄弟类共用字段那几格，与
union 同理 —— 一个对象同一时刻只是链上的一个类）。这一层没有 `sizeof`（那条边界记在
`bad/sizeof.jnc`），所以这个差别从语义上看不见。同名字段类型一样就共用那一格，不一样就明说
不收 —— 那要按类给字段改名，而 `pfield` 这一层到处用的是源码里的字段名。

**顺序**：`(struct …)` 的发出推迟到所有 `type-decl` 都过完（`classLayout`）—— jancy 不要求
先声明后使用，`class D: B` 写在 `class B` 上面是合法的。链上的环当场拒（不然那两个循环不停）。

**构造的三格，各有出处**（jancy 的顺序是"基类构造 → 静态构造 → 字段初值"，
jnc_ct_Parser.cpp:3005-3009 那四句里的第一句是 `callBaseTypeConstructors`）：

- 源码里写了 `basetype.construct(…)`（type_class.rst:253）就用那一句 —— 它是**静态**绑定的，
  `basetype.foo()` 说的就是"调基类那一个"。
- 没写就**自动补**一句（jancy 也只在没显式调时才补）—— 基类那一个要实参时补不出来，报错。
- 派生类干脆没写 `construct`：合成一个，它做的事就是把基类那一个调一遍
  （`DerivableType::createDefaultMethods`）。不合成就等于 `D d;` 悄悄跳过基类的构造 ——
  那是骗人。按链的深度从上往下合成，所以基类那一个（可能也是合成的）已经在表里了。

**查名多了一条链**：类是一层命名空间（第五十一刀），可**基类不是这一层的外层** —— `resolve`
走的是命名空间前缀，走不到基类上。所以方法与字段各多问一遍：字段表 = 基类的 ++ 自己的，
方法沿链自下往上找（派生的遮住基类的）。

**边界四条，都记成了 bad case**（`bad/class-base` 那条整条落地了，按规矩删掉，换成这四条）：

- `bad/class-multibase`：多继承。jancy 的模型是多继承（type_class.rst:171-174），两个以上的
  基类要 `basetype1..9` 与"共享基类各一份实例"，是自己一格。
- `bad/class-structbase`：拿结构体当基类（jancy 收它，同一处 :218）。这一层 struct 是值语义、
  class 是引用语义，把前者摆进后者那条链的前面要先答清"`Point p = d;` 抄的是哪几格"。
- `bad/class-virtual`：`virtual` / `override` / `abstract`（同一处 :178）。**这一条不能"先接了
  再说"** —— 接了继承却按静态类型派发，`b.foo()` 编得过、跑出来是错的答案，而语料里
  `override` 出现 450 次。补法量过了：方言的结构体字段放不下函数值（`bad/fnptr-field`），
  所以虚表不能是"对象里一格函数指针"；路是给根那一格加一格整数标签、每个虚方法抬一段按标签
  分派的函数出来 —— 一格 int 与一个 switch，方言还是一个字都不用长。那是下一刀。
- `bad/class-downcast`：下转。它要运行期问"这个对象到底是哪个类"，也就是对象头里那一格类型
  信息（01_Classes.jnc:12-14）—— 与虚派发同一格。报的是"类型不对"而不是"还不收"：隐式下转
  在 jancy 那边本来就错。

**期望输出的出处**：`/tmp/e56.c`，`cc -O0 -std=c99 -Wall`（`-Wall` 干净）。孪生件用的就是
这一层的模型 —— 一条链一格 C 结构体、方法是收 `Animal*` 的自由函数，所以它算的是同一串数。
七行逐字节相同。

**放行了什么**：全量 1688 → 1567 条(文件, 卡点)，**去掉 143 条**（类的基类 131、
"不是直接调一个名字的调用" 10、表达式 `basetype` 2），**新露出 22 条**（多继承 18 —— 两个基类的
16 份加三个基类的 2 份、类型是类的字段 1、修饰符 `override`/`autoget`/`abstract` 各 1）。
这一刀是少见的"去掉的比露出来的多六倍"：基类那一条挡在整族类文件的最前面，一拆开，后面大多是
早就收了的东西。

"只有一个卡点、带 `int main`"那张榜没动（43 → 43）。"一条卡点都没有、带 `int main`"从 55 份到
**56 份**，进来的是 `test/jnc/test108.jnc`，没有出去的 —— 这是好几刀以来第一次真的多跑起来一份
文件。它印不出东西（`main` 只有 `return 0`），因为它是 jancy 自己的一条查名回归用例：
`class Bar: a.b.Foo` 要跨命名空间解析限定基类名，而 `Foo.foo` 里那句 `g_x` 又得从基类所在的
`a.b` 往父命名空间找。五条腿都是 0 字节输出、退出码 0。

**跑过的轴**：`tests/jnc`（102/0，新增 `cases/53-inherit` 与 `bad/class-multibase`、
`bad/class-structbase`、`bad/class-virtual`、`bad/class-downcast`；删掉 `bad/class-base` ——
功能落地了，按规矩换成上面那四条更窄的）。
**没跑的**：`tests/sexpr`、`tests/glr`、`tests/asy`、`tests/oir` —— 只动了
`frontend-jnc/lower.js`（`typeDecl` 的基类那一段、新的 `classLayout`/`synthCtors`、
`tyText`/`zeroText` 那几处 `clsRoot`、`fnDef` 的构造前奏、`assignOk` 与十四处值流、
`callExpr` 与新的 `baseTarget`），加 `tests/jnc/run.js` 的头注释；语法、方言、HIR、MIR、
四个后端与运行时一个字都没改；自举、`tests/jit`、`tests/llvm`；`tests/mir` 是先前就红的那一条
（`fmtFixed`/`fmtSci`/`fmtGen` 不在 `frontend-js/link.js` 的 `NATIVE_OPS` 里，与这一刀无关）；
`npm run lint` 这台机器上没有 typescript。

### 第五十七刀：虚派发 —— 虚表放不进对象里，可"这是哪个类"那一格放得进

上一刀把 `bad/class-virtual` 那条边界的理由写成了「不能先接了再说」：接了继承却按静态类型
派发，`Base* b = d; b.foo()` 编得过、跑出来是错的答案，而语料里 `override` 出现 450 次。
这一刀把它做掉。

**拦路的是方言那一侧，不是这一侧**：jancy 的对象头里有一格虚表指针（01_Classes.jnc:12-14），
照抄就是"对象里一格函数指针"——**方言的结构体字段放不下函数值**（`hir/types.js` 的
`structLayout` 拒落不进字节内存的字段，那条边界记在 `bad/fnptr-field`）。

绕法是把那一格从"函数指针"降成"整数"：

- 一条继承链共用的那格结构体（第五十六刀）**头上加一格 `$tag`**。它就是对象头 ——
  这一层的对象头里只需要"是哪个类"这一件事。顺带把上一刀那个 `$hdr` 占位收掉了：
  一个字段都没有的类现在天然有一格。
- 每个类一个整数标签（从 1 起 —— 0 是"没写过"，撞不上任何一个类）。
- 每个（链, 虚方法名）抬一段**按标签挑实现**的函数：`if (tag == 3) return D$foo(…) … return B$foo(…)`。
  一格 int 加一串 if，方言一个字都不用长。

**标签写在造对象那一处，不是构造里**。三处：局部量 `C c;`、模块级变量、`new C`。写在构造里
会漏掉"压根没有 construct 的类"，而那种类照样能有虚方法 —— 漏了它的标签就是 0，分派会掉进
兜底那一支给出错的答案。写在造对象那一处就没有这个洞：那一处**总是**知道静态类型是谁。
顺带它也把 jancy 的另一条对上了：标签在**构造之前**就写死，所以基类的构造里调虚方法会派发到
派生那一个 —— jancy 的虚表指针也是在**分配**那一刻填的（`GcHeap::tryAllocateClass` 里那句
`primeClass(box, type)`，jnc_rt_GcHeap.cpp:253；填的动作在 jnc_Runtime.cpp:619 的
`jnc_primeClass`），构造还没开始跑。
（`new C` 因此从"没构造就直接是一句 pnew"变成了一律抬一段 `$newo` 函数出来 —— 那里现在有
两三句。）

**分派表是穷举的**：链上每个类各问一遍"从它起沿链找第一个虚的实现"（`findVirt`），所以运行期
不会走到"没有这一格"的分支。兜底挑的是最靠根那个实现，也就是"没人覆盖时用基类的"。
代价是一次虚调用要走 O(链长) 次比较，而不是一次间接跳转 —— 这一层没有性能指标，换来的是
方言不用长。

**静态绑定那一条留着**：`basetype.foo()` 说的就是"调基类那一个"（type_class.rst:226），
所以它绕过分派。反过来，**非虚方法里调虚方法**（`Shape.tagged` 里的 `area()`）与方法体里
裸写的 `foo()` 都要过分派 —— 它们都是 `this.foo()`，而 `this` 的动态类型不一定是当前这个类。
`c.foo` 当**一格函数指针**用（第五十五刀）也一样：thunk 里转手调的是分派那一段。

**`abstract` 是"有签名、没有体"**（jancy 那句 "'%s' is abstract and hence cannot have a body"，
jnc_ct_ModuleItem.h:690）。所以它的签名只能从类体里那个**原型**上来（`methodProto`）：登记进
函数表，但**不发** `(fn …)`。于是三处要挡住"调到一段不存在的函数"：

- 造一格链上还留着 abstract 的类 —— 报错，jancy 那句是 "abstract class '%s'"
  （jnc_ct_ClassType.cpp:660，虚表里还留着 abstract 那一格的类不 Creatable）。
  `bad/class-abstract-new`。
- `basetype.foo()` 指着 abstract 的那一个 —— 报错（"'%s' is abstract"，
  jnc_ct_OperatorMgr_Member.cpp:376）。
- 把 abstract 的方法当值用 —— 同一句。

**`override` 那几条规矩照抄 jancy 自己的诊断**（jnc_ct_ClassType.cpp:507 / 568 / 573）：
基类里没有这个方法、有但不是虚方法、签名对不上，各是一句。检查排在签名那一遍之后
（`vtCheck`）—— 基类的方法那时才都在表里。`bad/class-override-plain` 钉的是中间那条。

**一处没量清、因此没进测试的**：派生类用**普通**方法遮住基类的虚方法。这一层的模型给出的
结果是"虚表那一格还是基类的"（`findVirt` 跳过不是虚的那一个），而 `d.foo()` 按静态类型直接
调派生那一个 —— 那是 jancy 虚表模型的自然结论，可"jancy 收不收这种遮盖"我没量，所以没写成
用例，也没加限制。

**边界两条，都记成了 bad case**（`bad/class-virtual` 整条落地了，按规矩删掉）：

- `bad/class-virtual-again`：同名方法上再写一遍 `virtual`。jancy 那边 `virtual`/`abstract` 走
  `addVirtualFunction`（新开一格，ClassType.cpp:464）、`override` 走
  `overrideVirtualFunction`（占基类那一格，:485）—— 基类已经有同名虚方法时前者算哪一格，
  没量出来。**猜哪一种都会静悄悄给出一个答案**，所以明说不收。
- `bad/class-abstract-new`：见上，jancy 自己也拒。

**顺手补的一格 —— `basetype1`**。量尺子时发现 `test/jnc/test18.jnc` 报的是
「未声明的变量 'basetype1'」：那是一句**错话**。`basetype1` 与 `basetype` 在 jancy 里是同一格
（type_class.rst:226 那一串 `basetype`/`basetype1..9`），单继承下两种写法都指着唯一那个基类；
可这一层的语法只把 `basetype2` 列进了层号后缀那张关键字表，`basetype1` 于是被当成了普通标识符。
补法是一个 token 加一条产生式（`(-> ("basetype1") (basetype 1))`）—— 这一刀唯一的语法改动，
金表因此重生成（353→354 条规则、637→638 个状态、终结符 175→176）。语料里 10 份文件写了它。

**期望输出的出处**：`/tmp/e57.c`，`cc -O0 -std=c99 -Wall`（`-Wall` 干净）。孪生件用的就是这一层
的模型 —— 一条链一格 C 结构体（第一格是标签）、方法是收 `Shape*` 的自由函数、虚方法多一段
`Shape_vd_area` 按标签挑实现，所以它算的是同一串数。八行逐字节相同。

**放行了什么**：全量 1567 → 1500 条(文件, 卡点)，**去掉 77 条**（修饰符 `override` 50、
`virtual` 15、`abstract` 12 —— 这一刀只拆这三个词，所以去掉的正好就是它们），
**新露出 10 条**（修饰符 `errorcode` 6、64 位无符号整数 3、`basetype2` 1）。

"一条卡点都没有、带 `int main`" 56 → **57**，进来的是 `test/jnc/test18.jnc`；
"只有一个卡点、带 `int main`" 43 → **44**，进来的是 `samples/jnc/22_ScheduleOperator.jnc`
（只剩「不是直接调一个名字的调用」）。

test18 那一份**暴露了这把尺子的一个短处**：尺子只数「还不收」，可它当时卡在一句**错话**上
（`basetype1` 被当成了变量名，报「未声明的变量」）—— 那是 err 不是 nope，所以尺子看不见。
补上那个 token 之后它才真的跑起来，五条腿印的都是 `main () / C1.foo () / C2.foo ()`
（`basetype1.foo()` 调基类那一个，正是这份用例要看的）。补完**重新全量扫了一遍**：与上一遍
逐字节相同（1500 条，diff 空）—— 那一格改掉的只是错话，一条「还不收」都没动。

**跑过的轴**：`tests/jnc`（105/0，新增 `cases/54-virtual` 与 `bad/class-abstract-new`、
`bad/class-virtual-again`、`bad/class-override-plain`；删掉 `bad/class-virtual` —— 功能落地了，
按规矩换成上面那三条更窄的）、`tests/glr`（20/0，语法加了一个 token 与一条产生式，金表重生成：
终结符 175→176、353→354 条规则、637→638 个状态）。
**没跑的**：`tests/sexpr`、`tests/asy`、`tests/oir` —— 方言、HIR、MIR、四个后端与运行时一个字
都没改（这一刀是纯前端 + 一条语法产生式）；自举、`tests/jit`、`tests/llvm`；`tests/mir` 是先前
就红的那一条（`fmtFixed`/`fmtSci`/`fmtGen` 不在 `frontend-js/link.js` 的 `NATIVE_OPS` 里，
与这一刀无关）；`npm run lint` 这台机器上没有 typescript。

### 第五十八刀：errorcode —— 一次调用之后插两句，就是 jancy 的整套异常

jancy 的异常自己就说了是什么：「a layer of syntactic sugar over good old C-style error code
checking」（exceptions.rst:15）。所以这一刀不是"实现异常"，是**把那层糖写开**。

四条规矩，逐条都有出处：

- `T errorcode f()` 的返回值**就是**错误码，出错值按返回类型定（:17：bool 的 `false`、整数的
  `-1`、指针的 `null`）。
- 不写 `try` 调它，错就**自动往上传**（:26）。
- `try E` 挡住那次传播，值照拿（:40）。
- `try { … }` 块、`catch:`、`finally:` 是同一族的另外三格（:46、:62）。

前三条这一刀落地，第四条明着记成边界（下面说为什么它冒充不了）。

> 第五十九刀把第四条里的 `try { … }` 与 `catch:` 也做掉了（`finally:` 还是边界）。所以下面
> 那两条边界用例 `bad/errorcode-try-block` 与 `bad/errorcode-catch` 已经按规矩删掉，换成了
> `bad/errorcode-finally` 与 `bad/errorcode-catch-twice` —— 这一段留着的是当时的记录。
> 那时说"要给这一块开一个落点"听着像要给方言长新形式，其实不用：那一跳就是一次性循环的
> `brk`，见第五十九刀。

**出错值那张表不是从文档那句话猜的**，是从 `Type::getErrorCodeValue()` 抄的
（jnc_ct_Value/jnc_ct_Value.h:697-708）：只有"是整数且不是 bool"那一档给 `-1`，别的一律
`getZeroValue()`。所以 bool 是 `false`、指针是 `null`、无符号整数是 `-1` 在那一格里的样子
（全 1）—— 与文档那句话对得上，可它顺手回答了文档没说的两件事（无符号怎么办、枚举怎么办）。
枚举在那张 flagTable 里带 `Integer` 位（jnc_api/jnc_Type.cpp:107-111），所以它也是 `-1`。

**哪些类型当得了错误码**同样是抄的：`isErrorCodeType`（jnc_ct_TypeMgr/jnc_ct_Type.h:635-639）
问那张表里的 `ErrorCode` 位。`void` 那一行整个是 0，`float` / `double` 那两行只有
`Fp|Nullable|Numeric` —— 于是 `void errorcode f()` 与 `double errorcode f()` 在 jancy 那边就是
一条硬错：「'%s' cannot be used as error code」（jnc_ct_TypeMgr/jnc_ct_FunctionType.cpp:180-181）。
这一层照抄这条**错**（`bad/errorcode-void`），而 jancy 认、这一层还没定出出错值的那两个
（字符串、函数指针）发的是「还不收」。两种拒说的不是一件事，不许混。

**那句判断也是抄的**。`checkErrorCode`（jnc_ct_ControlFlowMgr/jnc_ct_ControlFlowMgr_Eh.cpp:248-294）
算一格**指示值**：bool 与"不是纯整数"的那些拿返回值自己当条件，纯整数先比一次 `!= -1`，
指示值为**假**时跳去抛。这一层发的是它的反面，三种形状：

```
bool      (un "!" v)
整数/枚举  (bin "==" v 出错值)
各种指针   (pisnull v)
```

指针那一支用 `pisnull` 不是省事：方言里没有指针相等（第四十六刀那处记着），跟 `null` 比只有
这一个算子。

**传播落成什么**：抬一格临时、比一下、等于出错值就 `return` 我自己的出错值。

```
(let $e0 int (call fetch (var a)))
(if (bin "==" (var $e0) (int -1)) (do (ret (int -1))))
(let x int (var $e0))
```

最后那句 `ret` 与 jancy 完全同一句：没有 catch 作用域时 `throwException()` 走的就是
`ret(currentFunctionType->getReturnType()->getErrorCodeValue())`（同一文件 :103-112）。

**难的那一格是"插在哪儿"。** jancy 是在那次调用之后**当场把基本块切开**的
（jnc_ct_OperatorMgr/jnc_ct_OperatorMgr_Call.cpp:591-592 那一句 `checkErrorCode`），它想插哪儿
插哪儿。这一层降的是**语句序列**，只有"一条语句"这个粒度。所以落法是：把那次调用抬成一格
临时，把判断那句插在**这条语句之前**（`ecOut` 那一叠，见 `stmt` / `ecScope`）。

这么做要求那次调用在这条语句里**只求一遍值、而且一定求**。于是只有这几种语句开这个落点
（`EC_HOIST`）：局部量声明、表达式语句、`return`、`if`、`switch`、`assert`。剩下的位置分两类，
都当场拒而不是悄悄发一段跑法不一样的代码：

- **循环的条件**（`while` / `do` / `for`）：每一圈都要重求一次，抬到循环之前就只检了第一圈
  （`bad/errorcode-loop`）。
- **惰性那几支**：`&&` / `||` 的右边、表达式位置上 `? :` 的两支 —— 求不求值要看别人，抬出来就
  成了"无条件先调一遍"，短路语义与求值顺序一起没了（`bad/errorcode-lazy`，落法见 `ecLazy`）。

**嵌在实参里反而是对的**，这一格值得说清：`use(fetch(i))` 里 fetch 是 use 的实参，本来就在
外层那次调用**之前**求值。抬出来之后顺序正好：

```
(let $e0 int (call fetch (var i)))
(if (bin "==" (var $e0) (int -1)) (do (ret (int -1))))
(let $e1 int (call use (var $e0)))
(if (bin "==" (var $e1) (int -1)) (do (ret (int -1))))
(ret (var $e1))
```

fetch 出错时 use 一次都不调 —— 与 jancy 同。所以"嵌套不收"那句话是错的，不该记成边界；
真正卡住的是上面那两类**惰性**位置。

**`try` 落成"什么都不插"。** 这不是偷懒：jancy 的 `endTryOperator` 把那次抛接到自己那一格 phi
上，两条边一条是正常值、一条是**那个出错值**（同一文件 :207-244）。而这一层的调用回的正好就是
那个出错值 —— 于是 `try f()` 与 `f()` 发出来的代码一模一样，差别只在"要不要接着插那两句"。
挡板是一个计数（`shield`），`try` 底下降完就减回去。

> 没跟着落的那一格：jancy 的 `throwException(value)` 会先调 `std.setError`（同一文件 :68-87），
> 于是 `try` 之后还能问 `jnc.getLastError()`。这一层没有那格线程状态，所以"错是什么"取不到，
> 只有"出没出错"。语料里 `try` 的用法几乎都是后者（`int result = try bar(); if (result < 0)`,
> exceptions.rst:81-88），所以这一格先欠着，且明写在这里。

**`? :` 当语句**跟着这一刀一起落地。语料里那 37 处的形状是 `m_state ? close() : try open();`
—— 两支都是有副作用的调用，值没人要。于是它就是一个 `if`，两支各按**语句**降，而传播那两句落在
**那一支里面**（各开一格自己的落点）。第五十四刀之后那两句错话（把 `try 表达式` 与 `? :` 当语句
说成"没有副作用"）到这儿一起消掉。

**三条为了不吞错而拒的**：

- 不写 `try` 从**不是 errorcode** 的函数里调（`bad/errorcode-noerrc`）。jancy 收这条，可它走
  运行期：`canStaticThrow()` 是「有 catch 或者自己带 ErrorCode 那一位」
  （jnc_ct_NamespaceMgr/jnc_ct_Scope.h:144-145），都不成立时跳 `getDynamicThrowBlock()`
  （Eh.cpp:98-101）由运行期展开。这一层没有运行期的展开，所以只能拒 —— 出路 jancy 自己给了：
  `int result = try bar();` 再自己判。
- errorcode 的函数**当函数指针用**（`bad/errorcode-fnptr`）。jancy 的 `errorcode` 是挂在函数
  **类型**上的一位（`FunctionTypeFlag_ErrorCode`），跟着类型走；这一层的 `errFns` 是按**名字**
  记的，`(fnty …)` 上没有那一位 —— 从指针调就一个字都不检。
- `override` 与基类那一个在 errorcode 上必须一致。同一个道理：那一位是签名的一部分，两边不一样
  时"从基类指针调过去检不检查"就成了看运气。

`errorcode` 写在 `main` 上也拒（错传不到调用方去，`main` 是那条链的头）。

**C 双胞胎**（`/tmp/e58.c`，`cc -O0 -std=c99 -Wall`）就是把那层糖手写开的样子：每次调用抬一格
临时、比一下、等于出错值就 `return` 自己的出错值；`try` 那几处就是"不比"。`bool` 写成 `int`
（0/1），无符号那一格的出错值写成 `(unsigned int)-1`。五条腿逐字节相同，且与双胞胎逐字节相同：

```
fetch 1 / fetch 2 / 30 / fetch 1 / -1 / …（42 行，见 cases/55-errorcode.expected）
```

用例里还锁了一格**两刀的交界**：errorcode 的**虚方法**。按标签分派的那一段（第五十七刀的
`dispatch`）只是转手调实现，出错值原样回来；检查那两句插在"调分派那一段的地方"。所以两刀不用
互相知道 —— 唯一要接的一条是 `override` 与基类那一个在 errorcode 上必须一致。

**量出来的**（662 份真实 `.jnc`，尺子与前几刀同一把：`sx` 里那句「还不收」的 (文件, 卡点) 去重
对数）：**1500 → 1402**。走掉 220 条，冒出来 122 条。

走掉的那 220 条正是这一格的全部：`修饰符 'errorcode'` 98、`这条表达式语句` 73、`语句 'label'`
32、`表达式 'try-expr'` 11、`语句 'try'` 6。挑这一刀时算的那个 187 条的口袋，实际比预估还大 ——
因为 `errorcode` 一被 `specs` 拒掉，整条函数声明就地返回，**函数体根本没降**；那 73 条
「这条表达式语句」有很大一部分是同一批文件里 `? :` 与 `try 调用` 的位置。

**冒出来的 122 条要分两半看**，这一条是尺子的老毛病，得写明：

- 真正是这一族剩下的：`catch:` 57、`try { … }` 块 6、`finally:` 4，加"传播插不进去"的那两类
  约 20 条（`connect` 8、`capture` 6、`open` 3…都是 `&&` 右边或循环条件里的 errorcode 调用），
  加"从不是 errorcode 的函数里不写 try 调" 5 条。
- 与这一刀无关、只是**被露出来**的：格式化字面量 4、64 位无符号 4、形参默认值 2…… 它们本来就在
  那些函数体里，只是以前 `errorcode` 那一拒把整个体挡在了后面。所以 `catch:` 从 32 条
  「语句 'label'」变成 57+4 条并不是"退步"：以前一个文件里带 `catch:` 的那些函数**压根没降到
  那一步**。

**能整份跑起来的**（零卡点 + 有 `int main`）：57 → **58**，新进来的是
`test/jnc/test01.jnc`（它自己的注释说是 mcjit 的行号信息用例，内容正好是"类里一个
`bool errorcode` 方法 + main 里连着 `try c.foo(&point);` 六次"，跑出来是 `hello world!` 加六行
`foo ()`）。**只剩一个卡点的**（同样限定带 `int main`）：44 → **48**。那 48 份里排头的还是
`顶层的 'import'` 14 份。

这一族的下一格因此是量出来的、不是猜的：`catch:` / `finally:` 61 条，是"给一个作用域开一个
出错就跳过去的落点"那一格；`try { … }` 块 6 条与它同一格。

**跑过的轴**：`tests/jnc`（113/0，新增 `cases/55-errorcode` 与 `bad/errorcode-lazy`、
`bad/errorcode-loop`、`bad/errorcode-noerrc`、`bad/errorcode-try-block`、`bad/errorcode-catch`、
`bad/errorcode-fnptr`、`bad/errorcode-void`；删掉 `bad/errorcode` —— 功能落地了，按规矩换成上面
那七条更窄的）。
**没跑的**：`tests/glr`（语法一个字没改 —— `try` / `catch` / `finally` 那几条产生式第一刀就在了，
这一刀只动降级）；`tests/sexpr`、`tests/asy`、`tests/oir` —— 方言、HIR、MIR、四个后端与运行时
一个字都没改；自举、`tests/jit`、`tests/llvm`；`tests/mir` 是先前就红的那一条
（`fmtFixed`/`fmtSci`/`fmtGen` 不在 `frontend-js/link.js` 的 `NATIVE_OPS` 里，与这一刀无关）；
`npm run lint` 这台机器上没有 typescript。

### 第五十九刀：`try { … }` 与 `catch:` —— 出错那一跳，方言里早就有了

第五十八刀留下的那一格是「给一个作用域开一个出错就跳过去的落点」。当时写的是"要那个落点"，
听起来像要给方言长新东西 —— 其实不用：**一次性循环加一句 `brk`** 就是"跳到这一格作用域的
出口"，而那一圈第四十二刀（带步进的 for 里的 `continue`）就已经在用了。这一刀因此又是纯前端。

`try { … }` 落成：

```
(while (bool true)
  (do
    …块里的语句…      ; errorcode 出错 -> (brk N)
    (brk)))           ; 正常走到底也出来
```

这就是文档那三行的意思（exceptions.rst:53-57）：出错时块里剩下的语句**一句都不跑**，然后从块
后面接着走。第五十八刀记边界时说过"拿 `shield` 冒充它是错的" —— 正是因为 `shield` 只把传播
关掉，`baz(21)` 照旧会跑。

它还有一条容易漏的性质：**不要求外面这个函数是 errorcode**。jancy 的 `canStaticThrow()` 是
「`canCatch()` 或者自己带 `ErrorCode`」（jnc_ct_NamespaceMgr/jnc_ct_Scope.h:144-145），`try` 块
自己就提供了前一半。所以 `void` 的函数里也能写 —— 用例里 `tryBlock` 就是 `void`。

`catch:` 落成同一圈循环，外加**一格 bool**：

```
(let $c0 bool (bool false))
(while (bool true)
  (do
    …前一段…          ; 出错 -> (do (set $c0 (bool true)) (brk N))
    (brk)))           ; 正常走到底：标志还是 false
(if (var $c0)
  (do …后一段…))
```

那格 bool 是这一层与 jancy 的**唯一结构差别**，值得说清：jancy 有两个块可跳 —— 正常流跳
`catch_follow`、出错跳 `m_catchBlock`（jnc_ct_ControlFlowMgr/jnc_ct_ControlFlowMgr_Eh.cpp:330-345）；
方言里一圈循环只有一个出口，所以"从哪条路出来的"这件事记在一格标志上。

两段各是自己的作用域，与 jancy 同（`catchLabel` 先 `closeScope()` 再
`openScope(pos, ScopeFlag_Catch)`，同一文件 :329-348）—— 前一段声明的名字在处理里看不见。
方言这边它**自然成立**：前一段的 `(let …)` 就在那圈循环的 `(do …)` 里。

处理那一段在**守护之外**，所以它自己再调 errorcode 是往调用方传（jancy 同：`findCatchScope`
从当前作用域往上走）。用例里 `rethrow(-6)` 印 `rethrow catch` 之后那次 `fetch(-1)` 就传出去了。

`catch:` 不是一条能单独降的语句 —— 它把一个块的语句序列**切成两段**，所以拦它的地方是
`block()`，不是 `stmt()`。于是"一个块里两个 `catch:`"这条自然分开了：第二个落到普通语句那条
路上，在那儿照抄 jancy 的拒（「'catch' is already defined」，同一文件 :322-325）。

中间隔着几层真循环都不用这一刀操心：那一跳的层号照第四十刀那条算法算（到栈顶的距离），
`this.loops` 里那一格 `oneshot` 自然被数进去。用例里 `loopy` 的 for 体里那次出错发的是
`(brk 2)` —— 出 for 的 while，再出守护那一圈。

jancy 还有一条这一层**不用实现也自然对**的：函数作用域上 `catch:` 之前那段必须 return
（`checkReturn()`，同一文件 :311-314）。真 return 了，那圈循环末尾的 `(brk)` 就是不可达的死
代码；没 return（`void` 函数）也对 —— 标志是 false，处理那段跳过去。

`finally:` **没有**跟着落地，它差的不是"跳哪儿"而是"跳几次"：不管走哪条路出这个作用域都要跑一
遍，连 `return` 也得先绕过去。jancy 为它专门开了一格路由变量（`m_finallyRouteIdxVariable`，
同一文件 :41-50）；这一层的 `return` 现在是直接发出去的 `(ret …)`，要 `finally` 得先把"函数里
所有 return 都改成先跳到出口"做掉。语料里它只有 4 处，所以留成边界（`bad/errorcode-finally`）。

**C 双胞胎**（`/tmp/e59.c`，`cc -O0 -std=c99 -Wall`）把那一跳写成 `goto`（C 里就是它；方言没有
goto，所以用一圈循环），`catch:` 那一格标志照写。五条腿逐字节相同，且与双胞胎逐字节相同
（42 行，见 `cases/56-catch.expected`）。

**量出来的**（662 份真实 `.jnc`，同一把尺子）：**1402 → 1334**。走掉 79 条，冒出来 11 条。

走掉的那 79 条里真正是这一刀做掉的：`catch:` 57、`try { … }` 块 6。剩下 16 条与冒出来的 11 条
基本是**同一批话换了措辞** —— `finally:` 那句诊断这一刀重写了（从"要给这个作用域开一个落点"
改成"不管走哪条路都要跑一遍，连 `return` 也得先绕过去"），`不写 try 调 errorcode 的 …` 那句也
多了半句（"外面也没有 `try { … }` / `catch:`"）。尺子按 (文件, 卡点文本) 去重，所以改一句话会
同时进"走掉"和"冒出来"两栏；净下来只有 2 条是真的被露出来的（`disposable` 1、
`main 里 return 非 0` 1）。

`finally:` 从 4 条变成 6 条也是这个原因加一点：`catch:` 收了之后，两份原先卡在 `catch:` 后面的
函数体降到了 `finally:` 那一句上。

**能整份跑起来的**（零卡点 + 有 `int main`）：58 → **60**。可这一格得说实话，尺子只数「还不收」、
不数 error，所以两份里只有一份真跑得起来：

- `test/jnc/test137.jnc` **真跑**（退出码 0，没有输出）—— 它整份就是一个嵌套作用域里的空
  `catch:`，正好是这一刀那一格。
- `test/jnc/test47.jnc` **跑不起来**：它卡在几条 error 上（`jnc.RegexState` 是标准库的正则类型、
  `const char text[] = "…"` 要从字符串字面量数出数组长度）。这是第五十七刀记过的同一个盲点
  （那次是 test18.jnc）。

**只剩一个卡点的**（同样限定带 `int main`）：48 → **50**，排头的还是 `顶层的 'import'` 14 份。

至此 errorcode 那一族只剩三格：`finally:` 6、传播插不进去的那两类位置约 20、errorcode 函数当
函数指针用。整张排行榜的头三名已经与异常无关了：`import` 346、64 位无符号 116、
`opaque class` 74。

**跑过的轴**：`tests/jnc`（114/0，新增 `cases/56-catch` 与 `bad/errorcode-finally`、
`bad/errorcode-catch-twice`；删掉 `bad/errorcode-try-block` 与 `bad/errorcode-catch` ——
功能落地了，按规矩换成那两条更窄的）。
**没跑的**：`tests/glr`（语法一个字没改）；`tests/sexpr`、`tests/asy`、`tests/oir` —— 方言、
HIR、MIR、四个后端与运行时一个字都没改（这一刀连方言的形式都没多用一个：`while` / `brk` /
`set` 都是现成的）；自举、`tests/jit`、`tests/llvm`；`tests/mir` 是先前就红的那一条；
`npm run lint` 这台机器上没有 typescript。

### 第六十刀：`import "x.jnc"` —— 不是 #include，是"这些条目也算我的"

排行榜的头一名，346 对。做它的第一件事是把它**不是什么**先说清楚。

`import` 不是 C 的 `#include`。`#include` 是在那一行上把另一份文本铺进来，所以顺序有意义、
重复有意义、写在什么作用域里有意义。jancy 的 `import` 一行一个字都不铺：`ImportMgr::addImport`
只是往一张待办表里 `insertTail` 一笔（jnc_ct_ImportMgr.cpp:70-75），等**当前这个文件整个解完**
之后 `Module::parseImports` 才去解那些文件（jnc_ct_Module.cpp:407-434），而解出来的东西进的是
**同一个模块的全局命名空间**。

所以它的语义是一句很短的话：**那份源码的顶层条目也算这个模块的**。没有作用域、没有可见性、
没有顺序 —— 与第十一刀那句"jancy 的命名空间成员不看声明顺序"是同一件事，只是跨了文件。

这句话一挑明，落法就只有一行的分量。降级这一侧本来就有一遍"把顶层摊平"（`nsFlat`，第五十一刀
为 `namespace` 加的），摊出来是一串 `{ns, it}`，后面那七八遍（类型名 → typedef → 类型体 →
`classLayout` → 签名 → `vtCheck` → 静态构造闸门 → 模块级变量 → 函数体）全都在这一串上走。
于是 `import` 要做的就是：**把被 import 的文件的顶层条目续到同一串后面**，续在那七八遍之前。

```js
  run(tree) {
    const items = this.nsFlat(tree, '', []);
    this.impDrain(items);          // 第六十刀：被 import 的条目在这儿续上
    for (const e of items) { … }   // 下面这些遍一个字没改
```

`impDrain` 抄的是 `parseImports` 的 worklist 形状 —— 把攒下的那一批整批取走、逐个解，解出来的
文件里又会攒下新的一批，循环到空。传递依赖因此自然成立；**环**也自然收掉，收掉靠的是那张按
规范化路径查重的表（`m_importFilePathMap` 的 `FindResult_AlreadyImported`，
jnc_ct_ImportMgr.cpp:126-128）。`cases/imports/` 底下那两份互相 import，量的就是这一格。

摊出来的条目一律挂在 `ns ''` 上。这一条不是省事：被 import 的文件是**另一个 unit**，从全局
命名空间开始解（`parseLazyImport` 里那句 `openNamespaceIf(getGlobalNamespace())`，
jnc_ct_ImportMgr.cpp:162），所以 `namespace inner { import "x.jnc"; }` 里那些名字落的还是
全局。`cases/57-import.jnc` 里 `other_twice` 就是这么进来的，main 不带 `inner.` 也查得着。

**找法**照 `findImportFile` 那三句（jnc_ct_ImportMgr.cpp:110-119）：绝对路径就看它在不在；
否则在 `unit->getDir()` 里找 —— **写这条 import 的那个文件自己的目录**，不是入口文件的目录。
这一格差别是能量出来的：`cases/imports/lib60.jnc` 写的是 `import "dep60.jnc"`，而
`cases/dep60.jnc` 并不存在。`io::findFilePath` 后面还有一份 `m_importDirList`（`-I` 给的），
这一层是空的：我们的命令行没有那个开关。所以这不是另一套规矩，是 jancy 规矩的一个**子集**。

文件系统那两下（在不在、读进来）不进降级这一层。`lowerJnc` 收两个回调：
`find(spec, from) -> 规范化路径 | null` 与 `parse(path) -> 语法树`，都由 cli.js 给。规范化那一下
（`resolve`）对着 jancy 的 `io::getFullFilePath`（jnc_ct_Module.cpp:386）—— 查重认的是这一格，
所以 `"imports/dep60.jnc"` 与 `"./imports/dep60.jnc"` 是同一个文件。入口文件自己**也在那张表里**
（jancy 那边是 `m_filePathSet`，jnc_ct_Module.cpp:390-392），所以 import 到自己身上是句空话。

**"两个 `main`" 是白捡的。** import 进来的条目与本地的条目平权，所以第十五刀那道"入口只能有
一个"的闸门（`mainSeen`）一个字不用改就管到了跨文件 —— `bad/import-main-twice.jnc` 量的是这个。

**两格边界，性质不一样，别混：**

- `.jncx` 是**永久**的。那不是源码，是 C++ 写的扩展库编出来的动态库（`isExtensionLib` 那一支
  走 `loadDynamicLib`，jnc_ct_ImportMgr.cpp:41-49）。整棵参考树里一个 `.jncx` 文件都没有 ——
  它们是构建产物。没有源码可降，这一格做不出来也不该做。
- **找不着的 `.jnc`** 记成"还不收"而不是硬错。jancy 那边它是硬错（`"import '%s' not found"`，
  jnc_ct_ImportMgr.cpp:122），但在这儿找不着的原因很可能是**我们少了它的 `-I`**——
  那不是这份源码写错了。这一句是量过的：346 份被 import 拦住的文件里，所有解不开的 `.jnc`
  写法（183 个不同的 spec）**在参考树里全都找得着**，只是不在写 import 那个文件的旁边 ——
  一个都不是拼错的名字。而且 jancy 找 `.jnc` 时**先翻扩展库里嵌着的那份源码表**
  （`findSourceFileContents`，jnc_ct_ImportMgr.cpp:52-60）：标准库那些名字它压根没去过文件
  系统。要接上那一半就是"接 jancy 的标准库"，那是另一件事、另一刀。
  记成"还不收"，语料尺子于是照旧诚实：这些文件仍然算在"还有拦路的"里。

**顺手修掉一个真 bug。** `jncText` 原来在词法与解析之后各调一次 `diags.throwIfErrors()` ——
那一句问的是"**到现在为止**有错没有"。一趟只解一个文件时这没问题；一趟解好几个文件时它就成了
个绞索：第一个解不开的 import 记下一条"还不收"之后，下一个文件的解析一进来就抛，整份源码的
其余拦路项全部报不出来。`io_ChildProcess.jnc` 就是这样从 8 条变成 1 条的。改成"只在**这个
文件自己**新添了错时才抛"（比 `errorCount()` 的前后差），见 cli.js 的 `jncParse`。
这一条不改，下面那把尺子量出来的每个数都是假的。

**尺子（662 份，与前几刀同一副方子；归属一律记到被扫的那个文件上）**：

- 对子 1334 → **2455**。这个数**变大是对的**，而且它的两半来源不一样：一是理由里现在带着
  spec 的名字（`import "std_Buffer.jnc"` 是一条、`import "io_base.jncx"` 是另一条），原来
  一格 `顶层的 'import'`（346 份）裂成了 183 格；二是**被 import 的文件的拦路项现在也算进来
  了** —— 非 import 的对子 988 → **1157**，多出来的 169 对就是原来被那一句 import 挡在后面
  看不见的东西。这一刀的价值主要在这 169 对上：它把一格粗糙的"有 import"换成了一份具体的账。
- import 那一族还拦着 **306** 份（原来 346）—— **40 份**文件的 import 全解开了。剩下的按性质
  分成 157 对 `.jncx`（永久）与 1141 对"旁边找不着"（缺 `-I` / 缺标准库）。
- **真降得下来的（`sx` 退出码 0）：29 份，一份没多。** 那 40 份 import 解开了的文件全都还有
  别的拦路项（`opaque class`、`property`、64 位无符号……）。这一刀在语料上的当期收益是**零**；
  它是别的刀的**前提**，不是它自己的战果。这句话说白了记在这儿，不粉饰。
- **顺带把尺子的盲点量清了**：117 份"零 nope"的文件里只有 **29** 份真降得下来，另外 88 份卡在
  **err** 上（`jnc.RegexState`、`rand`、`print` 这类标准库绑定，与 import 无关 —— 抽查过四份）。
  所以第五十七到五十九刀报的"零 nope 且带 `int main` = 57 / 58 / 60"是**高估**的：那把尺子只
  数"还不收"，不数 err。按"真降得下来"算，那个数一直是 **29**。往后这一格都按后者报。
- 下一刀的候选（非 import，按对子数）：64 位无符号 **144**、`opaque class` **85**、
  `reactor` **62**、`using-extension` **40**、"不是直接调一个名字的调用" **39**、
  `property` **33**、顶层函数原型 **29**、`attributed` **25**、结构体的基类 **23**、
  `readonly` **23**、`bindable` **22**、`pragma` **21**、形参默认值 **21**、字段默认值 **21**。

**跑过的轴**：`tests/jnc`（118/0，新增 `cases/57-import` 与 `cases/imports/` 底下那三份被
import 的源码，加 `bad/import-missing`、`bad/import-jncx`、`bad/import-main-twice`）；
`tests/sexpr`（75/0）与 `tests/glr`（20/0）—— 这两条跑是因为 cli.js 动了（`jncParse` 的抛法
与那两个回调），要确认没蹭到别的前端。
**没跑的**：`tests/asy`、`tests/oir` —— 方言、HIR、MIR、四个后端与运行时一个字都没改（这一刀
连方言的形式都没多用一个：摊平的是**语法树**，发出来的方言与手写在一个文件里的一模一样）；
自举、`tests/jit`、`tests/llvm`；`tests/mir` 是先前就红的那一条（`fmtFixed` / `fmtSci` /
`fmtGen` 不在 `NATIVE_OPS` 里）；`npm run lint` 这台机器上没有 typescript。

### 第六十一刀：无符号的 64 位 —— 符号性挂在**算子**上，不挂在类型上

`unsigned char` / `unsigned short` / `unsigned int` 第三十三刀就接了，`unsigned long` 却一直
是一条边界（`bad/unsigned-long.jnc`）。差别不在"再加一格类型"，在**有没有更宽的一格可以借**：
窄的那三格回卷成 `x & M` 之后，那个数在有符号 64 位里是非负的，于是有符号的除法、右移、比大小
算出来全对 —— 一个字都不用发。64 位没有更宽的一格，`0xFFFFFFFFFFFFFFFF` 在有符号里就是 -1，
`/` `%` `>>` 与四个大小比较**必须换成另一条指令**。这一刀就是给方言长出那一半。

**决定：一格有符号 64 位整数，符号性挂在算子上。** 不新开一格 `uint` 类型。这不是省事，是照着
下游的形状来的：LLVM 的 `i64` 自己不带符号性，分岔在 `udiv` / `sdiv`、`icmp ult` / `icmp slt`
上；SPIR-V 同样是 `OpUDiv` / `OpSDiv`、`OpULessThan` / `OpSLessThan`。方言里本来就有一处这么做
的先例 —— `(sbase E 进制)` 把实参当**无符号 64 位**读，那是第七刀 `%x` 留下的。于是长出来的是
七个算子加一条转换，没有一格新类型：

- `u/` `u%` `u>>` —— 无符号除、取余、逻辑右移；
- `u<` `u<=` `u>` `u>=` —— 四个无符号大小比较；
- `(torealu E)` —— 把那 64 位当无符号读再转 real。

**没换的一个都不换。** `+ - * & | ^ <<` 在补码下两种解释的位一模一样，`== !=` 比的也是位。
这句话是这一刀能这么小的全部原因：五条腿上每一格的实现都是"映到一条**本来就有**的指令"，
JS 那侧是 `BigInt.asUintN(64, x)`，C 那侧是 `(uint64_t)` 强转，LLVM 那侧是换个谓词，
MIR 解释器那侧是同一个 `U()`。

**一条被否掉的设计。** u64 → double 本来想用 `sel` 在方言里展开：
`E >= 0 ? (double)E : (double)((E u>> 1) | (E & 1)) * 2`。它是对的，但 `E` 在里面出现**四次**
—— 带副作用的操作数会跑四遍。方言因此长了 `torealu` / `CVT_U2F`（LLVM `uitofp`、
SPIR-V `OpConvertUToF`、JS `Number(BigInt.asUintN(64, v))`），一条指令，一次求值。
"jancy 支持不可向方言妥协"这句话在这儿的具体含义就是：宁可给方言加一条指令，
也不给一个正确答案配一份会重复求值的展开。

**MIR 的 opcode 是表的下标**，所以七个新 op 一律**接在表尾**，不插在 `DIV` / `LT` 旁边 ——
插进去等于把它后面每一个 op 的编号都改了。接在尾巴上有个要看住的地方：`negCmp` 靠"偶数 +1、
奇数 -1"取反比较（LuaJIT `lj_ir.h:154..158` 那招），所以 `ULT` 必须落在偶数号上。它落在哪儿
由表尾的位置定，于是那儿加了一句断言，别让以后加 op 的人踩着。顺带说一句：`negCmp`
在这一刀之前**从来没有被调用过**。

**踩到的坑：「是不是比较」从一条区间判断变成了两条。** 比较的 `t` 字段放的是**操作数**类型，
产出永远是 bool，读结果类型要走 `typeOf`。它里面写的是 `op >= OP.EQ && op <= OP.GT` ——
无符号那四个接在表尾，落在这个区间**外面**，于是每个 `if (a u> b)` 都被 verifier 判成
「条件的类型是 i64，不是 bool」，`interp --mir` 与 `run-llvm` 两条腿当场红。这类判断在树里有
三处（`mir/ir.js` 的 `typeOf`、`backend-llvm` 的 `resultTy`、`backend-spirv` 的 `tyOf`），
所以收成了一个导出的 `isCmp(op)`，三处都改成调它，`negCmp` 也一起。漏掉一段的代价不是"少一个
功能"，是"另一条腿上整份 MIR 不合法"，所以这一问只该有一处答案。

**字面量那一格与 C 不同。** 比 `INT64_MAX` 大的整数字面量在这一层是 `unsigned long`。C 那边
不带后缀的十进制只走有符号那条链（`18446744073709551615` 在 C99 里"没有类型装得下"），
jancy 走的是 `setConstInt64_u`（`jnc_ct_Expr.llk:856`），它挑类型用的 `getInt64TypeKind_u`
最后一格正是 `integer <= INT64_MAX ? TypeKind_Int64 : TypeKind_Int64_u`
（`jnc_ct_Type.cpp:64`）。所以 `uint64_t a = 18446744073709551615;` 不用后缀也是对的 ——
原来这一行报"超出 long 能装的范围"，是这一刀顺手补的一格。位上存的还是那 64 位
（`asIntN` 折一下），无符号性挂在类型上。

**第二个真 bug：复合赋值也得挑 u 版。** 第一版只在二元表达式那一处挑算子，于是
`q /= three` 发的是有符号除法 —— `-1 / 3` 给 0。孪生 C 那份的 `j=` 与 `p=` 两行就是这么抓出来
的（先有期望值，再对答案，不是反过来）。修法不是在第二处再写一遍同样的条件，是把它收进
`uOp(op, rt)`，两处都调它：**算子选择只能有一个地方**。

**这一刀划下的新边界（换掉被它做掉的那条）。** `bad/unsigned-long.jnc` 连同 `.expected` 删掉了
—— 按纪律，一条边界因为功能落地而通过时要删掉重划一条更窄的。新的那条不在 `tests/jnc` 里，
在 `tests/gpu/bad/uintdiv.sx`：**`u/` 与 `u%` 在 SPIR-V 那条腿上明确拒**。SPIR-V 里明明有
`OpUDiv` / `OpUMod`，但 CPU 那几条腿除零时要报错（`omni_udiv` / `$udiv`），设备上没有"报错"
这条路径，发出去就是在两条腿之间开一个静默的分叉 —— 与有符号 `/` `%` 同一个理由。分成两条
用例而不是合成一条，因为**理由不完全一样**：有符号那条还多一格 `INT64_MIN / -1`，无符号没有
那个不对称，只剩除零。理由不同的边界不合并。剩下那五个（`u>>` 与四个比较）在设备上都有现成的
一条指令，照发。

**期望输出的出处。** `cases/58-uint64.jnc` 的 17 行输出全部来自一份 `cc -O0 -std=c99 -Wall`
的孪生程序，前缀 `a=` … `q=` 逐行对应。与那份 C 的两处写法差别都不是语义差别：C 那边 64 位实参
要 `%llu` / `%lld` 的长度修饰（这一层的 `%u` / `%d` 位数从**类型**上取），以及上面说的字面量
后缀。用例里刻意留了几行"不接就给错答案"的：`a=` / `i=`（`-1 / 3` 有符号 0、无符号
6148914691236517205）、`b=`（同一串位上算术右移 -1 对逻辑右移）、`c=` 对 `d=`（同一对操作数、
同一个 `>`、两个答案）、`e=` / `q=`（不走 `torealu` 就印 -1）、`j=` / `p=`（复合赋值）、
`o=`（`long s = -1; s < three` 走常用算术转换之后是**假**）、`h=`（32 位无符号提到 64 位
**不带符号扩展**）。五条腿逐字节相同，且等于那份 C。

**尺子（662 份，与前几刀同一副方子；归属一律记到被扫的那个文件上）**：

- 对子 2455 → **2390**。import 那一族一个字没动，所以变化全在非 import 那一半：
  1157 → **1092**。「64 位的无符号整数」那一格 **144 对全消了**，同时露出 **79 对**原来被它
  挡在后面看不见的东西 —— 净减 65。这与第六十刀是同一个现象：拦路项被拆掉之后，尺子看见的
  是更靠后的那些格，数字变小得比"消掉多少"慢。
- 还剩 7 对里带着 `unsigned long` 的字，但它们**不是这一格**：4 对「把 void\* 转成
  unsigned long\*」、3 对「把 void thin\* 转成 unsigned long thin\*」，是指针转换那一族，
  上一刀根本走不到那儿。算术与类型那一格是干净的 0。
- 零 nope 的文件 117 → **123**。**真降得下来的（`sx` 退出码 0）：29 → 30**。多的那一份是
  `test31.jnc`（第六十刀记着的两份 uint64 独占拦路项之一）。另一份 `test95.jnc` 的 nope 也清了，
  但它卡在 err 上 —— `没有这个函数：'print'`，标准库绑定，与这一刀无关。**+1，不是 +2，说清楚。**
- 只剩一条拦路项且带 `int main` 的（43 份，按拦路项）：`$"…"` **4**、`bigendian` **3**、
  main 返回非 0 值 **3**、`destruct` **3**、"不是直接调一个名字的调用" **2**、`opaque class` **2**。
- 下一刀的候选（非 import，按对子数）：`opaque class` **85**、`reactor` **62**、
  「枚举成员的值算不出来」**56**、`using-extension` **40**、"不是直接调一个名字的调用" **39**。
  「64 位无符号」原来在这张表的第一名，现在不在表上了。

**跑过的轴**：`tests/jnc`（118/0 —— 删掉 `bad/unsigned-long` 那一条、加上 `cases/58-uint64`，
一进一出所以总数不变）；`tests/sexpr`（75/0）与 `tests/oir`（451/0）—— 方言长了七个算子加
`torealu`，这两条是它的本轴；`tests/llvm`（22/0）与 `tests/gpu`（17/0，1 skip：这台机器的
Apple M1 给 `shaderFloat64=0`）—— 这两条跑是因为两个后端的"是不是比较"那一句改成了 `isCmp`，
以及新加的 `bad/uintdiv`。
**没跑的**：`tests/asy`（这一刀与 asy 前端无关）；自举、`tests/jit`；`tests/mir` 是先前就红的
那一条（`fmtFixed` / `fmtSci` / `fmtGen` 不在 `NATIVE_OPS` 里，与这一刀无关）；
`npm run lint` 这台机器上没有 typescript。

### 第六十二刀：`-I` —— 把第六十刀记下的那条边界当账单来还

第六十刀把 `import` 做成了"这些条目也算我的"，但只在**写 import 那个文件的旁边**找，并且把
"找不着"记成了一条边界，理由写得很清楚：183 个解不开的 spec 在参考树里**全都找得着**，只是不在
旁边 —— 少的就是 `-I`。这一刀把它还了。

**找法照 jancy 一字不差**（`jnc_ct_ImportMgr.cpp:110-119` ->
`axl_io_FilePathUtils.cpp:419-449`）：

1. spec 是绝对路径 -> 只看它在不在，别处不找；
2. 否则先在**写这条 import 的那个文件自己的目录**里找（`firstDir`，第 428 行）；
3. 再按 `-I` 给的**顺序**逐个试（`dirList`，第 438-446 行）；
4. **进程的当前目录不算一格** —— ImportMgr 传进去的 `doFindInCurrentDir` 是 `false`。

第 4 条是这四条里唯一容易写错的：`findFilePath` 里确实有"看当前目录"那一格，但 jancy 调它时
关掉了。抄了那一格就会出现"从哪个目录敲命令决定编不编得过"这种事。

改动小得不像一刀：`cli.js` 多一个 `incDirs(argv)`、`find` 回调里多一个循环。真正花时间的是
**测得住它**。三条规则（旁边优先于 `-I`、`-I` 之间按给的顺序、目录表不是"只试第一个"）光看代码
是看不出对错的，所以 `cases/59-incdir.jnc` 给每条规则各配一份**同名的输家**：`near62.jnc` 在
旁边和第一个 `-I` 目录里各有一份（返回 1 与 9）、`order62.jnc` 在两个 `-I` 目录里各有一份
（2 与 8）、`onlyc62.jnc` 只在第二个里（3）。三个数各占一位，`chain62()` 印 `123`；错哪条规则
就哪一位变。这也是 `tests/jnc` 第一次需要**给某一条 case 传命令行参数** —— 加了一格
`NN.args`（`cases/59-incdir.args` 里就两个 `-I`），因为这个开关在命令行上，源码里没有它的位置。

**尺子（662 份；ioninja 那一支按它自己 CMakeLists.txt:815 的 `-c --ignore-opaque -I ../api
-I ../common -I ../protocols` 加 CMakeLists.txt:20-23 的 `-I ../../plugins` 来扫，其余几支的
CMakeLists 里一个 `-I` 都没有，照旧不给）**：

- 对子 2390 → **2103**。两半反着走：import 那一族 1298 → **570**（−728），非 import 那一半
  1092 → **1533**（+441）。多出来那 441 对不是退步，是**账单**：被 import 进来的 api / common
  文件里的拦路项，原来根本没机会被看见。第六十刀说过它是"别的刀的前提"，这就是那句话的兑现。
- 零 nope 的文件 123 → **140**（+17）。**真降得下来的：30 → 30，一份没多。**又是零收益 ——
  这一刀和第六十刀一样是前提而不是战果，说白了记在这儿。
- 那 17 份为什么还是降不下来：它们现在死在**语法**上，不是"还不收"。头一条是
  `api/ui_Layout.jnc:69` 的 `basetype.construct(Direction.LeftToRight)` —— **后面没有分号**。
  这不是语料写错了：jancy 的 `btm_construct_stmt`（`jnc_ct_Stmt.llk:51-61`）两条产生式的尾巴上
  都**没有** `';'`，也就是说构造函数体里那句 `X.construct(...)` 本来就是免分号的。我们的语法
  要求分号。下一刀就是它。

  > 试过一次最便宜的形状了，**不成**：给 `stmt` 直接加一条
  > `(expr "." "construct" "(" opt-args ")")`（不带分号）。两处都塌：
  > 一是**带**分号的那种写法立刻变成歧义（新那条吃到 `)`，剩下的 `;` 再当一条空语句 ——
  > 与原来的 `(expr ";")` 是两棵不同的树，GLR 两条都成功）；二是动作里手搓
  > `(call (field $1 "construct") $5)` 与走 `member` 那条路建出来的节点**不是一格东西**
  > （那边的 `construct` 是个词法记号，这边是个字符串），降级当场说"'basetype' 后面那个
  > 成员认不出来"。也就是说这一刀得照 jancy 的结构来：构造函数体是**另一种**
  > `compound`（`constructor_compound_stmt`，Stmt.llk:26-43），开头那一段 btm 列表把
  > `';'` 也吃进去（Stmt.llk:48、60 那两条 `';'` 就是干这个的）。已回滚，语法树里没留东西。
- 下一刀的候选（按对子数，全是被这一刀照出来的）：`opaque class` **151**、字段的默认值 **105**、
  `bitflag enum` 里的负值 **94**（那一格是 C++ 的未定义行为，没有可对的答案 —— 属于"落地了也
  还是拒"）、枚举成员的值算不出来 **79**、结构体的基类 **66**、形参的默认值 **56**、
  "不是直接调一个名字的调用" **56**。
- 「枚举成员的值算不出来」这一格顺手量清了一件事：它**不是**编译期求值缺功能。
  `enum B { Y = A.X }`、`ns.Enum.Member`、`0x01 | Flags.Foldable` 现在都算得出来（当场试过）；
  那 79 对全是**引用的枚举不在场** —— `io.SerialParity` 这类名字来自扩展库。所以它不是一刀，
  是"接标准库"的一部分。

**边界一进一出。** `bad/import-missing` 的理由窄了一格（现在量的是"一个目录都没给"时那句话），
新加 `bad/import-missing-inc`：给了 `-I` 还找不着。后者的理由**不再是**"我们少了 `-I`" ——
是"我们没有扩展库里嵌着的那份源码表"（`findSourceFileContents`,
`jnc_ct_ImportMgr.cpp:52-60`；jancy 翻文件系统**之前**先翻它）。拒的那句话里现在带着"在哪儿
找过"，不然读的人分不出是名字写错了还是目录表少了一格。

**跑过的轴**：`tests/jnc`（120/0 —— 新增 `cases/59-incdir` 与 `bad/import-missing-inc`）。
**没跑的**：`tests/sexpr`、`tests/oir`、`tests/llvm`、`tests/gpu`、`tests/glr` —— 这一刀只动
`cli.js` 的命令行与 `find` 回调、`lower.js` 里报错那句话、`tests/jnc/run.js` 的 `.args`；
方言、HIR、MIR、后端、语法表一个字都没改。自举、`tests/jit`、`tests/asy` 同理；
`tests/mir` 是先前就红的那一条；`npm run lint` 这台机器上没有 typescript。

### 第六十三刀：构造函数体里那句 `X.construct(…)` 免分号

第六十二刀最后那条记着的就是它：`-I` 接上之后，17 份新露出来的 api 文件第一个卡的地方是
`api/ui_Layout.jnc:69` 的 `basetype.construct(Direction.LeftToRight)` —— 后面**没有分号**。
这不是语料写错了。jancy 的构造函数体是**另一种** compound（`constructor_compound_stmt`，
`jnc_ct_Stmt.llk:26-43`），开头允许零个或多个 `btm_construct_stmt`，而那条规则的两条产生式

```
btm_construct_stmt
  :  TokenKind_BaseType '.' TokenKind_Construct '(' expression_or_empty_list ')'
  |  btm_construct_name '(' expression_or_empty_list ')'
  |  ';'
```

（`jnc_ct_Stmt.llk:51-61`）尾巴上都没有 `';'`。

**上一次试错记在第六十二刀那一节的 `>` 段里，这次两处都补上了。**

第一处是**节点的形状**。手搓 `(field $1 "construct")` 建出来的成员是个**字符串**，而
`callExpr` 认成员名用的是 `isAtom(callee.items[2])`（走 `member` 那条路来的是词法记号），
于是降级说"'basetype' 后面那个成员认不出来"。改成裸原子 `(field $1 construct)` 就与那条路
建出来的一模一样 —— 这也是为什么这一刀**一行降级代码都没改**：树的形状对上了，
第五十六刀写的 `basetype.construct(…)` 那段照旧接着。

第二处是**歧义**。带分号的写法有两棵树：新那条吃到 `)`、剩下的 `;` 再当一条空语句，
与原来的 `(expr ";")` 并列。GLR 驱动碰上两棵都成功的树是**报错**而不是猜（driver.js 开头那段
写得很清楚），所以要么消掉这条重叠，要么明写偏好。这里用 `(prefer -1)`：偏好沿栈累加、
在接受点定胜负，所以 `X.construct(a);` 照旧走 `(expr ";")`、`X.construct(a)` 只有一条路。
**证据不是"我试了两下"**：整份语料（662 份，ioninja 那一支带 `-I`）扫一遍，
出现"两棵树都成功"的文件数是 **0**（`/tmp/m63.sh`）。

**与 jancy 有一处明写下来的差别：这条产生式挂在 `stmt` 上，比 jancy 宽。** 它那边这一格只在
构造函数体的开头出现；这一层的函数体只有一种 `compound`，语法上分不出是不是构造函数，
要分出来得把 `special-dcl` 的体单独开一种 —— 那会把"开头那段列表"与 `unit` 的第一条语句重新
搅成歧义（上一次试错就是撞在这儿）。宽在这儿是安全的：写错地方由降级认（`construct` 得在类里
查得着），语法多认一个位置不会把别的写法读歪。这是取舍，不是漏掉。

**顺带记两条不是这一刀的账。** `m_field.construct(4)` 这种写法（jancy 的第二条产生式
`btm_construct_name`）现在**解析得动**了，但降级仍然说"没有这个函数：'m_in.construct'" ——
那一格与分号无关（带分号也是同一句），是"给字段调构造函数"还没接。`struct` 里的方法也一样，
还是老那条"结构体里的方法"。两条都当场验过带不带分号报的是同一句话。

**尺子（同一副方子，ioninja 那一支带 `-I`；`/tmp/m63r.sh`）：**

- 「真降得下来」（`sx` 退出码 0）：**30 → 30**。这一刀又是**零份**新文件。
- 对（文件，还不收的理由）：2103 → **2746**（+643）。
- 「没有还不收的行」的文件数：140 → **121**（−19）。

**那 −19 要说清楚，它不是退步。** 尺子里的 clean 一栏数的是"没有 `还不收：` 这种行"，
里头混着另一种死法：**在语法上就死了**的文件也一条 nope 都发不出来。`ui_Layout.jnc:67-70`
正是这种，第六十二刀那一趟它在 clean 里坐着（`/tmp/pairs62.txt` 里查不到它一条理由）。
这一刀让它解析得动，于是它往下走到降级，把真正的拦路虎报了出来（`'opaque class'`）。
掉出 clean 的 19 份，逐个查过 import 闭包，**19/19 都能走到 `ui_Layout.jnc`**（6 份直接
import，其余经 `ui_Widget.jnc`/`ui_Dialog.jnc` 那几层过去；`/tmp/reach63.sh`）。
换句话说：clean 这一栏一直**虚高**着 19 份，这一刀把虚的挤了出去。
这也是为什么诚实的那一格从一开始就定成"`sx` 退出码 0"，而不是"零条 nope"。

**挤出去以后，账单头上是这些**（对数，`/tmp/pairs63.txt`）：

- `opaque class` 194（第六十二刀 151）
- 字段的默认值 143（105）
- `bitflag enum` 里的负值 132（94）—— C++ 那边是未定义行为，仍旧不接
- `import "io_base.jncx"` 103 —— 编译好的扩展库，整棵参考树里没有这样的文件
- 形参的默认值 97（56）
- 枚举成员的值算不出来 92（79）—— 归"把标准库接上"那一刀
- 函数类型的 typedef 86
- 结构体里的方法 73 / `import "std_Buffer.jnc"` 73 / 结构体的基类 71（66）
- 顶层的函数原型 67 / `import "std_HashTable.jnc"` 67
- 修饰符 `readonly` 62、`cmut` 56、`event` 47、`bigendian` 41；不是直接调一个名字的调用 61

前几名普涨，涨的正是"以前看不见"的那部分 —— 与第六十二刀同一个道理：这一刀买的不是
能跑的文件，是**账单的可见度**。三份 `std_*.jnc` 排进前十五，说的是同一件事：
下一刀该去接标准库，`-I` 已经把路铺好了。


### 第六十四刀：格式化字面量 `$"…"` —— 一份实现，两个出口

第五十四刀把它记成边界时的理由是"`$(…)` 里那一格是一整条表达式，而语法把 `$"…"` 整块当一个
token"。这一刀把那笔账还了。四种注入照 literals.rst:62-88、词法 Lexer.rl:128-142、
语法 Expr.llk:965-993：

- `$id`：内嵌的一格值，**不占**实参表的位置（`site->m_index == -1`）
- `$(expr)` / `$(expr; spec)`：内嵌的一整条表达式
- `%N` / `%(N; spec)`：实参表里第 N 个（1 起）
- 光写一个 `%spec`：也占一个实参位，序号是"上一个用过的 + 1"（`site->m_index =
  ++literal->m_fmtIndex`，Parser.cpp:3496）

**没写 spec 时那个转换字母从哪儿来，是这一刀最容易写错的一格**，所以照抄出处：
Parser.cpp:3670-3691 那张表按静态类型挑 —— 整数 ≤4 字节 `d` / `u`、64 位 `lld` / `llu`、
浮点 `f`、字符串 `s`；bool 在 jancy 那边也带 Integer 标记（Eh.cpp:260 那句 "bool or not
integer" 反着说了这件事），一字节，所以是 `d`。写了 spec 但末尾不是字母时把默认那个字母接上
（prepareFormatString，CoreLib.cpp:702-723）—— 于是 `$(i; 6)` 是 `%6d`、`$(h; 08x)` 是 `%08x`。
`$d` 印 double 走的是 `%f`（六位小数），不是 `%g`：这一格如果按"把数印出来"猜，就会静默地
与 jancy 差一截。

**决策一：那一小段源码交回给同一张表解析。** jancy 是在词法层做的（`lit_fmt_opener` 之后
`fcall main`，Lexer.rl:142，于是里头就是普通 token 流）；这一层的词法是一张 DFA，没有
fcall / fret。所以改成"整块当一个 token、降级里再解析一遍"（`jncParseExpr`，cli.js）——
认的是同一门语言。裹的时候按**原文的行列**补空白（头一段占第一行，再补 line-1 个换行与
col-1 个空格），所以里头报的位置是真文件里的真位置。两处代价写下来：报错时回显的那一行是
裹出来的那段文字而不是源码那一行；字面量落在文件第一行时列会往右偏。内层不能出现 `"`
这条老限制还在 —— 它在词法那一层，不在这一层。

**决策二：一份实现，两个出口。** 转换本身（标志、宽度、精度、长度修饰、`#` 的四种含义）
从 printf 里分出来成 `fmtRun`，`'stmt'` 那条按 `\n` 切成 `print` / `write`，`'str'` 那条
整条拼成一格字符串。**没有第二份实现**：第六十一刀那次 `q /= three` 发有符号除法的教训就是
"同一个算法写在两处，其中一处写错"，这一刀不再犯。于是 `%08.3f` 在两条路上一个字节不差 ——
cases/61-fmtlit.jnc 的八行全部对着一份 `cc -O0 -std=c99 -Wall` 的 C 孪生量过。

**`printf($"…")` 这一格明说不收的那一半。** 字面量产出的是一格字符串，所以这一句就是把它
写出去（`write` 不添换行，与 printf 一致）。可要是结果里还留着**裸的 `%`**（词法上配不上
`lit_fmt_spec` / `lit_fmt_index` 的那种，比如 `100%\n` 里的那个），jancy 那边 printf 会把它
**再解释一遍**，而这一层的 printf 是编译期展开的、没有运行期的格式解释。这种时候拒
（bad/fmt-percent.jnc），不悄悄少印一个 `%` —— 一个静默错的答案从来不算边界。

老边界 bad/lit-fmt.jnc 因此删掉，重画两条更窄的：`$!`（要标准库那一格错误对象）与上面那个
裸 `%`。语料里还剩四种 fmt 相关的拦路项，一共 6 对：`$!` 3 处、混着拼的字面量 1 处、
`char*`（jancy 走 appendFmtLiteral_p 按 NUL 读一段内存，这一层的 `%s` 只认 string）1 处、
"这个位置插不进语句而又要补零"1 处。

**尺子（`/tmp/m64r.sh`，同一副方子，ioninja 带 `-I`）：**

- 「真降得下来」（`sx` 退出码 0）：**30 → 30**。**第三刀连着零份**。
- 对（文件，还不收的理由）：2746 → **2698**（−48）。
- 「没有还不收的行」的文件数：121 → **125**（+4）。

**这一刀顺手量出了尺子自己的一处盲区，值得记下来。** 挑这一刀的依据是"只剩一条拦路项的
文件"里 fmt 排第四（4 份，且都有 `main`）—— 做完之后那 4 份（test49 / test66 / test74 /
test88）确实进了 clean，可它们仍旧降不下来：卡的是**普通错**而不是"还不收"（test66 的
`没有这个类型：'S'`、test49 的 `null 得从左边知道自己是哪种指针`、test74 的 `variant_t`）。
尺子只数 `还不收：` 那种行，普通错在它眼里是隐形的，所以"只剩一条"这个指标会**高估**
一刀能买到的东西。下一刀选题得把普通错也扫进来 —— 那是尺子该长的下一格。


### 第六十五刀：库模块没有入口 —— 那是"要不要跑"的事，不是"降不降得下来"的事

上一刀记下的盲区当场就还了：尺子加上普通错重扫一遍（`/tmp/m65probe.sh`，两栏并出
`(文件, N=还不收 / E=普通错, 归一化的理由)`），第一名不是任何一条 jancy 特性，是**我们自己
立的规矩**：

- `jancy 的入口是 `int main()`，这份源码里没有` —— **408 份**（662 份里的六成），其中
  **18 份**这是它唯一的拦路项。

这条规矩是错的。语料里那 408 份是**库模块**：里头是类型、全局量与函数，本来就不该有入口。
jancy 自己分得很清 —— `jancy foo.jnc` 找不着 `main` 才报错，而把同一份源码当模块编译
（`jnc_ct` 那一层）不报。所以"要不要入口"是**调用方**的事：

- `omni sx`（只降不跑）不要入口 —— `jncText(path, dirs, needEntry = false)`。
- 五条腿（`run` / `run-c` / `interp` / `interp --mir` / `run-llvm`）照旧要，理由一字不改
  （bad/no-main.jnc 把这一半钉住）。

降出来的库模块仍旧带一格 `(main …)`：方言的整程序要它（sexpr/lower.js:779），而里头只剩
模块级变量那段序幕 —— jancy 的 `module.construct` 对库模块也是要跑的，所以这不是占位，
是真有内容的那一格。

**测试这一刀要一组新的**：`tests/jnc/mods/`。它问两件事 —— `sx` 退出码 0，以及**把降出来
的那份 `.sx` 交给 `run` 跑一遍**。第二步是刻意加的：只看"文本非空"的话，降成一堆废话也能过。

**尺子（`/tmp/m65r.sh`，同一副方子加上普通错那一栏）：**

- 「真降得下来」（`sx` 退出码 0）：**30 → 48**（+18）。**四刀以来第一次动**，而且动的正好是
  尺子指的那 18 份 —— 预测与结果对上了，这比数字本身更要紧：加了普通错那一栏之后，
  "只剩一条拦路项"这个指标才真的能用。
- (文件, 拦路项) 对：4440 → **4032**（−408，正是那条规矩自己）。

**挤掉这一条之后，账单头上换人了**（`/tmp/all65b.txt`）：

- 没有这个类型 298 / 未声明的变量 260 / 没有这个函数 209 —— 这三条**不是**三件事，是同一件：
  库模块里引用的名字来自还没接上的标准库或扩展库。
- `opaque class` 196（其中 **33 份是它唯一的拦路项** —— 这是眼下最大的一格）
- 修饰符 189、字段的默认值 143、`bitflag enum` 里的负值 134（C++ UB，仍旧不接）
- 剩下 28 份卡在**语法**上（`<` 12 份、`*` 7 份、`thin` 5 份、`:` 4 份）—— 那是语法那一层
  的账，不在降级这边。

所以下一刀是 `opaque class`：它是"最大的一格"，也是那 33 份唯一的拦路项。

> 第六十六刀更正：那 33 份里**只有 1 份**因这一刀降了下来。"唯一的拦路项"这个数在这儿
> 高估了 33 倍 —— 原因见下一节开头。


### 第六十六刀：`opaque class` —— 不是另一种类型，是类上的一位

先说尺子的教训，因为它比这一刀本身值钱。

上一刀数出"`opaque class` 是 33 份文件唯一的拦路项"，落地之后只有 **1 份**降了下来。
数错的原因是**拦路项会截断子树**：`typeDecl` 一进门就 `nope('opaque class')` 并 `return`，
类体里那些成员一个都没走到。于是那 33 份在旧尺子眼里"只剩一条"，其实是"只**看见**一条"。

> 所以这条度量得改口径：**"唯一的拦路项"只是上界**，而且对"整块拒掉"的那类拦路项
> （类型声明、函数定义、import）高估得最狠 —— 它们后面藏着一整个子树。要真数，得
> **试着把那一格摘掉再量**。这一刀就是这么量的（`/tmp/m66probe.sh`）：那 33 份摘掉
> `opaque class` 之后，新冒出来 66 个 (文件, 拦路项) 对，头几格是修饰符 14、`destruct` 13、
> 多继承 10、没有这个基类 9、指针后面的修饰符 5。

**这一刀本身只有一行半。** jancy 那边 `opaque class` 与 `class` 落在**同一个调用**上：

```
opaque_class_specifier
	:	TokenKind_OpaqueClass TokenKind_Identifier $n (':' type_name_list $b)?
			{ return ($type = createClassType(…, ClassTypeFlag_Opaque)) != NULL; }
		derivable_type_member_block<$type>
```

（`NamedTypeSpecifier.llk:199-215`；不带 opaque 的那条是同一个 `createClassType` 少那个
标记，体也是同一条 `derivable_type_member_block`。）所以"opaque"**不是另一种聚合**，
是类上的一位。这一层照着这个形状改：一个 `aggCls(k)` 谓词，三处原来写死 `=== 'class'`
的地方（`isClassAgg`、`typeName`、`typeDecl`）改成问它。

**那一位管什么、我们为什么可以先不读它。** 它只在**布局**那一步被消费
（`StructType.cpp:203-227`）：宿主登记的 `OpaqueClassTypeInfo::m_size` **顶掉**接口结构体
算出来的大小（并要求 ≥ 声明字段占的字节），宿主说 `m_isNonCreatable` 时给类补上
`ClassTypeFlag_OpaqueNonCreatable` —— 而**那个标记**才是真正挡住 `new`
（`New.cpp:580-582`"cannot instantiate"）与挡住继承（`ClassType.cpp:318-320`"cannot derive
from non-creatable opaque"）的东西。也就是说 opaque.rst:67 那句"既不能被继承也不能静态/栈上/
当字段分配"，在编译器里的实际条件是**宿主说了不可创建**，不是源码里写了 `opaque` 这个词。

关键的一句在同一处的条件里：`!(m_module->getCompileFlags() &
ModuleCompileFlag_IgnoreOpaqueClassTypeInfo)`。**没有宿主登记时，那一整段是跳过的** ——
jancy 自己的命令行就有这个开关：`--ignore-opaque`，帮助文本写着 "Ignore opaque class type
information (for testing)"（`CmdLine.h:165-169`），而 `--documentation` 不带 `--compile` 时
也会自动打开它（`CmdLine.cpp:255-257`）。我们没有宿主扩展库，所以**永远在那个模式里**：
体照常摆、方法照常降、`new` 照常收、拿它当基类照常收。这不是向方言妥协 —— 这是 jancy
在同一处境下自己的行为。

`this.opaques` 仍旧记下来了，虽然这一层不读：等宿主面真的来了，"体外还有多少字节"与
"可不可创建"两条规矩得有地方落。

**第二半：宿主那边的成员，得说清楚是"缺宿主"而不是"缺函数"。** 语料里 `opaque class` 的
真实形状是一份**只有声明**的 API 文件（`sys_Lock.jnc`、`jnc_Alias.jnc`、opaque.rst:19-29 的
`io.Serial`）：体内全是原型，实现在宿主的 C++ 里，由 `JNC_BEGIN_CLASS` 那一串宏映到函数
地址上（`abi.rst:60-70`）。原型这一层本来一个字都不发（与普通类里"体写在类外"同一条），
于是 `p.lock()` 会落到「没有这个函数：'p.lock'」—— **话说错了**：源码没写错，缺的是宿主。

两处补上（都只在**按名字查不着之后**才问，所以体外真写了定义时这两格用不上）：

- `hostFns`（方法的裸名 → 类名）：`callName` 里报「'Lock.lock' —— 它是 opaque class 上的
  方法，实现在宿主的 C/C++ 那边（opaque.rst:15-29），这一层还没有宿主面」。
- `hostCtors`（construct 在宿主那边的类名）：`newPtr` 里报同一族的话。**这一格是必须的**
  —— 不报就等于"当它没有构造"，交出去一格全零的内存，而 jancy 那边宿主的构造是真跑了的。
  悄悄少跑一段比报错难查得多。

**量出来的**（`tests/jnc` 129/0）：

- `cases/62-opaque.jnc` —— `opaque class Counter` 带字段、带类外定义的 construct 与方法，
  再让一个**非** opaque 的 `Derived` 继承它。四行输出与 `/tmp/c62.c`（`cc -O0 -std=c99
  -Wall`）逐字节相同：`15 / 12 / 101 / 202`。
- `mods/lib2.jnc` —— 语料的真形状：`namespace sys` 里两个只有声明的 opaque 类加一个继承它的
  普通类，`sx` 退出码 0，降出来的 `.sx` 跑得动。降出来的是**一格**结构体
  （`(struct sys$Lock ($tag int) (m_depth int) (m_owner int))`）：一整条继承链共用一格，
  第五十六刀的 `clsRoot` 本来就是这么设计的。
- `bad/opaque-host-fn.jnc` / `bad/opaque-host-ctor.jnc` —— 上面那两句话各钉一条。

**尺子**（`/tmp/m66r.sh`，`/tmp/all66.txt` 与 `/tmp/ok66.txt`）：

「真降得下来」（`sx` 退出码 0）：**48 → 49**（+1）。就是 `ui_Icon.jnc` 一份。
`ok65b ⊆ ok66`，一份都没退。

(文件, 拦路项) 对：4032 → **6250**（**+2218**）。这个数**涨**了两千多，而这是好事 ——
它就是"截断的子树"被打开之后露出来的东西，也是上面那条口径教训的量化版：一格拦路项
挡住的不是一条，是它后面的一整片。

`'opaque class'（只收 struct 与 class）` 196 → **3**，剩下那三条是 `union`
（`jnc_DynamicLayout.jnc`、`SerialTapPro.jnc`、`test19.jnc`）—— 那是另一格。

**露出来的那一片，按大小**（`/tmp/all66.txt`）：

- 修饰符 189 → **278**：眼下最大的一格"还不收"。`opaque class` 的体里全是
  `readonly` / `const property` / `autoget` / `bindable` 这些词。
- `destruct` 18 → **145**、形参的默认值 97 → **141**、指针后面的修饰符 6 → **101**、
  `main` 里 return 非 0 的值 17 → **75**、认不出的枚举名字 51 → **85**、
  这条声明没有类型 23 → **71**。
- **新出现的一格**：`函数 '…' 定义了两次` 13 → **113**。这个名字起错了 —— 它其实是
  **重载**。`ui_Layout.jnc:98-115` 那四个 `addRow`（`Widget*`/`Layout*` × `Widget*`/`string_t`）
  是四条不同签名的同名方法，jancy 收，我们没有重载决议，于是报成"定义了两次"。
  这是第二条"话说错了"的诊断（第一条是这一刀上半场修掉的"没有这个函数"）。
- 没有这个类型 290 / 未声明的变量 276 / 没有这个函数 248 —— 老三样，还是"标准库与扩展库
  没接上"这同一件事。

覆盖对得上：613 + 49 = 662。

所以下一刀是**修饰符**：278 对，最大的一格，而且它是 `opaque class` 体里那些成员的门槛
（`readonly`、`const property`、`autoget`、`bindable`）。它后面紧跟着的是**重载**——
那 113 条报错的真名。

### 第六十七刀：可变性那一族与访问控制的 Java 式写法 —— 四个词，零行降级

上一刀的尺子指的是"修饰符"这一格（278 对）。它**不是一件事** —— 探子把词拆开数出来
（`/tmp/m67probe.sh`，抓的是 `修饰符 '…'` 这个子串，所以**说明符位置与 `*` 后面那两个位置
是混在一起的**，见下面第三条）：

- `readonly` **155**（37 份文件里它是唯一的修饰符拦路项）
- `property` 130、`autoget` 124、`event` 82、`bindable` 80 —— 属性与事件那一整套，是自己的刀
- `cmut` **56**、`protected` **26**、`public` **1**
- `alias` 48、`async` 45、`bigendian` 41、`reactor` 22、`disposable` 6、`weak` 3、`safe` 3

这一刀只取**能证明"收下不看等于什么都没变"**的那四个：`readonly`、`cmut`、`public`、
`protected`。

**为什么这四个能并成一格。** jancy 自己把可变性那几个词放进**同一个互斥组**：

```
TypeModifierMaskKind_Const,     // TypeModifier_Const      = 0x00000004,
TypeModifierMaskKind_Const,     // TypeModifier_MaybeConst = 0x00000008,
TypeModifierMaskKind_Const,     // TypeModifier_AutoConst  = 0x00000010,
TypeModifierMaskKind_Const,     // TypeModifier_ReadOnly   = 0x00000020,
```

（`Decl.cpp:96` 那张 antiModifierTable。）`const` 这一层从一开始就是"收下、不看"，
因为这里**没有可变性检查**；`readonly` 与它同组，语义是**双重修饰符**——"自己人当它不存在，
外人当它是 const"（dual_modifiers.rst:45-68）。`cmut` 不在那张表里（它是后加的一格），
作者自己的说明是「just add `cmut` type modifier and make it behave the same as `readonly`」
（internal/Required IDE Modifications.rst:21）。

`public` / `protected` 是**同一件事的另一半**：jancy 只有这两种访问说明符，两种写法都收 ——
C++ 式的标签和"写在声明说明符里"的 Java 式（dual_modifiers.rst:22-24），而且**顶层的成员
也能写**（同处:26 那句 "Global namespace members can also have access specifiers just like
named type members"）。标签那一半第五十二刀就是跳过的（`access` 节点），这儿补上另一半。

**三个位置，不是一个。** 修饰符在这一层有三处独立的关卡：说明符表（`specs`）、`*` 后面
（`ptrsTy`）、函数指针的 `*` 后面（`fnPtrDcl`）。头一版只改了第一处，再量一遍才发现
`readonly` 还剩 64 份、`volatile` 从 1 涨到 61 —— 那是第二处，原先被第一处挡着看不见
（又是一次"截断的子树"，与上一刀同一个毛病）。`const` 在后两处本来就是收下不看的，
所以 `readonly` / `cmut` 跟着进去是同一行。**`volatile` 不进** —— 它在 jancy 那张
antiModifierTable 里是自己的一位（`PtrTypeFlag_Volatile`，jnc_Type.h:220"class & data ptr"），
不在 Const 那一组里，是自己一刀。

所以这一刀在降级那一侧**一行代码都没有** —— 只是三处 `continue` 上各多两个词。

**代价，明写。** 这四个词落地之后我们比 jancy **拒得更松**：

- `c.m_readOnly = 20`（从外面改只读字段）jancy 报 "cannot assign to const-location"
  （dual_modifiers.rst:67），我们不报。
- `protected` 的成员从外面碰，我们也不报 —— 与第五十二刀那笔账是同一笔。

这两条都不改变**能跑的程序**的行为：一份 jancy 收的源码，在这一层跑出来的字节一样。
变的只是"jancy 拒、我们收"那一类。这与"悄悄少跑一段"（上一刀 `hostCtors` 那格）不是一回事，
所以不给它记 `bad/` 边界 —— 记在这儿。

**量出来的**（`tests/jnc` 130/0）：`cases/63-dualmod.jnc` 把四个词摆在能摆的每个位置上
（顶层变量、类字段、结构体字段、形参与返回类型、`protected:` 标签与 Java 式前缀混写、
构造体里给自己的 `readonly` 字段赋值、局部量），五行输出与 `/tmp/c63.c`（`cc -O0 -std=c99
-Wall`，孪生里一个修饰符都不写 ——"一样"这件事本身就是这一刀的内容）逐字节相同：
`7 11 / 18 / 30 / 105 / 6 9`。

**尺子**（`/tmp/m67r.sh`）：

「真降得下来」（`sx` 退出码 0）：**49 → 50**（+1，`io_I2cSignalDecoder.jnc`）。
`ok66 ⊆ ok67`，一份都没退。覆盖对得上：612 + 50 = 662。

(文件, 拦路项) 对：6250 → **6158**（−92）。

两格修饰符各挪了一点：说明符位置 278 → **234**（−44 份文件彻底不再被修饰符挡住），
`*` 后面 101 → **97**。**这一刀买的东西比"238 对"少得多，原因还是那条**：那 278 份里
大多数不止一个修饰符，摘掉 `readonly` 之后立刻撞上 `property` / `autoget` / `bindable`。
"某个词值多少"这个数同样只是上界。

四个词在直方图里**归零**了（`/tmp/m67probe3.sh`：`readonly` / `cmut` / `public` /
`protected` 一条都不剩）。剩下的按大小：

- **属性那一套**：`property` 130（**32 份是它唯一的修饰符拦路项** —— 眼下最大的一格）、
  `autoget` 124（17 份）、`bindable` 80、`event` 82（3 份）。这四个是**一件事**：
  jancy 的 property 是"取/存两个函数装成一格看起来像字段的东西"，`autoget` 是"存的那半
  自动生成"，`bindable` 与 `event` 是它上面的通知机制（dual_modifiers.rst:70-99）。
- `volatile` 61 —— 上面说过，自己的一位（`PtrTypeFlag_Volatile`），自己一刀。
- `alias` 48（6 份）、`async` 45（7 份）、`bigendian` 41（**15 份**）、`reactor` 22、
  `errorcode` 13（写在不是函数的位置上）、`disposable` 6、`weak` 3、`safe` 3。

所以下一刀是**属性那一套**（`property` / `autoget` / `bindable`）：加起来 334 对，
而且 `property` 一个词就是 32 份文件唯一的修饰符拦路项。它也是 `opaque class` 那些 API
文件的主要内容 —— 第六十六刀打开的那一片，多半就卡在这儿。

### 第六十八刀：属性 —— 长得像变量，读写时是两次调用

上一刀的尺子指的是属性那一套（`property` 130 / `autoget` 124 / `bindable` 80 / `event` 82）。
这一刀只做**最里面那一层**：一格属性就是**一对函数**。

**模型。** prop.rst:15-17 那两句把它定死了：属性"looks like a variable/field but allows
performing actions on read or write"，读走 **getter**、写走 **setter**，
"Each property has a single getter and optionally one or more setters"，一个 setter 都没有
的就是 **const 属性**。所以这一层的落法没有第二种选择：

- `T property p;` → 方言里的两格函数 `p$get()` 与 `p$set(T)`
- 读 `p` → `(call p$get)`；写 `p = x` → `(expr (call p$set x))`
- `T const property p;` → 只有 `p$get`；写它是错

**简单声明式**（prop_simple.rst:19-31）在源码里只有一个词，两个体写在别处：

```jnc
int property g_p;
int g_p.get() { … }
g_p.set(int x) { … }
```

那两个体在语法里是 `(fn-def … (dcl … (qualified-special (name g_p) (accessor "get")) …))`
—— 与 `C.construct()` 同一个形状（第五十三刀），所以 `declarator` 那一支只是多认两个词，
`fnSig0` 多分一条岔路（`propSig`）。唯一的不对称在**取值器有返回类型**（`int g_p.get()`）
而存值器没有说明符 —— 后者与构造一样，摆一个 void 进去。

**顺序上有一件事非做不可。** 属性得**在签名那一遍之前**登记：那两个函数回什么、收什么，
是从属性的类型抄来的，而模块级变量那一遍（`globalDecl`）排在签名**之后**，来不及。所以
`run` 里多了一遍 `propName`，夹在 `classLayout()` 与签名之间。为了让这一遍与 `globalDecl`
都能看同一条 `var-decl` 而不把诊断发两次，加了个 `propMod(specs)` —— **不发一条诊断**地
问"这张 mods 表里有 `property` 吗"。

**`cfg.level` 是一个名字，不是"取 cfg 的字段"。** 命名空间里的属性在语法那一层摊成一串
`field`，所以读那一侧的钩子要挂在 `case 'field'` 里、**排在"把左边当值算"之前** —— 与
第三十九刀枚举成员 `Color.Red` 同一条理由。写那一侧同理，挂在 `exprStmt` 的 `assign` 上、
排在 `lvalue` 之前：属性没有"可写的那一格"，`lvalue` 只会去查变量然后报"未声明"。

**边界四条，都记了**：

- **类/结构体的成员属性**（`bad/prop-member.jnc`）。这一条**必须就地拦** —— 类体里的
  `int property m_value;` 走的是 `typeDecl` 那一遍，不拦它就会被当成一格普通字段，
  那是"悄悄换了意思"。成员属性要三处让路（取字段、lvalue、方法体里补 `this`），是自己一刀。
- **属性上的复合赋值**（`bad/prop-compound.jnc`）。`p += 1` 在 jancy 那边是"读一次、加一、
  写一次"，这一层的赋值降成方言的一句，两次调用摆不进去。
- **给 const 属性赋值**（`bad/prop-const-set.jnc`）—— jancy 自己也拒。
- **存值器的重载**：jancy 收（prop.rst:17 那句 "If a setter is overloaded…"），这一层一个
  名字一格函数，所以第二个 `set` 明说不收。

`autoget` / `bindable` / `event` / `indexed` 与完整声明式 `property { … }` 照旧不收 ——
它们各自都不只是"多一对函数"：`autoget` 要编译器**生成一格存储**（简单式里那格字段的名字
是 `m_value`，prop_autoget.rst:26），`bindable` / `event` 要通知机制。

**量出来的**（`tests/jnc` 134/0）：`cases/64-prop.jnc` 把六件事摆在一份里 —— 读、写、
`const property`、命名空间里的属性、"属性读出来是一格普通值"（参与运算、当实参），
以及**取值器被调了几次**（`hits=3`：读一次就是一次调用，不是一格缓存下来的内存）。
五行输出与 `/tmp/c64.c`（`cc -O0 -std=c99 -Wall`，孪生里写的正是那两格函数与那几次调用）
逐字节相同：`6 42 / 21 20 / 84 / 7 35 / hits=3`。

**尺子**（`/tmp/m68r.sh`）：

「真降得下来」（`sx` 退出码 0）：**50 → 50**（没动）。`ok67 ⊆ ok68`，一份都没退。
覆盖对得上：612 + 50 = 662。

(文件, 拦路项) 对：6158 → **6264**（+106）。

说明符位置的修饰符 234 → **202**（−32，`property` 那个词从这一格里没了）；
同时新开一格 **`类的成员属性 '…'` 100 份**。

**这一刀没让任何一份新降下来，而这正是它该有的样子。** 语料里的属性几乎全是**类的成员**
（`opaque class` 那些 API 文件里的 `X const property m_a;`）—— 顶层那一格在语料里近乎不存在。
这一刀买的是**机器**：属性表、取/存两个函数的签名、读写两处钩子、"属性名可以是限定名"，
以及"属性得在签名之前登记"那一遍。下一刀把这套机器接到成员上，那 100 份才动。

> 顺便钉一条：`property` 原先在 `specs` 里被整条拒掉，于是**类体里的那些成员属性根本没被
> 看见**。这一刀把 `property` 收下之后，如果不在 `typeDecl` 那一遍就地拦，`int property
> m_value;` 会被当成一格**普通字段**降下去 —— 那不是"拒得松"，那是**换了意思**。
> 所以那条 `nope` 不是补丁，是这一刀的一部分。这也是 +106 里的一大半：一条 specs 上的拒
> 变成了每个声明符各一条。

所以下一刀是**类的成员属性**：100 份，而且它是这一刀的机器唯一还没接上的一头。

### 第六十九刀：类的成员属性 —— 那一格 `this` 从对象来，或者从 `this` 来

上一刀把属性的机器摆齐了，只差一头：**哪一个对象**。jancy 的属性与方法一样是类的成员，
所以取/存那两个函数的第一个实参就是 `this`（第五十二刀那条）—— 上一刀的 `propSig` 里其实
已经写着 `if (pi.cls !== null) ps.unshift(this)`，只是从来没有一格属性的 `cls` 是非 null
的：类体里那些成员属性在 `typeDecl` 那一遍就被拦下来了。这一刀拆掉那道拦，把三处接上。

**登记要跨过一遍。** 类体是 `typeDecl` 那一遍看的，而属性的名字必须在**签名那一遍之前**
坐下（上一刀那条理由：取/存的签名是从属性的类型抄来的）。两遍之间隔着 `classLayout()`。
于是 `typeDecl` 只把节点连当时的 `ns`（就是那个类名）攒进 `propPend`，登记仍旧交给
`propName` —— 顶层那一格与成员那一格从此走**同一份代码**：`qual` 在 `ns = C` 下拼出来就是
`C$p`，`propName` 里那三行"前一格是不是类"于是第一次真的用上了。

**两种放法都收。** prop_simple.rst:21 那句话说得很清楚，简单声明式是给"declaring interfaces
or when the developer prefers to follow the C++-style of placing definitions outside of a
class"用的 —— 而语料里两种都有：

```jnc
class Box {                       // 体写在类体里（test42.jnc:27）
    int property m_value;
    int m_value.get() { … }
    void m_value.set(int x) { … }
}

class Tag {                       // 体写在类外（test150.jnc:16）
    int const property m_double;
}
int Tag.m_double.get() { … }
```

写在类外那一种本来就走顶层的 `fn-def`，`propSig` 里 `resolve('Tag.m_double')` 一步就查着了。
写在类体里那一种要 `aggHoist` 放行：`get` / `set` 从此与 `construct` 一样**提到顶层**，
`ns` 是那个类。它们与普通方法完全同型 —— 一格自由函数，`this` 当第一个形参，名字由 `propSig`
拼成 `C$p$get`。于是 `int m_value.get()` 的体里裸写 `m_raw` 照旧是 `this.m_raw`（第五十二刀
那条），一个字都不用改。

**三处接上，各自都有别的分支要让路。**

- **读 `b.m_value`**：挂在 `case 'field'` 里，**排在落到 `lvalue` 之前** —— 那儿只会报
  "Box 没有字段 'm_value'"。形状与第五十五刀的 `methodRef`（`c.foo` 当函数指针用）一模一样：
  先把左边算出来，左边不是类、或者那条继承链上没有这个属性就回 `undefined`，让那条路继续
  当"取字段"走。
- **写 `b.m_value = 10`**：挂在 `exprStmt` 的 `assign` 上、排在 `lvalue` 之前，理由与上一刀
  顶层那一格同一条 —— 属性没有"可写的那一格"。
- **方法体里裸写 `m_value`**：`this` 由 `propGet` / `propSet` 那一处补，不在调用点补。新开的
  `propSelf` 就管这一件事：给了对象就用那个，没给就补 `(var $this)`，而"能不能补"那一问与
  第五十二刀给 `foo()` 补 this 是同一句 —— `selfClass === pi.cls || isBase(pi.cls, selfClass)`。

**`resolve` 不走继承链。** 这是接上之后才露出来的一格：`class Derived: Box` 的方法体里裸写
`m_value`，`resolve` 从 `Derived` 一层层退到全局，路上没有 `Derived$m_value` 也没有全局的
`m_value` —— 于是报"未声明的变量"。裸写方法名早就有这条（`callName` 里 `resolve` 之后跟着
一句 `findMethod(this.selfClass, …)`），属性照抄：`findProp` 沿基类链找，`propBare` 是
"先 resolve、再 findProp"那两步。

**`propNames` 那一格是有代价换来的。** `b.m_value` 这一问要先把左边算出来才知道它是不是类 ——
如果每一次取字段都算一遍，光是白算就够难看，何况求值本身可能发诊断。所以照 `methodNames`
（第五十五刀）的办法先按**裸名**问一句"这个名字有没有可能是属性"。代价说清楚：一个类的属性
叫 `m_x`，另一个不相干的结构体也有字段 `m_x`，那么 `s.m_x` 会白算一次左边 —— 但 `propMember`
在"左边不是类"那一步就回 `undefined`，不发一个字，没有可观测差别。

**这一刀删掉了一条边界，重画了三条。** `bad/prop-member.jnc` 是上一刀刻意划的，现在功能落地
了 —— 按规矩删掉它，换三条更窄的：

- **结构体的成员属性**（`bad/prop-struct.jnc`）。取/存那两个体是从**类那一层命名空间**里查
  过来的（体外的 `int C.p.get()` 与体内的 `int p.get()` 靠的都是这一件事，第五十二刀），
  结构体在这一层不是一层命名空间，那两个体没有落脚处。jancy 那边结构体是可以有属性的
  （属性不占结构体的内存，与字段不同格），要接得先给结构体一层命名空间 —— 那是另一刀。
- **`virtual` 写在属性上**（`bad/prop-virtual.jnc`）。jancy 的属性也进 vtable，而这一层的虚
  派发（第五十七刀）是按**方法名**接的一格整数标签加一段分派，属性那两个函数的名字是这一层
  自己拼的（`p$get`），不在那条路上。悄悄把 `virtual` 丢掉的后果是**静默地调错一个**。
- **属性当一格可写的内存用**（`bad/prop-inc.jnc`）。`b.p++` 与 `&b.p` 都要求那一格有地址、
  能就地改。这一条原先报的是 **"Box 没有字段 'm_v'"**（裸名那一侧报的是 **"未声明的变量
  'g_p'"**）—— 两句都是**认错了人**：那个成员在、那个名字在，只是它那一格要走两次调用。
  与第六十六刀那两条一样，把误导的诊断改成一条说得清的边界，是这一刀的一部分而不是补丁。

**接上之后露出来两条"认错了人"，都在这一刀里改掉了。** 它们原先被「类的成员属性」那条拒
整块挡着，看不见：

- **类体里裸写的 `get` / `set` 不是属性，是下标运算符。** `class C2 { int get(int i) …
  void set(int i, int value) … }` 配上 `c[10] = 100`（test90.jnc:12-24）—— 那是 jancy 的
  索引运算符。第一版把所有 `get` / `set` 都提到顶层，于是这两个落进 `propSig`、报出
  「'get' / 'set' 前面要写属性的名字」：语料里 4 份这样，全是**误报**。所以提上去的条件不是
  "叫 get"，是**名字写在前面** —— 语法上那是 `qualified-special`（见 `accessorNamed`），
  裸写的那一格照旧由 `typeDecl` 报「'get'（要属性那一套）」。
- **`errorcode` 写在属性上**（io_WebSocket.jnc:96-101 那一串，语料里 16 份）。`specs` 那句
  「'errorcode' 只能写在函数上（exceptions.rst:17）」**对属性是错的** —— jancy 那一位落在
  取/存那两个函数的类型上。于是 `propName` 改成用 `allowVirt` 把它**收下来再就地拒**，
  理由写明"那一位在取/存那两个函数上，而这一层的 errorcode 是按函数名记的"。`virtual`
  同理，从 `typeDecl` 挪到这儿，一处一句。

**量出来的**（`tests/jnc` 137/0）：`cases/65-propmem.jnc` 把这一刀的每一头都摆在一份里 ——
`b.m_value` 的读与写、方法体里裸写属性名（`twice()` 与 `bump()`，后者一句里读一次写一次）、
**基类的属性**（`Derived.mine()` 里裸写 `m_value`）、体写在类外的 `const property`
（`int Tag.m_double.get()`），以及取值器被调了几次（`hits=5`）。七行输出与 `/tmp/c65.c`
（`cc -O0 -std=c99 -Wall`，孪生里那两个函数第一个形参就是 `Box* self`）逐字节相同：
`6 / 21 20 / 42 / 45 / 106 / 6 / hits=5`。

**尺子**（`/tmp/m69r.sh`）：

「真降得下来」（`sx` 退出码 0）：**50 → 51**（+1，`io_SslCipher.jnc`）。`ok68 ⊆ ok69`，
一份都没退。覆盖对得上：611 + 51 = 662。

(文件, 拦路项) 对：6264 → **6242**（−22）。

**`类的成员属性 '…'` 100 → 0**（那一格没了）。换出来的三格是：
`带形参表的属性` 4 → **67**（+63）、
`` `errorcode` 写在属性上 `` **16 份**（新，就是上面说的那一条）、
`属性 '…' 声明了两次` **1 份**（test149fail.jnc —— 那是 jancy 自己的 fail 测试，
一个类里把 `int const property m_a;` 写了两遍，jancy 也拒）。
`没有这个属性` 18 → 17，`C 没有字段 '…'` 2 → 1（少的那一条正是被改掉的误报）。

**+1 与 100 之间那道落差就是这一刀的诚实账。** 100 份里绝大多数换的不是"降下来了"，是
**换了一条更靠里的拦路项** —— 它们本来就还压着 `autoget`（124 份）、`bindable`（80）、
`event`（82）那几个词。真正只差这一刀的只有 `io_SslCipher.jnc` 一份。

**下一刀的名字已经写在尺子上了：`带形参表的属性` 63 份的涨幅**，那是**索引属性**
（`int property g_simpleProp(size_t i);`，32_IndexedProperties.jnc:22，prop_indexed.rst）——
属性的类型自己得成一格（jancy 的 `PropertyType` 带形参表），取/存两个函数各多一串下标形参，
读写落成 `(call p$get i)` / `(call p$set i v)`。它与 `autoget`（124 份，17 份只差它）是眼下
最大的两块。

### 第七十刀：索引属性 —— 那对方括号里的东西是实参，不是偏移

`int property g_slot(int i);` 里那一串**不是函数的形参，是下标**。prop_indexed.rst:15 把这
一格说得很干净：属性可以有数组语义，而"a property index doesn't have to be of the integer
type, nor does it mean **index** exclusively -- it is up to the developer how to use it"。
换句话说 `p[i]` 与 `a[i]` 只是长得像：数组那一格算的是**地址加偏移**，属性这一格是**调一次
函数、下标当实参**。

于是落法只多一段：`props` 里那一格多一个 `idx`（下标那一串类型，空数组就是普通属性），
取/存两个函数的形参表最前面多这一串，读写各多几个实参：

```
读 p[i]      ->  (call p$get i)
写 p[i] = v  ->  (expr (call p$set i v))
成员的那一格前面还有 this（第六十九刀）：(call C$p$get (var $this) i)
```

**`p[i][j]` 在语法上是一串套起来的 `index`**，最外那一层是**最后**一个下标 —— 所以
`indexChain` 从外往里 unshift，`{base, subs}` 里的 base 就是最底下那个名字。读那一侧的钩子
挂在 `case 'index'`、**排在 `derefLv` 之前**（那儿只会报"下标要一个指针"）；写那一侧挂在
`assign` 上、排在 `lvalue` 之前 —— 与前两刀同一条理由。三种底（裸名、`a.p`、`obj.p`）合成了
一个 `propTarget`。

**取/存两个函数的形参表要与声明里那一串对得上**（prop_indexed.rst:74 那句 "all accessors
should have the same index arguments"）：取值器是 k 个下标、存值器是 k 个下标加要存的值，
类型逐个比。个数不对时报的是"要 k 个形参（就是那 k 个下标）"，而不是原先那句"不带形参"。

**顺带堵上两个"悄悄换了意思"的洞**（都是这一刀的一部分，不是补丁）：

- **属性指针**（`bad/prop-ptr.jnc`）。`int property* p` 是一格**属性指针**（
  35_PropertyPtr.jnc:97-126）：里头存的是"取/存两个函数 + 那个对象"。而 `property` 这个词
  `specs` 是收下的，函数体里那条声明与形参那两处从来没问过它 —— 于是 `int property* p;`
  被**悄悄降成一格普通 `int*`**。这不是"拒得松"，是换了意思，所以两处各补一句拦。
- **完整声明式**（`bad/prop-full.jnc`）。`property p { … }` 在语法上是一格"说明符位置没有
  类型、只有 `property` 那个词"的**带体 fn-def**，落到 `specs` 那儿报的是「这条声明没有
  类型」—— 认错了人。那对花括号开的是一层命名空间（prop_full.rst:15），里头是属性自己的
  字段、取值器与可以重载的几个存值器；要接它得先有"属性也是一层命名空间"加重载决议。

**量出来的**（`tests/jnc` 140/0）：`cases/66-propidx.jnc` 把三种都摆进去 —— 一个下标的
`g_slot[i]` 读写、两个下标的 `g_grid[i][j]`、类的成员索引属性 `t.m_cell[i]`（读、写，加方法
体里裸写 `m_cell[0] + m_cell[1]` —— `this` 与下标各就各位）。七行输出与 `/tmp/c66.c`
（`cc -O0 -std=c99 -Wall`，孪生里那两个函数就是 `(Table* self, int i)`）逐字节相同：
`1 / 21 20 / 9 / 50 70 / 30 / 110 / hits=2`。

**尺子**（`/tmp/m70r.sh`）：

「真降得下来」（`sx` 退出码 0）：**51 → 52**（+1，`test148.jnc`）。`ok69 ⊆ ok70`，一份都没退。
覆盖对得上：610 + 52 = 662。

(文件, 拦路项) 对：6242 → **6227**（−15）。

**`带形参表的属性` 67 → 0**（那一格没了）。另外两格也随之空掉：
`'…' 有函数体，但声明符上没有形参表` 10 → **0**、`这条声明没有类型` 90 → **72**（−18）——
那两句原先接的都是**完整声明式**那一批，现在有自己的名字了：
`完整声明式的属性` **78 份**、`函数体里的属性声明（属性指针…）` **2 份**。

顺带修正了四处误报：`没有这个属性` 17 → 15、`未声明的变量` 270 → 269、
`CN 没有字段` 9 → 8、`ui.ComboBox 没有字段` 12 → 11。
`写属性 … 存值器没有定义` 2 → **7**（+5）：索引属性登记上了，于是"只写了取值器却往里写"这一条
第一次照到那几份 —— 那是诚实的。

**这一刀之后属性这一族剩下的账，两块最大：**`autoget` **124 份**（17 份只差它 —— 编译器要
**生成一格存储**，简单式里那格字段就叫 `m_value`，prop_autoget.rst:26）与**完整声明式**
**78 份**（那对花括号是一层命名空间，还要存值器的重载决议）。`bindable` 80、`event` 82 紧跟
在后面 —— 那两个要通知机制，不只是多一对函数。

### 第七十一刀：`autoget` 属性 —— 取值器不用写，那一格存储由编译器摆出来

prop_autoget.rst:15-17 把这一格的动机写在明面上：绝大多数取值器的体就是"回一格变量/字段"，
逻辑全在存值器里。所以 jancy 给了一个词 —— `autoget` —— 「Such properties do not require a
getter implementation: the compiler will access the data variable/field directly if possible,
or automatically generate a getter to access it otherwise.」而那格存储在**简单声明式**里叫什么，
同一份文档第 26 行就是答案：`m_value`（那句注释 "name of compiler-generated field is 'm_value'"
写在示例的存值器体里）。

于是这一刀要做的是三件事，一件都不能少：**摆出那一格存储**、**让存值器体里的 `m_value`
认得它**、**在没写取值器时合成一个**。

**那一格存储落在哪儿。** 名字统一是 `<属性全名>$m_value`（`$` 不在 jancy 的标识符里，所以
撞不上源码里的名字，而同一个类里两格 autoget 属性各带一格自己的存储、不会挤在一起）：

```
顶层  int autoget property g_p;      ->  (global g_p$m_value int)
成员  class C { int autoget property m_p; }
                                     ->  (struct C ($tag int) (C$m_p$m_value int) …)
```

成员那一格是**类自己那张字段表里加一格**，所以它必须赶在 `classLayout()`（一整条继承链发成
一格结构体，第五十六刀）之前进 `ownFields`。这就是这一刀在 `run()` 里唯一的结构改动：**属性
那两遍（顶层的与 `propPend` 里成员的）从 `classLayout()` 之后挪到了它之前**。挪得动是因为那
两遍只查名字 —— 类名在 `typeName` 那一遍就坐下了 —— 而且**一行 `decls` 都不发**。顶层那一格
的 `(global …)` 因此不能在那儿发：它排到 `gTaken` 数完之后（`&m_value` 决定它要不要提到"自己
的一段内存"里去，与第二十四刀对普通模块级变量的判定是同一条）。

**存值器体里的 `m_value` 怎么认。** 属性在 jancy 那边**本来就是一层命名空间**
（prop_full.rst:15 那对花括号开的就是它）。这一层顺着这句话走：`propOf` 记下"取/存这个函数属
于哪格属性"，`fnDef` 降它的体时把 `this.ns` 从类再往里挪一层，摆到属性上。于是顶层那一格
`resolve('m_value')` 从 `g_p` 退出去的第一下就撞上 `g_p$m_value` —— 零特例。成员那一格是类里
的字段、不走 `resolve`，所以多一格 `selfProp`：`selfField` 拿它把源码里写的 `m_value` 换成
`C$m_p$m_value`，而**回的是字段自己**，`nameLv` 因此改成发 `f.name` 而不是源码里那个名字。

**合成的取值器。** 只在 `pi.get === false` 时发 —— 写了取值器就用写的那个（那正是文档里
"if possible … or automatically generate … otherwise" 的两半）：

```
(fn g_p$get () int (ret (var g_p$m_value)))
(fn C$m_p$get (($this (ptr C))) int (ret (pload (pfield (var $this) C$m_p$m_value))))
```

**方言一个字没长。** 一格全局、一格字段、一句 `ret` —— 三样都是现成的。

**顺手划两条边界，两条都是 jancy 自己也拒的：**

- **`autoget` 与索引一起写**（`bad/prop-autoget-idx.jnc`）。prop_autoget.rst:47 那一句就是全部
  理由：「Autoget and indexed property modifiers are mutually exclusive.」生成的是**一格**存储，
  而索引属性要的是"一串下标各对一格"。悄悄挑一边就是骗人：挑 autoget 会让 `p[1]` 与 `p[2]`
  读到同一个字。
- **`autoget` 写在不是属性的那一格上**（`bad/autoget-nonprop.jnc`）。它在 jancy 里的第二个落点
  是完整声明式体内的那格字段（同处:34「'autoget' field implicitly makes property 'autoget'」），
  而完整声明式这一层整个不收（第七十刀的边界）。所以剩下的写法只能是写错了地方 —— 不拦就会
  被**悄悄降成一格普通的模块级变量**。

**量出来的**（`tests/jnc` 140/0 → **143/0**）：`cases/67-propauto.jnc` 把五种摆齐 —— 存值器里
带逻辑的 `g_clamp`（三次赋值分别落在下界、上界与中间）、存值器里**读那一格自己**的 `g_acc`
（累加三次）、**自己写了取值器**的 `g_dbl`（写 6 读出 60，证明写了就用写的那个）、对那一格
**取地址**的 `g_via`（`int* q = &m_value;` —— 提到自己那段内存的那条路）、类的成员 `Cell.m_v`
（存值器里同时改另一格真字段 `m_hits`，方法体里裸写 `m_v`，加**派生类** `Sub` 读基类的那一格）。
七行输出与 `/tmp/c67.c`（`cc -O0 -std=c99 -Wall`）逐字节相同：
`7 0 100 / 12 / 60 / 12 / 11 22 / 21 42 63 / hits=1`。

**尺子**（`/tmp/m71r.sh`）：

「真降得下来」（`sx` 退出码 0）：**52 → 53**（+1，`test128.jnc` —— 三格 `bool autoget
property` 加三个存值器，正是这一刀的形状；五条腿都跑得动）。`ok70 ⊆ ok71`，一份都没退。
覆盖对得上：609 + 53 = 662。

(文件, 拦路项) 对：6227 → **6146**（−81）。

**`修饰符 '…'` 202 → 188**（−14）。这个数比"语料里有 `autoget` 的份数"小得多，原因要说清：
语料里**字面写着 `autoget` 的只有 56 份**（先前记的 124 是连 import 进来的头文件一起算的），
而这些文件多半同时还写着 `bindable` / `event`，同一份文件的 `修饰符 '…'` 归一化之后只算一格。

**剩下的 14 份卡在另一个位置上，不是这一刀的漏**：`Icon* autoget property m_icon;` —— 那两个词
写在 `*` **后面**，落进声明符的指针后缀修饰符表（`ptrsTy`），`specs` 根本没看见它们。所以那
14 份报的是「指针后面的修饰符 'autoget'」，理由是对的。这一格现在有数了：**97 份**卡在指针后缀
修饰符上，按词数出来是 `property` 231 处、`autoget` 118 处、`bindable` 57 处、`errorcode` 30 处
—— 也就是说**"类型是指针的属性"是下一刀最大的一块**，而它是自己一个机制（后缀那张表要把
`property` 这类"其实是声明的事"的词送回 `specs` 那一侧），不是 `autoget` 的补丁。

**准头是这一刀更大的收成。** 成员 autoget 属性登记上之后，先前一堆"没有这个字段"的误报换成了
真东西：`ui$BoolProperty 没有字段` **18 → 8**、`ui$IntProperty` **12 → 5**、`ui$StringProperty`
**5 → 2**、`ui$FileProperty` **4 → 2**，另有**七格整格消失**（`Label` / `doc$Storage` /
`ui$InformationValue` / `ui$LineEdit` / `ui$LoginDlg` / `ui$Property` / `ui$SpinBox`）。
`没有这个属性` **15 → 8**。`没有这个类型` 296 → 297 那一份是 `test147fail.jnc` —— jancy 自己的
**fail** 用例，源码就一句 `AA autoget property m_a;`，我们现在报的正是 jancy 报的那件事
（`AA` 这个类型不存在），先前停在 `autoget` 上。

**涨上去的两格都是诚实的，得摆明白**：`写属性 '…' —— 它的存值器没有定义` **7 → 66**（+59）。
autoget 属性第一次登记进表，于是 ioninja 那些"声明在 `.jnc` API 头里、存值器在 C++ 宿主那边"的
属性第一次照到这一条 —— 它们的 setter 真的不在源码里，这条拦得对（宿主面是另一件事，第
六十六刀记着）。`errorcode` 写在属性上 16 → **22**（+6）同理：属性登记上了，那一条才照得到。
另有两格第一次出现：`'…' 一个实现都没有（abstract …）`（`ModbusParserBase.jnc` 走过了原先的
拦路项、走到了 `vtCheck`）与 `属性 '…' 当一格可写的内存用`（autoget 属性上的 `++` / `&`，
第六十九刀划的那条边界第一次照到语料）。

**属性这一族剩下的账**：类型是指针的属性（上面那 97 份，下一刀）、完整声明式 `property { … }`
**78 份**（那对花括号是一层命名空间，还要存值器的重载决议）、`bindable` 与 `event`（要通知机制，
不只是多一对函数）。

### 第七十二刀：那个词写在星号的哪一边

`int property* p` 与 `Icon* property p` 是**两码事**，差的只是 `property` 写在星号的哪一边。
这不是猜的，机制在 jancy 那三处：

- `Declarator::addPointerPrefix`（jnc_ct_Decl.cpp:292-297）：见到一个 `*` 就把**到这儿为止
  攒着的**那些词搬进这个 `*` 自己的 prefix、然后把袋子清空 —— 于是写在 `*` 前面的词修饰的是
  那一格指针，写在最后一个 `*` 后面的词留在袋子里。
- 那袋 prefix 带 `TypeModifier_Property` 时走 `getPropertyType` 再套一层
  `getPropertyPtrType`（jnc_ct_DeclTypeCalc.cpp:80-85）—— 那是**属性指针**，里头存的是
  "取/存两个函数 + 那个对象"。
- 循环之后剩下那袋（`m_typeModifiers = typeModifiers;`）带 `TypeModifier_Property` 时走
  `getPropertyType(type)`（同文件:145-150）—— 那是**类型是那格指针的属性**。

这一层的树形状恰好是同一个分法：写在第一个 `*` 前面的词落在 `(specs …)` 里，写在第 i 个 `*`
后面的词落在第 i 组 `(ptr (mods …))` 里 —— 所以**最后一组**就是 jancy 那只剩下的袋子。落法
就是照着这句话把那一组提成"这条声明的词"（`tailMods` + `specs` 多收一串 `extra` +
`ptrsTy` 的 `dropTail`），而 `declarator` 从此回一格 `info.sp`：关心 prop / cst / agt 的
调用方一律读它，不要读自己那份。

**提的条件是那一组里真写着 `property`。** 这一条不能省：全提就会把 `int* thin p` 悄悄当成
一格 thin 指针（`thin` 在 jancy 那边是指针的词，写在后面 jancy 自己会拒）。能提上来的词
就是 jancy 那张 `TypeModifierMaskKind_Property`（jnc_ct_Decl.h:75-85）里这一层认得的几个
（`PROP_TAIL_MODS`）；别的落在那儿明说不收 —— 免得"提上来"变成"悄悄丢掉"。

**这一刀同时堵掉三个洞，都是"悄悄换了意思"：**

- **顶层与类体里的属性指针**（`bad/prop-ptr-top.jnc`）。第七十刀在函数体与形参那两处拦过
  `int property* p`，顶层与类体里当时漏着 —— 那儿会把它**登记成一格"类型是 `int*` 的属性"**。
  现在这一问挪进 `declarator`（`sp.prop` + 没提过 + 有 `*`），一处拦住，三处都对。`typedef
  int property* P;` 也从这儿一并接住（先前它会静默变成 `P = int*`）。
- **取值器的返回类型吞掉了星号**。`declarator` 的特殊成员那一支直接抄 `sp.type`，`Icon*
  g_p.get()` 于是回 `Icon` —— 类型是指针的属性永远对不上自己的取值器，报的是"回的是 int，
  而属性是 int*"，认错了人。补上 `ptrsTy`。
- **完整声明式的判定漏了星号那一边**。`log.Writer* const property m_logWriter { … }` 是语料里
  最常见的一种完整声明式，而 `fnSig0` 开头那一问只看 `(specs …)` —— 于是它落到 `ptrsTy` 那儿
  报"指针后面的修饰符 'property'"。真拦路的是那对花括号（第七十刀那条），改成两边都问。

**属性读出来那一格上的 `.` 与 `[]`。** 这两条是"类型是指针的属性"能用起来的前提，所以是这一刀
的一部分，不是补丁：`g_icon.m_k` 里 `g_icon` 要先读一次（调取值器）、读出来是一格指针，之后
取字段与 `p->f` 同一条；`g_buf[0]` 同理，那对方括号是**读出来那一格**的，不是属性的。前者挂在
`lvalue0` 的 `field` 支上（左边是 LV 形状时先问一句 `propTarget`），后者由 `propSubOnValue`
让路 —— 属性没声明下标、类型又是指针时两处索引钩子都放手。**属性自己没有被写**，所以这跟
"把属性当一格可写的内存用"（第六十九刀那条边界）不是一回事：那一条拦的是 `g_icon++`。

**量出来的**（`tests/jnc` 143/0 → **145/0**）：`cases/68-propptr.jnc` 摆了四种 —— 类型是**类
指针**的属性（存值器只认非空，所以写 null 之后读到的还是上一格）、类型是**数据指针**的
autoget 属性（生成的那一格存储是 `int*`，`g_buf[0]` / `g_buf[1]` 走的是"读出来再下标"）、
类的**成员**的类指针 autoget 属性（生成的那一格是类里的字段，存值器同时改另一格真字段）、
方法体里裸写 `m_icon.m_k`。六行输出与 `/tmp/c68.c`（`cc -O0 -std=c99 -Wall`）逐字节相同：
`7 / 7 / 9 / 11 22 / 7 7 / 9 hits=2`。

**尺子**（`/tmp/m72r.sh`）：

「真降得下来」：**53 → 53**（一份没多）。`ok71 ⊆ ok72`，一份也没退。覆盖 609 + 53 = 662。

(文件, 拦路项) 对：6146 → **6116**（−30）。

**`指针后面的修饰符 '…'` 97 → 13**（−84）。剩下那 13 份全是 `errorcode` 写在 `*` 后面
（30 处）—— 那是 errorcode 那一族的事，与属性无关，记成账。

**新出来的那一格是把先前藏在错名字底下的东西摆到明面上**：`属性的声明里 '*' 后面的
'bindable'` **55 份**（57 处）。那些声明（`bool bindable autoget property m_isChecked;` 的指针
版）先前报的是"指针后面的修饰符 'property'" —— 属性这件事根本没被认出来。现在属性认出来了、
`bindable` 明说不收，理由对上了人。`bindable` 因此从"81 份的一个名字"变成**语料里属性这一族
最大的一块**。

**没有一份新降下来，为什么还算走对了。** 这一刀买到的是**认对人**：`TextEdit 没有字段` 整格
消失、`没有这个属性` 8 → 7、`未声明的变量` 269 → 268；`'…' 要 string，这里是 char*` 6 → 7 是
有一份走得更深了。`完整声明式的属性` 停在 **78** 没动 —— 那 35 份带 `log.Writer* const
property … { … }` 的文件里，同一份文件本来就另有一格普通写法的完整声明式属性，(文件, 理由) 对
早就在表里了。换句话说：这一刀清掉的是**理由错**，不是**份数**，而理由错清不掉就没法知道下
一刀该切哪儿 —— 现在知道了，是 `bindable`。

**属性这一族剩下的账**：`bindable` **55 份**（要"值变了就通知"那一套：一格事件加自动的
`onChanged`）、完整声明式 **78 份**（那对花括号是一层命名空间，还要存值器的重载决议）、
`event` 82 份。

## 第七十三刀：`bindable` 属性 —— 一格事件加手写的通知

上一刀数出来"下一刀是 `bindable`"，这一刀就是它。

**它是什么**（出处全在 jancy 自己的源码里）：`bindable` 写在属性上，编译器给这格属性生成
一格**事件**，名字是 `m_onChanged`，类型是 `multicast ()`（`Property::createOnChanged`，
jnc_ct_Property.cpp:125-147，`StdType_SimpleMulticast` 的定义在 jnc_ct_TypeMgr.cpp:195-197）。
`bindingof(p)` 就是"把那一格拿出来"（Expr.llk:898-901 直接落在 `getPropertyOnChanged` 上）。
**通知是手写的**——`samples/jnc/34_BindableProperties.jnc:15-17` 那句 "The firing of the
bindable event must be done manually, unless the entire property is compiler-generated"。
自动通知只有一处：整格属性都由编译器生成的那种（bindable data），它的存值器是
`if (m_value != x) { m_value = x; m_onChanged(); }`（`compileAutoSetter`，
jnc_ct_Property.cpp:788-822 —— 那个 `!=` 就是"同值不通知"的出处）。

**方言里不用加东西**。多播在 jancy 的运行期是"一串函数指针 + 个数"
（`jnc_Multicast`，include/jnc_RuntimeStructs.h:169-181），而方言现成就有**元素是函数值的
数组**：订阅是 `apush`、通知是照 `alen` 走一遍 `callfn`、清空是换一格空的上去。顺序也对得上
——jancy 的 `McSnapshot.call` 从下标 0 往上走（jnc_ct_MulticastClassType.cpp:64-94）。
先拿一份 `.sx` 探针量过这四件事在解释器上就是通的，然后才动前端。

**落法**：新的一格 jnc 类型 `mc`（`multicast ()`，`tyText` 出来就是
`(arr (fnty () void))`）；`bindable` 的属性登记时生成一格模块级的
`<属性全名>$m_onChanged`，与 `autoget` 那格 `$m_value` 同一处发；通知那一格助手
`jnc$mc_fire` 一份程序发一格。裸写的 `m_onChanged` **不用特判**——属性在 jancy 那边本来就是
一层命名空间（prop_full.rst:15），而这一层把属性全名当前缀，普通的名字查找就找着了。

**一处可观测的差别，记成账**：jancy 通知前先取一份快照，所以"叫的过程中有人加/减"不影响这
一轮；这一层每圈重问一次 `alen`，于是叫的过程中加进来的**会被叫到**。要快照就得先抄一份数组。

**量出来的**（`tests/jnc` 145/0 -> **150/0**）：`cases/69-propbind.jnc` 是 sample 34 简单声明
式那一半的等价物（订阅两个、同值不通知、`= null` 清空），六条腿逐字节相同；四条边界各钉一条
——类的成员上的 bindable（那格事件在 jancy 那边是类里的字段，方言的字段放不下函数值 ——
**第八十四刀落了**，那条边界现在是 `bad/prop-noset.jnc` 那一格）、
事件上的 `-=`（jancy 收的是 `+=` 回来的 cookie）、`bindingof` 用在非 bindable 的属性上
（照 jancy 那句 "has no bindable event" 说）、bindable data（整格生成的那一半，下一刀）。

**尺子**（只量提到 `bindable` 的那 67 份，口径是"第一条诊断的理由"）：
`修饰符 'bindable'` **11 份 -> 0**。这 11 份一份也没真降下来，它们换了更靠里的拦路项 ——
`event` 2->5、`reactor` 6->7、bindable data 0->2、`destruct` +2、`variant_t` 1->2。也就是说
这个词不再是墙，墙在它后面：**带实参的事件**、`reactor`、以及 `.jncx` 那种编译好的扩展库。

### 后一半：bindable data（整格由编译器生成）

`int bindable g_data;` —— 光写 `bindable` 不写 `property`，在 jancy 里是一格**整格生成**的
属性："a wholly compiler-generated property with trivial getter and setter - the sole purpose
of bindable data is to track data changes"（samples/jnc/34_BindableProperties.jnc:87-90）。

落法只有一句话：**把它补成一格 `autoget` 的属性**。那样取值器与那格 `$m_value` 存储都是
现成的（第七十一刀），这一刀只多发一格存值器：

```
(fn g_data$set ((x int)) void
  (if (bin "!=" (var g_data$m_value) (var x)) (do
    (set g_data$m_value (var x))
    (expr (call jnc$mc_fire (var g_data$m_onChanged))))))
```

那个 `!=` 不是我们的设计，是抄的：`Property::compileAutoSetter`
（jnc_ct_Property.cpp:788-822）里 `BinOpKind_Ne` 那一句就是"同值不通知"
（同一份 sample:128-129）的实现。顺带一格判据：`propMod` 那一问也要认光写 `bindable` 的
那种，否则 `globalDecl` 会把它当一格普通的模块级变量 —— 那就悄悄丢掉了通知。

**量出来的**：`cases/70-binddata.jnc`（`start 0` / 订阅 / 同值不通知 / 第二个订阅），六条腿
逐字节相同；`tests/jnc` **150/0**（`bad/bind-data` 那条边界随之退役 —— 它变成了能跑的用例）。
尺子上 `bindable data` **2 份 -> 0**，两份各换了更靠里的一格（`reactor` +1、类的成员上的
bindable +1）。

**属性这一族剩下的账**：完整声明式 **78 份**（那对花括号是一层命名空间，还要存值器的重载
决议）、`event` 82 份（**带实参的**多播 —— 这一刀只有 `void ()` 那一种）、类的成员上的
bindable（那格事件要能当类的字段，而方言的结构体字段还放不下函数值的数组）。


## 第七十四刀：`event` / `multicast` —— 带实参的多播（顶层那一格）

上一刀的账里第一名是 `event`（语料里 49 条 `event NAME(…)` 声明），而上一刀的多播只有
`void ()` 一种。这一刀把它一般化。

**出处**：`event` 与 `multicast` 都是**类型修饰符**（Lexer.rl:212-240），所以它们落在说明符表
里；`event m_e();` 的说明符里**没有类型** —— 处理函数一律回 void（"Multicasts must return
void"，jnc_ct_TypeMgr.cpp:907-911），带实参那一串写在声明符的括号里。多播类上那几格运算符
是别名（同处:962-973）：`:=`/`=` 是 setup、`+=` 是 add、`-=` 是 remove、`m(…)` 走 call。
`event` 与 `multicast` 的差别只在"能不能从外面叫"（`MulticastMethodFlag_
InaccessibleViaEventPtr`，同处:940-975）—— 这一层没有可见性检查（与第五十二刀同一笔账），
所以两个词落地是同一件事，那一格差别记成账。

**落法**：jnc 的 `mc` 类型带上那串实参（`tyText` 出来是 `(arr (fnty (T…) void))`），通知那一格
助手**按签名一格**（`jnc$mc_fire` / `jnc$mc_fire$int` / `jnc$mc_fire$int$int`…，名字由类型文本
消毒出来，同签名一份程序里只发一格）。顶层的 `event NAME(…)` 是一格模块级的
`(arr (fnty …))`，在 `globalCells` 里 `anew` 出来 —— 这一问必须排在"顶层的函数原型"那条**之前**，
否则 `event m_e()` 会被当成函数原型拒掉。

**两条必须拦住的**（不拦就是悄悄丢东西）：类/结构体里的 `event`（那是**字段**，语料里全是这个
形状 —— 不拦会被登记成一格返回 void 的方法原型，整格事件就没了），以及写了非 void 返回类型的
事件（jancy 自己也拒）。

**量出来的**（`tests/jnc` 150/0 -> **154/0**）：`cases/71-event.jnc` 摆了三格事件（无实参、一格
实参、两格实参，`event` 与 `multicast` 两种写法），订阅两个、按加入顺序叫、`= null` 清空、清完
再订阅，六条腿逐字节相同；三条边界各钉一条 bad（类里的事件、返回类型不是 void、订阅的签名
不对）。

**类里的事件为什么还不收（这一刀里试过，退回来了）**：语料里 `event` 全是类的成员，所以顺手
试了一把 —— 类体那一遍登记成一格 mc 字段、`newPtr` 里造对象时多发一句
`(pstore (pfield $p f) (anew …))`、`obj.m_e += h` 走字段的读写。结果撞在方言这一侧：
`形参 $this：结构体 'Button' 里有落不进内存的字段`（hir/types.js 的 `structLayout`）。
**先前拿 `.sx` 探针量的是 `(class Box (evt (arr …)))` —— 那是方言的**类**（按名字存的对象槽），
而这一层的 jancy 类降下来是一格 `(struct 根 …)` 加 `(ptr 根)`（第五十二刀）。探针量错了形状，
这条更正记在这儿。** 要它得先让方言的结构体布局收下"数组的句柄"，那与第五十五刀"函数值的
字段"是同一堵墙、同一刀。

**那堵墙为什么在那儿**（顺手把理由量清了）：方言的内存布局是**定死的一张表**
（`hir/types.js` 的 `alignOf` / `sizeOf`，本 ADR 决策二）—— 落得进内存的只有
bool / int / real / 两种指针 / 定长块 / 结构体，别的一律回 `0`，而 `structLayout` 见到 0 就整块
回 null。`arr` / `fn` / `list` / `class` 这几种是**引用语义**（`isRef`）：C 那条腿上它们是指向
运行期结构的指针，两个解释器里它们是宿主对象、内存是**模拟出来的一片 arena**。给 `arr` 记上
"8 字节"就等于说"一格 GC 句柄可以被 `pstore` 写进任意一段内存、可以随结构体一起盖在缓冲上"
—— 那正是这门语言"拿结构体盖协议头"那条用处的反面，而且解释器那侧要为此多一张句柄表。
所以它是一格 ADR 级的决定（与第五十五刀"函数值的字段"同一格），不是前端能绕过去的。

**剩下的账**（下一刀的候选，按语料）：类里的事件（先要方言的结构体字段收下数组句柄，见上）、
`reactor`、`.jncx` 那种编译好的扩展库、完整声明式的属性。

## 第七十五刀：完整声明式的属性 —— 一次改写，属性那一整套不动

语料里 **86 处** `property NAME { … }`，形状高度一致（`uint_t get() { … }` 加
`void set(uint_t value) { … }`，test/ioninja/plugins/Udp/UdpDispatch.jnc:11-29）。

**关键的一句话**：那对花括号开的是**一层命名空间**（prop_full.rst:15），取/存两个函数写在里面
还是写在外面，在 jancy 那边是同一件事。所以这一刀不动属性那一整套（第六十八到七十二刀），只在
名单成型之前做一次**改写**：

```
property g_p { int get() { … } void set(int x) { … } }
        ⇓
int property g_p;          // 简单声明式（第六十八刀）
int g_p.get() { … }        // 体外的取值器
void g_p.set(int x) { … }  // 体外的存值器
```

属性的类型是**取值器的返回类型**（完整声明式里说明符位置本来就不写类型）；`*` 那一串也照抄，
`property` 这个词按第七十二刀那条规矩落位（没有 `*` 进说明符表的后一组，有 `*` 就跟在最后一个
`*` 后面 —— `log.Writer* get()` 出来的是 `log.Writer* property m_x`）。类的成员不用另写一条：
写在类体里的函数定义本来就被提到同一份名单里（第六十九刀那句"提上去的那一批"），改写因此对
顶层与成员是同一条路。

**改写不动的两半当场说清**（不说就是悄悄丢东西）：体里写字段（`autoget int m_x;` 那半，
prop_full.rst:34 的 "implicitly makes property 'autoget'" —— 那格字段会反过来给整格属性加上
autoget/bindable 两个性质）、以及存值器的**重载**（`set(int)` 与 `set(double)` 两个，
samples/jnc/34_BindableProperties.jnc:57-58，要重载决议）。

**量出来的**（`tests/jnc` 154/0 -> **156/0**）：`cases/72-propfull.jnc` 摆了四格 —— 顶层一格
（存值器有副作用、取值器读另一格模块级变量）、类的成员两格（体里裸写字段就是 `this.m_n`）、
以及只有取值器的那一种（prop.rst:17 那句"没有存值器就是 const 属性"），六条腿逐字节相同；
两条边界各钉一条 bad。`bad/prop-full` 那条边界**退役**了 —— 它现在是能跑的程序。

**尺子**（只量提到 `property NAME {` 的那 34 份，口径"第一条诊断的理由"）：整块的
`完整声明式的属性（…）` **4 份 -> 0**，换成了体里那格字段的理由（`'g_prop' 体里的这一条` 6 份、
`'m_prop' 体里的这一条` 3 份）；另有几份走得更深，露出了后面的墙（`destruct`、类的静态字段、
类里的事件、`没有这个类型 'Scheduler'`）。一份也没真跑起来 —— 那 34 份是 ioninja 的插件，
还压着 `.jncx` 那一格。

## 第七十六刀：完整声明式里那格字段与那格事件

上一刀把体里"只有带体的 get / set"那一种接上了，尺子随后指的就是体里那格字段
（`'g_prop' 体里的这一条` 6 份、`'m_prop' …` 3 份）。这一刀接它。

**jancy 的两条隐含规则**（prop_full.rst:34）：体里写一格 `autoget` 的字段，整格属性就是
autoget；写一格 `bindable event`，整格属性就是 bindable。samples/jnc/34_BindableProperties.jnc:46-59
就是这个形状 —— 而且那两格的**名字是写的人定的**（`m_x` / `m_e`），默认的 `m_value` /
`m_onChanged` 只是"没写完整声明式时"的名字（prop_autoget.rst:26、prop_bindable.rst:23-29）。

**落法还是那一次改写**：体里那两条声明各出一格信息 —— 字段给出**属性的类型**（这时取值器可以
不写，由编译器生成）、事件给出 bindable。改写出来的简单声明式因此是
`int autoget bindable property g_prop;`。名字这一格记在 `propMemName` 上（属性全名 ->
`{store, onch}`），`autoStore` / `bindStore` 照它拼那格生成物的名字 —— 于是存值器体里裸写的
`m_x` / `m_e()` 由"属性是一层命名空间"直接查得着，一个特判都不用加。

**量出来的**（`tests/jnc` 156/0 -> **157/0**）：`cases/73-propfullauto.jnc` 是 sample 34 里
`g_prop` 那一格的等价物（`autoget int m_x;` + `bindable event m_e();` + 手写存值器 + 手写通知
+ 同值不通知），六条腿逐字节相同；`bad/propfull-field` 退役（它现在能跑），换成
`bad/propfull-plainfield` —— 体里写**不带 `autoget`** 的字段照旧拒（不拒就会把那格字段悄悄
丢掉，体里读它成了"未声明的变量"）。

**尺子**（同一份 34 份的口径）：`'g_prop' 体里的这一条` **6 -> 2**，好几份换成了更靠里的
`import "*.jncx"`（6 份）与别的 import；剩下的是体里还有别的成员（不带 `autoget` 的字段、
`alias` 之类）与 2 份语法就没过的（`unexpected "*"`）。

## 尺子本身进了仓库（`tests/lib/jnc-sweep.js`）

从第五十几刀起，每一刀的选题都靠同一件事：662 份真实 `.jnc` 过一遍 `omni sx`，把「还不收」与
普通错各自归一，数成 (文件, 拦路项) 对，看谁在榜首、谁是某些文件的**唯一**拦路项。可这把尺子
一直是 `/tmp/m64r.sh` 那种一次性脚本 —— 每量一次全量重跑、跑完就扔、上一趟的数字只留在这份
ADR 的正文里。三处都要修，修法与 ADR-0023 是同一件事：

- **方子进仓库**：归一化一字不变（掐掉 `路径:行:列: error: `、脱掉 `jancy 前端第一刀还不收：`
  记成 N、别的记成 E、理由里带引号的名字换成 `'…'`、一份文件里同一条理由只算一次；ioninja
  那一支带 `-I test/ioninja/api`，理由是它自己的 CMakeLists.txt:815）。两刀之间的数从此可比。
- **走运行缓存**：662 次子进程走 `RunCache('jnc-sweep')` —— 冷跑并行预热，没改的文件直接命中。
- **落报告**：`.omni-cache/test/log/jnc-sweep.log`（全量榜 + 每份文件的拦路项）与
  `jnc-sweep.json`（上一趟的数）。下一趟自动印出差值 —— `2746 -> 2698（−48）` 那句不再靠手抄。

```
node tests/lib/jnc-sweep.js --top 40
```

## 第七十七刀：形参的默认值 —— 补在调用点，所以能写什么有一条界

尺子（这一刀起是仓库里那一份 `tests/lib/jnc-sweep.js`）指的第一名不是语言特性，是**标准库
不在**（`没有这个类型` 353 / `没有这个函数` 296 / `未声明的变量` 284 —— 那是同一件事的三张脸）。
排在它们后面的第一个真特性是**形参的默认值**：190 对，其中 3 份文件它是唯一的拦路项。

**jancy 那边的三件事**（都从源码量的，因为文档里只有一句话）：

- 语法那一格是 `Declarator.llk:484-510` 的 `'=' expression_pass1`，收下来的东西存进
  `Declarator::m_initializer` —— 那是**一串没编译的记号**（`Decl.h:344`）；
- 它跟着形参走（`Parser.cpp:2565-2574` -> `TypeMgr.cpp:455-477`），`FunctionArg` 靠
  `ModuleItemInitializer` 存着（`jnc_ct_FunctionArg.h:23-35`）。所以 jancy **没有**"默认值
  必须是编译期常量"这条要求：里头写调用、写全局量都行；
- 补的位置是**调用点**：`OperatorMgr::castArgValueList`（`OperatorMgr_Call.cpp:413-476`）
  在发那句 call 之前，把缺的那几格用 `parseFunctionArgDefaultValue`（`OperatorMgr_New.cpp:329-362`）
  当场编出来，代码落在**调用方**的那个基本块里。而名字查的**不是**调用方的命名空间：
  `ParseContext(ParseContextKind_Expression, …)` 打开的是那个形参**声明处**的命名空间，
  只把调用方的 `Scope` 留着发码用（`ParseContext.cpp:32-38`）。

**这一层的落法**：`formalList` 把默认值那一格的语法节点记在签名上（`sigOf` 的 `defs`，
与 `params` 一样长，所以方法上第 0 格是 `this`、永远是 null），调用点少给的那几格换成那些
节点，然后与写出来的实参**走同一条路** —— 同一份类型检查、同一句诊断。普通调用
（`callExpr`）与 `construct`（`ctorArgs`）两处都接了。

**两条界，都是明码标价买来的**：

1. **只收末尾那几个**。jancy 比这宽：它允许中间那格空着调（`f(1,,3)`，空槽也拿默认值 ——
   `OperatorMgr_Call.cpp:418-435`，缺默认值时报 "argument (%d) of '%s' has no default value"）。
   这一层没有那种空槽写法，中间一格的默认值因此**根本用不上**，收下来只会是个哑巴功能，
   所以当场拒（`bad/argdefault-middle`）。
2. **默认值的形状限死**：字面量、`true`/`false`/`null`、**限定写法**的枚举成员（`Color.Red`），
   以及它们的一元/二元运算。理由是上面那条差别：我们在调用点按**调用点**的作用域降它，
   而 jancy 按**声明处**的命名空间。名字这一类只要撞上调用方的局部量就会静静地取错 ——
   所以不猜，当场说"还不收"（`bad/argdefault-shape`）。语料量出来的形状正好在这条界里
   （`null` 124、`0` 114、`1` 59、`false` 39、`-1` 33、`true` 31、`0x01`/`0x02` 那些、
   以及 `State.Opened` 那种枚举成员）。

**量出来的**：`tests/jnc` 157/0 -> **160/0**（`cases/74-argdefault.jnc` 六条腿逐字节相同：
函数、方法、`construct` 三处的默认值，`1 << 3` 与 `Color.Blue` 那两种形状，以及"默认值是
**每次调用**现算的"—— 两次不给实参的调用各把那个副作用函数跑了一遍，`g_calls` 是 2）。

**尺子（`tests/lib/jnc-sweep.js`，655 份）**：

- (文件, 拦路项) 对：8711 -> **8133**（−578）。比那 190 对多得多，因为跟着走掉的还有
  **调用点的个数不对**那一族普通错（`要 N 个实参，这里给了 M 个`）—— 有默认值的函数当然
  会被少给几个实参地调；
- 「没有还不收的行」的文件：140 -> **142**（+2）；
- 「真降得下来」（`sx` 退出码 0）：**53 -> 53，没动**。这与第六十刀那次是同一个现象：
  拦路项拆掉之后露出来的是它后面挡着的东西（这一趟 `没有这个函数` 285 -> 296、
  `未声明的变量` 277 -> 284、`函数定义了两次` 146 -> 161 都涨了），而那几条的账在
  "标准库不在" 那一头，不是这一刀能买到的。

## 第七十八刀：字段的默认值 —— 它们是构造函数里的普通代码

尺子上排在形参默认值后面的那个真特性：**179 对** (文件, 拦路项)，1 份文件它是唯一的拦路项。

**jancy 那边的四件事**（同样是从源码量的 —— 文档里一句都没写）：

- **没有单独的预构造**。我第一遍猜的是 `FunctionKind_PreConstructor`，错了：初值是挂在
  `Field` 上的一串没编译的记号（`jnc_ct_Field.h:21-42`）；
- 重放它的人是 `MemberBlock::initializeFields`（`jnc_ct_MemberBlock.cpp:141-182`），
  而它是**从构造函数里面**调的 —— 要么在合成出来的默认构造里
  （`jnc_ct_DerivableType.cpp:909-927`），要么插在用户写的 `construct` 开头
  （`jnc_ct_Parser.cpp:2997-3010`）；
- 顺序是那四句：**基类构造 → 静态构造 → 字段初值 → 用户的体**（`jnc_ct_Parser.cpp:3005-3009`）。
  所以 `construct` 里再给同一格字段赋值会**盖掉**默认值；
- 有初值却没写 `construct` 的类型，jancy 给它**合成一格**（`jnc_ct_DerivableType.cpp:465-472`）。

也就是说：初值是构造体里的普通代码 —— 能引用 `this`、别的字段、方法、全局量，没有"必须是
编译期常量"这条要求。

**这一层的落法：合成语句，走原来那条路。** `int m_x = 5;` 在这一层变成 `m_x = 5;`
**这条赋值语句的 AST**（`fieldInitLines`），再交给原来的 `stmt` 降。于是"裸字段名补 `this`"
（selfField）、类型检查、结构体的按格拷贝、花括号初值、属性字段的赋值全都是原来那一套，
一处逻辑都没有第二份 —— 这是这一刀唯一值得记的设计选择：**不新开一条降级路径**。

接的两处：

- 用户写了 `construct`：`fnDef` 把那几行摆进 `pre`，位置在基类构造与静态构造之后、
  体之前（就是 jancy 那四句的第三句）；
- 没写：`synthCtors` 合成一格。它只在签名那一遍**登记**（`ctors` / `fns` / `methods` ——
  `C1 a;` 与 `new C1` 从那张表接），**体推迟到函数体那一遍之后**（`emitFieldInitCtors`）：
  初值里可以引用模块级变量，那些在签名那一遍还没登记。只有静态构造的那种类也走这条路，
  否则两处各发一格 `C$construct` 就重名了。

**一条界**：结构体的字段默认值**不收**（`bad/fielddefault-struct`）。jancy 那边它成立
（结构体没有构造就合成一格，嵌套的递归调），而这一层的结构体是**纯值** —— `S s;` 只降出
一格内存，没有"造出来的那个时刻"可以插代码，按值传、按值回、花括号初值、数组元素、
结构体里的结构体，每一处都是一格新的 `S`。要收下来得先给结构体长出构造那条路，那是自己一刀。
收下来却不发那几句赋值是个**静默的错答案**，所以明说。

**量出来的**：`tests/jnc` 160/0 -> **162/0**。`cases/75-fielddefault.jnc` 在六条腿上逐字节
相同，钉的是七件事：合成的构造、初值引用模块级变量、写了 `construct` 时体盖掉初值、初值引用
同一个类里**前面**声明的字段、初值调同一个类的方法、继承（基类的初值也跑，且在基类构造之后）、
`new` 与栈上那一格走同一条路。

**尺子（655 份）**：

- (文件, 拦路项) 对：8133 -> **7948**（−185）；
- 「没有还不收的行」的文件：142 -> **143**（+1）；
- 「真降得下来」（`sx` 退出码 0）：53 -> **54**（+1）—— 这一格从第六十刀起就没动过，
  这一刀是这几刀里第一次把它推上去的。

## 第七十九刀：函数重载 —— 先做按实参个数分得开的那一半

尺子上 `函数 '…' 定义了两次` **161 对**（1 份文件它是唯一拦路项）。那不是错，那是**重载**：
语料里 `bool errorcode open()` 与 `bool errorcode open(uint_t port)` 写在同一个类里
（`test/ioninja/plugins/Udp/UdpDispatch.jnc:45,49`）。

**jancy 的规矩（源码量的）**：

- 判合法的只有一样东西 —— `FunctionType::getArgSignature()`
  （`jnc_ct_FunctionType.h:289-326`）：那是**实参那一串**的签名。所以差在参数**类型**上就够，
  不必差在个数上；而**返回类型不算**（它拼在 argSignature 的起点之前），`errorcode` / `unsafe`
  / `async` / 调用约定也**不算**（`appendFlagSignature`，`jnc_ct_FunctionType.cpp:66-79`）——
  只差这些的两条是 `illegal function overload: duplicate argument signature`
  （`jnc_ct_FunctionTypeOverload.cpp:248-261`）。变参算（那个 `'.'`）。成员方法的 `this`
  是**真实参**，所以它也进签名。
- 登记：`Namespace::addFunction`（`jnc_ct_Namespace.cpp:603-660`）第二条时把那一格提成
  `FunctionOverload`；构造走 `MemberBlock::addUnnamedMethod`（`jnc_ct_MemberBlock.cpp:254-284`）。
  哪几种函数**不许**重载列在 `jnc_api/jnc_Function.cpp:60-88`（取值器、静态构造、析构、
  转换算符…），`construct` 与存值器许。
- 调用点：`FunctionTypeOverload::chooseOverload`（`jnc_ct_FunctionTypeOverload.cpp:44-91`）——
  每个候选算**一个标量**：`OperatorMgr::getArgCastKind`（`jnc_ct_OperatorMgr.cpp:721-759`）取
  各实参 `CastKind` 里**最差**的那个（`CastKind` 的档在 `jnc_ct_CastOp.h:26-35`：
  `None < Dynamic < Explicit < ImplicitLossyFuntionCall < ImplicitCrossFamily <
  ImplicitCrossConst < Implicit < Identity`）。取最高分，平手就
  `ambiguous call to overloaded function`；一个都不可行就
  `none of the %d overloads accept the specified argument list`。**没有** C++ 那种逐参数的
  偏序，就这一个标量。

**语料的形状（662 份，扫的是同一个作用域里同名的那些声明；方法见附注）**：

- 重载组 **159** 个（另有 1137 组是"同一个签名写了两遍"—— 类体里的原型加体外的定义，不算）；
- 只靠**实参个数**就分得开的：**92** 个（把末尾默认值算进"可接受的个数区间"之后）；
  要看参数**类型**才分得开的：**67** 个（57 个真同元，10 个是默认值让区间重叠）；
- 组的大小：123 个两条、27 个三条、7 个四条，最长的是 `log.Writer.write` **11** 条
  （`test/ioninja/api/log_Writer.jnc:16-90`）；
- `construct` 的重载 **14** 组；`errorcode` 与非 `errorcode` 同元撞车的 **0** 组。

**所以这一刀这么切的**：

1. **按实参个数**的重载收下来：`this.fns` 仍按方言名字存，第二条起改名成 `<全名>$o<元数>`，
   另开一张 `overloads: 基名 -> [方言名…]`（`overloadName`）；调用点按"给了几个实参"在候选里
   挑（`pickOverload`），挑完之后原来那一整段（默认值、个数、类型）一个字都没改。
   每个候选可接受的个数是一个区间 `元数 − 末尾默认值个数 .. 元数` —— 第七十七刀那格 `defs`
   现成的。改名要小心一处：owner 与"源码里那个方法名"必须从**没改名的**基名算，
   `C$open$o1` 按最后一个 `$` 切出来的 owner 是 `C$open`，那是错的。
2. **同元的**当场说还不收（**下一刀就是它** —— 见第八十刀，那一刀把这条界改成了"按参数类型
   挑，问不出类型才拒"）—— 要按参数类型排序，而这一层只有 `assignOk` 那个"是/不是"的答案，
   排不出序。jancy 那套（一个标量）可以照抄，但要先有一张这一层的隐式转换代价表。
3. **默认值让可接受个数重叠**的，界划在**调用点**（`bad/overload-defaults`）：两条声明本身
   收下来，撞车的那一句才拒 —— 只声明不那么调是合法的，jancy 也一样。
4. **虚方法上的**不收（`bad/overload-virtual`）：第五十七刀的虚派发是"整数标签 + 按标签分派"，
   分派表按**方法名**接，同名两条会撞在同一格上。
5. **重载过的名字当函数值用**不收：挑哪一条要看左边那格函数指针的类型，这一层还传不下来
   （jancy 那边是 `getFunctionPtrCastKind` 排序挑）。
6. `construct` 的重载（14 组）还不收：`this.ctors` 现在一个类一格，要变成一串。

**量出来的**：`tests/jnc` 162/0 -> **166/0**。`cases/76-overload.jnc` 在六条腿上逐字节相同，
钉五件事：自由函数的三条（0/1/2 个实参）、类的方法的三条（元数不算 `this` 那一格）、
方法体里**裸写**的重载调用（补 `this` 之后再挑）、命名空间里的重载、重载与末尾默认值一起。

**尺子（655 份）—— 这一趟三个数字往三个方向走，都得说清**：

- 「真降得下来」（`sx` 退出码 0）：54 -> **55**（+1）；
- 「没有还不收的行」的文件：143 -> **142**（−1）。这不是能力退了：那份文件里的同元重载，
  以前报的是一句 `E 函数 '…' 定义了两次`（普通错），现在报的是 `N 同元重载`（还不收）——
  同一件事换了个分类。**说得更准**换来的账面上的一格。
- (文件, 拦路项) 对：7948 -> **9006**（+1058）。也不是退：以前一份带重载的文件卡在
  "定义了两次"那儿，后面挡着的东西根本没露出来；现在重载过去了，它们一次全露出来
  （新榜首四条是同元重载的 367 对：3 个实参 124、2 个 92、1 个 86、4 个 65）。
  这条尺子量的是"还有多少拦路项看得见"，不是"离得多远" —— 一刀之后它涨，说明这一刀
  真的往前走了一段。真正的进度信号是上面那个 55。

## 第八十刀：同元的重载 —— 按参数类型挑，分不出来就不猜

第七十九刀留下的那一半：同元重载在尺子上是 367 对（3 个实参 124、2 个 92、1 个 86、4 个 65）。

**jancy 的挑法**（`FunctionTypeOverload::chooseOverload`，jnc_ct_FunctionTypeOverload.cpp:44-91）
是一个**标量**，不是 C++ 那种逐参数的偏序：每个候选取 `OperatorMgr::getArgCastKind`
（jnc_ct_OperatorMgr.cpp:721-759）—— 各实参 `CastKind` 里**最差**的那一档 —— 然后取最高分。
平手报 `ambiguous call to overloaded function`，一条都不可行报
`none of the %d overloads accept the specified argument list`。档次在 jnc_ct_CastOp.h:26-35：
`None < Dynamic < Explicit < ImplicitLossyFuntionCall < ImplicitCrossFamily <
ImplicitCrossConst < Implicit < Identity`。它自己的 `test/jnc/test32.jnc` 量的就是这条：
`foo(int)` / `foo(double)` 喂 `3.14` 挑 double、喂 `10` 挑 int。

**这一层的代价表**（`argCost`）照那个**相对次序**排，只是粗 —— 这一层可行的隐式转换本来就少
（量过：`double d = 1;` 收、`int i = 2.5;` 拒）：

- 4 完全一样（Identity）
- 3 int 之间（两个方向 jancy 都是 Implicit）、类的上转
- 1 int -> real（ImplicitCrossFamily，严格差于 Implicit）、bool -> int、枚举 -> int
- 0 合不上

挑法与 jancy 同一个算法（每条取最差的那一档、取最高分）。**次序一致**是这一刀的全部立足点：
我们给出答案时挑的与 jancy 是同一条；分不出来时说"还不收"，绝不猜。

**两处刻意与 jancy 不一样，都是"我们更保守"**：

1. **整数字面量不给"完全一样"那一档**。jancy 对常量的 int -> int 加宽算 `Identity`
   （jnc_ct_CastOp_Int.h:23-111），于是 `p(int)` / `p(long)` 喂 `1` 在它那儿是 ambiguous。
   这一层对字面量一律按"int 之间"（3）算 —— 两条同分、当场拒，与 jancy 一样不给答案。
2. **实参的类型问不出来就不排**（`bad/overload-argtype-unknown`）。这是这一刀真正的拦路石：
   排序要**先知道实参是什么类型**，而这一层的 `expr` 是**按 want 定向**的（`null` 要 want 才知道
   是哪种指针、花括号要 want、整数字面量的宽度也看 want），并且降的时候**会发码**（errorcode 的
   传播提升、提临时量）。所以不能"先降一遍拿类型、再按选中的那一条降第二遍"—— 那会把同一段
   代码发两遍。于是 `cheapTy` 只回**不降也知道**的那几种：字面量、`true`/`false`、
   以及查得着的名字（局部量 / 形参 / 模块级 / 方法体里裸写的字段 —— 那三个查名都是纯查表，
   不发一个字）。别的当场说清。要全收得先给 `expr` 加一格"只问类型、不发码"的干跑模式。

顺带把第七十九刀那个"同元就拒"的登记规则也改对了：登记时只有**实参那一串完全一样**才是
`定义了两次`（与 jancy 的 `getArgSignature` 同），别的都收下来当重载；名字从
`<全名>$o<元数>` 改成 `<全名>$o<序号>` —— 同元的两条现在能共存了，元数当不了名字。

**量出来的**：`tests/jnc` 166/0 -> **167/0**（`bad/overload-samearity` 从 bad/ 搬进
`cases/77-overload-types.jnc` —— 它现在过得去了）。那一份在六条腿上逐字节相同，钉五件事：
整数字面量挑 int、实数字面量挑 double、**变量**也分得开（不只是字面量）、类的上转
（`D*` 在 `q(B*)` 与 `q(int)` 之间挑前者）、元数与类型混着分。

**尺子（655 份）**：

- 「真降得下来」：**55，没动**；
- 「没有还不收的行」的文件：142 -> **143**（+1 —— 第七十九刀丢掉的那一格回来了）；
- (文件, 拦路项) 对：9006 -> **8803**（−203）。同元重载那 367 对从榜上消失了，剩下的是
  那两处保守里漏出来的零头。

## 第八十一刀：说明符里不写类型 —— 那时它是 void

尺子上 `这条声明没有类型` **121 对**。语料里 test/ioninja/ 到处这么写：

```jnc
virtual decodeName(std.StringBuilder* string) {}
override start() { … }
abstract reset();
```

**为什么它连得上语法**：`virtual` / `override` / `abstract` 在 jancy 那边是**存储说明符**，
不是类型说明符（jnc_ct_DeclarationSpecifier.llk:99-110），而 `declaration_specifier_list`
是 `declaration_specifier+` —— 一个存储说明符就够，类型那一支根本没走。

**那时的类型是 `void`**，规矩明写在 `Declarator::setTypeSpecifier`（jnc_ct_Decl.cpp:217-234）：
没有说明符就 `getPrimitiveType(TypeKind_Void)`；有说明符却没有类型名时，只有写了
`unsigned` / `bigendian` 的那一格退回 `int`（C 那条隐式 int 在 jancy 里只剩这一格）。
函数后缀接上去之后这个 `void` 就成了**返回类型**（jnc_ct_DeclTypeCalc.cpp:170-197 的
`getFunctionType`）。没有函数后缀的那一种（`virtual m_x;`）在 jancy 那边报
`illegal use of type 'void'`（jnc_ct_Parser.cpp:1094-1136 的 `case TypeKind_Void`）。

**文档里一个字都没写这条** —— 翻遍 `doc/language/rst`，函数的例子全写着返回类型
（decl_simple.rst:27 那种），`decl_advanced.rst:42` 拆解一条声明的各部分时也没说类型可以省。
所以这一条的出处只能是源码。这也是"只借语法与形式"这条纪律的一个实例：形式在语料里，
理由在源码里，两头都得对上才敢收。

**这一层的落法**就是那两行：`no-type` 的说明符回 `J_VOID`（写了 `unsigned` 的回
`unsigned int`），别的一个字没动 —— 函数后缀、虚派发、`return;` 全是原来那一套。
没有函数后缀的那些照旧被下游拦住（`virtual m_x;` 报的是"字段上写不了 virtual"，
`void m_x;` 报的是"字段只能是 …，这里是 void"）—— 都拒，只是理由比 jancy 那句更具体。

**量出来的**：`tests/jnc` 167/0 -> **168/0**（`cases/78-notype.jnc` 六条腿逐字节相同：
不写类型的 `virtual` / `override` / `abstract` 三种，虚派发照旧，`return;` 收得下）。

**尺子（655 份）**：`这条声明没有类型` 这一条从榜上**消失**（121 -> 0）；对 8803 -> **8777**
（−26 —— 那 121 走掉之后，那些文件往前走又露出来 ~95 条别的，与第七十九刀同一个现象）；
「真降得下来」55、「没有还不收的行」143，两个都没动。

## 第八十二刀：函数类型的 typedef —— 那个名字加一个 `*` 才是能用的东西

尺子上 `函数类型的 typedef` **119 对**。语料里的形状是固定的：起个名字，然后一律当**函数指针**用。

```jnc
typedef string_t FormatFunc(void const* p);       // api 那一片到处是
typedef void DynamicLayoutFunc(jnc.DynamicLayout* layout);
typedef RangeProcessor* RangeProcessorFactoryFunc();
```

**jancy 那边**：`typedef` 是存储类（DeclarationSpecifier.llk:83），后面跟普通声明符串，
声明符带函数后缀时算出来的就是一格 `TypeKind_Function`（`DeclTypeCalc` 的 `getFunctionType`，
jnc_ct_DeclTypeCalc.cpp:170-197）。而函数类型的**变量**在 jancy 里没有表示 —— 能用的只有
`F*`（`getFunctionPtrType`，同文件 674-685）。

**这一层的落法**：别名表里存一格新的类型 `fnty0`（就是"函数类型本身"，`tFnTy`）。它只有
一个用处 —— `ptrsTy` 碰到第一个 `*` 就把它换成 fnptr（第五十五刀那一格，一个字都不用改）。
一个 `*` 都不带的用法当场拒，而且拦在 **declarator 的出口**：那儿是所有声明符的唯一出口
（局部量、模块级、字段、形参、返回类型都从那儿拿 type），漏一处 `fnty0` 就会被当成一个真类型
带下去 —— 量过：那时下游报的是 `fnty0 的局部量不写初值`，一句给用户看不懂的话。

**顺带露出来一条界**：原来的 `bad/typedef-fn.jnc` 写的是 `typedef int F(int);` ——
形参**没有名字**。那一条现在过了 typedef 这一关，撞在后面的 `无名形参` 上。所以那份固件
改名成 `bad/formal-unnamed.jnc`，理由也换成真正拦住它的那一条（这一层的形参名字要用来发
方言里那一格 `(名字 类型)`，没有名字就得自己编一个，而编出来的名字会变成"源码里不存在的
名字"，往后按名字查形参的地方都会拿它去比）。**一条界被另一条挡着的时候，把前一条做掉就得
把后一条写清楚** —— 这是第六十刀起反复出现的同一个现象。

**量出来的**：`tests/jnc` 168/0 -> **169/0**（`cases/79-fntypedef.jnc` 六条腿逐字节相同：
`Binop*` 赋函数名再调、当形参传、`Binop thin*` 那一格）。

**尺子（655 份）—— 这一趟三个数字同时往好的方向走**：

- 「真降得下来」：55 -> **56**（+1）；
- 「没有还不收的行」的文件：143 -> **144**（+1）；
- (文件, 拦路项) 对：8777 -> **8624**（−153）。

## 第八十三刀：类里的事件 —— 第七十四刀退回来的那一格，前置拆掉之后落了

尺子上 `类里的事件` **113 对**。语料里 `event` 全是这个形状
（`test/ioninja/common/iox_HostNameResolver.jnc:42` 的 `event m_onCompleted();`、
`iox_FpgaUploader.jnc:80` 的 `event m_onUpdateCompleted(bool result);`）——
jancy 那边它就是类里的**一格字段**（与 bindable 属性那格 `m_onChanged` 同一支，
jnc_ct_Property.cpp:131-134）。

**第七十四刀试过一次、退回来了**，理由记在那儿：这一层的类降下来是 `(struct 根 …)` + `(ptr 根)`
（第五十二刀），而方言的结构体字段放不下"一格数组的句柄" ——
`形参 $this：结构体 'Button' 里有落不进内存的字段`。那堵墙由 **ADR-0024 的 S1/S2** 拆掉了
（`sizeOf((arr T))` 定成 8，JS 那一族用句柄表），所以这一刀才落得下来。

**落法是四处，一处都不新开机制**：

1. 类体那一遍把 `event m_e(实参…)` 登记成一格字段，类型是 `mcTy(那几格实参的类型)`；
2. **造对象时把单子建起来**：`(pstore (pfield (var $this) m_e) (anew (arr …) (int 0)))` ——
   发这几行的地方就是第七十八刀那一套（`fnDef` 的 `pre` 与 `emitFieldInitCtors`），
   排在源码写的字段初值**之前**（初值里可以写 `m_e += h`）；没写 `construct` 的类由
   `synthCtors` 合成一格，判据与"有字段初值"完全一样；
3. `mcRef` 认两种新形状：`obj.m_e` / `p.m_e`（`(pload (pfield 对象 m_e))`）与方法体里
   **裸写**的 `m_e`（走 `selfField`，`$this` 由那儿补）。member 那一支先按**名字**便宜地筛
   一次（`evtNames`）—— 对着任何 `a.b` 都去求左边那个对象会多发诊断；
4. `+=` 与"调用它"两处从 `mcRef` 拿到的 `store` / `code` 走字段读写，与顶层事件共用
   同一个多播助手（第七十三刀的 `jnc$mc_fire$…`）。

**界没动**：`-=` 还是不收（jancy 收的是 `+=` 回来的那格 cookie，这一层的 `+=` 还不回那一格 ——
`bad/bind-remove.jnc`，与顶层事件同一条）；结构体里的事件也还是不收（那一格要"造出来的时候
建单子"，而这一层的结构体没有构造那条路 —— 与字段默认值同一条理由）。

**量出来的**：`tests/jnc` 169/0（`bad/event-member.jnc` 从 bad/ 撤了 —— 它的主题现在过得去；
换进 `cases/80-class-event.jnc`，**六条腿逐字节相同**）。那一份钉五件事：`obj.m_e += h` 挂两个
处理函数、方法体里裸写事件名、单子是造对象时建的（`Button b;` 与 `new Button` 两条路）、
两个对象各有自己的一张单子、没写 `construct` 的类那格单子由合成的构造建。

**尺子（655 份）—— 三个数字同时往好的方向走**：

- 「真降得下来」：56 -> **58**（+2）；
- 「没有还不收的行」的文件：144 -> **146**（+2）；
- (文件, 拦路项) 对：8624 -> **8462**（−162）。

紧跟着的是 `#28` 那 104 对（类的成员上的 bindable 属性）—— 它走的是同一条路
（那格 `m_onChanged` 在 jancy 那边也是类里的一格字段）。

## 第八十四刀：类的成员上的 bindable —— 那格 `m_onChanged` 也是类里的一格字段

尺子上 `类的成员上的 bindable 属性` **104 对**。语料里 `bindable` 的主流写法压根不是顶层的
属性，而是**类的成员上的 bindable data**（`State bindable m_state;`，
`test/ioninja/plugins/TcpServer/TcpServerSession.jnc:68`；同一份 :59 `bool bindable
m_isTransmitEnabled;`、:73 `size_t bindable m_clientCount;`）—— 光写 `bindable` 不写
`property`，取值器与存值器**两个都是编译器生成的**（samples/jnc/34_BindableProperties.jnc:87-90
那句 "bindable data is a wholly compiler-implemented property"）。

第七十三刀把 `bindable` 接上时只接了顶层那一格，`bindStore` 里 `cls !== null` 是一句 nope，
理由记的是"这一层的事件是一格数组、方言的字段放不下"。**那堵墙是第八十三刀拆的**（它靠的又是
ADR-0024 的 S1/S2）—— 所以这一刀不新开机制，只是把第二种落法接上去，四处：

1. `bindStore` 的第二支：往 `ownFields` 里加一格 `(名字 (arr …))`，名字与顶层同一条规则
   （`<属性全名>$m_onChanged`，完整声明式里那个名字由写的人定 —— 第七十六刀），同时往
   第八十三刀那张 `evtFields` 里**追加**（不是盖掉：`typeDecl` 那一遍已经把类体里写的
   `event` 字段 set 进去了）。这一遍（`propName`）排在 `typeDecl` 之后、`classLayout` 与
   `synthCtors` 之前，所以那一格既进得了结构体，也让"这个类要不要一格合成的 construct"看得见；
2. 建单子那几行**一行没写**：`evtInitLines` 照着 `evtFields` 走，构造开头那一段与第八十三刀
   共用（`fnDef` 的 `pre` 与 `emitFieldInitCtors`）；
3. 存值器：bindable data 的成员那一格现在也**合成得出来**（原先只有顶层那一支）——
   `if (m_value != x) { m_value = x; fire(m_onChanged); }`，两格生成物都在对象里
   （`(pfield (var $this) …)`），实参顺序与 `propSet` 发的那一句对上（对象在前、值在后）。
   出处还是 `Property::compileAutoSetter`（jnc_ct_Property.cpp:788-822）那个 `!=`；
4. 读写那两格名字：手写的存值器体里裸写的 `m_value` / `m_onChanged` 是**对象里的两格字段**，
   换名的活儿归 `selfField` —— 原先那儿只认死了 `m_value` 一个名字，这一刀把它换成 `fnDef`
   摆的一张"源码里的名字 -> 字段名"的表（于是完整声明式里写的人自己起的名字也走同一条）。
   `bindingof(…)` 里头从只认 `propRef`（`p` / `a.p`）换成 `propTarget` —— 与读写属性同一处
   判定（第七十刀并的那一处），于是 `bindingof(obj.p)` 里那格对象由它算出来，`+=` 与 `= null`
   两处拿到的 `code` / `store` 就是 `(pload (pfield 对象 …))` / `(pstore …)`。

**记一笔账（与第八十三刀共有）**：`bindingof(obj.p) = h` 那一句里对象那段文本出现**两次**
（清空一次 + 加一个），所以对象那个表达式会算两遍 —— 写成 `bindingof(mk().p) = h` 就是两次
`mk()`。语料里左边全是 `this` 或一格变量，所以这一刀先记账不动；真要治就是"先把对象落进一格
临时量"。`obj.m_e = h` 那一格同理。

**界没动**：`-=` 还是不收（`bad/bind-remove.jnc`）；`bindingof` 用在不是 bindable 的属性上照旧
报 jancy 那句 "has no bindable event"（`bad/bindingof-plain.jnc`）。

**量出来的**：`tests/jnc` 170/0。`bad/bind-member.jnc` 从 bad/ 撤了 —— 它的主题现在过得去；
它撞上的那格新墙（属性声明了却没写存值器）换成 `bad/prop-noset.jnc` 单独钉住。
换进 `cases/81-propbindmem.jnc`，**六条腿逐字节相同**，尺子是手写的一份等价 C（`/tmp/c81.c`，
`cc -O0 -std=c99 -Wall`）。那一份钉六件事：成员上的 bindable data 读写走生成的那两个函数、
同值不通知、两个对象各带自己那一格事件、`bindingof(s.m_state)` 与方法体里裸写
`bindingof(m_state)` 两种订阅、`= null` 清空、手写存值器里裸写的 `m_value` / `m_onChanged`
指的是对象里那两格。

**尺子（655 份）—— 只有一个数字动了，说清为什么**：

- 「真降得下来」：58 -> **58**（没动）；
- 「没有还不收的行」的文件：146 -> **146**（没动）；
- (文件, 拦路项) 对：8462 -> **8333**（−129）。

前两个数字不动是**该的**：那 104 对散在几十份文件里（`sole 0` —— 一份都不是"就差这一格"），
每一份还压着 `import "*.jncx"`、`disposable`、`io.` 那一族类型、opaque class 的构造。

−129 是**逐项对齐两趟榜量出来的**（把改动 stash 掉跑一趟，两份日志对着减）：

- **−104**：这一格自己；
- **−29**：`属性 '…' 当一格可写的内存用`（59 -> 30）—— **这一格是记账上的搬家，不是真过去了**，
  说清楚：语料里到处写 `m_readParallelismProp.m_value = storage.readInt(…)`
  （`ui_BufferPropertySet.jnc:183`），而 `ui.IntProperty.m_value` 是
  `int bindable autoget property`（`api/ui_PropertyGrid.jnc:55`）—— 写了 `property` 就不是
  bindable data，存值器该由写的人给，而那些类是 **opaque class**（存值器在宿主的 C++ 那边）。
  先前那一句落在"属性当内存用"上，现在落在同一份文件里**本来就有**的
  `写属性 '…' —— 它的存值器没有定义`上，于是少了一格 (文件, 拦路项) 对、那一行还是没过去；
- **−15**：`bindingof(…) 里头要是一格属性`（17 -> 2）—— `bindingof(obj.p)` 这个形状认了；
- **+10 / +5 / +1×6**：`读属性 '…' 的取值器没有定义`、`string 不能当条件用` 之类 ——
  **往前走一步才看得见的下一格**，不是退步；
- `ui.*Property` 那八格 **±88 抵平**：报的话从"没有 construct"换成"construct 要 0 个实参，
  这里给了 1 个"。**这是这一刀的一个副作用**：那些 opaque class 里有 bindable 成员之后就有了
  "要建单子"的活儿，于是 `synthCtors` 给它们合成了一格无参 construct（判据与"有字段初值"同一条）。
  同一堵墙（构造在宿主的 C/C++ 那边）没动，只是撞上去的那句话变了。

榜上第十一位现在是 **103 对**的 `写属性 '…' —— 它的存值器没有定义`（`sole 0`）—— 那是这一格
后面紧挨着的下一格，而上面那 29 对搬过去之后它更实了。量清了它里头是什么：大头是
**opaque class 上的属性**（`ui.IntProperty.m_value` / `m_minValue` / `m_spinBoxStep` 这一族，
`api/ui_PropertyGrid.jnc:52-60`）—— 声明在 jancy 源码里、存值器在宿主的 C++ 那边
（opaque.rst:15-29）。所以它跟 `ui.*Property` 的构造是**同一堵墙**：要么有宿主面，要么给
opaque class 一条"声明当真、实现留空"的路。不是属性这一族自己的账。

## 第八十五刀：reactor —— 一条语句一格反应，依赖先按静态超集绑

尺子上 `修饰符 '…'` 那 160 对里的大头是 `reactor`。先把语料量清（662 份，60 份写了它、
111 处声明；下面这些数字都是拿"注释/串都认得的分词器 + 花括号配对"数出来的，不是行 grep）：

- **生产代码的唯一惯用法是"类里声明、体写在类外"**：`reactor m_uiReactor;` +
  `reactor Cls.m_uiReactor { … }` —— 49 处，**49/49 都成对**（同一份文件里），46 处名字
  就叫 `m_uiReactor`（例：`test/ioninja/plugins/Serial/SerialSession.jnc:109` 与 `:984`）；
- 就地带体的类成员 6 处、顶层 `reactor g_r { … }` 7 处，**都在 test/ 与 samples/ 里**；
- 带括号的 `reactor F() { … }` 语料里 **0 处**（文档 reactive.rst:38 那个写法滞后了）；
- 一格 reactor 上被叫到的**只有三个**：`.start()` 59、`.stop()` 2、`.restart()` 2，
  别的方法与字段 0 处；
- 62 个体、436 条顶层语句：赋值 **379（86.9%）**、调用 32、`onevent` 17、局部声明 5、
  `if` **3**、循环 / switch / return **0**。最大的体 23 条（`SshSerialSession.jnc:762`）；
- 582 处读：裸名 287、单层字段 207、**带下标或调用 79**、两层以上纯字段链 9；58 处在条件里。
  `m_state` 一个名字占 174 处。

**语法一个字没改** —— 三种形状本来就解得出来：`reactor Cls.m_r { … }` 是一格
`(fn-def (specs (no-type) (mods … "reactor")) (dcl … (qualified …)) (compound …))`，
`reactor m_r;` 是一格 `var-decl`（`reactor` 落在 mods 里），`onevent` 是自己一格节点。
所以这一刀全在 lower.js 里。

**jancy 那边是什么**（出处是源码，reactive.rst 只讲用法）：

- 一条 reactive_expression 进一次 `enterReactiveExpression`（`jnc_ct_Expr.llk:179-185` /
  `jnc_ct_Module.h:885-896`）—— **一条语句一格反应**，各自一个 reactionIdx；
- 依赖不是静态分析出来的：读一格 bindable 属性（右值）时顺手插一句
  `addOnChangedBinding(reactionIdx, 那格 onChanged)`（`jnc_ct_OperatorMgr.cpp:1441-1457`
  那个 `if (!(opFlags & OpFlag_KeepPropertyRef))` 里的 `addReactorBinding`，
  `jnc_ct_OperatorMgr_Property.cpp:409-428`）。所以**每跑一遍重收一次依赖**，
  分支变了依赖跟着变；被赋值的左值保持 property-ref，不绑。

**这一层的落法**：一格 reactor = 一格"跑没跑"的 bool + 一条语句一格反应函数 + `start`/`stop`。

1. 类里那句声明加**两格 bool 字段**（`…$on` / `…$bound`），体由 `reactor Cls.m_r { … }`
   那一遍挂上去；顶层那一格是两个模块级 bool。两格都在**对象里**是量出来的：`bound`
   先前是模块级的，于是"第二个对象 start"把订阅整个跳过了，那格 reactor 从此不动；
2. 反应 k 的体外面套一道 `if (跑没跑)`。所以 `stop()` 只是把 bool 关掉 ——
   **订阅还挂着**（这一层的多播摘不掉：`+=` 不回 cookie，第七十三刀那条边界）。
   记账：jancy 的 stop 是真摘掉；这一层是"挂着不干活"，代价是每次通知白跑一圈；
3. 依赖按**静态超集**收（`rctReads`）：扫这条语句的读位置，读到的 bindable 属性都算依赖，
   `start()` 里绑一次（`(apush 那格 onChanged (mkclo 反应 k 的 thunk 对象))`）。
   带 `this` 的函数值不用新造 —— 第五十五刀的 `(cfn …)` + `(mkclo …)` 就是它；
4. `onevent (事件…)(形参…) { … }` 是一格合成方法 + start 时往每格事件挂上去，闸门同反应。
   形参与事件的签名对不上当场报；
5. `restart()` = 先 stop 再 start，而 start 会把所有反应再跑一遍。语料那 2 处的注释是
   "need to re-bind DTE/DCE" —— 在这一层"重绑"是空操作（依赖是静态的），**要的那个效果
   （再跑一遍）有**。记账。

**两格账，都明写**：

- 反应会**多跑**：分支里的读也算依赖（`if` 只有 3 处、三元里 58 处读），jancy 只绑这一遍
  真读到的那些。多跑不会算错值（反应是重算），可它对带副作用的反应（`printf`、
  `updateLineInfoValue`）是可观测的；
- 对象要算出来的读（79 处）**明说不收**：`m_actionTable[…].m_text` 这种，订阅在 start
  那一刻绑的是那一刻算出来的那一格 —— 后来换了就绑错。`bad/reactor-dynobj.jnc` 钉住它。
  局部声明（5 处，其中 3 处是 `bindable` 局部）也还不收。

**量出来的**：`tests/jnc` 170/0 -> **172/0**。`cases/82-reactor.jnc` 六条腿逐字节相同，
尺子是手写的一份等价 C（`/tmp/c82.c`，`cc -O0 -std=c99 -Wall`），钉六件事：start 时先跑一遍、
bindable 变了那一条反应重跑、`onevent` 订阅的是写出来的那格事件、stop 之后不干活、
restart 是再跑一遍、两个对象各有自己的一格 reactor。

**尺子（655 份）—— 三刀以来第一次动了前两个数字**：

- 「真降得下来」：58 -> **61**（+3）；
- 「没有还不收的行」的文件：146 -> **154**（+8）；
- (文件, 拦路项) 对：8333 -> **8330**（−3）。

那 −3 要说清：`修饰符 '…'` 掉了 **15**（160 -> 145，就是 `reactor` 那一格），可**往前走一步
就看见下一格**，+12 落在 `未声明的变量`（+5）、`没有这个函数`（−6 但换了别的形状）、
`onevent 里头要是一格事件`（+3，那些 onevent 订阅的是 opaque class 上的属性）、
`X 里没有见到 reactor '…' 的声明`（+3）这几处。最后那一格值得记一笔：
那 3 处（`ModbusLayer.jnc:201`、`Df1Layer`）源码里**明明写了**那句声明 —— 拦在前面的是
**多继承**（`ModbusLayer.jnc:19`，2 个基类），整格类因此没登记下来，reactor 的体自然找不着
它的声明。所以那一格诊断里明说了"也可能是那个类的体里前面有一条还不收的"。

对得起这一刀的是前两个数字：**8 份文件从此一条"还不收"都没有**，3 份**整份降得下来**——
那正是 `reactor` 挡了很久的东西。

## 第八十六刀：`volatile` —— 收下、不看，代价写在这儿

第八十五刀之后 `修饰符 '…'` 还剩 145 对，拿 ioninja 那一支量了一下剩的是什么：
**`volatile` 29 处、`alias` 5 处**，别的没有。

`volatile` 在 jancy 那边是**类型修饰符**（`decl_advanced.rst:22` 那张表里就列着它），
落地是指针类型上的一位 `PtrTypeFlag_Volatile`（`jnc_ct_DeclTypeCalc.cpp:282-283`），
意思是"读它不许缓存"。它**不在** const 那个互斥组里（`jnc_ct_Decl.cpp:97` 那张
antiModifierTable 给它的是 0，所以 `readonly volatile` 一起写是合法的）。

语料里的声明只有两处 —— `uint64_t readonly volatile m_txTotalSize;` /
`m_rxTotalSize`（`api/log_Log.jnc:81-82`），可 `log_Log.jnc` 被到处 import，
于是它拦住的文件一大片。

落法与 `const` / `readonly` / `cmut` 那一族同一条：**收下、不看**。
**代价明写**：这一层没有线程，方言里也没有"这一格不许缓存"那一位 —— 真有别人
（宿主的 C++ 那边）在改这一格时，我们保证不了每次都重读。而语料那两格恰好正是
宿主在写的计数器，所以这一位等真有宿主面那一刀时要跟着落到方言里去。

`alias`（5 处）不在这一刀里：那是 jancy 的另一格声明（给一个名字起别名），不是修饰符。

**量出来的**：`tests/jnc` 172/0 不动（`cases/63-dualmod.jnc` 里那三格声明加上 `volatile`
——**输出一个字节都没变**，正好说明它是个 no-op）。尺子：`修饰符 '…'` 145 -> **85**（−60）、
(文件, 拦路项) 对 8330 -> **8269**（−61）；「真降得下来」61 与「没有还不收」154 都不动 ——
那 60 对散在一大片文件里，每一份后面还压着 `.jncx`、opaque class 与 `io.` 那一族类型。

## 第八十七刀：`alias` —— 另起一个名字，指同一格东西

`volatile` 之后 `修饰符 '…'` 剩 85 对，里头最大的一格是 **`alias` 37 处**（余下的
bigendian 20 / errorcode 18 / async 17 / disposable 11 各是自己一格账 —— `bigendian`
**不能**收下不看，字节序是可观测的）。

jancy 那边 `alias` 与 `typedef` 同族（都是存储类），一条 alias 就是"另起一个名字指同一格
东西"。语料里 55 处，四种形状：

- 类型别名：`alias State = iox.SshChannel.State;`（SshChannelSession.jnc:24），顶层的
  `alias ModbusStreamRoles = jnc.global.ModbusStreamRoles;`（ModbusDispatchCode.jnc:42）；
- 方法别名：`alias dispose = close;`（test61.jnc:25、io_WebSocket.jnc:123）—— 那是
  disposable 那个 duck-typed 模式的一半（disposable.rst 里那句 "usually *aliased* to an
  actual release method such as close"）；`alias toString = getString;`（io_Ethernet.jnc:89）；
- 顶层的函数别名：`alias bar = foo;`（test89.jnc:36）；
- **字段路径**别名：`alias m_head = m_list.m_head;`（stdt_Map.jnc:85-87）。

**语法又是零改动**：`alias Hue = Color;` 解出来是
`(var-decl (specs (no-type) (mods … "alias")) (dcls (init (dcl … (name Hue)) (name Color))))`
—— 一格 var-decl，`alias` 落在 mods 里，目标就是那个 `init` 的第二半（`dotted` 摊得平）。

**落法两支**：

- 目标是**类型** -> 进 typedef 那张表（`this.aliases`）。别名不是新类型，所以 `sameTy`
  看到的两边一模一样。顺带补了一处：`Hue.Green` 这种"经别名取枚举成员"先前查不着 ——
  枚举成员那一处只问 `this.enums`，现在别名表里存的是解出来的那一格，问它的 `name`；
- 目标是**函数 / 方法** -> 发一格**转手的**，签名照抄（`(fn Cls$dispose (($this …)) T
  (ret (call Cls$close (var $this))))`）。比"调用点查一张别名表"简单，而且虚方法、重载、
  当函数值用那几处一处都不用改。`obj.名字()` 那一处的便宜预筛表（`methodNames`）要跟着加。

**分两趟**：类型那一支当场就办（类型名那一遍在前面），函数那一支记在 `aliasPend` 上、
等签名那一遍过完再发 —— 那时才知道目标的签名。

**界**：字段路径的别名当时明说不收 —— 那一格要的是"名字 -> 一串取字段"的重写，读、写、`&`、
结构体拷贝四处都得跟着，与前两支不是一回事。（第一百〇四刀把它接上了，边界改成"路径逐段
解不开"，`bad/alias-badpath.jnc`。）


**量出来的**：`tests/jnc` 172/0 -> **174/0**。`cases/83-alias.jnc` 六条腿逐字节相同，
尺子是手写的一份等价 C（`/tmp/c83.c`）：类型别名（顶层与类里）、经别名取枚举成员、
顶层的函数别名、类里的方法别名四件事各钉一条。

**尺子（655 份）—— 这一刀的对数是 `+15`，说清为什么**：

- `修饰符 '…'`：85 -> **59**（−26，`alias` 那一格清了）；
- 新出来一格 `alias '…' 的目标 '…'`：**38 对**（sole 1）；
- 「真降得下来」61、「没有还不收」154、对数 8269 -> **8284**。

那 38 对里绝大多数**不是**字段路径的别名，而是 `alias State = iox.SshChannel.State;`
这一族 —— 目标那个类型来自 `.jncx` 与 `import` 不着的模块，这一层压根没有它，所以
"目标解不出来"。先前它们被 `修饰符 'alias'` 一句话盖住（那一格还与 `async`、`bigendian`
共用同一条计数），现在换成了一句**说得清是什么**的诊断，于是同一份文件里的对数从 1 变成 2。
**对数升了、话说清了**：这一刀真正接上的是"目标解得出来"的那些（类型、函数、方法），
而尺子这个口径按"(文件, 拦路项) 对"数，把"一句笼统的"换成"一句具体的"就会 +1。

顺带记一笔：`结构体里的 alias` 那一条原先落在"结构体字段的默认值"上（alias 那一句也长成
`(init …)`）—— 已经把这一问挪到字段那一遍的最前面，诊断说的是 alias 而不是默认值。

## 第八十八刀：调用点的空槽 —— `f(1,,3)` 就是"这一格用默认值"

榜上 `表达式 '…'` 那 116 对，量下来**全是同一个形状**：`unbound` —— 也就是调用点的
**空槽**（`f(1,,3)` / `f(,x)`）。语法早就有它（`jnc.grammar` 的 `opt-arg` 是一条空产生式），
只是降到表达式那一层没人认；语料里的写法例：`test/ioninja/common/ui_SocketUi.jnc:107`。

第七十七刀把形参默认值接上了，但只接**末尾**少给的那几格 —— 空槽当时是那一刀明写的边界
（"jancy 还允许 `f(1,,3)` 那种空槽"）。这一刀把它补上，落法与末尾那几格**一个字都不差**：
`withDefaults` 先扫一遍实参、把 `(unbound)` 换成那个形参默认值的**语法节点**，然后照旧补末尾。
于是空槽与写出来的实参走同一条路（同一份类型检查、同一句诊断），默认值的形状还是第七十七刀
那条窄界（字面量 / `true`/`false`/`null` / 枚举成员与它们的运算 —— 因为默认值在**调用点**
按调用点的作用域降，而 jancy 按声明处的命名空间，ParseContext.cpp:32-38）。

**界**：空着的那一格没有默认值时当场报错（`bad/argslot-nodefault.jnc`）—— jancy 那边空槽的
意思就是"用它的默认值"，没有默认值就无从可用。

**量出来的**：`tests/jnc` 174/0 -> **176/0**。`cases/84-argslot.jnc` 六条腿逐字节相同，
尺子是手写的一份等价 C（`/tmp/c84.c`）—— C 没有默认实参，所以那几处空槽在尺子里就是把
默认值**写出来**，而这正是 jancy 在调用点做的事。钉五件事：末尾少给、中间空一格、
两格空槽连着、`bool` 与枚举的默认值、方法上的空槽。

**尺子（655 份）—— 又是"话说清了、对数升了"**：

- `表达式 '…'`：116 -> **32**（−84，`unbound` 那一格清了；剩下的 32 是别的表达式形状）；
- 新出来三格 `第 N 个实参是空的，而它那个形参没有默认值`：**96 + 8 + 5 = 109 对**；
- (文件, 拦路项) 对 8284 -> **8309**（+25）；「真降得下来」61、「没有还不收」154 不动。

那 96 对（"第 1 个实参"）值得记清：它们是 `createGroupProperty(,, name, toolTip)` 这一族
（`api/ui_PropertyGrid.jnc:244` 起一长串）—— 被调的是 **opaque class 里声明的方法**，
真正的默认值在宿主的 C++ 那边，这一层只收了它的签名（`hostSigs`）、收不到默认值。
所以这一格与 `ui.*Property` 的构造、`写属性 … 存值器没有定义` 是**同一堵墙**：
要么有宿主面，要么给 opaque class 一条"声明当真"的路。空槽本身接上了 —— 一旦知道默认值，
它就走通（`cases/84-argslot.jnc` 那一份钉的正是这个）。

## 第八十九刀：形参表之后那格修饰符 —— `const?` 与 `thin`（一条读错了的注）

换个口径排了一遍尺子：**"每份文件只剩一条拦路项"（sole）现在有 102 份**，第一名不是语义，
是**解析错**。前三组：`unexpected "<"` 12 份（jancy 的模板容器 `stdt_*`，另一格账）、
`unexpected "thin"` 6 份、`unexpected "?"` 2 份。后两组是同一件事：

```jnc
bool errorcode parse(string_t string) thin;              // io_SocketAddress.jnc:121
MapEntry autoconst* find(variant_t key) const?;          // std_RbTree.jnc:57
construct() thin {}                                      // std_Guid.jnc:74
```

jancy 那条规则叫 `this_modifier_suffix`（`jnc_ct_Declarator.llk:512-525`），收的是**三个**：
`const`、`const?`（MaybeConst）、`thin`。而 `jnc.grammar` 里只写了 `const`，旁边那条注还写着
"jancy 这里只收 const（Declarator.llk:484..489）"—— **那是读错了**（484 那一带是形参表，
不是 this 修饰符）。这一刀把三个都补上，注也换成对的出处。

落地都是**收下不看**：那格修饰符说的是"`this` 那一格"的可变性与胖瘦，而这一层没有可变性检查
（与 `const` / `readonly` / `cmut` 同一条，第六十七刀）、也没有 thin 那格调用约定。语义那一侧
只要在两处把 `post-modifier` 放过去（普通声明符那一处、`construct` 那一处）。

**量出来的**：`tests/jnc` 176/0 不动（`cases/63-dualmod.jnc` 里给 `Box2.construct` 加了
`thin`、给 `Box2.sum` 加了 `const?` —— **输出一个字节都没变**）；`tests/glr` 的 jnc 表快照
从 360 条产生式 / 651 个状态变成 362 / 653，**冲突数没变**（新加的两条不带歧义）。

尺子（655 份）：对数 8309 -> **8294**（−15），「真降得下来」61 不动，而
**「没有还不收的行」的文件 154 -> 146（−8）—— 这个数字掉了，而这一刀是对的**。
说清：那 8 份先前**死在解析上**，一条 `N`（还不收）都还没来得及报，于是它们被算进了
"没有还不收"。现在解析过去了，往下走撞到的是真正的语义墙（`disposable`、`variant_t`、
opaque class 那一族），于是它们从那个数字里退出来。**这一格是那个口径先前被解析错撑起来的
虚高** —— 记在这儿，免得下一趟看见 −8 以为是退步。

## 第九十刀：文档里没列、源码里有的五格标准 typedef

`没有这个类型：'…'` 那 354 对里，**8 份文件只差它一条**。挑三份量了一下缺的是什么：
`std_MapEntry.jnc` 缺 `intptr_t` 与 `variant_t`、`ui_ListItem.jnc` 缺 `variant_t`、
`Proto_Raw.jnc` 缺 `log.Representation`（那是别的模块里的类型，另一格账）。
`variant_t` 是一整格动态值（另一刀），而 **`intptr_t` 这一格是一行表的事**。

顺着源码把那张表整份对了一遍 —— `TypeMgr::setupStdTypedefArray`
（`jnc_ct_TypeMgr.cpp:1758-1783`）里有 **`type_primitive.rst` 那份清单里没有的五格**：

- `intptr_t` / `uintptr_t` -> `TypeKind_IntPtr` / `_u`（这一层的指针是 8 字节，所以落成 64 位）；
- `utf8_t` / `utf16_t` / `utf32_t` -> **有符号**的 Int8 / Int16 / Int32（同处 :1766 / :1771 / :1776
  —— 不是无符号，照源码抄，文档一个字都没提这三格）。

语料里 69 处：`intptr_t` 31、`utf32_t` 14、`uintptr_t` 13、`utf16_t` 10、`utf8_t` 1
（例：`io_FileIdMgr.jnc:21` 的 `intptr_t readonly m_lastLoFileId;`）。

**这一刀就是 `INT_ALIASES` 里加五行**，出处写在旁边。**"文档没列的按源码算"这条又中了一次**
——第八十一刀（没写类型就是 void）、第八十九刀（`this_modifier_suffix` 收三个）都是同一条。

**量出来的**：`tests/jnc` 176/0 -> **177/0**。`cases/85-stdtypedef.jnc` 六条腿逐字节相同，
尺子是手写的一份等价 C（`/tmp/c85.c`）：把**有符号**那一条钉住（`utf16_t x = -1` 转 int 是 -1，
不是 65535）、宽度那一条也钉住（`intptr_t` 是 64 位），字段与形参上各走一遍。
尺子（655 份）：(文件, 拦路项) 对 8294 -> **8267**（−27），「真降得下来」61 与
「没有还不收」146 都不动 —— 那 8 份 sole 的文件里除了 `intptr_t` 还压着 `variant_t`
与别的模块的类型，所以这一格只把对数往下推了 27。

## 第九十一刀：`size_t` 是**无符号**的 —— 一处安静的错答案

第九十刀顺着 `setupStdTypedefArray` 对表时发现的：这一层把 `size_t` 落成 `J_I64`
（**有符号** 64 位），旁边那句注只写着"jancy 的语料里到处是它"。可 jancy 那边它是

```c
jnc_TypeKind_SizeT = jnc_TypeKind_IntPtr_u,      // include/jnc_Type.h:136
```

—— **指针宽的无符号整数**。这不是个名字问题，是三处会给出不同答案：

- 比较：`size_t n = -1; n > 0` —— jancy 说真，按有符号算说假；
- 除法 / 取模：`n / 3` —— 无符号是 6148914691236517205，有符号是 0；
- 右移：`n >> 60` —— 逻辑移是 15，算术移是 -1。

这一层**有**无符号那一格（`mkInt(w, u)`，各处运算按它选指令），所以先前那一行是个安静的
错答案，不是"反正看不见"。改成 `mkInt(64, true)`（这一层的指针是 8 字节）。

**量出来的**：`tests/jnc` 177/0 不动，而 `cases/85-stdtypedef.jnc` 里**加了那三句**——
它们是这一刀唯一的证据（改之前那三句会答 0 / 0 / -1）。尺子是同一份 C：C 的 `size_t`
本来就是无符号的，所以尺子那边一个字都不用绕。语料尺子三个数字**一个都没动**
（8267 / 61 / 146）—— 该的：这一刀改的不是"收不收"，是**收下来之后算得对不对**，
而尺子只量前者。这种刀的证据只能是 case 里那几句。

## 第九十二刀：顶层的函数原型 —— 签名那一遍已经过完了，所以这时候问得出来

`void foo(int x);` 这种"先声明、后定义"的 C++ 式写法，语料里 99 个 (文件, 拦路项) 对，
先前一句话挡掉：`顶层的函数原型（只收带体的定义）`。

挡掉是因为一个**看错了的顺序**。这一层的 `run()` 里，签名那一遍（`fnSig`，
`lower.js:1895`）排在 `globalDecl`（`:2017`）**之前** —— 走到那格原型的时候，
`this.fns` 里已经躺着这一份源码（加 import 摊进来的那些）里所有带体函数的签名了。
"这个名字有没有定义"这时候是个**能回答**的问题，不是个要往后推的问题。

于是这一格从"挡"变成三条分岔：

- **有定义**：这条原型是多余的一句 —— 跳过它。jancy 那边也只做这一件事（把两份签名对一下）；
- **签名对不上**：当场报。悄悄按其中一份算是骗人 —— 调用点按原型检查、体按定义编，
  两边就错开了（`bad/proto-mismatch.jnc`）；
- **没有定义**：那就是"实现在别处" —— 宿主的 C/C++，或者 import 不着的模块。
  这一层接不上，但说清是**这一种**：`原型 '…' 没有带体的定义（实现在宿主那边的走
  opaque class 那条路，在别的模块里的要 import 得着）`（`bad/proto-nobody.jnc`）。
  宿主那条路是第六十六刀 + ADR-0022 的 J4b。

**证据**：`cases/15-forward.jnc` 里加了三条原型（`isOdd` / `later` / `wrap`，覆盖
前向调用、全局初始化里的调用、返回结构体三种），输出**一个字节都没变** —— 这正是这一刀
要的：原型是句没有可观测效果的话。尺子是同一份 C（那份 C 里本来就有这三条原型）。
`node tests/jnc/run.js` = 179 passed, 0 failed。

**量出来的（诚实那一栏）**：

- `顶层的函数原型` 99 → **0**，可它没有凭空消失：新的 `原型 '…' 没有带体的定义` **99**。
  语料里这 99 个对**几乎全是**宿主实现（`jnc.` / `io.` / `ui.` 那些 extension lib 的
  声明头），所以这一刀在语料上换来的是**一句更准的话**，不是"能编了"；
- `没有还不收` 146 → **147**（+1）：只有一个文件因此走到了尽头之后的真拦路项；
- 对数 8267 → 8269（+2），`真降得下来` **61 不动**。

这跟第八十四刀是同一种账：**一句笼统的话换成一句具体的话，对数会涨、真降得下来不涨**。
它照样值得做 —— 下一刀该往哪儿走，是这些具体的话指出来的（这 99 个对现在明明白白指着
"宿主面"这一格，也就是 #28 与 opaque class 那条路）。

## 第九十三刀：`opaque class` 里那格没有体的 `destruct();` —— 宿主实现、GC 不定时，收下不落码

`destruct` 这一格是第五十三刀留下的两格之一，理由写得很硬：jancy 自己说
"the destructor is called by the garbage collector at an unspecified moment"
（disposable.rst:17），挑一个时机替它跑就是骗人。那条理由**对带体的 destruct 仍然成立**。

可语料量下来，这一格 178 个对里挡住的**几乎全不是**带体的那种：

- 11 份文件里它是**唯一**拦路项，其中 **10 份**是 `opaque class` 里一句
  `destruct();`（`sys_Event` / `sys_Lock` / `sys_NotificationEvent`、
  `ui_Widget` / `ui_Label` / `ui_Button` / `ui_LineEdit` / `ui_SpinBox` /
  `ui_StatusBar` / `ui_ColorRangeTree` —— 后几份是顺着 `import "ui_Widget.jnc"` 带进来的）；
- 剩下那 1 份是 `test/jnc/test138.jnc` 的**模块级** `destruct() { assert(false); }`，带体，照旧拦。

`opaque class` 里那一句跟这个类里别的原型是**同一种东西**：体在宿主的 C/C++ 里
（opaque.rst:15-29），这一层这儿一个字都发不出来。而"什么时候调"那一头 —— 调它的是 GC，
且是不确定的时刻；这一层没有 GC，那个时刻**永远不到**。两头都空，所以收下这一句、不落
任何代码，是**少做一件本来也看不见时刻的事**，不是把它算错。这跟第八十六刀（`volatile`
收下、不看）是同一种收法，只是这一格的"代价"更小：那边丢的是一条内存序，这边丢的是一次
本来就没有确定时刻的调用。

改动是类体那一遍里 `fn-proto` 那条岔路上的一行（`lower.js`，紧挨着第六十六刀那句
`hostCtors`）：

```js
if (cls && key === 'opaque class' && sk === 'destruct') continue;
```

**范围划得很紧**：只有 `opaque class` 里、只有**原型**（`fn-proto`）。普通 `class` 里的
`destruct();`（体在类外、就在这份源码里）与任何带体的 `destruct() { … }` 都照旧走
`specialNope` —— `bad/destruct-body.jnc` 守着这一边。

**证据**：`cases/62-opaque.jnc` 的 `Counter` 里加了一句 `destruct();`，输出**一个字节
都没变**（尺子还是那份 `/tmp/c62.c`）—— 这正是这一刀声称的事：这句话在这一层没有可观测
效果。`node tests/jnc/run.js` = 180 passed, 0 failed。

**量出来的**：三个数字同向，是这一路十来刀里最大的一次移动：

- **真降得下来 61 → 71（+10）**：正好是那 10 份文件，一份没退（对着上一趟的 ok 名单逐份比过）；
- **没有还不收 147 → 160（+13）**；
- **(文件, 拦路项) 对 8269 → 8198（−71）**：全部来自这一组（178 → 107），别的组净零。

榜上有几个 sole 涨了（`没有这个类型` 8 → 11、`结构体里的方法` 0 → 1、`函数指针字段`
0 → 1）—— 那是文件走得更远之后露出的下一格，跟前几刀同一回事。

**代价，写在这儿**：语料里有 **12 个** `opaque class` 声明了 `destruct();` 却**没有**声明
`construct();`（`ui_Widget:Widget`、`ui_Menu:Menu`、`log_Log:Log`、`doc_Storage:Storage`
等）。这一格的 `new` 不落在第六十六刀那个 `hostCtors` 的拦网里，所以那种对象**造得出来、
析构永远不调，而且一声不响**。这不是这一刀新开的洞（`opaque class` 在这一层整个没有宿主面，
它那些方法本来也都是空的），但它是这一刀之后**能走到的**一个洞 —— 记在这儿，等宿主面
（ADR-0022 的 J4b）那一刀一起收。

## 尺子的一个盲点：语料里有些文件**本来就不是一份一份编的**

第九十三刀之后榜首那几组的 sole 名单看着不对劲，逐份查下来发现的：

- `没有这个类型` sole 11 —— 5 份是 `variant_t`（#35），**4 份**是
  `Field` / `Function` / `Type` / `log.Representation` 这种"名字在**同目录另一份文件**里
  声明着，而这一份一句 `import` 都没写"，1 份是 `test/jnc/test147fail.jnc`（名字里带
  `fail`，它**本来就该被拒**）；
- `没有这个基类` sole **7 份全是**这一种（`opaque class ArrayType: Type`、
  `class Filter: AbstractProcessor` …）。

原因在 jancy 那一侧：扩展库与 ioninja 插件的那些 `.jnc` 是**一组一起**进同一个 module 的
（`jnc_ext` 的 CMake 把整个目录 glob 进去；插件那边是 `.ini` 列源码表），所以它们相互之间
不需要 `import`。尺子一份一份编，这些文件**永远编不过** —— 那不是这一层的墙，是尺子的口径。

**没有改尺子**（那三个数字的历史可比性比这一格重要），而是拿一次一次性的量法看了一眼：给
目录里所有 `.jnc` 生成一份 `import` 全家的壳，编那一份。四个真"一组"的目录量出来：

- `src/jnc_ext/jnc_std/jnc`（19 份）：整组**只剩一条**错 ——
  `stdt_Array.jnc:19:12 unexpected "<"`，也就是 `class Array<T>`。别的 18 份一条错都没有。
  这一条记进 ADR-0025 的判据里；
- `src/jnc_ext/jnc_rtl_intro/jnc`（21 份）：**多继承 16 处**（2 个基类 9、3 个基类 7）压着，
  后面才是 `没有这个类型` 3、`未声明的变量` 3。一份一份编时这组文件报的是"没有这个基类"，
  一起编才看得见真正拦路的是第五十六刀那条单继承的界；
- `src/jnc_ext/jnc_sys/jnc`（4 份）：`原型没有带体的定义` 7（宿主面）+ `没有这个函数` 6；
- `test/ioninja/api`（44 份）：`未声明的变量` 48 / `没有这个函数` 36 / `没有这个类型` 31 ——
  这一组还得先有宿主面，量它意义不大。

**结论写在这儿，供后面几刀用**：单文件那三个数字仍然是主尺（可比、便宜），但**挑刀的时候**
要把上面这一格盲点算进去 —— `没有这个基类` 那 110 对 / 7 份 sole 一刀都换不来，而
`多继承`（榜上只有 34 对 / 4 份 sole）在 `rtl_intro` 那一组里是**第一道**墙。

## 第九十四刀：多个基类 —— 一整块继承图共用一格结构体，上转照旧发零条指令

第五十六刀只接单继承，理由是那一刀的落法：**一条链共用一格方言结构体**，字段是链上的并集，
于是 `D*` 与 `B*` 本来就是同一个方言类型，上转发零条指令、方言一个字都不用长。两个基类
当时看着要"同一个对象里两段基类 + 指针按偏移重解释"，所以退回来了。

**量清之后发现那一步不用走。**把"一条链"换成"一整块由继承连起来的连通图"，同一套落法照旧
成立：`D: B1, B2` 时 D、B1、B2 三家的字段并进**同一格**结构体，三个方言类型是同一个，
上转还是零条指令。语料量下来这也不是取巧 —— 35 处多基类声明里，**35 处**的第二格起基类
一个字段都不带（rtl_intro 那些 `opaque class` 的数据全在宿主那边，体里只有属性与方法），
所以"并进一格"这件事在语料上连一次字段合并都没发生。

落下来的是这几处（都在 `lower.js`）：

- `this.mixins`：类名 -> 第二格起的那些基类。第一格照旧待在 `this.bases` 里 —— 它是链那条
  脊梁（`basetype` 不带序号时指它）；
- `dirBases(c)` / `baseWalk(c)`：直接基类那一串、连所有祖先按**先广后深**排一遍。
  `isBase` / `findMethod` / `findProp` / `findVirt` / `absLeft` / `rctOf` 全改成按它走 ——
  六处原来都是 `while (cur = this.bases.get(cur))` 那条单链；
- `classLayout`：环检查改成图上的 DFS；根用并查集（第一格基类的根胜出，所以**单继承时
  与第五十六刀那时一个字不差**）；
- 构造：`callBaseTypeConstructors` 在 jancy 那边是**复数**（jnc_ct_Parser.cpp:3005）——
  `baseCtorCalls` 现在收的是"源码显式调了第几格"的集合，没写的那几格逐格自动补；
- `basetype2` .. `basetype9`：原来一句 nope，现在指第二格往后（type_class.rst:226）。

**两条边界留着，各有一份 bad/ 守着**：

- `bad/multibase-shared.jnc`：同一个基类到得了两遍（`D: B1, B2`，B1/B2 都从 A 来）。
  jancy 那句是 "**multiple instances of shared bases** -- if any" —— 一个 D 里有两份 A，
  `m_a` 是两格内存。这一层一格图一格结构体，两遍只有一份，所以当场拒；
- `bad/multibase-field.jnc`：两格基类带同名字段。jancy 那边是两块内存，这一层会合成一格 ——
  也拒。不同名的合得起来（那正是 `cases/86-multibase.jnc`）。

**证据**：`cases/86-multibase.jnc` 覆盖两格基类各自的字段与方法、`basetype1.construct(a)`
显式调 + 第二格自动补、`basetype2.two()`、往两格基类各上转一次；尺子是 `/tmp/c86.c`
（`cc -O0 -std=c99 -Wall`，把两段基类摊平成一格结构体 —— 与这一层落出来的形状一样），
六行输出逐字节相同。`node tests/jnc/run.js` = 182 passed, 0 failed；
`bad/class-multibase.jnc` 那份"刻意划的边界"删了 —— 它就是这一刀。

**量出来的（诚实那一栏）**：

- `(文件, 拦路项) 对` 8198 → **8164（−34）**，正是 `多继承` 那两行（2 个基类 24、3 个基类 9、
  `basetype2` 那句 1）**清零**；
- `没有还不收` 160 → **170（+10）**；
- **`真降得下来` 71 → 71，没动。**这一刀在单文件尺子上换不来一份新的可执行文件，原因是
  上一节那个盲点：那 4 份 sole 全在 `jnc_rtl_intro`，走过多基类这一格之后撞上的是
  `没有这个基类：'ModuleItem'` —— 基类在同目录另一份文件里、而那一份没写 `import`。
  榜上 `没有这个类型` 332 → 347、`没有这个基类` 110 → 117（sole 7 → 3）就是这一批文件
  走得更远之后露出来的；
- 真正换来东西的地方在**整目录一起编**那个量法上：`jnc_rtl_intro`（21 份）的错
  **27 → 13**，其中 `多继承` **16 → 0**、`未声明的变量` 3 → 0。这一组现在只剩
  `没有这个类型` 5 与属性那一族 5。

## 第九十五刀：类体里就带着体的 reactor —— 一个登记登错了地方的洞

顺着榜上 `未声明的变量` 那两份 sole 查出来的，是第八十五刀留下的一个**洞**，不是一格没做的
功能。`test/jnc/test16.jnc:12-21`：

```c
class C1 {
	int bindable m_x;
	int bindable m_y;
	bool m_b;

	reactor m_reactor {
		m_b = m_x != 0 && m_y != 0;      // 报：未声明的变量 'm_b'
	}
}
```

第八十五刀量到语料里生产代码**只用**"类里声明、体写在类外"那一种（49/49），于是那一刀
只在类体那一遍认 `reactor m_r;`（一格 var-decl）。可 `reactor m_r { … }` 写在类里时，
语法上它是一格 **fn-def**，而 fn-def 在 `nsFlat` 那一遍被提到了顶层 —— 于是只有
`reactorBody` 那一遍看见它，登记成了 `cls: null` 的**顶层** reactor。后果就是那一句报错：
体里裸写的字段名接不上 `this`（`selfField` 要 `selfClass`，那时是 null）。

落法是**把登记搬回该在的地方**：类体那一遍的 fn-def 分支上问一句"specs 上写着 reactor 吗"，
是就当成员登记（两格 bool 字段 `…$on` / `…$bound` 进 `fields` —— 必须赶在 `classLayout`
之前，那两格是类里的字段），并把这一格 fn-def 记进 `this.rctInline`（按**节点**记）；
`reactorBody` 那一遍见到记过的就只认"这是一格 reactor 的体"，不再当顶层那一格登记一遍。
`emitReactors` 一个字没改 —— 它本来就按 `r.cls` 摆 `selfClass` / `this` 别名。

顺手把 specs 上那一问与"声明符上不带前缀的名字"抽成 `rctSpecs` / `rctDeclName` 两格方法，
两处（第八十五刀那一遍与这一刀）共用。

**证据**：`cases/82-reactor.jnc` 加了一格 `class Inl`（`reactor m_r { m_seen = m_x * 2; }`
写在类里）与三行输出，钉的是"体里裸写的字段名接上了 this"和"两个对象各有自己那一格订阅"；
这三行的尺子是 `/tmp/c95.c`（`cc -O0 -std=c99 -Wall`：bindable 落成"值 + onChanged 单子"、
一条反应一格函数、start 挂上并先跑一遍）。`node tests/jnc/run.js` = 182 passed, 0 failed。

**量出来的**：`真降得下来 71 → 73（+2）` —— `test/jnc/test16.jnc` 与 `test/jnc/test23.jnc`
（`reactor m_MyAutoEv { … }` 也写在类里），一份没退；对数 8164 → 8157（−7）；
`未声明的变量` 289 → 287（sole 2 → 1，剩下那一份是 `test107.jnc` 的 `sys` 命名空间 ——
宿主面）；`没有还不收` 170 不动（这两份文件本来就没有"还不收"，卡的是一句普通错）。

## 第九十六刀：无名的枚举 —— 成员漏到外面那层命名空间里

语料 38 处、31 份文件（`io_PcapFile.jnc:13` 那三格签名与版本号、`XModem.jnc:13`、
`BacNetMsTp.jnc:14` …），先前一句 `认不出的枚举名字` 挡掉 105 对。语法早就认得它
（`jnc.grammar` 的 enum 规则第二条产出 `(enum key (anon) …)`），挡在的是"名字取不出来"。

jancy 那边无名枚举**隐含 exposed**，两处源码说得很直：

```c
if (name.isEmpty()) { flags |= EnumTypeFlag_Exposed; … }   // Parser.cpp:2587-2589
flags &= ~EnumTypeFlag_Exposed; // unnamed enums imply 'exposed' anyway
                                                          // EnumType.cpp:409-411
```

exposed 的意思是成员**直接坐在外面那层命名空间里**（`Namespace.cpp:736` 那句注反过来说了
同一件事："exposed enum, not unnamed"）—— 也就是 C 的无名 enum。

落法：给那一格枚举编一个碰不到的名字（`$anon<序号>`，`$` 不在 jancy 的标识符里），成员照旧
记在那一格枚举上、值的类型**还是那一格枚举**（所以 `bitflag` 的 1/2/4 与默认底类型 32 位
有符号都不用另写一份），另外记一张 `exposedMems`：外面看到的名字 -> 那一格成员。查名时在
三处多问一次 —— 表达式里的裸名字（排在"未声明的变量"之前）、`ns.Inner` 这种整体是一个名字
的 field 串（排在"把左边当值算"之前）、以及 `constInt`（数组长度与别的枚举的初值要算得动）。
名字那一遍与体那一遍拿同一个编出来的名字，靠一张按**节点**记的 `anonEnum`。

`enumName` / `enumDecl` 里那两处 `qname` 抽成了一格 `enumSelfName`，两遍共用。

**边界**：两格无名枚举漏出同一个名字当场报（`bad/anonenum-dup.jnc`）—— jancy 那边这是
`addItem` 失败，谁赢都不对。

**证据**：`cases/87-anonenum.jnc` 钉五件事：裸名字读得着、底类型默认 32 位有符号
（所以 `0xa1b2c3d4` 是 −1582119980）、`bitflag` 那一格照旧 1/2/4、编译期算得动
（`int g_arr[Major + 1]` 的 `countof` 是 3）、命名空间里那一格要写 `ns.名字`；有名字的那一种
一个字没变。尺子是 `/tmp/c87.c`（C 的无名 enum 是同一句话），四行逐字节相同。
`node tests/jnc/run.js` = 184 passed, 0 failed。

**量出来的（诚实那一栏）**：

- `认不出的枚举名字` 105 → **0**；对数 8157 → **8088（−69）**；
- `枚举成员的值算不出来` 95 → **105（+10）**，`没有还不收` 170 → **169（−1）** —— 这两个是
  **同一件事**：`io_PcapFile.jnc`（先前那 105 对的唯一 sole）现在走过了 enum 这一行，撞上
  下一格 `PcapFileSignature = '\xa1\xb2\xc3\xd4'` —— 多字符字面量，这一层算不出来。
  它于是从"只有普通错"变成"有一格还不收"。这一格照旧记着，是下一刀的候选；
- `真降得下来` 73 不动。

## 第九十七刀：`'a'` 是一个**整数** —— 一句安静的错答案

上一刀末尾记着的那一格：`io_PcapFile.jnc:14` 的 `'\xa1\xb2\xc3\xd4'` 算不出来。查下去发现
不止那一格 —— 这一层的词法把**单引号**那一格也做成了 LITERAL（跟双引号同一种）：

```
(string LITERAL "\"")
(string LITERAL "'")      // 先前
```

于是 `int a = 'a';` 报的是"初值的类型是 string，声明的是 int"。语料里字符字面量
**125 处、32 份文件**（`hexEncoding.jnc` 的 `' '` `'\t'` `'.'`、`escapeEncoding.jnc` 那一整张
转义表、`log_RecordFile.jnc` 的 `':gol'`、`io_DeviceMonitorNotify.jnc` 的 `'nomt'`）。

jancy 的词法把它做成 `TokenKind_Integer`，头一个字节**最重**、最多 8 个字节
（jnc_ct_Lexer.cpp:186-197）：

```c
uint64_t result = 0; uint_t shift = 8 * (length - 1);
for (; p < end; p++, shift -= 8) result |= *(uchar_t*)p << shift;
```

落法两处：

- `jnc.grammar`：单引号那一格换成自己一格 token（`(string CHAR "'")`），主表达式上加一条
  `(-> (CHAR) (char $1))`。表跟着重生成 —— **363 rules / 654 states**（先前 362 / 653，
  就多这一条产生式），`node tests/glr/run.js` 20/0；
- `lower.js` 的 `charLit`：转义在词法那一遍已经解开了，这儿把码位折成字节再按 jancy 那句折成
  整数。**怎么数字节记一笔**：`\xa1` 要的是一个字节，所以每格码位 < 256 时按 latin1 数，
  真写了非 ASCII 字符时才按 UTF-8 数（jancy 那边源码就是字节流）。类型走 `intLit` 那条老
  规矩（装得下 int、装不下 long）—— `0xa1b2c3d4` 正是"装不下"那一格，赋进 32 位枚举成员时
  回卷成 −1582119980。`constInt` 也认这一格：`enum { Sig = '…' }` 与 `int a['z' - 'a' + 1]`
  都要算得动。

**自举那一格的代价**：第一版用了 `Buffer.from(s, 'latin1')`，`node tests/bootstrap/link.js`
当场红了 —— `unresolved identifier 'Buffer'`。自举的那个 JS 子集里没有它，所以 UTF-8 那几行
手写了一遍。这条是这一层的常规约束，记在这儿。

**证据**：`cases/88-charlit.jnc` 钉六件事：`'a'` / `'\t'` / `'\0'`、多字节的 `'ab'` = 24930、
`'\xa1\xb2\xc3\xd4'` 进枚举、编译期算得动（`countof(g_alpha)` = 26）、当 `char` 用并进
`%c`、以及减法与比较。尺子是 `/tmp/c88.c` —— C 的多字符字面量与 jancy 同一个字节序，
六行逐字节相同。`node tests/jnc/run.js` = 185 passed, 0 failed；`link.js` 2/0；`glr` 20/0。

**量出来的**：`真降得下来 73 → 74（+1）` —— `io_PcapFile.jnc`（上一刀末尾记着的那一份）
整份下来了；对数 8088 → **8076（−12）**；`没有还不收` 169 不动。

这一刀的账要说清：它换来的不只是那 12 对。先前那 125 处**没有一处报错** —— 它们悄悄变成了
串，然后在某个类型检查上撞出一句看着无关的话（"初值的类型是 string"）。这种"安静的错答案"
与第九十一刀（`size_t` 是无符号的）同一类，尺子量不出来，只有 case 里那几行能钉住。

## 第九十八刀：`print(s)` —— 原样写出去的那一格

榜上 `没有这个函数` 那 5 份 sole 逐份看下来：`rand`（1 份）、`jnc.collectGarbage`（1 份，GC）、
以及 **3 份 `print`**（`test95.jnc` 与两份 `jnc_sample_0{4,5}_pass_c{,pp}`）。语料里 `print`
用了 **36 处**。

它在 jancy 那边不是关键字，是 `jnc_std` 那格宿主库里的一个普通函数：

```c
JNC_MAP_FUNCTION("print",     jnc::std::print)      // jnc_std_StdLib.cpp:891
```

签名 `void print(string_t text)`，语义是"把这一格字符串**原样**写出去" —— 不添换行、也**不**把
内容当格式串再解释一遍。方言里现成的就是 `(write …)`（printf 那条路上 `$"…"` 走的也是它），
所以这一格**没长出任何新东西**：`printCall` 只做三件事 —— 实参个数要是 1、格式化字面量走
`fmtLit` 那条现成的路、别的按一格字符串降，然后发一句 `(write …)`。

**它不是关键字这件事落在了那一问的位置上**：`print` 那一支排在"这个名字有没有别的定义"
之后（`lookupRef` 与 `this.fns` 都问一遍），所以源码里自己写了 `print` 的按自己那个算 ——
`cases/90-print-own.jnc` 反过来钉这一条。

**证据**：`cases/89-print.jnc` 钉四件事：连着两句拼成一行、**裸 `%` 不再被解释一遍**
（`print("100% sure")`，这是与 printf 最要紧的差别）、实参是一格 `string_t` 变量、
以及格式化字面量。尺子是 `/tmp/c89.c`（C 那边就是 `fputs`）与 `/tmp/c90.c`。
`node tests/jnc/run.js` = 187 passed, 0 failed；`link.js` 2/0。

**量出来的（三个数字全动，逐个说清）**：

- `真降得下来 74 → 75（+1）`：`test/jnc/test95.jnc` —— 它先前唯一那一句就是 `print`，
  现在一条错都没有；
- `没有还不收 169 → 167（−2）` 与 `对数 8076 → 8078（+2）`：这两个数是**同一件事** ——
  `jnc_sample_04_pass_c` 与 `jnc_sample_05_pass_cpp` 走过 `print` 之后撞上了下一格
  `格式化字面量里的 char*`（jancy 走 `appendFmtLiteral_p` 按 NUL 读一段内存，这一层的 `%s`
  只认 `string`）。它们于是从"只有普通错"变成"有一格还不收"。这一格记着；
- `没有这个函数` 290 → 285（sole 5 → 2）：剩下那两份是 `rand`（C 的 `::rand`，
  jnc_std_StdLib.cpp:879 —— 这一层没有随机数，而且拿它做 case 也钉不住输出）与
  `jnc.collectGarbage`（GC 那一族，disposable 那条账的同一格）。

## 尺子停在哪儿（第九十八刀之后）与下一批的候选

```
降得下来 75、没有还不收 167、(文件, 拦路项) 对 8078       ; 655 份；第九十八刀之后
降得下来 75、没有还不收 167、(文件, 拦路项) 对 7783       ; 第一百〇三刀之后（−295）
降得下来 75、没有还不收 167、(文件, 拦路项) 对 7783       ; 第一百〇四刀之后（一格没动，账在那一节）
降得下来 75、没有还不收 167、(文件, 拦路项) 对 7702       ; 第一百〇五刀之后（−81，只动了默认值那一格）
降得下来 75、没有还不收 167、(文件, 拦路项) 对 7711       ; 第一百〇六刀之后（+9，−67 −4 +80，账在那一节）
降得下来 75、没有还不收 167、(文件, 拦路项) 对 7681       ; 第一百〇七刀之后（−30，−43 +4 +9）
降得下来 76、没有还不收 168、(文件, 拦路项) 对 7738       ; 第一百〇八刀之后（真数字第一次动；对数 +57 是新露出来的地形）
降得下来 77、没有还不收 169、(文件, 拦路项) 对 7731       ; 第一百〇九刀之后（真数字又各 +1；−7 = 修饰符 −6 + 级联 −3 + 走得更远 +2）
```

榜首那几组逐组分了类，**挑刀时按这个分类看，别按对数排**：

- **尺子的口径**（一刀都换不来，见上面那一节）：`没有这个类型` 347 里那 4 份、
  `没有这个基类` 117 的 3 份 sole 全是"名字在同目录另一份文件里、而这一份没写 import"；
  另有 1 份是 `test147fail.jnc`（名字里带 fail，本来就该拒）；
- **宿主面**（ADR-0022 的 J4b 那一刀）：`原型没有带体的定义` 99、`写属性…存值器没有定义`
  103、`未声明的变量` 那 1 份 sole（`sys` 命名空间）、`没有这个函数` 剩下的 2 份
  （`rand` / `jnc.collectGarbage`）、`import "std_*.jnc"` 那两条 98 + 91；
- **没有可对的答案**：`bitflag enum 里的负值` 168 / sole 9 —— jancy 那句
  `2 << getHiBitIdx64(负数)` 是 C++ 的未定义行为，答什么都是猜；
- **方言的墙**：`main 里 return 一个非 0 的值` 110 / sole 3 —— 方言的入口没有退出码，
  而进程的退出码是看得见的。要么方言长出这一格（MIR 与四个后端都要动），要么这一格永远在。
  这是**唯一**一条"决定一下就能清掉三位数"的，可它不是一刀，是一个 ADR；
- **还没做的语言格**（真能一刀一刀掉的）：`结构体里的方法` 94 / sole 1、
  `null 得从左边知道类型` 98、`默认值那个形状`（第一百刀之后 84 —— 见那一节末尾量到的两件事）；
  第一百〇一 / 一百〇二 / 一百〇三刀之后这一栏改成：`null 得从左边知道类型` 103
  （量过：`want` 已经传下去了，卡的是"`string_t` 能不能是 null"，属于 string / variant 那一族）、
  `默认值那个形状` 84；**这一栏里原先还挂着"`字段路径的别名` 42 / sole 2"，那是记错了** ——
  第一百〇四刀落下来之后三个数一格没动，那 42 对逐份数出来是 52 处宿主面的原型 + 7 处解不开的
  点串类型名、字段路径 0 处（账在第一百〇四刀那一节；第八十七刀那一节其实早就写着这句话了）；
  `默认值那个形状` 那 84 对第一百〇五刀清掉了 81，剩 3 份是函数调用当默认值（界内该拒的）；


- **不能一起收的一组**：`修饰符 '…'` 63 对 / sole 4 看着像第八十六刀（`volatile` 收下不看）
  那种便宜活，量下来**不是** —— 里头是三种性质完全不同的词：`bigendian`（字段的字节序，
  "收下不看"会给出**错答案**：读出来的数不对，必须拦）、`async`（协程，明确的大件）、
  `errorcode`（第五十八刀那一套已有，这里报出来是因为它出现在**还没支持的位置**上）。
  要分三刀，别当一格看；

  **第一百〇八刀之后重量了一遍（这一行涨到 78 对，按真话拆成 11 个词）**，每个词的判据：

  ```
  36 份 / 212 处 / sole 2   bigendian    必须拦（错答案）
  31 份 /  46 处 / sole 1   async        协程，大件
   6 份 /  14 处 / sole 1   disposable   与第九十三刀同族：它管的是**时机**，这一层没有 GC
   4 份 /   4 处            weak         没有 GC，"收下不看"至多是不回收，不给错答案
   2 份 /   3 处            cdecl        这几个是**调用约定** —— 在 arm64 / x86-64 SysV 上
   2 份 /   3 处            stdcall      三者本来就是同一套 ABI，收下不看是**对的**；
   1 份 /   1 处            thiscall     哪天真加 32 位 x86 Windows 目标，得原样拿回来
   1 份 /  14 处            safe         默认就是它
   1 份 /   3 处            unsafe       忽略只会拒得更严，不会放过错的
   1 份 /   1 处            mutable
   1 份 /   1 处            indexed
  ```

  也就是说这一行里**便宜且不给错答案的只有 5 份文件**（调用约定 + safe/unsafe + mutable +
  indexed），212 处的 `bigendian` 与 46 处的 `async` 一格都不能白拿。别再拿这一行 78 对挑刀；
- **`声明符后缀 'bitfield'` 17 份 / 90 处**（第一百〇八刀之后才露出来的）：结构体里的位域。
  要方言的布局认位宽 —— 与 `sizeof` 那一条同族，是方言那一侧的账；

- **也是尺子的口径**（第一百刀之后逐份查出来的）：`枚举成员的值算不出来` 97 里的 3 份 sole
  全是 `Start = ui.StdColor.PastelPurple` 这种 —— `StdColor` 在同目录的 `ui_Color.jnc` 里，
  而这一份没写 `import`。跟 `没有这个基类` 那 3 份是同一回事；
- **两格已经量过、账写在别处的大件**：`variant_t`（`没有这个类型` 347 里 5 份 sole，#35）
  与**泛型**（ADR-0025：整个 `jnc_std` 那 19 份只差 `stdt_Array.jnc` 一个 `<T>`）。

上一刀末尾记着的那一格也在这儿：`格式化字面量里的 char*` 3 对 / 2 份 sole ——
jancy 走 `appendFmtLiteral_p` 按 NUL 读一段内存，这一层的 `%s` 只认 `string`。它要的是
"从一格指针按 NUL 读出一格字符串"，方言里现在没有这一步，所以它跟 `main` 的退出码一样，
是**方言那一侧**的账，不是这一层能一刀解决的。

## 第九十九刀：默认值挂在哪一格形参上都行 —— 一条第八十八刀之后就该撤的拦子

`形参 '…' 有默认值，它后面这一个没有 —— 默认值只能挂在末尾那几个上` 100 对。那句话里的
理由是第七十七刀写的："没有具名实参，中间空一格调用点说不清"。**第八十八刀已经把那一格
说清了** —— `f(1,,3)`，空槽就是"这一格用默认值"。这条拦子从那一刀起就是多余的。

jancy 那边本来也没有"必须在末尾"的规矩：它检查默认值是**按位置一格一格**问的 ——
`OperatorMgr_Call.cpp:421-435`（实参给到了但那一格是空的）与 `:447-460`（实参没给够），
两段循环报的都是 `argument (%d) of '%s' has no default value`。

所以这一刀就是**撤掉那六行**，外加把个数那句诊断里的"末尾 N 个有默认值"改成"其中 N 个"。
`withDefaults` 一个字没动 —— 它本来就是按位置查的（中间那格没有默认值时它停下，由个数那一句
报），这也正说明这条拦子拦的不是它。

**证据**：`cases/91-defmid.jnc` 里 `int f(int a = 1, int b, int c = 3)` 四种叫法
（都给、`f(, 8, 7)`、`f(9, 8)`、`f(, 8)`）加一格只有末尾默认值的 `g`，六行。尺子是
`/tmp/c99.c` —— C 写不出"中间那格有默认值"，所以那份把四种调用**各自展开**成完整调用，
要对的正是展开之后那几个数。`node tests/jnc/run.js` = 187 passed, 0 failed；`link.js` 2/0。

`bad/argdefault-middle.jnc` 删了 —— 它的注释里自己写着"jancy 比这宽 …… 这一层没有那种
空槽写法"，而那半句在第八十八刀之后已经不成立。**这类"理由被后来的刀作废了的边界"值得单独
留一眼**：它不是被这一刀推翻的，是第八十八刀落地时漏掉的一处跟进。

**量出来的**：对数 8078 → **7976（−102）** —— 那 100 对清零，另外 2 对是两处跟着不报了的
连带；`真降得下来` 75、`没有还不收` 167 都不动（那 100 对散在 80 多份文件里，每一份后面
还压着别的）。

## 第一百刀：形参的默认值写在**原型**上

`第 1 个实参是空的，而它那个形参没有默认值` 96 对。逐份看下来全是同一个形状
（`ui_PropertyGrid.jnc:233-245`）：

```c
GroupProperty* createGroupProperty(
    Property* parentProp = null, Property* beforeProp = null,
    string_t name, string_t toolTip = null);              // 类体里的原型：默认值在这儿

GroupProperty* createGroupProperty(string_t name, string_t toolTip = null) {
    return createGroupProperty(,, name, toolTip);          // 第八十八刀的空槽
}

GroupProperty* PropertyGrid.createGroupProperty(
    Property* parentProp, Property* beforeProp, …) { … }   // 体外的定义：不再写一遍
```

jancy 的默认值挂在 `FunctionArg` 上（`hasInitializer`），而"类里写原型、体写在类外"那种放法里
它**只出现在原型上**。这一层的签名那一遍看的是**定义**，于是那几格默认值整个丢了 ——
同一份文件里那句空槽调用就报"那个形参没有默认值"。**先前那句诊断是对的，错的是它前面那步。**

落法两处：类体那一遍见到方法原型时把默认值那几个语法节点按 `类名$方法名#元数` 记进
`protoDefs`（只**照着语法树记**，不走 `formalList` —— 那一遍会发诊断，而这份形参表马上还要
由体外那个定义再过一遍），然后签名那一遍之后一格 `mergeProtoDefs` 并进去：按元数在重载那一族
里挑，定义上自己写了默认值的**不动**（那时按定义那一份算）。

**证据**：`cases/92-protodef.jnc` 钉三件事 —— 原型上的默认值管用（`c.add(7)` / `c.add()`）、
原型上"默认值挂在哪一格都行"（第九十九刀）配上空槽（第八十八刀）能用（`c.mk(,, 4, 3)`）、
定义上写的照旧。尺子 `/tmp/c100.c` 把各种调用各自展开。语料里那个形状还多一层**同元重载**，
那一格留给 `ui_PropertyGrid.jnc` 在尺子上量 —— 全 int 的两条在这一层与 jancy 那边都真的
分不出来（"ambiguous call to overloaded function"），所以这一份不掺重载进来。
`node tests/jnc/run.js` = 188 passed, 0 failed；`link.js` 2/0。

**量出来的（这一刀的账最值得看，掉的与涨的都在同一个因果链上）**。对数 7976 → **7930
（−46）**，把 stash 前后两份榜逐行对下来是：

- **清零的**：`第 1 / 2 / 3 个实参是空的` −96 / −5 / −8 = **−109**；
- **跟着不报了的**：各种"要 N 个实参，这里给了 M 个" −25（默认值补上之后个数就对了）；
- **涨的（这一刀直接的后果）**：`这个形状的默认值` 3 → **84（+81）**、
  `null 得从左边知道自己是哪种指针` 98 → 103（+5）。默认值现在**找得着了**，于是
  `defShapeOk` 与 `null` 那两条界第一次真被这些默认值撞上 —— 前者拦的是
  `int spacing = Def_Spacing` 这种**裸名字**（`ui_ToolBar.jnc:51`：那是个枚举常量，
  而 `defShapeOk` 现在只认 `E.A` 那种写法），后者是 `= null` 落到调用点之后左边那格
  类型还没传下来。
- `真降得下来` 75 与 `没有还不收` 167 都不动。

那 +81 是**下一刀**，可它比看着的深一层 —— 试了一趟、量清之后退回来了，量到的两件事记在这儿：

1. `defShapeOk` 确实该认"裸名字指着一格编译期常量"。那 81 对里的形状是
   `int spacing = Def_Spacing`（`ui_ToolBar.jnc:28-51`）—— `Def_Spacing` 是**类体里一格无名
   枚举**的成员，也就是第九十六刀那种漏到外层的。
2. **可光加那一问不够**：默认值是在**调用点**降的，而这个名字只在**声明处**解得开。
   `Def_Spacing` 那格无名枚举由 `aggHoist` 提到顶层时带的命名空间是**那个类**
   （`T.$anon1` / 成员 `T.Def_Spacing`），所以调用点（比如另一份文件的 `main`）里
   `resolve('Def_Spacing')` 找不着它 —— 该找的是**被调那个函数的宿主类**那一层。
   试过"声明那一处就把名字改写成解出来的全名"（一格纯改写、值与类型都不动），量下来**不行**：
   类体那一遍跑在那格嵌套枚举登记**之前**，那时 `exposedMems` 还是空的。

所以这一刀要的是"默认值连它**声明处的命名空间**一起记着"（或者等价地：把那一步改写挪到所有
类型都登记完之后再做一遍）。那是 defs 那条链上五六处的口径改动，单独一刀做，别掺在这一刀里。

## 第一百〇一刀：结构体里的方法

`结构体里的方法` 94 对（`test/jnc/test43.jnc` 那一份的唯一拦路项就是它）。jancy 的 struct
也是一层命名空间、也能有方法。

**这一刀便宜是因为第十二刀早就把地基打好了**：这一层**结构体那一格里放的就是地址**。于是
`this` 那一格直接用它，与类那条路（第五十二刀）落法一模一样 —— 一个自由函数、`this` 当第一个
形参，调用点一条指令都不用多发，方言一个字没改。三处对上：

- `aggHoist` 现在也把 struct 体里的方法提到顶层（ns = 结构体名），于是"体内写"与"体外写
  `int P.scaled(int k)`"落在同一格 `P$scaled` 上；
- `fnSig0` 里那格 `this` 的类型是**结构体自己**（类是一条引用 `tClass`）；
- 那格 `this` **不抄** —— 第十三刀的"结构体形参按值传、进门先抄一份"对它不适用：jancy 那边
  结构体方法的 this 也是个指针，`c.bump(2)` 改得动 c。这一条要是漏了，`shift` 改的就是一份
  拷贝，而且**不报错** —— 所以 case 里专门有两行钉它。

`methodCallee` 那一处多认一种左边：结构体的值、以及 `P*`（jancy 那边 `p->foo()` 与 `p.foo()`
是同一件事）。

**范围**：`construct` / `destruct` 在结构体里还不收（构造那一族是自己一刀），裸写的
`get` / `set` 是下标运算符那一族、照旧拦，虚方法在结构体上明说不收（虚派发要对象头那一格
类型标签，结构体没有）。**语料里那两处 construct 的形状量过了**：`std_Guid.jnc:74-76` 是
`construct() thin {}` 加 `construct(string_t string) thin { … }` —— 也就是说它压在**构造的
重载**那一格后面（类那边同一格也还没收：`第二个 'construct'（构造的重载要重载决议）`），
不是"结构体的构造"单独一刀就能落的。

**证据**：`cases/93-structmeth.jnc` 钉四件事 —— 体写在里面 / 只写原型体在外面 / 方法里叫方法
（`this` 由这一层补）/ 改得动这一个对象（含经 `P*` 改）。尺子 `/tmp/c101.c` 就是"第一个参数
是 `P*`"的那份 C，四行逐字节相同。`node tests/jnc/run.js` = 189 passed, 0 failed；`link.js` 2/0。

**量出来的**：对数 7930 → **7852（−78）**。逐行对下来：

- `结构体里的方法` **−94**（清零）；
- 涨的 +16，全是"走过这一格之后露出来的下一格"：`结构体里的 '…'`（`construct`/`destruct`）+6、
  `sizeof` +2、`限定名或特殊名的声明符` +2、`把 …Crc 转成 char*` +2×3、`没有这个函数` +1；
- `真降得下来` 75 与 `没有还不收` 167 都不动。

顺手修了一处**同一件事报两遍**：第一版把 struct 体里的嵌套类型与 `construct` 也提上去了，
于是 typeDecl 就地那一句与提上去之后 fnSig0 那一句都发（`只收 struct 与 class` +15、
`只能是类的成员` +6）。改成"结构体那一侧只提方法"之后那两笔归零 —— 对数因此又少了 21。

## 第一百〇二刀：结构体里的 alias —— 上一刀的直接推论

第一百〇一刀把"结构体里的方法"收下之后，榜上露出来 `结构体里的 alias` 6 对
（`io_Socket.jnc` / `io_Ethernet.jnc` / `io_Arp.jnc` 那几份都是 `alias toString = getString;`
这个形状）。第八十七刀那一格当时只在类里办，理由是那时结构体上根本没有方法可指 —— 现在有了。

改的是三行：`aliasDecl` 里 `this` 那一格的类型从写死的 `tClass(cls, false)` 换成一格
`selfTy(owner)`（类是一条引用、结构体那一格里放的本来就是地址），加上把类体那一遍里
`if (!cls) nope('结构体里的 alias')` 撤掉。类型别名那一支一个字都不用改 —— 它本来就只往
typedef 那张表里写。

**证据**：`cases/83-alias.jnc` 里加了一格 `struct Box`（`alias tripled = val;` 与
`alias K = Num;`）与两行输出，尺子是 `/tmp/c102.c`（一个转手的函数 + 一个 typedef）。
`node tests/jnc/run.js` = 189 passed, 0 failed；`link.js` 2/0。

**量出来的**：对数 7852 → **7846（−6）**，正是那 6 对；`真降得下来` 75 与 `没有还不收` 167
不动 —— 那 6 份文件后面压着的是 `variant_t` 与宿主面。

顺手记一条**语法上的**边界（不是这一刀新拦的）：`alias Num = int;` 这种"目标是内建类型
关键字"的写法解析不了 —— alias 的目标那一格语法上要是个**名字**。语料里没有这种写法
（都是 `alias State = iox.SshChannel.State;` 这种指着一个名字的），所以记在这儿就够。

## 榜上一句**名字起错了**的诊断：`局部的函数原型` 那 69 对其实是 `T v(a, b)`

第一百〇二刀之后往榜中段翻，`局部的函数原型` 69 对（sole 0）看着像"函数体里写原型"，
逐份查下来**一处都不是**：

```c
ui.Action action(icon, text);      // test/ioninja/api/doc_Plugin.jnc:80
```

这是 C++ 那个"最令人烦恼的解析"—— 语法上它与"带形参表的声明符"长得一模一样，语义上是
**造一个局部对象、把 `(icon, text)` 当构造实参**。所以那句诊断的名字是错的：它说"这是个
函数原型（还不收）"，而源码里根本没有原型。

**这一层其实已经有它要的两半**：第五十三刀的"声明符尾巴上的构造实参"（`info.ctor`）在局部量
那条路上是**通的**（`lower.js:6023` 与 `:6083` 那两处），缺的只是**把语法树那一格认回来** ——
GLR 在这一处让"形参表"那条产生式赢了，于是 `info.formals` 非空、先撞上 `:6020` 那句 nope。

**落法与判据（下一刀照这个做）**：

- 判据：`info.formals` 里**每一格都是 `(formal-anon specs ptrs)`**（无名形参 —— 语法上
  `A a(x, y)` 的 `x` / `y` 就是"只有类型没有名字"的那种）、`ptrs` 是空的、`specs` 里只有
  一个名字（没有别的说明符词），并且这一格声明的类型是**类**且有 `construct`；
- 改写：把每一格 `formal-anon` 的那个名字读回成一格 `(name X)` 表达式，攒成实参表塞进
  `info.ctor`，`info.formals` 清成 null —— 之后走的就是第五十三刀那条现成的路；
- 判不出来的（`specs` 里真是个类型、或者带了 `*`）保持现在这句 nope，但**把话改对**：
  它该说"这一格看着像形参表，可局部量上不该有形参表"。

先只把这条记下来，不半落地 —— 改写语法树那一步要摸清 `specs` 的内部形状，值得单独一刀。

**试落过一趟，回退了，失败在哪儿量清了**：判据那半是对的（照上面写完 `ctorArgsOf`，
`tests/jnc` 189/0 一分不动），**改写那半造错了节点** —— 直接把 type-spec 归约出来的那一格塞进
`(name …)` 里，下游 `resolve()`（`lower.js:1458` 的 `nm.replace`）拿到的不是字符串，当场崩。
也就是说 type-spec 那一格与表达式里 `(name ID)` 的 `items[1]` **不是同一种东西**。下一次先把
`qname()` 收哪几种形状摸清，稳的做法大概是**不造 `(name <那一格>)`**，而是先 `qname(ts)` 解成
字符串、再造一格 `(name <atom 字符串>)`。

## 第一百〇三刀：`A a(x, y);` —— 那对括号是构造实参，不是形参表

（上一节记的就是这一刀的账：`局部的函数原型` 那 69 对名字起错了。第二趟落成了。）

**判据与"怎么当实参用"都在 `ctorArgsOf`**：每一格都得是无名形参
（`(formal-anon specs ptrs)` —— 语法上 `x` 只有"类型"没有名字）、`ptrs` 空、`specs` 两侧的
mods 都空、而那一格 type-spec 归约出来的正是一格 `(name <ID>)`。凑齐了就把那几格**原样**当
实参用 —— 那个节点在表达式那一侧本来就是"一个名字"，**一个节点都不用新造**。之后走第五十三刀
那条现成的路（`info.ctor`）。

**第一趟栽在哪儿（这条值得记住）**：判据那半一次就对，改写那半我造了 `(name <那一格>)` ——
而 `qname()` 要的是 `items[1]` 是 **atom**，于是它答 null、下游 `resolve()` 拿 null 去
`replace` 当场崩。教训是：**语法树里"同名的壳"不等于同一种东西** —— type-spec 归约出来的
`(name <ID>)` 与表达式里的 `(name <ID>)` 恰好是同一种，所以原样用就对；而再套一层就全错。

**判不出来的照旧拦，但话改对了**：`int` 那种内建类型关键字、限定名、带 `*` 的 —— 报的是
`局部量上的形参表（'T v(a, b)' 那种构造实参只有类的变量收得下）`（`bad/local-formals.jnc`）。

**证据**：`cases/94-localctor.jnc` 钉三件事：两格实参、一格实参且实参是另一格局部量、以及
"与 `new A(…)` 是同一个构造"。尺子 `/tmp/c103.c`。`node tests/jnc/run.js` = 191 passed,
0 failed；`link.js` 2/0。

**量出来的**：对数 7846 → **7783（−63）** = `局部的函数原型` **−69** + `未声明的变量` −1
+ 涨的 +9（全是走得更远之后换来的**具体**话：`ui.GroupBox 的 construct 要 0 个实参` +2、
`ui.Action 的 construct 的第 1 个实参要 ui.Icon*` +1、`jnc.RegexState 没有 construct` +1、
`alias 的目标` +2、新的 `局部量上的形参表` +2 …）。`真降得下来` 75 与 `没有还不收` 167 不动 ——
那 69 对散在语料里 ioninja 那一片，每份后面还压着宿主面。

## 第一百〇四刀：字段路径的 `alias` —— 落对了，可是尺子上一格都没动

第八十七刀收了 `alias` 的类型那一支与函数 / 方法那一支，**字段路径**那一支当时刻意留着
（`bad/alias-fieldpath` 就是那条边界）。这一刀把它接上。

**落法**：`名字 -> 一串取字段`。声明那一刻就逐段在字段表里解开（`this.structs` 对类与结构体
都有那张表），记下路径与末端的类型进 `aliasPath`；查名的两处**各展开一次**：

- `obj.别名` —— `memberOf` 里"没有这个字段"之前先问一句（`lower.js:6546`）；
- 裸写 `别名` —— `selfPathLv`（`lower.js:1589`），基那一格是 `$this`，写那一侧挂在 `nameLv`、
  读那一侧挂在表达式的 `name` 分支。

**两处缺一处就是半成品**：第一趟只挂了写那一侧，`return m_len;` 当场报 `未声明的变量 'm_len'`。

展开出来的是货真价实的一串 `(pfield … )`，所以读、写、`++`、`+=`、后面继续取字段、整格拷贝
这几条一处都不用另外管 —— 与"源码里真把那一串写出来"走的是同一条路。类字段那一格里放的也是
地址（第十二刀），所以叠 `pfield` 时不用分辨中间那一格是类还是结构体；层数也没有上限。

**证据**：`cases/95-aliaspath.jnc` 钉七行输出 —— 语料那个形状（类里 `alias m_head =
m_list.m_head;`）、裸读、裸写、`++` 与 `+=`、`obj.别名` 读写、别名后面继续取字段、别名指着
一格结构体时整格拷贝、以及结构体里的**两层**路径（第一百〇二刀 + 这一刀）。尺子 `/tmp/c104.c`。
路径解不开的仍旧拦（`bad/alias-badpath`）。`node tests/jnc/run.js` = 192 passed, 0 failed；
`link.js` 2/0。

**量出来的：`75 / 167 / 7783` 三个数一个都没动 —— 这一刀在尺子上的价值是 0。** 榜上那一行
`alias '…' 的目标 '…'` 也照旧是 42 对 / sole 2，只有话变了。为什么，我把那 42 份文件挨个跑了
一遍、把真报出来的目标抠出来数（59 处）：

- `dispose` = `close` 29、`release` 4、`stop` / `hide` / `cancel` 各 1；`toString` = `getString`
  8、`fromString` = `parse` 8 —— 共 **52 处，全是方法别名**，而那些目标（`void close();`、
  `string_t getString() thin const;`）都是**没有带体的原型**，实现在宿主那边。挡住的是宿主面
  （ADR-0022 J4b），不是别名。
- `State` = `iox.SshChannel.State` 5、`jnc.global.ModbusStreamRoles` / `…HalfDuplexMode` 各 1
  —— 共 **7 处，是点串的类型名**，外面那一格（`iox.SshChannel` / `jnc.global`）在这一趟里解不开。
- **字段路径 0 处。**

语料里的字段路径别名一共就三行，全在 `class MapBase<T>` 里
（`src/jnc_ext/jnc_std/jnc/stdt_Map.jnc:85-87`）—— 那份文件在泛型那一格上先倒了，压根走不到
alias 这一行。所以这一刀真正的前置是 ADR-0025 那个 `<T>`：**泛型落下来的那天，这三行不用再改
一个字就通了**。

**记这一笔的意思**：任务 #37 上写的"42 对 / sole 2"是我把榜上那一行整格算给了字段路径 ——
**判据错了**。更该记住的是：第八十七刀那一节里**已经写着这句话**（"那 38 对里绝大多数不是
字段路径的别名，而是 `alias State = iox.SshChannel.State;` 这一族"），十七刀之后我拿榜上的
行去挑刀，把自己写过的账覆盖掉了。榜上一行诊断底下可以压着好几种毫不相干的原因，按行认账
会高估。往后拿榜挑刀，得先把那一行**按真报出来的内容拆开数**，像这一节这样；而且落刀前先
翻一眼那一格自己以前写过的账。刀本身没白落（它是第八十七刀明写着欠的那一格、也是 stdt_Map
唯一还差的一格），但它的账是"补齐了一格语言的槽"，不是"降了 42 对"。


## 把榜上头几行**拆开**数了一遍（第一百〇四刀那一课的直接后果）

上一刀吃的教训是"按行认账会高估"。所以这一趟把尺子那张榜的前几行按**真报出来的话**逐份
拆开数了（一次性的 `/tmp/board-split.mjs`，走的是尺子同一张 RunCache，口径一个字没改，
所以不重编）。`份数 / 处数 / sole` 三栏里，**sole 是按真话算的**：这份文件从头到尾只被这
一句话挡住。

`E 没有这个类型` **347** 对拆开：

```
131 份 /  999 处 / sole 5   variant_t
110 份 /  216 处 / sole 0   std.Error
 90 份 /   91 处 / sole 0   std.StringHashTable
 80 份 /   80 处 / sole 0   FormatFunc
 77 份 /  163 处 / sole 0   std.Guid
 64 份 /  112 处 / sole 0   std.Buffer
 41 / 40 / 38 / 38 份       ui.ChecksumInfoSet / ui.StdSessionInfoSet / …InfoSet / …PropertySet
… 另有 291 种
```

`E 没有这个函数` **286** 对拆开：`readInt` 92、`addProperty` 88、`addWidget` 84 份 / **320 处**、
`addSpacing` 81、`addItem` 81、`std.setError` 52、`addPart` 43 份 / **817 处** —— sole 全 0。

`E 未声明的变量` **285** 对拆开：`prop` 88 份 / **2376 处**、`key` 90、`label` 81、
`comboBox` 81、`item` 80 —— sole 全 0。**这一整行是级联出来的**：根在
`ui_PropertyGrid.jnc:420` 那一句

```jancy
GroupProperty* prop = new GroupProperty(name);   // ui.GroupProperty 没有 construct，给不了构造实参
finalizeCreateProperty(prop, …);                 // 于是这里、以及后面每一处用 prop 的地方
return prop;                                     // 都再报一遍"未声明的变量 'prop'"
```

声明那一句失败之后**那一格局部量压根没登记**，于是一个根错误放大成几十条派生错误。
`prop` 那 2376 处几乎全是这么来的。

顺带两条也拆清了：`bitflag 里的负值` 168 份里 **166 份是同一个 `log$RecordCodeFlags`**；
`没有这个基类` 117 份里 **77 份是 `jnc.Scheduler`**（宿主给的）。

**三件事因此定下来**：

1. 榜上头三行 347 + 286 + 285 = **918 对，是这张榜的 12%，而它们几乎全是宿主 API 那一层
   加它带出来的级联** —— sole 合起来只有 variant_t 那 5 份。拿这三行的对数当"还差多少语言
   特性"读，会把宿主面的账算到语言头上。
2. `variant_t` **131 份 / 999 处**是整张榜上最大的**一个名字**，比第二名（`std.Error` 110）
   高一头，而且是那三行里唯一有 sole 的。任务 #35 上原先记的"75 处"低估了一大截。
3. **声明失败要不要照样登记那一格局部量**，是一笔独立的账（诊断的质量，不是新能力）：
   落下来对数会掉一大片，可掉的全是派生的噪声。要落就得在 ADR 里明写"这一刀不新增能力"，
   别混进"又收下一格语言特性"里去。

## `variant_t` 那一格的墙量出来了：它压在"方言的 string 能不能落进内存"上

上一节把 `variant_t` 认成下一刀（131 份 / 999 处 / sole 5，榜上最大的一个名字）。落之前先量
语料到底怎么用它 —— 全仓 190 处，形状就这么几种：

```jancy
variant_t in, variant_t* out                  // 压倒性的一种：当**转手**用（84 份 ioninja 插件里的 dispatch）
variant_t v1 = -1;                            // 装箱：整数字面量
*out = m_remoteAddressCombo.m_currentText;    // 装箱：一格 string
*out = atoi(…);                               // 装箱：整数表达式
m_remoteAddressCombo.m_editText = in;         // 拆箱：赋给一格有类型的槽（隐式）
m_localPortCombo.m_editText = $"%d"((uint_t)in);  // 拆箱：写出来的强转
assert(v1 == -1);  return v1 + v2 + v3 + v4;  // 比较与算术（只在 test/jnc_test_abi/main.jnc 里）
```

任务 #35 里想的落法是"前端自己造一格 `{ tag, payload }` 的结构体 + 一套生成的助手"，不动方言。
**这条路当场撞墙了**，两个探针都是同一句话：

```
struct V { int m_tag; int64_t m_n; string_t m_s; }
-> 结构体 'V' 里有落不进内存的字段，指不到它身上（见 hir/types.js 的 structLayout）
```

换成 `class V { … }` 一字不差地报同一句（类的那一格布局走的也是 `structLayout`）。根在
`src/core/hir/types.js:144-168`：`sizeOf` 对 `t.k === 'string'` 没有分支，落到最后 `return 0`，
于是 `structLayout`（:178）判整格结构体"落不了地"。

所以 **variant_t 的 payload 里放不下 string**，而语料里最要紧的那一种（`*out = 一格 string`）
正是 string。三条路摆着：

1. **只收非 string 的 variant**（整数 / 实数 / 布尔 / 枚举 / 指针）。`jnc_test_abi/main.jnc`
   那一份能过，ioninja 那 84 份 dispatch 里"把一格 string 转手"的仍旧不行 —— 半格；
2. **先把方言那一格补上**：让一格 `string` 能落进内存（当字段、当数组元素）。
   `hir/types.js:160-166` 那段注释里 ADR-0024 已经把门修好了 —— "引用语义的句柄能当字段"，
   `(arr T)` 就是照这条落的（存句柄本身、一个字、8 字节），而且那段注释明写着
   "string / buf / fn / class 各有各的账，一次只放一格"。给 string 补这一格，同时也就解掉
   榜上 `string 的数组` 那 90 对；
3. 给方言加一格真正的动态值类型 —— 渗到 MIR 与四个后端，最贵。

**判断：2 是正路**，而且它不是"为了 variant 特开的口子"，是 ADR-0024 那条已经定下来的模板的
下一格应用。所以 variant_t 这一刀先压住，前置换成"string 能落进内存"。这一条按上面那条纪律
另开一格账去量（要动的是 MIR 与四个后端，不是这一层）。

**量完之后这一节自己要改两处（这就是"落刀前先翻一眼自己写过的账"那条纪律在自己身上生效）**：

- 上面说"string 是 ADR-0024 那条模板的下一格应用"—— **量下来不是**。`arr` 那条路走得通的
  前提是它在 C 与 LLVM 两条原生腿上**本来就是一个字的指针**（`omni.h:324-327` 的
  `typedef struct omni_arr_i64_s *`、`backend-llvm/emit.js:58` 的 `[T_ARR,'ptr']`），所以
  `sizeOf` 从 0 改成 8 之后那两条腿一个字都没改（ADR-0024:99-106）。string **不满足**这个
  前提：它是**两个字、16 字节的按值聚合**（`src/runtime/omni.h:33-34` 的
  `omni_str{const char* p; int64_t len;}`、`backend-llvm/emit.js:49` 的 `[T_STR,'[2 x i64]']`）。
  所以它落的是**第十六刀 fat 指针那一格**（"多字的值"），不是句柄那一格 —— 也就是
  `lower.js:4496` 那句诊断自己写着的"与 `&p` 同一格"。那句话当初就量对了。
- 另一件更要紧的：**string 当"值结构体的字段"今天就是收的** ——
  `src/core/sexpr/lower.js:811-817` 的字段白名单里 `STRING` 在列，
  `tests/sexpr/cases/06-structs.sx:6` 那条 `(struct Tag (name string) (n int) (ok bool))`
  是已经在跑的用例，`09-arrfields.sx:10` 的 `(struct Bag (xs (arr int)) (tag string))` 也在。
  卡住的**只有内存那条路**：`sizeOf(string)` 是 0 -> `structLayout` 判 null -> `(ptr S)` 不收。
  而 jnc 这一层的类与结构体局部量一律走 `(pnew (ptr V) …)`，所以它每一次都要那条路 ——
  上面那两个探针报的就是这个，跟"字段能不能是 string"根本是两码事。

于是 #38 的形状清楚了：`sizeOf(string) = 16 / alignOf = 8`，C / LLVM 两条腿的 `PLOAD`/`PSTORE`
本来就是按类型泛型发的（`backend-c/emit.js:1715-1718`、`backend-llvm/emit.js:1768-1775`），
真要动的是 **JS 那一族**（arena 是一块 `ArrayBuffer`，JS 字符串塞不进去）—— 那 16 字节里
放什么由那一族自己定，先例是 fat 指针（JS 一族在 24 字节里写三个 arena 偏移）。

## 第一百〇六刀：类体里的 `typedef` —— 对数**涨了 9**，涨在哪儿说得清

`类里除字段以外的成员` 82 份 / 101 处，按上一节那条纪律拆开：**只有一种源头**，而 80 多份是
同一行经 `-I` 重读出来的 ——

```jancy
opaque class InformationStatValue: InformationValue {
    typedef string_t FormatFunc(uint64_t value);
    FormatFunc* m_formatFunc;
    …
}
```
（`test/ioninja/api/ui_InformationGrid.jnc:52-54`）

榜上另一行 `没有这个类型：'FormatFunc'` 80 份就是这条 typedef 没登记之后下游的样子。**两行一个根。**

**落法一处**：类体里的 `typedef` 与嵌套类型走同一条路（第五十二刀那条 `aggHoist`）—— 提到顶层
那一批里、命名空间记的是这个类。于是 `typedefDecl` 里那句 `qual(info.name)` 拼出来的正是
`C$Name`；类体内裸写、类外限定名、以及函数类型那一支（第八十二刀的 `fnty0`，`*` 由 `ptrsTy` 加）
一处都不用另外改。类体那一遍跟着跳过它。结构体那一侧**不提**（与第一百〇一刀同一个决定），
边界钉在 `bad/struct-typedef.jnc`。

**证据**：`cases/97-classtypedef.jnc` 四行对着 `/tmp/c106.c` —— 类体里裸写、类外 `Stat.Num`、
函数类型的 typedef 当函数指针用、再换一个函数赋进去。
`node tests/jnc/run.js` = 195 passed, 0 failed；`link.js` 2/0。

**量出来的：对数 7702 → 7711（+9）**。逐组比下来只有三行动，加减对得上：

- `类里除字段以外的成员` 82 → **15（−67）**；
- `没有这个类型` 347 → **343（−4）** —— `FormatFunc` 那个名字解开了。**只掉 4 不是 80**：
  那 80 份文件里除了 `FormatFunc` 还缺别的类型，整行按"份"数，所以只有 4 份是整行掉了；
- 新出来一行 `类型是函数指针（string function*(unsigned long)）的字段` **80（+80）**。

−67 −4 +80 = **+9**，一格不差。涨的那 80 是**走得更远之后撞上的下一堵墙**，而那堵墙是
方言那一侧现成的一格：`hir/types.js` 的 `structLayout` 放不下函数值。榜上原先就有一行
`类型是函数指针（void function*()）的字段` 90 / sole 1 —— 现在这一族合起来 **170 对**，
与 #38（string 落进内存）是同一个家族的账：结构体字段今天只放得下标量与 `arr` 那种一个字的
句柄。**这一刀换来的是"两行笼统的换一行说得清的"**：以前是"类里有个成员我不认"加"有个类型
我没听说过"，现在是"这个字段的类型是函数指针，方言的布局放不下"。

剩下那 15 份是另一格：`static EnumPropertyOption const m_baudRateTable[] = { … }`
（`ui_SerialUi.jnc:205` 起五处、`iox_SshChannel.jnc:94`）—— **类里的静态成员带数组初值**，
与 typedef 无关，单独一刀。

## 第一百〇七刀：`extension T: Base { … }` —— 给已有类型添方法

榜上 `顶层的 '…'` 84 份拆开是六种毫不相干的声明：`using-extension` 40、`pragma` 25、
`attributed` 25、`extension` 6、`dylib` 2、`using-namespace` 1。这一刀只动 extension 那两条。
语法早就有（`jnc.grammar:208` 的 `(extension $2 $3 $5)` 与 `:211` 的 `(using-extension $3)`），
拦的是 `lower.js` 那句笼统的 `顶层的 '…'`。

**落法与第五十二刀那条一模一样**：extension 体里的方法就是"体外写的那个目标类型的成员"。
`expandExtensions` 把它们摊成"命名空间 = 目标类型"的顶层条目 —— 名字于是拼成 `C1$bar`，
`this` 由 `fnSig0` 按 owner 挑，签名那一遍与函数体那一遍**一个字都不用改**。这一遍排在
"类型名坐下"之后（要查得着目标类型）、体与签名之前（摊出来的条目底下每一遍都要看见）。

**偏差（明写在这儿）**：`using extension` **收下不看** —— extension 的方法一律直接长在目标类型
上，不管有没有写那一句。jancy 那边不写就查不着（那是它的作用域规则）。这是**放宽**、不是把答案
算错；代价是"两格同名 extension 撞车"这一层看不见。语料里 46 份文件一共就一格 extension 被
引用（`ui.ComboBoxHistory`），撞不上。

**证据**：`cases/98-extension.jnc` 三行对着 `/tmp/c107.c` —— 裸写目标类型的字段、调目标类型
自己的方法、目标类型写成限定名（`extension ComboPlus: ui.Combo`）、以及"没写 using 也长得上"。
`node tests/jnc/run.js` = 196 passed, 0 failed；`link.js` 2/0。

**量出来的：7711 → 7681（−30）**，逐组加减对得上：

- `顶层的 '…'` 84 → **41（−43）**（那 46 份里有几份还带着 `pragma` / `attributed`，所以整行只掉 43）；
- 新出来 `extension 体里除带体的方法以外的成员` **4** —— 就是 `ui_History.jnc` 那一族：体里全是
  **没带体的原型**，实现在宿主。这一格**刻意仍旧拦着**：照第九十三刀那样"收下不落码"能把这 4 对
  抹掉，可它一行代码都发不出来，那 40 份插件里 `combo.addToHistory(…)` 照旧解不开 ——
  抹的是账不是墙，所以不抹；
- 走得更远之后撞上的下一堵墙，一共 +9：`没有这个函数` +1、`左边不是结构体：string` +2、
  `没有这个属性` +1、`完整声明式的属性` +2、`带宽度或补零的格式化字面量` +2、
  `'…' 是 C1 的方法，要一个对象来调它` +1 —— 全是 `test42.jnc` / `test102.jnc` 那两份里
  extension 后面跟着的属性与格式化字面量，各自是别处已有的格。

−43 + 4 + 9 = **−30**，一格不差。

## 第一百〇八刀：属性 `[ … ]` 收下不看 —— 对数涨 57，可**两个真数字第一次动了**

第一百〇七刀之后 `顶层的 '…'` 那一行剩下三种，这一刀动 `attributed` 那 25 份 / 66 处。
同一样东西还堵在另外两处：结构体 / 类体里落到 `…里除字段以外的成员`（后面还拖着一串
`S 没有字段 'm_len'` 的级联），枚举成员上落到 `认不出的枚举成员`。

语料里 66 处全是元数据：`[ ungroup ]` 22、`[ userAction = "…" ]`、`[ displayName = "PDU" ]`、
`[ formatFunc = formatIpAddress ]`、`[ structType = typeof(Df1Read) ]`。

**落法**：语法上属性把一格声明裹起来（`jnc.grammar:221` 的 `(attributed 属性 声明)`，枚举成员
那一支在 `:354`），剥掉那层壳就是原来那格声明 —— 四处走成员的地方（nsFlat、aggHoist、
枚举体、agg 体）各加一句 `unattr`。

**为什么"收下不看"在这里不给错答案，以及给后人的一把锁**：属性的值在 jancy 那边是给**反射**
读的（`decl.findAttributeValue("formatFunc")`，`log_RepresentStruct.jnc:24/96`）。这一层压根
没有反射，那几个调用现在报的是"没有这个函数"。**将来要落反射，必须连属性的值一起落** ——
只补个空壳回 null 才是安静的错答案。这句话写在 `lower.js` 的 `unattr` 上面。

**对照：同一行里的 `pragma` 那 25 份不能这么收**。语料里它只有 `pragma(Alignment, 1)` 10 处与
`pragma(Alignment, 2)` 2 处，改的是后面那些结构体的**字段对齐** —— 收下不看就会按默认对齐算
偏移，读写全错位。理由与第八十六刀里 `bigendian` 必须拦一模一样。边界钉在 `bad/pragma.jnc`。

**证据**：`cases/99-attr.jnc` 两行对着 `/tmp/c108.c` —— 属性裹顶层变量、裹结构体字段、裹枚举
成员、裹函数四处。`node tests/jnc/run.js` = 198 passed, 0 failed；`link.js` 2/0。

**量出来的 —— 这一刀是"按对数读榜会读反"的最好例子**：

```
真降得下来      75 -> 76    (+1)
没有"还不收"    167 -> 168  (+1)
(文件,拦路项)   7681 -> 7738 (+57)
```

**两个真数字第一次动了**（第九十八刀之后一直是 75 / 167），而对数涨了 57。逐行数完
（降 −39 / 涨 +96）：

- 降的是那三格堵头：`结构体里除字段以外的成员` **−15**（清零）、`顶层的 '…'` **−13**、
  `认不出的枚举成员` **−7**（清零）、`没有这个类型` −3、`枚举里没有 '…'` −1；
- 涨的 96 分布在约 50 行上，**全是那些被属性挡着、这一刀之后才第一次真编到的声明里的内容**：
  ioninja 那一片 NetSnifferLog 的协议结构体（`io.IpHdr` / `io.TcpHdr` / `io.UdpHdr` /
  `io.Icmp6Hdr` …）字段本来整片都裹在 `[ … ]` 里，现在字段有了，用它们的代码于是往前走到
  `把 void* 转成 io.IpHdr*`（那一族 +26）、`修饰符 '…'`（63 → **78**，+15）、
  `声明符后缀 '…'`（8 → 17，+9）、`没有这个函数` +7、`'…' 的第 1 个实参要 void*` 那一族 +14 …

换句话说：**这 96 对以前根本不在榜上，因为那些声明整片是"看不见"的**。榜上多出来的是新露出来
的地形，不是新添的墙 —— 判据就是那两个真数字同时 +1。

## 第一百〇九刀：`修饰符` 那一行里"收下不看不可能算错"的六个词

上一节把这一行拆成 11 个词并逐词写了判据。这一刀只收判据成立的那几个：
`cdecl` / `stdcall` / `thiscall` / `safe` / `unsafe` / `mutable`。

- **三个调用约定**在方言今天的目标（arm64 与 x86-64 SysV）上**本来就是同一套 ABI** ——
  `stdcall` / `thiscall` 只在 32 位 x86 上才与 `cdecl` 不同。所以忽略它不是"少做一件事"，
  是"这件事在这些目标上不存在"。**代价明写**：哪天真加 32 位 x86 Windows 目标，这三个词要
  原样拿回来落成真的约定；
- `safe` 是默认那一档（转 thin 指针本来就要写 `unsafe { … }`）；`unsafe` 写在**声明**上时
  忽略它只会让体里真需要 unsafe 的写法照旧被拒 —— 拒得更严，放不过错的；
- `mutable` 是 `const` 的反面，而默认就是可写的（`const` / `readonly` 那一族也是收下不看）。

**仍旧拦着的**：`bigendian` 36 份 / 212 处（收下不看会把数读错，真的错答案）、`async` 31 份
（协程）、`disposable` 6 份（管的是**时机**，这一层没有 GC —— 与第九十三刀同族）、`weak` 4 份
（没有 GC 就永远不会变 null，程序拿它当判据时行为不同）、`indexed` 1 份（属性带下标运算符，
忽略了 `p[i]` 就接错人）。

**证据**：`cases/100-mods.jnc` 对 `/tmp/c109.c`。`node tests/jnc/run.js` = 198 passed, 0 failed；
`link.js` 2/0。

**量出来的**：

```
真降得下来      76 -> 77    (+1)
没有"还不收"    168 -> 169  (+1)
(文件,拦路项)   7738 -> 7731 (−7)
```

逐行数完（降 −9 / 涨 +2）：`修饰符 '…'` **−6**，跟着掉的三条级联各 −1
（`没有这个函数`、`未声明的变量`、`C1 没有字段 '…'`）；涨的两条是走得更远之后的下一格
（`函数值的局部量不写初值` +1、`形参 '…'` +1）。**两个真数字又各 +1**。

## 白得的一格：字段的类型可以是 string 了（方言那一侧落的，见 ADR-0026）

这一格**前端一个字都没改**。挡着它的一直是方言：`hir/types.js` 的 `sizeOf` 对 string 没有
分支、落到 `return 0`，于是 `structLayout` 把整格结构体判成"落不进内存"。而这一层的类与
结构体局部量一律走 `(pnew (ptr V) …)`，所以每一次都撞那条路 —— 上面那一节里 variant_t 的
两个探针报的就是这个。

ADR-0026 把 `sizeOf(string)` 定成 **16**（C 那边 `omni_str{p,len}`、LLVM 那边 `[2 x i64]`
本来就是 16 字节的按值聚合；JS 那一族在这 16 字节里放"句柄 id + 字节长度"）。落完之后
`struct Item { string_t m_name; int m_n; }` 与类里的同一格立刻就通了 —— 判据钉在
`cases/101-strfield.jnc`（尺子 `/tmp/c110.c`）：整格拷贝里带两格 string、没写过的那一格
读出来是空串。

**它换来的**：variant_t 的 payload 现在放得下 string 了 —— 那一刀（任务 #35，131 份 / 999 处）
的前置到此清掉。**尺子上一格没动**（77 / 169 / 7731，逐行差为 0），账写在 ADR-0026：榜上从来
没有"string 字段落不进内存"这一行 —— 语料里那些文件在更早的地方就倒了。顺带更正一条：我先前
写着"顺带解掉榜上 `string 的数组` 那 90 对"，**记错了** —— 那 90 是
`类型是函数指针（void function*()）的字段`（#39），`string 的数组` 是 **14** 对，而且数组那一族
（按元素类型分行，合起来 146 对）**没有因为这一刀好转**：数组的元素比字段多一条"能不能整格搬"。


## 尺子停在哪儿（第一百〇九刀之后）：**便宜的前端格用完了**

第一百〇四到一百〇九这六刀之后，把榜按真话又拆了一遍。结论是一句：**"改前端就能收下、且不给
错答案"的格子基本没了**，剩下的分四族，每族的大小都量过：

- **方言的布局还差三格**（都不是前端能一刀解的，因为要么要重叠、要么要位宽、要么要多字的值）：
  - `类型是函数指针的字段` **170 对**（两行合起来，任务 #39）—— `structLayout` 放不下函数值；
  - `结构体里的匿名 union` **17 份 / 37 处 / sole 3**（任务 #41）—— 拆开只有 `union { … }`
    这一种（`io_DeviceMonitorNotify.jnc:59` 那一族协议头）。union 是"几格字段共用同一个偏移"，
    而方言的布局是一格一格往后排，前端合成不出来；
  - `声明符后缀 'bitfield'` **17 份 / 90 处** —— 同理要布局认位宽。
  （string 那一格已经落了，见 ADR-0026。）
- **大件语言特性**：`variant_t` 131 份（#35，前置已清、设计已定）、泛型 19 份的 `jnc_std`
  （#34 / ADR-0025）、`async` 31 份（协程）、`bitfield` 之外的 `bigendian` 36 份 / 212 处
  （必须拦，收下不看会把数读错）；
- **宿主面**（ADR-0022 J4b 那一刀）：`原型没有带体的定义` 99、`写属性…存值器没有定义` 103、
  `ui.*Property` 那一整片构造与 `addWidget` / `addPart` 那些方法、`import "std_*.jnc"` 两条
  98 + 91。**属性那一族（#28）量下来整片压在这后面**，单独开它只能把一行诊断换成另一行；
- **没有可对的答案 / 方言的墙**：`bitflag 里的负值` 168（C++ 的未定义行为）、
  `main 里 return 非 0` 110、`格式化字面量里的 char*` 3。

**挑下一刀的判据因此变了**：不再是"榜上哪一行大"，而是"哪一族的**前置**最便宜"。三格布局里
我的估计是 **union 最便宜**（JS 那一族的 arena 本来就是按偏移读字节、天然支持重叠；C 那边直接
发 `union { … }`），账写在任务 #41 里。

**union 那一格试落过一趟，退回来了 —— 收获记在这儿**（一次性探针，`git checkout` 撤了）：
只改两处（`hir/types.js` 认一格 `{k:'union',fields}`、`structLayout` 把成员摊进平表且偏移都等于
union 自己的偏移；`sexpr/lower.js` 在字段位置收 `(union …)`）之后，探针（写 `a` 读 `b`、
再写 `b` 读 `a`）在 **run-llvm / interp / interp --mir 三条腿上一次就对**（`3 7 7 9`）——
**指针那一侧确实是白得的**，正是"字段访问一律按字节偏移"那条量到的事实。差的只有**值那一侧**
两处：`hir/types.js` 的 `cTypeName`（C 的类型拼写）与 `backend-js/emit.js` 的 `zero`（JS 的零值）。

**退回来的真正原因是一个还没定的判据**：C 与 JS 的结构体**值**表示是"一格字段一格槽"，
把 union 的成员摊成两格槽就意味着"按值那条路上写 `a` 读 `b` 读不到同一块字节"——
那是安静的错答案。三条路（值表示里真做重叠 / **禁止带 union 的结构体走按值那条路** / 摊成两格
并明写不重叠）里第三条不能选，第二条最像这个仓库的路子（与 ADR-0024 不放开 `(ptr (arr T))`、
ADR-0026 不放开 `(ptr string)` 同一个做法：一次只开一格、界写清）。定了再落。

## 第一百一十二刀：位域 —— 三格布局里的最后一格，**方言一个字没改**

上一节把剩下的活分成四族，布局那一族列了三格：函数指针字段、匿名 union、位域。union 由
第一百一十 / 一百一十一刀落了（ADR-0027，方言改了两处）。这一刀落的是**位域**，而它与前一格
不一样：**方言一个字都不用改**。

理由一句话：一格位域不是一格字段，是**某一格普通整数字段里的几位**。所以这一层自己合成得出来 ——
给连着的那一组开一格存储字段（名字 `$b<N>`，源码里写不出来），读发 `(存储 >> off) & 掩码`、
写发**读-改-写**。方言看到的只是一格普通的 `(int)` 字段。

### 分组的规矩：照 jancy 那一遍抄

出处 `StructType::layoutBitField`（jnc_ct_StructType.cpp:346-399）。并进上一格要**三条同时成立**：

1. 上一格也是位域；
2. `getType()->isEqual(field->m_type)` —— 声明类型**完全一样**（这一层就是 `sameTy`：位宽与
   符号性都要一样）；
3. `lastBitOffset + bitCount <= baseBitCount`，而 `baseBitCount = 声明类型的字节数 * 8`。

第 3 条里的 `baseBitCount` 是**声明写的那格类型**的宽度，不是方言在内存里给的 8 字节 ——
这一点要紧，因为 `uint8_t a:5; uint8_t b:5;` 在 jancy 里是**两格存储**（5+5 > 8），按 8 字节算
就会挤进一格、`b` 落在第 5 位上，那是**错的偏移**，也就是错的答案。三条都不成立就新开一格，
位偏移从 0 起。位数超过 `baseBitCount` 是**错**，不是"还不收"（jancy 那句 "type of bit field
too small for number of bits"）。

大端那一支（`PtrTypeFlag_BigEndian`）不用管，而且这件事**不是运气**：`bigendian` 这个词在
第一百〇九刀那份清单里是**刻意拦着**的（"收下不看会把数读错"），所以带它的字段一格都到不了
分组这一步。这一条是拦子救了一次的实例。

### 值那一侧：读补符号位，写读-改-写

读照 `extractBitField`、写照 `mergeBitField`（jnc_ct_OperatorMgr_DataRef.cpp:272-350）：

- 读 = `(存储 >> off) & ((1 << cnt) - 1)`，声明类型**有符号**时再补符号位。这一层写成
  `(x ^ s) - s`（`s = 1 << (cnt-1)`），jancy 写成 `value |= ~((signBit & value) - 1)` ——
  两者逐位相同，而前者与 `wrapTo` 里那一句是同一个恒等式，不用发负数字面量；
- 写 = `(旧 & ~掩码) | ((值 & 位掩码) << off)`。`~掩码` 这一层写成 `旧 ^ (旧 & 掩码)`：等价，
  同样躲开负数字面量。

**存储那一格的类型记成无符号**。这不是随手挑的：读要**逻辑**右移，而 64 位那一格上有符号右移
会把高位（别人家的位）抹成符号位。jancy 躲这件事的办法是把 rawValue 先转成 `Int32_u`/`Int64_u`
再移（源码里那两行 `getPrimitiveType(TypeKind_Int32_u : Int64_u)`），这一层等价地把存储字段本身
记成无符号，于是 `uOp` 自然挑 `u>>`。声明写的符号性另记在 bitPath 的 `type` 上，补符号位那一步用它。

### 落点只有两处：`read` 与 `store`

这是这一刀真正便宜的地方。左值多了一种 `kind: 'bits'`，而 `read(lv)` / `store(lv, v)` 是这一层
**所有**读写的唯一出入口 —— 于是 `=`、`++`、`--`、`+=`、`|=`、`&=`、`<<=` 一条都不用单独接：
复合赋值本来就是 `store(lv, … read(lv) …)`，落到位域上自动就是读-改-写。

地址串在写那一句里出现两次（`pload` 一次、`pstore` 一次）。这不是新账：复合赋值那一处本来就是
read 一次 store 一次，而这一层的地址串是纯的折偏移，重求没有副作用。

与第六十九刀"属性不是一格内存"是同一族，可**结论不同**：属性的读写各是一次调用，所以 `++` 与 `&`
在那儿都接不上；位域的读写是同一段字节上的算术，所以 `++` 接得上，只有 `&` 接不上（jancy 那边
`&` 回的是带 `PtrTypeFlag_BitField` 的指针，里头是"地址 + 位偏移 + 位数"三样东西，
jnc_ct_DataPtrType.h:26，而这一层的指针里只有地址）。

### 界（四条，都有 `bad/` 钉着）

- `bad/bitfield-local` —— 位域只在**结构体的字段**上。别处的 `: 数` 在 jancy 那边压根不是位域：
  那条语法规则上挂着 `resolver({ return false; })`（Declarator.llk:494-499），注释写着"宁可当
  条件表达式"（`p = new int : 3`）。这一层的语法同样排成 `(prefer -1)`（jnc.grammar:438）；
- `bad/bitfield-class` —— **类**里的位域还不收。一整条继承链共用一格结构体（第五十六刀），
  而位偏移是按"本类体内的顺序"算的，两件事要一起接。语料里类上一格位域都没有（13 份带位域的
  文件**全是 struct**），所以这一格留着当账记；
- `bad/bitfield-curly` —— 带位域的结构体上还不收花括号初值。那一遍是按"第几格字段"数的
  （`curlyMember` 里 `fs[idx]`），而位域不占自己的格子 —— 数下去写的是整格存储，**静默的错答案**；
- `bad/bitfield-addr` —— 取地址（上面那段的理由）。

union 体**自己**那一层也不收位域（`bs` 传 null）：那儿每格成员都从偏移 0 起，"连着的几格挤一格
存储"这句话在那儿不成立（jancy 的 UnionType 也不走 `layoutBitField`）。union 里再套的匿名
**struct** 里收 —— 那正是 `io_UsbTransfer.jnc:63-71` 的形状，登记成 bitPath 时路走两步
（`['$s0','$b0']`）。

### 尺子：算了**两遍**

`/tmp/c111.c` 里同一串数算两遍：一遍**显式的移位掩码**（存储写成 `uint64_t`，照方言的样子）——
值那一侧的对照物；一遍**真的 C 位域**（`uint8_t a : 4;`）—— 分组那一侧的对照物。两遍逐字节相同，
所以"我按 jancy 源码抄的分组规矩"与"C 编译器自己的分组"是同一个答案。
（顺带：clang 那三条 `-Wbitfield-constant-conversion` 警告 —— `15 -> -1`、`33 -> 1`、`300 -> 44`
—— 把三个越界写的期望值直接说出来了，等于第三份出处。）

fixture `cases/104-bitfield` 里九格位域覆盖六种分组情形（挤一格 / 普通字段隔断 / 挤不下新开 /
换类型新开 / 有符号补位 / 24+8 位），加上 `=`、`++`、`+=`、`|=`、越界写、方法体里裸写名字、
以及 union + 匿名 struct 那一格。两条腿逐字节相同、逐字节等于尺子。

### 尺子动了多少（`7723 -> 7698`，−25）

- **真降得下来 77 -> 80（+3）**、**没有"还不收"的文件 169 -> 174（+5）**；
- `声明符后缀 '…'` **24 -> 0**（sole 3）—— 整行没了。这一行在第一百一十一刀之后从 17 涨到 24：
  那一刀让 7 份文件过了 union 那道墙、紧接着撞上位域，所以这两刀是**连着的一对**；
- 级联 `TestStruct 没有字段 '…'` 1 -> 0；
- 24 + 1 = 25，与总数对上，**没有一行的 files 数上涨**。

新降得下来的三份全在同一族：`io_UsbDescriptors.jnc`、`io_UsbDeviceStrings.jnc`、
`io_UsbTransfer.jnc`（也就是引文那一族）。新"没有还不收"的另两份是
`log_RecordFile.jnc`（`uint32_t m_recordOffset : 24;`）与 `test08.jnc`（`IpHdr`）。

**四行的 sole 数涨了**，逐行说清：`没有这个类型` 11->12、`顶层的 '…'` 2->3、
`类型名 '…' 重复定义` 0->1、`把 TestStruct* 转成 unsigned char*` 0->1。四行的 **files 数一个没动** ——
这些文件先前有两个拦路项（位域 + 这一行），现在只剩这一行，于是变成 sole。这正是尺子该有的样子：
sole 涨说明**下一刀的题目更集中了**，不是退步。

## 尺子停在哪儿（第一百一十二刀之后）：布局那一族只剩一格，而**榜首换人了**

第一百一十二刀之后把榜按"**只有一个拦路项**的文件"（sole）重排了一遍 —— 这一栏才是"下一刀能
让几份文件真过去"。头几行：

- **12** `没有这个类型：'…'`
- **12** `unexpected "<" …`
- **9** `bitflag enum 里的负值`（C++ 的未定义行为，没有可对的答案）
- **4** `修饰符 '…'`、**4** `unexpected "int" …`
- **3** `main 里 return 非 0`、**3** `原型没有带体的定义`、**3** `没有这个基类`、**3** `顶层的 '…'`

拦路项个数的分布也量了：**80 份零拦路项、84 份只有一个、63 份两个、83 份三个**。也就是说
"一刀能让它过去"的库存是 84 份，而这 84 份的题目集中在上面那六七行里。

### 两个把之前的分类改了的发现

**一、`unexpected "<"` 那 12 份全是泛型。** 逐份看过：`stdt_Array` / `stdt_BinTree` /
`stdt_BoxList` / `stdt_HashTable` / `stdt_Iterator` / `stdt_List` / `stdt_Map` / `stdt_Operator` /
`stdt_RbTree` 九份加 `test157` / `test158` / `unit_stdt_List`。`unexpected "int"` 那 4 份
（`unit_stdt_Array` / `unit_stdt_BoxList` / `unit_stdt_HashTable` / `unit_stdt_RbTree`）是同一族的
**用**那一侧（`stdt.Array<int>`）。所以泛型（#34 / ADR-0025）今天的账是 **sole 16**，与
`没有这个类型` 并列榜首 —— 先前把它记成"19 份的 jnc_std"，量下来 sole 这一栏比想的大。

**二、`没有这个类型` 那 12 份里，`variant_t` 独占 5 份。** 逐份跑出真名字：

- 只差 `variant_t`：`std_MapEntry.jnc`、`ias_PluginDispatch.jnc`、`ui_ComboBox.jnc`、
  `ui_ListItem.jnc`、`ui_ListWidget.jnc` —— **5 份**；
- 只差宿主面的自省类型：`jnc_MemberBlock`（Field / Function / Property / Variable）、
  `jnc_Module`（GlobalNamespace / Type）、`jnc_ModuleItem`（Attribute / … / Type / Unit，
  外加 variant_t）、`Proto_Raw` / `Proto_Simple`（log.Representation）、
  `log_RecordFile`（std.Guid）—— 6 份；
- `test147fail.jnc` 那份**本来就该失败**（名字里写着 fail）。

也就是说 `没有这个类型` 这一行不是一族，是两族加一份噪声，而 variant_t 那一半今天**没有前置了**。

### variant_t 的墙确实拆了（探针）

前面那一节（"`variant_t` 那一格的墙量出来了"）说它压在"string 能不能落进内存"上。ADR-0026 落了
之后拿探针复量：

```jancy
struct V { int m_tag; int64_t m_n; string_t m_s; }
V* v = new V;  v.m_tag = 1;  v.m_n = 42;  v.m_s = "hi";
```

`1 42 hi` / `2 hi` —— 过。当初报的那句"结构体 'V' 里有落不进内存的字段"不再出现。所以
**variant_t 的载荷用一格合成的结构体表示，这条路今天通了**，任务 #35 的前置清空。

余下要定的只有落法的三处（不是新问题，是把已定的设计写成代码）：装箱要**发语句**（`pnew` 一格
再逐格 pstore），而 `expr` 这一层回的是一格值 —— 所以装箱得挂在那几处本来就有 `out` 数组的
调用点上（赋值、声明的初值、实参、return），与 `aggSource` / `copyVal` 同一个位置。

### `pragma(Alignment, 1)` 那条拦子要不要撤：**先记账，不动**

`顶层的 '…'` sole 3 里两份是 `pragma`（`BacNetApdu.jnc:6`、`Osdp.jnc:29`），一份是
`dylib`（`io_JLink.jnc:208`，宿主面）。`bad/pragma` 那条拦子当初的理由写着"收下不看 = 按默认对齐
算偏移 = 与 jancy 那边不一样 = 安静的错答案"。

**这条理由今天要修一处**：这一层的整数在内存里一律 8 字节（`bad/sizeof` 那条界），所以字段偏移
**本来就**与 jancy 不同 —— 不是 `pragma` 造成的。拦着 `pragma` 保护的东西，8 字节那条决定早就
放走了。真正还站得住的理由只剩一条：**一份程序若从宿主拿按 jancy 布局排好的字节**（协议头那一族
正是这么用的），那时偏移对不上就是错答案；而 `pragma` 出现的两份恰好都是协议解析。

所以结论是"先不动"，可**理由换了**：不是"忽略对齐会算错"，而是"`pragma` 出现的地方正好是唯一
能观测到布局的地方（宿主喂进来的字节），而那一族的账要连 8 字节整数一起算"。这两份文件因此
排在宿主面那一族后面，不是排在"便宜的前端格"里。

### 挑下一刀

按 sole 这一栏，能选的只有三格：泛型 16、宿主面 6+、**variant_t 5**。三格里 variant_t 是唯一
**前置已清、设计已定**的一格（tag + 载荷的合成结构体、拆箱对不上就 `(fail …)`，见任务 #35），
所以下一刀是它。泛型与宿主面各自还差一份"怎么落"的设计。

## 第一百一十三刀：`variant_t` —— 方言一个字没改，可尺子上**两个数往回走了**

落法一句话：`variant_t` 在这一层是**一格合成的结构体**

```
(struct jnc$variant ($t int) ($n int) ($r real) ($s string))
```

`$t` 是标签（0 空 / 1 整数 / 2 实数 / 3 布尔 / 4 字符串），剩下三格是载荷，**不重叠** ——
重叠要 union（第一百一十刀那一格），可省下来的 16 字节买不到任何可观测的东西。

为什么这就够：这一层的结构体已经有整套"变量里放地址、赋值逐字段抄、形参抄一份"的落法
（第十二 / 十三刀），而 variant 要的正是这些。所以**方言一个字都没改**。前置（`string` 能落进
内存）由 ADR-0026 补齐了 —— 在那之前同一格报的是"结构体里有落不进内存的字段"（见前面那一节）。

### 装箱与拆箱：两个方向都是隐式的，挂在同一处

jancy 里两个方向都不写强制转换 —— 语料里的写法就是 `*out = atoi(s);` 与 `m_editText = in;`。
所以两条规则挂在 `expr(n, want)`：那是"要一个具体类型"的取值的**唯一入口**，于是初值、赋值、
实参、返回值四处一起接上（与第三十七刀 bool -> 整数那条同一个理由，那处注释里写的就是这句）。

装箱 / 拆箱各是一格**生成的函数**（`jnc$var$i` / `jnc$var$to$i` …），不是内联的几句。理由是
装箱要 `pnew` 一格再逐格写，而 `expr` 这一层回的是一格**值**、没有能挂语句的地方 ——
做成函数之后装箱在表达式里就地成立，一处都不用改调用点。先例是 `jnc$mc_fire`（第七十三刀）。

拆箱时标签对不上就 `(fail …)`（与 `assert` 落到同一格，第四十九刀）。**不在编译期拒** ——
jancy 那边拆箱失败也是运行期的事，编译期拒了就把"转手一格 variant"这个压倒性的用法
（84 份 ioninja 插件的 dispatch）一起拒掉了。

`variant_t v = null` 那一条在 `null` 自己那一支里（语料 8 处）：`null` 没有类型，走不到
"v.type 是什么"那一步。

### 顺手补的一个洞：结构体之间没有算符

`v1 + v2` 在 jancy 那边**合法**（按两边的标签在运行期选一条算），这一层不收。可先前它落到
二元那条 catch-all 上，发出一句 `(bin "+" 地址 地址)`，然后在后端炸掉
（`js.bin: + on struct`）。**这不是 variant 带来的** —— `S a, b; a + b` 先前就是这样。
variant 只是让它容易碰上，所以在这儿说清（`bad/variant-arith`）。

### 尺子（`7698 -> 7758`，**+60**）：两个数往回走了，逐条说清

- **真降得下来 80 -> 82（+2）**：`std_MapEntry.jnc`（拦路项清零）与 `ui_ListItem.jnc`；
- **没有"还不收"的文件 174 -> 163（−11）**；
- **(文件, 拦路项) 对 7698 -> 7758（+60）**。

后两个数往回走的原因是**同一个**，而且说得清：`没有这个类型：'variant_t'` 是一句 **E**
（普通错），它先前把 131 份文件**拦在体的降级之前**。那些文件因此一条 `N` 都报不出来 ——
于是 `clean`（没有还不收的文件数）把它们算成了"干净的"，尽管它们一份都编不过。这一刀把那句 E
拿掉之后，它们往下走、报出了自己真正的 `N`。

**逐份验过这 11 份**：`ui_ComboBox` / `ui_ListWidget` 从 `[E 没有这个类型]` 变成
`[E 没有这个函数, N 表达式 '…']`，`test141` / `test156` / `test66` / `test88` / `test96` 各自
换成两条别的，`test49` / `test52` / `test74` / `test94` 换成一条。一份都不是"本来能过、现在过不了"。

**账要记在 `clean` 这个口径上**：一句早早挡住整份文件的 E 会**把下游所有 N 藏起来**，于是
`clean` 会偏高。`lowered`（真降得下来）没有这个毛病 —— 它问的是"整份文件跑不跑得起来"，
而它这一刀是 **+2**。以后读榜要记着这条。

### 涨出来的 60 对涨在哪儿：**新榜首 `表达式 'assign'`，111 份**

拆开看，涨的那一批里最大的一格是先前根本没露出来的一行：

- **`表达式 '…'` 111 份 / sole 1** —— 逐份看是 **`表达式 'assign'`**：jancy 里赋值是**表达式**，
  而这一层的赋值只在语句位置成立。这一行现在是榜上最大的一格 `N`。

  **这个 111 要加一句注**（第一百〇四刀那一课）：全语料**源码里只有 14 处** ——
  `return <左值> = <表达式>;` 7 处（`ui_ComboBox.jnc:74`、`ui_ListWidget.jnc:67`、
  `stdt_Iterator.jnc:37/41`、`stdt_Map.jnc:45`、`stdt_BoxList.jnc:45`、`test157.jnc:28`）
  与链式 `a = b = c` 7 处（`Df1Layer.jnc:182-187`、`SerialTapProDecoder.jnc:132`、
  `SerialMonSession.jnc:200`、`ui_LogRecordCodeFilterUi.jnc:33`、`ui_ToggleUi.jnc:48`）。
  111 是**import 摊出来的** —— `ui_ComboBox` / `ui_ListWidget` 被上百份 ioninja 插件 import，
  一处根因摊成上百对。`while ((c = f()) != 0)` 那种形状语料里**一处都没有**。

  这件事对下一刀的形状有决定性影响：14 处里的左值**全是字段路径或指针**
  （`m_currentIndex`、`m_p.m_value`、`m_txParser.m_mode`、`p = p0 = next`），没有一处是
  SSA 局部量。所以那一刀落成"一格生成的助手 `jnc$asgn$T(p, x) { pstore p x; ret x }`"就够 ——
  与这一刀装箱那几格助手同一个办法，而"左边是局部量"那一种可以先明说不收；

- `格式化字面量里印不出 variant_t` 3 份（jancy 自己也是一句 "don't know how to format"，
  Parser.cpp:3689）；
- `把 X 装进一格 variant_t` / `把一格 variant_t 拆成 X` 各几份（X 是指针、结构体、`char*`）——
  这几条正是这一刀写下的界；
- 掉下去的几行也一起记：`ui$ComboBox 没有字段` 12 -> 0、`第 2 项越过了 ui$ListItem 的 1 个字段`
  21 -> 0、`读属性…取值器没有定义` 18 -> 0 —— 同一个机制的另一面（那些文件现在换了个地方报）。

### 界（两条，各有 `bad/` 钉着）

- `bad/variant-ptr` —— 装进 variant 的今天只收整数 / 实数 / 布尔 / 枚举 / 字符串。指针那一格
  要载荷里装得下三个字的 fat 指针（第十六刀那一格），结构体与函数值同理。语料里 190 处逐处
  看过，装的全是前五种；
- `bad/variant-arith` —— 上面那个洞。

### 尺子：手写的带标签联合

`/tmp/c112.c` 是手写的 `struct { int t; int64_t n; double r; const char* s; }` 加五格装箱、
四格拆箱、一格 `dispatch(in, &out)`，逐格与合成的那格结构体对应。fixture `cases/105-variant`
覆盖装箱五种、拆箱四种、转手两趟、隐式收窄（`(char)300` -> 44）、枚举按基整数装、
variant 当字段 + 结构体赋值抄一份。两条腿逐字节相同、逐字节等于尺子。

**下一刀：`表达式 'assign'`**（赋值当表达式）。它是这一刀翻出来的，榜上 111 对、源码里 14 处
（数字的注见上面那一段），而且不用动方言 —— 落成一格生成的助手 `jnc$asgn$T` 就够。

## 第一百一十四刀：赋值当表达式 —— 一行清空了，可交通全挪到**属性**那一族去了

上一刀翻出来的那一行（`表达式 'assign'`）。jancy 里赋值是表达式，值是**存进去的那个值**
（不是回头再读一次），这一层的赋值只在语句位置成立。

落法与上一刀装箱那几格助手同一个办法 —— 一格生成的函数：

```
(fn jnc$asgn$int ((p (ptr int)) (x int)) int (pstore (var p) (var x)) (ret (var x)))
```

于是 `(call jnc$asgn$int 地址 值)` 在表达式里就地成立，`expr` 这一层不用能挂语句。
方言一个字没改。类型转换那两条（整数之间隐式收窄、别的要同型）与语句那一侧**一字不差**。

**界**：左边只收一格**内存**（lvalue 的 `ptr`）—— 字段、指针指到的那一格、被取过地址的局部量、
模块级变量。SSA 里的局部量没有地址，助手第一个实参写不进去（`bad/asgnexpr-local`）。
上一刀量过的 14 处里左边全是字段路径或指针，一处都不是 SSA 局部量，所以这条界不挡任何真写法。

### 尺子（`7758 -> 7735`，−23）：两个真数字**一个没动**

- 真降得下来 82（没动）、没有"还不收"的文件 163（没动）；
- `表达式 '…'` **111 -> 31**，而剩下那 31 **一格 assign 都没有** —— 逐份跑出来是
  `dynamic-cast` 3 / `dynamic-sizeof` 1 / `dynamic-countof` 1（另一族，`samples/jnc/13`、
  `14`、`52_Finally.jnc` 那几份）。所以 assign 那一种**清空了**；
- 可是 `属性 '…' 当一格可写的内存用` **34 -> 90（+56）**。这就是那 80 份的去处：
  `ui_ComboBox.jnc:74` 那句 `return m_currentIndex = insertItem(…)` 里的 `m_currentIndex`
  是一格**属性**，于是 lvalue 那一步报的是"属性不是一格内存"（第六十九刀）。

−80 + 56 + 1 = −23，与总数对上。

**这一刀因此把一件事量成了硬事实**：`表达式 'assign'` 那 111 对里 **80 对压在属性那一族
（任务 #28）后面**。前面"尺子停在哪儿"那一节猜的是"属性那一族整片压在宿主面后面"——
现在方向反了一半：**属性挡在前面的东西比想的多**。属性那一族要落，缺的是"属性的存值器返回
存进去的那个值"这一条（jancy 那边 `m_p = v` 的值就是 v，与普通赋值同一条），也就是
第六十八 / 六十九刀那两格上再加一格"当表达式用"。

## 第一百一十五刀：表达式里给**属性**赋值 —— 把上一刀挪走的交通接了回来

上一刀量出来的硬事实：`表达式 'assign'` 那 111 对里 **80 对压在属性那一族后面**。
`ui_ComboBox.jnc:74` 那句 `return m_currentIndex = insertItem(…)` 里的 `m_currentIndex`
不是字段，是一格**属性**，于是 lvalue 那一步报的是第六十九刀那句"属性不是一格内存"。

落法与上一刀同一个办法（一格生成的包装函数），只是包的东西不同 —— 存值器回的是 void：

```
(fn jnc$pset$C_m_val ((s (ptr C)) (x int)) int
  (expr (call C$m_val$set (var s) (var x)))
  (ret (var x)))
```

**整条表达式的值是"存进去的那个值"**，不是回头再调一次取值器。这一条与普通赋值一字不差
（jancy 那边 `m_p = v` 的值就是 v），而且它**要紧**：取值器可以有副作用，多调一次就是错答案。
fixture 里故意让存值器把值改一下（乘 2 / 加 100），于是"表达式的值"与"再读一次"是两个数 ——
写错了一眼就看得见。

三种形状都收：体里裸写属性名（`m_val = v`）、`对象.属性 = 值`、模块级属性（没有 this 那一格）。
索引属性还不收（那几格下标也要进包装函数的形参表，个数按属性变）。

### 尺子（`7735 -> 7681`，−54）

- 真降得下来 82（没动）、没有"还不收"的文件 163（没动）；
- `属性 '…' 当一格可写的内存用` **90 -> 34（−56）** —— 剩下那 34 正是这一刀**之前**就有的
  那一批（`++`、`&`、复合赋值那三种"就地改"，第六十九刀那一格，形状不同）；
- `写属性 '…' —— 它的存值器没有定义` 103 -> 105（+2）—— 那两份的属性是**宿主面**的
  （存值器的体在 C/C++ 里），换了个地方报。

−56 + 2 = −54，与总数对上。

**三刀连起来看**（一百一十三 -> 一百一十四 -> 一百一十五）：`variant_t` 把 131 份文件往前推了
一步、翻出 `表达式 'assign'`；赋值当表达式把那一行清空、把交通挪到属性；属性这一刀把它接住。
对数 7723 -> 7681（净 −42），而"真降得下来"从 77 走到 82。**两个真数字这三刀里只在第一刀动过** ——
剩下那两刀清掉的是同一批文件里的第二、第三个拦路项，它们的第四个拦路项是**宿主面**
（`没有这个函数`、`ui.*Property` 那一片），那才是下一堵墙。

## 榜上又一句**名字起错了**的诊断：那剩下的 34 份不是 `++`，是"读一格属性再往下用"

第一百一十五刀之后 `属性 '…' 当一格可写的内存用` 还剩 34 份，那句诊断自己写着
"`++`、`&` 与复合赋值这类'就地改'的写法这一层接不上"。**逐份跑了一遍，一处 `++` 都没有。**
真正的两种形状是：

```jancy
m_type.getValueString(p, formatSpec);                             // jnc_Field.jnc:40
return m_attributeBlock ? m_attributeBlock.findAttribute(name) : null;  // jnc_ModuleItem.jnc:97
```

也就是**读**一格属性（它的值是一格类引用），再拿读出来的那个对象**往下用** —— 当方法调用的
接收者、当条件。一次都不是"就地改"。会落到那句诊断上是因为 `.` 的左边走的是 lvalue 那条路
（`memberOf`），而那儿见到属性名就报了第六十九刀那一句。

这与第一百〇四刀那一课（`局部的函数原型` 那 69 对其实是 `T v(a, b)`）是同一类错：**一句诊断
在别的场合是对的，可它挡住的这一批根本不是它说的那件事**。记在这儿，两件事：

1. 那句话要按落点分开 —— 写那一侧（`++` / `&` / 复合赋值）与**读**那一侧（属性当 `.` 的左边）
   是两条不同的账，混在一句里会让选题看错方向（我这一趟就差点去做 `++`）；
2. 下一刀的真题目是**"属性当 `.` 的左边"**：读那一次本来就有（propGet，第六十八刀），
   缺的只是把 `memberOf` / `lvalue` 那条路上"左边是属性"这一格接到 propGet 上，
   让它回一格**右值**再往下走。34 份，而且不用动方言。

## 第一百一十六刀：属性当 `.` 的左边（读那一侧）—— 落对了，可尺子只动了 **1**

上一节量出来的题目。根因不是"缺一格能力"，是**同一段七行代码抄了四遍**：`lvalue0` 的 field 支
接了"左边是属性就走取值器"（第七十二刀），而 `methodCallee` / `methodRef` / `propMember` /
原型那一处各自抄了一遍**却都没接**。抽成一处（`baseVal`）之后四条路一起对，净删了 21 行。

界不变：**写**那一侧（`++`、`&`、复合赋值）照旧拦着 —— 属性没有可写的那一格（第六十九刀）。

验过的两种形状（fixture `cases/108-propdot`，两条腿一致）：

```jancy
int viaBare() { return m_p.twice(); }      // 裸写属性名 + 调方法（jnc_Field.jnc:40 的形状）
int viaBareField() { return m_p.m_k; }     // 裸写属性名 + 取字段
o.m_p.twice()   o.m_p.m_k                  // 带对象的两种
```

### 尺子：`7681 -> 7680`，**只动了 1**

**这一刀要老实记一笔**：`属性 '…' 当一格可写的内存用` 只从 34 掉到 **33**。也就是说
上一节点名的那两处（`jnc_Field.jnc:40`、`jnc_ModuleItem.jnc:97`）里只有一处在这一刀的射程里，
**剩下 33 份撞的是同一句诊断的另一种形状，而那种形状我还没找出来**。

为什么没继续追：这一趟的预算到头了。留给下一趟的**具体活**：拿那 33 份逐份跑，把
`属性 … 当一格可写的内存用` 出现的那一行源码抄出来分类 —— 与第一百〇四刀那一课同一个办法。
在那之前**不要**再猜这一行的内容（上一节已经猜错一次：以为是 `++`）。

**这一趟试过四遍、都没量出来，把踩到的坑写下来免得下一趟重走**：

- 复现要用**sweep 自己那条命令**：`node src/cli.js sx <文件>`，而且 `test/ioninja/` 那一支
  要带 `-I <jancy>/test/ioninja/api`（jnc-sweep.js:60-64 那段注释写着为什么）。用
  `emit sx` 或者漏掉 `-I`，报出来的是另一堵墙（`没有这个类型`），不是这一行；
- `while read f; do node … ; done < 清单` 会**空转**：node 把清单文件的余下内容当自己的 stdin
  吃掉了。要 `node … </dev/null`；
- `execFileSync` **只在非零退出时**才把 stderr 交出来；要不管退出码都拿到，用 `spawnSync`；
- **最后那一次的真根因，也是最蠢的一条**：清单里的路径是 `test/ioninja/…`（没有打头的斜杠），
  而我判断"要不要加 `-I`"写的是 `f.includes('/test/ioninja/')` —— 永远是假，于是 `-I` 一次都
  没加上，33 份全撞在第一条那堵墙上。第一条自己写下来的坑，隔了三次又踩了一遍。

### 量出来了：那 144 处是**宿主面**，不是一格语言特性

改对之后（`/tmp/p33.mjs`，spawnSync + 路径判断修好）：33 份里命中 **144 处**，形状高度集中：

```jancy
m_deviceProp.m_currentIndex = m_deviceCombo.m_currentIndex;     // 14 处，最多的一种
storage.writeInt("readMode", m_readModeProp.m_value);           // 读出来当实参
m_readModeProp.m_value = Defaults.ReadMode;
m_adapterProp.m_currentIndex = storage.readInt("adapterIdx");
```

一眼看得出：左边全是 `<字段>.<属性>`，而那个字段的类型是 **`ui.*Property` 这一族宿主类**。
写它走的本来是 `propSet`（第六十八刀）—— 报到"属性当一格可写的内存用"这一句上是因为
那个宿主类这一层根本没有，于是 `memberOf` 落到了那一支。

**所以这 33 份（144 处）是宿主面那一族，不是语言特性。** 第一百一十四刀那一节说
"属性挡在前面的东西比想的多、方向反了一半"—— 这一趟把它量清了：**属性那一族里语言那一半
（一百一十五、一百一十六两刀）已经落完，剩下的整片是宿主面**（`ui.*Property` 的构造与成员、
`没有这个函数`、`import "std_*.jnc"`）。榜上那三格候选（泛型 16 / 宿主面 / variant 5）
到这一趟为止只剩**两格**：泛型与宿主面。

能力本身是真落了（fixture 钉着，两条腿一致），四处重复也真去掉了 —— 只是它买到的对数是 1。
这两件事分开记。

## 量清了 #39（函数值当字段，榜上 170 对）：它是 ADR-0024 那一档，**不是**我先前记的胖值

榜上剩下最大的一格是 `类型是函数指针（…）的字段`。这一节把它的形状量清，落之前先记账。

**先纠一处我自己写错的前提。** 前面几处（包括任务 #39 的描述）说函数值是 ADR-0010 那个
"胖值 `{fp, c_*}`"。**读错了**：ADR-0010 明明白白选的是**一个**指针 ——

> `docs/adr/0010-function-values.md:84-85`：把"**记录自己当作第一个实参传进去**，而不是另外
> 传一个 env 指针。于是函数值是**一个**指针，不是'函数指针 + 环境指针'的胖值"

而胖值在同一份 ADR 的**否决清单**里（`:153`）。`{fp, c_*}` 是**堆上那条闭包记录**的布局，
不是那格值的布局。这一处错得要紧：它决定了这一刀是哪一档。

**结论：它是 ADR-0024 那一档（两条原生腿上本来就是一个字），不是 ADR-0026 那一档。**
逐条证据：

- C：`typedef struct omni_closure_s *omni_fn`（`src/runtime/omni.h:135-137`）—— 与 `arr` 那条
  `typedef struct omni_arr_i64_s *` 一模一样的形状；
- LLVM：`if (t.k === 'fn') return 'ptr'`（`backend-llvm/emit.js:1626`），而且那一行的注释
  **已经**写着"与'类字段'同一条：引用语义，COPY 拷的是句柄"（:1624-1625）；
- 这一层**已经**在需要数字的地方按 8 算了：`arrIsBlob` 把 `fn` 与 `class` / `arr` 放进同一桶
  （`hir/types.js:371-373`），两条原生腿的数组元素步长就是 `esz = 8`
  （`backend-llvm/emit.js:1651-1652`、`:2083`）；
- `isRef` 早就把 `fn` 划进引用语义（`hir/types.js:233-234`）。

所以 `sizeOf(fn) = 8`、`alignOf(fn) = 8`，**C 与 LLVM 两条腿一个字都不用改**（PLOAD/PSTORE
在那两条腿上本来就按 `cTypeName` / `ty()` 泛型发 —— `backend-c/emit.js:1730-1733`、
`backend-llvm/emit.js:1768-1776`），要改的是 JS 那一族与两个解释器，与 ADR-0024 的清单同形：

1. `hir/types.js` 的 `alignOf` / `sizeOf` 各一支（今天落到 `return 0`，:156 / :202）；
2. `interp/builtin.js` 的 `ptrLoad` / `ptrStore` 各一支（照 `'arr'` 那一支，:455-459 / :482）；
3. `backend-js/prelude.js` 加 `$pload_f` / `$pstore_f`（挨着 `$pload_h` / `$pstore_h`，:262-267）；
4. `backend-js/emit.js` 的 `jsPtrLoad` / `jsPtrStore` 各一支（:44-49）；
5. `mir/interp.js` 的 `memKind`（:164-177）—— **这一格是唯一比 arr 难的地方，见下**；
6. `tests/sexpr/cases/` 一格新用例（`39-handle-field.sx` / `40-string-field.sx` 那个位置）。

`sexpr/lower.js` 的字段白名单、`ptrTargetOk`、`mir/ir.js`、`mir/verify.js`、两条原生腿的
emit：**都不用动**。`(ptr (fnty …))` 只从 `pfield` 出来（`sexpr/lower.js:2565-2566`），
与 arr / string 字段走的是同一条路 —— `ptrTargetOk` 那道门不要开，那是"指到句柄自己身上"，
ADR-0024:137-138 与 ADR-0026:118-119 两处都明确不开。

### 那个问题**用探针答了**：`T_AGG -> 'fn'` 是安全的

`memKind` 拿到的只是 MIR 的**类型码**，而函数值**没有自己的码** —— 它与 struct / class /
enum / 容器共用 `T_AGG = 7`（`mir/ir.js:59`、`mir/from_oir.js:150-152`）。`arr` 当初有自己的
`T_ARR = 9`，所以那一刀直接 `T_ARR -> 'arr'` 就完了。于是要先答一句：**今天 `T_AGG` 会不会以
别的身份走到 `memKind`**？

探针（`/tmp/probe-clsfield.sx`：`(class C (n int))` + `(struct Box (c (ptr C)))`）三条腿给的是
同一句话：

```
字段 Box.c：(ptr T) 的 T 只能是 int / real / bool / 结构体名 / 另一个指针 / (blk T N)，这里是 C
```

也就是说**方言的 `(class …)` 压根不是一个合法的指针目标** —— 类的句柄今天当不了字段，
`T_AGG` 走不到 `memKind` 那一步。（jnc 那一层的类不走这条路：它从第五十二刀起就把类落成
一格 `(struct …)`，指针指的是那格结构体，不是 `(class …)`。）

结论：等这一刀把 `fn` 开了之后，**`T_AGG` 当指针目标只可能是函数值一种**，所以
`memKind` 里加 `T_AGG -> 'fn'` 是安全的 —— 不需要给函数值另开一个 MIR 类型码。
顺带也答了那个"更要紧的现成错答案"的担心：**没有**这个错答案，因为那条路今天整个是关着的。

**于是 #39 的开放问题清零，清单就是上面那六条。** 落的时候记住 `hir/types.js` 是聚合层 ——
按 ADR-0023 那条规矩要跑整套 `node tests/all.js`（ADR-0024 立的先例）。

## 第一百一十七刀：类型是函数指针的字段 —— `7680 -> 7510`，**整 170 对，一行没涨**

榜上最大的一格，也是"方言的布局还差三格"那一族的**最后一格**（另两格：匿名 union 由
ADR-0027 落、位域由第一百一十二刀落）。

活主要在方言那一侧（**ADR-0028**）：函数值能落进内存了，`sizeOf` 从 0 变 8，走的是
ADR-0024 那一格。前端这一侧只两件事：

1. 把第五十五刀那句"方言的结构体字段还放不下函数值"的拦子**撤掉**。撤掉之后
   `fieldText((fnty …))` 本来就发得出来，读写走的是与别的字段同一条
   `pfield` + `pload` / `pstore` —— 一个字都不用加；
2. 加一支：`c.m_f(3, 4)` 与方法体里裸写的 `m_op(a, b)` 是"从一格函数指针**字段**上调"，
   不是"调一个方法"。它排在**所有**"按名字找"的路子之后，而且只在名字确实是一格函数指针
   字段时才走（`fnFieldNames` 那张表）—— 否则它要先求左边那个值，而求值会发诊断，
   那会给真的"没有这个函数"多发一条。与 `methodNames` / `propNames` 同一个办法。

### 撤掉一道墙**顺手翻出了第一百一十二刀留的一个洞**

拦子一撤，`int function* m_op(int, int);` 立刻报了一句离奇的话：
`位域 'm_op' 的类型是 int function*(int, int)`。

根因：第一百一十二刀在 `declarator` 的**主出口**加了 `bits`，可那个函数有**三个**出口 ——
函数指针那一个（`fnPtrDcl`）与特殊成员那一个都不带这个字段。字段那一遍问的是
`info.bits !== null`，而 `undefined !== null` **成立**，于是函数指针字段被当成了位域。

这个洞先前看不见，正因为 `isFn` 那道拦子排在位域那一支**前面**、把它挡住了 ——
**一道墙后面藏着一个洞**。两头都堵上：三个出口都写 `bits: null`，判断改成问**正面**
（`typeof info.bits === 'number'`）。这与 ADR-0024 记的那类"最后一格是 fallback 的链"
是同一族：默认值是"是"的时候，漏一个出口就是错答案。

### 尺子：`7680 -> 7510`（−170），**一行没涨**

- 真降得下来 82 -> **83**、没有"还不收"的文件 163 -> **164**；
- `类型是函数指针（void function*()）的字段` **90 -> 0**、
  `（string function*(unsigned long)）的字段` **80 -> 0**；
- 逐行 diff：**只有这两行消失，别的一行都没动** —— 没有新行、没有哪一行的 files 数上涨。
  这一趟最干净的一刀，而且预测的 170 与实际的 170 一个不差。

`bad/fnptr-field` 那条界随这一刀删了 —— 它钉的正是被拆掉的那道墙，注释里还写着"补法有两条，
选哪条要量"，选的是第一条。它验的那种写法（`int function* m_op(int, int);` 写在类里）搬进了
`cases/109-fnfield`，没丢。

尺子 `/tmp/c115.c` 是手写的 C：一格结构体里两条函数指针，同一串数（`5 7 12` / `12` / `10 10`）。
jancy 的 `function*` 是**胖的**（fp + 闭包），这一层的是一个指针 —— 在"能存能取能调、拷一份
两边指同一个"这几件可观测的事上两者一样；带闭包那一半在方言那一层的
`tests/sexpr/cases/42-fn-field.sx` 里用 `mkclo` 真钉过。

## 第一百一十八刀：泛型 —— 墙推倒了，可 pairs **朝上走了 16**

细账在 ADR-0025 的"S2/S3 落了"那一节（这一刀的设计与判据全在那份 ADR 里）。这儿只留三句
放在这条时间线上才看得清的话：

1. **拆墙型的刀，pairs 天生朝上走。** 7556 → 7572（+16），而 lowered / clean 一个没动
   （83 / 151）。逐份量过：+16 全在那 10 份声明泛型的文件里（39 → 55），原先撞的那两条硬 E
   （`认不出的结构体名字` / `认不出的类名字`）一条不剩，涨出来的是**走到后面才碰上的**账。
   这与第一百一十七刀那一节记的"早早一格硬 E 会把下游的 N 全挡住"是同一条口径的反面。
   **判一刀不能只看 pairs 的正负号**，要看 lowered / clean 与"具体哪几条理由消失了"。
2. **"AST 是纯的、抄一份就是完整替换"这条结论只对值成立，对身份不成立。** 类体里那格
   `reactor` / `fn-def` 与被 `aggHoist` 提到顶层的那一格是**同一个对象**，第八十二刀的
   `reactorBody` 靠这条身份认领它。泛型那一遍无条件重建节点 → `82-reactor` 当场报
   "reactor 'Inl.m_r' 声明了两次"。解法是"一格也没换就回原节点"。这一遍扫**每一个**文件，
   所以这一句护着的是所有不带泛型的写法。
3. **合成出来的类型要自己补一次 `aggHoist`。** 手写的类是在 `run()` 最开头那一遍提方法的；
   泛型实例是那之后才有的，少这一句它体里的方法就没人认领。凡是"在既有流水线中途插一遍、
   还往名单里加条目"的刀，都要回头问一句：**它之前那几遍里有没有欠它的**。

## 第一百二十四刀：结构体体里的 `typedef` —— 把**欠的那半句**补上

第一百〇六刀在类那一侧收了体内的 `typedef`，结构体那一侧当时留了界（`bad/struct-typedef`），
理由记的是"与第一百〇一刀同一个决定：提上来同一件事会报两遍"。这一刀把那条理由**改了** ——
它对 `construct` / `destruct` / 嵌套类型成立，对 `typedef` **不成立**：typedef 不报错，
它只是**起一个名字**。

两处改动，第二处才是要紧的：

1. `aggHoist` 里 `h === 'typedef' && isCls` 去掉 `isCls` —— 提上去，名字记成 `S$Num`。
2. `typeDecl` 里查名的起点：`if (cls) this.ns = name` 改成无条件。**这一句是把欠的补上**：
   方法从第一百〇一刀起就记在 `S$m` 上了，查名的起点却还停在外面一层 —— 也就是说
   "结构体是不是一层命名空间"这件事，先前是**记名字时算它是、查名字时算它不是**。
   这一刀让两边对齐。

它**不**等于"结构体全面变成一层命名空间"：嵌套类型、带名字的 union 那几条界各自的 `nope`
都还在原处（`bad/union-named` 照旧拦）。这一条区分要写清楚，否则下一刀会以为那几条也一起没了。

语料出处：`struct RbTreeNodeBase { typedef P EntryPtr; … }`（stdt_RbTree.jnc:20）那一族。
`bad/struct-typedef` 随这一刀删了，写法搬进 `cases/116-structtypedef`（尺子 `/tmp/c122.c` ——
C 里 struct 体内写不了 typedef，所以手抄的正是"提到外面之后"的样子，而那就是这一刀做的事）。

账：pairs 7563 → **7559（−4）**，lowered / clean 没动（84 / 154）。`结构体里除字段以外的成员`
那一行在 `BinTree` / `RbTree` / `test157` 上没了，顶上来的是 `结构体的基类` —— 下一格的题目。

## 第一百二十五刀：结构体的基类 —— `7559 -> 7490`，**这一轮最大的一格**

榜上 67 份文件在 `结构体的基类` 这一行上；语料里 50 处声明、22 份文件
（`struct termios2: termios`、`struct Point3D: Point`、Modbus 那一族协议头）——
**全是纯数据、只继承字段**。jancy 那句在 type_class.rst:218："it's ok to inherit from
structs and even unions"。

这一层它就是**布局**一件事：基类那几格字段排前面，自己的排后面（顺序就是布局）。三处机制：

1. **顶层的 type-decl 不保证先声明后使用**，所以基类可能还没摊开 —— 碰上就地先摊
   （`structLay`）。摊过的记 `laidStructs`（不然 `(struct …)` 会发两条），正在摊的记
   `layingStructs`（环的闸门 —— 不拦就是无穷递归，界在 `bad/structbase-cycle`）。
   这与类那一侧的 `pendingCls` + `classLayout` 是**两种办法**：类要等所有 type-decl 过完
   才知道"谁派生了我"（一条链共用一格结构体），结构体只需要"我的基类"，所以按需拉一次就够。
2. **同名字段当场拒**（`bad/structbase-dup`）—— 两格基类里的同名字段是两块不同的内存，
   悄悄合成一格是"改了意思"（第九十四刀 mixins 那处同一条口径）。
3. **基类里有位域 / 匿名 union 的先不收**：那两条路（`bitPath` / `aliasPath`）记的键是
   `基类$字段`，派生那一格按自己的名字查，查不着 —— 收下来会读到**错的位置**，是静默的错答案。
   要收得让那两张表跟着继承复制一份，单独一笔账。

**还不收的那半格**（`bad/structbase-up`）：上转，`D*` 装进 `B*`。这一格与类那一侧的对比值得
记下来 —— 类的一条链共用**一格**方言结构体，所以上转发零条指令；结构体**不能那么合**：
它的字节布局是可观测的（协议头、还能按值放进别的结构体里），合成一格之后 `Point` 就跟
`Point3D` 一样大了。而方言的指针没有类型重解释那一格。所以那半格要么给方言加一条"按前缀
重解释"、要么在前端插一格拷贝，两条各是一笔账。**中途试过让 `assignOk` 放它过去 —— 前端过了，
方言那一层照样拦（"形参是 Point*，给的是 Point3D*"）。当场退回来，账记在这儿**：这一层放宽
而下一层不认，等于把诊断从"说得清的一句"换成"离现场更远的一句"，那是退步。

账：pairs 7559 → **7490（−69）**、lowered 84 → **86**、clean 154 → **156** ——
这一轮（118–125）最大的一格。它大的理由与第一百二十三刀同一条：**位置**。协议头那一族是
ioninja 那半边语料的地基，一通就是几十份文件跟着往前走一步。

尺子 `/tmp/c123.c`：C 里没有结构体继承，手抄的是"字段展平之后"的样子 —— 那正是这一刀做的事。

## 第一百二十六刀：`bigendian` 的字段 —— 第一百〇九刀刻意留下的那一格，收了

第一百〇九刀把 `修饰符 '…'` 那一行拆开逐词看，`cdecl` / `safe` / `mutable` 那几个"收下不看"
（那件事在这些目标上不存在），而 `bigendian` **刻意留着**，理由写得很清楚：收下不看会把数
**读错** —— 那是真的错答案，不是"少做一件事"。这一刀把它真做了。

落法与位域（第一百一十二刀）一模一样：存储照旧是一格普通整数，**读写各套一次字节序反转**，
路子记在 `bePath` 上（`beLv` / `bswapRead` / `bswapStore`）。于是 `=`、`++`、复合赋值、
方法体里裸写字段名，一条都不用单独接 —— 这是"把新语义挂在左值那一层"这个办法第三次奏效
（位域、属性、现在是字节序）。

三处顺序是这一刀真正的内容，三处都源自同一句话："它**是**一格真字段"：

1. `nameLv` 里这一问排在 `selfField` **之前** —— 排在后面就被那一支当普通字段接走，反转丢掉；
2. `propMember` 里"套在匿名 struct 里"那一种排在 `aliasPath` **之前**，同一条理由；
3. 直接的 union 成员在外层那张字段表里**查得着**，所以那一种挂在最后那个出口上。

反转本身：挑字节用**无符号**右移（`uOp` —— 64 位那一格上有符号右移会把符号位摊进来，
挑出来的高字节就是错的），拼回去之后按声明的类型回卷一次（有符号要把最高位摊成符号位，
与 `bitsRead` 同一个恒等式）。

**能观测吗？** 这一层不许把结构体指针转成字节指针（`bad/thin-*` 那一族），所以"字节序真的
反过来了"唯一的观测方式是**同一段字节两种读法** —— 一格 union 里一半 `bigendian`、一半机器序。
界里那一格（`Ov`）正是它：写 `0x1234` 进大端那一侧，机器序那一侧读出来是 `0x3412`。
这也顺手把 union 成员那条路补齐了（协议头那一族本来就这么写）。

尺子 `/tmp/c124.c`：C 那边**把字节直接摆出来**（`be_put` / `be_get` 逐字节手写）——
大端的意思就是"高位字节在前"，所以不用 `htons`：那是另一个实现的答案，不是独立的出处。

账：pairs 7490 → **7459（−31）**、lowered 86 → **87**、clean 156 → **161（+5）**。
`修饰符 '…'` 那一行里最大的一格（32 份文件）就此没了。

## 口径：**一整批当一个模块编**（`jnc-sweep --group`）—— 榜首那三行大半是量法量出来的

这一格不是一刀，是把尺子上一处一直没量的东西量了。

默认那一遍是**逐份**编（662 份各自 `omni sx`），而 jancy 自己不是这么编的：ioninja 那一支的
`CMakeLists.txt:815` 把 `api/` 整批一起编成一个模块，`std` 那一支同理。于是像
`ui.StdColor.PastelPurple`（log_Representation.jnc:74）这种"名字就在同一批里、可这一份文件
没写 `import`"的写法，在逐份口径下必然报"没有这个类型 / 没有这个函数 / 未声明的变量" ——
**而那三行正是榜首**（320 / 304 / 303）。

所以给尺子加了一格 `--group <目录>`：合成一份只有 `import` 的文件，一次编完整批。
它**不动**默认那一遍、也不写 json/log —— 上一趟的基线要保持可比（ADR-0023 那条纪律）。

量出来两个数，都比预想的干净得多：

- **`test/ioninja/api`（44 份）**：213 条诊断、**59 种**理由。最大的三格是
  `未声明的变量` 45、`没有这个函数` 41、`没有这个类型` 11 —— 也就是说逐份口径下那三行的
  320 / 304 / 303，**绝大部分是同一批文件里互相引用引出来的**，不是三百多处真的缺。
- **`src/jnc_ext/jnc_std/jnc`（19 份）**：**只剩 1 条** ——
  `unexpected "basetype"`（stdt_HashTable.jnc 那一处语法）。整个 `std` 库就差这一格。

这条口径改变了"下一刀挑什么"的判据：**逐份那张榜的榜首不再是可信的选题依据**（它把
"没 import" 与"真的没有"混在一行里）。往后挑题目要两张榜一起看 —— 逐份那张看"孤立一份文件
能走多远"，`--group` 那张看"整批一起编还差什么"。

`std` 那一批只差一格语法，是这一轮（118–126）最直接的成果：泛型那六刀 + 结构体继承那一刀
之后，`stdt_Array` / `List` / `Map` / `RbTree` / `BinTree` / `BoxList` / `Iterator` /
`Operator` 这八份文件在**一起编**的口径下已经全通了。

## 第一百二十七刀：跟在点后面的 `basetype` —— `std` 那一批的最后一条

写在方法体里的 `basetype.m(…)` 第五十六刀就收了。语料里还有另一种写法 —— 跟在一格**值**后面：

```
Bucket.Entry* bucketEntry = p.m_bucket.basetype.remove(p.m_bucketIt);   （stdt_HashTable.jnc:155）
```

用处是"绕过派生类的遮挡、调基类那一个"（`Bucket` 与它的基类都有 `remove`）。语法上先前不收
（`unexpected "basetype"; expected …, ID`）—— `member` 那条规则里没有它。补三条产生式
（`basetype` / `basetype1` / `basetype2`），表从 368 条规则 / 663 状态到 371 / 666，
**零条新冲突**（glr 20/0）。

落法一句话：与写在方法体里那一种是**同一件事**，只是 `this` 换成左边那个值 —— 所以做法是把
`baseTarget` 的"从谁的基类里找"抽成一个参数（默认还是 `this` 那个类），调用点那一支多认一种
形状。一条继承链共用一格方言结构体（第五十六刀），"换一面"发**零条指令**，静态绑定照旧。

账：pairs 7459 → 7458（−1），lowered / clean 没动 —— 逐份口径下它本来就只挡着一份文件。
**要看的是另一张榜**：`--group src/jnc_ext/jnc_std/jnc` 从"1 条"变成 **0 条诊断** ——
`std` 那 19 份文件在"一起编"的口径下语义上全通了。

### 可这一趟量出一个**崩**（下一刀的题目）

`--group` 那一格现在退出码还是 1，而诊断是 0 条 —— 因为它**崩了**：

```
RangeError: Maximum call stack size exceeded
  at JncLower.copyVal (lower.js:1820) / copyAgg (lower.js:1844)  —— 两个来回互相叫
```

`copyVal` / `copyAgg` 是"结构体按值拷一份"那一对（第十二刀），它们顺着字段类型递归，
而**没有环的闸门**。泛型落地之后语料里出现了让它绕回自己的形状（`stdt_RbTree.jnc:51` 那句
`struct RbTreeNode<K, V>: BinTreeNodeBase<RbTreeNode, K, V, RbTreeColor>` 里，类型实参写的是
泛型**自己的名字**，一个实参都没带）。

**崩是最坏的一种答案** —— 比"还不收"坏得多：它不说话、还带不出位置。下一刀先给这一对加闸门、
把它变成一句说得清的话，再看那个形状本身该怎么收。

## 第一百二十八刀：环的闸门 —— 顺手**改一句上一刀记错的话**

上一刀（第一百二十七刀）那一节写着"`--group src/jnc_ext/jnc_std/jnc` 从 1 条变成 **0 条诊断**
—— std 那 19 份在一起编的口径下语义上全通了"。**这句话是错的。**

那个 0 是**崩出来的**：`copyVal` / `copyAgg`（第十二刀那对"结构体按值抄一份"）顺着字段类型
递归、一句拦的话都没有，跑到那个形状上直接爆栈（`RangeError: Maximum call stack size
exceeded`）。栈一爆，进程带着**尚未发出的那几百条诊断**一起走了 —— 于是"诊断 0 条"。
**崩不只是最坏的一种答案，它还会把别的答案一起吞掉。** 这条比那个数字本身值钱。

补两处，两头都堵：

1. **声明这一处**（`typeDecl`）：字段的类型按值走下去够得着自己（`structSelf`，数组按元素走、
   指针**不走**）就当场报，并把那一格字段**摘掉**再往下走 —— 留着它，后面几处顺着字段走的路
   照样绕不出来。报在这儿有位置，比 copyAgg 那儿只有类型名准得多。
2. **`copyAgg` 那一对**：留一个 `seen` 当闸门。就算将来还有别的路走到那儿，答案也是一句话
   而不是一次崩。

**根子上那个形状**也一起收了个界：泛型的实参写的是**一格泛型自己的名字、一个实参都没带** ——
`struct RbTreeNode<K, V>: BinTreeNodeBase<RbTreeNode, K, V, RbTreeColor>`（stdt_RbTree.jnc:51）。
jancy 那边它指"外层正在造的那一格"（晚一点再绑），这一层没有那条路；按字面替进去造出来的正是
一格按值套回自己的结构体。明说不收（`bad/generic-bareself`）。

### 真实的那两个数（口径这一栏的账要重记）

- `--group src/jnc_ext/jnc_std/jnc`：**356 条诊断、30 种理由**（不是 0）。最大三格是
  `没有这个类型` 102、`原型没有带体的定义` 70、`没有这个函数` 37 —— 后面那一格是宿主面，
  前面两格得逐处看。
- 逐份那张榜：pairs 7458 → **7477（+19）**、clean 161 → **160（−1）**。
  往**坏**的方向走了 —— 照实记：这一刀把"悄悄造出一格错类型再崩"换成了"一句说得清的不收"，
  于是那几处后面本来被崩挡住的账冒了出来。**用 19 对与 1 份 clean 换掉一个崩，这笔是划得来的**：
  崩不给位置、不给理由，还会把同一趟里别人的诊断一起吞掉。

界：`bad/struct-selfvalue`（结构体按值套回自己）、`bad/generic-bareself`（泛型实参是裸的泛型名）。

## 下一刀的选题：两张榜一起看之后剩下的那两格（量过了，没做）

`--group` 那一格（见上面那节）之后，`std` 那一批剩下的 356 条里，**不是宿主面、也不是
"没 import"** 的那两格是：

- **结构体里的 `construct`**（14 处诊断；语料里 struct/union 上的构造 **28 处**）。
  形状量过了：`construct() thin {}`（最多）、带实参的（`construct(string_t string) thin`、
  `construct(T value = null) thin`）、以及少数不带 `thin` 的。类那一侧第五十三刀（体内的
  construct）与第九十四刀（局部量的构造）都收了，结构体这一侧要多想一件事：**它是按值的**，
  所以"构造谁"得先有那一格的地址（局部量要么提到堆上、要么走 `&s` 那条路）。
- **运算符重载**（35 处）。语料里的那一批：`operator ++` / `--`（前后缀各有）、`operator *`、
  `operator ->`、`operator :=`（赋值）、`operator ()`（`static size_t operator () (string_t key)`
  —— 那是 HashTable 的哈希函子）。这一格是**一族**，得先定"在哪一层认它"：语法上是特殊声明符，
  调用点则要在二元/一元运算那几处先问一句"两边是不是有重载"。

两格都不小，各是一刀（或一族）。挑哪一格的判据仍是那两张榜一起看 —— 逐份那张榜上这两格
几乎看不见（它们被更早的墙挡着），而"一起编"那张榜上它们已经排在最前面。

## 第一百二十九刀：结构体的 `construct` —— 唯一一处不做就**静默错**的地方在字段上

`--group` 那张榜上 std 那一批剩的两格之一（14 处诊断；语料里 struct/union 上的构造 **28 处**，
最常见的写法是 `construct() thin {}`）。

类那一侧第五十三刀（体内的 construct）与第一百〇三刀（`T v(a, b)` 的构造实参）都收了。结构体
这一侧要多想一件事：**它是按值的**。可在这一层"按值"恰好省事 —— 结构体那一格的名字里放的
**本来就是地址**（第十二刀），所以 `this` 直接传那一格，不用先提到堆上。四处接上去：

1. `aggHoist` 把体里的 `construct` 也提到顶层（`static construct` 仍旧只在类那一侧 —— 那一格要
   一道 once 闸门）；
2. `fnSig0` 认结构体当主人（`this` 那一格的类型用结构体自己，与第一百〇一刀的方法一样）；
3. 三处调用点：局部量 `S s;` / `S s(a, b)` 与 `new S(…)`；
4. **字段自己的构造**。

**第 4 条才是这一刀真正的内容**，也是唯一一处不做就会**静默错**的地方：`Outer` 里内嵌一格
`Inner m_in`，只构造外面那一格的话 `m_in` 就停在零值上 —— 而源码明明写了 `Inner.construct`。
两种情形分开办：

- 自己写了 construct 的：那几句补在**体之前**（与字段默认值同一条口径 —— 体里再赋值会盖掉它，
  jancy 也是这个顺序）；
- 自己**没写**的（`Wrap`）：给它**合成一个**（`synthStructCtors`，与类那一侧的 `synthCtors`
  是一对）。合成要按字段依赖跑到不动点：`A` 里有 `B`、`B` 里有 `C`，那么 C 的先有、B 的才补得出来。

明说不收的三格：`static construct`、`new S[n]`（n 格要每格都调一遍，得一个循环）、
内嵌那一格的构造**要实参**（补不出来 —— 与基类那一条第九十四刀同一条口径）。

账：lowered 87 → **88**、clean 160 → **162（+2）**、pairs 7477 → 7481（+4）。
`--group std` 从 356 条降到 352 条，而"理由的种数"从 30 涨到 34 —— 又是那条老规律：
往前走一步，看见的账就多几种。

尺子 `/tmp/c126.c`：C 里没有构造，手写的正是"编译器该替你调的那几句"（造完调一次、内嵌那一格
也调一次）—— 那就是这一刀做的事。

## 第一百三十刀：赋值算符 `operator :=` —— 顺手把一句认错人的诊断改对了

语料里 11 处，全在 std 那一批（`std_String` / `std_Buffer`：
`size_t errorcode operator := (utf16_t const* p)`）。它是 `--group` 那张榜上
`限定名或特殊名的声明符` 那 35 处里最大的一格。

语法本来就认它（`(operator :=)` 是声明符的一格核心），所以这一刀全在降级那一侧：
`specialCore` 把它当特殊成员回 → aggHoist 提得动、typeDecl 跳得过 → `opAssignSig` 登记成一格
方法（`Owner$op$assign`，`this` 当第一个形参）→ 赋值那一处按**左边那一格的类型**去找它。

三条判据（都写在代码那处注里）：只在 `=` 上认（`+=` 那一族是别的算符，还不收）；右边**同型**时
不认（那是"抄一份"，是拷贝不是转换）；右边要对得上它那**一个**形参。一格类型上只收一个
`operator :=` —— 多个要按实参类型挑，与第八十刀的同元重载是同一笔账。

顺手让**类的变量能赋值**了（只在有 `operator :=` 的那一格上）：第五十二刀那句"类的变量赋不了值"
照旧管别的类 —— 算符要盖掉的正是那一句，所以这一问排在它之前。

### 量出来一个**认错人的诊断**，一并改了

`fnSig0` 里给特殊成员摆说明符那一句是 `special === null || special === 'get' ? 问 specs : void`。
`operator :=` 落到了 else 那一支上，于是**返回类型被吞成 void**，体里的 `return m_v` 报的是
"**main 里 `return` 一个非 0 的值**（方言的入口没有退出码）"—— 那句话谁看了都会去查 main，
而错在一个结构体的算符上。改法是把算符也放进"照常问 specs"那一侧。

这是这一族第三次踩同一类坑（第一百一十七刀的位域、第一百二十二刀的重报、这一刀）：
**共用的分支上多一种形状，就要回头看那条分支的每一个 else**。

账：逐份那张榜没动（lowered 88、clean 162，pairs +5）；`--group std` 总数还是 352 条，
可 `限定名或特殊名的声明符` 那 35 处**裂开了**：13 处是 `operator :=`（收了），剩下 22 处
现在报的是 `算符重载 '…'` —— 一句**说得出是哪个算符**的话。诊断的质量也是账。

尺子 `/tmp/c127.c`：C 里没有算符重载，手写的是"编译器该替你挑的那个调用"。

## 第一百三十一刀：自增自减那四个算符 —— 一堵墙**后面藏着另一堵**

`operator ++` / `operator --` 与它们的后缀变体。语料里这一族的原样只有一处，可那一处四个全写着
（`stdt_Iterator.jnc:36-54`）：前缀回**新**值、后缀回**旧**值，副作用一样。

第一件要办的事不是调用点，是**把后缀认出来**。语法上它是另一个头（`(postfix-operator ++)`，
jnc.grammar:431），而上一刀留下的四处判据写的都是 `sk.startsWith('operator ')` —— 后缀那一种的
话头上多了个词，四处会**一齐**认不出它，那一格于是掉到"认不出的声明符"那条路上去。改法是一个
共用谓词 `isOpSpecial`（前缀、后缀两种头都算），四处一起换。这是"共用的分支上多一种形状，就要
回头看那条分支的每一处"的第四次 —— 上一刀刚记过。

登记与调用：`opIncSig` 拼四个名字（`Owner$op$inc` / `$op$dec` / `$op$inc$post` / `$op$dec$post`），
落法与 `operator :=` 一模一样；自增自减那条**语句**上按主人的类型把名字拼回来去找。

这儿要**改一句老注释**：那条语句上原本注着"语句位置上前缀与后缀没有差别（都不取值）"——
对内建那三种（指针 / 整数 / real）成立，对重载**不成立**：它们是两个函数。所以后缀那一格先找
postfix 那个名字、没写才落回前缀（jancy 同，postfix 是可选的）；反过来只写了 postfix 却写成前缀，
明说（`bad/opinc-prefixonly`）—— 不替它猜。形参也明说：这一族在 jancy 里是**零元**，C++ 里那个
假的 `int` 形参在 jancy 是靠 `postfix` 这个词分的（`bad/opinc-arity`）。

### 账：`--group` 的总数**朝上走了 16**，而这是对的

逐份那张榜：lowered 88、clean 162 都没动，pairs `7486 -> 7483`（−3）。

`--group std` 那张榜是这一刀真正的读数，而它**朝上走**：`352 条 / 37 种` → `368 条 / 36 种`。
按第一百一十八刀立下的口径，这一刀该看的是"**哪一行不见了**"：

- `限定名或特殊名的声明符` 那 **8 处整行没了** —— 正是四个后缀声明掉下去的那一格（也就是上一刀
  裂开之后剩在那儿的最后一批）；
- `算符重载 '…'` `22 -> 14`（−8：四个算符 × 两格泛型实例）；
- `未声明的变量` `37 -> 69`（**+32**）—— 墙后面那一堵：算符的体现在真降了，于是体里的 `m_p`
  （26 处）与 `p0`（8 处）撞上了**另一件本来就错着的事**。

  > **这一句上一稿写错了**，下一刀查清之后改在这儿：当时把它记成"`P readonly m_p;` 的
  > `readonly` 走的是'指针后面的修饰符'那条路、字段没登记上"—— 那是猜的，而且是错的
  > （`int readonly m_n;` 这一层收得好好的）。真正的因是**泛型实例名被当成了一层层的
  > 命名空间**，见第一百三十二刀。这一句当时没量就写下去了，记在这儿。

一句话：这一刀把 `postfix` 那道门打开了，门后是一个**本来就在那儿的错**。总数涨的 16 条全是
**先前被挡在门外看不见**的账 —— 记在这儿，下一刀的选题就有出处了。

尺子 `/tmp/c128.c`：手写那六个调用，`a++` 走 postfix 那个（+10）、`a--` 落回前缀（−3）——
"该挑哪个"这个选择在 C 里得自己做，做出来与 jnc 那边一致，账才算平。同一串数（3/0/10/7/6/7）。

## 第一百三十二刀：泛型的**实例名不是一层层的命名空间** —— 上一刀量出来的那个错，是这个

上一刀记下的那条线索（`结构体 'stdt.IteratorBase.T*' 里的字段 'm_p' 按值套回了自己`，四处）
查到底之后，因不在 `readonly`、也不在算符上，而在**查名**那一处：

- 实例名是 `模板名$实参键` 拼出来的（`tinstOne`：`Box$Node`）；
- 实例体是拿 `this.ns = 实例名` 降的 —— 成员 typedef（`typedef P Entry;`）要在那一层查得着；
- 而 `resolve` 往外退一层是**按 `$` 掐**的：`Box$Node` 退成 `Box`，于是实例体里写 `Node`
  拼出来的正是 `Box$Node` —— **实例它自己**；
- `typeSpec` 里结构体表排在 typedef 表**前面**，于是这一撞每次都赢。

改法一句话：**实例名要当一个整体**。新加一格 `instNs`（实例名 -> 那个泛型声明处的那一层），
`resolve` 往外退时先问它、直接跳过去。实例自己那一层照旧先查（成员 typedef 还在），只是不再
退成模板名那一层。三处改动、六行。

### 这一格先前是**静默的错答案**那一类

最小的样子只要三行，连指针和泛型 typedef 都不用：

```jnc
struct Node { int m_x; }
struct Box<P> { P* m_p; }
Box<Node> b;    // m_p 的类型落成了 `Box$Node*`，不是 `Node*`
```

它撞上赋值时报的是"两边不同型：左是 Box.Node*，右是 Node*"（看着像用户写错了），撞上按值
字段时报的是"按值套回了自己"（看着像第一百二十七刀那道闸门在管事）—— **两句都指着别处**。
所以 `123-genericname` 把四个面一起摆上：指针字段、按值字段、成员 typedef（这是
`this.ns = 实例名` 本来要办的事，改完不能坏）、以及把参数转手给另一格泛型当实参
（`struct Pair<E> { Box<E> m_a; }` —— 键是从**替换之后**那格说明符上重新读出来的，
std 那一批就是这么一层层滚成 `stdt.IteratorBase.T*` 的）。

### 账

逐份那张榜：lowered 88、clean 162 都没动，pairs `7483 -> 7476`（−7）。

`--group std`：`368 条 / 36 种` → `359 条 / 34 种`。少的那几种是三行整行没了、一行新进来
（36 − 3 + 1 = 34）：

- `结构体 '…' 里的字段 '…' 按值套回了自己`（4 处）—— 就是那句认错人的话；
- `类型是类（stdt.BinTreeBase.T.C）的字段`（1 处）与
  `类型是类（stdt.HashTableBase.T.H.E）的字段`（1 处）—— 名字里那个 `.T.` 就是记号：
  它们本来也是这一撞造出来的假账；
- 新进来的是 `stdt$BoxListEntry$T* 没有字段 '…'`（8 处），见下面那段。

> **这一段上一稿写的是"另一种落在榜印不出来的那一段里，说不出是哪一行"**。说不出来是**尺子
> 缺一格**，不是账没法查：`--group` 那一遍先前什么基线都不留，两趟之间只能靠人记。补上之后
> （`jnc-sweep --group` 自己一份 json，印出与上一趟的差、以及**哪一行整行没了**，那一栏不受
> `--top` 限制）这三行一眼就看得见。判一刀看的是"哪一行不见了"—— 那就得让尺子说得出这句话。

`未声明的变量` `69 -> 35`（**−34**，上一刀涨的那 32 条连本带利还回来了）。
`没有这个类型` `106 -> 134`（+28）是**换了一句实话**：那格实参本来就是外层还没绑定的 `T`，
先前它被那一撞"解成"了实例自己，于是错悄悄往下传；现在它照实说没有这个类型。

顺手量到的一件小事记在这儿（没做）：新冒出来的 `stdt$BoxListEntry$T* 没有字段 '…'` 那 8 处，
话里漏了**内部拼法**（`$` 与 `*`）—— 实例名该有一套 `shown()` 认得的印法。

尺子 `/tmp/c129.c`：C 里没有泛型，手写的是"替换该替出来的那个类型"—— 每一格 `P` 按实参写死。
同一串数（7 / 7 41 / 9 / 5）。

## 第一百三十三刀：`errorcode` 写在**星号后面** —— 一条第五十八刀立错了的理由

语料里 9 处，一个形状：`ListEntry* errorcode add(variant_t data)`（std_List.jnc:146、
std_HashTable.jnc:113、std_RbTree.jnc:56）。

它与第七十二刀的 `T* property p` 是**同一条**：最后一个 `*` 后面那一组词是这条**声明**的词，
不是那格指针的。第五十八刀当时把这一格留着，理由写在 `55-errorcode.jnc` 的注里 ——
"那是指针自己的修饰符位置"。**这个理由不成立**：星号后面那一组本来就归声明，第七十二刀已经
为 `property` 立过这条规矩了，这一刀只是把 `errorcode` 也算进来。那三行注一并改对。

提的条件写紧：那一组里除了 `errorcode` **全是可变性那几个词**（`const` / `readonly` / `cmut`，
在指针上本来就是收下不看的）才提；混着别的词就照旧当场报 —— 悄悄丢掉一个没认出来的词就是
改了意思。

顺手改对一处**读错了袋子**的地方：`fnSig0` 里那两处 `errorcode` 读的是它自己算的 `sp`，
而星号后面那个词只有 `declarator` 那一遍认得（记在 `info.sp` 里）。第七十二刀那句"关心
prop / cst / agt 的调用方一律读 `info.sp`"少列了 `errc` 一格。

账：逐份那张榜 **clean `162 -> 163`**（这一轮第一次有整份文件干净下来）、pairs
`7476 -> 7465`（−11），lowered 88 没动。`--group std` `359/34 -> 357/33`：
`指针后面的修饰符 'errorcode'` 那 9 处整行没了；`没有这个函数` `38 -> 41`、
`未声明的变量` `35 -> 39` 各朝上走一点 —— 那几条声明现在真登记上了，调它们的地方于是往下
走了一步，是拆墙那一族的常态。

尺子 `/tmp/c130.c`：errorcode 就是 C 的错误码加一层糖（exceptions.rst:15），手写的是把糖摊开
的样子。C 那边压根没有"写在星号前面还是后面"这个问题 —— 它量的正是这一点：两种写法该落成
同一个函数。同一串数（3 / 1 / 40 / 2 / 1）。

## 下一刀的选题（第一百三十三刀之后重量的，没做）

两张榜现在是：逐份 lowered 88 / clean 163 / pairs 7465；`--group std` 357 条 / 33 种。
`--group std` 那张榜上剩下的、**不是宿主面也不是"没 import"**的那几格：

- **未绑定的泛型参数漏出去**（榜首 `没有这个类型` 134 处里约 **90 处**：`T` 40、`T*` 18、
  `I` 14、`T const*` 8、`T.Value` 4）。这是剩下最大的一块，账记在 ADR-0025 那一栏末尾。
  它挡着的是 `stdt` 那一族整批 —— 通了之后后面那几格才量得准。
- **算符重载剩下的 10 处**，散在**六个**算符上：`operator +=` 3、`operator ->` 2、
  `operator *` 2、`operator ?`（那是 `operator bool`，语法上走 cast-op 那一支，所以名字印成了
  `?`）1、`operator ==` 1、`operator !=` 1。它们与前三刀（`:=` / `++` / `--`）不同：调用点在
  **求值**那条路上（`*it` 是 `indirect`、`it->m_x` 是 `ptr-field`、`==` 那两个在二元那一处），
  而且**读写两侧都要认**（`it->m_value = value` 是语料里的真写法，stdt_Map.jnc:150）。
  语料里用它们的地方：`T* p = *it;`（stdt_HashTable.jnc:107）、`return it->m_value;`
  （stdt_Map.jnc:142）、`it ? it->m_value : undefinedValue`（stdt_Map.jnc:117 —— 那个 `it` 当
  条件用的正是 `operator bool`）。
  > `operator *` / `operator ->` 那 4 处第一百三十四刀收了，剩 6 处：`+=` 3、`bool` 1、
  > `==` 1、`!=` 1。剩下这三格都在**二元**那一处（`bool` 那一格在"当条件用"那一处），
  > 与取值那两个不是同一条路。
- **`stdt$BoxListEntry$T* 没有字段 '…'`（8 处）**：这一行本身是**诊断的质量问题** ——
  话里漏了内部拼法（`$` 与 `*`）。实例名该有一套 `shown()` 认得的印法（`stdt.BoxListEntry<T*>`）。
  它不改答案，只改话；可它现在排在第 7 位，谁读这张榜都会先被它绊一下。

判据仍是那两张榜一起看，加上第一百一十八刀那条：**看哪一行不见了**。这一栏现在由尺子自己印
（`jnc-sweep --group` 的"整行没了"，不受 `--top` 限制）—— 不用再靠人记。

## 第一百三十四刀：取值那两个算符 —— `operator *` 与 `operator ->`

语料里声明在 stdt_Iterator.jnc:28-34（一格迭代器包着一格指针，两个都回那格指针），用它的地方
在 stdt_HashTable.jnc:107 `T* p = *it;` 与 stdt_Map.jnc:142/150 `return it->m_value;` /
`it->m_value = value;` —— **读写两侧都有**。

与前三刀（`:=` / `++` / `--`）的差别：那三个的调用点在**语句**上，这一族在**求值**那条路上。
两处钩子，各一句：

- `fieldLv` 里左边算完之后先问一句"有没有 `operator ->`"—— `it->m_x` 与 `(*it).m_x` 在这一层
  是同一条路（第十九刀起就是，普通指针上两者同义），所以**读写两侧一起就都对了**：
  `it->m_value = value` 靠的正是这一句；
- 求值那一侧的 `indirect`：`*it` **就是**算符回的那格指针，不是"再解引用一次"
  （`T* p = *it;` 是语料里的原话）。

### 一处顺手把重复的判断收成一格

求值那一侧为了先问算符，左边已经算过一遍了，再走 `derefLv` 就会**算第二遍** —— 诊断会报两回、
errorcode 的传播那两句会插两回。所以把 lvalue 里 `*p` 那三行判断提成 `ptrLv(n, p)`，
两侧共用一格判断。整份文件里一个这样的算符都没有时（244 份里 243 份）连问都不问。

### 两条界，明说

- `operator *` / `operator ->` 要**回一格指针**（`bad/opderef-nonptr`）：这一层收下它之后接着
  走的是"指针取字段"那条原有的路。jancy 那边回什么都行 —— 接下来那一步按回的类型再解析一遍，
  那要一整套"重载之后再解析"的路。
- `(*x).f` 在这一层用的是 `operator ->`（没写才落回 `operator *`），因为 `.` 与 `->` 从第十九刀
  起就收在同一条路上、`fieldLv` 收到的节点一模一样。jancy 那边 `(*x).f` 严格走 `operator *`——
  **这一格记成账**。语料里那两个算符回的是同一格 `m_p`，所以看不出差别；哪天有人写出两个不同的
  返回值，这一格就得先把那两条路分开。

账：逐份那张榜 lowered 88 / clean 163 / pairs 7465 **一格没动** —— 这一族的用点全在 `stdt`
那几份里，而那几份被更早的墙（未绑定的泛型参数）挡着，逐份编根本走不到调用点。
`--group std` `357 条 / 33 种` → `353 条 / 33 种`：`算符重载 '…'` `10 -> 6`（−4，正是那四条声明）。
这一刀是"墙拆了、门后还有一道"的又一例：真正的收成要等泛型那一格通了才看得见。

尺子 `/tmp/c131.c`：手写那两个函数与四处调用 —— `it->m_y = 9` 摊开就是
`It_arrow(&it)->m_y = 9`。同一串数（5 6 / 5 / 9 / 70 80）。

## 第一百三十五刀：泛型的成员**写在体外** —— 这一轮最大的一格

`--group std` 那张榜的榜首是 `没有这个类型`（134 处），里头大半是 `T` / `T*` / `I` / `T const*`
—— **泛型参数自己的名字**。前一刀记下的选题说"未绑定的参数漏出去了，做之前先量清楚是哪几条路
漏的"。量清楚了，就一条：

```jnc
struct Box<T> {
    T fetch();          // 体里只写原型
}

T Box<T>.fetch() { return m_v; }   // 体外补上 —— 这一条原样留在名单里
```

jancy 里"体内写"与"体外写"是同一件事、任选其一（type_class.rst:41-59）—— 第五十二刀就是按这
一句办普通类的（两种放法落在同一格 `C$foo` 上）。泛型这一侧先前只办了体内那一半：`aggHoist`
把体里的成员跟着实例提出来，而**体外那些条目谁也没管**。它们原样留在名单里，里头那个 `T`
从来没绑过，于是照字面降了下去 —— 一片"没有这个类型：'T'"。

账记在别处，因在这儿：榜首那一行说的是"这个类型不存在"，而真话是"这一条本来就不该按字面降"。

改法与体内那一半同一条，两小段：

- `expandTemplates` 的 A 遍之后加一遍 A2：`tmplOuter` 认出这样的条目（声明符核心一层层往左剥
  到底，最左那一格是 `tinst`、名字又在 `this.templates` 里），从名单里摘出来记在那格泛型的
  `outer` 上；
- `tinstOne` 末尾（紧挨着 `aggHoist` 那一句）把 `tm.outer` 每一条 `tmplSubst` 一份再
  `tinstRewrite`。`tmplSubst` 连声明符里那格 `(tinst Box (targ T))` 的 `T` 一起换，于是
  `tinstRewrite` 自然把它解成**当前这格实例名**（`tmplInsts` 已 memoise，不会重造），
  名字落成 `Box$int$fetch` —— 与 aggHoist 提上来的那一批一模一样。

### 账：这一轮最大的一格

- 逐份那张榜：lowered `88 -> 91`（**+3**）、clean `163 -> 164`、pairs `7465 -> 7419`（**−46**）；
- `--group std`：`353 条 / 33 种` → **`151 条 / 20 种`**（−202 条、−13 种）。
  `没有这个类型` **134 -> 0，整行没了**；跟着一起没的还有 12 行，其中
  `stdt$BoxListEntry$T* 没有字段`（8，上一刀记下的那处"诊断质量"问题，源头就是这个）、
  `alias 的目标`（3）、`没有这个基类`（2）、`泛型的实参是一格泛型自己的名字`（2）、
  `这种类型说明符`（2）。
- 剩下的榜首换成了 `原型 '…' 没有带体的定义`（70）—— 那一格是**宿主面**（opaque class），
  不是这一层的墙。也就是说 std 那一批现在只剩"要么在宿主那边、要么是属性 / 算符那几族"的账了。

判一刀的量级要看它在依赖图上的位置（第一百二十三刀记过这一句）：这一格是 `stdt` 那一族
**每一份**都要走的一步，所以它一通，后面那些格才第一次量得准。

顺带说明一句这一刀与上一刀的关系：`operator *` / `operator ->` 那一刀（第一百三十四刀）当时
量出来"逐份榜一格没动"，理由写的是"用点被更早的墙挡着"。那道墙就是这一格 —— 拆了之后
`stdt` 那几份才第一次走到调用点上。

尺子 `/tmp/c132.c`：C 里没有泛型，手写的是"每格实参各出一份函数"—— 三格实参、六个函数。
同一串数（7 / 9 / 5 6 / 41）。

## 第一百三十六刀：体外写的方法名叫 `get` / `set` —— **两张榜一格没动**的一刀

语法上它与属性的取值器一模一样：`int C0.get() { … }` 与 `int C.p.get() { … }` 都是
`(qualified-special … (accessor get))`。所以先前一律当属性办 —— 左边那个 `C0` 拿去属性表里查，
查不着就报"**没有这个属性：'C0'**"。那句话指着别处：`C0` 是个类名，写错的不是它。

判据一句：**左边那个名字解得出一格属性吗？**解不出、而解得出一格类 / 结构体，这就是一格普通
方法 —— 名字接回去（`C0.get`）、`special` 清掉，走普通方法那条常路。

这一格与第六十九刀那条注是同一族。三种形状现在各走各的路：

- 类体里**裸写**的 `int get(int i)` —— 下标运算符（还不收）；
- 名字写在前面、而那个名字是**属性**：`int C.p.get()` —— 属性的取值器；
- 名字写在前面、而那个名字是**类**：`int C0.get()` —— 普通方法（这一刀）。

`127-outerget` 把三者里后两种摆在同一份里，而且摆在**同一个类**上（C1 既有一格叫 p 的属性、
又有一格叫 get 的方法），所以那句判据要是写反了，这一份立刻红。

### 账：**两张榜一格没动**

逐份 91 / 164 / 7419，`--group std` 151 条 / 20 种 —— 与上一刀一模一样。语料里这个形状的原样是
`Value MapImpl<T>.get(Key key) const`（stdt_Map.jnc:135），而 `MapImpl` 在这一批里**没人实例化**
到那一步，所以它一条诊断都不产。

那这一刀凭什么落？两条：

1. 它修的是一句**认错人的诊断**（"没有这个属性：'C0'"指着一个没写错的名字），而这类洞在这一轮
   里已经量到第四次了（第一百一十七刀的位域、第一百三十刀的返回类型、第一百三十二刀的
   "按值套回了自己"、这一刀）；
2. 它是上一刀**打开的门后面**那一格 —— 第一百三十五刀把泛型的体外成员接上之后，
   `MapImpl<T>.get` 这个形状才第一次走到这一处判断上；今天没人实例化它，哪天有人实例化就是
   静默的错答案（那时它会被当成"MapImpl 上一格叫 get 的属性"）。

**榜没动也是账**：写下来，免得下一趟看见这一刀以为它白做了，也免得有人拿"榜没动"当理由把它
回退掉。

尺子 `/tmp/c133.c`：C 里 `get` / `set` 就是两个普通名字，压根没有"取值器"这回事 ——
手写的正是那两条该落成什么。同一串数（4 / 9 / 69 70）。

## 第一百三十七刀：查名走**基类那一层** —— 连着第二刀"两张榜一格没动"

jancy 里类**同时是一层命名空间**（`ClassType` 派生自 `Namespace`），而派生类那一层接在基类那一层
上 —— 查名沿 `m_baseTypeList` 上溯。这一层先前不走这一步：`resolve` 只顺着当前那层一层层往外退，
从不看基类。三行就看得见：

```jnc
class B0 { typedef int X; }
class D0: B0 { X m_v; }        // 报"没有这个类型：'X'"
```

这条与泛型无关（非泛型代码同样撞），可它正是 `stdt` 那一批里 `construct(EntryPtr p)`
（stdt_Iterator.jnc:62，`EntryPtr` 在基类 `IteratorBase` 那一层）与 `Iterator append(T value)`
（stdt_BoxList.jnc:68）那两族的形状。

落法：`aggHoist` 那一遍记一张"类的全名 -> { 当时那层命名空间, 源码里写的基类名字 }"。**必须在
那一遍记** —— `this.bases` 是 `typeDecl` 才填的，而 typedef 与"类型的名字先坐下"那两遍都排在
`typeDecl` 之前，那时问 `this.bases` 什么都没有。基类名字解成全名留到查名的时候（那时类都登记
上了），所以 `baseResolve` 会回头调 `resolve` —— `inBase` 是那道闸门，解基类名字时不再往基类上
走，免得绕回来。

顺序两条写清：**自己那几层先查完才轮到基类**（`D3` 自己也有一格 `X` 时用自己那格）；多格基类按
**声明顺序** BFS（与第九十四刀 mixins 同一条口径：第一格先）。`128-basetypedef` 四个面各一格：
基类的成员 typedef、基类的嵌套类型、隔一层（`D2 -> M0 -> B0`）、自己那格遮住基类那格。

### 账：**又是两张榜一格没动**

逐份 91 / 164 / 7419，`--group std` 151 条 / 20 种 —— 与前两刀一模一样。原因写清：`stdt` 那两族
的形状里，`IteratorImpl<B, M>: B` 与 `MapImpl<T>: T` 的基类写的是**参数**，那要先有"参数当基类"
那一格（ADR-0025 还欠着）；而 `BoxList<T>: List<…>` 那一支在这一批里没走到那一步。也就是说
这一刀修的是**真的洞**，可语料里恰好没有一处**只差它**的。

连着两刀榜都没动，这件事本身要记一句：**榜是选题的尺子，不是验收的尺子**。验收的尺子是
"那份 C 双胞胎跑出同一串数"加"jnc 轴不红"—— 这两刀都过了。反过来说，连着两刀不动也是个信号：
下一刀该回去挑榜上真正还带着数的那几格（属性那一套 10 + 4、算符重载剩的 6），或者去啃
`原型没有带体的定义` 那 70 处背后的宿主面口径。

尺子 `/tmp/c134.c`：C 里 typedef 与 struct 都没有继承这回事，手写的是"每一处该解成哪个类型"。
同一串数（3 / 7 / 9 / 65）。

## 下一刀的选题：**下标算符**（量过了，形状已经定住，没做）

第一百三十七刀之后 `--group std` 剩 151 条 / 20 种，里头带着数又不是宿主面的最大一格是
`'…'（要属性那一套：property / bindable / autoget）`（10 处）。把那 10 处摊开看，它**不是**属性
那一族 —— 是**下标算符**，而且形状整齐得只有一种：

```jnc
class Array {                            // std_Array.jnc:26/31
    variant_t get(size_t index) const { … }
    bool errorcode set(size_t index, variant_t v) { … }
}
```

std_Array、std_Buffer（`char get(size_t offset)` / `bool errorcode set(…)`）、std_HashTable、
std_RbTree（`variant_t get(variant_t key)` / `void set(…)`）各一对，正好 10 处。类体里**裸写**的
`get` / `set` 在 jancy 里就是下标算符（`c[10] = 100` 走的是 `set`，test90.jnc:12-24）——
第六十九刀那条注早把这件事写下来了，只是当时把它留给了以后：`accessorNamed` 那处专门区分
"名字写在前面的 `p.get()` 才是属性"，裸写的这一批照旧由 typeDecl 报"还不收"。

这一刀的形状（做之前该定的都定了）：

- **登记**：裸写的 `get` / `set` 提到顶层，名字拼成 `Owner$op$index$get` / `$op$index$set`
  （与第一百三十~一百三十四刀那四族同一套 `$op$` 命名），`this` 当第一个形参 —— 也就是
  aggHoist 那一句的条件里放它进去、typeDecl 那一句里别再报它、fnSig0 里认 `info.name === ''`
  加"当时那层是个类 / 结构体"这两条；
- **调用点两处**：求值那一侧的 `index`（排在 `propIndexGet` 之后、`derefLv` 之前 —— 那儿只会报
  "下标要一个指针"），赋值那一侧 `head(lhs) === 'index'`（排在索引属性那一问之后）。两处都要
  先问一句"左边那格的类型上有没有这个算符"；
- **界**：下标只收**一个**（语料里全是一个）；`set` 那一格的返回值（`bool errorcode`）按第
  五十八刀的老路走，调用点不写 `try` 就自动往上传；一格 owner 上只收一个 `get` 与一个 `set`
  （重载要按实参类型挑，与第八十刀同一笔账）。

为什么值得单独一刀：它是这一轮里第一格**调用点在两侧、而且两侧的语法都不是"看着像调用"**的
算符 —— 前四族（`:=` / `++` / `*` / `->`）的调用点都只有一处或两处同型。它也是 `std_Buffer` /
`std_Array` 那几份真正能跑起来的前提。

顺带记一句量法：这 10 处的诊断名字叫"要属性那一套"，而真相是下标算符 —— **榜上的名字是拦路
那一句话，不是那件事的名字**。挑题时看见带"属性"的行，得先摊开看一眼是不是真的属性。

## 第一百三十八刀：**下标算符** —— 上一刀选的那一格，做完了

上一节把形状定住了，这一刀照那份清单落：`bareAccessor` 认出类 / 结构体体里**裸写**的
`get` / `set`（与属性那一族分得开的就是"名字没写在前面"），aggHoist 提上去、typeDecl 别再报，
`opIndexSig` 登记成 `Owner$op$index$get` / `$op$index$set`，两处调用点各问一句"左边那格的类型上
有没有它"—— 求值那一侧的 `index`（排在索引属性之后、`derefLv` 之前）与赋值那一侧的 `index`。

三件顺手办的事：

- 读写两侧共用一个 `opIndexCall`：差别只有"末尾多不多一个值"。`errorcode` 走 `propagate`
  —— 语料里 `set` 全是 `bool errorcode`，这一句漏了那个词就被悄悄吞掉、调用点从此不再检查
  错误码。
- 与第一百三十四刀同一条：求值那一侧为了先问算符已经把左边算过一遍，所以把 lvalue 里 `p[i]`
  那几行判断提成 `subLv(n, a)`，两侧共用一格判断，不算第二遍。
- **同一条 else 上第四次踩坑**：`fnSig0` 给特殊成员摆说明符那一句先前是
  "`get` 问 specs、别的都吞成 void"，于是裸写的 `bool errorcode set` 返回类型被吞掉，体里的
  `return false` 报成"**main 里 return 一个非 0 的值**"—— 与第一百三十刀那次一字不差。
  这回判据按"裸写还是写了名字"分：属性的存值器（`p.set(T x)`）才是没有说明符的那一种。
  第一百一十七刀、第一百三十刀、第一百三十二刀、这一刀 —— 共用的分支上每加一种形状，
  就要回头看那条分支的每一个 else。这句话已经记了四遍，下一次该考虑把那条分支拆开。

界：下标只收一个；一格 owner 上只收一个 `get` 与一个 `set`；`c[i] += 1` 明说不收
（`bad/opindex-compound` —— 要先读一次再写一次，两次调用加一次求值，是另一笔账）。

### 账

- 逐份那张榜：lowered `91 -> 92`、clean `164 -> 165`、pairs `7419 -> 7415`。整行没了一行：
  `下标要一个指针，这里是 C2` —— 那正是先前把 `c[i]` 当指针解引用报出来的那句话。
- `--group std`：`151 条 / 20 种` → **`146 条 / 20 种`**。`'…'（要属性那一套）` 那 **10 处整行
  没了**；新进来一行 `不写 try 调 errorcode 的 '…'`（5 处）—— 那是**墙后面那一格**：std 自己
  那几处 `c[i] = v` 调的是 `bool errorcode set`，而调用的那几个函数自己不是 errorcode、外面也
  没有 `try`。这一格是 jancy 那边走运行期 dynamic throw 的那条路（第五十八刀记过），
  不是这一刀漏的。

尺子 `/tmp/c136.c`：C 里 `c[i]` 只能是指针加下标，手写的是"编译器该替你挑的那次调用"，
errorcode 那一格照第五十八刀把糖摊开。同一串数（70 / 70 30 / 5 / 0 66 / 9）。

## 第一百三十九刀：转换算符 `operator bool` —— 顺手把 `operator ?` 那个名字改对

语法上它是 `(operator (cast-op (specs bool …) (ptrs)))`：目标类型那一格是**一整棵说明符**，
不是一个词。所以 `specialCore` 里那句 `isAtom(core.items[1])` 不成立，它先前回的是
`'operator ?'` —— 榜上那一行印出来就是 `算符重载 'operator ?'`，谁看了都不知道是哪个算符。

调用点只有一处：`truthy`。它一处管齐 `if` / `while` / `? :` / `&&` / `||` —— 那几处的条件全从这
一句过。语料里的用法是 `it ? it->m_value : undefinedValue`（stdt_Map.jnc:117）。

**顺序是这一刀唯一要想清的事**：这一问要排在 `truthy` 里**类那一支之前**。类引用当条件用在第
五十二刀那儿是"跟零比"（一次空检查）；而写了 `operator bool` 的那一格上，用户的意思是"问那个
算符"。排错了就是**静默的错答案** —— 一个非 null、可算符说 false 的对象会被当成真。
`131-opbool` 里的 C1 就是摆着量这件事的：`new` 出来的对象（非 null）、算符回 false，
该印 `no`。

### 顺手：把还不收的那两个也叫出名字

`operator ()`（`(call-op)`）与 `operator []`（`(index-op)`）也是自己一格节点，先前与 cast-op 一起
印成 `operator ?`。两个都还不收，可**话要说出是哪一个**：现在榜上那一行是
`算符重载 'operator ()'`（原样在 stdt_Operator.jnc:97，`static size_t operator () (string_t key)`
—— HashTable 的哈希函子）。上一刀刚记过这一条：榜上的名字是拦路那一句话，不是那件事的名字；
那就把那句话说准。

### 账：**两张榜一格没动**，可榜上那一行的**字**变了

逐份 92 / 165 / 7415，`--group std` 146 条 / 20 种，`算符重载` 还是 6 —— 因为 std 那一批里
`operator bool` 的声明在 `IteratorBase<P>` 里、用点在 `MapImpl` 里，两处都没走到实例化那一步。
变的是那 6 处的**明细**：`operator ?` 1 处变成了 `operator ()` 1 处。

这一轮里第三次"榜没动"。三次的性质各不相同，记清楚免得混：
第一百三十六刀是**语料里恰好没有只差它的地方**；第一百三十七刀是**它要等另一格**
（参数当基类那一支）；这一刀是**声明与用点都在没被实例化的泛型里**。

尺子 `/tmp/c137.c`：C 里没有转换算符，手写的是"每一处条件该调的那次调用"—— C1 那一格得自己
选"问算符还是问 NULL"，选出来与 jnc 一致，账才算平。同一串数（2 / yes / 2 / no / 7）。

## 第一百四十刀：相等算符 `operator ==` / `operator !=`

语料里的原样在 std_Guid.jnc:80/84：`bool operator == (Guid const* op) thin const` —— 一个形参、
回 bool，而那个形参是**指向同一格结构体的指针**，不是那格值本身。

调用点在二元比较那一处（`binary`），两边算完之后先问一句。要放开的只有类型那一问：这一层结构体
那一格里放的**就是地址**（第十二刀），所以 `a == b` 里那格值的 code 拿去当指针传本来就是对的
—— 形参是指针、而它指的正是右边那格结构体时也算对得上。这一格是第十二刀那条口径第一次在
**实参**这一侧派上用场。

**顺序**与上一刀同一条：这一问要排在 `binary` 里**类那一支之前**。类引用上的 `==` 在第五十二刀
那儿是"比是不是同一个对象"（`peq`）；写了算符的那一格上，用户的意思是"问那个算符"。
`132-opcmp` 里的 C1 就是摆着量这件事的：两个 `new` 出来的**不同**对象、内容相同 —— 走算符该说
相等（印 `eq`），走 `peq` 会说不相等。排错了就是静默的错答案。这是连着第三刀在同一件事上做
选择（一三八的下标 / 一三九的 bool / 这一刀的 ==），三处的判据一模一样：**写了算符就问算符**。

两条界：`==` 与 `!=` **各自登记、互不代替**（只写了 `==` 而源码写 `!=` 时不替它取反 —— jancy
那边也是各挑各的重载，语料里 std_Guid 两个都写了）；跟 `null` 比不走这条（那一问在两边都是
"这一格在不在"，与内容相等不是一件事）。

账：逐份榜 lowered 92 / clean 165 没动，pairs `7415 -> 7413`（−2）。`--group std` 总数
`146 -> 146`（没动），可 `算符重载` **6 -> 4**：剩下的是 `operator +=` 3（std_String，
`size_t errorcode operator += (…)`）与 `operator ()` 1（stdt_Operator 的哈希函子）。
`没有这个函数` `27 -> 29`（+2）—— 那两条 `==` 的体现在真降了，于是体里调的东西往下走了一步，
是拆墙那一族的常态。

算符这一族到这儿收了 **9 个**：`:=` / `++` / `--`（含 postfix 两个）/ `*` / `->` / 下标的
`get` `set` / `bool` / `==` / `!=`。剩两族：`+=`（复合赋值，要先读一次再写一次那条路，与下标
那一格的 `c[i] += 1` 是同一笔账）与 `()`（调算符）。

尺子 `/tmp/c138.c`：C 里结构体之间没有 `==`，手写的是"编译器该替你挑的那次调用"；C1 那一格得
自己选"比内容还是比地址"。同一串数（1 0 / 0 1 / eq / ne）。

## 口径与选题：`--group` 的第二张榜（ioninja 那 44 份），以及一格**被我误判过**的行

算符那一族收到第九个之后，std 那一批只剩宿主面加两族算符（`+=` 3、`()` 1）。于是把
`--group` 指向语料里另一整批 —— ioninja 的 api（44 份，它的 CMakeLists 本来就是整批一起编的）：

**213 条 / 59 种**（这一批的第一份基线，从此可比）。前几行：`未声明的变量` 45、
`没有这个函数` 41、`没有这个类型` 11、`枚举 '…' 里没有 '…'` 9、`枚举成员的值算不出来` 9、
`原型没有带体的定义` 9、`写属性 … 存值器没有定义` 8。

### 那两行枚举（9 + 9）是**一件事**，而且我先前把它判错了

这一轮里我抽查逐份那张榜时看过 `枚举成员的值算不出来`(97)，当时的结论是"`ui.StdColor` 没
import，是逐份编的量法 artifact"。**一起编之后它还在**，所以那个结论只对了一半。摊开看：

```jnc
// ui_Color.jnc:22
enum StdColor {
    Black = ColorFlags.Index | 0,     // 同一份文件里前面声明的 bitflag enum
    Red,                              // 1
    …
    PastelPurple,                     // 21
}

// log_Representation.jnc:74
Start = ui.StdColor.PastelPurple,     // 报"枚举 'ui.StdColor' 里没有 'PastelPurple'"
```

`ui_Color.jnc` 自己**一条诊断都没有**（`StdColor` 降得干干净净），可 `log_Representation.jnc`
说它里头没有 `PastelPurple`。因不在折叠上，在**顺序**上：合成的那份模块按文件名排 import，
`log_Representation` 排在 `ui_Color` 前面，于是用它的那一格先降 —— 那时 `StdColor` 的成员表
还没填。jancy 那边是"先把名字都声明下来、再算值"的两遍，这一层是一遍。

所以这两行 18 处是同一格账：**枚举成员的初值引用了后面才声明的枚举**。做法也清楚 ——
把"算成员的值"那一步从 typeDecl 那一遍里分出来：算不出来的先记着别报，等这一遍走完再来一轮，
跑到不动点为止（引用成环时才报，与第一百二十八刀那道闸门同一条路）。

这一格记下来的另一件事是**量法**：一行诊断的性质要在**两张榜上都看过**才敢下结论。
我先前只看了逐份那张榜就说它是 artifact —— 那是猜的第二次（第一次是第一百三十一刀的
`readonly`）。规矩补一句：说一行是"量法造成的"，得拿一起编那张榜证一次。

顺带记两处**诊断把内部拼法漏出去**的地方（都在"没有字段"那句上，`lower.js` 两处）：
ioninja 这张榜上有 `doc$PluginHost 没有字段 '…'`（5 处），std 那张榜上先前有
`stdt$BoxListEntry$T* 没有字段 '…'`（8 处，第一百三十五刀之后没了）。那两句该走 `shown()`。

## 第一百四十一刀：枚举的值**算的顺序**——`7413 -> 7243`，这一整轮里最大的一格

上一节量出来的那件事，这一刀做掉：枚举成员的初值引用**后面才声明的**枚举时，这一层必然算不
出来（那时它的成员表还没填）。jancy 那边是"先把名字都声明下来、再算值"的两遍
（`calcEnumConstValues` 排在 `addItem` 那一遍之后），这一层是一遍。

改法不是加一整遍，是**留一格重试的名单**（`enumTodo`）：

- 算不出来时**先别报**，整格枚举退回去 —— 成员表清空，无名枚举漏到外层的那几个名字也撤掉
  （不撤的话下一轮会撞上"与外面那层已经有的一格同名"，那是自己造出来的假账）；
- `typeDecl` 那一遍走完再来几轮，一轮解开一层，跑到不动点；
- 一轮下来一格都没解开 —— 剩下的是真算不出来（或者引用成环），那时把 `enumRetry` 打开再走
  一遍，这回报出来（`bad/enum-cycle`）。轮数天然有界：每轮要么少一格，要么就是最后那一遍。

顺手改一处**认错人的诊断**：算初值的第一遍里 `enumMember` 不许报"枚举 B 里没有 P"——
那时它可能只是还没填。这一格与第一百三十二刀（"按值套回了自己"）是同一族：
**一遍就想算完的地方，报错要等到最后一遍**。这句话与"共用的分支上每加一种形状就要回头看每个
else"并列，是这一轮记下的第二条通用口径。

### 账：两张榜一起大动

- 逐份那张榜：pairs `7413 -> 7243`（**−170**）、clean `165 -> 166`，lowered 92 没动。
  **两行整整没了**：`枚举成员的值算不出来`（97 处）与 `枚举 '…' 里没有 '…'`（89 处）。
- `--group ioninja`：`213 条 / 59 种` → **`195 条 / 57 种`**，同样是那两行（9 + 9）整行消失。
- 一件顺带露出来的事：`bitflag enum '…' 里的负值` 那一行的 **sole 从 9 跳到 28** ——
  也就是说有 28 份文件现在**只差这一行**就干净了。而那一行是这一栏里唯一一条
  "**没有可对的答案**"的账（jancy 那边 `2 << getHiBitIdx64(负数)` 是 C++ 的未定义行为，
  第四十七刀记的）。下一刀的选题得先想清楚：要么按 jancy 实测的行为照抄一个数（那是把 UB
  当规范，得写明白），要么这 28 份就永远停在这儿。

为什么一刀能动 170 对：这两行先前是**逐份榜上第 8 与第 12 大**的两格，而它们的因是同一个 ——
一个顺序问题穿在 655 份里的 186 处。挑题时看见两行数字接近、名字又都带同一个词（"枚举"），
值得先摊开看一眼是不是同一格账。

尺子 `/tmp/c139.c`：C 里 enum 的初值只能引用**前面**已经定下的常量，所以手写的是"值都算完之后
的那张表"—— 算的顺序不该改变算出来的数。同一串数（5 6 6 / 1073741824 1073741825 / 3）。

## 第一百四十二刀：`bitflag` 的下一格按**无符号那一面**算 —— 一条记错了 94 刀的账

上一刀量出来"`bitflag enum '…' 里的负值` 那一行的 sole 从 9 跳到 28"，于是这一刀先去看那一行
到底拦的是什么。**第四十七刀那句话错了两处**：

原话是"里的负值 —— jancy 那边 `2 << getHiBitIdx64(负数)` 是 C++ 的未定义行为，没有可对的答案"。

1. **`getHiBitIdx64` 收的是 `uint64_t`** —— jancy 那一步从来没见过负数。所谓"负值"是这一层
   自己把值按 signed 存下来之后看出来的：`Foldable = 0x8000000000000000`
   （log_RecordCode.jnc:18，`bitflag enum RecordCodeFlags: uint64_t`）在 64 位那一格里就是
   最高位，signed 看是负数。**那个值本身完全合法**，jancy 收它。
2. **拦的位置错了**：这一层拦在**写着那个值的成员**上，可算不出来的是**下一个**成员的自动取值
   —— 而那样的成员常常就是最后一个（`RecordCodeFlags` 里 `Foldable` 就是唯一一个）。
   把"下一个算不出来"记到"这一个"头上，于是一格好值被拒了。

改法两句：算下一格时先取无符号那一面（`v < 0 ? v + 2^w : v`，`w` 是这一格的基类型宽度），
然后只在**真有下一个成员要用它、而它又出了这一格宽度**时才报。`bad/bitflag-neg` 那一份留着
（`A = -1, B`）—— 拦的从 `A` 挪到了 `B`，话也换成"'B' 的自动取值超出了 32 位（上一格已经是
最高位）"。那一份的注一并改对：先前写的"没有可对的答案"是错的，jancy 那一步是有定义的
（移出去之后是 0，那会把两个成员悄悄取成同一个值 —— 所以这一层宁可明说，但那是**另一个**
理由）。

### 账：这一整轮里最大的一格

- 逐份那张榜：lowered `92 -> 120`（**+28**）、clean `166 -> 200`（**+34**）、
  pairs `7243 -> 7075`（**−168**）。`bitflag enum '…' 里的负值` 那一行 **168 处整行没了**。
- `--group ioninja`：`195 -> 194`（那一批里只有 1 处）。

一条错账拦住了 168 对、28 份文件、94 刀。为什么它能藏这么久：**它长得像一条已经想清楚的界**
—— 有 jancy 源码行号、有"UB"这个词、有"没有可对的答案"这句结论。这一轮里三次翻案
（第一百三十二刀的"按值套回了自己"、第一百三十九刀之前那个 `operator ?`、这一刀）都有同一个
形状：**话说得越像结论，越要回去看一眼那句话的第一个字是从哪儿来的**。

顺手记一条口径，与"一遍就想算完的地方，报错要等到最后一遍"并列：
**把"下一步算不出来"记在"这一步"头上，是错账的常见形状** —— 报错的位置要落在**真正用不上**
那个值的地方。第一百三十四刀（`(*x).f` 用 `->`）、第一百三十八刀（`bool errorcode set` 的返回
类型）、这一刀，三处都是"位置"而不是"判断"错了。

尺子 `/tmp/c140.c`：C 里 enum 没有 bitflag，"下一个"也不是移位来的，手写的是"那张表该长什么
样"。同一串数（1 2 4 / -9223372036854775808 / 1 2）。

## 第一百四十三刀：`null` 当一格**函数值** —— 换的是那句话指着谁，不是拦了几处

`void function* onTriggered() = null`（ui_Action.jnc:39）先前报的是
"null 得从左边知道自己是哪种指针（这里问不出来）"。这句话**认错人**了：左边说得出它要什么
—— 一格 `(fnty …)`，一点也不含糊。`cb == null` 同理，那一句先前连类型都没往下传。

真拦路的在**方言那一侧**：函数值只能从一个真函数做出来（`(fnref NAME)`，
tests/sexpr/cases/15-fnvalues.sx:28），方言里**还没有"空的那一格"**。要收它得先给方言加一个
空函数值，那会渗到 MIR 与四个后端 —— 是 ADR-0028 那一栏的事，不是这一层一句话能办的。

所以这一刀**只改那句话**：`null` 的 want 是函数类型时说"方言里的函数值只能从一个真函数做出来
（`(fnref …)`），还没有'空的那一格'"；`binary` 那边把左边的函数类型也传给右边的 `null`
（先前只传指针与类），免得同一件事在比较里又说成"问不出来"。`bad/null-fnvalue` 记这条界。

### 账：pairs `7075 -> 7140`（**+65**），是拆行拆出来的

- 逐份那张榜：lowered `120`（没动）、clean `200`（没动）、pairs `7075 -> 7140`。
- `--group ioninja`：`194`（没动）、理由 `56 -> 57`（**+1**）。

+65 全来自**一行拆成两行**：先前"null 得从左边知道自己是哪种指针"那一行里，函数值那个子集现在
换了名字，于是**同时撞上两种形状的文件各多算一对**。这是已经记下的"换名型/拆墙型的刀 pairs
天生朝上走"，判它看的是"哪一行没了"—— 这一刀哪一行都没没，lowered/clean 也都没动，因为
**拦的处数一处没变**。

值得把这一格与上一刀摆在一起看：第一百四十二刀是"话说得像结论，回去看第一个字从哪儿来"，
翻出 168 对；这一刀同样是回去看第一个字，翻出来的却是**零对** —— 那句话确实错了（认错人），
可它错的是**指着谁**，不是**拦不拦**。于是记一条口径：
**"这句话说错了"与"这一处拦错了"是两笔账** —— 前者该改，改完榜上不该动；后者才是榜上会动的
那种。改前者时若看见 lowered/clean 动了，要先怀疑自己顺手改了后者（那就是另一刀，得单独记）。

这一格没有尺子（`/tmp/cNN.c`）：它是一条**界**，没有该对上的输出 —— 与 `bad/` 下别的界一样，
出处是语料里那一句本身（ui_Action.jnc:39）与方言那一侧的 `15-fnvalues.sx:28`。

## 第一百四十四刀：同元重载 —— "不降就问得出来"的那一格再添五种

第八十刀那条界**没动**：挑哪一条要先知道实参是什么类型，而 `expr` 是按 want 定向的、降的时候
会发码，所以不能"先降一遍拿类型、再降第二遍"。这一刀动的只是**哪些实参不用降就问得准** ——
先前只有字面量、`true`/`false` 与查得着的名字，现在再添五种，每一种都是纯查表、一个字不发：

- `new C(…)` —— 类型就写在那儿（只收"一个名字、没有指针后缀、没有修饰符"这一种写法：别的要走
  `specs`，而 `specs` 会报诊断，cheapTy 里不许）；
- `x.f` / `p->f` —— 字段表查一次。**属性与方法名一律回 null**：那两种右边的名字不是字段，
  而 `autoget` 的属性还有一格同名的底层字段 —— 拿它的类型当答案就是接错人（读它其实是一次调用）；
- `f(…)` —— 自己不是一族重载时就是它的返回类型（是重载的回 null：那要先挑一条，绕回来了）；
- `&x` —— 取地址不改"是什么类型"这件事；
- `E.M` —— 枚举成员，值与类型都在编译期。

这五种是**量出来**的，不是想出来的：把那一行拦着的实参逐处摊开看，全是它们 ——
`new ui.Icon(iconFileName)`（doc_Plugin.jnc:68）、`new Label(label)`（ui_Layout.jnc:107）、
`text.m_p`（log_Writer.jnc:75）、`std.getLastError()`（同上:101）、
`StdRecordCode.SyncId` 与 `&syncId`（同上:136）。

`bad/overload-argtype-unknown` 这一份**收了，所以划掉**：它拦的形状（`p(mk())` —— 一次调用）
正是上面第三种。它改成了 `cases/135-overloadcheap.jnc`（五种一份里全走一遍），剩下的界另起一份
`bad/overload-argtype-expr.jnc`（`q(x + 1)` —— 一次二元运算，类型要按两边提升出来）。

### 账：pairs `7140 -> 7355`（**+215**），clean `200 -> 202`，lowered `120` 没动

+215 逐行摊开（拿"把这一刀撤了再量一遍"量的，三行整行是这一刀新长出来的）：

- **65 处** 新的 N：`new ui.Icon(…) —— 它的 construct 声明在 opaque class 里、实现在宿主的
  C/C++ 那边`。这一格是**好消息**：先前那句"第 2 个实参问不出来"把话说在半路上，现在挑得动了，
  于是走到真正拦路的那一句 —— 宿主面（第六十六刀那条账）。换的是"指着谁"，与上一刀同一形状；
- **77 + 77 处** 新的 E：`'ui.FormLayout.addRow' 的 2 条重载没有一条收得下这几个实参
  （ui.Label*, ui.Widget* / ui.Layout*）`。这一格是**坏消息**，而且它指出了下一刀：那个类里
  `addRow` 写了 **6 条**（4 条只有原型、2 条带体），可这一层只把**带体的**那 2 条收进候选 ——
  于是 `(Label*, Widget*)` 一条都合不上。拿 `/tmp/ov.jnc` 单独量过：三条同名、两条只有原型时，
  调用点根本没进重载决议，直接落到带体的那一条上报"第 1 个实参要 string"。**只有原型的重载
  不进候选**是一条**先前就在**的错账（榜上 `'…' 要 2 个实参，这里给了 1 个` 91 处、
  `'…' 有 2 条重载，收的实参个数是 2 / 2` 那一族都是它），这一刀只是把它露出来；
- 三行 `同元重载：第 N 个实参…` 从 90/85/84 变成 85/85/84（−5）。

`--group test/ioninja/api`：**194 条（没动）**、理由 `57 -> 60`。那两行 77 的 E 在一起编那张榜上
**不出现** —— 照"说一行是量法造成的得拿一起编那张榜证一次"这条口径，这一格反过来也成立：
一起编时那 6 条原型都在同一份里、候选凑得齐，所以那两行只在**逐份**那张榜上长出来。

尺子 `/tmp/c141.c`：C 里没有重载，所以这一份记的是"该挑哪一条"这个**判断** —— 我先照 jancy 的
`chooseOverload`（每个候选取各实参里最差的一档，取最高分）自己算出五句各落到哪一个 `q` 上，
再在 C 里直接写出那个函数名，两边没有共用的一步。同一串数（int 1 / int 3 / code 7 / blob 3 /
base 5）。

## 第一百四十五刀：初值降不下来时，那个名字仍旧进作用域 —— 一起编那张榜 194 -> 157

`GroupProperty* prop = new GroupProperty(name);`（ui_PropertyGrid.jnc:420）初值那一句报一条
（那个类的 `construct` 只有原型），先前这一层**连名字都不记** —— 于是下面每一句用到 `prop` 的都
跟着报"未声明的变量 'prop'"。逐份那张榜上那一行 296 处、一起编那张榜上 45 处，全是这么长出来的。

**声明的类型是写出来的**，初值算不出来一点也不影响它，所以记下来不是猜。改法是一格 `declBail`：
`localDecl` 里每一处"这一格降不下来"的出口先把名字按**声明的类型**推进作用域再回 null。
这条语句照旧算失败（一个字也不发、退出码照旧 1），变的只是**后面那些句子指着谁说话**。

这与第一百四十二刀那条口径是同一件事的两面：那儿说"把下一步算不出来记在这一步头上是错账的
常见形状"，这儿是反面 —— **把这一步算不出来记在下面那些步头上，也是错账**。两者共一句话：
诊断要落在**真正说不通的那一句**上。

`bad/declfail-scope.jnc` 钉的是"第二句报的是什么"：`S* p = 1;` 之后 `p.nosuch = 2;` 该报
"S 没有字段 'nosuch'"（只有 `p` 在作用域里、类型也知道，才说得出这句）。把这一刀撤掉，
那儿出现的会是"未声明的变量 'p'"，期望值对不上。

### 账：一起编 `194 -> 157`（**−37**），逐份 pairs `7355 -> 7533`（**+178**）

- `--group test/ioninja/api`（jancy 真的编法）：诊断 `194 -> 157`、理由 `60 -> 62`。
  `未声明的变量` 那一行 **45 -> 1**。新露出来的只有 3 条：`string 不能当条件用` 1、
  `'…' 的第 1 个实参要 ui.FlagPropertyOption*，这里是 ui.ListItem*` 2。
- 逐份那张榜：lowered `120`（没动）、clean `202 -> 201`（−1）、pairs `7355 -> 7533`。
  `未声明的变量` `296 -> 218`（−78），而 `string 不能当条件用` `10 -> 97`（+87）、
  `'…' 的第 1 个实参要 ui.FlagPropertyOption*` `8 -> 88`（+80），另有约 +89 散在长尾里。

两张榜方向相反，而**一起编那张才是尺子**：逐份那张榜上每一行都被"44 份各自 import 同一批头文件"
乘了一遍，所以一行真实的 2 处在那儿是 88 处。这一格正是"逐份那张榜是选题的尺子、不是验收的尺子"
最干净的一次示范 —— 只看它会把一刀 −37 读成 +178。

两行新露出来的话各自指着什么，一并记下（都是**先前就在**的账，这一刀只是让它们够得着）：

- `string 不能当条件用`：`if (!key)`，`key` 是 `string_t`（ui_Dictionary.jnc:32）。jancy 那边
  字符串转 bool 是"`m_p` 是不是空"，这一层今天硬拒 —— 那是**一句错话**，下一刀的选题；
- `'ui.FlagProperty.setOptions' 的第 1 个实参要 ui.FlagPropertyOption*，这里是 ui.ListItem*`：
  调用点是 `EnumProperty* prop; prop.setOptions(optionArray, count)`
  （ui_PropertyGrid.jnc:469），实参声明的是 `EnumPropertyOption const*`。**话里的名字就露了馅**
  —— 报的是 `FlagProperty` 那一个方法。`EnumProperty.setOptions` 只有原型（实现在宿主那边），
  于是按名字往别的类上找去了：这是第一百四十四刀记下的那条"只有原型的重载不进候选"再往前一步
  ——**连"是谁的方法"都接错了**。

## 第一百四十六刀：字符串当条件用 —— 问的是**长度**，不是"指针空不空"

`if (!key)`（ui_Dictionary.jnc:32，`key` 是 `string_t`）先前一律硬拒（`string 不能当条件用`）。
那是**一句错话**：jancy 收这一句。规矩从源码上抄的 ——
`Cast_BoolFromString::llvmCast`（jnc_ct_OperatorMgr/jnc_ct_CastOp_Bool.cpp:96-111）取的是
字符串那格结构体的 `getFieldArray()[2]` 再转 bool，而那张表是
`m_p` / `!m_ptr_sz` / `m_length`（jnc_ct_TypeMgr/jnc_ct_TypeMgr.cpp:2031-2039），
第 3 个是**长度**。

所以 `if (s)` 是"长度不为零"，落成 `(bin "!=" (slen …) (int 0))`（方言的 `slen` 也按字节）。

这一条差别**是可观察的**：空串 `""` 指针非空、长度为零 —— 按 C 的直觉说真，按 jancy 说**假**。
写这一格时我先按"m_p 是不是空"想了一遍，回去看源码才改对 —— 又一次是那条口径：
**话说得越像结论，越要回去看第一个字从哪儿来**。这一次的代价只是多读了三十行 C++。

### 账：整行没了（97 处），逐份 pairs `7533 -> 7439`（**−94**）

- 逐份那张榜：lowered `120`（没动）、clean `201`（没动）、pairs `7533 -> 7439`。
  `string 不能当条件用` 那一行 **97 处整行没了**；`没有这个函数` `306 -> 307`、
  `未声明的变量` `218 -> 219`（各 +1 —— 那两处是这一句收了之后才够得着的下一句）。
- `--group test/ioninja/api`：`157 -> 156`、理由 `62 -> 61`。

lowered 一份没多，因为这 97 份文件里每一份还压着别的行 —— 这一刀收的是"一句错话"，
不是"一整份文件"。

尺子 `/tmp/c142.c`：C 里 `if (s)` 对 `char const*` 问的是指针非空，与 jancy 那条**不是同一件
事**，所以这一份不能照 C 的直觉写 —— 先照 jancy 那条规矩把真假定成"长度不为零"，再在 C 里手写
成 `s.len != 0`。同一串数（yes hi / no / 1 1 / both）。

## 第一百四十七刀：类体里只有原型的方法 —— "没有这个函数"是认错人

`class BoxLayout: Layout { void addWidget(Widget* w); }` 之后 `addWidget(new Label(label))`
（ui_Layout.jnc:44 与 :51）先前报"没有这个函数：'addWidget'"。**那个名字明明声明过** ——
说没有它是认错人。真拦路的是"没有带体的定义"：实现在别处（宿主的 C/C++，或者 import 不着的那个
模块）。说法照抄第九十二刀给**顶层**原型定的那一句，两处本来就是同一件事的两半。

改法：类 / 结构体体里那条"只有原型"的支线上多记一格 `protoMethods`（裸名 -> 那几个主人），
调用点在"按名字查不着"的最后一步问它。三处口径写明白：

- **与 `opaque class` 那一支（第六十六刀）分得开**：那个词是用户明写的"实现在宿主那边"，
  于是调用点发 `(ccall Owner_method self …)`。这里的类**没写那个词**，所以这一层不替它认下那件事
  —— 只把话说对，不凭空发一格 `(ccall …)`；
- **主人不止一个就都列出来**（`A.m / B.m`）：这一步还不知道左边那个值是哪个类（问它要先求值，
  而求值会发诊断）。第一百四十五刀刚量到"指着别的类"那种错话长什么样，所以这儿宁可全列；
- 裸写的那一种（`attach(1)`，也就是 `this.attach(1)`）只在**类体里**才问这张表 ——
  否则一个顶层函数的笔误撞上某个类的原型名，就会被说成"实现在宿主那边"。

### 账：一起编那张榜上 31 条从 E 变 N，clean **−9**（这是这一刀的目的，不是代价）

- `--group test/ioninja/api`：总数 `156`（**没动**）、理由 `61`（没动），可
  `没有这个函数` `43 -> 12`（**−31**）、`原型 '…' 没有带体的定义` `9 -> 40`（**+31**）。
  一条不多一条不少 —— 这一刀不收也不拒任何一句，只是把 31 条**说错的话**改对。
- 逐份那张榜：lowered `120`（没动）、pairs `7439 -> 7455`（+16）、
  `没有这个函数` `307 -> 222`、`原型 …` `102 -> 203`。
- **clean `201 -> 192`（−9）**：那 9 份文件先前身上只有"错"（E），现在有了一格"还不收"（N），
  于是从"没有还不收的文件"那一栏里出去了。**同样的 9 份文件，一处也没多拦** ——
  变的只是那一句话算哪一类。这一栏本来就是"我们还没接的东西有多少"，把一句错话改成一条老实的
  界，它就该往上走。记在这儿是免得下一趟看见 −9 去找"哪儿退了"。

`bad/protoonly-call.jnc` 钉这条界（`Panel.attach` 只有原型）。

## 第一百四十八刀：`construct` 只有原型 —— 顺手翻出第六十六刀漏的那一半

第一百四十七刀那笔账的另一半。`class GroupProperty: Property { construct(string_t name); }`
（ui_PropertyGrid.jnc:37-39）先前报"`ui.GroupProperty` 的 construct 要 0 个实参，这里给了 1 个"
—— 那个 0 是**这一层自己合出来的**那格无参构造。**拿自己合的东西去顶用户声明的那一个**，
于是话就说成了"你多给了实参"。真拦路的仍旧是：construct 在，体不在这儿。

判据要两问（少一问就把 cases/50-construct、62-opaque、63-dualmod 三份拒掉 —— 第一遍就是这么
错的，跑了一趟腿才看见）：那个类的 construct 只写了原型，**而且**体外也没有定义
（`C.construct(…) { … }` 是第五十三刀那条正当的放法）。为此给合出来的那三处构造加了一格
`synth` 记号，另配一个 `realCtor(cls)`：**有没有真的那一个**。

### 顺手翻出的那一半：第六十六刀那条 N 被自己合的构造挡住了

写完 `realCtor` 才看出来，`opaque class` 那一支（第六十六刀）问的是 `!hasCtor` ——
而语料里 `opaque class ComboProperty: Property { construct(string_t name); }` 有基类、也有
`autoget` 属性，这一层于是给它合了一格无参构造，`hasCtor` 成真，那条"实现在宿主那边"的 N
**整条被跳过**，报出来的是"要 0 个实参，这里给了 1 个"。逐份榜上这一族十来行、每行 88 处，
两年多来一直是这句错话。改成 `!this.realCtor(...)` 就对上了。

这与第一百四十二刀是同一个形状：**一格自动合出来的东西冒充了用户写出来的东西**，于是诊断指错了
人。往后添"这一层自己合的"任何东西，都要留一格记号说明它是合的 —— 不然下一处判据又会把它
当成用户的。

### 账：10 行 E 换成 N，pairs `7455 -> 7483`（+28），lowered / clean 都没动

- 逐份那张榜：`ui.ComboProperty` / `EnumProperty` / `FlagProperty` … 那十来行
  `的 construct 要 0 个实参，这里给了 1 个`（各 88 处）**整族换成**
  `new ui.XProperty(…) —— 它的 construct 声明在 opaque class 里…`（各 88 处的 N）。
  剩下的 `construct 要 0 个实参` 只有 1 ~ 3 处的真case（`C1`、`TestClass` …）。
- lowered `120`（没动）、clean `192`（没动）、pairs `7455 -> 7483`（+28 —— 一句话拆成两句、
  以及收了之后够得着的下一句）。
- `--group test/ioninja/api`：`156 -> 157`（+1，同上）。

`bad/protoonly-ctor.jnc` 钉这条界，注里写明白那两问。

## 第一百四十九刀：`errorcode` 写在**函数原型**上 —— 顺带记一条"榜的量法"

`size_t errorcode transmit(void const* p, size_t size);`（ias.jnc:30）先前报
"'errorcode' 只能写在函数上"。**它正写在函数上** —— 只是写在一条原型上。先前顶层那一遍一律按
"不是函数位置"调 `specs`，那个词在那儿就被拦住了。

改法是把这一问**从 specs 挪到声明符那一层**：顶层收下那几个只对函数有意思的词往上传，再按
"这条声明符到底有没有形参表"分开说 —— 有形参表的是函数（那几个词写得对），没有的才落到原来
那句话上（`bad/errcode-onvar.jnc` 钉这条界）。`virtual` / `override` / `abstract` 那三个词
同一条支线。

收了之后 ias.jnc 那一句露出下一层：`原型 'transmit' 与它那个定义的签名对不上` —— 又是一句
错话。`transmit` 有两条（`(void const*, size_t)` 的原型 + `(string_t)` 的定义），拿其中一条去
对本来就不该。所以这一处也改对：名字是一族重载时说的是"只有原型的重载这一层还没有收进候选"
（第一百四十四刀那条账），不再谎称签名对不上。

### 账：一起编 `157`（没动）、5 条 E 变 N；逐份 pairs `7483 -> 6189`，**其中 −1294 全是量法**

- `--group test/ioninja/api`：诊断 `157`（**没动**）、理由 `61`（没动）；
  `'…' 只能写在函数上` 那一行 **5 处整行没了**，`原型 '…' 没有带体的定义` `40 -> 44`。
  又是"一条不多一条不少，只把说错的话改对"。
- 逐份那张榜：lowered `120`（没动）、clean `192 -> 191`（−1，与上一刀同一个道理：一份文件的
  E 换成了 N）、pairs `7483 -> 6189`。

**那 −1294 里一处拦路都没少，全是"一行的名字归一"造成的**，得写清楚：榜上归一那一步只把
**引号里**的名字换成 `'…'`。上一刀新写的那句 `原型 'X.construct' … 造一格 X 就得调它` 把类名
写了两遍，第二遍不在引号里 —— 于是十来个类各自成了一行（每行 88 处）。这一刀把第二遍改成"它"，
那十来行并成一行（98 处），pairs 掉了 811；顺手把第六十六刀那句 `new X(…) —— 它的 construct
声明在 opaque class 里…` 也归了一（改成 `造一格 'X' —— …`），又掉 483。

于是记一条**量法**的口径，与"逐份那张榜是选题的尺子"并列：
**诊断句子里的名字要放进引号，不然一行会按名字裂成几十行** —— 裂开的行在 pairs 上被数了几十遍，
并回去时那一大块掉数看着像战果，其实一处也没收。这一刀之前与之后的 pairs **不可直接比**；
往后新写诊断，名字一律进引号。

## 第一百五十刀："实参个数不对"是拿**不全的那张表**数出来的

第一百四十四刀记下的那条账（只有原型的重载不进候选）在调用点会说出三种错话：
`'ui.FormLayout.addRow' 有 2 条重载，收的实参个数是 2 / 2，这里给了 1 个`、
`… 的 2 条重载没有一条收得下这几个实参`、`'…' 要 1 个实参，这里给了 2 个`。
三句都听着像"你写错了实参"，其实是**这一层自己少了几条**：`addRow` 六条里四条只有原型
（ui_Layout.jnc:86-114），`doc.Plugin.createAction` 七条里五条。

于是那三处出错口各加一问 `protoSibling(base)`——"同一个主人身上还有只有原型的同名那几条吗"，
有就换成一句老实话（`'X.m' 同名的那几条里有只有原型的 …… 所以这儿对不上的那几个个数本来就
不全`）。判据只查表：方言名末段是方法名、前缀是主人（重载改名过的先摘掉 `$oN`）。

**这一刀仍旧只改话，不改判断** —— 真要收得先给"只有原型的重载"一格能进候选的表示，而那要连
宿主面一起（ADR-0022 的 J4b）。

### 账：一起编 `157`（没动）、理由 `61 -> 40`；逐份 pairs `6189 -> 5699`

- `--group test/ioninja/api`：诊断 `157`（**没动**），**13 条**换成那句老实话；
  理由 `61 -> 40`（−21，其中一部分是上一刀那两句归一之后并回去的行）。
- 逐份那张榜：lowered `120`（没动）、clean `191`（没动）、pairs `6189 -> 5699`（−490）——
  `'…' 要 2 个实参，这里给了 1 个`（91）、`2 条重载没有一条收得下…`（77 + 77）那几行并成了
  新那一行（107 处）。**又是一次并行**，照上一刀记下的量法看，这 −490 里没有一处是"收了"。

三刀连着（147 / 148 / 150）同一个形状：一个**声明得出来、体不在这儿**的东西，被三处不同的判据
各自当成了别的毛病（"没有这个函数"、"construct 要 0 个实参"、"实参个数不对"）。共同的教训是
第一百四十五刀那条口径的反面写法：**一句诊断要先问"我这张表全吗"，再问"用户写错了吗"**。

## 第一百五十一刀：顶层只有原型的函数 —— 调用点那句话也一并改对

第一百四十七刀把"类里只有原型的方法"那句话改对了，顶层那一半还留着：
`size_t errorcode receive(void* p, size_t size, uint_t timeout = -1);`（ias.jnc:43，体在宿主
那边）在 `receive(p, size)`（同上:87）那儿报的仍旧是"没有这个函数：'receive'"。同一句认错人。

改法一样小：globalDecl 那条"原型没有带体的定义"的支线上多记一格 `protoFns`（那一遍排在函数体
那一遍之前，所以调用点问得着），调用点在"按名字查不着"的最后一步按命名空间从里往外解一次。

`bad/proto-nobody.jnc`（第九十二刀那一份）本来就调了那个原型，所以这条界现成 —— 只把它的注
补上一句：这一刀之后**两处**都说这一句（声明那儿一条、调用点一条）。这也是"收了的要划掉"的
反面：**一条界已经有人钉着时，别再添一份**。

### 账：一起编 `157`（没动）、3 条 E 变 N；逐份 pairs `5699 -> 5695`

- `--group test/ioninja/api`：诊断 `157`（没动）、理由 `40`（没动），
  `原型 '…' 没有带体的定义` `44 -> 47`、`没有这个函数` `12 -> 9`。
- 逐份那张榜：lowered `120`、clean `191`、pairs `5699 -> 5695`（−4）—— 都基本没动。

一起编那张榜上现在 **157 条里 111 条是"还不收"**（宿主面那一族 47 + 13 + 10 + 10 + 8 + …），
也就是说 ioninja 那 44 份剩下的路基本就是**一件事**：宿主面（ADR-0022 的 J4b）。剩下的 E 里
`没有这个类型：'std.Error'`（11）与 `没有这个函数：'std.setError' / 'sys.sleep'`（9）又都是
**量法**：`std` / `sys` 那两个扩展库的 `.jnc` 不在 `-I` 给的那一个目录里。下一趟要么把那个目录
也给上（那会换基线，得单独记一笔），要么就认下这两行不是这一层的账。

## 第一百五十二刀：复合赋值算符 `operator +=` 那一族

`std.String` 写着三条 `operator += `（std_String.jnc:60-70），先前一律报"算符重载
'operator +='"——那个名字根本不在 OP_NAME 那张表里。这一刀把这一族接上。

要紧的一条是**语义上与 `operator +` 分得开**：jancy 那边复合赋值是**各自独立**的算符，不是
"先 `+` 再赋一次" —— `std.String.operator += (string_t)` 干的是 `append(string)`，而那个类连
`operator +` 都没有。所以它与 `operator :=`（第一百三十刀）才是同一个形状：一个自由函数、
`this` 当第一个形参、名字拼成 `Owner$op$addAssign`；判据也照抄那三条（只能是类或结构体的成员、
只收一个形参、一格主人身上一个算符只收一条）。

十个算符（`+= -= *= /= %= &= |= ^= <<= >>=`）一并列上：判据完全一样，少列一个那一格就会报
"算符重载 '…'"这句笼统的话。

调用点那一处的**位置**也照 `operator :=`：要排在"类的变量赋不了值"与整数那条老路**之前** ——
第一遍放在了后面，`b -= 7`（`b` 是类的变量）于是撞上那句"赋不了值"，跑了一趟腿才看见。
这与第一百三十四 / 一百三十八 / 一百四十二刀是同一类账：**位置错了，判断没错**。

### 账：std 那张榜 `136`（没动）—— 3 条里 1 条落地、2 条换成那条老实的界

- `--group src/jnc_ext/jnc_std/jnc`：诊断 `136`（没动）、理由 `17`（没动）。
  `算符重载 'operator +='` 那 3 处**整行没了**；换成 `std.String 的第二个 'operator +='`
  （+2，那是第二、三条 —— `bad/opcompound-second.jnc` 钉这条界）与 `不写 try 调 errorcode 的 …`
  （5 -> 6：第一条落地之后，它体里那句 `append(string)` 才够得着）。
- 逐份那张榜：lowered `120`、clean `191`、pairs `5695 -> 5692`。

尺子 `/tmp/c143.c`：C 里没有算符重载（`a += 4` 对结构体根本编不过），所以这一份把那层糖**手写
开**成三个函数再按顺序调 —— 两边没有共用的一步。最后那一格 `i += 4` 是 C 自己的复合赋值，
它同时证明这一刀没把整数那条老路抢走。同一串数（20 2 / 23 / 7）。

## 第一百五十三刀：那句"第 N 个实参要什么类型"也是**另一条**的形参说的

第一百五十刀在三处出错口加了"同名的还有原型吗"这一问，漏了第四处：**实参类型**对不上那一句。
语料里 `copy(string)`（std_String.jnc:49）报的是"'copy' 的第 1 个实参要 char*"，可
`std.String` 写着四条 `copy`（string_t / char const* / utf16_t const* / utf32_t）——
`copy(string_t)` 那一条明明在，只是没进候选。听着像"你传错了类型"，其实是这一层少了一条。

改法一行：那一处也先问 `protoSibling(nm)`。同时把那句话改得能同时管两种出错口 ——
"合得上的那一条**可能就不在这张表里**：这儿说'对不上'的那个个数与类型都是拿剩下那几条数出来的"。

### 账：std 那张榜 `136`（没动）、理由 `17 -> 13`

- `--group src/jnc_ext/jnc_std/jnc`：诊断 `136`（没动），四行 `'…' 的第 N 个实参要 char*`
  （各 1 处）并进那条老实话（`9 -> 13`），理由 `17 -> 13`。
- `--group test/ioninja/api`：`157`、理由 `40`（都没动 —— 那一批的这一格早在第一百五十刀就换过了）。
- 逐份那张榜：lowered `120`、clean `191`、pairs `5692 -> 5686`。

`bad/protoonly-argtype.jnc` 钉这条界。**这一族到这儿四处出错口齐了**：个数筛不剩、按类型排不出、
单条个数不对、单条类型不对 —— 四句先前都在替一张不全的表说话。

## 第一百五十四刀：类的 `static` 局部量 —— 三句落进同一道闸门

第五十三刀那时明说不收的那一格（`static Counter c;`）。jancy 那边 static 局部量的初值包在
`once` 里、**就地**包在声明这一处（`Parser::declare` 的 onceStmt_Create / PreBody /
initializeVariable / PostBody，jnc_ct_Parser.cpp:2452），不是挪到 module.construct。

类的那一格要做三件事：造一次对象、写一次 `$tag`（第五十七刀的动态类型）、构造一次。这一刀把三句
都放进**同一道** once 闸门 —— 与那四句 jancy 源码一句对一句。槽本身是模块级的
（`(global 名字$sN C)`，出来是空引用），所以出了函数它还活着：第二次调进来拿到的是同一个对象。
写了初值的照旧拒（类的变量赋不了值，第五十二刀），那与 `static` 无关。

### 账：pairs `5686 -> 5680`（−6），lowered / clean 都没动

- 逐份那张榜：`'…' 的 static 局部量（要一道 once 闸门…）` 那一行 6 处（`B` / `C` / `C1` /
  `C2` / `MyScheduler` / `BoxListEntry`）**整行没了**；lowered `120`、clean `191` 都没动 ——
  那 6 份文件身上还各压着别的行（那一行的 `sole` 本来就是 0，挑它的时候就知道不会多降一份）。

尺子 `/tmp/c144.c`：C 的 `static struct Counter c;` 是**静态存储期**的对象 —— 出来就零初始化、
没有"构造"这件事，与 jancy 那一格的意思（第一次走到这儿才造）**不是同一件事**。所以这一份把那道
闸门手写出来（一格 static bool + 一次 malloc + 一次构造），记的是"该跑几次、什么时候跑"这个判断。
同一串数（ctor / 101 / 102 / 103）—— `ctor` 只有一行，那正是这一刀要钉的。

## 第一百五十五刀：构造的**重载** —— lowered 这一栏这一轮第一次动

第五十三刀那时明说不收的那一格。jancy 收形参不同的好几个 `construct`（type_class.rst:63 那句
"Constructors can be overloaded, the rest of construction methods must have no arguments"）。

改法是**不新造机器**，走方法那条现成的路：第二条起交给第七十九刀的 `overloadName` 改名成
`C$construct$o1`（那儿顺手管着"定义了两次"与"虚方法上的重载"两条界），调用点 `ctorArgs` 交给
第八十刀的 `pickOverload` 按实参挑（先按个数筛、再按类型排）。三处调用点（`C a;` / `C a(5)` /
`new C(7, 8)`）共用那一份挑选，因为它们本来就都过 `ctorArgs`。

两处小口径写明白：

- `ctors` 里记的一直是**这一族的基名**（`C$construct`），第二条起不改那一格 —— 调用点先问
  `overloads` 有没有这个基名，有就挑，挑中之后 params / defs 换成挑中那一条的；
- `static construct` **不进**这一族（它不带形参，一个类上只有一格 —— 同一句 jancy 文档的后半句）。

`bad/ctor-overload`（第五十三刀那条界）**收了，所以划掉**。剩下的界另起
`bad/ctor-overload-tie.jnc`：`construct(int)` 与 `construct(long)` 喂一格字面量 —— 两条同分，
jancy 那边这也是 ambiguous。**第一遍我拿 `construct(int)` / `construct(double)` 当界写那一份，
跑出来一条诊断都没有** —— int -> real 是 ImplicitCrossFamily、严格差于 Implicit，所以那一对本来
就分得开。那一遍白写，可它正说明一件事：**写"界"的那一份也得先跑一遍**，不然钉住的可能是一件
根本不存在的事。

### 账：lowered `120 -> 121`（**+1**）、clean `191 -> 192`、pairs `5680 -> 5579`（−101）

- 逐份那张榜：`'…' 的第二个 'construct'（构造的重载要重载决议）` 那一族**整行没了**
  （`C1` / `TestClass` / `TestStruct` / `BoxListEntry.int` / `std.Guid` / `ui.Action` …）。
  **lowered 加了一份** —— 这一轮（第一百四十三刀起）lowered 第一次动。
- `--group test/ioninja/api`：`157 -> 156`、理由 `40 -> 39`（`ui.Action 的第二个 construct` 那两条
  收了）。`--group src/jnc_ext/jnc_std/jnc`：`136`（没动）、理由 `13 -> 12`（`std.Guid` 那一条收了，
  可那一份文件里还压着别的行）。

尺子 `/tmp/c145.c`：C 里没有构造也没有重载（`Point b(5)` 根本不是 C），所以这一份是"照 jancy 的
挑法自己算一遍、再手写出挑中的那一个" —— 三条按个数就分得开，于是三句各落在哪一条一眼算得出。
同一串数（ctor0 / ctor1 / ctor2 / 0 0 / 5 0 / 7 8）。

## 第一百五十六刀：**撤回** —— `opaque class` 上的属性那一刀是错的（翻自己的案）

这一刀落过一次，又整条撤了（`git revert`）。落的是什么、错在哪儿、怎么发现的，全记在这儿 ——
这是这一份 ADR 里第一条**自己撤自己**的账。

**当时以为**：`opaque class Action { bool autoget property m_isCheckable; }`（ui_Action.jnc:27）
被这一层合成了一格 `…$m_value` 字段、取值器去读它，于是"读出来的是我们自己那一格、不是宿主的
状态"，是个**静默错答案**。于是撤掉那格存储，读写两侧都报"主人是 opaque class"。逐份榜上因此
多出两行（写 103 / 读 58），我还把那 58 处写成"这一刀的全部意义"。

**错在哪儿**：jancy 的 `opaque` 那一位**不换布局的主人**。`jnc_ct_StructType.cpp:194-225` 那一段
做的只有一件事 —— 去扩展库里找宿主登记的那格 `OpaqueClassTypeInfo`，然后
**`m_size = typeInfo->m_size;`**（把整格类撑到宿主那么大）。jnc 那一侧声明的字段照旧是 jnc 自己
的字段、照旧在它们自己的偏移上。而且那一整段有开关：
`ModuleCompileFlag_IgnoreOpaqueClassTypeInfo`（同处:196 那个 `!(...)`，命令行是
`--ignore-opaque`，CmdLine.cpp:215-216）—— **打开它就整段跳过**，opaque 类与普通类一模一样。
我们没有宿主面，所以**永远**在那个模式里。

也就是说：合成那格 autoget 存储、读它，**正是 jancy 在这个模式下做的事**，不是错答案。真缺的只有
存值器 —— 而那一句（`写属性 … 存值器没有定义`）这一层本来就在报。

**怎么发现的**：撤了属性那一格之后，顺着同一个念头去撤 `opaque class` 里的字段与事件
（量过：语料里 18 个字段 + 20 个 event + 15 个 bindable，18 份文件），一跑腿，
`cases/62-opaque` 当场红 —— 而那一份的头八行注**早就把这条口径连源码行号一起写好了**：

> jancy 那边这两个词落在同一个 `createClassType` 上，只差一个 `ClassTypeFlag_Opaque`……
> 那一位管的是"宿主登记的体外字节数"与"能不能 new / 能不能被继承"，而**没有宿主登记时那整段是
> 跳过的** —— jancy 自己的 `--ignore-opaque` 走的就是这条路。我们还没有宿主面，所以永远在那个
> 模式里：体照常摆，方法照常降，`new` 照常收。

**教训（记进口径）**：

1. **动一条老账之前，先把钉着它的那份 fixture 的注读完。** 第六十六刀早把答案写在
   `cases/62-opaque.jnc` 的头上，我隔了九十刀在同一处又想了一遍，还给自己那句结论起了个更响的
   名字（"第一个静默错答案"）。这与第一百四十二刀那条口径是同一句话，只是这一回**说得像结论的
   那个人是我自己**；
2. **腿是最后一道闸门，而它挡住了。** 这一刀的代码与 ADR 都写完、还提交了，是那一份旧 fixture
   把它拦下来的 —— "每条期望都有出处"这条纪律在这儿变成了"每条**旧**期望都还在替你守着"；
3. **"发现一个静默错答案"是最值得怀疑的那种战果。** 它天生带着"我比之前的人看得清"的味道，
   所以要求的证据该比别的账更多，不是更少。

撤回之后三张榜回到第一百五十五刀那一趟：逐份 lowered `121` / clean `192` / pairs `5579`；
`--group test/ioninja/api` `156`、理由 `39`；`--group src/jnc_ext/jnc_std/jnc` `136`、理由 `12`；
jnc 腿 269 passed / 0 failed。

`写属性 … 存值器没有定义`（逐份 105 处、ioninja 群榜 10 处）**照旧是那一行**：它要的是宿主面
（ADR-0022 的 J4b 剩下的一格 —— 给属性那两个函数也发 `(ccall Owner_get_p self)` /
`(ccall Owner_set_p self v)`），不是撤掉一格存储。

## 第一百五十七刀：属性体里**直接就是取值器的体**

```jnc
string_t const property m_string {
    return string_t(m_p, m_length);
}
```

（std_String.jnc:26；`bool const property m_isEmpty`（std_HashTable.jnc:86）、
`log.Writer* const property m_logWriter`（doc_Plugin.jnc:33）同一个形状。）jancy 的属性体里可以
直接写语句 —— 那时**整格体就是 get 的体**，`const` 说的是"没有存值器"（prop.rst:17）。

改法走第七十五刀那条现成的路（完整声明式改写成"简单声明式 + 一个体外的 get"）：类型抄属性自己
那一格说明符（`string_t` 既是属性的类型也是 get 的返回类型），`property` / `const` 两个词从 get
那一份说明符里摘掉 —— 留着 `property` 会让下游把这个函数当成又一格属性声明。

**判据上踩了一格坑，记下来**：第一遍写的是"体里一条 `var-decl` 都没有就算纯语句"，结果
`m_desc` 那一格（体里先 `int t = m_twice;` 再 return）当场被判成成员表 —— **取值器体里的局部量
也是 `var-decl`**。按 prop_full.rst:34 那句话认才对：体里的成员声明是**带 `autoget` 的字段**与
**带 `bindable` 的事件**，也就是说明符里必有 `autoget` / `bindable` / `event` / `multicast` /
`alias` 之一。这一格是"语法长得一样、意思由修饰词定"的典型，与第一百三十八刀那条裸写的
`get` / `set` 是同一类判据。

### 账：clean `192 -> 194`（+2）、pairs `5692 -> 5566`（−126）

- 逐份那张榜：lowered `121`（没动）、clean `192 -> 194`、pairs `5692 -> 5566`；
  `完整声明式的属性 '…' 体里的这一条 —— 只收带体的 get / set 与 …`（81 处）与
  `… 里既没有 get 也没有 autoget 的字段`那两行整片让开。
- `--group src/jnc_ext/jnc_std/jnc`：`136 -> 134`（`std.String.m_string` / `m_sz`、
  `std.HashTable.m_isEmpty`、`std.RbTree.m_isEmpty` 那几格收了）。
- `--group test/ioninja/api`：`156`（没动）、理由 `40 -> 39`。

尺子 `/tmp/c146.c`：C 里没有属性，所以这一份把那层糖手写开成函数、读的地方写成一次调用。
`m_desc` 那一格有意让体里先有一格局部量、中间再调一次会改状态的 `bump()` —— 42 / 64 / 22 三个数
把"读了几次、什么时候改的"钉住。同一串数（42 / 64 / 22 / 4）。

**剩下的那一半没收**：`bindable alias m_onPropChanged = m_onChanged;`（ui_PropertyGrid.jnc:81，
逐份榜上 91 处那一行 `体里这一条的名字`）。试过一遍：按第八十七刀的口径它是"另一个名字指同一格
事件"，落法该是把它记进第一百〇四刀那张字段路径别名表（指向 `<属性全名>$m_onChanged`）。可那一遍
改完，`autoget` 那格字段与存值器一起从属性体里掉了出去（报的是"`autoget` 只能写在属性上"与
"没有这个属性"）—— 说明 `fullPropMember` 回的那格 `evt` 与后面 `propDeclOf` / `bindStore` 那条链
还有一处对不上。当场撤回，没留半落地的状态；下一刀先把那条链跑通再动。

## 第一百五十八刀：**类体里**的完整声明式属性 —— 改写要换两处

第七十五刀把 `property p { … }` 改写成"简单声明式 + 两个体外的函数"，可那一遍只换了 aggHoist
**提上来那一批**；类自己那格体一个字没动。而字段表、属性表与 `propPend` 都是 typeDecl 顺着体走出来的
—— 于是类体里剩下的还是原来那格带体的属性，体里那格 `autoget` 字段被当成类的一格普通字段（报
"`autoget` 只能写在属性上"），存值器又找不着属性（报"没有这个属性"）。语料里主流写法正是写在类里的
（`opaque class EnumProperty { property m_value { … } }`，ui_PropertyGrid.jnc:77-88），所以这一格
一直是**顶层能编、成员编不了**。

改法：`expandFullProps` 分三步 —— 先把每一条改写好记成一张 `原来那格 -> 改写出来的那几条`表；再顺着
`type-decl` 把类体里那一格换成**那条简单声明式**（`aggPropRw`，倒着走名单，于是嵌套的类型拿得到已经
换好的那一份）；最后出新名单时，类里那一格只留**取/存两个函数** —— 那条声明已经在体里了，两处都留会
报"属性声明了两次"。

**顺手补上第七十五刀留下的一格坑**：`property` 这个词要**摊平了再拼**进说明符。说明符里那串词在语法里
是左递归的一串（`(mods-add (mods) autoget)`，见 `flat`），照原样往 items 后面接的话 `flat` 只认得出
头两条 —— 接上去的 `property` 就这么没了。写 `autoget int m_x;`（词在类型前面）时那一格是空的
`(mods)`，所以这条路从第七十五刀起一直是对的；`int autoget m_value;`（ui_PropertyGrid.jnc:79 那种写法，
词在类型后面）才踩得着。这一格是"同一件事两种写法，只有一种走过"的典型 —— 榜上量不出来，因为它把
类成员那一整格挡在更早的一句诊断后面。

尺子 `/tmp/c147.c`：C 里没有属性，所以这一份把两格属性手写成两对 get/set 函数，`m_twice` 那一格特意
调另一格属性（读一次、写一次），`sets` 那个数把"存值器进了几次"钉住。同一串数（`v=5 twice=10 sets=1`
/ `v=7 twice=14 sets=2`）。

## 第一百五十九刀：属性体里那条 `alias` —— 等号右边那格才是真东西

第一百五十七刀末尾记的那笔账（`bindable alias m_onPropChanged = m_onChanged;` 试过一遍、撤回）是**猜
反了方向**。这一趟直接读源码：

```cpp
// jnc_ct_Parser.cpp:1346-1365
Alias* alias = m_module->m_namespaceMgr.createAlias(name, &declarator->m_initializer);
if (nspace->getNamespaceKind() == NamespaceKind_Property) {
    if (ptrTypeFlags & PtrTypeFlag_Bindable) result = prop->setOnChanged(alias);
    else if (ptrTypeFlags & PtrTypeFlag_AutoGet) result = prop->setAutoGetValue(alias);
}
```

也就是说：等号**右边**那格才是真东西（外层命名空间里已经有的那格成员），左边只是属性这一层里给它起的
**另一个名字**。`bindable` / `autoget` 在这儿的意思于是不是"生成一格"，而是"这格属性的事件 / 存储
**不生成**，就用它"—— 目标要等 `Property::finalize` 里 `alias->getTargetItem()` 才解
（jnc_ct_Property.cpp:484-500），而 `alias doesn't need a type`（jnc_ct_Parser.cpp:1341），所以类型是
从目标那格抄的（同文件族:170 那句 `item->getItemType()`）。头一遍那个"落成第一百〇四刀的字段路径别名、
指向生成的 `<属性全名>$m_onChanged`"正好把方向弄反了 —— 它多生成了一格，而 jancy 是少生成一格。

落法：一张 `属性全名 -> {store, onch}` 的表（`propAlias`），`autoStore` / `bindStore` 头一句先问它 ——
有就把外层那格成员的名字回上去，字段表与 `bindProps` 都不动（那格事件自己那份建单子的活儿早由类体
那一遍发过了）；`autoget` 那一种照旧要合成取值器（jancy 那边也是 `createFunction<AutoGetter>`），所以
仍进 `autoProps`，只多带一个 `alias: true` 说"存储已经有人声明了、别再发一遍"。类型这一遍排在类型解出来
之前，所以抄的是目标那格**声明的说明符**（`sibDecl`）——同一层里，抄写法与抄类型是一回事。

两种写法都收了：`bindable alias`（ui_PropertyGrid.jnc:81/87/92 —— 三格属性共用类里那一格
`event m_onChanged();`）与 `autoget alias`（test/jnc/test89.jnc:14-15）。**共用**这件事在尺子里看得见：
往一格属性的 `bindingof` 上订阅，另一格属性变的时候也叫得到。

**还有一遍要跑**：泛型摊出来的实例与 `extension T: Base { … }` 摊出来的成员里也有属性，而它们是
`expandFullProps` 那一遍之后才出现的（`string_t const property m_enumString { return …; }`，
io_HidDb.jnc:35）—— 所以 `expandExtensions` 之后再跑一遍同一个改写。改写过的落不到第二遍上：取/存
两个函数的名字是 `qualified-special`，`fullProp` 头一句 `qname(core)` 就回 null。

### 账：pairs `5566 -> 5564`（−2）、leg `270 -> 273`

- 逐份那张榜：lowered `121`（没动）、clean `194`（没动）、pairs `5566 -> 5564`；
  `完整声明式的属性 '…' 体里这一条的名字` `91 -> 89`、
  `完整声明式的属性（… 那对花括号开的是一层命名空间）` `72 -> 70`。
- 两张 group 榜都没动（`test/ioninja/api` 156 / 理由 39；`src/jnc_ext/jnc_std/jnc` 134 / 理由 12）。
- **这两刀在榜上几乎不动数，账要照实记**：ui_PropertyGrid 那三格属性的**存值器只有原型**
  （`void set(variant_t value);`，:80/86/91）—— 那是宿主面那条链（ADR-0022 的 J4b），属性这一族
  剩下的 89 处全压在它上面。类体里那一格与那条 alias 是它的**前置**：两条都通了，那 89 处才只剩
  "体在宿主那边"这一件事。

尺子 `/tmp/c148.c`：C 里没有多播，所以这一份把它手写成一格函数指针数组 —— `bindable alias` 落到这一份
里就是**两格属性共用同一个数组**，`autoget alias` 是两格各自共用外层那格 int。同一串数（log 2 / 4 / 6）。

## 第一百六十刀：属性体里那格取/存**只有原型** —— 体在宿主那边

```jnc
opaque class EnumProperty: Property {
    property m_value {
        variant_t autoget m_value;
        void set(variant_t value);          // ← 只有原型
        bindable alias m_onPropChanged = m_onChanged;
    }
}
```

（ui_PropertyGrid.jnc:78-88；逐份榜上 `完整声明式的属性 '…' 体里这一条的名字` 那 89 处全压在这
一格上。）语法上 `void set(variant_t value);` 是一格 `var-decl`，声明符的芯是**裸写的** `get` /
`set` —— 在类体里那是**下标算符**（第一百三十八刀），可在属性体里它就是这格属性的取/存
（prop_full.rst:15 那对花括号开的是一层命名空间）。没有体的意思是"实现在别处"，而
`opaque class` 里就是宿主的 C/C++（opaque.rst:15-29）。

落法与方法那一格（ADR-0022 的 J4b）**同一条**：读写发 `(ccall Owner_get_prop self)` /
`(ccall Owner_set_prop self v)`，符号名是"类名（`$` 换成 `_`）+ `_get_` / `_set_` + 属性名"。
取/存那两格一个函数都不发（没有体）；类型从原型的说明符抄（`string_t get();` 那一种）或者从体里
那格 autoget 字段抄，与第七十六刀那条一模一样。

**判据上又踩了同一格坑**：先得把这两条算进"成员声明"（`isPropMember`）—— 漏了那一句，
第一百五十七刀的 `whole` 会判成真，于是这两条被当成取值器体里的两格局部量（报的是"局部量上的
形参表"）。同一个判据这一轮改了三次（第一百五十七、一百五十九、这一刀），三次都是"语法长得一样、
意思由修饰词或者芯的形状定"。

正面判据在 `tests/llvm/run.js` 第 9 节（那儿有宿主的体）：`Counter_get_m_scale` /
`Counter_set_m_scale` 两句 `(cabi …)` 与那一趟 `scale 70`（存的时候乘 10，所以 70 证明**真走了**
宿主那两个函数）。

## 第一百六十一刀：类里那些**类型是类的值**的字段 —— 内嵌的对象

```jnc
class PluginHost {
    ui.Menu m_menu;
    ui.ToolBar m_toolBar;
}
```

榜上最大的一格真特性（526 处 / 19 行）。jancy 那边它是**内嵌**的对象：`ClassType::calcLayout` 把
这样的字段收进 `m_classFieldArray`（jnc_ct_ClassType.cpp:360-371，顺手拦住抽象的与
`OpaqueNonCreatable` 的），再由父对象的构造顺着 `m_fieldInitializeArray` 逐格造出来
（`MemberBlock::initializeFields`，jnc_ct_MemberBlock.cpp:141-179）；顺序是"基类构造 → 静态构造
→ 字段 → 用户写的体"（jnc_ct_Parser.cpp:3002-3009）。

这一层的类值本来就是"一格地址 + 一次 `pnew`"（局部量从第五十二刀起就这么落），所以内嵌落成
**字段里放地址、父对象构造开头把它造出来**：一格字段三句（`pnew` / 写 `$tag` / 调它的
`construct`），由 `embInitLines` 发在事件那几行（第八十三刀）之后、字段默认值之前 —— 与 jancy 那
四句同一个位置。没写 construct 的类跟着要合成一个（`synthFI` 那条路，第七十八刀）。

结构体那一侧 jancy 直接报错，不是"还不收"：

```cpp
// jnc_ct_StructType.cpp:303-307
if (m_structTypeKind != StructTypeKind_IfaceStruct && field->m_type->getTypeKind() == TypeKind_Class) {
    err::setFormatStringError("class '%s' cannot be a struct member", …);
```

那个 `IfaceStruct` 例外说的正是"类自己那格 iface 结构体"—— 也就是说内嵌是**类的**本事。这一层照它
报（`bad/embed-in-struct.jnc`）。按值套回自己也报：内嵌要在父对象里就地造出来，套回自己没完。

### 账：pairs `5564 -> 5038`（−526）、clean `194 -> 192`（**−2，记下来**）

- 逐份那张榜：lowered `121`（没动）、clean `194 -> 192`、pairs `5564 -> 5038`；
  `类型是类（…）的字段 —— 它在 jancy 那边是内嵌的对象`那 19 行整片让开。
- **clean 掉了 2 份，是这两份**：`samples/jnc_sample_01_export_c/script.jnc` 与
  `samples/jnc_sample_02_export_cpp/script.jnc`。理由是第一百六十刀那格判据把
  `property g_prop { char const* get(); void set(int); void set(double); void set(char const*); }`
  （script.jnc:29-35）认出来了 —— 那是**存值器的重载**（jancy 收：`Property::create` 里
  `setterTypeOverload` 是一串，jnc_ct_Property.cpp:73-82），而这一层一个名字一格函数，所以现在
  明说"里两个 set（要重载决议）"。先前这两份是"clean"是因为那几条压根没被认成取/存 —— 那是把
  形状认错了却没出声，比现在这一句差。数掉了 2、话对了，这一笔照实记（与第一百四十九刀那条
  "掉数不是战果"是同一件事的反面：**涨回来的那种数也不一定是战果**）。
- 两张 group 榜：`test/ioninja/api` 与 `src/jnc_ext/jnc_std/jnc` 这一轮没测（这两刀动的是类的
  字段与属性体，group 那一侧的墙在 import 与宿主面上）—— 没跑就不写数。

尺子 `/tmp/c149.c`：C 里没有类，所以这一份把内嵌写成"父结构体里嵌一格子结构体、父的 init 头一句
调子的 init"。三件可观测的事钉在同一串数里：内嵌那格的 construct 在父类构造的体**之前**跑
（`mid ctor n=41`）、两个父对象各带自己那一格（`p` 与 `q`）、内嵌的对象照旧是真对象（方法调得动、
还能再套一层）。

## 第一百六十二刀：宿主面的 construct 与"一个体都没写"的属性

第一百六十刀收的是属性体里**只有原型**的那两格。这一刀把宿主面剩下的两处补齐 —— 都是同一条
约定（`opaque class` 的成员**全都**在宿主的 C/C++ 里，opaque.rst:15-29；符号名是"类名 + `_` +
成员名"，ADR-0022 的 J4b）：

- **construct**：`new C(…)` 落成"造一格 + 写 `$tag` + `(ccall C_construct self …)`"。形参类型从
  **声明**抄（`hostCtorSigs`，与 `hostSigs` 同一遍记），不从调用点猜。
- **简单声明式、一个体都没写的属性**：`string_t const property m_name;`（ui_PropertyGrid.jnc:22）
  —— 在 `opaque class` 里那就是"取/存都在宿主那边"，与方法那一格一模一样。判据是"这个类是
  opaque + 这个取/存确实没有定义"；体里明写了另一半的那种不算（那是"只有取值器"，另一件事）。

正面判据在 `tests/llvm/run.js` 第 9 节：`new Counter(100)` 之后 `add(20)`、`add(22)` 印出
`count 142` —— 那个 100 是宿主的 `Counter_construct` 记进它自己那张表的，所以 142 证明**构造真跑了**。

### 账：pairs `5038 -> 5136`（**+98，记下来**）

这一刀让数**涨了**。理由不是退步，是墙往里挪了一格：先前那 103 处停在"写属性 '…' 的存值器没有
定义"，现在走到了下一道 —— **C_ABI 那几个词装不下那些类型**：

- `写属性 '…' —— 它的类型 ui.SizePolicy 落不进 C_ABI 的那几个词` 81 处（枚举）；
- `读/写属性 '…' —— 它的类型 variant_t 落不进…` 20 + 10 处；
- 其余是 `ui.FileDlgKind` 这类枚举与 `log.RangeProcessor* function*()` 这类函数值。

一格属性先前**一条**拦路项，现在读一次、写一次各算一条，所以 pairs 涨了 98 而 clean 一份没动
（192）。这与第一百四十九刀那条口径是一件事的两面：**数本身不是战果，说对了才是** —— 掉数可能是
把一行拆成了几十行，涨数也可能是把一道假墙换成了真墙。下一格该做的是那道真墙：宿主面上枚举与
`variant_t` 怎么过（jancy 的 C++ 绑定里枚举按它的底整数过 —— 那一条要先读 `JNC_MAP` 那一族的源码
再动，不能猜，见 `bad/opaque-host-fn.jnc` 与 `bad/opaque-host-ctor.jnc` 钉着的那两条界）。

`bad/opaque-host-ctor.jnc` 这一份跟着换了内容：先前钉的是"还没有宿主面"，那句话现在不成立了 ——
换成钉**边界**（形参是枚举时落不进 C_ABI），与 `bad/opaque-host-fn.jnc` 成一对。

## 第一百六十三刀：**翻案** —— 枚举过 C_ABI 不是"猜"，它本来就是那格底整数

第一百三十九刀（与 ADR-0022 的 J4d）给宿主面定过一条界：**枚举落不进 C_ABI 那几个词**，理由写的是
"它在这一侧是一格有自己规范形的类型，悄悄按底整数传过去是猜"。这一趟直接读源码，这条理由不成立：

```cpp
// jnc_ct_EnumType.h:182-183
prepareLlvmType() {
    m_llvmType = m_baseType->getLlvmType();
}
```

jancy 的枚举在**代码生成这一层根本不存在** —— 它的 LLVM 类型就是底整数的 LLVM 类型。也就是说过去
的从来就是那格整数，按底整数过是**照抄它的调用约定**，不是替它猜一个。这一层其实早就这么算了
（`vals.push(jncIsEnum(v.type) ? { code: v.code, type: v.type.base } : v)` 那一处，第一百三十刀），
只有宿主面这一格拦着 —— 拦的是一件自己别处已经在做的事。

改法一行：`cabiWordOfJnc` 里枚举回它底整数那个词。钉着这条老账的两份 fixture
（`bad/opaque-host-fn.jnc`、`bad/opaque-host-ctor.jnc`）跟着换成**真落不进**的那两种 ——
`variant_t`（带标签的一格值，那两格怎么摆是 ADR-0026 那一族的账）与**按值过去的结构体**
（按大小拆寄存器/进栈，arm64 与 x86-64 还不一样）。

### 账：pairs `5136 -> 5038`（−98）

- 逐份那张榜：lowered `121`、clean `192` 都没动，pairs `5136 -> 5038`；
  `写属性 '…' 的类型 ui.SizePolicy 落不进 C_ABI` 那 81 处与 `ui.FileDlgKind` 那 8 处整片让开。
- 剩下的那 30 处是 `variant_t`（读 20 / 写 10）—— 那是下一格，界照旧钉着。
- **口径记一笔**：一条"不收"的理由要能被源码证伪。这一条当初写的是"这一侧有自己的规范形"，
  可调用约定问的不是"这一侧怎么记"，是"过去的是几个字、什么形状" —— 问错了问题，就把一件照抄的事
  当成了猜。与第一百五十六刀那次撤回是同一类错的两面：那次是**多做**了宿主的活，这次是**少做**了
  一件本来就该照抄的事。

## 第一百六十四刀：宿主面上**同名两条原型** —— 补一个静默的错答案

`opaque class` 里两条同名的原型：

```jnc
opaque class Lock {
    void lock(int n);
    void lock(double d);
}
```

宿主面是按名字约定过去的（`Owner.method` -> C 符号 `Owner_method`，ADR-0022 的 J4b），而 C 那边
**一个符号只有一份签名** —— 没有重载。这一层的 `hostSigs` 也是按 `类$方法` 记的**一格**，于是第二条
原型直接盖掉第一条：调用点拿"最后声明的那一份"去查型。`p.lock(1.5)` 于是按 `void lock(int)` 检查
（或者反过来），过去的字宽与那个符号想要的对不上 —— 而错的调用约定在运行期是**读错地方**，不报错。

改法：记一笔 `hostOverloaded`，调用点明说"挑不出按哪一条过"。界钉在 `bad/opaque-host-overload.jnc`。

### 账：pairs `5038 -> 5058`（**+20**）

涨的这 20 处正是先前那条静默的路 —— 它们本来不出声（或者出的是一句按错签名算出来的类型错）。
**一句真话换二十个数**：这与第一百四十九刀那条口径同向 —— 榜上的数只在"话是对的"这个前提下才有
意义。真要把这 20 处收下来，得先有"宿主面的重载怎么起符号名"那条约定（jancy 那边是扩展库自己
`JNC_MAP_FUNCTION` 一条条登记，名字由写绑定的人定，源码里没有可照抄的**推导规则**）—— 所以这一格
不是"实现一下"，是要先定一条我们自己的约定，单独一笔账。

## 第一百六十五刀：`null` 当一格 `string_t`

榜上 `null 得从左边知道自己是哪种指针（这里问不出来）` 那 104 处（**E**，不是"还不收"—— 也就是说
jancy 编得过、这一层报错）。挑一处看原样：

```jnc
storage.writeString($"%1-key-%2"(name, i), null); // null-terminate
```

（test/ioninja/api/ui_Dictionary.jnc:64 —— 那一格形参声明的就是 `string_t`。）左边说得出它要什么，
所以"问不出来"这句话在这儿是**认错人**：`want` 是 `string_t`，而这一层那一问只放指针过。

jancy 的 `string_t` 是一格带指针的结构（`jnc_String`：`m_p` / `m_length` …），`null` 进去就是"指针
那格空着"。这一层不用另造一格 —— **字符串槽的零值本来就是 `(str "")`**（`jncZeroText`：`string_t s;`
那一格出来的就是它），而可观测的三件事在"空的"与"零长"上一模一样：长度 0、当条件用是假
（第一百四十六刀那条 `slen != 0`）、印出来什么都没有。所以这儿回同一格零值，不是替它猜一个新语义。

### 账：pairs `5058 -> 4958`（−100）

- 逐份那张榜：lowered `121`、clean `192` 没动，pairs `5058 -> 4958`；`null 得从左边…` 那一行
  `104 -> 4`（剩下 4 处的 `want` 是别的东西，界照旧钉着）。
- leg `276 -> 277`。尺子 `/tmp/c150.c`：C 里 `NULL` 与 `""` 印出来不是一回事（`printf("%s", NULL)`
  是未定义行为），所以那一份不照抄，而是按 jancy 的语义手写成零长的那一格，再把三件事逐个印出来。

## 第一百六十六刀：那句话说定 —— "合得上的那一条就是只有原型的那一条"

第一百五十刀给"同名的还有只有原型的"那三处（加第一百五十三刀那一处）定的说法是**可能**式：
"合得上的那一条**可能就不在这张表里**"。可能式是因为那时手里只有"同名的有没有原型"这一问 ——
没有"那几条原型各收几个实参"。

这一刀把个数记下来（`protoArity`：`类$方法` -> 那几条原型的实参个数），四处出错口都带上调用点给的
个数。给的个数正好是其中一条时，话就从"可能不在表里"变成**"收这么多个实参的那一条就是它，而它没有
带体的定义"** —— 那才是真拦路的东西，与顶层那一格（第九十二刀）同一句话。

只记**个数**、不记类型：类型要走 `formalList`，那一遍自己会发诊断，而这一格只想把话说对，不想为了
记账多报一句。

**踩了第一百四十九刀那条口径的坑，当场量出来**：第一版把个数写进了那句话（"收 2 个实参的就是它"），
榜上归一那一步只把**引号里**的名字换成 `'…'`，数字留在原地 —— 于是一行按 2 / 3 / 4 / 6 … 裂成几十行，
pairs 从 4958 涨到 **5281**。把数字从句子里去掉（"收这么多个实参"，要看几个诊断指着的源码上就有）之后
回到 4967。**那条口径本来只写了"名字要进引号"，这一趟才知道它管的是"任何会变的东西都别留在句子里"。**

### 账：pairs `4958 -> 4967`（+9）

- 逐份那张榜：lowered `121`、clean `192` 没动；`'…' 同名的那几条里有只有原型的` 那一行
  `108 -> 少了大半`，换成新那一行；净 +9 是因为有些文件里**两种都出现**（一处调用的个数对得上某条
  原型、另一处对不上），先前它们合在一行里。
- leg `277 passed / 0 failed`（`bad/protoonly-arity`、`bad/protoonly-argtype` 两份的 expected 跟着换）。

## 第一百六十七刀：结构体的**左值**回一格指向它的指针

```jnc
DictionaryEntry* insertDictionaryHead(…) {
    DictionaryEntry entry;
    entry.m_next = dictionary;
    return entry;                // ← 声明回的是 DictionaryEntry*
}
```

（ui_Dictionary.jnc:67-79；逐份榜上 90 处，而且是 **E** —— jancy 编得过、这一层报
"return 的类型是 X，函数声明的是 X*"。那句话认错了人。）

jancy 那边这不是类型不对：一格左值在它那边的类型是 `DataRef`，而

```cpp
// jnc_ct_CastOp_DataPtr.cpp:815-823 / 856-859
case TypeKind_DataRef:
    switch (((DataPtrType*)srcType)->getTargetType()->getTypeKind()) {
    case TypeKind_Array:  return &m_fromArray;
    case TypeKind_String: return &m_fromString;
    }
    break;                       // ← 结构体落到下面
    …
size_t i = ((DataPtrType*)srcType)->getPtrKind() >> PtrTypeFlag__PtrKindBit;
return m_operatorTable[i][j];    // 按指针种类查表：ref -> ptr
```

`DataRef` 在它那边本身就是 `DataPtrType` 的一种，所以**左值直接退化成"指向它自己的指针"**。
（顺带看清了另一条：`default:` 那一支才是"结构体**右值**转指针"，那一支要求目标指针是 `const`
—— 因为拿到的是一份拷贝的地址。我们这一刀只收左值那一种。）

地址逃出这个函数由 GC 兜着；这一层的对应机器是第九刀那一套 —— 被取过地址的量提到自己一段内存里
（`gTaken` / `lifted`）。所以落法就是"照 `&entry` 那条路发"，外加让取地址那一遍也看见
`return entry;`（返回类型是数据指针的函数里才问，宁可多提一格：多提只是多一次 `pnew`，漏提是
错答案 —— 回出去的地址会指着一段马上不属于它的内存）。

### 账：pairs `4967 -> 4877`（−90）

- 逐份那张榜：lowered `121`、clean `192` 没动，pairs `4967 -> 4877`；
  `return 的类型是 ui.DictionaryEntry，函数声明的是 ui.DictionaryEntry*` 那一行整片让开。
- leg `277 -> 278`。尺子 `/tmp/c151.c`：C 里回局部量的地址是未定义行为，所以那一份按语义写成
  堆上的一格（malloc）——"这一格要活过这次调用"这件事三种做法（jancy 的 GC、这一层的提格、C 的
  malloc）在可观测的东西上一样。字段那一格也钉着：`inner(p)` 回的是 `&p.m_b`，写进去在 `p` 上看得见。

## 第一百六十八刀：宿主面的主人按**对象**认 —— 又一个静默的错答案

`setOptions` 在 `ui.FlagProperty` 与 `ui.EnumProperty` 上**各声明一条**（ui_PropertyGrid.jnc:145 与
:334，两个都是 `opaque class`）。而 `hostFns` 是"方法名 -> 一格主人"—— 后声明的盖掉前面的。于是

```jnc
EnumProperty* prop = new EnumProperty(name);
prop.setOptions(optionArray, count);     // optionArray 是 EnumPropertyOption const*
```

按 **FlagProperty** 那一条去查型、发的还是 `FlagProperty_setOptions`：逐份榜上那 88 处
`'…' 的第 1 个实参要 ui.FlagPropertyOption*，这里是 ui.ListItem*` 就是它 —— 报出来的是"你传错了
类型"，真相是**这一层挑错了主人**。运气差一点（两条签名兼容）就不是报错、而是发错符号。

改法：`hostFns` 从"一格主人"改成"一组主人"，调用点先求出 `.` 左边那个对象的类，按**它自己那个类
再往基类走**挑主人（与普通方法查名同一条路）；一个都对不上时说"这个类上没有这个方法（同名那几条
声明在 … 上）"。这与第一百六十四刀是同一族的第三格：**按名字记的表，一个名字只留一格，就是在给
静默的错答案留门**（那一刀是 `hostSigs`，这一刀是 `hostFns`）。

正面判据在 `tests/llvm/run.js` 第 9 节：那儿现在有**两个** opaque class 各声明一条 `add`
（`Counter_add` 加、`Other_add` 乘 2），`o.add(21)` 印出 `other 42` —— 42 证明挑的是对象自己那一条。

### 账：pairs `4877 -> 4823`（−54）

- 逐份那张榜：lowered `121`、clean `192` 没动，pairs `4877 -> 4823`；那 88 处整片让开（剩下的
  −54 是它与别的行的重叠：同一份文件里那一格先前算一条，现在别的理由还在）。
- leg `278 passed / 0 failed`、llvm `38 passed / 0 failed`。

## 第一百六十九刀：宿主面那条路上的**默认值**

```jnc
opaque class Storage {
    string_t readString(string_t name, string_t defaultValue = null);
}
…
string_t key = storage.readString($"%1-key-%2"(name, i));   // 只给一个
```

（doc_Storage.jnc:43-46 与 ui_Dictionary.jnc:31；逐份榜上 91 处报的是 `'…' 要 2 个实参，这里给了
1 个` —— 又是一句认错人的话：形参表上第二格明明有默认值。）

原因：第一百刀把原型上的默认值记进了 `protoDefs`，可宿主面那条路（`hostSigs` / `hostMethodCall`）
是另一条 —— 它只比个数、不补默认值。改法是把默认值也记进 `hostSigs`，调用点走**与普通调用同一份**
`withDefaults`（第一百〇五刀那条口径：默认值在**声明那一头**的作用域里折，宿主面那一头就是那个类）。
个数不对时那句话也跟着补上"（其中 N 个有默认值）"，与普通调用那一处一字不差。

正面判据在 `tests/llvm/run.js` 第 9 节：`Other.add` 的声明改成 `long add(long d = 21)`，调用点写
`o.add()` —— 印出来还是 `other 42`（宿主那边乘 2），也就是说那个 21 是**补出来的**。

### 账：pairs `4823 -> 4714`（−109）

- 逐份那张榜：lowered `121`、clean `192` 没动，pairs `4823 -> 4714`；`'…' 要 2 个实参，这里给了 1 个`
  那 91 处与同族几行一起让开。
- leg `278 / 0`、llvm `38 / 0`。

## 第一百七十刀：方法体里**裸写**的宿主面方法

```jnc
opaque class Representation {
    void addPart(PartKind partKind, uint64_t partCode, void const* p, size_t size);

    void addBreak(bool isHardBreak = false) {
        addPart(PartKind.Break, isHardBreak, null, 0);   // ← 裸写，`this` 就是那个对象
    }
}
```

（log_Representation.jnc:112-137；group 榜上 19 处。）宿主面那一问（`hostFns`）先前只走
`obj.m(…)` 那一种 —— 裸写时调用点手里的"方法名"是 null，于是落到"原型没有带体的定义"那句话上。
可这儿的 `this` 就是那个对象：主人是当前这个类（或它的基类）时，按宿主面那条路发，`self` 就是
`$this`。`hostMethodCall` 因此多收一格现成的 `self`（`obj.m(…)` 那一种照旧自己去求左边那个值）。

### 账：group `124 -> 117`（−7）、逐份 pairs `4714 -> 4786`（**+72**）

数又是一涨一跌，理由与第一百六十二刀那次一样 —— **墙往里挪了一格**：这 19 处（以及别处同形状的）
现在真走到了宿主面，停在两道**已经记过账的**真墙上：

- `'…' 的第 3 个形参的类型 variant_t（落不进 C_ABI 的那几个词）` 88 处、
  `log.RangeProcessor* function*()` 41 处 —— C_ABI 那几个词装不下"带标签的一格值"与函数值
  （第一百六十三刀那一节末尾记的那笔）；
- `'…' 在 opaque class 里声明了同名的两条` 从 20 涨到 69 —— 宿主面的**重载怎么起符号名**那条约定
  还没定（第一百六十四刀那一节记的那笔）。

也就是说这 +72 不是新问题，是**把 19 处假墙换成了两道真墙上的更多格**。group 那张榜（诊断条数）
反而降了 7，那是同一件事在另一个尺子上的样子：一份文件里少了几条认错人的话。

## 第一百七十一刀：宿主面的**重载** —— 定一条自己的符号名约定

第一百六十四刀把"同名两条原型"从静默的错答案改成了明说不收，理由是**宿主那边一个符号只有一份
签名**。这一刀把它接上：那个理由是对的，但结论下早了 —— 一个符号一份签名，那就**给每条重载一个
自己的符号**。

jancy 那边没有可照抄的推导规则：它的重载由宿主一条条 `JNC_MAP_OVERLOAD` 登记，符号名由写绑定的人
定。所以这是**我们自己的约定**（与 `Owner_method` 那条同一性质，ADR-0022 的 J4b）：

> 同名那几条按**声明顺序**排。头一条的符号名仍是 `Owner_method`，之后的是 `Owner_method_o2`、
> `Owner_method_o3`…（`$` 不是可移植的 C 标识符字符，所以用 `_o`）。

代价写在这儿：一个真叫 `method_o2` 的方法会与 `method` 的第二条重载撞在同一个符号上。语料里一个
都没有，而换成更保险的名字（比如把类型编进去）就得先定一套类型编码 —— 那是更大的一笔账。

挑哪一条：先按**个数**筛（默认值算可省的那几格），剩一条就是它；剩几条按**实参类型**排
（`argCost`），规矩与普通重载那一处（`pickOverload`）逐条一样 —— 问不出实参类型的明说不收
（第八十刀那条"绝不猜"），同分的也明说（jancy 那边这也是 ambiguous）。界钉在
`bad/opaque-host-overload.jnc`：`lock(int)` / `lock(long)` 喂一个整数字面量，两条一样合得上。

### 账：clean `192 -> 194`（**+2**）、pairs `4786 -> 4759`（−27）、group `117 -> 102`（−15）

- **clean 这一栏这一轮第一次动**：两份文件从此一条"还不收"都不剩。
- 逐份那张榜：`'…' 在 opaque class 里声明了同名的两条` 那 69 处整片让开；
  `hostOverloaded` 那张表跟着删掉（它存在的理由被这一刀取消了）。
- group（`test/ioninja/api` 当一个模块）：诊断 `117 -> 102`、理由 `30 -> 29`。
- leg `278 / 0`、llvm `38 / 0`。

## 宿主面剩下那一格：`variant_t` 与函数值怎么过 C_ABI（**已经量清、等一个决定**）

逐份榜上这一族现在是最大的一格（`'…' 的第 3 个形参的类型 variant_t` 88 处、
`log.RangeProcessor* function*()` 41 处、读/写属性那两行 30 处）。这一节把**事实**记下来，好让下一趟
不用重新量：

- jancy 的 `variant_t` 在 C 那一侧是 `struct jnc_Variant`（include/jnc_Variant.h:150-189）：
  一格 `union`（`jnc_Variant_DataSize = sizeof(void*) * 6` = **48 字节**）+ 一格 `sizeof(void*)`
  的补白 + 一格 `jnc_Type* m_type` —— 64 位机上**一共 64 字节**。
- 64 字节的聚合在两个主流 C ABI 上都是**按内存过**（SysV x86-64 的 MEMORY 类、AAPCS64 的
  "> 16 字节走栈"）：也就是说被调方拿到的**本来就是一个地址**，调用方负责那份拷贝。

所以"`variant_t` 过去记成一格 `ptr`"与平台 ABI 对一格按值的 64 字节结构做的事是同一件。要定的不是
"怎么过"，是**指向的那块内存按谁的布局**：

- 选项 A：按**这一层自己**那格 variant 的表示（`variantTy()`）—— 与 `Owner_method` 那条约定同一性质
  （宿主本来就是照我们的约定写的），代价是把一格内部布局变成了 ABI 的一部分（要写进 ADR-0026）。
- 选项 B：按 jancy 的 `jnc_Variant` 布局摆一份出去 —— 与它的宿主二进制兼容，代价是每次调用多一次
  搬运，而且要把它那张 `jnc_Type*` 的表也照出来（那是一整套运行期类型系统）。

**再量出来一格（决定之前就该知道的）**：这一层的 variant 是一格**结构体值**
（`(struct $variant ($t int) ($n int) ($r real) ($s string))`，见 `variantTy`），而 `varBox` 把它
**当函数的返回值**做出来。也就是说"给宿主一个指向它的地址"要先把它落进一格内存（一格临时量）——
而那是一条语句，表达式位置上插不进去（榜上 `这个位置上带宽度或补零的格式化字面量` 那一行同一个
拦路东西，EC_HOIST）。所以选项 A 的第一步不是"改 cabiWordOfJnc"，是**先有"表达式里能提一格临时量"
那套机器**；那一格一动，别处好几行（格式化字面量、复合赋值那一族）跟着都能收。

函数值那 41 处是同一个问题的小一号版本：jancy 的 `function*` 是**胖的**（fp + 闭包，两个字），
这一层的函数值是一个指针（ADR-0010:84-85）—— 过去要么把两个字都过（那是"两格 ptr"，得先定顺序），
要么明说不收。两条都别猜，等决定。

## 第一百七十二刀：宿主面的**索引属性**

`int property m_cell(int row, int col);` 写在 `opaque class` 里 —— 取/存两格的体在宿主那边，而声明符
上那一串不是形参、是**下标**（prop_indexed.rst:15：属性带数组语义，下标的类型与含义都由写的人定）。
第一百六十刀那一格当时明说不收（"要先把下标也摆进 C_ABI 那张表"），这一刀把它摆进去：

> 下标那几格排在 `self` 后头、值前头 —— 与这一层自己发的 `(call p$get self i…)` /
> `(call p$set self i… v)` 同一个顺序（第七十刀）。逐个过 C_ABI 那张表，过不去的照旧明说。

于是 `g.m_cell[1][2] = 7` 出来是 `(ccall Grid_set_m_cell g 1 2 7)`、读是
`(ccall Grid_get_m_cell g 1 2)`。

### 账：pairs `4759 -> 4753`（−6）

lowered `121`、clean `194` 都没动。这一格小（榜上 5 处），记下来是因为它把第一百六十刀那句"还不收"
兑了 —— 宿主面那一族到这里只剩 `variant_t` / 函数值那一格（见上一节：已经量清、等一个决定）。

## 第一百七十三刀：`variant_t` 过宿主面 —— 过去的是一格**地址**

上一节把事实量清了，这一刀按它落地（选**选项 A**）：

> `variant_t` 过 C_ABI 记成一格 `ptr`，指向**这一层那格 variant 的表示**（`variantTy()`：
> `($t int) ($n int) ($r real) ($s string)`）。调用方负责那份拷贝 —— 落进一格临时内存再把地址过去。

两条理由：**一、这与平台 ABI 做的事是同一件**（jancy 的 `jnc_Variant` 是 64 字节的聚合，SysV
x86-64 与 AAPCS64 上都按内存过，被调方拿到的本来就是地址）；**二、宿主本来就是照我们的约定写的**
（`Owner_method` / `_oN` / `_get_` / `_set_` 那几条都是这一层定的），所以指向的那块按我们的布局是
一致的选择，不是把 jancy 的内部结构猜了一遍。

**这一节头一版写错了一句，当场改对（同一刀里）**：我写的是"那份拷贝要一格临时内存，用第五十八刀
那条 `ecOut` 落点"，并且真按那个发了

```
(let $vt1 (ptr jnc$variant) (pnew …))
(pstore (var $vt1) (call jnc$var$i (int 7)))
```

—— 方言当场拦住：`这个指针指向 jnc$variant，写进去的是 jnc$variant*`。**这一层的 variant 值本来
就是一格地址**（`varBox` 那几格出来的类型是 `jnc$variant*`，结构体值在这一层一律按地址拿）。所以
正确的落法是**一句都不发、把那个地址原样过去**：

```
(expr (ccall Sink_put (var s) (int 1) (call jnc$var$i (int 7))))
```

附带的好处是不用 `ecOut`，于是惰性位置（`&&` 的右边、`? :` 的两支）上也过得去 —— 先前那一版会在
那儿明说不收，那句话是**为一个不存在的困难报的**。

这一笔按第一百五十六刀那条口径记：**腿是最后一道闸门**，而"我以为要多做一步"与"真的要多做一步"
是两笔账。

### 账：pairs `4753 -> 4655`（−98）

- 逐份那张榜：lowered `121`、clean `194` 没动；`'…' 的第 3 个形参的类型 variant_t` 那 88 处与
  `写属性 … variant_t` 那 10 处让开。
- **还没兑的两格照实记**：① `读属性 … variant_t`（20 处）—— 那是**返回**一格 variant，要另一条约定
  （"调用方给一格缓冲"），没定就没做；② 函数值那 41 处 —— jancy 的 `function*` 是胖的两个字，
  过去要先定"哪个字在前"（界钉在 `bad/opaque-host-fn.jnc`，那一份这一轮从枚举改成了函数值）。
- **判据已经到运行期**（上一版记的"尚未证"这一趟补上了）：`tests/llvm/cabi/host.c` 里那格
  `Counter_tag(void* self, const void* v)` 把头两个字按 i64 读出来印掉，`c.tag(7)` 印的是
  `tag 1 7` —— `1` 就是 `V_INT`、`7` 是那格整数。**宿主真按这个布局读得对**，不是只看 `.sx` 里
  发了什么。（方言的 `int` 在原生腿上是 i64，与 ADR-0026:20 那个
  `struct V { int m_tag; int64_t m_n; string_t m_s; }` 是同一个形状。）

### 第一百七十四刀：`variant_t` **从宿主面回来** —— 缓冲区那格摆在最前面

上一刀末尾记的那两格欠账，这一刀兑掉第一格：`读属性 … variant_t`（20 处）。

**约定不是我们定的，是抄 jancy 自己的调用约定。** 上一刀说过 64 字节的聚合"按内存过"，那句话对
**返回**这一头的意思在 jancy 的代码里是写出来的 ——

```cpp
// jnc_ct_CdeclCallConv_arm.cpp:71-80
if (returnType->getFlags() & TypeFlag_StructRet) {
  if (returnType->getSize() > m_retCoerceSizeLimit) { // return in memory
    argCount++;
    typeRwi[0] = returnType->getDataPtrType(DataPtrKind_Thin)->getLlvmType();
    j = 1;
    returnType = m_module->m_typeMgr.getPrimitiveType(TypeKind_Void);
```

三件事一句不差：① 多出一个形参；② 它的类型是"指向那个返回类型的 thin 指针"；③ `j = 1` ——
**它摆在原来那些形参之前**，而 `this` 在 jancy 那边就是 `argArray[0]` 里的一格普通形参，所以缓冲区
那格排在**对象那格之前**；④ 函数自己回 `void`。`variant_t` 落在这一档是因为它带
`TypeFlag_StructRet`（jnc_ct_TypeMgr.cpp:1716-1721 那张 `StructFlags` 是所有"按结构体回"的原始类型
共用的），而 arm 那一支的 `m_retCoerceSizeLimit` 是 0（构造函数里就是 0），64 字节铁定超。

于是 `Owner.m` 在 C 那边是 `void Owner_m(jnc_Variant* ret, void* self, …)`，属性的取值器同一条：
`void Owner_get_p(jnc_Variant* ret, void* self, 下标…)`。

**落点上的一格选择：一个符号发一格包装函数。** "先要一格缓冲、再调、再把那格地址当值用"是三句话，
而 `expr` 这一层回的是一格值。上一刀犯过的错是往第五十八刀那条语句落点（`ecOut`）上想 —— 那会让
惰性位置（`&&` 的右边、`? :` 的两支）上白白说不收。这一刀用 `variantTy` 那一族现成的办法：
`hostVretFn` 按符号发一格 `jnc$vret$<符号>`，里头三句，调用点仍旧只是一格 `(call …)`。
`varBox` / `varUnbox` / `psetFn` 都是这个办法，不是新机器。

改的三处：`hostVretFn` 新增；`hostMethodCall` 与 `hostProp` 各多一格 `vret` 分支（`rw` 变 `void`、
形参词表前面插一格 `ptr`、调用点换成那格包装函数），顺带各多记一串 `slots`（包装函数的形参得写方言
类型，与 C_ABI 那几个词不是同一张表）。

**判据到运行期。** `tests/llvm/cabi/host.c` 里
`void Counter_last(void* ret, void* self)` 往调用方给的那块内存写 `p[0] = 1`（`V_INT`）、
`p[1] = 当前值`，`Counter_get_m_last` 转手同一格；`tests/llvm/run.js` 第 9 节的 jnc 源里
`variant_t last();` 与 `variant_t property m_last { variant_t get(); }` 各调一次，印出
`last 142` / `mlast 142` —— 那个 142 是宿主那张表里的数经**我们**的拆箱（标签对得上才不 `fail`）
读回来的，所以"缓冲区谁给的、写在哪一格、标签对不对"三件事一次证齐。`.sx` 那一层也逐字比：
`(cabi Counter_last void (ptr ptr))` 与 `(cabi Counter_get_m_last void (ptr ptr))` —— 回 `void`、
两格 `ptr`（缓冲 + 对象）。

- 腿：`node tests/jnc/run.js` 278/0、`node tests/llvm/run.js` 38/0。
- 逐份那张榜：lowered `121`、clean `194` 都没动；`(文件, 拦路项)` 对 `4655 -> 4650`。
  `读属性 … 它的类型 variant_t 落不进 C_ABI 的那几个词` **整行没了**（20 处、分布在 5 份文件里 ——
  所以对数只掉 5，那 5 份里还有别的拦路项）。一整批当一个模块那一格（`test/ioninja/api`）
  没动（100 条 / 28 种）：那 44 份里没有回 `variant_t` 的宿主成员。
- **还欠的那一格照实记**：函数值过宿主面（41 处）。这一刀之后 `bad/opaque-host-fn.jnc` 那条界的理由
  要改口径 —— 拦路的**不是** jancy 的 `function*` 胖不胖（它有 `FunctionPtrKind_Thin` 那一档，
  `type->m_size = ptrKind == FunctionPtrKind_Thin ? sizeof(void*) : sizeof(FunctionPtr)`，
  jnc_ct_TypeMgr.cpp:1378，那一档就是**一个字**），而是**这一层自己**的函数值是一条闭包记录
  （`(fnref F)` 发的是一格薄适配器闭包，sexpr/lower.js:1749-1791），根本拿不出一格裸代码地址来。
  也就是说这一格与 `main` 的退出码同一性质：**方言那一层缺一格**，不是 jnc 前端一刀能补的。
  这一笔先记在这儿，下一刀去改那份 fixture 的说法（今天那份注释说的理由是错的）。

### 第一百七十五刀：函数值的**空**那一格 —— 一笔过期的账

榜上这两行加起来 152 处，都是同一件事：

```
83  E void function*() 不能当条件用
69  N null 当一格函数值（void function*()）—— 方言里的函数值只能从一个真函数做出来（`(fnref …)`），还没有"空的那一格"
```

第一行是 **`E`** —— 也就是我们发的是"普通错"，而 jancy **收**这一句。错在哪儿，jancy 的表里写着：

```cpp
// jnc_ct_CastOp_Bool.cpp:183-187
case TypeKind_DataPtr:
case TypeKind_ClassPtr:
case TypeKind_FunctionPtr:
case TypeKind_PropertyPtr:
	return &m_fromPtr;
```

`Cast_BoolFromPtr::llvmCast`（同文件:116-127）是"取那格胖指针的第 0 个字段、跟零比"。也就是
`if (fp)` 问的是**函数地址那一半在不在**。这一层早就把 DataPtr / ClassPtr / 枚举 / 字符串各自那一支
照抄了（第四十七 / 五十二 / 一百四十六刀），漏的就是 FunctionPtr 这一格。

第二行那句"方言里……还没有空的那一格"是**过期的账**：方言那一侧后来长出来了 ——

```js
// src/core/sexpr/lower.js:2418-2437（方言那边的第三十三刀）
if (h === 'null') { … return { kind: t.k === 'fn' ? 'NullFn' : 'NullRef', type: t }; }
```

`(null (fnty …))` 六条腿都认（JS 的 `null`、C 的 `NULL`、LLVM 的 `null`、两个解释器的 `null`、
MIR 的 `K.nul`），`tests/llvm/three-way/21_null_fn_call.omni` 量的正是"调空函数值是运行期错"。
落地前先拿一份手写的 `.sx` 在 `run` 与 `run-jit` 两条腿上各验过一遍（赋空、`== null`、`!= null`、
赋真函数再调），两条腿都对 —— **不是照着注释猜方言收什么**。

改了四处，都很小：`zeroText` 多一行（`fnptr` 的零值是 `(null …)`）、局部量那一处删掉专门的拒绝、
`null` 那一格 case 回 `(null …)`、`truthy` 多一支。

**同一刀里钉了一条新界**：两个**真**函数值互相比明说不收（`bad/fnval-eq.jnc`）。这不是偷懒 ——
jancy 的比较把两边一起转成 `intptr_t`（`getPtrCmpOperatorOperandType`，jnc_ct_BinOp_Cmp.cpp:22-29；
`TypeKindFlag_Ptr` 把函数指针也算进去），取的是函数地址那一半、闭包那一半不参与；而这一层的函数值
是一条闭包记录，`(bin "==" f g)` 比的是"是不是同一条记录"。于是"同一个方法绑在两个不同对象上"
这一句两边答得不一样 —— 糊过去就是个静默的错答案。跟 `null` 比不受这条影响（空就是空），所以收。

- 腿：`node tests/jnc/run.js` 279/0、`node tests/llvm/run.js` 38/0。
- 逐份那张榜：`(文件, 拦路项)` 对 `4650 -> 4491`（−159）。lowered `121`、clean `194` 都**没动** ——
  这 152 处散在很多份文件里、每份还有别的拦路项，所以一份也没因此变干净。上面那两行整行消失。
- **中间量出来一格顺手补掉**：那两行一让开，`… 的局部量不写初值（方言的函数值那一格没有空值）`
  这一行浮出来（4 处，而且**把类型名拼进了消息里** —— 又是第一百四十九刀那条律：消息里留可变文本
  就会把一行拆成好几行）。同一笔账（"方言没有空值"），所以同一刀里一起兑：`zeroText` 那一行管的
  就是它，对数从 4495 再掉到 4491。
- **两份 fixture 退役**（墙真的移了，不是绕开）：`bad/null-fnvalue`（`= null` 的默认实参 + `cb == null`）
  升成 `cases/147-fnnulldefault.jnc`、`bad/fnptr-nozero`（不写初值）并进 `cases/146-fnnull.jnc`。
  两份 case 的期望值都出自手写的 C 尺子（`/tmp/c152.c`、`/tmp/c153.c`，`cc -O0 -std=c99 -Wall`）。
  146 那一份里"不写初值"这一格在 C 尺子上写成了 `= NULL`：jancy 的局部量是零初始化的、C 的不是，
  这条差别记在两份源码的注释里 —— 要量的是"空的函数值按真值用"这件事本身。

### 第一百七十六刀：jancy 的**全局 CRT** —— 那不是内建，是一份隐式 import 的源码

榜上 `没有这个函数：'…'` 那 219 处里，一大块是 `rand` / `isdigit` / `toupper` / `strlen` / `memcpy`
这一族。**先量清"它们是什么"再动手**：

```cpp
// jnc_std_StdLib.cpp:906-931
JNC_BEGIN_LIB_SOURCE_FILE_TABLE(jnc_StdLib)
	JNC_LIB_SOURCE_FILE("std_globals.jnc", g_std_globalsSrc)
	…
	JNC_LIB_IMPORT("std_globals.jnc")
JNC_END_LIB_SOURCE_FILE_TABLE()
```

也就是说：它们**不是编译器内建**，是 std 扩展库随身带的一份 `.jnc` 源码，而且每个模块都
**自动 import** 了它。那一份里有一半是**真的 jancy 代码**（`streq` / `atoi` / `strdjb2` 的体就写在
里头），另一半只有声明、由 `JNC_MAP_FUNCTION` 接到 C/C++ 的实现上（同文件:834-895）。这一条
把这一族的性质定死了：**照那份声明办**，不是我们自己发明一套库。

这一刀落**不碰指针**的那一批（10 个字符函数 + `rand`），碰指针的那一批（`str*` / `mem*` /
`strtol` 那一族 / `print` / `gets`）留在后面 —— 它们各自有胖指针、NUL 结尾、GC 分配这几件事要先
量清（`strdup` / `strcat` / `memcat` / `memdup` 在 jancy 里是**新分配一块**回来，不是 C 的那个语义；
`gets` 在现代 libc 里已经没有了）。

**两种落法，分界是"C 的同名函数答得一样吗"：**

- `rand()` -> 一句 `(ccall rand i32 ())`。判据是 jancy 自己说的：文档写着 "Maps directly to
  standard C function ``rand``"（std_globals.jnc:387-391），扩展库那一行也是
  `JNC_MAP_FUNCTION("rand", ::rand)`。所以这不是"我们决定接到 libc"，是照抄。
- 八个 `isXXX(utf32_t) -> bool` 与 `toupper` / `tolower` -> **自己发一格助手**，按 ASCII 判。
  为什么不叫 C 的同名函数：jancy 接的是它自己的 **Unicode** 实现（`enc::isSpace` / `enc::toUpper`
  那一族，jnc_std_StdLib.cpp:834-841 与 :890-891），而 C 库那几个是按 locale 的单字节表 ——
  名字一样、**答案在 ≥128 的码点上不一样**。糊过去就是个静默的错答案。
  **这条分岔照实记**：ASCII 那一段（0..127）两边逐个相同；≥128 的码点上这一层一律答 `false` /
  原样返回，而 jancy 会按 Unicode 表答（比如 U+00E9 在 jancy 是字母、在这一层不是）。语料里
  这一族全部用在 ASCII 上，所以今天量不出差别 —— 但它是**欠的**，不是"对的"。

判据分两处摆，分界是"C_ABI 符号只有原生腿上才有"（ADR-0014 的第 4 条决定）：

- 字符那一族在 `tests/jnc/cases/148-crtchar.jnc`，期望值出自 `/tmp/c154.c` —— 那份尺子直接用
  C 库的 `<ctype.h>`，也就是**独立**的第三方答案（C 的 `isXXX` 回非零而不是 1，所以那儿加了 `!!`）。
  七个码点 × 十个函数一次比完。
- `rand` 在 `tests/llvm/run.js` 第 9 节（那条腿是 JIT，libc 就在进程里）：`rand() >= 0` 印
  `rand 1`，`.sx` 里逐字比 `(cabi rand i32 ())`。**这一格是量出来的**：先前把 `rand` 写进
  `tests/jnc/cases` 里，`run` 那条腿当场说
  `C ABI symbol 'rand' is only available in a native build` —— 腿是最后一道闸门。

- 腿：`node tests/jnc/run.js` 280/0、`node tests/llvm/run.js` 38/0。
- 逐份那张榜：**lowered `121 -> 124`（+3）** —— 这个数一整轮都没动过，这一刀第一次推动它
  （`samples/jnc/30_SimplePropertyDecl.jnc` 那一族：属性的体写在类外这件事第六十八刀早就收了，
  唯一拦着的就是 `rand`）。clean `194` 没动，`(文件, 拦路项)` 对 `4491 -> 4485`。
- 顺带量清一件事、把一条旧猜法划掉：`写属性 … 存值器没有定义`（96 处）与
  `读属性 … 取值器没有定义`（47 处）**不是**"属性的体写在类外"那个特性没做 —— 那一格
  第六十八刀就收了（`propSig` 认 `T p.get() { … }`）。那 143 处是**属性的主人在另一个模块里**
  （`import "std_Buffer.jnc"` 之类找不着），也就是 import 那条账的下游，不是一格独立的特性。

### 第一百七十七刀：`string_t` 上那两格公开字段 —— 一格答得出、一格明说不收

榜上 `'…' 的左边不是结构体：string`（51 处）问的是字符串上的字段。jancy 的字符串是一格结构体，
**哪几格能直接读，它的源码里连注释一起写着**：

```cpp
// jnc_ct_TypeMgr.cpp:2031-2039
StructType* type = createInternalStructType("jnc.string_t");
// m_p && m_length are accessible directly (e.g.: string_t s; file.write(s.m_p, s.m_length);
type->createField("m_p", getStdType(StdType_CharConstPtr), 0, ConstKind_ReadOnly);
type->createField("!m_ptr_sz", getStdType(StdType_CharConstPtr));
type->createField("m_length", getPrimitiveType(TypeKind_SizeT), 0, ConstKind_ReadOnly);
```

三格里带 `!` 的那一格是内部的（jancy 自己的约定：`!` 开头的名字查不着），公开的两格都是**只读**的。

- `m_length` **答得出**：`(slen …)` 就是它 —— 两边都是"按**字节**的长度"。判据在
  `cases/149-strlength.jnc`：`"héllo"` 是 **6** 而不是 5（那个 é 在 UTF-8 里占两个字节），
  尺子 `/tmp/c155.c` 用的是 `strlen`。这一格与第一百四十六刀 `if (s)` 用的是同一格
  （那一刀已经查过 jancy 的 `Cast_BoolFromString` 取的是第 3 个字段 = 长度）。
- `m_p` **明说不收**（`bad/string-mp.jnc`）：它指到**字节**上，而这一层的 `char*` 指的是方言的
  整数格（一格 8 字节）。糊一个地址过去就是让下游按字节读一段不是字节的内存。这一格与
  第一百七十六刀留下的 `str*` / `mem*` 那一批是**同一条账**：这一层缺的是"一段真字节"这个说法。

- 腿：`node tests/jnc/run.js` 282/0。
- 逐份那张榜：lowered `124` 与 `(文件, 拦路项)` 对 `4485` 都没动；**clean `194 -> 191`（−3）**。
  **这个数往反方向走了，原因照实记**：`s.m_p` 先前落在一句普通错上（`'.' 的左边不是结构体：string`
  —— 那是 `E`，不进"还不收"那一栏），这一刀把它改成了 `N`。也就是说这三份文件**两趟都编不过**，
  变的只是"我们承认那是欠的还是假装是用户写错了"。jancy 收 `s.m_p`，所以 `N` 才是对的分类 ——
  这个指标掉 3 是它变诚实的代价，不是能力退了。

### 第一百七十八刀：类型是 `variant_t` 的 autoget 属性 —— 第一百七十三刀那条量出来的复利

榜上 `类型是 variant_t 的 autoget 属性 —— 编译器要生成的那一格存储得是能一句读完的一格`
（88 处）。那句话原本的理由是对的：autoget 要编译器生成**一格存储 + 一个取值器**
（prop_autoget.rst；jancy 那边是 `createAutoGetValue` / `compileAutoGetter`），而结构体那种存储
"读一次"要抄一份，合成的取值器就不是一句 `ret` 了。

`variant_t` 是**例外**，而这一条是第一百七十三刀量出来的那句话的直接后果：**这一层的 variant 值
本来就是一格地址**（`varBox` 那几格出来的类型是 `jnc$variant*`）。于是

- 那格存储就是一格普通的 variant 字段 —— 与手写的 `variant_t m_v;` 发的东西一模一样
  （`(struct C … (m_value jnc$variant))`，这一格早就能用）；
- 取值器回的是**那一格的地址**（`(ret (pfield (var $this) …$m_value))`），仍旧是一句 `ret`。

改了三处：那句拒绝上加 `&& !isVar(t)`、成员取值器的读法（`(pload ad)` -> `ad`）、顶层那一格
**真开一段内存**。最后这一处是**量出来的**：不开就是 `(global g (ptr jnc$variant))` 一个空指针，
存值器里那句 `m_value = x` 当场 `null pointer dereference` —— 与一格普通的顶层 `variant_t g;`
走同一条路才对（`declareGlobal` 那儿也是 `(global …)` + globalCells 里一句 `pnew`）。

判据：`cases/150-variantautoget.jnc`（顶层与成员各一格，尺子 `/tmp/c156.c` 把 autoget 那两件
生成物在 C 里手写出来 —— 一格带标签的存储 + 一个回地址的取值器，存值器是源码里那一个）。
"存值器真跑了"看那两句 `set`，"存进去的读得回来"看 `g 9` / `g 11` / `m 7`。

- 腿：`node tests/jnc/run.js` 283/0。
- 逐份那张榜：`(文件, 拦路项)` 对 `4485 -> 4394`（**−91**，那一行整行消失）。lowered `124`、
  clean `191` 都没动 —— 这 88 处散在很多份文件里，每份还压着别的拦路项。

### 第一百七十九刀：完整声明式的属性体里的**普通字段** —— 又一条我们自己多加的规矩

榜上 `完整声明式的属性（… 那对花括号开的是一层命名空间）`（70 处）背后其实是好几种形状。
先量清 jancy 到底收什么 ——

> A full property declaration looks a lot like a declaration for a class. It implicitly opens a
> namespace and allows for overloaded setters, **member fields**, helper methods,
> constructors/destructors etc.
> —— prop_full.rst:15-16，紧接着的例子第一行就是 `int m_x = 5; // member field with in-place initializer`

而这一层先前只收两种成员：带 `autoget` 的字段与 `bindable event` 的事件，别的一律
"字段要写 `autoget`"。那句话**不是 jancy 的规矩，是我们自己多加的一条**。

落法用现成的路：不带 `autoget` 的字段与 autoget 那格存储**在这一层是同一件东西** ——
属性那层命名空间里的一格存储，名字由写的人定，取/存两个体里裸写它。差别只有一处：

- 属性的**类型**照旧从 `get` 抄，不从这格字段抄（jancy 那边属性的类型就是取值器的返回类型；
  `autoget` 那一种才反过来 —— 它没有手写的取值器）。所以体里没有 `get` 的话这一格说不通，
  那一句留在原处（`fldT` 那个变量就是这条分界）。

顺带一个好处：类型对不上时**指的是对的人**。`int m_v;` + `bool get()` 这一句，存储按属性的类型
（bool）发，于是报的是 `赋值两边不同型：左是 bool，右是 int` 指着 `m_v = x ? 1 : 0` —— 而不是
先前那种"属性 'g_p' 是 int"（那是从字段抄的类型，culprit 认错了）。

判据：`cases/151-propfield.jnc`（顶层与成员各一格，存值器故意乘 3 / 取值器故意乘 2，好让
"两个体真跑了"在输出上看得见），尺子 `/tmp/c157.c` 把那三件东西在 C 里手写出来。
`bad/propfull-plainfield` 退役 —— 那面墙真的移了。

- 腿：`node tests/jnc/run.js` 283/0。
- 逐份那张榜：**一个数都没动**（lowered `124`、clean `191`、对 `4394`）。照实记：语料里那 70 处
  是**别的形状**，这一刀落的这一种恰好一处都没碰上。量出来的下一格也很具体 ——
  `samples/jnc/31_FullPropertyDecl.jnc` 现在停在第 19 行的 `int m_x = 5;`（**带就地初值**的字段，
  语法上是 `init` 而不是 `dcl`，落到"一条声明只收一格"那句上）。那一格要把初值一路带到生成的
  那格存储上（顶层进 globalCells、成员进 ctor），是下一刀的事。

### 第一百八十刀：属性体里那格字段的**就地初值**

上一刀量出来的下一格，兑掉。jancy 的例子第一行就是它：

```jnc
property g_prop {
	int m_x = 5; // member field with in-place initializer     —— prop_full.rst:18
```

语法上 `int m_x = 5;` 是一格 `init`（里头包着声明符与初值），先前落到"一条声明只收一格"那句上。
两种落法与"那格存储在哪儿"是一对，**两条都用现成的路，一个字的新机器都没长**：

- 顶层的属性 -> 那格存储是一格模块级变量，初值排进 `globalInit` —— 与一格普通的 `int g = 5;`
  走同一条 `globalValue`；
- 成员属性 -> 那格存储是类里的一格字段，初值排进 `fieldInits` —— 也就是**字段默认值**那条路
  （第七十八刀）。这一笔必须在 `autoStore` 那一步记：合成的 construct 要不要发是 `synthFI` 算的，
  而那一遍在发之前就跑完了。

判据：`cases/152-propfieldinit.jnc`（顶层与成员各一格；`g0 5` / `m0 7` 是初值真赋上了，
`g1 6`（3×2）/ `m1 10`（9+1）是存值器真跑了），尺子 `/tmp/c158.c`。

- 腿：`node tests/jnc/run.js` 284/0。
- 逐份那张榜：又是**一个数都没动**（lowered `124`、clean `191`、对 `4394`）。
- 但**量出来的下一格更近了一步**：`samples/jnc/31_FullPropertyDecl.jnc` 从第 19 行推进到第 30 行 ——
  现在停在 `完整声明式的属性 'g_prop' 里两个 set（要重载决议）`。那是 jancy 明写支持的
  （prop_full.rst:15 的 "overloaded setters"，例子里 `set(int x)` 与 `set(double x)` 各一格），
  而这一层的属性一个名字只记一格存值器 —— 要收它得让"写属性"这一处走重载决议
  （  与第八十刀那套 `pickOverload` 是同一套机器，只是挂在属性的 set 上）。这是下一刀。

### 第一百八十一刀：属性的**存值器重载**

上一刀量出来的下一格，兑掉。jancy 明写支持（prop_full.rst:15 的 "overloaded setters"，例子里
`set(int x)` 与 `set(double x)` 各一格），而这一层一个属性只记一格存值器 —— 第二个 `set` 先前
是一句"要重载决议"。

落法与别处的重载**同一套**，一个字的新机器都没长：

- 名字上加后缀：`p$set` / `p$set$o2` / …（与宿主面那条 `_o2` 是同一个主意，第一百七十一刀）。
  第一格收的是**属性自己的类型**（prop.rst:16 那句），后面几格收别的 —— 记在 `pi.sets` 上。
- 挑哪一条在**写属性**那一处按右边的类型排（`propSet` 里那段 `argCost`，与第八十刀的
  `pickOverload` / 第一百七十一刀的 `hostPick` 逐条一样）：问不出右边的类型的**明说不收**
  （绝不猜），同分的也明说，两格收同一个类型的在声明处就拒（那两格在任何右边上都分不出来）。
- `get` 照旧只许一个（prop.rst:15 那句 "a single getter"）—— 而且那句诊断从"还不收"改成了
  **普通错**：jancy 那儿它本来就是错的。

两种写法都收，判据在 `cases/153-propsetovl.jnc` 里各一格：体里直接带体的那一种，与体里只有
原型、体写在外面的那一种（`void g_q.set(bool x) { … }` —— prop_full.rst:37 那句 out-of-line）。
尺子 `/tmp/c160.c` 把"挑哪一条"按类型写在调用点上 —— 那正是这一层做的事（编译期挑）。
`bad/propfull-overload` 退役。

- 腿：`node tests/jnc/run.js` 284/0。
- 逐份那张榜：**三个数一起往对的方向动**——lowered `124 -> 126`（+2）、
  clean `191 -> 193`（+2）、`(文件, 拦路项)` 对 `4394 -> 4386`（−8）。
- 量出来的下一格：`samples/jnc/31_FullPropertyDecl.jnc` 从第 30 行推进到第 34 行 ——
  `void update() { … }`，属性体里的**帮手方法**（prop_full.rst:15 那句 "helper methods"）。
  那一格与这三刀是同一个家族：属性体是一层命名空间，里头能放的东西比我们收的多。

  **但先量了一下值不值得**：帮手方法那一行在榜上只有 **2 处**，而
  `完整声明式的属性（… 那对花括号开的是一层命名空间）` 那一行有 **70 处** —— 后者才是这一族里
  最大的一块。顺着一份文件往下钻，那 70 处的形状钻出来了，**八行就能复现**：

  ```jnc
  class C {
      char* m_p;
      void const* const property m_end {   // <- 这一格没被 expandFullProps 改写
          return m_p;
      }
  }
  ```

  同一个文件里紧挨着的 `bool const property m_isIncomplete { return …; }`（第一百五十七刀那种
  "体里直接就是取值器的体"）是**收**的，`void const*` 这一格不收 —— 也就是说拦路的不是
  "完整声明式"这件事本身，是那个类型（`void const*`：`property` 落在**星号后面**那一组词里，
  而这一格与第七十二刀那条路又不完全同形）。判据文件：`jnc_DynamicLayout.jnc:91`。
  这一格是下一刀的入口，比帮手方法值 35 倍。

### 第一百八十二刀：那 70 处不是"特性没做"—— 是改写留下的一撮词把自己的产物拦了一遍

上一刀钻出来的形状，这一刀量到根上。病根**不在**属性那一族，在**改写**这一步：

`property` 那个词可以落在两处 —— 说明符表里（`bool const property m_isBig`），或者**星号后面
那一组**（`void const* const property m_end`，第七十二刀那条路认的就是它，`tailMods`）。
第一百五十七刀那种"体里直接就是取值器的体"会把属性那格声明符**原样**给改写出来的 getter 用，
而洗词的 `keep()` 只洗了说明符表。于是：

1. 改写出来的那格 getter 的声明符上**还留着 `property`**；
2. 第二遍 `expandFullProps`（第一百五十九刀为泛型/extension 加的那一遍）把它又认成一格完整
   声明式的属性，`fullProp` 这回回 null（名字已经是 `qualified-special` 了）；
3. 于是那一条照原样留着，最后由 `fnSig0` 报一句
   `完整声明式的属性（… 那对花括号开的是一层命名空间）`。

**也就是说：那一行报的不是"这个特性还不收"，是我们自己的改写产物被自己的探测器抓住了。**
同一个文件里紧挨着的两格只差一个星号、一格收一格不收，就是这条的指纹（jnc_DynamicLayout.jnc:87
收、:91 不收）。

修法一处、四行：`dropPropTail(ptrs, words)` —— 把声明符最后那一组里的 `property` / `const`
摘掉，与 `ptrsTy` 的 `dropTail` 同一条口径（那几个词已经被这条声明吃掉了，不该再当指针的修饰符
看第二遍）。**踩过一个坑**：一组里的元素自己还是一格列表（`tailMods` / `ptrsTy` 都是 flat 两层
才拿到那几个词），第一版只摊一层、筛不掉任何东西 —— 改成摊两层再拼回"表头 + 那几个词"。
左递归那一串的表头照 `aggPropRw` 那条办（回到最里头那一格）。

判据：`cases/154-proptailptr.jnc`（星号那一格与不带星号那一格并排，各读两次；尺子 `/tmp/c161.c`）。

- 腿：`node tests/jnc/run.js` 285/0。
- 逐份那张榜：`(文件, 拦路项)` 对 `4386 -> 4276`（**−110**）—— 那一行 **70 处整行消失**，
  连带它下游的一批也让开了。lowered `126`、clean `193` 没动。
- **一条能复用的律**（记在这儿，与第一百四十九刀那条并列）：**改写这一步的产物必须洗干净触发
  改写的那些词** —— 不然多跑一遍改写就会把自己的产物再认一次。这一层已经有两处改写要跑两遍
  （expandFullProps 为泛型与 extension 各一遍），所以这不是偶然。

#### 顺带量清一格：`case 的标签算不出来`（53 处）**不是**常量折叠的欠账

那一行看着像"编译期求值没做全"，钻下去不是。判据文件 `Df1LogRepresenter.jnc:151`：

```jnc
switch (recordCode) {
case Df1LogRecordCode.Eot:      // <- 报"算不出来"
```

把同一句抄成一份八行的小文件（连 `import "Df1LogRecordCode.jnc"` 一起），**当场就过** ——
`constInt` 那条 `field` 支（第三十九刀）本来就认枚举成员，连 `0x01d67c31be5b71a0 |
log.RecordCodeFlags.Foldable`（超过 i64 正半区的那种）都算得出。

真相是：**`Df1LogRepresenter.jnc` 那份文件里一句 `import "Df1LogRecordCode.jnc"` 都没有**
（它的 import 只有 log_Representation / log_RepresentStruct / io_Df1 / crc16）。ioninja 的插件
是按**工程的文件表**一起编的，不靠每份文件自己 import。所以那 53 处与 `写属性 … 存值器没有定义`
那 143 处、`import "std_Buffer.jnc"` 那 91 处是**同一条账**：逐份编这条量法本身的边界，不是特性
欠账。

**这条记下来是为了不再上当**：榜上一行"看起来像特性"的，先抄成最小复现件试一次 —— 这一次省下的
是"给 `constInt` 加一整套折叠"那一刀。（诊断本身还有个小毛病：那儿该说"`Df1LogRecordCode`
这个名字在这份文件里没有"，说成"算不出来"是认错了人。改它会把一行拆成好几行，见第一百四十九刀
  那条律，所以单独一刀去做，连带把 `--group` 那条量法一起想清楚。）

### 第一百八十三刀：没写 `opaque` 的类里那些只有原型的方法 —— 拆掉一道我们自己加的闸门

一起编那张榜（44 份当一个模块，把 import 的噪音去掉之后）上最大的一块就是它：
`原型 '…' 没有带体的定义` 三行加起来 **43 条 / 95 条**。

**这一刀翻的是先前自己记下的一条线**（`bad/protoonly-call.jnc` 的注释原话：
"这里的类没写那个词，所以这一层不替它认下那件事"）。翻它的理由是量出来的三条：

1. `opaque` 在 jancy 里说的是"这个类的**布局**对 jancy 不透明"—— opaque.rst 整篇讲的是字段与
   大小，它**管的不是"方法的体在哪儿"**。
2. jancy 那边把声明接到 C 实现上的 `JNC_MAP_FUNCTION`（jnc_std_StdLib.cpp:834-895 那一串）
   **不问类是不是 opaque** —— 任何声明过的函数都能映。
3. "没有体的函数"在 jancy 里**不是编译期错误**（第一百五十一刀那一轮量过：它没有那条检查）。

所以决定"体在宿主"的只有一件事：**这个模块里没有那个体**。改法一处一行：那一格登记
（`hostFns` / `hostSigs`）的条件从 `cls && key === 'opaque class'` 变成 `cls`。体外真写了定义时
这一格用不上（调用那边先按名字查，查着了就不问这里）——这条在第六十六刀那格注释里本来就写着。

**代价照实记**：写错方法名的那种从"编译期一句诊断"变成"链接期找不着符号"。这一笔与
`(cabi …)` 那条路是同一笔（ADR-0022 的 J4b 早就接受了它），而且 jancy 自己就是这样。

判据搬到原生腿上（`tests/jnc/cases` 那条轴要 `run-jit == run`，而 C_ABI 符号只有原生腿上才有）：
`tests/llvm/run.js` 第 9 节多一格**没写 `opaque`** 的 `class Plain { long twice(long x); }`，
宿主那边 `int64_t Plain_twice(void*, int64_t)` 乘 2，`q.twice(21)` 印 `plain 42`；`.sx` 里逐字比
`(cabi Plain_twice i64 (ptr i64))`。`bad/protoonly-call` 退役。

- 腿：`node tests/jnc/run.js` 284/0、`node tests/llvm/run.js` 38/0。
- 逐份那张榜：lowered `126 -> 128`（+2）、clean `193 -> 198`（+5）、对 `4276 -> 4228`（−48）。
- **一起编那张榜只掉了 1 条（95 -> 94），而且有两行往上走**：
  `没有这个类型` 11 -> 12、`原型 … 造一格它就得调它` 11 -> 12。原因是**墙往里挪了**：先前停在
  "方法没有体"的那些地方现在过去了，于是后面那几格（构造的原型、别的类型名）露出来。这不是退步 ——
  同一份文件里能编过的**行数**多了，露出来的是下一道墙。下一刀就是那 12 条：
  没写 `opaque` 的类里那格只有原型的 `construct`（`hostCtors` / `hostCtorSigs` 那道闸门同一条
  理由，第 5528 行）。

### 第一百八十四刀：那格只有原型的 `construct` 也一样

上一刀说的下一格，同一条理由、同一处形状：`opaque` 说的是布局、不是"体在哪儿"。改法也是一行 ——
`hostCtors` / `hostCtorSigs` 那一格的条件从 `cls && key === 'opaque class' && sk === 'construct'`
变成 `cls && sk === 'construct'`。`protoCtors` 那张表照旧记着（第一百四十八刀 —— 别处还靠它说话）。

判据接在上一刀那格 `Plain` 上（`tests/llvm/run.js` 第 9 节）：`construct(long seed);` +
`long seeded();`，宿主那边 `Plain_construct` 把 seed 记进自己那张表、`Plain_seeded` 读回来，
`new Plain(5)` 之后 `q.twice(21)` 与 `q.seeded()` 印 `plain 42 5` —— **construct 真跑了**这件事
就在那个 5 上。`.sx` 里逐字比 `(cabi Plain_construct void (ptr i64))`。
`bad/protoonly-ctor` 退役。

- 腿：`node tests/jnc/run.js` 283/0、`node tests/llvm/run.js` 38/0。
- 逐份那张榜：lowered `128 -> 131`（+3）、clean `198 -> 201`（+3）、对 `4228 -> 4206`（−22）。
- **一起编那张榜 `94 -> 84`（−10）**：`原型 … 造一格它就得调它` 那一行整行消失。这两刀合起来把
  那张榜从 95 条压到 84 条，而 lowered 从 126 走到 131（这一整轮从 121 走到 131）。

### 第一百八十五刀：**顶层**那些只有原型的函数

同一族的最后一格。一起编那张榜上剩下的 16 条"原型没有带体的定义"全是顶层的
（`trace` / `sendKeepAlive` / `doc.sessionDispatch` / `clearLog` / `connect`…，
doc_PluginHost.jnc:56-58、ias.jnc:20/27 那一批），第一百五十一刀记的界就是它。

符号名的规则**不用新定**：`Owner_method` 那条本来就是"全名把 `$` 换成 `_`"，顶层这一格只是
少一格 `this` —— `hostAdd` 就叫 `hostAdd`、命名空间里的 `probe.hostMul` 叫 `probe_hostMul`。
新增两处：`hostTopSigs`（名字 -> `{ret, params, defs}`，在原来发那句诊断的地方登记）与
`hostTopCall`（调用点，与 `hostMethodCall` 逐条同一套检查，少一格 self）。默认值、`variant_t`
两头（第一百七十三 / 一百七十四刀）都照旧走同一份机器。

判据在 `tests/llvm/run.js` 第 9 节：`long hostAdd(long, long);` 与
`namespace probe { long hostMul(long, long); }` 各调一次，印 `top 42 42`；`.sx` 里逐字比
`(cabi hostAdd i64 (i64 i64))` 与 `(cabi probe_hostMul i64 (i64 i64))`（**命名空间那一格带前缀**
是这一刀要证的第二件事）。`bad/proto-nobody` 退役。

- 腿：`node tests/jnc/run.js` 282/0、`node tests/llvm/run.js` 38/0。
- 逐份那张榜：lowered `131 -> 136`（+5）、clean `201 -> 206`（+5）、对 `4206 -> 4121`（−85）。
- 一起编那张榜：`84 -> 70`（−14）、理由 `23 -> 22`。**`没有这个类型` 那一行 12 -> 14**（往上走了）
  —— 又是墙往里挪：那 16 处过去之后，后面的类型名才被问到。
- 三刀合起来（183 + 184 + 185）：一起编那张榜 `95 -> 70`，逐份 lowered `126 -> 136`、
  clean `193 -> 206`、对 `4276 -> 4121`。**共同的那一条**记在这儿：
  `opaque` 这个词管的是**布局**，不是"体在哪儿"；决定"体在宿主"的只有"这个模块里没有那个体"。



## 后果与代价





- 方言从"没有可算术的引用"变成"有"。这一格会渗到 MIR 与四个后端，改不回去。
- fat 指针三字内联：结构体里放指针就胖三倍。可接受——这一层没有 ABI 兼容负担。
- 两套实现意味着**两处都要验**。纪律靠"不许观测裸地址"这一条守住。
- 没有 oracle 意味着错了不会被自动抓住。纪律靠"每条期望都有出处"这一条守住。
