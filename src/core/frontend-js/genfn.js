/**
 * 生成器改写（ADR-0020 P2 的后半）：把 `function*` 的体切成一台状态机。
 *
 * 这个文件只做 **AST -> AST**：进来是一个 `generator: true` 的函数节点，出去是一个
 * 普通函数节点，体里再没有 `Yield`。降级器（lower.js）因此不用认识生成器 ——
 * 它看到的是"一格状态量 + 一个 while(true) 的派发 + 一堆 goto"。
 *
 *   function* g(a) { yield a; yield 2; }
 *
 * 变成（示意，真出来的是 AST）：
 *
 *   function g(a) {
 *     let _g_st = 0; let _g_un = 0; let _g_rv; let _g_fin = 0;
 *     const _g_step = (_g_v, _g_md) => {
 *       if (_g_md === 1) { ... }              // it.return(v)
 *       if (_g_md === 2) { ... }              // it.throw(e)
 *       while (true) {
 *         if (_g_st === 0) { _g_st = 1; return js_gen_res(a, false); }
 *         if (_g_st === 1) { _g_st = 2; return js_gen_res(2, false); }
 *         return js_gen_res(undefined, true);
 *       }
 *     };
 *     return js_gen_new(_g_step);
 *   }
 *
 * 认下来的是一个**子集**（拿不准的一律当场报错，而不是悄悄降错）：
 *   - yield 只能在**语句层**：`yield e;` / `const x = yield e;` / `x = yield e;` /
 *     `yield* e;`。别的位置（实参里、二元运算里、条件里）报一句能照着改的错。
 *   - 切段要穿过的结构：块、if、while、do-while、for、for-of、for-in、
 *     以及 `try { … } finally { … }`（finally 体自己不许再有 yield）。
 *   - `try { … } catch (e) { … }` 里有 yield 还降不了：这个值域里的异常是"挂起槽 +
 *     提前 return"（ADR-0007），跨状态机接手要另一套形状。
 *   - **已知的洞**：切开的 try 体里真抛出来的异常不会跑 finally（挂起槽会把 step
 *     直接送出去）。it.return / it.throw 那两条路是跑的。
 */

/** 遍历子节点（与 lower.js 的同名函数同形：跳过 span 与 type） */
function eachChild(node, f) {
  for (const k of Object.keys(node)) {
    if (k === 'span' || k === 'type') continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const x of v) if (x && typeof x === 'object') f(x);
    } else if (v && typeof v === 'object') {
      f(v);
    }
  }
}

/** 函数边界：走到这儿就不往里钻了（里面的 yield 属于里面那个生成器） */
function isFnBoundary(n) {
  if (n.type === 'Arrow' || n.type === 'FuncExpr' || n.type === 'FuncDecl') return true;
  if (n.type === 'ClassDecl' || n.type === 'ClassExpr') return true;
  // 对象字面量与类里的方法没有 type 字段（parser 把它们摊成 { kind, key, params, body }）
  return Array.isArray(n.params) && n.body != null && n.body.type === 'Block';
}

/** 子树里有 yield 吗（不进函数边界） */
function hasYield(node, top = true) {
  if (!node || typeof node !== 'object') return false;
  if (!top && isFnBoundary(node)) return false;
  if (node.type === 'Yield') return true;
  let hit = false;
  eachChild(node, (x) => { if (!hit) hit = hasYield(x, false); });
  return hit;
}

/**
 * 子树里有"跳出去"的语句吗 —— break / continue（`want` 里带 'r' 时连 return 一起算），
 * 而且**不被自己里面的**循环或 switch 接住。有的话这一句就不能原样发进段里：原样发的
 * break 会跳出派发用的那个 while(true)。
 */
