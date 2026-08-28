// 第四十七刀：闭包抓外层的接收者。方法体里的匿名函数照样看得见 this、字段与方法
// （plain_Label.asy:316/342 那两处 `pic.add(new void(frame,transform){ out(…); })`）。
using ifn = int();
using sfn = string();

struct Counter {
  int n = 0;
  string tag = "c";
  int bump(int k) { n += k; return n; }

  // 裸方法名
  ifn maker() {
    return new int() { return bump(1); };
  }

  // 裸字段名
  sfn teller() {
    return new string() { return tag + string(n); };
  }

  // 改字段、显式 this、以及同时抓一格外层局部量
  ifn adder(int d) {
    return new int() { n += d; return this.n; };
  }

  // 两层：里层要穿过外层那个闭包才拿到接收者
  ifn twice() {
    return new int() {
      ifn inner = new int() { return n; };
      return inner() * 2;
    };
  }

  // static 的方法体里没有接收者 —— 那一格不抓
  static ifn plain(int d) {
    int t = d;
    return new int() { return t * 2; };
  }
}

Counter c;
ifn m = c.maker();
write(m());
write(m());
sfn t = c.teller();
write(t());
ifn a = c.adder(10);
write(a());
write(c.n);
write(c.bump(0));
ifn w = c.twice();
write(w());
ifn p = Counter.plain(21);
write(p());
