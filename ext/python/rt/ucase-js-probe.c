/* ext/python/rt/ucase-js-probe.c —— 同一份探针，走**一份翻译单元**（给 JS 那条腿）
 *
 * `c run-js` 那条路是 C -> MIR -> JS，中间**没有链接器** —— 一份翻译单元就是全部。
 * 所以把借来的那份表 `#include` 进来（参考树只读，include 就是读），
 * 逻辑一个字不重复，全在 `ucase-probe.c` 里。
 */
#include "Python.h"
#include "Objects/unicodectype.c"
#include "ucase-probe.c"
