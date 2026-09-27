/* **浮点的有序比较那一族**（C99 的 `isgreater` 一家）—— gcc/clang 的内建，**tcc 没有**，
 * 所以这一格的尺子是 clang（`gnu/` 这一组的理由，见 `tests/c/run.js` 的 `gnuCase`）。
 *
 * macOS 的 `<math.h>:584` 起把六个标准宏直接定义成这几个内建，于是不认它们就编不了任何
 * 真用了 `isgreater(…)` 的 `.c` —— 量到的是 CPython 的 `Modules/mathmodule.c:230`
 * （`math.fmod` / `remainder` 那一路）。
 *
 * 考三件事：
 *   1. 六个比较在**普通值**上与 `>` `>=` `<` `<=` 一致；
 *   2. 在 **NaN** 上：前五个一律假、`isunordered` 真（C99 7.12.14）；
 *   3. **实参只求值一次**（`calls` 那一格）—— 宏体是语句表达式，参数各存一次。
 *
 * 不考浮点异常标志：我们这条链一个都不读（四条腿都没有 `fetestexcept`），
 * 所以"静默比较"与"普通比较"在可观察行为上一样。那一条记在 `tccdefs.js` 那一段注里。 */
#include <stdio.h>
#include <math.h>

static int calls = 0;

static double tick(double v) {
    calls++;
    return v;
}

int main(void) {
    double a = 1.5;
    double b = 2.5;
    double nan = 0.0 / 0.0;

    printf("%d %d %d %d %d %d\n", isgreater(b, a), isgreater(a, b),
           isgreaterequal(a, a), isless(a, b), islessequal(b, a), islessgreater(a, b));
    printf("%d %d %d %d %d %d\n", isgreater(nan, a), isgreaterequal(nan, a),
           isless(nan, a), islessequal(nan, a), islessgreater(nan, a), isunordered(nan, a));
    printf("%d %d\n", isunordered(a, b), isunordered(nan, nan));

    /* 记一格差别：**整数实参 clang 明着拒**（`ordered compare requires two args of
     * floating point type`），而我们那几条宏是 `__typeof__` + 普通比较，整数照样算 ——
     * 也就是我们比 clang **宽**。宽在这一格不会让对的代码变错，所以不改；
     * 用例里也就不能考它（考了 clang 编不过，这一组的尺子就没了）。 */

    /* 实参只求值一次：六个各来一次，`calls` 该正好是 12（每个两个实参） */
    calls = 0;
    int s = isgreater(tick(2.0), tick(1.0)) + isgreaterequal(tick(1.0), tick(1.0))
        + isless(tick(1.0), tick(2.0)) + islessequal(tick(1.0), tick(1.0))
        + islessgreater(tick(1.0), tick(2.0)) + isunordered(tick(1.0), tick(2.0));
    printf("%d %d\n", s, calls);
    return 0;
}
