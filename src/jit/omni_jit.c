/*
 * Omni — LLVM ORC JIT 宿主（ADR-0014 决策 3 第二阶段）
 *
 * 为什么是一个**独立的 C 文件**而不是编译器里的一段 Omni 代码：封闭的 C_ABI
 * （ADR-0014 决策 4）只有七个标量类型，没有出参、没有取址，更关键的是**没有
 * 「按一个 ptr 间接调用」这条操作**。而 JIT 的最后一步恰恰就是它 —— 拿到地址跳进去。
 * 补上间接调用等于给 JS 域一把任意函数指针，那是另开一条 ADR 的事，不该顺手做。
 * 所以 ORC 的那一段留在 C 里，和 jancy 的做法同形（它的 ORC 集成也只有 345 行）。
 *
 * 为什么不放在 runtime/ 下：c_runtime.js 的 runtimeSources() 是把 runtime/*.c 全都
 * 喂给 cc 的。这个文件要 LLVM 头，普通的 C 后端不该因此就依赖 LLVM。
 *
 * 与 AOT 共用同一个发射器是文本 IR 那个选择的全部回报：这里读的 .ll 和
 * `omni emit-llvm` 印出来的是同一份字节。
 *
 *   omni-jit FILE.ll [SYMBOL] [-- ARG...]
 *
 * 默认 SYMBOL 是 `main` —— 发射器已经发了一个和 AOT 一样的 main（omni_host_init ->
 * omni_main -> omni_js_check_uncaught -> fflush -> omni_host_exit_code），所以
 * 直接调它，退出码、未捕获异常、刷缓冲这些语义一个字都不用在这里重写。
 *
 * `--` 之后的东西是**给被调那个 main 的命令行参数**。没有它的时候，第二个位置参数
 * 就只能是 SYMBOL —— 于是 `omni-jit x.ll samples 1024` 会去找一个叫 `samples` 的符号，
 * 报 `Symbols not found: [ _samples ]`。这一层原本是含糊的：函数签名摆明了要把 argv
 * 传进去（`main(argc-1, argv+1)`），但任何一个参数都会被当成符号名截走。
 */


#include <llvm-c/Core.h>
#include <llvm-c/Error.h>
#include <llvm-c/IRReader.h>
#include <llvm-c/LLJIT.h>
#include <llvm-c/Orc.h>
#include <llvm-c/Target.h>
#include <llvm-c/TargetMachine.h>
#include <llvm-c/Transforms/PassBuilder.h>

#include "omni_jit_symbols.h"

#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* LLVMInitializeNativeTarget 一族是 Target.h 里的 static inline，展开成
   当前架构那几个真符号。这里照 LLVM 自己的宏来，别的架构加一条 #elif 就行。 */
static void omni_jit_init_target(void) {
  LLVMInitializeNativeTarget();
  LLVMInitializeNativeAsmPrinter();
}

/* **入口跑在哪个线程上**（ADR-0022 的 J4d）。macOS 上这不是好奇心：AppKit 只能在进程的
   真主线程上首次初始化，而 `glfwInit` 一进去就是 `[NSApplication sharedApplication]`。
   不在主线程上的话症状是 `NSUpdateCycle was already initialized.` 加一个 SIGTRAP，
   **一句诊断都没有** —— 而且我们那份带缓冲的 stdout 会跟着一起丢，看起来像"什么都没跑"。
   查得到就报真话，查不到（不是 macOS/BSD 那族）就当"是主线程"，不假装知道。 */
static int omni_jit_main_thread(void) {
#if defined(__APPLE__) || defined(__FreeBSD__)
  return pthread_main_np() != 0;
#else
  return 1;
#endif
}

/* ------------------------------------------------------- 对象码缓存（J7）
 *
 * ORC 是惰性物化的：真正花时间的是"查地址"那一句触发的**代码生成**。同一份 IR 反复跑
 * （REPL、跑测试、同一个程序改一行外面的东西）每次都重新生成一遍机器码，而那一份机器码
 * 是 IR 的纯函数 —— 所以可以存下来。
 *
 * 落法是 ORC 自己的两个口子：
 *   - **写**：`ObjTransformLayer` 上挂一个变换，编译器吐出对象码时顺手落盘（原样传下去）。
 *   - **读**：`LLVMOrcLLJITAddObjectFile` —— 直接摆一份对象码进去，不经 IR。
 *
 * 缓存的键由**调用方**（cli.js）算：IR 的内容 + 那个宿主二进制自己（它编进了 LLVM 的版本
 * 与运行时的 .o）。所以这一层只认一个路径，不判断"新不新" —— 内容寻址的缓存没有失效问题。
 *
 * 写不下来**不算错**：缓存是可选的。这条很重要 —— 一个只读的缓存目录不该让程序跑不起来。
 */
