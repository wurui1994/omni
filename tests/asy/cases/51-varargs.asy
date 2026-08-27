// 可变形参（`... T[] xs`）。plain_paths.asy:3 的 `guide(... guide[])` 是它在**函数类型**里
// 的形态，那一格还没接；这里钉的是普通函数上的那一半。
int total(... int[] xs) {
  int s = 0;
  for (int i = 0; i < xs.length; ++i) s += xs[i];
  return s;
}
write(total());
write(total(1,2,3));

int[] a = {4,5};
write(total(... a));       // 展开
write(total(9, ... a));    // 散着写的与展开的混在一起

// 前面还有固定形参
int mix(int k, ... int[] xs) { return k*100 + xs.length; }
write(mix(2));
write(mix(2,7,8));
// 不带逗号的写法真 asy 也收
int mix2(int k ... int[] xs) { return k + xs.length; }
write(mix2(5,1,2));

// 元素要提升：int 实参进 real[] 那一格
real avg(... real[] xs) {
  if (xs.length == 0) return 0;
  real s = 0;
  for (int i = 0; i < xs.length; ++i) s += xs[i];
  return s / xs.length;
}
write(avg(1,2,4));

// 重载：任何非可变的候选都比可变的合适（量过）
int pick(int x) { return 1; }
int pick(... int[] x) { return 2; }
write(pick(3));
write(pick(3,4));
write(pick());

// 展开是**拷**进去的，不是同一条数组
void poke(... int[] x) { x[0] = 99; }
poke(... a);
write(a[0]);

// 可变形参也能收字符串
string join(... string[] parts) {
  string s = "";
  for (int i = 0; i < parts.length; ++i) s += parts[i];
  return s;
}
write(join("a","b","c"));
