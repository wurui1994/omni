// src/core/lower/lower-stmt.js —— 公共降级器的语句降级（ADR-0044）
//
// 标准 IR 的语句描述 → .sx text。所有语言共用。
// 每门语言的 adapter 把 CST 翻成 §1.2 的标准描述，这一份接手。

import * as sx from './sx.js';
import { typeToSx, zeroOf } from './ty.js';

/**
 * 降级一条语句。回一段 .sx 文本（可能多行）。
 *
 * @param {object} stmt  标准 IR 语句描述（§1.2 的形状）
 * @param {object} ctx   降级上下文 { scope, typeEnv, lowerExpr, lowerStmts, hooks }
 * @returns {string}     .sx 文本
 */
export function lowerStmt(stmt, ctx) {
  switch (stmt.kind) {
    case 'if': return lowerIf(stmt, ctx);
    case 'while': return lowerWhile(stmt, ctx);
    case 'for': return lowerFor(stmt, ctx);
    case 'for-range': return lowerForRange(stmt, ctx);
    case 'return': return lowerReturn(stmt, ctx);
    case 'break': return lowerBreak(stmt, ctx);
    case 'continue': return lowerContinue(stmt, ctx);
    case 'let': return lowerLet(stmt, ctx);
    case 'assign': return lowerAssign(stmt, ctx);
    case 'expr-stmt': return lowerExprStmt(stmt, ctx);
    case 'block': return lowerBlock(stmt, ctx);
    /**
     * **真正的作用域出口**（`{ kind: 'scope', stmts, exits }`）：`exits` 里那几句在
     * **每一个离开这层的出口**上跑一遍 —— 走到底、`return`、以及跳出这层的 `break`/`continue`。
     *
     * 六门语言在做同一件事（C++ 的析构 / go 与 V 的 `defer` / nim 的 `defer:` /
     * freebasic 的析构 / mojo 的 `with`），从前各自在 adapter 里手写"每个出口逆序补一遍" ——
     * 那是六份同样的代码，而且漏一个出口就是**静默地少跑一段**。所以它的家在这一层。
     *
     * **次序由 adapter 定**（`exits` 照它给的顺序发）：C++ 与 go 都是逆序注册，
     * 那是那门语言的规矩，不是这一层的。
     */
    case 'scope': return lowerScope(stmt, ctx);
    case 'switch': return lowerSwitch(stmt, ctx);
    case 'print': return lowerPrint(stmt, ctx);
    /**
     * **不带换行地写一段**（`{ kind: 'write', values: [E] }` → `(write E)`）。方言里本来就有
     * 这一格（jancy 那条路的 `fmtRun` 一直在发），标准 IR 这一侧一直缺 —— 于是
     * `printf("abc")`（末尾没有换行）在 adapter 那条路上只能当场报。
     * 与 `print` 的差别只有"末尾补不补那个换行"。
     */
    case 'write':
      return sx.op('write', ctx.lowerExpr(stmt.values[0], ctx));
    /**
     * **语句形的内建**（`{ kind: 'builtin-stmt', name, args }`）：方言里有几格算子只当语句用
     * （`(dset d k v)` / `(aset a i v)` / `(apush a v)` / `(fldset o f v)`）——
     * 包进 `(expr …)` 会被当表达式读，那一侧当场报"不认识的表达式 'dset'"（量出来的）。
     */
    case 'builtin-stmt':
      return sx.op(stmt.name, ...stmt.args.map((a) => ctx.lowerExpr(a, ctx)));
    case 'defer': return ctx.hooks?.lowerDefer?.(stmt, ctx) ?? '';
    default:
      if (ctx.hooks?.lowerStmt) {
        const r = ctx.hooks.lowerStmt(stmt, ctx);
        if (r !== null && r !== undefined) return r;
      }
      /* **不发一段坏文本出去**（sx.js 文件头那三条规矩的第二条）：接不住就当场报，
         不然错要等跑起来印错数才看见。 */
      throw new Error(`lower-stmt.js: 这一格语句还没接：${stmt.kind}`);
  }
}

/**
 * 一组语句连成一个 `(do …)` 块。**每一行都缩进**（一条语句可能占几行，见 `lowerFor`）。
 *
 * 每条语句降级时开一格**语句槽**（`ctx.sink`）：表达式位置上要先跑几句的时候
 * （Scheme 的 `if` / `let` 是表达式、多值要先落一格记录）降级器往槽里 `ctx.emit(…)`，
 * 这儿把它们摆在那条语句**前面**。槽是按语句开的，所以嵌套的块各自一格，互不串味。
 */
