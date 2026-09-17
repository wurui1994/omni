/* `<dlfcn.h>` —— arm64-osx 的那一份（交叉编译用）。
 * 量到的：`RTLD_NOW` 2、`RTLD_LOCAL` **4**、`RTLD_GLOBAL` **8**
 * （Linux 上 LOCAL 是 0、GLOBAL 是 0x100）。 */
#ifndef _DLFCN_H
#define _DLFCN_H

#define RTLD_LAZY 1
#define RTLD_NOW 2
#define RTLD_LOCAL 4
#define RTLD_GLOBAL 8

void *dlopen(const char *path, int mode);
void *dlsym(void *handle, const char *name);
int dlclose(void *handle);
char *dlerror(void);

#endif
