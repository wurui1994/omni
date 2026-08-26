/**
 * 外部 C 符号的封闭表（ADR-0014 决策 4）—— 唯一的真源。
 *
 * 和 `JS_ABI` 是同一条纪律：能调什么由这张表说了算，表里没有的就不许调。区别只在
 * 另一端是谁 —— `JS_ABI` 的另一端是我们自己写的运行时，这张表的另一端是**别人的**
 * 共享库。所以它是 ADR-0013 那份 C-FFI 契约的第一个外部使用者：在此之前，
 * 「值就是 C 的值、调用就是 C 的调用」只被我们自己的运行时用过。
 *
 * 类型词汇刻意只有七个，且都是标量：
 *   i32 / i64  有符号整数（JS 域的数是 double，marshal 时按 JS 的取整口径转）
 *   f64        双精度
 *   bool       C 的 _Bool
 *   cstr       `const char *`，NUL 结尾。JS 侧给的是 UTF-16 字符串，marshal 时转 UTF-8
 *   ptr        不透明句柄。在 dynamic 里以 int 标签承载地址 —— 不是 double，
 *              免掉 2^53 以上的精度问题；JS 侧看到的是一个 bigint，除了传回来别无用途
 *   void       只能作返回类型
 * 聚合（结构体按值、数组、回调）**一律不支持**。要它们的时候再开一条 ADR，
 * 因为那牵扯到 ABI 的实参分类 —— jancy 为此手写了十六个调用约定类，那是我们要避开的坑。
 *
 * `lib: null` 表示 libc，不需要额外的 `-l`。
 * `std: true` 表示「声明已经由 omni.h 里 include 的标准头给出」—— 这种**不发 extern 原型**：
 * libc 的真实原型用的是 `size_t`/`int` 这些，我们表里写的是 `i64`/`i32`，
 * 重复声明成不同类型在 C 里是硬错误（不是警告）。调用处的隐式转换是合法的，所以只要
 * 别自己再声明一遍就行。第三方库（LLVM-C 之类）没有这个问题，照发。
 */

/** @type {Record<string, {sym: string, lib: string | null, params: string[], ret: string, std?: boolean}>} */
export const C_ABI = {
  // libc —— 这几条的用途是把机制本身钉住：可移植、无副作用、结果可断言
  c_abs: { sym: 'abs', lib: null, std: true, params: ['i32'], ret: 'i32' },
  c_strlen: { sym: 'strlen', lib: null, std: true, params: ['cstr'], ret: 'i64' },
  c_malloc: { sym: 'malloc', lib: null, std: true, params: ['i64'], ret: 'ptr' },
  c_free: { sym: 'free', lib: null, std: true, params: ['ptr'], ret: 'void' },
  c_memset: { sym: 'memset', lib: null, std: true, params: ['ptr', 'i32', 'i64'], ret: 'ptr' },
  c_memcmp: { sym: 'memcmp', lib: null, std: true, params: ['ptr', 'ptr', 'i64'], ret: 'i32' },
  c_getenv: { sym: 'getenv', lib: null, std: true, params: ['cstr'], ret: 'cstr' },
  /* 唯一一条**要发 extern 原型**的：POSIX 的 getpid 在 <unistd.h> 里，而生成的翻译单元
     只 include omni.h（unistd.h 只被 runtime/omni_js_host.c 用），所以它看不到那份原型。
     留着它是为了把 cAbiExterns() 那条路钉住 —— 第三方库（LLVM-C 之类）走的全是这条，
     而 libc 那几条因为 std:true 一条都不发，光靠它们这段代码永远不会被执行到。
     顺带也覆盖了零形参（原型里要写 `void`）。pid_t 在 macOS 与 Linux 上都是 int。 */
  c_getpid: { sym: 'getpid', lib: null, params: [], ret: 'i32' },
};

/** C 的类型拼写。extern 原型与调用处的强制转换都用它。 */
export const C_TYPE = {
  i32: 'int32_t',
  i64: 'int64_t',
  f64: 'double',
  bool: 'bool',
  cstr: 'const char *',
  ptr: 'void *',
  void: 'void',
};

/** dynamic -> C：每个类型一个 marshal 函数，实现在 runtime/omni_cabi.h */
export const C_IN = {
  i32: 'omni_cabi_i32',
  i64: 'omni_cabi_i64',
  f64: 'omni_cabi_f64',
  bool: 'omni_cabi_bool',
  cstr: 'omni_cabi_cstr',
  ptr: 'omni_cabi_ptr',
};

/** C -> dynamic。void 不在表里：调用点单独处理，发完调用返回 undefined。 */
export const C_OUT = {
  i32: 'omni_cabi_of_i32',
  i64: 'omni_cabi_of_i64',
  f64: 'omni_cabi_of_f64',
  bool: 'omni_cabi_of_bool',
  cstr: 'omni_cabi_of_cstr',
  ptr: 'omni_cabi_of_ptr',
};

/** 这张表用到的所有库（去重、有序），给链接命令用 */
export function cAbiLibs(names) {
  const out = [];
  for (const n of names) {
    const e = C_ABI[n];
    if (e && e.lib && !out.includes(e.lib)) out.push(e.lib);
  }
  return out;
}