export function lowerStmts(stmts, ctx) {
  const lines = stmtLines(stmts, ctx);
  return lines.length === 0 ? '(do)' : `(do${lines.map((l) => `\n  ${indent(l)}`).join('')})`;
}

/**
 * 一组语句 → 一串文本行，**每条语句开一格语句槽**（`ctx.sink`）。
 *
 * 单开这一格的理由是量出来的一条硬错：`lowerFor` 从前自己 `body.map(lowerStmt)`，
 * 于是体里那些"表达式位置上要先跑几句"的东西（`block-expr` / `if-expr`）把语句 emit 到了
 * **循环外头那一格槽**里 —— 症状是 `.sx` 那侧报"未声明的变量 'i'"（go 的 `strings` 桩里
 * `s[i:i+1]` 量出来的）。凡是"摆一串语句"的地方都要走这一格。
 */
export function stmtLines(stmts, ctx) {
  const lines = [];
  for (const s of stmts) {
    const outer = ctx.sink;
    const pre = [];
    ctx.sink = pre;
    let text;
    try {
      text = lowerStmt(s, ctx);
    } finally {
      ctx.sink = outer;
    }
    for (const p of pre) lines.push(p);
    if (text !== '') lines.push(text);
  }
  return lines;
}

/** 一段（可能多行）文本里除第一行之外的每一行也缩进 —— 印出来的 `.sx` 才对得上括号。 */
const indent = (text) => text.split('\n').join('\n  ');

function lowerIf(s, ctx) {
  const c = ctx.lowerExpr(s.cond, ctx);
  const t = lowerStmts(s.then, ctx);
  const e = s.else_ ? lowerStmts(s.else_, ctx) : null;
  return e !== null ? `(if ${c} ${t} ${e})` : `(if ${c} ${t})`;
}

function lowerWhile(s, ctx) {
  const c = ctx.lowerExpr(s.cond, ctx);
  const b = lowerStmts(s.body, ctx);
  return `(while ${c} ${b})`;
}

function lowerFor(s, ctx) {
  // C 系的 for(init; cond; post) body → 展开成 init + while(cond) { body; post }
  /* **init 那一格要自己一层作用域**：`for i := 0 …` 里那个 `i` 归这格循环。摊平成
     "init 摆在 while 前面"的话，同一个函数里第二格 `for i …` 会撞名（方言那侧当场报
     "'i' 在这一层已经声明过了" —— V 的 `forin.v` 量出来的）。所以带 init 的包一层 `(do …)`。 */
  const parts = [];
  if (s.init) ctx.scope.push();
  if (s.init) parts.push(lowerStmt(s.init, ctx));
  const c = s.cond ? ctx.lowerExpr(s.cond, ctx) : sx.bool(true);
  /* **`continue` 必须照跑步进那一格**（方言里没有三段式 `for`，只有 `while`）。
     把步进缀在体末尾是不够的：`continue` 跳过体的剩下部分，于是 `for (j=0; j<5; j++)`
     里的 `continue` 会死循环 —— 图那一条路上步进挂在 loop 的 post 端口上，所以那边没这个坑。
     办法：降级之前先把体里**属于这一层**的 `continue` 改写成"步进一格，再 continue"
     （嵌套循环里的 continue 归它自己那一层，不碰）。 */
  const body = s.post ? s.body.map((st) => withPostBeforeContinue(st, s.post)) : s.body;
  /* **每条语句一格语句槽**（`stmtLines`）—— 见那一段话：自己 map `lowerStmt` 会把体里
     那些"先跑几句"的东西 emit 到循环外头去。步进那一句摆在最后（它也要一格槽）。 */
  const bodyParts = stmtLines(s.post ? [...body, s.post] : body, ctx);
  const bodyText = bodyParts.length === 0 ? '(do)' : `(do${bodyParts.map((l) => `\n  ${indent(l)}`).join('')})`;
  parts.push(`(while ${c} ${bodyText})`);
  if (!s.init) return parts.join('\n');
  ctx.scope.pop();
  return `(do${parts.map((l) => `\n  ${indent(l)}`).join('')})`;
}

/**
 * 一条语句里**属于这一层循环**的 `continue`，前面补一格步进。
 *
 * 不进嵌套循环（`while` / `for` / `for-range` 的体）—— 那里头的 `continue` 是那一层的事。
 * 回一棵**新的**语句（不改 adapter 交来的那棵 IR：同一棵可能被别处引着）。
 */
