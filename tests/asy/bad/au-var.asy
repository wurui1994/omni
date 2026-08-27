// `autounravel` 的**变量**（第二十八刀只做了函数与算符）。asy 那边这个文件印 9 与 10：
// `autounravel int k = 9;` 把 k 铺成一个文件级变量，`twice` 是文件级函数。
// 函数那半边通了（见 cases/34-autounravel），变量这半边还没做：它要在 struct 声明那一行
// 求初值并发一个 `(global …)`，而那一行现在只走声明遍、不发语句。
struct R {
  int p;
  autounravel int k = 9;
  autounravel int twice(R r) { return r.p * 2; }
}

write(k);
R z = new R;
z.p = 5;
write(twice(z));
