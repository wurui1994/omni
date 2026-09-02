/* x86_64 的指令缓冲 —— ADR-0017 第 11 步，第九刀第十四片。
 *
 * 与 arm64 那一侧（`../arm64/asm.js`）同一件事：攒字节、记标签、回填跳转、
 * 给链接器记账。差别只有一件，但它决定了整个文件的形状 ——
 *
 * **x86 的指令是变长的，而回填要求「这一条占几个字节」在跳过去之前就定下来。**
 *
 * 于是这一层的规矩是：**相对跳转一律发四字节偏移的那个形式**，哪怕跳三个字节远。
 * 汇编器可以两遍过、可以先假设短形式再放大（llvm 的 relaxation 就是那样），
 * 但那要么把「一条指令多长」变成回填的函数、要么留空洞补 `nop`，两样都比多三个字节贵。
 * 一遍过、不回头，与 tcc 同一个口径（`tccgen.c` 的 `gjmp` 也是直接发四字节）。
 *
 * 另一件与 arm64 不同的：x86 的 PC 相对偏移是从**下一条指令的开头**算起的。
 * 所以每个回填点都记两个数：`at`（那四个字节在哪）与 `end`（本条指令的末尾）。
 * 少记 `end` 的话偏移会差一条指令的长度 —— 而那种错在「刚好跳到另一条指令的开头」时
 * 不会崩，只会跑错。
 */

import { OmniError } from '../source/diag.js';
import * as x from './encode.js';

/**
 * 要等链接器填的那几种。名字与值照 `<mach-o/reloc.h>` 的 x86_64 那一族：
 *  - `BRANCH`：`call`/`jmp` 的四字节相对偏移（`X86_64_RELOC_BRANCH = 2`）；
 *  - `SIGNED`：RIP 相对的取址与访存（`X86_64_RELOC_SIGNED = 1`）。
 *
 * 这一层只**记账**，不填 —— 填是链接器的事（arm64 那边同一条）。
 */
export const RELOC = { BRANCH: 'X86_64_RELOC_BRANCH', SIGNED: 'X86_64_RELOC_SIGNED' };

export class CodeBuf {
  constructor() {
    /** 攒起来的字节。 */
    this.buf = [];
    /** 标签的落点（`undefined` 表示还没落）。 */
    this.labels = [];
    /** 等回填的跳转：`{at, end, label}`。 */
    this.fixups = [];
    /** 等链接器填的：`{at, kind, sym}`。 */
    this.relocs = [];
  }

  get pos() { return this.buf.length; }

  /** 塞一串字节（编码器出来的那种数组）。 */
  emit(...parts) {
    for (const p of parts) {
      for (const b of p) {
        if (!Number.isInteger(b) || b < 0 || b > 255) {
          throw new OmniError(`x64: ${b} 不是一个字节`);
        }
        this.buf.push(b);
      }
    }
    return this;
  }

  label() {
    this.labels.push(undefined);
    return this.labels.length - 1;
  }

  chkLabel(l) {
    if (!Number.isInteger(l) || l < 0 || l >= this.labels.length) {
      throw new OmniError(`x64: 没有 ${l} 号标签`);
    }
  }

  place(l) {
    this.chkLabel(l);
    if (this.labels[l] !== undefined) throw new OmniError(`x64: ${l} 号标签落了两次`);
    this.labels[l] = this.pos;
    return this;
  }

  /**
   * 发一条「到标签」的指令。`make(rel)` 是编码器（`jmpRel`/`jccRel`/`callRel`），
   * 传 0 先发一遍占位 —— 于是「这一条多长」当场就知道了，四字节偏移的位置也就定了。
   *
   * 标签已经落过就直接算；没落过就记一笔，`finish` 时回填。回填**再调一遍编码器**，
   * 所以超出四字节能表示的范围会在那时炸，而不是被悄悄截断（arm64 那边同一个做法）。
   */
  toLabel(l, make) {
    this.chkLabel(l);
    const start = this.pos;
    const bytes = make(0);
    this.emit(bytes);
    const end = this.pos;
    /* 四字节的偏移格在这条指令的**最后四个字节**上 —— `E9`/`0F 8x`/`E8` 三种都是。 */
    const at = end - 4;
    const target = this.labels[l];
    if (target !== undefined) return this.patch(at, end, make, target);
    this.fixups.push({ at, end, label: l, make, start });
    return this;
  }

  /** 把 `target` 换算成偏移写进那四个字节。 */
  patch(at, end, make, target) {
    const bytes = make(target - end);
    /* 重发一遍，只取最后四个字节 —— 前面的操作码不会因为偏移变了而变（都是四字节形式）。 */
    for (let i = 0; i < 4; i++) this.buf[at + i] = bytes[bytes.length - 4 + i];
    return this;
  }

  jmp(l) { return this.toLabel(l, (rel) => x.jmpRel(rel)); }
  jcc(cc, l) { return this.toLabel(l, (rel) => x.jccRel(cc, rel)); }
  call(l) { return this.toLabel(l, (rel) => x.callRel(rel)); }

  /**
   * `call <符号>`。偏移留 0，记一笔 `BRANCH`。
   *
   * 留 0 而不是留一个自跳的偏移：x86 的 `call rel32 = 0` 就是「调下一条指令」——
   * 链接器没填的话会一路往下执行，而那种症状比 arm64 的自死循环难认。
   * 所以这里靠**记账**保证，不靠字节的形状 —— `writeObject` 那一头会把没登记的符号报出来。
   */
  callSym(name) {
    const bytes = x.callRel(0);
    this.emit(bytes);
    this.relocs.push({ at: this.pos - 4, kind: RELOC.BRANCH, sym: name });
    return this;
  }

  /** `jmp <符号>`（尾调用用得上）。 */
  jmpSym(name) {
    this.emit(x.jmpRel(0));
    this.relocs.push({ at: this.pos - 4, kind: RELOC.BRANCH, sym: name });
    return this;
  }

  /** `lea reg, [rip + <符号>]` —— x86_64 上取一个全局地址的那一条。 */
  leaSym(reg, name) {
    this.emit(x.leaRip(8, reg, 0));
    this.relocs.push({ at: this.pos - 4, kind: RELOC.SIGNED, sym: name });
    return this;
  }

  /** `mov reg, [rip + <符号>]`：直接读一个全局，不先取址。 */
  loadSym(size, reg, name) {
    this.emit(x.movRRip(size, reg, 0));
    this.relocs.push({ at: this.pos - 4, kind: RELOC.SIGNED, sym: name });
    return this;
  }

  /** `mov [rip + <符号>], reg`。 */
  storeSym(size, name, reg) {
    this.emit(x.movRipR(size, 0, reg));
    this.relocs.push({ at: this.pos - 4, kind: RELOC.SIGNED, sym: name });
    return this;
  }

  /** 回填所有等着的跳转。有标签没落地就报错 —— 那是上一层漏了 `place`。 */
  finish() {
    for (const f of this.fixups) {
      const target = this.labels[f.label];
      if (target === undefined) throw new OmniError(`x64: ${f.label} 号标签从没落地`);
      this.patch(f.at, f.end, f.make, target);
    }
    this.fixups = [];
    return this;
  }

  bytes() {
    if (this.fixups.length !== 0) throw new OmniError('x64: 还有没回填的跳转，先 finish');
    return new Uint8Array(this.buf);
  }
}
