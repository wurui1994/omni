// 收**可变实参**的内建当值用（Math.max / min / hypot 的 assoc、String.fromCharCode /
// fromCodePoint 的 fold）。从前包装按 spec.argc 定死形参个数，于是 F.max(1,2,3) 只拿前两格 ——
// 量出来的是一段真程序里 max(1,2,3) - min(4,5) 给 -2，而两把尺子是 -1；零实参那档给 NaN
// （规范是 -Infinity）。现在包成 (...xs) => Math.max(...xs)：带展开的调用走 abiSpreadCall
// 那条路，运行期 reduce，一格不差。Math.hypot / fromCharCode / fromCodePoint 顺手补上 len，
// 于是它们也能当值用了。
const F = { max: Math.max, min: Math.min, abs: Math.abs, sqrt: Math.sqrt };
const r = [];
r.push("max2=" + F.max(1, 2));
r.push("max3=" + F.max(1, 2, 3));
r.push("max0=" + F.max());
r.push("min2=" + F.min(4, 5));
r.push("min3=" + F.min(4, 5, 1));
r.push("min0=" + F.min());
r.push("spread=" + F.max(...[1, 5, 3]) + "," + F.min(...[4, 2, 9]));
r.push("abs=" + F.abs(-3));
r.push("direct=" + Math.max(1, 2, 3) + "," + Math.min(4, 5));
console.log(r.join("\n"));
const G = { hypot: Math.hypot, fcc: String.fromCharCode, fcp: String.fromCodePoint };
console.log(G.hypot(3, 4), G.hypot(1, 2, 2), G.hypot());
console.log(G.fcc(72, 105), G.fcp(97, 98), G.fcc());
console.log(Math.hypot.length, String.fromCharCode.length);
const nums = [3, 1, 4, 1, 5];
console.log(nums.reduce((a, b) => Math.max(a, b), -Infinity), Math.max(...nums));
console.log([[1,2],[3,4]].map((xs) => Math.min(...xs)).join(","));
