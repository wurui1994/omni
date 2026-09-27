/* 第八刀第四十片：复合字面量 `(T){…}`（C11 6.5.2.5）。
 * tcctest.c:1472 一带那几条（`int *cinit2 = (int []){3,2,1};` 等）。 */
#include <stdio.h>

struct P { int a, b; };
union U { int i; char c[4]; };

/* 文件作用域：静态存储期 */
int *cinit2 = (int []){ 3, 2, 1 };
int cinit4 = (int){ 44 };
void *cinit51 = (void *){ (void *)51 };
void *cinit52 = &(void *){ (void *)52 };
struct P cinit6 = (struct P){ 61, 62 };
struct P *cinit7 = &(struct P){ 71, 72 };
char *cs = (char []){ 'h', 'i', 0 };
int *part = (int [4]){ 9 };            /* 没写满的那几格是 0 */

/* `T x = (T){…}` 当**声明的初始化式**那一格：没点名的成员照样要归零
 * （C11 6.7.9 第 21 段）。出处是 CPython 的
 * `_PyPreCmdline_INIT`（`Include/internal/pycore_initconfig.h:110`）——
 * 三个 int 点了名、前两个成员是一个都没点名的**嵌套结构体**。
 * 从前这一格漏了清零：`decl` 那儿判的是 `=` 后面第一个记号是不是 `{`，而这一路是 `(`。
 *
 * 要**先把栈写脏**才量得出来 —— 不然"看着是 0"只是那一段栈本来干净。
 * `dirt()` 与 `pc_zero()` 都从 main 里同一层调，帧落在同一段上。 */
struct Two { long len; void *items; };
struct PC { struct Two a, b; int i, j, k; };

static long dirt(void)
{
    volatile long buf[16];
    int n;
    for (n = 0; n < 16; n++) buf[n] = -1L;
    return buf[0] + buf[15];
}

static int pc_zero(void)
{
    struct PC c = (struct PC){ .i = -1, .j = -1 };
    return c.a.len == 0 && c.a.items == 0 && c.b.len == 0 && c.b.items == 0
        && c.i == -1 && c.j == -1 && c.k == 0;
}

static int sum(struct P *p) { return p->a * 100 + p->b; }
static int addup(int *v, int n)
{
    int s = 0, i;
    for (i = 0; i < n; i++) s += v[i];
    return s;
}

int main(void)
{
    printf("f %d %d %d\n", cinit2[0], cinit2[1], cinit2[2]);
    printf("f %d %d %d\n", cinit4, (int)(long)cinit51, (int)(long)*(void **)cinit52);
    printf("f %d %d %d %d\n", cinit6.a, cinit6.b, cinit7->a, cinit7->b);
    printf("f %s %d %d\n", cs, part[0], part[3]);

    /* 块作用域：自动存储期 */
    int *p = (int []){ 7, 8, 9 };
    printf("l %d %d %d\n", p[0], p[1], p[2]);
    printf("l %d %d\n", (int){ 5 }, (struct P){ 11, 12 }.b);
    printf("l %d\n", sum(&(struct P){ 31, 32 }));
    printf("l %d\n", addup((int []){ 1, 2, 3, 4 }, 4));

    struct P s = (struct P){ 41, 42 };
    printf("l %d %d\n", s.a, s.b);

    /* 指定初始化器照旧管用 */
    int *d = (int [5]){ [1] = 2, [4] = 5 };
    printf("d %d %d %d %d\n", d[0], d[1], d[3], d[4]);

    /* 嵌套：里面又是一个复合字面量 */
    struct P *pp = &(struct P){ .a = (int){ 51 }, .b = 52 };
    printf("n %d %d\n", pp->a, pp->b);

    union U u = (union U){ .c = { 1, 2, 3, 4 } };
    printf("u %d %d\n", u.c[0], u.c[3]);

    /* 循环里的那一格：同一块内存，每一圈重新铺 */
    int i, t = 0;
    for (i = 0; i < 3; i++) {
        int *q = (int []){ i, i + 1 };
        t += q[0] + q[1];
    }
    printf("loop %d\n", t);

    printf("sz %d %d %d\n", (int)sizeof((int []){ 1, 2, 3 }),
           (int)sizeof((struct P){ 0, 0 }), (int)sizeof((char []){ "abcd" }));

    /* 改它是合法的 —— 它是个左值 */
    int *m = (int []){ 1, 2 };
    m[0] = 100;
    printf("lv %d %d\n", m[0], m[1]);

    if (dirt() == 0) printf("(不会走到)\n");
    printf("dz %d\n", pc_zero());
    return 0;
}
