/* 这条语料读之前先压上的一份「合成前言」（`ext/cpp/bench.json` 的 `preprocess.includes`）。
 *
 * 为什么要它：这门语法**问驱动器"这个名字登记成类型了吗"**（`declares-type` / `needs-type`），
 * 而登记只能来自源码里真的声明。语料里那些 `.cc` 的类型名一大半在头文件里，而头文件这一趟
 * 是跳过的（`--skip-missing-includes`，理由见 bench.json）。于是 `size_t x = 0;` 这种行
 * 读不成声明。
 *
 * 量出来的（第十、十一支探针）：出错那一格前面那个 ID 只有 **37 个不同的名字**，
 * 最常见的 23 个占 **95%**（`size_t` 92 · `string` 25 · `ostream` 4 …）。把标准库那几个
 * 补上，这条语料 **71 -> 79**，一份都没弄坏。
 *
 * 规矩（不许越过）：**只放标准库与编译器自己的名字**。项目自己的类型（`FilePath` /
 * `Vector` / `ExpectationBase` …）不许放 —— 那种要靠真读头文件，写在这儿就是作弊：
 * 语料量的是"这门语法读不读得动别人的源码"，不是"我能不能把答案抄进前言"。
 *
 * 形状也只求够登记：`class string;` 这种前向声明就足以让 `string& s` 读成声明，
 * 不必（也不该）在这儿摆一份假的标准库。 */

/* <cstddef> / <cstdint> / POSIX 那一批整数别名 */
typedef unsigned long size_t;
typedef long ptrdiff_t;
typedef long ssize_t;
typedef unsigned char uint8_t;
typedef signed char int8_t;
typedef unsigned short uint16_t;
typedef short int16_t;
typedef unsigned int uint32_t;
typedef int int32_t;
typedef unsigned long long uint64_t;
typedef long long int64_t;
typedef unsigned long uintptr_t;
typedef long intptr_t;
typedef long time_t;
typedef int pid_t;
typedef unsigned int mode_t;
typedef unsigned long off_t;
typedef int wint_t;

/* 编译器自己的那两个（`<cstdarg>` 展开出来的就是它们） */
typedef void *va_list;
typedef void *__builtin_va_list;

/* <cstdio> 里唯一一个当类型用的 */
typedef struct _IO_FILE FILE;

/* 常用的那几个类：只要前向声明，够登记成类型名 */
class string;
class wstring;
class ostream;
class istream;
class stringstream;
class ostringstream;
class istringstream;
class exception;

/* **模板名也要登记**（量出来的：`typedef std::reverse_iterator< iterator > rit;` 这一形
 * 在 81 那一版里是头名，114 份）。同一条规矩：只放标准库自己的名字，形状只求够登记 ——
 * 形参个数按最常见的那一版写（`std::map<K,V>` 三个实参那种在语法上不看个数）。 */
template <class T> class vector;
template <class T> class list;
template <class T> class deque;
template <class T> class queue;
template <class T> class stack;
template <class T> class set;
template <class T> class multiset;
template <class T> class map;
template <class T> class multimap;
template <class T> class unordered_set;
template <class T> class unordered_map;
template <class T> class pair;
template <class T> class tuple;
template <class T> class array;
template <class T> class valarray;
template <class T> class complex;
template <class T> class optional;
template <class T> class variant;
template <class T> class atomic;
template <class T> class initializer_list;
template <class T> class allocator;
template <class T> class char_traits;
template <class T> class basic_string;
template <class T> class basic_ostream;
template <class T> class basic_istream;
template <class T> class basic_stringstream;
template <class T> class shared_ptr;
template <class T> class unique_ptr;
template <class T> class weak_ptr;
template <class T> class function;
template <class T> class reference_wrapper;
template <class T> class reverse_iterator;
template <class T> class iterator;
template <class T> class iterator_traits;
template <class T> class numeric_limits;
template <class T> class less;
template <class T> class greater;
template <class T> class equal_to;
template <class T> class hash;

/* <type_traits> 那一族（`typename std::remove_cv<T>::type` 这种写法要它们登记） */
template <class T> class remove_cv;
template <class T> class remove_const;
template <class T> class remove_volatile;
template <class T> class remove_reference;
template <class T> class remove_pointer;
template <class T> class remove_extent;
template <class T> class decay;
template <class T> class enable_if;
template <class T> class conditional;
template <class T> class is_same;
template <class T> class is_const;
template <class T> class is_pointer;
template <class T> class is_reference;
template <class T> class is_class;
template <class T> class is_convertible;
template <class T> class is_base_of;
template <class T> class integral_constant;
template <class T> class tuple_size;
template <class T> class tuple_element;
