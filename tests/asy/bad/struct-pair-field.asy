// pair 字段还不收：核心方言的类字段只认标量（每条腿的"零值"是各自一个只认标量的
// 小函数，见 sexpr/lower.js 的 structDec）。pair 在核心方言里是 (vec real 2)。
struct P {
  pair z;
}
P p = new P;
write(p.z);
