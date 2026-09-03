/* int 与 real 之间的转换。回绕算术本身在 omni.h 里（static inline，热路径）。 */
#include "omni.h"

int64_t omni_trunc(double v) {
  if (!isfinite(v)) omni_error("cannot convert non-finite real to int");
  double t = trunc(v);
  /* 超范围的 (int64_t) 转换在 C 里是 UB（arm64 饱和，x86 给 INT64_MIN），所以先自己挡住。
     这里刻意不回绕：算术回绕是 i64 的约定（ADR-0005），但 int(1e20) 回绕出来的数
     不表示任何东西，静默给个垃圾值比报错糟。 */
  if (t < -9223372036854775808.0 || t >= 9223372036854775808.0) {
    omni_errorf("real %.6g is out of int range", v);
  }
  return (int64_t)t;
}
