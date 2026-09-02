/* ELF 目标文件的**并合** —— ADR-0017 第 11 步，第九刀第四十二片。
 *
 * `tcc -r a.o b.o -o m.o` 的那一步：几个 `ET_REL` 并成一个 `ET_REL`。照
 * `tccelf.c` 的 `tcc_load_object_file`（读进来、按名字接节、并符号、改重定位）
 * 与 `set_elf_sym`（符号怎么合），写出走 `elf.js` 的 `writeSections`。
 *
 * 为什么这一片值得单独做，而且能**现在就对字节**：并合的输入可以是 **tcc 自己出的
 * 目标文件**。同样的输入、同样的目标，出来的字节应当唯一 —— 于是这一步的对账
 * **不必等代码生成对齐**（`tests/c/elf-merge.js`）。它也是链接器与可执行文件写出的
 * 前半段：那两步同样是「接节、并符号、改重定位」，只是最后写出的形状不同。
 *
 * 并合的次序是**有讲究**的，一格都不能自己发明：
 *
 *  - 起手是 `tccelf_new` 造的那几条节（`.text`/`.data`/`.data.ro`/`.bss`/
 *    `.symtab`/`.strtab`，最终格式是 ELF 的目标上还有 `.eh_frame`，而且它起手就
 *    已经有一条 CIE），序号写死；
 *  - 每个目标文件按**自己节头表的次序**扫一遍，同名的接到已有的那一条后面（先按
 *    incoming 的 `sh_addralign` 补齐），没有的**当场造一条**（于是 `.rela.text`
 *    这种节的序号取决于谁先出现）；
 *  - 符号一个个过 `set_elf_sym`：局部的一律新增，非局部的按名字找 —— 找到且老的是
 *    未定义就改写老的那一条，两个都有定义就是重复定义；
 *  - 重定位表里的符号号按「老号 -> 新号」改一遍，偏移加上这一段在新节里的起点。
 *
 * 最后写出前还要**排一次符号**（`sort_syms`）：ELF 要求局部的全在前面，而并合是一个
 * 目标文件接一个目标文件地追加，b.o 的局部符号会排在 a.o 的全局符号后面。排完
 * `sh_info` 记局部的条数，重定位里的符号号再改一遍。
 */

import { OmniError } from '../source/diag.js';
import { readObject, writeSections } from './elf.js';

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_NOBITS = 8;
const SHT_NOTE = 7;
const SHT_INIT_ARRAY = 14;
const SHT_FINI_ARRAY = 15;
const SHT_PREINIT_ARRAY = 16;

const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

const SHN_UNDEF = 0;
const SHN_LORESERVE = 0xff00;
const SHN_COMMON = 0xfff2;

const STB_LOCAL = 0;
const STB_GLOBAL = 1;
const STB_WEAK = 2;

const SYM_SIZE = 24;
const RELA_SIZE = 24;

const EM_AARCH64 = 183;

/* `.eh_frame` 那一条 CIE 用到的几个 DWARF 常量（`dwarf.h` / `tccdbg.c:431`）。 */
const DW_CFA_nop = 0x00;
const DW_CFA_def_cfa = 0x0c;
const DW_CFA_offset = 0x80;
/** `DW_EH_PE_udata4 | DW_EH_PE_signed | DW_EH_PE_pcrel` */
const FDE_ENCODING = 0x1b;

function align(n, to) {
  return to <= 1 || n % to === 0 ? n : n + (to - (n % to));
}

/** 字符串表：0 号是空串。与 `elf.js` 里那一份同一个形状。 */
class StrTab {
  constructor() {
    this.bytes = [0];
    this.index = new Map([['', 0]]);
  }

  intern(s) {
    const hit = this.index.get(s);
    if (hit !== undefined) return hit;
    return this.append(s);
  }

  /** 不去重地接一条 —— `put_elf_str` 就是这样，同名的局部符号会在表里出现两次。 */
  append(s) {
    if (s === '') return 0;
    const off = this.bytes.length;
    for (let i = 0; i < s.length; i++) this.bytes.push(s.charCodeAt(i));
    this.bytes.push(0);
    if (!this.index.has(s)) this.index.set(s, off);
    return off;
  }

  out() {
    return new Uint8Array(this.bytes);
  }
}

