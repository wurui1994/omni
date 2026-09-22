// ext/gsl-shell/omni-lang.js —— 这格**方言**的入口
//
// 与 `ext/lua/omni-lang.js` 差的只有两处：读的是 `gslLang`（Lua 的表 + 两条产生式），
// 以及**登记时不认任何后缀**。
//
// 为什么不认后缀：gsl-shell 的源码就是 `.lua`（真 gsl-shell 那边也是），后缀那张表里
// 加一格等于把所有 `.lua` 都抢过来 —— 而 lua 才是那个后缀的主人。方言只能**点名**：
//
//   omni run x.lua --lang gsl-shell         命令行点名
//   #lang gsl-shell（文件第一行）            文件自己点名（见下）
//
// `#lang` 那一格默认是关着的（ADR-0037：一份文件的语言由后缀决定，不猜），可**方言是个
// 例外** —— `#lang gsl-shell` 写在一份 `.lua` 里并没有"偷偷换成另一门语言"，它只是把
// 同一门语言的方言说清。那条放行规矩在 `cli.js` 的 `pickLang`，靠自述里的 `dialectOf`。
//
// 降级那一整套（`lower.js`）**一个字都不改**：短 lambda 落到的树与 `function` 逐格相同
// （`lang.js` 里那格 `sugarOf: 'function-exp'`）。这正是"加一门方言 = 加一张增量表"。

import { Diagnostics, SourceFile, OmniError } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { basename } from '../../src/core/host/path.js';
import { lowerCoreSexpr } from '../../src/core/sexpr/lower.js';
import { parse, ParseError } from '../../src/core/frontend-engine/parse-driver.js';
import { LexError } from '../lua/tokens.js';
import { lower, Refuse, ACCOUNTS } from '../lua/lower.js';
import { gslLang } from './lang.js';

let API = null;

/** 一份 gsl-shell 源码 -> 核心方言的文本（与 `lua.toSx` 同一个形状）。 */
export function gslToSx(path) {
  const src = readText(path);
  let ast;
  try {
    ast = parse(src, gslLang);
  } catch (err) {
    if (err instanceof ParseError || err instanceof LexError) {
      throw new OmniError(`${basename(path)}: ${err.message}`);
    }
    throw err;
  }
  try {
    return lower(ast, gslLang).text;
  } catch (err) {
    if (err instanceof Refuse) {
      throw new OmniError(`${basename(path)}: 这一刀还降不了 —— ${err.id}：${ACCOUNTS[err.id].say}`);
    }
    throw err;
  }
}

/** gsl-shell -> OIR。 */
export function compileGsl(path) {
  const diags = new Diagnostics();
  const mod = lowerCoreSexpr(new SourceFile(`${path}.sx`, gslToSx(path)), diags);
  diags.throwIfErrors();
  if (API !== null) API.log(`gsl-shell front end  ${path} -> OIR  ${mod.funcs.length} funcs`);
  return { ast: null, mod, diags };
}

/** 自述里 `"register": "registerGslExt"` 指的就是这一个。 */
export function registerGslExt(api) {
  API = api;
  api.registerCap('gsl-shell.toSx', gslToSx);
  /* 后缀那一串是**空的**（见文件头）；`dialectOf` 让"按名字点它"不算与后缀冲突。 */
  api.registerLang([], 'gsl-shell', (path) => compileGsl(path), { dialectOf: 'lua' });
}
