// bench/js/progs/method-call.js —— **方法调用 + `this`**（调用约定那一层的账）
//
// ADR-0047 §3.3 说"调用：去掉每次一条 list"：我们现在每个 JS 函数都是
// `omni_dyn f(omni_fn, omni_list_dynamic)` —— 入口 n 次 `arr_get`、出口构造一条 list。
// 这一份把那一格单独拎出来：短方法、在热循环里反复叫。
// V8 上这是 IC 认出目标之后的直接调用（甚至内联）。
const N = 4000000;

function Vec(x, y) { this.x = x; this.y = y; }
Vec.prototype.dot = function (o) { return this.x * o.x + this.y * o.y; };
Vec.prototype.scale = function (k) { return new Vec(this.x * k, this.y * k); };

function run(n) {
  const a = new Vec(1, 2);
  const b = new Vec(3, 4);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += a.dot(b);
  }
  return s;
}

console.log(run(N));
