// struct 的数组字段（第十六刀）。核心方言的类字段现在收 (arr T)，而数组是**引用语义** ——
// 复制 struct 搬的是句柄，两个副本共用同一条数组。asy 的 struct 本身也是引用语义，
// 所以这一份里"共用"是两层的：句柄一层、对象一层。
struct S {
  int[] xs;
  pair[] pts;
  int[] seeded = new int[2];
  string tag;
}

void grow(S s) { s.xs.push(5); }
int total(S s) {
  int t = 0;
  for (int v : s.xs) t += v;
  return t;
}

// 零值：空数组（不是空引用 —— .length 就得能答），有默认值的那个是长度 2
S a;
write(a.xs.length);
write(a.seeded.length);
// 注意 seeded 的格子是 `new int[2]` 来的：asy 那边**读它是运行期错误**
// （"read uninitialized value from array"），我们填零 —— 这条差别写在 lower.js 的头里，
// 所以这一份只问长度，不读值。
write(a.tag);
write(a.pts.length);

// push / 下标读写 / pop / length
a.xs.push(10);
a.xs.push(20);
write(a.xs.length);
write(a.xs[0]);
a.xs[1] = 99;
write(a.xs[1]);
a.xs[1] += 1;
write(a.xs[1]);
write(a.xs.pop());
write(a.xs.length);

// 补满几格再往下走 —— 写下标顶长度那条规则（以及"跳过的格子在 asy 那边是未初始化"）
// 已经在裸数组那几份用例里钉过，这里不重复，好让下面能整条印出来
a.xs.push(20);
a.xs.push(30);
write(a.xs.length);
write(a.xs[2]);

// pair 元素的数组字段（核心方言里是 blob 那份实现）
a.pts.push((1,2));
a.pts.push((3,4));
write(a.pts[1]);
write(a.pts.length);
write(a.pts[0]+a.pts[1]);

// 整个数组当值印出来（每行「下标 : TAB 值」）
write(a.xs);

// 切片是复制不是视图
int[] part = a.xs[1:3];
write(part.length);
part[0] = -1;
write(a.xs[1]);

// struct 是引用语义：b 就是 a
S b = a;
b.xs.push(1000);
write(a.xs.length);
b.tag = "t";
write(a.tag);

// 改形参里的数组字段，外面看得见
grow(a);
write(b.xs.length);
write(total(a));

// 整条数组换掉：换的是句柄
int[] fresh = {1,2,3};
a.xs = fresh;
write(a.xs.length);
write(a.xs[2]);
fresh.push(4);
write(a.xs.length);

// 每次构造都是**新的**空数组，不是上一轮那条
for (int i = 0; i < 3; ++i) {
  S e;
  e.xs.push(i);
  write(e.xs.length);
  write(e.seeded.length);
}
