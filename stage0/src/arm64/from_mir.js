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
import { utf8Bytes } from '../host/utf8.js';
import * as a from './encode.js';
import { CodeBuf } from './asm.js';
import {
  OP, REF_NONE, isConstRef, T_I32, T_I64, T_BOOL, T_VOID, T_F32, T_F64,
  typeKind, isFloatType, intBits, memKindNo, memOff, MLOAD_KINDS, MSTORE_KINDS,
  CVT_SEXT, CVT_ZEXT, CVT_TRUNC, CVT_SEXT8, CVT_SEXT16,
  CVT_I2F, CVT_U2F, CVT_F2I, CVT_FCVT, CVT_BITCAST, OP_NAMES, hexBytes, memArgSize,
} from '../mir/ir.js';

/* 草稿寄存器。x8 是 arm64 的「间接结果」寄存器、x9-x15 是调用者保存的临时 ——
 * 这一层不跨调用活，所以随便用哪三个都行，取这三个只为读起来一致。 */
const TMP0 = 9;
const TMP1 = 10;
const RES = 8;
const SP = 31;
/* 帧基址（第三十六片）：**只有会动栈顶的函数里才用**（变长数组、`alloca`）。
 * 那种函数里 `sp` 会往下跑，而槽位与值的栈位都是「基址 + 正偏移」—— 所以序言里把
 * 降完的 `sp` 抄进这一个寄存器，往后一律按它寻址。x28 是**被调用者保存的**，
 * 所以要在帧里留一格把调用者的那份存起来。不会动栈顶的函数一条指令都不变，
 * 于是那 88 条编码对账的用例照旧成立。 */
const FB = 28;
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

/**
 * 一次调用的实参各自落在哪儿（第二十三片）。
 *
 * AAPCS64：整数进 x0-x7、浮点进 v0-v7，两串各自数；放不下的按次序摆在**出参区**
 * （`sp + 0` 起，一格 8 字节）。变参那几个（`nfixed` 之后）一律进出参区 ——
 * 苹果的改动，见第二十二片。
 *
 * 这个函数是**唯一**一处算「谁在哪儿」的地方：`outArgsBytes`（算帧要多大）与
 * `callArgs`（真的发指令）都问它。两处各算一遍的话，迟早在某个边角上分家，
 * 而那种错的症状是「实参串位」——最难查的一类。
 */
/**
 * 这个实参是不是「一整块内容」（`ARGMEM`，第三十九片）—— 是就回它有几个字节，不是回 0。
 *
 * 苹果的 arm64 上变参一律走栈，所以一块内容就是**栈上连着的 `align8(n)` 个字节**：
 * 与标量那一格同一条规则（一格至少 8 字节），只是格子更宽。
 */
function argMemBytes(f, ar) {
  if (isConstRef(ar)) return 0;
  const i = f.at(ar);
  return f.op[i] === OP.ARGMEM ? memArgSize(f.aux[i]) : 0;
}

function argPlaces(mod, f, args, nfixed) {
  const at = [];
  let ngrn = 0;
  let nsrn = 0;
  let stack = 0;
  let k = 0;
  for (const ar of args) {
    const va = nfixed >= 0 && k >= nfixed;
    const t = f.typeOf(ar, mod.consts);
    const n = argMemBytes(f, ar);
    if (n > 0) {
      /* 一整块内容只可能出现在变参那一段（前端只在那儿发 `ARGMEM`）—— 真在固定实参
       * 里撞见，那是上一层错了，不该悄悄按地址传过去。 */
      if (!va) return nyi('固定实参里的 ARGMEM（那一段传的是地址）');
      at.push({ off: stack, bytes: n });
      stack += n + (n % 8 === 0 ? 0 : 8 - (n % 8));
    } else if (!va && isFloatType(t) && nsrn <= 7) {
      at.push({ v: nsrn });
      nsrn++;
    } else if (!va && !isFloatType(t) && ngrn <= 7) {
      at.push({ x: ngrn });
      ngrn++;
    } else {
      at.push({ off: stack });
      stack += 8;
    }
    k++;
  }
  return { at, stack };
}

/**
 * 出参区要多大：本函数里最费的那次调用要往栈上摆几个字节（按 16 取整）。
 *
 * 三种调用都要数（`CALL`/`CCALL`/`CALLI`，实参池都在 `b` 上）。`CCALL` 的 aux 是
 * 变参分界（第二十二片），另两种没有变参。
 */
