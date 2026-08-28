// 第四十七刀：循环条件里**摊得出语句**的东西（条件里的 `? :`、条件里的赋值）。
// 条件每轮都得重算，所以摊出来的语句搬进循环体的开头、判假就 break；
// `continue` 跳到循环顶也会重新算一遍 —— 与 asy 一致。
int i = 0;
while (i < 3 ? true : false) ++i;
write(i);

// 条件里的赋值（asy 那边赋值是表达式，值就是赋进去的那一个）
string s = "a,b,c";
int last = 0;
int p;
while ((p = find(s, ",", last)) >= 0) {
  write(p);
  last = p + 1;
}

// continue 也要重算条件：j 每轮都从条件里更新
int j = 0;
int seen = 0;
while ((j = j + 1) < 5) {
  if (j == 2) continue;
  seen = seen + j;
}
write(seen);
