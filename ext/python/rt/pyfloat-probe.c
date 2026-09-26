/* ext/python/rt/pyfloat-probe.c —— 尺子用的那格小程序
 *
 * 一行一个数进来（命令行实参），一行一个 `repr` 出去。判据在 `tests/python/rt.js`：
 * 同一串数交给 `python3 -c 'print(repr(float(s)))'`，两边**逐字节相同**才算过。
 */
#include <stdio.h>

#include "omni_pyfloat.h"

int main(int argc, char **argv) {
    char buf[64];
    for (int i = 1; i < argc; i++) {
        double v;
        if (omni_py_float_from_string(argv[i], &v) != 0) {
            printf("!parse %s: %s\n", argv[i], omni_py_last_error());
            continue;
        }
        if (omni_py_float_repr(v, buf, sizeof buf) != 0) {
            printf("!repr %s: %s\n", argv[i], omni_py_last_error());
            continue;
        }
        printf("%s\n", buf);
    }
    return 0;
}
