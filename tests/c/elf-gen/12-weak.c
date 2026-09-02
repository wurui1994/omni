/* 未定义的**弱**符号：地址是 0，而且要走 `.got`（`AUTO_GOTPLT_ENTRY` 加未定义 ->
 * 数据类 -> `R_GLOB_DAT`）。 */

__attribute__((weak)) extern int maybe_data;

static int fallback = 42;

int main(void)
{
    int *p = &maybe_data;
    if (p == 0)
        p = &fallback;
    return *p;
}
