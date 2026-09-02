/**
 * MIR 的良构检查。
 *
 * OIR 那一层没有独立的 verifier —— `hir/check.js` 本身就是降级器，边查边造。MIR 不一样：
 * 它有**四个消费者**（解释器、LLVM、C 备选、SPIR-V），而且它的不变量是「结构性」的
 * （区域配对、ref 只能用在支配它的区域里）。这类不变量一旦破了，四个后端会各自
 * 表现成不同的错答案 —— 一个段错误、一个错值、一个静默少算一次循环。所以在这里
 * 一次查掉，比在四处各自 debug 便宜得多。
 *
 * 查五件事：
 *   1. 区域配对：END 有对应的 BLOCK/LOOP/IF；ELSE 只能在 IF 里；函数末尾深度归零。
 *   2. BR/BRIF 的层数在范围内（层数就是「往外数几层」，越界 = 跳到函数外）。
 *   3. **ref 的支配关系**：操作数要么是常量，要么是**更早**定义、且它所在的区域此刻
 *      仍然开着的指令。这一条替代了 SSA 的支配树检查 —— 结构化控制流下，「区域还开着」
 *      和「支配」是同一件事，而前者只要一个栈。
 *   4. 各种下标（槽、类型、访问描述符、op、函数、闭包、C 入口、实参池）在范围内。
 *   5. 条件必须是 bool：`IF` / `BRIF` 的条件类型不是 T_BOOL 就是降级器出了错。
 */

import {
  OP, OP_NAMES, OP_MODES, REF_NONE, REF_BIAS, isConstRef, refText, typeText, typeLanes, T_BOOL,
  T_I64, T_I32, T_F64, T_VOID,
  MLOAD_KINDS, MSTORE_KINDS, memKindNo, memBytes, isFloatType, isIntType, intBits,
} from './ir.js';

export function verifyMir(mod) {
  const errs = [];
  for (const f of mod.funcs) verifyFunc(mod, f, errs);
  return errs;
}

function verifyFunc(mod, f, errs) {
  const bad = (i, msg) => {
    if (errs.length < 40) errs.push(`${f.name}:${refText(i + REF_BIAS)} ${OP_NAMES[f.op[i]]}: ${msg}`);
  };
  // 区域栈：每层一个唯一 id。指令记下自己所在的最内层 id，用 ref 时查那个 id 还在不在栈上。
  let nextRegion = 1;
  const stack = [{ id: 0, op: null, hasElse: false }];
  const live = new Set([0]);
  const regionOf = [];

  // 用 while 而不是 `for (let i ...)`：本函数里有个箭头函数（bad），封闭子集会把
  // for 的循环变量判成「可能被闭包捕获」（ADR-0011 决策 15 那条保守规则）。
  let i = 0;
  while (i < f.count()) {
    const op = f.op[i];
    const top = stack[stack.length - 1];

    if (op === OP.ELSE) {
      if (top.op !== OP.IF) bad(i, 'ELSE 不在 IF 里');
      else if (top.hasElse) bad(i, '一个 IF 有两个 ELSE');
      else {
        // then 分支里定义的 ref 在 else 分支里不可见：换一个新 id，旧 id 下线
        top.hasElse = true;
        live.delete(top.id);
        top.id = nextRegion++;
        live.add(top.id);
      }
    } else if (op === OP.END) {
      if (stack.length === 1) bad(i, 'END 没有对应的区域');
      else { live.delete(top.id); stack.pop(); }
    }

    regionOf.push(stack[stack.length - 1].id);
    checkOperands(mod, f, i, live, regionOf, stack.length - 1, bad);

    if (op === OP.BLOCK || op === OP.LOOP || op === OP.IF) {
      const r = { id: nextRegion++, op, hasElse: false };
      stack.push(r);
      live.add(r.id);
    }
    i++;
  }
  if (stack.length !== 1) errs.push(`${f.name}: 函数结束时还有 ${stack.length - 1} 层区域没关`);
}

