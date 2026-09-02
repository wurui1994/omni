/* 第八刀第四十二片：转成数组类型 = 去掉「数组」这一层，剩下的是指向元素的指针
 * （tcc 的 `gen_cast` 最后一句就是抹掉 VT_ARRAY 位）。
 * tcctest.c:1560 那一行自带注释「We try to handle this syntax.」。 */
#include <stdio.h>

char invalid_function_def()[] { return 0; }

typedef char CA[4];

int main(void)
{
    printf("call %d\n", (int)(long)invalid_function_def());
    printf("cast %d\n", (int)(long)(CA)0);
    char *p = (CA)"hi";
    printf("p %s\n", p);
    return 0;
}
