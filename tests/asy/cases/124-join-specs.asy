// 第四十六刀：连接里的方向标记、张力、控制点。plain 那几份（tension 的两参转发、
// controls 的一参转发、`operator ..(tensionSpecifier)`、`operator ::`/`operator ---`）
// 在这儿照 plain_paths.asy:11-22/118-130 原样写一遍 —— 真 asy 那边它们是重复声明，
// 同签名是替换、变量是遮住，两边看到的都是同一份语义。
using interpolate = guide(... guide[]);

tensionSpecifier operator tension(real t, bool atLeast)
{
  return operator tension(t, t, atLeast);
}

guide operator controls(pair z)
{
  return operator controls(z, z);
}

interpolate operator ..(tensionSpecifier t)
{
  return new guide(... guide[] a) {
    if (a.length == 0) return nullpath;
    guide g = a[0];
    for (int i = 1; i < a.length; ++i)
      g = g..t..a[i];
    return g;
  };
}

interpolate operator :: = operator ..(operator tension(1, true));

void dump(path g) {
  write(length(g));
  write(cyclic(g));
  for (int i = 0; i < size(g); ++i) {
    write(precontrol(g, i));
    write(point(g, i));
    write(postcontrol(g, i));
    write(straight(g, i));
  }
}

dump((0,0){(0,1)}..tension 2 and 3 ..{curl 1.5}(1,1));
dump((0,0)..tension atleast 4 ..(1,1));
dump((0,0)..tension 4 ..(1,1));
dump((0,0)..controls (1,0) and (2,1)..(3,3));
dump((0,0)..controls (1,1)..(3,3));
dump((0,0){(1,2)}..(1,1));
dump((0,0){(0,1)}..(1,1));
dump((0,0)::(1,1)::(2,0));
dump((0,0){(0,1)}..{(1,0)}(1,1)..{(0,-1)}(2,0){(-1,0)}..cycle);
dump((0,0){curl 2}..(1,1)..{curl 2}(2,0));
dump((0,0){curl 3}..(1,1));
dump((0,0)..{curl 0.5}(2,0));
dump((0,0){curl 3}..(1,1)..(2,0)..{curl 0.5}(3,4));
