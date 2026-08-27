// 记录名在声明**之前**用，但这一回是当**数组元素**（`A[]`）—— 量过 asy 一样报
// "no type of name 'A'"。与 strict/struct-fwd 是同一条规矩的另一条路：type() 里
// array-ty 那一支自己解元素名，所以顺序解析要在那儿也裁一刀。
// 第三十三刀把那一支改成与 name-ty 同一条路时，这条钉着"别把守卫放松掉"。
A[] a;
write(a.length);
struct A { int x = 3; }
