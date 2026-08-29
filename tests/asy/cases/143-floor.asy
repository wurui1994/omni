// Floor（runmath.in:243 → path.h:31）：与 floor 的差别只在超出 int 范围时不报错。
// stats.asy:78/114/132 的分桶用它。
write(Floor(2.7));
write(Floor(-2.7));
write(Floor(0.0));
write(Floor(-0.5));
write(Floor(1e18));
write(Floor(-1e18));
// 拿它当值取也要认（asy 那边它就是一格函数值）
int f(real x)=Floor;
write(f(3.9));
