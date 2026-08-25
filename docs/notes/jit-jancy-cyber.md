# Jancy 与 Cyber 执行/JIT 层源码研究笔记

面向 Omni 设计（register bytecode VM + ARC + C backend + 后续 LLVM/trace JIT）的对比研究。

阅读版本：本地 `/Users/wurui/Documents/Lang/reference/jancy` 与 `/Users/wurui/Documents/Lang/reference/cyber` 工作副本（两者均非 git 仓库，无法给出 commit）。所有行号引用均基于这两份副本的当前内容。

一句话对比：Jancy 是「AOT 编 LLVM IR → 整模块 JIT 一次成型 → 运行时靠 guard page safepoint + shadow stack 做精确 GC」；Cyber 是「变长字节码 + computed-goto C 解释器 + 静态类型驱动的 ARC + 尚未完工的 copy-and-patch JIT」。

---

## 第一部分：Jancy

### 1.1 LLVM 的使用方式

#### 1.1.1 三套并存的 JIT 后端，抽象在一个基类之后

Jancy 把 JIT 抽象成 `jnc::ct::Jit` 基类，接口只有 6 个虚函数：`create(optLevel)` / `mapVariable` / `mapFunction` / `prepare` / `jit(Function*)` / `getStaticData` / `finalizeObject`（`src/jnc_ct/jnc_ct_Module/jnc_ct_Jit.h:25-130`）。

三个实现：

| 后端 | 文件 | LLVM API |
|---|---|---|
| `LegacyJit` | `jnc_ct_LegacyJit.cpp:11-85` | 老 `ExecutionEngine`（`setUseMCJIT(false)`，见 `:67`） |
| `McJit` | `jnc_ct_McJit.cpp:60-117` | `EngineBuilder` + MCJIT + `SectionMemoryManager` |
| `OrcJit` | `jnc_ct_OrcJit.cpp:104-164` | ORC v2：`ExecutionSession` / `IRCompileLayer` / `RTDyldObjectLinkingLayer` |

`LegacyJit` 与 `McJit` 共享一个中间基类 `ExecutionEngineJit`，它持有 `llvm::ExecutionEngine*`，`jit()` 直接调 `getPointerToFunction(function->getLlvmFunction())`（`jnc_ct_Jit.h:150-155`），`finalizeObject()` 调 `ExecutionEngine::finalizeObject()`（`:157-162`）。

后端选择在 `Module::createJit()`（`jnc_ct_Module.cpp:569-603`）；默认值在 `Module::initialize()`：Windows 且编译进了 legacy 后端时用 `JitKind_Legacy`，否则用 `JitKind_McJit`（`jnc_ct_Module.cpp:185-190`）。ORC **不是默认**，需要命令行显式指定（`src/jnc_app/CmdLine.cpp:96-109`）。

#### 1.1.2 ORC 后端的具体构造

`OrcJit::create()`（`jnc_ct_OrcJit.cpp:104-164`）的步骤：

1. `SelfExecutorProcessControl::Create()` → `new llvm::orc::ExecutionSession(std::move(*llvmEpc))`（`:120-127`；LLVM < 13 走无参构造 `:118`）。
2. `JITTargetMachineBuilder::detectHost()`，然后 `setCodeGenOptLevel`（`:129-135`）。
3. 取 `getDefaultDataLayoutForTarget()`，建 `MangleAndInterner`，并把 DataLayout 写回 `llvm::Module`（`:137-145`）。
4. `createBareJITDylib(moduleName)`，挂一个自定义 `DefinitionGenerator`（`:147-148`）。
5. `RTDyldObjectLinkingLayer`（每个对象一个 `SectionMemoryManager`）→ `IRCompileLayer` + `ConcurrentIRCompiler`（`:150-161`）。

外部符号解析走 `JitDefinitionGenerator::tryToGenerate`（`jnc_ct_OrcJit.cpp:34-61`）：把 lookup set 里能在自己的 `m_symbolMap` 里找到的名字，用 `llvm::orc::absoluteSymbols` 一次性 `JD.define()`。LLVM 17 前后分别用 `JITEvaluatedSymbol` 和 `ExecutorSymbolDef`（`:47-57`）。

`OrcJit::prepare()`（`:166-184`）把 `llvm::Module` + `LLVMContext` 的所有权包进 `ThreadSafeModule`，再 `cloneToNewContext` 后 `IRCompileLayer::add(...)`。`jit()` / `getStaticData()` 都只是 `ExecutionSession::lookup()` 的封装（`:239-261`）。

#### 1.1.3 MCJIT 后端的细节与几个「踩坑注释」

`McJit::create()`（`jnc_ct_McJit.cpp:60-117`）值得注意的点：

- `optLevel == 0` 时打开 `targetOptions.EnableFastISel`（`:83-84`）——O0 追求编译速度。
- **显式关闭 CPU 特性自动探测**：`engineBuilder.setMCPU("generic")`，注释写明「使用某些 CPU 特性会导致 JIT 崩溃（如 test114.jnc）」（`:102-108`）。
- 内存管理器 `JitMemoryMgr` 继承 `llvm::SectionMemoryManager`，重写 `getSymbolAddress` / `getPointerToNamedFunction` 转发到 `Jit::findSymbol`，解析失败时 `llvm::report_fatal_error`（`jnc_ct_McJit.cpp:9-56`）。
- ARM 上必须关掉 `GlobalMerge` pass，否则会让 `GlobalVariable::m_llvmVariable` 指针失效（`jnc_ct_McJit.cpp:64-69`，实现在 `jnc_ct_Jit.cpp:55-70`，通过 `llvm::cl::getRegisteredOptions()` 找到 `global-merge` 选项并置 false——这是一个相当 hacky 的做法）。

`LegacyJit` 里有一段针对 Windows x64 的手写 shellcode：Windows 10 把 ntdll.dll 装得太远，legacy JIT 发出的相对 `call __chkstk` 越界，于是在 JIT 内存里分配 128 字节，手写 `mov r11, imm64; jmp r11`（字节 `0x49 0xbb ... 0x41 0xff 0xe3`）作为近距离跳板，再 `DynamicLibrary::AddSymbol("__chkstk", p)`（`jnc_ct_LegacyJit.cpp:31-65`）。注释自嘲「legacy JIT is a gonner anyway」。

#### 1.1.4 是否惰性编译：不是

这是本次调查里最重要的结论之一。`Module::jit()`（`jnc_ct_Module.cpp:605-632`）流程是：

```
compile() → createJit() → m_extensionLibMgr.mapAddresses() → m_jit->prepare() → m_functionMgr.jitFunctions()
```

`FunctionMgr::jitFunctions()`（`jnc_ct_FunctionMgr.cpp:727-763`）是一个**无条件遍历全部函数**的循环：

```cpp
sl::Iterator<Function> it = m_functionList.getHead();
for (; it; it++)
    if (!it->isEmpty()) {
        void* p = m_module->m_jit->jit(*it);
        ...
        it->m_machineCode = p;
    }
m_module->m_jit->finalizeObject();
```

也就是说：**没有惰性/按需编译，没有分层，没有热点计数**。整个模块在一次 `jit()` 调用里全部物化，函数地址存入 `Function::m_machineCode`。整个 JIT 过程包在 `llvm::ScopedFatalErrorHandler` 里，把 LLVM 的 fatal error 转成 C++ 异常再转成 Jancy 错误（`:734-751`）。收尾还会检查 `m_requiredExternalFunctionArray` 里是否有未解析的必需外部函数（`:753-760`）。

（ORC 的 `IRCompileLayer` 本身具备惰性能力——符号首次 lookup 才编译——但 Jancy 立刻对所有函数做 lookup，实际上把惰性抵消掉了。`LegacyJit` 的 `getPointerToFunction` 同理。）

优化 pipeline 用新 PassManager：`PassBuilder` + `buildPerModuleDefaultPipeline(O0..O3)`（`jnc_ct_Module.cpp:541-565`）。

#### 1.1.5 全局变量映射的技巧

宿主要把 C++ 侧的静态数据地址绑到脚本的全局变量上。`Jit::createLlvmGlobalVariableMapping()`（`jnc_ct_Jit.cpp:146-167`）的做法：新建一个同类型、名字加 `.mapping` 后缀、linkage 为 `ExternalWeakLinkage` 的 `GlobalVariable`，`replaceAllUsesWith` 原变量后把原变量 `eraseFromParent()`。之后这个外部弱符号由 `findSymbol` 解析。这样 MCJIT/ORC 的对象链接阶段就能填入真实地址，不需要 `addGlobalMapping`（MCJIT 分支里 LLVM ≥ 4.0 仍额外调了一次 `addGlobalMapping`，`jnc_ct_McJit.cpp:142-145`）。

`findSymbol` 会处理平台符号前缀：Win32 x86 去掉 `_`，其他平台去掉 `_` 或 `?`（`jnc_ct_Jit.cpp:74-92`）。`addStdSymbols()`（`:94-143`）手工注册 `memset/memcpy/memmove`、`__chkstk`、以及 32 位平台的 compiler-rt 辅助函数（`__divdi3`、ARM 的 `__aeabi_*` 一大堆）——因为 JIT 环境里没有链接器帮你找 libgcc。

另外：LLVM 15/16 上显式关闭了 opaque pointer 模式 `m_llvmContext->setOpaquePointers(false)`（`jnc_ct_Module.cpp:203-205`），说明代码库仍依赖 typed pointer。

### 1.2 GC 与 JIT 代码的交互

Jancy 用的是**精确、stop-the-world、mark-sweep** GC，与 JIT 代码的接口有两条：safepoint 和 shadow stack。**它完全没有使用 LLVM 的 `gc.statepoint` / `llvm.gcroot` / StackMap 机制**——我在 `src/` 下搜索 `statepoint`、`gcroot`、`StackMap`、`setGC` 均无命中（唯一的 `gcroot` 命中是两处普通注释，`jnc_ct_ClassType.cpp:352` 和 `jnc_ct_StructType.cpp:156`）。GC root 信息全部由前端自己维护在一个手写的 shadow stack 里。

#### 1.2.1 Safepoint：默认用 guard page，可降级为函数调用

发射点在 `OperatorMgr::gcSafePoint()`（`jnc_ct_OperatorMgr_Call.cpp:551-578`），两种模式：

**模式 A（默认，guard page）**：加载全局变量 `jnc.g_gcSafePointTrigger`（一个 `void*`，定义在 `jnc_ct_VariableMgr.cpp:91-95`），然后对它指向的地址做一次 `AtomicRMWInst::Xchg`，ordering 为 `AcquireRelease`（`:560-576`）。也就是每个 safepoint 只有「一次 load + 一次 atomic xchg」，无分支。

运行时侧：GC 启动时分配一页 4KB 的 guard page，并把它的地址写进那个全局变量的静态数据（`jnc_rt_GcHeap.cpp:79-81` 分配，`:128-133` 写入）。`stopTheWorld_l()` 把这一页 `protect(PROT_NONE)`（POSIX，`:1299-1307`）或 `PAGE_NOACCESS`（Windows，`:1290-1298`），于是所有 mutator 线程下一次跑到 safepoint 就会吃到 SIGSEGV / access violation，信号/异常处理器调用 `GcHeap::handleGuardPageHit()` → `parkAtSafePoint()`（`:1766-1774`）。`resumeTheWorld()` 再改回可读写（`:1324-1331`）。

`parkAtSafePoint()`（`:1718-1743`）是标准的 handshake：`atomicDec(&m_handshakeCount)`，归零则 signal `m_handshakeEvent`，然后等 `m_resumeEvent`，恢复时再 dec 一次做第二轮 handshake。若期间设了 `Flag_Abort`，直接 `abortThrow()`（`:1745-1762`，通过 SJLJ longjmp 把脚本执行强行中断）。

**模式 B（`ModuleCompileFlag_SimpleGcSafePoint`）**：直接 `call jnc.gcSafePoint`（`jnc_ct_OperatorMgr_Call.cpp:556-558`），运行时 `GcHeap::safePoint()`（`jnc_rt_GcHeap.cpp:1001-1010`）检查状态并 park。这条路在 ASan 下被强制启用，因为 guard page 方案与 address sanitizer 不兼容（`jnc_ct_Module.cpp:196-199`）。

Safepoint 的插入位置：三个循环回边（`jnc_ct_ControlFlowMgr_Stmt.cpp:470`、`:507`、`:593`），以及可选的函数序言——由 `ModuleCompileFlag_GcSafePointInPrologue` / `GcSafePointInInternalPrologue` 控制（`jnc_ct_FunctionMgr.cpp:229-230`、`:403-404`），默认不开。

#### 1.2.2 Shadow stack 与 frame map

运行时结构（`include/jnc_RuntimeStructs.h:243-247`）：

```c
struct jnc_GcShadowStackFrame {
    jnc_GcShadowStackFrame* m_prev;
    jnc_GcShadowStackFrameMap* m_map;
    void** m_gcRootArray;   // 指向栈上数组
};
```

每个需要 GC root 的函数在栈上有一个这样的 frame，加一个 `void*` 数组。链表头是 TLS 变量 `StdVariable_GcShadowStackTop`。

编译期的核心是 `GcShadowStackMgr`（`jnc_ct_GcShadowStackMgr.h` / `.cpp`）。关键设计是 **frame map 按 scope 分层，而不是按指令位置**：

