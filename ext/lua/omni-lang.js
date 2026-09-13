// ext/lua/omni-lang.js —— 这格扩展的**入口**：把自己登记进 omni 的注册表
//
// 这一份是"扩展该长什么样"的样板（约定见 `src/core/ext.js` 的文件头、ADR-0030 第 4 节）：
//
//   omni-ext.json   自述（**数据**）：叫什么、认哪些后缀、答哪几格 cap、入口是谁
//   omni-lang.js    入口（**代码**）：`registerLuaExt(api)` 里调 `api.register*`
//   其余那几份       这门语言自己的表与驱动器（tokens/nodes/lang/parse/render/scope/values/lower）
//
// 方向是单向的：**扩展 import 核心**（`../../src/core/…` 那几行就是 SDK 面），
// 核心一个字都不认识 lua。所以别人的语言与这一格是同等公民 —— 换个目录、换份自述而已。
//
// 用到的 SDK 面（只有四样，都是"每门语言都要"的东西）：
//   source/diag.js   Diagnostics / SourceFile / OmniError
//   host/native.js   readText（宿主 IO 走封闭 ABI，不许直接碰 node:fs）
//   host/path.js     basename
//   sexpr/lower.js   核心方言的文本 -> OIR（我们这一门降到核心方言，后端那一摊照旧）

import { Diagnostics, SourceFile, OmniError } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { basename } from '../../src/core/host/path.js';
import { lowerCoreSexpr } from '../../src/core/sexpr/lower.js';
import { parse, ParseError } from './parse.js';
import { LexError } from './tokens.js';
import { luaLang } from './lang.js';
import { lower, Refuse, ACCOUNTS } from './lower.js';

/* 核心交过来的宿主服务（`log` 是 `-v` 那一栏）。 */
let API = null;

/**
 * 一份 `.lua` -> 核心方言的文本。`omni emit sx x.lua` 与 `omni run x.lua` 走同一条，
 * 所以降级只有一份实现。
 *
 * 三种拒法各报各的话，**别混成一句**（ADR-0029 那边学到的：把"语言里写不出来"与
 * "我们还没收"混在一栏，害得欠账被当成了规格）：
 *   语法/词法不认  -> 位置 + 那一行的抱怨
 *   降级还收不下   -> **账号 + 那笔账的原话**（`lower.js` 的 ACCOUNTS）
 */
export function luaToSx(path) {
  const src = readText(path);
  let ast;
  try {
    ast = parse(src, luaLang);
  } catch (err) {
    if (err instanceof ParseError || err instanceof LexError) {
      throw new OmniError(`${basename(path)}: ${err.message}`);
    }
    throw err;
  }
  try {
    return lower(ast, luaLang).text;
  } catch (err) {
    if (err instanceof Refuse) {
      throw new OmniError(`${basename(path)}: 这一刀还降不了 —— ${err.id}：${ACCOUNTS[err.id].say}`);
    }
    throw err;
  }
}

/** `.lua` -> OIR。驱动要的就是这一格（与内建那几门同一个形状）。 */
export function compileLua(path) {
  const diags = new Diagnostics();
  const mod = lowerCoreSexpr(new SourceFile(`${path}.sx`, luaToSx(path)), diags);
  diags.throwIfErrors();
  if (API !== null) API.log(`lua front end  ${path} -> OIR  ${mod.funcs.length} funcs`);
  return { ast: null, mod, diags };
}

/** 自述里 `"register": "registerLuaExt"` 指的就是这一个。 */
export function registerLuaExt(api) {
  API = api;
  api.registerCap('lua.toSx', luaToSx);
  api.registerLang(['.lua'], 'lua', (path) => compileLua(path));
}
