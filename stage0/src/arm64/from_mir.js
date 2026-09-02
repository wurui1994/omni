/* MIR -> arm64 机器码 —— ADR-0017 第 10 步，第九刀第四片。
 *
 * 这一片的口径：**最省事的那一版**。每个 MIR 值一个栈位，算之前 `ldr` 进来、
 * 算完 `str` 回去，寄存器只用 x8/x9/x10 三个当草稿。
 *
 * 为什么不先做寄存器分配
 * ----------------------
 * tcc 也不做。tcc 的 `vstack` 是「值大多在栈上，只有栈顶那一两个在寄存器里」
 * （`tccgen.c` 的 `vtop`/`gv`），一遍过、不回头。所以「全落栈」不是权宜之计，
 * 而是与 tcc 同一档的策略 —— 差别只在我们连栈顶那一两个也不留。留不留是下一片的事，
 * 而现在要先把「一条 MIR 变成哪几条 arm64」这件事逐条钉死。
 *
 * 帧的样子（sp 在函数体里一动不动，所以一律用 sp 加正偏移寻址）：
 *
 *   高地址  ┌────────────────┐
 *           │ 调用者的 x29/x30 │  <- stp x29, x30, [sp, #-16]!
 *   x29 ->  ├────────────────┤
 *           │ 值的栈位 ×N     │   off = 8 * (槽数 + 指令下标)
 *           │ 槽位 ×M         │   off = 8 * 槽号
 *   sp  ->  └────────────────┘
 *
 * 值的栈位数 = 指令条数，编译前就知道（`f.count()`），所以**一遍过**就够，不必像
 * 前端那样分两遍量帧（ADR-0017 偏差 4 说的那件事在这一层不发生）。
 *
 * 这一片认的东西
 * --------------
 * i32/i64/bool 的算术、位运算、比较、宽度转换、结构化控制流（BLOCK/LOOP/IF/ELSE/
 * END/BR/BRIF）、槽位读写、RET。**别的一概明着报错** —— 浮点、内存、指针、聚合、
 * 调用都还没做，而一个悄悄发错指令的后端比一个报错的后端坏得多。
 */

import { OmniError } from '../source/diag.js';
import * as a from './encode.js';
import { CodeBuf } from './asm.js';
import {
  OP, REF_NONE, isConstRef, T_I32, T_I64, T_BOOL, T_VOID, typeKind,
  CVT_SEXT, CVT_ZEXT, CVT_TRUNC, CVT_SEXT8, CVT_SEXT16, OP_NAMES,
} from '../mir/ir.js';

/* 草稿寄存器。x8 是 arm64 的「间接结果」寄存器、x9-x15 是调用者保存的临时 ——
 * 这一层不跨调用活，所以随便用哪三个都行，取这三个只为读起来一致。 */
const TMP0 = 9;
const TMP1 = 10;
const RES = 8;
const SP = 31;

function nyi(what) {
  throw new OmniError(`arm64 后端还不认识 ${what}`);
}

/** 这一片认的类型。bool 在栈位上是 0/1 的 64 位。 */
function widthOf(t) {
  const k = typeKind(t);
  if (k === T_I64 || k === T_BOOL) return 64;
  if (k === T_I32) return 32;
  return nyi(`类型 ${k}`);
}

class FnGen {
  /** `buf` 是整个模块共用的一个缓冲，`callLabels` 是「函数号 -> 标签」（没有就不认 CALL）。 */
  constructor(mod, f, buf, callLabels) {
    this.mod = mod;
    this.f = f;
    this.buf = buf === undefined ? new CodeBuf() : buf;
    this.callLabels = callLabels === undefined ? null : callLabels;
    /** 帧里 0 号槽位的偏移是 0，值的栈位接在槽位后面。 */
    this.valBase = f.slots.length * 8;
    const bytes = this.valBase + f.count() * 8;
    this.frame = bytes + (bytes % 16 === 0 ? 0 : 16 - (bytes % 16));
    /** 区域栈：`{kind, endLabel, contLabel?, elseLabel?, elseDone?}` */
    this.regions = [];
    this.retLabel = this.buf.label();
  }

