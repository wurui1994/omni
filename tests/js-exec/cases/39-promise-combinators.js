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
// any 是 all 的镜像：第一个**兑现**的赢，全拒才结算成一格 AggregateError（errors 按下标排）。
// 空数组这一格是**立刻拒绝**，所以它印在最前面 —— 次序也是量出来的。
// message 那一格**故意不印**：规范里它是空串（qjs 照此），而 node/V8 塞的是
// "All promises were rejected" —— 两把尺子在这一格上本来就不一样，我们跟规范与 qjs。
Promise.any([Promise.reject("a"), Promise.resolve(2), 3]).then((v) => console.log("any", v));
Promise.any([1, Promise.reject("x")]).then((v) => console.log("any first", v));
Promise.any([Promise.reject("e1"), Promise.reject("e2")]).catch((e) => console.log("any all rej", e.name, e.errors.join("|"), typeof e.message));
Promise.any([]).catch((e) => console.log("any empty", e.name, e.errors.length));
