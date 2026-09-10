// src/core/lang/sx.js —— 核心 S 表达式（`.sx`）前端的插件外壳（ADR-0021 的 S4）
//
// 与 lang/wat.js 同一条规矩：**不 import cli.js**，宿主服务由 register 的入参给。
// `.sx` 是 asy / jnc 的中间形态（它们降到 sx 文本再走这一门），所以它先搬出来还有一层用处：
// 那两门以后搬出去的时候，共用的这一格已经在插件那一侧了。

import { Diagnostics, SourceFile } from '../source/diag.js';
import { readText } from '../host/native.js';
import { lowerCoreSexpr } from '../sexpr/lower.js';

/** @param api `{ registerLang, log }` */
/* 名字带前缀是**这条腿的硬约束**：自举链的链接器要求模块作用域的名字在整份程序里唯一
   （tests/bootstrap/ratchet.js 的第一条断言），而四门语言现在还都链在同一个程序里。
   等每门语言各自成一个动态库、各自独立编译，C ABI 那一层的入口才是统一的
   `omni_plugin_init`，JS 这一侧的名字就不必再避让了。 */
export function registerSxLang(api) {
  api.registerLang(['.sx'], 'sx', (path) => {
    const diags = new Diagnostics();
    const mod = lowerCoreSexpr(new SourceFile(path, readText(path)), diags);
    diags.throwIfErrors();
    api.log(`core sexpr front end  ${path} -> OIR  ${mod.funcs.length} funcs`);
    return { ast: null, mod, diags };
  });
  api.registerCap('sx.textToMod', sxTextToMod);
}

/**
 * 一段**内存里的** `.sx` 文本降成 OIR。asy 的分单元构建走这一门：单元的核心方言正文
 * 从不落盘（诊断报的 `<单元>.sx:L:C` 是虚拟文件名，与 `omni sx` 印出来的逐字节对得上），
 * 所以不能借上面那条按路径读文件的门。
 *
 * @param name 虚拟文件名里那一截（诊断印的是 `${name}.sx`）
 * @param text 核心方言正文
 * @param entry 这一份的初始化函数叫什么（asy 那边是 `omni_init_<单元符号>`）
 */
export function sxTextToMod(name, text, entry) {
  const diags = new Diagnostics();
  const mod = lowerCoreSexpr(new SourceFile(`${name}.sx`, text), diags, entry);
  diags.throwIfErrors();
  return mod;
}
