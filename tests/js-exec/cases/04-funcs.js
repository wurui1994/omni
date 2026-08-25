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
