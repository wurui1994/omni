// Promise 与 async / await 在五条腿上（ADR-0020 P2）。C 那条腿上 promise 是一格三槽真对象
// （$st 0 待定 / 1 兑现 / 2 拒绝、$val、$cbs），作业队列是一格静态 list（main 末尾排空）。
// 里头量的**次序**才是要害：sync 先印、已结算的 then 也要排队、resolve 收到 promise 多花一拍。
const p = new Promise((res) => res(1));
p.then((v) => { console.log("then", v); return v + 1; }).then((v) => console.log("chain", v));
Promise.resolve(9).then((v) => console.log("r", v));
Promise.reject("bad").catch((e) => console.log("caught", e));
new Promise((_, rej) => rej("x")).catch((e) => { console.log("c2", e); return "ok"; }).then((v) => console.log("after", v));
console.log("sync");
async function f() { const a = await Promise.resolve(5); console.log("await", a); return a * 2; }
f().then((v) => console.log("async result", v));
async function g() { try { await Promise.reject("boom"); } catch (e) { console.log("async caught", e); } return "g"; }
g().then((v) => console.log("g", v));
Promise.resolve(1).finally(() => console.log("fin")).then((v) => console.log("after fin", v));
