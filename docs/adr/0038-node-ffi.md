# ADR-0038：node 那条腿上的 FFI（自己的 N-API 桥，不外挂 libffi）

## 决定

**JS 那条腿上的 `(ccall …)` 落成一次真的 C 调用**，桥是**我们自己发的一份 N-API 扩展**：
按 `mod.cabi` / `mod.cabiSig` 生成一份 C（每个用到的符号一个包装函数），用我们已有的
那条 C 编译/链接路径编成 `.node`，运行期 `process.dlopen` 装进本进程。

四条约定，逐条都是"少一处发明"：

- **签名从声明来，不从调用点猜**。包装函数的形参类型就是 `mod.cabiSig[i].params`
  那几个词（`i32 i64 ptr f64 f32 bool void`），与 LLVM 那条腿的 `cabiArg`、C 那条腿的
  `cAbiExterns` 读的是同一格。三条腿于是不可能对同一个 C ABI 分叉。
- **地址就是 `$mem` 里的偏移加基址**。JS 那条腿的指针本来就是"一块 `ArrayBuffer` +
  字节偏移"（`backend-js/prelude.js` 的 `$pnew`/`$pchk`）。把那块 buffer 的**真地址**
  问出来（`napi_get_arraybuffer_info`）之后，`(ptr T)` 交给 C 的就是 `base + p[0]` ——
  **不拷进去、不拷回来**，C 直接写 JS 的那块内存。`glfwGetFramebufferSize(win, &w, &h)`
  是这一条的判据。
- **N-API 的声明自己写一份**（`src/runtime/omni_napi.h`）。N-API 是一份稳定 ABI，
  符号在装载时从 node 的可执行文件里解（macOS 上 `-undefined dynamic_lookup`、
  ELF 上什么都不用加）。所以不需要 `node-api-headers`、不需要 `node-gyp`、
  不需要 `node-addon-api` —— 那三个包在 `node_modules/` 里只是**对照用的参考**，
  这条路上一个字都不引。
- **不做通用的"按签名拼调用"**（libffi / 手写 trampoline）。那是动态计算调用约定；
  而我们**编译期就知道每一条签名**，一条声明发一个真调用是 C 编译器的活儿。
  于是这条腿上没有一行按架构分叉的代码，arm64 / x86_64 / riscv 全是同一份 C。

## 为什么现在做这件事

`tests/llvm/cabi/glfw-tri.jnc` 在三条原生腿上跑得好好的（JIT / LLVM AOT / C AOT），
而 `--backend js` 上是一句：

```
Error: C ABI symbol 'glfwInit' is only available in a native build (ADR-0014 decision 4)
```

那句话是 ADR-0014 决策 4 留下的：**那时候 JS 宿主上没有办法调 C**。现在有了 ——
我们自己就带着一整条 C 编译与链接路径（`--backend c` 那条腿、插件那格 `--shared`、
`libomnigl` 那格运行期 dlopen），缺的只是"node 这一侧的入口"。

一条源码在四条腿上要么都行要么都不行，这种对称本身就是判据（`libLinkArgs` 那一格
注释里的同一句话）。而 `mod.libs` 在 JS 这条腿上**是被默默丢掉的** —— 那是一个
"声明说了、没人听"的洞。

## 形状

```
(cabi glfwGetFramebufferSize void (ptr ptr ptr))      源码/头文件
        │
        ├─ mod.cabi[i]      = "glfwGetFramebufferSize"
        ├─ mod.cabiSig[i]   = { params: ['ptr','ptr','ptr'], ret: 'void', variadic: false }
        └─ mod.libs         = ["/opt/homebrew/lib/libglfw.dylib", "OpenGL.framework", "libm"]
        │
        ▼  backend-js/cffi.js（这一刀新加的，纯函数：mod -> 两段文本）
   ┌─ cffiSource(mod)  一份 .c：omni_napi.h + 每个符号一个包装 + napi_register_module_v1
   └─ cffiGlue(mod)    一段 JS：process.dlopen + 基址同步 + 串写进 arena
        │
        ▼  cli.js：cc -shared（+ libLinkArgs(mod.libs)）-> .omni-cache/ffi/<hash>.node
        │
        ▼  backend-js/emit.js 的 `case 'CCall'`
   $cffi.glfwGetFramebufferSize($fa(win), $fp(wp), $fp(hp))
```

