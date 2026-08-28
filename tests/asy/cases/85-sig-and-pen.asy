// 第五十一刀（下半）：可变形参那一格**算在签名身份里** —— `f(int[])` 与 `f(... int[])`
// 是两份，不是"同签名替换"。base 里 plain_constants.asy:42 就是
// `int min(... int[] a) {return min(a);}`：体里那个 min(a) 调的正是数组那一份。
int f(int[] a) { return a.length; }
int f(... int[] a) { return 100 + a.length; }
int[] xs = {1, 2, 3};
write(f(xs));
write(f(1, 2));

// 笔的盒子（runtime.in:339/344 → pen.h:931 pen::bounds）：没有 nib、变换是恒等时
// 就是 ±0.5*linewidth 的正方形。
pen p = linewidth(2);
write(min(p));
write(max(p));
write(min(currentpen));

// 虚线那一族（runtime.in:503）：负数截成 0，别的属性存着。
pen q = linetype(new real[] {8, -3});
real[] pat = linetype(q);
write(pat[0]);
write(pat[1]);
write(offset(q));