static char omni_objcache[4096];

static LLVMErrorRef omni_objcache_write(void *ctx, LLVMMemoryBufferRef *obj) {
  (void)ctx;
  if (omni_objcache[0] == '\0' || obj == NULL || *obj == NULL) return NULL;
  /* 先写临时名再 rename：两个进程同时跑同一份 IR 时，谁也不会读到半个文件。 */
  char tmp[4200];
  snprintf(tmp, sizeof tmp, "%s.%d.tmp", omni_objcache, (int)getpid());
  FILE *f = fopen(tmp, "wb");
  if (f == NULL) return NULL;
  const char *p = LLVMGetBufferStart(*obj);
  size_t n = LLVMGetBufferSize(*obj);
  size_t w = fwrite(p, 1, n, f);
  int ok = (fclose(f) == 0) && (w == n);
  if (ok) {
    if (rename(tmp, omni_objcache) != 0) remove(tmp);
  } else {
    remove(tmp);
  }
  return NULL;
}

static int omni_jit_fail(LLVMErrorRef e, const char *what) {  char *m = LLVMGetErrorMessage(e);
  fprintf(stderr, "omni-jit: %s: %s\n", what, m);
  LLVMDisposeErrorMessage(m);
  return 70;   /* 与 omni_error 的退出码一致 */
}

static char *omni_jit_slurp(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (f == NULL) return NULL;
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
  long n = ftell(f);
  if (n < 0 || fseek(f, 0, SEEK_SET) != 0) { fclose(f); return NULL; }
  char *buf = (char *)malloc((size_t)n + 1);
  if (buf == NULL) { fclose(f); return NULL; }
  if (fread(buf, 1, (size_t)n, f) != (size_t)n) { free(buf); fclose(f); return NULL; }
  buf[n] = 0;
  *len = (size_t)n;
  fclose(f);
  return buf;
}

/** 名字拷进一格缓冲：LLVMGetValueName2 给的是 (指针, 长度)，别指望它一定收尾 */
static const char *omni_jit_name(LLVMValueRef v, char *buf, size_t cap) {
  size_t len = 0;
  const char *p = LLVMGetValueName2(v, &len);
  if (p == NULL || len == 0 || len >= cap) return NULL;
  memcpy(buf, p, len);
  buf[len] = 0;
  return buf;
}

/** 这个名字收过了吗；没收过就记下来。一批模块里同一个 `declare` 会出现好多次。 */
static int omni_jit_seen(char (*seen)[256], size_t *nseen, const char *nm) {
  for (size_t i = 0; i < *nseen; i++) {
    if (strcmp(seen[i], nm) == 0) return 1;
  }
  snprintf(seen[*nseen], 256, "%s", nm);
  (*nseen)++;
  return 0;
}

/**
 * 这一批模块里有谁**定义**了这个名字吗（ADR-0022 的 J6）。
 *
 * 一次会话是**好几份产物摆进同一个 JITDylib**：第二批里的 `@g_base` 是一句
 * `external global`、`@s_f1` 是一句 `declare`，它们的落点在**第一批**里。所以扫描那一步
 * 不能把这类名字当"外面的符号"—— 那会得到一句假的 `unresolved: g_base`，而 ORC 自己
 * 一查就找到了。
 */
static int omni_jit_defined_in(LLVMModuleRef *mods, int nmods, const char *nm) {
  for (int i = 0; i < nmods; i++) {
    LLVMValueRef f = LLVMGetNamedFunction(mods[i], nm);
    if (f != NULL && LLVMIsDeclaration(f) == 0) return 1;
    LLVMValueRef g = LLVMGetNamedGlobal(mods[i], nm);
    if (g != NULL && LLVMIsDeclaration(g) == 0) return 1;
  }
  return 0;
}

