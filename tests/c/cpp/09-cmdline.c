/* 命令行上的 `-D` 与 `-U`（第九刀第八十五片）。这一份**不带开关也过得去** ——
   没定义的名字在输出里就是它自己，`#ifdef` 那两支各走一边。
   期望值不写在这里：它是 tcc 的输出。带开关的走法见 run.js 的 optCase。 */
int x = X;

#ifdef X
int has_x = 1;
#else
int has_x = 0;
#endif

#if defined Y && Y > 1
int y_big = Y;
#else
int y_big = 0;
#endif

/* 命令行上的定义能被源码里的 `#undef` 掀掉，反过来也一样 */
#undef X
int after_undef = X;