`.node` 的落点按内容寻址（生成的 C + 链接命令 + 编译器 → `hash16`），所以没有失效问题；
路径通过 `OMNI_FFI_ADDON` 递给发出来的那份 JS —— **不写进 JS 正文**，那样同一个程序
发出来的字节与机器上的缓存路径无关（`jsCachePut` 那格印记于是一个字都不用改）。

## 值怎么过那道门

一格一格写清楚。左边是方言/JS 这一侧，右边是 C 那一侧，中间那一列是包装函数里用的
N-API 取值函数。

- `i32`：JS number（`Number(v) | 0`）· `napi_get_value_int32` · `int32_t`
- `i64`：JS **BigInt**（`BigInt(v)`）· `napi_get_value_bigint_int64` · `int64_t`
- `f64`：JS number · `napi_get_value_double` · `double`
- `f32`：JS number · `napi_get_value_double` · `(float)` —— 单精度是 ABI 上自己那一格，
  按 double 传就是错的调用约定（ADR-0022 的 J4d 那 67 条 `glColor3f` 一族）
- `bool`：JS boolean · `napi_get_value_bool` · `bool`
- `ptr`：JS **BigInt 的机器地址** · `napi_get_value_bigint_int64` · `void *`
- `void` 回值：`undefined`

`ptr` 那一格的地址由**发出来的 JS** 算，不由 C 猜：

- 方言的 `(ptr T)`（三元组 `[addr, base, end]`）→ `$fp(p)` = `$ffiBase() + BigInt(p[0])`
- 方言的 `(tptr T)`（一个 addr）→ `$ft(a)`，同上
- 方言的 `string`（JS 字符串）→ `$fs(s)`：在 arena 里 `$pnew` 一段 UTF-8 + 结尾零，
  回它的机器地址。与原生腿"字面量池里那条带结尾零的字节"同一个约定
- 方言的 `int` 当地址用（`long win` 那一格）→ `$fa(v)` = `BigInt(v)`，它本来就是机器地址

回值里 `i64` / `ptr` 从 C 回来是 BigInt，进方言之前过一次 `$CN`（方言的 `int` 是
"能用 number 就 number"那种规范形，prelude 文件头第一条）。

### 变参

`(cabi printf i32 (ptr ...))` 这一族：**定参按声明，变参按 C 的默认实参提升**，两档 ——
整数类（含地址）一律 `int64_t`、浮点一律 `double`。这与 C 那条腿 `case 'CCall'` 里
`raw` 那一支写的规则**逐字相同**（`(int64_t)` / `(double)`），所以两条腿印出来的
`printf("framebuffer: %d %d\n", w, h)` 是同一行字节。

包装函数这一侧于是要一格分派：JS 递一个 kinds 串（`"ii"` / `"di"` …），C 里按串查
一张生成出来的表（最多 6 格变参，`2^1+…+2^6 = 126` 条，多了就报一句真话）。
为什么不做成"运行期按类型拼调用"：那就是 libffi，而这一格的组合数是有限的、
生成出来的每一条都是编译器自己发的真调用。

## 留在门外的东西（明说，不假装）

- **非 `raw` 的 `CCall`**（JS 前端那条路上的封闭表 `hir/c_abi.js` 的 8 条 libc，
  实参是 dynamic 装箱值）照旧走 `$js_cabi_unavailable`。那一族的语义是
  `C_IN`/`C_OUT` 那对 marshaler，与这一条路的"机器值直通"不是同一件事；
  两件事混在一格会让"谁负责解箱"变成运行期的猜测。
- **C 回调进 JS**（`(cabi glfwSetKeyCallback void (ptr ptr))` 那种函数指针形参）：
  这一刀不做。它要的是"C 里一格蹦床 + N-API 的 threadsafe function"，而 `glfwPollEvents`
  是在 C 栈上回调的——那条路要先回答"事件循环一格都不转的时候怎么回 JS"。
  现在传一格 `0` 过去是合法的（那是 C 那侧的"不设回调"）。
