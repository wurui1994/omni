// 带形参的**文件级** `operator init`：asy 收这个声明，但它不是隐式转换 ——
// 量过 `asy -noV`：这个文件原样跑下来印 0（`A a;` 走的还是默认构造），而加上
// `A b = 7;` 会报 "cannot cast 'int' to 'A'"。既然量不出它到底能拿来干什么，就不猜。
// 不带形参的那份是通的，见 cases/24-oinit.asy。
struct A { int x; }
A operator init(int n) { A r = new A; r.x = n; return r; }
A a;
write(a.x);
