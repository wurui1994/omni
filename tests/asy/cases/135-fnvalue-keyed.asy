// 通过**函数值**调用时的命名实参：asy 的函数类型是带形参名的
// （`typedef void ticks3(…, bool opposite=false, bool primary=true, projection P);`，
// graph3.asy:69），所以名字照样能落格。grid3.asy:205 的
// `ticks(d,t,"",…,opposite=true,primary=false,P)` 靠这条
// （examples/elevation.asy、projectelevation.asy、smoothelevation.asy）。
typedef int F(int a, int b=2, int c=3);
int f(int a, int b, int c) { return a*100+b*10+c; }
F g=f;
write(g(1,c=9,b=8));
write(g(c=9,1,b=8));
write(g(1,8,9));
