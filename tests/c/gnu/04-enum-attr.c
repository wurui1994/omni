/* **枚举常量上的 `__attribute__`** —— gcc/clang 收（C23 把"枚举项上的属性"写进了标准），
 * **tcc 不收**（`tccgen.c:4520-4528` 那个循环里，名字之后直接看 `=`），所以判据在 `gnu/`。
 *
 * 逼出它的是 macOS 的 `Security.framework/Headers/SecBase.h:329`：
 *   errSecDskFull __attribute__((deprecated("use errSecDiskFull"))) = errSecDiskFull,
 * `Modules/_scproxy.c`（`os.environ` 的代理设置那一份）要那份头。
 *
 * 属性本身对我们没有意义（`deprecated` 只影响诊断，而我们不发那档警告）——
 * 要紧的是**值照旧**：带属性的那一格与不带的一样参与"上一格 + 1"。
 * 所以这一格考的是**值**：带属性的枚举项、它后面那一项（隐式 +1）、以及
 * 一个属性写在 `=` 前面的负值项。 */
#include <stdio.h>

enum E {
    A = 1,
    B __attribute__((deprecated("用 A"))) = A,   /* 与 A 同值 */
    C,                                          /* 隐式：B + 1 */
    D __attribute__((unused)),                  /* 隐式：C + 1，属性在名字后、没有 = */
    E_NEG __attribute__((deprecated)) = -7,
    F,                                          /* -6 */
};

/* 两处属性连着写也要认（`parseAttrs` 那个循环） */
enum G {
    G1 __attribute__((deprecated)) __attribute__((unused)) = 10,
    G2,
};

int main(void) {
    printf("%d %d %d %d %d %d\n", (int)A, (int)B, (int)C, (int)D, (int)E_NEG, (int)F);
    printf("%d %d\n", (int)G1, (int)G2);
    /* 枚举的底层类型不该被属性影响：有负值 -> 有符号 */
    printf("%d %d\n", (int)sizeof(enum E), (int)(E_NEG < 0));
    return 0;
}
