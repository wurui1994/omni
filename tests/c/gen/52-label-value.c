/* 第八刀第三十一片：标签当值（`&&label`）与计算跳转（`goto *p`），GNU 扩展。
 * tcctest.c:555 的 `static void *label_table[3] = { &&label1, … };` 就是这一格。 */
#include <stdio.h>

int pick(int i)
{
    static void *tab[3] = { &&a, &&b, &&c };
    int r = 0;
    goto *tab[i];
a:
    r = 10;
    goto out;
b:
    r = 20;
    goto out;
c:
    r = 30;
out:
    return r;
}

typedef int typedef_and_label;

int main(void)
{
    int i;
    void *p;
    /* struct 里的同一个名字要当**类型**（一个没名字的 32 位位域） */
    struct { int bla; typedef_and_label : 32; } y = { 1 };
    /* 这是普通声明 */
    typedef_and_label x = 7;

    /* 这一个要当**标签** —— typedef 名后面跟 `:` 时标签先赢 */
typedef_and_label:
    printf("y.bla=%d x=%d\n", y.bla, x);

    for (i = 0; i < 3; i++) {
        goto *(i == 0 ? &&label1 : i == 1 ? &&label2 : &&label3);
    label1:
        printf("label1\n");
        goto next;
    label2:
        printf("label2\n");
        goto next;
    label3:
        printf("label3\n");
    next: ;
    }
    for (i = 0; i < 3; i++) printf("pick(%d)=%d\n", i, pick(i));
    /* 前向引用：`done` 写在后面 */
    p = &&done;
    goto *p;
    printf("not reached\n");
done:
    printf("done\n");
    return 0;
}
