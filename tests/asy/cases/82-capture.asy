// 第四十八刀：捕获这一档的两条收窄。
// (1) 抓一个**函数值**：闭包里调外层的函数值形参（base 里 plain_picture.asy:488 的
//     `add(new void(frame f, transform t, …) { d(f,t*T); })` —— d 是外层方法的形参）。
// (2) "会被改"要看**位置**：改在这个闭包**之前**，按值抓的时候已经是最新的那一份了，
//     与 asy 的按引用同一个结果（base 里 plain_picture.asy:1294 的
//     `if(copy) g=copy(g);` 就是这一种）。改在之后的还是拒 —— bad/anon-capref 钉着。

typedef void drawer(int k);

void twice(drawer d) {
  drawer g = new void(int k) { d(k); d(k + 1); };
  g(5);
}
twice(new void(int k) { write(k); });

// 方法体里的匿名函数也一样（方法这一路原来没存体的 AST，捕获一律被拒）。
// 抓外层的 `this` 与裸字段名还在门外，所以这里抓的是方法的形参与局部量。
struct box {
  drawer wrap(drawer d, int shift) {
    return new void(int k) { d(k + shift); };
  }
}
box b;
drawer w = b.wrap(new void(int k) { write(k); }, 100);
w(1);

// 改在闭包之前：抓到的是改完之后的那一份
typedef void thunk();
thunk mk(int[] a, bool dup) {
  if (dup) a = copy(a);
  return new void() { write(a[0]); };
}
int[] xs = {1, 2};
thunk keep = mk(xs, false);   // 没复制：闭包看的是同一份数组
xs[0] = 5;
keep();
thunk cut = mk(xs, true);     // 复制过：后面改原数组它不跟
xs[0] = 9;
cut();
