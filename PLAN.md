# Omni：跨语言解析 / 多后端编译架构 —— 总体计划

> 状态：草案 v0.1（2026-08-25）。本文件是唯一的顶层规划入口，重大决策落到 `docs/adr/`。

## 0. 目标与非目标

**目标**
- 前端（语法）与后端（执行）彻底解耦：任意前端 → 统一 IR → 任意后端。
- 主语言 Omni：语法以 **Asymptote**（隐式转换、命名/默认参数、重载、几何字面量）+ **Jancy**（C 兼容 ABI、安全指针、reactive、dylayout、双错误模型）为骨架，**兼容 JS 子集**，并支持 **Nim 式 UFCS**（`a.f(b)` ≡ `f(a,b)`）。
- 后端矩阵：**解释执行（寄存器 VM）/ LLVM JIT+AOT / C 源码 / JavaScript**，后续 SPIR-V。
- **实现层不使用 C++/Rust 或任何编译慢的语言**：stage0 用纯 JS，随后自举到 Omni 自身；JS 实现永久保留作兼容层（见第 2 节）。
- 第二前端：**GLSL**（借 llvmpipe 思路做软件光栅/SIMD 向量化验证）。
- 性能目标：VM 层对标 Cyber，JIT 层借 LuaJIT 的 trace + guard/snapshot，kernel 层借 Taichi 的 offload/layout 解耦，元编程与 SIMD 抽象借 Mojo。

**非目标（v1 明确不做）**
- 不做完整 ECMAScript（无 `eval`/`with`/原型链动态改写/Proxy）。
- 不做完整 GLSL/Vulkan 驱动栈，只做前端 + 一个可跑的软件后端 demo。
- 不追求源码级兼容 Asymptote 或 Jancy 的全部标准库，只对齐语法与语义内核。

## 1. 需要先拍板的关键决策

| 决策 | 建议 | 理由与代价 |
|---|---|---|
| 实现语言 | **stage0 用纯 JS（ESM + JSDoc 类型，零构建步骤），随后自举到 Omni 自身；JS 实现永久保留为兼容层** | 明确排除 C++/Rust 及一切编译慢的宿主语言。纯 JS 改一行即刻生效，编辑-运行循环 ≈ 0；类型检查用 `tsc --noEmit` 当 linter 跑，不进构建路径（不写 `.ts`，不引 bundler）。代价：stage0 的编译吞吐较低、无原生 LLVM 绑定 —— 两者都由自举后的原生编译器解决，详见第 2 节。 |
| 自研 IR vs MLIR | **自研 OIR**，设计上向 MLIR 看齐（op + region + dialect 命名空间） | 宿主是 JS，MLIR 的 C++ API 本就无法直接用，此项变成必然而非取舍。Mojo 编译器已全量开源（2026-08-18, Apache 2.0），当作 comptime / 参数化类型的参考读物。 |
| 内存模型 | **ARC + 可选环收集**，逐步引入借用标注 | ARC 能同时映射到 C（显式 rc 调用）、LLVM、以及 **JS（rc 操作直接消解为 no-op，交给宿主 GC）**；tracing GC 在 JS/C 双后端下代价高。 |
| 动静态类型融合 | 静态为主 + `dynamic` 类型作为 JS 子集通道 | 单一类型系统，`dynamic` 只在边界处装箱，避免两套语义。 |
| 解析器形态 | 手写递归下降 + Pratt 表达式 + 试探回溯 | Asymptote/Jancy 的 C 系「声明 vs 表达式」歧义必须 tentative parse（参考 Clang），生成器不划算。 |
| 值表示 | 静态类型 slot 存裸值；只在 `dynamic` 边界装箱 —— **不上 NaN-boxing** | **已修订（ADR-0006）**：读 Cyber 源码后推翻原「VM 内 NaN-boxing」决定。Cyber 实际已退化为「静态存裸值 + dyn 边界装箱」，且付出了整数被压到 48 位的代价（`docs/notes/jit-jancy-cyber.md` §2.3.2）。 |

## 2. 自举与宿主策略

