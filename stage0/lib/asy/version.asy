// asy 的 `version` —— 与 settings 同理，真 asy 那边是 C++ 模块（`AsymptoteVersion`）。
// `base/plain.asy` 只读一个字段：
//
//   access version;
//   if(version.VERSION != VERSION) { warning(…"using possibly incompatible version"…); }
//
// 也就是"引进来的 base 与运行时是不是同一代"。我们照本机那份 asymptote 的版本填，
// 于是引真的 base 时那句 if 走 false 分支、不发警告。装的 base 换代了就会警告 ——
// 那正是这一段想说的话，所以不把它写成常真。
string VERSION = "3.05";
