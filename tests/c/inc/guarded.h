#ifndef GUARDED_H
#define GUARDED_H
/* 整份被守卫包着，而且 #endif 恰好在文件末尾 —— tcc 会把 GUARDED_H 记成这份文件的
   include 守卫，第二次引到它连文件都不打开（`tccpp.c:1392`）。 */
#define GUARD_VALUE 3
int guarded_decl;
#endif
