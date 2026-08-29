// 函数体里那种具名函数的**形参**被里层函数改（contour.asy:444 的 `follow(…, int edge)`
// 与它里面的 `search()`）。asy 的捕获是按引用的，所以里层改完外层看得见；这一层要把那一格
// 形参装进箱子（原来只有顶层函数与方法那两处装，闭包体里那一处漏了）。
int[] log;
void outer() {
  void follow(int edge) {
    int I = 0;
    void search() { edge = edge+10; I = I+1; }
    search();
    search();
    log.push(edge);
    log.push(I);
  }
  follow(1);
  follow(5);
}
outer();
write(log);

// 匿名闭包的形参也一样
void demo(int k) {
  void bump() { k = 2*k; }
  bump();
  write(k);
}
demo(3);

// 里层改的是**再里一层**（两层套下来还是同一格）
void two(int n) {
  void a() {
    void b() { n = n+100; }
    b();
  }
  a();
  write(n);
}
two(1);
