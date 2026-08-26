/**
 * MIR -> SPIR-V（汇编文本形式）。ADR-0014 门槛 7 的第一阶段。
 *
 * 为什么发**汇编文本**而不是二进制字：和 LLVM 那条腿同一个理由 —— 这一层真正的工作量
 * 在降级（缓冲变描述符、槽位变 Function 变量、结构化控制流变 merge 块），跟"谁来打包字"
 * 无关。文本让这部分能单独写、单独读、单独用 `spirv-as` + `spirv-val` 校验，
 * 而那两个是官方工具：它们接受了就说明字是对的，不必自己再实现一遍二进制布局。
 *
 * **一个 kernel 一个模块**。SPIR-V 允许一个模块多个 OpEntryPoint，但每个入口有自己的
 * 接口与描述符布局，合在一起只会让「这份模块对应哪次 dispatch」变模糊 ——
 * 而 Vulkan 那边一个 pipeline 就是一个入口。
 *
 * 映射（都是 GPU 那边本来就有的东西，不发明新概念）：
 *   - `buf<T>` 形参 -> 一个 StorageBuffer 描述符（set 0，binding 按形参序），
 *     类型是 `OpTypeStruct { OpTypeRuntimeArray T }`，带 Block 与 ArrayStride 装饰。
 *   - 标量形参 -> push constant 块里的一个成员（按形参序，每个 8 字节）。
 *   - `(gid)` -> `GlobalInvocationId` 的第 0 个分量，零扩展成 i64。
 *   - 槽位 -> Function 存储类的 OpVariable；**缓冲形参没有槽变量**，它的"值"就是描述符。
 *   - `blen` -> `OpArrayLength`，所以长度不必另传一个 uniform。
 *   - IF/ELSE/END -> OpSelectionMerge + 显式 merge 块。MIR 把结构化控制流留到后端才拆，
 *     正是为了这一步（决策 6 的第 2 条）。
 *   - BLOCK{LOOP{…}} -> OpLoopMerge + merge 块 + continue 目标。SPIR-V 那两条硬规矩
 *     （回边只许从 continue 出发、跳出构造只许跳它的 merge）决定了这个映射的形状，
 *     见 insn 里 LOOP 那一支的注释。
 *
 * **刻意不支持**（一律报错，不给近似答案）：
 *   - 整数 `/` `%`：CPU 那几条腿要在除零时报错、`INT64_MIN / -1` 要特判，而设备上
 *     没有报错这条路径。给个"差不多"的答案就等于让门槛 7 变成摆设。
 *   - `bnew`：设备上没有 arena，缓冲是宿主分配好再绑上来的。
 *   - print / 字符串 / dyn / 容器 / 调用 / 闭包 / 向量：kernel 里都还没有。
 *   - 越界检查：约定是 kernel 自己用 `blen` 守门（见 ADR-0014 门槛 7 的落地小节）。
 */

import { OmniError } from '../source/diag.js';
import {
  OP, OP_NAMES, REF_NONE, REF_BIAS, isConstRef, typeText, typeLanes,
  T_VOID, T_I64, T_F64, T_BOOL, T_BUF, CVT_I2F, CVT_F2I, CVT_NAMES,
} from '../mir/ir.js';

/** 这一层的边界提示。和 LLVM 那条腿一样收成常量：测试轴按它判「拒得对不对」。 */
export const SPIRV_NOPE = 'spirv 后端目前不支持';

/** 工作组大小。第一阶段固定：网格与工作组怎么分是宿主那侧的调度，不属于这份模块。 */
const LOCAL_SIZE = 64;

/** 比较：MIR 的六条连号 -> 整数/浮点各自的 opcode。浮点那列与 LLVM 那条腿一一对应。 */
const ICMP_OPS = new Map([
  [OP.EQ, 'OpIEqual'], [OP.NE, 'OpINotEqual'], [OP.LT, 'OpSLessThan'],
  [OP.GE, 'OpSGreaterThanEqual'], [OP.LE, 'OpSLessThanEqual'], [OP.GT, 'OpSGreaterThan'],
]);
const FCMP_OPS = new Map([
  [OP.EQ, 'OpFOrdEqual'], [OP.NE, 'OpFUnordNotEqual'], [OP.LT, 'OpFOrdLessThan'],
  [OP.GE, 'OpFOrdGreaterThanEqual'], [OP.LE, 'OpFOrdLessThanEqual'], [OP.GT, 'OpFOrdGreaterThan'],
]);
const BIN_OPS = new Map([
  [OP.ADD, ['OpIAdd', 'OpFAdd']],
  [OP.SUB, ['OpISub', 'OpFSub']],
  [OP.MUL, ['OpIMul', 'OpFMul']],
  [OP.DIV, [null, 'OpFDiv']],
  [OP.MOD, [null, 'OpFRem']],
  [OP.BAND, ['OpBitwiseAnd', null]],
  [OP.BOR, ['OpBitwiseOr', null]],
  [OP.BXOR, ['OpBitwiseXor', null]],
]);

