/**
 * 核心 S 表达式方言 -> OIR。ADR-0014 决策 1 的那**一份**降级。
 *
 * WAT 前端证明了「s-expr 能当前端汇聚点」，但它降的是别人的方言（wasm 的指令表），
 * 语言特有的东西（栈机、位宽、br 的层数）全在那份降级里。所以它不是汇聚点本身，
 * 是汇聚点的第一个使用者。这个文件才是汇聚点：一套**语言中立**的节点形状，
 * 一份降级，谁都能往里发。
 *
 * 于是「加一门语言 = grammar + 映射标注」第一次成立且可测：语法文件的动作模板直接
 * 拼出这些节点（`(bin "+" $1 $3)` 这种），`omni glr` 把它印出来，`omni run` 把它跑掉 ——
 * 中间**没有一行为那门语言写的 JS**。这条是决策 1 验收门槛的硬指标。
 *
 * 方言（刻意小；不够用时加节点，而不是在某门语言的前端里偷偷补语义）：
 *
 *   (module FORM...)
 *   FORM  = (fn NAME ((p TYPE)...) TYPE STMT...)   函数
 *         | (kernel NAME ((p TYPE)...) STMT...)     GPU 核（隐含第一个形参是 gid）
 *         | (main STMT...)                          入口体
 *   TYPE  = int | real | bool | string | void | (vec int|real 2|4|8) | (buf int|real)
 *   STMT  = (let NAME TYPE E) | (set NAME E) | (do STMT...)
 *         | (if E (do ...) [(do ...)]) | (while E (do ...))
 *         | (brk) | (cont)
 *         | (ret [E]) | (print E) | (expr E)
 *         | (bset E E E) | (dispatch NAME E E...)
 *   E     = (int TEXT) | (real TEXT) | (bool TEXT) | (str "…") | (tostr E) | (tostr E N)
 *         | (toreal E) | (toint E)
 *         | (var NAME) | (bin "OP" E E) | (un "OP" E) | (call NAME E...)
 *         | (splat TYPE E) | (vlit TYPE E...) | (lane E N) | (hsum E)
 *         | (bnew TYPE E) | (bget E E) | (blen E) | (gid)
 *
 * 向量那四条是 ADR-0014 门槛 6 的第一阶段，见 vecExpr 的注释；
 * 缓冲与 kernel/dispatch 是门槛 7 的第一阶段，见 bufExpr 与 dispatch 的注释。
 *
 * 类型不推导，只**检查**：声明处写死，表达式自底向上定型，两边类型不一致就报错 ——
 * 不插隐式转换。理由与 ADR-0008 一致：这一层的职责是把树接进 OIR，
 * 而"什么能悄悄转成什么"是语言设计决定，不该由汇聚层替某门语言定。
 */

import { INT, REAL, BOOL, STRING, VOID, vecType, bufType, zeroValue } from '../hir/types.js';
import { readSexpr, isList, isAtom, isStr, head } from './read.js';

const TYPES = new Map([['int', INT], ['real', REAL], ['bool', BOOL], ['string', STRING], ['void', VOID]]);

/** 向量宽度：2 的幂，上界 8。放宽之前先想清楚 C 那条腿要展开多少行。 */
const VEC_LANES = new Set([2, 4, 8]);

/** 算术/位运算：两边同型，结果同型。字符串只允许 `+`（拼接，与 Omni 一致）。 */
const ARITH = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);
const COMPARE = new Set(['==', '!=', '<', '<=', '>', '>=']);
const LOGIC = new Set(['&&', '||']);

class CoreLowerer {
  constructor(diags) {
    this.diags = diags;
    this.funcs = new Map();   // 名字 -> {name, mangled, ret, params}
    this.scopes = [];         // 名字 -> OIR 类型
    // kernel 与函数分开登记：kernel 只能被 (dispatch ...) 启动，(call ...) 要报错说清这件事。
    // 它在 OIR 里就是一个普通函数，第一个形参是隐含的 gid —— 于是「同一份 MIR 在 CPU 上跑」
    // 不需要任何新机制（门槛 7 要比的就是这个 CPU 结果），dispatch 只是一个循环。
    this.kernels = new Map();
    this.inKernel = false;
    this.tmpNo = 0;           // dispatch 展开出来的临时量编号，保证名字唯一
    this.loopDepth = 0;       // (brk) / (cont) 只在循环里合法，跟 hir/check.js 同一条规矩
  }

  err(node, msg) {
    this.diags.error(node === undefined || node === null ? null : node.span, msg);
    return null;
  }

