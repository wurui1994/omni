// src/core/lower/lower.js —— 公共降级器主入口（ADR-0044）
//
// 标准 IR（adapter 的输出）→ .sx text。所有语言走这一份。
// 语言特有的语义由 hooks 传入（语义配置表 + 钩子函数）。

import { Scope } from './scope.js';
import { TypeEnv, BASIC_TYPES } from './type-env.js';
import { lowerStmt, lowerStmts } from './lower-stmt.js';
import { lowerExpr } from './lower-expr.js';
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

  /** 降级上下文（所有 lower-* 模块共用的那个 ctx）。 */
  const ctx = {
    scope,
    typeEnv,
    hooks,
    lowerExpr: (expr, c) => lowerExpr(expr, c ?? ctx),
    lowerStmts: (stmts, c) => lowerStmts(stmts, c ?? ctx),
    lowerStmt: (stmt, c) => lowerStmt(stmt, c ?? ctx),
  };

  const lines = [];
  lines.push('(module');

  // 第一遍：收集类型和函数签名
  for (const decl of module.decls) {
    if (decl.kind === 'struct') {
      typeEnv.register(decl.name, { kind: 'struct', fields: decl.fields });
      typeEnv.registerFields(decl.name, decl.fields);
      const fields = decl.fields.map((f) => `(${f.name} ${typeToSx(f.type, hooks)})`).join(' ');
      lines.push(`  (struct ${decl.name} ${fields})`);
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
    if (decl.kind === 'global') {
      scope.declare(decl.name, { type: decl.type, global: true });
    }
  }

  // 第二遍：发射函数体
  for (const decl of module.decls) {
    if (decl.kind === 'fn') {
      lines.push(lowerFn(decl, ctx));
    }
    if (decl.kind === 'global' && decl.init) {
      const v = lowerExpr(decl.init, ctx);
      const ty = typeToSx(decl.type, hooks);
      lines.push(`  (global ${decl.name} ${ty} ${v})`);
    }
  }

  // main 入口
  const mainFn = module.decls.find((d) => d.kind === 'fn' && d.name === 'main');
  if (mainFn) {
    lines.push('  (main (expr (call main)))');
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
 * 类型描述 → .sx 类型文本。
 * 语言的 hooks.typeToSx 可以覆盖（处理特殊类型）。
 */
export function typeToSx(type, hooks = {}) {
  if (type === null || type === undefined) return 'void';
  if (typeof type === 'string') return type;
  if (hooks.typeToSx) {
    const r = hooks.typeToSx(type);
    if (r !== null && r !== undefined) return r;
  }
  switch (type.kind) {
    case 'void': return 'void';
    case 'bool': return 'bool';
    case 'int': return 'int';
    case 'real': return 'real';
    case 'string': return 'string';
    case 'named': return type.name;
    case 'ptr': return `(ptr ${typeToSx(type.inner, hooks)})`;
    case 'arr': return `(arr ${typeToSx(type.elem, hooks)})`;
    case 'map': return `(dict ${typeToSx(type.key, hooks)} ${typeToSx(type.value, hooks)})`;
    case 'fn-type': {
      const ps = type.params.map((p) => typeToSx(p, hooks)).join(' ');
      return `(fnty (${ps}) ${typeToSx(type.ret, hooks)})`;
    }
    default: return type.name ?? 'void';
  }
}

// Re-export 所有子模块，方便 adapter 统一 import
export { Scope } from './scope.js';
export { TypeEnv, BASIC_TYPES } from './type-env.js';
export { lowerStmt, lowerStmts } from './lower-stmt.js';
export { lowerExpr } from './lower-expr.js';
export * as sx from './sx.js';
