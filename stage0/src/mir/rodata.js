/**
 * 只读那一节的排布（第九刀第一百二十五片）。
 *
 * 摆进只读节的有两样：`const` 的全局量（第一百二十二片）与串常量（第一百二十三片）。
 * 前两片是两个循环各摆一段 —— 全局量先来、串常量跟在后面。量过 tcc，那不对：
 *
 * ```c
 * const int c1 = 11;   char *a = "A";   const int c2 = 22;   char *b = "B";
 * ```
 *
 * `.data.ro` 是 `11 0 0 0 | 65 0 | 0 0 | 22 0 0 0 | 66 0`，符号 `c1`@0、`L.3`@4、
 * `c2`@8、`L.4`@12 —— **按声明的次序交替着摆**，每样按自己的对齐。tcc 那边压根没有
 * 「先摆哪一类」这回事：只读节就是一个按序推进的游标（`section_ptr_add`），谁先要
 * 字节谁先拿。带初值的 `const` 指针也照这条走 —— 量过 `const char *const q = "S"`：
 * `q`@0+8 在前、它初值里那条串 `L.3`@8 在后，因为那一块是在解析初值**之前**领的。
 *
 * 所以「谁先领到字节」得由前端记下来：`mod.globalSeq[gi]` 与 `mod.strSeq[ref]` 是
 * **同一个轴**上的号（C 前端在 `allocGlobal` 与新建一条串常量那两处各取一个）。
 * 没有号的（别的前端、手搭的 MIR）排在有号的后面，次序照旧 —— 全局量在前、串在后。
 */

import { hexBytes } from './ir.js';
import { utf8Bytes } from '../host/utf8.js';

/**
 * 只读那一节要多少字节，以及每一样落在哪儿。
 *
 * 回 `{ size, gOff, sOff }`：`gOff` 是全局号 -> 偏移，`sOff` 是常量池下标 -> 偏移。
 * 两个后端共用这一份 —— 它们摆字节的那两段循环只从这儿查落点。
 */
export function planRodata(mod) {
  const items = [];
  for (let gi = 0; gi < mod.globals.length; gi++) {
    if (mod.globalRo[gi] !== true) continue;
    const blob = mod.globalBlob[gi];
    /* 外部的全局量不占字节（第三十一片）。 */
    if (blob !== null && blob.extern) continue;
    items.push({
      str: false,
      no: gi,
      seq: mod.globalSeq[gi],
      al: blob === null ? 8 : blob.align,
      size: blob === null ? 8 : blob.size,
    });
  }
  const cs = mod.consts.items;
  for (let r = 0; r < cs.length; r++) {
    const kind = cs[r].kind;
    if (kind !== 'str' && kind !== 'bytes') continue;
    /* 每条串按**元素的宽度**对齐，结尾多一格同宽的零（第一百二十三片）。 */
    const al = mod.strAlign[r] ?? 1;
    const raw = kind === 'bytes' ? hexBytes(cs[r].text) : utf8Bytes(cs[r].text);
    items.push({ str: true, no: r, seq: mod.strSeq[r], al, size: raw.length + al });
  }
  /* 稳定排序（JS 的 `sort` 是稳定的）：没有号的当 `Infinity`，于是它们保持
   * 「全局量在前、串在后」那个旧次序 —— 这一片对别的前端是零改动。 */
  items.sort((x, y) => (x.seq ?? Infinity) - (y.seq ?? Infinity));
  const gOff = new Map();
  const sOff = new Map();
  let at = 0;
  for (const it of items) {
    while (at % it.al !== 0) at++;
    (it.str ? sOff : gOff).set(it.no, at);
    at += it.size;
  }
  return { size: at, gOff, sOff };
}
