/* MIR -> x86_64 机器码 —— ADR-0017 第 10 步在这条腿上的那一半，第九刀第十六片。
 *
 * 骨架与 arm64 那一份（`../arm64/from_mir.js`）**同一个**：每个 MIR 值一个八字节栈位，
 * 算之前取进来、算完写回去；结构化控制流靠一个区域栈；一遍过、不回头。
 * 那一份头上关于「为什么不先做寄存器分配」的话在这儿一字不改地成立（tcc 的 `vstack`
 * 也是这一档），所以这儿不重复，只记**两条腿不一样的地方** —— 那才是这一片的内容。
 *
 * 一、帧靠 `rbp`，偏移是负的
 * --------------------------
 * arm64 那边 `sp` 在函数体里一动不动，于是一律 `sp + 正偏移`。x86 这边照 SysV 的常规
 * 用 `rbp` 链（`push rbp; mov rbp,rsp; sub rsp,frame`），格子在 `rbp` **下面**：
 *
 *   高地址  ┌──────────────┐
 *           │ 返回地址      │
 *           │ 调用者的 rbp  │  <- push rbp
 *   rbp ->  ├──────────────┤
 *           │ 槽位 ×M       │   off = -8 * (槽号 + 1)
 *           │ 值的栈位 ×N   │   off = -8 * (槽数 + 下标 + 1)
 *   rsp ->  └──────────────┘
 *
 * 用 `rbp` 而不是 `rsp`：x86 上 `rsp` 是**变长指令的隐含操作数**（`push`/`call` 都动它），
 * 而且 `[rsp + off]` 要多一个 SIB 字节。`rbp` 两样都没有。
 *
 * 二、`call` 之前 `rsp` 必须是 16 的倍数
 * -------------------------------------
 * 进函数时 `rsp % 16 == 8`（返回地址占了 8），`push rbp` 补回 16，再减一个 16 的倍数
 * 还是 16。所以帧一律按 16 对齐 —— 这不是风格，是 ABI：`printf` 那类用 SSE 的 libc
 * 函数会在没对齐的栈上崩掉。
 *
 * 三、`al` 要说清「用了几个向量寄存器」
 * ------------------------------------
 * SysV 要求调**变参**函数之前 `al` = 用掉的 xmm 个数。我们在 `CCALL` 之前一律发一条
 * `mov al, n` —— 被调的是不是变参这一层不知道，而多这一条对非变参函数完全无害
 * （`al` 是调用者保存的）。少这一条，`printf("%d", 1)` 在真机器上会崩。
 *
 * 四、除法要 `cqo`，移位数只认 `cl`
 * --------------------------------
 * x86 的 `idiv` 是「rdx:rax ÷ 操作数」，所以除之前必须 `cqo`（把 rax 的符号铺满 rdx）。
 * 移位只认 `cl` 一个寄存器。两条都是 x86 独有的形状，arm64 那边没有对应物。
 */

import { OmniError } from '../source/diag.js';
import { utf8Bytes } from '../host/utf8.js';
import * as x from './encode.js';
import { REG, ALU, CC, SH, FOP, XMM } from './encode.js';
import { CodeBuf } from './asm.js';
import {
  OP, REF_NONE, isConstRef, T_I32, T_I64, T_BOOL, T_VOID, T_F32, T_F64,
  typeKind, isFloatType, intBits, memKindNo, memOff, MLOAD_KINDS, MSTORE_KINDS,
  CVT_SEXT, CVT_ZEXT, CVT_TRUNC, CVT_SEXT8, CVT_SEXT16,
  CVT_I2F, CVT_U2F, CVT_F2I, CVT_FCVT, CVT_BITCAST, OP_NAMES, hexBytes,
  memArgSize, memArgSse,
} from '../mir/ir.js';

/* 草稿寄存器。挑 r10/r11 是因为它们**既不是实参寄存器、也不是被调用者保存的** ——
 * 于是备实参的时候不会先把自己的草稿踩掉。`rax` 当结果（也是返回值寄存器）。 */
const TMP0 = REG.r10;
const TMP1 = REG.r11;
const RES = REG.rax;
const BP = REG.rbp;
/* 浮点的草稿取 xmm8/xmm9：xmm0-7 是实参寄存器。SysV 里所有 xmm 都是调用者保存的，
 * 所以不必像 arm64 那样避开被调用者保存的那一段（v8-v15）。 */
const FTMP0 = XMM.xmm8;
const FTMP1 = XMM.xmm9;
const FRES = XMM.xmm10;

/** SysV 的整数实参寄存器，**只有六个**（arm64 有八个）。 */
const IARG = [REG.rdi, REG.rsi, REG.rdx, REG.rcx, REG.r8, REG.r9];
/** 浮点实参 xmm0-7，八个。 */
const FARG = [XMM.xmm0, XMM.xmm1, XMM.xmm2, XMM.xmm3, XMM.xmm4, XMM.xmm5, XMM.xmm6, XMM.xmm7];

/** 一个 double / float 的 IEEE 754 位模式。与 arm64 那一份同一个写法。 */
function floatBits(v, size) {
  const dv = new DataView(new ArrayBuffer(8));
  if (size === 4) {
    dv.setFloat32(0, v, true);
    return BigInt(dv.getUint32(0, true));
  }
  dv.setFloat64(0, v, true);
  return dv.getBigUint64(0, true);
}

function nyi(what) {
  throw new OmniError(`x64 后端还不认识 ${what}`);
}

/** 这一片认的类型。bool 在栈位上是 0/1 的 64 位。 */
function widthOf(t) {
  const k = typeKind(t);
  if (k === T_I64 || k === T_BOOL) return 8;
  if (k === T_I32) return 4;
  return nyi(`类型 ${k}`);
}

/**
 * 一次调用的实参各自落在哪儿（第二十三片）。
 *
 * SysV：整数进 rdi rsi rdx rcx r8 r9（**六个**）、浮点进 xmm0-7，放不下的按次序摆在
 * 出参区（`rsp + 0` 起，一格 8 字节）。**变参与固定实参一个待遇** —— 与苹果的 arm64
 * 不同（那边变参一律走栈），所以这儿不看变参分界，只在末尾用 xmm 的个数去填 `al`。
 *
 * 与 arm64 那一份同一个用意：算帧要多大与真的发指令**问同一个函数**。
 */
/**
 * 一整块内容的实参（`ARGMEM`，第四十片）：回 `{size, sse}`，不是这一条就回 null。
 */
function argMemOf(f, ar) {
  if (isConstRef(ar)) return null;
  const i = f.at(ar);
  if (f.op[i] !== OP.ARGMEM) return null;
  return { size: memArgSize(f.aux[i]), sse: memArgSse(f.aux[i]) };
}

/**
 * SysV 的聚合分类（第四十片）：**超过 16 字节整份进 MEMORY**（栈上一格 `align8(n)`），
 * 16 字节以内按八字节一格分 INTEGER / SSE，寄存器**够不够两串一起看** ——
 * 差一个就整份改走栈（规范 3.2.3 第 5 步：任一格分不到寄存器，整个实参进 MEMORY）。
 *
 * 回 `{regs}`（每格一个 `{x}` 或 `{v}`）或 null（走栈）。`ngrn`/`nsse` 由调用方推进。
 */
function classifyMem(mem, ngrn, nsse) {
  if (mem.size > 16) return null;
  const words = Math.ceil(mem.size / 8);
  let needInt = 0;
  let needSse = 0;
  for (let e = 0; e < words; e++) {
    if ((mem.sse & (e === 0 ? 1 : 2)) !== 0) needSse++;
    else needInt++;
  }
  if (ngrn + needInt > IARG.length || nsse + needSse > FARG.length) return null;
  const regs = [];
  let gi = ngrn;
  let si = nsse;
  for (let e = 0; e < words; e++) {
    if ((mem.sse & (e === 0 ? 1 : 2)) !== 0) {
      regs.push({ v: si });
      si++;
    } else {
      regs.push({ x: gi });
      gi++;
    }
  }
  return { regs, ngrn: gi, nsse: si };
}

