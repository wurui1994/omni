/* `<setjmp.h>` —— win32 的那一份（两个 arch 共用）（交叉编译用；形状沿用 Linux 那一套，见 ../README.md）。
 *
 * jmp_buf：量到 sizeof=200（glibc 的 `__jmp_buf_tag`：8 个 long + sigset_t(128)）。
 * 运行时只用 `setjmp` 与 `longjmp`。 */
#ifndef _SETJMP_H
#define _SETJMP_H

struct __jmp_buf_tag {
  long int __jmpbuf[8];
  int __mask_was_saved;
  unsigned long int __saved_mask[16]; /* sigset_t = 128 bytes */
};
typedef struct __jmp_buf_tag jmp_buf[1];
typedef struct __jmp_buf_tag sigjmp_buf[1];

int setjmp(jmp_buf env);
void longjmp(jmp_buf env, int val);
/* `savemask` 非零时**真的存**掩码：旗子在偏移 168、掩码在 176（后端那条 `SETJMP`
 * 只用头 64，所以那两格是空的 —— 见 `libc/misc.c` 里 `sigsetjmp` 那一段）。 */
int sigsetjmp(sigjmp_buf env, int savemask);
void siglongjmp(sigjmp_buf env, int val);

#define _setjmp setjmp
#define _longjmp longjmp

#endif
