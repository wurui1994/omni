/**
 * MIR 的闭包编译解释器（ADR-0013 决策 3 + ADR-0014 决策 7）。
 *
 * 它是**第四个执行器**，也是唯一一条不涉及机器码的路径 —— 所以它的身份是 oracle：
 * 将来 LLVM JIT/AOT、SPIR-V、C 备选四条路的正确性都对着它比。
 *
 * 「闭包编译」的含义：装载期把每条 MIR 指令编成一个函数值，执行是 `prog[pc](F)`，
 * **分派只付一次**。每条指令的类型判断、op 表查询、跳转目标、字段名、闭包捕获表都在
 * 编译期算完并被闭包捕获住；运行期只剩「取操作数、算、写回、返回下一个 pc」。
 * 这与 OIR 树遍历解释器（interp/eval.js）的区别是实打实的：那一份每次求值都要
 * switch 一次节点种类、每次都要重新查 recvType。
 *
 * 语义**不重新实现一遍**：值表示、内建 op、成员派发、宿主库那 138 条 op 全部走
 * `interp/builtin.js` 里已有的那一份（`applyBuiltin` / `zeroOf` / `binOp` / …）。
 * 这不是复用代码的偷懒，是**避免语义分叉** —— 两个解释器给出不同答案的话，
 * 「五方逐字节相同」这条门槛就成了摆设。
 *
 * 控制流：MIR 是扁平的结构化标记（`BLOCK`/`LOOP`/`IF`/`ELSE`/`END` + 按层数的 `BR`），
 * 装载期一次扫描就能把每个区域配对、把每条 `BR` 的层数解析成**具体的 pc**。
 * 于是运行期没有区域栈、没有信号值往上传（OIR 那份要靠 NEXT/BREAK/CONTINUE/RETURN
 * 逐层返回），只有一个 pc 循环。
 */

import { OmniError } from '../source/diag.js';
import { stderr, wrapFn, callFnValue, i32Op, i32ToU, i32Wrap } from '../host/native.js';
import {
  applyBuiltin, zeroOf, newInstance, flushOut, failRt, jsCallFn,
  InterpFail, InterpUncaught, binOp, cmpOp, vecBinOp, bufNew, bufGet, bufSet,
  arrNew, arrLen, arrGet, arrSet, arrPush, arrPop, listGet, listSet, dictGet, dynTag, W,
  ptrNew, ptrChk, ptrTChk, ptrLoad, ptrStore, ptrAdd, ptrSub,
  memInit, memData, memSize, memGrow, memLoadFn, memStoreFn, memLoadFnN, memStoreFnN,
  mirrorPendingToHost,
} from '../interp/builtin.js';
import { JS_ALL } from '../hir/js_abi.js';
import { hasLibc, callLibc, ExitCall, setFnPtrCaller, libcAtExit } from '../interp/libc.js';
import { lowerToMir } from './from_oir.js';
import { verifyMir } from './verify.js';
import {
  OP, OP_NAMES, REF_NONE, REF_BIAS, isConstRef, typeKind, typeLanes,
  T_VOID, T_I64, T_F64, T_STR, T_DYN, T_PTR, T_TPTR, T_I32, T_F32, T_ARR,
  MLOAD_KINDS, MSTORE_KINDS, memKindNo, memOff,
  CVT_I2F, CVT_F2I, CVT_F2U, CVT_BOX, CVT_U2F, CVT_SEXT, CVT_ZEXT, CVT_TRUNC, CVT_SEXT8, CVT_SEXT16, CVT_FCVT,
  fnPtrNo,
} from './ir.js';

/** 常量池条目 -> 宿主值。i64 是 BigInt（ADR-0005），**i32 是 number**（第三刀），
 *  real 是 number。 */
function constVal(c) {
  if (c.kind === 'int') {
    return c.t === T_I32 ? Number(BigInt.asIntN(32, BigInt(c.text))) : BigInt(c.text);
  }
  if (c.kind === 'real') {
    if (c.text === 'inf') return Infinity;
    if (c.text === '-inf') return -Infinity;
    if (c.text === 'nan') return NaN;
    return Number(c.text);
  }
  if (c.kind === 'bool') return c.text === 'true';
  if (c.kind === 'str') return c.text;
  if (c.kind === 'undef') return undefined;
  return null;
}

/** 区域配对 + BR 的层数 -> 具体 pc。装载期扫一遍就够，运行期不再有区域栈。 */
function resolveRegions(f) {
  const endOf = [];
  const elseOf = [];
  const brTarget = [];
  // 跳表（第三刀）：一条 BRTABLE 的所有目标，**兜底放在最后一项**。
  // 与 brTarget 同样只记「开区域的那条指令的下标」，真正的 pc 在 step 里算 ——
  // endOf 那时才填全（END 在 BR 后面）。
  const tabTarget = [];
  let i = 0;
  while (i < f.count()) { endOf.push(-1); elseOf.push(-1); brTarget.push(-1); tabTarget.push(null); i++; }
  const stack = [];
  i = 0;
  while (i < f.count()) {
    const op = f.op[i];
    if (op === OP.BLOCK || op === OP.LOOP || op === OP.IF) stack.push(i);
    else if (op === OP.ELSE) elseOf[stack[stack.length - 1]] = i;
    else if (op === OP.END) {
      const start = stack.pop();
      endOf[start] = i;
      // ELSE 自己也记一份：then 分支跑完落到 ELSE 时要直接跳到这个 END
      if (elseOf[start] >= 0) endOf[elseOf[start]] = i;
    }
    else if (op === OP.BR || op === OP.BRIF) {
      const start = stack[stack.length - 1 - f.aux[i]];
      if (start === undefined) throw new OmniError(`mir.interp: ${f.name} 的 BR 跳出了函数`);
      brTarget[i] = start;
    }
    else if (op === OP.BRTABLE) {
      const starts = [];
      for (const lv of f.levelsOf(f.b[i])) {
        const s = stack[stack.length - 1 - lv];
        if (s === undefined) throw new OmniError(`mir.interp: ${f.name} 的 BRTABLE 跳出了函数`);
        starts.push(s);
      }
      const d = stack[stack.length - 1 - f.aux[i]];
      if (d === undefined) throw new OmniError(`mir.interp: ${f.name} 的 BRTABLE 兜底跳出了函数`);
      starts.push(d);
      tabTarget[i] = starts;
    }
    i++;
  }
  return { endOf, elseOf, brTarget, tabTarget };
}

/** MIR 的类型码 -> OIR 那套 kind 字符串（binOp/cmpOp 收的是后者）。 */
function kindOf(t) {
  if (t === T_I64) return 'int';
  if (t === T_F64) return 'real';
  if (t === T_STR) return 'string';
  if (t === T_DYN) return 'dynamic';
  return 'other';
}

/* ------------------------------------------- 32 位那一族（ADR-0017 第一刀 / ADR-0013 第三刀）
 * **i32 的宿主表示是 number**，不是 BigInt。为什么：量出来 BigInt 的分配是这条腿最大的
 * 一笔成本（同一个形状上 360 ms 对 24 ms，15 倍），而 JS 引擎对 32 位整数有快路。
 * 那三个算符（`| 0` / `>>>` / `Math.imul`）不在封闭子集里，所以走宿主 op：
 * `i32Op` / `i32ToU` / `i32Wrap`（见 host/native.js 那一段的理由）。
 *
 * 规范形仍旧是**符号扩展后的值**（见 ir.js 的 T_I32），只是装在 number 里；
 * 无符号那一族先 `i32ToU` 折成 [0, 2^32) 再比 —— 拿负数直接比就错了。
 * 除零在这一层查（op 里不查），消息与 64 位那份逐字相同。
 */
function bin32(op, a, b) {
  if (op === '/' || op === '%' || op === 'u/' || op === 'u%') {
    if (b === 0) failRt('division by zero');
  }
  return i32Op(op, a, b);
}

/** i32 的比较。有符号那六条在规范形上直接成立，无符号四条要先折成无符号。 */
function cmp32(op, a, b) {
  switch (op) {
    case 'u<': return i32ToU(a) < i32ToU(b);
    case 'u<=': return i32ToU(a) <= i32ToU(b);
    case 'u>': return i32ToU(a) > i32ToU(b);
    case 'u>=': return i32ToU(a) >= i32ToU(b);
    default: return cmpOp(op, a, b);
  }
}

