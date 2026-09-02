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
  OP, REF_NONE, isConstRef, T_I32, T_I64, T_BOOL, T_VOID, T_F32, T_F64,
  typeKind, isFloatType, intBits, memKindNo, memOff, MLOAD_KINDS, MSTORE_KINDS,
  CVT_SEXT, CVT_ZEXT, CVT_TRUNC, CVT_SEXT8, CVT_SEXT16,
  CVT_I2F, CVT_U2F, CVT_F2I, CVT_FCVT, CVT_BITCAST, OP_NAMES,
} from '../mir/ir.js';

/* 草稿寄存器。x8 是 arm64 的「间接结果」寄存器、x9-x15 是调用者保存的临时 ——
 * 这一层不跨调用活，所以随便用哪三个都行，取这三个只为读起来一致。 */
const TMP0 = 9;
const TMP1 = 10;
const RES = 8;
const SP = 31;
/* 浮点的草稿。取 v16-v18 是因为 **v8-v15 是被调用者保存的** —— 用它们就得在序言里存、
 * 收场里取，而这一层根本不需要跨调用留住任何东西。 */
const FTMP0 = 16;
const FTMP1 = 17;
const FRES = 18;
/**
 * **native 这条腿上没有线性内存。**
 *
 * 线性内存（ADR-0017 第二刀）是 wasm 与解释器那条腿的模型：一整片字节，地址是从 0 起的
 * 偏移，越界能查得出来。native 不是那样 —— tcc 编出来的 `int x; &x` 就是**真地址**
 * （`[x29, #-off]`），全局在数据段、堆是 `malloc` 回来的地址，一个「基址」都不存在。
 *
 * 所以 `MLOAD`/`MSTORE` 在这一层的地址**就是真指针**，不加任何基址。曾经想过钉一个
 * 基址寄存器（wasm 引擎的常规做法），那是错的方向：不但白搭一条 `add`，还会让 native
 * 与外部 C 函数交换指针时对不上 —— `malloc` 回来的地址不在任何一块「线性内存」里。
 */

