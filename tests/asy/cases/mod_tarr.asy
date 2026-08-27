// 65-tplinst-array 引的模板模块（mod_ 开头的不是用例）。要紧的是 `T[]` —— 实例化时
// T 是**另一个模板的实例**（Box_int），这一族的形状与 collections/iter.asy 里的一样。
typedef import(T);

T firstOf(T[] items) {
  return items[0];
}

T[] pair(T a, T b) {
  T[] r;
  r.push(a);
  r.push(b);
  return r;
}