- **交给 C 的 arena 地址只在那一次调用期间有效**。`$mgrow` 会换一块 `ArrayBuffer`
  （新 buffer + 拷贝），旧地址当场悬空。C 那边留住指针以后再用是错的 ——
  原生腿上那是合法的，这一条腿上不是。判据：`glfw-tri` 里每一个 `ptr` 实参都是
  "这次调用用完就不要了"。
- **`mir/emit_js.js` 那条腿**（C 前端 → MIR → JS）上的 `OP.CCALL` 照旧走
  `interp/libc.js` 的 `callLibc`。那一条是"C 程序在 JS 上跑"，它的 libc 是**模拟的**
  （带自己那块线性内存），把真 libc 接进去要先回答"两块内存怎么对齐"。

## 判据

`tests/llvm/cabi/glfw-tri.jnc` 在 `--backend js` 上跑出来的两行，与三条原生腿**逐字节相同**：

```
framebuffer: <w> <h>
frames: 120
```

那一行 `framebuffer:` 同时压住四格：`f32` 的调用约定（`glClearColor`）、
字符串实参（`glfwCreateWindow` 的标题）、出参（`glfwGetFramebufferSize` 写进 JS 的
`ArrayBuffer`）、以及变参（`printf`）。四格里任何一格错了那两行就不一样。

---

# 第二刀：注入（`tcc -run` 那个形状），编到文件降为备选

## 决定

**默认那条路改成"在本进程里造出机器码，注进一格固定的宿主扩展"** —— 生成的那份 C 交给
**我们自己那台 C 前端**（`frontend-c` → MIR → arm64/x64 → 目标字节），在 JS 里重定位到
宿主给的那块可执行内存上，然后叫一次 `napi_register_module_v1`。

**"写一份 `.c`、叫外部 cc、编出一个 `.node`、`dlopen`"降为备选**（`OMNI_FFI=cc`）。
它更通用（谁的 cc 都行、什么 C 都吃得下），所以留着当逃生门 —— 但它不该是默认，
理由有两条量得出来的：一次 `fork/exec`、一次落盘，以及**一个外部 cc 的硬依赖**。

生成的那份 C **一个字都不用改**：两条路吃的是同一份 `cffiSource(mod)` 文本，出口都是
`napi_register_module_v1(env, exports)`。这是这一刀最重要的一格 —— 两条路不是两种语义，
是同一份 C 的两种交付方式。

## 可执行内存这件事：照 tcc 的做法，不发明

这一格是硬要求，不是细节：**注进去的字节要能跑，就得有一页可执行的内存**。
照参考树里那一份（`/Users/wurui/Documents/Lang/reference/tinycc/tccrun.c`）逐条抄：

- **内存不是 mmap 来的，是 `tcc_malloc` 来的**（`tccrun.c:143`，多要一页好对齐）。
  mmap 那一路只在 `CONFIG_SELINUX` 下走：建一个临时文件、`mmap` 两次 —— 一份
  `PROT_READ|PROT_EXEC`、另一份 `PROT_READ|PROT_WRITE` 摆在固定距离上（`ptr_diff`），
  写走 RW 那个别名（`tccrun.c:128-134`）。那是 W^X 严格的机器上的兜底。
- **权限是 `mprotect` 一节一节设的**（`protect_pages`，`tccrun.c:468`）：四档
  `rx / ro / rw / rwx`。
- **arm64 / arm / riscv 上 `mprotect` 之后必须刷指令缓存** ——
  `__clear_cache(ptr, ptr + length)`（`tccrun.c:492-493`）。少这一句的症状是"有时候对、
  有时候跑到旧字节上"，而那种错不可复现。
- **macOS 上 `.text` 必须单独占页**：`CONFIG_RUNMEM_RO` 在 `__APPLE__` 下是 1
  （`tccrun.c:320-326`），也就是 `.text` 是 `rx`、别的是 `rw`，**不允许**把代码页做成
  `rwx` 那一档。tcc 自己那句注释写得很清楚：有些目标的安全选项不许写可执行的代码页。

**在 node 这个进程里到底行不行 —— 量过了**（探针：写一段 arm64 的 `mov w0,#42; ret`
进去再调它；这台机器是 arm64 macOS + node 26.8.2）：