/** f32 运算：按 double 算完再舍一次到单精度。除法与乘法在这条路上与硬件 single 一致。 */
function bin32f(op, a, b) {
  switch (op) {
    case '+': return Math.fround(a + b);
    case '-': return Math.fround(a - b);
    case '*': return Math.fround(a * b);
    case '/': return Math.fround(a / b);
    case '%': return Math.fround(a % b);
    default: throw new OmniError(`mir.interp.bin f32: ${op}`);
  }
}

/**
 * PLOAD / PSTORE 的**目标**类型码 -> ptrLoad/ptrStore 收的 kind（ADR-0016）。
 * 与 kindOf 分开一份：这里的"其余"是 bool（内存里只有那四种加两种指针），
 * 而 kindOf 的"其余"是"不是那四种标量"，两处的默认值不是一回事。
 * 指针自己也能当目标（第十六刀）：T_PTR 是三个字、T_TPTR 是一个字。
 */
function memKind(t) {
  if (t === T_I64) return 'int';
  if (t === T_F64) return 'real';
  if (t === T_PTR) return 'ptr';
  if (t === T_TPTR) return 'tptr';
  // 引用语义的句柄（ADR-0024）：内存里存的是一格 id，对象在 builtin 那张表上。
  // 这一支忘了加就会落到下面那个 bool 上 —— 那是个静默的错答案（量过：那时 arrLen 拿到的
  // 是 undefined，报出来的是宿主的 TypeError，不是 "null reference"）。
  if (t === T_ARR) return 'arr';
  return 'bool';
}

/** 缺席实参的零值。这里只有类型码，所以按码给 —— 真正带类型的零值走 zeroOf。
 *  i32 的零是 **number** 的 0（第三刀）。 */
function zeroOfCode(t) {
  if (t === T_I64) return 0n;
  if (t === T_F64) return 0;
  if (t === T_I32) return 0;
  if (t === T_F32) return 0;
  if (t === T_STR) return '';
  return null;
}

/**
 * `setjmp` / `longjmp`（ADR-0017 第八刀第二十二片）。
 *
 * 这两个不是 libc 里的一条普通调用 —— `setjmp` 要**返回两次**，而 `interp/libc.js`
 * 那张表里的函数只认实参、不认帧。能在这一层做的理由是这个解释器的形状：一帧一个
 * `while (pc …) pc = prog[pc](F)`，所以「回到某一帧的某条指令之后」是可表达的。
 *
 * 做法：
 *   - `setjmp(buf)` 记下**调用它的那一帧**（`buf` 的地址当键），回 0。
 *     外部符号是经桩函数调的，所以 `F` 是桩的帧、`F.up` 才是 C 那边的调用者。
 *   - `longjmp(buf, v)` 抛一个 `LongJmp`。中间那些帧靠宿主的异常自然退掉。
 *   - 目标帧的那个 pc 循环 catch 住：抛出的那一刻 `pc` 还停在**正在执行的那条指令**上，
 *     也就是那条 CALL。于是 `F.v[pc] = v; pc = pc + 1` 就等于「那次调用回了 v」。
 *
 * 键取 `jmp_buf` 的**地址**而不是往里写一个号：真的 `setjmp` 往那块地方存寄存器，
 * 没人读它的内容；按地址记还顺带对上了「同一个 buf 上后一次 setjmp 盖掉前一次」。
 *
 * 已经返回的帧上 longjmp 是 C 的未定义行为。这里不装作能做：那个异常会一路飘到
 * `runMirModule`，在那儿变成一条明确的运行期错误。
 */
/* 继承 `Error`：封闭子集里 `instanceof` 只对 Error 及其子类成立（ADR-0011 决策 15），
 * 而这个类的判断正是靠 `instanceof`（帧要认出"这是给我的那一跳"）。 */
class LongJmp extends Error {
  constructor(target, pc, val) {
    super('longjmp');
    this.target = target;
    this.pc = pc;
    this.val = val;
  }
}

/** @type {Map<bigint, object>} `jmp_buf` 的地址 -> `{ f: 那一帧, pc: 那条 CALL }` */
const jmpTargets = new Map();
const SETJMP_NAMES = new Set(['setjmp', '_setjmp', 'sigsetjmp', '__sigsetjmp']);
const LONGJMP_NAMES = new Set(['longjmp', '_longjmp', 'siglongjmp']);

class MirInterp {
  constructor(oir, mir) {
    this.mir = mir;
    // struct/enum/class 的定义留在 OIR 模块上：zeroOf/newInstance/拷贝都要字段类型，
    // 而 MIR 的类型池只带身份（名字挂在 aux）。类型池条目上的 `oir` 字段是同一份对象。
    this.structs = new Map();
    for (const s of oir.structs) this.structs.set(s.name, s);
    this.enums = new Map();
    for (const e of oir.enums ?? []) this.enums.set(e.name, e);
    this.classes = new Map();
    for (const c of oir.classes ?? []) this.classes.set(c.name, c);
    // JS 域的函数体只有一个形参，绑的是整条实参表（ADR-0011 第 1 节）
    this.js = oir.js === true;
    this.kvals = mir.consts.items.map(constVal);
    this.globals = mir.globals.map(() => undefined);
    this.progs = mir.funcs.map(() => null);
    this.depth = 0;
    /* 当前帧（`F.up` 那条链的头）。只有 setjmp 要它：它得知道**谁**调了自己。 */
    this.cur = undefined;
    /* 这个模块里有没有 setjmp。有才给每一帧套上 try —— 没有的话那五条既有的轴
     * 连一个 try 都不多付。 */
    this.usesSetjmp = mir.cabi.some((e) => SETJMP_NAMES.has(e));
    /* ---- 帧的**对象池**（ADR-0013 第三刀，js_interp.md 的第 7 条）。
     *
     * 从前每次调用都要：两个 `[]`、一个 `while push` 铺满槽、再一个 `while push`
     * 铺满**值窗口**（长度 = 指令条数！）。后一个是纯浪费：一个 300 条指令的函数
     * 每次进来都要 push 300 个 `undefined`，而其中大半这一趟根本不会被写。
     *
     * 池化之后：数组按函数号复用（递归各持一份，返回时还回来）。
     *   - 值窗口**不清**：MIR 是 SSA，每个 ref 先写后读（verifier 保证支配关系），
     *     所以上一趟留下的值不可能被读到。这一条是池化能成立的全部理由。
     *   - 槽**要清**：局部量可以先读后写（C 里那是未定义行为，我们给零值），
     *     所以每次进来从零值模板拷一遍 —— 那是 O(槽数)，通常十几个。 */
    this.vpool = mir.funcs.map(() => []);
    this.spool = mir.funcs.map(() => []);
    this.szero = mir.funcs.map(() => null);
  }

  /** 一个函数的槽位零值模板（第一次调用时算一次）。 */
  slotZeros(no) {
    let z = this.szero[no];
    if (z === null) {
      z = this.mir.funcs[no].slots.map((s) => zeroOfCode(s.t));
      this.szero[no] = z;
    }
    return z;
  }


  run() {
    // 线性内存在进入口之前就位（第二刀）：wasm 的 instantiate 也是先建内存、再拷 data 段、
    // 最后才调 start。`mem === null` 的模块（既有的五个前端）这里一个字节都不动。
    if (this.mir.mem !== null) {
      memInit(this.mir.mem.min, this.mir.mem.max);
      for (const d of this.mir.mem.data) memData(d.off, d.bytes);
    }
    const no = this.mir.funcIndex.get(this.mir.entry);
    if (no === undefined) throw new OmniError(`mir.interp: no entry function '${this.mir.entry}'`);
    const v = this.callFunc(no, undefined, []);
    /* 入口**可以带一个整数退出码**（ADR-0017 第六刀）：C 的 `main` 返回的就是进程
     * 退出码，而这一刀的 oracle 正是 `tcc -run` 的退出码。既有的五个前端的入口是
     * T_VOID，callFunc 回 undefined，这里照旧回 0 —— 那五条轴一个字节都不变。
     * 只留低 8 位：wait(2) 只传得下一个字节（`return -1` 于是是 255，与 tcc 一致）。 */
    const ret = this.mir.funcs[no].ret;
    if (ret === T_VOID || v === undefined || v === null) return 0;
    return Number(BigInt.asUintN(8, BigInt(v)));
  }

