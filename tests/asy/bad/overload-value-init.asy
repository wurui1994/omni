// 有多个重载的名字当**变量的初值**：asy 收，我们不收。
// 量过 `asy -noV`：这个文件原样跑下来印 10 退 0（`real(real,real)` 那个槽挑的是第二份）。
// 实参位置上这一条已经通了（cases/42-fntype 的 useI/useR），差的是**声明**这个位置 ——
// 那条路上期望类型是有的（`real g(real,real)` 就写在左边），但走的不是 fit 那一段。
int both(int a, int b) {return a + b;}
real both(real a, real b) {return a * b;}
real g(real,real) = both;
write(g(2,5));
