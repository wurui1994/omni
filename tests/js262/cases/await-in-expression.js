// await / yield 在**表达式里面**（从前是 loud 拒绝："写成自己一句"）：现在提到语句层，
// 最后一处挂起之前的子表达式也落进临时量，所以求值次序不变。
// 惰性位置（a || await b、c ? await x : y、o?.m(await x)）照旧报错 —— 提出来会把
// "可能不算"变成"一定算"。
const log = [];
function side(x) { log.push(x); return x; }
async function f(v) { log.push("a" + v); return v; }
function* g() { const a = yield 1; const b = yield a * 2; return a + b; }
async function main() {
  console.log(1 + (await f(2)), (await f(3)) * 2, `${await f(4)}!`);
  console.log([await f(5), side(6)].join(","), { k: await f(7) }.k);
  log.length = 0;
  console.log(side(1) + (await f(9)) + side(2));
  console.log(log.join(","));
  const o = { v: 10, add(a, b) { return this.v + a + b; } };
  console.log(o.add(await f(1), 2));
  const arr = [1, 2, 3];
  console.log(arr[await f(0)], arr.slice(await f(1)).join(","));
  console.log(await f(await f(12)));
  async function ret() { return [await f(13)].join("|"); }
  console.log(await ret());
  const both = (await f(14)) + (await f(15));
  console.log(both, -(await f(16)), typeof (await f(17)), !(await f(0)));
  // 生成器那一侧：yield 在表达式里面同样提得出来
  function* h() { console.log("h", (yield 1) + 1, [yield 2].length); }
  const it = h();
  it.next();
  it.next(10);
  it.next(20);
  const gi = g();
  console.log(gi.next().value, gi.next(3).value, JSON.stringify(gi.next(4)));
}
main();
