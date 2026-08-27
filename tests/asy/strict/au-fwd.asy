// `autounravel` 的可见位置是**这个 struct 的位置** —— 写在 struct 前面的地方看不见
// （量过 asy 报 "no matching variable 'auq'"）。跟"引用后面才声明的函数"是同一条规矩。
// 不带 ASY_NOPE：这个程序在 asy 那边本来就不对。
write(auq(3));

struct R {
  int p;
  autounravel int auq(int n) { return n; }
}
