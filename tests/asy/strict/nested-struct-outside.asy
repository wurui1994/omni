// 嵌套 struct 的名字在**体外**用（第三十九刀）：asy 报 "no type of name 'Inner'" 并退 1。
// 也就是"体里可见"这一条不能顺手做成"全局可见" —— 那就是比 asy 多接受一门语言。
// 体外还有两条同族的（都退 1，理由不同，所以没进这一条里）：
//   `Outer.Inner x;`      -> private 的报 "accessing private field outside of structure"
//   `new Outer.Inner`     -> 不 private 的报 "allocation of struct 'Inner' is not in a valid scope"
struct Outer {
  struct Inner { int n = 2; }
  Inner a = new Inner;
}
Inner b;
write(b.n);
