// src/core/lang/sx.js —— 核心 S 表达式（`.sx`）前端的插件外壳（ADR-0021 的 S4）
//
// 与 lang/wat.js 同一条规矩：**不 import cli.js**，宿主服务由 register 的入参给。
// `.sx` 是 asy / jnc 的中间形态（它们降到 sx 文本再走这一门），所以它先搬出来还有一层用处：
// 那两门以后搬出去的时候，共用的这一格已经在插件那一侧了。

import { Diagnostics, SourceFile, OmniError } from '../source/diag.js';
import { readText } from '../host/native.js';
import { lowerCoreSexpr, lowerCoreSession, CoreSession } from '../sexpr/lower.js';

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
  api.registerCap('sx.repl', () => new SxReplLang());
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

/**
 * `omni repl --lang sx` 那条腿：CoreSession。从 repl.js 搬过来的（ADR-0021 的 S4）——
 * 驱动不该为了一门语言的交互式会话去 import sexpr/lower.js。
 *
 * 语法驱动的前端（asy/jancy）印出来的就是这份方言，所以这一条**不是**为 .sx 文件加的功能，
 * 而是"新语言从语法来"这条路上 REPL 的落点：那门语言只要能把一批输入印成方言，
 * 增量、回滚、跨批可见性就都已经在这里了。
 */
class SxReplLang {
  constructor() {
    this.name = 'sx';
    this.cs = new CoreSession();
  }

  // 方言里类型都写明了，没有"缺省注解怎么办"这回事，所以模式是固定的
  getMode() { return 'static'; }

  setMode(m) { throw new OmniError(`omni: ${this.name} has no type modes to switch`); }

  prelude() { return null; }

  /** 空动作：`;` 到行尾是注释，去掉之后什么都不剩就不编译 */
  blank(text) {
    return text.replace(/;[^\n]*/g, '').trim() === '';
  }

  complete(text) {
    let depth = 0;
    let str = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (str) {
        if (c === '\\') i++;
        else if (c === '"') str = false;
        continue;
      }
      if (c === '"') str = true;
      else if (c === ';') { while (i < text.length && text[i] !== '\n') i++; }
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    return depth <= 0 && !str;
  }

  // 方言里"打印一个值"就是 `(print E)`，写法本身已经是语句，没有回显这一层
  echo(text) { return null; }

  echoOptional(text) { return true; }

  asStmt(text) { return text; }

  snapshot() { return this.cs.snapshot(); }

  restore(s) { this.cs.restore(s); }

  add(text, diags) {
    const delta = this.cs.add(text, diags);
    diags.throwIfErrors();
    return delta;
  }

  full(chunks) {
    const diags = new Diagnostics();
    const mod = lowerCoreSession(`${chunks.join('\n')}\n`, diags);
    diags.throwIfErrors();
    return mod;
  }
}