function outArgsBytes(mod, f) {
  let most = 0;
  let i = 0;
  while (i < f.count()) {
    const op = f.op[i];
    if (op === OP.CALL || op === OP.CCALL || op === OP.CALLI) {
      const nfixed = op !== OP.CALL && f.aux[i] !== 0 ? f.aux[i] - 1 : -1;
      const p = argPlaces(mod, f, f.argsOf(f.b[i]), nfixed);
      most = Math.max(most, p.stack);
    }
    i++;
  }
  return most + (most % 16 === 0 ? 0 : 16 - (most % 16));
}

/**
 * 固定形参里有几个字节排在**入参区**上（`fp + 16` 起）。
 *
 * 序言按它把放不下的形参读回来，`VASTART` 按它算「第一个变参在哪儿」——
 * 苹果的 arm64 上变参一律走栈，它们就紧跟在这些溢出的固定形参后面。
 */
/** 这个函数会动栈顶吗（第三十六片）：有变长数组或 `alloca` 就会。 */
function hasDynStack(f) {
  let i = 0;
  while (i < f.count()) {
    const op = f.op[i];
    if (op === OP.SPALLOC || op === OP.SPSET || op === OP.SPGET) return true;
    i++;
  }
  return false;
}

function inArgBytes(f) {  let ngrn = 0;
  let nsrn = 0;
  let bytes = 0;
  for (const p of f.params) {
    const flt = isFloatType(p.t);
    if (flt && nsrn <= 7) { nsrn++; continue; }
    if (!flt && ngrn <= 7) { ngrn++; continue; }
    bytes += 8;
  }
  return bytes;
}

class FnGen {
  /** `buf` 是整个模块共用的一个缓冲，`callLabels` 是「函数号 -> 标签」（没有就不认 CALL），
   * `strSyms` 是「字符串常量的 ref -> 数据段里的符号名」（没有就不认串常量）。 */
  constructor(mod, f, buf, callLabels, strSyms) {
    this.mod = mod;
    this.f = f;
    this.buf = buf === undefined ? new CodeBuf() : buf;
    this.callLabels = callLabels === undefined ? null : callLabels;
    this.strSyms = strSyms === undefined ? null : strSyms;
    /* 出参区（第二十二片）：`sp + 0` 起的一块，专给「要走栈的实参」。
     * 苹果的 arm64 上**变参一律走栈**（AAPCS64 的苹果改动）—— 固定实参进 x0-x7/v0-v7，
     * `...` 后面那些一格 8 字节摆在 `sp` 上。所以帧的最底下要留出这一块，
     * 它的大小是本函数里最费的那次调用要的字节数（按 16 取整）。
     * 槽位与值的栈位都往上让开这一块 —— 它必须**紧贴 `sp`**，被调方按 `sp` 找它。 */
    this.outArgs = outArgsBytes(mod, f);
    /** 帧里 0 号槽位的偏移。出参区在它下面（第二十二片）。 */
    this.slotBase = this.outArgs;
    this.valBase = this.slotBase + f.slots.length * 8;
    let bytes = this.valBase + f.count() * 8;
    /* 帧块（第十八片）：接在值的栈位后面，每块按自己的 `align` 对齐。**能这么算是因为
     * `sp` 本身 16 对齐**（AAPCS64 要求，序言里的 `sub sp` 也按 16 取整），于是
     * 「sp + off」的对齐就等于 off 的对齐 —— 块内不用再留余地。 */
    this.frameOffs = [];
    for (const blk of f.frames) {
      const pad = bytes % blk.align === 0 ? 0 : blk.align - (bytes % blk.align);
      this.frameOffs.push(bytes + pad);
      bytes = bytes + pad + blk.size;
    }
    this.frame = bytes + (bytes % 16 === 0 ? 0 : 16 - (bytes % 16));
    /* 会动栈顶的函数（第三十六片）：帧最上面留一格存调用者的 x28，往后一律按 `FB`
     * 寻址。留在**最上面**是为了让下面所有偏移都不变 —— 那样「不会动栈顶」的那一路
     * 一条指令都不改。 */
    this.dynStack = hasDynStack(f);
    this.fbSave = -1;
    if (this.dynStack) {
      this.fbSave = this.frame;
      this.frame += 16;
    }
    /** 槽位与值的栈位按谁寻址。会动栈顶时是 `FB`，否则就是 `sp`（一条指令都不多）。 */
    this.base = this.dynStack ? FB : SP;
    /* 第一个变参在哪儿（第二十四片）：苹果的 arm64 把 `...` 后面的实参一律摆在栈上，
     * 于是它就在入参区里、溢出的固定形参之后。序言什么都不用泼 —— 这是这条 ABI
     * 比 SysV 省事的地方。 */
    this.vaBase = 16 + inArgBytes(f);
    /** 区域栈：`{kind, endLabel, contLabel?, elseLabel?, elseDone?}` */
    this.regions = [];
    this.retLabel = this.buf.label();
  }

