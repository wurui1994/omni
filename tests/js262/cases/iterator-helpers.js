// Iterator helpers（ES2025）：住在 Iterator.prototype 上，生成器的原型链上有它。
// 量三件事：惰性（无穷生成器上 take 得停得下来）、回调收 (value, counter)、
// 以及**关上游**（带 finally 的生成器在链子拉完之后就该跑 finally，一层层往上传）。
// 边界：空 reduce 与负的 take/drop 在规范里是 TypeError / RangeError，这个值域里是
// 当场报错（没有可 catch 的宿主错那一格），所以不在这条里量。
function* g() { try { let i = 0; while (true) yield i++; } finally { console.log("fin"); } }
console.log([...g().take(3)].join(","));
function* h() { yield 1; yield 2; yield 3; }
console.log(h().map((v, i) => `${v}@${i}`).toArray().join(" "));
console.log(h().filter((v, i) => i > 0).toArray().join(","));
console.log(h().drop(1).toArray().join(","), h().take(0).toArray().length);
console.log(h().flatMap((v) => [v, v * 10]).toArray().join(","));
console.log(h().reduce((a, b) => a + b), h().reduce((a, b) => a + b, 100));
console.log(h().some((v) => v === 2), h().every((v) => v > 0), h().find((v) => v > 1));
console.log(h().toArray().length, [...h().map((v) => v)].join(","));
const seen = [];
h().forEach((v, i) => seen.push(`${i}:${v}`));
console.log(seen.join(","));
// helper 交出来的都是同一格原型（%IteratorHelperPrototype%），不是 Iterator.prototype 本身
console.log(typeof h().take(1), Object.getPrototypeOf(h().take(1)) === Object.getPrototypeOf(h().map((x) => x)));
// 个数过一遍 ToIntegerOrInfinity：1.9 截成 1，drop(Infinity) 把上游抽干
console.log(h().take(1.9).toArray().join(","), h().drop(Infinity).toArray().length);
// 链起来：中间那一格被关掉时要把上游也关掉，所以 fin 照样跑
console.log([...g().map((x) => x * 2).take(3)].join(","));
console.log([...g().filter((x) => x % 2 === 0).take(3)].join(","));
console.log(g().take(5).reduce((a, b) => a + b, 0));
