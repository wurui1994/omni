// groupBy（ES2024）与 Promise.try（ES2025）。
// 回调**只收两个实参**（值、下标）—— 第三格是 undefined，这一条特意量在下面。
// Object.groupBy 交出来的是一格 null 原型的对象；Map.groupBy 的键按 SameValueZero 比。
const xs = [1, 2, 3, 4, 5];
console.log(JSON.stringify(Object.groupBy(xs, (x) => (x % 2 ? "odd" : "even"))));
const m = Map.groupBy(xs, (x) => x % 2);
console.log([...m.keys()].join(","), m.get(1).join(","), m.get(0).join(","));
console.log(JSON.stringify(Object.groupBy([], (x) => "a")), Map.groupBy([], (x) => 1).size);
console.log(JSON.stringify(Object.groupBy(["a", "b"], (v, i, arr) => `${v}${i}${arr}`)));
// 键过一遍 ToPropertyKey：数与布尔都变成串
console.log(JSON.stringify(Object.groupBy([1, 2], (x) => x > 1)));
Promise.try(() => 1).then((v) => console.log("try", v));
Promise.try(() => { throw new Error("boom"); }).catch((e) => console.log("caught", e.message));
Promise.try(() => Promise.resolve(9)).then((v) => console.log("adopt", v));
