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

**界**：字段路径的别名明说不收（`bad/alias-fieldpath.jnc`）—— 那一格要的是"名字 -> 一串
取字段"的重写，读、写、`&`、结构体拷贝四处都得跟着，与前两支不是一回事。

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

## 后果与代价



- 方言从"没有可算术的引用"变成"有"。这一格会渗到 MIR 与四个后端，改不回去。
- fat 指针三字内联：结构体里放指针就胖三倍。可接受——这一层没有 ABI 兼容负担。
- 两套实现意味着**两处都要验**。纪律靠"不许观测裸地址"这一条守住。
- 没有 oracle 意味着错了不会被自动抓住。纪律靠"每条期望都有出处"这一条守住。
