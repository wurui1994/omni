/* Mach-O 的读入与**把几个 .o 并成一个** —— ADR-0017 第 11 步，第九刀第十一片；
 * 第十七片起两种架构都认。
 *
 * 到第十片为止我们只会**写** `.o`，写完交给 clang。这一片开始自己**读**：
 * 一个能读回自己写出去的东西的读入器，本身就是写出器的一道对账（写错的字段，读的时候
 * 对不上）。然后是链接器的第一件事 —— 几个目标文件并成一个，把**够得着的**重定位当场
 * 填掉，填不了的原样转出去。
 *
 * 为什么这一片不出可执行文件
 * --------------------------
 * 因为有一格是**算不出来**的。arm64 这边 `adrp` 要的是「目标所在的页」减「PC 所在的页」，
 * 而页号取决于最终的**绝对地址**；x86_64 这边 RIP 相对要的是「数据与代码的距离」，
 * 而最终链接会把各个文件的 `__text` 与 `__data` 分别拼到一起，那个距离也会变。
 * 所以两边的「取数据的地址」这一类重定位都只能原样转出去。
 *
 * 能填的是**同一节内的相对跳转**：两头都在合并后的 `__text` 里，差值就定下来了 ——
 * 也正是 `ld -r` 会填的那些。arm64 是 `BRANCH26`（26 位、单位 4 字节、从本条开头算），
 * x86_64 是 `BRANCH`（四字节、从**下一条**开头算）。
 *
 * 于是这一片的形状是诚实的：读、并、填得了的填掉、填不了的记着。可执行文件是后面的事
 * （dyld 那一整摊、代码签名，与「指令对不对」无关，见 `macho.js` 头上那段）。
 */

import { OmniError } from '../source/diag.js';
import { RELOC } from '../arm64/asm.js';
import { RELOC as XRELOC } from '../x64/asm.js';

const MH_MAGIC_64 = 0xfeedfacf;
const MH_OBJECT = 1;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_X86_64 = 0x01000007;
const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x02;

const N_TYPE = 0x0e;   // n_type 里「是哪一类」的那三位
const N_SECT = 0x0e;

const ARM64_RELOC_BRANCH26 = 2;
const ARM64_RELOC_PAGE21 = 3;
const ARM64_RELOC_PAGEOFF12 = 4;

const X86_64_RELOC_UNSIGNED = 0;
const X86_64_RELOC_SIGNED = 1;
const X86_64_RELOC_BRANCH = 2;

/**
 * 文件里的重定位类型 -> 我们这一侧的名字。写出那一头的表反过来，**分架构** ——
 * 两族的类型号同号不同义（`2` 在 arm64 是 `BRANCH26`、在 x86_64 是 `BRANCH`），
 * 所以读之前必须先认 cputype。按错的表往下读会得到一个「看上去合理」的结果，
 * 那种错最难查。
 */
const KIND_OF_TYPE = {
  arm64: {
    [ARM64_RELOC_BRANCH26]: RELOC.BRANCH26,
    [ARM64_RELOC_PAGE21]: RELOC.PAGE21,
    [ARM64_RELOC_PAGEOFF12]: RELOC.PAGEOFF12,
  },
  x86_64: {
    [X86_64_RELOC_UNSIGNED]: XRELOC.UNSIGNED,
    [X86_64_RELOC_SIGNED]: XRELOC.SIGNED,
    [X86_64_RELOC_BRANCH]: XRELOC.BRANCH,
  },
};

/** cputype -> 架构名。 */
const ARCH_OF_CPU = {};
ARCH_OF_CPU[CPU_TYPE_ARM64] = 'arm64';
ARCH_OF_CPU[CPU_TYPE_X86_64] = 'x86_64';

/** 读字节。位域一律用除法与取模拆 —— 32 位的最高位用 `>>` 会拆出负数。 */
class Rd {
  constructor(bytes) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(at) { return this.dv.getUint8(at); }
  u16(at) { return this.dv.getUint16(at, true); }
  u32(at) { return this.dv.getUint32(at, true); }
  i32(at) { return this.dv.getInt32(at, true); }
  u64(at) { return Number(this.dv.getBigUint64(at, true)); }

