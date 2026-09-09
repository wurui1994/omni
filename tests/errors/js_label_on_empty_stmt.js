// 标签只打在循环或块上（这个值域的边界，见 parser 的 labeled）。
//
// `L: { … break L; }` 会被摊成 `L: while (true) { … ; break; }`，所以标签的载体必须是**块**
// 或循环。别的形状（`L: ;`、`L: foo();`）在规范里合法，这儿不收 —— 但**必须是一条诊断**，
// 不是宿主崩。从前 this.error 只记不抛、代码接着往下读 body.body，于是空语句那一支崩成
// TypeError: body.body is not iterable：一格没有位置、没有源码行的宿主栈。
//
// 这份用例钉的就是"报一条、位置对、退出码非零"。
lbl: ;
console.log("never compiled");
