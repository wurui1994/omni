/*
 * Omni — JIT 的宿主符号表（ADR-0022 决策 2）
 *
 * JIT 出来的代码能看见的东西**只有这张表里的**。从前是靠 ORC 的进程符号搜索
 * （`LLVMOrcCreateDynamicLibrarySearchGeneratorForProcess`）—— 那条路有三个毛病：
 *
 *   1. 宿主没有任何办法说"这个名字请指到我这一格函数上"，于是 FFI 没有落点；
 *   2. 能不能跑取决于"宿主二进制里恰好链进了什么"，换台机器就可能变；
 *   3. 漏一个符号时报的是 LLVM 的原话（`Symbols not found: [ _foo ]`），
 *      而它是在**物化的时候**才报的 —— 程序可能已经打了半屏输出。
 *
 * 一张显式的表把这三样一起解决：定义在装载之前一次做完，漏了的当场按名字列出来。
 * 与 jancy 的 `Jit::addStdSymbols`（jnc_ct_Jit.cpp:98-112）同一个位置，
 * 只是它那张表是"运行时 + 编译器 rt 助手"，我们这张是"运行时 + libc 的那几个"。
 */

#ifndef OMNI_JIT_SYMBOLS_H
#define OMNI_JIT_SYMBOLS_H

typedef struct {
  const char *name;   /* IR 里那个**没有平台前缀**的名字（mangle 由 ORC 那边做） */
  void *addr;
} omni_jit_sym;

/** 以 `{ NULL, NULL }` 结尾。 */
extern const omni_jit_sym OMNI_JIT_SYMS[];

/** 表里有这个名字吗（有就给地址，没有给 NULL）。 */
void *omni_jit_symbol(const char *name);

#endif
