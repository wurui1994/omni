# ADR-0031：`sx` 的承载力模型（语言与方言之间的契约）

## 原则（这一条先于所有细节）

**`sx` 首要的是承载力，不是简洁。** 一门方言要接得住 C / C++ / Rust / Zig / jancy / GLSL 这一族
native 语言，就得把它们**共识里已有的东西**先摆齐；简化是"量过、确认真的没人用得上"之后才做的
事，不是设计的起点。

反面的证据就在眼前：今天 `sx` 只有五格标量类型（`int` / `real` / `bool` / `string` / `void`，
`src/core/sexpr/lower.js:64`），`int` 是一格 64 位有符号机器字。后果不是"方言干净"，是**每个前端
自己写一遍 C 的整数语义**：

| 前端替方言做的那一段 | 在哪儿 | 方言缺的那一格 |
| --- | --- | --- |
| 每个算子后掩一次、落进一格再转一次 | `src/lang/jnc/int-table.js` 整份 + 每处 `withBits` | **带宽度与符号性的整数** |
| 结构体逐字段抄、数组逐格抄 | `member-table.js` 的 `copyValLines` | **聚合体按值拷贝** |
| `new C` / printf 中间量 / errorcode 抬成 `$newoN` / `$fN` / `$eN` | `emit-ctx.js` 三处 | **表达式里装得下语句**（块表达式） |
| 属性读写各拼一次调用 | `lvalue-table.js` 的 `SHAPE_ACCESS.prop` | **取/存成对的位置** |
| 动态类型用 `$tag` 整数 + 一串 `if (tag == N)` | `lower.js` 的 `tags` + 旧降级的 `dispatch` | **虚派发 / 字段里装得下函数值**（ADR-0028） |
| `%8.3f` 用 `srep` / `ssub` / `sfind` 拼 | `fmt-table.js` 的 `padTo` / `precInt` | **格式化** |
| `switch` 摊成一圈 while + 一串比较 | `stmt-table.js` 的 `switchLines` | **`switch`（跳表）与 `match`（解构）** |
| 类型名、字段名、`(pfield …)`、`(expr …)` 全是字符串模板 | 所有 `emit-*.js`（191 处） | **契约**（构造器 + 校验，见 §6） |

八行里有七行是**共性**：C 前端那一侧同样在掩位宽、同样在抄聚合体、同样在拼括号。所以这些不是
"jancy 的账"，是方言欠的账。

## 1. 标量：位宽写在类型上

- **整数**：`i8 i16 i32 i64` / `u8 u16 u32 u64`。回卷与符号扩展是**算子按类型**定的
  （`add.i8` 溢出就是 C 的 `char` 溢出），前端不再掩。
  预留：`i128 u128`（Rust / Zig 都有）、`isize usize`（按目标平台定宽）、任意位宽 `iN`（LLVM / Zig
  有；位域那一族真正该落的地方）。
- **浮点**：`f32 f64` 先落，`f16`（GLSL / ML）与 `f80 / f128`（C 的 long double）预留。
  语义按 IEEE-754，快速数学是**算子上的标记**而不是另一格类型。
- **布尔**：`bool` 独立一格（LLVM 的 `i1`、Rust 的 `bool`）—— 不是 `i8` 的别名，比较答的就是它。
- **字符与字节**：不抢 `char` 这个名字（C 的 `char` 是 8 位、Rust 的 `char` 是 Unicode 标量）。
  方言给两格：`u8`（= 字节，`byte` 是它的别名）与 `c32`（一个 Unicode 标量值），
  语言各自映射自己的 `char`。`c8 / c16` 预留（UTF-8 / UTF-16 的码元）。
- **`void`**：函数不回值那一格。`unit`（有值但零宽）预留 —— Rust 的 `()` 与它不是一回事。
- **`string`**：**留着**（ADR-0026 已定形：落进内存是 16 字节的按值聚合）。它比 native 共识高一层，
  可 jancy / asy / js 三门都要它；native 那一侧用 `slice u8` 表达，两者并存不冲突。

## 2. 指针与引用：thin / fat / 引用**各自一格**

今天方言里 `(ptr T)` 是**带范围**的（越界是运行期错误），`(tptr T)` 才是裸的 —— 名字与共识反着，
而且"带范围"这件事被塞进了同一个概念里。要摆齐的是四格：

