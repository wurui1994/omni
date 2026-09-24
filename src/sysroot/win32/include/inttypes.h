/* `<inttypes.h>` —— win32 的那一份（两个 arch 共用）（交叉编译用；形状沿用 Linux 那一套，见 ../README.md）。
 * 只有那几个打印宏；类型从 `<stdint.h>` 来。 */
#ifndef _INTTYPES_H
#define _INTTYPES_H

#include <stdint.h>

#define PRId64 "ld"
#define PRIu64 "lu"
#define PRIx64 "lx"
#define PRId32 "d"
#define PRIu32 "u"
#define PRIx32 "x"

#endif
