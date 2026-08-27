// `static` 的**方法**（第三十八刀）：没有接收者的那一种成员。量出来的五条都在这里 ——
//   - `C.make(3)`：类型名限定着调；
//   - struct 的方法体里裸写 `make(…)`；
//   - **实例上**也能调（`a.make(7)` 通 —— 接收者算白搭）；
//   - static 的体里能调另一个 static、能读 static 字段；
//   - 但实例字段与实例方法在 static 的体里用不了（asy 报 "static use of dynamic
//     variable"，见 strict/static-method-inst-field 与 -inst-call）。
// 落地就是"名字挂在 struct 上、没有 this 形参的普通函数"：符号 asy__sm_<记录>_<名字>，
// 候选表还是那张 `记录名.方法名`，applyCall 里丢掉接收者那一句。
// plain_scaling.asy:9/166 的 `static coord build(…)` / `static scaling build(…)` 靠这一条。
struct C {
  int v;
  static int made = 0;

  static C make(int v) {
    C c = new C;
    c.v = v;
    // `++made` 那种复合形态在 static 字段上还是 nope（另一刀），这里写成显式赋值
    made = made + 1;
    return c;
  }

  // 重载也照旧：static 与非 static 混在一个名字上
  static C make(int a, int b) { return make(a + b); }

  C twin() { return make(v * 2); }
  int val() { return v; }
}

C a = C.make(3);
write(a.v);
write(a.twin().v);

C b = a.make(7);
write(b.v);

C c = C.make(2, 5);
write(c.v);
write(C.made);
