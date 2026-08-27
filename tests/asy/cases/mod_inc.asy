// 39-include.asy 的被 include 文件。include 是文本级的，所以这里的语句在那边就地跑。
int inc_v = 7;
write("in mod_inc");
int incf() { return inc_v * 2; }
