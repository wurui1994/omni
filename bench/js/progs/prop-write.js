// bench/js/progs/prop-write.js —— **属性写**（读那一边有 IC 了，写那一边还没有）
//
// 两种写各占一半：
//   1. 改一格**已有**的字段（`p.x = …`）—— 热循环里最常见的一种，现在每次一趟哈希查找；
//   2. 现造对象（构造器里连着写四格）—— 那是"插新键"，还要沿形状树走一步。
// 规模按"V8 上几十毫秒"选（见 bench/js/run.mjs 头注）。
const N = 1500000;

function Point(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; }

function run(n) {
  const p = new Point(0, 0, 0, 0);
  let s = 0;
  for (let i = 0; i < n; i++) {
    p.x = i; p.y = i + 1; p.z = i + 2; p.w = i + 3;
    s += p.x + p.w;
    if ((i & 1023) === 0) { const q = new Point(i, i, i, i); s += q.y; }
  }
  return s;
}

console.log(run(N));
