// 内建函数**当值用**（ADR-0020 P1-f）：`const f = Object.keys` / `[1,2].map(Number)`。
// 量三件事：调用结果、name / length（照规范，不是 op 的形参个数）、以及**同一个名字取
// 两次是同一个值**（`Object.keys === Object.keys`）。
// 表里没标 len 的名字（console.log / String.fromCharCode 这些收可变实参的）照旧是编译期
// 报错，不在这条用例里量 —— 那是"不给会撒谎的值"那条边界。
const keys = Object.keys;
console.log(keys({ a: 1, b: 2 }).join(","));
console.log(keys.name, keys.length);
console.log(Object.keys === Object.keys);
console.log([1, 2, 3].map(Number).join(","));
// 第二个实参是 map 给的下标，被 parseInt 当成进制 —— 所以第二格是 NaN（规范如此）
console.log(["1", "2", "3"].map(parseInt).join(","));
console.log(["a", 1, true].map(String).join("|"));
console.log(Math.abs.name, Math.abs.length, Math.max.length);
const abs = Math.abs;
console.log(abs(-3), abs(-2.5));
console.log([-1, -2].map(Math.abs).join(","));
console.log(typeof Object.assign, Object.assign.length);
console.log(JSON.stringify.length, JSON.parse.length);
console.log(Array.isArray.name, [[], 1].map(Array.isArray).join(","));
console.log(Number.parseFloat("2.5e1"), Number.parseFloat.length);
const isInt = Number.isInteger;
console.log(isInt(3), isInt(3.5), isInt.name);
