/* `<math.h>` 与 `<inttypes.h>`（第八十八片）：这两份里 `__has_include`、
 * `__builtin_*`、`_Float16` 那些编译器探针最密 —— 预定义少一条、答错一个，
 * 走的就是另一支 `#if`，输出立刻差出几十行。 */
#include <inttypes.h>
#include <math.h>
#include <time.h>

int64_t big = INT64_C(7);
double root = M_SQRT2;
time_t when;
