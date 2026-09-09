// 整张 Unicode 大小写表（ADR-0020）。从前 0x80 以上有映射的码点一律**当场报错**
// （"要么整张表要么拒掉"）；现在四条腿上都是整张表，两侧同一批数字。
// 量的三件事：一对多（ss / fi 那族连字会让串变长）、titlecase 那一族（Dz 的三形）、
// 以及 Final_Sigma —— Σ 在词尾小写成 ς，那是**有条件**的特例，要 Cased 与
// Case_Ignorable 两个性质；少了它 "ΣΟΦΟΣ".toLowerCase() 给 σοφοσ，是静默的错答案。
console.log("Straße".toUpperCase(), "ß".toUpperCase(), "ﬁx".toUpperCase());
console.log("ΣΟΦΟΣ".toLowerCase(), "σοφος".toUpperCase(), "İ".toLowerCase().length);
console.log("é".toUpperCase(), "É".toLowerCase(), "ǅ".toUpperCase(), "ǅ".toLowerCase());
console.log("ＡＢ".toLowerCase(), "𐐨".toUpperCase(), "𐐀".toLowerCase());
console.log("abcXYZ".toUpperCase(), "abcXYZ".toLowerCase(), "日本語".toUpperCase());
console.log("ǰ".toUpperCase(), "ᾀ".toUpperCase(), "ﬄ".toUpperCase());