  /** 定长名字格：到第一个 0 为止。 */
  name16(at) {
    let s = '';
    for (let i = 0; i < 16; i++) {
      const c = this.u8(at + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /** 字符串表里的一条：从 `at` 到 0 字节。 */
  cstr(at) {
    let s = '';
    for (let i = at; i < this.b.length; i++) {
      if (this.b[i] === 0) break;
      s += String.fromCharCode(this.b[i]);
    }
    return s;
  }
}

/** Mach-O 的名字带一条下划线前缀，这一层把它脱掉（我们内部一律不带）。 */
function plainName(s) {
  if (s.length === 0 || s.charAt(0) !== '_') {
    throw new OmniError(`macho: 符号名 '${s}' 没有下划线前缀，还不认这种`);
  }
  return s.slice(1);
}

/**
 * 读一个 arm64 的 `MH_OBJECT`。
 *
 * 回来的形状与 `writeObject` 的入参**一样**（`text`/`data`/`defs`/`relocs`），
 * 于是「读回来再写出去，字节不变」是一条能直接验的性质。
 */
export function readObject(bytes) {
  const r = new Rd(bytes);
  if (r.u32(0) !== MH_MAGIC_64) throw new OmniError('macho: 不是 64 位的 Mach-O');
  if (r.u32(12) !== MH_OBJECT) throw new OmniError('macho: 只读 MH_OBJECT（.o）');
  /* 重定位的类型号是**分架构**的（`ARM64_RELOC_*` 与 `X86_64_RELOC_*` 同号不同义），
   * 所以先认架构 —— 按错的表往下读会得到一个「看上去合理」的结果。 */
  const arch = ARCH_OF_CPU[r.u32(4)];
  if (arch === undefined) throw new OmniError(`link: 还不认识 cputype ${r.u32(4)}`);
  const kinds = KIND_OF_TYPE[arch];
  const ncmds = r.u32(16);

  /** 节按文件里的次序排，`n_sect` 是**从 1 起**的下标。 */
  const sects = [];
  let symtab = null;
  let at = 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = r.u32(at);
    const size = r.u32(at + 4);
    if (size < 8) throw new OmniError('macho: 载入命令的长度是 0，文件坏了');
    if (cmd === LC_SEGMENT_64) {
      const nsects = r.u32(at + 64);
      let s = at + 72;
      for (let k = 0; k < nsects; k++) {
        sects.push({
          sectname: r.name16(s),
          segname: r.name16(s + 16),
          addr: r.u64(s + 32),
          size: r.u64(s + 40),
          offset: r.u32(s + 48),
          reloff: r.u32(s + 56),
          nreloc: r.u32(s + 60),
        });
        s += 80;
      }
    } else if (cmd === LC_SYMTAB) {
      symtab = { symoff: r.u32(at + 8), nsyms: r.u32(at + 12), stroff: r.u32(at + 16) };
    }
    at += size;
  }
  if (symtab === null) throw new OmniError('macho: 没有 LC_SYMTAB');

  const sectBy = (name) => sects.find((s) => s.sectname === name);
  const grab = (s) => (s === undefined ? new Uint8Array(0)
    : bytes.subarray(s.offset, s.offset + s.size));
  const text = grab(sectBy('__text'));
  const data = grab(sectBy('__data'));

  /* 符号。定义的那些换算回**节内偏移**（`n_value` 是段里的地址，见 `writeObject`），
   * 未定义的只记名字 —— 它们是重定位的目标，不是这个文件的内容。 */
  const defs = [];
  const symNames = [];
  for (let i = 0; i < symtab.nsyms; i++) {
    const p = symtab.symoff + i * 16;
    const name = plainName(r.cstr(symtab.stroff + r.u32(p)));
    const type = r.u8(p + 4);
    const sect = r.u8(p + 5);
    const value = r.u64(p + 8);
    symNames.push(name);
    if ((type & N_TYPE) !== N_SECT) continue;
    const s = sects[sect - 1];
    if (s === undefined) throw new OmniError(`macho: 符号 ${name} 说它在第 ${sect} 节，没这一节`);
    defs.push({ name, off: value - s.addr, sect });
  }

  /* 重定位只读代码节的。数据节里也可能有（第二十八片：初值里的地址）—— 那种我们自己的
   * 链接器还不会填，所以**明着报**而不是悄悄漏掉：漏掉的结果是一个指着 0 的指针。 */
  const relocs = [];
  const ds = sectBy('__data');
  if (ds !== undefined && ds.nreloc !== 0) {
    throw new OmniError(`macho: 数据节里有 ${ds.nreloc} 条重定位，这一层还不会读回它们`);
  }
  const ts = sectBy('__text');
  if (ts !== undefined) {
    for (let i = 0; i < ts.nreloc; i++) {
      const p = ts.reloff + i * 8;
      const site = r.i32(p);
      const w = r.u32(p + 4);
      const symnum = w % 2 ** 24;
      const ext = Math.floor(w / 2 ** 27) % 2;
      const type = Math.floor(w / 2 ** 28);
      if (ext !== 1) throw new OmniError('macho: 还不认按节的重定位（r_extern=0）');
      const kind = kinds[type];
      if (kind === undefined) throw new OmniError(`macho: ${arch} 还不认重定位类型 ${type}`);
      const sym = symNames[symnum];
      if (sym === undefined) throw new OmniError(`macho: 重定位指着第 ${symnum} 条符号，没这条`);
      relocs.push({ at: site, kind, sym });
    }
  }
  return { arch, text, data, defs, relocs };
}

function align(n, to) {
  return n % to === 0 ? n : n + (to - (n % to));
}

/** 一条 `bl`/`b` 的低 26 位换成新的偏移。高六位（是 `bl` 还是 `b`）原样留着。 */
function patchBranch26(text, site, delta) {
  if (delta % 4 !== 0) throw new OmniError(`link: 跳转的偏移 ${delta} 不是 4 的倍数`);
  const imm = delta / 4;
  if (imm < -(2 ** 25) || imm >= 2 ** 25) {
    throw new OmniError(`link: 跳转的偏移 ${delta} 超过 ±128MB`);
  }
  const dv = new DataView(text.buffer, text.byteOffset, text.byteLength);
  const w = dv.getUint32(site, true);
  const top = Math.floor(w / 2 ** 26);
  const imm26 = imm < 0 ? imm + 2 ** 26 : imm;
  dv.setUint32(site, (top * 2 ** 26 + imm26) >>> 0, true);
}

/**
 * x86_64 的 `call`/`jmp`：把四个字节换成新的偏移。
 *
 * 偏移是从**下一条指令**算起的，而 `site` 指着那四个字节 —— 四字节偏移格总在指令的
 * 最后，所以「下一条」就是 `site + 4`。这一格与 arm64 差一个「本条指令的长度」，
 * 记错的话跳到的地方**照样是合法指令**，只是跑错。
 */
function patchRel32(text, site, target) {
  const delta = target - (site + 4);
  if (delta < -(2 ** 31) || delta >= 2 ** 31) {
    throw new OmniError(`link: 跳转的偏移 ${delta} 超过 ±2GB`);
  }
  const dv = new DataView(text.buffer, text.byteOffset, text.byteLength);
  dv.setInt32(site, delta, true);
}

/**
 * 几个目标文件并成一个。
 *
 * @param objs `readObject` 出来的那种（`{arch, text, data, defs, relocs}`）
 * @returns `{arch, text, data, defs, relocs, filled}` —— `filled` 是当场填掉的条数
 *
 * 规矩：
 *  - 所有文件的架构必须一样（混着并出来的东西没有意义）；
 *  - `__text` 按 4 拼、`__data` 按 8 拼，符号的偏移跟着挪；
 *  - 同一个名字被定义两次**直接报错**（`ld` 说 duplicate symbol，我们也说）；
 *  - **同一节内的相对跳转**指着已经并进来的符号就当场填掉，别的原样转出去。
 */
export function linkObjects(objs) {
  if (objs.length === 0) throw new OmniError('link: 没有文件可并');
  const arch = objs[0].arch;
  for (const o of objs) {
    if (o.arch !== arch) throw new OmniError(`link: ${arch} 与 ${o.arch} 不能并在一起`);
  }
  const textParts = [];
  const dataParts = [];
  let textLen = 0;
  let dataLen = 0;
  const defs = [];
  const defAt = new Map();
  const shifted = [];   // [{relocs, textBase}]

  for (const o of objs) {
    /* 每个文件的代码从一个 4 的边界起 —— arm64 的指令必须对齐，x86 的不必但也无害。 */
    textLen = align(textLen, 4);
    while (textParts.length < textLen) textParts.push(0);
    const textBase = textLen;
    for (const byte of o.text) textParts.push(byte);
    textLen += o.text.length;

    dataLen = align(dataLen, 8);
    while (dataParts.length < dataLen) dataParts.push(0);
    const dataBase = dataLen;
    for (const byte of o.data) dataParts.push(byte);
    dataLen += o.data.length;

    for (const d of o.defs) {
      if (defAt.has(d.name)) throw new OmniError(`link: 符号 ${d.name} 定义了两次`);
      const off = d.off + (d.sect === 1 ? textBase : dataBase);
      defAt.set(d.name, { sect: d.sect, off });
      defs.push({ name: d.name, off, sect: d.sect });
    }
    shifted.push({ relocs: o.relocs, textBase });
  }

  const text = new Uint8Array(textParts);
  /** 这一族是「同一节内的相对跳转」—— 各架构一条。 */
  const BRANCH = arch === 'arm64' ? RELOC.BRANCH26 : XRELOC.BRANCH;
  const relocs = [];
  let filled = 0;
  for (const part of shifted) {
    for (const rl of part.relocs) {
      const site = rl.at + part.textBase;
      const hit = defAt.get(rl.sym);
      /* 够得着的只有「同在 `__text` 里的相对跳转」。取数据地址的那几种要等最终地址
       * （arm64 的 `PAGE21` 要页号、x86_64 的 `SIGNED` 要代码与数据的距离），原样转出去。 */
      if (rl.kind === BRANCH && hit !== undefined && hit.sect === 1) {
        if (arch === 'arm64') patchBranch26(text, site, hit.off - site);
        else patchRel32(text, site, hit.off);
        filled++;
        continue;
      }
      relocs.push({ at: site, kind: rl.kind, sym: rl.sym });
    }
  }
  return { arch, text, data: new Uint8Array(dataParts), defs, relocs, filled };
}
