// 一批：按名字给的实参先配槽，位置实参再配剩下的（中间带默认值的槽照旧能跳）

typedef int mod(int);
int keep(int v) { return v; }
int twice(int v) { return v * 2; }

void g(string fmt="", string lab="", bool b1=true, bool b2=true,
       int N=0, real Step=0, mod m=keep, real Size=0)
{
  write(fmt); write(lab); write(b1); write(b2);
  write(N); write(Step); write(m(3)); write(Size);
}

// keep 要跳过 lab/b1/b2/N/Step 落到 m 上，而 b1/Step/Size 是按名字给的
g("f", keep, b1=false, Step=1, Size=2);
write("--");
// 换一份函数值，名字给的那几格换位置写
g(Size=8, fmt="q", m=twice);
write("--");
// 一个名字都不给：还是原来那条"跳过带默认值的槽"
void h(int a, int b=7, string c, string d) { write(a); write(b); write(c); write(d); }
h(1, "xy", "z");
write("--");
h(1, 2, "p", "q");
write("--");
// 名字给的那一格与位置那一格撞上：asy 那边也是 no matching function（这里只留通的那几种）
g("z");
