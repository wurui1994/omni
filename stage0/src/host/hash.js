// Omni stage0 — 纯 JS 的短摘要（缓存键用）
//
// 为什么不用 node:crypto 的 sha256：唯一的用途是 runtime .o 缓存的目录名（cli.js
// runtimeObjects），键的内容是"编译器 + flags + 每个运行时源文件的 mtime 与大小"。
// 这里要的是"内容变了名字就变"，不是抗碰撞 —— 而 node:crypto 不在封闭 ABI 里
// （ADR-0011 决策 2），为它开一个宿主 op 只为算个目录名不划算。
//
// 两条独立的滚动哈希拼成 64 位：乘数不同、方向相反，任何一处改动都会同时扰动两边。
// 全程只用加法、乘法、取模 —— 没有位运算（ABI 的 js_bitop 只对 int/bigint 成立，
// 这里的一切都是 real），也没有 toString(16)。
//
// 乘数刻意取小：h < 2^32，h * 137 + c < 2^40，远在 double 的 2^53 精确整数范围内。

const M = 4294967296;  // 2^32
const HEX = '0123456789abcdef';

function hex8(n) {
  let v = n;
  let s = '';
  for (let i = 0; i < 8; i++) {
    const d = v % 16;
    s = HEX[d] + s;
    v = (v - d) / 16;
  }
  return s;
}

/** 16 个十六进制字符（64 位）。同一个输入在 node 与降级后的两代里必须给同一个结果。 */
export function hash16(s) {
  let a = 2166136261;
  for (let i = 0; i < s.length; i++) a = (a * 131 + s.charCodeAt(i)) % M;
  let b = 5381;
  for (let i = s.length - 1; i >= 0; i--) b = (b * 137 + s.charCodeAt(i) + i) % M;
  return hex8(a) + hex8(b);
}
