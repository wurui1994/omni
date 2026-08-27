// 28-import 引到的模块之一。文件级变量、函数、struct（带构造函数与方法）、
// 再 import 一个别的模块 —— 导出的是这四样。
import mod_two;
write("one body");
int base = 10;
int bump(int d) { base = base + d; return base; }
struct Box {
  int v;
  void operator init(int n) { v = n; }
  int get() { return v; }
}
