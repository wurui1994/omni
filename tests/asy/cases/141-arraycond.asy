// `bool[] ? T[] : T[]` 是**逐格选**（runarray.in:1222 的 arrayConditional）：
// 两支都在时回一格一样长的；有一支是 null 时那一格不要，回筛出来的那些 ——
// math.asy:160 的 `(b != n) ? sequence(1,b.length) : null` 正是拿它当"取下标"用。
bool[] c={true,false,true};
int[] a={1,2,3};
int[] b={10,20,30};
write(c?a:b);
write(c?a:null);
write(c?null:b);

real[] x={1.5,2.5};
real[] y={9.5,8.5};
bool[] d={false,true};
write(d?x:y);

string[] s={"a","b"};
string[] t={"A","B"};
write(d?s:t);

// 条件全真 / 全假，与筛出空的那一格
bool[] all3={true,true,true};
write(all3?a:null);
bool[] no3={false,false,false};
write(no3?a:null);

// 与逐格比较接起来用：挑出两边不同的那些下标（math.asy 的 segmentlimits 那一形态）
bool[] p={true,false,true,true};
bool[] q={true,true,true,false};
write((p!=q)?sequence(1,4):null);
