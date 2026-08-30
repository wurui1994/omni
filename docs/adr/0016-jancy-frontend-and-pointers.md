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
2. `&x` —— 要局部量可寻址（jancy 那边是"提到 GC 堆上"）。
3. 真数组 `int a[3]` —— jancy 的数组是**值**类型，方言的 `(arr T)` 是引用语义；
   要方言有值语义的定长数组。
4. 定宽整数——jancy 的 `int` 是 32 位、`char` 8 位，这一层全按 64 位。溢出会不一样，
   这是目前**唯一一处会静默给出不同答案**的地方，所以排在这份名单里而不是"不收"里。
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

**刻意没做**：`(srep S N)`（重复一个串，printf 的宽度要它）。封闭 ABI 里确实有个
`js_str_repeat`，但它收发的是 `omni_dyn`——从这条按类型走的路上用它要装箱拆箱两次。
对的形状是在运行时里加 `omni_str_repeat(omni_str, int64_t)`。它与 `%.Nf`（精度：要先
定死 C 的 `%.*f` 与 JS 的 `toFixed` 在舍入上怎么对齐）、`%x`/`%o`（要一个对 int64
**精确**的进制转换——现有的 `toString(radix)` 只挂在 real 上，大整数会丢精度）是同一类
问题：都要先做一个数值上的决定。那是下一刀，一起做。

**跑过的轴**：`tests/jnc`（10/0，`bad/printf-tail` 转成了 `cases/05-printf`）、
`tests/sexpr`（60 -> 61，新增 `27-write.sx`）。**没跑的**：`tests/asy` 全部、
`sweep.js`、`svg.js`、自举、`tests/jit`、`tests/mir`、`tests/llvm`——这一刀加的是一条
builtin 与一行 ABI，`tests/sexpr` 的五方一致把两者都走过了。

## 后果与代价

- 方言从"没有可算术的引用"变成"有"。这一格会渗到 MIR 与四个后端，改不回去。
- fat 指针三字内联：结构体里放指针就胖三倍。可接受——这一层没有 ABI 兼容负担。
- 两套实现意味着**两处都要验**。纪律靠"不许观测裸地址"这一条守住。
- 没有 oracle 意味着错了不会被自动抓住。纪律靠"每条期望都有出处"这一条守住。
