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