  /* -------------------------------------------------------------- 位置 */

  slotOff(no) {
    if (!Number.isInteger(no) || no < 0 || no >= this.f.slots.length) {
      throw new OmniError(`arm64: 槽号 ${no} 越界`);
    }
    return no * 8;
  }

  valOff(i) {
    return this.valBase + i * 8;
  }

  /** 帧里的一个 8 字节格子的读写。偏移超过 `ldr` 能表示的范围就明着报。 */
  frameLoad(reg, off) {
    if (off > 32760) throw new OmniError(`arm64: 帧偏移 ${off} 太大（这一片还不搬基址）`);
    this.buf.emit(a.ldrU(3, reg, SP, off));
  }

  frameStore(reg, off) {
    if (off > 32760) throw new OmniError(`arm64: 帧偏移 ${off} 太大（这一片还不搬基址）`);
    this.buf.emit(a.strU(3, reg, SP, off));
  }

  /* -------------------------------------------------------------- 立即数
   * `movz` + 三条 `movk`。全 1 的高位用 `movn` 起头能省两条，这里先不省 ——
   * 省的那两条要靠「哪几个 16 位段是 0xffff」来判，属于下一片的窥孔。 */
  movImm(reg, value) {
    let v = BigInt.asUintN(64, BigInt(value));
    this.buf.emit(a.movz(1, reg, Number(v % 65536n), 0));
    for (let hw = 1; hw < 4; hw++) {
      v /= 65536n;
      const part = Number(v % 65536n);
      if (part !== 0) this.buf.emit(a.movk(1, reg, part, hw));
    }
  }

  /** 把一个 ref 的值弄到 `reg` 里。常量当场造，指令的值从栈位取。 */
  loadRef(reg, ref) {
    if (ref === REF_NONE) throw new OmniError('arm64: 这条指令少了一个操作数');
    if (isConstRef(ref)) {
      const k = this.mod.consts.get(ref);
      if (k.kind === 'int') return this.movImm(reg, BigInt(k.text));
      if (k.kind === 'bool') return this.movImm(reg, k.text === 'true' ? 1n : 0n);
      return nyi(`常量 ${k.kind}`);
    }
    this.frameLoad(reg, this.valOff(this.f.at(ref)));
  }

  /* -------------------------------------------------------------- 区域 */

  region(level) {
    const i = this.regions.length - 1 - level;
    if (i < 0) throw new OmniError(`arm64: BR 往外 ${level} 层，可是只有 ${this.regions.length} 层`);
    return this.regions[i];
  }

  /** BR 的落点：跳到 LOOP 是回头（continue），跳到别的是出去（break）—— 与 wasm 逐条相同。 */
  brTarget(level) {
    const r = this.region(level);
    return r.kind === 'loop' ? r.contLabel : r.endLabel;
  }

  /* -------------------------------------------------------------- 主体 */

  gen() {
    const f = this.f;
    const buf = this.buf;
    buf.emit(a.stpPre(1, 29, 30, SP, -16), a.movSp(1, 29, SP));
    if (this.frame > 0) {
      if (this.frame < 4096) buf.emit(a.subImm(1, SP, SP, this.frame));
      else {
        this.movImm(TMP0, BigInt(this.frame));
        buf.emit(a.subReg(1, SP, SP, TMP0));
      }
    }
    /* 形参：AAPCS 的 x0-x7 进各自的槽位。第九个起走栈，这一片还不认。 */
    if (f.params.length > 8) nyi(`${f.params.length} 个形参（超过 8 个要走栈）`);
    let pi = 0;
    for (const p of f.params) {
      this.frameStore(pi, this.slotOff(p.slot));
      pi++;
    }

    for (let i = 0; i < f.count(); i++) this.one(i);

    buf.place(this.retLabel);
    if (this.frame > 0) buf.emit(a.movSp(1, SP, 29));
    buf.emit(a.ldpPost(1, 29, 30, SP, 16), a.ret());
    return buf;
  }

