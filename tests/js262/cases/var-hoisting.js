/* `var` 是**函数**作用域的（规范 14.3.2 / 9.1.1.3 的 VarDeclaredNames）：块里、if 里、
   循环里写的 var 出了块还看得见，声明之前读它是 undefined 而不是错。从前它跟 let 一样按块
   声明 —— `{ var x = 1; } return x;` 当场报 unresolved 'x'（量出来的）。现在栈帧入口把这一层
   所有 var 的名字一次立好，声明那一句只剩"写一次"；模块顶层的 var 是全局槽（块里写的也是
   同一格）。 */
function blocks() {
  { var x = 1; }
  if (true) { var y = 2; }
  for (var i = 0; i < 2; i++) { var z = i; }
  while (x < 2) { var w = 9; x++; }
  return `${x}${y}${z}${i}${w}`;
}
console.log(blocks());
// 提升：声明之前读它是 undefined
function hoisted() {
  const first = typeof v;
  var v = 3;
  return `${first}${v}`;
}
console.log(hoisted());
// 再声明一次不清零；同名形参就是同一个绑定
function again() {
  var v = 1;
  { var v = 2; }
  var v;
  return v;
}
function param(p) { var p = p + 1; return p; }
console.log(again(), param(1));
// try / catch / switch 里的 var
function branches(k) {
  try { var t = 1; } catch { var t = 2; }
  switch (k) { case 1: var s = "one"; break; default: var s = "other"; }
  return `${t}${s}`;
}
console.log(branches(1), branches(9));
// 闭包捕获块里的 var：捕获的是**同一格**，块外再改还看得见
function captured() {
  const fns = [];
  { var m = 5; fns.push(() => m); }
  m = 6;
  return fns[0]();
}
console.log(captured());
// 解构的 var
function pat() {
  { var { a, b: bb } = { a: 1, b: 2 }; }
  { var [c, d = 4] = [3]; }
  return `${a}${bb}${c}${d}`;
}
console.log(pat());
// 模块顶层：块里的 var 也是全局槽，顶层函数看得见它
{ var g1 = 7; }
if (true) { var g2 = 8; }
function readsGlobals() { return g1 + g2; }
console.log(g1, g2, readsGlobals());
