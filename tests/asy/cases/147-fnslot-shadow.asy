// 同名按**签名**分得开的三处（三个都是 three.asy 上量出来的），加虚线的 adjust。
import mod_fnslot;
access mod_fnslot;

// (1) 字段被同名的**局部函数**遮住：赋值还是落在字段上（three.asy:2755 的 `f=pic.fit3(…)`，
//     那边 `frame f` 是 struct scene 的字段，而块里又声明了 `real f(pair,pair)`）。
struct S {
  int n;
  void go(bool b) {
    if (b) {
      real n(int a) { return a+0.5; }
      write(n(3));
      n = 7;
    }
    write(n);
  }
}
S s; s.go(true);

// (2) import 进来的函数名当左值（three.asy:3235 的 `fit=new frame[](…)` 赋的是
//     plain_arrows.asy:618 那一格）。
write(g(1));
g = new real(int x) { return x+2; };
write(g(1));

// (3) 模块限定的函数当**值**用（three.asy:12 的 `Embed=embed.embedplayer`）。
real h(int) = mod_fnslot.g2;
write(h(1));

// (4) 虚线的 adjust（runtime.in:535 -> drawpath.cc:52）：节拍缩到正好铺满弧长。
//     （这一份用例不引 plain，所以笔宽用默认的那 0.5 —— `+2bp` 那种写法要 plain。）
pen p = adjust(linetype(new real[] {4,4}), 10, false);
write(linetype(p));
write(offset(p));
write(linetype(adjust(linetype(new real[] {8,8,4}, offset=2), 25, true)));
write(offset(adjust(linetype(new real[] {8,8,4}, offset=2), 25, true)));
write(linetype(adjust(linetype(new real[] {4,4}, adjust=false), 10, false)));