- `markGcRoot(ptrValue, type)`（`jnc_ct_GcShadowStackMgr.cpp:89-116`）：分配一个 slot index，发射 `GEP + bitcast + store`，把该 root 的地址写进 `m_gcRootArray[index]`；同时在当前 scope 的 `GcShadowStackFrameMap` 里记下 `(index, type)`。
- `openFrameMap(scope)`（`:118-152`）：为 scope 新建一个 frame map，并把「设置 map」的调用插到 **scope 起始处**（用保存的 `m_gcShadowStackFrameMapInsertPoint` 回溯插入点）。
- `setFrameMap()`（`:154-171`）发射 `call jnc.setGcShadowStackFrameMap(frame, mapPtr, op)`，`op ∈ {Open, Close, Restore}`。注意 map 指针是**编译期 C++ 对象地址**直接当立即数嵌进代码里的（`Value(&frameMap, ByteThinPtr)`，`:167`）。
- `finalizeFrame()`（`:186-308`）在函数结束时做几件事：
  - 在 prologue 真正 alloca 大小已知的 root 数组，用 `replaceAllUsesWith` 替换掉之前的占位 alloca 再 `eraseFromParent`（`:199-214`）。这是典型的「先发射占位、后回填」技巧。
  - 初始化 frame 的三个字段，把 frame 挂进 `g_gcShadowStackTop`（`:216-260`）。
  - **在每个 `ret` 之前恢复上一个 stack top**：遍历 `getReturnBlockArray()`，在 `ReturnInst` 前插 store（`:262-273`）。
  - 计算各 frame map 的 `m_prev`（按 scope 父子关系，`:276-283`）。
  - **在每个 landing pad 处恢复 frame pointer 和 frame map**（`:285-303`）——因为 SJLJ longjmp 回来后栈顶指针是脏的。
  - async 函数（`FunctionKind_AsyncSequencer`）走另一条路：frame 存进 promise 对象的 `m_gcShadowStackFrame` 字段，而不是链进 TLS（`:236-246`）。

运行时侧 `GcHeap::setFrameMap()`（`jnc_rt_GcHeap.cpp:1205-1240`）非常轻：
- `Open`：只把该 map 涉及的那几个 slot 清零（不是清整个数组），然后 `frame->m_map = map`。
- `Close`：`frame->m_map = map->getPrev()`（附带一个 assert 用来抓 scope 关闭顺序错误，`:1229`）。
- `Restore`：直接赋值。

标记阶段 `GcHeap::addShadowStackFrame()`（`:1563-1594`）沿 `m_map` 的 `getPrev()` 链走，对 static map 用 `(indexArray, typeArray)` 取出 `frame->m_gcRootArray[j]` 并 `addRoot(p, type)`；对 dynamic map（call-site 场景）直接拿 `Box*` 数组标记。之后 `runMarkCycle()`（`:1596-1621`）以广度优先方式驱动 `Type::markGcRoots`，双缓冲 root 数组交替。

Dynamic frame map 用于宿主进入脚本的 call site：`Runtime` 在 `CallSite` 里就地 placement-new 一个 `GcShadowStackFrameMap`，标为 `Dynamic`，并把它链进 TLS 栈顶（`jnc_rt_Runtime.cpp:100-139`）。`GcShadowStackFrameMap` 的析构函数会把所有 `BoxFlag_CallSiteLocal` 的 box 标记为 `BoxFlag_Invalid`（`jnc_ct_GcShadowStackMgr.cpp:22-34`），实现 call-site 局部句柄的失效。

**代价评估**：这套方案对 LLVM 完全透明（root 只是普通 alloca + store），所以任何优化 pass 都不会破坏它；但代价是每个 scope 边界一次外部函数调用（`jnc.setGcShadowStackFrameMap` 不可内联，因为它是映射到宿主的外部符号），以及每个 root 一次 store。相比 LLVM statepoint + stack map，运行时开销大，但实现和维护成本低得多，且不受 LLVM 版本变动影响。

### 1.3 Safe pointer（fat pointer）的 LLVM IR 表示

#### 1.3.1 三种指针种类

`DataPtrTypeKind` 只有三个值（`include/jnc_Type.h:324-329`）：`Normal`、`Lean`、`Thin`。

`DataPtrType::prepareLlvmType()`（`jnc_ct_DataPtrType.cpp:111-121`）：
- `Normal` → `StdType_DataPtrStruct` 的 LLVM 类型（两字宽结构体）。
- `Lean` / `Thin` → 普通机器指针（单字）。

`DataPtrStruct` 的构造（`jnc_ct_TypeMgr.cpp:2022-2028`）：

```cpp
StructType* type = createInternalStructType("jnc.DataPtr");
type->createField("!m_p", getStdType(StdType_ByteThinPtr));
type->createField("!m_validator", getStdType(StdType_DataPtrValidatorPtr));
```

对应的 C 结构（`include/jnc_RuntimeStructs.h:94-97`、`:103-115`）：

```c
struct jnc_DataPtr {
    void* m_p;
    jnc_DataPtrValidator* m_validator;
};

struct jnc_DataPtrValidator {
    jnc_Box* m_validatorBox;
    jnc_Box* m_targetBox;
    const void* m_rangeBegin;
    const void* m_rangeEnd;
};
```

关键点：**fat pointer 只有 2 个字**（指针 + validator 指针），范围信息不内嵌，而是间接放在一个共享的 validator 对象里。多个指向同一块内存的指针共享同一个 validator，所以「取地址、传参、存字段」这些操作只搬 16 字节。代价是每次边界检查多一次间接寻址。

`Box` 头（`:77-87`）是 `Type* m_type` + 位域 `m_flags:10` + `m_rootOffset:54`（32 位下 22 位），共两字。`DataBox = Box + DataPtrValidator + 实际数据`（`:143-148`），`DetachedDataBox` 多一个 `void* m_p` 用于静态/外部数据（`:150-154`）。

#### 1.3.2 边界检查的发射与省略

全部集中在 `OperatorMgr::checkDataPtrRange()`（`jnc_ct_OperatorMgr_CheckPtr.cpp:61-131`）。**这里有四层省略（elision）**：

1. **整块跳过**（`:68-71`）：处于 `unsafe` 区域内、或指针类型带 `PtrTypeFlag_Safe`、或是 `Thin` 指针 → 直接 `return true`，不发射任何检查。

2. **Lean 指针 + 编译期已知范围 → 常量折叠成「直接检查」**（`:82-114`）：`Lean` 指针在编译期由 `LeanDataPtrValidator`（`jnc_ct_Value/jnc_ct_LeanDataPtrValidator.h:25-80`）跟踪，它持有 `m_originValue` / `m_rangeBeginValue` / `m_rangeLength` / `m_validatorValue`。若 `!isDynamicRange() && !hasValidatorValue()`，则范围长度是编译期常量，于是：
   - 若 `rangeLength < targetSize`，**直接报编译错误** `"'%s' fails range check"`（`:91-94`）——静态越界在编译期就被拒。
   - 否则发射 `CheckDataPtrRangeDirect(ptr, rangeBegin, rangeLength - targetSize)`，三个参数里两个是常量，运行时函数不需要解引用 validator。

3. **其余情况走间接检查**（`:117-128`）：`CheckDataPtrRangeIndirect(ptr, targetSize, validator)`。`Normal` 指针从结构体里 `extractvalue 0/1` 取出 p 和 validator（`:78-80`）。

4. **抛出方式的选择**（`checkPtr`，`:22-59`）：如果当前 scope `canStaticThrow()`，用返回 errorcode 的 `TryCheck*` 变体并接一段 `checkErrorCode`；否则用不返回值、内部直接 dynamic throw 的 `Check*` 变体。这样在不需要 unwind 的上下文里，检查调用是一个纯 void call，寄存器压力更小。

`Lean` 指针的 validator 传播规则见 `Value::setLeanDataPtrValidator` 的三个重载（`jnc_ct_LeanDataPtrValidator.h:95-131`）：从另一个值继承 validator、从变量取变量自己的 validator、或新建一个带 `(origin, rangeBegin, rangeLength)` 的 validator。这是一个纯编译期的数据流传播，没有 IR 开销。

#### 1.3.3 空指针检查的技巧

`checkNullPtr()`（`jnc_ct_OperatorMgr_CheckPtr.cpp:133-150`）不发射比较+分支，而是**故意做一次解引用**：bitcast 成一个静态 sink 变量的指针类型，`load` 一下，再把结果 `store` 回那个 sink 变量。注释说明 store 到 sink 是为了防止 load 被优化掉（`:143-144`）。空指针会自然触发 SIGSEGV，由 SJLJ 信号处理器转成脚本异常。**用硬件页保护代替显式分支**——和 safepoint 用 guard page 是同一个思路。

### 1.4 调用约定 / C ABI 桥接、thunk、闭包

#### 1.4.1 CallConv 抽象

`CallConvKind` 枚举（`jnc_ct_CallConv.h:27-75`）是「族 × 平台」的笛卡尔积：`Jnccall` / `Cdecl` 各 6 个平台变体（msc32/msc64/gcc32/gcc64/arm32/arm64），加 `Stdcall_msc32` / `Stdcall_gcc32` / `Thiscall_msc32`。默认是 `CallConvKind_Jnccall`（`:74`）。

`jnccall` 的定义在文件头注释里说得很清楚（`:23-25`）：

> jnccall is basically cdecl with the following 2 differences:
> - arrays are passed by value (like if it were wrapped in a struct)
> - varargs are wrapped into variants and prepended with vararg count

映射到 LLVM 的 calling convention 时（`jnc_ct_CallConv.cpp:24-40`），**所有 jnccall 和 cdecl 变体都映射为 `llvm::CallingConv::C`**，只有 stdcall/thiscall 映射为 `X86_StdCall` / `X86_ThisCall`。也就是说 jnccall 与 C ABI 在机器层面是同一个约定，差异全部在前端的参数打包逻辑里处理。

`CallConv` 基类（`jnc_ct_CallConv.h:119-233`）的虚函数覆盖了 ABI 的全部环节：`prepareFunctionType`（决定 LLVM 函数签名）、`createLlvmFunction`（加 attribute）、`call` / `ret`（调用点与返回点的打包/解包）、`getThisArgValue` / `getArgValue` / `getArgValueArray` / `createArgVariables`（被调用方的参数取用）。

#### 1.4.2 SysV amd64 结构体传递的手工实现

`CdeclCallConv_gcc64::prepareFunctionType()`（`jnc_ct_CdeclCallConv_gcc64.cpp:35-105`）**手工实现了 SysV 分类算法的简化版**：

- 维护 `argRegCount = 6`（rdi/rsi/rdx/rcx/r8/r9）计数（`:39`）。
- 返回值若带 `TypeFlag_StructRet`：`> 16` 字节 → 插入首个 sret 指针参数、返回类型改 void、可用寄存器减一（`:52-60`）；`≤ 16` 字节 → coerce（`:62`）。
- 参数逐个分类：非结构体直接用原类型；结构体 `> 16` 字节或寄存器不够 → 标 `ArgFlag_ByVal` 并改成指针传（`:80-83`）；否则标 `ArgFlag_Coerced`（`:84-88`）。
- `getArgCoerceType()`（`:22-32`）：`≤ 8` 字节 → `i64`，否则 → `{i64, i64}`（`StdType_Int64Int64`）。**这里有一个显式的 `AXL_TODO("implement proper coercion for structures with floating point fields")`（`:23`）** —— 含浮点字段的小结构体不会被分类到 SSE 寄存器，属于已知的 ABI 不完备。

调用点（`:201-227`）用 `addTypedAttribute(..., Attribute::ByVal / StructRet, type)` 补齐 attribute，coerce 的通过 `OperatorMgr::forceCast` 做位级重解释；返回点（`:229-250`）对 sret 情况 store 到隐藏参数、对 coerce 情况 forceCast 后 ret。被调用方 `getArgValue()`（`:267-287`）根据 flag 反向操作：ByVal → `load`，Coerced → `forceCast`。所有需要跳过隐藏 sret 参数的地方都要 `llvmArg++`（`:259-262`、`:310-313`、`:296-302`）。

#### 1.4.3 「带闭包的函数指针」

Jancy 的 `function*` 是两字 fat pointer（`include/jnc_RuntimeStructs.h:123-126`）：

```c
struct jnc_FunctionPtr {
    void* m_p;
    jnc_IfaceHdr* m_closure;
};
```

`property*` 同构，只是第一个字是 vtable（`:134-137`）。`IfaceHdr` 是 `{ const void* m_vtable; jnc_Box* m_box; }`（`:160-165`）。

闭包本身被实现成**一个编译期合成的 class**：`ClosureClassType`（`jnc_ct_ClosureClassType.cpp`）。核心是 `m_closureMap`——一个 `size_t` 数组，记录「目标函数的第 i 个参数来自闭包字段还是来自 thunk 参数」。`buildArgValueList()`（`:53-87`）就是按这张 map 交错地从闭包字段和 thunk 参数里取值拼出实参列表：

```cpp
if (i == m_closureMap[iClosure]) {
    getClassField(closureValue, this, m_fieldArray[fieldIdx], NULL, &argValue);  // 来自闭包
    fieldIdx++; iClosure++;
} else {
    argValue = thunkArgValueArray[iThunk]; iThunk++;                              // 来自调用方
}
```

所以 Jancy 的闭包支持**任意位置的参数绑定**（partial application），不限于「第一个参数是 this」。`FunctionClosureClassType::compileThunkFunction()`（`:109-143`）生成 thunk 函数体：取 this → 从字段 0 取出目标函数指针 → `buildArgValueList` → `callOperator` → `ret`。

`ClosureClassType::strengthen()`（`:89-100`）处理弱引用闭包：如果闭包里存了 `this`（`m_thisArgFieldIdx != -1`），调用 `jnc::strengthenClassPtr` 尝试提升，失败返回 NULL。

#### 1.4.4 Thunk 函数

`ThunkFunction::compile()`（`jnc_ct_ThunkFunction.cpp:26-82`）负责签名适配（协变/逆变、fat→thin 转换）。三个要点：

- **fat → thin 时跳过第一个 closure-this 参数**：判断条件是「thunk 首参是 `StorageKind_This` 而目标首参不是」（`:44-48`）。
- **裁掉多余参数**：`if (argCount > j + targetArgCount) argCount = j + targetArgCount;`（`:50-51`）——允许把多参函数指针赋给少参签名。
- 每个参数都过一遍 `castOperator` 做隐式转换（`:57-61`）。