  /** 类型名 -> OIR 类型。写错就报错，不猜。 */
  ty(node, what) {
    // `(buf int|real)`：一段连续的元素 + 一个运行期长度（门槛 7 第一阶段）
    if (isList(node) && head(node) === 'buf') {
      const e = isAtom(node.items[1]) ? TYPES.get(node.items[1].value) : undefined;
      if (e === undefined || (e !== INT && e !== REAL)) {
        return this.err(node, `${what}：(buf 元素) 的元素只能是 int 或 real`);
      }
      return bufType(e);
    }
    // `(vec int 4)`：元素只能是 int/real（bool/string 的向量没有意义，也没有硬件对应）
    if (isList(node) && head(node) === 'vec') {
      const e = isAtom(node.items[1]) ? TYPES.get(node.items[1].value) : undefined;
      const n = isAtom(node.items[2]) ? Number(node.items[2].value) : NaN;
      if (e === undefined || (e !== INT && e !== REAL)) {
        return this.err(node, `${what}：(vec 元素 宽度) 的元素只能是 int 或 real`);
      }
      if (!VEC_LANES.has(n)) return this.err(node, `${what}：向量宽度只能是 2 / 4 / 8`);
      return vecType(e, n);
    }
    if (!isAtom(node) || !TYPES.has(node.value)) {
      return this.err(node, `${what} 的类型只能是 int / real / bool / string / void / (vec T N) / (buf T)`);
    }
    return TYPES.get(node.value);
  }

  lookup(name) {
    let i = this.scopes.length - 1;
    while (i >= 0) {
      if (this.scopes[i].has(name)) return this.scopes[i].get(name);
      i--;
    }
    return null;
  }

  /* -------------------------------------------------------------- 模块 */

  run(nodes) {
    const top = nodes.length === 1 && head(nodes[0]) === 'module' ? nodes[0] : null;
    if (top === null) {
      this.err(nodes[0], '一份核心方言的源文件是恰好一个 (module ...)');
      return null;
    }
    const forms = top.items.slice(1);
    // 两遍：先收签名，函数才能互相调用（也才能递归）
    for (const f of forms) {
      const h = head(f);
      if (h !== 'fn' && h !== 'kernel') continue;
      const nm = isAtom(f.items[1]) ? f.items[1].value : null;
      if (nm === null) { this.err(f, `(${h} NAME ...) 缺名字`); continue; }
      if (this.funcs.has(nm) || this.kernels.has(nm)) { this.err(f, `'${nm}' 重复定义`); continue; }
      if (h === 'kernel') {
        const ps = this.params(f.items[2]);
        if (ps === null) continue;
        // 隐含的第一个形参就是 gid。名字带 `$` 是刻意的：方言里写不出这个标识符，
        // 所以它不可能被用户的名字遮蔽，(gid) 是读它的唯一途径。
        const all = [{ name: '$gid', type: INT }];
        for (const p of ps) all.push(p);
        this.kernels.set(nm, { name: nm, mangled: `k_${nm}`, ret: VOID, params: all });
        continue;
      }
      const ps = this.params(f.items[2]);
      const ret = this.ty(f.items[3], `函数 ${nm} 的返回值`);
      if (ps === null || ret === null) continue;
      this.funcs.set(nm, { name: nm, mangled: `s_${nm}`, ret: ret, params: ps });
    }
    return this.assemble(forms);
  }

  /** `((p int) (q real))` -> OIR 形参表。 */
  params(node) {
    if (!isList(node)) return this.err(node, '形参表要写成 ((名字 类型) ...)');
    const out = [];
    for (const p of node.items) {
      if (!isList(p) || p.items.length !== 2 || !isAtom(p.items[0])) {
        this.err(p, '一个形参是 (名字 类型)');
        return null;
      }
      const t = this.ty(p.items[1], `形参 ${p.items[0].value}`);
      if (t === null) return null;
      out.push({ name: p.items[0].value, type: t });
    }
    return out;
  }

