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

// 可变实参与展开（同一刀）：op 是定长的，所以 3 个以上摊成一串两两调用、展开则是
// "整条实参表先求成 list，再按形状接下去"。这几行在 C 那条腿上走的是 js_arr_reduce /
// js_arr_map / js_arr_at 加一格就地合成的闭包 —— 所以必须在这儿量。
console.log(`vmax ${Math.max(1, 2, 3)} ${Math.min(4, 2, 9, 1)} ${Math.hypot(1, 2, 2)}`);
console.log(`vmax ${Math.max(5)} ${Math.min(5)} ${Math.max()} ${Math.min()}`);
const ns = [3, 9, 4];
console.log(`spread ${Math.max(...ns)} ${Math.min(...ns)} ${Math.max(1, ...ns, 20)}`);
console.log(`spread ${Math.max(...[])} ${Math.hypot(...[3, 4])}`);
console.log(`spread ${String.fromCharCode(...[72, 105])}`);
