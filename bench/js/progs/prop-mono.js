// bench/js/progs/prop-mono.js —— **单态属性访问**：榜首那一格（ADR-0047 §10）
//
// `-O2` 那一趟量出来 `omni_js_obj_getk` 含子 36.20%、`dict_string_dynamic_find` 自用 25.50%
// —— 那是"小表线性扫 + 逐格比串"。这一份把它单独拎出来：**一个形状、四个字段、只读**。
// V8 上这条路是 `(Map, offset)` 的 monomorphic IC ⇒ 一次形状比较 + 一次定偏移读。
//
// 规模按"V8 上几十毫秒"选（见 bench/js/run.mjs 头注）：工作量太小的话进程启动占比太大。
const N = 3000000;

function Point(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; }

function run(n) {
  const p = new Point(1, 2, 3, 4);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += p.x + p.y + p.z + p.w;
  }
  return s;
}

console.log(run(N));