```
A malloc + mprotect(RX)                     = 42   ← tcc 的默认路径，行
B mmap(RW,ANON) + mprotect(RX)              = 42   行
C mmap(RWX, MAP_JIT) + jit_write_protect_np = 42   行
```

三种都行。于是**选 A/B 那一路**（与 tcc 同形），不用 `MAP_JIT`：`MAP_JIT` 要
`com.apple.security.cs.allow-jit` 那个 entitlement，那是"这个 node 二进制是怎么签的"
的性质，不该成为我们这条路的前提。刷缓存用 `sys_icache_invalidate`（Apple）／
`__builtin___clear_cache`（别处）。

这三条不写成一次性的探针，而是**落在宿主里当一道梯子**：`mem()` 先试 A，
拿不到可执行页就退到 B、再退到 C，一个都不成就报一句真话（**不假装成功** ——
那会变成"注进去然后 SIGBUS"，而那种错离原因很远）。


## 固定的那格宿主扩展

`src/jit/omni_ffi_host.c` —— **一份固定的源码**，与被注入的程序无关，所以整台机器上
只编一次（内容寻址，和 `buildJitHost` 同一套路）。它导出的东西只够"把一块字节变成
能跑的代码"，一条业务逻辑都没有：

- `mem(size) -> {addr, buf}` —— 要一块页对齐的内存，回它的机器地址与一格
  **external ArrayBuffer**（`napi_create_external_arraybuffer`）。于是 JS 那侧
  **直接往那块内存里写字节**，零拷贝、不用 `write(addr, bytes)` 这种调用。
- `protect(addr, len, mode)` —— `mprotect` 那四档 + arm64 上刷指令缓存。
- `dlopen(path)` / `sym(name)` —— `(lib …)` 那几个库装进进程、`dlsym(RTLD_DEFAULT, …)`
  问一个符号的地址。与 `omni_jit.c` 的 `--lib` / `--dl` 是同一件事、同一个立场
  （ADR-0022 决策 2）。
- `init(addr) -> exports` —— 把那个地址当成
  `napi_value (*)(napi_env, napi_value)` 叫一次，把它回的对象交出来。

**重定位在 JS 里做**，不在 C 里 —— 那台链接器已经在 JS 里了（`link/elf_exe.js`、
`link/macho_exe.js`、`link/elf_merge.js` 的 `linkObjects`）。宿主只回答两个问题：
"装到哪个地址"（`mem`）与"外面那些符号在哪"（`sym`）。这与 tcc 的分工完全一致：
`tcc_relocate` 拿到一块内存就自己布局、自己打重定位，`tcc_get_symbol` 只是查表。

需要新加的一格是链接器的**平铺映像**模式：`flatImage(objs, base, resolve)` —— 按
`rx / ro / rw` 三档分页布局（照 `tcc_relocate_ex` 的 `for (k = 0; k < 3; ++k)`）、
未定义符号交给 `resolve(name)` 回一个真地址。它与现有那两条出口（写 ELF/Mach-O 文件）
共用同一套重定位代码，只是不写文件头。

## 量出来的账（这台机器，arm64 macOS，465 行生成的 C + 三个库）

一次**冷**的 FFI 准备，两条路各自的成本：

- 写 `.c` 落盘 —— cc 那条路有，注入那条路**没有**
- `fork/exec` 的底 —— `spawnSync('/usr/bin/true')` **2.02 ms**（20 次平均）
- 编 + 链
  - 外部 clang `-shared`：`spawnSync` 量 **145.3 ms**（5 次平均）；不经 node 的
    `time cc` 是 **92 ms**。两个数都记着 —— 差的那一段就是 node 这一侧的 spawn 开销
  - 我们自己那台：**47 ms**（`cpp + lower` 37 ms、`codegen` 9 ms、写字节 1 ms，
    `omni c obj -v` 逐格印出来的），而且**已经在本进程里**，没有那 2 ms 与那次落盘
