/* 第八刀第三十二片：typedef 名是普通标识符，能被同名的变量遮住
 * （tcctest.c:655-662 那一段）。 */
#include <stdio.h>

typedef int *my_ptr;
typedef int mytype1;
typedef int mytype2;
typedef int shadow_me;

int outer(shadow_me x) { return x + 1; }

int param_shadow(int shadow_me) { return shadow_me * 2; }

/* 成员表里的空成员与 `_Static_assert`（tcc 在同一个岔路上收这两格） */
struct empty_mem {
    /* nothing */ ;
    int x;
    _Static_assert(sizeof(int) == 4, "int is 4");
    ;
    int y;
};

int main(void)
{
    my_ptr a;
    mytype1 mytype2;          /* 变量名就是另一个 typedef 的名字 */
    int b;

    a = &b;
    *a = 1234;
    printf("a=%d\n", *a);
    mytype2 = 2;              /* 这一行是表达式，不是声明 */
    printf("mytype2=%d\n", mytype2);
    printf("outer=%d param=%d\n", outer(5), param_shadow(7));

    {
        /* 里层的 typedef 遮住外层，出了块就没了 */
        typedef char shadow_me;
        shadow_me c = 'z';
        printf("inner=%d size=%d\n", c, (int)sizeof(shadow_me));
    }
    {
        shadow_me d = 9;      /* 又是 int 了 */
        printf("outer again=%d size=%d\n", d, (int)sizeof(shadow_me));
    }
    {
        int shadow_me = 3;    /* 变量遮住 typedef */
        shadow_me += 4;
        printf("var=%d\n", shadow_me);
    }
    printf("still a type: %d\n", (int)sizeof(shadow_me));
    {
        struct empty_mem e;
        e.x = 3; e.y = 4;
        printf("empty_mem=%d,%d size=%d\n", e.x, e.y, (int)sizeof(e));
    }
    return 0;
}
