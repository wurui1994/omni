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
import { stderr, wrapFn, callFnValue } from '../host/native.js';
import {
  applyBuiltin, zeroOf, newInstance, flushOut, failRt, jsCallFn,
  InterpFail, InterpUncaught, binOp, cmpOp, vecBinOp, bufNew, bufGet, bufSet,
  arrNew, arrLen, arrGet, arrSet, arrPush, arrPop, listGet, listSet, dictGet, dynTag, W,
  ptrNew, ptrChk, ptrTChk, ptrLoad, ptrStore, ptrAdd, ptrSub,
} from '../interp/builtin.js';
import { JS_ALL } from '../hir/js_abi.js';
import { lowerToMir } from './from_oir.js';
import { verifyMir } from './verify.js';
import {
  OP, OP_NAMES, REF_NONE, REF_BIAS, isConstRef, typeKind, typeLanes,
  T_I64, T_F64, T_STR, T_DYN, T_TPTR, CVT_I2F, CVT_BOX,
} from './ir.js';

/** 常量池条目 -> 宿主值。int 是 BigInt（ADR-0005 的 i64），real 是 number。 */
function constVal(c) {
  if (c.kind === 'int') return BigInt(c.text);
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
  let i = 0;
  while (i < f.count()) { endOf.push(-1); elseOf.push(-1); brTarget.push(-1); i++; }
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
    i++;
  }
  return { endOf, elseOf, brTarget };
}

/** MIR 的类型码 -> OIR 那套 kind 字符串（binOp/cmpOp 收的是后者）。 */
function kindOf(t) {
  if (t === T_I64) return 'int';
  if (t === T_F64) return 'real';
  if (t === T_STR) return 'string';
  if (t === T_DYN) return 'dynamic';
  return 'other';
}

