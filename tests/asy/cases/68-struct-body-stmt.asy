// struct 体里的**语句**（第三十六刀）。asy 的 struct 体其实就是一个 block ——
// 量出来的四条：
//   - 每造一个实例就按体内顺序跑一遍（两个实例印两遍 body）；
//   - 与字段默认值是同一串（`x = 5` 在 `int y = x + 1` 前面，所以 y 是 2 不是 6）；
//   - 能裸读写前面的成员（字段与方法都算）；
//   - 后面的成员看不见（asy 报 "no matching variable"，见 strict/struct-body-later）。
// collections/map.asy:115 的 `map.size = new int() { return size; };` 靠这一条 ——
// 补上之后 collections/ 整族过了。
struct S {
  int x = 1;
  write('body');
  int y = x + 1;
  x = 5;
  int sum() { return x + y; }
  int tot = sum();
  for (int i = 0; i < 3; ++i) {
    tot += i;
  }
}

S a = new S;
write(a.x);
write(a.y);
write(a.tot);

S b = new S;
write(b.tot);
write('done');
