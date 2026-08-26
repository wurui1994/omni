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
  OP, OP_NAMES, OP_MODES, REF_NONE, REF_BIAS, isConstRef, refText, typeText, T_BOOL,
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
    } else if (role === 'n') {
      if (op === OP.BR || op === OP.BRIF) {
        // 层数是「往外数第几层」。栈底那一层是函数体本身，跳到它没有意义（该用 RET）。
        if (v >= depth) bad(i, `跳 ${v} 层，但此处只有 ${depth} 层可跳`);
        continue;
      }
      checkIndex(mod, f, i, op, v, bad);
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

function checkIndex(mod, f, i, op, v, bad) {
  if (op === OP.BR || op === OP.BRIF) return;   // 层数在 verifyFunc 的栈深里查
  if (op === OP.CALL && mod.funcs[v] === undefined) bad(i, `函数号 ${v} 越界`);
  if (op === OP.CALLOP && mod.ops[v] === undefined) bad(i, `op 号 ${v} 越界`);
  if (op === OP.CCALL && mod.cabi[v] === undefined) bad(i, `C 入口号 ${v} 越界`);
  if (op === OP.CLOSURE && mod.closures[v] === undefined) bad(i, `闭包号 ${v} 越界`);
  if ((op === OP.GLOAD || op === OP.GSTORE) && mod.globals[v] === undefined) bad(i, `全局号 ${v} 越界`);
  if ((op === OP.FLD || op === OP.FLDSET) && mod.accs[v] === undefined) bad(i, `访问描述符 ${v} 越界`);
  if ((op === OP.NEW || op === OP.COPY || op === OP.ETAG || op === OP.IDXGET
    || op === OP.IDXSET || op === OP.AGGLIT || op === OP.MKENUM) && mod.types[v] === undefined) {
    bad(i, `类型号 ${v} 越界`);
  }
}
