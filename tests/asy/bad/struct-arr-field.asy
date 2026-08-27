// 数组字段还不收，与 pair 字段同一条理由。
struct P {
  int[] xs;
}
P p = new P;
write(p.xs.length);
