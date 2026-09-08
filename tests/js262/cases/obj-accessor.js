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
