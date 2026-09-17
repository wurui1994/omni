/* `<execinfo.h>` —— arm64-osx 的那一份（交叉编译用）。 */
#ifndef _EXECINFO_H
#define _EXECINFO_H

int backtrace(void **buf, int size);
char **backtrace_symbols(void *const *buf, int size);

#endif
