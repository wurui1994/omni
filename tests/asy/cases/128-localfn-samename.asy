// 函数体里的函数抓外层的量、体里又提到**自己的名字** —— 可那不是递归：asy 的名字按签名
// 查，同名而签名不同的那一份照旧接得住。原型是 plain_Label.asy:56 的
// `pair[][] conj(pair[][] a)` 体里那句 `conj(a[j][i])`（调的是内建的 `pair conj(pair)`），
// 与 plain_markers.asy:64 的 `void add(real x)` 体里那句 `add(pic,f,z)`。
real twice(real x) { return 2x; }

void f(real k) {
  // 抓外层的 k，体里又提到 twice —— 那个 twice 是文件级的 `real twice(real)`
  real twice(int n) { return twice(k) * n; }
  write(twice(3));
}
f(5);

// 抓的量与自己同名的那一档：`real dot(real)` 体里的 `dot` 是内建的 `real dot(pair,pair)`
void g(pair u, pair v) {
  real amp(real s) { return dot(u,v) * s; }
  write(amp(2));
}
g((1,2),(3,4));
