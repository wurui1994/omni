// call / apply / bind 在五条腿上（ADR-0020 P1-c）。C 那条腿上它们是**原生函数值**：
// f.call / f.apply 是一格捕获了目标的原生（sel 8 / 9），bind 出来的那一格把
// [目标, this, 名字, 形参个数, …预置的实参] 存进载荷 —— 名字与个数是每一格自己的
// （"bound f" / max(0, len - 预置个数)），所以不能按 sel 查静态表。
// 借方法（Object.prototype.toString.call(x)）与 bind 链（bound bound f）都在里头。
function f(a, b, c) { return [this && this.v, a, b, c].join("|"); }
const o = { v: "V" };
console.log(f.call(o, 1));
console.log(f.apply(o, [1, 2, 3]));
const g1 = f.bind(o);
const g2 = f.bind(o, 1);
const g3 = g2.bind({ v: "W" }, 2);
console.log(g1(9), g2(8), g3(7));
console.log(g1.name, g1.length, g2.name, g2.length, g3.name, g3.length);
console.log(Object.prototype.toString.call([]), Object.prototype.toString.call({}));
console.log(Object.prototype.hasOwnProperty.call({ a: 1 }, "a"), Object.prototype.hasOwnProperty.call({}, "a"));
const arr = [3, 1, 2];
console.log(Object.prototype.toString.call(arr));
const borrow = { m() { return this.tag; } };
console.log(borrow.m.call({ tag: "T" }));
console.log(typeof f.call, typeof f.bind, typeof g1.call);
console.log(f.call.call(f, o, 5));