  /* -------------------------------------------------------------- 位置 */

  slotOff(no) {
    if (!Number.isInteger(no) || no < 0 || no >= this.f.slots.length) {
      throw new OmniError(`arm64: 槽号 ${no} 越界`);
    }
    return this.slotBase + no * 8;
  }

  valOff(i) {
    return this.valBase + i * 8;
  }

  /** 第 no 块帧存储在帧里的偏移（`FRAME` 的落脚点）。 */
  frameOff(no) {
    const off = this.frameOffs[no];
    if (off === undefined) throw new OmniError(`arm64: 帧块号 ${no} 越界`);
    return off;
  }

  /** 帧里的一个 8 字节格子的读写。偏移超过 `ldr` 能表示的范围就明着报。 */
  frameLoad(reg, off) {
    if (off > 32760) throw new OmniError(`arm64: 帧偏移 ${off} 太大（这一片还不搬基址）`);
    this.buf.emit(a.ldrU(3, reg, this.base, off));
  }

  frameStore(reg, off) {
    if (off > 32760) throw new OmniError(`arm64: 帧偏移 ${off} 太大（这一片还不搬基址）`);
    this.buf.emit(a.strU(3, reg, this.base, off));
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
      /* 串常量取的是**地址**：字节躺在数据段里，这一格只要把那个符号的地址算出来。
       * 于是 `f("hi")` 在这一层与 `f(&g)` 是同一件事 —— 都是 adrp+add。 */
      if (k.kind === 'str' || k.kind === 'bytes') return this.symAddr(reg, this.strSym(ref));
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
    /* 帧超过 4096 时**不能**用「造立即数 + sub 寄存器形式」（第二十六片改掉的一个真错误）：
     * add/sub 的**移位寄存器形式**里 31 号是 `xzr`、不是 `sp` —— `sub sp, sp, x9` 那条
     * 于是编成 `sub xzr, xzr, x9`，一条空指令。`sp` 没降下来，随后的 `str [sp, #off]`
     * 就写到**调用者的帧**里去，症状是回不去（PC 变成一个小整数）而现场早已离开。
     * 立即数形式有 `lsl #12` 那一位，所以拆成「多少个 4096」+「余下的」两条 —— 两条都
     * 是立即数形式，31 号在那儿就是 `sp`。 */
    if (this.frame > 0) {
      const hi = Math.floor(this.frame / 4096);
      const lo = this.frame % 4096;
      if (hi > 4095) nyi(`帧 ${this.frame} 字节（一次 sub 装不下）`);
      if (hi > 0) buf.emit(a.subImm(1, SP, SP, hi, 1));
      if (lo > 0) buf.emit(a.subImm(1, SP, SP, lo));
    }
    /* 会动栈顶的函数（第三十六片）：存下调用者的 x28，再把降完的 `sp` 抄进它。
     * 这两条只能按 `sp` 写 —— `FB` 还没成立。 */
    if (this.dynStack) {
      buf.emit(a.strU(3, FB, SP, this.fbSave), a.movSp(1, FB, SP));
    }
    /* 形参：AAPCS 把整数与浮点**分成两串**数（x0-x7 与 v0-v7 各自从 0 起），
     * 所以两个计数器。放不下的从**入参区**读（第二十三片）：调用方摆在它自己的
     * 出参区里，也就是我们这一层 `fp + 16` 起的地方（`fp`/`lr` 那一对占了前 16）。
     *
     * 一格按 8 字节读。欠账：i32 的形参按规范形（符号扩展的 64 位）用，而别人（clang）
     * 摆在栈上的那一格高 32 位是不保证的 —— 与寄存器那一路的同一笔账（那边也直接
     * 存了整个 x 寄存器），一起还。 */
    let ngrn = 0;
    let nsrn = 0;
    let inArg = 16;
    for (const p of f.params) {
      const flt = isFloatType(p.t);
      if (flt && nsrn <= 7) {
        this.fromFp(TMP0, nsrn, typeKind(p.t) === T_F64);
        this.frameStore(TMP0, this.slotOff(p.slot));
        nsrn++;
        continue;
      }
      if (!flt && ngrn <= 7) {
        this.frameStore(ngrn, this.slotOff(p.slot));
        ngrn++;
        continue;
      }
      buf.emit(a.ldrU(3, TMP0, 29, inArg));
      this.frameStore(TMP0, this.slotOff(p.slot));
      inArg += 8;
    }

    for (let i = 0; i < f.count(); i++) this.one(i);

    buf.place(this.retLabel);
    /* 会动栈顶的函数：先把调用者的 x28 取回来（这一条得在 `FB` 还有效的时候发），
     * 再按 `x29` 把 `sp` 收回去 —— `sp` 这会儿可能停在某个变长数组下面。 */
    if (this.dynStack) buf.emit(a.ldrU(3, FB, FB, this.fbSave));
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
    /* `BRTABLE`（第十九片，C 的 `switch` 落在这儿）：**比较链**，不是跳表。
     * 一张真跳表要在数据段里摆一串地址、再靠重定位填进去；比较链一条指令都不欠链接器，
     * 而 n 小的时候（C 里绝大多数 switch）两者差不了几个周期。密集化已经在前端做过了
     * （`0 <= a < n` 的那一段），所以这里只是「等于 k 就跳第 k 项」。
     * 下标按**无符号**读：负数与 >= n 都落到兜底那一支。 */
    if (op === OP.BRTABLE) {
      this.loadRef(TMP0, f.a[i]);
      const levels = f.levelsOf(f.b[i]);
      let k = 0;
      for (const lv of levels) {
        if (k >= 4096) nyi('BRTABLE 的表超过 4096 项（cmp 的立即数装不下）');
        buf.emit(a.cmpImm(1, TMP0, k));
        buf.bcond(a.COND.eq, this.brTarget(lv));
        k++;
      }
      buf.b(this.brTarget(f.aux[i]));
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
      this.callArgs(f.argsOf(f.b[i]), -1);
      const label = this.callLabels[f.a[i]];
      if (label === undefined) throw new OmniError(`arm64: 没有 ${f.a[i]} 号函数`);
      buf.bl(label);
      return this.callRet(i, t);
    }
    /* `CCALL` 是**外部符号**（`printf`、`malloc`）。模块内的调用走标签、跨模块的走符号
     * ——这一格是欠链接器的第一笔账（`asm.js` 的 `blSym` 记，`macho.js` 写成
     * `ARM64_RELOC_BRANCH26`）。 */
    if (op === OP.CCALL) {
      const name = this.mod.cabi[f.a[i]];
      if (name === undefined) throw new OmniError(`arm64: 没有 ${f.a[i]} 号 C 入口`);
      /* aux 是变参分界（第二十二片）：0 = 不是变参调用，否则固定实参个数 + 1。 */
      this.callArgs(f.argsOf(f.b[i]), f.aux[i] === 0 ? -1 : f.aux[i] - 1);
      buf.blSym(name);
      return this.callRet(i, t);
    }
    /* `CALLI` 是**按指针调用**（第二十七片）。native 上函数指针就是真地址，所以一条
     * `blr`。次序要紧：先把实参摆好（那一步用 x0-x7 与草稿寄存器），**再**把目标地址
     * 取进草稿 —— 反过来的话备实参那几条会把目标踩掉。 */
    if (op === OP.CALLI) {
      if (!this.mod.native) nyi('CALLI（解释器那条腿上函数指针是「号 + 1」，不是地址）');
      /* aux 是变参分界（第三十五片），与 `CCALL` 同一个编码。 */
      this.callArgs(f.argsOf(f.b[i]), f.aux[i] === 0 ? -1 : f.aux[i] - 1);
      this.loadRef(TMP0, f.a[i]);
      buf.emit(a.blr(TMP0));
      return this.callRet(i, t);
    }
    /* 一个函数的**地址**（第二十七片）：与 `GADDR` 同一对指令，只是符号在 `__TEXT` 里。 */
    if (op === OP.FADDR) {
      this.symAddr(RES, this.funcSym(f.aux[i]));
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

    /* ---- 帧上的一块（第十八片）。**`&x` 在 native 上就落在这里**：不是线性内存里的
     * 一个偏移，而是 `sp` 加一个常数得到的真地址 —— 交给 libc 也认。
     * 一条 `add` 就够，前提是偏移进得了 12 位；进不去就分两条（第二十九片）——
     * 高位那条带 `lsl #12`，与序言里降 `sp` 那两条是同一个办法。
     * **不能**走「造立即数再 add 移位寄存器形式」：那个形式里 31 号是 `xzr` 不是 `sp`
     * （第二十六片那个真错误）。 */
    if (op === OP.FRAME) {
      const off = this.frameOff(f.aux[i]);
      const hi = Math.floor(off / 4096);
      const lo = off % 4096;
      if (hi > 4095) nyi(`帧偏移 ${off}（两条 add 也装不下）`);
      if (hi === 0) {
        buf.emit(a.addImm(1, RES, this.base, lo));
      } else {
        buf.emit(a.addImm(1, RES, this.base, hi, 1));
        if (lo > 0) buf.emit(a.addImm(1, RES, RES, lo));
      }
      return this.def(i, RES);
    }

    /* ---- 模块级变量（第九刀第九片）。**靠符号寻址**：`adrp` 取页、`add` 取页内偏移。
     * 这一对是 arm64 上取任何一个全局地址的标准两条，两格都欠链接器一笔重定位
     * （`ARM64_RELOC_PAGE21` + `PAGEOFF12`）—— 第九刀第一片对账时被 llvm 挡回来的
     * 那个「adrp 的页号填不出来」，现在从写出去的那一头解释清楚了。 */
    if (op === OP.GLOAD) {
      this.globalAddr(TMP0, f.aux[i]);
      GLOAD_EMIT[widthKey(t)](buf, RES, TMP0);
      return this.def(i, RES);
    }
    if (op === OP.GSTORE) {
      this.loadRef(TMP1, f.a[i]);
      buf.emit(a.movReg(1, RES, TMP1));
      this.globalAddr(TMP0, f.aux[i]);
      buf.emit(a.strU(STORE_SIZE[widthKey(f.t[i])], RES, TMP0, 0));
      return;
    }
    /* 全局的**地址**（第二十一片）：`GLOAD` 里那两条的前半截，只是不接 `ldr`。
     * C 的全局量都从这儿走 —— 取地址、按成员写、按下标写，后头接 `MLOAD`/`MSTORE`。 */
    if (op === OP.GADDR) {
      this.globalAddr(RES, f.aux[i]);
      return this.def(i, RES);
    }

    /* ---- 变参的定义那一侧（第二十四片）。苹果的 arm64 上 `va_list` 就是一个 `char *`：
     * 变参一律在栈上连着放，一格 8 字节。于是这两条都很短 ——
     * `va_start` 是「把入参区里第一个变参的地址写进 ap」，
     * `va_arg` 是「按 ap 读一格、把 ap 推到下一格」。
     * i32 按符号扩展读（规范形），浮点读的是位模式（栈位里躺的就是位模式）。 */
    if (op === OP.VASTART) {
      this.loadRef(TMP0, f.a[i]);
      buf.emit(a.addImm(1, TMP1, 29, this.vaBase), a.strU(3, TMP1, TMP0, 0));
      return;
    }
    if (op === OP.VAARG) {
      this.loadRef(TMP0, f.a[i]);
      buf.emit(a.ldrU(3, TMP1, TMP0, 0));
      /* aux > 0：这一格里躺着一个 struct（第三十九片）。回的是**这一格的地址**，
       * 游标往前走 `align8(n)` —— 与写的那一侧（`argPlaces` 里的 `ARGMEM`）同一条规则。
       * 内容一个字节都不动：拷不拷由前端那边的赋值决定。 */
      if (f.aux[i] !== 0) {
        const n = memArgSize(f.aux[i]);
        const step = n + (n % 8 === 0 ? 0 : 8 - (n % 8));
        if (step > 4095) return nyi(`va_arg 取 ${n} 字节的 struct（一条 add 的立即数装不下）`);
        buf.emit(a.movReg(1, RES, TMP1));
        buf.emit(a.addImm(1, TMP1, TMP1, step), a.strU(3, TMP1, TMP0, 0));
        return this.def(i, RES);
      }
      MLOAD_EMIT[typeKind(t) === T_I32 ? 'i32s' : widthKey(t)](buf, RES, TMP1);
      buf.emit(a.addImm(1, TMP1, TMP1, 8), a.strU(3, TMP1, TMP0, 0));
      return this.def(i, RES);
    }
    /* 变参里的一整块内容（第三十九片）：这一条本身**不发访存** —— 内容什么时候拷、
     * 拷到哪儿，是调用那一头的事（`callArgs` 里按 `place.bytes` 拷）。这儿只把地址
     * 落到自己的栈位上，好让 `callArgs` 拿得到。 */
    if (op === OP.ARGMEM) {
      this.loadRef(RES, f.a[i]);
      return this.def(i, RES);
    }
    /* `va_copy`（第三十二片）：苹果 arm64 上 `va_list` 就是那个游标，所以「抄一份」
     * 就是抄那 8 字节 —— 两个 ap 从此各走各的。用 RES 当中转而不是 TMP1，是因为
     * `loadRef` 会再要一个寄存器；这一条不产值，RES 正好闲着。 */
    if (op === OP.VACOPY) {
      this.loadRef(TMP0, f.b[i]);
      buf.emit(a.ldrU(3, RES, TMP0, 0));
      this.loadRef(TMP0, f.a[i]);
      buf.emit(a.strU(3, RES, TMP0, 0));
      return;
    }

    /* ---- 会动的栈顶（第三十六片）：变长数组与 `alloca`。
     *
     * `sp` 只能用**立即数形式**或经过一个普通寄存器中转来动 —— 移位寄存器形式里 31 号
     * 是 `xzr`（第二十六片那个真错误）。所以一律「抄进 TMP1、算、再抄回 sp」。
     *
     * 切下来那一块要**让开出参区**：被调方按 `sp` 找走栈的实参，所以 `sp + 0` 起那一段
     * 得一直是出参区。于是降 `sp` 时多降 `outArgs` 个字节，而块的基址取降之前那个位置
     * 减去 n —— 也就是出参区的上沿。 */
    if (op === OP.SPGET) {
      buf.emit(a.movSp(1, RES, SP));
      return this.def(i, RES);
    }
    if (op === OP.SPSET) {
      this.loadRef(TMP0, f.a[i]);
      buf.emit(a.movSp(1, SP, TMP0));
      return;
    }
    if (op === OP.SPALLOC) {
      this.loadRef(TMP0, f.a[i]);
      buf.emit(a.movSp(1, TMP1, SP), a.subReg(1, TMP1, TMP1, TMP0));
      buf.emit(a.movReg(1, RES, TMP1));
      const oa = this.outArgs;
      if (oa > 0) {
        const hi = Math.floor(oa / 4096);
        const lo = oa % 4096;
        if (hi > 4095) nyi(`出参区 ${oa} 字节（一次 sub 装不下）`);
        if (hi > 0) buf.emit(a.subImm(1, TMP1, TMP1, hi, 1));
        if (lo > 0) buf.emit(a.subImm(1, TMP1, TMP1, lo));
      }
      buf.emit(a.movSp(1, SP, TMP1));
      return this.def(i, RES);
    }

    /* ---- 存取（第九刀第七片）。地址就是真指针 —— native 上没有线性内存。 */
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

  /** 实参就位：整数一串（x0-x7）、浮点一串（v0-v7），**各自从 0 起数**（AAPCS）。 */
  callArgs(args, nfixed) {
    const p = argPlaces(this.mod, this.f, args, nfixed);
    let k = 0;
    for (const ar of args) {
      const place = p.at[k];
      k++;
      /* 走栈的（放不下的固定实参、以及变参那几个）：一格 8 字节，摆在出参区里。
       * 这一条**只能按 `sp` 写**（第三十六片）：出参区的约定是「紧贴 sp」，而会动栈顶的
       * 函数里 `this.base` 是那个钉住的帧基址，与 `sp` 早就不是一回事了。 */
      if (place.off !== undefined) {
        /* 一整块内容（`ARGMEM`，第三十九片）：把 `bytes` 个字节拷进那一格。
         * 按 8/4/2/1 递降着拷，**不拷到格子的末尾**（格子补齐到 8，源没有那么长）——
         * 多读的那几个字节大多无害，可源要是正好贴着一页的末尾就会踩空。 */
        if (place.bytes !== undefined) {
          this.loadRef(TMP0, ar);
          let at = 0;
          for (const [w, sz] of [[8, 3], [4, 2], [2, 1], [1, 0]]) {
            while (place.bytes - at >= w) {
              this.buf.emit(a.ldrU(sz, TMP1, TMP0, at), a.strU(sz, TMP1, SP, place.off + at));
              at += w;
            }
          }
          continue;
        }
        this.loadRef(TMP0, ar);
        this.buf.emit(a.strU(3, TMP0, SP, place.off));
        continue;
      }
      if (place.v !== undefined) {
        this.loadRef(TMP0, ar);
        this.toFp(place.v, TMP0, typeKind(this.typeOfRef(ar)) === T_F64);
        continue;
      }
      this.loadRef(place.x, ar);
    }
  }

  /** 返回值落回栈位。 */
  callRet(i, t) {
    if (typeKind(t) === T_VOID) return;
    if (isFloatType(t)) {
      this.fromFp(RES, 0, typeKind(t) === T_F64);
      return this.def(i, RES);
    }
    /* i32 的返回值要按规范形符号扩展：AAPCS 只保证 w0 有值，x0 的高 32 位不算数。 */
    return this.def(i, 0, widthOf(t));
  }

  /** 一个函数的符号名（`FADDR` 用）。落到目标文件上就是 `__TEXT` 里的一个符号。 */
  funcSym(no) {
    const f = this.mod.funcs[no];
    if (f === undefined) throw new OmniError(`arm64: 没有 ${no} 号函数`);
    return f.name;
  }

  /** 模块级变量的符号名。MIR 里它就是个名字，落到目标文件上就是一个全局符号。 */
  globalSym(no) {
    const name = this.mod.globals[no];
    if (name === undefined) throw new OmniError(`arm64: 没有 ${no} 号模块级变量`);
    return name;
  }

  /** 串常量的符号名。名字是 `genModule` 分的 —— 单个函数编不出数据段，所以那儿明着报。 */
  strSym(ref) {
    const sym = this.strSyms === null ? undefined : this.strSyms.get(ref);
    if (sym === undefined) {
      throw new OmniError('arm64: 字符串常量的字节要落在数据段里，得走 genModule');
    }
    return sym;
  }

  /** 一个符号的地址算进 `reg`：`adrp` 取页、`add` 取页内偏移。两格都记一笔重定位。 */
  symAddr(reg, sym) {
    this.buf.adrpSym(reg, sym);
    this.buf.addSymOff(reg, reg, sym);
  }

  /**
   * **外部**符号的地址算进 `reg`：过 GOT（`adrp @GOTPAGE` + `ldr @GOTPAGEOFF`）。
   *
   * 为什么不能与自家符号走同一条路：外部的数据符号可能住在一个 dylib 里，
   * 那时链接期没有「它的页」可谈 —— 链接器会说 `target does not have address`
   * （第三十一片上 `__stdoutp` 就是这么挡回来的）。
   */
  symAddrGot(reg, sym) {
    this.buf.adrpSymGot(reg, sym);
    this.buf.ldrSymGot(reg, reg, sym);
  }

  /** 一个模块级变量的地址算进 `reg`：自家的直接算，外部的过 GOT。 */
  globalAddr(reg, no) {
    const blob = this.mod.globalBlob[no];
    if (blob !== null && blob.extern) return this.symAddrGot(reg, this.globalSym(no));
    return this.symAddr(reg, this.globalSym(no));
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

/** 类型 -> 一个宽度的名字。bool 与指针都按 64 位走。 */
function widthKey(t) {
  const k = typeKind(t);
  if (k === T_I32) return 'i32';
  if (k === T_F32) return 'f32';
  if (k === T_F64) return 'f64';
  if (k === T_I64 || k === T_BOOL) return 'i64';
  return nyi(`模块级变量的类型 ${k}`);
}

/* 模块级变量的读。i32 走 `ldrsw`（i32 的规范形是符号扩展过的 64 位）；
 * 两种浮点走整数加载 —— 栈位里躺的是位模式。 */
const GLOAD_EMIT = {
  i64: (b, d, p) => b.emit(a.ldrU(3, d, p, 0)),
  i32: (b, d, p) => b.emit(a.ldrsU(2, d, p, 0)),
  f64: (b, d, p) => b.emit(a.ldrU(3, d, p, 0)),
  f32: (b, d, p) => b.emit(a.ldrU(2, d, p, 0)),
};
const STORE_SIZE = { i64: 3, i32: 2, f64: 3, f32: 2 };

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
  /* 数据段先排出来 —— 函数体里 `loadRef` 要拿串常量的符号名，所以这一步得在生成之前。
   *
   * 布局：模块级变量**一个八字节一格**、零初始化，串常量接在后面（UTF-8 + 一个 0）。
   * MIR 没有「全局的初值」这回事（初始化是入口函数里的一串 GSTORE），所以变量那段只管留位。
   * 每个变量都是一个真符号 —— 于是 C 那边 `extern long long x;` 就能看见它。
   *
   * 串常量**不必扫函数体**：常量池自己就是去重表（`ConstPool.intern` 按 `类型|种类|文本`
   * 去重），所以同一个 `"hi"` 在整个模块里只有一条 ref、于是只有一个符号、只有一份字节。
   * 代价是没被用到的串也会占数据段 —— 那是死代码消除的事，不是这一层的事。
   *
   * 欠账：这些符号现在是**外部**符号（`macho.js` 里 defs 一律 `N_EXT`），于是两个模块
   * 各有一个 `omni_str_0` 就会撞。真正的办法是局部符号 + 按节的重定位，等自己的链接器。 */
  const dataSyms = [];
  const dataBytes = [];
  /* 初值里的地址（第二十八片）：一条 `POINTER64`，原地那八个字节是加数。
   * 这些坑落在**数据节**里，所以 `sect: 2` —— 节头里各有一张重定位表。 */
  const dataRelocs = [];
  const fixSym = (fx) => {
    if (fx.kind === 'g') return mod.globals[fx.no];
    if (fx.kind === 'f') return mod.funcs[fx.no].name;
    return `omni_str_${fx.no}`;
  };
  /* 模块级变量（第二十一片起两种）：说过大小的按它的大小与对齐摆（C 的全局量），
   * 没说过的还是「一格」八个零字节（wasm 的 `(global …)` 与 JS 前端那批）。
   * 对齐最多到 4096（第二十九片：`__data` 那一节的对齐字段现在按内容算，
   * 不再是写死的 8）—— 上界取一页，再往上就该问「你到底在摆什么」了。 */
  let dataAlign = 8;
  for (let gi = 0; gi < mod.globals.length; gi++) {
    const blob = mod.globalBlob[gi];
    /* 外部的全局量（第三十一片）：不占字节、不定义符号 —— 它落进「未定义的外部符号」
     * 那一段，靠取它地址的那几条重定位把名字带进符号表。 */
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
    /* 两种串常量（第三十片）：`str` 是文本（按 UTF-8 写出去），`bytes` 是「就这几个字节」
     * （C 的串字面量里的 `\xe4` 那种）。摆在数据段里的差别只有「怎么变成字节」这一步。 */
    const kind = items[r].kind;
    if (kind !== 'str' && kind !== 'bytes') continue;
    const name = `omni_str_${r}`;
    strSyms.set(r, name);
    /* 串常量的符号一律 8 对齐（第三十三片）。从前是紧挨着摆的 —— 窄串无所谓，可宽串
     * （`L"ab"`，一格四字节）的地址会被交给按 `int` 读的代码。按内容算每一条的对齐
     * 要在常量池里多记一个字段，而 8 是所有 C 标量的上界，一条 while 就够。 */
    while (dataBytes.length % 8 !== 0) dataBytes.push(0);
    /* `local: true`（第九十二片）：串常量的编号是**这个模块里**的序号，两个 `.o` 各有
     * 一个 `omni_str_0` —— 当外部符号的话一链就撞。局部符号里各归各家。 */
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
