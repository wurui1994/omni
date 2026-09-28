// bench/js/progs/prop-poly.js —— **多态属性访问**（同一处代码见好几种形状）
//
// 与 prop-mono 成对：V8 上这一份走 POLY（≤4 个 Map 线性试）而不是 MONO，
// 所以它量的是"IC 退化一档之后还剩多少"。我们现在两份都走同一条哈希查找 ⇒
// 两份的比值差，正好说明"形状这一层到底值多少"。
const N = 1500000;

function A(x) { this.x = x; this.a = 1; }
function B(x) { this.x = x; this.b = 2; }
function C(x) { this.x = x; this.c = 3; }

function sum(o) { return o.x; }

function run(n) {
  const objs = [new A(1), new B(2), new C(3)];
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += sum(objs[0]) + sum(objs[1]) + sum(objs[2]);
  }
  return s;
}

console.log(run(N));
