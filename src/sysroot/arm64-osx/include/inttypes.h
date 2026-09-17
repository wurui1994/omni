/* `<inttypes.h>` —— arm64-osx 的那一份（交叉编译用）。
 * macOS 的 LP64 里 `int64_t` 是 `long long`，于是格式串是 `lld`（Linux 上是 `ld`）。 */
#ifndef _INTTYPES_H
#define _INTTYPES_H

#include <stdint.h>

#define PRId64 "lld"
#define PRIu64 "llu"
#define PRIx64 "llx"
#define PRId32 "d"
#define PRIu32 "u"
#define PRIx32 "x"

#endif
