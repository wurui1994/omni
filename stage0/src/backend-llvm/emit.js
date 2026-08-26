/**
 * MIR -> LLVM IR（文本形式）。ADR-0014 决策 3 的第一步。
 *
 * 为什么先出**文本** IR 而不是直接调 C API 建模块：
 *
 *   - 这一层真正的工作量在**降级**（类型映射、槽位变 alloca、结构化控制流拆成基本块），
 *     跟用哪个 API 无关。文本形式让这部分能单独写、单独用快照测、单独用 `llvm-as` 校验。
 *   - JIT 那一步不需要重写它：ORC 那边用 `LLVMParseIRInContext` 读同一份文本就行，
 *     于是 AOT 与 JIT 共用一个发射器，而不是「C API 版」和「文本版」两份语义。
 *     这一条同时省掉几百个 IRBuilder 的 extern-C 声明。
 *
 * 第一阶段的边界（**报错而不是给错答案**，与 WAT 前端同一条规矩）：只认标量
 * i64 / f64 / bool / void。字符串、dyn、聚合、容器、闭包都在 MIR 里，但它们的语义
 * 依赖 C 运行时里按模块生成的类型，那是下一步的事。
 *
 * 语义对齐的两处硬约束：
 *   - i64 的加减乘取负按**无符号回绕**（omni.h:325..330 的 omni_add 一族），LLVM 的
 *     `add`/`mul` 不带 nsw 就正好是回绕，所以直接发指令。
 *   - `/` `%` `<<` `>>` 在运行时是 `static inline`（omni.h:329..343），**不是可链接符号**，
 *     所以不能 call —— 这里把它们的语义原地展开（移位量 `& 63`，除零报错，
 *     INT64_MIN / -1 特判）。少一条就是一个只在边角上出现的答案分叉。
 */

import { OmniError } from '../source/diag.js';
import {
  OP, OP_NAMES, REF_NONE, REF_BIAS, isConstRef, typeText,
  T_VOID, T_I64, T_F64, T_BOOL, CVT_I2F, CVT_F2I,
} from '../mir/ir.js';

/** MIR 的类型码 -> LLVM 类型名。表外的一律报错（第一阶段边界）。 */
const LL_TYPES = new Map([[T_VOID, 'void'], [T_I64, 'i64'], [T_F64, 'double'], [T_BOOL, 'i1']]);

/**
 * 支持的运行时 op：单态名字 -> 可链接的 C 符号与签名。
 * 只列**真符号**（omni.h 里声明为函数的那些）；`static inline` 的不能出现在这里。
 */
const RT_OPS = new Map([
  ['print.int', { sym: 'omni_print_int', ret: 'void', params: ['i64'] }],
  ['print.real', { sym: 'omni_print_real', ret: 'void', params: ['double'] }],
  ['print.bool', { sym: 'omni_print_bool', ret: 'void', params: ['i1 zeroext'] }],
  ['trunc', { sym: 'omni_trunc', ret: 'i64', params: ['double'] }],
  // 同一件事的两个名字：WAT 前端发的是 `trunc`，Omni 前端按接收者单态化成 `trunc.real`
  ['trunc.real', { sym: 'omni_trunc', ret: 'i64', params: ['double'] }],
]);

/** i64 比较 -> icmp 谓词；f64 -> fcmp 谓词。顺序与 OP.EQ..OP.GT 一致。 */
const ICMP = new Map([[OP.EQ, 'eq'], [OP.NE, 'ne'], [OP.LT, 'slt'], [OP.GE, 'sge'], [OP.LE, 'sle'], [OP.GT, 'sgt']]);
const FCMP = new Map([[OP.EQ, 'oeq'], [OP.NE, 'une'], [OP.LT, 'olt'], [OP.GE, 'oge'], [OP.LE, 'ole'], [OP.GT, 'ogt']]);

class LlvmEmitter {
  constructor(mir) {
    this.mir = mir;
    this.out = [];
    this.needDiv = false;   // 除法/取模的辅助函数只在用到时才发
    this.needMod = false;
    this.f = null;          // 当前函数
    this.tmp = 0;           // 临时值编号（%t0…），与 %v<i> 分开，不会撞
    this.labels = 0;
    this.regions = [];      // 结构化控制流的区域栈，层数语义与 wasm 相同
    this.live = false;      // 当前基本块还没被终结子关掉
  }