/** 这一节的内容要不要跟着并（`tcc_load_object_file` 里那一串 `sh_type` 的筛子）。 */
function mergeable(type, name, unwind) {
  if (name.startsWith('.debug_') || name.startsWith('.stab')) return false;
  /* `.eh_frame`：节都没造的目标上（macOS、Windows）连输入里的也不要。 */
  if (name.startsWith('.eh_frame')) return unwind;
  return type === SHT_PROGBITS || type === SHT_NOTE || type === SHT_NOBITS
    || type === SHT_INIT_ARRAY || type === SHT_FINI_ARRAY || type === SHT_PREINIT_ARRAY;
}

/**
 * `.eh_frame` 起手那一条 CIE（`tccdbg.c` 的 `tcc_eh_frame_start`）。
 *
 * 这一条不是从输入里并来的，是 `tccelf_new` 造节的时候**当场写下**的 —— 于是并出来的
 * `.eh_frame` 天生比几个输入加起来长一截。少了它，字节就从 `.eh_frame` 起全错。
 */
function ehFrameCie(machine) {
  /* code_alignment_factor / 返回地址列 / CFA 寄存器与偏移；x86_64 还多记一条
   * 「返回地址在 CFA-8」（`DW_CFA_offset + 16`），arm64 那一段没有。 */
  const k = machine === EM_AARCH64
    ? { code: 4, ra: 30, cfaReg: 31, cfaOff: 0, ret: [] }
    : { code: 1, ra: 16, cfaReg: 7, cfaOff: 8, ret: [DW_CFA_offset + 16, 1] };
  const b = [
    0, 0, 0, 0,                 // 长度，末尾回填
    0, 0, 0, 0,                 // CIE ID
    1,                          // 版本
    0x7a, 0x52, 0,              // 增补串 "zR"
    k.code,                     // uleb code_alignment_factor
    0x78,                       // sleb data_alignment_factor = -8
    k.ra,                       // uleb 返回地址列
    1,                          // uleb 增补数据长度
    FDE_ENCODING,
    DW_CFA_def_cfa,
    k.cfaReg,
    k.cfaOff,
    ...k.ret,
  ];
  while (b.length % 4 !== 0) b.push(DW_CFA_nop);
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, b.length - 4, true);
  for (let i = 0; i < 4; i++) b[i] = dv.getUint8(i);
  return b;
}

/**
 * 把几个 ELF 目标文件装进**一份内存里的节表**。
 *
 * 这是 `tcc_load_object_file` 走完一圈之后 `TCCState` 的样子：节一条条接好、符号并好、
 * 重定位的符号号改好。写 `.o`（`mergeObjects`）与写可执行文件（`elf_exe.js`）都从这里
 * 接着往下走 —— 那两步的前半段本来就是同一件事，只是最后写出的形状不同。
 *
 * @param objs 每个都是一个 `ET_REL` 的字节
 * @param opts `{rdata, unwind}`：`rdata` 是只读数据那一节的名字 —— PE 目标上 tcc 叫它
 *             `.rdata`，别的目标叫 `.data.ro`（`tccelf.c` 开头那个 `#ifdef`）；`unwind`
 *             是要不要 `.eh_frame` —— tcc 只在**最终格式是 ELF** 的目标上开
 *             （`tccelf.c:93`：格式不是 ELF 就把 `unwind_tables` 清掉），于是 macOS
 *             与 Windows 上连节都没有，输入里的 `.eh_frame` 也一并丢掉
 * @returns `{machine, secs, syms, relas, strs, byName, idx, setSym, newSec}`；`secs` 是
 *          1 号起的（0 号留空），`idx` 记着起手那几条的号
 */
