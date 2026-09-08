// Number.prototype.toString 的接收者不止 real：int（这个值域里的 bigint）与 bool 本来
// 落到"取属性再当函数调"的兜底上，于是 (5n).toString() 给出 [object Number]。
// 两条腿都改了（prelude 的 $js_num_to_string 与 runtime 的 omni_js_num_to_string），
// 所以这一条走五条腿的差分。
//
// 顺带记一格**刻意的不齐**：这个值域里的 int 是 int64（ADR-0005），所以 2n ** 64n 是 0，
// 不是 2^64 —— 五条腿一致地是 0，与 qjs 不同。那一格要等 BigInt 单独立一节（ADR-0020）。
console.log((5).toString(), (1.5).toString(), (-7).toString());
console.log((255).toString(16), (255).toString(2), (35).toString(36));
console.log((5n).toString(), (-5n).toString(), (0n).toString());
console.log((255n).toString(16), (1024n).toString(2));
console.log(true.toString(), false.toString());

// 大到 double 装不下的 int64 也要按位精确（先转 double 就会掉精度）
const big = 9007199254740993n;
console.log(big.toString());

// 模板与拼接走的是另一条路（js_str），这儿一起量一眼
console.log(`${5n}|${true}|${1.5}`);
console.log(String(5n) + String(false));