  line(s) { this.out.push(s); }

  /** 类型码 -> LLVM 类型。表外的报错，带上函数名与类型名 —— 边界要说得清。 */
  ty(t, what) {
    const s = LL_TYPES.get(t);
    if (s === undefined) {
      throw new OmniError(`llvm 后端第一阶段只支持 i64/f64/bool/void：${what} 是 ${typeText(t)}`
        + `（函数 ${this.f === null ? '?' : this.f.name}）`);
    }
    return s;
  }

  /** 这条指令**结果**的类型（比较的结果是 bool，`t` 上放的是操作数类型）。 */
  resultTy(f, i) {
    const op = f.op[i];
    return op >= OP.EQ && op <= OP.GT ? T_BOOL : f.t[i];
  }

  fresh() { const n = this.tmp; this.tmp++; return `%t${n}`; }
  label(tag) { const n = this.labels; this.labels++; return `${tag}${n}`; }

  /* --------------------------------------------------------------- 值与常量 */

  /** ref -> LLVM 里的写法。常量内联，指令是 `%v<下标>`。 */
  val(ref) {
    if (ref === REF_NONE) throw new OmniError(`llvm: 少了一个操作数（函数 ${this.f.name}）`);
    if (!isConstRef(ref)) return `%v${ref - REF_BIAS}`;
    const c = this.mir.consts.get(ref);
    if (c.t === T_I64) return c.text;
    if (c.t === T_BOOL) return c.text === 'true' ? 'true' : 'false';
    if (c.t === T_F64) return llFloat(c.text);
    throw new OmniError(`llvm 后端第一阶段不支持 ${typeText(c.t)} 常量（${c.text}）`);
  }

  /** ref 的类型码。 */
  tyOf(ref) {
    if (isConstRef(ref)) return this.mir.consts.get(ref).t;
    return this.resultTy(this.f, this.f.at(ref));
  }

  /** `<类型> <值>`，call/store 那些地方要的形式。 */
  typed(ref) { return `${this.ty(this.tyOf(ref), 'operand')} ${this.val(ref)}`; }

  /* --------------------------------------------------------------- 基本块 */

  startBlock(name) {
    this.line(`${name}:`);
    this.live = true;
  }

  /** 发一条终结子。之后开一个新块 —— MIR 里 BR/RET 后面还可能跟着不可达的指令。 */
  term(s) {
    if (this.live) this.line(`  ${s}`);
    this.live = false;
  }

  /** 终结子之后要继续发指令时，先落一个新标签，否则 IR 不合法。 */
  ensureBlock() {
    if (!this.live) this.startBlock(this.label('dead'));
  }

  /* ------------------------------------------------------------------ 模块 */

  emit() {
    this.line('; Omni stage0 — MIR -> LLVM IR（ADR-0014 决策 3）');
    this.line('');
    for (const op of usedRtOps(this.mir)) {
      const d = RT_OPS.get(op);
      this.line(`declare ${d.ret} @${d.sym}(${d.params.join(', ')})`);
    }
    this.line('declare void @omni_host_init(i32, ptr)');
    this.line('declare i32 @omni_host_exit_code()');
    this.line('declare void @omni_js_check_uncaught()');
    this.line('declare i32 @fflush(ptr)');
    this.line('');

    for (const f of this.mir.funcs) this.func(f);

    if (this.needDiv) this.line(DIV_HELPER);
    if (this.needMod) this.line(MOD_HELPER);
    if (this.needDiv || this.needMod) {
      this.line('declare void @omni_error(ptr)');
      this.line('@.omni_divzero = private unnamed_addr constant [17 x i8] c"division by zero\\00"');
      this.line('');
    }

    // main 与 C 后端那一行逐句对应（backend-c/emit.js:152）：argc/argv 要存下来，
    // 退出码是 omni_host_exit_code 里的槽，不是 omni_main 的返回值。
    this.line('define i32 @main(i32 %argc, ptr %argv) {');
    this.line('entry:');
    this.line('  call void @omni_host_init(i32 %argc, ptr %argv)');
    this.line(`  call void @${this.mir.entry}()`);
    this.line('  call void @omni_js_check_uncaught()');
    this.line('  %fl = call i32 @fflush(ptr null)');
    this.line('  %code = call i32 @omni_host_exit_code()');
    this.line('  ret i32 %code');
    this.line('}');
    return this.out.join('\n') + '\n';
  }

