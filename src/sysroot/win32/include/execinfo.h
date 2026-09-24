/* `<execinfo.h>` —— win32 的那一份（两个 arch 共用）（交叉编译用；形状沿用 Linux 那一套，见 ../README.md）。
 * glibc 与 macOS 上签名一样，只有 `OMNI_MEM_DEBUG=4` 那条路会用到。 */
#ifndef _EXECINFO_H
#define _EXECINFO_H

int backtrace(void **buf, int size);
char **backtrace_symbols(void *const *buf, int size);

#endif
