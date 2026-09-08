// P4 第一批库方法（ADR-0020）：flat / reduceRight / toSorted / replaceAll / padEnd。
// 这一条用例存在的理由是**验 C 那条腿** —— 每个方法都是"prelude 一份 + C 一份"，
// C 那份写坏了不会在 JS 后端上露出来，只有这里三条腿一起跑才会。
const nested = [1, [2, 3], [4, [5, [6]]]];
console.log(`flat1 ${JSON.stringify(nested.flat())}`);
console.log(`flat2 ${JSON.stringify(nested.flat(2))}`);
console.log(`flatInf ${JSON.stringify(nested.flat(Infinity))}`);
console.log(`flat0 ${JSON.stringify([[1], 2].flat(0))}`);

const xs = [1, 2, 3, 4];
console.log(`reduceR ${xs.reduceRight((a, b) => a + "," + b)}`);
console.log(`reduceR0 ${xs.reduceRight((a, b) => a + b, 100)}`);
console.log(`reduceRidx ${xs.reduceRight((a, b, i) => a + i, 0)}`);

const src = [3, 1, 2];
const sorted = src.toSorted((a, b) => a - b);
// toSorted 不动原数组，这一行是它和 sort 的分水岭
console.log(`toSorted ${JSON.stringify(sorted)} ${JSON.stringify(src)}`);
console.log(`toSortedDefault ${JSON.stringify([10, 9, 1].toSorted())}`);

console.log(`replaceAll ${"a-b-c".replaceAll("-", "+")}`);
console.log(`replaceAll ${"aaa".replaceAll("aa", "b")}`);
console.log(`replaceAll ${"abc".replaceAll("", "-")}`);
console.log(`replaceAll ${"abc".replaceAll("x", "y")}`);

console.log(`padEnd ${"7".padEnd(4, "0")}|`);
console.log(`padEnd ${"7".padEnd(4)}|`);
console.log(`padEnd ${"abcd".padEnd(2, "0")}|`);
console.log(`padEnd ${"ab".padEnd(7, "xyz")}|`);

// at 在数组上：负下标从尾部数（a[-1] 走的是取属性那条路，给 undefined）
console.log(`at ${xs.at(0)} ${xs.at(-1)} ${xs.at(4)} ${xs.at(-9)} ${xs[-1]}`);

