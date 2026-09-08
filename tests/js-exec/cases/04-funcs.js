// 函数：递归、互相递归、默认参数、rest 参数、实参多给少给
function fact(n) {
  if (n <= 1) return 1;
  return n * fact(n - 1);
}
console.log(String(fact(6)));

function isEven(n) {
  if (n === 0) return true;
  return isOdd(n - 1);
}
function isOdd(n) {
  if (n === 0) return false;
  return isEven(n - 1);
}
console.log(String(isEven(10)));
console.log(String(isOdd(7)));

function greet(name, greeting = "hi") {
  return `${greeting}, ${name}!`;
}
console.log(greet("omni"));
console.log(greet("omni", "hello"));
console.log(greet("omni", undefined));

function count(...items) {
  return items.length;
}
console.log(String(count()));
console.log(String(count(1, 2, 3)));

function head(first, ...tail) {
  return `${first}/${tail.join("-")}`;
}
console.log(head(1, 2, 3));

function missing(a, b) {
  return `${a} ${b}`;
}
console.log(missing(1));
console.log(missing(1, 2, 3));

function noReturn() {
  const x = 1;
}
console.log(String(noReturn()));

function spreadCall(a, b, c) {
  return `${a}${b}${c}`;
}
const args = [1, 2, 3];
console.log(spreadCall(...args));
console.log(spreadCall(0, ...[8, 9]));

// 参数解构
function pair([a, b]) {
  return a + b;
}
console.log(String(pair([3, 4])));

// 模式带默认值（`function f({x} = {})`）与嵌套模式的默认值：只在那一格是 undefined 时生效
function opt({ x = 1, y: z = 2 } = {}, ...tail) {
  return `${x}/${z}/${tail.length}`;
}
console.log(opt(), opt({ x: 9 }, 1, 2), opt({ y: 7 }));
function nest({ b: { c = 2 } = {} } = {}) {
  return String(c);
}
console.log(nest(), nest({ b: {} }), nest({ b: { c: 5 } }));
const [q = 5, , r = 6, ...more] = [undefined, 2];
console.log(`${q}/${r}/${more.length}`);
// 计算键的解构：键的表达式只算一次
let hits = 0;
function k() {
  hits = hits + 1;
  return "kk";
}
const { [k()]: got = "no", ...restC } = { kk: "yes", zz: 1 };
console.log(`${got}/${hits}/${JSON.stringify(restC)}`);

// 对象字面量里的方法拿的是**自己的接收者**：从前外层函数会以为"我体里提到了 this"、
// 开一格 this 装进 cell，方法于是捕获外层那一个（量出来的：m.next() 里 this 是 undefined）
function mkCounter() {
  return { i: 0, next() { this.i = this.i + 1; return this.i; } };
}
const ctr = mkCounter();
console.log(`this ${ctr.next()}/${ctr.next()}/${ctr.i}`);
function nestedMk() {
  return { v: 7, inner() { return { v: 8, deep() { return this.v; } }; } };
}
console.log(`this ${nestedMk().inner().deep()}/${nestedMk().v}`);
const withArrow = { v: 3, m() { const a = () => this.v; return a(); } };
console.log(`this ${withArrow.m()}`);
