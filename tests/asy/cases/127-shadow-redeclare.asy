void g(real position) {
  pair position=(position,position+1);
  write(position);
}
g(3);

void locals() {
  real d=5;
  write(d);
  pair d=(d,d+1);
  write(d);
  string d="hi";
  write(d);
  d = d + "!";
  write(d);
}
locals();

// 遮住的那一格进闭包
void h(real n) {
  string n = "n=" + (string) n;
  void p() { write(n); }
  p();
}
h(7);

// 块里遮住外层同名的那一格，出块还是外层的
void blk() {
  real k=1;
  {
    string k="in";
    write(k);
  }
  write(k);
}
blk();

// 遮住之后再遮回原来那个类型
void back() {
  int m=1;
  string m="two";
  int m=3;
  write(m+4);
}
back();