- `ptr T`：裸指针（LLVM 的 `T*`、Rust 的 `*mut T`）—— 只有地址；
- `slice T`：地址 + 长度（Rust 的 `&[T]`、Zig 的 `[]T`、Go 的 slice）—— 今天那格 fat 指针的正身，
  越界检查是**这一格自己的**语义，不是所有指针都背着它；
- `ref T`：非空、有效期由上层保证的引用（C++ 的 `T&`、Rust 的 `&T`）；
- `fnptr (params) ret` 与 `closure`：函数地址与"函数地址 + 捕获环境"两格分开（今天的 `mkclo` 是后者）。

限定语（qualifier）挂在类型上而不是另开一格类型：`const` / `volatile` / `align(N)` / `restrict`。
地址空间（GLSL 的 uniform / storage、CUDA 的 shared）预留一格 `addrspace(N)`。

## 3. 聚合与代数类型

- `struct`：**布局是类型的一部分** —— `packed`、`align(N)`、字段偏移可查；
- `union`：C 的那种（无标签）；
- `array T N` 与 `slice T`（见 §2）；
- `tuple`：位置字段的聚合（Rust / Zig / Python 的元组，也是多返回值的落点）；
- `enum`：**带标签的联合**（Rust 的 enum、C++ 的 variant、Zig 的 union(enum)）—— 这一格是 `match`
  的前提，也是 jancy 的 `variant_t`、js 的 tagged value、错误返回（`Result`）共同的落点。
  今天 jancy 那边靠 `$tag` 整数手工模拟（第五十七刀），正是缺它；
- `variant`（动态类型的那种，运行期带类型标签）：jancy / js 要它，**与 `enum` 分开**记一格。

## 4. 控制流：`switch` 与 `match` 都要有

- `if` / `while` / `loop`（无条件循环）/ `for`（区间与迭代器两种形态）；
- `break N` / `continue N`（带层号 —— jancy 与 Zig 都有，今天已经在）；
- **`switch`**：整数与字符串的多路分派，语义上是**跳表**而不是一串比较（今天前端把它摊成一圈
  `while` 加一串 `if`，`stmt-table.js` 的 `switchLines`）。落法允许后端挑（跳表 / 二分 / 比较链），
  但**方言里它是一格**；
- **`match`**：对 `enum` 解构 + 绑定 + 守卫（Rust / Zig 的 switch on tagged union）。
  这一格是"承载力"最典型的例子：没有它，任何有代数类型的语言都要在前端把解构摊成一串
  `if (tag == N) { … }`；
- `goto` 与 `label`：**要有**（C 的 `goto` 是真特性，LLVM 的 `br` 更是），只是不鼓励；
- 非局部跳转：`try` / `catch` / `finally` 那一族在语义上是"带落点的跳"—— 今天 jancy 用
  "抬语句 + 算层号 `brk`"模拟（`escapeText`）。方言给一格**可失败调用**（callee 回
  `(value | error)`，调用点两条边）就能收掉这一整族。

## 5. 表达式的承载力（今天最缺的一格）

- **块表达式**：表达式里装得下语句与临时量（Rust 的 `{ … }`、GCC 的 statement expression）。
  今天 `new C` 那三句、printf 的中间量、errorcode 的传播**各自抬成一个函数或一串前置语句**
  （`$newoN` / `$fN` / `$eN`）—— 全是因为这一格没有；
- `let` 绑定当表达式、短路 `&&` / `||`、三目、复合赋值、`++` / `--`；
- **转换写清楚**（照 LLVM 的分法，不靠"看类型猜"）：`trunc` / `sext` / `zext` / `fptrunc` /
  `fpext` / `fptosi` / `fptoui` / `sitofp` / `uitofp` / `ptrtoint` / `inttoptr` / `bitcast`。
  今天 jancy 的 `intConvCode` 就是在**猜**该发哪一种；
- 取地址 / 取字段 / 下标 / 解引用：位置（place）与值（value）分开，读写各一条边
  （前端那三种形状 `var` / `ptr` / `agg` 是这一格的影子）。

## 6. 契约：语言 ↔ `sx` 只有一处说法

方言的每一格算子写成一张**机器可读的表**（名字、元数、每格操作数收什么、答什么），
落在 `src/lang/common/sx.js`：前端不拼字符串，叫构造器；元数与形状**当场校验**。
今天 191 处裸模板要收到 0 —— 这一轮量出来的真错里有三处正是"少一个括号 / 忘了裹 `(expr …)` /
`(pfield)` 与 `(pload (pfield))` 混了"，它们本该在发码那一刻就炸，而不是等跑起来印错数。

