// 函数值与闭包（ADR-0011 落地第 6b 步）
// 箭头 / 函数表达式 / 嵌套的函数声明 / 顶层函数当值用 / 按引用的可变捕获
const twice = (x) => x * 2;
console.log(String(twice(21)));

const add = function (a, b) {
  return a + b;
};
console.log(String(add(2, 3)));

// 立即调用
console.log(String(((a) => a + 1)(41)));

// 捕获一个只读的外层量
const base = 100;
const addBase = (x) => x + base;
console.log(String(addBase(5)));

// 按引用捕获：闭包写一下，外面看得见
function makeCounter() {
  let n = 0;
  const bump = () => {
    n = n + 1;
    return n;
  };
  return bump;
}
const c1 = makeCounter();
const c2 = makeCounter();
console.log(`${c1()} ${c1()} ${c1()} ${c2()}`);

// 两个闭包共享同一个捕获
function makeBox(v) {
  let cur = v;
  return {
    get: () => cur,
    set: (x) => {
      cur = x;
    },
  };
}
const box = makeBox("a");
console.log(box.get());
box.set("b");
console.log(box.get());

// 嵌套两层：内层捕获中层的捕获
function outer(a) {
  const mid = (b) => {
    const inner = (c) => a + b + c;
    return inner(3);
  };
  return mid(2);
}
console.log(String(outer(1)));

// 自递归的 const 箭头
const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2));
console.log(String(fib(10)));

// 嵌套的函数声明：提升 + 互相递归
function parity(n) {
  function even(k) {
    if (k === 0) return "even";
    return odd(k - 1);
  }
  function odd(k) {
    if (k === 0) return "odd";
    return even(k - 1);
  }
  return even(n);
}
console.log(parity(10));
console.log(parity(7));

// 顶层函数当值用
function square(x) {
  return x * x;
}
const nums = [1, 2, 3, 4, 5];
console.log(nums.map(square).join(","));

// 回调：map / filter / forEach / some / every / find / findIndex
console.log(nums.map((x) => x * x).join(","));
console.log(nums.filter((x) => x % 2 === 1).join(","));
let sum = 0;
nums.forEach((x) => {
  sum = sum + x;
});
console.log(String(sum));
console.log(String(nums.some((x) => x > 4)));
console.log(String(nums.every((x) => x > 0)));
console.log(String(nums.find((x) => x > 2)));
console.log(String(nums.findIndex((x) => x > 2)));

// 回调的第二、第三个实参（下标、数组本身）
console.log(nums.map((x, i) => `${i}:${x}`).join(" "));
console.log(nums.map((x, i, all) => x + all.length).join(","));

// reduce / flatMap / sort
console.log(String(nums.reduce((a, b) => a + b, 0)));
console.log(String(nums.reduce((a, b) => a + b)));
console.log([1, 2, 3].flatMap((x) => [x, x * 10]).join(","));
console.log([3, 1, 2].sort((a, b) => a - b).join(","));
console.log(["bb", "a", "ccc"].sort((a, b) => a.length - b.length).join(","));

// 返回函数的函数（柯里化）
const mul = (a) => (b) => a * b;
console.log(String(mul(6)(7)));

// 函数值存在对象与数组里
const table = { inc: (x) => x + 1, dec: (x) => x - 1 };
console.log(`${table.inc(1)} ${table.dec(1)}`);
const fns = [(x) => x + 1, (x) => x * 3];
console.log(`${fns[0](2)} ${fns[1](2)}`);

// 函数值当实参传下去
function applyTwice(f, x) {
  return f(f(x));
}
console.log(String(applyTwice(twice, 3)));
console.log(String(applyTwice(square, 3)));

// typeof
console.log(typeof twice);
console.log(typeof square);

// 闭包捕获参数（形参也要装 cell）
function tagger(prefix) {
  return (s) => `${prefix}:${s}`;
}
console.log(tagger("x")("y"));

// for-of 的循环变量是每轮一个新的，闭包捕获它是安全的
const made = [];
for (const v of [1, 2, 3]) {
  made.push(() => v);
}
console.log(made.map((f) => f()).join(","));

// `for (let i …)` 的绑定也是**每轮一个新的**（规范 14.7.4.9 的 CreatePerIterationEnvironment）：
// 体里另给一格同名的 cell、每轮从外层抄一份进去。var 那一支照旧共享一格。
const li = [];
for (let i = 0; i < 3; i++) li.push(() => i);
console.log(`let ${li.map((f) => f()).join(",")}`);
const vj = [];
for (var j = 0; j < 3; j++) vj.push(() => j);
console.log(`var ${vj.map((f) => f()).join(",")}`);
const cont = [];
for (let m = 0; m < 4; m++) {
  if (m === 2) continue;
  cont.push(() => m);
}
console.log(`cont ${cont.map((f) => f()).join(",")}`);
const grid = [];
for (let x = 0; x < 2; x++) {
  for (let y = 0; y < 2; y++) grid.push(() => `${x}${y}`);
}
console.log(`grid ${grid.map((f) => f()).join(",")}`);
// 具名函数表达式引用自己（体里那个名字指着这个函数）。
// name / length 那两格在 tests/js262 里量 —— 函数上的属性读要真原型，C 那条腿还没有（P1-c）。
const fact = function fx(n) { return n <= 1 ? 1 : n * fx(n - 1); };
console.log(`fx ${fact(5)} ${fact(1)}`);
/* 提升的嵌套函数声明看得见外层体里的局部量：声明在入口就造出来，而那些量是体里后面才
   声明的 —— 所以入口先给被引用的那几个各立一格 cell（preCells），到声明那一句再往里写。
   从前这一族当场报 unresolved（箭头与函数表达式没这毛病，它们在声明之后才降级）。 */
function nest() {
  const base = 10;
  let bump = 1;
  function inner(n) { return n + base + bump; }
  bump = 2;
  const viaArrow = () => inner(1);
  return `${inner(0)} ${viaArrow()}`;
}
console.log(`nest ${nest()}`);
// 互相递归的两格声明，都要看得见外层的量
function mutual(n) {
  const tag = "t";
  function even(k) { return k === 0 ? `${tag}even` : odd(k - 1); }
  function odd(k) { return k === 0 ? `${tag}odd` : even(k - 1); }
  return even(n);
}
console.log(`mutual ${mutual(4)} ${mutual(3)}`);
// 声明写在用它的那一句前面也一样（提升）
function order() {
  const v = 5;
  function get() { return v; }
  return get();
}
console.log(`order ${order()}`);
/* 块级的函数声明（规范 14.2.3：绑定是块作用域的，块一进去就绑好）。从前当场报
   "a nested function declaration is only supported at the top of a function body"。
   里外同名那一格不在这儿量：脚本语义（Annex B.3.3）与模块语义给的是两个答案。 */
function inIf(flag) {
  if (flag) { const tag = "y"; function f() { return `${tag}es`; } return f(); }
  return "no";
}
console.log(`block ${inIf(true)} ${inIf(false)}`);
function inLoop() {
  let n = 0;
  while (n < 1) { const step = 2; function bump() { return step; } n += bump(); }
  return n;
}
console.log(`block ${inLoop()}`);
// 形参默认值里的闭包看得见前面的形参
function dflt(x, y = x + 1, z = () => x + y) { return `${x}${y}${z()}`; }
console.log(`dfltcap ${dflt(1)} ${dflt(1, 5)}`);