function checkOperands(mod, f, i, live, regionOf, depth, bad) {
  const op = f.op[i];
  const mode = OP_MODES[op];
  const vals = [f.a[i], f.b[i], f.aux[i]];
  for (let k = 0; k < 3; k++) {
    const role = mode[k];
    const v = vals[k];
    if (role === 'r') {
      if (v === REF_NONE) continue;
      checkRef(mod, f, i, v, live, regionOf, bad);
      if ((op === OP.IF || op === OP.BRIF) && k === 0) {
        const t = f.typeOf(v, mod.consts);
        if (t !== T_BOOL) bad(i, `条件的类型是 ${typeText(t)}，不是 bool`);
      }
    } else if (role === 's') {
      if (f.slots[v] === undefined) bad(i, `槽号 ${v} 越界（共 ${f.slots.length} 个）`);
    } else if (role === 'p') {
      const n = f.args[v];
      if (n === undefined || v + 1 + n > f.args.length) { bad(i, `实参池 ${v} 越界`); continue; }
      for (const r of f.argsOf(v)) checkRef(mod, f, i, r, live, regionOf, bad);
    } else if (role === 'j') {
      // 跳表（第三刀）。池的形状与 'p' 相同，但里头是层数 —— 一律不当 ref 查。
      const n = f.args[v];
      if (n === undefined || v + 1 + n > f.args.length) { bad(i, `跳表池 ${v} 越界`); continue; }
      for (const lv of f.levelsOf(v)) {
        if (lv >= depth) bad(i, `跳表里有一项跳 ${lv} 层，但此处只有 ${depth} 层可跳`);
      }
      // 下标的类型：只有整数说得清"第几项"。浮点/bool 落进来的话两条腿会各自转一次
      // （LLVM 的 switch 只收整数、解释器那边 BigInt 与 Number 的比较还悄悄成立）。
      const it = f.typeOf(f.a[i], mod.consts);
      if (!isIntType(it)) bad(i, `BRTABLE 的下标是 ${typeText(it)}，不是整数`);
    } else if (role === 'n') {
      if (op === OP.BR || op === OP.BRIF || op === OP.BRTABLE) {
        // 层数是「往外数第几层」。栈底那一层是函数体本身，跳到它没有意义（该用 RET）。
        if (v >= depth) bad(i, `跳 ${v} 层，但此处只有 ${depth} 层可跳`);
        continue;
      }
      checkIndex(mod, f, i, op, v, bad, k);
    }
  }
}

function checkRef(mod, f, i, ref, live, regionOf, bad) {
  if (isConstRef(ref)) {
    if (mod.consts.get(ref) === undefined) bad(i, `常量 ${refText(ref)} 不在池里`);
    return;
  }
  const j = ref - REF_BIAS;
  if (j >= i) { bad(i, `用了还没定义的 ${refText(ref)}`); return; }
  if (!live.has(regionOf[j])) bad(i, `${refText(ref)} 定义在一个已经关掉的区域里（支配关系不成立）`);
}

