// `unravel s;` 摊进来的那一条是**按签名**遮的：同名、签名不同的文件级函数照旧调得到。
// geometry.asy:347 的 `unravel R;` 把 coordsys 的字段 `real dot(pair,pair)` 摊了进来，
// :355 那句 `dot(pic, O, dotpen)` 要的却是 plain_markers.asy:329 的那一条 dot。
typedef int intfn(int);
struct S {
  intfn g;
}
int g(int a, int b) { return a*b; }
S s;
s.g=new int(int a) { return a+1; };
unravel s;
write(g(3));
write(g(3,4));
