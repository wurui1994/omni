// Promise 与微任务队列（ADR-0020 P2 的前半）。
//
// 这个值域里**没有事件循环**：作业队列是一格数组，降级器在 main 末尾补一句 js_jobs_run
// 把它排空 —— "调用栈空了"这件事只有那一处可观测。所以 setTimeout 那一族不在这一档里，
// 只有微任务；`async function` / `await` 也还没有（那要状态机改写）。
console.log(1);
Promise.resolve(2).then((v) => console.log(v + 1));
console.log(2);

// 已经结算的 promise 也要排队再调 —— 上面那三行印出 1 2 3 就是这一条
new Promise((res) => res(9)).then((v) => console.log("new", v));
new Promise((res, rej) => rej(new Error("no"))).catch((e) => console.log("rej", e.message));
// executor 自己抛出来的当 reject
new Promise(() => { throw new Error("boom"); }).catch((e) => console.log("exec", e.message));

// 回调里抛出来的往下传给 catch；then 的返回值往下传给下一个 then
Promise.resolve(1).then(() => { throw new Error("in"); }).catch((e) => console.log("chain", e.message));
Promise.resolve(4).then((v) => v + 1).then((v) => console.log("pipe", v));
// 回调返回一格 promise 时跟着它走
Promise.resolve(1).then(() => Promise.resolve("inner")).then((v) => console.log("follow", v));
// finally 不改值，抛出来的除外
Promise.resolve(5).finally(() => console.log("fin")).then((v) => console.log("after", v));

// Promise.all：不是 promise 的元素当已结算的值收；有一格 reject 就整体 reject
Promise.all([Promise.resolve(1), 2, Promise.resolve(3)]).then((a) => console.log("all", a.join(",")));
Promise.all([]).then((a) => console.log("all0", a.length));
Promise.all([Promise.resolve(1), Promise.reject(new Error("x"))]).catch((e) => console.log("allrej", e.message));