function checkIndex(mod, f, i, op, v, bad, k) {
  if (op === OP.BR || op === OP.BRIF || op === OP.BRTABLE) return;   // 层数在 verifyFunc 的栈深里查
  /* CCALL 的两个数字字段（第二十二片）：a 是 C 入口号，aux 是变参分界。
   * 分界要么是 0（不是变参调用），要么在 1..实参数+1 里 —— 「固定实参比实参还多」
   * 会让后端把一个不存在的实参往寄存器里放。
   * `CALLI` 的 aux 是同一个编码（第三十五片），所以同一段查。 */
  if (op === OP.CCALL || op === OP.CALLI) {
    if (op === OP.CCALL && k === 0) {
      if (mod.cabi[v] === undefined) bad(i, `C 入口号 ${v} 越界`);
      return;
    }
    const n = f.args[f.b[i]];
    if (v !== 0 && (n === undefined || v > n + 1)) {
      bad(i, `变参分界 ${v}（固定实参 ${v - 1} 个）超过实参个数 ${n}`);
    }
    return;
  }
  // 道号：向量的宽度在 `t` 上，所以这一条不用查类型池，一次比较就够。
  // 越界的道在 LLVM 里是 poison、在 C 里是越界读 —— 两条腿会给出不同的错答案，所以查。
  if (op === OP.VEXT || op === OP.VINS) {
    const vt = op === OP.VEXT ? f.typeOf(f.a[i], mod.consts) : f.t[i];
    if (v >= typeLanes(vt)) bad(i, `道号 ${v} 越界（${typeText(vt)} 只有 ${typeLanes(vt)} 道）`);
    return;
  }
  if (op === OP.CALL && mod.funcs[v] === undefined) bad(i, `函数号 ${v} 越界`);
  // 帧块号（第十八片）。越界的块号在 native 上是「拿到一个帧外的地址」—— 写进去就把
  // 调用者的保存寄存器或返回地址改了，而症状要到 `ret` 才出现，离现场已经很远。
  if (op === OP.FRAME) {
    if (f.frames[v] === undefined) { bad(i, `帧块号 ${v} 越界（共 ${f.frames.length} 块）`); return; }
    if (f.t[i] !== T_I64) bad(i, `FRAME 的 t 是 ${typeText(f.t[i])}，地址只能是 i64`);
    return;
  }
  /* 全局的地址（第二十一片）：号要在表里，`t` 只能是 i64。**还要求它是一块字节** ——
   * 「一格」的全局（wasm 的 `(global …)`）没有地址可谈，取它的址是降级器的 bug。 */
  if (op === OP.GADDR) {
    if (mod.globals[v] === undefined) { bad(i, `全局号 ${v} 越界`); return; }
    if (mod.globalBlob[v] === null) {
      bad(i, `GADDR 取的是 '${mod.globals[v]}' 的地址，可是它只是一格（没说大小与对齐）`);
      return;
    }
    if (f.t[i] !== T_I64) bad(i, `GADDR 的 t 是 ${typeText(f.t[i])}，地址只能是 i64`);
    return;
  }
  // 线性内存（ADR-0017 第二刀）。三件事都在这儿查：有没有内存、描述符号在不在表里、
  // **宽度与 `t` 配不配**。第三条是关键：`(mload i64 …)` 落到 t=T_F64 上，两条腿会
  // 各自猜一个（DataView 那边读出整数、memcpy 那边读出位模式当浮点），错得还不一样。
  if (op === OP.MLOAD || op === OP.MSTORE) {
    const isLoad = op === OP.MLOAD;
    const kn = memKindNo(v);
    const names = isLoad ? MLOAD_KINDS : MSTORE_KINDS;
    /* 地址模型（第十九片）：线性内存那条腿必须**有** `mem`，native 那条腿必须**没有**。
     * 同一条 `MLOAD` 在两种模型下解释不同（偏移 vs 真地址），所以两边各查一句。 */
    if (mod.native) {
      if (mod.mem !== null) { bad(i, `${OP_NAMES[op]}：这个模块认真地址，不该有线性内存`); return; }
    } else if (mod.mem === null) {
      bad(i, `${OP_NAMES[op]}：这个模块没有声明线性内存`);
      return;
    }
    if (names[kn] === undefined) { bad(i, `内存访问号 ${kn} 越界`); return; }
    const t = f.t[i];
    const wantFloat = names[kn].charCodeAt(0) === 102;   // 'f'
    if (wantFloat !== isFloatType(t)) {
      bad(i, `${OP_NAMES[op]} 的描述符是 ${names[kn]}，但 t 是 ${typeText(t)}`);
      return;
    }
    // 整数侧：读进来的字节数不能超过结果类型的宽度（`i64` 的描述符配 i32 的 t 会丢高位）。
    if (!wantFloat && memBytes(v, isLoad) * 8 > intBits(t)) {
      bad(i, `${OP_NAMES[op]} 的描述符是 ${names[kn]}（${memBytes(v, isLoad)} 字节），装不进 ${typeText(t)}`);
      return;
    }
    // 满宽的读没有符号可言（wasm 也是这样：有 `i32.load8_u`，没有 `i32.load32_u`）。
    // 放过去的后果是宿主表示脱离规范形 —— `i32u` 读出 0x80000000 得到 2147483648n，
    // 而 T_I32 的规范形是 -2147483648n，之后每一条比较都会与 LLVM 那条腿分叉。
    if (isLoad && !wantFloat && memBytes(v, isLoad) * 8 === intBits(t) && names[kn].endsWith('u')) {
      bad(i, `${OP_NAMES[op]} 的描述符是 ${names[kn]}，但满宽的读没有无符号变体 —— 用 ${names[kn - 1]}`);
    }
    return;
  }
  /* 变参的定义那一侧（第二十四片）。只有 native 有真 ABI 可谈；`VASTART` 还要求函数
   * **自己**是变参的（不然 va_list 里没有东西可指）—— 而 `VAARG` 不要求：C 里
   * 「收一个 va_list 形参、替别人取实参」是合法的（`vfprintf` 就是那个形状）。
   * 取出来的类型限于 C 的变参能传的那几个：`float`/`bool` 过不来（默认提升成
   * double/int），放过去只会读到半格。 */
  if (op === OP.VASTART || op === OP.VAARG || op === OP.VACOPY) {
    if (!mod.native) { bad(i, `${OP_NAMES[op]}：只有 native 这条腿有真的 va_list`); return; }
    if (v !== 0) { bad(i, `${OP_NAMES[op]} 的 aux 只能是 0`); return; }
    const t = f.t[i];
    if (op === OP.VASTART) {
      if (!f.variadic) { bad(i, `VASTART：函数 '${f.name}' 的形参表里没有 ...`); return; }
      if (t !== T_I64) bad(i, `VASTART 的 t 是 ${typeText(t)}，va_list 只能是 i64`);
      return;
    }
    /* `VACOPY` 与 `VAARG` 一样不要求函数自己是变参的：`va_copy` 最常出现的地方
     * 正是「收一个 va_list 形参、抄一份自己用」那种函数（第三十二片）。 */
    if (op === OP.VACOPY) {
      if (t !== T_I64) bad(i, `VACOPY 的 t 是 ${typeText(t)}，va_list 只能是 i64`);
      return;
    }
    if (t !== T_I64 && t !== T_I32 && t !== T_F64) {
      bad(i, `VAARG 取的是 ${typeText(t)}，C 的变参只传 i32/i64/f64`);
    }
    return;
  }
  /* 会动的栈顶（第三十六片）：只有 native 有真的机器栈可动 —— 线性内存那条腿上
   * 「栈」是 `$sp` 那个全局，动它是普通的 GLOAD/GSTORE，不该走这三条。 */
  if (op === OP.SPGET || op === OP.SPSET || op === OP.SPALLOC) {
    if (!mod.native) { bad(i, `${OP_NAMES[op]}：只有 native 这条腿上栈顶是机器的 sp`); return; }
    const t = f.t[i];
    if (op === OP.SPSET) {
      if (t !== T_VOID) bad(i, `SPSET 的 t 是 ${typeText(t)}，它不产值`);
      return;
    }
    if (t !== T_I64) bad(i, `${OP_NAMES[op]} 的 t 是 ${typeText(t)}，栈顶只能是 i64`);
    return;
  }
  /* 函数的地址（第二十七片）：号要在表里、`t` 只能是 i64、而且只有 native 有真地址可谈   * （解释器那条腿上函数指针是「号 + 1」，不是地址）。 */
  if (op === OP.FADDR) {
    if (mod.funcs[v] === undefined) { bad(i, `函数号 ${v} 越界`); return; }
    if (!mod.native) { bad(i, 'FADDR：只有 native 这条腿上函数有真地址'); return; }
    if (f.t[i] !== T_I64) bad(i, `FADDR 的 t 是 ${typeText(f.t[i])}，地址只能是 i64`);
    return;
  }
  if (op === OP.CALLOP && mod.ops[v] === undefined) bad(i, `op 号 ${v} 越界`);
  if (op === OP.CCALL && mod.cabi[v] === undefined) bad(i, `C 入口号 ${v} 越界`);
  if (op === OP.CLOSURE && mod.closures[v] === undefined) bad(i, `闭包号 ${v} 越界`);
  if ((op === OP.GLOAD || op === OP.GSTORE) && mod.globals[v] === undefined) bad(i, `全局号 ${v} 越界`);
  if ((op === OP.FLD || op === OP.FLDSET) && mod.accs[v] === undefined) bad(i, `访问描述符 ${v} 越界`);
  if ((op === OP.NEW || op === OP.COPY || op === OP.ETAG || op === OP.IDXGET
    || op === OP.IDXSET || op === OP.AGGLIT || op === OP.MKENUM
    // 数组那五条的 aux 也是类型号（第十八刀）：越界的话后端拿不到元素类型，
    // 发出来的会是"按 ptr 猜"的指令 —— 那种错在运行时才现形，所以在这里查。
    || op === OP.ANEW || op === OP.AGET || op === OP.ASET || op === OP.APUSH
    || op === OP.APOP) && mod.types[v] === undefined) {
    bad(i, `类型号 ${v} 越界`);
  }
}
