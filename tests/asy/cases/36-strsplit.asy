// 字符串的 split 与 insert。两条先前都在门外，理由各不相同、现在都不成立了：
//   split 要 `string[]` 的返回值 —— 数组那一整套（含 `string[]`）早就通了
//   insert 缺的是**测量**："越界怎么办"没量全，不猜。这一刀量了（下面钉着）
// split 的四条语义（每条都在 lower.js 的 asy__ssplit 上方写着）：
//   普通分隔符不重叠、**保留空字段**；找不到就整串一个元素；空串给一个空元素；
//   分隔符是**空串**时按**空格**切并丢掉空字段（只有空格算分隔，制表符不算）
// insert 的关键一条：下标落在 [0, length) 之外**什么都不做** —— 不是"追加到末尾"。
write(split("a,b,c",","));
write(split("a,b,c",",").length);
write(split("a,,b",","));
write(split(",a,",","));
write(split("",","));
write(split("abc","abc"));
write(split("aXXbXXc","XX"));
write(split("abc","x"));
write(split("a b  c",""));
write(split("  a  b  ",""));
write(split("a,b,c",""));
write(split("a b","")[1]);
// 切出来的就是普通的 string[]：下标、length、for-each、切片都能用
string[] parts = split("x:y:z",":");
write(parts.length);
for (string p : parts) write(p);
write(parts[1:3]);
write(insert("abc",1,"XY"));
write(insert("abc",0,"X"));
write(insert("abc",2,"XY"));
write(insert("abc",3,"X"));
write(insert("abc",5,"X"));
write(insert("abc",-1,"X"));
write(insert("",0,"X"));
write(insert("abcdef",4,"Z"));