**核心思路：JS 既是过渡宿主，也是永久兼容层 —— 但自举完成后，那份 JS 实现是「生成的」，不再手工维护。**

```
stage0  手写 JS 编译器（最小 Omni 子集 → JS 后端 + C 后端）
          │  用它编译 stage1
stage1  用 Omni 重写的完整编译器  ──emit JS──▶ omni.js   （永久兼容层：浏览器/npm/无工具链环境）
          │                      ──emit C ──▶ 原生编译器（tcc 秒级构建 / clang -O2 发布）
stage2  原生编译器再编译一次自己 → 与 stage1 输出比对，达到不动点即自举成功
```

四条关键推论：

1. **stage0 只需要能编译「用来写编译器的那个 Omni 子集」**，不必支持 reactive / dylayout / GLSL / SIMD。它是一次性脚手架，规模控制在几千行以内，写完就冻结。
2. **JS 宿主不需要字节码 VM**。「直接解析执行」在 JS 宿主上 = 解析 → 生成 JS → `new Function` 执行，直接吃 V8 的 JIT。手写解释器在这里只会更慢。寄存器 VM + NaN-boxing 是给**原生**宿主的，用 Omni 写、编译成 C。
3. **C 后端是自举的唯一必经之路**，因此它的优先级最高（早于 LLVM，也早于 VM）。开发期用 **tcc** 编译生成的 C（毫秒级），发布用 clang/gcc `-O2` —— 全链路没有任何慢编译环节。
4. **LLVM 依赖被推到自举之后**。stage0/stage1 期间若需要 LLVM，只以文本 `.ll` 形式落盘再调 `llc`/`clang` 子进程，不做进程内绑定；真正的 ORC JIT 等原生编译器就位后再做（那时可直接 `extern "C"` 链 LLVM-C）。
5. **comptime 求值器天然复用宿主执行路径**：JS 宿主上把 comptime 函数编译成 JS 后 `new Function` 执行；原生宿主上走 VM。两条路径必须通过同一套差分测试。

**永久兼容层的价值**：`omni.js` 是零依赖的参考实现，能在浏览器 playground、CI、以及任何没有 C 工具链的环境里跑；同时它是差分测试的第四个参照点。因为它由编译器自己生成，不会出现「JS 版落后于原生版」的经典陷阱。

## 3. 整体管线

```
             ┌──────────── 前端层（可插拔）────────────┐
 Omni 源码 ──┤ lexer → CST(无损) → AST → HIR(具名+类型) │──┐
 JS 子集  ──┤ 同一 CST 框架，不同 grammar + 不同 lowering │  │
 GLSL     ──┘                                            │  │
                                                          ▼  ▼
                                          ┌───────── OIR（typed SSA + region）─────────┐
                                          │ 通用 pass: 内联/常量折叠/SROA/RC 消解/边界检查消除 │
                                          │ 专用 pass: comptime 求值/单态化/SoA 向量化/offload │
                                          └───────────────────────────────────────────┘
                                            │          │            │            │
                                         C 源码       JS(ES2020)   Bytecode      LLVM
                                       (自举必经)   (rc 消解/兼容层) (原生VM)   (自举后)
```

关键约束：**同一份 OIR 必须能被所有后端消费**。任何只对某一后端成立的语义（如 JS 的数字都是 f64）都必须在前端 lowering 阶段消化掉，不能渗进 OIR。左二两个后端（C / JS）在 stage0 就必须完备，后两个推到自举之后。

## 4. 语言语义要点

**取自 Asymptote**
- 隐式转换图（cast graph）+ 重载解析；命名参数、默认参数、rest 参数。
- 内建几何类型 `pair/triple/transform/path`，`..`/`--` guide 运算符（作为一等语法，非库糖）。
- 模块系统 `import` / `access` / `unravel`（受控地把命名空间成员导入当前作用域）。
- 一等函数 + 闭包。

