# ADR-0022：LLVM JIT 是一格**通用后端**，不是某一门语言的特化

状态：草案（计划已定，J1 起逐格落地）
起因：jancy 要它（`opaque class` 的宿主成员、扩展库那一套都卡在这儿），但范围不是 jancy。

## 这一份要立的边界

ADR-0014 决策 3 把 LLVM 定成 JIT 与 AOT 的首选后端，第二阶段落了 `src/jit/omni_jit.c`
（进程外、读一份 `.ll`、调 `main`）。那一格**能跑**，可它的形状只够"把一份 IR 跑起来"。

三件它做不到的事，都不是性能问题，是**接口不存在**：

1. **宿主把地址喂进去**。JIT 出来的代码现在只能看见"进程里已经导出的符号"
   （`LLVMOrcCreateDynamicLibrarySearchGeneratorForProcess`）。宿主没有任何办法说
   "`foo` 这个名字请指到我这一格函数上" —— 而那正是 FFI 的必要条件。
2. **多个入口、反复调**。现在是 `lookup(main)` 调一次就结束。REPL、增量、kernel dispatch
   要的是"查一个符号、调它、再查下一个"。
3. **一个进程里开会话**。现在每跑一次 spawn 一个 `omni-jit`。装载与卸载的生命周期问题
   一次都没碰到过，因为进程马上就退了（omni_jit.c 末尾那句注释说的就是这个）。

与 GLSL 那条路**明确不同**：`src/jit/glsl_host.c` 是照 llvmpipe 复刻的**特化**实现
（一门语言、一种流水线、宿主提供的东西是那门语言的环境）。这一份要的是相反的东西 ——
六门语言与 MIR 共用一格会话，语言特有的语义一格都不进 JIT 层。

## 量出来的现状（`tests/jnc/cases/49-class.jnc`，含 node 启动与前端约 150ms）

```
run-jit   514ms      run-llvm  481ms      run-c  322ms      interp  172ms
```

`run-jit -v` 的分步：

```
backend llvm   5ms     29052 bytes -> jit.ll
runtime .o    23ms     20 objects，缓存命中
jit host       0ms     缓存命中
orc jit + 跑 220ms     <- 这一格就是"spawn + 建 LLJIT + 解析 29KB IR + 物化 + 调 main"
```

两个结论摆在这儿，免得往后拿"JIT 更快"当默认前提：

- **这一刀之前 JIT 一点速度优势都没有**（比 `run-c` 还慢 190ms）。220ms 的大头是会话
  搭建与进程启动，不是编译 —— 所以"把会话开在编译器进程里"是性能上唯一有意义的一刀。
- jancy 那一侧的正确性其实已经在了：69 份 `.jnc` 用例里 **68 份**在 `run-jit` 上与
  `.expected` 逐字节相同；剩下的一份（`59-incdir`）差的是 `-I` 没透过去，与 JIT 无关。

## 决策

**决策 1：JIT 是一格会话，不是一次 spawn。**
接口照 jancy 的 `jnc_ct::Jit`（`create` / `mapVariable` / `mapFunction` / `prepare` /
`jit` / `findSymbol`，见 `jnc_ct_Jit.h:23-70`）：建会话 → 加 IR → 映符号 → 物化 → 查地址 →
调。名字用我们自己的（`omni_jit_open/add_ir/map/prepare/lookup/call`），语义照抄那五格。

**决策 2：符号可见性默认关。**
bare JITDylib + 一格定义生成器，只有映进去的名字看得见（jancy 的
`JitDefinitionGenerator::tryToGenerate` + `Jit::findSymbol`，`jnc_ct_OrcJit.cpp:32-59`）。
理由三条：FFI 的安全边界要在这一层，而不是"进程里恰好有这个符号"；可复现（同一份 IR
在两台机器上能不能跑，不取决于宿主二进制里链进了什么）；诊断（漏一格时报的是
`unresolved: X`，那是 jancy 的 `TRACE("JIT: unresolved: %s")`，比 LLVM 的原话有用）。
达尔文那条前缀规矩照抄：`_foo` 先剥掉下划线再查（`jnc_ct_Jit.cpp:81-87`）。

**决策 3：两个方向的 FFI 都从这一格符号表出。**

- 宿主 → JIT：`map(name, addr)` 定义成绝对符号。`opaque class` 的宿主成员、扩展库的
  `JNC_MAP_FUNCTION`、模块级变量映到宿主的存储（jancy 的 `mapVariable` 还会把那格
  `GlobalVariable` 换成 `ExternalWeakLinkage` 的 `.mapping`，`jnc_ct_Jit.cpp:149-170`）
  —— 全是这一格的用法，不需要各自一套机制。
- JIT → 宿主：声明无体的函数 + 一张"这个名字从哪个库来"的表，`dlopen`/`dlsym` 挂在
  `findSymbol` 的回退链末端。

**决策 4：语言中立。**
所有语言共用 `MIR -> LLVM IR` 那一个发射器与这一格会话。jancy 特有的东西（fat 指针带范围、
`errorcode` 的两句、`opaque class` 体外的字节数）落在 **frontend-jnc 的降级**里 ——
JIT 层看见的只有 IR 与符号。这条是这一份 ADR 的全部意义：GLSL 那条特化路不再复制第二遍。

**决策 5：先补进程外的能力，再把会话搬进来。**
`map` 与多入口在**进程外**就能做（宿主自己注册一张表）。而"会话开在编译器进程里"要给
封闭 ABI（ADR-0011 决策 2）加"按 ptr 间接调用"这条 —— 那等于把任意函数指针交给 JS 域，
是单独一节的论证，不该顺手做。所以它排在 J6，不排在 J2。

## 分步计划（每一格独立验收）

- **J1 钉住现状**：`run-jit` 进 `tests/jnc` 成第六条腿（`.args` 要透过去，68/69 -> 69/69）。
  没有 libLLVM 的机器上按 `tests/jit` 那条规矩跳过而不是算失败。
- **J2 符号表**：`omni_jit.c` 换成 bare dylib + 定义生成器 + 宿主的一张显式符号表
  （`src/jit/omni_jit_symbols.c`，运行时那些名字一条条列出来）。验收：`tests/jit`、
  `tests/llvm`、`tests/jnc` 全绿；故意漏一格时报 `omni-jit: unresolved: X`。
- **J3 多入口 + 反复调**：`omni-jit FILE.ll --call SYM --repeat N`。验收：一份 `.ll` 里
  两个入口各调一次，答案与 AOT 相同（为 kernel dispatch 与 REPL 备好）。
