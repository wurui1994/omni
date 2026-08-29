// 局部量是**函数类型**时它遮不住同名的字段（147-fnslot-shadow 的 (1) 那一格，
// three.asy:2755）；不是函数的那一格是**真的**遮住 —— 量过
// `struct S { int x; void go() { string x="a"; x=5; } }` 在 asy 那边报的是
// "cannot convert 'int' to 'string' in assignment"，不会退回去赋那个字段。
// 这条不是"还没做"，所以钉在这儿：按签名挑格那一路不许把它一起放过。
struct S { int x; void go() { string x="a"; x=5; write(this.x); } }
S s; s.go();