function argPlaces(mod, f, args) {
  const at = [];
  let ngrn = 0;
  let nsse = 0;
  let stack = 0;
  for (const ar of args) {
    const mem = argMemOf(f, ar);
    if (mem !== null) {
      const c = classifyMem(mem, ngrn, nsse);
      if (c !== null) {
        at.push({ regs: c.regs, size: mem.size });
        ngrn = c.ngrn;
        nsse = c.nsse;
        continue;
      }
      at.push({ off: stack, bytes: mem.size });
      stack += mem.size + (mem.size % 8 === 0 ? 0 : 8 - (mem.size % 8));
      continue;
    }
    const t = f.typeOf(ar, mod.consts);
    if (isFloatType(t)) {
      if (nsse < FARG.length) {
        at.push({ v: nsse });
        nsse++;
        continue;
      }
    } else if (ngrn < IARG.length) {
      at.push({ x: ngrn });
      ngrn++;
      continue;
    }
    at.push({ off: stack });
    stack += 8;
  }
  return { at, stack, nsse };
}

/** 出参区要多大：本函数里最费的那次调用要往栈上摆几个字节（按 16 取整）。 */
function outArgsBytes(mod, f) {
  let most = 0;
  let i = 0;
  while (i < f.count()) {
    const op = f.op[i];
    if (op === OP.CALL || op === OP.CCALL || op === OP.CALLI) {
      most = Math.max(most, argPlaces(mod, f, f.argsOf(f.b[i])).stack);
    }
    i++;
  }
  return most + (most % 16 === 0 ? 0 : 16 - (most % 16));
}

/**
 * 固定形参占掉了几个寄存器、又有几个字节排在**入参区**上（`rbp + 16` 起）。
 *
 * 序言按 `bytes` 把放不下的形参读回来，`VASTART` 三样都要：`gp_offset` 与 `fp_offset`
 * 就是「固定实参已经用掉的那一段」，`overflow_arg_area` 从溢出的固定形参之后起。
 */
function inArgPlaces(f) {
  let ngrn = 0;
  let nsse = 0;
  let bytes = 0;
  for (const p of f.params) {
    const flt = isFloatType(p.t);
    if (flt && nsse < FARG.length) { nsse++; continue; }
    if (!flt && ngrn < IARG.length) { ngrn++; continue; }
    bytes += 8;
  }
  return { ngrn, nsse, bytes };
}

class FnGen {
  constructor(mod, f, buf, callLabels, strSyms) {
    this.mod = mod;
    this.f = f;
    this.buf = buf === undefined ? new CodeBuf() : buf;
    this.callLabels = callLabels === undefined ? null : callLabels;
    this.strSyms = strSyms === undefined ? null : strSyms;
    this.valBase = f.slots.length;
    const cells = this.valBase + f.count();
    let bytes = cells * 8;
    /* 帧块（第十八片）：`rbp` 往下继续挖。**`rbp` 是 16 对齐的** —— 进函数时 `rsp ≡ 8`
     * （返回地址占了 8），`push rbp` 之后回到 16 的整数倍，`mov rbp, rsp` 于是搬来一个
     * 16 对齐的基址。所以「块的偏移是 align 的整数倍」就等于「地址是 align 对齐的」。
     * 注意方向与 arm64 相反：偏移是负的，所以要把**深度**往上取整，再取负。 */
    this.frameOffs = [];
    for (const blk of f.frames) {
      let depth = bytes + blk.size;
      if (depth % blk.align !== 0) depth += blk.align - (depth % blk.align);
      this.frameOffs.push(-depth);
      bytes = depth;
    }
    /* 变参函数还要两块（第二十四片）：
     *  - **寄存器保存区**（176 字节）：6 个整数实参寄存器（0-47）+ 8 个 xmm（48 起每 16
     *    字节一格）。SysV 的变参**先占寄存器**，被调方要把它们泼到栈上才谈得上「下一个」。
     *  - 每条 `VASTART` 一个 24 字节的 `va_list` 结构
     *    `{gp_offset, fp_offset, overflow_arg_area, reg_save_area}`。
     *    前端手里的 `va_list` 是**一个指针**（8 字节），指的就是这个结构 ——
     *    SysV 里 `va_list` 是 `__va_list_tag[1]`，传给 `vfprintf` 时退化成的正是这个指针，
     *    所以两边对得上。 */
    this.regSave = 0;
    this.vaOffs = new Map();
    if (f.variadic) {
      let depth = bytes + 176;
      if (depth % 16 !== 0) depth += 16 - (depth % 16);
      this.regSave = -depth;
      bytes = depth;
    }
    /* 一条 `VASTART` 或 `VACOPY` 一个 24 字节的结构。这个循环**不在** `f.variadic`
     * 里面（第三十二片）：收一个 `va_list` 形参、抄一份自己用的那种函数（`vfprintf`
     * 那个形状）自己不是变参的，可是它照样要一块新的结构 —— 不给它就只能与源共用，
     * 那正是 `va_copy` 要避开的事。 */
    let k = 0;
    while (k < f.count()) {
      if (f.op[k] === OP.VASTART || f.op[k] === OP.VACOPY) {
        bytes += 24;
        this.vaOffs.set(k, -bytes);
      }
      /* 取 struct 的 `VAARG` 也要一块（第四十片，16 字节）：分到寄存器上的那种聚合，
       * 两个八字节在寄存器保存区里**不连着**（整数格在 0-47、xmm 格在 48 起，一格 16），
       * 而 `va_arg` 回的必须是一份连着的内容。所以抄进这一块再把它的地址给出去。 */
      if (f.op[k] === OP.VAARG && f.aux[k] !== 0) {
        bytes += 16;
        this.vaOffs.set(k, -bytes);
      }
      k++;
    }
    this.frame = bytes + (bytes % 16 === 0 ? 0 : 16 - (bytes % 16));
    /* 出参区（第二十三片）：放不下寄存器的实参摆在 `rsp + 0` 起的一块。
     * 与 arm64 那一份的区别只有方向 —— 这里帧是 `rbp` 往下挖的，所以出参区就是**帧的
     * 最低那一段**，`rsp = rbp - frame` 之后它正好从 `rsp` 起。
     * SysV 要求 `call` 那一刻 `rsp` 16 对齐：`frame` 是 16 的整数倍，所以照旧成立。 */
    this.outArgs = outArgsBytes(mod, f);
    this.frame += this.outArgs;
    this.regions = [];
    this.retLabel = this.buf.label();
  }

  /* -------------------------------------------------------------- 位置 */

  slotOff(no) {
    if (!Number.isInteger(no) || no < 0 || no >= this.f.slots.length) {
      throw new OmniError(`x64: 槽号 ${no} 越界`);
    }
    return -8 * (no + 1);
  }

  valOff(i) {
    return -8 * (this.valBase + i + 1);
  }

  /** 第 no 块帧存储的偏移（`FRAME` 的落脚点）。 */
  frameOff(no) {
    const off = this.frameOffs[no];
    if (off === undefined) throw new OmniError(`x64: 帧块号 ${no} 越界`);
    return off;
  }

  frameLoad(reg, off) {
    this.buf.emit(x.movRM(8, reg, BP, off));
  }

  frameStore(reg, off) {
    this.buf.emit(x.movMR(8, BP, off, reg));
  }

  /* -------------------------------------------------------------- 立即数
   * 装得进四字节（符号扩展）就一条 `mov r64, imm32`，否则 `movabs` 的十字节。 */
  movImm(reg, value) {
    const v = BigInt.asIntN(64, BigInt(value));
    if (v >= -(2n ** 31n) && v < 2n ** 31n) {
      this.buf.emit(x.movRI(8, reg, Number(v)));
      return;
    }
    this.buf.emit(x.movAbs(reg, v));
  }

  loadRef(reg, ref) {
    if (ref === REF_NONE) throw new OmniError('x64: 这条指令少了一个操作数');
    if (isConstRef(ref)) {
      const k = this.mod.consts.get(ref);
      if (k.kind === 'int') return this.movImm(reg, BigInt(k.text));
      if (k.kind === 'bool') return this.movImm(reg, k.text === 'true' ? 1n : 0n);
      if (k.kind === 'real') {
        return this.movImm(reg, floatBits(Number(k.text), typeKind(k.t) === T_F32 ? 4 : 8));
      }
      if (k.kind === 'str' || k.kind === 'bytes') return this.buf.leaSym(reg, this.strSym(ref));
      return nyi(`常量 ${k.kind}`);
    }
    this.frameLoad(reg, this.valOff(this.f.at(ref)));
  }

