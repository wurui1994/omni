// async / await（ADR-0020 P2 的后半，与生成器同一台状态机）。
//
// async 函数体也被 genfn.js 切成段，只是收尾不一样：`await e` 那一段发 js_gen_awt，
// 驱动（js_async_run）把 resumption 挂到 promise 的 then 上 —— 恢复者是**微任务**。
// 拍数按规范：await 一拍；async 生成器的 yield 多一拍（AsyncGeneratorYield 先 Await
// 让出去的值）。这一族只有 JS 那条腿，所以走 js262 这道门。

// 体一直同步跑到第一个 await；返回值经过 promise 交出去
async function one() {
  console.log("in");
  const v = await Promise.resolve(2);
  console.log("v", v);
  return v * 10;
}
one().then((x) => console.log("then", x));
console.log("sync");

// await 一格**不是** promise 的值也要花一拍
const arrow = async () => {
  await null;
  console.log("arrow");
};
arrow();

// 抛出来的就是 reject；try/finally 照跑
async function boom() { throw new Error("nope"); }
boom().catch((e) => console.log("caught", e.message));

async function guarded() {
  try {
    await Promise.resolve(1);
    return "ok";
  } finally {
    console.log("fin");
  }
}
guarded().then((v) => console.log("guarded", v));

// 被 reject 的 await 在体里就是抛出来（mode 2 进状态机）
async function rejected() {
  const p = Promise.reject(new Error("bad"));
  await p;
  console.log("not reached");
}
rejected().catch((e) => console.log("rejected", e.message));

// 循环里的 await：每一圈一拍
async function loop() {
  let sum = 0;
  for (const x of [1, 2, 3]) {
    const v = await Promise.resolve(x);
    sum += v;
  }
  return sum;
}
loop().then((v) => console.log("loop", v));

// return await：改写器自己拆成"等一格 + 返回那一格"
async function tail() { return await Promise.resolve("tail"); }
tail().then((v) => console.log(v));

// async 方法（对象与类上各一个）
const obj = { async m() { return await Promise.resolve("obj.m"); } };
obj.m().then((v) => console.log(v));
class C {
  constructor() { this.n = 7; }
  async get() { const v = await Promise.resolve(this.n); return v + 1; }
}
new C().get().then((v) => console.log("C.get", v));

// async 生成器 + for await
async function* ag() {
  yield 1;
  const v = await Promise.resolve(10);
  yield v;
}
(async () => {
  for await (const v of ag()) console.log("ag", v);
  console.log("ag done");
})();

// for await 走同步可迭代的兜底：元素的值也 await 一遍
(async () => {
  for await (const v of [Promise.resolve("p1"), "p2"]) console.log("fa", v);
})();

// 交错的次序（这一段就是"拍数对不对"的尺子）
Promise.resolve().then(() => console.log(1)).then(() => console.log(2))
  .then(() => console.log(3)).then(() => console.log(4));
