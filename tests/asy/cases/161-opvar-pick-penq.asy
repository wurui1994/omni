// 一批：同名的文件级算符变量按签名挑；不带实参的笔查询

// `operator ::` / `---` 在 base 里是**一格变量**（plain_paths.asy:129 的 interpolate、
// three.asy:793 的 interpolate3），同名的可以有好几格 —— 按签名分得开。
typedef int conn(int, int);
conn operator ::=new int(int a, int b) { return a * 100 + b; };

typedef string sconn(... string[]);
sconn operator ::=new string(... string[] xs) {
  string s = "[";
  for (int i = 0; i < xs.length; ++i) s = s + xs[i];
  return s + "]";
};

write(3 :: 4);
write("a" :: "b" :: "c");

typedef real rconn(real, real);
rconn operator ---=new real(real a, real b) { return a - b; };
write(7.5 --- 2.5);

// 笔的查询那一族不带实参时是 currentpen（runtime.in 里都写成 `T f(pen p=CURRENTPEN)`）
write(linewidth());
write(linecap());
write(linejoin());
write(basealign());
write(fontsize());
write(lineskip());
write(font());
write(linetype().length);
currentpen = linewidth(2) + fontsize(20);
write(linewidth());
write(fontsize());
write(lineskip());
write(linewidth(linewidth(3)));
