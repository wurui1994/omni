/* `<setjmp.h>` —— arm64-osx 的那一份（交叉编译用）。
 * 量到 sizeof(jmp_buf)=192（Linux 上 200）。 */
#ifndef _SETJMP_H
#define _SETJMP_H

typedef int jmp_buf[48];   /* 48 * 4 = 192 */

int setjmp(jmp_buf env);
void longjmp(jmp_buf env, int val);

#define _setjmp setjmp
#define _longjmp longjmp

#endif