- **J4 FFI 第一刀（宿主 → JIT）**：无体声明 + 宿主表里的实现。jancy 与核心方言各一份用例；
  jancy 那一份就是 `opaque class` 的宿主方法（现在在 `tests/jnc/bad` 里被拒的那两条）。

  **量到的前提（做 J4 之前先补这一格）**：`MIR` 早就带着 `cabi` 与 `OP.CCALL`
  （`mir/from_oir.js:493`、`mir/bytes.js:129`），JS 后端与解释器都实现了它，
  而 **`backend-llvm` 里一个 `CCALL` 的分支都没有** —— 也就是说 LLVM/JIT 这条腿
  **压根调不了外部 C 函数**。`tests/cabi` 那份用例进不来是另一个原因（它是 JS 前端 +
  dyn 模块级变量，超出 LLVM 的支持面），所以这条空白一直没被照到。
  J4 于是分成两半：先教 `backend-llvm` 发 `declare` 并降 `CCALL`（类型词汇就是 C_ABI
  那七个标量，`cstr` 的 marshal 照 backend-c 那一份），再让宿主解析那些名字。

  **`CCALL` 已经降了**（`OP.CCALL` -> `call`，声明按调用点收上来的签名回填；变参按 `aux`
  的定参分界发 `declare RET @f(T…, ...)` 并在调用点写出函数类型；`setjmp`/`longjmp`
  照 emit_js 与 interp 的同一张名单拒）。回填那一格有个坑量到了：一个外部符号都没有时
  占位那行必须**抽掉**而不是留成空行 —— 否则整份 IR 平移一行，`tests/llvm` 的快照当场红。

  **但 C 那条腿还接不上，三处都定到点了**（拿 `strlen`/`abs` 两个调用的 `.c` 量的）：
  1. 原生降级把每个外部符号包成一个**桩函数**（`externThunk`，MIR 里是
     `func strlen(s:i64)`，体里一条 `CCALL`），而 LLVM 后端把桩发成了
     `define i64 @strlen() { ret i64 0 }` —— 形参丢了、体是假的。它该发的是 `declare`。
  2. 调用点的实参是**胖指针**（`[2 x i64]`，地址 + 长度），桩的形参是 `i64` ——
     两边对不上。`c obj` 那条腿在生成机器码时把它摊平了，LLVM 这边要照同一个约定。
  3. 程序自己的 `main` 与包装的 `main` 撞名，clang 直接报
     `invalid redefinition of function 'main'`。

  所以 `emit llvm x.c` 这扇门**暂时不开**（试过，能跑通到"clang 拒绝"这一步，
  正是靠它把上面三条定出来的）。

  **三条都补完了，门开了**：extern 函数发 `declare`（签名从调用点收）、模块自带 `main`
  时不发包装（C 的 `main` 就是进程入口，`c obj` 那条路也是这么链的；顺带一个旁证：
  原生 C 的 MIR 里 `entry` 是**文件路径**，压根不是函数）、胖指针在外部调用点抽出地址
  （`externArg`）。第三条是量出来的：`strlen("abcdefg")` 侥幸对（地址正好落在第一格），
  而 `strcmp("abc","abc")` 直接 **segfault** —— 16 字节的聚合在 arm64 与 x86_64 上都占
  两格寄存器，于是第二个指针实参落错了位置。抽地址之后 `declare i32 @strcmp(ptr, ptr)`，
  两份用例的退出码分别是 10 与 7，都对。

  **下一格边界（已定位，连接缝都找着了）**：`extern FILE *stdout` 那一类**外部全局量** ——
  `emit llvm hello.c` 现在停在 `llvm 后端目前不支持 dyn：模块级变量 __stdinp`。
  MIR 那一侧的记法是 `MirModule.setGlobalExtern(i, size, align)`（`globalBlob[i].extern`
  = true，`mir/ir.js:1156`，只有 native 这条腿有），符号名在 `globalSym[i]`（不给就用
  `globals[i]`）。所以这一刀要做三件事：
  1. `globalBlob[i].extern` 的那些发 `@<真符号> = external global [<size> x i8]`，
     **不带 `@g_` 前缀**（那个前缀是这一层给自己的模块级变量用的）；
  2. `GLOAD`/`GSTORE` 到这些格子上时按**指令自己的类型**读写（外部块在我们眼里是裸内存，
     `dyn` 那条拒绝不该照到它身上）；
  3. 顺带就是 J4 后半的第一个真用例：JIT 里这些名字由宿主 `map` 进去
     （jancy 的 `mapVariable` 管的正是这一类，`jnc_ct_Jit.cpp:189-215`）。
  补完之后 `printf` 那一族才通，而 `tests/c/sys/*.c` 那一组就是现成的验收面。

  **那三件事都做了，`tests/c/sys/*.c` 五份全部逐字节对上**（stdout / stderr / 退出码
  三样都比，新的第 4 节 `c-extern/*` 在 `tests/llvm/run.js` 里）。做的过程里量出**六个
  各自独立的错**，全都是「这条腿从来没跑过认真地址的模块」留下的：

  1. **变参分界差一个**。`CCALL` 的 aux 是「固定实参个数 **+ 1**」（0 才是「不是变参」，
     见 `mir/ir.js` 的 `callVaFixed`），而这一层直接把 aux 当个数用了。于是
     `printf("hi %d\n", 7)` 出来的是 `declare i32 @printf(ptr, i32, ...)` —— 7 成了
     **定参**，而苹果 arm64 上变参一律走栈，印出来是 `hi 1860954544`。
     顺带这个 bug 还让「同一个符号两处签名必须一样」误报（不同调用点实参个数不同）。
  2. **串常量没有结尾的零**。Omni 的字符串带长度，所以池子里从来不放 `\0`；而 C 那边
     `printf("a\n")` 到 libc 手上只是一个 `char *`。量出来是 `printf("a\n")` 印完 `a`
     之后接着把池子里下一个字面量也印了半句。
  3. **`bytes` 那一种常量被当成文本发了**。`T_STR` 有两个 kind（`mir/ir.js` 的
     `ConstPool.bytes`）：`str` 存文本，`bytes` 存**十六进制**。C 的串字面量里有 0x80
     以上的字节时前端走 `bytesOnce` —— 于是那条十六进制**本身**成了数据段里的内容，
     `strlen("stdout 也是一格")` 回 38（19 个字节的十六进制正好 38 个字符）。
  4. **`MLOAD`/`MSTORE` 在原生腿上不是线性内存**。那边指针是真地址，这两条就是解引用；
     照旧过 `omni_lin_at` 查界，量出来是链接时缺 `_omni_lin_at` —— 而就算把那个符号链
     进去，查的也是错的那块内存。现在按 `mod.native` 分岔（`nativeMemInsn`）。
  5. **`static` 没落到 `internal` 上**。头文件里那些没被用到的 `static inline`（SDK 的
     `__sputc`）在我们手上是一个 0 条指令的函数体，照默认的外部链接发出去就是
     `define i32 @__sputc() { ret i32 0 }` —— **一份把 libc 名字占住的空实现**。
     JIT 那侧更险：`omni_jit_define` 让模块自己定义的名字优先。
  6. **外部符号的形参不能一处 `ptr` 一处 `i64`**。`externArg` 从前把胖指针抽出来之后
     转成了 `ptr`，于是 `strlen("abc")`（字面量）与 `strlen(s)`（一个 i64 变量）成了
     `i64 (ptr)` 与 `i64 (i64)` 两份声明。MIR 上指针本来就是 i64，两者同一个寄存器类
     —— 统一按 i64 传。同一个道理：**原生腿上串常量的值就是地址**（一个 i64），
     不是胖指针，不然是 `store i64 [i64 …, i64 …]`，LLVM 当场说类型对不上。

  这一刀实际落下来的四格（都在 `backend-llvm/emit.js`）：`globalRef`（原生腿一律用真
  符号名，`@g_` 只留给线性内存那几条腿）、`blobGlobal`（字节块全局：外部的发
  `external global`，自己的发定义 —— 初值里的**地址**是 `ptrtoint` 常量表达式，塞不进
  `[n x i8]` 的元素里，所以有 fixup 的块发成一个紧凑结构体，clang 出来的也是这个形状）、
  `GADDR`/`FRAME`（前者一条 `ptrtoint`，后者在入口块按 `frames` 表各发一个 alloca ——
  原生腿上 `&x` 就是这一条）、以及上面第 1/2/3/6 条那几处。

  **`setjmp` 那一族接着收干净了**（同一刀的第二段）。从前 `LL_NOJMP` 那张拒绝名单只照到
  `CCALL` 一支，而 C 的 `setjmp` 走的是**桩**（`externThunk` -> 外部 `CALL`），于是它从那条
  拒绝旁边绕过去了 —— `04-setjmp.c` 在 `-O0` 上跑对了，看着像是支持了。开优化一量就露：
  `-O1`/`-O2` 上它跳成一个**不停印的死循环**。两件事都缺：

  - **声明上的属性**。`setjmp` 那一半要 `returns_twice`（不写的话优化器假定它只回一次，
    把跳回来还要用的值当死值删掉），`longjmp` 那一半要 `noreturn`（C11 7.13.2.1：它不回来）。
    所以名单拆成两张（`LL_SETJMP` / `LL_LONGJMP`），合起来那张（`LL_JMPFAMILY`）只管边界。
  - **槽位的 `volatile`**。C11 7.13.2.1 只保证 `volatile` 的自动变量在 `longjmp` 之后还是
    那个值，而 MIR 上**没有 `volatile` 这一位**（C 前端到这一层已经把它丢了）。所以凡是
    函数里有 `setjmp` 那一族的调用，它的槽位一律按 `volatile` 读写（`func` 里的 `this.vol`，
    判据是 `hasJmp` 扫一遍函数体 —— `CCALL` 与外部 `CALL` 两条路都看）。整个函数都按
    volatile 是**比 C 要求的更强**的一边：只会更对，代价只落在真用了 setjmp 的那几个函数上。
    真正的解法是把 `volatile` 带进 MIR，那是另一刀。

  边界本身也从「一律不收」改成**按模块的地址模型分两种**：认真地址那条腿上它们真的能用
  （真帧、真 libc），线性内存那几条腿上不收（那边「外部函数」是宿主的实现，没有那个帧）。
  一处判断（`externDecl`），两支共用 —— 这就是上面那个 bug 的成因，所以顺手把「登记一个
  外部符号的声明」收成了一个方法。

  验收面因此加了一个轴：`c-extern/*` 现在**两个优化档都跑**（`-O0` 与 `-O2`）。这一类
  「少一位属性、少一个 volatile」的错只在开优化之后才露出来。跑的时候一律带时限（20s）
  与输出上限（1MB）—— 一个跳飞的用例不该把测试机的磁盘写满（写这一节的时候真写了 51GB）。

  **下一格边界**：`volatile` 还没进 MIR。现在是按函数一刀切（有 setjmp 就全 volatile），
  对了但过粗；C 那侧 `volatile int x` 与普通 `int x` 在别处（比如 MMIO、信号处理器里那些
  变量）也该有区别，而这一层看不见。要做就在 `MirFunc.slots` 那一格上加一位。

  **J4 的最后一格：这一切在 JIT 上也成立**。同一份 IR 交给 `omni-jit` 之后，`tests/c/sys`
  五份的 stdout、stderr、退出码与 `omni c run` 逐字节相同（`tests/jit` 的 `c-jit/*`）。
  路上又是两个错：

  - **`int main(void)` 的退出码被丢了**。宿主判入口形状只数**参数个数**（0 格 -> `void(void)`、
    2 格 -> `int(int,char**)`），而 C 的 `int main(void)` 正好是「0 格参数但有退出码」——
    量出来是五份用例 stdout 全对而退出码全成了 0。现在回值也看：0 格 + 回 i32 -> `int(void)`。
  - **不透明指针之后 `LLVMTypeOf(f)` 就是一个 `ptr`**。对它 `LLVMGetElementType` 拿到的是
    垃圾，当场 segfault。函数的类型要走 `LLVMGlobalGetValueType`。

