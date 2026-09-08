// this 是调用接收者：方法借用 / call / apply / bind
function who() { return this === undefined ? "undefined" : this.name; }
const a = { name: "a", who };
const b = { name: "b", who };
console.log(a.who(), b.who());
console.log(who.call(a), who.apply(b), who.call({ name: "c" }));
const bound = who.bind({ name: "d" });
console.log(bound(), bound.call(a));
function sum(x, y) { return this.base + x + y; }
console.log(sum.call({ base: 10 }, 1, 2), sum.apply({ base: 20 }, [1, 2]));
const psum = sum.bind({ base: 100 }, 1);
console.log(psum(2));
const arr = [3, 1, 2];
console.log(Array.prototype.join.call(arr, "|"));
