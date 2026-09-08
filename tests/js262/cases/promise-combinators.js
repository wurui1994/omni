// Promise 的另外三个静态面（ES2020 / ES2021）：allSettled / any / race。
// 量的不只是结果，还有**拍数**：把一条 5 级的 then 链摆在旁边当尺子 —— 三者都在
// 第 2 拍落地（与 all 同一拍），所以顺序必须是 t1 t2 <四个组合子> t3 t4 t5。
// 不量 AggregateError 的 message：qjs 那边是空串、node 那边是一句话，两把尺子不一致。
const log = [];
Promise.resolve().then(() => log.push("t1")).then(() => log.push("t2")).then(() => log.push("t3"))
  .then(() => log.push("t4")).then(() => log.push("t5"));
Promise.allSettled([Promise.resolve(1), Promise.reject(2)]).then((r) => log.push("settled:" + JSON.stringify(r)));
// race 跟着头一个 settle 的走（这里是 fulfilled 的那一个）
Promise.race([Promise.resolve("a"), Promise.reject("b")]).then((v) => log.push("race:" + v));
// any 跳过 reject，取头一个 fulfill
Promise.any([Promise.reject("x"), Promise.resolve("y")]).then((v) => log.push("any:" + v));
// 全 reject 才 reject，errors 按**原顺序**排
Promise.any([Promise.reject(1), Promise.reject(2)]).catch((e) => log.push("agg:" + e.name + ":" + e.errors.join(",")));
Promise.allSettled([]).then((r) => log.push("empty:" + JSON.stringify(r)));
Promise.any([]).catch((e) => log.push("anyEmpty:" + e.name + ":" + e.errors.length));
Promise.resolve().then(() => {}).then(() => {}).then(() => {}).then(() => {}).then(() => {}).then(() => {})
  .then(() => { console.log(log.join(" | ")); });
