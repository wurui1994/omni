struct P {
  real v;
  real tag(real x) { return x; }
  void operator init(real v) { this.v = v; }
}

// struct 之后才写的那一份：跨单元用 `P p;` 时也要看得见它
P operator init() { P r = P(9); return r; }

// 没有文件级 operator init 的那一份：照旧走字段默认值
struct Q {
  int n = 4;
}
