// 第四十四刀之二：struct 里的同名成员**不整片遮住**外层的同名函数。
// asy 的名字解析是逐层按签名找的（venv），成员那一层接不住这次实参就往外走 ——
// base 里 plain_picture.asy:686 就靠这条（struct picture 里有 `pair min(transform)`，
// 体里照样调得到内建的 `min(real,real)`）。

int who() { return 1; }
int twice(int k) { return 2 * k; }

struct S {
  pair min(transform t) { return (0, 0); }
  int who(int k) { return 10 + k; }
  int twice(string s) { return -1; }

  void go() {
    write(min(1.0, 2.0));      // 外层（内建）那一份
    write(min(new int[] {5, 2, 9}));
    write(who());              // 成员那一份接不住 0 个实参 -> 外层的
    write(who(7));             // 成员那一份
    write(twice(4));           // 成员是 twice(string) -> 外层的
    write(twice("x"));         // 成员那一份
    write(min(identity()).x);  // 成员那一份（transform）
  }
}

S s;
s.go();
