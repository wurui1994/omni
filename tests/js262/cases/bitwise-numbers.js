/* Number 上的位运算（规范 7.1.6 ToInt32 / 7.1.7 ToUint32）：两边先截成 int32，结果是
   Number。从前这一族当场报 "requires bigint operands" —— 位运算在 JS 里满地都是。
   bigint 那一支照旧按 64 位算（这个值域里 bigint 与方言的 int64 同一个标签）。 */
console.log(~5, ~0, ~-1, ~~-1.5, ~2.9, ~NaN, ~Infinity);
console.log(5 & 3, 5 | 3, 5 ^ 3, 1 << 31, (1 << 31) >>> 0, -5 >>> 0, 5 >>> 1);
console.log(-1 >> 1, -1 >>> 28, 1 << 32, 1 << 33, 8 >> 33, 2147483647 + 1 | 0);
console.log("5" & 3, "5" | "3", true & 1, null | 0, undefined | 0, [] | 0, 4294967296 | 0);
console.log(3.9 & 3, -3.9 | 0, 1e21 | 0, (-1e21) | 0, 0.5 << 1);
// bigint 那一支照旧按 64 位算（印出来不带 n 是刻意的分叉，见 ADR-0020，所以这儿比串）
console.log(String(5n & 3n), String(5n | 3n), String(1n << 40n), String(-8n >> 2n), String(~5n));
// parseInt / parseFloat 在规范里是**同一个函数对象**，两条写法取出来该相等
console.log(Number.parseInt === parseInt, Number.parseFloat === parseFloat);
console.log(Number.parseInt("42"), Number.parseInt.name, Number.parseInt.length);
const pi = parseInt, pi2 = Number.parseInt;
console.log(pi === pi2, [pi("10"), pi2("10", 2)].join(","));
