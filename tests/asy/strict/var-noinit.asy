// `var` 没有初值：**asy 自己就不收** —— 量过它报
// "inferred variable declaration without initializer" 并退 1。
// 也就是「从初值推类型」这一刀不能顺手把"没有初值"当成"给个零值"，那就是比 asy
// 多接受一门语言。三处都是同一条（文件级、struct 字段、函数体里），这里钉文件级那份。
var z;
write(z);