/** MIR 类型码 -> id 后缀。缓冲的元素类型也用这套后缀（`%rta_f64` 等）。 */
const SUFFIX = new Map([[T_VOID, 'void'], [T_I64, 'i64'], [T_F64, 'f64'], [T_BOOL, 'bool'], [T_BUF, 'buf']]);

class SpirvEmitter {
  constructor(mir, f) {
    this.mir = mir;
    this.f = f;
    // 四个输出段。SPIR-V 的模块布局是有次序的（能力 -> 内存模型 -> 入口 -> 调试名 ->
    // 装饰 -> 类型/常量/全局 -> 函数），而「用到了什么」是发函数体时才知道的，
    // 所以分段收集、最后拼。这也是「能力」那几行能按实际用量发的原因。
    this.names = [];
    this.decor = [];
    this.decls = [];
    this.body = [];
    this.ids = new Map();      // 类型/全局的 id 备忘（键就是 id 名）
    this.konsts = new Map();   // `类型|文本` -> %k<n>
    this.bufOfSlot = new Map();  // 槽号 -> 缓冲变量 id（缓冲形参没有 Function 变量）
    this.elemOfSlot = new Map(); // 槽号 -> 缓冲的元素类型码（见 prescanElems）
    this.idOf = new Map();       // 指令下标 -> id（默认 %v<下标>，缓冲与 BSET 是别名）
    this.needF64 = false;
    this.tmp = 0;
    this.labels = 0;
    this.regions = [];
    this.live = false;
  }

  nope(what) {
    throw new OmniError(`${SPIRV_NOPE} ${what}（kernel ${this.f.name}）`);
  }

  line(s) { this.body.push(s); }

  /**
   * 类型/常量/全局的登记。`make` 里可以再登记依赖 —— 依赖的行会先进 decls，
   * 于是「先声明后使用」自动成立，不必单独排一遍拓扑序。
   */
  id(key, make) {
    const hit = this.ids.get(key);
    if (hit !== undefined) return hit;
    const name = `%${key}`;
    const line = make(name);
    this.ids.set(key, name);
    this.decls.push(line);
    return name;
  }

  /* ------------------------------------------------------------------ 类型 */

  /** MIR 类型码 -> SPIR-V 类型 id。向量与表外类型一律报错（第一阶段边界）。 */
  ty(t, what) {
    if (typeLanes(t) > 1) this.nope(`向量（${typeText(t)}：${what}）`);
    if (t === T_VOID) return this.id('void', (n) => `${n} = OpTypeVoid`);
    if (t === T_I64) return this.id('i64', (n) => `${n} = OpTypeInt 64 1`);
    if (t === T_F64) { this.needF64 = true; return this.id('f64', (n) => `${n} = OpTypeFloat 64`); }
    if (t === T_BOOL) return this.id('bool', (n) => `${n} = OpTypeBool`);
    this.nope(`${typeText(t)}：${what}`);
    return null;
  }

  /** 32 位无符号：内建变量的分量、访问链的下标、OpArrayLength 的结果都是它。 */
  u32() { return this.id('u32', (n) => `${n} = OpTypeInt 32 0`); }

  suffix(t, what) {
    const s = SUFFIX.get(t);
    if (s === undefined) this.nope(`${typeText(t)}：${what}`);
    return s;
  }

  /** `GlobalInvocationId`。装饰随变量一起登记，所以两处不会走散。 */
  gidVar() {
    return this.id('gid', (n) => {
      const v3 = this.id('v3u32', (m) => `${m} = OpTypeVector ${this.u32()} 3`);
      const p = this.id('ptr_in_v3u32', (m) => `${m} = OpTypePointer Input ${v3}`);
      this.decor.push(`OpDecorate ${n} BuiltIn GlobalInvocationId`);
      this.names.push(`OpName ${n} "gl_GlobalInvocationID"`);
      return `${n} = OpVariable ${p} Input`;
    });
  }