  /** 数组类型号 -> 元素是不是向量（"存进去要拷一份"的唯一一种）。类型池的 oir 上挂着
   *  元素的完整类型；8 位类型码分不出向量与行，所以这一问必须走池子。 */
  elemIsVec(n) {
    const ty = this.mir.types[n];
    if (ty === undefined || ty.kind !== 'arr') return false;
    return ty.oir.elem.k === 'vec';
  }

  /** 一个指针操作数是 thin 还是 fat：看它那条指令的 `t`（ADR-0016 把胖瘦放在类型码上，
   *  正是为了这一问能在**编译期**答完 —— 闭包里再问就是每次解引用都多一次查表）。
   *  指针不会从常量池来（空指针是 PNULL 一条指令），所以这里只认指令 ref。 */
  ptrIsThin(f, ref) {
    if (ref === REF_NONE || isConstRef(ref)) return false;
    return f.t[ref - REF_BIAS] === T_TPTR;
  }

  /** 一条 ref 的类型码。转换那几条要它：i32 是 number、i64 是 BigInt，
   *  方向必须由「源 + 结果」两头定（第三刀）。 */
  refT(f, ref) {
    if (ref === REF_NONE) return T_VOID;
    if (isConstRef(ref)) return this.mir.consts.items[ref].t;
    return f.t[ref - REF_BIAS];
  }

  /**
   * 二元运算的**特化闭包**（ADR-0013 第三刀第二段，js_interp.md 的"部分求值"那一条）。
   *
   * 从前每条二元指令要付三次调用：一次 `prog[pc](F)`，加两次操作数读取器 `l(F)`/`r(F)`。
   * 那两次是纯粹的间接层 —— 操作数是常量还是某个 ref **在装载期就知道**，所以把取值
   * 直接编进闭包里：常量成为捕获的值，ref 成为一次 `F.v[j]`。四种组合各发一份，
   * 于是运行期只剩「一次调用 + 两次数组下标 + 一次算」。
   *
   * 这比"特化 dispatch"（量过是 0 收益）不同：省掉的不是 switch，是**函数调用**。
   */
  bin2(f, i, fn) {
    const next = i + 1;
    const a = f.a[i];
    const b = f.b[i];
    const ac = isConstRef(a);
    const bc = isConstRef(b);
    if (ac && bc) {
      const x = this.kvals[a];
      const y = this.kvals[b];
      return (F) => { F.v[i] = fn(x, y); return next; };
    }
    if (ac) {
      const x = this.kvals[a];
      const k = b - REF_BIAS;
      return (F) => { F.v[i] = fn(x, F.v[k]); return next; };
    }
    if (bc) {
      const y = this.kvals[b];
      const j = a - REF_BIAS;
      return (F) => { F.v[i] = fn(F.v[j], y); return next; };
    }
    const j = a - REF_BIAS;
    const k = b - REF_BIAS;
    return (F) => { F.v[i] = fn(F.v[j], F.v[k]); return next; };
  }

  /** struct / enum 是值类型，深拷贝；其余（含 class）是引用。与 eval.js 的 copyOf 同一套。 */
  copyOf(t, v) {
    if (t === undefined || v === null || v === undefined) return v;
    if (t.k === 'struct') {
      const def = this.structs.get(t.name);
      const out = {};
      for (const fd of def.fields) out[fd.name] = this.copyOf(fd.type, v[fd.name]);
      return out;
    }
    if (t.k === 'enum') {
      const def = this.enums.get(t.name);
      const out = { $t: v.$t };
      for (const fd of def.variants[Number(v.$t)].fields) out[fd.name] = this.copyOf(fd.type, v[fd.name]);
      return out;
    }
    return v;
  }

  callFunc(no, captures, args) {
    const f = this.mir.funcs[no];
    let prog = this.progs[no];
    if (prog === null) { prog = this.compile(no); this.progs[no] = prog; }
    this.depth = this.depth + 1;
    if (this.depth > 4000) throw new OmniError('mir.interp: call stack too deep');
    // 帧 = 值窗口 + 槽位窗口（ADR-0013 决策 3）。形参就是前几个槽 —— 降级器是这么分的，
    // 值语义要的拷贝由函数体入口那几条 COPY 负责，不在这里重复。
    // 两个窗口都从**池**里拿（见构造函数那一段）：递归各持一份，返回时还回来。
    const vp = this.vpool[no];
    const sp = this.spool[no];
    const zeros = this.slotZeros(no);
    const nv = f.count();
    /* 值窗口铺满一次就够：封闭 ABI 里 list 的下标写入必须落在长度之内（越界在原生构建里
     * 是运行期错误，不是自动扩张）。池里那份**已经**是满的，所以只有第一次付这一笔。
     * 不清它是因为 MIR 是 SSA：每个 ref 先写后读。 */
    const v = vp.length > 0 ? vp.pop() : new Array(nv).fill(undefined);
    const s = sp.length > 0 ? sp.pop() : zeros.slice();
    const F = { v, s, captures, ret: undefined, up: this.cur };
    this.cur = F;
    const myDepth = this.depth;
    /* 槽要清：局部量可以先读后写（C 里那是未定义行为，我们给零值）。 */
    let i = 0;
    const ns = zeros.length;
    const na = args.length;
    while (i < ns) { s[i] = i < na ? args[i] : zeros[i]; i++; }
    let pc = 0;
    const n = prog.length;
    if (this.usesSetjmp) {
      /* longjmp 的落点（见 `LongJmp` 那一段）。抛出的那一刻 `pc` 还停在正在执行的
       * 那条指令上 —— 也就是调 setjmp 的那条 CALL —— 所以写回它的值、再往下一条走。
       * 中间那些帧的 `depth`/`cur` 复原被异常跳过了，在这儿一次收回。
       *
       * 「跑完了」用一个旗子传出来、`break` 落在 try 外面：封闭子集不许 `break`
       * 跨过 try 的边界（那条规则是为了 C 后端的落法，见 ADR-0011）。 */
      let done = false;
      while (!done) {
        try {
          while (pc >= 0 && pc < n) pc = prog[pc](F);
          done = true;
        } catch (e) {
          if (!(e instanceof LongJmp) || e.target !== F) throw e;
          this.depth = myDepth;
          this.cur = F;
          F.v[e.pc] = e.val;
          pc = e.pc + 1;
        }
      }
    } else {
      while (pc >= 0 && pc < n) pc = prog[pc](F);
    }
    const out = F.ret;
    this.depth = this.depth - 1;
    this.cur = F.up;
    /* 两个窗口还回池子。**正常返回才还** —— longjmp / exit 那两条路上这一帧的数组
     * 就让 GC 收，不然还得判"它是不是还在某条异常路径上被引用"。 */
    vp.push(v);
    sp.push(s);
    return out;
  }

  /**
   * 把一个函数编成一串闭包，一条指令一个。每个闭包收帧、返回**下一个 pc**；
   * -1 表示返回。所有能在装载期算掉的东西都在这里算掉并被闭包捕获住。
   */
  compile(no) {
    const f = this.mir.funcs[no];
    const I = this;
    const { endOf, elseOf, brTarget, tabTarget } = resolveRegions(f);
    // 操作数读取器：常量在编译期就取出值，指令引用编成一次数组访问
    const rd = (ref) => {
      if (ref === REF_NONE) return () => undefined;
      if (isConstRef(ref)) { const v = this.kvals[ref]; return () => v; }
      const j = ref - REF_BIAS;
      return (F) => F.v[j];
    };
    const rdArgs = (at) => f.argsOf(at).map(rd);
    const readAll = (rs, F) => rs.map((r) => r(F));

    const prog = [];
    let i = 0;
    while (i < f.count()) {
      prog.push(this.step(f, i, rd, rdArgs, readAll, endOf, elseOf, brTarget, tabTarget, I));
      i++;
    }
    return prog;
  }

