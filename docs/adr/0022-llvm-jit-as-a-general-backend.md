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

  **下一格边界**：`04-setjmp.c` 在这条腿上**跑对了**，但 `declare` 上没有
  `returns_twice` —— `-O0` 下没事，开优化就是一个静悄悄的错答案。而 `LL_NOJMP` 那张
  名单只照到 `CCALL` 一支，外部 `CALL` 那一支从它旁边绕过去了。两者要一起收：
  名单上的那几个名字发 `declare … #returns_twice`，两支共用同一处判断。

- **J5 FFI 第二刀（JIT → 任意库）**：库表 + `dlopen` 回退，用 `libm` 的 `sin`/`cos` 验收。
  C_ABI 里 `lib: null` 的那些（libc）走 `dlsym(RTLD_DEFAULT, …)`，第三方库走 `--lib`。
- **J6 会话进编译器进程**：新增 ABI（`jit_open/jit_add/jit_map/jit_lookup/jit_call_i`），
  目标是把那 220ms 压到一次会话内的物化时间；同时给 REPL 一条 JIT 引擎。
- **J7 与增量缓存接线**：ADR-0014 决策 5 的对象码缓存挂到会话上（同一份 IR 不重编）。

## 不做

- 不抄 jancy 的十六个 CallConv 类（ADR-0014 决策 3 已定：我们只有一个 ABI）。
- 不做 GC，也不把安全指针搬到 JIT 层 —— 那两样在 jancy 里也是编译期与运行时库的事。
- 不做惰性按函数物化的分层（tier）。先把会话与符号表做对，分层是之后拿数说话的事。
