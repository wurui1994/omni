/* ext/r/rt/omni_rna.c —— 见 omni_rna.h 文件头那段账（这一份是我们自己的代码，不是 R 的）。 */

#include <math.h>
#include <string.h>
#include "omni_rna.h"

/* R Internals §1.3：`NA_real_` 是一个 NaN，**低 32 位写 1954**。
   用 union 而不是指针硬转：后者是严格别名规则下的未定义行为，而这一格要的就是位模式准。 */
typedef union { double d; unsigned int w[2]; } omni_r_ieee;

/* 高低字在内存里哪一头，由本机的字节序定。这儿按 `double` 的 IEEE 布局取"低 32 位"：
   小端机器上它是 `w[0]`，大端上是 `w[1]`。R 自己那份也是这么分的两档。 */
#ifdef WORDS_BIGENDIAN
# define OMNI_R_LOW 1
#else
# define OMNI_R_LOW 0
#endif

#define OMNI_R_NA_PAYLOAD 1954u

double omni_r_na(void)
{
    omni_r_ieee v;
    v.d = NAN;
    v.w[OMNI_R_LOW] = OMNI_R_NA_PAYLOAD;
    return v.d;
}

double omni_r_nan(void) { return NAN; }

/* `1.0/0.0` 会被一些编译器在编译期当成错误折掉，所以走一格不会被折的写法。 */
double omni_r_posinf(void) { return HUGE_VAL; }
double omni_r_neginf(void) { return -HUGE_VAL; }

/* `is.na`：R 的文档明写它对 `NaN` 也真 —— 所以它就是 isnan，不看载荷。 */
int omni_r_is_na(double x) { return isnan(x) ? 1 : 0; }

/* `is.nan`：只有**不带 1954 载荷**的 NaN 算。
   `NA` 与 `NaN` 在算术里都会传播，而传播之后载荷不一定保得住 —— R 自己也有这条说明
   （"the NA payload may be lost"），所以这儿只判"手上这一格"，不声称能追溯来源。 */
int omni_r_is_nan(double x)
{
    omni_r_ieee v;
    if (!isnan(x)) return 0;
    v.d = x;
    return v.w[OMNI_R_LOW] == OMNI_R_NA_PAYLOAD ? 0 : 1;
}

int omni_r_is_infinite(double x) { return isinf(x) ? 1 : 0; }
