// 只有 static 成员的 struct 在我们这边会被补一个**看不见的**占位字段（核心方言的 class
// 至少要一个字段）。这里钉的是"看不见"：那个名字取不出来，与真 asy 一样报没有这个字段。
struct Box {
  static int n = 1;
}

Box b;
write(b.asy__filler);