  one(i) {
    const f = this.f;
    const buf = this.buf;
    const op = f.op[i];
    const t = f.t[i];

    /* ---- 控制流 */
    if (op === OP.BLOCK) {
      this.regions.push({ kind: 'block', endLabel: buf.label() });
      return;
    }
    if (op === OP.LOOP) {
      const contLabel = buf.label();
      buf.place(contLabel);
      this.regions.push({ kind: 'loop', endLabel: buf.label(), contLabel });
      return;
    }
    if (op === OP.IF) {
      this.loadRef(TMP0, f.a[i]);
      const elseLabel = buf.label();
      buf.cbz(1, TMP0, elseLabel);
      this.regions.push({ kind: 'if', endLabel: buf.label(), elseLabel, elseDone: false });
      return;
    }
    if (op === OP.ELSE) {
      const r = this.regions[this.regions.length - 1];
      if (r === undefined || r.kind !== 'if') throw new OmniError('arm64: ELSE 没有对应的 IF');
      buf.b(r.endLabel);
      buf.place(r.elseLabel);
      r.elseDone = true;
      return;
    }
    if (op === OP.END) {
      const r = this.regions.pop();
      if (r === undefined) throw new OmniError('arm64: END 多了一条');
      /* 没有 ELSE 的 IF：条件假就直接落到 END —— 两个标签钉在同一处。 */
      if (r.kind === 'if' && !r.elseDone) buf.place(r.elseLabel);
      buf.place(r.endLabel);
      return;
    }
    if (op === OP.BR) {
      buf.b(this.brTarget(f.aux[i]));
      return;
    }
    if (op === OP.BRIF) {
      this.loadRef(TMP0, f.a[i]);
      buf.cbnz(1, TMP0, this.brTarget(f.aux[i]));
      return;
    }
    if (op === OP.RET) {
      if (f.a[i] !== REF_NONE) {
        this.loadRef(0, f.a[i]);
        /* i32 的规范形是符号扩展过的 64 位，而 AAPCS 只看 w0 —— 两边都对，不用再削。 */
      }
      buf.b(this.retLabel);
      return;
    }

    /* ---- 调用。实参进 x0-x7，返回值在 x0。
     * 不用管调用者保存的寄存器：这一片的值全在栈位上，跨调用活着的东西一个也没有 ——
     * 「全落栈」这个笨办法在这儿一次性省掉了整个调用点的溢出逻辑。 */
    if (op === OP.CALL) {
      if (this.callLabels === null) nyi('单个函数里的 CALL（要按整个模块生成才有落点）');
      const args = f.argsOf(f.b[i]);
      if (args.length > 8) nyi(`${args.length} 个实参（超过 8 个要走栈）`);
      let r = 0;
      for (const ar of args) {
        this.loadRef(r, ar);
        r++;
      }
      const label = this.callLabels[f.a[i]];
      if (label === undefined) throw new OmniError(`arm64: 没有 ${f.a[i]} 号函数`);
      buf.bl(label);
      if (typeKind(t) === T_VOID) return;
      /* i32 的返回值要按规范形符号扩展：AAPCS 只保证 w0 有值，x0 的高 32 位不算数。 */
      return this.def(i, 0, widthOf(t));
    }

    /* ---- 槽位 */
    if (op === OP.LOAD) {
      this.frameLoad(RES, this.slotOff(f.aux[i]));
      return this.def(i, RES);
    }
    if (op === OP.STORE) {
      this.loadRef(RES, f.a[i]);
      this.frameStore(RES, this.slotOff(f.aux[i]));
      return;
    }

    /* ---- 单目 */
    if (op === OP.NEG) {
      const w = widthOf(t);
      this.loadRef(TMP0, f.a[i]);
      buf.emit(a.neg(w === 64 ? 1 : 0, RES, TMP0));
      return this.def(i, RES, w);
    }
    if (op === OP.BNOT) {
      const w = widthOf(t);
      this.loadRef(TMP0, f.a[i]);
      buf.emit(a.mvn(w === 64 ? 1 : 0, RES, TMP0));
      return this.def(i, RES, w);
    }
    if (op === OP.NOT) {
      this.loadRef(TMP0, f.a[i]);
      buf.emit(a.eorImm(1, RES, TMP0, 1));
      return this.def(i, RES);
    }

    /* ---- 二目 */
    const bin = BIN[op];
    if (bin !== undefined) {
      const w = widthOf(t);
      const sf = w === 64 ? 1 : 0;
      this.loadRef(TMP0, f.a[i]);
      this.loadRef(TMP1, f.b[i]);
      bin(buf, sf, RES, TMP0, TMP1);
      return this.def(i, RES, w);
    }

    /* ---- 比较：`t` 是操作数的类型，产出永远是 0/1 的 bool */
    const cond = CMP[op];
    if (cond !== undefined) {
      const sf = widthOf(t) === 64 ? 1 : 0;
      this.loadRef(TMP0, f.a[i]);
      this.loadRef(TMP1, f.b[i]);
      buf.emit(a.cmpReg(sf, TMP0, TMP1), a.cset(1, RES, cond));
      return this.def(i, RES);
    }

    /* ---- 宽度转换 */
    if (op === OP.CVT) return this.cvt(i);

    return nyi(`MIR 指令 ${OP_NAMES[op]}`);
  }

