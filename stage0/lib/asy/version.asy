// asy 的 `version` —— 与 settings 同理，真 asy 那边是 C++ 模块（`AsymptoteVersion`）。
// `base/plain.asy` 只读一个字段：
//
//   access version;
//   if(version.VERSION != VERSION) { warning(…"using possibly incompatible version"…); }
//
// 也就是"引进来的 base 与运行时是不是同一代"。填的是**内建面那一格 VERSION 的同一个值**
// （asy_builtins.asy 里那句 `string VERSION = "3.14git"`），于是引参考树那份 base 时那句
// if 走 false 分支、不发警告 —— 参考树本身就是这一代。两边不同代时照旧会警告，那正是
// 这一段想说的话，所以不把它写成常真。
string VERSION = "3.14git";