  /* ------------------------------------------------------------------ 函数 */

  func(f) {
    this.f = f;
    this.tmp = 0;
    this.labels = 0;
    this.regions = [];
    if (f.closureId !== undefined) {
      throw new OmniError(`llvm 后端第一阶段不支持闭包（函数 ${f.name}）`);
    }
    const ps = f.params.map((p, i) => `${this.ty(p.t, `参数 ${p.name}`)} %a${i}`);
    this.line(`define ${this.ty(f.ret, '返回值')} @${f.name}(${ps.join(', ')}) {`);
    this.startBlock('entry');
    // 槽位一律 alloca：MIR 不做 mem2reg，那是 LLVM 的活（ADR-0014 决策 6 的三处偏离之一）
    let s = 0;
    while (s < f.slots.length) {
      this.line(`  %s${s} = alloca ${this.ty(f.slots[s].t, `槽位 ${f.slots[s].name}`)}`);
      s++;
    }
    // 形参占前几个槽（from_oir 里 declare(p.name) 就是这么排的），入口处存进去
    let p = 0;
    while (p < f.params.length) {
      const t = this.ty(f.params[p].t, 'param');
      this.line(`  store ${t} %a${p}, ptr %s${p}`);
      p++;
    }
    let i = 0;
    while (i < f.count()) { this.insn(f, i); i++; }
    // 掉出函数体：void 就 ret void，有返回值的补一个零值 —— 让它确定，而不是随机
    if (this.live) {
      const rt = this.ty(f.ret, '返回值');
      this.term(rt === 'void' ? 'ret void' : `ret ${rt} ${rt === 'double' ? '0.0' : '0'}`);
    }
    this.line('}');
    this.line('');
  }

  /* ---------------------------------------------------------------- 一条指令 */

  insn(f, i) {
    const op = f.op[i];
    // 终结子之后的指令在 MIR 里是可达性上的死码（`BR` 后面还跟着 END 之类），
    // 但 IR 要求每条指令都在某个块里 —— 补一个标签，让 LLVM 自己删。
    if (!this.live && op !== OP.END && op !== OP.ELSE) this.ensureBlock();
    const dst = `%v${i}`;
    const t = f.t[i];

    if (op === OP.BLOCK) { this.regions.push({ kind: 'block', end: this.label('bend'), head: null, els: null, seenElse: false }); return; }
    if (op === OP.LOOP) {
      const head = this.label('lhead');
      this.term(`br label %${head}`);
      this.startBlock(head);
      this.regions.push({ kind: 'loop', end: this.label('lend'), head: head, els: null, seenElse: false });
      return;
    }
    if (op === OP.IF) {
      const then = this.label('then');
      const els = this.label('else');
      const end = this.label('ifend');
      this.term(`br i1 ${this.val(f.a[i])}, label %${then}, label %${els}`);
      this.startBlock(then);
      this.regions.push({ kind: 'if', end: end, head: null, els: els, seenElse: false });
      return;
    }
    if (op === OP.ELSE) {
      const r = this.regions[this.regions.length - 1];
      this.term(`br label %${r.end}`);
      this.startBlock(r.els);
      r.seenElse = true;
      return;
    }
    if (op === OP.END) {
      const r = this.regions.pop();
      this.term(`br label %${r.end}`);
      // 没有 ELSE 的 IF：else 那一支还是要有个块，直接跳到汇合点
      if (r.kind === 'if' && !r.seenElse) { this.startBlock(r.els); this.term(`br label %${r.end}`); }
      this.startBlock(r.end);
      return;
    }
    if (op === OP.BR || op === OP.BRIF) {
      const r = this.regions[this.regions.length - 1 - f.aux[i]];
      if (r === undefined) throw new OmniError(`llvm: BR 的层数越界（函数 ${f.name}）`);
      // wasm 的层数语义：跳到 LOOP 是回循环头，跳到 BLOCK/IF 是跳到它的汇合点
      const target = r.kind === 'loop' ? r.head : r.end;
      if (op === OP.BR) { this.term(`br label %${target}`); return; }
      const next = this.label('brnext');
      this.term(`br i1 ${this.val(f.a[i])}, label %${target}, label %${next}`);
      this.startBlock(next);
      return;
    }
    if (op === OP.RET) {
      if (f.a[i] === REF_NONE) this.term('ret void');
      else this.term(`ret ${this.typed(f.a[i])}`);
      return;
    }
    this.dataInsn(f, i, op, dst, t);
  }