**取自 Jancy**
- 与 C 的 ABI/源码级兼容：struct 布局、`extern "C"`、可直接传入外部 buffer 不拷贝。
- **安全指针**：胖指针 `(ptr, base, limit)`，越界抛异常；配合 pass 做边界检查消除。
- **reactive**：`reactor` 块自动建立依赖图，赋值触发重算（在 OIR 里降级为订阅表 + 脏标记）。
- **dylayout**：解析动态结构二进制流的声明式布局。
- **regex switch + 内建 lexer 生成器**：编译期把 case 里的正则合并成 DFA。
- **双错误模型**：同一函数在调用点选择 error-code 还是异常语义。
- `disposable` 局部变量 + 确定性释放；bitflag enum；`readonly`/`cmut` 双修饰符；属性。

**UFCS（Nim）**
- **规则已修订，见 ADR-0006 第 5 节**：方法 = 第一参数为 `this` 的自由函数，`o.f(x)` ≡ `f(o, x)`。
  成员、作用域内自由函数、类型所在模块的候选**合并成一个重载集**按转换代价择优，并列即报歧义
  错误。（原方案是有序回退、首个命中集参与解析；当前 `stage0` 实现仍是旧规则，待第 4 步改。）
- 与隐式转换、扩展命名空间的交互要有专门的测试矩阵。

**容器 / json / class**
- 见 ADR-0006：`json` 是 `dynamic` 的可序列化子集（不另造类型）；`list`/`dict`/`set` 先做编译器
  内建参数化；`dict` 必须保持插入序；`struct` 值语义、`class` 引用语义 + ARC、不支持原型。
- `pointer` / `unsafe` / C FFI 登记在案但排在自举之后，v1 语言表面没有裸指针。

**JS 子集（兼容层）**
- 支持：`let/const`、箭头函数、闭包、对象/数组字面量、解构、模板字符串、`for-of`、`class`（无原型改写）、异常、`async/await`（可延后）。
- 不支持：`eval`、`with`、`Proxy`、运行时改 `prototype`、稀疏数组语义细节。
- 数字：默认 f64 语义，静态可证明整数时降级为 i64；`dynamic` 值统一 NaN-boxing 表示。

## 5. IR 分层

- **CST**：无损（保留 trivia/注释），供 LSP、格式化、重命名；解析永不失败（error node）。
- **AST → HIR**：名字解析、模块图、重载与 UFCS 解析、隐式转换插入、类型推导后的产物；语法糖（reactive、dylayout、regex switch、guide 运算符）在此展开。
- **OIR**：typed SSA，带 region（结构化控制流，便于 JS/C 后端还原成 if/for，也便于 GPU/kernel pass）。
  - dialect 分层：`omni.*`（高层：字符串/数组/闭包/rc）、`mem.*`（胖指针、边界检查）、`vec.*`（SIMD/SoA）、`llvm-ish 低层`。
  - 高层 op 保留到尽可能晚，让 JS/C 后端能生成惯用代码，而不是被过早降级成指针算术。
- **Bytecode**：寄存器式，从 OIR 直接生成；仅用于原生宿主（JS 宿主走 `emit JS + new Function`）。

## 6. 后端

优先级顺序由自举路径决定：**C ≻ JS ≻ VM ≻ LLVM ≻ SPIR-V**。

- **C 后端（最高优先）**：自举必经之路，也是「OIR 是否真的可编译」的最低成本验证。输出要可读、可调试（`#line` 映射）。开发期 tcc 毫秒级编译，发布期 clang/gcc `-O2`。目标 C99，不用 VLA / 编译器扩展。
- **JS 后端**：stage0 的执行引擎 + 永久兼容层的生成器。ES2020 + source map；ARC op 消解为 no-op（交给宿主 GC）；胖指针可证明安全时退化为原生数组索引，否则 TypedArray + 显式检查。
- **VM**：用 Omni 写，编译成 C。寄存器式、NaN-boxing、ARC、inline cache（属性/方法/全局）；`switch` 分发起步，需要时再上 computed goto（C 后端需支持 label-as-value 扩展开关）。
- **LLVM 后端**：**自举之后**再做。先只 emit 文本 `.ll` + 调 `llc`/`clang` 子进程（零绑定成本），原生编译器成熟后再通过 LLVM-C 做进程内 ORC JIT。锁定单一 LLVM 大版本。
- **SPIR-V**：GLSL 前端与 `vec.*` dialect 的出口，最后做。


