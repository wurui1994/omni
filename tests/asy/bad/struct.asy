// struct + `operator init`：asy 的记录类型自带构造、字段默认值和 unravel，
// 这一刀先不碰。
struct P {
  int x;
}
P p = new P;
write(p.x);