  assemble(forms) {
    const funcs = [];
    const mainStmts = [];
    let sawMain = false;
    for (const f of forms) {
      const h = head(f);
      if (h === 'fn') {
        const nm = isAtom(f.items[1]) ? f.items[1].value : null;
        const d = nm === null ? undefined : this.funcs.get(nm);
        if (d === undefined) continue;
        this.scopes = [new Map()];
        for (const p of d.params) this.scopes[0].set(p.name, p.type);
        const body = this.block(f.items.slice(4), d.ret);
        // 掉出函数体：非 void 补一个零值 return，与 WAT 前端同一处理（那边也是这样）
        if (d.ret !== VOID) body.push({ kind: 'Return', value: zeroValue(d.ret) });
        else body.push({ kind: 'Return', value: null });
        funcs.push({ name: d.name, mangled: d.mangled, ret: d.ret, params: d.params, body: { kind: 'Block', stmts: body } });
        continue;
      }
      if (h === 'kernel') {
        const nm = isAtom(f.items[1]) ? f.items[1].value : null;
        const d = nm === null ? undefined : this.kernels.get(nm);
        if (d === undefined) continue;
        this.scopes = [new Map()];
        for (const p of d.params) this.scopes[0].set(p.name, p.type);
        this.inKernel = true;
        const body = this.block(f.items.slice(3), VOID);
        this.inKernel = false;
        body.push({ kind: 'Return', value: null });
        // kernel 在 OIR 里就是一个普通 void 函数。`kernel: true` 是给后端的**标注**，
        // 不改语义：SPIR-V 那条腿按它挑要发的函数，其余五条腿完全不看它。
        funcs.push({ name: d.name, mangled: d.mangled, ret: VOID, params: d.params, kernel: true, body: { kind: 'Block', stmts: body } });
        continue;
      }
      if (h === 'main') {
        if (sawMain) { this.err(f, '(main ...) 只能有一个'); continue; }
        sawMain = true;
        this.scopes = [new Map()];
        for (const s of this.block(f.items.slice(1), VOID)) mainStmts.push(s);
        continue;
      }
      this.err(f, `(module ...) 里只能是 (fn ...) / (kernel ...) / (main ...)，见到 '${h}'`);
    }
    if (!sawMain) this.err(null, '缺入口：加一个 (main ...)');
    mainStmts.push({ kind: 'Return', value: null });
    funcs.push({ name: 'main', mangled: 'omni_main', ret: VOID, params: [], body: { kind: 'Block', stmts: mainStmts } });
    return {
      structs: [], classes: [], enums: [], containers: [], closures: [], fnTypes: [],
      funcs: funcs,
      entry: 'omni_main',
    };
  }

  /* -------------------------------------------------------------- 语句 */

  block(nodes, ret) {
    const out = [];
    for (const s of nodes) {
      const st = this.stmt(s, ret);
      if (st !== null) out.push(st);
    }
    return out;
  }

  stmt(n, ret) {
    if (!isList(n)) return this.err(n, '语句要写成一个 (…) 形式');
    const h = head(n);
    if (h === 'do') {
      this.scopes.push(new Map());
      const body = this.block(n.items.slice(1), ret);
      this.scopes.pop();
      return { kind: 'Block', stmts: body };
    }
    if (h === 'let') {
      const nm = isAtom(n.items[1]) ? n.items[1].value : null;
      if (nm === null) return this.err(n, '(let 名字 类型 值)');
      const t = this.ty(n.items[2], `变量 ${nm}`);
      if (t === null) return null;
      const v = this.expr(n.items[3]);
      if (v === null) return null;
      if (!sameCoreType(v.type, t)) return this.err(n, `变量 ${nm} 是 ${coreTypeText(t)}，初值是 ${coreTypeText(v.type)}`);
      // 同一层里重名是错的；外层同名是遮蔽，合法
      if (this.scopes[this.scopes.length - 1].has(nm)) return this.err(n, `'${nm}' 在这一层已经声明过了`);
      this.scopes[this.scopes.length - 1].set(nm, t);
      return { kind: 'Local', name: nm, type: t, init: v };
    }
    if (h === 'set') {
      const nm = isAtom(n.items[1]) ? n.items[1].value : null;
      if (nm === null) return this.err(n, '(set 名字 值)');
      const t = this.lookup(nm);
      if (t === null) return this.err(n, `未声明的变量 '${nm}'`);
      const v = this.expr(n.items[2]);
      if (v === null) return null;
      if (!sameCoreType(v.type, t)) return this.err(n, `'${nm}' 是 ${coreTypeText(t)}，赋的值是 ${coreTypeText(v.type)}`);
      return { kind: 'ExprStmt', expr: { kind: 'Assign', target: { kind: 'VarRef', name: nm, type: t }, value: v, type: t } };
    }
    return this.stmt2(n, h, ret);
  }

