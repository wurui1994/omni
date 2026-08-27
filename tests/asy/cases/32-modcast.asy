// 第二十七刀 × 第二十五刀：模块里的 `operator cast` 跟着 `import` 一起进来。
import mod_cast;

// 隐式位置：模块里的转换在这边也管用
write(useC(1));

// `(C) x` 也走它
C c = (C) 2;
write(c.n);

// 顺序解析照旧：本地再写一份，从这里起用本地那份
C operator cast(int x) {
  C r = new C;
  r.n = x + 500;
  return r;
}

write(useC(3));
