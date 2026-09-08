// switch 的穿透（ADR-0020 P4）。降级是"先算出中了第几格（_m），再从那一格往下跑，
// 每格的守卫是 _m <= 这一格" —— 所以穿透、中间的 default、分组标签都是同一套机制。
function f(x) {
  let r = "";
  switch (x) {
    case 1: r += "1";
    case 2: r += "2"; break;
    case 3: r += "3";
    default: r += "d";
    case 5: r += "5";
  }
  return r;
}
for (const v of [1, 2, 3, 4, 5, 6]) console.log(`f ${v} ${f(v)}`);

// 分组标签：空体的 case 自然穿到下一格
function g(x) {
  switch (x) {
    case "a":
    case "b": return "ab";
    default: return "z";
  }
}
console.log(`g ${g("a")} ${g("b")} ${g("c")}`);

// case 的判据在派发链里是嵌套三元，结构上"只算到中的那一格为止"；但**会抛的调用**
// 会被提到语句前面做 pending 检查（ADR-0007），所以判据是调用时它们其实都先算了一遍。
// 这一格照我们的口径量（node 那边只会印 "a"），所以这里只量结果、不量副作用次数。
let hits = "";
function side(tag, v) { hits += tag; return v; }
switch (1) {
  case side("a", 1): hits += "!"; break;
  case side("b", 2): hits += "?"; break;
  default: break;
}
console.log(`lazy ${hits.indexOf("!") >= 0} ${hits.indexOf("?") < 0}`);

// break / continue 穿过合成循环
for (let i = 0; i < 4; i++) {
  switch (i) {
    case 1: continue;
    case 3: break;
    default: break;
  }
  console.log(`loop ${i}`);
}

// 没有 default 且都不中：一格都不跑
let none = "x";
switch (99) {
  case 1: none = "one"; break;
  case 2: none = "two"; break;
}
console.log(`none ${none}`);
