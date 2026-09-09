/* 对象**自带的 toString** 要被调（规范 7.1.17 的 ToString 走 ToPrimitive）。C 那条腿上
   这一格从前当场报："调回调要现拼一条实参 list，而运行时那份 to_s16 住在普通 .c 里造不
   出来"。现在 js_str / js_disp 两条 op 指向宏段里的 omni_js_str_v / omni_js_disp_v ——
   段里 list 是现成的，所以调得动。
   `+` 与 Array.prototype.join 那两条路还落在运行时的 to_s16 上（它们在段里也是直接
   转字符串），所以那两格照旧是一句响错，记在 ADR-0020 里；这份用例只量 String() 与模板。 */
class Money {
  constructor(v) { this.v = v; }
  toString() { return "$" + this.v; }
}
const m = new Money(3.5);
console.log(String(m), m.toString(), `${m}`);
const lit = { n: 2, toString() { return "L" + this.n; } };
console.log(String(lit), `${lit}`);
console.log(String({ a: 1 }), String([1, 2]));
const proto = { toString() { return "P"; } };
console.log(String(Object.create(proto)), `${Object.create(proto)}`);
class Chain extends Money { toString() { return "c:" + super.toString(); } }
console.log(String(new Chain(1)));
