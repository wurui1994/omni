// 无名形参（graph.asy:271 的 `pair zero(real)`、math.asy:211 的 `new real(int){return 0;}`）。
// 这个槽在体里没法提，所以降级时补一个按位置定死的名字 —— 定死是要紧的：声明遍与正文遍
// 各求一次形参表，两遍拼出来的名字必须一样。
pair zero(real) { return (0,0); }
write(zero(3.5));
int two(int, string) { return 2; }
write(two(1, 'x'));
real[] seq(real f(int), int n) {
  real[] r;
  for (int i = 0; i < n; ++i) r.push(f(i));
  return r;
}
write(seq(new real(int) { return 0; }, 3));
int mix(int a, real, string s) { return a + length(s); }
write(mix(5, 1.0, 'abc'));

// 形参表里的函数类型也能不带名字（`real f(int)` 那个槽里的 int 就是无名的）
real apply(real g(int), int k) { return g(k); }
write(apply(new real(int i) { return i * 1.5; }, 4));
