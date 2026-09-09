/* 提升的嵌套函数声明看得见外层体里的局部量。声明在**入口**就造出来（规范：体首可见），
   而那些量是体里后面才声明的 —— 所以入口先给被它们引用的名字各立一格 cell，到声明那一句
   再往里写。从前这一族一律当场报 unresolved（箭头与函数表达式没这毛病：它们在声明之后
   才降级）。async / 生成器那两种再多一层：它们的体被改写成状态机，量的赋值落在 step 里，
   于是"整份声明搬到外层"的老做法更看不见它们。 */
function plain() {
  const base = 10;
  let bump = 1;
  function inner(n) { return n + base + bump; }
  bump = 2;
  return `${inner(0)} ${inner(1)}`;
}
console.log(plain());
function gen() {
  const v = 3;
  function* g() { yield v; yield v * 2; }
  return [...g()].join(",");
}
console.log(gen());
// async 声明嵌在普通函数里，以及嵌在 async 函数里
function inPlain() {
  const v = 4;
  async function a() { return v + 1; }
  return a();
}
async function inAsync() {
  const v = 5;
  async function a() { return v + 1; }
  function s() { return v * 2; }
  return `${await a()} ${s()}`;
}
// async 箭头的**表达式体**（`async () => e`）：这一格从前把编译器崩成宿主 TypeError
const aa = async () => 7;
async function main() {
  console.log(await inPlain(), await inAsync(), await aa());
  // 互相递归的两格声明，都要看得见外层的量
  function mutual(n) {
    const tag = "t";
    function even(k) { return k === 0 ? `${tag}even` : odd(k - 1); }
    function odd(k) { return k === 0 ? `${tag}odd` : even(k - 1); }
    return even(n);
  }
  console.log(mutual(4), mutual(3));
  // 生成器里的嵌套声明（体也是状态机）
  function* outerGen() {
    const v = 6;
    function h() { return v + 1; }
    yield h();
    yield v;
  }
  console.log([...outerGen()].join(","));
}
main();
/* 块级的函数声明（规范 14.2.3：绑定是**块**作用域的，块一进去就绑好）。
   从前这一族当场报 "a nested function declaration is only supported at the top of a
   function body"。块里的量与块里的声明一起提升，所以两种次序都通。 */
function inBlock() {
  {
    const v = 1;
    function f() { return v; }
    return f();
  }
}
console.log(inBlock());
function inIf(flag) {
  if (flag) { function f() { return "yes"; } return f(); }
  return "no";
}
console.log(inIf(true), inIf(false));
function inLoop() {
  let n = 0;
  while (n < 1) { const step = 2; function bump() { return step; } n += bump(); }
  return n;
}
console.log(inLoop());
/* 里外同名那一格**不量**：块级函数声明在严格/模块语义里是块作用域的（我们这一档），而
   qjs 当脚本跑、node 当 CJS 跑走的是 Annex B.3.3 的旧网页语义（提到函数作用域去）——
   `{ function f(){…} }` 之后再读 f，两种语义给的是两个答案（`qjs -m` 与我们一致）。
   记在 ADR-0020 里，用例不量。 */
/* 形参默认值里的闭包看得见前面的形参（规范 10.2.11 的形参作用域）：直接写 `y = x + 1`
   本来就通，装进闭包那一格从前漏了 —— capturedNames 只扫体，不扫形参表。 */
function dflt(x, y = x + 1, z = () => x + y) { return `${x}${y}${z()}`; }
console.log(dflt(1), dflt(1, 5));
const arrowDflt = (a, b = () => a * 2) => `${a}${b()}`;
console.log(arrowDflt(3), arrowDflt(4, () => 9));
function patDflt({ p = 1 } = {}, q = () => p) { return `${p}${q()}`; }
console.log(patDflt(), patDflt({ p: 7 }));
