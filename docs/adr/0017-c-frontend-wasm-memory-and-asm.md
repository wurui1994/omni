# ADR-0017：C 前端（以 tinycc 为样板）、wasm 内存模型、自带汇编器与链接器

状态：设计中（jancy 那一路暂停，这一路接主线）

## 背景

这条管线已经有四门前端语法（omni / sx / asy / jnc / js），但没有 C。补 C 不是"再搬一门
语言"，它换来的是三件这条管线现在缺的东西：

1. **一个货真价实的 oracle。**asy 那条线之所以能把语义钉死，靠的是本机有 `asy` 可以逐记号
   比对；jancy 那条线没有 oracle，只能"每条都要有出处"。C 两样都有：tinycc 编得出来
   （本机已编过，见下面的量），`clang` 也在，同一份 `.c` 可以三方比对。
2. **一份别人定好的、极大的规格。**C 的语义边角（整型提升、位域、可变实参、`volatile`、
   序列点）是公开的、有海量语料的。这比自己发明方言的边角安全得多。
3. **一条不依赖 LLVM 的机器码出口。**tcc 的 `-run` 在内存里编完就跳进去。我们的 `run-jit`
   现在要 libLLVM（157MB）。tcc 那条路线证明：一个自带汇编器 + 链接器的后端可以只有几千行。

样板挑 tinycc 而不是 gcc/clang 的理由是**量级**：整份 68619 行（含四个 CPU 的后端与三种
目标文件格式），编出来 410KB，在本机 14 秒编完。这是一个人读得完、也搬得动的规模。

## 量出来的基线（M 系列 macOS，本机，clang 21 -O2 编出来的 tcc 0.9.28rc42）

tcc 的源码树在 `/Users/wurui/Documents/Lang/reference/tinycc`，构建在
`.omni-cache/tcc-build`（树外构建，参考树不动）。

- **编译吞吐**：`tcc -c tccgen.c`（9001 行）**0.03–0.05s** ≈ **200–300k 行/秒**；
  整份 libtcc 的 11 个 TU（约 30000 行）串起来 **0.57s**（含 11 次进程启动）
- **`tcc -run` 的启动**：hello world **11–16ms**（这就是"编译 + 内存里链接 + 跳进去"的全部）
- **生成代码的质量**：2000 万次 `s += 1.0/i` 的循环，`tcc -run` 全程 **0.113s**；
  同一份源码 `clang -O2` 编 0.33s、跑 **0.034s**。也就是 tcc 的码比 clang -O2 慢约 **3.3x**，
  而它的编译快约 **10x**。这两个数字就是这一路的档位：**编译要快到 tcc 那一档，
  生成代码只要求"不比 tcc 差"**。
- **我们现在的吞吐（对照）**：`emit-c src/core/cli.js`，47866 行 JS -> 214007 行 C，
  **1.91s** ≈ **25k 行/秒**。比 tcc 慢一个数量级 —— 差距在哪儿要按刀量，不先猜。

## 借什么、不借什么

**借**（出处逐条写在实现旁边，格式与 asy 那条线一样，`tcc 文件:行`）：

- **前端的形状**：`tccpp.c`（3961 行，预处理 + 词法，token 流 + TokenSym 哈希表）、
  `tccgen.c`（9001 行，**一遍过、没有 AST**、值栈 `vtop` 上直接发码）
- **后端的接口**：`arm64-gen.c` / `x86_64-gen.c` 那 26 个入口 —— `load` / `store` /
  `gen_opi` / `gen_opl` / `gen_opf` / `gen_cvt_*` / `gfunc_call` / `gfunc_prolog` /
  `gfunc_epilog` / `gfunc_sret` / `gen_va_start` / `gen_va_arg` / `gjmp` / `gjmp_cond` /
  `gjmp_append` / `gsym_addr` / `ggoto` / `gen_vla_*` / `gen_fill_nops` / `o`。
  这张表就是"一个 CPU 后端要交付什么"的完整清单
- **汇编器与链接器的分工**：`tccasm.c`（内联汇编）+ 每个 CPU 一份 `*-asm.c` +
  `tccelf.c` / `tccmacho.c` / `tccpe.c`（目标文件与链接）+ `tccrun.c`（内存里重定位并执行）
- **语料**：`tests/tests2/` 281 份、`tests/` 下的 abitest / asmtest / boundtest

**不借**：源码文本。tinycc 是 LGPL 2.1，逐字搬进这个仓库会让这个仓库变成派生作品。
所以纪律与 asy 那条线相同 ——

> **照着行为与结构重写，不抄代码。**每条规则在实现旁边注明 tcc 的文件与行号作为**出处**，
> 就像 asy 的每条语义都注着 `camp.y` 的行号。tcc 的二进制只当 oracle 用（跑它、比对它的
> 输出），不进产物、不进仓库。

这一条要用户点头之后才开工的部分：如果目标是"逐字节复刻 tcc 的实现"，那许可证结论会不同。
本文按"行为复刻、代码自写"来定所有分步。

## 决策一：两条解析路径，一套语义

`.c` 进来有两条路，**同一份输入必须产出逐字节相同的核心方言 / MIR**：

- **路径 A（GLR）**：`src/core/glr/` 加一份 C 的 grammar，走与 asy / jnc 相同的形状
  （grammar -> 解析树 -> `frontend-c/lower.js`）。它的价值是错误信息、编辑器、以后的
  重构工具 —— 一棵真的树在手上。
- **路径 B（tcc 忠实路径）**：`frontend-c/tccpp.js` + `frontend-c/tccgen.js`，**一遍过、
  不建树**：token 流进来，值栈上直接出 MIR。它的价值只有一个 —— **快**，以及"`tcc -run`
  这件事在架构上说得通"。

为什么两条都要，而不是只留一条：这两条各自证明一件不同的事。A 证"C 的语法能在这条管线的
通用机制里表达"，B 证"这条管线能达到 tcc 那一档的吞吐"。只留 A 就永远解释不了慢；只留 B
就没有树，工具链那一半全废。

**它们之间的一致性是一条测试轴**（`tests/c/` 的 `two-path` 组）：同一份 `.c`，A 与 B 出来的
MIR 逐字节相同。不相同就是 bug，不允许"两条路各有各的道理"。

一个必须现在就说清的边界：**C 的语法不是上下文无关的**（`(a)*b` 是乘法还是强制转换，取决于
`a` 是不是 typedef 名）。GLR 能吃歧义，但消歧要靠符号表 —— 路径 A 因此也需要一遍过的
typedef 表，这与 tcc 的做法（`tccgen.c` 的 `Sym` 链）是同一件事。**这不是可以绕开的**：
无论哪条路径，"名字是不是类型"都要在解析当时就知道。

## 决策二：C 的降级目标是 MIR，不是核心方言

其他四门语言的路子是 `语法 -> 核心方言(S 表达式文本) -> HIR/OIR -> MIR`。C **不走**这条：
`frontend-c` 直接发 MIR。三个理由，按重要性排：

1. **OIR 的值域不是 C 的值域。**OIR 只有一格 `int`（有符号 64 位）、一格 `real`（double），
   字符串是 UTF-8 值语义，聚合是句柄。C 有 `char/short/int/long/long long` × 有无符号、
   `float`、位域、union、真数组、真指针算术。把 C 塞进 OIR 要么撒谎（宽度丢了），要么
   给 OIR 加一整套只有 C 用的东西 —— 那等于在 OIR 里再实现一遍 MIR。
2. **MIR 已经有 C 需要的九成。**结构化控制流（`BLOCK`/`LOOP`/`IF`/`BR`，而且
   **`BR` 的层数语义与 wasm 逐条相同** —— `mir/ir.js:129`）、`i64`/`f64`、无符号那七条
   （`UDIV`/`UMOD`/`USHR`/`ULT`/`UGE`/`ULE`/`UGT`）、胖瘦两种指针加按字节步长的
   `PLOAD`/`PSTORE`/`PADD`/`PSUB`（ADR-0016）。
3. **吞吐。**tcc 的 200k 行/秒来自"一遍过、不建中间结构"。中间多一层 S 表达式文本
   （现在 asy 那一路 44 行源码就生成 817594 字节的方言文本）就不可能到那一档。

代价写在明处：**C 与另外四门语言的共同点只到 MIR 为止**。`.c` 与 `.asy` 不能互相 import；
要互操作走的是既有的 extern-C FFI（ADR-0014 决策 4），不是共享 OIR。

## 决策三：MIR 要长出的五格

现在的 MIR 差这些（`src/core/mir/ir.js`）：

1. **`T_I32` 与 `T_F32`。**类型码只用到 10（`T_TPTR`），低 5 位还有 21 个空位，加两个码不动
   任何位布局。为什么不沿用 WAT 前端那招"i32 存成符号扩展的 i64、每次运算后 `<<32 >>32`"
   （`frontend-wat/lower.js:61`）：那招在 wasm 那个小子集里够用，但 C 里**每一个 `int`
   运算都要回绕**，等于给每条算术加两条指令 —— 直接把吞吐和码质量一起赔掉。`float` 更没得
   商量：`float` 的舍入与 `double` 不同，用 double 冒充会在 tcc / clang 的三方比对里当场露馅。
2. **线性内存。**一块按字节寻址的连续内存，加 `MSIZE` / `MGROW` / 带宽度与符号的
   `MLOAD` / `MSTORE`（见决策四）。
3. **`BRTABLE`。**C 的 `switch`（以及 wasm 的 `br_table`）现在只能降成一串 `BRIF` ——
   O(n) 的比较链。密集 case 要跳表。
4. **`ADDR`（取局部量的地址）。**C 的 `&local` 现在无法表达：MIR 的局部量是槽位
   （`LOAD`/`STORE` + 槽号），没有地址。这是整件事里唯一动到 MIR 根基的一格，见决策四的影子栈。
5. **按位宽的截断/扩展。**`CVT` 现在只有几种模式，C 需要
   `i8/i16/i32 <-> i64` 的有符号与无符号八种，加 `f32 <-> f64`、`f32 <-> 整数`。

这五格加完，MIR 就同时是"C 的目标"和"wasm 的目标" —— 这不是巧合，见下一节。

## 决策四：wasm 标准内存模型，MIR 与 sx 都补上

**形状**（照 wasm 规范，不自创）：

- **一块线性内存**，按字节寻址，长度是 64KB 页的整数倍，`MGROW` 只增不减，
  失败返回 −1（wasm 的约定，不是抛错）。地址 0 是合法字节，但**约定不用** ——
  C 的空指针要能与它区分，所以第 0 页整页保留（tcc 在 `-b` 边界检查模式下也是这么做的）。
- **load/store 带四格属性**：宽度（8/16/32/64）、符号（`_s`/`_u`，只对小于宽度的整数有意义）、
  静态偏移、对齐提示。`i32.load8_s` / `i64.load32_u` 这一族因此不是几十条 op，而是
  `MLOAD` 一条 + aux 里的四格描述符。
- **data 段**：模块级的初始字节，编译期算好，运行期一次 memcpy 进内存。C 的 `.data` /
  字符串字面量落在这里。
- **影子栈**：C 的局部量只要**被取过地址**就搬进线性内存（一个 `SP` 全局，进函数减、
  出函数加）；没被取过地址的留在 MIR 槽位里当寄存器用。这是 wasm 工具链的标准做法，
  也是决策三第 4 格的答案 —— `ADDR` 只对"已经搬进影子栈的局部量"有定义，于是
  `&local` 就是 `SP + 常量偏移`，不需要给 MIR 引入"槽位的地址"这种概念。

**两套实现，一套语义**（与 ADR-0016 的指针同一条路数）：

- **JS / 两个解释器**：一个 `ArrayBuffer` + `DataView`，字节序**固定小端**（不跟宿主走）。
- **C / LLVM / 自带后端**：一块 `malloc` 出来的字节，指针就是真地址。

于是既有的 `T_PTR`/`T_TPTR` 与线性内存是**同一件事的两种视角**：模拟实现里 fat 指针的
`addr` 本来就是 arena 的字节偏移（ADR-0016 决策二），把 arena 换成"线性内存"就直接对上了。
这一格补完，`sx` 也跟着能写内存操作 —— 那是既有测试轴的入口（`tests/sexpr/` 五条腿逐字节比对），
C 前端的内存语义因此在 C 前端写完之前就能被钉住。

## 决策五：C -> wasm -> MIR 能不能无损？—— 语义能，结构不能，所以别走这条路

用户问的是这个，先给结论，再给理由。

**能无损的部分：**

- **控制流**。MIR 的区域标记与 `BR` 层数语义**本来就是照 wasm 抄的**（`mir/ir.js:129-138`
  写着"与 wasm 逐条相同"）。`block`/`loop`/`if`/`br`/`br_if`/`br_table` 一对一落到
  `BLOCK`/`LOOP`/`IF`/`BR`/`BRIF`/`BRTABLE`（后者是决策三要加的）。这一格是真正的双向无损。
- **值运算**。wasm 的 i32/i64/f32/f64 与它们的算术、比较、无符号变体、截断扩展转换，
  补完决策三的五格之后与 MIR 一对一。
- **内存**。补完决策四就是同一个模型。
- **函数与直接调用**。一对一。

**不能无损的部分（三条，都是硬的）：**

1. **不可归约的控制流回不来。**C 的 `goto`（跳进循环体、Duff's device、状态机里的
   计算跳转）在 wasm 里只能降成"一个 `loop` + 一个 `br_table` 派发器 + 一个状态变量"。
   这在语义上等价，但**原来的 CFG 形状永远回不来**了。从 wasm 读回 MIR 得到的是那个
   派发循环，不是原来的图。往 LLVM 递的时候，这意味着把一堆本来是自然循环的东西
   变成了不可归约的图 —— LLVM 的循环优化会当场失效。
2. **局部量的地址一旦进了线性内存就再也认不出来。**C 的 `int x; f(&x);` 在 wasm 里是
   影子栈上的一段字节。回读 MIR 时，它是内存读写，不是槽位 —— 也就是把"这是一个局部量"
   这条信息永久丢掉了。LLVM 那边本来能靠 `alloca` + mem2reg 把它提回寄存器，
   过一趟 wasm 之后 mem2reg 面对的是"一大块共享内存里的偏移"，提不动。
3. **C 里有一族东西 wasm 根本表达不了**：`setjmp`/`longjmp`（tcc 支持）、内联汇编、
   真正的函数指针比较（wasm 里是表下标）、`volatile` 的访存顺序保证、可变实参的 ABI。
   每一条都要靠约定编码进去，而"约定"就是损失。

**所以架构是这样，不是那样：**

```
                 ┌-> MIR -> {JS, C, LLVM, 自带 arm64/x86_64 后端}
.c -> frontend-c ┘
                       MIR -> backend-wasm  (出口：给浏览器/wasmtime)
                       MIR <- frontend-wasm (入口：读别人的 .wasm/.wat)
```

C **直发 MIR**；wasm 是 MIR 的一个**出口**和一个**入口**，不是 C 通往 MIR 的中转站。
「方便地接 LLVM」这个目的由 `MIR -> LLVM`（已经有了）直接满足，不需要绕 wasm。

**而"无损"这件事仍然要被钉住 —— 用往返测试**：`.wat -> MIR -> .wasm -> MIR` 两次的 MIR
逐字节相同（`tests/wasm/` 的 `roundtrip` 组）。这条轴管的是"我们发的 wasm 与我们读的 wasm
是同一套理解"，而不是"任意 C 程序过一趟 wasm 不掉东西"—— 后者按上面三条，做不到。

## 决策六：自带汇编器与链接器，`tcc -run` 那条腿不依赖 LLVM

三层，从下往上：

1. **指令编码器**（`src/core/backend-native/arm64/encode.js`、`x86_64/encode.js`）。
   纯函数：指令 + 操作数 -> 字节。这一层是可以逐条对着 `llvm-mc` 反汇编验的 —— 每条编码
   一个用例，`llvm-mc -disassemble` 印出来的文本就是期望值。**这是整件事里最枯燥也最容易
   做对的一层，先做它。**
2. **代码生成器**（`backend-native/arm64/gen.js`、`x86_64/gen.js`）。实现 tcc 那 26 个入口
   的等价物，输入是 MIR，输出是"一段字节 + 一张重定位表 + 一张符号表"。寄存器分配照 tcc
   的路数：**没有真正的分配器**，值栈上的东西按需 `load`/`store`，只有少数几个寄存器
   （tcc 的 `RC_INT`/`RC_FLOAT` 类）参与。这是它快的根本原因，也是它的码比 clang 慢 3.3x
   的根本原因 —— 两件事同源，不要试图两头都要。
3. **链接与执行**：
   - `link/macho.js`、`link/elf.js`：写出真正的可执行文件（先 Mach-O arm64，本机能跑的那个）
   - `run/inmem.js`：不写文件 —— 申请可执行内存、把段拷进去、按重定位表填地址、
     `mprotect` 成 RX、跳进去。这就是 `tcc -run`（`tccrun.c`），也是我们的
     `omni run x.c` 在没有 cc 的机器上唯一需要的东西。macOS arm64 上还要处理 codesign
     的 W^X 限制（`MAP_JIT` + `pthread_jit_write_protect_np`）—— tcc 自己在
     `tccrun.c` 里就有这一段，出处照抄，代码自写。

**内联汇编**（`asm("...")`）也要，因为 tcc 的语料里有，而且"不回避任何特性"是这一路的前提。
它是一个独立的小汇编器（tcc 的 `*-asm.c` + `tccasm.c`），只做 arm64 与 x86_64 两份，
其余（arm、riscv64、i386、c67）**留着不做** —— 目录留位置，报"阶段边界"。

## 决策七：oracle 与测试轴

`tests/c/`，四种比对，全部逐字节：

1. **三方输出比对**：我们的 `run` / `run-c` / `run-llvm` / `run-native`（新）/ 两个解释器
   × 同一份 `.c`，与 `tcc -run` 和 `clang -O0` 的输出比。这是主轴。
2. **两条解析路径比对**（决策一）：GLR 路径与 tcc 路径出来的 MIR 相同。
3. **wasm 往返**（决策五）。
4. **指令编码比对**：我们编出来的字节 vs `llvm-mc -disassemble`。

语料按三档进：
- 自写的小例子（每条语义一个，注明出处），走"先立规矩"的路子
- tcc 的 `tests/tests2/` 281 份 —— 这批是**行为语料**，期望输出 tcc 自己带着
- `tests/abitest.c`（C ABI 的边角）与 `boundtest.c`（越界检查），这两份是硬骨头，最后进

**边界要明说、要报错，不许猜**（asy 那条线的纪律）：还没做的特性一律"阶段边界"报错，
不许静默降级。第一阶段的边界清单会写在 `frontend-c/README` 里，并且每一条对应一个
`boundary/declared` 用例 —— 与 llvm/jit 那两条轴现在的做法一样。

## 性能目标（对齐 tcc 的档位，逐刀量）

- **编译吞吐**：路径 B 在 `tccgen.c` 那种规模（9001 行）上 **< 0.5s**（tcc 是 0.03–0.05s；
  我们跑在 node/自举出来的二进制上，差 10x 是可接受的第一档，第二档再谈)
- **`run` 的端到端**：hello world 在原生构建上 **< 100ms**（tcc 是 11ms）
- **生成码**：那个 2000 万次循环，自带后端 **< 0.5s**（tcc 是 0.113s，clang -O2 是 0.034s）
- 每一刀都把这三个数字量一遍写进 ADR，不许"感觉快了"

## 分步

前四步是**打地基**，不碰 C 的语法 —— 它们各自都能被既有的测试轴钉住，所以先做：

1. **MIR 加 `T_I32` / `T_F32`** 与那八种截断扩展。五个消费者（JS、C、LLVM、闭包解释器、
   MIR 打印）各跟一遍，`tests/mir` 与 `tests/sexpr` 加用例。
2. **MIR 加线性内存**（`MSIZE`/`MGROW`/`MLOAD`/`MSTORE` + data 段），两套实现
   （ArrayBuffer / malloc），`tests/sexpr` 五条腿逐字节比对。**sx 同时长出这套语法** ——
   用户明说要的"sx 补 wasm 内存模型"就是这一步。
3. **MIR 加 `BRTABLE` 与 `ADDR` + 影子栈约定**。
4. **WAT 前端扩到"内存 + 表 + 全局量 + `br_table` + 平铺栈式写法"**，并加
   `backend-wasm`（发 `.wasm` 二进制）与往返测试。这一步之后 wasm 那半边就完整了。
   **前半（内存 + 全局量）已落地**，见下面的落地节；后半的三格（表与 `call_indirect`、
   `br_table`、平铺栈式）卡在同一处 —— OIR 没有带标签的跳转也没有函数表，
   要接第三刀的 `BRTABLE` 就得让 WAT **直接降到 MIR**，那是一条独立的路径。

中间四步是 **C 前端**：

5. **`tccpp` 的等价物**：词法 + 预处理（`#include`/`#define`（含函数式宏与 `##`/`#`）/
   条件编译/`#pragma`），token 流形状照 tcc（`tccpp.c` 出处逐条注）。单测：把 tcc 的
   `-E` 输出当 oracle。**已落地**，见下面的第五刀节。
6. **路径 B 的一遍过降级器**：声明、类型、表达式（值栈 `vtop` 的等价物）、语句、
   初始化器、位域、可变实参。这是最大的一块（tcc 那边 9001 行），要拆成十来刀。
   **前二十五片已落地**（第一片 `int`/`void` + 表达式 + 语句 + 自定义函数；第二片整型的宽度
   与符号；第三片指针/数组/影子栈/字符串字面量；第四片全局量/`typedef`/`extern`；
   第五片外部符号/变参/libc shim —— oracle 从这一片起是**退出码加 stdout 逐字节**；
   第六片 struct/union/enum 与成员访问；第七片位域；第八片聚合初始化器；第九片 `switch`；
   第十片 `goto` 与语句标签；第十一片 struct 的传值与返回；第十二片带括号的声明符；
   第十三片函数指针 —— MIR 为它加了 `CALLI`；第十四片浮点 —— printf 的 `%f/%e/%g`
   也进了逐字节对账；第十五片堆 —— `malloc` 一族，簿记全在线性内存上；第十六片变参函数的
   定义 —— 签名定死成「固定形参 + 一个变参区指针」；第十七片 `exit` —— 宿主抛一个信号，
   不进 MIR 的控制流；第十八片嵌套聚合省掉里层花括号 —— 一个下降栈换掉两份遍历；
   第十九片函数类型的 typedef 与变参的间接调用 —— 两条边界原来只是保守；
   第二十片 `long double` —— 在这个目标上它就是 double；第二十一片常量表达式里的浮点
   与 printf 的 `%a` —— 两个求值器合成一份；第二十二片变参里的 struct —— 变参区从
   「一格 8 字节」变成「一格按大小」；第二十三片指定初始化器串起来 —— 长度那一遍也改用
   同一个下降栈；第二十四片 `goto` 跳到哪儿都行 —— 每个块一台状态机换成函数一台
   加一条分派链；第二十五片语句标签长在 `switch` 里 —— case 的段界与标签的段界摆在
   同一串嵌套 `BLOCK` 上），
   见下面的落地节；那几节里也写了剩下几片的顺序与理由。
7. **路径 A 的 GLR grammar + lower**，与路径 B 比对。
8. **C 的库面**：`libtcc1` 的等价物（软除法/浮点辅助/`alloca`/`setjmp`）与 libc 的接法。
   原先写的是"先转手宿主的 libc，走既有的 extern-C FFI"，第五片证明**转手不成立**
   （指针是自家线性内存里的偏移，宿主 libc 读不到），改成一个读写线性内存的宿主模块，
   见第五片的落地节。**前六十三片已落地**（预定义的宏 —— 目标的自述，五十条，
   顺序与值都对着 `tcc -dM -E` 抄；自带的系统头目录 + 编译器必须自己给的那四份头；
   `stdio.h`/`stdlib.h`/`string.h` 的最小子集 —— libc 的自述；
   `strtol` 一族与 `strncpy`/`strchr`/`strstr` 那几条；
   `qsort`/`bsearch` —— libc 回头调 MIR 的那扇门；`vprintf` 一族；`<ctype.h>`；
   `<errno.h>` —— data 段里一格 + `__omni_errno_location`；三条标准流与 `fprintf`；
   真的文件 —— `fopen`/`fread`/`fgets`/`fseek`，整份快照；
   `int main(int argc, char **argv)` —— argv 住 data 段；
   stdout 是字节不是字符 —— C 那条腿自己一扇门；
   `strerror` / `perror` —— 一张量出来的表 + 一号一格；
   `sscanf` / `vsscanf` / `fscanf` —— cFormat 的反向；
   Duff's device —— 里层的 case 就是一个没有名字的标签；
   真的 macOS 系统头 —— 预定义的宏本来就是两份，而没引用的声明不发桩；
   SDK 的三条标准流 —— 宿主填的全局量；
   编 tinycc 自己的源码撞出来的六格 —— `__has_include`、`#pragma pack`、
   `_Static_assert`、匿名 struct/union 成员、常量表达式里的 `?:`、顶层多余的分号；
   诊断逐字节对齐 + `__asm__` 当语句 —— 行号那条减法、`pp_error` 的记号流、
   收起来的记号串带着行号；
   **tinycc 自己那一整份源码编过了** —— `__func__`、常量表达式里的 `sizeof 表达式`、
   转换的常量折叠（于是 `offsetof` 是常量）、`inline` 的体等被引用才发、
   `__builtin_expect`；
   **预处理那一路也与 `tcc -E -P` 逐字节相同** —— `#ifdef __has_include` 也算真；
   **编出来的 tinycc 真的在预处理文件了** —— `getenv`、fd 那一层
   （`open`/`read`/`write`/`lseek`/`close`/`unlink`，与 `fopen` 共用同一张快照表）、
   dispatch 的信号量、以及 `setjmp`/`longjmp` —— 后者在**解释器**这一层做：
   一帧一个 pc 循环，所以「回到某一帧的某条指令之后」是可表达的；
   **编出来的 tinycc 在预处理 tinycc 自己那一整份源码了**，与本机 tcc 逐字节相同 ——
   位域的**访问类型**（`adjust_bf`：声明的类型装不下时另挑一个，符号性看声明的、
   宽度看访问的），以及别在命令行上替它回答目标配置那件事；
   **编出来的 tinycc 在产可执行文件了**，与本机 tcc 产的逐字节相同 ——
   `open` 的第三个实参是变参、`fdopen` 几乎是空操作、`system` 回 `wait(2)` 的编码
   且不冲调用方的 stdio、`errno` 的第三个名字 `__error`、`dlopen` 回 NULL 是真话；
   **自举到不动点** —— 编出来的 tinycc 编它自己，产出的 `tcc2` 与本机 tcc 编的
   逐字节相同，`tcc2` 再编一遍自己也一样（`strtod` 一族 + 十六进制浮点是最后一格）；
   **换一把尺子** —— 编出来的 tinycc 编 tinycc 自己那份 `tests/tcctest.c`，产物与
   输出都相同（`ldexp` 要分步缩放，否则次正规数成 0；tag 与枚举常量**分作用域** ——
   函数体走两遍，不分层第二遍必报重复，而作用域栈进出还得成对）；
   **K&R 的函数定义** —— 省掉的 int、标识符表、`{` 之前那串形参声明（老式形参里的
   float 就是 double；老式函数不核对实参个数）；
   **花括号裹着的字符串**与**字符串字面量的下标** —— 并完相邻的字面量再看下一格才知道
   是哪一种，不定长数组还要先按 strlen + 1 定大小；
   **范围指定初始化器** `[0 ... 3] =` —— 复制的是**字节**而不是把初始化式再放一遍，
   所以里头的函数只叫一次；静态那一侧只挪落在这一格里的那几条；
   **宽字符常量与宽字符串** `L'a'` / `L"ab"` —— 一格是一个 `wchar_t`（这个目标上是
   带符号的 int），`\u`/`\U` 在窄串里按 UTF-8 铺、在宽串里就是那个值；
   **标签当值与计算跳转** `&&label` / `goto *p` —— 状态机那一套摆好了之后它就是
   「编号当地址」，顺手把「typedef 名后面跟 `:` 是标签」也补上；
   **typedef 名是普通标识符** —— 它跟变量分同一套作用域、能被同名的变量遮住；
   **长度 0 的数组** —— `double a[0]` 是 size 0 / align 8，「不完整」不能再拿 size 是 0
   当替身；
   **`aligned(N)` 与 `packed`** —— 属性从「整块跳过」变成真的分派，而尾置的 `packed`
   逼出了「收成员」与「排布局」分段；挂在变量上的那一份也做了，不然它是条静悄悄给
   错答案的边界；
   **`__alignof__`** —— 与 `sizeof` 同一支，只是问符号时回的是符号那一份对齐；
   **省掉中间那一项的 `? :`** —— `x ? : y` 里 x 只求值一次，所以先落进一个槽；
   **`switch` 的体不是花括号** —— 收记号的时候替它补一对，下游一个字不用改；
   **语句表达式 `({ … })`** —— 复合语句照原样交给 `stmt`，只在 `exprStmt` 里把最后
   那条的值留下；里面带语句标签的那一种钉住报错；
   **试探性定义** —— 同名的多条全局声明合并成一条，数组长度谁写了算谁的，
   「划 data 段」从声明那一步挪到「长度定下来」那一步；
   **复合字面量 `(T){…}`** —— 与声明一个带初始化式的变量同一段代码，只差没有名字；
   常量一路上分标量/聚合/同类型三种，只有地址被取到的那一种才真的划地方；
   **不定长数组配指定初始化器** —— 数格子那一遍改成放一遍记号、走真的分析器，
   与真的铺那一遍共用同一套规则；
   **转成数组类型就是去掉数组那一层** —— 抄 tcc 的 `gen_cast` 抹掉 VT_ARRAY 位那一句，
   `char f()[] { return 0; }` 于是通了；
   **柔性数组成员** —— 占 0 个字节、照样抬对齐，三种写法的 sizeof 都对上了；
   **常量表达式里 `||`/`&&`/`? :` 也短路** —— 没求值的那一段里除以零不算错；
   **静态位域的初始化式** —— 按位并进同一条 data 记录，与运行期那一路共用同一组取位量；
   **文件作用域的 `extern int x = 1;`** —— 带初始化式就是定义，块里那一种照 tcc 报
   `';' expected`；
   **`case 1 ... 5:`** —— 标签从一个值变成一个闭区间，稀疏那一路上一个区间一次比较；
   **指针的静态初始化式是地址常量** —— 借表达式一路解析，`genPtrOp` 与 `addrOf`
   把「常量 + 常量」真的折起来，那就是我们这儿的重定位；
   **C99 的变长数组** —— 「多大」从类型里挪进一个槽，那块地方在 `$sp` 上切一刀，
   作用域退出与 `break`/`continue`/`goto` 各把它收回去；
   **形参上的变长数组** —— 那段记号挂在类型上，进函数、形参绑好之后再放一遍；
   **`typeof`** —— 与 `sizeof` 同一条「不求值只取类型」的路，在说明符里占 `tdef` 那一格；
   **`__label__`** —— 块局部标签声明，名字读掉；
   **语句表达式里带标签** —— 自己一份 `kids`、自己一台状态机，值落在槽上；
   **`__builtin_types_compatible_p`** —— 「什么算一样」合成 `compareTypes` 一处，
   `int f()` 归入 `FUNC_OLD`；
   **`? :` 两支里有指针** —— 空指针常量让位、指向 void 的优先、限定符并起来，
   到这一片 tcctest.c 整份编得过了；
   **实参里的宏不吃外面的记号流** —— 实参串以 TOK_EOF 收尾；
   **块作用域的 `static`** —— 东西在 data 段上、名字只在这一层，data 段里的键带函数名
   与「这个函数里的第几条」；
   **`printf` 的 `%C` / `%S`** —— 宽字符那两格等于 `%lc` / `%ls`，一个 `wchar_t` 摊成
   UTF-8 的字节，于是 tcctest.c 从第 66 行一路跑到第 843 行；
   **函数类型的 `sizeof` 是 1** —— 与 `char`/`void`/`_Bool` 同一格，不是指针的 8；
   **窄返回类型由调用方截一刀** —— tcc 的 PROMOTE_RET，`_Bool` 那一格按无符号 char 截；
   **枚举的底层整型** —— 全非负就是无符号、装不下就撑到 64 位，而枚举常量自己的类型
   装得进 int 就还是 int；
   **typedef 上的 `aligned(N)`** —— 属性跟着名字走，成员自己写的赢，而对齐是覆盖不是取大；
   **柔性数组成员配初始化式** —— `sizeof` 不变、划的地方变大，于是 tcctest.c 前 842 行
   与 tcc 逐字节相同；
   **`alloca`** —— 与变长数组同一刀，区别只在「什么时候还」），
   见下面的第八刀第一到六十三片节。

最后三步是**后端**：

9. **arm64 指令编码器**（对着 `llvm-mc` 验）——**前三片已落地**（第一批 96 条编码、第二批补齐逻辑立即数/位段/浮点/屏障、第三片是带标签回填与符号记账的指令缓冲），见下面的第九刀第一到三片节。
10. **arm64 代码生成器 + 内存里执行**（`omni run x.c` 在没有 cc 的机器上跑起来）——**前四片已落地**（整数与结构化控制流；调用与递归；浮点与它的调用约定；存取。每个值一个栈位；**native 这条腿上没有线性内存**，地址就是真指针 —— 线性内存只属于 wasm 与解释器那两条腿。用 `.incbin` + clang 链接后在真机上**跑起来**验的），见下面的第九刀第四到七片节。
11. **x86_64 同两步**——**两步都落地了**（`src/core/x64/`：编码器与缓冲对着 `llvm-mc` 验、`from_mir.js` 生成的代码在 Rosetta 上真跑过，见第九刀第十二到十六片节），然后 **Mach-O / ELF 写出**——**Mach-O 两种架构都写了**（`src/core/link/macho.js`），然后**内联汇编**——Mach-O 的目标文件写出**已落地前三片**（`MH_OBJECT`、`__TEXT,__text` 与 `__DATA,__data`、`BRANCH26`/`PAGE21`/`PAGEOFF12` 三种重定位；`CCALL` 落成 `bl <符号>`、模块级变量与字符串字面量落成 `adrp`/`add`，clang 能把我们的 `.o` 与 libc 链起来跑，C 那边也读得到我们定义的数据符号），**读入与并合也已落地**（`link.js`：`readObject` 读回自己写出去的东西、`linkObjects` 把几个 `.o` 并成一个并当场填掉跨文件的 `BRANCH26`），见下面的第九刀第八到十一片节。**ELF 目标文件写出也落地了**（第三十八片，
`src/core/link/elf.js`：`ET_REL`，节的次序与 `elf_output_obj` 的排布算式照
`tccelf.c`；tcc 的 `-c` 在所有目标上都写 ELF，所以这一份写出六个目标共用，
差别只在 `e_machine`、重定位号与符号名前那条下划线）。**读回来能原样写回去**（第四十一片，
六个目标 108 条逐字节相同），**并合与 `tcc -r` 也对上了字节**（第四十二片，
`src/core/link/elf_merge.js`，命令行 `omni elf-r`：六个目标 108 条逐字节相同 ——
输入是 tcc 自己出的 `.o`，所以这一步的对账不必等代码生成对齐）。**可执行文件从 PE 起手**
（第四十三片，`src/core/link/pe.js`：读一份 PE 映像再从 `pe_template` 写回去，两个
win32 目标 160 条逐字节相同 —— 三种可执行格式里只有 PE 没有代码签名、没有 dyld 那一摊，
而且在 macOS 上就链得出来）。**导入表也照原样重建了**（第四十四片：两个 win32 目标
160 条逐字节相同，320 个 dll、1990 个导入符号）。**异常展开表也重建了**（第四十五片：
`.pdata` 与 arm64 的 `.xdata`，160 条逐字节相同，1426 个函数）。**静态库也读得进来了**
（第四十六片，`src/core/link/ar.js`：成员、符号索引与「按需取用要转圈」那条规矩，
7 个库、65 个成员、825 条索引）。**「该读哪些字节」也与 tcc 一致了**（第四十七片，
`src/core/link/pe_load.js`：入口符号的挑法、要接哪几个库、`.def` 导入库与按需取用，
用 `tcc -vv` 打出来的那串 `-> 文件` / `   -> 成员` 当尺子，两个 win32 目标 160 条足迹
逐条相同，共拉出 242 个成员）。**节表也摆对了**（第四十八片，
`src/core/link/pe_sections.js`：按类重排、同类并节、导入桩把 `.text` 撑长、导入表接在
thunk 节后面、arm64 的 `.reloc`，160 张节表的虚拟地址、文件偏移、长度与节名逐条相同 ——
这一步与重定位无关，所以能单独对准）。**节里的字节也填对了**（第四十九片，
`src/core/link/pe_reloc.js` + `src/core/link/pe_link.js`：导入桩、符号地址、链接器自己
提供的那几个符号、所有重定位落笔，160 份节内容与 tcc 逐字节相同）。**整份 `.exe` 也与
tcc 逐字节相同了**（第五十片，`peWrite`：两个 win32 目标 160 份、853504 字节全同 ——
从 `.o` 到 `.exe` 这一整条路是我们自己的了，读库、按需取用、装 `.def`、并合、分类摆地址、
造导入表与导入桩、落重定位、算校验和、写文件；欠的是另一端，`.o` 里的字节还是 tcc 出的）。
**这条链子已经能把 tcc 自己链出来**（第五十二片，`tests/c/pe-tcc.js`：`tcc.c` 一份
`ONE_SOURCE` 的 `.o`，x86_64 400896 字节、arm64 476160 字节，与 tcc 自己链的逐字节相同）。
**换个格式也走通了**（第五十三片，`src/core/link/elf_exe.js`：Linux 的 ELF 可执行文件，
尺子是 `<target>-tcc -static -nostdlib -Wl,-e,main`，两个目标 20 份逐字节相同 —— 节的
两级排序、程序头、静态链接下照样要造的 `.got` 与 PT_GNU_RELRO 都在里面；命令行上是
`omni elf-link`）。**动态链接那一整套也对上了**（第五十四片：`.interp`、`.dynsym`/`.dynstr`
与两张哈希表、`.dynamic` 的十五条标签、`.rela.got`、`.eh_frame_hdr`，十六条节八个段头，
两个目标又是 20 份逐字节相同）。**第三个格式也补齐了**（第五十五片，
`src/core/link/macho_exe.js`：macOS 的 Mach-O 可执行文件，尺子是
`<target>-osx-tcc -nostdlib`，两个目标 22 份逐字节相同 —— 段套节、按用途归类的
`enum skind`、链式修正（`LC_DYLD_CHAINED_FIXUPS` 的 bind/rebase 链）、导出符号的前缀树
（`LC_DYLD_EXPORTS_TRIE`）、`__stubs` 桩子；arm64 那一份签完名能跑，命令行上是
`omni macho-link`）。三个格式于是都是我们自己写出来的了。**macOS 上也接上真的 libc 了**
（第五十六片：`.tbd` 里的导出符号、`LC_LOAD_DYLIB`、按需取用 `libtcc1.a`、当场生成的
`___GLOBAL_init_65535`，`tests/c/gen` 里那八十几份要 `printf` 的用例两个目标各 86 份
逐字节相同）。**macOS 上也把 tcc 自己链了出来**（第五十七片，`tests/c/macho-tcc.js`：
`ONE_SOURCE` 与拆开编的十二个 `.o` 两种都逐字节相同，arm64 那份签完名还拿它编了个 hello
跑起来）。**ELF 的 `.plt` 也补上了**（第五十八片：未定义的弱函数既取地址又调用 ——
两格 GOT、调用点改指 `name@plt`、静态那一路故意「没修完」的跳板、动态那一路的
`.rela.plt` 与 `DT_JMPREL` 四条标签外加现场编出来的 adrp/ldr/add/br，静态与动态
各 11 × 2 份逐字节相同）。**共享库也能造了**（第五十九片：ET_DYN、装载地址从 0 起、
没有 `.interp`、`export_global_syms` 把所有非局部符号端进 `.dynsym`、
`prepare_dynamic_rel` 把 `.rela.data` 里那几条改写成装载时的 RELATIVE，两个目标各
11 份逐字节相同；命令行上是 `omni elf-link --shared`）。**也能接着真的共享库链了**
（第六十片：读库的 `DT_SONAME` 与 `.dynsym`、函数走跳板、数据在自己的 `.bss` 里划一块
加一条 `R_*_COPY`、库里提到的名字反过来导出、`DT_NEEDED`，两个目标各 3 份逐字节相同；
命令行上是 `omni elf-link --dll libfoo.so`）。**`__thread` 也认了**（第六十一片：PT_TLS
那一段的起止穿到重定位里，x86_64 的 `TPOFF32` 相对整块的**末尾**算、arm64 的
`TLSLE_ADD_TPREL_HI12`/`LO12` 相对起点加 16 个字节的 `tcbhead_t` 算 —— tcc 只出
local-exec 这一种模型，静态、动态、共享库三道门各 12 × 2 份逐字节相同）。
**链接器那几个开关也认了**（第六十二片：`-pie`（`output_type` 里 EXE 与 DYN
两个位都在，摆放跟共享库同路、导出跟可执行文件同路）、`-rdynamic`、`-rpath`
（DT_RPATH / DT_RUNPATH）、`-soname`，五种开关各 12 × 2 份逐字节相同；
`-pie` 的尺子得另建一份 `CONFIG_TCC_PIE` 的交叉编译器 —— tcc 的命令行上那个
`-pie` 是个空壳）。**macOS 的 dylib 也出得来了**（第六十三片：MH_DYLIB、没有
`__PAGEZERO`（`__TEXT` 成了 0 号段、地址从 0 起）、`LC_ID_DYLIB`、不叫
`tcc_add_linker_symbols`、没定义的符号交给平坦查找，两个目标 15 与 90 份逐字节
相同；顺手补上 Mach-O 上的 `__thread` —— 那一路没有 PT_TLS，偏移是相对「0」与
「符号所在那一节的末尾」算的，算出来没用但字节照写）。
**Windows 的 dll 也出得来了**（第六十四片：映像基址换成 `IMAGE_BASE_DLL`、
`subsystem` 2、`CHARACTERISTICS_DLL`、`.reloc` 一定建（哪怕空着也要把
`RELOCS_STRIPPED` 抹掉）、thunk 节里接一张按 `strcmp` 排过的导出表（函数 RVA 那几格
靠 `R_XXX_RELATIVE` 落笔）、入口是 `libtcc1.a` 里 `dllcrt1.o` 的 `_dllstart`，两个目标
各 83 份逐字节相同；命令行上是 `omni pe-link --shared`）。三种格式的「共享库」于是
都齐了 —— 而 `tcc_add_linker_symbols` 在这三种格式上是三个答案：ELF 的 DLL 不叫、
Mach-O 的 dylib 不叫、PE 的 dll **照叫**（`pe_add_runtime` 在
`resolve_common_syms` 之前就把 `output_type` 改回 `EXE` 了）。
**Windows 上的 `__thread` 也认了**（第六十五片：`.tls` 那一节、thunk 节里那 40 字节的
`IMAGE_TLS_DIRECTORY`（四个指针靠 `REL_TYPE_DIRECT` 落笔，所以也要进 `.reloc`）、
`.data` 里那 32 字节的 `__tls_index`、数据目录 9，以及 arm64 上**不加** `tcbhead_t`
那 16 个字节 —— 三个格式于是三种 tp；顺手把 `elf-gen/` 那八份接进两道 PE 的门，
`pe-exe` 172 份、`pe-dll` 180 份逐字节相同）。
**PE 那一路的链接器开关也认了**（第六十六片：`--stack`、`-subsystem=`（`native`
那一种**两个对齐都变 0x20**、EFI 那三种映像基址变 0）、`--image-base`、
`--section-alignment` / `--file-alignment`、`--large-address-aware`、
`--nxcompat` / `--tsaware` / `--dynamicbase`、`-e`，十二种走法各 6 × 2 份逐字节
相同；头上那两格 `SectionAlignment` / `FileAlignment` **永远是模板里的
0x1000 / 0x200** —— `pe_write` 从来不把真用的对齐写回去）。
**Windows 上也能接着真的 `.dll` 链了**（第六十七片：`pe_load_file` 按开头是不是 `MZ`
认，`get_dllexports` 把数据目录 0 那张导出表的 `AddressOfNames` 读成一张 `.def`
（序号一律 0），库名取文件名的基名；导入表的次序还是符号表里谁先出现谁先来，与
导出表那个 `strcmp` 次序无关，两个目标各 2 份逐字节相同）。三种格式的「接着真的
共享库链」于是都齐了。
**资源那一节 `.rsrc` 也进得来了**（第六十八片：`windres -O coff` 那种文件是一份
**只有一节的 COFF**、没有魔数，`pe_load_res` 靠「机器号对得上、只有一节、名字正好是
`.rsrc`」认它；字节整块搬成一节 `.rsrc`、加一个同名的局部符号、COFF 那张重定位表整条
改挂成 `R_XXX_RELATIVE` —— 资源目录里 `OffsetToData` 那一格于是得到「原地那个节内偏移
+ 这一节的 RVA」，而 `RELATIVE` 不算 `REL_TYPE_DIRECT`，所以**不进** `.reloc`；六种
形状各 6 × 2 份逐字节相同，尺子自己拼，因为交叉环境里没有 windres）。
**PE 上的 `-g` 也认了**（第六十九片：Windows 上 tcc 的 `-g` 出的是 **stabs**；`.stab` 与
`.stabstr` 只在 `-g` 时装（那一条分支绕过 `sh_type` 的白名单，所以 `SHT_STRTAB` 的
`.stabstr` 也进得来）、`tccelf_new` 就给它们各放了一条全 0 的起手（12 与 1 字节）、
每份输入的 `n_strx` 要加上它 `.stabstr` 的起点、调试那一类从不并条，末尾再接一张 COFF
符号表（一条 18 字节，只收 `STB_GLOBAL`，`n_value` 是节内偏移、`n_scnum` 是节表里第几
条；长节名换成 `/<偏移>`，而 `snprintf` 只覆盖前几个字节，后面还是原名字剩下的）；
九种走法各 2 份逐字节相同。真正难的一格不是这些 —— 是**符号表里的次序**：
`tcc_add_linker_symbols` 那一批「表里没有也要建」，入口符号则是在「命令行上那几份装完、
库还没扫」的缝里加的，这两处以前都能偷懒，`-g` 一开就看得见了）。
**`-gdwarf` 也认了**（第七十片：`tcc_debug_new` 的另一支造十三节（其中七节永远空着，
只为了让 `R_DATA_32DW` 有地方落 —— 它们还全落在同一个地址上，因为「空节照样推地址」
碰上「已经对齐就不再推」）；两处例外都在问「目标节与符号所在的节是不是都在 `dwlo`
到 `dwhi` 里」：`relocate_section` 里那种要写**节内偏移**而不是绝对地址，
`pe_build_reloc` 里那种**不进** `.reloc`。`pe-debug` 那道门长到十七种走法、34 份逐字节
相同）。
**顺手写出的那份 `.def`**（第七十一片：`pe_build_exports` 是无条件调的 ——「导出表是 DLL
的东西」这个想当然一直挡着一条真路：带 `__declspec(dllexport)` 的 `.exe` 里一样有导出目录。
`.def` 本身只有三行 `fprintf`，难的是换扩展名那一步认的是**基名里最后一个点**
（`my.lib.dll` → `my.lib.def`），`LIBRARY` 后面写的是带扩展名的基名。8 种 × 2 个目标，
映像与 `.def` 都逐字节相同）。PE 那一路 tcc 自己会走的每条路于是都对上了。
**32 位那两个目标的 `.o`**（第七十二片：i386 与 arm 的目标文件是 ELF32 —— 不只是「短
一半」，`Elf32_Sym` 的字段次序不一样，`Elf32_Rel` 的 `r_info` 是「高 24 位符号号 + 低
8 位类型」而且**没有加数那一格**（加数写在被修的字节里），起手那几条节的对齐是
`PTR_SIZE` = 4，arm 还带 `e_flags`。顺带挖出来一格：arm 上 tcc **不造** `.eh_frame` ——
`tccdbg.c` 里那段 arm 的 CIE 是死代码。`elf-merge` 从六个目标长到十个，436 份逐字节
相同）。
**i386-win32 的映像**（第七十三片：PE32 的可选头短 16 字节，多一格 `BaseOfData` ——
那一格只认 `sec_data` 类，`.rdata` 不算。导入桩是 `ff 25 <绝对地址>`，而且 i386 上
`R_XXX_THUNKFIX` 就是 `REL_TYPE_DIRECT`，所以每个桩里那 4 字节还要进 `.reloc`。
最不显眼的一格是 `PE_STDSYM` 是**按目标**定的宏，不是按 `leading_underscore`：i386 的
DLL 入口是 `___dllstart@12`，削成 `__dllstart@12`，找错了名字连 `dllcrt1.o` 都拉不出来。
十一道 PE 门各长出第三个目标，全 0 条不同）。
**arm-wince**（第七十四片：桩是 12 字节的两条 `ldr`，subsystem 一律 9（连 DLL 也是），
`R_ARM_TLS_LE32` 比 x86 那两个多加 8。最贵的一格是 `REL_TYPE_DIRECT` —— 原先把 i386 与
arm 合在一起回 1，可 `R_ARM_ABS32` 是 2，`.reloc` 于是收了一批 `R_ARM_PC24` 的位置，
条数与偏移全不对。另外 arm 上谁都不引用 `__tls_index`，所以 tcc 的 COFF 符号表末尾多出
一条 —— `set_elf_sym` 的「有就改、没有就接在末尾」这一格只有 arm 撞得着。
`pe-tcc` 于是走到 **四个目标 × 两种编法、八份 tinycc 自己的 `.exe` 逐字节相同**：
tcc 在 Windows 上支持的目标，链接器这一层全对齐了）。
**32 位那两个 Linux 目标**（第七十五片：ELF32 的头 52 / 程序头 32 / 节头 40，
**`p_flags` 在程序头里挪到倒数第二格**；`Elf32_Sym` 换了字段次序，`Elf32_Rel` 没有
加数那一格（`r_info` 是 `符号 << 8 | 类型`，加数写进被改的字节里），`.dynamic` 一条
8 字节且换成 `DT_REL` 那一套，`.gnu.hash` 的 bloom 一格 4 字节、`bloom_shift` 是 5。
i386 的跳板 push 的是**字节**而不是条数，arm 的跳板要四条 `add`/`ldr` 才凑出一个地址。
三处只有 32 位才踩到的规矩：i386 的 `PCRELATIVE_DLLPLT` 是 0，于是造共享库时未定义
符号一格 GOT 都不给；`fill_local_got_entries` 在 REL 架构上要把值**写进 GOT 那一格**；
`.ARM.attributes` 只有可执行文件与共享库有（`elf_output_obj` 不叫那个函数），而且是
非 alloc 的节里唯一留得住 `sh_size` 的一条。五道 ELF 门各长出两个目标，全 0 条不同）。
**riscv64**（第七十六片：真正新的只有四处 —— `.eh_frame` 的 CIE **版本是 3**（五个
目标里只有它）、可执行文件头的 `e_flags` 要照 `.o` 抄（riscv 上是 4）、`relocate_plt`
是自己的八条指令（`create_plt_entry` 与 arm64 形状一样，一个字都不用改）、
`__global_pointer$` 落在 `.data + 0x800`。重定位那一层要紧的是 **hi/lo 成对**：
`PCREL_LO12` 那条的符号值就是 `PCREL_HI20` 那条的地址，得回头查 HI20 记下的值。
六道 ELF 门各长出第五个目标，全 0 条不同 —— tcc 支持的九个目标在链接器这一层
至此全部逐字节对齐）。

**真的 `.dylib` 能当输入了**（第七十七片）：在这以前 Mach-O 那一路只认 `.tbd` 那种
文本 stub（SDK 里的），自己 `-shared` 出来的库读不进去。补上 `macho_load_dll` 之后
dylib 对链接器就是**一张名字表**：`LC_ID_DYLIB` 给安装名（进 `LC_LOAD_DYLIB`），
`LC_SYMTAB` 配 `LC_DYSYMTAB` 的 `iextdefsym`/`nextdefsym` 圈出「它导出了什么」，
段的内容一眼都不看。`LC_REEXPORT_DYLIB` 顺着名字再开一份、往下钻一层，钻进来的那些
level 是 1 —— 只贡献名字，不发 `LC_LOAD_DYLIB`。胖二进制那一段也照抄了 tcc 的
**严格比**：它要求 x86_64 那片的 cpusubtype 正好是 `CPU_SUBTYPE_X86_ALL`，而 `lipo`
写的是 `CPU_SUBTYPE_X86_ALL | CPU_SUBTYPE_LIB64`，于是 tcc 自己就认不出胖文件里的
x86_64 —— 我们跟着认不出。门是 `tests/c/macho-dll.js`，`9 条`全 0 条不同。

**`LC_RPATH`**（第七十八片）：`-Wl,-rpath=` 攒起来的那一串按冒号切开，一段一条
（`rpath_command` 12 字节 + 路径，八字节对齐），排在 `LC_LOAD_DYLIB` 后面。
tcc 那段不在 EXE 的分支里，所以 dylib 也发。门涨到 `27 条`。

**macOS 上的 `-g`**（第七十九片）：stabs 与 dwarf 两路都对上了。要的是三件事 ——
调试那几节跟着并进来（`linkObjects` 的 `debug`/`dwarf`；macOS 上 `-gdwarf` 的默认版本
是 **2**，别的目标是 5，所以没有 `.debug_line_str`）、`collect_sections` 里 DWARF 的
六节各自一类落进 `__DWARF` 段、调试节里指向调试节的 `R_DATA_32DW` 写**节内偏移**。
从 `.o` 里读进来的 `.stab` tcc 是丢掉的（`sk_stab` 认的是本次编译造的那一节），
所以 stabs 那一路的产物里没有 `__stab`。门是 `tests/c/macho-debug.js`，`40 条`。

**PE 上那几个反过来的开关**（第八十片）：`link_option` 里带 `?` 的都能加 `--no-`，
清的位不一定是设的那几位 —— `?dynamicbase` 设 0x40 却清 **0x60**，`?high-entropy-va`
设 0x60 却只清 **0x20**。x86_64 默认值是 0 看不出来，arm64-win32 默认 0x8160，
四条各清出一个不同的值，清掉 0x40 的那一条还会让它丢掉 `.reloc`。写出的那一层
一个字没改就对上了，`tests/c/pe-flags.js` 从 `243 条`涨到 `390 条`。

**`-dM` / `-dD`：宏表自己也印出来**（第八十一片）：`-dD` 是 dflag 3、`-dM` 是 7，
`& 7` 开「边定义边印」，`& 4` 再把记号流那一半掐掉 —— 所以 `-dM` 的输出只有指令行。
印的次序就是**宏表的插入次序**，这把预定义那张表的次序也量出来了：`__TCC_PP__`
不在表尾，tcc 是在目标/OS 那一段之后（紧跟 `__unix`）就 `putdef` 的。
`#define` 的宏体里那些空格是真存进记号流的（`SPC`），加上 `pp_need_space`
补出来的分隔位，才能逐字节对上。门是 `tests/c/run.js` 里 `cpp/` 那八份文件
再各走一遍两个开关，`8 条` → `24 条`。

**行标**（第八十二片）：`tcc -E` 默认是要印 `# 行号 "文件"` 的，我们一直只对得上
`-E -P`（什么都不印那一路）。`pp_line` 四种走法一条不少：不印、**补几个换行**、
`#line`、`# 行号 "文件"` 带 ` 1`/` 2`。要紧的是第二支排在前面 —— 落后不到 8 行就补
换行而不是印一行行标，输出干净得多。`-P10` 那一路（数字一律解成常量再印回去，
Bellard 拿它让 tcc 编译自己）也通了。`cpp/` 与 `inc/` 两组各多了两三种走法，
`24 条` → `51 条`。

**`-M` 一族**（第八十三片）：给 make 的依赖清单。`#include` 成功时记一笔，印的时候
去重、空白加反斜杠、`-MP` 再给每个头补一条空规则。分「自己的头」与「系统的头」靠的是
**在搜索表第几格找到的**（`include_next_index`）—— 在 include 它的那份的目录里找到的
自己算不清，得顺着 `prev` 往上认祖先的身份。目标名是 basename 的后缀换成 `.o`。
`inc/` 那一份走四种（`-MM`/`-M` 各配 `-MP`），加 `gen/01-expr.c` 一条没有头的，
`51 条` → `56 条`。

**`#include_next` 与 `__has_include_next`**（第八十四片）：上一片记下的
「在第几格找到的」这一格，正好是这两条要的东西 —— 从**我自己那一格之后**接着数
（`i = file->include_next_index` 起步），于是「盖一层但还要用底下那一层」写得出来，
也不会又找回自己。两个阶段边界（`cpp-bad/include-next`、`cpp-bad/has-include-next`）
换成了 `inc/02-include-next.c` 这份真的用例，`inc/` 那一组从此有两个搜索目录。

**`-U` / `-isystem` / `-nostdinc`**（第八十五片）：`-D` 与 `-U` 在 tcc 那边写进**同一个
缓冲**，所以共用一条顺序 —— `-DX=1 -UX` 与 `-UX -DX=1` 不是一回事。`-isystem` 给的目录
排在自带那一份**前面**，`-nostdinc` 只掐掉自带的那一份。门里多了一支 `optCase`：
拿 `tcc -E -P <开关>` 当尺子比两边 CLI 的 stdout，八种走法。

**`-include`**（第八十六片）：`<command line>` 成了一个**真的 include 层** ——
`#include "…"` 那几行压在主文件上面，读完了才回到主文件。于是 `"..."` 那一格算的是
当前工作目录，依赖清单里也有它，`# 行号 "文件"` 那套进出层级的行标自动就对。

**`-v` / `-vv` / `-vvv`**（第八十七片）：头文件的开合印在**标准输出**上，与 `-E` 的正文
交织。三档不是一个开关而是**数出来的**（`do ++verbose; while (*optarg++ == 'v')`）：
1 只印命令行上那几个输入文件（`tcc.c:380`，开工之前），2 起每开一个文件印一行 `->`、
被守卫或 `#pragma once` 挡回去的印 `=>`（`tccpp.c:1398`），3 连试不开的那些路径也印 `nf`。
缩进是 **include 深度**，取的是压栈**之前**的值。这几行在 tcc 那边是 `next()` 里头印的，
所以排在这一个记号的行标**前面** —— 顺序也是尺子的一部分。

**真的系统头**（第八十八片）：系统头目录成了**两段** —— 自带的 `src/include`
（对着 tcc 的 `{B}/include`）在前，本机 SDK 的 `/usr/include` 在后。tcc 那一段是
configure 时用 `xcrun --show-sdk-path` 定死编进去的，我们没有 configure，于是第一次用
的时候找一次记下来。新的一组门 `sysinc/`：两边都**不给 `-I`**，各自去找
`<stdint.h>` / `<unistd.h>` / `<math.h>`，`-E -P` 与 `-M` 都逐字节相同（最长那份
五百多行正文、一百多条依赖）。**「先自带、后系统」这个顺序也是量出来的**：做尺子的
tcc 没装，它 `{B}` 那一格不存在、一路掉到 SDK 上；拿 `-B` 指一个 `include/` 真在的树，
它就跟我们一样先用自己那份。

**让位**（第八十九片）：自带的那五份 libc 头（`stdio.h`/`stdlib.h`/`string.h`/
`ctype.h`/`errno.h`，第八刀第三片的最小子集）**删了** —— 它们只会挡着 SDK 里的同名头。
留下的正是 tcc 也自带的那四份（`stddef.h`/`stdarg.h`/`stdbool.h`/`float.h`）。
删之前要补一件事：SDK 的 `<errno.h>` 里 `errno` 是 `(*__error())`，前端得认出这个名字
才会在版图上留那一格 —— 不认的话宿主只能临时去堆上要，而一个不用 `malloc` 的程序
连堆都没有。整个 `tests/c/`（206）与 native（217）在删掉之后全绿。
跟着成了死码的那几个（第九十片清掉）：`__omni_errno_location`、
`__omni_stdin/stdout/stderr`，以及 native 上给它们收口的 `NATIVE_CNAME`（改名）与
`streamThunk`（给函数名配一个读外部全局量的函数体）—— 头文件没了，这两条收口也就没了
用处，`__stdoutp`/`__error` 本来就是真 libc 里的名字，直接落过去。

**拿 tinycc 自己的源码当尺子**（第九十一片）：`tests/c/selfpp.js` —— tinycc 那 30 份
`.c`，两边各自去找头（只给 `-I <构建目录>`），`-E -P` 出来的字节必须一样。**29 份全同**，
剩下一份是 tcc 自己就拒的旧文件（`il-gen.c`），加起来约 23 万行展开后的正文。
为此把 `src/include/stddef.h` 对着 tcc 那一份逐行对齐了 —— 头文件的内容直接就是
输出的一部分：typedef 的条数与次序、`offsetof` 展开成 `__builtin_offsetof` 还是就地
展开、那句 `void *alloca(size_t size);` 在不在，都在输出里看得见。

**编出一个 tcc，让它去编 tinycc**（第九十二片）：tinycc 的十二份源码（arm64-osx 那一套）
用 `omni c-obj` 各编成一个 `.o`，`clang` 链成 `omni-tcc`，跑得起来；它 `-c` 编
`tests/c/gen/` 那 83 份、以及**tinycc 自己那十二份源码**，出来的目标文件与尺子 tcc
的**逐字节相同**（`tests/c/selfobj.js`，16 条）。为此还的账是**局部符号**：串常量
（`omni_str_0`）、匿名静态块（`$cl$0`）、`static` 的函数与全局、外部函数的转发桩
（`$ext$printf`）、以及 `inline` 的函数 —— 这些名字每个翻译单元里都有一份，当外部符号
发的话十二个 `.o` 一链就是 1402 条 `duplicate symbol`。`inline` 那一格是量出来的：
tcc 判的是 `sym->type.t & (VT_STATIC | VT_INLINE)`（`tccgen.c:478`），而 macOS 的
`__header_inline` 对我们展成光秃秃的 `inline`（`sys/cdefs.h:375`），`__sputc` 身上
没有 `static`。Mach-O 的符号表因此按局部/外部定义/未定义**三段**摆，`LC_DYSYMTAB`
的三对下标跟着走。ELF 那一侧不用改：`link/elf.js` 的 `buildSyms` 本来就按 `d.local`
分段（第三十八片建的时候就照 tcc 的 `sort_syms` 办了），两个写出器同一份入参。

**连 clang 也换掉**（第九十三片）：上一片那个 `omni-tcc` 是 `clang` 链的。这一片把
链接那一步也换成自己的 —— `c-obj --format elf` 出 tcc 那种 `ET_REL`，`macho-link`
（`link/macho_exe.js`，第五十几片建的那套「读 ELF、写 `MH_EXECUTE`」）把十二份读回来
链成一个 2.2 MB 的可执行文件。它跑得起来（不用 `codesign`），编 `tests/c/gen/` 那 83 份
与 tinycc 自己那 12 份，出来的目标文件与尺子 tcc **逐字节相同**。从源码到能跑的 tcc，
整条链上除了 SDK 的头与那份 `libc.tbd`（只从里头读符号名），没有别人的东西。

**换一副架构**（第九十四片）：同一份源码编成 **x86_64** 的 tcc，在 Rosetta 上跑，
`-c` 编 `tests/c/gen/` 那 83 份，**81 份**与交叉尺子（`x86_64-osx-tcc`）逐字节相同。
挡在门口的是 `u64 -> 浮点`：`cvtsi2sd` 认有符号，v >= 2^63 会算成负数，所以分两路 ——
第二路 `(v >> 1) | (v & 1)` 之后转、再自己加自己，那个 `or` 是把右移丢掉的最低位接回来
当粘位，于是也是正确舍入的（tcc 那边这件事交给 `__floatundidf`，我们不带 libtcc1，
就地发指令；尺子是 clang）。差的两份是 `long double`：x86_64 上它是 x87 的 80 位、
占 16 字节，我们还当 8 字节的 double。

**浮点 -> 无符号整数**（第九十五片）：MIR 多一条 `CVT_F2U`。原来无符号目标与有符号
共用 `CVT_F2I`，而硬件那两条转有符号的指令（`fcvtzs` / `cvttsd2si`）越界时是**饱和**
不是回绕 —— `(unsigned)3000000000.0` 给 `0x7fffffff`、`(unsigned long long)2^63` 给
`0x7fff…`，四个探针四个错，tcc 自己的常量折叠里就有这种转换。arm64 落成 `fcvtzu`；
x86 分两路（`d >= 2^63` 时先减掉 2^63 再转、再把第 63 位置回去，减法是精确的）。
32 位及以下的无符号目标先转 i64 再截 —— 直接按 32 位转同样会饱和。

**十二副交叉编译器**（第九十六片）：把上面那件事按 tinycc `Makefile` 里的十二个目标各做一遍 ——
每个目标一套源码与一串 `-DTCC_TARGET_…`，我们编出 `<target>-tcc`，用四个不带头文件的探针
（整数算术、浮点、结构体、控制流）与 `.omni-cache/tcc-cross/<target>-tcc` 逐字节比。
十一副相同。这里要留两把尺子：`.omni-cache/tcc-cross/` 里那些是**另一次**建出来的
（版本行的 git 戳 `main@4fb21a4`，源码树在 `mob@2ba12e83`），所以一有差别先用 `clang`
按同一份源码与同一串宏建一副基线，只有连那个也不同才算我们的账。顺手量到的一件事：
`tcctools.c` 不是翻译单元，`tcc.c` 把它 `#include` 进去，单独编会撞 `_tcc_tool_ar`。
剩下的一副是 **c67**，账最后不在我们身上，见下面第九十七片那一段。

**那一位差在哪**（第九十七片）：c67 那副的差别是**被编的那份程序自己踩了未定义行为**。
把 `c67-gen.c` 里那句 `/* #define ASSEMBLY_LISTING_C67 */` 用 `-D` 打开，两副 tcc
各写一份指令清单，一 `diff` 就落到一行上：`MVKL. 0 105 0` 对 `MVKL. 2 105 0` ——
差的不是寻址模式那四位（第九十六片记错了），是那条 `MVKL` 的**立即数**（`(a & 0xffff) << 7`，
0 与 2 差出 0x100）。往上追是 `c67-gen.c:1592-1605`：`load()` 见到 `fc > 0`（tcc 以为
这是栈上的参数）就在 `TranslateStackToReg` 上找那个偏移属于第几个参数，而 `stack_pos`
一次加整个参数的大小，所以一个**跨两个字**的参数只有第一个字对得上；第二个字找不到，
循环走满，`t == NoCallArgsPassedOnStack`（10），紧接着那句 `fc = ParamLocOnStack[t] - 8;`
读的是 `int[10]` 的第 11 格 —— 越界。往那句上插一行 `fprintf` 量过：两副 tcc 都是
`fc=12 t=10`，差的只是那一格里躺着什么（我们编的那份 0、clang 编的那份 8）。
结构体传值（`struct P` 12 字节）走同一条路。这种输入的输出取决于全局量摆在哪，
称不出我们的对错，所以 c67 换一套探针（64 位的移位从局部量上走、结构体只留一个 `int`），
十二副全绿，`known` 那格拆了。

**`-l` 自己找库**（第九十八片）：第九十三片那份「自己编、自己链的 tcc」还得手工把
`--dylib <SDK>/usr/lib/libc.tbd` 递进去 —— 那是欠的账，这一片还了。`macho-link` 认
`-lc` 与 `-L 目录`：名字往文件的三种拼法照 `tcc_add_library`（`libtcc.c:1301-1332`，
MACHO 上是 `lib%s.dylib`、`lib%s.tbd`、`lib%s.a`，**外层循环是拼法**不是路径），
`:name` 是「就照这个名字找」，路径是 `-L` 给的在前、`/usr/lib`、再到 SDK 里那份
`usr/lib`（`tcc_add_macos_sdkpath`，`tccmacho.c:2267` —— 今天的 macOS 上 `libc.tbd`
只在最后那一处）。顺手把 `machoExe` 的 `libtcc1`（一份）换成 `archives`（几份）：
`-lfoo` 找到的 `.a` 与 `libtcc1.a` 走同一条按需取用的路。

**全部源码，不只十二份**（第九十九片）：第九十二片那句「我们编出来的 tcc 去编 tinycc」
量的是 arm64-osx 那**十二份**。这一片把范围推到十二个目标各一套源码 —— 同一份 `.c`
换一套 `-DTCC_TARGET_*` 就是另一条路，六个后端（i386/x86_64/arm/arm64/riscv64/c67）、
三个目标文件写出器（`tccpe.c`/`tccmacho.c`/`tcccoff.c`）、四份汇编器都在里头，
**138 个（文件，宏）组合**，我们编出来的 tcc 与尺子写出同一串字节
（`tests/c/selfsrc.js`，13 条）。顶层那 24 份源码里没量到的只有两份：`tcctools.c`
（不是翻译单元，`tcc.c` 把它 `#include` 进去）与 `il-gen.c`（Makefile 里没有它）。
十二个目标的文件集与宏挪进了 `tests/c/tcc-targets.js`，与 `selfcross.js` 共用一张表。

**十二副都自己链**（第一百片）：第九十六片那十二副交叉编译器是 `clang` 链的。这一片把
那一步也换掉 —— `c-obj --format elf` 出 `ET_REL`、`macho-link … -lc` 写出
`MH_EXECUTE`，十二副全绿。于是从源码到十二副能跑的交叉 tcc，链上除了 SDK 的头与
那份 `libc.tbd`（只读符号名）没有别人；`selfcross.js` 里还留着的 `clang` 只在
「差出来了先建第二把尺子」那一支上 —— 那是**尺子**，不是工具。

**自举的定点**（第一百〇一片）：把两段接起来量到底 —— 我们编、我们链出 omni-tcc（第一级），
让它去编 tinycc 那十二份得到 `.o`（与真 tcc 的 `-c` 逐字节相同），再用我们的
`macho-link` 链成 tcc2；尺子那边 `tcc -c` 加 `tcc` 自己链出 tccref。
**tcc2 与 tccref 597104 字节逐字节相同** —— 编译器与链接器整条换成我们的，出来的是
同一个文件。签名那一格是账上一直挂着的「可执行文件不比字节」的真身：本机 arm64 上
tcc 链完自己喊 `codesign -f -s -`，而 `codesign` 不给 `-i` 时拿**文件基名**当
identifier，所以两份输出得同名不同目录才比得。

**`--arch` 也换预定义宏**（第一百〇二片）：以前 `--arch x86_64` 只换后端，预定义宏还是
`__aarch64__` 那一套 —— 编出来的是「按 arm64 那一支展开、按 x86_64 生成」的四不像。
量出来的差别正好三条（`tcc -dM -E /dev/null` 与 `x86_64-osx-tcc -dM -E /dev/null` 一 diff，
五十条里只差这三行）：arm64 是 `__aarch64__`/`__arm64__`/`__AARCH64EL__`，x86_64 是
`__x86_64__`/`__x86_64`/`__amd64__`，别的（LP64、macOS、C99 那些）两边同形。
`tccdefs.js` 里那一格于是按架构换（`CPU_DEFS`），`Cpp` 从 host 上收 `arch`。
门是 `tests/c/arch-defs.js`：两条腿各自与自己那把 tcc 比六个宏的在与不在
（x86_64 那份在 Rosetta 上跑）。

**`__DATE__` / `__TIME__` 不再是边界**（第一百〇三片）：这两条以前明着报
「its value is not reproducible」—— 值随时钟走，进不了「逐字节相同」那根轴。
第一百〇三片把它们做了，照 `tccpp.c:3378-3393`：**每次展开现读一次时钟**（tcc 也是在
这儿 `time()`/`localtime()` 的，不是启动时算一次存着），格式是那两句 `snprintf` 的原样
—— `"%s %2d %d"`（月份缩写、日**空格**右对齐到两位，所以 9 月 3 日是 `Sep  3 2026`，
两个空格）与 `"%02d:%02d:%02d"`。尺子换一种称法（`tests/c/datetime.js`，4 条）：
日期那一串与 tcc 逐字符相同、时间差在容差内、把 `hh:mm:ss` 抹成占位符之后整份 `-E`
输出与 tcc 逐字节相同。`cpp-bad/date` 那个「该拒」的用例跟着删了。

**`weak` 是符号的绑定**（第一百〇四片）：`__attribute__((weak))` 以前落在 `parseAttrs`
的「不认识的属性」那一支上 —— 括号平衡掉、什么都不改。编得过，符号表里那个名字却仍旧是
**强**定义。现在它是一格真的标注：`ad.weak` 一路带到 `MirFunc.weak` 与
`MirModule.globalWeak`，写目标文件那一步变成 ELF 的 `STB_WEAK`（`elf.js` 的 `buildSyms`）
与 Mach-O 的 `N_WEAK_DEF`（`macho.js`，它不在 `n_type` 上而是 `n_desc` 的那一位）。
门是 `tests/c/weak-sym.js`：与 `tcc -c` 出的 ELF 比 `nm` 的每一行 —— 弱的函数是 `W`、
弱的数据是 `V`、强的是 `T`/`D`、`static` 的是 `t`/`d`，再链起来跑一遍。
`__attribute__((alias("目标")))` 也做了（第一百〇五片）：它不是一条外部声明，而是
**同一个地址的第二个名字** —— 代码一份、符号两条。前端在 `funcSym` 之前就拦下来
（不建 MirFunc、不发桩），把名字接到目标那一格上，再往 `MirModule.aliases` 记一条；
写目标文件那步照目标的落点（函数是 `blob.offsets[目标号]`、数据是那一格的 `base`）
多发一条符号。数据的别名同理：登记复制目标那份、`gno` 写成目标的号，于是同一个单元里
用别名取的就是目标的地址。目标还没定义就用它（前向别名）明着拒 ——
`unsupported forward __alias__ attribute`，与 tcc 同一句同一行
（`tests/c/alias-sym.js`，4 条）。

**可见性也齐了**（第一百〇六片）：`__attribute__((visibility("hidden")))` 落在 ELF 符号那
24 个字节里的第 6 个（`st_other`，DEFAULT 0 / INTERNAL 1 / HIDDEN 2 / PROTECTED 3）。
`nm` 不印这一格，所以 `tests/c/vis-sym.js` 自己解 symtab，与 `tcc -c` 比每条符号的
`(名字, st_info, st_other)`；两条声明各写一个可见性时取**更严**的那个
（严的次序不是数值序：`DEFAULT < PROTECTED < HIDDEN < INTERNAL`，`tccelf.c:722`）。
Mach-O 那边**不写** —— tcc 自己的 `tccmacho.c` 根本不消费可见性，尺子是 tcc 不是 clang。
`-fvisibility=` 这个命令行开关 tcc 没有（量过：整个 tinycc 里只有属性那一处），
所以那一格不是账。至此那条「`-fvisibility`、`weak`、别名都还没有一格」的欠账清了。

**`-E` 从第一个字节起就一样了**（第一百〇七片）：以前门里有一段「削序幕」的削法 ——
tcc 的预定义是一份叫 `<command line>` 的**源码**（`tccpp.c:3653-3666`：预定义 + `-D` +
`-include` 拼成一个缓冲，压在主文件上面开出来），进出主文件各印一行行标，而我们的预定义
是三张宏表、没有这一层。现在这一层照旧开着（里头只放 `-include` 那几行，常常是空的）——
`# 1 "x.c"` / `# 1 "<command line>" 1` / `# 1 "x.c" 2` 三行自然长出来，`-E` 与 `-P1`
两个模式的 `strip` 都撤了，207 条从第一个字节起逐字节比。顺手清掉另一处同类的账：
ELF 的 STT_FILE 那一条印的是**命令行上给的那一串**（量出来的：`tcc -c s.c` 写 `s.c`、
`-c ./s.c` 写 `./s.c`、给绝对路径就写绝对路径），我们从前写基名。

**`-dD`/`-dM` 印的是经过，不是宏表**（第一百〇八片）：接着上一片那一层往下称。既然
`<command line>` 是一份**源码**，`-dD`/`-dM` 的那几行就不是「把宏表倒出来」，而是这些指示
**经过时**一条条印的（`pp_debug_defines`，`tccpp.c:3843`）。两件从「印宏表」绝对得不到的事：
后来被 `-U` 掉的预定义**照印**一遍 `#define`（它确实定义过），从没定义过的名字
`-UNEVER` 也**照印**一行 `#undef NEVER`（那一条指示确实过去了）；次序就是命令行次序，
`-DA=1 -UA` 与 `-UA -DA=1` 出来不一样。我们的这一层是一行行过的（`cmdlineLine`），
于是改成边过边攒（`cmdlineDump`），到门口一次倒出去。同一层还量出两件小事：`-E` 那一路
**每出一条诊断，stdout 上先落一个空行**（`error1`，libtcc.c:683 —— 诊断走 stderr，这个换行
走 stdout），于是「该不该响」也进了逐字节这根轴 —— `X redefined` 补上了
（`define_push`，`tccpp.c:1262`，比的是宏体**印出来的字符串**），而
`multi-character character constant` 与 `#pragma X ignored` 反过来得**收**回去：
它们在 tcc 那儿挂在 `warn_all` 上，默认不响，我们从前无条件响 —— 多响一句就多一个空行。
门是 `tests/c/dm-order.js`（7 条）。还差一格：`-dD` **不带** `-P` 时 tcc 那份缓冲的空行与
`# 132 "<command line>"` 那样的行标，得等预定义变成真的源码文本才能对上。

**80 位那十个字节先量准**（第一百〇九片）：x86_64 上 `long double` 是 x87 的扩展精度
（`x86_64-gen.c:102-103`：值十个字节、格子十六个字节），这是 `selfobj` 上最后一处已知不同
（`15-float.c`、`21-ldouble.c`）。整条腿是几片的活，第一片只做**位模式**这一格：
`f80.js` 的 `f80Bytes`/`f80ToDouble`，门 `tests/c/f80.js` 拿交叉编出来的
`x86_64-osx-tcc -c` 写在 `.data` 里的字节当尺子，九个字面量逐个相同。量的时候撞见一件
决定后面几片怎么走的事：**尺子自己也只有 53 位有效位** —— `0.1L` 的尾数是
`0xCCCCCCCCCCCCD000`，低 11 位是零，因为那份交叉 tcc 跑在 arm64 上，它自己的
`long double` 就是 double。于是「值从 double 来、按 80 位存」这条路就是与尺子逐字节相同的
那条路，不必先写一台十进制到 64 位尾数的转换器。

**MIR 里多了一格 `f80`**（第一百一十片）：**值仍是 f64**，多出来的只是「内存里那十个字节的
形状」—— 读的时候 x87 把 80 位收成 double，写的时候把 double 摊成 80 位。于是类型系统一格
没多（没有 T_F80），`MLOAD`/`MSTORE` 的描述符表各多一项。x86_64 后端拿四条 x87 指令实现
（`fld/fstp tbyte` 与 `fld/fstp qword`，encode.js 新增），中间那块八字节的地方**借栈**：
`push` 腾格子、`fstp` 写进去、`pop` 回来 —— 帧是 rbp 基的，所以动 rsp 不碰任何一个槽。
arm64 与线性内存那两条腿一个字没改：它们的 `long double` 就是 double，发不出这个描述符，
真发了也会当场报「不认识的访问 f80」。门在 `tests/x64/from-mir.js`（Rosetta 上真跑）：
2.5 存进去读回来、**0.1 来回一位不掉**（走错成 float 那一档立刻答成 fround(0.1)）、
写出来的十个字节与 `f80Bytes(1.5)` 逐个相同。顺手清掉那份门里一条过期的**反面**用例
（`u64 -> 浮点` 早就做了，反面用例还在说「该报错」）—— 换成两条正面的。

**x86_64 上 `long double` 真的是 16 字节了**（第一百一十一片）：`typeSize` 那一格按目标走
（`setLdoubleTarget`，`lowerC`/`lowerCNative` 每次进来拨一次 —— tcc 那边它是编译期常量），
`loadKindOf`/`storeKindOf` 在 x86_64 上给它派 `f80`，静态初始化式走 `floatBits(x, 16)`
（也就是 `f80Bytes`）。于是 `sizeof(long double)` 是 16、`struct { char c; long double d; }`
是 32、`.data` 里那十六个字节与尺子称过的那一份逐个相同、局部量存进帧再读回来算术全对
（门 `tests/c/ldouble-x64.js`，Rosetta 上真跑；这一条的尺子是 `clang -arch x86_64` ——
交叉编出来的 `x86_64-osx-tcc` **链不动**自己的目标，没有 x86_64 那一档的 libc 与
`libtcc1.a`）。**还差 SysV 的那一半**：`long double` 是 MEMORY 类，传参走栈上 16 字节的
格子、返回在 `st0`。

**返回值在 `st0` 里**（第一百一十二片）：`long double` 的返回值 SysV 说在 **x87 的栈顶**，
不是 xmm0。这一位记在两个地方，各有各的理由 —— 直接调用（`CALL`）看得见被调的是谁，
所以标注在**那个 MirFunc** 上（`ldRet`，与 `local`/`kernel` 同一种性质：标注，不是语义）；
外部符号与按指针调用看不见，只能由调用点带着（`CCALL`/`CALLI` 的 aux 挤进 bit 16，
`CALL_LDRET`）。同一件事只记一处，两处记同一件事迟早会不一致。取回来的手法与上一片
一样是**借栈**：`push` 腾八个字节、`fstp qword` 把栈顶收成 double 写进去（顺手弹干净 x87
栈，不弹的话连着几次调用就把八格填满了）、`pop` 回来；发出去是反过来的 `fld qword`。
外部函数那个桩（`$ext$strtold`）两头都要点：CCALL 从 `st0` 取，桩自己的 `RET` 再写回
`st0` —— 只做一头的话值在桩里从 x87 转到 xmm0 就再也回不去了。**这一片把 `21-ldouble.c`
拿下了**：`tokc.ld = strtold(...)`（`tccpp.c:2427`）的返回值从此取得对，于是我们编出来的
x86_64 tcc 认得准 `1.5L`，写出来的 `.o` 与交叉编那份逐字节相同。

**传参走栈上 16 字节的格子**（第一百一十三片）：SysV 里 `long double` 是 X87 类 ——
**不看大小**一律 MEMORY。前端把值落进帧上十六个字节，传的是那一块（`ldArgMem`，
发一条 `ARGMEM`，aux 上多一位 `MEMARG_F80`）；后端见到那一位就在出参区里对齐到 16
开一个 16 字节的格子，往里拷十个字节（余下六个字节 clang 也不写）。被调那一头对称：
形参表上那一格按一位 `ld`，序言 `fld tbyte [rbp+off]` 读进 x87 再 `fstp qword` 落进槽里。
桩也要转发（`ldexpl`，`tccpp.c:3961` 真有这一处）：桩自己划一块 16 字节，收到的值写成
80 位再 `ARGMEM` 转出去。变参里取它（`va_arg(ap, long double)`）是第一百一十四片：
X87 类从来不进寄存器，所以那一路只有「游标对齐到 16、`fld tbyte`、推 16」三件事。
**于是 x86_64 那一套一份不差**：`selfobj` 的
`X64_KNOWN_DIFF` 空了 —— 84 份用例、12 份 tinycc 自己的源码，我们编出来的 x86_64 tcc
与交叉编那份写出来的字节处处相同。**第二级也补齐了**（第一百一十五片）：那份 x86_64 tcc
去编 tinycc 自己的十二份几千行的源码，与交叉编那份逐字节相同 —— arm64 那条腿上这一格
第九十四片就有了，x86_64 这边一直缺着，缺的正是 `long double`。

**只读数据那一节的名字跟着目标走**（第一百一十六片）：PE 上叫 **`.rdata`**，别处叫
`.data.ro`（`tccelf.c:50-56` 一个 `#ifdef TCC_TARGET_PE` 定的）。这与符号前缀那个 `_`
同一种性质 —— 目标的事实，不是选项，所以写 `.o` 的那一头收一格 `opts.rdata`
（缺省 `.data.ro`），由 `cli.js` 按 `--os` 给。门 `tests/c/rdata-name.js` 3/0，
三个目标的期望都是从交叉 tcc 自己的 `.o` 里读出来的，一个字都不写死。
win32 的容器还差三样，量过了记在这：`.pdata` 与 `.rela.pdata`（每个函数 12 字节的
`RUNTIME_FUNCTION` 加三条重定位）、它们指的那条局部符号 `.uw_base`、以及 `.symtab`
的 `sh_info` —— 最后这个被我们 `$ext$` 那些桩的局部符号顶偏了，得等那门手法退役。

**`.pdata` 也补上了**（第一百一十七片）：win64 的异常展开是查表的，每个函数在 `.pdata` 里
占一条 12 字节的 `RUNTIME_FUNCTION`。三个字段都是相对代码节起点的偏移，`.o` 里代码节还
没有地址，于是三个字段各挂一条指着局部符号 `.uw_base` 的 RELATIVE；那一份共用的八字节
`UNWIND_INFO` 住在 `.text` 里，摆在**第一个函数收完之后**、对齐到 4 —— 位置由代码的排布
决定，所以这一格只能由后端摆（`genModule(mod, {unwind: true})` 回 `{offs, funcs}`），
八个字节本身借链接器那一头早就有的 `unwindInfoX64()`。顺手量到一条一直没写明的规矩：
**7 号往后那几节的次序就是造出来的次序** —— `.rela.text` 在第一条代码重定位发出来时造、
`.pdata` 在第一个函数收尾时造，于是「第一个函数里有没有重定位」决定两节谁在前。
门 `tests/c/pdata-x64.js` 11/0，`tcc-obj.js x86_64-win32` 从「0 容器相同、5 不同」
走到「3 容器相同、2 不同」。**`.rela.data` 也照这条规矩排了**（第一百一十八片）：
它是第一条数据重定位落的时候造的，而带地址的初值常常在所有函数之前 —— 于是它常常排最前。
时刻要在**发生的那一刻**记（`putSymBytes` 里的 `after`，因为全局的字节是一遍过走完才切的），
三件事再换算到「第几个函数」那一把尺子上排（`cli.js` 的 `relaSeq`）。
门 `tests/c/rela-order.js` 6/0。**linux 上那张展开表是 `.eh_frame`**（第一百一十九片）：
同一件事的另一种写法 —— DWARF 的 CFI，而且它跟着**输出格式**走而不是 CPU
（`tccelf.c:92-94`：非 ELF 的输出格式把 `unwind_tables` 关掉），所以 osx 与 win32 一节也没有。
CIE 24 字节、每个函数一条 36 字节的 FDE、收尾四个零字节；一条 FDE 里只有
「`PC Begin`（挂 PC32，指着一条没名字的 STT_SECTION）/ `PC Range` / `size - 5`」这三个数
跟函数走，那几条 CFA 指令是写死的 —— 序言前四个字节我们与 tcc 一样，所以照抄成立。
门 `tests/c/eh-frame-x64.js` 8/0（把那三个数挖成零之后与尺子逐字节相同），
`tcc-obj.js x86_64-linux` 从「0 容器相同、5 不同」走到「3 容器相同、2 不同」。
**符号表那一格 `st_size` 也填上了**（第一百二十片）：函数记「这个落点到下一个落点」
（win32 上第一个函数后面那八字节的 `UNWIND_INFO` 也算在里头），全局量记 C 类型的大小。
门 `tests/c/sym-size.js` 4/0 —— 全局量的大小与尺子一个数不差，函数的把 `.text` 铺满。
**那条下划线只有 osx 加**（第一百二十一片改对）：`libtcc.c:895-898` 里 PE 那一支是
注释掉的，所以 win32 的符号名与 linux 一样是**光的**；我们自己的 PE 链接器一直知道
这一格，是写 `.o` 那一头记错了。改完 `sym-size` 那门从 4/0 变 6/0。
**只读的全局量落进 3 号节**（第一百二十二片）：`tccgen.c:8401-8403` 只剥**数组**那几层，
剥完剩下的类型带 `const` 就进 `.data.ro`（PE 上是 `.rdata`）—— 于是
`const char s[]`、`const int ci` 进只读节，`const char *const cq` 也进（它是**只读的
指针**，哪怕初值要一条重定位，于是多一张 `.rela.data.ro`），而 `const char *cp` 不进。
为这一条，指针自己的 `const`/`volatile` 从「吃掉」改成记在那一层指针的类型上 ——
从前确实没有可观察的效果，现在有了。门 `tests/c/rodata-sec.js` 27/0（三个目标 × 三个
探针 × 三问：节号、只读节里那几样的字节、`.rela.<只读节>` 有没有与排在第几），
`tcc-obj.js` 的「容器相同」从 6 走到 12。Mach-O 那个写出器只有两节，只读那一段折进
`__data` 的尾巴（`foldRo`）—— `__DATA,__const` 是笔欠账。
**串常量也进只读节**（第一百二十三片）：每条按**元素的宽度**对齐（窄串 1、宽串 4）、
结尾补一格同宽的零，`st_size` 是带那一格的长度。量过的 `.data.ro` 现在**逐字节相同**
（`"A" "B" L"ab"` 那个探针：16 字节、三条符号的落点与大小一个数不差），差的只剩名字 ——
tcc 叫 `L.N`（`tccpp.c:626`，`N` 是匿名符号计数器），我们叫 `omni_str_N`。
门 `tests/c/str-rodata.js` 33/0/1（那个 1 是 win32 的 `wchar_t` 只有两字节，还没做）。
**串常量不去重**（第一百二十四片）：tcc 那边一条串常量的身份是它在源码里的**那一次
出现** —— `"A"` 写三遍就是三份字节、三条 `L.N`。我们的常量池原来按文本合成一条，
现在 `fresh` 只管添、`strConst` 按出现的次序记（函数体里 `${funcName}#${strNo++}`、
两遍各自归零好认回同一条，文件作用域自己一格只增不减的计数）。门加两个探针，51/0/1。
**只读节按声明的次序摆**（第一百二十五片）：tcc 那边只读节就是一个按序推进的游标，
`const` 全局与串常量**交替**着落（量过 `const int c1; char *a="A"; const int c2; …`：
`11 0 0 0 | 65 0 | 0 0 | 22 0 0 0 | 66 0`），带初值的 `const` 指针在自己那条串之前领字节。
前端多一格共用的计数（`allocGlobal` 与新建串常量各领一个号），新的 `mir/rodata.js`
按号排好落点，两个后端只查不推。门 69/0/1 —— `.data.ro` 的字节与落点全对，只读节里
剩下的差别只有名字（`L.N`）与符号表那几条的次序。
**符号表按建符号的次序排**（第一百二十六片）：tcc 自己不排（`tccelf.c:862` 那段注释），
`sort_syms` 只按绑定分成局部/非局部两段、段里保持原序，而原序就是一个名字**第一次被
提到**的次序。我们从前是三堆分开攒的（函数、全局量、串常量），现在函数也在那个共用的
轴上领号（`funcSym` 第一次见到就领），每一块全局量都领（不只 `const` 那些），
`cli.js` 的 `orderSyms` 按号稳定排一遍再交给写出器。新门 `tests/c/sym-order.js` 18/0 ——
整张 `.symtab` 逐条与 `sh_info` 都对得上，只读节剩下的差别只有名字。
**模块内的直接调用也发重定位**（第一百二十七片）：量过 tcc —— `static` 的被调者、
同一个 `.o` 里，那条 `e8` 后面照样是四个零，`.rela.text` 里一条 `PLT32`（加数 −4）
指着它（arm64 是 `bl` 全零 + `BRANCH26`）。我们从前在汇编那一层就把位移算掉了，于是
`.o` 比 tcc 少一整节。改动是两个后端各一行（`buf.call(label)` → `buf.callSym(名字)`），
写出器与链接器都不用动。新门 `tests/c/rela-text.js` 18/0/3（那三格是外部函数的转发桩
还是一个真函数），`tcc-obj` 的容器相同从 12 走到 16。
**没有函数体的名字不再是一个函数**（第一百二十八片）：native 上外部函数不发桩了 ——
`MirFunc` 多一格 `extern`，两个后端跳过它、一个字节都不出、也不发符号，名字靠调用点
那条重定位进「未定义的外部符号」那一段。还留着桩的四类：变参的、按值收发 struct 的、
带 x87 `long double` 的，以及**取过地址的**（`adrp+add` 指不着未定义符号，那得过 GOT）。
顺手修了「第几个函数」那根轴 —— 没有函数体的不占落点，`relaSeq` 得只数出过代码的。
`rela-text` 22/0/1，`tcc-obj` 的容器相同从 16 走到 21。
**预定义宏按目标分**（第一百二十九片）：从前只有目标 CPU 那三条跟着 `--arch` 走，
剩下的四十几条照 macho 写死 —— 六个 64 位目标一 diff，条数就不一样（osx 51、linux 44、
win32 41、arm64-win32 40）。`tccdefs.js` 于是从一张静态表改成顺着攒（照 tcc 的
`tcc_predefs` 那一串 `putdef`），`(arch, os)` 两个轴：OS 那一段（`__linux__`/`__APPLE__`/
`_WIN32`）、模型（LP64 与 win32 的 LLP64）、`wchar_t` 那两条、OS 自己那一段
（osx 的 `__GNUC__ 4` 一族、win32 的 `__declspec`/`__cdecl`）、glibc 的 `__REDIRECT`
一族（PE 上没有）。量出来两条从前不知道的：`__arm64__` **只有 Mach-O 才有**
（`arm64-gen.c:57`），`__CHAR_UNSIGNED__` **只有 arm64-linux**（`arm64-gen.c:41`：
非 MACHO 非 PE）。`cpp` 那一路也接上了 `--arch`/`--os` —— 从前它连目标都说不出来。
新门 `tests/c/predefs.js` 12/0（六个目标 × `-dM` 整张表与 `-dD` 那一路，逐行比）。
**win32 的 `wchar_t` 是两字节**（第一百三十片）：上一片把 `__WCHAR_TYPE__` 摆对之后，
这一格就只剩「让语言跟着宏走」。tcc 那边是编译期的两条、其实是一件事 ——
`tcc.h:447` 的 `nwchar_t` 定字节宽度，`tccgen.c:5667`/`:5614` 那两道 `#ifdef TCC_TARGET_PE`
定宽串与 `L'x'` 的**类型**。ctype.js 于是多一格模块级状态（与 `LDOUBLE_SIZE` 同一个
办法）：`wcharType()` / `wcharSize()` / `isWcharType()`，`lowerCNative` 按 `host.os` 拨。
量过：win32 上 `sizeof(L"ab")` 是 6、`sizeof(L'x')` 是 **2**、`unsigned short a[] = L"ab"`
收得下而 `int a[] = L"ab"` 只是「指针赋给整数」。新门 `tests/c/wchar.js` 27/0/3，
`str-rodata` 那个 `not yet` 消掉，从 69/0/1 变 72/0。
**`.data` 也按声明的次序摆**（第一百三十一片）：上一片的探针顺带量出来的 —— 从前两个
后端铺 `.data` 是照 MIR 的**全局号**一块接一块推，而号是「第一次被提到」的次序。
`sizeof(*p)` 这种（借表达式那一路解析）会让后声明的先领到号，于是
`char *n; int *p; int m = sizeof(*p);` 我们摆成 `p@0 n@8 m@16`、tcc 是 `n@0 p@8 m@16`。
`mir/rodata.js` 里那个规划器抽出一个共用的 `layout(items)`，多一个 `planData(mod)`，
两个后端的 `dataBytes` 从「一路 push」改成「先按落点开好、只往里填」。`wchar` 那门
27/0/3 变 **30/0**。
**没有初值的全局量进 `.bss`**（第一百三十二片）：判据是**源码里有没有那个 `=`**，不是
「字节是不是全零」—— tcc 在 `tccgen.c:8405-8438` 上按序问三步（`is_const` 进只读那一节、
否则 `has_init` 进 `.data`、否则进 `.bss`；`nocommon` 缺省 1 所以 COMMON 那一路不走），
于是 `int b = 0;` 在 `.data` 里、`int a;` 在 `.bss` 里，两者的字节一模一样。所以这一格
只能由 C 前端记（MIR 的 `globalBss`），后端**不能**按字节猜。`planData` 旁边多一个
`planBss`，两个各自独立的游标；ELF 那一头 `.bss` 终于带上真的 `sh_size`（NOBITS，
文件里不占字节），Mach-O 那一头折进 `__data` 的尾巴。顺带被尺子逮到一笔旧账：每一节的
`sh_addralign` 是「里头对齐要求最大的那一块」（下界 8），从前三节都写死 8 ——
量过 `int g32 __attribute__((aligned(32))) = 9;` 的 `.data` 是 32、
`struct a7 g7[2] __attribute__((aligned(16)));` 的 `.bss` 是 16。`sym-size` 那门从
6/0 长到 **12/0**：全局量的 `st_size`、**落点（哪一节、第几个字节）**、三节的
`sh_size` 与 `sh_addralign`、函数把 `.text` 铺满，四条都与尺子一个数不差。
**函数体里 `static` 的名字也改对了**（第一百三十三片）：tcc 写的是**声明时那个名字**
（`n`），而且同一份 `.o` 里两个函数各有一个 `static int n;` 就是**两条都叫 `n`** 的局部
符号 —— 局部符号本来就不必唯一。我们那点料（`f.n.0`）是一遍过里的**身份**，不能扔，
所以拆成两格：MIR 多一格 `globalSym`（写进符号表的名字），两个写出器里「重定位按它
找符号」的那张表还按身份键，只有往字符串表里塞的那一下用名字。`sym-size` 称到的
全局量从 7 个长到 **10 个**（那三个函数静态量从前是名字对不上被跳过的），比法也从
「按名字查一条」改成按名字攒成**多重集**再比。
**串常量的名字也对上了**（第一百三十四片）：tcc 那边它们是**匿名符号**，名字是 `L.N`，
N 是一根与匿名 struct 标签、匿名成员共用的游标（`anon_sym`）。前端多一格 `anonSym`
在四处推（匿名标签、匿名成员、无名位域、每条串常量），都带 `if (!this.pass1)`——函数体
走两遍，只在第二遍数才是源码次序。起点那三个数（linux 3 / osx 1 / win32 0）是
**这个目标的 `__builtin_va_list` 里有几样匿名的东西**，我们那份是写死的 `void *`
typedef，所以在装它的地方把游标推过去 —— 那三行是「我们这条 typedef 与 tcc 那条形态
不同」这笔旧账的另一面，等它真按目标解析出来就该删掉。`sym-size` 称到的全局量
从 10 个长到 **12 个**。
**文件作用域的静态复合字面量也进这根游标**（第一百三十五片）：tcc 那边它与串常量同一条
路（`get_sym_ref`），所以名字也是 `L.N`、也吃号。量过 `int *p = (int[]){1,2,3}; char *s = "x";`：
tcc 是那一块 `L.0`@8、串 `L.1`，而且那一块摆在 `p` 与 `s` **中间**（它是解析 `p` 的初值
那一刻领的字节）—— 我们从前既不给它号、也不给它 `dseq`，于是串顶成了 `L.0`、那一块被
排到最后。补上两格之后那个探针的数据段与 tcc 一字不差。
**arm64-linux 上 `char` 是无符号的**（第一百三十六片）：第一百二十九片把
`__CHAR_UNSIGNED__` 那个宏摆对了，可那一格在 tcc 那边**同时是一条语言规矩**
（`arm64-gen.c:41` -> `libtcc.c:889` 的 `char_is_unsigned`），六个目标里只有它一个。
落点只有一处 —— `parseBtype` 定基本类型那一步，没写 `signed`/`unsigned` 的 `char` 补上
`VT_UNSIGNED`；`ctype.js` 多一格旋钮（与 `LDOUBLE_SIZE`/`WCHAR_IS_SHORT` 同一个办法）。
新门 `tests/c/char-sign.js` 六个目标 6/0，期望值从尺子读，里头带两条显式
`signed char`/`unsigned char` 的对照与一条「至少量到一个无符号目标」的元检查。

**往上接回前端**：MIR 多了一条 `FRAME`（帧上要一块，回它的**真地址**），这是 native 这条腿上
「取地址」的落脚点 —— 两条腿各一条指令（`add xd, sp, #off` / `lea rd, [rbp - off]`），
地址交给真的 libc（`strlen`/`memcpy`）验过。C 前端现在还把 `&x` 降到影子栈上，
把它改成落在 `FRAME` 上是下一片，见下面的第九刀第十八片节。

**C 已经走通 native 这条腿**（第十九片）：`lowerCNative` 出的 MIR 没有线性内存，
局部量的帧是一条 `FRAME`，两个后端编成机器码、clang 链起来在真机器上跑，
结果与 clang 自己编的逐字节相同（`tests/c/native.js`，oracle 是 clang）。
还落在线性内存上的（字符串字面量、全局量、变长数组、堆）一律明着报，一片片往下搬。

**串常量与全局量已经落到符号上**（第二十、二十一片），**变参调用按真 ABI 走**
（第二十二片：`CCALL` 的 aux 记固定实参的分界，苹果 arm64 的变参一律走栈、
SysV 要在 `al` 里报 xmm 个数），**实参超过寄存器数时走栈**（第二十三片：两条腿共用
一个 `argPlaces` 算落点，帧底留出参区，溢出的形参在 `fp+16`/`rbp+16` 读回）。
native 上的堆就是系统的堆 —— `malloc`/`free` 落成普通的外部 C 调用。
**变参函数的定义也通了**（第二十四、二十五片：MIR 的 `VASTART`/`VAARG` 把
`va_list` 的形状留给后端 —— 苹果 arm64 上它是个 `char *`，SysV 上是 24 字节的结构
加一块 176 字节的寄存器保存区）。**`va_copy` 也通了**（第三十二片：MIR 的 `VACOPY` ——
抄的是 va_list **本身**，所以形状照旧归后端）。

**`gen/` 那一批已经在 native 上整批跑**（第二十六片）：`omni c-obj` 出 `.o`、clang 链、
真进程跑，83 条里 **81 条**与 `tcc -run` 逐字节相同（`tests/c/native-gen.js`）——
剩下 2 条是**问不出**同一个答案的（`37-argv`、`82-flex-init`），不是没做到。
**同一批还有第二条能跑的路**（第三十八片）：`c-obj --format elf` 出 ELF 目标文件、
**tcc 自己的链接器**链、真进程跑，同样 **81 条**过（`tests/c/tcc-link.js`）——
那条路上没有 clang，tcc 会把我们写的节头、符号表与重定位全读一遍再自己重定位。
**struct 进变参也通了**（第三十九片：MIR 的 `ARGMEM` —— 内容的地址 + 字节数，
由后端按 ABI 拷进格子；`VAARG` 的 aux 添了「这一格里躺着多大的 struct」这个意思。
第四十片补上 x86_64：SysV 的聚合分类，aux 里再带一张两位的 SSE 位图）。
**函数指针也通了**（第二十七片：MIR 的 `FADDR` 取函数符号的真地址、`CALLI` 落成
`blr` / `call *r`），**初值里的地址也通了**（第二十八片：数据节里的 `POINTER64`
重定位 —— 静态指针表、`char *p = "…"`、`&g`、`&s.f`、函数指针的全局都在这一格上）。
**宿主的那几格也通了**（第三十一片：外部的全局量是未定义符号、取地址过 GOT、
`errno` 映到 macOS 的 `__error`、三个标准流映到 `__stdinp`/`__stdoutp`/`__stderrp`）。
**变长数组与 `alloca` 也通了**（第三十六片：MIR 的 `SPGET`/`SPSET`/`SPALLOC` ——
栈顶是机器的 `sp`，会动它的函数在 arm64 上另钉一个帧基址）。
只剩一条没到：`va_arg` 取 struct（要真的 ABI 分类）。

## 后果与代价

- **这是本仓库到目前为止最大的一件事。**tcc 自己是 68619 行 C；我们要的那部分
  （pp + gen + 两个 CPU 的 encode/gen + asm + 两种目标格式 + 内存执行）在 tcc 那边大约
  是 3961 + 9001 + 2×2300 + 2×2600 + 1525 + 4201 + 2477 + 1580 ≈ **33000 行**。
  我们的实现不会更短。**必须按刀走，每刀都要有量和测试。**
- **C 与另外四门语言不共享 OIR**（决策二的代价）。这意味着 `hir/check.js` 那套模式/
  可选类型/容器语义对 C 完全不适用，C 的类型检查是**另一套**代码。这是刻意的重复。
- **自带后端的码比 clang 慢约 3 倍**（tcc 就是这样）。所以它不取代 LLVM 那条腿，
  它取代的是"必须装 cc / 装 LLVM 才能跑"这件事。
- **许可证是一个未决问题**（见"借什么"）。按"行为复刻、代码自写"走时没有传染问题；
  一旦某一刀想直接搬 tcc 的代码文本，那一刀要先停下来问。
- **wasm 那半边有独立价值**：它让这条管线多一个不需要本机工具链的执行目标，
  而且它的规格是公开的、有官方测试集（spec tests）的 —— 这比自带后端更容易做对。
- **参考树是只读的**：tcc 的构建放在 `.omni-cache/tcc-build`（树外），
  `/Users/wurui/Documents/Lang/reference/tinycc` 不改一个字节。哪天要改（比如加计时探针），
  改在我们自己的构建目录里，并把改动记在这份 ADR 里。

## 落地：第一刀 —— MIR 的 `T_I32` / `T_F32` 与八种截断扩展

**加了什么。**`T_I32 = 11`、`T_F32 = 12` 两个类型码（低 5 位还剩 19 个空位，位布局与
`REF_BIAS` 一个字节都没动），`CVT` 长出六种模式：`sext` / `zext` / `trunc` / `sext8` /
`sext16` / `fcvt`。加上原有的 `i2f` / `f2i` / `u2f`，C 要的那八种整数宽度转换与
`f32 <-> f64` 就都能表达了。常量池加 `i32()` / `f32()` 两个入口。

**规范形。**这一条是整刀的地基，写在 `ir.js` 的注释里：`T_I32` 的宿主表示仍是 bigint，
**规范形是符号扩展后的值** —— 也就是说 `-1` 就是 `-1n`，不是 `4294967295n`；无符号语义
只出现在运算里（`u/` `u%` `u>>` `u<` 那一族先 `asUintN(32)`），不出现在表示里。
`T_F32` 的宿主表示是 Number，**每一步运算之后都要 `Math.fround`**。这两句话让"同一份 MIR
在闭包解释器与 LLVM 上逐字节相同"成为可判定的事，而不是靠运气。

**五个消费者跟了几个。**`mir/print.js`、`mir/verify.js`、`mir/bytes.js` 三个是**类型无关**的
（走 `TYPE_NAMES` / `CVT_NAMES` 表），扩表即完成，一行代码没改。真正要逐 op 跟的是两个：
- 闭包解释器（`mir/interp.js`）：新增 `bin32` / `cmp32` / `bin32f` 三族，加减乘回绕 32 位、
  除零与 `INT32_MIN / -1` 的行为、移位量掩 31、`u>>` 走 `asUintN`，f32 每步 `fround`。
  这些分支落在**闭包构造期**（`step2` 里按类型选闭包），不在每步执行的热路径上 ——
  所以既有腿的稳态吞吐不受影响。
- LLVM 后端（`backend-llvm/emit.js`）：`i32` / `float` 两个类型，`NEG` / `BNOT` 改成按
  `this.ty(t)` 发而不是硬编码 `i64` / `double`，移位先 `and i32 ..., 31`，`CVT` 全部重写。
  两处刻意的选择：(1) i32 的 `/` `%` **先扩到 i64、调既有的 `@omni_ll_div` 家族、再 `trunc`
  回来** —— 不是为了省事，是为了让"除零的报错文本"和"`INT32_MIN / -1` 的回绕"与 `bin32`
  逐字节一致；(2) f32 常量发 64 位十六进制形（`llFloat32`），因为 LLVM 只接受对该类型精确的
  十进制字面量，`0.1` 这种写法它会拒收。

`backend-spirv` 这一刀**没跟**：它遇到不认识的类型走 `nope()`，是个诚实的报错而不是错码。
GPU 那边 f32 其实比 f64 更自然，留成后面单独一刀。

**新增一条测试轴：MIR 级单元用例。**i32/f32 现在**没有任何前端能产出**（核心方言只有一格
`int`、一格 `real`），所以测法只能是直接造 MIR：`tests/mir/mirkit.mjs` 搭模块，
`tests/mir/units/{i32,f32}.mjs` 是 20 个用例，`tests/mir/unit-leg.mjs` 一条腿一个进程跑，
`tests/mir/run.js` 第 4 节比对。**期望值是按 IEEE-754 与 wasm 规范算出来的，不是从任何一条
腿抄回来的** —— 抄回来的期望值只能证明"两条腿一样错"。
- i32 13 例：加/乘回绕、`INT32_MIN / -1`、`1 << 33 == 2`（掩 31）、`-8 >> 1` 与
  `-8 u>> 1 == 2147483644`、`-1 u/ 2 == 2147483647`、有符号与无符号比较分岔、
  `sext8(200) == -56`、`sext16(40000) == -25536`、`zext(-1) == 4294967295`
- f32 7 例：`0.1f + 0.2f == 0.30000001192092896`、`1f/3f == 0.3333333432674408`、
  `16777216 + 1 == 16777216`、`3.4e38 * 2 == inf`、最小非规格化数
  `1.4012984643248171e-45`、`-0`、`0.1f + 0.2f == 0.3f` 为**真**（f64 下这是假的）
- 结果：`unit/i32 [interp == llvm == 期望，13 行]`、`unit/f32 [interp == llvm == 期望，7 行]`

**两个踩到的坑。**(1) 用例入口不能叫 `main` —— LLVM 后端自己会发一个 C `main` 去调
`omni_run_entry`，clang 报 `invalid redefinition of function 'main'`；改叫 `omni_main`。
(2) 一开始用 `print.real` 印 f32，两条腿都印出 `0.3` —— `print.real` 是 `%g`、六位有效数字，
**把 f32 与 f64 的差别整个盖掉了**，那版测试什么都没证明。改成
`to_string_g.real(x, 17)` + `print.string` 才看得见 `0.30000001192092896`。

**闭合 ABI 长出 `Math.fround`。**f32 的规范形要在 JS 侧落地就必须有 fround，而它不在闭合
ABI 里（ADR-0011 决策二会当场报错）。按「jancy 支持不可向方言妥协」那条，**长 ABI，不绕路**：
op 字母 `'F'`，四个落点 —— `frontend-js/lower.js` 的 `'Math.x'` 表、`hir/js_abi.js` 的 op
表与注释、`backend-js/prelude.js`（在那个 `String.raw` 模板里，不能有反引号）、
`src/runtime/omni_js_num.c`（`(float)x` 再回 double）。
`tests/js-exec/cases/01-expr.js` 加了四行断言（`fround(0.1+0.2)` / `fround(1/3)` /
`fround(16777217)` / `fround(-0.5)`），**参照是 node** ——
`node == omni-js == omni-c == interp == interp-mir` 五方逐字节相同才算过。

**量出来的。**
- `tests/mir` 35/0（含新增两条）、`tests/js-exec` 11/0（42 行断言）、`tests/llvm` 22/0、
  `tests/jit` 22/0、`tests/sexpr`、`tests/wat`、`tests/incr`、`tests/gpu`、`tests/asy`、
  `tests/jnc`、`tests/cabi`、`tests/glr`、`tests/oir`、`tests/oracle` 全绿
- 自举 `tests/bootstrap` 60/0，`npm run build:self` 9/0 —— 运行时的 C 与 prelude 都动了，
  所以这一条是必须跑的：`fixpoint C1 == C2` 168099 行、`N1 emit-c == N2` 12988256 字节、
  `N1 emit-js == N2` 6874214 字节，三个不动点都还在。全套 137.0s。
- 自解析轴（`tests/js-roundtrip`）101/1 —— 那个 1 是既有欠账 `tests/asy/sweep.js` 的
  `await import`。**这里有个自绊的教训**：第一版 `tests/mir/run.js` 也用了 `await import`
  去读用例的 `expected`，于是这条轴从 101/1 掉到 100/2 —— 仓库自己的 JS 必须在
  我们自己的方言里（async/await 未支持）。改成向 `unit-leg.mjs` 多要一条 `expected` 腿，
  动态 import 留在 `.mjs` 里（`.mjs` 不在自解析轴内）。async/await 是一刀独立的活
  （要 Promise 与微任务队列），不在这一刀里顺手做。
- 代码量：`ir.js` +45、`interp.js` +103、`backend-llvm/emit.js` +109、闭合 ABI 四处 +13，
  测试 +51 与三个新文件。改动集中在两个消费者上，这个比例正是"类型码扩展"应有的样子。

## 落地：第二刀 —— 线性内存（MIR + sx + 五条腿）

**MIR 那半边。**四条 op 接在表尾（`MSIZE` / `MGROW` / `MLOAD` / `MSTORE`），模块上多一格
`mem`（`null` = 不用内存，既有五个前端一个字节都不多发）。`i64.load32_u` 那一族不是几十条
op，是**两条 op 加一个描述符**：aux 打包成「静态偏移 * 16 + 宽度符号号」，读侧九种
（`i8s`/`i8u`/`i16s`/`i16u`/`i32s`/`i32u`/`i64`/`f32`/`f64`）、写侧六种（没有符号）。
这与 wasm 的指令表逐条对应 —— 那边 load 有 `_s`/`_u`、store 没有。对齐提示**刻意不进
描述符**：它在 wasm 里只是给引擎的优化提示、不改语义，而三套实现都不要求对齐。

**verifier 查三件事**，第三件是真正会咬人的：
1. 有没有内存（`(mload …)` 落在没声明内存的模块里）；
2. 描述符号在不在表里；
3. **宽度与 `t` 配不配**。`(mload i64 …)` 落到 `t = f64` 上，两条腿会各自猜一个
   （DataView 那边读出整数、memcpy 那边把位模式当浮点），错得还不一样。
   另外满宽的读不许带无符号变体：`i32u` 读出 `0x80000000` 得到 `2147483648n`，
   而 `T_I32` 的规范形是 `-2147483648n` —— 之后每一条比较都会与 LLVM 分叉。
   wasm 同样没有 `i32.load32_u`，这不是巧合。

**三套实现，一套语义。**
- `interp/builtin.js`（两个解释器共用）：`ArrayBuffer` + `DataView`，字节序**固定小端**
  （每次调用都显式传 `true`）。给 MIR 那条腿的入口是 `memLoadFn(kind)` ——
  **在造闭包时选一次函数**，于是每次访问只剩「一次加法 + 一次 DataView 调用」。
- `backend-js/prelude.js`：同一套算法的文本版，一个访问一个函数（`$lin_ld_i32u`），
  于是每个调用点都是单态的。名字带 `lin` 前缀是因为 prelude 里 `$mgrow` 已经是 arena
  的增长了（ADR-0016）—— 两块内存两套名字，撞上了会静悄悄地错。
- `omni_linmem.c`（C 与 LLVM 共用）：`realloc` 出来的字节 + **本机字节序**。
  `omni_lin_at(addr, bytes)` 查一次界、回一个可直接读写的指针，宽度与符号在生成的代码里
  用强转表达（`*(int8_t*)` 提升到 int64 就是符号扩展）。`omni_lin_init` 里有一句小端检查：
  大端机上当场停，而不是静悄悄地把每个字段读反。

LLVM 那条腿的形状与指针那一路刻意一致：**先 call 查界、再就地 load/store**，`align 1`
（wasm 允许非对齐访问，不写它 LLVM 会按自然对齐发指令，arm64 上是未定义行为）。
于是越界那句话只有 `omni_linmem.c` 里那一份，run-c 与 run-llvm 调的是同一份机器码。

**MSTORE 的结果是存进去之前的那个值**，不是回读 —— 存 `i8` 的 300 回读得到 44。
LLVM 那边用 `select i1 true` 做恒等（`fadd 0.0` 会把 `-0.0` 变成 `0.0`）。C 那条腿上
这个表达式的值是窄类型、也是截断后的，但方言里 `mstore` 是**语句**，那条差别不可观测。

**sx 那半边**（用户明说要的「sx 补 wasm 的内存模型」）：
```
(memory MIN [MAX])          ;; 页数下界/上界，一页 64KB，MAX = 0 不设上界
(data OFF 字节…)            ;; 字节写成 0..255 的整数或字符串（按 UTF-8 展开），可混写
(msize)                     ;; 当前页数
(mgrow N)                   ;; 回**旧**页数；加不了回 -1（不报错）
(mload KIND ADDR [OFF])     ;; KIND 是那九个之一，结果是 int 或 real
(mstore KIND ADDR VAL [OFF]);; 语句；KIND 是那六个之一
```
两处刻意是**字面量而不是表达式**：`KIND`（它决定读几个字节、怎么扩展、结果是 int 还是
real —— 那是类型不是值，wasm 那边它也是指令名的一部分）与 `OFF`（wasm 的 `offset=`
立即数、C 的 `p->field` 那个常量偏移；写成表达式就等于 `(mload k (bin "+" a off))`，
那本来就能写 —— 分开一格是为了让四条腿都能把它折进寻址里）。

data 段的字节也是**编译期**的：四条腿各自把它们发成自己的字面量（C 的 `static const
unsigned char`、JS 的数组字面量、LLVM 的 `private constant`）。允许表达式就等于要求
四条腿各带一个编译期求值器。

内存在**入口之前**就位，与 wasm 的 instantiate 同序：建内存 -> 拷 data 段 -> 调入口。
REPL 那一路多一格 `memEmitted`：内存只在声明它的那一批产物里被建起来，后面几批的
`mem` 是 null —— 否则第二批会把第一批写进去的字节清掉。

**量出来的。**
- `tests/mir` 36/0，新增 `unit/mem` 15 例（两条腿逐字节相同）：data 段进去了且读是小端
  （`01 02 03 04` -> 67305985）、窄读的符号扩展与零扩展、静态偏移、`i8` 存法只留低 8 位、
  MSTORE 的结果值、f32 存读、`0x80000000` 的两种读法、`msize`/`mgrow` 回旧页数/
  新页清零/上界外回 -1。
- `tests/sexpr` 78/0，新增三个：`core/36-memory`（21 行，**五条腿**逐字节相同且等于
  `.expected`）、`rt/memory-oob`（五条腿同一句
  `memory access out of bounds: 65530+8 (size 65536)`）、`bad/mload-no-memory`
  （没有 `(memory …)` 就拒，拒在降级期）。
- 越界消息的格式与指针那一路**刻意不同**：那边按元素印（裸地址在两套实现里不一样），
  这边印字节地址 + 宽度 + 总字节数 —— 线性内存里没有"元素"，而地址在三套实现里是同一个数。

<!-- 第二刀-END -->

## 落地：第三刀 —— 跳表与影子栈（两格里只多了一条 op）

决策三列了五格，这一刀收掉第 3 与第 4 格。**第 3 格加了一条 op，第 4 格一条都没加** ——
后者是这一刀真正的结论，先说它。

### `ADDR` 没有加，因为影子栈让它不必存在

决策四说过 `ADDR` 只对「已经搬进影子栈的局部量」有定义。把这句话推到底，它就不该是一条
op：`&x` = `$sp + 常量偏移`，那是一条 `ADD`，MIR 已经有了。约定是三句话：

- 一个 i64 全局当栈指针（这一刀的用例里叫 `$sp`），**向下长**，和真 ABI 一样；
- 进函数 `$sp -= 帧大小`，出函数加回去；
- 只有**真的被取过地址**的局部量落到那片字节上，其余留在 MIR 槽位里。

真加一条 `ADDR slot` 的代价是：LLVM 那条腿必须把该槽位的 `alloca` 地址交出去 ——
那还行；但 MIR 的槽位在**闭包解释器**里是帧上的一格 JS 值，它根本没有「地址」这种东西。
要么给解释器也铺一片字节（那就是影子栈，只是藏进了实现里，而且两套实现的地址会不一样），
要么让 `ADDR` 在解释器上报「不支持」（那就毁了五条腿逐字节相同这条轴）。
把它留在前端，两套实现看到的就都只是「一个 i64 加法 + 一次线性内存读写」——
同一个地址、同一个字节序、同一句越界消息。

代价也写下来：过一趟影子栈的局部量，`mem2reg` 再也提不回寄存器（决策五第 2 条就是这件事）。
所以判「哪些局部量要搬」是 C 前端的活，且要判得紧 —— 那是第六刀的题目，不是这一刀的。

### `BRTABLE`：一条 op 加一张层数表

形状照 wasm 的 `br_table`：**一张层数表 + 一个兜底层数**，不是「一组 case 值 + 一组目标」。
密集化（把 `case 3/5/7` 摊成下标 0..4、或者判定该用比较链）留给前端 —— 只有它知道 case
的取值分布。MIR 拿到的已经是「下标 -> 层数」。

层数表放在**实参池那同一个数组**里，但角色字母是新的 `'j'` 而不是 `'p'`：
里头是层数不是 ref，走 `'p'` 的话 verifier 会拿它去查支配关系、bytes.js 会把「跳第 3 层」
和「用 `%3` 那条指令」摘要成同一串字节。多一个字母比多一个池便宜 ——
多一个池就要给 `MirFunc` 加一个字段，而哈希与快照是按字段来的。

**下标按无符号读**（wasm 如此），而 i32/i64 的规范形是有符号的，于是
「无符号 `>= n`」与「有符号 `< 0` 或 `>= n`」在 `n <= 2^31` 时是同一句话 —— 两条腿都用后者。
表可以是空的（永远走兜底），wasm 也允许。

verifier 查三件事：表里每一项与兜底的层数都不超过此处的区域深度、下标是整数类型、池不越界。
第二件是会咬人的那件：`f64` 下标落进来，LLVM 的 `switch` 只收整数会当场报错，
而解释器那边 BigInt 与 Number 的比较**悄悄成立**，于是两条腿一条报错一条给答案。

两条腿的实现都把「解包」放在编译期：
- 闭包解释器在**装载期**把层数换算成 pc 表，运行期只剩「一次范围比较 + 一次数组下标」。
  不这么做就等于用一条新 op 换了个更慢的比较链，白加。
- LLVM 那条腿发一条 `switch`，下标类型跟着操作数走（i32 的下标发 `switch i32`）。
  越界走 `default`，与 wasm 语义逐条相同，所以这条腿上不必自己补范围判断。

SPIR-V 那条腿照第一刀的立场：落到 `nope('BRTABLE')`，报错而不给近似答案。

### 量出来的

同一个 64 路密集派发（同样的 case 体、同样的汇合点，只有派发那一步不同）：

- 闭包解释器：跳表 **355ms**，比较链 **620ms**（20 万次迭代，下标 `i % 64`，
  即平均要比 32 次）。差 1.7 倍 —— 比 32 倍小得多，因为解释器每一步的固定开销本来就大；
  这个数字的意思是「跳表把派发那一段的成本压到了看不见」。
- 发出来的 LLVM IR：**392 行 / 1 条 `switch` / 3 条 `icmp`** 对
  **584 行 / 0 条 `switch` / 67 条 `icmp`**。
- clang **-O0** 编到 arm64 之后：跳表那份是 **1 条 `br x8`**（真的间接跳）+ 5 条比较，
  比较链那份是 **0 条间接跳** + 67 条比较；汇编 18072 字节对 31059 字节。
  「密集 case 要跳表」这句话到这里才算被证到机器码上。
- MIR 指令数 408 对 536。

测试（`tests/mir/units/`，两条腿逐字节相同）：
- `unit/brtable` 14 行：表项重复指向同一层、表里显式指向兜底那一层、下标越界、
  下标是负数（无符号读法）、下标大到 2^32（截到 32 位再查表的实现会在这里印错）、
  下标是 i32 的 2 与 -1、表项指向 LOOP（continue）与外层 BLOCK（break）、空表。
- `unit/shadow` 4 行：把影子栈约定整个跑一遍 —— `fill(&y, 42)` 写穿地址、
  同一帧里的 `x` 不被动到、`rec(3)` 每层帧拿到自己的 8 个字节、出栈后 `$sp` 配平。
  这一条的价值在于它**没用任何新 op**：证的正是「第 4 格不需要动 MIR」。

回归：`tests/mir` 38/0、`tests/llvm` 22/0、`tests/sexpr` 78/0、`tests/oir` 607/0、
`bootstrap` 60/0、`build:self` 9/0。`tests/incr` 在这一刀的过程中露出一条**早就红了**的用例
（`insert-front`，见第四刀前半的末尾）—— 那是摇树那一刀留下的，与这一刀无关，一并修好了。
改动量：`ir.js` +22、`interp.js` +42、`verify.js` +17、`print.js` +8、`bytes.js` +3、
`backend-llvm/emit.js` +18，测试两个新文件 205 行。六个 MIR 消费者里四个是表驱动的，
所以那四处（print/bytes/verify 的池检查/verify 的层数检查）加起来 +28 行 ——
这个比例正是「一条新 op」应有的样子。

<!-- 第三刀-END -->

## 落地：第四刀（前半）—— WAT 前端接上内存与全局量

第二刀让核心方言长出了 wasm 的内存模型，五条腿逐字节比对过。但那时它只有**一个**生产者
（sx 的 `mload`/`mstore`），而那个生产者和消费者是同一天写的 —— 语义对不对没有第三方来证。
WAT 前端存在的理由本来就是这个（`frontend-wat/lower.js` 开头写着「它给了这条路径一份别人
写好的规格」），所以这一刀把 wasm 自己的写法接上去：**同一套内存语义有了第二个互不相干的
前端**，而期望值是按 wasm 规范手算的，不是从任何一条腿抄回来的。

**接上的**：`(memory MIN [MAX])`、`(data (i32.const OFF) …)`、
`(global $g [mut] T (T.const …))`、`global.get`/`global.set`、
`memory.size`/`memory.grow`，以及 load/store 那一族 20 条
（`i32.load8_u` … `i64.load32_s` … `f64.store`）加 `offset=` / `align=` 立即数。

**一张表就是全部的映射**（`MEM_LOAD_OP` / `MEM_STORE_OP`）：wasm 把宽度与符号写进指令名，
我们写进描述符，两边逐条对得上 —— 这正是第二刀「一族指令 = 一条 op + 一个描述符」那句话
的另一半。三处值得记下来：

- `i32.load` 落到 `i32s` 而不是 `i32u`。这个前端里 i32 的表示是**符号扩展后的 int64**
  （它比 MIR 的 `T_I32` 早，见文件头），所以读 4 个字节要按有符号扩展。
  `i64.load32_u` 才是零扩展的那一条 —— 而 wasm 里也**没有** `i32.load32_u`，
  与第二刀 verifier 里「满宽的读没有无符号变体」那条规则是同一件事。
- **地址要零扩展一次。** wasm 的访存地址是 i32 且**按无符号**读，而这个前端的 i32 是符号
  扩展的 —— 不补这一下，`0x80000000` 那个地址会变成负数，连越界消息里印的都是负数。
  代价是每次访问多一条 `&`；常量地址在降级时就折掉了，所以手写 wat 里绝大多数访存不付这个钱。
  C 前端（第六刀）不走这条路：它的地址是真的 `T_I32`，不需要这一步。
- `align=` 读了就丢。wasm 里它只是给引擎的优化提示、不改语义，而三套实现都不要求对齐 ——
  第二刀的描述符里刻意没有这一格，这里也就没有地方放它。
- `f32.load` / `f32.store` 不认：这个前端没有 f32（OIR 只有 double）。MIR 那一格在第一刀
  就位了，但从 OIR 到那里还缺一段 —— 那是另一刀。

全局量走的是核心方言现成的那条路（`GlobalRef` + OIR 的 `globals`），初值就是入口最前面的
几句赋值 —— 与 `sexpr/lower.js` 里 `(global …)` 的做法逐字相同，于是六个后端一行都不用改。
不可变的全局写起来会被拒，那是 wasm 校验器的规则，不是我们加的限制。

**与 WAT 规范刻意的一处不同**：`(data …)` 的字节写成字符串或 0..255 的整数，
**不认 WAT 的 `\hh` 转义**。读取器是六个前端共用的一份（`sexpr/read.js`），
它认 `\n` / `\u{…}` 那一套；加一条「两位十六进制、无前缀」的转义会同时改掉 sx 方言的词法，
而那条轴上「源码 -> 树 -> 文本 -> 树」要逐节点相同。整数写法与核心方言的
`(data OFF 字节…)` 是同一种，所以这一处不同不引入第二套概念。

**量出来的。**
- `tests/wat` 15/0（原来 12/0）。新增 `cases/03-memory`：20 行，**四条腿**
  （omni-js / omni-c / interp / interp --mir）逐字节相同且等于手算的 `.expected` ——
  data 段与小端、`offset=` 立即数、窄读的两种扩展、`i64.load32_u` 那条唯一的满宽无符号读、
  窄写只留低位、f64 原样进出、全局量读写、影子栈的形状（一个全局当栈指针）、
  `memory.size`/`grow` 回旧页数/新页清零/上界外回 -1。
- `bad/` 那一组跟着边界走：`bad/memory` 从「内存不认」改成**「访存要先有内存」**
  （边界移动了，旧的那条已经不成立），新增 `bad/global-immutable`。
  这一格是有意义的：`bad/` 的作用是钉住「哪些是刻意不做的」，边界一动它就得跟着动，
  否则它会悄悄从「刻意」退化成「忘了改」。
- 改动量：`frontend-wat/lower.js` +348，测试三个新文件。**六个后端与 MIR 一行没改** ——
  第二刀把语义放在了对的层上，这一刀才只是加一个生产者。

**这一刀的后半还没做**：表与 `call_indirect`、`br_table`、平铺栈式写法、`backend-wasm`。
前两条都卡在同一处 —— OIR 没有带标签的跳转，也没有函数表；`br_table` 要落到第三刀的
`BRTABLE` 上，就得让 WAT 前端**直接降到 MIR**（决策五说过那条路上控制流是双向无损的），
那是一条独立的路径，不是往现有降级里加几个 case。

**顺手修的一条早就红了的用例。** `tests/incr` 的 `insert-front` 断言「插一个函数只 miss 一个」，
而摇树那一刀（42c084f）之后**没人调的函数在降级前就被摘掉了** —— 于是 `inserted` 连
MIR 都没进，miss=0，断言当场不成立。更糟的是它原本要测的东西（新常量挤进模块常量池、
老函数的键不能跟着位移）也一起没了：常量根本没进池。
两处一起改：让 `inserted` 真的被调到（`print(inserted(1))`），预期改成 miss=2
（`inserted` 是新的、`omni_main` 的函数体跟着变），`f`/`g`/`caller` 三个照样 hit。
这条红是靠 `npm run test:all` 的 `&&` 链**又一次**被掩住的（incr 退出 1，后面的套件根本没跑，
而单独跑时只看 `tail -2` 恰好只看到那行统计）。所以顺手把根因也修了：
`test:all` 换成 `tests/all.js` —— 顺序不变、**一条红了也继续往下跑**，末尾印一张套件级的汇总表。
十七个套件用 `&&` 串起来这件事已经掩住过两次真实的红（js-roundtrip 那次掩了 14 个套件、
incr 这次掩了 7 个），两次都表现为「看起来全绿」。顺序执行没问题，短路有问题。

<!-- 第四刀前半-END -->

## 落地：第五刀 —— C 的词法与预处理器（oracle 是 `tcc -E -P`）

前四刀都在打地基，没碰 C 的语法。这一刀是 C 前端的第一块，也是这条线上**第一次有真
oracle**：同一份 `.c` 交给我们和本机编出来的 tcc，两份输出逐字节比。asy 那条线靠本机的
`asy`，这里靠 `.omni-cache/tcc-build/tcc`。

### 为什么词法与预处理不能拆成两遍

C 的预处理不是一层独立的文本变换，它与词法是**同一遍**。四条硬证据，每一条都会让
「先展开成文本、再词法」那种做法出错：

- `#include` 会**换掉输入流**，而 `__LINE__` 要拿到换之前那个文件的行号；
- `##` 粘出来的字节要**重新过一遍词法**（`tccpp.c:3139` 为此临时开一个叫 `:paste:` 的
  输入）—— `a ## b` 粘成一个标识符，`+ ## +` 粘成一个 `++`；
- 函数式宏要**跨行去找它的 `(`**（`tccpp.c:3163` 的 peek_file），找不到就不是一次调用，
  而已经读过的空白要原样吐回去；
- `#` 与 `##` 在宏体里是记号，在行首才是指令 —— 差别只有词法器知道。

所以结构照 tcc：`nextNomacro()` 出记号，`next()` 在它上面套宏展开，**指令由词法器在行首
看见 `#` 时回调进 `preprocess()`**（`tccpp.c:2622-2631`）。

### 记号流的表示：一处刻意的不同

tcc 把记号流存成 `int` 数组，带值的记号把值**变宽编码**在后面几格里
（`tccpp.c:1079-1139`），于是「下一个记号在哪儿」要靠 `tok_size()` 算。那是 C 里没有更好
选择时的做法。这里用**两个等长的平行数组**（`toks[i]` / `vals[i]`）：下标就是记号序号。
代价是每个不带值的记号多占一格 `null`；换来的是所有「往前看第 n 个记号」的地方
（`##` 的处理、实参切分、`#` 后面跟的是不是形参）都变成一次数组下标，而 tcc 那边每一处
都得 `while ((t2 = ptr[n]) == ' ') ++n` 地摸过去。语义等价。

**记号编号照抄**（`tcctok.js`）。tcc 的前端靠**区间判断**工作：`tok < TOK_IDENT`（256）是
运算符，`TOK_IDENT <= tok < TOK_UIDENT` 是关键字，`TOK_ASSIGN_OP(t)` 干脆是
`"+-*/%&|^<>"[t - TOK_A_ADD]`（`tcc.h:1169`）—— **顺序本身被当数据用了**。换一套编号这些
判断就得逐条改写成集合查询，那是另一份代码、另一批 bug。

### 三处「照抄才对」的细节

这一刀真正花时间的不是那 1200 行，是这几处「按常理会写错、逐字节比对当场抓住」的地方：

1. **`-P` 下行首的空白照印。** 一开始想当然地把它清了（「-P 不是不印行号标记吗」），
   于是所有缩进消失。量了 tcc：`    int    b;` 出来还是 `    int    b;`，一个字节不差 ——
   `pp_line` 在 `-P` 下什么都不做，而攒在 `white[]` 里的空白**不经过它**（`tccpp.c:3948`）。
2. **`, ## __VA_ARGS__` 要把逗号后面那个空格放回去。** tcc 在往回退到逗号之前先记下
   最后一个输出记号（`tccpp.c:3056` 的 `int c = str.str[str.len - 1]`），非空实参时
   `if (c == ' ')` 再补一个。少了这一格，`printf("%d\n" , 7)` 会印成 `,7` —— 语义没变，
   但逐字节比对就是要抓这个。
3. **`#line 200 "renamed.c"` 里的相对路径要接在真文件所在的目录后面**
   （`tccpp.c:1769` 的 tccpp_putfile）。所以 CFile 上要有 `trueFilename`：`#line` 能改
   `filename`，而 include 的「当前文件所在目录」与下一次 `#line` 都按真路径算。

还有一处是自己的：`0u` 一开始解不出来 —— 前缀那个 `0` 被当八进制摘掉了，只剩 `u`，
一个数字都没有。八进制的前缀**不能摘**。

### `#if` 的求值器是自己写的

tcc 把这件事交给 tccgen 的 `expr_const()`（`tccpp.c:1501`）—— 它复用整个 C 的表达式解析器。
我们还没有那个东西，所以自带一个只管整数的。这不是偷懒：`#if` 的算术在标准里就只有
intmax_t，字符串与浮点都要报错（`tccpp.c:1449`）。两条容易漏的：
**无符号性会传播**（`#if -1 > 0u` 是**真**），字符常量按 **signed char** 算
（`#if '\xff' < 0` 成立 —— 量过 tcc 在本机是这样）。`&&` / `||` / `?:` 要短路，
不然 `#if 0 && (1/0)` 会因为除零报错。

### 第一阶段的边界（刻意的，全部报错而不是给错答案）

每一条都对应一个 `cpp-bad/` 用例：

- **输出格式只有 `-P` 那一种**（不发 `# 行号 "文件"` 标记）：`pp_line` 那套「差 8 行以内
  补空行、否则印行号标记」要跟 include 层级联动，是独立一格。
- **`__DATE__` / `__TIME__` 不认**：值随时钟走，进不了逐字节比对的轴。`__LINE__` /
  `__FILE__` / `__COUNTER__` 都认。
- **`#include_next` 与 `__has_include` 不认**：前者要记住「上一次是在第几个搜索目录里
  找到的」（`tccpp.c:1363`），后者要把 include 搜索接进 `#if` 的求值。
- **没有系统头目录**：`#include <...>` 只在 `-I` 给的目录里找。libc 头文件的接法是
  第八刀第二片；**预定义的宏是第八刀第一片，已落地**（见下面那一节）。
- 三字母词（trigraph）不认 —— tcc 也不认，这一格不是我们的边界。

### 量出来的

- **`tests/c` 20/0**（新套件，进了 `tests/all.js` 与 `test:c`）：
  - `cpp/` 六份与 `tcc -E -P` **逐字节相同**，共 143 行输出。**没有 `.expected` 文件** ——
    期望值就是 tcc 的输出，写死一份反而会在 tcc 升级时骗人。
  - `inc/01-include` 一份：`"..."` 与 `<...>` 两条搜索路径、`#ifndef` 守卫与
    `#pragma once` 两种跳过、嵌套 include 的相对路径、`#undef` 掉守卫之后真的再读一遍、
    「算出来的 include」。
  - `cpp-bad/` 十三份：五条阶段边界 + 八条真错误，每一条都拒在正确的理由上。
  - tcc 不在时整组**跳过而不是假过**（印 skip 并说明怎么建）。
- **一份 15001 行、宏用得很密的合成文件**（1000 组 `##`/`#`/`#if`/`__LINE__`），
  输出 4000 行，我们与 tcc **逐字节相同**。速度：
  - 我们 **16.4ms**（中位数，进程内，预热两趟）≈ **916k 行/秒**
  - tcc **13.4ms/趟**（20 趟 0.267s，含进程启动 2–3ms）≈ **1.1M+ 行/秒**

  也就是这一层大约是 tcc 的 **0.7 倍**，不是 ADR 里预留的「差 10 倍也接受」那一档。
  这个结果不奇怪：预处理是字符串与哈希表的活，JS 引擎在这上面不吃亏；真正会拉开差距的
  是第六刀（值栈上直接发码）与后端。
- 代码量：`tccpp.js` 2100 行、`tcctok.js` 198 行、`tests/c/` 二十六个文件。
  `cli.js` +50（`cpp` 子命令 + `-D`）。**六个后端与 MIR 一行没改** —— 这一刀的产物是文本，
  还没接上降级。tcc 那边对应的是 `tccpp.c` 的 3961 行，而我们少掉的主要是它的分配器
  （TinyAlloc）、CString 与手写哈希表 —— 那些在 JS 里是引擎的活。

### 顺手修的一条

`cli.js` 挑源文件时那张「带值的开关」表里没有 `-I` 与 `-D`（`cli.js:1679`），
于是 `cpp -I dir x.c` 会把 `dir` 当成源文件。`.jnc` 那一路的 `-I` 本来就有同一个毛病
（`sx -I dir x.jnc` 一样中招），一并修掉；`tests/jnc` 145/0 照旧。

<!-- 第五刀-END -->

## 落地：第六刀第一片 —— 一遍过的降级器（oracle 是 `tcc -run` 的退出码）

### 先纠一个方向上的偏差

这一片写完时我把「只有 int 与 void」「没有指针」「没有 printf」写成了阶段边界。
**那个框架是错的**，先把对的写在这儿，后面每一片都按它走：

- **printf 与 libc 躲不过去。**终点是「能编译 tinycc 自己的全部源码」，那份源码里
  `printf`/`memcpy`/`malloc`/`setjmp` 一个都不少。所以外部符号不是「以后再说」，而是
  MIR 要长出来的一格：现在的 `CCALL` 挂在 `hir/c_abi.js` 那张**封闭表**上
  （JS 域刻意只开那么几个口子），C 需要的是**任意符号 + 任意签名 + 变参**。
  这一格补完之后，`printf` 在三条腿上各有各的解法，而且都不是假的：
  C/LLVM/自带后端把它当真符号交给链接器，闭包解释器要一层「读线性内存的 libc 垫片」
  （就是 wasm 运行时对 WASI 做的那件事 —— 格式串在线性内存里，垫片照 C 的语义解释它）。
- **MIR 只是其中一种形式。**汇编器、代码生成、链接三件都要自己做（分步的 9-11），
  `tcc -run` 的等价物是**内存里生成机器码然后跳进去**，不是「解释 MIR」。
  这一片用 MIR 那条腿只是因为它现成、能当 oracle 用；它不是 C 前端的归宿。
- **别的语言也会接进来**，入口是 s-expr 或 MIR。所以 MIR 上加的每一格都要问一句
  「这是 C 特有的，还是所有语言共用的」——`CCALL` 长出真签名属于后者。

于是第六刀的分片按「解锁能力」排，不按「语法书的章节」排：

1. **这一片**：`int`/`void`、局部量、C 的全部优先级、`if/while/do/for/break/continue`、
   自定义函数与递归。**已落地。**
2. 类型系统长齐：`char`/`short`/`int`/`long`/`unsigned`、指针、数组、`typedef`、
   `sizeof`；被取过地址的局部量搬上**影子栈**（第三刀已经把约定钉好了）；
   字符串字面量进 data 段。
3. `struct`/`union`/`enum`、成员访问、初始化式、位域。
4. `switch` -> `BRTABLE`（第三刀那条 op 就是为它加的）、`goto`。
5. 全局变量、`extern` 声明、可变实参 -> `CCALL` 长出真签名 + 解释器的 libc 垫片。
   **`printf` 在这一片跑通**，于是 oracle 从「退出码」升级成「stdout 逐字节」。
6. 之后接分步 9-11：arm64 编码器 / 代码生成 / 链接 + 内存里执行。

### 一遍过、没有 AST

`tccgen.c` 与 `tccpp.c` 是同一遍：语法分析器一边从 `next()` 取记号，一边发目标码，
中间没有树。`src/core/frontend-c/tccgen.js` 照这个结构：`Cpp` 是记号源，`CGen` 一边
解析一边 `f.emit(...)`。优先级表（`tccgen.c:6506-6524`）、`expr_infix`（6536）、
`expr_landor`（6570）、`expr_cond`（6608）、`expr_eq`（6738）、`gexpr`（6757）、
`block`（7177）、`decl`（8747）逐个对应，出处注在实现旁边。

`Cpp` 上补了两个方法：`startParse`（对应 `tccgen.c:417` 那行
`parse_flags = PREPROCESS | TOK_NUM | TOK_STR`）与 `captureTokens`/`pushTokens`
（tcc 的 `TokStr` 本来就干这件事：inline 函数体、`#if` 的表达式、宏体都是先收后放）。

### 三处刻意的偏离

1. **没有 `vtop` 值栈。**tcc 的 `SValue` 栈存在的理由是**延迟寄存器分配**，而 MIR 没有
   寄存器 —— 一条指令的 ref 就是那个值。所以解析函数**返回**一个值记录，不往全局栈上压。
   保留的只有真正带语义的两格：`VT_LVAL`（左值，`gv` 时才发 LOAD，于是 `a = 5` 不多出
   一条没人读的 LOAD）与 `VT_CMP`（`tccgen.c:1028`：比较结果不急着摊成 0/1，于是
   `if (a < b)` 只有一条 `LT`，而 `x = a < b` 才走「临时槽 + IF/ELSE」那条路）。
2. **控制流是结构化的，不是跳转加回填。**tcc 用 `gjmp()` 发待回填的跳转、`gsym()` 回填；
   MIR 只有区域标记加层数，指令不能重排。`if`/`while`/`do` 的形状照
   `mir/from_oir.js` 已经钉好的那几套（两个降级器发同一种形状，读代码的人只记一份）。
   代价落在 `for` 上：**步进式写在循环体前、要在循环体后跑**，只能先把记号收起来、
   循环体之后再放一遍。这是这一片唯一一处「因为 MIR 而必须绕」的地方，也正是上面
   「MIR 只是其中一种形式」那句话的第一个实例 —— 自带后端那条路上它会退回成一条跳转。
3. **不折常量。**`gen_opic` 在解析时就把 `1+2*3` 算成 7。这里不折：MIR 的消费者本来就会折，
   而折叠**语义可见**（`1/0` 折了是编译期错误、不折是运行期错误），先记下来不做。

### 入口与退出码

MIR 的入口必须叫 `omni_main`（LLVM 后端自己会发一个 C 的 `main`）。所以 C 的 `main`
照原名进模块，另发一个 `omni_main`：`RET CALL main()`。`MirInterp.run()` 因此改了三行 ——
**入口的返回值就是进程退出码**，只留低 8 位（`wait(2)` 的规矩，`return -1` 于是是 255）。
既有五个前端的入口是 `T_VOID`，那条路一个字节没变。

这就把 oracle 白送了：`tcc -B .omni-cache/tcc-build -run x.c` 的退出码，与
`omni c-run x.c` 的退出码逐条相同。整条轴**不需要 libc**，printf 是第 5 片的事。

### 量出来的

- `tests/c` 22/0（原来 20/0）。新增 `gen/` 一组两份：
  `01-expr`（80 行，退出码 139）—— 优先级与结合性、一元、比较当整数用（C 的 0/1）、
  短路真的短路（右边有副作用才看得出来）、`a || b && c` 的分组、三元右结合、
  十个复合赋值、前后缀 `++`/`--`、逗号表达式、`int` 的 32 位回绕、`(int)` 强制转换；
  `02-stmt`（100 行，退出码 149）—— `if/else if/else`、`while` 的 continue 与 break、
  `while (n)` 的非零条件、`do-while` 至少跑一遍、do-while 里 continue 去测条件、
  `for` 的四种写法（三段齐全 / C99 声明式初始化 / 三段全空 / 步进段是逗号表达式）、
  嵌套循环里 break 与 continue 只作用于最内层、内层作用域遮蔽、循环体里每轮新变量。
- 改动量：`tccgen.js` 新文件 730 行、`tcctok.js` +50（语句与类型关键字的导出 +
  `TOK_ASSIGN_OP` 那张字符串）、`tccpp.js` +55（`startParse` + `captureTokens`）、
  `interp.js` +8（退出码）、`cli.js` +40（`c-mir` / `c-run`）。
- `tests/mir` / `tests/sexpr` / `tests/wat` 不受影响：退出码那三行只对
  「入口不是 T_VOID」的模块生效，而那三条轴上的入口都是 T_VOID。

<!-- 第六刀第一片-END -->

## 落地：第六刀第二片 —— 整型的宽度与符号（`CType` 的等价物）

第一片只有 `int` 与 `void`，类型是两个常量。这一片把类型层换成真的：
`frontend-c/ctype.js` 是 tcc `CType` 的等价物，`tccgen.js` 整个压在它上面。

### 为什么类型是「一个整数加一个引用」

tcc 的 `CType` 只有两格：`t`（32 位位域）与 `ref`。这不是省内存的小聪明，是让整个前端能靠
**位运算**回答类型问题 —— `(t & VT_BTYPE) == VT_PTR`、`IS_ENUM(t)`、`t & VT_UNSIGNED`。
其中最省事的一条是 `VT_ARRAY` **同时带着 `VT_PTR`**（`tcc.h:1062` 那句括号）：
「数组退化成指针」在绝大多数判断里因此**不用写代码**，问「是不是指针」时数组自动答是。
位分配照抄（`tcc.h:1044-1104`）—— 它是数据，改一位就是改一门语言。

`VT_STRUCT_MASK` 在 JS 里是**负数**（`0xFFF00080` 越过 int32 的正区间），位模式与 C 相同，
`isEnum`/`isUnion` 量过都对。这一处写在实现旁边，因为下一个人看到负数一定会怀疑。

### 窄整数在寄存器里是什么样（这一片最要紧的一条不变量）

`char` / `short` / `_Bool` 在 MIR 里都是 `T_I32`，而且**永远处在规范形**：有符号的符号
扩展过、无符号的落在 `0..2^n-1`。tcc 与 wasm 都这么做（`tcc.h` 里根本没有 8/16 位的
寄存器类）。这条不变量买到两件事：

- **整型提升不发任何指令** —— `char` 提到 `int` 只是换一个 CType，位一个都不动；
- 宽度只在两处看得见：存进内存（`MSTORE` 的描述符）与显式转换（`CVT_SEXT8/16`）。

反过来，任何产生窄类型值的地方都**必须**收口回规范形，而收口只在 `castTo` -> `narrow`
一处。无符号窄化走一次 `BAND 0xff` 而不是新加一个 `ZEXT8` 模式：「零扩展 8 位」就是
按位与，MIR 已经有 BAND 了。

### 三处 C 明文规定、合并就会错的地方

1. **移位不做常规算术转换。**两边**各自**整型提升，结果类型是左操作数提升后的类型，而
   「算术右移还是逻辑右移」看**左**操作数的符号性。合进 `usualArith` 会让
   `(unsigned char)x >> 1` 变成无符号右移 —— 提升之后它是 `int`，该是算术右移。
2. **64 位上的符号性只看本来就是 64 位的那个。**`unsigned int` 与 `long long` 相遇是
   `long long`（它装得下全部 uint），`unsigned long long` 与 `long long` 相遇才是无符号。
   合成一句「有一个无符号就无符号」会把前者判错，而它错的时候只有 `-1` 那种边界值看得出来。
3. **有原型时形参不做实参提升。**`char c` 形参就是 char，是**调用方**把实参转成声明的类型
   （C11 6.5.2.2 第 6 段；实参提升只对无原型与变参的可变部分成立）。这一格搞反过一次：
   形参提成 int 之后 `int f(char c){return c;}` 里的 c 不再收口，`f(300)` 回 300 而不是 44。

### 常量一律收成 MIR 的规范形

`18446744073709551615ULL` 进常量池是 `-1`，`4294967295u` 是 i32 的 `-1` ——
T_I32/T_I64 的规范形是有符号两补（`ir.js:75`），无符号性挂在**算子**上
（ADR-0016 第六十一刀），不挂在位上。这一格错过一次：字面量按 `asUintN` 存进去，于是
`(long long)ull == -1` 在解释器里比的是 `18446744073709551615n` 与 `-1n`，判假。
逐位比对当场抓住，二分到那一行只花了一个循环（`head -n K` + 补 `return s % 251; }`
再两边跑 —— 这个法子对「一个字节的总和」型用例特别好用，记在这儿）。

### `sizeof` 与 `nocode_wanted`

`sizeof 表达式` 要「算出类型但不求值」。tcc 用全局的 `nocode_wanted` 计数器；这里的
等价物是**把 `this.f` 换成一个用完就丢的 MirFunc** —— 表达式照样解析、指令照样发，
只是发进了一个没人要的函数里。比给每个 emit 加分支干净，代价是槽号白涨，而那个函数
马上被丢掉，所以不涨真的。

### 量出来的

- `tests/c` 28/0（原来 25/0）。新增 `gen/03-inttypes`（125 行，退出码 219）：
  `sizeof` 的九种写法（含不带括号的与 `sizeof(dummy + 1L)`）、说明符乱序
  （`long unsigned` / `int unsigned` / `long long int`）、`char` 与 `short` 的收口与符号、
  整型提升（`char + char` 在 int 里算、`sizeof(a1+b1)==4`、一元负号也先提升）、
  无符号比较（`-1 > 0u`、`(long long)-1 < 1u`）、有符号除法向零取整与无符号的另一套算子、
  两种右移、`long long` 的移位与无符号除、七种显式转换、`_Bool` 的「非零就是 1」、
  三元两支的常规算术转换、复合赋值与前后缀在窄类型上的收口、窄返回值与实参转换。
  新增 `gen-bad/float`（浮点这条边界）与 `gen-bad/short-long`（真类型错误 ——
  钉住说明符循环真的在核对，而不是见到什么都按位或上去）。
- 两条旧的边界用例（`gen-bad/pointer` / `switch`）**跟着红了**，因为报错文本从
  「第六刀第一片没有 X」统一成了「第六刀：X 还没到」。这正是 `bad/` 那一组存在的理由：
  边界一动它就得跟着动，否则会悄悄从「刻意」退化成「忘了改」。
- 改动量：`ctype.js` 新文件 190 行，`tccgen.js` 730 -> 1010 行，`tcctok.js` +1
  （`_Bool` 的记号号）。`gen/01-expr` 与 `gen/02-stmt` **一个字符没改就照旧通过** ——
  类型层换掉而行为不变，这是这一片最想要的那个证据。
- `js-roundtrip` 108/0（新文件也过自解析定点）。

<!-- 第六刀第二片-END -->

## 落地：第六刀第三片 —— 指针、数组、影子栈、字符串字面量

这一片把「地址」这件事接上：`&`、`*`、下标、指针算术、多维数组、字符串字面量进 data 段。
`tests/c` 29/0（新增 `gen/04-pointer.c`，136 行，退出码 156 与 `tcc -run` 相同），
`js-roundtrip` 108/0。

### 一个一遍过的编译器怎么知道「谁需要地址」

这是这一片唯一真正难的问题。`&x` 要求 `x` 落在线性内存上，可「哪些局部量被取过地址」
写在声明**后面** —— 一遍过没法后看。

tcc 不需要回答这个问题，因为它的答案是「全都要」：所有局部量都在栈帧上（`loc -= size`），
寄存器只是表达式的临时。而「帧有多大」它在函数体读完之后**回填**进序言（`gfunc_prolog`
与 `gfunc_epilog` 之间那次改写）。

MIR 不能回填（第六刀第一片的偏离 2）。序言里 `$sp -= frameSize` 那个常量必须在发它之前
就定下来。三条路：

1. **全部上栈**，像 tcc。那就不用知道谁被取地址了 —— 但帧大小仍然要提前知道，而且所有
   局部量都变成 MLOAD/MSTORE，后端再想把它们提回寄存器就得做一遍 mem2reg。
2. **记号层扫一遍**，找 `&` 后面跟的标识符。快，但会漏 `&*p`、`&a[i]` 这类，也会被宏
   骗到；而「漏」在这里的后果是第二遍里 `&x` 撞上一个还在槽里的名字。
3. **函数体解析两遍**。第一遍发进一个用完就扔的 `MirFunc`（与 `sizeofExpr` 的
   `nocode_wanted` 等价物同一手法），收集 `addrTaken` 与帧大小上界；第二遍才是真的。

选 3。理由是它**用的是解析器本身**：`&` 走的是同一条 `addrOf`，所以第一遍收到的名字集合
与第二遍会问的问题严格同源，不存在「扫漏了」这一类。为此给 `Cpp` 加了 `captureBraced()`
（收一整个配平的 `{…}`，含两端花括号）—— tcc 的 `skip_or_save_block` 存 inline 函数体
是同一件事。

代价是函数体解析两遍。收益量得出来：`gen/04-pointer.c` 六个函数里**只有两个有帧**，
`sum3`/`bump`/`strlen2`/`swap2` 的序言一条指令都没有（它们的指针都是形参，不用取地址）。
`down` 的帧 16 字节，`main` 96 字节。如果走路 1，这六个函数全都要序言，
而 `main` 的 11 个槽会全部变成内存访问。

第一遍还顺手给出帧大小的**上界**：数组之类「非落内存不可」的当场就算进去，标量则先记进
一张表，等这一遍读完、`addrTaken` 齐了再把命中的那些加上。上界而不是精确值，是因为
同名遮蔽（两个不同块里的 `x`）在名字集合里只有一个条目 —— 多算是安全的，少算不是。

### 平铺的帧：为什么不复用兄弟块的空间

帧里一个声明一个偏移，块结束时**不回退**分配指针。复用能省空间，但要么在块结束时回退
（于是循环体里 `$sp` 每轮都动，`&x` 在两轮之间不是同一个地址），要么做一次活跃区间分析
（那就不是一遍过了）。平铺让每个声明的地址在整个函数里恒定，代价是帧大一点 ——
`main` 那 96 字节里有一部分是这么来的。

用例里专门有一段钉这件事：

```c
for (i = 0; i < 5; i++) {
  int k = i * i;
  int *kp = &k;
  acc += *kp;
}
```

### 指针就是字节偏移，不是 `T_PTR`

指针在 MIR 里是 `T_I64`，一个线性内存里的字节偏移。**不用** ADR-0016 的 `T_PTR`/`T_TPTR`
——那两个带范围检查、一块一块地分配，是「一个对象一个指针」的视角；C 要的是「一整片可
寻址的字节」。决策四早就说这两者是同一件事的两个视角，C 前端取后者。

于是三条规则各自只有一两条指令（`genPtrOp`）：

- `p + n`：n 转 i64、乘元素大小、加。元素 1 字节时不发那条 MUL —— 那不是常量折叠
  （偏离 3 说不折），是不发一条无操作。
- `p - q`：两个偏移相减再除元素大小，结果是 `ptrdiff_t`。
- 比较：**无符号**。C 只定义同一个对象内的指针比较，而同一个对象内的偏移都是正数；
  这个选择也要与将来的后端一致（地址不是负数）。

`a[i]` 直接写成 `*(a + i)`（C11 6.5.2.1 第 2 段），一行代码换来三件事自动正确：
`i[a]` 也对、数组与指针一视同仁、多维数组自动是「先退化外层」。用例里 `1[a]`、
`m[1][2]`、`sizeof(m[0]) == 12` 各钉一条。

### 内存的版图

- `[0, 64K)`：页 0 整页留空。C 的 `NULL` 于是**一定**访问不到，而不是碰巧落在别的东西上。
- `[64K, dataOff)`：data 段，字符串字面量（以后是全局量），往上长。
- `[栈底, 栈顶)`：影子栈，16 对齐，`$sp` 从栈顶往下长。1 MiB。

`$sp` 是一个 i64 全局，初值在 `omni_main` 里用一条 GSTORE 写 —— 解释器的全局初值是
`undefined`（`interp.js:216`），而 wasm 那边的 `(global $sp (mut i64) (i64.const …))`
是同一件事的静态写法。收场（把 `$sp` 还回去）在**每条 RET 之前**，而且在返回值算完
之后：反过来会让 `return *&x` 读到已经归还的那段栈。

字符串字面量的类型是 `char[N+1]` 而**不是** `char *` —— 于是 `sizeof("abc")` 是 4，
用在表达式里再退化成指针。这一格用指针的话 sizeof 会变成 8，而那是最难发现的那种错。

### 抓到的两个错

**一、提升一个左值时先换了类型码。** `promote` 原来只改 `ty` 那一格、把 `slot`/`mem`
原样带过去。看着很对（`(int)c` 之后 `c` 还是左值），但**宽度只在访问那一刻有意义**：
`gv` 按 `v.ty` 选 MLOAD 的描述符，而 `ty` 已经被换成 `int` 了。于是

```c
char *t = "hello";
s += t[1];
```

发出来的是 `mload i32 %5 i32s` —— 该是 `i8s`。它读了 4 个字节，`t[1]` 的值变成
`"ello"` 拼出来的数。修法是提升时先按**原**类型取值：`return sVal(TY_INT, this.gv(v))`。
只问类型的地方（`funcCall` 定形参类型）改用一个不发指令的 `promotedType`。

这个错是逐位比对抓到的，而抓它的过程本身值得记：第一次二分（每个截断点比
`s % 251`）说「没有分岔」，因为退出码只有 8 位、`% 251` 撞上了。改成每个截断点比
`(s >> 0/8/16) & 255` 三次，第一处分岔当场出来。**单字节的 oracle 要多取几个字节才够用。**

**二、`v.mem !== null` 对 `undefined` 是真。** 上面那个 `promote` 返回的对象漏了 `mem`
这一格，于是每个提升过的值都走进了内存左值那一支，`v.mem.addr` 当场炸。JS 里
`undefined !== null`，所以「少一个字段」与「字段是 null」在这类判断上行为相反 ——
四个构造函数（`sVal`/`sLval`/`sMem`/`sCmp`）现在都把五格写全。

### 边界移动了，钉它的用例跟着红

`gen-bad/pointer` 原来钉的是「指针还没到」。这一片做出来之后它红了 —— 那正是这一组存在的
理由。换成 `gen-bad/paren-decl`（`int (*a)[3]`，带括号的声明符还没做到）。

还没到的：struct/union/enum、typedef、聚合初始化器、带括号的声明符与函数指针、浮点、
`switch`/`goto`、全局变量、外部符号与变参。下一片是**全局变量 + 外部符号 + 变参** ——
`CCALL` 要长出任意符号与任意签名，闭包解释器要一个读线性内存的 libc shim。
printf 在那一片跑通，oracle 从退出码升级成 stdout 逐字节。

<!-- 第六刀第三片-END -->

## 落地：第六刀第四片 —— 全局量、`typedef`、`extern`

`tests/c` 32/0（新增 `gen/05-global.c`，退出码 145 与 `tcc -run` 相同；新增两条边界
用例），`js-roundtrip` 108/0。

### 全局量：地址是编译期常量，零初始化不花一个字节

第三片已经有了 data 段（字符串字面量在里面），全局量就是同一片地方的另一批住户：
声明时按对齐划一块，地址是一个编译期常量，`entryLval` 的等价物 `gvarLval` 回一个
`sMem(ty, konst(addr), 0)`。于是**全局量不用影子栈** —— 它的地址不依赖任何运行期的值。

`int zero;` 与 `int tab[8];` 这种没有初始化式的**一个字节的 data 都不写**：线性内存
出生时全是 0（`memInit` 分配的 ArrayBuffer 就是零），而 C 正好规定静态存储期的对象
零初始化（C11 6.7.9 第 10 段）。这条让「一份有几千个全局量的源码」不会把 data 段
撑成几千段初始字节 —— tinycc 自己的源码正是那个量级。

初始化式**必须是常量表达式**（C11 6.7.9 第 4 段）。这一条正好与「主路上不折常量」
那条偏离和解：折叠不在主路上，但 C 本来就要求这些位置是常量，所以这儿走的是第三片
为数组维度写的那个独立小求值器 `constExpr`。值在编译期算完、写成小端字节进 data 段 ——
运行期一条指令都没有，与 tcc 把它放进 `.data` 是同一件事。

`char *s = "abc";` 也在这条路上：值是那个字面量在 data 段里的地址。在真的目标文件里
这是一条重定位，我们的「链接」是一个常量，所以它就是一个 8 字节的数。

### `extern`：一遍过里「没定义」这个问题只能最后答

`extern int x;` 之后没有定义，是链接期的错。我们只有一个翻译单元，所以「用过但没定义」
当场就该是错 —— 但一遍过里**引用发生在定义之前**，代码得先有一个地址可发。所以：
声明时照样分配地址（`defined = false`），引用时打一个 `used` 记号，
`unit()` 读完整个单元之后再检查。与函数那条 `undefined symbol` 检查同一个理由、同一个位置。

`gen-bad/extern-undef` 钉住这条。它钉的**不是**「还没做到」而是一条真的诊断，
所以做到链接期符号那一片时它要么保持红、要么换成「链接时找不到」，反正不能变绿。

### `typedef`：C 的语法在这一处不是上下文无关的

`(T)*x` 是强制转换还是乘法，取决于 `T` 是不是一个类型名。这是 C 那条著名的
「typedef 名与标识符不可分辨」。tcc 靠符号表当场断（`parse_btype` 里查带 `VT_TYPEDEF`
的那条符号，`tccgen.c:4880` 一带），我们照做：`isTypeStart` 对标识符查一张 `typedefs` 表。
**路径 A 的 GLR 到这儿会把两种解析都留着**，两条路在这一格的差别正是第七步要对账的东西
之一 —— 先记在这儿。

`parseBtype` 里那条规则要写准：`typedef` 名**只在还没有基本类型时**才吃。否则
`int x;` 里的 `x` 会被当成类型名（如果恰好有一个同名 typedef）。判断顺序就是答案。

两个容易掉的格子：

- `typedef int V[4];` 之后 `V a;` —— `count` 挂在 CType 对象上而不在 `t` 里
  （ctype.js:129），所以「把 typedef 的类型接过来」与「剥存储类」两处都得手工带上它。
  少一句 `sizeof(V)` 从 16 变 8，而 `V a; a[3] = …` 仍然编得过 —— 它写到了别人身上。
  为此把「剥存储类」收成一个 `stripStorage` 函数，四处调用共用它。
- `typedef unsigned char byte;` 之后 `(byte)(-1)` 要是 255。这走的是既有的
  `castTo` -> `narrow`，说明第二片那条「收口只在一处」的纪律在类型别名上照样成立。

### 一处**不能**拿 tcc 当 oracle 的地方

我们让同一份文本的字符串字面量共享同一段 data，tcc 不共享。C 没规定
（C11 6.4.5 第 7 段：字面量是否有独立存储未指定），所以 `msg2 == msg` 两边都对 ——
这一格写进用例会让它红，而红的原因不是谁错了。用例里把它换成读字节，并在旁边注明
**这条不能比**。逐位对账的纪律要配一份「哪些位不该对账」的清单，这是第一条。

### 下一片

struct/union/enum 与聚合初始化器（`gen-bad/agg-init` 钉着它），然后是外部符号与变参 ——
`CCALL` 要长出任意符号与任意签名，闭包解释器要一个读线性内存的 libc shim。printf 在那一片
跑通，oracle 从退出码升级成 stdout 逐字节。

<!-- 第六刀第四片-END -->

## 落地：第六刀第五片 —— 外部符号、变参、libc（oracle 从 1 字节升到几百字节）

这一片只做一件事：让 `printf("%d\n", x)` 跑通。收益不在 printf 本身，在**测量手段**：
在此之前一份用例只能通过 `main` 的返回值说话，8 位，一次比较 1 字节；这一片之后
一份用例能拿几百字节的 stdout 跟 tcc 逐字节对。`gen/06-libc` 是 `exit 6 + 346B stdout`——
同一份文件钉住的东西多了两个数量级。所以它排在 struct 前面：**按解锁能力排**。

### 调用点不该知道「这个函数在别处」

一遍过降级器里，`f(1)` 出现的时候我们**还不知道** f 是本单元定义的、是原型声明过的、
还是根本没声明。三种情况在真的编译器里走的都是同一条路（tcc 也是：`external_sym`
先造一个符号，`.o` 里留一条重定位，链接时才决定），所以这里也让**调用点只发 CALL**，
用一个 `funcSym(name)` 造出 `{no, f, params, ret, defined, declared, variadic}` 占位。

到 `unit()` 末尾，谁没有函数体谁就是外部符号，给它补一个**转发桩**：

```
puts:  load $p0 -> ccall "puts"($p0) -> ret
```

于是「外部」这件事被压进一个 4 条指令的函数体里，`CALL n` 那一侧一个字节都不用改。
代价是每次外部调用多一层跳转 —— 这一片不在乎，因为真正的链接（分步 11）会把它换掉，
而换掉的时候要动的只有 `externThunk` 一个函数。

**变参装不进桩**。桩是一副固定形参，而 `printf` 的每个调用点实参个数都不同，一个桩
装不下两个调用点。所以变参走另一条：调用点**直接发 `CCALL`**。这也解释了为什么
`funcCall` 里那个分支不是「优化」而是必须的。相应地，在 C 里**定义**一个变参函数
还没到（要 `va_list`/`va_arg`），`funcDecl` 里当场报错钉住。

### 隐式声明与实参个数

没见过原型的函数照 C89 的老规矩办：`info.params === null` 表示「不知道签名」，
实参按**默认实参提升**（数组退化、窄整型升 `int`）自己定形参表，并在 `unit()`
末尾 warn 一句 `implicit declaration of function 'f'`。见过原型的就检查个数 ——
变参函数比的是「不少于命名形参数」，非变参比的是相等。

这里有一格值得记：判断「第 i 个实参该转成什么类型」时不能用 `promote(v)`，那是个
**会发指令**的函数，问一句类型就白发一条 LOAD。为此拆出纯函数 `promotedType(ty)` /
`decayedType(ty)`。「查询」与「生成」在一遍过降级器里必须是两个函数，这条纪律
在第二片的 `castTo` 上已经出现过一次了。

### 为什么不能直接转手宿主的 libc

分步 8 里写的是「先转手宿主的 libc，走既有的 extern-C FFI」。这一片做下来发现
**转手不成立**：我们的指针是**自家 ArrayBuffer 里的字节偏移**，宿主的 `puts` 收到
`65536` 会去读它自己进程的第 64K 字节。指针一进 libc，两个地址空间就对不上了。

所以 libc 必须是一个**读写我们线性内存**的宿主模块 —— 也就是 wasm 那边的
`(import "env" "puts" …)`，一模一样的结构。`src/core/interp/libc.js` 就是它：
`readCStr(addr)` / `writeCStr` 走 `mem` 的字节，`callLibc(name, args)` 是唯一入口。
放在 `interp/` 而不是 `frontend-c/` —— 一开始放错了，那会让 `mir/interp.js` 依赖前端，
方向是反的：libc 属于**执行侧**，跟哪个前端产生的 MIR 无关。

`cFormat` 是这个文件的主体。`%[flags][width][.prec][len]conv`，逐条按 C11 7.21.6.1 写，
最容易错的是**填充顺序**：精度先作用在数字上，然后加符号与 `0x` 前缀，最后才补零或补空格。
`%+05d` 给 `42` 要出 `+0042` 而不是 `0+042` —— 这一格错了整行 stdout 就歪，而
oracle 会立刻指出来。这正是把 oracle 升级成逐字节的回报：`pad` 的三步顺序不是推理出来的，
是被 tcc 的 stdout 逼出来的。

`strcmp` 特意返回**字节差**而不是 `-1/0/1`：C 只规定符号，但用例里如果写
`printf("%d", strcmp(a,b))` 就得跟宿主 libc 一样。凡是「C 只规定符号/未指定」的地方，
只要它能被 stdout 看见，我们就跟 glibc 对齐 —— 否则用例没法逐字节比。

### 「不该对账」的清单加了两条

第四片记下第一条（共享字符串字面量）。这一片加两条：

- **`%p`**。地址空间不同，两边永远不一样。用例里不用它。
- **浮点**。前端还没有浮点，`cFormat` 碰到 `%f/%e/%g` 当场报「第六刀」。

`callLibc` 抛出的异常在 `interp.js` 的 `CCALL` 分支里被 `failRt` 接住并带上函数名 ——
于是「libc 里哪一格没做」和「MIR 哪条不支持」是两种不同的报错文本。

### 下一片

struct/union/enum 与成员访问、位域，然后是聚合初始化器（`gen-bad/agg-init` 与
`gen-bad/paren-decl` 各钉一边）。堆（`malloc` 那一族）等它们 —— `malloc` 要一个
能被 C 侧看见的分配器，而分配器自己最好用 struct 写。

<!-- 第六刀第五片-END -->

## 落地：第六刀第六片 —— struct / union / enum 与成员访问

`gen/07-struct` 是 `exit 66 + 134B stdout`，第一次跑就与 tcc 逐字节相同。这一片没有
「调试到对」的过程，值得记的原因正在这儿：布局是**数据**，抄准了就一次过。

### 一个 tag 只有一个对象

`tagOf` 里那条纪律是这一片的地基：**同一个 tag 全程共用一个 info 对象，定义时往里填，
从不换**。它买到的是 C 的不完整类型：

```c
struct Later;                        /* fields: null 的空壳 */
struct Holder { struct Later *next; int n; };
struct Later { int deep; };          /* 往同一个对象里填 */
```

`Holder.next` 手上那份 CType 指着那个空壳，成员表后来填进去，它自动变完整。换成
「定义时新建一个 info」就得回头去修所有已经发出去的类型 —— 一遍过时那做不到，
所以这不是省事，是唯一可行的形状。

`struct S s;`（不完整还要当对象）由 `needComplete` 在**声明那一刻**报错，与 tcc 同时机：
后面才出现的 `struct S {…}` 补不上这一格。

### 布局是数据，抄准就完了

成员按声明顺序排、各自对齐到自己的对齐、整体对齐取最大、整体大小向上对齐 ——
四句话，union 是同一段代码的另一支（偏移全 0，大小取最大）。用例把 `sizeof` 与
四个成员偏移都 printf 出来：

```
sizeof Point=8 Mixed=32 Nested=20 Bits=8
off i=4 d=8 q=16 s=24
```

`struct Mixed { char c; int i; char d; long long q; short s; }` 于是被钉死在 32 字节 ——
少写一句「整体大小向上对齐」它就是 26，而 `Mixed a[2]` 会开始互相踩。偏移是用
`(char *)&m.i - (char *)&m` 量出来的，不是靠信任编译器印一个数。

### 成员访问一条指令都不多

`s.f` 与 `p->f` 是**同一段代码**（C11 6.5.2.3 第 4 段：`p->f` 就是 `(*p).f`），
箭头那侧只在开头多一次解引用。关键的一格是成员偏移**加进静态偏移**而不是发一条 ADD：

```js
cur = sMem(fld.ty, base.mem.addr, base.mem.off + fld.off);
```

于是 `n.a.x` 与 `h.next->deep` 都是一条 `mload`。第三刀把静态偏移放进访问描述符
（`sMem` 的 `off`）时写的注释是「于是 `p->f` 不多一条加法」—— 三片之后那句话兑现了，
而兑现它只用了一个加号。

### struct 赋值：把 memcpy 摊开

C 规定 struct 赋值是整块字节的拷贝（6.5.16.1）。大小是编译期常量，所以 `structCopy`
直接摊成几条 8/4/2/1 字节的 load+store：8 字节的 `Point` 是一条，20 字节的 `Nested`
是三条。不发 `memcpy` 调用、不给 MIR 加一条块拷贝指令、不生成循环。

前提是两侧都在内存上，而 `needsMem` 加了 `isStruct` 之后这不是巧合而是保证 ——
所以那一支里写的是「internal:」而不是一个用户可见的错误。

一个容易掉的格子：搬字节时读要用**无符号/满宽**的那格（`i8u` 而不是 `i8s`）。用
`i8s` 时 `0x80` 会被符号扩展成 `0xffffff80`，存回去低 8 位仍然对，但中间那条指令的
值不再是「一个字节」—— 错的时候看不出来，直到有人去读那个中间值。

### enum：一边登记一边求值

枚举常量是**普通标识符**（与 tag 不在一个名字空间），作用域是包着 enum 的那个作用域，
不是「enum 内部」。所以 `enum {A, B = A + 2}` 要求 `A` 立刻可见 —— `enumDecl` 一边
`enumConsts.set` 一边 `constExpr`，而 `ceUnary` 里加一格查 `enumConsts` 就闭环了。
`int arr2[BLUE + 2];` 走的正是这条路。

C 的四个名字空间（C11 6.2.3）在这一片第一次真的用上：`tags` 必须与 `typedefs` /
`gvars` 分开存，否则 `struct S { int S; } S;` 里那三个 S 会互相覆盖。

### 划出去的两格

- **位域**（`gen-bad/bitfield` 钉着）：要用 `VT_BITFIELD` 那两个 6 位段记「偏移与宽度」
  （`tcc.h:1077-1104`），读写多一层移位与掩码。
- **struct 传值 / 返回**（`gen-bad/struct-byval` 钉着）：这是 **ABI**，不是前端 ——
  arm64 上 ≤16 字节走两个寄存器，再大是调用方分配一块传地址。在分步 9-11 之前
  先猜一个形状，猜错的代价是整条调用约定要重写。传指针（`sum(&p)`）这一片就能用，
  少的只有「按值」那一格。

### 下一片

位域，然后聚合初始化器（`gen-bad/agg-init` 钉着）—— 有了 struct 布局，`{1, 2}` 才有
「往哪儿写」可言，两者的顺序不能反。

<!-- 第六刀第六片-END -->

## 落地：第六刀第七片 —— 位域

`gen/08-bitfield` 是 `exit 104 + 190B stdout`，与 tcc 逐字节相同。这一片有两个真的坑，
都值得记。

### 布局：两格状态，三句规则

位域的布局不能用「当前偏移」一格状态描述 —— `int a:3; int b:5;` 两个成员的 `off`
**相同**，差别只在「从第几位起」。所以状态是两格，和 `struct_layout`（`tccgen.c:4190`）
一样：

- `c` —— 已经排到第几个字节
- `bitPos` —— 从 `c` 起这一串位域用掉了几位

PCC（也就是 gcc）的规则是「紧挨着前一个位域放」，除了两种情形要换一个新的存储单元：
宽度是 0，或者放下去会**越过它自己的基类型容器**。第二种那句判断照抄
（`tccgen.c:4274`）：

```js
const a8 = align * 8;
const ofs = Math.floor(((c * 8 + bitPos) % a8 + bits + a8 - 1) / a8);
if (ofs > size / align) newUnit = true;
```

它算的是「从当前位置起这个位域要横跨几个 align 单位」，超过基类型本来占几个就换。
`struct Cross { unsigned a:30; unsigned b:5; }` 于是是 8 字节而不是 5 —— 用例把它
印出来钉住。另外三句也各有一条用例钉着：普通成员进来先把没排完的位冲成整字节
（`struct Mix` = 8）、匿名位域**不影响**整体对齐（`struct Pad`）、PCC 模式下装得下的
`long long` 位域按 `int` 算（`struct LL` = 8）。

### 读：两条移位，不是掩码

读一个位域是**左移再右移**：先把要的那几位顶到最高位，再移回来。有符号用算术右移，
于是符号扩展是免费的 —— `int a:3` 里存 7，读出来是 -1。

写成 `(x >> pos) & mask` 也对，但那样有符号的还要**另写一次**符号扩展，于是同一件事
两条路。这和第二片那条「收口只在 `castTo` 一处」是同一个判断标准：宁可一条路多两条
指令，不要两条路各对一半。

写是读改写：`容器 = (容器 & ~(mask << pos)) | ((值 & mask) << pos)`。掩码运算一律
按无符号做 —— 位一样，但不必每次都想一遍「这里会不会被符号扩展带歪」。

`s.a = 300` 那个 3 位的字段该存 4，所以 `storeBitfield` 回的是**左值本身**而不是
存进去的那个值：让读那一侧走 `gvBitfield`，「截断」就只在一处实现（tcc 靠 `vdup`
把左值留在栈上，同一个用意）。

### 第二条不变量：位域信息只能挂在左值上

位域的「第几位、几位宽」挤在 CType 的位里（和 tcc 一样，`tcc.h:1087-1088`），好处是
它跟着类型走，不必给 SValue 加一格。代价是一条纪律：**一旦取过值，类型上就不能再
带着它** —— 否则下一次 `gv` 会以为自己还得去内存里读一遍，而手上已经没有地址了。

这一格连着错了两次，而且两次的现场都是同一句「位域左值不在内存上」：

1. `incdec` 里 `sVal(target.ty, old)` 把位域类型套在了一个已经取出来的值上；
2. `castTo` 回 `sVal(ty, …)` 时 `ty` 是 `promotedType` 传进来的**位域类型**（`btype`
   是 `VT_INT`，所以那个函数原样退回），于是 printf 的实参上炸。

修法是把「位域取过值之后是什么类型」收成一个函数 `bfValTypeOf`，并在三处
（`promote` / `castTo` / `incdec`）过它。第二条比第一条难找，因为它要经过
`promotedType` 这个**看起来只问类型**的纯函数 —— 纯函数也会把不该传递的信息传递下去。

### 一个 union 的坑

union 那一支里 tcc 只算大小与偏移，**不填 `bit_pos`**（`tccgen.c:4238`）——照抄的时候
很容易连「打上位域标记」这件事一起省了。省掉之后 `u.a` 成了一个普通的 unsigned 成员，
读出来是整个容器：`0xABCDE` 而不是低 3 位的 6。逐字节的 oracle 一行就指出来。

### 划出去的那一格

`__attribute__((packed))` 与 `#pragma pack` 没做，所以「位域跨过它自己的容器」那条
按字节读写的路（`load_packed_bf` / `store_packed_bf`）也没做 —— 布局那一侧保证了
跨不过去，`gvBitfield` 里留了一句 internal 断言守着这条前提。

`&f.a` 报 `cannot take address of bit-field`（C11 6.5.3.2 第 1 段）。这是**真的诊断**，
所以 `gen-bad/bitfield-addr` 那条用例与 `extern-undef` 一样，不是「还没到」的钉子。

### 下一片

聚合初始化器（`gen-bad/agg-init` 钉着）：`{1, 2}`、`char s[] = "…"`、嵌套的
`{{1,2},{3,4}}`、指定初始化器。有了 struct 布局与位域，「往哪儿写」才都有答案。

<!-- 第六刀第七片-END -->

## 落地：第六刀第八片 —— 聚合初始化器

`gen/09-init` 是 `exit 96 + 159B stdout`，第一次跑就与 tcc 逐字节相同。

### 一份代码同时管静态与自动

全局量的初始化式往 data 段写字节、值必须是常量表达式（C11 6.7.9 第 4 段）；局部量的
要发 MSTORE、值是任意表达式。这两件事看着很不一样，但**不一样的只有最里面那一层怎么
落地** —— 「怎么走这棵嵌套结构」（哪个元素对哪个偏移、designator 之后从哪儿接着排、
union 只初始化一个成员）完全相同。

所以 `initializer` 收一个 `dest`，三种形状：data 段的绝对地址、线性内存的基址 ref、
MIR 的槽。tcc 也是这么合的（它靠 `c >= 0` 区分 data 与代码）。分成两份的代价是
`{{1,2},{3,4}}` 那套遍历规则要写两遍，而它们迟早会在某个边角上不一致 —— 用例正是
按这个判断来写的：**每一种写法都在全局与局部各来一遍**，两条路必须给同一个答案。

局部量的初始化式**不必是常量**（`int dyn[3] = {n, n*2, n+100}`），这是两条路真正的
差别，也在用例里。

### 没写出来的那些要是 0

C 规定聚合初始化式只覆盖写出来的那些，剩下的按静态存储期的规则置 0（6.7.9 第 21 段）。
静态那一侧**免费** —— 线性内存出生就是 0（第四片那条「零初始化不花一个字节 data」
在这儿又收了一次利息）。自动这一侧要发指令：`autoZero` 先把整块清零，再写给出的那些。

先整块清零、而不是「算出哪些没被覆盖再补零」：后者省几条指令，但要在 designator 与
嵌套之下维护一张「覆盖到哪儿了」的表，那张表是错误的温床。`int lpart[5] = {7,8}`
于是是 5 条清零加 2 条写，多花 3 条 store 换掉一张表。

### 不定长数组：鸡生蛋，用记号解

`int a[] = {1,2,3}` 要先知道长度才能划地方，而长度写在后面。一遍过没法后看，所以
和函数体那两遍（第三片）一样：把 `{…}` 的记号整块收下来（`captureBraced`），先数一遍
再放一遍（`replayBraced`）。

但**数的那一遍不必真的解析**：顶层元素个数在记号层面就数完了 —— 深度 1 上的逗号数
加一，末尾多余的那个逗号不算。这比 tcc 的做法轻（它真的跑一遍 `decl_initializer`），
代价是 designator 数不了（`{[3]=1}` 的长度是 4 而不是 1），所以那一格当场报「还没到」。

`char s[] = "a" "b"` 走另一条：相邻的字面量要拼起来，所以只能真的读一遍，读完记号
已经吃掉、字节留在手上 —— 于是这条路先算出 `char[3]` 再声明。

### 三个 C 的边角，各一条用例

- `char gtight[3] = "abc"` 是**合法**的：装不下的那个结尾 0 直接丢掉（6.7.9 第 14 段）。
  少这一条会把一个常见写法判成错。
- union 只初始化一个成员（6.7.9 第 17 段），没有 designator 时是第一个。
- 标量外面套一层花括号合法：`int one = { 42 };`（6.7.9 第 11 段）。

### 划出去的那一格

嵌套聚合**省掉里层花括号**（`int a[2][2] = {1,2,3,4}`）没做，`gen-bad/agg-init` 从
「聚合初始化器还没到」换成钉这一格。要支持它，`initArray` 得把「这一层还没吃完的
元素」交给下一层接着吃，那是一套跨层的游标；写全花括号的那条路不需要它。
静态位域的初始化式（要按位往 data 里并，`tccgen.c:7938`）同样留着。

### 下一片

`switch` → `BRTABLE` 与 `goto` —— 结构化控制流下这两个各要一套办法，而 MIR 的
`BRTABLE` 从第三刀就等在那儿了。

<!-- 第六刀第八片-END -->

## 落地：第六刀第九片 —— switch（没有跳转，怎么做贯穿）

`gen/10-switch` 是 `exit 33 + 38B stdout`，第一次跑就与 tcc 逐字节相同。这一片是
「不许有跳转」那条偏离（文件头偏离 2）被逼到极限的地方，也是它第一次真的还有赚。

### 形状：层层嵌套的 block

tcc 的 switch 是「每个 case 记一条待回填的跳转，最后统一 patch」。我们没有跳转也不
回填，所以换 wasm 那个形状：

```
BLOCK break
 BLOCK L3          ← 第三个标签
  BLOCK L2
   BLOCK L1        ← 第一个标签，最里层
     分派
   END             ← 跳到这儿 = 第一个标签的代码
   L1 的代码
  END              ← 第二个标签
  L2 的代码
 END
 L3 的代码
END                ← break 跳到这儿
```

**贯穿自动就对**：L1 的代码走完自然落到 `END L2` 后面，也就是 L2 的代码。C 的 switch
默认贯穿，而这个形状不用为它写一行 —— 一个标签就是「关掉一层 block」，`caseLabel`
的全部内容是 `close()`。`break` 也不用特殊照顾：区域标签本来就叫 `'break'`，
`levelOf('break')` 一问就得到正确的层数，而 `continue` 会自动穿过这些 block 找到外面
那个循环。用例里 `inloop` 专门钉这一格：同一个 switch 里 `continue` 归 for、
`break` 归 switch。

`default` 不必在最后 —— 它就是这一列标签里的一个，兜底跳它那一层；没有 `default`
就兜底跳 break 那一层。用例 `middef` 把 default 放中间，而且它后面的标签照样贯穿到。

### 代价：分派要在函数体之前发

而那时还不知道有几个标签。一遍过又撞上第三片那堵墙，办法也一样：函数体的记号整块
收下来（`captureBraced`），先扫一遍收标签，再放一遍真的做。

扫那一遍**只走记号**：不解析语句，于是不声明局部量、不占帧、不发一条指令。这一点是
必须的而不是优化 —— 帧的大小是在函数那一层的两遍里数出来的，这儿多数一次就会数歪。
唯一真的要解析的是 `case` 后面那个常量表达式，而 `constExpr` 本来就不发指令。

里层 switch 的 case 属于它自己，所以扫的时候整块跳过（`skipBalanced`）。

### 两条分派路，跟 tcc 同一个判断

- **密**（`BRTABLE`）：下标是 `v - min`，表里第 i 格是「值 `min+i` 该去哪一层」，
  空格填兜底。门槛写成两个字面量：表不超过 1024 格、平均每格至少 1/8 个 case。
- **疏**（比较链）：一串 `BRIF (v == ci) -> 那一层`，最后 `BR -> 兜底`。
  `case 1: case 1000000:` 走这条 —— 密集表会是 4 MB。

`BRTABLE` 的下标按无符号与表长比（ir.js:301），所以 `v < min` 会绕成一个大数、自动
落到兜底。但**还是要先发一条区间检查**：64 位的值截成 32 位下标时，差 2^32 的两个值
会撞在同一格。用例 `wide` 里 `case 0` 与 `case 4294967296LL` 正是这一对 —— 少那条
检查，`wide(4294967296LL)` 会回 1 而不是 2，而这种错在 32 位的用例上永远看不出来。

case 的值还要按控制表达式**提升之后的类型**收口（C11 6.8.4.2 第 5 段），否则
`switch ((char)x) { case 256: }` 里的重复挑不出来。

### 划出去的两格

- **`goto`**：嵌套 block 那一招吃得下 switch，是因为它的目标都在**同一个方向**（往外跳）。
  goto 可以往回跳 —— 那要在外面再套一圈循环、开头按状态分派，是独立的一片（第十片做了）。
- **case 标签长在里层的控制结构里**（Duff's device）：「关掉一层」会关错对象，当场报错。

### 下一片

`goto`。它是这条轴上最后一个控制流的坑，而 tinycc 自己的源码里到处是
`goto redo;` / `goto again;`，躲不过去。

<!-- 第六刀第九片-END -->

## 落地：第六刀第十片 —— `goto` 与语句标签

`goto` 是**任意跳转**，而这条路上没有跳转（tccgen.js 头偏离 2）。第九片把 switch 做成了
「层层嵌套的 block，一个标签关掉一层」，那一招吃得下 switch 只因为 switch 的目标都在
**同一个方向**（往外跳）。`goto` 要能往回跳，而结构化控制流里**往回跳只有一种写法**：
跳到一个 `LOOP` 的开头。于是这一片就是在第九片那个骨架外面套一圈循环、加一个状态槽。

### 形状

带标签的**复合语句**变成一台状态机：

```
BLOCK gotoend
 LOOP gotoloop
  BLOCK Lk ... BLOCK L1 BLOCK entry
    BRTABLE state -> [entry, L1, ..., Lk]
  END(entry)         ← 状态 0 落在这儿 = 第一个标签**之前**那一段
  seg0
  END(L1) seg1 ... END(Lk) segk
  BR gotoend         ← 走完最后一段，出去（而不是掉回循环开头）
 END(gotoloop)
END(gotoend)
```

- 状态槽在进块时清零，`state == i` 对应第 i 个标签，`0` 是正常入口。
- `goto Li` = 「写状态 i+1」+「`BR` 到那个块的 `LOOP` 层」。往外层块的标签跳也一样：
  `gotoStack` 从内往外找，找到谁就写谁的槽、跳谁的 `LOOP`。
- **贯穿依旧免费**：每一段走完自然落进下一段，与 switch 同一个理由。
- `break` / `continue` / `return` 一行没改 —— 区域栈（`regions`）多了三个名字
  （`gotoend`/`gotoloop`/`label`），层数是数出来的，所以它们自动算对。

代价是诚实的：**往前跳与往回跳一样贵**（一次写状态、一次分派）。tcc 那边往前跳是一条
待回填的 `gjmp`，比这个便宜；自带后端那条路上这一层会退回成真的跳转。

### 前向引用：白拿函数体本来就有的那两遍

分派要在块的第一条语句**之前**发，可那时还没见到后面的标签 —— 与第九片同一堵墙。但这次
不必再收一遍记号：函数体本来就要解析两遍（偏离 4，为了 `&x`）。两遍走的是**同一串记号**，
所以同一个复合语句在两遍里的**序号**（`blockNo`）一定相同：

- 第一遍：`labelSink` 是一叠数组，栈顶是最内层的块；`labelStmt` 把名字推进栈顶，
  整块记进 `blockLabels[bn]`，同时进 `funcLabels`（整个函数的标签名，重名当场报）。
- 第二遍：按同一个 `bn` 取回来，进块时就知道有几个标签、顺序是什么，分派于是发得出来。

一句话：`goto` 的前向引用**没有额外成本**，它蹭的是取地址那一遍。

### 划出去的两格（都钉着）

- **`goto` 跳到不在外围块上的标签**（`gen-bad/goto`）：分派只能把控制送到那个块自己那一层，
  而「跳进一个 block 的中间」在结构化控制流里没有写法。C 允许（标签的作用域是整个函数），
  所以这是边界不是错误 —— 要做得把两个块合成一台状态机（relooper 那一路）。
  报错分得清两种情况：函数里根本没这个标签是**真错误**，有但不在外围块上才是边界。
- **标签长在里层的控制结构里**（`gen-bad/goto-duff`，Duff's device）：「关掉一层」会关错
  对象。与 `case` 那一条是同一个判断、同一处理由。

### 量出来的

`tests/c/gen/11-goto.c`：退出码 218 + 59B stdout，与 `tcc -run` 逐字节相同。十个用例
钉住十个形状：往回跳（`goto again;`）、往前跳、从循环里跳出去、一个块上五个标签互相跳、
里层块的标签 + 从里层跳到外层、`goto fail;` 那个收尾形状、**标签与局部量同名**
（C 的四个名字空间，C11 6.2.3）、switch 里跳到 switch 外、循环里当 continue 用、
两层循环一把跳到最外面。

`tests/c` 41 passed / 0 failed，`tests/js-roundtrip` 109 passed / 0 failed。

### 下一片

struct 的**传值与返回**（`gen-bad/struct-byval` 钉着）。它是第一片真的要碰 ABI 的 ——
「按值传一个 struct」在 MIR 里没有对应的东西，得先决定是拆成寄存器还是走一块内存 +
隐藏的返回指针，而那个决定要与将来 arm64/x64 的调用约定对得上。

<!-- 第六刀第十片-END -->

## 落地：第六刀第十一片 —— struct 的传值与返回

MIR 的实参与返回值都是**标量**，而 C 能按值传一整个 struct、也能返回一整个 struct。
这一片定的是前端这一层的约定（真的 ABI 是后端那几步的事）。

### 约定

- **传值传地址**：调用方给出实参那个对象的地址，**拷贝由被调方在入口处做**。
- **返回走隐藏的第一个形参**：调用方在自己帧上划一块、把地址当第一个实参传进去；被调方
  把返回值拷进去，再把这个地址返回。RET 于是照旧只带一个 i64 —— SysV 用 rax 回同一个东西。

「拷贝落在被调方」这一条是想清楚的，不是随手定的：C 说形参是实参的**一份可改的拷贝**
（C11 6.9.1 第 10 段），所以那次拷贝是**必须**发生的。放在调用方就要拷两次（调用方拷一份
临时对象、被调方直接用），放在被调方只拷一次，而且语义一模一样 —— 被调方改形参改的是
自己帧上那份，调用方那个对象一个字节都不动（用例里 `bump` / `bigsum` 钉着这一点）。

拷贝本身白拿第六片的 `structCopy`：大小是编译期常量，所以展成 8/4/2/1 的 MLOAD+MSTORE，
没有循环、没有 memcpy、不依赖 libc。

### 三处改动，加起来不到八十行

- `funcCall`：返回 struct 就先 `frameAlloc` 一块、地址塞成 `refs[0]`，调用的结果是
  **那块地方的左值**（`sMem(ret, r, 0)`，用回来的 ref 而不是手上的地址 —— 让「返回值在
  哪儿」这件事记在数据流里）。struct 实参走 `addrOf` 而不是 `gv`。
- `runBody`：返回 struct 的函数多一个 `$sret` 形参（第 0 个）；struct 形参进来是地址，
  在入口处 `frameAlloc` + `structCopy` 拷成自己帧上的一份。
- `return`：拷进 `$sret`、返回那个指针。拷贝在 `emitEpilogue` **之前** —— `return s;` 里
  的 `s` 就在自己帧上，先把 `$sp` 还回去再拷是在拷一块已经归还的栈。

帧上多划的那两块（调用方的返回临时、被调方的形参拷贝）**两遍都划**，于是第一遍数出来的
帧一定装得下它们 —— 两遍走同一段代码这条纪律（偏离 4）在这儿又付了一次红利。

### 划出去的一格

**外部符号那一侧的 struct 传值/返回**（`gen-bad/struct-byval` 钉着）。这个约定只在自家人
之间成立：桩要把实参原样转给宿主，而我们的 struct 是自家线性内存里的一个偏移，宿主读不到
—— 与第五片「转手宿主 libc 不成立」同一个理由。要等真的调用约定落地。

### 量出来的

`tests/c/gen/12-struct-abi.c`：退出码 140 + 44B stdout，与 `tcc -run` 逐字节相同。
钉住的形状：8 字节与 28 字节两种大小、改形参不影响调用方、`mk(5,6).y` 这种直接用返回值、
`bump(bump(p))` 套着调、形参取地址（`&p`）、嵌套 struct / union / 位域都按字节拷、
递归里每层各有自己那块返回地方（`walk`）、全局 struct 当实参（地址是编译期常量）、
实参是成员（`w.p`）或解引用（`*&p`）。

`tests/c` 42 passed / 0 failed，`tests/js-roundtrip` 109 passed / 0 failed。

### 下一片

**带括号的声明符**（`gen-bad/paren-decl` 钉着）：`int (*a)[3]`、函数指针。它是纯解析的
一片（`declarator` 要能递归），但解锁的是 tinycc 自己源码里到处都有的那些表 ——
`static const struct { const char *name; int (*fn)(void); } table[] = {…}`。

<!-- 第六刀第十一片-END -->

## 落地：第六刀第十二片 —— 带括号的声明符

声明符里有三段：前缀的 `*`、括号里的那一层、后缀的 `[]` 与 `(形参表)`。后缀绑得更紧，
所以 `int *a[3]` 是「3 个 `int *`」、`int *f(void)` 是「回 `int *` 的函数」——
**括号是唯一能翻转这个次序的东西**，于是 `int (*a)[3]` 才是「指向 `int[3]` 的指针」。

### 洞在函数里，不在数据里

tcc 的 `type_decl` 递归下去时手上只有一个**半成品**类型：里层的 `*` 已经知道，可它指向
什么还没读到。tcc 的办法是先建一个带洞的 CType，解析完外层再顺着 `ref` 链走下去把洞补上。

我们的 CType 建好就不改（`mkStruct` 那一条纪律的另一面），所以反过来：`declaratorParts`
回一个**函数** `wrap(base) -> ty`，外层把自己攒出来的类型喂给里层的 `wrap`。一层里的
次序写成一行就是

```
wrap(base) = inner.wrap( 后缀倒着套( 前缀的 * 套完( base ) ) )
```

三个例子按这一行读：

- `int *a[3]`：pre=1、posts=[[3]]、没有 inner -> `*` 先套成 `int*`，再套 `[3]`。
- `int (*a)[3]`：外层 posts=[[3]]、inner 是 `*a` -> 先套成 `int[3]`，交给 inner 的 `*`。
- `int (*f[3])(void)`：外层 posts=[(void)]、inner 是 `*f[3]` -> 先成函数类型，
  inner 的 `*` 套成函数指针，inner 的 `[3]` 再套成「3 个函数指针」。

### 那个 `(` 是分组还是形参表

位置本来就分得开：形参表只跟在名字（或者里层那一组）**后面**。抽象声明符是唯一的例外
—— `int (*)(void)` 的第一个 `(` 是分组，`int (void)`（一个函数类型）的那个是形参表。
所以只在声明符**开头**那一处看一格（`isGroupParen`）：后面是类型的开头、`)` 或者 `...`
就是形参表，别的都是分组。看一格靠的是 `ungetTok`，与 `funcDecl` 里判断 `(void)`
用的是同一手法。

### 顺带被拆开的两件事

- 形参表的解析从 `funcDecl` **搬进了声明符**（`funcParams`）。于是「这是函数定义吗」
  不再问「下一个记号是不是 `(`」，而是问**类型**：`isFunc(d.ty.t)`。这正是 C 自己的
  判断方式，也是 `int (*fp)(void)`（一个变量）与 `int fp(void)`（一个函数）唯一的差别。
- `sameType` 对函数类型改成**结构性**比较：`int (*)(int)` 每写一次都是一个新的 ref
  对象，而 C 说这两个类型相同（C11 6.7.6.3 第 15 段）。struct 那边正相反 —— 一个 tag
  一个对象，比引用就够。两条规则在同一个函数里并排放着，各自注了理由。

### 划出去的一格

**通过函数指针调用**与**取函数地址**（`gen-bad/paren-decl` 钉着）。类型这一片已经有了，
少的是 MIR 的**间接调用**：现在的 `CALL` 的 a 字段是函数表下标，一个编译期常量
（ir.js:211）。加一条 `CALLI`（wasm 的 `call_indirect`）是独立的一片，而且它同时解锁
wasm 那条路上的函数表 —— 分步 4 里那一格也在等它。

### 量出来的

`tests/c/gen/13-paren-decl.c`：退出码 187 + 25B stdout，与 `tcc -run` 逐字节相同。
钉住的形状：`int (*p)[3]` 与 `int *q[3]` 并排（少一个括号就是另一个类型）、
`char *(*r)[2]`、`int (**pp)[3]`、struct 成员上的两种、形参是 `int (*a)[3]`（于是
`a[i][j]` 按一行 3 个走）、形参是函数指针、**回指针到数组的函数** `int (*pick(int))[3]`、
强制转换与 `sizeof` 里的抽象声明符（8 / 24 / 8 / 12 / 24 五个数）、`int (y) = 9`
（括号套在名字上什么都不变）、指向数组的指针的算术（`rp++` 跳一整行、`rp - a2`）。

`tests/c` 42 passed / 0 failed，`tests/js-roundtrip` 109 passed / 0 failed。

### 下一片

MIR 加**间接调用**（`CALLI`），把函数指针真的打通。它不只是 C 这一条腿的事：
wasm 那条路上的 `call_indirect` 与函数表用的是同一个东西，所以这一片是**跨层**的 ——
`ir.js` 的算子表、文本形式、字节形式、verifier、闭包解释器都要跟着动一格。

<!-- 第六刀第十二片-END -->

## 落地：第六刀第十三片 —— 函数指针（MIR 多了一条 `CALLI`）

这一片是**跨层**的：C 这一侧要的是「通过指针调用」，而 MIR 只有直接调用
（`CALL` 的 a 是函数表下标，一个编译期常量）。所以先给 MIR 加算子，再让前端用它。

### MIR：`CALLI`

```
['CALLI', 'r', 'p', '-']    // a = 函数指针值，b = 实参池，t = 返回类型
```

三个决定，各自有理由：

- **a 是「函数指针值」而不是函数号**：`0` 是空指针，非 0 的是「函数号 + 1」
  （`fnPtr` / `fnPtrNo`）。偏这一格是 C 逼出来的 —— C 要求空指针的位模式是 0，而 0 号
  函数是一个真函数。编码放在 MIR 这一层，于是两个消费者不会各挑一种「什么算空」。
- **不带类型索引**。wasm 的 `call_indirect` 带一个 type index，装载期就能查签名；MIR
  没有函数类型池，硬加一个只会多出一处「两个消费者各自解释」的地方（ADR-0014 的纪律）。
  签名是**前端**的责任（C 的类型系统在编译期就说完了），MIR 只在运行期查两格：
  不是空、下标在范围内。
- **接在算子表尾**，与无符号那七条同一个理由：opcode 就是表的下标。

改动只落在三处：`ir.js` 的表 + 两个小helper、`interp.js` 一个 case。文本形式、字节形式、
verifier 都是按算子表驱动的，所以一行都不用改 —— 这正是那张表存在的意义。

### 前端：一条纪律换掉六个特例

**函数指示符是一个「函数类型的内存左值」，它的「地址」就是那个函数指针值。**

这一句话（`unary` 里三行）让下面六种写法共用同一条路，一个特例都不用写：

- `f`、`&f` —— `decay` / `addrOf` 各一行（`&f` 与 `f` 的值相同，C11 6.5.3.2 第 3 段）
- `*f`、`**f` —— 解引用一个函数指针又回到「函数类型的内存左值」，形状不变
- `fp(x)`、`(*fp)(x)` —— `postfix` 的 `(` 那一支把两副面孔归一成「函数类型 + 一个 ref」

`gv` 里那一行与数组的那一行并排：**函数与数组都在这儿退化成指针**（C11 6.3.2.1 第 3、4
段）。放在 `gv` 而不只放在 `decay`，理由与数组一样 —— `gv` 是「我要一个值」的必经之路，
漏一处就会 MLOAD 一个函数。

直接调用照旧发 `CALL`。只有真的经过指针才发 `CALLI`，所以常见情形一条指令都没多。
实参那一段（读、按原型转、struct 的两条 ABI）抽成 `callArgs`，两条调用路共用 ——
否则「struct 传值」这条规则就会有两份，而它们迟早会分岔。

### 顺带解锁的一格：函数指针表

`static int (*tab[])(int) = { twice, thrice };` —— 函数名是**地址常量**（C11 6.6 第 9
段），所以常量求值器（`ceUnary`）也认它：回那个函数指针值。tinycc 自己的源码里到处是
这种表（`static const struct { const char *name; int (*fn)(); } …`），所以这一格不是
锦上添花，是躲不过去的。

### 划出去的两格

- **通过函数指针调变参函数**（`gen-bad/fnptr-variadic`）：变参走的是 `CCALL`（第五片），
  而 `CCALL` 的 a 是 C ABI 入口号 —— 也是编译期常量。要么再加一条「间接的 CCALL」，
  要么让 `CALLI` 认宿主符号，两条都得先想清楚 wasm 那一侧的形状。
- **函数类型的 typedef**（`gen-bad/fnty-typedef`）：`typedef int cb(int);` 之后 `cb` 能当
  声明符的基本类型，于是「这是函数定义吗」要从展开之后的类型上问。指针形
  （`typedef int (*cb)(int);`）已经能用，而那才是 tinycc 自己在用的写法。

### 量出来的

`tests/c/gen/14-funcptr.c`：退出码 94 + 29B stdout，与 `tcc -run` 逐字节相同。
钉住的形状：六种写法调同一个函数、`&f` 与 `f` 同值、与函数名/与 0 比较、静态函数指针
与静态函数指针表、局部函数指针数组按下标分派、回调形参（`int (*fn)(int)` 与写成函数
类型的 `int fn(int)` 两种拼法）、struct 成员上的函数指针、**回函数指针的函数立刻调用**
（`chooser(1)(2)` 与 `(*chooser(2))(3)`）、`void (*)(int *)` 改调用方的局部量。

`tests/c` 45 passed / 0 failed，`tests/js-roundtrip` 109 passed / 0 failed，
`tests/mir` 38 passed（`lower/cli.js` 那一条早就红着 —— 见下面「欠着的账」）。

### 欠着的账：C 前端还不是「方言干净」的

`tests/mir` 里的 `lower/cli.js` 是「用 Omni 方言编译整个编译器自己」那一条，它现在红着：
`ctype.js` 的 `isPtr` / `isStruct` / `isEnum` 与 `frontend-jnc/lower.js` 撞名、
`ir.js` 的 `typeText` 与 `ctype.js` 撞名、`tccgen.js` 的 `TOK_ARROW` 与 `tcctok.js` 撞名
（方言不许同名的模块级声明）。这几个名字是**刻意照 tcc 起的**，所以改名要连着注释里的
出处一起改，是一次独立的清扫 —— 记在这儿，别让它烂在那儿。

### 下一片

**浮点**（`gen-bad/float` 钉着）：`float` / `double`、算术与比较、与整型的互转、
`printf` 的 `%f/%e/%g`。它是「能编译 tinycc 自己」路上剩下的最大一块类型面 ——
tinycc 的 `tccgen.c` 里浮点常量折叠、`long double` 的 80 位布局都要它。

<!-- 第六刀第十三片-END -->


## 落地：第六刀第十四片 —— 浮点（`float` / `double`）

`float` 与 `double` 是这一片；`long double` **不是**（往下的边界，见「划出去的三格」）。

### MIR 那一侧本来就有的与这一片补上的

`T_F32` / `T_F64`、`f32`/`f64` 的访问描述符、`CVT_I2F` / `CVT_U2F` / `CVT_FCVT`、
`f32` 的算术（`bin32f`）与比较早就在（ADR-0005/0017 第一刀）。这一片补了两个洞：

- **`CVT_F2I` 在解释器里根本没实现**（`interp.js`）。补上：朝零截尾（C11 6.3.1.4 第 1
  段），装不下与 NaN/无穷收成 0 —— 那在 C 里是 UB，抛错会把 UB 变成「一定崩」，
  而原生那一侧给的是随便一个值，两条腿反而更不可能一致。
- **`CVT_I2F` / `CVT_U2F` 目标是 f32 时没有 `fround`**。少这一次舍入，
  `(float)16777217` 在解释器里会保住那个 1，而真的 f32 上它舍成 16777216。

### 词法：字面量原先把值丢掉了

`parseNumber` 的浮点分支从前回的是 `{tok: TOK_CDOUBLE, val: 0n}` —— 记号对了、**值是 0**。
补齐三件事：十进制走宿主的 `Number(text)`（它的十进制 -> double 是最近舍入，与 C 一致）、
十六进制浮点（`0x1.8p3`）自己拆尾数与二进制指数、后缀 `f`/`l` 挑记号并且 `f` 的那个
**先 fround**（常量池按文本去重，不 fround 的话 `0.1f` 会以 double 的文本进池，
于是 `x == 0.1f` 判假）。

### 前端：五处规则，每处一两条指令

- **`castTo` 的浮点四条路**（`castFloat`）：浮点<->浮点是 `FCVT`（同宽度不发指令）；
  整型 -> 浮点**先把整数扩到 64 位**再 `I2F`/`U2F`；浮点 -> 整型是 `F2I` 再收口窄宽度；
  浮点 <-> 指针报错。中间那条「先扩到 64 位」是这一片最容易错的一格：`CVT_U2F` 在 MIR 里
  是「把这 64 位当无符号读」，而 `unsigned int` 的规范形是**符号扩展过的** i32，
  直接喂进去 `(double)(unsigned)-1` 会算成 1.8446744073709552e19 而不是 4294967295。
- **常规算术转换**（`usualArith`）：有一边是浮点就都转到等级高的那个浮点，整型那三句
  一句都不用（`double` 与 `unsigned long long` 相遇是 `double`）。`float + float` 留在
  `float` —— C 不要求中间算成 double，tcc 也是按声明的类型算的。
- **浮点上没有的运算符**：`%`、`&`/`|`/`^`、`<<`/`>>`、`~` 在 `genOp` 与 `unary` 里拦住。
  不拦的话它们会撞上 verifier，而那报的是内部错 —— 用户代码里的普通错误该有普通的报错文本。
- **`? :` 多开一个 f64 的槽**。原先两支都往一个 i64 的槽里存（`c ? 1.5 : 2.5` 于是成了 1）。
  现在算术类型的那一支往两个槽里各存一份，最后按公共类型挑一个读。多出来的那条 store
  只在 `? :` 上，买到的是「不必知道第二支的类型就能给第一支开槽」—— 也就是不必为此
  再扫一遍记号（结构化控制流没有「回头改」那条路，见文件头偏离 2）。
- **默认实参提升**（`promotedType`）多一条 `float` -> `double`（C11 6.5.2.2 第 6 段）。
  少这一条，`printf("%f", 1.5f)` 往变参里放 4 个字节而 `%f` 按 8 个字节读。

`gtst` 与「掉出函数尾巴的隐式 return」都是 `konst(ty, 0)`，所以 `konst` 认浮点之后
这两处一个字都没改 —— `double` 的那个 0 自动是 `f64 0`。

### 静态初始化式：常量表达式的第二份

`double x = 1.5 * 2;` 要在编译期算出来再写 data 段。整型那份求值器是 BigInt 的，
所以浮点这份（`constFloatExpr`）与它**并排**，而一个值带着自己的宿主表示走：
两边都是整数就在整数里算（用的就是整型那份的 `ceApply`），有一边是浮点就都变成 number。
于是 `double half = 1 / 2;` 是 0.0 而不是 0.5 —— 转换发生在最后，不在中间。
落地那一步写的是 **IEEE 754 的位模式**（`floatBits`），因为 data 段就是字节。

### printf 的 `%f/%e/%g`：浮点进了逐字节对账

骨架借宿主的 `toFixed` / `toExponential`（它们的舍入是「在这个 double 的**精确**十进制值
上取最近」，与 C 的 printf 同一件事），自己补三处：指数至少两位、`%g` 挑形态的规则
（指数 < -4 或 >= 精度走 `%e`，精度是**有效数字**位数）、`%g` 去掉末尾的零。
`inf`/`nan` 与 `-0.0` 各有一格；`%08.2f` 的零补在符号之后，所以浮点这一格不走
`padTo` 的补零那一支。

**一格分歧、而且不打算追平**：正好落在两个十进制数正中间的值（`%.2f` 的 0.125）。
C 按当前舍入模式（默认向偶数）给 `0.12`，宿主的 `toFixed` 给 `0.13`。这要求「double 的
精确值在切点上恰好终止」，用例避开这类值；真要追平得自己写一份任意精度的十进制展开。

原先「浮点不能与 tcc 对账」那条限制于此解除 —— 现在只剩 `%p`（地址空间不同）。

### 划出去的三格

- **`long double`**（`gen-bad/long-double`）：本机 arm64 上是 128 位 IEEE quad、x86 上是
  80 位扩展精度，两者都不是宿主的 double，得有自己的一套算术与自己的一份 printf。
- **整型的*静态*初始化式里的浮点常量**（`gen-bad/static-float-int`）：`static int n = 1.9;`
  要「在浮点里算完再截尾」，那是把两份常量求值器合流的一步。自动存储期那一侧没有这个洞
  （`int n = 1.9;` 在函数里走 `castTo`）。
- **printf 的 `%a`**（`gen-bad/printf-hexfloat`）：要自己拆尾数与指数，tinycc 用不到它。

### 量出来的

`tests/c/gen/15-float.c`：退出码 92 + **510B stdout**，与 `tcc -run` 逐字节相同 ——
这一片的 stdout 是目前最长的一份，因为浮点的每一格都印得出来。钉住的形状：
字面量与十六进制浮点、静态初始化式（含 `1 / 2` 在整数里算）、混合类型的算术、
比较与逻辑、与 `unsigned int`/`unsigned char`/`long long` 的互转、`(float)` 的往回舍、
`+=`/`++`/`*=`、struct 里的浮点（传值、返回、整块拷贝）、数组与指针、
`? :` 的两支一支是浮点、函数与函数指针的浮点签名、printf 三种形态与各种标志。

`tests/c` **48 passed / 0 failed**（gen 15 条、gen-bad 13 条），
`tests/js-roundtrip` 109 passed / 0 failed。

### 下一片

**`malloc` 那一族**（要一个真的堆）与**变参函数的定义**（`va_list`/`va_arg`）。
这两格是「能编译 tinycc 自己」路上剩下的最后两块运行期面：tinycc 的每个数据结构都
`tcc_malloc`，而它的 `tcc_error` 是变参的。类型面上剩下的是 `long double` 与
函数类型的 typedef，两条都已经钉着。

<!-- 第六刀第十四片-END -->


## 落地：第六刀第十五片 —— 堆（`malloc` 一族）

### 簿记放在哪儿：线性内存里，不在宿主里

分配器写在 `interp/libc.js`，但它的状态**一个字节都不在宿主那边** —— brk 与每个块的
块头都在线性内存上。两条收益：

- **上一次运行不可能漏到下一次**。内存每次 `memInit` 都是新的，所以堆自动跟着重置；
  宿主留一个 `let brk` 就得另想一套「什么时候清」，而那种状态是最容易忘的一种。
- **换成真的 malloc 是替换这几个函数，不动版图**。自带后端那条路（第 9-11 步）上
  堆是 libtcc1 的事，而线性内存里的这份布局与那时的布局是同一个形状。

### 版图与不变量

```
[0, 64K)            页 0 整页留空（NULL 一定访问不到）
[64K, dataOff)      data 段
[栈底, 栈顶)        影子栈，$sp 从栈顶往下长
[堆底, …)           堆，往上长，不够就 MGROW
```

堆底是**栈顶之上的下一个页边界**，而 `mem.min` 给到堆底加一页 —— 于是
`__omni_heap_init` 写第一个字节时内存一定已经够，那条初始化不必自己先长内存。

堆里：`[堆底, +8)` 是 brk，`[堆底+8, +16)` 留空（让块头落在 16 的整数倍上），
往后一串块，每块 `[+0] i64 载荷字节数`、`[+8] i64 在用吗`，然后是载荷。
形状是 K&R 那一版的隐式空闲链表：**块头本身就是链表**（顺着大小往前走就是下一块），
首次适配，`free` 之后合并相邻的空闲块。够 tinycc 用，而且每一步都看得懂。

### 堆的起点怎么交给宿主

一条 CCALL：入口函数在 `CALL main` 之前发 `__omni_heap_init(堆底)`。

- 宿主那边**不猜版图** —— 版图是前端定的，猜出来的常量迟早会与前端分岔。
- **用到堆才发**（`HEAP_FNS` 这几个名字出现在外部符号清单里才算用到）。没用到的模块
  不该多一个外部符号：自带后端那条路上它是一次真的链接。
- 每次运行都发，所以「重置」这件事不必另有出口。emscripten 的 `emscripten_stack_init`
  与 wasi 的 `_initialize` 是同一个位置上的同一件事。

### 语义上照 C 而不是照方便

- `malloc(0)` 给一块**真地址**（C11 7.22.3 允许两种，glibc 与 tcc 的 libc 都给地址）——
  回 NULL 会让「分配了就往里写」的常见写法在这一格上崩，而那不是它的错。
- `calloc` 的 `nmemb * size` 在 BigInt 上算，所以先算出真值再判装不装得下：
  溢出回 NULL，而不是分配一小块然后让调用方写出界。
- `realloc(NULL, n)` 是 malloc、`realloc(p, 0)` 是 free 回 NULL、原地够用就回原地址
  （C 只保证「内容保留到较小的那个长度」，地址允许不变）。
- `free(NULL)` 什么都不做（C11 7.22.3.3 第 2 段）。
- 内存真的长不动时回 NULL，不抛错 —— `MGROW` 本来就是「加不了回 -1」的形状。

### 量出来的

`tests/c/gen/16-heap.c`：退出码 19 + 70B stdout，与 `tcc -run` 逐字节相同。
**一个地址都不印**（`%p` 与 tcc 对不上），只印内容与长度。钉住的形状：
malloc 写读、calloc 零初始化、realloc 长大保内容、realloc 变小、`realloc(0,n)`、
`strdup`、链表五块互不重叠、free 之后合并出来的大块被复用、`free(NULL)`、
`malloc(0)`、20 万字节（要 `MGROW`）、交替 free 之后剩下那几块内容不串。

`tests/c` **50 passed / 0 failed**（gen 16 条、gen-bad 14 条），
`tests/js-roundtrip` 109 passed / 0 failed。

### 下一片

**变参函数的定义**（`gen-bad/vararg-def` 钉着）：`va_list` / `va_start` / `va_arg`。
tinycc 的 `tcc_error` / `tcc_warning` 都是变参的，所以这一格躲不过去。它要的不是语法
而是**调用约定**：那三个宏展开成「按 ABI 从形参区往后走」的代码，而我们这一片的形参
还都在 MIR 的槽里 —— 所以第一步是决定「变参区在影子栈上长什么样」。

<!-- 第六刀第十五片-END -->

## 落地：第六刀第十六片 —— 变参函数的定义（`va_list` 一族）

### 调用约定：签名是**定死的**

变参函数的 MIR 签名不随调用点变：**固定形参 + 一个隐藏的最后一个形参 `$va`（i64）**，
指向调用方帧上的一块「变参区」。变参区是一串 **8 字节的格子**，每个格子按**它自己的宽度**
写进去（`float` 提升成 `double`、窄整型提升成 `int`，也就是 C 的默认实参提升），
`va_arg` 按**要的类型的宽度**读出来、然后游标加 8。

这样一来：

- **调用点不需要知道被调方是谁定义的**。`printf(...)` 与自家的 `total(...)` 发的是同一条
  `CALL`，都是「固定实参 + 变参区地址」。第五片那条「变参一律 CCALL」的分支因此整条删掉。
- **外部变参函数走同一个形状**。`externThunk` 给桩也加上 `$va` 形参，原样转发进 CCALL；
  宿主的 `printf` 于是从内存里读变参（`libc.js` 的 `vaCursor`）——
  第五片那种「宿主直接拿 MIR 实参列表」的假变参被换成了**真变参**。
- **递归与嵌套天然成立**。每个调用方的变参区是它自己帧上一次 `frameAlloc`，
  而 `frameAlloc` 两遍都跑，所以第一遍估的帧长已经把它算进去了。

### 前端那几处

- `__builtin_va_list` 在构造函数里注册成 `void *` 的 typedef；`va_start`/`va_arg`/
  `va_end`/`va_copy` 四个 `__builtin_*` 进 `tcctok.js` 的**预注册名**区（照
  `tcctok.h:168-185` 那一段的位置），在 `unary` 里被拦成 `vaBuiltin`。
- `va_start(ap, last)` 把 `this.vaRef`（`runBody` 里那个 `$va` 形参的值）存进 `ap`，
  **第二个实参求值后丢掉** —— 我们不靠「最后一个固定形参的地址」找变参区。
  在固定形参的函数里用它是**编译期**错误（`vaRef === REF_NONE`）。
- `va_arg(ap, T)` 是「按 `T` 的宽度 MLOAD，游标 +8」；`va_copy` 是一次普通的指针赋值；
  `va_end` 除了类型检查什么都不做。
- `callArgs` 把实参分成固定段与 `extra` 段：固定段照形参类型转换，`extra` 段照
  `promotedType`（它在第十四片起也负责 `float`→`double`）。

### 边界

第十五片的 `gen-bad/vararg-def` 是这一片钉住的东西，所以它被**换成**下一格的两个钉子：

- `gen-bad/vararg-pass-struct`：把 struct 传进变参的可变部分（要按大小分格）。
- `gen-bad/vararg-struct`：`va_arg` 出 struct 或大于 8 字节的东西（同一件事的读侧）。

「通过函数指针调变参函数」还钉在 `gen-bad/fnptr-variadic` 上：签名定死之后它其实只差
函数指针类型上记住 `variadic` 这一位，留给下一格一起做。

### 量出来的

`tests/c/gen/17-vararg.c`：退出码 68 + 118B stdout，与 `tcc -run` 逐字节相同。
钉住的形状：整型求和（哨兵结尾）、`double` 求和、字符串逐个打印、混合类型
（`int`/`double`/指针一把抓，含 `va_copy` 走第二遍）、变参函数里再调变参函数、
递归的变参函数、把 `va_list` 转手给 `sprintf`。用的是 `__builtin_va_*`
而不是 `<stdarg.h>`，所以两边编译器都不需要头文件。

`tests/c` **52 passed / 0 failed**（gen 17 条、gen-bad 15 条），
`tests/js-roundtrip` 109 passed / 0 failed。

### 下一片

**`exit`**：tinycc 自己到处在用（`tcc_error` 之后就 `exit(1)`），而它要的是「从任意深处
一路退出去」—— 结构化控制流那条纪律下这不是一个 `BR` 能办的事，得决定是宿主抛一个
信号打断执行，还是 MIR 加一条真的 `EXIT`。同时也是 `setjmp`/`longjmp` 的前哨。

<!-- 第六刀第十六片-END -->

## 落地：第六刀第十七片 —— `exit`

### 为什么它不进 MIR

`exit` 是「从任意深处一路退出去」，而这条腿上的控制流是**结构化**的：BLOCK/LOOP/IF +
往外数几层的 `BR`（第六刀四条偏离的第二条）。`BR` 的层数是**函数内**的概念，跨不过调用
边界 —— 想在 MIR 里表达 `exit`，就得给每个函数都加一条「我是不是正在退出」的返回旗，
然后每个调用点都检查它一次。那是把结构化控制流那条纪律拆掉，换来的只是一个 libc 函数。

所以这一片的决定是：**`exit` 是宿主的事**。libc 抛一个 `ExitCall`，跑模块的那一层
（`mir/interp.js` 的 `runMirModule`）收住，刷 stdout，把它的 `code` 当退出码回出去。

这不是权宜之计，是各条腿上本来的形状：wasi 的 `proc_exit` 也是宿主 trap 掉整个实例，
自带后端那条路（第 9-11 步）上它就是真的 `exit` 系统调用 —— 三处都是「离开被编译的
那段代码」，而不是被编译的代码自己算出来的一次跳转。`setjmp`/`longjmp` 是同一个问题的
难版（它要回到**某个还活着的帧**而不是一直退出去），这一片先把简单的那半钉住。

### 收在哪儿

- `ExitCall` **不是** `InterpFail`。后者是「程序错了」，退出码 70（ADR-0005）；
  `exit(3)` 是程序正常地要求退出码 3。CCALL 那层的 try/catch 因此要把它**原样放过去**
  （那个 catch 本来把 libc 抛的一切都翻成运行期错误）。
- 刷 stdout 之后才回 —— C 的 `exit` 也是先冲 stdio 再退（C11 7.22.4.4 第 2 段）。
  `_exit` 才是不冲的那个，等有人要它再说。
- 退出码截到 8 位这件事**不在我们这儿做**：`runMirModule` 回整数，node 退出时自己截。
  `exit(300)` 于是与 `tcc -run` 一样是 44（wait(2) 的规矩）。
- `abort()` 顺手一起：退出码 128 + SIGABRT(6) = 134，与 shell 报的数一样。

### 量出来的

`tests/c/gen/18-exit.c`：退出码 44 + 46B stdout，与 `tcc -run` 逐字节相同。
钉住的形状：`exit` 之后那句 printf 一定不跑；退出码 300 截成 44；退出发生在
**循环里套 switch、switch 里 return 一个不回来的调用、外面还套着三层递归**
（结构化控制流下最容易漏的形状：BLOCK/LOOP 的 END 还欠着，栈却已经不打算退回去了）；
退出前 buffer 里的 stdout 全都出来了。

`tests/c` **53 passed / 0 failed**（gen 18 条、gen-bad 15 条），
`tests/js-roundtrip` 109 passed / 0 failed。

### 下一片

**嵌套聚合初始化式省掉里层花括号**（`gen-bad/agg-init` 钉着）：
`int m[2][3] = {1,2,3,4,5,6};`、`struct {int a; struct {int b, c;} in;} s = {1, 2, 3};`。
tinycc 自己的表（`tcctok.h` 那一族、目标描述表）大量用这个写法，所以躲不过去。
它要的是把「初始化式读到哪儿了」从一层的游标改成**一个下降栈**：遇到标量而当前是聚合，
就往里下降一层，填满就往外回一层。

<!-- 第六刀第十七片-END -->

## 落地：第六刀第十八片 —— 嵌套聚合省掉里层花括号

### 一个下降栈，换掉两份遍历

C 允许 `int m[2][3] = {1,2,3,4,5,6}`、`struct S a[2] = {1,2,3,4}`
（C11 6.7.9 第 20 段）：里层的花括号可以省，省了之后**上一层没吃完的东西交给下一层
接着吃**。第八片做的是「花括号写全」那条路，`initArray` 与 `initStruct` 各自递归，
省花括号的写法当场报错（`gen-bad/agg-init` 钉着）。

这一片把那两份合成一份 `initBraced`，而且**不用递归走层**，用一个下降栈：

- 栈顶是「现在正在填的那一层」，每层记 `{ ty, off, i }`。
- 要填的那一格是聚合、而记号不是 `{` → 省了花括号，**下降**一层（栈上多一格）。
- 一层填满 → **回卷**：弹掉它，外层的序号 +1（可能连着弹好几层）。
- **逗号只由花括号那一层吃。**省花括号的层不碰分隔符。

最后那一条是整片里唯一真正要想清楚的地方。先写的版本是让每一层自己吃逗号、吃到满了
就退出去 —— 结果 `int a[2][2] = { 1, [1] = {5,6} }` 立刻炸：里层吃掉逗号之后才看见
`[1]`，而那个逗号是**外层的**分隔符，得还回去。一遍过的降级器里能不回退就别回退
（`ungetTok` 有，但它要开一个宏帧，而初始化式本身可能正跑在 `replayBraced` 的宏帧里），
所以改成「只有花括号那一层吃逗号」：下降出来的层是纯粹的**记账**，一个记号都不消费。

指定初始化器（`[3] =` / `.f =`）也顺着这条线：C 里它作用在**current object** 上，
而 current object 就是花括号那一层。所以碰到 `[` 或 `.` 先把下降出来的层全弹掉，
再挪栈底那一层的序号。`union` 是「只填一个成员」（C11 6.7.9 第 17 段），实现成
填完直接把序号跳到「满」—— 于是后面再来东西自然是 excess，而不是悄悄盖掉第一个。

### 顺手修掉的一个真 bug

`sizeFromInit`（不定长数组的长度那一遍，在记号层面数）把 `int a[][2] = {{1,2},{3,4}}`
数成了 **1** —— 它只在「深度 1 上有非括号记号」时才算一格，而写全花括号的那种格子
第一个记号就是 `{`，直接被当成进层去了。tcc 那边数出来是 2。修法是在深度 1 上把
`{` 也算作「这一格开始了」。这是第八片带进来的洞，之前没有用例踩到。

### 边界（`gen-bad/agg-init` 换成两个钉子）

- `gen-bad/init-flex-elided`：**不定长数组配省掉里层花括号**（`int a[][2] = {1,2,3,4}`）。
  长度那一遍只看记号，而省了花括号之后「一格」不再等于「一个记号」—— 要数对就得先按
  元素类型分格，那是 `initBraced` 的活。两遍合一遍是下一步的事。
- `gen-bad/init-desig-chain`：**串起来的指定初始化器**（`.i.b = 3`、`[1][2] = 3`）。
  现在的 `initDesignator` 只挪一层的序号。

### 量出来的

`tests/c/gen/19-init.c`：退出码 16 + 185B stdout，与 `tcc -run` 逐字节相同。
钉住的形状（静态与自动两侧都各来一遍）：`int[2][3]` 全省、`struct{int; struct; int}`
全省、数组套 struct 全省（`struct in [2][2]` 八个数一把铺）、省与写全**混着**
（`{ {1}, 5, 6 }`）、`char[3][4]` 用字符串铺、指定初始化器把省出来的层弹掉之后接着排
（`{ 1, 2, [2] = 7, 8 }`）、没写满的部分按 C 归零、`union` 在省花括号的下降里只填一个成员。

`tests/c` **55 passed / 0 failed**（gen 19 条、gen-bad 16 条），
`tests/js-roundtrip` 109 passed / 0 failed。

### 下一片

**函数类型的 typedef**（`gen-bad/fnty-typedef` 钉着）：`typedef int (*cmp)(const void*, const void*);`
里带指针的那种已经能用，缺的是 `typedef int F(int);` 这种**函数类型本身**的别名 ——
tinycc 的 `tccgen.c` 里 `ST_FUNC`/`ST_DATA` 那一族声明大量用它。它要的是让 `declarator`
认得「基类型已经是函数类型」这件事，而不是只在声明符上长出函数来。

<!-- 第六刀第十八片-END -->

## 落地：第六刀第十九片 —— 函数类型的 typedef 与变参的间接调用

### 两条边界原来只是保守

这一片没写新机制，只是把两条 `gen-bad/` 的钉子拔了 —— 它们钉的东西**在别的片里已经
做完了**，只是当时没人回头验：

- `typedef int cb(int);`：第十二片让声明符能造出函数类型、第十三片让「函数指示符是
  函数类型的内存左值」，于是把函数类型放进 `typedefs` 表之后，`cb *p`、`cb *tab[3]`、
  `cb f;`（声明一个函数）、形参写成 `cb f`（C11 6.7.6.3 第 8 段：自动退化成指针）
  全都是既有代码路径。删掉 `decl` 里那一行 todo 就通了。
- 通过函数指针调变参函数：原来的理由是「变参要发 `CCALL`，而 `CCALL` 的入口号是编译期
  常量，间接调用给不出来」。**第十六片把这个前提废掉了** —— 变参函数的签名定死成
  「固定形参 + 一个变参区指针」之后，间接调用与直接调用的实参形状一模一样，`indirectCall`
  只要把 `variadic` 那一位交给 `callArgs`，照旧发 `CALLI`。

这两件事都属于「上一片顺手解锁了下一片，而边界文本还停在旧世界」。所以 `gen-bad/` 的
纪律得配一条：**每片开头把与这一片相邻的钉子拿去跑一遍**，红了才说明它还钉得住。

### 量出来的

`tests/c/gen/20-fnty.c`：退出码 9 + 61B stdout，与 `tcc -run` 逐字节相同。
钉住的形状：`typedef int cb(int)` 之后 `cb *p`、`cb *tab[3]`、`cb plus1;` 加它的定义、
形参写成函数类型（退化成指针）、返回 `cb *` 的函数、`typedef cb *cbp` 再套一层；
变参这一侧：`typedef int pf(const char*, ...)` 造出的指针调 `printf`、指针调 `sprintf`、
指针调**自家**的变参函数（`__builtin_va_*` 那一套）。

`tests/c` **54 passed / 0 failed**（gen 20 条、gen-bad 14 条），
`tests/js-roundtrip` 109 passed / 0 failed。

### 下一片

**`goto` 跳到不在外围块上的标签**（`gen-bad/goto`、`gen-bad/goto-duff` 钉着）：
第十片做的是「标签在外围块上」那一半，靠的是往外数层数的 `BR`。剩下的一半（跳进/跳过
控制结构，Duff's device 那种）在结构化控制流上要 relooper：把函数体按标签切成基本块，
再用一个 `loop { switch (state) { … } }` 把它们缝回去。tinycc 自己的源码里
`goto` 主要用来跳到出错处理，那一半已经能用，所以这一片可以慢慢做 —— 但躲不过去。

<!-- 第六刀第十九片-END -->

## 落地：第六刀第二十片 —— `long double`

### 在这个目标上它就是 `double`

原来的边界文本写的是「它不是 double：arm64 上是 128 位 IEEE quad，x86 上是 80 位」。
**前半句是错的**，而错法很有教育意义：`arm64-gen.c:36` 确实写着 `LDOUBLE_SIZE 16`，
但 `tcc.h:237-241` 在它之上还有一条：

> No ten-byte long doubles on window and macos except in cross-compilers made by a
> mingw-GCC —— `TCC_TARGET_PE` 或（`TCC_TARGET_MACHO` 且 `TCC_TARGET_ARM64`）就开
> `TCC_USING_DOUBLE_FOR_LDOUBLE`。

也就是说在**我们的 oracle 上** `sizeof(long double)` 是 8，精度就是 double 的精度
（`1.0L + 1e-18L == 1.0L`，量过）。查这一条的路子值得记下来：先问二进制（`sizeof`、
`1e-18` 那个加法），发现与源码里的常量对不上，再回源码找覆盖它的那一层 ——
**别信一条 `#define`，信整条预处理链**。

### 于是这一片改了五处

- `typeSize`：VT_LDOUBLE 是 8/8（x86_64 16、i386 12、riscv64 16，跟着那几条后端来）。
- `mirTypeOf`、`loadKindOf`、`storeKindOf`：VT_LDOUBLE 与 VT_DOUBLE 同一格（f64）。
  忘了后两个的下场是 `MSTORE 的描述符是 i64，但 t 是 f64` —— MIR 的良构检查逮住了它，
  这正是「一条映射只写一处」那条纪律没做到时该出现的红。
- `parseBtype`：`long double` 认下来之后**把 `long` 那一票用掉**（`longs = 0`），
  否则「short/long 只能配 int」与「longs>0 就是 long long」会把它按整型处理。
- 字面量后缀 `L`（`TOK_CLDOUBLE`）与常量求值器的浮点那一半：都归到 long double 上。

**类型码不合并。**`VT_LDOUBLE` 仍然是自己一格 —— `sizeof`、`typeText`、以后的
`_Generic` 看的是类型而不是表示；x86_64 那条后端上来时改的只有 `typeSize` 与
`mirTypeOf` 两处（那时 MIR 需要一个真的 f80，是它自己的一刀）。

### 量出来的

`tests/c/gen/21-ldouble.c`：退出码 5 + 148B stdout，与 `tcc -run` 逐字节相同。
钉住的形状：`sizeof` 四种（标量、数组、`struct{char; long double;}` 的布局）、
`1.5L` 字面量、与 `double`/`float`/整型互转、常规算术转换里「最宽的赢」、
静态初始化式（含 `1.0/4` 在浮点里算、没写满的那格归零）、传参与返回、
`printf` 的 `%Lf`/`%.3Lf`/`%Lg`/`%Le`、比较。

`tests/c` **54 passed / 0 failed**（gen 21 条、gen-bad 13 条），
`tests/js-roundtrip` 109 passed / 0 failed。

### 下一片

**整型的静态初始化式里的浮点常量**（`gen-bad/static-float-int` 钉着）：`int n = 1.9;`
要的是 1。现在常量求值器有两份 —— 整型那份是 BigInt、浮点那份是 number，而这一格
要求「在浮点里算完再截到整型」。合流的办法已经想清楚：让整型那份在**碰到浮点常量时
切到浮点那份**，回来时按 C 的规则截断（向零）。同一并把 printf 的 `%a` 收掉。

<!-- 第六刀第二十片-END -->

## 落地：第六刀第二十一片 —— 常量表达式里的浮点，与 printf 的 `%a`

### 两个求值器合成一份

第十四片给静态浮点初始化式加了第二个常量求值器（`constFloatExpr`），于是有两份：
整型那份走 BigInt，浮点那份走 number。代价立刻显形 —— `int n = 1.9;` 落在整型那份上，
而它见到浮点常量只能报「还没到」（`gen-bad/static-float-int` 钉的就是这个）。

合流的办法是**一个求值器、两种宿主表示**：整数是 BigInt、浮点是 number，也就是 C 的
「整型常量」与「浮点常量」这两类，原样带着走。算子那一步分两支：两边都是 BigInt 用
`ceApply`（旧的那份，一个字没改），否则用新的 `cefApply`（`+ - * /` 加比较与逻辑 ——
比较的**结果是 int**，所以那几格回的是 BigInt；`%`、位运算、移位在浮点上不存在，
与 `genOp` 同一条规则）。两个出口：

- `constExpr()`：要整型 —— 落在 number 上就**向零截断**（C11 6.3.1.4 第 1 段）。
- `constFloatExpr()`：要浮点 —— 同一个求值器，只是最后不截断。

于是 `double x = 1 / 2;` 还是 0.0（两边都是整数就在整数里算，转换只发生在最后），
而 `int n = (1.5 + 1) * 2;` 是 5 而不是 4（括号里不提前截断）。删掉了 `cefInfix` 与
`cefUnary` 两个函数，净减代码。

顺手补上的两格：**常量表达式里的强制转换**（`(int)2.9`、`case (int)1.5:`、
`int a[(int)3.7]`）走新的 `ceCastTo` —— 截断之后还要**按目标宽度回绕**
（`(unsigned char)300.9` 是 44），`_Bool` 例外（只有零与非零）。

### `%a`：这一格是二进制的直读

`%f/%e/%g` 都能靠宿主的 `toFixed`/`toExponential` 起个头，`%a` 不行 —— 它印的是
**位模式**。所以 `aText` 自己拆：`DataView` 取 64 位，指数域减 1023，52 位尾数当
十六进制的 13 位。量出来的四条细节（都不是从标准正文一眼能读出来的）：

- **次正规数也规格化**：`5e-324` 是 `0x1p-1074`，不是 `0x0.0…1p-1022`。
- 精度省略时印「13 位去掉末尾的零」；给了精度是**半值向偶**（`%.0a` 的 1.5 是
  `0x1p+0`、1.75 是 `0x2p+0`、2.5 是 `0x1p+1`）。
- 进位溢出落在**首位数字**上，指数不动：`%.1a` 的 1.999999 是 `0x2.0p+0`。
- 指数**不补两位**（`p+0`），与 `%e` 的 `e+00` 不同；`0x` 是**前缀**（`%012.3a` 印
  `0x001.555p-2`，零补在它右边）；`inf`/`nan` 连 `0x` 都不印。

libc 那份「不能与 tcc 对账」的清单因此只剩 `%p` 一格（地址本身不同）。

### 量出来的

`tests/c/gen/22-cexpr-float.c`：退出码 8 + 303B stdout，与 `tcc -run` 逐字节相同。
钉住的形状：整型位置上的浮点常量（正负、`char`、`unsigned char` 的回绕）、括号、
`1/2` 与 `1.0/2`、浮点的比较与 `!`/`&&`、`(int)` 与 `(_Bool)` 转换、数组维度、
`case` 标签、枚举值；`%a` 这一侧：基本形状、`%A`、指定精度、四种 round 情形、
次正规数、三种对齐/补零。

`tests/c` **53 passed / 0 failed**（gen 22 条、gen-bad 11 条），
`tests/js-roundtrip` 109 passed / 0 failed。

### 下一片

剩下的钉子只有五个了，而其中四个是**同一类**：`vararg-struct` / `vararg-pass-struct`
（变参里的 struct 要按大小分格）、`init-desig-chain`（`.a.b = 3`）、`init-flex-elided`
（不定长数组配省花括号）。第五个是 `struct-byval`（**外部**函数上的 struct 传值/返回，
那要真的 ABI，等后端）。加上没钉子的两条 `goto`（relooper）。

下一片做**变参里的 struct**：它是 `printf("%s", s)` 之外 tinycc 自己会用到的一格
（`tcc_error` 那一族里传的都是标量，但 `libtcc.h` 的 API 上有结构），而且它把
「变参区按 8 字节一格」这条规则推到「按大小对齐分格」—— 与 arm64 真 ABI 的那条规则同形。

<!-- 第六刀第二十一片-END -->

## 落地：第六刀第二十二片 —— 变参里的 struct

### 内容摊在格子里，不放地址

固定形参上的 struct 传的是**地址**（第十一片：被调方在入口处拷一次）。变参这一侧
不能照抄，理由是读的那一侧只有一条信息：`va_arg(ap, struct pt)` 里的**类型**。
「这一格放的是地址还是内容」是第二条信息，而变参没有地方带它 —— 所以内容必须直接
躺在格子里。arm64/SysV 的变参区也是这么放的（小的摊开在栈上）。

于是变参区的分格规则从「一格 8 字节」变成「一格 `对齐到8(sizeof)` 字节」：

- 写侧（`vaBlock`）：标量照旧只写自己那几个字节；struct 用 `structCopy` 整份拷进去
  （那是第六片就有的按 8/4/2/1 摊开的块拷贝，一行没改）。
- 读侧（`vaArg`）：游标按同一条规则往前走。struct 那一格**回一个指向变参区的左值**
  （`sMem`）而不是一个值 —— 于是 `struct pt p = va_arg(ap, struct pt);` 的拷贝由赋值
  那一步做（C 要求的那一次），而 `va_arg(ap, struct pt).x` 一个字节都不用拷。
  这与 struct 返回值那一格是同一个手法（第十一片）。

两边的规则写在同一处（`alignUp(typeSize(ty).size, 8)`），这是这一格唯一的不变量：
**写的时候怎么分格，读的时候就怎么分格**。

`va_arg` 的类型检查顺手收紧了一格：数组与函数类型不能当实参类型（C11 6.7.6.3 第 8 段
说它们在形参上退化成指针，而 `va_arg` 要的是「实参本来的类型」）。

### 量出来的

`tests/c/gen/23-vararg-struct.c`：退出码 34 + 70B stdout，与 `tcc -run` 逐字节相同。
钉住的形状：两个 struct 连着传、`va_arg` 回左值后直接取成员（`va_arg(...).x`）、
混着传（`int`/struct/`double`/24 字节的 struct/指针 一把抓）、`va_copy` 之后同一块
变参区再走一遍、变参函数里再调变参函数把 struct 传下去。

`tests/c` **52 passed / 0 failed**（gen 23 条、gen-bad 9 条），
`tests/js-roundtrip` 109 passed / 0 failed。

### 下一片

`gen-bad/` 只剩三个真边界了：`init-desig-chain`（`.a.b = 3`）、`init-flex-elided`
（`int a[][2] = {1,2,3,4}`）、`struct-byval`（**外部**函数上的 struct 传值/返回 ——
那要真的 ABI，等后端）。加上没钉子的两条 `goto`（relooper 那一路）。

下一片把前两个初始化式的洞一起补掉：它们其实是同一件事的两半 ——
**「初始化式的游标要能下降」**。`initBraced` 的下降栈已经有了，缺的是
(1) 让指定初始化器顺着 `.a.b` / `[1][2]` 往里走一层一层挪，
(2) 让长度那一遍（`sizeFromInit`）用同一个栈去数格子，而不是在记号层面数逗号。

<!-- 第六刀第二十二片-END -->

## 落地：第六刀第二十三片 —— 指定初始化器串起来，长度那一遍也用下降栈

### 一个栈，三处用

第十八片给 `initBraced` 造了个下降栈（`{ty, off, i}` 一层一层往里走，逗号只由花括号
那一层吃）。这一片没有新机制，只是把同一个栈接到另外两处，两个洞就一起没了：

- **指定初始化器串起来**（`.i.b = 3`、`m[1][2] = 7`）：`initDesignator` 原来只认
  一个部件，认完就 `=`。改成 `initDesignators(stack)`：每认掉一个部件就把游标挪到
  那一格，**如果后面还跟着部件**，就用 `initElem(lv)` 把那一格当新的一层压进栈。
  于是 `.i.b` 与 `.i = { .b = ... }` 走的是同一条路径，差别只在花括号在不在。
- **长度那一遍**（`sizeFromInit`）：原来在记号层面数深度 1 的逗号，遇到
  `int a[][2] = {1,2,3,4}` 就数成 4 个元素。改成拿 `initHeads(toks)` 取出每个
  深度 1 项的**头一个记号**，再用同一套下降/回卷逻辑走一遍：头是 `{` 或字符串就是
  整整一个元素，别的就往里降到标量。「顶层那一格只填了一半也算一格」由
  `stack[0].i + (stack.length > 1 ? 1 : 0)` 收尾。

`initHeads` 只需要跟踪 `{}`/`()`/`[]` 三种深度，并在深度 1 的逗号上把 `fresh` 复位 ——
它不解析任何东西，因此不会跟真正那一遍的语义分叉。

### tcc 与 clang 在这里不一样，跟 tcc

```c
struct s { int a; struct { int b, c; } i; int d; };
struct s g1 = { .i.b = 3, 4, .a = 1 };
```

`4` 落在哪？

- tcc：`a=1 i.b=3 i.c=0 d=4` —— 串起来的指定初始化器之后，**回到花括号那一层**接着往下走。
- clang / gcc（本机 `cc` 验过）：`a=1 i.b=3 i.c=4 d=0` —— 停在最里那一层接着走。

C11 6.7.9 第 17 段的字面读法更像 clang 那一边，但 oracle 是 tcc 的二进制，这一刀的
目标是复刻它，所以跟 tcc。实现就是 `chainAt`：进 `initDesignators` 前记下花括号层的
游标，串完一个元素之后把栈弹回花括号层、把游标设成 `chainAt` 再 `initBump` 一格。
分歧写在代码注释里，将来若要加 `-std=` 的宽严档，这就是第一格。

### 量出来的

`tests/c/gen/24-init-desig.c`：退出码 13 + 112B stdout，与 `tcc -run` 逐字节相同。
钉住的形状：串起来的 `.i.b`、串完之后 `4` 落在哪、`[1][2] = 7`、不定长数组配省掉
里层花括号（`int a[][2] = {1,2,3,4}` 数成 2、`{{1},2,3}` 数成 2、字符串数组数成 3）、
`char *[]` 与 `char [][4]`、块作用域里的同样几形。

`tests/c` **51 passed / 0 failed**（gen 24 条、gen-bad 7 条），
`tests/js-roundtrip` 109 passed / 0 failed。

`gen-bad/` 的两个钉子（`init-desig-chain`、`init-flex-elided`）删掉了 —— 边界挪走了，
钉子就换成 `gen/` 里的形状。剩的唯一一条初始化式边界是 `int a[] = {[3] = 1}`
（指定初始化器决定长度），它还在 `sizeFromInit` 的 `todo` 里，因为那要让长度那一遍
也认设计符 —— 同一个栈再接一处，但不急。

### 下一片

`gen-bad/` 剩下的真边界只有 `struct-byval`（**外部**函数上的 struct 传值/返回，
要真 ABI，等后端）。所以下一片轮到那两条**没有钉子的** `goto`
（`gen-bad/goto`、`gen-bad/goto-duff`）—— 结构化控制流里表达不了任意跳转，
要一个 relooper。这是第六刀剩下最大的一块，也是 tinycc 自己的源码里必然会用到的
一格（`tccgen.c` 里到处是 `goto redo`）。

<!-- 第六刀第二十三片-END -->

## 落地：第六刀第二十四片 —— `goto` 跳到哪儿都行

### 原来卡在哪

第十片的形状是「**每个带标签的块自己一台状态机**」：一圈 `LOOP`、一个状态槽、
开头一张 `BRTABLE`，一个标签关掉一层 `BLOCK`。它能表达的只有一种 `goto`：
标签直接长在某个复合语句的语句层上，而 `goto` 在那个块**里面**。两条边界卡在那儿：

- `goto inner;` 跳进一个 for 的循环体 —— 标签在**兄弟块**里；
- `if (c) half: i += 1;` —— 标签长在**里层的控制结构**里（Duff's device 那一形）。

两条其实是同一件事：**控制要「跳进去」，而不是只在一个块的语句层上挪**。

### 换法：一台状态机 + 一条分派链

1. **状态机只有一台，在函数那一层**（`runBody`）。`goto` 不再挑「哪个外围块」，
   永远是「写状态、`BR` 回函数那圈 `LOOP`」—— 往前跳、往后跳、跳进跳出，一个形状。
2. **每条「里面有标签」的语句各出一小段，让自己能被重新进入**。函数那一层只能把控制
   送到函数体的直接子语句上，再往里由下一层自己接：
   - 复合语句：一台分派（`openSegs`/`segCut`）。这就是第十片那台状态机，只是
     **段的边界从「标签」变成「里面有标签的子语句」**，而且不再自带 `LOOP`。
   - `while` / `for`：把测条件（和 `for` 的初始化）**跳过**（`headSkip`），直接落进
     循环体 —— 重新进入时不能重跑那些副作用。测条件那一跳在 `LOOP` **里面**，
     所以每一圈都重新判断；到了标签那儿状态清零，下一圈就照常测。
   - `if`：条件换成「`state == 0 ? cond : state <= thenHi`」。结构化控制流里没有
     select，所以借一个 bool 槽把两条路合起来。
   - `L: 语句`：到了就把状态清零（`labelStmt`），此后一切照常。状态是**别的**（更里层的
     标签）就原样留着，交给里面那一层。
   - `do-while`：循环体就在最前面，一行都不用改。

「状态落在谁里面」为什么只是一次比较：标签编号按**定义的源码顺序**从 1 起，而一条语句
占一段连续的源码，所以它里面的标签编号一定是连续区间 `(lo, hi]`；同一层兄弟子语句的
区间又递增且相接，于是一台分派就是一串 `state <= hi_i`，不需要 `BRTABLE`，也不需要
把绝对状态号偏移成表下标。

这条「编号连续 ⇒ 区间判断」的性质是这一片的全部技巧。它把 relooper 里那套
「求支配树、算 loop/multiple block」的活儿换成了**一遍量区间**：语句在两遍里是同一个
序号（`block` 那个包装给每条语句编号），第一遍量 `(lo, hi]` 与 `thenHi`，第二遍按序号
取回来。前向引用照旧是**白拿**函数体本来就有的那两遍。

### 代价，明写在这儿

- `goto` 一次要重走一遍分派链：从函数那圈 `LOOP` 往里，每层一次比较。深度那么多次，
  而 tinycc 里那些 `goto redo;` 都很浅。
- 函数里只要有一个标签，**整个函数体**就被套进一圈 `LOOP`，而且每条含标签的语句多几条
  比较。自带后端那条路上这一整套会退回成一条跳转（文件头偏离 2 那一条的老账）。
- 「跳过初始化式」把 `for (int i = 0; …)` 里的 `i` 留成未初始化的 —— 那正是 C 说的
  （跳进一个块，对象存在但没初始化），不是我们的取舍。

### 量出来的

`tests/c/gen/25-goto.c`：退出码 87 + 82B stdout，与 `tcc -run` 逐字节相同，**一次就对**。
钉住的九形：往回跳（`goto redo;`）、跳进 for 的循环体（初始化式与测条件都跳过）、
标签长在 `if` 里、从两层循环里一跳到底（`goto out;`，循环变量跳出去照旧看得见）、
跳进 while 的循环体再照常绕圈、同一层两个标签往前往后都跳、跳进套了两层的普通块、
标签在函数最后（顺着掉下来与跳过来同一条路）、do-while 的循环体里有标签。

`tests/c` **51 passed / 0 failed**（gen 25 条、gen-bad 6 条），
`tests/js-roundtrip` 109 passed / 0 failed。

`gen-bad/goto` 与 `gen-bad/goto-duff` 删掉了 —— 边界挪走，钉子换成下一条边界
`gen-bad/goto-in-switch`（语句标签长在 `switch` 里）。

### 下一片

`gen-bad/` 只剩两条：

- `goto-in-switch`：case 那台分派与标签这台要在**同一串嵌套 `BLOCK`** 上各插自己的段界，
  而且重新进入时还得跳过选择子的求值。两台分派交错是一件独立的事，一片就够。
  顺带能把 `caseLabel` 里那条「case 标签长在里层控制结构里」的边界一起看一遍 ——
  真的 Duff's device 就长在那儿。
- `struct-byval`：**外部**函数上的 struct 传值/返回，要真的 ABI，等后端。

所以下一片做 switch 里的标签，做完第六刀在「控制流」这一栏上就没有洞了 ——
tinycc 自己的源码里 `goto` 与 `switch` 同时出现的地方不少（`tccgen.c` 的
`unary`/`expr_infix` 一带），那是走向「拿自己编译 tinycc」的必经一格。

<!-- 第六刀第二十四片-END -->

## 落地：第六刀第二十五片 —— 语句标签长在 `switch` 里

### 两台分派，一串 `BLOCK`

switch 是第二十四片唯一没接上的一格。原因是它**自己就有一台分派**：`case` 也是
「一个标签关掉一层 `BLOCK`」（第九片）。于是同一个复合语句上有两种段界要插，
而它们必须落在同一串嵌套 `BLOCK` 上 —— 分成两串就没法互相跳。

换法是承认它们本来就是同一件事：**段界**。

- 第一遍量区间时，`case`/`default` 也记成一处段界（`r.isCase`），与「里面有标签的
  子语句」一起进同一个 `kids`。它们本来就都是复合语句的**直接子语句**。
- `openSegs` 于是开 `kids.length + 1` 层 `BLOCK`，发**两截**分派：
  1. 状态非 0 -> 按区间送到带标签的那条子语句；
  2. 落到这儿说明状态是 0（正常进来），才轮到 `case` 那台（`dispatch`，末尾是无条件的）。
- `switchStmt` 只剩三件事：开 `break` 那一层、把选择子求出来、把它交给函数体那一层
  （`pendingSwitch`）。`caseLabel` 里那句 `close()` 也交给 `segCut` 了。

区间判断顺手简化成一次**无符号**比较：`(unsigned)(state - 1) <= hi_i - 1`。
状态 0 减 1 是 `0xFFFFFFFF`，一条都不中，于是「状态 0」不必再单独测一次 ——
第二十四片那个 `state == 0` 的分支没了。

### 选择子要落在槽上

被重新进入时那段求值整个跳过（`headSkip`），而 MIR 是 SSA —— 跳过的那一段里发的 ref
在下面就没有定义了。所以选择子求完之后**存进一个槽**，分派那儿再读回来。
这是「跳过一段头」这条规则的必然代价：凡是头里算出来、身子里要用的值，都得落在槽上。
`if` 那一格（第二十四片的 bool 槽）是同一个理由。

### 量出来的

`tests/c/gen/26-goto-switch.c`：退出码 44 + 79B stdout，与 `tcc -run` 逐字节相同，
**一次就对**。钉住的六形：从 switch 外面跳进一个 case 里的标签（选择子一次都不算）、
从 switch 里往回跳到 switch 之前的标签（选择子每圈重算）、标签夹在两个 case 之间而
贯穿还在、switch 在循环里 `goto` 一跳出两层、里层 switch 里的标签从最外面跳进去
（分派链一层一层往里接）、标签长在 `default` 里。

`tests/c` **52 passed / 0 failed**（gen 26 条、gen-bad 6 条），
`tests/js-roundtrip` 109 passed / 0 failed。

`gen-bad/goto-in-switch` 删掉了，换成 `gen-bad/duff`：**`case` 标签长在里层的控制结构里**
（真的 Duff's device，`case 3:` 长在 `do` 的循环体里）。它不是 switch 函数体的直接
子语句，于是没有自己的段界 —— `openSegs` 当场数出来「段界比扫到的 case 少」并报边界。

### 下一片

`gen-bad/` 剩两条，都不是控制流：

- `duff`：要让「进入一个 case」也走状态机那一路（case 也编号，与语句标签同一套分派）。
  这是控制流上最后一格，但它只在 Duff's device 那一种写法里出现，不挡「拿自己编译
  tinycc」——`tccgen.c` 里没有这种写法。
- `struct-byval`：**外部**函数上的 struct 传值/返回，要真的 ABI，等后端。

所以第六刀在控制流这一栏上已经够用了。下一步转向第 8 步的库面：`libtcc1` 的等价物与
libc 头文件那一摊 —— 那是「拿自己编译 tinycc」路上下一堵墙（`tccgen.c` 第一行就
`#include "tcc.h"`）。

<!-- 第六刀第二十五片-END -->

## 落地：第八刀第一片 —— 预定义的宏（目标的自述）

### 为什么它是库面的第一格

第六刀让 C 的语法基本齐了，可 `tests/c/gen/` 里每一份还得自己写
`int printf(const char *fmt, ...);` —— 因为 `#include <stdio.h>` 走不通。走不通的第一层
原因不是「找不到 stdio.h」，是**头文件不知道自己在哪个目标上**：macOS 的
`sys/cdefs.h` 第一件事就是看 `__APPLE__`、`__LP64__`、`__has_builtin`、`_Nonnull`，
少一条就展开成另一份声明。

所以库面的第一格是这五十条宏。它们是**目标的自述**，不是 C 的语法 ——
换目标要换表，所以 `tccdefs.js` 里按 tcc 那边的来源分了段（tcc 自己 / 目标 CPU /
目标 OS / 模型 / C 标准 / 标准类型的底子 / 装成 GCC 4 / macOS 头文件要的那几条 /
指针类型 / glibc 的 `__REDIRECT` / clang 的探测宏 / nullability 标注）。

### 三条照抄 tcc 的取舍

- `_Nonnull` / `_Nullable` / `_Null_unspecified` / `_Nullable_result` **展开成空**：
  clang 的 nullability 标注，tcc 不认就抹掉。
- `__has_builtin` / `__has_feature` / `__has_attribute` 一律 **回 0**，`__REDIRECT`
  一族照定：让系统头文件走「这编译器什么都没有」那一支。
- `#define _Float16 short unsigned int`：tcc 没有 `_Float16`，拿一个同宽的整型顶着，
  于是那些声明至少能过语法。**它不是一份能算的 `_Float16`** —— 这一条是 tcc 自己的
  取舍，我们照抄，并且把「会算错」写在 `tccdefs.js` 那一条旁边。

装的顺序也照 tcc：预定义在前、命令行的 `-D` 在后（于是 `-D` 盖得掉预定义），
最后一条是 `__BASE_FILE__` = 主输入文件。谁来叫 `installPredefs`：想控制这个先后的
调用方自己先叫一次，没叫过的话 `preprocessToText` / `startParse` 会补上 ——
「忘了装预定义」这种事于是不会悄悄发生。

### 量出来的

- `tests/c/cpp/07-predef.c`：与 `tcc -E -P` **逐字节相同**，24 行。量的是「展开成什么」：
  五十条的值、函数宏（`__has_builtin(x)` / `__REDIRECT(...)`）、抹成空的那四条、
  `__BASE_FILE__`，以及拿它们做条件编译（`__aarch64__ && __SIZEOF_POINTER__ == 8`、
  `__BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__`、`#ifdef __x86_64__` 走否、
  `#undef __TINYC__` 之后确实没了）。
- `tests/c/gen/27-predef.c`：退出码 45 + 165B stdout，与 `tcc -run` 逐字节相同。
  量的是「拿它们写真代码」：`typedef __SIZE_TYPE__ my_size_t;` 一族的 `sizeof`、
  有无符号、`__UINTPTR_TYPE__` 装指针再取回来、`_Nonnull` 在声明里被抹掉、
  `__has_builtin` 决定 `LIKELY` 走哪一支、小端下逐字节看 `0x11223344`。
- `tests/c` **54 passed / 0 failed**，`tests/js-roundtrip` 109 passed / 0 failed。
  两份新用例都**一次就对**。

### 下一片

第八刀第二片：**系统头目录 + 我们自己那几份头文件**。tcc 自带
`stddef.h` / `stdarg.h` / `stdbool.h` / `float.h`（`include/`），其余转手系统的。
我们要的顺序是：

1. 一个内建的系统头目录（`#include <...>` 在 `-I` 之后再试它），
2. 在那儿放 `stddef.h` / `stdarg.h` / `stdbool.h` / `limits.h` / `float.h` ——
   照 tcc 的语义写，值来自第一片那几条宏（`__SIZE_TYPE__`、`__INT_MAX__`……），
3. 一份声明我们真的 shim 了的那些 libc 函数的头（`interp/libc.js` 的那张表），
   于是 `gen/` 里那行 `int printf(...);` 可以删掉。

**先不碰 macOS 真正的系统头** —— 那要 `#include_next`、`__asm("_name")`、
`__attribute__` 一整套，而且一进去就是几千行。它是第八刀后半的事。

<!-- 第八刀第一片-END -->


## 落地：第八刀第二片 —— 自带的那几份头文件

第一片给了目标的**自述**（那五十条宏）。这一片把自述**用起来**：`size_t` 到底是什么，
不该由头文件里的 `#ifdef __LP64__` 猜，而该由 `__SIZE_TYPE__` 说。

### 搜索顺序：`-I` 之后才是自带的

`Cpp` 多一个 `sysIncludeDirs`（tcc 的 `sysinclude_paths`）。`parseInclude` 的 tries
按 `tccpp.c:1364-1405` 排：

1. 绝对路径（只有它自己），
2. `"..."` 才看的「当前文件所在目录」，
3. `-I` 给的那些，
4. **`sysIncludeDirs`**。

两处值得记：

- 自带目录在**最后**。于是用户的 `-I` 能盖掉我们的 `stddef.h` —— tcc 就是这个顺序，
  不是我们为了方便挑的。
- `"..."` 也会一路走到第 4 步。于是 `#include "stddef.h"` 与 `#include <stddef.h>`
  都能找到自带的那份，也是照 tcc。

`cli.js` 里一个常量把它接上，`cppText` 与 `cMir` 两条路都用：

```js
const C_SYS_INCLUDE = [join(installDir(), '..', '..', 'include')];
```

即 `src/include/`。

### 装哪几份：与 tcc 自带的**一一对应**

tcc 的 `include/` 里有 `stddef.h`、`stdarg.h`、`stdbool.h`、`float.h`、`varargs.h`、
`stdatomic.h`、`tccdefs.h` 等；真正「C 标准要求编译器自己给」的是前四份。我们装的就是
前四份：

- **`stddef.h`** —— `NULL`、`size_t` / `ptrdiff_t` / `wchar_t`，类型全部从
  `__SIZE_TYPE__` / `__PTRDIFF_TYPE__` / `__WCHAR_TYPE__` 取，各自带一个
  `_SIZE_T_DEFINED` 式的守卫（同一个 typedef 被两份头各写一遍是常事）。
  外加 `offsetof(type, member) ((size_t) & ((type *)0)->member)`。
- **`stdarg.h`** —— `typedef __builtin_va_list va_list;` 加四个宏转手到
  `__builtin_va_start` / `__builtin_va_arg` / `__builtin_va_copy` / `__builtin_va_end`。
  第十七、二十三片已经把这四个内建做了，这一片只是给它们**标准的名字**。
- **`stdbool.h`** —— 四行。`bool` / `true` / `false` / `__bool_true_false_are_defined`。
- **`float.h`** —— 见下。

**没装 `limits.h`**：tcc 也不装（转手系统的）。装了就是分岔，不是复刻。
`stdalign.h` / `stdnoreturn.h` 同理。

### 量出来的一处矛盾：tcc 的 `float.h` 与 tcc 的编译器不一致

tcc 的 `float.h` 把 `LDBL_*` 按 **binary128** 写：

```
LDBL_MANT_DIG   113
LDBL_DIG        33
LDBL_MIN_EXP    -16381      LDBL_MAX_EXP    16384
LDBL_MIN_10_EXP -4931       LDBL_MAX_10_EXP 4932
LDBL_MAX        1.18973149535723176508575932662800702e+4932L
LDBL_MIN        3.36210314311209350626267781732175260e-4932L
LDBL_EPSILON    1.92592994438723585305597794258492732e-34L
DECIMAL_DIG     36
```

而在这个目标（aarch64-macos）上 tcc 自己的 `sizeof(long double) == 8` ——
`long double` 就是 `double`（第二十一片量过）。两边合起来的实际后果，量出来是：

```
ldbl 113 8 1 1          /* LDBL_MANT_DIG, sizeof(long double),
                           LDBL_MAX > DBL_MAX, LDBL_MIN == 0.0 */
```

即 `LDBL_MAX` 的字面量**溢出成 `inf`**（所以 `> DBL_MAX` 为真），`LDBL_MIN`
**下溢成 `0`**（所以 `== 0.0` 为真），而 `LDBL_MANT_DIG` 仍说 113。
一份自称 113 位有效数字的类型，`MAX` 是 `inf`、`MIN` 是 `0`。

**我们照抄这处矛盾**，理由还是那一条：tcc 的二进制是 oracle，一份逐字节对账的测试轴
不能一边说"以 tcc 为准"一边挑着改。它进了「将来 `-std=` 严格档」的候选表，
成为**第二**条（第一条是第二十三片那处链式指定初始化器的分岔）。
`src/include/float.h` 头上有一节写着这些量出来的数，免得将来有人"顺手修好它"。

`gen/28-headers.c` 里 `float.h` 那一段因此**不比十进制字面量，只比形状与关系**：

```c
printf("eps %d %d\n", 1.0 + DBL_EPSILON > 1.0, 1.0 + DBL_EPSILON / 2.0 == 1.0);
printf("range %d %d\n", DBL_MAX > 1e307, DBL_MIN < 1e-307);
printf("ldbl %d %d %d %d\n",
  LDBL_MANT_DIG, (int)sizeof(long double), LDBL_MAX > DBL_MAX, LDBL_MIN == 0.0);
```

前两行说的是"`EPSILON` 真的是最小的那个可加量"、"`MAX`/`MIN` 真的在指数范围两端"；
最后一行把矛盾**钉住**。这样写，将来换目标（`long double` 真是 binary128 的机器上）
这份用例仍然对，因为它问的是关系而不是数。

### oracle 需要的一处环境

`.omni-cache/tcc-build/` 是**树外构建**，里头没有 `include/`，于是 `-B` 指过去
`tcc -run` 也找不到自带的头，会报 `include file 'stdarg.h' not found`。补一条软链：

```
ln -s /Users/wurui/Documents/Lang/reference/tinycc/include .omni-cache/tcc-build/include
```

这不是我们代码里的事，但不写下来，下一台机器上重建 oracle 时会白花时间。

### 顺手量到的一格：tcc 的 `float.h` 里没有 `FLT_EVAL_METHOD`

C99 要求它，tcc 不给。测试里先写了它，tcc 报 `'FLT_EVAL_METHOD' undeclared` ——
于是从用例和我们的 `float.h` 里一起删掉，保持**宏集合与 tcc 相同**。

### 量出来的数

- `src/include/` 四份头，共 138 行（`float.h` 69 行，一半是那节说明）。
- `tests/c/gen/28-headers.c`：退出码 67 + 209B stdout，与 `tcc -run` 逐字节相同。
  它一份文件里同时用上四份头：`offsetof`、`size_t` 的宽度与无符号回绕、
  `va_list` 转接一层、`bool` 的宽度与"真值只有 0/1"、`float.h` 的形状与那处矛盾。
- `tests/c/run.js`：**55 passed, 0 failed**（cpp 7、inc 1、cpp-bad 13、
  gen 28、gen-bad 6）。`tests/js-roundtrip/run.js`：110 passed, 0 failed。
- 边界钉子仍是 6 条，一条没动 —— 这一片没有搬动任何边界，它只是把已有的能力
  换上标准的名字。

### 下一片

第八刀第三片：**一份声明我们真的 shim 了的那些 libc 函数的头**。
`interp/libc.js` 里那张表（`printf` / `puts` / `exit` / `malloc` / `memcpy` ……）
现在只有实现没有声明，于是 `gen/` 里每份用例都得手写一行
`int printf(const char *fmt, ...);`（在 arm64 上还是**必须**手写 —— 不写 tcc 自己
都会编错，第五片量过）。装上 `stdio.h` / `stdlib.h` / `string.h` 的**最小子集**
之后那些手写声明可以删掉，而且"我们支持哪些 libc"就成了一件**看头文件就知道**的事。

要小心的是：这一步一旦开始，就会有人想 `#include <stdio.h>` 然后用
`FILE *` / `fopen` —— 那要真的文件描述符与宿主 IO，是另一片。这一片只装
"我们已经 shim 了的那些"，多一个都不装，缺的按 tcc 的原话报
`undefined symbol '...'`。

<!-- 第八刀第二片-END -->


## 落地：第八刀第三片 —— libc 的自述

第二片装的四份头是**编译器必须自己给**的，tcc 也自带。这一片装的三份不是：
tcc 把 `<stdio.h>` / `<stdlib.h>` / `<string.h>` 转手给系统，链接期再去 libc 里找符号。
我们在解释器这条腿上**没有真的 libc 可转手** —— 指针是自家线性内存里的偏移，
宿主的 libc 读不到（`interp/libc.js` 头上那一节记着这个结论是怎么来的）。

于是这三份头的身份是**自述**：`interp/libc.js` 那张表有什么，头文件就声明什么，
**多一个都不声明**。缺的那些不会悄悄退化成 implicit int，而是照 tcc 的原话报
`undefined symbol '...'`。

这是一处**刻意的分岔**，写在这儿免得将来被当成 bug：等自带后端那条路（第 9-11 步）
真的链上 libc，这三份就换成「转手系统的」，那时 `#include_next` / `__asm("_name")` /
`__attribute__` 也都到位了。

### 装了哪些

- `stdio.h`：`putchar` / `puts` / `printf` / `sprintf` / `snprintf`，加 `EOF`。
- `stdlib.h`：`malloc` / `calloc` / `realloc` / `free` / `abs` / `labs` /
  `exit` / `abort`，加 `EXIT_SUCCESS` / `EXIT_FAILURE`。
- `string.h`：`strlen` / `strcmp` / `strcpy` / `strcat` / `strdup` /
  `memcpy` / `memmove` / `memset` / `memcmp`。

三份都 `#include <stddef.h>` 拿 `size_t` —— 于是「同一个 typedef 被三份头各带一次」
这件事也被验了一遍（`_SIZE_T_DEFINED` 守卫）。

`strdup` 是 POSIX 而不是 C 标准里的，照样放进 `string.h`：这三份头跟的是
**那张表**，不是标准的目录。

### 少了什么，为什么（每一格都是一片）

- **`FILE` / `fopen` / `fprintf` / `stdout` / `stderr`**：要真的文件描述符与宿主 IO。
  现在输出只有一条路（`printRaw` 写进程的 stdout），而对账的正是这一条。
- **`vprintf` 一族**：要把 `va_list` 再往下传一层。有意思的是这一格几乎是白送的 ——
  `cFormat` 现在拿的就是**变参区的地址**（第十六片的 ABI），而 `va_list` 在这个目标上
  就是那个地址，两者是同一个东西。但它得连着 `vsnprintf` 一起量，所以还是独立一格。
- **`atoi` / `strtol` 一族**：要自己写字符串到数的解析。tinycc 的源码在用，下一格。
- **`qsort` / `bsearch`**：要让 libc **回头**调 MIR（函数指针回调），而 CCALL 现在是
  「宿主调宿主」的单向门。这是真的一格新东西，不是补一个函数。
- **`strncpy` / `strchr` / `strstr` / `strtok`**：`interp/libc.js` 里还没有实现，
  加声明就得加实现，连着做。
- **`atexit`**：要一张退出时跑的表，而 `exit` 现在是一个抛出去的信号（`ExitCall`）。
- **`getenv` / `system`**：要宿主进程环境。

### 顺手清掉的那 47 行

从第五片起每份 `gen/` 用例头上都手写着 libc 的原型，最少一行
（`int printf(const char *fmt, ...);` —— arm64 上**必须**有，没有的话 tcc 自己
就把变参编错，第五片踩过），`06-libc.c` 那份手写了十三行。这一片把它们全换成
`#include`：**23 份用例、47 行声明**清零。

这不只是好看：那 47 行是**手抄的原型**，与 `interp/libc.js` 那张表之间没有任何
机械保证。换成头文件之后两边只有一处说法，而且「我们支持哪些 libc」变成一件
**看头文件就知道**的事。

顺带一件事：那些手写原型里 `size_t` 都写成了 `unsigned long`（那时还没有
`stddef.h`）。两者在这个目标上是同一个类型，所以换过来 stdout 一个字节都没变 ——
28 份既有用例全部逐字节照旧，这本身就是一次「头文件与手写原型等价」的对账。

`17-vararg.c` 是唯一保留 `__builtin_va_*` 写法的一份：它验的就是那几个内建本身，
标准名字那一层由 `gen/28` 验。

### 量出来的数

- `src/include/` 从 4 份 138 行长到 7 份 235 行。
- `tests/c/gen/29-libc-headers.c`：退出码 24 + 210B stdout，与 `tcc -run` 逐字节相同。
  **一行手写声明都没有**，三行 `#include` 就够。oracle 那一侧 tcc 用的是 macOS 真正的
  头（量过：`#include <stdio.h>` 那三份 tcc 编得过），我们用自带的三份 ——
  两边的原型必须兼容，逐字节对账正是在验这一句。
- `tests/c/run.js`：**56 passed, 0 failed**。`tests/js-roundtrip/run.js`：110 passed。
- 边界钉子仍是 6 条，一条没动。

### 下一片

第八刀第四片：**`atoi` / `strtol` 一族 + `strncpy` / `strchr` / `strstr`**。
选它们的理由不是「顺着标准往下抄」，而是 tinycc 的源码在用 —— 而那份源码是这一刀的
终点。做法与前几片相同：`interp/libc.js` 加实现、头文件加声明、一份 `gen/` 用例与
`tcc -run` 逐字节对账。

`strtol` 那一格要小心：`errno` / `ERANGE` 我们还没有，而 tcc 那边有真的 libc，
于是**溢出的输入**两边会分岔。用例先避开溢出，边界写成 `todo`。

<!-- 第八刀第三片-END -->


## 落地：第八刀第四片 —— `strtol` 一族与 `str` 的那几条边角

第三片装了头，这一片往表里加实现。选的是 `atoi` / `atol` / `strtol` / `strtoul` 与
`strncpy` / `strncat` / `strncmp` / `strchr` / `strrchr` / `strstr` —— 理由不是
「顺着标准往下抄」，是 tinycc 的源码在用，而那份源码是这一刀的终点。

### 一处真的 bug：无符号的返回值破了一条不变量

`strtoul("-1", NULL, 10)` 与 `18446744073709551615UL` 比，`printf("%lu")` 印出来
两边一模一样，`==` 却是假。

原因是这条腿上有一条**没写下来的不变量**：64 位整数一律以**有符号** BigInt 表示
（`builtin.js` 的 `W` 就是 `BigInt.asIntN(64, …)`，`MEM_ST.i64` 也是）。
`strtoul` 按无符号算完直接回了 `2n**64n-1n`，而同一个值从 slot 里读出来是 `-1n` ——
`==` 比的是两个 BigInt 本身，于是不相等。之前没露出来只因为 libc 里所有函数回的
都是小的正数。

修在**出口那一处**，不是在 `strtoul` 里：

```js
const v = LIBC[name](args);
return typeof v === 'bigint' ? BigInt.asIntN(64, v) : v;
```

放在 `callLibc` 上，这条不变量就对**每一个**将来加进表里的函数成立，而不是靠
「写的人记得」。`strtoul` 本身照旧按无符号算 —— 那是它的语义。

### 那几条 `str` 的边角（这一片的用例主要在钉这些）

- `strncpy`：源短了要**用 0 填满 n 个字节**，源长了**不补终止的 0**
  （C11 7.24.2.4）。它不是「安全的 strcpy」。
- `strncat`：`n` 说的是**从源那边最多取几个**，终止的 0 不算 —— 与 `strncpy` 的 `n`
  不是同一个意思。
- `strncmp`：遇到 0 就停，不是「比满 n 个字节」；回的是**字节差**（宿主的 libc
  就是这样，要逐字节对账就得跟着，第五片那条纪律）。
- `strchr(s, 0)`：回的是那个**终止符的地址**，不是 NULL（C11 7.24.5.2：终止的 0
  算这个字符串的一部分）。
- `strstr(s, "")`：回 `s`。

`strtol` 那边最容易写错的一格是 `endptr`：

- 一位有效数字都没有（`"hello"`）→ 回 0，`endptr` 指**原地址**。
- `"0xz"`（base 16 或 0）→ 那个 `0` **算**一位有效数字，`endptr` 停在 `x` 上。
  也就是说 `0x` 前缀的识别是**试探性**的，识别失败要退回去。
- `base = 0` 的三条路：`0x` → 16、`0` → 8（那个 `0` 本身就是有效数字）、否则 10。
- `strtoul` 收负号是**合法**的（C11 7.22.1.4 第 5 段：按无符号取负），
  `strtoul("-1")` 回 `ULONG_MAX` 而不是报错。

### 不能拿 tcc 对账的一格：溢出

C 说溢出时回端点值（`LONG_MAX` / `LONG_MIN` / `ULONG_MAX`）并把 `errno` 设成
`ERANGE`。我们回同样的值，但**没有 `errno`** —— 那要一份 `<errno.h>` 与一个
每线程的变量，独立一格。tcc 那边有真的 libc，所以溢出的输入两边会分岔，
用例避开它。这一格记在 `src/include/stdlib.h` 头上。

### 量出来的数

- `tests/c/gen/30-strtol.c`：退出码 37 + 21 行 stdout，与 `tcc -run` 逐字节相同。
  21 行里有 11 行专门钉上面那些边角。
- `tests/c/run.js`：**57 passed, 0 failed**。`tests/js-roundtrip/run.js`：110 passed。
- 边界钉子仍是 6 条。

### 下一片

第八刀第五片：**`qsort` / `bsearch`**。它们与前几片**不是同一类活**：要让 libc
能**回头**调 MIR 里的函数（比较器是个函数指针），而现在 CCALL 是「宿主调宿主」的
单向门。函数指针的值已经是「函数表下标 + 1」（第十三片定的），所以宿主那边拿到的
是一个能查表的整数 —— 缺的是一条「从宿主回到解释器」的路。

这条路一通，`atexit`、`signal`、以及将来 wasm 那边的 `table` 调用都是同一件事，
所以它值得单独一片。

<!-- 第八刀第四片-END -->


## 落地：第八刀第五片 —— `qsort` / `bsearch`，libc 回头调 MIR

前四片都是「宿主替 C 干一件事」。这一片不同：比较器是 C 里的一个**函数指针**，
libc 得**回头**调 MIR。在这之前 CCALL 是一扇单向门。

### 门开在哪儿，为什么

开在 `interp/libc.js` 上，一个模块级的钩子：

```js
let callFnPtr = null;
export function setFnPtrCaller(fn) { callFnPtr = fn; }
```

由跑模块的那一层（`runMirModule`）在开跑前装上：

```js
setFnPtrCaller((ptr, args) => {
  const no = fnPtrNo(ptr);
  if (no < 0) failRt('call of a null function pointer');
  if (I.mir.funcs[no] === undefined) failRt(`function pointer index ${no} out of range`);
  return I.callFunc(no, undefined, args);
});
```

方向决定了它该在哪儿：libc 是**被调**的一方，它要的是一个「拿函数指针值 + 实参，
回返回值」的回调；而**函数指针值的编码**（函数号 + 1，第十三片定在 `ir.js` 的
`CALLI` 上）是 MIR 的事，libc 不该认得它。所以钩子的声明在 libc、实现在解释器 ——
两边各知道自己该知道的那一半。

检查与 `CALLI` 那一支**逐条相同**（空指针、下标越界、同样的消息）：同一件事只该有
一种失败方式。

这条路一通，`atexit` / `signal` 与 wasm 那边的 `table` 调用都是同一个形状。

### `qsort` 用插入排序，而且这是个决定

C 只要求「排好」（C11 7.22.5.2），不要求稳定、也不要求 O(n log n)。插入排序在这儿
有一个具体的好处：**比较器拿到的是真的元素地址**，交换就地做，所以这一份实现
不需要临时缓冲区、也不碰堆 —— 而堆可能根本没初始化（没用过 `malloc` 的程序连
`__omni_heap_init` 都不发）。

代价写在明处：**相等元素之间的次序是未规定的**，宿主的 libc 与我们不是同一个算法。
所以要逐字节对账的用例里不能有比较相等的元素，也不能把「比较器被调了几次」
算进输出 —— `gen/31` 只问 `calls > 0`。这一格记在 `src/include/stdlib.h` 上。

`bsearch` 那边有一处次序容易写反：比较器的两个实参是 **key 在前**、数组元素在后
（C11 7.22.5.1）。

### 量出来的数

- `tests/c/gen/31-qsort.c`：退出码 18 + 12 行 stdout，与 `tcc -run` 逐字节相同。
  钉了七格：int 数组升/降、一个元素与零个元素、struct 数组（元素比一个字宽，
  交换按字节做）、比较器有副作用（说明它真的在我们这边跑）、`bsearch` 命中/未命中/
  空数组、以及**通过一个函数指针变量**传比较器（不是直接写函数名）。
- `tests/c/run.js`：**58 passed, 0 failed**。`tests/js-roundtrip/run.js`：110 passed。
- 边界钉子仍是 6 条。

### 下一片

第八刀第六片：**`vsnprintf` 一族**。`cFormat` 现在拿的就是变参区的地址，而
`va_list` 在这个目标上**就是**那个地址 —— 所以 `vprintf(fmt, ap)` 是把 `ap`
原样交给 `cFormat`。要量的是「变参区的地址能不能穿过一层函数调用」，
以及 `va_copy` 之后两条游标互不干扰。

再往后是 `<errno.h>`（`strtol` 的溢出那一格等着它）与 `FILE` / `fopen`
（要真的文件描述符与宿主 IO，是这一刀里最大的一格）。

<!-- 第八刀第五片-END -->


## 落地：第八刀第六片 —— `vprintf` 一族

这一片几乎是白送的，而**为什么**白送是这一节唯一值得写的东西。

第十六片定的变参 ABI 是：变参函数的签名里多一个隐藏的最后一个形参，指向调用方帧上的
一块「变参区」（一格 8 字节）。`va_list` 就是那个指针（`tccgen.js` 把
`__builtin_va_list` 定成 `void *`），`va_arg` 就是「按要的类型读一格、加 8」。
而 `cFormat` 拿的第二个实参**正是那个地址**。

于是 `vprintf(fmt, ap)` 的实现是把 `ap` 原样交给 `cFormat` —— 与 `printf` 那条
一个字不差，区别只在地址从哪儿来：`printf` 那条是编译器在调用点摊出来的变参区，
这条是调用方传进来的一个指针。**同一个东西的两个名字**。

这不是巧合，是第十六片选那个 ABI 时就想要的性质：真的 ABI 里 `va_list` 也是「指向
实参区的游标」，所以照着做的结果自然对上。

`vsprintf` / `vsnprintf` 同理，`vsnprintf` 照旧回「本来会写多少」。

### 量出来的一格：`<stdio.h>` 不能替你带 `<stdarg.h>`

我们的 `stdio.h` 里 `#include <stdarg.h>`（要 `va_list` 才能声明 `vprintf`），
所以在我们这一侧 `va_start` 那几个宏顺带就有了。macOS 真正的 `stdio.h` 只带**类型**
（`__darwin_va_list`）不带宏 —— 于是只写 `#include <stdio.h>` 的代码在 tcc 那一侧
报 `implicit declaration of function 'va_start'` 加三条 `unresolved reference`。

这不是我们的 bug（C 标准把那几个宏放在 `<stdarg.h>` 里，用了就该包），
但它是一个**真实存在的分岔**：我们更宽松。用例照标准写 —— 显式包
`<stdarg.h>` —— 于是它同时在两边成立。

### 量出来的数

- `tests/c/gen/32-vprintf.c`：退出码 9 + 9 行 stdout，与 `tcc -run` 逐字节相同。
  钉了六格：包一层 `vprintf`、包一层 `vsnprintf`（正常/截断/`cap = 0` 三种）、
  `va_copy` 之后「先量长度再写」（`vsnprintf(NULL, 0, …)` 那个惯用法）、
  `ap` **再往下传一层**（`vprintf` 不是终点）、以及浮点与宽度/左对齐/正号
  穿过去之后还对。
- `tests/c/run.js`：**59 passed, 0 failed**。`tests/js-roundtrip/run.js`：110 passed。
- 边界钉子仍是 6 条。

### 下一片

第八刀第七片：**`<errno.h>` 与 `<ctype.h>`**。前者是第四片欠下的（`strtol` 的溢出
那一格在等它），要一个「宿主与 C 都看得见」的变量 —— 也就是线性内存上的一格，
加一条取它地址的 libc 入口（glibc 的 `__errno_location` 就是这个形状）。
后者是十几个一行函数，但它有一处容易错：`isupper` 那些收的是 `int` 而且允许 `EOF`。

再往后是这一刀最大的一格：`FILE` / `fopen` / `fread` / `fprintf` —— 要真的文件
描述符与宿主 IO。tinycc 的源码从命令行读文件、往 stderr 写诊断，绕不开它。

<!-- 第八刀第六片-END -->


## 落地：第八刀第七片 —— `<ctype.h>`

十三条一行的函数，值得写下来的只有三处边角与一处顺带量到的事。

### 三处边角

1. **`EOF` 是合法输入**。C11 7.4 第 1 段：实参要么是 `unsigned char` 能表示的值、
   要么是 `EOF`。所以实现里**不能**先 `asUintN(8)` —— 那会把 -1 变成 255（`ÿ`），
   于是 `isprint(EOF)` 莫名为真。范围外的一概回 0。
2. **回的只保证非零**，不保证是 1。glibc 回的是位掩码（`isdigit` 是 2048 那类），
   macOS 回 1。我们回 1，但用例照 C 的保证写（`p(c) != 0`）—— 换一台机器
   这份用例仍然成立，而如果照实比数就会在 Linux 上炸。
3. **`toupper`/`tolower` 对不认识的输入原样回**，包括 `EOF` 与非字母。这两条的
   返回值是**有定义**的，所以照实比（`toupper(EOF)` 是 -1）。

只做 "C" locale。C 允许 `isalpha` 在别的 locale 下更宽，那要一整套 locale 机制，
而 tinycc 的源码只用 C locale。

### 顺带量到的一件事：libc 的函数可以当函数指针用

`gen/33` 里那个 `row(name, isalpha)` 把 libc 的谓词**当函数指针传进去**，
两边都对。我们这一侧能成，靠的是第五片给外部符号造的**转发桩**（`unit()` 末尾）：
外部函数在函数表里也有一格，于是「取它的地址」与自家函数没有区别。

这条性质之前没有用例碰过 —— 之前所有 libc 调用都是直接写名字。

### 量出来的数

- `src/include/ctype.h`：30 行，13 条声明。
- `tests/c/gen/33-ctype.c`：退出码 10 + 14 行 stdout，与 `tcc -run` 逐字节相同。
  11 条谓词各在 8 个代表性字符加 3 个边角（`EOF` / `0` / `127`）上量一遍。
- `tests/c/run.js`：**60 passed, 0 failed**。`tests/js-roundtrip/run.js`：110 passed。
- 边界钉子仍是 6 条。

### 下一片：`<errno.h>`，而它需要一个决定

第四片欠下的 `errno` 不是「再加一个函数」—— 它要一个**宿主与 C 都看得见的变量**。
三条路都想过：

- **宿主那边一个 JS 变量 + `__omni_errno_get/set`**：不行。C 要求 `errno` 是一个
  **可改的左值**（`errno = 0` 必须能写），函数回不出左值。
- **glibc 的形状**：`errno` 是宏，展开成 `(*__errno_location())`，那个函数回一个
  `int *`。这条路对，但那个指针得指进**线性内存**，而线性内存的版图是前端定的
  （`tccgen.js` 末尾那张表）—— libc 自己划一块的话会与堆/影子栈打架。
- **前端在 data 段里留一格，开跑前用一条 CCALL 把地址交给宿主**：与
  `__omni_heap_init` 完全同一个形状（第十五片已经走过一遍）。

所以第八片就是这一条：data 段里留 4 个字节、一条 `__omni_errno_init`、
一个 `__omni_errno_location` 入口、头文件里 `#define errno (*__omni_errno_location())`
加那几个 `E*` 的值（照本机的 `<sys/errno.h>` 量）。第四片 `strtol` 溢出那一格
就能与 tcc 对上账。

它是这一刀里第一次**因为库面而动前端**，所以单独一片。

<!-- 第八刀第七片-END -->


## 落地：第八刀第八片 —— `<errno.h>`，第一次因为库面而动前端

第七片末尾把三条路摆出来了，落下来的是第三条。这一节记它长什么样、以及它顺带补上了
第四片欠的那笔账。

### 那一格在哪儿

`errno` 必须是**可改的左值**（`errno = 0`、`errno++`、`&errno` 都得成立），
所以它只能是一块**内存**。形状照 glibc：

```c
int *__omni_errno_location(void);
#define errno (*__omni_errno_location())
```

那块内存在 **data 段的末尾 4 个字节**，由前端留（版图是前端定的）：

```js
let errnoAddr = 0;
if (gen.errnoUsed) {
  errnoAddr = alignUp(gen.dataOff, 4);
  gen.dataOff = errnoAddr + 4;
}
```

地址在入口处交给宿主，与第十五片的堆一字不差地对称：

```js
if (gen.errnoUsed) {
  entry.emit(OP.CCALL, T_VOID, mod.cabiNo('__omni_errno_init'),
    entry.pushArgs([mod.consts.int(BigInt(errnoAddr))]), 0);
}
```

「用到了吗」在**外部符号那张清单**里问（`unit()` 末尾那个循环），与 `HEAP_FNS`
同一处 —— 因为「用到 errno」就等于「`__omni_errno_location` 是这个单元里的一个
外部符号」。没用到的模块**不留那 4 个字节、也不发那条 CCALL**。

**那一格不写一个字节 data**：线性内存出生全是 0，而 C 正好要求「程序启动时 `errno`
是 0」（C11 7.5 第 3 段）。这与「没有初始化式的全局量不写 data」是同一条。

### 顺带补上第四片欠的账

`strtol` 溢出时现在设 `ERANGE`（34，照本机的 `<sys/errno.h>` 量的），于是
**溢出的输入也能与 tcc 对账了** —— 第四片那条「用例避开溢出」的限制解除。
`gen/34` 里那四行正是它：

```
over 9223372036854775807 1     /* LONG_MAX + errno == ERANGE */
under -9223372036854775808 1
edge 9223372036854775807 0     /* 正好在边界上：不算溢出，errno 不动 */
fine 123 0
```

`strtoul("-1")` 那一格照旧**不设** errno（按无符号取负是合法的，不是错误）。

### 头文件里只放我们真的会设的那几个

本机的 `<sys/errno.h>` 有八十多个 `E*`。我们放十个（`EPERM` / `ENOENT` / `EINTR` /
`EIO` / `ENOMEM` / `EACCES` / `EEXIST` / `EINVAL` / `EDOM` / `ERANGE`），值都量过。
多出来的那些没有一个地方会写它们 —— 而「有哪些」应当等于「我们真的会设哪些」，
与第三片那条纪律相同。

`strerror` / `perror` 没有：要一张号到文字的表，而那些文字得与本机 libc 逐字节相同
才能对账。独立一格。

### 量出来的数

- `src/include/errno.h`：36 行。前端那边一共 12 行（一个字段、一个常量、
  留格子的四行、发 CCALL 的四行）。
- `tests/c/gen/34-errno.c`：退出码 10 + 11 行 stdout，与 `tcc -run` 逐字节相同。
  钉了五格：出生是 0、读写与清零、那几个数、`strtol`/`strtoul` 的溢出与边界、
  以及**它真的是左值**（`+=`、`++`、`&errno` 拿去写）。
- `tests/c/run.js`：**61 passed, 0 failed**。`tests/js-roundtrip/run.js`：110 passed。
- 边界钉子仍是 6 条。

### 下一片

第八刀第九片：**`FILE` / `fopen` / `fread` / `fclose` / `fprintf` / `stderr`**。
这是这一刀里最大的一格，也是绕不开的一格 —— tinycc 的源码从命令行读文件、往
`stderr` 写诊断。要想清楚的是：

- `FILE` 是**不透明的**，所以它可以就是一个小整数包在结构里（fd），宿主那边一张表。
  但 `stdout` / `stderr` 是**对象的地址**（`FILE *`），得在 data 段里有真的一格 ——
  与 `errno` 这一片同一个手法，只是要三格而不是一格。
- 读文件要真的宿主 IO，而解释器现在只有 `printRaw` 一条出去的路。
- `fprintf(stderr, …)` 与 `printf` 的对账口径不同：stdout 逐字节比，stderr
  在测试轴上现在是「非空就算 tcc 拒了这份用例」（`tests/c/run.js` 那一句）——
  这一片要先把那条口径改掉，否则第一个 `fprintf(stderr, …)` 的用例会被判成失败。

最后一条说明这一片**得先动测试轴**，不是先动 libc。

<!-- 第八刀第八片-END -->


## 落地：第八刀第九片 —— 三条标准流，与测试轴的一次口径改动

`FILE` 那一格分成两片：这一片只有 `stdout` / `stderr` / `stdin` 三条标准流与
往上写的那几条，真的文件（`fopen`）是下一片。

### 先动测试轴，不是先动 libc

到第八片为止 `gen/` 那一组的判据里有这么一句：

```js
if (want.err !== '') { bad(name, `tcc 自己就拒了这份用例`); continue; }
```

那时**没有任何用例会往 stderr 写字**，所以「tcc 的 stderr 非空」等价于「这份用例
本身有问题」。第一个 `fprintf(stderr, …)` 的用例一进来，这条判据就会把对的判成错的。

改成两件事：

1. `isTccDiag(err)` —— 认出 **tcc 自己的话**：`tcc: error: …` / `tcc: warning: …`
   以及 `文件.c:行: error: …`（`tccpp.c` 的 `tcc_error`/`tcc_warning` 那两种形状）。
   这两种仍然算「tcc 拒了这份用例」。
2. 别的 stderr **逐字节对账**，与 stdout 同一条纪律。

第 2 条顺带把测试轴收紧了一格：我们这一侧的运行期错误也走 stderr
（`omni: runtime error: …`），所以从这一片起「多出一句错误消息」也会被抓住 ——
以前它只在退出码变了的时候才露出来。

### `FILE` 是不透明的，所以它可以是一个小整数

C 不让程序碰 `FILE` 的里头（`typedef struct __omni_FILE FILE;` —— 一个**不完整**
类型）。于是句柄取 1 / 2 / 3（stdin / stdout / stderr）。这三个数落在**页 0** 里，
而页 0 整页留空（版图的第一条），所以它们**不可能与任何真的指针撞上**；
`NULL` 是 0，`f == NULL` 也照旧对。

`stdout` / `stderr` 是宏，展开成 `__omni_stdout()`。这一处与 `errno` 那一片
**刻意不同**：C 只要求这三个是「`FILE *` 类型的**表达式**」（C11 7.21.1），
不要求可改的左值，所以一次函数调用就够 —— 不必像 `errno` 那样在 data 段里留格子。
两片放在一起正好说明「什么时候必须是内存、什么时候不必」。

### 缓冲：stdout 攒着，stderr 直写

`printf` 与 `fprintf(stdout, …)` 走的是同一个缓冲（`printRaw`），而 stderr **直写**
—— C 的 stderr 本来就不带缓冲（C11 7.21.3 第 7 段）。写 stderr 之前先把 stdout
攒着的冲掉，否则同一个终端上两条流的先后会与 tcc 那边相反。测试轴上两条流分开
对账，所以它们之间的交错不进入 oracle。

### 量出来的一格：`fwrite(p, 0, n, f)` 回 0

C11 7.21.8.2 最后一句：`size` 或 `nmemb` 是 0 时回 **0**，而不是回 `nmemb`。
我们一开始回了 4，本机的 libc 回 0 —— 逐字节对账当场抓住。

### 量出来的数

- `tests/c/gen/35-streams.c`：退出码 12 + 11 行 stdout + 3 行 **stderr**，
  三样都与 `tcc -run` 逐字节相同。钉了七格：`fprintf` 到 stdout 与 printf 同流、
  `fputs` 不补换行、`fputc` 回那个字符、`fwrite` 回成员数与「长度 0 回 0」、
  `fflush(NULL)`、三条句柄互不相同且都非 NULL、以及**包一层
  `vfprintf(stderr, …)`**（tinycc 自己的诊断就是这个形状）。
- `tests/c/run.js`：**62 passed, 0 failed**。`tests/js-roundtrip/run.js`：110 passed。
- 边界钉子仍是 6 条。

### 下一片

第八刀第十片：**`fopen` / `fread` / `fgets` / `fseek` / `ftell` / `fclose` / `feof`**。
要的东西这一片已经备好一半：句柄从 4 起、宿主那边一张表。缺的是真的宿主 IO ——
`host/native.js` 现在有 `readText`/`writeText`（整份读写），而 `fread` 要**按位置读
一段**。两条路：一是开文件时整份读进宿主的一个缓冲、`fread` 从那儿切（简单，
但大文件与「边写边读」不成立），二是给 `host/native.js` 加真的 fd 级入口。
tinycc 的源码读源文件正是「整份读进来」，所以第一条够用 —— 但要在 ADR 里写明
它是一个**刻意的简化**，而不是忘了。

<!-- 第八刀第九片-END -->


## 落地：第八刀第十片 —— 真的文件，与一处写在明处的简化

`fopen` / `fclose` / `fread` / `fgets` / `fgetc` / `fseek` / `ftell` / `rewind` /
`feof` / `ferror` / `remove`。句柄从 4 起（1/2/3 是三条标准流），宿主那边一张表：
`{ path, data, pos, write, eof, err, dirty }`。

### 那处简化：整份快照

`fopen` 时把整份文件读进宿主的一个字符串（**一个字符一个字节**），`fread`/`fgets`/
`fseek` 都在那份快照上走；写模式攒在同一个字符串里，`fclose`/`fflush` 时整份落盘。

于是**不成立**的有三件事，逐条写在这儿而不是留给将来的人猜：

- **很大的文件**：整份进内存。
- **边写边被别人读**：别人看到的是落盘那一刻的样子。
- **`remove` 不真的删盘上的文件**，只把还开着的那份忘掉（`host/native.js` 里没有
  unlink）。

选它的理由：tinycc 的源码读源文件正是「整份读进来」，而真的 fd 级 IO 要给
`host/native.js` 加一套 open/read/seek/close —— 那是后端那几步真的要跑
`tcc -run` 时才必须的一格。

`host/native.js` 只加了两条，而且与既有的 `readText`/`writeText` 差别只有一处：
**latin1 而不是 UTF-8**（`readBinary`/`writeBinary`）。C 的 `FILE` 是字节流、
线性内存里也是字节，中间过一遍 UTF-8 解码会把非 ASCII 的字节改掉。

### 「从 main 返回」也要收摊

C11 5.1.2.2.3：从 `main` 返回等价于 `exit`，而 `exit` 会冲刷并关掉所有流
（7.22.4.4）。所以没写 `fclose` 的程序**也该**看到文件里有东西 —— 新加的
`libcAtExit()` 在跑模块那一层的**两条**出去的路上（正常返回与 `ExitCall`）都调。

它顺带把三样进程级状态清了：文件表、句柄计数、`errno` 那一格的地址、堆的起点。
同一个进程里跑两个模块时不清就会把上一遍的状态漏进下一遍 —— `tests/mir` 那条轴
正是一个进程里跑很多个模块。

### 四处照实量出来的边角

- **`fread` 回成员个数**，读到一半停下的那个成员**不算**（C11 7.21.8.1）。
  搞错的话「读满一块就继续」的循环会多走一轮。
- **`fseek` 成功要清掉 eof 标志**（7.21.9.2）。漏了的话「seek 回开头再读一遍」
  立刻以为又到头了。
- **`feof` 说的是「上一次读撞到了末尾」**，不是「现在在末尾」（7.21.10.2）——
  所以它由 `fread`/`fgets`/`fgetc` 置，不在 `feof` 里现算。
- **`fgets` 一个字节都没读到时回 NULL**，不是回空串（7.21.7.2）。

### 量出来的数

- `tests/c/gen/36-files.c`：退出码 35 + 18 行 stdout，与 `tcc -run` 逐字节相同。
  写三行（`fputs`/`fprintf`/`fwrite` 各一种）、`fgets` 逐行读回、`fseek` 三种
  `whence`、`fread` 的成员计数、`SEEK_END` + `ftell` 当文件长度、`fgetc` 数到底、
  `rewind` 后整份读、打不开回 NULL、追加模式接在后面。
  文件放 `/tmp` 下一个固定的名字 —— 工作目录不留东西，而文件名不进 stdout。
- `tests/c/run.js`：**63 passed, 0 failed**。`tests/js-roundtrip/run.js`：110 passed。
- 边界钉子仍是 6 条。

### 下一片

第八刀第十一片：**`int main(int argc, char **argv)`**。现在 `lowerC` 那儿还钉着
`第六刀：'int main(argc, argv)' 还没到（要变参与 argv）`，而这一格现在**只差
版图上的一块**：入口函数要把命令行的那几个串写进 data 段（或堆），再把
`argv` 那张指针表也摆好，然后按两个实参调 `main`。

它是「让 `omni tcc x.c` 这条命令真的能跑」的最后一格库面 —— tinycc 的
`main` 第一件事就是读 `argv`。

<!-- 第八刀第十片-END -->

## 落地：第八刀第十一片

**`int main(int argc, char **argv)`。**

到第十片为止 `lowerC` 那儿一直钉着 `第六刀：'int main(argc, argv)' 还没到`。这一格
落地之后，`main` 的两种写法都认了 —— 而它是「让 `omni tcc x.c` 这条命令真的能跑」的
最后一格库面：tinycc 的 `main` 第一件事就是读 `argv`。

### argv 住 data 段

tcc 那边 argv 在真的进程栈上，由 `execve` 摆好。我们这一侧线性内存自己说了算，于是
**命令行的那几个串与 `argv` 那张指针表都进 data 段**：

```
[64K, dataOff)  data 段：字符串字面量、全局量，
                末尾是 argv 的那几个串 + 那张指针表 + errno 那一格
```

这么摆的好处是**入口处一条写内存的指令都不必发** —— 串的内容与表的内容都在编译期
就知道，直接是 data 段的初始内容，`main` 的两个实参是两个常量。堆与 errno 那两格要
在入口处发一条 CCALL 把地址交给宿主（宿主要写它们），argv 不用：宿主一侧不碰它。

三条照实量出来的（`tcc -run x.c aa bb` 上量的，见下）：

- **`argv[0]` 是命令行上写的那个源文件名**，不是绝对路径、也不是 `tcc`。
- **`argv[argc]` 是 NULL**（C11 5.1.2.2.1 第 2 段也要求）。这一格**不写一个字节**
  data —— data 段出生全是 0。
- 串的顺序就是命令行的顺序，`-run` 之后的第一个非选项之后的全归被跑的程序。

还有一条不是量出来的、是标准要求的：**argv 的那些串必须可改**（同一段）。所以它们
**不走 `strData`** —— 那儿按内容去重，与某个字符串字面量共享一份的话，改一个会把另一个
也改了。`37-argv.c` 里有一格专门量这件事（改掉 `argv[0][0]` 再改回去）。

### `--`：命令行上多一刀

tcc 不需要这一刀：`-run` 是个**开关**，它后面第一个非选项是源文件，再往后全归被跑的
程序。我们的 `c-run` 是个**子命令**，而 `-I`/`-D` 跟在源文件**之后**
（`c-run x.c -I dir`），于是程序自己的 argv 与我们的选项会撞在一起。办法是
`cli.js` 的 `cSplitArgs`：**`--` 之后的都是被跑的程序的**。

```
node src/core/cli.js c-run x.c -I dir -- aa bb
tcc -B … -run x.c aa bb                # 同一件事，tcc 的摆法
```

`c-mir` 也吃同一刀 —— 不然「印出来的 MIR」与「跑的那个 MIR」会不是一个（argv 的串
占的 data 不一样）。

### 命令行的串要编码，源文件的串不用

data 段里放的是**字节**。字符串字面量那条路（`strData`）是 `charCodeAt % 256`：
预处理器拿到的源文件在那儿已经是「一个字符一个字节」了，不必再编码。命令行不一样 ——
`process.argv` 是 node 解码过的 JS 串，所以多了一个 `utf8Bytes`（10 行，
`tccgen.js` 里 `lowerC` 之前）。

量的时候顺手撞见一个**与这一片无关的**洞：非 ASCII 的字节在**输出**那一侧会被编两遍。
`printf("漢字")` 两条腿的 `sizeof` 都是 7（内存里的字节是对的），可 stdout 上
tcc 是 `346 274 242 …`，我们是 `303 246 302 274 …` —— `host/native.js` 的 `stdout`
按 UTF-8 写一个已经是字节串的 JS 串。这一条不在这一片里改：那个 `stdout` 是**五门语言
共用**的，asy 那边的串是真的 JS 串，改成 latin1 会把那一侧弄坏。它要自己一片
（「stdout 是字节，不是字符」），见下面的「下一片」。

### 边界

`main` 只认 `()` 与 `(int, char **)`。第三个形参（`envp`，POSIX 的扩展，tcc 认）
错在明处，`tests/c/gen-bad/main-envp.c` 钉着它：

```
第八刀：'main' 只认 () 与 (int, char **)
```

它没跟着这一片一起做，是因为它要先答一个别的问题：「环境」住线性内存的哪一段、
`getenv` 从哪儿读。那和 argv 不是同一格。

`argc` 的类型按形参声明的给（`int` 是 i32，`long` 之类是 i64）；`argv` 只要求是指针，
所以 `char *argv[]` 那种写法也认 —— 形参上的数组**就是**指针（C11 6.7.6.3 第 7 段），
`paramList` 早就退化过了。

### 量出来的数

- `tests/c/gen/37-argv.c`：退出码 13 + 122 字节 stdout，与 `tcc -run`
  逐字节相同。量的是：`argc == 1`、`argv` 与 `argv[0]` 都不是空指针、
  `argv[argc] == 0`、`argv[0]` 以 `37-argv.c` 收尾、下标走法与指针走法一致、
  串可改（改完再改回去，两次都比）、`argv` 与 `argc` 自己是可改的左值（形参就是局部量）。
  **不印 `argv[0]` 本身** —— 两条腿拿到的是同一个绝对路径，印它也能对上，
  可那样这份用例就跟着机器走了。
- 多个实参那一侧单量过（`.omni-cache` 里一份临时的探针，用完删了）：
  `argc=4`、`[0]` 是源文件名、`[1]`/`[2]`/`[3]` 是 `aa`/`b c`/`漢字`、`argv[argc]==0`，
  除了上面那条输出编码的洞之外与 tcc 逐字节相同。
- `tests/c/run.js`：**65 passed, 0 failed**。`tests/js-roundtrip/run.js`：110 passed。
- 边界钉子 6 -> **7** 条（多了 `main-envp`）。

### 下一片

第八刀第十二片：**stdout 是字节，不是字符**。上面那个洞：C 这一条腿上一个「串」
是一串字节（`latin1`），而 `host/native.js` 的 `stdout` 按 UTF-8 写它。要做的是让
C 这条腿的输出走一条**按字节**写的门（`writeBytes`），而不去动五门语言共用的那个
`stdout`；`printRaw` 现在是 asy 的 `write` 与 C 的 `printf` 共用的，也要跟着分开。
它值一片，因为「byte-exact stdout」是这一刀的 oracle 本身 —— 一条编错的字节现在
只在非 ASCII 上出现，可 tinycc 自己的源码里有非 ASCII（注释与字符串都有）。

之后仍是原来的顺序：`strerror`/`perror`（要一张逐字节对得上的消息表）、`scanf` 一族、
`gen-bad/duff`、`struct-byval`、真的 macOS 系统头。

<!-- 第八刀第十一片-END -->

## 落地：第八刀第十二片

**stdout 是字节，不是字符。**

上一片量 argv 的时候撞见的：`printf("漢字")` 两条腿的 `sizeof` 都是 7（内存里的
字节是对的），可 stdout 上 tcc 是 `346 274 242`，我们是 `303 246 302 274 302 242`。
`host/native.js` 的 `stdout` 是 `process.stdout.write(s)`，node 默认按 UTF-8 编 ——
而 C 这一条腿上一个「串」**已经是一串字节了**（一个字符一个字节），再编一遍就成了
每个字节自己变两个字节。

这是一条 **byte-exact 的轴上的真错**，不是一个显示问题：`tests/c/gen/` 那一组比的
就是整条 stdout 的字节。它到第十一片才露出来，只因为在那之前没有一份用例里有非 ASCII。

### 为什么不能就地把 `stdout` 改成 latin1

那个 `stdout` 是**五门语言共用**的。asy/jancy 那一路的串是真的 JS 串（`print "漢字"`
里那个是两个字符），按 UTF-8 写是对的；改成 latin1 会把那一侧弄坏（`漢` 的
`charCodeAt` 是 0x6F22，latin1 只取低 8 位，出去就成了 `"`）。

所以两侧各一扇门：

- `host/native.js`：`stdout` / `stderr` 照旧按 UTF-8；新增 `stdoutBytes` /
  `stderrBytes`，走 `Buffer.from(s, 'latin1')`。
- `interp/builtin.js`：`printRaw`（asy 的 `write`、`js_proc_stdout_write`）照旧；
  新增 `printBytes`，C 的 `printf`/`puts`/`putchar`/`vprintf` 与 `streamWrite` 的
  stdout 那一支改走它。
- `interp/libc.js`：stderr 直写那一支从 `stderr` 换成 `stderrBytes`。

### 一个缓冲区两种口径

`outBuf` 仍然只有一个 —— 两个缓冲区会让「谁先落盘」变成一件说不清的事，而
「直写的那一路不能插到已缓冲、还没落盘的输出前面去」这条不变量是原来就有的。
办法是缓冲区带一个口径标记，切换口径时**先把攒着的落盘**：

```js
function outMode(bytes) {
  if (outBuf.length > 0 && bytes !== outIsBytes) flushOut();
  outIsBytes = bytes;
}
```

一次运行实际上只会是其中一种（C 的模块不会调 asy 的 `write`），这几行只是让
「万一」也是对的 —— 顺序比省一次 `write` 重要。

我们自己的运行期错误（`omni: runtime error: …`）仍走 UTF-8 那扇门：那是我们的诊断，
不是被跑的程序的输出，而它的文字里有中文。

### 量出来的数

- `tests/c/gen/38-bytes.c`：退出码 25 + 6 行 stdout + 2 行 stderr，与 `tcc -run`
  逐字节相同。量的是：源文件里的非 ASCII 字面量（`sizeof` 与 `strlen` 都数字节）、
  `putchar` 一个字节一个字节凑出一个字、`%c` 拿高字节、`%s` 里高字节在串中间、
  一个字节一个字节印 `(unsigned char)`（`char` 在这个目标上是**有符号**的）、
  stderr 那条也是字节。
- `tests/c/run.js`：**66 passed, 0 failed**。`tests/run.js`：96 passed。
  `tests/js-roundtrip/run.js`：110 passed。
- 边界钉子仍是 7 条。

### 下一片

第八刀第十三片：**`strerror` / `perror`**。它要一张**逐字节对得上的消息表** ——
`strerror(ENOENT)` 在 macOS 上是 `No such file or directory`，那串字必须从
oracle 上量出来，而不是自己编。`perror` 是它加一句 `: ` 与 `\n` 往 stderr 上写，
第九片那扇门已经在了。

之后仍是原来的顺序：`scanf` 一族、`gen-bad/duff`、`struct-byval`、
真的 macOS 系统头。

<!-- 第八刀第十二片-END -->

## 落地：第八刀第十三片

**`strerror` / `perror`。**

这一片的难处不在实现，在**那张表**：`strerror(2)` 在 macOS 上是
`No such file or directory`，那串字必须与本机的 libc 逐字节相同，否则 `perror`
的输出进不了对账。所以整张表（0..107）与「表外是什么样」都是从 oracle 上量出来的
—— `tcc -run` 里一个 `for` 印 `strerror(0..110)`，抄下来的就是 `libc.js` 的 `ERRSTR`。

第 0 格也占着：macOS 上 `strerror(0)` 是 `Undefined error: 0`，不是空串。
表外（含负数）是 `Unknown error: N`。

### 两条**指针**上的性质，也是量出来的

一开始的设计是「一块共用的缓冲，每次写进去」—— C11 7.24.6.2 第 3 段确实允许
「下一次调用改掉上一次的串」。可量出来 macOS **不是**这样：

```
char *a = strerror(1), *b = strerror(2);
printf("[%s][%s] same=%d\n", a, b, a == b);
→ [Operation not permitted][No such file or directory] same=0
```

也就是说已知的号是一张**常量表**：同一个号两次回同一个地址，不同的号回不同的地址，
先拿到的那个串不会被后来的调用改掉。而表**外**的号确实共用一块：

```
char *a = strerror(999), *b = strerror(1000);
→ [Unknown error: 1000][Unknown error: 1000] same=1
```

共用一块缓冲的实现会在第一条上分岔（`same` 会是 1，两个 `%s` 会印同一句话）。
所以落地的形状是**一号一格**：

```
strerror(n) 的地址 = base + (n 在表内 ? n : 108) * 48
```

48 字节一格（最长那句 46 个字符 + 结尾的 0 是 47，48 让每格 8 对齐），
109 格（108 个号 + 表外那一格），一共 5232 字节。好处是**不必记账** ——
地址是号算出来的，两条性质自动成立；坏处是用到 `strerror` 的模块 data 段多 5K。

那块地方与 errno 那一格同一个形状：**前端**在 data 段里留、开跑前一条
`__omni_strerror_init(addr, bytes)` 交过去。大小也交，是为了让宿主能**当场核对**
—— 两处各写一个数，写错了要立刻骂而不是悄悄写出界：

```js
const need = (BigInt(ERRSTR.length) + 1n) * STRERR_SLOT;
if (BigInt(a[1]) < need) throw new Error(`libc: strerror 那块地方不够（…）`);
```

一个字节 data 都不写：那些串由宿主在**第一次调用时**写进去，而线性内存出生全是 0。

### `perror` 的两条边角

- 前缀是空指针**或空串**时只写那句话，连 `: ` 都不写。
- 那句话取的是**当时**的 `errno`（`errno = 0` 时是 `Undefined error: 0`，不是不写）。

两条都量出来的。它走的是第九片那扇 stderr 的门（直写，不带缓冲）。

### 量出来的数

- `tests/c/gen/39-strerror.c`：退出码 17 + 326 字节 stdout + 75 字节 stderr，
  与 `tcc -run` 逐字节相同。量的是：`strerror(0)`、我们 `<errno.h>` 里那几个号、
  表的最后一格（107）与表外（108、-1、500、501）、最长那句的长度（46）、
  一号一格的三条（同号同址、异号异址、先拿到的串不被改）、表外共用一格、
  `strerror(errno)`、`perror` 的三种前缀。
- `tests/c/run.js`：**67 passed, 0 failed**。`tests/run.js`：96 passed。
  `tests/js-roundtrip/run.js`：110 passed。
- 边界钉子仍是 7 条。

### 下一片

第八刀第十四片：**`scanf` 一族**（`sscanf` 先，`scanf`/`fscanf` 跟上）。
它是 `cFormat` 的反向：一个格式串驱动的**扫描器**，`%d`/`%s`/`%c`/`%x`/`%f` 与
宽度、`*`（跳过）、空白的规则（C11 7.21.6.2 那一长条）。回的是**成功赋值的个数**，
而 `EOF` 与 0 是两回事 —— 那几条边角同样要从 oracle 上量。
`strtol` 那台扫描器（第二片）可以直接给整数那几个转换用。

之后仍是原来的顺序：`gen-bad/duff`、`struct-byval`、真的 macOS 系统头。

<!-- 第八刀第十三片-END -->

## 落地：第八刀第十四片

**`sscanf` / `vsscanf` / `fscanf`。**

`cScan` 是 `cFormat` 的反向：一个格式串驱动的扫描器。三条腿共用它 —— 输入是一个串
（`sscanf`）还是一条流（`fscanf`）只差「那个串从哪儿来、用掉的怎么退回去」。

### 回 0 还是回 EOF

这一片最值钱的一条量：

```
sscanf("",    "%d", &a)  →  -1     输入先没了
sscanf("abc", "%d", &a)  →   0     匹配失败
sscanf("  ",  "%d", &a)  →  -1     全是空白，跳完就没了
```

C11 7.21.6.2 第 16 段：**一次转换都没做成就撞到输入的末尾**回 `EOF`，别的情况回
成功赋值的个数。所以 `cScan` 回的是 `{n, eof, used}` 两件事分开 ——
`while (sscanf(…) == 1)` 那种循环两种都能收，`if (sscanf(…) != EOF)` 就不行。

### 量出来的另外几条边角

- **`%n` 不算进返回值**：`sscanf("42abc", "%d%n", &a, &n)` 回 **1**，`n` 是 2。
- **`%c` 不跳空白**，`%s` 与数字那几个跳：`sscanf(" x", "%c", &c)` 拿到的是空格，
  `sscanf(" x", " %c", &c)` 才拿到 `x`。
- **格式串里的空白吃任意多个，含零个**：`sscanf("12", "  %d", &a)` 成功。
- **`%f` 存的是 float，`%lf` 才是 double**。搞反了 `printf("%.3f")` 会差在第七位上。
- `%i` 的进制由前缀定（与 `strtol(…, 0)` 同一套）；`%x` 认 `0x` 前缀，
  而且只在后面**真的跟着一个十六进制数字**时才算前缀。
- `%2d%2d` 对 `"1234"` 是 12 与 34 —— 宽度是**字符数**的上限，不是数值的。

### `fscanf` 与那份快照

文件在我们这儿是一整份快照（第十片），所以「从当前位置到末尾」这一段本身就是一个串。
扫完把游标推过 `cScan` 回的 `used`（**真的用掉的字节数**）—— 效果与真的 libc
「一个字符一个字符读、多读的那个 `ungetc` 回去」相同，而我们不必有 `ungetc`。

`scanf`（stdin 上那条）**还没有**：宿主那侧还没有一条同步读 stdin 的路。撞上 stdin 的
`fscanf` 会当场骂。

### 还没到的转换

`%[…]`（扫描集）、`%p`、十六进制的浮点字面量 —— 都在 `cScan` 的末尾一条
`throw` 上，写在 `stdio.h` 的自述里。**悄悄少赋一个值是最难查的那种错**，
所以这儿宁可当场停。

### 量出来的数

- `tests/c/gen/40-sscanf.c`：退出码 35 + 390 字节 stdout，与 `tcc -run` 逐字节相同。
  35 条：上面每一条边角各一条，加 `%hd`/`%lld`、`"%d-%d-%d"` 那种带字面量的、
  `vsscanf` 绕一层、以及 `fscanf` 在一份真文件上连读三次（第三次撞到末尾回 EOF）。
- `tests/c/run.js`：**68 passed, 0 failed**。`tests/run.js`：96 passed。
  `tests/js-roundtrip/run.js`：110 passed。
- 边界钉子仍是 7 条。

### 下一片

第八刀第十五片：**`gen-bad/duff`** —— `case` 标签长在里层的控制结构里
（Duff's device）。它是控制流上最后一个洞，也是这一刀里唯一还钉着的**语言**边界
（别的钉子要么是真语法错，要么等后端）。tinycc 自己的源码里没有 Duff's device，
但 `switch` 里套 `if` 再放 `case` 这种写法有 —— 现在的实现只认「`case` 直接长在
`switch` 的复合语句里」。

之后：`struct-byval`（外部函数按值收 struct，等真的后端）、真的 macOS 系统头
（要 `#include_next`、`__asm("_name")`、`__attribute__`）、`-dM`。

<!-- 第八刀第十四片-END -->

## 落地：第八刀第十五片

**Duff's device —— `case` 标签长在里层的控制结构里。**

这一格从第二十五片起就钉着（`gen-bad/duff.c`）。原来的形状是「一个 case = 一层
`BLOCK`，一个标签关掉一层」，而它要求 case 是 switch 函数体的**直接子语句**：

```c
switch (count % 8) {
case 0: do { *to++ = *from++;
case 7:      *to++ = *from++;   /* ← 这个 case 长在 do 的循环体里 */
```

### 换法：里层的 case 就是一个没有名字的标签

第二十四片已经有一台**函数级的状态机**（一个状态槽 + 一圈 `LOOP` + 一条分派链），
`goto` 就是「写状态、回到 LOOP 的开头」，而每种语句都会「被重新进入」。
里层的 case 需要的正是这件事，所以这一片没有新机器，只有一次**接线**：

1. **第一遍**（`caseLabel`）：里层的 case 领一个标签编号（与 `L:` 同一个计数器）。
   于是外面每一层「里面有标签」的语句自动变得可以被重新进入 —— `while`/`for` 跳过头、
   `if` 直接进对的那一半、复合语句一台分派，全是现成的。
2. **第二遍**：到了那个 case 处就是 `arriveLabel(id)`（把状态清零），与 `L:` 一个字不差。
3. **分派**（`openSegs`）：里层的 case 没有自己的段界，给它一层**蹦床** ——
   跳到蹦床 = 「写状态、`BR` 回函数那圈 LOOP」，此后与一条 `goto` 走的是同一条路。

```
BLOCK t0            ← 第一个里层 case
 BLOCK t1
   分派（要么送到段界，要么送到某层蹦床）
 END t1  → state = id1; BR gotoloop
END t0   → state = id0; BR gotoloop
```

蹦床开在 `entry` 里面，所以段界的层数要 +T（那几条区间判断在开蹦床之前就发完了，
不受影响）。

「是不是直接子语句」怎么问：新加一个 `blockDepth`（`block()` 的层数），
直接子语句的深度是「switch 函数体的深度 + 1」。所以 `switch(x){ { case 1: … } }`
里那个 case 也算「里层」—— 多一层花括号就走蹦床，慢一点，但是对的。

### 第一遍的区域要平

第一遍发出去的指令是扔掉的，可**区域栈要平**：那一遍仍然按老形状开了 k 层 `case`
`BLOCK`，而里层的 case 不再关掉自己那一层。所以 `switchStmt` 在第一遍结束时把剩下的
`nested` 层一起关掉。第二遍不欠 —— 那儿走的是合流那一路，根本没开这些层。

### 量出来的数

- `tests/c/gen/41-duff.c`：退出码 16 + 251 字节 stdout，与 `tcc -run` 逐字节相同。
  四种形状：教科书上那个 `count % 8` 的拷贝（1/7/8/9/17 五种长度逐字节比）、
  case 长在 `if` 的两半里、case 长在 `while` 的循环体里**并且**与一条真的语句标签
  加 `goto` 混在一起、以及最小的那个 `do { } while (0)`。
- `tests/c/run.js`：**68 passed, 0 failed**。`tests/run.js`：96 passed。
  `tests/js-roundtrip/run.js`：110 passed。
- 边界钉子 7 -> **6** 条（`duff` 从 `gen-bad/` 挪进了 `gen/`）。
  剩下的六条里只有 `struct-byval` 是「还没到」，别的五条都是真错误。

### 下一片

第八刀第十六片：**真的 macOS 系统头**。到现在为止 `#include <stdio.h>` 拿到的是
`src/include/` 里我们自己那份最小子集；要编 tinycc 自己的源码就得能读
`/usr/include`（准确地说是 SDK 里那份），而那需要三样东西：`#include_next`、
`__asm("_name")`（符号改名）、以及一整套 `__attribute__` 的**吃掉**（不必实现语义，
但要能读过去）。它是「编 tinycc 自己的源码」这条路上最大的一块。

之后：`struct-byval`（等真的后端）、`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）。

<!-- 第八刀第十五片-END -->

## 落地：第八刀第十六片

**真的 macOS 系统头。**`-I <SDK>/usr/include`，两条腿读**同一份** `/usr/include`。

写在第十五片末尾的预判是「要 `#include_next` + `__asm("_name")` + 一整套
`__attribute__`」。量下来只对了一半：`__attribute__` 与 `__asm` 改名确实是拦路的
（第十六片的前半，见 tcctok.js 里新加的那些拼法与 `skipAttrs`/`skipAsmName`），
而 `#include_next` 一次都没用上 —— macOS 那套头文件不靠它。真正没料到的是另外两件事。

### 一：预定义的宏本来就是两份

`tcc -dM -E` 量到的那 51 条**只是一半**。tccdefs.h 里有一道

```c
#ifndef __TCC_PP__      /* 只预处理时整段跳过 */
    struct __uint128__ { char x[16]; } __attribute((__aligned__(16)));
    #define __uint128_t struct __uint128__
    #define __builtin_offsetof(type, field) ((__SIZE_TYPE__)&((type*)0)->field)
    …
#endif
```

而 `__TCC_PP__` 恰恰**只在 `-E` 那一路上定义**。也就是说：拿 `-dM -E` 当 oracle 量预
定义，量到的永远是「只预处理」那一份；编译那一路要的那一半（内建 + `__uint128_t`）
在那份输出里根本不出现。所以 tccdefs.js 从一张表变成三张：`PREDEFS`（两路共有）、
`PP_ONLY_DEFS`（`__TCC_PP__` 一条）、`COMPILE_DEFS`（编译那一路），加一份
`COMPILE_PREAMBLE`（真的声明）。

`__uint128_t` 不是个可选项：`#include <stdlib.h>` 一路会带到
`<mach/arm/_structs.h>`，那儿用它声明 NEON 的寄存器组 —— 不认它就编不了**任何**
一份用系统头的 C。tcc 的换法是「拿一个同宽同对齐的类型顶着」，我们照抄。

那份 preamble 是**主文件之前的一个独立单元**（`CGen.preamble`），不是拼在主文件
前面 —— 拼上去主文件的行号就全错了，而行号是与 tcc 对账的一部分。

### 二：没引用的声明不发桩

第一次编成功之后撞上的是自家的边界消息：`第六刀：外部函数返回 struct 还没到`。
源码里一个 struct 都没有 —— 是 `<stdlib.h>` 里的 `div()`。原来那条循环把**所有**
「声明过但这个单元里没有函数体」的名字都发一个转发桩，而自带的头文件里只有几十个
声明，SDK 那套是几百个，里面自然有 `div`/`imaxdiv`/`localeconv` 这种。

所以函数符号多了一位 `used`（调用、取地址、当地址常量用 —— 三处置位），
`unit()` 只给引用过的外部符号发桩。这一条与真的编译器一致（没引用的声明不产生任何
符号引用），而且顺手把 `heapUsed`/`errnoUsed`/`strerrorUsed` 那三问也变准了：
以前 `#include <stdlib.h>` 就算「用到堆」，现在得真的调 `malloc`。

### 三：`extern` 可以不知道自己多大

`extern char *sys_errlist[];`（`_stdio.h:473`）连着触发两条检查：先是
「array size missing」（不完整的 extern 数组现在允许，尺寸记 0），再是
`declareGlobal` 里那条「storage size isn't known」。后者放宽成**只拦非 extern** ——
`extern` 只是「别处有」，尺寸不必现在知道；真用起来仍然会被「用过但没定义」拦住。

### 量出来的数

- `tests/c/sys/01-sdk-headers.c`：退出码 26 + 35 字节 stdout，与 `tcc -run` 逐字节
  相同。它用的是 `malloc`/`free`/`strcpy`/`strlen`/`printf`/`sscanf`/`strerror`，
  头文件全部来自 SDK。测试轴新加一组 `sys/`（`tests/c/run.js`）：`-I` 只给我们这一条
  腿，tcc 自己就默认读那儿；`xcrun --show-sdk-path` 取不到就整组跳过。
- `tests/c/run.js`：**69 passed, 0 failed**。`tests/run.js`：96 passed。
- 边界钉子仍是 6 条。

少了什么（都记在 tccdefs.js 里）：`__attribute__((aligned))` 是**吃掉**而不是实现，
所以 `struct __uint128__` 的对齐是 1 而不是 16 —— 装着它的那些结构体尺寸会与 tcc
不同（一个都还没用到）；`stdout`/`stderr` 在 SDK 里是 `extern FILE *__stdoutp`，
那要「外部全局量」与 `FILE` 的真布局，所以 `sys/` 这一组还不碰流。

### 下一片

第八刀第十七片：**SDK 的 `stdout`**。`__stdoutp` 是一个外部的 `FILE *`，
`putc` 是个碰 `FILE` 内部字段的宏 —— 也就是说这一片要的是「宿主给的全局量」加
一份**布局兼容**的 `FILE`。它是「编 tinycc 自己的源码」路上下一块必过的：
tinycc 的每个 .c 都 `#include <stdio.h>` 并且真的往 stderr 写字。

之后：`struct-byval`（等真的后端）、`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）。

<!-- 第八刀第十六片-END -->

## 落地：第八刀第十七片

**SDK 的三条标准流 —— 宿主填的全局量。**

自带那份 `<stdio.h>` 里 `stdout` 是宏，展开成 `__omni_stdout()`（C 只要求它是
`FILE *` 类型的表达式）。SDK 那份不是：

```c
extern FILE *__stdinp, *__stdoutp, *__stderrp;
#define stdout __stdoutp
```

三个**外部全局量**。所以第十六片的第二条（没引用的声明不发桩）在这儿有个对偶：
引用了、但这个单元里没有定义的**全局量**，以前一律是「undefined symbol」。

### 换法：与 errno 那一格同一个形状，方向相反

`declareGlobal` 本来就给它留了 8 个字节（`FILE *`），所以这一片只加一条接线：
`unit()` 收尾时，名字在 `STREAM_GVARS`（三条流）里的就不算「没定义」，而是记下
`{地址, 第几条}`；入口处一条 `__omni_stream_init(地址, 序号)`，宿主把自己的句柄
写进那一格。

- 前端不知道句柄是几（`F_STDIN`/`F_STDOUT`/`F_STDERR` 在 `interp/libc.js` 里）；
- 宿主不知道版图（地址是交过去的）。

与 `errno` 那一格的差别只是方向：那一格是**宿主写、程序读写**，这一格是
**宿主写一次、程序只读**。`__omni_stdout()` 那条门照旧留着 —— 同一份 libc 于是
同时接得住两种头文件的写法，自带的那份一个字都不用改。

### 量出来的数

- `tests/c/sys/02-streams.c`：退出码 5 + 21 字节 stdout + 9 字节 stderr，
  与 `tcc -run` 逐字节相同（`fprintf(stdout,…)`、`fputs`、`fputc`、
  `fprintf(stderr,…)` 四条都走 SDK 的 `__stdoutp`/`__stderrp`）。
- `tests/c/run.js`：**70 passed, 0 failed**。
- 终端上两条流的**交错**与 tcc 相反（我们的 stdout 带缓冲、stderr 直写）——
  测试轴分开对账，这一条不进 oracle，与第九片一样。

少了什么：`stdin` 那一格也填了，但读它仍然会抛（我们的文件是整份快照，没有真的
fd 级 IO）；`getc`/`putc` 在 macOS 上是真的函数（宏那一套是 `__sgetc`/`__sputc`，
只有 `*_unlocked` 用），所以 `FILE` 的内部字段还是一次都没被碰过 ——
`FILE` 至今仍然是不透明的一个小整数。

### 下一片

第八刀第十八片：**tinycc 自己那份 `libtcc.c` 的头几百行**。到这一片为止「能读 SDK
的头」与「三条流」都有了，下一步该拿真的输入来量：把 tinycc 的一个 .c 交给我们，
看第一个拦路的是什么（预期是 `setjmp`/`longjmp`、`struct` 传值、以及
`static` 函数指针表里的那些 `__attribute__`）。

之后：`struct-byval`（等真的后端）、`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）。

<!-- 第八刀第十七片-END -->

## 落地：第八刀第十八片

**把 tinycc 自己的源码交给我们，看第一个拦路的是什么。**

第十七片末尾的预判是「预期是 `setjmp`/`longjmp`、`struct` 传值、`__attribute__`」。
量下来一个都不是 —— 拦路的六格全在**更前面**，而且每一格都是先在 macOS 的系统头里
撞到的（`node src/core/cli.js c-mir libtcc.c -I …`，一次一格往前推）：

1. **`-D 名字` 的宏体是 `1`，不是空**（`tcc_define_symbol`：`value = *eq ? eq+1 : "1"`）。
   `config.h` 第一行就是 `#if !(TCC_TARGET_I386 || … || TCC_TARGET_ARM64 || …)`，
   展开成空当场就是「bad preprocessor expression」。顺手把 `-D名字` / `-I目录`
   贴着写的形状也认了（tcc 两种都认）。
2. **`__has_include`**（`tccpp.c:1474-1483`）。`<Availability.h>` 一进门就用。
   实现是把 `parse_include` 拆成「读名字」+「摊成候选路径」两半，`#include` 与
   `__has_include` 共用后者 —— 找的顺序必须一个字不差。`defined(__has_include)`
   也要是真（它不是宏，但要装成有）。
3. **`#pragma pack`**（`<sys/fcntl.h>` 的 `struct log2phys`）。它改的是**布局**，
   所以必须真的实现：预处理器一个栈，struct 排成员时 `pack < align` 就按 pack 排。
   **有一条只有对着 tcc 才看得见**：`tcc -E` 下 `#pragma pack` 是**原样印回**、
   不解释的 —— tcc 的 `pragma_parse` 里「-E 就印回」那一支排在 `pack` **前面**
   （`tccpp.c:1688` vs `1696`）。所以我们也分两路：只预处理时印回，编译时解释；
   而认不出的 pragma 在编译那一路上是「警告一句、整行丢掉」，不是印回 ——
   印回的话那些记号会漏进语法分析器（第一次撞上的正是这个）。
4. **`_Static_assert`**（`<mach/message.h>` 拿它钉住 mach 消息的尺寸）。
   它顺手在考我们的 struct 布局：位域 + `pack(4)` 算错就当场炸。
5. **匿名 struct/union 成员**（C11 6.7.2.1 第 13 段）。tinycc 自己的 `SValue`
   （tcc.h:488）就是这么写的。换法：那个没有名字的成员按自己的对齐占一块，
   然后把它的字段**带着偏移摊进外层的字段表** —— 于是 `s.jtrue` 一个特例都不用写。
   有 tag 的 `struct S { … };` 长在里面则只是声明一个 tag，不产生成员。
6. **常量表达式里的 `?:`**（`<sys/_types/_fd_def.h>` 算 `fd_set` 的维度）与
   **顶层多余的分号**（`<os/object.h>` 那些宏在非 Objective-C 下展开成空，
   `OS_WORKGROUP_SUBCLASS_DECL_PROTO(…);` 整行只剩一个分号）。

外加一条**真的类型规则**：赋值比的是「**去掉最外层限定符**之后相容」
（C11 6.5.16.1），不是全等。`<math.h>` 里 `const struct __float2 __stret = f();`
两侧只差一个 `const`，`sameType` 会把对的代码判成错的 —— 新的 `sameTypeUnqual`。

### 量出来的数

- `tests/c/gen/42-c11.c`：退出码 13 + 30 字节 stdout，与 `tcc -run` 逐字节相同。
  六格全在里面，而且 `_Static_assert` 把三个 `sizeof`（7 / 12 / 12）钉住了 ——
  那是 pack 与不 pack 的差别，tcc 认这三个数。
- `tests/c/cpp/08-has-include.c`：与 `tcc -E -P` 逐字节相同（5 行）。
- `tests/c/run.js`：**72 passed, 0 failed**。`tests/run.js`：96 passed。
- 边界钉子 6 -> **6** 条：`cpp-bad/has-include` 拆了（实现了），
  换上 `cpp-bad/has-include-next`（那一格要给每份打开的文件记住它是在第几个 `-I`
  里找到的；macOS 那套头文件一次都没用到它）。

### 下一片

第八刀第十九片：**`__asm__` 出现在声明的中间**。现在 `libtcc.c` 停在
`<dispatch/data.h>:45`（`unexpected keyword '__asm__' in expression`）——
Apple 的 `API_AVAILABLE(...)` 一族在「编译器什么都没有」的分支上会展开出
`__asm__(…)`，而我们只在**声明符之后**认它（`skipAsmName`）。这一格连着两件事：
`__asm__` 能出现在哪些位置，以及我们的诊断行号比 tcc 晚一行（`#if` 那条也一样，
tcc 的 `pp_error` 还会把整行记号印出来 —— 那是对账时最好用的一条线索）。

之后：`struct-byval`（等真的后端）、`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）。

<!-- 第八刀第十八片-END -->

## 落地：第八刀第十九片

**诊断逐字节对齐，与 `__asm__` 当一条语句。**

第十八片末尾把这一片写成「`__asm__` 出现在声明的中间」。量下来**不是** —— 整份
预处理过的 `libtcc.c` 里，不是「声明符后面改名」的 `__asm__` **只有一处**：

```
dispatch/once.h:115  __asm__ __volatile__ ( "" : : : "memory" )
```

也就是 `dispatch_compiler_barrier()`（`dispatch/base.h:195`）。它在一个 `static inline`
函数**体**里，是一条**语句**，不是声明的一部分。第十八片那句预判之所以偏了，正是因为
当时的行号是错的 —— 它报的是 `<dispatch/data.h>:45`，那儿是一段注释。

于是这一片的两件事其实是**同一件事的两头**：诊断不准，下一格就找不到。

### 一、报错报在哪一行

tcc 只有一行（`libtcc.c:669`）：

```c
line = f->line_num - ((tok_flags & TOK_FLAG_BOL) && !macro_ptr);
```

`lineNum` 记的是「读到哪儿了」，而换行是**读完上一行**才数的：当前记号正好落在行首时
`lineNum` 已经跨过去了，要减回来一行。宏流里读记号不动 `lineNum`，所以在宏里不减。
我们从第六刀起一直晚一行，全是缺这条减法（`Cpp.errLine`）。

第二件更要紧的，是**收起来再放一遍**那几路（函数体、`for` 的步进式、`switch` 的体 ——
文件头偏离 2 换来的代价）。放的时候文件早就读到那一段的末尾了，于是重放期间报的每一个
错都指向末尾。tcc 里有现成的答案，两处：

- `tok_str_add_tok`（`tccpp.c:1142`）记一个记号之前，**行号变了就先塞一条
  `TOK_LINENUM`** 进记号串；`next()` 从宏流里读到它就把 `file.lineNum` 拨过去
  （`tccpp.c:3478`）。我们的 `TokStr.addTok` 与 `captureTokens`/`captureBraced` 照此。
- `begin_macro` / `end_macro` **存下并还原 `file->line_num`**（`save_line_num`）。
  少了这一半，一段重放结束之后行号会停在那一段的末行，后面整片文件跟着偏。

### 二、`#if` 出错要印记号流

tcc 的 `error1` 里有一支很容易漏掉（`libtcc.c:677`）：

```c
if (pp_expr > 1)
    pp_error(&cs);            /* 不用原来那句话 */
```

`pp_expr` 在求值那一段里是 `#if` / `#elif` 本身，于是**求值期间出的任何错**都换成
`pp_error` 的转印：`bad preprocessor expression: #if` 后面跟**整条展开后的记号流**。
理由很实在 —— 那一行源码长得完全不像展开后的样子（`TargetConditionals.h:140` 的
`#if !defined(__has_extension) || !__has_extension(...)` 展开成 `! 0 || ! 0 ( 0 )`），
错在哪儿只有看记号流才知道。tcc 宁可丢掉具体错因也要印这一串。

顺带 `skip()` 也补齐了：tcc 印的是 `'x' expected (got 'y')`（`tccpp.c:100`），
**看见的那个记号**才是有用的一半。

### 三、`__asm__` 当一条语句

自带汇编器还没到（第九到十一步），所以这一格只认一种形状：**模板是空串、没有操作数**
—— 编译屏障。它说的是「别把内存访问搬过这一行」，而我们既不重排也不把内存缓进寄存器
（每次访问都是一条 LOAD/STORE），所以**一条指令都不发**就是它的正确实现，不是近似。
macOS SDK 里这一条有三个名字（`dispatch_compiler_barrier`、`os_compiler_barrier`、
`<sys/cdefs.h>` 的 `__compiler_barrier`），glibc 里也到处是。

位置两处，与 tcc 一样：语句（`tccgen.c:7465`）与顶层（`asm_global_instr`，
`tccgen.c:8774`）。三段冒号的进入条件照抄 `tccasm.c:1352-1380`——「下一个不是 `:`」
才算这一段有东西，于是 `__asm__("" :)` 在 tcc 那儿也是一条错（它会去读操作数、撞上
`)`，报 `string constant expected`），我们也报同一句。模板非空或真有操作数的，
报边界。`;` 与 tcc 一样**只检查、不吃掉**（`tccasm.c:1420` 的注释）。

### 量出来的数

- 新的一组 `tests/c/diag/`：**诊断本身**与 `tcc -c` 逐字节相同（同一个文件名、
  同一个行号、同一句话）。三份，三条都对上了：
  - `01-if-expr.c:8: error: bad preprocessor expression: #if ! 0 || ! 0 ( 0 )`
  - `02-semi-decl.c:4: error: ';' expected (got 'int')`
  - `03-semi-body.c:12: error: ';' expected (got 'return')` —— 这一条在**函数体里**，
    钉的正是 `TOK_LINENUM` 那条线；没有它这儿会报到第 15 行。
  这一组同样**没有 .expected** —— 期望值就是 tcc 那一行。
- `tests/c/gen/43-asm.c`：退出码 23 + 10 字节 stdout，与 `tcc -run` 逐字节相同。
  三种拼法、`__volatile__` 的有无、三段冒号、顶层那一条都在里面。
- `tests/c/run.js`：**77 passed, 0 failed**。`tests/run.js`：96 passed。
- 边界钉子 6 -> **7** 条：加 `gen-bad/asm-tmpl`（模板非空）。
- `libtcc.c` 现在**读完了所有系统头**，停在 tcc 自己的 `tcc.h` 上：
  `tccgen.c:515: error: macro 'ELF32_ST_BIND' used with too many args`。

### 下一片

第八刀第二十片：**`ELFW` 那一格**。`tcc.h` 里

```c
#define ELFW(sym) ELF##32##_##sym      /* PTR_SIZE == 4 */
#define ELFW(sym) ELF##64##_##sym      /* PTR_SIZE == 8 */
```

我们选到了 32 位那一支（于是 `ELFW(ST_BIND)(...)` 展开成
`ELF32_ST_BIND(...)` 而 elf.h 里那个宏只收一个参数）。也就是说我们对 `tcc.h` 里
`PTR_SIZE` 那一串 `#if` 的求值与 tcc 不同 —— 是一条**真的分岔**，得一层层二分到
第一个不一样的 `#if` 上。第十九片那组 `diag/` 正好是为这种活准备的工具。

之后：`struct-byval`（等真的后端）、`-dM`、`__has_include_next`、
路径 A 的 GLR 与路径 B 对账（第七步）。

<!-- 第八刀第十九片-END -->

## 落地：第八刀第二十片

**tinycc 自己那一整份源码编过了。**

```
node src/core/cli.js c-mir -I"$SDK/usr/include" -I.omni-cache/tcc-build \
  -I"$TCCSRC" -DONE_SOURCE=1 -DTCC_TARGET_ARM64 "$TCCSRC/tcc.c"
exit=0     98200 行 MIR，零错误零警告
```

`-DONE_SOURCE=1` 于是这一份里有 `tccpp.c`、`tccgen.c`、`tccdbg.c`、`tccasm.c`、
`tccelf.c`、`tccrun.c`、`arm64-gen.c`、`arm64-link.c`、`arm64-asm.c`、`tccmacho.c`，
加上 `libtcc.c` 与 `tcc.c` 自己 —— 也就是 ADR 顶上那句「终点是编完 tinycc 自己的
源码」的**前端那一半**。后端还没有（第 9-11 步），所以这是「读懂了」，不是「跑起来了」。

上一片预测的那条分岔（`ELFW` / `PTR_SIZE` 的 `#if` 求值不同）**是错的**。真相是
`readMacroArgs` 数实参时把空白也算进去了 —— 一个纯粹的记号层 bug，与 `#if` 无关。
预测错在「行号对不上」那件事已经修好之后还照着旧结论推。

### 一 空白不减那个计数

`tccpp.c:3286` 的循环：

```c
do { t = next_argstream(nested_list, NULL); }
while (t == ' ' || --i);
```

`||` **短路**：`t == ' '` 真的那一轮，`--i` 根本不执行。所以空白不减计数。`i` 从 2 起
（要吃掉 `(`），每收完一个实参重置成 1。我们原来写的是后自减、且没有短路，于是
`B (val)` 里 `(` 前面那个空格白吃掉一格，`A(zz)` 就被数成两个实参 ——
`macro 'ELF32_ST_BIND' used with too many args`。最小重现：

```c
#define B(val) [val]
#define A(val) B (val)
X A(zz) Y
```

### 二 `?:` 的两臂是 void

C11 6.5.15 第 5 段：两臂都是 void，结果是 void；只有一臂是 void 是错。
`tccgen.c:1804` 的 `c ? vdup() : gv_dup();` 走的正是第一种。我们原来一律去求
「共同的算术类型」，于是报 `cannot convert 'void' to 'long long'`。

### 三 `__func__` / `__FUNCTION__`

`tccgen.c:5656-5666`：tcc 把记号**换成**一个 `TOK_STR`、内容是 `funcname`，再落到
字符串那一支。于是它的类型是 `char[N+1]`、相邻字面量照样拼、`sizeof(__func__)` 是
名字长度加一。`__PRETTY_FUNCTION__` 不是记号 —— `include/tccdefs.h:151` 一条
`#define __PRETTY_FUNCTION__ __FUNCTION__`，我们那一条在 `tccdefs.js` 里本来就有。
函数外面 `funcname` 收回 `""`（`tccgen.c:8610`）。

### 四 行号记录不是记号

第十九片让 `tok_str_add_tok` 往收起来的记号串里插 `TOK_LINENUM`。代价在这一片
现出来：`sizeFromInit` 的 `initHeads` 是**生扫**记号数组、不走 `next()`，于是那些
行号记录被当成了「一项的头」——

```c
static const struct { int t; const char *n; } tab[] = {
  { 1, "a" },
  { 2, "b" },     /* 报 excess elements in array initializer */
};
```

一行一项的表全错。tcc 那边不会：它数长度也走 `next()`，而 `next()` 认得
`TOK_LINENUM`。生扫的地方只此一处，跳掉就好。

### 五 `sizeof` 的操作数总是一个 unary

`tccgen.c:5794`：`if (tok == '(') tok = TOK_SOTYPE;` —— 把那**一个**括号换成一个特殊
记号，然后照常 `expr_type(&type, unary)`。`unary` 里 `case TOK_SOTYPE` 认出类型名之后
`vpush(&type); return;`（`tccgen.c:5708`）—— **`return` 而不是 `break`**，于是不进后缀
循环，`sizeof(int)[0]` 是语法错而不是「int 数组的第 0 项」。

这一层不能省。`tccdbg.c:497` 是

```c
stab_section->sh_addralign = sizeof ((Stab_Sym*)0)->n_value;
```

**里层**那个 `(` 是真的强制转换，**外层**那个才是「可能的类型名」。我们原来在
`sizeofType` 里自己判「括号后面是不是类型名」，判的是里层，于是把
`sizeof((Stab_Sym*)0)` 读完就剩一个 `->` 在手上。换记号我们做不到（记号是数），
用一个一次性的标志代替，取下来就清掉 —— 效果一样。

顺带把常量表达式那一路的 `sizeof` 接到同一段代码上：`tccdbg.c:394` 的
`base_type_used[N_DEFAULT_DEBUG]`，而 `N_DEFAULT_DEBUG` 是
`sizeof(default_debug) / sizeof(default_debug[0])`。

### 六 转换的常量折叠，于是 `offsetof` 是常量

`offsetof(T, f)` 展开成 `((__SIZE_TYPE__)&((T*)0)->f)`（tccdefs.h 的
`__builtin_offsetof`）。tcc 那边它一点都不特殊：`(T*)0` 是个 `VT_CONST` 的 0，
`->f` 只是往上加一个偏移，于是它自然是常量。

我们的常量求值器是**另一台**机器（只认记号、不建值），所以补了两处：
`castTo` 在源是整数常量时当场算完（`gen_cast` 在 `VT_CONST` 上也是这样），
截断规则与 `ceCastTo` 同一套；`ceUnary` 的 `&` 那一格借表达式一路解析
（用完就丢的函数里，与 `sizeof` 同一手法），拿到的内存左值如果地址本身是常量，
「地址常量 + 静态偏移」就是这个常量表达式的值。地址不是常量（`&某个全局`）的
那一种还没到 —— 那要真的重定位。

`libtcc.c` 的 `options_W` / `options_f` 那几张表全靠这一格。

### 七 `inline` 的体等被引用才发

`tccgen.c:8873`：「static inline 函数只是一种宏。它的代码在编译单元末尾、
而且只在被用到时才发。」`decl` 里只 `skip_or_save_block` 收下记号串，
`gen_inline_functions`（`tccgen.c:8661`）循环到不再有新的为止 ——
一个被引用的 inline 体里可以调另一个 inline 函数。

这不是优化。macOS 的 `<math.h>` 里有一串 `__header_always_inline` 的定义，其中

```c
__header_always_inline void __sincosf(float __x, float *__sinp, float *__cosp) {
    const struct __float2 __stret = __sincosf_stret(__x);
    ...
}
```

`__sincosf_stret` 返回 struct，是个外部符号。体一进来就分析的话那个名字当场被标成
「引用过」，于是一份根本没用三角函数的程序会撞上「外部函数返回 struct 还没到」。
tcc 编得过，正是因为它连体都还没读。

一处偏离：一次都没被引用的 inline 函数，tcc 什么都不发；我们的 `MirFunc` 已经登记
在模块里、拿不掉，所以给它一条 `RET` 收口。谁都不会调到它，只是让模块自洽。

### 八 `__builtin_expect`

`tccgen.c:5811`：`parse_builtin_params(0, "ee"); vpop();` —— 两个操作数都求值，
只留左边那个。`tcctok.js` 的 builtin 那一段于是从四条变五条。

### 量出来的数

- `tcc.c`（整份 tinycc，arm64 + ONE_SOURCE）：**exit=0**，98200 行 MIR，
  零错误零警告。上一片停在 `tccgen.c:515`，这一片依次推过
  `tccgen.c:1804`（void 的 `?:`）、`tccgen.c:7604`（`__FUNCTION__`）、
  `tccdbg.c:48`（行号记录被当成项）、`tccdbg.c:394`（`sizeof 表达式`）、
  `tccdbg.c:497`（`TOK_SOTYPE`）、`libtcc.c:1709`（`offsetof`）、
  `__sincosf_stret`（inline 的体），最后只剩 `undefined symbol 'main'` ——
  而那是因为 `libtcc.c` 是个库。
- `tests/c/gen/44-tinycc.c`：退出码 24 + 与 `tcc -run` 逐字节相同的 stdout。
  上面八格里能在一份小程序里钉住的七格都在里面（`readMacroArgs` 那一格钉在
  `tests/c/cpp/` 已有的宏展开组里）。
- `tests/c/run.js`：**78 passed, 0 failed**。`tests/run.js`：96 passed。
- 边界钉子仍是 7 条。`externThunk` 的那句「外部函数返回 struct」现在**带上名字**——
  这一片查 `__sincosf_stret` 花掉的时间全在这一句上。

### 下一片

第八刀第二十一片：**`-E` 那一路也编完整份 tinycc**（预处理的输出与
`tcc -E` 逐字节比），然后把 `c-mir` 的输出真的喂给 verifier 与解释器 ——
98200 行 MIR「生成出来了」与「跑得动」是两件事，中间隔着
`struct` 按值传/返回（第 9-11 步的后端要它）。

之后：`-dM`、`__has_include_next`、路径 A 的 GLR 与路径 B 对账（第七步）。

<!-- 第八刀第二十片-END -->

## 落地：第八刀第二十一片

**整份 tinycc 的预处理输出与 `tcc -E -P` 逐字节相同。**

```
node src/core/cli.js cpp -I"$SDK/usr/include" -I.omni-cache/tcc-build \
  -I"$TCCSRC" -DONE_SOURCE=1 -DTCC_TARGET_ARM64 "$TCCSRC/tcc.c"
cmp 出来 IDENTICAL —— 27825 行
```

### 一 `#ifdef __has_include` 也是真

`tccpp.c:1850-1853` 与 `tccpp.c:1464-1466` 是**同一条**判断：

```c
if (define_find(tok) || tok == TOK___HAS_INCLUDE || tok == TOK___HAS_INCLUDE_NEXT)
```

前者在 `#ifdef` / `#ifndef` 上，后者在 `defined` 上。我们只补了后者（第十八片）。

一行之差，后果是整份系统头换了一套配置：macOS 的 `<sys/cdefs.h>` 里那句
`#ifndef __has_include` 对我们成立，于是它把 `__has_include` **`#define` 成一个恒回
0 的宏**。从那一刻起 SDK 里每一处 `__has_include(...)` 都答「没有」。

第一处看得见的后果隔了三层：`malloc/_malloc.h:35`

```c
#if __has_include(<sys/_types/_size_t.h>)
#include <sys/_types/_size_t.h>
#else
#define __need_size_t
#include <stddef.h>
#endif
```

我们走 `#else`，于是 `<stdlib.h>` 就把 `<stddef.h>` 拖进来了，`offsetof` 提前有了
定义，而 `tcc.h:107` 是

```c
#ifndef offsetof
#ifdef __clang__
#define offsetof(type, field) __builtin_offsetof(type, field)
#else
#define offsetof(type, field) ((size_t) &((type *)0)->field)
#endif
#endif
```

`#ifndef` 不成立，于是 tinycc 全篇的 `offsetof` 展开式与 tcc 不一样。找这一格是从
输出的第 7454 行倒着追到第 1 行的：**`-E` 逐字节比是唯一能把这种「配置分岔」逼出来的
工具** —— 编译那一路照样 exit=0，因为两种 `offsetof` 算出来的数是同一个。

顺带记一笔查法：`#ifdef X`（X 逐个换成 tcc.h 前 107 行 include 的那些头）在两条腿上
的真假表，一次就把范围缩到 `<stdlib.h>`；再往里两层缩到 `malloc/_malloc.h`。

### 二 自带的 `<stdarg.h>` 照 tcc 那份

输出第 2 行就不同：tcc 的 `include/stdarg.h:11` 有一条
`typedef va_list __gnuc_va_list;`（原注释：fix a buggy dependency on GCC in libio.h；
macOS 的 `<_stdio.h>` 也认这个名字）与 `#define _VA_LIST_DEFINED`，我们那份没有。

同一份文件里那四个 `va_*` 在 tcc 那边是**对象式**宏，不是函数式的
（`include/stdarg.h:5-8`）。差别在 `-E` 的输出上看得见：`va_start` 单独出现时
对象式那种会展开成 `__builtin_va_start`，函数式那种原样留下。照 tcc。

### 量出来的数

- 整份 tinycc（`tcc.c`，arm64 + ONE_SOURCE，27825 行输出）：`cpp` 的输出与
  `tcc -E -P` **逐字节相同**。改之前是 111 行 diff。
- 编译那一路照旧 exit=0（`c-mir`，98200 行 MIR）。
- `tests/c/cpp/08-has-include.c` 多了四格：`#ifdef` / `#ifndef` 认它、
  `__has_include_next` 也认、真的被 `#define` 掉之后 `#ifdef` 照样是真而调用走那个宏。
- `tests/c/run.js`：**78 passed, 0 failed**。

### 下一片

第八刀第二十二片：**把那 98200 行 MIR 喂给 verifier 与解释器**。
「生成出来了」与「跑得动」是两件事，中间隔着 struct 按值传/返回（`div`、
`__sincosf_stret` 那一类），而那要真的 ABI —— 也就是第 9-11 步的后端。
所以下一步大概是先把 verifier 过一遍、把「哪些指令我们发得出但跑不动」列成一张表。

之后：`-dM`、`__has_include_next`、路径 A 的 GLR 与路径 B 对账（第七步）。

<!-- 第八刀第二十一片-END -->

## 落地：第八刀第二十二片

**编出来的 tinycc 真的在预处理文件了**，而且输出与 tcc 自己逐字节相同：

```
node src/core/cli.js c-run "$TCCSRC/tcc.c" -I"$SDK/usr/include" \
  -I.omni-cache/tcc-build -I"$TCCSRC" -DONE_SOURCE=1 -DTCC_TARGET_ARM64 \
  -- -E -P .omni-cache/tiny.c
cmp 我们跑出来的与 tcc 跑出来的 —— IDENTICAL
```

也就是说这条链现在整条通了：**我们的 C 前端 -> MIR -> 我们的解释器 -> tinycc ->
预处理的输出**，而末端与 oracle 一致。

### 零 上一片那个预测错了：`c-mir` 本来就在 verify

上一片写「下一步先把 verifier 过一遍」。读了 `cli.js:155` 才发现 `c-mir` / `c-run`
走的那条路默认就跑 `verifyMir`（良构检查不是可选的调试开关，理由在
`mir/verify.js` 文件头）。所以那 98200 行 MIR 从第二十片起就是良构的 —— 该问的
不是「良不良构」而是「跑到哪一格停」。

### 一 `getenv`

第一格。tcc 的 `main` 一开头就读环境（`CPATH`、`C_INCLUDE_PATH`）。

回的地址必须**在线性内存里**且**同一个名字两次回同一个地址**（真的 libc 就是这样），
所以一个 `Map` 缓存 + 一次 `heapAlloc`。宿主那一侧走 `host/native.js` 的 `env()`，
不是直接 `process.env` —— 那一层是 ADR-0011 的边界。

### 二 fd 那一层：`open` / `read` / `write` / `lseek` / `close` / `unlink`

第二格。tinycc 读源文件走的是 `tcc_open` -> `open`/`read`，不是 stdio。

**与 `fopen` 共用同一张表、同一个计数器**：两边都是「打开时整份读进来、关的时候整份
落盘」的快照（第十片那处刻意的简化），所以没有第二套记账。标志位的数值从 macOS 的
`<sys/fcntl.h>` 量出来 —— 与 tcc 编同一份头时看到的是同一批数。

两格是量出来才对上的：

- `read` 回的是**字节数**，读到末尾回 0（不是 -1）。搞错的话读循环不停。
- fd 1/2 的 `write` **不过 stdio 的缓冲**。它是系统调用，与 `printf` 攒的那份缓冲
  互不相干，所以直接交给宿主而不是走 `streamWrite(F_STDOUT)`。走了的话
  「先 `printf` 再 `write(1, …)`」两句的先后与 tcc 相反：tcc 那边 `write` 先出来、
  `printf` 那份要等退出时才冲。`tests/c/sys/03-fd.c` 第一次跑就是被这一条判掉的。

顺带把 `remove` 补成真的删（`host/native.js` 新增 `removeFile`）—— 第十片那儿只是
把还开着的那份忘掉，盘上的文件还在。

### 三 dispatch 的信号量

第三格，三行。`tcc.h:1943` 的 `__APPLE__` 分支里 `TCCSem` 就是
`dispatch_semaphore_t`。解释器只有一条线，所以互斥是白给的：`create` 回一个非 0 的
句柄，`wait`/`signal` 回 0。

### 四 `setjmp` / `longjmp` —— 这一片真的那一格

第四格，也是唯一一格不是「补一条 libc」的。tinycc 的错误恢复就是它：
`libtcc.c` 的 `_tcc_error` 里 `longjmp(s1->error_jmp_buf, 1)`，落点是
`tcc_compile` 的 `if (setjmp(…) == 0)`。

`setjmp` 要**返回两次**，而 `interp/libc.js` 那张表里的函数只认实参、不认帧。
能做的理由是这个解释器的形状：一帧一个 `while (pc …) pc = prog[pc](F)`，于是
「回到某一帧的某条指令之后」是可表达的（`mir/interp.js`）。

- `setjmp(buf)` 记下**调用它的那一帧**与那一帧的**那条 CALL**，回 0。
- `longjmp(buf, v)` 抛一个 `LongJmp`。中间那些帧靠宿主的异常自然退掉。
- 目标帧的 pc 循环 catch 住，`F.v[pc] = v; pc = pc + 1` —— 等于「那次调用回了 v」。

三处是踩过才知道的：

1. **落点不能取抛出那一刻的 pc**。第一版这么写，结果 `longjmp` 落在了「主函数当时
   正在执行的那条 CALL」上（也就是调 `outer()` 那条），而不是当初调 `setjmp` 的那条。
   所以要在 `setjmp` 的时候把落点记下来。
2. **要记的是 `F.up`，不是 `F`**。外部符号是经桩函数（`externThunk`）调的，
   `setjmp` 那条 CCALL 在桩自己的帧里，那一帧一返回就没了。
3. **`depth` 与 `cur` 要在 catch 里收回**。中间那些帧的复原被异常跳过了。

键取 `jmp_buf` 的**地址**而不是往那块地方写一个号：真的 `setjmp` 往里存寄存器，
没人读它的内容；按地址记还顺带对上了「同一个 buf 上后一次 `setjmp` 盖掉前一次」。

代价只落在用 setjmp 的模块上：`usesSetjmp` 是装载期一次判断（`mir.cabi` 里有没有
那几个名字），没有的话每帧连一个 `try` 都不多付、每条 CALL 也不多写一次 `F.pc`。

已经返回的帧上 `longjmp` 是 C 的未定义行为（C11 7.13.2.1）。不装作能做：那个异常
一路飘到 `runMirModule`，在那儿变成一条明说的运行期错误。

### 量出来的数

- 编出来的 tinycc `-E -P` 一份小文件：与 `tcc -E -P` **IDENTICAL**，exit=0。
- `tests/c/cpp/` 那八份用例全部**交给编出来的 tinycc** 跑一遍，与本机 tcc 的
  `-E -P` 比：**7 份逐字节相同**。不同的那一份是 `07-predef.c`，差的全是
  **目标配置**那几条（`__APPLE__`、`__arm64__`、`__GNUC__`、`long long` 对 `long`、
  `wchar_t` 的符号）—— 我们喂的是 `-DTCC_TARGET_ARM64`（arm64 Linux），
  本机那个二进制是 arm64 macOS。同一份源码、两套配置，这一格是对的。
- 错误那一路也对：`#error boom here` 两边都是
  `.omni-cache/bad.c:2: error: #error boom here` + exit=1 —— 这一条走的正是
  编出来的 tinycc 自己的 `longjmp`。
- 跑一趟（编 tcc.c 到 MIR + 解释执行它去预处理一个文件）1.7s。
- `tests/c/sys/03-fd.c`：exit 64 + 150B stdout + 8B stderr == `tcc -run`。
- `tests/c/sys/04-setjmp.c`：exit 9 + 126B stdout == `tcc -run`。
- `tests/c/run.js`：**80 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。

### 下一片

第八刀第二十三片：**把配置也换成 macOS**（`-DTCC_TARGET_MACHO`），于是上面那
一份 `07-predef.c` 也该逐字节相同。量出来的第一格已经在那儿等着：

```
tccmacho.c:2142: error: internal: 位域跨过了它的容器（要 packed 那条按字节读的路）
```

`struct dyld_chained_ptr_64_rebase` 是 `uint64_t target:36, high8:8, …` —— 一个
**64 位的容器**，我们那条路目前只走到 32 位。

再往后是让它走到**编译**那一路（`-c` / `tcc -run`）而不只是 `-E`：那要 `mmap`/`mprotect`
（`tccrun.c`）与 `struct` 按值传/返回（第 9-11 步的后端要它）。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）。

<!-- 第八刀第二十二片-END -->

## 落地：第八刀第二十三片

**编出来的 tinycc 在预处理 tinycc 自己那一整份源码了**，而且逐字节相同：

```
node src/core/cli.js c-run "$TCCSRC/tcc.c" -I"$SDK/usr/include" \
  -I.omni-cache/tcc-build -I"$TCCSRC" -DONE_SOURCE=1 \
  -- -E -P -B.omni-cache/tcc-build -I.omni-cache/tcc-build -I"$TCCSRC" \
     -DONE_SOURCE=1 "$TCCSRC/tcc.c"
29009 行，与本机 tcc 的同一条命令 cmp —— IDENTICAL
```

这一条是**自指**的：我们的 C 前端把 tinycc 编成 MIR，MIR 在我们的解释器上跑，
那份 tinycc 再去读它自己的源码 —— 答案与本机那个二进制一个字节不差。

它自报的身份也从上一片的 `(AArch64 Linux)` 变成了 `(AArch64 Darwin)`：这一片起
配置与本机那个二进制**是同一套**。

### 一 别在命令行上告诉它目标

上一片喂的是 `-DTCC_TARGET_ARM64`，于是它是 arm64 **Linux**，`07-predef.c` 那一格
对不上（`__APPLE__`、`__arm64__`、`long long` 对 `long`、`wchar_t` 的符号）。

原因在 `config.h`（configure 生成的那份）：

```c
#if !(TCC_TARGET_I386 || TCC_TARGET_X86_64 || … || TCC_TARGET_ARM64 || …)
#define TCC_TARGET_ARM64 1
#define TCC_TARGET_MACHO 1
#define CONFIG_TCC_SYSINCLUDEPATHS "{B}/include:…/MacOSX.sdk/usr/include"
#endif
```

命令行上一定义 `TCC_TARGET_ARM64`，这**一整块**就被跳过 —— 目标是 arm64 了，但
Mach-O 没了、系统头的搜索路径也没了（这正是它找不到 `stdlib.h` 的原因）。
把那个 `-D` 去掉，让 `config.h` 自己说，一次就全对了。

一句话：**别替被编的程序回答它自己的配置问题**。

### 二 位域的访问类型（`adjust_bf`）

换成 Mach-O 之后第一格就在 `tccmacho.c:2142`：

```c
struct dyld_chained_ptr_64_rebase { uint64_t target:36, high8:8, reserved:7, …; };
rebase->high8 = cur >> (64 - 8);
```

我们报的是「位域跨过了它的容器」。这不是布局错了 —— 布局与 tcc 逐字相同，包括
PCC 那句「装得下的 `long long` 位域按 `int` 算」（`tccgen.c:4280`）。`high8` 排在
第 36 位而类型已经是 4 字节的 `int`，**36 + 8 越过 32**，按声明的类型确实读不出来。

缺的是 tcc 布局之后那一遍收尾（`tccgen.c:4365-4436`）：**给这些位域挑一个别的
访问类型**。`high8` 这一格挑出来是「偏移 4、位置 4、按 2 字节访问」。
那个 `for(;;)` 是在找一个不动点：按当前对齐算容器起点 `cx`，据此算需要几个字节、
挑一个类型，那个类型的对齐又会改变 `cx` —— 直到 `cx` 不再变。

访问类型挂在**成员记录**上、由类型的 `ref` 指过去（`f->type.ref = f`，
`tccgen.c:4372`）：标量类型的 `ref` 本来空着，于是它和位域信息一样跟着类型走，
传递过程中不会掉。声明的类型**不动** —— 符号性还得按它算。

### 三 值的容器宽度跟着**访问**类型，不是声明的类型

这一格是量出来的。第一版写完，`struct { unsigned long long a:20, b:20, c:20, d:4; }`
的 `b` 读出来是 `345ab` 而不是 `12345`。

`b` 的声明类型被布局改成了 4 字节的 `int`，而访问类型挑出来是 8 字节（位置 20、
20 + 20 = 40 越过 32，但落在 64 里）。移位的宽度按哪个算？`tccgen.c:1859-1868`
把这两件事分在了 `adjust_bf` 的**两侧**：

```c
type.t = vtop->type.t & VT_UNSIGNED;      /* 之前：符号性按声明的类型 */
r = adjust_bf(vtop, bit_pos, bit_size);   /* 这一句把基类型换成访问类型 */
if ((vtop->type.t & VT_BTYPE) == VT_LLONG) type.t |= VT_LLONG; else type.t |= VT_INT;
```

也就是**符号性看声明的、宽度看访问的**。按声明的 32 位去移，`b` 那 20 位有 8 位
被移出去了 —— 而 `345ab` 与 `12345` 只差这么多。

### 量出来的数

- 编出来的 tinycc 预处理**整份 tinycc**（`tcc.c` + ONE_SOURCE，29009 行输出）：
  与本机 tcc 的同一条命令 **IDENTICAL**，18.0s。这一条是自指的：我们的 C 前端编出
  tinycc，那份 tinycc 再去读它自己的源码，答案与本机那个二进制一个字节不差。
- 单独一份 `tccasm.c`（6553 行）：同样 **IDENTICAL**，7.7s。
- `tests/c/cpp/` 那八份用例全部交给编出来的 tinycc：**8/8 逐字节相同**
  （上一片是 7/8，差的那一份就是配置）。
- `tests/c/gen/45-bitfield-access.c`：exit 241 + 106B stdout == `tcc -run`。
- `tests/c/run.js`：**81 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。

### 下一片

第八刀第二十四片：让编出来的 tinycc 走到**编译**那一路（`-c` / `tcc -run`）。
`-E` 只用到预处理器；`-c` 会把 `tccgen.c`、arm64 的代码生成、`tccmacho.c` 的写出
全拉进来，于是它要的东西也另一批：`mmap`/`mprotect`（`tccrun.c`）、
写文件那一路（已经有了）、以及 `struct` 按值传/返回（第 9-11 步的后端要它）。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）。

<!-- 第八刀第二十三片-END -->

## 落地：第八刀第二十四片

**编出来的 tinycc 在产可执行文件了**，而且与本机 tcc 产的**逐字节相同**：

```
node src/core/cli.js c-run "$TCCSRC/tcc.c" … -DONE_SOURCE=1 \
  -- -B.omni-cache/tcc-build -o .omni-cache/ours/a.out .omni-cache/tiny.c
.omni-cache/ours/a.out            # 真的跑起来，退出码 3（f(2) = 3）
cmp 我们产的与本机 tcc 产的 —— IDENTICAL（36112 字节，0755，已签名）
```

也就是说这一路整条通了：**预处理 -> 语法分析 -> arm64 代码生成 -> Mach-O 写出 ->
codesign**，全在我们的解释器上跑，产物与 oracle 一个字节不差。`-c` 那一档同样
（976 字节的 `.o`，IDENTICAL）。

### 一 `open` 的第三个实参是**变参**

第一版把 `a[2]` 当成权限用了，结果产物的权限是 `--w-r-x---`：SDK 里
`int open(const char *, int, ...)` 是变参函数，所以桩函数交过来的 `a[2]` 是
**变参区的地址**，不是那个数。从那儿按 `int` 读一格才是 0777。

这一格错了的表现很有意思：**链接成功、文件正确，但跑不起来**（0644，没有执行位）。
落盘那一侧也要跟着改 —— `writeBinary` 多收一个 `mode`，只在新建那一刻生效、
照旧过 umask（本机 022，于是 0777 落成 0755，与 tcc 一样）。

### 二 `fdopen` 几乎是空操作

tinycc 写产物走 `open` + `fdopen`（`tcc_output_file`）。fd 与 `FILE*`
在我们这儿**本来就是同一张表**（第二十二片那个决定），所以 `fdopen` 只按 mode
把几个标志对齐、句柄原样回去 —— 之后的 `fclose` 关的就是同一格，与真的一样。

### 三 `system` 回的是 `wait(2)` 那套编码

arm64 的 macOS 上没签名的可执行文件跑不起来，所以 tinycc 写完 Mach-O 之后会
`system("codesign -f -s - <文件>")`（`tccmacho.c:2243`）。宿主那一侧走
`host/native.js` 的 `spawn`。

两格要注意：

- 回的**不是**退出码，是 `wait(2)` 的编码（高 8 位是退出码）：tinycc 拿
  `WIFEXITED`/`WEXITSTATUS` 读它。回成裸的退出码，成功也会被判成失败。
- **不能冲 stdout**。第一版顺手冲了一次，想让先后好看；但真的 `system` 不管调用方的
  stdio 缓冲（POSIX 只说「像创建了一个子进程」）。于是 tcc 那边子进程的输出先出来、
  调用方攒着的等退出才出去 —— 冲了反而与 oracle 对不上。

### 四 `errno` 有第三个名字

`__error`。macOS 的 `<errno.h>` 把 `errno` 定义成 `(*__error())`，glibc 那边是
`__errno_location()` —— 用**真的系统头**的程序（编出来的 tinycc 正是）走的是这条，
而不是我们自带那份 `<errno.h>` 的 `__omni_errno_location`。三个名字回**同一格**，
于是 `open` 失败时 libc 写下的号，tinycc 那边读得到。

### 五 `dlopen` 回 NULL 是真话

`tccmacho.c:2270` 拿 `libxcselect.dylib` 问「当前的 SDK 在哪儿」。解释器里没有
动态装载器（线性内存里放不下一个宿主的 dylib，宿主函数的地址在这套指针上也没有意义），
所以一律回 NULL —— 而 tinycc 那边正好按「问不到」写的：退到写死的两条 SDK 路径，
那条路径与 configure 量出来的正是同一个。

`-run` 那一路另说：它要**执行生成出来的机器码**，那在 MIR 解释器上根本不成立
（第 9-11 步的后端才有这一格）。撞上去是一条明确的错误，不是一个错答案。

### 量出来的数

- `-c`：976 字节的 `.o`，与本机 tcc **IDENTICAL**。
- 链接成可执行文件：36112 字节、0755、已签名，与本机 tcc **IDENTICAL**，跑起来
  退出码也对。带 `printf` 的那份（要连 libSystem）同样 IDENTICAL，输出正确。
- 比对产物时**输出文件名要一样**：ad-hoc 签名把标识符（取自文件名）嵌在签名块里，
  名字不同则签名块不同。第一次比是 `tiny.exe` 对 `tiny-tcc.exe`，差的 8 个字节
  全在那儿 —— 不是代码生成的差别。
- `tests/c/sys/05-fdopen.c`：exit 33 + 109B stdout == `tcc -run`。
- `tests/c/run.js`：**82 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。

### 下一片

第八刀第二十五片：让编出来的 tinycc 编**它自己**（`tcc.c` -> 一个能跑的 `tcc`），
也就是把这条链再套一层。第一格已经量出来了 —— `__error` 就是那一趟撞出来的。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第二十四片-END -->

## 落地：第八刀第二十五片

**自举到不动点了。** 编出来的 tinycc 编**它自己**，产出的 `tcc2` 与本机 tcc 编同一份
源码产出的逐字节相同；拿那份 `tcc2` 再编一遍自己，产物与它自己**又**逐字节相同：

```
node src/core/cli.js c-run "$TCCSRC/tcc.c" … -DONE_SOURCE=1 \
  -- -B.omni-cache/tcc-build -o .omni-cache/ours/tcc2 … "$TCCSRC/tcc.c"
cmp ours/tcc2 theirs/tcc2                  # IDENTICAL，590272 字节，1m17s
.omni-cache/ours/tcc2 -v                   # tcc version 0.9.28rc (AArch64 Darwin)
.omni-cache/ours/tcc2 -o stage3/tcc2 … tcc.c && cmp ours/tcc2 stage3/tcc2
                                           # FIXED-POINT IDENTICAL，0.165s
```

这一格值得说清楚它证明了什么。链条是：**我们的 C 前端**读 tinycc 的源码，把它编成
MIR，在**我们的解释器**上跑；跑起来的那个 tinycc 读它自己的源码，走它自己的预处理、
语法分析、arm64 代码生成、Mach-O 写出、`codesign`，落出一个**原生**可执行文件。那个
文件与本机 tcc 落出的一个字节不差 —— 也就是说我们对 tinycc 这五万行的**行为**复现，
在这条路径上没有一处偏差；有偏差的话，产物里必然看得见（第二十三片就是这么抓出位域
那一格的）。第三段更强一点：`ours/tcc2` 自己再编一遍自己得到同一个文件，说明它不只是
"这一次的输入恰好对"，而是**这个编译器本身**是那个不动点。

### 一 最后一格是 `strtod`

自举那一趟撞出来的边界只剩浮点的读入。`tccpp.c` 的 `parse_number` 把浮点字面量交给
`strtod`/`strtold`/`strtof`（`tccpp.c:1962`），于是 tinycc 编自己的源码时，源码里每
一个 `1e6`、每一个 `0x1p-52` 都从这儿过。

`scanReal` 照 C 标准那三条分支写：

- 空白 + 符号；
- `inf` / `infinity` / `nan` / `nan(字符序列)`；
- **十六进制浮点** `0x1.8p3` —— 尾数按 16 进制攒成整数，再 `mant * 2**(exp - 4*小数位)`。
  分两步是为了精度：先攒成一个精确的整数、再一次二的幂缩放，只有最后那一步舍入；
- 其余交给 `Number()`。JS 的十进制串转 double 与 C 的 `strtod` 是同一套
  round-to-nearest-even，所以这一格不需要自己写。

`strtof` 在结果上再 `Math.fround`；`strtold` 与 `strtod` 同一格 —— 这个目标上
`long double == double`（`src/include/float.h` 头上那节写了量出来的数）。

`atof` 是 `strtod(s, NULL)`，不是另写一份。

### 二 `endptr` 是"停在哪儿"，不是"对不对"

`1e` 这种：C 说 `strtod` 认下 `1`、`endptr` 停在 `e`。写成"看见 `e` 就吃指数"会把
`1e` 读成错误或者 `10`。`scanReal` 里指数那一段是**试着吃**：符号加至少一位数字都齐了
才认，否则回退到 `e` 之前。同一条规则也管十六进制那份 —— 只是那儿的 `p` 是必需的
（没有 `p` 就不是十六进制浮点，退回按 `0` 加 `x…` 读）。

### 量出来的数

- 编出来的 tinycc 编 **`tcc.c` + ONE_SOURCE**（五万行）：产物 590272 字节，与本机
  tcc 的同一条命令 **IDENTICAL**，1m17s。
- 那份 `tcc2` 编它自己：**FIXED-POINT IDENTICAL**，0.165s（原生，所以快了 470 倍）。
- `tcc2 -v` / `tcc2 -run hello.c a b`：与本机 tcc 一样 —— 输出相同、退出码 7 相同。
  JIT 那一路在**它**身上是通的（我们的解释器上不通，那是第 9-11 步的事）。
- `tests/c/gen/46-strtod.c`：exit 42 + 567B stdout == `tcc -run`（20 组 `strtod`，
  含 `5e-324`、`1e`、十六进制浮点、inf/nan，再加 strtof/strtold/atof）。
- `tests/c/run.js`：**83 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。

### 下一片

第八刀第二十六片：把 tinycc 自己那套测试拿来当尺子 —— `tests/tcctest.c` 那一大份，
让**编出来的 tinycc** 去编它、再与本机 tcc 编的产物/输出比。自举只证明了"编 tcc.c
这条路径"没有偏差，`tcctest.c` 是专门为了踩边角写的，覆盖面不一样。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第二十五片-END -->

## 落地：第八刀第二十六片

**换一把尺子量。** 自举只证明了「编 `tcc.c` 这条路径」没有偏差；tinycc 自己那份
`tests/tcctest.c`（4520 行，专门为踩边角写的）覆盖的是另一批代码。让编出来的
tinycc 去编它：

```
node src/core/cli.js c-run "$T/tcc.c" … -- -w -I$T/tests -I$B -I$T \
  -o .omni-cache/t26/ours/tcctest1 "$T/tests/tcctest.c"
cmp ours/tcctest1 theirs/tcctest1        # IDENTICAL，206256 字节，1m11s
./tcctest1 > out.txt                     # 1011 行，与本机 tcc 编出来那份**逐行相同**
```

这一趟撞出两格：一格在解释器的 libc（`ldexp`），一格在**我们自己的 C 前端**
（块作用域的 tag）。

### 一 `ldexp`：分步缩放，不然次正规数没了

`tccpp.c:2367` 读十六进制浮点字面量时 `d = ldexpl(d, exp_val - frac_bits)`，
而 tcctest.c 里正好有 `0x0.88p-1022` 这种**次正规**的字面量。

一步到位的 `x * Math.pow(2, e)` 在两头都坏：`e < -1074` 时那个幂自己先变成 0，
于是本该是 4.8e-322 的答案成了 0。`ldexpReal` 分步走 —— 每次乘 2**-1022（这一步
在正规数里是精确的），只有最后一步可能落进次正规区，也就只舍入一次。

我们自己的 `strtod`（第二十四片）里那句 `mant * 2**(exp - 4*frac)` 是**同一个
错误**，只是当时的用例没走到次正规。一起改了，`tests/c/gen/46-strtod.c` 补上
`0x0.88p-1022` / `0x88p-1030` / `0x1p-1074` / `0x1p-1075` / `0x1p4000` 五格。

### 二 tag 与枚举常量是**分作用域**的 —— 而我们的函数体走两遍

`tcctest.c:331` 那行是 `static struct recursive_macro { int rm_field; } G;`，长在
函数体里。我们报了「redefinition of 'struct recursive_macro'」—— 而它只写了一遍。

原因是我们这边函数体要走**两遍**（`genFuncBody`：第一遍数帧、第二遍发指令），
而 tag 表原先只有一张、不分层：第一遍把成员填好，第二遍再看见这条定义就成了重复。
换句话说，这不是「少支持一个语法」，是**作用域这件事本来就没做**。

于是照 C11 6.2.1 第 7 段做：`tagStack` / `ecStack` 与 `scopes` 同步推弹
（只留 `pushScope` / `popScope` 一个入口，三张表不可能再走散），
定义（后面就是 `{`）只看当前那一层，引用从里往外找。副产品是遮蔽也对了 ——
外层一个 `struct S`、函数里再一个 `struct S {…}` 现在是两个类型，`sizeof` 各自算。

**枚举常量也在这一格里**：它们是普通标识符，块里的 `enum {E_IN = 5}` 出了块就没了，
而且与 tag 同理，第二遍会再登记一次。

第一版改完撞了一个更有意思的错 —— `gen/31-qsort.c` 报「'struct rec' is an
incomplete type」。`runBody` 把 `tagStack` 换成了函数体那一层，**回来时没收回去**，
于是函数**之后**那句文件作用域的 `struct rec { … };` 落进了上一个函数体的那一层，
下一个函数自然看不见它。作用域栈进出必须成对 —— 这条在两遍制下尤其容易漏。

### 量出来的数

- 编出来的 tinycc 编 `tests/tcctest.c`：产物 206256 字节，与本机 tcc **IDENTICAL**，
  1m11s；跑起来 1011 行输出与本机那份**逐行相同**，退出码 0。
- 自举那一条重量一遍（前端改过 tag 作用域，必须确认没动到产物）：
  `tcc.c` -> 590272 字节，仍然 **IDENTICAL**。
- `tests/c/gen/47-block-tags.c`（块里的 struct/union/enum、遮蔽外层同名 tag、
  嵌套再遮一层、静态且被取地址的）：与 `tcc -run` 一致。
- `tests/c/run.js`：**84 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。

### 下一片

第八刀第二十七片：**K&R 的函数定义**。我们自己的前端读 tcctest.c 现在停在 339 行 ——
`int op(a, b) { return a / b; }`，以及 `void old_style_f(a,b,c) int a, b; double c; {…}`
那种参数声明摆在括号后面的写法。tinycc 自己接受它（`#if __TINYC__` 那一段就是为它写的），
所以这是路径 B 的下一格。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第二十六片-END -->

## 落地：第八刀第二十七片

**K&R 的函数定义。** 形参表里只有名字，类型摆在 `)` 与 `{` 之间：

```c
f() { return 3; }                                    /* 省掉的 int */
int op(a, b) { return a / b; }                        /* 只有标识符表 */
void old_style_f(a,b,c) double c; int a, b; { … }     /* 加声明串，次序无关 */
void takes_float(x) float x; { … }                    /* float 形参**就是** double */
void takes_fn(cmpfn) int cmpfn(); { … }               /* 函数类型退化成指针 */
```

三段各自的位置：

- **省掉的 `int`**（`tccgen.c:8777-8781`）：文件作用域上一个光头的标识符开头就当
  `int`。只在文件作用域 —— 块里那样开头的是表达式语句，不是声明。
- **标识符表**（`tccgen.c:5077-5082`）：`(` 后面第一个记号是标识符而**不是**类型时，
  括号里读的就是名字，类型一律先当 `int`。这一位（`old`）跟着函数类型走。
- **声明串**（`tccgen.c:8897-8912`）：它不声明新东西，只给已经在表里的名字**定类型**。
  名字对不上是错、重复是错、带存储类是错，三句诊断与 tcc 逐字节相同。

### 一 老式形参里的 `float` 是 `double`

`tccgen.c:8867-8870` 特意把它改掉。理由在调用方那一侧：没有原型，实参走「默认实参
提升」，`float` 传出去的时候已经是 double 了。形参再按 float 收，就会把一个 double
的位模式当 float 读 —— 结果不是「精度差一点」，是完全的另一个数。

### 二 老式函数**不核对实参个数**

`gfunc_param_typed`（`tccgen.c:5352`）：`FUNC_OLD` 与变参的可变部分走同一条路，
只做默认提升，不比对。所以 `sum2(1, 2, 99)` 在 tcc 那儿是合法的，多的那个没人读。

我们这边多一层要注意：多出来的实参**不能塞进变参区** —— 被调方不是变参函数，
它的 MIR 签名里没有那一格。所以它们照旧求值（副作用还在），但不进实参表。

### 量出来的数

- `tests/c/gen/48-kr-funcs.c`（九种写法：省 int、标识符表、声明串一行一个 / 一行两个、
  float 提成 double、函数形参、数组形参、指针形参、多给实参）：与 `tcc -run` 一致。
- `tests/c/diag/04-kr-param.c`：`declaration for parameter 'c' but no such parameter`
  —— 与 tcc 同一句话、同一个行号。
- 自举那一条重量一遍（`decl` 与 `callArgs` 都动过）：`tcc.c` -> 590272 字节，
  仍然 **IDENTICAL**。
- `tests/c/run.js`：**86 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。

### 下一片

第八刀第二十八片：我们自己的前端读 tcctest.c 现在停在 359 行 ——
`char str_ag2[] = { "b" };`，也就是**用一对花括号裹着的字符串**初始化一个字符数组
（C11 6.7.9 第 14 段允许），以及紧跟着的 `char str_x[2] = { "xy" "z"[2], 0 };`
（字符串字面量下标当常量）。都在初始化式那一段。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第二十七片-END -->

## 落地：第八刀第二十八片

**花括号裹着的字符串，以及字符串字面量的下标。** 两件事挤在同一个位置上：

```c
char g1[] = { "ab" };              /* 铺进数组，大小是 3 —— 不是「1 个元素」 */
struct S g4 = { "r" };             /* 成员是数组，同一条规则 */
char x1[2] = { "ab" "c"[2], 0 };   /* 这个字面量只是一个更大表达式的开头 */
```

判「是哪一种」照 tcc（`tccgen.c:8086`）：把相邻的字面量**并完**之后看下一格，
是 `}` / `,` / `;` 才算「孤零零的一个字面量」，否则把并好的那个串塞回输入、
按表达式走。并的次序是硬的 —— `"xy" "z"[2]` 是 `"xyz"[2]`（`'z'`），
反过来会得到 `"z"[2]`（越界）。

塞回去这件事需要一个「带值的 unget」：`ungetTok` 只管记号号，值要另外补上
（tcc 那边也是 `unget_tok` 之后手写 `tokc.str`）。`ungetWith(t, val)` 就是这一格。

不定长数组要**先知道大小**，所以 `{ "abc" }` 在 `decl` 里也要认一次（`tryBracedStr`）：
数格子那一遍（`sizeFromInit`）会把这一整格数成 1 个元素，而正确答案是 strlen + 1。

### 一 静态初始化式里的 `"ab"[1]`：这一格我们**不照** tcc

量出来的数（`char c` / `short s` / `int n` / `long l` 都是 `= "abcde"[1]`）：

- tcc：`98` / `25442` / `1701077858` / `7595434461045744482`
- clang：`98` / `98` / `98` / `98`
- 我们：`98` / `98` / `98` / `98`

tcc 是**按目标类型的宽度**从字面量那块内存里整读（`1701077858` = `0x65646362` =
`"bcde"` 四个字节）。这是它的一个 bug：读的是 data 段里紧跟着的字节，所以「复现它」
等于连 data 段的排布一起复现 —— 那不是一条可移植的行为，而是一次越界读的结果。

这一格照 C 来（读一个字节，`char` 在这个目标上带符号，于是 `"\xff"[0]` 是 -1）。
运行期那一路 tcc 本来就读一个字节，与我们一致；而 tinycc 自己的 `tcctest.c` 里
那几处（`char a4[2] = { "ab" "c"[2], 0 };`）都在**函数体里**，走的正是运行期那一路
（文件作用域那两行在 `#ifdef CONSTANTINDEXEDSTRLIT` 里，tcc 不编）。
也就是说：oracle 能问到的地方我们全对得上，问不到的那一格我们比它对。

### 量出来的数

- `tests/c/gen/49-braced-str.c`（全局与局部各一套：`{ "…" }` 定长/不定长、
  struct 成员、`char *p = { "…" }`、相邻字面量并起来、下标、`"\xff"[0]`）：
  与 `tcc -run` 一致。
- 自举那一条重量一遍（初始化式那一段动过）：`tcc.c` -> 590272 字节，仍然 **IDENTICAL**。
- `tests/c/run.js`：**87 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。

### 下一片

第八刀第二十九片：**范围指定初始化器** `[0 ... 1] = 'a'`（GNU 扩展）。我们自己的前端
读 tcctest.c 现在停在 378 行 —— `struct str_SS ss = { { [0 ... 1] = 'a' }, 0 };`，
而 `sinit18[10] = { [2 ... 5] = 20, … }` 与 `cinit8[] = { [0 ... 1] = "BB", … }`
也是同一格。指定初始化器那套已经有了（第二十三片），这一片是给它加「一段范围」。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第二十八片-END -->

## 落地：第八刀第二十九片

**范围指定初始化器**（GNU 扩展）：

```c
int  sinit18[10] = { [2 ... 5] = 20, [8] = 9 };
char *cinit8[4]  = { [0 ... 1] = "BB", [2 ... 3] = "CC" };
struct str_SS ss = { { [0 ... 1] = 'a' }, 0 };      /* tcctest.c:378 */
```

`[a ... b] =` 就是「这一格的东西同时给 a 到 b 这几格」。语法上它是 `[` 里多一个
`TOK_DOTS`（`tccgen.c:7696-7699`），只许出现在**最后一个**指定符上 —— tcc 那边
是循环条件 `while (nb_elems == 1 && …)` 里的那一半，一旦看见范围就不再往里下降。

### 一 复制**字节**，而不是把初始化式再放一遍

我们手上有 `captureBraced` / `replayBraced` 那套「把记号收下来再走一遍」，套在这儿
最省事。但那是错的：

```c
int calls;
int f(void) { calls++; return 5; }
int a[4] = { [0 ... 3] = f() };     /* calls 是 1，不是 4 */
```

tcc 把初始化式**求一遍**，之后把栈顶那个值当成「一个 elem_size 大的 struct」反复
`init_putv` 出去（`tccgen.c:7768-7787`）—— 复制的是字节。放三遍记号会叫三次 `f`，
那是另一门语言。所以 `initRange` 复制字节：

- 自动那一侧：load + store，与 `structCopy` 同一手法（宽度是编译期常量，摊开就完了）。
  整块清零在前面已经做过，所以头一格没写到的字节是 0，一起复制过去正好。
- 静态那一侧：把刚追加进 `pendingData` 的那几条整体挪一格。

### 二 静态那一侧只能挪**落在这一格里**的字节

第一版把 `mark` 之后追加的 `pendingData` 全挪了，于是 `[0 ... 1] = "BB"` 把一个
无关的全局改成了 17220。原因是那一格的初始化式往 data 段写了**两处**：指针那 8 个
字节在数组里，字符串本身 `"BB\0"` 在别处 —— 而字符串那一块是**共享**的，跟着挪
就是往别人身上写。所以只挪 `[dest.addr+off, +size)` 里的那几条。

这条 bug 是「复制的是效果、不是内存范围」这个错误抽象的直接后果：那一格的初始化式
产出的字节并不都属于那一格。

### 三 越界与空范围：tcc 把三件事合成一句话

```
error: index exceeds array bounds or range is empty
```

负下标、上界越界、`[3 ... 1]` 这种空范围，tcc 都报这一句（`tccgen.c:7703-7704`）。
我们原来对 `[-1]` 报的是自己编的 `negative array designator`、越界靠 `excess elements`
兜着 —— 这一片一起改成 tcc 的那一句，四种写法逐字节相同。

### 量出来的数

- `tests/c/gen/50-init-range.c`（静态与自动各一套：标量、`char`、struct、指针、
  嵌套 `[1] = { [0 ... 2] = 5 }`、`static` 局部、`[0 ... 0]` 单格、
  以及 `f()` 只叫一次）：与 `tcc -run` 一致。
- `tests/c/diag/05-init-range.c`（空范围）：与 tcc 逐字节相同；`[5]` 越界、`[-1]`、
  `[1 ... 4]` 三种也当场量过，都是同一句话。
- `tests/c/run.js`：**89 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍（初始化式那一段又动过）：`tcc.c` -> 与本机 tcc 编的
  逐字节 **IDENTICAL**（1m22s）。
- 我们自己的前端读 tcctest.c 从 378 行走到了 **428 行**（`str_test` 那一整段过去了）。

### 下一片

第八刀第三十片：**宽字符常量与宽字符串** `L'a'` / `L"abc"`。我们自己的前端读 tcctest.c
现在停在 428 行 —— `printf("wc=%C 0x%lx %C\n", L'a', L'\x1234', L'c');`（`str_test`
那一段整个过去了）。这一片要的是：`L` 前缀的字符常量类型是 `wchar_t`（这个目标上是
`int`，四字节、带符号）、`L"…"` 是 `wchar_t[]`、相邻的宽窄字面量能并（`L"abc" "def"`），
以及 `u8`/`u`/`U` 那几个前缀该报什么。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第二十九片-END -->

## 落地：第八刀第三十片

**宽字符常量与宽字符串。** `wchar_t` 在这个目标上是 `int`（tcc 那边是 `nwchar_t`，
非 PE 目标上 `typedef int`），于是：

```c
L'a'                /* 类型是 int，值 97 */
L'\x1234'           /* 4660 —— 不截到一个字节 */
L'\xffffffff'       /* -1 —— 一格是带符号的 32 位 */
sizeof(L"ab")       /* 12 = (2+1) * 4 */
wchar_t s[] = L"ab" /* 铺进数组，3 格 */
```

### 一 一格装什么，是词法层面的一个开关

`parse_escape_string` 那一层带一个 `isLong`（tcc 同名参数）：窄的一格是一个字节、
宽的一格是一个 `wchar_t`。差别不止「宽度」：

- `\x` / 八进制 / `\n` 那些：宽的不截到 8 位。
- 源码里的非 ASCII：窄的按 **UTF-8 的字节**铺开、宽的是**一个码位一格**。
- `\u` / `\U`：反过来 —— 窄的要按 UTF-8 编码（tcc 的 `cstr_u8cat`），宽的直接就是那个值。
  这一片顺手把 `\u`/`\U` 补上了（原来两种都报「未知转义」），位数是硬的：
  `\u` 四位、`\U` 八位，少一位就是错，不是「有几位算几位」（那是 `\x` 的规则）。

宽串的值因此**不能**再用 JS 字符串装：码位可以超过 0xFFFF，塞进去会变成代理对、
格数就错了。TOK_LSTR 的 `tokc` 是一个数字数组。

### 二 `L'ab'` 的值是**最后**那个

窄的多字符常量是「左移八位再或」（`'ab'` = 24930），宽的那个循环是**直接赋值**
（`tccpp.c:2198-2203`），所以 `L'ab'` 是 `'b'`。这不是对称的，照抄。

顺带记一条量出来的差别：tcc 的「multi-character character constant」这条警告挂在
`warn_all` 上，不给 `-Wall` 它一个字都不印；我们是无条件印。这一格与这一片无关
（窄的那一路本来就这样），但它让 `L'ab'` 进不了 `gen/` 的用例 —— 那一组是拿
stderr 一起对账的。

### 三 「宽串铺进数组」与「宽串当指针」是两条路

`wchar_t s[] = L"ab"` 是铺；`char s[] = L"ab"` 不是 —— 元素类型不对就当成一个
`wchar_t *` 表达式（tcc 那个 if 的注释原话：*only parse strings here if correct
type, otherwise handle them as ((w)char *) expressions*）。所以窄的那一套路径全都
多了一条宽的岔路：`initializer` / `initScalar`（`wchar_t *p = L"ab"`）/ `decl` 的
不定长数组 / `tryBracedStr`（`{ L"ab" }`）/ 常量表达式里的下标（`L"abc"[1]`）。

宽窄混着拼（`L"abc" "def"`）tcc 认，但它是在**字节**层面接的（那个循环对两种记号
都 `cstr_cat`），于是窄的半截字节被当成 wchar 读。那是「按表示接、不按元素接」的
巧合，不是一条能解释的规则 —— 这一格明着报错，而 tinycc 自己的 `tcctest.c` 把这种
写法关在 `#if 0` 里，oracle 也问不到。

### 量出来的数

- `tests/c/gen/51-wide-str.c`（`L'a'`/`L'\x1234'`/`L'\xffffffff'`、`sizeof`、
  全局与局部的 `wchar_t s[]`、`int a[3] = L"pq"`、`wchar_t *p = L"zz"`、
  `{ L"cd" }`、相邻宽串拼接、常量下标、`\u00e9` 与源码里的 `é` 宽窄各一份）：
  与 `tcc -run` 一致。
- `tests/c/run.js`：**90 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍（词法层动过）：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 428 行走到了 **555 行**。

### 下一片

第八刀第三十一片：**标签当值**（GNU 扩展）。停在 tcctest.c:555 ——
`static void *label_table[3] = { &&label1, &&label2, &&label3 };`，配的是
`goto *ptr`（计算跳转）。这一格在 MIR 上不是「取一个地址」那么简单：MIR 是结构化
控制流，没有「跳到某个运行期算出来的地址」。所以它要先想清楚怎么表达 ——
一个函数内的标签表 + 一层 dispatch 循环，是目前看得见的走法。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第三十片-END -->

## 落地：第八刀第三十一片

**标签当值（`&&label`）与计算跳转（`goto *p`）**，GNU 扩展：

```c
static void *tab[3] = { &&a, &&b, &&c };
goto *tab[i];
```

这一片本来看着是最难的一格 —— MIR 是结构化控制流，没有「跳到一个运行期算出来的
地址」。结果它是最便宜的一格，因为**第二十四片已经把 goto 做成了状态机**：一个状态
槽（i32）、函数那一层一圈 `LOOP`、一条分派链。`goto name` 是「把那个标签的编号写进
状态槽，`BR` 回 LOOP 的开头」。

于是：

- `&&label` 的值就是**那个标签的编号**。它是编译期常量，所以
  `static void *tab[] = { &&a };` 直接成立 —— 不需要往 data 段里放一条指向代码的
  重定位（真的目标文件里那是最麻烦的一种）。
- `goto *p` 与 `goto name` 只差「编号是常量还是算出来的」：`gotoPtr` 把值收口成 i32
  写进状态槽，然后同一条 `BR`。

代价是这些「地址」不是真地址（是 1、2、3……），把它印出来或者与真指针比较就能看出
差别。C 那边只保证它能用于 `goto *`，所以这一格在标准的范围内是对的；而
`&&label` 之间的比较（相等/不等）照样对，因为编号是一一对应的。

第一遍（`labelStmt` 那一遍）还在给标签编号，前向引用的那些还没有号 —— 那时候
`labelValue` 回 0，反正第一遍发出来的指令是丢掉的。

### 一 顺手一格：typedef 名后面跟 `:` 是标签

```c
typedef int typedef_and_label;
…
typedef_and_label:            /* 标签 */
    …
struct { int bla; typedef_and_label : 32; } y;   /* 类型：一个没名字的位域 */
```

同一个名字，一个位置上是标签、另一个位置上是类型。tcc 的次序（`tccgen.c:7469`）是
**标签先判**：`if (tok == ':' && t >= TOK_UIDENT)`。我们原来在 `decl` 的入口只问
「这是不是类型的开头」，于是 `typedef_and_label:` 走进了声明那一路。改法是往前看一格
再把名字交回去 —— 与 `stmt` 里那个普通标签、`funcDecl` 的 `(void)` 同一手法。

### 量出来的数

- `tests/c/gen/52-label-value.c`（静态标签表、`goto *tab[i]`、`&&` 进三元表达式、
  跨函数各自一套编号、前向引用的 `&&done`、以及 typedef 名当标签/当类型各一次）：
  与 `tcc -run` 一致。
- `tests/c/run.js`：**91 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 555 行走到了 **661 行**（`goto_test` 整段过去了）。

### 下一片

第八刀第三十二片：**用 typedef 名当变量名**。停在 tcctest.c:661 ——
`mytype1 mytype2;`，也就是把一个 typedef 名重新声明成一个变量。typedef 名是普通
标识符（C11 6.2.3），在内层作用域里当然能被遮住；我们的声明符现在在那个位置上只认
「不是类型的标识符」，所以报了 `identifier expected`。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第三十一片-END -->

## 落地：第八刀第三十二片

**typedef 名是普通标识符。** tcctest.c 里那三行（655-662）：

```c
typedef int mytype2;
…
mytype1 mytype2;      /* 变量名正好是另一个 typedef 的名字 */
mytype2 = 2;          /* 于是这一行是表达式，不是声明 */
```

我们原来把 typedef 单独放在一张**平的**表里（`this.typedefs`），于是两件事都错了：
块里的 `typedef char T;` 出了块还在，而一个叫 `mytype2` 的变量遮不住同名的 typedef ——
`mytype2 = 2;` 被当成了声明的开头，报 `identifier expected`。

tcc 不会撞上这个，因为它的 typedef 与变量**本来就在同一张符号表里**：`VT_TYPEDEF`
只是那条符号上的一个位，`sym_find` 找到的是最内层那一条。C 的说法也是这个
（C11 6.2.3：typedef 名属于「普通标识符」那个名字空间）。

所以这一片把 typedef 表也做成一叠（`tdefStack`），与 `scopes` / `tagStack` / `ecStack`
同进同出，并且多一种值：`null` = 「这一层有个普通标识符占了这个名字」。
`declareLocal` 声明一个局部量时，如果这个名字现在解析成 typedef，就在当前层记一个
`null` —— 「遮住」于是与「定义」是同一套机制。

第二十六片那条教训在这儿又用了一次：函数体走两遍，所以这一叠也要在 `runBody` 里
换成函数体那一层、在 `finishFunc` 末尾收回文件作用域。三条栈现在是并排的三行 ——
下一次再加第四种作用域化的东西时，它们该合成一张表。

### 一 顺手一格：struct 成员表里的空成员

```c
struct empty_mem { /* nothing */ ; int x; };
```

成员表里一个孤零零的分号。tcc 的做法（`tccgen.c:4585-4592`）是「`parse_btype` 认不出
类型就 `skip(';')` 接着来」，顺带同一个岔路上还收 `_Static_assert` —— 于是那一段从
`decl` 里提成了 `staticAssert()`，两处共用。顶层多余的分号我们第二十片就收了，
struct 里这一格是同一件事的另一半。

### 量出来的数

- `tests/c/gen/53-typedef-shadow.c`（`mytype1 mytype2;` 那一格、形参遮 typedef、
  块里的 `typedef char shadow_me` 遮外层且出块即失效、局部变量遮 typedef、
  以及遮完之后外面那个名字还是类型；再加 struct 里的空成员与成员表里的
  `_Static_assert`）：与 `tcc -run` 一致。
- `tests/c/run.js`：**92 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 661 行走到了 **985 行**（`typedef_test`、`forward_test`、
  结构体那一大段全过去了）。

### 下一片

第八刀第三十三片：**长度 0 的数组**。停在 tcctest.c:985 ——
`struct aligntest4 { double a[0]; };`，GNU 的零长数组（`sizeof` 是 0，但对齐还是 8）。
我们的声明符现在见到 `[0]` 就报 `zero-sized array`。紧跟着的 989 行是
`struct __attribute__((aligned(16))) aligntest5`，也在同一段。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第三十二片-END -->

## 落地：第八刀第三十三片

**长度 0 的数组。** tcctest.c 那一段（985 起）：

```c
struct aligntest4 { double a[0]; };   /* sizeof 是 0，_Alignof 还是 8 */
```

我们原来在声明符里见到 `[0]` 就报 `zero-sized array`。tcc 的 `post_type`
（`tccgen.c` 里读 `[` 那一段）**根本没有这个检查** —— 它只在乎「有没有写数」，
写了 0 就是 0。零长数组是 GNU 的扩展，tcc 一声不响地收下：成员占 0 字节，
但元素类型的对齐照算，所以上面那个结构体是 **size 0 / align 8**。

去掉那个检查以后又冒出第二件事：`int gz[0];` 报 `storage size of 'gz' isn't known`。
`declareGlobal` 一直拿「size === 0」当「类型不完整」的替身 —— 在这之前这个替身是对的，
因为除了不完整类型没有别的东西 size 是 0。现在有了，所以得说真话：

```js
if (!isExtern) this.needComplete(name, ty);
if (!isExtern && isArray(ty.t) && ty.count < 0) this.err(`storage size of '${name}' isn't known`);
```

「不完整」交给 `needComplete`（它查的是 struct/union 有没有定义过），
「没写长度的数组」单独一条。这是同一类错误在这个仓里的第三次：**用一个可观测量
去替代另一个概念**，等到那个概念真的能取到那个值的时候就塌了（第十九片的
`ty.count < 0`、第二十九片的 pendingData 范围，也都是这个形状）。

零长数组还顺带把柔性数组那套写法喂通了：`struct hdr { int len; char data[0]; }` ——
`sizeof(struct hdr)` 是 4，`data` 的偏移也是 4，越过末尾去写就是调用者的事了。

### 量出来的数

- `tests/c/gen/54-zero-array.c`（`double a[0]` / `char b[0]` 收尾成员 / 全局 `int gz[0]` /
  零长结构体的数组 / 借 `struct hdr` 走一遍柔性数组）：与 `tcc -run` 一致。
  量到的：`sizes: 0 4 0 0 0`、`four=0 hdr=4`、`a=5 off=4`、`len=4 data=abcd off=4`。
- `tests/c/run.js`：**93 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 985 行走到了 **988 行**（对齐那一段的第一格）。

### 下一片

第八刀第三十四片：**`__attribute__((aligned(N)))` 与 `packed`**。停在 tcctest.c:988 ——
`struct __attribute__((aligned(16))) aligntest5 { int i; };`，紧跟着 993 行是尾置的
`struct aligntest6 { int i; } __attribute__((aligned(16)));`。我们的 `skipAttrs()`
现在把属性整段扔掉，所以这两个位置都得先认出来，再把对齐喂给 `structDecl` 的
`maxalign`（它已经认 `this.cpp.packStack` 了）。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第三十三片-END -->

## 落地：第八刀第三十四片

**`__attribute__((aligned(N)))` 与 `packed`。** tcctest.c 988 起那一段：

```c
struct __attribute__((aligned(16))) aligntest5 { int i; };   /* tag 之前 */
struct aligntest6 { int i; } __attribute__((aligned(16)));   /* `}` 之后 */
struct aligntest7 altest7[2] __attribute__((aligned(16)));   /* 挂在变量上 */
```

第十六片起 `skipAttrs()` 是「整块跳过」，因为那时**没有一个属性有可观察的效果**。
这一片起它不再是跳过：`aligned` 与 `packed` 改 struct 的布局，`sizeof` 与成员的 offset
跟着变，跳过就是给出错的答案。所以那一格换成了 `parseAttrs(ad)` —— 形状照
`parse_attribute`（`tccgen.c:3914`）：**成对的两层括号**、里面是**逗号分隔的表**、
末尾 `goto redo` 收连着写的第二个 `__attribute__`。认不出的名字落在最后一支，
有参数就把括号平衡掉（tcc 的 `skip_param`）。

### 一 边读边排排不了尾置的属性

真正的改动不在解析，在**顺序**。我们原来是边读成员边算 offset，而
`struct { … } __attribute__((packed));` 的 packed 长在所有成员**后面** —— 读到它的时候
前面那些成员的位置已经定死了。tcc 不会撞上这个，因为它天然是两段：`struct_decl` 只把
成员串成 `Sym` 链，`}` 与尾置属性都读完了才叫 `struct_layout(type, &ad)`
（`tccgen.c:4688`）。

于是 `structDecl` 拆成了两个：收成员的那一段（名字、类型、位域宽度、成员自己的属性
攒进一个数组）和 `structLayout`（那一整套 PCC 布局规则原封不动搬过去）。这不是为了
好看 —— 是「后面的记号能改前面的结果」这件事**逼**出来的分段。

### 二 三样东西抢同一个对齐

一个成员的对齐现在有三个来源，优先级照 tcc（`tccgen.c:4215-4235`）：

- `packed`（成员自己的，或者整个 struct 的）—— 按 1 排；
- `#pragma pack(N)`（第十八片）—— 比它小就按 N，而且在 PCC 模式下**连成员自己写的
  `aligned` 也一起抹掉**；
- 成员自己的 `aligned(N)` —— 直接就是 N，比自然对齐小也算（那是压紧）。

宽度 0 的位域整段跳过这三条：PCC 模式下 packing 不动它。位域那边还多一条 ——
成员写了 `aligned` 就换一个新的存储单元（`tccgen.c:4270`）。

而**整体**的对齐是 `max(ad.aligned, maxalign)`（`tccgen.c:4346`）：`aligned` 只抬不压，
压是 `packed` 的活。所以 `struct { char c; int i; } __attribute__((packed, aligned(4)))`
的成员紧排（`c` 在 0、`i` 在 1）而外壳按 4 —— size 8。

属性还能长在**说明符**那一段上（`__attribute__((aligned(8))) int i, j;`），那时它管这
一行的**所有**声明符 —— tcc 的 `parse_btype` 就是收进同一个 `ad`（`tccgen.c:4919`），
所以我们也给 `parseBtype` 加了一个可选的收集处，声明符那一份从它起头。

### 三 挂在变量上的那一份

`altest7[2] __attribute__((aligned(16)))` 抬的是**这一个符号**的地址，不是类型的对齐。
本来打算把它划成边界，但那会是一条**静悄悄给错答案**的边界：程序可以自己
`(unsigned long)&x & 15` 去看。所以顺手做了 —— 声明符那一路把属性收进 `dad`，
`declareGlobal` / `declareLocal` 多收一个 `align`，非 0 就用它对齐分配那一步
（局部量还得强制落到帧上：住在 MIR 槽里的量没有地址，也就没有对齐可言）。
类型上的对齐还是不带（`typedef unsigned long long __attribute__((aligned(4))) u64;`
那种降对齐的 typedef 仍然被忽略），下一格 `__alignof__` 会把这件事量出来。

### 量出来的数

- `tests/c/gen/55-attr-align.c`（tag 前 / `}` 后两个位置、`packed` 紧排后真的读写、
  `packed + aligned(4)` 同时写、成员自己的 `aligned(8)`、说明符段上的 `aligned(8)` 管
  一行两个成员、`aligned(2 * sizeof(long))` 这样的常量表达式、union、以及挂在全局量
  与局部量上的 `aligned`）：与 `tcc -run` 一致。量到的：`a5 16 16` / `p1 7: 0 1 5` /
  `p2 8 4: 0 1` / `m1 16: 0 8 12` / `m2 24: 0 8 16` / `sym 0 0 0`。
- `tests/c/run.js`：**94 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 988 行走到了 **1094 行**（对齐那一整段过去了）。

### 下一片

第八刀第三十五片：**`__alignof__`**。停在 tcctest.c:1094 ——
`printf("__alignof__ …", __alignof__(struct aligntest5), …)`。记号早就在表里
（`tcctok.h` 的四种拼法我们也有），只是 `unary` 里没有那一支：它和 `sizeof` 是同一个
形状（类型名或者表达式），回的是 `typeSize().align`。它同时是上面第三条那个「类型上的
对齐还不带」的量尺 —— 做完就知道 `aligned` 的 typedef 还差多少。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第三十四片-END -->

## 落地：第八刀第三十五片

**`__alignof__`。** tcctest.c 1093 起那二十来行把上一片做的每一格都问了一遍：

```c
printf("aligntest5 sizeof=%d alignof=%d\n", sizeof(struct aligntest5), __alignof__(struct aligntest5));
printf("altest7 sizeof=%d alignof=%d\n", sizeof(altest7), __alignof__(altest7));
```

解析这一格几乎是白送的：操作数的读法与 `sizeof` **完全一样**（`tccgen.c:5788` 那个
`case` 就是四个标号连在一起：`TOK_SIZEOF` 与三种 alignof 拼法），连「`(` 后面可能是
类型名」那个一次性标志都共用。差别只在最后取 `align` 还是 `size`。三种拼法
（`__alignof` / `__alignof__` / `_Alignof`）本来就在记号表里，只是没导出过。

真正要想清楚的是**第二行**：`__alignof__(altest7)` 是 16，而
`__alignof__(struct aligntest7)` 是 4 —— 同一个类型，问法不同答案不同。因为
`aligned` 挂在**符号**上（上一片第三条），类型里没有它。tcc 在这儿的做法是回头去看
刚压进去的那个 SValue 上挂的 `Sym`（`tccgen.c:5802`，注释里自己写着 hack）。

我们的 SValue 不挂符号，所以记的是「**最后一次引用到的符号**带的对齐」：
`entryLval` / `gvarLval` 各一行，`alignofExpr` 问之前先清零。同样只在紧接着问的时候
有意义 —— 这与 tcc 的 hack 是同一个精度，不多也不少。上一片顺手存下来的那个
`e.align` 到这儿才有了读者。

### 量出来的数

- `tests/c/gen/56-alignof.c`（基本类型与指针、struct/union、`aligned(16)` 的两种写法、
  `packed` 的 1、空 struct、数组类型、表达式当操作数、局部量、以及三个挂了 `aligned`
  的符号；再加 `_Alignof` 拼法与 `sizeof / _Alignof` 混算）：与 `tcc -run` 一致。
  量到的：`t 1 2 4 8` / `s2 16 16 1` / `arr 16 4` / `e 4 8 4` / `sym 16 16 8` / `c11 8 4`。
- `tests/c/run.js`：**95 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 1094 行走到了 **1304 行**（对齐与位域那一大段全过去了）。

### 下一片

第八刀第三十六片：**省掉中间那一项的 `?:`**（GNU 扩展）。停在 tcctest.c:1304 ——
`static int v1 = 34 ? : -1;`，以及紧接着的 `a - 30 ? : a * 2`。`x ? : y` 的意思是
「x 非 0 就是 x，否则 y」，而条件**只求值一次**。常量表达式那一路（`ceCond`）与
表达式那一路各有一处要认这个空位。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第三十五片-END -->

## 落地：第八刀第三十六片

**省掉中间那一项的 `? :`。** tcctest.c 1302 起：

```c
static int v1 = 34 ? : -1;                  /* 常量那一路 */
printf("%d %d\n", a - 30 ? : a * 2, a + 1 ? : a * 2);
```

`x ? : y` 是 GNU 的扩展，意思是「x 非 0 就是 x，否则 y」。语法上只是「中间那一项可以
是空的」，语义上多一条：**x 只求值一次**。所以 `f() ? : 99` 里 f 只调一次 —— 这条要是
漏了，编出来的程序照样跑，只是副作用多一遍，而那种错最难从输出上看出来。

我们的 `? :` 是「一个 IF 加两个槽」（i64 一个、f64 一个，见第六刀那一节），条件先算
成一个 ref。这一片就多一步：中间是空的时候，先把 x 落进一个临时槽，**条件与第一支
读的是同一格**。tcc 那边是 `vdup()` 复制 vtop —— 同一个意思，那个值已经在手上了，
别再算一遍。

常量表达式那一路（`ceCond`）反而没有这个问题：值已经算出来了，`a = c` 一行完事。

### 量出来的数

- `tests/c/gen/57-cond-omit.c`（静态初始化式里的三格、真/假两侧、`calls` 计数确认
  只求值一次、double / 指针 / unsigned、嵌套 `0 ? : 0 ? : 3`、整条当 `if` 的条件用）：
  与 `tcc -run` 一致。量到的：`34 -1 7` / `60 31` / `nz=5 calls=1` / `z=99 calls=1` /
  `p=null hi` / `nest=3` / `a=7 calls=2`。
- `tests/c/run.js`：**96 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 1304 行走到了 **1354 行**。

### 下一片

第八刀第三十七片：**`switch` 的体不是花括号**。停在 tcctest.c:1354 ——
tcctest.c 自己的注释就写着「Following is a switch without {} block intentionally.」：

```c
switch (j)
  case 1: break;
```

`switch` 后面跟的是**一条语句**（C11 6.8.4：`switch (expr) statement`），花括号只是
最常见的那一种。第六刀把它写成了「必须是复合语句」并钉了边界，现在这条边界要拆 ——
`case` 标签本来就是「语句上的标签」，与它长在哪一层无关。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第三十六片-END -->

## 落地：第八刀第三十七片

**`switch` 的体不是花括号。** tcctest.c 1352 那两行自带注释：

```c
/* Following is a switch without {} block intentionally.  */
switch (j)
  case 1: break;
```

C11 6.8.4 写的是 `switch (expr) statement` —— 花括号只是最常见的那一种语句。第六刀
把它实现成「必须是复合语句」并钉了一条边界（`switch 的函数体不是花括号还没到`），
这一片拆掉那条边界。

我们的 switch 是「先把体整块收成记号串，扫一遍收标签，再放一遍真的做」（那一整套的
理由见第六刀那一节：分派要在体之前发，而那时还不知道有几个标签）。所以这一片的做法是
**在收的时候替它补上一对花括号**：`captureStmtBraced` 见到 `{` 就走原来那条
`captureBraced`，否则收一条语句、外面裹一对花括号。下游（`scanCases` 与 `block`）
一个字都不用改 —— 这是「收完再放」这个结构第一次白送了一件事。

### 一 「一条语句到哪儿为止」只能按记号数

收的时候还没解析，所以边界得按记号定：配平括号，深度 0 上的 `;` 或者 `}` 收尾。
两种情形要接着收：

- 后面跟着 `else` —— `if (a) b; else c;` 是**一条**语句；
- 深度 0 上还有没配对的 `do` 而后面跟着 `while` —— `do b; while (c);`。

第二条上先写错了一次：判的是「这条语句的**第一个**记号是不是 `do`」，于是
`case 1: do { n++; } while (n < 3);` 在 `}` 处就收尾了，重放时报
`'while' expected (got '}')`。`do` 不一定在开头（前面可以有任意多层标签），
所以数的是**个数**而不是「开头是不是它」。里层 switch 那一路（`scanCases` 跳过嵌套的
switch）需要同一套规则，于是 `skipStmtToks` 是它在 tccgen 一侧的同一份。

### 量出来的数

- `tests/c/gen/58-switch-stmt.c`（tcctest 那一格、体真的会跑到、`default` 当那一条、
  一个都不匹配、体里带 `else` 与 `do/while`、里层 switch 的体也不是花括号、
  以及长在 `for` 里的一条）：与 `tcc -run` 一致。量到的：
  `a ok` / `b hit` / `c default` / `d ok` / `e then` / `n=3` / `f inner` / `n=13`。
- `tests/c/run.js`：**97 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 1354 行走到了 **1436 行**。

### 下一片

第八刀第三十八片：**语句表达式 `({ … })`**（GNU 扩展）。停在 tcctest.c:1436 ——

```c
(void)sizeof( ({ do { } while (0); 0; }) );
```

一整个复合语句当一个表达式用，值是**最后那条表达式语句**的值。这一片不小：它要能
出现在表达式的任何位置（包括 `sizeof` 里，那时还不能求值），而里头能声明局部量、
能有循环、能 `goto` 出去。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第三十七片-END -->

## 落地：第八刀第三十八片

**语句表达式 `({ … })`。** tcctest.c:1436 那一格：

```c
(void)sizeof( ({ do { } while (0); 0; }) );
```

一整个复合语句当表达式用，值是**最后那条直接长在里面的表达式语句**的值，一条都没有
就是 `void`。Linux 内核的 `max()`、`container_of()` 那一套全靠它。

这一片本来估计不小，落下来只有三十行 —— 因为复合语句照原样交给 `stmt` 那一支去解析，
声明、循环、嵌套的 switch、`sizeof` 里不求值全都是免费的。真正要加的只有「把值捞出来」：

- `unary` 的 `(` 那一格多一支：后面跟着 `{` 就是语句表达式（`tccgen.c:5715`）；
- `exprStmt` 多两行：栈顶那一帧记着「直接子语句在哪个深度」，深度对上就把值留下。
  最后一条留下的自然就是整条的值 —— tcc 的写法是 `vpop(); gexpr();`
  （`tccgen.c:7511`，先丢掉上一条的），同一个道理。

值能这么直接留下来，靠的是一条**已有的**性质：没有标签的复合语句**不开 MIR 的
block**（`stmt` 的 `LBRACE` 那一支，`d === null`）。里面发的指令就在外面这条指令流上，
所以最后那条表达式的 ref 出了花括号照样能用。

### 一 钉住的边界：里面带语句标签

反过来说，语句表达式里有语句标签的那一种**真的**会开一层 block（那是 goto 状态机的
段界，第二十四片），值就出不来了。这一格钉住报错，而不是给个错的答案：

```
error: 第六刀：语句表达式里带语句标签还没到（那时复合语句会开一层 MIR block，值就出不来）
```

tcc 收这种写法（它没有结构化控制流这层约束）。要做的话得把值改成「落进一个临时槽、
出了 block 再读」—— 与 `? :` 那两个槽是同一招，等真的撞上再做。

### 量出来的数

- `tests/c/gen/59-stmt-expr.c`（最简的一格、里面声明局部量、多条语句取最后一条、
  里面带 `for`、`MAX(a,b)` 那个宏且两个实参各求值一次、整条当语句用的 void、
  嵌套、浮点、指针、`sizeof(({…}))` 里 `f()` **一次都没调**、数组下标、
  里面带 `if/else`）：与 `tcc -run` 一致。量到的：`max=7 calls=2` / `so=4 calls=0` /
  `nest=5` / `ifel=104`。
- `tests/c/run.js`：**98 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 1436 行走到了 **1463 行**。

### 下一片

第八刀第三十九片：**试探性定义**（tentative definition，C11 6.9.2）。停在
tcctest.c:1462 —— 注释就写着「GCC accepts that」：

```c
static int tab_reinit[];        /* 先来一个没写长度的 */
static int tab_reinit[10];      /* 后面这一条把它补全 */
static int tentative_ar[];
static int tentative_ar[] = {1,2,3};
int cinit1; int cinit1;         /* 全局量可以定义好几遍 */
```

同一个名字的多条声明要**合并**成一条定义：数组的长度谁写了算谁的，初始化式只能有
一处。我们的 `declareGlobal` 现在见到「没写长度的数组」直接报
`storage size of 'x' isn't known`（第三十三片那一格），而这儿它得先等一等。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第三十八片-END -->

## 落地：第八刀第三十九片

**试探性定义**（tentative definition，C11 6.9.2）。同一个名字在文件作用域上声明好几遍
是合法的，多条声明**合并**成一条定义：

```c
static int tab_reinit[];        /* 先来一条没写长度的 */
static int tab_reinit[10];      /* 后面这一条把它补上 -> sizeof 是 40 */
static char first_sized[4];     /* 反过来也行 */
static char first_sized[];
int cinit1; int cinit1; int cinit1 = 0;
```

### 一 「没写长度」不是错，是**先不划地方**

第三十三片起 `declareGlobal` 见到不完整类型就报错，而这儿要它先等一等。分成两步：

- `int t[];` 在文件作用域上不带 `extern` 时，`decl` **留着** `count < 0`（`tccgen.js:5169`
  一带），不再当场补成 `[0]`；
- `declareGlobal` 登记一条 `addr: -1` 的登记，**不叫** `allocGlobal`。长度由后面那条
  同名声明补上时才划 data 段（`tccgen.js:1574`）。

一直没补上就是错，而那条错报在**用**它的地方 —— `gvarLval` 的 `unknown type size`。
这与 tcc 一致（`static int t[]; sizeof(t)` 在 tcc 那儿也是这句话、也是在用的那一行）。
「划地方」从声明那一步挪到「长度定下来」那一步，是这一片唯一的结构改动。

### 二 `sameType` 比数组时**不看长度** —— 于是合并的顺序反了

这一格卡了最久。第一版 `mergeTentative` 是这么写的：

```js
if (sameType(a, b)) return a;                       /* 完全一样 */
if (isArray(a.t) && isArray(b.t) && …) { … }        /* 长度谁写了算谁的 */
```

看着没问题，跑起来 `int t[]; int t[10]; sizeof(t)` 仍然报 `unknown type size`。打一行
调试出来的是 `mergeTentative` 回了 `count = -1` —— **第一条**就命中了：`sameType` 比数组
时只递归比元素类型，`count` 根本不参与（`ctype.js:267`）。那不是 bug，是它服务的场景
不同：赋值与形参那些地方要的正是「`int[]` 与 `int[10]` 相容」（C11 6.7.6.2）。

所以数组那一格必须**先**判：

```js
if (isArray(a.t) && isArray(b.t) && sameType(a, b)) {
  if (a.count === b.count || b.count < 0) return a;
  if (a.count < 0) return b;
  return null;               /* 两条都写了长度，而且不一样 */
}
if (sameType(a, b)) return a;
return null;
```

教训是一句可以带走的话：**一个「相等」谓词只在它被造出来的那个问题上是对的**。
`sameType` 回 true 不等于「这两个类型可以互相替换」，只等于「在赋值那一关它们相容」。
用它当合并的判据之前得先问一句「它把什么信息扔了」。

### 三 边界

两条都写了长度且不一样 -> 报错，措辞抄 tcc 的原话：

```
tests/c/diag/06-tentative-conflict.c:4: error: incompatible types for redefinition of 'a'
```

初始化式只能有一处（`int c = 1; int c = 2;`）那一格 tcc 报 `redefinition of 'c'`，
我们现在**不**报 —— 后一条会把 data 段里那几个字节盖掉。等撞上再做。

### 量出来的数

- `tests/c/gen/60-tentative.c`（没长度在前/在后、`{1,2,3}` 补长度、同名全局量三条
  其中一条带初始化式）：与 `tcc -run` 一致。量到的：`reinit 40` / `reinit v=7` /
  `ar 12: 1 2 3` / `cinit 0 5` / `first 4`。
- `tests/c/diag/06-tentative-conflict.c`：错误行号与措辞与 tcc **逐字节相同**。
- `tests/c/run.js`：**100 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 1463 行走到了 **1472 行**。

### 下一片

第八刀第四十片：**复合字面量**（compound literal，C11 6.5.2.5）。停在 tcctest.c:1472：

```c
int *cinit2 = (int []){3, 2, 1};
void *cinit52 = &(void*){ (void*) 52 };
int cinit4 = (int){44};
struct _c6 { int a,b; } cinit6 = (struct _c6){61,62}, *cinit7 = &(struct _c6){71,72};
```

`(类型){初始化式}` 是一个**有地址的对象**：文件作用域上它有静态存储期（于是要在 data 段
里划一块、按常量初始化），块作用域上它的生命期到那个块结束。语法上它与「强制转换」
只差 `(` 后面跟的是 `{` 还是表达式 —— 那一格要在 `unary` 里判。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第三十九片-END -->

## 落地：第八刀第四十片

**复合字面量 `(T){…}`**（C11 6.5.2.5）。它是一个**有地址的对象**，不是一个值：

```c
int *cinit2 = (int []){ 3, 2, 1 };          /* 文件作用域：静态存储期 */
struct P *cinit7 = &(struct P){ 71, 72 };   /* 取地址是合法的 */
int *p = (int []){ 7, 8, 9 };               /* 块里：这一层块的生命期 */
sum(&(struct P){ 31, 32 });                 /* 当实参传出去 */
m[0] = 100;                                 /* 它是左值，可以改 */
```

### 一 语法上它与强制转换只差一个记号

`unary` 的 `(` 那一格读完类型名、吃掉 `)` 之后，看下一个记号：是 `{` 就是复合字面量，
否则是强制转换。这一问必须摆在 `sizeof` 那一格**前面** —— `sizeof((int[]){1,2,3})`
是 12（那个对象的大小），走成「类型名」那一路会得到别的答案。

落地那一段与 `decl` 里声明一个带初始化式的变量**几乎一样**，只差「没有名字」：划地方、
跑一遍 `initializer`、把那块内存当左值交出去。所以不定长数组（`sizeFromInit`）、
`{ "abcd" }` 那种裹着字面量的（`tryBracedStr`）、没写满就补 0（`autoZero`）三条
全都是现成的 —— 这一片新写的只有 40 行 `compoundLiteral`。

存储期按写在哪儿分（第 5 段）：`this.scopes.length <= 1` 就是文件作用域，落 data 段；
否则划一块帧。我们的帧不回收，所以「出了这个块就没了」在我们这儿只体现为「没人再引用
它」；循环里那一格每一圈是同一块内存，C 也允许（同一个块里那个对象只有一个）。

### 二 常量一路上分成三种，而不是一种

静态初始化式走的是**另一台机器**（只认记号、回一个数），于是 `(T){…}` 在那儿要分：

- **标量**（`int cinit4 = (int){44};`）—— 根本不划地方。那个对象的地址谁都看不见，
  值就是花括号里那一项，`ceCastTo` 一下就完了。
- **聚合**（`int *cinit2 = (int []){3,2,1};`）—— 真的在 data 段里划一块铺好，
  值是它的地址（数组退化成指针正是这个数）。手法与 `&` 那一格一样：借表达式一路解析，
  拿到的左值地址本身就是常量。
- **同类型的对象**（`struct P cinit6 = (struct P){61,62};`）—— 这一格在 `initializer`
  里，而且**不划地方**：复合字面量初始化一个同类型的对象时，它与「直接写那对花括号」
  等价。少了这一条就得做整块拷贝，而静态那一侧的拷贝要么是一条重定位、要么得把刚写进
  data 的字节再读回来 —— 两样都比这一行贵。

三种分法的共同点：**只有地址被取到的那一种才需要真的存在**。

### 三 顺手补上的一格：孤零零的字面量是个地址常量

`uintptr_t cinit3 = (uintptr_t)"AA";`（tcctest.c:1473）。常量求值器里字符串那一格
原先只认带下标的写法（`"ab"[1]`，第二十八片），别的一律报错；现在下一个记号不是 `[`
就把串铺进 data 段、回那个地址。宽串同理。

### 量出来的数

- `tests/c/gen/61-compound-literal.c`（文件作用域上七条、块里九条：取地址、当实参、
  `.b` 直接取成员、指定初始化器、里面嵌一个、union、循环里那一格、`sizeof` 三种、
  改它）：与 `tcc -run` **逐行一致**。量到的：`d 0 2 0 5` / `n 51 52` / `loop 9` /
  `sz 12 8 5` / `lv 100 2`。
- `tests/c/run.js`：**101 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 1472 行走到了 **1474 行**。

### 下一片

第八刀第四十一片：**不定长数组配指定初始化器**。停在 tcctest.c:1474：

```c
char const * const cinit8[] = { [0 ... 1] = "BB", [2 ... 4] = "CC" };
```

长度得由「最大的那个下标 + 1」定出来（这儿是 5）。`sizeFromInit` 现在见到 `[` 或 `.`
开头的项就钉住报错 —— 它只会「一格一格往后数」，不认指定初始化器。要做的是让数格子
那一遍也认得下标（含 `...` 的范围）与成员名，把「当前位置」跳到指定的那一格去。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第四十片-END -->

## 落地：第八刀第四十一片

**不定长数组配指定初始化器。** tcctest.c:1474 那一条：

```c
char const *const cinit8[] = { [0 ... 1] = "BB", [2 ... 4] = "CC" };   /* 长度 5 */
int t2[] = { [4] = 5, [0] = 1 };                                       /* 长度 5，往回跳 */
int t3[] = { 1, [4] = 5, 6 };                                          /* 长度 6 */
```

### 一 数格子那一遍得**用真的语法分析器**

「长度由初始化式定」在一遍过的编译器里是个鸡生蛋，办法是把初始化式的记号收下来先数
一遍（tcc 的 `decl_initializer_alloc`，我们的 `sizeFromInit`）。原先那一遍是**生扫记号
数组**：只看每一项的头一个记号，够用是因为那时只要区分「`{` 是整格 / 别的往里下降」。

指定初始化器把这条便宜路走死了：`[3] = 1` 里的 `3` 是个常量**表达式**（真实代码里
`[TOK_x] = …` 这种到处都是），生扫记号得不到它的值；`.f =` 还要查 struct 的成员表。

于是这一遍改成**放一遍记号、走真的分析器**：同一个下降栈、同一个 `initDesignators`、
同一条回卷规则，与 `initBraced` 逐行对应，差别只有两处 ——

- 每一项的值用 `skipInitItem` 整段跳掉（到顶层的 `,` 或 `}` 为止），什么都不落地；
- 顶层那一层的长度是未知的（`count = -1`，于是它永远填不满）。

长度取的是**见过的最大格号**，不是「数了几格」—— 指定初始化器可以往回跳。
生扫那一版（`initHeads`）连同它那条 `todo` 一起删掉了。

代价是初始化式的记号现在被走**三遍**（数一遍、放一遍、函数体那两遍里各一次）。这不
影响正确性：数那一遍只求常量、不发指令、不写 data 段。收益是「数格子」与「真的铺」
从此**共用同一套规则** —— 原先那两套迟早会在某个边角上不一致，而这一片正是那个边角。

### 二 顺带确认的一格

`int t5[][2] = { [1] = { 3, 4 } };` 的长度是 2、`sizeof` 是 16。指定初始化器落在顶层
（一格是 `int[2]`），里层那对花括号被整段跳过 —— 与 tcc 一致。

### 量出来的数

- `tests/c/gen/62-init-designator-size.c`（范围指定符定长度、往回跳、指定之后接着往下排、
  `[1].b =` 串起来的、元素是数组的、局部量的那一份）：与 `tcc -run` **逐行一致**。
  量到的：`c8 5: BB BB CC CC CC` / `t2 20 1 5` / `t3 24 1 5 6` / `t4 16 1 7` /
  `t5 16 3 4` / `loc 16 2 4`。
- `tests/c/run.js`：**102 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍（数格子那一遍换了实现，`tcc.c` 里满地都是初始化式）：
  `tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 1474 行走到了 **1560 行** —— 一片跨过 86 行，
  中间那一整段（K&R 的那几个函数、`kr_test`）本来就通了。

### 下一片

第八刀第四十二片：**函数声明符后面挂一对 `[]`**。停在 tcctest.c:1560，那一行自带注释
「We try to handle this syntax. Make at least sure it doesn't segfault.」：

```c
char invalid_function_def()[] {return 0;}
```

tcc 收下它（它的 `post_type` 把 `()` 与 `[]` 一路串起来，不问「函数回数组」合不合法）。
我们现在在这儿报 `lvalue required as unary '&' operand` —— 也就是说这一串被解析成了
别的东西。要做的是先量清楚 tcc 把它当成什么类型，再决定跟到哪一步。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第四十一片-END -->

## 落地：第八刀第四十二片

**转成数组类型 = 去掉「数组」这一层。** tcctest.c:1560 那一行自带注释
「We try to handle this syntax. Make at least sure it doesn't segfault.」：

```c
char invalid_function_def()[] { return 0; }
```

声明符 `()[]` 我们本来就解析对了：后缀倒着套，`[]` 先套在 `char` 上、`()` 再套在
外面 —— 也就是「一个函数，返回类型是 `char[]`」，与 tcc 的 `post_type` 同一个答案。
炸在后面两步：`return 0`（把 0 转成 `char[]`）与 `f()`（一个没有地址的数组值）。

### 一 规则不是我们编的，是 tcc 的 `gen_cast` 最后一句

```c
vtop->type = *type;
vtop->type.t &= ~ ( VT_CONSTANT | VT_VOLATILE | VT_ARRAY | VT_TLS );   /* tccgen.c:3490 */
```

tcc 的数组是 `VT_PTR | VT_ARRAY`，抹掉 VT_ARRAY 剩下的**正好是指针**。所以
「转成 `char[4]`」在 tcc 那儿就是「转成 `char *`」—— 一条我们照抄就行的规则：

```js
if (isArray(ty.t)) return this.castTo(v, mkPointer(ty.ref));
```

量出来的旁证：`(CA)"hi"` 赋给 `char *p` 之后印出来是 `hi`（那个指针就是字面量的地址），
`(int)(long)(CA)0` 是 0。两条都与 `tcc -run` 一致。

### 二 没有地址的数组值

`f()` 的类型是 `char[]`，而那个值在寄存器里 —— 我们的 `decay` 原先一律走 `addrOf`，
于是报 `lvalue required as unary '&' operand`。这一种数组值只有这一个来源（返回类型是
数组的函数），tcc 那边它也只是「寄存器里的一个数、类型上带着 VT_ARRAY 位」。
所以 `decay` 多一格：没有内存位置也没有槽的数组，退化成指针时**照原样用那个值**。

### 三 一条量出来的差别，记在这儿

`sizeof(invalid_function_def)`：tcc 是 **1**（它的 `type_size` 对 VT_FUNC 回 1），
我们是 8（`typeSize` 把函数类型当函数指针）。tcctest.c 不问这个数，而改动它要动
「函数名退化」那一路上的每一处 —— 记下来，等真的有人问再改。

### 量出来的数

- `tests/c/gen/63-array-type-cast.c`（那个函数定义、调用它、转成数组 typedef、
  把它赋给 `char *` 再印）：与 `tcc -run` 一致。量到的：`call 0` / `cast 0` / `p hi`。
- `tests/c/run.js`：**103 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 1560 行走到了 **1783 行**。

### 下一片

第八刀第四十三片：**柔性数组成员**（flexible array member，C11 6.7.2.1 第 18 段）。
停在 tcctest.c:1783：

```c
struct flex { int n; char buf[]; };
```

最后一个成员是个没写长度的数组：`sizeof` 不算它，而 `p->buf` 是「紧跟在前面那些成员
之后的那块」。tcc 收的还不止标准这一种 —— `char buf[0]` 与 `char buf[1]` 那两种老写法
在真实代码里同样常见，而它们的 `sizeof` 各不相同。我们现在在 `structDecl` 里钉住报错。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第四十二片-END -->

## 落地：第八刀第四十三片

**柔性数组成员**（flexible array member，C11 6.7.2.1 第 18 段）。这一片的代码改动是
**删掉一条 todo**，值在于把「为什么不用特判」量清楚：

```c
struct f0 { int n; char buf[]; };      /* sizeof 4 —— buf 占 0 个字节 */
struct f1 { int n; char buf[0]; };     /* sizeof 4 —— GNU 的老写法，同一条路 */
struct f2 { int n; char buf[1]; };     /* sizeof 8 —— 「留一格」那种真的占 1 个字节 */
struct f4 { char c; double d[]; };     /* sizeof 8 —— 占 0 个字节，但**照样抬对齐** */
```

没写长度的数组 `count < 0`，而 `typeSize` 对它回 0（ctype.js:218）—— 于是布局那一步
自然给它 0 个字节、又把它的对齐算进 `maxalign`。`struct f4` 的 8 就是这么来的：
`c` 占 1 个字节，`double d[]` 把整体对齐抬到 8，于是 sizeof 是 8 而 `d` 的偏移是 8。

`p->buf` 也不用改：它是「前面那些成员之后的那块」，而成员的偏移本来就是布局算出来的
（量出来 `(char *)p->buf - (char *)p` 是 4）。`struct f0 init = { 5 };` 同样成立 ——
那个柔性成员有 0 个元素，初始化式铺完 `n` 就没了。

### 量出来的数

- `tests/c/gen/64-flex-array.c`（三种写法的 sizeof、`strcpy` 进 `p->buf` 再读、
  `int v[]` 那一种、`char c; double d[];` 的对齐、带初始化式的）：与 `tcc -run` 一致。
  量到的：`sz 4 4 8 4 8` / `p 3 abc 4` / `q 11 22 4` / `i 5`。
- `tests/c/run.js`：**104 passed, 0 failed**。
- 我们自己的前端读 tcctest.c 从 1783 行走到了 **1813 行**。

<!-- 第八刀第四十三片-END -->

## 落地：第八刀第四十四片

**常量表达式里 `||` / `&&` / `? :` 也短路。** tcctest.c:1813，注释原话
「exception in constant but unevaluated context」：

```c
int sinit24 = 2 || 1 / 0;
```

C11 6.5.13/6.5.14/6.5.15 说得很清楚：右边那一半（没走到的那一支）**不求值**。而
「不求值」在常量表达式里是有观察差别的 —— 除以零在这儿本来是一条编译期错误。

### 一 记号还是要读掉，只是那一段的错不算

常量求值器是递归下降的，右边那一半必须走一遍才能把记号吃完。所以加的是一个**计数器**
`ceDead`：进被短路掉的那一段时 +1，出来 -1；算子的报错走 `ceErr`，它在 `ceDead > 0`
时什么都不做。tcc 那边是同一个思路（`nocode_wanted` 一路传下去压掉那条错）。

`ceApply` 的除零那一格因此多了一行：`err(...)` 不抛的时候得有个回得出去的值（0n）——
不然 bigint 的 `a / 0n` 会当场扔 RangeError，那是一条**不带位置信息**的崩，
比报错更难查。

### 二 `? :` 两支都要管

`1 ? 3 : 1 / 0` 与 `0 ? 1 / 0 : 4` 是同一件事的两面，所以 `ceCond` 里两支各包一次
计数器。GNU 的 `x ? : y` 那一格（第三十六片）不受影响 —— 中间那一项省掉时值已经
在手上，不必再走一遍。

### 量出来的数

- `tests/c/gen/65-const-shortcircuit.c`（`||`、`&&`、`? :` 两支、数组维度上的、
  串起来的 `0 || 2 || 1/0`）：与 `tcc -run` 一致，量到 `1 0 3 4 1 1 0`。
- `tests/c/run.js`：**105 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 1813 行走到了 **1817 行**。

### 下一片

第八刀第四十五片：**静态位域的初始化式**。停在 tcctest.c:1817：

```c
struct bf_SS { unsigned int bit:1, bits31:31; };
struct bf_SS bf_init = { .bit = 1 };
struct bfn_SS { int a, b; struct bf_SS c; int d, e; };
struct bfn_SS bfn_init = { .c.bit = 1 };
```

自动那一侧早就通了（`vstore` 认得位域）；静态这一侧要**按位往 data 段里并** ——
同一个字节里的几个位域来自好几条初始化式，而 `emitBytes` 现在是「一格覆盖一格」。
`initScalar` 里那条 todo 就钉在这儿。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第四十四片-END -->

## 落地：第八刀第四十五片

**静态位域的初始化式**：按位往 data 段里**并**。tcctest.c:1817 那一段：

```c
struct bf_SS { unsigned int bit:1, bits31:31; };
struct bf_SS bf_init = { .bit = 1 };
struct bfn_SS bfn_init = { .c.bit = 1 };
struct bfa_SS bfa_init = { .c[1].bit = 1, .c[2].bits31 = 5 };
```

自动那一侧早就通了（`vstore` 认得位域，读改写三条指令）；静态这一侧原先钉着一条 todo。
难的不是取位，是**同一个访问单元里的几个位域来自好几条初始化式** —— `emitBytes` 是
「一格覆盖一格」，第二条会把第一条抹掉。

做法是让静态位域走一条**回头改**的路：`emitBitfield` 按地址记住那一条 `pendingData`
（`statBits` 这张表），往它的字节里**或**进去。没写到的位保持 0，正是 C 要的
（静态存储期先零初始化）。取位那一段与 `storeBitfield` 共用同一组量：`bitPosOf` /
`bitSizeOf` / `bfAccess` —— 也就是说「位域住在哪个字节的哪几位」这件事只有一份答案。

### 量出来的数

- `tests/c/gen/66-static-bitfield.c`（`.bit = 1`、按顺序写两个、struct 里嵌一层、
  数组的第 1/2 格、同一个字节里两个位域 + 一个普通成员）：与 `tcc -run` 一致。
  量到的：`1 1 0` / `2 1 7` / `3 1 0 0` / `4 1 5 0` / `5 3 1 9 8`。
- `tests/c/run.js`：**106 passed, 0 failed**。
- 我们自己的前端读 tcctest.c 从 1817 行走到了 **1827 行**。

<!-- 第八刀第四十五片-END -->

## 落地：第八刀第四十六片

**文件作用域上 `extern int x = 1;` 是一条定义。** tcctest.c:1827：

```c
extern int external_inited = 42;
```

带初始化式就是定义 —— `extern` 那个存储类被压过去了（C11 6.9.2 的脚注；gcc 警告一句，
tcc 一声不响地收）。我们原先在这儿报 `'x' has both 'extern' and initializer`，
改成「有初始化式时按不带 extern 走」：`declareGlobal(name, vty, isExtern && !hasInit, …)`。

**块里那一种不一样**，而这一格是量出来的：tcc 对 `int main() { extern int x = 3; }`
报的是 `';' expected (got '=')` —— 它的块作用域声明根本不认那个 `=`。所以我们在**吃掉**
那个记号之前判，让 `skip(SEMI)` 自己报出同一句话。措辞与行号都对上了
（`tests/c/diag/07-extern-local-init.c`）。

### 量出来的数

- `tests/c/gen/67-extern-inited.c`（`extern int x = 42`、`extern` 声明后面再定义、
  `extern char es[] = "hi"` 的 sizeof）：与 `tcc -run` 一致，量到 `42 5 hi 3`。
- `tests/c/diag/07-extern-local-init.c`：错误措辞与行号与 tcc **逐字节相同**。
- `tests/c/run.js`：**108 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 1827 行走到了 **1968 行**。

### 下一片

第八刀第四十七片：**`case` 的范围**（GNU 扩展）。停在 tcctest.c:1968：

```c
case 1 ... 5:
```

`switch` 那一套现在只认单个常量（`scanCases` 收的是一张「值 -> 分支号」的表）。范围要
把那张表变成「区间 -> 分支号」，而下游那个跳转链也得跟着改 —— 一个区间不能摊成
「几千个相等比较」（`case 0 ... 1000000:` 在真实代码里有）。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第四十六片-END -->

## 落地：第八刀第四十七片

**`case 1 ... 5:`**（GNU 的范围）。tcctest.c:1968。

`case` 的标签从「一个值」变成「一个**闭区间**」——单个值就是 `lo === hi` 的那一种，
于是分派那一步只有一套代码，而不是两条路。收标签那一遍（`scanCases`）多读一个
`... 上界`；重复检查从「一个 Set 查值」变成「与已有区间比有没有交叠」。

分派那两条路各改一处：

- **密的**（跳转表）：表还是一格一格填，判「这一格属于谁」从 `c.v === i` 变成
  `c.v <= i && i <= c.hi`。密度门槛数的东西也变了 —— 数**覆盖到的值**而不是标签数，
  因为 `case 0 ... 99:` 一条标签就把 100 格填满了。
- **稀的**：一个区间是**一次**无符号比较 `(unsigned)(v - lo) <= hi - lo`，
  不是摊成 `hi - lo + 1` 个相等比较。`case 1000 ... 100000:` 真实代码里有，
  摊开就是十万条指令。

### 量出来的数

- `tests/c/gen/68-case-range.c`（密的范围、长度 1 的范围、稀的十万格范围、
  `'a' ... 'z'` 三段字符）：与 `tcc -run` 一致，量到
  `-1 10 10 10 10 10 -1 20 -1 | 30 -1 40 40` 与 `g 1 2 3 0`。
- `tests/c/run.js`：**109 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 1968 行走到了 **2900 行** —— 一片跨过 932 行。

<!-- 第八刀第四十七片-END -->

## 落地：第八刀第四十八片

**指针的静态初始化式是一个地址常量**（C11 6.6 第 9 段）。tcctest.c:2900 一带：

```c
int reltab[3] = { 1, 2, 3 };
int *rel1 = &reltab[1];
int *rel3 = reltab + 2;
char *p = "abcd" + 1;
int *rel5 = &st.b;
```

### 一 借表达式一路，而不是教常量求值器认全局量

常量求值器是另一台机器：只认记号、没有类型。而这几行要的三件事都是**类型上的**——
指针算术按元素大小缩放、数组退化成指针、`&s.f` 加成员偏移。教它认这三件事等于把
类型系统抄一遍，那两份迟早不一致。

所以静态初始化式里「目标是指针」的那一格改成**借表达式一路**：在一个用完就丢的
`MirFunc` 里解析（与 `sizeof`、`&` 那两格同一手法），拿到的 ref 是常量就是那个地址。
这一条同时把 `reltab`（数组退化）、`f`（函数名）、`"abcd" + 1`（字面量加偏移）
一起收了 —— 它们本来各有各的特判。

### 二 让「常量 + 常量」真的折起来

借过来之后还差一步：表达式一路原先**从不折**指针算术，`&reltab[1]` 会落成一条 ADD
指令。于是两处加了折叠：

- `genPtrOp` 的「指针 + 整数」：两边都是常量就在编译期算完；
- `addrOf`：地址本身是常量时把静态偏移折进去（`&st.b`）。

真实编译器里这两折是**重定位**（`.data` 里写 `reltab + 4`）；我们的「链接」是一个数，
所以折叠**就是**那条重定位。顺带一提，函数体里也少了两条指令。

### 三 值住在 data 段里的那一种：读回来

`void *cinit51 = (void *){ (void *)51 };`（第四十片那个静态复合字面量）不是地址常量 ——
它是「那块 data 里的**内容**」。tcc 在这一格是从 section 里拷字节（`init_putv` 的
`VT_LVAL` 那一支），我们照做：`staticRead` 把已经写好的字节读回来，没写过的是 0。

### 四 一条量出来的差别

`unsigned long d = (unsigned long)&reltab[1] - (unsigned long)&reltab[0];`：
**tcc 拒绝**（`initializer element is not constant`）—— 两个重定位相减它折不了。
我们收下（在我们这儿地址就是数，减法当场算完 4）。这是「地址是不是真的数」这条建模
差别第一次露出可观察的口子，记在这儿；要对齐得给 data 段的地址加一层「符号 + 偏移」
的表示，那是链接那几步的事。

### 量出来的数

- `tests/c/gen/69-static-address.c`（`&a[i]`、`a + i`、光数组名、`&s.f`、
  字面量加偏移、`&"abcd"[2]`、函数名、`arr2[1] + 1`）：与 `tcc -run` 一致。
  量到的：`2 3 3 1` / `5 bcd cd` / `7 5`。
- `tests/c/run.js`：**110 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍（`addrOf` 与 `genPtrOp` 都动了，产物必须一个字节不差）：
  `tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 2900 行走到了 **2987 行**。

### 下一片

第八刀第四十九片：**C99 的变长数组**（VLA）。停在 tcctest.c:2987：

```c
void c99_vla_test_1(int size1, int size2)
{
    int size = size1 * size2;
    int tab1[size][2], tab2[10][2];
```

长度是**运行期**的值：帧上那一块要在运行期划（tcc 用 `alloca` + 一个保存的栈指针），
`sizeof tab1` 变成一次乘法而不是一个常量，而且「长度在声明那一刻就定住了」——
后面改 `size` 不影响它。作用域退出时还要把栈指针收回去。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第四十八片-END -->

## 落地：第八刀第四十九片

**C99 的变长数组**（VLA）。`int a[n]` —— 长度是运行期的一个值。

### 一 「多大」这件事从类型里拿出来，放进一个槽

普通数组的长度是类型上的一个数（`ctype.js` 的 `count`）。VLA 的长度不是数，所以类型上
挂的是**那个数在哪儿**：`ty.vla` 是一个 MIR 槽号，槽里放着**整个数组的字节数**。

tcc 那边 VLA 是另一位（`VT_VLA`），而且它**不带** `VT_ARRAY` —— 于是 tcc 到处要写
`t & (VT_ARRAY|VT_VLA)`。这里反过来：VLA 就是一种数组（`isArray` 成立），「长度未定」
照旧是 `count < 0`。这么选换来的是**退化成指针、下标、`&`、强制转换那几条路一个字都
不用改**；代价是每一处「必须是常量大小」的位置要单独挡一次。挡了三处：`sizeof`
（改成运行期读那个槽）、初始化式（`variable length array cannot be initialized`）、
常量表达式里的 `sizeof`（报「要一个常量表达式」）。

### 二 「是不是常量」只有常量求值器答得出来

tcc 不需要试：它的表达式解析器自己就折常量，所以局部量的维度一律走 `gexpr()`，
折完看 `vtop` 上还是不是 `VT_CONST`（`tccgen.c:5167-5188`）。我们主路上**不折**
（文件头偏离 3），照它那样做的话 `int buf[2*N]` 会莫名变成变长数组。

所以这一片的读法是「收下这一段记号，先试一遍」：`captureTokens(']')` 收下，
`tryConstDim` 用常量求值器放一遍 —— 成了就是普通数组（与从前一个字节都不差），
不成才把这段记号留到 `wrap` 里当运行期表达式再读一遍（`replayDim`）。试那一遍要求
「什么都没发生」：宏栈连帧一起还原，因为报错是从中间抛出来的、`endMacro` 那条路走不到。

### 三 那块地方：`$sp` 上切一刀

`$sp` 本来就是一个往下长的 i64 全局（第三刀）。于是 `alloca` 就是三条指令：
`$sp = ($sp - 字节数) & -16`，切完的值存进变量自己那个槽 —— 也就是说**变长数组这个
名字是一个指针槽**，`entryLval` 那儿多出来的一格就是为它:先读出那个指针，再当内存
左值的基址。它是唯一一种「在内存上、却不占帧」的局部量。

对回 16 不是讲究：帧的对齐是 16，切一刀之后不对回去，后面所有 8 字节访问都可能骑在
边界上。

### 四 收回去：一处存，四处放

「平铺的帧」那一节说帧不回收 —— 那是因为地址恒定比省空间重要。变长数组没有这个选择：
循环体里每一圈都切一块，不收就是 `$sp` 一路掉出内存。所以：

- **存**在「这一层作用域里第一个变长数组之前」（不是作用域开头 —— 那时还不知道里面
  有没有 VLA，而 MIR 不能回填）。一层一格，记在 `vlaStack` 上，就是 tcc 的
  `cur_scope->vla.locorig`。
- **放**在四处：`popScope`（正常退出）、`break`/`continue`（`BR` 会**跳过**上面那条，
  所以跳之前自己发一条 —— tcc 的 `vla_leave`）、`goto`（收到函数里最外面那一格，
  tcc 也是 locorig）、以及 `return`（收场那条 `$sp = spSave` 本来就覆盖了）。

收的是**被跳出去的那些层里最外面那一层**：`$sp` 只往下走，恢复最外面那一格就把里面
所有的一起收回来了。为此 `vlaStack` 的每一格还记着「它开在第几层 MIR 区域里」——
`break` 要知道自己越过了哪些层。

顺带一件事：`frameSize` 为 0 的函数本来不发序言/收场，而有变长数组就必须发（不然
`$sp` 还不回去，递归一圈走穿栈）。所以有 VLA 时把帧撑到 16 —— 帧里一格都不用，
要的只是那一对。

### 五 元素也是变长的那一种

`int a[2][n]`：外面这一维是常量，里面是变长的 —— 于是**外面这一层也得是变长的**
（字节数 = 2 × 里层那个槽，tcc 的 `t1 |= type->t & VT_VLA`）。这一格带出来的是
`genPtrOp`：`a[i]` 里「加 i 格」在元素变长时是一次乘法而不是一个常量，指针相减那一边
是一次除法。也就是说 `int (*arr)[h][w]`（指向变长数组的指针，tcctest.c:3036）跟着一起
就通了 —— 它不需要额外的代码，它需要的只是这两处别再读 `typeSize` 那个 0。

### 六 存储类说的是「那个对象」

`static int a[n]` 要常量，`static int (*p)[n]` 不要 —— 后者的 `[n]` 说的是它**指向**的
东西。tcc 的那一句 `post_type(post, ad, post != ret ? 0 : storage, …)`（`tccgen.c:5313`）
就是这条规矩：声明符里有指针链的话，存储类在后缀这一步被丢掉。我们的 `vlaMode` 是这
一句话的三个值：0 不行、1 只有穿过指针才行、2 行。

### 量出来的数

- `tests/c/gen/70-vla.c`（`sizeof`、长度在声明那一刻定住、指针相减/相加/下标、
  循环里的 2000 圈、`break`/`continue`/`goto` 各一条、递归六层、`int a[2][n]`、
  `int (*arr)[h][w]` 与 `static int (*starr)[h][w]`）：与 `tcc -run` 逐字节一致。
  量到的：`s 30 119` / `sz 1 80` / `sub 1` / `add 1` / `acc 1` / `loop 4000000` /
  `goto 500500` / `rec 91` / `in 24 12 12 0` / `p 80 20 4` / `p 2 3 1` / `p 1 60 34`。
- `tests/c/run.js`：**111 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍（数组维度那一步的读法变了，所有局部数组都过这条路）：
  `tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 2987 行走到了 **3076 行**。

### 下一片

第八刀第五十片：**形参上的变长数组**。停在 tcctest.c:3076：

```c
void c99_vla_test_3b(int s, int arr[s][3][4])
{
    printf("%d\n", (int)sizeof(*arr));
}
```

形参上的 `[s]` 是另一件事：最外面那一维按 C 的规矩变成指针，而里面那些维度的长度要留到
**函数体的开头**才求值 —— 那时形参才有值。tcc 为此把那段记号存在类型上
（`vla_array_str`，`tccgen.c:5232`），进函数时再放一遍（`func_vla_arg_code`）。
`int arr[][3][--s]`（tcctest.c:3091）说明那段记号是**真的求值**，不是抄一个数。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第四十九片-END -->

## 落地：第八刀第五十片

**形参上的变长数组**，以及**类型名里的变长数组**。

### 一 形参上那个长度，进函数时才算

`void f(int s, int arr[s][3][4])` —— 声明符读到 `[s]` 那一刻，`s` 还没有值（它自己也是
这一张形参表里的一格）。所以形参上的变长维度只能**先收着**：那段记号挂在类型上
（`ty.vlaToks`），进函数、形参都绑好之后再放一遍（`vlaParamCode`）。tcc 挂在 Sym 的
`vla_array_str` 上（`tccgen.c:5232`），进函数时 `func_vla_arg_code` 放一遍 —— 同一件事。

顺序是**由里往外**：外面那一层的「一格多大」等于里面那一层的字节数。

那段记号是**真的求值**，不是抄一个数：`int arr[][3][--s]`（tcctest.c:3091）会把 `s` 减一，
而且减完的值就是 `sizeof(*arr)` 里用的那个。

最外面那一维不算：C 说形参上的数组就是指针（`paramList` 那一句 `mkPointer`），所以
`[s]` 读完就丢。`[]` 也因此在最外面那一维上合法 —— tcc 的「need explicit inner array
size in VLAs」只在**里层**报（`td & TYPE_NEST`）。

### 二 一个踩到的坑：类型对象只有一份，函数体解析两遍

第一遍把算出来的槽号写在类型上，第二遍看见「已经算过了」就跳过 —— 于是第二遍用的是
**第一遍那个函数**的槽号，MIR 的良构检查当场报「槽号越界」。判据得是「这一层是不是形参
上待算的」（`vlaToks` 在不在），而不是「算过了没有」。两遍各算一次，各自的槽号才对得上。

这是「函数体解析两遍」这条选择第二次咬人（第一次是第八刀第九片的 `pendingData`）：
**凡是挂在类型/符号上的槽号与 ref，都是一遍一份的东西。**

### 三 `sizeof` 里的变长数组：操作数不求值，可是长度要算

`sizeof(char[1+2*a])`（tcctest.c:3162，那儿的注释原话是「sizes of VLAs need to be
evaluated even inside sizeof」）。我们的 `sizeof` 把 `this.f` 换成一个用完就丢的
MirFunc（操作数不求值），而这个长度**必须真的算**。tcc 那边是同一个矛盾，它的解法是在
VLA 长度那一格上把 `nocode_wanted` 清零（`tccgen.c:5175`）。

我们的解法是一个 `bodyF`：**函数体**那个 MirFunc 单独记着，`arrayPost` 发指令时切到它
上面。也就是说「不求值」这件事有一个例外，而那个例外只有一处入口。

### 量出来的数

- `tests/c/gen/71-vla-param.c`（`int arr[2][3][4]` / `[s][3][4]` / `[2][s][4]` /
  `[2][3][s]` / `[][3][--s]` 五种形参，原型 + 定义各写一遍的那一种，
  以及 `sizeof(char[1+2*a])`）：与 `tcc -run` 逐字节一致。
  量到的：`48 16 23` ×4、`48 16 23 4`、`8 5`、`t 5 24`、`x 2`。
- `tests/c/run.js`：**112 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 3076 行走到了 **3185 行**。

### 下一片

第八刀第五十一片：**`typeof`**。停在 tcctest.c:3185：

```c
printf("typeof(int) = %d\n", (int)sizeof(typeof(int)));
```

GNU 的 `typeof(表达式)` 与 `typeof(类型名)`（`tccgen.c` 的 `parse_btype` 里 `TOK_TYPEOF`
那一格）：表达式那一种**不求值**，只取类型 —— 与 `sizeof` 同一条路（`expr_type`），
所以这一片主要是把那条路接到 `parseBtype` 上。C23 把它写进了标准。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第五十片-END -->

## 落地：第八刀第五十一片

**GNU 的 `typeof`**（`typeof` / `__typeof` / `__typeof__`，C23 收进了标准）。

括号里可以是**类型名**也可以是**表达式**，表达式那一种**不求值** —— 与 `sizeof` 是同一件
事，所以同一个手法：发进一个用完就丢的 MirFunc（`typeofType`）。tcc 那边这两条路合在
`parse_expr_type` 里（`tccgen.c:6810`），我们照着分。

它在 `parseBtype` 里走的是 **`tdef` 那一格** —— 与 struct/union/enum 和 typedef 名一样，
`typeof(x)` 是「一整个类型」而不是一位说明符，所以不能与 `short`/`long`/`signed` 同时
出现。这一格换来的是数组类型原样带过去（`count` 跟着 `tdef` 走，见那儿的注释）：
`typeof(arr) arr2 = {…}` 的 `sizeof` 是 16 而不是 8。

存储类要剥掉（tcc 那句 `type1.t &= ~(VT_STORAGE&~VT_TYPEDEF)`）：`typeof(某个 static 的
东西)` 说的是那个**对象**的存储类，不是它的类型。

`isTypeStart` 也要认它：`typeof(x) y;` 是一条声明的开头，`(typeof(x))v` 是一次强制转换 ——
两处都靠那一问。

## 落地：第八刀第五十二片

**块局部标签声明** `__label__ a, b;`（GNU 扩展）。

它声明的是「这几个标签只属于这一层块」，为的是让宏里的标签不与外面撞名。我们的标签是
**函数一份**的编号（第二十四片那台状态机），所以这一片只把名字读掉 —— 可观察的差别只有
「同名标签在两个块里各算一个」那一种，而那要给标签也摆一层作用域。撞上了的表现是
「重复的标签」，不会静悄悄跳到错的地方，所以这个界是安全的。

### 量出来的数

- `tests/c/gen/72-typeof.c`（`typeof(表达式)` / `typeof(类型名)` / 数组 / 指针 /
  `unsigned char` / 文件作用域上的 `typeof(gv)` 与 `__typeof__(int *)` / 强制转换 /
  「不求值」（`sizeof(typeof(a++))` 之后 `a` 没变）/ `typeof(*(char (*)[7])0)`，
  再加一个 `__label__` 的块）：与 `tcc -run` 逐字节一致。
  量到的：`t 4 4 16` / `v 4 5 3 8` / `g 7 8 7` / `u 201 1` / `c 1 8` / `n 4 3` /
  `s 7` / `l 5 15`。
- `tests/c/run.js`：**113 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍（两片一起量：`parseBtype` 与 `stmt` 各多一格，都在主路上）：
  `tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 3185 行走到了 **3262 行**（`__label__` 读过去了，
  停在同一行上的**另一个**界：语句表达式里带标签）。

### 下一片

第八刀第五十三片：**语句表达式里的语句标签**。停在 tcctest.c:3262：

```c
    ({ __label__ l1; goto l1; l1:; });
```

这是第八刀第三十八片（语句表达式）与第二十四片（`goto` 那台状态机）撞在一起的地方：
语句表达式的值靠「复合语句最后一条表达式落在一个槽上」拿到，而带标签的复合语句要开一层
MIR block 摆分派链 —— 那一层会把值挡在里面。真做法大概是把值先写进槽、再从槽里读，
也就是让语句表达式**总是**走槽，而不是只在带标签时走。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第五十二片-END -->

## 落地：第八刀第五十三片

**语句表达式里带语句标签** —— `({ __label__ l1; goto l1; l1:; })`（tcctest.c:3262）。

第三十八片（语句表达式）与第二十四片（`goto` 那台状态机）撞在一起的地方。撞出来的是两个
彼此独立的毛病，而它们的解法是同一个：**让语句表达式自己是一层**。

### 1. 值挡在块里 -> 值落在槽上

语句表达式的值是「最后那条直接长在里面的表达式语句」的值，而拿到它的办法本来是直接留住
那条表达式的 ref（`exprStmt` 看 `seStack` 栈顶那一帧记的深度）。没有标签的复合语句**不开
MIR 的 block**，所以那个 ref 出了花括号照样能用。

有标签就不行了：分派链要一层 `BLOCK`，而 MIR 是结构化控制流上的 SSA —— **块里定义的 ref
出了块就不能用**。所以这一种得改成「块里写槽、块外读槽」：槽是函数一份的，跨得过 `END`。
聚合的那一种落在槽上的是**地址**（那块地方在帧上、帧不回收，所以出了块还在）。

每条表达式语句都新开一个槽，因为类型可以不一样（`({ 1; 1.5; })`），而只有最后一条那个会被
读到 —— 这与 tcc 的 `vpop(); gexpr();`（先丢掉上一条的，最后剩的自然是最后一条的，
`tccgen.c:7511`）是同一个意思，只是我们丢的是槽号而不是栈顶。

### 2. 两遍数出来的段数不一样 -> 自己一份 `kids`

第一次跑出来的是 `internal: 段数与第一遍量的不符`，最小的样子只要一行：

```c
int v = ({ lab4: s = s + 7; s; });
```

第一遍 `blockBody` 把「有标签的子语句」push 进**外面那个块**的 `kids`，于是外面那个块以为
自己多了一条带标签的子语句、第二遍要给它切一段（`segCut`）。可是这个语句表达式长在
**声明的初始化式**里 —— 第二遍的 `segCut` 只在语句前面跑，声明前面不跑，于是段数对不上。

`kids` 记的是「这一层要为哪几条子语句切段」，而语句表达式里的标签根本不该由外面那一层管。
所以进 `stmtExpr` 时把 `this.kids` 换成一个用完就丢的数组：外面看不见它，也就不会为它切段。

### 3. 一台**局部**的状态机

既然外面那台不管里面的标签，里面就得自己有一台：一个状态槽、一圈
`BLOCK'gotoend'` + `LOOP'gotoloop'`，与 `runBody` 里那台一个形状，只是嵌在这一层里。
`goto` 找 `levelOf('gotoloop')`，找到的自然是最里面那一圈，所以嵌套的语句表达式各跳各的，
不必额外做什么。

这么做是对的，因为**gcc 明令禁止跳进语句表达式** —— 里面的标签只可能被里面的 `goto` 用。
反过来「从里面跳到外面的标签」gcc 是允许的，而我们做不到（要跨出这一层 `LOOP`，而且状态槽
都不是同一个）。那个界在 `gotoStmt` 里明确报出来：名字在外面那张表里找得到、在里面找不到，
就是 `goto 'x' out of a statement expression is not supported`，不会静悄悄跳错。

### 4. 标签表要跨两遍活着

第一版把局部标签表写成「进来 `new Map()`、出去丢掉」，结果 MIR 里冒出一条
`const k6 i32 undefined`：标签的**编号是第一遍给的**（`labelStmt` 只在第一遍往表里写），
第二遍拿着一张空表去 `labelIds.get(name)` 只能得到 `undefined`，再 `consts.i32(undefined)`
就成了那条常量。

这是「函数体解析两遍」第三次咬人（前两次：形参上的变长维度、槽号是每遍一份的）。这次的教训
反过来：**第一遍算出来、第二遍要用的东西，必须存在跨得过两遍的地方**。所以那张表按语句序号
存进 `seLabels`，与 `stmtRanges` 一样的活法 —— 语句序号在两遍里是同一个，这是第十五片
就立好的地基。

顺带把 `name:` 那一支改成**深度透明**的（`blockDepth--` / `block()` / `blockDepth++`）：
`({ lab: x; })` 里那条带标签的表达式语句在 `exprStmt` 眼里得还算「直接长在这一层」，
不然值就留不下来（症状是 `cannot assign 'int' to 'struct S'` 那一类）。

### 量出来的数

- `tests/c/gen/73-stmt-expr-label.c`（十二条：标签在前值在后 / 往后跳 / 往前跳（在语句
  表达式里跑一圈循环）/ 值是聚合 / 嵌套（里外各一台机器）/ 一条表达式语句都没有（void）/
  几条类型不一样的 / 长在 `for` 里每圈重进 / 里面有 `switch` / 里面有变长数组 /
  当条件用 / 长在 `return` 里）：与 `tcc -run` 逐字节一致。
  量到的：`v 7 7` / `w 3 1` / `r 10 10 5` / `q 1 20 3` / `n 40` / `side 5` / `d 2.5 6` /
  `sum 46` / `z 2 0 1` / `p 35` / `cc yes 1`。
- `tests/c/run.js`：**114 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 3262 行走到了 **3951 行** —— 一片走过将近七百行，
  因为 3262 之后那一大段（`goto` 的各种花样、`asm` 之外的 GNU 扩展、`__builtin` 的一堆）
  本来就都在路上了，只被这一个界挡着。

### 下一片

第八刀第五十四片：**`__builtin_types_compatible_p`**。停在 tcctest.c:3951：

```c
#define COMPAT_TYPE(type1, type2) \
    printf("__builtin_types_compatible_p(%s, %s) = %d\n", #type1, #type2, \
           __builtin_types_compatible_p(type1, type2));
```

它是个**编译期**的问句：两个类型名，忽略顶层限定符与 `signed`/`unsigned` 之外的别名，
一样就是 1。tcc 的做法在 `tccgen.c` 的 `TOK_builtin_types_compatible_p` 那一支：
两次 `parse_expr_type` 之后把两边的 `t` 都去掉限定位再 `is_compatible_types`。我们已经有
`typeName()`（第五十一片的 `typeof` 用的就是它）与类型比较，所以这一片主要是把
「什么算一样」量准 —— 数组的长度算不算、函数的形参算不算、枚举与它的底层整型算不算。

之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第五十三片-END -->

## 落地：第八刀第五十四片

**`__builtin_types_compatible_p(T1, T2)`**（tcctest.c:3951）。

一个编译期的问句：两个**类型名**（不是表达式），相容就是 1。tcc 那一支只有四行
（`tccgen.c:5816`）：把两边最外层的 `const`/`volatile` 抹掉，问 `is_compatible_types`，
`vpushi(n)`。所以这一片的分量不在接线，而在**「什么算一样」这一句得先量准**。

### 1. 「什么算一样」从此只有一处

原先我们有 `sameType` 与 `sameTypeUnqual` 两个函数，各自写了一遍比较；tcc 那边是**一个**
`compare_types(t1, t2, unqualified)`，`is_compatible_types` 与
`is_compatible_unqualified_types` 只是它的两个入口。ADR 开头那条「加一条方便的判断的代价是
它迟早与已有的某条在某个边角上给出不同答案」在这儿应验了 —— 把两个函数合成
`compareTypes(a, b, unqualified)` 之后，三处一直答错的地方一起浮出来：

- **`signed` 写没写只对 `char` 有意义**。`signed int` 与 `int` 是同一个类型，而
  `char` / `signed char` / `unsigned char` 是**三个**（C11 6.2.5 第 15 段）。tcc 的写法是
  「基本类型不是 `VT_BYTE` 时先把 `VT_DEFSIGN` 抹掉」，一条掩码顶一张表。
- **数组的长度要比**，但**有一边没写长度就算相容**（`int a[]` 与 `int a[10]`）——
  暂定定义与「先声明后补全」全靠这一条。原先我们干脆不比长度，于是
  `int a[5]` 与 `int a[10]` 重定义能过。
- **比的是 `t & ~(VT_STORAGE | VT_STRUCT_MASK)`**（tcc 的 `VT_TYPE`）。原先只抹了存储类，
  于是 struct/union/enum 那一段与位域那几位也进了比较 —— 而后者（位域的偏移与宽度）
  是**成员**的事，不是类型的事。

### 2. `int f()` 不是「没有形参」

`int()` 与 `int(int)` 在 tcc 眼里是**相容**的，因为 `int f()` 记的是 `FUNC_OLD`：括号里
什么都没写不等于「没有形参」，而是「形参没说」（C11 6.7.6.3 第 14 段）。「真的没有形参」
是 `int f(void)`。`is_compatible_func` 见到任一边是 `FUNC_OLD` 就只比返回类型、当场回 1。

我们本来就有 `ref.old`（K&R 的标识符表那一路在用），这一片把空括号也归进去 —— 于是
调用点也跟着不核对实参个数了，而那正是 tcc 的行为（`gfunc_param_typed` 对 `FUNC_OLD`
什么都不检查）。

### 3. 一个明确报出来的界：只有一边是枚举

tcc 在只有一边是枚举时拿的是**那个枚举的底层类型**，而底层类型是**算出来的**：
所有枚举值都非负就是 `unsigned int`，装不进 `int` 就是 `long long`（`tccgen.c:4556` 一带）。
我们的枚举底层永远是 `int`（`mkEnum`），所以 `__builtin_types_compatible_p(enum E, unsigned int)`
会答错 —— tcc 说 1，我们说 0。与其静悄悄给个错的数，这一片在那个位置直接报
`__builtin_types_compatible_p with one enum side is not supported`。

两边都是枚举那一种是对的（比「是不是同一个枚举」），tcctest.c 考的那十二对里也没有枚举。
报错只报在这个内建里，**不**报在 `compareTypes` 里 —— 赋值那一路天天问「enum 与 int 相容吗」，
在那儿报错会把对的代码判成错的。

### 量出来的数

- `tests/c/gen/74-types-compatible.c`（四十三对：整型与符号性 / 限定符 / 指针 / typedef /
  枚举 / struct 与 union / 数组（含长度与二维）/ 函数（含 `int()`、`int(void)`、变参、
  函数指针））：与 `tcc -run` 逐字节一致。
- `tests/c/run.js`：**115 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍（`compareTypes` 在主路上，赋值、重定义、初始化式全过它）：
  `tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- 我们自己的前端读 tcctest.c 从 3951 行走到了 **4102 行**（`__builtin_constant_p` 与
  `__builtin_choose_expr` 那一段本来就走得过去）。

### 下一片

第八刀第五十五片：**`? :` 两臂是指针时的结果类型**。停在 tcctest.c:4102：

```c
  int i1 = (i == 0 ? 0 : s)->i;
  int i3 = (i == 0 ? (void*)0 : s)->i;
```

一臂是空指针常量或 `void *`、另一臂是 `struct condstruct *`，结果类型得是后者 ——
我们现在算出来是 `void`，于是 `->` 报「不是结构体」。tcc 的规则在 `gen_cond` 里那段
类型合并（`tccgen.c` 的 `TOK_COLON` 那一支）：两臂都是指针时取「相容的那个合成类型」，
一臂是 0 就取另一臂，一臂是 `void *` 就取 `void *` 之外那个的指向类型。C11 6.5.15
第 6 段是这条规则的出处。

再之后：枚举的底层类型（上面那个界）、`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、
第 9-11 步的后端。

<!-- 第八刀第五十四片-END -->

## 落地：第八刀第五十五片

**`? :` 两支里有指针时的结果类型**（tcctest.c:4102，C11 6.5.15 第 6 段）。

原先这一格只有一句：「有一支是指针，结果就是那个指针类型」。它在 `(i ? 0 : s)` 上是对的，
在 `(i ? (void *)0 : s)` 上就不是了 —— 那时两支**都**是指针，`pa` 先被挑中，于是整条的类型
是 `void *`，`->i` 只能报「不是结构体」。tcc 的规则是三条（`tccgen.c:2931-2999`）：

1. **一支是空指针常量 -> 结果是另一支的类型**。`is_null_pointer`（`tccgen.c:2814`）认三种：
   常量 0 的 `int`、常量 0 的 `long long`、以及**不带限定符的 `void *` 上的常量 0**——
   也就是 `(void *)0`。这一条排在最前面，所以 `(void *)0` 与 `T *` 那一对答的是 `T *`。
2. 一支是指针、另一支是**不为 0 的**整数 -> 结果是那个指针类型（tcc 只警告不报错）。
3. **两支都是指针** -> 指向 `void` 的那个优先，否则取第二支；两边**指向的东西**上的限定符
   要并起来（`const char *` 与 `char *` -> `const char *`）；两边指向的都是数组而选中的
   那个长度未定时，长度从另一个那儿补上（于是 `sizeof(*(c ? a0 : a5))` 是 20 而不是 0）。

「是不是常量 0」这一问在我们这儿只能看 ref 是不是常量池里的一条（偏离 2：主表达式那条路
不折常量）。`(void *)0` 那次强制转换落不成常量时第一条就认不出它 —— 但那时走第三条，
而第三条对 `void *` 与 `T *` 这一对给的是同一个答案，所以两条路殊途同归。

### tcctest.c 读完了

这一片之后 **tcctest.c 整份（4500 行）编得过了** —— 前沿从「第几行读不下去」变成了
「跑出来的数对不对」。量出来的样子：

- 输出的**前 44 行与 `tcc -run` 逐字**一致。
- 第 45 行分岔：`qq=42` vs `qq=2`（tcctest.c:263，`printf("qq=%d\n", qq(qq)(2));`），
  再往后 `rm_field`（tcctest.c:331-335，`#define rm_field (G.rm_field)`）也不对。
  两处是同一件事：**宏在自己的展开里不再展开**（C11 6.10.3.4 第 2 段，
  俗称「刷蓝漆」）。我们那台预处理器现在会把 `rm_field` 在 `(G.rm_field)` 里再展开一次。
- 再往后我们死在自家 libc 上：`printf` 不认识 `%C`（宽字符）。

### 量出来的数

- `tests/c/gen/75-cond-ptr.c`（tcctest.c 那四行的等价物 + 空指针常量的三种写法各在两边 /
  `void *` 优先 / 限定符并起来 / 结果指针的步长 / 长度未定的数组补长度 / 两支同类型）：
  与 `tcc -run` 逐字节一致。量到的：`g 28` / `n 9 9 9 9` / `v 7 7` / `q x a` /
  `s 30 4` / `a 20 20` / `p 10 20`。
- `tests/c/run.js`：**116 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。

### 下一片

第八刀第五十六片：**宏不自我展开**（「刷蓝漆」，C11 6.10.3.4 第 2 段）。

```c
#define rm_field (G.rm_field)     /* 里面那个 rm_field 是**普通标识符**，不再展开 */
#define qq(x) x                   /* qq(qq)(2) 展开成 qq(2)，而那个 qq 也不再展开 */
```

tcc 的做法在 `macro_subst` 里：展开一个宏时把它自己**标成正在展开**（`s->v` 挂进
`macro_stack` / `nested_list`），里面再见到同名就当普通标识符抄过去。我们那台
预处理器已经有 `macroFrames`（`__VA_ARGS__` 与参数替换用的），这一片是让它在
「这个名字现在能不能展开」这一问上也起作用。

再之后：`printf` 的 `%C`/`%S`、枚举的底层类型、`-dM`、路径 A 的 GLR 与路径 B 对账
（第七步）、第 9-11 步的后端。

<!-- 第八刀第五十五片-END -->

## 落地：第八刀第五十六片

**实参里的宏不许吃外面的记号流**（tcctest.c:262，注释就写着 "should not eat stream"）。

```c
int qq(int x) { return x + 40; }
#define qq(x) x
printf("qq=%d\n", qq(qq)(2));     /* tcc: 42。我们原先给的是 2 */
```

`qq(qq)` 的实参是 `qq`，而实参在代进宏体之前要**先整个展开一遍**。展开时见到 `qq` ——
一个函数式宏名 —— 就得预看下一个非空白记号是不是 `(`。那个 `(` 在**实参之外**
（是 `(2)` 的那一个），所以必须看不到；看到了就会把 `(2)` 当成 `qq` 的实参吃掉，
于是 `qq(qq)(2)` 变成 `2` 而不是「函数 qq 调用 2」。

上一片写 ADR 时把这一格记成「宏不自我展开（刷蓝漆）」，量下来不是：刷蓝漆那一套
（`nested.list` + `SYM_FIELD` 的印）第二十片就有了，而且是对的。真正缺的是**实参串的收尾**：

tcc 的每个实参记号串以 **`TOK_EOF`** 结尾（`macro_arg_subst` 里到处是
`while (*st != TOK_EOF)`），而 `next_argstream` 的内层循环只在**真的 0** 上退出去下一层。
于是预看落在 `TOK_EOF` 上、`!= '('`、那个宏名原样留下 —— 一个哨兵就把「实参的边界」
钉住了，不需要额外的状态。我们的实参串原先什么都不加，预看就一路穿到文件上。

顺带两处跟着这个哨兵走：
- 「实参是不是空的」不再是 `len() === 0`（现在空实参的串里有一个 TOK_EOF），
  单独一个 `argEmpty`；`##` 两侧的占位与 `, ## __VA_ARGS__` 吃逗号都靠它。
- 展开过的那一份（`a.expanded`）也补上 TOK_EOF（tcc 的 `tok_str_add(&str2, TOK_EOF)`），
  于是嵌套的实参展开（`F(F(qq))(4)`）在每一层上都停得住。

### 量出来的数

- `tests/c/gen/76-macro-arg-stream.c`（`qq(qq)(2)` / `F(qq)(3)` / 两层 `F(F(qq))(4)` /
  宏与同名函数（`#define add(a,b) add((a),(b))`）/ 空实参 / `#` 字符串化 / `##` 粘贴 /
  `, ## __VA_ARGS__` / 实参里的宏名后面**真的**跟着 `(` 的那一种）：与 `tcc -run`
  逐字节一致。量到的：`qq=42 3` / `w=4` / `add=5` / `s=[qq(1)] [] [a b]` / `j=12 7` /
  `va` / `va 7 8` / `g=3` / `e=9` / `c=5`。
- `tests/c/run.js`：**117 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- tcctest.c 的输出：`qq=42` 那一行对上了，前 57 行与 `tcc -run` 逐字一致。

### 下一片

第八刀第五十七片：**块作用域的 `static`**。tcctest.c 剩下那三行不对的
（`rm_field = 66008`）追下来是这个：

```c
void f(void) { static int n; n++; printf("n %d\n", n); }
f(); f(); f();          /* tcc: 1 2 3。我们给的是 1 1 1 */
```

函数里的 `static` 我们现在**当普通局部量处理** —— 存储期错了（每次调用重新开始），
而且它静悄悄地错：tcctest 里那个 `static struct { int rm_field; } G;` 读到的是上一次
调用留在帧上的垃圾，正好是个地址，于是印出 66008。

真做法是照 tcc 的 `decl_initializer_alloc`：块里带 `static` 的变量走的是**全局那一路**
（data 段划地方、初始化式当静态初始化式算），只是名字只在这一层可见 —— 也就是
`decl` 里那个 `global ? declareGlobal : declareLocal` 的判据要从「在哪一层」
改成「有没有 `static`」，而 data 段里的名字要带上函数名以免两个函数里的同名 static 撞车。

再之后：`printf` 的 `%C`/`%S`、枚举的底层类型、`-dM`、路径 A 的 GLR 与路径 B 对账
（第七步）、第 9-11 步的后端。

<!-- 第八刀第五十六片-END -->

## 落地：第八刀第五十七片

**块作用域的 `static`**（以及块里的 `extern`）。

```c
void f(void) { static int n; n++; printf("n %d\n", n); }
f(); f(); f();      /* 1 2 3 —— 我们原先给的是 1 1 1 */
```

函数里的 `static` 我们**一直当普通局部量处理**：`decl` 里那句
`global ? declareGlobal : declareLocal` 只问「在哪一层」，不问「有没有 static」。
于是存储期错了（每次调用重新开始），而且它**静悄悄地错** —— tcctest 里那个
`static struct { int rm_field; } G;` 读到的是上一次调用留在帧上的垃圾，正好是个地址，
所以印出 `rm_field = 66008`。上一片的 ADR 把这一格误判成「宏自我展开」，是这一片纠回来的。

### 「往哪儿落地」从两种变成四种

- 文件作用域 -> `declareGlobal`（原样）
- 块里带 `static` -> **data 段**，名字只在这一层可见（`declareStaticLocal`）
- 块里带 `extern` -> 说的是文件作用域那个对象（C11 6.2.2 第 4 段），
  查/建同一条全局登记（`declareExternLocal`）
- 其余 -> `declareLocal`（原样）

后两种在作用域里压的是一条**转手**登记（`{ gvar: 那条全局登记 }`），`entryLval` 见到它就
去问 `gvarLval` —— 于是「名字的可见范围」与「东西住在哪儿」这两件事各归各管。
初始化式也跟着走静态那一路（`dest.stat`），所以 `static int t[3] = {1,2};` 是 data 段里
铺好的字节，不是每次进函数再写一遍。

### data 段里的名字要加料，而序号必须两遍数出来一样

两个函数里各有一个 `static int n;` 是**两个**对象；同一个函数里两层块各有一个同名的
也是两个。所以 data 段里的键是「函数名 + 变量名 + 这个函数里的第几条 static」。

那个序号在两遍里必须数出来一样（偏离 4：函数体解析两遍），不然第二遍会再划一块地方 ——
`staticNo` 跟 `stmtNo` 一样在 `runBody` 里归零，于是第二遍找到的正是第一遍划的那块。
这是「函数体解析两遍」第四次要人当心，而这次的形状与前几次都不同：不是槽号、不是段数，
而是**data 段的地址**。

还有一格是这个两遍带出来的：第二遍见到的是同一条声明，但**类型对象是新的**（函数体里写的
匿名 struct 每遍各造一个 tag 对象）。所以第二遍不能走 `declareGlobal` 那条「合并两条同名
声明」的路 —— 那条路比的是 tag 对象的引用相等，会把它判成
`incompatible types for redefinition`。地址留着、类型换成这一遍的那份。

### 量出来的数

- `tests/c/gen/77-static-local.c`（计数器 / 带初始化式 / 两个函数里的同名 static /
  同一函数里两层块的同名 static / 字符串与数组与指针的静态初始化式 /
  `static int *q = &v;`（另一个 static 的地址当常量用）/ 块里的 `extern` /
  循环里的 static 只初始化一次）：与 `tcc -run` 逐字节一致。
  量到的：`n 1 2 3` / `i 12 14` / `t1 1 2` / `t2 0` / `b1 101` `b2 201` `b1 102` `b2 202` /
  `a bb 1 5 3 xy` / `a cb 1 10 3 xy` / `p 4 4` / `p 5 5` / `e 7 8` / `l 6 7 8`。
- `tests/c/run.js`：**118 passed, 0 failed**。`tests/run.js`：**96 passed, 0 failed**。
- 自举那一条重量一遍：`tcc.c` -> 与本机 tcc 编的逐字节 **IDENTICAL**。
- tcctest.c 的输出：**前 66 行（也就是我们跑到的每一行）与 `tcc -run` 逐字一致**。

### 下一片

第八刀第五十八片：**`printf` 的 `%C` 与 `%S`**（宽字符）。tcctest.c 现在死在这儿：

```
omni: runtime error: printf: 不认识的转换 '%C'
```

出处是 tcctest 的宽字符那一段（`wc=a 0x1234 c`）。`%C` 等价于 `%lc`、`%S` 等价于 `%ls`，
而我们的 `wchar_t` 是 4 字节的 `int`（第八刀里量过），所以这一片是 cFormat 那张表上
两格 + 「一个 wchar 怎么变成字节」这一问（tcc 那边交给宿主 libc，我们自己写，
所以要把 UTF-32 -> UTF-8 那一步补上）。

再之后：枚举的底层类型、`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、
第 9-11 步的后端。

<!-- 第八刀第五十七片-END -->

## 落地：第八刀第五十八片

**`printf` 的 `%C` 与 `%S`。**改的是 `src/core/interp/libc.js` 一处（`cFormat` 那张
转换表），加的用例是 `tests/c/gen/78-wide-printf.c`。

### 一、`%C` 就是 `%lc`，`%S` 就是 `%ls`

这两格不在 C 标准里，是旧 Unix 留下来的写法，`tcctest.c` 的 `string_test` 在用。所以
判断是「`conv` 是大写的那一个」**或者**「长度修饰符里出现过 `l`」——

```js
if (conv === 'C' || bits === 64) { … }
```

`bits` 这个量本来只用来选整数宽度（32 还是 64），在这儿被借去当「宽不宽」的旗子：
`l` 在 `%d` 上是「64 位」，在 `%c`/`%s` 上是「宽的」，同一个字母两个意思，而这一层
恰好只有这两种用法，所以不必再加一个量。

### 二、一个 `wchar_t` 怎么变成字节

真的 libc 在这儿调 `wcrtomb`，按当前区域设置把宽字符编码出去。我们没有区域设置这一
套，也不需要 —— 这个目标上宽字符就是 Unicode 码点，所以写死 UTF-8：

```js
function utf8Of(cp) {
  if (cp < 0 || cp > 0x10ffff) throw new Error(`printf: 宽字符 ${cp} 不是码点`);
  if (cp < 0x80) return String.fromCharCode(cp);
  …
}
```

回的是「一个字符一个字节」的 JS 字符串 —— `cFormat` 全程用这个约定攒 `out`
（`readCStr` 也是这个约定），所以宽的那一支摊完就能直接跟窄的那一支拼起来，
`padTo` 数的宽度自然也是**字节数**，与宿主 libc 一致（`%5S` 配 `L"ab"` 补三个空格）。

宽字符串那一侧要一个「四个字节一格」的读法：

```js
const w = Number(memLoad('i32s', p, 0));
```

`i32s` 而不是 `i32` —— `MEM_LD` 那张表里读的那一半是按「带不带符号」分的
（`i32s`/`i32u`），只有写的那一半叫 `i32`。第一次写成 `i32` 时报的是
`printf: memLoadFn: 不认识的访问 i32`，查表查空。

精度那一格照 C11 7.21.6.1 第 8 段：`%.2S` 限的是**字节数**，而且不许把一个字符切成
两半，所以一个字符一个字符地攒、够不下就停：

```js
if (limit !== undefined && limit >= 0 && s.length + b.length > limit) break;
```

### 三、非 ASCII 那一格对不了账，所以用例不碰

`tcctest.c` 里印的宽字符全是 ASCII（`printf("wc=%C 0x%lx %C\n", L'a', L'\x1234', L'c')`
中间那个 0x1234 被 `%lx` 吃掉了，没走 `%C`）。这不是巧合：宿主 libc 在 `"C"`
区域设置下把 >127 的宽字符当成非法序列，整个 `printf` 调用直接失败，**一个字节都不印**
—— macOS 那份实现是先把宽串整个转成多字节缓冲再算长度，转不动就 `goto error`，而那时
`"wstring="` 还在 iovec 里没冲出去。所以「非 ASCII 的宽字符印成什么」在 oracle 那边
根本不是「印成 UTF-8」，而是「什么都不印」，那是宿主区域设置的行为、不是 tcc 的行为，
对账没有意义。用例只印 ASCII。

同一条也解释了 `tcctest.c` 为什么把 `%S` 那两行关在 `#if 0` 里：

```c
    printf("wstring=%S\n", L"abc" L"def" "ghi");
```

`L"abc" L"def" "ghi"` 在 tcc 那儿是**按字节接**的，问出来的宽字符是
`a b c d e f 0x00696867` —— 最后那一格是窄串 `"ghi\0"` 的四个字节被当成一个 wchar
读了，0x696867 比 0x10FFFF 大，于是那一行整行消失。我们这儿「宽窄字面量混着拼」
仍是一条明着报错的边界（`readWStrTok`），而 `utf8Of` 对超出码点范围的值也是明着抛
—— 两处都不会静悄悄给个错答案。

### 四、这一片把 tcctest.c 的对账面从 66 行推到 843 行

上一片停在第 66 行，是因为我们自己的 libc 抛了 `不认识的转换 '%C'`。补上之后整份
`tcctest.c` 一路跑到 `alloca_test`，我们印出 843 行、tcc 印出 1011 行，中间只有
六处不一样。这份清单就是接下来几片的地图：

- `sizeof1 = 8` / `sizeof2 = 8`，tcc 是 `1` —— `sizeof` 一个函数（`funcptr_test`
  是个函数名，不是指针）。tcc 给函数类型的 size 是 1。
- `enum large: 0`，tcc 是 `263882790666240` —— 枚举的底层类型（第五十四片就欠着的
  那一笔），值超出 int 时 tcc 把枚举撑到 64 位。
- `aligntest9 sizeof=16 alignof=8`，tcc 是 `12` / `4` —— `packed` 与
  `aligned` 撞在一起时谁说了算。
- `promote char/short funcret` 与 `… VA` 两行 —— 返回 `char`/`short` 的函数，回来那一
  格没按窄类型截。
- `cix2: 2 4006` 与 `arrtype3: 4 4005 4006` —— 复合字面量/数组类型那一段的两处。
- 然后死在 `interp: C ABI call 'alloca' is not supported by the interpreter`。

三条对账链都在：`node tests/c/run.js` 119 过 0 挂（新的 78 那条与 tcc 逐字节一样），
`node tests/run.js` 96 过 0 挂，自举编译出来的 `tcc2` 与 tcc 自己编的仍然逐字节相同。

**下一片**：`sizeof` 一个函数是 1（清单里最短的一条），顺手把返回 `char`/`short` 的
函数那两行一起看 —— 它们都在「函数类型这一格上我们比 tcc 多想了一步」这条线上。

再之后：枚举的底层类型、`alloca`、`packed` 撞 `aligned`、`-dM`、路径 A 的 GLR 与
路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第五十八片-END -->

## 落地：第八刀第五十九片

**函数类型的 `sizeof` 是 1，窄返回类型由调用方截一刀。**两处都是「函数这一格上我们比
tcc 多想了一步」：改的是 `ctype.js` 的 `typeSize` 一行与 `tccgen.js` 的
`funcCall`/`indirectCall` 收尾，用例是 `tests/c/gen/79-funcsize-retnarrow.c`。

### 一、`sizeof` 一个函数是 1，不是 8

我们原来写的是 `if (b === VT_FUNC) return { size: 8, align: 8 };`，注释是「函数指针」——
那句注释就是错处：`VT_FUNC` 是**函数**，指针是 `VT_PTR`。tcc 的 `type_size`
（`tccgen.c:3494`）最后那一支把四种东西归成一格，注释原话是
`/* char, void, function, _Bool */`，`*a = 1; return 1;`。gcc 也是 1。

平时看不出来，因为函数名在表达式里立刻退化成指针；只有「不求值」的地方能问到函数类型
本身 —— `sizeof f`、`sizeof(fn_t)`、`sizeof(*fp)`、`__alignof__`。tcctest.c 的
`funcptr_test` 恰好逐个问了一遍。

### 二、`char`/`short`/`_Bool` 的返回值，**调用方**再截一刀

tcc 在调用点这么写（`tccgen.c:6372-6379`）：

```c
    t = s->type.t & VT_BTYPE;
    if (t == VT_BYTE || t == VT_SHORT || t == VT_BOOL) {
#ifdef PROMOTE_RET
        vtop->r |= BFVAL(VT_MUSTCAST, 1);
```

`PROMOTE_RET` 在 arm64/x86_64/i386/riscv64 上全开着。兑现在 `force_charshort_cast`
（`tccgen.c:3236`）：把源类型当 `int`、往声明的窄类型上转一次。

被调的那一侧如果也是它编的，`return` 那一步早就截过了，这一刀白挨。露出来的是**函数
指针的类型与真实函数不符**那一种，tcctest.c 拿 `csf` 专门造了这个局面：

```c
static int __csf(int x) { return x; }
static void *_csf = __csf;
#define csf(t,n) ((t(*)(int))_csf)(n)
```

`__csf` 老老实实回一个 `int`，调用点却说「这个函数回 `unsigned char`」。寄存器里躺着
32 位，谁负责截由 ABI 说了算 —— tcc 说调用方，所以 `csf(unsigned char, 0x89898989)`
是 **137**。我们原来直接把那个 ref 贴上 `unsigned char` 的类型牌子就走，于是印出
`-1987475063`（就是 0x89898989 当 int 看）。

我们这一侧只加了一个 `retNarrow`：

```js
  retNarrow(ret, r) {
    const b = btype(ret.t);
    if (b !== VT_BYTE && b !== VT_SHORT && b !== VT_BOOL) return sVal(ret, r);
    const nt = b === VT_BOOL ? TY_UCHAR
      : ctype(ret.t & (VT_BTYPE | VT_UNSIGNED | VT_DEFSIGN), null);
    return sVal(ret, this.gv(this.castTo(sVal(TY_INT, r), nt)));
  }
```

关键是 `sVal(TY_INT, r)`：**先把回来的那一格当 int**，再往窄类型转 —— 直接
`castTo(sVal(ret, r), ret)` 是个空操作，什么都不会发生。

`_Bool` 那一格照 `force_charshort_cast` 里那句
`gen_cast_s(dbt == VT_BOOL ? VT_BYTE|VT_UNSIGNED : dbt)`：按**无符号 char** 截，
不是「非零就是 1」。所以 `csf(_Bool, 0x33221100)` 是 0、`csf(_Bool, 0x33221101)` 是 1
—— 按 `!= 0` 算的话两个都会是 1，而 tcc 印的是 `0 1`。这一格是这一片里唯一一处
「看着该用现成的 `_Bool` 转换、其实不能用」的地方。

`tests/c/run.js` 120 过 0 挂，`tests/run.js` 96 过 0 挂，tcctest.c 的差异清单从六处
减到四处（`sizeof1`/`sizeof2` 与 `promote char/short funcret` 那两行同时没了）。

<!-- 第八刀第五十九片-END -->

## 落地：第八刀第六十片

**枚举的底层整型。**这是第五十四片欠下的那一笔：那时 `__builtin_types_compatible_p`
上钉了一条「只有一边是枚举就报错」的边界，理由是「我们的枚举底层永远是 int」。现在
它是算出来的，那条边界跟着拆了。改的是 `ctype.js` 的 `enumBase`/`mkEnum` 与
`tccgen.js` 的 `enumDecl`，用例是 `tests/c/gen/80-enum-base.c`。

### 一、三句话（`tccgen.c:4555-4562`）

```c
    t.t = VT_INT;
    if (nl >= 0) {
        if (pl != (unsigned)pl)
            t.t = (LONG_SIZE==8 ? VT_LLONG|VT_LONG : VT_LLONG);
        t.t |= VT_UNSIGNED;
    } else if (pl != (int)pl || nl != (int)nl)
        t.t = (LONG_SIZE==8 ? VT_LLONG|VT_LONG : VT_LLONG);
```

`nl` 是最小值、`pl` 是最大值，两个都**从 0 起算**。于是：

- 没有负的枚举值 —— 整个枚举是**无符号**的。C11 6.7.2.2 只说「能装下全部值的某个
  整型」，谁来定没写，所以这是 tcc（跟 gcc）的选择，不是标准的要求；
- 全非负而最大的装不进 `unsigned int` —— `unsigned long long`；
- 有负的、而两头有一个装不进 `int` —— `long long`。

`enum { EL_large = ((unsigned long)0xf000 << 31) << 1 }` 于是是 8 个字节，
`printf("%ld", EL_large)` 印 263882790666240。我们原来在读枚举值时就
`BigInt.asIntN(32, val)`，那个数被截成 0 —— tcctest.c 里 `enum large: 0` 就是这么来的。
现在收成 64 位（tcc 的 `expr_const64`），宽度由 `enumBase` 一处定。

### 二、枚举常量**自己**的类型与枚举的底层类型不是一回事

`tccgen.c:4564-4576` 单独走了一遍那条链：

```c
    for (ss = s->next; ss; ss = ss->next) {
        ll = ss->enum_val;
        if (ll == (int)ll) continue;          /* 装得进 int 就是 int */
        if (t.t & VT_UNSIGNED) {
            ss->type.t |= VT_UNSIGNED;
            if (ll == (unsigned)ll) continue;
        }
        ss->type.t = (ss->type.t & ~VT_BTYPE) | VT_LLONG|VT_LONG;
    }
```

也就是说：`enum EA { A0, A1 = 3 }` 整体是 `unsigned int`，但 `A1` 这个常量的类型是
**`int`**（装得进 int 就不动它），哪怕枚举是无符号的。这一条不是可有可无的细节 ——
`printf("%d", A1)` 与 `A1 < 0` 都要靠它。

结构上的代价是：枚举常量的类型**要等读完 `}` 才定得下来**，而枚举常量在 `}` 之前就得
可见（`enum {A, B = A + 2}`）。tcc 的办法是先按 int 登记、读完回头改整条链，我们照做：
`this.ecScope().set(en, { ty, val })` 先放，`}` 之后再遍历 `names` 把每条的 `ty` 换掉。

### 三、底层类型挂在 tag 上，不挂在类型对象上

`enum ELong` 这个名字后面还会被再写一次（`enum ELong x;`），那时走的是 `mkEnum(info)`
另造一个类型对象。所以算出来的那几位必须存在**共享的那一头**（`info.bt`），
`mkEnum` 从它取：

```js
export function mkEnum(info) {
  return ctype((info.bt === undefined ? VT_INT : info.bt) | VT_ENUM, info);
}
```

`compareTypes` 那一侧一个字都不用改 —— 它第一段就把枚举换成 `a.t & ~VT_STRUCT_MASK`，
而那份位里现在带着 `VT_UNSIGNED` 与真的宽度，于是「全非负的枚举」与 `unsigned int`
自然相容、与 `int` 自然不相容。第五十四片那条边界因此可以直接删掉。

`tests/c/run.js` 121 过 0 挂，`tests/run.js` 96 过 0 挂。tcctest.c 只剩三处不一样：

- `aligntest9 sizeof=16 alignof=8`，tcc 是 `12` / `4` —— `packed` 与 `aligned` 撞在
  一起时谁说了算；
- `cix2: 2 4006`，tcc 是 `3003 4006`；
- `arrtype3: 4 4005 4006`，tcc 是 `4 0 0`。

然后死在 `alloca`。

**下一片**：`aligntest9` 那一格（`packed` 撞 `aligned`）。再之后：`cix2` / `arrtype3`
那两处、`alloca`、`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第六十片-END -->

## 落地：第八刀第六十一片

**typedef 上的 `aligned(N)`。**`tcctest.c` 的 `aligntest9` 就一句：

```c
typedef unsigned long long __attribute__((aligned(4))) unaligned_u64;
struct aligntest9 { unsigned int buf_nr; unaligned_u64 start_lba; };
```

sizeof 是 12、alignof 是 4（不是 16 / 8）—— 那个 `aligned(4)` 把 `unsigned long long`
的对齐**降**到了 4。我们原来把它读掉就扔了。改的是 `tccgen.js` 两处，用例是
`tests/c/gen/81-typedef-aligned.c`。

### 一、属性跟着**名字**走，不跟着类型走

tcc 在登记 typedef 那一步 `sym->a = ad.a`（`tccgen.c:8926`），用到这个名字时
`sym_to_attr(ad, s)`（`tccgen.c:4970`）把它并回当前这一份 `ad`。并的规则是
`merge_symattr`（`tccgen.c:1177`）：

```c
    if (sa1->aligned && !sa->aligned)
      sa->aligned = sa1->aligned;
```

**当前没写才用 typedef 那一份** —— 所以 `unaligned_u64 v __attribute__((aligned(8)));`
是 8，成员自己写的赢。

我们的 typedef 表存的是类型对象，所以那个数就挂在类型对象上（`talign`），与 `count`
同一个位置、同一种带法（`count` 也是「在 `t` 那串位里放不下、只能挂在对象上」的东西）。
`parseBtype` 用到 typedef 名时照 `merge_symattr` 那一句并进 `ad`，并且把 `talign`
继续往下带 —— 于是 `typedef unaligned_u64 chained_u64;` 接一层也还在（tcc 那边是因为
新 typedef 的 `ad` 已经从旧的那条并到了这个值，同一个效果）。

### 二、成员的对齐是**覆盖**，不是取大

`structLayout` 里那一句早就写对了：

```js
      if (a !== 0) align = a;
```

照的是 `tccgen.c:4235` 的 `if (a) align = a;`。这一格要是写成 `Math.max` ——
一个看着更「安全」的写法 —— `aligned(4)` 就永远降不下来，而 gcc/tcc 都允许降。
第三十四片当时抄对了，这一片只是把那个数真的送到它手上。

顺带量了 `aligned(16)` 加在 `int` 的 typedef 上（`struct D { char c; overaligned_int i; }`
的 sizeof 是 32、alignof 是 16）与全局量上的那一份，都与 oracle 逐字节一样。

`tests/c/run.js` 122 过 0 挂，`tests/run.js` 96 过 0 挂，tcctest.c 只剩两处不一样。

<!-- 第八刀第六十一片-END -->

## 落地：第八刀第六十二片

**柔性数组成员配初始化式：`sizeof` 不变，但那块地方要真的够大。**这一片修的是一个
**静悄悄踩别人内存**的错，症状离原因很远：

```
cix2: 2 4006          （tcc: 3003 4006）
arrtype3: 4 4005 4006 （tcc: 4 0 0）
```

`arrtype3` 那一行印的 `4005 4006` 是 `cix22` 的初始化式 —— 也就是说 `sinit21` 与
`cix22` 压在同一段字节上。`cix22` 是这个：

```c
struct complexinit2 { int a; int b[]; };
struct complexinit2 cix22 = { .a = 4000, .b = { 4001, 4002, 4003, 4004, 4005, 4006 } };
```

`sizeof(struct complexinit2)` 是 4（柔性成员占 0 个字节，第四十三片量过），我们照 4
个字节划地方，然后初始化式往后写了 24 个字节 —— 邻居的地盘。

### 一、tcc 怎么分这两件事

`decl_initializer_alloc`（`tccgen.c:8290-8340`）：struct 的最后一个成员是柔性数组时把
`size` 置成 -1，逼出「先干跑一遍」那条路（那条路本来是给 `int a[] = {…}` 的）；干跑
完了：

```c
        if (flexible_array && flexible_array->type.ref->c > 0)
            size += flexible_array->type.ref->c
                    * pointed_size(&flexible_array->type);
```

`size` 变大，但**类型没变** —— `sizeof` 还是 4。跑完还要把那个格数改回 -1
（`tccgen.c:8503`），好让下一条同样的声明重新算。

### 二、我们量的是「碰到的最大字节偏移」

`flexInit` 收下那一对花括号、`measureBraced` 放一遍，记的是 `at.off + span` 的最大值，
减去 `sizeof` 就是要多划的字节数。走法与 `countBraced` 是同一份（同一个下降栈、同一个
`initDesignators`、同一条回卷规则），差别只在记什么。这样就不必在类型里存一个「柔性
成员这次有几格」再改回去 —— 少一处会忘记复位的状态。

到底那一格如果是**没写长度的数组**（也就是柔性成员本身），`typeSize` 回 0，量不出东西，
所以那一格自己数：

```js
      if (isArray(at.ty.t) && at.ty.count < 0) {
        const es = typeSize(at.ty.ref).size;
        if (this.tok === LBRACE) span = this.countBraced(at.ty) * es;
        else if (this.tok === TOK_STR) span = (this.readStrTok(this.tokc).length + 1) * es;
        …
```

字符串那一支不是凑数的：`struct T { char c; char s[]; }; struct T t1 = { 'x', "abcdef" };`
在 tcc 那边划 8 个字节，我们量出来也是 8。

### 三、多出来的那几个字节走 `extra`，不进类型

`declareGlobal` / `declareStaticLocal` / `declareLocal` 各多一个 `extra`，落到
`allocGlobal` 与 `frameAlloc` 那两处加法上。**不**去改类型的 count —— 改了 `sizeof`
就跟着变，而 tcc 的 `sizeof cix21` 是 4。自动那一侧的整块清零也要按 `size + extra`
来（不然柔性那一段是上一轮的垃圾）。

局部量那一种也顺手做了（`struct S l = { .a = 1, .b = {11,12,13,14} };`），因为
`frameAlloc` 与 `allocGlobal` 是同一个形状，多一个参数而已。

### 四、tcctest.c 的输出到此**全对**

`tests/c/run.js` 123 过 0 挂，`tests/run.js` 96 过 0 挂。tcctest.c 我们印出来的 842 行
与 tcc 印的**逐字节相同**，第 843 行停在同一个地方：

```
omni: runtime error: interp: C ABI call 'alloca' is not supported by the interpreter
```

**下一片**：`alloca`。它在我们这儿不是「一个没实现的 libc 函数」—— 变长数组那一片
（第四十九片）已经把「在 `$sp` 上切一刀」这件事做好了，`alloca` 就是把那一刀交给
一个函数调用，难点在**它切出来的那一块什么时候还**（tcc 的 `alloca` 是「函数返回才还」，
而 VLA 是「出作用域就还」）。

再之后：`-dM`、路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第六十二片-END -->

## 落地：第八刀第六十三片

**`alloca`。**改的是 `tccgen.js` 两处（`funcCall` 头上一个拦子、一个 `allocaCall`），
用例是 `tests/c/gen/83-alloca.c`。

### 一、它在 tcc 那边是个真函数，在我们这边只能是编译期的一刀

tcc 的 `alloca` 来自它自己的运行时库（`lib/alloca.S`，arm64 上就是一句 `sub sp`），
编译器里只在边界检查那一路特判它（`tccgen.c:1701`：`func_bound_add_epilog = 1`）。
我们没有 FFI（ADR-0014 决策 4：解释执行是 oracle，它不该假装能做 FFI），所以只能在
前端把它编开 —— 编成的东西与变长数组（第四十九片）**是同一刀**：

```js
    const sp = f.emit(OP.GLOAD, T_I64, REF_NONE, REF_NONE, spNo);
    const base = f.emit(OP.BAND, T_I64, f.emit(OP.SUB, T_I64, sp, this.gv(n), 0),
      this.mod.consts.int(-16n), 0);
    f.emit(OP.GSTORE, T_VOID, base, REF_NONE, spNo);
```

`vlaAlloc` 比它多一步：把切之前的 `$sp` 存进一个槽，好让 `popScope` 写回。alloca
没有那一步 —— **没人要把它还回来**，那块地方活到函数返回。

### 二、「活到函数返回」这一条靠 `vlaSeen` 兑现

函数收场那一条（`emitEpilogue`）只在 `frameSize > 0` 时才发，而 `char *p = alloca(16);`
这种函数的帧可能一格都不用。第四十九片为变长数组立过一条规矩：

```js
    if (this.vlaSeen && est === 0) est = FRAME_ALIGN;
```

alloca 直接借这一条（`this.vlaSeen = true`）—— 理由一字不改：那块地方是运行期从 `$sp`
上切的，不在返回前把 `$sp` 还回去，递归一圈就把栈走穿了。用例里 `rec(20)` 与随后的
`rec(5)` 就是问这个：两次调用切的是同一段地址，答案分别是 210 与 15。

### 三、拦名字，但让位给真的定义

`if (name === 'alloca' || name === '__builtin_alloca')` 之后还要问一句
`hit === undefined || !hit.defined` —— 这个单元里真的定义了一个叫 `alloca` 的函数时
不拦。tcc 那边天然如此（它就是个普通符号，谁定义了就用谁），我们靠这一句追上。

### 四、一个作用域里 VLA 与 alloca 撞上时，alloca 那块会被提前收走

作用域退出发的是 `spRestore(cur.sp)`，而 `cur.sp` 存的是**这个作用域里第一个 VLA
之前**的 `$sp` —— 在它之后 alloca 切的那些块也就一起还了。这不是我们的取舍：tcc 的
`gen_vla_sp_restore(cur_scope->vla.locorig)` 是同一个效果。

### 五、对账方式从这一片起变了：不再每片跑整份 tcctest

补上 alloca 之后 tcctest.c 不再停在第 843 行，而我们的解释器跑它**每 20 秒大约 630
行** —— 整份跑完加上 oracle 那一遍已经超出一次命令的窗口。所以从这一片起，
每片的对账是「新加的那个 `tests/c/gen/*.c` 与 `tcc -run` 逐字节相同」加上两条测试链，
整份 tcctest 的差异清单改成攒几片量一次。

`tests/c/run.js` 124 过 0 挂，`tests/run.js` 96 过 0 挂，83 那条与 oracle 逐字节相同。

**下一片**：解释器的速度（每 20 秒 630 行这件事本身现在是路上的石头），或者 `-dM`。
再之后：路径 A 的 GLR 与路径 B 对账（第七步）、第 9-11 步的后端。

<!-- 第八刀第六十三片-END -->

## 落地：第九刀第一片

**arm64 指令编码器的第一批。**新文件两个：`src/core/arm64/encode.js`（编码）与
`tests/arm64/run.js`（对账）。96 条用例，与 llvm 逐条相同。

到这一刀为止，前八刀做的是**前端**（C 源码 -> MIR -> 解释执行），借 tinycc 自举那件事
证明的也只是前端与它逐字节一致 —— **后端一行还没有**。这一刀开始补：先把「一条指令
怎么变成四个字节」这件事做实，代码生成器（第 10 步）、目标文件与链接（第 11 步）才有
地方落。

### 一、这一层只回一个 32 位的字

不管符号、不管重定位、不管往哪儿写。函数签名一律是「字段进、字 出」：

```js
export const addImm = (sf, rd, rn, imm12, sh = 0) => addSubImm(sf, 0, 0, sh, imm12, rn, rd);
```

字段的位置照 ARM DDI 0487 的 C4.1（"A64 instruction set encoding"）。**不抄 tcc 的
`arm64-gen.c`**（ADR-0017 的规矩：行为复刻、代码自写）—— tcc 那边是一条条
`o(0x91000000 | ...)` 的立即数，我们把每一族的字段拆开写成一个私有函数，别名
（`cmp`/`mov`/`neg`/`tst`/`mul`/`cset`）都落在它上面。这一批 40 个导出：

- 立即数运算：`add/adds/sub/subs`（含 `lsl #12` 那一档）、`cmp`/`cmn`/`movSp`
- 搬立即数：`movz`/`movk`/`movn`（四个 hw）
- 寄存器运算：`add/sub` 与 `and/orr/eor/ands/bic` 的移位寄存器版、`neg`/`tst`/`mov`/`mvn`
- 乘除变位：`madd`/`msub`/`mul`/`udiv`/`sdiv`/`lslv`/`lsrv`/`asrv`
- 条件选择：`csel`/`csinc`/`cset`
- 取地址：`adr`/`adrp`
- 存取：缩放无符号偏移（`ldr/str/ldrb/ldrh/ldrsb/ldrsh/ldrsw`）、9 位有符号的
  `ldur/stur` 与前后变址、寄存器偏移、成对的 `stp/ldp`（含 `[sp, #-16]!`）
- 跳转：`b`/`bl`/`b.cond`/`cbz`/`cbnz`/`br`/`blr`/`ret`/`nop`

### 二、移位一律用 `* 2 ** n`，不用 `<<`

`1 << 31` 在 JS 里是 **-2147483648**，而我们要的是那个无符号的数。位域拼装全程用
加法与乘法，最后过一道 `x >>> 0`。这一条不是洁癖：`sf * 2 ** 31 + ...` 与
`sf << 31 | ...` 在 `sf=1` 时差一个符号，而差出来的那个数照样能当「指令」写进文件，
错得无声无息。

### 三、编不下去的当场报，不许悄悄截断

`imm12` 越界、`ldr` 的偏移没对齐、`stp` 的偏移不是 8 的倍数、跳转偏移不是 4 的倍数、
`w` 系 `movz` 的 `hw` 超过 1、寄存器号超过 31 —— 七条都在用例里问过「有没有报」。
理由与前八刀那些「明着报的边界」一样：一个截断过的偏移是一条**能跑但跑错**的指令，
而错的地址在运行期什么都不像。

`ldr` 的偏移这一格还多一句：无符号偏移是**按宽度缩放**过的，所以 `ldrU` 收字节偏移、
自己除，除不尽就报「要走 ldur/stur」—— 这正是调用方接下来该做的事。

### 四、对账：走 obj，不走 `--show-encoding`

一开始用的是 `llvm-mc --show-encoding`，跳转那一族印出来是
`[0bAAA00000,A,A,0x54]` —— 它不落实 fixup。改成
`llvm-mc -filetype=obj` 再 `llvm-objdump -d`，`b . + 8` 就变成了实数 `14000002`。

剩下一格例外是 **`adrp`**：写成 `. + 4096` 的话 obj 里留的是 `ARM64_RELOC_PAGE21`，
那一格要等链接才填，反汇编看见的是 0。所以 `adrp` 用**立即数形式**问
（`adrp x1, #4096`），页数自己写 —— 这一格顺便说明了第 11 步要做的事：
页 21 位与低 12 位那一对重定位，是我们自己的链接器要填的第一种。

`node tests/arm64/run.js`：**96 过 0 挂**。

**下一片**：还差的编码 —— 逻辑立即数（`and x0, x1, #0xff` 那一族的 N/immr/imms
位掩码编码，arm64 最绕的一格）、位段（`ubfm`/`sbfm`，`lsl #n`/`lsr #n`/`asr #n` 与
`sxtb`/`uxth` 都是它的别名）、浮点（`fmov`/`fadd`/`fcvt` 一族与 `scvtf`/`fcvtzs`）、
`extr`、`rev`/`clz`、`ldar`/`stlr`。再之后是第 10 步：MIR -> arm64 的代码生成，
以及在内存里执行（`mmap` + `PROT_EXEC` 那条路在 node 上要另想办法）。

<!-- 第九刀第一片-END -->

## 落地：第九刀第二片

**arm64 编码器的第二批：逻辑立即数、位段、单目位运算、浮点、单向屏障。**
`src/core/arm64/encode.js` 从 40 个导出长到 90 个，`tests/arm64/run.js` 从 96 条
用例长到 200 条（含 17 条「必须报错」的边界）。全部与 llvm 逐条相同。

### 一、逻辑立即数：arm64 最绕的一格

`and x0, x1, #0xff` 的立即数**不是照原样存的**。存的是三件事（N:immr:imms 共 13 位）：
一段连着的 1 有多长、这一段往哪儿转了、按多长的元素重复铺满 64 位。所以：

- `#0xff` 编得下去（e=64，8 个 1，不转）
- `#0xff00ff00ff00ff00` 编得下去（e=16，8 个 1，转 8 位，铺 4 遍）
- `#0x3ff0` 编得下去（e=64，10 个 1，转过 4 位）
- `#0xf000000000000003` 编得下去（6 个 1 **绕过了边界**，两头各一截）
- `#0x1234` 编不下去（1 分成好几段，怎么转都凑不成一段）

`bitmaskImm(sf, value)` 是手册 J1 的 `DecodeBitMasks` 反过来跑：从 e=2 起逐个试
元素长度，先查「每 e 位一个样吗」，再查「元素里是一段 1 转过某个角度吗」。绕过边界
的那种要单独认（低位一截 + 高位一截 + 中间全 0），转角从高位那头数。

**这一格错过一次，是 llvm 抓出来的**：`and x0, x1, #0x8000000000000000` 我们编成
`immr=63`，llvm 说是 `immr=1`。原因是 `immr` 是**右**转的角度（`ROR(welem, R)`），
而我数出来的是「那段 1 从最低位往左挪了多少」—— 两者互为补角，`immr = (e - rot) % e`。
凡是 `rot=0` 或者恰好 `rot = e/2` 的用例都碰巧过了，所以这个错必须靠不对称的用例
（`#1 << 63`、`#-16`、`#0x80000000`）才照得出来 —— 用例的价值全在**不对称**上。

`imms` 的高几位编的是元素长度（e=32 -> `0xxxxx`，e=16 -> `10xxxx`，e=8 -> `110xxx`……），
一句 `(0x7e & ~(2e-1)) & 0x3f` 就够。

顺带删了一句死代码：原来挡了「w 系不许用 N=1」，但 `width=32` 时循环最多试到 e=32，
而 N 只在 e=64 时是 1 —— 这条永远不会触发。

### 二、位段：arm64 根本没有「移位立即数」指令

`lsl x0, x1, #1` 是 `ubfm` 的别名，`asr` 是 `sbfm` 的，`sxtb`/`sxth`/`sxtw` 也是
`sbfm`，`ubfx`/`sbfx`/`bfi` 全是这三条。别名的换算写在导出函数里，`ubfm`/`sbfm`/`bfm`
本身也导出（代码生成器有时要直接用）。

`ubfx`/`sbfx`/`bfi` 多加了一道 `chkField`：段必须在寄存器里放得下、宽度至少 1。
不然 `ubfx w0, w1, #28, #8` 会算出 `imms=35`，`chkU(imms, 6)` 放它过去 —— 编出来是
一条**能跑但取错位**的指令。这是这一层「不许悄悄截断」那条规矩的又一处。

`uxtb`/`uxth` 只有 w 系（x 系那两个写起来是 `and Rd, Rn, #0xff`，因为高 32 位本来
就是 0）—— 这也是上一节那个逻辑立即数编码器的第一个真实用处。

### 三、浮点：`type` 那两位是宽度

单/双精度只差 bit 22，所以所有浮点函数第一个参数是 `dbl`。`fcvt` 是例外：源的宽度
进 `type`、目标的宽度进 `opcode` 的低两位，于是两个方向是两个不同的 opcode
（`fcvtSD` 与 `fcvtDS`）。整数与浮点互转那一族（`scvtf`/`ucvtf`/`fcvtzs`/`fcvtzu`/
`fmov` 的两个方向）有两个宽度要交待：`sf` 说整数那头是 32 还是 64，`dbl` 说浮点那头。
C 的强制转换只用 `fcvtzs`/`fcvtzu`（**向零取整**），别的取整模式暂时不导出。

浮点的存取与整数是同一族，多一个 V 位（bit 26）。

### 四、`ldar`/`stlr`：漏了 bit 23 就变成 `ldxr`

第二个被 llvm 抓出来的错。这两条落在 Load/store exclusive 那一族里，`o2`（bit 23）
是「带 acquire/release 语义」那一格；我只填了 `L` 与几个固定的 `(1)`，编出来是普通的
`ldxr`/`stxr`（独占访问，语义完全是另一件事）。这类错的可怕之处在于**编出来的字是一条
合法指令** —— 没有 oracle 就发现不了。

`dmb ish`/`dsb ish`/`isb` 三条没有可变字段，直接写死那个字。

### 五、这一批的 50 个新导出

- 逻辑立即数：`bitmaskImm`、`andImm`/`orrImm`/`eorImm`/`andsImm`/`tstImm`
- 位段：`sbfm`/`bfmIns`/`ubfm` 与 `lslImm`/`lsrImm`/`asrImm`/`ubfx`/`sbfx`/`bfi`/
  `sxtb`/`sxth`/`sxtw`/`uxtb`/`uxth`
- 取一段：`extr`/`rorImm`
- 单目位运算：`rbit`/`rev16`/`rev`/`rev32`/`clz`/`cls`
- 浮点两目：`fmul`/`fdiv`/`fadd`/`fsub`/`fmax`/`fmin`/`fnmul`
- 浮点单目：`fmovFp`/`fabsFp`/`fneg`/`fsqrt`/`fcvtSD`/`fcvtDS`
- 浮点比较：`fcmp`/`fcmpZero`/`fcmpe`
- 浮点整数互转：`scvtf`/`ucvtf`/`fcvtzs`/`fcvtzu`/`fmovToInt`/`fmovFromInt`
- 浮点存取：`strFpU`/`ldrFpU`
- 屏障：`ldar`/`stlr`/`dmbIsh`/`dsbIsh`/`isb`

`node tests/arm64/run.js`：**200 过 0 挂**（183 条编码 + 17 条边界）。

到这里，MIR 的每一种运算在 arm64 上都有对应的指令可发了 —— 整数五则、移位、比较、
分支、调用、访存、浮点、类型转换。**下一片**是第 10 步的开头：一个能填回填的指令缓冲
（标签、前向跳转的 fixup），然后是 MIR -> arm64 的寄存器分配与发射。第 11 步的
目标文件与链接（`ARM64_RELOC_PAGE21` 那一对）在其后。

<!-- 第九刀第二片-END -->

## 落地：第九刀第三片

**指令缓冲：标签、往前跳的回填、符号记账。**新文件 `src/core/arm64/asm.js`
（`CodeBuf` 与 `RELOC`）。`tests/arm64/run.js` 到 207 条。

### 一、为什么非要这一层

`encode.js` 只把字段变成字，它不知道标签在哪。而一遍过的代码生成器（我们与 tcc 都是
一遍过）发 `if (x) {...}` 的第一条指令时，`b.eq` 的目标地址**还没生出来**。

tcc 的做法是把待填的地址串成一条链表：`gjmp` 返回上一处待填的位置、写在这条指令的
立即数格里，`gsym` 顺着链表走一遍回填（`arm64-gen.c` 的 `gjmp`/`gsym_addr`）。我们
换了个记法 —— 一张 fixup 表，每笔账带一个 `make(off)` 闭包：

```js
toLabel(l, make) {
  const at = this.words.length;
  const target = this.labels[l];
  if (target !== undefined) return this.word(make(target - this.pos));  // 往后跳，当场算
  this.words.push(0);                                                   // 往前跳，先占位
  this.fixups.push({ at, label: l, make });
}
```

**要点是回填时重新调一次编码函数**，而不是去或那几位。这样偏移越界会在回填那一刻从
`encode.js` 里抛出来 —— 而「或几位」的写法会把一个超界的偏移悄悄截断成一条跳到别处的
合法指令。这与前八刀那条一贯的规矩同源：错要响，不要静。

选 fixup 表而不选 tcc 的链表，也不只是口味：链表把待填信息藏在**指令自己的立即数格
里**，格子有多大就只能记多远，而且一条指令只能欠一笔账。表没有这个限制，`adr`
那种「立即数格不够放中间值」的情况也照记。

### 二、跳到标签的六条与符号的四条

标签：`b`/`bl`/`bcond`/`cbz`/`cbnz`/`adr`。往后跳与往前跳走同一个 `make`，
偏移一律是「目标 - 这条指令自己」。

符号（`bl _printf`、`adrp _msg@PAGE`）在这一层只**记账**，字里留 0：
`blSym`/`adrpSym`/`addSymOff`/`ldrSymOff`。留 0 是有意的 —— `bl` 的 0 偏移是「跳到
自己」，链接器漏填就是个死循环，响的错；换成 `nop` 就成了静的错。

`RELOC` 四种，名字照 Mach-O 的 `ARM64_RELOC_*`（ELF 那边一一对得上）：
`BRANCH26`、`PAGE21`、`PAGEOFF12`、`ABS64`。第九刀第一片那格 `adrp` 的对账例外
（obj 里留的是未落实的 `ARM64_RELOC_PAGE21`）现在有了正主：那一对就是第 11 步链接器
要填的第一种。

### 三、对账：整段程序与 llvm 汇编同一段带标签的源比

单条指令的对账管不到回填。所以这一片的用例是**两段完整的程序**：一个阶乘的循环
（往后跳 `b L1`、往前跳 `cbz L2` 与 `b.lt L3`、还有一条 `adr x2, L3`），一个
「序言 + 收场夹一个循环」。我们用 `CodeBuf` 拼一遍、把同样的汇编（带标签）交给
llvm 汇编一遍，逐字比。llvm 那边自己算标签，于是这一比正好卡住偏移的符号与单位
（指令数还是字节数）这两处最容易错的地方。

缓冲自己的四条边界也在用例里：标签从没落地、同一个标签落两次、跳到不存在的标签、
往缓冲里塞不是 32 位字的东西。

`node tests/arm64/run.js`：**207 过 0 挂**。

**下一片**：MIR -> arm64 的发射。先把最省事的那一版做出来 —— 每个 MIR 值一个栈位，
算之前 `ldr` 进来、算完 `str` 回去（tcc 的 `vstack` 也是「值大多在栈上、只有栈顶那
一两个在寄存器里」，所以这不是权宜之计，而是与 tcc 同一档的策略）。再之后是把它写成
Mach-O 目标文件与自己的链接器（第 11 步）。

<!-- 第九刀第三片-END -->

## 落地：第九刀第四片

**MIR -> arm64 的第一版发射，而且是真跑起来验的。**新文件两个：
`src/core/arm64/from_mir.js`（发射）与 `tests/arm64/from-mir.js`（对账）。
32 条用例在真机上跑出来的返回值，与 JS 里用 BigInt 算的期望值逐条相同。

这是第 10 步的第一片 —— 到这里为止，「C 源码 -> 会跑的机器码」这条路第一次通了半程
（还差符号与链接，那是第 11 步）。

### 一、口径：每个值一个栈位，全落栈

寄存器只用三个当草稿（x9、x10 装操作数，x8 装结果）。一条二目运算发四条指令：
两条 `ldr`、一条算、一条 `str`。

**这不是权宜之计，是与 tcc 同一档的策略。**tcc 的 `vstack` 就是「值大多在栈上，
只有栈顶那一两个在寄存器里」（`tccgen.c` 的 `vtop`/`gv`），一遍过、不回头。差别只在
我们连栈顶那一两个也不留。留不留是窥孔那一片的事；现在要先把「一条 MIR 变成哪几条
arm64」逐条钉死 —— 顺序反了的话，寄存器分配的 bug 与指令选择的 bug 会缠在一起。

帧的样子（`sp` 在函数体里一动不动，所以一律 `sp` 加**正**偏移寻址）：

```
  高地址  ┌──────────────────┐
          │ 调用者的 x29/x30  │  <- stp x29, x30, [sp, #-16]!
  x29 ->  ├──────────────────┤
          │ 值的栈位 ×N       │   off = 8 * (槽数 + 指令下标)
          │ 槽位 ×M           │   off = 8 * 槽号
  sp  ->  └──────────────────┘
```

值的栈位数 = 指令条数，这件事**编译前就知道**（`f.count()`）—— 所以这一层一遍过就够，
不必像 C 前端那样分两遍量帧（ADR-0017 偏差 4 说的那件事在这一层不发生）。这是 MIR
这一层的好处第一次兑现：前端的两遍是因为「标签与帧大小要先知道」，而 MIR 已经把它们
变成了数出来的东西。

### 二、i32 的规范形是「符号扩展过的 64 位」，所以每个 32 位结果后面跟一条 `sxtw`

MIR 的 T_I32 规范形（见 `mir/ir.js`）是符号扩展后的值。落到 arm64 上就是：32 位运算
用 w 系发（`add w8, w9, w10`），发完补一条 `sxtw x8, w8`。收在 `def()` 一处，不在
每条运算里各写一遍 —— 漏一处的后果是「大多数用例照过、某个负数上突然错」。

顺带解决了三件本来要分头处理的事：

- **无符号那三条（UDIV/UMOD/USHR）在 w 系上天然对**：`udiv w8, w9, w10` 只看低 32 位、
  结果零扩展进 w8，随后的 `sxtw` 把它变回规范形。不必先手动零扩展。
- **`CVT_SEXT`（i32 -> i64）是一条 `mov`**：值本来就是那个样子。
- **`CVT_SEXT8`/`SEXT16` 一律用 x 系**（`sxtb x8, w9`）：一条就把 64 位都扩好，i32 与
  i64 的规范形在这儿是同一个值，分 w/x 系反而要给 i32 补一条 `sxtw`。

取余没有单条指令：`sdiv` 之后一条 `msub`（`d = x - (x/y)*y`）。

### 三、结构化控制流：区域栈 + 第三片的标签

`BLOCK`/`LOOP`/`IF` 压一个区域，`END` 弹。`BR n` 的落点按区域的种类分：跳到 `LOOP`
是回头（continue，落在循环头的标签），跳到别的是出去（break，落在 END 的标签）——
与 wasm 逐条相同，这也是 MIR 当初照抄 wasm 层数语义的回报（`ir.js` 里那段注释）。

没有 `ELSE` 的 `IF`：`elseLabel` 与 `endLabel` **钉在同一处**。条件假就一路落到底，
不必为「有没有 else」分两条发射路径。

### 四、验法：`.incbin` 塞进 `.s`，与 C 的 main 一起链接，跑起来比返回值

这一片的错（帧算错、符号扩展漏了、条件码接反）在反汇编上看着全对，**只有跑一遍才
现形**。所以用例不比字节：

1. 生成的机器码写成 `f{i}.bin`；
2. 一个 `.s` 里 `.global _omni_t{i}` / `_omni_t{i}:` / `.incbin "f{i}.bin"`；
3. 一个 C 的 `main` 把每个函数 `extern long long` 声明出来、调用、`printf`；
4. clang 链接，跑，与 JS 里 BigInt 算的期望值逐条比。

第三片之前做不了这件事（没有回填），第十一片之后会更省事（有了目标文件与链接器就
不用 `.incbin` 了）。用例里刻意放了几条**只有真跑才抓得住**的：`i32` 乘要回绕
（100000×100000 = 1410065408）、`-7/2` 是 -3 而 `-7%2` 是 -1、`(u64)-1 / 2`、
`i32` 的逻辑右移看的是 32 位不是 64 位、有符号 `<` 与无符号 `<` 在 -1 与 1 上分道、
两层循环里往外跳两层。

这一次没有错要记 —— 32 条一遍过。前三片把编码与回填都对着 llvm 验过了，这一层只剩
「选哪条指令」，而选错的话上面那几条负数用例会立刻响。

### 五、没做的明着报

浮点、线性内存、指针、聚合、调用、超过 8 个形参、帧偏移超过 32760 —— 一律
`arm64 后端还不认识 …`。四条「必须报」的用例在测里。理由与前八刀一样：一个悄悄发错
指令的后端比一个报错的后端坏得多，而机器码的错在运行期什么都不像。

**下一片**：调用与符号 —— `CALL`/`CCALL` 落到 `bl`（第三片的 `blSym` 已经备好记账），
实参进 x0-x7，然后是 Mach-O 目标文件的写出与我们自己的链接器（第 11 步），
`ARM64_RELOC_PAGE21` 与 `PAGEOFF12` 那一对是第一批要填的。

<!-- 第九刀第四片-END -->

## 落地：第九刀第五片

**调用。**`from_mir.js` 多了 `genModule(mod)`（整个模块生成一段连着的字节）与 `CALL`
的发射。`tests/arm64/from-mir.js` 到 36 条，含递归、八个实参、跨调用还活着的值。

### 一、同一个模块里的调用走**标签**，不走符号

一个模块的函数全在同一个缓冲里，`bl` 的 ±128MB 够得着 —— 所以模块内的调用一笔账都不欠
链接器。`genModule` 先给每个函数要一个标签，再挨个 `place` 加发射，最后一次 `finish`
把所有 `bl` 回填。回来的东西是 `{bytes, offsets, sizes, relocs}`：`offsets[i]` 是第 i
个函数在这段字节里的起点，`relocs` 是**跨**模块那些还欠着的账（`blSym` 记的）。

递归因此是免费的：自己叫自己就是跳自己的标签，与调别人没有任何区别。

### 二、「全落栈」在调用点一次性还本

调用者保存的寄存器（x9-x15）一个都不用管，因为**跨调用活着的值一个也没有** —— 全在
栈位上。实参从栈位 `ldr` 进 x0-x7，`bl`，返回值从 x0 `str` 回自己的栈位。

这就是第四片选「每个值一个栈位」的回报：一般的后端到了调用点要算活跃区间、要溢出、
要恢复，而这里那三件事根本不存在。代价是每条运算多两次访存 —— 这笔账在窥孔那一片再
还，而且到那时「哪些值真的跨调用活着」已经有现成的答案（栈位就是答案）。

`sp` 在函数体里一动不动这条也在这儿兑现：调用前后不用调整栈指针，实参也不落栈
（超过 8 个就明着报）。

### 三、i32 的返回值要在**调用点**再扩一次

AAPCS 只保证 w0 有值，x0 的高 32 位不算数。而 MIR 的 T_I32 规范形是符号扩展过的 64 位
—— 所以调用点收到 i32 返回值时要补一条 `sxtw`。这一条走的是第四片那个 `def()`：
`def(i, 0, widthOf(t))`，与本地运算的收尾是同一处代码。

用例里专门有一条查它（`omni_neg32` 回 -5）：漏掉这条扩展的话，返回值在 64 位里看起来是
`0xfffffffb`（正的 4294967291），而**大多数用例照过** —— 只有负的 i32 返回值会露。

### 四、验法多了一格：`.incbin 文件, 跳过, 取多少`

第四片一个函数一个 `.bin`。现在函数之间有相对跳转，切成几个文件的话链接器未必把它们
摆在一起，`bl` 就指到别处 —— 所以整个模块一个 `blob.bin`，用
`.incbin "blob.bin", 起点, 长度` 在同一段里按 **blob 的顺序**切出符号来。顺序错了、
或者中间插了别的东西，递归那条用例会立刻死循环或者跳飞。

新的边界两条：单个函数里的 `CALL`（没有别的函数的落点，明着报「要按整个模块生成」）、
九个实参。

**下一片**：浮点（第二片已经把编码备好了，缺的是 `from_mir` 这一侧的 d0-d7 与 v 寄存器的
栈位）与线性内存（`MLOAD`/`MSTORE`，C 前端的 `&x`、`memcpy`、影子栈全在那片上）。
再之后是第 11 步：Mach-O 目标文件的写出与我们自己的链接器 —— `relocs` 那个字段就是给
它准备的。

<!-- 第九刀第五片-END -->

## 落地：第九刀第六片

**浮点。**`from_mir.js` 认了 f64/f32 的算术、取负、比较、六种转换，以及浮点的调用
约定（d0-d7 与 x0-x7 **各自从 0 起数**）。`tests/arm64/from-mir.js` 到 50 条。

### 一、值照旧躺在 8 字节的栈位里，躺的是**位模式**

没有为浮点另开一套取值/回写。栈位里存的是 IEEE 位模式，算之前一条 `fmov` 进 FP 寄存器、
算完一条 `fmov` 出来：

```
ldr  x9, [sp, #40]      // 位模式
fmov d16, x9
ldr  x10, [sp, #48]
fmov d17, x10
fadd d18, d16, d17
fmov x8, d18            // 位模式
str  x8, [sp, #56]
```

这样 `loadRef`/`def`/`frameLoad`/`frameStore`/常量池那一整套一个字都不用改，代价是每条
运算多两三条 `fmov`。与「全落栈」是同一个取舍 —— 先把「哪条 MIR 对哪条 arm64」钉死。

**白捡了一件事**：`CVT_BITCAST` 在这个表示下就是一条 `mov`（甚至可以不发）。位重解释
在别的后端要专门处理，在这儿是恒等的。

草稿用 **v16-v18**，不是 v8-v15 —— 后者是被调用者保存的，用了就得在序言里存、收场里取，
而这一层不需要跨调用留住任何东西。

### 二、浮点的条件码**不能照抄整数那张表**

`fcmp` 遇上 NaN 会把标志位置成「无序」：C=1、V=1、Z=0、N=0。而 C 与 IEEE 要求除了 `!=`
之外所有比较对 NaN 都是假。逐条对下来：

- `<` 要用 `mi`（N==1），**不能**用 `lt`（N!=V）—— 无序时 N=0、V=1，`lt` 会**为真**；
- `<=` 要用 `ls`（C==0 或 Z==1），不能用 `le`，同一个道理；
- `>`/`>=` 用 `gt`/`ge` 就对（两者都要 N==V，无序时不成立）；
- `==`/`!=` 用 `eq`/`ne`：无序时 Z=0，于是 `==` 假、`!=` 真，正是 C 要的。

这是整片里唯一「照抄就错、而且**只在 NaN 上**错」的地方，所以用例里有三条 NaN
（`NaN < 1.0`、`NaN <= 1.0`、`NaN != NaN`）。这类错跑一万个正常数字都跑不出来。

### 三、AAPCS 的两串寄存器各自从 0 起数

整数实参占 x0-x7，浮点实参占 v0-v7，**两个计数器**。`(double, long long, double, long long)`
的四个实参落在 d0、x0、d1、x1 —— 按一串数的话就全错位。形参那一侧同理。返回值：整数
在 x0、浮点在 d0。用例里专门有一条混着传的（`omni_mix`）。

`fmov` 的整数那一侧要与浮点同宽：d 配 x、s 配 w。配错了 f32 会带上高 32 位的垃圾。

### 四、f32 是真的单精度

`1.0/3.0` 在 f32 与 f64 下是两个不同的数（`ir.js` 里 T_F32 那条注释说的就是这个），
所以用例比的是**位模式**，不比十进制文本：`f2b(1/3)` 与 `d2b(1/3)` 一望而知不同。
`double -> float -> double` 掉精度那条也在（`d2b(Math.fround(0.1))`）。

对账那一侧多了一格：浮点用例的实参与期望值都以 64 位整数（位模式）过手，
C 那边用 `memcpy` 换成 `double` —— 十进制文本一次都不经过，于是「谁的十进制解析怎么舍」
这件事根本不进这条链。

### 五、还没做的

浮点的 `MOD`（arm64 没有单条指令，要落到 `fmod`，那是有了符号调用之后的事）、
`f32` 的形参与返回（编码备好了，ABI 那一侧还没写）、线性内存、指针、聚合。

**下一片**：线性内存（`MLOAD`/`MSTORE`）—— C 前端的 `&x`、`memcpy`、影子栈全在那一片上，
做完之后「C 源码 -> 会跑的机器码」就只差符号与链接了。

<!-- 第九刀第六片-END -->

## 落地：第九刀第七片

**存取。**`MLOAD`/`MSTORE` 的十五种宽度符号落成六条 arm64 存取。
`tests/arm64/from-mir.js` 到 61 条。

### 一、native 这条腿上**没有线性内存**

这一片先走错过一步，记在这儿：我本来按 wasm 引擎的常规做法，把「线性内存的基址」钉在
x28 上，每次访问发一条 `add x9, x28, x9`。**那是错的方向。**

线性内存（第二刀）是 **wasm 与解释器那条腿**的模型：一整片字节、地址是从 0 起的偏移、
越界查得出来。native 不是那样 —— tcc 编出来的 `int x; &x` 就是**真地址**
（`[x29, #-off]`），全局在数据段、堆是 `malloc` 回来的地址，一个「基址」都不存在。
钉基址寄存器的代价不只是白搭一条 `add`：native 要与外部 C 函数交换指针，而 `malloc`
回来的地址不在任何一块「线性内存」里，一加基址就全错。

所以这一层的口径是：**`MLOAD`/`MSTORE` 的地址就是真指针**。改完之后每次访问少一条指令，
测里那段设 x28 的手写蹦床也整段退役 —— 实参直接传 `membuf + 偏移`。

（线性内存那套仍然在 MIR 里、仍然给解释器与 wasm 用。分岔在**后端**，不在 MIR。）

### 二、十五种宽度符号落成六条指令

读侧九种、写侧六种（`MLOAD_KINDS`/`MSTORE_KINDS`），落下来只要六条：

- 符号扩展的三种走 `ldrsb`/`ldrsh`/`ldrsw`，一律**扩到 64 位** —— i32 的规范形就是
  符号扩展过的 64 位，扩到 x 于是两种结果类型通用，不必按 `t` 分岔；
- 零扩展的三种走 `ldrb`/`ldrh`/`ldr w`（w 系的加载天然把高 32 位清零）；
- **`f32`/`f64` 也走整数加载**：栈位里躺的是位模式（第六片定的），所以浮点的存取
  一条 FP 指令都不用发。这是那个表示第二次白给好处。

写侧没有符号可言（「把低若干位拍进内存」），所以就是 `strb`/`strh`/`str w`/`str x`，
浮点两种与整数两种共用。

### 三、静态偏移一律折进地址，不进 `ldr` 的立即数格

`ldr` 的无符号偏移是**按宽度缩放**的。而 C 的 `p->field` 给的偏移未必是宽度的倍数：
`short a[4]` 里第三个元素在字节 6，按 2 缩放正好；可 `struct { char c; long long v; }`
在紧凑布局下 `v` 在 1，按 8 缩放就除不尽。分情况判断得多写一层，而折进地址只是一条
`add` —— 所以一律折。偏移大过一格立即数（4096）时先 `movz/movk` 造出来再加，用例里
有一条 5000 的专门走这条路。

顺带一个次序上的坑：`memAddr` 在偏移大的时候要借 TMP1 当中转，而 `MSTORE` 的值本来
也落在 TMP1 上 —— 所以 `mstore` 先把值挪到 RES，再去算地址。写反了的话只有
「静态偏移大于 4096 的 store」会错，而那种偏移在小用例里根本不出现。

### 四、还没做的

`MSIZE`/`MGROW`（那两条本来就是线性内存的语义，native 上没有对应物 —— 明着报）、
指针那一族（`PLOAD` 等，不过 C 前端根本不发它们）。

到这里，**C 前端发得出来的 MIR 里，除了外部符号的调用，arm64 后端全认了**。
`&x`、`memcpy`、struct 的字段、数组的下标 —— 都是一条存取加一条 `add`。

**下一片**：第 11 步的开头 —— Mach-O 目标文件的写出。有了它，`blSym` 记的那些账
（`printf` 之类）就能交给系统链接器，而 `.incbin` 那套脚手架可以退役；再往后是我们
自己的链接器。

<!-- 第九刀第七片-END -->

## 落地：第九刀第八片

**Mach-O 目标文件的写出，与外部符号的调用。**新文件 `src/core/arm64/macho.js`；
`from_mir.js` 认了 `CCALL`。`tests/arm64/from-mir.js` 到 65 条，而且**整套 `.incbin`
脚手架退役了** —— 现在是真的 `.o`，交给 clang 链接。

这是第 11 步的第一片。

### 一、先写 `.o`，不写可执行文件

一个可执行文件要自己解决 dyld 的那一整摊：`LC_LOAD_DYLINKER`、`LC_MAIN`、
`LC_LOAD_DYLIB`、绑定信息，而且 **macOS 上 arm64 的可执行文件必须签名**。这些与
「我们编出来的指令对不对」全无关系。目标文件只要说清三件事：**字节、符号、哪几个
字节要等符号定下来再填**。tcc 也是这个次序（`tccelf.c` 在 `tccrun.c` 之前）。

写出来的是 `MH_OBJECT`，一段一节（`__TEXT,__text`），四条 load command：

```
mach_header_64      32
LC_SEGMENT_64       72 + 80（一节）
LC_BUILD_VERSION    24        // 不写链接器会嘟囔「没有平台信息」
LC_SYMTAB           24
LC_DYSYMTAB         80
```

结构照 `<mach-o/loader.h>`/`<nlist.h>`/`<reloc.h>` 的字段布局，**不抄代码**。
一格一格用 `DataView` 填，不手拼字节 —— 字段宽度混着 4 和 8，手拼错一格的话链接器
只会说一句「malformed object」，什么都查不出来。

### 二、三件必须对的事

1. **符号表的次序**：局部、定义的外部、未定义的外部，三段各自连着，`LC_DYSYMTAB`
   报的就是这三段的起点与长度。乱了链接器说符号表坏了。
2. **名字带下划线**：C 的 `printf` 在文件里是 `_printf`。这一层加前缀，上面那几层
   记的是裸名字。
3. **重定位的第二个字是位域**：低 24 位符号号、24 位 `pcrel`、25-26 位长度、
   27 位 `extern`、28-31 位类型。拼它照旧用乘法不用 `<<`（`1 << 31` 在 JS 里是负数
   —— 与 arm64 编码器那边同一条教训）。

`ARM64_RELOC_BRANCH26` 的三格是 `pcrel=1, length=2, extern=1`。第九刀第一片对账时
遇到的那个「`adrp` 在 obj 里留着未落实的 `ARM64_RELOC_PAGE21`」，现在从另一头看清楚了：
那正是我们要写出去的东西。

### 三、`CCALL` 落成 `bl <符号>`

模块内的调用走标签（第五片），跨模块的走符号。`asm.js` 的 `blSym` 早就把账记好了
（第三片），这一片只是把它接上：`CCALL` 的 `a` 是 `mod.cabi` 的下标，取出名字、
`blSym`，其余（实参就位、返回值落回栈位）与 `CALL` 共用 `callArgs`/`callRet`。

同一个外部符号叫多次只占**一条**符号表项（按名字去重），用例里有一条查它。

### 四、`.incbin` 那套脚手架退役

第四到七片的对账靠 `.incbin "blob.bin", 跳过, 取多少` 把符号从一段裸字节里切出来 ——
能跑，但那是脚手架：切的次序要人来保证，外部符号一个也填不了。现在直接：

```
genModule(mod) -> {bytes, offsets, relocs}
writeObject(bytes, defs, relocs) -> omni.o
clang main.c omni.o -o prog
```

于是 `CCALL` 的用例才有可能存在。测里三条整数的（自家的 `omni_ext_add`、**libc 的
`llabs`**、同一个符号叫两次）加一条 double 的（实参走 d0/d1、返回走 d0）。
`llabs` 那条尤其要紧 —— 它证明我们的 `.o` 与系统的 libc 是真的链在一起了。

一次就过，没有错要记。头的长度写死成一个常量并在填完之后断言一句
（`if (b.len !== HEAD)`），是这类「偏移必须自洽」的文件格式里最省事的保险。

**下一片**：`__DATA` 段（字符串字面量与全局变量，`adrp`/`add` 那一对
`PAGE21`+`PAGEOFF12` 的重定位就为它们准备的）—— 有了它，`printf("hello")` 这种最寻常
的 C 才编得出来。再之后是我们**自己的链接器**，把 clang 也换掉。

<!-- 第九刀第八片-END -->

## 落地：第九刀第九片

**`__DATA` 段与模块级变量。**`GLOAD`/`GSTORE` 落成 `adrp`/`add` 取址加一条存取；
`macho.js` 会写第二节了。`tests/arm64/from-mir.js` 到 71 条。

### 一、全局靠**符号**寻址，一个都不进什么「基址」

`adrp x9, sym` 取符号所在的那一页（21 位、单位 4096），`add x9, x9, sym@PAGEOFF` 取页内
的偏移。这一对是 arm64 上取任何一个全局地址的标准两条，两格各欠链接器一笔重定位：
`ARM64_RELOC_PAGE21` + `ARM64_RELOC_PAGEOFF12`。

第九刀第一片对账时被 llvm 挡回来的那件事（`adrp x1, . + 4096` 在 obj 里反出来是 0，
因为 `ARM64_RELOC_PAGE21` 还没落实），现在从写出去的那一头解释完了 —— 那正是我们要
写出去的东西。当时在 ADR 里留的那句「这一格顺便说明了第 11 步要做的事」，兑现了。

MIR 里模块级变量只是个名字（`mod.globals`）。落到目标文件上，每个名字就是一个**真符号**，
占 `__DATA` 里的八个字节、零初始化。MIR 没有「全局的初值」这回事（初始化是入口函数里的
一串 `GSTORE`），所以这一层只管留位。

「是真符号」这件事测里专门查了一条：C 那边写 `extern long long omni_g_i64;` 直接读它。

### 二、写宽了不会当场错，所以要专门有一条用例盯着

`i32` 的全局只占八字节格子里的**低四字节**：读用 `ldrsw`（i32 的规范形是符号扩展过的
64 位），写用 `str w`。如果写的时候发成了 `str x`，高四字节会被踩掉 —— 而在一个只有
这一个全局的模块里**什么都看不出来**。所以用例先把整个八字节铺满 1、再只写低四字节、
再读回来：写宽了这条立刻露。

### 三、`n_value` 是**段里的地址**，不是节里的偏移

这一片唯一的错，链接器抓的：

```
ld: warning: _omni_g_i64 symbol is ignored,
    because its address isn't in its designated section
```

节的地址在段里是接着排的 —— 代码从 0 起，`__DATA` 紧跟着（按 8 对齐）。所以数据符号的
`n_value` 要是 `dataAddr + 节内偏移`。少加那一格，符号看上去落在代码节的范围里，链接器
就把它整个丢掉（只警告，不报错 —— 于是链接过了、跑起来读到的是垃圾）。

调用方给的还是**节内偏移**（那才是它知道的东西），换算收在 `writeObject` 一处。

### 四、没有数据就不写第二节

`nsects` 是算出来的：数据是空的就只写 `__TEXT,__text`，头也短 80 字节。这不是省空间，
是让「一个只有代码的模块」写出来的字节与第八片**一模一样** —— 那样第八片验过的东西不用
再验一遍。

**下一片**：字符串字面量（`printf("hello")` 的那个 `"hello"` 要进 `__DATA`，
`CVT` 不出来 —— MIR 里它是常量池里的一条 `str`，得先在这一层想清楚「常量池里的串怎么
变成一个符号」）。再往后是我们**自己的链接器**。

<!-- 第九刀第九片-END -->

## 落地：第九刀第十片

**字符串字面量进 `__DATA`。**常量池里的一条 `str` 变成数据段里的一个符号，用到它的地方
取的是**地址**（`adrp`/`add`，与全局同一对指令）。`tests/arm64/from-mir.js` 到 78 条。

### 一、去重不用再做一遍 —— 常量池本身就是那张表

原本打算「预扫每个函数的 `a`/`b`/实参池，把 `str` 常量收集起来去重」。写之前多看了一眼
`ConstPool.intern`：它按 `类型|种类|文本` 建索引，同一份文本第二次进池拿回的是**同一条
ref**（那是为哈希稳定性做的，ADR-0014 决策 5）。于是「同一个 `"hi"` 只有一个符号、
一份字节」是常量池的性质，不是这一层要维护的东西 —— `genModule` 只需顺着
`mod.consts.items` 走一遍，`kind === 'str'` 的每一条分一个符号。

代价是**没被用到的串也会占数据段**。那是死代码消除的事，不是这一层的事；而且换个角度，
「池里有的就写出去」比「扫函数体决定写哪些」少一份会与事实不符的信息。

用例里那条「同一份文本只有一个符号」是两个地址相减等于 0 —— 在 MIR 那一侧它本来就是
同一条 ref，所以这条查的其实是**下游没有把一条 ref 铺成两份字节**。

### 二、末尾那个 0 要自己补

数据段的字节是我们排的，池里的文本没有终止符。少补一个 0 的话 `strlen("")` 会一路数到
下一段数据里去 —— 而那种错在「后面正好是另一个串的字节」时是**看不出来**的（数出来的是
个大于 0 的合理数）。所以有一条专门的用例：空串的 `strlen` 是 0。

### 三、串的字节是 UTF-8，一格不多

`utf8Bytes`（`src/core/host/utf8.js`，C 后端与 LLVM 后端共用的那一份）直接拿来用。
用例查的是 `strlen("hello, 世界")` 等于 UTF-8 的**字节数**（13，不是 9 个字符），
外加读第 7 个字节等于 `0xe4`（「世」= U+4E16 -> `e4 b8 96` 的第一节）—— 后一条顺手
把 `MLOAD` 的静态偏移也压在串上了。

### 四、这些符号现在是外部符号，这是一笔欠账

`macho.js` 里 defs 一律 `N_SECT | N_EXT`，于是 `omni_str_0` 是个外部符号。两个模块各有
一个 `omni_str_0` 就会在链接时撞名。正确的做法是**局部符号**（符号表的第一段，
`nlocalsym` 那一格现在还是 0）配按节的重定位。

没有在这一片做，是因为它要动的是重定位那一侧的表示（`r_extern=0` 时 `symbolnum` 是**节号**，
地址靠 addend 表示），而那一整套的验收更适合与我们自己的链接器一起做 —— 现在的形状
在「一个模块」这个尺度上是对的，撞名要到多模块才发生。记在这里，不是忘了。

### 五、单个函数那条路上明着报

`codeOf`/`genFunc` 编一个孤立的函数，没有数据段可言，于是 `strSyms` 是 `null`、
碰到串常量直接抛。这一格有边界用例盯着：不能悄悄发一条指着 0 的 `adrp` ——
那种错要到运行时段错误才露，而那时已经离现场很远了。

**下一片**：我们**自己的链接器** —— 把测里的 clang 从链接这一步上换掉。
`writeObject` 写出去的 `.o` 现在是给别人读的，下一片要开始自己读。

<!-- 第九刀第十片-END -->

## 落地：第九刀第十一片

**Mach-O 的读入，与「几个 `.o` 并成一个」。**`src/core/arm64/link.js`：`readObject`
把一个 `MH_OBJECT` 读回 `writeObject` 的那四样（`text`/`data`/`defs`/`relocs`），
`linkObjects` 把几个并起来、把够得着的重定位当场填掉。`tests/arm64/link.js` 21 条。

### 一、读入器的第一份价值是给写出器对账

写出器一直只有一个信号：链接器肯不肯吃。那个信号很粗 —— 上一片那条
「`n_value` 算错了」就只换来一句 warning，链接过了、跑起来读垃圾。

有了读入器，多一条能直接验的性质：**读回来再写出去，字节不变**。任一侧错一格这条就不成立，
而且它不需要外部工具。两个 `.o`（一个带 `__DATA` 一个不带）各验一遍。

### 二、`BRANCH26` 填得了，`adrp` 那两格填不了

这一片最关键的一个判断，写之前想清楚的：

- `BRANCH26` 是**同一节内的相对偏移**。并合之后两头都在同一段 `__text` 里、偏移都定了，
  于是差值算得出来 —— 这正是 `ld -r` 会填的那一类。
- `PAGE21`/`PAGEOFF12` 要的是「目标所在的 4096 页」减「PC 所在的 4096 页」。
  目标文件的 `__text` 只保证按 4 对齐，整段将来落在哪个页边界上这一层**不知道**，
  所以这两格只能原样转出去。

想当然地「都填掉」会得到一个看上去干净、跑起来乱跳的产物，而且错法与对齐有关 ——
换个 `main.c` 的长度症状就变。所以填与不填的界线是按「这个数在这一层是否已经定下来」划的，
不是按「我会不会算这个编码」划的。

### 三、填进 26 位里的偏移必须真跑一遍

账对上不等于填对了：偏移的符号、除不除 4、要不要按 `at` 挪，四处都能错一格而账面不变。
所以验收的第三段是真跑：乙里的 `omni_lk_main` 跨文件调甲的 `omni_lk_add3`，
甲的 `omni_lk_add3` 又调自己的 `omni_lk_triple`（那一笔在甲自己的 `.o` 里就填好了），
结果再进 libc 的 `llabs`。三层跳一齐对上，才算这 26 位是对的。

`patchBranch26` 只换低 26 位、高六位原样留着 —— 那六位是「`bl` 还是 `b`」，
重编一遍等于把这个信息丢掉再猜回来。

### 四、并合的规矩

`__text` 按 4 拼、`__data` 按 8 拼，符号的偏移跟着挪（`n_sect` 决定挪哪一个基址）。
同一个名字定义两次**直接报错** —— `ld` 说 duplicate symbol，我们也说，这不是可以
「后来者胜」的事。

顺手兑现了上一片记的那笔账的一半：并合之后，两个模块各自的串常量符号还在同一张符号表里，
于是「两个模块各有一个 `omni_str_0`」现在会被这条 duplicate 挡下来 —— 从「链接时莫名撞名」
变成「我们自己在并合时明着报」。真正的办法（局部符号）还是欠着。

**下一片**：可执行文件。那需要 `PAGE21`/`PAGEOFF12` 的填法（有了绝对地址就算得出来）、
`LC_MAIN` 那一摊，以及 macOS 上 arm64 必须有的**代码签名**。也可以先走另一头：
x86_64 的编码器（第 11 步的前半）。

<!-- 第九刀第十一片-END -->

## 落地：第九刀第十二片

**x86_64 的编码器（整数那一档）。**`src/core/x64/encode.js`，对着
`llvm-mc -triple=x86_64` 验，`tests/x64/run.js` 123 条。搬、算、比、跳、调、存取、
宽度转换都在了；SSE（浮点）是下一片。

### 一、返回的是字节数组，不是一个字

x86 的指令变长，所以 arm64 那边「一条 = 一个 `u32`」的便利在这里没有。连带着测的写法也变：
反汇编那一行要连「这条占几个字节」一起读回来。

**这一格骗过一次**：`llvm-objdump` 的字节列**填满时最后一个字节后面没有空格**
（直接接制表符），而原本的正则要求「每个字节后跟一个空格」，于是十字节的 `movabs`
被少读一个字节 —— 报出来的样子像是编码错（`ours` 比 `llvm` 长一个字节），
一时看不出是读的那一头错。所以现在按「到制表符为止」切。

### 二、一族运算写成一张表，不写成三十二个函数

`add/or/adc/sbb/and/sub/xor/cmp` 在手册里就是一张表：操作码 = 基码 + `/digit` × 8。
所以这里也是一张表（`ALU`）加四个入口（`aluRR`/`aluRI`/`aluRM`/`aluMR`），
不是三十二个各写一遍的函数 —— 那样的下场是「改一条忘八条」。
`shl/shr/sar`（`SH`）与十六个条件码（`CC`）同一个道理。

### 三、「哪个形式」不是偏好，是账

x86 的同一件事常有两三种合法编码，而对账要求我们**挑与 llvm 一样的那个**。
三条界线是这一片打回来的（九条用例一齐红，全是「我们发的也对、也跑得动，只是字节不同」）：

- `mov r32, imm32` 走 `B8+r`（操作码里带寄存器号），不走 `C7 /0`；64 位那一档反过来，
  走 `C7 /0` 加符号扩展的四字节。
- `add rax, imm32` 走累加器的短形式 `05+digit*8`，省掉 ModRM 那一字节；
  但立即数装得进一字节时，`83 /digit` 更短，那个优先。
- 移 **1** 位走 `D1 /digit`，不走 `C1 /digit` 加一个 `01`。（源码里原本写着一句
  「llvm 也不用短形式」—— 那句话是错的，`sarq $1, %r11` 当场打回来。）

### 四、相对跳转不进对账那一批

`jmp 1f` 这种够近的，llvm 会自己**缩成两字节**的 `EB` 形式（量过：紧跟标签的 `jmp`
编出来是 `eb 00`）。那是汇编器的松弛，不是编码器的账。

我们这一层永远发四字节的形式，理由与回填有关：「这一条占几个字节」必须在回填**之前**
就定下来，会变长的编码要么两遍过、要么留空洞，两样都比多三个字节贵。所以这几条对着
**手册的字节**验（`E9`/`0F 8x`/`E8` 加一个小端的四字节），不对着 llvm 验 ——
并把这个理由写在测里，免得后来人以为是漏了。

### 五、x86 的三个特例，各有一条用例盯着

- `rsp`/`r12` 当基址时 `rm=100` 被 SIB 占了，必须补一个 SIB 字节；
- `rbp`/`r13` 当基址时 `mod=00` 被「RIP 相对」占了，位移是 0 也得写 `mod=01` 加一个 0；
- 八位那一档的 `spl/bpl/sil/dil` **必须**有 REX 前缀（哪怕全 0 位的 `0x40`）——
  没有 REX 的话同一格编码指的是 `ah/ch/dh/bh`，值会取到高字节去。

**下一片**：SSE —— `f64`/`f32` 的搬、算、比与六种转换（`movsd`/`addsd`/`ucomisd`/
`cvtsi2sd` 那一族）。再往后是 x86_64 的 `from_mir`（第 10 步在这条腿上的那一半）。

<!-- 第九刀第十二片-END -->

## 落地：第九刀第十三片

**x86_64 的 SSE（浮点）。**`movsd`/`movss`、七条标量算术、`ucomisd`、四种转换、
位模式的进出（`movq xmm↔r64`）、`xorpd`/`andpd`/`pxor`。`tests/x64/run.js` 到 165 条，
四十二条 SSE 用例一次全中 —— 上一片吃过的那三种「llvm 挑了更短的形式」在这一族里没有，
SSE 的编码是一条一格、没有短形式可挑。

### 一、x87 一格都不碰

x86_64 上的 `double`/`float` 全走 SSE 的**标量**那一档（`movsd` 的 `s` 是 scalar）。
x87 是栈式的、内部精度还是 80 位 —— 与 C 的 `double` 语义对不上（同一串运算在 x87 上
会因为「中间值多几位精度」得出不同的结果），而我们要的是逐字节可比。tcc 的 x86-64
后端也走 SSE。

### 二、强制前缀在 REX **之前**

一条 SSE 指令的形状是：强制前缀（`F2` double、`F3` float、`66` 打包双精度）+ REX +
`0F` + 操作码 + ModRM。次序记反了 llvm 立刻打回来，所以带 r8-r15 与 xmm8-xmm15 的用例
特意各有几条 —— 那才是 REX 真的出现的场合。

### 三、`2C` 与 `2D` 差一格，平时看不出来

浮点转整数用 `cvttsd2si`（`2C`，两个 t，**向零截断**），不是 `cvtsd2si`（`2D`，
按 MXCSR 里的舍入模式，默认是「就近偶数」）。C 的 `(int)f` 是截断。

这两个操作码差一格，而 `(int)2.5` 两样都得 2 —— 要到 `(int)2.7` 才露（`2D` 给 3）。
所以这一格在源码里写了注释，不指望以后有人从用例上看出来。

### 四、`ucomisd` 之后不能只看 ZF

浮点比较把结果放进标志位，不可比（有 NaN）时 `PF=1`，而**ZF 与 CF 也都是 1**。
于是「相等」要 `je` 加 `jnp` 两条，光看 ZF 会把 NaN 判成相等 —— 这与 arm64 那边
「`fcmp` 之后 `<` 要用 `mi` 而不是 `lt`」是同一个坑的两种长相。

条件码这一侧只有「大于」那一列（`a`/`ae`）好用，所以 `<` 一般靠**换操作数**实现。
这些是 `from_mir` 那一层的事，这一片只把话记在 `fcmp` 的注释里。

**下一片**：x86_64 的 `from_mir`（第 10 步在这条腿上的那一半）—— 帧的样子、
SysV 的传参（整数六个 `rdi/rsi/rdx/rcx/r8/r9`、浮点八个 `xmm0-7`，与 arm64 的
八加八不同），以及 `idiv` 那条要先 `cqo` 的老规矩。

<!-- 第九刀第十三片-END -->

## 落地：第九刀第十四片

**x86_64 的指令缓冲，与 RIP 相对寻址。**`src/core/x64/asm.js`：标签、回填、
`callSym`/`leaSym`/`loadSym`/`storeSym` 的记账。`tests/x64/run.js` 到 182 条。

### 一、相对跳转一律发四字节的形式

这是这一片唯一的设计决定，而它是被**回填**逼出来的：回填要求「这一条占几个字节」在
跳过去之前就定下来。汇编器可以两遍过、可以先假设短形式再放大（llvm 的 relaxation
就是那样），但那要么把「一条多长」变成回填的函数、要么留空洞补 `nop` ——
两样都比多三个字节贵。一遍过、不回头，与 tcc 同一个口径。

于是回填点只要记「那四个字节在哪」，而它总在**这条指令的最后四个字节**上
（`E9`/`0F 8x`/`E8` 三种都是）。

### 二、偏移从**下一条指令**算起

x86 的 PC 相对以指令**末尾**为基准，arm64 以指令**开头**为基准。所以每个回填点记两个数：
`at`（四字节偏移的位置）与 `end`（本条的末尾），偏移是 `目标 - end`。

少记 `end` 会差一条指令的长度，而那种错**不会崩**：它跳到另一条指令的开头，
照样是合法的指令流，只是跑错。所以往前跳与往后跳各有一条手算的用例
（`e9 01 00 00 00 90` 与 `90 e9 fa ff ff ff`）。

### 三、缓冲这一批不进 llvm 那一批

理由与上一片同一个：llvm 会把够近的跳转缩短，所以它的字节与我们的不同**不代表谁错**。
缓冲要验的是记账 —— 偏移从哪算起、四个字节落在哪、重定位记在哪一格 ——
这些对着手算的字节验更清楚，也不需要外部工具。

手算这件事本身也会错：`movl %edx, 0(%rip)` 那一条我把重定位的位置算成了 22，
实际是 21（那条指令没有 REX，比前一条短一个字节）。测打回来的正是这个。

### 四、x86_64 没有 `adrp`，一条 `lea` 就够

`mod=00, rm=101` 在 64 位下被改成了 RIP 相对（32 位时它是「绝对地址」）。
于是取一个全局的地址是 `leaq sym(%rip), %rax` **一条**，比 arm64 的 `adrp`+`add`
少一条、也少一笔重定位（`X86_64_RELOC_SIGNED` 一笔）。

`loadSym`/`storeSym` 更进一步：直接 `movq sym(%rip), %rax`，连取址都省了 ——
arm64 那边做不到（`ldr` 的立即数格装不下一个符号）。这是两条腿上第一处「x86 更省」的地方，
记一笔，免得以后照着 arm64 的形状去写 x86 的 `GLOAD`。

**下一片**：x86_64 的 `from_mir` —— 帧、SysV 的传参（整数六个、浮点八个，
与 arm64 的八加八不同）、`idiv` 前的 `cqo`。再往后是 x86_64 的目标文件写出
（`macho.js` 现在写死了 arm64 的 cpu 类型与三种重定位）。

<!-- 第九刀第十四片-END -->

## 落地：第九刀第十五片

**x86_64 的目标文件写出。**`macho.js` 认两种架构了，并从 `src/core/arm64/` 挪到
`src/core/link/`（它早就不只是 arm64 的东西了，而 ADR 上头的清单里本来就写着
`link/macho.js`）。`tests/x64/macho.js` 15 条，**在真机器上跑过** ——
Apple Silicon 上靠 `clang -arch x86_64` 加 Rosetta。

### 一、两种架构只差三格

cpu 类型、子类型、重定位的类型号。段/节/符号表/字符串表的形状与次序完全一样，
所以这个文件没有按架构分叉，只多一张 `ARCH` 表加一个参数。

一格记着：x86_64 的子类型是 `CPU_SUBTYPE_X86_ALL = 3`，**不是 0**（arm64 那边是 0）。

重定位这一侧，两族的类型号**同号不同义**（`2` 在 arm64 是 `BRANCH26`、在 x86_64 是
`BRANCH`），而我们这一层的 `kind` 是字符串、两族的名字不同，所以一张 `RELOC_TYPE`
就够。为了不把 arm64 的重定位混进 x86_64 的文件里，`ARCH` 表里列了各自认的 `kind`，
不在表里的当场报。同一个理由，`link.js` 的 `readObject` 现在先认 cputype ——
它只有 arm64 那张表，读别的架构会按错的表往下读。

### 二、函数体是**手写**的，这是有意的

x86_64 那条腿上第 10 步（`from_mir`）还没做，而目标文件这一层不该等它。所以这一片的
十个函数是用 `CodeBuf` 一条条发出来的：序言/收场、`idiv` 前的 `cqo`、`cmp`+`jcc`+标签、
`setcc`+`movzx`、帧里的存取、`call` libc、RIP 相对取串、全局的读写、SSE 的乘加、
`ucomisd`+`setb`。

反过来说，等 x86_64 的 `from_mir` 落地，这十段正好是那一层要照着发的样子 ——
这一片顺手把「一个 SysV 的函数长什么样」钉死了。

### 三、SysV 与 AAPCS 的差别，在这一片上第一次真碰到

- 整数实参只有**六个**（`rdi rsi rdx rcx r8 r9`），arm64 有八个；浮点两边都是八个。
- `call` 之前 `rsp` 必须是 16 的倍数。进函数时 `rsp % 16 == 8`（返回地址占了 8），
  `push rbp` 补回 16 —— 所以「序言里 push 一个、再减一个 16 的倍数」这套是**必须**的，
  不是风格。少了它 `printf` 那类用 SSE 的 libc 函数会崩在对齐检查上。
- 浮点比较要 `ucomisd` **换操作数** + `seta`：`x < y` 编成「比 `y` 与 `x`、取 above」。
  直接比 `x` 与 `y` 取 below 也能过这一片的用例，但 NaN 那一格是错的
  （`CF=1` 对不可比也成立）—— 与 arm64 那边「`<` 要用 `mi` 而不是 `lt`」是同一个坑。

**下一片**：x86_64 的 `from_mir`。有了这一片的十段手写样板与上一片的缓冲，
那一层要做的是「把 arm64 那份 `from_mir` 的骨架照搬，指令换成 x86 的」——
骨架（全落栈、每个值一个八字节格子、区域栈管结构化控制流）两条腿共用。

<!-- 第九刀第十五片-END -->

## 落地：第九刀第十六片

**MIR -> x86_64。**`src/core/x64/from_mir.js`。`tests/x64/from-mir.js` 73 条，
**在真机器上跑过**（`clang -arch x86_64` + Rosetta）。第 10 步现在两条腿都有了。

### 一、骨架照搬，不重写

「每个 MIR 值一个八字节栈位、算之前取进来算完写回去、结构化控制流靠一个区域栈、
一遍过不回头」这一整套在两条腿上是**同一个**。所以这一片写的是差集，不是全集 ——
文件头上那段只记「x86 与 arm64 不一样的地方」，相同的部分指回 arm64 那一份。

这么做的前提是上一片钉下的十段手写样板：那时候已经把「一个 SysV 的函数长什么样」
逐条量过了，这一片只是把它接到 MIR 的分发上。

### 二、四处形状不同，各有用例盯着

- **帧靠 `rbp`，偏移是负的**。arm64 那边 `sp` 一动不动、一律正偏移；x86 这边用 `rbp` 链，
  因为 `rsp` 是 `push`/`call` 的隐含操作数，而且 `[rsp+off]` 要多一个 SIB 字节。
- **除法要 `cqo`**（`idiv` 是「rdx:rax ÷ 操作数」），商在 `rax`、余数在 `rdx`；
  无符号那两条要先把 `rdx` 清零。四条各一个用例。
- **移位数只认 `cl`**，所以要先搬进 `rcx`。三条各一个用例。
- **整数实参只有六个**（arm64 八个），第七个起走栈，还没做 —— 边界用例盯着。

### 三、`al` 那一条：少了它 `printf` 会崩

SysV 要求调**变参**函数之前 `al` = 用掉的 xmm 个数。被调的是不是变参，这一层不知道
（MIR 里 `CCALL` 只有个名字），所以外部调用**一律**发 `mov al, n` —— 对非变参函数无害
（`al` 是调用者保存的），少了它变参函数会去读没被写过的 xmm。

用例是一个真的变参函数（`double omni_ext_vsum(int n, ...)`，两个 double），
这条在 Rosetta 上是真崩还是真对，一跑就知道。

### 四、浮点比较那张表是重新想的，不是抄的

`ucomisd` 只动 ZF/PF/CF，**根本不动 SF/OF** —— 而整数的 `l`/`le` 看的正是 SF≠OF。
所以照抄整数条件码不是「NaN 上错」那么轻，是**全错**。这一族的形状是：

- `<`/`<=`：**换操作数**再取 `a`/`ae`（`above` 要求 CF=0，NaN 时 CF=1，于是为假）；
- `>`/`>=`：直接 `a`/`ae`；
- `==`：`ZF=1 且 PF=0` —— 两条 `setcc` 加一条 `and`；
- `!=`：`ZF=0 或 PF=1` —— 两条 `setcc` 加一条 `or`。

五条 NaN 用例（`<`/`<=`/`>`/`==` 为假、`!=` 为真）就是为这张表准备的。
arm64 那边同一个坑的长相是「`<` 要用 `mi` 而不是 `lt`」。

### 五、`and rax, 0xffffffff` 是个陷阱

零扩展（i64 -> u32 的规范化）不能用 `and rax, 0xffffffff`：那条的立即数是**符号扩展**的，
`0xffffffff` 会变成 `-1`，于是这条 `and` 什么都不做。正确的是一条 **32 位的 `mov`**
（x86 的 32 位写入天然把高 32 位清零）—— 还短一个字节。

arm64 那边是 `and x, #0xffffffff`，逻辑立即数编得出来，没有这个坑。同一条 MIR、
同一个语义，两条腿上一个是「一条指令的立即数」一个是「换个宽度的 mov」。

### 六、`u64 -> 浮点`明着报

x86 没有「无符号整数转浮点」的指令。32 位的够办（先零扩展再走有符号那条），
64 位的要拆成两半加起来 —— 那是另一片的事，现在明着报。arm64 有 `ucvtf`，一条就完。

**下一片**：两条腿都齐了，往上走还是往下走都行 —— 往上是 C 前端的 native 降级
（现在前端把一切都降到线性内存上，而 native 没有线性内存），往下是可执行文件与
自己的链接器。也可以先补 x86_64 的并合（`link.js` 现在只读 arm64 的 `.o`）。

<!-- 第九刀第十六片-END -->

## 落地：第九刀第十七片

**读入与并合也认两种架构了。**`link.js` 从 `src/core/arm64/` 挪到 `src/core/link/`
（与 `macho.js` 并排），按 cputype 选重定位表、按架构选回填的算法。
`tests/x64/link.js` 21 条（与 arm64 那一份一一对应），真跑过。

### 一、上一片记的那笔账，还掉了

第十五片写着「`link.js` 现在只读 arm64 的 `.o`，读别的架构会按错的表往下读」——
那句话当时是靠一个 `if` 挡住的。现在是一张表：

- `KIND_OF_TYPE` 按架构分两组。**两族的类型号同号不同义**（`2` 在 arm64 是 `BRANCH26`、
  在 x86_64 是 `BRANCH`；`1` 在 arm64 没有、在 x86_64 是 `SIGNED`），
  所以读之前必须先认 cputype，不认就报。
- `readObject` 的返回里多一格 `arch`，`linkObjects` 拿它挑回填的算法，并且**不许混着并**。

### 二、能填的还是那一类，但算法不同

「同一节内的相对跳转」这个判断与架构无关，具体怎么填差得远：

- arm64：`BRANCH26` 是 26 位、单位 4 字节、从**本条指令的开头**算；只换低 26 位。
- x86_64：`BRANCH` 是四字节、从**下一条指令的开头**算 —— 而四字节偏移格总在指令的最后，
  所以「下一条」就是 `at + 4`。

差的那一格是「本条指令的长度」。记错的话跳到的地方**照样是合法指令流**，不崩、只跑错 ——
所以这一格靠真跑来验（乙跨文件调甲、甲再调自己、结果进 libc，三层一齐对上）。

### 三、x86 少一笔账

取一个数据符号的地址：arm64 是 `adrp`+`add` 两条、两笔重定位；x86_64 是
`leaq sym(%rip)` 一条、一笔。测里把这件事写成了断言（甲那个 `.o` 里 `SIGNED` 正好一笔），
这样将来如果谁把 x86 的取址改成两条，账面上会先响。

**下一片**：可执行文件（要 dyld 那一摊与代码签名），或者往上走 —— C 前端的 native 降级。
后者是通往「我们的 tcc 编译 tinycc 自己的源码」的那条路上的下一块石头：前端现在把
一切都降到线性内存上，而 native 这条腿没有线性内存。

<!-- 第九刀第十七片-END -->

## 落地：第九刀第十八片

**MIR 有了 `FRAME`：帧上要一块，拿它的真地址。**这是 native 这条腿上「取地址」的落脚点，
也是 C 前端往 native 降级的第一块石头。两条腿各一条指令：arm64 `add xd, sp, #off`、
x86_64 `lea rd, [rbp - off]`。`tests/arm64/from-mir.js` 78 -> 84、
`tests/x64/from-mir.js` 73 -> 79，都是真跑（x86_64 在 Rosetta 上）。

### 一、为什么前端不能就这么往下走

`tccgen.js` 的头上写着「`&x` 要求 `x` 落在线性内存上」——它把取地址做成了**影子栈**：
`$sp` 是个 i64 全局，减一减得到一个线性内存里的偏移，`&x` 就是那个偏移。
这在 wasm/解释器那条腿上成立，在 native 上一句都不成立：**native 没有线性内存**，
`malloc` 回来的、`sp` 上的、数据段里的，全是同一个地址空间里的真地址。

于是 MIR 缺一条：「在本函数的帧上给我一块，把它的地址给我」。缺了它，前端只能继续
往线性内存上降 —— 而那条路走不到「我们的 tcc 编译 tinycc 自己的源码」。

### 二、静态大小，不是 `alloca`

`FRAME` 的 aux 是**块号**，块记在函数的一张 `frames` 表上（`{name, size, align}`），
大小编译期就定了。这样帧的布局能一遍算出来，`sp` 在函数体里一动不动 ——
正是两条 native 后端现有的口径。变长数组与真 `alloca` 要动栈顶，那是另一片的事；
先把静态的这一格钉死，别让「地址」这件事一上来就带上「栈顶会动」。

`align` 不传就按大小猜（1/2/4/8 里不超过 size 的那个最大的二的幂）—— C 的标量正好是
这个规律；聚合体的对齐由前端说，因为只有它知道成员。

### 三、两条腿的方向相反

- arm64：偏移是**正的**（`sp + off`）。块接在值的栈位后面，深度往上取整到 `align`。
- x86_64：偏移是**负的**（`rbp - off`）。所以要把**深度**往上取整再取负 ——
  把负偏移直接往下取整会算错，这是这一片唯一容易写反的地方。

两边都成立的前提是**基址本身 16 对齐**：arm64 的 AAPCS64 要求 `sp` 16 对齐；
x86_64 进函数时 `rsp ≡ 8`（返回地址），`push rbp` 之后回到 16 的整数倍，
`mov rbp, rsp` 搬来的就是个 16 对齐的基址。于是「偏移是 align 的倍数」等于
「地址是 align 对齐的」，块内不用再留余地。测里把这一条写成了断言
（`frame('c',1)` 之后 `frame('q',8)` 的地址 `& 7 == 0`、`frame('v',16,16)` 的 `& 15 == 0`）。

### 四、怎么证明它是个"真"指针

不是「存进去读回来」就算 —— 那一步线性内存的偏移也能过。这一片的两条关键用例是
**把地址交给真的 libc**：`strlen` 数我们在帧上摆的三个字节、`memcpy` 把串常量搬到帧上
再 `strlen`。libc 不认偏移，只认地址，所以这两条过了才算。

### 五、账面上跟着改的三处

- `verify.js`：aux 的角色是 `n`，所以查块号越界，并且查 `t` 必须是 `T_I64`。
  越界的块号在 native 上是「拿到一个帧外的地址」—— 写进去就把调用者的保存寄存器或
  返回地址改了，而症状要到 `ret` 才出现，离现场已经很远。
- `bytes.js` 的规范文本：多一行 `frame <size> <align>`。**大小与对齐必须进哈希** ——
  「把一个 int 局部量换成 long」生成的指令可以一模一样（都是 `FRAME %0`），差别全在这张表上。
- `OPS` 表**接在表尾**（opcode 是下标，老规矩）。

`interp.js` 与 wasm 那条腿还不认 `FRAME`：它们要把帧块映到影子栈上，那是下一片的事。

**下一片**：C 前端的 native 降级 —— 局部量落到 `FRAME` 上、全局与串常量落到符号上、
libc 直接调，而不是现在这套线性内存 + 影子栈。

<!-- 第九刀第十八片-END -->

## 落地：第九刀第十九片

**C 走通 native 这条腿了。**`lowerCNative` 出的 MIR 没有线性内存，两个后端把它编成
机器码，clang 与一份手写的 `main.c` 链起来，在真机器上跑，**结果与 clang 自己编的
逐字节相同**。`tests/c/native.js` 32 条（14 个用例 × 两条腿 + 一条模块检查 + 三条边界），
arm64 原生、x86_64 走 Rosetta。

### 一、前端只改了一处

`runBody` 的序言里，`fp` 从哪来：

- 线性内存：`$sp -= frameSize`（三条指令 + 每条 RET 前一条收场）。
- native：`FRAME $frame`（一条，没有收场 —— 帧跟着函数走，`ret` 一收全收）。

除此之外**一字不改**：帧的布局、`&x` 是 `fp + 偏移`、聚合体怎么摆、struct 返回的隐藏
形参、`switch` 怎么密集化，两条腿共用同一段代码。这不是巧合 —— 第六刀把「取地址」
收在一个 `fpRef` 上时就是为了留这一手。

### 二、地址模型进了模块

`MirModule` 多一格 `native`（`setNative()`）。理由是 `MLOAD`/`MSTORE` 在两种模型下
**是同一条指令、不同解释**（线性内存里的偏移 vs 真地址）。不立这一格的话，
「这个模块没有 `mem`」既可能是「用不着内存」也可能是「地址是真的」——
verify 于是既不能骂也不能不骂。立了，两边都能查：线性内存那条腿必须有 `mem`，
native 那条腿必须**没有**。两者互斥，`setMem`/`setNative` 各挡一句。

### 三、`switch` 逼出了 `BRTABLE`

第一次真的把 C 喂给后端，第一个撞上的就是 `BRTABLE`（`switch` 落在它上头）。
两条腿都做成**比较链**（`cmp` + 条件跳，最后一条兜底的 `b`），不是真跳表：
真跳表要在数据段里摆一串地址、再靠重定位填（x86 上还得走 `SIGNED`），
而比较链一笔重定位都不欠。密集化早在前端做过了，所以这里只是「等于 k 就跳第 k 项」。
n 大的时候值得换成真跳表，那是窥孔那一片的事。

### 四、还要线性内存的东西，明着报

字符串字面量、带初值的全局量、变长数组、`alloca`、堆、`errno`/标准流 —— 这些现在
都落在线性内存上，native 上一律报错（`lowerCNative` 三条检查 + `spGlobal` 一条）。
悄悄放过去会得到一个指着 64K 的指针：解释器上看不出来，真机器上是段错误，
而且现场离原因很远。测里有三条专门查「该报的报了」。

### 五、oracle 换人了

前面几刀的 oracle 是 tcc（`tcc -run` 的退出码与 stdout）。这一片的 oracle 是
**clang 自己**：同一份 `.c` 加同一份 `main.c`，一边用我们的后端、一边整份交给 clang，
两边 stdout 逐字节比。写死期望值本来也行，但「C 的语义」这件事 clang 比我手算可靠 ——
特别是 `union` 的字节序、二维数组的行主序、`fib(20)` 这种。

**下一片**：字符串字面量与全局量落到**符号**上（后端已经会发 `omni_str_*` 与数据段，
缺的是前端不再往 `dataOff` 上摆）。那之后 `printf("…")` 就能直接调真 libc，
「我们的 tcc 编译 tinycc 自己的源码」这条路上的下一块石头是它。

<!-- 第九刀第十九片-END -->

## 落地：第九刀第二十片

**串常量落到符号上了。**native 上 `"abc"` 不再是 data 段里的一个偏移，而是 MIR 的
串常量 —— 后端把字节发进 `__DATA`、给它一个 `omni_str_<ref>` 符号、取址处记一笔重定位。
`tests/c/native.js` 32 -> 42（多了五个用例 × 两条腿）。

### 一、前端这一处只有三行

`strLit` 里，值从 `consts.int(那个偏移)` 换成 `consts.str(文本)`。去重不用管：
常量池的 `intern` 按文本去重，与线性内存那边的 `this.strs` 是同一个效果 ——
第十片记过这件事（「池就是去重表」），这一片正好用上。

`sizeof("abcd")` 还是 5：类型照旧是 `char[N+1]`，只有**值**换了个来路。

### 二、撞上的那个真错误：桩不能与它转发的符号同名

第一次真跑 `strlen("hello")` 直接段错误。原因不在串常量，在**外部函数的转发桩**：
桩的名字就是 `strlen`，于是它发出去的 `bl _strlen` 跳回自己 —— 无穷递归，
栈满了才崩。线性内存那条腿上不存在这个问题，那边的 `CCALL` 落到宿主的 JS 实现上、
不是符号，所以这个坑只有真链接才踩得到。

改法：native 上把桩改名成 `$ext$strlen`（`MirModule.renameFunc`，`funcIndex` 跟着改），
调用点照旧按函数号 `CALL` 它，它再 `CCALL` 真的 `strlen`。多一跳，换来「一遍过里
调用点可以出现在定义之前」这条不用动。

**症状与原因的距离**是这一片值得记的东西：段错误发生在栈的尽头，而错误在符号表上。
下次看见「我们生成的代码一调 libc 就崩」，先查名字撞没撞。

### 三、还没到的那两格

- **非 ASCII**：MIR 的串常量存的是**文本**，后端写数据段时按 UTF-8 编码，而 C 前端手里
  的 `bytes` 每个字符已经是一个字节 —— 0x80 以上会被编成两个。要一个「字节串」常量
  种类才能收口。现在明着报（测里有一条查它）。
- **`printf`**：变参的桩走的是线性内存那套变参区 ABI（一个指针指向一块自家摆的实参区），
  与 SysV/AAPCS 的变参不是一回事。真 `printf` 要等「变参按真 ABI 传」那一片。

**下一片**：全局量落到符号上。那一格比串常量难 —— 要 `&g`（MIR 现在没有「取全局的地址」）、
要全局的**大小与初值字节**（现在后端一律给 8 个零字节），也就是说要往 MIR 里补一条
`GADDR` 与一张全局的字节表。

<!-- 第九刀第二十片-END -->

## 落地：第九刀第二十一片

**全局量也落到符号上了。**MIR 多一条 `GADDR`（全局的**地址**）与一张全局的字节表
（`setGlobalData`：大小、对齐、初值）。`tests/c/native.js` 42 -> 64：全局的读写、初值、
数组、struct 的成员与初值、`&g`、`char` 数组交给 `strlen`、`double`、函数里的 `static`——
两条腿都与 clang 对上。

### 一、为什么 `GLOAD` 不够

`GLOAD`/`GSTORE` 读写「一格」，那是 wasm 的 `(global …)`。C 的全局量不是一格：
它是**一块地方**，会被取地址（`&g`）、按成员写（`s.x = 1`）、按下标写（`a[i]`）。
所以这一片给 MIR 补了两样东西：

- `GADDR` —— 回那块地方的地址（t = i64），后头照旧接 `MLOAD`/`MSTORE`。
  没让 `GLOAD` 兼职：那会让同一条 op 的 `t` 有两种意思（值的类型 / 地址），
  两条腿各猜一个，而猜错不报错。
- `globalBlob[no]` —— `null` 是老样子（一格，后端 8 个零字节），
  `{size, align, bytes}` 是 C 的全局量。verify 于是能骂「取一格的地址」。

### 二、前端只在最后一步分岔

关键是**没有**为 native 重写一套全局量代码。前端照旧在一块**暂存的线性地址**上摆全局
（`allocGlobal` 与整套初值代码一字不改，包括 `{{1,2},{3,4}}` 那套遍历与位段），
`lowerCNative` 末尾再把每一块按 `[addr, addr+size)` 切出来交给 `setGlobalData`。

于是「初值怎么算」那几百行两条腿共用，差别只在最后一步：一边是 data 段里的偏移，
一边是一个符号。切完之后暂存区**必须空**——剩下的字节说明有东西还落在线性内存上，
放过去就是一个指着 64K 的指针。这一条检查比一开始那句「data 段一个字节都不该有」
精确得多。

### 三、`static` 局部量白拿

函数里的 `static int n;` 在前端本来就是一条全局量登记（名字加料成
`函数名.n.序号`）—— 所以它跟着全局量一起搬完了，一行都没写。测里有一条
`bump()` 连叫三次查这件事。

### 四、还没到的三格

- **外部的全局量**（`extern int x;` 定义在别的翻译单元）：要目标文件里的未定义符号 +
  数据段的重定位。现在明着报。
- **初值里的地址**（`int *p = &g;`、`char *s = "x";` 在文件作用域）：那是数据段里的一笔
  重定位，`macho.js` 还只写代码段的重定位。也明着报（两条边界用例）。
- **16 字节对齐**：`__data` 那一节的对齐字段写死是 8。要 16 得先按内容算那一格。

**下一片**：变参按真 ABI 传 —— 那之后 `printf` 就能直接调真 libc，
`tests/c/gen/` 那批用例才能整批在 native 上跑（现在它们靠宿主那份 JS libc）。

<!-- 第九刀第二十一片-END -->

## 落地：第九刀第二十二片

**变参调用按真 ABI 走了。**`snprintf(b, 32, "%d %.1f %d", 1, 2.5, 3)` 在两条腿上都与
clang 编的结果逐字节相同。`tests/c/native.js` 64 -> 76。

### 一、`CCALL` 的 aux 有了意思：变参的分界

`0` = 不是变参调用；否则「固定实参个数 + 1」。为什么非要这条分界：

- **苹果的 arm64** 把 `...` 后面的实参**一律放栈上**（AAPCS64 的苹果改动），
  固定实参照旧进 x0-x7/v0-v7。
- **SysV 的 x86_64** 把变参也放寄存器里，但要在 `al` 里报浮点实参的个数。

少了分界，后端只能猜；而猜错不报错 —— `printf` 读到垃圾。x86_64 那边其实不看它
（`al` 那条对非变参函数无害，一律发），arm64 那边非看不可。

### 二、arm64 多了一块「出参区」

栈上的实参必须**紧贴 `sp`**（被调方按 `sp` 找它）。所以帧的最底下留出一块出参区，
大小是本函数里最费的那次变参调用要的字节数（按 16 取整），槽位与值的栈位都往上让开。
这一格顺手把「固定实参超过 8 个要走栈」那笔账也开了个头 —— 那一片接着填。

### 三、前端：变参不走桩

第十六片的做法是「一块变参区 + 一个指针」，一个桩装得下所有调用点。真的 libc 读不懂
那块区，所以 native 上变参**跟在固定实参后面一起传**，调用点直接发 `CCALL`
（桩装不下「实参个数各不相同」的调用点）。**定义**一个变参函数还没到：`va_start`
要按真 ABI 把寄存器里那几个实参先泼到栈上，明着报。

### 四、又一个「症状离原因很远」的真错误

第一版全崩，返回值像个截断的指针。原因：每个**声明过**的函数在模块里都已经有一个
MirFunc（一遍过的规矩：调用点可能在定义之前）。没有函数体的那些如果留着原名，
后端就把它们当函数发出去 —— 我们的 `.o` 里于是定义了一个**空的 `_snprintf`**，
链接器拿它盖掉 libc 那个。

`sealExternSymbols` 一次收干净：没有函数体的名字统统改成 `$ext$名字`，再补一条 `RET`。
第二十片记的是「桩不能与它转发的符号同名」，这一片是同一件事的另一半 ——
**凡是没有函数体的名字，都不能出现在我们的符号表里**。

### 五、`auxDigest` 要知道自己在看第几个字段

`CCALL` 的 `a` 与 `aux` 都是数字、意思不同（C 入口号 / 变参分界）。哈希用的规范文本
原来只按 op 分派，于是「固定实参 2 个」会被印成 `cabi:<第 2 个 C 入口的名字>`——
同一个函数的两次不同调用可能哈希成同一串。加了字段号 `k` 才分得开。

**下一片**：`printf` 那批（`tests/c/gen/`）在 native 上整批跑起来 —— 缺的是
`va_start`（变参函数的定义）与堆（`malloc`）。

<!-- 第九刀第二十二片-END -->

## 落地：第九刀第二十三片

**固定实参也能超过寄存器数了，堆也通了。**两条腿都跑十个实参（整数与 double 各一条），
native 上 `malloc`/`free` 就是普通的外部 C 调用。`tests/c/native.js` 76 -> 84；
`tests/arm64/from-mir.js` 84 -> 86；`tests/x64/from-mir.js` 80 -> 81（去掉一条过期的必错）。

### 一、「谁在哪儿」只准算一次

两条腿各多了一个模块级的 `argPlaces(mod, f, args, nfixed)`：按实参的类型与序号返回
每个实参的落点（`{x:n}` / `{v:n}` / `{off:n}`），以及栈上一共要多少字节。上一片写变参时
这段逻辑是内嵌的，这一片把它抬出来 —— **发实参**、**算出参区大小**、**读入参**
（被调方那侧）都得按同一套规则数，三处各写一遍必然会有一处错，而错法是「值到了错的
地方」，不报错、只出垃圾。

`outArgsBytes(mod, f)` 就是拿它扫一遍函数里所有 `CALL`/`CCALL`/`CALLI`，取最费的那次。
非变参调用传 `nfixed = -1`，于是同一个函数管两种。

### 二、被调方那侧：溢出的形参在帧外

调用方把第 9、10 个实参摆在 `sp+0`、`sp+8`；被调方建好帧之后，它们在
`fp + 16`（arm64，跨过存下来的 fp/lr）与 `rbp + 16`（x64，跨过存下来的 rbp 与返回地址）。
序言里照 `argPlaces` 给的 `off` 从那儿读进槽位。两个偏移都是 16 而原因不同，
这是个容易记混、错了又只在第 9 个实参上露的地方。

### 三、native 上没有我们的堆

线性内存那条腿里 `malloc` 是我们自己实现的（`heapUsed` 标记会拉进一段序言）。
native 上没有线性内存可分，那些标记只在 `!this.native` 时才置 —— 于是 `malloc`/`free`
自然落成 `$ext$malloc` 转发的普通外部调用，直接用系统的堆。**不需要新代码**，
只需要不把线性内存那套东西拉进来。

### 四、一条过期的必错

`tests/x64/from-mir.js` 里「七个整数实参（SysV 只有六个寄存器）」原来是「必须报 nyi」，
现在这件事做完了，它就成了假警报，删掉；`tests/arm64/from-mir.js` 的「九个实参」同理
（上一片已删）。必错用例的寿命跟着能力走 —— 能力补上就得同时销掉那条账。

**下一片**：`va_start`（变参函数的**定义**）—— 缺它，`tests/c/gen/` 那批还不能在
native 上整批跑。

<!-- 第九刀第二十三片-END -->

## 落地：第九刀第二十四片

**两条腿都能定义变参函数了。**MIR 多了 `VASTART`/`VAARG` 两条，我们自己编出来的
`f(long long n, ...)` 由 clang 编的 `main` 来调，实参在寄存器里还是溢到栈上都对。
`tests/arm64/from-mir.js` 86 -> 88；`tests/x64/from-mir.js` 81 -> 85。
（前端的 `va_start` 还没接上 —— 那是下一片。）

### 一、为什么 `va_arg` 必须是一条 op

`va_list` 的形状**是 ABI 的一部分**，而 MIR 与架构无关：

- 苹果的 arm64：变参一律在栈上连着放、一格 8 字节（`int` 也占满一格 ——
  clang 发的是 `ldr w9, [x8], #8`），`va_list` 就是个 `char *`。
- SysV 的 x86_64：变参先占寄存器，`va_list` 是 24 字节的
  `{gp_offset, fp_offset, overflow_arg_area, reg_save_area}`，`va_arg` 要分两路。

前端要是自己展开成「读一格、指针加 8」，就得在**选架构之前**知道 va_list 长什么样。
所以前端只说「起个头」（`VASTART`）与「取下一个」（`VAARG`），形状归后端。
两条都拿 va_list 变量的**地址** —— `va_arg` 要就地把它推到下一格。

### 二、arm64 便宜，x86_64 贵

arm64 那边两条 op 各三四条指令：`va_start` 是 `add x, fp, #(16+溢出的固定形参)`，
`va_arg` 是「读一格、加 8、写回」。序言什么都不用做。

x86_64 那边要：
- 序言里把 6 个整数实参寄存器与 8 个 xmm **无条件**泼进一块 176 字节的寄存器保存区
  （clang 会先 `test al, al` 跳过 xmm 那一段；我们不跳 —— 那些寄存器总是在的，
  多写 128 字节换掉一条分支）；
- 每条 `VASTART` 在帧上占一个 24 字节的结构，前端手里那个 8 字节的 `va_list`
  装的是**这个结构的地址**。这不是将就：SysV 里 `va_list` 是 `__va_list_tag[1]`，
  传给 `vfprintf` 时退化成的正是这个指针，所以两边天然对得上；
- `VAARG` 分两路：偏移还没到 48（整数）/176（浮点）就从保存区里取、把偏移推一格，
  否则从 `overflow_arg_area` 取、把它加 8。

### 三、这一批用例查的是「谁摆的」与「谁读的」对不对得上

调用方全是 clang 编的 `main`，实参个数刻意跨过分界：x86_64 那批里「八个 i64」
让后三个溢到栈上、「十个 double」让后两个溢出去，两路都走到。
`i32` 那条传了个负数 —— 零扩展的话答案会大出 2³²，而这种错在寄存器那一路上
最容易漏（低 32 位看着全对）。

### 四、记在账上的

- `va_copy` 在 x86_64 上还是**别名**（我们的 `va_list` 是指向结构的指针，赋值只复制
  指针），SysV 要的是复制结构本身。arm64 上赋值就是对的。
- 一个函数里两个 `va_list` 各有自己的结构（按 `VASTART` 的条数分），所以那件事不欠。
- `float`/`bool` 的 `VAARG` 明着报：C 的默认提升让它们过不来。

**下一片**：前端接上 —— `__builtin_va_start`/`va_arg` 在 native 上落到这两条 op，
`tests/c/gen/` 那批（`printf` 那一族）就能在 native 上整批跑。

<!-- 第九刀第二十四片-END -->

## 落地：第九刀第二十五片

**C 的 `va_start`/`va_arg` 在 native 上接上了。**自己定义的变参函数与 clang 编的
逐字节一致：`vsum(10, 1..10)`、十个 double、`i64 + double + 指针`混着、
以及把 `va_list` 当形参传给别人（`vprintf` 那个形状）。`tests/c/native.js` 84 -> 96。

### 一、前端的两条腿差别只有三处

- 定义一个变参函数时：线性内存那条腿加一个隐藏形参（变参区的地址），native 上
  **什么都不加**，只在 `MirFunc` 上按一位 `setVariadic()`。
- `va_start`：那边把隐藏形参存进 ap，这边发一条 `VASTART`，实参是**ap 的地址**。
- `va_arg`：那边算「格子多大、指针加几」，这边发一条 `VAARG` —— 格子在哪儿归后端。

取 ap 的地址顺带解决了「ap 得在内存里」：两遍过的机制第一遍记下「这个名字被取过址」，
第二遍它就落在帧上了（`addrOf` 里那一段），不用为 `va_list` 单开一条规则。

### 二、`va_arg` 不要求所在函数是变参的

第一版的 verifier 两条 op 都要求 `f.variadic`，`vrelay(int n, va_list ap)` 当场被判不良构。
C 里「收一个 `va_list` 形参、替别人取实参」是合法而且常见的（`vfprintf` 就是那个形状）——
只有 `va_start` 才必须在变参函数里。这条用例是照着 `vprintf` 写的，一写就把规则写错的地方顶出来了。

### 三、比 int 窄的类型再削一刀

后端只按 i32/i64/f64 三种宽度取。`va_arg(ap, char)` 取回来的是**提升之后**那个 int，
所以前端再补一次到 `char` 的转换 —— 不补的话「取回来的值当 char 用」时才现形。

### 四、`va_copy` 在这条腿上明着报

native 的 `va_list` 是「指向后端那个 va_list 的指针」，直接赋值只复制指针：
arm64 上恰好是对的（那边 va_list 本身就是个指针），SysV 上两个 ap 会互相牵动。
与其静默地错，先报出来 —— 要做对得让后端再出一条 `VACOPY`。

**下一片**：`tests/c/gen/` 那批（`printf`/`vprintf` 一族）在 native 上整批跑
—— 缺的已经不是 ABI，而是那批用例现在还只走线性内存那条腿。

<!-- 第九刀第二十五片-END -->

## 落地：第九刀第二十六片

**`gen/` 那一批开始在 native 上整批跑了：83 条里 48 条编成真机器码、链起来、
跑出与 `tcc -run` **逐字节相同**的 stdout 与退出码。**新增 `omni c-obj`
（`.c` -> `.o`）与 `tests/c/native-gen.js`（同一个 oracle，我们这一侧换成真进程）。

### 一、真 C 一上来就顶出一个真错误：帧超过 4096

`03-inttypes` 是 bus error，PC = 3。原因在序言上：

```js
// 错的
this.movImm(TMP0, BigInt(this.frame));
buf.emit(a.subReg(1, SP, SP, TMP0));     // 编出来是 sub xzr, xzr, x9
```

add/sub 的**移位寄存器形式**里 31 号是 `xzr`、不是 `sp`（`sp` 只在立即数形式与扩展
寄存器形式里）。于是那条是空指令：`sp` 没降下来，随后的 `str [sp, #off]` 写进
**调用者的帧**，把返回地址盖掉 —— 症状（回不去）离原因（一个编码的坑）非常远。
改成两条立即数形式（`lsl #12` 那一位摆得下「多少个 4096」）：

```js
const hi = Math.floor(this.frame / 4096);
const lo = this.frame % 4096;
if (hi > 0) buf.emit(a.subImm(1, SP, SP, hi, 1));
if (lo > 0) buf.emit(a.subImm(1, SP, SP, lo));
```

从前的用例全都只有小帧，所以这条路一次都没走过。**这就是要拿真 C 来跑的理由。**

### 二、还没做的东西要**拒**，不能让它崩在别人家里

`31-qsort` 原本是段错误：函数指针的值在线性内存那条腿上是「函数号 + 1」——
一个只有解释器认得的小整数，交给 libc 的 `qsort` 就是让它跳到地址 3。
崩的位置在别人的栈帧里，堆栈上连我们的名字都没有。
所以前端在「函数名当值用」那一格直接明着报，同理 `__omni_*`（errno 与三条标准流那套
宿主接口）也在这儿拒 —— 放过去只会得到一条 `ld: symbol not found`。
**「还没到」不算失败，崩掉才算。**

### 三、两条问不出同一个答案的用例

`37-argv` 数的是 `argv`，而 `tcc -run x.c` 的 argv[0] 是源文件路径、我们的是可执行文件
的路径。`82-flex-init` 印的是**两个全局之间的距离** —— C 不保证不同对象的相对位置
（6.5.6 第 9 段），我们的 `__data` 摆得比 tcc 松。两条都记在 `SKIP` 里连理由一起写。

### 四、一条防线：`MIN_OK`

能编能跑的条数不许比 46 少。少了就是回归 —— 某个用例从「能编」退回「明着拒」，
而那种退步不看这一行是发现不了的（它会静静地混进「还没到」那一堆里）。

**还没到的 33 条，按堆分**：函数指针（6 条，要 MIR 的「取函数地址」与两条腿的
`CALLI`）、全局初值里的地址与串（8 条，要数据段里的重定位）、`va_copy`（3 条）、
宿主那几格 errno/标准流（3 条）、变长数组与 alloca（3 条）、16 字节对齐的全局（3 条）、
非 ASCII 串常量（2 条）、复合字面量与宽字符还落在线性内存上（2 条）、其它 3 条。
**下一片**：函数指针 —— 那一堆最大，而且它挡着 `qsort`/`ctype` 这类真程序。

<!-- 第九刀第二十六片-END -->

## 落地：第九刀第二十七片

**函数指针在 native 上是真地址了。**`gen/` 那一批从 48 条涨到 50 条，
`qsort`/`ctype` 这类「把函数交给 libc」的程序不再是段错误。

### 一、值：`FADDR`，不复用 `GADDR`

线性内存那条腿上，函数名当值用得到的是「函数号 + 1」—— 一个只有解释器认得的小整数
（表里的下标）。native 要的是符号的**真地址**，所以 MIR 上新加一条：

```js
['FADDR', '-', '-', 'n'],   // aux = 函数号，t = T_I64（地址）
```

为什么不复用 `GADDR`：那一条取的是**数据符号**的地址，落在 `__DATA`；函数落在
`__TEXT`。两节的重定位不是一回事（arm64 上都是 `ADRP`+`ADD` 的一对，但符号来自
两张不同的表），而且 `GADDR` 的 aux 是全局量号、`FADDR` 的是函数号 —— 编号空间不同，
混用会在「号越界」这一格上悄悄错过去。校验器因此各管一边：`FADDR` 只查 `mod.funcs`，
并且只在 `mod.native` 上放行。

摘要（`bytes.js`）里 aux 印的是**名字**而不是号：`faddr:qsort`。号会随函数表增删而变，
名字不会 —— 摘要要的是「同样的程序摘出同样的串」。

### 二、调用：`CALLI` 落到 `blr` / `call *r`

`CALLI` 早就在 MIR 上（线性内存那条腿走的是函数表 + 类型检查），native 这边只是把
实参照真 ABI 摆好、把被调地址装进一个临时寄存器，然后：

- arm64：`a.blr(TMP0)`
- x64：`x.callR(TMP0)`

实参与返回值完全复用 `CCALL` 那两个函数（`callArgs` / `callRet`）—— 间接调用与直接
调用的差别只有「跳哪儿」这一条指令，别的一模一样。这一点值得说出来：
如果两边的实参摆法各写一遍，变参那一片改 ABI 时就会漏掉一处。

### 三、还欠一格：外部变参函数的地址

`&printf` 在 native 上还不行，并且**明着拒**。原因不在函数指针这一格，在符号那一格：
没有函数体的名字，我们眼下会改名成 `$ext$<name>` 再补一个只有 `RET` 的桩，
而变参的外部函数连桩都不补（第二十五片的决定）。`FADDR` 取到的就会是那个空桩的地址 ——
调用它什么都不做，答案静静地错。要把这一格补上，得先让「没有函数体的名字」在 `.o` 里
成为**未定义符号**而不是桩，那是另一片的事。

### 四、验到哪一步

`tests/c/native.js` 加了七条（直接调、当实参传下去、一张表、改指向、比一比、
返回 `double` 的、`(*f)(x)` 这种写法），110 条全过 —— 两条腿都真跑，x86_64 在 Rosetta 上。
`tests/c/native-gen.js` 现在 **50 passed, 0 failed, 31 not yet, 2 skipped**，`MIN_OK` 提到 50。

**还没到的 31 条，按堆分**：全局初值里的地址与串（8 条，要数据段里的重定位）、
`va_copy`（3 条）、宿主那几格 errno/标准流（3 条）、变长数组与 alloca（3 条）、
16 字节对齐的全局（3 条）、非 ASCII 串常量（2 条）、复合字面量与宽字符还落在线性内存上
（2 条）、外部变参函数的地址（1 条）、其它 6 条。
**下一片**：数据段里的重定位 —— 现在它是最大的一堆，而且 `&printf` 那一格也拴在同一根桩上。

<!-- 第九刀第二十七片-END -->

## 落地：第九刀第二十八片

**初值里的地址落成了数据节的重定位。**`gen/` 那一批从 50 条涨到 **61 条** ——
一次十一条，是这一刀里最大的一跳。原因是这一格挡着的东西多：静态的指针表、
`char *msg = "…"`、`&g`、指着成员的指针、函数指针的全局，全都拴在同一根桩上。

### 一、一条重定位：`POINTER64`

数据节里的一个八字节指针，两种架构的类型号**都是 0**（`ARM64_RELOC_UNSIGNED`
与 `X86_64_RELOC_UNSIGNED`），语义也一样：链接器把**原地那八个字节当加数**，
加上符号的地址写回去。所以这一格不分架构，`RELOC_TYPE` 里一个名字就够。

写出这边有两处得改：

- 重定位表是**一节一张**。节头里的 `reloff`/`nreloc` 各归各的，而 `r_address` 是
  **节里的偏移**。混成一张的话代码的 0x10 与数据的 0x10 会撞在一起 —— 链接器会
  拿数据的坑去填代码。
- 长度那一位从前是写死的 2（四个字节）。指针是 8，所以 `RELOC_TYPE` 里多一格 `len`。

读回那边（`readObject`）现在**明着报**「数据节里有 N 条重定位，还不会读回」。
悄悄漏掉的后果是一个指着 0 的指针，而那比报错难查得多。

### 二、加数从哪儿来：把那一小段指令反着读一遍

C 里静态初始化式的指针值只能是「某个对象或函数的地址 ± 一个整型常量」
（C11 6.6 第 9 段）。线性内存那条腿上这整件事是**一个数**（地址就是编译期常量），
native 上算不出来。

那一格本来就在一个用完就丢的 `MirFunc` 里解析（第四十八片的手法：借表达式一路，
于是指针算术的缩放、数组退化、`&s.f` 的成员偏移都不用重写）。所以这一片只是在
「算不出数」之后多问一句：把那几条指令**反着读**——`GADDR`/`FADDR`/串常量是根，
`ADD`/`SUB` 一个整数往上摞。摞出来就是 `{符号, 加数}`。

为什么不学 tcc 在 `SValue` 上带一个 `sym` 字段：那要求每一处造 `SValue` 的地方都
记得传它，而**漏掉一处的后果是静静地丢掉符号、只剩加数**。反着读只此一处，漏不掉。

顺手多了一个 `kfoldOf`：`arr + 2` 里「乘元素大小」是一条真的 `MUL`（这一层不折叠
常量，见文件头偏离 3），所以加数不是一个常量 ref 而是一小棵树。折叠放在这儿而不是
放回 `genPtrOp` —— 那一层多折一次会改掉每个函数体里的指令，这一格只影响
「静态初始化式认不认这个加数」。

### 三、范围指定初始化器上摔了一次

`char *gs[4] = {[0 ... 1] = "BB", [2 ... 3] = "CC"};` 印出 `BB (null) CC (null)`。

范围的后几格是**复制头一格的字节**（跟着 tcc：`[0 ... 2] = f()` 只叫一次 `f`）。
字节复制了，可是那条「指着串常量」的记录没复制 —— 于是第二格是八个零。
补一句「落在这一格里的 fixup 也跟着挪」就好了。挑的办法是**按偏移**而不是按
`mark`：这一格刚清零刚写，别人的地址不会落在里面。

### 四、验到哪一步

- `tests/c/native.js`：124 条（新增八条 —— 指着全局、带正加数、带负加数、指着成员、
  串常量、串常量带加数、一张串的表、一个函数），两条腿都真跑。
- 顺手删掉两条过期的「必须拒」用例（初值里的串常量与地址）——它们正是这一片做的事。
- `tests/c/native-gen.js`：**61 passed, 0 failed, 20 not yet, 2 skipped**，`MIN_OK` 提到 61。

**还没到的 20 条，按堆分**：`va_copy`（3 条）、宿主那几格 errno/标准流（3 条）、
变长数组与 alloca（3 条）、16 字节对齐的全局（3 条）、非 ASCII 串常量（3 条）、
复合字面量与宽字符还落在线性内存上（2 条）、`va_arg` 取 struct（1 条）、
外部变参函数的地址（1 条），外加一条**新露头**的：`09-init` 的帧偏移 4672 太大
（走到这一步才碰到 —— 一条 `ldr` 的立即数装不下那么大的偏移，要先把基址搬进寄存器）。

**下一片**：那条帧偏移 —— 它是一个真的编码上界，而且与第二十六片的「sub sp 装不下」
是同一类东西（真程序一大就碰）。

<!-- 第九刀第二十八片-END -->

## 落地：第九刀第二十九片

**两个上界。**`gen/` 那一批 61 -> **65 条**。这一片没有新概念，只有两个「真程序一大
就碰到、小程序永远碰不到」的编码/布局上界 —— 与第二十六片那个 `sub sp` 是同一类东西。

### 一、帧偏移过 4096：`add` 的立即数装不下

`FRAME`（`&x` 在 native 上就落在这儿）从前是一条 `add rd, sp, #off`。`off` 只有 12 位，
所以帧里第二块往上一点就装不下。`09-init` 的第 4672 字节就是这么露头的。

改法与序言里降 `sp` 那两条一样：高位一条带 `lsl #12`，低位一条跟着。

```js
buf.emit(a.addImm(1, RES, SP, hi, 1));
if (lo > 0) buf.emit(a.addImm(1, RES, RES, lo));
```

**不能**走「先 `movImm` 造出偏移再 `add` 移位寄存器形式」—— 那个形式里 31 号是 `xzr`
不是 `sp`（第二十六片查了半天的那个真错误）。同一个坑，第二次遇到时是免费的。

`frameLoad`/`frameStore` 的 32760 那条上界还在：`ldr` 的无符号偏移形式按 8 缩放，
所以它比 `add` 宽得多，眼下的程序还够不着。

### 二、`__data` 的对齐从写死的 8 改成按内容算

`int x __attribute__((aligned(32)))` 从前被明着拒。原因在目标文件那一头：节头里的
对齐字段写的是常数 3（2^3 = 8）。现在 `writeObject` 多收一个 `dataAlign`，
两条腿的 `genModule` 顺手把「所有全局里最大的那个对齐」算出来一起交上去。
段里数据节的起点（`dataAddr`）也跟着按它对齐 —— 符号的 `n_value` 是**段里的地址**，
这两个数不一致的话链接器会说符号不在它该在的节里。

上界取 4096（一页）。取这个数没有什么深理由，只是「再往上就该问你到底在摆什么」。

### 三、验到哪一步

- `tests/c/native.js`：128 条（新增两条 —— 一个 5000 字节数组之上再取一个局部的地址、
  一对 16/32 字节对齐的全局，两条腿都真跑）。
- `tests/c/native-gen.js`：**65 passed, 0 failed, 16 not yet, 2 skipped**，`MIN_OK` 提到 65。

**还没到的 16 条，按堆分**：`va_copy`（3 条）、宿主那几格 errno/标准流（3 条）、
非 ASCII 串常量（3 条）、变长数组与 alloca（3 条）、复合字面量与宽字符还落在
线性内存上（2 条）、`va_arg` 取 struct（1 条）、外部变参函数的地址（1 条）。

**下一片**：`va_copy` 或非 ASCII 串常量 —— 两堆都是三条，而非 ASCII 那一堆更浅
（常量池现在只有「文本」这一种串，要的是「一串字节」）。

<!-- 第九刀第二十九片-END -->

## 落地：第九刀第三十片

**串常量多了一种：字节。**`gen/` 那一批 65 -> **66 条**（`49-braced-str`），
另外两条非 ASCII 的用例（`38-bytes`、`51-wide-str`）往前挪到了下一个坎上 ——
现在挡着它们的是宿主的标准流与宽串，不再是这一格。

### 一、`str` 与 `bytes` 必须是两种

MIR 的串常量从前只有一种：`str`，`text` 存的是**文本**，后端写数据段时按 UTF-8 编码。
对 ASCII 那是恒等，所以一直没露馅。可 C 的串字面量里 `"\xe4\xb8\x96"` 是**三个字节**，
而作为三个「字符」各自的 UTF-8 编码是六个字节 —— 那不是同一块内存。

所以加一种：

```js
bytes(bs) { /* text 是十六进制 */ return this.intern(T_STR, 'bytes', hex); }
```

`text` 用十六进制而不是「每个字节一个 charCode」：常量池是**按文本去重**的，
而十六进制与字节串一对一，并且摘要（`bytes.js`）印出来还是可打印的 ——
把裸字节塞进 `text` 会让摘要里出现控制字符，那种文件将来 diff 起来是灾难。

前端挑哪一种只看内容（`strConst`）：全是 ASCII 走 `str`，有 0x80 以上的走 `bytes`。
不一律用 `bytes` 是因为 `str` 是另外几条腿也在用的那一种，而且印出来可读。
挑法只依赖字节内容，所以「同一个字面量只有一份」照旧成立。

### 二、两条腿各改两行

数据段那一段的条件从 `kind !== 'str'` 变成「`str` 或 `bytes`」，
「怎么变成字节」那一步分两路（`utf8Bytes` / `hexBytes`）。取地址那一路（`loadRef`）
同理多认一种 —— 对它来说两种串完全一样，都是「一个符号的地址」。

### 三、验到哪一步

`tests/c/native.js`：133 条（新增三条 —— 局部的非 ASCII 串、全局初值里的非 ASCII 串、
`strlen` 数出来还是字节数）。写这几条时踩了 C 的一个真规则：`"\x96ab"` 里 `\x`
会**尽量多吃十六进制位**，于是 `\x96ab` 越界 —— 得写成 `"\x96" "ab"`。
（clang 报的 `hex escape sequence out of range` 就是这个。）

`tests/c/native-gen.js`：**66 passed, 0 failed, 15 not yet, 2 skipped**，`MIN_OK` 提到 66。

**还没到的 15 条，按堆分**：宿主那几格 errno/标准流（4 条）、变长数组与 alloca（3 条）、
`va_copy`（2 条）、还落在线性内存上的（3 条：复合字面量、宽串两条）、
`va_arg` 取 struct（1 条）、外部变参函数的地址（1 条）、其它 1 条。

**下一片**：宿主那几格 —— 现在它是最大的一堆，而且做法是清楚的
（`__omni_errno_location` 映到 `__error()`、`__omni_stdout` 映到 `__stdoutp`）。

<!-- 第九刀第三十片-END -->

## 落地：第九刀第三十一片

**宿主的那几格通了：errno、标准流、外部的全局量。**`gen/` 那一批 66 -> **70 条**
（`24-errno`、`35-streams`、`40-perror`、`58-fputs`）。

### 一、外部的全局量：`globalBlob` 上多一种「没有内容」

从前 `globalBlob[i]` 只有两种：`null`（wasm 那种一格的全局）与 `{size, align, bytes, fixups}`。
native 上还需要第三种 —— **只声明、别处定义**：

```js
setGlobalExtern(i, size, align) {
  if (!this.native) throw new Error('mir: 外部的全局量只有 native 这条腿上有');
  this.globalBlob[i] = { size, align, bytes: [], fixups: [], extern: true };
}
```

只在 native 上有，是因为 wasm 那条腿的全局是模块内的一格，「未定义」在那里没有意义。
两条后端在铺数据段时 `continue` 掉这一种：不占 `__data` 的字节，于是它在 `.o` 里
自然就是个**未定义符号**，链接时由别的 `.o` 或 dylib 供上。

### 二、`adrp` 到不了住在 dylib 里的东西 —— 要过 GOT

先按老路走（`adrp` + `add`），链接器直接顶回来：

```
ld: fixup error (kind=arm64_adrp_lo12) … target '___stdoutp' does not have address
```

这不是编码错，是**原理上不可能**：`adrp` 算的是「本镜像里某一页的地址」，
而 `__stdoutp` 在 libSystem 里 —— 链接时它根本没有页号。这一类只能间接来一步：
先取 GOT 里那一格的地址，再从那一格里**读出**真地址。

```js
// arm64
adrpSymGot(rd, sym)  // ARM64_RELOC_GOT_LOAD_PAGE21   = 5
ldrSymGot(rt, rn, sym)  // ARM64_RELOC_GOT_LOAD_PAGEOFF12 = 6
// x86_64
loadSymGot(reg, name)  // mov reg,[rip + sym@GOTPCREL]，X86_64_RELOC_GOT_LOAD = 3
```

代价是多一次内存访问。省不掉：本地定义的全局仍走 `adrp`/`lea`，
分岔就一句（`globalAddr` / `isExternGlobal`），`GLOAD`/`GSTORE`/`GADDR` 三处都走它。

### 三、`errno` 只是改个名，标准流不是

`errno` 在 macOS 上是 `*__error()` —— 一个函数。我们的 `__omni_errno_location`
形状与它一样（返回 `int *`），所以只要**改个名**就行：

```js
const NATIVE_CNAME = new Map([['__omni_errno_location', '__error']]);
```

标准流不行。`stdout` 在 macOS 上是 `__stdoutp`，那是一个**变量**，
而我们这边 `__omni_stdout` 是个**函数**。改名不成 —— 名字改过去了，
调用点还是 `bl`，跳到一个数据地址上去。所以给它一个**真的身子**：

```js
streamThunk(name, info) {
  const gno = this.mod.globalNo(NATIVE_STREAM_SYMS.get(name));
  this.mod.setGlobalExtern(gno, 8, 8);
  const v = f.emit(OP.GLOAD, T_I64, REF_NONE, REF_NONE, gno);
  f.emit(OP.RET, T_I64, v, REF_NONE, 0);
}
```

一格 `GLOAD` 加一个 `RET`。原来那个没身子的名字照旧被 `sealExternSymbols` 改成
`$ext$__omni_stdout`（第二十六片的规矩：任何没身子的名字都要改名，不许和真 libc 撞）。

### 四、验到哪一步

`tests/c/native.js`：**144 passed**（新增六条 —— 读、写完读回、数组、取地址、
住在 dylib 里的 `__stdoutp`、`*__error() = 42`）。`host_g` 与 `host_arr` 的**定义**
放在 clang 编的 `main.c` 那一边，probe.c 只声明 —— 于是它们在我们的 `.o` 里
是未定义符号，正好是要验的那件事。边界那一节里「外部的全局量必须明着报」这一条
删掉了（它已经不成立）。

`tests/c/native-gen.js`：**70 passed, 0 failed, 11 not yet, 2 skipped**，`MIN_OK` 提到 70。

**还没到的 11 条，按堆分**：`va_copy`（3 条）、变长数组与 alloca（3 条）、
还落在线性内存上的（3 条：复合字面量、宽串两条）、`va_arg` 取 struct（1 条）、
外部变参函数的地址（1 条）。

**下一片**：`va_copy` —— 三条里最大的一堆，而且是一个新的 MIR 指令（`VACOPY`）就够。

<!-- 第九刀第三十一片-END -->

## 落地：第九刀第三十二片

**`va_copy` 通了。**`gen/` 那一批 70 -> **73 条**（`17-vararg`、`28-headers`、`32-vprintf`）。

### 一、为什么它不能是一条 `MSTORE`

前端手里的 `va_list` 是 8 个字节，看着「抄那 8 字节」就完了。可那 8 字节装的东西
两条 ABI 上不是一回事：

- 苹果 arm64：它**就是**那个游标（一个 `char *`）—— 抄了就对。
- SysV x86_64：它是**指向**那个 24 字节结构的指针 —— 抄指针会让两个 `ap` 共用一个
  游标，于是 `va_arg(ap2)` 把 `ap` 也推了一格。

C 说 `va_copy` 之后两个 `va_list` 是**互不相干**的（7.16.1.2），所以在 arm64 上
恰好对的那个写法在 SysV 上是错的。第二十五片当时把它挡住（`todo`）而不是发出去，
就是因为这种「一条腿上恰好对」的错**在另一条腿上是静默的**。

所以照 `VASTART`/`VAARG` 的老规矩来：形状归后端。

```js
['VACOPY', 'r', 'r', 'n'],    // a = dest 的地址，b = src 的地址，t = T_I64
```

两个实参都是**变量的地址**（不是值）—— 后端要就地写 dest。

### 二、arm64 四条指令，x86_64 要另开一块

arm64 上就是抄那 8 字节：

```js
this.loadRef(TMP0, f.b[i]);
buf.emit(a.ldrU(3, RES, TMP0, 0));
this.loadRef(TMP0, f.a[i]);
buf.emit(a.strU(3, RES, TMP0, 0));
```

中转用 `RES` 而不是 `TMP1`：中间还要再调一次 `loadRef`，而这一条不产值，`RES` 闲着。

x86_64 上要给 dest **另开一块** 24 字节的结构，把源那三个 8 字节抄进去，
再把新那块的地址写进 dest 那个变量。帧上那块的分配跟着 `VASTART` 那套走
（`vaOffs`），只是那个循环得从 `if (f.variadic)` 里**搬出来**：

```js
if (f.op[k] === OP.VASTART || f.op[k] === OP.VACOPY) { bytes += 24; this.vaOffs.set(k, -bytes); }
```

搬出来是必须的 —— 收一个 `va_list` 形参、抄一份自己用的那种函数（`vfprintf`
那个形状）**自己不是变参的**，可它照样要一块新结构。`verify` 那边同理：`VACOPY`
与 `VAARG` 一样不要求 `f.variadic`，只有 `VASTART` 要求。

### 三、验到哪一步

`tests/c/native.js`：**152 passed**（新增四条）。这几条的形状都是「抄完之后两边
各走一遍」—— 只抄指针的话第二遍会从第一遍停下的地方接着读，那正是要抓的错。
其中一条刻意用十个 `int`（跨过 SysV 那六个寄存器的线），一条在走了一格之后才抄
（抄的是当前游标，不是起点），一条在收 `va_list` 当形参的函数里抄。

`tests/c/native-gen.js`：**73 passed, 0 failed, 8 not yet, 2 skipped**，`MIN_OK` 提到 73。

**还没到的 8 条**：变长数组与 alloca（3 条：`70-vla`、`73-stmt-expr-label`、`83-alloca`）、
还落在线性内存上的（3 条：`61-compound-literal` 43 字节、`51-wide-str` 32 字节、
`78-wide-printf` 120 字节）、`va_arg` 取 struct（1 条）、外部变参函数的地址（1 条）。

**下一片**：还落在线性内存上的那三条 —— 变长数组要一个真能动的栈顶，
比这三条大得多，而这三条是「局部的初值还在往线性内存里摆」，与第二十八片同一个手法。

<!-- 第九刀第三十二片-END -->

## 落地：第九刀第三十三片

**宽串字面量上 native 了。**`gen/` 那一批 73 -> **75 条**（`51-wide-str`、`78-wide-printf`）。

### 一、与窄串同一个办法，只是「一格四字节」

第二十片把窄串搬到了 MIR 的串常量上（`__DATA` 的一个符号 + 一笔重定位），
宽串当时留在线性内存里，于是这两条用例的报错是「有 32 / 120 个字节还落在线性内存上」。

搬法一模一样，第三十片那个 `bytes` 种类正好装得下 ——
一格四字节小端、末尾一格 0，`wstrData` 铺的就是这些字节：

```js
wstrConst(vals) {
  const raw = [];
  for (const v of [...vals, 0]) {
    const u = v >>> 0;
    raw.push(u & 255, (u >>> 8) & 255, (u >>> 16) & 255, (u >>> 24) & 255);
  }
  return this.mod.consts.bytes(raw);
}
```

三处用它：当表达式用（`wstrLit`）、全局的初值里当指针用（`initScalar` 那一路走
第二十八片的 `putSymBytes`，落成一笔 `POINTER64`）。第三处 —— 把宽串的地址当成
**整型常量**（`(uintptr_t)L"ab"`）—— 照旧明着报：那要在编译期知道地址，
而 native 上地址要等链接。窄串那边 `strData` 的那条 todo 是同一件事。

### 二、串常量的符号得对齐

这一片唯一的新账：从前串常量在数据段里是**紧挨着**摆的。窄串无所谓（一格一字节），
可宽串的地址会被交给按 `int` 读的代码。于是两条后端各加一行：

```js
while (dataBytes.length % 8 !== 0) dataBytes.push(0);
```

一律 8 而不是「按内容算」：按内容算要在常量池里给每一条串多记一个对齐字段，
而 8 是所有 C 标量对齐的上界 —— 多几个填充字节换掉一个字段和一路判断。

### 三、验到哪一步

`tests/c/native.js`：**164 passed**（新增六条 —— 按格读、`sizeof` 是格数乘四、
末尾那一格是 0、`\u00e9` 一格一个码位、全局初值里的宽串指针、铺进全局数组）。
这几条一律写 `int` 而不是 `wchar_t`：这个目标上它就是 `int`，而那份 SUPPORT
没有 `stddef.h`。

`tests/c/native-gen.js`：**75 passed, 0 failed, 6 not yet, 2 skipped**，`MIN_OK` 提到 75。

**还没到的 6 条**：变长数组与 alloca（3 条）、静态的复合字面量（1 条：
`61-compound-literal`，43 字节还在线性内存上）、`va_arg` 取 struct（1 条）、
外部变参函数的地址（1 条）。

**下一片**：静态的复合字面量 —— 它要的是「一个**没有名字**的全局」，
而现在这条路上全局是按名字建的。

<!-- 第九刀第三十三片-END -->

## 落地：第九刀第三十四片

**静态的复合字面量上 native 了。**`gen/` 那一批 75 -> **76 条**（`61-compound-literal`）。
线性内存那一栏现在**空了** —— 剩下的五条没有一条是「还有字节落在 64K 上」。

### 一、它要的是「一个没有名字的全局」

`int *cinit2 = (int []){3,2,1};` 在文件作用域上是一块**静态存储期**的数据
（C11 6.5.2.5 第 5 段），可它没有名字。而这条腿上数据段里的每一块都是按名字建的。

名字编出来就行（`$cl$0`、`$cl$1`……，按出现顺序），于是「同一份输入两次编译逐字节
相同」照旧成立。切块那一段与有名字的全局一字不差 —— 少了「试探性定义」与「外部的」
两种情况而已。

### 二、地址那一半：按**区间**认，不在表达式一路上带字段

第二十八片认地址常量靠 `symConstOf`：往回走那条 `GADDR`/`FADDR`。这一片不能照抄 ——
静态的复合字面量在前端里照旧先摆进**暂存区**（那一整套 `initializer` 一字不改，
含 `staticRead` 把字节读回来那一格），所以算出来的是「暂存区里的一个数」，
一个**真的常量**，只是那个数指着 64K 那一带。

于是这一格反过来：`kintOf` **算出来了**之后再问一句「这个数落在哪个匿名块里」。

```js
anonFixOf(k) {
  const at = Number(k);
  for (const b of this.anonStatics) {
    if (at >= b.addr && at < b.addr + b.size) {
      return { kind: 'g', no: b.gno, add: BigInt(at - b.addr) };
    }
  }
  return null;
}
```

按区间认而不是在表达式一路上多带一个「我来自哪一块」的字段：那条路上地址会经过
下标、成员、指针算术好几手（`(int []){4,5,6} + 2` 就是三手），每一手都记得捎上它
是行不通的 —— 那正是第二十八片不学 tcc 往 `SValue` 里塞 `sym` 的同一个理由。

### 三、验到哪一步

`tests/c/native.js`：**176 passed**（新增六条 —— 数组、取 struct 的地址、
`char []` 交给真的 `strlen`、标量的那一种（值就是里面那一项，没有符号可谈）、
没写满的那几格是 0、地址加了偏移）。

`tests/c/native-gen.js`：**76 passed, 0 failed, 5 not yet, 2 skipped**，`MIN_OK` 提到 76。

**还没到的 5 条**：变长数组与 alloca（3 条）、`va_arg` 取 struct（1 条）、
外部变参函数的地址（1 条）。

**下一片**：外部变参函数的地址（`20-fnty`）—— 一条，而且是「没身子的名字要成为
目标文件里的未定义符号」这一件事，比变长数组那一堆小得多。

<!-- 第九刀第三十四片-END -->

## 落地：第九刀第三十五片

**外部变参函数的地址通了。**`gen/` 那一批 76 -> **77 条**（`20-fnty`）。
剩下的四条里三条是同一件事（变长数组与 alloca）。

### 一、`&printf` 不能取我们那个名字

native 上变参外部符号**没有桩**（第二十二片：一个桩装不下「实参个数各不相同」的
调用点），于是我们的 `.o` 里 `$ext$printf` 只剩一条 `RET`。取它的地址会拿到一个
什么都不做的函数 —— 调它不报错，只是什么都不发生，而那种错离原因很远。

要取的是**真 libc 里那个符号**的地址。它在这个 `.o` 里是未定义的，于是这件事与
第三十一片那个「住在 dylib 里的外部全局量」一模一样：过 GOT。

```js
const gno = this.mod.globalNo(name);
if (this.mod.globalBlob[gno] === null) this.mod.setGlobalExtern(gno, 8, 8);
fptr = this.f.emit(OP.GADDR, T_I64, REF_NONE, REF_NONE, gno);
```

不新加一条「取 C 入口的地址」的 MIR 指令：`GADDR` 加上外部全局量这两样已经**恰好**
是「一个未定义符号的地址，过 GOT 取」。大小写 8 只是占个形状 —— 这一格从来只取地址，
一个字节都不读写。全局名与 C 入口名撞在一起是**要**的：两边落成的符号名相同，
于是调用点的 `bl _printf` 与这儿的 GOT 表项指的是同一个东西。

### 二、`CALLI` 也要一个变参分界

`fp("d %d %s\n", 7, "via pointer")` 是**按指针的变参调用**。苹果的 arm64 上变参
一律走栈，而 `CALLI` 从前一律按非变参摆实参 —— 那三个实参会进 `x0`/`x1`/`x2`，
而 `printf` 到栈上去找。于是 `CALLI` 的 aux 从「不用」变成变参分界，编码与 `CCALL`
那一格完全相同（0 = 不是变参调用，否则固定实参个数 + 1）：

```js
['CALLI', 'r', 'p', 'n'],
```

`aux` 缺省是 0，所以这是一次**向后兼容**的扩展 —— 解释器那条腿不看这一格（那边
没有 ABI 可谈），x86_64 也不看（SysV 把变参也放寄存器里，那边只要 `al` 报 xmm
个数，而那一条对非变参函数无害，所以一律发）。只有 arm64 那一边多一句。

`verify` 那边把 `CCALL` 的分界检查改成两条 op 共用：「固定实参比实参还多」会让后端
把一个不存在的实参往寄存器里放。

### 三、验到哪一步

`tests/c/native.js`：**188 passed**（新增六条 —— 按指针调 `snprintf`、写出来的字节、
八个变参跨过寄存器那条线、`double` 混着、一个变参都没有、以及
`fp == snprintf`（两条路取到的必须是同一个地址））。

`tests/c/native-gen.js`：**77 passed, 0 failed, 4 not yet, 2 skipped**，`MIN_OK` 提到 77。

**还没到的 4 条**：变长数组与 alloca（3 条）、`va_arg` 取 struct（1 条）。

**下一片**：变长数组与 alloca —— 现在是最后一堆，也是最大的一堆：它要一个**真能动的
栈顶**（影子栈那套在这条腿上不成立，帧是 `sub sp` 一次挖好的）。

<!-- 第九刀第三十五片-END -->

## 落地：第九刀第三十六片

**变长数组与 `alloca` 上 native 了。**`gen/` 那一批 77 -> **80 条**
（`70-vla`、`73-stmt-expr-label`、`83-alloca`）。83 条里只剩**一条**没到。

### 一、为什么线性内存那一路一条新 op 都不用，而 native 要三条

线性内存那条腿上「栈」是一个 i64 全局（`$sp`，第三刀的影子栈），于是变长数组就是
「读它、减、按 16 对齐、写回」四条**普通**指令。native 上的栈是**机器的** `sp`：

- 动它得用专门的形式 —— arm64 上 `sub sp, sp, xN` 的移位寄存器形式里 31 号是 `xzr`
  （第二十六片那个真错误），所以只能「抄进一个普通寄存器、算、再抄回 `sp`」；
- 降完 `sp` 之后「出参区紧贴 `sp`」这条约定还得继续成立，而那笔账只有后端知道。

所以三条：`SPGET`（读栈顶）、`SPSET`（写栈顶）、`SPALLOC`（切一块，回它的基址）。
`SPALLOC` 的实参**必须已经是 16 的倍数**：对齐这一步两条腿要的是同一个数，
放在前端就只有一份（`nativeAlloca`）。

### 二、`sp` 会动，于是帧要另一个基址（arm64）

arm64 那一份从头到尾按 `sp` 加正偏移寻址（`ldr x9, [sp, #off]`）。`sp` 一动，
所有槽位与值的栈位就都错了。x86_64 没这个问题 —— 那边一直是 `rbp` 相对的。

改法：**只在会动栈顶的函数里**多一个钉住的帧基址（x28），序言里把降完的 `sp` 抄进它：

```js
this.dynStack = hasDynStack(f);            // 扫一遍：有 SPALLOC/SPSET/SPGET 吗
this.base = this.dynStack ? FB : SP;       // 槽位与值的栈位按谁寻址
```

x28 是**被调用者保存的**，所以帧最上面留一格存调用者那份（留在最上面，下面所有偏移
都不变）。不会动栈顶的函数一条指令都不改 —— 那 88 条编码对账的用例因此照旧成立。
收场那边先取回 x28（这一条得在 `FB` 还有效时发），再 `mov sp, x29`：`sp` 这会儿
可能停在某个变长数组下面，而 `x29` 一直没动。

### 三、出参区那一条只能按 `sp` 写

这一片踩到的**唯一**一个真错误：`callArgs` 里走栈的实参原来用 `frameStore` 摆，
而 `frameStore` 现在按 `this.base` 走。于是在有变长数组的函数里，变参被摆到了
帧基址那一带，而被调方按 `sp` 去找 —— `printf("sz %d %d", …)` 印出来的是别的东西。

症状很清楚（实参错位、值像是随机的），原因却在两百行以外。改法是一句：那一条**只能
按 `sp` 写**，因为「出参区紧贴 sp」就是它的定义。

切块时也是同一条约定在起作用：降 `sp` 时多降一个出参区的字节数，块的基址取降之前
那个位置减去 n —— 也就是新出参区的上沿。

### 四、验到哪一步

`tests/c/native.js`：**205 passed**（新增九条 —— 变长数组按下标读写、运行期的
`sizeof`、地址交给别人、循环里每一圈收回来、两个套着、中间还调了变参的；
`alloca` 写读、两块不串味、地址交给真的 `snprintf`）。

**边界那一节空了**：它曾经列着「还要线性内存的那些东西必须明着报」，现在
native 这条腿上再没有哪一格偷偷落回偏移上去，所以那一栏一条都不剩。
唯一的守卫留在 `mod.mem !== null` 那一条上。

`tests/c/native-gen.js`：**80 passed, 0 failed, 1 not yet, 2 skipped**，`MIN_OK` 提到 80。

**还没到的 1 条**：`23-vararg-struct`（`va_arg` 取 struct —— 要真的 ABI 分类：
SysV 要按 8 字节一格分 INTEGER/SSE，苹果 arm64 要按「装不装得下 16 字节」分）。

<!-- 第九刀第三十六片-END -->

## 落地：第九刀第三十七片 —— 换尺子：对齐的对象是 tcc，不是 clang

这一片不加功能，改的是**验收标准**，以及为它做的一次勘察。结论有一条是意外的，
而它把后面几刀的工作量砍掉了一大块。

### 一、标准：最后写进文件的字节要与交叉编译的 tcc 相同

从第九刀第一片起，native 这条腿的尺子是 clang：我们出 `.o`、clang 链、真机器上跑，
输出对了就算过（`tests/c/native.js`）。这条路**留着** —— 它是"真的能跑"唯一的证据。
但它不是对齐的尺子，理由是它只能覆盖**本机这一个目标**：本机的 clang/llvm 没法方便地
交叉编译，而 PE（Windows）与 ELF（Linux）也在要支持的范围里。

tcc 可以把交叉编译全开（必要时改它的代码）。而编译本身是一个**纯计算过程**：
同一份输入、同一个目标，写出来的字节应当唯一。所以标准换成：

> 最后写进文件的字节，与交叉编译的 tcc 写出来的逐字节相同。

可执行文件上有一个例外：签名（macOS 的 ad-hoc code signature）那一段**跳过**。
签名数据的结构是已知的，按结构定位并排除即可 —— 要求签名字节相同没有意义，
它是对文件其余部分的一个函数。

### 二、交叉编译器怎么来

```
mkdir .omni-cache/tcc-cross && cd .omni-cache/tcc-cross
<tinycc>/configure --enable-cross && make -j8 cross
```

一次出全套：`arm64-osx-tcc`、`x86_64-osx-tcc`、`x86_64-tcc`、`i386-tcc`、
`x86_64-win32-tcc`、`i386-win32-tcc`、`arm64-win32-tcc`、`arm64-tcc`、`arm-tcc`、
`riscv64-tcc`、`arm-wince-tcc`、`c67-tcc`，以及各自的 `*-libtcc1.a`。
调它们要带 `-B<tinycc 源码目录>`（win32 目标带 `-B<源码>/win32`）——
否则找不到 `libtcc1.a` 与 `include/`。

位置无关那一路要再来一份（`-pie` 在 tcc 的命令行上是个空壳，见第六十二片）：

```
mkdir .omni-cache/tcc-pie && cd .omni-cache/tcc-pie
<tinycc>/configure --enable-cross
make x86_64-tcc arm64-tcc EXTRA-DEFS=-DCONFIG_TCC_PIE=1
```

### 三、意外的那条：**tcc 的 `-c` 在所有目标上都写 ELF**

拿一行 C（`int f(int x){return x+1;}`）在四个目标上各出一个 `.o`，头四个字节：

```
tcc arm64-osx   7f 45 4c 46   ELF
tcc x86_64-osx  7f 45 4c 46   ELF
tcc x86_64      7f 45 4c 46   ELF
tcc x86_64-win32 7f 45 4c 46  ELF
我们 arm64      cf fa ed fe   Mach-O
```

也就是说 Mach-O（`tccmacho.c`）与 PE（`tccpe.c`）**只在最终可执行文件那一步**出现；
目标文件一律是 ELF（`tccelf.c` 的 `output_type == TCC_OUTPUT_OBJ` 那一路）。

两个后果：

1. **"目标文件对齐"只有一种格式要复刻**，四个目标共用同一段代码，
   差别只在 `e_machine` 与重定位号。那是一个杠杆很长的活 —— 一份 ELF 目标写出
   同时把 arm64/x86_64/i386/win32 四条腿的 `-c` 都对上。
2. 我们现在的 `src/core/link/macho.js` 写的 Mach-O `.o` **不在对齐路径上** ——
   它属于 clang oracle 那条腿（clang 只吃 Mach-O）。所以它不用改、也不该拿它去对账。
   曾经以为"下一步是把 macho.js 写得和 tcc 一样"，那是个错的方向。

第一次量的差距（同一行 C，arm64-osx 目标）：tcc 的 ELF `.o` 是 **789 字节**，
我们的 Mach-O `.o` 是 **412 字节** —— 两个不同格式，这个数只是记个起点，不是差距。

### 四、于是后面的排布

- **ELF 目标文件写出**（对 `tccelf.c`）：一片，四个目标的 `-c` 一起对上。
- **ELF 可执行文件**（Linux）、**Mach-O 可执行文件 + ad-hoc 签名**（macOS，
  比对时跳过签名段）、**PE 可执行文件**（Windows）：各一片。
- clang 那条腿照旧跑 `tests/c/native.js`，管"真的能跑"；tcc 那条腿管"字节相同"。
  两条腿都要绿。

<!-- 第九刀第三十七片-END -->

## 落地：第九刀第三十八片 —— ELF 目标文件写出，而且 tcc 自己的链接器认它

第三十七片说了「一份 ELF 目标写出把六个目标的 `-c` 一起对上」，这一片把它写了：
`src/core/link/elf.js`，写 `ET_REL`。入参与 `link/macho.js` 的 `writeObject`
**一模一样** —— 同一份前端产物喂两个写出器，一个给 clang 那条腿，一个给 tcc 那条腿。

### 一、`tccelf.c` 里那两条算式

节的次序是**写死**的，因为 tcc 那边它也是写死的：节是 `tccelf_new` 按固定顺序造出来的，
序号就是造出来的次序，`.shstrtab` 在 `alloc_sec_names` 里最后造，所以永远在最后。

```
0 （全 0 的那一条）
1 .text      PROGBITS  ALLOC|EXECINSTR  align 8
2 .data      PROGBITS  ALLOC|WRITE      align 8
3 .data.ro   PROGBITS  ALLOC            align 8
4 .bss       NOBITS    ALLOC|WRITE      align 8
5 .symtab    SYMTAB    entsize 24, link=6, info=局部符号的条数
6 .strtab    STRTAB    align 1
7.. .rela.*  RELA      entsize 24, link=5, info=被修的那一节
末 .shstrtab STRTAB    align 1
```

排布是 `elf_output_obj` 的两行：

```
off = (64 + 3) & -4  +  节数 * 64        // 节头表紧贴 ELF 头，所以 e_shoff = 64
每一节：off = (off + 15) & -16           // 一律 16 对齐，空节也占一个位置
```

`SHT_NOBITS`（`.bss`）拿到 `sh_offset` 但**不推进**游标；文件末尾**不补齐**，
最后一节的末尾就是文件的末尾。`e_shstrndx = 节数 - 1`，`e_phnum = 0`。

### 二、重定位：加数从原地搬到明写的那一格

Mach-O 把加数藏在**原地那几个字节**里（数据段那个八字节指针就是这么走的），
ELF 的 `RELA` 有明写的 `r_addend`。于是转换要做两件事：

- 数据里的八字节指针（`POINTER64`）：读走原地的八字节当加数，**原地清零**。
  tcc 写出来的 `.data` 就是清过零的。
- x86_64 那几种四字节 pcrel（`PC32`/`PLT32`/`GOTPCREL`）：Mach-O 的 pcrel 是
  「相对指令末尾」，ELF 是 `S + A - P` 而 `P` 指**那四个字节自己**的地址，
  坑落在指令末尾，所以加数要写 `-4`。arm64 那边坑在整条指令的位域里，`P` 就是
  指令地址，不用这一格。

类型号对照（`R_AARCH64_*` / `R_X86_64_*`）：

```
BRANCH26      -> 283 CALL26          BRANCH   -> 4 PLT32
PAGE21        -> 275 ADR_PREL_PG_HI21 SIGNED  -> 2 PC32
PAGEOFF12     -> 277 ADD_ABS_LO12_NC  GOT_LOAD-> 9 GOTPCREL
GOT_PAGE21    -> 311 ADR_GOT_PAGE     UNSIGNED-> 1 X86_64_64
GOT_PAGEOFF12 -> 312 LD64_GOT_LO12_NC
POINTER64     -> 257 ABS64 / 1 X86_64_64（按架构）
```

顺手记一笔勘察出来的事实：**tcc 在 arm64 上取任何数据的地址都过 GOT**
（`ADR_GOT_PAGE` + `LD64_GOT_LO12_NC`），连自己文件里的 static 也一样。
我们第三十一片被 `ld` 逼出来的那条路（外部数据只能过 GOT），在 tcc 那边是**所有**
数据的默认路。

### 三、符号表：局部在前、`STT_FILE` 在 1 号位、未定义的是 `NOTYPE`

```
0    全 0
1    源文件名（STT_FILE，st_shndx = SHN_ABS）
2..  局部的
..   本文件定义的全局（.text 里的是 STT_FUNC，.data 里的是 STT_OBJECT）
末   只被引用、没有定义的（STB_GLOBAL + STT_NOTYPE）
```

`sh_info` 报的就是局部那一段的条数。最后那一段的类型是 `NOTYPE` 而不是 `FUNC`,
这是 `tccelf_end_file` 里明写的一条：未定义的 `STT_FUNC` 会让 gnu ld 在静态链接
`STT_GNU_IFUNC` 时犯糊涂。符号名前那条下划线按目标走 —— osx 与 win32 有，linux 没有
（`c-obj --os linux`）。

### 四、新的门禁：`tests/c/tcc-link.js` —— 一条不经过 clang 的能跑的路

```
node src/core/cli.js c-obj x.c -o x.o --format elf
arm64-osx-tcc -B<有 libtcc1.a 的目录> x.o -o x
./x
```

**83 条 gen 用例，80 过、0 败、1 还没到（`23-vararg-struct`）、2 问不出同一个答案。**
第一次跑就是这个数 —— ELF 写出没有返工。

这一份的价值不只是多一把尺子：tcc 的 `tcc_load_object_file` 会把我们写的节头、
符号表、重定位**全读一遍再自己重定位**，一个字段填歪它就会说话，而 clang 那条腿
根本看不见 ELF。所以它同时验「ELF 写对了」与「码本来就对」两件事。
`libtcc1.a` 那一格有个坑：交叉编译出来的名字带前缀（`arm64-osx-libtcc1.a`），
而 tcc 只找 `-B<dir>/libtcc1.a`，所以测试里现搭一个只有那一个文件的目录喂给 `-B`。

三把尺子到这一片的分工：

- `native-gen.js`：我们出 Mach-O `.o` -> **clang** 链 -> 跑，与 `tcc -run` 比输出
- `tcc-link.js`：我们出 ELF `.o` -> **tcc** 链 -> 跑，与 `tcc -run` 比输出
- `tcc-obj.js`：我们出 ELF `.o`，与 `<target>-tcc -c` 的目标文件比**字节**

### 五、字节对账走到哪儿了

`tcc-obj.js` 多了一栏「容器相同」：节的名字、次序，以及每一节的形状
（类型、旗、`sh_link`/`sh_info`、对齐、`sh_entsize`）与 tcc 的完全一样，
差别只剩节里的字节与 `sh_size`。arm64-osx 目标、83 条用例：

```
0 字节相同, 2 容器相同, 80 不同, 1 我们还编不出
```

第一个不同的字节，绝大多数落在 **0xa0** —— 那是 1 号节头里的 `sh_size`，
也就是说 ELF 头、0 号节头、`.text` 的名字/类型/旗/地址全对上了，第一格差别是
**代码有多长**。那是 B 路（一遍过、寄存器分配与 tcc 相同）的活，不是容器的活。

结构上还剩两处已知的不同，都记在这儿不藏：

1. `.rela.text` 与 `.rela.data` 的**次序**。tcc 那边是「谁先要重定位谁先造」——
   全局的初值里带地址而它写在函数之前，`.rela.data` 就在前面。我们这儿是写死的
   `.rela.text` 在前。要对上得让前端记住「谁先要」，那属于 B 路。
2. 有些用例我们**没有** `.rela.text` 而 tcc 有：文件内部的调用我们在汇编层就把
   相对偏移填掉了，tcc 一律发一条重定位让链接器填。同样是 B 路的事。

<!-- 第九刀第三十八片-END -->

## 落地：第九刀第三十九片 —— struct 进变参：`gen/` 那一批一条不剩

`23-vararg-struct` 是 `gen/` 里最后一条没到的用例，从第二十六片起就挂着。这一片把它填了
（arm64 那条腿），于是 **81 条能问出同一个答案的用例全过**，两条腿都是：
`native-gen.js`（clang 链）81、`tcc-link.js`（tcc 链）81，剩下 2 条是**问不出**
同一个答案的（`37-argv`、`82-flex-init`），不是没做到。

### 一、为什么需要一条新 op

固定形参那边早就通了，靠的是前端自己的约定：**传地址、被调方拷**（见 `tccgen.js` 文件头）。
可变部分不能这么办 —— `va_arg(ap, struct P)` 只知道自己要什么类型，拿不到「这一格里
放的是地址还是内容」这条额外信息，所以内容必须**直接躺在格子里**。而「那是几个字节、
摆在哪儿」是 ABI 的事，只有后端知道。

于是 MIR 多一条：

```
ARGMEM   a = 那一份内容的地址，aux = 字节数，t = T_I64
```

它产的"值"只能当一次变参调用的实参用，而且只能落在分界之后。后端见到它就把 aux 个
字节**拷进那一格**，而不是把地址写进去。良构检查里三条：native 才有、aux 是正数、
t 是 i64（`verify.js`）。

读的那一侧不用新 op，只是给 `VAARG` 的 aux 添了个意思：**aux > 0 表示这一格里躺着一个
多大的 struct**，回的是**那一格的地址**（t = i64）。前端把它包成一个左值
（`sMem(ty, at, 0)`）—— 拷不拷由赋值那一步决定，与 struct 返回、与线性内存那条腿的
`va_arg`，都是同一个手法。

### 二、arm64（苹果）那一侧

苹果的 arm64 上变参**一律走栈**，所以一块内容就是栈上连着的 `align8(n)` 个字节 ——
与标量那一格同一条规则（一格至少 8 字节），只是格子更宽。两处改动，都在
`argPlaces` 那一个「谁在哪儿」的算法里外：

- `argPlaces`：`ARGMEM` 的实参占 `align8(aux)` 个字节的出参区，而且**只许出现在变参
  那一段** —— 真在固定实参里撞见就明着报（那说明上一层错了，不该悄悄按地址传过去）。
- `callArgs`：按 8/4/2/1 递降着拷。**不拷到格子的末尾** —— 格子补齐到 8，源没有那么长，
  多读的那几个字节大多无害，可源要是正好贴着一页的末尾就会踩空。

`va_arg` 取 struct 在这条腿上只有三条指令：地址就是当前游标，游标往前走 `align8(n)`。

### 三、x86_64 还没到，而且是**明着**没到

SysV 上同一件事要走真的分类：每 8 字节一格算 INTEGER/SSE，超过 16 字节整份进 MEMORY，
而分类结果决定它躺在寄存器保存区里还是溢出区里。所以 x86_64 后端上这两条都报
`nyi`（`va_arg 取 struct（SysV 的分类还没到）`、以及 `ARGMEM` 那一条走默认的
「还不认识」）。这是刻意的：MIR 是**不分架构**的（同一份 MIR 喂 `genArm64` 与 `genX64`），
所以拒绝只能落在后端；而按标量读半格的那种"能跑"比报错坏得多。

`gen/` 那一批的两把尺子都只在 arm64 上跑（`native-gen.js` 与 `tcc-link.js` 开头都挡了
架构），所以这一片先落一条腿不留暗账。x86_64 那条腿是下一片。

<!-- 第九刀第三十九片-END -->

## 落地：第九刀第四十片 —— SysV 的聚合分类：x86_64 那条腿也通了

第三十九片留了一条明账：x86_64 上 struct 进变参报 `nyi`。这一片把它填了，
`tests/c/native.js` 205 -> **217 条**（六条新用例 × 两条腿），两条腿都是 0 败。

### 一、位图：一条**类型事实**要跟着 MIR 走

SysV 的分类要知道「前两个八字节里，哪几整格只装浮点」—— 一格里全是 float/double
就归 SSE（进 xmm），掺进一个整型或指针就归 INTEGER。可 MIR 是**不分架构**的
（同一份 MIR 喂 `genArm64` 与 `genX64`），后端拿不到 C 的类型，所以这条信息只能带下来。

它是**类型事实**而不是 ABI 决定，所以算在 `ctype.js` 的 `sseEightbytes`（逐字节标记，
不是逐成员判断 —— `struct{float a; int b;}` 与 `struct{float a, b;}` 成员数一样多，
差别只在某几个字节上；对齐补出来的空洞不表态）。带下去的方式是把它塞进 aux：

```
低 20 位   字节数
再两位     SSE 位图（第 0 位说 [0,8)、第 1 位说 [8,16)）
```

`memArgAux` / `memArgSize` / `memArgSse` 三个函数在 `ir.js` 里，`ARGMEM` 与取 struct 的
`VAARG` 共用。超过 16 字节的一律进 MEMORY，位图没有意义，前端填 0（良构检查里挡着）。

### 二、写侧：够不够**两串一起看**

`argPlaces` 里多一步分类：超过 16 字节整份进 MEMORY（栈上一格 `align8(n)`）；
16 字节以内按格分 INTEGER/SSE，两串寄存器**都够**才进寄存器，差一个就整份改走栈 ——
那是规范 3.2.3 第 5 步说的，不是「能塞几格塞几格」。

进寄存器那一路**整格读满 8 字节**，末格不满也一样：寄存器里的高位无所谓，而进寄存器的
聚合最多 16 字节、它的对齐把那一格垫满了。tcc 那边（`gfunc_call` 的 x86_64 一支）也是
按 8 字节一格读的。走栈那一路按 8/4/2/1 递降着拷，不拷到格子末尾。

### 三、读侧：两格在保存区里**不连着**

`va_arg` 取 struct 在 SysV 上是这一片最绕的地方：

- 超过 16 字节：只可能在**溢出区**里躺着，取地址、游标推 `align8(n)`，一条访存都不发。
- 16 字节以内：先在**运行时**判两串的余量（`gp_offset <= 48 - 8*需要的整数格`、
  `fp_offset <= 176 - 16*需要的浮点格`）—— 要在运行时判，因为同一条 `va_arg` 在循环里
  会走多次，而游标是变的。够就从寄存器保存区取；可整数格在 0-47、xmm 格在 48 起一格
  16 字节，两格**不连着**，而 `va_arg` 回的必须是连着的一份 —— 所以抄进帧里新开的
  16 字节再把那一块的地址给出去（帧位分配跟着 `vaOffs` 那个循环走）。不够就整份从
  溢出区取。

六条新用例正好把几条路都占上：8 字节的一整格 INTEGER、16 字节两格都是 SSE、
24 字节的进 MEMORY、混着标量与两种聚合的、`va_arg` 回左值直接取成员、同一个 struct
传两遍。两条腿（arm64 原生、x86_64 过 Rosetta）答案与 tcc 逐字节相同。

<!-- 第九刀第四十片-END -->

## 落地：第九刀第四十一片 —— 读回来的目标文件能原样写回去（**108 条逐字节**）

第三十八片写出了 ELF，可「写得对不对」当时只有间接的证据（tcc 的链接器认它、链出来能跑）。
这一片补上直接的证据，而且是**第一批真正的字节相同**：

```
拿 <target>-tcc -c 出的目标文件 -> readObject 读进来 -> writeSections 写回去 -> 比字节
六个目标：108 条，全部逐字节相同，0 条不同
```

`tests/c/elf-roundtrip.js`。它的价值在于**与我们的代码生成完全无关** —— 输入是 tcc 自己
写的字节，所以量的只有「我们的 ELF 模型对不对」：节头表的每一格、`elf_output_obj` 的
两条排布算式、`.shstrtab` 里每个名字的偏移、`e_shstrndx`。一格错就不可能相同。

（arm64-osx 那一栏是 83 条，别的目标各 5 条：交叉目标上 tcc 自己编不过大多数用例，
缺的是那些目标的系统头文件，不是我们的账。）

### 一、`elf.js` 分成了两层

- `writeSections(machine, secs)`：节都已经是字节了，只管排布与写字节。它**不认得**
  「哪一节是什么」—— 正因为如此，读回来的一份才能原样写回去。
- `writeObject(...)`：照旧从前端产物出发，备齐每一节的字节，交给上面那一层。
- `readObject(bytes)`：读节头表与节的字节，形状与 `writeSections` 的入参一样。
  符号与重定位**不解释** —— 链接器要的正是这个粒度（tcc 的 `tcc_load_object_file`
  也是先按节读进来，再各自并合）。

一格值得记：`sh_size` 与「文件里有几个字节」不是一回事 —— NOBITS（`.bss`）有大小、
没字节。所以节这一层认一个可选的 `size`，读的时候带上原样的那个数。第一版忘了这一格，
`.bss` 非空的用例写回去 `sh_size` 就成了 0。

### 二、这是往后几片的地基

读得进来，才谈得上「拿 tcc 出的 `.o` 喂我们的链接器」。那条路上有一个很好的性质：
**同样的输入目标文件、同样的目标，链出来的可执行文件应当唯一** —— 于是可执行文件的
字节对账**不必等代码生成对齐**就能开始：

```
tcc -c a.c -> a.o        （tcc 出的目标文件，字节与我们无关）
tcc a.o -o exe-tcc       （tcc 链）
我们的链接器 a.o -> exe   （我们链）
比字节（跳过 ad-hoc 签名那一段）
```

<!-- 第九刀第四十一片-END -->

## 落地：第九刀第四十二片 —— 目标文件的并合与 `tcc -r` 对字节（**108 条**）

第四十一片说「往后要拿 tcc 出的 `.o` 喂我们的链接器」。这一片就是那条路的第一步，也是
链接器的前半段：几个 `ET_REL` 并成一个 `ET_REL`，即 `tcc -r`。

```
<target>-tcc -c 出两个目标文件（字节与我们无关）
tcc -r a.o mate.o -o want.o   ← 尺子
mergeObjects([a.o, mate.o])   ← 我们
六个目标：108 条，全部逐字节相同，0 条不同
```

`src/core/link/elf_merge.js` + `tests/c/elf-merge.js`，命令行上是 `omni elf-r`。
陪衬那个 `mate.c` 是现造的：几个全局、一个只读数组、一段 bss、两个静态（局部符号）、
一个未定义的外部符号 —— 好把 `set_elf_sym` 的几条岔路都走到。

### 一、并合的次序一格都不能自己发明

- 起手是 `tccelf_new` 造的那几条节，序号写死：`.text` / `.data` / `.data.ro`（PE 上叫
  `.rdata`）/ `.bss` / `.symtab` / `.strtab`；
- 每个目标文件按**自己节头表的次序**扫一遍，同名的接到已有的那一条后面（先按 incoming 的
  `sh_addralign` 把已有长度补齐），没有的**当场造一条** —— 于是 `.rela.text` 这种节的
  序号取决于谁先出现；
- 重定位表能不能并，看**它修的那一节**能不能并（`sh = &shdr[sh->sh_info]`）；
- 符号一个个过 `set_elf_sym`：局部的一律新增，非局部的按名字找，老的未定义就改写老的
  那一条，两个都有定义就是重复定义（全局压弱、弱的让路、data 压 common）；
- 最后 `sort_syms` 排一次（局部全在前），`sh_info` 记局部条数，重定位里的符号号跟着改。

### 二、两格是靠对字节才发现的

第一版按上面这套写完，长度全对、节头表每一格全对、符号表逐条全对 —— 字节还是不同。
两处，都不在「算法」里，在「什么时候做」和「谁先造」里：

- **`.strtab` 的次序不是排完之后的次序**。名字是在**造符号的那一刻**进字符串表的
  （`put_elf_sym` 里那一句 `put_elf_str`），而 `sort_syms` 只动符号表、不动字符串表。
  我们一开始在写出时按排好的次序 intern，于是 b.o 的文件名跑到了 a.o 的 `_main` 前面。
  顺带一格：`put_elf_str` **不去重** —— 两个目标文件里同名的静态符号，名字在表里出现两次。
- **`.eh_frame` 起手就有一条 CIE**。它不是从输入里并来的，是 `tccelf_new` 造节的时候
  当场写下的（`tcc_eh_frame_start`）—— 于是并出来的 `.eh_frame` 天生比几个输入加起来
  长一截（x86_64 与 arm64 都是 20 字节，按 8 对齐占 24）。CIE 的内容认架构，x86_64 那
  一份末尾还多一条 `DW_CFA_offset+16`（返回地址在 CFA-8），arm64 没有。这一节只在
  **最终格式是 ELF** 的目标上有：`tccelf.c:93` 把非 ELF 格式的 `unwind_tables` 清掉，
  于是 macOS 与 Windows 上连节都不造，输入里的 `.eh_frame` 也一并丢掉。

这两格都是「读代码读不出来、对字节才露出来」的那一类。这也正是换尺子（第三十七片）的
意义：能跑不等于对，字节相同才是对。

### 三、这一片为什么现在就能对字节

因为并合的输入可以是 **tcc 自己出的目标文件**：同样的输入、同样的目标，出来的字节应当
唯一。于是这一步的对账**不必等代码生成对齐** —— 往后可执行文件的三个写出器（ELF / Mach-O
+ ad-hoc 签名 / PE）都能这么办。

<!-- 第九刀第四十二片-END -->

## 落地：第九刀第四十三片 —— PE 映像的容器（**160 条逐字节**，顺带把交叉目标的覆盖从 5 条提到 82 条）

可执行文件的写出有三个（ELF / Mach-O / PE）。先挑 PE，理由是**只有它能现在就对账**：

- **它是三种里唯一完全确定的**。macOS 上 arm64 的可执行文件必须签名，而 tcc 自己不签 ——
  它 `system("codesign -f -s - <file>")` 让系统去签（`tccmacho.c:2242`）；PE 没有签名，
  也没有 dyld 那一摊（chained fixups、export trie）。
- **本机就链得出来**。`x86_64-win32-tcc a.o -o a.exe` 不需要 Windows 的 sysroot（win32 的
  导入库随 tinycc 源码走），而 `x86_64-tcc`（Linux）少一个 Linux 的 crt/libc，本机链不了。

这一片先立容器：读一份 PE 映像，再**从模板**写回去，字节相同。

```
<target>-win32-tcc a.o -o a.exe   （tcc 链出来的映像）
readImage -> writeImage           （头部除了算出来的那几格全部来自 pe_template）
两个目标：160 条，全部逐字节相同，0 条不同
```

`src/core/link/pe.js` + `tests/c/pe-roundtrip.js`。算出来的那几格是：`NumberOfSections`、
`SizeOfHeaders`、`SizeOfImage`、`SizeOfCode`、`SizeOfInitializedData`、`BaseOfCode`，
以及每节的 `PointerToRawData` / `SizeOfRawData`：

```
sizeofheaders = fileAlign(392 + 节数 * 40)     // 392 = DOS 头 128 + "PE\0\0" 4 + 20 + 240
每节有数据才占文件：ptr = off；off = fileAlign(off + 数据长度)；size = off - ptr
```

### 一、又是靠对字节才发现的一格：**PE 有校验和，而且 tcc 真的填**

模板里 `CheckSum` 那一格写的是 0，`pe_write` 里也看不到给它赋值 —— 但文件里是
`0x00006e96`。它是**边写边攒**的（`pe_fwrite` 每写一段就把那一段按十六位小端的字加进
`pe->sum`，每加一次把高半边折回来），最后 `pe->sum += file_offset`，`fseek` 回到那一格
写下去（`tccpe.c:850`）。

一格值得记：tcc 只把**真写出去的字节**算进和里，补齐的 0 走的是另一条路（`pe_fpad`）。
但补的是 0，加进去也一样 —— 连「奇数长度的最后一个字节单独加」那一格也一样，因为小端下
`(字节, 0)` 这个字就等于那个字节。所以我们直接对整个文件算，结果相同。

### 二、顺带一格：交叉目标上 tcc 缺的不是系统头，是**它自己的头**

前几片的报告里，非 macOS 的目标一直只有 5 条（「tcc 自己编不过大多数用例」）。真正的原因
不是缺 Windows/Linux 的头，是 `-B<src>/win32` 之后 tcc 只往 `win32/include` 里找，而
`stddef.h` / `stdarg.h` 这几个**它自己的**头在 `include/` 里 —— 于是凡是
`#include <stdio.h>` 的用例都在 `_mingw.h` 那一行断掉。补一个 `-I<src>/include`：

- `tests/c/elf-roundtrip.js`：108 -> **262 条**（win32 两个目标各 5 -> 82）
- `tests/c/elf-merge.js`：108 -> **262 条**

<!-- 第九刀第四十三片-END -->

## 落地：第九刀第四十四片 —— 导入表照原样重建（**160 条逐字节，320 个 dll、1990 个符号**）

容器立住了，接着是里头第一块**真内容**：导入表（`pe_build_imports`）。它是 PE 上
「调用别人家的函数」的全部机制，也是往后我们自己链 `.exe` 时必须一格不差地摆出来的东西。

```
读 tcc 链出来的映像 -> 「哪个 dll、按什么次序导入哪些符号」-> buildImports 重新摆一遍
两个目标：160 条，全部逐字节相同（320 个 dll、1990 个导入符号）
```

`src/core/link/pe.js` 的 `readImports` / `buildImports` + `tests/c/pe-imports.js`。

### 一、整段的形状

它接在 thunk 那一节（`.rdata`）的后面，先补齐到 16，然后：

```
dll_ptr  = 补齐之后的长度
imp_size = (dll 数 + 1) * 20        // 描述符，末尾一条全 0
iat_size = (符号数 + dll 数) * 8    // 每个 dll 的那一串末尾一条 0
thk_ptr  = dll_ptr + imp_size       // FirstThunk：运行时被加载器改写成真地址
ent_ptr  = thk_ptr + iat_size       // OriginalFirstThunk：原样留着
再往后   = dll 名字、每个符号的「提示字 + 名字」，按 dll、符号的次序一条条接
```

两份 thunk 数组里填的是**同一个值**：按名字导入就是那个「提示字 + 名字」的 RVA，
按序号导入就是 `序号 | 最高位`。次序上有一格容易写反：dll 的名字是**先**进字符串区、
**后**填描述符的，于是名字区里是「dll0 的名字、dll0 各符号的名字、dll1 的名字、……」。

### 二、又一格是对字节撞出来的：arm64 上导入表**不是** `.rdata` 的最后一段

x86_64 上一次就对上了，arm64 上每份都短 64 到 80 字节。差的那一段是 `.xdata` ——
每个函数 8 字节的展开信息（`pe_add_unwind_info`），它也是只读数据，于是接在导入表后面
一起进了 `.rdata`。所以这一片只对「我们声称重建的那一段」，`.xdata` 留给后面的片。

<!-- 第九刀第四十四片-END -->

## 落地：第九刀第四十五片 —— 异常展开表照原样重建（**160 条逐字节，1426 个函数**）

上一片留下的那个尾巴（arm64 上 `.rdata` 里接在导入表后面的一段）就是 `.xdata`。这一片
把展开表整个认下来 —— Windows 上 x86_64 与 arm64 都要它，而且两个目标的形状**不一样**：

- **x86_64**：`.pdata` 一条 12 字节（起、止、展开信息的 RVA）。展开信息（`UNWIND_INFO`）
  是固定的 8 字节，住在 `.text` 里 —— tcc 的函数帧长得都一样，一份够用。
- **arm64**：`.pdata` 一条 8 字节（起、`.xdata` 里那一条的 RVA），每个函数在 `.xdata` 里
  有自己的 8 字节：一个头 + 四个展开码（`set_fp` / `save_fplr_x` / `end` / 一个补位的
  `nop`）。头里装着函数长度（18 位，按 4 字节数）、`E=1`、epilog 的起点、展开码的字数。

```
两个目标：160 条，全部逐字节相同（共 1426 个函数）
```

`src/core/link/pe.js` 的 `readUnwind` / `buildUnwind` + `tests/c/pe-unwind.js`。

### 一格又是撞出来的：x86_64 上展开信息**不是一份，是一个目标文件一份**

`pe_add_unwind_info` 里那个 `s1->uw_offs` 是**编译那一趟**的状态，不是链接那一趟的 ——
每个 `.o` 都在自己的 `.text` 里放一份，链完就有好几份（内容都一样）。第一版按「只有一份」
写，除了只含一个函数的用例，其余全部报错。

<!-- 第九刀第四十五片-END -->

## 落地：第九刀第四十六片 —— 静态库读得对（7 个库、65 个成员、825 条索引）

链可执行文件必须先能读库：`libtcc1.a` 里住着 `__va_start` 那一族、`_start`、长除法那些
辅助函数，少一个都链不出东西来。这一片照 `tccelf.c` 的 `read_ar_header` /
`tcc_load_archive` / `tcc_load_alacarte`：`src/core/link/ar.js` + `tests/c/ar-read.js`。

两格值得记，都是「tcc 就这么简单」：

- 名字**只有 16 字节那一格**，尾部的空格去掉就是名字。GNU 的长名字（`/N` 指进那张 `//`
  表）与 BSD 的 `#1/N` 它都不认 —— 于是 tcc 自己造的库里名字都是**截断**的
  （`x86_64-osx-libtcc1.o` 成了 `x86_64-osx-libt/`）。
- 符号索引是名叫 `/`（或 `/SYM64/`）的第一个成员，**大端**：先是符号个数，然后每个符号
  一个「成员头的偏移」，再接一串以 0 结尾的名字。

按需取用（`tcc_load_alacarte`）是一个**要转圈**的过程：扫一遍索引，凡是名字正好是当前
还未定义的符号就把那个成员拉进来；拉进来的成员自己又带新的未定义符号，所以要一圈一圈
扫到没有新的为止。

### 尺子这一次只能对一半

想用 `ar p` 对每个成员的字节，但 macOS 的 BSD `ar` 做不到 —— 名字被截断了，而它按完整
名字找成员，于是一律「not found in archive」。退一步：成员的名字与次序对 `ar t`，
每个成员的内容用我们的 `readObject` 读一遍（偏移或长度错一个字节，ELF 的头就对不上），
索引里每条记的偏移都必须正好落在某个成员头上。32 位的目标（i386/arm）不在这一刀的
账上，按第一个成员的 `EI_CLASS` 跳过。

<!-- 第九刀第四十六片-END -->

## 落地：第九刀第四十七片 —— 该读哪些字节（160 条足迹与 tcc 一样，242 个成员）

前面五片能把 tcc 链好的映像照原样重建，可那都是「拿现成的 `.exe` 当模板」。要自己链出来，
第一步不是摆地址，是**先把该读的文件读进来**：哪些库、哪些成员、哪些导入符号。读错了文件，
后面每一格都白算。

这一步原以为没有单独的尺子，其实有：`tcc -vv` 链接时会把装进来的每个文件打成 `-> 路径`，
把从静态库里拉出来的每个成员打成 `   -> 名字`。于是「装了什么」可以先单独对准。

```
两个 win32 目标：160 条足迹与 tcc 逐条相同（共拉出 242 个成员）
```

`src/core/link/pe_load.js`（`readSymbols` / `SymTab` / `peStart` / `runtimeLibs` /
`libCandidates` / `parseDef` / `peLoad`）+ `tests/c/pe-load.js`，照的是 `tccpe.c` 的
`pe_add_runtime` 与 `pe_load_def`，加上第四十六片的 `alacarte`。

三格值得记：

- 入口符号是**按符号表里有什么**挑的：有 `WinMain` 就 `__winstart` 并且是 GUI，有 `wmain`
  就 `__wstart`，否则 `__start`（`-Wl,-subsystem=gui` 时也算 GUI）。挑完之后名字要削掉
  下划线，而且**削几个要看目标**：查入口地址用 `start_symbol + 1`，进符号表的那个在不带
  前导下划线的目标上再削一个 —— x86_64/arm64 上是 `_start`，i386 上是 `__start`。
- 这个入口符号是当作**未定义的全局符号**加进去的（`set_global_sym`），正是它把 `libtcc1.a`
  里的 crt 那个成员拉了进来。少这一句，一个成员都拉不出来。
- `-lmsvcrt` 找的是 `%s.def` / `lib%s.def` / `%s.dll` / `lib%s.dll` / `lib%s.a` 这个次序；
  EXE 只接 `msvcrt` 与 `kernel32`（`libs[]` 里那个空串是哨兵），DLL/GUI 才继续接 `user32`
  与 `gdi32`。

### 一格是撞出来的：`.def` 里的符号**不进** `.symtab`

`pe_putimport` 写的是另一张表（`s1->dynsymtab_section`）。所以导入符号不能在扫库的时候
充当「已定义」—— `printf` 在扫 `libtcc1.a` 的那一刻仍然是未定义的，两张表要到
`pe_check_symbols` 才对上。这一格若按「一张表」写，拉出来的成员就会多。

第一版削下划线削多了一个（`_start` 写成了 `start`），于是 160 条全部一个成员都没拉到 ——
错得干净，也就好找。

<!-- 第九刀第四十七片-END -->

## 落地：第九刀第四十八片 —— 这些字节摆在哪（160 张节表与 tcc 一样）

上一片解决「该读哪些字节」，这一片解决「摆在哪」。尺子还是 `tcc -vv`：它在写文件之前会
把最终的节表打出来（`虚拟地址 文件偏移 长度 节名`），那正是 `pe_assign_addresses` 的
结果加上 `pe_write` 算出来的文件偏移。

关键在于**节表只与长度有关**，一个字节的重定位都不用改 —— 于是这一步能单独对准，不必
等到整份 `.exe` 写得出来。

```
两个 win32 目标：160 张节表与 tcc 逐条相同（虚拟地址、文件偏移、长度、节名）
```

`src/core/link/pe_sections.js`（`sectionClass` / `collectImports` / `buildReloc` /
`peSections`）+ `tests/c/pe-secs.js`，照的是 `pe_section_class` /
`pe_assign_addresses` / `pe_check_symbols` / `pe_build_reloc`。

规矩：

- 节**按「类」重排**，不按名字：text < rdata < data < bss < idata < pdata < tls <
  other < rsrc < debug < reloc。用的是插入排序，所以同一类里保持原来的次序 —— 这也是
  第四十二片那份并合能直接接上来的原因（并合出来的次序与 tcc 链接时的一样）。
- 同一类连着的几节**并成一条**（对到 16），换类就对到 `SectionAlignment`（0x1000）。
  `PE_MERGE_DATA` 把 `.bss` 也算进 data 那一类。
- `.text` 在链接时会长：先对到 8，然后每个「用作函数的导入符号」加一个跳转桩 ——
  x86_64 是 `ff 25` 那 8 字节，arm64 是 24 字节（`ldr x16` / `ldr x16,[x16]` / `br x16`
  / `nop` + 4 字节地址）。
- 第一个 rdata 类的节就是 thunk 节，导入表接在它后面（对到 16）。
- `.reloc` 只在 DLL 或者 `DYNAMIC_BASE` 时才建 —— arm64-win32 默认带，x86_64 不带。

### 三格是撞出来的

- **空节照样推地址**。`if (0 == s->data_offset) continue` 是在 `s->sh_addr = addr =
  pe_virtual_align(...)` **之后**，所以一个空的 `.data` 会把后面的 `.bss` 顶到下一个
  0x1000。少了这一条，`.bss` 就落在 `.rdata` 屁股上。
- **`-vv` 打的「文件偏移」不是 `PointerToRawData`**，是打印那一刻的游标 —— 那一句在
  `if (si->data_size)` 之前。所以 `.bss` 那一行打的是下一节的起点，而它自己的
  `PointerToRawData` 是 0。
- **arm64 上导入桩里那条重定位要进 `.reloc`**：`R_XXX_THUNKFIX` 在 arm64 上**就是**
  `REL_TYPE_DIRECT`（都是 `R_AARCH64_ABS64`），而 x86_64 上它是 PC32。第一版没算这几条，
  arm64 的 `.reloc` 整节都空了，80 条全差一节。

顺手补了第四十四片留下的一个坑：`buildImports` 判序号写的是 `s.ordinal !== undefined`，
可 tcc 那一句是 `if (ordinal)` —— `.def` 里没写 `@N` 的符号序号是 0，要按名字导入。
读回来的那条路上序号总是非零，所以第四十四片的尺子照不出这一格；自己造导入表的时候
所有名字都丢了，`.rdata` 一下短了 0x9d 字节。

<!-- 第九刀第四十八片-END -->

## 落地：第九刀第四十九片 —— 节里的字节（160 份逐字节相同）

上一片算「摆在哪」，这一片填「里面是什么」：导入表的字节、导入桩的代码、每个符号的最终
地址，然后把所有重定位落笔。尺子是 tcc 链出来那份 `.exe` 的每一节，用 `readImage` 读出来
逐字节比。

```
两个 win32 目标：160 份节内容逐字节相同（.text / .rdata / .pdata / .reloc）
```

`src/core/link/pe_reloc.js`（`relocateOne`：两条腿一共十几个重定位号）+
`src/core/link/pe_link.js`（`peImage`：导入桩、符号地址、`relocate_sections`）+
`tests/c/pe-content.js`。

要点：

- 导入函数的符号**不再是未定义的** —— `pe_check_symbols` 把它的 `st_value` 改成 `.text`
  里那个桩的偏移。于是 `call printf` 那条 `PLT32` 算的是「到桩的距离」。导入**数据**
  （`__declspec(dllimport)`）绑的是 IAT 那一格的地址。
- 桩里那一格地址由一条重定位补上：x86_64 是 `R_X86_64_PC32`（`ff 25` 后面那个 rel32，
  原地先写着 -4），arm64 是 `R_AARCH64_ABS64`（16 字节代码后面那 8 字节）。
- `R_XXX_RELATIVE` 在 PE 上不是「什么都不做」：`add32le(ptr, val - imagebase)`，也就是
  往那一格写 RVA。`.pdata` 里指向函数的那些项全靠它。

### 两格又是撞出来的

- **链接器自己提供的符号**（`tcc_add_linker_symbols`）。`__init_array_start` /
  `__init_array_end` 在没有 `.init_array` 的时候**都等于 `.text` 的开头**（`s =
  text_section; end_offset = 0`），不是 0。我们按 0 算，80 条全在那一处差了 0x1000。
  同一族还有 `_etext` / `_edata` / `_end` 与 `__start_节名` / `__stop_节名`。它跑在
  `pe_check_symbols` **之前**，所以 `_etext` 是导入桩还没接上时的 `.text` 长度。
- **arm64 上「够不着」要改写指令**。未定义的弱符号在 PE 上地址是 0，而映像基址是
  0x140000000 —— `adrp` 与 `bl` 都编不出那么远：tcc 把 `adrp` 换成 `movz xN, #0`，
  把 `bl` 换成 `nop`。第一版照常编码，80 条全在那一处差了字节（tcc 那边是 `1f`，
  正是 `d503201f` 的头一个字节）。

<!-- 第九刀第四十九片-END -->

## 落地：第九刀第五十片 —— 整份 `.exe` 与 tcc 逐字节相同（160 份，853504 字节）

把头补上，然后与 `<target>-win32-tcc a.o -o a.exe` 写出来的文件**整个**比。PE 是三种可执行
格式里唯一没有代码签名的，所以「整个文件逐字节相同」在这里是字面意思，没有要跳过的区段。

```
x86_64-win32: 80 份 .exe 逐字节相同
arm64-win32 : 80 份 .exe 逐字节相同
共 853504 字节
```

`src/core/link/pe_link.js` 的 `peWrite` + `tests/c/pe-exe.js`。头部那三十几个字段照
`pe_write`：`Characteristics` 是 `CHARACTERISTICS_EXE`（x86_64 是 0x022f，arm64 是
0x0022），子系统默认 3（console），栈 0x100000，数据目录里填导入表、IAT、异常表
（`.pdata`）与重定位表（`.reloc`）。写文件那一层直接用第四十三片的 `writeImage` ——
它本来是「拿 tcc 的映像当模板写回去」，形状不变，只是这一次那个 `img` 是我们自己算出来的。

到这里，**从 `.o` 到 `.exe` 这一整条路是我们自己的了**：读库、按需取用、装 `.def`、
并合、分类摆地址、造导入表与导入桩、落所有重定位、算校验和、写文件。链接这一端不再欠
tcc 什么。

还欠的是另一端：`.o` 里的字节还是 tcc 生成的（我们的代码生成走的是 A 路，与 tcc 的一趟式
不一样）。也就是说这条链子现在是「tcc 的前端 + 我们的链接器」，逐字节对得上；换成
「我们的前端 + 我们的链接器」还要等 B 路。ELF 与 Mach-O 两个可执行格式也还没写。

<!-- 第九刀第五十片-END -->

## 落地：第九刀第五十一片 —— 命令行上的 `pe-link`

前四片都是从测试里调的，这一片把它接到命令行上：

```
omni pe-link a.o -o a.exe -L <交叉目录> -L <tinycc>/win32/lib --target x86_64-win32
```

库从 `-L` 那几个目录里找（`<目标>-libtcc1.a` 与 `msvcrt.def` / `kernel32.def`），映像基址
与要不要 `.reloc` 现在**由目标自己定**（读出 `e_machine` 之后就知道：x86_64 是 0x400000
不带 `DYNAMIC_BASE`，arm64 是 0x140000000 带），调用方不必操心。

两个目标各链一份 `06-libc.c`，与 tcc 链出来的 `.exe` 用 `cmp` 比 —— 一样。

<!-- 第九刀第五十一片-END -->

## 落地：第九刀第五十二片 —— 用我们的链接器把 tcc 自己链出来

`gen/` 里那些用例都只有几十行。这一片换成真东西：把 tinycc 整份源码（`tcc.c`，
`ONE_SOURCE`）交叉编成一个 `.o`，再用我们的链接器链成 `.exe`，与
`<target>-win32-tcc tcc.o -o tcc.exe` 逐字节比。

```
x86_64-win32: 400896 字节逐字节相同（4 节、82 个导入桩）
arm64-win32 : 476160 字节逐字节相同（5 节、79 个导入桩）
```

`tests/c/pe-tcc.js`。这一份是「照抄的规矩到底对不对」的真考题 —— 二十几万字节的 `.bss`、
八十几个导入、上万条重定位，小用例照不出来的两格立刻现形：

- **`.bss` 并进 `.data` 那一条时，写进文件的长度是 `data_size` 不是 `sh_size`**。
  `pe_write` 里写的是 `si->data_size`（最后一个有内容的节结束处），而虚拟长度还要算上
  后面那一大截 `.bss`。小用例里 `.data` 是空的、`.bss` 自己单独成一条，所以从来没撞上；
  这里 `.data` 有 8 字节、`.bss` 有 0x2696c 字节，我们的文件一下大了 15 万字节。
- **arm64 少了两个重定位号**：`R_AARCH64_CONDBR19`（280）与 `R_AARCH64_TSTBR14`（279）
  —— `b.cond` / `cbz` 与 `tbz` 的位移。几十行的用例里没有跳得那么远的条件分支。

`.o` 里的字节还是 tcc 出的，所以这句话要说准：**「tcc 的前端 + 我们的链接器」能把 tcc 自己
逐字节链出来**。

### 拆开编的那一份也一样

tinycc 平时不是 `ONE_SOURCE` 编的，是十二个 `.c` 各出一个 `.o`（`tcc` / `libtcc` /
`tccpp` / `tccgen` / `tccdbg` / `tccelf` / `tccasm` / `tccrun` / `tccpe` 加上按目标挑的
代码生成与汇编那三个）。那一份也对上了：

```
x86_64-win32 一份: 400896 字节（1 个 .o）    拆开: 403968 字节（12 个 .o）
arm64-win32  一份: 476160 字节（1 个 .o）    拆开: 480768 字节（12 个 .o）
```

十二个目标文件要并合、符号要跨文件解析、`.pdata` 里每个目标文件都带自己那一份展开信息 ——
这一路走通，说明并合那一片（第四十二片）与链接这几片接得上。

<!-- 第九刀第五十二片-END -->

## 落地：第九刀第五十三片 —— 换个格式：ELF 可执行文件

前面六片走的是 PE。这一片把同一条路在 **Linux 的 ELF** 上再走一遍，为的是验一句话：
我们照的是 tcc 的**算式**，不是照着一个输出反推出来的。尺子换成

```
<target>-tcc -static -nostdlib -Wl,-e,main a.o [b.o …] -o a.out
```

`src/core/link/elf_exe.js`，对账在 `tests/c/elf-exe.js`：

```
x86_64-linux: 10 份可执行文件逐字节相同
arm64-linux : 10 份可执行文件逐字节相同        （共 35676 字节）
```

三个开关都是被逼出来的：交叉编译的 Linux 目标在 macOS 上没有 libc 可装，所以
`-nostdlib`；动态那一整套（`.interp` / `.dynsym` / `.hash` / `.dynamic` / `.got` 的
运行期部分）还没写，所以 `-static`；没有 crt 也就没有 `_start`，入口只能自己指。剩下的
正好是「摆放 + 写出」这一段 —— 而那一段是三个格式共用的骨架。

### 这一片新学到的几格

- **符号表根本不写**。`set_sec_sizes` 只给 `SHF_ALLOC` 的节填 `sh_size`（`tccelf.c:2217`），
  `.symtab` / `.strtab` / `.rela.*` 的 `sh_size` 一直是 0；`alloc_sec_names` 于是不给它们
  名字，`sort_sections` 把没名字的归到 0x900 那一类，`reorder_sections` 再把它们摘掉。
  可执行文件里只剩 `SHF_ALLOC` 的节加一条 `.shstrtab`。
- **次序是两级键**：`j` 认 alloc/write（0x100/0x200/0x700/0x900），`k` 认「是什么节」
  （符号表 0x10、重定位 0x20、可执行 0x60、bss 0x70、`.got` 0x47、别的数据 0x50），然后
  `if (s->sh_num <= bss_section->sh_num) ++k` —— 起手那几条标准节要排在**同类的后面**，
  `_etext` / `_edata` 才是对的值。排法是插入排序，同键保持原次序。
- **头占的地方要先算**：`file_offset = (Ehdr + phnum*Phdr + 3) & -4`，再加 `shnum * Shdr`，
  然后 `addr = ELF_START_ADDR + file_offset`；第一个 PT_LOAD 最后又把 `p_offset` 按回 0、
  `p_vaddr` 按回 base，好让 strip 一类的工具高兴。
- **空节不换段**：`f != f0 && s->sh_size` 才开新的 PT_LOAD。`.data`/`.bss` 是空的时候它们
  跟着 `.text` 那一段走，段的 `p_filesz` 是按对齐推过去的游标算出来的（0x279 -> 0x280）。
- **静态链接照样有 `.got`**。tcc 的代码生成对 extern 符号用的是 `R_X86_64_GOTPCREL` /
  `R_AARCH64_ADR_GOT_PAGE`，而那几号是 `ALWAYS_GOTPLT_ENTRY` —— 于是 `build_got_entries`
  两趟走完就造出了 `.got`（头三格留给 `_DYNAMIC` 与两条哑项）。`.got` 归 0x47 那一档，
  一出现就牵出一个 PT_GNU_RELRO 段头。GOT 那一格的值不是 `fill_got` 写的（那一句在 arm64
  上比的是 x86_64 的号，等于没写），是 `.rela.got` 里那条 `R_GLOB_DAT` 在
  `relocate_sections` 落笔时写进去的。
- **`R_XXX_RELATIVE` 在 ELF 上什么都不做**，arm64 那两条「弱未定义符号改写成 `movz`/`nop`」
  也是 PE 才有的 —— 同一个 `relocate()`，两个格式两套边角（`x86_64-link.c:398`、
  `arm64-link.c:250` 那两个 `#ifdef TCC_TARGET_PE`）。
- **链接器给的符号要真的放进符号表**。一开始我拿一张「名字 -> 节 + 偏移」的旁表记
  `_etext` / `__start_xxx`，字节也对上了；但那样它们在 `build_got_entries` 眼里仍是**未定义**，
  「AUTO 且未定义才走 GOT」那道筛子会漏进来，多造出 GOT 项。改成 `set_global_sym` 那样
  直接改写符号表里那一条才是对的。

### 顺手把尺子加宽

`gen/` 里 83 个用例只有 5 个不用 libc 的头就能编。于是 `tests/c/elf-gen/` 添了五份专门
戳这一片的自由站立源码：`.bss` 与 `_etext`/`_edata`/`_end`（10）、自己起名的节加
`__attribute__((constructor))`（11，牵出 `.init_array` 与 PT_GNU_RELRO）、未定义的弱符号
（12，走 GOT）、只读常量表（13）、两个目标文件一起链（14）。摊出来的形状：

```
11-sections: 8 节 + .shstrtab，4 段（3 个 PT_LOAD + PT_GNU_RELRO）
             .eh_frame .data.ro .text .init_array .got mysec .data .bss
```

命令行上是 `omni elf-link a.o b.o -o a.out -e main`。

<!-- 第九刀第五十三片-END -->

## 落地：第九刀第五十四片 —— 动态链接的那一整套

上一片是 `-static`。这一片把 `-static` 去掉 —— tcc 默认就是动态链接，**一个共享库都没装
也照样把整套家当摆出来**：

```
<target>-tcc -nostdlib -Wl,-e,main a.o -o a.out
```

`tests/c/elf-dyn.js`：

```
x86_64-linux: 10 份可执行文件逐字节相同
arm64-linux : 10 份可执行文件逐字节相同        （共 63112 字节）
```

摊出来是十六条节、八个段头：

```
.interp .dynsym .dynstr .hash .gnu.hash .rela.got .eh_frame .eh_frame_hdr
.data.ro .text .init_array .dynamic .got mysec .data .bss .shstrtab
PT_PHDR  PT_INTERP  PT_LOAD×3  PT_DYNAMIC  PT_GNU_EH_FRAME  PT_GNU_RELRO
```

新写的东西：`.interp`（`CONFIG_TCC_ELFINTERP` 那个串）、`.dynsym`/`.dynstr` 与它们的
**两张哈希表**（老的 `.hash` 与 `.gnu.hash`）、`.dynamic` 的十五条标签、`.rela.got`、
`.eh_frame_hdr`（走一遍 `.eh_frame` 数 FDE，再按函数地址排一张二分查找表）。

### 又是几格照着读代码想不到的

- **`.got` 是无条件造的**。动态那一路里 `build_got(s1)` 直接就调了，一格都不用也照样
  占 24 字节（`_DYNAMIC` 加两条哑项），头一格还要 `write32le` 记 `.dynamic` 的地址。
  第一版我把它写成「按需造」，于是整个文件短了 93 字节、后面每个地址都错。
- **`.dynsym` 里的 `st_shndx` 是重排之后的节号**。`reorder_sections` 那一圈
  `sym->st_shndx = backmap[...]` 对 `SHT_DYNSYM` 也生效，而 `.dynsym` 是**要写进文件**
  的（`.symtab` 不写，所以上一片看不出这一格）。我们的 4/2 对着 tcc 的 14/13。
- **局部符号那几格 GOT 在文件里是 0**。`fill_local_got_entries` 在 RELA 的架构上只改
  `r_addend`，`write32le(got->data + offset, …)` 那一句在 `#else` 里 —— 值留给动态链接器
  按 `R_RELATIVE` 写。x86_64 的用例里没有走 GOT 的局部符号，所以这一格是 arm64 先报的。
- **`.rela.got` 不参加 `build_got_entries` 的扫描**：那个循环有一句
  `if (s->link != symtab_section) continue`，而动态那一路的 `.rela.got` 指着 `.dynsym`。
  少了这道筛子，`R_AARCH64_RELATIVE` 会被拿去问「该不该走 GOT」，而 arm64 的表里没有
  这一号。
- **`.rela.*` 装载得下的那些，`r_offset` 最后要换成绝对地址**（`relocate_section` 末尾
  那一句 `rel->r_offset += s->sh_addr`），`.dynamic` 里的 `DT_RELA`/`DT_RELASZ` 也是从
  这一遍里数出来的。
- **两张哈希表的形状**：老的 `.hash` 起手一个桶，`put_elf_sym` 每加一个非局部符号就多一格
  链，攒到 `> 2 * 桶数` 就把桶数翻倍重建一次；`.gnu.hash` 的桶数是 `有定义的符号数 / 4 + 1`，
  布隆过滤器的大小是「翻倍到 `ndef < size * 8`」，最后 `update_gnu_hash` 还要**按桶把
  `.dynsym` 重排一遍**，再把 `.rela.got` 里的符号号跟着改、老哈希表重建。

命令行上默认就是动态：`omni elf-link a.o -o a.out -e main`，要上一片那种就加 `--static`。

<!-- 第九刀第五十四片-END -->

## 落地：第九刀第五十五片 —— 第三个格式：Mach-O 可执行文件

PE（四十七到五十二片）、ELF（五十三、五十四片），这一片把最后一个格式补上：

```
<target>-osx-tcc -nostdlib a.o -o a.out
```

`tests/c/macho-exe.js`（`src/core/link/macho_exe.js`，`omni macho-link`）：

```
x86_64-macos: 11 份可执行文件逐字节相同
arm64-macos : 11 份可执行文件逐字节相同        （共 1054920 字节）
```

摊出来是十三条加载命令、六节、五个段：

```
__PAGEZERO  __TEXT(__text __stubs)  __DATA_CONST(__rodata __got)
__DATA(__data __bss)  __LINKEDIT
LC_DYLD_CHAINED_FIXUPS  LC_DYLD_EXPORTS_TRIE  LC_SYMTAB  LC_DYSYMTAB
LC_LOAD_DYLINKER  LC_BUILD_VERSION  LC_SOURCE_VERSION  LC_MAIN
```

跟前两个格式差得最远的三处：**没有节头表**（段套节，节头跟在段头后面，ELF 的节号只活在
内存里，最后靠 `elfsectomacho` 换成 1 起的连续编号）；**节按用途归类**（`enum skind`，
每一类写死落在哪个段里，于是三个段的内容是类决定的，不是 flags 决定的）；**动态链接不用
符号表**，用「链式修正」—— 要改的那些 8 字节格子自己串成一条链，每格里记着「下一格离我
几个 4 字节」，导出的符号则摊成一棵前缀树（`export_trie`）。

### 又是几格照着读代码想不到的

- **`resolve_common_syms` 末尾就调了 `tcc_add_linker_symbols`**。第一版我照
  `macho_output_file` 的调用序写，符号表只有 4 条，tcc 有 21 条 —— 少的正好是
  `_etext`/`_edata`/`_end`、三个数组的 start/end、以及八条 `__start_X`/`__stop_X`。
  换句话说这一段不是 ELF 专属的，是「解 COMMON」顺手带的。
- **`.fini_array` 是被 `find_section` 顺手造出来的**。`tcc_macho_add_destructor` 一进门
  就 `find_section(s1, ".fini_array")`，那个函数**找不到就造**（ALLOC 的 PROGBITS），
  于是一个没有析构函数的程序里也凭空多一条空节 —— 也就多了
  `__start_fini_array`/`__stop_fini_array` 两个符号。旁边 `add_init_array_defines` 用的是
  `have_section`（不造），所以 `.init_array`/`.preinit_array` 那两对退回 `.text` 的地址。
- **`check_relocs` 的循环会扫到自己刚造出来的表**。C 那边 `for (i = 1; i < s1->nb_sections; i++)`
  的上界每轮重读，`.rela.got`（刚 `put_elf_reloc` 造的）于是在同一趟里被扫到，末尾那句
  `if (type == R_DATA_PTR || type == R_JMP_SLOT)` 就给**每个 GOT 格子**记上一条 bind 或
  rebase。整套链式修正的来源就是这一句。
- **一个符号不能既走 GOT 又走桩子**。`attr->plt_offset = -n_bind_rebase - 2` 是拿负数当
  「我先记了一条 bind，编号在这儿」的凭据；等发现这个符号还被**调用**，就把那条 bind
  改成 `bind = 2`（作废）再造桩子。反过来（先调用后取地址）tcc 自己会喊
  `Overlap bind/bind .got:_xxx` —— 门里那份 `20-fixups.c` 于是分成两个弱符号写。
- **类型不对就先记下 `plt_offset` 再走**：`if (type != R_AARCH64_CALL26) continue;` 在
  `attr->plt_offset = mo->stubs->data_offset;` **之后**，桩子并没造出来，可同一个符号的
  下一条重定位会照着这个偏移改写 `r_info`。照着抄，别顺手「修正」。
- **只有本机那个目标签名**。`CONFIG_CODESIGN` 在 `config.h` 里裹在「没指定目标时」的
  `#if` 里头，所以 `arm64-osx-tcc` 写完文件会 `system("codesign -f -s - …")`，交叉出来的
  `x86_64-osx-tcc` 不签。而 ad-hoc 签名里的 identifier 取的是**文件名** —— 同名两次签名
  逐字节相同，改个名字第 849 字节起就不同。门里于是把我们的字节写到另一个目录、**同一个
  名字**下再签。
- 段页是 16384 不是 4096（`SEG_PAGE_SIZE`），链式修正的「页」也是这个；而头上留给
  mach 头与加载命令的是 4096，于是 `__TEXT` 的 `vmaddr` 是 `0x100000000`、`__text` 从
  `0x100001000` 起，`LC_MAIN` 的 `entryoff` 就是 `main` 的地址减段基址 —— 没有 crt 也照样跑。
- `__mh_execute_header` 是当场造的符号，`st_value` 写 `-4096`：等 `relocate_syms` 给它加上
  `.text` 的地址，正好落回 mach 头那儿。

自己写出来的 arm64 文件签完名能跑：`22-bss.c` 返回 15，`./a.out; echo $?` 就是 15。

<!-- 第九刀第五十五片-END -->

## 落地：第九刀第五十六片 —— 接上真的 libc

上一片是 `-nostdlib`，只能编那十一份自带的用例。这一片把 libc 接上，于是
`tests/c/gen` 里那八十几份**要 `stdio.h`、要 `printf`** 的用例全进了门：

```
<target>-osx-tcc -B<dir> -L<sdk>/usr/lib a.o -o a.out
```

`tests/c/macho-libc.js`：

```
x86_64-macos: 86 份可执行文件逐字节相同
arm64-macos : 86 份可执行文件逐字节相同   （共 8658712 字节，从 libtcc1.a 里拉了 6 个成员）
```

多出来的三样：

- **`.tbd`**：SDK 里那种文本 stub。`tcc_add_library(s1, "c")` 找到的是 `libc.tbd`，
  从里头读出安装名 `/usr/lib/libSystem.B.dylib` 与一大堆导出符号。那些名字**进不了我们的
  符号表** —— 它们只用来回答 `check_symbols` 里那一句「这个未定义符号是不是来自某个
  dylib」，是就标成 `SHN_FROMDLL`，不是就报「没有定义」。tcc 的「解析器」照抄过来了：
  它不认 YAML，只会找 `install-name: `、再一遍遍找 `symbols: [`，连 `targets:` 都不看
  （于是 x86_64 专属的导出在 arm64 上也一并进表 —— 反正只判断存在性）。
- **`LC_LOAD_DYLIB`**：装了哪个 dylib 就多一条，排在 `LC_MAIN` 后面；`timestamp` 是 2，
  两个版本号都是 `1 << 16`。
- **`libtcc1.a` 按需取用**：跟 PE 那一路同一套（`ar.js` 的 `alacarte`），拉进来的成员
  **接在命令行那些目标文件后面**再一起并合。

顺手把上一片欠的那一块补了：**`.fini_array` 在 Mach-O 上不是一节，是一段当场生成的代码**。
`tcc_macho_add_destructor` 造一个 `___GLOBAL_init_65535`，对每个析构函数写一段
`___cxa_atexit(dtor, 0, &__mh_execute_header)`（arm64 每条 24 字节：adrp/add 取析构函数、
`mov x1, #0`、adrp/add 取 mach 头、`bl`；x86_64 每条 26 字节），前后加上帧的开合，
然后把 `.fini_array` 清空、摘掉 `SHF_ALLOC`，把这个函数挂到 `.init_array` 上。
`23-dtor.c` 两个架构头一遍就逐字节相同，跑起来是 `main 10` / `down2` / `down 10` ——
构造函数、经桩子的 `printf`、倒序的析构函数都对。

命令行：`omni macho-link a.o -o a.out --dylib <sdk>/usr/lib/libc.tbd --libtcc1 libtcc1.a`。

<!-- 第九刀第五十六片-END -->

## 落地：第九刀第五十七片 —— 在 macOS 上把 tcc 自己链出来

PE 那一路第五十二片做过一次（`tests/c/pe-tcc.js`），这是 Mach-O 的那一份
（`tests/c/macho-tcc.js`）：

```
x86_64-macos one-source: 499576 字节逐字节相同（1 个 .o、14 条加载命令、6 节、2 个库成员）
x86_64-macos parts     : 506744 字节逐字节相同（12 个 .o）
arm64-macos  one-source: 590192 字节逐字节相同（1 个 .o）
arm64-macos  parts     : 597040 字节逐字节相同（12 个 .o）
我们链出来的 tcc 能编能跑：hi from ours
```

拆开编的那一份里 `tccmacho.c` 顶掉了 PE 那一路的 `tccpe.c`，代码生成三件套按目标挑。
最后一行是这一片真正想要的东西：arm64 那份是本机能跑的，于是门里**拿我们链出来的 tcc
去编一个 hello 再跑一遍** —— 五十六万字节里任何一处摆错、任何一条重定位落错、
任何一格链式修正串错，它都跑不到 `printf`。

至此三个格式（PE / ELF / Mach-O）都能把真程序链出来，其中 PE 与 Mach-O 都已经把
**tcc 自己**链了出来。

<!-- 第九刀第五十七片-END -->

## 落地：第九刀第五十八片 —— ELF 的 `.plt`

之前 `elf_exe.js` 碰上「未定义的函数被调用」就抛 `要一条 .plt，还没写`。这一片把它写完，
两条路（静态与动态）都逐字节对上：

```
tests/c/elf-exe.js  11 × 2 = 22 条相同（-static -nostdlib）
tests/c/elf-dyn.js  11 × 2 = 22 条相同（动态）
```

新的那条用例是 `tests/c/elf-gen/15-plt.c`：一个**未定义的弱函数**，既取地址又调用。
这一条同时踩到三处讲究：

- **两格 GOT。**「被调用」记在 `attr->plt_offset`，「被取地址」记在 `attr->got_offset`，
  两个格子互不相认，于是同一个符号有两格 —— 头一趟（代码类 `R_JMP_SLOT`）给跳板占
  偏移 24 那格，第二趟（数据类 `R_GLOB_DAT`）再占偏移 32 那格。
- **调用点改指 `name@plt`。** `build_got_entries` 末尾那句
  `rel->r_info = ELFW(R_INFO)(attr->plt_sym, type)` 把重定位的符号号换成了跳板那条符号，
  所以 `.text` 里的 `call`/`bl` 落在 `.plt` 上，而不是落回那个值为 0 的弱符号。
- **静态那一路 `.plt` 是「没修完」的。** `relocate_plt` 只在 `if (dynamic)` 里叫，
  静态输出里跳板里存的还是 GOT 的**节内偏移**：x86_64 那格是 `jmp *(0x18)`，
  arm64 那格干脆只有 `18 00 00 00` 加一串 0。跳不通，可静态链接里也没有解析例程可跳，
  弱符号那一格本就是 0 —— tcc 就这么写，我们也就这么写。

动态那一路多出来的东西：`.rela.plt`（`sh_info` 末了改指 `.got`）、`.dynamic` 里
`DT_PLTGOT`/`DT_PLTRELSZ`/`DT_JMPREL`/`DT_PLTREL` 四条、以及 `relocate_plt` 本身 ——
x86_64 是往三处 `add32le` 补地址差，arm64 是把整段 adrp/ldr/add/br 现场编出来。
`sort_sections` 里还藏着一句 `if (s == s1->plt->reloc) k = 0x21`：跳板那张重定位表要排在
别的重定位表**后头**，`update_reloc_sections` 把余下几张接成连着的一块时才不会被它插一脚
（`DT_RELASZ` 因此只算 `.rela.got` 那 24 字节）。

<!-- 第九刀第五十八片-END -->

## 落地：第九刀第五十九片 —— 共享库（ET_DYN）

第三种输出：`<target>-tcc -shared -nostdlib a.o -o a.so`（门是 `tests/c/elf-so.js`）。

```
x86_64-linux: 11 份共享库逐字节相同
arm64-linux : 11 份共享库逐字节相同
```

命令行上是 `omni elf-link --shared`。与可执行文件那两路的差别不多，但每一处都在别处：

- **没有 `.interp`，没有 PT_PHDR/PT_INTERP**，装载地址从 0 起（`if (s1->output_type &
  TCC_OUTPUT_DYN) addr = 0`）—— 头一个 PT_LOAD 于是从文件偏移 0、虚址 0 开始。
- **`tcc_add_linker_symbols` 不叫**（`resolve_common_syms` 末尾那句认
  `output_type != TCC_OUTPUT_DLL`）：库里没有 `_etext`/`_edata`/`__start_X`。
- **`export_global_syms`**：所有非局部符号原样端进 `.dynsym` —— 连
  `_GLOBAL_OFFSET_TABLE_` 与 `xxx@plt` 都在里头，因为它们在 symtab 里是 GLOBAL 的。
  也正因为这张表是导出的，`build_got_entries` 末尾那句
  `sym[got_sym].st_size = got->data_offset` 第一次显出来 —— 可执行文件里 symtab 不写进
  文件，这个 24 看不见；共享库里它就是第一处不同。
- **x86_64 上的 PLT32/PC32 不再降成 PC32**：库里的全局函数可以被别人的定义顶掉，
  所以除了局部符号与藏起来的符号，一律走跳板。arm64 没这回事（`AUTO_GOTPLT_ENTRY`
  本来就只管未定义的），于是同一份源码 x86_64 多一格 `.plt`。
- **`prepare_dynamic_rel`**：本来只给自己用的 `.rela.data`/`.rela.text` 里，绝对地址那
  几号（`R_X86_64_64`/`_32`/`_32S`、`R_AARCH64_ABS64`/`ABS32`）一律要留到装载时，
  PC 相对那号只在符号进了 `.dynsym` 时留。数出几条，这张表就变成 `SHF_ALLOC` 的，
  长度按条数定；落笔那一趟再**原地挤**（tcc 里那个 `qrel`）：局部符号那条写成
  `R_*_RELATIVE` + 「落笔后的值」当加数，能被顶掉的那条原样留着而**本地不落笔**。
  `char *msg = "hi"` 这样一句就正好走这一路。

<!-- 第九刀第五十九片-END -->

## 落地：第九刀第六十片 —— 接着真的共享库链

上一片能造 `.so` 了，这一片把它用起来（门是 `tests/c/elf-dll.js`）：先
`-shared -nostdlib lib.o -o lib.so`，再 `-nostdlib -Wl,-e,main use.o lib.so -o a.out`。

```
x86_64-linux: 3 份可执行文件逐字节相同
arm64-linux : 3 份可执行文件逐字节相同
```

命令行上是 `omni elf-link --dll libfoo.so`。四件事：

- **读库**（`tcc_load_dll`）：只要 `DT_SONAME`（没有就用文件名的最后一段）与 `.dynsym`
  里非局部的那些符号。库的节头、字节一概不看 —— 可执行文件只记「要哪个库、要它的
  哪些名字」。这张旁表就是 tcc 的 `dynsymtab_section`，**不进**输出。
- **`bind_exe_dynsyms`**：没定义的名字去旁表里找，按**类型**分两路。函数在 `.dynsym`
  里记一条 `STT_FUNC`（值 0），往下 `build_got_entries` 见了它就造跳板；数据则在
  **自己的 `.bss` 里划一块**（起点按 16 对齐，长度取库里那条符号的 `st_size`），
  同名符号改成「定义在 `.bss`」，再放一条 `R_*_COPY` 到 `.rela.bss` —— 装载时由动态
  链接器把库里那份的内容拷进来。tcc 不生成位置无关码，所以引用必须是本地地址，
  这一手是绕不开的。`.bss` 长了之后 `_end` 还要跟着改。
- **`bind_libs_dynsyms`**：反过来，**我们**定义的、而库里也提到的名字要导出到
  `.dynsym`。动态链接器先在可执行文件里找、再去库里找，库里对这个名字的引用于是落在
  我们这份定义上（回调那一路靠的就是它）。顺带一个意外的入选者：`_GLOBAL_OFFSET_TABLE_`
  —— 库把它导出了，于是我们这份定义也得导出。
- **`DT_NEEDED`**：库名进 `.dynstr` 是在所有符号名之后，标签排在 `DT_FLAGS` 之前。

<!-- 第九刀第六十片-END -->

## 落地：第九刀第六十一片 —— 线程局部（local-exec）

`__thread` 的变量落在 `.tdata`/`.tbss`，摆放时多一个 PT_TLS 段。用例是
`tests/c/elf-gen/16-tls.c`（初始化过的、没初始化过的、静态的各一份），三道门都自动收了它：

```
elf-exe: 12 × 2 逐字节相同    elf-dyn: 12 × 2    elf-so: 12 × 2
```

要点只有一条：**偏移相对哪里算**。tcc 只出 local-exec 这一种模型（不生成位置无关码，
连 `-shared` 也一样），于是编译期就能把偏移写死，两条腿的算法却不同：

- **x86_64**（`R_X86_64_TPOFF32`，23 号）：`add32(val - tls_end)`。`fs` 基址指的是整块
  TLS 的**末尾**，所以偏移一律是负数。`tls_end` 要把 `p_memsz` 按 `p_align` 向上取整
  之后再算 —— PT_TLS 的对齐是从节里来的，不取整就差几个字节。
- **arm64**（`TLSLE_ADD_TPREL_HI12` 549 / `LO12` 550）：`tp = val - tls_start + 16`，
  高 12 位与低 12 位分别填进 `add` 的 imm 位（`(insn & 0xffc003ff) | (imm << 10)`）。
  那 16 个字节是 `tcbhead_t`：`tpidr_el0` 指着它，线程数据跟在它后面。

落笔的地方仍是 `relocateOne`，只是多收一个 `{start, end}`。这一段是在**摆放**时才知道的
（PT_TLS 的 `p_vaddr`/`p_memsz`），所以要从布局那里穿过来 —— 没摆就用，只能报错。

<!-- 第九刀第六十一片-END -->

## 落地：第九刀第六十二片 —— 链接器那几个开关（PIE / rdynamic / rpath / soname）

门是 `tests/c/elf-flags.js`：一份用例按五种开关各链一遍。

```
x86_64-linux: 60 份逐字节相同    arm64-linux: 60 份逐字节相同
```

`-pie` 这一路先卡了一下：**tcc 的命令行上没有 `-pie`**，选项表里那条是
`{ "pie", 0, 0 }` —— 收下就丢。位置无关的可执行文件是**编译期**配出来的：

```c
LIBTCCAPI int tcc_set_output_type(TCCState *s, int output_type) {
#ifdef CONFIG_TCC_PIE
    if (output_type == TCC_OUTPUT_EXE) output_type |= TCC_OUTPUT_DYN;
#endif
```

所以尺子得另建一份（`--config-pie` 还不够 —— configure 把那一整块塞在
`#if !(TCC_TARGET_…)` 里，交叉编译的目标是在命令行上给的，整块被跳过）：

```
mkdir .omni-cache/tcc-pie && cd .omni-cache/tcc-pie
<tinycc>/configure --enable-cross
make x86_64-tcc arm64-tcc EXTRA-DEFS=-DCONFIG_TCC_PIE=1
```

PIE 的 `output_type` 是 `TCC_OUTPUT_EXE | TCC_OUTPUT_DYN` —— **两个位都在**，
于是代码里凡是分岔的地方都要问清楚看的是哪一个位：

- 看 `DYN`（跟共享库同一路）：`e_type = ET_DYN`、装载地址从 0 起、
  `prepare_dynamic_rel` 把非 alloc 的重定位表提上来。
- 看 `EXE`（跟普通可执行文件同一路）：`.interp` 与 PT_PHDR/PT_INTERP、
  `tcc_add_linker_symbols`、`bind_exe_dynsyms` + `bind_libs_dynsyms`
  （不是 `export_global_syms`）、x86_64 上「有定义的 PLT32/PC32 降成 PC32」
  照降（那条筛子问的就是 `output_type & TCC_OUTPUT_EXE`）。
- 只看 `DLL`（PIE **不算**）：PC 相对那几号留给装载时算。绝对地址那几号
  （`R_X86_64_64/32/32S`、`R_AARCH64_ABS64/32`）问的是 `DYN`，PC32/PREL32 问的是
  `output_type == TCC_OUTPUT_DLL` —— 位置无关的可执行文件里自家的定义不会被谁顶掉。
- `bind_exe_dynsyms(s1, is_PIE)` 头一句 `if (is_PIE) continue`：库里那些名字既不走
  跳板也不往自己的 `.bss` 里拷 `R_*_COPY`，全交给 GOT（`tests/c/elf-dll.js` 也跟着
  多了一路，6 × 2 份逐字节相同）。
- `DT_FLAGS_1` 多一位 `DF_1_PIE`；代码节上还留着重定位就再加一条 `DT_TEXTREL`。

另外三个开关都在 `.dynamic` 与 `.dynstr` 上：`-rpath` 默认写 DT_RPATH、
`--enable-new-dtags` 改写 DT_RUNPATH，`-soname` 只在 `DYN` 那一路写 DT_SONAME，
串进 `.dynstr` 的次序是「库名、rpath、soname」（`put_elf_str` 的次序）；
标签排在 DT_NEEDED 之后、DT_FLAGS 之前。`-rdynamic` 是把 `bind_libs_dynsyms`
那道「库里也提到」的筛子撤掉 —— 所有有定义的非局部符号都导出，于是没接库时也要跑
这一趟。命令行上是 `omni elf-link --pie / --rdynamic / --soname NAME / --rpath PATH`。

<!-- 第九刀第六十二片-END -->

## 落地：第九刀第六十三片 —— macOS 的 dylib（MH_DYLIB）

门是 `tests/c/macho-dylib.js`，尺子 `<target>-osx-tcc -shared -nostdlib a.o -o a.dylib`。

```
x86_64-macos: 15 份 dylib 逐字节相同    arm64-macos: 90 份 dylib 逐字节相同
```

（两边份数差得多是 tcc 自己的脾气：dylib 允许有没定义的符号，arm64 那份于是把要
libc 的用例也链上了，x86_64 那份链不上就跳过。）

与可执行文件的差别都在「哪些东西是给装载器看的」：

- 没有 `__PAGEZERO`（`used_segment[0] = 0`）—— `__TEXT` 于是成了 0 号段，地址也从
  0 起。凡是「拿 `__TEXT` 那一段」的地方（摆放的起点、导出前缀树的基址、链式修正里
  逐段那一趟）都得跟着挪一格，tcc 那句写得干脆：
  `get_segment(mo, s1->output_type == TCC_OUTPUT_EXE)`。这一句还有个副作用：
  可执行文件里「`mo->segment[sk]` 是 0」意思是「这一类没落在哪个段里」，dylib 里
  0 号是正经的 `__TEXT`，那道筛子得撤掉。
- **`used_segment[0] = 0` 要放在归类之后**：`sk_discard` 归的也是 0 号段，摆在前头
  会被归类那一趟重新点上。这一处踩过一次 —— 段数多一条，`ncmds` 就差一。
- 多一条 `LC_ID_DYLIB`（排在段头之后、链式修正之前），名字是**输出的文件名**
  （`s1->install_name ? install_name : filename`），`timestamp` 是 1 而不是
  `LC_LOAD_DYLIB` 的 2；少了 `LC_LOAD_DYLINKER` 与 `LC_MAIN`。
- 文件类型 MH_DYLIB，标志只有 MH_DYLDLINK（没有 MH_PIE）。
- `tcc_add_linker_symbols` 整趟不叫（跟 ELF 的 `-shared` 一样）—— 少了 `_etext` /
  `_end` / `__start_*` 那十几条，符号表、字符串表、导出前缀树跟着短一截。这一处是
  第二个坑：符号多了十几条，`__LINKEDIT` 的长度就不对。
- 没定义的符号一律标成「来自别处」（`check_symbols` 里那句
  `|| s1->output_type != TCC_OUTPUT_EXE`），谁来填由装载时的平坦查找决定。

顺手补上了 **Mach-O 上的 `__thread`**：Mach-O 那一路根本不填 `tls_start`/`tls_end`
（那两格是 ELF 摆程序头时算的），于是 tcc 算出来的偏移相对的是「0」与
「符号所在那一节的末尾」——

```c
if (s1->tls_end) x = val - s1->tls_end;
else { Section *sec = s1->sections[sym->st_shndx];
       x = val - sec->sh_addr - sec->data_offset; }   /* x86_64 */
int64_t tp_offset = val - s1->tls_start + 16;         /* arm64，start 是 0 */
```

算出来的偏移在 macOS 上没有意义（Mach-O 的线程局部走 `__thread_vars` 那一套，
tcc 不生成），但**字节就是这么写的**，我们照写。第六十一片加的 `16-tls.c` 三道
macOS 的门也收，所以这一条不补上，`macho-exe` 与 `macho-libc` 就是红的。

命令行上是 `omni macho-link --shared [--install-name NAME]`。

<!-- 第九刀第六十三片-END -->

## 落地：第九刀第六十四片

Windows 的 `.dll`：`x86_64-win32-tcc -shared a.o -o a.dll` 与 `arm64-win32-tcc` 写出来的
那份，整份文件逐字节相同。门是 `tests/c/pe-dll.js`，166 份（两个目标各 83 份，704512
字节）。

`.exe` 那一路是第四十七到五十片，这一片只补 DLL 与它差的地方。差的地方全在 `tccpe.c`
里问「是不是 `PE_DLL`」的那五处：

- `pe_set_options`：映像基址换成 `IMAGE_BASE_DLL`（x86_64 `0x10000000`、arm64
  `0x180000000`），`subsystem` 换成 2。
- `pe_assign_addresses` 第一句：`.reloc` **一定建**（EXE 只在 `DYNAMIC_BASE` 时才建）。
- `pe_build_exports`：thunk 节里，导入表后面再接一张导出表。
- `pe_write`：`Characteristics` 换成 `CHARACTERISTICS_DLL`（x86_64 `0x222E`、arm64
  `0x2022`）。
- `pe_add_runtime`：入口符号换成 `PE_STDSYM("__dllstart","@12")`。

### 导出表的布局

`pe_build_exports` 先把 thunk 节对到 16，从那里起是四张连着的表：

```
IMAGE_EXPORT_DIRECTORY     40 字节
函数 RVA                   每个符号 4 字节
名字 RVA                   每个符号 4 字节
序号                       每个符号 2 字节
dll 自己的名字             \0 结尾
各个符号名                 \0 结尾，一个接一个
```

要留意的三格：

1. **次序是按名字 `strcmp` 排的**，不是符号表里的次序 —— `sorted` 那个数组先按
   `st_other & ST_PE_EXPORT` 收一遍，再 `qsort(sym_cmp)`。名字取的是
   `pe_export_name`（带前导下划线的目标才削一个 `_`，`@` 结尾的 stdcall 不削）。
2. **函数 RVA 那几格是空着的**：tcc 给每一格挂一条 `R_XXX_RELATIVE` 指向那个符号，
   等 `relocate_sections` 落笔。在 PE 上 `R_XXX_RELATIVE` 是 `add32(val - imagebase)`，
   原地是 0，所以写进去的正是符号的 RVA。我们不造这条重定位，直接在
   `peImage` 里把 `addrOf(sym) - imagebase` 写进去 —— 一样的字节。
   顺带一句：这几条**不进 `.reloc`**，`pe_build_reloc` 只收 `REL_TYPE_DIRECT`
   （x86_64 是 `R_X86_64_64`，arm64 是 `R_AARCH64_ABS64`），`RELATIVE` 不是那个号。
3. **dll 的名字取的是输出文件的基名**（`tcc_basename(pe->filename)`），所以门里两边
   必须写到同一个文件名。数据目录 0 是 `{base_o + rva_base, thunk 的新长度 - base_o}`。

`pe_build_exports` 还会顺手写一份 `<输出名>.def` 出来。那是给别人链的时候用的，不进
`.dll`，与逐字节无关，我们不写。

### `RELOCS_STRIPPED` 与「建过但空着」

`pe_write` 那一句是

```c
if (pe->reloc)
    pe_header.filehdr.Characteristics &= ~IMAGE_FILE_RELOCS_STRIPPED;
```

问的是这一节**建过没有**，不是它里面有没有东西。DLL 一定建，可我们那三份导出案例里
一条 `REL_TYPE_DIRECT` 都没有 —— `.reloc` 长度 0，连节表都没进去（空节不进节表那一条
是第四十八片的事），可 `Characteristics` 里那一位照样抹掉了。所以 `peSections` 要把
`hasReloc` 传出来，`peWrite` 看的是它，不是节表里有没有 `.reloc`。
（x86_64 的 `CHARACTERISTICS_DLL = 0x222E` 里那一位本来就是 0，这一句在这两个目标上看
不出来；留着是为了 i386 那一天。）

### `_dllstart` 与那个下划线

`pe_add_runtime` 里 DLL 的入口是 `PE_STDSYM("__dllstart","@12")`，而 x86_64/arm64 上
`PE_STDSYM(n,s)` 就是 `n`，于是 `start_symbol = "__dllstart"` —— 两个下划线。接着：

```c
pe->start_symbol = start_symbol + 1;                       /* "_dllstart" */
if (!s1->leading_underscore || strchr(start_symbol, '@'))
    ++start_symbol;                                        /* 也变 "_dllstart" */
```

win32 的 x86_64/arm64 上 `leading_underscore` 是 0，所以**两个名字都是 `_dllstart`**：
要找的符号是它，写进 `AddressOfEntryPoint` 的也是它。它的定义在 `libtcc1.a` 的
`dllcrt1.o` 里，`peLoad({dll: true})` 已经会挑（`peStart` 早就有 `PE_DLL` 那一支了）。

还有一处**不**变：`tcc_add_linker_symbols`。`resolve_common_syms` 里那一句是
`if (s1->output_type != TCC_OUTPUT_DLL) tcc_add_linker_symbols(s1)`，看着是 DLL 就跳过；
可 `pe_output_file` 的调用次序是 `pe_add_runtime` 在前、`resolve_common_syms` 在后，而
`pe_add_runtime` 最后一句正是

```c
if (TCC_OUTPUT_DLL == s1->output_type)
    s1->output_type = TCC_OUTPUT_EXE;   /* “need this for relocate_sections()” */
```

等 `resolve_common_syms` 跑到的时候 `output_type` 已经是 `EXE` 了 —— 于是 PE 的 DLL
**照样**有 `_etext` / `__init_array_start` 那一套。ELF 那边（第五十九片）不是这样，
Mach-O 那边（第六十三片）也不是。三种格式在这一格上三个答案。

### 案例

`tests/c/pe-gen/` 三份专门造导出表：名字故意不按字母序写（`Zeta`、`alpha`、`_under`、
`Mid`、`beta`，`strcmp` 下 `M` < `_` < `a` < `b` < `z`）、导出表与导入表挨在一块、
三十个函数加一张函数指针表。`gen/` 那八十来份也整个过一遍 —— 它们不导出任何东西，
看的是头、入口与那张空 `.reloc`。`gen/40-sscanf.c` 与 `gen/83-alloca.c` 跳过：
`vsscanf` 不在 `msvcrt.def` 里、`__builtin_alloca` 不在 `libtcc1.a` 里，tcc 自己在
win32 上就链不上，可执行文件那一路也一样。

命令行上是 `omni pe-link --shared`（输出名默认 `a.dll`）。

<!-- 第九刀第六十四片-END -->

## 落地：第九刀第六十五片

Windows 上的 `__thread`：`.tls` 那一节、`IMAGE_TLS_DIRECTORY`、数据目录 9，以及
arm64 上**不加** `tcbhead_t` 那 16 个字节。顺手把 `elf-gen/` 那八份也接进两道 PE 的门，
于是 `pe-exe` 是 172 份（两个目标各 86，905216 字节）、`pe-dll` 是 180 份（各 90，
750080 字节），全部逐字节相同。

### `pe_build_tls` 分两趟

`pe_assign_addresses` 一上来数一遍节的类，见到 `sec_tls` 就把
`pe->tls_size = sizeof(IMAGE_TLS_DIRECTORY)` 记下（x86_64/arm64 上是 40：四个指针
加两个 DWORD）。然后：

- **走到 thunk 节的时候**（`pe_build_tls(pe, NULL)`）：在 thunk 节里对到 16 再留
  40 字节当目录，又在 **`.data`** 里对到 16 留 32 字节（`PTR_SIZE * (1+3)`），
  给这 32 字节起名 `__tls_index` —— 代码里那条引用就是冲它来的。目录里那四个指针
  各挂一条 `REL_TYPE_DIRECT`，指向一个「值为 0、节是 `.data`」的匿名符号。
- **走到 `.tls` 那一节的时候**（`pe_build_tls(pe, s)`）：把目录填上。填的是**相对
  `.data` 的偏移**，等 `relocate_sections` 把 `.data` 的地址加上去才成真地址：

```c
d->StartAddressOfRawData = s1->tls_start - data_section->sh_addr;
d->EndAddressOfRawData   = s->sh_addr + s->data_offset - data_section->sh_addr;
d->AddressOfIndex        = pe->tls_data;
d->AddressOfCallBacks    = pe->tls_data + PTR_SIZE;
```

我们不造那四条重定位，直接把终值写进去 —— 一样的字节。可有一处**不能**省：那四条
是 `REL_TYPE_DIRECT`，所以它们**要进 `.reloc`**。第四十八片给 arm64 的导入桩留的那个
`extraDirect` 正好能用；顺手把 `.reloc` 的收集改成「一节一节走，先它自己那张表、
再它的 `extraDirect`」—— tcc 是把链接时那几条**追加在这一节自己那张重定位表末尾**的，
原来分两轮走碰上「同一组里有两节都有东西」就会错序。

节表里那一条还要**改名叫 `.tls`**（`strcpy(si->name, ".tls")`），哪怕并进来的是
`.tdata` 与 `.tbss` 两节。数据目录 9 是 `{tls_dir + thunk 的 RVA, 40}`。

### 三个格式，三种 tp

落笔的时候要的两个数（`s1->tls_start` / `tls_end`）在 PE 上是这么给的：

```c
if (0 == s1->tls_start) s1->tls_start = s->sh_addr;   /* 第一节的地址 */
...
s1->tls_end = s1->tls_start;                          /* “to reuse logic from linux” */
```

两头是同一个地址。于是 x86_64 的 `TPOFF32`（`val - tls_end`）在 PE 上算的是「离
`.tls` 起点的距离」，跟 Linux 上「离整块末尾的距离」正好反着 —— 但两边走的是同一句
代码，因为 `tls_end` 被特意设成了 `tls_start`。

arm64 那两号不一样，`arm64-link.c` 里明写着一个 `#if`：

```c
#if TCC_TARGET_PE
    int64_t tp_offset = val - s1->tls_start;
#else
    /* glibc arm64: tp points to tcbhead_t (DTV), TLS data starts after it */
    int64_t tp_offset = val - s1->tls_start + 16;
#endif
```

Windows 上 tp 直接指着数据，那 16 个字节不加。这一格是这一片唯一一个「先写错了才
发现」的地方：头一遍跑出来 arm64 差九个字节，八个在 `.text` 里（`add` 的 imm12 都
大了 16），第九个是校验和 —— 校验和是算出来的，前八个改对了它自己就对。于是
`relocateOne` 的 `tls` 参数多一格 `tcb`：ELF 与 Mach-O 传 16，PE 传 0。

### 顺带：八个字节以上的节名

`elf-gen/11-sections.c` 里有 `.init_array`，十一个字节。tcc 那一句是

```c
memcpy(psh->Name, sh_name, umin(strlen(sh_name), sizeof psh->Name));
```

—— **就地截断**成 `.init_ar`，只有带 COFF 符号表（`-g`）的时候才写成 `/<偏移>` 去指
字符串表。我们原来在这儿是抛错的，改成照样截断。（可执行文件那一路碰不上，是因为
`.init_array` 并在 `.data` 后面、节表里那一条叫 `.data`；DLL 那一路 `.data` 是空的，
`.init_array` 就成了那一组的头一节。）

<!-- 第九刀第六十五片-END -->

## 落地：第九刀第六十六片

PE 那一路的链接器开关，十二种走法各 6 × 2 份逐字节相同（`tests/c/pe-flags.js`，
144 份、948192 字节）：

- `-Wl,--stack=N`（**十进制**）→ `SizeOfStackReserve`
- `-Wl,-subsystem=gui|native|console|efiapp|…`（`pe_setsubsy` 那张表）
- `-Wl,--image-base=HEX`（也叫 `-Ttext=`）
- `-Wl,--section-alignment=HEX` / `--file-alignment=HEX`
- `-Wl,--large-address-aware` → `Characteristics |= 0x20`
- `-Wl,--nxcompat` / `--tsaware` / `--dynamicbase` → `DllCharacteristics`
- `-Wl,-e,NAME` → 入口符号换人

### `pe_set_options` 那几句的次序

```c
imagebase = (PE_DLL == pe->type) ? IMAGE_BASE_DLL : IMAGE_BASE_EXE;
subsystem = (PE_DLL == pe->type || PE_GUI == pe->type) ? 2 : 3;
if (s1->pe_subsystem) subsystem = s1->pe_subsystem;      /* 开关一律盖过 */
if (subsystem == 1) section_align = file_align = 0x20;   /* native */
else                section_align = 0x1000, file_align = 0x200;
if (s1->section_align)  section_align = s1->section_align;
if (s1->pe_file_align)  file_align = s1->pe_file_align;
if (subsystem >= 10 && subsystem <= 12) imagebase = 0;   /* EFI */
if (s1->has_text_addr)  imagebase = s1->text_addr;       /* 最后说话 */
```

两处容易看漏：**subsystem 1 那一种两个对齐都是 0x20**（`.text` 于是从
`imagebase + 0x20` 起，文件也按 0x20 补），以及 **EFI 那三种映像基址是 0**。

### 头上那两格永远是 0x1000 / 0x200

`pe_write` 往头里写的只有这几格：`NumberOfSections`、`AddressOfEntryPoint`、
`SizeOfHeaders`、`ImageBase`、`Subsystem`、`DllCharacteristics`、
`SizeOfStackReserve`、`Characteristics`。**`SectionAlignment` 与 `FileAlignment`
不在里面** —— 它们是 `pe_template` 里的常量，从头到尾没人改。于是
`-Wl,-subsystem=native` 出来的文件：节确实是按 0x20 摆的（`.text` 在 0x20、
`SizeOfHeaders` 是 0x240、整个文件 2976 字节不是 0x200 的倍数），可头上那两格
写的还是 0x1000 与 0x200。这一片头一遍跑出来的 36 条不同全是这一格
（`native`、`--section-alignment`、`--file-alignment` 三种走法），改法是让
`writeImage` 摆放用传进来的对齐、**写头用模板那两个常量**。

### 顺带清掉一个多余的入参

`.reloc` 到底建不建，tcc 问的是
`PE_DLL == pe->type || (s1->pe_dll_characteristics & IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE)`。
arm64-win32 的 `DllCharacteristics` 默认值 0x8160 里正好带着 0x40，这才是「arm64
默认多一节 `.reloc`」的**原因**。原来我们是拿一个 `dynamicBase` 布尔入参糊过去的，
这一片把它删了，改成从 `dllChars` 里读那一位 —— 于是 `-Wl,--dynamicbase` 在
x86_64 上也长出 `.reloc` 来，一分钱不用另加。映像基址那个入参留着，它现在的角色
正好是 `has_text_addr`。

命令行上是 `omni pe-link --subsystem gui --image-base 1000000 --stack 2097152
--section-align 2000 --file-align 1000 -e main`。

<!-- 第九刀第六十六片-END -->

## 落地：第九刀第六十七片

接着真的 `.dll` 链一份 `.exe`：`<target>-win32-tcc use.o mylib.dll -o a.exe`，两个目标
各 2 份逐字节相同（`tests/c/pe-dll-link.js`）。三种格式的「接着真的共享库链」于是都齐了
（ELF 是第六十片、Mach-O 那一路走的是 `.tbd`/第五十六片）。

要的东西只有一件：**认得一份真的 `.dll`**。`pe_load_file` 按内容认 ——

```c
if (0 == strcmp(tcc_fileextension(filename), ".def"))   ret = pe_load_def(s1, fd);
else if (pe_load_res(s1, fd) == 0)                      ret = 0;
else if (read_mem(fd, 0, buf, 4) && 0 == memcmp(buf, "MZ", 2))
                                                        ret = pe_load_dll(s1, fd, filename);
```

`pe_load_dll` → `get_dllexports`：找到数据目录 0 那张导出表落在哪一节
（`addr >= VirtualAddress && addr < VirtualAddress + SizeOfRawData`），照
`AddressOfNames` 把 `NumberOfNames` 个名字读出来，一个个交给
`pe_putimport(s1, ref->index, q, 0)` —— **序号一律 0**，于是导入表里走的是名字那一路，
跟 `.def` 里不带 `@序号` 的行没有区别。所以我们这边不必新造一条路：把 `.dll` 读成一张
`.def`（`readDllExports`），后面第四十七片那套原样能用。

两格容易错：

- **库名是文件名的基名**（`tcc_basename(dllref->name)`），命令行上写的路径不进导入表。
  门里因此把 `.dll` 和 `.exe` 放在同一个临时目录、用同一个文件名。
- **导入表里那一串的次序与导出表无关**。导出表是按 `strcmp` 排过的（第六十四片），
  可导入表是 `pe_check_symbols` 扫 `.symtab` 排出来的 —— 谁先在符号表里出现谁先来。
  `02-order` 那一份就是把两个次序故意错开：导出是 `alpha beta mid table tag zeta`，
  导入是 `zeta beta alpha mid tag table`。

还有一格是 C 那边的：**从 `.dll` 里取数据要 `__declspec(dllimport)`**，不然 tcc 自己就
报 `symbol 'gvar' is missing __declspec(dllimport)`。函数不用 —— 它走的是 `.text` 里
那个跳转桩。

`peLoad` 于是多回一格 `objs`：命令行上给的文件里**真的目标文件**那几份。原来调用方
是把自己那一份 `objs` 直接交给 `peWrite` 的，现在有 `.dll` 混在里面，得让 `peLoad`
把它挑出来。命令行上是 `omni pe-link use.o mylib.dll -o a.exe`。

<!-- 第九刀第六十七片-END -->

## 落地：第九刀第六十八片

**资源那一节 `.rsrc`。** Windows 上图标、版本号、对话框那些东西不在 C 里，在 `.rc` 里；
`windres -O coff` 把它编成一份文件，链接器整块搬进映像的 `.rsrc` 节。tcc 收这种文件的
那一段叫 `pe_load_res`，它短得出奇 —— 三十行，可有几格挺意外。

**它没有魔数。** `pe_load_file` 认文件的次序是：扩展名是 `.def` 就当导入库，否则先试
`pe_load_res`，再看开头是不是 `MZ`，剩下的才当目标文件。`pe_load_res` 拿什么认？三个
条件：`filehdr.Machine` 与本目标对得上、`NumberOfSections` 正好是 1、那一节的名字正好
是 `.rsrc`。也就是说这种文件就是一份**只有一节的 COFF**：20 字节的文件头加 40 字节的
节表项，后面跟着那一节的字节与它自己那张重定位表。ELF 的 `\x7fELF` 落在机器号那两个
字节上（`0x457f`），撞不着，所以这个次序是安全的。

搬进来的东西就三样：

- 那一节的原始字节整块变成一节新的 `.rsrc`（`new_section(s1, ".rsrc", SHT_PROGBITS,
  SHF_ALLOC)`）—— 内容一个字节都不动，链接器根本不看资源树长什么样。
- 一个**局部符号** `.rsrc`，`st_value` 是 0、`st_shndx` 指着那一节。
- COFF 那张重定位表一条条改挂到这个符号上，类型统一换成 `R_XXX_RELATIVE`。COFF 的
  一条重定位是 10 字节（偏移、符号号、类型）；原来的符号号 tcc **一律不看**，因为
  `windres` 生成的每一条指的都是那唯一一节。类型必须是 `RSRC_RELTYPE`，x86_64 与
  arm64 都是 3（`ADDR32NB`），i386 与 arm 是 7。

第三条是这一片的关键。资源树里 `IMAGE_RESOURCE_DATA_ENTRY.OffsetToData` 那一格要的是
**RVA**，而 `windres` 只知道节内偏移，就把偏移写在那里、挂一条重定位。落笔时
`R_X86_64_RELATIVE` 是 `add32le(ptr, val - imagebase)` —— `add`，不是 `write`。原地那个
节内偏移是要算进去的，加上 `.rsrc` 的 RVA 正好成了终值。第五十片起我们一直照着「原地
的值也算」在做，这一格于是白捡。

还有一格反过来：`R_XXX_RELATIVE` **不是** `REL_TYPE_DIRECT`（那是 `R_X86_64_64` /
`R_AARCH64_ABS64`），所以这几条**不进** `.reloc`。想想也对 —— 资源目录里那些字段本来
就存 RVA，装载器搬动映像时不需要改它们。导出表里那几格函数 RVA（第六十四片）走的是
同一条路。

摆地址那边几乎不用动：`pe_section_class` 里 `.rsrc` 已经排在 `sec_rsrc`（8）那一档，
在 `.pdata` 之后、`.debug` / `.reloc` 之前；`pe_assign_addresses` 顺手把它填进数据
目录 2。这两处第四十八与五十片就照抄过了，这一片只是第一次真的有节落到那一档。

我们这边的形状：`peLoad` 多回一格 `res`（`{bytes, relocs}` 的数组），`peSections` 拿到
它就往 `secs` 里补一节 `.rsrc`、往 `syms` 里补一个同名局部符号、再造一张合成的
`.rela.rsrc` —— 24 字节一条的 ELF 形状，类型填 `R_X86_64_RELATIVE` / `R_AARCH64_RELATIVE`，
符号号指着刚补的那个。补完就什么都不用管了：`peImage` 的重定位循环扫的是 `secs` 里所有
`SHT_RELA` 的节，合成的这一张与真的一样走。这是这一片写得最省的地方 —— 把新东西翻译成
已有的形状，而不是给它开一条新路。

尺子这次得自己造。交叉环境里没有 `windres`，所以 `tests/c/pe-rsrc.js` 自己拼那份单节
COFF：一棵「类型 → 名字 → 语言 → 数据项」的资源树，`OffsetToData` 写节内偏移、各挂一条
重定位。六种形状（一份资源、三份资源、空树、长度 19 字节的、跨过一个 0x1000 页的、
以及 `-shared` 造 DLL 时带资源的）乘六份 C 案例乘两个目标，**72 份逐字节相同**
（474624 字节）。同一份 `.res` 交给 tcc 与交给我们，写出来的映像一个字节不差。

<!-- 第九刀第六十八片-END -->

## 落地：第九刀第六十九片

**PE 上的 `-g`。** Windows 上 tcc 的 `-g` 出的是 **stabs**，不是 dwarf（`tcc_debug_new`
里那个 `if (s1->dwarf) … else …`）。于是这一片要的东西看起来只有三样：把 `.stab` 与
`.stabstr` 带进来、给它们摆地址、在文件末尾接一张 COFF 符号表。真做下来，牵出的是
**「链接过程里谁在什么时候进符号表」**这件一直被绕过去的事。

先说三样明面上的。

**一、`.stab` 与 `.stabstr` 是「只有 `-g` 才装」的节。** `tcc_load_object_file` 开头那个
筛子里，`.debug_*` 与 `.stab*` 单独一条分支：`if (!s1->do_debug || seencompressed)
continue;`。要紧的是这一条分支**绕过**了后面那个 `sh_type` 的白名单 —— 所以
`.stabstr`（`SHT_STRTAB`）也进得来。我们那个 `mergeable` 原来无条件把这两族丢掉，现在
认一个 `debug` 开关；`.stabstr` 那一格还得在「`SHT_STRTAB` 一律跳过」之前先放行。

**二、并出来的两节天生比几份输入加起来长。** `tccelf_new` 在 `-g` 时就调
`tcc_debug_new`，那儿把 `.stab`（`entsize` 12、对齐 4）与 `.stabstr` 建好，**并且先放
一条全 0 的 `Stab_Sym`**（`put_stabs(s1, "", 0, 0, 0, 0)`）。那一条的名字是
`put_elf_str(stabstr, "")`，于是 `.stabstr` 起手也有一个 `\0`。两节因此各长 12 与 1
字节 —— 与 `.eh_frame` 起手那条 CIE（第四十二片）是同一种事：节是**造的时候就带内容**
的，不是从输入里并出来的。

而 `stab_section` 这个全局量从此非空，于是 `tcc_load_object_file` 末尾那段
`gr relocate stab strings` 真的会跑：每份目标文件的 `.stab` 接进来之后，里面每条
`n_strx`（非 0 的）都要加上它那份 `.stabstr` 落在并出来那一节里的起点。一份输入时看不
出来，两份就全错 —— 用例里 `01-a` / `01-b` 就是冲这一格。

**三、调试那一类从不并条。** `pe_assign_addresses` 里合并相邻同类节的条件是
`si && c == si->cls && c != sec_debug` —— 那个 `c != sec_debug` 我们第四十八片就照抄了，
这一片才第一次有节落到那一档：`.stab` 与 `.stabstr` 各占一条节表项，各自对到
`SectionAlignment`。

**四、COFF 符号表。** `pe_write` 开头 `if (s1->do_debug) pe_add_coffsym(pe)` —— 第一次调
只是把 `.coffsym` / `.coffstr` 两节建出来（`SHF_PRIVATE`，所以进不了节表），并在
`.coffstr` 头上留 4 字节给它自己的长度。第二次调（写完节表头之后）才真填：走一遍
`.symtab`，**只收 `STB_GLOBAL`**，一条 18 字节：

- `n_name` 不超过 8 字节就写在原地，否则 `n_zeroes` 留 0、`n_offset` 记进 `.coffstr`；
- `n_value` 是 `st_value - s->sh_addr` —— 那时 `st_value` 已经是绝对地址了，减回去就是
  **这一节里的偏移**，不是 RVA；
- `n_scnum` 是 `s->sh_info`，也就是摆地址那一步记下的「落在节表里第几条」（并进同一条
  的几节记的是同一个号）；未定义的符号是 0，`SHN_ABS` 那种照原样写（短整数，成了负数）；
- `n_sclass` 一律 2（`C_EXT`），`n_type` 与 `n_numaux` 都是 0。

两段在 `.coffstr` 里的**次序不能反**：节表头那个循环里 `if (pe->coffstr &&
strlen(sh_name) > 8)` 会把超过 8 字节的节名也接进去、把节名换成 `/<偏移>`，那一步在填
符号之前。于是长节名先、符号名后。

顺手记一个 `snprintf` 的边角：那两句是先 `memcpy(psh->Name, sh_name, umin(strlen, 8))`，
**再** `snprintf((char*)psh->Name, 8, "/%d", off)`。`snprintf` 只覆盖前面那几个字节加一个
`\0`，**后面几个字节还是原名字剩下的那几个**。`.init_array` 于是成了 `/24\0ay` 之类
——装载器读到 `\0` 就停，可文件里那几个字节不是 0。第六十五片我们发现「节名超过 8 字节
就地截断」，那是**没有** `.coffstr` 的时候；有了它就换成 `/<偏移>`，两条路都得走。

那张表与字符串表接在最后一节补齐之后，**不再补齐** —— 于是带 `-g` 的 `.exe` 长度不是
`FileAlignment` 的整数倍。校验和那一句 `pe->sum += file_offset` 自然把它们算进去了。

### 真正难的那一格：符号表里的次序

前面那些照着写就对了，可第一次跑出来 `NumberOfSymbols` 是 22，tcc 是 37。差的 15 条
全是**链接器自己造的符号**。

`tcc_add_linker_symbols` 里 `_etext` / `_edata` / `_end` 走 `set_linker_sym(…, 0)`，
`__preinit_array_start` 那六个与 `__start_<节>` / `__stop_<节>` 走 `set_global_sym` ——
**这两个都是「表里没有就新建一条」**。我们原来只在「表里已经有、而且还没定义」时才记一
笔（因为没人引用的符号不影响任何字节）。这个偷懒到 `-g` 才露出来：COFF 符号表照 `.symtab`
的次序一条条写，「建了没有」是看得见的。

只有一处确实是有条件的：`set_linker_sym` 末尾那句
`if (name[0] == '_') set_linker_sym(s1, name + 1, sec, f + 1)` —— 不带下划线的
`etext` / `edata` / `end` 走 `f == 1` 那一路，`if (!(sym_index || esym_index) || defined)
break;`，也就是「表里压根没有就不建」。所以 tcc 的表里有 `_etext` 没有 `etext`。

还差一条：**入口符号**。tcc 的表里 `_start` 排在 `g` / `add` / `main` 之后、crt 那一堆之
前 —— 因为 `pe_add_runtime` 里 `set_global_sym(s1, start_symbol, NULL, 0)` 是在**命令行
上那几个目标文件都装完、库还没开始扫**的那一刻加的。我们那边 `peLoad` 早就在同一个位置
做了同一件事（`tab.declare(start)`），可那是链接器自己那张查询表，没进并合出来的
`.symtab`；于是 `_start` 要等 `crt1.o` 里的定义才第一次出现，位置就晚了十几条。

`mergeObjects` 因此多收一个 `declare: [{name, after}]`：装完第 `after` 份输入之前，先
`setSym` 一条未定义的全局符号。调用方给的是
`[{name: loaded.start, after: loaded.objs.length}]` —— 「命令行上那几份」与「从库里拉出
来的成员」之间那条缝，本来是 `peLoad` 才知道的。

这一格值得记：**符号表里的次序是链接过程的一部分**，不是并合的副产品。前面二十几片都没
碰上，是因为一直没有哪个字节依赖它。

尺子：`<target>-win32-tcc -g …`。九种走法（四份单目标的 C 案例、`.init_array` 那份长节
名的、弱符号、线程局部、两份都带 stabs 的，以及 `-shared` 的两种）乘两个目标，
**18 份逐字节相同**（180010 字节）。`-gdwarf` 那一路是下一片。

<!-- 第九刀第六十九片-END -->

## 落地：第九刀第七十片

**`-gdwarf`。** 接着上一片，把调试信息的另一路补齐。跑下来出乎意料地短 —— 因为第六十九片
把「谁在什么时候进符号表」那一格解决之后，剩下的只有两处不同。

**一、造出来的是另一套节。** `tcc_debug_new` 里 `if (s1->dwarf)` 那一支造十三节：
`.debug_info`、`.debug_abbrev`、`.debug_line`、`.debug_aranges` 是真会写的；接着七节
（`.debug_macro`、`.debug_loc`、`.debug_ranges`、`.debug_loclists`、`.debug_rnglists`、
`.debug_str_offsets`、`.debug_addr`）注释里写明只是「为了让 `R_DATA_32DW` 那种重定位有
地方落」，一个字节都不写；最后 `.debug_str`（带 `SHF_MERGE|SHF_STRINGS`），dwarf 5 还多
一节 `.debug_line_str`。与 stabs 那一路不同，**它们都不带起手内容**。

那七节空着也不白占：摆地址那一步里，空节虽然不进节表，可 `s->sh_addr = addr =
pe_virtual_align(pe, addr)` 是在 `continue` **之前**做的。第一节把地址推到下一个
0x1000，后面六节看到的地址已经对齐了，`pe_virtual_align` 就是个恒等式 —— 于是七节全落在
同一个地址上，一页也没浪费。`.debug_str` 接着从那儿开始。这一格是「空节照样推地址」
（第四十八片）与「已经对齐就不再推」两条规则合起来的结果，看着像巧合，其实是必然。

`s1->dwlo` / `dwhi` 就是这十三节的区间。我们那边把这一串导出成 `DWARF_SECTIONS`，
按名字判断 —— 反正只有 `tcc_debug_new` 造的这几个名字落在区间里，输入里别的
`.debug_*` 是后建的，号在 `dwhi` 之外。

**二、dwarf 指向 dwarf 的重定位有两处例外。** 两处都在问同一个问题「这条重定位的目标节
与符号所在的节是不是都在 dwarf 区间里」：

- `relocate_section`：`if (is_dwarf && type == R_DATA_32DW && sym->st_shndx` 在区间里
  `) add32le(ptr, tgt - s1->sections[sym->st_shndx]->sh_addr)` —— 写的是**节内偏移**，
  不是绝对地址。`R_DATA_32DW` 在 x86_64 上是 `R_X86_64_32`、别的目标上是 `R_DATA_32`
  （arm64 的 `R_AARCH64_ABS32`）。DWARF 里 `.debug_info` 指 `.debug_str` 的那些字段本来
  就该是节内偏移。
- `pe_build_reloc`：同样的条件，这几条**不进** `.reloc`。装载时搬动映像不影响调试信息
  内部互相指的偏移。

第一处不加，`.debug_info` 里指向 `.debug_str`、`.debug_line_str` 的那几格就写成了映像
地址（第一次跑出来 x86_64 差 38 个字节，全在 `.debug_info` 里）；第二处不加，arm64 的
`.reloc` 会多出一堆条目。

命令行上是 `omni pe-link -gdwarf`（也认 `-gdwarf-N`）。`pe-debug` 那道门于是从九种走法
长到十七种（八种 dwarf 的），两个目标 **34 份逐字节相同**（345955 字节）。

至此 PE 那一路 tcc 自己会走的每条路都对上了：可执行文件、dll、接着 `.def` / 真 `.dll` /
资源文件链、十二个链接器开关、`__thread`、`-g` 与 `-gdwarf`。剩下的是 tcc 自己也不常走
的几处（`-Wl,--no-*` 那几个反开关、i386/arm 那两个目标的 stdcall 修饰、造 dll 时顺手写
的那份 `<输出>.def` —— 最后这个是下一片）。

<!-- 第九刀第七十片-END -->

## 落地：第九刀第七十一片

顺手写出的那份 `<输出>.def`，还有它背后那件一直漏着的事：**导出表不问是不是 DLL。**

`pe_build_exports`（`tccpe.c:1025`）是 `pe_assign_addresses` 走到 thunk 那一节时无条件
调的一次 —— 跟 `pe_build_imports` 并排：

```c
if (s == pe->thunk) {
    pe_build_imports(pe);
    pe_build_exports(pe);
    if (pe->tls_size)
        pe_build_tls(pe, NULL);
}
```

我们原先拿 `if (dll)` 把它挡住了，因为「导出表是 DLL 的东西」听起来天经地义。可拿一份
带 `__declspec(dllexport)` 的 `main` 链成 `.exe` 就看得见：数据目录第 0 条指着一张
80 字节的导出目录。挡不得。改法只有一句 —— 把那个 `if` 去掉，让 `buildExports` 自己在
「一个导出符号都没有」时回 `null`（它本来就这么写的，`if (list.length === 0) return null`）。

`.def` 那一段是 `pe_build_exports` 里那段 `#if 1`，就三行：

```c
pstrcpy(buf, sizeof buf, pe->filename);
strcpy(tcc_fileextension(buf), ".def");
op = fopen(buf, "wb");
fprintf(op, "LIBRARY %s\n\nEXPORTS\n", dllname);
...
    if (op) fprintf(op, "%s\n", name);      /* 摆表的那个循环里顺路写 */
```

三处细节：

- **换扩展名换的是基名里最后一个点**。`tcc_fileextension` 先 `tcc_basename`，再
  `strrchr(b, '.')`，找不到就回字符串末尾 —— 于是 `my.lib.dll` 出来的是 `my.lib.def`
  （不是 `my.def`），而 `out.d/foo` 出来的是 `out.d/foo.def`（目录名里的点不算）。
- **`LIBRARY` 后面是基名，连扩展名一起**：`LIBRARY p.q.exe`。跟导出目录里那个
  `hdr->Name` 指着的字符串是同一个 `dllname`。
- 名字的次序跟表里一样 —— 已经按 `strcmp` 排过。`_` 是 0x5f、小写字母从 0x61 起，所以
  `_mid` 排在 `alpha` 前面。文件是 `"wb"` 开的，换行就是一个 `\n`，末尾也有一个。

落地上 `buildExports` 多回一个 `def` 字符串，`peWrite` 把它连同算好的路径挂成
`r.def = {path, text}`；真往磁盘写的是 `cli.js`（链接器这一层不碰文件系统）。`defPath`
就是上面那条换名规则。

新门 `tests/c/pe-def.js` 两样都比：映像自己的字节，和旁边那份 `.def` 的字节。案例是
`pe-def/`（带 `main`，链 `.exe`）加 `pe-gen/`（带 `_dllstart`，链 `.dll`，而且同一份
`.o` 再链一遍 `<名字>.two.dll` 专门看换扩展名认的是哪个点）—— 8 种 × 2 个目标，
`32 条相同, 0 条不同`（69252 字节）。CLI 也对：`pe-link e.o -o a/p.q.exe` 出来的
`p.q.exe` 与 `p.q.def` 都与 tcc 的逐字节相同。

至此 PE 那一路只剩两处 tcc 自己也不常走的：`-Wl,--no-*` 那几个反开关，和 i386/arm 那
两个目标的 stdcall 修饰（`leading_underscore` 一开，`pe_export_name` 那个削下划线的分支
才有活干）。

<!-- 第九刀第七十一片-END -->

## 落地：第九刀第七十二片

32 位那两个目标（i386 / arm）的目标文件：**ELF32**。

到这一片为止我们只读得懂 ELF64。可 `i386-win32-tcc -c` 与 `arm-wince-tcc -c` 出来的
`.o` 是 `ELFCLASS32`：头 52 字节、节头 40 字节、符号 16 字节，而重定位是 `Elf32_Rel` ——
**没有加数那一格**。tcc 那边这一整套是两个宏一换（`tcc.h:401`）：

```c
#if PTR_SIZE == 8
# define ElfW_Rel ElfW(Rela)
# define SHT_RELX SHT_RELA
#else
# define ElfW_Rel ElfW(Rel)
# define SHT_RELX SHT_REL
#endif
```

四处不只是「短一半」，是**摆得不一样**：

- `Elf32_Sym` 的字段次序与 64 位那份不同：`st_name`、`st_value`、`st_size` 在前，
  `st_info` / `st_other` / `st_shndx` 在后。64 位那份是 name、info、other、shndx 之后
  才是 value 与 size。
- `Elf32_Rel.r_info` 是一个 32 位的字：**高 24 位**是符号号、低 8 位是类型（64 位那份是
  高 32 位符号号、低 32 位类型）。加数写在被修的那几个字节里，跟着节的内容一起并过来 ——
  于是并合这一步反而更省事，`r_addend` 那一格根本不存在。
- `new_section` 默认的对齐是 `PTR_SIZE`，所以起手那几条节（`.text`/`.data`/`.data.ro`/
  `.bss`/`.symtab`）在 32 位上是 **4** 而不是 8。
- arm 还带 `e_flags`：`EF_ARM_EABI_VER5 | EF_ARM_VFP_FLOAT`（0x05000400）。我们照输入
  里那份抄 —— 并合的输入本来就是同一个 tcc 出的。

还挖出来一格：**arm 上 tcc 根本不造 `.eh_frame`**。`tccdbg.c` 里明明有一段 arm 的 CIE，
可 `tcc.h:1839` 那个 `#if` 把 `TCC_EH_FRAME` 关掉了（`defined TCC_TARGET_ARM` 在排除
列表里），所以那段代码是死的。第一次跑的时候 arm-linux 每份都长出 90 字节，就是我们照
x86 的样子给它建了一条。

代码上是 `elf.js` 的 `readObject` / `writeSections` 认位宽（`readObject` 顺手回
`class32` 与 `flags`），`elf_merge.js` 把 `SYM_SIZE` / `RELA_SIZE` / `SHT_RELA` 换成
按位宽算的 `symSize` / `relSize` / `relType`，另外 `.eh_frame` 的 CIE 表补上 i386 那一
支（`data_alignment_factor` 是 -4 不是 -8，返回地址列 8，CFA 是 `esp + 4`）。

`elf-merge` 那道门于是从六个目标长到**十个**：i386-linux、arm-linux、i386-win32、
arm-wince 四个新的，`436 条相同, 0 条不同`。这一格是 PE32 的地基 —— 那两个目标的
`.o` 读不进来，链接器那一层无从谈起。

<!-- 第九刀第七十二片-END -->

## 落地：第九刀第七十三片

第七十二片把 32 位的 `.o` 读进来了，这一片把它们**链成一份 PE32**。尺子是
`i386-win32-tcc a.o -o a.exe` 与 `-shared a.o -o a.dll`。

PE32 与 PE32+ 的差，全在几格宽度上：可选头 0xe0 而不是 0xf0（整个头 376 而不是 392）、
魔数 0x010b、`ImageBase` 与那四格栈/堆是 4 字节，并且**多一格 `BaseOfData`**（偏移 24）。
那一格我一开始按「第一个不是代码的节」写，错了 —— `tccpe.c:741` 只在 `case sec_data`
里填它，`.rdata`（`sec_rdata`）不算，所以 `.text`/`.rdata`/`.data` 的映像里它是 `.data`
的 RVA，不是 `.rdata` 的。`writeImage` 于是改成走一个游标 `p`，那一格插进去，后面所有
偏移自然跟着挪；往返那一路（`pe-roundtrip`）读回来的时候节的类已经没了，所以
`readImage` 把这一格原样留下，写回去照抄。

i386 那边这一片新学了三件事：

- **导入桩是 8 字节的 `ff 25 <绝对地址>`**。`write32le(p+2, -4)` 那一句在
  `#ifdef TCC_TARGET_X86_64` 里 —— 32 位上 `ff 25` 后面跟的是 IAT 那一格的**绝对**
  地址，重定位是 `R_386_32`。IAT 一格 4 字节，序号位是第 31 位。
- **`R_XXX_THUNKFIX` 在 i386 上就是 `REL_TYPE_DIRECT`**（都是 `R_386_32`），所以每个
  桩里那 4 字节也得进 `.reloc`。这一格漏了，`.reloc` 就短 4 字节 —— DLL 那一路第一次
  跑就是这么差的：`08-bitfield` 少两条 `HIGHLOW`，块长 0x34 而不是 0x38。arm64 上
  THUNKFIX 也是 DIRECT（`ABS64`），那一支早就有了；只有 x86_64 是 PC32，不算。
- **`R_386_TLS_LE`（17）** 与 x86_64 的 `TPOFF32` 同一个形状：`tls_end` 有就
  `val - tls_end`，没有就退回符号所在那一节的末尾。PE 上 `tls_end == tls_start`。
  `IMAGE_TLS_DIRECTORY` 也跟着窄一半：四个指针加两个 DWORD，32 位上是 **24** 字节。

最费时间的是入口符号。`PE_STDSYM(n,s)` 是**按目标**定的宏 ——
`#if defined TCC_TARGET_X86_64 || defined TCC_TARGET_ARM64` 时是 `n`，否则是 `"_" n s`。
我原先把它挂在 `leading_underscore` 上，于是 i386 的 DLL 去找 `_dllstart`，
`dllcrt1.o` 一个都没拉出来（`.text` 136 字节对 tcc 的 1024）。真正的名字是
`___dllstart@12`，`pe_add_runtime` 那两句
`pe->start_symbol = start_symbol + 1; if (!leading_underscore || strchr(start_symbol,'@')) ++start_symbol;`
把它削成 `__dllstart@12` —— 带 `@` 的一律再削一次，与前导下划线无关。`WinMain` 那两条
查的也是 `_WinMain@16`。`peStart` 于是多收一个 `stdcall`，由 `peLoad` 从输入 `.o` 的
机器号定；`leading_underscore` 只管最后削不削那一下。

顺带一格：`pe_load_res` 里 `rel.type != RSRC_RELTYPE` 是硬卡的，i386/arm 上那个值是
**7**（`DIR32NB`）不是 3。`readRes` 改成按资源文件自己头里那个机器号选 —— tcc 那句
`hdr.filehdr.Machine != IMAGE_FILE_MACHINE` 保证它就是目标的机器号。

十一道 PE 门于是都长出第三个目标：`pe-exe` `258 条相同`、`pe-dll` `270 条相同`、
`pe-secs`/`pe-content`/`pe-imports`/`pe-load`/`pe-roundtrip` 各 `240 条`、
`pe-flags` `216 条`、`pe-rsrc` `108 条`、`pe-debug` `51 条`、`pe-def` `48 条`、
`pe-dll-link` `6 条`，全 0 条不同。命令行上
`omni pe-link --target i386-win32`（带与不带 `--shared`）写出来的 `.exe`、`.dll` 与
那份 `.def` 也与 tcc 逐字节相同。

<!-- 第九刀第七十三片-END -->

## 落地：第九刀第七十四片

第四个 PE 目标：**arm-wince**。尺子是 `arm-wince-tcc a.o -o a.exe` 与 `-shared`。
位宽那一层第七十三片已经铺好，剩下的都是 arm 自己的几格：

- **桩是 12 字节**：`ldr ip, [pc]`（0xe59fc000，`pc+8` 正好指着后面那一格）、
  `ldr pc, [ip]`（0xe59cf000），再跟一格 IAT 的绝对地址。`R_XXX_THUNKFIX` 是
  `R_ARM_ABS32`，落在 +8。
- **`REL_TYPE_DIRECT` 是 2**，不是 1。这一格原先写错了 —— `directRelocType` 把 i386 与
  arm 合在一起回 1，可 `R_386_32` 是 1、`R_ARM_ABS32` 是 2。错的后果不是「少一条」而是
  「换了一批」：`.reloc` 里收进来的是一堆 `R_ARM_PC24`（也是 1 号）的位置，条数与偏移
  全不对。DLL 那一路第一次跑，六条 `HIGHLOW` 变成三条、偏移从 0x4f0…0x5b4 变成
  0x5fc…0x620。
- **subsystem 一律 9**：`pe_set_options` 里 arm 那一支是整段 `#if defined TCC_TARGET_ARM`
  —— 连 DLL 都不走「DLL/GUI 是 2」那条路。`pe_setsubsy` 那张表在 arm 上也只有
  `wince` 一档，所以 `-Wl,-subsystem=gui` 这类开关 tcc 自己就报错。
- **`R_ARM_TLS_LE32`（108）多加 8**：`x = val - tls_start + 8`（`tls_end` 是 0 时退回
  符号所在那一节的末尾，同样 +8）。x86 那两个目标既不加也是减 `tls_end`，这是三份
  算式里唯一带常数的一份。
- **`R_ARM_PC24` 那一族**（`PC24`/`PLT32`/`CALL`/`JUMP24`）：原地那 24 位是右移过 2 位
  的加数，要先左移、按 26 位符号扩展，加完再移回去；`val & 1` 是 thumb，那时把
  `bl` 换成 `blx`（0xfa000000）并把第 1 位挪到 24 位上。

还有一条不在 arm 名下、可只有 arm 撞得着：**`__tls_index` 这个符号**。
`pe_build_tls` 用 `set_elf_sym` 写它 —— 符号表里本来有就原地改，没有就接在末尾。
i386 的代码生成会引用它，所以那一路它早就在表里（位置也就对得上）；arm 用
`TLS_LE32` 直接算偏移，谁都不引用，于是 tcc 的 COFF 符号表末尾多出一条而我们没有
（`-g` 出来的映像少 30 字节，`NumberOfSymbols` 63 对 64）。`buildCoffSyms` 于是在有
TLS 且表里还没有的时候补上这一条。

十二道 PE 门都长到**四个目标**：`pe-exe` `344 条`、`pe-dll` `359 条`、
`pe-secs`/`pe-content`/`pe-imports`/`pe-load`/`pe-roundtrip` 各 `320 条`、
`pe-flags` `270 条`（arm 上那三档 subsystem 归到「tcc 自己就链不上」）、
`pe-rsrc` `144 条`、`pe-debug` `68 条`、`pe-def` `64 条`、`pe-dll-link` `8 条`，
全 0 条不同。命令行上 `omni pe-link --target arm-wince` 的 `.exe`、`.dll` 与 `.def`
也都对上。

最能说明问题的是 `pe-tcc`：**四个目标 × 两种编法（`ONE_SOURCE` 与拆成 12 个 `.o`）
八份 tinycc 自己的 `.exe` 全部逐字节相同** —— i386 那份 323072 字节、arm 那份
415232 字节。tcc 在 Windows 上支持的四个目标，链接器这一层至此全部对齐。

<!-- 第九刀第七十四片-END -->

## 落地：第九刀第七十五片

32 位那两个 Linux 目标（`i386-linux`、`arm-linux`）的可执行文件与共享库。Windows 那
四个目标齐了之后，ELF 这一路还只有 64 位两个 —— 这一片把 `elf_exe.js` 从「64 位写死」
改成认位宽的。

位宽带来的格子，一处不能少：

- 头 52 / 程序头 32 / 节头 40，`e_ident[EI_CLASS]` 是 1。**ELF32 的程序头把
  `p_flags` 挪到倒数第二格**（type, off, vaddr, paddr, filesz, memsz, flags, align），
  ELF64 是第二格 —— 这一处错了段的权限全歪。
- `Elf32_Sym` 16 字节，次序也不同：name、value、size 在前，info/other/shndx 在后。
- `Elf32_Rel` 8 字节，**没有加数那一格**：`r_info` 是 `符号 << 8 | 类型`，加数早在
  落笔那一趟就加进被改的字节里了。表的类型跟着从 `SHT_RELA` 变成 `SHT_REL`，节名
  也从 `.rela.` 变成 `.rel.`。
- `.dynamic` 一条 8 字节，几号也换了一套：`DT_REL`/`DT_RELSZ`/`DT_RELENT`/
  `DT_RELCOUNT`，`DT_PLTREL` 的值跟着变成 `DT_REL`（`fill_dynamic` 里那个
  `#if PTR_SIZE == 8` 的另一半）。
- `.gnu.hash` 的 bloom 一格是一个 `addr_t`：32 位上 4 字节，`bloom_shift` 也从 6
  变成 5，位掩码取模从 64 变成 32。
- `.got` 头三格是 `3 * PTR_SIZE` = 12 字节，每格 4 字节；`.dynsym`/`.hash`/
  `.dynamic` 的 `sh_addralign` 都是 `PTR_SIZE`。

装载地址与解释器：i386 是 `0x08048000` / `0x1000` / `/lib/ld-linux.so.2`，arm 是
`0x00010000` / `0x10000` / **`/lib/ld-linux-armhf.so.3`** —— 交叉编译出来的 arm-tcc
是硬浮点的，`tccelf.c:117` 那个 `#if` 走的是 armhf 那一支。这一处一开始写成了
`/lib/ld-linux.so.3`，于是 arm 的动态可执行文件整份短 8 字节。

跳板与 GOT 那几处按目标各写一遍：

- i386 的 `create_plt_entry` 与 x86_64 同形，只有一处不同：push 的那个数在 i386 上
  是**字节**（`relofs - sizeof(Elf32_Rel)`），x86_64 上是**条数**。静态那一路
  `relofs` 是 0，于是 -8。`relocate_plt` 是把 GOT 的绝对地址**加**进那三处
  （32 位取址不走相对寻址）。
- arm 的 PLT0 二十字节（`push {lr}` / `ldr lr,[pc,#4]` / `add lr,pc,lr` /
  `ldr pc,[lr,#8]!`，末四字节留给 `relocate_plt`），每格 16 字节里只在 +4 记 GOT
  的偏移；`relocate_plt` 用四条 `add`/`ldr` 把地址凑出来 —— 一条里的立即数只带得动
  8 位。
- **`.ARM.attributes`**：`create_arm_attribute_section` 是 `elf_output_file` 一进门
  就叫的，`elf_output_obj` 那一路**不叫** —— 所以 `.o` 里没有这一节，可执行文件与
  共享库里有，而且 `tcc_load_object_file` 的 `sh_type` 筛子也不收它（输入里的同名节
  一律扔掉，输出里那一份永远是写死的 45 字节）。它还是非 alloc 的节里唯一能留下
  `sh_size` 的一条（`set_sec_sizes` 里那个 `|| s->sh_type == SHT_ARM_ATTRIBUTES`），
  否则会跟 `.symtab` 一样被摘掉。少了它，arm 的可执行文件整份短 101 字节
  （45 + 名字 16 + 节头 40）。

`build_got_entries` 里两条「只有 32 位才踩到」的规矩，也是这一片才补上的：

- `!PCRELATIVE_DLLPLT && (output_type & TCC_OUTPUT_DYN)`：i386 上这个宏是 0
  （没配 `CONFIG_TCC_PIC`），于是造共享库或位置无关的可执行文件时，未定义符号那一类
  **一格 GOT 都不给**。arm 上是 1，照旧要。
- `SHN_ABS` 那种（`tcc_add_symbol` 放的）只有 64 位才过 GOT，`#ifndef TCC_TARGET_ARM`
  把 arm 排除在这条之外。

还有一条与位宽无关、可 64 位那边一直没露头的：AUTO 那一类里未定义符号如果在
`.dynsym` 里是个函数，`goto jmp_slot` 会**连第二趟一起跳过**（`jmp_slot:` 头一句是
`if (pass != 0) continue`）—— 取地址那一处于是不再单独要一格 GOT，留给 `.rel.text`
里的装载期重定位。arm 的 `15-plt` 就是这一条：我们本来多造了一格 GOT 加一条
`.rel.got`。

最后一处是 `fill_local_got_entries`：RELA 的架构上 tcc 只改加数，REL 的架构上没有
加数那一格，值得**写进 GOT 那一格自己**（`write32le(got->data + offset, st_value)`）。
i386 的 `16-tls` 卡在这儿 —— 整份只差 GOT 里那两个字节。

五道 ELF 关口现在都是四个目标：`elf-exe` `41 条`、`elf-dyn` `41 条`、`elf-so`
`48 条`、`elf-dll` `18 条`、`elf-flags` `195 条`，全 0 条不同。命令行上
`omni elf-link` 的 i386/arm 可执行文件与共享库也都逐字节对上。

<!-- 第九刀第七十五片-END -->

## 落地：第九刀第七十六片

riscv64 —— tcc 支持的第五个 Linux 目标，`.o`、可执行文件、共享库一并对齐。

这一片小得出人意料：ELF64 的骨架、`Elf64_Rela`、`.dynamic` 那一套全都现成，真正
新的只有四处。

**`.eh_frame` 的 CIE 版本是 3**（`tccdbg.c:864` 那句
`eh_frame_section->data[eh_start + 8] = 3`）。五个目标里只有它这么写；`code`/`data`
是 1 / -4，返回地址列是 1（ra），CFA 寄存器是 2（sp）。这一格错了，并合出来的 `.o`
从 `.eh_frame` 起全不对 —— 而这也是 `.o` 那一路**唯一**要改的地方。

**`e_flags`**：`.o` 那一路早就从输入里抄了，可可执行文件那个写头的分支 64 位那一半
一直写死 0（32 位那一半在第七十五片补的时候顺手加了）。riscv64 的 `.o` 里是 4
（`EF_RISCV_FLOAT_ABI_DOUBLE`），于是整份文件只差 `e_flags` 那四个字节。

**跳板**：`create_plt_entry` 与 arm64 形状完全一样（头一格 32 字节留空，每格 16
字节里先记 GOT 的偏移，64 位小端），所以那一段一个字都不用改；`relocate_plt` 是
riscv 自己的八条指令 —— `auipc t2` / `sub t1,t1,t3` / `ld t3` / `addi t1,t1,-44` /
`addi t0,t2` / `srli t1,t1,1` / `ld t0,8(t0)` / `jr t3`，每一格四条
（`auipc t3` / `ld t3` / `jalr t1,t3` / `nop`）。

**`__global_pointer$`**：`tcc_add_linker_symbols` 里 riscv 独有的一条，落在
`.data + 0x800`（源码里那句注释说「本该是 `.sdata`」）。它只在 `-rdynamic` 那一档
露头 —— 那时所有有定义的非局部符号都进 `.dynsym`，少这一条就少 24 字节符号加 18
字节名字。

重定位那一层是新写的一整段（`riscv64-link.c` 的 `relocate`），要紧的是 **hi/lo 是
成对的**：`PCREL_HI20`/`GOT_HI20` 落笔时把「这一处的地址 -> 目标值」记下来，
`PCREL_LO12_I`/`_S` 那条的**符号值就是 HI20 那条的地址**，拿它回头查
（`riscv64_record_pcrel_hi` / `_lookup_pcrel_hi`）。于是 `relocateOne` 多了一个
参数：一张按链接过程活着的表。`auipc` 的高 20 位都带 `+0x800` 的进位补偿，
`BRANCH`/`JAL`/`RVC_*` 的位散在四五处，一处一处照抄。

五道 ELF 关口现在都是五个目标：`elf-exe` `53 条`、`elf-dyn` `53 条`、`elf-so`
`60 条`、`elf-dll` `21 条`、`elf-flags` `243 条`、`elf-merge` `441 条`，全 0 条
不同。命令行上 `omni elf-link` 的 riscv64 可执行文件与共享库也逐字节对上。

至此 tcc 支持的**九个目标**（Linux 五个、Windows 四个、macOS 两个里的 arm64/x86_64）
在链接器这一层全部与 tcc 逐字节相同。

<!-- 第九刀第七十六片-END -->

## 落地：第九刀第七十七片

真的 `.dylib` 二进制能当链接输入了（`macho_load_dll`，tccmacho.c:2351）。

在这以前 Mach-O 那一路的 `--dylib` 只认 `.tbd` —— SDK 里那种文本 stub，
`parseTbd` 撕出 `install-name` 与一串 `symbols: [...]` 就完事（第五十七片）。
于是「自己刚 `-shared` 出来的那份库」读不进去，ELF 那边早有的 `elf-dll` 那道门
（第六十片）在 Mach-O 上一直是空的。

**dylib 对链接器来说就是一张名字表。** tcc 只看四条加载命令：

- `LC_SYMTAB`：`symoff`/`nsyms`/`stroff`/`strsize` —— 符号表与字符串表在哪。
  偏移都是**相对那一片的起点**（`machofs + sc->symoff`），胖文件里不是文件头。
- `LC_ID_DYLIB`：安装名。这个名字后面进可执行文件的 `LC_LOAD_DYLIB`，
  所以门里两边的库路径必须是同一个字符串。没有这条就退回命令行上的文件名。
- `LC_DYSYMTAB`：`iextdefsym` 与 `nextdefsym`。真正登记进 `dynsymtab` 的只有
  `symtab[iextdef .. iextdef+nextdef)` 这一窗，一律记成 GLOBAL/NOTYPE/UNDEF ——
  值和节都不看，装载时平坦查找。
- `LC_REEXPORT_DYLIB`：顺着名字再开一份文件、带 `lev + 1` 递归进去。
  「重导出连不成环」是 tcc 的假设，它自己没查，我们也不查。

段的内容一个字节都不读。

**level 那一格是有用的。** `macho_output_file` 发 `LC_LOAD_DYLIB` 时有一句
`if (dllref->level == 0)` —— 命令行上摆的库是 0，重导出钻进来的是 1，后者只贡献
名字表，不进可执行文件的依赖列表。`tcc_add_dllref`（libtcc.c:1040）还会把已经装过的
那条的 level **往小的那边收**，去重是按安装名、跨 `.tbd` 与 `.dylib` 全局的。
`loadInputs` 于是从「一个 `dylibNames` 数组」改成「一张 `{soname, syms, level}` 的表」，
`dylibNames` 变成 `filter(level === 0)` 的投影。

**胖二进制那一段照抄了 tcc 的严格比。** 头是大端写的，tcc 按本机字序读一遍 magic：
读出 `FAT_MAGIC` 就不翻，读出 `FAT_CIGAM`（小端机器上就是这个）就每个字段都翻。
挑片的条件是 cputype **与 cpusubtype 都相等**，而 x86_64 要的是正好
`CPU_SUBTYPE_X86_ALL`。`lipo` 写出来的 x86_64 那片是
`CPU_SUBTYPE_X86_ALL | CPU_SUBTYPE_LIB64`（0x80000003），于是 **tcc 自己就认不出
胖文件里的 x86_64**（`unrecognized file type`）。我们跟着严格比，两边一起认不出 ——
门里那一路只在 tcc 链得上的时候才比，所以胖文件只在 arm64 上有一条。
`FAT_MAGIC_64` tcc 明着不管，我们也返回「读不动」。

一处容易踩的：**目标文件是 ELF**。tcc 的 `-c` 在所有目标上都写 ELF，Mach-O 只出现在
最终产物里。所以「这一趟是哪个架构」得从 `.o` 的 `e_machine`（+18）来，
再 `targetConf` 换成 cputype —— 头一版从 Mach-O 头 +4 读 cputype，读到的是
`\x7fELF` 后面那几个字节，胖文件一片都挑不中。

命令行上 `--dylib` 现在自己认字（`isMachoBinary`，就是 tcc 的 `tcc_object_type`
那一下）：Mach-O 或胖头就当真库读，别的当 `.tbd` 文本。

门是 `tests/c/macho-dll.js`，尺子：

```
<target>-osx-tcc -shared -nostdlib lib.o -o lib.dylib
<target>-osx-tcc -nostdlib use.o lib.dylib -o a.out
```

`9 条`全 0 条不同（x86_64 三条、arm64 三条 + 胖文件三条，共 418600 字节）。
借的是 `elf-dll/` 里那三对源文件。`macho-libc` `176 条`、`macho-tcc` `4 条`
（`.tbd` 那一路）没动。命令行上 `omni macho-link --dylib <真库>` 也逐字节对上。

<!-- 第九刀第七十七片-END -->

## 落地：第九刀第七十八片

`LC_RPATH`（tccmacho.c:1777）。

`-Wl,-rpath=` 给几次，tcc 用 `tcc_concat_str(&s->rpath, o.arg, ':')` 把它们攒成一串
冒号隔开的（libtcc.c:1478），写出来的时候再按冒号切回去，**一段一条 `LC_RPATH`**：

```
i = (sizeof(*rpath) + (end - path) + 1 + 7) & -8;   /* 12 + 路径 + '\0'，八字节对齐 */
rpath->path = sizeof(*rpath);                        /* 路径紧跟在结构体后面 */
```

`rpath_command` 是 `{cmd, cmdsize, path}` 三个 u32，12 字节。位置在
`LC_LOAD_DYLIB` 那一串后面。

两处值得记：

- 这段**不在** `if (output_type == TCC_OUTPUT_EXE)` 里，所以 `-shared` 出来的 dylib
  也发 `LC_RPATH`。
- 切法是 `do { ... } while (*end)`：切到底，所以末尾那个空段也会发一条空路径的
  `LC_RPATH`。`split(':')` 正好是这个行为。

命令行上是 `omni macho-link --rpath <路径>`，给几次攒几段。

门还是 `tests/c/macho-dll.js`：每个 case 多三路（一条 rpath 的可执行文件、两条的、
两条 rpath 的 dylib），`27 条`全 0 条不同（共 1227384 字节）。

<!-- 第九刀第七十八片-END -->

## 落地：第九刀第七十九片

macOS 上的 `-g`：stabs 与 dwarf 两路都与 tcc 逐字节相同。

三处要补：

**一、调试那几节要跟着并进来。** `linkObjects` 早就认 `{debug, dwarf}`（PE 那边
第五十片就用上了），Mach-O 这一路一直没往下传，于是输入 `.o` 里的 `.debug_*` 在并的
那一步就被 `mergeable` 拦掉了 —— 产物里连 `__DWARF` 段都没有。

`dwarf` 那个数字有个坑：`-gdwarf` 的默认版本**分目标**（tcc.h:1909）——

```c
#ifdef TCC_TARGET_MACHO
# define DEFAULT_DWARF_VERSION 2
#else
# define DEFAULT_DWARF_VERSION 5
#endif
```

版本 2 就没有 `.debug_line_str`（那一节是 dwarf 5 才加的），所以 macOS 上并出来的
调试节比 PE 上少一条。

**二、`collect_sections` 里 DWARF 的六节各自一类**（tccmacho.c:1677）。tcc 比的是
节的指针（`s == dwarf_info_section` …），我们按名字**全等**比 —— `.debug_line_str`
不能被 `.debug_line` 抢走。这六类的 `seg_initial` 都是 3，也就是 `__DWARF` 段，
标志 `S_REGULAR | S_ATTR_DEBUG`。别的 `.debug_*`（`.debug_macro`、`.debug_ranges`、
`.debug_loclists`、`.debug_str_offsets`、`.debug_addr` …）落到 `sk_ro_data` ——
它们本来就是空的，落哪儿都不影响字节。

**三、调试节里指向调试节的重定位写节内偏移**（tccelf.c:1159）：

```c
if (is_dwarf && type == R_DATA_32DW
    && sym->st_shndx >= s1->dwlo && sym->st_shndx < s1->dwhi) {
    add32le(ptr, tgt - s1->sections[sym->st_shndx]->sh_addr);
    continue;
}
```

`R_DATA_32DW` 在 x86_64 上是 `R_X86_64_32`（10）、arm64 上是 `R_AARCH64_ABS32`（258）。
最先露出来的就是它：`__debug_info` 里 CU 头 +6 那一格 `abbrev_offset`，tcc 写 0，
我们写的是 `__debug_abbrev` 的虚地址。PE 那一路（`pe_link.js:216`）早有同一道岔，
照抄过来即可。

还有一条不用补但要知道的：**从 `.o` 里读进来的 `.stab` 是丢掉的**。`sk_stab` 认的是
`s == stab_section`，也就是本次编译自己造的那一节；从输入并进来的那一条既没有
`SHF_ALLOC` 也不叫 `.debug_*`，归 `sk_discard`。所以 `-gstabs` 的产物里没有 `__stab`
段，只是符号表里多了几条 —— 我们本来就是这个行为，一个字没改就对上了。

门是 `tests/c/macho-debug.js`，尺子 `<target>-osx-tcc -gstabs|-gdwarf -nostdlib`，
十个 case（末一条是 `-shared`）× 两路 × 两个目标，`40 条`全 0 条不同（共 2396880 字节）。
挑 case 时避开了要 libc 的那些 —— `-nostdlib` 下 tcc 自己也链不上。
命令行上是 `omni macho-link -g [--dwarf 2]`。

<!-- 第九刀第七十九片-END -->

## 落地：第九刀第八十片

PE 上那几个反过来的开关（`-Wl,--no-*`）。

`tcc_set_linker` 里 `link_option` 的名字前面带 `?` 的，都能加 `--no-` 前缀
（libtcc.c:1494）。要紧的是**清的位不一定是设的那几位**：

```c
#define SET_OR_CLEAR(v,f)      (v = r > 0 ? v | f  : v & ~f)
#define SET_OR_CLEAR_2(v,f1,f2)(v = r > 0 ? v | f1 : v & ~f2)

?dynamicbase      → SET_OR_CLEAR_2(chars, 0x40, 0x60)
?high-entropy-va  → SET_OR_CLEAR_2(chars, 0x60, 0x20)
?nxcompat         → SET_OR_CLEAR  (chars, 0x100)
?tsaware          → SET_OR_CLEAR  (chars, 0x8000)
```

也就是：`--no-dynamicbase` 连 `HIGH_ENTROPY_VA`（0x20）一起清掉，
`--no-high-entropy-va` 却把 `DYNAMIC_BASE`（0x40）留着。`--high-entropy-va` 反过来
一下带起两位。

x86_64-win32 的 `DllCharacteristics` 默认是 0，`--no-` 什么都看不出来；
**arm64-win32 默认 0x8160**，四条各清出一个不同的值来 ——
`--no-dynamicbase` 那一条清掉 0x40 之后，可执行文件连 `.reloc` 那一节都没了
（`hasReloc = dll || (dllChars & 0x40) !== 0`）。

写出的那一层一个字没改 —— 我们本来就是拿 `dllChars` 这个数字往下走的，这一片补的是
**门没盖到的那五种走法**：`--high-entropy-va` 与四个 `--no-`。
`tests/c/pe-flags.js` 的走法从十二种涨到十七种，条数 `243 → 390`，全 0 条不同。

**`-fleading-underscore` 这一支没有尺子**（试过，退回来了）。它牵动三处：目标文件里
每个符号前多一个 `_`、`pe_export_name` 导出时又把那个 `_` 削掉（带 `@n` 的 stdcall
不削）、起手符号 `__start` 前面那个 `_` 留不留。写出的那一层我们早就照抄了
（`pe_sections.js:182`、`pe_load.js:141`）。可**尺子跑不起来**：交叉编译出来的
`libtcc1.a` 与 `msvcrt`/`kernel32` 的导入库里全是不带下划线的名字，
`-fleading-underscore` 一开 tcc 自己就一条都链不上。要盖到它得把整套运行库重新
配一遍，跟 `-pie` 在 32 位那几个目标上一样 —— 等有那份交叉编译器再说。

**`update_reloc_sections` 里补地址那一支是够不着的**（顺手记一下）。那个函数除了
算出 `DT_REL(A)` / `DT_REL(A)SZ`（这两格我们一直在算，`elf_exe.js:1656`），还会给
**第二张往后**的重定位表改地址与文件偏移：

```c
s->sh_addr   = dyninf->rel_addr + dyninf->rel_size;
s->sh_offset = file_offset + dyninf->rel_size;
```

也就是「把几张表挤成连着的一块，中间不留对齐的洞」。可这些洞本来就不存在：排序键
把所有重定位表排在一起（`.rela.plt` 单独一档排在后头），每张表的对齐是 `PTR_SIZE`
而每条的大小是 24（RELA）或 8（REL32）—— 都是对齐的整数倍，所以摆出来的地址天然就是
上一张的末尾。改与不改是同一个数。六道 ELF 门里带好几张重定位表的例子都对得上，
就是这个道理。

<!-- 第九刀第八十片-END -->

## 落地：第九刀第八十一片

`-dM` / `-dD` —— 把宏表自己印出来。

两个开关落成同一个数（libtcc.c:1979）：`-dD` → `dflag = 3`，`-dM` → `dflag = 7`。
读的地方只有两处：

- `dflag & 7` 开「边定义边印」（`pp_debug_defines`）；
- `dflag & 4` 再把**记号流那一半**掐掉（`pp_line` 一进来就返回，正文一个字不印）。

所以 `-dM` 的输出就是纯指令行，`-dD` 是指令行**夹在**正文里。

### 预定义那一批是怎么印出来的

tcc **没有**「先把表里已有的印一遍」这一步。`tcc_preprocess` 的循环里只有一处钩子
（tccpp.c:3933）：

```c
if (s1->dflag & 7) {
    pp_debug_defines(s1);
    if (s1->dflag & 4)
        continue;
}
```

预定义之所以会印出来，是因为在 tcc 里它们**本来就是一份源码**：`tcc_predefs` 把
tccdefs.h 那段文本当成 `<command line>` 这个文件喂进同一个循环，里头每条 `#define`
都走 `TOK_DEFINE` 那个 case —— `-dD` 的输出里那几行
`# 1 "<command line>" 1` / `# 132 "<command line>"` 就是这么来的。

我们的预定义是**三张表**（`tccdefs.js`），不是一段源码。所以这一步换了个形状：
`preprocessToText` 开头遍历一遍 `this.defines.keys()`（Map，次序就是插入次序），
之后循环里每取一个记号叫一次 `ppDebugDefines()`。印出来的东西一模一样 ——
但这也意味着**表的次序就是输出的次序**，见下面那一节。

`TOK_DEFINE` / `TOK_UNDEF` 那两个 case 与 `pragmaParse` 的 push/pop 分支各留一对
`ppDebugTok` / `ppDebugSymv`，照 tcc 的样子。

### 空格是量出来的

`tok_print`（tccpp.c:3772）那一行是这么写的：

```c
fprintf(fp, &" %s"[s], get_tok_str(t, v));
```

`s` 是**下标**：0 → `" %s"`（带一个前导空格），1 → `"%s"`（不带）。
起手 `s = 0`，印的就是 `#define NAME` 后面那个空格；之后一直是 1，
只有 `pp_need_space(t0, t)` 说「这两个记号贴着会粘成一个」时才回 0 补一格。
宏体源码里本来有的空格是**真的记号**（`add2Spc` 在 `needSpc === 3` 时存的 `SPC`），
不是靠这里补的。这条读反了输出就到处差一格 —— 我一开始就读反了，
拿 `#define A a b` / `#define F(x,y) x ## y + 1` 印一遍才纠回来。

### 顺手量出了预定义表的次序

`-dM` 是逐行比的，于是**表的次序**也进了对账范围。第一次跑出来只差一行：

```
8d7
< #define __TCC_PP__ 1
50a50
> #define __TCC_PP__ 1
```

`__TCC_PP__` 不在表尾 —— tcc 是在目标/OS 那一段之后就 `putdef` 的
（tccpp.c:3597，紧跟 `__unix`，在 `__leading_underscore` 前面）。
`tccdefs.js` 多了一个 `PP_ONLY_AFTER = '__unix'`，`installPredefs` 走到那一条就
把 `PP_ONLY_DEFS` 插进去。这种事只有逐行的尺子量得出来。

### 门

不新开文件：`tests/c/run.js` 里 `cpp/` 那八份各再走一遍 `-dD` 与 `-dM`
（尺子是 `tcc -E -P -dD` / `-dM`，`-P` 是因为我们从来不印 `# 行号 "文件"` 的行标 ——
那是另一片的事）。`compare()` 多一个 `mode` 参数，`8 条` → `24 条`，全部相同。
CLI 那一路 `omni cpp <文件> -dM|-dD` 同样与 `arm64-osx-tcc` 逐字节相同。

<!-- 第九刀第八十一片-END -->

## 落地：第九刀第八十二片

行标 —— `# 行号 "文件"` 那几行。

`tcc -E` 默认是印行标的；我们从第五刀起一直只对得上 `-E -P`（什么都不印那一路），
门也一直加着 `-P`。这一片把 `pp_line`（tccpp.c:3796）整个搬过来。

### 四种走法，次序有讲究

```c
if (s1->Pflag == LINE_MACRO_OUTPUT_FORMAT_NONE) {
    ;
} else if (level == 0 && f->line_ref && d < 8) {
    while (d > 0) fputs("\n", s1->ppfp), --d;
} else if (s1->Pflag == LINE_MACRO_OUTPUT_FORMAT_STD) {
    fprintf(s1->ppfp, "#line %d \"%s\"\n", f->line_num, f->filename);
} else {
    fprintf(s1->ppfp, "# %d \"%s\"%s\n", f->line_num, f->filename,
        level > 0 ? " 1" : level < 0 ? " 2" : "");
}
```

`Pflag = atoi(optarg) + 1`（libtcc.c:2092）：不给 `-P` 是 0（GCC 那种 `# 行号`）、
`-P` 是 1（不印）、`-P1` 是 2（`#line`）、`-P10` 是 11。

**第二支排在第三四支前面**，这是这段代码的重点：只要没进出文件（`level === 0`）、
这个文件先前印过一次行标（`line_ref` 非 0）、而且落后不到 8 行，就**补几个换行**——
行号靠数行对上，比印一行行标干净。差 8 行以上（一大段 `#if` 跳过去了）才值得印。
所以带行标的输出里，被 `#if 0` 吃掉的三五行会变成三五个空行，吃掉一整屏才会变成
一行 `# 137 "…"`。

`level` 是这一个记号把我们带进/带出了几层文件：`> 0` 行尾加 ` 1`、`< 0` 加 ` 2`、
`0` 什么都不加。带进去的时候还要先给**来处**补一行（`pp_line(*iptr, 0)`：`iptr`
那一格里放的正是压栈时的当前文件）—— 于是 `#include` 一进一出是三行行标。

`-dM`（`dflag & 4`）一进 `pp_line` 就返回，连 `line_ref` 都不动。

### 我们这边多出来的两格

`CFile` 多一个 `lineRef`（tcc 的 `BufferedFile` 是 calloc 出来的，所以起手 0，
而 `lineNum` 是 1 —— 「一行都还没印过」与「现在在第 1 行」是两回事，`d = 1` 那一次
就靠这个差走到印行标那一支）。真印出去一个换行的时候 `lineRef++`。

`Pflag === 11` 在 `preprocessToText` 开头就换成 `PF_TOK_NUM | (Pflag = 1)` ——
`-P10` 的意思是「每个 pp-number 都当场解成有类型的常量再印回去」，于是十六进制与
浮点全成了十进制。这一路上 `1e`、`0x1p` 这种**合法的 pp-number 但不是合法的 C 数字**
tcc 自己就拒（`cpp/01-lex.c` 正好有一个），门里记成 skip。

### 门：尺子要削掉一段序幕

tcc 的预定义是一份叫 `<command line>` 的**源码**，进出主文件都会印行标：

```
# 1 "a.c"
# 1 "<command line>" 1
# 1 "a.c" 2
```

我们的预定义是三张表，没有这一段。所以带行标比的时候把 tcc 那边「最后一行提到
`<command line>` 的 + 紧跟着回到主文件那一行」以上全丢掉，我们那边丢掉开头那一行 ——
两边都停在「主文件第 1 行、`lineRef = 1`」上，往后逐字节比。要量的东西
（`#include` 的进出、`#line`、`#if` 跳行之后补几个空行）一个没漏。

`cpp/` 八份各走五种走法（`-P`、`-dD`、`-dM`、`-E`、`-P1`、`-P10` 里除去 `-P` 那一种
算基准），`inc/` 那一份还多两种 —— 进出文件的 ` 1`/` 2` 只有真 include 才试得到。
`24 条` → `51 条`（1 条 skip）。CLI 那一路 `omni cpp <文件>`、`-P`、`-P1`、`-P10`
四种都与 tcc 逐字节相同。

<!-- 第九刀第八十二片-END -->

## 落地：第九刀第八十三片

`-M` 一族 —— 给 make 的依赖清单。

tinycc 自己的 Makefile 就用 `-MD`：每编一个 `.o` 顺手写一份 `.d`，下一趟 make 靠它
知道改了哪个头要重编谁。四个开关（libtcc.c:2095）落成三格状态：

- `-M`：`include_sys_deps = 1` + `just_deps = 1` + `gen_deps = 1`，落脚处默认 `-`（标准输出）
- `-MM`：同上，但不带 `include_sys_deps` —— 系统头不进清单
- `-MD` / `-MMD`：只 `gen_deps`，正文照出，`.d` 落到 `目标.d`
- `-MF <文件>` 换落脚处，`-MP` 补空规则

### 哪些头算「自己的」

记一笔的地方在 `#include` 成功之后（tccpp.c:1418）：

```c
BufferedFile *bf = file;
while (i == 1 && (bf = bf->prev))
    i = bf->include_next_index;
if (s1->include_sys_deps || i - 2 < s1->nb_include_paths)
    dynarray_add(&s1->target_deps, ..., tcc_strdup(buf));
```

`i` 是**在搜索表第几格找到的**：0 = 绝对路径、1 = 「跟 include 它的那份同一个目录」、
`2 + j` = 第 j 个 `-I`、再往后是系统目录。所以 `i - 2 < nb_include_paths` 的意思就是
「落在 `-I` 里」。

`i === 1` 那一格自己说不清身份 —— 一个系统头旁边的 `"foo.h"` 也是 `i === 1`。
于是顺着 `prev` 往上找第一个不是 1 的下标，拿祖先的身份当自己的。这一段我们照抄，
`includeTries` 因此改成回 `{path, i}`：**跳过的格子也占号**（`i` 是照着 `for(;;) ++i`
数的，绝对路径与「当前目录」两格即使不试也占 0 和 1），不然 `i - 2` 就对不上。

`CFile` 多一格 `includeNextIndex`（主文件是 0 —— tcc 那边是 calloc 出来的）。

### 印出来的样子

```c
fprintf(depout, "%s:", target);
for (i = 0; i < num_targets; ++i)
    fprintf(depout, " \\\n  %s", escaped_targets[i]);
```

去重是**印的时候**做的（`tcctools.c:625` 的 O(n²) 两重循环，记的时候重复留着）。
空白按 `escape_target_dep` 加反斜杠 —— `is_space` 那五个字符（空格、`\t`、`\v`、`\f`、
`\r`），**不含换行**。`-MP` 从第 1 个（跳过主文件）起，每个头一条 `头:` 空规则。

目标名是 `default_outputfile`（tcc.c:251）在 `just_deps` 那一路上算出来的：
**basename** 的后缀换成 `.o`，没有后缀就是 `a.out`。给了 `-o` 就用 `-o` 的。

### 门

`tests/c/run.js` 多一组 `depsCase`：比的是**两边 CLI 的 stdout**（依赖清单是驱动层的
产物，不是预处理器的返回值）。`inc/01-include.c` 走 `-MM`、`-MM -MP`、`-M`、`-M -MP`
四种，再加 `gen/01-expr.c` 一条（一个头都不 include，清单里只有 `.c` 自己）。
`-MF` 与 `-MMD` 落文件那两路手工量过，同样逐字节相同。

`cpp/` 那八份**不能**进这一组：`-M` 一族不带 `-E`，tcc 会真的把文件编一遍，
而那几份是预处理器的探针，本来就不是合法的 C（`'REC' undeclared`）。

**带系统头的 `-M` 是另一件事**：我们自带 `src/include/stddef.h` 并排在 SDK 前面，
tcc 在 macOS 上直奔 SDK —— 同一句 `#include <stddef.h>` 两边找到的不是同一份文件，
清单自然不同。那是搜索表的分歧，不是 `-M` 的分歧，所以门里只盖 `-MM` 与不牵动系统头的
`-M`。

<!-- 第九刀第八十三片-END -->

## 落地：第九刀第八十四片

`#include_next` 与 `__has_include_next` —— 两个阶段边界拆掉。

这两条一直是明着报错的（`cpp-bad/include-next`、`cpp-bad/has-include-next`），
留的话是「要给每份打开的文件记住它是在第几个 `-I` 里找到的」。上一片为了 `-M`
已经把那一格（`includeNextIndex`）记上了 —— 于是这一片只剩下一行的事：

```c
i = do_next ? file->include_next_index : -1;
for (;;) {
    ++i;
    ...
}
```

`includeTries` 多一个 `doNext`：从 `file.includeNextIndex + 1` 那一格起才收。
「跳过的格子也占号」这件事在这儿变成硬要求 —— 少算一格就会又找回自己，
成了自己 include 自己。

`__has_include_next` 与 `__has_include` 在 tcc 那边是**同一句**
（`parse_include(s1, t - TOK___HAS_INCLUDE, 1)`，tccpp.c:1480），我们也并成一支。

### 门

`inc/` 那一组从此有两个搜索目录（`include`、`include2`，都有一份 `next.h`）。
新用例 `inc/02-include-next.c`：

- `include/next.h` 里 `#include_next <next.h>` 落到 `include2/next.h`；
- `include2/next.h` 里 `__has_include_next(<next.h>)` 是**假**（没有第三层了）；
- 主文件里 `__has_include_next(<next.h>)` 是**真**（主文件那一格是 0，只跳过绝对路径那一格）。

三种走法（`-P`、`-E`、`-P1`）加四种 `-M` 走法，与 tcc 逐字节相同。`sys/` 那一组
（真的 macOS SDK）也重新验过 —— SDK 里的 `__has_include_next` 从此走真的路子。

<!-- 第九刀第八十四片-END -->

## 落地：第九刀第八十五片

驱动层那三个开关：`-U`、`-isystem`、`-nostdinc`。

### `-D` 与 `-U` 共用一条顺序

两个都不是「设一格状态」—— tcc 把它们**当文本写进同一个缓冲**：

```c
void tcc_define_symbol(s1, sym, value)
{ ... cstr_printf(&s1->cmdline_defs, "#define %.*s %s\n", ...); }

void tcc_undefine_symbol(TCCState *s1, const char *sym)
{ cstr_printf(&s1->cmdline_defs, "#undef %s\n", sym); }
```

那个缓冲随后当 `<command line>` 这个文件过一遍。所以顺序是命令行上的顺序：
`-DX=1 -UX` 之后 X 没有，`-UX -DX=1` 之后 X 是 1。我们的 `defArgs` 因此改成回
一条**混在一起的**表，宏体 `null` 就是 `#undef`；`Cpp` 多一个 `undefine()`，
与 `define()` 共用那台「假装是 `<command line>` 里的一行」的机器（`cmdlineLine`）。

`-U` 掀一个本来就没有的名字，什么都不该发生 —— 门里有这一条。

### `-isystem` 排在前面

`-isystem` 是在**选项解析里**就 `tcc_add_sysinclude_path` 的，而自带的那一份
（`CONFIG_TCC_SYSINCLUDEPATHS`）是 `tcc_set_output_type` 里补的（libtcc.c:973）——
选项在前，所以 `-isystem` 给的目录排在自带那一份前面。`-nostdinc` 只是把补那一步
跳掉，`-isystem` 给的照留。这两条合起来就是 `sysIncDirs(argv)` 那七行。

### 门：`optCase`

`tests/c/run.js` 多一支 `optCase`：尺子是 `tcc -E -P <开关>`，比两边 CLI 的 stdout。
新用例 `cpp/09-cmdline.c`（不带开关也过得去 —— 没定义的名字在输出里就是它自己）
走六种 `-D`/`-U` 组合，`inc/02-include-next.c` 走两种 `-isystem`（一种再加 `-nostdinc`）。

`-DY` 那一条钉的是「没有 `=` 的宏体是 `1` 不是空」：源码里 `#if defined Y && Y > 1`
于是为假。展开成空的话这一行会变成 `bad preprocessor expression`。

**`-include` 还没做**：它是 `cstr_printf(&s->cmdline_incl, "#include \"%s\"\n", ...)`，
落在 `<command line>` 那个缓冲的**末尾**（预定义与 `-D` 之后）。我们的预定义是三张表、
`-D`/`-U` 是一行一行喂进去的，`<command line>` 从来不是一个真的 include 层 ——
要把它变成真的（主文件压栈、`file->prev` 指回去），那是独立一片。

<!-- 第九刀第八十五片-END -->

## 落地：第九刀第八十六片

`-include` —— `<command line>` 成了一个真的 include 层。

tcc 那边这一层一直是真的：`preprocess_start`（tccpp.c:3653）把预定义、`-D`/`-U`、
`-include` 拼成一份文本，当成一个**压在主文件上面**的文件读；读完了自然回到主文件。
`-E` 的输出开头那三行就是它的凭据：

```
# 1 "a.c"
# 1 "<command line>" 1
# 1 "a.c" 2
```

我们的预定义是三张表、`-D`/`-U` 是一行一行喂进去的，所以这一层以前不存在。这一片让它
在**有 `-include` 的时候**存在：

```js
pushCmdlineIncls() {
  if (this.cmdlineIncls.length === 0) return;
  const src = this.cmdlineIncls.map((n) => `#include "${n}"\n`).join('');
  this.includeStack.push(this.file);
  const f = new CFile('<command line>', src, this.file);
  f.ifdefBase = this.ifdefStack.length;
  this.file = f;
  this.tokFlags = TOK_FLAG_BOL | TOK_FLAG_BOF;
}
```

三件事跟着自动就对了：`"..."` 那一格（下标 1）算的是 `<command line>` 的目录 ——
`dirname("<command line>")` 没有斜杠，`join` 出来就是文件名本身，也就是**当前工作
目录**，与 tcc 的 `tcc_basename(p) - p == 0` 一样；进出这一层的行标（` 1` / ` 2`）
走的是第八十二片那套 `level` 逻辑；依赖清单里也有它（`i === 1` 顺着 `prev` 认到主文件
那一格 0，于是记上）。

### 门

`optCase` 三条（一个 `-include`、两个 `-include`、`-MM -include`）。路径给绝对的 ——
这一格算的是当前工作目录，而门是从仓库根上跑的。

**`-E` 加 `-include` 不逐字节比**：差的正好是 `<command line>` 那份文本的**行数** ——
tcc 的里头有 133 行预定义，我们的只有那几行 `#include`，于是 `# 134 "<command line>"`
对上 `# 2 "<command line>"`。要对上就得把预定义也变成一份源码，那是另一回事
（`-dM` 已经证明表的次序与源码的次序一致，值也一样）。带 `-P` 的那三条一个字节不差。

<!-- 第九刀第八十六片-END -->

## 落地：第九刀第八十七片

`-v` / `-vv` / `-vvv` —— 头文件的开合，印在正文里。

这一档开关的形状本身就要量：它不是三个开关，而是**数出来的一个计数**
（`libtcc.c:2044`）——

```c
case TCC_OPTION_v: do ++s->verbose; while (*optarg++ == 'v'); continue;
```

`-v` = 1、`-vv` = 2、`-vvv` = 3、`-vvvv` = 4（再往上没人管）。三档各有各的出处，
这是最容易想错的地方：

- **1** 不在预处理器里，在驱动里（`tcc.c:380`）：`if (1 == s->verbose) printf("-> %s\n",
  f->name)` —— 对**命令行上每个输入文件**印一行，在 `tcc_add_file` 之前，没有缩进。
- **2 / 3** 在 `_tcc_open` 里（`libtcc.c:784`）：

  ```c
  if ((s1->verbose == 2 && fd >= 0) || s1->verbose == 3)
      printf("%s %*s%s\n", fd < 0 ? "nf" : "->",
             (int)(s1->include_stack_ptr - s1->include_stack), "", filename);
  ```

  `->` = 开成了、`nf` = 这一格没有（只有 3 才印）。宽度是 **include 深度**，取的是
  压栈**之前**的值，于是主文件与它直接 include 的那几份都是 0 个空格。
- **守卫挡回去的那一次**又是另一处（`tccpp.c:1398`）：`if ((s1->verbose | 1) == 3)
  printf("=> %*s%s\n", …)` —— `| 1` 是把 2 和 3 一起收进来的写法。这一行是「省了一次读」
  的凭据：`#ifndef` 守卫或 `#pragma once` 认出来之后连 `open` 都不做。

我们这边主文件那一行只能在 `preprocessToText` 里补（正文是调用方读进来的），好在
1 那一处与 2 那一处印出来的字节正好一样（深度 0 就是没有缩进），于是一条就够：

```js
if (this.verbose >= 1) this.traceLine('->', filename);
```

`traceLine` 只往 `traceOut` 里攒，`preprocessToText` 每读一个记号倒一次 —— 倒的位置
是尺子的一部分：

```js
this.next();
/* `-vv[v]` 的那几行在 tcc 那边是 `next()` 里头印的，所以排在行标**前面**。 */
if (this.verbose >= 2) out += this.takeTrace();
```

`__has_include` 那一路也照印：tcc 的 test 模式也是真开一次再关掉
（`parse_include(s1, …, 1)` 里同一个 `tcc_open`）。

### 门

`optCase` 多了一个参数 `dropBanner`：`-v` 一族下 tcc 的第一行是版本条
（`tcc version 0.9.28rc … (AArch64 Darwin)`，也在标准输出上），Omni 没有对应的东西，
掐掉再比。五条：`01-include.c` 的 `-v` / `-vv` / `-vvv`、`02-include-next.c` 的
`-vv` / `-vvv`，一个字节不差。

**`-vvv` 那两条加了 `-nostdinc`**：3 这一档连试不开的路径都印，于是会一路印到系统头
目录 —— tcc 有两个（`/usr/local/lib/tcc/include` 与 macOS SDK），我们只有一个
`src/include`。那是第八刀就记下的搜索路径分歧，不是这一片的事，掐掉系统那一段照样
把 `nf` 的**行数、缩进、次序**都比上了。

<!-- 第九刀第八十七片-END -->

## 落地：第九刀第八十八片

真的系统头 —— 系统头目录的第二段。

到上一片为止，`sysIncludeDirs` 只有一格：`src/include`。`<stdint.h>`、`<unistd.h>`、
`<math.h>` 这些从来没找过 —— 谁要用就得自己 `-I` 一份 SDK 进来（`tests/c/run.js` 的
`sys/` 组就是这么干的）。这一片把第二段接上。

**tcc 那边这一段是 configure 时定死的**，不是运行时找的（`configure:370`）：

```sh
tcc_usrinclude="`xcrun --show-sdk-path`/usr/include"
default tcc_sysincludepaths "{B}/include:$tcc_usrinclude"
```

编成 `-DCONFIG_TCC_SYSINCLUDEPATHS=…`，运行时只剩一句
`tcc_add_sysinclude_path(s, CONFIG_TCC_SYSINCLUDEPATHS)`（libtcc.c:976）把它按 `:` 拆开。
`{B}` 是 `CONFIG_TCCDIR`（`-B` 能换）。

Omni 没有 configure 那一步，于是同一件事挪到**第一次用的时候**做一次记下来
（`cli.js` 的 `sdkUsrInclude`），按代价从小到大试：`SDKROOT` -> 写死的那两条路径
（CommandLineTools 与 Xcode.app，与 tcc 找库时的退路同一份，`tccmacho.c:2287`）->
`xcrun --show-sdk-path`。一个都不成就只剩自带那一段，与这一片之前一样。

### 「先自带、后系统」这个顺序也是量出来的

做尺子的那个 tcc **没装**：它的 `{B}` 是 `/usr/local/lib/tcc`，那个目录不存在。于是
它第一格落空、一路掉到 SDK 上 —— `tcc -M` 拿 `<stddef.h>` 会给你 SDK 那份连带
二十几个 `sys/_types/*.h`，而我们给的是 `src/include/stddef.h` 一份。

这看着像分歧，其实是「装没装」。拿 `-B` 指一个 `include/` 真在的树，它立刻跟我们一样：

```
$ tcc -B <tinycc 源码树> -M s.c
s.o: \
  s.c \
  <tinycc 源码树>/include/stddef.h
```

也就是说两边的搜索顺序是同一个：`-I` -> `-isystem` -> 自带 -> SDK。

### 门

新的一组 `tests/c/sysinc/`，三份，两边都**不给 `-I`**：

- `01-stdint.c` —— `<stdint.h>`，131 行正文、22 条依赖
- `02-posix.c` —— `<sys/types.h>` + `<unistd.h>` + `<fcntl.h>`，561 行正文、104 条依赖
  （那一堆 `sys/_types/*.h` 是一层套一层的守卫，守卫认不准立刻多印几百行）
- `03-probe.c` —— `<inttypes.h>` + `<math.h>` + `<time.h>`，486 行正文
  （`__has_include`、`__builtin_*`、`_Float16` 那些编译器探针最密的地方）

每份三条：`-E -P`、`-M`、`-MM`，九条全逐字节相同。刻意只用 SDK 里独有的头 ——
我们自带的 `stdio.h`/`stdlib.h`/`string.h` 是**最小子集**（第八刀第三片），它们
**挡着** SDK 里的同名头，那是第八刀就记下的刻意分岔。

`sys/` 组仍旧把 SDK 当 `-I` 传进去，理由从「不然找不到」变成了「要它压过自带的那三份」：
`sys/05-fdopen` 用的 `fdopen`/`system`/`strpbrk` 只有 SDK 那份里有。把这三份让位给 SDK
是 native 那条腿上的另一片 —— 解释器那条腿没有真的 libc 可转手，让位之前得先补上。

<!-- 第九刀第八十八片-END -->

## 落地：第九刀第八十九片

让位 —— 自带的那五份 libc 头删了。

第八刀第三片给 `src/include/` 放了 `stdio.h` / `stdlib.h` / `string.h` / `ctype.h` /
`errno.h` 的**最小子集**：声明的正好是 `interp/libc.js` 那张表里有的，多一个都没有。
那时候的理由是「没有真的系统头可用」。上一片把 SDK 那一段接上之后，这个理由消失了 ——
留着它们只有一个效果：**挡着** SDK 里的同名头（自带那一段排在 SDK 前面）。

`tests/c/sys/05-fdopen` 就是被挡的样子：`fdopen`/`system`/`strpbrk` 只有 SDK 那份里有，
于是那一组一直得靠 `-I <SDK>` 把 SDK 顶到前面去。这一片直接删掉那五份，留下的正是
tcc 也自带的那四份 —— `stddef.h` / `stdarg.h` / `stdbool.h` / `float.h`，
**编译器必须自己给**的那四份（它们的值来自预定义宏，只有编译器知道）。

### 删之前要补的那一件事

SDK 的 `<errno.h>` 里 `errno` 不是 `(*__omni_errno_location())` 而是 `(*__error())`。
前端认的名字只有前者，于是「这个单元要一格 `errno`」这件事没被认出来 ——
版图上不留、入口不发 `__omni_errno_init`，宿主的 `__error` 只能临时去堆上要一格，
而一个不用 `malloc` 的程序**连堆都没有**：

```
omni: runtime error: __error: libc: malloc 之前堆没有初始化
```

所以那一格从一个名字变成三个（`tccgen.js`）：

```js
const ERRNO_FNS = new Set(['__omni_errno_location', '__error', '__errno_location']);
```

第三个是 glibc 的形状 —— 同一件事在 Linux 上的名字，一起认了。

### 门

不加新用例：这一片改的是「同一份 `.c` 读到的是哪份头」，而 `tests/c/` 的每一条本来就在
比「与 tcc 跑出来的一不一样」。删掉之后 `tests/c/` 206 条、`tests/c/native.js` 217 条
全绿 —— 也就是说那五份头里的每一条声明，SDK 那边都有，而且我们的前端读得下来、
解释器与两个后端都跑得对。

`sys/` 那一组顺手把 `-I <SDK>` 也去掉了：现在两条腿都自己找。

**跟着成了死码的那几个**：`__omni_errno_location`、`__omni_stdin/stdout/stderr`
（连着 `NATIVE_CNAME` 与 `streamThunk` 那一套）—— 只有被删掉的那几份头会用它们。
下一片清。

<!-- 第九刀第八十九片-END -->

## 落地：第九刀第九十片

上一片留下的死码清掉。

自带的那五份 libc 头一删，为它们搭的那几处收口就没有输入了 —— 一个名字都不会再出现。
清掉的是：

- `interp/libc.js`：`__omni_errno_location`、`__omni_stdin` / `__omni_stdout` /
  `__omni_stderr` 四个宿主入口。`errno` 那一格现在只从 `__error`（macOS）与
  `__errno_location`（glibc）进 —— 而且**不再有堆上要一格的退路**：那一格必须由前端
  在版图上留，退路只会把「前端没认出来」这个真问题藏起来（上一片正是被它藏了一次）。
- `frontend-c/tccgen.js`：`NATIVE_CNAME`（native 上把 `__omni_errno_location` 改名成
  `__error`）与 `NATIVE_STREAM_SYMS` + `streamThunk`（给 `__omni_stdout()` 配一个
  「读那个外部全局量、返回它」的函数体）。SDK 的写法本来就是真 libc 里的名字：
  `__error` 是函数、`__stdoutp` 是外部全局量，两条都直接落过去，中间不需要谁转手。
  于是 `externThunk` 里那句 `const cname = this.native ? NATIVE_CNAME.get(name) ?? name
  : name;` 也回到一个 `name`。

`native` 上 `__omni_*` 的那条 `todo` 留着，含义反而更干净了：**任何**
`__omni_` 开头的名字走到 native 都是错，一个例外都没有。

### 门

同上一片：`tests/c/` 206 条、`tests/c/native.js` 217 条全绿。删死码不该改任何行为，
这两个数一个字都没动就是证据。

<!-- 第九刀第九十片-END -->

## 落地：第九刀第九十一片

拿 tinycc 自己的源码当尺子 —— 23 万行展开后的正文，一个字节不差。

到这一片为止，`-E` 那一路的每个细节都是用**我们写的探针**称的：一个宏、一个 `#if`、
一处记号粘连，一份文件十几行。探针的好处是「差在哪儿」一眼看得见，坏处是**它们是我们
想到的那些情况**。真实的 C 不是这样：一份 `tcc.c` 展开出来两万九千行，中间是 macOS SDK
那几百份头、`__has_include`、`__builtin_*`、层层守卫、`#pragma once`、行号拼接。

所以这一片把尺子换成 tinycc 自己：

```
tcc:  tcc -B <构建目录> -I <构建目录> -E -P x.c
我们: omni cpp x.c -P -I <构建目录>
```

两边都**自己去找头文件**（`-I` 只给 `config.h` 所在的那个目录）。`-B` 是给 tcc 指它
自己那份 `include/` —— 那个 tcc 没装，不给 `-B` 的话它第一格落空（见第八十八片）。
于是两边的搜索表形状相同：自带的一份在前（我们是 `src/include/`）、SDK 的在后。

结果：**30 份 `.c` 里 29 份逐字节相同**，剩下那份 `il-gen.c` 是 tcc 自己就拒的旧文件
（不在它的构建里），没有尺子、跳过。最长的 `tcc.c` 29009 行、`libtcc.c` 28387 行、
`tccgen.c` 11752 行，加起来约 23 万行。

### 唯一要改的东西：`stddef.h`

第一次跑下来只差 17 行，全在一处 —— 我们自带的 `stddef.h` 与 tcc 那一份内容不同。
头文件的**文本本身就是输出的一部分**，所以这件事不能靠「语义相同」蒙过去：

- typedef 的**条数与次序**：tcc 那份有 `ssize_t` / `intptr_t` / `uintptr_t`，我们只有
  三条，而且次序不同（它是 `size_t`、`ssize_t`、`wchar_t`、`ptrdiff_t`、`intptr_t`、
  `uintptr_t`）。
- `offsetof`：tcc 定成 `__builtin_offsetof(type, field)`，而 `__builtin_offsetof`
  **只在编译那一路上是宏**（tccdefs.h 的 `#ifndef __TCC_PP__` 里头）—— 于是 `-E` 出来
  是 `__builtin_offsetof(...)` 原样。我们那份是就地展开成 `((size_t)&((T*)0)->f)`，
  于是每一处 `offsetof` 都差一行。我们的 `COMPILE_DEFS` 里本来就有
  `__builtin_offsetof`，改的只是头文件这一句。
- 那句 `void *alloca(size_t size);`：我们那份没有。有意思的是它在输出里长这样 ——
  `void *__builtin_alloca(size_t size);`：SDK 的 `<alloca.h>` 把 `alloca` 定成了
  `__builtin_alloca`，先包过 `<stdlib.h>` 的程序看到的就是展开后的样子。
  两边的文本一样，展开出来自然也一样。
- `max_align_t` 那一条藏在 `#if __STDC_VERSION__ >= 201112L` 里，而 tcc 的
  `__STDC_VERSION__` 是 `199901L`（量过 `-dM`）—— 抄进来也不会印出来，但要抄对，
  哪天把版本号提到 C11 两边才会同时多出这一行。

新的 `ssize_t` / `intptr_t` / `uintptr_t` 与 SDK 头里的同名 typedef 重复 —— 底层类型
相同，C11 6.7 允许，两条腿的测试全绿就是它接得住的证据。

### 门

`tests/c/selfpp.js`，29 条，跑完 6.8 秒。跳过的那条明着印出「tcc 自己就拒了」。
源码树的位置默认与 ADR 里记的一样，`TINYCC_SRC` 可以指到别处；树或构建不在就整组跳过。

`tests/c/run.js`（206）与 `tests/c/native.js`（217）在改完 `stddef.h` 之后照旧全绿。

**这不是「能编 tinycc」**：这一片称的只有预处理器。真编还差语法与代码生成那一路 ——
不过从这儿起，喂给它们的记号流已经是与 tcc 一模一样的那一份了。

<!-- 第九刀第九十一片-END -->

## 落地：第九刀第九十二片

局部符号 —— 十二个 `.o` 链成一个 tcc，那个 tcc 编 tinycc，出来的字节与尺子相同。

上一片称完预处理器就写了一句「**这不是「能编 tinycc」**」。这一片把那句话取消掉。

### 起点：编得出来，链不上

先量了一遍：tinycc 的十二份源码（arm64-osx 那一套，`Makefile:201-240` 的
`CORE_FILES` + `arm64-gen/link/asm` + `tccmacho`，`tcc.c` 与 `libtcc.c` 要
`-DONE_SOURCE=0`）用 `omni c-obj` 一个不落地都编得出来 —— `tccpp.c` 0.33 秒、378 KB、
1373 个符号。然后 `clang -o omni-tcc *.o`：

```
1402 条 duplicate symbol
```

三族：

- `$ext$printf` 这样的**外部函数转发桩**（第二十九片建的），
- `omni_str_0`、`omni_str_1` …… **串常量**，
- `___sputc`、`___sincospi`、`___OSSwapInt32` —— **系统头里的函数**。

`arm64/from_mir.js:1087` 早把这笔账记下来了：「这些符号现在是**外部**符号
（`macho.js` 里 defs 一律 `N_EXT`），于是两个模块各有一个 `omni_str_0` 就会撞。
真正的办法是局部符号 + 按节的重定位」。这一片就是去还它。

### Mach-O 的符号表是**三段**

`nlist` 里没有「这是局部还是全局」的自由排布：符号表**必须**按局部、外部定义、
未定义三段连续摆好，`LC_DYSYMTAB` 用三对 `(i*sym, n*sym)` 指出三段的起止。
所以 `link/macho.js` 里不是「给某个符号打个标记」，而是**先分段再编号**：

```js
const locals = defs.filter((d) => d.local === true);
const globals = defs.filter((d) => d.local !== true);
for (const d of [...locals, ...globals]) { … }
b.u32(0).u32(nlocal);                    // ilocalsym / nlocalsym
b.u32(nlocal).u32(nextdef);              // iextdefsym / nextdefsym
b.u32(nlocal + nextdef).u32(nundef);     // iundefsym / nundefsym
```

局部的那些**不打 `N_EXT`**（只 `N_SECT`）。重定位那一侧一个字没改：`r_extern=1` +
符号下标对局部符号同样成立，而下标是在这个循环里现编的，所以分段自动带着它走。

### 谁是局部的：三处，全是量出来的

1. **串常量与匿名静态块**（`omni_str_3`、`$cl$0`）—— 名字是**按出现顺序编**的，
   每个翻译单元里都有一个 0 号。
2. **`static`** 的函数与全局量 —— C11 6.2.2 的内部链接。记在登记上（`info.isStatic` /
   `e.isStatic`）而不是当场用：先写 `static int f(void);` 后写定义时省掉 `static`
   是合法的，内部链接跟着**第一次**那个声明。块里的 `static`（键是 `f.buf.0`）同理。
3. **`inline`** —— 这一格是量出来的，不是推出来的。tcc 判的是

   ```c
   if (sym->type.t & (VT_STATIC | VT_INLINE)) sym_bind = STB_LOCAL;
   ```

   （`tccgen.c:478` 与 `534`，两处一样）：`inline` 与 `static` 同一个待遇。

   为什么非它不可：macOS `sys/cdefs.h:375` 那串条件对我们成立（`__STDC_VERSION__`
   是 `199901L`、没有 `__GNUC__`），于是 `__header_inline` 展成的是**光秃秃的
   `inline`** —— `__sputc` 身上根本没有 `static`。我原先只跟着 `static` 走，
   于是那三个符号漏了出去，十二份一链就是十二个 `___sputc`。

MIR 这一侧加的只是两个**标注**：`MirFunc.local` 与模块上与 `globals` 同下标的
`globalLocal`。与 `kernel` 同一个性质 —— 只有写目标文件那一步看它，没有语义。

### 收口：`omni-tcc` 编 tinycc

改完之后链接一条 `duplicate symbol` 都没有，`./omni-tcc -v` 印出版本行。往下三步：

- `omni-tcc -c` 编 `tests/c/gen/` 那 83 份，与尺子 tcc 的 `.o` **逐字节相同**；
- `omni-tcc -c` 编 **tinycc 自己那十二份源码**，同样逐字节相同；
- `omni-tcc -run`、`omni-tcc x.c -o x` 都跑得起来。

可执行文件那一级**不比字节**：tcc 写出的可执行文件里带着一个临时名，尺子自己跑两遍
出来的字节都不一样（量过）。目标文件才是有定义的尺子。

版本行里那一段 git 戳（`2026-09-01 main@cf0e1fe*`）不在源码里 ——
`Makefile:267` 只给 `tcc.o` 加一个 `-DTCC_GITHASH="…"`，内容是建那份 tcc 时的 git
状态，算不出来。所以从尺子自己的版本行里读回来，当命令行上的 `-D` 递进去：与
Makefile 做的是同一件事。

### 门

`tests/c/selfobj.js`，16 条，跑完 8.4 秒：十二个 `.o`、一次链接、版本行、两组字节比。
前两步任一步失败就直接停下（`.o` 没编齐、链不上，后面几步没有意义）。
不是 arm64 macOS、或者尺子/源码树不在，整组跳过。

`tests/c/run.js`（206）、`tests/c/native.js`（217）、`native-gen.js`（81）、
`tcc-link.js`（81）以及 macho 那一排（`macho-exe/libc/tcc/dylib/dll/debug`）照旧全绿。

### 还欠着的

- **ELF 那一侧不欠**：写这一片的时候以为欠着，量过才发现 `link/elf.js` 的 `buildSyms`
  从第三十八片起就按 `d.local` 分段（局部在前、`sh_info = nlocal + 1`、`STT_FILE`
  插在 1 号那一格），两个写出器吃的是同一份 `defs` —— 这一片新打的那些标记它自动就
  用上了。量法：`c-obj a.c --format elf --os linux --arch x86_64`，85 条局部符号，
  `main` 是唯一的 `T`。
- `weak`、别名（`__attribute__((alias))`）、可见性都有了（第一百〇四到一百〇六片）：
  `STB_WEAK` / 与目标同址的第二条符号 / `st_other`，各有一个门。`-fvisibility=` 那个
  命令行开关 tcc 本身没有，所以不是账。
- `tcc-obj.js` 依旧是「6 容器相同、99 不同」：那要的是 B 路（与 tcc 同构的一遍过
  代码生成），与这一片无关。

<!-- 第九刀第九十二片-END -->

## 落地：第九刀第九十三片

把 clang 也换掉 —— 自己编、自己链的 tcc，编出来的字节还是与尺子相同。

上一片的 `omni-tcc` 是 `clang -o omni-tcc *.o` 链的。链接那一步用别人的，等于这条链上
还留着一个没被称过的环节。这一片把它换成自己的：

```
omni c-obj x.c --format elf -o x.o     # tcc 那种 ET_REL
omni macho-link *.o -o omni-tcc-own --dylib <SDK>/usr/lib/libc.tbd
```

两件事本来就都在手里，这一片只是**第一次把它们接起来**：

- `--format elf` 是第三十八片建的那个写出器。为什么链接器要吃 ELF 而不是 Mach-O：
  tcc 的 `-c` 在**所有**目标上都写 ELF（`tccelf.c` 是它唯一的目标文件写出器），
  Mach-O 只在链接那一步才出现 —— `macho_exe.js` 照的就是 `tccmacho.c`，入口是
  「一堆 ELF 的 `.o` 进来，一个 `MH_EXECUTE` 出去」。
- `libc.tbd` 只当**名单**用（`macho_load_tbd`）：从里头读出安装名
  `/usr/lib/libSystem.B.dylib` 与它导出的符号名，用来回答「这个未定义的名字是不是
  来自某个 dylib」。一个字节都不从里头拷。

第一次跑只差一个符号：`__NSGetEnviron` 没定义 —— 那正是「没给 `--dylib`」的样子
（`tcc_add_library(s1, "c")` 那一步我们是手工递的）。给上就过了。

结果：2241432 字节、14 条加载命令、6 节。它

- **跑得起来，而且不用 `codesign`**（`./omni-tcc-own -v` 印出与尺子一样的版本行）；
- `-c` 编 `tests/c/gen/` 那 83 份、编 tinycc 自己那 12 份，出来的目标文件与尺子 tcc
  **逐字节相同**；
- `-run` 也走得通。

到这儿，从 C 源码到一个能干活的 tcc，整条链上除了 macOS SDK 的头与那份 `libc.tbd`，
没有别人的东西：预处理、语法、代码生成、目标文件、链接，全是自己的。

### 门

`tests/c/selfobj.js` 从 16 条长到 21 条（新增：12 份 ELF `.o`、一次自己链、版本行、
两组字节比），跑完 14 秒。尺子编出来的那些 `.o` 现在按「文件 + 参数」记着 ——
两条腿比的是同一份，不必让尺子编两遍。

`tests/c/run.js`（206）与 `tests/c/native.js`（217）不受影响（这一片没动前端）。

### 还欠着的

- 那份可执行文件与 tcc 自己链出来的**不比字节**：tcc 写出的可执行文件里带临时名，
  它自己跑两遍都不一样（第九十二片量过）。要比得先有一个「可重现」的口径。
- `--dylib` 还得手工递。tcc 是 `tcc_add_library` 按 `-l` 去找 `libc.tbd` 的，
  那一段（库搜索路径）还没搬。
- x86_64 那一侧没试：`macho_exe.js` 两种架构都写得出，但十二份源码要换成 `x86_64-gen.c`
  那一套，而且得在 Rosetta 上跑。

<!-- 第九刀第九十三片-END -->

## 落地：第九刀第九十四片

换一副架构 —— x86_64 的 tcc，在 Rosetta 上跑，83 份里 81 份逐字节相同。

前两片走通的是 arm64。这一片把同一份源码编成 **x86_64**（`x86_64-osx_FILES`：
`CORE_FILES` + `x86_64-gen.c x86_64-link.c i386-asm.c` + `tccmacho.c`，
`-DTCC_TARGET_X86_64 -DTCC_TARGET_MACHO`），尺子换成交叉编出来的 `x86_64-osx-tcc`。

### 挡在门口的一条指令：`u64 -> 浮点`

十二份源码里有八份直接撞在同一句上：

```
x64 后端还不认识 u64 -> 浮点（x86 没有这条指令，要拆两半）
```

`cvtsi2sd` 认的是**有符号**的 64 位，v >= 2^63 会被算成负数。分两路：

- v >= 0：直接转，硬件自己按最近偶数舍入；
- v < 0：`(v >> 1) | (v & 1)` 之后转，再自己加自己。

第二路的关键是那个 `or`：右移丢掉的最低位用它接回来当**粘位**。值 >= 2^63 时有效位
至少 64 位，最低位只影响「往哪边舍」，粘位留住它 —— 于是这一路也是正确舍入的，
float 与 double 同一套（gcc/clang 发的就是这个序列）。

尺子那边的答案不一样，但不冲突：tcc 在 x86_64 上把这件事交给运行时的
`__floatundidf`/`__floatundisf`（`tccgen.c:3184` 的 `gen_cvt_itof1`；`x86_64-gen.c`
里那句「unsigned case is handled generically」说的就是它）。我们这条腿不带 libtcc1，
就地发指令。正确性的尺子是 clang：12 个值（2^63 前后、末位带信息的、2^24 与 2^53
两个有效位边界、全一）打印到 17 位有效数字，一个字符不差。

### x86_64 的 tcc

改完这一条，十二份全编得出来，`clang -arch x86_64` 链得上，`arch -x86_64` 跑起来印

```
tcc version 0.9.28rc 2026-09-02 main@4fb21a4 (x86_64 Darwin)
```

它 `-c` 编 `tests/c/gen/` 那 83 份：**81 份与交叉尺子逐字节相同**。

量的时候先撞了一次：两边都报「`stdio.h` not found」。这不是我们的毛病 ——
**交叉编出来的 tcc 没有系统头那一格**（`configure` 只给本机那一份烤了 SDK 的路径），
尺子自己也一样。所以两边都手工给 `-I <SDK>/usr/include`。

### 差的那两份：`long double`

`15-float.c` 与 `21-ldouble.c`。量到根上：

```
clang -arch x86_64:  sizeof(long double) = 16, _Alignof = 16
我们 --arch x86_64:  sizeof(long double) = 8,  _Alignof = 8
```

x86_64 上 `long double` 是 x87 的 **80 位**（占 16 字节），我们还当成 double。
于是我们编出来的 tcc 存不住 `1.5L`：尺子写出 `00…00 c0 ff 3f` 那十个字节，
我们写成了零。修它要在 x64 后端上开 x87 那一路（10 字节的读写、`fld`/`fstp`），
是另一片的事。这一片明着把这两份列进「已知不同」—— 多一份少一份都算门失败。

### 顺手量到的下一片

给 `84-u64-float.c` 加反方向那一句（`(unsigned long long)(double)(1ULL << 63)`）
之后，**arm64** 那条腿也开始不同了。追下去不是浮点转整数发错了指令，而是 MIR 里
**只有「浮点 -> 有符号整数」一种** `CVT_F2I`：2^63 以上的 double 转 `unsigned long long`
走的是 `fcvtzs`/`cvttsd2si`，饱和成 `0x7fff…`。tcc 自己的常量折叠里就有这一句
（`(unsigned long long)vtop->c.d`），所以它编出来的目标文件当场就差。
那是第九十五片的题目，这一片的用例先不带它。

### 门

`tests/c/selfobj.js` 21 -> 24 条（新增：12 份 x86_64 `.o`、一次 `clang -arch x86_64`、
版本行、一组字节比），跑完 21 秒。

`tests/c/gen/84-u64-float.c` 新增（`run.js` 从 206 到 207）；`native.js` 加了三条
u64 -> 浮点的（两条腿各一份，217 -> 223）。`native-gen.js`（81）不变。

<!-- 第九刀第九十四片-END -->

## 落地：第九刀第九十五片

浮点 -> 无符号整数 —— 一条新的 CVT 模式，两副架构两种办法。

上一片末尾记下的那个：给 `84-u64-float.c` 加一句
`(unsigned long long)(double)(1ULL << 63)`，**arm64** 那条腿也开始与尺子不同了。
追到根上不是发错了指令，而是 MIR 里少一条：

```
export const CVT_F2I = 1;   // trunc
```

只有「浮点 -> **有符号**整数」一种，而 `castFloat` 里那句注释还写着「无符号目标也走
同一条：`F2I` 出来的是两补的位」—— 这句话是**错的**。硬件那两条转有符号的指令
（`fcvtzs` / `cvttsd2si`）在值越出有符号范围时不是回绕、是**饱和**：

```
             clang / tcc                 我们（改之前）
(unsigned)3000000000.0        3000000000              2147483647
(unsigned long long)2^63      9223372036854775808     9223372036854775807
```

四个探针，四个都错。tcc 自己的常量折叠里就有 `(unsigned long long)vtop->c.d`
这一句，所以我们编出来的 tcc 一碰到这种转换当场就与尺子分道。

### 前端：两种宽度两种办法

- 64 位无符号 -> 一条新模式 `CVT_F2U`；
- 32 位及以下 -> 先转成 **i64**（`unsigned int` 的每个值都装得进有符号 64 位），
  再 `CVT_TRUNC` 到 32 位、按 C 的宽度收口。直接按 32 位转会饱和成 `0x7fffffff`。

### 两副架构：一条指令 vs 一段序列

arm64 有现成的：`fcvtzu`，与 `fcvtzs` 只差一个位域。

x86 又没有。分两路：

```
    d < 2^63 ：直接 cvttsd2si，值落在有符号范围里，位就是对的
    d >= 2^63：先减掉 2^63 再转（差一定 < 2^63），再把第 63 位置回去
```

减法是**精确**的（两个数的指数差不超过有效位数），所以这一路不引入第二次舍入。
这与上一片的 `u64 -> 浮点` 正好是一对：两处都是「x86 只有有符号那条指令」的后果。

`interp.js` 与 LLVM 后端也各补一格（`fptoui`）。

### 越界是 UB，不能拿来当尺子

写用例时撞了一次：`(unsigned short)3000000000.0` 我们给 24064（回绕），tcc 给 65535
（`fcvtzu` 饱和成 `0xffffffff` 再按位与）。这不是谁对谁错 —— C11 6.3.1.4 第 1 段说
整数部分表示不了时是**未定义行为**。用例里改成 `(unsigned short)40000.5`：
装得下，两边才有可比的东西。

### 门

`tests/c/gen/85-float-to-unsigned.c` 新增（`run.js` 207 -> 208、`native-gen.js`
82 -> 83），`native.js` 加两条（225 -> 227）。`selfobj.js` 24 条不变 ——
新用例那份两条腿都与尺子逐字节相同。

<!-- 第九刀第九十五片-END -->

## 落地：第九刀第九十六片

十二副交叉编译器 —— 十一副的字节对得上，第十二副把我们的一个 bug 顶了出来。

前几片走的是两副本机架构。tinycc 支持的目标不止这两副：i386 / x86_64 / arm / arm64 /
riscv64 / c67，每副再乘上 ELF、PE、Mach-O 三种目标文件格式。这一片把它们**一副副
都编出来**（`Makefile:203-219` 的 `<target>_FILES` 与 `100-120` 的 `DEF-<target>`）。

每一副三步：`omni c-obj` 编那副的十一二份源码 -> `clang` 链成一个本机 arm64 的可执行
文件（交叉编译器自己是本机程序）-> 它 `-c` 编四个探针（算术、浮点、结构体传值、
控制流与串常量；不带 `#include`，因为交叉编译器没有目标那一侧的系统头）。

### 顺手掉出来的一条：`tcctools.c` 不单独编

第一次链接撞 `duplicate symbol '_tcc_tool_ar'`。`Makefile:201` 的 `CORE_FILES` 里
明明有 `tcctools.c` —— 但 `tcc.c` 里有一句 `#include "tcctools.c"`，而
`LIBTCC_SRC` 把它与 `tcc.c` 一起滤掉了。它是 `tcc.o` 的一部分，不是一个翻译单元。

### 两把尺子，而不是一把

`.omni-cache/tcc-cross/` 里那些是**另一次**建出来的：版本行里的 git 戳是
`main@4fb21a4`（2026-09-02），而源码树在 `mob@2ba12e83`（2026-08-09）。c67 那副就在
这上头差了 —— 我一开始以为是自己的账，量了一次「全用 clang 编同一份源码」才发现
**clang 编出来的也与那份不同**。

所以这一组的口径改成两层：先与预先建好的那份比；不同了再拿 **clang 编同一份源码、
同一套 `-D`** 当第二把尺子。我们与它相同，说明差的是「尺子那份的版本」；连它也不同，
才是我们的账。

结果：**十一副与预先建好的那份逐字节相同**（i386 / i386-win32 / x86_64 /
x86_64-win32 / x86_64-osx / arm / arm-wince / arm64 / arm64-osx / arm64-win32 /
riscv64）。第十二副 c67 连 clang 那把尺子也对不上 —— 那是我们的 bug。

### c67：一个真的 miscompile，最小复现只有一行

二分（从「全 clang」出发，一次只换一个我们编的 `.o`）指到 **`c67-gen.c`** 一份。
再把探针缩到最小：

```c
long long f(long long a) { return a << 3; }   // c67 目标
```

32 位目标上的 64 位移位走的是运行时的 `__ashldi3`，而那次调用的参数落位上差**一位**：
一条指令我们发 `0x00000028`、clang 编出来的那份发 `0x00000228` —— 差的是 c67 寻址
模式那四位（bit 9-12），mode 0 对 mode 1（负偏移常量 对 正偏移常量）。

排除过的：不是不确定性（两边各跑两遍都稳定），不是读未初始化的栈（往环境里塞几十字节
把栈推开，两边的输出都不变）。

这一片先把它**记在账上**：`selfcross.js` 里那副带一个 `known` 字段，报出来但不算失败；
反过来它要是哪天相同了，门会失败并提醒把这一格去掉。找到那个构造是下一片的事。

### 门

`tests/c/selfcross.js`，十二副约 45 秒（可以按名字过滤，`node tests/c/selfcross.js
riscv c67` 只跑对得上的那些）。源码树或 `.omni-cache/tcc-cross/` 不在就整组跳过。

<!-- 第九刀第九十六片-END -->

## 落地：第九刀第九十七片

上一片记在账上那一位，这一片查完了：**不是我们的账**，是 tinycc 的 c67 后端自己读越界。

### 怎么查的

不用二分，也不用读汇编 —— c67 后端自带一台记录仪。`c67-gen.c:23` 有一句被注释掉的
`/* #define ASSEMBLY_LISTING_C67 */`，打开之后每调一次 `C67_asm` 就往当前目录的
`TCC67_out.txt` 里写一行：地址、发出去的指令字、以及那次调用的**助记符与三个实参**。
两副 tcc（我们编的、clang 编的同源那副）各在自己的目录里跑一遍探针，`diff` 一下：

```
< 005C  00000028 MVKL. 0 105 0
> 005C  00000128 MVKL. 2 105 0
```

差的不是寻址模式那四位（第九十六片写错了，已改），是这条 `MVKL` 的**立即数** ——
编码里它是 `(a & 0xffff) << 7`，`a` 一个 0 一个 2，于是差出 0x100。

### 那个 0 与 2 从哪来

`c67-gen.c:1592-1605`，`load()` 里那段「tcc 以为这是栈上的参数」：

```c
if (v == VT_LOCAL && fc > 0) {
    int stack_pos = 8;
    for (t = 0; t < NoCallArgsPassedOnStack; t++) {
        if (fc == stack_pos) break;
        stack_pos += TranslateStackToReg[t];       // 一次加**整个**参数的大小
    }
    fc = ParamLocOnStack[t] - 8;                   // 循环走满时 t == 10
}
```

`stack_pos` 一次加整个参数的大小，所以一个**跨两个字**的参数只有第一个字的偏移对得上。
`long long f(long long a)` 的高半字 `fc = 12` 永远撞不上（8 之后直接跳到 16），循环走满，
`t` 停在 `NoCallArgsPassedOnStack` = 10，而 `ParamLocOnStack` 是 `int[10]` ——
`ParamLocOnStack[10]` 读的是数组外面那四个字节。

往那一句上面插一行 `fprintf` 量过，两边一模一样地走到同一个越界读：

```
== 我们编的那副 ==            == clang 编的那副 ==
PROBE load: fc=8  t=0  PLOS=0   PROBE load: fc=8  t=0  PLOS=0
PROBE load: fc=12 t=10 PLOS=0   PROBE load: fc=12 t=10 PLOS=8
```

`fc` 与 `t` 都一样，差的只是那一格里躺着什么 —— 我们编的那副是 0、clang 编的那副是 8。
`(fc / 4) + 8 / 4` 于是一个算出 0、一个算出 2，正好是清单里那两个立即数。
换句话说：这个输出取决于**全局量挨着谁摆**，不取决于谁编的代码更对。

### 于是探针换了两份

结构体传值走的是同一条路（`struct P` 12 字节，`p.y` 在 `fc = 12` 上），所以差的是
那两份探针，另两份（浮点、控制流）本来就一字节不差。逐份量过：

- `long long f(long long a){return a<<3;}` —— 不同
- `struct P{int x,y;char c;}` 传值 —— 不同
- `long long wide(int k,unsigned b){long long a=k; …}` —— 相同（64 位移位照样走 `__ashldi3`）
- `struct S{int x;}` 传值 + 返回 —— 相同（一个字的参数偏移对得上）
- 浮点、控制流 —— 相同

所以 c67 这一副换成后面那套：64 位的移位与异或从**局部量**上走、结构体只留一个 `int`。
别的十一副照旧用原来那四份 —— `long long` 与多字结构体的传值在它们身上照样称着。
`TARGETS` 里那个 `known` 那格拆了，`selfcross.js` 十二副全绿。

值得记一笔的是这类账该怎么记：**被编的程序自己是未定义行为**时，字节比不出对错
（第九十五片那个 `(unsigned short)3e9` 也是同一类 —— 越界的浮点转整数，tcc 饱和、
我们回绕，两边都对）。碰上这种输入，改探针；不是把差别记成「已知不同」。

### 门

`tests/c/selfcross.js`，十二副全绿（c67 那副四个探针里换了两份，见 `PROBE_SRC` 里
那段注释）。

<!-- 第九刀第九十七片-END -->

## 落地：第九刀第九十八片

第九十三片那份「自己编、自己链的 tcc」链的时候还得手工递一句
`--dylib <SDK>/usr/lib/libc.tbd`。这一片把找库那一段搬进链接器，`-lc` 就够了。

### 名字往文件怎么拼

照 `tcc_add_library`（`libtcc.c:1301-1332`）。MACHO 上三种拼法：

```c
"%s/lib%s.dylib", "%s/lib%s.tbd", "%s/lib%s.a"
```

一处容易写反的地方：**外层循环是拼法，内层才是路径** —— 先拿所有路径试一遍
`.dylib`，都没有再全试 `.tbd`。所以同一个目录里 `libfoo.a` 与另一个目录里
`libfoo.dylib` 并存时，赢的是 `.dylib`。名字前面加冒号（`-l:libc.tbd`）是
「就照这个名字找，不加前缀后缀」；三种拼法都没中，最后再拿名字本身当文件试一次。

### 去哪儿找

- `-L` 给的那些（可以写 `-L 目录` 也可以写 `-L目录`），命令行上的在最前
- `/usr/lib` —— tcc 的 `CONFIG_TCC_LIBPATHS` 在非 PE 上是 `{B}:<sysroot>/usr/lib`
- SDK 里那份 `usr/lib` —— `tcc_add_macos_sdkpath`（`tccmacho.c:2267`）。
  今天的 macOS 上 `libc.tbd` **只在这一处**：`/usr/lib` 里早就没有 `.tbd` 了，
  真正的 `libSystem.B.dylib` 也只在 dyld 的共享缓存里，文件系统上找不到。

SDK 的根与 `-I` 那一格共用（`SDKROOT` -> 两条写死的路径 -> `xcrun --show-sdk-path`），
这一片把它抽成了 `sdkRoot()`，`usr/include` 与 `usr/lib` 各挂一个薄壳。

### 顺手改的：一份支持库变几份

`machoExe` 原来只认一个 `libtcc1`。`-lfoo` 找到 `.a` 的时候要能一起进来，于是换成
`archives`（一串），按给的顺序一份份 alacarte：取完一份重算未定义符号再看下一份，
所以后一份能补上前一份带出来的洞。`--libtcc1` 还在，只是变成往 `archives` 里塞一份。

### 门

`tests/c/selfobj.js` 那一步的 `--dylib <TBD>` 换成了 `-lc`，24 条照旧全绿；
`macho-tcc.js`（4 条逐字节相同）与 `macho-libc.js`（180 条）跟着 `archives` 改了入参，
也全绿。四种写法各手工验过一遍：`-lc`、`-L 目录 -lfoo`（`.tbd`）、`-l:libc.tbd`、
`-L 目录 -lhelp`（`.a`），链出来的都跑得起来；找不到的名字报
`library 'nosuchlib' not found`。

<!-- 第九刀第九十八片-END -->

## 落地：第九刀第九十九片

第九十二片那句「我们编出来的 tcc 去编 tinycc，一个字节不差」量的是 arm64-osx
那**十二份**源码。这一片把范围推到十二个目标各一套。

### 同一份 `.c`，换一套宏就是另一条路

tinycc 的源码是靠 `-DTCC_TARGET_*` 切的。`tccgen.c` 在 `TCC_TARGET_C67` 下与在
`TCC_TARGET_ARM64` 下走的不是同一堆条件编译；`tccelf.c` 在 PE 那一路少半个文件。
所以「编过十二份」离「编过这棵树」还差得远。这一组按 `tests/c/tcc-targets.js`
那张表（第九十六片抄 Makefile 抄的，这一片挪出来两个门共用）一行行走：

- 六个后端：`i386-gen`、`x86_64-gen`、`arm-gen`、`arm64-gen`、`riscv64-gen`、`c67-gen`
- 六个重定位器：同名的 `*-link.c`
- 四个汇编器：`i386-asm`、`arm-asm`、`arm64-asm`、`riscv64-asm`
- 三个目标文件写出器：`tccpe.c`、`tccmacho.c`、`tcccoff.c`
- 八份 core，每份乘以十二套宏

一共 **138 个（文件，宏）组合**，两边逐字节相同。顶层那 24 份源码里没量到的只有
两份：`tcctools.c`（不是翻译单元 —— `tcc.c` 把它 `#include` 进去，`Makefile:266`）
与 `il-gen.c`（Makefile 里根本没有它，是个没人维护的老后端）。

### 这一组称的是什么

两边的**代码生成都是本机 arm64**（尺子是 `.omni-cache/tcc-build/tcc`，我们那份是同一套
源码用 `omni c-obj` 编出来的），`-DTCC_TARGET_C67` 只改被编的那份程序自己的形状。
所以这里称的不是「我们会不会生成 c67 的码」（那是第九十六片的事），而是
**我们编出来的那个 tcc 在读这些源码时与真的 tcc 走同一条路**：一百多个组合里
任何一处条件编译、任何一处 `switch` 的落点不同，写出来的字节就会分叉。

### 门

`tests/c/selfsrc.js`，十二套约 60 秒（可以按名字过滤，`node tests/c/selfsrc.js
arm riscv` 只跑对得上的）。第 1 步先用 `omni c-obj` 把我们那份 tcc 编出来
（`clang` 只管链），`-v` 与尺子的版本行相同才往下走。

<!-- 第九刀第九十九片-END -->

## 落地：第九刀第一百片

第九十六片那十二副交叉编译器是 `clang` 链的。这一片把链那一步也换成自己的。

改的就是 `selfcross.js` 里两处：`c-obj` 加 `--format elf`（tcc 的 `-c` 在所有目标上
都写 ELF，所以我们的 `.o` 也是），`clang -o tcc *.o` 换成
`omni macho-link *.o -o tcc -lc`。libc 那一句是第九十八片的 `-l`：`.tbd` 的路径
不必手工递。十二副全绿，探针照旧逐字节相同。

于是这条链上现在只剩别人的两样东西：SDK 的头，与那份 `libc.tbd`（从里头只读符号名，
用来回答「这个未定义的名字是不是来自某个 dylib」）。`selfcross.js` 里还留着一处
`clang` —— 「与预先建好的那份不同时，先拿 clang 编同源的一副当第二把尺子」那一支。
那是**尺子**，不是工具：第九十六、九十七片就是靠它把 c67 那一位的账算清的。

### 门

`tests/c/selfcross.js`，十二副全绿（分三批量过：x86 那五副、arm 那五副加 riscv64、
c67 与 arm64-win32）。

<!-- 第九刀第一百片-END -->

## 落地：第九刀第一百〇一片

前面两片各自称了半段：

- 第九十二片：我们编出来的 tcc `-c` 出来的 `.o` 与真 tcc 的逐字节相同
- 第五十七片（`macho-tcc.js`）：我们的链接器把 **tcc 编的** `.o` 链出来，与 tcc 自己链的相同

这一片把它们接起来，从源码一直走到**可执行文件**：

```
第一级   omni c-obj + omni macho-link            -> omni-tcc
第二级   omni-tcc -c tinycc/*.c + omni macho-link -> tcc2
尺  子   tcc      -c tinycc/*.c + tcc 自己链      -> tccref
```

**tcc2 与 tccref 597104 字节逐字节相同。** 编译器与链接器整条换成我们的，出来的是
同一个文件；tcc2 签完名自己也跑得起来（`-run` 一个 hello）。

### 签名那一格

账上一直挂着一句「可执行文件不比字节，因为 tcc 那边掺了个临时名字」。这一片顺手查清了：
本机 arm64 上 tcc 链完会自己喊一句 `codesign -f -s -`（`CONFIG_CODESIGN` 只在本机
那个目标上开），而 `codesign` 不给 `-i` 的时候拿**文件的基名**当签名里的 identifier。
所以

- 我们写出来的那份要先签，不签就比，差的是那两万来字节的签名段；
- 两份输出要**同名不同目录**。叫 `tcc2` 与 `tccref` 的话，第一处不同正落在签名开头
  往后十几个字节（`0x8cd17`，签名段从 `0x8cd18` 起）—— 就是那两个名字。

改成 `mine/tcc` 与 `theirs/tcc`，字节就齐了。这不是「放宽了标准」：identifier 是签名
工具按文件名填的，不是编译器或链接器产出的内容。

### 门

`tests/c/selfboot.js`，4 条，约 30 秒。第二级那一步顺带又量了一遍 `.o` 的字节相同 ——
定点比的是最终文件，`.o` 那一格在这里是「差出来时先看是编译器还是链接器」的分水岭。

<!-- 第九刀第一百〇一片-END -->

## 落地：第九刀第一百〇二片

`--arch x86_64` 以前只换后端 —— 预定义宏还是 `__aarch64__` 那一套。也就是说系统头与
被编的源码都按 arm64 那一支展开，代码却按 x86_64 生成。这种四不像编得过，
错要到几千行之后以「声明与调用约定对不上」的样子冒出来。

### 差的正好三条

尺子摆在一起一 diff（`tcc -dM -E /dev/null` 对 `x86_64-osx-tcc -dM -E /dev/null`）：

```
< #define __aarch64__ 1        > #define __x86_64__ 1
< #define __arm64__ 1          > #define __x86_64 1
< #define __AARCH64EL__ 1      > #define __amd64__ 1
```

五十条里只差这三行。别的 —— LP64（`__SIZEOF_LONG__ 8`）、macOS（`__APPLE__`、
`__leading_underscore`）、C99、那一堆装成 GCC 4 的 —— 两边同形，因为这两个目标在
这台机器上除了 CPU 就没别的分歧。

`tccdefs.js` 里于是留一格占位（`CPU_SLOT`），`predefs(arch)` 把 `CPU_DEFS[arch]`
那三条填进去；`Cpp` 从 host 上收 `arch`（cli 的 `c-obj` 按 `--arch` 递）。

### 顺手量到的一件事

这三条一变，tinycc 自己的源码本该跟着走另一支 —— `tcc.h:163-186` 在没有
`TCC_TARGET_*` 的时候就是照 `__x86_64__`/`__aarch64__` 选目标的。但
`selfobj.js` 的 x86_64 那一腿仍旧要手工递 `-DTCC_TARGET_X86_64 -DTCC_TARGET_MACHO`，
原因不在我们这边：`.omni-cache/tcc-build/config.h`（本机那次 `configure` 生成的）里
写死了

```c
#if !(TCC_TARGET_I386 || TCC_TARGET_X86_64 || …)
#define TCC_TARGET_ARM64 1
#define TCC_TARGET_MACHO 1
#endif
```

`-I` 指着那份 config.h 编，目标就已经被它钉成 arm64 了，`tcc.h` 那段默认选择根本不会
执行。tinycc 的 Makefile 交叉编时也是明着给 `-DTCC_TARGET_*` 的（`Makefile:100-120`），
所以这一格照旧。

### 门

`tests/c/arch-defs.js`，2 条。探针把六个 CPU 宏的在与不在、以及 `sizeof(void *)`
与 `sizeof(long)` 印出来；尺子是 tcc 自己 —— arm64 那条腿用本机那份，x86_64 那条腿用
`x86_64-osx-tcc`（它需要手工的 `-B <交叉目录> -I <SDK>/usr/include -L <SDK>/usr/lib`，
因为交叉那份没烤系统路径），出来的可执行文件在 Rosetta 上跑。两边 stdout 逐字节比。

<!-- 第九刀第一百〇二片-END -->

## 落地：第九刀第一百〇三片

`__DATE__` 与 `__TIME__` 从第八刀起就明着报 `is not supported yet: its value is not
reproducible`。理由不是不会做，是**不想让它们进逐字节比对的轴** —— 一个值随时钟走的宏，
昨天编出来的 `.o` 与今天编出来的不同，`cpp-bad/date` 那个用例就是把这条边界钉在门上的。

但这条边界的成本在涨。`__DATE__`/`__TIME__` 是 C90 就规定的、每个实现都必须给的预定义宏，
真实源码里到处是「版本横幅印一行编译时间」这种用法（tinycc 自己的源码不用它们 —— 量过，
`tccpp.c` 之外零处 —— 但我们的终点不止 tinycc）。把「不认」挂在那儿，等于说凡是印编译
时间的源码都编不了，而做它只要照抄两句 `snprintf`。真正需要想清楚的只有一件事：门怎么称。

### tcc 是怎么做的

`tccpp.c:3378-3393`，就在 `__LINE__`/`__FILE__` 旁边的同一个 `else if` 链上：

```c
} else if (v == TOK___DATE__ || v == TOK___TIME__) {
    time_t ti; struct tm *tm;
    time(&ti); tm = localtime(&ti);
    if (v == TOK___DATE__) {
        static char const ab_month_name[12][4] = { "Jan", … , "Dec" };
        snprintf(buf, sizeof(buf), "%s %2d %d",
            ab_month_name[tm->tm_mon], tm->tm_mday, tm->tm_year + 1900);
    } else {
        snprintf(buf, sizeof(buf), "%02d:%02d:%02d", tm->tm_hour, tm->tm_min, tm->tm_sec);
    }
```

三件值得记下来的：

1. **每次展开都现读一次时钟** —— 不是启动时算一次存起来。所以一份文件里 `__TIME__`
   出现两次，理论上可以印出两个不同的秒数（tcc 编得慢的时候真会）。C 标准说
   `__TIME__` 在一个翻译单元里应当是「翻译的时间」，tcc 这一手是它的取舍，我们照抄。
2. **日是 `%2d`，空格右对齐** —— 不是 `%02d`。9 月 3 日是 `Sep  3 2026`，中间两个空格。
   这一格最容易写成 `padStart(2, '0')`，一写就与 tcc 差一个字节，而且一个月里只有九天
   看得出来。
3. **`localtime`，不是 `gmtime`** —— 跟着本机时区走。

我们那边是 `substSpecial` 里的一格，`MONTH_ABBR` 抄的是 `ab_month_name`，
`String(d.getDate()).padStart(2, ' ')` 对着 `%2d`。

### 门怎么称

值随时钟走，就不能拿「两份输出逐字节相同」当唯一的尺。`tests/c/datetime.js` 拆成四条：

- **格式**：两处 `__DATE__` 与三处 `__TIME__`（探针里有一处是 `#define STAMP __DATE__ " "
  __TIME__` 的间接展开）都得合 `/^[A-Z][a-z]{2} [ \d]\d \d{4}$/` 与 `/^\d{2}:\d{2}:\d{2}$/`。
- **日期逐字符相同**：同一天里两台编译器印出的 `__DATE__` 必须一模一样，连那个空格都算。
- **时间差在容差内**：两次进程启动之间隔着几十毫秒，容差 5 秒。
- **抹掉时间之后整份 `-E` 输出与 tcc 逐字节相同**：把 `hh:mm:ss` 换成 `HH:MM:SS` 再比。
  这一格才是「与 tcc 同形」的真身 —— 空白、字符串的拼接形状（`"Sep  3 2026" " " "…"`
  是三个相邻的字面量，tcc 不合并）全在里面。序幕要削，与 `tests/c/run.js` 的
  `dropPrologue` 同一套：tcc 的预定义是一份叫 `<command line>` 的**源码**，进出主文件都印
  行标，我们的预定义是三张表，没有这一段。

`cpp-bad/date`（`.c` 与 `.expected`）删了 —— 该拒的事不再该拒。`tests/c/run.js`
207 条全绿。

<!-- 第九刀第一百〇三片-END -->

## 落地：第九刀第一百〇四片

`__attribute__((weak))` 一直落在 `parseAttrs` 的最后一支上：认出是个属性、把参数括号
平衡掉、什么都不改。这种「读过去」对 `format`、`__printflike`、`__dead2` 是对的
（它们只影响诊断），对 `weak` 是错的 —— 它改的是**符号表**。

### 量出来的差

一个探针（弱函数 + 弱数据 + 强的一对 + 一个 `static`），`tcc -c` 与我们的
`c-obj --format elf` 各出一份，`nm` 一比：

```
tcc :  _wfn W      _wvar V      _strong T   _svar D   _hidden d
ours:  _wfn T      _wvar D      _strong T   _svar D   _hidden d
```

那个字母就是 ELF `st_info` 的高四位：`W`/`V` = `STB_WEAK`（2），`T`/`D` = `STB_GLOBAL`。
后果不是学术的：弱定义的用处正是「可以被盖掉的默认实现」，当成强的发出去，两份 `.o`
一链就是 `duplicate symbol`。

### 一格标注，三处消费

`weak` 与 `static` 是同一种东西 —— 不改语义，只改符号怎么写：

- 前端：`parseAttrs` 认 `TOK_WEAK1`/`TOK_WEAK2`（`tcctok.h:114-115`；tcc 那边是
  `ad->a.weak = 1`，`tccgen.c:4017-4019`），`dad.weak` 一路进 `funcDecl`
  （`MirFunc.weak`）与全局量的登记（封盘那步 `mod.markGlobalWeak`）。
  属性写在原型上、写在定义上、写在类型说明符前头都算 —— 只往上加不往下抹，
  对应 tcc 的 `merge_symattr`。
- MIR：多一格与 `globals` 同下标的 `globalWeak`，与 `globalLocal` 并排。
- 写目标文件：ELF 是 `buildSyms` 里的 `STB_WEAK`（与全局的排在同一段，`sh_info`
  只切「局部/非局部」那一刀）；Mach-O 里它**不在 `n_type` 上** —— 是 `n_desc` 的
  `N_WEAK_DEF`（0x0080），所以 `macho.js` 的符号写出那一行从写死的 `u16(0)` 变成
  `u16(s.desc ?? 0)`。

### 门

`tests/c/weak-sym.js`，2 条：符号表的每一行与 `tcc -c` 相同（地址无关，只比名字与那个
字母），再用我们自己的 `macho-link` 链起来跑一遍 —— 弱定义在没人盖它的时候就是普通定义。
`selfboot` 的定点不动（597104 字节），因为没有 `weak` 的地方那一格是 `false`。

### 还欠

`__attribute__((alias("目标")))`。tcc 的做法是把别名**当成目标那条符号的一个副本**发出去
（`tccgen.c:8972-8983`：`esym = elfsym(sym_find(ad.alias_target))`，再
`put_extern_sym2` 同一个节、同一个 value、同一个 size；目标还没定义就报
`unsupported forward __alias__ attribute`）。我们现在把那条没有函数体的声明当外部函数，
给了它一个转发桩 `$ext$别名` —— 名字与绑定都不对。下一片。

<!-- 第九刀第一百〇四片-END -->

## 落地：第九刀第一百〇五片

`__attribute__((alias("目标")))` 以前被当成「外部函数的声明」：没有函数体的那条声明落进
`sealExternSymbols`，得到一个改名成 `$ext$别名` 的转发桩。三处都不对 —— 名字不对
（符号表里根本没有那个别名）、绑定不对（桩是局部符号）、还白发了一份代码。

### tcc 的做法

`tccgen.c:8972-8983`：

```c
if (ad.alias_target && l == VT_CONST) {
    esym = elfsym(sym_find(ad.alias_target));
    if (!esym)
        tcc_error("unsupported forward __alias__ attribute");
    put_extern_sym2(sym_find(v), esym->st_shndx, esym->st_value, esym->st_size, 1);
}
```

别名不是一份代码，是**目标那条符号的一个副本**：同一个节、同一个 value、同一个 size。
「目标必须已经定义」是这条实现的直接后果 —— 一遍过的编译器在目标出现之前不知道它会落在
哪儿，所以前向别名当场报错（注释里写得明白：否则要把别名攒到编译单元末尾再发）。
量过：我们与它同一句、同一行。

### 我们这一格

- 前端：`parseAttrs` 认 `TOK_ALIAS1`/`TOK_ALIAS2`，参数是字符串字面量（相邻的要拼 ——
  tcc 走 `parse_mult_str`，我们走 `readStrTok`），存进 `ad.aliasTarget`。
- 函数：在 `funcSym` **之前**拦下来 —— 不建 MirFunc、不进 `sealExternSymbols`。
  `this.funcs.set(别名, 目标的登记)`（于是同一个单元里 `别名(1)` 就是调目标）
  加 `mod.addAlias(名, 'f', 目标号, 弱不弱)`。
- 数据：登记复制目标那份，`gno` 明着写成**目标的**号（否则 `GADDR` 会照别名的名字
  再登记一个空全局 —— 第一版就撞在这儿：`GADDR 取的是 'gvar_alias' 的地址，
  可是它只是一格`），另记 `aliasOf` 让封盘那步别再切一块数据。
- 写目标文件：两个后端在排完数据之后按 `mod.aliases` 补符号（数据用那一格的 `base`），
  函数那一半在 `cli.js` 里用 `blob.offsets[目标号]`。`weak` 与 `alias` 能同时写
  （`__attribute__((weak, alias("real")))`），两格互不干扰。

### 门

`tests/c/alias-sym.js`，4 条：符号表与 `tcc -c` 逐行相同（名字 + `nm` 那个字母）、
别名与目标**同址**（地址是我们自己排的，但这个等式必须成立）、链起来跑一遍
（调别名 == 调目标、读别名的变量 == 读目标）、前向别名拒得与 tcc 一字不差。
`selfboot` 的定点不动（597104 字节）。

<!-- 第九刀第一百〇五片-END -->

## 落地：第九刀第一百〇六片

可见性是符号属性里最容易漏的一格：它不改绑定、不改地址、不改一个字节的代码，只改符号表
那 24 个字节里的**第 6 个**（`st_other`）。`nm` 不印它，所以「看着一样」正是它的陷阱 ——
第一百〇四片写完 `weak`、第一百〇五片写完 `alias` 之后，`__attribute__((visibility(…)))`
仍旧落在「不认识的属性」那一支上，而符号表看起来毫无异样。

### 量出来的

自己解 symtab 才看得见（`tcc -c` 那份对我们那份）：

```
       tcc                 ours（改之前）
_h     info=18 other=2     info=18 other=0     hidden
_i     info=18 other=1     info=18 other=0     internal
_p     info=18 other=3     info=18 other=0     protected
_d     info=18 other=0     info=18 other=0     default
_hv    info=17 other=2     info=17 other=0     hidden 的数据
```

四个名字对着 ELF 的 `STV_DEFAULT 0 / STV_INTERNAL 1 / STV_HIDDEN 2 / STV_PROTECTED 3`
（`tccgen.c:3982-3996`）。

### 严的次序不是数值序

两条声明各写一个可见性时取更严的那个，而「严」的排法是
`DEFAULT(0) < PROTECTED(3) < HIDDEN(2) < INTERNAL(1)`（`tccelf.c:722` 的注释原话）。
tcc 的 `merge_symattr`（`tccgen.c:1182-1187`）落到的规则就是「非 0 里取小的、0 谁都让」，
我们的 `mergeVis` 一模一样。写成「取大的」或者「后面那个赢」在四个值里三种情形都还对，
只有 `protected` 撞 `hidden` 那一格露馅 —— 门里专门有这一对。

### 落点

`ad.visibility` -> `MirFunc.vis` / `MirModule.globalVis` -> `elf.js` 的 `st_other`
（那一行从写死的 `u8(0)` 变成 `u8(s.other ?? 0)`）。**Mach-O 那边不写**：tcc 自己的
`tccmacho.c` 根本不消费可见性（`N_PEXT` 它没有用），我们的尺子是 tcc 不是 clang。
`-fvisibility=` 那个命令行开关 tcc 也没有 —— 量过，整个 tinycc 里 `visibility` 只在属性
那一处出现，所以「命令行的默认可见性」不是一笔欠账。

### 门

`tests/c/vis-sym.js`，2 条：每条符号的 `(名字, st_info, st_other)` 与 `tcc -c` 相同
（STT_FILE 那一条不算 —— 它印的源文件名 tcc 写命令行给的整串、我们写基名，是另一笔账），
以及认不出的可见性名拒得与 tcc 一字不差
（`visibility("default|hidden|internal|protected") expected`，同一行同一句）。

<!-- 第九刀第一百〇六片-END -->

## 落地：第九刀第一百〇七片

`-E` 的门里一直有一段道歉：削序幕。tcc 的输出开头是三行

```
# 1 "x.c"
# 1 "<command line>" 1
# 1 "x.c" 2
```

我们只有第一行，所以两边都从「主文件第 1 行」往后比 —— 也就是说**头几十个字节从来没有
称过**。这不是格式差异，是结构差异：`tccpp.c:3653-3666` 把预定义、`-D`/`-U`、`-include`
拼成一份源码，`tcc_open_bf(s1, "<command line>", …)` 压在主文件上面开出来，于是「命令行」
在 tcc 那儿是一个**真的 include 层**，读完了才回到主文件。我们的预定义是三张宏表，
`-D` 是 `define()`，这一层从来没建。

### 一行都不用改行标的逻辑

有意思的是我们的行标逻辑早就照 tcc 抄好了（`tcc_preprocess` 的 `if (file->prev)
pp_line(file->prev, level++)`，以及循环里按 `include_stack_ptr` 的差值印 1/2 那一段）——
缺的只是那一层的**存在**。所以这一片改的是一件事：`pushCmdlineIncls` 从「有 `-include`
才压一层」变成 `pushCmdlineFile`：**总是**压一层，里头是 `-include` 那几行，常常是空的。
空的层立刻 EOF、弹回主文件，于是那三行自然长出来。

### 门收紧

`tests/c/run.js` 的 `-E` 与 `-P1` 两个模式的 `strip` 撤了，`dropPrologue` 删了 ——
207 条现在从**第一个字节**起逐字节比（`-P1` 的 `#line` 那一路同理）。
`tests/c/datetime.js` 里那份同样的削法也跟着删。

### 顺手：STT_FILE 印的是命令行上那一串

同一类账还有一处，是写 vis-sym 那个门时露出来的：ELF 符号表第一条 STT_FILE，tcc 写的是
**命令行上给的那一串**，不是基名。量了三遍：

```
tcc -c s.c        -> "s.c"
tcc -c ./s.c      -> "./s.c"
tcc -c /tmp/x/s.c -> "/tmp/x/s.c"
```

`cli.js` 里那一格于是从 `basename(path)` 改成 `path`。`vis-sym.js` 不必再把 STT_FILE
那一条滤掉。`tcc-obj.js` 的账不变（0 字节相同 / 6 容器相同 / 104 不同）—— 那 104 份差在
码本身，等 B 路；`selfboot` 的定点也不动（597104 字节）。

<!-- 第九刀第一百〇七片-END -->

## 落地：第九刀第一百〇八片

上一片把 `<command line>` 那一层开出来了，这一片称那一层里**发生过什么**。

`-dM` 这个开关的名字容易骗人：它看着像「把宏表倒出来」。量一遍就知道不是：

```
$ tcc -E -P -dM -U__TINYC__ -U__APPLE__ -DFOO=2 t.c
…
#define __TINYC__ 928        <- 后来被 -U 掉了，照印
#define __APPLE__ 1          <- 同上
…
#undef __TINYC__
#undef __APPLE__
#define FOO 2
```

被 `-U` 掉的两条**照印**，而且 `#undef` 排在后面 —— 因为这几行不是宏表的快照，是
`pp_debug_defines`（`tccpp.c:3843`）在每一条指示**经过时**印的一行。同一个道理：

```
$ tcc -E -P -dM -UNEVER t.c
…
#undef NEVER                 <- NEVER 从来没定义过，那一条指示还是过去了
```

我们从前的做法正好是被骗的那一种：`for (const v of this.defines.keys()) out += definePrint(v)`
—— 倒宏表。表里没有被 `-U` 掉的，也没有 `#undef` 这件事本身，于是上面两处一处都印不出来。

### 改法：边过边攒

预定义与 `-D`/`-U` 在我们这儿都走 `cmdlineLine(src)`（装一行、读完还原），所以攒行的地方
就在那儿：读完那一行之后叫一次 `ppDebugDefines()`，把印出来的行接到 `cmdlineDump` 上。
次序于是天然是**命令行次序** —— 预定义、`__BASE_FILE__`、再一条条 `-D`/`-U`。
`preprocessToText` 那一头把倒出来的位置从「循环前」挪到**两行行标之后**（tcc 那边这些行是
循环里读那份缓冲时印的），`cli.js` 里 `cpp.dflag = …` 也得挪到 `installPredefs` **之前**
—— 否则预定义那一段还没开攒就过去了。

### 顺带量出来的：诊断前那个空行

写第三个用例时冒出来一个对不上的空行，追到 `error1`（libtcc.c:681-687）：

```c
if (s1->output_type == TCC_OUTPUT_PREPROCESS && s1->ppfp == stdout)
    printf("\n"); /* print a newline during tcc -E */
fprintf(stderr, "%s\n", cs.data);
```

`-E` 那一路每出一条诊断，**stdout 上先落一个空行**。诊断本身走 stderr，这个换行走 stdout
—— 也就是说「有没有响过一句」在逐字节比对里是**看得见的**。攒的地方是 `ppNl`，倒的地方
两处：命令行那一层里出的（接到 `cmdlineDump`，排在同一条的 `#define` 行之前），
和循环里出的（跟 `-vv` 的 trace 一样，排在行标之前）。

### 于是「该不该响」进了这根轴

这个空行把三处以前看不见的账翻出来了：

* `X redefined` **补上**（`define_push`，`tccpp.c:1262`）：`macro_is_equal` 比的不是记号号，
  是逐个记号**印出来的字符串**。量过：`#define T  2` 与 `#define T 2` 不响（宏名后头那几个
  空格不进宏体），`#define A 0x10` 与 `#define A 16` 响（`TOK_PPNUM` 存的是原文）。
* `multi-character character constant` **收回**（`tccpp.c:2197`）：tcc 那句挂在
  `tcc_warning_c(warn_all)` 上，`-Wall` 才响。我们从前无条件响 —— 于是
  `cpp/05-cond.c` 里 `#if 'ab' == 24930` 那一行会多出一个空行，`run.js` 当场抓住。
* `#pragma X ignored` 同上（`tccpp.c:1759`）。新的一格是 `warnAll`，默认 false。

### 门

`tests/c/dm-order.js`，7 条：`-U` 掉的预定义照印 + 没定义过的名字照印 `#undef`、
`-DA=1 -UA` 的次序、源文件里重定义时那个空行的落点（带 `-dD` 与不带各一条）、
重定义警告在 stderr 上一字不差（且宏体相同的那一对不响）、`-Wall` 那两句默认不响。
`run.js` 仍 207/0/1skip，`native.js` 227/0，`selfobj` 24/0，`selfboot` 定点不动（597104）。

### 还差一格

`-dD` **不带** `-P` 时还对不上：tcc 那份缓冲里的空行（预定义源码里非 `#define` 的那几行）
与 `# 132 "<command line>"` 这样的行标，要求预定义在我们这儿也是一份**逐行相同的源码文本**
才能长出来。同一格还欠 `<command line>:133: warning: __TINYC__ redefined` 里那个行号
——现在我们只能说 `<command line>:1`。这一格记在账上，不在这一片。

<!-- 第九刀第一百〇八片-END -->

## 落地：第九刀第一百〇九片

`selfobj` 上还剩一处已知不同，注释里写着一句欠账：

```js
/* 我们的 `long double` 在 x86_64 上还是 8 字节（该是 16 字节的 x87 80 位）——
 * 于是我们编出来的 tcc 存不住 `1.5L`，这两份用例里那十个字节写成了零。 */
const X64_KNOWN_DIFF = ['15-float.c', '21-ldouble.c'];
```

这条腿是几片的活：类型的宽度与对齐要按目标走、静态初始化式要写出那十六个字节、
x87 的加载/存储/传参/返回都得有。这一片先做最下面那一格 —— **位模式**，因为它是纯函数，
可以拿尺子写出来的字节直接称。

### 形状

`src/core/frontend-c/f80.js`：`f80Bytes(x, slot)` 与 `f80ToDouble(bytes)`。
80 位与 IEEE double 最大的不同是**整数位是显式的**：1.5 的尾数是 `0xC000000000000000`，
不是 `0x8000…`。四支：零（含 -0）、Inf/NaN（指数全一，整数位照置，double 的安静位挪到
次高位）、double 的非规格化数（80 位指数范围宽得多，所以它们在这儿是**规格化的**，
左移到最高位为 1、指数跟着减）、规格化数（换偏置 16383，尾数补整数位）。

### 量出来的那件事：尺子自己也只有 53 位

门里九个字面量的字节全对上之后，`0.1L` 那一条露出来了：

```
0.1L -> 00 d0 cc cc cc cc cc cc fb 3f     尾数 0xCCCCCCCCCCCCD000，低 11 位是零
```

真正的 80 位 `0.1` 尾数是 `0xCCCCCCCCCCCCCCCD`。差别的来处不在写，在**读**：那份交叉编出来的
`x86_64-osx-tcc` 跑在 arm64 上，它自己的 `long double` 就是 double，`0.1L` 这个字面量先落进
一个 53 位的 double 才写出去。

这件事决定了后面几片怎么走：**值从 double 来、按 80 位存**，与尺子逐字节相同 ——
不必先写一台「十进制 -> 64 位尾数」的转换器（`strtold` 那一格）。等哪天尺子换成在 x86_64 上
跑的 tcc，那一格才会变成真账。

### 门

`tests/c/f80.js`，5 条：与尺子的十六个字节逐个相同（9 个字面量）、尺子只有 53 位这一条
单独钉住、`double -> 80 位 -> double` 恒等（18 个值，含 ±0/非规格化/Inf/NaN/两头极值）、
零/Inf/QNaN/非规格化的位模式、1.5 的尾数与指数。这一片没动任何现有的码，
所以别的门一条都没跟着变。

### 下一片

`typeSize` 那一格要按目标走（x86_64 是 16/16，arm64-macho 与 PE 仍是 8/8）——
它是个模块级纯函数，四十来处在叫，所以这一片先不动它；紧接着是静态初始化式走
`f80Bytes`、x87 的 `fldt`/`fstpt` 与 SysV 的传参（栈上 16 字节的格子）与返回（`st0`）。

<!-- 第九刀第一百〇九片-END -->

## 落地：第九刀第一百一十片

上一片把 80 位的**位模式**称准了（纯函数，与尺子逐字节相同）。这一片让**机器**认它。

### 一个决定：不加类型，只加一格宽度

看着最像的做法是给 MIR 加一个 `T_F80`。没有那么做，理由是量出来的（第一百〇九片）：
尺子自己的 `long double` **值**也只有 53 位有效位，所以 80 位这件事全部发生在**内存里** ——
值一律是 double。于是：

* 类型系统一格没多；
* `MLOAD_KINDS` 多一项 `f80`（10 字节）、`MSTORE_KINDS` 多一项 `f80`；
* verify 那边一个字没改 —— 它本来就按名字头一个字母是不是 `f` 判「描述符与 `t` 配不配」，
  `f80` 自然要求 `t` 是浮点。

### x87 那四条

`src/core/x64/encode.js` 多了四条，是 x87 在这条腿上唯一的用处：

```
fld  tbyte [m] = DB /5      fstp tbyte [m] = DB /7
fld  qword [m] = DD /0      fstp qword [m] = DD /3
```

`/n` 是 ModRM 的 reg 三位当操作码扩展，所以直接把 n 递给 `memOperand`。
`fstp` 的 p 是 pop —— 成对使用才不会把 x87 那八格慢慢填满（填满了下一条 `fld` 直接得 NaN，
而且不报错）。

### 中间那块八字节的地方：借栈

x87 只能与**内存**来往，而我们的值躺在整数寄存器里，所以读写各要一块八字节的暂存。
没有在帧里开一格，而是借栈：

```
MLOAD  f80:  lea/add -> TMP0;  fld tbyte [TMP0];  push RES;  fstp qword [rsp];  pop RES
MSTORE f80:  RES <- 值;  push RES;  fld qword [rsp];  fstp tbyte [TMP0];  pop RES
```

`push` 推什么都行（推 `RES` 省一条指令），它只是「腾出八个字节」。帧是 rbp 基的
（`push BP; mov BP, rsp`），所以动 rsp 不影响任何一个槽或帧块的地址；一进一出配对，
中间没有 call。

### 另外两条腿一个字没改

arm64-macho 与 PE 上 `long double` 就是 double（`TCC_USING_DOUBLE_FOR_LDOUBLE`），
线性内存那条腿同理 —— 它们发不出 `f80` 这个描述符。真发出来了，两边都当场报
「不认识的访问 f80」，不会悄悄读到半格。

### 门

`tests/x64/from-mir.js`（Rosetta 上真跑真对结果）多三条：

* 2.5 存成十个字节再读回来；
* **0.1 来回一位不掉** —— 这一条是防「走错成 float 那一档」的：那样会答成 `fround(0.1)`；
* 写出来的十个字节与 `f80Bytes(1.5)`（上一片尺子称过的那份）逐个相同 ——
  十个字节各读一遍、异或、或起来，答 0 才算过。

顺手清掉同一份门里一条**过期的反面用例**：`u64 -> 浮点` 早就实现了（`u64ToFloat`），
反面用例还在说「该报错还没报」。换成两条正面的（0xFFFF…F 收到 2^64、2^63 精确）。
90 passed / 0 failed。

### 下一片

前端那一头：`typeSize` 按目标给 16/16（现在还是 8/8）、`loadKindOf`/`storeKindOf` 在
x86_64 上给 `long double` 派 `f80`、静态初始化式走 `f80Bytes`，再往后是 SysV 的传参
（栈上 16 字节的格子）与返回（`st0`）。做到那儿，`selfobj` 上最后两份已知不同才会消失。

<!-- 第九刀第一百一十片-END -->

## 落地：第九刀第一百一十一片

前两片一片称位模式、一片让机器认它。这一片把**前端**那一头接上：x86_64 上
`long double` 从此真的是 16 字节。

### 一格模块级状态，因为 tcc 那边是编译期常量

`typeSize` 是 ctype.js 里的一个纯函数，四十来处在叫它。tcc 那边宽度是编译期常量
（`x86_64-gen.c:102-103` 的 `LDOUBLE_SIZE`/`LDOUBLE_ALIGN` 都是 16），我们的目标是运行时的
一个开关，于是这儿也只能是一格模块级状态：

```js
let LDOUBLE_SIZE = 8;
export function setLdoubleTarget(arch) { LDOUBLE_SIZE = arch === 'x86_64' ? 16 : 8; }
```

`lowerCNative` 按 `host.arch` 拨、`lowerC`（线性内存那条腿）明着拨回 8 —— **每次进来都拨**，
这样同一个进程里先编 x86_64 再编 arm64 不会串。

### 三处跟着走

* `loadKindOf` / `storeKindOf`：`VT_LDOUBLE` 在 16 字节那一档派 `f80`（上一片那个描述符），
  8 字节那一档照旧 `f64`。局部量、结构成员、数组元素的读写全都走这两个函数，所以
  这一处一改，整条链就是 x87 的十个字节了。
* `floatBits(x, 16)`：静态初始化式的字节走 `f80Bytes`（第一百〇九片）。
* 布局：`struct { char c; long double d; }` 于是是 32 字节（16 对齐），`long double[3]` 是 48。

### 门

`tests/c/ldouble-x64.js`，3 条：sizeof/布局（16 / 32 / 48）、帧上那十六个字节存读算转
（`2.5*2 + 0.75 + 1.5` -> `(int) 7`）、`.data` 里四个静态量的字节与 `f80Bytes` 逐个相同。

前两条的尺子是 **`clang -arch x86_64`**，不是 tcc —— 量过才知道：交叉编出来的那份
`x86_64-osx-tcc` **链不动**自己的目标（`configure` 只给本机那份烤了 SDK 的路径），
`-o 可执行文件` 直接报 `library 'c' not found`。字节这一层的尺子仍然是 tcc
（第 3 条的期望值来自第一百〇九片称过的 `f80Bytes`，以及 `selfobj` 那一整段）。

### 还差 SysV 的那一半

`selfobj` 那两份已知不同还在，**原因换了**：不再是宽度，而是 ABI。
`long double` 在 SysV 里是 MEMORY 类 —— 传参走栈上 16 字节的格子、返回在 `st0`。
我们编出来的 tcc 里 `tokc.ld = strtold(...)`（`tccpp.c:2427`）的返回值还按 xmm0 读，
于是它认不准 `1.5L` 这种字面量。同一个洞也让 `printf("%Lf", x)` 在 x86_64 上印不对
（第一百一十一片之前也一样不对 —— 那时 `sizeof` 还是 8）。`selfobj.js` 里那条注释
按这个改了：说清楚现在差的是哪一半。

<!-- 第九刀第一百一十一片-END -->

## 落地：第九刀第一百一十二片

上一片留了一句「还差 SysV 的那一半」。这一片做掉其中的**返回**：x86_64 上
`long double` 的返回值在 **x87 的 `st0`** 里，不是 xmm0。

### 这一位记在哪儿：两处，各有各的理由

一开始想的是「调用点带一位就完了」。写完发现 `CALL` 那一路根本不需要 ——
直接调用**看得见被调的是谁**，返回值回在哪儿是那个函数自己的事：

```js
// tccgen.js，genFuncBody
if (this.ldRetAux(ret) !== 0) info.f.setLdRet();
```

```js
// x64/from_mir.js，OP.CALL
return this.callRet(i, t, this.mod.funcs[f.a[i]].ldRet === true);
```

`ldRet` 与 `local`/`kernel` 同一种性质：**标注，不是语义** —— 只有 x86_64 那条腿看它，
别的腿一个字不改。而外部符号（`CCALL`）与按指针调用（`CALLI`）看不见被调的是谁，
只有前端知道那个 C 的返回类型，所以这两条只能由**调用点**带着：aux 的 bit 16
（`CALL_LDRET = 0x10000`），与低 16 位的变参分界挤同一格。

同一件事只记一处 —— 两处记同一件事迟早会不一致。所以 `CALL` 的 aux 一位都不点。

### 取值与发值：还是借栈

与上一片的 `f80` 读写同一个手法，因为 x87 与 SSE 之间没有直接的路：

```js
buf.emit(x.push(RES));            // 腾八个字节
buf.emit(x.fstpM64(REG.rsp, 0));  // st0 -> double，顺手弹干净 x87 栈
buf.emit(x.pop(RES));             // 拿回来
```

`fstp` 而不是 `fst`：不弹的话连着几次调用就把 x87 那八格填满，第九次是 NaN。
发出去（`OP.RET`，被调那一头）是反过来的 `fld qword`。

### 桩要点两头

非变参的外部函数走桩（`$ext$strtold`），于是桩里有两次跨界：

```js
const ldr = this.ldRetAux(info.ret);
if (ldr !== 0) f.setLdRet();
const r = f.emit(OP.CCALL, rt, this.mod.cabiNo(name), f.pushArgs(refs), ldr);
```

只做一头的话值在桩里从 x87 转到 xmm0 就再也回不去了 —— 症状是「`strtold` 回来的数
像上一次调用留下的垃圾」，现场离原因很远。

### 挤一格的代价：两处读它的人要改

aux 从「一个数」变成「两件事挤在一格」，于是所有**按数读它**的地方都得过 `callVaFixed`：

* `arm64/from_mir.js` 三处（帧大小、`CCALL`、`CALLI`）—— 它只关心变参分界。
* `mir/verify.js` 的「分界不能超过实参个数」：拿整个 aux 去比的话，点了那一位就一律报错。
* `mir/bytes.js` 的摘要：`vafix:3+ldret`。没点那一位时的写法与从前**一字不差** ——
  既有的哈希不能因为多了一件事就全变。

### 门

`tests/c/ldouble-x64.js` 加 3 条，三条路各一遍：直接调用（`1.5 + 2.5` -> `(int) 4`）、
按指针调用（`CALLI` 那一位）、外部符号（`strtold("2.5") * 2` -> 5）。尺子照旧是
`clang -arch x86_64`。

### 拿下 `21-ldouble.c`

`selfobj` 的已知不同从两份减到一份。凑齐的是三件：宽度（第一百一十一片）、静态初始化式
的那十个字节（第一百〇九片）、返回值从 `st0` 里取（这一片）—— `tokc.ld = strtold(...)`
（`tccpp.c:2427`）取得对，我们编出来的 x86_64 tcc 才认得准 `1.5L`，写出来的 `.o` 与
交叉编那份逐字节相同。

剩下的 `15-float.c` 差的是**传参**：`long double` 是 MEMORY 类，实参要摆进栈上 16 字节的
格子（`printf("%Lf", x)` 那一路），下一片。

<!-- 第九刀第一百一十二片-END -->

## 落地：第九刀第一百一十三片

`long double` 的最后一半：**传参**。SysV 说它是 X87 类 —— 不看大小，一律 MEMORY。

### 一位新的类型事实

`ARGMEM` 的 aux 本来是「字节数 + SSE 位图」。这一片给它加了一位：

```js
/** 这一块是 x87 的 80 位（一律 MEMORY，16 字节的格子）。按在 SSE 位图之上那一位。 */
export const MEMARG_F80 = 4;
```

为什么不能按字节数猜：16 字节的聚合**是能进两个寄存器的**（`struct { double a, b; }`
进 xmm0/xmm1），而同样 16 字节的 `long double` 一定进栈。两者在 MIR 里都是「一块 16
字节的内容」，差别只在类型 —— 那是前端才有的知识，所以只能明说。

### 三头对着摆

* **调用点**（`ldArgMem`）：值落进帧上十六个字节（`MSTORE` 的 `f80` 描述符，第一百一十片），
  传的是那一块的地址。固定实参与变参那一路走的是同一条 —— X87 类不分固定与可变。
* **后端摆格子**（`argPlaces`）：见到那一位就把出参偏移对齐到 16、开一个 16 字节的格子，
  往里拷**十个**字节（8 + 2，余下六个字节 clang 也不写）。对齐靠出参区本身是 16
  对齐的（`outArgsBytes` 按 16 取整），所以「偏移对齐」等于「地址对齐」。
* **被调那一头**（序言）：形参表那一格上按一位 `ld`，于是它**不占寄存器**，在入参区里
  占一个 16 字节的格子。`fld tbyte [rbp+off]` 读进 x87、`fstp qword` 收成 double 落进
  槽里 —— 值在 MIR 里仍是 f64，80 位只活在内存里。

三头哪一头漏了都是**静默的错值**：调用方摆栈、被调方读 xmm0，取回来是上一次留下的东西。

### 桩也得转发

```
tccpp.c:3961: error: 外部函数 'ldexpl' 按值收 long double 还没到（X87 类，要栈上的格子）
```

先加的是这条**明着报**，然后它当场响了 —— tcc 自己的预处理器里就有一处 `ldexpl(x, e)`。
桩（`$ext$ldexpl`）于是要自己划一块：每个这样的形参 16 字节（一条 `FRAME`），收到的
f64 写成 80 位，再 `ARGMEM` 转出去。变参那一路不走桩（调用点直接 CCALL），所以
`printf("%Lf")` 与 `ldexpl` 是两条不同的路，各有一条门用例。

### x86_64 一份不差

`selfobj` 的 `X64_KNOWN_DIFF` **空了**：

```
ok   x64-tcc -c tests/c/gen/*.c == x86_64-osx-tcc -c（84 份逐字节相同，一份不差)
```

四件事凑齐才走到这儿：宽度 16 字节（第一百一十一片）、静态初始化式的那十个字节
（第一百〇九片）、返回值在 `st0`（第一百一十二片）、传参走栈上的格子（这一片）。
少任何一件，我们编出来的 tcc 就会在 `1.5L` 这种字面量上答错，而错在**它编出来的
下一份文件**里 —— 离原因很远。

### 门

`tests/c/ldouble-x64.js` 9/0。新增的三条要比退出码更细，所以加了个 `sameOut`：
**比印出来的字节**（`%Lf` 那一路只有这样才称得出来）。
`printf("%.4Lf %.4Lf %d %.4Lf")`（变参，掺着 int）、
`mix(int, long double, double, long double, int)` 加一条「形参被取了地址」（固定形参）、
`ldexpl(1.5L, 3)`（走桩）。尺子照旧是 `clang -arch x86_64`。

### 还没做

`va_arg(ap, long double)`：X87 类在 SysV 的变参里要从溢出区取 16 字节的格子，
`VAARG` 那一条还没认这一位 —— 下一片补上。

<!-- 第九刀第一百一十三片-END -->

## 落地：第九刀第一百一十四片

`va_arg(ap, long double)` —— `long double` 那一摊的最后一格。

### 这一路比别的都短

X87 类在 SysV 的变参里**从来不进寄存器**（它是 MEMORY），所以这一条不用像标量那样
判「寄存器保存区还有没有余量、不够再走溢出区」那一对分支：一律在溢出区里。要做的
只有三件 —— 游标对齐到 16、`fld tbyte` 取那十个字节、游标推 16。

```js
buf.emit(x.movRM(8, TMP1, TMP0, 8));           // TMP1 = overflow_arg_area
buf.emit(x.aluRI(ALU.add, 8, TMP1, 15), x.aluRI(ALU.and, 8, TMP1, -16));
buf.emit(x.fldM80(TMP1, 0));
buf.emit(x.aluRI(ALU.add, 8, TMP1, 16), x.movMR(8, TMP0, 8, TMP1));
```

对齐**要在运行时算**：固定形参用掉多少字节是编译期知道的，可同一条 `va_arg` 在循环里
会被走多次，游标是变的。

### 同一位，第三个读它的人

`MEMARG_F80`（第一百一十三片）这一位现在有三个消费者：`ARGMEM` 的调用点、序言里的
形参、以及这一条 `VAARG`。前两个回的是「一块内存」，这一条回的是**值**（f64）——
所以 `verify.js` 里那句「aux 非 0 就是取 struct，t 只能是 i64」要先让它过：

```js
if (memArgIsF80(v)) {
  if (t !== T_F64) bad(i, `VAARG 取 long double，回的是 f64 的值，t 不能是 ${typeText(t)}`);
  return;
}
```

### 门

`tests/c/ldouble-x64.js` 10/0。新增那一条有两个变参函数：一个循环里取三个
`long double`（称「游标推得对」—— 推错一格后面全错，而错出来的是一个像模像样的数），
一个掺着 `int`/`double`/`long double` 各取一次（称「三种格子的宽度各不相同」）。
尺子照旧 `clang -arch x86_64`。

<!-- 第九刀第一百一十四片-END -->

## 落地：第九刀第一百一十五片

x86_64 的**第二级**：我们编出来的那份 x86_64 tcc 去编 **tinycc 自己**的十二份源码，
与交叉编那份写出来的字节逐个相同。

```
ok   x64-tcc -c tinycc/*.c == x86_64-osx-tcc -c（12 份，逐字节相同）
```

### 为什么这一格与前面那 84 份不一样

差别在**规模**，而规模会翻出不同的东西。那 84 份是几十行的用例，一份盯一件事；
这十二份是几千行的真代码（`tccgen.c` 九千行）—— 里头有 tcc 用到的全部语言特性、
全部的 `#include`、它自己那些位域与联合、以及**上千个函数**的寄存器分配与跳转。
84 份全相同不保证这十二份也相同：前者的错会藏在没人走的组合里。

arm64 那条腿上这一格是第 5 步（「收口：我们编出来的 tcc 去编 tinycc 自己」，
第九十四片就有了）。x86_64 这边一直缺着 —— 缺的原因是 `long double`
（第一百〇九 ~ 一百一十四片），补齐之后这一格**一次就过**。

### 参数明着给

```js
const tinyArgs = ['-B', TCC_DIR, '-I', SDK_INC, '-I', TCC_DIR, '-DONE_SOURCE=0',
  '-DTCC_TARGET_X86_64', '-DTCC_TARGET_MACHO'];
```

目标宏不靠「编译器自己是什么架构」那一层默认（`tcc.h` 会按 `__x86_64__` 猜），
而是两边都明着给同一串 —— 这样比的是同一份源码，而不是「两边各自猜对了」。
`-I <SDK>/usr/include` 是交叉编那份自己也要的（它没有烤进 SDK 路径）。

`tcc.c` 那一份要 `-DTCC_GITHASH`：版本行里那个戳来自尺子自己的 `-v`
（交叉编那份与本机那份的戳不同），否则字符串池里差一串字节。

### 门

`tests/c/selfobj.js` 25/0（多了这一条）。整组现在跑 45 秒 —— 一半在 Rosetta 上，
因为这一格与上一格都要真的把 x86_64 那份 tcc 跑起来。

<!-- 第九刀第一百一十五片-END -->

## 落地：第九刀第一百一十六片

PE 目标上只读数据那一节叫 **`.rdata`**，不叫 `.data.ro`。

tcc 里这是文件开头的一个 `#ifdef`（`tccelf.c:50-56`）：

```c
#ifdef TCC_TARGET_PE
static const char rdata[] = ".rdata";
#else
static const char rdata[] = ".data.ro";
#endif
```

我们的 ELF 写出器六个目标共用一份，差别本来只记着两处（`e_machine`、符号名前那条
下划线）。这是第三处 —— 而且我们的**链接器**早就有这一格（`elf_merge.js` 的
`opts.rdata`，`peSections` 传的正是 `.rdata`），写 `.o` 这一头一直欠着，于是我们出的
win32 `.o` 里那一节叫 `.data.ro`，并合的时候成了另一节。

`writeObject` 于是多一个 `opts.rdata`，`cli.js` 按 `--os` 给：`win32` 是 `.rdata`，
别的是 `.data.ro`。

### 门

`tests/c/rdata-name.js` 3/0。期望值**不写死**：拿交叉编译器写出来的 `.o` 问它 3 号节
叫什么，再问我们的。三个目标各一遍（x86_64-win32 / x86_64-linux / arm64-osx）。

### win32 的容器还差什么（量过的）

`tcc-obj.js` 的 win32 那一栏仍然是「0 容器相同」，剩下的差别有三处，都不是这一片能补的：

* **`.pdata` 与 `.rela.pdata`**：x86_64-win32 上 tcc 每编完一个函数就往 `.pdata` 里加
  一条 12 字节的 `RUNTIME_FUNCTION`（`tccpe.c:1981` 的 `pe_add_unwind_data`，由
  `x86_64-gen.c:1016` 的 `gfunc_epilog` 叫），三个 dword 各带一条重定位；那 8 字节的
  `UNWIND_INFO` 是**共享的一份**，躺在 `.text` 里（对齐到 4）。我们的写出器还没有这一节
  —— 有意思的是链接器那一头早就会读会摆（第四十五片的 `buildUnwind`/`unwindInfoX64`），
  所以这一片是把同一件事补到写 `.o` 那一头。
* **`.uw_base` 那条符号**：`.pdata` 的重定位指着它（一条 `shndx = .text` 的局部符号）。
* **`.symtab` 的 `sh_info`**：我们多几条局部符号（外部函数的桩 `$ext$printf`），
  于是「第一个全局符号的下标」与 tcc 不同 —— 这一条要等桩那个手法本身换掉。

<!-- 第九刀第一百一十六片-END -->

## 落地：第九刀第一百一十七片

win32 的 x86_64 上每个函数都要在 **`.pdata`** 里占一条 12 字节的
`RUNTIME_FUNCTION{BeginAddress, EndAddress, UnwindData}` —— win64 的异常展开是查表的，
没有这一节，栈就展不开。上一片量出来的三笔债，这一片还前两笔。

### 三个字段都是相对的，所以都要修

三个字段都是**相对代码节起点**的偏移，可 `.o` 里代码节还没有地址。tcc 于是造一条
局部符号 `.uw_base`（`shndx = .text`、值 0、类型 NOTYPE），三个字段各挂一条指着它的
`R_X86_64_RELATIVE`（`tccpe.c:1997-2005`）—— 链接时整节一挪，三个数跟着挪。
名字上**不加**那条下划线前缀：它不是 C 里的名字，是 tcc 自己造的一条。

那一份 `UNWIND_INFO` 是**共用的**（八个字节，`01 04 02 05 04 03 01 50` ——
「序言 4 字节、两条展开码、帧寄存器是 rbp」），因为 tcc 编出来的函数长相都一样。
它住在 `.text` 里，摆在**第一个函数收完之后**、对齐到 4 —— tcc 是在第一个函数的
`gfunc_epilog` 里把它塞进代码节的，所以位置由代码的排布决定，这一格只能由后端摆
（`genModule(mod, {unwind: true})` 回 `{offs, funcs}`），写出器照它排 `.pdata`。
八个字节本身借链接器那一头早就有的 `unwindInfoX64()`——同一件事只记一处。

### 节的次序就是造出来的次序

7 号往后那几节 tcc 并不排序，**谁先造谁在前**。`.rela.text` 在第一条代码重定位发出来的
时候造，`.pdata` 在第一个函数收尾那一步造 —— 于是「第一个函数里有没有重定位」决定了
两节谁在前。量过：

* `int f(int a){return a+1;} int main(void){return f(1);}` → `.pdata .rela.pdata .rela.text`
* 把 `f` 改成 `return g(a)+1`（`g` 是外部的）→ `.rela.text .pdata .rela.pdata`

写出器于是照这条规矩插，而不是把次序写死。

### 门 `tests/c/pdata-x64.js` 11/0

两个探子（第一个函数里有 / 没有代码重定位）各五条，加一条反面的
「x86_64-linux 上一节也不多」。期望一律从交叉 tcc 写出来的 `.o` 里读。
两处只能比**形状**不能比数：我们那边外部函数还带一个 `$ext$` 的桩，那也是个真函数，
于是 `.pdata` 比尺子多一条、`.uw_base` 的下标也偏一位 —— 所以门比的是
「每个函数三条重定位」与「`.uw_base` 是局部段的最后一条」这两个不变量。

### 量出来的进展与还欠的

`tcc-obj.js x86_64-win32`：**0 字节相同, 0 容器相同, 5 不同** → **0 字节相同,
3 容器相同, 2 不同**。剩下那两份差的都不是 `.pdata`，是别的两条次序：

* `03-inttypes.c`：tcc 有 `.rela.text`，我们没有 —— 我们模块内的直接调用走标签，
  不发重定位；tcc 一律发。这是另一条轴（Path B）。
* `05-global.c`：tcc 的 `.rela.data` 在**最前**（初值里的地址在解析阶段就修了，
  比任何函数都早），我们一律把它摆在最后。同一条「造出来的次序」的规矩，下一片补。

<!-- 第九刀第一百一十七片-END -->

## 落地：第九刀第一百一十八片

上一片顺手量到的那条规矩 —— **7 号往后那几节的次序就是造出来的次序** —— 这一片按它把
`.rela.data` 摆对。三件事各有各的时刻：

* `.rela.data` —— 第一条**数据**重定位落的时候（解析初值里那个地址那一刻）
* `.rela.text` —— 第一条**代码**重定位发出来的时候（某个函数体里）
* `.pdata` —— **第一个函数收尾**那一步（win32 的 x86_64）

### 时刻要在发生的那一刻记

我们的全局量是**一遍过走完之后**才切出来的（前端把它们摆在一块暂存的线性地址上，
`lowerCNative` 末尾那个后处理再一块块交给 MIR），到那时函数早就全出来了 ——
所以在 `setGlobalData` 里问「现在有几个函数」永远得到总数。时刻只能在**落那条地址**
的那一刻记：`putSymBytes` 往 `pendingFix` 里多记一格 `after`（那一刻 `mod.funcs` 有多长），
`setGlobalData` 取一块字节里最小的那一个存进 `mod.globalAfter[i]`。

一格新的模块级标注，与 `globalLocal`/`globalWeak`/`globalVis` 同一种性质：只有写目标
文件那一步看它。**没有**进 `bytes.js` 的哈希 —— 它不改变任何一条指令，改了哈希就等于
把「同一份输入两次编译逐字节相同」那条不变量搅动一次。

### 三个时刻换算到同一把尺子上

`cli.js` 的 `relaSeq` 把三件事都换算到「第几个函数」这把尺子上，写出器只管排：

* `.rela.data` → `k`（第一条数据重定位落在第 k 个函数**之前**）
* `.rela.text` → `j + 0.5`（第一条代码重定位在第 j 个函数的**体里**）
* `.pdata` → `0.8`（第 0 个函数**收尾**时 —— 比它的体晚、比第 1 个函数早）

于是上一片那个「第一个函数里有没有重定位」的特例不用单独写了，它就是
`0.5 < 0.8 < 1.5` 这条不等式的两头。

### 门 `tests/c/rela-order.js` 6/0

两个探子把同一句 `char *p = "hi";` 挪到第一个函数前后，加 `gen/05-global.c`
这份真源码，两个目标（x86_64-win32 与 arm64-osx）各三条 —— 节的名单与尺子逐字相同：

```
ok   x86_64-win32 pre：.rela.data .pdata .rela.pdata .rela.text
ok   x86_64-win32 post：.pdata .rela.pdata .rela.data .rela.text
ok   arm64-osx    pre：.rela.data .rela.text
```

**这一门不比的那一格**（量过了）：「第一个函数里就有调用」那种源码，tcc 的
`.rela.text` 排最前，我们那儿根本没有那一条 —— 模块内的直接调用我们走标签、不发重定位，
tcc 一律发。那是 Path B 那条轴上的债。

### 量出来的下一笔

`tcc-obj.js` 三个目标各量了一遍：win32 与 arm64-osx 的 `05-global.c` 节名单从此相同
（`3 容器相同` 那三份没变，差别退到节头里的大小与偏移 —— 那是代码本身还不一样）。
**x86_64-linux 是另一笔**：tcc 在那个目标上还多写 **`.eh_frame` 与 `.rela.eh_frame`**
（ELF 上默认带展开表 —— 与 win32 的 `.pdata` 同一件事的另一种写法），
五份用例的节名单全差在这两节上。下一片就这个。

<!-- 第九刀第一百一十八片-END -->

## 落地：第九刀第一百一十九片

上一片量到的那笔债：linux 目标的 `.o` 里 tcc 还多写 **`.eh_frame`** 与
**`.rela.eh_frame`**。这与 win32 的 `.pdata` 是同一件事的两种写法 —— 那边是查表
（`RUNTIME_FUNCTION`），这边是 DWARF 的 CFI。

### 它跟着**输出格式**走，不跟着 CPU 走

`unwind_tables` 默认是开的（`libtcc.c:887`），可 `tccelf.c:92-94` 又把它按输出格式关掉：

```c
if (s->output_format != TCC_OUTPUT_FORMAT_ELF)
    s->unwind_tables = 0;
```

于是 osx（Mach-O）与 win32（PE）一节也没有，只有 linux 有。这是第三条「目标的事实」
（前两条是符号名那条下划线、只读数据那一节的名字），门里两条反面的用例就钉这一格。

### 三个数跟函数走，别的都是写死的

`.eh_frame` 的形状是「CIE 24 字节 + 每个函数一条 36 字节的 FDE + 收尾四个零字节」——
每一格都定长，所以 FDE 的长度不看函数。一条 FDE 里只有三个数跟函数走：

* `PC Begin` —— 挂一条 `R_X86_64_PC32`，指着一条**没有名字**的 STT_SECTION 符号
* `PC Range` —— 这个函数多大
* `DW_CFA_advance_loc4` 那一格 —— `size - 5`

那几条 CFA 指令是**写死**的（`advance_loc+1` / `def_cfa_offset 16` /
`offset rbp cfa-16` / `advance_loc+3` / `def_cfa_register rbp`）：tcc 编出来的序言
一律 `push rbp`（1 字节）+ `mov rsp,rbp`（3 字节），那两步正好对得上，而 `size - 5`
根本不看收尾那几条指令有多长 —— 就是这么算的。**我们的序言前四个字节与 tcc 一样**
（`55 48 89 e5`），所以同一套 CFA 指令在我们的码上也对。

### 每个 FDE 一条节符号 —— 而且不查重

`dwarf_get_section_sym` 每次都直接 `put_elf_sym(…, NULL)`，不查重。所以 n 个函数就有
n 条一模一样的 STT_SECTION 局部符号，`sh_info` 跟着往后挪。量过的两函数那份：
`· a.c ·(SECTION) ·(SECTION) f main`，`sh_info = 4` —— 我们写出来的一样。

### 门 `tests/c/eh-frame-x64.js` 8/0

六条正面加两条反面。第三条是这一门的骨头：把每条 FDE 里那三个数**挖成零**，
剩下的与尺子**逐字节相同** —— 我们的代码比 tcc 的长，那三个数不可能一样，
别的一个字节都不该差。第四条反过来查那三个数与我们自己的函数对得上
（FDE 把 `.text` 铺满、`advance_loc4` 都是 `size - 5`）。

### 量出来的进展与还欠的

`tcc-obj.js x86_64-linux`：**0 容器相同, 5 不同** → **3 容器相同, 2 不同**，
`05-global.c` 的节名单从此与尺子逐字相同（`.eh_frame .rela.data .rela.eh_frame
.rela.text` —— 三条造出来的次序一条不差）。

还欠的两笔，都在同一条轴上：

* `03-inttypes.c` 差的还是那条 `.rela.text` —— 模块内的直接调用我们走标签、不发重定位。
* **arm64-linux 的 FDE 另算**：那边 `code_alignment_factor` 是 4、返回地址列是 30，
  而且 `def_cfa_offset` 里带着**帧有多大**（`tccdbg.c:958` 的 `224 + ((-loc + 15) & ~15)`）
  —— 那个数得从后端捞出来，所以这一片只写了 x86_64 的，arm64-linux 上还一节不写。

<!-- 第九刀第一百一十九片-END -->

## 落地：第九刀第一百二十片

符号表里那一格 **`st_size`** 我们一直写 0。tcc 两种符号都填：

* 函数 —— 它在 `.text` 里占多长。是**这个函数的落点到下一个函数的落点**，不是「代码
  多少字节」：win32 上第一个函数后面那八字节的 `UNWIND_INFO` 也算在里头
  （量过：`f` 的代码 23 字节、`st_size` 32）。所以这一格就是后端已经算好的 `blob.sizes`。
* 全局量 —— 那个 C 类型有多少字节（`static const char s[] = "hi"` 是 3、`char tab[40]` 是 40）。

### 门 `tests/c/sym-size.js` 4/0

两件事分开查，因为能查的强度不同：

* 全局量那些名字的 `st_size` 与尺子**一个数不差** —— 那是 C 类型的大小，与我们的代码
  长短无关，所以必须相同（数据段里的**落点**我们还与 tcc 不同，那是另一笔债）。
* 函数那些只能查不变量：`st_size` 把 `.text` **铺满**（第 k 个的 `val + size` 正好是
  第 k+1 个的 `val`，最后一个到节尾）—— 尺子那一份也拿同一条查过，两边都成立。

### 量出来的两笔新债

比符号表的时候顺手看见两件事，都写在这儿等着：

* **win32 上 tcc 不加那条下划线前缀**。`libtcc.c:895-898`：

  ```c
  /* enable this if you want symbols with leading underscore on windows: */
  #if defined TCC_TARGET_MACHO /* || defined TCC_TARGET_PE */
      s->leading_underscore = 1;
  #endif
  ```

  PE 那一支是**注释掉的**。我们却给 win32 也加了 `_`（第一百〇七片欠下的），
  于是 win32 的符号名一个都对不上 —— 所以这一门的表里暂时没有 win32。下一片就这个。
* **`const` 的静态量该落在只读那一节里**。尺子那份 `s` 的 `st_shndx` 是 3（`.rdata`/
  `.data.ro`），我们的是 2（`.data`）。第一百一十六片把那一节的名字摆对了，
  可还没有一个字节落进去。

<!-- 第九刀第一百二十片-END -->

## 落地：第九刀第一百二十一片

上一片量出来的那笔：**win32 上没有那条下划线前缀**。`libtcc.c:895-898`

```c
/* enable this if you want symbols with leading underscore on windows: */
#if defined TCC_TARGET_MACHO /* || defined TCC_TARGET_PE */
    s->leading_underscore = 1;
#endif
```

—— PE 那一支被注释掉了，只有 MACHO 开着。所以「加不加 `_`」不是「ELF 之外都加」，
而是**只有 osx 加**。第一百〇七片写下的 `os === 'linux' ? '' : '_'` 把 win32 也捎上了，
这一片改成 `os === 'osx' ? '_' : ''`。

有意思的是我们自己的 PE 链接器一直是对的（`pe_load.js`：「PE 上默认是 0，
只有 `-fleading-underscore` 才开」）—— 一头知道、另一头不知道，是同一件事记了两处的
老毛病；这回把写 `.o` 那一头对齐到同一个说法。

### 门

`tests/c/sym-size.js` 从 4/0 变 6/0：x86_64-win32 加回表里，六个全局量的 `st_size`
与尺子一个数不差 —— 上一片这一格根本比不了，因为名字全对不上。
`pe-exe`（352 条相同）与 `tcc-link`（83/0）都没动，正说明链接那一头本来就不指望前缀。

### 顺手记下的一笔

`tccdefs.js` 那张预定义表还是**照 macho 写死**的（`__APPLE__`、`__unix__`、
`__leading_underscore` 都在里头，只有 CPU 那三条跟着 `--arch` 走）。编给 linux 或
win32 的时候那几条都是错的 —— 比这一片大得多的一笔，单独一片。

### 下一片的尺子：只读数据那一节里到底有什么（量过了）

第一百一十六片把那一节的名字摆对了，可我们还没有一个字节落进去。拿
`static const char s[] = "hi"; const int ci = 5; char *p = "lit"; int g = 1;
const char *const cp = "cst";` 量 x86_64-linux 的尺子：

* `.data` 只剩 12 字节 —— 只有 `p`（8）与 `g`（4）
* `.data.ro` 28 字节，里头**五样**：`s`（0，3 字节）、`ci`（4）、串常量 `L.3`（8，`"lit"`）、
  `cp`（16，8 对齐）、串常量 `L.4`（24，`"cst"`）
* **`const` 的东西哪怕初值要重定位也进只读节**：`cp` 在 `.data.ro` 里，于是多一张
  `.rela.data.ro`（一条，`cp` 指着 `L.4`）
* 串常量在符号表里是**有名字的局部** `L.3`/`L.4`（STT_OBJECT、`shndx = 3`、
  `st_size` 是带 `\0` 的长度），我们叫 `omni_str_N`
* 每样按自己的对齐摆，串常量 1 对齐（`L.3` 就紧跟在 `ci` 后面）

所以那一片要动的地方：前端记下「这一块是只读的」（`const` 与串常量）、MIR 多一格、
两个后端多出一段字节、ELF 写出器多一节内容与一张 `.rela.data.ro`（次序还是照
「造出来的次序」那条规矩），还有 Mach-O 那个写出器要多一节（`__DATA,__const`）——
它现在只写 `__text` 与 `__data` 两节，而 clang 那条「真的能跑」的腿正压在它上面。

<!-- 第九刀第一百二十一片-END -->

## 落地：第九刀第一百二十二片

上一片量下的尺子里有五样，这一片摆进去**三样半**：`const` 的全局量。串常量那两样
（`L.3`/`L.4`）留给下一片 —— 它要的是 tcc 那个匿名符号计数器，是另一件事。

### 谁算只读的：只剥数组

`tccgen.c:8401-8403`

```c
while ((tp->t & (VT_BTYPE|VT_ARRAY)) == (VT_PTR|VT_ARRAY))
    tp = &tp->ref->type;
is_const = tp->t & VT_CONSTANT;
```

那个 while 的条件是 `VT_PTR|VT_ARRAY` —— 在 tcc 里数组就是「带 `VT_ARRAY` 的指针」，
所以这一圈**只剥数组**，剥到第一个不是数组的类型就停下，看它的 `VT_CONSTANT`。
量过的四种（x86_64-linux）：

* `const char s[] = "hi"` → 剥掉数组剩 `const char` → 只读节
* `const int ci = 7` → 只读节
* `const char *const cq = "q"` → 不是数组，直接看：这一层**指针**带 const → 只读节
* `const char *cp = "cst"` → 不是数组，这一层指针**不**带 const（const 在被指的
  `char` 上）→ `.data`

第三条与第四条只差一个 `const` 的位置，落点却不同一节 —— 这正是「读的是**这个对象**
能不能改」，而不是「这行里有没有 const」。

### 于是指针自己的限定词不能再吃掉了

`declaratorParts` 里那一段从前把 `*` 后面的 `const`/`volatile`/`__restrict` 一律吃掉，
注释还写着「这一片没有可观察的效果」。从第一百一十六片起那句话就不成立了：
`const char *const cq` 与 `const char *cp` 全靠这一位分家。这一片把 `const` 与
`volatile` 记在**那一层指针**的类型上（`preQ[i]`，一颗 `*` 一格），`__restrict` 与
`_Atomic` 照旧吃掉 —— 它们真的还没有可观察的效果。

改完跑一遍怕它溢出去的那几处（`compareTypes` 有 `unqualified` 这一格、
指针算术那两条合并限定词的路）：`run.js` 207/0、`native.js` 227/0、
`elf-exe`/`macho-exe`/`pe-content` 一个字节没动。

### 字节走的路

前端 `isRoType` → `mod.markGlobalRo(no)` → 两个后端的全局那一圈按这一位分两段
（`dataBytes` / `roBytes`，各自从 0 数偏移，符号带 `sect: 2` 或 `3`，重定位分两张表）
→ ELF 写出器 `opts.rodata` 摆进 3 号节、`raRo` 出一张 `.rela<只读节名>`。

两处细节：

* **原地的加数**要从只读那一段里捞（`relaOf` 从前只认 `.data`）—— `cq` 的那八个字节
  躺着的是加数，搬到 `r_addend` 去、原地清零，与 `.data` 同一个待遇。
* **`.rela.data.ro` 的位置**还是「造出来的次序」那条规矩（第一百一十八片）：只读那一段里
  第一条重定位落在第几个函数之前。与 `.rela.data` 撞在同一格时只读那一节的号大、排后面
  （`relaSeq` 里那个 `+ 0.01`）。量过的三个目标都对上了。

Mach-O 那个写出器只有 `__text`/`__data` 两节，所以只读那一段**折进 `__data` 的尾巴**
（`foldRo`：按 `dataAlign` 对齐之后接上去，`sect: 3` 的符号与重定位跟着挪）。
真正的 `__DATA,__const` 是笔欠账，可 clang 那条「真的能跑」的腿压在这个写出器上，
折过来至少不掉字节 —— `native.js` 227/0 是它的凭据。

### 门

`tests/c/rodata-sec.js` 27/0 —— 三个目标（x86_64-linux / x86_64-win32 / arm64-osx）
× 三个探针（常量与可写混着摆、只读的指针、一个 const 也没有）× 三问：

* 那几个名字各在第几节（尺子怎么说就怎么算，节号不写死）
* 只读节里**那几样的字节**（位置各家自己排 —— 我们还没摆串常量，所以比的是
  「这个符号那一段的内容」）
* `.rela<只读节名>` 有没有、在 7 号往后那一段的第几位

门里踩过一格值得记：第一版查符号表用的是光名字，arm64-osx 上两边都查不到（那边有
`_` 前缀），于是三条「节号」比的是 `undefined:undefined` —— **假绿**。现在查不到就当场报。

`tcc-obj.js` 的「容器相同」从 6 走到 12。回归：`native` 227/0、`run` 207/0、
`selfobj` 25/0、`tcc-link` 83/0、`elf-merge` 451、`pe-exe` 352、`elf-roundtrip` 268、
`rela-order` 6/0、`sym-size` 6/0、`eh-frame-x64` 8/0、`pdata-x64` 11/0。

### 下一片：串常量进只读节，名字叫 `L.N`

上一片的尺子里剩下的那两样。量过的形态（x86_64-linux）：`L.3`/`L.4` 是**有名字的局部**
符号（STT_OBJECT、`shndx = 3`、`st_size` 是带 `\0` 的长度）、1 对齐、紧挨着摆。
难的不是摆字节，是那个 `N`：它是 tcc 的匿名符号计数器（`anon_sym`）走到那儿的值，
所以要先把「这个计数器在哪几处 ++」量清楚 —— 它同时给匿名 struct、静态块、
串常量发号，编号对不上则一个字节也对不上。

<!-- 第九刀第一百二十二片-END -->

## 落地：第九刀第一百二十三片

上一片摆进只读节的是 `const` 的全局量，这一片是**串常量** —— 尺子上那一节里剩下的两样。

### 量到的四条

拿 `char *a="A"; char *b="B"; int main(void){ const int *w=L"ab"; … }` 量 x86_64-linux：

* 串常量落在 `.data.ro` 里（PE 上 `.rdata`），符号是**有名字的局部** STT_OBJECT
* 每条按**元素的宽度**对齐：`L.3`@0（2 字节）、`L.4`@2（2）、宽串 `L.5`@4（12）
* `st_size` 是带结尾那一格的长度：窄串 `strlen+1`、宽串 `(n+1)*4`
* 那一节自己的 `sh_addralign` 还是 8 —— 每条串的对齐是**摆的时候**的事，不是节的属性

第二条把第三十三片那句话推翻了：从前串常量一律 8 对齐摆在 `.data` 里，注释写的理由是
「宽串的地址会被交给按 `int` 读的代码，而 8 是所有 C 标量的上界，一条 while 就够」——
将就得对，可尺子按元素宽度。于是这一片给 MIR 加了一格 `strAlign`（缺省 1、宽串 4）：
常量池里宽串与「就这几个字节」的窄串是同一个种类（`bytes`），分不出来，只能由造它的人说。

### 结尾那一格挪了位置

`wstrConst` 从前自己在字节里加一格四个零，摆字节的那一步又补一个字节 —— `st_size`
于是比 tcc 多 1。这一片把收尾统一到摆字节那一步：补**一个元素宽**的零（`sal` 个字节），
两种串共用同一条。`.data.ro` 从 17 字节变 16，与尺子逐字节相同。

### 门

`tests/c/str-rodata.js` 33/0/1 —— 三个目标 × 四个探针（两条窄串、窄串夹宽串、
带 `\xNN` 转义的串、一条串也没有）× 三问：那一节的字节（逐字节）、落在那一节里的符号
（**落点与大小与绑定/类型**，名字不比 —— 我们叫 `omni_str_N`）、`sh_addralign`。

那个 `1 not yet` 是量出来的一笔：**win32 的 `wchar_t` 只有两字节**，tcc 那边 `L"ab"`
在 `.rdata` 里占 6 字节，我们的宽串一律四字节。照实报成 `todo` 而不是把探针删掉 ——
删掉就成了假绿，这道门前一版正踩过一次（osx 上查符号忘了下划线，三条比较全在比
`undefined`）。

回归：`native` 227/0、`run` 207/0、`x64/from-mir` 90/0、`arm64/from-mir` 88/0、
`native-gen` 83/0、`selfobj` 25/0、`tcc-link` 83/0、`elf-merge` 451、`pe-exe` 352、
`elf-roundtrip` 268、`elf-exe` 53、`macho-exe` 26、`pe-content` 328、`elf-dyn` 53、
`macho-dylib` 107、`rodata-sec` 27/0。`tcc-obj` 的容器相同还是 12。

### 下一片的尺子：那个 `L.N` 的 N（量过了）

`tccpp.c:626` 是 `sprintf(p, "L.%u", v - SYM_FIRST_ANOM)` —— 名字里的数就是**匿名符号
计数器**走到那儿的值。三处 `anon_sym++`（`tccgen.c:1129` 的 `get_sym_ref`：串常量与
静态块都走它；`4490`：没名字的 `struct`/`union`/`enum`；`4675`：匿名的成员），
一个计数器发号。

量出来的起点**每个目标不同**：linux 3、win32 0、osx 1。原因在 `include/tccdefs.h` 里
`__builtin_va_list` 的形状：

* x86_64 SysV 是 `typedef struct { …; union { … }; … } __builtin_va_list[1]` ——
  匿名的外层 struct、匿名的 union、再加那个匿名成员自己，三个号
* win32 x86_64 是 `typedef char *__builtin_va_list` —— 一个号也不用
* arm64-osx 是 `typedef struct { void *__stack; } __builtin_va_list` —— 一个号

所以那一片要先把这个计数器建起来（匿名聚合体也得从它取号），而起点得由**我们自己的
预定义**给出 —— 那正好压在「`tccdefs.js` 照 macho 写死」那笔欠账上。

顺手量到的另一笔：**tcc 不给串常量去重**。同一份源码里 `"A"` 写两遍，`.data.ro` 里就是
两份字节、两条 `L.N`；我们的常量池按 `类型|种类|文本` 去重成一份。那是「一条串常量的
身份是它在源码里的**那一次出现**」，与编号那件事是同一片的两半。

### 那个 `1 not yet` 试过了：它压在别的欠账后面

win32 的 `wchar_t` 是两字节这件事本身好做 —— 照 `long double` 那一格的样子在 ctype.js
里加一格模块级状态（`setWcharTarget`/`wcharType`/`wcharSize`），宽串的元素类型、
`initWString` 的步长、那几处「元素类型是不是 wchar_t」的判断跟着它走，`.rdata` 里
`L"ab"` 就从 12 字节变 6。写完跑一遍：`native` 227/0、`run` 207/0、`tcc-obj` 也没有
新的「编不出」。

可它错在别处：`wchar_t s[] = L"ab"` 编给 win32 **编不动了** —— 我们给所有目标用的都是
macOS 的 SDK 头，那儿 `wchar_t` 是 `__darwin_wchar_t`（写死的 `int`），于是「宽串的
元素类型」与「`wchar_t` 这个名字」当场不是一回事，那一行报「array size missing」。
tcc 那边没有这个问题：编 win32 时它用的是自己的 `win32/include`。

所以这一格不是一片，而是压在**每个目标自己的头与预定义**那笔欠账后面（`tccdefs.js`
照 macho 写死那笔的同一根）。改动已经退掉，测量留在这儿：动它之前先把头与预定义
按目标分开，否则「宽串对了、`wchar_t` 这个名字还是旧的」比原来更糟。

<!-- 第九刀第一百二十三片-END -->

## 落地：第九刀第一百二十四片

**一条串常量的身份是它在源码里的那一次出现，不是它的字节。**

上一片顺手量到的那半格：tcc 不给串常量去重。量一遍尺子（x86_64-linux）——

```c
char *a = "A";
char *b = "A";
int main(void) { char *c = "A"; return a[0] + b[0] + c[0]; }
```

`.data.ro` 是 `65 0 65 0 65 0`，三条局部符号 `L.3`@0+2、`L.4`@2+2、`L.5`@4+2。三处
`"A"` 就是三份字节、三个号 —— tcc 那边压根没有「相同的串合成一条」这一步：
`tccgen.c` 里每见到一条串常量就 `get_sym_ref` 领一个新的匿名号，把字节摆进节里。

我们的常量池原来按 `类型|种类|文本` 认人（`consts.str(s)` 里一张 `Map`），三处 `"A"`
合成一条、`.data.ro` 只有两字节。这一片把「摆一条新的」与「按文本找回来」拆开：

* `mir/ir.js`：`fresh(t, kind, text)` 只管往池子里**添一条**并返回新的 `ref`，
  `strOnce(s)`/`bytesOnce(bs)` 走它。原来那两个按文本查表的入口留着 —— 别处（比如
  内建的名字）还按文本认人。
* `frontend-c/tccgen.js`：`strConst`/`wstrConst` 不再按文本查，改按**出现的次序**记：
  `strKey()` 发一把钥匙，`this.strRefs` 这张表按钥匙存 `ref`。

钥匙这件事有个坑。函数体我们要走两遍（偏差四），第二遍必须认回第一遍摆下的那一条，
否则每条串都会变成两份 —— 所以钥匙不能是「第几条」这么简单，得像
`declareStaticLocal` 的 `${funcName}.${name}.${staticNo++}` 那样，**两遍里数出同一个
号**。函数体里用 `${funcName}#${strNo++}`，`strNo` 在 `runBody` 的每一遍开头跟
`staticNo` 一起归零。

文件作用域上不能用同一格计数：那儿 `funcName` 是空的，而 `strNo` 被每个函数体归零，
于是「第一个函数之前的那条串」与「两个函数之间的那条串」会领到同一把钥匙 —— 后者
认回前者，指到别人的字节上。这道坑我踩了一次（`native` 223/4，`g_wp` 指到了
`"omni\0"` 上）。修法是文件作用域自己一格**只增不减**的计数：`@${strTopNo++}`。

### 门

`tests/c/str-rodata.js` 加两个探针，跟着原来那三格检查（只读节逐字节、符号的落点与
大小、`sh_addralign`）过三个目标：

* **同一个串写三遍**：两处在文件作用域、一处在函数体里 —— 既比「不去重」，也比
  「两遍解析不重摆」
* **两个函数体各一条串**：`strNo` 归零之后别让第二个函数的第一条串认到第一个函数
  那一条上去

51/0/1（还剩 win32 的 `wchar_t` 那一格，上一片记过为什么）。回归：`native` 227/0、
`run` 207/0/1、`rodata-sec` 27/0、`native-gen` 83/0、`x64/from-mir` 90/0、
`arm64/from-mir` 88/0、`selfobj` 25/0、`tcc-link` 83/0。`tcc-obj` 的容器相同还是 12。

不去重不影响出字节的确定性：同一份输入走同一条路，池子里的次序一模一样，
`bytes.js` 的哈希照旧。

### 下一片还是那个 `L.N`

名字这一格没动 —— 我们还叫 `omni_str_N`，那个 `N` 是池子里的下标（上面那个探针里是
0、1、3，中间的 2 是池子里一条别的常量）。tcc 的 `N` 是匿名符号计数器，起点每个目标
不同（linux 3、win32 0、osx 1，见上一片的测量），所以它压在「每个目标自己的预定义」
那笔欠账上。现在「一处出现一条池子条目」已经就位，那一片只需把编号换成从共享的
匿名计数器取号。

<!-- 第九刀第一百二十四片-END -->

## 落地：第九刀第一百二十五片

**只读那一节里没有「先摆哪一类」这回事 —— 谁先领字节谁在前。**

前两片把两样东西摆进了只读节：`const` 的全局量（一百二十二）与串常量（一百二十三）。
两片各写了一个循环，于是节里是「全局量一段、串常量一段」。量一遍尺子，那不对：

```c
const int c1 = 11;   char *a = "A";   const int c2 = 22;   char *b = "B";
```

tcc 的 `.data.ro` 是 `11 0 0 0 | 65 0 | 0 0 | 22 0 0 0 | 66 0`，符号 `c1`@0+4、
`L.3`@4+2、`c2`@8+4、`L.4`@12+2 —— **按声明的次序交替着摆**，每样按自己的对齐
（`c2` 让到 8 是因为 `L.3` 之后游标在 6，`int` 要 4 对齐）。我们那一版是
`11 0 0 0 22 0 0 0 65 0 66 0`：字节数还少两个，因为「先全局后串」正好省下了那次让位。

原因在 tcc 那边压根没有「类别」：只读节就是一个 `section_ptr_add` 的游标，谁先要字节
谁先拿。再量一格确认游标的粒度 —— `const char *const q = "S"`：`q`@0+8 在前、它初值里
那条串 `L.3`@8 在后。也就是说一块 `const` 全局是在**解析它的初值之前**领的字节。

### 一个轴上的号

所以「谁先」这件事得由前端记下来，而且全局量与串常量要在**同一个轴**上：

* `frontend-c/tccgen.js`：`this.dataSeq` 一格只增不减的计数。`allocGlobal` 领一个
  （那正是 tcc 推游标的那一刻），`strConst`/`wstrConst` 新建一条串常量时领一个。
* `mir/ir.js`：`globalSeq[gi]` 与 `strSeq[ref]` 两张标注表，`markGlobalRo(no, seq)` 与
  `markStrSeq(ref, seq)` 记下来。还是标注 —— 只有写目标文件那一步看它。
* `mir/rodata.js`（新的一小份）：`planRodata(mod)` 把两样东西收成一张单子，按号**稳定
  排序**，再一遍推游标算出每一样的落点，回 `{size, gOff, sOff}`。

两个后端（`x64/from_mir.js`、`arm64/from_mir.js`）从此不自己推只读那一段的游标：
先 `planRodata` 排好，`roBytes` 直接开成那么大一块零，摆字节的时候按查到的落点写进去。
可写那一段照旧一块接一块推。这样两处循环的次序（先全局、后串）就与节里的次序脱钩了 ——
那本来就是两回事，从前只是恰好一样。

没有号的（别的前端、手搭的 MIR）在排序里当 `Infinity`，稳定排序把它们留在原处，
于是旧的次序一字不差：`x64/from-mir` 90/0、`arm64/from-mir` 88/0 一个字节都没动。

### 门

`tests/c/str-rodata.js` 再加两个探针，还是那三问（只读节逐字节、符号的落点与大小、
`sh_addralign`）过三个目标：

* **`const` 全局与串常量交替**：14 字节逐字节相同，四条符号的落点与大小一个数不差
* **`const` 指针的初值里那条串排在它后面**：18 字节，同上

69/0/1。回归：`native` 227/0、`run` 207/0/1、`rodata-sec` 27/0、`native-gen` 83/0、
`selfobj` 25/0、`tcc-link` 83/0、`rela-order` 6/0、`sym-size` 6/0、`elf-roundtrip` 268、
`elf-merge` 451、`pe-content` 328、`pe-exe` 352、`elf-exe` 53、`elf-dyn` 53、
`macho-exe` 26、`macho-dylib` 107。`tcc-obj` 的容器相同还是 12。

### 只读节里还差的那两样

字节与落点现在对得上了，`.data.ro` 那一节剩下的差别只有**名字**（我们 `omni_str_N`、
tcc `L.N`，压在「每个目标自己的预定义」那笔欠账上，见一百二十三片的测量）与**符号表
里那几条的次序**（量到 tcc 是 `L.3 L.4 q c` —— 局部在前、按声明；我们是
`omni_str_0 omni_str_1 c q`，全局那一段按「第一次提到」排）。后者是「符号按声明次序」
那笔欠账的一格，与这一片同一个轴上的号正好能用。

<!-- 第九刀第一百二十五片-END -->

## 落地：第九刀第一百二十六片

**符号表的次序就是建符号的次序。**

上一片收尾时量到只读节还差两样，其中一样是符号表里那几条的次序。`tccelf.c:862` 上
tcc 自己写着为什么：

> In an ELF file symbol table, the local symbols must appear below the global and weak
> ones. Since TCC cannot sort it while generating the code, we must do it after.

也就是说 tcc 压根不排 —— `sort_syms` 只做一件事：按绑定分成局部/非局部两段，**段里
保持原序**（两趟 for，各自顺着抄）。原序就是 `put_elf_sym` 被调用的次序，也就是源码里
一个名字**第一次被提到**的次序。

量一遍（x86_64-linux，`const char *const q="S"; const int c; char *p="P"; static int sv;
int gv;` 加一个 `static` 函数和 `main`）：

```
局部：  L.3  L.4  sv  helper          非局部： q  c  p  gv  main
```

我们那一版是三堆分开攒的 —— 函数（`cli.js` 照 `mod.funcs` 发）、全局量、串常量
（两个后端的那两段循环）—— 于是局部段是 `omni_str_0 omni_str_1 helper sv`、
非局部段是 `main c q p gv`。分段那一刀我们的写出器早就在切（`sh_info` 一直是对的），
差的只是段里的次序。

上一片那个「谁先领到字节」的号正好是这件事要的东西，只差两处：

* 函数也要号：`funcSym` 第一次见到一个名字就 `markFuncSeq(no, dataSeq++)`
  （`mir/ir.js` 多一张 `funcSeq` 标注表）
* **每一块**全局量都要号，不只是 `const` 那些：`markGlobalSeq(no, e.dseq)` 从
  `markGlobalRo` 里拆出来单独叫 —— 上一片只给了 `const` 的，于是这一片第一版里
  `p`/`gv`/`sv` 的号是 `undefined`，排到了 `main` 后面（局部段成了
  `str str helper sv`，非局部段成了 `q c main p gv`）。那个错正好说明这两片是一个轴。

排的地方在 `cli.js` 的 `orderSyms`：把 `[...函数, ...数据]` 按号**稳定排序**一遍再交给
写出器。没有号的（别的前端、别名）当 `Infinity` 留在原处。

### 门

新的 `tests/c/sym-order.js`：三个目标 × 三个探针 × 两问 —— 整张 `.symtab` 逐条
（每条比「名字/绑定/类型/节号」，串常量的名字换成 `<str>`：tcc 叫 `L.N`、我们叫
`omni_str_N`，那是另一片的事）、`sh_info`（前面有几条局部的）。18/0。

探针里有一格是**先调用后定义**（`main` 里先调 `later`，`later` 定义在后面的全局量
之后）—— 盯的是「第一次被提到」而不是「第几个被定义」，两边都是前者。

顺手量到一格：osx 上那个串常量符号叫 **`_L.1`**（带下划线，起点 1）—— 与第一百二十三片
量的匿名计数器起点对得上。

回归：`native` 227/0、`run` 207/0/1、`str-rodata` 69/0/1、`rodata-sec` 27/0、
`native-gen` 83/0、`selfobj` 25/0、`tcc-link` 83/0、`sym-size` 6/0、`rela-order` 6/0、
`eh-frame-x64` 8/0、`pdata-x64` 11/0、`x64/from-mir` 90/0、`arm64/from-mir` 88/0、
`elf-roundtrip` 268、`elf-merge` 451、`pe-content` 328、`pe-exe` 352、`elf-exe` 53、
`elf-dyn` 53、`macho-exe` 26、`macho-dylib` 107。`tcc-obj` 的容器相同还是 12。

### 只读节里剩下的那一样

字节、落点、符号表的次序都对上了，`.data.ro` 与 `.symtab` 上剩下的差别只有**名字**：
`L.N` 的那个 N 是匿名符号计数器，起点每个目标不同（linux 3、win32 0、osx 1），
压在「每个目标自己的头与预定义」那笔欠账后面。

<!-- 第九刀第一百二十六片-END -->

## 落地：第九刀第一百二十七片

**模块内的直接调用也走符号 —— 位移留给链接器。**

`.o` 的节表上一直缺一节：`.rela.text`。量一遍最小的那种：

```c
static int a(void) { return 1; }
int main(void) { return a(); }
```

tcc 出的 `.text` 里那条 `e8` 后面是**四个零**，`.rela.text` 里一条
`R_X86_64_PLT32`（加数 −4）指着 `a` —— 哪怕 `a` 就在同一个 `.o` 里、哪怕它是**局部
符号**，tcc 也不在汇编那一层把位移算掉。arm64 上同一回事：`bl` 的编码是
`0x94000000`（偏移全零），一条 `ARM64_RELOC_BRANCH26`。

我们从前分两路走：跨模块（`CCALL`）发符号、模块内（`CALL`）走 `CodeBuf` 的标签，在
汇编那一层就把位移算出来了。结果是 `.rela.text` 一条也没有，`.o` 比 tcc 少一节 ——
连 `.shstrtab` 的长度都因此差 11 个字节。

改动是两处各一行：`x64/from_mir.js` 的 `buf.call(label)` 换成
`buf.callSym(this.funcSym(f.a[i]))`、`arm64/from_mir.js` 的 `buf.bl(label)` 换成
`buf.blSym(…)`。`callLabels` 那一格留着 —— 它现在只当「这个模块里有没有落点」的判据
（单个函数生成时 `CALL` 照旧报 nyi，`from-mir` 里那条负例还盯着）。

不用改的地方比改的地方多，值得记一笔：两个写出器早就会写这种重定位（跨模块调用一直
走它），Mach-O 那边一律 `r_extern=1` + 符号号 —— 指着一个**本文件里已定义**的符号
也合法；我们自己的链接器解 `PLT32`/`BRANCH26` 时也不问「符号是不是同一个 `.o` 的」。

### 门

新的 `tests/c/rela-text.js`：三个目标 × 四个探针 × 两问 —— 那几条重定位本身
（类型/指着谁/加数，按表里的次序）与「落点上那几个字节是零」。18/0/3。

`r_offset` **不比**：我们出的代码比 tcc 长（`main` 里那条调用在 tcc 是 30、我们是 52），
落点对不上是窥孔那几片的事，不是这一片的。

那三个 `not yet` 是同一格：`static int one(); … one() + strlen("ab")` 这个探针上
tcc 是 `4/one 2/L.0 4/strlen`、我们是 `4/strlen 4/one 2/omni_str_N 4/$ext$strlen` ——
多出来的两条来自**外部函数的转发桩**（`$ext$strlen` 现在是一个真的函数，桩里那条
`call strlen` 反而排在最前），于是次序也错位。那是「桩不该是函数」那笔欠账。

`tcc-obj` 的「容器相同」从 12 走到 **16**。回归：`native` 227/0、`run` 207/0/1、
`native-gen` 83/0、`str-rodata` 69/0/1、`rodata-sec` 27/0、`sym-order` 18/0、
`sym-size` 6/0、`rela-order` 6/0、`eh-frame-x64` 8/0、`pdata-x64` 11/0、
`x64/from-mir` 90/0、`arm64/from-mir` 88/0、`selfobj` 25/0、`tcc-link` 83/0、
`elf-roundtrip` 268、`elf-merge` 451、`pe-content` 328、`pe-exe` 352、`elf-exe` 53、
`elf-dyn` 53、`macho-exe` 26、`macho-dylib` 107。

<!-- 第九刀第一百二十七片-END -->

## 量：外部函数的桩要怎么去掉（下一片的尺子）

上一片剩下的三个 `not yet` 都是同一格。量到的差别（x86_64-linux，
`static int one(void); … one() + (int)strlen("ab")`）：

```
tcc : 4/one/-4   2/L.0/-4          4/strlen/-4
ours: 4/strlen/-4  4/one/-4  2/omni_str_N/-4  4/$ext$strlen/-4
```

多出来的两条来自 `externThunk`（`tccgen.js:3764`）：这个单元里没有函数体的名字被改成
`$ext$strlen`、发成一个**真的局部函数**，桩里一条 `CCALL strlen`（那就是排在最前面的
`4/strlen`），调用点则 `CALL $ext$strlen`（最后那条）。把桩去掉，次序就是
`4/one 2/串 4/strlen` —— 与尺子只差名字。

桩当初是为了两件事：

1. **一遍过**：调用点可能在「知道这个名字最后有没有函数体」之前。桩把这件事推到读完
   整个单元之后，于是调用点一条都不用改。
2. **线性内存那两条腿**：那边的 `CCALL` 落到宿主的 JS 实现上，桩是唯一的落点。

第一百二十七片把路清了一半：`CALL` 现在按**符号名**发，位移交给链接器 —— 也就是说
一个没有函数体的被调者**压根不需要代码**。所以 native 这条腿上桩可以换成：

* MIR 的函数多一格「没有函数体」（像 `setGlobalExtern` 那样），`sealExternSymbols`
  在 native 上打这一格而不是改名 + 发 `RET`
* 两个后端跳过这种函数（不出代码、不发符号），`funcSym(no)` 回**真名**
* 名字靠那条重定位进「未定义的外部符号」那一段 —— 两个写出器早就这么扫了

还得接住桩顺手在做的三件 ABI 事（都在 `externThunk` 里，第一百一十三片那几行）：

* x86_64 的 `long double` 实参是 X87 类：要 `ARGMEM` + `MEMARG_F80`，不能按 xmm 传
* `st0` 返回（`ldRet`）：`callRet` 现在问的是被调者的 `f.ldRet`，外部函数得从声明里拨
* SysV 的 `al`（xmm 个数）：`CCALL` 一律报，`CALL` 现在不报 —— 外部符号那条要报

变参的外部函数不在这一片里：它的调用点早就直接发 `CCALL`（`funcCall`），没有桩。

<!-- 量：外部函数的桩-END -->

## 落地：第九刀第一百二十八片

**没有函数体的名字不该是一个函数。**

上一节把尺子记好了，这一片照着做。native 这条腿上外部函数不再发桩：

* `MirFunc` 多一格 `extern`（`setExtern()`）—— 与 `setGlobalExtern` 同一件事，落在函数上
* `externThunk` 开头：native 上「简单」的外部函数直接打这一格就回（不改名、不发
  `CCALL`、一条指令都不出）
* `sealExternSymbols`：native 上一律打这一格 —— 声明了却没用过的那些于此彻底消失，
  与 tcc 一样（它压根不为没引用过的声明发符号）
* 两个后端的那个「一个函数一段」的循环跳过它们，落点记 **−1**
* `cli.js` 与三个自己攒 `defs` 的门跳过它们的符号

名字靠调用点那条重定位进「未定义的外部符号」那一段 —— 两个写出器早就这么扫了，
一行都没改。

### 还留着桩的四类（`externSimple` 说的就是它们）

1. **变参的** —— 它的调用点早就直接发 `CCALL`
2. **按值收发 struct 的** —— 桩里那两条 `todo` 是边界，得留在那儿报
3. **带 x87 `long double`（16 字节那种）实参或返回值的** —— 桩顺手在做
   `ARGMEM`+`MEMARG_F80` 与 `st0` 那两件事
4. **取过地址的**（新量到的一格）—— `int (*f)(int) = isalpha;`

第 4 类是这一片踩的坑：`33-ctype` 链不上，
`ld: fixup error (kind=arm64_adrp_lo12) at '_main'+0x14 … target '_isalpha' does not have
address`。**调它**与**取它的地址**是两回事 —— 调用点那条 `PLT32`/`BRANCH26` 指着未定义
符号没问题（链接器会给它搭 stub），而 `adrp+add`/`lea` 指着未定义符号 Mach-O 不收，
那得过 GOT。变参那一格早就走 GOT 了（第三十一片那条「外部全局量」的路，
`funcCall` 里那几行），把它推广到所有外部函数是另一片；这一片先老实记下
`fn.addrTaken`，取过地址的留着桩（桩是本文件里定义的，`adrp` 够得着）。

### 顺手修的一格：那根「第几个函数」的轴

`.rela.text`/`.rela.data` 排在第几，靠的是「这条重定位落在第几个函数」。没有函数体的
函数落点是 −1，于是 `relaSeq` 里那个 `while (offsets[j+1] <= at) j++` 一路走过头 ——
`pdata-x64` 当场红了一格（`.rela.text` 排到 `.pdata` 后面）。修法是这根轴上**只数
出过代码的函数**：`starts` 先滤掉 −1，而 `after`（初值落下那一刻 `funcs` 有多长）折成
「前面有几个出过代码的」。

### 门

`tests/c/rela-text.js` 里那个「模块内一条、模块外一条」的探针从 `not yet` 转绿：
三条重定位与尺子同数、同序（`4/one 2/<str> 4/strlen`）。串常量的名字这道门不比。
22/0/1 —— 剩的那一格是 arm64 上取串常量地址的序列（tcc `adrp`+**`ldr`**、我们
`adrp`+`add`），量在探针的注释里。

`tcc-obj` 的「容器相同」从 16 走到 **21**。回归：`native` 227/0、`run` 207/0/1、
`native-gen` 83/0、`selfobj` 25/0、`tcc-link` 83/0、`sym-order` 18/0、
`str-rodata` 69/0/1、`rodata-sec` 27/0、`sym-size` 6/0、`rela-order` 6/0、
`eh-frame-x64` 8/0、`pdata-x64` 11/0、`x64/from-mir` 90/0、`arm64/from-mir` 88/0、
`elf-roundtrip` 268、`elf-merge` 451、`pe-content` 328、`pe-exe` 352、`elf-exe` 53、
`elf-dyn` 53、`macho-exe` 26、`macho-dylib` 107。

<!-- 第九刀第一百二十八片-END -->

## 量：arm64 上取符号地址一律过 GOT（下一片的尺子）

上一片剩的那个 `not yet` 顺出一条**目标事实**，比原来以为的大。量 arm64-osx（尺子）：

```c
int g = 5;
static const char s[] = "ab";
int main(void) { return g + s[0]; }
```

`.rela.text` 四条，两两成对：

```
@32 type311 sym=_s add=0 insn=9000001e   adrp x30, :got:_s
@36 type312 sym=_s add=0 insn=f94003de   ldr  x30, [x30, :got_lo12:_s]
@44 type311 sym=_g ...                   同一对，换成 _g
@48 type312 sym=_g ...
```

`311` = `R_AARCH64_ADR_GOT_PAGE`、`312` = `R_AARCH64_LD64_GOT_LO12_NC`。也就是说
**arm64 上 tcc 取任何符号的地址都过 GOT** —— 连 `static const char s[]`（同一个 `.o`
里的局部符号）也是。我们发的是 `adrp` + `add`（`275` = `ADR_PREL_PG_HI21`、
`277` = `ADD_ABS_LO12_NC`），一条 `ldr` 都没有。

这条事实牵着好几笔：

* arm64 的 `.rela.text` 要对上，得改成那一对 —— 数量、类型、指令三样一起变
* 第一百二十八片那第 4 类（取过地址的外部函数还留着桩）**正好被它解掉**：
  过 GOT 的地址天生够得着未定义符号
* 我们自己的链接器要会**建 GOT**（tcc 那边是 `tccelf.c` 的 `build_got`/`put_got_entry`）——
  `tcc-link`/`macho-exe` 那几条腿现在解的是 `PAGE21`/`LO12`，多一节 `.got` 是新东西
* x86_64 上不是这样：那边取地址是一条 `lea` + `R_X86_64_PC32`（量过，我们已经一样）

所以这一片得从链接器那头起：先有 `.got` 与那两条重定位的解法，再让 arm64 后端改发
那一对。**别反着来** —— 反过来会让 `native`（clang 链）绿着而 `tcc-link` 全红。

<!-- 量：arm64 的 GOT-END -->

## 落地：第九刀第一百二十九片

**预定义宏那一整张表按目标分。**

起因是量 `-dD` 那道门：`#define A 1` / `#undef A` 一份三行的源码，我们与
`x86_64-tcc` 的输出差 **40 行**。看了才知道差的不是 `-dD` —— 是**预定义**。
`cpp` 那个命令根本没有 `--arch`/`--os` 这两格，而 `tccdefs.js` 里除了目标 CPU
那三条（第一百〇二片接上的），剩下的四十几条照 macho 写死。

### 尺子：六个目标的整张表

`tcc -dM -E` 挨个量。条数就不一样：

```
arm64-osx 51   x86_64-osx 51   x86_64-linux 44
arm64-linux 44   x86_64-win32 41   arm64-win32 40
```

拿三份并排看，差别分得开：

* **OS 那一段**（`tccpp.c:3545` 的 `target_os_defs`）：linux 是
  `__linux__`/`__linux`/`__unix__`/`__unix`，osx 是 `__APPLE__` + 那两条 `__unix`，
  win32 只有 `_WIN32`/`_WIN64` —— PE 那一支在 `#ifdef` 的另一半，`__unix` 走不到
* **模型**：win32 是 LLP64（`__SIZEOF_LONG__ 4`、`__LLP64__`、
  `__SIZE_TYPE__ unsigned long long`、`__LONG_MAX__ 0x7fffffffL`），别的是 LP64。
  tccdefs.h 是**按 `__SIZEOF_LONG__` 分岔**的，不是按 OS
* **`__INT64_TYPE__`**：linux `long`，osx/win32 `long long`（`tccdefs.h:41-45`）——
  同一个宽度，两个名字，而 `%lld` 的格式检查看的是名字
* **`wchar_t` 那两条**：win32 `unsigned short`/`unsigned short`，linux
  `int`/`unsigned int`，osx `int`/`int` —— 三个目标三个样
* **OS 自己那一段**（`tccdefs.h:81-134`）：osx 有 `__GNUC__ 4`/`__APPLE_CC__`/
  `__LITTLE_ENDIAN__`/`_DONT_USE_CTYPE_INLINE_`/`__FINITE_MATH_ONLY__`/
  `_FORTIFY_SOURCE 0`/`_Float16` 七条，win32 有 `__declspec`/`__cdecl` 两条，
  **linux 那一支是空的** —— 也就是说 `__GNUC__` 在 linux 上一条都不定
* **glibc 的 `__REDIRECT` 一族**：`#if !defined _WIN32`，所以 linux 与 osx 有、PE 没有

还量出两条原来不知道的：

* **`__arm64__` 只有 Mach-O 才有** —— `arm64-gen.c:55-61` 那张
  `target_machine_defs` 里它压在 `#if defined(TCC_TARGET_MACHO)` 里面。
  于是「CPU 那三条」这个说法本身是错的：arm64-linux 与 arm64-win32 只有两条。
* **`__CHAR_UNSIGNED__` 只有 arm64-linux** —— `arm64-gen.c:41` 那道
  `#if !defined(TCC_TARGET_MACHO) && !defined(TCC_TARGET_PE)` 给出
  `CHAR_IS_UNSIGNED`，`libtcc.c:889` 于是把 `s1->char_is_unsigned` 拨上，
  `tccpp.c:3609` 印出这个宏。这就是 arm64-win32 比 arm64-linux 少的那一条。

### 改法：静态表改成顺着攒

tcc 那边 `tcc_predefs`（`tccpp.c:3585`）是一串顺着写的 `putdef`，不是一张表 ——
`__TCC_PP__`、`__CHAR_UNSIGNED__`、`__leading_underscore` 都在中间那一串
`if (…) putdef(…)` 里，位置固定在 OS 那一段之后、`__SIZEOF_POINTER__` 之前。
所以 `predefs(arch, os, forPP)` 也照这个形状攒，几张小表按 OS 取：
`OS_DEFS`、`MODEL`、`WCHAR_DEFS`、`OS_EXTRA`、`REDIRECT_DEFS`。

`PP_ONLY_AFTER = '__unix'` 那个按名字找位置的做法**没了** —— win32 上没有 `__unix`
这条，按名字就插不进去。改成按位置（OS 那一段之后），`installPredefs` 于是只剩
一个循环。`CPU_DEFS` 的每一行多一格可选的第三项 =「只有这个 OS 才有」，`__arm64__`
就住在那儿。

`Cpp` 多收一格 `host.os`（默认 `osx`），`cli.js` 的 `cpp` 那一路认 `--arch`/`--os`
（与 `c-obj` 同名同值）。

### 门

新门 `tests/c/predefs.js` **12/0**：六个 64 位目标 × 两组探针（`-dM` 的整张表、
`-dD` 带源码里 `#define`/`#undef` 的那一路），逐行比，头一处不同就印出行号与两边。
比的是逐行不是集合 —— `-dD`/`-dM` 印的是定义**经过**的次序（第一百〇八片），
差一格就得报出来。

回归都绿：`native` 227/0、`run` 207/0/1、`native-gen` 83/0、`selfobj` 25/0、
`tcc-link` 83/0、`selfpp` 29/0/1、`dm-order` 7/0、`arch-defs` 2/0、`selfsrc` 13/0、
`selfcross` 12/0、`rela-text` 22/0/1、`sym-order` 18/0、`str-rodata` 69/0/1、
`rodata-sec` 27/0、`sym-size` 6/0、`rela-order` 6/0、`eh-frame-x64` 8/0、
`pdata-x64` 11/0。`tcc-obj` 的「容器相同」还是 21（这一片不碰字节）。

### 这一片解开的与没解开的

解开的是**根**：`L.N` 的起点（`__builtin_va_list` 在每个目标上占几个匿名符号号）
与 win32 的 `wchar_t` 两字节，从前都记着「压在 `tccdefs.js` 照 macho 写死那笔欠账
后面」—— 现在那笔还了。

没解开的还有两笔，都是「宏对了、语言还没跟着走」：

* **`__CHAR_UNSIGNED__` 同时是语言**：tcc 那边这一条一拨，`char` 就是无符号的。
  我们现在只把宏摆对，`char` 的符号性还照 signed 走 —— arm64-linux 那条腿上的一笔。
* **`wchar_t` 的宽度**：win32 上 `__WCHAR_TYPE__` 现在是 `unsigned short` 了，
  可我们的宽串常量还按 4 字节铺（`str-rodata` 那个 `not yet`）。宏与字节要一起改。
* **头文件那一半**：预定义对了不等于头对了 —— `src/include/` 那几份还是照
  macOS 写的，`--os linux` 编一份 `#include <stdio.h>` 仍然走的是本机那一支。

<!-- 第九刀第一百二十九片-END -->

## 落地：第九刀第一百三十片

**win32 的 `wchar_t` 是两字节。**

上一片把 `__WCHAR_TYPE__` 摆对了（win32 `unsigned short`、linux `int`+`unsigned int`、
osx `int`+`int`），可宏对了不等于语言跟着走 —— 我们的宽串一律四字节铺。这一片把
那笔补上。

### tcc 的形状：一件事，两处写

* `tcc.h:447-451` 的 `nwchar_t`：PE 上 `unsigned short`，别处 `int` —— 定的是
  **一格几个字节**（`cstr_wccat` 往它里头赋值，`sizeof(nwchar_t)` 到处在用）
* `tccgen.c:5667-5672`（宽串）与 `:5614-5618`（`L'x'`）那两道
  `#ifdef TCC_TARGET_PE`：定的是**类型** —— `VT_SHORT|VT_UNSIGNED` 还是 `VT_INT`

两处其实是同一件事，所以我们这边只留一格状态，与 `LDOUBLE_SIZE` 同一个办法
（ctype.js，`lowerC`/`lowerCNative` 每次进来拨一次）：

```js
let WCHAR_IS_SHORT = false;
export function wcharType() { return WCHAR_IS_SHORT ? TY_USHORT : TY_INT; }
export function wcharSize() { return WCHAR_IS_SHORT ? 2 : 4; }
export function isWcharType(ty) { … }
export function setWcharTarget(os) { WCHAR_IS_SHORT = os === 'win32'; }
```

`isWcharType` 是第三个出口，也是最容易漏的那个：`wchar_t s[] = L"ab"` 到底走
「字符串铺开」还是「把指针赋给整数」，tcc 看的就是元素类型对不对得上
（`tccgen.c:8064-8070` 那个 if）。原来五处写的是 `btype(ty.ref.t) === VT_INT`。

### 量出来的

```
win32 : sizeof(L"ab") = 6   sizeof(L'x') = 2   sizeof(L"ab"[0]) = 2
别的  : sizeof(L"ab") = 12  sizeof(L'x') = 4   sizeof(L"ab"[0]) = 4
```

`sizeof(L'x')` 那一格是个惊喜 —— **`L'x'` 在 PE 上不是 int**，是
`unsigned short`（`tccgen.c:5615-5617` 那个 `goto push_tokc` 跳过了 `TOK_CINT`
那一支）。顺带 tccpp 里 `L'…'` 的收口也换了：非 PE 上 32 位有符号，win32 上
16 位无符号。

`L'\xffff'` **没进探针**：量过，tcc 自己在静态初始化式里就报
`constant expression expected`（linux 与 win32 都报），那不是这一格的事。

### 门

新门 `tests/c/wchar.js` **27/0/3**：三个目标 × 五个探针（`sizeof` 那三个数、
从初值定长的数组、定长数组、相邻宽串拼起来、指向宽串的指针），比 `.data`
与只读节的字节，加上落在它们里头的符号的落点与大小。探针里元素类型写
`__WCHAR_TYPE__` —— 上一片刚接对的预定义，于是一份源码在三个目标上各说各的类型。

`str-rodata` 那个 `not yet`（win32 的宽串）消掉了，69/0/1 变 **72/0**。

回归都绿：`native` 227/0、`run` 207/0/1、`native-gen` 83/0、`selfobj` 25/0、
`tcc-link` 83/0、`predefs` 12/0、`rela-text` 22/0/1、`sym-order` 18/0、
`rodata-sec` 27/0、`sym-size` 6/0、`rela-order` 6/0、`eh-frame-x64` 8/0、
`pdata-x64` 11/0、`dm-order` 7/0、`selfpp` 29/0/1、`f80` 5/0、`ldouble-x64` 10/0、
`x64/from-mir` 90/0、`arm64/from-mir` 88/0。`tcc-obj` 的「容器相同」还是 21。

### 量：`.data` 也该按声明的次序摆（下一片的尺子）

新门那三个 `not yet` 是**同一笔**，而且与 `wchar_t` 无关 —— 是这个探针顺带量出来的：

```c
char *n = "z";
__WCHAR_TYPE__ *p = L"ab";
int m = sizeof(*p);
```

```
tcc : n@0+8 p@8+8 m@16+4
ours: p@0+8 n@8+8 m@16+4
```

`sizeof(*p)` 借表达式那一路解析（在一个用完就丢的函数里，见 `sizeof`/`&` 那两格），
于是 `p` 在 `n` 之前就领到了 MIR 的全局号；而两个后端铺 `.data` 的字节是按
**全局号**走的（`for (let gi = 0; gi < mod.globals.length; gi++)`），不是按声明的次序。
把那一行换成 `int m = 4;` 就对得上 —— 也就是说这一笔平时藏着，得有「先被提到、
后被定义」的东西才露出来。

第一百二十五片给只读节立过那根轴（`globalSeq`，`mir/rodata.js` 按它排落点），
`.data` 还没接上。所以下一片就是把 `.data` 也交给一个按 `globalSeq` 排的规划器 ——
`planRodata` 那个形状原样再来一遍（或者干脆合成一个「按声明次序摆一节」的零件，
只读节与 `.data` 各调一次）。`.bss` 同理要看。

<!-- 第九刀第一百三十片-END -->

## 落地：第九刀第一百三十一片

**`.data` 也按声明的次序摆。**

上一片那三个 `not yet` 是同一笔，尺子已经量在那儿了：

```c
char *n = "z";   __WCHAR_TYPE__ *p = L"ab";   int m = sizeof(*p);
```

```
tcc : n@0+8 p@8+8 m@16+4
ours: p@0+8 n@8+8 m@16+4
```

`sizeof(*p)` 借表达式那一路解析（在一个用完就丢的函数里，与 `&` 那一格同一个办法），
于是 `p` 在 `n` 之前就领到了 MIR 的**全局号**；而两个后端铺 `.data` 是照全局号
一块接一块推的（`for (let gi = 0; …) { while (dataBytes.length % al) …; base = dataBytes.length; }`）。
平时看不出差别 —— 全局号一般就是声明的次序；要有「先被提到、后被定义」的东西才露出来。

### 改法：只读节那个规划器再用一次

第一百二十五片给只读节立过那根轴（`globalSeq`，前端在 `allocGlobal` 领号）。这一片把
`mir/rodata.js` 里的排布抽成一个共用的 `layout(items)`，再加一个出口：

```js
export function planData(mod) { … 非只读、非外部的全局量 … return layout(items); }
```

两个后端于是对称了：`dataBytes` 从「一路 push」改成 `new Array(dataPlan.size).fill(0)`，
落点 `const base = (ro ? roPlan.gOff : dataPlan.gOff).get(gi)` —— 一句话，两段都只查不推。
对齐的空档由规划器留（原来是 `while (…% al) push(0)`）。

没有 `globalSeq` 的（手搭的 MIR、别的前端）照旧排在后面、次序不变，所以
`x64/from-mir` 90/0、`arm64/from-mir` 88/0 一条没动。

### 门

`wchar` 那门从 27/0/3 变 **30/0** —— 那三格就是这一笔。回归都绿：`native` 227/0、
`run` 207/0/1、`native-gen` 83/0、`selfobj` 25/0、`tcc-link` 83/0、`predefs` 12/0、
`str-rodata` 72/0、`rodata-sec` 27/0、`sym-order` 18/0、`sym-size` 6/0、
`rela-order` 6/0、`rela-text` 22/0/1、`eh-frame-x64` 8/0、`pdata-x64` 11/0、
`selfsrc` 13/0、`selfcross` 12/0、`dm-order` 7/0、`selfpp` 29/0/1、
`elf-roundtrip` 268、`elf-merge` 451、`macho-exe` 26、`elf-exe` 53、`elf-dyn` 53、
`macho-dylib` 107、`pe-content` 328、`pe-exe` 352。`tcc-obj` 的「容器相同」还是 21。

### 量：没有初值的全局量该进 `.bss`（下一片的尺子）

顺手想把 `sym-size` 那门的「全局量的落点也一个数不差」打开，结果它红了 —— 而红的
不是这一片，是**另一笔**。那份探针里有两块没有初值的：

```c
char tab[40];   struct P { int a; char b; } p;
```

量 x86_64-linux：

```
tcc  .data 44 字节  .data.ro 3  .bss 48    g@0 big@8 arr@16 | tab@0 p@40（在 .bss 里）
ours .data 92 字节  .data.ro 3  .bss 0     g@0 big@8 tab@16 p@56 arr@64（全在 .data）
```

也就是说 tcc 把「没有初值」的那些摆进 `.bss`（那一节不占文件字节，只占 `sh_size`），
我们全摆在 `.data` 里 —— 于是它们后面每一块的偏移都跟着差。我们的 `.bss` 节头是有的，
只是一直空着。

所以下一片：`planData` 分成两个游标（`.data` 与 `.bss`），判据是「这一块的字节是不是
全零、而且它是不是**试探性定义**」—— 得先照 tcc 那边量准（`tccgen.c` 里
`has_init` 与 `sec` 的那几支，别拿「字节碰巧全零」当判据，`int z = 0;` 也许照旧进
`.data`）。落点对上之后 `sym-size` 那门就能多称一格「全局量的落点」。

<!-- 第九刀第一百三十一片-END -->

## 量：`.bss` 的判据是「源码里有没有初始化式」（下一片的尺子）

上一片末尾那笔量细了。tcc 的判据在 `tccgen.c:8405-8438`，一串 `if`：

```c
if (is_const)        sec = rodata_section;    /* 剥掉指针数组那几层之后带 const */
else if (has_init)   sec = data_section;
else if (nocommon)   sec = bss_section;
else                 sec = common_section;    /* SHN_COMMON，st_value 是对齐要求 */
```

`nocommon` 在 `libtcc.c:881` 是**默认开着**的（`s->nocommon = 1`），所以最后那一支
走不到 —— 我们不必管 COMMON 符号。

关键是 `has_init` 是**源码里有没有那个 `=`**，不是「字节是不是全零」。拿
x86_64-linux 量这一份：

```c
int a;            int b = 0;        int c = 5;
static int d;     static int e = 0;
char f[10];       char g[10] = "";
const int h = 0;  const int i;
struct S { int x; } j;   int k[3] = {0, 0, 0};
int fn(void) { static int m; static int n = 0; … }
```

```
.bss (28, NOBITS)   a@0  d@4  f@8  j@20  m@24
.data (40)          b@0  c@4  e@8  g@12  k@24  n@36
.data.ro (8)        h@0  i@4
```

三条读得出来的规矩：

* **`int b = 0;` 进 `.data`** —— 字节全零也照进，因为它有初始化式。
  「按字节全零判」是错的判据，会把 `b` 摆错。
* **`const int i;` 进 `.data.ro`** —— `const` 那一支在 `has_init` **之前**，
  所以没有初始化式的 `const` 也不进 `.bss`。
* **两段各自一个游标，都按声明的次序**：`.bss` 是 a、d、f、j、m，`.data` 是
  b、c、e、g、k、n —— 也就是第一百二十五/一百三十一片那根 `globalSeq` 轴再分一次流，
  规划器多一个出口就够（`planBss`）。函数体里的 `static` 也在同一根轴上
  （`m` 排在 `j` 之后、`n` 排在 `k` 之后）。

我们现在全摆在 `.data` 里，`.bss` 的节头一直空着（`link/elf.js:474` 那一行
`sh_size` 写死 0）。所以下一片的活分三处：

1. 前端：MIR 上给每一块记「有没有初始化式」（`globalBss` 那样一格标注），
   判据从 C 前端来 —— **不能**在后端按字节猜
2. 规划器：`planData` 分成 `planData` 与 `planBss`，两个游标
3. 三个写出器：ELF 的 `.bss` 要真的带 `sh_size`（NOBITS，不占文件字节）、
   符号要能落在 4 号节；Mach-O 那边是 `__bss`（`S_ZEROFILL`，
   `macho_exe.js` 里链接那一头已经认它，写 `.o` 那一头还只有两节）；
   PE 那边 `.bss` 归 data 那一类（`pe_sections.js:117`）

第 3 步是这一片的大头 —— 三个写出器现在都只知道「代码 + 数据 + 只读数据」这三段。
顺带：静态局部量的**名字**也还差着（tcc 叫 `m`/`n`，我们叫 `fn.m.0`/`fn.n.1`），
那是另一笔。

<!-- 量：.bss 的判据-END -->

## 落地：第九刀第一百三十二片

上一片末尾那把尺子照着做完了：**没有初始化式的全局量进 `.bss`**。

### 判据只能从前端来

`tccgen.c:8405-8438` 那三步是**有次序**的：

```c
if (is_const)        sec = rodata_section;
else if (has_init)   sec = data_section;
else if (nocommon)   sec = bss_section;      /* nocommon 缺省 1（libtcc.c:881） */
else                 /* SHN_COMMON */;
```

关键那一条：`has_init` 是**源码里有没有那个 `=`**，不是「这一块的字节是不是全零」。
`int b = 0;` 与 `int a;` 出来的字节一模一样，前者在 `.data`、后者在 `.bss` ——
所以后端**没有**任何办法从字节上把这两种分开，这一格必须由 C 前端记下来。

而且次序要照着来：`const` 先问，于是 `const int i;`（没有初值）落的是**只读那一节**，
不是 `.bss`。

### 三处改动

1. **前端**：`decl` 里那个 `hasInit`（`this.tok === ASSIGN`）往登记上记一笔
   （`gv.hasInit = true`，块里的 `static`/`extern` 那两种是转手，标在 `e.gvar` 上）。
   同一个名字可以声明好几遍（试探性定义），所以只往上加不往下抹 ——
   `int a; int a = 1;` 是**有**初始化式的那一个。封盘那一步：
   `if (isRoType) markGlobalRo; else if (!hasInit) markGlobalBss;`
2. **规划器**：`mir/rodata.js` 里 `planData` 旁边多一个 `planBss`，两个各自独立的
   游标，都按声明的次序（`globalSeq` 那根轴）。函数体里的 `static` 也在同一根轴上。
3. **写出器**：两个后端的全局量循环从「只读 / 可写」两段变三段（`sect` 4 是 `.bss`），
   `.bss` 那一段**一个字节也不写**。ELF 那一头 `.bss` 终于带上真的 `sh_size`——
   `writeSections` 早就认 `size` 那一格（NOBITS 有大小、没字节），只是上一层没往下递。
   Mach-O 那一头这个写出器还只有 `__text`/`__data` 两节，所以 `foldRo` 顺手把 `sect: 4`
   也折进 `__data` 的尾巴（那一段本来全是零，占着文件里的零字节只是胖一点）——
   真正的 `__bss`（`S_ZEROFILL`）与 `__DATA,__const` 还是欠账。忘了递 `bssSize` 的
   症状是 SIGSEGV（符号指到 `__data` 之外），所以那儿明着骂一句。

链接那三头本来就都认 NOBITS 的输入节（`elf_merge.js:366`、`macho_exe.js:1155`、
`pe_sections.js:117`），所以第 3 步比预想的小 —— 大头只在写 `.o` 这一头。

### 顺带被尺子逮到的旧账：节自己的对齐

`tcc-link` 的 `55-attr-align` 一红就露出来了：`g7` 的地址低四位是 8，该是 0。

```c
struct a7 g7[2] __attribute__((aligned(16)));   /* 没有初值 -> .bss */
int g32 __attribute__((aligned(32))) = 9;       /* 有初值   -> .data */
```

量过 x86_64-linux：tcc 的 `.bss` `sh_addralign` 是 **16**、`.data` 是 **32**。
也就是每一节的对齐是「里头对齐要求最大的那一块」，下界 8 —— 我们三节一直写死 8
（`elf.js` 里 `dataAlign` 那一格还写着「ELF 用不上，tcc 的 `.data` 一律 8」，
那句话是错的，只是先前每个探针里最大的对齐正好都是 8，`.data` 从 0 起也就没露）。
`layout()` 顺手回一格 `al`，两个后端回 `secAlign: {data, rodata, bss}`。

### 门

`sym-size` 从 6/0 长到 **12/0**，四条：全局量的 `st_size`、**落点（哪一节、节里第几个
字节）**、`.data`/`.data.ro`（win32 `.rdata`）/`.bss` 三节的 `sh_size` 与 `sh_addralign`、
函数把 `.text` 铺满 —— 三个目标各四条，都与尺子一个数不差。探针里添了
`struct Q { int x; } wide[2] __attribute__((aligned(16)));` 专门顶对齐那一格。
上一片留的那句「落点这儿还不比」删掉了。

`tcc-link` 82/1 变 **83/0**；`native` 227/0（Mach-O 那一头的 `bssSize` 补齐之前它是
SIGSEGV）；其余照旧全绿，`tcc-obj` 还是 0 字节相同 / **21 容器相同** / 89 不同。

### 还差什么

静态局部量的**名字**（tcc 叫 `m`/`n`，我们叫 `fn.m.0`/`fn.n.1`）——`sym-size` 这门
是按名字对的，所以那些名字这一片还被跳过，落点没被称到。那是下一片。

<!-- 第九刀第一百三十二片-END -->

## 落地：第九刀第一百三十三片

上一片末尾留的那笔：**函数体里 `static` 的符号名**。量过 x86_64-linux：

```c
int f(void){ static int n = 1; static char b[4]; return n + b[0]; }
int g(void){ static int n = 2; static const char s[] = "hi"; return n + s[0]; }
```

```
tcc   .data:n@0/L  .bss:b@0/L  .data:n@4/L  .data.ro:s@0/L
ours  .data:f.n.0@0/L  .bss:f.b.1@0/L  .data:g.n.0@4/L  .data.ro:g.s.1@0/L
```

节与偏移早就对上了（上一片），差的只是名字：tcc 写的是**声明时那个名字**，而且
同一份 `.o` 里**两条局部符号都叫 `n`** —— 局部符号本来就不必唯一，链接器不拿它们
去解析引用。

### 「身份」与「名字」得分成两格

我们那点料（`f.n.0` = 函数名 + 这个函数里的第几条 static）不是随便加的：一遍过里
两个函数各有一个 `static int n;`，`gvars` 那张表要能把它们分开，`GADDR` 也要能指准。
所以身份不能扔。改法是把「身份」与「写进符号表的名字」拆成两格：

- 前端：`declareStaticLocal` 在登记上记一笔 `g.symName = name`（声明时那个名字），
  封盘那步 `mod.markGlobalSym(no, e.symName)`
- MIR：多一格标注 `globalSym`（不给就用 `globals[gi]` 自己）——与 `globalLocal`/
  `globalRo`/`globalBss` 同一种性质
- 两个后端：`dataSyms` 那条多一格 `sym`
- 两个写出器：`no`/`defNo`（重定位按它找符号）还是按 `name` 键，只有**往字符串表里
  塞的那一下**用 `sym ?? name`。一处一行

这一步顺带把「重定位按名字找符号」那条隐患挑明了：名字可以重，身份不能重，所以
两者不是一回事 —— 从前它们是同一格，只是还没有重名的东西出现过。

### 门

`sym-size` 的探针里添了两个同名的函数静态量（`f` 里 `static int n = 5;` 进 `.data`、
`q` 里 `static int n;` 进 `.bss`），比法从「按名字查一条」改成**按名字攒成多重集、
两边各自排序再比** —— 一个名字底下可以有两条。称到的全局量从 7 个长到 **10 个**
（那三个函数静态量从前是名字对不上被跳过的）。12/0 不变，但是称的东西多了三样。

其余全绿，`tcc-obj` 还是 0 字节相同 / **21 容器相同** / 89 不同 —— 那 89 份差在
代码字节上，与符号名无关。

<!-- 第九刀第一百三十三片-END -->

## 量：串常量的符号名是 `L.N`，N 是一根**匿名符号**的共用游标（下一片的尺子）

上一片把函数静态量的名字对上了，符号表里还剩一种名字不同：串常量。我们叫
`omni_str_<常量池下标>`，tcc 叫 `L.N`。量过三个目标（探针
`char *a = "x"; char *b = "yy";`，不带任何 `#include`）：

```
linux    .data.ro:L.3@0   .data.ro:L.4@2
osx      .data.ro:_L.1@0  .data.ro:_L.2@2
win32    .rdata:L.0@0     .rdata:L.1@2
```

名字的规矩在 `tccpp.c:624-626`：`v >= SYM_FIRST_ANOM` 的符号印成 `L.%u`，数是
`v - SYM_FIRST_ANOM`。而 `anon_sym` 这根游标（`tccgen.c:32`，`tccgen.c:404` 起手置成
`SYM_FIRST_ANOM`）被**三处**共用：

- `tccgen.c:1129` `get_sym_ref` —— 每一条指着某一节的静态符号（串常量、静态复合字面量）
- `tccgen.c:4490` —— 没名字的 `struct`/`union`/`enum` **标签**
- `tccgen.c:4675` —— 没名字的**成员**（嵌进去的匿名 struct/union，或者无名位域）

所以起手那个数不是玄学，是**这个目标的 `tccdefs.h` 里有几样匿名的东西**，一个一个数得出来
（`include/tccdefs.h:188-238`）：

- x86_64-linux：`typedef struct { unsigned gp_offset, fp_offset; union { … }; char *reg_save_area; } __builtin_va_list[1];`
  —— 外头那个匿名 struct 标签 1 个，里头那个匿名 `union` 既是标签又是成员，2 个 ——
  一共 **3**，于是第一条串是 `L.3` ✓
- arm64-osx：`typedef struct { void *__stack; } __builtin_va_list;` —— 1 个匿名标签，
  于是 `L.1` ✓
- x86_64-win32：`typedef char *__builtin_va_list;` —— 一样匿名的都没有，于是 `L.0` ✓

三个都对得上，所以这一格**不该写死**每个目标的起点：照 tcc 那样立一根共用游标，
起点自然从我们自己那份 `tccdefs.h` 里长出来。

所以下一片的活：

1. 前端：一根 `anonSym` 游标（从 0 起），三处 `++`——匿名的 struct/union/enum 标签、
   匿名的成员（含无名位域）、每一条领到符号的静态块（串常量与静态复合字面量）
2. MIR：常量池那边要一格「写进符号表的名字」（`strSym[ref]`，与第一百三十三片的
   `globalSym` 同一种性质）；`$cl$N` 那些匿名静态块也在同一根游标上，名字一样是 `L.N`
3. 两个后端把 `strSym` 传给 `dataSyms`，两个写出器已经认 `sym` 那一格（一百三十三片
   铺好了）—— 这一步是零改动

「匿名的成员」那一条也量准了（x86_64-win32，起点是 0，所以数就是号）：

```c
struct C { int x; };                              /* 有名字的标签   -> L.0，0 个号 */
struct A { int x; int :3; int y; };               /* 无名位域       -> L.1，1 个号 */
struct B { int x; struct { int u; }; int y; };     /* 匿名 struct 成员 -> L.2，2 个号 */
```

也就是：无名位域**一个**号（它只是成员，没有标签），匿名 struct/union 成员**两个**号
（`tccgen.c:4490` 那个标签一个、`:4675` 那个成员一个）—— 与上头 linux 那个 3 对得上。

### 一个必须先想清楚的坑：函数体解析两遍

我们的函数体走两遍（`runBody`，偏离 4），所以「在解析到的那一刻 `++`」这条会**数两遍**。
既有的几根游标都各有一把去重的钥匙躲开了这件事（`strRefs` 按「函数名 + 这个函数里的
第几条」认、`declareStaticLocal` 按同样的料认、`allocGlobal` 按 `addr < 0` 认），可匿名
struct 标签没有这种天然的钥匙。

现成的那一格就够：`this.pass1`。它在文件作用域上是 `false`、只在函数体第一遍里是 `true`，
而两遍是**紧挨着**跑的（第一遍完立刻第二遍，然后才轮到下一条顶层声明）—— 所以
「只在 `!this.pass1` 的时候 `++`」数出来正好是**源码次序**。

串常量那一头要跟着改成同一条规矩：现在 `markStrSeq` 是在第一遍里就落的（`strRefs`
那把钥匙让第二遍认回同一个 `ref`），要是匿名标签在第二遍数、串在第一遍数，两者就交错
错了。所以 `strSym[ref]` 也得在 `!this.pass1` 的时候才给 —— 第二遍会拿同一把钥匙走到
同一个 `ref` 上，那时候给正好。

<!-- 量：L.N 的游标-END -->

## 落地：第九刀第一百三十四片

上一片的尺子照着做完了：**串常量在符号表里的名字是 `L.N`**，三个目标都与 tcc 一字不差。

### 一根游标，三处 `++`

C 前端多一格 `this.anonSym`，照 tcc 的 `anon_sym` 在三处推：

- `tagOf` 里 `name === null`（没名字的 struct/union/enum 标签，`tccgen.c:4490`）
- `structDecl` 里匿名 struct/union 成员（`tccgen.c:4675`）——它连着上面那一处，
  所以一个匿名 struct 成员吃**两个**号
- 同一处的无名位域（`int : 3;`）——它没有标签，只吃**一个**号
- `strConst` / `wstrConst`：每一条串常量领一个，名字就是 `L.<号>`

三处都带 `if (!this.pass1)`。这是这一片唯一真的坑：函数体走两遍，而两遍紧挨着跑
（第一遍完立刻第二遍，才轮到下一条顶层声明），所以「只在第二遍数」数出来正好是源码
次序。串常量那一头本来是在第一遍就落 `markStrSeq` 的（`strRefs` 那把钥匙让第二遍认回
同一个 `ref`），这一片把「给名字」这一步挪到 `!pass1`——两个游标必须在同一趟里推，
不然就交错错了。

MIR 那边多一格 `strSym[ref]`（与上一片的 `globalSym` 同一种性质：身份归下标、名字归
这一格），两个后端把它填进 `dataSyms` 的 `sym`。写出器**零改动**——上一片已经把
「重定位按身份找、字符串表放名字」那一层铺好了。

### 起点那三个数，与它背后的一笔账

第一条串是几号，取决于**这个目标的 `__builtin_va_list` 里有几样匿名的东西**：

- x86_64 非 win32：`struct { …; union { … }; … } [1]` —— 匿名标签 1 + 匿名 union 2 = **3**
- arm64 osx/linux：`struct { … }` —— **1**
- win32（两种架构）：`char *` —— **0**

tcc 那份是真的在 `tccdefs.h` 里解析出来的，号自然就花掉了。我们那份是 CGen 里写死的
`void *` typedef（`tccgen.js` 里那条，理由在它头上的注释里：我们的变参区是一串 8 字节
格子，一个指针足够走完），一个匿名的都没有 —— 所以在装那条 typedef 的地方按上面那个
个数把游标推过去。

这**不是**一张「每个目标第一条串是几号」的写死表，是「我们这条 typedef 与 tcc 那条形态
不同」这笔旧账的另一面：等哪天 `__builtin_va_list` 真的按目标解析出来，那三行就该删掉，
号会自己长出来。写在同一处、注释里说清楚，是为了以后不会有人把它当成一个魔数。

### 门

`sym-size` 的探针里添了 `char *lit = "hi";`——`L.N` 于是自动进了那两条按名字比的检查
（tcc 有的名字我们没有**是差错**）。称到的全局量从 10 个长到 **12 个**，12/0 不变。
三个目标上串常量的名字、落点、`st_size` 全部一致。

其余全绿，`tcc-obj` 还是 0 字节相同 / **21 容器相同** / 89 不同。

### 还差什么

静态复合字面量那些块（我们叫 `$cl$N`）在 tcc 那边也是 `get_sym_ref`、也是 `L.N` ——
下一片。

<!-- 第九刀第一百三十四片-END -->

## 落地：第九刀第一百三十五片

上一片末尾留的那笔：**文件作用域的静态复合字面量**（我们叫 `$cl$N`）。tcc 那边它与串常量
走同一条路（`get_sym_ref`），所以名字也是 `L.N`、也吃同一根游标的号。量过
（x86_64-win32，探针 `int *p = (int[]){1,2,3}; char *s = "x";`）：

```
tcc   .data:L.0@8+12  .rdata:L.1@0+2  .data:p@0+8  .data:s@24+8
ours  .rdata:L.0@0+2  .data:$cl$0@16  .data:p@0+8  .data:s@8+8
```

两处不同，都在一行里：

1. **名字**：那一块该是 `L.0`（它在源码里比那条串早），于是后面那条串是 `L.1` ——
   我们从前不给它号，串就顶上去成了 `L.0`
2. **落点**：tcc 把它摆在 `p` 与 `s` 中间（`p`@0、它@8、`s`@24）—— 它是在解析 `p` 的
   初值那一刻领的字节。我们从前**不给它 `dseq`**，于是 `layout()` 把没号的排在所有
   有号的后面（`$cl$0`@16、`s`@8）

上一片担心的那个两遍问题这儿不存在：这一路有 `if (this.scopes.length <= 1)` 的门 ——
只有文件作用域走它，块里的复合字面量落在帧上，压根不领符号。

所以这一片就是那条 `anonStatics.push` 上多两格（`dseq: e.dseq`、
`sym: \`L.${anonSym++}\``）与封盘那步多两句 `markGlobalSeq` / `markGlobalSym`。
`$cl$N` 那个名字留着当**身份**（重定位按它找），与上两片同一条。

改完那个探针的数据段与 tcc 一字不差 —— 三个符号的名字、偏移、`st_size` 全同，只有
`.text` 长短不同（44 对 188，我们的代码还长）。整套门全绿，`tcc-obj` 还是
0 字节相同 / **21 容器相同** / 89 不同。

<!-- 第九刀第一百三十五片-END -->

## 量：arm64-linux 上 `char` 是无符号的（下一片的尺子）

第一百二十九片把 `__CHAR_UNSIGNED__` 这个宏摆对了，可那一格在 tcc 那边**同时是一条语言
规矩**：`char` 真的变成无符号的。量过（探针不带任何 `#include`）：

```c
int b   = (int)(char)200;
int sgn = ((char)-1) < 0;
int mx  = (int)(char)127 + (int)(char)128;
```

```
arm64-tcc（linux）  b=200  sgn=0  mx=255      <- char 是无符号的
arm64-osx-tcc       b=-56  sgn=1  mx=-1
arm64-win32-tcc     b=-56  sgn=1  mx=-1
x86_64-tcc（linux） b=-56  sgn=1  mx=-1
我们（arm64-linux） b=-56  sgn=1  mx=-1      <- 错在这儿
```

**只有 arm64-linux 一个目标**：`arm64-gen.c:41` 那个
`#if !defined(TCC_TARGET_MACHO) && !defined(TCC_TARGET_PE)` 开出 `CHAR_IS_UNSIGNED`，
`libtcc.c:889` 把它变成 `s1->char_is_unsigned`，然后 tcc 在定基本类型那一步照它给
`VT_UNSIGNED`——**没有**写 `signed`/`unsigned` 的那种 `char` 才受影响
（`VT_DEFSIGN` 那一位就是「显式写过」的意思，我们这边同名同义）。

所以下一片的活：

1. `ctype.js` 里再立一格目标旋钮，与 `LDOUBLE_SIZE`/`WCHAR_IS_SHORT` 同一个办法
   （`lowerC`/`lowerCNative` 进门时钉一次）：`CHAR_IS_UNSIGNED = arch === 'arm64' && os === 'linux'`
2. 落点是**定基本类型那一步**（`parseBtype` 里 `VT_BYTE` 那一支）：没有 `VT_DEFSIGN`
   就补 `VT_UNSIGNED`。`TY_CHAR` 那个常量不能就地改 —— 它被一堆地方 import 着，而且
   串字面量的元素类型、`char *` 那几个内建也用它，得先一处一处看清哪些该跟着变
3. 门：三个目标各量上面那三个数（`sgn`/`b`/`mx`），期望值从尺子读，不写死

<!-- 量：arm64-linux 的 char-END -->

## 落地：第九刀第一百三十六片

上一片的尺子照着做完了：**arm64-linux 上光秃秃的 `char` 是无符号的**。

改动一共三处，都很小 —— 因为这件事在 tcc 那边也只有一个落点：

- `ctype.js` 多一格模块状态 `CHAR_IS_UNSIGNED` 与 `charIsUnsigned()`/`setCharTarget(arch, os)`，
  与 `LDOUBLE_SIZE`/`WCHAR_IS_SHORT` 同一个办法（进门钉一次）
- `parseBtype` 收尾那三行 `sign` 判断后面多一支：`else if (t === VT_BYTE && charIsUnsigned())`
  —— **只有没写 `signed`/`unsigned` 的那种才受影响**（`VT_DEFSIGN` 那一位就是「写过」），
  tcc 也是在定基本类型这一步补的
- `lowerC`（线性内存那条腿，只有 arm64-osx 那一套规矩）与 `lowerCNative` 各拨一次

`TY_CHAR` 那个常量**没动** —— 它被一堆地方 import 着，而且串字面量的元素类型也用它。
不动是对的：tcc 那边 `char_is_unsigned` 也只作用在「解析 `char` 这个关键字」那一步，
串字面量的元素类型是另一回事。

### 门

新的一门 `tests/c/char-sign.js`，**六个 64 位目标**各一条，6/0。探针把答案算成五个 `int`
全局量摆进 `.data`，两边各编一个 `.o`、把那一节的字节读回来比 —— 期望值从尺子读，
不写死「arm64-linux 上该是 200」这种数。里头有两条**对照**（`(signed char)200` 与
`(unsigned char)200`）：显式写过符号的三个目标上都该是同一个数，用来证明这一片没有
把符号性整个拨歪。还有一条元检查：六个目标里**至少**要量到一个「`char` 是无符号的」，
不然这门比的是空气。

其余全绿，`tcc-obj` 还是 0 字节相同 / **21 容器相同** / 89 不同。

<!-- 第九刀第一百三十六片-END -->


## 量：函数的地址在 arm64 上也过 GOT（把上一节那把尺子量全）

上面那节量的是**数据**（`g`、`static const char s[]`）。接着量函数 —— 因为「取地址」这件事
在后端是三个落点（串常量、函数、全局量），只量了一个就接，另两个是猜。arm64-osx 与
arm64-linux 同一份探针：

```c
int g = 5;
static const char s[] = "ab";
static int helper(int x) { return x + 1; }
extern int outer(int);
int main(void) {
  int (*p)(int) = helper;
  int (*q)(int) = outer;
  return g + s[0] + p(1) + q(2) + helper(3);
}
```

`.rela.text`（两个目标一字不差，linux 那边只多 `.rela.eh_frame`）：

```
@88  type311 sym=helper  add=0  90000000   adrp x0, :got:helper
@92  type312 sym=helper  add=0  f9400000   ldr  x0, [x0, :got_lo12:helper]
@100 type311 sym=outer   add=0  90000000   同一对
@104 type312 sym=outer   add=0  f9400000
@112 type311 sym=s       add=0  9000001e
@116 type312 sym=s       add=0  f94003de
@124 type311 sym=g       add=0  9000001e
@128 type312 sym=g       add=0  f94003de
@196 type283 sym=helper  add=0  94000000   bl helper —— 直接调用还是 bl
```

三条新事实：

1. **函数的地址也过 GOT**，连**同一个文件里的 `static` 函数**（`helper`）也是 —— 也就是说
   「局部/外部」这个分岔在尺子那边根本不存在，取地址就是那一对。
2. **直接调用不过 GOT**：`helper(3)` 还是一条 `bl` + `283`（`R_AARCH64_CALL26`）。
   「取地址」与「调用」是两码事，这一格分得很清楚。
3. 加数**一律 0**。GOT 那一格里放的是符号的地址，`sym+8` 那种写法在 GOT 上没有意义。

还量了另一头：**ld64 收不收「GOT 指向局部符号」**。这一问必须问，因为 `native` 那条腿是
clang 链的，而 clang 自己从不为局部符号发 GOT 重定位。手写一份 `.s`：

```asm
_main:
	adrp x0, _s@GOTPAGE
	ldr  x0, [x0, _s@GOTPAGEOFF]
	ldrb w0, [x0]
	ret
	.section __DATA,__data
_s:	.byte 42
```

`_s` 没有 `.globl`。`objdump -r` 看进 `.o` 的是真的 `ARM64_RELOC_GOT_LOAD_PAGE21` +
`GOT_LOAD_PAGEOFF12`（汇编器**没有**悄悄降级成 `PAGE21`/`PAGEOFF12`），`clang` 链完跑得动。
所以两条腿都收得下。

<!-- 量：arm64 函数地址也过 GOT-END -->

## 落地：第九刀第一百三十七片

**arm64 上取符号地址一律过 GOT。** 上面两节的尺子照着做完。

改动一共三处，都在一个咽喉上：

- `arm64/from_mir.js` 的 `symAddr(reg, sym)` 从 `adrp` + `add`（`275`/`277`）改成
  `adrp @GOTPAGE` + `ldr @GOTPAGEOFF`（`311`/`312`）。三个落点（串常量、`FADDR`、
  `globalAddr`）都从它走，所以**只改这一处**。
- `symAddrGot` 删掉，`globalAddr` 里「自家的直接算、外部的过 GOT」那道岔跟着删 ——
  那道岔本身是个假设（第三十一片上 `__stdoutp` 挡回来时立的），尺子那边没有它。
- `link/link.js`（第十一片那个 `ld -r` 式的并合器）的读入表多认 `5`/`6` 两号，
  与 `PAGE21` 同一类待遇：填不了，原样转出去。不加这两号它会当场骂
  「还不认重定位类型 5」—— 那个报错是对的，它只是还没被教过。

**没动**的两处，值得写下来：

- 我们自己那两个出可执行文件的链接器（`elf_exe.js`/`macho_exe.js`）**本来就会**：
  `311`/`312` 在两边的 `GOTPLT` 表里都是 `ALWAYS_GOTPLT`，局部符号那一支走
  `R_RELATIVE` + 加数（`fill_local_got_entries`）。所以「先从链接器起手」这条规矩
  这一次没有额外的活 —— 前几片已经把它铺好了。
- `PAGE21`/`PAGEOFF12` 那两号**留着**：`asm.js` 里那三条（`adrpSym`/`addSymOff`/
  `ldrSymOff`）现在没有调用者，但两个链接器都还要认这两号（别人写的 `.o` 会有）。

### 门

- `tests/c/rela-text.js` 从 22/0/**1 not yet** 变成 **24/0/0** —— 那个 `not yet`
  正是这一格（「arm64 上串常量的地址是 adrp+ldr，我们还发 adrp+add」）。三条重定位
  现在类型、符号、加数、落点上的位移**逐条**对得上。
- `tests/arm64/link.js` 里两条写着旧形状的断言改成新的（`GOT_PAGE21`/`GOT_PAGEOFF12`）。
  这门原本 17/4，改完还是 17/4 —— 那 4 条是先前就红的（往返字节、`bl` 那两条），
  与这一片无关：改前改后各跑一遍对过。它末尾那 5 条**真跑**（并出来的 `.o` 交给
  clang 链、跑、对数）全绿，这是「过 GOT 这一对算得对」最硬的一条证据。
- 其余全绿：`native` 227/0、`native-gen` 83/0、`tcc-link` 83/0、`selfobj` 25/0、
  `selfsrc` 13/0、`selfcross` 12/0、`arm64/from-mir` 88/0、`tests/run.js` 96/0。
  `tcc-obj` 还是 0 字节相同 / **21 容器相同** / 89 不同 —— 这一片改的是指令与重定位，
  离「整份字节相同」还差别的账。

顺带解掉的一笔：第一百二十八片留下的第 4 类桩（取过地址的外部函数还留一个转发桩）
现在**没有技术理由**了 —— 过 GOT 的地址天生够得着未定义符号。桩本身还在前端那一头，
拆它是另一片。

<!-- 第九刀第一百三十七片-END -->

## 落地：第九刀第一百三十八片

**两条 link 门那 4 条红收掉了。** 上一片明写「那 4 条是先前就红的，与这一片无关」——
现在去查它们，量出来是**两件不同的事**：一件是实现真的缺一格，一件是门的期望值过期了。

### 一、往返掉字节：`readObject` 少读了 `local` 与 `weak`

`link/link.js` 的 `readObject` 读符号时只取 `name`/`off`/`sect`，把 `n_type` 的
`N_EXT` 位与 `n_desc` 的 `N_WEAK_DEF` 位**丢了**。于是「读回来再写出去」时，
一个本该是局部的串常量符号（`omni_str_1`）被当成外部的写回去，差的是 4 个字节：

- `LC_DYSYMTAB` 的 `nlocalsym` 1→0、`iextdefsym` 1→0、`nextdefsym` 3→4
- 那条符号自己的 `n_type` `0x0e`→`0x0f`

这不是装饰位。`local` 决定符号进不进 `LC_DYSYMTAB` 的第一段 —— 串常量、`static`
的函数、外部函数的转发桩全靠它（第九十二片），当外部符号的话两个 `.o` 一链就是
`duplicate symbol`。修：读回 `local`/`weak`，形状与 `writeObject` 的入参对齐
（只在真是那一格时才带上那个键）。

**这一条红对了** —— 往返那条门的全部意义就是「写出器与读入器互为对账」，
它红了一阵，指的是读入器。

### 二、`bl` 那两条：门的期望值过期了

`甲：内部调用不留重定位` 与 `并合：跨文件的 bl 当场填掉了一笔` 说的是同一件事的两头。
第一百二十七片起，**模块内的直接调用也走符号**（`from_mir.js:490-494` 那段注释写着
量过 tcc：哪怕被调的就在同一个 `.o` 里、哪怕它是局部符号，`.rela.text` 里也有那一条）。
实现照尺子改了，门没跟上。

改成：内部调用**也留**一笔 `BRANCH26`；并合时填掉的是**两笔**（甲自己那笔 + 乙跨文件那笔）。
x64 那一份是同一条（`BRANCH`），一起改。

### 门

- `tests/arm64/link.js` **21/0**（原 17/4），`tests/x64/link.js` **21/0**（原 19/2）。
  两门末尾那几条「真跑」（并出来的 `.o` 交给 clang 链、跑、对数）照旧绿。
- `tests/all.js` 全跑一遍：14/20 组绿，红的 6 组（`js-roundtrip`、`js-exec`、`cabi`、
  `mir`、`incr`、`bootstrap`）**与这一片无关** —— 把 `link.js` 那处改动 stash 掉再跑
  `cabi`，一字不差地红在同一处。它们是自编译那三处重名与 cabi 那几笔旧债。

<!-- 第九刀第一百三十八片-END -->

## 落地：第九刀第一百三十九片

**`-B` 在 `-c` 那条路上整个丢了。** 本来是去收一笔小账（第一百三十七片记的
「`src/include` 还赖在搜索序尾巴上」），一查发现底下压着一件大的。

### 量出来的

```
$ node src/core/cli.js cpp  /tmp/isys/m.c -isystem /tmp/isys/inc   # -E 那条路
# 1 "/tmp/isys/inc/only.h" 1
int main(void){return 42;}
$ node src/core/cli.js c mir /tmp/isys/m.c -isystem /tmp/isys/inc   # 编译那条路
/tmp/isys/m.c:1: error: include file 'only.h' not found
```

`cli.js` 里 `cppText` 收一个 `sysIncs` 参数（`c cpp` 那一路递 `sysIncDirs(rest)`），
可 `cMir`/`cObj` **没有**这个参数 —— 它们的 `sysIncludeDirs` 是写死的 `cSysInclude()`，
只认 `-I`。而 `omni c tcc` 把 `-B DIR` 翻成 `-isystem DIR/include`，
于是 `-B` 在 `-c`/`-run` 上**一格都没落下**。

`-B` 正是十几处门给尺子指 tinycc 源码树用的那一格。它们没红，因为
`tests/c/run.js` 那一组只称 `-E`；而 `-c` 那些门比的是我们自己两次运行的字节，
两边都少了同一个目录，于是一致。**「同一串 argv 喂两边」还不够 —— 那串 argv
里的每一格都得有人称它到没到。**

### 改的三处

- `cMir(path, incs, defs, args, sysIncs)` 与 `cObj(…, sysIncs)` 多收一格，
  三个调用点递 `sysIncDirs(flags)`。于是 `-isystem`/`-nostdinc` 在编译那条路上
  与 `-E` 那条路**同一套**。
- `cSysInclude(libDir)` 收一个可选的目录：给了就**换掉**自带那一份
  （`libDir/include`），SDK 那一段照留 —— 那正是 tcc 的形状（`{B}/include`
  就是自带那一份的位置，`CONFIG_TCC_SYSINCLUDEPATHS` 不受 `-B` 影响）。
  `sysIncDirs` 认一格新开关 `--tcc-lib-dir DIR` 来递它。
- `cmd-tcc.js`：`-B DIR` 递 `--tcc-lib-dir DIR`，不再是 `-isystem DIR/include`。
  这**同时**收掉第一百三十七片那笔小账 —— `src/include` 不再赖在尾巴上。

### 门

新的一门 `tests/c/inc-path.js`（**4/0**），四条，两边喂同一串 argv：

- `-isystem` 在 `-run`（编译并跑）上生效 —— 退出码与 stdout 都与尺子相同
- `-I` 在 `-run` 上生效（**对照**：它一直是通的，所以问题在「系统头」这一格）
- `-B DIR` 在 `-c` 上生效（`{B}/include` 里的头找得到）
- 一个头目录都不给，**两边都得找不到** —— 没有这一条，前三条可能只是「我们到处乱找」

把 `cli.js` 与 `cmd-tcc.js` 那两处改动 `git stash` 掉再跑这一门：**2/2 红**，
红在头两条对应的那两格上。这就是它该有的样子。

其余：`tests/cli/tree.js` 里那条写着旧形状的断言改成新的（**41/0**）。
`tests/c/run.js` 207/0/1 skip、`rela-text` 24/0/0、`native-gen` 83/0、
`selfobj` 25/0、`selfsrc` 13/0、`tcc-obj` 照旧 0 字节相同 / 21 容器相同 / 89 不同。

<!-- 第九刀第一百三十九片-END -->





















