  cvt(i) {
    const f = this.f;
    const buf = this.buf;
    const mode = f.aux[i];
    this.loadRef(TMP0, f.a[i]);
    /* i32 的规范形是**符号扩展后的 64 位**，所以：
     *  - SEXT（i32 -> i64）什么都不用做（值本来就是那个样子）；
     *  - ZEXT 要把高 32 位抹掉；
     *  - TRUNC（i64 -> i32）要重新按 32 位符号扩展一遍。 */
    if (mode === CVT_SEXT) buf.emit(a.movReg(1, RES, TMP0));
    else if (mode === CVT_ZEXT) buf.emit(a.andImm(1, RES, TMP0, 0xffffffffn));
    else if (mode === CVT_TRUNC) buf.emit(a.sxtw(RES, TMP0));
    /* `sxtb x8, w9` 一条就把 64 位都符号扩展好了 —— i32 与 i64 的规范形在这儿是同一个值，
     * 所以不按结果类型分 w/x 系（分了反而要给 i32 再补一条 `sxtw`）。 */
    else if (mode === CVT_SEXT8) buf.emit(a.sxtb(1, RES, TMP0));
    else if (mode === CVT_SEXT16) buf.emit(a.sxth(1, RES, TMP0));
    else return nyi(`CVT 模式 ${mode}`);
    return this.def(i, RES);
  }

  /** 把结果写回这条指令的栈位。32 位的结果先按 i32 的规范形符号扩展。 */
  def(i, reg, w) {
    if (w === 32) this.buf.emit(a.sxtw(reg, reg));
    this.frameStore(reg, this.valOff(i));
  }
}

/* 二目运算表。`sf` 是 0/1（w/x 系）；32 位的结果由 `def` 统一符号扩展回规范形。
 * 无符号那三条（UDIV/UMOD/USHR）在 w 系上天然对：`udiv w` 只看低 32 位、
 * 结果零扩展，而随后的 `sxtw` 把它变回规范形。 */
