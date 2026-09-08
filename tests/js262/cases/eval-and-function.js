// eval 与 Function(src)（ADR-0020 的 P6）。
//
// 这两样要**编译器在运行期在场**：源码字符串是运行期才有的，得当场过一遍前端。落点是
// 一格运行期的钩子（host/src_eval.js 装上，prelude 的 $js_src_eval 顺着宿主全局找它）——
// 所以只有"在本进程里跑"的场合有：`omni run` 的 JS 腿与 REPL。编成独立产物、或者走 C 腿
// 的时候那两个 op 当场报错，不假装能跑。
//
// 认下来的是**全局 eval** 那一档（规范里的 indirect eval）：编出来的是一段独立的模块，
// **看不见调用者的局部量**。所以这条用例里的每一段源码都是自洽的 —— `let x = 1; eval("x")`
// 在 qjs 里是 1，在这儿是一句编译期的 "unresolved identifier"（冒出去是 SyntaxError）。

// 表达式：整段的值就是最后那一句表达式的值
console.log(eval("1+1"));
console.log(eval("'a' + 'b'"));
console.log(eval("[1,2,3].map((x) => x * 2).join(',')"));

// 语句 + 表达式：最后一句是表达式就是完成值
console.log(eval("const t = 5; t * 2"));

// 造函数：eval 出来的是这门语言里正常的函数值
console.log(typeof eval("(function () { return 7; })"));
console.log(eval("(function () { return 7; })")());

// Function(...)：形参名与体都是运行期的字符串
console.log(new Function("return 1")());
const add = new Function("a", "b", "return a + b");
console.log(add(2, 3), typeof add);
// 不带 new 是同一件事
const twice = Function("x", "return x * 2");
console.log(twice(21));
// 一个形参都没有也行
console.log(new Function("return 'none'")());

// 编不过的源码冒出来是一格 SyntaxError（挂起槽那条路，ADR-0007）
try {
  eval("1 +");
} catch (e) {
  console.log("caught", e.name);
}
try {
  eval("noSuchNameAnywhere + 1");
} catch (e) {
  console.log("caught", e.name);
}

// eval 出来的对象与外面是同一套值：属性访问、JSON、instanceof 都通
const o = eval("({ a: 1, b: [2, 3] })");
console.log(o.a, o.b.length, JSON.stringify(o));
console.log(eval("new Error('boom')") instanceof Error);