  /* -------------------------------------------------- 数据指令（不改控制流） */

  dataInsn(f, i, op, dst, t) {
    const isF = t === T_F64;
    if (op === OP.LOAD) {
      this.line(`  ${dst} = load ${this.ty(t, 'slot')}, ptr %s${f.aux[i]}`);
      return;
    }
    if (op === OP.STORE) {
      const st = this.ty(f.slots[f.aux[i]].t, 'slot');
      this.line(`  store ${st} ${this.val(f.a[i])}, ptr %s${f.aux[i]}`);
      return;
    }
    if (BIN_LL.has(op)) {
      const kind = BIN_LL.get(op);
      const ll = isF ? kind[1] : kind[0];
      // null = 这个类型上没有一条指令能直接用（i64 的 `/` `%`），交给下面的分支
      if (ll !== null) {
        this.line(`  ${dst} = ${ll} ${this.ty(t, OP_NAMES[op])} ${this.val(f.a[i])}, ${this.val(f.b[i])}`);
        return;
      }
    }
    // `/` `%` 走辅助函数：除零要报错、INT64_MIN/-1 要特判，与 omni.h:332..343 逐条对应
    if (op === OP.DIV && !isF) {
      this.needDiv = true;
      this.line(`  ${dst} = call i64 @omni_ll_div(i64 ${this.val(f.a[i])}, i64 ${this.val(f.b[i])})`);
      return;
    }
    if (op === OP.MOD && !isF) {
      this.needMod = true;
      this.line(`  ${dst} = call i64 @omni_ll_mod(i64 ${this.val(f.a[i])}, i64 ${this.val(f.b[i])})`);
      return;
    }
    // 移位量先 `& 63`：C 那边是 `b & 63`，而 LLVM 里移过位宽是 poison
    if (op === OP.SHL || op === OP.SHR) {
      const m = this.fresh();
      this.line(`  ${m} = and i64 ${this.val(f.b[i])}, 63`);
      this.line(`  ${dst} = ${op === OP.SHL ? 'shl' : 'ashr'} i64 ${this.val(f.a[i])}, ${m}`);
      return;
    }
    if (op === OP.NEG) {
      if (isF) this.line(`  ${dst} = fneg double ${this.val(f.a[i])}`);
      else this.line(`  ${dst} = sub i64 0, ${this.val(f.a[i])}`);
      return;
    }
    if (op === OP.BNOT) { this.line(`  ${dst} = xor i64 ${this.val(f.a[i])}, -1`); return; }
    if (op === OP.NOT) { this.line(`  ${dst} = xor i1 ${this.val(f.a[i])}, true`); return; }
    if (op >= OP.EQ && op <= OP.GT) {
      const pred = isF ? FCMP.get(op) : ICMP.get(op);
      const cmp = isF ? 'fcmp' : 'icmp';
      this.line(`  ${dst} = ${cmp} ${pred} ${this.ty(t, 'compare')} ${this.val(f.a[i])}, ${this.val(f.b[i])}`);
      return;
    }
    if (op === OP.CVT) {
      if (f.aux[i] === CVT_I2F) { this.line(`  ${dst} = sitofp i64 ${this.val(f.a[i])} to double`); return; }
      if (f.aux[i] === CVT_F2I) { this.line(`  ${dst} = fptosi double ${this.val(f.a[i])} to i64`); return; }
      throw new OmniError(`llvm 后端第一阶段不支持 CVT ${f.aux[i]}（函数 ${f.name}）`);
    }
    if (op === OP.CALL) {
      const g = this.mir.funcs[f.a[i]];
      const args = f.argsOf(f.b[i]).map((r) => this.typed(r));
      const rt = this.ty(g.ret, `${g.name} 的返回值`);
      const call = `call ${rt} @${g.name}(${args.join(', ')})`;
      this.line(rt === 'void' ? `  ${call}` : `  ${dst} = ${call}`);
      return;
    }
    if (op === OP.CALLOP) {
      const entry = this.mir.ops[f.a[i]];
      const d = RT_OPS.get(entry.name);
      if (d === undefined) {
        throw new OmniError(`llvm 后端第一阶段还没有 op '${entry.name}'（函数 ${f.name}）`);
      }
      const refs = f.argsOf(f.b[i]);
      if (refs.length !== d.params.length) {
        throw new OmniError(`llvm: ${entry.name} 要 ${d.params.length} 个实参，实得 ${refs.length}`);
      }
      const args = refs.map((r, k) => `${d.params[k]} ${this.val(r)}`);
      const call = `call ${d.ret} @${d.sym}(${args.join(', ')})`;
      this.line(d.ret === 'void' ? `  ${call}` : `  ${dst} = ${call}`);
      return;
    }
    throw new OmniError(`llvm 后端第一阶段不支持 ${OP_NAMES[op]}（函数 ${f.name}）`);
  }
}

