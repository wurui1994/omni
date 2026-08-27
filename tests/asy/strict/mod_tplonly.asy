// 模板模块：只能被 `from m(T=…) access …` 实例化，不能裸 import。
// 体里刻意不提 T —— 这一条钉的是"裸 import 要被拒"，别的诊断混进来会盖住它。
typedef import(T);
int one() { return 1; }
