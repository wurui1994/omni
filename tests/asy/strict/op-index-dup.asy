// 一个 struct 里两个 `operator []` —— asy 自己就拒：量过报
// "multiple operator[] definitions in one struct"。所以这两个名字不是普通的重载集，
// 收下就是比 asy 多接受一门语言。这一条**不带** ASY_NOPE。
struct D {
  string[] keys;
  int operator [] (int i) { return i; }
  string operator [] (string k) { return k; }
}
write(1);