Thunk 由 `FunctionMgr::getDirectThunkFunction()` 按需创建并缓存（`jnc_ct_FunctionMgr.cpp:426-465`），命名为 `jnc.directThunkFunction`。属性也有对应的 `ThunkProperty` / `DataThunkProperty`（`jnc_ct_ThunkProperty.cpp`），后者把一个数据指针包装成 getter/setter（`jnc_ct_ClosureClassType.cpp:267-310`）。

### 1.5 双错误模型（errorcode vs throw）的 LLVM IR 降级

Jancy 的错误处理是「**一套语法，两套降级路径**」。选择的判据是 `Scope::canStaticThrow()`（`jnc_ct_Scope.h:140-143`）：

```cpp
bool canStaticThrow() {
    return canCatch() || (m_function->getType()->getFlags() & FunctionTypeFlag_ErrorCode);
}
```

即：当前 scope 里有 `catch`，**或者**当前函数的返回类型被声明为 errorcode。

#### 1.5.1 静态路径（zero-cost，纯 CFG）

`ControlFlowMgr::throwException()`（`jnc_ct_ControlFlowMgr_Eh.cpp:89-110`）：

```cpp
Scope* catchScope = m_module->m_namespaceMgr.findCatchScope();
if (catchScope) {
    escapeScope(catchScope, catchScope->getCatchBlock());   // 直接跳到 catch block
} else {
    // 函数是 errorcode 函数：ret 一个错误值
    Value throwValue = currentFunctionType->getReturnType()->getErrorCodeValue();
    ret(throwValue);
}
```

错误值的编码在 `Type::getErrorCodeValue()`（`jnc_ct_Type.cpp:310-321`）：`bool` 或非整数类型 → 零值；整数类型 → `-1`。

调用方的检查在 `ControlFlowMgr::checkErrorCode()`（`jnc_ct_ControlFlowMgr_Eh.cpp:245-290`）：
- 构造 indicator：bool/非整数直接用返回值本身；整数则发射 `icmp ne retval, -1`（`:255-265`）。
- `canStaticThrow()` 为真 → 建一个 `static_throw_block`，条件跳转过去，在里面递归调 `throwException()`（`:281-289`）。
- 为假 → 条件跳转到 `dynamicThrowBlock`（`:276-280`）。

所以「静态 throw」编译出来就是普通的 `icmp` + `br`，没有 landing pad、没有 unwind table、没有 personality function。**这是真正的 zero-cost happy path**（成功分支只多一次比较），代价是错误必须通过返回值传播，函数签名被污染。

`try` 表达式（`e = try f()`）用 SJLJ 加 phi 实现：`beginTryOperator()`（`:184-201`）建 catch block 并 `setJmp`；`endTryOperator()`（`:203-243`）在正常流上恢复上一层 sjlj frame，然后两条边汇合到 `try_phi_block`，用 `createPhi(value, prevBlock, errorValue, catchBlock)` 选出结果（`:239`）。

#### 1.5.2 动态路径（SJLJ + longjmp）

当既没有 catch 也不是 errorcode 函数时，无法用 CFG 表达 throw，于是走 `setjmp/longjmp`。

`getDynamicThrowBlock()`（`:22-39`）为每个函数惰性创建一个块，内容是 `call jnc.dynamicThrow` + `unreachable`。运行时 `Runtime::dynamicThrow()`（`jnc_rt_Runtime.cpp:224-240`）从 TLS 取当前 `m_sjljFrame` 并 `jnc_longJmp(frame->m_jmpBuf, -1)`；如果 TLS 里没有（说明在宿主外层），退化到 TLS slot 里的外部 frame 并打一条 warning（`:232-236`）。

SJLJ frame 的类型（`jnc_ct_TypeMgr.cpp:2077-2095`）：

```cpp
StructType* type = createInternalStructType("jnc.SjljFrame");
type->createField("!m_jmpBuf", char[sizeof(jmp_buf)]);
#if POSIX
type->createField("!m_signal", int);
type->createField("!m_code", int);
type->createField("!m_codeAddress", intptr_u);
type->createField("!m_faultAddress", intptr_u);
#endif
type->m_alignment = 16;   // 显式覆盖对齐
```

`setJmp()`（`jnc_ct_ControlFlowMgr_Eh.cpp:112-162`）：从函数级的 sjlj frame 数组里按 index 取一个 frame，写进 TLS 变量 `StdVariable_SjljFrame`，POSIX 下先把 `m_signal` 清零，然后 `call jnc.setJmp(frame)`，条件跳转。POSIX 上多一个 `pre_catch_block` 调 `jnc.saveSignalInfo` 把信号信息转成错误对象（`:147-155`，运行时在 `jnc_rt_Runtime.cpp:243-249`）。sjlj frame 数组和 GC root 数组一样是「先占位、`finalizeSjljFrameArray()` 回填」（`:607-621`）。

值得一提的是：**信号（SIGSEGV/SIGFPE 等）也统一进入这套 SJLJ 机制**——所以空指针检查（1.3.3）和 guard page safepoint（1.2.1）能直接复用它。

`finally` 用一个 `finallyRouteIdx` 栈变量做多路返回：正常流写入路由号，异常流由 `setJmpFinally` 写入 `-1`（`:164-182`）。

**代价评估**：这个双模型的实质是「把 unwind 的成本转移到类型系统」。errorcode 标注等价于「这个函数的错误走返回值」，调用方一定要检查；未标注的函数如果 throw 就得付 setjmp 的代价（每个 try 一次 `setjmp`，在 x86-64 上是保存 callee-saved 寄存器 + rsp + rip，几十个周期）。好处是完全不依赖 LLVM 的 EH（无 `invoke`、无 personality、无 `.gcc_except_table`），JIT 环境下不用处理 unwind table 注册。

### 1.6 内建 lexer / regex DFA

需要先厘清一件事：仓库里有**两套**正则引擎，但 Jancy 编译器只用其中一套。

#### 1.6.1 Jancy 实际使用的：axl_re2（Google RE2 的封装）

`src/jnc_ct/include/jnc_ct_Pch.h:249` 只 include 了 `axl_re2_Regex.h`。我在 `src/` 下搜索 `axl_re_` 和 `\bre::` **无任何命中**，所以 `axl::re`（下面 1.6.2 的自研引擎）没有被 Jancy 编译器使用。`dependencies.cmake:48` 依赖 `re2s`（vendored 的 Google RE2，在仓库根的 `re2s/`）。

`regex switch` 语句的代码生成分四阶段：

1. `regexSwitchStmt_Create()`（`jnc_ct_ControlFlowMgr_Stmt.cpp:249-262`）：`stmt->m_regex.createSwitch(flags)`。
2. `regexSwitchStmt_Condition()`（`:264-324`）：两种模式——单参数（simple）时 `new RegexState(flags)` 并用 `execEof` 方法；两参数（streaming）时复用调用方传入的 state 并用 `exec`（`:284-308`）。
3. `regexSwitchStmt_Case()`（`:326-348`）：每个 case 调 `m_regex.compileSwitchCase(regexSource)` 拿到一个 `caseId`，记进 `stmt->m_caseMap[caseId] = block`（`:339-344`）。
4. `regexSwitchStmt_Finalize()`（`:372-441`）：
   - `m_regex.finalizeSwitch()` 把所有 case 编成一个 RE2 program。
   - `createStaticRegexVariable(stmt->m_regex)` 把 DFA/program **序列化成字节数组常量**嵌进模块（见下）。
   - 发射 `regexVar.exec(state, text)` → `icmp eq result, ExecResult_Match` → 条件跳转。
   - 最后 `createSwitch(caseIdValue, defaultBlock, caseMap...)`（`:426-432`）——**用一条 LLVM `switch` 指令按 match id 分派到各 case 块**。

`VariableMgr::createStaticRegexVariable()`（`jnc_ct_VariableMgr.cpp:671-701+`）的做法很值得学：

```cpp
sl::Array<char> regexStorage = regex.save();          // 序列化
storageValue.setCharArray(regexStorage, ...);          // 变成一个 char[] 常量
Variable* variable = createVariable(StorageKind_Static, "regex", regexType);
// 然后把 "从常量反序列化并加载" 的代码包进一个 once-block
OnceStmt onceStmt;
onceStmt_Create(...); onceStmt_PreBody(...);
allocateVariable(variable) && initializeVariable(variable) && ...
```

也就是：**DFA 不在编译期生成机器码，而是把 pattern（或 program）序列化成模块里的常量，在第一次执行时由 `once` 块反序列化成运行时对象**。序列化格式在 `axl/src/axl_re2/axl_re2_Regex.cpp:242-259+`（`StorageHdr` 带 signature/version/regexKind/flags/captureCount/dataSize），反序列化在 `:166-239`（对 switch 类型逐个 `add_switch_case` 再 `finalize_switch`，并校验 capture count 一致）。`createSwitch` / `compileSwitchCase` / `finalizeSwitch` 就是 RE2 的 `create_switch` / `add_switch_case` / `finalize_switch` 的薄封装（`:146-162`）。

**注意：这不是把 DFA 编译成机器码/LLVM IR。** Jancy 的 `regex switch` 只是「编译期把多个 pattern 合并成一个 RE2 set，运行时解释执行，用 match id 驱动一条 LLVM switch」。我没有找到任何把 DFA 状态转移展开成基本块或 jump table 的代码。

#### 1.6.2 仓库里的自研 DFA 引擎：axl::re（未被 Jancy 使用）

`axl/include/axl_re/axl_re_Dfa.h` + `axl/src/axl_re/axl_re_{Nfa,Dfa,Compiler,ExecDfa,ExecNfaSp,ExecNfaVm}.cpp` 是一套完整的自研引擎，值得单独参考：

- `DfaState`（`axl_re_Dfa.h:98-114`）：`m_id` / `m_acceptId` / `m_flags` / `m_anchorMask` / `NfaStateSet m_nfaStateSet` / anchor 转移表 / 字符转移表 / `m_rollbackState`。
- 字符转移用**区间树**而不是 256/utf32 大数组：`DfaCharTransitionMap` 内部是 `sl::RbTree<utf32_t, {last, state}>`，查找用 `find<RelOpKind_Le>(c)` 再验 `c <= it->m_value.m_last`（`:34-85`）。这对 Unicode 是必要的（`visitMatchAnyChar()` 的范围是 `0..0x7fffffff`，`:188-191`）。
- `DfaStateFlag_Ready = 0x08`（`:93`）配合 `DfaProgram::getState(nfaStateSet)`（`:137-138`）和 `DfaBuilder::buildTransitionMaps(state)`（`:165-166`），是典型的**惰性 DFA 构造**（subset construction 按需展开，避免状态爆炸）。
- 有三种执行器：`ExecDfa`、`ExecNfaSp`（Spencer 回溯？）、`ExecNfaVm`（Pike VM 式），说明它做了 DFA/NFA 混合策略。
- 支持反向匹配（`DfaStateFlag_Reverse`）和 rollback state，用于最长匹配/lookbehind。

#### 1.6.3 Jancy 自身语言的 lexer/parser

不是 DFA 生成器，是**外部代码生成器**：词法用 Ragel（`src/jnc_ct/jnc_ct_Parser/jnc_ct_Lexer.rl` → 生成 `jnc_ct_Lexer.cpp`），语法用 AXL 自家的 `llk` LL(k) 生成器（`jnc_ct_Parser.llk`、`jnc_ct_Decl.llk`、`jnc_ct_Expr.llk`、`jnc_ct_Stmt.llk`、`jnc_ct_Declarator.llk` 等 → 生成 `jnc_ct_Parser.cpp`）。

---

## 第二部分：Cyber

### 2.1 字节码指令编码与调用帧布局

#### 2.1.1 编码：字节流、变长

`Inst` 就是一个字节（`src/bytecode.zig:886-904`）：

```zig
pub const Inst = packed struct {
    val: u8,
    pub inline fn initOpCode(code_: OpCode) Inst { return .{ .val = @intFromEnum(code_) }; }
    pub inline fn opcode(self: *const Inst) OpCode { return @enumFromInt(self.val); }
    pub fn initArg(arg: u8) Inst { return .{ .val = arg }; }
};
```

单元测试断言 `@sizeOf(Inst) == 1` 且 opcode 数量为 130（`bytecode.zig:1334-1336`）。所以这是**纯字节流、变长指令**：opcode 1 字节，后面跟若干字节操作数，`u16` / `u32` / `u48` 立即数直接内嵌（`READ_U16(n)` / `READ_U48(n)` 宏读 `pc+n`，例如 `vm.c:707`、`:1101`）。

指令长度由 `getInstLenAt(pc)`（`bytecode.zig:968` 起）用一个 switch 表决定：`ret0/ret1` 是 1 字节；`ret_dyn/typeCheckOption/throw/retain/end/release/true/false/await_op/map` 是 2 字节；`releaseN` 是 `2 + pc[1]`（可变长，`:986-989`）。三个 call 指令长度是常量：`CALL_OBJ_SYM_INST_LEN = 16`、`CALL_SYM_INST_LEN = 12`、`CALL_INST_LEN = 4`（`src/vm.h:198-200`）。call 指令留这么长是为了给 inline cache 预留 patch 空间（见 2.6）。

**opcode 枚举同时是 Zig 和 C 的真相来源**：`OpCode` 的每个成员显式赋值为 `vmc.CodeXxx`（`bytecode.zig:1142-1332`，如 `constOp = vmc.CodeConstOp`），而 `vmc` 是通过 `@cImport` 拿到的 `vm.h`。这样 C 解释器的 jump table 顺序和 Zig 编译器的枚举永远一致——C 侧还有一个 `STATIC_ASSERT(sizeof(jumpTable) == (CodeEnd + 1) * sizeof(void*), JUMP_TABLE_INCOMPLETE)` 兜底（`vm.c:674`）。这个「单一 opcode 定义、双语言消费」的技巧对 Omni（VM + C backend 双后端）直接可用。

