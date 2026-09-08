// 内建里的可变实参与展开（ADR-0020 P1-f）：`Math.max(1,2,3)` / `Math.max(...xs)` /
// `console.log(...args)`。op 是定长的，所以三个以上摊成一串两两调用；展开的长度只有
// 运行期才知道，于是整条实参表先求成一个 list，再按这个名字的形状接下去。
// 单位元那一格照规范：max 是 -Infinity、min 是 +Infinity、hypot 是 0 —— 所以
// `Math.max(x)` 就是 ToNumber(x)，`Math.max()` 是 -Infinity。
console.log(Math.max(1, 2, 3), Math.min(4, 2, 9, 1), Math.hypot(1, 2, 2));
console.log(Math.max(5), Math.min(5), Math.max(), Math.min());
console.log(Math.max(-0, 0), Math.max(NaN, 1), Math.min(1, NaN), Math.hypot(-3));
const xs = [3, 9, 4];
console.log(Math.max(...xs), Math.min(...xs), Math.max(1, ...xs, 20));
console.log(Math.max(...[]), Math.hypot(...[3, 4]));
const args = ["a", 1, true];
console.log(...args);
console.log("x", ...args, "y");
console.log(String.fromCharCode(...[72, 105]), String.fromCharCode(...[]));
// 定长的那些：按下标取头几格，缺的自然是 undefined
console.log(Object.keys(...[{ a: 1, b: 2 }]).join(","), JSON.stringify(...[{ a: 1 }]));
