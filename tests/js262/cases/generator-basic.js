// 生成器（ADR-0020 P2 的后半）。函数体被 genfn.js 切成一台状态机：
// 每两个 yield 之间是一段，`_g_st` 记着下一段，next(v) 送进来的值从段首接回去。
// 这一族只有 JS 那条腿（js_gen_new / js_gen_res 在 P1_JS_ONLY 里），所以走 js262 这道门。

function* two() { yield 1; yield 2; }
console.log([...two()].join(","));

// 展开、for-of 与手动 next 都走同一条迭代器协议（Symbol.iterator 返回自己）
const it = two();
const a1 = it.next();
const a2 = it.next();
const a3 = it.next();
console.log(a1.value, a1.done, a2.value, a3.value, a3.done);
for (const v of two()) console.log("of", v);

// 形参、局部量、循环：局部量的名字被提到外层函数体上（切段要跨过它们）
function* range(n) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += i;
    yield i;
  }
  return sum;
}
console.log([...range(4)].join(","));
const r = range(2);
r.next();
r.next();
console.log(JSON.stringify(r.next()));

// next(v) 的值是 yield 表达式的值
function* echo() {
  const x = yield "first";
  const y = yield x + 1;
  return y;
}
const e = echo();
const e1 = e.next().value;
const e2 = e.next(10).value;
const e3 = e.next(99);
console.log(e1, e2, e3.value, e3.done);

// break / continue 穿过 yield；while 与 do-while 同样切段
function* pick(xs) {
  for (const x of xs) {
    if (x === 2) continue;
    if (x === 4) break;
    yield x * 10;
  }
}
console.log([...pick([1, 2, 3, 4, 5])].join(","));

function* countdown() {
  let n = 0;
  while (true) {
    n++;
    if (n > 3) return n;
    yield n;
  }
}
console.log([...countdown()].join(","));

// yield*：一格一格转发出去
function* inner() { yield "a"; yield "b"; }
function* outer() { yield* inner(); yield "c"; }
console.log([...outer()].join(","));

// 生成器方法：*m() {} 与 *[Symbol.iterator]() {}
class Bag {
  constructor() { this.items = [1, 2, 3]; }
  *[Symbol.iterator]() { for (const x of this.items) yield x * 2; }
  *names() { yield "bag"; }
}
const b = new Bag();
console.log([...b].join(","));
console.log([...b.names()].join(","));
const lit = { data: ["p", "q"], *[Symbol.iterator]() { yield* this.data; } };
console.log([...lit].join("|"));

// it.return(v)：跑该跑的 finally，然后完
function* guarded() {
  try {
    yield 1;
    yield 2;
  } finally {
    console.log("cleanup");
  }
}
const g1 = guarded();
g1.next();
const back = g1.return(9);
console.log(back.value, back.done);
// 完了之后再叫就一直是 { undefined, true }
console.log(JSON.stringify(g1.next()));

// it.throw(e)：同样先跑 finally，再把异常接回调用者
const g2 = guarded();
g2.next();
try {
  g2.throw(new Error("boom"));
} catch (err) {
  console.log("caught", err.message);
}

// 还没开始就 return / throw：不进体
const g3 = guarded();
const early = g3.return(7);
console.log(early.value, early.done);

// 体里自己抛出来的：生成器就此完，异常往调用者那边冒
function* bad() { yield 1; throw new Error("inside"); }
const g4 = bad();
console.log(g4.next().value);
try {
  g4.next();
} catch (err) {
  console.log("inside", err.message);
}
console.log(JSON.stringify(g4.next()));