function freeJump(node, want, inLoop, inSwitch, top) {
  if (!node || typeof node !== 'object') return false;
  if (!top && isFnBoundary(node)) return false;
  if (node.type === 'Return') return want.includes('r');
  if (node.type === 'Break' || node.type === 'Continue') {
    // 带标签的跳转：标签是不是在这棵子树里定的不好一眼看出来 —— 拿不准就当"跳出去"
    if (node.label) return true;
    if (node.type === 'Break') return !inLoop && !inSwitch;
    return !inLoop;
  }
  const loop = inLoop || node.type === 'While' || node.type === 'DoWhile'
    || node.type === 'For' || node.type === 'ForOf' || node.type === 'ForIn';
  const sw = inSwitch || node.type === 'Switch';
  let hit = false;
  eachChild(node, (x) => { if (!hit) hit = freeJump(x, want, loop, sw, false); });
  return hit;
}

const hasFreeBC = (n) => freeJump(n, 'bc', false, false, true);
const hasFreeReturn = (n) => freeJump(n, 'r', false, false, true);


/* ---- 造 AST 的那几件小工具（形状按 parser.js 里的字面量来） ---- */

const ident = (name, sp) => ({ type: 'Ident', name, span: sp });
const num = (v, sp) => ({ type: 'Num', value: v, raw: String(v), span: sp });
const lit = (v, sp) => ({ type: 'Lit', value: v, span: sp });
const undef = (sp) => ident('undefined', sp);
const opCall = (op, args, sp) => ({ type: 'OpCall', op, args, span: sp });
const exprStmt = (e, sp) => ({ type: 'ExprStmt', expr: e, span: sp });
const assign = (target, value, sp) => ({ type: 'Assign', op: '=', target, value, span: sp });
const bin = (op, left, right, sp) => ({ type: 'Binary', op, left, right, span: sp });
const block = (body, sp) => ({ type: 'Block', body, span: sp });
const ret = (arg, sp) => ({ type: 'Return', arg, span: sp });
const ifSt = (test, cons, alt, sp) => ({ type: 'If', test, cons, alt, span: sp });
const letDecl = (name, init, sp) => ({
  type: 'VarDecl', kind: 'let', decls: [{ id: ident(name, sp), init }], span: sp,
});

/** 状态量的名字。都带 `_g_` 前缀：用户的名字撞上了就当场报（见 checkNames）。 */
const ST = '_g_st';      // 下一个要跑的段
const SENT = '_g_v';     // next(v) 送进来的值
const MODE = '_g_md';    // 0 next / 1 return / 2 throw
const UNW = '_g_un';     // 正在为哪一种"非正常出去"跑 finally（1 return / 2 throw）
const RV = '_g_rv';      // 那一格待返回/待重抛的值
const FIN = '_g_fin';    // 当前活着的 finally 的入口段（0 = 没有）

const genRes = (v, done, sp) => opCall('js_gen_res', [v, lit(done, sp)], sp);

/** 原样发进段里的那些句子：里面的 return 是"生成器完成"，要换成 return js_gen_res(v, true) */
function rewriteReturns(node) {
  if (!node || typeof node !== 'object') return node;
  if (isFnBoundary(node)) return node;
  if (node.type === 'Return') {
    const a = node.arg ? node.arg : undef(node.span);
    return ret(genRes(a, true, node.span), node.span);
  }
  const out = { type: node.type, span: node.span };
  for (const k of Object.keys(node)) {
    if (k === 'span' || k === 'type') continue;
    const v = node[k];
    if (Array.isArray(v)) out[k] = v.map((x) => (x && typeof x === 'object' ? rewriteReturns(x) : x));
    else if (v && typeof v === 'object') out[k] = rewriteReturns(v);
    else out[k] = v;
  }
  return out;
}

/* ---- 切段 ---- */

class Split {
  constructor(err) {
    this.err = err;
    this.blocks = [];   // 每一段的语句表
    this.term = [];     // 这一段已经跳走了吗（跳走之后再 emit 就是死代码）
    this.hoist = [];    // 要提到外层函数体的名字（切段要跨过它们的生存期）
    this.tmp = 0;
  }

  newBlock() {
    this.blocks.push([]);
    this.term.push(false);
    return this.blocks.length - 1;
  }

