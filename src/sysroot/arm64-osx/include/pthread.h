/* `<pthread.h>` —— arm64-osx 的那一份（交叉编译用）。
 *
 * 量到 sizeof(pthread_attr_t)=**64**（Linux 上 56）。
 * `pthread_main_np` 与 `pthread_get_stacksize_np` 是 **Apple 专有**的 ——
 * 运行时那侧用 `#ifdef __APPLE__` 走这两个，Linux 走 `getrlimit(RLIMIT_STACK)`。 */
#ifndef _PTHREAD_H
#define _PTHREAD_H

#include <stddef.h>

struct _opaque_pthread_t;
typedef struct _opaque_pthread_t *pthread_t;
typedef struct { long __sig; char __opaque[56]; } pthread_attr_t;  /* 64 bytes */

int pthread_attr_init(pthread_attr_t *attr);
int pthread_attr_destroy(pthread_attr_t *attr);
int pthread_attr_setstacksize(pthread_attr_t *attr, size_t size);
int pthread_create(pthread_t *th, const pthread_attr_t *attr,
                   void *(*fn)(void *), void *arg);
int pthread_join(pthread_t th, void **ret);
pthread_t pthread_self(void);

/* Apple 专有的那两格 */
int pthread_main_np(void);
size_t pthread_get_stacksize_np(pthread_t th);

#endif
