// async 生成器与 for await 搬到 C 了（ADR-0020 P2 的第四步）。C 那条腿上没有宿主闭包，
// 所以那格递归的 tick 是带载荷 [g, p] 的原生（sel 49 / 50），yield 让出去的值再 await
// 一遍那两格是 51 / 52，AsyncGenerator.prototype 是 realm 上一格真对象。
// 量的是**拍数**：yield 出去的值照规范（27.6.3.8）还要 await 一遍才结算这一次 next，
// 所以 async 生成器每一圈比同步生成器多一拍 —— 少这一拍，for await 的循环体会早两拍跑。
// 同步可迭代物的兜底（CreateAsyncFromSyncIterator）里元素的值也要 await 一遍，
// 所以 for await (const v of [Promise.resolve(10), 11]) 拿到的是 10 / 11 而不是那格 promise。
async function* ag() { yield 1; await Promise.resolve(0); yield 2; yield 3; }
(async () => {
  const out = [];
  for await (const x of ag()) out.push(x);
  console.log("for await", out.join(","));
  const it = ag();
  console.log("manual", (await it.next()).value, (await it.next()).value);
  const r = await it.return(9);
  console.log("return", r.value, r.done);
  // 同步可迭代的兜底：元素是 promise 时值也要 await 一遍
  for await (const v of [Promise.resolve(10), 11]) console.log("sync-src", v);
  // 自己写 Symbol.asyncIterator
  const obj = { [Symbol.asyncIterator]() { let i = 0; return { next: () => Promise.resolve(i < 2 ? { value: i++, done: false } : { value: undefined, done: true }) }; } };
  for await (const v of obj) console.log("custom", v);
  console.log("sync tail");
})();
console.log("top");
