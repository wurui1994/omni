/* String(容器)：规范 23.1.3.36 —— Array.prototype.toString 就是 join(",")，null 与
   undefined 那格写成空串，嵌套的数组递归下去；普通对象是 "[object Object]"；异常对象是
   "Name: message"（20.5.3.4，message 空时只剩 Name）。四条腿以前只有三条对：C 那条在
   这儿硬报 "cannot convert list to string"。 */
const a = [1, 2, "x"];
console.log(String(a));
console.log(`v=${a}`);
console.log("" + a);
console.log([a, a].join("|"));
console.log(String([1, [2, [3, [4]]]]));
console.log(String([null, undefined, 5]));
console.log(String([]));
console.log(String([[], [[]]]));
console.log(String([true, -0, 1e21, 0.5]));

const o = { a: 1 };
console.log(String(o));
console.log(`o=${o}`);
console.log(String([o, new Map(), new Set()]));

console.log(String(new Error("x")));
console.log(String(new Error("")));
console.log(String(new TypeError("bad")));
console.log(String([new RangeError("r")]));
console.log("t: " + new Error("cat"));
