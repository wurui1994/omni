/* arm64 指令缓冲 —— ADR-0017 第 9 步，第九刀第三片。
 *
 * `encode.js` 只把「字段」变成「字」，它不知道标签在哪。这一层管的正是那件事：
 * 一边往下发指令，一边收「往前跳」的欠账（fixup），标签落地时把欠账补上。
 *
 * 为什么必须有这一层
 * ------------------
 * `if (x) { ... }` 编出来的第一条是 `b.eq <还不知道在哪>`。一遍过的代码生成器
 * （我们与 tcc 都是一遍过）在发这条指令时，目标地址还没生出来。tcc 的做法是把
 * 待填的地址串成一条链表（`gjmp`/`gsym` 那一对）；我们记一张 fixup 表，效果一样，
 * 但**回填时重新调一次编码函数**而不是去或那几位 —— 这样偏移越界会在回填那一刻
 * 从 `encode.js` 里抛出来，不会悄悄截断成一条跳错地方的指令。
 *
 * 符号（`bl _printf`、`adrp _msg@PAGE`）在这一层只**记账**、字里留 0，等第 11 步
 * 的链接器来填。记的就是 Mach-O/ELF 认得的那几种重定位。
 */

import { OmniError } from '../source/diag.js';
import * as e from './encode.js';

/** 重定位的种类。名字照 Mach-O 的 `ARM64_RELOC_*`（ELF 那边一一对得上）。 */
export const RELOC_ARM64 = {
  /** `bl`/`b` 到一个符号：26 位、单位 4 字节。 */
  BRANCH26: 'BRANCH26',
  /** `adrp` 取符号所在页：21 位、单位 4096。 */
  PAGE21: 'PAGE21',
  /** `add`/`ldr` 取符号在页内的偏移：12 位。 */
  PAGEOFF12: 'PAGEOFF12',
  /**
   * 过 GOT 取一个符号的地址（第九刀第三十一片）。**外部的数据符号只有这一条路**：
   * 它可能住在一个 dylib 里，链接期没有「它的页」可谈，直接 `adrp` 会被链接器骂
   * `target does not have address`。形状是
   * `adrp Rd, sym@GOTPAGE` + `ldr Rd, [Rd, sym@GOTPAGEOFF]` ——
   * 多一次内存读，换来「真地址由加载器填进 GOT 那一格」。
   */
  GOT_PAGE21: 'GOT_PAGE21',
  GOT_PAGEOFF12: 'GOT_PAGEOFF12',
  /** 数据里的一个 8 字节绝对地址。 */
  ABS64: 'ABS64',
};

export class Arm64CodeBuf {
  constructor() {
    /** 已发的字，按顺序。@type {number[]} */
    this.words = [];
    /** 标签的字节位置；`undefined` 表示还没落地。@type {(number|undefined)[]} */
    this.labels = [];
    /** 待回填：`{ at, label, make }`，`at` 是**字**的下标。 */
    this.fixups = [];
    /** 重定位：`{ at, kind, sym, addend }`，`at` 是**字节**位置。 */
    this.relocs = [];
  }

  /** 下一条指令的字节位置。 */
  get pos() {
    return this.words.length * 4;
  }

  /** 发一条已经编好的指令。 */
  word(w) {
    if (!Number.isInteger(w) || w < 0 || w > 0xffffffff) {
      throw new OmniError(`arm64: ${w} 不是一个 32 位的指令字`);
    }
    this.words.push(w);
    return this;
  }

  /** 发一串。方便 `buf.emit(a.movz(1, 0, 5), a.ret())` 这种写法。 */
  emit(...ws) {
    for (const w of ws) this.word(w);
    return this;
  }

  /** 要一个新标签（还没有位置）。 */
  label() {
    this.labels.push(undefined);
    return this.labels.length - 1;
  }

  /** 把标签钉在当前位置。 */
  place(l) {
    this.chkLabel(l);
    if (this.labels[l] !== undefined) {
      throw new OmniError(`arm64: 标签 ${l} 已经在 ${this.labels[l]} 落过了`);
    }
    this.labels[l] = this.pos;
    return this;
  }

  chkLabel(l) {
    if (!Number.isInteger(l) || l < 0 || l >= this.labels.length) {
      throw new OmniError(`arm64: 没有标签 ${l}`);
    }
  }

