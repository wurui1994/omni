/* atexit.c — glibc 的 libc_nonshared.a 里那份 atexit 的替代。
 *
 * glibc 的 `atexit` 只住在 `libc_nonshared.a` 里（`libc.so.6` 不导出它），
 * 展开成 `__cxa_atexit(f, 0, &__dso_handle)`。`__cxa_atexit` 在 `.so.6` 里。
 *
 * 这一份的意义是**交叉编译时不需要拷一份 glibc 的 `.a`** —— 用我们自己的 C 前端
 * 编成 `.o` 放进 sysroot/lib，与 tcc 的 `lib/dsohandle.c` 同一个思路。
 */
extern int __cxa_atexit(void (*fn)(void *), void *arg, void *dso);
extern void *__dso_handle;
int atexit(void (*fn)(void)) {
  return __cxa_atexit((void (*)(void *))fn, (void *)0, &__dso_handle);
}
