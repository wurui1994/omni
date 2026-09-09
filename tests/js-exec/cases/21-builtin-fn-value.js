// 内建函数**当值用**（ADR-0020 P1-f）：`const f = Math.abs` / `xs.map(parseInt)`。
// 降级出来的是一个薄包装闭包，体就是那一句 ABI 调用 —— 所以这条路**五条腿都走得通**，
// 不是 JS 那侧的特产。这条用例刻意只用数与串那几格 op（真对象那一族在 C 那侧还没有）。
//
// `map(Number)` / `map(String)` 从前也在这儿。它们挪去了 js262/builtin-fn-value.js：
// String / Number / Boolean 这三个名字当值用时现在给的是 **realm 上那一格构造器对象**
// （`"".constructor === String` 要为真，见 ADR-0020），而 realm 是真对象那一族的东西，
// 只有 JS 那条腿有。这一格因此是**发射期**的拒，不是静悄悄的错值。
const abs = Math.abs;
console.log(`abs ${abs(-3)} ${abs(2.5)}`);
const xs = [-1, -2, 3];
console.log(`map ${xs.map(Math.abs).join(",")}`);
// map 传下去的第二个实参是下标，被 parseInt 当成了进制 —— 照规范，第二格起是 NaN
console.log(`radix ${["1", "2", "3"].map(parseInt).join(",")}`);
const f = Math.max;
console.log(`max ${f(3, 7)} ${f(-1, -9)}`);
// 同一个名字取两次是**同一个**函数值（单件，与顶层函数当值用同一格）
console.log(`same ${Math.abs === Math.abs} ${Math.abs === Math.floor}`);
const sq = Math.sqrt;
console.log(`sqrt ${sq(16)} ${sq(2) > 1.414}`);

// 可变实参与展开（同一刀）：op 是定长的，所以 3 个以上摊成一串两两调用、展开则是
// "整条实参表先求成 list，再按形状接下去"。这几行在 C 那条腿上走的是 js_arr_reduce /
// js_arr_map / js_arr_at 加一格就地合成的闭包 —— 所以必须在这儿量。
console.log(`vmax ${Math.max(1, 2, 3)} ${Math.min(4, 2, 9, 1)} ${Math.hypot(1, 2, 2)}`);
console.log(`vmax ${Math.max(5)} ${Math.min(5)} ${Math.max()} ${Math.min()}`);
const ns = [3, 9, 4];
console.log(`spread ${Math.max(...ns)} ${Math.min(...ns)} ${Math.max(1, ...ns, 20)}`);
console.log(`spread ${Math.max(...[])} ${Math.hypot(...[3, 4])}`);
console.log(`spread ${String.fromCharCode(...[72, 105])}`);

// 这一批也要在 C 那条腿上量：Array.from 的 mapFn 与类数组、Object.assign 的可变实参、
// Math.round（半数往 +∞，与 C 的 round 不是一回事）、以及 console.log 印 -0。
console.log(`from ${Array.from([1, 2], (x) => x * 2).join(",")} ${Array.from({ length: 3 }, (v, i) => i).join(",")}`);
console.log(`from ${Array.from("ab").join(",")} ${Array.from([1, 2], (v, i) => `${v}@${i}`).join("|")}`);
console.log(`assign ${JSON.stringify(Object.assign({}, { a: 1 }, { b: 2 }, { a: 3 }))}`);
// 原始值当源：串摊成下标键，数 / 布尔一格键都没有，null / undefined 跳过（规范 20.1.2.1）
console.log(`assign ${JSON.stringify(Object.assign({}, "ab", null, undefined, 3, true))}`);
console.log(`round ${Math.round(-0.5)} ${Math.round(0.5)} ${Math.round(2.5)} ${Math.round(-1.5)}`);
console.log(`round ${Math.round(0.49999999999999994)} ${Math.round(-1.2)} ${Math.round(NaN)}`);
console.log(-0, 0, String(-0), 1 / Math.round(-0.2) < 0);