  typeOfRef(ref) {
    return this.f.typeOf(ref, this.mod.consts);
  }

  /** 位模式 -> xmm。`movq` 一条，与 arm64 的 `fmov` 对应。 */
  toFp(fdst, greg) {
    this.buf.emit(x.movqToXmm(fdst, greg));
  }

  /** xmm -> 位模式。 */
  fromFp(gdst, fsrc) {
    this.buf.emit(x.movqFromXmm(gdst, fsrc));
  }

  strSym(ref) {
    const sym = this.strSyms === null ? undefined : this.strSyms.get(ref);
    if (sym === undefined) {
      throw new OmniError('x64: 字符串常量的字节要落在数据段里，得走 genModule');
    }
    return sym;
  }

  /* -------------------------------------------------------------- 区域 */

  region(level) {
    const i = this.regions.length - 1 - level;
    if (i < 0) throw new OmniError(`x64: BR 往外 ${level} 层，可是只有 ${this.regions.length} 层`);
    return this.regions[i];
  }

  brTarget(level) {
    const r = this.region(level);
    return r.kind === 'loop' ? r.contLabel : r.endLabel;
  }

  /* -------------------------------------------------------------- 主体 */

  gen() {
    const f = this.f;
    const buf = this.buf;
    buf.emit(x.push(BP), x.movRR(8, BP, REG.rsp));
    if (this.frame > 0) buf.emit(x.aluRI(ALU.sub, 8, REG.rsp, this.frame));
    /* 变参函数的序言（第二十四片）：把六个整数实参寄存器与八个 xmm **无条件**泼进
     * 寄存器保存区。clang 会先 `test al, al` 再跳过 xmm 那一段；我们不跳 ——
     * 那些寄存器总是在的，多写 128 字节换掉一条分支与一个标签。
     * xmm 借整数草稿过一手（`movq`），省一条「xmm 存内存」的编码。
     * 只泼低 8 字节：C 的变参里 `double` 只用到这些，`__m128` 不在这条腿的范围内。 */
    if (f.variadic) {
      let k = 0;
      while (k < IARG.length) {
        buf.emit(x.movMR(8, BP, this.regSave + k * 8, IARG[k]));
        k++;
      }
      k = 0;
      while (k < FARG.length) {
        this.fromFp(TMP0, FARG[k]);
        buf.emit(x.movMR(8, BP, this.regSave + 48 + k * 16, TMP0));
        k++;
      }
    }
    /* 形参：整数一串（六个）、浮点一串（八个），各自从 0 起数。放不下的从**入参区**
     * 读（第二十三片）：调用方摆在它自己的出参区里，也就是我们这一层 `rbp + 16` 起 ——
     * `rbp + 0` 是存起来的 `rbp`、`rbp + 8` 是返回地址。
     * （与 arm64 那一份的 `fp + 16` 是同一句话，只是两样东西的次序不同。） */
    let ngrn = 0;
    let nsse = 0;
    let inArg = 16;
    for (const p of f.params) {
      const flt = isFloatType(p.t);
      if (flt && nsse < FARG.length) {
        this.fromFp(TMP0, FARG[nsse]);
        this.frameStore(TMP0, this.slotOff(p.slot));
        nsse++;
        continue;
      }
      if (!flt && ngrn < IARG.length) {
        this.frameStore(IARG[ngrn], this.slotOff(p.slot));
        ngrn++;
        continue;
      }
      buf.emit(x.movRM(8, TMP0, BP, inArg));
      this.frameStore(TMP0, this.slotOff(p.slot));
      inArg += 8;
    }

    for (let i = 0; i < f.count(); i++) this.one(i);

    buf.place(this.retLabel);
    buf.emit(x.movRR(8, REG.rsp, BP), x.pop(BP), x.ret());
    return buf;
  }

  one(i) {
    const f = this.f;
    const buf = this.buf;
    const op = f.op[i];
    const t = f.t[i];

    /* ---- 控制流。与 arm64 那一份逐条对应，只是 `cbz` 换成 `test` + `jz`
     * （x86 没有「寄存器为零就跳」的单条指令）。 */
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
      buf.emit(x.testRR(8, TMP0, TMP0));
      buf.jcc(CC.e, elseLabel);
      this.regions.push({ kind: 'if', endLabel: buf.label(), elseLabel, elseDone: false });
      return;
    }
    if (op === OP.ELSE) {
      const r = this.regions[this.regions.length - 1];
      if (r === undefined || r.kind !== 'if') throw new OmniError('x64: ELSE 没有对应的 IF');
      buf.jmp(r.endLabel);
      buf.place(r.elseLabel);
      r.elseDone = true;
      return;
    }
    if (op === OP.END) {
      const r = this.regions.pop();
      if (r === undefined) throw new OmniError('x64: END 多了一条');
      if (r.kind === 'if' && !r.elseDone) buf.place(r.elseLabel);
      buf.place(r.endLabel);
      return;
    }
    if (op === OP.BR) {
      buf.jmp(this.brTarget(f.aux[i]));
      return;
    }
    if (op === OP.BRIF) {
      this.loadRef(TMP0, f.a[i]);
      buf.emit(x.testRR(8, TMP0, TMP0));
      buf.jcc(CC.ne, this.brTarget(f.aux[i]));
      return;
    }
    /* `BRTABLE`（第十九片）：与 arm64 同一个办法 —— **比较链**。真跳表要在数据段里摆
     * 一串地址（x86 上还得走 `SIGNED` 重定位），比较链一笔重定位都不欠。 */
    if (op === OP.BRTABLE) {
      this.loadRef(TMP0, f.a[i]);
      const levels = f.levelsOf(f.b[i]);
      let k = 0;
      for (const lv of levels) {
        buf.emit(x.aluRI(ALU.cmp, 8, TMP0, k));
        buf.jcc(CC.e, this.brTarget(lv));
        k++;
      }
      buf.jmp(this.brTarget(f.aux[i]));
      return;
    }
    if (op === OP.RET) {
      if (f.a[i] !== REF_NONE) {
        this.loadRef(TMP0, f.a[i]);
        /* 浮点的返回值在 xmm0，整数在 rax。i32 的规范形是符号扩展过的 64 位，
         * 而 SysV 只看 eax —— 两边都对，不用再削。 */
        if (isFloatType(t)) this.toFp(FARG[0], TMP0);
        else buf.emit(x.movRR(8, RES, TMP0));
      }
      buf.jmp(this.retLabel);
      return;
    }