## 7. 性能路线（分层，按里程碑逐步引入）

前置声明：本节全部属于 **P7 及以后**，即自举完成之后。stage0 阶段（JS 宿主）的性能不优化，慢也接受。

- **Cyber**：寄存器 VM 指令编码、ARC + 环检测、fiber 调度、动静混合的调用约定。
  已读源码，结论见 `docs/notes/jit-jancy-cyber.md`：值表示与 ARC 记账值得抄（→ ADR-0006/0007），
  但**它的 JIT 只是原型**（copy-and-patch 架构完整，`genStmt` 只支持 6 种语句、循环一条未实现，
  默认 `-Djit=false`），方法内联缓存也被 `if (false)` 禁用且 guard 写反 —— 不能当成熟方案参考。
  倒是 copy-and-patch（`[[clang::musttail]]` stencil + 运行时 memcpy 补洞）本身值得作为
  「比 LLVM ORC 便宜得多的 JIT 路线」备选。
- **Jancy**：**它的 JIT 不值得抄** —— `jitFunctions()` 无条件把全部函数编译一遍，没有分层、
  没有热点计数、没有 OSR，ORC 的惰性能力被立刻 lookup 全部符号抵消。真正值得抄的是它的
  错误模型降级（纯 CFG，绕开 LLVM EH，→ ADR-0007）与 safe pointer 的 IR 表示。
- **LuaJIT**：热循环 trace 记录 → 线性 SSA IR → 边优化边生成（fold / CSE / store-forward / allocation sinking）；guard + snapshot 实现精确 deopt 回 VM；后向线性扫描寄存器分配。**推到 P10，不要提前投入。**
- **Taichi**：kernel 边界 + offload pass 结构；数据布局（AOS/SoA/稀疏）与算法解耦；按实参类型做 kernel 模板特化 + AOT 模块。
- **Mojo**：comptime 解释器复用同一 VM（编译期任意求值）；参数化类型/参数化值作为泛型机制；SIMD 作为一等 stdlib 类型；ownership（borrow/inout/owned）作为 ARC 的静态优化输入。

## 8. GLSL 前端与 llvmpipe 借鉴

- GLSL 前端产出同一 OIR，但打上 `shader` dialect 标记：无指针、swizzle、`in/out/uniform` 限定符、精度限定。
- 借 llvmpipe（gallivm）三件事：
  1. **SoA 向量化**：把 scalar shader 按 4/8 宽转成 SoA，在 OIR 上做，成为通用 pass（CPU SIMD 与 GPU 都吃）。
  2. **状态键特化**：以渲染状态哈希为 key 缓存 JIT 变体（同 Taichi 的模板特化，共用一套 specialization cache）。
  3. **分块 binning 光栅化**：只作为 demo 验证端到端，不做完整驱动。
- 交付物：一个能跑 GLSL fragment shader、输出 PNG 的软件光栅 demo。

## 9. 里程碑

自举把里程碑切成三段：**先用 JS 打通最小闭环 → 尽早自举 → 自举后再铺开特性与性能。**

阶段 A：stage0（纯 JS，一次性脚手架）
- **P0 骨架（1-2 周）**：Node 20+ / ESM、零构建；SourceMap + 诊断、CST 框架、测试与基准 harness、ADR 模板。`tsc --noEmit` 作为 lint 接入 CI。
- **P1 最小闭环**：lexer + Pratt/递归下降 parser + 名字解析 + 最小类型检查 → OIR → **JS 后端**；`omni run` 用 `new Function` 执行。`fib`/闭包/struct 跑通。
- **P2 C 后端**：SSA 构造 + 通用 pass + C codegen；tcc 秒级编译验证；差分测试 JS vs C。
- **P3 自举子集冻结**：确定「写编译器够用」的 Omni 子集（`bootstrap-subset.md`），stage0 支持到此为止，随后冻结不再扩展。

阶段 B：自举
- **P4 stage1**：用 Omni 重写编译器（前端 + OIR + JS/C 后端）。
- **P5 不动点**：stage0 编译 stage1 → 原生编译器；原生编译器再编译自己得 stage2；`stage1 output == stage2 output` 即自举成功。此后 stage0 归档只读，`omni.js` 改为由编译器生成并发布到 npm + 浏览器 playground。