- 装载
  - `process.dlopen` 小的那份（238 行、只 libc）：**1.85 ms**
  - `process.dlopen` 大的那份（带 libglfw + OpenGL.framework）：**197.8 ms** ——
    这一格**不是 `.node` 的成本**，是那两个库第一次进这个进程的成本。注入那条路
    同样要 `dlopen` 它们（`glfwInit` 的地址得有人给），所以这 197 ms 两条路都跑不掉

### 接完之后的整程序墙上时间（`run tests/llvm/cabi/va-printf.sx`，238 行 C、只 libc）

- 注入 **冷 362 ms** · **热 160 ms**
- cc   **冷 511 ms** · **热 131 ms**

逐格拆（`-v`，热）：注入那条是 `ffi host` 装宿主 **16 ms** + `ffi inject` 铺映像 **9 ms**；
cc 那条热的时候这两格都没有，只在 `exec` 里多 5 ms（那一次 `dlopen`）。

**结论（诚实版）**：

- **冷**：注入省 **~150 ms**，而且**一个外部 cc 都不要** —— 这是这一刀真正要的东西。
- **热**：cc 那条**反而快 ~29 ms**。原因看得见：注入每次都要装那格宿主（16 ms）
  再铺一次映像（9 ms），而 cc 那条只剩一次 1.85 ms 的 `dlopen`。
- 那 29 ms 换来的是"不依赖外部 cc"。**这是一笔明知的交易，不是退步** ——
  而且它有下一刀可做：宿主装载可以在一个进程里只做一次（现在就是，`FFI_HOST` 那格
  缓存住了），铺映像那 9 ms 里大半是读那 46512 字节的 `.o` 再逐字节转成 `Uint8Array`
  （`readBinary` 回的是 latin1 串）—— 那一格可以省。

**对象字节（`.o`）必须进内容寻址缓存**，这一条不是优化、是这条路成立的前提：
不缓存的话每次都要重编那 47 ms，热路径上注入就成了明显更慢的那一条。
落点 `.omni-cache/ffi-obj/<key>.o`，键是那份 C 的内容 + 目标。

整份 CLI 的启动底是 ~110 ms（node + 装插件），上面那几个数都含它。


## 这条路打通之后顺带解决的事

`omni c run x.c` 现在是"编出一个可执行文件、`spawn` 它"，退出码是那个进程的退出码
（`cli.js` 里那句注释：与 `tcc -run` 逐条相同，那也是这一刀的 oracle）。有了这台
注入机器之后，那一条可以变成**同一个进程**里的 `tcc -run` —— 与真 `tcc -run`
处在同一个可比位置上（都是"进程内造码然后跳进去"），而不是"我们多一次 fork"。

那是下一刀的事，不在这一刀的判据里。这一刀只要求：**FFI 那格扩展走注入这条路，
`OMNI_FFI=cc` 还能一句话切回去，两条路发的是同一份 C、跑出同一份字节。**

## 落地在哪儿（第二刀）

- `src/jit/omni_ffi_host.c` —— 那格**固定**宿主，六个口子：`page` / `mem` / `protect` /
  `dlopen` / `sym` / `init`。与被注入的程序无关，所以整台机器上只编一次
  （`.omni-cache/ffi-host/<key>/`，键是它自己那两份源码 + 编译器）。
- `src/core/link/flat_image.js` —— `flatImage({objs, reserve, resolve, page})`：
  三档分页布局 + GOT + 桩子 + 重定位，回 `{base, size, bytes, ranges, syms}`。
- `src/core/host/ffi_host.js` —— `dlopenAddon` / `publishCffi` / `hasAddonLoader`。
  与 `src_eval.js` 同一个形状（`process` 不在我们自己那份 JS 子集里，所以走 `evalJs`
  那扇已经在的门；摆全局那一格照 `$OMNI_SRC_EVAL` 的先例）。
- `src/core/cli.js` —— `ffiHost()` / `ffiObject()` / `ffiInject()` / `ffiPrepare()`；
  `ffiAddon()` 留在那儿当备选。发出来那份 JS 的 glue **先看全局的 `$OMNI_CFFI`、
  再看 `OMNI_FFI_ADDON`** —— 于是 `omni build --backend js` 出来的独立产物
  （编译器不在场，没有那格全局）自动落到 cc 那条路上。