再往前一格（等 §1~§5 长齐）：前端**不发文本，发一棵带类型的树**，文本只是它的一种打印法。
那时"契约"就从"元数对不对"升级成"类型对不对"，`intConvCode` 那种猜法自然消失。

## 7. 还没定形、但要预留的

这几族现在**不定语义**，只在模型里留下位置（留位置的意思是：类型与算子的命名空间给它们让开，
别让别的东西占了）：

- **async / 协程**：状态机化之后需要"挂起点"与"恢复"两格算子；帧的布局是结构体；
- **线程与原子**：`atomic T` 一格类型 + 内存序（`relaxed` … `seqcst`）挂在算子上；
- **IO / 网络**：syscall 面（今天走宿主 `native.js`），长期该是一格 `extern` ABI + 能力对象；
- **SIMD**：`vec T N` 一格类型（GLSL 早就要它），逐元素算子按类型定；
- **调试信息与内联汇编**：`inline asm` 与位置信息挂在语句上。

## 8. 迁移（不推倒，尺子始终在）

今天那五格类型是这个模型的**子集**（`int` = `i64`、`real` = `f64`），所以每一格都是"加"，不是"改"：

1. §1 的整数与浮点先落（收益最大：`int-table.js` 整份 + 每处 `withBits` 消失，C 前端同得）；
2. §5 的块表达式（`$newoN` / `$fN` / `$eN` 三族抬升消失）；
3. §3 的 `enum` + §4 的 `match` / `switch`（jancy 的 `$tag`、js 的 tagged value 一起收）；
4. §3 的聚合按值拷贝、§2 的 thin / slice / ref 分家；
5. 其余按账排。

每一格的验收与 ADR-0026 / 0027 / 0028 同一条：**六条腿逐字节相同**，加上
`node tests/lib/jnc-rules-sweep.js`（今天 52/199 降得下来、行为 52/52 对 `.expected`）
**不许变差**；每落一格，记下"前端因此删掉了多少行手写细节"—— 那是这一整份 ADR 唯一的成绩单。

**规则化那条路子现在的数**（`node tests/lib/jnc-rules-sweep.js` + 逐字节比 `.expected`）：
199 份语料**降得下来 137（68.8%）、行为一致 137 / 不一致 0**，账 58 种。前一轮接上的几族
（各带出处）：静态字段与成员属性、`basetype.…`、合成出来的构造（基类 / 字段初值 / 内嵌对象）、
聚合体按值抄一份与 `operator :=`、花括号初值（模块级 / 局部 / `static` + once / `a = { … }`
四处一份 `curlyLines`）、点串的类型名、类体里的 `typedef`、`countof`、`'a'` 是一个整数、
`a.g` 是命名空间里那一格、静态方法、完整声明式的属性、`autoget` 生成的取值器、
construct 的默认实参、赋值当表达式用（`jnc$asgn$T` 助手）。

**这一轮又接上的几族**（84 → 122，每一格都是"同一件事走同一条路"）：
- **import**：把那份文件的顶层条目并进这一个模块（找法/查重/传递三条与 jancy 同）；
- **泛型 = 单态化**：`generic.js` 接进 lower，造出来的实例插在顶层链最前头；
- **名字先过一遍**：顶层没有"先声明后使用"这条（泛型接上之后成了硬要求）；
- **alias 那一族**：顶层 / 体里 / 类体里三处一条规则（"一个名字指着谁"，不是一格量）；
- **沿基类链找方法** + 基类构造**按格**补（虚方法/撞车两样明说不收）；
- **`try <表达式>`**（把往上传关掉）、**调用点的空槽**（`f(1, , 3)`）；
- **union 里套的匿名 struct**（一格名字对一条路）、**extension 的方法长在目标类型上**；
- **方法当值用**（闭包壳 + `mkclo`）、**声明符尾巴上那对括号是构造实参**；
- **模块级的类变量**那一格对象、**命名空间里的函数**（`a.b.deep()`）；
- **`operator []`**（下标与属性同一种 `prop` 形状；存值器写着 `errorcode` 的那一格明说不收）；
- **贴着写的几格串字面量是一格串**、**`autoget` 写在体里那格存储上也算**；
- **虚派发**（第五十七刀）：一格虚槽落成一个分派函数 `<声明那一格的类>$$vd$<方法名>`，
  按 `$tag` 一格一格比；派生类自己没写那个方法时比出来的是**上头最近那一格**写的实现
  （54-virtual.jnc 的 `Cube` 比出 `Square$area`）；调用点按**接收方的静态类型**查同一张表
  （78-notype.jnc / 54-virtual.jnc）。一句都发不出来的（一个实现都没有）照旧明说不收；
