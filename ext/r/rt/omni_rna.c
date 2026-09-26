/* ext/r/rt/omni_rna.c —— 见 omni_rna.h 文件头那段账（这一份是我们自己的代码，不是 R 的）。 */

#include <math.h>
#include <stdlib.h>
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

/* ---- 按指针进出（见头文件那段账） ---- */

void omni_r_na_into(double *p) { *p = omni_r_na(); }
int omni_r_is_na_p(const double *p) { return omni_r_is_na(*p); }
int omni_r_is_nan_p(const double *p) { return omni_r_is_nan(*p); }

/* ---- 串 → 数（见头文件里那段量出来的账） ---- */

static int omni_r_isspace(char c)
{
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
}

int omni_r_numdigits(const char *s)
{
    const char *p = s;
    int nd = 0;          /* 数出来的有效数字 */
    int seen = 0;        /* 见过至少一个数字 */
    int lead = 1;        /* 还在前导零里 */
    while (omni_r_isspace(*p)) p++;
    if (*p == '+' || *p == '-') p++;
    /* 十六进制那一档 R 走的是另一条路（按 16 累加），这儿不接 —— 单独一个回值，
       让上头报得清楚，而不是混进"这不是一个数"。 */
    if (p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) return -2;
    for (; *p >= '0' && *p <= '9'; p++) {
        seen = 1;
        if (*p != '0') lead = 0;
        if (!lead) nd++;
    }
    if (*p == '.') {
        p++;
        for (; *p >= '0' && *p <= '9'; p++) {
            seen = 1;
            if (lead && *p == '0') continue;   /* `0.00123` 的那两个零不算 */
            lead = 0;
            nd++;
        }
    }
    if (!seen) return -1;
    if (*p == 'e' || *p == 'E') {
        p++;
        if (*p == '+' || *p == '-') p++;
        if (!(*p >= '0' && *p <= '9')) return -1;
        while (*p >= '0' && *p <= '9') p++;
    }
    while (omni_r_isspace(*p)) p++;
    if (*p != '\0') return -1;   /* 后面还挂着别的字 —— R 那边出 NA 并警告 */
    return nd;                   /* 全是零时 0 位，那一格准确无疑 */
}

double omni_r_str2d(const char *s) { return strtod(s, (char **)0); }
