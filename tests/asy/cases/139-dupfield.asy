// 同名的两格字段（第四十九刀）：asy 的 struct 体是个作用域，`real size(int k)` 与
// `real size` 按签名分得开，是**两个**成员。three_arrows.asy:70/73 的 arrowhead3
// 就是这个形状（那边是 `real size(pen p)=arrowsize;` 与 `real size;`）——
// 这一层给后一份另起了槽名，`.size` 按上下文（取值 / 调用）挑一份。
real three(int k) {return 3;}

struct head {
  real size(int k)=three;
  real size;
  void show() {
    write(size);     // 取值这一路：挑不是函数类型那份
    write(size(1));  // 调用这一路：挑函数类型那份
  }
}

head h;
write(h.size);     // 0（real 那格的零值）
write(h.size(1));  // 3（函数那格）
h.size=7;          // 赋值挑 real 那格
write(h.size);
write(h.size(1));
h.size=new real(int k){return 11;};  // 同一个名字，这一句挑函数那格
write(h.size(1));
write(h.size);
h.show();

// 拷过来：`TeXHead3.size=TeXHead.size;`（three_arrows.asy:218）那一形态 —— 右边只有
// 一格 real，所以左边那两格里挑 real 那份。（两边都是两格时 asy 报
// "assignment is ambiguous"，这一层挑 real 那格收下了 —— 收得比 asy 多的一处，
// 记在 ADR 里，没往 strict 里钉。）
struct flat { real size; }
flat g;
g.size=5;
h.size=g.size;
write(h.size);
write(h.size(1));