    /* ---- 调用 */
    if (op === OP.CALL) {
      if (this.callLabels === null) nyi('单个函数里的 CALL（要按整个模块生成才有落点）');
      this.callArgs(f.argsOf(f.b[i]));
      const label = this.callLabels[f.a[i]];
      if (label === undefined) throw new OmniError(`x64: 没有 ${f.a[i]} 号函数`);
      buf.call(label);
      return this.callRet(i, t);
    }
    if (op === OP.CCALL) {
      const name = this.mod.cabi[f.a[i]];
      if (name === undefined) throw new OmniError(`x64: 没有 ${f.a[i]} 号 C 入口`);
      /* aux 是变参分界（第二十二片），**x86_64 用不着它**：SysV 把变参也放寄存器里，
       * 与固定实参一个待遇；要报的只有 `al`（xmm 个数），而那一条对非变参函数无害，
       * 所以一律发。苹果的 arm64 不一样（变参走栈），那一边才要看 aux。 */
      this.callArgs(f.argsOf(f.b[i]), true);
      buf.callSym(name);
      return this.callRet(i, t);
    }
    /* `CALLI` 是**按指针调用**（第二十七片）：native 上函数指针就是真地址，一条
     * `call *r`。次序与 arm64 那份一样 —— 先摆实参，再取目标进草稿（r10 不是实参
     * 寄存器，所以摆好的实参不会被这一步踩掉）。`al` 照旧报 xmm 个数：被调的是不是
     * 变参这一层不知道，多发一条无害。 */
    if (op === OP.CALLI) {
      if (!this.mod.native) nyi('CALLI（解释器那条腿上函数指针是「号 + 1」，不是地址）');
      this.callArgs(f.argsOf(f.b[i]), true);
      this.loadRef(TMP0, f.a[i]);
      buf.emit(x.callR(TMP0));
      return this.callRet(i, t);
    }
    /* 一个函数的**地址**（第二十七片）：与 `GADDR` 一样是一条 RIP 相对的 `lea`，
     * 只是符号在 `__TEXT` 里。 */
    if (op === OP.FADDR) {
      buf.leaSym(RES, this.funcSym(f.aux[i]));
      return this.def(i, RES);
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

    /* ---- 帧上的一块（第十八片）。x86_64 上是**一条** `lea` —— 与 arm64 的
     * 「adrp + add」不同，这里基址就在寄存器里（`rbp`），偏移是 disp32，硬件自己加。 */
    if (op === OP.FRAME) {
      buf.emit(x.lea(8, RES, BP, this.frameOff(f.aux[i])));
      return this.def(i, RES);
    }

    /* ---- 变参的定义那一侧（第二十四片）。SysV 的 `va_list` 是个 24 字节的结构，
     * 于是这两条比 arm64 那边长得多 —— 长出来的全是「这个实参当初进了寄存器还是栈」
     * 这一笔账。 */
    if (op === OP.VASTART) {
      const vl = this.vaOffs.get(i);
      if (vl === undefined) throw new OmniError('x64: VASTART 没有分到 va_list 的位置');
      const p = inArgPlaces(f);
      /* 固定实参用掉的那一段先记上：`va_arg` 从这儿往后数。 */
      buf.emit(x.movRI(4, TMP1, 8 * p.ngrn), x.movMR(4, BP, vl, TMP1));
      buf.emit(x.movRI(4, TMP1, 48 + 16 * p.nsse), x.movMR(4, BP, vl + 4, TMP1));
      /* 溢到栈上的实参从入参区、固定形参之后起。 */
      buf.emit(x.lea(8, TMP1, BP, 16 + p.bytes), x.movMR(8, BP, vl + 8, TMP1));
      buf.emit(x.lea(8, TMP1, BP, this.regSave), x.movMR(8, BP, vl + 16, TMP1));
      /* 前端手里那个 8 字节的 `va_list` 装的是这个结构的地址。 */
      this.loadRef(TMP0, f.a[i]);
      buf.emit(x.lea(8, TMP1, BP, vl), x.movMR(8, TMP0, 0, TMP1));
      return;
    }
    if (op === OP.VAARG) {
      /* 取 struct（aux > 0）：SysV 的分类在这儿真的要算一遍（第四十片）。
       *
       *  - 超过 16 字节：整份进 MEMORY，只在**溢出区**里躺着 —— 取它的地址、游标往前推
       *    `align8(n)`，一条访存都不用发。
       *  - 16 字节以内：按八字节分 INTEGER / SSE。两串寄存器**够不够一起看**，够就从
       *    寄存器保存区里取。可那两格在保存区里**不连着**（整数格在 0-47、xmm 格在 48 起
       *    一格 16 字节），而 `va_arg` 回的必须是连着的一份 —— 所以抄进帧里那 16 字节
       *    （见 `vaOffs`）再把它的地址给出去。不够就整份从溢出区取。
       *
       * 「够不够」要在运行时判：同一条 `va_arg` 在循环里会被走多次，而游标是变的。 */
      if (f.aux[i] !== 0) {
        const n = memArgSize(f.aux[i]);
        const sseMask = memArgSse(f.aux[i]);
        const step = n + (n % 8 === 0 ? 0 : 8 - (n % 8));
        this.loadRef(TMP0, f.a[i]);
        buf.emit(x.movRM(8, TMP0, TMP0, 0));            // TMP0 = 那个 24 字节结构的地址
        /* 从溢出区取一份：地址就是 `overflow_arg_area`，之后往前推一格。 */
        const fromStack = () => {
          buf.emit(x.movRM(8, RES, TMP0, 8));
          buf.emit(x.movRR(8, TMP1, RES), x.aluRI(ALU.add, 8, TMP1, step));
          buf.emit(x.movMR(8, TMP0, 8, TMP1));
        };
        if (n > 16) {
          fromStack();
          return this.def(i, RES);
        }
        const words = Math.ceil(n / 8);
        const isSse = (e) => (sseMask & (e === 0 ? 1 : 2)) !== 0;
        let needInt = 0;
        let needSse = 0;
        for (let e = 0; e < words; e++) if (isSse(e)) needSse++; else needInt++;
        const dst = this.vaOffs.get(i);
        if (dst === undefined) throw new OmniError('x64: 取 struct 的 VAARG 没有分到那一块');
        const over = buf.label();
        const done = buf.label();
        /* 两串各自的余量：`gp_offset <= 48 - 8*needInt`、`fp_offset <= 176 - 16*needSse`。
         * 任一串不够就整份走溢出区（规范 3.2.3 第 5 步）。 */
        if (needInt > 0) {
          buf.emit(x.movRM(4, TMP1, TMP0, 0), x.aluRI(ALU.cmp, 4, TMP1, 48 - 8 * needInt));
          buf.jcc(CC.a, over);
        }
        if (needSse > 0) {
          buf.emit(x.movRM(4, TMP1, TMP0, 4), x.aluRI(ALU.cmp, 4, TMP1, 176 - 16 * needSse));
          buf.jcc(CC.a, over);
        }
        for (let e = 0; e < words; e++) {
          const field = isSse(e) ? 4 : 0;
          const grow = isSse(e) ? 16 : 8;
          buf.emit(x.movRM(4, TMP1, TMP0, field), x.movRM(8, RES, TMP0, 16));
          buf.emit(x.aluRR(ALU.add, 8, RES, TMP1));     // RES = reg_save_area + 偏移
          buf.emit(x.movRM(8, TMP1, RES, 0), x.movMR(8, BP, dst + e * 8, TMP1));
          buf.emit(x.movRM(4, TMP1, TMP0, field), x.aluRI(ALU.add, 4, TMP1, grow));
          buf.emit(x.movMR(4, TMP0, field, TMP1));
        }
        buf.emit(x.lea(8, RES, BP, dst));
        buf.jmp(done);
        buf.place(over);
        fromStack();
        buf.place(done);
        return this.def(i, RES);
      }
      const flt = isFloatType(t);
      const field = flt ? 4 : 0;          // gp_offset 在 0、fp_offset 在 4
      const limit = flt ? 176 : 48;       // 越过这条线就说明寄存器那一段用完了
      const step = flt ? 16 : 8;          // xmm 一格 16 字节，整数一格 8
      const over = buf.label();
      const done = buf.label();
      const ldv = (ptr) => {
        if (typeKind(t) === T_I32) buf.emit(x.movsxM(8, 4, RES, ptr, 0));
        else buf.emit(x.movRM(8, RES, ptr, 0));
      };
      this.loadRef(TMP0, f.a[i]);
      buf.emit(x.movRM(8, TMP0, TMP0, 0));            // TMP0 = 结构的地址
      buf.emit(x.movRM(4, TMP1, TMP0, field));
      buf.emit(x.aluRI(ALU.cmp, 4, TMP1, limit));
      buf.jcc(CC.ae, over);
      /* 还在寄存器保存区里：地址 = reg_save_area + 偏移，偏移随后往前推一格。 */
      buf.emit(x.movRM(8, RES, TMP0, 16), x.aluRR(ALU.add, 8, RES, TMP1));
      buf.emit(x.aluRI(ALU.add, 4, TMP1, step), x.movMR(4, TMP0, field, TMP1));
      ldv(RES);
      buf.jmp(done);
      /* 已经溢到栈上：这一路不分整数与浮点，一格一律 8 字节。 */
      buf.place(over);
      buf.emit(x.movRM(8, TMP1, TMP0, 8));
      ldv(TMP1);
      buf.emit(x.aluRI(ALU.add, 8, TMP1, 8), x.movMR(8, TMP0, 8, TMP1));
      buf.place(done);
      return this.def(i, RES);
    }
    /* `va_copy`（第三十二片）：SysV 上要抄的是那个 24 字节的结构**本身**，不是指向它的
     * 指针 —— 抄指针会让两个 ap 共用一个游标，`va_arg(ap2)` 于是把 ap 也推了一格。
     * 所以给 dest 另开一块（帧里那 24 字节，见 `vaOffs`），三个 8 字节抄过去，
     * 最后把新那块的地址写进 dest 那个 va_list 变量。 */
    if (op === OP.VACOPY) {
      const vl = this.vaOffs.get(i);
      if (vl === undefined) throw new OmniError('x64: VACOPY 没有分到 va_list 的位置');
      this.loadRef(TMP0, f.b[i]);
      buf.emit(x.movRM(8, TMP0, TMP0, 0));            // TMP0 = 源结构的地址
      for (let o = 0; o < 24; o += 8) {
        buf.emit(x.movRM(8, TMP1, TMP0, o), x.movMR(8, BP, vl + o, TMP1));
      }
      this.loadRef(TMP0, f.a[i]);
      buf.emit(x.lea(8, TMP1, BP, vl), x.movMR(8, TMP0, 0, TMP1));
      return;
    }

    /* ---- 会动的栈顶（第三十六片）：变长数组与 `alloca`。x86_64 上比 arm64 省事 ——
     * `rsp` 是一个普通可编码的寄存器（`sub rsp, r10` 就是它本来的意思），而槽位与值的
     * 栈位一直是 `rbp` 相对的，所以帧基址那一摊完全不用动。
     *
     * 要让开的只有出参区：被调方按 `rsp` 找走栈的实参，所以块的基址取第一次 `sub` 之后
     * 那个位置，再往下降 `outArgs` 个字节当新的 `rsp`。 */
    if (op === OP.SPGET) {
      buf.emit(x.movRR(8, RES, REG.rsp));
      return this.def(i, RES);
    }
    if (op === OP.SPSET) {
      this.loadRef(TMP0, f.a[i]);
      buf.emit(x.movRR(8, REG.rsp, TMP0));
      return;
    }
    /* 变参里的一整块内容（第三十九片）：这一条本身**不发访存** —— 内容什么时候拷、
     * 拷到哪儿（寄存器还是溢出区），是调用那一头按分类决定的（`callArgs`）。
     * 这儿只把地址落到自己的栈位上。 */
    if (op === OP.ARGMEM) {
      this.loadRef(RES, f.a[i]);
      return this.def(i, RES);
    }
    if (op === OP.SPALLOC) {
      this.loadRef(TMP0, f.a[i]);
      buf.emit(x.aluRR(ALU.sub, 8, REG.rsp, TMP0));
      buf.emit(x.movRR(8, RES, REG.rsp));
      if (this.outArgs > 0) buf.emit(x.aluRI(ALU.sub, 8, REG.rsp, this.outArgs));
      return this.def(i, RES);
    }

    /* ---- 模块级变量。x86_64 上一条 RIP 相对的 `mov` 就够 —— 不必先取址
     * （arm64 那边 `ldr` 的立即数格装不下符号，所以要 `adrp`+`add` 两条）。 */
    if (op === OP.GLOAD) {
      const key = widthKey(t);
      const gno = f.aux[i];
      /* 外部的全局量（第三十一片）：地址得先过 GOT 取出来，再从那个地址读 ——
       * `mov RES, sym(%rip)` 这条路走不通（链接期没有它的地址）。 */
      if (this.isExternGlobal(gno)) {
        buf.loadSymGot(TMP0, this.globalSym(gno));
        MLOAD_EMIT[key === 'i32' ? 'i32s' : key](buf, RES, TMP0);
        return this.def(i, RES);
      }
      const sym = this.globalSym(gno);
      if (key === 'i32') {
        /* i32 的规范形是符号扩展过的 64 位，而 `movslq sym(%rip)` 我们没有 ——
         * 先读四字节（零扩展），再一条 `movslq` 扩成规范形。 */
        buf.loadSym(4, RES, sym);
        buf.emit(x.movsx(8, 4, RES, RES));
      } else if (key === 'f32') {
        /* f32 的栈位里躺的是**四字节的位模式**，高位清零 —— 读四字节正好。 */
        buf.loadSym(4, RES, sym);
      } else {
        buf.loadSym(8, RES, sym);
      }
      return this.def(i, RES);
    }
    if (op === OP.GSTORE) {
      this.loadRef(RES, f.a[i]);
      const gno = f.aux[i];
      const size = STORE_SIZE[widthKey(f.t[i])];
      if (this.isExternGlobal(gno)) {
        buf.loadSymGot(TMP0, this.globalSym(gno));
        buf.emit(x.movMR(size, TMP0, 0, RES));
        return;
      }
      buf.storeSym(size, this.globalSym(gno), RES);
      return;
    }
    /* 全局的**地址**（第二十一片）：x86_64 上就是一条 `leaq sym(%rip)`。 */
    if (op === OP.GADDR) {
      const gno = f.aux[i];
      if (this.isExternGlobal(gno)) buf.loadSymGot(RES, this.globalSym(gno));
      else buf.leaSym(RES, this.globalSym(gno));
      return this.def(i, RES);
    }

    /* ---- 存取。地址就是真指针 —— native 上没有线性内存（arm64 那份头上那段）。 */
    if (op === OP.MLOAD) return this.mload(i);
    if (op === OP.MSTORE) return this.mstore(i);

    /* ---- 浮点 */
    if (isFloatType(t)) return this.float(i);

    /* ---- 单目 */
    if (op === OP.NEG) {
      const w = widthOf(t);
      this.loadRef(RES, f.a[i]);
      buf.emit(x.negR(w, RES));
      return this.def(i, RES, w);
    }
    if (op === OP.BNOT) {
      const w = widthOf(t);
      this.loadRef(RES, f.a[i]);
      buf.emit(x.notR(w, RES));
      return this.def(i, RES, w);
    }
    if (op === OP.NOT) {
      this.loadRef(RES, f.a[i]);
      buf.emit(x.aluRI(ALU.xor, 8, RES, 1));
      return this.def(i, RES);
    }

    /* ---- 二目。三类形状（一般的、除/取余、移位）在 `bin` 里分流。 */
    if (BIN[op] !== undefined || DIVLIKE[op] !== undefined || SHIFT[op] !== undefined) {
      return this.bin(i);
    }

    /* ---- 比较：`t` 是操作数的类型，产出永远是 0/1 的 bool */
    const cond = CMP[op];
    if (cond !== undefined) {
      const w = widthOf(t);
      this.loadRef(TMP0, f.a[i]);
      this.loadRef(TMP1, f.b[i]);
      buf.emit(x.aluRR(ALU.cmp, w, TMP0, TMP1));
      buf.emit(x.setcc(cond, RES), x.movzx(8, 1, RES, RES));
      return this.def(i, RES);
    }

    if (op === OP.CVT) return this.cvt(i);

    return nyi(`MIR 指令 ${OP_NAMES[op]}`);
  }