  /** 一条指令 -> 一个闭包。控制流与槽位这一半。 */
  step(f, i, rd, rdArgs, readAll, endOf, elseOf, brTarget, tabTarget, I) {
    const op = f.op[i];
    const t = f.t[i];
    const a = f.a[i];
    const b = f.b[i];
    const x = f.aux[i];
    const next = i + 1;
    switch (op) {
      // 区域标记本身不做事。留着它们是因为 pc 是指令下标，跳转目标要落在真实位置上；
      // 折叠掉会让 BR 的目标计算多一层映射，而这一层每次跳都要付。
      case OP.BLOCK: case OP.LOOP: case OP.END:
        return () => next;
      // then 分支跑完落到 ELSE：跳到配对的 END（END 自己是空操作，再 +1 出去）
      case OP.ELSE: {
        const target = endOf[i];
        if (target < 0) throw new OmniError(`mir.interp: ${f.name} 的 ELSE 没有配对的 END`);
        return () => target;
      }
      case OP.IF: {
        const c = rd(a);
        const els = elseOf[i];
        const target = els >= 0 ? els + 1 : endOf[i] + 1;
        return (F) => (c(F) === true ? next : target);
      }
      case OP.BR: {
        const start = brTarget[i];
        // 跳 LOOP = 回循环头（continue），跳 BLOCK/IF = 跳到它的 END 之后（break）
        const target = f.op[start] === OP.LOOP ? start + 1 : endOf[start] + 1;
        return () => target;
      }
      case OP.BRIF: {
        const c = rd(a);
        const start = brTarget[i];
        const target = f.op[start] === OP.LOOP ? start + 1 : endOf[start] + 1;
        return (F) => (c(F) === true ? target : next);
      }
      // 跳表（第三刀）。**pc 表在装载期就算好**，运行期只剩「一次范围比较 + 一次数组下标」
      // —— 这就是跳表相对比较链的全部意义，编译期不把它算掉就白加了这条 op。
      case OP.BRTABLE: {
        const idx = rd(a);
        const starts = tabTarget[i];
        const pcs = starts.map((s) => (f.op[s] === OP.LOOP ? s + 1 : endOf[s] + 1));
        const def = pcs[pcs.length - 1];   // 最后一项是兜底
        // 下标按无符号读（wasm）。规范形是符号扩展过的，所以负数就是"很大的无符号数"
        // —— 一律走兜底，与 `v u>= n` 等价（n 不会大到 2^31）。
        // i32 的下标现在是 number（第三刀），i64 的仍是 BigInt，两条各走各的比较。
        if (this.refT(f, a) === T_I32) {
          const n = pcs.length - 1;
          return (F) => {
            const v = idx(F);
            if (v < 0 || v >= n) return def;
            return pcs[v];
          };
        }
        const n = BigInt(pcs.length - 1);
        return (F) => {
          const v = idx(F);
          if (v < 0n || v >= n) return def;
          return pcs[Number(v)];
        };
      }
      case OP.RET: {
        if (a === REF_NONE) return (F) => { F.ret = undefined; return -1; };
        const v = rd(a);
        return (F) => { F.ret = v(F); return -1; };
      }
      case OP.LOAD:
        return (F) => { F.v[i] = F.s[x]; return next; };
      case OP.STORE: {
        const v = rd(a);
        return (F) => { F.s[x] = v(F); return next; };
      }
      case OP.GLOAD:
        return (F) => { F.v[i] = I.globals[x]; return next; };
      case OP.GSTORE: {
        const v = rd(a);
        return (F) => { I.globals[x] = v(F); return next; };
      }
      case OP.CAPTURE: {
        const name = this.captureName(f, x);
        return (F) => { F.v[i] = F.captures.get(name); return next; };
      }
      default:
        return this.step2(f, i, rd, rdArgs, readAll, I);
    }
  }

  /** ELSE 所在 IF 的 END 已经在 resolveRegions 里记好了（endOf 也按 ELSE 的下标存一份）。 */
  captureName(f, x) {
    const def = this.mir.closures[f.closureId];
    if (def === undefined) throw new OmniError(`mir.interp: ${f.name} 不是闭包体，却读了捕获`);
    return def.captures[x];
  }