  emit(b, st) { if (!this.term[b]) this.blocks[b].push(st); }

  /** `_g_st = k; continue;` —— 派发循环的 goto */
  goto(b, k, sp) {
    if (this.term[b]) return;
    this.blocks[b].push(exprStmt(assign(ident(ST, sp), num(k, sp), sp), sp));
    this.blocks[b].push({ type: 'Continue', label: null, span: sp });
    this.term[b] = true;
  }

  /** `_g_st = k; return js_gen_res(v, false);` —— 让出去，下次从第 k 段接着跑 */
  yieldTo(b, v, k, sp) {
    if (this.term[b]) return;
    this.blocks[b].push(exprStmt(assign(ident(ST, sp), num(k, sp), sp), sp));
    this.blocks[b].push(ret(genRes(v, false, sp), sp));
    this.term[b] = true;
  }

  temp(tag) {
    const n = `_g_${tag}${this.tmp}`;
    this.tmp += 1;
    this.hoist.push(n);
    return n;
  }

  /** 一串语句。返回"接着往下走"的那一段，或者 -1（前面已经跳走了） */
  stmts(list, cur, ctx) {
    let b = cur;
    for (const s of list) {
      if (b < 0) return -1;
      b = this.stmt(s, b, ctx);
    }
    return b;
  }

  stmt(s, cur, ctx) {
    const sp = s.span;
    /* 声明**永远**走 varDecl：切段之后每一段是一个 `if (_g_st === k) { … }` 的块，
     * 声明留在块里就只在那一段里可见（量到过：`let n = 0;` 之后的段报 unresolved 'n'）。
     * 所以名字一律提到外层函数体，这儿只剩赋值。 */
    if (s.type === 'VarDecl') return this.varDecl(s, cur, ctx);
    /* 原样发进段里的条件：没有 yield、没有会跳出去的 break/continue，而且里面的 return
     * 不必先跑 finally。return 原样发之前要改写成"生成器完成"。 */
    if (!hasYield(s) && !hasFreeBC(s)) {
      const hasRet = hasFreeReturn(s);
      if (!hasRet) { this.emit(cur, s); return cur; }
      if (ctx.fin < 0) { this.emit(cur, rewriteReturns(s)); return cur; }
      if (s.type !== 'Return') {
        this.err(sp, "inside a generator's try/finally, 'return' must be a statement of its own");
        return cur;
      }
    }
    switch (s.type) {
      case 'Block': return this.stmts(s.body, cur, ctx);
      case 'ExprStmt': return this.exprStmt(s, cur, ctx);
      case 'VarDecl': return this.varDecl(s, cur, ctx);
      case 'Return': return this.retStmt(s, cur, ctx);
      case 'Break': case 'Continue': {
        const to = s.type === 'Break' ? ctx.brk : ctx.cont;
        if (s.label) {
          this.err(sp, `a labeled '${s.type === 'Break' ? 'break' : 'continue'}' is not supported in a generator`);
          return cur;
        }
        if (to < 0) {
          this.err(sp, `'${s.type === 'Break' ? 'break' : 'continue'}' cannot cross a yield boundary here`);
          return cur;
        }
        this.goto(cur, to, sp);
        return -1;
      }
      case 'If': return this.ifStmt(s, cur, ctx);
      case 'While': return this.whileStmt(s, cur, ctx);
      case 'DoWhile': return this.doWhile(s, cur, ctx);
      case 'For': return this.forStmt(s, cur, ctx);
      case 'ForOf': case 'ForIn': return this.forInOf(s, cur, ctx);
      case 'Try': return this.tryStmt(s, cur, ctx);
      default:
        this.err(sp, `a '${s.type}' statement that a 'yield' crosses is not supported yet in a generator`);
        return cur;
    }
  }

