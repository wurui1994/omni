// `operator []` 与 `operator [=]`（collections/map.asy:26/29）。asy 那边 `v[i]` 就是
// `v.operator [](i)`、`v[i] = x` 就是 `v.operator [=](i, x)` —— 量过直呼那种写法也通。
struct V {
  int[] a;
  int operator [] (int i) { return a[i]; }
  void operator [=] (int i, int v) { a[i] = v; }
}

V v;
v.a = new int[] {10, 20, 30};
write(v[1]);
v[1] = 99;
write(v[1]);
write(v.operator [](2));

// 下标的类型不必是 int（走的是同一张候选表，只是一个 struct 里各只能有一个 ——
// 多一个 asy 自己就拒，见 strict/op-index-dup）
struct D {
  string[] keys;
  int[] vals;
  int operator [] (string k) {
    for (int i = 0; i < keys.length; ++i) if (keys[i] == k) return vals[i];
    return -1;
  }
  void operator [=] (string k, int n) {
    for (int i = 0; i < keys.length; ++i) if (keys[i] == k) { vals[i] = n; return; }
    keys.push(k);
    vals.push(n);
  }
}

D d;
d['a'] = 1;
d['b'] = 2;
d['a'] = 7;
write(d['a']);
write(d['b']);
write(d['zz']);

// struct 里别的方法用自己的下标
struct W {
  int[] a;
  int operator [] (int i) { return a[i]; }
  int head() { return this[0]; }
}
W w;
w.a = new int[] {5, 6};
write(w.head());