  /** 运算与转换。 */
  step2(f, i, rd, rdArgs, readAll, I) {
    const op = f.op[i];
    const t = f.t[i];
    const next = i + 1;
    const x = f.aux[i];
    if (BIN_STR.has(op)) {
      const o = BIN_STR.get(op);
      const kind = kindOf(t);
      // 向量：宿主表示是一条长度 = 宽度的数组，逐道走 **同一份** binOp（vecBinOp 就在
      // interp/builtin.js 里，OIR 解释器用的也是它）—— 两个解释器不会在道上分叉。
      if (typeLanes(t) > 1) {
        const l = rd(f.a[i]);
        const r = rd(f.b[i]);
        const vt = { lanes: typeLanes(t), elem: { k: kindOf(typeKind(t)) } };
        return (F) => { F.v[i] = vecBinOp(o, vt, l(F), r(F)); return next; };
      }
      // 32 位那两格走各自的一份（ADR-0017 第一刀）：回绕宽度与移位掩码都不一样
      if (t === T_I32) return this.bin2(f, i, (a, b) => bin32(o, a, b));
      if (t === T_F32) return this.bin2(f, i, (a, b) => bin32f(o, a, b));
      return this.bin2(f, i, (a, b) => binOp(o, kind, a, b));
    }
    if (CMP_STR.has(op)) {
      const o = CMP_STR.get(op);
      // dynamic 的相等：标签相同**且**值相同（ADR-0006）。`t` 是操作数类型，所以这里
      // 认得出来 —— 结果类型是 bool，看它就分不出这一支了。
      if (t === T_DYN) {
        const isEq = op === OP.EQ;
        return this.bin2(f, i, (a, b) => {
          const eq = dynTag(a) === dynTag(b) && a === b;
          return isEq ? eq : !eq;
        });
      }
      // i32 的无符号比较要先零扩展到 32 位（见 cmp32 的注释）；有符号那六条在规范形上
      // 直接成立，所以这一支只在 t 是 i32 时接手。
      if (t === T_I32) return this.bin2(f, i, (a, b) => cmp32(o, a, b));
      return this.bin2(f, i, (a, b) => cmpOp(o, a, b));
    }
    switch (op) {
      case OP.NEG: {
        const v = rd(f.a[i]);
        // 一元负号也会溢出：-INT64_MIN == INT64_MIN，必须回绕
        if (t === T_I64) return (F) => { F.v[i] = W(-v(F)); return next; };
        // i32 是 number：过 op 走「0 - x」，回绕与溢出都在那一份里
        if (t === T_I32) return (F) => { F.v[i] = i32Op('-', 0, v(F)); return next; };
        if (t === T_F32) return (F) => { F.v[i] = Math.fround(-v(F)); return next; };
        return (F) => { F.v[i] = -v(F); return next; };
      }
      case OP.BNOT: {
        const v = rd(f.a[i]);
        // `~x` 就是 `x ^ -1`（i32 上过 op；i64 仍是 BigInt）
        if (t === T_I32) return (F) => { F.v[i] = i32Op('^', v(F), -1); return next; };
        return (F) => { F.v[i] = W(~v(F)); return next; };
      }
      case OP.NOT: {
        const v = rd(f.a[i]);
        return (F) => { F.v[i] = !v(F); return next; };
      }
      case OP.CVT: {
        const v = rd(f.a[i]);
        // 源类型：整数之间那几条的方向由「源 + 结果」两头定（i32 是 number、i64 是 BigInt）
        const st = this.refT(f, f.a[i]);
        /* 整数 -> 浮点。目标是 f32 就要**真的舍到单精度** —— 少这一次 fround，
         * `(float)16777217` 在解释器里会保住那个 1，而在真的 f32 上它舍成 16777216。
         * 源是 i32 时它已经是 number，`Number()` 那一步都不用付。 */
        if (x === CVT_I2F) {
          if (st === T_I32) {
            if (t === T_F32) return (F) => { F.v[i] = Math.fround(v(F)); return next; };
            return (F) => { F.v[i] = v(F); return next; };
          }
          if (t === T_F32) return (F) => { F.v[i] = Math.fround(Number(v(F))); return next; };
          return (F) => { F.v[i] = Number(v(F)); return next; };
        }
        // 位当无符号读再转（第六十一刀）。i32 那半边过 `i32ToU`，i64 那半边过 asUintN(64)。
        if (x === CVT_U2F) {
          if (st === T_I32) {
            if (t === T_F32) return (F) => { F.v[i] = Math.fround(i32ToU(v(F))); return next; };
            return (F) => { F.v[i] = i32ToU(v(F)); return next; };
          }
          if (t === T_F32) {
            return (F) => { F.v[i] = Math.fround(Number(BigInt.asUintN(64, v(F)))); return next; };
          }
          return (F) => { F.v[i] = Number(BigInt.asUintN(64, v(F))); return next; };
        }
        /* 浮点 -> 整数：**朝零截尾**（C11 6.3.1.4 第 1 段）。装不下（含 NaN/无穷）在 C 里
         * 是未定义行为，这里收成 0 而不是抛错 —— 抛错会让「UB」变成「一定崩」，
         * 那是另一种语义，而且两条腿不可能一致（原生那边是随便一个值）。 */
        if (x === CVT_F2I) {
          // i32：`i32Wrap` 就是 ToInt32（对 2^32 取模再看符号），NaN/无穷落成 0
          if (t === T_I32) return (F) => { F.v[i] = i32Wrap(Math.trunc(v(F))); return next; };
          return (F) => {
            const d = Math.trunc(v(F));
            F.v[i] = Number.isFinite(d) ? BigInt.asIntN(64, BigInt(d)) : 0n;
            return next;
          };
        }
        /* 浮点 -> **无符号**整数（第九十五片）。与 `F2I` 差的只有「按几位读」：
         * 位模式仍旧存成两补（MIR 里没有无符号类型码），所以上半区落成负数 ——
         * 与 `fcvtzu` 出来的位一样。 */
        if (x === CVT_F2U) {
          if (t === T_I32) {
            return (F) => {
              const d = Math.trunc(v(F));
              F.v[i] = Number.isFinite(d) && d >= 0 ? i32Wrap(d) : 0;
              return next;
            };
          }
          return (F) => {
            const d = Math.trunc(v(F));
            F.v[i] = Number.isFinite(d) && d >= 0
              ? BigInt.asIntN(64, BigInt.asUintN(64, BigInt(d)))
              : 0n;
            return next;
          };
        }
        // 装箱是恒等：dynamic 就是原生值（ADR-0006 第 2 节）。C 后端那边它是打标签，
        // 所以指令留着 —— 「哪里发生装箱」是后端要知道的事实。
        if (x === CVT_BOX) return (F) => { F.v[i] = v(F); return next; };
        /* ---- 宽度转换（ADR-0017 第一刀 / ADR-0013 第三刀）。`t` 是**结果**类型。
         * i32 是 number、i64 是 BigInt，所以扩宽/变窄这几条现在**真的要换表示**：
         * 从前 sext 是恒等（两边都是 BigInt），现在它是一次装箱。 */
        if (x === CVT_SEXT) {
          if (st === T_I32 && t === T_I64) return (F) => { F.v[i] = BigInt(v(F)); return next; };
          return (F) => { F.v[i] = v(F); return next; };
        }
        if (x === CVT_ZEXT) {
          if (st === T_I32) return (F) => { F.v[i] = BigInt(i32ToU(v(F))); return next; };
          return (F) => { F.v[i] = BigInt.asUintN(64, v(F)); return next; };
        }
        if (x === CVT_TRUNC) {
          return (F) => { F.v[i] = Number(BigInt.asIntN(32, v(F))); return next; };
        }
        // 低 8/16 位的符号扩展。i32 上是两次移位（C 的 `(signed char)x`），i64 上仍是 BigInt
        if (x === CVT_SEXT8) {
          if (t === T_I32) {
            return (F) => { F.v[i] = i32Op('>>', i32Op('<<', v(F), 24), 24); return next; };
          }
          return (F) => { F.v[i] = BigInt.asIntN(8, v(F)); return next; };
        }
        if (x === CVT_SEXT16) {
          if (t === T_I32) {
            return (F) => { F.v[i] = i32Op('>>', i32Op('<<', v(F), 16), 16); return next; };
          }
          return (F) => { F.v[i] = BigInt.asIntN(16, v(F)); return next; };
        }
        // 浮点宽度：变窄要真的舍到单精度，变宽是恒等（single 的每个值都是 double 的值）
        if (x === CVT_FCVT) {
          if (t === T_F32) return (F) => { F.v[i] = Math.fround(v(F)); return next; };
          return (F) => { F.v[i] = v(F); return next; };
        }
        throw new OmniError(`mir.interp: 还不支持的转换模式 ${x}`);
      }
      // 向量三条。VINS **拷一份再改**，不就地改：MIR 的值是 SSA，就地改会让源向量
      // 在别处也变了（`(vlit ...)` 就是一串 VINS，第一条的输入是那个 splat）。
      case OP.VSPLAT: {
        const v = rd(f.a[i]);
        const n = typeLanes(t);
        return (F) => {
          const s = v(F);
          const out = [];
          for (let k = 0; k < n; k++) out.push(s);
          F.v[i] = out;
          return next;
        };
      }
      case OP.VINS: {
        const v = rd(f.a[i]);
        const s = rd(f.b[i]);
        return (F) => {
          const out = v(F).slice();
          out[x] = s(F);
          F.v[i] = out;
          return next;
        };
      }
      case OP.VEXT: {
        const v = rd(f.a[i]);
        return (F) => { F.v[i] = v(F)[x]; return next; };
      }
      // 缓冲四条。走的是 interp/builtin.js 里那一份（OIR 解释器用的也是它）：
      // 越界的消息文本因此不可能在两个解释器之间分叉。
      case OP.BNEW: {
        const c = rd(f.a[i]);
        const kind = kindOf(x);
        return (F) => { F.v[i] = bufNew(kind, c(F)); return next; };
      }
      case OP.BLEN: {
        const b = rd(f.a[i]);
        return (F) => { F.v[i] = BigInt(b(F).length); return next; };
      }
      case OP.BGET: {
        const b = rd(f.a[i]);
        const k = rd(f.b[i]);
        return (F) => { F.v[i] = bufGet(b(F), k(F)); return next; };
      }
      case OP.BSET: {
        const b = rd(f.a[i]);
        const args = rdArgs(f.b[i]);
        return (F) => { F.v[i] = bufSet(b(F), args[0](F), args[1](F)); return next; };
      }
      // 数组六条。同样走 interp/builtin.js 那一份 —— 两个解释器共用一份实现，
      // 而它的消息文本又与 omni_arr.c 逐字对齐，于是五条腿只有一个字符串。
      // 末位那个布尔是"元素是值语义、存进去要拷一份"（只有向量）。它从 aux 上那个
      // **数组类型号**问出来（类型池的 oir 挂着元素的完整类型）—— 8 位类型码分不出
      // 向量与行，而多维数组那一刀之后两者在 JS 侧都是数组（见 builtin.js 的 arrCopy）。
      case OP.ANEW: {
        const c = rd(f.a[i]);
        const z = rd(f.b[i]);
        const cp = this.elemIsVec(f.aux[i]);
        return (F) => { F.v[i] = arrNew(c(F), z(F), cp); return next; };
      }
      case OP.ALEN: {
        const a = rd(f.a[i]);
        return (F) => { F.v[i] = arrLen(a(F)); return next; };
      }
      case OP.AGET: {
        const a = rd(f.a[i]);
        const k = rd(f.b[i]);
        return (F) => { F.v[i] = arrGet(a(F), k(F)); return next; };
      }
      case OP.ASET: {
        const a = rd(f.a[i]);
        const args = rdArgs(f.b[i]);
        const cp = this.elemIsVec(f.aux[i]);
        return (F) => { F.v[i] = arrSet(a(F), args[0](F), args[1](F), cp); return next; };
      }
      case OP.APUSH: {
        const a = rd(f.a[i]);
        const v = rd(f.b[i]);
        const cp = this.elemIsVec(f.aux[i]);
        return (F) => { F.v[i] = arrPush(a(F), v(F), cp); return next; };
      }
      case OP.APOP: {
        const a = rd(f.a[i]);
        return (F) => { F.v[i] = arrPop(a(F)); return next; };
      }
      // 指针（ADR-0016）。同样走 interp/builtin.js 那一份 —— 两个解释器与 backend-js
      // 的 prelude 是三处**同一套算法**，三条错误消息因此逐字节相同。
      // 胖瘦看 `t`（T_TPTR 是 thin），步长在 aux 上。
      case OP.PNEW: {
        const c = rd(f.a[i]);
        return (F) => { F.v[i] = ptrNew(c(F), x); return next; };
      }
      case OP.PNULL: {
        const thin = t === T_TPTR;
        return (F) => { F.v[i] = thin ? 0 : [0, 0, 0]; return next; };
      }
      case OP.PISNULL: {
        const p = rd(f.a[i]);
        const thin = this.ptrIsThin(f, f.a[i]);
        return (F) => { const v = p(F); F.v[i] = (thin ? v : v[0]) === 0; return next; };
      }
      case OP.PTHIN: {
        const p = rd(f.a[i]);
        return (F) => { F.v[i] = p(F)[0]; return next; };
      }
      case OP.PLOAD: {
        const p = rd(f.a[i]);
        const kind = memKind(t);
        const thin = this.ptrIsThin(f, f.a[i]);
        return (F) => {
          const v = p(F);
          F.v[i] = ptrLoad(kind, thin ? ptrTChk(v) : ptrChk(v, x));
          return next;
        };
      }
      case OP.PSTORE: {
        const p = rd(f.a[i]);
        const v = rd(f.b[i]);
        const kind = memKind(t);
        const thin = this.ptrIsThin(f, f.a[i]);
        return (F) => {
          const q = p(F);
          F.v[i] = ptrStore(kind, thin ? ptrTChk(q) : ptrChk(q, x), v(F));
          return next;
        };
      }
      // ---- 线性内存（ADR-0017 第二刀）。四条都在**闭包构造期**把描述符拆开：
      // 宽度、符号、静态偏移全是编译期常量，于是每次访问只剩"一次加法 + 一次
      // DataView 调用"。查表（MLOAD_KINDS -> 那九个函数之一）也只在这儿做一次。
      case OP.MSIZE: return (F) => { F.v[i] = memSize(); return next; };
      case OP.MGROW: {
        const n = rd(f.a[i]);
        return (F) => { F.v[i] = memGrow(n(F)); return next; };
      }
      case OP.MLOAD: {
        const p = rd(f.a[i]);
        const kind = MLOAD_KINDS[memKindNo(x)];
        /* 结果是 i32 就用 **number 口径**那一组（第三刀）：读出来直接是 number，
         * 不经过一次 BigInt。选口径在装载期做完，运行期只是一次调用。 */
        const ld = t === T_I32 ? (memLoadFnN(kind) ?? memLoadFn(kind)) : memLoadFn(kind);
        const off = memOff(x);
        return (F) => { F.v[i] = ld(p(F), off); return next; };
      }
      case OP.MSTORE: {
        const p = rd(f.a[i]);
        const v = rd(f.b[i]);
        const kind = MSTORE_KINDS[memKindNo(x)];
        const st = t === T_I32 ? (memStoreFnN(kind) ?? memStoreFn(kind)) : memStoreFn(kind);
        const off = memOff(x);
        return (F) => { const w = v(F); st(p(F), off, w); F.v[i] = w; return next; };
      }
      case OP.PADD: {
        const p = rd(f.a[i]);
        const k = rd(f.b[i]);
        const thin = t === T_TPTR;
        return (F) => {
          const q = p(F);
          F.v[i] = thin ? q + Number(k(F)) * x : ptrAdd(q, k(F), x);
          return next;
        };
      }
      case OP.PSUB: {
        const a = rd(f.a[i]);
        const b = rd(f.b[i]);
        const thin = this.ptrIsThin(f, f.a[i]);
        return (F) => {
          const p = a(F);
          const q = b(F);
          F.v[i] = thin ? BigInt((p - q) / x) : ptrSub(p, q, x);
          return next;
        };
      }
      // 只比**地址那一个字**：fat 在这一层是个三元数组，两个指向同一格的指针各是一份
      // 拷贝，`===` 比引用就永远不等。
      case OP.PEQ: {
        const a = rd(f.a[i]);
        const b = rd(f.b[i]);
        const thin = this.ptrIsThin(f, f.a[i]);
        return (F) => {
          const p = a(F);
          const q = b(F);
          F.v[i] = thin ? p === q : p[0] === q[0];
          return next;
        };
      }
      default:
        return this.step3(f, i, rd, rdArgs, readAll, I);
    }
  }

