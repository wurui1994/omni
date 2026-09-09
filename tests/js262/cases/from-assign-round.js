// 又四格量出来的缺口：Array.from 的 mapFn 与类数组、Object.assign 的可变实参、
// Math.round（**半数往 +∞**，与 C 的 round 离零舍入不是一回事），以及 console.log 印 -0。
// -0 那一条两把尺子一致：String(-0) 是 "0"，而 console.log(-0) 印 "-0"。
console.log(Array.from([1, 2], (x) => x * 2).join(","), Array.from("ab").join(","));
console.log(Array.from({ length: 3 }, (v, i) => i).join(","), Array.from([]).length);
console.log(Array.from([1, 2], (v, i) => `${v}@${i}`).join("|"), Array.from(new Set([1, 1, 2])).join(","));
console.log(JSON.stringify(Object.assign({}, { a: 1 }, { b: 2 }, { a: 3 })));
console.log(JSON.stringify(Object.assign({ x: 0 }, { y: 1 })), JSON.stringify(Object.assign({ z: 1 })));
// 原始值当源（规范 20.1.2.1 第 4 步）：串摊成下标键，数 / 布尔 / bigint 一格键都没有，
// null / undefined 跳过。从前数与布尔那两支当场报 "real is not an object"。
console.log(JSON.stringify(Object.assign({}, "ab", null, undefined, 3, true, 7n)));
console.log(JSON.stringify(Object.assign({ a: 1 }, "xy")), JSON.stringify(Object.assign({}, Symbol("s"))));
console.log(Math.round(-0.5), Math.round(0.5), Math.round(2.5), Math.round(-1.5));
// 这一格是"floor(x + 0.5)"那种写法的分水岭：加法先舍到 0.5，答案就成了 1
console.log(Math.round(0.49999999999999994), Math.round(-0.49999999999999994));
console.log(Math.round(NaN), Math.round(Infinity), Math.round(2), Math.round(-1.2));
console.log(-0, 0, String(-0), `${-0}`, [-0].join(","), JSON.stringify(-0));
console.log(1 / Math.round(-0.5) < 0, Math.round.name, Math.round.length);
