// globalThis（ADR-0020 P4）：这个值域里没有全局环境记录（模块顶层的名字是模块局部的），
// 所以它就是**一格普通的真对象**，每个 realm 一份 —— 挂上去的东西读得回来。
// 画出来的边界：内建（Math / JSON …）不在它身上，qjs 那边 `globalThis.Math` 有、我们没有，
// 所以这条用例只量"它是个对象、能挂能读、同一性成立"。
console.log(typeof globalThis, globalThis === globalThis);
globalThis.a = 1;
globalThis.b = { c: 2 };
console.log(globalThis.a, globalThis.b.c);
// **不量** Object.keys(globalThis)：qjs 的那一格上还挂着它自己的内建（console/print…），
// 我们这一格是空的 —— 那正是上面写的边界，不是错。
console.log("a" in globalThis, delete globalThis.a, "a" in globalThis);
// 同名的局部声明照旧接住（用户的名字优先）
{
  const globalThis = 5;
  console.log(globalThis + 1);
}