  /**
   * 一个缓冲形参的描述符：`OpTypeStruct { OpTypeRuntimeArray T }` + StorageBuffer 变量。
   *
   * 这个形状不是随手挑的：`OpArrayLength` 只能作用在「结构体最后一个成员是运行期数组」上，
   * 而 `blen` 要 O(1) —— 于是长度不必另传一个 uniform，宿主绑多长就是多长。
   * 与 CPU 那边的 `{长度, 指针}` 是同一件事的两种表示（ADR-0014 门槛 7）。
   */
  bufVar(binding, elemT, what) {
    const s = this.bufElemSuffix(elemT, what);
    const el = this.ty(elemT, what);
    const rta = this.id(`rta_${s}`, (n) => {
      this.decor.push(`OpDecorate ${n} ArrayStride 8`);
      return `${n} = OpTypeRuntimeArray ${el}`;
    });
    const st = this.id(`sbuf_${s}`, (n) => {
      this.decor.push(`OpMemberDecorate ${n} 0 Offset 0`);
      this.decor.push(`OpDecorate ${n} Block`);
      return `${n} = OpTypeStruct ${rta}`;
    });
    const pst = this.id(`ptr_sb_sbuf_${s}`, (n) => `${n} = OpTypePointer StorageBuffer ${st}`);
    return this.id(`buf${binding}`, (n) => {
      this.decor.push(`OpDecorate ${n} DescriptorSet 0`);
      this.decor.push(`OpDecorate ${n} Binding ${binding}`);
      return `${n} = OpVariable ${pst} StorageBuffer`;
    });
  }

  /** 指向缓冲元素的指针类型（访问链的结果类型）。 */
  bufElemPtr(elemT, what) {
    const s = this.bufElemSuffix(elemT, what);
    const el = this.ty(elemT, what);
    return this.id(`ptr_sb_${s}`, (n) => `${n} = OpTypePointer StorageBuffer ${el}`);
  }

  /**
   * 缓冲的元素类型只许 int / real —— 和 LLVM 那条腿的 noteBufElem 同一条边界。
   * 这里拦的是 `ArrayStride 8` 这个装饰：它是**算好的**（i64 与 f64 都是 8 字节），
   * 不是通用的。哪天缓冲能装别的元素，这一行会先红，而不是发出一份步长错了的模块。
   */
  bufElemSuffix(t, what) {
    if (t !== T_I64 && t !== T_F64) this.nope(`${typeText(t)} 的缓冲（${what}）`);
    return this.suffix(t, what);
  }

  /* ------------------------------------------------------------------ 常量 */

  /** 常量池：按 (类型, 文本) 去重，id 按首次用到的顺序编号 —— 同一份输入两次发出来逐字相同。 */
  konst(t, text) {
    const key = `${t}|${text}`;
    const hit = this.konsts.get(key);
    if (hit !== undefined) return hit;
    const name = `%k${this.konsts.size}`;
    const ty = this.ty(t, '常量');
    let line;
    if (t === T_BOOL) line = `${name} = ${text === 'true' ? 'OpConstantTrue' : 'OpConstantFalse'} ${ty}`;
    else line = `${name} = OpConstant ${ty} ${t === T_F64 ? spvFloat(text, this) : text}`;
    this.konsts.set(key, name);
    this.decls.push(line);
    return name;
  }

  /** 无符号 32 位字面量（成员号与下标）。走同一个池，所以也只发一次。 */
  u32c(v) {
    const key = `u32|${v}`;
    const hit = this.konsts.get(key);
    if (hit !== undefined) return hit;
    const name = `%k${this.konsts.size}`;
    this.konsts.set(key, name);
    this.decls.push(`${name} = OpConstant ${this.u32()} ${v}`);
    return name;
  }

  /* -------------------------------------------------------------- 值与类型 */

  val(ref) {
    if (ref === REF_NONE) this.nope('少了一个操作数');
    if (isConstRef(ref)) {
      const c = this.mir.consts.get(ref);
      return this.konst(c.t, c.text);
    }
    const i = ref - REF_BIAS;
    const hit = this.idOf.get(i);
    return hit === undefined ? `%v${i}` : hit;
  }

  tyOf(ref) {
    if (isConstRef(ref)) return this.mir.consts.get(ref).t;
    const i = this.f.at(ref);
    const op = this.f.op[i];
    return op >= OP.EQ && op <= OP.GT ? T_BOOL : this.f.t[i];
  }

  fresh() { const n = this.tmp; this.tmp++; return `%t${n}`; }
  label(tag) { const n = this.labels; this.labels++; return `%${tag}${n}`; }

  startBlock(name) { this.line(`${name} = OpLabel`); this.live = true; }

  /** 终结子。之后的指令属于不可达块 —— 落一个新标签（spirv-val 接受不可达块）。 */
  term(s) {
    if (this.live) this.line(`  ${s}`);
    this.live = false;
  }

  ensureBlock() { if (!this.live) this.startBlock(this.label('dead')); }

  /* ------------------------------------------------------------------ 模块 */

