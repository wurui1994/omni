// 生成器里的 for-of 从前是"先收齐再走"（js_iter 收成一格 list），于是套一个惰性源就挂住：
//   function* take(it, n) { for (const v of it) { … } }   配一个无穷生成器 -> 永不返回。
// 既不响也不停，比错答案还糟。现在走与 lower.js 的 forOf 逐行对齐的惰性把手
// （js_iter_open / done / cur / close）；return 穿出去那条路也补一次 close（规范的
// IteratorClose，见 genfn.js 的 closeOpenIters）—— 不然 take 之后源还会被拉到底。
let pulled = 0;
function* counted(n) { for (let i = 0; i < n; i++) { pulled++; yield i; } }
pulled = 0;
const out1 = [];
for (const v of counted(100)) { out1.push(v); if (out1.length === 3) break; }
console.log("break", out1.join(","), pulled);
pulled = 0;
function* take3(it) { let k = 0; for (const v of it) { if (k++ >= 3) return; yield v; } }
console.log("take", [...take3(counted(100))].join(","), pulled);
function* nat() { let i = 0; for (;;) yield i++; }
const first = [];
for (const v of nat()) { first.push(v); if (first.length === 4) break; }
console.log("inf", first.join(","));
function* takeN(it, n) { let k = 0; for (const v of it) { if (k++ >= n) return; yield v; } }
console.log("gen-over-inf", [...takeN(nat(), 3)].join(","));
// 嵌套两层 for-of，里层 return 穿出去
function* pairs(xs, ys) { for (const x of xs) { for (const y of ys()) { if (y > 1) break; } yield x; } }
console.log("nested", [...pairs([1, 2], nat)].join(","));
// for-in 照旧是"先收齐键再走"（键本来就得先收齐）
const o = { a: 1, b: 2 };
function* keys(x) { for (const k in x) yield k; }
console.log("forin", [...keys(o)].join(","));