  /**
   * 二目运算。三类各有自己的形状，所以不像 arm64 那样一张表打完：
   *  - 一般的（加减乘与位运算）：两个操作数进 rax 与 r11，一条指令；
   *  - 除与取余：被除数必须在 **rax**、要先 `cqo` 铺符号、商在 rax 余数在 rdx；
   *  - 移位：移位数必须在 **cl**。
   */
  bin(i) {
    const f = this.f;
    const buf = this.buf;
    const op = f.op[i];
    const w = widthOf(f.t[i]);

    if (DIVLIKE[op] !== undefined) {
      const d = DIVLIKE[op];
      this.loadRef(RES, f.a[i]);
      this.loadRef(TMP1, f.b[i]);
      if (d.signed) buf.emit(w === 8 ? x.cqo() : x.cdq());
      /* 无符号除法要把 rdx 清零（`div` 用的是 rdx:rax 这个双字）。 */
      else buf.emit(x.aluRR(ALU.xor, 8, REG.rdx, REG.rdx));
      buf.emit(d.signed ? x.idivR(w, TMP1) : x.divR(w, TMP1));
      if (d.rem) buf.emit(x.movRR(8, RES, REG.rdx));
      return this.def(i, RES, w);
    }

    if (SHIFT[op] !== undefined) {
      this.loadRef(RES, f.a[i]);
      this.loadRef(REG.rcx, f.b[i]);
      buf.emit(x.shiftRCl(SHIFT[op], w, RES));
      return this.def(i, RES, w);
    }

    this.loadRef(RES, f.a[i]);
    this.loadRef(TMP1, f.b[i]);
    BIN[op](buf, w, RES, TMP1);
    return this.def(i, RES, w);
  }

