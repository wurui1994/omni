// 把方法取出来当**值**：asy 收，我们不收。
// 量过 `asy -noV`：这个文件原样跑下来印 1 退 0 —— asy 的方法就是一个字段，取出来是绑住
// 接收者的闭包。我们的方法降成"多带一个 this 形参的普通函数"，核心方言里函数不是值，
// 要绑接收者就得有闭包（那是另一刀）。方法**调用**是通的，见 cases/22-structmethod.asy。
struct A { int x = 1; int get() { return x; } }
A a;
int f() = a.get;
write(f());