指令集的形态是**三地址寄存器式**，注释里能看到操作数布局，例如：
- `constOp`：`[constIdx u16] [dst]`（`bytecode.zig:1143-1145`）
- `call`：`[calleeLocal] [numArgs] [numRet=0/1]`（`:1205-1207`）
- `match`：`[exprLocal] [numCases] [case1Local] [case1Jump] ... [elseJump]`（`:1296-1299`）
- `staticVar`：`[symId u16] [dstLocal]`（`:1301-1303`）

指令集设计上做了大量**类型特化**（这点很关键）：`addFloat`/`addInt`、`lessFloat`/`lessInt`、`field`/`fieldDyn`/`field_struct`、`copy`/`copyReleaseDst`/`copyRetainSrc`/`copyRetainRelease`/`copy_struct`/`copyObjDyn`。130 条指令里相当大一部分是「同一操作 × 静态类型已知/未知 × 是否需要 ARC」的组合展开。

#### 2.1.2 调用帧 / 寄存器窗口

调用帧是**滑动窗口**：`stack` 指针就是 frame pointer，寄存器就是 `stack[i]`。前 5 个 slot 是 prelude，实参从 `CALL_ARG_START = 5` 开始（`vm.h:203`）。

从 `CallFuncIC` 的实现能读出精确布局（`vm.c:1170-1186`）：

```c
Value retFramePtr = (uintptr_t)stack;
stack += ret;                                              // 窗口前移到 ret slot
stack[1] = VALUE_CALLINFO(false, CALL_SYM_INST_LEN, numLocals);
stack[2] = (uintptr_t)(pc + CALL_SYM_INST_LEN);            // 返回 pc
stack[3] = retFramePtr;                                    // 调用方 fp
pc = (Inst*)READ_U48(6);
```

即：
| slot | 内容 |
|---|---|
| `fp[0]` | 返回值 |
| `fp[1]` | `CallInfo` |
| `fp[2]` | 返回 pc（`retPcPtr`） |
| `fp[3]` | 调用方 frame pointer（`retFramePtr`） |
| `fp[4]` | （prelude 第 5 格，`CALL_ARG_START=5` 表明保留） |
| `fp[5..]` | 实参，之后是局部/临时 |

`CallInfo` 是一个 packed struct（`src/fiber.zig:543-560`）：

```zig
pub const CallInfo = packed struct {
    ret_flag: bool,        // ret 指令是否应退出 VM 循环
    call_inst_off: u7,     // 到原 call 指令的偏移（因为保存的是已推进的 pc）
    stack_size: u8,        // 函数栈帧大小
    type: FrameType,       // vm / host / dyn / main (u2)
    padding: u14,
    payload: u32,
};
```

`call_inst_off` 的注释解释了一个精妙的取舍（`fiber.zig:547-550`）：调用约定选择**先推进 pc 再保存**，这样 `ret` 之后 pc 已经指向正确位置（省一次加法），而栈回溯需要原 call 指令位置时再减掉这个偏移。回溯代码见 `fiber.zig:287` 和 `arc.zig:366`：

```zig
pcOff = getInstOffset(vm.c.ops, vm.c.stack[fpOff + 2].retPcPtr) - vm.c.stack[fpOff + 1].call_info.call_inst_off;
fpOff = getStackOffset(vm.c.stack, vm.c.stack[fpOff + 3].retFramePtr);
```

栈溢出检查在每个 call 点显式做：`if (stack + ret + numLocals >= vm->c.stackEndPtr) RETURN(RES_CODE_STACK_OVERFLOW);`（`vm.c:1176-1178`）——不是 guard page，而是显式比较。溢出后由 Zig 侧 `growStackAuto` 扩容再重入循环（`vm.zig:1915-1916`）。

### 2.2 解释器分派策略

**computed goto，且默认开启。**

`vm.c:540-691` 是分派宏的定义：

```c
#if CGOTO
    #define JENTRY(op) &&Code_##op
    static void* jumpTable[] = { JENTRY(ConstOp), JENTRY(ConstRetain), ... JENTRY(End) };
    STATIC_ASSERT(sizeof(jumpTable) == (CodeEnd + 1) * sizeof(void*), JUMP_TABLE_INCOMPLETE);
    #define CASE(op) Code_##op
    #define NEXT() do { PRE_TRACE(); PRE_DUMP(); goto *jumpTable[*pc]; } while (false)
#else
    #define CASE(op) case Code##op
    #define NEXT() do { PRE_TRACE(); PRE_DUMP(); goto beginSwitch } while (false)
#endif
```

每条指令末尾都是 `NEXT()`，所以是**每 handler 一次间接跳转**（replicated dispatch），而不是回到单一 switch 头——这是获得良好间接分支预测的关键。

`build.zig:592` 无条件 `cflags.append("-DCGOTO=1")`，所以标准构建就是 computed goto 版本；switch 分支只是不支持 label-as-value 编译器时的 fallback。

`pc` 和 `stack` 声明为 `register`（`vm.c:693-694`）：

```c
register Inst* pc;
register Value* stack;
```

`vm.c:8` 的注释还给了查看生成汇编的命令：`zig cc -c src/vm.c -S -O2 -DDEBUG=0 -DCGOTO=1 ...`，并特别指出 x86_64 上只有 linux target 会省掉函数调用序言（`:8-9`）——说明作者在逐条检查生成的机器码。

#### 2.2.1 Zig 解释器已废弃

`vm.zig:1874-1909` 的 `evalLoopGrowStack` 里：

```zig
if (comptime build_options.vmEngine == .zig) {
    return error.Unsupported;              // <-- Zig 引擎已弃用
} else if (comptime build_options.vmEngine == .c) {
    while (true) {
        const res = vmc.execBytecode(@ptrCast(vm));
        ...
    }
}
```

默认 `vmEngine = .c`（`build.zig:38`）。`vm.zig:2007` 还残留一个 `switch (pc[0].opcode())` 的 Zig 侧分派片段，但主循环不走它。

**这本身就是一个结论**：Cyber 作者试过用 Zig 写解释器循环，最终因为拿不到 computed goto 和寄存器分配控制而回退到 C，把热循环整体外置到 `vm.c`，Zig 侧只保留冷路径（`zCallObjSym`、`zAllocLambda`、`zBox`、panic 处理等，以 `z` 前缀的 `callconv(.C)` 函数导出）。这是一个非常明确的工程信号。

热/冷路径分工的例子：`CallObjSym` 整个 handler 只是 `CallObjSymResult res = zCallObjSym(vm, pc, stack, recv, typeId, method, ret, numArgs);`（`vm.c:1080`），而 `CallFuncIC`（已特化的快路径）完全在 C 里内联展开（`vm.c:1170-1186`）。

#### 2.2.2 未采用的方案

我在树里**没有**找到 tail-call threading（`musttail` 只出现在 JIT stencil 里，见 2.5）、也没有解释器汇编模板（LuaJIT 风格）。分派策略只有「computed goto（默认）/ switch（fallback）」两种。

### 2.3 值表示

这是本次调查里最容易被误判的一点，需要分两层讲。

#### 2.3.1 名义上的 NaN boxing 布局

位模式定义在 `src/vm.h:29-160`，`src/value.zig:15-42` 镜像了一份。注释写得很完整：

```
// 0111111111110000 (7FF0): +INF
// 1111111111110000 (FFF0): -INF
// 0111111111111000 (7FF8): QNAN
// 1111111111111000 (FFF8): -QNAN
// 0111111111111100 (7FFC): QNAN and one extra bit to the right.
#define TAGGED_VALUE_MASK       ((u64)0x7ffc000000000000)   // vm.h:39
#define TAGGED_UPPER_VALUE_MASK ((u64)0xffff000000000000)   // vm.h:41
#define UPPER_PLACEHOLDER_MASK  ((u64)1 << 49)              // vm.h:44
#define ENUM_MASK               ((u64)1 << 48)              // vm.h:47
#define NOCYC_POINTER_MASK      (TAGGED_VALUE_MASK | SIGN_MASK)          // 0xfffc..., vm.h:55
#define CYC_POINTER_MASK        (NOCYC_POINTER_MASK | ((u64)1 << 49))    // 0xfffe..., vm.h:59
#define POINTER_PAYLOAD_MASK    0xFFFFFFFFFFFF   // 48 位；32 位平台是 0xFFFFFFFF, vm.h:62-66
```

要点：

- **float**：非 quiet-NaN 的任意 f64 原样存。判定 `VALUE_IS_FLOAT(v) = (v & TAGGED_VALUE_MASK) != TAGGED_VALUE_MASK`（`vm.h:152`）。
- **指针**：`TAGGED_VALUE_MASK | SIGN_MASK` 前缀（高 16 位 `0xfffc`），低 48 位是地址。取出用 `VALUE_AS_HEAPOBJECT(v) = (HeapObject*)(v & ~POINTER_MASK)`（`vm.h:137`）。
- **可循环指针（cyclable）多一个 bit 49**，前缀变成 `0xfffe`（`vm.h:57-59`）。注释说明用途：「GC 用它跳过一次昂贵的解引用」。于是两个判定都是单次无符号比较：
  ```c
  #define VALUE_IS_POINTER(v) (v >= NOCYC_POINTER_MASK)     // vm.h:149
  ```
  ```zig
  pub inline fn isPointer(self) bool { return self.val >= vmc.NOCYC_POINTER_MASK; }   // value.zig:241-243
  pub inline fn isCycPointer(self) bool { return self.val >= vmc.CYC_POINTER_MASK; }  // value.zig:245-247
  ```
  **把「是指针」「是可回收指针」编码成有序区间，用一次 `cmp` 完成——这个技巧很值得抄。**
- **小 tag 值**放在 bit 32-34（`TAG_MASK = 7`，`vm.h:80`）：`TAG_VOID=1`、`TAG_BOOLEAN=2`、`TAG_ERROR=3`、`TAG_TAGLIT=5`、`TAG_SYMBOL=6`（`vm.h:81-85`）。`TRUE_MASK = BOOLEAN_MASK | 1`，`FALSE_MASK = BOOLEAN_MASK`（`vm.h:86-88`），所以 `VALUE_AS_BOOLEAN(v) = (v == TRUE_MASK)`（`vm.h:144`）。`value.zig:38-42` 里 `TagId = u3` 并注明「the tag id is also the primitive type id」。
- **Interrupt 哨兵**：`ERROR_MASK | 0xffff`（`vm.h:128`；`value.zig:65-67` 用 `ErrorMask | (0xFF << 8) | maxInt(u8)`），native 函数用它表示 panic。

对象头（`heap.zig:139-152`）：

```zig
pub const HeapObject = extern union {
    head: extern struct { typeId: cy.TypeId, rc: u32 },
    freeSpan: extern struct { typeId: cy.TypeId, len: u32, start: *HeapObject, next: ?*HeapObject },
    ...
};
```

`typeId` 这个 u32 是打包的（`vm.h:99-114`）：低 29 位 `TYPE_MASK = 0x1fffffff` 是真实类型 id，bit 29 `EXTERNAL_MASK` 表示由宿主 GPA 分配，bit 30 `CYC_TYPE_MASK` 表示可循环类型，bit 31 `GC_MARK_MASK` 是 mark 位。`OBJ_TYPEID(o) = (o->head.typeId & TYPE_MASK)`（`vm.h:160`）。**mark 位复用类型字段的高位，省掉独立的 mark bitmap**。池对象固定 40 字节（`heap.zig:138` 注释），更大的走 GPA。`freeSpan` 复用同一块内存做 free list，`typeId == cy.NullId` 标识空闲（`arc.zig:272`、`:287-290`）。

#### 2.3.2 实际上：静态类型的值不走 NaN boxing

这是必须指出的关键点。`Value.initInt` 是一个**裸 bitcast**（`value.zig:348-350`）：

```zig
pub inline fn initInt(val: i64) Value {
    return .{ .val = @bitCast(val) };
}
```

没有任何 tag。单测 `t.eq(Value.initInt(0).val, 0)`（`value.zig:560`）确认整数 0 就是 `0x0000000000000000`——这在 NaN boxing 里本来会被解释为 float `+0.0`。`initByte(val)` 同样直接 `.val = val`（`:352-354`）。

而 `vm.h` 里那三个整数判定宏 `VALUE_IS_INTEGER` / `VALUE_BOTH_INTEGERS` / `VALUE_ALL3_INTEGERS`（`vm.h:157-159`）引用了一个**在整个仓库里根本没有定义**的 `TAGGED_INTEGER_MASK`；我在 `src/` 下全文搜索确认它们也**没有任何使用点**。这三行是死代码，是从早期「整数也 NaN box」的设计残留下来的。

结论：Cyber 已经从纯动态 NaN boxing 演进为 **「静态类型 slot 里存裸值 + 动态边界处装箱」**：

- 静态已知 `int` 的 slot 存原始 i64（`VALUE_AS_INTEGER(v) = BITCAST(_BitInt(48), v)`，注释「Padding bits returned are undefined」，`vm.h:138`）。注意这里用的是 `_BitInt(48)` 而不是 `int64_t`，说明整数运算指令（`addInt` 等）按 48 位语义做——与 NaN boxing 的 payload 宽度一致，是过渡期的折中。
- 需要放进 `dyn` 上下文时显式装箱：`box` / `unbox` 指令（`vm.c:1577-1589`，`bytecode.zig:1245-1246`），运行时 `zBox(vm, val, type_id)`（`vm.zig:2869`）分配一个 `heap.Int` 对象（`heap.zig:180` `integer: Int`，`:728` `pub const Int = extern struct`），读回用 `asBoxInt()`（`value.zig:69-71`，走 `asHeapObject().integer.val`）。
- 动态字段访问会自动装箱：`FieldDyn` handler 里 `if (res.boxed) { retain; store } else { stack[dst] = zBox(vm, field, res.type_id); }`（`vm.c:1367-1372`）。

对 Omni 的启示：如果 Omni 是静态类型为主的语言，**不要一开始就上 NaN boxing**。Cyber 的经验表明它最终会退化成只服务于 `dyn` 边界，而带来的是「整数被限制在 48 位」这种长期负债。

### 2.4 ARC 实现

#### 2.4.1 运行时原语

