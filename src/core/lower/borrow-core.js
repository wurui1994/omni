// src/core/lower/borrow-core.js —— "按登记处那一行取出运行时那半"的**机制**（纯逻辑）
//
// 两条腿共用这一份，差别只在**怎么把那份模块拿到手**：
//   `borrow.js`      node 源码腿 —— `createRequire`（同步装 ESM）
//   `borrow-fat.js`  编产物那条腿 —— 一张静态 import 的表（产物里不能有 `require`）
// 接缝规则在 `../lazy-pick.js`（它同时管 `lazy.js` 那一格），与 `lang/builtin-pick.js` 同构。
//
// 这一份里**一个语言名字都没有**，也没有任何 `ext/` 的 import —— 那正是这一刀要的
// （ADR-0030 第 4 节：核心给机制，扩展自述）。
//
// **刻意不是 `mkBorrowRt(load)` 那种"造一格闭包"的工厂**：两条腿的形状因此一模一样
// （各自一个普通 `borrowRt` + 一格模块级 Map），少一层间接、也少一处只有换腿才试得出的差别。
// （第一版确实是工厂，而且那时产物腿真的炸了 —— 但真因是别的：`frontend-js/rename.js` 的
// import 别名改写没认局部遮蔽，见那一份的 `boundAnywhere`。工厂本身编得出也跑得对。）

import { OmniError } from '../source/diag.js';

/**
 * 登记处那一行 + 已经装进来的那份 adapter -> `{ toIR, hooks?, imports?, pre? }`。
 *
 * `lang.exports` 是"从 adapter 里取哪几个名字"（`{ toIR: 'pyToIR', hooks: 'PY_HOOKS' }`）。
 * 取不到就当场抛「登记处与代码走散了」—— 与 `plugin.js` 那格 `pendingMismatch` 同一条纪律：
 * 两处各写一遍的东西必须有人核对，不然只会悄悄少一格。
 */
export function pickRt(lang, mod) {
  if (typeof lang.adapter !== 'string') {
    throw new OmniError(`${lang.name} 还没有 adapter —— 这条路（ADR-0044）要登记处那一格 adapter`);
  }
  if (mod === null || mod === undefined) {
    throw new OmniError(`${lang.name}：装不进 ${lang.adapter}`);
  }
  const rt = {};
  for (const k of Object.keys(lang.exports)) {
    const ex = lang.exports[k];
    const v = mod[ex];
    if (v === undefined) {
      throw new OmniError(`${lang.adapter} 里没有 '${ex}' 这个导出`
        + `（登记处 lower/langs.js 说 ${lang.name} 的 ${k} 是它）—— 登记处与代码走散了`);
    }
    rt[k] = v;
  }
  return rt;
}