  /** 实参就位：整数一串（六个）、浮点一串（八个）。`variadic` 时还要报 xmm 的个数。 */
  callArgs(args, variadic) {
    const p = argPlaces(this.mod, this.f, args);
    let k = 0;
    for (const ar of args) {
      const place = p.at[k];
      k++;
      /* 走栈的：一格 8 字节，摆在出参区里（`rsp + off`）。 */
      if (place.off !== undefined) {
        /* 一整块内容进 MEMORY（`ARGMEM`，第四十片）：按 8/4/2/1 递降着拷，
         * **不拷到格子末尾** —— 格子补齐到 8，源没有那么长（arm64 那边同一条）。 */
        if (place.bytes !== undefined) {
          this.loadRef(TMP0, ar);
          let at = 0;
          for (const w of [8, 4, 2, 1]) {
            while (place.bytes - at >= w) {
              this.buf.emit(x.movRM(w, TMP1, TMP0, at), x.movMR(w, REG.rsp, place.off + at, TMP1));
              at += w;
            }
          }
          continue;
        }
        this.loadRef(TMP0, ar);
        this.buf.emit(x.movMR(8, REG.rsp, place.off, TMP0));
        continue;
      }
      /* 一整块内容分到了寄存器上：一格一个，整数格进 IARG、浮点格进 xmm。
       * **整格读满 8 字节**，末格不满也一样 —— 寄存器里的高位无所谓（SysV 明说），
       * 而 tcc 那边（`gfunc_call` 的 x86_64 那一支）也是按 8 字节一格读的。
       * 能这么读是因为进寄存器的聚合最多 16 字节，而它的对齐把那一格垫满了。 */
      if (place.regs !== undefined) {
        this.loadRef(TMP0, ar);
        let e = 0;
        for (const r of place.regs) {
          if (r.x !== undefined) this.buf.emit(x.movRM(8, IARG[r.x], TMP0, e * 8));
          else {
            this.buf.emit(x.movRM(8, TMP1, TMP0, e * 8));
            this.toFp(FARG[r.v], TMP1);
          }
          e++;
        }
        continue;
      }
      if (place.v !== undefined) {
        this.loadRef(TMP0, ar);
        this.toFp(FARG[place.v], TMP0);
        continue;
      }
      this.loadRef(IARG[place.x], ar);
    }
    /* SysV：调变参函数之前 `al` 要等于用掉的 xmm 个数。被调的是不是变参这一层不知道，
     * 所以外部调用一律发这一条 —— 对非变参函数完全无害，少了它 `printf` 会崩。 */
    if (variadic === true) this.buf.emit(x.movRI(1, RES, p.nsse));
  }

  callRet(i, t) {
    if (typeKind(t) === T_VOID) return;
    if (isFloatType(t)) {
      this.fromFp(RES, FARG[0]);
      return this.def(i, RES);
    }
    /* i32 的返回值要按规范形符号扩展：SysV 只保证 eax 有值。 */
    return this.def(i, RES, widthOf(t));
  }

  globalSym(no) {
    const name = this.mod.globals[no];
    if (name === undefined) throw new OmniError(`x64: 没有 ${no} 号模块级变量`);
    return name;
  }

  /** 这个全局是外部的吗（第三十一片）——是就得过 GOT，不能 RIP 相对直取。 */
  isExternGlobal(no) {
    const blob = this.mod.globalBlob[no];
    return blob !== null && blob.extern === true;
  }

  /** 一个函数的符号名（`FADDR` 用）。 */
  funcSym(no) {
    const fn = this.mod.funcs[no];
    if (fn === undefined) throw new OmniError(`x64: 没有 ${no} 号函数`);
    return fn.name;
  }

  /** 真址 = 地址本身 + 静态偏移，算进 `reg`。 */
  memAddr(reg, ref, off) {
    this.loadRef(reg, ref);
    if (off === 0) return;
    this.buf.emit(x.aluRI(ALU.add, 8, reg, off));
  }

  /**
   * `MLOAD`。九种宽度落成五条指令：
   *  - 符号扩展的三种走 `movsx`（一律扩到 64 位 —— i32 的规范形就是那个样子）；
   *  - 零扩展的 i8u/i16u 走 `movzx`；
   *  - i32u 走 `mov r32`（32 位的 mov 天然把高 32 位清零）；
   *  - i64 与两种浮点走 `mov r64`/`mov r32` —— 栈位里躺的是位模式，不绕 xmm。
   *
   * 静态偏移折进地址（`add`），不进 ModRM 的位移格：那一格能装，但折进地址与 arm64
   * 那份的做法一致，也少一处「偏移大小要分情况」的分支。
   */
  mload(i) {
    const f = this.f;
    const kind = MLOAD_KINDS[memKindNo(f.aux[i])];
    const ld = MLOAD_EMIT[kind];
    if (ld === undefined) return nyi(`MLOAD 的宽度 ${kind}`);
    this.memAddr(TMP0, f.a[i], memOff(f.aux[i]));
    ld(this.buf, RES, TMP0);
    return this.def(i, RES);
  }

  /** `MSTORE`。六种宽度只管「把低若干位拍进内存」。 */
  mstore(i) {
    const f = this.f;
    const kind = MSTORE_KINDS[memKindNo(f.aux[i])];
    const size = MSTORE_SIZE[kind];
    if (size === undefined) return nyi(`MSTORE 的宽度 ${kind}`);
    this.loadRef(RES, f.b[i]);
    this.memAddr(TMP0, f.a[i], memOff(f.aux[i]));
    this.buf.emit(x.movMR(size, TMP0, 0, RES));
  }

  /**
   * `t` 是浮点的那些指令。值照旧躺在八字节的栈位里（躺的是位模式），
   * 进 xmm 一条 `movq`、出来再一条。
   */
  float(i) {
    const f = this.f;
    const buf = this.buf;
    const op = f.op[i];
    const dbl = typeKind(f.t[i]) === T_F64;
    if (op === OP.CVT) return this.cvtToFloat(i, dbl);
    if (op === OP.NEG) {
      /* x86 没有 `fneg`：把符号位**异或**掉。掩码只有一位是 1，走整数寄存器造。 */
      this.loadRef(TMP0, f.a[i]);
      this.toFp(FTMP0, TMP0);
      this.movImm(TMP1, dbl ? -(2n ** 63n) : BigInt(2 ** 31));
      this.toFp(FTMP1, TMP1);
      buf.emit(x.fxor(dbl, FTMP0, FTMP1));
      this.fromFp(RES, FTMP0);
      return this.def(i, RES);
    }
    const fb = FBIN[op];
    const fc = FCMP[op];
    if (fb === undefined && fc === undefined) return nyi(`浮点的 ${OP_NAMES[op]}`);
    this.loadRef(TMP0, f.a[i]);
    this.loadRef(TMP1, f.b[i]);
    this.toFp(FTMP0, TMP0);
    this.toFp(FTMP1, TMP1);
    if (fb !== undefined) {
      buf.emit(x.fbin(fb, dbl, FTMP0, FTMP1));
      this.fromFp(RES, FTMP0);
      return this.def(i, RES);
    }
    return this.fcmp(i, dbl, fc);
  }

