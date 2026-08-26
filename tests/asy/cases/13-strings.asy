// 字符串函数：length / substr / find / rfind / erase / replace。
// 期望值都是 `asy -noV` 印的，边角尤其是量出来的：
//
//   - 越界**不报错**：substr("abc",5,1) 是空串，substr("abc",1,100) 是 "bc"。
//   - 负数当无效，**不是** clamp 到 0：substr("abc",-1,2) 是空串（clamp 会给 "ab"），
//     find("abc","b",-5) 是 -1（clamp 会给 1），erase("abc",-1,2) 原样返回。
//   - replace 换掉所有不重叠的出现：replace("aaa","aa","b") 是 "ba"。
//   - length 只有 string 和 pair 两个重载 —— 数组的长度写 a.length（见 strict/）。
//   - 长度按**字节**：asy 的 string 是 C++ 的 std::string，Omni 的 string 是 UTF-8 字节序列。

string s = "hello world";

write(length(s));
write(length(""));
write(substr(s,0,5));
write(substr(s,6,5));
write(substr(s,6));
write(substr(s,6,100));
write(substr("abc",5,1));
write(substr("abc",-1,2));

write(find(s,"o"));
write(find(s,"o",5));
write(find(s,"zz"));
write(find("abc","b",100));
write(find("abc","b",-5));
write(find(s,""));

write(rfind("abcabc","bc"));
write(rfind(s,"o"));
write(rfind(s,"zz"));

write(erase("abc",1,100));
write(erase("abc",-1,2));
write(erase(s,5,6));

write(replace("aaa","aa","b"));
write(replace(s,"l","L"));
write(replace("abc","","X"));
write(replace(s,"world","there"));

// 比较与拼接（这两条第一刀就有，放在这里是因为字符串的用例都在一处好读）
write(s < "z");
write(s + "!");
write(s == "hello world");

// 非 ASCII：长度是字节数，切在字节边界上
write(length("中文"));
write(substr("中文",0,3));
write(find("中文","文"));

// 在函数里用，且把字符串当形参/返回值
string initials(string a, string b) { return substr(a,0,1) + substr(b,0,1); }
write(initials("hello","world"));

int words(string t) {
  int n = 0;
  int i = 0;
  while (i < length(t)) {
    if (substr(t,i,1) == " ") ++n;
    ++i;
  }
  return n + 1;
}
write(words(s));
write(words("a b c d"));

// 循环里逐字节走一遍，顺手把 for-each 与切片以外的下标方式对上
string rev = "";
for (int i = length(s) - 1; i >= 0; --i) rev += substr(s,i,1);
write(rev);
