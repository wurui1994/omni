// 最底层的模块：没有自己的依赖
export const CHARS = "==";

export function repeatStr(s, n) {
  let out = "";
  for (let i = 0; i < n; i++) out = out + s;
  return out;
}

export const ORDER = [];
ORDER.push("text");
