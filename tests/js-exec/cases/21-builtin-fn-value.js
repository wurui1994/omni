// 内建函数**当值用**（ADR-0020 P1-f）：`const f = Math.abs` / `xs.map(Number)`。
// 降级出来的是一个薄包装闭包，体就是那一句 ABI 调用 —— 所以这条路**五条腿都走得通**，
// 不是 JS 那侧的特产。这条用例刻意只用数与串那几格 op（真对象那一族在 C 那侧还没有）。
const abs = Math.abs;
console.log(`abs ${abs(-3)} ${abs(2.5)}`);
const xs = [-1, -2, 3];
console.log(`map ${xs.map(Math.abs).join(",")}`);
console.log(`map ${["1", "2", "3"].map(Number).join(",")}`);
// map 传下去的第二个实参是下标，被 parseInt 当成了进制 —— 照规范，第二格起是 NaN
console.log(`radix ${["1", "2", "3"].map(parseInt).join(",")}`);
const f = Math.max;
console.log(`max ${f(3, 7)} ${f(-1, -9)}`);
// 同一个名字取两次是**同一个**函数值（单件，与顶层函数当值用同一格）
console.log(`same ${Math.abs === Math.abs} ${Math.abs === Math.floor}`);
const sq = Math.sqrt;
console.log(`sqrt ${sq(16)} ${sq(2) > 1.414}`);
console.log(`str ${[1, true].map(String).join("|")}`);
