// src/core/lang/wat.js —— WAT 前端的插件外壳（ADR-0021 的 S4）
//
// 为什么单独一份而不是留在 cli.js 里：语言要能**独立编译成一个动态库**，核心扫目录发现它。
// 硬条件就一条 —— **这一份不许 import cli.js**。它要的宿主服务（印一行步骤耗时）由
// `register` 的入参给，不是伸手去拿；这样内建（核心直接调 register）与外挂
// （`dlopen` 之后由 `omni_plugin_init` 调 register）是同一条路，只差登记的时刻。
//
// wat 与 sx 先搬：它们各自只有六行、除了 lower 什么都不依赖。asy / jnc 与 cli 的
// 读盘 / 诊断 / 缓存缠在一起（`.asy` 的 run 还有一条走缓存可执行文件的快路径），
// 那两门要先把纠缠解开，是下一刀。

import { Diagnostics, SourceFile } from '../source/diag.js';
import { readText } from '../host/native.js';
import { lowerWat } from '../frontend-wat/lower.js';

/** @param api `{ registerLang, log }` —— 核心给的那一格宿主服务 */
export function register(api) {
  api.registerLang(['.wat'], 'wat', (path) => {
    const diags = new Diagnostics();
    const mod = lowerWat(new SourceFile(path, readText(path)), diags);
    diags.throwIfErrors();
    api.log(`wat front end  ${path} -> OIR  ${mod.funcs.length} funcs`);
    return { ast: null, mod, diags };
  });
}
