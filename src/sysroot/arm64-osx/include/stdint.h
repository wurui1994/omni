/* `<stdint.h>` —— arm64-osx 的那一份（交叉编译用）。
 * arm64 macOS 是 LP64，与 x86_64-linux 完全一样。 */
#ifndef _STDINT_H
#define _STDINT_H

typedef signed char int8_t;
typedef short int int16_t;
typedef int int32_t;
typedef long long int64_t;

typedef unsigned char uint8_t;
typedef unsigned short int uint16_t;
typedef unsigned int uint32_t;
typedef unsigned long long uint64_t;

typedef long long intmax_t;
typedef unsigned long long uintmax_t;

#define INT8_MIN (-128)
#define INT16_MIN (-32767 - 1)
#define INT32_MIN (-2147483647 - 1)
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
