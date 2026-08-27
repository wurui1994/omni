// 28-import 里用 `from mod_four access tag;` 引这一份 —— 只把 tag 带成裸名字，
// hidden 不带（量过：那样写之后 hidden 还是 "no matching variable"）。
write("four body");
string tag() { return "four"; }
int hidden = 44;
