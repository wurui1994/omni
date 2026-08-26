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
 *         | (main STMT...)                          入口体
 *   TYPE  = int | real | bool | string | void
 *   STMT  = (let NAME TYPE E) | (set NAME E) | (do STMT...)
 *         | (if E (do ...) [(do ...)]) | (while E (do ...))
 *         | (ret [E]) | (print E) | (expr E)
 *   E     = (int TEXT) | (real TEXT) | (bool TEXT) | (str "…")
 *         | (var NAME) | (bin "OP" E E) | (un "OP" E) | (call NAME E...)
 *
 * 类型不推导，只**检查**：声明处写死，表达式自底向上定型，两边类型不一致就报错 ——
 * 不插隐式转换。理由与 ADR-0008 一致：这一层的职责是把树接进 OIR，
 * 而"什么能悄悄转成什么"是语言设计决定，不该由汇聚层替某门语言定。
 */

import { INT, REAL, BOOL, STRING, VOID, zeroValue } from '../hir/types.js';
import { readSexpr, isList, isAtom, isStr, head } from './read.js';

const TYPES = new Map([['int', INT], ['real', REAL], ['bool', BOOL], ['string', STRING], ['void', VOID]]);

/** 算术/位运算：两边同型，结果同型。字符串只允许 `+`（拼接，与 Omni 一致）。 */
const ARITH = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);
const COMPARE = new Set(['==', '!=', '<', '<=', '>', '>=']);
const LOGIC = new Set(['&&', '||']);

class CoreLowerer {
  constructor(diags) {
    this.diags = diags;
    this.funcs = new Map();   // 名字 -> {name, mangled, ret, params}
    this.scopes = [];         // 名字 -> OIR 类型
  }

  err(node, msg) {
    this.diags.error(node === undefined || node === null ? null : node.span, msg);
    return null;
  }

  /** 类型名 -> OIR 类型。写错就报错，不猜。 */
  ty(node, what) {
    if (!isAtom(node) || !TYPES.has(node.value)) {
      return this.err(node, `${what} 的类型只能是 int / real / bool / string / void`);
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
      if (head(f) !== 'fn') continue;
      const nm = isAtom(f.items[1]) ? f.items[1].value : null;
      if (nm === null) { this.err(f, '(fn NAME ...) 缺函数名'); continue; }
      if (this.funcs.has(nm)) { this.err(f, `函数 '${nm}' 重复定义`); continue; }
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
      if (h === 'main') {
        if (sawMain) { this.err(f, '(main ...) 只能有一个'); continue; }
        sawMain = true;
        this.scopes = [new Map()];
        for (const s of this.block(f.items.slice(1), VOID)) mainStmts.push(s);
        continue;
      }
      this.err(f, `(module ...) 里只能是 (fn ...) 或 (main ...)，见到 '${h}'`);
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
      if (!sameCoreType(v.type, t)) return this.err(n, `变量 ${nm} 是 ${t.k}，初值是 ${v.type.k}`);
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
      if (!sameCoreType(v.type, t)) return this.err(n, `'${nm}' 是 ${t.k}，赋的值是 ${v.type.k}`);
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
      const body = this.stmt(n.items[2], ret);
      if (body === null) return null;
      return { kind: 'While', cond: c, body: body };
    }
    if (h === 'ret') {
      if (n.items[1] === undefined) {
        if (ret !== VOID) return this.err(n, `这个函数要返回 ${ret.k}，(ret) 没给值`);
        return { kind: 'Return', value: null };
      }
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (!sameCoreType(v.type, ret)) return this.err(n, `要返回 ${ret.k}，给的是 ${v.type.k}`);
      return { kind: 'Return', value: v };
    }
    // 宿主面只有 print 一条，和 WAT 前端同一条理由：格式、换行、四个执行器之间的
    // 一致性全是现成的，不必为新方言再造一份
    if (h === 'print') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      if (v.type === VOID) return this.err(n, 'print 的实参不能是 void');
      return { kind: 'ExprStmt', expr: { kind: 'Builtin', name: 'print', args: [v], type: VOID, argType: v.type } };
    }
    if (h === 'expr') {
      const v = this.expr(n.items[1]);
      if (v === null) return null;
      return { kind: 'ExprStmt', expr: v };
    }
    return this.err(n, `不认识的语句 '${h}'`);
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
      if (d === undefined) return this.err(n, `未声明的函数 '${nm}'`);
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
          return this.err(n, `'${nm}' 的第 ${i + 1} 个形参是 ${d.params[i].type.k}，给的是 ${args[i].type.k}`);
        }
        i++;
      }
      return { kind: 'Call', func: d.mangled, name: d.name, args: args, type: d.ret };
    }
    return this.operator(n, h);
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
    if (!sameCoreType(a.type, b.type)) return this.err(n, `'${op}' 两边要同型：左是 ${a.type.k}，右是 ${b.type.k}`);
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
 * OIR 类型相等。这一层的类型只有五个标量，比一个 `k` 就够。
 * 名字带 Core 不是啰嗦：自举构建把所有模块拍平，模块级名字必须全仓唯一，
 * 而 `hir/types.js` 里已经有一个 `same` —— 撞了只在自举链上报，node 上照跑。
 */
function sameCoreType(a, b) {
  return a.k === b.k;
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