阶段 C：铺开（全部在自举后的编译器上进行）
- **P6 语义补全**：JS 子集前端、UFCS 全规则、安全指针/边界检查消除、reactive、dylayout、regex switch/DFA、双错误模型、comptime 求值器。
- **P7 原生 VM**：用 Omni 写寄存器 VM + NaN-boxing + ARC + inline cache；基准集（fib、nbody、binary-trees、字符串、字典）对标 Cyber/LuaJIT 建立基线。
- **P8 LLVM 后端**：先 `.ll` 文本 + 子进程，再 LLVM-C 进程内 ORC JIT/AOT；四方差分测试。
- **P9 GLSL + 向量化**：GLSL 前端、SoA pass、状态键特化缓存、软件光栅 demo、SPIR-V 出口。
- **P10 性能攻坚**：trace JIT（或先 template JIT）、allocation sinking、单态化、kernel offload/并行循环。

每个里程碑的出口条件都是「差分测试全绿 + 基准无回退 + 一个可演示 demo」，否则不进下一阶段。**P5 之前不做任何性能优化**——stage0 慢是可接受的，它的唯一使命是把 stage1 编译出来。

## 10. 测试与验证策略

- **差分执行**：同一测试用例在 `omni.js`（兼容层）/ C / 原生 VM / LLVM 上跑，结果（含异常与副作用顺序）必须一致。自举前只有 JS vs C 两方，也已经足够暴露 lowering 错误。
- **自举不动点**：`stage1 == stage2` 的字节级比对进 CI，是自举正确性的硬门槛。
- **CST 往返**：`parse → print` 必须字节级还原源码；模糊测试 parser 不允许抛未分类异常。
- **一致性语料**：Asymptote 官方示例、Jancy 语言手册用例、test262 的子集切片、glslang 测试语料。
- **基准**：微基准（算术/调用/字符串/字典/对象分配）+ 宏基准（光栅 demo、JSON 解析、协议解析）；每次提交跑，回退超阈值即失败。另外单独跟踪**编译器自身的构建时长**，这是本项目的一条硬指标（目标：全量 < 10s，增量 < 1s）。
- **诊断质量**：错误信息本身进快照测试。

## 11. 主要风险与对策

- **JS 子集 × 静态类型系统语义冲突** → 用 `dynamic` 把动态语义局限在边界；冲突点逐条写进 ADR，不靠"看情况"。
- **stage0 双实现漂移**（手写 JS 编译器 vs Omni 版编译器长期并存） → 用「冻结 + 归档」硬性切断：P3 冻结 stage0，P5 之后 stage0 只读，`omni.js` 改为生成物。**绝不允许长期同时手工维护两份编译器。**
- **自举子集蔓延** → `bootstrap-subset.md` 是白名单，往里加特性必须走 ADR；stage1 只能用白名单内的特性写。
- **ARC 环泄漏（尤其 reactive 依赖图）** → reactive 图内部用弱引用 + 可选环收集器；JS 兼容层天然规避。
- **胖指针/边界检查拖慢性能** → 边界检查消除做成 P2 就存在的 pass，并纳入基准门槛。
- **生成 C 的可移植性** → 锁 C99 + 无编译器扩展（computed goto 作为可选开关）；CI 跑 tcc / clang / gcc 三套。
- **LLVM 版本漂移** → 隔离在单一模块后面，先用子进程调用（几乎无耦合），锁版本，升级作为独立任务。
- **scope 爆炸** → 严格按里程碑冻结特性；P5 前不碰性能，trace JIT 推到 P10。
- **单人/小团队产能** → 每阶段都要有可演示产物维持反馈闭环，避免长期无输出。

## 12. 仓库骨架（P0 落地）

