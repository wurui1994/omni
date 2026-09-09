// 端到端回归：带重试的任务队列。async / await、Promise.allSettled、生成器分块、
// 错误子类穿过 await、生成器的 throw、以及"微任务顺序"（sync -> async-start -> sync2 -> …）。
// 第三段真程序：带重试与超时的任务队列（async / 生成器 / 错误传播 / 闭包）
class TaskError extends Error {
  constructor(msg, attempts) { super(msg); this.name = "TaskError"; this.attempts = attempts; }
}
function makeFlaky(failTimes, label) {
  let n = 0;
  return async () => {
    n += 1;
    if (n <= failTimes) throw new Error(`${label} fail #${n}`);
    return `${label} ok after ${n}`;
  };
}
async function withRetry(fn, times) {
  const errs = [];
  for (let i = 0; i < times; i++) {
    try { return await fn(); } catch (e) { errs.push(e.message); }
  }
  throw new TaskError(`gave up: ${errs.join(" | ")}`, times);
}
function* chunk(xs, n) {
  let buf = [];
  for (const x of xs) {
    buf.push(x);
    if (buf.length === n) { yield buf; buf = []; }
  }
  if (buf.length > 0) yield buf;
}
async function runAll(tasks, width) {
  const out = [];
  for (const group of chunk(tasks, width)) {
    const rs = await Promise.allSettled(group.map((t) => withRetry(t, 3)));
    for (const r of rs) out.push(r.status === "fulfilled" ? r.value : `${r.reason.name}(${r.reason.attempts}): ${r.reason.message}`);
  }
  return out;
}
const tasks = [
  makeFlaky(0, "a"),
  makeFlaky(2, "b"),
  makeFlaky(5, "c"),
  makeFlaky(1, "d"),
  makeFlaky(0, "e"),
];
(async () => {
  const rs = await runAll(tasks, 2);
  rs.forEach((r, i) => console.log(`${i}: ${r}`));
  // 顺序与微任务：await 之后才继续
  const order = [];
  order.push("sync1");
  const p = (async () => { order.push("async-start"); await null; order.push("after-await"); return 7; })();
  order.push("sync2");
  const v = await p;
  order.push("got" + v);
  console.log(order.join(" -> "));
  // 生成器与 return / throw
  function* g() { try { yield 1; yield 2; } catch (e) { yield "c:" + e.message; } }
  const it = g();
  console.log(it.next().value, it.throw(new Error("boom")).value, JSON.stringify(it.next()));
  // 错误子类穿过 await
  try { await withRetry(makeFlaky(9, "z"), 2); } catch (e) {
    console.log(e instanceof TaskError, e instanceof Error, e.name, e.attempts, e.message.length > 0);
  }
})();
