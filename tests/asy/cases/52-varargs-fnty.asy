// 函数类型里那一格可变形参（`int(... int[])`）—— plain_paths.asy:3 的
// `using interpolate=guide(... guide[]);` 就是它，那一行是 `import plain;` 的两道墙之一。
//
// 类型的拼法把 `... ` 留在形参的类型文本里，所以可变的只等于可变的：量过 asy 对
// `using afn=int(int[]); afn g = total;` 报 "cannot cast 'int(... int[] xs)' to 'int(int[])'"
// 并退 1（那一半钉在 strict/varargs-fnty-cast）。
//
// 通过这种函数值**调**也通了：多出来的实参在调用处打成一条数组，与直接调一个可变函数
// 走的是同一份写法。下面四行与真 asy 逐字节相同（量过：0 / 6 / 18 / 6.5）。
int total(... int[] xs) { int s=0; for (int x : xs) s += x; return s; }
using vfn = int(... int[]);
vfn f = total;
write(f());
write(f(1,2,3));
int[] a = {4,5};
// 散着写的与展开的混在一起：9 + 4 + 5 = 18
write(f(9, ... a));
// 前面还有固定那几格时也一样，而且元素那一格照样做 int -> real 提升
real avg(int k, ... real[] xs) { real s=0; for (real x : xs) s += x; return k+s; }
using afn2 = real(int, ... real[]);
afn2 g = avg;
write(g(1, 2, 3.5));
