class P {
  constructor(x, y) { this.x = x; this.y = y; }
  sum() { return this.x + this.y; }
  get mag() { return this.x * 10 + this.y; }
  static make(v) { return new P(v, v); }
}
const p = new P(1, 2);
console.log(p.x, p.y, p.sum(), p.mag);
console.log(P.make(3).sum(), Object.keys(p).join(","), JSON.stringify(p));
class Q extends P {
  constructor(v) { super(v, v * 2); this.tag = "q"; }
  sum() { return super.sum() * 100; }
}
const q = new Q(2);
console.log(q.x, q.y, q.tag, q.sum(), q.mag);
console.log(q instanceof Q, q instanceof P, typeof q);
function F(a) { this.a = a; }