```
omni/
  docs/adr/                 # 架构决策记录
  docs/bootstrap-subset.md  # Omni 自举子集白名单
  docs/js-bootstrap-subset.md # JS 自举子集白名单（编译器源码只能用这些，ADR-0001 第 6 节）
  stage0/                   # 编译器（JS 实现，**不重写成 Omni 语法** —— ADR-0001 第 2 节）
    runtime/                #   C 运行时：真的 .c/.h（omni.h + 8 个 .c + 2 个宏头）
    src/source/             #   SourceMap、文件、诊断
    src/syntax/             #   CST 框架 + trivia + error recovery
    src/parse/              #   Omni 语法前端
    src/frontend-js/        #   JS 语法前端（自举入口，且永久可用）
    src/frontend-glsl/      #   GLSL 前端
    src/hir/                #   名字解析、类型系统、重载/UFCS、隐式转换
    src/oir/                #   typed SSA + region + dialect + pass 框架
    src/backend-js/
    src/backend-c/
    src/backend-llvm/
    src/comptime/           #   编译期求值
    src/vm/                 #   寄存器字节码 + 解释器 + ARC
    src/cli.js              #   omni run / run-c / build / emit-c / emit-js / repl
  dist/omni.js              # 生成物：永久兼容层
  dist/omni                 # 生成物：原生编译器（C0 -> C1 -> C2 不动点的产物）
  tests/                    # 差分测试、跨语言对照测试（oracle）、js 往返、语料、快照
  bench/
```

## 下一步

**已完成（MVP-1，2026-08-25）**：P0 骨架 + P1 最小闭环 + P2 的 C 后端骨架。
- `stage0/` 纯 JS 编译器：lexer → parser（递归下降 + Pratt + tentative decl 消歧）→ 类型检查/重载/UFCS → OIR v0 → **JS 后端 + C 后端**
- CLI：`omni run | run-c | build | emit-js | emit-c | ast | oir`
- `tests/run.js`：js/c 双后端差分 + 快照，8/8 绿；`docs/adr/0005-value-semantics.md` 钉死了 i64 回绕、`%.6g`、struct 值语义
- 端到端耗时 58ms（解析→OIR→JS→执行），全测试套件 1.3s

**已完成（MVP-2，2026-08-25）**：ADR-0006 落地顺序第 1–5 项，两个后端都完整。
- 容器：`list<T>` / `dict<K,V>`（插入序）/ `set<T>`，索引与边界检查、迭代协议 `for (T x in c)`。
  C 侧是宏模板单态化（`OMNI_LIST_*` / `OMNI_DICT_*` / `OMNI_SET_*`）：条目数组保插入序 +
  开放寻址索引表，删除打墓碑 —— 这样 JS `Map`/`Set` 的迭代顺序语义在 C 上逐位成立。
- `dynamic` + 原生 json：C 侧是带标签的胖值 `omni_dyn`；**json 解析/序列化用 Omni 自己写**
  （`stage0/lib/json.omni`），两个后端因此共享同一份实现，不存在"两边各写一遍"的漂移风险。
- `class`（引用语义 + 显式空检查）+ 方法降级为「第一参数为 this 的自由函数」+ UFCS 合并重载集。
  ARC 仍是欠账。
- `tests/cases/01..16` 全绿（含 5 个运行期错误用例）；C 侧另过 ASan/UBSan 无报告。

**已完成（可选类型与三模式，2026-08-25）**：ADR-0008。
- 四种声明形态，作用域规则各自来自出处：`int x`（C，块作用域）/ `let x`（TS，块作用域）/
  `var x`（JS，函数作用域）/ 裸 `x = e`（Python，函数作用域）。**不做类型后置**。
- 后缀选模式：`.omni` 混合 / `.omnid` 纯动态 / `.omnis` 纯静态（静态模式禁**隐式** dynamic，
  含 `list<dynamic>`）；`--mode` 可覆盖，REPL 用它。
- 推断**只在函数内**，函数签名就是接口；不做全程序推断、不做编译期隐式单态化、
  依赖安装期不编译任何东西 —— 这三条是对 Julia 编译时间失控的直接反应。
- 任意深度嵌套走 `dynamic` 一条通道，异质字面量**自上而下**降级为
  `list<dynamic>` / `dict<string,dynamic>`；不做联合类型；dict 键不降级。
