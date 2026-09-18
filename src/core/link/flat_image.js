/* **平铺映像** —— 把几个 `.o` 链到一块**已经在这个进程里**的内存上（ADR-0038 第二刀）。
 *
 * 这是 tcc 的 `tcc_relocate` / `tcc_relocate_ex`（`tccrun.c:154` / `:330`）那一步：
 * 不写文件、不造程序头、不留给 dyld —— 装载地址与外部符号的**真地址在链接时就知道**，
 * 所以每一条重定位当场打完，剩下的只有"把哪几页设成可执行"。
 *
 * 与写可执行文件那两条出口（`elf_exe.js` / `macho_exe.js`）的分工：
 *   - 前半段共用 —— `elf_merge.js` 的 `linkObjects` 把几份 `.o` 并成一份内存里的节表；
 *   - 重定位共用 —— `pe_reloc.js` 的 `relocateOne` 是全仓唯一一份"按号改字节"；
 *   - 这一份只换后半段：**布局按 tcc 的三档分页**（rx / ro / rw，`tcc_relocate_ex` 里
 *     `for (k = 0; k < 3; ++k)` 那一圈），未定义符号交给调用方给的 `resolve(name)`。
 *
 * 为什么外部调用还是要 GOT 与桩子：`resolve` 回来的地址在 libSystem 里，离我们这块内存
 * 两个 G（量过：我们 0x1_04a2_4000、`printf` 0x1_84ff_1964）。arm64 的 `CALL26` 只够
 * ±128MB —— 直接改那条 `bl` 是**静默截断**（`relocateOne` 里 `d & 0x3ffffff` 不查界）。
 * 所以照 `macho_exe.js` 的 `check_relocs` 造同一种桩子：`adrp x16` + `ldr x16` + `br x16`
 * 走一格 GOT，而那格 GOT 里**直接写死真地址**（不像 AOT 那样留给 dyld 绑）。
 */

import { OmniError } from '../source/diag.js';
import { linkObjects } from './elf_merge.js';
import { relocateOne } from './pe_reloc.js';

const FI_EM_X86_64 = 62;
const FI_EM_AARCH64 = 183;

const FI_SHT_PROGBITS = 1;
const FI_SHT_RELA = 4;
const FI_SHT_NOBITS = 8;

const FI_SHF_WRITE = 1;
const FI_SHF_ALLOC = 2;
const FI_SHF_EXECINSTR = 4;

const FI_SHN_UNDEF = 0;
const FI_SHN_COMMON = 0xfff2;
const FI_SHN_LORESERVE = 0xff00;

const FI_STB_LOCAL = 0;
const FI_STB_WEAK = 2;

/** 权限那三档（与宿主的 `protect` 同一套号，与 tcc 的 `protect_pages` 逐条对应）。 */
export const FI_RX = 0;
export const FI_RO = 1;
export const FI_RW = 2;

/** 走不走 GOT：`always` 那一档照 `arm64-link.c` / `x86_64-link.c` 的 `gotplt_entry_type`。 */
const FI_ALWAYS_GOT = new Map([
  [FI_EM_X86_64, new Set([3, 4, 9, 17, 19, 20, 21, 25, 26, 27, 29, 31, 41, 42])],
  [FI_EM_AARCH64, new Set([311, 312])],
]);

/** 「这一条是代码里的调用」——要桩子的就是它们（`code_reloc()`）。 */
const FI_CODE_RELOC = new Map([
  [FI_EM_X86_64, new Set([2, 4, 31, 42])],
  [FI_EM_AARCH64, new Set([282, 283])],
]);

function fiConf(machine) {
  if (machine === FI_EM_X86_64) {
    return { stubSize: 6, callReloc: 31, gotReloc: 9 };
  }
  if (machine === FI_EM_AARCH64) {
    return { stubSize: 12, callReloc: 283, gotReloc: 311 };
  }
  throw new OmniError(`flat: 还不会给 ${machine} 号架构铺映像`);
}

const fiAlign = (n, to) => (to <= 1 ? n : Math.ceil(n / to) * to);

