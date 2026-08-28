void dump(path g) {
  write(length(g)); write(cyclic(g));
  for (int i = 0; i < size(g); ++i) {
    write(precontrol(g,i)); write(point(g,i)); write(postcontrol(g,i));
    write(straight(g,i));
  }
}
// 拼接：接缝那个结的 pre 来自左边、point/post 来自右边
dump((0,0)..(1,1)..(2,0) & (2,0)--(3,2));
dump((0,0)--(1,0) & (1,0)..(2,1)..(3,0));
dump(nullpath & (1,1)--(2,2));
dump((1,1)--(2,2) & nullpath);
// `p & cycle`：末段是直线就走 `--cycle`，否则把末段那两个控制点搬过来
dump((0,0)--(1,0)--(1,1) & cycle);
dump((0,0)..(1,1)..(2,0) & cycle);
dump((0,0)--(1,0)--cycle & cycle);
dump((5,5) & cycle);
dump((5,5)--cycle);
dump((5,5)..cycle);
dump(nullpath--cycle);
// bool 的 `&`：两边都真的算
bool f() { write("f"); return false; }
bool g() { write("g"); return true; }
write(f() & g());
write(g() & g());
write(true & false);
