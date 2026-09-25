/* `<stdint.h>` —— win32 的那一份（两个 arch 共用）（交叉编译用；形状沿用 Linux 那一套，见 ../README.md）。
 *
 * **`long` 有多宽不是一件确定的事**：我们自己那台后端按 LP64 发（`long` 64 位，与 Linux
 * 那一套对齐，`%ld` 那一族格式串才不打警告），而 Windows 上的 `cl` / `clang` 按 **LLP64**
 * —— 那儿 `long` 只有 32 位。所以 `int64_t` 不能硬写成 `long`：写死了，
 * `--cc msvc|clang --libc self` 这两条腿上的 `int64_t` 就成了 32 位，而这份头正是它们看到
 * 的那一份。量到的是 01_basics 最后一行 —— 一个 64 位的位型印出来是 `1` 而不是
 * `4611686014132420609`（高 32 位整个丢了）。
 *
 * 次序：**编译器自己说得出来就按它说的**（clang/gcc 预定义 `__INT64_TYPE__` 那一族，它是
 * 按目标的数据模型算出来的），说不出来再看 `_MSC_VER`（那一定是 LLP64），两样都没有才落回
 * `long`（我们自己那台前端走这一支）。 */
#ifndef _STDINT_H
#define _STDINT_H

typedef signed char int8_t;
typedef short int int16_t;
typedef int int32_t;

typedef unsigned char uint8_t;
typedef unsigned short int uint16_t;
typedef unsigned int uint32_t;

#if defined(__INT64_TYPE__) && defined(__UINT64_TYPE__)
typedef __INT64_TYPE__ int64_t;
typedef __UINT64_TYPE__ uint64_t;
#elif defined(_MSC_VER)
typedef long long int64_t;
typedef unsigned long long uint64_t;
#else
typedef long int int64_t;
typedef unsigned long int uint64_t;
#endif

/* 指针那一对。少了它们的样子是
 *   omni.h:301: error: use of undeclared identifier 'uintptr_t'
 * （`cl` 那条腿上从前是 VC 自己那份头顶上的；clang 那条腿 `-nostdlibinc` 之后没人顶了。） */
#if defined(__INTPTR_TYPE__) && defined(__UINTPTR_TYPE__)
typedef __INTPTR_TYPE__ intptr_t;
typedef __UINTPTR_TYPE__ uintptr_t;
#elif defined(_MSC_VER)
typedef long long intptr_t;
typedef unsigned long long uintptr_t;
#else
typedef long int intptr_t;
typedef unsigned long int uintptr_t;
#endif

typedef int64_t intmax_t;
typedef uint64_t uintmax_t;

#define INT8_MIN (-128)
#define INT16_MIN (-32767 - 1)
#define INT32_MIN (-2147483647 - 1)
/* 后缀刻意用 `LL`：LLP64 上 `L` 只有 32 位，那个常量就装不进去（C 会往上找到
 * `long long`，但 `-Wconstant-conversion` 那一档会先喊一句）。LP64 上 `LL` 同样是 64 位。 */
#define INT64_MIN (-9223372036854775807LL - 1)

#define INT8_MAX 127
#define INT16_MAX 32767
#define INT32_MAX 2147483647
#define INT64_MAX 9223372036854775807LL

#define UINT8_MAX 255
#define UINT16_MAX 65535
#define UINT32_MAX 4294967295U
#define UINT64_MAX 18446744073709551615ULL

#define SIZE_MAX 18446744073709551615ULL

#define INT64_C(c) c ## LL
#define UINT64_C(c) c ## ULL

#endif