/**
 * 宿主符号：**表里有的定义进去，表里没有的当场报**（ADR-0022 决策 2）。
 *
 * 两步分开做，因为它们回答的是两个问题：
 *   - 定义那一步要**无条件**摆上整张表 —— 代码生成器自己合成的 `memcpy`/`bzero`
 *     在 IR 里看不见，靠"扫一遍 declare"发现不了（jancy 的 addStdSymbols 同理）。
 *   - 扫描那一步只为**诊断**：ORC 是惰性物化的，等它自己报"Symbols not found"
 *     时程序可能已经打了半屏输出，而且那句话里是带平台前缀的 `_foo`。
 *
 * 模块自己有体的同名符号归模块（现在没有这样的名字；FFI 覆盖运行时某一格时就会有）。
 *
 * **一次收下这一批模块**（J6）：一格名字只能定义一次，而 `omni_print_int` 这种
 * 每批的 IR 里都有一句声明 —— 分批调这个函数就是重复定义。所以两步都跨整批做一遍。
 *
 * `dl != 0`（`--dl`，ADR-0022 的 J5）时，表里没有的名字**再问一次进程的动态符号表**
 * （`dlsym(RTLD_DEFAULT, …)`）—— C 那条腿的 `printf`/`__stdoutp` 那一族就是这么进来的。
 * 它默认是**关**的，这一点是 J2 那个决定的全部内容：`--dl` 一给，这个进程里所有导出的
 * 东西就都在射程内了，那必须是显式要来的，不能是默认。`--lib` 先 `dlopen` 再走同一条路
 * （`RTLD_GLOBAL`，于是 `RTLD_DEFAULT` 找得到）—— 与 jancy 的 `JitDefinitionGenerator`
 * 同一个形状：一个"找不到就问外面"的兜底生成器，只是我们把它做成显式开关。
 */