  /** 聚合、容器、调用。 */
  step3(f, i, rd, rdArgs, readAll, I) {
    const op = f.op[i];
    const t = f.t[i];
    const next = i + 1;
    const x = f.aux[i];
    switch (op) {
      case OP.NEW: {
        const ty = this.mir.types[x].oir;
        if (ty.k === 'class') return (F) => { F.v[i] = newInstance(ty, I); return next; };
        return (F) => { F.v[i] = zeroOf(ty, I); return next; };
      }
      case OP.COPY: {
        const ty = this.mir.types[x].oir;
        const v = rd(f.a[i]);
        return (F) => { F.v[i] = I.copyOf(ty, v(F)); return next; };
      }
      case OP.FLD: {
        const acc = this.mir.accs[x];
        const name = acc.field;
        // class 是引用类型，可能为 null：两个后端都显式检查，消息一致（$nullCheck）
        const guard = this.mir.types[acc.type].kind === 'class';
        const o = rd(f.a[i]);
        return (F) => {
          const ov = o(F);
          if (guard && (ov === null || ov === undefined)) failRt('null reference');
          F.v[i] = ov[name];
          return next;
        };
      }
      case OP.FLDSET: {
        const name = this.mir.accs[x].field;
        const o = rd(f.a[i]);
        const v = rd(f.b[i]);
        return (F) => {
          const ov = o(F);
          if (ov === null || ov === undefined) failRt('null reference');
          ov[name] = v(F);
          return next;
        };
      }
      case OP.MKENUM: {
        const ty = this.mir.types[x].oir;
        const tag = f.a[i];
        const names = ty.variants[tag].fields.map((fd) => fd.name);
        const args = rdArgs(f.b[i]);
        const tagVal = BigInt(tag);
        return (F) => {
          const out = { $t: tagVal };
          let k = 0;
          while (k < args.length) { out[names[k]] = args[k](F); k++; }
          F.v[i] = out;
          return next;
        };
      }
      case OP.ETAG: {
        const o = rd(f.a[i]);
        return (F) => { F.v[i] = o(F).$t; return next; };
      }
      default:
        return this.step4(f, i, rd, rdArgs, readAll, I);
    }
  }

