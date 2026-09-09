// String.prototype.normalize（规范 22.1.3.15）。从前整格缺失，"a\u0301".normalize() 在运行期
// 报 "undefined is not a function" —— 落在成员表外的兜底上，那句话既没说是哪个成员，
// 也没说是"这一格还没有"。
// 形态名缺席时是 NFC，不在四个里是能 catch 的 RangeError（消息跟 qjs：bad normalization form）。
// 这一格是 JS-only（P1_JS_ONLY）：NFC/NFD 要 Unicode 的分解与组合表，C 侧没有，所以 C 那条腿
// 在发射期整格拒，不会悄悄给个没规范化的串。
const r = [];
const t = (l, f) => { try { r.push(l + "=" + String(f())); } catch (e) { r.push(l + "!" + e.name + ": " + e.message); } };
t("nfc", () => "a\u0301".normalize("NFC").length);
t("default", () => "a\u0301".normalize().length);
t("nfd", () => "\u00e1".normalize("NFD").length);
t("nfkc", () => "\uFB01".normalize("NFKC"));
t("nfkd", () => "\u2460".normalize("NFKD"));
t("idem", () => "abc".normalize("NFC"));
t("bad", () => "a".normalize("NFX"));
t("num", () => "a".normalize(1));
t("eq", () => "\u00e1" === "a\u0301");
t("eq-norm", () => "\u00e1".normalize("NFC") === "a\u0301".normalize("NFC"));
console.log(r.join("\n"));
