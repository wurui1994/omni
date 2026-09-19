# ADR-0039：公共优化管线（照 Go 的通道表），tcc -O2 那一档

日期：2026-09-20　状态：**已定形，待实现**

## 0. 起因：量出来的账说明我一直在修错的地方

`node bench/ir/extreme.js --size 64 --iters 5 --runs 2`（smallpt 64×64，校验和 243367 全腿一致）：

| 腿 | 冷态 | 倍 | 热态/遍 | 倍 |
|---|---|---|---|---|
| C -O2 | 23ms | 1.0x | 19ms | **1.0x** |
| Go | 26ms | 1.1x | 23ms | **1.2x** |
| java(hotspot) | 125ms | 5.4x | 13ms | 0.7x |
| node(v8) | 115ms | 5.0x | 68ms | 3.6x |
| **ours(AOT)** | 279ms | 12.1x | 295ms | **15.7x** |
| **ours(VM-JIT)** | 299ms | 13.0x | 319ms | **17.0x** |
| luajit | 383ms | 16.7x | 362ms | 19.3x |
| lua5.1 | 1441ms | 62.7x | 1357ms | 72.4x |

**关键是这一条：AOT 腿 15.7x、VM-JIT 腿 17.0x —— 两条一样差。**
过去一整轮我在 `src/core/lua/jit-a64.c` 上做的都是 Tier 1 的窥孔级改动
（内联深度、守卫 CSE、STR→LDR 转发、arena 对齐……），单项 0~5%，而且**只对 Lua 那一条腿有效**。
真正的原因写在 `src/core/mir/ir.js` 第 5 行，是我们自己写下的：

> **不做优化**：没有 pass 管线、没有寄存器分配、没有指令选择。

`src/core/mir/` 下面没有任何 `opt`/`pass` 文件。也就是说 **C / Go / Lua / JS 四个前端共用的中层 IR
一个优化通道都没有**。差的 15 倍不在某一门语言的发射器里，在缺的那一层。

⇒ 决定：**停止在单语言后端上做窥孔**。把优化建成**公共的一层**，位置在 MIR，
所有前端共享，判据对齐 Go 自己编出来的二进制。

## 1. 决策

1. **新增 `src/core/mir/opt/`：语言中立的 SSA 优化管线**，照 Go 的
   `cmd/compile/internal/ssacompile/compile.go` 那张通道表抄（顺序、每格一遍、不迭代到不动点）。
2. **质量档位对齐 tcc 的 -O2**：编译速度是硬约束（在内存里、单遍、无全局迭代求解），
   质量目标是"该消的都消掉"，不是"追平 LLVM -O3"。
3. **判据是 Go 的二进制**：`.go` 输入 → 我们的管线 → 与 `go build` 出来的二进制**保持一致**
   （与 `tcc` 那把尺子同构，见 ADR/`project_binary_parity`：验收标准是"写出的字节相同"）。
4. **MIR 要先长出真 SSA**。现在可变局部量是 `SLOT + LOAD/STORE`、没有 phi（ir.js 开头第 1 条）。
   优化管线的前置是 `mem2reg`：把不取地址的 SLOT 提成 SSA 值 + 插 phi。
   这一格**不违反**原决策——原决策说的是"MIR 自己不做常量传播"，不是"永远不许有 SSA 构造器"。

## 2. 通道表（照 Go 抄，分三批落地）

来源：`/Users/wurui/Documents/Lang/reference/go/src/cmd/compile/internal/ssacompile/compile.go:414`
起的 `var passes = [...]ssa.Pass{...}`（**已逐条核对过这一版的源码**，不是凭记忆写的）。
`R` = 源码里 `Required: true`（不能关）。批次标注：`[1]`=第一批、`[2]`=第二批、`[3]`=第三批、`—`=我们不要。

