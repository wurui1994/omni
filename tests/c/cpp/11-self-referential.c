/* **自指的宏那个"不再展开"的印，跨过「当实参被读走」这一步也得留着**。
 *
 * C11 6.10.3.4 第 2 段：重扫的时候遇到**正在展开的那个宏自己**的名字，不再展开它。
 * tcc 的做法是给那个记号打一个 `SYM_FIELD` 的印（`tccpp.c:3435`），印只在最后交给
 * 语法分析那一步摘掉（`tccpp.c:3491`）。关键在于：那个打了印的记号可能**接着被当成
 * 另一个宏的实参**读走 —— 读的时候不能把印摘了，摘了它在外层重扫时就又展开一遍。
 *
 * 逼出这一格的是 CPython 的 `Include/cpython/classobject.h:65`：
 *
 *     static inline PyObject* PyInstanceMethod_GET_FUNCTION(PyObject *meth) { … }
 *     #define PyInstanceMethod_GET_FUNCTION(m) PyInstanceMethod_GET_FUNCTION(_PyObject_CAST(m))
 *
 * 「宏与同名 inline 函数」这一招 CPython 的头文件里到处是。多展开一层的后果不是多几个
 * 括号那么无害：`Objects/classobject.c:417` 的 `Py_DECREF(PyInstanceMethod_GET_FUNCTION(self))`
 * 会把 `_PyObject_CAST` 推到没人再展开它的位置上，于是报「隐式声明的函数 `_PyObject_CAST`」。
 *
 * 这一格的判据就是这份文件与 `tcc -E` 的六种模式逐字节相同（见 `tests/c/run.js` 的 `compare`）。 */

#define CAST(op) ((T *)(op))
#define GET(m) GET(CAST(m))
#define DEC(o) DEC(CAST(o))

/* 一、`DEC(GET(x))` —— 打了印的 `GET` 当 `CAST` 的实参被读走那一格 */
DEC(GET(self));
/* 二、单独一层：印在这儿也要留住（`GET` 只出现一次） */
GET(self);
/* 三、嵌两层同名的：里外都是 `GET` */
GET(GET(self));
/* 四、三个宏套起来 */
DEC(GET(CAST(self)));

/* 五、`#define REC REC` 那一族（对象式宏自指，不会死循环） */
#define REC REC
#define REC2 REC3
#define REC3 REC2
REC REC2 REC3

/* 六、自指 + `##`：粘出来的名字是新记号，不带印 */
#define JOIN(a, b) a##b
#define AB JOIN(A, B)
#define A JOIN(A, X)
AB A
