// 这一批是自己量出来的口径（探针之外）：fill 的 start/end、copyWithin、Math.log2 /
// Math.sign、String.raw 的普通调用形态、JSON.stringify 的**数组** replacer（白名单）。
// 前三样从前是"成员表里没有"（运行期报错），最后一样从前是**静默分叉** —— 白名单被
// 当成没给，多印了不该印的键。
console.log(JSON.stringify([1, 2, 3].fill(0, 1)), JSON.stringify([1, 2, 3].fill(9, 1, 2)));
console.log(JSON.stringify([1, 2, 3].fill(8, -2)), JSON.stringify([1, 2, 3, 4].fill(6, 1, -1)));
console.log(JSON.stringify([1, 2, 3].fill(5, 9)), JSON.stringify([1, 2, 3].fill(5, 1, 0)));
console.log(JSON.stringify([1, 2, 3, 4, 5].copyWithin(0, 3)), JSON.stringify([1, 2, 3, 4, 5].copyWithin(1, 3, 4)));
console.log(JSON.stringify([1, 2, 3, 4, 5].copyWithin(-2, 0)), JSON.stringify([1, 2, 3].copyWithin(0, 9)));
// 交出的是同一格数组（原地改），不是拷一份
const a = [1, 2, 3];
console.log(a.fill(7, 1) === a, a.join(","), a.copyWithin(0, 2) === a, a.join(","));
console.log(Math.log2(8), Math.log2(1), Math.log2(0), Math.sign(-3), Math.sign(4));
// sign 的零那一格原样送回：Math.sign(-0) 是 -0（console.log 印 -0，String(-0) 是 "0"）
console.log(Math.sign(0), Math.sign(-0), Math.sign(NaN), 1 / Math.sign(-0));
// 当值用（builtin 作为函数值那条路，len 那一格）
console.log([4, -1, 0].map(Math.sign).join(","), [1, 2, 4].map(Math.log2).join(","));
// String.raw 的普通调用：段数看 raw.length，最后一段后面不再拼插值；插值不够就当没有
console.log(String.raw({ raw: ["x", "y"] }, 7), String.raw({ raw: ["a"] }), String.raw({ raw: [] }) + "|");
console.log(String.raw({ raw: ["a", "b", "c"] }, 1), String.raw({ raw: ["a", "b"] }, 1, 2, 3));
// tag 形态（这条在降级器那儿就折成字面量了）：\n 照原文留着
console.log(String.raw`a\nb${1 + 1}c`, String.raw`\t`);
// JSON 的数组 replacer：按**名单的次序**、重复只留第一次、别的类型忽略、数组接收者不受影响
const o = { b: 1, a: 2, c: 3 };
console.log(JSON.stringify(o, ["a", "b"]), JSON.stringify(o, ["b", "a", "b"]));
console.log(JSON.stringify(o, ["zz"]), JSON.stringify(o, []), JSON.stringify(o, ["a", null, true, "b"]));
console.log(JSON.stringify({ 1: "x", 2: "y" }, [1]), JSON.stringify([{ a: 1, b: 2 }], ["a"]));
console.log(JSON.stringify({ a: { b: 1, c: 2 }, b: 9 }, ["a", "b"]), JSON.stringify({ a: [1, 2] }, ["a"]));
console.log(JSON.stringify(o, ["a"], 1));
// 函数形态与缩进那两条照旧
console.log(JSON.stringify({ a: 1, b: 2 }, (k, v) => (typeof v === "number" ? v * 2 : v)));
console.log(JSON.stringify({ a: 1 }, null, 2));
