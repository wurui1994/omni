// triple = 三个 real。这一层它是核心方言的 `(vec real 4)`，**第 3 道垫 0** ——
// MIR 的类型码把向量宽度存成对数（mir/ir.js 的高 3 位），3 在那里编不出来；而硬件
// 本来就把 vec3 垫成 vec4，所以垫一道是常规做法，不是将就（见 lower.js 的 ASY_TRIPLE_TY）。
// 垫出来的那一道**不参与语义**：`==` 只比前三道，印的时候也只印前三道。
// 下面每一行的期望值都是 `asy -noV` 量出来的。要点：
//   `+ -` 逐分量，`* /` 只有 triple 与 **real** 那一个重载（`(1,2,3)+1` 与
//   `(1,2,3)*(4,5,6)` 在 asy 都是 no matching function —— 逐分量乘叫 realmult）
//   abs = length（朴素平方和开根）、dot、cross（右手系）、xpart/ypart/zpart、.x/.y/.z
triple t=(1,2,3);
write(t);
write(t.x); write(t.y); write(t.z);
write(xpart(t)); write(ypart(t)); write(zpart(t));
write(t+(4,5,6));
write(t-(4,5,6));
write(t*2); write(2*t); write(t*2.5); write(t/2);
write(-t);
write(abs(t)); write(length(t));
write(dot(t,(4,5,6))); write(cross(t,(4,5,6))); write(realmult(t,(4,5,6)));
write(t==(1,2,3)); write(t!=(1,2,3)); write(t==(1,2,4));
write((triple)(1,2,3));
triple u; write(u);
// pair 上那三条同名函数是另一组重载（量过：dot 给 11、cross 给**实数** -2、realmult 逐分量）
write(dot((1,2),(3,4))); write(cross((1,2),(3,4))); write(realmult((1,2),(3,4)));
// 复合赋值：`+= -=` 收 triple，`*= /=` 收 real
triple v=(1,2,3);
v+=(1,1,1); write(v);
v*=2; write(v);
v/=4; write(v);
v-=(1,1,1); write(v);
// 数组：裸数组那一整套在 triple 上一条不少
triple[] a; a.push((1,2,3)); a.push((4,5,6));
write(a); write(a.length); write(a[1].y);
triple[] b={(7,8,9),(1,0,0)};
write(b); write(b[0]+b[1]);
for (triple w : b) write(abs(w));
write(b[0:1]);
// 形参与返回值
triple twice(triple w){ return w*2; }
write(twice((1,2,3)));
// struct 的 triple 字段
struct S { triple p; }
S s; write(s.p);
s.p=(1,2,3); write(s.p.z);
s.p*=2; write(s.p);
