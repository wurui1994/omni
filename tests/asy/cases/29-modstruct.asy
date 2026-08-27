// 模块的第二组量点（第二十五刀）：
//   - import 进来的 struct 能当**本地 struct 的字段类型**（声明遍里记录与模块声明
//     按下标同一遍走，就是为了这一条）；
//   - 被调方的**默认实参**在它自己那个文件里求（`addp(p)` 补的是 mA 里的 5）；
//   - import 进来的候选与本地的候选是**同一张重载表**，而且照旧顺序解析 ——
//     最后那句 `f(2)` 走的还是模块里的 int 那份，尽管前一行刚定义了 real 那份。
import mod_five;
struct Q { P inner; }
Q q;
q.inner.x = 3;
write(addp(q.inner));
write(f(2));
real f(real r) { return r / 2; }
write(f(3.0));
write(f(2));
