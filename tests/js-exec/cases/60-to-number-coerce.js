// 到数的强制转换（ToNumber / ToInt32）在**各种操作数**上：16 种值 × 17 种运算。
//
// 为什么单独一份：`>>>` 那条路（`js_i32_op` / `js_i32_tou`，ADR-0013 第三刀）从前
// **直接拿检查过的 `omni_dyn_as_real` 取操作数** ⇒ 操作数不是 real 就当场死在
// `dynamic value is bool, expected real`。`true >>> 2` / `"3" >>> 2` / `null >>> 2`
// 三个都崩，而 node 上都是 0。规范 7.1.6 的第一步就是 ToNumber，那一步整个漏了。
//
// 上面那一族（`js_arith` / `js_bitop`）走的是另一条路（`to_num1`），所以这一份把
// **两条路一起**压住：谁再动那两处，这一格立刻红。
const xs = [0, 1, -1, 2.5, NaN, Infinity, true, false, null, '3', '3.5', '', 'abc', [], [7], {}];
const out = [];
for (let k = 0; k < xs.length; k++) {
  const a = xs[k];
  out.push(String(a - 2), String(a * 2), String(a / 2), String(a % 2), String(a ** 2));
  out.push(String(a | 2), String(a & 2), String(a ^ 2), String(a << 2), String(a >> 2), String(a >>> 2));
  out.push(String(-a), String(+a), String(a + 2), String(2 + a));
  let b = a;
  b++;
  out.push(String(b));
  let c = a;
  --c;
  out.push(String(c));
}
console.log(out.join('|'));
