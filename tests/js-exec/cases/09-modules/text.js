// 最底层的模块：没有自己的依赖
export const CHARS = "==";

export function repeatStr(s, n) {
  let out = "";
  for (let i = 0; i < n; i++) out = out + s;
  return out;
}

export const ORDER = [];
ORDER.push("text");

/* 命名空间导入那一格要看的东西：导出的是**活绑定**，所以 `ns.seen` 得跟着 note() 变。 */
export let seen = 0;
export function note() { seen = seen + 1; return seen; }
