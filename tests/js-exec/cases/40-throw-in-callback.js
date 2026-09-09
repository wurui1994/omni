// 回调里的 throw 落在谁的槽里（ADR-0007 的挂起槽 + ADR-0013 决策 3 的两份槽）。
// 解释器与宿主 prelude 是**两份**槽，回调抛出来时要往宿主搬一次；而宿主那份 op 若自己把它
// 取走并负责了（promise_try 变成 reject、schedule 变成子 promise 的 reject、gen_step 用
// mode 3 送回状态机），解释器这一份就得放手 —— 一格错只该有一个主人。
// 末两行是反面：forEach 只是**停下循环**、没有取走，那一格必须继续往上冒到 catch。
Promise.try(() => { throw "oops"; }).catch((e) => console.log("try catch", e));
Promise.resolve(1).then(() => { throw "h1"; }).catch((e) => console.log("then throw", e));
Promise.reject("r").catch(() => { throw "h2"; }).catch((e) => console.log("catch throw", e));
new Promise(() => { throw "exec"; }).catch((e) => console.log("exec throw", e));
Promise.resolve(1).finally(() => { throw "f"; }).catch((e) => console.log("fin throw", e));
function* g() { try { yield 1; } catch (e) { console.log("gen caught", e); yield 2; } }
const it = g(); console.log(it.next().value); console.log(it.throw("t").value);
async function a() { throw "ae"; }
a().catch((e) => console.log("async throw", e));
async function b() { try { await Promise.reject("br"); } catch (e) { throw "b2"; } }
b().catch((e) => console.log("async rethrow", e));
try { [1, 2, 3].forEach((x) => { console.log("fe", x); if (x === 2) throw "fe2"; }); } catch (e) { console.log("fe caught", e); }
console.log([1, 2].map((x) => x * 2).join(","));
