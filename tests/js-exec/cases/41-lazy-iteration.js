// for-of / 解构在真迭代器上必须**惰性**（ADR-0020）：每轮恰好拉一次 next。
// C 那条腿上从前是先把上游整个摊成一条 list，于是无穷生成器直接**挂住** —— 挂死比错答案更坏，
// 所以现在那条腿也有一格三槽把手 [$it, $d, $v]。这里量四件事：无穷源上 break 得出来、
// break 出来要跑得到生成器的 finally、rest 抽到 done、以及手写 Symbol.iterator 的对象同路。
function* nat() { let i = 1; while (true) yield i++; }
for (const x of nat()) { if (x > 3) break; console.log("of", x); }
function* fin() { try { yield 1; yield 2; yield 3; } finally { console.log("cleanup"); } }
for (const x of fin()) { console.log("f", x); if (x === 2) break; }
function* nat2() { yield 1; yield 2; yield 3; yield 4; }
const [a, b, ...rest] = nat2();
console.log(a, b, rest.join(","));
const [p, q] = nat();
console.log("lazy destructure", p, q);
function* g2() { yield 1; yield 2; }
console.log([...g2()].join(","), Array.from(g2()).join("-"));
for (const [k, v] of new Map([[1, "a"], [2, "b"]])) console.log("m", k, v);
const obj = { [Symbol.iterator]() { let i = 0; return { next: () => (i < 2 ? { value: i++, done: false } : { value: undefined, done: true }) }; } };
for (const x of obj) console.log("proto", x);
console.log([...obj].join(","));