export function linkObjects(objs, opts) {
  if (objs.length === 0) throw new OmniError('elf: 一个目标文件都没有，没什么可并的');
  const o = opts === undefined ? {} : opts;
  const rdata = o.rdata === undefined ? '.data.ro' : o.rdata;
  const unwind = o.unwind === true;
  /* 起手那几条节要按 `tccelf_new` 的次序造，而 `.eh_frame` 的 CIE 认架构 —— 先把
   * 输入都读进来，架构就知道了。 */
  const parsed = objs.map((b) => readObject(b));
  const machine = parsed[0].machine;
  for (const p of parsed) {
    if (p.machine !== machine) throw new OmniError('elf: 这几个目标文件不是一个架构的');
  }

  /* ---- 起手那几条（`tccelf_new` 的次序，序号写死）。 */
  const secs = [null];
  const newSec = (name, type, flags, al, ent) => {
    secs.push({
      name, type, flags, al, ent, link: 0, info: 0, data: [], size: 0, relaFor: 0,
    });
    return secs.length - 1;
  };
  const TEXT = newSec('.text', SHT_PROGBITS, SHF_ALLOC | SHF_EXECINSTR, 8, 0);
  const DATA = newSec('.data', SHT_PROGBITS, SHF_ALLOC | SHF_WRITE, 8, 0);
  const RDATA = newSec(rdata, SHT_PROGBITS, SHF_ALLOC, 8, 0);
  const BSS = newSec('.bss', SHT_NOBITS, SHF_ALLOC | SHF_WRITE, 8, 0);
  const SYMTAB = newSec('.symtab', SHT_SYMTAB, 0, 8, SYM_SIZE);
  const STRTAB = newSec('.strtab', SHT_STRTAB, 0, 1, 0);
  secs[SYMTAB].link = STRTAB;
  if (unwind) {
    const eh = newSec('.eh_frame', SHT_PROGBITS, SHF_ALLOC, 8, 0);
    secs[eh].data = ehFrameCie(machine);
    secs[eh].size = secs[eh].data.length;
  }

  /* ---- 符号表。0 号是全 0 的那一条（`init_symtab`）。 */
  const strs = new StrTab();
  const syms = [{ name: '', strx: 0, value: 0, size: 0, info: 0, other: 0, shndx: SHN_UNDEF }];
  /** 非局部符号的名字 -> 号（`find_elf_sym` 那张哈希表）。局部的不进这张表。 */
  const byName = new Map();
  /** 重定位：一条一条攒着，最后按所属节写出去。 */
  const relas = new Map();          // 节号 -> [{at, sym, type, add}]

  const setSym = (s) => {
    const bind = Math.floor(s.info / 16);
    if (bind !== STB_LOCAL) {
      const hit = byName.get(s.name);
      if (hit !== undefined) {
        const old = syms[hit];
        if (old.value === s.value && old.size === s.size && old.info === s.info
          && old.other === s.other && old.shndx === s.shndx) return hit;
        if (old.shndx !== SHN_UNDEF) {
          const oldBind = Math.floor(old.info / 16);
          if (s.shndx === SHN_UNDEF) return hit;          // 老的有定义，新的没有：不管
          if (bind === STB_GLOBAL && oldBind === STB_WEAK) {
            syms[hit] = { ...old, info: s.info, shndx: s.shndx, value: s.value, size: s.size };
            return hit;
          }
          if (bind === STB_WEAK) return hit;               // 弱的让路
          const oldCommon = old.shndx === SHN_COMMON || old.shndx === BSS;
          const newCommon = s.shndx === SHN_COMMON || s.shndx === BSS;
          if (oldCommon && !newCommon && s.shndx < SHN_LORESERVE) {
            syms[hit] = { ...old, info: s.info, shndx: s.shndx, value: s.value, size: s.size };
            return hit;
          }
          if (newCommon) return hit;
          throw new OmniError(`elf: 符号 '${s.name}' 定义了两次`);
        }
        /* 老的是未定义：改写老的那一条，但 `st_name` 留着 —— tcc 只动后面几格。 */
        syms[hit] = { ...s, strx: old.strx };
        return hit;
      }
    }
    /* 名字是在**造符号的时候**进字符串表的（`put_elf_sym` 里那一句 `put_elf_str`），
     * 于是表里的次序是加符号的次序，不是最后排完的次序 —— 这一格错了字节就对不上。 */
    syms.push({ ...s, strx: strs.append(s.name) });
    const no = syms.length - 1;
    if (bind !== STB_LOCAL) byName.set(s.name, no);
    return no;
  };

  for (const obj of parsed) {
    /* `obj.secs` 是 1 号起的，这儿按 ELF 的序号（1 起）来记账。 */
    const n = obj.secs.length + 1;
    const at = (i) => obj.secs[i - 1];
    /** 老节号 -> {no（新节号）, off（这一段在新节里的起点）}。 */
    const map = new Map();
    let symtabIdx = -1;
    for (let i = 1; i < n; i++) if (at(i).type === SHT_SYMTAB) symtabIdx = i;

    /* ---- 一、按自己节头表的次序接节。`.shstrtab` 不并（每份自己重建）。 */
    for (let i = 1; i < n; i++) {
      const sh = at(i);
      if (sh.type === SHT_STRTAB && sh.name === '.shstrtab') continue;
      if (sh.type === SHT_SYMTAB) {
        map.set(i, { no: SYMTAB, off: 0 });
        continue;
      }
      if (sh.type === SHT_STRTAB) continue;               // .strtab 跟着符号一条条并
      /* 重定位表：能不能并要看**它修的那一节**（`sh = &shdr[sh->sh_info]`）。 */
      const probe = sh.type === SHT_RELA ? at(sh.info) : sh;
      if (!mergeable(probe.type, probe.name, unwind)) continue;
      const al = sh.al < 1 ? 1 : sh.al;
      let no = -1;
      for (let j = 1; j < secs.length; j++) if (secs[j].name === sh.name) { no = j; break; }
      if (no < 0) {
        no = newSec(sh.name, sh.type, sh.flags, al, sh.ent);
      }
      const s = secs[no];
      /* `section_add`：先把已有的长度补齐到 incoming 的对齐上，再接。 */
      s.size = align(s.size, al);
      while (s.data.length < s.size) s.data.push(0);
      const off = s.size;
      if (al > s.al) s.al = al;
      const sz = sh.type === SHT_NOBITS ? sh.size : sh.bytes.length;
      if (sh.type !== SHT_NOBITS) for (const b of sh.bytes) s.data.push(b);
      s.size = off + sz;
      map.set(i, { no, off });
      /* arm64/arm/riscv：代码节接完补齐到 4 —— 后面还可能接别的东西，
       * 而指令必须落在 4 的整数倍上（`tcc_load_object_file` 里那个 `#if`）。 */
      if (machine === EM_AARCH64 && (s.flags & SHF_EXECINSTR) !== 0) {
        s.size = align(s.size, 4);
        while (s.data.length < s.size) s.data.push(0);
      }
    }

    /* ---- 二、新造的节的 `sh_link` / `sh_info`。 */
    for (let i = 1; i < n; i++) {
      const m = map.get(i);
      if (m === undefined) continue;
      const sh = at(i);
      if (sh.type === SHT_RELA) {
        const tgt = map.get(sh.info);
        if (tgt === undefined) throw new OmniError(`elf: ${sh.name} 修的那一节没并进来`);
        secs[m.no].link = SYMTAB;
        secs[m.no].info = tgt.no;
        secs[m.no].relaFor = tgt.no;
      } else if (sh.link > 0 && map.has(sh.link)) {
        secs[m.no].link = map.get(sh.link).no;
      }
    }

    /* ---- 三、符号。老号 -> 新号，同时把 shndx 与 value 换到并完之后的位置上。 */
    const trans = [0];
    if (symtabIdx > 0) {
      const st = at(symtabIdx);
      const strBytes = at(st.link).bytes;
      const nameAt = (k) => {
        let e = k;
        while (e < strBytes.length && strBytes[e] !== 0) e++;
        let s = '';
        for (let p = k; p < e; p++) s += String.fromCharCode(strBytes[p]);
        return s;
      };
      const dv = new DataView(st.bytes.buffer, st.bytes.byteOffset, st.bytes.byteLength);
      const count = Math.floor(st.bytes.length / SYM_SIZE);
      for (let k = 1; k < count; k++) {
        const p = k * SYM_SIZE;
        const sym = {
          name: nameAt(dv.getUint32(p, true)),
          info: st.bytes[p + 4],
          other: st.bytes[p + 5],
          shndx: dv.getUint16(p + 6, true),
          value: Number(dv.getBigUint64(p + 8, true)),
          size: Number(dv.getBigUint64(p + 16, true)),
        };
        if (sym.shndx !== SHN_UNDEF && sym.shndx < SHN_LORESERVE) {
          const m = map.get(sym.shndx);
          if (m === undefined) {                 // 那一节没并进来，这个符号就不要
            trans.push(0);
            continue;
          }
          sym.shndx = m.no;
          sym.value += m.off;
        }
        trans.push(setSym(sym));
      }
    }

    /* ---- 四、重定位：符号号改一遍，偏移加上这一段的起点。 */
    for (let i = 1; i < n; i++) {
      const m = map.get(i);
      if (m === undefined) continue;
      const sh = at(i);
      if (sh.type !== SHT_RELA) continue;
      const base = map.get(sh.info).off;
      const dv = new DataView(sh.bytes.buffer, sh.bytes.byteOffset, sh.bytes.byteLength);
      const count = Math.floor(sh.bytes.length / RELA_SIZE);
      const list = relas.get(m.no) === undefined ? [] : relas.get(m.no);
      for (let k = 0; k < count; k++) {
        const p = k * RELA_SIZE;
        const info = dv.getBigUint64(p + 8, true);
        const oldSym = Number(info >> 32n);
        if (oldSym >= trans.length) throw new OmniError('elf: 重定位指着一个不存在的符号');
        list.push({
          at: Number(dv.getBigUint64(p, true)) + base,
          sym: trans[oldSym],
          type: Number(info & 0xffffffffn),
          add: dv.getBigInt64(p + 16, true),
        });
      }
      relas.set(m.no, list);
      secs[m.no].size = list.length * RELA_SIZE;
    }
  }

  if (machine < 0) throw new OmniError('elf: 并合之后不知道是什么架构');
  /* `.text` 一直在 1 号上（起手那几条写死），这一条是给读代码的人的锚，不参与计算。 */
  if (secs[TEXT].name !== '.text') throw new OmniError('elf: 1 号节不是 .text');
  return {
    machine,
    secs,
    syms,
    relas,
    strs,
    byName,
    setSym,
    newSec,
    idx: {
      TEXT, DATA, RDATA, BSS, SYMTAB, STRTAB,
    },
  };
}