  emit() {
    const f = this.f;
    if (f.ret !== T_VOID) this.nope(`有返回值的 kernel（${typeText(f.ret)}）`);
    if (f.closureId !== undefined) this.nope('闭包');
    // 形参分两类：缓冲进描述符，标量进 push constant。第一个形参必须是隐含的 gid ——
    // 那是 sexpr 前端登记 kernel 时插进去的（sexpr/lower.js 的 `$gid`），
    // 这里不是"约定"，是**检查**：对不上就说清，而不是把某个形参当成 gid。
    if (f.params.length === 0 || f.params[0].name !== '$gid' || f.params[0].t !== T_I64) {
      this.nope('第一个形参不是隐含的 $gid（这份 MIR 不像是 kernel）');
    }
    const pcMembers = [];   // [{slot, t}]，push constant 的成员按形参序
    let binding = 0;
    let k = 1;
    this.elemOfSlot = this.prescanElems();
    while (k < f.params.length) {
      const p = f.params[k];
      // 形参就是前几个槽（from_oir 里 declare(p.name) 就是这么排的）；这里核对一遍
      if (k >= f.slots.length || f.slots[k].t !== p.t) {
        this.nope(`形参 ${p.name} 与槽位对不上（MIR 形状变了）`);
      }
      if (p.t === T_BUF) {
        this.bufOfSlot.set(k, this.bufVar(binding, this.bufElemOf(k), `形参 ${p.name}`));
        binding++;
      } else if (p.t === T_I64 || p.t === T_F64) {
        pcMembers.push({ slot: k, t: p.t });
      } else {
        this.nope(`${typeText(p.t)} 形参（${p.name}）`);
      }
      k++;
    }
    const pc = pcMembers.length === 0 ? null : this.pcVar(pcMembers);

    // ---- 函数体。先发，因为「用到了哪些类型/常量」是发的过程中才知道的。
    this.line(`%main = OpFunction ${this.ty(T_VOID, '返回值')} None `
      + `${this.id('fn_void', (n) => `${n} = OpTypeFunction ${this.ty(T_VOID, '函数类型')}`)}`);
    this.startBlock('%entry');
    // Function 存储类的变量必须全在入口块的最前面（SPIR-V 的硬要求），所以槽位先发。
    // 缓冲槽没有变量：它的"值"就是描述符，见 LOAD 那一支。
    let s = 0;
    while (s < f.slots.length) {
      if (!this.bufOfSlot.has(s)) {
        const st = f.slots[s].t;
        if (st === T_BUF) this.nope(`局部缓冲变量（槽位 ${f.slots[s].name}）`);
        const ps = this.suffix(st, `槽位 ${f.slots[s].name}`);
        const pt = this.id(`ptr_fn_${ps}`, (n) => `${n} = OpTypePointer Function ${this.ty(st, '槽位')}`);
        this.line(`  %s${s} = OpVariable ${pt} Function`);
      }
      s++;
    }
    this.initGid();
    let mi = 0;
    for (const m of pcMembers) { this.initFromPc(pc, m, mi); mi++; }
    let i = 0;
    while (i < f.count()) { this.insn(i); i++; }
    this.term('OpReturn');
    this.line('OpFunctionEnd');
    return this.assemble();
  }

  /* ------------------------------------------------- 缓冲形参的元素类型
   * `T_BUF` 里刻意没有元素类型（mir/ir.js:57 的注释：LLVM 的指针早就是不透明的）。
   * CPU 那几条腿不需要它 —— 步长与零值只在 BNEW/BGET/BSET 上出现，那些指令的 `t` 说了。
   * 可是描述符必须在函数体之前声明，所以这条腿得先扫一遍：谁读写了哪个槽。
   * 一个从没被读写过的缓冲形参因此发不出来 —— 那不是「支持不了」，是**信息不在 MIR 里**，
   * 与其猜一个 f64 发出去，不如说清。
   */
  prescanElems() {
    const f = this.f;
    const out = new Map();
    let i = 0;
    while (i < f.count()) {
      const op = f.op[i];
      if (op === OP.BGET || op === OP.BSET) {
        const sl = this.slotOfLoad(f.a[i]);
        if (sl === null) this.nope(`不是直接来自形参的缓冲（${OP_NAMES[op]}）`);
        const prev = out.get(sl);
        if (prev !== undefined && prev !== f.t[i]) {
          this.nope(`槽位 ${f.slots[sl].name} 被当成两种元素类型用`);
        }
        out.set(sl, f.t[i]);
      }
      i++;
    }
    return out;
  }

  /** ref 是不是「某个槽的 LOAD」？是就给槽号。缓冲在这一层只能这么用。 */
  slotOfLoad(ref) {
    if (ref === REF_NONE || isConstRef(ref)) return null;
    const i = this.f.at(ref);
    return this.f.op[i] === OP.LOAD ? this.f.aux[i] : null;
  }

