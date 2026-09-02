/* 第八刀第五十八片：printf 的 %C / %S（等于 %lc / %ls）。
 * 只印 ASCII 的宽字符 —— 宿主 libc 在 "C" 区域设置下把 >127 的宽字符当成非法序列，
 * 那一格对不了账，所以不碰。 */
#include <stdio.h>

int main(void)
{
    printf("wc=%C 0x%lx %C\n", L'a', L'\x1234', L'c');
    printf("wstring=%S\n", L"abc");
    printf("lc=%lc %lc\n", L'x', L'-');
    printf("ls=%ls|%ls|\n", L"hello", L"");
    printf("w=[%5C][%-5C][%5S][%-7S]\n", L'q', L'q', L"ab", L"cde");
    printf("p=[%.2S][%.0S][%.9S]\n", L"abcdef", L"abcdef", L"abc");
    printf("mix=%s %S %d\n", "narrow", L"wide", 42);
    return 0;
}
