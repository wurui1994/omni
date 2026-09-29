/* ext/python/rt/abi-shim.c —— **Cython 出的扩展要的那几个"上一版还在"的名字**
 *
 * 我们借的是参考树那一支（现在 3.16.0a0），而 Cython 生成的 C 是按它见过的某个小版本
 * 发的（本机那份 Cython 3.2.4 发的代码里就有 3.14 还在、3.15 起没了的名字）。每个小版本
 * CPython 都会清掉几个不在稳定 API 里的内部符号 —— 于是"编得过、链的时候缺一格"。
 * 这一份就是那一格：把老名字补上，语义照旧。
 *
 * **一条量出来的边界，别越过去**：这不是"老 wheel 可以直接拿来用"。现成的
 * `cpython-314` 的 `.so` 补上符号之后 dlopen **过得去，可跑起来是 segfault**
 * （2026-09-29 量的：lxml 的 `etree.cpython-314-darwin.so` 在我们这份 3.16 运行时上
 * 崩在解析第一个文档之前）—— 跨小版本的**结构布局**本来就不保证，补符号补不了那个。
 * 第三方扩展要进来只有一条路：**源码过我们这条链编一遍**（Cython 本机就有）。
 *
 * 怎么发现下一格：`ImportError: symbol not found in flat namespace '…'`。
 * 那句话里的名字去掉前导下划线（Mach-O 的 `_`）就是要补的 C 名。
 */

/* `_PyByteArray_empty_string`：3.14 及以前在 `Objects/bytearrayobject.c` 里是
 * `char _PyByteArray_empty_string[] = "";`，3.15 起没有了（bytearray 的空串改走
 * `PyByteArray_FromStringAndSize(NULL, 0)`）。
 * 谁在引用：Cython 生成的代码（`__Pyx_PyByteArray_*` 那一族里对空 bytearray 的快路）
 * —— 量出来的原话是 lxml 的 `etree.cpython-314-darwin.so` dlopen 时缺它。 */
char _PyByteArray_empty_string[] = "";