  /* ---------------------------------------------------------------- 跳到标签
   * 往后跳（标签已落地）当场算得出来；往前跳先占个位、记一笔账。
   * 两条路都走同一个 `make(off)` —— 偏移是「目标 - 这条指令自己」。 */

  toLabel(l, make) {
    this.chkLabel(l);
    const at = this.words.length;
    const here = this.pos;
    const target = this.labels[l];
    if (target !== undefined) return this.word(make(target - here));
    this.words.push(0);
    this.fixups.push({ at, label: l, make });
    return this;
  }

  b(l) { return this.toLabel(l, (off) => e.b(off)); }
  bl(l) { return this.toLabel(l, (off) => e.bl(off)); }
  bcond(cond, l) { return this.toLabel(l, (off) => e.bcond(cond, off)); }
  cbz(sf, rt, l) { return this.toLabel(l, (off) => e.cbz(sf, rt, off)); }
  cbnz(sf, rt, l) { return this.toLabel(l, (off) => e.cbnz(sf, rt, off)); }
  adr(rd, l) { return this.toLabel(l, (off) => e.adr(rd, off)); }

  /* ---------------------------------------------------------------- 符号
   * 字里留 0（`bl` 的 0 偏移就是「跳到自己」，链接器不填就死循环 —— 这正是我们要的：
   * 漏填是个响的错，不是个静的错）。 */

  /** `bl <sym>`。 */
  blSym(sym, addend = 0) {
    this.relocs.push({ at: this.pos, kind: RELOC_ARM64.BRANCH26, sym, addend });
    return this.word(e.bl(0));
  }

  /** `adrp Rd, <sym>@PAGE`。 */
  adrpSym(rd, sym, addend = 0) {
    this.relocs.push({ at: this.pos, kind: RELOC_ARM64.PAGE21, sym, addend });
    return this.word(e.adrp(rd, 0));
  }

  /** `add Rd, Rn, <sym>@PAGEOFF`。 */
  addSymOff(rd, rn, sym, addend = 0) {
    this.relocs.push({ at: this.pos, kind: RELOC_ARM64.PAGEOFF12, sym, addend });
    return this.word(e.addImm(1, rd, rn, 0));
  }

  /** `ldr Rt, [Rn, <sym>@PAGEOFF]`。`size` 照 `encode.js` 的口径是宽度的对数。 */
  ldrSymOff(size, rt, rn, sym, addend = 0) {
    this.relocs.push({ at: this.pos, kind: RELOC_ARM64.PAGEOFF12, sym, addend });
    return this.word(e.ldrU(size, rt, rn, 0));
  }

  /** `adrp Rd, <sym>@GOTPAGE`（外部数据符号那一对的头一条，见 `RELOC_ARM64.GOT_PAGE21`）。 */
  adrpSymGot(rd, sym) {
    this.relocs.push({ at: this.pos, kind: RELOC_ARM64.GOT_PAGE21, sym, addend: 0 });
    return this.word(e.adrp(rd, 0));
  }

  /** `ldr Rt, [Rn, <sym>@GOTPAGEOFF]`。取出来的就是那个符号的真地址。 */
  ldrSymGot(rt, rn, sym) {
    this.relocs.push({ at: this.pos, kind: RELOC_ARM64.GOT_PAGEOFF12, sym, addend: 0 });
    return this.word(e.ldrU(3, rt, rn, 0));
  }

  /* ---------------------------------------------------------------- 收工 */

  /** 补上所有欠账。没落地的标签、跳不到的距离，都在这儿报。 */
  finish() {
    for (const f of this.fixups) {
      const target = this.labels[f.label];
      if (target === undefined) {
        throw new OmniError(`arm64: 标签 ${f.label} 从没落地，第 ${f.at} 条指令跳不过去`);
      }
      this.words[f.at] = f.make(target - f.at * 4);
    }
    this.fixups = [];
    return this;
  }

  /** 小端序的字节。调用前会先 `finish()`。 */
  bytes() {
    this.finish();
    const out = new Uint8Array(this.words.length * 4);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < this.words.length; i++) dv.setUint32(i * 4, this.words[i], true);
    return out;
  }
}
