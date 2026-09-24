/* int 与 real 之间的转换。回绕算术本身在 omni.h 里（static inline，热路径）。
   `omni_trunc` 在别处是个宏（快路内联在调用点，见 omni.h），这个 TU 要定义真符号，
   所以 include 之前先把那个宏关掉。 */
#define OMNI_INT_IMPL_TU
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

/* 宏那条快路（|v| < 2^53）之外的那一段：判断与上面这一份是同一份，所以答案与报的话
   都与从前逐字相同。单独一格是为了让调用点上只留一次比较 + 一次冷调用。 */
int64_t omni_trunc_oob(double v) { return omni_trunc(v); }

/* 把一格整数截到 n 位（ADR-0031 §8.2）。先前这两件事是前端拿三个算子拼出来的
   （`(bin "-" (bin "^" (bin "&" v M) S) S)` 就是"截到 8 位有符号"）—— 拼出来的东西读的人
   看不出意图，后端也挑不了更好的落法。现在方言里各是一格算子。

   **n >= 64 是恒等**：方言的 int 就是 64 位有符号那一格，无符号的读法由算子承担
   （u/ u% u>> 与四个无符号比较），所以这儿绝不能答一个装不进 int64_t 的数。
   n 在方言那一层查过（1..64 的字面量），这儿不再判。

   写法刻意是"掩 + 摊符号位"而不是 `(int8_t)` 那种强制转换：n 是任意位宽（1..64），
   而且这一串与前端先前发的那一串**逐位相同** —— 换过来时六条腿的输出一个字节都不该变。 */
int64_t omni_int_trunc(int64_t v, int64_t n) {
  if (n >= 64) return v;
  uint64_t m = (uint64_t)1 << (uint64_t)n;
  return (int64_t)((uint64_t)v & (m - 1));
}

int64_t omni_int_sext(int64_t v, int64_t n) {
  if (n >= 64) return v;
  uint64_t s = (uint64_t)1 << (uint64_t)(n - 1);
  uint64_t m = s * 2 - 1;
  return (int64_t)((((uint64_t)v & m) ^ s) - s);
}
