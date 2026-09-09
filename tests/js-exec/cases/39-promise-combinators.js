// Promise 的四个组合器在五条腿上（ADR-0020 P2）。C 那条腿上共享状态是一格 list
// [p, vals, 计数盒]，每一项自己的回调再挂一格 [状态, 下标] 当负载，这样下标才不会串。
// 空数组要**立刻**兑现、all 只认第一个拒绝、allSettled 的每一格形状（status/value/reason）
// 和 race 认第一个结算的那个，都是量出来的次序，不是猜的。
Promise.all([1, Promise.resolve(2), 3]).then((v) => console.log("all", v.join(",")));
Promise.all([]).then((v) => console.log("all empty", v.length));
Promise.all([1, Promise.reject("no")]).catch((e) => console.log("all rej", e));
Promise.allSettled([Promise.resolve(1), Promise.reject("e")]).then((v) => console.log("settled", JSON.stringify(v)));
Promise.race([new Promise((r) => r("first")), Promise.reject("late")]).then((v) => console.log("race", v));
Promise.try(() => 7).then((v) => console.log("try", v));
