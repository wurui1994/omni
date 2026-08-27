// 文件级的 `A operator init()`：asy 用它换掉 `A a;` 的隐式构造。
// 量过 `asy -noV`：这个文件原样跑下来印 7 与 1.5 —— `A a;` 拿到的是那份构造回的对象
//（字段默认值仍然铺过了），而 `A b = new A;` 绕开它（b.x 是 0）。
// 内嵌记录字段也走它，而且还是顺序解析的（写在 `A a;` 后面就不算）。
// 我们还没收：那要把 recNew 那一层整个改成"问一遍此处可见的 operator init"。
// struct 体里的 `void operator init(…)`（构造调用 `A(…)`）是另一件事，那个通了。
struct A { int x; real y = 1.5; }
A operator init() { A a = new A; a.x = 7; return a; }
A a;
write(a.x);
write(a.y);
