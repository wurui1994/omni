// for-each 走 operator iter 协议
struct Iter { int get(); void advance(); bool valid(); }
Iter mkiter(int[] xs) {
  int i = 0;
  Iter it;
  unravel it;
  get = new int() { return xs[i]; };
  advance = new void() { ++i; };
  valid = new bool() { return i < xs.length; };
  return it;
}
struct Bag {
  Iter operator iter();
  void operator init(int[] xs) {
    this.operator iter = new Iter() { return mkiter(xs); };
  }
}
int[] xs = {5, 6, 7};
Bag b = Bag(xs);
for (int x : b) write(x);
int s = 0;
for (var y : b) { if (y == 6) continue; s += y; }
write(s);
for (int x : b) { if (x == 6) break; write(x); }