  stmt2(n, h, ret) {
    if (h === 'if') {
      const c = this.cond(n.items[1]);
      if (c === null) return null;
      const then = this.stmt(n.items[2], ret);
      if (then === null) return null;
      const els = n.items[3] === undefined ? null : this.stmt(n.items[3], ret);
      return { kind: 'If', cond: c, then: then, otherwise: els };
    }
    if (h === 'while') {
      const c = this.cond(n.items[1]);
      if (c === null) return null;
      this.loopDepth++;
      const body = this.stmt(n.items[2], ret);
      this.loopDepth--;
      if (body === null) return null;
      return { kind: 'While', cond: c, body: body };
    }
    // `(brk)` / `(cont)`：OIR 里 Break / Continue 早就有，方言这边一直没开口。
    // 补上不是为 asy 特设的 —— 任何 C 系语言的循环都要它，而"用标志位绕开 break"
    // 会把控制流塞进数据流里，六条腿上都更难读。
    if (h === 'brk' || h === 'cont') {
      if (this.loopDepth === 0) return this.err(n, `(${h}) 只能写在循环里`);
      return { kind: h === 'brk' ? 'Break' : 'Continue' };
    }
    if (h === 'ret') {
      if (n.items[1] === undefined) {
        if (ret !== VOID) return this.err(n, `这个函数要返回 ${ret.k}，(ret) 没给值`);
        return { kind: 'Return', value: null };
      }
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (!sameCoreType(v.type, ret)) return this.err(n, `要返回 ${coreTypeText(ret)}，给的是 ${coreTypeText(v.type)}`);
      return { kind: 'Return', value: v };
    }
    // 宿主面只有 print 一条，和 WAT 前端同一条理由：格式、换行、四个执行器之间的
    // 一致性全是现成的，不必为新方言再造一份
    if (h === 'print') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (v.type === VOID) return this.err(n, 'print 的实参不能是 void');
      // 向量没有 print：运行时没有对应的输出函数，而"随便定一个格式"意味着六个执行器
      // 各自实现一遍格式化 —— 那是最容易分叉的地方。要看向量就 (lane v k) 逐道印。
      if (v.type.k === 'vec') return this.err(n, 'print 不接受向量：用 (lane v N) 逐道印');
      if (v.type.k === 'buf') return this.err(n, 'print 不接受缓冲：用 (bget b i) 逐个印');
      return { kind: 'ExprStmt', expr: { kind: 'Builtin', name: 'print', args: [v], type: VOID, argType: v.type } };
    }
    if (h === 'expr') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      return { kind: 'ExprStmt', expr: v };
    }
    if (h === 'bset') return this.bufSet(n);
    if (h === 'dispatch') return this.dispatch(n);
    return this.err(n, `不认识的语句 '${h}'`);
  }

  /** `(bset 缓冲 下标 值)`。写回是语句而不是表达式：它的"值"没人用，留着只会多一条路。 */
  bufSet(n) {
    const b = this.expr(n.items[1]);
    const i = this.expr(n.items[2]);
    const v = this.expr(n.items[3]);
    if (b === null || i === null || v === null) return null;
    if (b.type.k !== 'buf') return this.err(n, `bset 的第一个实参要是缓冲，这里是 ${coreTypeText(b.type)}`);
    if (i.type !== INT) return this.err(n, `bset 的下标要是 int，这里是 ${coreTypeText(i.type)}`);
    if (!sameCoreType(v.type, b.type.elem)) {
      return this.err(n, `这个缓冲装 ${b.type.elem.k}，写进去的是 ${coreTypeText(v.type)}`);
    }
    return { kind: 'ExprStmt', expr: { kind: 'BufSet', buf: b, index: i, value: v, type: b.type.elem } };
  }

  /**
   * `(dispatch NAME 网格 实参...)`：把一个 kernel 在 `[0, 网格)` 上跑一遍。
   *
   * 在这里就展开成「临时量 + while 循环 + 普通调用」，不留一个 OIR 节点 ——
   * 于是六个执行器一行都不用改，而 CPU 上的答案就是门槛 7 要比的那个答案。
   * GPU 那条腿看的是 kernel 函数本身（`kernel: true` 标注）与这里的网格大小，
   * 不是这个循环：循环是"没有 GPU 时怎么执行"的定义，不是语义的一部分。
   *
   * 实参先各绑一个临时量再进循环：`(dispatch k (blen b) (bget b 0))` 这种写法里
   * 实参表达式只该求值一次。
   */
  dispatch(n) {
    const nm = isAtom(n.items[1]) ? n.items[1].value : null;
    if (nm === null) return this.err(n, '(dispatch NAME 网格 实参...)');
    const d = this.kernels.get(nm);
    if (d === undefined) {
      return this.err(n, this.funcs.has(nm) ? `'${nm}' 是函数，不是 kernel` : `未声明的 kernel '${nm}'`);
    }
    const grid = this.expr(n.items[2]);
    if (grid === null) return null;
    if (grid.type !== INT) return this.err(n, `网格大小要是 int，这里是 ${coreTypeText(grid.type)}`);
    const args = [];
    for (const a of n.items.slice(3)) {
      const v = this.expr(a);
      if (v === null) return null;
      args.push(v);
    }
    // 形参表里第一个是隐含的 gid，所以实参个数比形参个数少一个
    if (args.length !== d.params.length - 1) {
      return this.err(n, `kernel '${nm}' 要 ${d.params.length - 1} 个实参，给了 ${args.length} 个`);
    }
    let i = 0;
    while (i < args.length) {
      if (!sameCoreType(args[i].type, d.params[i + 1].type)) {
        return this.err(n, `kernel '${nm}' 的第 ${i + 1} 个形参是 ${coreTypeText(d.params[i + 1].type)}，给的是 ${coreTypeText(args[i].type)}`);
      }
      i++;
    }
    const tag = this.tmpNo;
    this.tmpNo++;
    const nVar = `$n${tag}`;
    const gVar = `$g${tag}`;
    const stmts = [
      { kind: 'Local', name: nVar, type: INT, init: grid },
      { kind: 'Local', name: gVar, type: INT, init: { kind: 'Const', type: INT, value: 0n } },
    ];
    const callArgs = [{ kind: 'VarRef', name: gVar, type: INT }];
    let k = 0;
    while (k < args.length) {
      const an = `$a${tag}_${k}`;
      stmts.push({ kind: 'Local', name: an, type: args[k].type, init: args[k] });
      callArgs.push({ kind: 'VarRef', name: an, type: args[k].type });
      k++;
    }
    const gRef = { kind: 'VarRef', name: gVar, type: INT };
    const step = {
      kind: 'ExprStmt',
      expr: {
        kind: 'Assign',
        target: gRef,
        value: { kind: 'Bin', op: '+', opType: INT, left: gRef, right: { kind: 'Const', type: INT, value: 1n }, type: INT },
        type: INT,
      },
    };
    stmts.push({
      kind: 'While',
      cond: { kind: 'Cmp', op: '<', opType: INT, left: gRef, right: { kind: 'VarRef', name: nVar, type: INT }, type: BOOL },
      body: {
        kind: 'Block',
        stmts: [
          { kind: 'ExprStmt', expr: { kind: 'Call', func: d.mangled, name: d.name, args: callArgs, type: VOID } },
          step,
        ],
      },
    });
    return { kind: 'Block', stmts: stmts };
  }

  /** 条件位置：必须是 bool，不做真值化 —— 那是各门语言自己的规则。 */
  cond(n) {
    const c = this.expr(n);
    if (c === null) return null;
    if (c.type !== BOOL) return this.err(n, `条件要是 bool，这里是 ${c.type.k}`);
    return c;
  }

  /* ------------------------------------------------------------ 表达式 */

  expr(n) {
    if (n === undefined) return this.err(null, '少了一个表达式');
    if (!isList(n)) return this.err(n, '表达式要写成一个 (…) 形式（常量也要：(int 1)）');
    const h = head(n);
    if (h === 'int') return this.intLit(n);
    if (h === 'real') return this.realLit(n);
    if (h === 'bool') {
      const v = isAtom(n.items[1]) ? n.items[1].value : null;
      if (v !== 'true' && v !== 'false') return this.err(n, '(bool true) 或 (bool false)');
      return { kind: 'Const', type: BOOL, value: v === 'true' };
    }
    if (h === 'str') {
      if (!isStr(n.items[1])) return this.err(n, '(str "…") 要一个字符串字面量');
      return { kind: 'Const', type: STRING, value: n.items[1].value };
    }
    // `(tostr E)`：数值/布尔 -> 字符串。OIR 的 `to_string` 早就在（四个消费方都认它），
    // 方言这边一直没开口，于是"把数拼进一句话里"在这一层根本写不出来 —— 而那是任何
    // 语言的 `write("x = ", x)` 都要的。刻意**不**做隐式转换：`+` 两边照旧必须同型，
    // 要拼就显式写出这一步。格式跟 print 的同一份（ADR-0005 的 %.6g），不另造一份。
    if (h === 'tostr') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      const k = v.type.k;
      if (k !== 'int' && k !== 'real' && k !== 'bool') {
        return this.err(n, `(tostr E) 只接受 int / real / bool，这里是 ${coreTypeText(v.type)}`);
      }
      if (n.items[2] === undefined) {
        return { kind: 'Builtin', name: 'to_string', args: [v], type: STRING, argType: v.type };
      }
      // `(tostr E N)`：按 **N 位有效数字** 格式化，只对 real 有意义。加它是因为默认那份
      // %.6g 是"看值用的"（ADR-0005），而别的语言有自己的默认位数 —— asy 是 %.15g，
      // 逐字节对不上就等于没做。N 只收 1..17 的字面量：位数是格式的一部分，不是运行期
      // 才知道的东西，写死了后端就能把它当常量传下去，也不会出现 %.0g 这种没有定义的东西。
      if (k !== 'real') return this.err(n, `(tostr E N) 的位数只对 real 有意义，这里是 ${coreTypeText(v.type)}`);
      const p = this.expr(n.items[2]);
      if (p === null) return null;
      if (p.kind !== 'Const' || p.type.k !== 'int') return this.err(n.items[2], '(tostr E N) 的 N 要是 int 字面量');
      const digits = Number(p.value);
      if (!Number.isInteger(digits) || digits < 1 || digits > 17) {
        return this.err(n.items[2], `(tostr E N) 的 N 要在 1..17 之间，这里是 ${digits}`);
      }
      return { kind: 'Builtin', name: 'to_string_g', args: [v, p], type: STRING, argType: REAL };
    }
    // `(toreal E)` / `(toint E)`：int <-> real 的**显式**转换。同一条纪律：类型不推导、
    // 不插隐式转换，所以两个方向都得写出来。OIR 侧两个都是现成的（Cast int->real、
    // trunc real->int），方言这边原先没开口 —— 而 asy 的 `1/3` 是实数除法、`(int) 3.7`
    // 是截断，没有这两条就一句都降不下来。
    if (h === 'toreal' || h === 'toint') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      const want = h === 'toreal' ? 'int' : 'real';
      if (v.type.k !== want) {
        return this.err(n, `(${h} E) 的参数要是 ${want}，这里是 ${coreTypeText(v.type)}`);
      }
      if (h === 'toreal') return { kind: 'Cast', type: REAL, from: INT, expr: v };
      return { kind: 'Builtin', name: 'trunc', args: [v], type: INT, argType: REAL };
    }
    if (h === 'var') {
      const nm = isAtom(n.items[1]) ? n.items[1].value : null;
      if (nm === null) return this.err(n, '(var 名字)');
      const t = this.lookup(nm);
      if (t === null) return this.err(n, `未声明的变量 '${nm}'`);
      return { kind: 'VarRef', name: nm, type: t };
    }
    if (h === 'call') {
      const nm = isAtom(n.items[1]) ? n.items[1].value : null;
      if (nm === null) return this.err(n, '(call 名字 实参...)');
      const d = this.funcs.get(nm);
      if (d === undefined) {
        return this.err(n, this.kernels.has(nm)
          ? `'${nm}' 是 kernel，要用 (dispatch ${nm} 网格 实参...) 启动`
          : `未声明的函数 '${nm}'`);
      }
      const args = [];
      for (const a of n.items.slice(2)) {
        const v = this.expr(a);
        if (v === null) return null;
        args.push(v);
      }
      if (args.length !== d.params.length) {
        return this.err(n, `'${nm}' 要 ${d.params.length} 个实参，给了 ${args.length} 个`);
      }
      let i = 0;
      while (i < args.length) {
        if (!sameCoreType(args[i].type, d.params[i].type)) {
          return this.err(n, `'${nm}' 的第 ${i + 1} 个形参是 ${coreTypeText(d.params[i].type)}，给的是 ${coreTypeText(args[i].type)}`);
        }
        i++;
      }
      return { kind: 'Call', func: d.mangled, name: d.name, args: args, type: d.ret };
    }
    if (h === 'splat' || h === 'vlit' || h === 'lane' || h === 'hsum') return this.vecExpr(n, h);
    if (h === 'bnew' || h === 'bget' || h === 'blen') return this.bufExpr(n, h);
    if (h === 'gid') {
      if (!this.inKernel) return this.err(n, '(gid) 只在 kernel 里有意义');
      return { kind: 'VarRef', name: '$gid', type: INT };
    }
    return this.operator(n, h);
  }

  /**
   * 缓冲的三条读侧（写侧是语句 `bset`）。
   *
   *   (bnew (buf T) N)   新建长度 N 的零缓冲
   *   (bget b i)         读第 i 个
   *   (blen b)           长度
   *
   * 越界是**运行期错误**，消息与 list 那套同一个形状（`buffer index out of range: i (length n)`）。
   * GPU 上没有这条错误路径 —— 那边的约定是 kernel 自己用 `(blen b)` 守门，
   * 越界属于程序的 bug；CPU 这五条腿会当场报出来，正是想要的：错误在 CPU 上暴露。
   */
  bufExpr(n, h) {
    if (h === 'bnew') {
      const t = this.ty(n.items[1], 'bnew 的类型');
      if (t === null) return null;
      if (t.k !== 'buf') return this.err(n, '(bnew TYPE N) 的 TYPE 要是 (buf T)');
      const c = this.expr(n.items[2]);
      if (c === null) return null;
      if (c.type !== INT) return this.err(n, `bnew 的长度要是 int，这里是 ${coreTypeText(c.type)}`);
      return { kind: 'BufNew', type: t, count: c };
    }
    const b = this.expr(n.items[1]);
    if (b === null) return null;
    if (b.type.k !== 'buf') return this.err(n, `${h} 的实参要是缓冲，这里是 ${coreTypeText(b.type)}`);
    if (h === 'blen') return { kind: 'BufLen', buf: b, type: INT };
    const i = this.expr(n.items[2]);
    if (i === null) return null;
    if (i.type !== INT) return this.err(n, `bget 的下标要是 int，这里是 ${coreTypeText(i.type)}`);
    return { kind: 'BufGet', buf: b, index: i, type: b.type.elem };
  }

  /**
   * 向量的四条（ADR-0014 门槛 6 第一阶段）。刻意只有这四条 —— 比较、select、shuffle、
   * 从容器加载都还没有，因为每一条都要在六个执行器上各实现一次，而它们的答案要逐位相同。
   *
   *   (splat TYPE E)     标量铺满所有道
   *   (vlit TYPE E...)   逐道给值，个数必须等于宽度
   *   (lane E N)         取第 N 道（N 是字面量，不是表达式 —— 变量下标要边界检查，
   *                      而那会给两条腿各引入一条错误路径，下一阶段再说）
   *   (hsum E)           水平求和。**求值顺序写死成严格左到右**：((v0+v1)+v2)+v3。
   *                      浮点加法不结合，这一条就是门槛 6 里「固定求值顺序」的落点 ——
   *                      两条腿必须发同一棵树，而不是各自挑一个规约形状。
   */
  vecExpr(n, h) {
    if (h === 'lane') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (v.type.k !== 'vec') return this.err(n, `lane 的实参要是向量，这里是 ${v.type.k}`);
      const i = isAtom(n.items[2]) ? Number(n.items[2].value) : NaN;
      if (!Number.isInteger(i) || i < 0 || i >= v.type.lanes) {
        return this.err(n, `(lane v N) 的 N 要是 0..${v.type.lanes - 1} 的字面量`);
      }
      return { kind: 'VecLane', vec: v, lane: i, type: v.type.elem };
    }
    if (h === 'hsum') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (v.type.k !== 'vec') return this.err(n, `hsum 的实参要是向量，这里是 ${v.type.k}`);
      return { kind: 'VecHsum', vec: v, type: v.type.elem };
    }
    const t = this.ty(n.items[1], h === 'splat' ? 'splat 的类型' : 'vlit 的类型');
    if (t === null) return null;
    if (t.k !== 'vec') return this.err(n, `(${h} TYPE ...) 的 TYPE 要是 (vec T N)`);
    if (h === 'splat') {
      const v = this.expr(n.items[2]);
      if (v === null) return null;
      if (!sameCoreType(v.type, t.elem)) {
        return this.err(n, `splat 的值要是 ${t.elem.k}，这里是 ${v.type.k}`);
      }
      return { kind: 'VecSplat', value: v, type: t };
    }
    const lanes = [];
    for (const a of n.items.slice(2)) {
      const v = this.expr(a);
      if (v === null) return null;
      if (!sameCoreType(v.type, t.elem)) {
        return this.err(a, `vlit 的每一道要是 ${t.elem.k}，这里是 ${v.type.k}`);
      }
      lanes.push(v);
    }
    if (lanes.length !== t.lanes) {
      return this.err(n, `vlit 要 ${t.lanes} 个值，给了 ${lanes.length} 个`);
    }
    return { kind: 'VecLit', lanes: lanes, type: t };
  }

  /** `(bin "OP" a b)` / `(un "OP" a)`。算符写成字符串，所以映射模板里可以直接 `(bin $2 $1 $3)`。 */
  operator(n, h) {
    if (h === 'un') {
      const op = isStr(n.items[1]) ? n.items[1].value : null;
      const a = this.expr(n.items[2]);
      if (op === null || a === null) return op === null ? this.err(n, '(un "OP" 值)') : null;
      if (op === '-') {
        if (a.type !== INT && a.type !== REAL) return this.err(n, `一元 - 要 int 或 real，这里是 ${a.type.k}`);
        return { kind: 'Un', op: '-', operand: a, type: a.type };
      }
      if (op === '!') {
        if (a.type !== BOOL) return this.err(n, `! 要 bool，这里是 ${a.type.k}`);
        return { kind: 'Un', op: '!', operand: a, type: BOOL };
      }
      return this.err(n, `不认识的一元算符 '${op}'`);
    }
    if (h !== 'bin') return this.err(n, `不认识的表达式 '${h}'`);
    const op = isStr(n.items[1]) ? n.items[1].value : null;
    if (op === null) return this.err(n, '(bin "OP" 左 右)：算符要写成字符串');
    const a = this.expr(n.items[2]);
    const b = this.expr(n.items[3]);
    if (a === null || b === null) return null;
    if (!sameCoreType(a.type, b.type)) return this.err(n, `'${op}' 两边要同型：左是 ${coreTypeText(a.type)}，右是 ${coreTypeText(b.type)}`);
    // 向量：只有逐元素的四则运算。比较要出 vec<bool,N>（掩码类型），select 要三目 ——
    // 两条都得先在六个执行器上定好语义，第一阶段不做，所以在这里挡住而不是给错答案。
    if (a.type.k === 'vec') {
      if (op !== '+' && op !== '-' && op !== '*' && op !== '/') {
        return this.err(n, `向量上第一阶段只有 + - * /，不能用 '${op}'`);
      }
      return { kind: 'Bin', op: op, opType: a.type, left: a, right: b, type: a.type };
    }
    if (LOGIC.has(op)) {
      if (a.type !== BOOL) return this.err(n, `'${op}' 要 bool，这里是 ${a.type.k}`);
      return { kind: 'Logic', op: op, left: a, right: b, type: BOOL };
    }
    if (COMPARE.has(op)) {
      return { kind: 'Cmp', op: op, opType: a.type, left: a, right: b, type: BOOL };
    }
    if (!ARITH.has(op)) return this.err(n, `不认识的二元算符 '${op}'`);
    if (a.type === STRING && op !== '+') return this.err(n, `string 上只有 '+'（拼接），不能用 '${op}'`);
    if (a.type === BOOL) return this.err(n, `'${op}' 不能作用在 bool 上`);
    if (a.type === REAL && (op === '%' || op === '&' || op === '|' || op === '^' || op === '<<' || op === '>>')) {
      return this.err(n, `'${op}' 只对 int 成立，这里是 real`);
    }
    return { kind: 'Bin', op: op, opType: a.type, left: a, right: b, type: a.type };
  }

  intLit(n) {
    const s = isAtom(n.items[1]) ? n.items[1].value : null;
    if (s === null || !/^[+-]?[0-9]+$/.test(s)) return this.err(n, '(int 十进制整数)');
    return { kind: 'Const', type: INT, value: BigInt(s) };
  }

  realLit(n) {
    const s = isAtom(n.items[1]) ? n.items[1].value : null;
    if (s === null || !/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(s)) {
      return this.err(n, '(real 十进制小数)');
    }
    return { kind: 'Const', type: REAL, value: Number(s) };
  }
}

