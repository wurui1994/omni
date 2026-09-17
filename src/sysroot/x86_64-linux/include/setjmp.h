/* `<setjmp.h>` —— x86_64-linux 的那一份（交叉编译用）。
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

int setjmp(jmp_buf env);
void longjmp(jmp_buf env, int val);

#define _setjmp setjmp
#define _longjmp longjmp

#endif
