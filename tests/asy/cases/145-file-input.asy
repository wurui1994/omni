// 从文件读：line 模式的整行、word 模式的词、real[] / real[][]、eof/eol/error/close，
// 以及 `(real) s` / `(int) s` 这两条字符串转换。数据在 145-file-input.dat 里
// （第 3 行是空行、第 5 行整行是注释、第 6 行行尾有注释、最后一行没有数）。
string d = "145-file-input.dat";

// 一、line 模式一行一行读：空行会被"读完一行之后的 nexteol"吃掉，注释行读出来是空串
file b = input(d).line();
for (int i = 0; i < 8; ++i) {
  bool e0 = eof(b);
  string s = b;
  write("s" + string(i) + " eofbefore=" + (e0 ? "T" : "F") + " [" + s + "] eofafter=" + (eof(b) ? "T" : "F"));
}

// 二、word + line 模式：一行的词一份数组。空行是**一格空串**（nullfield 那条路）
file w = input(d).word().line();
for (int i = 0; i < 8; ++i) {
  string[] a = w;
  string j = "";
  for (int k = 0; k < a.length; ++k) j += "<" + a[k] + ">";
  write("w" + string(i) + " n=" + string(a.length) + " " + j + " eof=" + (eof(w) ? "T" : "F"));
}

// 三、real[]：line 模式下一行一份，空行是一格 0
file r = input(d).line();
for (int i = 0; i < 6; ++i) {
  real[] a = r;
  string j = "";
  for (int k = 0; k < a.length; ++k) j += "<" + string(a[k]) + ">";
  write("r" + string(i) + " n=" + string(a.length) + " " + j);
}

// 四、不带 line 模式：字符串读**不**跳空行，数字读一直读到底（二维只有一行）
file g = input(d);
for (int i = 0; i < 4; ++i) { string s = g; write("g" + string(i) + "[" + s + "]"); }
file m = input(d);
real[][] z = m;
write("rows=" + string(z.length) + " cols0=" + string(z.length > 0 ? z[0].length : -1));

// 五、line 模式的二维：一行一行
file m2 = input(d).line();
real[][] z2 = m2;
string sh = "";
for (int i = 0; i < z2.length; ++i) sh += "<" + string(z2[i].length) + ">";
write("rows2=" + string(z2.length) + " " + sh);

// 六、eol / error / close。**读一个 close 过的句柄不测**：量过真 asy 那边
// `close(f); eof(f);` 是 Segmentation fault（流已经 delete 了），这一层回 eof=true。
file c = input(d).line();
write("eol0=" + (eol(c) ? "T" : "F") + " error0=" + (error(c) ? "T" : "F"));
close(c);
write("closed");

// 七、字符串转数
write("cast " + string((real) "3.5") + " " + string((int) "12") + " " + string((real) "1e3"));