/**
 * 二元指令表：`[i64 用哪条, f64 用哪条]`。null = 这个类型上没有对应指令（要么报错，
 * 要么在 dataInsn 里单独处理，比如 i64 的 `/` `%` 要走辅助函数）。
 * 键是数字（opcode），所以是 Map 而不是普通对象 —— 封闭 ABI 里普通对象是 dict<string,dynamic>。
 */
const BIN_LL = new Map([
  [OP.ADD, ['add', 'fadd']],
  [OP.SUB, ['sub', 'fsub']],
  [OP.MUL, ['mul', 'fmul']],
  [OP.DIV, [null, 'fdiv']],
  [OP.MOD, [null, 'frem']],
  [OP.BAND, ['and', null]],
  [OP.BOR, ['or', null]],
  [OP.BXOR, ['xor', null]],
]);

/** 这个模块用到的运行时 op（按名字去重后排序，`declare` 的顺序才是确定的）。 */
function usedRtOps(mir) {
  const seen = new Set();
  for (const f of mir.funcs) {
    let i = 0;
    while (i < f.count()) {
      if (f.op[i] === OP.CALLOP) {
        const nm = mir.ops[f.a[i]].name;
        if (RT_OPS.has(nm)) seen.add(nm);
      }
      i++;
    }
  }
  const out = [];
  for (const x of seen) out.push(x);
  out.sort();
  return out;
}

/**
 * f64 字面量。LLVM 的解析是正确舍入的，所以 17 位有效数字能精确往返
 * （与 C 后端的 cReal 同一条理由）。inf/nan 只能走十六进制形式。
 */
function llFloat(text) {
  const v = Number(text);
  if (Number.isNaN(v)) return '0x7FF8000000000000';
  if (v === Infinity) return '0x7FF0000000000000';
  if (v === -Infinity) return '0xFFF0000000000000';
  const s = v.toPrecision(17);
  return s.includes('.') || s.includes('e') || s.includes('E') ? s : `${s}.0`;
}

/* `/` 与 `%` 的语义（omni.h:332..343）：除零报错，INT64_MIN / -1 不走硬件除法。
 * 发成 IR 里的私有函数而不是在每个调用点展开 —— 调用点少一半行，LLVM 会自己内联。 */
const DIV_HELPER = `define private i64 @omni_ll_div(i64 %a, i64 %b) {
entry:
  %z = icmp eq i64 %b, 0
  br i1 %z, label %err, label %chk
err:
  call void @omni_error(ptr @.omni_divzero)
  unreachable
chk:
  %m1 = icmp eq i64 %b, -1
  %mn = icmp eq i64 %a, -9223372036854775808
  %ov = and i1 %m1, %mn
  br i1 %ov, label %sat, label %ok
sat:
  ret i64 -9223372036854775808
ok:
  %r = sdiv i64 %a, %b
  ret i64 %r
}
`;

const MOD_HELPER = `define private i64 @omni_ll_mod(i64 %a, i64 %b) {
entry:
  %z = icmp eq i64 %b, 0
  br i1 %z, label %err, label %chk
err:
  call void @omni_error(ptr @.omni_divzero)
  unreachable
chk:
  %m1 = icmp eq i64 %b, -1
  %mn = icmp eq i64 %a, -9223372036854775808
  %ov = and i1 %m1, %mn
  br i1 %ov, label %sat, label %ok
sat:
  ret i64 0
ok:
  %r = srem i64 %a, %b
  ret i64 %r
}
`;

/** MIR 模块 -> LLVM IR 文本。 */
export function emitLlvm(mir) {
  return new LlvmEmitter(mir).emit();
}


