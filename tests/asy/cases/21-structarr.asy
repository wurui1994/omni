// struct 的数组（asy 前端第十九刀）：asy 的 struct 是**引用类型**，所以 `A[]` 是"一串句柄"。
// 每一条都量过（asy -noV）：句柄进数组不拷、同一个对象进两格改一次两处都变、
// 数组本身是引用语义（传进函数改的是同一条）。
struct P {
  int x;
  real w = 0.5;
}

P mk(int n) {
  P p = new P;
  p.x = n;
  return p;
}

int total(P[] a) {
  int s = 0;
  for (int i = 0; i < a.length; ++i) s += a[i].x;
  return s;
}

void bump(P[] a, int k) {
  for (int i = 0; i < a.length; ++i) a[i].x += k;
}

P[] a;
write(a.length);
a.push(mk(1));
a.push(mk(2));
a.push(mk(3));
write(a.length);
write(a[0].x);
write(a[2].w);
write(total(a));

// 句柄不拷：手上的和格子里的是同一个对象
P h = a[1];
h.x = 20;
write(a[1].x);
write(total(a));

// 数组是引用语义：函数里改的是同一条
bump(a, 100);
write(total(a));
write(a[0].x);

// 换掉一个格子
a[0] = mk(7);
write(a[0].x);
write(total(a));

// 同一个对象进两格
P dup = mk(9);
a.push(dup);
a.push(dup);
write(a.length);
dup.x = 40;
write(a[3].x);
write(a[4].x);
write(total(a));

// pop 回来的是句柄本身
P last = a.pop();
write(last.x);
write(a.length);

// 切片是复制**数组**，不是复制对象：格子里还是同一批句柄
P[] part = a[0:2];
write(part.length);
part[0].x = 555;
write(a[0].x);

// for-each：循环变量是句柄的复制，指向的还是同一个对象
int seen = 0;
for (P p : a) { seen += p.x; }
write(seen);
write(total(a));