  exprStmt(s, cur, ctx) {
    const e = s.expr;
    const sp = s.span;
    if (e.type === 'Yield') return this.yieldExpr(e, null, cur, ctx);
    if (e.type === 'Assign' && e.value && e.value.type === 'Yield') {
      if (e.op !== '=') {
        this.err(sp, "a compound assignment from 'yield' is not supported; split it into two statements");
        return cur;
      }
      if (e.target.type !== 'Ident') {
        this.err(sp, "'yield' can only be assigned to a plain name; assign it to a local first");
        return cur;
      }
      return this.yieldExpr(e.value, e.target, cur, ctx);
    }
    this.err(sp, "'yield' in this position is not supported; write it as its own statement ('yield e;' or 'const x = yield e;')");
    return cur;
  }

  /** 一次让出：当前段收尾（记下回来的段号），值从 `_g_v` 接回来 */
  yieldExpr(e, target, cur, ctx) {
    const sp = e.span;
    if (e.arg && hasYield(e.arg)) {
      this.err(sp, "a nested 'yield' is not supported");
      return cur;
    }
    if (e.delegate) return this.delegate(e, target, cur, ctx);
    const next = this.newBlock();
    this.yieldTo(cur, e.arg ? e.arg : undef(sp), next, sp);
    if (target) this.emit(next, exprStmt(assign(target, ident(SENT, sp), sp), sp));
    return next;
  }

  /* `yield* e` 摊成一个 for-of：一格一格转发出去。
   * 内层的返回值（`const x = yield* g()`）与把 throw/return 转发给内层迭代器这两件事
   * 还没有 —— 前者报错，后者是那个洞。 */
  delegate(e, target, cur, ctx) {
    const sp = e.span;
    if (target) {
      this.err(sp, "the result value of 'yield*' is not supported; use it without assigning");
      return cur;
    }
    const v = this.temp('d');
    return this.stmt({
      type: 'ForOf',
      declKind: null,
      left: ident(v, sp),
      right: e.arg ? e.arg : undef(sp),
      body: exprStmt({ type: 'Yield', arg: ident(v, sp), delegate: false, span: sp }, sp),
      span: sp,
    }, cur, ctx);
  }

  /* 声明：名字提到外层函数体（切段之后它的生存期跨过好几个段），这儿只剩赋值。 */
  varDecl(s, cur, ctx) {
    const sp = s.span;
    let b = cur;
    for (const d of s.decls) {
      if (d.id.type !== 'Ident') {
        this.err(sp, "a destructuring declaration that a 'yield' crosses is not supported in a generator; take the parts apart in separate statements");
        return b;
      }
      this.hoist.push(d.id.name);
      if (!d.init) continue;
      if (d.init.type === 'Yield') {
        b = this.yieldExpr(d.init, ident(d.id.name, sp), b, ctx);
        continue;
      }
      if (hasYield(d.init)) {
        this.err(sp, "'yield' in this position is not supported; write it as its own statement");
        continue;
      }
      this.emit(b, exprStmt(assign(ident(d.id.name, sp), d.init, sp), sp));
    }
    return b;
  }

  retStmt(s, cur, ctx) {
    const sp = s.span;
    if (s.arg && hasYield(s.arg)) {
      this.err(sp, "'return' of a 'yield' is not supported; split it into two statements");
      return -1;
    }
    const arg = s.arg ? s.arg : undef(sp);
    if (ctx.fin >= 0) {
      // 还在 try 里：先把值收好、标上"在为 return 跑 finally"，再跳到 finally 的入口
      this.emit(cur, exprStmt(assign(ident(UNW, sp), num(1, sp), sp), sp));
      this.emit(cur, exprStmt(assign(ident(RV, sp), arg, sp), sp));
      this.goto(cur, ctx.fin, sp);
      return -1;
    }
    this.emit(cur, ret(genRes(arg, true, sp), sp));
    this.term[cur] = true;
    return -1;
  }

  /** 一格 `{ _g_st = k; continue; }` —— 派发循环里的条件跳转用它当分支体 */
  gotoBlock(k, sp) {
    return block([
      exprStmt(assign(ident(ST, sp), num(k, sp), sp), sp),
      { type: 'Continue', label: null, span: sp },
    ], sp);
  }