  /** 下标、字面量、五种调用。 */
  step4(f, i, rd, rdArgs, readAll, I) {
    const op = f.op[i];
    const next = i + 1;
    const x = f.aux[i];
    switch (op) {
      case OP.IDXGET: {
        const isList = this.mir.types[x].kind === 'list';
        const o = rd(f.a[i]);
        const k = rd(f.b[i]);
        if (isList) return (F) => { F.v[i] = listGet(o(F), k(F)); return next; };
        return (F) => { F.v[i] = dictGet(o(F), k(F)); return next; };
      }
      case OP.IDXSET: {
        const isList = this.mir.types[x].kind === 'list';
        const o = rd(f.a[i]);
        const args = rdArgs(f.b[i]);   // [下标, 值]
        return (F) => {
          const ov = o(F);
          const kv = args[0](F);
          const vv = args[1](F);
          F.v[i] = isList ? listSet(ov, kv, vv) : setDict(ov, kv, vv);
          return next;
        };
      }
      case OP.AGGLIT: {
        const kind = this.mir.types[x].kind;
        const args = rdArgs(f.b[i]);
        if (kind === 'list') return (F) => { F.v[i] = readAll(args, F); return next; };
        if (kind === 'set') return (F) => { F.v[i] = new Set(readAll(args, F)); return next; };
        // dict：池里是 k,v,k,v…（顺序就是源码里的书写顺序，Map 保持插入序）
        return (F) => {
          const m = new Map();
          let k = 0;
          while (k < args.length) { m.set(args[k](F), args[k + 1](F)); k = k + 2; }
          F.v[i] = m;
          return next;
        };
      }
      case OP.CALL: {
        const no = f.a[i];
        const args = rdArgs(f.b[i]);
        /* 有 setjmp 的模块里，每条 CALL 先把**自己的下标**记进帧：`setjmp` 落在桩函数
         * 里，它要问的正是「调我的那一帧停在哪条指令上」，而那条指令就是 longjmp 的落点
         * （见 `LongJmp` 那一节）。没有 setjmp 的模块连这一次写都不付。 */
        if (this.usesSetjmp) {
          return (F) => {
            F.pc = i;
            F.v[i] = I.callFunc(no, undefined, readAll(args, F));
            return next;
          };
        }
        /* 实参表用**这条调用点自己的**一块草稿，不每次新建（第三刀第三段）。
         * 递归也安全：`callFunc` 进门第一件事就是把实参拷进被调者的槽，拷完这块草稿就死了，
         * 而里层的调用发生在那之后 —— 所以同一条 CALL 递归下去也不会互相踩。
         * profile 上这一格（连同 callFunc 里那两笔）占 BBP 的四成，所以值得这么写。 */
        const scratch = new Array(args.length);
        const na = args.length;
        return (F) => {
          let k = 0;
          while (k < na) { scratch[k] = args[k](F); k++; }
          F.v[i] = I.callFunc(no, undefined, scratch);
          return next;
        };
      }
      case OP.CALLFN: {
        const fv = rd(f.a[i]);
        const args = rdArgs(f.b[i]);
        // aux=1：JS 域的动态调用，实参是**一条实参表**，整条交给宿主的 js_call_fn ——
        // 「函数值不是函数」的检查与消息也就留在宿主那一份里（ADR-0013 决策 5）。
        if (x === 1) return (F) => { F.v[i] = jsCallFn(fv(F), args[0](F)); return next; };
        return (F) => {
          const g = fv(F);
          if (g === null || g === undefined) failRt('call of a null function value');
          F.v[i] = callFnValue(g, readAll(args, F));
          return next;
        };
      }
      case OP.CALLI: {
        /* 间接调用（C 的函数指针）。a 是**函数指针值** —— 0 是空、非 0 是函数号 + 1
         * （编码定在 ir.js 的 `CALLI` 上）。签名对不对是前端的事，这儿只查这两格。 */
        const fv = rd(f.a[i]);
        const args = rdArgs(f.b[i]);
        return (F) => {
          const no = fnPtrNo(fv(F));
          if (no < 0) failRt('call of a null function pointer');
          if (I.mir.funcs[no] === undefined) failRt(`function pointer index ${no} out of range`);
          F.v[i] = I.callFunc(no, undefined, readAll(args, F));
          return next;
        };
      }
      default:
        return this.step5(f, i, rd, rdArgs, readAll, I);
    }
  }

  /** CALLOP / CLOSURE / CCALL。 */
  step5(f, i, rd, rdArgs, readAll, I) {
    const op = f.op[i];
    const next = i + 1;
    const x = f.aux[i];
    if (op === OP.CALLOP) {
      // 描述符**在装载期造一次**：`applyBuiltin` 会把 op 表的解析结果缓存回这个对象上
      // （negative cache + 成员描述符），于是「分派只付一次」对这条路径同样成立。
      const desc = opDescriptor(this.mir.ops[f.a[i]]);
      const args = rdArgs(f.b[i]);
      return (F) => { F.v[i] = applyBuiltin(I, desc, readAll(args, F)); return next; };
    }
    if (op === OP.CLOSURE) {
      const def = this.mir.closures[f.a[i]];
      const bodyNo = this.mir.funcIndex.get(def.funcName);
      if (bodyNo === undefined) throw new OmniError(`mir.interp: closure body '${def.funcName}' is missing`);
      const names = def.captures;
      const args = rdArgs(f.b[i]);
      const isJs = this.js;
      // 带 `single` 的那一格（`(fnref f)` 的薄适配器）是**单件**：同一个具名函数取出来的值
      // 必须是同一个东西，不然 `f == g` 这种按身份比的式子永远为假。与三个后端同一条规矩。
      const single = def.single === true && names.length === 0;
      return (F) => {
        if (single && def.$one !== undefined) { F.v[i] = def.$one; return next; }
        // 捕获在这里**按值拷进记录**（ADR-0010）：不靠宿主的词法作用域，那是按引用捕获的，
        // 循环里造的闭包会在两个后端给出不同答案。
        const caps = new Map();
        let k = 0;
        while (k < names.length) { caps.set(names[k], args[k](F)); k++; }
        // wrapFn：解释器造的函数值必须**就是**这一代的闭包记录，宿主库那些回调 op
        // （xs.map(f)）拿到它才能直接调（ADR-0013 决策 3）。JS 域的函数体只有一个形参，
        // 绑的是整条实参表，所以那一支要再包一层。
        // mirrorPendingToHost：回调里的 throw 落在解释器那一份待决槽里，而宿主那些 op
        // （$js_arr_for_each 的循环）问的是 prelude 那一份 —— 见 interp/builtin.js 里那段注。
        F.v[i] = isJs
          ? wrapFn((self, callArgs) => {
            const r = I.callFunc(bodyNo, caps, [callArgs]);
            mirrorPendingToHost();
            return r;
          })
          : wrapFn((self, callArgs) => {
            const r = I.callFunc(bodyNo, caps, callArgs);
            mirrorPendingToHost();
            return r;
          });
        /* fn.name / fn.length 也存在记录里（与 backend-js 的 closureMake、interp/eval.js 的
           makeClosure 一一对应）：这条腿与它们共用那份 prelude，少这两格就是静默的错答案。 */
        if (typeof def.fnName === 'string') {
          F.v[i].$nm = def.fnName;
          F.v[i].$ln = def.fnLen === undefined ? 0 : def.fnLen;
        }
        if (single) def.$one = F.v[i];
        return next;
      };
    }
    if (op === OP.CCALL) {
      const entry = this.mir.cabi[f.a[i]];
      /* `setjmp` / `longjmp` 在这一层截住，不进 libc 那张表：它们要的是**帧**，
       * 而那张表里的函数只认实参（整段理由见 `LongJmp` 那一节）。 */
      if (SETJMP_NAMES.has(entry)) {
        const args = rdArgs(f.b[i]);
        /* `setjmp` 的回值类型是 C 的 `int`，也就是 i32 —— 而 i32 现在是 number
         * （第三刀）。这一格从前写死 `0n`，换表示之后那就是「一个 BigInt 落进 i32 的位置」，
         * 后面第一条把它存进内存的指令当场炸（tests/c/sys/04-setjmp 抓到的就是这个）。 */
        const zero = f.t[i] === T_I32 ? 0 : 0n;
        return (F) => {
          /* 记的是 `F.up` —— 外部符号是经桩函数调的，`F` 是桩自己的帧，
           * 一返回就没了；要回去的是 C 那边的调用者，落点是它那条 CALL。 */
          const up = F.up;
          jmpTargets.set(args[0](F), { f: up, pc: up.pc });
          F.v[i] = zero;
          return next;
        };
      }
      if (LONGJMP_NAMES.has(entry)) {
        const args = rdArgs(f.b[i]);
        /* `val` 的类型也是 C 的 `int`（i32 -> number，第三刀），所以那条
         * 「0 换成 1」要在**同一种表示**上判，不然 setjmp 那边收到的是另一种数。 */
        const refs = f.argsOf(f.b[i]);
        const num = refs.length > 1 ? this.refT(f, refs[1]) === T_I32 : true;
        return (F) => {
          const rec = jmpTargets.get(args[0](F));
          if (rec === undefined) failRt('longjmp: 这个 jmp_buf 没有被 setjmp 装过');
          /* C11 7.13.2.1：`val` 是 0 的话 `setjmp` 那边回 1。 */
          if (num) {
            const v = args.length > 1 ? Number(args[1](F)) : 0;
            throw new LongJmp(rec.f, rec.pc, v === 0 ? 1 : v);
          }
          const v = args.length > 1 ? args[1](F) : 0n;
          throw new LongJmp(rec.f, rec.pc, v === 0n ? 1n : v);
        };
      }
      /* C 的 libc 走宿主提供的那一份（`interp/libc.js`）：它认得线性内存，所以指针
       * 实参在它手里有意义 —— 与 wasm 那边「宿主模块 + 一块共享内存」是同一个结构。
       * 其余的 C_ABI 入口**照旧拒绝**：那些是 ADR-0014 的封闭表，每条签名各不相同，
       * 而解释执行是 oracle，它不该假装能做 FFI（eval.js 的 CCall 分支同一个立场）。 */
      if (hasLibc(entry)) {
        /* **libc 的边界要换一次口径**（第三刀）：那一份收发的整数一律 BigInt
         * （它是照着「方言只有 i64 一格整数」写的），而 i32 现在是 number。
         * 装/卸都在这儿，一次也不上推 —— 「语义只有一份」比「少一次 BigInt」重要，
         * 而 libc 调用不在内层循环里。转换**编在读取器里**，运行期不再判类型。 */
        const refs = f.argsOf(f.b[i]);
        const args = refs.map((r) => {
          const g = rd(r);
          if (this.refT(f, r) !== T_I32) return g;
          return (F) => BigInt(g(F));
        });
        const retI32 = f.t[i] === T_I32;
        return (F) => {
          const vals = readAll(args, F);
          try {
            const r = callLibc(entry, vals);
            F.v[i] = retI32 ? Number(BigInt.asIntN(32, BigInt(r))) : r;
          } catch (e) {
            /* `exit` 抛的信号要原样穿过去：它不是「程序错了」，而是程序要求的退出码。
             * `longjmp`（从 libc 回调进去的那种，比如比较器里报错）同理。 */
            if (e instanceof ExitCall || e instanceof LongJmp) throw e;
            failRt(`${entry}: ${e instanceof Error ? e.message : String(e)}`);
          }
          return next;
        };
      }
      return () => {
        failRt(`interp: C ABI call '${entry}' is not supported by the interpreter`);
        return next;
      };
    }
    throw new OmniError(`mir.interp: 还没有处理的指令 ${OP_NAMES[op]}`);
  }
}

