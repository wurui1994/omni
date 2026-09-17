/* `<dlfcn.h>` —— x86_64-linux 的那一份（交叉编译用）。
 *
 * `RTLD_*` 的值照 glibc 的 `bits/dlfcn.h`：`RTLD_LAZY` 1、`RTLD_NOW` 2、
 * `RTLD_GLOBAL` 0x100、`RTLD_LOCAL` 0 —— macOS 那边 `RTLD_LOCAL` 是 4，
 * 又是一格「按目标走」的差别。 */
#ifndef _DLFCN_H
#define _DLFCN_H

#define RTLD_LAZY 1
#define RTLD_NOW 2
#define RTLD_GLOBAL 0x100
#define RTLD_LOCAL 0

void *dlopen(const char *path, int mode);
void *dlsym(void *handle, const char *name);
int dlclose(void *handle);
char *dlerror(void);

#endif
