// 文件级变量的聚合档（第三十刀）：pair / struct / 数组都能当模块级的单件，函数里也看得见。
// 原来这里只收 int/real/bool/string，理由写的是「聚合的身份不在 MIR 的 8 位类型码里」——
// 量下来那个身份根本不需要：class 与数组在四条腿上都是一个指针（LLVM 的 T_AGG/T_ARR
// 都是 `ptr`），字段与元素的身份是从**表达式**的 OIR 类型来的。
// 绘图层的 currentpicture / defaultpen 就是这一档，所以它是那一刀的前置。
struct P {
  int n;
  pair z;
}

pair origin = (1, 2);
P cur;
pair[] pts;
real w = 2;

real len() { return abs(origin); }

void bump(int k) {
  cur.n += k;
  cur.z = (cur.n, w);
  pts.push(cur.z);
}

write(len());
bump(3);
bump(4);
write(cur.n);
write(cur.z);
write(pts.length);
write(pts[0]);
write(pts[1]);
// 没有初值的聚合全局也是造好的（asy 的隐式 operator init）：零就是 null，一读就炸
write(cur.z == (7, 2));