/** 缺席实参的零值。这里只有类型码，所以按码给 —— 真正带类型的零值走 zeroOf。 */
function zeroOfCode(t) {
  if (t === T_I64) return 0n;
  if (t === T_F64) return 0;
  if (t === T_STR) return '';
  return null;
}

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
  }

  run() {
    const no = this.mir.funcIndex.get(this.mir.entry);
    if (no === undefined) throw new OmniError(`mir.interp: no entry function '${this.mir.entry}'`);
    this.callFunc(no, undefined, []);
    return 0;
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
    const F = { v: [], s: [], captures, ret: undefined };
    let i = 0;
    while (i < f.slots.length) { F.s.push(i < args.length ? args[i] : zeroOfCode(f.slots[i].t)); i++; }
    // 值窗口要**先铺满**：封闭 ABI 里 list 的下标写入必须落在长度之内（越界在原生构建里
    // 是运行期错误，不是自动扩张）。代价是每次调用一次线性初始化 —— oracle 路径认这个代价。
    i = 0;
    while (i < f.count()) { F.v.push(undefined); i++; }
    let pc = 0;
    const n = prog.length;
    while (pc >= 0 && pc < n) pc = prog[pc](F);
    const out = F.ret;
    this.depth = this.depth - 1;
    return out;
  }

  /**
   * 把一个函数编成一串闭包，一条指令一个。每个闭包收帧、返回**下一个 pc**；
   * -1 表示返回。所有能在装载期算掉的东西都在这里算掉并被闭包捕获住。
   */
  compile(no) {
    const f = this.mir.funcs[no];
    const I = this;
    const { endOf, elseOf, brTarget } = resolveRegions(f);
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
      prog.push(this.step(f, i, rd, rdArgs, readAll, endOf, elseOf, brTarget, I));
      i++;
    }
    return prog;
  }

  /** 一条指令 -> 一个闭包。控制流与槽位这一半。 */
  step(f, i, rd, rdArgs, readAll, endOf, elseOf, brTarget, I) {
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
      const l = rd(f.a[i]);
      const r = rd(f.b[i]);
      // 向量：宿主表示是一条长度 = 宽度的数组，逐道走 **同一份** binOp（vecBinOp 就在
      // interp/builtin.js 里，OIR 解释器用的也是它）—— 两个解释器不会在道上分叉。
      if (typeLanes(t) > 1) {
        const vt = { lanes: typeLanes(t), elem: { k: kindOf(typeKind(t)) } };
        return (F) => { F.v[i] = vecBinOp(o, vt, l(F), r(F)); return next; };
      }
      return (F) => { F.v[i] = binOp(o, kind, l(F), r(F)); return next; };
    }
    if (CMP_STR.has(op)) {
      const o = CMP_STR.get(op);
      const l = rd(f.a[i]);
      const r = rd(f.b[i]);
      // dynamic 的相等：标签相同**且**值相同（ADR-0006）。`t` 是操作数类型，所以这里
      // 认得出来 —— 结果类型是 bool，看它就分不出这一支了。
      if (t === T_DYN) {
        const isEq = op === OP.EQ;
        return (F) => {
          const av = l(F);
          const bv = r(F);
          const eq = dynTag(av) === dynTag(bv) && av === bv;
          F.v[i] = isEq ? eq : !eq;
          return next;
        };
      }
      return (F) => { F.v[i] = cmpOp(o, l(F), r(F)); return next; };
    }
    switch (op) {
      case OP.NEG: {
        const v = rd(f.a[i]);
        // 一元负号也会溢出：-INT64_MIN == INT64_MIN，必须回绕
        if (t === T_I64) return (F) => { F.v[i] = W(-v(F)); return next; };
        return (F) => { F.v[i] = -v(F); return next; };
      }
      case OP.BNOT: {
        const v = rd(f.a[i]);
        return (F) => { F.v[i] = W(~v(F)); return next; };
      }
      case OP.NOT: {
        const v = rd(f.a[i]);
        return (F) => { F.v[i] = !v(F); return next; };
      }
      case OP.CVT: {
        const v = rd(f.a[i]);
        if (x === CVT_I2F) return (F) => { F.v[i] = Number(v(F)); return next; };
        // 装箱是恒等：dynamic 就是原生值（ADR-0006 第 2 节）。C 后端那边它是打标签，
        // 所以指令留着 —— 「哪里发生装箱」是后端要知道的事实。
        if (x === CVT_BOX) return (F) => { F.v[i] = v(F); return next; };
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
        const kind = kindOf(t) === 'other' ? 'bool' : kindOf(t);
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
        const kind = kindOf(t) === 'other' ? 'bool' : kindOf(t);
        const thin = this.ptrIsThin(f, f.a[i]);
        return (F) => {
          const q = p(F);
          F.v[i] = ptrStore(kind, thin ? ptrTChk(q) : ptrChk(q, x), v(F));
          return next;
        };
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
        return (F) => { F.v[i] = I.callFunc(no, undefined, readAll(args, F)); return next; };
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
      return (F) => {
        // 捕获在这里**按值拷进记录**（ADR-0010）：不靠宿主的词法作用域，那是按引用捕获的，
        // 循环里造的闭包会在两个后端给出不同答案。
        const caps = new Map();
        let k = 0;
        while (k < names.length) { caps.set(names[k], args[k](F)); k++; }
        // wrapFn：解释器造的函数值必须**就是**这一代的闭包记录，宿主库那些回调 op
        // （xs.map(f)）拿到它才能直接调（ADR-0013 决策 3）。JS 域的函数体只有一个形参，
        // 绑的是整条实参表，所以那一支要再包一层。
        F.v[i] = isJs
          ? wrapFn((self, callArgs) => I.callFunc(bodyNo, caps, [callArgs]))
          : wrapFn((self, callArgs) => I.callFunc(bodyNo, caps, callArgs));
        return next;
      };
    }
    if (op === OP.CCALL) {
      // 和 OIR 解释器同一个立场（eval.js 的 CCall 分支）：解释执行是 oracle，
      // 它不该假装能做 FFI —— C_ABI 每条 op 的签名各不相同，按名字查一张函数指针表过不去。
      const entry = this.mir.cabi[f.a[i]];
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
]);

const CMP_STR = new Map([
  [OP.EQ, '=='], [OP.NE, '!='], [OP.LT, '<'], [OP.LE, '<='], [OP.GT, '>'], [OP.GE, '>='],
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
  const I = new MirInterp(oir, mir);
  try {
    I.run();
  } catch (e) {
    if (e instanceof InterpFail) {
      stderr(`omni: runtime error: ${e.message}\n`);
      return 70;
    }
    if (e instanceof InterpUncaught) {
      stderr(`omni: uncaught: ${e.message}\n`);
      return 70;
    }
    throw e;
  }
  flushOut();
  return 0;
}

/** `m[k] = v` 的 dict 一支。写成函数是为了和 listSet 在调用点对称。 */
function setDict(m, k, v) {
  m.set(k, v);
  return v;
}