function withPostBeforeContinue(stmt, post) {
  if (stmt === null || stmt === undefined) return stmt;
  switch (stmt.kind) {
    case 'continue': return { kind: 'block', stmts: [post, stmt] };
    case 'while': case 'for': case 'for-range': return stmt;   // 另一层的事
    case 'if': return {
      ...stmt,
      then: stmt.then.map((s) => withPostBeforeContinue(s, post)),
      else_: stmt.else_ ? stmt.else_.map((s) => withPostBeforeContinue(s, post)) : stmt.else_,
    };
    case 'block': return { ...stmt, stmts: stmt.stmts.map((s) => withPostBeforeContinue(s, post)) };
    case 'switch': return {
      ...stmt,
      cases: stmt.cases.map((c) => ({ ...c, body: c.body.map((s) => withPostBeforeContinue(s, post)) })),
      default_: stmt.default_ ? stmt.default_.map((s) => withPostBeforeContinue(s, post)) : stmt.default_,
    };
    default: return stmt;
  }
}

function lowerForRange(s, ctx) {
  // for name in iter { body } — 由语言的 hooks 处理（Go 的 range 和 Nim 的 for 语义不同）
  if (ctx.hooks?.lowerForRange) return ctx.hooks.lowerForRange(s, ctx);
  throw new Error('lower-stmt.js: for-range 要一格语言钩子（hooks.lowerForRange）'
    + ' —— "在什么上走一遍"各门语言答得不一样');
}

/**
 * `print`：**一行一格值**（方言的 `(print E)` 收一格）。
 *
 * 多个值怎么连（awk 的 OFS、go 的 `Println` 那个空格）是语言的事 —— 由 `hooks.lowerPrint`
 * 答。没给钩子又来了多格值就当场报，不替谁选一个分隔符。
 */
function lowerPrint(s, ctx) {
  const values = s.values ?? [s.value];
  if (ctx.hooks?.lowerPrint) {
    const r = ctx.hooks.lowerPrint(s, ctx);
    if (r !== null && r !== undefined) return r;
  }
  if (values.length !== 1) {
    throw new Error(`lower-stmt.js: print 收 ${values.length} 格值 —— 怎么连是语言的事`
      + '（要 hooks.lowerPrint）');
  }
  return sx.op('print', ctx.lowerExpr(values[0], ctx));
}

function lowerReturn(s, ctx) {
  if (s.values.length === 0) return sx.ret();
  if (s.values.length === 1) return sx.ret(ctx.lowerExpr(s.values[0], ctx));
  // 多返回值：由语言钩子处理（Go 有，C 没有）
  if (ctx.hooks?.lowerMultiReturn) return ctx.hooks.lowerMultiReturn(s, ctx);
  return sx.ret(ctx.lowerExpr(s.values[0], ctx));
}

function lowerBreak(s, _ctx) {
  return s.label ? sx.op('brk', s.label) : sx.op('brk');
}

function lowerContinue(s, _ctx) {
  return s.label ? sx.op('cont', s.label) : sx.op('cont');
}

function lowerLet(s, ctx) {
  const ty = typeToSx(s.type, ctx.hooks);
  const v = s.init ? ctx.lowerExpr(s.init, ctx) : zeroOf(s.type, ctx.hooks);
  ctx.scope.declare(s.name, { type: s.type });
  return `(let ${s.name} ${ty} ${v})`;
}

/**
 * 赋值。左边是什么形状决定发哪一格 —— 这正是 `place.js` 那张表的事，
 * 而各语言的特殊位置（字典的键、位域、属性）由 `hooks.lowerAssign` 先答。
 */
function lowerAssign(s, ctx) {
  if (ctx.hooks?.lowerAssign) {
    const r = ctx.hooks.lowerAssign(s, ctx);
    if (r !== null && r !== undefined) return r;
  }
  const value = ctx.lowerExpr(s.value, ctx);
  // 简单名字赋值 → (set name value)
  if (s.target.kind === 'name') return sx.set(s.target.name, value);
  // 字段 → 那一格记录的字段；下标 → 数组那一格（字典由 adapter 发 `dset`）
  if (s.target.kind === 'field') {
    return sx.fldset(ctx.lowerExpr(s.target.obj, ctx), s.target.name, value);
  }
  if (s.target.kind === 'index') {
    return sx.aset(ctx.lowerExpr(s.target.obj, ctx), ctx.lowerExpr(s.target.index, ctx), value);
  }
  if (s.target.kind === 'deref') {
    return sx.exprStmt(sx.pstore(ctx.lowerExpr(s.target.expr, ctx), value));
  }
  throw new Error(`lower-stmt.js: 赋值的左边是 ${s.target.kind} —— 这一格要由 hooks.lowerAssign 答`);
}

