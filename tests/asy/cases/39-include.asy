// `include m;` 是**文本**包含：那个文件的顶层项就摆在这一行的位置上 —— 名字直接落在
// 当前文件里（不是模块，没有限定名），语句也在这里跑。base/plain.asy 那一串
// `include plain_pens;` 全靠它，所以这一条是"引真的 base/*.asy"的前置。
// 量过（`asy -noV`）：include 进来的语句就地执行，顺序解析照旧（inc_v 在 include 之后才可见）。
int before = 1;
write(before);
include mod_inc;
write(inc_v);
write(incf());
inc_v = 9;
write(incf());