  bufElemOf(slot) {
    const e = this.elemOfSlot.get(slot);
    if (e === undefined) {
      this.nope(`缓冲形参 ${this.f.slots[slot].name} 的元素类型定不下来`
        + '（这个 kernel 从没读写过它，而 MIR 的 buf 类型码不带元素类型）');
    }
    return e;
  }

  /* ------------------------------------------------------------ push constant
   * 标量形参进一个 push constant 块，每个成员 8 字节（i64 与 f64 都是 8，
   * 所以偏移就是序号乘 8 —— 不必查对齐表）。bool 不进来：OpTypeBool 没有物理布局，
   * 这也是上面把 bool 形参拒掉的理由。
   */
  pcVar(members) {
    const tys = members.map((m) => this.ty(m.t, 'push constant 成员'));
    const st = this.id('pc_ty', (n) => {
      let i = 0;
      while (i < members.length) { this.decor.push(`OpMemberDecorate ${n} ${i} Offset ${i * 8}`); i++; }
      this.decor.push(`OpDecorate ${n} Block`);
      return `${n} = OpTypeStruct ${tys.join(' ')}`;
    });
    const pt = this.id('ptr_pc_pc_ty', (n) => `${n} = OpTypePointer PushConstant ${st}`);
    return this.id('pc', (n) => {
      this.names.push(`OpName ${n} "omni_args"`);
      return `${n} = OpVariable ${pt} PushConstant`;
    });
  }

  /** `(gid)` -> GlobalInvocationId 的第 0 个分量，零扩展成 i64，存进 0 号槽。 */
  initGid() {
    const v3 = this.id('v3u32', (m) => `${m} = OpTypeVector ${this.u32()} 3`);
    const g = this.fresh();
    const x = this.fresh();
    const w = this.fresh();
    this.line(`  ${g} = OpLoad ${v3} ${this.gidVar()}`);
    this.line(`  ${x} = OpCompositeExtract ${this.u32()} ${g} 0`);
    this.line(`  ${w} = OpSConvert ${this.ty(T_I64, 'gid')} ${x}`);
    this.line(`  OpStore %s0 ${w}`);
  }

  /** 标量形参的槽在入口处从 push constant 里灌进去 —— 之后它和别的槽没有区别。 */
  initFromPc(pc, m, index) {
    const s = this.suffix(m.t, 'push constant 成员');
    const pt = this.id(`ptr_pc_${s}`, (n) => `${n} = OpTypePointer PushConstant ${this.ty(m.t, '成员')}`);
    const p = this.fresh();
    const v = this.fresh();
    this.line(`  ${p} = OpAccessChain ${pt} ${pc} ${this.u32c(index)}`);
    this.line(`  ${v} = OpLoad ${this.ty(m.t, '成员')} ${p}`);
    this.line(`  OpStore %s${m.slot} ${v}`);
  }

  /* ------------------------------------------------------------- 拼成模块
   * 次序是 SPIR-V 的硬要求（能力 -> 内存模型 -> 入口 -> 执行模式 -> 调试名 ->
   * 装饰 -> 类型/常量/全局 -> 函数）。能力按实际用量发：Float64 只在真用到 f64 时出现，
   * 多发一条在某些设备上就是「这份模块跑不了」。
   */
  assemble() {
    const out = [];
    out.push('; SPIR-V');
    out.push(`; Omni stage0 — MIR -> SPIR-V（ADR-0014 门槛 7）：kernel ${this.f.name}`);
    out.push('OpCapability Shader');
    out.push('OpCapability Int64');
    if (this.needF64) out.push('OpCapability Float64');
    out.push('OpMemoryModel Logical GLSL450');
    out.push(`OpEntryPoint GLCompute %main "${this.f.name}" ${this.ids.get('gid')}`);
    out.push(`OpExecutionMode %main LocalSize ${LOCAL_SIZE} 1 1`);
    out.push(`OpName %main "${this.f.name}"`);
    for (const n of this.names) out.push(n);
    for (const d of this.decor) out.push(d);
    for (const d of this.decls) out.push(d);
    for (const b of this.body) out.push(b);
    return out.join('\n') + '\n';
  }

  /* ---------------------------------------------------------------- 一条指令 */

