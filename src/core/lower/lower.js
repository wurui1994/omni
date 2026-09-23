// src/core/lower/lower.js —— 公共降级器主入口（ADR-0044）
//
// 标准 IR（adapter 的输出）→ .sx text。所有语言走这一份。
// 语言特有的语义由 hooks 传入（语义配置表 + 钩子函数）。

import { Scope } from './scope.js';
import { TypeEnv, BASIC_TYPES } from './type-env.js';
import { lowerStmt, lowerStmts } from './lower-stmt.js';
import { lowerExpr } from './lower-expr.js';
import { typeToSx, zeroOf } from './ty.js';
import * as sx from './sx.js';

/**
 * 把一棵标准 IR 翻译成 .sx 文本。
 *
 * @param {object} module   标准 IR 的模块描述（§1.2 的 { kind: 'module', decls } ）
 * @param {object} hooks    语言钩子（语义配置 + 回调函数）
 * @returns {string}        .sx 文本
 */
export function lower(module, hooks = {}) {
  const scope = new Scope();
  const typeEnv = new TypeEnv();

  // 注册基本类型
  for (const [name, desc] of Object.entries(BASIC_TYPES)) {
    typeEnv.register(name, desc);
  }
  // 语言的额外类型
  if (hooks.types) {
    for (const [name, desc] of Object.entries(hooks.types)) {
      typeEnv.register(name, desc);
    }
  }

  /**
   * 降级上下文（所有 lower-* 模块共用的那个 ctx）。
   *
   * `sink` 那一格是**语句槽**：表达式位置上要先跑几句的时候（Scheme 的 `if` 是表达式、
   * `let` 是表达式、多值要先落一格记录），降级器把那几句 `ctx.emit(…)` 进去，
   * 由 `lowerStmts` 摆在当前这条语句**前面**。没有它就只能在表达式里塞语句 —— 那是错的。
   */
  let tmpN = 0;
  const ctx = {
    scope,
    typeEnv,
    hooks,
    sink: null,
    /** 一格新的临时量名字（`if_tmp1` / `mv_tmp2` …）。模块里唯一。 */
    fresh: (prefix) => { tmpN += 1; return `${prefix}${tmpN}`; },
    /** 往当前语句前面插一句。**不在语句里**（sink 为 null）就是降级器写错了，当场报。 */
    emit: (text) => {
      if (ctx.sink === null) {
        throw new Error(`lower.js: 这一格要往语句前面插一句（${text.slice(0, 40)}），`
          + '可现在不在语句里 —— 顶层的初始化要包在 (main …) 或函数体里');
      }
      ctx.sink.push(text);
    },
    lowerExpr: (expr, c) => lowerExpr(expr, c ?? ctx),
    lowerStmts: (stmts, c) => lowerStmts(stmts, c ?? ctx),
    lowerStmt: (stmt, c) => lowerStmt(stmt, c ?? ctx),
  };

  const lines = [];
  lines.push('(module');

  /* **借外头那份 C 的那两句先发**（`(lib …)` / `(cabi …)`）：方言那一侧要它们在用之前。 */
  for (const decl of module.decls) {
    if (decl.kind === 'lib') lines.push(`  ${sx.lib(decl.name)}`);
    if (decl.kind === 'cabi') lines.push(`  ${sx.cabi(decl.sym, decl.ret, decl.params ?? [])}`);
  }

  // 第一遍：收集类型和函数签名
  for (const decl of module.decls) {
    if (decl.kind === 'struct' || decl.kind === 'class') {
      /* **值语义与引用语义分两格**（方言的 `(struct …)` 与 `(class …)`）：
         谁是哪一格由 adapter 说 —— Scheme 的记录是引用、go 的 struct 是值。 */
      typeEnv.register(decl.name, { kind: 'named', name: decl.name, ref: decl.kind === 'class' });
      typeEnv.registerFields(decl.name, decl.fields);
      const fields = decl.fields.map((f) => `(${f.name} ${typeToSx(f.type, hooks)})`).join(' ');
      lines.push(`  (${decl.kind} ${decl.name} ${fields})`);
    }
    if (decl.kind === 'enum') {
      typeEnv.register(decl.name, { kind: 'enum', values: decl.values });
      // enum → 一组常量
      for (const v of decl.values) {
        scope.declare(v.name, { type: { kind: 'int' }, value: v.value });
      }
    }
    if (decl.kind === 'fn') {
      typeEnv.registerFunc(decl.name, { params: decl.params, ret: decl.ret });
    }
    /* 闭包（`(cfn …)`）也登记一格签名 —— `(mkclo 名 …)` 要按名字找它。 */
    if (decl.kind === 'closure') {
      typeEnv.registerFunc(decl.name, { params: decl.params, ret: decl.ret });
    }
    if (decl.kind === 'global') {
      scope.declare(decl.name, { type: decl.type, global: true });
    }
  }

  // 第二遍：发射函数体
  for (const decl of module.decls) {
    if (decl.kind === 'fn') {
      lines.push(lowerFn(decl, ctx));
    }
    if (decl.kind === 'closure') {
      lines.push(lowerClosure(decl, ctx));
    }
    if (decl.kind === 'global') {
      /**
       * 模块级变量。**初值只能没有** —— 方言的 `(global 名字 类型)` 按设计零初始化，
       * 后面多摆一格会当场报（"后面多了 1 格"）。要非零初值就让 adapter 在入口里摆一句
       * `set`（go / chez / sbcl / cpp 四门都是这么做的）。
       * 从前这儿有一支 `if (decl.init)` 会发出**方言收不了的那一形**：没人踩到是因为
       * 四门都没给 init，踩到了报的也是 `.sx` 那一层的错，账不在这儿 —— 所以改成当场报。
       */
      if (decl.init !== undefined && decl.init !== null) {
        throw new Error(`lower: 模块级变量 ${decl.name} 不许带初值 —— 摆一句 set 到入口里`);
      }
      lines.push(`  (global ${decl.name} ${typeToSx(decl.type, hooks)})`);
    }
  }

  /**
   * 入口那一格。两种形状，**adapter 说是哪一种**：
   *   * `{ kind: 'main', body }` —— 入口就是一段语句（awk 的 `BEGIN`、lua / 脚本那一族的
   *     顶层语句）。这一格直接摆进 `(main …)`。
   *   * 有一格名叫 `main` 的函数（go / cpp 那一族）—— 那就发一句 `(main (expr (call main)))`。
   * 两种都没有就没有入口（库那一档），`(main …)` 一格都不发。
   */
  const mainDecl = module.decls.find((d) => d.kind === 'main');
  if (mainDecl !== undefined) {
    ctx.scope.push();
    lines.push(`  (main ${lowerStmts(mainDecl.body, ctx)})`);
    ctx.scope.pop();
  } else if (module.decls.some((d) => d.kind === 'fn' && d.name === 'main')) {
    lines.push(`  (main ${sx.exprStmt(sx.call('main'))})`);
  }

  lines.push(')');
  return lines.join('\n') + '\n';
}

