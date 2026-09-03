/**
 * 「按声明的次序摆一节」（第九刀第一百二十五片起的只读节，第一百三十一片起的 `.data`）。
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
 *
 * `.data` 也是同一个游标（第一百三十一片）：从前两个后端是照 MIR 的**全局号**一块接
 * 一块推的，平时看不出差别 —— 全局号一般就是声明的次序。露出来要有「先被提到、后被
 * 定义」的东西，量过：
 *
 * ```c
 * char *n = "z";   int *p = L"ab";   int m = sizeof(*p);
 * ```
 *
 * `sizeof(*p)` 借表达式那一路解析，于是 `p` 先领到全局号 —— tcc 是 `n`@0 `p`@8 `m`@16，
 * 我们从前是 `p`@0 `n`@8 `m`@16。摆字节的依据得是**领字节的次序**，不是号。
 */

import { hexBytes } from './ir.js';
import { utf8Bytes } from '../host/utf8.js';

/**
 * 一串「要几个字节、按几对齐、第几个领到」的东西 -> 每一样的落点。
 *
 * 稳定排序（JS 的 `sort` 是稳定的）：没有号的当 `Infinity`，于是它们保持进来的次序 ——
 * 这一格对别的前端（手搭的 MIR）是零改动。
 *
 * 回的 `al` 是**这一节自己的对齐**（第一百三十二片量到的）：tcc 的 `sh_addralign` 是
 * 「里头对齐要求最大的那一块」，下界 8 —— 量过 x86_64-linux 上
 * `struct a7 g7[2] __attribute__((aligned(16)));  int g32 __attribute__((aligned(32))) = 9;`：
 * `.bss` 的 `sh_addralign` 是 16、`.data` 是 32。从前两个写出器都写死 8，那只是先前
 * 每个探针里最大的对齐正好都是 8 —— 少了这一格，`g7` 的地址低四位就不是 0。
 */
function layout(items) {
  items.sort((x, y) => (x.seq ?? Infinity) - (y.seq ?? Infinity));
  const gOff = new Map();
  const sOff = new Map();
  let at = 0;
  let al = 8;
  for (const it of items) {
    while (at % it.al !== 0) at++;
    (it.str ? sOff : gOff).set(it.no, at);
    at += it.size;
    if (it.al > al) al = it.al;
  }
  return { size: at, al, gOff, sOff };
}

/** 一块全局量占几个字节、按几对齐（没有 blob 的是「试探性定义」，八字节八对齐）。 */
function globalItem(mod, gi) {
  const blob = mod.globalBlob[gi];
  return {
    str: false,
    no: gi,
    seq: mod.globalSeq[gi],
    al: blob === null ? 8 : blob.align,
    size: blob === null ? 8 : blob.size,
  };
}

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
    items.push(globalItem(mod, gi));
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
  return layout(items);
}

/**
 * 可写那一节（`.data` / Mach-O 的 `__data`）要多少字节，以及每一块落在哪儿。
 * 只有 `gOff` 有内容 —— 串常量一律进只读节。
 *
 * 没有初始化式的那些不在这儿（第一百三十二片）：它们进 `.bss`，见 `planBss`。
 */
export function planData(mod) {
  const items = [];
  for (let gi = 0; gi < mod.globals.length; gi++) {
    if (mod.globalRo[gi] === true) continue;
    if (mod.globalBss[gi] === true) continue;
    const blob = mod.globalBlob[gi];
    if (blob !== null && blob.extern) continue;
    items.push(globalItem(mod, gi));
  }
  return layout(items);
}

/**
 * `.bss` 那一节（第一百三十二片）：源码里**没有那个 `=`** 的全局量。
 *
 * 与 `.data` 是**两个各自独立的游标**，都按声明的次序 —— 量过 tcc（x86_64-linux）：
 * `int a; int b = 0; int c = 5; static int d; static int e = 0;` 出来是
 * `.bss` `a@0 d@4`、`.data` `b@0 c@4 e@8`。函数体里的 `static` 也在同一根轴上。
 *
 * 只有 `gOff` 有内容，而且这一节**在文件里不占字节**（ELF 的 NOBITS）—— 回的
 * `size` 是它的 `sh_size`。
 */
export function planBss(mod) {
  const items = [];
  for (let gi = 0; gi < mod.globals.length; gi++) {
    if (mod.globalBss[gi] !== true) continue;
    if (mod.globalRo[gi] === true) continue;
    const blob = mod.globalBlob[gi];
    if (blob !== null && blob.extern) continue;
    items.push(globalItem(mod, gi));
  }
  return layout(items);
}