  /**
   * 浮点比较。`ucomisd` 把结果放进 ZF/PF/CF，而**不可比（NaN）时 PF=1、ZF=1、CF=1**。
   * 于是：
   *  - `<`/`<=` 要**换操作数**再取 `a`/`ae`（「above」要求 CF=0，NaN 时 CF=1，于是为假）；
   *  - `>`/`>=` 直接取 `a`/`ae`；
   *  - `==` 是 `ZF=1 且 PF=0`、`!=` 是 `ZF=0 或 PF=1` —— 两条 `setcc` 加一条与/或。
   *
   * 照抄整数那张表（`l`/`le`/`e`）会错，而且**只在 NaN 上错**：`l` 看的是 SF≠OF，
   * 而 `ucomisd` 根本不动 SF/OF。所以这张表是重新想过的，不是抄的。
   */
  fcmp(i, dbl, fc) {
    const buf = this.buf;
    /* `swap` 的那两条：比的是 (b, a) 而不是 (a, b)。 */
    buf.emit(x.fcmp(dbl, fc.swap ? FTMP1 : FTMP0, fc.swap ? FTMP0 : FTMP1));
    if (fc.pf === undefined) {
      buf.emit(x.setcc(fc.cc, RES), x.movzx(8, 1, RES, RES));
      return this.def(i, RES);
    }
    /* `==`/`!=`：两个条件合起来。用 r10/r11 的低字节 —— 这时它们的旧值已经不要了。 */
    buf.emit(x.setcc(fc.cc, TMP0), x.setcc(fc.pf, TMP1));
    buf.emit(x.aluRR(fc.join, 1, TMP0, TMP1));
    buf.emit(x.movzx(8, 1, RES, TMP0));
    return this.def(i, RES);
  }

  /** 结果是浮点的那几种 CVT。 */
  cvtToFloat(i, dbl) {
    const f = this.f;
    const buf = this.buf;
    const mode = f.aux[i];
    const src = this.typeOfRef(f.a[i]);
    this.loadRef(TMP0, f.a[i]);
    if (mode === CVT_BITCAST) {
      buf.emit(x.movRR(8, RES, TMP0));
      return this.def(i, RES);
    }
    if (mode === CVT_I2F) {
      buf.emit(x.cvtI2F(dbl, intBits(src) === 64 ? 8 : 4, FTMP0, TMP0));
      this.fromFp(RES, FTMP0);
      return this.def(i, RES);
    }
    if (mode === CVT_U2F) {
      /* x86 没有「无符号 -> 浮点」的指令。32 位的够办：零扩展成 64 位再走**有符号**那条
       * （零扩展之后的值一定是正的）。 */
      if (intBits(src) === 64) return this.u64ToFloat(i, dbl);
      buf.emit(x.movRR(4, TMP0, TMP0));
      buf.emit(x.cvtI2F(dbl, 8, FTMP0, TMP0));
      this.fromFp(RES, FTMP0);
      return this.def(i, RES);
    }
    if (mode === CVT_FCVT) {
      const srcDbl = typeKind(src) === T_F64;
      if (srcDbl === dbl) return nyi('同宽的 CVT_FCVT');
      this.toFp(FTMP0, TMP0);
      buf.emit(x.cvtF2F(srcDbl, FTMP1, FTMP0));
      this.fromFp(RES, FTMP1);
      return this.def(i, RES);
    }
    return nyi(`结果是浮点的 CVT 模式 ${mode}`);
  }

  /**
   * `unsigned long long` -> float/double（第九刀第九十四片）。
   *
   * `cvtsi2sd` 认的是**有符号**的 64 位，所以 v >= 2^63 时它会算成负数。分两路：
   *
   *   v >= 0（符号位是 0）：直接 `cvtsi2sd`，硬件自己按最近偶数舍入。
   *   v <  0：`(v >> 1) | (v & 1)` 之后转，再自己加自己。右移一位丢掉的那一位用 `or`
   *           接回最低位当**粘位**（sticky）—— 这是这一手的关键：值 >= 2^63 时有效位
   *           至少 64 位，最低位的信息只影响「往哪边舍」，粘位留住它，于是这一路的结果
   *           与直接转一样是正确舍入的。float 与 double 同一套（gcc/clang 也是这个序列）。
   *
   * 尺子那边的答案不一样但不冲突：tcc 在 x86_64 上把这件事交给运行时的
   * `__floatundidf`/`__floatundisf`（`tccgen.c:3184` 的 `gen_cvt_itof1`，后端里
   * 那句注释「unsigned case is handled generically」说的就是它）。我们这条腿不带
   * libtcc1，就地发指令；正确性的尺子是 clang（`tests/c/native.js`）。
   */
  u64ToFloat(i, dbl) {
    const buf = this.buf;
    const big = buf.label();
    const done = buf.label();
    buf.emit(x.testRR(8, TMP0, TMP0));
    buf.jcc(CC.s, big);
    buf.emit(x.cvtI2F(dbl, 8, FTMP0, TMP0));
    buf.jmp(done);
    buf.place(big);
    buf.emit(x.movRR(8, TMP1, TMP0));
    buf.emit(x.shiftRI(SH.shr, 8, TMP1, 1));
    buf.emit(x.aluRI(ALU.and, 8, TMP0, 1));
    buf.emit(x.aluRR(ALU.or, 8, TMP1, TMP0));
    buf.emit(x.cvtI2F(dbl, 8, FTMP0, TMP1));
    buf.emit(x.fbin(FOP.add, dbl, FTMP0, FTMP0));
    buf.place(done);
    this.fromFp(RES, FTMP0);
    return this.def(i, RES);
  }

  cvt(i) {
    const f = this.f;
    const buf = this.buf;
    const mode = f.aux[i];
    this.loadRef(TMP0, f.a[i]);
    if (mode === CVT_F2I) {
      const srcDbl = typeKind(this.typeOfRef(f.a[i])) === T_F64;
      const w = widthOf(f.t[i]);
      this.toFp(FTMP0, TMP0);
      buf.emit(x.cvtF2I(srcDbl, w, RES, FTMP0));
      return this.def(i, RES, w);
    }
    /* i32 的规范形是符号扩展后的 64 位，所以：
     *  - SEXT（i32 -> i64）什么都不用做；
     *  - ZEXT 要抹掉高 32 位 —— 一条 32 位的 `mov` 就够（x86 的 32 位写入天然清高位）。
     *    不用 `and rax, 0xffffffff`：那条的立即数是**符号扩展**的，0xffffffff 会变成 -1；
     *  - TRUNC（i64 -> i32）要重新按 32 位符号扩展一遍（`movslq`）。 */
    if (mode === CVT_SEXT) buf.emit(x.movRR(8, RES, TMP0));
    else if (mode === CVT_ZEXT) buf.emit(x.movRR(4, RES, TMP0));
    else if (mode === CVT_TRUNC) buf.emit(x.movsx(8, 4, RES, TMP0));
    else if (mode === CVT_SEXT8) buf.emit(x.movsx(8, 1, RES, TMP0));
    else if (mode === CVT_SEXT16) buf.emit(x.movsx(8, 2, RES, TMP0));
    else if (mode === CVT_BITCAST) buf.emit(x.movRR(8, RES, TMP0));
    else return nyi(`CVT 模式 ${mode}`);
    return this.def(i, RES);
  }

  /** 把结果写回这条指令的栈位。32 位的结果先按 i32 的规范形符号扩展。 */
  def(i, reg, w) {
    if (w === 4) this.buf.emit(x.movsx(8, 4, reg, reg));
    this.frameStore(reg, this.valOff(i));
  }
}

/* 一般的二目：一条指令，结果在 `d`。除、取余、移位不在这张表里（形状不同，见 `bin`）。 */
const BIN = {};
BIN[OP.ADD] = (b, w, d, y) => b.emit(x.aluRR(ALU.add, w, d, y));
BIN[OP.SUB] = (b, w, d, y) => b.emit(x.aluRR(ALU.sub, w, d, y));
BIN[OP.MUL] = (b, w, d, y) => b.emit(x.imulRR(w, d, y));
BIN[OP.BAND] = (b, w, d, y) => b.emit(x.aluRR(ALU.and, w, d, y));
BIN[OP.BOR] = (b, w, d, y) => b.emit(x.aluRR(ALU.or, w, d, y));
BIN[OP.BXOR] = (b, w, d, y) => b.emit(x.aluRR(ALU.xor, w, d, y));

