/* for-of 的**惰性**形态（ADR-0020 的那一刀）：js_iter_open 交出 list 或一格迭代把手、
   js_iter_done 一轮走一格、循环出口补一次 js_iter_close。从前 for-of 先把迭代器**抽干**
   再遍历，于是三样都不对：next 多调了、提前退出不调 return()、无穷生成器直接挂住。 */
let calls = 0;
const counted = {
  [Symbol.iterator]() {
    let i = 0;
    return { next() { calls++; return { value: i++, done: i > 100 }; } };
  },
};
for (const v of counted) { if (v === 2) break; }
console.log("calls", calls);

let closed = 0;
const withRet = {
  [Symbol.iterator]() {
    let i = 0;
    return {
      next() { return { value: i++, done: false }; },
      return() { closed++; return { done: true }; },
    };
  },
};
for (const w of withRet) { if (w === 1) break; }
console.log("closed", closed);

// 正常跑完**不**调 return()（规范只在 abrupt 退出时调）
let closed2 = 0;
const three = {
  [Symbol.iterator]() {
    let i = 0;
    return {
      next() { return { value: i++, done: i > 3 }; },
      return() { closed2++; return { done: true }; },
    };
  },
};
const seen = [];
for (const x of three) seen.push(x);
console.log("done-run", seen.join(","), closed2);

// 带 finally 的生成器：break 出来要跑清理（靠 return()）
function* gf() {
  try { yield 1; yield 2; yield 3; } finally { console.log("cleanup"); }
}
for (const y of gf()) { if (y === 2) break; }

// 无穷生成器 + break：从前是挂住（30s 超时）
function* nat() { let n = 0; while (true) yield n++; }
const got = [];
for (const z of nat()) { if (z > 4) break; got.push(z); }
console.log(got.join(","));

// continue 也是一轮恰好一格
let bodies = 0;
function* upto() { bodies++; yield 1; bodies++; yield 2; bodies++; yield 3; }
let sum = 0;
for (const t of upto()) { if (t === 2) continue; sum += t; }
console.log(sum, bodies);

// 内建容器照旧（list / string / Map / Set 本来就是抽干的语义）
const arr = [1, 2, 3];
const pairs = [];
for (const a of arr) for (const b of arr) if (a < b) pairs.push(`${a}${b}`);
console.log(pairs.join(","));
for (const [mk, mv] of new Map([["k", 1]])) console.log(mk, mv);
console.log([...new Set([3, 4])].join(","), [..."ab"].join("|"));
for (const e of []) console.log("never");
// 体里往数组上追加：把手就是那个数组，所以下标是**活**的
const live = [1, 2, 3];
const out = [];
for (const lv of live) { out.push(lv); if (lv === 1) live.push(9); }
console.log(out.join(","), live.length);
