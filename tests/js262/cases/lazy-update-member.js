// 惰性位置（三元的分支、&& 的右边）里对**成员 / 下标**目标做 ++ / --。从前整族拒：
// lvalue 对成员目标头一件事就是 emitPre 存接收者，而惰性位置里开不了语句 ——
// 报 "hoist it into a statement"，而下面这些是再普通不过的 JS（手写迭代器就是这个形状）。
// 现在"存接收者"与"存计算键"也折进表达式，靠"三元的条件一定先算、两条分支又一样"定顺序；
// 于是 get 与 set 读的是同一格临时量，C 那边实参求值次序未指定也不再要紧。
const o = { i: 0, next() { return this.i < 3 ? { value: this.i++, done: false } : { done: true }; } };
console.log(JSON.stringify(o.next()), JSON.stringify(o.next()), JSON.stringify(o.next()), JSON.stringify(o.next()));
// 前缀 / 计算键 / 数组下标 也在惰性位置里
const a = [10, 20, 30];
let k = 0;
const pick = (c) => c ? a[k++] : "no";
console.log(pick(true), pick(true), pick(false), k);
const b = { n: 5, m: 7 };
const which = "n";
console.log(true ? ++b.n : 0, true ? b[which]++ : 0, b.n);
let i2 = 0;
const step = () => (i2 < 2 && a[i2++] === 10) ? "hit" + i2 : "miss" + i2;
console.log(step(), step(), step());
// 手写迭代器整条跑一遍
const it = { i: 0, [Symbol.iterator]() { return this; }, next() { return this.i < 3 ? { value: this.i++, done: false } : { done: true }; } };
console.log([...it].join(","));