function lowerExprStmt(s, ctx) {
  return sx.exprStmt(ctx.lowerExpr(s.expr, ctx));
}

function lowerBlock(s, ctx) {
  ctx.scope.push();
  const r = lowerStmts(s.stmts, ctx);
  ctx.scope.pop();
  return r;
}

/**
 * 一层带**出口动作**的作用域（见 `lowerStmt` 里 `'scope'` 那一格的说明）。
 * 一格出口动作都没有就退化成普通的块。
 */
function lowerScope(s, ctx) {
  const exits = s.exits ?? [];
  if (exits.length === 0) return lowerBlock({ kind: 'block', stmts: s.stmts }, ctx);
  const body = s.stmts.map((st) => withExits(st, exits, false));
  ctx.scope.push();
  const r = lowerStmts([...body, ...exits], ctx);
  ctx.scope.pop();
  return r;
}

/**
 * 一条语句里**离开本层的那几个跳转**前面补上出口动作。回一棵**新的**语句
 * （不改 adapter 交来的那棵 IR：同一棵可能被别处引着）。
 *
 * `inLoop` 为真 = 这条语句在**本层里头的某一层循环**里 —— 那时 `break`/`continue`
 * 跳的是那一层，没离开本层，所以不补。`return` 不管在哪一层都是离开。
 *
 * **明说的近似**：`return f()` 上出口动作跑在**算完返回值之后**（C++ 的规矩就是这样），
 * 可这一层是"先发出口动作、再发 `ret`"—— 返回值里读了那几格要销毁的东西时两者有别。
 * 判据里没有这一格（六门语言从前手写的那一份也是这么落的），明说记着。
 */
function withExits(stmt, exits, inLoop) {
  if (stmt === null || stmt === undefined) return stmt;
  const mapBody = (st, f) => {
    const out = { ...st };
    if (Array.isArray(st.body)) out.body = st.body.map(f);
    return out;
  };
  switch (stmt.kind) {
    case 'return': return { kind: 'block', stmts: [...exits, stmt] };
    case 'break': case 'continue':
      return inLoop ? stmt : { kind: 'block', stmts: [...exits, stmt] };
    /* 本层里头的循环：它自己的 break/continue 不离开本层，可 return 还是离开。 */
    case 'while': case 'for': case 'for-range':
      return mapBody(stmt, (s) => withExits(s, exits, true));
    case 'if': return {
      ...stmt,
      then: stmt.then.map((s) => withExits(s, exits, inLoop)),
      else_: stmt.else_ ? stmt.else_.map((s) => withExits(s, exits, inLoop)) : stmt.else_,
    };
    case 'block': return { ...stmt, stmts: stmt.stmts.map((s) => withExits(s, exits, inLoop)) };
    /* 里头又一层带出口动作的作用域：它自己那几句由它自己补，这一层只管往下走。 */
    case 'scope': return { ...stmt, stmts: stmt.stmts.map((s) => withExits(s, exits, inLoop)) };
    case 'switch': return {
      ...stmt,
      cases: stmt.cases.map((c) => ({ ...c, body: c.body.map((s) => withExits(s, exits, inLoop)) })),
      default_: stmt.default_ ? stmt.default_.map((s) => withExits(s, exits, inLoop)) : stmt.default_,
    };
    default: return stmt;
  }
}

function lowerSwitch(s, ctx) {
  // switch → if/else 链（核心方言没有 switch）
  const v = ctx.lowerExpr(s.value, ctx);
  let out = '';
  for (let i = s.cases.length - 1; i >= 0; i--) {
    const c = s.cases[i];
    const cond = sx.bin('==', v, ctx.lowerExpr(c.match, ctx));
    const body = lowerStmts(c.body, ctx);
    const els = out || (s.default_ ? lowerStmts(s.default_, ctx) : null);
    out = els ? `(if ${cond} ${body} ${els})` : `(if ${cond} ${body})`;
  }
  if (!out && s.default_) return lowerStmts(s.default_, ctx);
  return out || '(do)';
}
