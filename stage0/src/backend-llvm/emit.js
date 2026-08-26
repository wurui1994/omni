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
 * 支持面按阶段扩，边界一律**报错而不是给错答案**（与 WAT 前端同一条规矩）：
 *
 *   第一阶段：标量 i64 / f64 / bool / void。
 *   第二阶段：**字符串**。这一步的关键不在代码量，在 ABI —— `omni_str` 是
 *     `{const char *p; int64_t len;}`，16 字节，clang 在 AArch64 上把它降成
 *     `[2 x i64]` 按值传（量出来的，不是猜的：拿一份只声明这些签名的 C 过一遍
 *     `clang -emit-llvm` 看它发什么）。所以这里也必须发 `[2 x i64]`，
 *     一个字节都不能差，否则每一次字符串调用都在悄悄给错答案。
 *   还没做：dyn（24 字节，clang 走**间接传**：入参 `ptr`、返回 `sret`）、
 *     聚合、容器、闭包。它们在 MIR 里都有，缺的是这一层。
 *
 * 语义对齐的硬约束 —— 都源自同一件事：**运行时把热的叶子函数写成 `static inline`，
 * 那不是可链接符号，call 不到**，所以必须在 IR 里原地重建：
 *   - i64 的加减乘取负按无符号回绕（omni.h:325..330），LLVM 不带 nsw 正好是回绕。
 *   - `/` `%` `<<` `>>`（omni.h:329..343）：移位量 `& 63`、除零报错、INT64_MIN / -1 特判。
 *   - 字符串比较（`omni_str_cmp`，omni.h:353..358）：memcmp 前 n 字节，相同则短者在前。
 *     memcmp 本身是真符号，call 得到。
 * 少一条就是一个只在边角上出现的答案分叉，而这类分叉正是多方比对要抓的东西。
 */

import { OmniError } from '../source/diag.js';
import { utf8Bytes } from '../host/utf8.js';
import {
  OP, OP_NAMES, REF_NONE, REF_BIAS, isConstRef, typeText, typeKind, typeLanes,
  T_VOID, T_I64, T_F64, T_BOOL, T_STR, T_BUF, CVT_I2F, CVT_F2I,
} from '../mir/ir.js';

/**
 * MIR 的类型码 -> LLVM 类型名。表外的一律报错（阶段边界）。
 * `[2 x i64]` 不是「一个长度 2 的数组」这种建模选择，是 clang 对 16 字节聚合的
 * 实参降级结果 —— 我们必须跟它一模一样，见文件头。
 */
const LL_TYPES = new Map([
  [T_VOID, 'void'], [T_I64, 'i64'], [T_F64, 'double'], [T_BOOL, 'i1'], [T_STR, '[2 x i64]'],
  // 缓冲：`{长度, 指针}`。这一个不是量出来的 ABI，是**我们自己定的** —— 运行时里没有
  // 任何函数收发缓冲（print 不接受缓冲），所以这条腿只要自洽就够，和 [2 x i64] 那条不同。
  [T_BUF, '{ i64, ptr }'],
]);

/**
 * 支持的运行时 op：单态名字 -> 可链接的 C 符号与签名。
 * 只列**真符号**（omni.h 里声明为函数的那些）；`static inline` 的不能出现在这里。
 */
const RT_OPS = new Map([
  ['print.int', { sym: 'omni_print_int', ret: 'void', params: ['i64'] }],
  ['print.real', { sym: 'omni_print_real', ret: 'void', params: ['double'] }],
  ['print.bool', { sym: 'omni_print_bool', ret: 'void', params: ['i1 zeroext'] }],
  ['print.string', { sym: 'omni_print_string', ret: 'void', params: ['[2 x i64]'] }],
  ['trunc', { sym: 'omni_trunc', ret: 'i64', params: ['double'] }],
  // 同一件事的两个名字：WAT 前端发的是 `trunc`，Omni 前端按接收者单态化成 `trunc.real`
  ['trunc.real', { sym: 'omni_trunc', ret: 'i64', params: ['double'] }],
  // 刻意**没有** str.int / str.real / str.bool 这些转换：它们都是真符号、签名也照
  // `[2 x i64]` 那条规则推得出来，但现在没有一份 case 走得到（核心方言不含类型转换，
  // 而 Omni 那边用到它们的程序都带容器，早在别处就被拒了）。没测过的 ABI 断言
  // 和猜是一回事 —— 等有用例了再加，那时它是被验证的，不是被推断的。
]);

