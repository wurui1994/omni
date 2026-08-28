// 三个内建的缺口，都量着真 asy 补的：
//  - `minAfterTransform` / `maxAfterTransform`（runpath.in:338/362）：每条路径先搬一遍
//    再取盒子，逐分量取最小 / 最大。plain_bounds.asy:316 要它们。
//  - **static** 那一格里躺着函数值：`static frame fitter(string,picture,…);`
//    （plain_picture.asy:876）是一格 static 的函数类型字段，裸名字调它是"读这一格再间接调"。
//  - `write(x, suffix)`：asy 的内建签名里 file 有默认值 stdout，被调方填。
// 整个文件都走带 suffix 的那一路 —— stdout 的行缓冲是一份（见 asy__obuf），而
// 不带 suffix 的 `write(x)` 走的是另一条路（前端内建的 print），两条混着用会串行。
path[] ps = { (0,0)--(1,1), (2,-1)--(3,0) };
write(minAfterTransform(identity(), ps), endl);
write(maxAfterTransform(identity(), ps), endl);
write(minAfterTransform(shift(1,2), ps), endl);
write(maxAfterTransform(scale(2), ps), endl);

struct P {
  int n = 5;
  static int fitter(string, P, real);
  int fit(string pre="a", real x=1) {
    return fitter == null ? n : fitter(pre, this, x);
  }
}
P p;
write(p.fit(), endl);
P.fitter = new int(string s, P q, real x) { return q.n + length(s) + (int) x; };
write(p.fit("abc", 2), endl);

write(true, endl);
write(3, endl);
write(2.5, endl);
write("hi", endl);
write((1,2), endl);
write((1,2,3), endl);
write(false, none);
write("|", endl);
