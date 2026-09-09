class P {
  constructor(x, y) { this.x = x; this.y = y; }
  sum() { return this.x + this.y; }
  get mag() { return this.x * 10 + this.y; }
  set both(v) { this.x = v; this.y = v; }
  static make(v) { return new P(v, v); }
  static kind = "point";
}
const p = new P(1, 2);
console.log(p.x, p.y, p.sum(), p.mag);
p.both = 7;
console.log(p.x, p.y, P.make(3).sum(), P.kind);
console.log(Object.keys(p).join(","), JSON.stringify(p), typeof p, String(p));
console.log(p instanceof P, ({}) instanceof P, Object.getPrototypeOf(p) === P.prototype);
console.log(Object.hasOwn(p, "x"), Object.hasOwn(p, "sum"), "sum" in p);
const ks = [];
for (const k in p) ks.push(k);
console.log(ks.join(","));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(p, "x")));
const frozen = Object.freeze(new P(1, 1));
frozen.x = 9;
console.log(frozen.x, Object.isFrozen(frozen), Object.isExtensible(frozen));
