/* `<stdint.h>` —— win32 的那一份（两个 arch 共用）（交叉编译用；形状沿用 Linux 那一套，见 ../README.md）。
 *
 * 宽度照 LP64：`long` 是 64 位，于是 `int64_t` 是 `long`（glibc 也这么定，
 * 与它对齐才不会在 `%ld` 那一族格式串上出警告）。 */
#ifndef _STDINT_H
#define _STDINT_H

typedef signed char int8_t;
typedef short int int16_t;
typedef int int32_t;
typedef long int int64_t;

typedef unsigned char uint8_t;
typedef unsigned short int uint16_t;
typedef unsigned int uint32_t;
typedef unsigned long int uint64_t;

typedef long int intmax_t;
typedef unsigned long int uintmax_t;

#define INT8_MIN (-128)
#define INT16_MIN (-32767 - 1)
#define INT32_MIN (-2147483647 - 1)
#define INT64_MIN (-9223372036854775807L - 1)

#define INT8_MAX 127
#define INT16_MAX 32767
#define INT32_MAX 2147483647
#define INT64_MAX 9223372036854775807L

#define UINT8_MAX 255
#define UINT16_MAX 65535
#define UINT32_MAX 4294967295U
#define UINT64_MAX 18446744073709551615UL

#define SIZE_MAX 18446744073709551615UL

#define INT64_C(c) c ## L
#define UINT64_C(c) c ## UL

#endif