- **J4b jancy 的 `opaque class` 宿主方法 —— 已落**（从前 `tests/jnc/bad/opaque-host-*.jnc`
  被拒着，那句"这一层还没有宿主面"现在不成立了）。
  两个前提先确认过了：

  1. **地址模型对得上**。jancy 那条腿**没有线性内存** —— `emit-llvm 62-opaque.jnc` 里一条
     `omni_lin_init`/`omni_lin_at` 都没有，对象是 `omni_ll_alloc` 从 arena 里切的**真地址**。
     所以把 `self` 交给宿主的 C 函数是有意义的（C 的线性内存腿不是这样：那边指针是偏移）。
  2. **现在没有任何一条路能说出"调这个 C 符号"**。`hir/c_abi.js` 的 `C_ABI` 是**构建期**的
     常量表、键是 JS 的导入名，前端造不出新条目；sexpr 方言里也没有 extern-C 那个形式
     （`cfn` 是闭包签名，不是这件事）。

  **已落的第一格：MIR 那一侧**。`MirModule.cabiNo(entry, sig)` 现在能记下**这个模块自己
  声明的**签名（`cabiSig[i]`，词汇就是 C_ABI 那七个标量），同名两处签名不一样就在那儿停 ——
  真发出去的话 C 那条腿会写出两份对不上的 extern 原型，而 C 里重复声明成不同类型是硬错误。
  签名也进了摘要（`bytes.js`）与清单（`print.js`）：同一个名字、不同签名是**两个**外部符号。
  `backend-c` 的 `cAbiExterns()` 优先看这一格。

  **下一格是一个设计点，量清楚了再动**：OIR 的 `CCall` 现在的含义是「**dynamic 域**的 C
  调用」—— 实参逐个 `omni_cabi_*` marshal 进去、返回值 marshal 回来（`backend-c` 的
  `case 'CCall'`）。而 jancy 那边值是**有类型的机器值**，要的是「不 marshal 的 C 调用」。
  两者必须能分开，否则 backend-c 会把 marshaler 套在已经是机器值的东西上。

  **这一格也落了**。方言里多两个形式：

  ```
  (cabi omni_probe_add i64 (i64 i64))     ;; 声明：那一端的 C 是这么声明的
  (ccall omni_probe_add (var a) (var b))  ;; 调用：实参已经是机器值
  ```

  类型词汇是 C_ABI 那一套的**名字**（`i32`/`i64`/`f64`/`bool`/`ptr`/`void`），不是方言的
  类型 —— 写的是「那一端怎么声明的」，而不是「这一端的值是什么」。`i32`/`i64`/`ptr` 都落在
  方言的 `int` 上（这个方言没有 i32、也没有指针类型：地址就是一个整数），差别只体现在 C
  那侧的原型文本与强制转换上。`cstr` **不收**：它要 UTF-8 的装卸，而这一格上的实参已经是
  机器值了，没有地方放那次转换。

  OIR 的 `CCall` 上因此多一位 `raw`，四条腿各自的落点：
  - `backend-llvm`/arm64：什么都不用改 —— 签名是从调用点收上来的，MIR 的 `CCALL` 本来就是
    「实参是机器值」那个含义。
  - `backend-c`：`raw` 的发 `sym((int64_t)(a), …)`，一个 marshaler 都不套；原型从
    `mod.cabiSig` 发。
  - `emit_js`/`interp`：照旧拒（那两条腿没有 C 调用约定）。顺带修掉两处**崩**而不是拒：
    `C_ABI[e.entry].sym` 在源码声明的那些名字上读到 undefined 上，一个 TypeError 代替了
    本该有的那句诊断。

  验收面（`tests/llvm` 的第 5 节 `cabi-decl`，fixture 在 `tests/llvm/cabi/`）：四种形状各走
  一遍（i64 进出、f64 进出、ptr、void 返回），体在一份独立的 `host.c` 里 —— 编成 dylib 之后
  `omni-jit --lib` 装进来，符号是**运行期**解析的（J5 那条路）；C 那条腿另用一条文本判据钉住
  （extern 原型要在、`omni_cabi_*` 不许出现）。顺带量出一个 print 的老 bug：`CCALL` 的 `a`
  与 `aux` 都是数字、意思不同，而 `print.js` 只看 op 不看第几格，于是 aux 也被当成入口号印了
  一遍（`CCALL void omni_probe_hi () omni_probe_add` —— 末尾那个名字是 0 号入口，而它真正的
  意思是「这个调用点不是变参的」）。

  **最后一步也落了**：jnc 把无体的 opaque 方法降成 `(ccall Owner_method self …)`。

  形状与 jancy 一样 —— **对象由这一侧分配**、方法的体在宿主里、第一个实参是那个对象；
  只把 jancy 的"登记"（`JNC_BEGIN_CLASS` 那一串，abi.rst:60-70）换成**按名字约定**：
  `Owner.method` 对着的 C 符号是 `Owner_method`。用 `_` 不用 `$`：后者不是可移植的 C
  标识符字符（clang 收，标准不收），而命名空间里的类名本来带 `$`，一并换掉。
  第一个形参的词是 `ptr`（类引用在这一侧是一格带界的三字指针，交给 C 的是"当前"那一格），
  别的形参与返回按原型上的 jnc 类型对到 C_ABI 的词上（`cabiWordOfJnc`）；落不进那几个词的
  就在调用点明说，不悄悄放宽。体在哪个库里由源码另说一句 `import "libfoo.dylib"` ——
  与 `(cabi …)`/`(lib …)` 的分工完全一致。

  ```
  opaque class Counter { long add(long d); long value(); }
  Counter* c = new Counter;
  c.add(20);                 // -> (ccall Counter_add (var c) (int 20))
  ```

  判据（`tests/llvm/run.js` 第 9 节）：`host.c` 那边**看不见对象的布局**（那正是 opaque 的
  意思），所以它拿指针当键、状态放自己一张小表里 —— 于是 `add(20)`、`add(22)`、`value()`
  回 42 这件事，证的正是"两次调用里宿主看到的是同一个 self"。生成的 `.sx` 里那句
  `(cabi Counter_add i64 (ptr i64))` 也逐字比。

  **量出来的一条语法事实**：方法名不能叫 `get` —— 那是 jancy 的关键字（属性的取值器），
  `c.get()` 在语法上根本不是一次方法调用，报出来的是"没有这个函数"。判据里用 `value()`。

