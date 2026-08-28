// asy 的 `settings` —— 真 asy 那边它是**C++ 模块**（`settings.cc` 里 `addOption(new
// …Setting(…))` 那一串，`access settings;` 拿到的是那些选项的当前值）。我们这一侧照
// 「C++ 那一面自己做、`base/*.asy` 引真的」这条界（ADR-0014）用 asy 写出来：
// 它就是一批模块级变量，类型逐个照 settings.cc 抄，默认值照 asy 命令行的默认档。
//
// 只放 `base/plain*.asy` 真的读到的那些（量出来的：`grep -oh "settings\.[A-Za-z_]*"
// plain*.asy | sort | uniq -c`）。别的选项等哪个 base 文件真的要了再加 —— 猜一批没人读的
// 变量与没测过的 ABI 断言是一回事。
//
// 类型来源（settings.cc 的行号）：
//   stringSetting: outformat(1657) autoimport(1880)   userSetting: command(1882) user(1884)
//   engineSetting: tex(1762)                          realSetting: render(1675)
//   pairSetting:   viewportmargin(1714)               incrementSetting: verbose(1753)
//   boolSetting:   prc(1662) v3d(1664) thin(1727) twice(1766) inlinetex(1768)
//                  inlineimage(1778) batchView(1649) multipleView(1651)
//                  interactiveView(1654)
//   boolrefSetting: bw(1804) gray(1806) xasy(1839)

string outformat = "";
string autoimport = "";
string command = "";
string user = "";
// TeX 引擎的默认档：settings.cc 的 engineSetting 默认 "latex"
string tex = "latex";

// 3D 渲染的分辨率倍数。0 就是"不渲染"—— plain_shipout.asy 里
// `settings.render != 0` 是"要不要走 3D 那条路"的判据，所以这个 0 很要紧：
// 2D 那条路全靠它。真 asy 的默认是 -1（自动），但自动那一档要问显示设备，
// 我们这边还没有 OpenGL，所以先钉在 0。
real render = 0;
pair viewportmargin = (0, 0);
int verbose = 0;

bool prc = false;
// v3d 是那个新的三维格式（settings.cc:1664，默认关）。plain_shipout.asy:36/130 读它。
bool v3d = false;
bool thin = true;
bool twice = false;
bool inlinetex = false;
bool inlineimage = false;
bool batchView = false;
bool multipleView = false;
bool interactiveView = false;
bool bw = false;
bool gray = false;
bool xasy = false;
