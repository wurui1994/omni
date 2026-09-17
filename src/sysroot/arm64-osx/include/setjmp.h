/* `<setjmp.h>` —— arm64-osx 的那一份（交叉编译用）。
 * 量到 sizeof(jmp_buf)=192（Linux 上 200）。 */
#ifndef _SETJMP_H
#define _SETJMP_H

typedef int jmp_buf[48];   /* 48 * 4 = 192 */
typedef int sigjmp_buf[48];

int setjmp(jmp_buf env);
void longjmp(jmp_buf env, int val);
/* `savemask` 非零时**真的存**掩码：旗子在偏移 168、掩码在 176（后端那条 `SETJMP`
 * 用头 168，所以 168..183 那两格是空的 —— 见 `libc/misc.c` 里 `sigsetjmp` 那一段）。 */
int sigsetjmp(sigjmp_buf env, int savemask);
void siglongjmp(sigjmp_buf env, int val);

#define _setjmp setjmp
#define _longjmp longjmp

#endif
