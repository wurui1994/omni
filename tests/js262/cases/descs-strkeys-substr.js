// getOwnPropertyDescriptors（复数）、串上的 Object.keys / values / entries、substr。
// 串那一族：规范里 Object.keys 先 ToObject，串于是成了类数组 —— 键是下标的十进制串、
// 值是一个个码元（量过：qjs 的 Object.keys("ab") 是 ["0","1"]）。
const o = { a: 1, get g() { return 2; } };
const ds = Object.getOwnPropertyDescriptors(o);
console.log(Object.keys(ds).join(","), JSON.stringify(ds.a), ds.g.get !== undefined);
console.log(Object.keys("ab").join(","), Object.values("ab").join("|"), JSON.stringify(Object.entries("ab")));
console.log(Object.keys("").length, JSON.stringify(Object.getOwnPropertyDescriptors({})));
// substr（Annex B）：起点认负数（从末尾数），第二格是**长度**不是终点
console.log("abcdef".substr(1, 2), "abcdef".substr(-2), "abcdef".substr(-3, 2), "abc".substr(1));
console.log("abc".substr(0, 0) === "", "abc".substr(9), "abc".substr(1, 99), "abc".substr(-9, 2));
