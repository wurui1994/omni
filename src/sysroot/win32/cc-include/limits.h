/* limits.h —— 只给 `--cc msvc` 这条腿用的那一份（同 float.h 的理由）。 */
#ifndef __OMNI_MSVC_LIMITS_H
#define __OMNI_MSVC_LIMITS_H

#define CHAR_BIT 8
#define SCHAR_MIN (-128)
#define SCHAR_MAX 127
#define UCHAR_MAX 255
/* Windows 上 char 是有符号的。 */
#define CHAR_MIN SCHAR_MIN
#define CHAR_MAX SCHAR_MAX

#define SHRT_MIN (-32768)
#define SHRT_MAX 32767
#define USHRT_MAX 65535

#define INT_MIN (-2147483647 - 1)
#define INT_MAX 2147483647
#define UINT_MAX 4294967295U

/* LLP64：long 是 32 位（这一条与 Linux/macOS 不同，LLP64 的坑就在这儿）。 */
#define LONG_MIN (-2147483647L - 1)
#define LONG_MAX 2147483647L
#define ULONG_MAX 4294967295UL

#define LLONG_MIN (-9223372036854775807LL - 1)
#define LLONG_MAX 9223372036854775807LL
#define ULLONG_MAX 18446744073709551615ULL

#define MB_LEN_MAX 5

#endif /* __OMNI_MSVC_LIMITS_H */