- 原生 json 现在源码里不需要 `dyn()`：`j["k"]` / `j[0]` / `j.length` / `for-in` / `push` /
  `has` / `keys` 在 `dynamic` 上运行期分派，`if (j["ok"])` 直接可用（不引入 JS truthiness）。

**已完成（跨语言对照测试，2026-08-25）**：`tests/oracle/`，第二条测试轴。
- 分工：`tests/run.js`（js 后端 vs c 后端 + 快照）只能发现两边**不一致**；
  `tests/oracle/run.js`（omni vs python3/node）发现两边**一起错**。参照实现刻意用各语言的
  原生设施：Python 的 `json` 模块、`%.6g`、bignum + 显式掩码、保插入序的 `dict`、`str.encode()`。
- 6 个用例全绿：`real_format`(54 行)、`int64_wrap`(2087 行)、`json_roundtrip`(60)、
  `json_floats`(165)、`dict_order`(22)、`string_bytes`(55)。`npm run test:all` 跑两条轴。
- 当场逮到三个真问题，都是差分测试**结构上看不见**的（两个后端一起错）：
  1. JS 后端一元负号没做 i64 回绕（`-INT64_MIN`）—— bug 就在"永久兼容层"里。
  2. `repr(real)` 丢 `.0`，`real → json → real` 不保类型。现在补 `.0` 后缀（ADR-0005）。
  3. json 19 位整数静默变 `real`，snowflake ID 丢精度。现在按等长字典序比 i64 上界。
- 顺带补掉一处两边真分叉：`int(real)` 超 i64 范围时 C 是 UB、JS 静默回绕，
  现在两边都报 `real 1e+20 is out of int range`（`tests/cases/16_int_of_real.omni`）。
- `tests/run.js` 加了 host crash 检测：prelude 里一个语法错会让两个后端**一起崩**，
  差分因此"一致通过"、快照还把崩溃回溯原样存下来 —— 这个洞已经堵上。

**已完成（REPL，2026-08-25）**：`omni repl`，`stage0/src/repl.js`。
- **重放整个会话**而不是增量编译（ADR-0008 第 3 节的偏差已记录）：整体编译 → 整体执行 →
  只打增量 stdout。重放在当前语言下语义精确（可观察副作用只有 `print`）。副产品是失败的
  那一块直接不进会话，状态自动回到上次成功的样子，不需要回滚代码。
- 默认 `--mode mixed`（不是 ADR 写的 dynamic）：`dynamic` 上还没有算术，`x * x` 会报错，
  做不了乘法的 REPL 没有意义。`:mode` 可以随时切。
- 表达式回显（`1 + 2` → `3`）、括号未闭合续行、`:help :quit :list :reset :mode :js :c`。
- 测试：`tests/repl/session.in` + `.expected`，走 stdin 管道（管道输入时不打提示符，
  stdout 可以逐字节比对），已并入 `node tests/run.js`。
- 顺带修掉 `libsFor` 的一个真 bug：`/\bJson\b/` 在 `parseJson` 里匹配不上，
  所以 `j = parseJson(s)` 会报 "undefined function 'parseJson'" —— json 库根本没被拼进来。

**已知欠账（REPL 暴露出来的）**
- `dynamic` 上没有算术运算符，`.omnid` 模式因此只能做取值/索引/迭代，不能计算。
- `print` / `string()` 不支持容器：`print(list<int>)` 是编译错误，所以 REPL 里 `ys`
  回显不出来。两条都不是 REPL 的问题，但都卡着 REPL 的手感。

**已决定（自举策略，2026-08-25）**：ADR-0001。
- **语法前端加 JS 并永久可用**，不是自举脚手架；和 GLSL 前端并列，是对"前端/后端分离"
  这个架构主张最便宜的验证。
- **不用 Omni 语法重写编译器**。不动点变成：C0（node 上的编译器）用 JS 前端读自己的源码
  走 C 后端产出原生 C1，C1 再产出 C2，要求 C1 与 C2 的输出逐字节相同。
  这比重写省一整轮，而且同时证明 JS 前端 / 类型检查 / C 后端三者在自己身上一致。