全在 `src/arc.zig`。核心就是两个 inline 函数：

`retain`（`arc.zig:174-192`）：

```zig
pub inline fn retain(self: *cy.VM, val: cy.Value) void {
    if (val.isPointer()) {
        const obj = val.asHeapObject();
        obj.head.rc += 1;
        if (cy.TrackGlobalRC) self.c.refCounts += 1;
    }
}
```

`release`（`arc.zig:17-55`）：

```zig
pub fn release(vm: *cy.VM, val: cy.Value) void {
    if (val.isPointer()) {
        const obj = val.asHeapObject();
        obj.head.rc -= 1;
        if (cy.TrackGlobalRC) vm.c.refCounts -= 1;
        if (obj.head.rc == 0) {
            @call(.never_inline, cy.heap.freeObject, .{vm, obj, false});
        }
    }
}
```

三个设计点：
- 引用计数**非原子**（单线程 VM）。
- `freeObject` 用 `@call(.never_inline, ...)` 强制不内联——保持 release 的快路径代码体积小。
- 还有 `retainObject` / `releaseObject`（`:135-148`、`:84-102`）跳过 `isPointer` 判定，`retainInc(val, inc)`（`:194-212`）做批量增量，避免多次 retain 的重复检查。
- Debug/Trace 模式下有 `checkDoubleFree`（`:71-82`）和 `checkRetainDanglingPointer`（`:159-172`），会打印 pc 和对象 trace。`checkGlobalRC`（`:472-487`）在退出时断言全局 rc 归零——**这是一个非常值得抄的测试基础设施**。

#### 2.4.2 发射位置与省略机制

retain/release 由 `src/bc_gen.zig` 在字节码生成时静态插入。机制有三层：

**第一层：类型驱动的省略。** `sema.isRcCandidateType(t)` / `isUnboxedType(t)` 决定这个表达式结果是否可能需要 ARC：

```zig
const retain = c.sema.isRcCandidateType(ret_t);              // bc_gen.zig:1226
const retain = !c.sema.isUnboxedType(ret_t);                 // bc_gen.zig:894
const willRetain = c.sema.isRcCandidateType(ret_t);          // bc_gen.zig:875
const retRetained = c.sema.isRcCandidateType(data.func.retType);  // bc_gen.zig:1556
```

如果静态类型确定不是 RC 候选（int/float/bool/struct 等），**不发射任何指令**。这是最大的一笔节省，也是「静态类型 + ARC」组合的主要收益。

**第二层：Cstr（destination constraint）系统消掉冗余 retain。** `Cstr`（`bc_gen.zig:4220-4229`）的文档注释把语义写得很清楚：

> Some constraints have a `retain` flag.
> If `retain` is true, the caller expects the value to have increased it's RC by 1.
> * If the value already has a +1 retain (eg. map literal), the requirement is satisfied.
> * If the value comes from a local, then a retain copy is generated.
> * If the value does not have a RC, the requirement is satisfied.

也就是**「谁负责 +1」通过 Cstr 沿表达式树向下传播**：临时值（map literal、构造器结果）天然带 +1，直接满足；来自局部变量的才需要生成 retain-copy（`copyRetainSrc` 等指令）。这正是 ARC 优化里的 "ownership threading"，在 codegen 阶段一次完成，不需要后续 peephole。

`CstrType` 有 7 种目标：`simple` / `tempReg` / `localReg` / `varSym` / `liftedLocal` / `captured` / `none`（`bc_gen.zig:4196-4218`）。

**第三层：self-assignment 的正确性处理。** `selectForDstInst()`（`bc_gen.zig:4057-4117`）的注释给了这个经典陷阱的例子（`:4053-4056`）：

```
> let node = [Node ...]
> node = node.val
`node` rec gets +1 retain and saves to temp since the `node` cstr has `releaseDst=true`.
```

当目标 slot 需要先 release（`releaseDst`）或需要 retain 但指令本身不产生 retain 时，强制分配一个临时寄存器并置 `has_final_dst = true`（`:4079-4086`），最后再搬过去。`selectForNoErrNoDepInst()`（`:4121-4177`）对不会失败、不依赖目标的指令则允许直接写目标，只标 `requiresPreRelease`（`:4139`），后续 `if (inst.requiresPreRelease) try pushRelease(c, inst.dst, node);` 发射一条 release（`bc_gen.zig:1160-1161` 等十余处）。

**Slot 状态跟踪。** `initSlot()`（`bc_gen.zig:1778-1804`）是「把一个 slot 登记进 ARC 跟踪」的入口：

```zig
if (!slot.boxed) return;                    // 非 boxed 类型不跟踪
slot.boxed_init = true;
if (slot.type == .temp) {
    if (retained_val) { slot.boxed_retains = true; try pushUnwindSlot(c, slot_id); }
} else {
    slot.boxed_retains = true; try pushUnwindSlot(c, slot_id);
}
```

作用域结束时 `genReleaseSlots()`（`:2480-2496`）只对 `slot.boxed and slot.boxed_init and slot.boxed_retains` 三个条件同时成立的 slot 发 release，且多个 slot 合并成一条 `releaseN`（`pushReleases`，`:3736`）。`releaseN` 指令是变长的 `[op][n][slot...]`（`bytecode.zig:986-989`；`vm.c:1059`），**把 N 次 release 压成一条指令**，减少 dispatch 次数。

#### 2.4.3 异常/提前退出路径：unwind table，不是 defer 链

Cyber 不在字节码里为每条提前退出路径重复发射 release，而是维护一张**编译期构造的 unwind 链表**，运行时按 pc 查表。

数据结构（`fiber.zig:303-320`）：

```zig
pub const UnwindTry = packed struct { catch_pc: ..., prev: UnwindKey };
pub const UnwindKey = packed struct { idx: ..., is_try: bool, is_null: bool, ... };
```

三个平行数组在 VM 上：`unwind_slots: []u8`、`unwind_slot_prevs: []UnwindKey`、`unwind_trys: []UnwindTry`（`bytecode.zig:32`、`:38-40`）。每条 debug sym 关联一个 `UnwindKey`（`debug.getUnwindKey(vm, symIdx)`）。

回溯时（`arc.zig:104-117`）：

```zig
pub fn runUnwindReleases(vm: *cy.VM, fp: [*]const cy.Value, key: cy.fiber.UnwindKey) void {
    var cur = key;
    while (!cur.is_null) {
        if (cur.is_try) { cur = vm.unwind_trys[cur.idx].prev; }
        else { release(vm, fp[vm.unwind_slots[cur.idx]]); cur = vm.unwind_slot_prevs[cur.idx]; }
    }
}
```

`runUnwindReleasesUntilCatch()`（`:119-133`）是同一个遍历，但遇到 `is_try` 节点就返回 `catch_pc`，从而实现「释放到 catch 边界为止」。

这个设计的价值：**正常路径上零成本**（不发射任何 defer/landing pad 代码），异常路径上一次链表遍历。表的空间开销是每个 retained slot 一个 u8 + 一个 UnwindKey。对 Omni 直接可用。

#### 2.4.4 循环引用：按需触发的 mark-sweep，只扫可循环对象

`performGC()`（`arc.zig:233-241`）的算法说明在 `:222-232`：

> Mark-sweep leveraging refcounts and deals only with cyclable objects.
> 1. Looks at all root nodes from the stack and globals. Traverse the children and sets the mark flag.
>    Only cyclable objects that aren't marked are visited.
> 2. Sweep iterates all cyclable objects. If the mark flag is not set: the object's children are
>    released excluding confirmed child cyc objects, and the object is queued to be freed later.
>    If the mark flag is set, reset the flag for the next gc run.
>    TODO: Allocate using separate pages for cyclable and non-cyclable objects.

要点：

- **只有可循环类型参与**：判定靠 Value 的 bit 49（`isCycPointer()`）和对象头的 `CYC_TYPE_MASK`，全程不需要解引用非可循环对象。所有 mark 入口都先过 `if (sym.value.isCycPointer())`（`:249`、`:353`、`:388-393`）。
- **root 集合 = 栈 + 全局 + context vars**（`performMark`，`:243-258`）。栈 root 的枚举复用了 2.4.3 的 unwind 表：`markMainStackRoots()`（`:329-370`）从当前 pc 开始，`indexOfDebugSym` → `getUnwindKey` → 沿链表把每个 retained slot 标记，然后用 `fp[+2]/fp[+3]` 回溯到上一帧。**同一张表既服务异常释放，又服务 GC 精确根枚举** —— 很漂亮的复用。
- `markValue()`（`:373-441`）按 typeId 分派子对象遍历：`Map` 遍历 kv、`UpValue` 一个字段、用户 `object` 按 `numFields` 遍历、`trait` 走 `impl`、`func_union` 遍历 captured values、宿主对象走 `getChildrenFn` 回调（`:430-437`）。**递归实现**（`markValue` 自调用），深图有爆栈风险，代码里没有显式深度限制。
- `Fiber` 类型的 mark 是 `// TODO: Visit other fiber stacks.`（`:404-406`）——**其他 fiber 栈上的对象目前不会被扫描**，这是一个已知漏洞。
- Sweep（`:260-327`）分两趟：先扫池页（`heapPages`，用 `freeSpan.len` 跳过空闲块，`:268-292`），再扫非池对象的双向链表 `cyclableHead`（`:296-315`）。对 `isNoMarkCyc()` 的对象从全局 rc 里扣掉它的 rc 再 `freeObject(vm, obj, true)`（`skip_cyc_children = true`）。
- `num_freed` 恒为 0 并带 TODO（`:263-264`），所以返回的统计只有 `numCycFreed` 可信。

#### 2.4.5 弱引用 / 延迟释放：不存在

我在 `src/` 下搜索 `weakref` / `weak_ref` / `WeakRef` **零命中**。也没有 deferred release pool / autorelease 之类的机制——`release` 到 0 就立即 `freeObject`，同步递归释放子对象。

（`vm.h:60-61` 有 `BoxFlag_WeakMark` / `ClosureWeakMark` 之类的名字，但那是 **Jancy** 的 `jnc_BoxFlag`；Cyber 侧没有对应物。不要混淆。）

### 2.5 JIT：copy-and-patch，部分完成

`src/jit/` 下 11 个文件，架构是**copy-and-patch（stencil）JIT**——不是 IR-based codegen，而是「预编译好的机器码片段 + 运行时拼接 + 补洞」。

#### 2.5.1 Stencil 的产生

`src/jit/stencils.c` 用 C 写出每条操作的语义，并用 `[[clang::musttail]]` 尾调用到一个**占位的 continuation 函数**（`stencils.c:26-60`）：

```c
void cont4(VM* vm, Value* fp, u64 a, u64 b);
void interrupt5(VM* vm, Value* fp, u64 a, u64 b, u64 c);
void divByZero(VM* vm, Value* fp, u64 a, u64 b);

void addFloat(VM* vm, Value* fp, Value left, Value right) {
    [[clang::musttail]] return cont4(vm, fp, VALUE_FLOAT(VALUE_AS_FLOAT(left) + VALUE_AS_FLOAT(right)), right);
}

void divInt(VM* vm, Value* fp, Value left, Value right) {
    _BitInt(48) rightInt = VALUE_AS_INTEGER(right);
    if (rightInt == 0) {
        [[clang::musttail]] return divByZero(vm, fp, left, right);
    }
    [[clang::musttail]] return cont4(vm, fp, VALUE_INTEGER(VALUE_AS_INTEGER(left) / VALUE_AS_INTEGER(right)), right);
}
```

`musttail` 保证编译出来的片段末尾是一条 `b`/`jmp`（而不是 `bl`+`ret`），于是拼接时只要把那条跳转的目标改成「下一条指令的 stencil 起始处」就能串起来。文件头给了编译命令（`stencils.c:4-9`），包括 wasm 变体（`--target=wasm32 -mtail-call`）。

`src/jit/gen-stencils-a64.cy` 是一个**用 Cyber 自己写的构建工具**（self-hosting 的味道）：通过 LLVM C API（`tools/llvm.cy` 的 FFI 绑定）读 `stencils.o`，找 `__text` section（`:27-46`），遍历符号表按地址排序切出每个函数的字节区间，同时**记录每个 call/relocation 在片段内的偏移**，最后生成 `a64_stencils.zig`。

产物形态（`src/jit/a64_stencils.zig`，25 行）：

```zig
pub const addFloat = [_]u8{ 0x40, 0x00, 0x67, 0x9e, 0x61, 0x00, 0x67, 0x9e, 0x00, 0x28, 0x61, 0x1e, 0x02, 0x00, 0x66, 0x9e };
pub const addInt = [_]u8{ 0x68, 0x00, 0x02, 0x8b, 0xc2, 0xff, 0xef, 0xd2, 0x02, 0xbd, 0x40, 0xb3 };
...
pub const release_zFreeObject = 64;       // 洞的偏移
pub const divInt_divByZero = 32;
pub const callHost_hostFunc = 60;
pub const stringTemplate_zAllocStringTemplate2 = 56;
```

即：字节数组 + 每个「洞」的偏移常量。注意 `addFloat` 只有 16 字节、`addInt` 只有 12 字节——因为 continuation 的尾跳转被切掉了，直接顺序落到下一个 stencil。

#### 2.5.2 拼接与补洞

`gen.zig` 的核心操作是 `jitPush`（`:145-150`）和 `jitPushStencil`（`:152-158`），都是往 `CodeBuffer.buf`（`std.ArrayListAlignedUnmanaged(u8, page_size)`，`:60-68`）里 `@memcpy`。

补洞的写法是「拆成前后两半，中间插自己生成的 call」（`gen.zig:981-983`）：

```zig
try c.jitPush(stencils.release[0..stencils.release_zFreeObject]);
try assm.genCallFuncPtr(c, &cy.vm.zFreeObject);
try c.jitPush(stencils.release[stencils.release_zFreeObject+CallHoleLen..]);
```