/** i64 比较 -> icmp 谓词；f64 -> fcmp 谓词。顺序与 OP.EQ..OP.GT 一致。 */
const ICMP = new Map([[OP.EQ, 'eq'], [OP.NE, 'ne'], [OP.LT, 'slt'], [OP.GE, 'sge'], [OP.LE, 'sle'], [OP.GT, 'sgt']]);
const FCMP = new Map([[OP.EQ, 'oeq'], [OP.NE, 'une'], [OP.LT, 'olt'], [OP.GE, 'oge'], [OP.LE, 'ole'], [OP.GT, 'ogt']]);

/**
 * 所有「这一层还没做」的报错都带上这句。
 * 它是测试轴上的断言字串（tests/llvm、tests/jit 都按它判「拒得对不对」），
 * 所以是一个常量而不是散在各处的字面量 —— 措辞改了，两条轴不会静默失配。
 */
const NOPE = 'llvm 后端目前不支持';

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
    // 字符串常量的字节池。函数体里遇到才登记，模块末尾统一发 —— LLVM 不要求
    // 全局在使用之前出现，所以不必先扫一遍。键是内容，同一份字面量只发一次。
    this.strs = new Map();
    this.needStrCmp = false;
    this.needStrCat = false;
    // 用到的缓冲元素类型（类型码 -> true）。每种要发一组 new/get/set 的私有函数。
    this.bufElems = new Map();
  }

  line(s) { this.out.push(s); }

  /** 类型码 -> LLVM 类型。表外的报错，带上函数名与类型名 —— 边界要说得清。 */
  ty(t, what) {
    // 向量（ADR-0014 门槛 6）：`<N x 元素>`。宽度在 `t` 的高 3 位上，所以不查表 ——
    // 查表就要为 2/4/8 三种宽度各列一行，而宽度本来就是算得出来的。
    const lanes = typeLanes(t);
    if (lanes > 1) return `<${lanes} x ${this.ty(typeKind(t), what)}>`;
    const s = LL_TYPES.get(t);
    if (s === undefined) {
      throw new OmniError(`${NOPE} ${typeText(t)}：${what}`
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
    if (c.t === T_STR) return this.strConst(c.text);
    throw new OmniError(`${NOPE} ${typeText(c.t)} 常量（${c.text}）`);
  }

  /**
   * 字符串字面量 -> 一个 `[2 x i64]` 的**常量表达式**：{字节的地址, 字节数}。
   *
   * 之所以能内联成常量表达式（而不是在函数入口 alloca 再 store 两次），是因为
   * `ptrtoint` 作用在全局上是合法的常量表达式。于是字符串常量和整数常量在这个
   * 发射器里走同一条路 —— `val()` 的调用者不需要知道类型。
   *
   * 长度是**字节数**（UTF-8），不是字符数：ADR-0005 的 Omni string 就是字节序列。
   * 编码用的是与 C 后端同一份 utf8Bytes（host/utf8.js），落单代理项的处理也因此一致。
   */
  strConst(text) {
    let e = this.strs.get(text);
    if (e === undefined) {
      const bytes = utf8Bytes(text);
      e = { name: `@.omni_s${this.strs.size}`, bytes: bytes };
      this.strs.set(text, e);
    }
    return `[i64 ptrtoint (ptr ${e.name} to i64), i64 ${e.bytes.length}]`;
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
    if (this.needStrCmp) {
      this.line(STRCMP_HELPER);
      this.line('declare i32 @memcmp(ptr, ptr, i64)');
      this.line('');
    }
    if (this.needStrCat) {
      this.line('declare [2 x i64] @omni_str_cat([2 x i64], [2 x i64])');
      this.line('');
    }
    // 缓冲：分配器的快路径 + 每种元素类型的 new/get/set。arena 的两个指针是真符号，
    // 所以这条腿分配到的内存和 C 那条腿在同一个池里（见 ALLOC_HELPER 的注释）。
    if (this.bufElems.size > 0) {
      this.line('declare ptr @omni_alloc_slow(i64)');
      this.line('declare void @omni_errorf(ptr, ...)');
      this.line('@omni_arena_ptr = external global ptr');
      this.line('@omni_arena_end = external global ptr');
      this.line(llCStr('@.omni_boob', 'buffer index out of range: %lld (length %lld)'));
      this.line(llCStr('@.omni_bneg', 'buffer length cannot be negative: %lld'));
      this.line('');
      this.line(ALLOC_HELPER);
      for (const t of this.bufElems.keys()) {
        this.line(t === T_F64 ? bufHelpers('double', 8, '0.0') : bufHelpers('i64', 8, '0'));
      }
    }
    // 字符串字面量的字节。放在最后是因为它们是函数体发到一半才登记的；
    // 顺序按登记顺序，所以同一份输入两次发出来逐字节相同（快照轴要这个）。
    for (const e of this.strs.values()) {
      const bs = e.bytes.map((b) => `i8 ${b}`).join(', ');
      this.line(`${e.name} = private unnamed_addr constant [${e.bytes.length} x i8] [${bs}]`);
    }
    if (this.strs.size > 0) this.line('');

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
      throw new OmniError(`${NOPE} 闭包（函数 ${f.name}）`);
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
    const lanes = typeLanes(t);
    const isF = typeKind(t) === T_F64;
    if (op === OP.LOAD) {
      this.line(`  ${dst} = load ${this.ty(t, 'slot')}, ptr %s${f.aux[i]}`);
      return;
    }
    if (op === OP.STORE) {
      const st = this.ty(f.slots[f.aux[i]].t, 'slot');
      this.line(`  store ${st} ${this.val(f.a[i])}, ptr %s${f.aux[i]}`);
      return;
    }
    // 缓冲四条：三条走私有函数（越界检查带分支，展开会搅乱区域记账），BLEN 就地取字段
    if (op === OP.BNEW || op === OP.BLEN || op === OP.BGET || op === OP.BSET) {
      this.bufInsn(f, i, op, dst, t);
      return;
    }
    // 向量三条 + 向量上的四则运算。分流要在标量表之前：`add <4 x i64>` 是合法的，
    // 但 `/`（整数）和 `& 63` 那些辅助函数是标量签名，落进去会发出对不上的 IR。
    // 条件里刻意**不是**"只要 t 是向量"：返回向量的 CALL、装载向量的 LOAD 的 `t` 也是向量，
    // 而它们的发射方式与元素类型无关，走下面那条通路就对。
    if (op === OP.VSPLAT || op === OP.VINS || op === OP.VEXT
      || (lanes > 1 && (BIN_LL.has(op) || op === OP.NEG))) {
      this.vecInsn(f, i, op, dst, t);
      return;
    }
    // 字符串要**在标量表之前**分流：`t` 是 T_STR 时 isF 为假，落到 BIN_LL 会发出
    // `add [2 x i64]` 这种既不合法又语义全错的东西。先拦住。
    // 只截运算与比较 —— CALL / CALLOP 的 `t` 也可能是 T_STR（返回字符串的函数），
    // 那两条走下面的通路，类型由 ty() 统一映射。
    if (t === T_STR && (op === OP.ADD || (op >= OP.EQ && op <= OP.GT))) {
      this.strInsn(f, i, op, dst);
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
      throw new OmniError(`${NOPE} CVT ${f.aux[i]}（函数 ${f.name}）`);
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
        throw new OmniError(`${NOPE} op '${entry.name}'（函数 ${f.name}）`);
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
    throw new OmniError(`${NOPE} ${OP_NAMES[op]}（函数 ${f.name}）`);
  }

  /* -------------------------------------------------------------- 字符串 */

  /**
   * `t` 是 T_STR 的运算与比较。
   *
   * 拼接是真符号（`omni_str_cat`），直接 call。比较不是 —— `omni_str_cmp` 在
   * omni.h 里是 static inline，所以在 IR 里重建成一个私有函数（见 STRCMP_HELPER），
   * 语义逐句对着那八行抄。相等/不等本可以短路成「长度不同直接 false」，
   * **故意不这么写**：那是另一条语义路径，与 C 那边就不再是同一份代码了，
   * 而这一层的全部风险就在「两条腿在边角上分叉」。
   */
  strInsn(f, i, op, dst) {
    if (op === OP.ADD) {
      this.needStrCat = true;
      this.line(`  ${dst} = call [2 x i64] @omni_str_cat([2 x i64] ${this.val(f.a[i])}, `
        + `[2 x i64] ${this.val(f.b[i])})`);
      return;
    }
    this.needStrCmp = true;
    const c = this.fresh();
    this.line(`  ${c} = call i32 @omni_ll_strcmp([2 x i64] ${this.val(f.a[i])}, `
      + `[2 x i64] ${this.val(f.b[i])})`);
    this.line(`  ${dst} = icmp ${ICMP.get(op)} i32 ${c}, 0`);
  }

  /**
   * 缓冲四条（门槛 7 第一阶段）。`{i64, ptr}` 里第 0 个字段是长度，第 1 个是数据。
   * new/get/set 都调私有函数（见 bufHelpers）：越界检查带分支，而调用点在结构化控制流的
   * 中间，就地展开会把 live/regions 那套记账搅乱。BLEN 没有分支，所以就地取字段。
   */
  bufInsn(f, i, op, dst, t) {
    if (op === OP.BLEN) {
      this.line(`  ${dst} = extractvalue { i64, ptr } ${this.val(f.a[i])}, 0`);
      return;
    }
    // BNEW 的元素类型在 aux 上（结果类型是缓冲本身）；get/set 的元素类型就是 `t`
    const el = op === OP.BNEW ? f.aux[i] : t;
    const s = this.noteBufElem(el);
    if (op === OP.BNEW) {
      this.line(`  ${dst} = call { i64, ptr } @omni_ll_bnew_${s}(i64 ${this.val(f.a[i])})`);
      return;
    }
    const et = this.ty(el, 'buffer element');
    if (op === OP.BGET) {
      this.line(`  ${dst} = call ${et} @omni_ll_bget_${s}({ i64, ptr } ${this.val(f.a[i])}, `
        + `i64 ${this.val(f.b[i])})`);
      return;
    }
    const args = f.argsOf(f.b[i]);
    this.line(`  ${dst} = call ${et} @omni_ll_bset_${s}({ i64, ptr } ${this.val(f.a[i])}, `
      + `i64 ${this.val(args[0])}, ${et} ${this.val(args[1])})`);
  }

  /** 记下用到的元素类型，返回助手名字的后缀。表外的报错 —— 缓冲只装 int/real。 */
  noteBufElem(t) {
    if (t !== T_I64 && t !== T_F64) {
      throw new OmniError(`${NOPE} ${typeText(t)} 的缓冲（函数 ${this.f.name}）`);
    }
    this.bufElems.set(t, true);
    return t === T_F64 ? 'f64' : 'i64';
  }

  /**
   * 向量（ADR-0014 门槛 6 第一阶段）。这条腿走 LLVM 的原生向量类型 `<N x T>`，
   * C 那条腿是标量化 —— 两者必须逐位相同，所以这里只用**逐道语义确定**的指令：
   *
   *   - `+ - *`：`add`/`fadd` 等在向量上就是逐道；i64 不带 nsw，回绕与 C 的 omni_add 一致。
   *   - `/`：f64 直接 `fdiv`（IEEE 逐道，无 fast-math）；**i64 要标量化** ——
   *     除零要报错、INT64_MIN/-1 要特判，那些在 @omni_ll_div 里，而它是标量签名。
   *   - splat：`insertelement` + 全零掩码的 `shufflevector`，clang 发的就是这个形状。
   *   - hsum 不在这里：它在 OIR -> MIR 那步就成了「VEXT + 左到右 ADD 链」，
   *     所以求值顺序是 MIR 的事实，不是这一层的选择（这正是门槛 6 要的）。
   *
   * 刻意**不发** `llvm.vector.reduce.fadd`：那条 intrinsic 的规约顺序由目标决定，
   * 用它就等于把「固定求值顺序」交给后端心情。
   */
  vecInsn(f, i, op, dst, t) {
    const lanes = typeLanes(t);
    const isF = typeKind(t) === T_F64;
    if (op === OP.VSPLAT) {
      const el = this.ty(typeKind(t), 'splat 的元素');
      const vt = this.ty(t, 'splat');
      const one = this.fresh();
      this.line(`  ${one} = insertelement ${vt} poison, ${el} ${this.val(f.a[i])}, i64 0`);
      this.line(`  ${dst} = shufflevector ${vt} ${one}, ${vt} poison, <${lanes} x i32> zeroinitializer`);
      return;
    }
    if (op === OP.VINS) {
      const el = this.ty(typeKind(t), 'insert 的元素');
      this.line(`  ${dst} = insertelement ${this.ty(t, 'insert')} ${this.val(f.a[i])}, `
        + `${el} ${this.val(f.b[i])}, i64 ${f.aux[i]}`);
      return;
    }
    if (op === OP.VEXT) {
      // `t` 是元素类型（结果类型）；被取的向量类型看操作数
      this.line(`  ${dst} = extractelement ${this.typed(f.a[i])}, i64 ${f.aux[i]}`);
      return;
    }
    if (op === OP.DIV && !isF) {
      this.needDiv = true;
      const vt = this.ty(t, 'div');
      let acc = 'poison';
      let k = 0;
      while (k < lanes) {
        const la = this.fresh();
        const lb = this.fresh();
        const q = this.fresh();
        const ins = k + 1 === lanes ? dst : this.fresh();
        this.line(`  ${la} = extractelement ${vt} ${this.val(f.a[i])}, i64 ${k}`);
        this.line(`  ${lb} = extractelement ${vt} ${this.val(f.b[i])}, i64 ${k}`);
        this.line(`  ${q} = call i64 @omni_ll_div(i64 ${la}, i64 ${lb})`);
        this.line(`  ${ins} = insertelement ${vt} ${acc}, i64 ${q}, i64 ${k}`);
        acc = ins;
        k++;
      }
      return;
    }
    if (BIN_LL.has(op)) {
      const kind = BIN_LL.get(op);
      const ll = isF ? kind[1] : kind[0];
      if (ll !== null) {
        this.line(`  ${dst} = ${ll} ${this.ty(t, OP_NAMES[op])} ${this.val(f.a[i])}, ${this.val(f.b[i])}`);
        return;
      }
    }
    if (op === OP.NEG) {
      const vt = this.ty(t, 'neg');
      if (isF) this.line(`  ${dst} = fneg ${vt} ${this.val(f.a[i])}`);
      else this.line(`  ${dst} = sub ${vt} zeroinitializer, ${this.val(f.a[i])}`);
      return;
    }
    throw new OmniError(`${NOPE} 向量上的 ${OP_NAMES[op]}（函数 ${f.name}）`);
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

/* 字符串比较（omni.h:353..358 的 omni_str_cmp，也是 static inline 所以 call 不到）：
 * 前 min(len) 字节走 memcmp，相同则短者在前。memcmp 是真符号。
 * `%lt` 在 entry 里算好，bylen 里再用 —— entry 支配全图，合法。 */
const STRCMP_HELPER = `define private i32 @omni_ll_strcmp([2 x i64] %a, [2 x i64] %b) {
entry:
  %ai = extractvalue [2 x i64] %a, 0
  %an = extractvalue [2 x i64] %a, 1
  %bi = extractvalue [2 x i64] %b, 0
  %bn = extractvalue [2 x i64] %b, 1
  %ap = inttoptr i64 %ai to ptr
  %bp = inttoptr i64 %bi to ptr
  %lt = icmp slt i64 %an, %bn
  %n = select i1 %lt, i64 %an, i64 %bn
  %pos = icmp sgt i64 %n, 0
  br i1 %pos, label %cmp, label %tail
cmp:
  %c = call i32 @memcmp(ptr %ap, ptr %bp, i64 %n)
  %nz = icmp ne i32 %c, 0
  br i1 %nz, label %diff, label %tail
diff:
  ret i32 %c
tail:
  %eq = icmp eq i64 %an, %bn
  br i1 %eq, label %same, label %bylen
same:
  ret i32 0
bylen:
  %s = select i1 %lt, i32 -1, i32 1
  ret i32 %s
}
`;

/** 一个 C 字符串常量（只用于 ASCII 的格式串）。长度算出来，不手数 —— 数错就 IR 不合法。 */
function llCStr(name, text) {
  return `${name} = private unnamed_addr constant [${text.length + 1} x i8] c"${text}\\00"`;
}

/* arena 的 bump 快路径（omni.h:98..103 的 omni_alloc，又一条 static inline，call 不到）。
 * 慢路径 omni_alloc_slow 与两个 arena 指针都是真符号 —— 所以这里重建的是那六行，
 * 不是另换一个分配器：换一个的话缓冲的地址来自别的池，同一个程序里两套内存管理。 */
const ALLOC_HELPER = `define private ptr @omni_ll_alloc(i64 %n) {
entry:
  %cur = load ptr, ptr @omni_arena_ptr
  %ci = ptrtoint ptr %cur to i64
  %a1 = add i64 %ci, 15
  %al = and i64 %a1, -16
  %end = load ptr, ptr @omni_arena_end
  %ei = ptrtoint ptr %end to i64
  %over = icmp ugt i64 %al, %ei
  br i1 %over, label %slow, label %chk
chk:
  %room = sub i64 %ei, %al
  %big = icmp ugt i64 %n, %room
  br i1 %big, label %slow, label %fast
fast:
  %np = add i64 %al, %n
  %p = inttoptr i64 %al to ptr
  %newp = inttoptr i64 %np to ptr
  store ptr %newp, ptr @omni_arena_ptr
  ret ptr %p
slow:
  %r = call ptr @omni_alloc_slow(i64 %n)
  ret ptr %r
}
`;

/**
 * 一种元素类型的缓冲三条：new / get / set。发成私有函数而不是在调用点展开 ——
 * 越界检查带分支，而调用点在结构化控制流里，展开会把 this.live/regions 那套记账搅乱。
 *
 * 越界与负长度的消息走 `omni_errorf`（真符号，变参）：格式串与实参和 C 那条腿**逐字相同**
 * （backend-c 的 bufLines / omni_container.h:50），所以两条腿的 stderr 是同一串字节。
 */
function bufHelpers(elem, sizeOf, zero) {
  const s = elem === 'double' ? 'f64' : 'i64';
  return `define private { i64, ptr } @omni_ll_bnew_${s}(i64 %n) {
entry:
  %neg = icmp slt i64 %n, 0
  br i1 %neg, label %err, label %chk
err:
  call void (ptr, ...) @omni_errorf(ptr @.omni_bneg, i64 %n)
  unreachable
chk:
  %z = icmp eq i64 %n, 0
  br i1 %z, label %empty, label %alloc
empty:
  %e0 = insertvalue { i64, ptr } undef, i64 0, 0
  %e1 = insertvalue { i64, ptr } %e0, ptr null, 1
  ret { i64, ptr } %e1
alloc:
  %bytes = mul i64 %n, ${sizeOf}
  %p = call ptr @omni_ll_alloc(i64 %bytes)
  br label %loop
loop:
  %i = phi i64 [ 0, %alloc ], [ %i1, %body ]
  %done = icmp sge i64 %i, %n
  br i1 %done, label %fin, label %body
body:
  %sl = getelementptr ${elem}, ptr %p, i64 %i
  store ${elem} ${zero}, ptr %sl
  %i1 = add i64 %i, 1
  br label %loop
fin:
  %b0 = insertvalue { i64, ptr } undef, i64 %n, 0
  %b1 = insertvalue { i64, ptr } %b0, ptr %p, 1
  ret { i64, ptr } %b1
}

define private ${elem} @omni_ll_bget_${s}({ i64, ptr } %b, i64 %i) {
entry:
  %n = extractvalue { i64, ptr } %b, 0
  %p = extractvalue { i64, ptr } %b, 1
  %lo = icmp slt i64 %i, 0
  %hi = icmp sge i64 %i, %n
  %oob = or i1 %lo, %hi
  br i1 %oob, label %err, label %ok
err:
  call void (ptr, ...) @omni_errorf(ptr @.omni_boob, i64 %i, i64 %n)
  unreachable
ok:
  %sl = getelementptr ${elem}, ptr %p, i64 %i
  %v = load ${elem}, ptr %sl
  ret ${elem} %v
}

define private ${elem} @omni_ll_bset_${s}({ i64, ptr } %b, i64 %i, ${elem} %v) {
entry:
  %n = extractvalue { i64, ptr } %b, 0
  %p = extractvalue { i64, ptr } %b, 1
  %lo = icmp slt i64 %i, 0
  %hi = icmp sge i64 %i, %n
  %oob = or i1 %lo, %hi
  br i1 %oob, label %err, label %ok
err:
  call void (ptr, ...) @omni_errorf(ptr @.omni_boob, i64 %i, i64 %n)
  unreachable
ok:
  %sl = getelementptr ${elem}, ptr %p, i64 %i
  store ${elem} %v, ptr %sl
  ret ${elem} %v
}
`;
}

/** MIR 模块 -> LLVM IR 文本。 */
export function emitLlvm(mir) {
  return new LlvmEmitter(mir).emit();
}


