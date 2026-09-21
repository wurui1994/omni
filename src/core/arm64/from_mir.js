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
import {
  COND, addImm, addReg, andImm, andReg, asrv, asrImm, blr, br, cmpImm, cmnImm, cmpReg, cset, csinc,
  eorImm,
  eorReg, fadd,
  fcmpArm64, fcvtDS, fcvtSD, fcvtzs, fcvtzu, fdiv, fmovFromInt, fmovToInt, fmul, fneg, fsub,
  fmadd, fmsub, fnmsub, fsqrt, fabsFp, frintn, frintp, frintm, frintz, frinta,
  ldpPost, ldrFpU, ldrU, ldrsU, ldrRegOff, lslv, lslImm, lsrv, lsrImm, movReg, movSp, movk, movz,
  msub, mul,
  mvn, neg, orrImm, orrReg,
  cneg, fmovFp, fmovImm, fmovImm8Of, retArm64, scvtf, sdiv, stp, ldp, stpFp, ldpFp, stpPre, strFpU, strU, strRegOff, subImm, subReg, svcArm64, sxtb,
  sxth, sxtw,
  ucvtf, udiv
} from './encode.js';
import { Arm64CodeBuf } from './asm.js';
import {
  OP, REF_NONE, REF_BIAS, isConstRef, T_I32, T_I64, T_BOOL, T_VOID, T_F32, T_F64,
  typeKind, isFloatType, intBits, memKindNo, memOff, MLOAD_KINDS, MSTORE_KINDS,
  CVT_SEXT, CVT_ZEXT, CVT_TRUNC, CVT_SEXT8, CVT_SEXT16,
  CVT_I2F, CVT_U2F, CVT_F2I, CVT_F2U, CVT_FCVT, CVT_BITCAST, OP_NAMES, OP_MODES, hexBytes, memArgSize,
  memArgHfa, memArgAlign16,
  callVaFixed,
} from '../mir/ir.js';
import { planRodata, planData, planBss } from '../mir/rodata.js';

/* 草稿寄存器。x8 是 arm64 的「间接结果」寄存器、x9-x15 是调用者保存的临时 ——
 * 这一层不跨调用活，所以随便用哪三个都行，取这三个只为读起来一致。 */
const TMP0 = 9;
const TMP1 = 10;
const RES = 8;
const SP = 31;
/**
 * **值的寄存器缓存**（第一百四十三片）：x11-x15。
 *
 * 「每个值一个栈位」这个口径没改 —— 改的是「算完先别急着写回去」：结果落在这五个里的
 * 一个，用它的那条指令**直接读那个寄存器**，一条 `ldr` 都不发。用光了（`cacheLeft`
 * 归零）寄存器就还回池子；控制流一分岔一合并、或者一条 `bl` 之前，还有人要的那几个
 * 写回栈位（`flush`）—— 这五个都是调用者保存的，跨不过一次调用。
 *
 * 为什么是「缓存」而不是「寄存器分配」：分配要先算活跃区间、再上色，是一整遍额外的
 * 遍历；这一格只用「这个值还要用几次」这一个数（`countUses`，编译前一遍数完），
 * 一遍过的代码生成器里当场就够用。省下来的正是那条 `ldr`：
 *   `int add(int,int)`  92 -> 72（不可达那一刀）-> 60 字节，与 tcc 的 60 齐平。
 *
 * 为什么取 x11-x15：x0-x7 是实参、x8 是 `RES` 兼间接结果、x9/x10 是草稿、x28 是帧基址、
 * x29/x30 是帧与返回地址 —— 这五个是这一层里**谁都不碰**的（量过：整份 from_mir 里
 * 没有一处发到它们身上），所以缓存不需要任何「会不会被踩」的推理。
 */
const POOL = [11, 12, 13, 14, 15];
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
/**
 * **粘住的那几个寄存器**（第一百五十二片）：x19-x27，被调用者保存。
 *
 * 与 `POOL` 那五个的区别是**谁决定住哪儿**：`POOL` 是发码时一遍过的缓存，靠
 * "还要用几次"抢位子，控制流一分岔、一条 `bl` 之前就全写回栈位（`flush`）。
 * 这九个是**上一层算好的**：`mir/opt/regalloc.js` 按线性扫描给一部分值涂了颜色
 * （`fn.regHint`：下标 -> 颜色），一个颜色一个寄存器，从定义到最后一次使用一直住着 ——
 * 于是那些值**一次访存都不发**，`flush` 也不碰它们。
 *
 * 为什么必须是被调用者保存的：上一层给的区间会跨过调用点（它刻意不在调用点切开）。
 * x19-x28 在 AAPCS 里是被调用者保存的，所以一条 `bl` 过去它们还在；代价是本函数要在
 * 序言里存、收场里取（只存真用到的那几个）。
 *
 * 为什么与 `POOL` 不重叠也不与草稿重叠：这一层里 x8(RES)/x9/x10(草稿)/x11-x15(POOL)/
 * x28(FB)/x29/x30 各有主，x19-x27 谁都不碰 —— 与 `POOL` 当初挑 x11-x15 同一条理由。
 *
 * **个数不必与 `regalloc.js` 的 `COLORS` 相等**：那边按"哪条腿最多"给到 9 个颜色，
 * 这边有几个就认几个，`stickyAt` 里 `c >= STICKY.length` 一律回 -1 ——
 * 认不下的颜色照旧住栈位，而那永远是对的（见 regalloc.js 文件头）。
 */
const STICKY = [19, 20, 21, 22, 23, 24, 25, 26, 27];
/**
 * **浮点那一套粘住的寄存器**：d8-d15，AAPCS 里被调用者保存（只保低 64 位，
 * 而这一层的浮点值最宽就是一个 double ⇒ 够）。对的是 `regalloc.js` 的 `regHintF`。
 *
 * 为什么要有这一套（指令级对账指出来的）：浮点值从前一律当**八字节位模式**住在通用
 * 寄存器/栈位上，算之前 `fmov` 进 FP、算完 `fmov` 回来 —— radiance 里 `fmov` 511 条，
 * 而真的浮点运算只有 115 条。给浮点值一个真的 FP 住处，那一整类搬运就没了。
 *
 * 与 `FTMP0`(16)/`FTMP1`(17)/`FRES`(18) 以及传参用的 d0-d7 都不重叠。
 *
 * **后半段（d19-d31）是调用者保存的草稿档**（`regalloc.js` 的 `COLORS_F_SCRATCH`）：
 * 上一层只把**不跨任何调用点**的区间涂成这些颜色，所以序言/收场一个字都不用发
 * （`fstickySpill` 只存前 `STICKY_F_SAVED` 个）。
 *
 * 为什么要有这半段（量出来的）：struct 拷贝改成按字段发之后，`Vec` 的分量不再以 i64
 * 位模式流转而是真 f64 —— `radiance` 里该有寄存器的 550 个值中 429 个要 FP 颜色，
 * 而只有 8 个。指令从 1613 掉到 1283（-20%），时间却从 219ms 涨到 301ms：
 * 少的是搬运、多的是溢出。arm64 有 32 个 FP 寄存器，不用是白扔。
 */
const STICKY_F = [8, 9, 10, 11, 12, 13, 14, 15,
  19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];
/** 前几个颜色是被调用者保存的（要在序言里存）—— 与 `regalloc.js` 的 `COLORS_F` 对齐。 */
const STICKY_F_SAVED = 8;
const FRES = 18;

/**
 * **一元数学函数 -> 一条机器指令**（Go 的 `ssagen/intrinsics.go:744-777` 那一段
 * 配 `ARM64.rules:53-59`）。键是 C 库里的名字，值是发码的那个编码器。
 *
 *   sqrt  -> FSQRTD      Go: (Sqrt)        => (FSQRTD)
 *   fabs  -> FABSD       Go: (Abs)         => (FABSD)
 *   ceil  -> FRINTPD     Go: (Ceil)        => (FRINTPD)
 *   floor -> FRINTMD     Go: (Floor)       => (FRINTMD)
 *   trunc -> FRINTZD     Go: (Trunc)       => (FRINTZD)
 *   round -> FRINTAD     Go: (Round)       => (FRINTAD)   离零取整
 *   rint / nearbyint -> FRINTND            Go: (RoundToEven) => (FRINTND)
 *
 * `round` 那一格要小心：C 的 `round` 是"离零取整"（0.5 往远离零的方向），
 * 正好是 `FRINTA`（ties away from zero）；而 `rint`/`nearbyint` 是"就近偶数"，
 * 是 `FRINTN`。两者不可互换 —— Go 也是分成 `Round` 与 `RoundToEven` 两格。
 */
const MATH1 = {
  sqrt: fsqrt,
  fabs: fabsFp,
  ceil: frintp,
  floor: frintm,
  trunc: frintz,
  round: frinta,
  rint: frintn,
  nearbyint: frintn,
};

/** `OMNI_EMIT_STAT=1` 的账本：MIR op 名 -> `{n: 机器指令条数, k: 这种 op 出现几次}`。
 *  关着的时候是 `null`，一条判断都不多做。印出来的地方在 `emitStatDump`。 */
export const EMIT_STAT = process.env.OMNI_EMIT_STAT === '1' ? new Map() : null;

/** 把 `EMIT_STAT` 印出来（按条数从多到少）。**要看的是最后那一列"每条 op 摊几条指令"** ——
 *  一条 `MSTORE` 理应是一条 `str`，摊到 2.5 就说明操作数没在寄存器里。 */
export function emitStatDump() {
  if (EMIT_STAT === null) return [];
  let total = 0;
  for (const v of EMIT_STAT.values()) total += v.n;
  const rows = [...EMIT_STAT].sort((a, b) => b[1].n - a[1].n);
  const out = [`[emit] 一共 ${total} 条机器指令，按 MIR op 分：`];
  for (const [nm, v] of rows.slice(0, 16)) {
    out.push(`  ${String(v.n).padStart(7)} 条（${(100 * v.n / Math.max(1, total)).toFixed(1)}%）`
      + `  ${nm} × ${v.k}，每条摊 ${(v.n / Math.max(1, v.k)).toFixed(2)}`);
  }
  return out;
}
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

function arm64Nyi(what) {
  throw new OmniError(`arm64 后端还不认识 ${what}`);
}

/**
 * 每个值被引用几次 —— 寄存器缓存的全部账本（见 `POOL`）。
 *
 * 角色表照 `verify.js` 的口径：三个字段里只有 `'r'`（一个 ref）与 `'p'`（一池 ref）
 * 躺着值，`'s'`/`'n'`/`'j'` 分别是槽号、下标、跳几层。常量与空位不算。
 *
 * 数得**多**是安全的（寄存器多攥一会儿，到边界上照旧写回栈位），数得**少**是不安全的
 * （攥着的那个会被当成用完了让出去）—— 所以这一遍宁可宽，别自作聪明。
 * 数出 0 的那些是 `discard` 掉的表达式（C 里 `f();` 那种）：连写回都省了。
 */
function countUses(f) {
  const n = f.count();
  const out = [];
  for (let i = 0; i < n; i++) out.push(0);
  for (let i = 0; i < n; i++) {
    const mode = OP_MODES[f.op[i]];
    for (let k = 0; k < 3; k++) {
      const role = mode[k];
      if (role !== 'r' && role !== 'p') continue;
      const v = k === 0 ? f.a[i] : (k === 1 ? f.b[i] : f.aux[i]);
      if (role === 'r') {
        if (v !== REF_NONE && !isConstRef(v)) out[f.at(v)]++;
        continue;
      }
      for (const r of f.argsOf(v)) {
        if (r !== REF_NONE && !isConstRef(r)) out[f.at(r)]++;
      }
    }
  }
  /* `ARGSRET`（返回值那一块的地址）**读两次**：调用之前进 x8（`callArgs` 里那一格），
   * 调用之后 `callRet` 还要按它把 x0/x1 写进那一块 —— 而实参池里它只出现一次。
   * 少数这一次就是「攥着的寄存器被当成用完了让出去」，量出来的症状是 `take24(mk24(...))`
   * 段错误（第一百四十三片踩过一次）。 */
  for (let i = 0; i < n; i++) if (f.op[i] === OP.ARGSRET) out[i]++;
  return out;
}

/** 这一片认的类型。bool 在栈位上是 0/1 的 64 位。 */
function arm64WidthOf(t) {
  const k = typeKind(t);
  if (k === T_I64 || k === T_BOOL) return 64;
  if (k === T_I32) return 32;
  return arm64Nyi(`类型 ${k}`);
}

/** `ARGMEM`/`ARGSRET` 的 aux 摊成那几格。`sret` 由调用者说（形参那一侧从函数上读）。 */
function memInfoOf(aux, sret) {
  return {
    sret: sret === true,
    size: memArgSize(aux),
    hfa: memArgHfa(aux),
    align16: memArgAlign16(aux),
  };
}

/**
 * 这个实参是「一整块内容」吗（`ARGMEM`，第三十九片；`ARGSRET`，第一百三十一片）——
 * 是就回 `{sret, size, hfa, align16}`，不是回 null。
 */
function argMemOf(f, ar) {
  if (isConstRef(ar)) return null;
  const i = f.at(ar);
  const op = f.op[i];
  if (op !== OP.ARGMEM && op !== OP.ARGSRET) return null;
  return memInfoOf(f.aux[i], op === OP.ARGSRET);
}

/** 一个标量占几个字节（C.7/C.9/C.14 那几条要它）。指针与 i64 都是 8。 */
function scalarBytes(t) {
  const k = typeKind(t);
  if (k === T_I32 || k === T_F32) return 4;
  if (k === T_BOOL) return 1;
  return 8;
}

/**
 * 一次调用的实参各自落在哪儿（第二十三片；第一百三十一片按 tcc 补齐了聚合那几条）。
 *
 * **照 `arm64-gen.c:818` 的 `arm64_pcs_aux` 抄**，连编号一起：B.2/B.3/B.4 是
 * 「HFA 例外、>16 字节换指针、聚合按 8 取整」，C.1-C.15 是那一长串摆位。抄编号不是
 * 摆样子 —— AAPCS64 §6.4.2 的规则本来就是按编号一条条来的，跳一条的症状是「实参串位」，
 * 而那是最难查的一类错。
 *
 * 回的每一格是这几种之一：
 *
 *   - `{x}` 一个整数寄存器 / `{v}` 一个向量寄存器（标量）
 *   - `{x, xn, bytes}` 聚合摊进 `xn` 个连着的整数寄存器（C.10）
 *   - `{v, hfa, bytes}` HFA 摊进 `hfa.n` 个连着的向量寄存器（C.2）
 *   - `{x|off, ptr, bytes, copyOff}` >16 字节的聚合：传一个指向出参区里那份拷贝的指针（B.3）
 *   - `{off}` / `{off, bytes}` 出参区里的一格 / 一整块（C.13/C.15）
 *   - `{sret, x8?}` 返回值那一块（`ARGSRET`）—— 不占实参的位置
 *
 * 这个函数是**唯一**一处算「谁在哪儿」的地方：`arm64OutArgsBytes`（算帧要多大）与
 * `callArgs`（真的发指令）都问它。两处各算一遍的话，迟早在某个边角上分家。
 */
function argPlaces(mod, f, args, nfixed) {
  return pcsPlaces(args.map((ar) => {
    const mem = argMemOf(f, ar);
    if (mem !== null) return { mem };
    const t = f.typeOf(ar, mod.consts);
    return { mem: null, flt: isFloatType(t), bytes: scalarBytes(t) };
  }), nfixed);
}

/**
 * 摆位那一段本身。`descs` 的每一格是 `{mem}`（一整块内容）或 `{flt, bytes}`（标量）。
 *
 * 分成两层是因为**形参那一侧要问同一个问题**：序言得知道「进来的这个 struct 在哪几个
 * 寄存器里」，而它手上是 `f.params` 不是实参的 ref。两处各写一遍摆位规则的话，
 * 迟早在某条 C.x 上分家 —— 那种错的症状是「实参串位」，最难查的一类。
 */
