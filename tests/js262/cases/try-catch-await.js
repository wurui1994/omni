// try { … await … } catch (e) { … }（ADR-0020 P2）。
//
// 这个值域里的异常是"挂起槽 + 提前 return"（ADR-0007）：切开的 try 体里抛出来的东西会让
// step 直接返回，挂起槽还是满的。所以接手这件事要**驱动**帮一把 —— 它看见挂起槽满了就把
// 那一格值送回 step（mode 3），step 开头那一段按 `_g_cat` 跳到 catch 段去。没有活着的
// catch 时机器原样抛回来，照旧往上冒。
//
// 还不行的一格：catch 与 finally **一起**（那要两层不变量一起维护），genfn.js 会当场报错。

// 被 reject 的 await 在体里就是抛出来
async function f() {
  try {
    const v = await Promise.reject(new Error("bad"));
    console.log("not reached", v);
  } catch (e) {
    console.log("caught", e.message);
  }
  return "done";
}
f().then((v) => console.log(v));

// await 之后再 throw：同一格 catch 接住（跨段的接手）
async function g() {
  try {
    await Promise.resolve(1);
    throw new Error("sync throw");
  } catch (e) {
    console.log("caught2", e.message);
    return "recovered";
  }
}
g().then((v) => console.log(v));

// 同步生成器也走同一条路
function* gen() {
  try {
    yield 1;
    throw new Error("inside");
  } catch (e) {
    console.log("gen caught", e.message);
  }
  yield 2;
}
console.log([...gen()].join(","));

// 一个函数里两段 try/catch：第一段走完之后那格 catch 要摘下来
async function h() {
  try {
    await Promise.reject(new Error("x"));
  } catch (e) {
    console.log("h", e.message);
  }
  try {
    throw new Error("y");
  } catch (e) {
    console.log("h2", e.message);
  }
}
h();

// catch 与 finally 一起：抛进来的那一格先看 catch，再看 finally（step 开头那一段）
async function both() {
  try {
    await Promise.reject(new Error("boom"));
  } catch (e) {
    console.log("both caught", e.message);
    return "from catch";
  } finally {
    console.log("both fin");
  }
}
both().then((v) => console.log(v));

// catch 里 yield，finally 收尾
function* genf() {
  try {
    yield 1;
    throw new Error("in try");
  } catch (e) {
    console.log("genf caught", e.message);
    yield 2;
  } finally {
    console.log("genf fin");
  }
  yield 3;
}
console.log([...genf()].join(","));

// 一路顺的时候 finally 也要跑，return 的值不受它影响
async function ok() {
  try {
    const v = await Promise.resolve(7);
    return v * 2;
  } catch (e) {
    return -1;
  } finally {
    console.log("ok fin");
  }
}
ok().then((v) => console.log("ok", v));
