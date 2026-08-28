// `? :` 两支不同型：靠用户的 operator cast 定案（pair -> guide）
write(length(true ? (0,0) : (1,1)--(2,2)));
write(length(false ? (0,0) : (1,1)--(2,2)));
write(true ? 1 : 2.5);
// intMax 不是 INT64_MAX（common.h:106 留了最高两个值）
write(intMax); write(intMin); write(randMax);
// orient：照 path.cc:1158 那两行摆，`-0` 也一样
write(orient((0,0),(1,0),(0,1)));
write(orient((0,0),(1,0),(1,0)));
write(orient((0,0),(1,0),(2,0)));
// 绕数与 inside
path g = (0,0)--(1,0)--(1,1)--(0,1)--cycle;
write(windingnumber(g,(0.5,0.5)));
write(windingnumber(g,(2,2)));
write(windingnumber(g,(0.5,0)));
write(windingnumber(reverse(g),(0.5,0.5)));
write(inside(g,(0.5,0.5)));
write(inside(g,(2,2)));
path c = (0,0)..(2,0)..(2,2)..(0,2)..cycle;
write(windingnumber(c,(1,1)));
write(windingnumber(c,(1,3)));
write(inside(c,(1,1),fillrule(1)));
path[] two = {g, shift(0.25,0.25)*scale(0.5)*g};
write(windingnumber(two,(0.35,0.35)));
write(inside(two,(0.35,0.35),fillrule(1)));
write(inside(two,(0.35,0.35)));
// 数组上的 abs
real[] ra = {-1.5, 2};
pair[] pa = {(3,4),(0,-2)};
triple[] ta = {(1,2,2),(0,0,-3)};
write(abs(ra)[0]); write(abs(pa)[0]); write(abs(ta)[0]);
// 泛型的 array(int, T)
real[] f1 = array(3, 1.5);
write(f1.length); write(f1[2]);
real[][] f2 = array(2, f1);
f2[0][0] = 9;
write(f2[1][0]);
string[] f3 = array(2, "q");
write(f3[1]);
