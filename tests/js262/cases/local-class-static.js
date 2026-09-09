// 局部类的 static 块与 static 字段初始化式（规范 15.7.4 / 15.7.14）：它们在"类定义那一刻"跑，
// 里面读的类名就是那格 let 绑定 —— 等到 let A = … 那一句才写就晚了（量出来的是
// "cannot assign to an index of a undefined"）。所以类对象一造好就先往那一格写一次
// （classProtoStmts 的 afterCreate）；规范里类体内部那个类名本来就是另一格、这时已初始化好。
// 配套的一格：nestedFns 要把字段与 staticBlock 也算成"内层函数"，不然外层不给类名装 cell。
function mk(seed) {
  class A {
    static x;
    static { A.x = seed; this.y = seed * 2; }
    m() { return A.x + "," + A.y; }
  }
  return new A().m();
}
console.log(mk(5));
console.log(mk(10));
{
  class B { static n; static { B.n = 1; } }
  console.log(String(B.n));
}
// 静态字段初始化式里读类名（同样是"类定义那一刻"）
function mk3(seed) {
  class C { static a = seed; static b = C.a * 3; static { C.c = C.b + 1; } }
  return [C.a, C.b, C.c].join(",");
}
console.log(mk3(2));
console.log(mk3(4));