  ifStmt(s, cur, ctx) {
    const sp = s.span;
    if (hasYield(s.test)) {
      this.err(sp, "'yield' in an if condition is not supported; assign it to a name first");
      return cur;
    }
    const thenB = this.newBlock();
    const elseB = s.alt ? this.newBlock() : -1;
    const join = this.newBlock();
    this.emit(cur, ifSt(s.test, this.gotoBlock(thenB, sp),
      this.gotoBlock(elseB >= 0 ? elseB : join, sp), sp));
    this.term[cur] = true;
    const a = this.stmt(s.cons, thenB, ctx);
    if (a >= 0) this.goto(a, join, sp);
    if (elseB >= 0) {
      const c = this.stmt(s.alt, elseB, ctx);
      if (c >= 0) this.goto(c, join, sp);
    }
    return join;
  }

  whileStmt(s, cur, ctx) {
    const sp = s.span;
    if (hasYield(s.test)) {
      this.err(sp, "'yield' in a loop condition is not supported; assign it to a name first");
      return cur;
    }
    const head = this.newBlock();
    const bodyB = this.newBlock();
    const exit = this.newBlock();
    this.goto(cur, head, sp);
    this.emit(head, ifSt(s.test, this.gotoBlock(bodyB, sp), this.gotoBlock(exit, sp), sp));
    this.term[head] = true;
    const b = this.stmt(s.body, bodyB, { ...ctx, brk: exit, cont: head });
    if (b >= 0) this.goto(b, head, sp);
    return exit;
  }

  doWhile(s, cur, ctx) {
    const sp = s.span;
    if (hasYield(s.test)) {
      this.err(sp, "'yield' in a loop condition is not supported; assign it to a name first");
      return cur;
    }
    const bodyB = this.newBlock();
    const testB = this.newBlock();
    const exit = this.newBlock();
    this.goto(cur, bodyB, sp);
    const b = this.stmt(s.body, bodyB, { ...ctx, brk: exit, cont: testB });
    if (b >= 0) this.goto(b, testB, sp);
    this.emit(testB, ifSt(s.test, this.gotoBlock(bodyB, sp), this.gotoBlock(exit, sp), sp));
    this.term[testB] = true;
    return exit;
  }

  forStmt(s, cur, ctx) {
    const sp = s.span;
    if ((s.test && hasYield(s.test)) || (s.update && hasYield(s.update))) {
      this.err(sp, "'yield' in a for header is not supported");
      return cur;
    }
    let b = cur;
    if (s.init) b = s.init.type === 'VarDecl' ? this.varDecl(s.init, b, ctx) : this.stmt(s.init, b, ctx);
    if (b < 0) return -1;
    const head = this.newBlock();
    const bodyB = this.newBlock();
    const upd = this.newBlock();
    const exit = this.newBlock();
    this.goto(b, head, sp);
    if (s.test) {
      this.emit(head, ifSt(s.test, this.gotoBlock(bodyB, sp), this.gotoBlock(exit, sp), sp));
      this.term[head] = true;
    } else {
      this.goto(head, bodyB, sp);
    }
    const x = this.stmt(s.body, bodyB, { ...ctx, brk: exit, cont: upd });
    if (x >= 0) this.goto(x, upd, sp);
    if (s.update) this.emit(upd, exprStmt(s.update, sp));
    this.goto(upd, head, sp);
    return exit;
  }

