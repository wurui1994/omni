// pair：asy 的复数。这一份里每一行的期望值都是 `asy -noV` 印出来的，不是推的。
//
// 要害的几条：
//   - `*` 和 `/` 是**复数**乘除，不是逐分量（(1,2)*(3,-4) 是 (11,2)）。
//   - `/` 是**朴素**的复数除法：分母的平方和会溢出，所以 (1,1)/(1e200,1e200) 是 (0,0)。
//   - 实数**不是**另一个重载，是先转成 (v,0)：(1e300,1)/1e300 因此是 (nan,0)。
//   - abs 也是朴素的 sqrt(x*x+y*y)，不是 hypot：abs((1e200,1e200)) 是 inf。
//   - 印出来的两个分量各走 %.15g，中间一个逗号、没有空格。

pair rot90(pair z) { return z*(0,1); }

pair mid(pair a, pair b) { return (a+b)/2; }

real cross(pair a, pair b) { return a.x*b.y - a.y*b.x; }

pair z = (1,2);
pair w = (3,-4);

// 构造与取分量
write(z);
write(z.x, z.y);
write(xpart(w), ypart(w));
pair zero;
write(zero);

// 四则。后两个是复数乘除
write(z+w);
write(z-w);
write(z*w);
write(z/w);
write(w/z);

// int/real 会被隐式提成 (v,0) —— 不是"标量乘"那个重载
write(2*z);
write(z*2);
write(z-1);
write(z/2);
write(z/(0,1));

// 一元与共轭
write(-z);
write(conj(z));
write(-(0.0,0.0));

// 模
write(abs(w));
write(length(z));
write(abs((0,0)));

// 相等：逐分量比，int 那边先转 pair
write(z == (1,2));
write(z != w);
write(z == 1);
write((3,0) == 3);

// 复合赋值
pair v = z;
v += w;
write(v);
v -= (1,1);
write(v);
v *= 2;
write(v);
v /= (0,1);
write(v);

// 强制转换
write((pair)3);
write((pair)2.5);

// 函数：pair 进、pair 出，还有回 real 的
write(rot90((1,0)));
write(rot90(z));
write(mid(z,w));
write(cross(z,w));

// ?: 的两支是 pair
pair pick = z.x > 0 ? z : w;
write(pick);
write(z.y < 0 ? (1,1) : (2,2));

// 循环里累加
pair sum;
for (int i = 1; i <= 3; ++i) sum += (i, -i);
write(sum);

// write 的形状：字符串前缀不加分隔符，值与值之间是制表符，
// 有一个实参是 pair 时别的 int/real 也按 pair 印
write("z=",z);
write(z,w);
write(3,z);

// 极端值 —— 这几行钉的是"朴素公式"那件事
write((1,1)/(1e200,1e200));
write((1e300,1)/1e300);
write(abs((1e200,1e200)));
write((1e20,1e-5));
write((1/3,2/3));