- **J4c 动态库导入：`import "libfoo.dylib"`，不做 `.jncx`**。jancy 的扩展库是 `.jncx` ——
  一个 zip，里头封着 `.jnc` 声明**加**一份编译好的共享库（`ImportMgr::addImport` 里
  `isExtensionLib` 那一支走 `loadDynamicLib`）。我们**换一条路**：那两件事本来可以分开 ——
  「有哪些符号」由源码里的声明说（`(cabi …)` / `opaque class` 上的方法原型），「它们的体在
  哪儿」由一句 import 说。于是不需要一种新的文件格式，也不需要在编译器里读 zip。

  ```
  import "libfoo.dylib";   // jnc：.so / .dll 同样收，.so.6 那种带版本号的也算
  (lib "libfoo.dylib")     // 方言里对应的那一句（jnc 降出来就是它）
  ```

  **C 的系统库必须特殊对待，而且是预登记的**（`hir/c_abi.js` 的 `C_SYSLIBS`：
  `libc`/`libm`/`libpthread`/`libdl`）。两条量出来的理由：
  1. 它们**未必是磁盘上的文件** —— macOS 上 `existsSync('/usr/lib/libSystem.B.dylib')`
     回 **false**（在 dyld 的共享缓存里），照文件路径去 dlopen 是碰运气；
  2. 它们**已经在这个进程里**了（宿主自己链着 libc/libm），所以要的不是"装进来"，
     是"去问进程的动态符号表"。
  所以这一类不走 dlopen，走 `omni-jit --dl`（RTLD_DEFAULT）；表里还记着链接那侧要不要
  加一项（`libm` 在 Linux 上要 `-lm`，macOS 上不用）。表外的名字当成路径。

  这一格在管线上是一条**独立的线**：`(lib …)` -> OIR 模块的 `libs` -> `MirModule.libs` ->
  `runViaJit` 把它变成 `--lib` / `--dl`。**IR 里不带它** —— `.ll` 是给 LLVM 的，装哪个库
  是宿主的事；手工跑 `omni-jit x.ll` 的时候开关自己给。
  验收面在 `tests/llvm` 的第 6 节 `lib-decl`：一条第三方库（临时目录里编出来的 dylib，
  走 `--lib`）、一条预登记的系统库（`(lib "libm")` + `sqrt`，走 `--dl`），都用
  `run-jit` 跑 —— 一条命令、不手工给开关，钉的就是整条链。

