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

分步 7 与 8 一起落地：`stage0/src/frontend-jnc/lower.js`（jnc 树 -> 核心方言）、`.jnc`
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
`stage0/src/frontend-jnc/lower.js` 一个文件，共享面一个字没碰。
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
`stage0/src/frontend-jnc/lower.js` 一个文件，共享面一个字没碰。
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
`stage0/src/frontend-jnc/lower.js` 一个文件，共享面一个字没碰。
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

## 后果与代价

- 方言从"没有可算术的引用"变成"有"。这一格会渗到 MIR 与四个后端，改不回去。
- fat 指针三字内联：结构体里放指针就胖三倍。可接受——这一层没有 ABI 兼容负担。
- 两套实现意味着**两处都要验**。纪律靠"不许观测裸地址"这一条守住。
- 没有 oracle 意味着错了不会被自动抓住。纪律靠"每条期望都有出处"这一条守住。