/**
 * OIR 类型相等。标量比一个 `k` 就够；向量还要比元素与宽度，
 * 否则 vec<int,4> 与 vec<real,8> 会被当成同一个类型（两者的 `k` 都是 'vec'）。
 * 名字带 Core 不是啰嗦：自举构建把所有模块拍平，模块级名字必须全仓唯一，
 * 而 `hir/types.js` 里已经有一个 `same` —— 撞了只在自举链上报，node 上照跑。
 */
function sameCoreType(a, b) {
  if (a.k !== b.k) return false;
  if (a.k === 'vec') return a.elem.k === b.elem.k && a.lanes === b.lanes;
  if (a.k === 'buf') return a.elem.k === b.elem.k;
  return true;
}

/**
 * 诊断里的类型拼写。标量就是 `k`，向量要连元素和宽度一起说 ——
 * 否则「左是 vec，右是 vec」这种消息等于没说（vec<int,2> 和 vec<real,4> 的 `k` 都是 vec）。
 */
function coreTypeText(t) {
  if (t.k === 'vec') return `vec<${t.elem.k},${t.lanes}>`;
  if (t.k === 'buf') return `buf<${t.elem.k}>`;
  return t.k;
}

/**
 * 核心方言的源文本 -> OIR。`.sx` 文件走这条，`omni glr` 的输出也走这条 ——
 * 后者才是重点：语法文件的映射模板拼出这份方言，中间没有为那门语言写的一行代码。
 */
export function lowerCoreSexpr(file, diags) {
  const nodes = readSexpr(file, diags);
  if (diags.hasErrors()) return null;
  return new CoreLowerer(diags).run(nodes);
}

