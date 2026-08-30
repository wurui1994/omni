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

// 第六十六刀那一批：base 与 examples 里真读到、而这里还缺的那些。类型与默认值逐个照
// settings.cc 抄（行号在后面），一个都没猜：
//   boolSetting:  keep(1759,false) keepaux(1760,false) auto3D(1770,true)
//                 embed(1769,true) loop(1773,false) interrupt(1774,false)
//                 animating(1775,false) reverse(1776,false) toolbar(1666,true)
//                 twosided(1693,true) thick(1725,true) autobillboard(1729,true)
//                 ibl(1670,false) nothin（settings.cc 里没有这个名字 —— 它是
//                 examples/RiemannSurface.asy:5 注释里的写法，thin 的反面，默认 false）
//   IntSetting:   digits(1911,7)
//   realSetting:  paperwidth(1914,0) paperheight(1915,0) prerender(1787,0)
//   stringSetting: image(1672,"snowyField")
//                  hyperrefOptions(1928,"setpagesize=false,unicode,pdfborder=0 0 0")
bool keep = false;
bool keepaux = false;
bool auto3D = true;
bool embed = true;
bool loop = false;
bool interrupt = false;
bool animating = false;
bool reverse = false;
bool toolbar = true;
bool twosided = true;
bool thick = true;
bool autobillboard = true;
bool ibl = false;
bool nothin = false;
int digits = 7;
// 纸张那一格不是 0：settings.cc:2101-2118 的 SetPageDimensions() 在启动时就按
// papertype 把它填好了 —— "letter" → 8.5*inches / 11.0*inches，否则按 a4 算
// 21.0*cm / 29.7*cm。默认 papertype 是 "letter"，所以量出来是 612 / 792。
// （量法：写个只 write(settings.paperwidth/paperheight/papertype) 的例子跑 asy -noV，
//  输出 612 / 792 / letter。clockarray.asy:7-9 用这两格算格子宽高，为 0 就 abort。）
string papertype = "letter";
real paperwidth = 612;
real paperheight = 792;
real prerender = 0;
string image = "snowyField";
string hyperrefOptions = "setpagesize=false,unicode,pdfborder=0 0 0";