- **J4d 类型从哪儿来：三条路，一条都不强制**。`import` 只说「体在哪个库里」，说不出签名 ——
  **动态库里没有类型**：Mach-O 的导出表与 ELF 的 `.dynsym` 里只有**名字**，C 又不做名字修饰，
  所以一个 `.dylib` 里关于 `foo` 的全部信息就是"有这么个符号"。这一条决定了下面的形状。

  1. **手写声明**（已落）：`(cabi 名字 返回类型 (形参类型…))`。最准，也是别的两条路最后
     落到的同一格。
  2. **`with 'header.h'` 自动解析**（要做）：`import "libfoo.dylib" with "foo.h";`。
     **不需要外挂 tcc、也不需要另写一个 C 解析器** —— 这个仓库里已经有一份完整的 C 前端
     （`frontend-c/tccgen.js`，tcc 的移植），它现在就在读真的 SDK 头
     （`tests/c/sys/01-sdk-headers.c` 是它的用例）。要补的只有**一条出口**：
     `tccgen` 的 `this.funcs` 里每一条都带着 `ret`/`params`/`variadic`/`old`
     （`funcSym`、`callArgs` 用的就是它们），而这些信息**在降到 MIR 的路上被丢掉了**
     （原生腿的外部 MirFunc 上没有 params，见 backend-llvm 那一支的注释）。
     所以这一刀 = 一个新的 cap（`c.declsOf(path, opts)` -> `[{name, ret, params, variadic}]`）
     加上把 C 的类型翻成 C_ABI 那七个词的映射。头文件里那些落不进七个词的（struct 按值、
     函数指针…）**跳过并记一笔**，不要让一个头文件里的一条声明把整次 import 弄失败。

     **cap 已经落了，在真头文件上量过**：`#include <stdio.h> <string.h> <math.h>` 一趟收下
     **233 条**、跳过 137 条，签名都对（`printf (ptr)+... -> i32`、
     `fwrite (ptr,i64,i64,ptr) -> i64`、`sqrt (f64) -> f64`）。跳过的那 137 条绝大多数是
     `float`/`long double` 的那一族 —— 这两个**刻意不放宽成 `f64`**：`float` 的形参按 double
     传就是错的调用约定（ABI 上它是单精度那一格），而错的 ABI 比"没这一条"难查得多。
     顺带量出一个必须挡的坑：**老式声明 `int f();` 不是 `int f(void)`** —— 形参表没说，
     调用点给几个都合法。收下它就会发出 `declare i32 @f()` 而调用点给两个实参，签名当场
     对不上。所以 `old` 的那些也跳过（第一版没挡，出来与 `f(void)` 一模一样）。
     `f32` 该不该进那七个词是另一件事（它会让这 137 条里的大半收得下），而那是 ADR-0014
     决策 4 的口径，要动就单独一刀。
     验收面：`tests/c` 的 `decls/foo.h`（收得下的九条 + 带理由跳过的五条，逐字节比）。
  3. **省略、从调用点推**（要做）：`import "libfoo.dylib" as g;` 之后 `g.foo(1, 2)` ——
     没有声明也能调，签名从**调用点**收。这一条本来就是现成的：J4 里 LLVM 那条腿的
     `declare` 就是从调用点收上来的（`externDecl`），MIR 的 `CCALL` 的含义也正是
     「实参是机器上的值」。要补的是 jnc/方言那一侧的 `as g` 那个命名空间与推断规则
     （借 zig 与常见 FFI 的口径：整数一律按目标机的 `int`/`long` 提升、浮点提 double、
     指针与整数同宽）。

  **有一条要说准**：「运行时推断不出类型就 warning」这件事**没有运行时的落点** —— 库里没有
  类型，跑起来能检测的只有"符号找不着"（那一条已经在 `omni_jit_define` 里，装载前按名字报）。
  所以那个 warning 是**编译期**的：没有声明、签名是从调用点猜的，就在那儿记一笔
  （`这个符号没有声明，签名按调用点猜的：i64 (ptr, i32)`）。这样它才落在能改的地方 ——
  一条源码行上。**猜错了会崩，这是明写在文档里的代价**：方便与权利留给用的人，
  但那条 warning 得让人知道自己在用哪一边。

  三条路最后都落在同一格（`mod.cabiSig` 的那条签名），所以后端一个字都不用改。

  **拿一个真的 OpenGL 程序量出来的四格**（homebrew 的 glfw 3.5.1 + 它的真头文件）：
  1. **framework 的头文件目录**（macOS）。`<GLFW/glfw3.h>` 第 237 行 include 的是
     `<OpenGL/gl.h>` —— 苹果那边它是 `<F>/OpenGL.framework/Headers/gl.h`（clang 的 `-F`）。
     少了这张表，一份真的 GLFW 头**连预处理都过不去**。补上之后一趟收下 637 条声明。
  2. **`f32` 进那张类型词表**。补完 framework 之后剩下的 67 条跳过**全都只因为 `float`**，
     而那 67 条正是 `glColor3f`/`glClearColor`/`glVertex3f` 那一族 —— 一个经典 OpenGL 程序的
     正中心。`float` 不许拿 `f64` 顶：ABI 上单精度是自己那一格。
  3. **有声明就按声明发**（`backend-llvm` 的 `cabiArg` + `CABI_LL`）。签名从前是从调用点的
     **值**收的，而方言里只有 `real`（f64）—— 那对 `float` 必然错。现在 `mod.cabiSig` 在的
     时候由它说：形参在调用点补 `fptrunc`/`trunc`/`sext`/`sitofp`，返回值反向补。
  4. **`ptr` 的形参也收 `string` 与方言的指针**。一个真程序两种都要：
     `glfwCreateWindow(w, h, "标题", …)` 的第三格是 `const char *`，
     `glfwGetFramebufferSize(win, &w, &h)` 的后两格是 `int *`。方言的 `(ptr T)` 是**带界的
     三个字**，交给 C 的是"当前"那一格（与 `OP.PTHIN` 同一格）—— 界检查留在这一侧。

  **第五格：宏与枚举常量 —— `with` 的正当理由**（已落）。`GL_COLOR_BUFFER_BIT`、
  `GL_TRIANGLES`、`GLFW_CONTEXT_VERSION_MAJOR` 这些在 C 里是 `#define`，不是函数。
  没有这一格，一个 jancy 写的 OpenGL 程序只能把 `16384` 手抄进源码（`glfw-tri.sx` 里
  就是那个样子，那正是不该有的样子）。用 `with "h"` 的全部意义就在这儿：
  **头文件是那些名字的唯一出处**。

  两处来源，一处出口：`gen.enumConsts`（枚举常量的值在解析时就算好了）与 `cpp.defines`
  里的对象宏（宏体先用 `tokPrint` 还原成文本，再当常量表达式求值）。求值器是新写的一小份
  `src/core/frontend-c/cconst.js` —— **两个现成的都不合用**：`Cpp.exprPreprocess` 是 `#if`
  那一套，只有整数，而且**没定义的名字一律当 0**（这里最不能要的就是这条：拼错的名字要
  报"不知道"）；`CGen.constExpr` 要一个正在解析中的记号流，而这儿手上只有一段文本、
  而且要在 `unit()` 之后按名字一条条问。范围是宏体里真会出现的那些：整数/浮点/字符/
  字符串字面量、一元与二元运算、`?:`、括号，以及**别的常量名**（于是
  `#define GLFW_KEY_LAST GLFW_KEY_MENU` 这种转手的链自然work）。类型转换
  （`(unsigned)x`）不认 —— 认它要一份类型解析，而宏体里并不常见；碰上了带理由跳过。

  量出来的（GLFW + GL 的真头文件一趟）：**704 条函数声明、0 条跳过；1825 个常量、
  121 条跳过**，跳过的基本全是 include 守卫（体是空的）和 `__attribute__` 那一族 ——
  它们本来就不是常量。`GL_COLOR_BUFFER_BIT = 16384`、`GLFW_KEY_LAST = 348` 都在里头。

  **jnc 那一侧两格一起接上了**：常量在用到的地方当场变成一格字面量（`cconstLit`，
  所以运行期什么都不占），而调用点发的是 `(ccall …)`（`ccallSite`，实参按 C 那边的声明
  检查、返回类型按声明给）。于是一个 jancy 写的 OpenGL 程序**一条 `import` 就够**：

      import "/opt/homebrew/lib/libglfw.dylib" with "GLFW/glfw3.h";
      import "libm" with "math.h";        // 系统库写名字不写路径

  `tests/llvm/cabi/glfw-tri.jnc` 就是它，与 `.sx` 那一份**逐字节同一个输出**
  （`framebuffer: 1600 1200` / `frames: 120`）—— 那才说明"从头文件收来的签名"与
  "手写的签名"是同一件事。顺带补的两格：`import "libm"`（预登记的系统库写名字）与
  **系统头**（`math.h` 不在 `-I` 里也不在源码旁边，那一路递一份 `#include <math.h>`
  给 C 前端，按它自己那条 include 搜索路径找 —— `cDeclsOf` 的 `opts.text`）。

  判据：`tests/c/decls/foo.h` 里那一段常量（十六进制/八进制/字符/浮点/转手引用/`?:`/
  字符串各一条，加三条求不出来的）逐字节比；`tests/llvm/run.js` 第 7 节两份 glfw 程序
  各跑一遍、再比两者的字节。

  **第六格：变参**（已落）。`(cabi printf i32 (ptr ...))` —— `...` 前面那些是**定参**，
  分界（定参个数）由声明说。为什么必须由声明说：苹果 arm64 上变参一律走**栈**而定参走
  寄存器，差一格就是读错地方（这条曾经量到过：`printf("hi %d\n", 7)` 把 7 当成定参，
  印出 1860954544）。落点是 `CCALL` 的 aux（记「定参个数 + 1」，0 才是"不是变参"，
  只经 `callVaFixed` 读）—— MIR 与 LLVM 后端本来就支持，这一刀补的是**方言那句语法**
  加 C 那条腿的原型（`extern int64_t f(int64_t, ...);`）与变参段的强制转换。

  变参那一段没有声明的类型可对，按 C 的默认实参提升办：整数、`real`、地址收；`bool`
  不收（C 会把它提升成 `int`，而这一层没有那一步，传一格 i1 过去就是读半个寄存器）。
  于是 `printf` 那一族也能从头文件里进来（`impWith` 不再跳过变参声明）。

  判据：`tests/llvm/cabi/host.c` 里那个 `omni_probe_sum(int64_t n, ...)` —— 拿 `va_arg`
  把后面 n 个逐个取出来加起来，分界错了在输出上当场看得见（`100+20+3` 要等于 `123`）。

  **第七格：`as g` 与"类型可以省"那一条**（已落）。

      import "/opt/homebrew/lib/libglfw.dylib" with "GLFW/glfw3.h" as glfw;   // glfw.glfwInit()
      import "/path/libfoo.dylib" as p;                                       // p.foo(…)：猜

  第一条只是把**函数**挂进一层命名空间（一个真库几百个名字不该占全局那一格），常量不挂
  —— 它们在 C 里本来就没有命名空间，挂上去是一种发明。查表的键带前缀（`glfw.glfwInit`，
  正是调用点 `qname` 出来的样子），而 `sym` 始终是真的 C 符号名：命名空间是这一侧的事。

  第二条是 ffi 那一族的常规做法，也是这条设计里说的"类型可以省":没有头文件时按**实参**
  推一份签名（整数 → `i64`、`real` → `f64`、字符串与指针 → `ptr`，返回当 `i64`），
  **并且报一条 warning**。同一个名字第二个调用点推出不一样的签名就报错 —— 那说明两处对
  它的看法不同，正该说出来。

  **顺带修好一条空承诺**：`diags.warn` 攒下来的东西从前**一个字都不出去**（没有任何
  地方印它），所以"推不出类型就给 warning"这条一直是空的。加了 `Diagnostics.warnings()`
  并在 jnc 那条路上印到 **stderr**（stdout 是程序自己的输出，每条腿都在按字节比它）。
  于是 `with "h"` 里跳过的那些声明也终于看得见了。

  `as` 因此成了保留字。**这一个没有量过参考树**（这台机器上没有那棵树），所以代价不敢
  说是零：真撞上一份拿 `as` 当标识符的 jancy 源码，就要把它改成上下文关键字（只在
  `import` 那一行里认）。这一点与 `with` 那次不同 —— 那次是量过的。

  判据：`tests/llvm/run.js` 第 8 节两条 —— 没有头文件时输出对、warning 在、warning 里写出
  猜的那份签名；有头文件时输出对、**一句 warning 都没有**。

  **第八格：AOT 两条腿也要能跑同一个程序**（已落）。这一格是被上面那个 OpenGL 程序**逼出来**
  的：它在 `run-jit` 上跑得好好的，而 `run-llvm` 与 `run-c` 上是一串 undefined symbol ——
  同一份源码在几条腿上要么都行要么都不行，这种不对称本身就是错。补的五件事：

  1. **`(lib …)` 接到链接命令上**（`cli.js` 的 `libLinkArgs`）。从前只有 `runViaJit` 认这一格，
     AOT 那两处一个字都没用。预登记的系统库按表走（`libm` → `-lm`），表外的当路径原样写上。
  2. **macOS 的 framework**：`(lib "OpenGL.framework")` → `-framework OpenGL`。为什么它必须
     单列一格：GL 的符号不在 libglfw 里，而在 OpenGL.framework 里，而那个 framework 的
     二进制**在 dyld 的共享缓存里、磁盘上没有那个文件** —— 路径原样交给链接器是链不上的
     （JIT 那侧反而行：`dlopen` 认共享缓存里的路径，所以那一侧把它展开成
     `/System/Library/Frameworks/X.framework/X`）。
  3. **C 那条腿上 `string` 与 `(ptr T)` 的交法**。`omni_str` 是 `{p, len}` 两个字、`omni_ptr` 是
     `{a, b, e}` 三个字，整个结构体强制转成 `void *` clang 当场就拒。交出去的是 `.p` / `.a`
     —— 与 LLVM 那条腿抽第 0 格是同一件事。界检查留在这一侧。
  4. **返回 `ptr`/`cstr` 的那些要明写一刀**（`(int64_t)(…)`）：方言这一侧接它的是 `int`，
     而 C 那边回的是 `void *`，指针到整数在 C 里不许隐式。
  5. **`__` 开头的声明一概不收**（`declsOfC`）。C 把这一族名字整个留给实现（C11 7.1.3），
     它们是标准头与编译器自己的内部件。收它们有两个实实在在的害处：`<math.h>` 里它们占了
     跳过名单的绝大多数（把真要看的那条埋掉），而 C 那条腿上重新声明 `__builtin_alloca`
     是**硬错误**。

  **顺带把上面那条"已知边界"也解掉了**：`with "stdio.h"` 之类会不会与标准头撞，取决于
  「我们发了多少条 extern 原型」—— 而从前是**声明了多少发多少**。现在只发**真被 `(ccall …)`
  调过的**（`cabiUsed`）：一句 `with "math.h"` 带进来 119 条声明，一个程序通常只调其中两个，
  剩下 117 条本来就不该落进产物。这既少了一大片撞名的机会，也是"声明是免费的"该有的样子。
  真撞上的那一条（`alloca` 在 SDK 里是 `#define alloca(x) __builtin_alloca(x)`）就是这么
  暴露出来的：它被展开成 `__builtin_alloca`，与编译器自己那份原型冲突。

  判据：`tests/llvm/run.js` 第 7 节 —— 两份源码 × 三条**原生**腿（`run-jit`/`run-llvm`/`run-c`）
  各跑一遍，六次输出**逐字节相同**。interp 那条不在里头：它没有 `(ccall …)`。

  **那个 SIGTRAP —— 查清了，是我们自己的线程**：`tests/llvm/cabi/glfw-tri.sx` 在 `run-jit`
  上 SIGTRAP（exit 133），现在跑通了（`framebuffer: 1600 1200` / `frames: 120`，与 C 参照
  逐字一致）。整条查法值得留着，因为每一步都差点走错。

  **先纠一句我自己写错的**：上一版这里写"一个字节输出都没有，连 `main` 里第一句 `print`
  都没跑到，所以是**装载期**的事"。这是错的 —— 在 lldb 底下第一句**印出来了**。看不到它
  只是因为进程死于**信号**，libc 那份带缓冲的 stdout 没来得及刷。判断一个"没有输出"的
  崩溃，第一件事是问输出是不是被缓冲吃掉了，而不是从"没跑到"往下推。

  排掉的：C 参照（clang 直接链 glfw）跑通，所以不是环境不给开窗；`ref2.c`（运行期
  `dlopen` + `dlsym` + `glfwInit`）也跑通，所以 dlopen 进来的 glfw 去初始化 AppKit 本身
  没问题；`--lib libglfw.dylib` 加在一份不引用任何 glfw 符号的 IR 上不炸。

  现场：`EXC_BREAKPOINT` 落在 AppKit 的 `NSUpdateCycleInitialize`，一句
  `NSUpdateCycle was already initialized.` 加一句 `Main thread potentially initialized
  incorrectly`。我先在 `omni_jit.c` 的调用循环前量了一句 `pthread_main_np()`，答案是
  `main thread = 1`，于是**误以为**"跑到工作线程上"这条被证伪了。差的是一层：那句量的是
  **宿主的调用点**，而真正把活挪走的在下一层。`bt all` 一下就看见了：

      thread #1  omni-jit`omni_run_entry + 164 -> _pthread_join      ← 主线程在等
    * thread #2  glfwInit -> _glfwInitCocoa -> -[NSApplication run]  ← 崩在这儿

  `omni_run_entry`（`src/runtime/omni_js_host.c`）把入口跑在一条自己开的、栈 512MB 的
  pthread 上 —— 那是为编译器自己那条深递归留的余量（8MB 的主线程栈上，"多编译一个文件"
  就是随机的 Segmentation fault）。而 macOS 上 AppKit 只能在**真主线程**上首次初始化。
  两个要求撞在一起。**这件事仓库里早就写着**：`src/runtime-gl/omni_r3_gl.c` 的文件头那段
  「上下文用 CGL，不用 GLFW」讲的就是同一个坑 —— 一年前量过一次，这回又从头量了一遍。

  **修法不是二选一**：macOS 上主线程栈的大小是**链接期**定死的，那就链接期给大 ——
  `-Wl,-stack_size,0x20000000`（512MB，只保留地址空间）。于是 `omni_run_entry` 的判断
  倒过来：**先问主线程的栈够不够大**，够就留在主线程上（两个要求同时满足），不够才开
  线程。查栈大小 macOS/BSD 用 `pthread_get_stacksize_np`，别处用 `getrlimit(RLIMIT_STACK)`；
  tcc 不认那个 `-Wl,`，那条腿照旧走线程 —— 它上面本来也没有 GUI。
  落点：`cli.js` 的 `mainStackFlags(cc)`，加在**可执行文件**的三处链接上
  （backend-c 的产物、`run-llvm` 的产物、JIT 宿主），插件那格不加。

  判据：`tests/llvm/run.js` 第 7 节 —— 开窗、画 120 帧、自己退，只查输出的形状
  （retina 上 framebuffer 是窗口的两倍，尺寸不写死），没有 glfw 就 skip。

  顺带一条一般性的：**ORC 默认就是单线程编译的**（LLJIT 的编译线程数默认 0，物化发生在
  查地址那条线程上），C API 里连设它的入口都没有。所以"让 ORC 单线程化"这个实验从一开始
  就是空转 —— 幸好先看了 `bt all`。

