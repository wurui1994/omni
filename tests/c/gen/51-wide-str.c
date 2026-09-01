/* 第八刀第三十片：宽字符常量与宽字符串（`L'a'` / `L"ab"`）。
 * tcctest.c:428 那一行（`printf("wc=%C …", L'a', L'\x1234', L'c')`）要的就是这个。
 * `wchar_t` 在这个目标上是 `int`（4 字节、带符号），所以 `sizeof(L"ab")` 是 12。 */
#include <stdio.h>
#include <stddef.h>

wchar_t gw[] = L"ab";
wchar_t gw2[4] = L"xy";
int gwi[3] = L"pq";              /* 元素类型就是 wchar_t，所以照样是「铺进数组」 */
wchar_t *gwp = L"zz";
wchar_t gwb[] = { L"cd" };       /* 花括号裹着的宽串 */
int gsub = L"abc"[1];            /* 常量表达式里的下标 */

int main(void)
{
    int i;
    wchar_t w[] = L"hi";
    wchar_t w2[] = L"a" L"bc";   /* 相邻的宽串要拼起来 */
    wchar_t w3[3] = { L"ab" };
    printf("L'a'=%d L'\\x1234'=%d 0x%lx\n", L'a', L'\x1234', (unsigned long)L'\x1234');
    printf("sizeof L\"ab\"=%d sizeof(gw)=%d sizeof(w)=%d\n",
           (int)sizeof(L"ab"), (int)sizeof(gw), (int)sizeof(w));
    for (i = 0; i < 3; i++) printf("gw[%d]=%d gwb[%d]=%d\n", i, gw[i], i, gwb[i]);
    for (i = 0; i < 4; i++) printf("gw2[%d]=%d\n", i, gw2[i]);
    for (i = 0; i < 3; i++) printf("gwi[%d]=%d\n", i, gwi[i]);
    for (i = 0; i < 3; i++)
        printf("w[%d]=%d w2[%d]=%d w3[%d]=%d\n", i, w[i], i, w2[i], i, w3[i]);
    printf("gwp=%d,%d gsub=%d L\"ab\"[1]=%d\n", gwp[0], gwp[1], gsub, L"ab"[1]);
    /* `\u`/`\U` 与源码里的非 ASCII：宽的一格一个码位，窄的按 UTF-8 的字节 */
    printf("wide=%d,%d narrow=%d,%d\n",
           L"\u00e9"[0], L"é"[0], (unsigned char)"\u00e9"[0], (unsigned char)"é"[1]);
    printf("neg=%d\n", L'\xffffffff');
    return 0;
}
