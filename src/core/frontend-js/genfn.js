/**
 * 生成器与 async 的改写（ADR-0020 P2 的后半）：把 `function*` / `async function` 的体
 * 切成一台状态机。
 *
 * 这个文件只做 **AST -> AST**：进来是一个 `generator: true` / `async: true` 的函数节点，
 * 出去是一个普通函数节点，体里再没有 `Yield` / `Await`。降级器（lower.js）因此不用认识
 * 这两样 —— 它看到的是"一格状态量 + 一个 while(true) 的派发 + 一堆 goto"。
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
 * 三种尾巴共用这一台机器，差别只在"谁来恢复它"：
 *   function*        -> js_gen_new     恢复者是 next()
 *   async function   -> js_async_run   恢复者是微任务（await 那一段发 js_gen_awt）
 *   async function*  -> js_agen_new    next() 返回 promise，两种收尾都可能出现
 *
 * 认下来的是一个**子集**（拿不准的一律当场报错，而不是悄悄降错）：
 *   - yield / await 只能在**语句层**：`yield e;` / `const x = await e;` / `x = yield e;` /
 *     `yield* e;` / `return await e;`。别的位置（实参里、二元运算里、条件里）报一句
 *     能照着改的错。
 *   - 切段要穿过的结构：块、if、while、do-while、for、for-of、for-in、for await、
 *     以及 try / catch / finally（三种形状都收；finally 体自己不许再有 yield / await，
 *     也不许有 break/continue/return —— 它要发两份）。
 *   - 抛进来的那一格（it.throw 与"体里抛出来的"是同一件事）先看有没有活着的 catch，
 *     再看 finally，都没有才原样往上冒 —— 见 modePrologue 与 tryStmt。
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

/** 子树里有"能挂起"的东西吗 —— yield / await / for-await（不进函数边界） */
function hasSuspend(node, top = true) {
  if (!node || typeof node !== 'object') return false;
  if (!top && isFnBoundary(node)) return false;
  if (node.type === 'Yield' || node.type === 'Await') return true;
  if (node.type === 'ForOf' && node.await === true) return true;
  let hit = false;
  eachChild(node, (x) => { if (!hit) hit = hasSuspend(x, false); });
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

/**
 * 这一格挂起提得出来吗（见 lift）。两类提不出来：
 *
 *   - **惰性位置**：`a || await b`、`c ? await x : y`、`o?.m(await x)` —— 提出来就把
 *     "可能不算"变成了"一定算"，那是可观察的分叉。
 *   - **不认的节点**：只认下面这几种"子表达式按次序、无条件求值"的形状；别的照旧报错。
 */
function hoistable(e) {
  if (!e || typeof e !== 'object' || !hasSuspend(e)) return true;
  if (e.type === 'Await' || e.type === 'Yield') return hoistable(e.arg);
  // 可选链那一段（`o?.m()`）：短路会跳过实参，所以不提
  if (e.optional === true) return false;
  if (e.type === 'Logical' && hasSuspend(e.right)) return false;
  if (e.type === 'Cond' && (hasSuspend(e.cons) || hasSuspend(e.alt))) return false;
  /* 没有 type 的那些是**结构节点**（对象字面量的 prop、声明的 decl…）：它们不是表达式，
   * 往里看就行。方法那一格在 isFnBoundary 那儿就断了，落不到这里。 */
  if (e.type !== undefined && !HOISTABLE_KINDS.has(e.type)) return false;
  if (e.type === 'Assign' && !(e.op === '=' && e.target.type === 'Ident')) return false;
  // 对象字面量：只认普通的 key: value 那一格（方法体里的挂起属于里面那个函数）
  if (e.type === 'Object' && e.props.some((p) => hasSuspend(p) && (p.method === true || p.kind !== 'init'))) return false;
  let all = true;
  eachChild(e, (x) => { if (all) all = hoistable(x); });
  return all;
}
const HOISTABLE_KINDS = new Set([
  'Call', 'New', 'Member', 'Binary', 'Logical', 'Cond', 'Unary',
  'Array', 'Object', 'Template', 'Seq', 'Assign', 'Spread',
]);


/* ---- 造 AST 的那几件小工具（形状按 parser.js 里的字面量来） ---- */

const ident = (name, sp) => ({ type: 'Ident', name, span: sp });
const num = (v, sp) => ({ type: 'Num', value: v, raw: String(v), span: sp });
const lit = (v, sp) => ({ type: 'Lit', value: v, span: sp });
const undef = (sp) => ident('undefined', sp);
const opCall = (op, args, sp) => ({ type: 'OpCall', op, args, span: sp });
const exprStmt = (e, sp) => ({ type: 'ExprStmt', expr: e, span: sp });
const assign = (target, value, sp) => ({ type: 'Assign', op: '=', target, value, span: sp });
const bin = (op, left, right, sp) => ({ type: 'Binary', op, left, right, span: sp });
const member = (obj, name, sp) => ({
  type: 'Member', object: obj, name, computed: false, optional: false, span: sp,
});
const block = (body, sp) => ({ type: 'Block', body, span: sp });
const ret = (arg, sp) => ({ type: 'Return', arg, span: sp });
const ifSt = (test, cons, alt, sp) => ({ type: 'If', test, cons, alt, span: sp });
const letDecl = (name, init, sp) => ({
  type: 'VarDecl', kind: 'let', decls: [{ id: ident(name, sp), init }], span: sp,
});

/** 状态量的名字。都带 `_g_` 前缀：用户的名字撞上了就当场报（见 checkNames）。 */
const ST = '_g_st';      // 下一个要跑的段
const SENT = '_g_v';     // next(v) 送进来的值
const MODE = '_g_md';    // 0 next / 1 return / 2 throw / 3 "体里抛出来的送回来接手"
const UNW = '_g_un';     // 正在为哪一种"非正常出去"跑 finally（1 return / 2 throw）
const RV = '_g_rv';      // 那一格待返回/待重抛的值
const FIN = '_g_fin';    // 当前活着的 finally 的入口段（0 = 没有）
const CAT = '_g_cat';    // 当前活着的 catch 的入口段（0 = 没有）
const EX = '_g_ex';      // 接住的那一格异常值

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
  constructor(err, isAsync) {
    this.err = err;
    this.isAsync = isAsync === true;
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

  /** `_g_st = k; return js_gen_awt(v);` —— 等一格 promise，恢复者是微任务 */
  awaitTo(b, v, k, sp) {
    if (this.term[b]) return;
    this.blocks[b].push(exprStmt(assign(ident(ST, sp), num(k, sp), sp), sp));
    this.blocks[b].push(ret(opCall('js_gen_awt', [v], sp), sp));
    this.term[b] = true;
  }

  temp(tag) {
    const n = `_g_${tag}${this.tmp}`;
    this.tmp += 1;
    this.hoist.push(n);
    return n;
  }

  /* 把**表达式里面**的 yield / await 提到语句层（`console.log(await f())`）。
   * 交出 { pre, expr }：pre 是要先跑的那几句（里面还带着挂起，交给 stmts 去切段），
   * expr 是把挂起换成临时量之后的那一格表达式。提不出来（惰性位置、不认的节点）给 null，
   * 调用方照旧报那句"写成自己一句"。
   *
   * 次序是这里唯一要小心的地方：**最后一处挂起之前的子表达式也要落进临时量**，
   * 不然它们会被推到 await 之后才算 —— `f(g(), await h())` 里的 g() 就是那一格。 */
  lift(e, sp) {
    if (!hoistable(e)) return null;
    const pre = [];
    const expr = this.hoistExpr(e, pre);
    return { pre, expr: expr === null ? e : expr, span: sp };
  }

  /** 一个不含挂起的子表达式：先算出来存进临时量（保住求值次序） */
  spill(x, pre) {
    if (x === null || x === undefined) return x;
    if (hasSuspend(x)) return this.hoistExpr(x, pre);
    if (x.type === 'Ident' || x.type === 'Num' || x.type === 'Str' || x.type === 'Lit') return x;
    const sp = x.span;
    const t = this.temp('h');
    pre.push(exprStmt(assign(ident(t, sp), x, sp), sp));
    return ident(t, sp);
  }

  /** 一串按次序求值的位置（实参、数组的格子、模板的插值） */
  hoistList(xs, pre) {
    let last = -1;
    for (let i = 0; i < xs.length; i++) if (xs[i] && hasSuspend(xs[i])) last = i;
    return xs.map((x, i) => {
      if (x === null || x === undefined) return x;
      if (x.type === 'Spread') {
        if (i < last) return { ...x, arg: this.spill(x.arg, pre) };
        return hasSuspend(x) ? { ...x, arg: this.hoistExpr(x.arg, pre) } : x;
      }
      if (i < last) return this.spill(x, pre);
      if (i === last) return this.hoistExpr(x, pre);
      return x;
    });
  }

  hoistExpr(e, pre) {
    if (!hasSuspend(e)) return e;
    const sp = e.span;
    if (e.type === 'Await' || e.type === 'Yield') {
      const arg = e.arg && hasSuspend(e.arg) ? this.hoistExpr(e.arg, pre) : e.arg;
      const t = this.temp('h');
      pre.push(exprStmt(assign(ident(t, sp), { ...e, arg }, sp), sp));
      return ident(t, sp);
    }
    switch (e.type) {
      case 'Call': case 'New': {
        /* 被调用的那一格先算：成员形态只把**接收者**（与计算键）落进临时量，保住
         * `o.m(await x)` 里的 this；属性本身于是在 await 之后才查一次，那一格与规范
         * 差一点（规范先查），换来的是不必给方法调用另开一条路。 */
        let callee = e.callee;
        if (e.args.some((a) => hasSuspend(a))) {
          callee = callee.type === 'Member'
            ? { ...callee, object: this.spill(callee.object, pre), prop: callee.computed ? this.spill(callee.prop, pre) : callee.prop }
            : this.spill(callee, pre);
        } else if (hasSuspend(callee)) {
          callee = this.hoistExpr(callee, pre);
        }
        return { ...e, callee, args: this.hoistList(e.args, pre) };
      }
      case 'Member':
        return { ...e, object: this.hoistExpr(e.object, pre), prop: e.computed && hasSuspend(e.prop) ? this.hoistExpr(e.prop, pre) : e.prop };
      case 'Binary': {
        const [left, right] = this.hoistList([e.left, e.right], pre);
        return { ...e, left, right };
      }
      case 'Logical':
        return { ...e, left: this.hoistExpr(e.left, pre) };
      case 'Cond':
        return { ...e, test: this.hoistExpr(e.test, pre) };
      case 'Unary':
        return { ...e, arg: this.hoistExpr(e.arg, pre) };
      case 'Array':
        return { ...e, elements: this.hoistList(e.elements, pre) };
      case 'Template':
        return { ...e, exprs: this.hoistList(e.exprs, pre) };
      case 'Seq':
        return { ...e, exprs: this.hoistList(e.exprs, pre) };
      case 'Assign':
        return { ...e, value: this.hoistExpr(e.value, pre) };
      case 'Object': {
        const vals = this.hoistList(e.props.map((p) => p.value), pre);
        return { ...e, props: e.props.map((p, i) => ({ ...p, value: vals[i] })) };
      }
      default: return null;
    }
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
    if (!hasSuspend(s) && !hasFreeBC(s)) {
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
        const word = s.type === 'Break' ? 'break' : 'continue';
        if (s.label) {
          this.err(sp, `a labeled '${word}' is not supported in a generator`);
          return cur;
        }
        if (to < 0) {
          this.err(sp, `'${word}' cannot cross a yield boundary here`);
          return cur;
        }
        if (ctx.fin >= 0) {
          this.err(sp, `'${word}' out of a try/finally is not supported here; the finally block would be skipped`);
          return cur;
        }
        // 跳出带 catch 的 try 体：那格 catch 得摘下来（不然后面抛的东西会跳回它）
        if (ctx.cat >= 0) this.emit(cur, exprStmt(assign(ident(CAT, sp), num(0, sp), sp), sp));
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
    if (e.type === 'Yield' || e.type === 'Await') return this.suspend(e, null, cur, ctx);
    if (e.type === 'Assign' && e.value && (e.value.type === 'Yield' || e.value.type === 'Await')) {
      if (e.op !== '=') {
        /* `s += await f()`：摊成两句 —— 先把挂起的值接进临时量，再做那次复合赋值。
         * 目标只收"读两次也没差别"的形状（名字，或者对象是名字的成员）；别的照旧报错。
         * 与规范差一点：规范先读左边再 await，这儿是 await 之后才读 —— 只有"左边是访问器
         * 且 await 期间被改过"才看得出来，记在 ADR-0020。 */
        const okTarget = e.target.type === 'Ident'
          || (e.target.type === 'Member' && e.target.object.type === 'Ident' && !e.target.computed);
        if (!okTarget) {
          this.err(sp, "a compound assignment from 'yield' / 'await' is only supported on a name or a simple member; split it into two statements");
          return cur;
        }
        const t = this.temp('c');
        return this.stmts([
          exprStmt(assign(ident(t, sp), e.value, sp), sp),
          exprStmt({ ...e, value: ident(t, sp) }, sp),
        ], cur, ctx);
      }
      if (e.target.type !== 'Ident') {
        this.err(sp, "'yield' / 'await' can only be assigned to a plain name; assign it to a local first");
        return cur;
      }
      return this.suspend(e.value, e.target, cur, ctx);
    }
    /* 表达式**里面**的挂起（`console.log(await f())`）：提到语句层再走一遍。
     * 提不出来的（惰性位置、不认的形状）才落到下面那句报错。 */
    const lifted = this.lift(e, sp);
    if (lifted && lifted.pre.length > 0) {
      return this.stmts([...lifted.pre, exprStmt(lifted.expr, sp)], cur, ctx);
    }
    this.err(sp, "'yield' / 'await' in this position is not supported; write it as its own statement ('yield e;' or 'const x = await e;')");
    return cur;
  }

  /** 一次挂起。当前段收尾（记下回来的段号），值从 `_g_v` 接回来 */
  suspend(e, target, cur, ctx) {
    const sp = e.span;
    if (e.arg && hasSuspend(e.arg)) {
      this.err(sp, "a nested 'yield' / 'await' is not supported");
      return cur;
    }
    if (e.type === 'Await') {
      if (!this.isAsync) {
        this.err(sp, "'await' is only allowed in an async function");
        return cur;
      }
      const nextA = this.newBlock();
      this.awaitTo(cur, e.arg ? e.arg : undef(sp), nextA, sp);
      if (target) this.emit(nextA, exprStmt(assign(target, ident(SENT, sp), sp), sp));
      return nextA;
    }
    if (e.delegate) return this.delegate(e, target, cur, ctx);
    const next = this.newBlock();
    this.yieldTo(cur, e.arg ? e.arg : undef(sp), next, sp);
    if (target) this.emit(next, exprStmt(assign(target, ident(SENT, sp), sp), sp));
    return next;
  }

  /* `yield* e` 摊成**手写的迭代器协议**，而不是一个 for-of：for-of 把内层的返回值丢了，
   * 而 `const x = yield* g()` 要的正是那一格（规范 27.5.3.7 第 7.a.iii 步 —— done 那次的
   * value 就是 yield* 整个表达式的值）。
   *
   *   _di = e[Symbol.iterator]();
   *   while (true) {
   *     _dr = _di.next();
   *     if (_dr.done) { target = _dr.value; break; }
   *     yield _dr.value;
   *   }
   *
   * 还差的一格（照旧）：把 it.throw / it.return 转发给内层迭代器。
   */
  delegate(e, target, cur, ctx) {
    const sp = e.span;
    const it = this.temp('di');
    const r = this.temp('dr');
    const dot = (obj, name) => ({ type: 'Member', object: obj, name, computed: false, optional: false, span: sp });
    const symIter = {
      type: 'Member', computed: true, optional: false, span: sp,
      object: e.arg ? e.arg : undef(sp),
      prop: dot(ident('Symbol', sp), 'iterator'),
    };
    const body = [
      exprStmt(assign(ident(r, sp),
        { type: 'Call', callee: dot(ident(it, sp), 'next'), args: [], optional: false, span: sp }, sp), sp),
      {
        type: 'If',
        test: dot(ident(r, sp), 'done'),
        cons: {
          type: 'Block',
          body: [
            ...(target ? [exprStmt(assign(target, dot(ident(r, sp), 'value'), sp), sp)] : []),
            { type: 'Break', label: null, span: sp },
          ],
          span: sp,
        },
        alt: null,
        span: sp,
      },
      exprStmt({ type: 'Yield', arg: dot(ident(r, sp), 'value'), delegate: false, span: sp }, sp),
    ];
    return this.stmts([
      exprStmt(assign(ident(it, sp),
        { type: 'Call', callee: symIter, args: [], optional: false, span: sp }, sp), sp),
      {
        type: 'While',
        test: { type: 'Lit', value: true, span: sp },
        body: { type: 'Block', body, span: sp },
        span: sp,
      },
    ], cur, ctx);
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
      if (d.init.type === 'Yield' || d.init.type === 'Await') {
        b = this.suspend(d.init, ident(d.id.name, sp), b, ctx);
        continue;
      }
      if (hasSuspend(d.init)) {
        // 初值**里面**的挂起（`const x = 1 + await f();`）：提到语句层再走一遍
        const lifted = this.lift(d.init, sp);
        if (lifted && lifted.pre.length > 0) {
          b = this.stmts([...lifted.pre,
            exprStmt(assign(ident(d.id.name, sp), lifted.expr, sp), sp)], b, ctx);
          continue;
        }
        this.err(sp, "'yield' / 'await' in this position is not supported; write it as its own statement");
        continue;
      }
      this.emit(b, exprStmt(assign(ident(d.id.name, sp), d.init, sp), sp));
    }
    return b;
  }

  retStmt(s, cur, ctx) {
    const sp = s.span;
    let b = cur;
    let arg = s.arg ? s.arg : undef(sp);
    // `return await e;` 很常见：拆成"等一格 + 返回那一格" —— 用户不必自己动手
    if (s.arg && s.arg.type === 'Await') {
      const t = this.temp('rv');
      b = this.suspend(s.arg, ident(t, sp), b, ctx);
      if (b < 0) return -1;
      arg = ident(t, sp);
    } else if (s.arg && hasSuspend(s.arg)) {
      // `return f(await x);` 这类：把挂起提到语句层，再返回换好临时量的那一格
      const lifted = this.lift(s.arg, sp);
      if (lifted && lifted.pre.length > 0) {
        b = this.stmts(lifted.pre, b, ctx);
        if (b < 0) return -1;
        arg = lifted.expr;
      } else {
        this.err(sp, "'return' of a 'yield' / 'await' is not supported; split it into two statements");
        return -1;
      }
    }
    if (ctx.fin >= 0) {
      // 还在 try 里：先把值收好、标上"在为 return 跑 finally"，再跳到 finally 的入口
      this.emit(b, exprStmt(assign(ident(UNW, sp), num(1, sp), sp), sp));
      this.emit(b, exprStmt(assign(ident(RV, sp), arg, sp), sp));
      this.goto(b, ctx.fin, sp);
      return -1;
    }
    this.emit(b, ret(genRes(arg, true, sp), sp));
    this.term[b] = true;
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
    if (hasSuspend(s.test)) {
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
    if (hasSuspend(s.test)) {
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
    if (hasSuspend(s.test)) {
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
    if ((s.test && hasSuspend(s.test)) || (s.update && hasSuspend(s.update))) {
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
    if (hasSuspend(s.right)) {
      this.err(sp, "'yield' in a for-of header is not supported");
      return cur;
    }
    if (s.left.type !== 'Ident') {
      this.err(sp, "a destructuring for-of variable that a 'yield' crosses is not supported in a generator");
      return cur;
    }
    if (s.declKind) this.hoist.push(s.left.name);
    if (s.await === true) return this.forAwait(s, cur, ctx);
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

  /* `for await (const v of xs)`（ADR-0020 P2）：走异步迭代协议 —— 每一圈 await 一格
   * `it.next()` 的 promise。同步可迭代的兜底在运行期那一侧（`js_aiter` 照规范的
   * CreateAsyncFromSyncIterator 把元素的值也 await 一遍），所以这儿只有一处 await。 */
  forAwait(s, cur, ctx) {
    const sp = s.span;
    if (!this.isAsync) {
      this.err(sp, "'for await' is only allowed in an async function");
      return cur;
    }
    const it = this.temp('ai');
    const r = this.temp('ar');
    this.emit(cur, exprStmt(assign(ident(it, sp), opCall('js_aiter', [s.right], sp), sp), sp));
    const head = this.newBlock();
    const after = this.newBlock();
    const bodyB = this.newBlock();
    const exit = this.newBlock();
    this.goto(cur, head, sp);
    this.awaitTo(head, opCall('js_aiter_next', [ident(it, sp)], sp), after, sp);
    this.emit(after, exprStmt(assign(ident(r, sp), ident(SENT, sp), sp), sp));
    this.emit(after, ifSt(member(ident(r, sp), 'done', sp),
      this.gotoBlock(exit, sp), this.gotoBlock(bodyB, sp), sp));
    this.term[after] = true;
    this.emit(bodyB, exprStmt(assign(ident(s.left.name, sp), member(ident(r, sp), 'value', sp), sp), sp));
    const x = this.stmt(s.body, bodyB, { ...ctx, brk: exit, cont: head });
    if (x >= 0) this.goto(x, head, sp);
    return exit;
  }

  /* try / catch / finally，try 体里有 yield / await 的那一种。三种形状同一段代码：
   *
   *   cur:    _g_cat = catchB（有 catch）；_g_fin = unw（有 finally）；-> bodyB
   *   bodyB:  try 体（切段）。正常走完就把那两格摘下来 -> norm 或 join
   *   catchB: 进来时 _g_cat 已经被 step 开头那一段清了、值在 _g_ex 上 -> 绑参数、跑体
   *   norm:   finally 体（正常那一份）-> join
   *   unw:    finally 体（"非正常出去"那一份）-> 把 return/throw 接回去
   *
   * finally 体因此**发两份**（状态机是平的，没有别的办法让两条路都经过它），所以它自己
   * 不许有 yield / await，也不许有 break/continue/return。
   *
   * `_g_fin` / `_g_cat` 记着"现在活着的 finally / catch 在哪一段"：it.return / it.throw
   * 与"体里抛出来的东西"进来时看它们一眼（step 开头那几个 if，见 modePrologue）。 */
  tryStmt(s, cur, ctx) {
    const sp = s.span;
    if (!s.handler && !s.finalizer) {
      this.err(sp, "'yield' inside a try needs a catch or finally clause to be lowered");
      return cur;
    }
    if (s.handler && ctx.cat >= 0) {
      this.err(sp, 'a nested try/catch around a yield / await is not supported in a generator');
      return cur;
    }
    if (s.finalizer && ctx.fin >= 0) {
      this.err(sp, 'a nested try/finally around a yield / await is not supported in a generator');
      return cur;
    }
    if (s.param && s.param.type !== 'Ident') {
      this.err(sp, "a destructuring catch parameter is not supported around a 'yield' / 'await'");
      return cur;
    }
    if (s.finalizer && hasSuspend(s.finalizer)) {
      this.err(sp, "'yield' / 'await' inside a finally block is not supported");
      return cur;
    }
    if (s.finalizer && (hasFreeBC(s.finalizer) || hasFreeReturn(s.finalizer))) {
      this.err(sp, "'break' / 'continue' / 'return' inside a generator's finally block is not supported");
      return cur;
    }
    const bodyB = this.newBlock();
    const catchB = s.handler ? this.newBlock() : -1;
    const unw = s.finalizer ? this.newBlock() : -1;
    const norm = s.finalizer ? this.newBlock() : -1;
    const join = this.newBlock();
    const setState = (b, name, v) => this.emit(b, exprStmt(assign(ident(name, sp), num(v, sp), sp), sp));
    if (catchB >= 0) setState(cur, CAT, catchB);
    if (unw >= 0) setState(cur, FIN, unw);
    this.goto(cur, bodyB, sp);
    const after = unw >= 0 ? norm : join;
    const x = this.stmts(s.block.body, bodyB, {
      ...ctx, cat: catchB >= 0 ? catchB : ctx.cat, fin: unw >= 0 ? unw : ctx.fin,
    });
    if (x >= 0) {
      if (catchB >= 0) setState(x, CAT, 0);
      if (unw >= 0) setState(x, FIN, 0);
      this.goto(x, after, sp);
    }
    if (catchB >= 0) {
      if (s.param) {
        this.hoist.push(s.param.name);
        this.emit(catchB, exprStmt(assign(ident(s.param.name, sp), ident(EX, sp), sp), sp));
      }
      // catch 体仍在 finally 的保护下（里面的 return 要先跑 finally），但不再被自己接住
      const c = this.stmts(s.handler.body, catchB, {
        ...ctx, cat: ctx.cat, fin: unw >= 0 ? unw : ctx.fin,
      });
      if (c >= 0) {
        if (unw >= 0) setState(c, FIN, 0);
        this.goto(c, after, sp);
      }
    }
    if (unw >= 0) {
      this.emit(norm, s.finalizer);
      this.goto(norm, join, sp);
      setState(unw, FIN, 0);
      if (catchB >= 0) setState(unw, CAT, 0);
      this.emit(unw, s.finalizer);
      this.emit(unw, ifSt(bin('===', ident(UNW, sp), num(2, sp), sp),
        block([{ type: 'Throw', arg: ident(RV, sp), span: sp }], sp), null, sp));
      this.emit(unw, ret(genRes(ident(RV, sp), true, sp), sp));
      this.term[unw] = true;
    }
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

/** step 的开头几句：it.return(v) / it.throw(e) / "体里抛出来的送回来" 进来时先看一眼
 *  有没有活着的 catch 或 finally 要接手（`_g_cat` / `_g_fin`）。 */
function modePrologue(sp) {
  const unwindTo = (kind) => block([
    exprStmt(assign(ident(UNW, sp), num(kind, sp), sp), sp),
    exprStmt(assign(ident(RV, sp), ident(SENT, sp), sp), sp),
    exprStmt(assign(ident(ST, sp), ident(FIN, sp), sp), sp),
  ], sp);
  const noFin = bin('===', ident(FIN, sp), num(0, sp), sp);
  /* 抛进来的那一格（it.throw 与"体里抛出来的"是同一件事）：
   *   有活着的 catch  -> 跳到 catch 段，值放在 _g_ex 上
   *   否则有 finally  -> 跑 finally，跑完把异常接回去（unw 段）
   *   都没有          -> 原样抛回去，让它继续往调用者那边冒 */
  const toCatch = block([
    exprStmt(assign(ident(EX, sp), ident(SENT, sp), sp), sp),
    exprStmt(assign(ident(ST, sp), ident(CAT, sp), sp), sp),
    exprStmt(assign(ident(CAT, sp), num(0, sp), sp), sp),
  ], sp);
  const thrownIn = block([
    ifSt(bin('!==', ident(CAT, sp), num(0, sp), sp), toCatch,
      block([
        ifSt(noFin, block([{ type: 'Throw', arg: ident(SENT, sp), span: sp }], sp), unwindTo(2), sp),
      ], sp), sp),
  ], sp);
  return [
    ifSt(bin('===', ident(MODE, sp), num(1, sp), sp), block([
      ifSt(noFin, block([ret(genRes(ident(SENT, sp), true, sp), sp)], sp), unwindTo(1), sp),
    ], sp), null, sp),
    ifSt(bin('===', ident(MODE, sp), num(2, sp), sp), thrownIn, null, sp),
  ];
}

/**
 * 把一个 `generator: true` / `async: true` 的函数节点改写成普通函数节点。降级器在
 * funcDecl 与 closureOf 的入口调它一次（lower.js），所以嵌套的那些也一样过这条路。
 *
 * 三种尾巴（体切出来的段是同一台机器）：
 *   function*        -> js_gen_new(step)     同步生成器，恢复者是 next()
 *   async function   -> js_async_run(step)   返回一格 promise，恢复者是微任务
 *   async function*  -> js_agen_new(step)    next() 返回 promise；yield 与 await 各一种收尾
 */
export function genToStateMachine(node, err) {
  const sp = node.span;
  const isAsync = node.async === true;
  const isGen = node.generator === true;
  checkNames(node, err);
  const sx = new Split(err, isAsync);
  const entry = sx.newBlock();
  /* 体里顶层的函数声明留在外层函数体上：那儿有降级器的提升（hoistFuncDecls），
   * 而状态机的段是 if 块 —— 声明留在段里就只有那一段看得见它。 */
  const fns = node.body.body.filter((s) => s.type === 'FuncDecl');
  const rest = node.body.body.filter((s) => s.type !== 'FuncDecl');
  const last = sx.stmts(rest, entry, { brk: -1, cont: -1, fin: -1, cat: -1 });
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
    letDecl(CAT, num(0, sp), sp),
    letDecl(EX, undef(sp), sp),
  ];
  for (const f of fns) out.push(f);
  const seen = new Set();
  for (const n of sx.hoist) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(letDecl(n, null, sp));
  }
  out.push({ type: 'VarDecl', kind: 'const', decls: [{ id: ident(STEP, sp), init: step }], span: sp });
  const tail = isGen && isAsync ? 'js_agen_new' : (isAsync ? 'js_async_run' : 'js_gen_new');
  out.push(ret(opCall(tail, [ident(STEP, sp)], sp), sp));
  return { ...node, generator: false, async: false, body: block(out, sp) };
}