  /* for-of / for-in 摊成"取一串 + 下标走"：这个值域里的 js_iter 收出来的是一格 list
   * （for-of 的降级本来也吃它，见 lower.js 的 forOf）。所以生成器里的 for-of 与外面
   * 一样是**先收齐再走** —— 无穷的可迭代对象在这儿会挂住，那是同一格已知的账。 */
  forInOf(s, cur, ctx) {
    const sp = s.span;
    if (hasYield(s.right)) {
      this.err(sp, "'yield' in a for-of header is not supported");
      return cur;
    }
    if (s.left.type !== 'Ident') {
      this.err(sp, "a destructuring for-of variable that a 'yield' crosses is not supported in a generator");
      return cur;
    }
    if (s.declKind) this.hoist.push(s.left.name);
    const it = this.temp('it');
    const ix = this.temp('ix');
    const items = s.type === 'ForIn'
      ? opCall('js_for_in_keys', [s.right], sp)
      : opCall('js_iter', [s.right], sp);
    this.emit(cur, exprStmt(assign(ident(it, sp), items, sp), sp));
    this.emit(cur, exprStmt(assign(ident(ix, sp), num(0, sp), sp), sp));
    const head = this.newBlock();
    const bodyB = this.newBlock();
    const exit = this.newBlock();
    this.goto(cur, head, sp);
    this.emit(head, ifSt(bin('<', ident(ix, sp), opCall('js_arr_len', [ident(it, sp)], sp), sp),
      this.gotoBlock(bodyB, sp), this.gotoBlock(exit, sp), sp));
    this.term[head] = true;
    // 先取值再进位：`continue` 于是可以直接跳回 head
    this.emit(bodyB, exprStmt(assign(ident(s.left.name, sp),
      opCall('js_idx_get', [ident(it, sp), ident(ix, sp)], sp), sp), sp));
    this.emit(bodyB, exprStmt(assign(ident(ix, sp), bin('+', ident(ix, sp), num(1, sp), sp), sp), sp));
    const x = this.stmt(s.body, bodyB, { ...ctx, brk: exit, cont: head });
    if (x >= 0) this.goto(x, head, sp);
    return exit;
  }

  /* try { … } finally { … }，try 体里有 yield 的那一种。
   *
   * finally 体发**两份**：一份在正常走完那条路上，一份在"非正常出去"那一段（unw）上 ——
   * 状态机是平的，没有别的办法让两条路都经过它。所以 finally 体自己不许有 yield，
   * 也不许有 break/continue/return（不然两份就不是同一件事了）。
   *
   * `_g_fin` 记着"现在活着的 finally 在哪一段"：it.return / it.throw 进来时看它一眼，
   * 有就先跑 finally（step 的开头那两个 if）。 */
  tryStmt(s, cur, ctx) {
    const sp = s.span;
    if (s.handler) {
      this.err(sp, "'yield' inside a try that has a catch clause is not supported yet (ADR-0020 P2)");
      return cur;
    }
    if (!s.finalizer) {
      this.err(sp, "'yield' inside a try needs a finally clause to be lowered");
      return cur;
    }
    if (ctx.fin >= 0) {
      this.err(sp, 'a nested try/finally around a yield is not supported in a generator');
      return cur;
    }
    if (hasYield(s.finalizer)) {
      this.err(sp, "'yield' inside a finally block is not supported");
      return cur;
    }
    if (hasFreeBC(s.finalizer) || hasFreeReturn(s.finalizer)) {
      this.err(sp, "'break' / 'continue' / 'return' inside a generator's finally block is not supported");
      return cur;
    }
    const bodyB = this.newBlock();
    const unw = this.newBlock();
    const norm = this.newBlock();
    const join = this.newBlock();
    this.emit(cur, exprStmt(assign(ident(FIN, sp), num(unw, sp), sp), sp));
    this.goto(cur, bodyB, sp);
    const x = this.stmts(s.block.body, bodyB, { ...ctx, fin: unw });
    if (x >= 0) {
      this.emit(x, exprStmt(assign(ident(FIN, sp), num(0, sp), sp), sp));
      this.goto(x, norm, sp);
    }
    this.emit(norm, s.finalizer);
    this.goto(norm, join, sp);
    this.emit(unw, exprStmt(assign(ident(FIN, sp), num(0, sp), sp), sp));
    this.emit(unw, s.finalizer);
    this.emit(unw, ifSt(bin('===', ident(UNW, sp), num(2, sp), sp),
      block([{ type: 'Throw', arg: ident(RV, sp), span: sp }], sp), null, sp));
    this.emit(unw, ret(genRes(ident(RV, sp), true, sp), sp));
    this.term[unw] = true;
    return join;
  }
}