`CallHoleLen` 是 a64 → 4、x86_64 → 5（`gen.zig:28-32`），正好是一条 `bl` / `call rel32` 的长度。同样的模式用于 `callHost`（`:718-720`）、`stringTemplate`（`:954-956`）、`dumpJitSection`（`:769-775`）。

二元运算就是直接 push 对应 stencil，运算前先 push `intPair` stencil 做解包（`gen.zig:394`、`:427-463`）：

```zig
try c.jitPush(&stencils.intPair);
...
.sub => try c.jitPush(&stencils.subInt),
.add => try c.jitPush(&stencils.addInt),
```

跨函数调用用重定位表：`Reloc { type: .jumpToFunc, data: { func: *cy.Func, pc: u32 } }`（`gen.zig:46-58`），`genCallFunc` 时 append（`a64_assembler.zig:88`、`x64_assembler.zig:117`），全部 chunk 生成完后统一 patch（`gen.zig:1079-1090`）。

#### 2.5.3 手写汇编器部分

不能全靠 stencil 的地方（load/store slot、立即数、条件跳转、函数序言/尾声）有一个薄汇编层。`src/jit/assembler.zig` 定义了架构无关的**逻辑寄存器**（`:12-19`）：

```zig
pub const LRegister = enum { fp, arg0, arg1, arg2, arg3, temp };
```

和一组操作：`genLoadSlot` / `genStoreSlot` / `genAddImm` / `genMovImm` / `genJumpCond` / `patchJumpCond` / `genPatchableJumpRel` / `genCmp` / `genMovPcRel` / `genPatchableMovPcRel` / `genStoreSlotImm` / `genBreakpoint` / `genCallFunc` / `genCallFuncPtr` / `genFuncReturn` / `genMainReturn`（`assembler.zig:26-172`），每个都 `switch (builtin.cpu.arch)` 分派到 `a64_assembler.zig` / `x64_assembler.zig`。文件头注释坦白：「Most machine code is still being generated from stencils.」（`:8-9`）

寄存器约定：**a64 上 frame pointer 固定在 x1**（`a64_assembler.zig:12` `pub const FpReg: A64.Register = .x1`），所有 slot 访问都是 `ldr/str [x1, #slot]`（`:15`、`:19`）。这与 stencil 的签名 `(VM* vm, Value* fp, ...)` 对应——x0=vm、x1=fp 是 AAPCS 的前两个参数寄存器，于是 stencil 之间串联时 vm/fp 天然常驻寄存器，不需要 spill。**这是 copy-and-patch 能高效的关键前提：所有 stencil 共享同一套寄存器契约。**

函数序言处理返回地址（`gen.zig:1023-1030`）：

```zig
// A64 relies on bl to obtain the return addr in x30.
if (builtin.cpu.arch == .aarch64) {
    try c.jitPushU32(A64.LoadStore.strImmOff(a64.FpReg, 2, .x30).bitCast());   // 存到 fp[2]
} else if (builtin.cpu.arch == .x86_64) {
    try assm.genStoreSlot(c, 2, .temp);    // x86 上 call 已经把返回地址压栈，从 rax 转存
}
```

注意存的位置是 `fp[2]`——**与解释器的调用帧布局完全一致**（见 2.1.2），所以 JIT 代码和解释器代码共享同一个栈格式，栈回溯/GC 根枚举可以统一。

#### 2.5.4 驱动与执行

编译入口在 `compiler.zig:443-451`：

```zig
C.BackendJIT => {
    ...
    try jitgen.gen(self);
    return .{ .jit = .{ ..., .buf = self.jitBuf, ... } };
},
```

`jitgen.gen()`（`gen.zig:1058-1090`）：先给所有 host func 做 `prepareFunc`，然后**只处理 chunk 0**（`if (chunk.id != 0) continue;`，注释 `// Skip other chunks for now.`，`:1066-1070`），最后跑重定位。

执行在 `vm.zig:658-688`：

```zig
try std.posix.mprotect(jitRes.buf.items.ptr[0..jitRes.buf.capacity], PROT_READ | PROT_EXEC);
defer std.posix.mprotect(..., PROT_WRITE) catch cy.fatal();
const main: *const fn(*VM, [*]Value) callconv(.C) void = @ptrCast(@alignCast(jitRes.buf.items.ptr + jitRes.mainPc));
main(self, self.c.framePtr);
```

**是 AOT 式的整体 JIT，不是热点触发**：整个 chunk 一次编译完，mprotect 成可执行，直接调 main。没有 tier-up、没有 OSR、没有 profile counter、没有 deopt 元数据。

#### 2.5.5 完成度：远未可用

`genStmt()`（`gen.zig:188-220`）只实现了 6 种语句：

```zig
.declareLocal, .exprStmt, .funcBlock, .ifStmt, .mainBlock, .retExprStmt, .verbose
else => return error.TODO,
```

被注释掉的包括 `forIterStmt` / `forRangeStmt` / `whileCondStmt` / `whileInfStmt` / `whileOptStmt` / `switchStmt` / `tryStmt` / `setField` / `setIndex` / `setLocal` / `opSet` …… **循环一条都没有**（`:194-216`）。`pushReleaseVals` 对 `vals.len > 1` 直接 `return error.TODO`（`:969-978`），`funcBlock` 里方法注册整段被注释（`:1042-1053`），`callObjFuncIC` 的 patch 也是注释状态。

`build.zig:407` 默认 `.jit = false`，需要 `-Djit` 显式打开（`:43`、`:377-378`）。

结论：**Cyber 的 JIT 是一个可运行的原型骨架（能跑直线代码 + if + 函数调用），不是生产实现。** 但它的架构（stencil 生成流水线 + 共享寄存器契约 + 与解释器一致的栈布局 + 薄汇编层补差）是完整且清晰的，作为 Omni 的 JIT 蓝图价值很高。

#### 2.5.6 另外两个后端

- **C backend**：`src/cgen.zig`（1854 行），生成 C 源码后用内嵌 tinycc 编译（`cgen.zig:594-641`：`tcc_new` → `tcc_set_output_type(TCC_OUTPUT_EXE)` → `tcc_add_include_path` → `tcc_add_file` → `tcc_output_file`）。macOS 上还硬编码了 Xcode SDK 的 include 路径（`:607`）——移植性上的一个坑。这是三个后端里除 VM 之外最完整的。
- **LLVM AOT backend**：`src/llvm_gen.zig`（1455 行，`genNativeBinary` 用 LLVM C API：`ContextCreate` / `ModuleCreateWithNameInContext` / `CreateBuilderInContext` / `InitializeNativeTarget` / `CreateTargetMachine` …，`:12-49`）。但在 `compiler.zig:460` 调用点是**注释掉的**：`// try llvm_gen.genNativeBinary(self);`。属于历史遗留、当前不可用。

### 2.6 Inline caching / 调用点特化

Cyber 用的是**指令自修改式的单态 inline cache（monomorphic IC，patch-in-place）**：同一个 call/field 站点在字节码里被原地改写成一个特化 opcode，把 guard 数据写进指令的空闲字节里；guard 失败就再改回通用 opcode（deoptimize）。

指令预留的长度就是为此：`CALL_SYM_INST_LEN = 12`、`CALL_OBJ_SYM_INST_LEN = 16`（`vm.h:198-199`），`fieldDyn` 家族是 11 字节（`vm.c:1387`、`:1406`）。

#### 2.6.1 字段访问 IC（工作中）

`FieldDyn` handler（`vm.c:1354-1389`）第一次执行时查 `zGetTypeField(vm, typeId, field_id)`，命中后**把自己改写成 `FieldDynIC` 并把缓存写进指令**：

```c
pc[0] = CodeFieldDynIC;
WRITE_U16(5, OBJ_TYPEID(obj));    // 缓存 typeId
pc[7] = (u8)res.offset;           // 缓存字段偏移
pc[8] = res.boxed;                // 缓存是否 boxed
WRITE_U16(9, res.type_id);        // 缓存字段类型（用于 box）
```

`FieldDynIC`（`:1390-1412`）就是 guard + 直接取字段：

```c
if (OBJ_TYPEID(obj) == READ_U16(5)) {
    Value field = objectGetField((Object*)obj, pc[7]);
    if (pc[8]) { retain(vm, field); stack[dst] = field; }
    else { stack[dst] = zBox(vm, field, READ_U16(9)); }
    pc += 11; NEXT();
} else {
    pc[0] = CodeFieldDyn;   // Deoptimize.
    NEXT();
}
```

注意 deopt 之后**不推进 pc**，直接 `NEXT()` 重新执行通用版本——这样通用版本又会重新 patch 成新类型的 IC。所以在多态站点上会发生**IC 抖动（thrashing）**：每次类型切换都要两次 dispatch + 一次自修改写。没有 polymorphic IC（多入口缓存），也没有「抖动 N 次后固化为 megamorphic」的机制。

`SetFieldDyn` / `SetFieldDynIC` 同构（`vm.c:1673-1739`）。

#### 2.6.2 静态函数调用 IC（工作中）

`callSym`（`vm.zig:1398-1443`）在第一次调用时按 `func.type` 分流并 patch：

- `.host_func`（`:1402-1424`）：`pc[0] = .callNativeFuncIC`，把宿主函数指针以 **u48** 写入 `pc+6`：
  ```zig
  pc[0] = cy.Inst.initOpCode(.callNativeFuncIC);
  @as(*align(1) u48, @ptrCast(pc + 6)).* = @intCast(@intFromPtr(func.data.host_func));
  ```
- `.func`（`:1425-1443`）：`pc[0] = .callFuncIC`，`pc[4]` 存 `stackSize`，`pc+6` 存**目标机器 pc（绝对地址，u48）**：
  ```zig
  pc[0] = cy.Inst.initOpCode(.callFuncIC);
  pc[4] = cy.Inst{ .val = @intCast(func.data.func.stackSize) };
  @as(*align(1) u48, @ptrCast(pc + 6)).* = @intCast(@intFromPtr(cy.fiber.toVmPc(self, func.data.func.pc)));
  ```

之后 `CallFuncIC`（`vm.c:1170-1186`）完全没有 guard——因为静态调用的目标不会变，直接 `pc = (Inst*)READ_U48(6)`。这不是真正的 "cache"，而是**一次性的调用点绑定（call site linking）**：把符号解析结果烧进指令，省掉每次的符号表查找。这个手法对 Omni 很实用，且实现代价极低。

#### 2.6.3 方法调用 IC：代码存在但被禁用

这是必须点出来的。`callMethod()`（`vm.zig:2745-2810`）里两处 patch 逻辑都被 `if (false)` 包住：

```zig
// Optimize.
// TODO: callObjFuncIC (rt args typecheck) or callObjFuncNoCheckIC.
if (false) {
    pc[0] = cy.Inst.initOpCode(.callObjFuncIC);
    pc[7] = cy.Inst{ .val = @intCast(func.data.func.stackSize) };
    @as(*align(1) u32, @ptrCast(pc + 8)).* = func.data.func.pc;
    @as(*align(1) u16, @ptrCast(pc + 14)).* = @intCast(typeId);
}
```

（`vm.zig:2760-2767` 和 `:2781-2787`）TODO 说明了原因：需要区分「需要运行时参数类型检查」和「不需要」两种变体，作者还没做。

因此 `vm.c` 里的 `CallObjFuncIC` / `CallObjNativeFuncIC` handler（`:1088-1154`）**目前是死代码**——`CallObjSym` 永远不会 patch 成它们，每次方法调用都走 `zCallObjSym`（`vm.c:1080`）→ 方法表查找。这也解释了 `CallObjFuncIC` 里那段看起来逻辑反了的 guard（`vm.c:1124-1129`）：

```c
TypeId cachedTypeId = READ_U16(14);
if (typeId == cachedTypeId) {
    // Deoptimize.
    pc[0] = CodeCallObjSym;
    NEXT();
}
```

类型**匹配**时反而 deopt，与 `CallObjNativeFuncIC`（`:1094-1117`，匹配则走快路径、不匹配才 deopt）相反。既然这条路径不可达，这个 bug 也就没被发现。**对 Omni 的提示：把 IC 的 patch 与 guard 写在同一处、并保证有测试覆盖，否则很容易出现这种不对称错误。**

`deoptimizeBinOp()`（`vm.zig:2812-2814+`）还有一套把特化二元运算还原成 `callObjSym` 的逻辑，会重排操作数（`pc[1] = pc[8]`），说明 Cyber 也做了「二元运算符特化 → 失败回退到方法调用」。

---

## 第三部分：对 Omni 的可借鉴结论

按「立刻采用 / 设计时留口子 / 明确不抄」三档给出，每条都标注来源。

### 3.1 立刻采用（低成本、高回报）

**A1. opcode 枚举单一定义，双语言/双后端消费。**
Cyber 把 opcode 数值定义在 C 头文件里，Zig 侧枚举成员显式绑定到它（`cyber/src/bytecode.zig:1142-1332`），并用 `STATIC_ASSERT` 校验 jump table 完整性（`cyber/src/vm.c:674`）。Omni 有 VM + C backend，必然面临同一份指令集被多处消费。做法：用一份机器可读的指令描述（表格/DSL），生成 opcode 常量、指令长度表、反汇编器、解释器 dispatch 骨架、C backend 的 case。**这件事在指令还只有二十条时做，成本几乎为零；等到一百三十条时做，是重写。**

**A2. 指令长度用一个纯函数集中定义，变长指令显式列出。**
`getInstLenAt(pc)`（`cyber/src/bytecode.zig:968-989`）是所有需要遍历字节码的地方（反汇编、GC、调试、JIT）的唯一真相。Omni 应该由 A1 的描述表自动生成它。

**A3. 调用帧布局固定为「返回值 + CallInfo + retPc + retFp + 参数」，并让所有执行层共享。**
Cyber 的 `fp[0..3]` prelude（`cyber/src/vm.c:1180-1184`）被解释器、JIT（`cyber/src/jit/gen.zig:1023-1030` 存 x30 到 `fp[2]`）、栈回溯（`cyber/src/fiber.zig:287`）、GC 根枚举（`cyber/src/arc.zig:366`）四方共用。Omni 从第一天就该定死这个布局，并把「解释器帧和 JIT 帧长得一样」当作硬约束——否则 JIT 上线时栈回溯和 GC 都要写第二套。