/**
 * 几个 ELF 目标文件并成一个 `.o`（`tcc -r`）。
 *
 * @param objs 每个都是一个 `ET_REL` 的字节
 * @param opts 同 `linkObjects`
 * @returns 并出来的 `.o` 的字节
 */
export function mergeObjects(objs, opts) {
  const st = linkObjects(objs, opts);
  const {
    machine, secs, syms, relas, strs,
  } = st;
  const { SYMTAB, STRTAB } = st.idx;
  /* ---- 排符号（`sort_syms`）：局部在前、全局在后，重定位里的号跟着改。 */
  const order = [];
  for (let i = 0; i < syms.length; i++) if (Math.floor(syms[i].info / 16) === STB_LOCAL) order.push(i);
  const nlocal = order.length;
  for (let i = 0; i < syms.length; i++) if (Math.floor(syms[i].info / 16) !== STB_LOCAL) order.push(i);
  const newNo = new Array(syms.length).fill(0);
  for (let k = 0; k < order.length; k++) newNo[order[k]] = k;
  const sorted = order.map((i) => syms[i]);

  /* ---- 写出：符号表、字符串表、重定位表，最后 `.shstrtab`。 */
  const symBuf = new Uint8Array(sorted.length * SYM_SIZE);
  const symDv = new DataView(symBuf.buffer);
  for (let k = 0; k < sorted.length; k++) {
    const s = sorted[k];
    const p = k * SYM_SIZE;
    symDv.setUint32(p, s.strx, true);
    symBuf[p + 4] = s.info;
    symBuf[p + 5] = s.other;
    symDv.setUint16(p + 6, s.shndx, true);
    symDv.setBigUint64(p + 8, BigInt(s.value), true);
    symDv.setBigUint64(p + 16, BigInt(s.size), true);
  }
  secs[SYMTAB].info = nlocal;

  const shstr = new StrTab();
  const out = [];
  for (let i = 1; i < secs.length; i++) {
    const s = secs[i];
    let body;
    if (i === SYMTAB) body = symBuf;
    else if (i === STRTAB) body = strs.out();
    else if (s.type === SHT_RELA) {
      const list = relas.get(i) === undefined ? [] : relas.get(i);
      body = new Uint8Array(list.length * RELA_SIZE);
      const dv = new DataView(body.buffer);
      for (let k = 0; k < list.length; k++) {
        const r = list[k];
        dv.setBigUint64(k * RELA_SIZE, BigInt(r.at), true);
        dv.setBigUint64(k * RELA_SIZE + 8, BigInt(newNo[r.sym]) * 4294967296n + BigInt(r.type), true);
        dv.setBigInt64(k * RELA_SIZE + 16, r.add, true);
      }
    } else if (s.type === SHT_NOBITS) body = new Uint8Array(0);
    else body = new Uint8Array(s.data);
    out.push({
      name: s.name,
      strx: 0,
      type: s.type,
      flags: s.flags,
      link: s.link,
      info: s.info,
      al: s.al,
      ent: s.ent,
      size: s.type === SHT_NOBITS ? s.size : body.length,
      bytes: body,
    });
  }
  out.push({
    name: '.shstrtab', strx: 0, type: SHT_STRTAB, flags: 0, link: 0, info: 0, al: 1, ent: 0,
    bytes: new Uint8Array(0),
  });
  for (const s of out) s.strx = shstr.intern(s.name);
  out[out.length - 1].bytes = shstr.out();
  out[out.length - 1].size = out[out.length - 1].bytes.length;
  return writeSections(machine, out);
}