/** 状态机占了 `_g_` 开头的名字：用户的名字撞上就当场报，而不是悄悄遮住 */
function checkNames(node, err) {
  const bad = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'Ident' && typeof n.name === 'string' && n.name.startsWith('_g_')) bad.add(n.name);
    eachChild(n, walk);
  };
  walk(node.body);
  for (const n of bad) err(node.span, `the name '${n}' is reserved by the generator rewrite; rename it`);
}

const STEP = '_g_step';

/** step 的开头两句：it.return(v) 与 it.throw(e) 进来时先看有没有 finally 要跑 */
function modePrologue(sp) {
  const unwindTo = (kind) => block([
    exprStmt(assign(ident(UNW, sp), num(kind, sp), sp), sp),
    exprStmt(assign(ident(RV, sp), ident(SENT, sp), sp), sp),
    exprStmt(assign(ident(ST, sp), ident(FIN, sp), sp), sp),
  ], sp);
  const noFin = bin('===', ident(FIN, sp), num(0, sp), sp);
  return [
    ifSt(bin('===', ident(MODE, sp), num(1, sp), sp), block([
      ifSt(noFin, block([ret(genRes(ident(SENT, sp), true, sp), sp)], sp), unwindTo(1), sp),
    ], sp), null, sp),
    ifSt(bin('===', ident(MODE, sp), num(2, sp), sp), block([
      ifSt(noFin, block([{ type: 'Throw', arg: ident(SENT, sp), span: sp }], sp), unwindTo(2), sp),
    ], sp), null, sp),
  ];
}

/**
 * 把一个 `generator: true` 的函数节点改写成普通函数节点。降级器在 funcDecl 与
 * closureOf 的入口调它一次（lower.js），所以嵌套的生成器也一样过这条路。
 */
export function genToStateMachine(node, err) {
  const sp = node.span;
  checkNames(node, err);
  const sx = new Split(err);
  const entry = sx.newBlock();
  /* 体里顶层的函数声明留在外层函数体上：那儿有降级器的提升（hoistFuncDecls），
   * 而状态机的段是 if 块 —— 声明留在段里就只有那一段看得见它。 */
  const fns = node.body.body.filter((s) => s.type === 'FuncDecl');
  const rest = node.body.body.filter((s) => s.type !== 'FuncDecl');
  const last = sx.stmts(rest, entry, { brk: -1, cont: -1, fin: -1 });
  // 走到体的尽头就是 done（值 undefined）
  if (last >= 0) {
    sx.emit(last, ret(genRes(undef(sp), true, sp), sp));
    sx.term[last] = true;
  }
  const chain = [];
  for (let i = 0; i < sx.blocks.length; i++) {
    chain.push(ifSt(bin('===', ident(ST, sp), num(i, sp), sp), block(sx.blocks[i], sp), null, sp));
  }
  // 派发不中（不该发生，也包括"跑完之后又被叫一次"）：当 done
  chain.push(ret(genRes(undef(sp), true, sp), sp));
  const step = {
    type: 'Arrow',
    params: [ident(SENT, sp), ident(MODE, sp)],
    rest: null,
    body: block([...modePrologue(sp),
      { type: 'While', test: lit(true, sp), body: block(chain, sp), span: sp }], sp),
    expression: false,
    span: sp,
  };
  const out = [
    letDecl(ST, num(0, sp), sp),
    letDecl(UNW, num(0, sp), sp),
    letDecl(RV, undef(sp), sp),
    letDecl(FIN, num(0, sp), sp),
  ];
  for (const f of fns) out.push(f);
  const seen = new Set();
  for (const n of sx.hoist) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(letDecl(n, null, sp));
  }
  out.push({ type: 'VarDecl', kind: 'const', decls: [{ id: ident(STEP, sp), init: step }], span: sp });
  out.push(ret(opCall('js_gen_new', [ident(STEP, sp)], sp), sp));
  return { ...node, generator: false, body: block(out, sp) };
}