/** 一个 double / float 的 IEEE 754 位模式。与 C 前端的 `floatBits` 同一个写法。 */
function floatBits(x, size) {
  const dv = new DataView(new ArrayBuffer(8));
  if (size === 4) {
    dv.setFloat32(0, x, true);
    return BigInt(dv.getUint32(0, true));
  }
  dv.setFloat64(0, x, true);
  return dv.getBigUint64(0, true);
}

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

  /** 把一个 ref 的值弄到 `reg` 里。常量当场造，指令的值从栈位取。
   * 浮点也走**整数寄存器**：栈位里躺的是位模式，进 FP 寄存器是 `fmov` 的事。 */
  loadRef(reg, ref) {
    if (ref === REF_NONE) throw new OmniError('arm64: 这条指令少了一个操作数');
    if (isConstRef(ref)) {
      const k = this.mod.consts.get(ref);
      if (k.kind === 'int') return this.movImm(reg, BigInt(k.text));
      if (k.kind === 'bool') return this.movImm(reg, k.text === 'true' ? 1n : 0n);
      if (k.kind === 'real') {
        return this.movImm(reg, floatBits(Number(k.text), typeKind(k.t) === T_F32 ? 4 : 8));
      }
      return nyi(`常量 ${k.kind}`);
    }
    this.frameLoad(reg, this.valOff(this.f.at(ref)));
  }

  /** 一个 ref 产出的类型（比较的 `t` 是操作数的类型，所以不能直接读 `t`）。 */
  typeOfRef(ref) {
    return this.f.typeOf(ref, this.mod.consts);
  }

  /** 位模式 -> FP 寄存器。`fmov` 的整数那一侧要与浮点宽度同宽（d 配 x、s 配 w）。 */
  toFp(fdst, greg, dbl) {
    this.buf.emit(a.fmovFromInt(dbl ? 1 : 0, dbl, fdst, greg));
  }

  /** FP 寄存器 -> 位模式。 */
  fromFp(gdst, fsrc, dbl) {
    this.buf.emit(a.fmovToInt(dbl ? 1 : 0, dbl, gdst, fsrc));
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
    /* 形参：AAPCS 把整数与浮点**分成两串**数（x0-x7 与 v0-v7 各自从 0 起），
     * 所以两个计数器。第九个起走栈，这一片还不认。 */
    let ngrn = 0;
    let nsrn = 0;
    for (const p of f.params) {
      if (isFloatType(p.t)) {
        if (nsrn > 7) nyi(`第 ${nsrn + 1} 个浮点形参（超过 8 个要走栈）`);
        this.fromFp(TMP0, nsrn, typeKind(p.t) === T_F64);
        this.frameStore(TMP0, this.slotOff(p.slot));
        nsrn++;
        continue;
      }
      if (ngrn > 7) nyi(`第 ${ngrn + 1} 个整数形参（超过 8 个要走栈）`);
      this.frameStore(ngrn, this.slotOff(p.slot));
      ngrn++;
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
        this.loadRef(TMP0, f.a[i]);
        /* 浮点的返回值在 d0，整数在 x0。i32 的规范形是符号扩展过的 64 位，而 AAPCS
         * 只看 w0 —— 两边都对，不用再削。 */
        if (isFloatType(t)) this.toFp(0, TMP0, typeKind(t) === T_F64);
        else buf.emit(a.movReg(1, 0, TMP0));
      }
      buf.b(this.retLabel);
      return;
    }

    /* ---- 调用。整数实参进 x0-x7、浮点实参进 v0-v7（两串各自从 0 起数），返回值在
     * x0 或 d0。不用管调用者保存的寄存器：这一片的值全在栈位上，跨调用活着的东西一个
     * 也没有 —— 「全落栈」这个笨办法在这儿一次性省掉了整个调用点的溢出逻辑。 */
    if (op === OP.CALL) {
      if (this.callLabels === null) nyi('单个函数里的 CALL（要按整个模块生成才有落点）');
      const args = f.argsOf(f.b[i]);
      let ngrn = 0;
      let nsrn = 0;
      for (const ar of args) {
        const at = this.typeOfRef(ar);
        if (isFloatType(at)) {
          if (nsrn > 7) nyi(`第 ${nsrn + 1} 个浮点实参（超过 8 个要走栈）`);
          this.loadRef(TMP0, ar);
          this.toFp(nsrn, TMP0, typeKind(at) === T_F64);
          nsrn++;
          continue;
        }
        if (ngrn > 7) nyi(`第 ${ngrn + 1} 个整数实参（超过 8 个要走栈）`);
        this.loadRef(ngrn, ar);
        ngrn++;
      }
      const label = this.callLabels[f.a[i]];
      if (label === undefined) throw new OmniError(`arm64: 没有 ${f.a[i]} 号函数`);
      buf.bl(label);
      if (typeKind(t) === T_VOID) return;
      if (isFloatType(t)) {
        this.fromFp(RES, 0, typeKind(t) === T_F64);
        return this.def(i, RES);
      }
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

    /* ---- 线性内存（第九刀第七片）。地址是从 0 起的字节偏移，真址 = x28 + 偏移。 */
    if (op === OP.MLOAD) return this.mload(i);
    if (op === OP.MSTORE) return this.mstore(i);

    /* ---- 浮点。`t` 是浮点就整条交给 `float()`：算术、取负、比较、以及**结果是浮点的**
     * 那几种 CVT 都在那儿。结果是整数的 F2I 留在 `cvt()`（那条的 `t` 是整数）。 */
    if (isFloatType(t)) return this.float(i);

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

  /**
   * `t` 是浮点的那些指令。
   *
   * 值照旧躺在 8 字节的栈位里（躺的是**位模式**），进 FP 寄存器一条 `fmov`、出来
   * 再一条。于是取值/回写那一整套一个字都不用改，多出来的只是每条运算两三条 `fmov`。
   * 这与「全落栈」是同一个取舍：先把「哪条 MIR 对哪条 arm64」钉死，省指令是窥孔的事。
   */
  float(i) {
    const f = this.f;
    const buf = this.buf;
    const op = f.op[i];
    const dbl = typeKind(f.t[i]) === T_F64;
    if (op === OP.CVT) return this.cvtToFloat(i, dbl);
    if (op === OP.NEG) {
      this.loadRef(TMP0, f.a[i]);
      this.toFp(FTMP0, TMP0, dbl);
      buf.emit(a.fneg(dbl, FRES, FTMP0));
      this.fromFp(RES, FRES, dbl);
      return this.def(i, RES);
    }
    const fb = FBIN[op];
    const fc = FCMP[op];
    if (fb === undefined && fc === undefined) return nyi(`浮点的 ${OP_NAMES[op]}`);
    this.loadRef(TMP0, f.a[i]);
    this.loadRef(TMP1, f.b[i]);
    this.toFp(FTMP0, TMP0, dbl);
    this.toFp(FTMP1, TMP1, dbl);
    if (fb !== undefined) {
      fb(buf, dbl, FRES, FTMP0, FTMP1);
      this.fromFp(RES, FRES, dbl);
      return this.def(i, RES);
    }
    buf.emit(a.fcmp(dbl, FTMP0, FTMP1), a.cset(1, RES, fc));
    return this.def(i, RES);
  }

  /** 结果是浮点的那几种 CVT。 */
  cvtToFloat(i, dbl) {
    const f = this.f;
    const buf = this.buf;
    const mode = f.aux[i];
    const src = this.typeOfRef(f.a[i]);
    this.loadRef(TMP0, f.a[i]);
    /* 位重解释在这一层是**一条 mov**：栈位里躺的本来就是位模式。 */
    if (mode === CVT_BITCAST) {
      buf.emit(a.movReg(1, RES, TMP0));
      return this.def(i, RES);
    }
    if (mode === CVT_I2F || mode === CVT_U2F) {
      const sf = intBits(src) === 64 ? 1 : 0;
      this.buf.emit(mode === CVT_I2F ? a.scvtf(sf, dbl, FRES, TMP0)
        : a.ucvtf(sf, dbl, FRES, TMP0));
      this.fromFp(RES, FRES, dbl);
      return this.def(i, RES);
    }
    if (mode === CVT_FCVT) {
      /* 源的宽度与目标的宽度一定相反（同宽的 fcvt 没有意义，MIR 也不该发）。 */
      const srcDbl = typeKind(src) === T_F64;
      if (srcDbl === dbl) return nyi('同宽的 CVT_FCVT');
      this.toFp(FTMP0, TMP0, srcDbl);
      buf.emit(dbl ? a.fcvtSD(FRES, FTMP0) : a.fcvtDS(FRES, FTMP0));
      this.fromFp(RES, FRES, dbl);
      return this.def(i, RES);
    }
    return nyi(`结果是浮点的 CVT 模式 ${mode}`);
  }

  cvt(i) {
    const f = this.f;
    const buf = this.buf;
    const mode = f.aux[i];
    this.loadRef(TMP0, f.a[i]);
    /* 浮点 -> 整数（向零取整，C 的强制转换就是这一种）。`t` 是整数所以落在这儿。 */
    if (mode === CVT_F2I) {
      const srcDbl = typeKind(this.typeOfRef(f.a[i])) === T_F64;
      const w = widthOf(f.t[i]);
      this.toFp(FTMP0, TMP0, srcDbl);
      buf.emit(a.fcvtzs(w === 64 ? 1 : 0, srcDbl, RES, FTMP0));
      return this.def(i, RES, w);
    }
    /* 位重解释：栈位里躺的就是位模式，一条 mov。 */
    if (mode === CVT_BITCAST) {
      buf.emit(a.movReg(1, RES, TMP0));
      return this.def(i, RES);
    }
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

  /** 真址 = 地址本身 + 静态偏移，算进 `reg`。地址就是真指针 —— 见文件上头那段。 */
  memAddr(reg, ref, off) {
    this.loadRef(reg, ref);
    if (off === 0) return;
    if (off < 4096) {
      this.buf.emit(a.addImm(1, reg, reg, off));
      return;
    }
    /* 静态偏移大过一格立即数就先造出来 —— 用 TMP1 当中转（这两条路上它都还没被占）。 */
    this.movImm(TMP1, BigInt(off));
    this.buf.emit(a.addReg(1, reg, reg, TMP1));
  }

  /**
   * `MLOAD`。九种宽度符号（`MLOAD_KINDS`）落成六条指令：
   *
   * - 符号扩展的三种走 `ldrsb`/`ldrsh`/`ldrsw`，一律**扩到 64 位** —— i32 的规范形是
   *   符号扩展过的 64 位，所以扩到 x 正好两种结果类型通用；
   * - 零扩展的三种走 `ldrb`/`ldrh`/`ldr w`（w 系的加载天然把高 32 位清零）；
   * - `f32`/`f64` 也走**整数**加载：栈位里躺的是位模式，不必绕 FP 寄存器。
   *
   * 静态偏移一律折进地址，不进 `ldr` 的立即数格：那一格是**按宽度缩放**的，而 C 的
   * `p->field` 给的偏移未必是宽度的倍数（`struct { char c; int i; }` 的 `i` 在 4，
   * 按 4 缩放正好，但 `short` 数组里的第三个元素在 6，按 8 缩放就除不尽）。折进地址
   * 是一条 `add`，比在这儿分情况稳。
   */
  mload(i) {
    const f = this.f;
    const kind = MLOAD_KINDS[memKindNo(f.aux[i])];
    this.memAddr(TMP0, f.a[i], memOff(f.aux[i]));
    const ld = MLOAD_EMIT[kind];
    if (ld === undefined) return nyi(`MLOAD 的宽度 ${kind}`);
    ld(this.buf, RES, TMP0);
    return this.def(i, RES);
  }

  /** `MSTORE`。六种宽度只管「把低若干位拍进内存」，没有符号可言（与 wasm 同）。 */
  mstore(i) {
    const f = this.f;
    const kind = MSTORE_KINDS[memKindNo(f.aux[i])];
    const size = MSTORE_SIZE[kind];
    if (size === undefined) return nyi(`MSTORE 的宽度 ${kind}`);
    this.loadRef(TMP1, f.b[i]);
    /* 先取值再算地址：`memAddr` 在偏移大的时候要借 TMP1，所以值得换个落脚点。 */
    this.buf.emit(a.movReg(1, RES, TMP1));
    this.memAddr(TMP0, f.a[i], memOff(f.aux[i]));
    this.buf.emit(a.strU(size, RES, TMP0, 0));
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

/* 浮点的二目。`dbl` 直接就是编码器要的那一位。 */
const FBIN = {};
FBIN[OP.ADD] = (b, dbl, d, x, y) => b.emit(a.fadd(dbl, d, x, y));
FBIN[OP.SUB] = (b, dbl, d, x, y) => b.emit(a.fsub(dbl, d, x, y));
FBIN[OP.MUL] = (b, dbl, d, x, y) => b.emit(a.fmul(dbl, d, x, y));
FBIN[OP.DIV] = (b, dbl, d, x, y) => b.emit(a.fdiv(dbl, d, x, y));

/**
 * 浮点比较 -> 条件码。**不能照抄整数那张表**：`fcmp` 遇上 NaN 会把标志位置成
 * 「无序」（C=1、V=1、Z=0、N=0），而 C/IEEE 要求除了 `!=` 之外**所有**比较对 NaN
 * 都是假。于是：
 *   - `<` 用 `mi`（N==1）而不是 `lt`（N!=V）—— 无序时 N=0、V=1，`lt` 会**为真**；
 *   - `<=` 用 `ls`（C==0 或 Z==1）而不是 `le`，同一个道理；
 *   - `>`/`>=` 用 `gt`/`ge` 就对（它们都要 N==V，无序时不成立）；
 *   - `==`/`!=` 用 `eq`/`ne`：无序时 Z=0，于是 `==` 假、`!=` 真，正是 C 要的。
 * 这一格是「照抄整数表就会错、而且只在 NaN 上错」的地方，所以用例里有 NaN。
 */
const FCMP = {};
FCMP[OP.EQ] = a.COND.eq;
FCMP[OP.NE] = a.COND.ne;
FCMP[OP.LT] = a.COND.mi;
FCMP[OP.LE] = a.COND.ls;
FCMP[OP.GT] = a.COND.gt;
FCMP[OP.GE] = a.COND.ge;

/* 线性内存的九种读。`ldrs*` 一律扩到 64 位（i32 的规范形就是那个样子），
 * 零扩展的三种与两种浮点都走整数加载 —— 栈位里躺的是位模式。 */
const MLOAD_EMIT = {
  i8s: (b, d, p) => b.emit(a.ldrsU(0, d, p, 0)),
  i8u: (b, d, p) => b.emit(a.ldrU(0, d, p, 0)),
  i16s: (b, d, p) => b.emit(a.ldrsU(1, d, p, 0)),
  i16u: (b, d, p) => b.emit(a.ldrU(1, d, p, 0)),
  i32s: (b, d, p) => b.emit(a.ldrsU(2, d, p, 0)),
  i32u: (b, d, p) => b.emit(a.ldrU(2, d, p, 0)),
  i64: (b, d, p) => b.emit(a.ldrU(3, d, p, 0)),
  f32: (b, d, p) => b.emit(a.ldrU(2, d, p, 0)),
  f64: (b, d, p) => b.emit(a.ldrU(3, d, p, 0)),
};

/* 六种写 -> `str` 的宽度对数。 */
const MSTORE_SIZE = { i8: 0, i16: 1, i32: 2, i64: 3, f32: 2, f64: 3 };

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
