// slant（runtime.in:1219）与变换的幂（从 identity 起乘 —— `^-1` 那个 -0 就是这么来的）
write(slant(2));
write(shift((1,2))^3);
write(rotate(30)^2);
write(shift((1,2))^0);
write(shift((1,2))^-1);
// 内建 array 的形参名（builtin.cc:624 的 `array(Int n, T value)`）
int[] a=array(n=6,value=1);
write(a.length); write(a[5]);
string[] s=array(value="x",n=2);
write(s.length); write(s[1]);
// 数组对一个标量的 == / !=（builtin.cc 的 addOps）
string[] E={"H","He","Li"};
bool[] m=(E == "He");
write(m[0]); write(m[1]); write(find(E == "He"));
int[] I={1,2,3,2};
write(find(I == 2,2)); write(find(I != 2));
// 记录对 null 是**身份比较**，哪怕这个记录有一格到 string 的 cast
// （不拦住的话会去匹配 `operator !=(string, string[])`，答成 bool[]）
struct P { int v; }
string operator cast(P p) { return "P"; }
P p;
write(p != null);
write(p == null);
P q=null;
write(q == null);