/** 降级一个函数声明。 */
function lowerFn(decl, ctx) {
  ctx.scope.push();
  // 形参
  const params = [];
  for (const p of decl.params) {
    ctx.scope.declare(p.name, { type: p.type });
    params.push(`(${p.name} ${typeToSx(p.type, ctx.hooks)})`);
  }
  const ret = typeToSx(decl.ret, ctx.hooks);
  const body = decl.body ? lowerStmts(decl.body, ctx) : '(do)';
  ctx.scope.pop();

  const paramStr = params.length > 0 ? ` ${params.join(' ')}` : '';
  return `  (fn ${decl.name} (${paramStr.trim()}) ${ret} ${body})`;
}

/**
 * 降级一格闭包（`(cfn 名 ((c T)…) ((p T)…) R 语句…)`）。
 * 捕获**按值抓**，体里读它写 `(cap c)`（见 `lower-expr.js` 的 `capture` 那一格）。
 */
function lowerClosure(decl, ctx) {
  ctx.scope.push();
  const caps = (decl.caps ?? []).map((c) => {
    ctx.scope.declare(c.name, { type: c.type, capture: true });
    return `(${c.name} ${typeToSx(c.type, ctx.hooks)})`;
  });
  const params = (decl.params ?? []).map((p) => {
    ctx.scope.declare(p.name, { type: p.type });
    return `(${p.name} ${typeToSx(p.type, ctx.hooks)})`;
  });
  const ret = typeToSx(decl.ret, ctx.hooks);
  const body = decl.body ? lowerStmts(decl.body, ctx) : '(do)';
  ctx.scope.pop();
  return `  (cfn ${decl.name} (${caps.join(' ')}) (${params.join(' ')}) ${ret} ${body})`;
}

/**
 * 类型描述 → .sx 类型文本 + 零值。**正本在 `ty.js`**（语句层也要它们，摆在这儿就成了环）。
 *
 * 转口写成"一条 import + 一条光秃秃的 export"，**不是 `export … from`**：这份文件自己
 * 也用 `typeToSx`，两条都写就是同一格名字进来两遍 —— 单体 HTML 那个打包器把两种形状都摊成
 * `const { … } = __req(…)`，拼出来当场 `Identifier 'typeToSx' has already been declared`
 * （`tests/studio/run.js` 量出来的，与 `graph/fromtree.js` 那处同一个坑）。
 */
export { typeToSx, zeroOf };

/* **这儿不再转口各子模块**（原来有一摊 `export { Scope } from './scope.js'` 之类的
   "方便 adapter 统一 import"）。两个理由，后一个是硬的：
     * adapter 要哪一格就 import 哪一份（`ext/awk/adapter.js` 只用 `sx.js` 与 `cst.js`）——
       转口只是给同一件东西加第二个名字；
     * 这份文件自己也 import 了那几格，于是"既 import 又 `export … from`"会让单体 HTML
       那个打包器摊出两条 `const { Scope } = __req(…)` —— 拼出来当场 SyntaxError。 */
