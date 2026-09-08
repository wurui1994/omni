// for-in：自有 + 原型上的可枚举键，不可枚举的不来
const base = { inherited: 1 };
Object.defineProperty(base, "hidden", { value: 2, enumerable: false });
const o = Object.create(base);
o.own = 3;
o[1] = 4;
const seen = [];
for (const k in o) seen.push(k);
console.log(seen.join(","));
const arr = ["a", "b"];
arr.extra = "c";
const ks = [];
for (const k in arr) ks.push(k);
console.log(ks.join(","));
