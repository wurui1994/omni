// 第二十七刀：反方向的转换（struct -> int）。这份原来在 bad/op-cast —— 那时 `operator cast`
// 还在门外，理由是"它会改重载解析的打分"；现在打分量清了（跟内建提升同价，打平就是
// ambiguous），于是它进 cases。
// 顺序解析在这里看得见：`int b = a;` 前面才声明的 V->int 那份管这一行。
struct V { int x; }
V operator cast(int n) { V v = new V; v.x = n; return v; }
V a = 7;
write(a.x);
int operator cast(V v) { return v.x * 2; }
int b = a;
write(b);