const BIN = {};
BIN[OP.ADD] = (b, sf, d, x, y) => b.emit(a.addReg(sf, d, x, y));
BIN[OP.SUB] = (b, sf, d, x, y) => b.emit(a.subReg(sf, d, x, y));
BIN[OP.MUL] = (b, sf, d, x, y) => b.emit(a.mul(sf, d, x, y));
BIN[OP.DIV] = (b, sf, d, x, y) => b.emit(a.sdiv(sf, d, x, y));
BIN[OP.UDIV] = (b, sf, d, x, y) => b.emit(a.udiv(sf, d, x, y));
/* 取余没有单条指令：先除、再 `msub`（d = x - (x/y)*y）。 */
BIN[OP.MOD] = (b, sf, d, x, y) => b.emit(a.sdiv(sf, d, x, y), a.msub(sf, d, d, y, x));
BIN[OP.UMOD] = (b, sf, d, x, y) => b.emit(a.udiv(sf, d, x, y), a.msub(sf, d, d, y, x));
BIN[OP.SHL] = (b, sf, d, x, y) => b.emit(a.lslv(sf, d, x, y));
BIN[OP.SHR] = (b, sf, d, x, y) => b.emit(a.asrv(sf, d, x, y));
BIN[OP.USHR] = (b, sf, d, x, y) => b.emit(a.lsrv(sf, d, x, y));
BIN[OP.BAND] = (b, sf, d, x, y) => b.emit(a.andReg(sf, d, x, y));
BIN[OP.BOR] = (b, sf, d, x, y) => b.emit(a.orrReg(sf, d, x, y));
BIN[OP.BXOR] = (b, sf, d, x, y) => b.emit(a.eorReg(sf, d, x, y));

/* 比较 -> 条件码。`cs`/`cc` 就是手册里的 `hs`/`lo`（无符号的 >= 与 <）。 */
const CMP = {};
CMP[OP.EQ] = a.COND.eq;
CMP[OP.NE] = a.COND.ne;
CMP[OP.LT] = a.COND.lt;
CMP[OP.GE] = a.COND.ge;
CMP[OP.LE] = a.COND.le;
CMP[OP.GT] = a.COND.gt;
CMP[OP.ULT] = a.COND.cc;
CMP[OP.UGE] = a.COND.cs;
CMP[OP.ULE] = a.COND.ls;
CMP[OP.UGT] = a.COND.hi;

/** 一个 MIR 函数 -> 一段 arm64 机器码（`CodeBuf`，已回填）。不认 CALL —— 单个函数
 * 里没有别的函数的落点，要发调用得走 `genModule`。 */
export function genFunc(mod, f) {
  const g = new FnGen(mod, f);
  g.gen();
  g.buf.finish();
  return g.buf;
}

/** 图省事的入口：直接要字节。 */
export function codeOf(mod, f) {
  return genFunc(mod, f).bytes();
}

/**
 * 整个模块 -> 一段连着的机器码。
 *
 * 函数之间的调用走**标签**而不是符号：一个模块的函数全在同一个缓冲里，`bl` 的
 * ±128MB 够得着，于是这一层不欠链接器任何账（跨模块的符号才欠，见 `asm.js` 的
 * `blSym`）。`offsets[i]` 是第 i 个函数在这段字节里的起点。
 */
export function genModule(mod) {
  const buf = new CodeBuf();
  const labels = [];
  for (let i = 0; i < mod.funcs.length; i++) labels.push(buf.label());
  const offsets = [];
  let i = 0;
  for (const f of mod.funcs) {
    offsets.push(buf.pos);
    buf.place(labels[i]);
    new FnGen(mod, f, buf, labels).gen();
    i++;
  }
  const bytes = buf.bytes();
  const sizes = [];
  for (let k = 0; k < offsets.length; k++) {
    sizes.push((k + 1 < offsets.length ? offsets[k + 1] : bytes.length) - offsets[k]);
  }
  return { bytes, offsets, sizes, relocs: buf.relocs };
}