**A4. `CallInfo` 里存 `call_inst_off` 而不是原始 call pc。**
`cyber/src/fiber.zig:547-551` 的取舍：保存已推进的 pc（`ret` 时零成本），需要原位置时减偏移。对变长指令集尤其必要。

**A5. 静态调用点绑定（call site linking）。**
`callSym` 首次执行时把目标地址烧进指令、opcode 改成 `callFuncIC`，之后无 guard 直接跳（`cyber/src/vm.zig:1425-1443` + `cyber/src/vm.c:1170-1186`）。实现量极小、无正确性风险（静态目标不变）、收益是每次调用省一次符号表间接。Omni 应在 VM 第一版就做。前提是 call 指令预留足够字节（Cyber 是 12/16 字节）。

**A6. 类型驱动的 ARC 省略作为第一优先级优化。**
`isRcCandidateType` / `isUnboxedType` 门控所有 retain/release 发射（`cyber/src/bc_gen.zig:845`、`:875`、`:894`、`:1226`、`:1556`）。对静态类型语言，这一条消掉的 ARC 流量远超任何后端 peephole。**它属于「类型系统给 ARC 的红利」，必须在 sema 里就算出来，不要指望后端补救。**

**A7. Cstr（destination constraint）式的 ownership threading。**
`cyber/src/bc_gen.zig:4220-4229` 的注释是这套机制最好的规格说明：把「谁负责 +1」作为约束沿表达式树往下传，临时值天然带 +1 直接满足，只有来自变量的才生成 retain-copy。这在 codegen 一遍完成，不需要独立的 ARC 优化 pass。同时必须处理 self-assignment（`node = node.val`）：目标需要 pre-release 时强制走临时寄存器（`selectForDstInst`，`cyber/src/bc_gen.zig:4053-4095`）。**这个陷阱如果没在设计期考虑，后期会以「偶发 use-after-free」的形式出现。**

**A8. Unwind table 代替 defer 链。**
`cyber/src/fiber.zig:303-320` 的 `UnwindKey`/`UnwindTry` + 三个平行数组 + `runUnwindReleases`（`cyber/src/arc.zig:104-117`）/`runUnwindReleasesUntilCatch`（`:119-133`）。正常路径零指令，异常路径一次链表遍历。**并且同一张表直接用于 GC 精确根枚举**（`cyber/src/arc.zig:329-370`）。这个「一张表两用」是 Omni 应该照抄的结构性决定。

**A9. `releaseN` 合并释放。**
作用域退出时把 N 条 release 压成一条变长指令（`cyber/src/bc_gen.zig:2480-2496` 收集 + `cyber/src/vm.c:1059` 执行）。省 dispatch，也省字节码体积。

**A10. mark 位复用类型字段高位。**
`cyber/src/vm.h:99-114`：低 29 位 typeId，bit 29 external、bit 30 cyclable、bit 31 mark。免掉独立 mark bitmap 和额外 cache miss。

**A11. 「是指针 / 是可回收指针」编码成有序区间，用一次无符号比较判定。**
`VALUE_IS_POINTER(v) = (v >= NOCYC_POINTER_MASK)`、`isCycPointer = (v >= CYC_POINTER_MASK)`（`cyber/src/vm.h:149`、`cyber/src/value.zig:241-247`）。这两个判定在 ARC 的 retain/release 里是最热的分支，值得为它专门安排 tag 布局。**即使 Omni 不用 NaN boxing，也应该让「需要 ARC 的值」在 tag 空间里连续。**

**A12. 全局引用计数总量断言 + 对象 trace。**
`cy.TrackGlobalRC` 维护 `refCounts` 总数，退出时 `checkGlobalRC` 断言归零并 dump 存活对象（`cyber/src/arc.zig:472-487`）；`checkDoubleFree`（`:71-82`）/ `checkRetainDanglingPointer`（`:159-172`）在 debug 下带 pc 定位。**ARC 的 bug 几乎无法靠事后调试定位，这套设施必须与 ARC 同时落地，不能延后。**

**A13. 「先发射占位、后回填」的 codegen 模式。**
Jancy 在 GC root 数组（`jancy/src/jnc_ct/jnc_ct_Module/jnc_ct_GcShadowStackMgr.cpp:199-214`）和 SJLJ frame 数组（`jancy/src/jnc_ct/jnc_ct_ControlFlowMgr/jnc_ct_ControlFlowMgr_Eh.cpp:607-621`）上都用「先 alloca 一个占位、函数结束时知道真实大小后 `replaceAllUsesWith` + `eraseFromParent`」。Omni 的 C backend / LLVM backend 都会需要这个模式（栈帧大小、临时槽数量在函数末尾才确定）。

### 3.2 设计时留口子（不必立刻实现，但结构要兼容）

**B1. Copy-and-patch 作为第一版 JIT，而不是 IR-based。**
Cyber 的 `src/jit/` 给了一条完整的低成本路径：
1. 用 C 写每条 VM 操作的语义，尾部 `[[clang::musttail]]` 跳到占位 continuation（`cyber/src/jit/stencils.c:26-60`）。
2. 编译成 `.o`，用工具读 `__text` + 符号表切出字节片段、记录 relocation 洞的偏移，生成一个常量表（`cyber/src/jit/gen-stencils-a64.cy` → `cyber/src/jit/a64_stencils.zig`）。
3. 运行时 `memcpy` 拼接，遇到洞就「push 前半段 → 自己生成一条 call → push 后半段」（`cyber/src/jit/gen.zig:981-983`）。
4. 只为 load/store slot、立即数、条件跳转、序言尾声写一个薄汇编层（`cyber/src/jit/assembler.zig:12-19` 的 6 个逻辑寄存器）。

前提条件必须在 VM 设计期就满足：**所有 stencil 共享同一套寄存器契约**（Cyber：x0=vm、x1=fp，`cyber/src/jit/a64_assembler.zig:12`），并且 **JIT 帧布局与解释器帧一致**（见 A3）。如果 Omni 打算走这条路，`vm` 和 `fp` 必须是所有 VM 操作函数的前两个参数——这会影响解释器主循环的写法，事后改动很痛。

**B2. LLVM 后端做「整模块一次 JIT」，用 ORC v2，并把符号解析做成 DefinitionGenerator。**
Jancy 的 ORC 用法（`jancy/src/jnc_ct/jnc_ct_Module/jnc_ct_OrcJit.cpp:104-164`）是一个干净的最小骨架：`SelfExecutorProcessControl` + `ExecutionSession` + `RTDyldObjectLinkingLayer` + `IRCompileLayer(ConcurrentIRCompiler)` + `MangleAndInterner`，外部符号靠自定义 `DefinitionGenerator` 用 `absoluteSymbols` 按需注入（`:34-61`）。约 160 行。**如果 Omni 只需要 AOT 式 JIT（整模块一次成型），不要碰 MCJIT/ExecutionEngine，直接 ORC。**

配套要注意的坑（Jancy 都踩过并留了注释）：
- ARM 上必须关 `GlobalMerge` pass，否则前端持有的 `GlobalVariable*` 会失效（`jancy/src/jnc_ct/jnc_ct_Module/jnc_ct_Jit.cpp:55-70`）。
- CPU 特性自动探测会导致 JIT 崩溃，`setMCPU("generic")`（`jancy/src/jnc_ct/jnc_ct_Module/jnc_ct_McJit.cpp:102-108`）。
- JIT 环境下没有链接器，compiler-rt 辅助函数（`memcpy`、32 位的 `__divdi3`、ARM 的 `__aeabi_*`）必须手工注册进符号表（`jancy/src/jnc_ct/jnc_ct_Module/jnc_ct_Jit.cpp:94-143`）。**这是一个很容易被漏掉、且症状是「随机 unresolved symbol」的问题。**
- 宿主静态数据绑定用「新建 `ExternalWeakLinkage` 全局 + RAUW + 删原变量」（`jancy/src/jnc_ct/jnc_ct_Module/jnc_ct_Jit.cpp:146-167`）。

**B3. Trace JIT 的前置条件：unwind/根枚举表要能按 pc 查询。**
Cyber 的 `indexOfDebugSym(vm, pcOff)` → `getUnwindKey` → 遍历（`cyber/src/arc.zig:337-359`）已经具备「任意 pc 处枚举活跃引用」的能力，这正是 deopt 需要的。Omni 若计划 trace JIT，应该让这张表从一开始就以 pc 为键、且对 JIT 生成的代码同样可查（Cyber 没做到这点，因为它的 JIT 没有 deopt）。

**B4. Guard page 做 safepoint（如果 Omni 以后需要并发 GC 或抢占）。**
Jancy 的方案：safepoint 只发射「load 全局 trigger 指针 + 对其做一次 atomic xchg」，无分支（`jancy/src/jnc_ct/jnc_ct_OperatorMgr/jnc_ct_OperatorMgr_Call.cpp:560-576`）；stop-the-world 时把那一页 `mprotect(PROT_NONE)`（`jancy/src/jnc_rt/jnc_rt_GcHeap.cpp:1299-1307`），信号处理器里 park（`:1766-1774`）。**必须同时提供一个「简单模式」降级路径**（改成 `call gcSafePoint`，`jancy/src/jnc_ct/jnc_ct_OperatorMgr/jnc_ct_OperatorMgr_Call.cpp:556-558`），因为 guard page 与 AddressSanitizer 不兼容（`jancy/src/jnc_ct/jnc_ct_Module/jnc_ct_Module.cpp:196-199`）。ARC 为主的 Omni 短期可能不需要 safepoint，但如果引入并发环形回收器就会需要。

同一思路的另一处应用：Jancy 的空指针检查不发射分支，而是故意 load 一次并 store 到静态 sink 防止被优化掉（`jancy/src/jnc_ct/jnc_ct_OperatorMgr/jnc_ct_OperatorMgr_CheckPtr.cpp:133-150`），靠 SIGSEGV + SJLJ 兜住。

**B5. Fat pointer 的「validator 间接层」。**
如果 Omni 要做 safe slice/pointer：Jancy 的 fat pointer 只有 2 字（`{void* p; DataPtrValidator* v;}`，`jancy/include/jnc_RuntimeStructs.h:94-97`），范围信息在共享的 validator 里（`:103-115`）。**取舍很清楚：传递/存储便宜（16 字节），检查贵一次间接。** 如果 Omni 的边界检查频率远高于指针传递，反过来把 `{ptr, len}` 内联可能更好——但那样 slice 就是 3 字（带 base 的话）。这个决定要基于 Omni 的典型工作负载。

配套的三级指针种类（`Normal` 胖 / `Lean` 瘦但编译期跟踪 validator / `Thin` 裸，`jancy/include/jnc_Type.h:324-329`）是一个很有价值的设计：**`Lean` 让编译器在能静态证明来源时把 fat pointer 降级成单字，而 validator 只存在于编译期的 `LeanDataPtrValidator` 对象里**（`jancy/src/jnc_ct/jnc_ct_Value/jnc_ct_LeanDataPtrValidator.h:25-80`）。

**B6. 边界检查的四层省略，特别是「静态越界直接编译报错」。**
`jancy/src/jnc_ct/jnc_ct_OperatorMgr/jnc_ct_OperatorMgr_CheckPtr.cpp:61-131`：
1. unsafe 区域 / `Safe` 标记 / `Thin` → 完全不检查（`:68-71`）。
2. `Lean` + 编译期常量范围 → 若 `rangeLength < targetSize` **直接编译错误**（`:91-94`）；否则发射常量参数的 direct check（`:96-113`）。
3. 其余走 indirect check（`:117-128`）。
4. 根据 `canStaticThrow()` 选「void 版本（内部 dynamic throw）」还是「返回 errorcode 版本 + 检查」（`:22-59`）——不需要 unwind 的上下文里检查调用更便宜。
第 2 条的「静态越界升级为编译错误」是 Omni 应该直接采纳的语义。

**B7. 双错误模型的降级策略。**
Jancy 用一个谓词 `canStaticThrow() = canCatch() || 函数标了 errorcode`（`jancy/src/jnc_ct/jnc_ct_NamespaceMgr/jnc_ct_Scope.h:140-143`）在两条路径间选择：
- 静态路径：`throw` 编译成「跳到 catch block」或「`ret errorCodeValue`」（`jancy/src/jnc_ct/jnc_ct_ControlFlowMgr/jnc_ct_ControlFlowMgr_Eh.cpp:89-110`）；调用方一个 `icmp ne retval, -1` + `br`（`:245-290`）。**完全不用 LLVM EH：无 `invoke`、无 personality、无 `.gcc_except_table`、无 unwind table 注册**——这对 JIT 环境是巨大的简化。
- 动态路径：`setjmp/longjmp`（`:112-162`、`jancy/src/jnc_rt/jnc_rt_Runtime.cpp:224-240`）。

**给 Omni 的建议：只做静态路径。** 让所有可失败函数在类型上标注（Result/errorcode），把 `throw` 降级成「跳转 + 返回值」。这样 VM、C backend、LLVM backend 三个后端的错误处理是同一套 CFG 变换，不需要为任何后端实现 unwinder。Jancy 之所以还要 SJLJ，是因为它必须支持未标注函数抛异常 + 把硬件信号（SIGSEGV/SIGFPE）也统一进异常体系（`jancy/src/jnc_ct/jnc_ct_TypeMgr/jnc_ct_TypeMgr.cpp:2082-2090` 的 SjljFrame 带信号信息字段）。如果 Omni 不需要「信号即异常」，就不需要 SJLJ。

**B8. 闭包 = 编译期合成的类 + closureMap。**
Jancy 的 `ClosureClassType.m_closureMap` 记录「目标函数第 i 个参数来自闭包字段还是调用方」，thunk 按 map 交错取值（`jancy/src/jnc_ct/jnc_ct_TypeMgr/jnc_ct_ClosureClassType.cpp:53-87`）。**这使得任意位置的参数绑定（partial application）而不只是 this 绑定成为可能**，且 thunk 是普通函数、对后端完全透明。函数指针本身是 `{code, closure}` 两字（`jancy/include/jnc_RuntimeStructs.h:123-126`）。

