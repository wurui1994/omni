// src/core/lang/builtin-pick.js —— 编**我们自己的源码**时，`lang/builtin.js` 换成哪一份
//
// 三份 builtin 的分工（ADR-0021 的 S4 + ADR-0023 的 S7）：
//   - `builtin.js`      迟装：一门语言只在真被问到时才 `require` 进来。**只给从源码跑的那条
//                       腿**（node）—— 它用 `createRequire`，而我们自己的 JS 前端不认那个，
//                       也不认 `import()`（"the module graph is fixed at link time"）。
//   - `builtin-fat.js`  全静态 import：编产物时（`--fat` / `emit-js`）用它。
//   - `builtin-core.js` 一格都不装：编出来的核心用它，功能全在 `plugins/*.dylib` 里。
//
// 这条规则单独一份的理由：**换哪一份不是某一处的事**。cli.js 的 readModule 要它，
// tests/mir 那条轴（它把 cli.js 自己降到 MIR）也要它 —— 少一处就会拿迟装那一份去编，
// 于是报 `export const BUILTINS = [` 那种"前端不认这句"的错，而真相是"读错了文件"。

/**
 * @param p 正在读的那份源码路径
 * @param fat 要不要全装（`--fat` / `emit-js` 那条是 true）
 * @returns 该换成的路径；不是 builtin.js 就回 null
 */
export function builtinAlt(p, fat) {
  if (!p.endsWith('/lang/builtin.js')) return null;
  const base = p.slice(0, p.length - 'builtin.js'.length);
  return `${base}${fat ? 'builtin-fat.js' : 'builtin-core.js'}`;
}
