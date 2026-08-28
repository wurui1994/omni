// 三维路径（第四十八刀）：`path3` 在真 asy 那边是 C++ 的内建类型，**不用 import three**
// 就在（量过：这份文件真 asy 直接跑得过）。求解那一头不在这儿 —— three.asy 自己写了
// `struct flatguide3` 与 `path3 solve(flatguide3)`，`guide3` 的 `--` / `..` 也是它自己的。
// 所以这里钉的是 runpath3d.in 那一批取值函数，落点是
// `path3(pre,point,post,straight,cyclic)`（three.asy:1359 的 solve 用的那份）。
triple[] pt = {(0,0,0), (1,0,0), (1,1,1)};
triple[] pre = {(0,0,0), (1,0,0), (1,1,1)};
triple[] post = {(0,0,0), (1,0,0), (1,1,1)};
bool[] st = {true, true, false};
path3 p = path3(pre, pt, post, st, false);
write(length(p));
write(size(p));
write(cyclic(p));
write(point(p, 1));
write(point(p, 0.5));
write(precontrol(p, 1));
write(postcontrol(p, 1));
write(straight(p, 0));
write(arclength(p));
write(arctime(p, 1.0));

// reverse：结点倒排、pre 与 post 互换
write(point(reverse(p), 0));
write(point(reverse(p), 2));

// subpath 的两份
write(point(subpath(p, 0, 1), 1));
write(length(subpath(p, 0, 1)));
write(point(subpath(p, 0.5, 1.5), 0));

// 包围盒
write(min(p));
write(max(p));

// 4x4 齐次变换作用在整条路上（three.asy 的 `t*p[i]`）
real[][] T = {{1,0,0,5}, {0,1,0,0}, {0,0,1,0}, {0,0,0,1}};
write(point(T * p, 1));

// 闭合的那一档：结点数就是段数
path3 c = path3(pre, pt, post, st, true);
write(length(c));
write(point(c, 3));

// 文件级 `operator init` 落在**函数类型**上（three.asy:704 的
// `guide3 operator init() {return nullpath3;}` 就是这一档）。这里问的是**局部**那一格 ——
// 文件级那一格的零值是方言那边铺的，还没走这条路（下一刀）。
typedef int thunk();
int seven() { return 7; }
thunk operator init() { return seven; }
int ask() { thunk t; return t(); }
write(ask());
