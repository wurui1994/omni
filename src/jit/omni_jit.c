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

#include "omni_jit_symbols.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* LLVMInitializeNativeTarget 一族是 Target.h 里的 static inline，展开成
   当前架构那几个真符号。这里照 LLVM 自己的宏来，别的架构加一条 #elif 就行。 */
static void omni_jit_init_target(void) {
  LLVMInitializeNativeTarget();
  LLVMInitializeNativeAsmPrinter();
}

static int omni_jit_fail(LLVMErrorRef e, const char *what) {
  char *m = LLVMGetErrorMessage(e);
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
 */
static int omni_jit_define(LLVMOrcLLJITRef jit, LLVMOrcJITDylibRef jd, LLVMModuleRef mod) {
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
    LLVMValueRef f = LLVMGetNamedFunction(mod, nm);
    if (f != NULL && LLVMIsDeclaration(f) == 0) continue;
    LLVMValueRef g = LLVMGetNamedGlobal(mod, nm);
    if (g != NULL && LLVMIsDeclaration(g) == 0) continue;
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

  char buf[256];
  int missing = 0;
  for (LLVMValueRef f = LLVMGetFirstFunction(mod); f != NULL; f = LLVMGetNextFunction(f)) {
    if (LLVMIsDeclaration(f) == 0) continue;
    if (LLVMGetIntrinsicID(f) != 0) continue;   /* llvm.* 由 LLVM 自己降 */
    const char *nm = omni_jit_name(f, buf, sizeof buf);
    if (nm == NULL || omni_jit_symbol(nm) != NULL) continue;
    fprintf(stderr, "omni-jit: unresolved: %s\n", nm);
    missing++;
  }
  for (LLVMValueRef g = LLVMGetFirstGlobal(mod); g != NULL; g = LLVMGetNextGlobal(g)) {
    if (LLVMIsDeclaration(g) == 0) continue;
    const char *nm = omni_jit_name(g, buf, sizeof buf);
    if (nm == NULL || omni_jit_symbol(nm) != NULL) continue;
    fprintf(stderr, "omni-jit: unresolved: %s\n", nm);
    missing++;
  }
  if (missing > 0) {
    fprintf(stderr, "omni-jit: %d 个符号宿主表里没有（要么补进 src/jit/omni_jit_symbols.c，"
            "要么是后端发错了名字）\n", missing);
    return 70;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: omni-jit FILE.ll [SYMBOL] [-- ARG...]\n");
    return 64;
  }
  const char *path = argv[1];
  int i = 2;
  const char *sym = "main";
  if (i < argc && strcmp(argv[i], "--") != 0) sym = argv[i++];

  /* 被调那个 main 看到的 argv：第 0 格照旧是 `.ll` 的路径（没有 `--` 时的老行为就是
     `argv+1`，一个字节都不变），`--` 之后的原样接在后面。argv 本身可写，所以把 `--`
     那一格改写成路径就够了 —— 不用另分配一个数组。 */
  char **eargv = argv + 1;
  int eargc = argc - 1;
  if (i < argc && strcmp(argv[i], "--") == 0) {
    argv[i] = (char *)path;
    eargv = argv + i;
    eargc = argc - i;
  }

  size_t len = 0;
  char *text = omni_jit_slurp(path, &len);
  if (text == NULL) {
    fprintf(stderr, "omni-jit: cannot read %s\n", path);
    return 66;
  }

  omni_jit_init_target();

  LLVMOrcLLJITRef jit = NULL;
  LLVMErrorRef err = LLVMOrcCreateLLJIT(&jit, NULL);
  if (err != NULL) return omni_jit_fail(err, "cannot create LLJIT");

  /* 文本 -> Module。MemoryBuffer 接管 text 的所有权（不复制），所以不能提前 free。 */
  LLVMContextRef ctx = LLVMContextCreate();
  LLVMMemoryBufferRef mb = LLVMCreateMemoryBufferWithMemoryRange(text, len, path, 0);
  LLVMModuleRef mod = NULL;
  char *msg = NULL;
  if (LLVMParseIRInContext(ctx, mb, &mod, &msg) != 0) {
    fprintf(stderr, "omni-jit: %s is not valid IR: %s\n", path, msg == NULL ? "?" : msg);
    LLVMDisposeMessage(msg);
    return 65;
  }

  LLVMOrcJITDylibRef jd = LLVMOrcLLJITGetMainJITDylib(jit);
  /* 进程符号搜索**故意不装**（从前那句 LLVMOrcCreateDynamicLibrarySearchGeneratorForProcess
     在这儿）：JIT 出来的代码只能看见宿主明确摆上的那些名字。理由三条在
     omni_jit_symbols.h 的文件头，可观测的形式是宿主链接时不再要 `-Wl,-export_dynamic`。 */
  int rc = omni_jit_define(jit, jd, mod);
  if (rc != 0) return rc;

  LLVMOrcThreadSafeContextRef tsc = LLVMOrcCreateNewThreadSafeContext();
  LLVMOrcThreadSafeModuleRef tsm = LLVMOrcCreateNewThreadSafeModule(mod, tsc);
  err = LLVMOrcLLJITAddLLVMIRModule(jit, jd, tsm);
  if (err != NULL) return omni_jit_fail(err, "cannot add module");

  /* 这一句才是真正触发编译的地方（ORC 是惰性物化的）—— 所以「JIT 延迟」量的就是它 */
  LLVMOrcJITTargetAddress addr = 0;
  err = LLVMOrcLLJITLookup(jit, &addr, sym);
  if (err != NULL) return omni_jit_fail(err, "cannot materialize");

  int code = ((int (*)(int, char **))addr)(eargc, eargv);

  /* 故意不 DisposeLLJIT：被 JIT 的代码可能还持有运行时里的东西，而这个进程马上就退。
     卸载要等到「同一进程内解释与 JIT 混合执行」那一步，那时才有真正的生命周期问题。 */
  return code;
}