/* op 号 -> binOp/cmpOp 收的那个运算符字符串。
 * 用 Map 而不是普通对象：键是**数字**（opcode），而封闭 ABI 里普通对象就是
 * `dict<string, dynamic>`，数字键在 node 上会被悄悄转成 "12"、在原生构建里是另一回事
 * （ADR-0011 决策 2 那类分叉）。Map 的键带标签，两边一致。 */
const BIN_STR = new Map([
  [OP.ADD, '+'], [OP.SUB, '-'], [OP.MUL, '*'], [OP.DIV, '/'], [OP.MOD, '%'],
  [OP.SHL, '<<'], [OP.SHR, '>>'], [OP.BAND, '&'], [OP.BOR, '|'], [OP.BXOR, '^'],
  // 无符号那三个（第六十一刀）：binOp 那边收的就是这三个字符串
  [OP.UDIV, 'u/'], [OP.UMOD, 'u%'], [OP.USHR, 'u>>'],
]);

const CMP_STR = new Map([
  [OP.EQ, '=='], [OP.NE, '!='], [OP.LT, '<'], [OP.LE, '<='], [OP.GT, '>'], [OP.GE, '>='],
  [OP.ULT, 'u<'], [OP.ULE, 'u<='], [OP.UGT, 'u>'], [OP.UGE, 'u>='],
]);

/**
 * `CALLOP` 的 op 号 -> 一个「像 OIR 节点」的描述符。
 *
 * MIR 的 op 名字是单态的（`len.list`），而 `applyBuiltin` 读的是 `recvType` / `argType`；
 * 回来的路上分不出当初是哪一个，所以**两个都填** —— 每条 op 只会读其中一个，填两个是安全的。
 * 描述符只造一次，`applyBuiltin` 的负缓存就挂在它上面。
 */
function opDescriptor(entry) {
  const dot = entry.name.indexOf('.');
  const base = dot < 0 ? entry.name : entry.name.slice(0, dot);
  const desc = { name: base };
  if (dot >= 0) {
    const k = { k: entry.name.slice(dot + 1) };
    desc.recvType = k;
    desc.argType = k;
  }
  const abi = JS_ALL[base];
  const litNames = abi === undefined ? [] : abi.lit ?? [];
  let i = 0;
  while (i < litNames.length) { desc[litNames[i]] = entry.lits[i]; i++; }
  return desc;
}

/**
 * 解释执行一个 OIR 模块 —— 但走 MIR 那条路：降级 -> 良构检查 -> 闭包编译 -> 跑。
 * 错误的收法与 OIR 解释器逐条相同（同样的前缀、同样的退出码 70，ADR-0005）。
 * @param {any} oir OIR 模块
 */
export function interpretMir(oir) {
  const mir = lowerToMir(oir);
  const errs = verifyMir(mir);
  if (errs.length > 0) throw new OmniError(`mir is not well-formed:\n  ${errs.join('\n  ')}`);
  return runMirModule(oir, mir);
}

/**
 * 已经有 MIR 在手上时的入口（ADR-0017 第一刀）：`tests/mir` 的单元用例直接造 MIR，
 * 不经过任何前端 —— i32/f32 现在还没有前端能产出，而它们的语义必须在两条腿上钉住。
 * verify 由调用方负责（那条轴自己要单独报"良构"这一项）。
 */
export function runMirModule(oir, mir) {
  const I = new MirInterp(oir, mir);
  /* libc 回头调 MIR 的那扇门（第八刀第五片，`qsort` 的比较器就走这儿）。
   * 装在这一层的理由：函数指针值的编码（函数号 + 1）是 MIR 的事，libc 不该认得它。 */
  setFnPtrCaller((ptr, args) => {
    const no = fnPtrNo(ptr);
    if (no < 0) failRt('call of a null function pointer');
    if (I.mir.funcs[no] === undefined) failRt(`function pointer index ${no} out of range`);
    /* libc 手里的整数一律 BigInt，而被调函数的 i32 形参要的是 number（第三刀）——
     * 按**被调者的签名**装/卸一次。回值同理：i32 回去要变回 BigInt，不然 libc 那边
     * 拿它去算会当场抛（BigInt 与 number 不能混着做算术）。 */
    const ps = I.mir.funcs[no].params;
    const as = [];
    let k = 0;
    while (k < args.length) {
      const v = args[k];
      const wantI32 = ps[k] !== undefined && ps[k].t === T_I32;
      as.push(wantI32 && typeof v === 'bigint' ? Number(BigInt.asIntN(32, v)) : v);
      k++;
    }
    const r = I.callFunc(no, undefined, as);
    return I.mir.funcs[no].ret === T_I32 && typeof r === 'number' ? BigInt(r) : r;
  });
  let code = 0;
  try {
    code = I.run();
  } catch (e) {
    /* `exit(n)`：stdout 照样要刷出去（C 的 `exit` 也是先冲 stdio 再退），退出码就是 n。 */
    if (e instanceof ExitCall) {
      libcAtExit();
      flushOut();
      return e.code;
    }
    if (e instanceof InterpFail) {
      stderr(`omni: runtime error: ${e.message}\n`);
      return 70;
    }
    if (e instanceof InterpUncaught) {
      stderr(`omni: uncaught: ${e.message}\n`);
      return 70;
    }
    /* 没人接的 `longjmp`：装它的那一帧早就返回了（C11 7.13.2.1 说这是未定义行为）。
     * 这一条明说，而不是让一个陌生的宿主异常飘出去。 */
    if (e instanceof LongJmp) {
      stderr('omni: runtime error: longjmp: 装这个 jmp_buf 的那一帧已经返回了\n');
      return 70;
    }
    throw e;
  }
  /* 从 `main` 返回等价于 `exit`（C11 5.1.2.2.3），所以这一条路上也要收摊：
   * 还开着的文件流落盘（第八刀第十片），然后冲 stdout。 */
  libcAtExit();
  flushOut();
  return code;
}

/** `m[k] = v` 的 dict 一支。写成函数是为了和 listSet 在调用点对称。 */
function setDict(m, k, v) {
  m.set(k, v);
  return v;
}
