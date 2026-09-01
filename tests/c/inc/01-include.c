/* `#include` 的搜索顺序与守卫。这一份与 tcc 比时多给一个 `-I tests/c/inc/include`。 */

/* `"..."` 先看**当前文件所在的目录** */
#include "local.h"

/* `<...>` 只看 -I 给的目录 */
#include <viaflag.h>

/* 同一份头引两次：靠 `#ifndef` 守卫，第二次整份跳过（tcc 连文件都不打开） */
#include "guarded.h"
#include "guarded.h"

/* `#pragma once` 那一路 */
#include "onced.h"
#include "onced.h"

/* 嵌套：被引的头里再引，相对路径按**那个头**所在的目录算 */
#include "nested/outer.h"

/* 引进来的宏在这里生效 */
int a = LOCAL_VALUE;
int b = VIAFLAG_VALUE;
int c = GUARD_VALUE;
int d = ONCE_VALUE;
int e = INNER_VALUE + OUTER_VALUE;

/* 守卫名被 #undef 掉之后，同一份头会被真的再读一遍 */
#undef GUARDED_H
#include "guarded.h"
int f = GUARD_VALUE;

/* 「算出来的 include」：宏展开之后拼成 <...> */
#define WHICH <viaflag.h>
#include WHICH
int g = VIAFLAG_VALUE;

/* 引一份里面有条件编译的头 */
#define WANT_EXTRA 1
#include "conditional.h"
int h = COND_VALUE;