  insn(i) {
    const f = this.f;
    const op = f.op[i];
    if (!this.live && op !== OP.END && op !== OP.ELSE) this.ensureBlock();
    const dst = `%v${i}`;
    const t = f.t[i];

    if (op === OP.IF) {
      const then = this.label('then');
      const els = this.label('else');
      const end = this.label('ifend');
      // OpSelectionMerge 必须**紧接着** OpBranchConditional（或 OpSwitch）——
      // 这是 SPIR-V 结构化控制流的硬规则，也是 BLOCK 那条标记不能借用它的原因。
      this.line(`  OpSelectionMerge ${end} None`);
      this.term(`OpBranchConditional ${this.val(f.a[i])} ${then} ${els}`);
      this.startBlock(then);
      this.regions.push({ kind: 'if', end: end, els: els, seenElse: false,
        head: null, cont: null, at: this.body.length, loaned: false });
      return;
    }
    if (op === OP.ELSE) {
      const r = this.regions[this.regions.length - 1];
      this.term(`OpBranch ${r.end}`);
      this.startBlock(r.els);
      r.seenElse = true;
      return;
    }
    if (op === OP.END) {
      const r = this.regions.pop();
      if (r === undefined) this.nope('END 多了一条（MIR 形状不对）');
      if (r.kind === 'loop') {
        // 体的最后一条边进 continue 块，continue 块里那一条 OpBranch 才是回边
        this.term(`OpBranch ${r.cont}`);
        this.startBlock(r.cont);
        this.term(`OpBranch ${r.head}`);
        this.startBlock(r.end);
        return;
      }
      if (r.kind === 'block') {
        // 标签借给循环当 merge 块了的话，此刻就已经在那个块里，什么都不用发
        if (r.loaned) return;
        this.term(`OpBranch ${r.end}`);
        this.startBlock(r.end);
        return;
      }
      this.term(`OpBranch ${r.end}`);
      // 没有 ELSE 的 IF：假分支也得有个块，直接跳汇合点（与 LLVM 那条腿同一处理）
      if (!r.seenElse) { this.startBlock(r.els); this.term(`OpBranch ${r.end}`); }
      this.startBlock(r.end);
      return;
    }
    if (op === OP.RET) {
      if (f.a[i] !== REF_NONE) this.nope('带值的 return');
      this.term('OpReturn');
      return;
    }
    // ---- 循环。MIR 里 `while` 的形状是 BLOCK{ LOOP{ BRIF ^1 跳出; 体; BR ^0 回头 } }
    // （wasm 的层数语义，见 mir/ir.js 的 op 表），SPIR-V 要的是 OpLoopMerge 同时给
    // **merge 块与 continue 目标**，而且规矩很硬：
    //   - 回边只许从 continue 目标出发 —— 所以 `BR 到 LOOP` 发的是「跳 continue」，
    //     不是「跳循环头」。continue 块里那一条 OpBranch 才是回边。
    //   - 跳出一个构造只许跳到它的 merge 块 —— 所以外层 BLOCK 的出口标签必须**就是**
    //     这个循环的 merge 块，否则 `BRIF ^1`（break）就是一条非法的跨构造跳转。
    //     于是 LOOP 见到「自己是刚开的 BLOCK 里第一条东西」时，直接借用那个标签。
    if (op === OP.BLOCK) {
      this.regions.push({ kind: 'block', end: this.label('bend'), els: null, seenElse: false,
        head: null, cont: null, at: this.body.length, loaned: false });
      return;
    }
    if (op === OP.LOOP) {
      const top = this.regions[this.regions.length - 1];
      const wrap = top !== undefined && top.kind === 'block' && top.at === this.body.length;
      const merge = wrap ? top.end : this.label('lend');
      if (wrap) top.loaned = true;
      const head = this.label('lhead');
      const body = this.label('lbody');
      const cont = this.label('lcont');
      this.term(`OpBranch ${head}`);
      this.startBlock(head);
      this.line(`  OpLoopMerge ${merge} ${cont} None`);
      this.term(`OpBranch ${body}`);
      this.startBlock(body);
      this.regions.push({ kind: 'loop', end: merge, els: null, seenElse: false,
        head: head, cont: cont, at: this.body.length, loaned: false });
      return;
    }
    if (op === OP.BR || op === OP.BRIF) {
      const r = this.regions[this.regions.length - 1 - f.aux[i]];
      if (r === undefined) this.nope(`${OP_NAMES[op]} 的层数越界`);
      // 跳到 LOOP = continue（回边由 continue 块负责）；跳到 BLOCK/IF = 跳它的汇合点
      if (r.kind === 'block' && !r.loaned) {
        this.nope('跳到一个不是循环出口的 BLOCK —— SPIR-V 里跳出构造只能跳它的 merge 块');
      }
      const target = r.kind === 'loop' ? r.cont : r.end;
      if (op === OP.BR) { this.term(`OpBranch ${target}`); return; }
      const next = this.label('brnext');
      this.term(`OpBranchConditional ${this.val(f.a[i])} ${target} ${next}`);
      this.startBlock(next);
      return;
    }
    this.dataInsn(i, op, dst, t);
  }

