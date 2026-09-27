/* **指定初始化符穿透匿名 struct / union**（C11 6.7.9：匿名成员的成员就是外层的成员）。
 *
 * 逼出这一格的是 CPython 的 `PyObject`（`Include/object.h:127`，匿名 union 里套匿名 struct）：
 * `Objects/object.c:2400` 的 `_Py_NoneStruct = _PyObject_HEAD_INIT(&_PyNone_Type)` 展开成
 *   { .ob_refcnt = (3ULL << 30), .ob_flags = (…), .ob_type = (&_PyNone_Type) }
 * —— 前两格住在那两层匿名里，第三格是外层成员。
 *
 * 从前这儿拿**摊平表**（`ref.fields`）的下标当**按声明表**（`initMembers` / `ref.inits`）的
 * 序号用。两张表长度不一样（匿名成员在摊平表里摊成好几格），于是匿名成员**后面**的成员一律
 * 错位（`excess elements in struct initializer`）；三个指定符一起时还会错到 `int64_t` 那一格
 * 上（`initializer element is not constant`）。两张表分家是上一刀（匿名 union 的**位置式**
 * 初始化）留下的账，这一刀补的是**指定式**那一半。
 */
#include <stdint.h>
#include <stdio.h>

typedef struct { void *p; } T;

typedef struct {
    union {
        int64_t full;
        struct { uint32_t refcnt; uint16_t overflow; uint16_t flags; };
        char aligner;
    };
    T *type;
} P;

static T tt;

P a = { .refcnt = (3ULL << 30), .flags = ((long)((1 << 2) | (1 << 0))), .type = (&tt) };
P b = { .type = (&tt) };
P c = { .full = 0x123456789abcLL, .type = (&tt) };
P d = { .type = (&tt), .refcnt = 9 };

typedef struct { int head; struct { struct { int deep; }; int mid; }; int tail; } Q;
static Q q = { .head = 1, .deep = 2, .mid = 3, .tail = 4 };

int main(void) {
    printf("%u %u %d\n", a.refcnt, a.flags, a.type == &tt);
    printf("%u %d\n", b.refcnt, b.type == &tt);
    printf("%lld %d\n", (long long)c.full, c.type == &tt);
    printf("%u %d\n", d.refcnt, d.type == &tt);
    printf("%d %d %d %d\n", q.head, q.deep, q.mid, q.tail);
    P e = { .refcnt = 5, .type = (&tt) };
    printf("%u %d\n", e.refcnt, e.type == &tt);
    return 0;
}