- **J5 FFI 第二刀（JIT → 任意库）——已落**：`--dl` 让表里没有的名字再问一次进程的动态
  符号表（`dlsym(RTLD_DEFAULT, …)`），`--lib PATH` 先 `dlopen(…, RTLD_NOW|RTLD_GLOBAL)`
  再走同一条路（于是它顺带打开 `--dl`：要一个库进来，本来就是"表里没有的去外面找"这件事）。
  与 jancy 的 `JitDefinitionGenerator::tryToGenerate` 同一个形状 —— 一个「找不到就问外面」
  的兜底生成器，区别是我们把它做成**显式开关**。

  **默认那一边没有变**：不给 `--dl` 时照旧在物化之前按名字停下（决策 2）。这一点有自己的
  用例（`dl-closed`），而且报错里要指出 `--dl` 这条路 —— 一个开关的价值全在默认那一边是
  哪一边上。验收面两条：C 那条腿的五份（libc + 三条标准流，走 `--dl`），以及 `sin`/`cos`
  走 `--lib`（对账的对象是 **AOT** 而不是解释器 —— 解释器压根没有 libm，它会明着说
  `C ABI call 'sin' is not supported`）。
  顺带量到一个坑：macOS 上 `existsSync('/usr/lib/libSystem.B.dylib')` 回 **false**
  （它在 dyld 的共享缓存里，磁盘上没有那个文件），而 `dlopen` 照样成 —— 按"文件在不在"
  挑库路径会把这条用例静默跳过。
