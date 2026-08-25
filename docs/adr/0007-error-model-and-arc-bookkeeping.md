# ADR-0007：错误传播与 ARC 记账共用一张编译期表

状态：已接受（2026-08-25）· 依据：`docs/notes/jit-jancy-cyber.md` §1.5、§2.4

## 背景

Omni 要在四个后端（C / JS / 寄存器 VM / LLVM）上跑同一份 OIR，同时要支持 Jancy 的双错误模型
（调用点选 errorcode 还是异常语义），并且内存管理是 ARC。这三件事在实现上会在同一个地方交汇：
**异常/错误路径上必须释放已经 retain 的局部值**。

## 决定 1：错误传播只做静态降级，不用宿主的异常机制

Jancy 的经验（notes §1.5）：它的双错误模型**完全绕开了 LLVM 的 EH** —— 静态路径就是
`icmp ne retval, -1` + `br` 到错误块，没有 `invoke`、没有 personality 函数、没有 unwind table，
判据是一个编译期谓词 `canStaticThrow()`（`Scope.h:140-143`）。动态路径才退到 SJLJ + `longjmp`。

**决定：Omni 只实现静态路径。** 错误传播在 OIR 里就是普通控制流（检查 + 跳转到错误块）。

理由是多后端约束直接推出来的：
- C 后端：不需要 `setjmp`/`longjmp`，也不需要依赖编译器的 `__try`
- JS 后端：不需要把 Omni 的错误映射到 JS `throw`（映射会污染栈、破坏跨后端一致性）
- VM：不需要额外的 unwind 机制
- LLVM：不需要 personality / landing pad，也就绕开了「不同平台 EH ABI 不同」的坑

代价：不能在任意深度的调用栈上做非局部跳转（Jancy 用 SJLJ 覆盖的那部分）。可接受 —— 用显式的
错误返回 + 传播来表达，这本来也是 errorcode 语义的一半。若将来确实需要，再单独开 ADR。

## 决定 2：一张编译期 unwind table，同时服务错误路径释放与根枚举

Cyber 里最值得抄的结构性决定（notes §2.4，`arc.zig:104-133` 与 `:329-370`）：编译期为每个函数
构造「pc → 当前活跃的、已 retain 的 slot 链表」，这张表**同时**被两件事使用：
1. 错误传播时按表释放活跃 slot
2. GC 精确枚举根

关键性质：**正常路径零指令** —— 表是静态数据，只在出错或 GC 时查。

**决定**：OIR 在函数级别产出同一张表（`pc/block -> live owned slots`），供：
- 错误路径的批量 release
- 将来可选的环收集器做精确根枚举
- 将来的 deopt（VM ↔ JIT）复用同一套 slot 活跃性信息

这条决定的意义在于**不要让这三个需求各自长一套元数据**。Jancy 就是反例：它手写了一套按 scope
分层的 shadow stack frame map（notes §1.2.2），完全不用 LLVM 的 `gc.statepoint`/StackMap，于是
GC 元数据与错误路径元数据是两套东西。

## 决定 3：safepoint 的页保护技巧登记但不采用

Jancy 用 `mprotect(PROT_NONE)` 打 guard page 实现 stop-the-world，空指针检查也用页保护代替分支
（notes §1.2.1、§1.3.3）。技巧很漂亮，但：
- 依赖 POSIX/Windows 各自的信号/SEH 机制，与「四后端一致」冲突（JS 后端根本无法表达）
- ARC 不需要 stop-the-world

**决定**：不采用。登记在案，只在将来引入并发环收集器时重新评估。

## 待跟进（研究未能确定，不要假设）

1. **Cyber 的 C backend 是否发射 ARC 未知** —— `cgen.zig`（1854 行）里搜不到 retain/release。
   Omni 明确要「C 后端 + ARC」，这块没有可参考的先例，需要单独读一遍或自己定方案。
   这是当前最大的参考空白。
2. Cyber 的 `initInt` 存 64 位而 `VALUE_AS_INTEGER` 按 48 位读，大于 2^47 的整数经 `addInt`
   是否被截断未验证 —— 与 ADR-0006「不上 NaN-boxing」的判断方向一致，但不作为证据引用。
