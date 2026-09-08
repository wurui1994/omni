// 函数那一面量出来的四格：for (let i…) 的**每轮一格新绑定**（静默分叉 —— 从前是 loud 拒绝，
// 拒绝掉的正是最常见的写法）、具名函数表达式引用自己、内建函数值上的 call/apply、
// bind 出来的那一格的 name 与 length。
const fns = [];
for (let i = 0; i < 3; i++) fns.push(() => i);
console.log(fns.map((h) => h()).join(","));
const vfns = [];
for (var j = 0; j < 3; j++) vfns.push(() => j);
console.log(vfns.map((h) => h()).join(","));
const cont = [];
for (let m = 0; m < 4; m++) { if (m === 2) continue; cont.push(() => m); }
console.log(cont.map((h) => h()).join(","));
const two = [];
for (let a = 0, b = 10; a < 2; a++, b--) two.push(() => `${a}:${b}`);
console.log(two.map((h) => h()).join(","));
// 嵌套的两层循环各自一格
const grid = [];
for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) grid.push(() => `${x}${y}`);
console.log(grid.map((h) => h()).join(","));
// 具名函数表达式：那个名字只在体里可见，指着自己
const fact = function fx(n) { return n <= 1 ? 1 : n * fx(n - 1); };
console.log(fact(5), fact.name, fact.length);
const fib = function f(n) { return n < 2 ? n : f(n - 1) + f(n - 2); };
console.log(fib(10), [1, 2, 3].map(function dbl(v) { return v * 2; }).join(","));
// 内建函数当值用 + call / apply
console.log(Math.max.apply(null, [1, 9, 3]), Math.max.call(null, 4, 2));
console.log(Number.isInteger.call(null, 3), [1, 0, 2].map(Boolean).join(","));
console.log(Array.prototype.join.call([1, 2], "|"), Object.prototype.hasOwnProperty.call({ a: 1 }, "a"));
// bind：name 是 "bound " 加原名、length 是原来的减去预绑的实参个数
function sum3(a, b, c) { return a + b + c; }
const b1 = sum3.bind(null, 1);
const b2 = b1.bind(null, 2);
console.log(sum3.length, b1.length, b2.length, b2(3));
console.log(sum3.name, b1.name, b2.name);
const o = { v: 10, get() { return this.v; } };
const bg = o.get.bind({ v: 7 });
console.log(bg(), bg.name, bg.length);
