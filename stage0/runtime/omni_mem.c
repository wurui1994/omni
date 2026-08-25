/* 分配：失败即致命错误，调用方因此永远不需要检查返回值。
   目前只分配不释放（ARC 是欠账，见 ADR-0007）。 */
#include "omni.h"

void *omni_alloc(size_t n) {
  void *p = malloc(n);
  if (!p) omni_error("out of memory");
  return p;
}

void *omni_realloc(void *p, size_t n) {
  void *q = realloc(p, n);
  if (!q) omni_error("out of memory");
  return q;
}

/* class 引用的显式空检查：C 侧不能让它变成段错误，否则和 JS 后端的诊断分叉 */
void *omni_nullck(void *p) {
  if (!p) omni_error("null reference");
  return p;
}
