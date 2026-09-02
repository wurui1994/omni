/* 第八刀第五十九片：函数类型的 sizeof 是 1，以及窄返回类型由调用方截一刀。 */
#include <stdio.h>

void nothing(int i) { (void)i; }

static int __csf(int x) { return x; }
static void *_csf = (void *)__csf;
#define csf(t, n) ((t (*)(int))_csf)(n)

char retc(void) { return 200; }
short rets(void) { return -3; }
unsigned char retuc(void) { return 300; }
_Bool retb(void) { return 7; }

typedef int fn_t(int);

int main(void)
{
    fn_t *fp = __csf;
    printf("sz %d %d %d %d\n", (int)sizeof(nothing), (int)sizeof nothing,
           (int)sizeof(&nothing), (int)sizeof &nothing);
    printf("sz2 %d %d\n", (int)sizeof(fn_t), (int)__alignof__(fn_t));
    printf("sz3 %d %d\n", (int)sizeof(*fp), (int)sizeof(main));
    printf("own %d %d %d %d\n", retc(), rets(), retuc(), retb());
    printf("uc %d\n", csf(unsigned char, 0x89898989));
    printf("sc %d\n", csf(signed char, 0xabababab));
    printf("us %d\n", csf(unsigned short, 0xcdcdcdcd));
    printf("ss %d\n", csf(short, 0xefefefef));
    printf("b %d %d\n", csf(_Bool, 0x33221100), csf(_Bool, 0x33221101));
    printf("sum %d\n", csf(unsigned char, 0x89898989) + 1);
    return 0;
}
