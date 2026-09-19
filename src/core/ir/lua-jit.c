/*
 * src/core/ir/lua-jit.c —— **IR 那条路的 JIT 宿主**（ORC LLJIT）
 *
 * 与 `src/jit/omni_jit.c` 的关系：那一份是 omni 主语言的 JIT，它要把整份 omni 运行时
 * （几百个符号）按名字摆进 JIT。这一份**什么都不用摆** —— IR 那条路的 `.ll` 是
 * `llvm-link` 合成过的自包含模块（程序 + lua 运行时在同一个模块里），所以除了 libc
 * 没有外部依赖。
 *
 * 这就是"运行时也过 IR"那个选择的回报：AOT 与 JIT 读的是**同一份 .ll**，
 * 一个字节都不差。差别只有"交给 clang 还是交给 LLJIT"。
 *
 *   lua-jit FILE.ll [SYMBOL]     默认 SYMBOL 是 main
 *
 * 判据：同一份 .ll，AOT 跑出来的输出与 JIT 跑出来的逐字节相同。
 */

#include <llvm-c/Core.h>
#include <llvm-c/Error.h>
#include <llvm-c/IRReader.h>
#include <llvm-c/LLJIT.h>
#include <llvm-c/Orc.h>
#include <llvm-c/Target.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fail(const char *what, LLVMErrorRef err) {
    char *msg = LLVMGetErrorMessage(err);
    fprintf(stderr, "lua-jit: %s: %s\n", what, msg);
    LLVMDisposeErrorMessage(msg);
    return 1;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: lua-jit FILE.ll [SYMBOL]\n");
        return 2;
    }
    const char *path = argv[1];
    const char *sym = argc > 2 ? argv[2] : "main";

    LLVMInitializeNativeTarget();
    LLVMInitializeNativeAsmPrinter();

    /* 读 .ll —— 与 AOT 那条路同一份文本 */
    LLVMMemoryBufferRef buf = NULL;
    char *err = NULL;
    if (LLVMCreateMemoryBufferWithContentsOfFile(path, &buf, &err) != 0) {
        fprintf(stderr, "lua-jit: cannot read %s: %s\n", path, err ? err : "?");
        return 1;
    }
    LLVMContextRef ctx = LLVMContextCreate();
    LLVMModuleRef mod = NULL;
    if (LLVMParseIRInContext(ctx, buf, &mod, &err) != 0) {
        fprintf(stderr, "lua-jit: cannot parse %s: %s\n", path, err ? err : "?");
        return 1;
    }

    /* LLJIT：一格现成的 ORC 配置（懒编译 + 本机目标） */
    LLVMOrcLLJITRef jit = NULL;
    LLVMErrorRef e = LLVMOrcCreateLLJIT(&jit, NULL);
    if (e) return fail("cannot create LLJIT", e);

    LLVMOrcThreadSafeContextRef tsc = LLVMOrcCreateNewThreadSafeContext();
    LLVMOrcThreadSafeModuleRef tsm = LLVMOrcCreateNewThreadSafeModule(mod, tsc);
    LLVMOrcJITDylibRef main_jd = LLVMOrcLLJITGetMainJITDylib(jit);

    /* libc 那一族（printf / malloc / floor …）从**本进程**的动态符号表来。
       这一格是这份宿主与 omni_jit.c 最大的差别：那儿刻意关掉了进程符号表
       （要验"解析路径只有那张表"），这儿反过来 —— 自包含模块只缺 libc。 */
    LLVMOrcDefinitionGeneratorRef dg = NULL;
    char prefix = LLVMOrcLLJITGetGlobalPrefix(jit);
    e = LLVMOrcCreateDynamicLibrarySearchGeneratorForProcess(&dg, prefix, NULL, NULL);
    if (e) return fail("cannot make process symbol generator", e);
    LLVMOrcJITDylibAddGenerator(main_jd, dg);

    e = LLVMOrcLLJITAddLLVMIRModule(jit, main_jd, tsm);
    if (e) return fail("cannot add module", e);

    LLVMOrcJITTargetAddress addr = 0;
    e = LLVMOrcLLJITLookup(jit, &addr, sym);
    if (e) return fail("symbol not found", e);

    int (*fn)(void) = (int (*)(void))addr;
    int rc = fn();

    fflush(stdout);
    LLVMOrcDisposeLLJIT(jit);
    return rc;
}
