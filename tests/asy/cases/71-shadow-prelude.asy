// 第三十八刀：**遮住外面来的那个类型名**。
//
// 我们的 prelude（`src/lib/asy/asy_builtins.asy`）里有一份替补的 `struct picture`，
// 真 asy 那边 `picture` 是 `base/plain_picture.asy` 里的 struct（不是 C++ 内建面）。
// 用户文件里再写一个 `struct picture`，asy 收 —— 后一份遮住前一份（量过，见下）。
// 以前我们报"重复定义的 struct 'picture'"，那正是 `import plain;` 那面墙上的第三块砖：
// `base/plain.asy` 里真的那个 `picture` 撞上我们 prelude 的替补。
//
// 收下来靠的还是第三十一刀那条分家：「这里叫什么」（recVis 的键）与「那个类型是什么」
// （rec.name）不是一个东西 —— 真名撞上时按单元前缀打散，源码里那个名字只当键。
//
// 门外的一条（量过，故意不写进这个用例）：**遮之前**用那个名字。
//   picture q = currentpicture;   // 这一行 asy 指的是 prelude 那份
//   struct picture { int x = 7; }
// asy 收（印 7），我们报 "'picture' 在这里还不是一个类型" —— recVis 一个名字只存一份，
// 遮住之后前面那几行也跟着看的是新的这份。要收得对，得让每个名字存一串按位置排的类型。
struct picture {
  int x = 7;
  int twice() { return 2 * x; }
}

picture p = new picture;
write(p.x);
write(p.twice());

picture q;
q = p;
q.x = 9;
write(p.x);
