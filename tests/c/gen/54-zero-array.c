/* 第八刀第三十三片：长度 0 的数组（GNU 扩展，tcctest.c:985 那一格）。
 * sizeof 是 0，但对齐还是元素的对齐 —— 老代码拿它当「只要对齐、不要空间」的垫片。 */
#include <stdio.h>

struct at4 { double a[0]; };
struct at7 { int a; char b[0]; };
struct at8 { char a[0]; };
int gz[0];
char gz2[0];

struct hdr { int len; char data[0]; };

int main(void)
{
    struct at7 s;
    struct at4 four[3];
    char buf[sizeof(struct hdr) + 8];
    struct hdr *h = (struct hdr *)buf;
    int i;

    printf("sizes: %d %d %d %d %d\n", (int)sizeof(struct at4), (int)sizeof(struct at7),
           (int)sizeof(struct at8), (int)sizeof(gz), (int)sizeof(gz2));
    printf("four=%d hdr=%d\n", (int)sizeof(four), (int)sizeof(struct hdr));
    s.a = 5;
    printf("a=%d off=%d\n", s.a, (int)((char *)s.b - (char *)&s));
    /* 零长数组当「后面接着一段」用：这是它真正的用途 */
    h->len = 4;
    for (i = 0; i < 4; i++) h->data[i] = 'a' + i;
    printf("len=%d data=%c%c%c%c off=%d\n", h->len,
           h->data[0], h->data[1], h->data[2], h->data[3],
           (int)((char *)h->data - (char *)h));
    return 0;
}