```
 R  number lines                      —   调试行号
    early phielim and copyelim        [1]
    early deadcode                    [1]
    short circuit                     [2]
 R  decompose user                    [1] ★
    pre-opt deadcode                  [1]
 R  opt                               [1] ★ 重写规则（generic.rules）
 R  zero arg cse (zcse)               [1]  源码注释：required to merge OpSB values
 R  opt deadcode                      [1]
    generic cse                       [1] ★
    phiopt                            [2]
 R  gcse deadcode                     [1]
    nilcheckelim                      [2]
    prove                             [3]
 R  divisible                         [3]
 R  divmod                            [3]
 R  middle opt                        [1]  （又跑一遍 opt）
    known bits                        [3]
    early fuse                        [2]
 R  expand calls                      [1] ★
 R  decompose builtin                 [1]
 R  softfloat                         —
    branchelim                        [2]
 R  late opt                          [1]  （第三遍 opt）
    dead auto elim                    [1] ★ elimDeadAutosGeneric
    sccp                              [2]
 R  generic deadcode                  [1]  注释：remove dead stores…mess up store chain
    late fuse                         [2]
    check bce                         —   诊断
    dse                               [1] ★
    memcombine                        [3]
 R  writebarrier                      —   我们没有 GC 写屏障
    insert resched checks             —   实验开关
    cpufeatures / rewrite tern        —   SIMD 实验开关
 R  lower                             [1] ★
    addressing modes                  [2]
 R  late lower                        [2]
    pair                              [3]  ldp/stp
    lowered deadcode for cse          [1]  注释：避免 CSE 把死值救活
    lowered cse                       [2]
    elim unread autos                 [1]
 R  tighten tuple selectors           [2]
 R  lowered deadcode                  [1]
 R  checkLower                        [1]  自检：还有没有没降下去的通用 op
    loop invariant (licm)             [3]
    late phielim and copyelim         [1]
 R  tighten                           [2]  把值挪近使用点
    late deadcode                     [1]
 R  critical                          [1]  拆临界边
    phi tighten                       [2]
    likelyadjust                      [2]
 R  layout                            [1] ★ 排块
 R  schedule                          [1] ★ 排值
    late nilcheck                     [2]
 R  flagalloc                         [1] ★ 标志位
 R  regalloc                          [1] ★★ 寄存器分配
    loop rotate                       [2]
    trim                              [1]
```

**源码里还有一张 `passOrder` 约束表**（`compile.go` 紧随 passes 之后）—— 那是"a 必须在 b 之前"的
自检，不是顺序本身。已确认的几条与我们相关：`generic cse → prove`、`prove → generic deadcode`、
`prove → divisible`、`dse → insert resched checks`、`insert resched checks → lower/tighten`。
我们实现时**照抄这张约束表并在启动时自检**，免得以后调顺序调坏。

**第一批（★ 是必须的骨架）= 24 格**：不做这 24 格就没有"能跑的优化管线"；
做完这 24 格就该看到 smallpt 从 15.7x 往个位数掉。
第二批 = 质量补齐，第三批 = 边界检查/循环那一族。

## 3. "对象不落堆"是三步流水，不是一个 trick

抄的位置与门槛（`memory/reference_go_compiler_passes.md` 已经记过，这里落成实现约束）：

1. **逃逸分析在 SSA 之前**（Go 在 `internal/escape`，跑 AST）：不逃逸的 `&T{...}` 变成
   **栈上的 auto**，只决定"堆还是栈"。
   → 我们的对应：前端（graph/HIR）那一层判，MIR 里体现为 `SLOT` 而不是 `HEAPALLOC`。
2. **decompose user**（`ssa/decompose.go`）：结构体 SSA 值按字段拆成标量。
   门槛 `MaxStruct = 4`（`ssa/value.go:CanSSA`：`size > MaxStruct*PtrSize` 不拆）。
3. **dead auto elim / dse**（`ssacompile/deadstore.go:246 elimDeadAutosGeneric`）：
   拆完之后栈槽没人取地址 ⇒ 连 auto 带 store 一起删。算法是"哪些值能到达 auto 地址"的定点传播。

⇒ 三格缺一格就没效果。这也解释了这一轮 Lua 那边"标量替换写完了但一个都没拆成"：
缺的是**第 1 格在正确的层**（前端定栈/堆）与**第 2 格的 IR 支持**（MIR 没有 phi、没有按字段拆的表示）。

## 4. 动态语言怎么接进同一条管线

Go 没有动态类型，但去虚化那一格给了模板（`devirtualize/pgo.go`）：

```go
fnPC       := ir.FuncPC(fn)
concretePC := ir.FuncPC(callee.Nname)
pcEq       := fnPC == concretePC
res        := condCall(pcEq, concreteCall, originalIndirectCall)  // 两条路都留着
```