static int omni_jit_define(LLVMOrcLLJITRef jit, LLVMOrcJITDylibRef jd, LLVMModuleRef *mods,
                           int nmods, int dl) {
  size_t n = 0;
  while (OMNI_JIT_SYMS[n].name != NULL) n++;
  LLVMOrcCSymbolMapPair *pairs = (LLVMOrcCSymbolMapPair *)malloc(sizeof(LLVMOrcCSymbolMapPair) * n);
  if (pairs == NULL) {
    fprintf(stderr, "omni-jit: out of memory\n");
    return 70;
  }
  size_t m = 0;
  for (size_t i = 0; i < n; i++) {
    const char *nm = OMNI_JIT_SYMS[i].name;
    if (omni_jit_defined_in(mods, nmods, nm)) continue;
    pairs[m].Name = LLVMOrcLLJITMangleAndIntern(jit, nm);
    pairs[m].Sym.Address = (LLVMOrcExecutorAddress)(uintptr_t)OMNI_JIT_SYMS[i].addr;
    pairs[m].Sym.Flags.GenericFlags =
      (uint8_t)(LLVMJITSymbolGenericFlagsExported | LLVMJITSymbolGenericFlagsCallable);
    pairs[m].Sym.Flags.TargetFlags = 0;
    m++;
  }
  LLVMErrorRef err = LLVMOrcJITDylibDefine(jd, LLVMOrcAbsoluteSymbols(pairs, m));
  free(pairs);
  if (err != NULL) return omni_jit_fail(err, "cannot define host symbols");

  /* 表里没有的那些：先数一遍声明（要给 dlsym 那批留位置），再走一遍决定每一个的去处。
     一批里同一个名字会出现好多次（每份 IR 都有自己的 `declare printf`），所以要有一格
     "收过了吗" —— 不然既会重复定义、又会把同一句 unresolved 报好几遍。 */
  size_t ndecl = 0;
  for (int mi = 0; mi < nmods; mi++) {
    for (LLVMValueRef f = LLVMGetFirstFunction(mods[mi]); f != NULL; f = LLVMGetNextFunction(f)) ndecl++;
    for (LLVMValueRef g = LLVMGetFirstGlobal(mods[mi]); g != NULL; g = LLVMGetNextGlobal(g)) ndecl++;
  }
  LLVMOrcCSymbolMapPair *dls = NULL;
  if (dl != 0 && ndecl > 0) {
    dls = (LLVMOrcCSymbolMapPair *)malloc(sizeof(LLVMOrcCSymbolMapPair) * ndecl);
    if (dls == NULL) {
      fprintf(stderr, "omni-jit: out of memory\n");
      return 70;
    }
  }
  char (*seen)[256] = NULL;
  if (ndecl > 0) {
    seen = (char (*)[256])malloc(256 * ndecl);
    if (seen == NULL) {
      free(dls);
      fprintf(stderr, "omni-jit: out of memory\n");
      return 70;
    }
  }
  size_t nseen = 0;
  size_t nd = 0;
  char buf[256];
  int missing = 0;
  for (int mi = 0; mi < nmods; mi++) {
    LLVMModuleRef mod = mods[mi];
    for (LLVMValueRef f = LLVMGetFirstFunction(mod); f != NULL; f = LLVMGetNextFunction(f)) {
      if (LLVMIsDeclaration(f) == 0) continue;
      if (LLVMGetIntrinsicID(f) != 0) continue;   /* llvm.* 由 LLVM 自己降 */
      const char *nm = omni_jit_name(f, buf, sizeof buf);
      if (nm == NULL || omni_jit_symbol(nm) != NULL) continue;
      /* 落点在这一批**别的模块**里（会话里跨批调函数就是这个形状）：不是外面的符号 */
      if (omni_jit_defined_in(mods, nmods, nm)) continue;
      if (omni_jit_seen(seen, &nseen, nm)) continue;
      void *a = dl != 0 ? dlsym(RTLD_DEFAULT, nm) : NULL;
      if (a == NULL) { fprintf(stderr, "omni-jit: unresolved: %s\n", nm); missing++; continue; }
      dls[nd].Name = LLVMOrcLLJITMangleAndIntern(jit, nm);
      dls[nd].Sym.Address = (LLVMOrcExecutorAddress)(uintptr_t)a;
      dls[nd].Sym.Flags.GenericFlags =
        (uint8_t)(LLVMJITSymbolGenericFlagsExported | LLVMJITSymbolGenericFlagsCallable);
      dls[nd].Sym.Flags.TargetFlags = 0;
      nd++;
    }
    for (LLVMValueRef g = LLVMGetFirstGlobal(mod); g != NULL; g = LLVMGetNextGlobal(g)) {
      if (LLVMIsDeclaration(g) == 0) continue;
      const char *nm = omni_jit_name(g, buf, sizeof buf);
      if (nm == NULL || omni_jit_symbol(nm) != NULL) continue;
      if (omni_jit_defined_in(mods, nmods, nm)) continue;
      if (omni_jit_seen(seen, &nseen, nm)) continue;
      void *a = dl != 0 ? dlsym(RTLD_DEFAULT, nm) : NULL;
      if (a == NULL) { fprintf(stderr, "omni-jit: unresolved: %s\n", nm); missing++; continue; }
      /* 数据符号：不带 Callable —— 这一位是给"能跳进去"的东西的。 */
      dls[nd].Name = LLVMOrcLLJITMangleAndIntern(jit, nm);
      dls[nd].Sym.Address = (LLVMOrcExecutorAddress)(uintptr_t)a;
      dls[nd].Sym.Flags.GenericFlags = (uint8_t)LLVMJITSymbolGenericFlagsExported;
      dls[nd].Sym.Flags.TargetFlags = 0;
      nd++;
    }
  }
  free(seen);
  if (nd > 0) {
    LLVMErrorRef e2 = LLVMOrcJITDylibDefine(jd, LLVMOrcAbsoluteSymbols(dls, nd));
    free(dls);
    if (e2 != NULL) return omni_jit_fail(e2, "cannot define dlsym symbols");
  } else if (dls != NULL) {
    free(dls);
  }
  if (missing > 0) {
    if (dl != 0) {
      fprintf(stderr, "omni-jit: %d 个符号宿主表与进程的动态符号表里都没有"
              "（--lib 把带它的那个库加进来，或者补进 src/jit/omni_jit_symbols.c）\n", missing);
    } else {
      fprintf(stderr, "omni-jit: %d 个符号宿主表里没有（补进 src/jit/omni_jit_symbols.c，"
              "或者用 --dl 让它们去问进程的动态符号表，"
              "或者是后端发错了名字）\n", missing);
    }
    return 70;
  }
  return 0;
}

/* 一次能叫几个入口。够用就行 —— 真要成百上千个入口时该做的是 J6 那格会话，不是把这个数改大。 */
#define OMNI_JIT_MAX_CALLS 16

/* 一次能摆几份 IR 进同一个 JITDylib（`--add`，J6）。REPL 一批一份，够长的会话要的是
   真会话 ABI（那时这个数就该没有了），所以这里也只要一个够用的上界。 */
