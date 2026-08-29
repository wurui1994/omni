// 复数上的 sin / cos（runpair.in:208 与 :213）。asy 那边它们是 `explicit pair` 那一格：
// `sin(2.0)` 还是走实数那一份，`sin((1,0.5))` 才是复数版。
// examples/sin3.asy 与 cos3.asy 靠这两格。
pair z=(1.0,0.5);
write(abs(sin(z)));
write(abs(cos(z)));
write(sin(2.0));
write(sin(z).x);
write(cos(z).y);
