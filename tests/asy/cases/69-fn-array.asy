// 函数值的**数组**（第三十七刀）。asy 那边这一族到处都是 —— plain_picture.asy:95 的
// `boundRoutine[] bound;`（boundRoutine 是 `void(…)` 的 typedef）就是它。
// 方言那边补了 `(arr (fnty …))`（见 tests/sexpr/cases/17-fnarray.sx），前端这边两处：
// arrElemOk 收函数类型，以及 `fs[0](5)` —— 被调的是**下标出来的那一格**。
typedef int F(int);

F[] fs;
fs.push(new int(int x) { return x * 2; });
fs.push(new int(int x) { return x + 100; });
write(fs.length);
write(fs[0](5));
write(fs[1](5));

// 当形参传，格子里那份直接调
int apply2(F[] gs, int v) {
  return gs[0](v) + gs[1](v);
}
write(apply2(fs, 5));

// 量过一条**不能写进这里**的：`F[] fs2 = new F[1]; fs2[0] == null` 在 asy 那边是
// **运行期**错误（"read uninitialized value from array at index 0"），不是 null ——
// 与 `int[] r = null; r == null` 那条（59-null.asy 里记着的）同一族：asy 的 new T[n]
// 铺的是"没初始化"，而我们铺的是零值（函数值那格就是空引用），所以这一格两边不一样。
// 这一条差别写在这儿，不假装它不存在。