我们的映射（现成，不用造）：
- Go 的 profile ⇔ 我们调用点的**反馈槽**（IC 已经记着这个点调过哪个闭包）
- `fnPC == concretePC` ⇔ 比较运行期取出的闭包值与**编译期烧进去的立即数**
- condCall 两条路 ⇔ 守卫命中走内联体、不命中走原来的 helper

⇒ 动态那一面**只多要一个形状守卫**，不强制堆分配、也不需要另一条管线。
次序仍然是：**devirt(带守卫) → inline → escape → decompose(≤4) → dse**。

## 5. Go 输入这条腿：现状与要补的

现成的（`memory/project_go_52of52_crosspkg.md`、`project_go_47of49_remaining.md`）：
- `ext/go` 的语法（照 `go_spec.html` 的 EBNF）
- `ext/go/tograph.js`：Go → graph，**tograph 754/754**
- 跨包编译 **52/52 包全通过**（46 单包 + 6 跨包）
- `ext/go/go.mapping` + mapping 解释器

要补的：
1. **graph → MIR** 这一段对 Go 的覆盖（现在 Go 那条腿主要落在 js/eval 上验语义）
2. **Go 的运行时约定**：goroutine/channel/defer/interface 的降级（已有 `__goSprintf`/`__goTypeOf`
   /`__goTypeIs`/接口方法表三刀，见近期提交）
3. **判据的建法**：同一份 `.go`，`go build` 与我们各出一份二进制，比较
   —— 先比**行为**（stdout + 退出码），再比**函数级的机器码**（照 tcc 那把尺子的做法：
   先对齐 `.text` 的语义，不追求逐字节相同，因为 Go 的 runtime 我们不复制）

⚠️ 这一条要**如实记账**：与 `go build` 逐字节相同是不可能的目标（Go 的二进制里有它自己的
runtime、类型元数据、GC 位图）。可达到的判据是三级：
- L1 **行为一致**：同一份 `.go`，两边 stdout/退出码/校验和相同（先做这个）
- L2 **性能同档**：热态在 Go 的 1.5x 以内（这是"优化管线做对了"的真判据）
- L3 **代码形状一致**：对指定的小函数，我们出的指令序列与 `go tool objdump` 的可逐条对照

## 6. 落地顺序（每一格都要能单独验）

1. `mir/opt/ssa.js`：**mem2reg + phi 插入**（Braun 那篇按需插 phi），判据 = 所有现有腿输出不变
2. `mir/opt/pass.js`：通道表框架（Pass 列表 + `-O` 档位 + 单格开关 + `--mir-dump-pass`）
3. 第一批 24 格，**按通道表顺序**逐格加，每加一格跑：
   - `node bench/lua/regress.js`（22/22 逐字节）
   - C 腿的自举（`OMNI_CC=self`）
   - `node bench/ir/extreme.js`（看倍数往下走）
4. `regalloc`（线性扫描）—— 这一格之前所有"值住在栈槽"的量都不准，别提前下结论
5. Go 输入的 L1 判据，然后 L2

## 7. 不做什么

- **不引入 LLVM/MLIR**（MLIR 那条腿已废弃，只当对照）
- **不迭代到不动点**：每格一遍，顺序固定 —— 这是"编译快"的唯一来源
  （注：`opt` 那一格**自己**迭代到不动点，Go 的 `applyRewrite` 也是这样；
  "不迭代"说的是通道**之间**）
- **不在单语言后端继续做窥孔**：`src/core/lua/jit-a64.c` 那边冻结在现状
  （Tier 1 已到顶的证据见 `memory/project_lua_vm_jit.md` 第 19~30 条）

## 8. 现状（2026-09-20）

落了 16 格（`level 1` 跑 15 格）：`early phielim and copyelim`（mem2reg）、
八格 `*deadcode`、`opt`/`middle opt`/`late opt`、`zero arg cse`/`generic cse`/`lowered cse`、
`elim unread autos`。代码在 `src/core/mir/opt/`：

