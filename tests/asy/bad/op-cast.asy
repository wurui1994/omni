// `operator cast`：asy 的**隐式转换**（量过这个文件原样跑下来印 7 与 14 —— `V a = 7;`
// 走 int->V 那份，`int b = a;` 走 V->int 那份）。我们不收，理由不是形态难认，是它会改
// **重载解析的打分**：一旦用户能加转换，"要几次转换"这件事就不再只由内建的提升表决定，
// 而那张表（fit 里的 convCost）是第十一刀量出来钉死的。收它得先量清"用户转换算几分、
// 能不能连着用两次、跟内建提升谁优先"，那是另一刀。
// 别的算符是通的，见 cases/25-opover.asy 与 cases/26-opbuiltin.asy。
struct V { int x; }
V operator cast(int n) { V v = new V; v.x = n; return v; }
V a = 7;
write(a.x);
int operator cast(V v) { return v.x * 2; }
int b = a;
write(b);