function pcsPlaces(descs, nfixed) {
  const at = [];
  let nx = 0;          // 下一个整数寄存器（tcc 的 `nx`）
  let nv = 0;          // 下一个向量寄存器（tcc 的 `nv`）
  let ns = 0;          // 出参区里的下一个偏移（tcc 从 32 起数，减回来是同一件事）
  /* B.3 那些拷贝（>16 字节的聚合按值传 = 传一个指向**调用方那份拷贝**的指针）落在
   * 出参区之后。tcc 也是在同一块 `sub sp` 里划的（`gfunc_call` 的 `a1[i]`）。 */
  let copies = 0;
  const pending = [];
  let k = 0;
  for (const d of descs) {
    const va = nfixed >= 0 && k >= nfixed;
    k++;
    const mem = d.mem === undefined ? null : d.mem;
    /* 返回值那一块（`ARGSRET`）不按实参排 —— 它要么进 x8（>16 字节），要么压根不传
     * （≤16 字节：值从 x0/x1 或 v0-v3 回来，调用方自己写进去）。tcc 的 `arm64_pcs`
     * 把它当 `a[0]` 单独算，这儿同一个道理：不动 nx/nv/ns 三个游标。 */
    if (mem !== null && mem.sret) {
      at.push(mem.size > 16 ? { sret: mem, x8: true } : { sret: mem });
      continue;
    }
    /* 苹果的 arm64 上变参一律走栈（AAPCS64 的苹果改动）：tcc 是
     * `if (variadic && i == variadic) { nx = 8; nv = 8; }`（`arm64-gen.c:836`）——
     * 分界那一格把两串寄存器都数满，后面的自然全落到 C.12 起那几条上。 */
    if (va && nfixed >= 0 && k - 1 === nfixed) { nx = 8; nv = 8; }
    if (mem !== null) {
      const align = mem.align16 ? 16 : 8;
      let size = mem.size;
      const hfa = mem.hfa;
      /* B.2：HFA 不走「换成指针」那一条，哪怕它超过 16 字节
       * （`struct {double a,b,c;}` 是 24 字节的 HFA，进三个 v 寄存器）。
       * B.3：别的 >16 字节的聚合换成一个指针 —— 指向调用方现做的一份拷贝。 */
      if (hfa === null && size > 16) {
        const copyOff = copies;
        copies += size + (size % 8 === 0 ? 0 : 8 - (size % 8));
        if (nx < 8) {
          at.push({ x: nx, ptr: true, bytes: size, copyOff });
          nx++;
        } else {
          ns = alignUp8(ns);
          at.push({ off: ns, ptr: true, bytes: size, copyOff });
          ns += 8;
        }
        pending.push(at[at.length - 1]);
        continue;
      }
      // B.4：聚合按 8 取整
      if (hfa === null) size = alignUp8(size);
      // C.2：HFA 进连着的几个 v 寄存器
      if (hfa !== null && nv + hfa.n <= 8) {
        at.push({ v: nv, hfa, bytes: mem.size });
        nv += hfa.n;
        continue;
      }
      // C.3：放不下的 HFA 把 v 那一串数满，按 8 取整
      if (hfa !== null) {
        nv = 8;
        size = alignUp8(size);
        // C.4
        ns = alignUp8(ns);
        ns = ns + ((align - ns % align) % align);
        // C.6
        at.push({ off: ns, bytes: mem.size });
        ns += size;
        continue;
      }
      // C.8
      if (align === 16) nx = (nx + 1) & ~1;
      // C.10：整个聚合摊进 nx 起的几个整数寄存器
      if (size <= (8 - nx) * 8) {
        /* 字节数不是 8 的整数倍时（`struct {int a; char b;}` 是 12 或 5 字节）先在
         * 出参区里落一份补齐到 8 的拷贝，再从那儿整格整格地取 —— 直接按 8 字节读源，
         * 末尾那一格会读到 struct 之外去，源正好贴着一页的末尾就踩空。tcc 那边是
         * `arm64_ldrs`（`arm64-gen.c:1145`）一条条算宽度拼出来的，效果一样，
         * 而这一条落在「奇数宽度的聚合」这一路上，常见的 8/16 字节一条指令都不多。 */
        const odd = mem.size % 8 !== 0;
        const copyOff = odd ? copies : -1;
        if (odd) copies += size;
        at.push({ x: nx, xn: size / 8, bytes: mem.size, copyOff });
        if (odd) pending.push(at[at.length - 1]);
        nx += size / 8;
        continue;
      }
      // C.11 / C.12 / C.13
      nx = 8;
      ns = alignUp8(ns);
      ns = ns + ((align - ns % align) % align);
      at.push({ off: ns, bytes: mem.size });
      ns += size;
      continue;
    }
    const flt = d.flt === true;
    // C.1
    if (flt && nv < 8) {
      at.push({ v: nv });
      nv++;
      continue;
    }
    // C.5 / C.6：浮点走栈时一格 8 字节
    if (flt) {
      ns = alignUp8(ns);
      at.push({ off: ns });
      ns += 8;
      continue;
    }
    // C.7
    if (d.bytes <= 8 && nx < 8) {
      at.push({ x: nx });
      nx++;
      continue;
    }
    // C.11 / C.12 / C.14 / C.15
    nx = 8;
    ns = alignUp8(ns);
    at.push({ off: ns });
    ns += 8;
  }
  /* 拷贝区排在出参区后面，两块在同一次 `sub sp` 里。偏移到这一步才定 —— 出参区
   * 有多大要等所有实参都排完。 */
  const base = alignUp8(ns);
  for (const p of pending) p.copyOff += base;
  return { at, stack: base + copies, argStack: base };
}

/** 往上取到 8 的倍数（`arm64_pcs_aux` 里那句 `(ns + 7) & ~7` 出现过五次）。 */
function alignUp8(n) { return n + (n % 8 === 0 ? 0 : 8 - (n % 8)); }

/**
 * 出参区要多大：本函数里最费的那次调用要往栈上摆几个字节（按 16 取整）。
 *
 * 三种调用都要数（`CALL`/`CCALL`/`CALLI`，实参池都在 `b` 上）。`CCALL` 的 aux 是
 * 变参分界（第二十二片），另两种没有变参。
 */
