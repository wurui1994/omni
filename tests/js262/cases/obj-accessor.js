// 对象字面量里的访问器（ADR-0020 P1）
const o = {
  x: 1,
  get double() { return this.x * 2; },
  set double(v) { this.x = v / 2; },
};
console.log(o.double);
o.double = 10;
console.log(o.x, o.double);
const d = Object.getOwnPropertyDescriptor(o, "double");
console.log(typeof d.get, typeof d.set, d.enumerable, d.configurable);
/* 三格逻辑赋值（规范 13.15.2）目标**只读一次**：从前条件里与"保持原值"那一支各读一次，
   于是取值器被叫了两遍。取值器与设值器上数得出来，所以这一格量的是调用次数。 */
let reads = 0, writes = 0;
const c = { get v() { reads++; return 5; }, set v(x) { writes++; } };
c.v ??= 1;
console.log(reads, writes, c.v, reads);
reads = 0; writes = 0;
c.v ||= 2;
console.log(reads, writes);
reads = 0; writes = 0;
c.v &&= 3;
console.log(reads, writes);
// += 那一族照旧是"读一次、写一次"
reads = 0; writes = 0;
c.v += 1;
console.log(reads, writes);
// 名字目标：写进去才算，条件那一次不额外求值
const ev = [];
const mk = (t, v) => { ev.push(t); return v; };
let n = null;
n ??= mk("n", 7);
let m = 1;
m ??= mk("m", 8);
console.log(n, m, ev.join(","));
