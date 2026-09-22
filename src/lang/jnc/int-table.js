// src/lang/jnc/int-table.js —— **搬走了**：整数那一族的家在 `src/lang/common/int.js`
//
// 里头**没有一条是 jancy 自己的规矩**：整型提升、常用算术转换、"算完就掩"、无符号读法，
// 这些是 C 系语言的共性 —— C 前端那一侧同样在做（`frontend-c/ctype.js` 的 `VT_*` 位与
// `cconst.js` 的 `asIntN`）。所以它搬到公共那一层（ADR-0031 轴 B），这儿只留一格转口，
// 免得一次改动动到十几个 import。
//
// 等方言长出**带宽度的整数**（ADR-0031 §8.1）之后，`wrapTo` 那一串掩码会塌成一格
// `trunc` / `sext`，塌的时候只改公共那一份 —— 两门语言一起跟着变。
//
// **转口要一格一格写**（不是 `export * from …`）：我们自己那个 JS 前端不收 `export *`
// （`frontend-js/link.js`：整棵 import 树拼成一个程序，星号那种"名字表要到运行期才知道"
// 落不下来），写了的后果是 `tests/mir/run.js` 那格"编译器自己也要降得下来"当场红
// —— 而且报的是下游那句莫名其妙的 "does not export 'intConvCode'"。
import {
  wrapTo, wrapVal, U_OPS, uOp, realOf, arithType, commonInt, intConvCode,
  OVERFLOWS, intBinary, intUnary,
} from '../../core/lower/int.js';

export {
  wrapTo, wrapVal, U_OPS, uOp, realOf, arithType, commonInt, intConvCode,
  OVERFLOWS, intBinary, intUnary,
};