#define OMNI_JIT_MAX_MODS 32

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: omni-jit FILE.ll [SYMBOL] [--call SYM]... [--add FILE.ll]..."
            " [--repeat N] [--dl] [--lib PATH]... [--objcache PATH] [-- ARG...]\n");

    return 64;
  }
  const char *path = argv[1];
  const char *calls[OMNI_JIT_MAX_CALLS];
  int ncalls = 0;
  /* 摆进同一个 JITDylib 的那几份 IR（`--add`，J6）：第 0 格是位置上那一份。 */
  const char *paths[OMNI_JIT_MAX_MODS];
  int nmods = 0;
  paths[nmods++] = path;
  long repeat = 1;
  int dl = 0;               /* --dl / --lib：表里没有的名字去问进程的动态符号表（J5） */
  const char *pos = NULL;   /* 老写法里那个位置参数（等价于一个 --call） */

  /* 被调那个 main 看到的 argv：第 0 格照旧是 `.ll` 的路径（没有 `--` 时的老行为就是
     `argv+1`，一个字节都不变），`--` 之后的原样接在后面。argv 本身可写，所以把 `--`
     那一格改写成路径就够了 —— 不用另分配一个数组。 */
  char **eargv = argv + 1;
  int eargc = argc - 1;

  for (int i = 2; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      argv[i] = (char *)path;
      eargv = argv + i;
      eargc = argc - i;
      break;
    }
    if (strcmp(argv[i], "--call") == 0) {
      if (i + 1 >= argc) { fprintf(stderr, "omni-jit: --call 要一个符号名\n"); return 64; }
      if (ncalls >= OMNI_JIT_MAX_CALLS) {
        fprintf(stderr, "omni-jit: --call 最多 %d 个\n", OMNI_JIT_MAX_CALLS);
        return 64;
      }
      calls[ncalls++] = argv[++i];
      continue;
    }
    if (strcmp(argv[i], "--repeat") == 0) {
      if (i + 1 >= argc) { fprintf(stderr, "omni-jit: --repeat 要一个次数\n"); return 64; }
      repeat = atol(argv[++i]);
      if (repeat < 1) { fprintf(stderr, "omni-jit: --repeat 要 >= 1\n"); return 64; }
      continue;
    }
    if (strcmp(argv[i], "--dl") == 0) { dl = 1; continue; }
    /* `--add FILE.ll`：再摆一份 IR 进**同一个** JITDylib（J6）。会话就是这个形状 ——
       第二批里的 `@g_base` 是一句 external global、`@s_f1` 是一句 declare，落点在第一批
       那份 IR 里，由 ORC 自己接上。 */
    if (strcmp(argv[i], "--add") == 0) {
      if (i + 1 >= argc) { fprintf(stderr, "omni-jit: --add 要一个路径\n"); return 64; }
      if (nmods >= OMNI_JIT_MAX_MODS) {
        fprintf(stderr, "omni-jit: --add 最多 %d 份\n", OMNI_JIT_MAX_MODS - 1);
        return 64;
      }
      paths[nmods++] = argv[++i];
      continue;
    }
    /* `--lib PATH`：把那个库装进这个进程（`RTLD_GLOBAL`，于是 `RTLD_DEFAULT` 找得到），
       并且顺带打开 `--dl` —— 要一个库进来，本来就是"表里没有的去外面找"这件事。 */
    if (strcmp(argv[i], "--lib") == 0) {
      if (i + 1 >= argc) { fprintf(stderr, "omni-jit: --lib 要一个路径\n"); return 64; }
      const char *lib = argv[++i];
      if (dlopen(lib, RTLD_NOW | RTLD_GLOBAL) == NULL) {
        fprintf(stderr, "omni-jit: 装不上 %s：%s\n", lib, dlerror());
        return 70;
      }
      dl = 1;
      continue;
    }
    /* `--objcache PATH`：这份 IR 的对象码存在哪儿（J7）。键由调用方算（内容寻址），
       所以这一层只认路径 —— 有就用、没有就生成完落一份。 */
    if (strcmp(argv[i], "--objcache") == 0) {
      if (i + 1 >= argc) { fprintf(stderr, "omni-jit: --objcache 要一个路径\n"); return 64; }
      const char *op = argv[++i];
      if (strlen(op) + 1 > sizeof omni_objcache) {
        fprintf(stderr, "omni-jit: --objcache 的路径太长\n");
        return 64;
      }
      snprintf(omni_objcache, sizeof omni_objcache, "%s", op);
      continue;
    }
    if (argv[i][0] == '-') {

      fprintf(stderr, "omni-jit: 不认识的开关 %s\n", argv[i]);
      return 64;
    }
    if (pos != NULL) {
      fprintf(stderr, "omni-jit: 位置参数只能有一个（要叫多个入口用 --call）\n");
      return 64;
    }
    pos = argv[i];
  }
  if (ncalls == 0) calls[ncalls++] = pos != NULL ? pos : "main";
  /* 对象码缓存的键是**一份 IR** 的内容（J7 里由调用方算），一次会话有好几份 —— 两者一起
     用等于让几份 IR 抢同一个文件。所以明着拒绝，而不是留一个静悄悄错的组合。 */
  if (nmods > 1 && omni_objcache[0] != '\0') {
    fprintf(stderr, "omni-jit: --objcache 与 --add 不能一起用（缓存的键是一份 IR 的内容）\n");
    return 64;
  }

  omni_jit_init_target();

  LLVMOrcLLJITRef jit = NULL;
  LLVMErrorRef err = LLVMOrcCreateLLJIT(&jit, NULL);
  if (err != NULL) return omni_jit_fail(err, "cannot create LLJIT");

  /* 文本 -> Module。MemoryBuffer 接管 text 的所有权（不复制），所以不能提前 free。
     几份 IR 进**同一个 LLVMContext**（`--add`，J6）：它们互相引用符号，类型也要在同一个
     上下文里才敢摆进同一个 JITDylib。 */
  LLVMContextRef ctx = LLVMContextCreate();
  LLVMModuleRef mods[OMNI_JIT_MAX_MODS];
  for (int mi = 0; mi < nmods; mi++) {
    size_t len = 0;
    char *text = omni_jit_slurp(paths[mi], &len);
    if (text == NULL) {
      fprintf(stderr, "omni-jit: cannot read %s\n", paths[mi]);
      return 66;
    }
    LLVMMemoryBufferRef mb = LLVMCreateMemoryBufferWithMemoryRange(text, len, paths[mi], 0);
    mods[mi] = NULL;
    char *msg = NULL;
    if (LLVMParseIRInContext(ctx, mb, &mods[mi], &msg) != 0) {
      fprintf(stderr, "omni-jit: %s is not valid IR: %s\n", paths[mi], msg == NULL ? "?" : msg);
      LLVMDisposeMessage(msg);
      return 65;
    }
  }
  LLVMModuleRef mod = mods[0];

  /* **中端优化管线**（2026-09-25）。LLJIT 只做 codegen —— 它**不跑一个 IR 通道**，
     于是这条腿等于 `clang -O0` 的中端配上后端的寄存器分配。量出来的差就是这一格：
     `tigrou/balls2k.pss` 上 jit 5.5ms/帧、同一份 IR 走 clang -O2 是 0.3~0.4ms/帧。
     而这条腿是**主要基准**（要与原版的 x87 JIT 平齐，clang 是上限），所以默认就跑
     `default<O2>` —— 与 clang -O2 同一条管线，两边的差从此只剩"我们发的 IR 长什么样"。

     `OMNI_JIT_OPT=0` 关掉（查"是不是优化改坏了答案"用），`=1/=2/=3` 选档。
     **档位要进对象码缓存的名字**：那份缓存的键是 IR 的内容，不含这一格 ——
     不带上它的话 `OMNI_JIT_OPT=0` 会安静地端上一份 O2 编好的对象码（同一类"会跑错
     程序的缓存"，见 cli.js 里 runtimeObjectsSelf 那段注）。 */
  int optlvl = 2;
  {
    const char *ov = getenv("OMNI_JIT_OPT");
    if (ov != NULL && ov[0] != '\0') optlvl = atoi(ov);
    if (optlvl < 0) optlvl = 0;
    if (optlvl > 3) optlvl = 3;
  }
  if (omni_objcache[0] != '\0') {
    size_t n = strlen(omni_objcache);
    if (n + 4 < sizeof omni_objcache) snprintf(omni_objcache + n, 4, ".O%d", optlvl);
  }
  if (optlvl > 0) {
    char pipe[32];
    snprintf(pipe, sizeof pipe, "default<O%d>", optlvl);
    /* TargetMachine 递进去是为了让通道看得见这台机器的 CPU 与特性（向量化那一族
       靠它）。拿不到就递 NULL —— 管线照跑，只是少了目标信息，不该因此不优化。 */
    LLVMTargetMachineRef tm = NULL;
    char *triple = LLVMGetDefaultTargetTriple();
    char *terr = NULL;
    LLVMTargetRef tgt = NULL;
    if (triple != NULL && LLVMGetTargetFromTriple(triple, &tgt, &terr) == 0 && tgt != NULL) {
      char *cpu = LLVMGetHostCPUName();
      char *feat = LLVMGetHostCPUFeatures();
      tm = LLVMCreateTargetMachine(tgt, triple, cpu == NULL ? "" : cpu,
                                   feat == NULL ? "" : feat,
                                   LLVMCodeGenLevelAggressive, LLVMRelocDefault,
                                   LLVMCodeModelJITDefault);
      if (cpu != NULL) LLVMDisposeMessage(cpu);
      if (feat != NULL) LLVMDisposeMessage(feat);
    }
    if (terr != NULL) LLVMDisposeMessage(terr);
    LLVMPassBuilderOptionsRef pbo = LLVMCreatePassBuilderOptions();
    for (int mi = 0; mi < nmods; mi++) {
      LLVMErrorRef perr = LLVMRunPasses(mods[mi], pipe, tm, pbo);
      if (perr != NULL) return omni_jit_fail(perr, "cannot run the opt pipeline");
    }
    LLVMDisposePassBuilderOptions(pbo);
    if (tm != NULL) LLVMDisposeTargetMachine(tm);
    if (triple != NULL) LLVMDisposeMessage(triple);
    if (getenv("OMNI_JIT_TRACE") != NULL) {
      fprintf(stderr, "omni-jit: opt %s on %d module(s)\n", pipe, nmods);
    }
  }

  LLVMOrcJITDylibRef jd = LLVMOrcLLJITGetMainJITDylib(jit);
  /* 进程符号搜索**故意不装**（从前那句 LLVMOrcCreateDynamicLibrarySearchGeneratorForProcess
     在这儿）：JIT 出来的代码只能看见宿主明确摆上的那些名字。理由三条在
     omni_jit_symbols.h 的文件头，可观测的形式是宿主链接时不再要 `-Wl,-export_dynamic`。 */
  int rc = omni_jit_define(jit, jd, mods, nmods, dl);
  if (rc != 0) return rc;

  /* 每个入口的**形状**从 IR 上读，不另发明一套签名语法（J3）。这一层只会调三种：
       0 格参数、回 void -> `void(void)`（omni 的 `omni_main` 那类、kernel）
       0 格参数、回 i32  -> `int(void)`（C 的 `int main(void)` —— 退出码是它的返回值）
       2 格参数         -> `int(int, char**)`（与 AOT 同一个 main）
     回值也要看，不能只数参数：C 那条腿的 `int main(void)` 正是「0 格参数但有退出码」，
     只数参数会把它当 `void(void)` 调，于是**退出码一律是 0** —— 量出来是
     `tests/c/sys/*` 五份的 stdout 都对而退出码全成了 0。
     形状读完才能把 mod 交给 ThreadSafeModule —— 交出去之后这份 mod 就不属于我们了。
     入口可以在**这一批里任何一份** IR 上（`--add`）：会话里第 k 批的入口就在第 k 份里。 */
  int kind[OMNI_JIT_MAX_CALLS];
  for (int k = 0; k < ncalls; k++) {
    LLVMValueRef f = NULL;
    for (int mi = 0; mi < nmods && f == NULL; mi++) {
      LLVMValueRef c = LLVMGetNamedFunction(mods[mi], calls[k]);
      if (c != NULL && LLVMIsDeclaration(c) == 0) f = c;
    }
    if (f == NULL) {
      fprintf(stderr, "omni-jit: 这几份 IR 里没有 %s 的函数体\n", calls[k]);
      return 70;
    }
    unsigned np = LLVMCountParams(f);
    /* 函数的类型要走 `LLVMGlobalGetValueType`：不透明指针之后 `LLVMTypeOf(f)` 就是
       一个 `ptr`，对它 `LLVMGetElementType` 拿到的是垃圾（量出来是当场 segfault）。 */
    LLVMTypeRef rt = LLVMGetReturnType(LLVMGlobalGetValueType(f));
    int i32ret = LLVMGetTypeKind(rt) == LLVMIntegerTypeKind && LLVMGetIntTypeWidth(rt) == 32;
    if (np == 0) kind[k] = i32ret ? 2 : 0;
    else if (np == 2) kind[k] = 1;
    else {
      fprintf(stderr, "omni-jit: %s 收 %u 格参数 —— 这一层只调 `void(void)`、`int(void)` "
              "与 `int(int,char**)` 三种形状（要别的形状是 J4 那格 FFI 的事）\n", calls[k], np);
      return 70;
    }
  }

  /* **对象码缓存**（J7，见 `omni_objcache_write` 上面那段）：缓存里有就直接摆一份对象码
     进去，一次代码生成都不做；没有就照旧交 IR，顺手在 ObjTransformLayer 上把生成出来的
     对象码落盘。入口的**形状**已经从 IR 上读完了（上面那一段），所以这两条路下游完全一样。 */
  int objhit = 0;
  if (omni_objcache[0] != '\0') {
    LLVMMemoryBufferRef ob = NULL;
    char *omsg = NULL;
    if (LLVMCreateMemoryBufferWithContentsOfFile(omni_objcache, &ob, &omsg) == 0) {
      /* 走这条路 IR 就不要了 —— 两份都摆进去等于重复定义。 */
      LLVMDisposeModule(mod);
      err = LLVMOrcLLJITAddObjectFile(jit, jd, ob);
      if (err != NULL) return omni_jit_fail(err, "cannot add cached object");
      objhit = 1;
    } else if (omsg != NULL) {
      LLVMDisposeMessage(omsg);   /* 缓存不在（第一次跑）不是错 */
    }
  }
  if (objhit == 0) {
    if (omni_objcache[0] != '\0') {
      LLVMOrcObjectTransformLayerSetTransform(LLVMOrcLLJITGetObjTransformLayer(jit),
                                              omni_objcache_write, NULL);
    }
    /* 一份一份摆进**同一个** JITDylib（`--add`，J6）：跨模块的引用由 ORC 自己接 ——
       第二份里的 `@g_base`/`@s_f1` 找的就是第一份摆进去的那两个符号。 */
    for (int mi = 0; mi < nmods; mi++) {
      LLVMOrcThreadSafeContextRef tsc = LLVMOrcCreateNewThreadSafeContext();
      LLVMOrcThreadSafeModuleRef tsm = LLVMOrcCreateNewThreadSafeModule(mods[mi], tsc);
      err = LLVMOrcLLJITAddLLVMIRModule(jit, jd, tsm);
      if (err != NULL) return omni_jit_fail(err, "cannot add module");
    }
  }
  if (omni_objcache[0] != '\0' && getenv("OMNI_JIT_TRACE") != NULL) {
    fprintf(stderr, "omni-jit: objcache %s %s\n", objhit != 0 ? "hit" : "miss", omni_objcache);
  }
  /* 查地址那一句才是真正触发编译的地方（ORC 是惰性物化的）—— 「JIT 延迟」量的就是它。
     多个入口按命令行上的顺序来；`--repeat` 是给"同一个入口反复调"用的（kernel dispatch
     与将来的 REPL 都要它），退出码取最后一个 main 形状那次的返回值。 */
  int code = 0;
  /* 这儿量的是**宿主的调用点**在哪个线程上（一直是主线程）。真正会把活挪走的是
     入口那一层的 `omni_run_entry`（omni_js_host.c）—— 它宁可留在主线程也不开线程，
     条件是主线程的栈已经够大（链接时的 `-Wl,-stack_size`）。头一版我把这句诊断放在
     这里就以为量到了答案，其实差了一层：那次是 `omni_run_entry` 开的线程在崩。 */
  if (getenv("OMNI_JIT_TRACE") != NULL) {
    fprintf(stderr, "omni-jit: main thread = %d\n", omni_jit_main_thread());
  }

  for (int k = 0; k < ncalls; k++) {
    LLVMOrcJITTargetAddress addr = 0;
    err = LLVMOrcLLJITLookup(jit, &addr, calls[k]);
    if (err != NULL) return omni_jit_fail(err, "cannot materialize");
    for (long r = 0; r < repeat; r++) {
      if (kind[k] == 1) code = ((int (*)(int, char **))addr)(eargc, eargv);
      else if (kind[k] == 2) code = ((int (*)(void))addr)();
      else ((void (*)(void))addr)();
    }
  }

  /* 故意不 DisposeLLJIT：被 JIT 的代码可能还持有运行时里的东西，而这个进程马上就退。
     卸载要等到「同一进程内解释与 JIT 混合执行」那一步，那时才有真正的生命周期问题。 */
  return code;
}
