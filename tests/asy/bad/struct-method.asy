// struct 里的函数定义（方法）还不收：那要 this 与闭包，是另一刀。
struct P {
  int x;
  int twice() { return 2x; }
}
P p = new P;
write(p.twice());
