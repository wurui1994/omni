// 同一层里同名的**局部函数**在 asy 那边按签名分得开（venv 是按签名逐层找的）。
// 两处都要能挑：同一层里直接调，以及**里层**的局部函数体里调（那时名字是抓进来的）。
// contour3.asy:229 与 :245 的两个 `setupweighted` 就是这一对，:279 那些调用在里层的
// checkpyr 体里（examples/cheese.asy 与 magnetic.asy 靠它）。
void run() {
  int g(int a, int b) { return a+b; }
  int g(int a) { return a*10; }
  write(g(3));
  write(g(4,5));
  int call() { return g(3) + g(4,5); }
  write(call());
  string s(string a) { return a+"!"; }
  string s(string a, string b) { return a+b; }
  string inner() { return s("x") + s("y","z"); }
  write(inner());
}
run();