/** 除与取余：`signed` 决定 `idiv`/`div` 与铺符号的方式，`rem` 决定取商还是取余。 */
const DIVLIKE = {};
DIVLIKE[OP.DIV] = { signed: true, rem: false };
DIVLIKE[OP.MOD] = { signed: true, rem: true };
DIVLIKE[OP.UDIV] = { signed: false, rem: false };
DIVLIKE[OP.UMOD] = { signed: false, rem: true };

/** 移位：`SHR` 是**算术**右移（MIR 的 `SHR` 保号），`USHR` 是逻辑右移。 */
const SHIFT = {};
SHIFT[OP.SHL] = SH.shl;
SHIFT[OP.SHR] = SH.sar;
SHIFT[OP.USHR] = SH.shr;

/* 整数比较 -> 条件码。`b`/`ae`/`be`/`a` 是无符号那一套。 */
const CMP = {};
CMP[OP.EQ] = CC.e;
CMP[OP.NE] = CC.ne;
CMP[OP.LT] = CC.l;
CMP[OP.GE] = CC.ge;
CMP[OP.LE] = CC.le;
CMP[OP.GT] = CC.g;
CMP[OP.ULT] = CC.b;
CMP[OP.UGE] = CC.ae;
CMP[OP.ULE] = CC.be;
CMP[OP.UGT] = CC.a;

/* 浮点的二目 -> SSE 的操作码。 */
const FBIN = {};
FBIN[OP.ADD] = FOP.add;
FBIN[OP.SUB] = FOP.sub;
FBIN[OP.MUL] = FOP.mul;
FBIN[OP.DIV] = FOP.div;

/**
 * 浮点比较 -> 「怎么取」。`swap` 是「换操作数」，`pf`/`join` 是「两个条件合起来」。
 * 为什么不能照抄整数表，见 `FnGen.fcmp` 上面那段。
 */
const FCMP = {};
FCMP[OP.EQ] = { cc: CC.e, pf: CC.np, join: ALU.and };
FCMP[OP.NE] = { cc: CC.ne, pf: CC.p, join: ALU.or };
FCMP[OP.LT] = { cc: CC.a, swap: true };
FCMP[OP.LE] = { cc: CC.ae, swap: true };
FCMP[OP.GT] = { cc: CC.a };
FCMP[OP.GE] = { cc: CC.ae };

/* 线性内存的九种读。 */
const MLOAD_EMIT = {
  i8s: (b, d, p) => b.emit(x.movsxM(8, 1, d, p, 0)),
  i8u: (b, d, p) => b.emit(x.movzxM(8, 1, d, p, 0)),
  i16s: (b, d, p) => b.emit(x.movsxM(8, 2, d, p, 0)),
  i16u: (b, d, p) => b.emit(x.movzxM(8, 2, d, p, 0)),
  i32s: (b, d, p) => b.emit(x.movsxM(8, 4, d, p, 0)),
  i32u: (b, d, p) => b.emit(x.movRM(4, d, p, 0)),
  i64: (b, d, p) => b.emit(x.movRM(8, d, p, 0)),
  f32: (b, d, p) => b.emit(x.movRM(4, d, p, 0)),
  f64: (b, d, p) => b.emit(x.movRM(8, d, p, 0)),
};

/* 六种写 -> `mov` 的字节宽度。 */
const MSTORE_SIZE = { i8: 1, i16: 2, i32: 4, i64: 8, f32: 4, f64: 8 };

/** 模块级变量的宽度：写多少字节。 */
const STORE_SIZE = { i64: 8, i32: 4, f64: 8, f32: 4 };

/** 类型 -> 一个宽度的名字。bool 与指针都按 64 位走。 */
function widthKey(t) {
  const k = typeKind(t);
  if (k === T_I32) return 'i32';
  if (k === T_F64) return 'f64';
  if (k === T_F32) return 'f32';
  return 'i64';
}

/** 一个 MIR 函数 -> 一段 x86_64 机器码。不认 CALL 与串常量（那两样要整个模块）。 */
export function genFunc(mod, f) {
  const g = new FnGen(mod, f);
  g.gen();
  g.buf.finish();
  return g.buf;
}

export function codeOf(mod, f) {
  return genFunc(mod, f).bytes();
}

/**
 * 整个模块 -> 一段连着的机器码 + 数据段。与 arm64 那一份的 `genModule` 一一对应
 * （函数之间走标签、跨模块走符号、串常量与模块级变量进数据段）。
 */
export function genModule(mod) {
  const dataSyms = [];
  const dataBytes = [];
  /* 初值里的地址（第二十八片）：与 arm64 那一份同一条 —— `POINTER64`、加数在原地。 */
  const dataRelocs = [];
  const fixSym = (fx) => {
    if (fx.kind === 'g') return mod.globals[fx.no];
    if (fx.kind === 'f') return mod.funcs[fx.no].name;
    return `omni_str_${fx.no}`;
  };
  /* 模块级变量（第二十一片起两种）：说过大小的按它的大小与对齐摆（C 的全局量），
   * 没说过的还是「一格」八个零字节。对齐最多 4096，与 arm64 那一份同一条（第二十九片）。 */
  let dataAlign = 8;
  for (let gi = 0; gi < mod.globals.length; gi++) {
    const blob = mod.globalBlob[gi];
    /* 外部的全局量（第三十一片）：不占字节、不定义符号，与 arm64 那一份同一条。 */
    if (blob !== null && blob.extern) continue;
    const size = blob === null ? 8 : blob.size;
    const al = blob === null ? 8 : blob.align;
    if (al > 4096) nyi(`全局 '${mod.globals[gi]}' 要 ${al} 字节对齐（__data 这一节最多 4096）`);
    if (al > dataAlign) dataAlign = al;
    while (dataBytes.length % al !== 0) dataBytes.push(0);
    const base = dataBytes.length;
    dataSyms.push({
      name: mod.globals[gi], off: base, sect: 2, local: mod.globalLocal[gi] === true,
    });
    for (let k = 0; k < size; k++) {
      const b = blob === null ? 0 : blob.bytes[k];
      dataBytes.push(b === undefined ? 0 : b);
    }
    for (const fx of blob === null ? [] : blob.fixups ?? []) {
      dataRelocs.push({ at: base + fx.off, kind: 'POINTER64', sym: fixSym(fx), sect: 2 });
    }
  }
  const strSyms = new Map();
  const items = mod.consts.items;
  for (let r = 0; r < items.length; r++) {
    /* 两种串常量（第三十片）：`str` 是文本（UTF-8），`bytes` 是「就这几个字节」。 */
    const kind = items[r].kind;
    if (kind !== 'str' && kind !== 'bytes') continue;
    const name = `omni_str_${r}`;
    strSyms.set(r, name);
    /* 串常量的符号一律 8 对齐（第三十三片，与 arm64 那一份同一个理由：宽串的地址
     * 会被交给按 `int` 读的代码）。 */
    while (dataBytes.length % 8 !== 0) dataBytes.push(0);
    /* `local: true`（第九十二片，与 arm64 那一份同一条）：编号是模块内的序号，
     * 当外部符号的话两个 `.o` 各有一个 `omni_str_0`，一链就撞。 */
    dataSyms.push({ name, off: dataBytes.length, sect: 2, local: true });
    const raw = kind === 'bytes' ? hexBytes(items[r].text) : utf8Bytes(items[r].text);
    for (const byte of raw) dataBytes.push(byte);
    dataBytes.push(0);
  }

  const buf = new CodeBuf();
  const labels = [];
  for (let i = 0; i < mod.funcs.length; i++) labels.push(buf.label());
  const offsets = [];
  let i = 0;
  for (const f of mod.funcs) {
    offsets.push(buf.pos);
    buf.place(labels[i]);
    new FnGen(mod, f, buf, labels, strSyms).gen();
    i++;
  }
  buf.finish();
  const bytes = buf.bytes();
  const sizes = [];
  for (let k = 0; k < offsets.length; k++) {
    sizes.push((k + 1 < offsets.length ? offsets[k + 1] : bytes.length) - offsets[k]);
  }
  return {
    bytes,
    offsets,
    sizes,
    relocs: buf.relocs,
    data: new Uint8Array(dataBytes),
    dataSyms,
    dataRelocs,
    dataAlign,
  };
}