/**
 * 几个 `.o` -> 一块能跑的内存。
 *
 * @param inp `{ objs, reserve, resolve, page }`
 *   - `objs`    每个都是一份 `ET_REL` 的字节（我们自己那台 C 前端出的，或者 tcc 出的）
 *   - `reserve` `(size) => 基址`：布局算完之后**才**知道要多大，所以这一格是回调
 *     （tcc 也是这个形状：`tcc_relocate_ex(NULL)` 先回一个尺寸，再要内存）
 *   - `resolve` `(name) => 地址 | null`：外面那些符号在哪。回 null = 查不着
 *   - `page`    页大小（宿主那侧的 `getpagesize()`；arm64 macOS 上是 16384）
 * @returns `{ base, size, bytes, ranges, syms }`
 *   - `bytes`  整块映像（下标 0 就是 `base`），照原样写进宿主那块内存即可
 *   - `ranges` `[{ addr, len, mode }]`：写完之后一段一段 `protect`
 *   - `syms`   全局符号名 -> 绝对地址（`napi_register_module_v1` 从这儿拿）
 */
export function flatImage(inp) {
  const page = inp.page === undefined ? 4096 : inp.page;
  const resolve = inp.resolve;
  const st = linkObjects(inp.objs, { rdata: '.data.ro', unwind: false });
  const {
    machine, secs, syms, relas, byName,
  } = st;
  const { BSS, SYMTAB } = st.idx;
  const conf = fiConf(machine);
  const alwaysGot = FI_ALWAYS_GOT.get(machine) ?? new Set();
  const codeReloc = FI_CODE_RELOC.get(machine) ?? new Set();

  /* ---- 一、COMMON 进 `.bss`（`resolve_common_syms`）。 */
  for (const s of syms) {
    if (s.shndx !== FI_SHN_COMMON || s.size === 0) continue;
    const bss = secs[BSS];
    const al = s.value < 1 ? 1 : Number(s.value);
    const off = fiAlign(bss.size, al);
    bss.size = off + Number(s.size);
    if (al > bss.al) bss.al = al;
    s.value = off;
    s.shndx = BSS;
  }

  /* ---- 二、外面那些符号：一个个问 `resolve`。
     查不着的**攒起来一次报全**：一条条报的话，改一个名字就要重跑一趟才看见下一条。 */
  const ext = new Map();          // 符号号 -> 绝对地址
  const missing = [];
  for (let i = 1; i < syms.length; i++) {
    const s = syms[i];
    if (s.shndx !== FI_SHN_UNDEF || s.name === '') continue;
    const a = resolve(s.name);
    if (a === null || a === undefined || a === 0 || a === 0n) {
      /* 弱符号查不着是**合法**的：那一格的语义就是"没有就当 0"，`relocateOne` 里
         `weakUndef` 那几支把 `bl` 改成 `nop`、把 `adrp` 改成 `movz #0`。 */
      if (Math.floor(s.info / 16) === FI_STB_WEAK) continue;
      missing.push(s.name);
      continue;
    }
    ext.set(i, BigInt(a));
  }
  if (missing.length > 0) {
    throw new OmniError(`flat: 这 ${missing.length} 个符号在这个进程里找不着：${missing.join(' ')}`);
  }

  /* ---- 三、GOT 与桩子（照 `macho_exe.js` 的 `check_relocs`，去掉 dyld 那一半）。 */
  const GOT = st.newSec('.got', FI_SHT_PROGBITS, FI_SHF_ALLOC | FI_SHF_WRITE, 8, 0);
  const STUBS = st.newSec('.stubs', FI_SHT_PROGBITS, FI_SHF_ALLOC | FI_SHF_EXECINSTR, 4, 0);
  /* 桩子那一节自己要一格符号：调用点的重定位改指到它 + 一格偏移。 */
  const stubSym = st.setSym({
    name: '.stubs$flat', info: FI_STB_LOCAL * 16, other: 0, shndx: STUBS, value: 0, size: 0,
  });
  const attr = new Map();         // 符号号 -> { gotOff, pltOff }
  const gotOrder = [];            // 按分配次序记着，最后往 GOT 里写地址
  const needStub = [];
  for (let si = 1; si < secs.length; si++) {
    if (secs[si].type !== FI_SHT_RELA) continue;
    const list = relas.get(si);
    if (list === undefined) continue;
    const tgtName = secs[secs[si].relaFor]?.name ?? '';
    if (tgtName.startsWith('.debug_')) continue;
    for (const rel of list) {
      const sym = syms[rel.sym];
      const undef = sym.shndx === FI_SHN_UNDEF;
      if (!undef && !alwaysGot.has(rel.type)) continue;
      let a = attr.get(rel.sym);
      if (a === undefined) {
        a = { gotOff: secs[GOT].size, pltOff: -1 };
        attr.set(rel.sym, a);
        for (let k = 0; k < 8; k++) secs[GOT].data.push(0);
        secs[GOT].size += 8;
        gotOrder.push(rel.sym);
      }
      /* 代码里的调用 + 符号在外面 -> 一格桩子。`adrp` 够得着（±4GB，而 GOT 就在
         这块映像里差几页），所以桩子这一跳是安全的，直接改 `bl` 不安全。 */
      if (undef && codeReloc.has(rel.type)) {
        if (a.pltOff === -1) {
          a.pltOff = secs[STUBS].size;
          secs[STUBS].size += conf.stubSize;
          needStub.push({ sym: rel.sym, off: a.pltOff });
        }
        rel.sym = stubSym;
        rel.add += BigInt(a.pltOff);
      }
    }
  }
  /* 桩子的字节：`adrp x16, GOT` / `ldr x16,[x16]` / `br x16`，两条立即数等地址定了再填
     （所以先摆零，下面 `patchStubs` 那一步补）。x86_64 上是一条 `jmpq *ofs(%rip)`。 */
  for (let k = 0; k < secs[STUBS].size; k++) secs[STUBS].data.push(0);

  /* ---- 四、布局（照 `tcc_relocate_ex` 的 `for (k = 0; k < 3; ++k)`）。
     三档：0=rx（.text + .stubs）  1=ro（.data.ro）  2=rw（.data + .bss + .got）
     每档起头对齐到页 —— 不然 `mprotect` 打不准。 */
  const classify = (s) => {
    if (s.type === FI_SHT_RELA || s.type === 2 || s.type === 3) return -1;
    if ((s.flags & FI_SHF_ALLOC) === 0) return -1;
    if ((s.flags & FI_SHF_EXECINSTR) !== 0) return 0;
    if ((s.flags & FI_SHF_WRITE) !== 0) return 2;
    return 1;
  };
  /* 第一遍：量总大小（`tcc_relocate_ex` 的 `ptr == NULL` 那一趟）。 */
  let total = 0;
  for (let k = 0; k < 3; k++) {
    let first = true;
    for (let i = 1; i < secs.length; i++) {
      const s = secs[i];
      if (classify(s) !== k) continue;
      const len = s.type === FI_SHT_NOBITS ? s.size : s.data.length;
      if (len === 0 && s.size === 0) continue;
      if (first) { total = fiAlign(total, page); first = false; }
      const al = s.al < 1 ? 1 : s.al;
      total = fiAlign(total, al) + Math.max(len, s.size);
    }
  }
  total = fiAlign(total, page);
  const base = BigInt(inp.reserve(total));

  /* 第二遍：把每一节摆在那块内存上（`sh_addr`）。同时收 ranges。 */
  const ranges = [];
  let cur = 0;
  for (let k = 0; k < 3; k++) {
    let first = true;
    let rangeStart = 0;
    for (let i = 1; i < secs.length; i++) {
      const s = secs[i];
      if (classify(s) !== k) continue;
      const len = s.type === FI_SHT_NOBITS ? s.size : s.data.length;
      if (len === 0 && s.size === 0) continue;
      if (first) { cur = fiAlign(cur, page); rangeStart = cur; first = false; }
      const al = s.al < 1 ? 1 : s.al;
      cur = fiAlign(cur, al);
      s.addr = Number(base) + cur;
      cur += Math.max(len, s.size);
    }
    if (!first) {
      const n = fiAlign(cur - rangeStart, page);
      ranges.push({ addr: base + BigInt(rangeStart), len: n, mode: k });
    }
  }

  /* ---- 五、`relocate_syms`：`value += secs[shndx].addr`。 */
  for (const s of syms) {
    if (s.shndx !== FI_SHN_UNDEF && s.shndx < FI_SHN_LORESERVE && secs[s.shndx] !== undefined) {
      s.value += secs[s.shndx].addr;
    }
  }

  /* ---- 六、把节的字节拷进一块大 Uint8Array（BSS 部分自然是 0）。 */
  const bytes = new Uint8Array(total);
  for (let i = 1; i < secs.length; i++) {
    const s = secs[i];
    if (classify(s) < 0 || s.type === FI_SHT_NOBITS) continue;
    if (s.data.length === 0) continue;
    const off = s.addr - Number(base);
    /* `data` 总是普通数组（`elf_merge.js` 的 `linkObjects` 用 `.push` 堆出来的），
       不需要判 Uint8Array —— 那样做会触 check:self 的 `instanceof` 门。 */
    for (let j = 0; j < s.data.length; j++) bytes[off + j] = s.data[j];
  }

  /* ---- 七、GOT：每格写上**真地址**（tcc 那一路由 dyld 绑，我们这条路直接写死）。 */
  const gotBase = secs[GOT].addr;
  const gdv = new DataView(bytes.buffer, secs[GOT].addr - Number(base), secs[GOT].size);
  for (let k = 0; k < gotOrder.length; k++) {
    const si = gotOrder[k];
    const s = syms[si];
    const a = s.shndx === FI_SHN_UNDEF ? (ext.get(si) ?? 0n) : BigInt(s.value);
    gdv.setBigInt64(k * 8, a, true);
  }

  /* ---- 八、桩子的立即数（布局定了才知道）。 */
  const stubBase = secs[STUBS].addr;
  const stubOff = stubBase - Number(base);
  for (const { sym: si, off } of needStub) {
    const a = attr.get(si);
    const gotAddr = gotBase + a.gotOff;
    if (machine === FI_EM_AARCH64) {
      /* adrp x16, #got_page  / ldr x16,[x16, #got_off12]  / br x16 */
      const pc = stubBase + off;
      const immHi = Number(BigInt(gotAddr & ~0xfff) - BigInt(pc & ~0xfff)) >> 12;
      const lo12 = (gotAddr & 0xfff) >> 3;
      const adrp = 0x90000010 | ((immHi & 3) << 29) | (((immHi >> 2) & 0x7ffff) << 5);
      const ldr  = 0xf9400210 | ((lo12 & 0x1ff) << 10);
      const br   = 0xd61f0200;
      const dv = new DataView(bytes.buffer, stubOff + off, 12);
      dv.setUint32(0, adrp, true);
      dv.setUint32(4, ldr, true);
      dv.setUint32(8, br, true);
    } else {
      /* x86_64: jmpq *ofs(%rip)   ff 25 <i32> */
      const pc = stubBase + off + 6;
      const disp = gotAddr - pc;
      const dv = new DataView(bytes.buffer, stubOff + off, 6);
      dv.setUint8(0, 0xff);
      dv.setUint8(1, 0x25);
      dv.setInt32(2, disp, true);
    }
  }

  /* ---- 九、打重定位。 */
  const symAddr = (idx) => {
    const s = syms[idx];
    if (s.shndx === FI_SHN_UNDEF) {
      const a = ext.get(idx);
      if (a !== undefined) return Number(a);
      /* weak */
      return 0;
    }
    return s.value;
  };
  for (const [si, list] of relas) {
    const tgtIdx = secs[si].relaFor;
    const tgt = secs[tgtIdx];
    if (tgt === undefined || classify(tgt) < 0) continue;
    const tgtOff = tgt.addr - Number(base);
    const tgtBuf = bytes.subarray(tgtOff, tgtOff + Math.max(tgt.data.length, tgt.size));
    for (const r of list) {
      const s = syms[r.sym];
      const weak = s.shndx === FI_SHN_UNDEF && Math.floor(s.info / 16) === FI_STB_WEAK;
      const a = attr.get(r.sym);
      relocateOne(machine, r.type, tgtBuf, r.at, tgt.addr + r.at,
        symAddr(r.sym) + Number(r.add), 0, weak,
        a === undefined ? undefined : gotBase + a.gotOff);
    }
  }

  /* ---- 十、全局符号名 -> 绝对地址。 */
  const outSyms = new Map();
  for (const s of syms) {
    if (s.name === '' || Math.floor(s.info / 16) === FI_STB_LOCAL) continue;
    if (s.shndx === FI_SHN_UNDEF || s.shndx >= FI_SHN_LORESERVE) continue;
    outSyms.set(s.name, BigInt(s.value));
  }

  return { base, size: total, bytes, ranges, syms: outSyms };
}


