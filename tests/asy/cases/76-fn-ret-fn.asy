// 返回类型自己是函数类型（第四十二刀）。plain.asy:66-68 就是这个形状：
//   using restoreThunk=void();
//   using saveFunction=restoreThunk();
//   saveFunction[] saveFunctions={};
// 类型文本还是 asy 自己的拼法（`real(real)(real)`），形参表是**最后**那一对括号。
// 量过 asy：这种类型只能经 typedef 拼出来 —— 直接写 `real(real) adder(real a)`
// 那边是 syntax error。
typedef real realfn(real);
realfn adder(real a) { return new real(real x) { return x+a; }; }
realfn f = adder(3);
write(f(4));
// 调用回来的那个值再调一次（`h(3)(4)`）：与 `fs[0](5)` 同一条路子
using G = realfn(real);
G h = adder;
write(h(3)(4));
// 这一族的数组：plain.asy:68 那一句
G[] hs = {adder, adder};
write(hs.length);
write(hs[1](10)(5));
// void 那一档（plain.asy 的 restoreThunk 就是 void()）
using thunk = void();
using mkthunk = thunk();
void say() { write("inner"); }
thunk pick() { return say; }
mkthunk mk = pick;
thunk t = mk();
t();
