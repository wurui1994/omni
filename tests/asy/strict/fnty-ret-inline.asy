// 返回类型自己是函数类型，但**写在声明里**（不经 typedef）：asy 自己就不收 ——
// 量过 `asy -noV` 报 `syntax error` 并退 1（第四十二刀）。
// 也就是"这个类型现在拼得出来了"不等于"这个拼法在声明位置也能写"：
// 真 asy 的 camp.y 里没有这条产生式，我们的语法表是照它转写的，所以也是语法错。
// 经 typedef 那一条是通的，钉在 cases/76-fn-ret-fn.asy。
real(real) adder(real a) { return new real(real x) { return x+a; }; }
write(adder(1)(2));
