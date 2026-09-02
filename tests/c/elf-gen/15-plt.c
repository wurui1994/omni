/* 未定义的**弱函数**：被调用就要一格 `.plt`（代码类 -> `R_JMP_SLOT`），
 * 被取地址还要另一格 `.got`（数据类 -> `R_GLOB_DAT`）—— 同一个符号两格 GOT，
 * 头一趟给跳板占的那格在前。
 *
 * 调用点的重定位最后指的不是 `maybe` 而是 `maybe@plt`，所以 `.text` 里那条
 * call/bl 跳进 `.plt`；静态链接不叫 `relocate_plt`，跳板里的 got 偏移就那么留着。 */

__attribute__((weak)) int maybe(int);

int main(void)
{
    if (maybe)
        return maybe(3);
    return 7;
}