  /* ------------------------------------------------ 数据指令（不改控制流） */

  dataInsn(i, op, dst, t) {
    const f = this.f;
    const isF = t === T_F64;
    if (op === OP.LOAD) {
      // 缓冲槽没有变量：装载它就是"拿到那个描述符"。于是 BGET/BSET 的 `a` 落到
      // 这个 id 上，OpAccessChain 直接用 —— SPIR-V 里没有能传递的指针值，
      // 所以这一步不是优化，是唯一能表达的形状。
      const bv = this.bufOfSlot.get(f.aux[i]);
      if (bv !== undefined) { this.idOf.set(i, bv); return; }
      this.line(`  ${dst} = OpLoad ${this.ty(t, '槽位')} %s${f.aux[i]}`);
      return;
    }
    if (op === OP.STORE) {
      if (this.bufOfSlot.has(f.aux[i])) this.nope(`给缓冲形参重新赋值（槽位 ${f.slots[f.aux[i]].name}）`);
      this.line(`  OpStore %s${f.aux[i]} ${this.val(f.a[i])}`);
      return;
    }
    if (op === OP.BLEN || op === OP.BGET || op === OP.BSET) { this.bufInsn(i, op, dst, t); return; }
    if (op === OP.BNEW) this.nope('bnew —— 设备上没有 arena，缓冲由宿主分配后绑上来');

    if (BIN_OPS.has(op)) {
      const pair = BIN_OPS.get(op);
      const name = isF ? pair[1] : pair[0];
      // null = 这个类型上没有语义相同的一条指令。整数 `/` `%` 就在这里：CPU 那几条腿
      // 要在除零时报错、INT64_MIN/-1 要特判，而设备上没有报错这条路径。
      if (name === null) {
        this.nope(`${typeText(t)} 上的 ${OP_NAMES[op]}`
          + (op === OP.DIV || op === OP.MOD ? '（除零与 INT64_MIN/-1 在设备上没有报错的去处）' : ''));
      }
      this.line(`  ${dst} = ${name} ${this.ty(t, OP_NAMES[op])} ${this.val(f.a[i])} ${this.val(f.b[i])}`);
      return;
    }
    if (op === OP.NEG) {
      this.line(`  ${dst} = ${isF ? 'OpFNegate' : 'OpSNegate'} ${this.ty(t, 'neg')} ${this.val(f.a[i])}`);
      return;
    }
    if (op === OP.BNOT) { this.line(`  ${dst} = OpNot ${this.ty(t, 'bnot')} ${this.val(f.a[i])}`); return; }
    if (op === OP.NOT) { this.line(`  ${dst} = OpLogicalNot ${this.ty(T_BOOL, 'not')} ${this.val(f.a[i])}`); return; }
    if (op === OP.SHL || op === OP.SHR) {
      // 移位量先 `& 63`，与 omni.h 的 `b & 63` 逐条对应：SPIR-V 里移过位宽是未定义的
      const m = this.fresh();
      const i64 = this.ty(T_I64, 'shift');
      this.line(`  ${m} = OpBitwiseAnd ${i64} ${this.val(f.b[i])} ${this.konst(T_I64, '63')}`);
      this.line(`  ${dst} = ${op === OP.SHL ? 'OpShiftLeftLogical' : 'OpShiftRightArithmetic'} `
        + `${i64} ${this.val(f.a[i])} ${m}`);
      return;
    }
    if (op >= OP.EQ && op <= OP.GT) {
      const bt = this.ty(T_BOOL, 'compare');
      if (t === T_BOOL) {
        // bool 不是整数类型，OpIEqual 在它上面不合法
        if (op !== OP.EQ && op !== OP.NE) this.nope(`bool 上的 ${OP_NAMES[op]}`);
        const name = op === OP.EQ ? 'OpLogicalEqual' : 'OpLogicalNotEqual';
        this.line(`  ${dst} = ${name} ${bt} ${this.val(f.a[i])} ${this.val(f.b[i])}`);
        return;
      }
      if (t !== T_I64 && t !== T_F64) this.nope(`${typeText(t)} 的比较`);
      const name = isF ? FCMP_OPS.get(op) : ICMP_OPS.get(op);
      this.line(`  ${dst} = ${name} ${bt} ${this.val(f.a[i])} ${this.val(f.b[i])}`);
      return;
    }
    if (op === OP.CVT) {
      if (f.aux[i] === CVT_I2F) {
        this.line(`  ${dst} = OpConvertSToF ${this.ty(T_F64, 'i2f')} ${this.val(f.a[i])}`);
        return;
      }
      if (f.aux[i] === CVT_F2I) {
        this.line(`  ${dst} = OpConvertFToS ${this.ty(T_I64, 'f2i')} ${this.val(f.a[i])}`);
        return;
      }
      this.nope(`CVT ${CVT_NAMES[f.aux[i]]}`);
    }
    this.nope(OP_NAMES[op]);
  }