- `pass.js` 56 格的表 + `PASS_ORDER` 自检 + 档位；`index.js` 一处 import 全部通道
- `edit.js` **改图只有这一份实现**（`replaceRef` / `removeInsns`）
- `region.js` **词法作用域**（MIR 的"支配"，见下面第 2 条坑）
- `cfg.js` 基本块 / 支配树 / 支配边界（`BRTABLE` 的边在里头）

接线：`OMNI_MIR_OPT=1..3` 开（缺省 0 = 一格不跑），`OMNI_MIR_OPT_STATS=1` 印账，
`OMNI_MIR_OPT_ONLY=通道名` 单格 A/B 与二分；挂在 `lang/c.js` 的 `cMir`/`cMirNative`，
跑完再 `verifyMir` 一遍。

量出来的（真产物）：`src/runtime/omni_r3.c` 147 个函数，指令 26002 -> 23545（-9.4%）；
一个 fib 例子解释器腿 -17.6%、原生腿 `.o` 960 -> 912 字节。
判据 `node tests/mir/opt.js`（24s，在 `tests/all.js` 里）：六个单格判据 +
**L1：`tests/c/gen/*.c` 那 85 份开与不开管线 stdout 与退出码逐字节相同**。

### 落地时踩的三个坑（都是真产物/判据抓的，不是想出来的）

1. **MIR 里没有 NOP**。把消掉的指令改写成 `END` 会当场把控制流改坏（`END` 关掉最近一个
   未闭合的区域）。所以变换只改引用，删指令集中在 `edit.js` 的 `removeInsns` ——
   这也正是 Go 的表在每个变换后面都跟一格 deadcode 的理由。
2. **"支配"在这一层是词法作用域，不是 CFG 支配树**。`verify.js:124 checkRef` 判的是
   "定义它的那层区域还在栈上吗"。循环之前的块**确实**支配循环之后的块，但 `LOOP…END`
   一关那个值就不可见（wasm 那条腿上它就是求值栈上一格）。CSE 第一版用支配树，
   在 `omni_r3.c` 的 `r3_num` 上被骂「%38 定义在一个已经关掉的区域里」。
3. **`buildCfg` 原来不认 `BRTABLE`**：switch 的目标块拿不到入边、还多一条"顺序落下去"的边。
   mem2reg 于是按错的"单前驱"传了值（`tests/c/gen/10-switch.c`：s=7457 变 7557）。
   顺带一笔：折浮点常量时 `String(-0)` 是 `"0"`，负零要特判（`15-float.c` 抓的）。

### 下一格：**regalloc**，不是更多与机器无关的通道

L2 那一档量了（smallpt 64×64、6 帧、校验和 243367 四份逐位相同；三趟取最小）：

- `clang -O2`      169 ms  = **1.0x**
- `clang -O0`      641 ms  = 3.8x
- 我们（原生 C 腿，`omni c tcc`）MIR-opt **关**  1211 ms = **7.0x**
- 我们 + MIR-opt **开**（指令 -5.6%）            1245 ms = 7.2x —— **时间没动**

这条账把话说死了：**与机器无关的通道再加也不会动这个数**。原因在
`src/core/arm64/from_mir.js` 自己的文件头上：「每个 MIR 值一个栈位，算之前 `ldr` 进来、
算完 `str` 回去，寄存器只用 x8/x9/x10 三个当草稿」，加第一百四十三片那五个缓存
（x11-x15，用"还要用几次"这一个数决定，不算活跃区间）。于是热路径上每条运算都夹着一对
内存访问 —— 少 5% 的指令条数换不出时间来。

所以按第 6 节的第 4 步走：**下一格是 regalloc**（线性扫描）。MIR 这一层做它有个便宜：
值的活跃区间**就是 pc 区间**且一定连续（区域作用域保证"跨过 END 就不可见"，见上面第 2 条坑），
所以不需要先建活跃区间的那一整遍数据流。做完之前，别再拿"指令条数降了多少"当性能判据。

（与机器无关的那几格仍有它们的价值：解释器腿上一条指令就是一次分派，而
`decompose user` 那一格是"对象不落堆"三步里的第二步 —— 但它们都不在这条 7.0x 的主路上。）

`dead auto elim` 那一格现在无活可干的理由另记一笔：C 前端在线性内存腿上把那一块的
基址当场 `GSTORE` 进了 `$sp`，照 Go 的判据答"留着"（见 `opt/autos.js` 末尾）。