function arm64OutArgsBytes(mod, f) {
  let most = 0;
  let i = 0;
  while (i < f.count()) {
    const op = f.op[i];
    if (op === OP.CALL || op === OP.CCALL || op === OP.CALLI) {
      const nfixed = op !== OP.CALL ? callVaFixed(f.aux[i]) : -1;
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

/**
 * 形参那一侧的描述表（喂 `pcsPlaces`）。
 *
 * 与实参那一侧问的是同一个问题（"这一格 ABI 摆在哪儿"），所以走同一段规则：
 * `mem` 是按值收的 struct（前端按在形参表上的那一格），`sret` 是「返回值那一块的地址」
 * 那个隐藏形参 —— 它进 x8，不占 x0（`arm64_pcs` 的 `a[0] == 1`）。
 */
function paramDescs(f) {
  return f.params.map((p) => {
    if (p.sret === true) return { mem: memInfoOf(f.retStruct, true) };
    if (p.mem !== undefined) return { mem: memInfoOf(p.mem, false) };
    return { mem: null, flt: isFloatType(p.t), bytes: scalarBytes(p.t) };
  });
}

function inArgBytes(f) {
  return pcsPlaces(paramDescs(f), -1).argStack;
}

class FnGen {
  /** `buf` 是整个模块共用的一个缓冲，`callLabels` 是「函数号 -> 标签」（没有就不认 CALL），
   * `strSyms` 是「字符串常量的 ref -> 数据段里的符号名」（没有就不认串常量）。 */
  constructor(mod, f, buf, callLabels, strSyms) {
    this.mod = mod;
    this.f = f;
    // 惰性求值位置里不许藏需要临时量的构造（ADR-0011）：拆成一句 if
    let buf0 = buf;
    if (buf0 === undefined) buf0 = new Arm64CodeBuf();
    this.buf = buf0;
    this.callLabels = callLabels === undefined ? null : callLabels;
    this.strSyms = strSyms === undefined ? null : strSyms;
    /* 出参区（第二十二片）：`sp + 0` 起的一块，专给「要走栈的实参」。
     * 苹果的 arm64 上**变参一律走栈**（AAPCS64 的苹果改动）—— 固定实参进 x0-x7/v0-v7，
     * `...` 后面那些一格 8 字节摆在 `sp` 上。所以帧的最底下要留出这一块，
     * 它的大小是本函数里最费的那次调用要的字节数（按 16 取整）。
     * 槽位与值的栈位都往上让开这一块 —— 它必须**紧贴 `sp`**，被调方按 `sp` 找它。 */
    this.outArgs = arm64OutArgsBytes(mod, f);
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
    /* 按值收的 struct 落脚的那几块（第一百三十一片）：进来在**寄存器**里的那些要有一块
     * 地方待着 —— 序言把那几个寄存器存进去、槽里放这一块的地址，于是函数体那一侧照旧
     * 「槽里是一个 struct 的地址」，一个字都不用改。在入参区里的（C.13）与换成指针的
     * （B.3）不用这一块：地址已经现成。
     *
     * 划在帧里而不是出参区：它得活到函数返回，而出参区每次调用都会被踩。 */
    this.paramBlocks = [];
    for (const pl of pcsPlaces(paramDescs(f), -1).at) {
      let need = 0;
      if (pl.xn !== undefined) need = pl.xn * 8;
      else if (pl.hfa !== undefined) need = pl.hfa.n * pl.hfa.size;
      if (need === 0) {
        this.paramBlocks.push(-1);
        continue;
      }
      const pad = bytes % 16 === 0 ? 0 : 16 - (bytes % 16);
      this.paramBlocks.push(bytes + pad);
      bytes = bytes + pad + need;
    }
    this.frame = bytes + (bytes % 16 === 0 ? 0 : 16 - (bytes % 16));
    /* 粘住的那几个（见 `STICKY`）：上一层涂了几个颜色，这儿就要在帧里留几格存
     * 调用者的那几个 x19-x23。`regHint` 不在的话（没跑优化管线）这一格整条不存在，
     * 于是**一个字节都不变** —— 那 88 条编码对账的用例照旧成立。 */
    this.hint = (f.regHint !== undefined && f.regHint !== null && f.regHint.size > 0)
      ? f.regHint : null;
    /* **槽位提升**（`regalloc.js` 的 `slotIntervals`）：这两张表的键是槽号，
     * 涂过色的槽**权威副本就是那个寄存器**，栈位从头到尾没人碰。颜色与值的是同一套
     * （同一个池子分出来的），所以存调用者的那一步要把它们一起算进去。 */
    this.slotHint = (f.slotHint !== undefined && f.slotHint !== null && f.slotHint.size > 0)
      ? f.slotHint : null;
    this.slotHintF = (f.slotHintF !== undefined && f.slotHintF !== null && f.slotHintF.size > 0)
      ? f.slotHintF : null;
    this.stickyColors = [];
    if (this.hint !== null || this.slotHint !== null) {
      const seen = [];
      if (this.hint !== null) for (const c of this.hint.values()) if (seen.indexOf(c) < 0) seen.push(c);
      if (this.slotHint !== null) for (const c of this.slotHint.values()) if (seen.indexOf(c) < 0) seen.push(c);
      seen.sort((a, b) => a - b);
      for (const c of seen) if (c >= 0 && c < STICKY.length) this.stickyColors.push(c);
    }
    this.stickySave = -1;
    if (this.stickyColors.length > 0) {
      this.stickySave = this.frame;
      const need = 8 * this.stickyColors.length;
      this.frame += need + (need % 16 === 0 ? 0 : 16 - (need % 16));
    }
    /* 浮点那一类同一套账（见 `STICKY_F`）：上一层的 `regHintF` 是另一张表、另一套颜色。 */
    this.hintF = (f.regHintF !== undefined && f.regHintF !== null && f.regHintF.size > 0)
      ? f.regHintF : null;
    /* **寄放在 FP 寄存器里的整数值**（`regalloc.js` 的 `GP_IN_F`）：要不到通用颜色的
     * 整数值住进一个 d 寄存器 —— 读 `fmov x,d`、写 `fmov d,x`，一条指令且不碰内存。
     * 用的是**同一批物理寄存器**，所以这几个颜色也要算进下面存调用者的那一步。
     * **这一路今天是关着的**（`GP_IN_F = false`，量出来 −19%，那一段写了账）——
     * 表是空的 ⇒ `hintGF` 是 null ⇒ 这一整族判断一条指令都不影响。 */
    this.hintGF = (f.regHintGF !== undefined && f.regHintGF !== null && f.regHintGF.size > 0)
      ? f.regHintGF : null;
    this.fstickyColors = [];
    if (this.hintF !== null || this.slotHintF !== null || this.hintGF !== null) {
      const seen = [];
      if (this.hintF !== null) for (const c of this.hintF.values()) if (seen.indexOf(c) < 0) seen.push(c);
      if (this.slotHintF !== null) for (const c of this.slotHintF.values()) if (seen.indexOf(c) < 0) seen.push(c);
      if (this.hintGF !== null) for (const c of this.hintGF.values()) if (seen.indexOf(c) < 0) seen.push(c);
      seen.sort((a, b) => a - b);
      /* **只存被调用者保存的那几个**（前 `STICKY_F_SAVED` 个颜色）。草稿那一档
       * （d19-d31）是调用者保存的，上一层保证涂成它们的区间不跨调用点 ⇒ 不用存。 */
      for (const c of seen) if (c >= 0 && c < STICKY_F_SAVED) this.fstickyColors.push(c);
    }
    this.fstickySave = -1;
    if (this.fstickyColors.length > 0) {
      this.fstickySave = this.frame;
      const need = 8 * this.fstickyColors.length;
      this.frame += need + (need % 16 === 0 ? 0 : 16 - (need % 16));
    }
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
    /**
     * 上一条是不是「走了就不回来」的（`RET`/`BR`/`BRTABLE`）—— 是的话后面那几条到下一个
     * 标签落地之前都到不了，一个字都别发（第一百四十二片）。
     *
     * 为什么值这一刀：C 前端在每个函数尾巴上都补一条 `RET 0`（`tccgen.js:7739`），
     * 而函数体自己以 `return` 收尾时那一条就是死的 —— arm64 上是 `movz`+`mov`+`b`
     * 三个字。量出来的：`int add(int,int)` 92 -> 76 字节。
     *
     * 判「到得了」这件事**故意往宽算**：只要碰上一条区域指令（BLOCK/LOOP/IF/ELSE/END）
     * 就当活过来了。真正的判据是「有没有标签钉在这儿」，而 END 那一格钉的标签正可能是
     * 让我们死掉的那条 `BR` 的目标 —— 宽算的代价只是少省几个字，窄算的代价是发出跳不到
     * 的代码，两边不对称。
     */
    this.dead = false;
    /* 寄存器缓存的三张表（见 `POOL`）。全是定长数组 —— 这一格要能被我们自己编出来的
     * 编译器编（ADR-0011 的封闭子集），Map 的迭代器不在里头。 */
    this.uses = countUses(f);
    /* **NZCV 里攥着的那一格比较**（融合比较与跳转，见 `one` 里 IF 那一支的注）：
       `flagCmp` 是那条比较的指令下标、`flagCond` 是它的条件码。-1 = 现在没攥着。 */
    this.flagCmp = -1;
    this.flagCond = 0;
    /**
     * **乘加融合**（`lower` 那一族，照 Go 的 `ARM64.rules:1824-1834`）：
     *     (FADDD a (FMULD  x y)) => (FMADDD  a x y)
     *     (FSUBD a (FMULD  x y)) => (FMSUBD  a x y)
     *     (FSUBD (FMULD x y) a)  => (FNMSUBD a x y)
     * 这张集合记的是**被吃掉的那条 MUL 的 pc** —— 到它的时候一个字都不发，
     * 由紧跟的 ADD/SUB 发一条三源指令。
     *
     * 为什么值得做：go 的 `radiance` 里 `FMADDD` 46 条 + `FMSUBD` 18 条，我们一条都没有；
     * 除了少 64 条指令，点积那种链子的深度也从 5 降到 3（是延迟瓶颈，不是吞吐瓶颈）。
     *
     * 两条刻意收紧的：
     *   - **那条 MUL 必须紧挨在 ADD/SUB 前面**（`pc-1`）。隔着别的指令就要问"跳过它之后
     *     它的操作数还活着吗"，而隔着区域边界（`IF`/`END`）更是把一次乘法挪出了分支。
     *     表达式树本来就编成相邻的两条，够用。
     *   - **那条 MUL 只能有一个使用者**（就是这条 ADD/SUB）。多于一个的话它的结果还有
     *     别人要，吃掉就错了。
     */
    this.fused = null;
    {
      const fu = new Set();
      for (let pc = 1; pc < f.op.length; pc++) {
        const o = f.op[pc];
        if (o !== OP.ADD && o !== OP.SUB) continue;
        if (!isFloatType(f.t[pc])) continue;
        const m = pc - 1;
        if (f.op[m] !== OP.MUL || f.t[m] !== f.t[pc]) continue;
        if (this.uses[m] !== 1) continue;
        const mref = REF_BIAS + m;
        if (f.a[pc] !== mref && f.b[pc] !== mref) continue;
        fu.add(m);
      }
      if (fu.size > 0) this.fused = fu;
    }
    /** 第 s 个池寄存器现在装着哪个值（-1 = 空）。 */
    this.cacheIdx = [-1, -1, -1, -1, -1];
    /** 那个值还剩几次要用（<= 0 = 用光了，寄存器可以让出去）。 */
    this.cacheLeft = [0, 0, 0, 0, 0];
    /** 值 -> 池里的第几个（-1 = 不在寄存器里，得走栈位）。 */
    this.valReg = [];
    for (let k = 0; k < f.count(); k++) this.valReg.push(-1);
    /** `dest` 给这条指令留下的池位置（-1 = 没留），等 `def` 来认领。 */
    this.pending = -1;
  }

  /* -------------------------------------------------------------- 位置 */

  slotOff(no) {
    if (!Number.isInteger(no) || no < 0 || no >= this.f.slots.length) {
      throw new OmniError(`arm64: 槽号 ${no} 越界`);
    }
    return this.slotBase + no * 8;
  }

  /* ------------------------------------------------- 提升到寄存器的槽位 */

  /** 这个槽住在哪个通用寄存器里（-1 = 照旧住栈位）。见 `regalloc.js` 的 `slotIntervals`。 */
  slotSticky(no) {
    if (this.slotHint === null) return -1;
    const c = this.slotHint.get(no);
    if (c === undefined || c < 0 || c >= STICKY.length) return -1;
    return STICKY[c];
  }

  /** 这个槽住在哪个 FP 寄存器里（-1 = 不住）。 */
  slotStickyF(no) {
    if (this.slotHintF === null) return -1;
    const c = this.slotHintF.get(no);
    if (c === undefined || c < 0 || c >= STICKY_F.length) return -1;
    return STICKY_F[c];
  }

  /** 这个槽是 f64 吗（f32 提升时 `fmov` 要用 s 系）。 */
  slotDbl(no) {
    return typeKind(this.f.slots[no].t) !== T_F32;
  }

  /**
   * 把一个**通用寄存器里的位模式**写进槽 —— 序言里给形参落位、`STORE` 走同一条。
   * 涂过色的进那个寄存器（一条 `mov`/`fmov`），没涂色的照旧一条 `str`。
   */
  putSlot(no, greg) {
    const fs = this.slotStickyF(no);
    if (fs >= 0) { this.toFp(fs, greg, this.slotDbl(no)); return; }
    const s = this.slotSticky(no);
    if (s >= 0) { if (s !== greg) this.buf.emit(movReg(1, s, greg)); return; }
    this.frameStore(greg, this.slotOff(no));
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

  /**
   * 帧里的一个 8 字节格子的读写。
   *
   * 偏移超过那一格能表示的范围（`ldr` 的立即数是缩放过的 12 位，8 字节宽时是
   * 0..32760）就**把偏移造进 x30、走「基址 + 寄存器」那一形**（第一百三十三片）。
   * 照 tcc 的 `arm64_ldrx`/`arm64_strx`（`arm64-gen.c`）——它挑的也是 x30：序言里
   * `stp x29, x30` 已经把调用者的那份存起来了，函数体里没人用它，收场再取回来。
   * 量出来的：`src/runtime/omni_r3.c` 的帧有 32768 字节以上，之前这儿直接报错。
   */
  frameLoad(reg, off) {
    if (off <= 32760) {
      this.buf.emit(ldrU(3, reg, this.base, off));
      return;
    }
    this.movImm(30, off);
    this.buf.emit(ldrRegOff(3, reg, this.base, 30));
  }

  frameStore(reg, off) {
    if (off <= 32760) {
      this.buf.emit(strU(3, reg, this.base, off));
      return;
    }
    this.movImm(30, off);
    this.buf.emit(strRegOff(3, reg, this.base, 30));
  }

  /**
   * 同一个格子，但**直接对 FP 寄存器**读写（`ldr d, [base,#off]` / `str d, [base,#off]`）。
   * 省的是那条 `fmov`：一个 double 在栈位与 d 寄存器之间从前要两条。
   *
   * 偏移超出那 12 位缩放立即数（8 字节宽时 0..32760）就回 false —— 调用方退回
   * 「整数那一族 + `fmov`」那条老路。FP 那一族没有"基址 + 寄存器"形的编码器，
   * 而 32KB 以上的帧只有 `omni_r3.c` 那一个（见 `frameLoad`）。
   */
  frameLoadF(freg, off) {
    if (off > 32760) return false;
    this.buf.emit(ldrFpU(3, freg, this.base, off));
    return true;
  }

  frameStoreF(freg, off) {
    if (off > 32760) return false;
    this.buf.emit(strFpU(3, freg, this.base, off));
    return true;
  }

  /**
   * `rd = base + off`（第一百三十一片：按值收发 struct 要「某一块在哪儿」这个地址）。
   *
   * 拆成「多少个 4096」+「余下的」两条**立即数形式**的 add，而不是造个立即数再走
   * 寄存器形式 —— 后者在 `base` 是 `sp` 时是错的：移位寄存器形式里 31 号是 `xzr`
   * 不是 `sp`（同一个坑第二十六片踩过一次，见序言里那一段）。
   */
  addOff(rd, base, off) {
    const hi = Math.floor(off / 4096);
    const lo = off % 4096;
    if (hi > 4095) throw new OmniError(`arm64: 偏移 ${off} 太大（两条 add 装不下）`);
    if (hi === 0) {
      this.buf.emit(addImm(1, rd, base, lo));
      return;
    }
    this.buf.emit(addImm(1, rd, base, hi, 1));
    if (lo > 0) this.buf.emit(addImm(1, rd, rd, lo));
  }

  /* -------------------------------------------------------------- 立即数
   * `movz` + 三条 `movk`。全 1 的高位用 `movn` 起头能省两条，这里先不省 ——
   * 省的那两条要靠「哪几个 16 位段是 0xffff」来判，属于下一片的窥孔。 */
  movImm(reg, value) {
    let v = BigInt.asUintN(64, BigInt(value));
    this.buf.emit(movz(1, reg, Number(v % 65536n), 0));
    for (let hw = 1; hw < 4; hw++) {
      v /= 65536n;
      const part = Number(v % 65536n);
      if (part !== 0) this.buf.emit(movk(1, reg, part, hw));
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
      return arm64Nyi(`常量 ${k.kind}`);
    }
    /* 在池寄存器里（见 `POOL`）就一条 `mov` —— 省的是一次访存。真正省下一整条指令的是
     * `refReg`：那条连 `mov` 都不发。 */
    const vi = this.f.at(ref);
    /* 粘住的那几个（见 `STICKY`）：一条 `mov`，而且**没有任何簿记** ——
     * 它从定义到最后一次使用一直住在那儿，读几次都不用减什么计数。 */
    const sk = this.stickyAt(vi);
    if (sk >= 0) {
      this.buf.emit(movReg(1, reg, sk));
      return;
    }
    /* 浮点那一套粘住的（见 `STICKY_F`）：权威副本在 d 寄存器里，一条 `fmov` 搬出位模式。
     * 这比从前那条 `ldr` 还省 —— 它连内存都不碰。 */
    const fsk = this.fstickyAt(vi);
    if (fsk >= 0) {
      this.fromFp(reg, fsk, typeKind(this.f.t[vi]) !== T_F32);
      return;
    }
    const s = this.valReg[vi];
    if (s >= 0) {
      this.cacheLeft[s] -= 1;
      this.buf.emit(movReg(1, reg, POOL[s]));
      return;
    }
    /* 寄放进 FP 的整数值（见 `gfAt`）：一条 `fmov x,d` 取出位模式 —— 顶掉的是那条
     * `ldr`，而且不碰内存。栈位从头到尾没人写过，所以这一条必须在 `frameLoad` 之前。 */
    const gf = this.gfAt(vi);
    if (gf >= 0) {
      this.fromFp(reg, gf, true);
      return;
    }
    this.frameLoad(reg, this.valOff(vi));
  }

  /** 这个 ref 是个整数常量吗（bool 按 0/1 算）—— 是就回它的值，不是回 null。 */
  intConst(ref) {
    if (ref === REF_NONE || !isConstRef(ref)) return null;
    const k = this.mod.consts.get(ref);
    if (k.kind === 'int') return BigInt(k.text);
    if (k.kind === 'bool') return k.text === 'true' ? 1n : 0n;
    return null;
  }

  /** 这个 ref 是个浮点常量吗 —— 是就回它的数值，不是回 null。 */
  realConst(ref) {
    if (ref === REF_NONE || !isConstRef(ref)) return null;
    const k = this.mod.consts.get(ref);
    return k.kind === 'real' ? Number(k.text) : null;
  }

  /**
   * 二目的右操作数是常量时，**能不能直接用立即数那一形**（第一百四十五片）。能就当场
   * 发完（连 `def` 一起）、回 true；不能回 false，调用方照旧把常量装进寄存器再算。
   *
   * 省的是那条 `movz`：整份 `.text` 的 972 万条指令里 `mov` 占 321 万，造常量是其中一份。
   * 认三类 ——
   *   - `+`/`-`：12 位无符号。常量是负的就换一条方向（`x + (-3)` = `sub x, #3`）；
   *   - 移位：位数是常量就走 `lsl`/`lsr`/`asr` 的立即数形（`ubfm`/`sbfm`）；
   *   - `&`/`|`/`^`：走**逻辑立即数**，但只认两种保证编得出来的形状（见 `maskImmOk`）。
   * 乘除取余没有立即数形，`bitmaskImm` 也不敢乱试 —— 它编不了就抛，而这一层不接异常。
   */
  binImm(op, sf, i, x, k, w) {
    const buf = this.buf;
    if (op === OP.ADD || op === OP.SUB) {
      /* `x - k` 就是 `x + (-k)`：先归一到「加多少」，再按正负挑 add / sub。 */
      const up = op === OP.SUB ? -k : k;
      if (up >= 0n && up <= 4095n) {
        const d = this.dest(i, x);
        buf.emit(addImm(sf, d, x, Number(up)));
        this.def(i, d, w);
        return true;
      }
      if (up < 0n && up >= -4095n) {
        const d = this.dest(i, x);
        buf.emit(subImm(sf, d, x, Number(-up)));
        this.def(i, d, w);
        return true;
      }
      return false;
    }
    if (op === OP.SHL || op === OP.SHR || op === OP.USHR) {
      const lim = sf === 1 ? 64n : 32n;
      if (k < 0n || k >= lim) return false;
      const n = Number(k);
      const d = this.dest(i, x);
      if (op === OP.SHL) buf.emit(lslImm(sf, d, x, n));
      else if (op === OP.SHR) buf.emit(asrImm(sf, d, x, n));
      else buf.emit(lsrImm(sf, d, x, n));
      this.def(i, d, w);
      return true;
    }
    if (op === OP.BAND || op === OP.BOR || op === OP.BXOR) {
      if (!maskImmOk(sf, k)) return false;
      const d = this.dest(i, x);
      if (op === OP.BAND) buf.emit(andImm(sf, d, x, k));
      else if (op === OP.BOR) buf.emit(orrImm(sf, d, x, k));
      else buf.emit(eorImm(sf, d, x, k));
      this.def(i, d, w);
      return true;
    }
    return false;
  }

  /* ------------------------------------------- 粘住的那几个（见 `STICKY`） */

  /** 这个值下标住在哪个粘住的寄存器里（-1 = 不住，照旧走栈位/POOL）。 */
  stickyAt(i) {
    if (this.hint === null) return -1;
    const c = this.hint.get(i);
    if (c === undefined || c < 0 || c >= STICKY.length) return -1;
    return STICKY[c];
  }

  /** 这个 ref 住在哪个粘住的寄存器里（常量与 REF_NONE 一律 -1）。 */
  stickyRef(ref) {
    if (this.hint === null || ref === REF_NONE || isConstRef(ref)) return -1;
    return this.stickyAt(this.f.at(ref));
  }

  /** 序言里存下调用者的那几个 / 收场里取回来。只动真用到的那几格。 */
  stickySpill(save) {
    const n = this.stickyColors.length;
    if (n === 0) return;
    /* **成对存取**（`stp`/`ldp`）：一条顶两条。它的偏移是按 8 缩放的 7 位有符号
     * （±512 字节），而 `stickySave` 常在几千（`omni_r3.c` 的帧上万），所以先用一条
     * `add` 把近的基址算到草稿里 —— 六对少发六条，那一条 `add` 划得来。
     * 草稿用 `TMP0`：序言里还没人用它，收场里返回值在 x0/d0、它也空着。 */
    this.addOff(TMP0, this.base, this.stickySave);
    let k = 0;
    for (; k + 1 < n; k += 2) {
      const a = STICKY[this.stickyColors[k]], b = STICKY[this.stickyColors[k + 1]];
      this.buf.emit(save ? stp(1, a, b, TMP0, k * 8) : ldp(1, a, b, TMP0, k * 8));
    }
    if (k < n) {
      const a = STICKY[this.stickyColors[k]];
      this.buf.emit(save ? strU(3, a, TMP0, k * 8) : ldrU(3, a, TMP0, k * 8));
    }
  }

  /* ---------------------------------------- 浮点那一套粘住的（见 `STICKY_F`） */

  /**
   * 这个值下标住在哪个 FP 寄存器里（-1 = 不住）。
   *
   * 住在这儿的值**权威副本就是那个 d 寄存器** —— 栈位从头到尾没人写过。所以每一条
   * 读路径都得先问这一条：`loadRef`/`refReg`（要位模式的，一条 `fmov` 搬出来）、
   * `float`/`cvtToFloat`（要浮点的，直接用）。写路径只有 `def` 一处（`fmov` 搬进来）。
   */
  fstickyAt(i) {
    if (this.hintF === null) return -1;
    const c = this.hintF.get(i);
    if (c === undefined || c < 0 || c >= STICKY_F.length) return -1;
    return STICKY_F[c];
  }

  /** 这个 ref 住在哪个 FP 寄存器里（常量与 REF_NONE 一律 -1）。 */
  fstickyRef(ref) {
    if (this.hintF === null || ref === REF_NONE || isConstRef(ref)) return -1;
    return this.fstickyAt(this.f.at(ref));
  }

  /**
   * 这个**整数**值寄放在哪个 FP 寄存器里（-1 = 没寄放）。见 `regalloc.js` 的 `GP_IN_F`。
   *
   * 与 `fstickyAt` 的差别只在"住着的是什么"：那边是真浮点值（`fRefReg` 直接拿去算），
   * 这边是**位模式** —— 只有三条路认它：`dest`（算进 `RES`）、`def`（一条 `fmov d,x`
   * 存进去）、`loadRef`（一条 `fmov x,d` 取出来）。`refReg` 不必认：它问不到 POOL
   * 就转手 `loadRef`。别的地方（浮点那些快路）按 MIR 类型分流，整数值走不到。
   */
  gfAt(i) {
    if (this.hintGF === null) return -1;
    const c = this.hintGF.get(i);
    if (c === undefined || c < 0 || c >= STICKY_F.length) return -1;
    return STICKY_F[c];
  }



  /** 序言里存下调用者的 d8-d15 / 收场里取回来。只动真用到的那几格。
   *  用 FP load/store 一条指令 `str d, [base, #off]` / `ldr d, [base, #off]` 搞定，
   *  比从前走 `fmov + str/ldr + fmov` 省两条。 */
  fstickySpill(save) {
    const n = this.fstickyColors.length;
    if (n === 0) return;
    /* 与 `stickySpill` 同一套：`stp d,d` / `ldp d,d`（Go 那边发的就是 FSTPD/FLDPD）。 */
    this.addOff(TMP0, this.base, this.fstickySave);
    let k = 0;
    for (; k + 1 < n; k += 2) {
      const a = STICKY_F[this.fstickyColors[k]], b = STICKY_F[this.fstickyColors[k + 1]];
      this.buf.emit(save ? stpFp(a, b, TMP0, k * 8) : ldpFp(a, b, TMP0, k * 8));
    }
    if (k < n) {
      const a = STICKY_F[this.fstickyColors[k]];
      this.buf.emit(save ? strFpU(3, a, TMP0, k * 8) : ldrFpU(3, a, TMP0, k * 8));
    }
  }

  /* ------------------------------------------------- 寄存器缓存（见 `POOL`） */

  /** 池里的一个位置：先要空的，没空的就收一个用光了的。都没有回 -1。
   *  `a`/`b` 是要**避开**的寄存器（见 `dest`）。 */
  takeSlot(a, b) {
    for (let s = 0; s < 5; s++) {
      if (this.cacheIdx[s] === -1 && POOL[s] !== a && POOL[s] !== b) return s;
    }
    for (let s = 0; s < 5; s++) {
      if (this.cacheLeft[s] <= 0 && POOL[s] !== a && POOL[s] !== b) {
        this.valReg[this.cacheIdx[s]] = -1;
        this.cacheIdx[s] = -1;
        return s;
      }
    }
    return -1;
  }

  /**
   * 这条指令的结果**直接算进哪个寄存器**：池里要得到位置就算进池寄存器，`def` 认领它时
   * 连那条 `mov RES -> 池` 都不发（每个有人要的值省一个字）。要不到就回 `RES`，
   * 走从前那条路。
   *
   * 两条使用规矩：
   *   - **先把操作数读进来（`refReg`）再要落点** —— 反过来会占掉本来能让出来的位置；
   *   - 操作数所在的寄存器要当 `a`/`b` 传进来**避开**：让出来的位置可能正是它们之一
   *     （`refReg` 刚把那个值读空），而 `MOD` 那两条（`sdiv d,x,y` 接 `msub d,d,y,x`）
   *     里 d 撞上 x 或 y 就算错了。
   */
  dest(i, a, b) {
    /* 粘住的那几个（见 `STICKY`）：上一层已经给这个值定了住处，**直接算进去** ——
     * 连 `def` 里那条 `mov` 都省了。不会撞上还活着的操作数：分配器在 pc 处只让
     * `end < pc` 的区间到期（`regalloc.js` 的 expire 那一步），所以这条指令的操作数
     * 若在这儿还要用，它的颜色此刻不在空闲池里。 */
    const sk = this.stickyAt(i);
    if (sk >= 0) return sk;
    /* 浮点那一套（见 `STICKY_F`）：`def` 会从这个寄存器 `fmov` 进它的 d 寄存器，
     * 所以不必占 POOL 的位子 —— 占了也白占（`def` 那一路不认领）。 */
    if (this.fstickyAt(i) >= 0) return RES;
    /* 寄放进 FP 的整数值（见 `gfAt`）：`def` 会从 `RES` 一条 `fmov` 搬进去，
     * 同理不必占 POOL 的位子。 */
    if (this.gfAt(i) >= 0) return RES;
    if (this.uses[i] === 0) return RES;
    const s = this.takeSlot(a, b);
    if (s < 0) return RES;
    this.pending = s;
    return POOL[s];
  }

  /**
   * **这个 ref 现在在哪个寄存器里** —— 在池里就直接回那一个（一个字都不发），
   * 否则装进 `fallback` 再回它。省下来的正是那条 `ldr`。
   *
   * 调用方只要「有个寄存器装着这个值」而不在乎是哪个时用这一条；非得是某一个特定
   * 寄存器（实参要进 x0、返回值要进 x0）时用 `loadRef`。
   */
  refReg(ref, fallback) {
    if (ref !== REF_NONE && !isConstRef(ref)) {
      /* 粘住的那几个先问（见 `STICKY`）：一个字都不发。 */
      const sk = this.stickyAt(this.f.at(ref));
      if (sk >= 0) return sk;
      /* 浮点那一套（见 `STICKY_F`）：得搬出位模式，一条 `fmov`（照旧不碰内存）。 */
      if (this.fstickyRef(ref) >= 0) {
        this.loadRef(fallback, ref);
        return fallback;
      }
      const s = this.valReg[this.f.at(ref)];
      if (s >= 0) {
        this.cacheLeft[s] -= 1;
        return POOL[s];
      }
    }
    this.loadRef(fallback, ref);
    return fallback;
  }

  /**
   * 把还有人要的那几个写回栈位，清空缓存。
   *
   * 三处必须走：控制流一分岔或一合并（区域指令、`BR`/`BRIF`/`BRTABLE`/`RET`）——
   * 缓存只在一段直线代码里成立；以及**每条 `bl` 之前** —— x11-x15 是调用者保存的。
   * 用光了的（`cacheLeft <= 0`）连写都不写：那一格从头到尾没碰过内存。
   *
   * 「用光了」这件事全靠 `countUses` 数得准：数漏一处，攥着的值就会被当成用完了、
   * 让给下一个 def，而它的下一次读会去读一个从没写过的栈位。已知要特别数的只有
   * `ARGSRET`（见 `countUses` 末尾那一段），别的口径都由角色表 `OP_MODES` 兜住。
   */
  flush() {
    for (let s = 0; s < 5; s++) {
      const i = this.cacheIdx[s];
      if (i === -1) continue;
      if (this.cacheLeft[s] > 0) {
        this.frameStore(POOL[s], this.valOff(i));
      }
      this.valReg[i] = -1;
      this.cacheIdx[s] = -1;
      this.cacheLeft[s] = 0;
    }
  }

  /**
   * `RET` 处也走一趟 `flush`（摆在那条 `b` 之前）：此刻攥着的值按理都是死的（剩下的
   * 引用在这条 `RET` 之后，到不了），但「按理」不够 —— 到不了的那一段里若有一条区域
   * 指令把标签钉下来，后面那几条就又发得出来了（`dead` 是往宽算的）。写回去几条 `str`
   * 换掉一整类「读一个从没落地的栈位」，这笔账划得来。
   */
  dropCache() {
    this.flush();
  }

  /** 一个 ref 产出的类型（比较的 `t` 是操作数的类型，所以不能直接读 `t`）。 */
  typeOfRef(ref) {
    return this.f.typeOf(ref, this.mod.consts);
  }

  /** 位模式 -> FP 寄存器。`fmov` 的整数那一侧要与浮点宽度同宽（d 配 x、s 配 w）。 */
  toFp(fdst, greg, dbl) {
    this.buf.emit(fmovFromInt(dbl ? 1 : 0, dbl, fdst, greg));
  }

  /** FP 寄存器 -> 位模式。 */
  fromFp(gdst, fsrc, dbl) {
    this.buf.emit(fmovToInt(dbl ? 1 : 0, dbl, gdst, fsrc));
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
    buf.emit(stpPre(1, 29, 30, SP, -16), movSp(1, 29, SP));
    /* 帧超过 4096 时**不能**用「造立即数 + sub 寄存器形式」（第二十六片改掉的一个真错误）：
     * add/sub 的**移位寄存器形式**里 31 号是 `xzr`、不是 `sp` —— `sub sp, sp, x9` 那条
     * 于是编成 `sub xzr, xzr, x9`，一条空指令。`sp` 没降下来，随后的 `str [sp, #off]`
     * 就写到**调用者的帧**里去，症状是回不去（PC 变成一个小整数）而现场早已离开。
     * 立即数形式有 `lsl #12` 那一位，所以拆成「多少个 4096」+「余下的」两条 —— 两条都
     * 是立即数形式，31 号在那儿就是 `sp`。 */
    if (this.frame > 0) {
      const hi = Math.floor(this.frame / 4096);
      const lo = this.frame % 4096;
      if (hi > 4095) arm64Nyi(`帧 ${this.frame} 字节（一次 sub 装不下）`);
      if (hi > 0) buf.emit(subImm(1, SP, SP, hi, 1));
      if (lo > 0) buf.emit(subImm(1, SP, SP, lo));
    }
    /* 会动栈顶的函数（第三十六片）：存下调用者的 x28，再把降完的 `sp` 抄进它。
     * 这两条只能按 `sp` 写 —— `FB` 还没成立。 */
    if (this.dynStack) {
      buf.emit(strU(3, FB, SP, this.fbSave), movSp(1, FB, SP));
    }
    /* 粘住的那几个（见 `STICKY`）：存下调用者的那几个 x19-x23。摆在 `FB` 成立之后 ——
     * 会动栈顶的函数里这几格按 `FB` 寻址。 */
    if (this.stickyColors.length > 0) this.stickySpill(true);
    /* 浮点那一套（见 `STICKY_F`）：同一笔账，存下调用者的 d8-d15。
     * 必须在形参落位**之前** —— 形参落位会走 `def`，而 `def` 已经会往 d 寄存器里写。 */
    if (this.fstickyColors.length > 0) this.fstickySpill(true);
    /* 形参：AAPCS 把整数与浮点**分成两串**数（x0-x7 与 v0-v7 各自从 0 起），
     * 所以两个计数器。放不下的从**入参区**读（第二十三片）：调用方摆在它自己的
     * 出参区里，也就是我们这一层 `fp + 16` 起的地方（`fp`/`lr` 那一对占了前 16）。
     *
     * 一格按 8 字节读。欠账：i32 的形参按规范形（符号扩展的 64 位）用，而别人（clang）
     * 摆在栈上的那一格高 32 位是不保证的 —— 与寄存器那一路的同一笔账（那边也直接
     * 存了整个 x 寄存器），一起还。 */
    /* 形参照 `pcsPlaces` 摆（第一百三十一片起与实参那一侧共用同一段规则）：
     * 整数与浮点分成两串（x0-x7 与 v0-v7），放不下的从**入参区**读 —— 调用方摆在它
     * 自己的出参区里，也就是我们这一层 `fp + 16` 起的地方（`fp`/`lr` 那一对占了前 16）。
     *
     * 一格按 8 字节读。欠账：i32 的形参按规范形（符号扩展的 64 位）用，而别人（clang）
     * 摆在栈上的那一格高 32 位是不保证的 —— 与寄存器那一路的同一笔账，一起还。 */
    const places = pcsPlaces(paramDescs(f), -1).at;
    let pi = 0;
    for (const p of f.params) {
      const place = places[pi];
      const blk = this.paramBlocks[pi];
      pi++;
      /* 隐藏的返回值指针（>16 字节那条路）：它在 **x8** 里，不在 x0 里。 */
      if (place.sret !== undefined) {
        this.putSlot(p.slot, 8);
        continue;
      }
      /* HFA 进来在 v 寄存器里（C.2）：落进 `blk` 那一块，槽里放它的地址。
       * **先把地址算进草稿**再按它存：`str` 的偏移是缩放过的 12 位，帧一大
       * （`omni_r3.c` 的帧有四万多字节）那一格就装不下，而症状是编不出来。 */
      if (place.hfa !== undefined) {
        const dbl = place.hfa.size === 8;
        this.addOff(TMP1, this.base, blk);
        for (let j = 0; j < place.hfa.n; j++) {
          this.fromFp(TMP0, place.v + j, dbl);
          buf.emit(strU(dbl ? 3 : 2, TMP0, TMP1, j * place.hfa.size));
        }
        this.putSlot(p.slot, TMP1);
        continue;
      }
      /* 聚合摊在几个整数寄存器里（C.10）：同上，落进 `blk`。 */
      if (place.xn !== undefined) {
        this.addOff(TMP1, this.base, blk);
        for (let j = 0; j < place.xn; j++) {
          buf.emit(strU(3, place.x + j, TMP1, j * 8));
        }
        this.putSlot(p.slot, TMP1);
        continue;
      }
      /* 入参区里的一整块（C.13）：**不用拷** —— 地址就是它待着的地方，而「形参是实参的
       * 一份可改的拷贝」那次拷贝是前端发的（`structCopy`），不是这一层的事。 */
      if (place.off !== undefined && place.bytes !== undefined && place.ptr !== true) {
        this.addOff(TMP0, 29, 16 + place.off);
        this.putSlot(p.slot, TMP0);
        continue;
      }
      /* 入参区里的一格（标量、或 B.3 换成的那个指针）。 */
      if (place.off !== undefined) {
        buf.emit(ldrU(3, TMP0, 29, 16 + place.off));
        this.putSlot(p.slot, TMP0);
        continue;
      }
      if (place.v !== undefined) {
        this.fromFp(TMP0, place.v, typeKind(p.t) === T_F64);
        this.putSlot(p.slot, TMP0);
        continue;
      }
      this.putSlot(p.slot, place.x);
    }

    for (let i = 0; i < f.count(); i++) {
      /* `OMNI_EMIT_STAT=1`：**每条 MIR op 各发了多少条机器指令**。
       * 加这张表是吃过教训的：光看 `objdump` 里 `ldr` 的总数，判不出那些 `ldr` 是
       * `MLOAD`（真访存）、`LOAD`（槽位）还是值溢出回读 —— 少了它，连着六个假设
       * 全被自己的测量否掉。量过再改。 */
      if (EMIT_STAT === null) { this.one(i); continue; }
      const n0 = buf.words.length;
      this.one(i);
      const nm = OP_NAMES[f.op[i]];
      let e = EMIT_STAT.get(nm);
      if (e === undefined) { e = { n: 0, k: 0 }; EMIT_STAT.set(nm, e); }
      e.n += buf.words.length - n0;
      e.k += 1;
    }

    buf.place(this.retLabel);
    /* 粘住的那几个（见 `STICKY`）：取回调用者的那几个。要在 `FB` 还有效、`sp` 还没收回去
     * 的时候发 —— 下面那两行会把两样都毁掉。 */
    if (this.stickyColors.length > 0) this.stickySpill(false);
    /* 浮点那一套（见 `STICKY_F`）：同一处取回。用的草稿是 `TMP0` 与 d8-d15，
     * 都不碰返回值（x0 / d0），所以摆在这儿是安全的。 */
    if (this.fstickyColors.length > 0) this.fstickySpill(false);
    /* 会动栈顶的函数：先把调用者的 x28 取回来（这一条得在 `FB` 还有效的时候发），
     * 再按 `x29` 把 `sp` 收回去 —— `sp` 这会儿可能停在某个变长数组下面。 */
    if (this.dynStack) buf.emit(ldrU(3, FB, FB, this.fbSave));
    if (this.frame > 0) buf.emit(movSp(1, SP, 29));
    buf.emit(ldpPost(1, 29, 30, SP, 16), retArm64());
    return buf;
  }

  one(i) {
    const f = this.f;
    const buf = this.buf;
    const op = f.op[i];
    const t = f.t[i];
    /* **NZCV 里攥着的那格比较，读一次就清**：只有紧跟在比较后面的那条 IF/BRIF 算数，
       别的指令一律当它没了（这一层不去逐条判"这条会不会动标志位"，那是猜）。 */
    const flagCmp = this.flagCmp;
    this.flagCmp = -1;

    /* 到不了的就不发（见构造器里的 `dead`）。区域指令照旧走 —— 它们钉的标签是「活过来」
     * 的唯一入口，跳过的话 END 那一格的落点就没了。 */
    if (this.dead) {
      if (op !== OP.BLOCK && op !== OP.LOOP && op !== OP.IF && op !== OP.ELSE && op !== OP.END) {
        return;
      }
      this.dead = false;
    }

    /* ---- 控制流。每一条都得先把缓存写回栈位（见 `flush`）：缓存只在一段直线代码里
     * 成立。带条件的那几条**先取条件、后 flush** —— 反过来的话刚存下去的那一个立刻又要
     * 读回来，白搭一条 `ldr`。 */
    if (op === OP.BLOCK) {
      this.flush();
      this.regions.push({ kind: 'block', endLabel: buf.label() });
      return;
    }
    if (op === OP.LOOP) {
      this.flush();
      const contLabel = buf.label();
      buf.place(contLabel);
      this.regions.push({ kind: 'loop', endLabel: buf.label(), contLabel });
      return;
    }
    if (op === OP.IF) {
      /**
       * **比较与跳转融合**（Go 的 `ARM64.rules`：`(If (LessThan cmp) yes no) => (BLT cmp …)`
       * 加 `flagalloc` 那一格）。紧挨着的那条比较把结果留在 NZCV 里、而且**只有这一处用它**
       * 时，`cset` + `cbz` 两条并成一条 `b.<反条件>`。
       *
       * 为什么中间那趟 `flush()` 不会把标志位弄丢（这是这一刀唯一要证的事）：
       * `flush` 只发 `str`（`strU` / `movz|movk` + `strRegOff`），一条都不动 NZCV。
       * 只融合**整数**那一族 —— 浮点的条件反过来不等价（NaN 是无序的，`b.ge` 的反面
       * 不是 `b.lt`）。
       *
       * 反条件就是条件码的最低位取反（ARM 的约定：eq/ne、ge/lt、gt/le、cs/cc、hi/ls
       * 都是成对排的），所以 `cond ^ 1` 是精确的，不是近似。
       */
      if (flagCmp >= 0 && !isConstRef(f.a[i]) && f.at(f.a[i]) === flagCmp) {
        this.flush();
        const elseLabel = buf.label();
        buf.bcond(this.flagCond ^ 1, elseLabel);
        this.regions.push({ kind: 'if', endLabel: buf.label(), elseLabel, elseDone: false });
        return;
      }
      const c = this.refReg(f.a[i], TMP0);
      this.flush();
      const elseLabel = buf.label();
      buf.cbz(1, c, elseLabel);
      this.regions.push({ kind: 'if', endLabel: buf.label(), elseLabel, elseDone: false });
      return;
    }
    if (op === OP.ELSE) {
      const r = this.regions[this.regions.length - 1];
      if (r === undefined || r.kind !== 'if') throw new OmniError('arm64: ELSE 没有对应的 IF');
      this.flush();
      buf.b(r.endLabel);
      buf.place(r.elseLabel);
      r.elseDone = true;
      return;
    }
    if (op === OP.END) {
      const r = this.regions.pop();
      if (r === undefined) throw new OmniError('arm64: END 多了一条');
      this.flush();
      /* 没有 ELSE 的 IF：条件假就直接落到 END —— 两个标签钉在同一处。 */
      if (r.kind === 'if' && !r.elseDone) buf.place(r.elseLabel);
      buf.place(r.endLabel);
      return;
    }
    if (op === OP.BR) {
      this.flush();
      buf.b(this.brTarget(f.aux[i]));
      this.dead = true;
      return;
    }
    if (op === OP.BRIF) {
      /* 与 IF 那一支同一条（那儿有整段账）：融合得上就一条 `b.<条件>`。 */
      if (flagCmp >= 0 && !isConstRef(f.a[i]) && f.at(f.a[i]) === flagCmp) {
        this.flush();
        buf.bcond(this.flagCond, this.brTarget(f.aux[i]));
        return;
      }
      const c = this.refReg(f.a[i], TMP0);
      this.flush();
      buf.cbnz(1, c, this.brTarget(f.aux[i]));
      return;
    }
    /* `BRTABLE`（第十九片，C 的 `switch` 落在这儿）：**比较链**，不是跳表。
     * 一张真跳表要在数据段里摆一串地址、再靠重定位填进去；比较链一条指令都不欠链接器，
     * 而 n 小的时候（C 里绝大多数 switch）两者差不了几个周期。密集化已经在前端做过了
     * （`0 <= a < n` 的那一段），所以这里只是「等于 k 就跳第 k 项」。
     * 下标按**无符号**读：负数与 >= n 都落到兜底那一支。 */
    if (op === OP.BRTABLE) {
      const x = this.refReg(f.a[i], TMP0);
      this.flush();
      const levels = f.levelsOf(f.b[i]);
      let k = 0;
      for (const lv of levels) {
        if (k >= 4096) arm64Nyi('BRTABLE 的表超过 4096 项（cmp 的立即数装不下）');
        buf.emit(cmpImm(1, x, k));
        buf.bcond(COND.eq, this.brTarget(lv));
        k++;
      }
      buf.b(this.brTarget(f.aux[i]));
      this.dead = true;
      return;
    }
    if (op === OP.RET) {
      if (f.a[i] !== REF_NONE) {
        /* 返回一整块 struct 且 ≤16 字节（第一百三十一片）：MIR 那条 RET 带的是**那一块的
         * 地址**，而 ABI 要的是值在 x0/x1（或 v0-v3，HFA）里 —— 所以在这儿装一次。
         * 与 tcc 的 `gfunc_return`（`arm64-gen.c:1546`）是同一件事。>16 字节那条路不走
         * 这儿：被调方写的就是 x8 那个地址，回去照旧把地址放 x0（tcc 的 rax 也一样）。
         *
         * 那一块前端补齐到了至少 16 字节，所以满 8 字节地读，不按 5/6/7 分岔。 */
        const rs = f.retStruct;
        if (rs !== 0 && memArgSize(rs) <= 16) {
          this.loadRef(TMP0, f.a[i]);
          const hfa = memArgHfa(rs);
          if (hfa !== null) {
            const dbl = hfa.size === 8;
            for (let j = 0; j < hfa.n; j++) {
              buf.emit(ldrU(dbl ? 3 : 2, TMP1, TMP0, j * hfa.size));
              this.toFp(j, TMP1, dbl);
            }
          } else {
            buf.emit(ldrU(3, 0, TMP0, 0));
            if (memArgSize(rs) > 8) buf.emit(ldrU(3, 1, TMP0, 8));
          }
          this.dropCache();
          buf.b(this.retLabel);
          this.dead = true;
          return;
        }
        /* 浮点的返回值在 d0，整数在 x0。i32 的规范形是符号扩展过的 64 位，而 AAPCS
         * 只看 w0 —— 两边都对，不用再削。
         *
         * 整数那一路**直接取进 x0**（第一百四十二片）：先进 x8 再 `mov x0, x8` 是白发的
         * 一条 —— 这之后没人再用 x8，而 `loadRef` 对哪个寄存器都一样。每个「带值的
         * return」省一个字。 */
        if (isFloatType(t)) {
          this.loadRef(TMP0, f.a[i]);
          this.toFp(0, TMP0, typeKind(t) === T_F64);
        } else {
          this.loadRef(0, f.a[i]);
        }
      }
      this.dropCache();
      buf.b(this.retLabel);
      this.dead = true;
      return;
    }

    /* ---- 调用。整数实参进 x0-x7、浮点实参进 v0-v7（两串各自从 0 起数），返回值在
     * x0 或 d0。跨调用**活着的东西一个也没有**：实参摆完就把寄存器缓存写回栈位
     * （`flush`，x11-x15 是调用者保存的），于是整个调用点还是一条溢出逻辑都不欠。
     * 次序要紧：flush 摆在实参之后 —— 实参正好是刚算出来的那几个值，那时它们还在
     * 寄存器里，一条 `ldr` 都省了。 */
    if (op === OP.CALL) {
      const g = this.mod.funcs[f.a[i]];
      if (this.mathIntrinsic(i, t, g === undefined ? '' : g.name, g)) return;
      if (this.callLabels === null) arm64Nyi('单个函数里的 CALL（要按整个模块生成才有落点）');
      const sret = this.callArgs(f.argsOf(f.b[i]), -1);
      this.flush();
      /* 模块内的直接调用也走**符号**（第一百二十七片，与 x64 那一份同一条）：位移留 0、
       * 发一条重定位。量过 tcc：哪怕被调的就在同一个 `.o` 里、哪怕它是局部符号，
       * `.rela.text` 里也有那一条。`callLabels` 还留着 —— 那一格是「这个模块里有没有
       * 落点」的判据。 */
      buf.blSym(this.funcSym(f.a[i]));
      return this.callRet(i, t, sret);
    }
    /* `CCALL` 是**外部符号**（`printf`、`malloc`）。模块内的调用走标签、跨模块的走符号
     * ——这一格是欠链接器的第一笔账（`asm.js` 的 `blSym` 记，`macho.js` 写成
     * `ARM64_RELOC_BRANCH26`）。 */
    if (op === OP.CCALL) {
      const name = this.mod.cabi[f.a[i]];
      if (name === undefined) throw new OmniError(`arm64: 没有 ${f.a[i]} 号 C 入口`);
      if (this.mathIntrinsic(i, t, name, null)) return;
      /* aux 是变参分界（第二十二片）：0 = 不是变参调用，否则固定实参个数 + 1。
       * 高位那一格（`CALL_LDRET`）是 x86_64 的事，这条腿上前端不会点它。 */
      const sret = this.callArgs(f.argsOf(f.b[i]), callVaFixed(f.aux[i]));
      this.flush();
      buf.blSym(name);
      return this.callRet(i, t, sret);
    }
    /* `CALLI` 是**按指针调用**（第二十七片）。native 上函数指针就是真地址，所以一条
     * `blr`。次序要紧：先把实参摆好（那一步用 x0-x7 与草稿寄存器），**再**把目标地址
     * 取进草稿 —— 反过来的话备实参那几条会把目标踩掉。 */
    if (op === OP.CALLI) {
      if (!this.mod.native) arm64Nyi('CALLI（解释器那条腿上函数指针是「号 + 1」，不是地址）');
      /* aux 是变参分界（第三十五片），与 `CCALL` 同一个编码。 */
      const sret = this.callArgs(f.argsOf(f.b[i]), callVaFixed(f.aux[i]));
      this.loadRef(TMP0, f.a[i]);
      this.flush();
      buf.emit(blr(TMP0));
      return this.callRet(i, t, sret);
    }
    /* `SYSCALL`（第一百四十片）：**不是**调用 —— 没有 `bl`、没有出参区、`sp` 一动不动。
     *
     * 两家内核两套摆法（`mod.os` 那一格就是为这儿立的）：
     *   Linux ：号进 x8、实参 x0-x5、`svc #0`，失败回 `-errno`
     *   Darwin：号进 **x16**、实参 x0-x5、`svc #0x80`，失败**置进位标志**、x0 里是
     *           **正的** errno（`open` 失败回 2 长得跟 fd 2 一模一样）
     *
     * op 的约定只有一条「回负数就是 -errno」（见 `mir/ir.js`），所以 Darwin 这一支
     * 多一条 `cneg x0, x0, cs`：进位置了就取负。少了它，`open("/nope")` 会被当成
     * 一个能用的 fd —— 这正是「同一条 op、约定不变、摆法归后端」该由后端补的那一格。
     *
     * `flush()` 照 `CCALL` 那一条发在前头：池里那五个（x11-x15）内核不动，但前端手上
     * 攥着的值得先落回帧里，`loadRef` 才取得到。号最后摆：Linux 那边 x8 就是 `RES`，
     * 摆实参那几步都可能拿它当落点。 */
    if (op === OP.SYSCALL) {
      const sysArgs = f.argsOf(f.b[i]);
      if (sysArgs.length > 6) arm64Nyi(`${sysArgs.length} 个实参的 SYSCALL`);
      const darwin = this.mod.os === 'osx';
      this.flush();
      let sysK = 0;
      for (const ar of sysArgs) {
        this.loadRef(sysK, ar);
        sysK++;
      }
      this.loadRef(darwin ? 16 : RES, f.a[i]);
      buf.emit(svcArm64(darwin ? 0x80 : 0));
      if (darwin) buf.emit(cneg(1, 0, 0, COND.cs));
      return this.def(i, 0);
    }
    /* `SYSCALL2`（第一百四十片第六格）：与上面那一条只差收尾两步 —— 池的**第一格是
     * 「第二个返回值写到哪儿」的地址**，实参从第二格起。
     *
     * 次序要紧：`svc` 之后先把 x1 存出去，**再**折进位（`cneg` 只动 x0，所以反过来
     * 也行，但先存 x1 少一处要推理的地方）。存地址用 TMP0（x9）—— 它不在实参那八个
     * 里，内核也不动它，所以 `svc` 之后再取都来得及。 */
    if (op === OP.SYSCALL2) {
      const all = f.argsOf(f.b[i]);
      if (all.length < 1) arm64Nyi('SYSCALL2 的池是空的（第一格该是第二个返回值的地址）');
      if (all.length - 1 > 6) arm64Nyi(`${all.length - 1} 个实参的 SYSCALL2`);
      const darwin2 = this.mod.os === 'osx';
      this.flush();
      let k2 = 0;
      for (const ar of all.slice(1)) {
        this.loadRef(k2, ar);
        k2++;
      }
      this.loadRef(darwin2 ? 16 : RES, f.a[i]);
      buf.emit(svcArm64(darwin2 ? 0x80 : 0));
      this.loadRef(TMP0, all[0]);
      buf.emit(strU(3, 1, TMP0, 0));
      if (darwin2) buf.emit(cneg(1, 0, 0, COND.cs));
      return this.def(i, 0);
    }
    /* `SETJMP`/`LONGJMP`（第一百四十片第三格，第七格实现的）。
     *
     * 与 x86_64 那一对同一个语义（`mir/ir.js` 那一段），存的东西按 AAPCS64 换一套：
     * 被调用者保存的是 **x19-x28 与 d8-d15**（不是那边的 rbx/r12-r15），而且返回地址
     * 在这条腿上也占一格 —— 序言一律 `stp x29, x30, [sp, #-16]!` + `mov x29, sp`，
     * 所以调用者的三样都在 x29 上量得出来。
     *
     * 布局（一共 168 字节，而 `jmp_buf` 是 192 —— 见 `arm64-osx/include/setjmp.h`）：
     *   +0   x19 … +72 x28（十格）
     *   +80  d8  … +136 d15（八格）
     *   +144 调用者的 x29   = [x29]
     *   +152 调用者在 bl 之后的 sp = x29 + 16
     *   +160 返回地址       = [x29, #8]
     *
     * x28 那一格不是凑数：它就是 `FB`（会动栈顶的函数按它寻址），跳回去的那个函数
     * 可能正靠着它 —— 少存这一个，`longjmp` 回到一个有变长数组的函数里就读错地方。
     */
    if (op === OP.SETJMP) {
      this.flush();
      this.loadRef(TMP0, f.a[i]);
      let jo = 0;
      for (let r = 19; r <= 28; r++) {
        buf.emit(strU(3, r, TMP0, jo));
        jo += 8;
      }
      for (let v = 8; v <= 15; v++) {
        buf.emit(strFpU(3, v, TMP0, jo));
        jo += 8;
      }
      buf.emit(ldrU(3, TMP1, 29, 0), strU(3, TMP1, TMP0, 144));      /* 调用者的 x29 */
      buf.emit(addImm(1, TMP1, 29, 16), strU(3, TMP1, TMP0, 152));   /* 调用者的 sp */
      buf.emit(ldrU(3, TMP1, 29, 8), strU(3, TMP1, TMP0, 160));      /* 返回地址 */
      this.movImm(RES, 0n);
      return this.def(i, RES);
    }
    /* `LONGJMP`：反过来装一遍，最后一条 `br x10`。
     *
     * 次序要紧，两处：
     *   1. 值先算好（0 换成 1，C11 7.13.2.1 第 2 段）—— 那一步要读栈上的值，得趁
     *      x19-x28 还没被覆盖、`sp` 还没动的时候做完。
     *   2. 落点、目标的 x29、目标的 sp **三条读完了才 `mov sp`** —— 反过来的话最后
     *      那条 `ldr` 已经踩在别人的栈上了（x86_64 那边同一条纪律）。
     * 目标 sp 借 x30 当草稿：这一条一去不回，lr 没有人再要了。
     *
     * 值放 **x0，不是 `RES`（x8）**：落点是调用者那条 `bl setjmp` 的下一条，它按 ABI
     * 从 x0 取返回值。x86_64 上这两个角色是同一个寄存器（rax），照抄那边就会写到 x8 上 ——
     * 量到过：`setjmp` 回 47923552（一个地址），而控制流是对的，最难查的那一种。 */
    if (op === OP.LONGJMP) {
      this.flush();
      this.loadRef(TMP1, f.b[i]);
      buf.emit(cmpImm(1, TMP1, 0), csinc(1, 0, TMP1, 31, COND.ne));
      this.loadRef(TMP0, f.a[i]);
      let ro = 0;
      for (let r = 19; r <= 28; r++) {
        buf.emit(ldrU(3, r, TMP0, ro));
        ro += 8;
      }
      for (let v = 8; v <= 15; v++) {
        buf.emit(ldrFpU(3, v, TMP0, ro));
        ro += 8;
      }
      buf.emit(ldrU(3, TMP1, TMP0, 160));      /* 落点 */
      buf.emit(ldrU(3, 30, TMP0, 152));        /* 目标的 sp（借 lr 当草稿） */
      buf.emit(ldrU(3, 29, TMP0, 144));        /* 目标的 x29 */
      buf.emit(movSp(1, SP, 30));
      buf.emit(br(TMP1));
      return;
    }
    /* `FPGET`（第一百四十片第二格，第五格改的）：帧指针自己 —— 一句 `mov x0, x29`。
     *
     * 上一版这儿明着报错，理由写的是「帧基址按这个函数动不动栈顶在 x28 与 sp 之间选」。
     * **那句话说的是 `FB`**（只有会动栈顶的函数才用那一格），与 x29 是两件事：这条腿的
     * 序言一律 `stp x29, x30, [sp, #-16]!` 加 `mov x29, sp`（见 `emitPrologue`），
     * x29 从来就是个真的帧指针。所以那次报错是报错了，这一格是改正。
     *
     * crt 靠它取 argc/argv：内核跳到 `_start` 时 sp 指着 argc，推完 fp/lr 那一对之后
     * `[x29 + 16]` 是 argc、`x29 + 24` 是 argv 的第一格 —— x86_64 那边是 +8 / +16，
     * 差的正是 lr 在这条腿上也占一格。 */
    if (op === OP.FPGET) {
      buf.emit(movReg(1, RES, 29));
      return this.def(i, RES);
    }
    /* 一个函数的**地址**（第二十七片）：与 `GADDR` 同一对指令，只是符号在 `__TEXT` 里。 */
    if (op === OP.FADDR) {
      const d = this.dest(i);
      this.symAddr(d, this.funcSym(f.aux[i]));
      return this.def(i, d);
    }

    /* ---- 槽位。**涂过色的槽**（`regalloc.js` 的 `slotIntervals`）权威副本就是那个
     * 寄存器，栈位从头到尾没人碰 —— 于是一条 `ldr`/`str` 换成一条 `mov`/`fmov`，
     * 而循环携带的局部变量（`i`、`t`…）不再每轮走一趟内存。 */
    if (op === OP.LOAD) {
      const no = f.aux[i];
      const fs = this.slotStickyF(no);
      if (fs >= 0) return this.fMove(i, fs, this.slotDbl(no));
      const sk = this.slotSticky(no);
      if (sk >= 0) return this.def(i, sk);
      const d = this.dest(i);
      this.frameLoad(d, this.slotOff(no));
      return this.def(i, d);
    }
    if (op === OP.STORE) {
      const no = f.aux[i];
      const fs = this.slotStickyF(no);
      if (fs >= 0) {
        const dbl = this.slotDbl(no);
        const x = this.fRefReg(f.a[i], FTMP0, dbl);
        if (x !== fs) buf.emit(fmovFp(dbl, fs, x));
        return;
      }
      const sk = this.slotSticky(no);
      if (sk >= 0) {
        const v = this.refReg(f.a[i], sk);
        if (v !== sk) buf.emit(movReg(1, sk, v));
        return;
      }
      const v = this.refReg(f.a[i], RES);
      this.frameStore(v, this.slotOff(no));
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
      if (hi > 4095) arm64Nyi(`帧偏移 ${off}（两条 add 也装不下）`);
      const d = this.dest(i);
      if (hi === 0) {
        buf.emit(addImm(1, d, this.base, lo));
      } else {
        buf.emit(addImm(1, d, this.base, hi, 1));
        if (lo > 0) buf.emit(addImm(1, d, d, lo));
      }
      return this.def(i, d);
    }

    /* ---- 模块级变量（第九刀第九片）。**靠符号寻址**：`adrp` 取页、`add` 取页内偏移。
     * 这一对是 arm64 上取任何一个全局地址的标准两条，两格都欠链接器一笔重定位
     * （`ARM64_RELOC_PAGE21` + `PAGEOFF12`）—— 第九刀第一片对账时被 llvm 挡回来的
     * 那个「adrp 的页号填不出来」，现在从写出去的那一头解释清楚了。 */
    if (op === OP.GLOAD) {
      this.globalAddr(TMP0, f.aux[i]);
      const d = this.dest(i);
      GLOAD_EMIT[arm64WidthKey(t)](buf, d, TMP0);
      return this.def(i, d);
    }
    if (op === OP.GSTORE) {
      const v = this.refReg(f.a[i], RES);
      this.globalAddr(TMP0, f.aux[i]);
      buf.emit(strU(STORE_SIZE[arm64WidthKey(f.t[i])], v, TMP0, 0));
      return;
    }
    /* 全局的**地址**（第二十一片）：`GLOAD` 里那两条的前半截，只是不接 `ldr`。
     * C 的全局量都从这儿走 —— 取地址、按成员写、按下标写，后头接 `MLOAD`/`MSTORE`。 */
    if (op === OP.GADDR) {
      const d = this.dest(i);
      this.globalAddr(d, f.aux[i]);
      return this.def(i, d);
    }

    /* ---- 变参的定义那一侧（第二十四片）。苹果的 arm64 上 `va_list` 就是一个 `char *`：
     * 变参一律在栈上连着放，一格 8 字节。于是这两条都很短 ——
     * `va_start` 是「把入参区里第一个变参的地址写进 ap」，
     * `va_arg` 是「按 ap 读一格、把 ap 推到下一格」。
     * i32 按符号扩展读（规范形），浮点读的是位模式（栈位里躺的就是位模式）。 */
    if (op === OP.VASTART) {
      this.loadRef(TMP0, f.a[i]);
      buf.emit(addImm(1, TMP1, 29, this.vaBase), strU(3, TMP1, TMP0, 0));
      return;
    }
    if (op === OP.VAARG) {
      this.loadRef(TMP0, f.a[i]);
      buf.emit(ldrU(3, TMP1, TMP0, 0));
      /* aux > 0：这一格里躺着一个 struct（第三十九片）。回的是**这一格的地址**，
       * 游标往前走 `align8(n)` —— 与写的那一侧（`argPlaces` 里的 `ARGMEM`）同一条规则。
       * 内容一个字节都不动：拷不拷由前端那边的赋值决定。
       *
       * **B.3 那一档例外**（第一百五十四片量出来的一个真错）：非 HFA 且 >16 字节的聚合，
       * 变参区里躺着的不是内容，是**一个指针**（指向调用方现做的那份拷贝）——
       * 写的那一侧本来就是这么摆的（`pcsPlaces` 的 `ptr` 那一支），读的这一侧却一直按
       * 「内容摊在格子里」算，于是 24 字节的 struct 过一趟 `va_arg` 读到的是垃圾，
       * 而且每趟不同（读的是拷贝那块之后的栈）。tcc 的 `gen_va_arg` 是同一条：
       * `n = size > 16 ? 8 : align8(size)`，再补一条 `ldr x(r1),[x(r1)]`
       * （`arm64-gen.c:1464` 与 `:1492`）。 */
      if (f.aux[i] !== 0) {
        const mem = memInfoOf(f.aux[i], false);
        const n = mem.size;
        const indirect = mem.hfa === null && n > 16;
        const step = indirect ? 8 : n + (n % 8 === 0 ? 0 : 8 - (n % 8));
        if (step > 4095) return arm64Nyi(`va_arg 取 ${n} 字节的 struct（一条 add 的立即数装不下）`);
        /* 值 = 这一格的地址；间接那一档要再读一层（那格里装的是指针）。
           两条都在动游标之前发 —— TMP1 就是游标。 */
        buf.emit(movReg(1, RES, TMP1));
        if (indirect) buf.emit(ldrU(3, RES, TMP1, 0));
        buf.emit(addImm(1, TMP1, TMP1, step), strU(3, TMP1, TMP0, 0));
        return this.def(i, RES);
      }
      /* 偏移那一格**必须显式给 0**（第一百四十片第五格找出来的一个真错）：
       * `MLOAD_EMIT` 那几条是 `(buf, dst, base, off)`，少给第四个就是 `undefined`，
       * 于是 `ldrU` 里那句「偏移是不是宽度的倍数」判成 `undefined % 8`，编译当场
       * 报「偏移 undefined 不是 8 的倍数」。
       *
       * 为什么一直没露头：这条腿上**从来没有人编过带 `va_arg` 的函数** ——
       * 我们生成的 C 只**调**变参（printf），不定义变参；tcc 那把尺子比的是解释器
       * 那条腿。这一格是自带 libc 的 `sscanf`/`strftime` 第一次踩上来。 */
      MLOAD_EMIT[typeKind(t) === T_I32 ? 'i32s' : arm64WidthKey(t)](buf, RES, TMP1, 0);
      buf.emit(addImm(1, TMP1, TMP1, 8), strU(3, TMP1, TMP0, 0));
      return this.def(i, RES);
    }
    /* 变参里的一整块内容（第三十九片）：这一条本身**不发访存** —— 内容什么时候拷、
     * 拷到哪儿，是调用那一头的事（`callArgs` 里按 `place.bytes` 拷）。这儿只把地址
     * 落到自己的栈位上，好让 `callArgs` 拿得到。 */
    if (op === OP.ARGMEM || op === OP.ARGSRET) {
      this.loadRef(RES, f.a[i]);
      return this.def(i, RES);
    }
    /* `va_copy`（第三十二片）：苹果 arm64 上 `va_list` 就是那个游标，所以「抄一份」
     * 就是抄那 8 字节 —— 两个 ap 从此各走各的。用 RES 当中转而不是 TMP1，是因为
     * `loadRef` 会再要一个寄存器；这一条不产值，RES 正好闲着。 */
    if (op === OP.VACOPY) {
      this.loadRef(TMP0, f.b[i]);
      buf.emit(ldrU(3, RES, TMP0, 0));
      this.loadRef(TMP0, f.a[i]);
      buf.emit(strU(3, RES, TMP0, 0));
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
      buf.emit(movSp(1, RES, SP));
      return this.def(i, RES);
    }
    if (op === OP.SPSET) {
      this.loadRef(TMP0, f.a[i]);
      buf.emit(movSp(1, SP, TMP0));
      return;
    }
    if (op === OP.SPALLOC) {
      this.loadRef(TMP0, f.a[i]);
      buf.emit(movSp(1, TMP1, SP), subReg(1, TMP1, TMP1, TMP0));
      buf.emit(movReg(1, RES, TMP1));
      const oa = this.outArgs;
      if (oa > 0) {
        const hi = Math.floor(oa / 4096);
        const lo = oa % 4096;
        if (hi > 4095) arm64Nyi(`出参区 ${oa} 字节（一次 sub 装不下）`);
        if (hi > 0) buf.emit(subImm(1, TMP1, TMP1, hi, 1));
        if (lo > 0) buf.emit(subImm(1, TMP1, TMP1, lo));
      }
      buf.emit(movSp(1, SP, TMP1));
      return this.def(i, RES);
    }

    /* ---- 存取（第九刀第七片）。地址就是真指针 —— native 上没有线性内存。 */
    if (op === OP.MLOAD) return this.mload(i);
    if (op === OP.MSTORE) return this.mstore(i);

    /* ---- 浮点。`t` 是浮点就整条交给 `float()`：算术、取负、比较、以及**结果是浮点的**
     * 那几种 CVT 都在那儿。结果是整数的 F2I 留在 `cvt()`（那条的 `t` 是整数）。 */
    if (isFloatType(t)) return this.float(i);

    /* ---- 单目。操作数用 `refReg`：值本来就在池寄存器里的话，这一条连 `ldr` 都不发。
     * 结果的落点用 `dest`：要得到池位子就直接算在那儿，`def` 那条 `mov` 也免了。 */
    if (op === OP.NEG) {
      const w = arm64WidthOf(t);
      const x = this.refReg(f.a[i], TMP0);
      const d = this.dest(i, x);
      buf.emit(neg(w === 64 ? 1 : 0, d, x));
      return this.def(i, d, w);
    }
    if (op === OP.BNOT) {
      const w = arm64WidthOf(t);
      const x = this.refReg(f.a[i], TMP0);
      const d = this.dest(i, x);
      buf.emit(mvn(w === 64 ? 1 : 0, d, x));
      return this.def(i, d, w);
    }
    if (op === OP.NOT) {
      const x = this.refReg(f.a[i], TMP0);
      const d = this.dest(i, x);
      buf.emit(eorImm(1, d, x, 1));
      return this.def(i, d);
    }

    /* ---- 二目。右操作数是常量时先试立即数那一形（`binImm`）—— 省掉造常量那条 `movz`。 */
    const bin = BIN[op];
    if (bin !== undefined) {
      const w = arm64WidthOf(t);
      const sf = w === 64 ? 1 : 0;
      const x = this.refReg(f.a[i], TMP0);
      const kb = this.intConst(f.b[i]);
      if (kb !== null && this.binImm(op, sf, i, x, kb, w)) return;
      const y = this.refReg(f.b[i], TMP1);
      const d = this.dest(i, x, y);
      bin(buf, sf, d, x, y);
      return this.def(i, d, w);
    }

    /* ---- 比较：`t` 是操作数的类型，产出永远是 0/1 的 bool。
     * 与常量比也走立即数形（`cmp x, #k` / 负数用 `cmn x, #-k`）。 */
    const cond = CMP[op];
    if (cond !== undefined) {
      const sf = arm64WidthOf(t) === 64 ? 1 : 0;
      const x = this.refReg(f.a[i], TMP0);
      const kb = this.intConst(f.b[i]);
      let y = -1;
      if (kb !== null && kb >= 0n && kb <= 4095n) {
        buf.emit(cmpImm(sf, x, Number(kb)));
      } else if (kb !== null && kb < 0n && kb >= -4095n) {
        buf.emit(cmnImm(sf, x, Number(-kb)));
      } else {
        y = this.refReg(f.b[i], TMP1);
        buf.emit(cmpReg(sf, x, y));
      }
      /* **紧跟着就是一条 IF/BRIF、而且只有它用这格结果** ⇒ 结果留在 NZCV 里，
         `cset` 与目标寄存器一条都不发（见 IF 那一支的账）。 */
      const nx = i + 1;
      if (this.uses[i] === 1 && nx < f.count()
        && (f.op[nx] === OP.IF || f.op[nx] === OP.BRIF)
        && !isConstRef(f.a[nx]) && f.at(f.a[nx]) === i) {
        this.flagCmp = i;
        this.flagCond = cond;
        return;
      }
      /* `dest` 一个字都不发，所以标志位在这中间不会被动 —— `cset` 紧接着读它。 */
      const d = this.dest(i, x, y);
      buf.emit(cset(1, d, cond));
      return this.def(i, d);
    }

    /* ---- 宽度转换 */
    if (op === OP.CVT) return this.cvt(i);

    return arm64Nyi(`MIR 指令 ${OP_NAMES[op]}`);
  }

  /**
   * **数学函数的内建**（Go 的 `ssagen/intrinsics.go:744` + `ARM64.rules:54`）：
   *     addF("math", "sqrt", → OpSqrt)      (Sqrt ...) => (FSQRTD ...)
   * go 的 `sqrt` 就是一条 `FSQRTD`，我们原来是一条 `bl` 到 libm —— 而它在
   * `intersect` 的内层循环上（每个球的求交都要一次），采样里 libm 的 sqrt 占 5%。
   * 除了省掉调用本身，还省掉 `flush()`（每条 `bl` 之前要把攥着的值写回栈位）。
   *
   * 认的判据（都是"判不准就照旧发调用"）：
   *   - 名字正好是这几个之一，**而且本模块里没有同名的定义**（`extern`/`decl`）——
   *     程序自己写一个 `double sqrt(double)` 是合法的，那时必须调它自己那个；
   *   - 一个实参、实参与结果都是 f64（`sqrtf` 那一族另算，这儿不认）。
   *
   * **已知的偏离**：C 在 `-fmath-errno` 那一档要求 `sqrt(-1)` 设 `errno = EDOM`，
   * 而 `fsqrt` 只给 NaN、不动 errno。clang 在 `-fno-math-errno` 下发的也是裸的
   * `fsqrt`，go 压根没有 errno 这回事 —— 我们跟 go 一致。
   */
  mathIntrinsic(i, t, name, g) {
    const enc = MATH1[name];
    if (enc === undefined) return false;
    /* 本模块里自己定义的同名函数不算内建（`g` 为 null = C ABI 的外部符号，一定是外部的）。 */
    if (g !== null && g.extern !== true && g.decl !== true) return false;
    if (typeKind(t) !== T_F64) return false;
    const f = this.f;
    const args = f.argsOf(f.b[i]);
    if (args.length !== 1) return false;
    if (typeKind(this.typeOfRef(args[0])) !== T_F64) return false;
    const x = this.fRefReg(args[0], FTMP0, true);
    const d = this.fDest(i);
    this.buf.emit(enc(true, d, x));
    this.fDef(i, d, true);
    return true;
  }

  /**
   * 发一条三源的乘加（`ARM64.rules:1824-1834`）。发成了回 undefined，
   * **草稿不够就回 `false`**（调用方退回去照常发乘法与加法）。
   *
   * 三个操作数：那条 MUL 的 x、y，与这条 ADD/SUB 的另一个操作数（加数 `a`）。
   * FP 草稿只有 FTMP0/FTMP1 两个，所以「要草稿的操作数」最多两个 ——
   * 涂过色的（`fstickyRef >= 0`）不占草稿。
   */
  fma(i, dbl) {
    const f = this.f;
    const m = i - 1;
    const mref = REF_BIAS + m;
    const aref = f.a[i] === mref ? f.b[i] : f.a[i];
    const refs = [f.a[m], f.b[m], aref];
    let need = 0;
    for (const r of refs) if (this.fstickyRef(r) < 0) need++;
    if (need > 2) return false;
    const tmps = [FTMP0, FTMP1];
    let ti = 0;
    const get = (r) => {
      const sk = this.fstickyRef(r);
      if (sk >= 0) return sk;
      return this.fRefReg(r, tmps[ti++], dbl);
    };
    const x = get(f.a[m]);
    const y = get(f.b[m]);
    const a = get(aref);
    const d = this.fDest(i);
    /* `SUB` 的两种次序要分开：`a - x*y` 是 FMSUB，`x*y - a` 是 FNMSUB。 */
    if (f.op[i] === OP.ADD) this.buf.emit(fmadd(dbl, d, x, y, a));
    else if (f.a[i] === mref) this.buf.emit(fnmsub(dbl, d, x, y, a));
    else this.buf.emit(fmsub(dbl, d, x, y, a));
    return this.fDef(i, d, dbl);
  }

  /**
   * `t` 是浮点的那些指令。
   *
   * 两条路：
   *   - 值住在 FP 寄存器里的（`regHintF` 涂过色，见 `STICKY_F`）—— 操作数直接读那个
   *     d 寄存器、结果直接算进它自己的 d 寄存器，**一条 `fmov` 一次访存都不发**；
   *   - 没涂上色的照旧：值躺在 8 字节栈位里（躺的是**位模式**），进 FP 一条 `fmov`、
   *     出来再一条。
   */
  float(i) {
    const f = this.f;
    const buf = this.buf;
    const op = f.op[i];
    const dbl = typeKind(f.t[i]) === T_F64;
    if (op === OP.CVT) return this.cvtToFloat(i, dbl);
    /* 这条 MUL 被后一条 ADD/SUB 吃掉了（见构造里的 `fused`）：一个字都不发。
     * `pending` 要清 —— 它是 `dest` 留给"结果算进池寄存器"的约，这儿没结果。 */
    if (this.fused !== null && this.fused.has(i)) { this.pending = -1; return; }
    /* 乘加融合（`ARM64.rules:1824-1834`）：紧挨在前面那条 MUL 已经跳过了，这儿发三源的。 */
    if ((op === OP.ADD || op === OP.SUB) && this.fused !== null && this.fused.has(i - 1)) {
      const r = this.fma(i, dbl);
      if (r !== false) return r;
      /* 三个操作数要三个草稿、而 FP 草稿只有两个（FTMP0/FTMP1）⇒ 退回去照常发。
         那条 MUL 已经跳过了，所以这儿得**自己把乘法补上**。 */
      const m = i - 1;
      const mx = this.fRefReg(f.a[m], FTMP0, dbl);
      const my = this.fRefReg(f.b[m], FTMP1, dbl);
      const md = this.fDest(m);
      buf.emit(fmul(dbl, md, mx, my));
      this.fDef(m, md, dbl);
    }
    if (op === OP.NEG) {
      const x = this.fRefReg(f.a[i], FTMP0, dbl);
      const d = this.fDest(i);
      buf.emit(fneg(dbl, d, x));
      return this.fDef(i, d, dbl);
    }
    const fb = FBIN[op];
    const fc = ARM64_FCMP[op];
    if (fb === undefined && fc === undefined) return arm64Nyi(`浮点的 ${OP_NAMES[op]}`);
    /* 比较那一路 `f.t[i]` 存的就是**操作数**的类型（结果是 bool，见 `isCmp`），
     * 所以 `dbl` 对两路都成立 —— 从前那一版也是这么用的。 */
    const x = this.fRefReg(f.a[i], FTMP0, dbl);
    const y = this.fRefReg(f.b[i], FTMP1, dbl);
    if (fb !== undefined) {
      const d = this.fDest(i);
      fb(buf, dbl, d, x, y);
      return this.fDef(i, d, dbl);
    }
    /* 比较的结果是 bool（通用那一类）：**直接 cset 进它该待的寄存器**，
     * 省掉 `def` 里那条 `mov 粘住, RES`。操作数在 d 寄存器里，与 GP 的避让无关，
     * 所以 `dest` 的 a/b 传 -1。 */
    const dc = this.dest(i, -1, -1);
    buf.emit(fcmpArm64(dbl, x, y), cset(1, dc, fc));
    return this.def(i, dc);
  }

  /**
   * **这个 ref 的浮点值弄到哪个 d 寄存器里**：
   *   1. 涂过色的（`STICKY_F`）直接回它那一个 —— 一个字都不发；
   *   2. 住在栈位里的 double 一条 `ldr d, [base,#off]` 读进 `ftmp`（省掉那条 `fmov`）；
   *   3. 别的（常量、在 POOL 里攥着的、f32）照旧：位模式进草稿、`fmov` 进 `ftmp`。
   *
   * 为什么第 2 条只认 f64：f32 的栈位是按 8 字节写的（高 4 字节是零），
   * 用 `str s` 回写只动低 4 字节会留下脏的高位，而别处有按 8 字节读同一格的路。
   * f32 的量太小，不值得为它把「一个值一个 8 字节栈位」那条不变式改了。
   */
  fRefReg(ref, ftmp, dbl) {
    const fsk = this.fstickyRef(ref);
    if (fsk >= 0) return fsk;
    /* **浮点常量落在 `fmov` 的 8 位立即数里 ⇒ 一条指令**（原先是 `mov` + 一到三条 `movk`
       + `fmov d,x` 三四条，而且在循环里每轮重发）。`1.0`/`2.0`/`0.5`/`3.0` 这些都在。
       只走 f64：f32 常量的文本按 f32 定过，而 `VFPExpandImm` 两种精度给的是同一个数值，
       本来也能收 —— 但 f32 在这条腿上量不到，不给它开没验过的路。 */
    if (dbl) {
      const cv = this.realConst(ref);
      if (cv !== null) {
        const im = fmovImm8Of(cv);
        if (im >= 0) { this.buf.emit(fmovImm(true, ftmp, im)); return ftmp; }
      }
    }
    const gp = ftmp === FTMP1 ? TMP1 : TMP0;
    if (dbl && ref !== REF_NONE && !isConstRef(ref)) {
      const vi = this.f.at(ref);
      /* `gfAt` 那一路的栈位从头到尾没人写过（见 `gfAt`）—— 从那儿读是读垃圾。
       * 按类型分流本来就到不了这儿（寄放的只有整数值），这一条是钉住那条不变式。 */
      if (this.stickyAt(vi) < 0 && this.valReg[vi] < 0 && this.gfAt(vi) < 0
          && this.frameLoadF(ftmp, this.valOff(vi))) {
        return ftmp;
      }
    }
    /* 值住在某个通用寄存器里（粘住的或 POOL 里攥着的）⇒ **直接从那一个 `fmov` 过去**。
     * 从前走 `loadRef` 是先 `mov 草稿, 那个寄存器`、再 `fmov d, 草稿` —— 中间那条纯废，
     * 而 `fmov` 的整数那一侧收任何通用寄存器。
     * 量出来的：`radiance` 1780 条指令里 `mov` 有 413 条，这一族是大头
     * （涂色覆盖率上到 99.4% 之后，几乎每个浮点操作数都是"住在通用寄存器里"）。 */
    const x = this.refReg(ref, gp);
    this.toFp(ftmp, x, dbl);
    return ftmp;
  }

  /** 这条浮点指令的结果**直接算进哪个 d 寄存器**：涂过色的就它自己那一个，否则 `FRES`。 */
  fDest(i) {
    const fsk = this.fstickyAt(i);
    return fsk >= 0 ? fsk : FRES;
  }

  /**
   * 交出一条浮点指令的结果。三条路，与 `fRefReg` 对称：
   *   1. 算在它自己的 d 寄存器里的 —— 一个字都不用发；
   *   2. 没人要的（`uses` 为 0）—— 也不用发；
   *   3. 是个 double 且要落栈位的 —— 一条 `str d, [base,#off]`（省掉那条 `fmov`）。
   *      这一路**绕过 POOL**：值的家就是栈位，往后 `loadRef` 从那儿读位模式，对得上。
   *   4. 剩下的（f32、偏移太大）照旧 `fmov` 出位模式走 `def`。
   */
  fDef(i, freg, dbl) {
    if (this.fstickyAt(i) >= 0) return;          // 已经在家了
    if (this.uses[i] === 0) { this.pending = -1; return; }
    if (dbl && this.frameStoreF(freg, this.valOff(i))) {
      this.pending = -1;
      return;
    }
    this.fromFp(RES, freg, dbl);
    return this.def(i, RES);
  }

  /**
   * 交出一个**已经躺在别处 d 寄存器里**的浮点值（提升过的槽的 `LOAD` 走这条）。
   * 与 `fDef` 的差别只在第一条：`fDef` 假定值就是算在自己那个 d 寄存器里的、一个字都
   * 不发，这儿得真搬一次。
   */
  fMove(i, freg, dbl) {
    const fsk = this.fstickyAt(i);
    if (fsk >= 0) {
      if (fsk !== freg) this.buf.emit(fmovFp(dbl, fsk, freg));
      this.pending = -1;
      return;
    }
    return this.fDef(i, freg, dbl);
  }

  /** 结果是浮点的那几种 CVT。 */
  cvtToFloat(i, dbl) {
    const f = this.f;
    const buf = this.buf;
    const mode = f.aux[i];
    const src = this.typeOfRef(f.a[i]);
    /* 位重解释在这一层**一个字都不必发**：栈位里躺的本来就是位模式，`def` 收任何
     * 通用寄存器。从前那条路是 `loadRef(TMP0) + mov RES, TMP0 + def`，
     * 前两条全是白绕 —— 值多半已经住在某个粘住的寄存器里（`refReg` 直接回它），
     * 而 `def` 自己会把它 `fmov` 进结果的 d 寄存器。
     * 量出来的：`intersect` 的循环体里这一族出现六次，每次省两条。 */
    if (mode === CVT_BITCAST) {
      return this.def(i, this.refReg(f.a[i], TMP0));
    }
    this.loadRef(TMP0, f.a[i]);
    if (mode === CVT_I2F || mode === CVT_U2F) {
      const sf = intBits(src) === 64 ? 1 : 0;
      const d = this.fDest(i);
      this.buf.emit(mode === CVT_I2F ? scvtf(sf, dbl, d, TMP0) : ucvtf(sf, dbl, d, TMP0));
      return this.fDef(i, d, dbl);
    }
    if (mode === CVT_FCVT) {
      /* 源的宽度与目标的宽度一定相反（同宽的 fcvt 没有意义，MIR 也不该发）。 */
      const srcDbl = typeKind(src) === T_F64;
      if (srcDbl === dbl) return arm64Nyi('同宽的 CVT_FCVT');
      const d = this.fDest(i);
      this.toFp(FTMP0, TMP0, srcDbl);
      buf.emit(dbl ? fcvtSD(d, FTMP0) : fcvtDS(d, FTMP0));
      return this.fDef(i, d, dbl);
    }
    return arm64Nyi(`结果是浮点的 CVT 模式 ${mode}`);
  }

  cvt(i) {
    const f = this.f;
    const buf = this.buf;
    const mode = f.aux[i];
    const x = this.refReg(f.a[i], TMP0);
    /* 浮点 -> 整数（向零取整，C 的强制转换就是这一种）。`t` 是整数所以落在这儿。 */
    if (mode === CVT_F2I || mode === CVT_F2U) {
      const srcDbl = typeKind(this.typeOfRef(f.a[i])) === T_F64;
      const w = arm64WidthOf(f.t[i]);
      this.toFp(FTMP0, x, srcDbl);
      const d = this.dest(i, x);
      /* 无符号那条是 `fcvtzu`（第九十五片）：`fcvtzs` 在越界处饱和到有符号上界，
       * 于是 `(unsigned long long)9223372036854775808.0` 会少一位。arm64 上两条指令
       * 只差一个位域，所以这一格只是挑一条。 */
      buf.emit(mode === CVT_F2U
        ? fcvtzu(w === 64 ? 1 : 0, srcDbl, d, FTMP0)
        : fcvtzs(w === 64 ? 1 : 0, srcDbl, d, FTMP0));
      return this.def(i, d, w);
    }
    const d = this.dest(i, x);
    /* 位重解释：栈位里躺的就是位模式，一条 mov。
     *
     * 这一条与下面的 `SEXT` 都是**空操作**，理应连 mov 都不必发 —— 记一笔「这个值就是
     * 那个值」、往后谁读它就去读源头即可。试过（`alias` 那一版，三十行）：整份 `.text`
     * 35331080 -> 35343832，**反而大了 12752 字节**。生成的 C 全是 i64 的 `omni_dyn`，
     * 这两种转换几乎不出现，省下的还不够抵那三十行自己编出来的代码。所以不留。 */
    if (mode === CVT_BITCAST) {
      buf.emit(movReg(1, d, x));
      return this.def(i, d);
    }
    /* i32 的规范形是**符号扩展后的 64 位**，所以：
     *  - SEXT（i32 -> i64）什么都不用做（值本来就是那个样子）；
     *  - ZEXT 要把高 32 位抹掉；
     *  - TRUNC（i64 -> i32）要重新按 32 位符号扩展一遍。 */
    if (mode === CVT_SEXT) buf.emit(movReg(1, d, x));
    else if (mode === CVT_ZEXT) buf.emit(andImm(1, d, x, 0xffffffffn));
    else if (mode === CVT_TRUNC) buf.emit(sxtw(d, x));
    /* `sxtb x8, w9` 一条就把 64 位都符号扩展好了 —— i32 与 i64 的规范形在这儿是同一个值，
     * 所以不按结果类型分 w/x 系（分了反而要给 i32 再补一条 `sxtw`）。 */
    else if (mode === CVT_SEXT8) buf.emit(sxtb(1, d, x));
    else if (mode === CVT_SEXT16) buf.emit(sxth(1, d, x));
    else return arm64Nyi(`CVT 模式 ${mode}`);
    return this.def(i, d);
  }

  /** 实参就位：整数一串（x0-x7）、浮点一串（v0-v7），**各自从 0 起数**（AAPCS）。 */
  /**
   * 把实参摆到位。回「返回值那一块」的那一格（`{place, ref}`，没有就 null）——
   * 调用之后 `callRet` 要按它把 x0/x1（或 v0-v3）里的值写进去。
   */
  callArgs(args, nfixed) {
    const p = argPlaces(this.mod, this.f, args, nfixed);
    let sret = null;
    let k = 0;
    for (const ar of args) {
      const place = p.at[k];
      k++;
      /* 返回值那一块（`ARGSRET`，第一百三十一片）：放到最后再摆 —— 它要占 x8，
       * 而 x8 正是这一层的草稿寄存器（`RES`），别的实参摆完之前不能占着。 */
      if (place.sret !== undefined) {
        sret = { place, ref: ar };
        continue;
      }
      /* >16 字节的聚合（B.3）：ABI 传的是指针，而 C 要的是**一份拷贝**（形参是实参的
       * 一份可改的拷贝，C11 6.9.1 第 10 段）—— 所以先在出参区里拷一份，传那一份的地址。
       * tcc 也是这么做的（`gfunc_call` 里的 `a1[i]`，同一块 `sub sp` 里划出来的）。 */
      if (place.ptr === true) {
        this.blockCopy(ar, place.copyOff, place.bytes);
        if (place.x !== undefined) this.addOff(place.x, SP, place.copyOff);
        else {
          this.addOff(TMP1, SP, place.copyOff);
          this.buf.emit(strU(3, TMP1, SP, place.off));
        }
        continue;
      }
      /* 出参区里的一整块（C.13/C.15 那两条与变参那一段）。 */
      if (place.off !== undefined) {
        if (place.bytes !== undefined) {
          this.blockCopy(ar, place.off, place.bytes);
          continue;
        }
        this.loadRef(TMP0, ar);
        this.buf.emit(strU(3, TMP0, SP, place.off));
        continue;
      }
      /* HFA 进连着的几个 v 寄存器（C.2）：一个成员一格。位模式先进整数草稿再 `fmov`
       * 过去 —— 这一层本来就是这么搬浮点的（见 `toFp`），不用新的编码。 */
      if (place.hfa !== undefined) {
        this.loadRef(TMP0, ar);
        for (let j = 0; j < place.hfa.n; j++) {
          const dbl = place.hfa.size === 8;
          this.buf.emit(ldrU(dbl ? 3 : 2, TMP1, TMP0, j * place.hfa.size));
          this.toFp(place.v + j, TMP1, dbl);
        }
        continue;
      }
      if (place.v !== undefined) {
        this.loadRef(TMP0, ar);
        this.toFp(place.v, TMP0, typeKind(this.typeOfRef(ar)) === T_F64);
        continue;
      }
      /* 聚合摊进几个整数寄存器（C.10）：整格整格地取。奇数宽度的先落一份补齐的拷贝
       * （`argPlaces` 划的那一块），从那儿取就不会读到 struct 之外。 */
      if (place.xn !== undefined) {
        if (place.copyOff >= 0) {
          this.blockCopy(ar, place.copyOff, place.bytes);
          this.addOff(TMP0, SP, place.copyOff);
        } else this.loadRef(TMP0, ar);
        for (let j = 0; j < place.xn; j++) {
          this.buf.emit(ldrU(3, place.x + j, TMP0, j * 8));
        }
        continue;
      }
      this.loadRef(place.x, ar);
    }
    if (sret !== null && sret.place.x8 === true) this.loadRef(8, sret.ref);
    return sret;
  }

  /**
   * 把 `ar` 指着的 `bytes` 个字节拷到出参区的 `off` 处。
   *
   * 按 8/4/2/1 递降着拷，**不拷到格子的末尾**（格子补齐到 8，源没有那么长）——
   * 多读的那几个字节大多无害，可源要是正好贴着一页的末尾就会踩空。
   */
  blockCopy(ar, off, bytes) {
    this.loadRef(TMP0, ar);
    let at = 0;
    for (const [w, sz] of [[8, 3], [4, 2], [2, 1], [1, 0]]) {
      while (bytes - at >= w) {
        this.buf.emit(ldrU(sz, TMP1, TMP0, at), strU(sz, TMP1, SP, off + at));
        at += w;
      }
    }
  }

  /** 返回值落回栈位。`sret` 是 `callArgs` 回的那一格（没有就 null）。 */
  callRet(i, t, sret) {
    /* 返回的是一整块 struct（第一百三十一片）：这条指令的"值"是**那一块的地址** ——
     * 前端拿它当 struct 的左值（`sMem(ret, r, 0)`）。>16 字节那条路上被调方已经按我们
     * 进去前放进 x8 的地址写好了；≤16 字节那条要调用方自己把 x0/x1（或 v0-v3）写进去，
     * 与 tcc 的 `gfunc_call` 收尾那一段（`arm64-gen.c:1197`）是同一件事。
     *
     * 那一块前端补齐到了至少 16 字节（见 `callArgs` 里那一段），所以这儿满 8 字节地写，
     * 不用按 5/6/7 那几种宽度分岔（tcc 也是直接 `stp x0,x1,[x8]`）。 */
    if (sret !== undefined && sret !== null) {
      const m = sret.place.sret;
      this.loadRef(TMP0, sret.ref);
      if (sret.place.x8 !== true) {
        if (m.hfa !== null) {
          for (let j = 0; j < m.hfa.n; j++) {
            const dbl = m.hfa.size === 8;
            this.fromFp(TMP1, j, dbl);
            this.buf.emit(strU(dbl ? 3 : 2, TMP1, TMP0, j * m.hfa.size));
          }
        } else {
          this.buf.emit(strU(3, 0, TMP0, 0));
          if (m.size > 8) this.buf.emit(strU(3, 1, TMP0, 8));
        }
      }
      return this.def(i, TMP0);
    }
    if (typeKind(t) === T_VOID) return;
    if (isFloatType(t)) {
      /* 返回值住 FP 寄存器（`STICKY_F`）⇒ **一条 `fmov d,d`** 直接从 d0 搬过去。
       * 从前走 `fromFp(RES, 0)` 再让 `def` 的 FP 钩子搬回去是**两条** `fmov`
       * （d0 -> x8 -> d粘住），中间白绕一趟通用寄存器。
       * `radiance` 里 41 条 `bl`，返回 double 的是大头。 */
      const fsk = this.fstickyAt(i);
      if (fsk >= 0) {
        if (fsk !== 0) this.buf.emit(fmovFp(typeKind(t) === T_F64, fsk, 0));
        this.pending = -1;
        return;
      }
      this.fromFp(RES, 0, typeKind(t) === T_F64);
      return this.def(i, RES);
    }
    /* i32 的返回值要按规范形符号扩展：AAPCS 只保证 w0 有值，x0 的高 32 位不算数。 */
    return this.def(i, 0, arm64WidthOf(t));
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

  /** 串常量的符号名。名字是 `genArm64Module` 分的 —— 单个函数编不出数据段，所以那儿明着报。 */
  strSym(ref) {
    const sym = this.strSyms === null ? undefined : this.strSyms.get(ref);
    if (sym === undefined) {
      throw new OmniError('arm64: 字符串常量的字节要落在数据段里，得走 genArm64Module');
    }
    return sym;
  }

  /**
   * 一个符号的**地址**算进 `reg`：`adrp Rd, sym@GOTPAGE` + `ldr Rd, [Rd, sym@GOTPAGEOFF]`。
   *
   * **arm64 上取任何符号的地址都过 GOT** —— 量过尺子（ADR-0017 的「量：arm64 上取符号
   * 地址一律过 GOT」那一节）：数据、函数、自家文件里的 `static`，一律是 `311`/`312`
   * 那一对，addend 一律 0。只有**直接调用**留着 `bl`（`283`）。
   *
   * 从前这儿分两条路：自家的走 `adrp` + `add`（`275`/`277`）、外部的才过 GOT
   * （第三十一片上 `__stdoutp` 那次）。分岔本身是个假设 —— 尺子那边没有这个分岔。
   *
   * 两头都验过收得下「GOT 指向局部符号」这件事：
   *
   *   - 我们自己的链接器：`elf_exe.js`/`macho_exe.js` 里 `311`/`312` 是 `ALWAYS_GOTPLT`，
   *     局部符号那一支走 `R_RELATIVE` + 加数（`fill_local_got_entries`）
   *   - ld64（`native` 那条腿）：量过一份手写 `.s`，局部符号的 `@GOTPAGE` 真落成
   *     `ARM64_RELOC_GOT_LOAD_PAGE21`（没被汇编器悄悄降级），链完跑得动
   */
  symAddr(reg, sym) {
    this.buf.adrpSymGot(reg, sym);
    this.buf.ldrSymGot(reg, reg, sym);
  }

  /** 一个模块级变量的地址算进 `reg`。自家的与外部的**同一条路** —— 见 `symAddr`。 */
  globalAddr(reg, no) {
    return this.symAddr(reg, this.globalSym(no));
  }

  /**
   * 真址 = 地址本身 + 静态偏移，**回哪个寄存器装着它**。地址就是真指针 —— 见文件上头那段。
   *
   * 偏移是 0（最常见的一格：`*p`、数组下标已经算进地址里了）时不动它：地址本来在池
   * 寄存器里的话直接用那一个，连 `mov` 都不发。偏移不是 0 就得算，那就落到 `reg` 里 ——
   * 池寄存器是别人的值，不能往上写。
   */
  memAddr(reg, ref, off) {
    if (off === 0) return this.refReg(ref, reg);
    this.loadRef(reg, ref);
    if (off < 4096) {
      this.buf.emit(addImm(1, reg, reg, off));
      return reg;
    }
    /* 静态偏移大过一格立即数就先造出来 —— 用 TMP1 当中转（这两条路上它都还没被占）。 */
    this.movImm(TMP1, BigInt(off));
    this.buf.emit(addReg(1, reg, reg, TMP1));
    return reg;
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
    const ld = MLOAD_EMIT[kind];
    if (ld === undefined) return arm64Nyi(`MLOAD 的宽度 ${kind}`);
    /* 静态偏移能折进立即数就折（见 `foldOff`）：那样地址寄存器直接是操作数本身，
     * 连一条 `add` 都不发。折不进才走 `memAddr` 把真址算出来。 */
    const off = memOff(f.aux[i]);
    const fold = foldOff(off, MLOAD_SIZE[kind]);
    /**
     * **f64 且结果住 FP 寄存器**：一条 `ldr d, [p, #off]` 直接读进它的家。
     *
     * 这一条是指令级对账里 `fmov` 那 566 条的大头：从前这一路发的是
     *   `ldr x9, [x22, #8]` + `fmov d11, x9`
     * —— 一条真访存后面跟一条纯搬运。Go 那边同一件事是 `FLDPD`（还一次读两个）。
     * 只认 f64：f32 的栈位按 8 字节写、`str s` 只动低 4 字节（见 `fRefReg` 那一段）。
     */
    const fsk = this.fstickyAt(i);
    if (fsk >= 0 && kind === 'f64') {
      const p = fold ? this.refReg(f.a[i], TMP0) : this.memAddr(TMP0, f.a[i], off);
      this.buf.emit(ldrFpU(3, fsk, p, fold ? off : 0));
      this.pending = -1;
      return;
    }
    const p = fold ? this.refReg(f.a[i], TMP0) : this.memAddr(TMP0, f.a[i], off);
    const d = this.dest(i, p);
    ld(this.buf, d, p, fold ? off : 0);
    return this.def(i, d);
  }

  /** `MSTORE`。六种宽度只管「把低若干位拍进内存」，没有符号可言（与 wasm 同）。 */
  mstore(i) {
    const f = this.f;
    const kind = MSTORE_KINDS[memKindNo(f.aux[i])];
    const size = MSTORE_SIZE[kind];
    if (size === undefined) return arm64Nyi(`MSTORE 的宽度 ${kind}`);
    const off = memOff(f.aux[i]);
    const fold = foldOff(off, size);
    /* **f64 且值住 FP 寄存器**：一条 `str d, [p, #off]`，省掉那条 `fmov x, d`
     * （与 `mload` 那一段同一笔账）。 */
    const fv = kind === 'f64' ? this.fstickyRef(f.b[i]) : -1;
    if (fv >= 0) {
      const p = fold ? this.refReg(f.a[i], TMP0) : this.memAddr(TMP0, f.a[i], off);
      this.buf.emit(strFpU(3, fv, p, fold ? off : 0));
      return;
    }
    /* 先取值再算地址：`memAddr` 在偏移大的时候要借 TMP1，所以值落在 RES 上。
     * 值在池寄存器里的话 `refReg` 一个字都不发（从前这儿是 `ldr` + `mov` 两条）。 */
    const v = this.refReg(f.b[i], RES);
    const p = fold ? this.refReg(f.a[i], TMP0) : this.memAddr(TMP0, f.a[i], off);
    this.buf.emit(strU(size, v, p, fold ? off : 0));
  }

  /**
   * 把结果交出去。32 位的结果先按 i32 的规范形符号扩展。
   *
   * 落点有三种（见 `POOL`）：没人要的连交都不交；池里有空位的就 `mov` 进那一个，
   * 用它的指令直接读那个寄存器；池满了才写回栈位 —— 那是从前唯一的一条路。
   */
  def(i, reg, w) {
    /* 浮点那一套粘住的（见 `STICKY_F`）：结果的家是那个 d 寄存器，一条 `fmov` 搬进去。
     * **不进 POOL、不写栈位、不做符号扩展**（浮点没有 32 位规范形那回事）。
     * 这一条摆在最前面，于是「凡是产浮点值的指令」都不必各自认领 —— LOAD / MLOAD /
     * CALL 的返回值 / SELECT 一律走 `def`，都在这儿收口。 */
    const fsk = this.fstickyAt(i);
    if (fsk >= 0) {
      this.toFp(fsk, reg, typeKind(this.f.t[i]) !== T_F32);
      this.pending = -1;
      return;
    }
    if (w === 32) this.buf.emit(sxtw(reg, reg));
    /* 寄放进 FP 的整数值（见 `gfAt`）：一条 `fmov d,x` 把位模式搬进它的家。
     * **摆在符号扩展之后** —— 寄存器里躺的必须是 i32 的规范形，取出来的那一头
     * （`loadRef` 的 `fmov x,d`）不会再补一次。 */
    const gf = this.gfAt(i);
    if (gf >= 0) {
      this.toFp(gf, reg, true);
      this.pending = -1;
      return;
    }
    /* 粘住的那几个（见 `STICKY`）：结果要落在它那一个里。`dest` 已经直接算进去的话
     * 这儿一个字都不发；别处算好的（`RES` 那一路）就一条 `mov`。
     * **不进 POOL、不写栈位**：它从这儿一直住到最后一次使用，`flush` 也不碰它。 */
    const sk = this.stickyAt(i);
    if (sk >= 0) {
      if (reg !== sk) this.buf.emit(movReg(1, sk, reg));
      this.pending = -1;
      return;
    }
    const n = this.uses[i];
    const p = this.pending;
    this.pending = -1;
    if (n === 0) return;
    /* `dest` 早就把位置留好了、结果也已经算在那个寄存器里：认领一下就完，不发指令。 */
    if (p >= 0 && POOL[p] === reg) {
      this.cacheIdx[p] = i;
      this.cacheLeft[p] = n;
      this.valReg[i] = p;
      return;
    }
    const s = this.takeSlot();
    if (s >= 0) {
      this.cacheIdx[s] = i;
      this.cacheLeft[s] = n;
      this.valReg[i] = s;
      this.buf.emit(movReg(1, POOL[s], reg));
      return;
    }
    this.frameStore(reg, this.valOff(i));
  }
}

/* 二目运算表。`sf` 是 0/1（w/x 系）；32 位的结果由 `def` 统一符号扩展回规范形。
 * 无符号那三条（UDIV/UMOD/USHR）在 w 系上天然对：`udiv w` 只看低 32 位、
 * 结果零扩展，而随后的 `sxtw` 把它变回规范形。 */
const BIN = {};
BIN[OP.ADD] = (b, sf, d, x, y) => b.emit(addReg(sf, d, x, y));
BIN[OP.SUB] = (b, sf, d, x, y) => b.emit(subReg(sf, d, x, y));
BIN[OP.MUL] = (b, sf, d, x, y) => b.emit(mul(sf, d, x, y));
BIN[OP.DIV] = (b, sf, d, x, y) => b.emit(sdiv(sf, d, x, y));
BIN[OP.UDIV] = (b, sf, d, x, y) => b.emit(udiv(sf, d, x, y));
/* 取余没有单条指令：先除、再 `msub`（d = x - (x/y)*y）。 */
BIN[OP.MOD] = (b, sf, d, x, y) => b.emit(sdiv(sf, d, x, y), msub(sf, d, d, y, x));
BIN[OP.UMOD] = (b, sf, d, x, y) => b.emit(udiv(sf, d, x, y), msub(sf, d, d, y, x));
BIN[OP.SHL] = (b, sf, d, x, y) => b.emit(lslv(sf, d, x, y));
BIN[OP.SHR] = (b, sf, d, x, y) => b.emit(asrv(sf, d, x, y));
BIN[OP.USHR] = (b, sf, d, x, y) => b.emit(lsrv(sf, d, x, y));
BIN[OP.BAND] = (b, sf, d, x, y) => b.emit(andReg(sf, d, x, y));
BIN[OP.BOR] = (b, sf, d, x, y) => b.emit(orrReg(sf, d, x, y));
BIN[OP.BXOR] = (b, sf, d, x, y) => b.emit(eorReg(sf, d, x, y));

/* 比较 -> 条件码。`cs`/`cc` 就是手册里的 `hs`/`lo`（无符号的 >= 与 <）。 */
const CMP = {};
CMP[OP.EQ] = COND.eq;
CMP[OP.NE] = COND.ne;
CMP[OP.LT] = COND.lt;
CMP[OP.GE] = COND.ge;
CMP[OP.LE] = COND.le;
CMP[OP.GT] = COND.gt;
CMP[OP.ULT] = COND.cc;
CMP[OP.UGE] = COND.cs;
CMP[OP.ULE] = COND.ls;
CMP[OP.UGT] = COND.hi;

/* 浮点的二目。`dbl` 直接就是编码器要的那一位。 */
const FBIN = {};
FBIN[OP.ADD] = (b, dbl, d, x, y) => b.emit(fadd(dbl, d, x, y));
FBIN[OP.SUB] = (b, dbl, d, x, y) => b.emit(fsub(dbl, d, x, y));
FBIN[OP.MUL] = (b, dbl, d, x, y) => b.emit(fmul(dbl, d, x, y));
FBIN[OP.DIV] = (b, dbl, d, x, y) => b.emit(fdiv(dbl, d, x, y));

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
const ARM64_FCMP = {};
ARM64_FCMP[OP.EQ] = COND.eq;
ARM64_FCMP[OP.NE] = COND.ne;
ARM64_FCMP[OP.LT] = COND.mi;
ARM64_FCMP[OP.LE] = COND.ls;
ARM64_FCMP[OP.GT] = COND.gt;
ARM64_FCMP[OP.GE] = COND.ge;

/* 线性内存的九种读。`ldrs*` 一律扩到 64 位（i32 的规范形就是那个样子），
 * 零扩展的三种与两种浮点都走整数加载 —— 栈位里躺的是位模式。 */
const MLOAD_EMIT = {
  i8s: (b, d, p, o) => b.emit(ldrsU(0, d, p, o)),
  i8u: (b, d, p, o) => b.emit(ldrU(0, d, p, o)),
  i16s: (b, d, p, o) => b.emit(ldrsU(1, d, p, o)),
  i16u: (b, d, p, o) => b.emit(ldrU(1, d, p, o)),
  i32s: (b, d, p, o) => b.emit(ldrsU(2, d, p, o)),
  i32u: (b, d, p, o) => b.emit(ldrU(2, d, p, o)),
  i64: (b, d, p, o) => b.emit(ldrU(3, d, p, o)),
  f32: (b, d, p, o) => b.emit(ldrU(2, d, p, o)),
  f64: (b, d, p, o) => b.emit(ldrU(3, d, p, o)),
};

/* 九种读各自的宽度对数 —— 折静态偏移进立即数那一格要按它判缩放（见 `foldOff`）。 */
const MLOAD_SIZE = { i8s: 0, i8u: 0, i16s: 1, i16u: 1, i32s: 2, i32u: 2, i64: 3, f32: 2, f64: 3 };

/**
 * 这个静态偏移**折得进** `ldr`/`str` 的立即数那一格吗（第一百四十四片）。
 *
 * 那一格是**按宽度缩放**的 12 位无符号：`ldr x, [x9, #16]` 里躺的是 2。所以偏移得是
 * 宽度的整数倍、商还得进得了 12 位。折得进就省掉一条 `add` —— `p->field` 在生成的 C
 * 里到处都是，量出来这一条占了整份 `.text` 的 1.27M 条 `add` 里的大头。
 *
 * 折不进（`struct { char c; int i; }` 里 `i` 在偏移 1 那种、或者偏移大过 4095×宽度）
 * 就回 false，走 `memAddr` 那条老路先把地址算出来。
 */
function foldOff(off, size) {
  const w = 1 << size;
  return off >= 0 && off % w === 0 && off / w <= 4095;
}

/**
 * 这个常量**保准编得出**一条逻辑立即数吗（`and`/`orr`/`eor` 的那一格）。
 *
 * arm64 的逻辑立即数是「一段连着的 1，转过某个角度、按 2/4/8/16/32/64 位复制」——
 * `encode.js` 的 `bitmaskImm` 会把它算出来，但**编不了的时候它抛**，而这一层不接异常。
 * 所以这儿只认两种**一眼就成立**的形状：
 *   - 低位连着的一段 1（`v & (v+1) == 0`）：0x1、0x3、0xff、0xffff、0xffffffff……
 *   - 单独一位（`v & (v-1) == 0`）：1 << n。
 * 全 0 与全 1 编不了（手册里那两个位模式留给了别的指令），先挡掉。
 * 别的形状（0x0f0f0f0f 那种）也是合法立即数，但要判就得把 `bitmaskImm` 的判据抄一遍 ——
 * 抄两份就会有一天不一致，所以宁可少省几条。
 */
function maskImmOk(sf, k) {
  const width = sf === 1 ? 64 : 32;
  const v = BigInt.asUintN(width, k);
  if (v === 0n) return false;
  if (v === BigInt.asUintN(width, -1n)) return false;
  if ((v & (v + 1n)) === 0n) return true;
  if ((v & (v - 1n)) === 0n) return true;
  return false;
}

/* 六种写 -> `str` 的宽度对数。 */
const MSTORE_SIZE = { i8: 0, i16: 1, i32: 2, i64: 3, f32: 2, f64: 3 };

/** 类型 -> 一个宽度的名字。bool 与指针都按 64 位走。 */
function arm64WidthKey(t) {
  const k = typeKind(t);
  if (k === T_I32) return 'i32';
  if (k === T_F32) return 'f32';
  if (k === T_F64) return 'f64';
  if (k === T_I64 || k === T_BOOL) return 'i64';
  return arm64Nyi(`模块级变量的类型 ${k}`);
}

/* 模块级变量的读。i32 走 `ldrsw`（i32 的规范形是符号扩展过的 64 位）；
 * 两种浮点走整数加载 —— 栈位里躺的是位模式。 */
const GLOAD_EMIT = {
  i64: (b, d, p) => b.emit(ldrU(3, d, p, 0)),
  i32: (b, d, p) => b.emit(ldrsU(2, d, p, 0)),
  f64: (b, d, p) => b.emit(ldrU(3, d, p, 0)),
  f32: (b, d, p) => b.emit(ldrU(2, d, p, 0)),
};
const STORE_SIZE = { i64: 3, i32: 2, f64: 3, f32: 2 };

/** 一个 MIR 函数 -> 一段 arm64 机器码（`Arm64CodeBuf`，已回填）。不认 CALL —— 单个函数
 * 里没有别的函数的落点，要发调用得走 `genArm64Module`。 */
export function genArm64Func(mod, f) {
  const g = new FnGen(mod, f);
  g.gen();
  g.buf.finish();
  return g.buf;
}

/** 图省事的入口：直接要字节。 */
export function codeOfArm64(mod, f) {
  return genArm64Func(mod, f).bytes();
}

/**
 * 整个模块 -> 一段连着的机器码。
 *
 * 函数之间的调用走**标签**而不是符号：一个模块的函数全在同一个缓冲里，`bl` 的
 * ±128MB 够得着，于是这一层不欠链接器任何账（跨模块的符号才欠，见 `asm.js` 的
 * `blSym`）。`offsets[i]` 是第 i 个函数在这段字节里的起点。
 */
export function genArm64Module(mod) {
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
  /* 只读的那些摆进第三节（第一百二十二片，与 x64 那一份同一条）：`const` 的全局量
   * 在 tcc 那边落在 `.data.ro`。两段字节各自从 0 数偏移，符号与重定位按 `sect` 分。
   * 只读那一节的落点由 `planRodata` 一次排好（第一百二十五片）—— 里头 `const` 全局与
   * 串常量**按声明的次序交替**，所以这儿不能再一段接一段地推游标。 */
  const roPlan = planRodata(mod);
  const roBytes = new Array(roPlan.size).fill(0);
  const roRelocs = [];
  /* 可写那一节的落点也一样排（第一百三十一片）：从前是照 MIR 的全局号一块接一块推，
   * 而号是「第一次被提到」的次序 —— `sizeof(*p)` 这种会让后声明的先领到号。 */
  const dataPlan = planData(mod);
  const dataBytes = new Array(dataPlan.size).fill(0);
  /* 没有初始化式的那些进 `.bss`（第一百三十二片）：又一个各自独立的游标。这一节
   * **不占文件字节**，所以只有落点、没有字节数组 —— `bssSize` 交给写出器当 `sh_size`。 */
  const bssPlan = planBss(mod);
  /* 别名要照目标的落点发符号（第一百〇五片），所以边排边记每个全局的起点与它在哪一段。 */
  const gBase = new Map();
  for (let gi = 0; gi < mod.globals.length; gi++) {
    const blob = mod.globalBlob[gi];
    /* 外部的全局量（第三十一片）：不占字节、不定义符号 —— 它落进「未定义的外部符号」
     * 那一段，靠取它地址的那几条重定位把名字带进符号表。 */
    if (blob !== null && blob.extern) continue;
    const size = blob === null ? 8 : blob.size;
    const al = blob === null ? 8 : blob.align;
    if (al > 4096) arm64Nyi(`全局 '${mod.globals[gi]}' 要 ${al} 字节对齐（__data 这一节最多 4096）`);
    if (al > dataAlign) dataAlign = al;
    const ro = mod.globalRo[gi] === true;
    /* 三段（第一百三十二片）：只读、可写、`.bss`。次序是**有讲究**的 —— `const` 先问，
     * 所以 `const int i;`（没有初值）还是进只读那一节。 */
    const bss = !ro && mod.globalBss[gi] === true;
    const rel = ro ? roRelocs : dataRelocs;
    const sect = ro ? 3 : bss ? 4 : 2;
    /* 三段的落点都是排好的（第一百二十五、一百三十一、一百三十二片）：这儿只查，不推游标。 */
    const base = (ro ? roPlan.gOff : bss ? bssPlan.gOff : dataPlan.gOff).get(gi);
    gBase.set(gi, { base, sect });
    dataSyms.push({
      name: mod.globals[gi],
      /* 写进符号表的名字（第一百三十三片）：函数体里的 `static` 那一种与身份不同 ——
       * 身份是我们编的 `f.n.0`，名字是 tcc 写的 `n`。 */
      sym: mod.globalSym[gi],
      off: base,
      sect,
      /* `st_size`（第一百二十片，与 x64 那一份同一条）：这一块有多少字节。 */
      size,
      local: mod.globalLocal[gi] === true,
      weak: mod.globalWeak[gi] === true,
      vis: mod.globalVis[gi] ?? 0,
      /* 符号表里排第几（第一百二十六片）：与函数、串常量同一个轴上的号。 */
      seq: mod.globalSeq[gi],
    });
    for (let k = 0; k < size; k++) {
      const b = blob === null ? 0 : blob.bytes[k];
      const v = b === undefined ? 0 : b;
      if (ro) roBytes[base + k] = v;
      /* `.bss` 一个字节也不写（第一百三十二片）：这一节在文件里没有内容，
       * 而没有初始化式的那些字节本来就全是零。 */
      else if (!bss) dataBytes[base + k] = v;
    }
    for (const fx of blob === null ? [] : blob.fixups ?? []) {
      /* `after`（第一百一十八片，与 x64 那一份同一条）：这一条数据重定位是在第几个
       * 函数之前落的 —— `.rela.data` 那一节的造出来的次序全靠它。 */
      rel.push({
        at: base + fx.off,
        kind: 'POINTER64',
        sym: fixSym(fx),
        sect,
        after: mod.globalAfter[gi] ?? 0,
      });
    }
  }
  /* 数据的别名（第一百〇五片）：与目标同一个偏移，符号表里多一条。 */
  for (const a of mod.aliases) {
    if (a.kind !== 'g') continue;
    const at = gBase.get(a.no);
    if (at === undefined) arm64Nyi(`别名 '${a.name}' 的目标不在数据段里`);
    dataSyms.push({
      name: a.name, off: at.base, sect: at.sect, local: false, weak: a.weak === true,
    });
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
    /* 串常量摆进**只读那一节**（第一百二十三片，与 x64 那一份同一条）：每条按元素的
     * 宽度对齐 —— 窄串 1、宽串 4（`mod.strAlign`，宽串的地址会被交给按 `int` 读的
     * 代码）。从前一律 8 对齐摆在 `.data` 里，那是没有只读节可摆时的将就。 */
    const sal = mod.strAlign[r] ?? 1;
    const off = roPlan.sOff.get(r);
    const raw = kind === 'bytes' ? hexBytes(items[r].text) : utf8Bytes(items[r].text);
    /* `local: true`（第九十二片）：串常量的编号是**这个模块里**的序号，两个 `.o` 各有
     * 一个 `omni_str_0` —— 当外部符号的话一链就撞。局部符号里各归各家。
     * `size` 是带那个 0 的长度（第一百二十片那一格）。 */
    dataSyms.push({
      name,
      /* 符号表里的名字是 `L.N`（第一百三十四片，与 x64 那一份同一条）。 */
      sym: mod.strSym[r],
      off,
      sect: 3,
      size: raw.length + sal,
      local: true,
      seq: mod.strSeq[r],
    });
    for (let k = 0; k < raw.length; k++) roBytes[off + k] = raw[k];
    /* 结尾那一格是**一个元素宽**的零（`wstrConst` 不加它）—— 整块预置成 0，不用再补。 */
  }

  const buf = new Arm64CodeBuf();
  const labels = [];
  for (let i = 0; i < mod.funcs.length; i++) labels.push(buf.label());
  const offsets = [];
  let i = 0;
  for (const f of mod.funcs) {
    /* 这个模块里没有函数体（第一百二十八片，与 x64 那一份同一条）：一个字节都不出、
     * 也不发符号。落点记 −1，调用它的那条重定位把名字带进「未定义的外部符号」那一段。 */
    if (f.extern) {
      offsets.push(-1);
      i++;
      continue;
    }
    offsets.push(buf.pos());
    buf.place(labels[i]);
    new FnGen(mod, f, buf, labels, strSyms).gen();
    i++;
  }
  const bytes = buf.bytes();
  const sizes = [];
  for (let k = 0; k < offsets.length; k++) {
    if (offsets[k] < 0) {
      sizes.push(0);
      continue;
    }
    /* 「到下一个函数的落点」那一段（第一百二十片）—— 中间那些没有函数体的要跳过。 */
    let end = bytes.length;
    for (let m = k + 1; m < offsets.length; m++) {
      if (offsets[m] >= 0) { end = offsets[m]; break; }
    }
    sizes.push(end - offsets[k]);
  }
  return {
    bytes,
    offsets,
    sizes,
    relocs: buf.relocs,
    data: new Uint8Array(dataBytes),
    /* 只读那一段（第一百二十二片，与 x64 那一份同一条）：写 ELF 的那一头摆进 3 号节，
     * Mach-O 那一头现在只有两节，由 `macho.js` 折进 `__data` 的尾巴上。 */
    rodata: new Uint8Array(roBytes),
    /* `.bss` 只有长度（第一百三十二片）：ELF 那一头当 4 号节的 `sh_size`（NOBITS，
     * 不占文件字节），Mach-O 那一头由 `macho.js` 折进 `__data` 的尾巴上。 */
    bssSize: bssPlan.size,
    /* 每一节自己的 `sh_addralign`（第一百三十二片）：「里头对齐要求最大的那一块」，
     * 下界 8 —— 见 `mir/rodata.js` 的 `layout`。 */
    secAlign: { data: dataPlan.al, rodata: roPlan.al, bss: bssPlan.al },
    dataSyms,
    dataRelocs,
    roRelocs,
    dataAlign,
  };
}