  /**
   * 缓冲三条。`blen` 是 `OpArrayLength`（32 位无符号，再扩到 i64）——
   * 长度因此不必另传一个 uniform，宿主绑多长就是多长。
   *
   * 下标要截成 32 位（`OpSConvert`）：访问链的下标在驱动那边就是 32 位的。
   * **没有越界检查** —— 约定是 kernel 自己用 `blen` 守门（ADR-0014 门槛 7），
   * 而这个约定在 CPU 那几条腿上也成立，所以两边跑的是同一份判断，不是两套语义。
   */
  bufInsn(i, op, dst, t) {
    const f = this.f;
    const buf = this.val(f.a[i]);
    if (op === OP.BLEN) {
      const n = this.fresh();
      this.line(`  ${n} = OpArrayLength ${this.u32()} ${buf} 0`);
      this.line(`  ${dst} = OpSConvert ${this.ty(T_I64, 'blen')} ${n}`);
      return;
    }
    const idxRef = op === OP.BGET ? f.b[i] : f.argsOf(f.b[i])[0];
    const el = this.ty(t, '缓冲元素');
    const pt = this.bufElemPtr(t, '缓冲元素');
    const x = this.fresh();
    const p = this.fresh();
    this.line(`  ${x} = OpSConvert ${this.u32()} ${this.val(idxRef)}`);
    this.line(`  ${p} = OpAccessChain ${pt} ${buf} ${this.u32c(0)} ${x}`);
    if (op === OP.BGET) { this.line(`  ${dst} = OpLoad ${el} ${p}`); return; }
    const v = this.val(f.argsOf(f.b[i])[1]);
    this.line(`  OpStore ${p} ${v}`);
    // BSET 在 MIR 里"产出"被写进去的那个值（`t` 是元素类型）。这里不必再算一次 ——
    // 结果就是那个值本身，于是这条指令的 id 是个别名。
    this.idOf.set(i, v);
  }
}

/**
 * f64 字面量。`spirv-as` 用 strtod 读它，是正确舍入的，所以 17 位有效数字能精确往返
 * （与 LLVM 那条腿的 llFloat、C 那条腿的 cReal 同一条理由）。
 *
 * 非有限值刻意报错：SPIR-V 汇编要写成原始字（`!0x...`），而设备上的 inf/nan 行为
 * 还要看 `SignedZeroInfNanPreserve` 那些执行模式 —— 没验过的东西不发。
 */
function spvFloat(text, em) {
  const v = Number(text);
  if (!Number.isFinite(v)) em.nope(`非有限的 real 常量（${text}）`);
  const s = v.toPrecision(17);
  return s.includes('.') || s.includes('e') || s.includes('E') ? s : `${s}.0`;
}

/** 这份 MIR 里带 kernel 标注的函数名（MIR 名，即前端 mangle 过的那个）。 */
export function kernelNames(mir) {
  const out = [];
  for (const f of mir.funcs) if (f.kernel === true) out.push(f.name);
  return out;
}

/**
 * 一个 kernel -> 一份 SPIR-V 汇编。名字可以给 MIR 名（`k_saxpy`）或方言里的名字（`saxpy`）。
 * 不给名字时：恰好一个 kernel 就发它，多个就报错让调用方指明 —— 一个模块一个入口
 * （见文件头），所以"全都发"不是一个有意义的选项。
 */
export function emitSpirv(mir, kernelName) {
  const names = kernelNames(mir);
  if (names.length === 0) {
    throw new OmniError(`${SPIRV_NOPE} 没有 kernel 的模块`
      + '（GPU 那条腿要的是 (kernel ...)，普通函数与 main 不在它的支持面里）');
  }
  let pick = null;
  if (kernelName === undefined || kernelName === null) {
    if (names.length > 1) {
      throw new OmniError(`这份模块有 ${names.length} 个 kernel（${names.join(' ')}），`
        + '用 --kernel NAME 指定一个：一份 SPIR-V 模块只有一个入口');
    }
    pick = names[0];
  } else {
    for (const n of names) if (n === kernelName || n === `k_${kernelName}`) pick = n;
    if (pick === null) {
      throw new OmniError(`没有这个 kernel：${kernelName}（有的是 ${names.join(' ')}）`);
    }
  }
  for (const f of mir.funcs) if (f.name === pick) return new SpirvEmitter(mir, f).emit();
  return null;
}