- **重载：按实参个数分得开的那一半**（第五十八刀 A，76-overload.jnc）：同名的几格在方言那一侧
  各有一个名字（`f` / `f$o1` / `f$o2`，号由 `overloadSuffix` 拼，扫与发两头共用一格）；
  **实参签名一样的两条不是重载、是同一格**（类体里那句原型 + 体外那个定义）；调用点按
  "收得下的个数"挑，同元有两条或一条也合不上**明说不收**（那要按各实参的转换代价排）。
  `construct` / 取存 / 算符那几族的调用点还没有"挑一格"这一步 —— 照旧记账；
- **重载：同元那一半按实参的类型挑**（第五十八刀 B，77-overload-types.jnc / 135-overloadcheap.jnc）：
  每条候选取各实参里**最差**的那一档当分、取最高分、并列即歧义 —— "怎么挑"这一句用的是
  引擎那一格（`frontend-engine/overload.js`，与旧降级同一份），打分那张表（int 之间 /
  完全一样 / 类的上转 / 跨族）才是这门语言的。实参的类型走**不发一个字**的那一问
  （`cheapTy`：字面量、名字、字段、枚举项、`&x`、`new T`、一元那几个、非重载的调用），
  问不出来或平手照实说不收；
- **顶层的函数原型不是一格量**（15-forward.jnc / 180-topmixovl.jnc）：`int later(int x);` 在树上
  与模块级那几格量长在同一个节点里（声明符尾巴上多一对括号），先前被收进模块级量表 ——
  调用点于是走"从一格函数值上调"那条，报的是"'later'：函数那一族（fn）"这种认错人的账。

**账不许转手**：外面那几层（printf / 赋值 / 调用 / 取字段…）先前一律补一条"这一格还拼不出来"，
把真原因盖住了 —— 现在里头记过就闭嘴（`acctSeen`）。于是尺子上的前几堆是真原因：
跨文件/宿主面的被调 13、属性的取值器 9、重载挑一格（函数 8 + 方法 6）、字段认不出基类型 8、
作用域图 7。剩下的大族按"下一刀"排：**重载挑一格**（旧降级发 `q$o1` / `q$o2`）、
位域、反应器与事件、`bindable` 生成的取存、`bindingof`、带下标的属性。

### 8.1 第一格（整数带宽度）怎么落：证据、文件、闸门

**证据（这一条决定了它排第一）**：宽度这件事**两个前端各写了一遍**——
- jancy：`src/lang/jnc/int-table.js` 整份（`wrapTo` / `uOp` / `arithType` / `commonInt` /
  `intConvCode`）+ 每处发码点的 `withBits`；
- C：`src/core/frontend-c/ctype.js` 的 `VT_*` 位与 `cconst.js` 的 `BigInt.asIntN(64, …)`。

而**核心 IR 自己没有宽度**：`src/core/hir/types.js:4` 就一行 `export const INT = { k: 'int' }`。
所以这不是"某门语言的账"，是核心欠的账 —— 也是为什么两边都在掩。

**要动的文件（按依赖序）**：
1. `src/core/hir/types.js`：`int` 长出 `w`（8/16/32/64）与 `u`（有无符号），**缺省 64 位有符号**
   —— 于是今天所有的 IR 一个字都不用改；
2. `src/core/hir/check.js`：算子两边的宽度要一致（不一致是**错**，不是隐式转换）；
3. `src/core/sexpr/lower.js`：类型名收 `i8 i16 i32 i64 u8 u16 u32 u64`（`int` 是 `i64` 的别名）；
   字面量 `(int N)` 按落点定宽，转换写成显式算子（`trunc` / `sext` / `zext`）；
4. 六条腿：`backend-c`（原生类型直接对上）、`backend-js`（`|0` / `>>>0` / `BigInt.asIntN`）、
   `interp`、`mir`、`llvm`、`jit`。