- **J6 会话进编译器进程**：新增 ABI（`jit_open/jit_add/jit_map/jit_lookup/jit_call_i`），
  目标是把那 220ms 压到一次会话内的物化时间；同时给 REPL 一条 JIT 引擎。
- **J7 对象码缓存 —— 已落**（`--objcache PATH`）。ORC 是惰性物化的，真正花时间的是"查地址"
  那一句触发的**代码生成**，而那份机器码是 IR 的纯函数 —— 所以可以存下来。落法用 ORC 自己
  的两个口子：写走 `ObjTransformLayer` 上挂的一个变换（编译器吐出对象码时顺手落盘、原样
  传下去），读走 `LLVMOrcLLJITAddObjectFile`（直接摆一份对象码进去，不经 IR）。

  键由**调用方**算：IR 的内容 + 那个宿主二进制自己（宿主的缓存键里已经编进了编译器、
  LLVM 的版本与运行时的 `.o`）。内容寻址于是没有失效问题 —— IR 改一个字节就是另一个文件。
  落在 `.omni-cache/jitobj/`。入口的**形状**照旧从 IR 上读（`LLVMGlobalGetValueType` 那一段），
  所以两条路下游完全一样；命中时把解析出来的 module 扔掉，不然就是重复定义。

  **写不下来不算错**：缓存是可选的，一个只读的缓存目录不该让程序跑不起来。写是"先写
  `.<pid>.tmp` 再 rename"，于是两个进程同时跑同一份 IR 时谁也读不到半个文件。

  量出来（这台机器，宿主直调、去掉 node 那一层）：
  - 13.7KB 的 IR：miss ≈ 20ms，hit ≈ 10ms
  - 120KB 的 IR：miss ≈ 40–50ms，hit ≈ 10ms（对象码 22KB）——**快 4 到 5 倍**，
    而且省下的正是随模块变大而变大的那一半。

  判据（`tests/jit/run.js` 的 4f）：同一份 IR 跑两次 —— 第一次 `objcache miss` 且落下文件，
  第二次 `objcache hit`，**两次的 stdout 与退出码逐字节相同**（缓存不许改变可观测行为）。
  走宿主直调而不是 `run-jit`：后者的缓存目录是共享的，"第一次是不是 miss"会取决于别人
  跑过没有 —— 判据不该有那种依赖。

## 不做

- 不抄 jancy 的十六个 CallConv 类（ADR-0014 决策 3 已定：我们只有一个 ABI）。
- 不做 GC，也不把安全指针搬到 JIT 层 —— 那两样在 jancy 里也是编译期与运行时库的事。
- 不做惰性按函数物化的分层（tier）。先把会话与符号表做对，分层是之后拿数说话的事。
