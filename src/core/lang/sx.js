// src/core/lang/sx.js —— 核心 S 表达式（`.sx`）前端的插件外壳（ADR-0021 的 S4）
//
// 与 lang/wat.js 同一条规矩：**不 import cli.js**，宿主服务由 register 的入参给。
// `.sx` 是 asy / jnc 的中间形态（它们降到 sx 文本再走这一门），所以它先搬出来还有一层用处：
// 那两门以后搬出去的时候，共用的这一格已经在插件那一侧了。

import { Diagnostics, SourceFile } from '../source/diag.js';
import { readText } from '../host/native.js';
import { lowerCoreSexpr } from '../sexpr/lower.js';

/** @param api `{ registerLang, log }` */
export function register(api) {
  api.registerLang(['.sx'], 'sx', (path) => {
    const diags = new Diagnostics();
    const mod = lowerCoreSexpr(new SourceFile(path, readText(path)), diags);
    diags.throwIfErrors();
    api.log(`core sexpr front end  ${path} -> OIR  ${mod.funcs.length} funcs`);
    return { ast: null, mod, diags };
  });
}