5. 前端跟着删：`int-table.js` 那五个函数与 `withBits` 一路的参数。

**闸门（每一步都要过）**：
- 后端**还没接**某个宽度时，`hir/check.js` 当场报"这条腿还不认 i8"——
  **绝不允许悄悄按 64 位跑**（那正是这一轮最坏的一类错：静静地印错数）；
- `tests/jnc`（六条腿逐字节相同 + `.expected`）与 `tests/c`、`tests/asy` 全绿；
- `jnc-rules-sweep.js` 的两个数不许变差；
- 落完之后 `src/lang/jnc/` 的行数**要减**（成绩单：删掉的手写细节行数）。

### 8.2 先落半格：`trunc` / `sext` / `zext` 三个算子（踏脚石，已量好代价）

整数带宽度那一格要动 `INT` 的 238 处引用（`grep -rn "INT" src/core/`），是一场独立战役。
**先落它的半格**：把"掩回去"从**三个算子拼出来**变成**一个算子**——

```
今天：(bin "-" (bin "^" (bin "&" v (int 255)) (int 128)) (int 128))     ; 有符号回卷到 8 位
今天：(bin "&" v (int 255))                                             ; 无符号回卷到 8 位
之后：(sext 8 v)        / (trunc 8 v) 与 (zext 8 v)
```

语义写死（不留解释空间）：`(trunc N v)` = `asUintN(N, v)`；`(sext N v)` = `asIntN(N, v)`；
`(zext N v)` = 与 `trunc` 同值，分开写是为了**读的人知道意图**（LLVM 的分法）。

**要动的文件（量过：OIR 的算子只有四处消费方）**：
1. `src/core/sexpr/lower.js`：读这三格 + 建 OIR 节点；
2. `src/core/backend-c/emit.js`：C 那侧就是一次强制转换（`(int8_t)` / `(uint8_t)`）；
3. `src/core/backend-js/emit.js`：`BigInt.asIntN(N, x)` / `asUintN`；
4. `src/core/interp/builtin.js`：同上；
5. `src/core/mir/from_oir.js`：MIR 一格截断/扩展指令（LLVM 与 JIT 顺着 MIR 走）；
6. `src/lang/common/int.js`：`wrapTo` 从五行塌成一行。

**闸门**：`tests/jnc` 六条腿（`OMNI_LEGS=all`）逐字节相同 + `.expected`；
`jnc-rules-sweep.js` 的两个数不许变差；发出来的 `.sx` 文本**要变短**（那是这一格的成绩单）。

**为什么值得先做**：它把"回卷"从"三个算子的拼装"变成"一格意图明确的算子"，于是
（a）`.sx` 读得懂了，（b）后端能挑最好的落法（C 直接强转、LLVM 直接 trunc/sext），
（c）等类型真的带上宽度时，这三格算子**原地就是那时要的东西**，不用再改一遍。

**落完之后量到的（两条降级路子都换过来了）**：

- 方言与六条腿：三格算子读得进（`sexpr/lower.js`），落得下（C 的 `omni_int_trunc` /
  `omni_int_sext`、JS 前奏里保持数种类的两格辅助、解释器、MIR→LLVM/JIT）；
- 规则化那一侧 `src/lang/common/int.js` 的 `wrapTo` 从五行塌成一行；
- **旧降级那一侧也换了**（`src/core/frontend-jnc/lower.js:797`）。顺带塌掉的是位域读那一格
  `bitsRead`：先前"掩到 cnt 位 + `(x ^ s) - s` 补符号位"是自己又写了一遍同一条算法，
  现在就是一句 `wrapTo(sh, lv.cnt, lv.type.u)`。
- 成绩单：199 份语料默认路发出来的 `.sx` **470047 → 426722 字节（−43325，−9.2%）**；
  `tests/jnc` 六条腿 `350 passed, 0 failed`；`jnc-rules-sweep.js` 两个数没变（降得下来 52 / 账 71）。



## 9. 不做什么

- 不为了"看起来规则化"把手写细节塞进一张更大的表：那只是把问题挪了地方（这一轮的教训）；
- 不在方言还没长出那一格之前，先把前端那一段模拟代码"重构漂亮"：模拟得越漂亮，越难删；
- 不用"简单"当理由砍承载力 —— 砍之前先量：哪一门语言、哪一份语料用不上它。
