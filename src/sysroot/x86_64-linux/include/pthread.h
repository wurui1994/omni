/* `<pthread.h>` —— x86_64-linux 的那一份（交叉编译用）。
 *
 * 量到 sizeof(pthread_t)=8、sizeof(pthread_attr_t)=56。运行时只用「起一个大栈的
 * 线程去跑入口」那一族（`omni_js_host.c` 的 `omni_run_entry`）。
 *
 * `pthread_main_np` / `pthread_get_stacksize_np` 是 **Apple 专有**的，不在这儿 ——
 * 运行时那侧用 `#ifdef __APPLE__` 岔开，Linux 走 `getrlimit(RLIMIT_STACK)`。 */
#ifndef _PTHREAD_H
#define _PTHREAD_H

#include <stddef.h>

typedef unsigned long int pthread_t;
typedef union { char __size[56]; long int __align; } pthread_attr_t;

int pthread_attr_init(pthread_attr_t *attr);
int pthread_attr_destroy(pthread_attr_t *attr);
int pthread_attr_setstacksize(pthread_attr_t *attr, size_t size);
int pthread_create(pthread_t *th, const pthread_attr_t *attr,
                   void *(*fn)(void *), void *arg);
int pthread_join(pthread_t th, void **ret);
pthread_t pthread_self(void);

#endif
