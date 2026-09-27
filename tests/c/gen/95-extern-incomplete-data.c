/* 第一百四十三片：**类型还不完整时的 `extern` 声明，别把别人的初值吃掉**。
 *
 * 一遍过的编译器给每个全局量在一块暂存的线性地址上划位置（`allocGlobal`）。
 * `extern struct Big b;` 这一刻 `struct Big` 可能还没定义 —— `sizeof` 是 0，
 * 于是一串这样的声明**全落在同一个地址上**；封盘那步又按"现在这个类型有多大"
 * 去把没认领的字节丢掉，把后面那些全局量的初值一起丢了。
 *
 * 量出来的原话：CPython 的 `Include/object.h` 先
 *   `PyAPI_DATA(PyTypeObject) PyType_Type;`（那时 `struct _typeobject` 还没定义）
 * 再声明 `PyAPI_DATA(PyObject) _Py_NoneStruct;`，而 `Objects/object.c:2400` 定义后者。
 * 于是我们编出来的 `Py_None` 的 refcnt 是 0（该是 3<<30），CPython 一初始化就
 * `assert(_Py_IsImmortal(constants[i]))` 崩在 `Objects/object.c:3472`。
 *
 * 这一格考两件事：
 *   1. 不完整类型的 extern 声明**不吃**后面那些全局量的初值；
 *   2. 同一个名字后来真成了定义（类型这会儿完整了）时，要重新划一块够大的地方 ——
 *      不然它的初值会写到别人的字节上。 */
#include <stdio.h>

struct Big;                         /* 这一刻不完整 */
extern struct Big big1;
extern struct Big big2;
extern struct Big big3;

/* 夹在中间的这几个的初值就是被吃掉的那些 */
struct Vals { unsigned a; unsigned short b; unsigned short c; };
struct Vals vals = { .a = 0xC0000000u, .c = 5 };
unsigned guard1 = 0x11223344u;
char msg[8] = "hi";

struct Big { char pad[400]; };      /* 现在完整了 */

/* 第二件事：先不完整地声明、后面才定义 */
struct Later;
extern struct Later later;
unsigned guard2 = 0x55667788u;
struct Later { unsigned x[4]; };
struct Later later = { { 1, 2, 3, 4 } };

/* 那三个 extern **故意不引用** —— 它们是"声明了、别处定义"的那种，真引用了这一格就
 * 链不起来（`tcc -run` 要现场解析）。而那格错发生在封盘：不认领的字节按"现在的类型
 * 有多大"去丢，引不引用都一样。 */

int main(void)
{
    printf("vals %u %u %u\n", vals.a, vals.b, vals.c);
    printf("guard %u %u\n", guard1, guard2);
    printf("msg %s\n", msg);
    printf("later %u %u %u %u\n", later.x[0], later.x[1], later.x[2], later.x[3]);
    printf("sz %d\n", (int)sizeof(struct Big));
    return 0;
}
