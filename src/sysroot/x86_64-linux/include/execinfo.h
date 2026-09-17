/* `<execinfo.h>` —— x86_64-linux 的那一份（交叉编译用）。
 * glibc 与 macOS 上签名一样，只有 `OMNI_MEM_DEBUG=4` 那条路会用到。 */
#ifndef _EXECINFO_H
#define _EXECINFO_H

int backtrace(void **buf, int size);
char **backtrace_symbols(void *const *buf, int size);

#endif
