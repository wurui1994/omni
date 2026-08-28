// 函数**类型**上的默认值、别名当返回类型、没有体的成员声明，与几处按目标类型定案。
// (1) 类型上带默认值（`using envelope=path(frame dest, frame src=dest, …)`，
//     plain_boxes.asy:75）：通过一格这种类型的函数值调用时少给的实参由它补。
//     少给的**不一定在尾巴上** —— 类型接不住的那一格跳过去（plain_boxes.asy:88）。
struct fr { int k; }
using env=int(fr d, fr s=d, int m=1);
int box(fr d, fr s=d, int m=1) { return d.k * 100 + s.k * 10 + m; }
env e = box;
fr q; q.k = 7;
write(e(q));
write(e(q, 5));

// (2) 别名当**返回类型**（`arrowbar EndBar(real size=0)=Bar;`，plain_arrows.asy:429）：
//     那一格的类型是 `bool(int)(real)`，不是 `ab(real)` —— 不展开的话下一句调不动。
using ab=bool(int);
ab mk(real size) { return new bool(int i) { return i > size; }; }
ab mkv(real size=0)=mk;
write(mkv(2.5)(3));

// (3) struct 里**没有体**的成员声明就是一格函数类型的字段（`V operator [] (K key);`，
//     collections/map.asy:43/85）。下标读写都落在那一格上。
struct S {
  int size();
  int operator [] (int k);
  void operator [=] (int k, int v);
}
S s;
int[] cell = {0};
s.size = new int() { return 5; };
s.operator [] = new int(int k) { return k * 2 + cell[0]; };
s.operator [=] = new void(int k, int v) { cell[0] = k + v; };
write(s.size());
write(s[3]);
s[10] = 4;
write(s[3]);

// (4) pair 的数组元素上的复合赋值（`A[0][0] /= D;`，plain_Label.asy:70）
pair[][] A={{(1,2),(3,4)},{(5,6),(7,8)}};
real D=2;
A[0][0] /= D;
A[1][1] += (1,1);
write(A[0][0]);
write(A[1][1]);

// (5) 同一层里被重新声明遮住的那一格：用处那一侧按**目标类型**还挑得到它
//     （`marginT margin=margin(b--b,p);` 之后 `draw(…,margin)`，plain_arrows.asy:593/595）
using mg=fr(int);
fr mkfr(int i) { fr t; t.k = i; return t; }
int take(mg m) { return m(3).k; }
int f(mg margin) {
  fr margin = margin(7);
  return take(margin) + margin.k;
}
write(f(mkfr));