**B9. Regex/DFA：编译期序列化 + 首次执行时 once-block 反序列化。**
`jancy/src/jnc_ct/jnc_ct_VariableMgr/jnc_ct_VariableMgr.cpp:671-701`：把 regex program `save()` 成 char 数组常量嵌进模块，加载代码包在 `once` 块里。`regex switch` 的分派是「合并所有 case 成一个 RE2 set → 运行时匹配得到 match id → 一条 LLVM `switch` 跳到对应 case 块」（`jancy/src/jnc_ct/jnc_ct_ControlFlowMgr/jnc_ct_ControlFlowMgr_Stmt.cpp:404-432`）。**注意：Jancy 并没有把 DFA 编译成机器码。** 对 Omni：`switch` 分派复用宿主语言的 switch/jump table 是对的；「序列化到常量段 + 惰性初始化」这个模式对任何编译期构建、运行时使用的数据结构（不只是 DFA）都适用。

若 Omni 要自研引擎，`jancy/axl/include/axl_re/axl_re_Dfa.h` 值得读：字符转移用区间红黑树而非 256 数组（`:34-85`，Unicode 必需）、`DfaStateFlag_Ready` 配合 `DfaProgram::getState(nfaStateSet)` 做惰性 subset construction（`:93`、`:137-138`）、DFA/NFA 三执行器混合（`ExecDfa`/`ExecNfaSp`/`ExecNfaVm`）。

### 3.3 明确不建议照抄

**C1. 不要用纯 NaN boxing。**
Cyber 名义上是 NaN boxing（`cyber/src/vm.h:29-160`），但静态类型的整数实际上是裸 i64 bitcast（`cyber/src/value.zig:348-350`，单测 `initInt(0).val == 0` 于 `:560`），`VALUE_IS_INTEGER` 那组宏引用了一个从未定义的 `TAGGED_INTEGER_MASK` 且无任何使用点（`cyber/src/vm.h:157-159`），是死代码。残留的负债是整数运算按 `_BitInt(48)` 语义做（`cyber/src/vm.h:138`）。**对静态类型为主的 Omni：slot 里存裸值，只在 `dyn`/variant 边界装箱**（Cyber 的 `box`/`unbox` 指令 + `zBox`，`cyber/src/vm.c:1577-1589`、`cyber/src/vm.zig:2869`）。这样整数是完整 64 位，浮点无需 canonicalize。

**C2. 不要在 Zig/Rust 之类的语言里写解释器主循环。**
Cyber 试过并放弃了：`vmEngine == .zig` 现在直接 `return error.Unsupported`（`cyber/src/vm.zig:1881-1882`），主循环全在 `vm.c`，Zig 只保留 `z*` 前缀的冷路径函数。原因是需要 computed goto（`cyber/src/vm.c:540-691`）和 `register` 变量提示（`:693-694`）。**Omni 的解释器热循环应该用 C（或至少是有 label-as-value 的方言）写，宿主语言只做编译器和冷路径。** `vm.c:8` 的注释还提示要定期 dump 生成的汇编做检查。

**C3. 不要用 Jancy 式的 shadow stack 做 GC 根（如果 Omni 有 JIT 且追求性能）。**
Jancy 每个 scope 边界都要一次不可内联的外部调用 `jnc.setGcShadowStackFrameMap`（`jancy/src/jnc_ct/jnc_ct_Module/jnc_ct_GcShadowStackMgr.cpp:154-171`），每个 root 一次 store（`:110-112`）。它的优点是对 LLVM 完全透明、不受 LLVM 版本影响；缺点是运行时开销明显。**Omni 已经有 unwind table（A8），应该直接用「pc → 活跃 slot 列表」的查表方案，正常路径零成本。** Jancy 的 shadow stack 方案只在「无法控制代码生成、或必须支持多个后端且不想为每个后端实现 stack map」时才是正确取舍。

**C4. 不要止步于单态 IC + 原地 deopt。**
Cyber 的字段 IC 在多态站点会抖动：类型不匹配 → 改回通用 opcode → 通用版本重新 patch → 下次又不匹配（`cyber/src/vm.c:1390-1412`）。没有 polymorphic IC、没有 megamorphic 固化。**Omni 至少要有「抖动计数达阈值后固化为不再 patch 的通用形式」这一档**，否则多态热点会比不做 IC 更慢。

**C5. 不要让 IC 的 patch 逻辑和 guard 逻辑分处两地。**
Cyber 的方法调用 IC patch 被 `if (false)` 禁用（`cyber/src/vm.zig:2760-2767`、`:2781-2787`），导致 `CallObjFuncIC` handler 成为死代码，而其中的 guard 逻辑是**反的**（类型匹配时反而 deopt，`cyber/src/vm.c:1124-1129`），与相邻的 `CallObjNativeFuncIC`（`:1094-1117`）不一致，且从未被发现。**教训：patch 和 guard 必须成对定义（最好由同一份描述生成），并且每个 IC 都要有强制走一遍 hit 和 miss 的测试。**

**C6. 不要在 C backend 里硬编码平台 SDK 路径。**
`cyber/src/cgen.zig:607` 硬编码了 `/Applications/Xcode.app/.../MacOSX.sdk/usr/include`。Omni 的 C backend 应该把编译器/头文件路径做成配置。

**C7. 不要用 `llvm::cl::getRegisteredOptions()` 去改 LLVM 的内部 pass 开关。**
Jancy 靠找到 `global-merge` 这个命令行选项对象并 `setValue(false)` 来关 pass（`jancy/src/jnc_ct/jnc_ct_Module/jnc_ct_Jit.cpp:55-70`）。这依赖 LLVM 内部选项名，任何版本变动都可能静默失效。根因是「前端长期持有 `GlobalVariable*`」这个设计。**Omni 若用 LLVM，不要在 pass 运行后还依赖 IR 对象的身份稳定性**，用名字或索引重新查找（Jancy 自己在 `Jit::getLlvmFunction` / `getLlvmGlobalVariable` 里已经部分改成按名字查了，`jancy/src/jnc_ct/jnc_ct_Module/jnc_ct_Jit.h:112-126`）。

### 3.4 一个直接可执行的推进顺序

基于以上，给 Omni 的落地顺序建议：

1. **指令集描述表 + 生成器**（A1、A2）。在指令还少时做。
2. **帧布局与 CallInfo 定死**（A3、A4）。写进文档并加断言测试。
3. **C 写的 computed-goto 解释器**（C2）。宿主语言写编译器和冷路径。
4. **裸值 slot + dyn 边界装箱的值表示**（C1、A10、A11）。
5. **ARC：sema 层类型省略 + Cstr ownership threading + slot 状态跟踪**（A6、A7）。同时上 A12 的调试设施。
6. **Unwind table**（A8、A9）。一张表同时服务错误传播和精确根枚举。
7. **静态错误模型（无 unwinder）**（B7）。
8. **静态调用点绑定 + 字段 IC（带 megamorphic 固化）**（A5、C4、C5）。
9. **循环回收：只扫可循环对象的 mark-sweep**（2.4.4）。注意补上 Cyber 漏掉的「其他协程栈」（`cyber/src/arc.zig:404-406`）和递归 mark 的深度保护。
10. **C backend**（B1 之前，因为它验证了 IR/语义的完整性且无平台风险）。
11. **Copy-and-patch JIT**（B1）。前提是 3、4 步已满足寄存器契约和帧布局约束。
12. **LLVM/ORC 后端**（B2）或 **trace JIT**（B3）。

---

## 第四部分：未能从源码确定的事项

以下条目是我在阅读中无法从代码得出确定结论的，列出来避免被当成已知事实使用。

### 关于 Jancy

1. **没有任何性能数据。** 三个 JIT 后端（Legacy / MCJIT / ORC）的编译速度与生成代码质量差异，源码里没有 benchmark；`test/` 下我没有检查是否有性能测试。guard page safepoint 与 simple safepoint 的实际开销差距同样未知。
2. **`jitFunctions` 的整模块编译对大模块的延迟影响未知。** 代码明确是 eager 全量编译（`jnc_ct_FunctionMgr.cpp:727-763`），但没有任何增量/缓存机制的痕迹，也没有注释说明是否曾遇到启动延迟问题。
3. **`Lean` 指针的降级覆盖率未知。** `checkDataPtrRange` 里 `Lean` + 静态范围是最优路径（`jnc_ct_OperatorMgr_CheckPtr.cpp:82-114`），但「实际代码中有多大比例的指针能被推断成 `Lean` 且范围已知」需要跑起来统计，无法从源码判断。我也没有追踪 `Normal → Lean` 的转换在哪些操作里发生（`jnc_ct_CastOp_DataPtr.cpp:563`、`:636` 有调用点，但完整的类型推导规则我未通读）。
4. **`AXL_TODO("implement proper coercion for structures with floating point fields")`（`jnc_ct_CdeclCallConv_gcc64.cpp:23`）的实际影响范围未确认。** 含浮点字段的小结构体按 SysV 应进 SSE 寄存器，Jancy 统一 coerce 成 `i64`/`{i64,i64}`。这在与 C 库互操作时应该会产生 ABI 不匹配，但我没有找到测试或 workaround 说明它是否在实践中被规避。
5. **`re2s/` 是否被修改过。** 仓库根有 `ucs2.diff`，暗示 vendored RE2 打了 UCS-2 补丁，我没有阅读该 diff，因此不确定 Jancy 用的 RE2 与上游语义是否完全一致。
6. **`axl::re` 自研引擎的定位。** 它在 `axl/` 子树里完整存在（含惰性 DFA、三种执行器），但 Jancy `src/` 完全不引用它。它是替代 RE2 的进行中工作、还是另一个项目的产物，从这两份副本里无法判断。
7. **async/协程与 GC shadow stack 的完整交互。** 我看到 async sequencer 把 frame 存进 promise 而非 TLS 链（`jnc_ct_GcShadowStackMgr.cpp:236-246`），但没有追踪 GC 标记阶段如何遍历挂起的 promise 上的 frame，以及跨 suspend 点的 root 生命周期如何保证。
8. **LLVM 版本兼容矩阵。** 代码里有从 `LLVM_VERSION < 0x030600` 到 `LLVM_VERSION_MAJOR >= 17` 的大量条件编译，实际被 CI 验证的版本范围我没有查 `ci/`。

### 关于 Cyber

9. **`VALUE_AS_INTEGER` 用 `_BitInt(48)` 的确切理由与后果。** 注释只写「Padding bits returned are undefined」（`vm.h:138`）。我推测是 NaN boxing 时代的残留（payload 48 位），但既然 `initInt` 已经是裸 64 位 bitcast（`value.zig:348-350`），两者是否存在不一致（例如大于 2^47 的整数经过 `addInt` 后是否被截断）我**没有验证**。这是一个值得单独确认的疑点。
10. **`callObjFuncIC` 的 guard 是否真的是 bug。** `vm.c:1124-1129` 在类型匹配时 deopt，与 `CallObjNativeFuncIC`（`:1094-1117`）相反。由于 patch 路径被 `if (false)` 禁用（`vm.zig:2762`、`:2783`），这段代码不可达，我无法通过运行验证。也可能是作者故意留的「先禁用」标记。
11. **JIT 的性能。** 没有任何 benchmark。而且由于 `genStmt` 不支持循环（`jit/gen.zig:194-216` 全部注释掉），实际上无法对任何有意义的程序做性能对比。stencil 拼接方案相对解释器的加速比在这个树里**无法测量**。
12. **JIT 与 ARC/GC 的交互。** JIT 代码里 `pushReleaseVals` 对多值直接 `error.TODO`（`jit/gen.zig:969-978`），unwind 表在 JIT 路径下是否生成、GC 能否在 JIT 帧上做精确根枚举，我没有找到相关代码。推测是**尚未实现**，但不能确定。
13. **`x64_stencils.zig` 是否与 `a64_stencils.zig` 同步。** 我只读了 a64 版本的内容。x64 的 stencil 生成器（`gen-stencils-x64.cy`）存在，但两边的 stencil 覆盖是否一致未核对。
14. **`heap.zig` 的分配器细节。** 我只确认了「40 字节池对象 + 更大的走 GPA + freeSpan 复用内存做 free list」（`heap.zig:138-152`、`arc.zig:268-292`），但页大小、池的分级策略、`cyclableHead` 双向链表的插入时机都没有细读。
15. **`Fiber` 的 GC 标记缺口有多严重。** `markValue` 对 `bt.Fiber` 只有 `// TODO: Visit other fiber stacks.`（`arc.zig:404-406`）。这意味着挂起协程栈上的对象不会被标记，理论上会被 sweep 误回收。但也可能协程栈上的对象都有非零 rc 从而不进入 cyclable sweep，所以实际是否会触发 use-after-free 我**无法确定**。
16. **`sema.isRcCandidateType` / `isUnboxedType` 的精确判据。** 我确认了它们门控 ARC 发射（`bc_gen.zig` 多处），但没有读 `sema.zig`（7638 行）里的实现，因此不知道哪些类型被归为 RC 候选（例如包含引用字段的 struct 如何处理）。
17. **`cgen.zig` 生成的 C 代码里 ARC 如何表达。** 我在 `cgen.zig` 里搜 `retain`/`release`/`zRetain` **没有命中**，只找到 tcc 调用部分（`:594-641`）。C backend 是否发射 ARC 操作、还是走另一套内存策略，需要读那 1854 行才能确定。**这一点对 Omni 尤其重要（Omni 明确要 C backend + ARC），建议单独做一次专项阅读。**
18. **两份副本的版本。** 都不是 git 仓库，无法确定对应上游哪个 commit/tag，因此本文档的行号无法与公开仓库对齐，也无法判断这些 TODO 是否在上游已被修复。
