// src/core/lang/js.js —— JS 前端的插件外壳（ADR-0021 的 S4）
//
// 与另外几门同一条规矩：**不 import cli.js**，宿主服务由 register 给一次。
// 这一门与别的不同的地方：它是**自举那条路自己**（编译器就是 JS 写的），所以它永远内建 ——
// 但形状还是跟别人一样，不给它开特例。

import { Diagnostics } from '../source/diag.js';
import { readText, exists } from '../host/native.js';
import { linkJs } from '../frontend-js/link.js';
import { lowerJs } from '../frontend-js/lower.js';

let JS_API = null;

/**
 * `.js` 入口走 JS 语法前端：链接整棵 import 树，再降级成 OIR（ADR-0011 第 6 步）。
 * 自举就是这一条路 —— 编译器自己的源码是 JS，喂给它自己就得到下一代。
 * 这里没有 check()：OIR 是降级器直接造的，类型早已确定（全是 dynamic）。
 */
function compileJs(path) {
  const diags = new Diagnostics();
  const ast = linkJs(path, (p) => (exists(p) ? readText(p) : null), diags);
  diags.throwIfErrors();
  JS_API.log(`js front end  link ${path}`);
  const mod = lowerJs(ast, diags);
  diags.throwIfErrors();
  JS_API.log(`js lower -> OIR  ${mod.funcs.length} funcs, ${mod.structs.length} structs`);
  return { ast, mod, diags };
}

/** 登记（名字带前缀的理由见另外几门：自举链要求模块作用域的名字整份程序里唯一）。 */
export function registerJsLang(api) {
  JS_API = api;
  api.registerLang(['.js'], 'js', (path) => compileJs(path));
}