- **js → 解析 → 生成 js 要做**，虽然是恒等变换：它是前端唯一的免费 oracle
  （幂等 + 语义一致），否则前端的 bug 只会在几万行生成的 C 里以段错误现身。第三条测试轴。
- **C 路径性能底线**：不比 JS 宿主慢**一个数量级**。只做必要优化：热叶子 static inline（已做）、
  字符串 builder（不能让拼接退化成 O(n²)）、arena 分配（编译器是批处理，比先上 ARC 简单也更快）、
  `-O2`。明确不做 NaN boxing / 内联缓存 / Grisu / profile 反馈类优化。
- **JS 自举子集是闸门**：覆盖不到就改编译器源码，不扩前端。量过 4485 行的实际用量，
  正则只有 4 个字符类（不是拦路虎），真正要支持的是模板字符串、Map/Set、数组方法、解构、展开。

**已完成（运行时出 JS，2026-08-25）**：ADR-0001 第 5 节。
- `stage0/runtime/`：`omni.h` + 8 个 `.c` + 2 个宏头，都是真的 C 文件（clang 能查、ASan 能扫、
  能贴 godbolt、能单独编）。每个 TU 单独过 `-Wall -Wextra` 零警告。
- 热叶子函数（i64 回绕算术、`byte_at`、dict 的 hash/eq）是 `omni.h` 里的 `static inline`：
  拆成多 TU 后跨 TU 调用没有 LTO 就不内联，而 tcc 不支持 `-flto`。
- `emit-c --amalgamate` 拼成单文件（ASan / godbolt 用）；运行时 `.o` 缓存实测 757ms → 73ms。
- 拆分没让 C 路径变慢：`bench/compare.js` 的 c 后端 282ms → **151ms**（原生二进制本身 5ms）。

**接下来**（顺序按 ADR-0001 的落地顺序重排）
1. **JS 语法前端第一版**：`stage0/src/frontend-js/`，先能解析 `stage0/src` 全部文件。
2. **`tests/js-roundtrip/`**：幂等（`gen(parse(x))` 再往返一次逐字节相同）+ 语义一致
   （原始 js 与生成 js 在 node 下输出相同）。
3. **字符串 builder + arena**（ADR-0001 第 4 节）—— 自举前必须有。
4. **打通 C0 → C1 → C2，验不动点**（C1 与 C2 产出的 C 逐字节相同）。
5. 写 `docs/js-bootstrap-subset.md`，冻结 JS 自举子集。
6. `dynamic` 的算术与 `print`/`string()` 的容器支持（上面两条欠账）—— 做完这两条，
   `.omnid` 才算真能用，REPL 默认模式也就能按 ADR-0008 改回 `dynamic`。
7. **ARC**（ADR-0006 落地顺序第 4 项的欠账）：按 ADR-0007 的一张编译期 unwind 表
   （`pc → 存活的 owned 槽位`）同时服务错误路径释放与 GC 根枚举。当前 C 侧只分配不释放。
   注意 ADR-0001 把它从"自举前置"降级了：编译器用 arena 就够，ARC 的价值在长期运行的程序上。
2. tagged union + 模块系统（`cli.js` 的 `libsFor` 拼库是显式临时方案，有 `import` 后删掉；
   模式也要从"整程序"改成"按文件"），然后闭包 / 函数值。
3. OIR 升级为 SSA + dialect 分层（P2 的真正内容），此时才开始写优化 pass。
4. 补 `docs/adr/0002-ir-strategy.md`、`0003-memory-model.md`、`0004-ufcs-resolution.md`
   （`0001-bootstrap-strategy.md` 已写）。
5. 语法调研：Asymptote 与 Jancy 的冲突点（声明语法、运算符、`import` 语义）对照表 → Omni v0 语法定稿。
6. tcc 在本机无 bottle（`brew install tcc` 失败），暂用 clang；需要毫秒级 C 编译时从
   `reference/tinycc` 源码构建。运行时 `.o` 缓存之后 `bench` 的 c 一路降到 151ms，
   剩下的仍然基本是 clang `-O2` 编译生成代码的时间（原生二进制本身 5ms）。
