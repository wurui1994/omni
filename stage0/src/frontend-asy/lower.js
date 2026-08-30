// Omni stage0 — asymptote 前端：asy 语法树 -> 核心 S 表达式方言（ADR-0014 第 2 道门槛）
//
// ## 为什么这里有一个手写的降级，而 tests/sexpr 那门玩具语言没有
//
// （那门语言的名字刻意不写在这里 —— tests/sexpr 那条轴的硬指标就是"编译器源码里不许出现
// 它的名字"，连注释也算。）
//
// 「加一门语言 = grammar + 映射标注」这句话管的是**语法**：asy.grammar 是从 camp.y 照原样
// 转写的，动作模板出来的树跟 camp.y 的 AST 一一对应（84 个真实模块全过，一份不落）。
// 但 asy 的**语义**不是语法能表达的：`1/3` 是实数除法而 `1#3` 是整数商、`3 == 3.0` 要把
// 左边提成 real、`write` 的分隔符规则取决于第一个实参是不是字符串 —— 每一条都要先知道
// 子表达式的类型。类型是符号表的事，模板里没有符号表。
//
// 所以这个文件只做**类型定向**的那一半，而且刻意只出核心方言的文本：出来的东西六条腿
// 都能跑（run / run-c / interp / interp --mir / run-llvm / build），中间没有为 asy 写的
// 第二份降级。语法那一半仍然一行代码都没有。
//
// ## 第一刀的边界（都是**刻意**的，不是漏的）
//
// 支持：int / real / bool / string 四种标量、变量与赋值、`+ - * / # % ^` 与比较、
// `&& ||`、一元 `- !`、前缀 `++ --` 与 `+= -= *= /=`、`?:`、if/else、while、do-while、
// C 式 for、break/continue、函数（含递归）、`(int)`/`(real)` 强制转换、`write`
// （含 real 的 %.15g —— 核心方言的 `(tostr E N)` 就是为它加的）、内建数学函数
// sqrt/fabs/abs/floor/ceil/round/fmod（核心方言的 `(rmath …)`）、
// **一维数组**：`T[] a`、`new T[n]`、`{…}` 与 `new T[] {…}`、`a[i]` 读写（写会扩长）、
// `a.length`、`a.push(v)`、`a.pop()`、数组当形参/返回值（引用语义，核心方言的 `(arr T)`）、
// **切片** `a[i:j]`/`a[i:]`/`a[:j]`/`a[:]`（是复制不是视图）、`write` 一整个数组
// （每行「下标 : TAB 值」，多个数组并排）、**for-each**（`for (T x : a)`，循环变量是复制，
// 迭代是活的）、
// **pair**：`(x,y)` 字面量、`+ - * /`（后两个是复数乘除）、一元 `-`、`== !=`、
// `z.x`/`z.y`/`xpart`/`ypart`、`abs`/`length`/`conj`、int/real 到 pair 的隐式转换、
// `(pair)` 强制转换、`write`（`(x,y)` 两个分量各 %.15g）、pair 当形参/返回值/`?:` 的两支、
// **`pair[]`**（第八刀：核心方言的 `(arr T)` 现在收 `(vec T N)` 元素，上面那一整套数组
// 操作 —— 下标读写、切片、`write` 整数组、for-each、当形参 —— 在 pair 上一条不少）、
// **字符串函数**：`length`、`substr`、`find`、`rfind`、`replace`、`erase`
// （核心方言为此加了 `(slen E)`/`(ssub E I N)`/`(sfind E T)` 三条 —— OIR 那边本来就有
// len/substr/indexOf 三个 Builtin，所以四条腿是白捡的，只有 LLVM 那条腿要三行 ABI）、
// **默认实参与命名实参**（第十刀：缺实参时按"缺了哪几个"生成一个包装函数，默认值在
// 包装里求 —— 量过 asy 的默认值是每次调用求一次、只在没给时求、而且能引用前面的形参）、
// **重载解析**（第十一刀：同名多份签名，按"同型优先、每次隐式转换算一分"挑最小的那个，
// 并列就是歧义；核心方言没有重载，所以第 2 个及以后的候选降级时改名成 `asy__ov<i>_<名>`。
// 候选表按**声明顺序**裁：asy 的名字解析是顺序的，见下面的差别一节）、
// **struct**（第十四刀：`struct A { int x; real y = 1.5; }`、`A a;`、`a.x` 读写、
// struct 当形参/返回值/`?:` 的两支、`== !=`。量过 asy 的 struct 是**引用类型** ——
// 赋值只搬句柄、改形参的字段外面看得见、`==` 比的是身份 —— 所以降成核心方言的
// `(class …)` 而不是 `(struct …)`：那一层的值语义只由 from_oir 里显式的 OP.COPY 给，
// class 不发 COPY，五条腿都是引用。`A a;` 隐式跑一遍 `operator init`（= `new A` 加上
// 字段默认值），默认值是**每次构造**求一次，所以有默认值的类型会生成一个
// `asy__new_<T>` 包装，`A a;` 降成对它的调用）、
// **pair 字段**（第十五刀：核心方言的类字段现在收 `(vec T N)`，而 pair 就是
// `(vec real 2)`。pair 上那一整套 —— 复数乘除、`+= *=`、`abs`/`conj`、`z.x`/`xpart`、
// `== !=`、当形参/返回值 —— 在字段上一条不少；`s.p.x` 这条三层的点也认了，
// 但**写**不认：pair 的分量在 asy 那边是只读的虚字段）、
// **数组字段**（第十六刀：`struct S { int[] xs; pair[] pts; }`。数组是引用语义，
// 所以复制 struct 搬的是句柄 —— 量过 `S b = a; b.xs.push(1000);` 之后 `a.xs.length`
// 也变了。字段上那一整套数组操作 —— `push`/`pop`/`.length`/下标读写/复合赋值/切片/
// for-each/`write` 整条数组 —— 与裸数组同一条路，因为 `(fld …)` 出来的就是那个句柄）、
// **内嵌记录字段**（第十七刀：`struct A { int x; } struct B { A a; }`，`b.a.x` 读写、
// `a.b.c.d` 任意层。asy 给记录字段跑一遍 `operator init`（量过 `struct B { A a; }` 之后
// `b.a.y` 是 A 的字段默认值，不是空引用），所以有记录字段的类型一定走生成的构造函数，
// 里面把内嵌对象一个个造出来。字段类型只收**前面已经声明过**的记录 —— 自引用在门外，
// 见下面的差别一节）。
// **`A[]`**（第十九刀：asy 的 struct 是引用类型，所以 `A[]` 就是"一串句柄" ——
// 核心方言的 `(arr T)` 这一刀收下了类元素，格子里躺的是句柄，存进去一句拷都不用发。
// 裸数组那一整套 —— `push`/`pop`/`.length`/下标读写/写下标扩长/切片/for-each/当形参与
// 返回值 —— 在 `A[]` 上一条不少；量过的三条都对上了：句柄进数组不拷、同一个对象进两格
// 改一次两处都变、切片复制的是**数组**而不是对象（格子里还是同一批句柄））。
// **方法**（第二十刀：`struct P { int x; int get() { return x + 10; } }`、`a.get()`。
// 降级是**加糖**：每个方法出一个 `asy__m_<记录>_<名>` 的普通函数，头上多一个 `this`
// 形参，`a.get()` 就是 `(call asy__m_P_get (var a))`。方法体里的裸名字先找局部量与
// 形参，再找**前面声明的**字段（`x` -> `(fld (var this) x)`），`this.x` 与 `this`
// 本身也认，返回 `this` 能接着点下去。重载、默认实参、递归在方法上与普通函数走的是
// 同一条路（同一个 userCall / defWrapper，只是多塞一个接收者）。接收者可以是任意
// 表达式：`mk(7).get()`、`ps[1].bump(30)`、`bx.inner.get()` 都通）。
// **构造函数**（第二十一刀：`struct A { int x; void operator init(int n) { x = n; } }`、
// `A(3)`。降成两层：正文还是那个多带一个 `this` 的 void 方法（`asy__ctor_A_body`），
// 外面套一层 `asy__ctor_A` —— 造对象、调正文、回对象。重载、默认实参、命名实参照旧白捡，
// 因为候选长得就像"回记录、没有接收者的普通函数"。量过的三条都对上了：字段默认值在体
// **之前**就铺好、默认实参能引用字段（所以它是在对象造好之后求的，defWrapper 为此有一条
// 构造分支）、而 `A a;` **不**走构造函数）。
// **文件级的 `T operator init()`**（第二十二刀：它换掉 `T t;` 的隐式构造。降级就是
// "多问一句"：recInit 先问此处可见的那份（顺序解析，两份就各管后面那一段），没有才走
// recNew。分界是量出来的 —— `A a;` 与**内嵌记录字段**走 operator init，而 `new A` 与
// 构造调用 `A(…)` 走原来那份字段默认值（所以 operator init 的体里写 `new A` 不递归）；
// 内嵌字段那一格按**那个 struct 声明处**的可见性定，不是按用它的地方）。
// **算符重载**（第二十三刀：`V operator +(V a, V b)`、`bool operator <(V,V)`。降级就是
// 改个名 —— `operator +` 出一个叫 `asy__op_add` 的普通函数，于是重载解析、默认实参、
// 命名实参、顺序裁候选全是第十、十一刀的东西，一行新逻辑都不用。量出来的三条钉在
// cases/25-opover.asy 与 26-opbuiltin.asy 里：① 用户算符跟**内建的在同一张候选表里**，
// 签名与内建那份**逐个相同**时是**替换**（写了 `int operator +(int,int){return a*b;}`
// 之后 `2 + 3` 印 6，而 `2 + 1.5` 还是走内建的 real 那份印 3.5）；② asy **不派生** ——
// 定义 `==` 不白得 `!=`，定义 `<` 不白得 `<=`；③ 一元 `- !`、复合赋值 `+= -= *= /=`
// （摊成 `a = a + b`，所以自动落到用户那份）、以及 `--`（那是 guide 的连接产生式，
// 内建的要等绘图层，但自己定义一份是通的）都走同一张表）。
// **文件级变量**（第二十四刀：`int counter = 7;` 之后**函数里**读得到、改得到 ——
// 核心方言这一刀加了 `(global 名字 类型)`，asy 的那份声明降成「一个全局 + 原地一句
// `(set …)`」，于是"初值在它那一行求"这条语义是照搬的而不是模拟的。顺序解析照旧：
// 函数体只看得见前面声明的那些（strict/global-fwd 钉着 —— asy 自己也拒）；局部量与
// 形参是**遮蔽**；同名再声明一次就是另一个变量，所以每份声明各出一个符号
// `asy__g<序号>_<名字>`。只收 int/real/bool/string —— pair/记录/数组照旧当
// `(main …)` 的局部量，函数里看不见，bad/global-pair 钉着那条边界）。
//
// **模块**（第二十五刀：`import m;`、`access m;`、`access m as mm;`、`from m access f;`。
// 一份 .asy 文件是一个**单元**，符号名带单元前缀（主文件那份不带 —— 于是不含 import 的
// 程序降出来的文本一字不变）；模块的顶层语句成为一个 `asy__init<k>`，调用点就在 import
// 那一行，外加一个 `asy__ran<k>` 门闩管"只跑一遍"。名字是**并表**并进来的（可见位置 =
// 那条 import 的下标），于是顺序解析、本地声明遮蔽、以及 import 的传递性都是白捡的。
// 量过的五条钉在 cases/28-import.asy 里：体在那一行跑、两次 import 只跑一遍、裸名字与
// `m.x` 是同一块存储、传递性、`access` 只给限定名（strict/mod-access-bare 钉着裸用要拒）。
// 找模块是按**当前目录**找的，也是量出来的（`asy -noV sub/user.asy` 里的 `import mm;`
// 找不到 sub/mm.asy）。门外：标准库那 84 个模块、`unravel`、`include`、参数化模块、
// `from m access *`、带点的模块名（我们的语法表里 stridpair 只有单个 ID 或字符串）、
// 两个模块里同名的 struct、给别的模块的 struct 写文件级 `operator init`）。
// 限定名当赋值目标（`m.x = …`）第四十七刀补上了，见 assign 里那一档。
//
// **`explicit` 形参**（第二十六刀：`void p(explicit real r)` 这个槽只收类型一模一样的
// 实参 —— 量过它连内建的 int->real 提升都挡，而且**不进签名身份**（同签名的第二份还是
// 替换）。降级要做的只有两件：formals 记个标记、fit 多问一句）。
// **用户定义的转换**（第二十七刀：`T operator cast(S)` 管所有隐式位置、`operator ecast`
// 只管 `(T) x`。它原来在门外，理由是会改**重载解析的打分**；量清了才收：跟内建提升
// **同价**（打平就是 ambiguous）、而且**不串**（源类型必须一模一样），见 castSig）。
// **`autounravel`**（第二十八刀：struct 体里带它的声明其实是**文件级**的声明 ——
// 形参显式、没有 this，可见位置是那个 struct 的位置，见 auMod。第三十四刀补上**变量**：
// `autounravel T n = …` 与 `static` 只差"名字在文件级也裸着可见"这一条，见 staticDec）。
// **函数类型**（`real f(real)` 这种形参、`f(v)` 的间接调用、裸函数名当值用、
// 以及函数值类型的**变量**（`real f(real) = twice;` 与 typedef 拼的那一份走同一条路）——
// 类型全是字符串，所以它就是 `R(P,…)` 那个拼法，见 asyIsFn / fnTypeOf / fnValCall）。
// **匿名函数**（`new int(int x){…}` -> 顶层的 `(cfn …)` 加用处上的 `(mkclo …)`，捕获边降边
// 收，见 anonFn / capOf。捕获按**值**抓，而 asy 是按引用的 —— 所以那个外层名字在这个闭包
// **之后**还被赋值时这一刀拒（改在闭包之前的两种语义同一个结果，见 assignsAfter）；
// 抓函数值可以（`(cap d)` 就是一格 `(fnty …)`），抓 `this` 与裸字段名还在门外。
// **typedef 与 `using`**（别名表 tyAlias：名字 -> 一串 {t, at}，`t` 是已经解析好的类型
// 字符串，type() 一查就换掉 —— asy 的 typedef 不造新类型，所以"换掉"就是全部语义。
// 存一串是因为同一个名字可以 typedef 多次，而名字解析是顺序的，见 aliasAt）。
//
// 不支持（见到就报错，报错里说清是哪一条）：标准库模块（`import graph;`）、
// 给切片赋值（`a[0:2] = b`）、
// 字符串的 `reverse`（asy 是**按字节**倒的，而 Omni 的 string 是 UTF-8 字节序列
// （ADR-0005）—— 非 ASCII 倒过来在 C 那条腿上是一串坏字节，在 JS 那条腿上要看
// 宿主怎么处理，"六条腿逐字节相同"这句话就保不住了，所以门外）、
// 字符串的 `insert`/`split`（`insert` 要的 `substr` 拼接现成，但 asy 的越界行为
// 还没量全；`split` 要 `string[]` 的返回值，那条路还没走通）、
// struct 的这两条边界（每条都有 bad/ 用例钉着）：**自引用**字段
// （`struct A { A next; }` —— asy 收，我们不收，见下面的差别一节）、
// `operator init` 的另两种形态（**带形参**的文件级那份 —— asy 收这个声明，但它不是隐式
// 转换，量不出能拿它干什么就不猜；以及 struct 体里**非 void** 的那份 —— asy 自己也不给
// 它构造调用）、
// struct **体里**的算符（`struct V { int operator +(V o) {…} }` —— asy 收这个声明，
// 但量过它**不参与** `a + b`（那边照旧报 "no matching function 'operator +(V, V)'"），
// 所以收它得先量清"那份成员算符到底能被什么调到"，不猜。文件级的那份是通的）。
//
// ## 与真 asy 的差别，写在这里而不是等着被发现
//
// - 整数溢出：asy 是运行期报错（量过：`2^62 * 4` -> "Integer overflow"），我们回绕。
// - `2^-1`：asy 报 "Only 1 and -1 can be raised to negative exponents as integers"，
//   我们的 helper 对负指数返回 0（`^` 那条 helper 里写着）。
// - `(0,0)^-1`：asy 走 pair 除法那条路，报运行期错误 "division by pair (0,0)"；我们照
//   pair 除法既有的那条偏差（下面"除以零"那条）出 IEEE 的 inf/nan，不报错。
// - **数组的未初始化格子**：asy 每个格子带一个"写过没有"的标记，`new int[2]` 之后读
//   `a[0]` 是运行期错误（量过："read uninitialized value from array at index 0"）；
//   我们填零值。写下标扩长时中间跳过的格子同理。这类程序本来就有 bug，但"我们给 0
//   而 asy 报错"必须写在明处。**记录元素**（第十九刀）上这一条稍好一点：`new A[2]` 的
//   格子是**空引用**，读它的字段撞的是判空诊断 —— 两边都报错，只是话不一样；而写下标
//   扩长跳过的格子我们填 `(cnew A)`（方言里写不出空引用），那才是"我们给值、asy 报错"。
// - 反过来的一条**已经对齐**了：后缀 `x++` asy 自己不收（"postfix expressions are not
//   allowed"），所以这一层也拒 —— 比 asy 多接受一门语言不会让任何用例变红，只会让
//   "等价"这两个字变虚。`tests/asy/strict/` 那一节专门盯这种漏洞。
// - 同一类的两条是第二十三刀补的（都在 strict/，都不带 ASY_NOPE）：记录上的**大小比较**
//   （只定义了 `operator <` 不白得 `<=` —— asy 报 "no matching function
//   'operator <=(V, V)'"，而我们先前 promote 回记录名就直接发 `(bin "<=" …)` 了）；
//   以及 `operator &&`/`operator ||` 的声明本身（量过 asy 那边是 **syntax error** ——
//   camp.y 的 operator 产生式里没有这两个 token）。
// - **除以零**：asy 是运行期报错，而且**实数除法也报**（量过：`1.0/0.0`、`(1,2)/0`、
//   `(1,2)/(0,0)`、`(1,2,3)/0` 全是运行期错误）；我们按 IEEE 出 inf/nan。这一条不是 pair
//   才有的，`/` 从第一刀起就这样，量到了就记在这里。
// - **切片的两条边界检查**：`a[3:1]` asy 报 "slice ends before it begins"，我们给空数组；
//   `a[-1:2]` asy 报 "invalid negative index in slice of non-cyclic array"，我们落到
//   `(aget …)` 的越界检查上（也是运行期错误，只是话不一样）。
// - **字符串函数的越界是"静静地失败"，不是钳位**——这一条量完才敢写，而且量出来的
//   跟直觉相反，所以 helper 是照量出来的写的，不是照"应该怎样"写的：
//   `substr("abc",-1,2)` 是 `""` 不是 `"ab"`（起点为负直接空串，不是从 0 算）；
//   `substr("abc",1,-1)` 也是 `""`（长度为负不当成"到末尾"）；起点越界同样是 `""`，
//   而长度过长是钳到末尾。`find("abc","b",-5)` 是 `-1` 不是 `1`（起点为负不当 0）；
//   起点等于长度时找空串给的是长度本身。`erase("abc",-1,2)` 原串不动。
//   `replace("aaa","aa","b")` 是 `"ba"`（从左往右不重叠地换），空针不换。
//   `length(int[])` 在 asy 那边是 "no matching function" —— length 只有 string 和
//   pair 两个重载，数组的长度写 `a.length`；这一条落在 `tests/asy/strict/` 里。
// - **asy 的名字解析是顺序的**，这一条也是**对齐过的**（而不是差别）：量过
//   `int a(int n) { return b(n)+1; } int b(int n){...}` 报 "no matching variable 'b'"，
//   `int rec(int n){ rec(n-1,2); } int rec(int,int)` 报 "cannot call 'int rec(int n)'
//   with parameters 'int, int'"。我们是两遍降级（先收签名再降体），天然会看见后面的
//   声明，所以候选表要按声明下标裁一刀（见 visible）—— 不裁就是"比 asy 多接受一门
//   语言"。等号是故意留的：一个函数看得见自己，单函数递归 asy 允许。
//   连带的一条：用户把 `sqrt` 定义在后面时，前面那句 `sqrt(...)` 走的还是内建的那个
//   （callExpr 里问的是"此处可见的候选"，不是"整个文件有没有同名函数"）。
// - **类型名也是顺序解析的**（第二十一刀顺手补上的一个漏，也是对齐的一条）：量过
//   `A a; write(a.x); struct A { int x = 3; }` 在 asy 那边报 "no type of name 'A'"，
//   而我们先前收下了 —— 记录是第一遍全收的，`type()` 只问"有没有这个名字"。现在按声明
//   下标裁（recHere），struct 体里则按**这个 struct 的位置**裁。这是"比 asy 多接受一门
//   语言"那类漏洞的一个真实样本：它不会让任何用例变红，`tests/asy/strict/struct-fwd`
//   才盯得住。
// - **struct 的这四条都是量出来的，也都对齐了**（第十四刀）：`A a; A b=a; b.x=1;` 之后
//   `a.x` 也变了（引用语义）、`void f(A p){p.x=9;}` 改得到外面的对象、`==`/`!=` 比的是
//   身份（量过 `a==b` false、`a==a` true、别名 true）、有默认值的字段每次构造都重求一遍
//   （量过：默认值里调函数，构造两次就印两次）。`write(a)` asy 自己不收
//   （"no matching function 'write(A)'"），所以 writeStmt 里有一条专门的拦截 ——
//   不拦的话漏出去的是核心方言那句 `(tostr E) 只接受 int / real / bool`，
//   拒得对但理由不对；`tests/asy/strict/write-struct` 钉着这一条。
// - **pair 的分量是只读的**（第十五刀量的，也是对齐的一条）：`z.x = 5` 与 `a.p.x = 5`
//   asy 都报 "virtual field is read-only"，所以 assign 里有一条专门的诊断 ——
//   读（`s.p.x`）认，写不认。`tests/asy/strict/pair-field-set` 钉着这一条。
// - **自引用字段：asy 收，我们不收**（第十七刀量的）：`struct A { A next; int x; } A a;
//   write(a.x);` 在 asy 那边印 0 退 0 —— 它的字段是懒的，`next` 搁着不造。我们的隐式
//   `operator init` 要把内嵌的记录**造出来**（不造就是空引用，而量过 asy 那边内嵌记录
//   的字段拿得到默认值），自引用于是无限递归，所以拦在字段类型那一关。这是"我们比 asy
//   少接受"的一条，`tests/asy/bad/struct-self` 钉着。
// - **`f(x).字段 = v` 认**（第十七刀顺出来的）：量过 asy 收，因为 struct 是引用类型，
//   函数返回的就是那个句柄。所以 assign 不再只认"普通变量的字段"，接收者可以是任意
//   表达式；复合赋值（`f(x).n += 1`）要先把接收者绑成临时量，免得调两次。
// - **struct 的成员遮住同名的文件级名字**（第二十刀量的，对齐的一条）：`int who()` 在
//   文件级、`int who()` 又在 struct 里，方法体里那句 `who()` 走的是**成员**那个
//   （量过：印 2 不是 1）。所以 call 里"裸名字"的查找顺序是局部量 -> 成员 -> 文件级/内建。
// - **struct 体内部的可见性也是顺序的**（第二十刀量的，也是对齐的一条）：方法看不见
//   它后面声明的字段与方法（量过：往前引用报 "no matching variable"）。文件级那一刀
//   裁的是声明下标（visible），这里裁的是**成员下标**（selfField / visibleMethods 里的
//   `mat`）—— 两处是同一个道理的两份实现，因为两张表本来就是分开的。
//   连带的一条：字段与方法同名时不算重载，谁在前面谁生效。
// - **`A a;` 与 `A(…)` 是两件不同的事**（第二十一刀量的，对齐的一条）：struct 体里的
//   `void operator init(…)` 只给**构造调用** `A(…)`，`A a;` 一概不走它（量过：体里赋
//   `x = 42` 之后 `A a; write(a.x)` 印的还是 0）。换掉 `A a;` 的是**文件级**的
//   `A operator init()`（第二十二刀收的，见 recInit）—— 同名的两个东西是两件事。
// - **构造函数里字段默认值先铺、默认实参后求**（第二十一刀量的）：`int z = 8;` 加体里
//   `z = z + 1` 出来是 9（默认值在体之前），而 `void operator init(int n = x)` 里的 `x`
//   是**字段**、拿到的是字段默认值（默认实参在对象造好之后才求）。后一条逼出 defWrapper
//   里那条构造分支：`this` 在包装里是本地量而不是形参，对象先造、默认值再求。
//
// ## 这一摊分在哪几个文件里
//
// 原来是一个 5400 行的文件，按"管什么"切成了八个（每个文件头上都写着它管哪一段）：
//
//   lower.js   入口、单元与 include、作用域、类型名（typedef 与 struct 体里的 using）、记录
//   exprs.js   表达式：分派、名字解析、匿名函数、隐式转换、内建面、算符
//   decls.js   顶层声明：函数与字段、operator init/cast、文件级变量、声明遍 + 正文遍
//   calls.js   调用与重载解析：实参、候选表、打分、方法与构造、默认实参的包装
//   stmts.js   语句：write、三种循环、变量声明、赋值那一整套
//   runtime.js 零值表、pair/字符串内建的名字表、六条腿共用的那份 helper 源码
//   modules.js 模块：import / access / unravel / from-access
//   types.js   类型层（类型在这一层就是**字符串**）
//
// 家族文件里的函数第一个形参都是 `L`，就是这个降级器（原来的 `this`）。为什么不是跨文件
// 的 extends 或 prototype mixin：这个文件在自举路径上，那两种写法在封闭子集里没有先例。
// 依赖是一条 DAG：decls -> modules -> calls、exprs -> stmts -> calls -> runtime -> types，
// lower.js 在最上面。反向那几条边（calls.js 要 expr、modules.js 要 declPass…）不走 import
// 而走类体里那 27 个一行的**转接方法** —— 自举那条路的加载器**禁止 import 成环**
// （frontend-js/link.js 报 "import cycle through"）。

import { isList, isAtom, isStr, head } from '../sexpr/read.js';
// 单元前缀按模块身份的哈希取（unitNew），所以这一层要这个哈希
import { hash16 } from '../host/hash.js';
import { asyIfaceDump } from './iface.js';
// 类型层（类型在这一层就是字符串）与运行时 helper 那两摊搬到隔壁去了 —— 这个文件只留
// 「要看符号表才能决定」的那一半。名字一个都没改：模块级名字全仓唯一是封闭 ABI 的要求。
import {
  ASY_NOPE, SCALARS, DOT_BAD, CAP_BAD, ASY_FILLER, ASY_MODSTM, ASY_ARRELEM, ASY_ARRELEM_TEXT,
  asyConvCost, asyOpText, ASY_OPSYM, ASY_OPBAD, ASY_CYCLE,
  asyIsArr, asyElem, asyMangle, asyIsFn, asyFnSplit, asyFldSym,
  ASY_PAIR_TY, ASY_TRIPLE_TY, asyCore,
} from './types.js';

import {
  ZERO, ASY_PAIRFN, ASY_STRFN, ASY_STR_DEPS, ASY_STR_NOPE, strLit, HELPERS, asyArrHelpers,
} from './runtime.js';

// 调用与重载解析那一族（第三摊）。它们带状态，所以第一个形参 `L` 就是这个降级器 ——
// 跨文件 extends 与 prototype mixin 在自举路径上都没有先例，普通函数调用有。
import {
  asyArgs, asyCall, asyBuiltinRaw, asyStrRaw, asyBuiltinOwns, asyBuiltinCost, asyVisible,
  asyMethodCall, asyCtorCall, asyUserCall, asyApplyCall, asyOpUser, asyOpBuiltinSig,
  asyFnValCall, asyCallArgs, asySigText, asyFit, asyDefWrapper, asyMathCall,
} from './calls.js';

// 语句那一族（第四摊）：write / 分派 / 三种循环 / 变量声明 / 赋值那一整套。同一条拆法。
import {
  asyWriteStmt, asyFmtStr, asyWriteArrays, asyStmt, asyStmtOne, asyDoWhile,
  asyForEach, asyForStmt, asyForPart, asyVardec, asyExprStmt,
  asyAssignStat, asyAssign, asyAssignFld, asyAssignIndex, asyBody,
} from './stmts.js';

// 表达式那一族（第五摊）。lower.js 里同时留了一层薄转接方法（见类体里"表达式"那一段）：
// calls.js / stmts.js 要调这一族，而 exprs.js 要调它们两个 —— 加载器禁止环，所以反向走转接。
import {
  asyExpr, asyLit, asyNameOf, asyOverPick, asyCandFnType, asyMValType, asyOverArg, asyAnonFn, asyCapOf,
  asyCapSlot,
  asyAssignsAfter, asyPromote, asyToPair, asyCoerce, asyCondAt, asyExprList, asyIndex, asySlice, asyDotQual,
  asyField, asyMember, asyPairLit, asyTripleLit, asyPairCall, asyVecPairFn, asyTripleDir,
  asyTunitOf, asyUnitOf, asyLengthCall, asyLengthOf, asyStrCall, asyStrConvCall, asyNewArray,
  asyArrLit, asyArrMethod, asyBinary, asyPairArith, asyTripleArith, asyCmpCode, asyCompare,
  asyCond, asyLogic, asyUnary, asyCast, asyCloFrom, asyNeedsBox,
} from './exprs.js';

// 模块那一族（第六摊）与顶层声明那一族（第七摊）。同样在类体里留了一层转接方法。
import {
  asyIdPair, asyModLoad, asyCandAt, asyModMerge, asyModStmt, asyModCallAt,
  asyModAlias, asyModVar, asyModCall, asyAutoPlain,
} from './modules.js';
import {
  asyUnwrapMod, asyAuMod, asyAuNames, asyStaticDec, asyStaticInit, asyStMod, asyOinitSig, asyOinitFor,
  asyCastSig, asyCastFor, asyFormals, asyFnTypeOf, asySig, asyMethodSig, asyMethod,
  asyGlobalNames, asyGvarHere, asyGvarAt, asyGvarFor, asyGvarLate, asyFunc, asyBuiltinsIn,
  asyDeclPass, asyBodyPass,
} from './decls.js';


class AsyLower {
  constructor(diags, opts) {
    this.diags = diags;
    // 模块（第二十五刀）。`opts` = `{path, load(名字) -> 树|null}` —— 文件 IO 与语法表
    // 都留在 cli.js，这里只管"给我这个模块的树"。null = 没人给加载器（那时 import 就报错）。
    this.opts = opts === undefined ? null : opts;
    // 内建函数的**绑定表**是驱动读进来的数据（builtins.tab）—— 数学不是 asy 的语法，
    // 它在 asy 自己那边也是 builtin.cc 里一张表。见 parseAsyBuiltins。
    this.math = this.opts !== null && this.opts.builtins !== undefined
      ? this.opts.builtins : new Map();
    // 一份 .asy 文件是一个**单元**。逐单元的表有 funcs / globals / oinits / oiByNode /
    // recVis / mods / at，降级时换进换出（unitIn / unitOut）；共享的是 records /
    // recInits / arrGen / used / wraps / gdecls —— 它们按已经全局唯一的名字存，
    // 发到模块层的文本只有一份。
    this.units = [];           // 单元（按加载顺序，0 号是主文件）
    this.byKey = new Map();    // 模块名 -> 单元（同一个模块只加载一次）
    this.unit = null;          // 当前单元
    this.pfx = '';             // 当前单元的符号前缀（主文件是空串，于是老输出一字不变）
    this.mods = new Map();     // 模块别名 -> {unit, at}（import 与 access 都进这张表）
    this.loading = [];         // 正在加载的模块名（认出循环 import）
    this.recVis = new Map();   // 这个单元**看得见**的记录名 -> {rec, at}
    // typedef 的别名（这个单元看得见的）：名字 -> 一串 {t, at}。`t` 是**已经解析好的**
    // asy 类型字符串，所以下游一律不知道 typedef 存在过 —— 这也是 asy 自己的语义（别名不是
    // 新类型，量过：`typedef int myint; int f(int){…} myint n=1; f(n)` 通得过）。
    // **一串**而不是一个，理由与文件级变量那张表一样：同一个名字可以 typedef 多次，
    // 而名字解析是顺序的（量过：`typedef int again; again a=1; typedef string again;`
    // 两句各按自己那一份算），所以用到的地方挑"此处可见的最后一份"。
    this.tyAlias = new Map();
    this.funcs = new Map();    // 名字 -> {ret, params: 类型名数组}
    // main 末尾要不要插"跑退出钩子"那一句。整份文件（run）插，REPL 的每一批不插 ——
    // 一批一批地跑时那一句会在**每批**末尾放一次隐式 shipout，与"程序跑完一次"不是一回事。
    this.tailExit = false;
    this.scopes = [];          // 名字 -> 类型名
    this.used = new Set();     // 用到的 helper
    // for 的更新片段栈。C 式 for 降成 while 之后，`continue` 必须**先跑更新**再跳 ——
    // 不这么做 `for(i=0;i<5;++i){if(i==2)continue;}` 就死循环。量过 asy 的行为：更新会跑。
    this.updates = [];
    // 当前语句的**前置语句**。核心方言里 `? :` 不是表达式，只能摊成临时量 + if/else，
    // 那两条 if/else 就攒在这里，由 stmt() 的外壳补在这条语句前面。
    // null = 不在语句上下文里（那时见到 `? :` 只能报错，不能悄悄丢）。
    this.pre = null;
    // 重降一句 `? :` 时用处那一侧给的**目标类型**（见 asyCondAt）：两支的公共签名多于
    // 一个时靠它定案。null = 没人给。
    this.condWant = null;
    // 函数**类型**上带的默认值：类型文本 -> {ps, types, at, unit}（见 asyFnTypeOf）。
    // 通过一格这种类型的函数值调用时少给的实参由它补（asyFnValDefWrap）。
    this.fnDefs = new Map();
    // 文件级变量（第二十四刀）：名字 -> 一串声明 {sym, type, at, ok}。
    // **一串**而不是一个，因为 asy 的名字解析是顺序的，而同一个名字可以在文件里声明
    // 多次（量过：`int a = 1; write(a); int a = 7; write(a);` 印 1 再印 7）——
    // 于是每份声明各出一个全局，用到的地方挑"此处可见的最后一份"。
    // `ok:false` 的那些是这一刀的全局量还收不下的类型（pair/记录/数组），
    // 留在表里只为让函数里那句错话说得清是哪一条。
    this.globals = new Map();
    // 按声明顺序攒起来的 `(global sym 类型)`，最后发到模块层
    this.gdecls = [];
    this.probeMsg = null;
    // 方法当值那一族的包装（第四十三刀）：方法符号 -> `(cfn …)` 的名字。一个方法一份。
    this.mvals = new Map();
    // 正在降级**文件级**的语句（`(main …)` 那一层）。vardec 要靠它分清
    // "这是个全局"还是"这是 main 里某个块的局部量"。
    this.fileLevel = false;
    // 默认实参的包装函数（第十刀）：`函数名|缺的槽号` -> 包装名，正文攒在 wraps 里，
    // 最后跟别的函数一起发到模块层。同一形状只生一份，顺序按第一次用到的顺序 ——
    // 同一份输入两次降出来的文本因此逐字节相同。
    this.wrapNames = new Map();
    // 每一项是 `{u, t}`：`u` 是这份包装**归哪个单元**（一个库文件一份产物，所以发出去的
    // 每一项都得能归到某个单元），`t` 是正文。`u === ASY_WEAK` 是"谁都可能生、名字只由
    // 内容决定"的那一档（内建数学包装、方法值包装、隐式构造），链接时按顶层名字去重。
    this.wraps = [];
    // 匿名函数（`new int(int x){…}`）：出来的 `(cfn …)` 也攒在 wraps 里。
    // 起名用的编号在**单元**上（unitNew 的 nsym），不在这里 —— 见 asyCloFrom。
    // 正在降级的那个匿名函数的捕获状态（null = 不在匿名函数里）。见 anonFn / capOf。
    this.cap = null;
    // 正在降级的那个**函数体**的 AST（匿名函数要拿它扫"这个外层名字会不会被改"）。
    this.fnBody = null;
    // 正在求初值的那个**文件级变量的名字**（null = 不在初值里）：那一格在自己的初值里
    // 还不可见（量过 asy 对 `int x = x + 1;` 报 "no matching variable 'x'"），而同一句里
    // 前面那几个声明子照样可见（`real a=1, b=a+1;` 印 2）—— 所以按名字挡，不按位置挡。
    this.selfHide = null;
    // 刚摊出去的那句赋值"怎么把写进去的那个值读回来"（见 assignIndex / 赋值当表达式那一档）：
    // `{ node, code, type }`，node 是那句赋值的节点 —— 里外套着好几层赋值时用它认人。
    this.avout = null;
    // 文件级的 `T operator init()`（第二十二刀）：记录名 -> 候选表（按声明顺序），
    // 外加节点 -> 候选表，好让 func() 认出"这份 fundec 是哪张表里的"。
    this.oinits = new Map();
    this.oiByNode = new Map();
    // 用户定义的转换（第二十七刀）：目标类型 -> 一串候选 {to, src, sym, at, ec}。
    // `ec` 是 `operator ecast`（只给 `(T) x` 用），`cast` 那份连隐式位置一起管。
    this.casts = new Map();
    this.castByNode = new Map();
    this.castNo = 0;
    // 现在降的是**第几个**顶层项。asy 的名字解析是顺序的（量过：函数体里引用后面
    // 才声明的名字是 "no matching variable"），所以候选表要按这个下标裁一刀。
    // 自己那条也算可见（`c.at <= this.at`）—— 单函数递归 asy 是允许的。
    this.at = 0;
    // REPL 的批与批之间，顶层项的下标要**接着往下数**：第 2 批的第 0 句在第 1 批的
    // 所有声明**之后**，所以 `at` 是 `atOff + i`。不这样做，第 1 批声明的记录/函数
    // 在第 2 批看起来就成了"声明在后面"，顺序可见性会整批失效。整程序降级时它一直是 0。
    this.atOff = 0;
    /** REPL：这个降级器在跑一个**会话**（一批一批来），不是一份文件 */
    this.sessionRoot = false;
    /** @type {Map|null} 会话根的文件级作用域：跨批留住（第 1 批的 `real[] xs` 第 2 批还在） */
    this.fileScope = null;

    // 记录（asy 的 struct）：名字 -> {name, fields:[{name,type,def}]}。
    // **asy 的 struct 是引用语义的**（量过：`A b = a; b.x = 7;` 之后 `a.x` 是 7，
    // `void f(A q){q.x=99;} f(a);` 之后 `a.x` 是 99），所以它降成核心方言的 **class**，
    // 不是 struct —— 降成值语义的那个会在"改了副本还是改了本体"上静静给错答案。
    this.records = new Map();
    // 有默认值的字段要一个构造函数（`new A` 每次都重新求那些默认值：量过
    // `struct B { int n = bump(); }` 之后 `new B` 两次，计数器是 2）。
    // 名字 -> 构造函数名；正文攒在 wraps 里，和默认实参的包装一起发。
    this.recInits = new Map();
    // 元素是记录的数组 helper（grow / slice / slicefrom）：五种标量那三份是模块级的静态
    // 文本（HELPERS），记录是**逐类型**的，所以按同一个模板在这里生成，名字 -> 正文。
    this.arrGen = new Map();
    // 正在降的是哪个记录的方法（第二十刀）：`{rec, mat}`，mat = 那个方法在成员表里的下标。
    // 方法体里的裸名字要按 asy 的顺序解析找**前面**的字段与方法（量过：用后面声明的字段
    // 报 "no matching variable"），而字段名要降成 `(fld (var this) f)`。
    this.self = null;
    // struct 体里的 `using` 起的别名：`{map, mat}`，null = 不在任何 struct 体里。
    // 单开一张表是因为这种别名**不漏出去** —— 量过 struct 外面 `fn2 g;` 报
    // "no type of name 'fn2'"；而且同名的字段可以并存（`fill2 fill2;`，
    // plain_filldraw.asy:93 就是这么写的），asy 的类型名与变量名是两个名字空间。
    this.recAlias = null;
    // 方法声明表：`{rec, cand, at}`，第二遍按这个顺序发方法正文。方法降成一个多带一个
    // `this` 形参的普通函数（`asy__m_<记录>_<方法>`）—— 核心方言没有方法，而 asy 的方法
    // 本质上就是这个：量过 `A b = a; b.bump(1);` 改的是同一个对象（struct 是引用类型），
    // 所以传句柄就够。
    this.methodDecls = [];
    // struct 体里带 `autounravel` 的那些声明（第二十八刀）：它们其实是**文件级**函数，
    // 正文在这里攒着，第二遍跟文件级函数一起发。
    this.auFns = [];
  }

  /* ------------------------------------------------------------------ 单元 */

  /**
   * 新开一个单元（第二十五刀）。`key` 是模块名（主文件是它的路径，只用来报错）。
   * 前缀：主文件是空串 —— 于是**不带 import 的程序降出来的文本一字不变**，
   * 老用例的 .expected 与逐字节重编译都不受这一刀影响。
   */
  /**
   * `include m;` / `include "m";` —— **文本级**的引入，不是模块：那个文件的顶层项就摆在
   * 这一行的位置上，名字直接落进当前单元，体也在这里跑（asy 的 include 就是这个意思，
   * base/plain.asy 那一串 `include plain_pens;` 全靠它）。
   *
   * 所以它在**收表之前**就摊平：`rs` 是一个平坦的顶层项数组，下标就是"可见位置"，
   * 摊平之后后面那几遍（declPass / bodyPass / 顺序解析）一个字都不用改。
   * 循环 include 靠深度兜住 —— 真 asy 那边也是重复 include 就再摊一遍。
   */
  expandIncludes(rs, depth, inc) {
    let has = false;
    for (const r of rs) {
      const u = asyUnwrapMod(this, r);
      if (isList(u) && head(u) === 'include') has = true;
    }
    if (!has) return rs;
    const out = [];
    for (const r of rs) {
      const u = asyUnwrapMod(this, r);
      if (!isList(u) || head(u) !== 'include') { out.push(r); continue; }
      if (depth >= 32) {
        this.nope(u, 'include 套了 32 层以上（八成是自己 include 自己）');
        continue;
      }
      let nm = null;
      const a = u.items[1];
      if (isAtom(a)) nm = a.value;
      else if (isStr(a)) nm = a.value;
      if (nm === null) { this.nope(u, 'include 的这种写法'); continue; }
      if (nm.endsWith('.asy')) nm = nm.slice(0, nm.length - 4);
      if (this.opts === null || this.opts.load === undefined || this.opts.load === null) {
        this.nope(u, `include '${nm}'（这条路上没有模块加载器）`);
        continue;
      }
      const tree = this.opts.load(nm);
      if (tree === null || tree === undefined) {
        this.nope(u, `include '${nm}' 找不到 —— 当前目录与 ASYMPTOTE_DIR 里都没有 ${nm}.asy`);
        continue;
      }
      // 摊进来的那个**文件**要记在单元上（这一刀）：产物缓存的印记是「编译器 + 它自己那个
      // 源文件 + 它 import 的那几个源文件」，`include` 摊平之后正文来自别的文件，可那个文件
      // 一格都不在印记里 —— 改了 base/plain_picture.asy 而 plain.asy 没动时，`plain` 那份
      // 产物照旧算"还能用"，于是盘上那份**旧代码**被复用。量出来的样子：往
      // plain_picture.asy 的 `scale(frame,…)` 里加一句 write，OMNI_ASY_MODS=1 那一路
      // 印不出来（同一份探针在 stage0 那一路印得出来）—— 一整轮测量都建立在旧代码上。
      if (inc !== undefined && inc !== null && this.opts.pathOf !== undefined
          && this.opts.pathOf !== null) {
        const p = this.opts.pathOf(nm);
        if (typeof p === 'string' && p !== '' && !inc.includes(p)) inc.push(p);
      }
      for (const x of this.expandIncludes(this.flat(tree, 'block'), depth + 1, inc)) out.push(x);
    }
    return out;
  }

  /**
   * 一个新单元。`key` 是**模块身份**（模块名，模板实例还带实参），与加载顺序无关。
   *
   * 前缀按 key 的哈希取（第七十五刀）：以前是 `asy__m<第几个被加载的>_`，于是同一个
   * plain_pens.asy 在 `import graph` 的例子里与在 `import three` 的例子里编出来的符号名
   * **不一样** —— 那份编译结果就没法给另一个例子用。按身份取之后，一个库文件在哪个入口
   * 底下都是同一批名字，这是"一个库一份产物、按文件名增量"的前提。
   * `nsym` 是这个单元自己的编号计数器（文件级变量、局部函数、cast、包装那些用它）：
   * 以前用的是全程序的计数器，也是顺序依赖的一处。
   */
  unitNew(tree, key) {
    const id = this.units.length;
    const pfx = id === 0 ? '' : `asy__m${hash16(key).slice(0, 8)}_`;
    // `include` 摊进来的那几个**文件**（印记要它，见 expandIncludes 末尾那段注释）
    const inc = [];
    const u = {
      id,
      key,
      // 这个单元来自哪个真文件（模块那一路由 modules.js 从加载器那里填；主文件是 opts.path）。
      // 产物的增量按它判 —— key 只是模块身份，不是路径。
      file: '',
      rs: this.expandIncludes(this.flat(tree, 'block'), 0, inc),
      inc,
      pfx,
      nsym: 0,
      // 局部临时量的编号（`asy__va…`/`asy__c…`/`asy__bx…` 那些）。也是**每个单元自己**的：
      // 以前是全程序一个计数器，于是同一个库文件在不同入口底下编出来的临时量名字不一样。
      ntmp: 0,
      init: id === 0 ? null : `${pfx}init`, ran: id === 0 ? null : `${pfx}ran`,
      funcs: new Map(), globals: new Map(), oinits: new Map(), oiByNode: new Map(),
      casts: new Map(), castByNode: new Map(),
      recVis: new Map(), mods: new Map(), methodDecls: [], callAt: new Map(), at: 0,
      tyAlias: new Map(),
      // 模板模块的实参表（名字 -> 类型文本），普通单元是 null。它决定两件事：
      // `typedef import(…)` 那一句认不认，以及这个单元里的 struct 名要不要按 pfx 打散
      // （同一个模板两次实例化里的 `Box_T` 是**两个**类型 —— 量过，见 modules.js）。
      tpl: null,
      auFns: [], bi: null,
    };
    // 这个单元里**被当成成员赋过值**的那些名字（第六十二刀）：`X.name = …` 里的 name。
    // struct 体里"有体的方法"要不要摊成一格函数值字段，就看这一条（见 recordBody）。
    u.mset = this.memAssigned(u.rs);
    this.units.push(u);
    return u;
  }

  /**
   * 一格**没有正文**的单元（第七十八刀）：库的接口索引读回来时用它，或者某个库的名字
   * 经由别人传递过来、而它这一趟没人直接 import 时补的占位。
   *
   * 与 unitNew 的差别只有两处：`rs` 是空的（于是不走 expandIncludes、也不算 mset），
   * 以及 `frozen` 一开始就是 true —— 它的产物已经在盘上，正文永远不降。
   */
  unitStub(key) {
    const id = this.units.length;
    const pfx = id === 0 ? '' : `asy__m${hash16(key).slice(0, 8)}_`;
    const u = {
      id,
      key,
      file: '',
      rs: [],
      pfx,
      nsym: 0,
      ntmp: 0,
      init: id === 0 ? null : `${pfx}init`, ran: id === 0 ? null : `${pfx}ran`,
      funcs: new Map(), globals: new Map(), oinits: new Map(), oiByNode: new Map(),
      casts: new Map(), castByNode: new Map(),
      recVis: new Map(), mods: new Map(), methodDecls: [], callAt: new Map(), at: 0,
      tyAlias: new Map(),
      tpl: null,
      auFns: [], bi: null,
      mset: new Set(),
      frozen: true,
    };
    this.units.push(u);
    this.byKey.set(key, u);
    return u;
  }

  /**
   * 一棵树里所有 `X.name = …` 形状的**成员名**。
   *
   * 为什么要它：asy 那边方法就是一格函数值字段，所以 `TeXHead.defaultfilltype=…`
   * （plain_arrows.asy:162）是合法的 —— 而我们的方法是"多一个 this 形参的普通函数"，
   * 没有那一格可以写。全部方法都摊成字段的话，每个实例都要为每个方法装一个闭包
   * （picture 那种几十个成员的 struct 代价看得见），所以这一刀**只摊真被赋过值的那些**：
   * 名字对上就摊，对不上照旧是方法。跨单元赋值还接不住（那个 struct 已经降完了）——
   * 漏出去的还是 recField 那句 nope，base 里没有那种写法。
   */
  memAssigned(rs) {
    const out = new Set();
    const stack = [];
    const push = (n, inRec) => stack.push([n, inRec]);
    if (Array.isArray(rs)) for (const r of rs) push(r, false);
    else push(rs, false);
    while (stack.length > 0) {
      const [cur, inRec] = stack.pop();
      if (cur === undefined || cur === null || !isList(cur)) continue;
      const h = head(cur);
      // `recorddec` 的子树里再往下都算"在 struct 体里"（下面那一档要用）
      const nowRec = inRec || h === 'recorddec';
      if (h === 'assign') {
        const lhs = cur.items[1];
        // `X.name = …`（`(field X name)`）：`this.stepDependence=stepDependence;`
        // （ode.asy:34，在 RKTableau 的 `operator init` 体里）就是这一种。原来只认下面
        // `name-exp` + `qualified` 那一种（模块限定名 `m.x`），于是这一句漏掉了，
        // `stepDependence` 照旧是方法、那一句报"给方法赋值"（odetest 与 slope 停在这儿）。
        if (isList(lhs) && head(lhs) === 'field' && isAtom(lhs.items[2])) {
          out.add(lhs.items[2].value);
        }
        if (isList(lhs) && head(lhs) === 'name-exp') {
          const q = lhs.items[1];
          if (isList(q) && head(q) === 'qualified' && isAtom(q.items[2])) {
            out.add(q.items[2].value);
          } else if (nowRec) {
            // struct 体里给**裸名字**赋值（第六十六刀）：那也可能是"给自己的成员赋值" ——
            // three_surface.asy:261 的 `external=externaltriangular;` 就在 patch 的
            // `void init()` 里，而 `external` 是同一个体里**有体的方法**（:28）。
            // 只在 struct 体里认这一种：整个单元都认的话，随便一个同名的局部量赋值
            // 都会把一个方法摊成字段（每个实例多一个闭包）。
            const nm = isAtom(q) ? q.value
              : (isList(q) && head(q) === 'name' && isAtom(q.items[1]) ? q.items[1].value : null);
            if (nm !== null) out.add(nm);
          }
        }
      }
      for (let i = 1; i < cur.items.length; i++) push(cur.items[i], nowRec);
    }
    return out;
  }

  /**
   * 模块级的生成名（匿名函数 `asy__anon…`、局部函数 `asy__lf…`）。
   *
   * 正文被跳过的那个单元（`frozen`，见 chunk 里的 skipBody）**不能再用它的计数器**：
   * 那个编号只有"整份正文都降一遍"时才是确定的。跳过之后，替它生的那几段
   * （默认实参那一段里的匿名函数 —— 降它时 L.unit 换成了被调方）会占到盘上那份产物里
   * 已经用过的号，于是两段不同的代码撞成同一个名字。量出来的样子是 filesurface（graph3
   * 那一路）报 `捕获 'asy__self' 要 …_picture，这里是 Label`。
   * 所以 frozen 的单元按**位置**取名：同一个源文件里位置唯一，与降级顺序无关。
   */
  genSym(tag, n) {
    if (this.unit.frozen !== true) return `${this.pfx}asy__${tag}${this.unit.nsym++}`;
    const at = n === undefined || n === null || n.span === undefined || n.span === null
      ? '?' : n.span.start;
    return `${this.pfx}asy__${tag}_${hash16(`${this.unit.key}|${tag}|${at}`).slice(0, 8)}`;
  }

  /** 当前那几张表存回单元 `u`（表本身是同一个对象，真要存的只有 at） */  unitSave(u) {
    u.funcs = this.funcs;
    u.globals = this.globals;
    u.oinits = this.oinits;
    u.oiByNode = this.oiByNode;
    u.casts = this.casts;
    u.castByNode = this.castByNode;
    u.recVis = this.recVis;
    u.tyAlias = this.tyAlias;
    u.mods = this.mods;
    u.methodDecls = this.methodDecls;
    u.auFns = this.auFns;
    u.at = this.at;
  }

  /** 换到单元 `u`，回"原来那个"（配 unitOut 用，与 defWrapper 那套保存/还原同一个路子） */
  unitIn(u) {
    const prev = this.unit;
    if (prev !== null) this.unitSave(prev);
    this.unit = u;
    this.funcs = u.funcs;
    this.globals = u.globals;
    this.oinits = u.oinits;
    this.oiByNode = u.oiByNode;
    this.casts = u.casts;
    this.castByNode = u.castByNode;
    this.recVis = u.recVis;
    this.tyAlias = u.tyAlias;
    this.mods = u.mods;
    this.methodDecls = u.methodDecls;
    this.auFns = u.auFns;
    this.pfx = u.pfx;
    this.at = u.at;
    return prev;
  }

  unitOut(prev) {
    this.unitSave(this.unit);
    if (prev !== null) this.unitIn(prev);
  }

  /**
   * 方法体里的裸名字 `nm` 是不是**此处可见的字段**（局部量/形参优先，量过：形参 `x`
   * 遮住字段 `x`，要拿字段得写 `this.x`）。回字段项或 null。
   *
   * `shadowed` 为真时**不看**局部量那一格：同名的局部量是**函数类型**时它遮不住字段 ——
   * 量过 `struct S { int x; void go() { real x(int a){…} x=5; } }` 里那句 `x=5` 赋的是
   * 字段（写 `string x="a";` 就报 "cannot convert 'int' to 'string' in assignment"，
   * 不是函数的那一格真的遮住了）。只有赋值那一侧按签名挑格时才该传它。
   */
  selfField(nm, wantFn, shadowed) {
    if (this.self === null) return null;
    // static 的方法体里实例字段**不可见**（量过 asy 报 "static use of dynamic variable"）。
    // 这里回 null，那句诊断由调用处发（说清是"静态的地方用了实例的东西"，见 selfStatBad）。
    if (this.self.stat === true) return null;
    if (shadowed !== true && this.lookup(nm) !== null) return null;
    if (nm === ASY_FILLER) return null;   // 占位字段看不见，方法体里也一样（见 recField）
    // 同名两格字段（第四十九刀）：这里也照 recField 的规矩 —— 取值挑**不是函数类型**那份，
    // `wantFn` 为真（调用形态，见 calls.js 里那一档）时反过来挑函数那份。
    let alt = null;
    for (const f of this.self.rec.fields) {
      if (!this.fldIs(f, nm) || f.mat >= this.self.mat) continue;
      if (asyIsFn(f.type) === (wantFn === true)) return f;
      if (alt === null) alt = f;
    }
    return alt;
  }

  /**
   * 上面那条的**多格**形（第七十一刀）：源码里叫 nm、此处可见、而且是函数类型的**全部**
   * 字段格。重载的方法各摊一格之后一个名字能有好几格 —— plain_picture.asy 里 `min`
   * 就有 `pair(transform)` 与 `triple(real[][])` 两格，调用形态得逐格试
   * （只认第一格时 :852 的 `min(calculateTransform3(…))` 报"没有能匹配 min(real[][])"）。
   */
  selfFieldsFn(nm) {
    const out = [];
    if (this.self === null || this.self.stat === true) return out;
    // 局部量遮住字段这件事只在**它自己也能被调**的时候算：asy 的作用域是按签名分层的，
    // 一格不是函数类型的同名局部量遮不住那格函数字段。量出来的形状是 plain_Label.asy:119
    // 的 `void align(align align, align default) { align(align); … }`——形参 `align` 是
    // 一格 `align` 类型的值，而这一句要的是同名那格 `void(align)` 的字段。
    const lv = this.lookup(nm);
    if (lv !== null && asyIsFn(lv)) return out;
    if (nm === ASY_FILLER) return out;
    for (const f of this.self.rec.fields) {
      if (!this.fldIs(f, nm) || f.mat >= this.self.mat) continue;
      if (asyIsFn(f.type)) out.push(f);
    }
    return out;
  }

  /** 记录 `rec` 上此处可见的方法候选（方法体里按成员顺序裁，外面看全部）。
   *  候选表按**声明这个记录的那个单元**查：asy 的 struct 与它的方法是一起导出的
   *  （量过：`import m;` 之后 m 里的 struct 连方法带构造函数都能用），
   *  所以 import 的时候不用把 `记录名.方法名` 那些 key 搬一遍。 */
  visibleMethods(rec, nm) {
    const key = `${rec.name}.${nm}`;
    const funcs = this.units[rec.unit].funcs;
    const out = [];
    if (!funcs.has(key)) return out;
    // 刻意不用 `Infinity` 当"不裁"的上界：它不在封闭 ABI 的数值词汇里（同 glr/driver.js）。
    const inSelf = this.self !== null && this.self.rec === rec;
    // static 的方法体里只看得见 static 的方法（量过实例方法在那儿报
    // "static use of dynamic variable"）
    const statOnly = inSelf && this.self.stat === true;
    for (const c of funcs.get(key)) {
      if (statOnly && c.stat !== true) continue;
      if (!inSelf || c.mat <= this.self.mat) out.push(c);
    }
    return out;
  }

  /** static 的地方用了实例的东西：asy 自己也拒（量过 "static use of dynamic variable"，退 1），
   *  所以是 err 不是 nope。这一句由调用处在"名字查不着"之后问一遍。 */
  selfStatBad(node, nm) {
    // struct 体里**不带 static** 的算符重载（第四十刀）：asy 那边它读得着实例成员
    // （量过印 16），也就是绑住了接收者 —— 那要闭包，还在门外。所以这一条是 nope 不是 err。
    if (this.self.opNonStat === true) {
      return this.nope(node, `struct ${this.self.rec.name} 体里不带 static 的算符重载里用`
        + `实例成员 '${nm}'（asy 收 —— 那份算符绑住了接收者，我们的算符是没有接收者的函数）`);
    }
    return this.err(node, `'${nm}' 是 struct ${this.self.rec.name} 的实例成员，`
      + `static 的方法里没有接收者，用不了它（asy 那边报 "static use of dynamic variable"）`);
  }

  /** 这个名字是当前 struct 的**实例**成员吗（static 方法体里那句诊断要问它） */
  selfInstMember(nm) {
    if (this.self === null || this.self.stat !== true) return false;
    for (const f of this.self.rec.fields) if (this.fldIs(f, nm)) return true;
    const funcs = this.units[this.self.rec.unit].funcs;
    const list = funcs.get(`${this.self.rec.name}.${nm}`);
    if (list === undefined) return false;
    for (const c of list) if (c.stat !== true) return true;
    return false;
  }

  /**
   * 数组 helper 的名字：标量元素就是 HELPERS 里那份（标记用到），记录元素与**数组元素**
   * 按同一个工厂（asyArrHelpers）生一份 —— 三条一起生，因为 slicefrom 要调 slice。
   * 名字过 asyMangle：`asy__grow_real[]` 不是标识符，`asy__grow_arr_real` 才是。
   * 扩长填的是零值：记录填 `(cnew T)`、数组填一条**新的空行**（每次循环各求一次，不共用）。
   * 方言里写不出空引用，而 asy 那边那些格子是"未初始化"、读就报错，这一条与其他元素类型
   * 的零值填充是同一条差别（见文件头）。
   */
  arrHelper(kind, el) {
    const nm = `asy__${kind}_${asyMangle(el)}`;
    // 函数类型的元素也要现生一份（第六十九刀）：`void()[]` 在 graph 里真的有，而
    // HELPERS 那张表只有标量那几个。零值是**空引用** —— 函数类型写不出 `(cnew …)`。
    const gen = this.isRec(el) || asyIsArr(el) || asyIsFn(el);
    if (!gen) { this.used.add(nm); return nm; }
    if (!this.arrGen.has(nm)) {
      const zero = asyIsArr(el) ? `(anew ${asyCore(el)} (int 0))`
        : (asyIsFn(el) ? `(null ${asyCore(el)})` : `(cnew ${asyCore(el)})`);
      for (const pair of asyArrHelpers(asyMangle(el), asyCore(el), zero)) {
        if (!this.arrGen.has(pair[0])) this.arrGen.set(pair[0], pair[1]);
      }
    }
    return nm;
  }

  /**
   * `new T[n][m]…`（两维起）用的构造器。counts 是**运行期**表达式，所以铺行要一个循环 ——
   * 生成一个函数而不是往 this.pre 摊语句：`new` 能出现在任何表达式位置，而 this.pre
   * 在有些位置是 null（`?:` 的两支里就没有）。外层 `anew` 铺的是**空引用**（核心方言
   * 那一刀的决定），所以每一行都要显式 aset 一条新的 —— 这正是"N 行各自独立"。
   * k 维的正文里调 k-1 维那一份，所以只有一处循环。
   */
  arrNewHelper(el, k) {
    const nm = `asy__anew${k}_${asyMangle(el)}`;
    if (this.arrGen.has(nm)) return nm;
    let t = el;
    let i = 0;
    while (i < k) { t = `${t}[]`; i++; }
    let ps = '';
    i = 0;
    while (i < k) { ps = i === 0 ? `(n0 int)` : `${ps} (n${i} int)`; i++; }
    let row = '';
    if (k === 2) {
      row = `(anew ${asyCore(asyElem(t))} (var n1))`;
    } else {
      let as = '';
      i = 1;
      while (i < k) { as = `${as} (var n${i})`; i++; }
      row = `(call ${this.arrNewHelper(el, k - 1)}${as})`;
    }
    this.arrGen.set(nm, `  (fn ${nm} (${ps}) ${asyCore(t)}
    (let r ${asyCore(t)} (anew ${asyCore(t)} (var n0)))
    (let i int (int 0))
    (while (bin "<" (var i) (var n0))
      (do
        (aset (var r) (var i) ${row})
        (set i (bin "+" (var i) (int 1)))))
    (ret (var r)))`);
    return nm;
  }

  /**
   * 泛型的 `copy(T[])`（runarray.in:687 的 copyArray，默认深拷到底）。这个前端没有泛型，
   * 所以按**实参的元素类型**现生一份 —— 与 arrGen 那张表同一条路子（一个类型只生一份）。
   * 元素本身是数组时递归深拷：asy 那边 `copy` 的 depth 默认是 Int_MAX。
   *
   * `cyclic` 跟着走（量过真 asy：`a.cyclic=true; b=copy(a); b.cyclic` 是 true，
   * `real[][]` 的**内层行**也跟着，`b[4]` 与 `a[4]` 都回 2）。每一层各自照 is/set 抄一次 ——
   * 内层那一层是递归进去的那份 helper 自己抄的，所以两层都对上。
   * 少了这一条的样子：three_surface.asy:1633 `array index out of range: 1 (length 1)`
   * （`copy` 出来的那份丢了 cyclic，下标绕不回去），sphere.asy 就死在那儿。
   */
  arrCopyHelper(el) {
    const nm = `asy__acopy_${asyMangle(el)}`;
    if (this.arrGen.has(nm)) return nm;
    this.arrGen.set(nm, '');   // 先占位：递归时不再进来
    const at = asyCore(`${el}[]`);
    const inner = asyIsArr(el)
      ? `(call ${this.arrCopyHelper(asyElem(el))} (aget (var a) (var i)))`
      : `(aget (var a) (var i))`;
    const cyc = this.cycHelper(`${el}[]`);
    // 登记册空着时**连调用都不发**：`cycis` 是线性扫，而这条 acopy 是 asy 值语义的
    // 每一次数组拷贝都要走的路。量过 sinc.asy 的 CPU profile：`asy__cycis_arr_real`
    // 自己占 12.3%（650ms / 5.3s），而 real[] 那本登记册整趟是空的 —— 花掉的全是
    // 调用与 alen 的开销。先看一眼长度，空的就跳过。
    this.arrGen.set(nm, `  (fn ${nm} ((a ${at})) ${at}
    (let r ${at} (anew ${at} (alen (var a))))
    (let i int (int 0))
    (while (bin "<" (var i) (alen (var a)))
      (do
        (aset (var r) (var i) ${inner})
        (set i (bin "+" (var i) (int 1)))))
    (if (bin "!=" (alen (var ${cyc.reg})) (int 0))
      (do (if (call ${cyc.is} (var a)) (do (expr (call ${cyc.set} (var r) (bool true)))))))
    (ret (var r)))`);
    return nm;
  }

  /**
   * 泛型的 `array(int n, T value)`（builtin.cc:624 → runarray.in:675 的 copyArrayValue）：
   * n 格，每格是 value。value 本身是数组时**逐层深拷**（那边的 depth 默认就是这个类型的
   * 真实深度，见注册时压进去的 `depth-1`），所以这里套 arrCopyHelper。
   */
  arrFillHelper(el) {
    const nm = `asy__afill_${asyMangle(el)}`;
    if (this.arrGen.has(nm)) return nm;
    this.arrGen.set(nm, '');   // 先占位：递归时不再进来
    const et = asyCore(el);
    const at = asyCore(`${el}[]`);
    const val = asyIsArr(el)
      ? `(call ${this.arrCopyHelper(asyElem(el))} (var v))`
      : '(var v)';
    this.arrGen.set(nm, `  (fn ${nm} ((n int) (v ${et})) ${at}
    (let r ${at} (anew ${at} (var n)))
    (let i int (int 0))
    (while (bin "<" (var i) (var n))
      (do
        (aset (var r) (var i) ${val})
        (set i (bin "+" (var i) (int 1)))))
    (ret (var r)))`);
    return nm;
  }

  /**
   * 数组的 `.cyclic`（第六十五刀）。asy 那边这是数组**对象**上的一格标记（array.h:21 的
   * `cycle`），置上之后下标按长度取模、负数也绕回来（runarray.in:104
   * `if(cyclic && len > 0) n=imod(n,len);`）。plain 里四处：plain_paths.asy:165 的
   * `T.cyclic=true`、plain_strings.asy:238 的 `spinner`、plain_pens.asy:148/152 的
   * `colorPen`/`monoPen`（`Pen(int n)` 正是靠它绕圈取笔）。
   *
   * 这一层的数组是核心方言的裸数组，头上没有那一格。加一格要动 anew/aget/aset 在
   * 解释器、JS/C/LLVM/SPIR-V 五个后端与 MIR 那一路，所以这一刀把标记放在**旁边**：
   * 每个数组类型一格模块级登记册（`(arr (arr T))`），按**身份**查（`(bin "==" …)`，
   * 就是 asy 的 alias 那一条）。身份查过的语义与"标记在对象上"完全一样 —— 别名、
   * 传参、装进结构体都跟着走，不像"按符号静态近似"那样会悄悄给错答案。
   *
   * 代价是每次下标多一次调用：登记册空着时（绝大多数类型）那一句就是一次长度比较。
   */
  cycHelper(at) {
    // asyMangle 对函数类型留着括号与逗号（`real(real)`），那不是标识符 —— 登记册与三个
    // helper 的名字都得是，所以再洗一遍。
    const key = asyMangle(at).replace(/[^A-Za-z0-9_]/g, '_');
    const nm = {
      reg: `asy__cycreg_${key}`,
      is: `asy__cycis_${key}`,
      set: `asy__cycset_${key}`,
      idx: `asy__cycidx_${key}`,
      map: `asy__cycmap_${key}`,
    };
    if (this.arrGen.has(nm.is)) return nm;
    const ct = asyCore(at);
    this.used.add('asy__mod');
    // 登记册本身也是一个顶层项（`(global …)`），跟 helper 一起发
    this.arrGen.set(nm.reg, `  (global ${nm.reg} (arr ${ct}))`);
    // 上一次问过的那一个记一格。下标操作绝大多数是"在同一个数组上循环"，所以这一格
    // 把线性扫变成一次身份比较。量过 sinc.asy：登记册非空时 `asy__cycis_arr_real`
    // 自己占 12.1%（709ms / 5.9s），全花在这条扫描上。
    // set 那边一改就把这一格清掉（置成空引用，与任何真数组都不相等），所以答案不会过期。
    this.arrGen.set(`${nm.is}__memo_a`, `  (global ${nm.is}__la ${ct})`);
    this.arrGen.set(`${nm.is}__memo_b`, `  (global ${nm.is}__lb bool)`);
    this.arrGen.set(nm.is, `  (fn ${nm.is} ((a ${ct})) bool
    (if (bin "==" (var ${nm.is}__la) (var a)) (do (ret (var ${nm.is}__lb))))
    (let f bool (bool false))
    (let i int (int 0))
    (while (bin "<" (var i) (alen (var ${nm.reg})))
      (do
        (if (bin "==" (aget (var ${nm.reg}) (var i)) (var a)) (do (set f (bool true)) (set i (alen (var ${nm.reg})))))
        (set i (bin "+" (var i) (int 1)))))
    (set ${nm.is}__la (var a))
    (set ${nm.is}__lb (var f))
    (ret (var f)))`);
    // 取消标记就把那一格换成空引用：它跟任何真数组都不相等，所以 is 那边照旧对
    this.arrGen.set(nm.set, `  (fn ${nm.set} ((a ${ct}) (on bool)) void
    (set ${nm.is}__la (null ${ct}))
    (set ${nm.is}__lb (bool false))
    (let i int (int 0))
    (while (bin "<" (var i) (alen (var ${nm.reg})))
      (do
        (if (bin "==" (aget (var ${nm.reg}) (var i)) (var a))
          (do
            (if (un "!" (var on)) (do (aset (var ${nm.reg}) (var i) (null ${ct}))))
            (ret)))
        (set i (bin "+" (var i) (int 1)))))
    (if (var on) (do (apush (var ${nm.reg}) (var a))))
    (ret))`);
    this.arrGen.set(nm.idx, `  (fn ${nm.idx} ((a ${ct}) (i int)) int
    (if (bin "==" (alen (var ${nm.reg})) (int 0)) (do (ret (var i))))
    (let n int (alen (var a)))
    (if (bin ">" (var n) (int 0))
      (do (if (call ${nm.is} (var a)) (do (ret (call asy__mod (var i) (var n)))))))
    (ret (var i)))`);
    // `a[ix]`（ix 是 int[]）里那一串下标也要过 idx —— runarray.in:910 的 arrayIntArray
    // 里 `if(cyclic && asize > 0) index=imod(index,asize);` 是**逐个**做的。
    // 量过（`asy -noV`）：`int[] a={10,20,30,40,50}; a.cyclic=true; a[-sequence(5)]`
    // 是 {10,50,40,30,20} —— smoothcontour3.asy:1408 那句反转就靠它（genustwo/genusthree）。
    this.arrGen.set(nm.map, `  (fn ${nm.map} ((a ${ct}) (ix (arr int))) (arr int)
    (let r (arr int) (anew (arr int) (int 0)))
    (let i int (int 0))
    (while (bin "<" (var i) (alen (var ix)))
      (do
        (apush (var r) (call ${nm.idx} (var a) (aget (var ix) (var i))))
        (set i (bin "+" (var i) (int 1)))))
    (ret (var r)))`);
    return nm;
  }

  /**
   * 泛型的 `search(T[] a, T key, bool less(T,T))`（runarray.in 的 searchArray）：
   * 有序数组里**最后一个"不比 key 大"的下标**，key 比首元素还小给 -1。
   * 判据从 `a[mid] <= key` 换成 `!less(key, a[mid])` —— 只用 less 一个算符，与那边一致。
   * 原型是 plain_Label.asy:624 的 `search(stringcache, s, lexorder)`。
   * 二元的那份在 prelude 里（`int search(real[], real)`，同一套二分）。
   */
  searchHelper(el) {
    const nm = `asy__search_${asyMangle(el).replace(/[^A-Za-z0-9_]/g, '_')}`;
    if (this.arrGen.has(nm)) return nm;
    const et = asyCore(el);
    const at = asyCore(`${el}[]`);
    const ft = asyCore(`bool(${el},${el})`);
    this.arrGen.set(nm, `  (fn ${nm} ((a ${at}) (key ${et}) (less ${ft})) int
    (let lo int (int -1))
    (let hi int (alen (var a)))
    (while (bin ">" (bin "-" (var hi) (var lo)) (int 1))
      (do
        (let mid int (call asy__quot (bin "+" (var lo) (var hi)) (int 2)))
        (if (un "!" (callfn (var less) (var key) (aget (var a) (var mid))))
          (do (set lo (var mid)))
          (do (set hi (var mid))))))
    (ret (var lo)))`);
    this.used.add('asy__quot');
    return nm;
  }

  /** 泛型的 `sequence(T f(int), int n)`（runarray.in:954）：{f(0),…,f(n-1)}。 */
  seqHelper(el) {
    const nm = `asy__seq_${asyMangle(el)}`;
    if (this.arrGen.has(nm)) return nm;
    const at = asyCore(`${el}[]`);
    this.arrGen.set(nm, `  (fn ${nm} ((f ${asyCore(`${el}(int)`)}) (n int)) ${at}
    (let r ${at} (anew ${at} (var n)))
    (let i int (int 0))
    (while (bin "<" (var i) (var n))
      (do
        (aset (var r) (var i) (callfn (var f) (var i)))
        (set i (bin "+" (var i) (int 1)))))
    (ret (var r)))`);
    return nm;
  }

  err(node, msg) {    this.diags.error(node === null || node === undefined ? null : node.span, msg);
    return null;
  }

  nope(node, what) {
    return this.err(node, `${ASY_NOPE}：${what}`);
  }

  /** `(H)` / `(H X)` / `(H-add PREV X)` 这三种形状摊成一条平的列表 */
  flat(node, name) {
    if (!isList(node)) return [];
    const h = head(node);
    if (h === `${name}-add`) {
      const out = this.flat(node.items[1], name);
      out.push(node.items[2]);
      return out;
    }
    if (h === name) {
      const out = [];
      for (const x of node.items.slice(1)) out.push(x);
      return out;
    }
    return [node];
  }

  push() { this.scopes.push(new Map()); }
  pop() { this.scopes.pop(); }

  lookup(nm) {
    let i = this.scopes.length - 1;
    while (i >= 0) {
      if (this.scopes[i].has(nm)) return this.scopes[i].get(nm);
      i--;
    }
    return null;
  }

  declare(node, nm, t) {
    if (this.scopes[this.scopes.length - 1].has(nm)) return this.err(node, `'${nm}' 在这一层已经声明过了`);
    this.scopes[this.scopes.length - 1].set(nm, t);
    return t;
  }

  /**
   * 这一格变量**写下来的类型名是 `guide`** 吗（第八十四刀）。这一层 `guide` 是 `path` 的
   * 别名（`typedef path guide;`），可 asy 那边它们是两个类型，而且**看得出差别**：
   * guide 是还没解的规格，path 是解好、控制点定死的。所以往一个写着 path 的变量里存的
   * 时候要过一次 `asy__solid`（见 asySlotAssign 与 asyVardec），写着 guide 的不过。
   * 记号与别名/箱子/改名那三条同一个拼法：键上加一个源码里不可能出现的前缀，
   * 作用域一 pop 一起没。查的时候在**第一个有这个名字的层**上停 —— 遮住的语义跟着 lookup。
   */
  markGuide(nm) { this.scopes[this.scopes.length - 1].set(`\u0000gd:${nm}`, true); }

  guideVar(nm) {
    let i = this.scopes.length - 1;
    while (i >= 0) {
      if (this.scopes[i].has(nm)) return this.scopes[i].get(`\u0000gd:${nm}`) === true;
      i--;
    }
    return false;
  }

  /**
   * `unravel x;` 摊出来的名字：类型照旧进 scopes（查得到），另存一条"它其实是谁的哪个
   * 字段"。那一条的键上加了一个源码里不可能出现的前缀，所以作用域一 pop 两条一起没。
   */
  declareAlias(node, nm, t, recv, rty, field) {
    if (this.declare(node, nm, t) === null) return null;
    this.scopes[this.scopes.length - 1].set(`\u0000al:${nm}`, {
      recv, rty, field, type: t,
    });
    return t;
  }

  /** `nm` 是不是一个摊出来的名字（是就回 `{recv, field, type}`）。只看**找到它的那一层** */
  aliasOf(nm) {
    let i = this.scopes.length - 1;
    while (i >= 0) {
      if (this.scopes[i].has(nm)) {
        const a = this.scopes[i].get(`\u0000al:${nm}`);
        return a === undefined ? null : a;
      }
      i--;
    }
    return null;
  }

  /**
   * 装箱的局部量（这一刀）：`nm` 在作用域里照旧记类型 `t`，另记一条"它其实住在一格
   * 长度 1 的数组里"。读是 `(aget (var 箱) (int 0))`、写是 `(aset (var 箱) (int 0) …)`，
   * 闭包抓走的是**那个数组**（引用语义），于是里外看见的是同一格 —— asy 的按引用捕获。
   * 箱子的名字与源码里那个名字**不同**：漏改的路径会去引用一个没声明的名字，
   * 核心方言那边当场报，而不是悄悄读到旧值。
   */
  declareBox(node, nm, t) {
    if (this.declare(node, nm, t) === null) return null;
    const sym = `asy__bx${this.unit.ntmp++}_${nm}`;
    this.scopes[this.scopes.length - 1].set(`\u0000bx:${nm}`, { sym, type: t });
    return sym;
  }

  /** 形参那一格装箱：名字已经在作用域里了（declare 过），这里只记"它住在箱子里" */
  boxParam(nm, t) {
    const sym = `asy__bx${this.unit.ntmp++}_${nm}`;
    this.scopes[this.scopes.length - 1].set(`\u0000bx:${nm}`, { sym, type: t });
    return sym;
  }

  /** `nm` 是不是一格装了箱的局部量（是就回 `{sym, type}`）。只看**找到它的那一层** */
  boxOf(nm) {
    let i = this.scopes.length - 1;
    while (i >= 0) {
      if (this.scopes[i].has(nm)) {
        const b = this.scopes[i].get(`\u0000bx:${nm}`);
        return b === undefined ? null : b;
      }
      i--;
    }
    return null;
  }

  /**
   * 同一层里用**另一个类型**重新声明同名的变量（第六十四刀）。asy 那边是**新开一格**把
   * 旧的遮住 —— `real d=…; pair d=dot(u,u);`（plain_Label.asy:39）与
   * `pair position=point(g,position);`（:349，形参 `real position` 被遮住）都是这一格。
   *
   * 这一层没有"同名两格"的表示（`(var 名字)` 就是那个名字），所以给**新那一格改个名**：
   * 作用域里的类型换成新的，另记一条 `\u0000sy:名字 -> 核心方言里的符号`。读（nameOf）、
   * 写（assign 的 `sym`）、调（call 里那两处）、捕获（capOf 的 `val`）四处各问一句 symOf。
   * 旧那一格从这一句起再也用名字取不到，与"类型相同就复用同一格"那一支看不出差别；
   * 已经抓走的捕获抓的是**旧那个符号**，也不受影响。
   *
   * 名字带 `asy__sh` 前缀是保留区：漏改的读写路径会去引用一个没声明的名字，核心方言那边
   * 当场报，而不是悄悄读到被遮住的旧值。
   */
  declareShadow(nm, t, boxed) {
    const top = this.scopes[this.scopes.length - 1];
    // 被遮住的那一格**记一条**：同名不同型时，用处那一侧（目标类型）还挑得到它 ——
    // `marginT margin=margin(b--b,p);` 之后 `draw(…,margin)` 里那个 margin 是**形参**
    // 那一格（plain_arrows.asy:593/595，形参是 `margin margin=EndMargin`）。
    // 落地与模块级那一格同一条（见 nameOf 的 shadowVar 与 coerce/fit 里那两个落点）。
    const oldT = this.lookup(nm);
    const oldBx = oldT === null ? null : this.boxOf(nm);
    const oldSym = oldT === null ? null : this.symOf(nm);
    top.set(nm, t);
    // 新那一格是**全新的一格**：旧那一格的别名/箱子/改名三条记号都不能留下来
    top.delete(`\u0000al:${nm}`);
    top.delete(`\u0000bx:${nm}`);
    top.delete(`\u0000sy:${nm}`);
    if (oldT !== null && oldT !== t) {
      top.set(`\u0000ov:${nm}`, {
        code: oldBx === null ? `(var ${oldSym})` : `(aget (var ${oldBx.sym}) (int 0))`,
        type: oldT,
        // 写回去也要够（第七十三刀）：`frame f;` 之后同一层里又写了 `real f(pair,pair){…}`，
        // 再一句 `f=pic.fit3(…)` 赋的还是**那格 frame**（three.asy:2755，85 个例子停在这里）。
        sym: oldSym,
        bx: oldBx === null ? null : oldBx.sym,
      });
    } else {
      top.delete(`\u0000ov:${nm}`);
    }
    if (boxed === true) {
      const bs = `asy__bx${this.unit.ntmp++}_${asyFldSym(nm)}`;
      top.set(`\u0000bx:${nm}`, { sym: bs, type: t });
      return bs;
    }
    const sym = `asy__sh${this.unit.ntmp++}_${asyFldSym(nm)}`;
    top.set(`\u0000sy:${nm}`, sym);
    return sym;
  }

  /** `nm` 在核心方言里叫什么（改过名的回新名字）。只看**找到它的那一层**，照 boxOf */
  symOf(nm) {
    let i = this.scopes.length - 1;
    while (i >= 0) {
      if (this.scopes[i].has(nm)) {
        const s = this.scopes[i].get(`\u0000sy:${nm}`);
        return s === undefined ? nm : s;
      }
      i--;
    }
    return nm;
  }

  /** 被 declareShadow 遮住的那一格（同名不同型）。只看**找到它的那一层**，照 boxOf */
  outerOf(nm) {
    let i = this.scopes.length - 1;
    while (i >= 0) {
      if (this.scopes[i].has(nm)) {
        const o = this.scopes[i].get(`\u0000ov:${nm}`);
        return o === undefined ? null : o;
      }
      i--;
    }
    return null;
  }

  /* ------------------------------------------------------------------ 类型 */

  /** `(name-ty (name int))` -> 'int'；`(array-ty (name int) (dims))` -> 'int[]'；
   *  `(dims+ (dims))` 是两层，`int[][]`（多维数组这一刀收下了）。 */
  type(node, what) {
    if (!isList(node)) return this.err(node, `${what}：这里要一个类型`);
    const h = head(node);
    if (h === 'array-ty') {
      const d = this.dimsDepth(node.items[2]);
      if (d === null) return this.err(node, `${what}：认不出的数组维数形状`);
      // 元素那一格有两种形状：声明那条路上是**裸的** name（`type -> name dims`），
      // 而 `new int[](…)` 那两条产生式里是 celltype，也就是多包了一层 `(name-ty …)`。
      // 两种都收 —— 不然 `new int[](int n){…}` 会报"带点的类型名"（量出来的）。
      let en = node.items[1];
      if (isList(en) && head(en) === 'name-ty') en = en.items[1];
      const el = this.plainName(en);
      if (el === null) {
        const qd = this.dotTy(en);
        if (qd === null) return this.nope(node, '带点的类型名');
        let qt = qd;
        for (let k = 0; k < d; k++) qt = `${qt}[]`;
        return qt;
      }
      // 元素那个名字走与下面 name-ty **同一条**路：别名 -> recVis（顺序解析 + 换成真名）
      // -> 全局表（没 import 进来）。以前这里只解别名，然后拿解出来的**文本**去问 recHere，
      // 那问法错在两头：
      //   - 别名解出来的是类型文本（模板实例里是打散过的真名 `asy__m6_Pair_K_V`），压根不在
      //     recVis 里，`e === undefined` 就被当成"声明在后面" —— 量出来的三条
      //     collections/iter.asy:14/30/48 全是 `T[]`（T 是另一个模板的实例）；
      //   - 而这个单元里的记录名没换成 `rec.name`，`Box_int[]`（模板实例改过名的）就报
      //     "数组元素只有 int/real/…" 那条 nope，asy 那边是收的（量过）。
      let eel = el;
      if (this.aliasKnown(el)) {
        const ael = this.aliasAt(el);
        if (ael === null) return this.aliasLate(node, el);
        eel = ael.t;
      } else if (this.recVis.has(el)) {
        if (!this.recHere(el)) return this.recLate(node, el);
        eel = this.recVis.get(el).rec.name;
      } else if (this.records.has(el)) {
        return this.recElsewhere(node, el);
      }
      if (!this.arrElemOk(eel)) return this.nope(node, `${eel}[] （${ASY_ARRELEM_TEXT}）`);
      let t = eel;
      let k = 0;
      while (k < d) { t = `${t}[]`; k++; }
      return t;
    }
    if (h !== 'name-ty') return this.err(node, `${what}：认不出的类型形状 '${h}'`);
    const nm = this.plainName(node.items[1]);
    if (nm === null) {
      const qd = this.dotTy(node.items[1]);
      if (qd !== null) return qd;
      return this.nope(node, '带点的类型名');
    }
    if (nm === 'void') return 'void';
    if (nm === 'pair') return 'pair';
    if (nm === 'triple') return 'triple';
    // typedef 的别名。放在内建名后面、记录名前面：asy 那边 `typedef int int;` 是错的，
    // 而 `typedef` 一个 struct 名的别名是对的，所以顺序只影响诊断说哪一句。
    if (this.aliasKnown(nm)) {
      const al = this.aliasAt(nm);
      return al === null ? this.aliasLate(node, nm) : al.t;
    }
    // 记录名（第十四刀）。放在内建名单后面查，与核心方言那边同一条规矩。
    // 查的是**这个单元看得见的**那张表（recVis）：别的模块里的 struct 没 import 进来时
    // 不算类型（量过 asy 报 "no type of name"），所以 records 那张全局表只用来发文本。
    // 回的是 `rec.name` 不是查的那个键 —— 模板模块的实例里两者不一样（键是源码里写的
    // `Box_T`，name 是打散过的 `asy__m3_Box_T`），别处也一样：`recVis` 的键是**这里**
    // 叫什么，`rec.name` 是那个类型**是什么**。
    if (this.recVis.has(nm)) {
      return this.recHere(nm) ? this.recVis.get(nm).rec.name : this.recLate(node, nm);
    }
    if (this.records.has(nm)) return this.recElsewhere(node, nm);
    if (!SCALARS.has(nm)) return this.nope(node, `类型 '${nm}'（这一刀只有 int/real/bool/string/pair/triple 与 struct）`);
    return nm;
  }

  /**
   * `A.B` 那样的类型名（第七十一刀）。两种来路，都是量出来的：
   *   - A 是个 struct、B 是它体里声明的类型 —— solids.asy:120 的
   *     `skeleton.curve s=s.transverse;`（`struct skeleton` 体里有 `struct curve`）。
   *     体里那些类型名记在 `rec.tyAlias` 上（第三十九刀），所以这里查它。
   *   - A 是个模块名（`access m;` 之后 `m.T x;`）—— 查那个单元自己的 recVis 与 tyAlias。
   * 认不出回 null（上一层照旧发"带点的类型名"那句 nope）。
   */
  dotTy(n) {
    if (!isList(n) || head(n) !== 'qualified') return null;
    const base = this.plainName(n.items[1]);
    const last = isAtom(n.items[2]) ? n.items[2].value : null;
    if (base === null || last === null) return null;
    const e = this.recVis.get(base);
    if (e !== undefined && e.rec.tyAlias !== undefined && e.rec.tyAlias.has(last)) {
      return e.rec.tyAlias.get(last).t;
    }
    const m = this.mods !== undefined && this.mods.has(base) ? this.mods.get(base) : undefined;
    if (m !== undefined) {
      const mu = this.units[m.unit];
      const me = mu.recVis.get(last);
      if (me !== undefined) return me.rec.name;
      if (mu.tyAlias !== undefined && mu.tyAlias.has(last)) {
        const l = mu.tyAlias.get(last);
        return l[l.length - 1].t;
      }
    }
    return null;
  }

  /**
   * 记录名 `nm` 在**当前位置**已经声明过了吗。asy 的**类型名**也是顺序解析的 ——
   * 量过：`A a; write(a.x); struct A { int x = 3; }` 报 "no type of name 'A'"。
   * 这一问与 visible()（函数候选按声明下标裁）是同一条规矩的另一半；不问就是
   * "比 asy 多接受一门语言"，`tests/asy/strict/struct-fwd` 钉着。
   */
  recHere(nm) {
    const e = this.recVis.get(nm);
    return e !== undefined && e.at <= this.at;
  }

  /** 上面那条的诊断。asy 自己也拒，所以是 err 不是 nope */
  recLate(node, nm) {
    return this.err(node, `'${nm}' 在这里还不是一个类型 —— struct ${nm} 声明在后面，`
      + `而 asy 的类型名是顺序解析的（那边报 "no type of name '${nm}'"）`);
  }

  /**
   * `from T unravel N;`（第六十五刀）：把一个类型按 `nm` 这个名字带进这一层，落法与
   * typedef 同一格（见 typeDec 尾巴上那一段）。分出来是给 stmts.js 用的 —— 那边不能
   * 直接碰 tyAlias（跨文件只走包装方法这一条，见文件头）。
   */
  bringTy(nm, t, at) {
    const list = this.tyAlias.has(nm) ? this.tyAlias.get(nm) : [];
    list.push({ t: t, at: at, u: this.unit.id });
    this.tyAlias.set(nm, list);
  }

  /** typedef 的名字也是顺序解析的（与 recLate 同一条规矩，只是话不一样） */
  aliasLate(node, nm) {
    return this.err(node, `'${nm}' 在这里还不是一个类型 —— typedef ${nm} 写在后面，`
      + `而 asy 的类型名是顺序解析的（那边报 "no type of name '${nm}'"）`);
  }

  /**
   * struct 体里所有 `using` / `typedef` 起的**名字**（只要名字，不解析类型）。
   *
   * 先扫一遍是为了那句诊断分得清：写在后面的别名，asy 报 "no type of name"（它自己也拒），
   * 所以我们要报 aliasLate 那条 err，而不是"这一刀还不支持类型 'X'"那条 nope ——
   * 两者的差别就是 tests/asy/strict 那条纪律（拒的理由不能带 ASY_NOPE）。
   */
  aliasNames(n) {
    const out = new Map();
    for (const item of this.flat(n.items[2], 'block')) {
      const r = asyUnwrapMod(this, item);
      if (!isList(r)) continue;
      const h = head(r);
      // 体里的**嵌套 struct**（第三十九刀）也算这一族：它起的那个名字同样只在体里可见，
      // 同样是顺序的。放进 late 是为了"写在后面"那句诊断说得对（asy 报 "no type of name"）。
      if (h === 'recorddec') {
        if (isAtom(r.items[1])) out.set(r.items[1].value, true);
        continue;
      }
      if (h === 'typedec-using') {
        const s = r.items[1];
        if (isList(s) && isAtom(s.items[1])) out.set(s.items[1].value, true);
        continue;
      }
      if (h !== 'typedec') continue;
      const v = r.items[1];
      if (!isList(v) || head(v) !== 'vardec') continue;
      for (const d of this.flat(v.items[2], 'decids')) {
        if (!isList(d) || head(d) !== 'decid') continue;
        const s = d.items[1];
        if (isList(s) && isAtom(s.items[1])) out.set(s.items[1].value, true);
      }
    }
    return out;
  }

  /** `nm` 是**某处**声明过的别名吗（不管这里可见不可见）—— 两张表都要问：文件级那张，
   *  与正在降的这个 struct 体里那张。分开问是为了 aliasLate 那句诊断：只有"确实有这个别名、
   *  但写在后面"才说那句话，别的名字该落到"类型 'X'"那条。 */
  aliasKnown(nm) {
    if (this.tyAlias.has(nm)) return true;
    return this.recAlias !== null
      && (this.recAlias.map.has(nm)
        || (this.recAlias.late !== undefined && this.recAlias.late.has(nm)));
  }

  /** 别名表里 `nm` 在**当前位置**可见的那一份（挑最后一份），此处一份都不可见给 null */
  aliasAt(nm) {
    // struct 体里的 `using` 先问：它遮住同名的文件级别名（asy 的作用域就是这么套的），
    // 并且严格按**体里的书写顺序**裁 —— 量过两条：写在方法后面的 using，那个方法体里
    // 报 "no type of name"；写在字段后面的，那个字段也报。所以 bi 是体里的项序号。
    if (this.recAlias !== null) {
      const e = this.recAlias.map.get(nm);
      if (e !== undefined && e.bi < this.recAlias.bi) return e;
    }
    const list = this.tyAlias.get(nm);
    if (list === undefined) return null;
    let hit = null;
    for (const e of list) if (e.at <= this.at) hit = e;
    return hit;
  }

  /**
   * `typedef real realfn(real);` / `typedef int myint;` / `using X = real(real);`
   * -> 往别名表里记一条。
   *
   * asy 的 typedef **不造新类型**，只给一个已有类型起名（量过：`typedef int myint;`
   * 之后 `int f(int)` 收 `myint` 的实参，`write(myint)` 那种事根本没有）。所以这里存的是
   * **解析好的类型字符串**，type() 一查就换掉，下游（重载挑选、asyCore、零值表）
   * 一个字都不用改 —— 这正是"类型全是字符串"那条设计付的第二次利息。
   *
   * 语法上 typedef 借的是 vardec 那条产生式（camp.y 就这么写的），所以名字藏在 decid 里：
   * `decidstart` 是普通别名（后面可以跟 `[]`），`fundecidstart` 是函数类型的别名 ——
   * `graph_splinetype.asy` 的 `typedef real[] splinetype(real[], real[]);` 就是后者，
   * 量过它是真 base 在场时 examples 的第一名（143 份）。
   */
  typeDec(n, at) {
    const h = head(n);
    if (h === 'typedec-using') {
      const start = n.items[1];
      const base = this.type(n.items[2], 'using');
      if (base === null) return null;
      return this.aliasOne(start, base, at);
    }
    const v = n.items[1];
    if (!isList(v) || head(v) !== 'vardec') return this.err(n, '认不出的 typedef 形状');
    const base = this.type(v.items[1], 'typedef');
    if (base === null) return null;
    for (const d of this.flat(v.items[2], 'decids')) {
      if (!isList(d) || head(d) !== 'decid') return this.err(d, '认不出的 typedef 项');
      // `typedef int myint = 3;` 语法上过得去（借的是 vardec），asy 那边报错。
      if (d.items.length > 2) return this.err(d, 'typedef 后面不能带初值');
      if (this.aliasOne(d.items[1], base, at) === null) return null;
    }
    return true;
  }

  /** 一条别名项。`start` 是 decidstart（可带 `[]`）或 fundecidstart（函数类型） */
  aliasOne(start, base, at) {
    if (!isList(start)) return this.err(start, '认不出的 typedef 项');
    const nm = isAtom(start.items[1]) ? start.items[1].value : null;
    if (nm === null) return this.err(start, 'typedef 少了名字');
    if (SCALARS.has(nm) || nm === 'pair' || nm === 'triple' || nm === 'void') {
      return this.err(start, `'${nm}' 是内建类型名，不能当 typedef 的名字`);
    }
    if (this.recVis.has(nm)) return this.nope(start, `typedef 的名字与 struct '${nm}' 撞了`);
    let t = base;
    if (head(start) === 'fundecidstart') {
      t = asyFnTypeOf(this, base, start.items[2], start);
      if (t === null) return null;
    } else if (head(start) === 'decidstart') {
      if (start.items.length > 2) {
        const d = this.dimsDepth(start.items[2]);
        if (d === null) return this.nope(start, 'typedef 的名字后面那串东西');
        if (!this.arrElemOk(t)) return this.nope(start, `${t}[] （${ASY_ARRELEM_TEXT}）`);
        let k = 0;
        while (k < d) { t = `${t}[]`; k++; }
      }
    } else {
      return this.err(start, '认不出的 typedef 项');
    }
    if (base === 'void' && t === 'void') return this.err(start, 'typedef 一个 void');
    // struct 体里的 `using`（见 recAlias）：记进这个记录自己那张表，**不进**文件级的那张。
    // 体里的 typedef 与体外同名时遮住体外那份，出了体就没了 —— 量过。
    // **只有"正在收这个 struct 的成员"那一遍算**（`this.self === null`）：方法体里写的
    // `using`（collections/map.asy:101 的 `using F = void();`）是**体内一句语句**，
    // 记进 rec.tyAlias 的话它的 bi 正好等于当前那一项的 bi，于是 aliasAt 里
    // `e.bi < bi` 不成立 —— 紧接着那一句就报"typedef 写在后面"。语句位置的别名走
    // 文件级那张表，与语句位置的 struct / typedef 同一条（出了块还看得见，见 asyStmt）。
    if (this.recAlias !== null && this.self === null) {
      this.recAlias.map.set(nm, { t: t, bi: this.recAlias.bi });
      return true;
    }
    // 同名再 typedef 一次：asy 收（后面那句起换成新的那一份），所以存的是一串。
    const list = this.tyAlias.has(nm) ? this.tyAlias.get(nm) : [];
    list.push({ t: t, at: at, u: this.unit.id });
    this.tyAlias.set(nm, list);
    return true;
  }

  /** 别的模块里的 struct，但这个文件没把它 import 进来（asy 那边也是 "no type of name"） */
  recElsewhere(node, nm) {
    // 嵌套 struct（第三十九刀）：名字在全局那张表里，但它是**某个 struct 体里**声明的，
    // 体外看不见。asy 那边同样报 "no type of name"，所以这也是 err；只是理由要说对。
    const r = this.records.get(nm);
    if (r !== undefined && r.inRec !== undefined) {
      return this.err(node, `'${nm}' 是 struct ${r.inRec} 体里声明的类型，体外看不见`
        + `（那边报 "no type of name '${nm}'"）`);
    }
    return this.err(node, `'${nm}' 是另一个模块里的 struct，这个文件没有把它引进来 ——`
      + ` \`access m;\` 只给限定名，要裸用得写 \`import m;\`（那边报 "no type of name '${nm}'"）`);
  }

  /** `t` 是声明过的记录（asy 的 struct）吗。`t` 已经是解析好的类型名，所以查全局那张表 */
  isRec(t) { return t !== null && t !== undefined && this.records.has(t); }

  /**
   * 源码里的一个名字 -> 它指的那个记录（没有就 null）。`A(…)` 这种构造调用要用它 ——
   * 调用处写的是**这个单元里的名字**（模板模块的实例是 `Box_int`），而 records 那张全局表
   * 的键是记录的真名（`asy__m3_Box_T`），两者在第三十一刀之后不再总是同一个。
   * 先问 recVis（并且照顺序解析裁），再退回全局表（类型文本进来时就是这一档）。
   */
  recOf(nm) {
    if (this.recVis.has(nm)) return this.recHere(nm) ? this.recVis.get(nm).rec : null;
    return this.records.has(nm) ? this.records.get(nm) : null;
  }

  /** `el` 能当数组元素吗（第十九刀起记录也能：asy 的 struct 是引用类型，`A[]` 是一串句柄；
   *  多维数组这一刀起数组自己也能 —— 格子里躺的同样是句柄；第三十七刀起**函数值**也能：
   *  方言那边 `(arr (fnty …))` 通了，量出来的理由是 plain_picture.asy:95 的
   *  `boundRoutine[] bound;`） */
  arrElemOk(el) {
    if (asyIsArr(el)) return this.arrElemOk(asyElem(el));
    return ASY_ARRELEM.has(el) || this.isRec(el) || asyIsFn(el);
  }

  /** `(dims)` 是 1 层，`(dims+ X)` 是 X 再加一层。认不出来给 null。 */
  dimsDepth(node) {
    if (!isList(node)) return null;
    const h = head(node);
    if (h === 'dims') return 1;
    if (h !== 'dims+') return null;
    const inner = this.dimsDepth(node.items[1]);
    return inner === null ? null : inner + 1;
  }

  /**
   * 记录的**真名**：全局唯一。源码里那个名字（`nm`）能直接用就直接用 —— 不带 import 的
   * 程序降出来的文本因此一字不变。撞上时（模板实例、遮蔽 prelude 或别的模块）按单元前缀
   * 打散，前缀也撞（主文件的前缀是空串）就再加一格计数。
   */
  recUniq(nm) {
    if (this.unit.tpl === null && !this.records.has(nm)) return nm;
    let t = `${this.unit.pfx}${nm}`;
    let k = 1;
    while (t === nm || this.records.has(t)) { t = `asy__sh${k}_${nm}`; k++; }
    return t;
  }

  /**
   * `struct A { int x; real y = 1.5; int get() { return x; } }` -> 一条记录声明。
   *
   * 字段**这一刀收 int / real / bool / string、pair、它们的一维数组，与前面已经声明过的
   * 记录**（pair 是第十五刀、数组是第十六刀、记录套记录是第十七刀）。
   * 自引用还在门外（`struct A { A next; }` —— asy 收，我们不收，见文件头的差别一节）。
   *
   * **方法是第二十刀**：降成一个多带一个 `this` 形参的普通函数（`asy__m_<记录>_<方法>`），
   * 因为 asy 的 struct 是引用类型 —— 传句柄就够，量过 `A b = a; b.bump(1);` 改的是同一个
   * 对象。成员名的可见性按**成员顺序**裁（量过：用后面声明的字段/方法报 "no matching
   * variable"），而 struct 的成员**遮住**同名的文件级名字（量过：文件里有 `int who()`、
   * struct 里也有 `who()`，方法体里调到的是后者）。
   * 把方法当值取出来（`int f() = a.late;`）是第四十三刀：现造一个只抓接收者的闭包，
   * 见 methodVal。
   */
  /**
   * 这个类型节点是不是**光一个 `var`**（第四十一刀）。asy 的 `var` 是"从初值推"，
   * 不是一个类型：量过 `var a=1, b=2.5;` 两个名字各推各的（int 与 real），
   * `var z;` 那边直接报 "inferred variable declaration without initializer"。
   */
  isVarTy(node) {
    if (!isList(node) || head(node) !== 'name-ty') return false;
    if (this.plainName(node.items[1]) !== 'var') return false;
    // **`var` 也可以被 typedef 掉**（第六十二刀）：`simplex2.asy:16` 的
    // `typedef int var;`（写在 `struct problem` 体里），之后 `var[] v = {…}` 与
    // `var argmin;` 都是**普通声明**，不是类型推断。asy 那边 `var` 是个可以被遮住的
    // 名字（量过：那两句在真 asy 里通，而"推断不带初值"它自己是拒的）。
    // 所以这一格先问别名表 —— 此处可见的别名有一份，就不是 `var` 那条路。
    return this.aliasAt('var') === null;
  }

  /**
   * 试着降一遍这个表达式、只为了拿它的类型（`var` 用）。诊断全部回滚，`pre` 换成一个
   * 扔掉的数组（表达式里可能要落临时量），所以这一趟对外面**只多不少**：生成的构造函数与
   * 数组工厂都是按名字记住的，真降那一遍会用同一份。推不出来（那一句本来就有错）回 null。
   */
  /**
   * `var` 字段的类型（第七十一刀）。`var f = new T;` 这一种**不真降**：类型就写在那儿。
   *
   * 为什么要这一格：真降一遍会顺手把 T 的构造函数**在声明遍里**生成出来（recNew），
   * 而声明遍是先走一圈 recorddec、**再**登记文件级函数的签名（见 asyDeclPass 的两个循环），
   * 于是 T 里那些摊出来的函数值字段（fnFldOk）的体一降就找不着文件级的函数。
   * 量出来的形状是 plain_bounds.asy:657 的 `private var base=new freezableBounds;`——
   * freezableBounds 体里 `pair min(transform t)` 要 plain_scaling.asy:180 的
   * `min(real, scaling, coord[])`，那时候一格签名都还没登记，于是整条推不动。
   */
  varFldTy(d) {
    const iv = d.items[2];
    if (isList(iv) && head(iv) === 'new-record') {
      const nt = this.type(iv.items[1], '`var` 字段的 `new` 的类型');
      if (nt !== null) return nt;
    }
    return this.probeTy(iv);
  }

  probeTy(node) {
    if (node === undefined || node === null) return null;
    const mark = this.diags.mark();
    const savePre = this.pre;
    this.pre = [];
    const v = this.expr(node);
    this.pre = savePre;
    // 推不动的时候那一遍里报的是什么：留一句给上面那条 nope 用 —— 不留的话
    // 「`var` 的初值推不动」会盖住真正的原因（量过一条：plain_bounds.asy:657 的
    // `new freezableBounds` 推不动，真正的门槛是体里 `addPath=addPathToEmptyArray;`
    // 那句「把方法取出来当值」，跟 `var` 没关系）。
    this.probeMsg = this.diags.items.length > mark ? this.diags.items[mark].msg : null;
    this.diags.rollback(mark);
    if (v === null || v.code === null || v.type === undefined) return null;
    return v.type;
  }

  recordDec(n, at, outerAl) {
    const nm = isAtom(n.items[1]) ? n.items[1].value : null;
    if (nm === null) return this.nope(n, '没有名字的 struct');
    if (SCALARS.has(nm) || nm === 'pair' || nm === 'triple' || nm === 'void') {
      return this.err(n, `'${nm}' 是内建类型名，不能当 struct 名`);
    }
    // 同一个单元里同名的 struct 声明两遍：还是拒（asy 那边后一份遮住前一份，量过，
    // 但那要求"这个名字在这一格之前指的是另一个类型"这件事整条路都记得住 —— 门外）。
    // **别处**来的那个名字（prelude 或 import 进来的）不算重复：这一句遮住它。
    const prev = this.recVis.get(nm);
    if (prev !== undefined && prev.rec.unit === this.unit.id) {
      return this.nope(n, `重复定义的 struct '${nm}'`);
    }
    // struct 名是**全局共享**的一个命名空间（第二十五刀）：核心方言的 class 名、方法名
    // （`asy__m_<记录>_<方法>`）、构造函数名都是按记录名拼的，所以真名必须全局唯一。
    // 撞上时打散（第三十八刀）——「这里叫什么」（recVis 的键）与「那个类型是什么」
    // （rec.name）第三十一刀就分开了，模板实例一直靠这一条活着，遮蔽跟着白捡：
    //   - 用户文件里 `struct picture {…}` 遮住 prelude 那份（量过 asy 收，写 7）；
    //   - `base/plain.asy` 里真的那个 `picture` 遮住我们 prelude 的替补 —— 这条是
    //     `import plain;` 那面墙上的第三块砖。
    const tname = this.recUniq(nm);
    const fields = [];
    // 记录先登记（字段还空着）：方法的签名可以提到这个记录自己（`A copy()`），
    // 而 type() 是查 recVis 认记录名的。自引用字段那一条拦在 type() 前面，
    // 所以"字段还空着"这件事在这里看不出问题。
    const rec = { name: tname, fields: fields, at: at, unit: this.unit.id, tyAlias: new Map(),
      memAlias: new Map(), stmts: [], au: new Set() };
    this.records.set(tname, rec);
    this.recVis.set(nm, { rec, at });
    // 体里的类型名按**这个 struct 的位置**判可见（recHere）：字段与方法签名只能提到
    // 前面声明过的记录。第一遍走到这里时 this.at 还是 0，所以要现设现还。
    const keepAt = this.at;
    this.at = at;
    // 体里的 `using` 也是现设现还（见 recAlias）—— recordBody 里到处是 return null，
    // 所以开关放在这一层，与 this.at 那一对并排
    const keepAl = this.recAlias;
    this.recAlias = { map: rec.tyAlias, bi: 0, late: this.aliasNames(n) };
    // 嵌套 struct（第三十九刀）：**外层体里那些名字**在里面也认。量出来的样子是
    // plain_picture.asy:207 那条 `using drawerBound3=…`，紧接着的 `struct node3` 拿它
    // 当字段类型（`:211`）。抄进这份自己的表、位置记 -1（体里第 0 项之前就可见），
    // 于是方法体那条路（decls.js 里按 cand.abi 摆 recAlias）跟着白捡。
    if (outerAl !== undefined && outerAl !== null) {
      for (const kv of outerAl.map) {
        if (kv[1].bi < outerAl.bi) rec.tyAlias.set(kv[0], { t: kv[1].t, bi: -1 });
      }
    }
    const out = this.recordBody(n, rec, at);
    this.recAlias = keepAl;
    this.at = keepAt;
    return out;
  }

  /**
   * struct 体里的嵌套 struct（第三十九刀）。降法：**当一条普通的记录声明**（真名走
   * recUniq，所以撞了就打散），只是那个名字**不留在这个单元的表里** —— 它进外层那张
   * 体内别名表（`rec.tyAlias`，与 `using` 同一张、同一条 bi 规矩），于是体里从这一项
   * 之后认得它，体外一样是"没有这个类型"。
   *
   * recVis 那一份是 recordDec 塞的（嵌套的体里要认自己的名字，比如 `B copy()`），
   * 所以是**先让它塞、回来再撤**，撤成原来那份（外面可能本来就有一个同名的类型）。
   *
   * 最后把**外层那条记录挪到后面**：方言要求字段的类那一条先声明，而 records 是按插入
   * 顺序发的，外层先进去、嵌套的后进去，不挪就是 `(class A (b B))` 排在 `(class B …)`
   * 前面。Map 没有"重排"，删掉再塞一遍就到末尾了。
   */
  recNested(n, outer, at) {
    const bn = isAtom(n.items[1]) ? n.items[1].value : null;
    if (bn === null) return this.nope(n, '没有名字的 struct');
    const al = this.recAlias;
    const had = this.recVis.get(bn);
    // recordDec 成功也回 null（那个返回值只有"体走完了"的意思），所以失败要看诊断有没有多
    const mark = this.diags.errorCount();
    this.recordDec(n, at, al);
    const e = this.recVis.get(bn);
    if (had === undefined) this.recVis.delete(bn);
    else this.recVis.set(bn, had);
    if (e === undefined || this.diags.errorCount() > mark) return null;
    al.map.set(bn, { t: e.rec.name, bi: al.bi });
    // 嵌套那个 struct **自己的**体里也要认得自己的名字：方法体是后一遍才降的，那时候
    // recVis 上面已经撤了、recAlias 换成了它自己那张（decls.js 里 asyMethod 那一句），
    // 于是 `Inner copy() { Inner b = new Inner; … }`（plain_picture.asy:236 的 bounds3）
    // 就找不着类型了。所以把外层这一刻**已经声明过**的体内类型连同它自己的名字，
    // 抄进它自己那张表（bi 记 0 —— 在它自己的体里从第一项起就看得见）。
    for (const [k, v] of al.map) {
      if (v.bi <= al.bi && !e.rec.tyAlias.has(k)) e.rec.tyAlias.set(k, { t: v.t, bi: 0 });
    }

    // 体外那句诊断要说得对（见 recElsewhere）：这个类型是**某个 struct 体里**声明的
    e.rec.inRec = outer.name;
    this.records.delete(outer.name);
    this.records.set(outer.name, outer);
    return true;
  }

  /**
   * 这个"有体的方法"要摊成**一格函数类型的字段**吗（第六十二刀）。摊就回 {name, type}，
   * 不摊回 null（照旧当方法）。门槛卡得很紧 —— 摊一格字段每个实例都要多装一个闭包，
   * 而这一刀只为了让 `X.方法名 = …` 那一句能落地：
   *   - 名字在这个单元里**真被当成员赋过值**（memAssigned）；
   *   - 是个普通名字（`operator …` 与 `operator init` 的调用形态不是"读一格字段再调"）；
   *   - 不带 static（那一档没有接收者，本来就不在实例上）；
   *   - 形参不带默认值、不带可变形参（函数值没有那两格 —— 与 methodVal 同一条）。
   *
   * **同名的重载各占一格**（第七十一刀）：asy 的 struct 体是个作用域，同名按签名分得开，
   * 而"同名两格字段"那条路（第四十九刀的 `asy__fd<K>_名字` + `src`）早就铺好了 ——
   * 所以重载不再是拦路的理由，只有"类型一模一样的两份"才照旧当方法（那两格分不开）。
   * 量出来的形状是 three_surface.asy:267 的 `normal=normaltriangular;`：`patch` 体里
   * `normal` 有两个签名（:100 的七个 triple 与 :168 的 `(real,real)`），从前 mcount != 1
   * 一律不摊，于是那一句报"未声明的变量 'normal'"—— 220 个例子里 31 个停在这一行。
   */
  fnFldOk(r, st, seen, memNames) {
    if (st === true) return null;
    if (r.items[4] === undefined || r.items[4] === null) return null;
    const mn = isAtom(r.items[2]) ? r.items[2].value : null;
    if (mn === null || mn.startsWith('operator ')) return null;
    if (this.unit === null || this.unit.mset === undefined || !this.unit.mset.has(mn)) return null;
    const ps = asyFormals(this, r.items[3]);
    if (ps === null) return null;
    for (const p of ps) {
      // 带默认值的形参**不再**一律挡这一格（第七十三刀）：类型那一份的默认值由
      // asyFnTypeOf 记进 fnDefs，通过这格函数值少给实参时 asyFnValDefWrap 会补上 ——
      // `pen[] colors(material m, light light=currentlight)`（three_surface.asy:226，
      // 同名的 `pen[] colors;` 在 :23）就是这一条，:271 的 `colors=colorstriangular`
      // 要的正是这格函数值。
      //
      // 只有一种默认值不行：**引用这个记录自己的成员**（`bool keepAspect=this.keepAspect`，
      // plain_picture.asy:559）—— fnDefs 那份包装是在文件级降的，没有接收者。那种照旧当方法。
      if (p.rest === true) return null;
      if (p.def !== null && p.def !== undefined && !this.defSelfFree(p.def, memNames)) return null;
    }
    const ret = this.type(r.items[1], `方法 ${mn} 的返回类型`);
    if (ret === null) return null;
    const t = asyFnTypeOf(this, ret, r.items[3], r);
    if (t === null) return null;
    // 同名同型的两格分不开（asy 那边也是 "already declared in this scope"）：照旧当方法
    const had = seen.get(mn);
    if (had !== undefined) for (const x of had) if (x === t) return null;
    return { name: mn, type: t };
  }

  /**
   * 这个默认值表达式**不碰记录自己的成员**吗（fnFldOk 用它）。
   * 判据只有两条：没有 `this`，也没有一个裸名字落在 `memNames` 里
   * （记录体里声明的字段名与方法名，recMemNames 收的）。宁可保守 —— 判错了只是
   * 这一格照旧当方法，不会错降。
   */
  defSelfFree(d, memNames) {
    const stack = [d];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (isAtom(cur)) {
        if (memNames !== undefined && memNames.has(cur.value)) return false;
        continue;
      }
      if (!isList(cur)) continue;
      if (head(cur) === 'this') return false;
      for (let i = 1; i < cur.items.length; i++) stack.push(cur.items[i]);
    }
    return true;
  }

  /** 记录体里声明的成员名（字段名与方法名）。只给 defSelfFree 用，收得宽一点没坏处。 */
  recMemNames(n) {
    const out = new Set();
    for (const item of this.flat(n.items[2], 'block')) {
      const r = asyUnwrapMod(this, item);
      if (!isList(r)) continue;
      const h = head(r);
      if (h === 'fundec' && isAtom(r.items[2])) out.add(r.items[2].value);
      if (h !== 'vardec') continue;
      const stack = [r.items[2]];
      while (stack.length > 0) {
        const cur = stack.pop();
        if (!isList(cur)) continue;
        if (head(cur) === 'decidstart' && isAtom(cur.items[1])) { out.add(cur.items[1].value); continue; }
        for (let i = 1; i < cur.items.length; i++) stack.push(cur.items[i]);
      }
    }
    return out;
  }

  /** recordDec 的体（分出来只为了那句 this.at 现设现还） */
  recordBody(n, rec, at) {
    const nm = rec.name;
    const fields = rec.fields;
    const seen = new Map();
    const memNames = this.recMemNames(n);
    let mat = 0;
    let bi = 0;
    for (const item of this.flat(n.items[2], 'block')) {
      // 体里的项序号：`using` 的可见性按它裁（见 aliasAt）。每一项都占一个号，
      // 不管它占不占成员槽 —— 那样 `using` 与紧跟着的字段就不会撞在同一个号上。
      this.recAlias.bi = bi;
      bi++;
      const r = asyUnwrapMod(this, item);
      if (!isList(r)) continue;
      // `autounravel`（第二十八刀）：这个成员其实是**文件级**声明 —— 交给 sig，
      // 正文攒在 auFns 里跟文件级函数一起发。它不占成员槽（不是字段也不是方法）。
      if (asyAuMod(this, item)) {
        // `autounravel T n = …`（第三十四刀）：与 static 的字段是同一格，只是名字在
        // struct 之后的文件级也裸着可见。量过（见 staticDec 的注释）。
        if (head(r) === 'vardec') {
          if (asyStaticDec(this, rec, r, at, true) === null) return null;
          asyAuNames(this, rec, r);
          continue;
        }
        if (head(r) !== 'fundec') {
          this.nope(r, `autounravel 的 '${head(r)}'（这一刀有 autounravel 的函数、算符与字段）`);
          return null;
        }
        asySig(this, r, at);
        asyAuNames(this, rec, r);
        this.auFns.push({ node: r, at });
        continue;
      }
      if (head(r) === 'fundec') {
        // `static` 的方法（第三十八刀）：没有接收者的那一种成员。三种调用形态都量过 ——
        // `C.make(3)`、struct 的方法体里裸写 `make(3)`、实例上 `a.make(7)`（接收者算白搭）。
        const st = asyStMod(this, item);
        // **有体的方法被当成员赋过值**（第六十二刀）：asy 那边方法就是一格函数值字段，
        // 所以这一档整条摊成"一格函数类型的字段 + 一个初值是那个匿名函数的默认值"——
        // 与"没有体的成员就是一格字段"落在同一条路上（调用、取值、赋值三处都白捡）。
        // plain_arrows.asy:36 的 `filltype defaultfilltype(pen) {return FillDraw;}` 加
        // `:162` 的 `TeXHead.defaultfilltype=…` 就是它。摊的判据只有"名字被赋过值"
        // （见 memAssigned）—— 全摊的话每个实例都要为每个方法装一个闭包。
        const fnf = this.fnFldOk(r, st, seen, memNames);
        if (fnf !== null) {
          // 同名的第二格起换槽名（与上面 vardec 那一路同一条，第四十九刀）
          const fhad = seen.get(fnf.name);
          const fdup = fhad !== undefined;
          const fslot = fdup ? `asy__fd${fields.length}_${asyFldSym(fnf.name)}` : fnf.name;
          fields.push({ name: fslot, src: fnf.name, type: fnf.type, def: null, mat: mat,
            bi: bi - 1, fnbody: r });
          if (fdup) fhad.push(fnf.type); else seen.set(fnf.name, [fnf.type]);
          mat++;
          continue;
        }
        if (asyMethodSig(this, rec, r, mat, at, st) === null) return null;
        mat++;
        continue;
      }
      // `static T n = …`：**不是字段**，是一个名字挂在 struct 上的文件级变量（见 stMod）。
      // 与 autounravel 同一个形状，所以也不占成员槽。
      if (head(r) === 'vardec' && asyStMod(this, item)) {
        if (asyStaticDec(this, rec, r, at) === null) return null;
        continue;
      }
      // `using X = void(frame,path[],pen);` / `typedef … X;` 写在 struct 体里：别名只在
      // 体里可见（见 recAlias），也不占成员槽。plain_filldraw.asy:93 的 filltype 靠这条 ——
      // 它紧接着还写了 `fill2 fill2;`，同名的字段与别名并存，因为那是两个名字空间。
      if (head(r) === 'typedec' || head(r) === 'typedec-using') {
        if (this.typeDec(r, at) === null) return null;
        continue;
      }
      // struct 体里的 **struct 声明**（第三十九刀）：那是一个只在这个体里可见的类型名。
      // 量过 asy 那边：体里当字段、当数组元素、方法里 `new B` 全通；体外裸写 `B` 报
      // "no type of name 'B'"；`private` 的写 `A.B` 报 "accessing private field outside
      // of structure"，不 private 的 `new A.B` 报 "allocation of struct 'B' is not in a
      // valid scope"（三条都退 1）。plain_bounds.asy:88 的 transformedBounds 与
      // plain_picture.asy:210 的 node3 都是这一条。它不占成员槽（不是字段也不是方法）。
      if (head(r) === 'recorddec') {
        if (this.recNested(r, rec, at) === null) return null;
        continue;
      }
      // `from 字段 unravel 名字;`（第五十八刀）：把那个字段上的同名成员**借**到这个
      // struct 上。plain_picture.asy:556 的 `from bounds unravel addPath;` 就是它，
      // 那边的注释写着理由是"省一次函数调用"。asy 那边这是名字空间那一层的事；
      // 我们这一层只借到**方法调用**那一档上 —— `pic.addPath(g,p)` 转成
      // `pic.bounds.addPath(g,p)`（见 methodCall 里那一句）。借的名字**不**占成员槽。
      // 只认"从这个 struct 前面的一个 struct 字段借"这一种形状；从模块或类型名 unravel、
      // 带 `as` 改名、以及体里裸写这个名字都还没做（漏出去的是各自那句 nope）。
      if (head(r) === 'unravel') {
        const qn = this.plainName(r.items[1]);
        let fty = null;
        if (qn !== null) for (const f of fields) if (f.name === qn) fty = f.type;
        if (fty === null || !this.isRec(fty)) {
          // 这一条**不**把整个 struct 判死（nope 之后接着走）：一句借不动的 unravel
          // 不该把后面几十个成员一起拖下水 —— 从前它落到"体里的语句"那一档也是这样。
          this.nope(r, `from ${qn === null ? '?' : qn} unravel …`
            + '（这一刀只有"从这个 struct 前面的一个 struct 字段借名字"这一种）');
          continue;
        }
        // `from 字段 unravel *;`（collections/map.asy:198）：借**全部**。不在这里把那个
        // 记录的成员列出来 —— 记一个通配的记号，methodCall 里当兜底那一档问。
        if (isList(r.items[2]) && head(r.items[2]) === 'wildcard') {
          rec.memAliasAll = { field: qn, type: fty };
          continue;
        }
        for (const p of this.flat(r.items[2], 'idpairs')) {
          if (!isList(p) || head(p) !== 'idpair' || p.items.length !== 2 || !isAtom(p.items[1])) {
            this.nope(p, 'unravel 里带 `as` 的名字对');
            continue;
          }
          rec.memAlias.set(p.items[1].value, { field: qn, type: fty });
        }
        continue;
      }
      if (head(r) !== 'vardec') {
        // struct 体里的**语句**（第三十六刀）：asy 的 struct 体其实就是一个 block ——
        // 量过它是**每个实例**构造时按体内顺序跑一遍，而且能裸读写前面的成员
        //   `struct S { int x = 1; write("body"); int y = x + 1; x = 5; }`
        //   -> body / x=5 / y=2，造第二个实例又印一遍 body。
        // 名字的可见性与字段默认值同一条（量过后面的字段/方法都报 "no matching variable"），
        // 所以这里只记下位置，正文在 recNew 里与字段默认值**同一串**里发。
        // collections/map.asy:115 的 `map.size = new int() { return size; };` 靠这一条。
        this.records.get(nm).stmts.push({ node: r, mat: mat, bi: bi - 1 });
        mat++;
        continue;
      }
      // 字段类型是**这个 struct 自己**：asy 收，而且那一格是**空引用** —— 量过
      //   `struct N { int v; N next; } N a; a.v=1; N b; b.v=2; a.next=b;`
      //   -> `a.next.v` 是 2、`a.next.next == null` 是 true。
      // 也就是"自引用那一格不给它造对象"（造就是无限递归）。第七十七刀收下这一种：
      // 声明这里放行，不造那一格在 recNew 里（见那边的 recBusy）。
      // bsp.asy:151（examples/colorplanes.asy）与 drawtree.asy:9（treetest.asy）靠它。
      // `var` 的字段（第四十一刀）：类型从初值推，而字段类型要在**声明遍**就定下来，
      // 所以这里是"试着降一遍初值、只要它的类型"（probeTy）。plain_bounds.asy:657 的
      // `private var base=new freezableBounds;` 就是这一条。
      const isVarFld = this.isVarTy(r.items[1]);
      const ft = isVarFld ? 'var' : this.type(r.items[1], `struct ${nm} 的字段`);
      if (ft === null) return null;
      for (const d of this.flat(r.items[2], 'decids')) {
        if (!isList(d) || head(d) !== 'decid') return this.err(d, '认不出的字段声明');
        const start = d.items[1];
        // `int size();`（无体的方法声明，collections/iter.asy:5、genericpair.asy:24）在
        // asy 那边**就是一个函数类型的字段、初值 null** —— 量过：`struct S { int size(); }`
        // 之后 `s.size == null` 是 true，`s.size = new int(){…};` 之后 `s.size()` 就通了，
        // 而 struct 里别的方法调 `size()` 读的是这一格。语法上它是 vardec 里的
        // `(fundecidstart 名字 形参表)`，所以这里把类型换成 `(fnty …)` 就够了。
        const isFnFld = isList(start) && head(start) === 'fundecidstart' && start.items.length === 3;
        if (!isFnFld && (!isList(start) || head(start) !== 'decidstart')) {
          return this.nope(start, '认不出的字段名');
        }
        let fty = isFnFld ? this.fnTypeOf(ft, start.items[2], start) : ft;
        // 维度挂在**名字**后面（`struct S { real x[]; }` 就是 `real[] x`，量过一样）——
        // 与形参表里那一条、文件级 `real a[];` 那一条同一件事。
        if (!isFnFld && start.items.length > 2 && fty !== null) {
          const dd = this.dimsDepth(start.items[2]);
          if (dd === null) return this.nope(start, '认不出的字段名维度');
          for (let k = 0; k < dd; k++) fty = `${fty}[]`;
        }

        if (fty === null) return null;
        if (isVarFld) {
          if (isFnFld) return this.nope(start, '`var` 后面跟形参表的字段');
          if (d.items[2] === undefined) {
            return this.err(d, '`var` 的字段没有初值 —— 那推不出类型（asy 那边报'
              + ' "inferred variable declaration without initializer"）');
          }
          fty = this.varFldTy(d);
          if (fty === null || fty === 'void') {
            const why = this.probeMsg === null ? '' : `，那一遍里报的是「${this.probeMsg}」`;
            return this.nope(d, '这一句 `var` 字段的初值推不动（声明遍里推得动的只有不依赖'
              + `别的成员的写法 —— 那时候这个 struct 的成员还没铺好${why}）`);
          }
        }
        // 函数类型的字段（`fill2 fill2;`，plain_filldraw.asy:93）：方言那边现在收
        // `(fnty …)` 当字段类型了，五条腿上都是"存一个句柄"。没写默认值就不发 fldset ——
        // `(cnew …)` 已经把每一格铺成零值了（函数值那一格的零值是空引用，见 recNew）。
        if (!SCALARS.has(fty) && fty !== 'pair' && fty !== 'triple' && !this.isRec(fty)
            && !asyIsFn(fty)
            && !(asyIsArr(fty) && this.arrElemOk(asyElem(fty)))) {
          return this.nope(r, `struct ${nm} 的 ${fty} 字段（这一刀的字段只有 `
            + `int/real/bool/string/pair/triple、函数类型、它们的一维数组，`
            + '与**前面已经声明过**的 struct）');
        }
        const fn = isAtom(start.items[1]) ? start.items[1].value : null;
        if (fn === null) return this.err(start, '字段少了名字');
        // 同名的字段（第四十九刀）：asy 的 struct 体是个**作用域**，同名按签名分得开 ——
        // three_arrows.asy:70/73 的 `real size(pen p)=arrowsize;` 与 `real size;` 是
        // 两格。核心方言的 class 一个名字一格，所以后来那份**换个槽名**（`asy__fd<K>_名字`），
        // 源码里那个名字记在 `src` 上，认名字那几处（fldOf / hasFld / 方法调用）按 src 找。
        // 类型一模一样的两份仍然是错（asy 那边报 "already declared in this scope"）。
        const had = seen.get(fn);
        if (had !== undefined) {
          for (const t of had) {
            if (t === fty) return this.err(d, `struct ${nm} 里有两个字段叫 '${fn}'，类型也一样`);
          }
        }
        const dup = had !== undefined;
        if (dup) had.push(fty); else seen.set(fn, [fty]);
        const slot = dup ? `asy__fd${fields.length}_${asyFldSym(fn)}` : fn;
        fields.push({ name: slot, src: fn, type: fty,
          def: d.items[2] === undefined ? null : d.items[2], mat: mat, bi: bi - 1 });
      }
      // 一条 vardec 可以声明好几个字段，它们在 asy 那边是**同一步**（互相看不见），
      // 所以 mat 是按声明语句加一，不是按字段加一。
      mat++;
    }
    // `operator [=]` 必须配一个 `operator []`（asy 自己就拒：量过报 "operator[=] defined
    // without operator[]"）。这一条要在这里问 —— 方法是逐条登记的，"缺另一半"只有走完
    // 整个体才看得出来。
    if (this.funcs.has(`${nm}.operator [=]`) && !this.funcs.has(`${nm}.operator []`)) {
      return this.err(n, `struct ${nm} 里有 'operator [=]' 却没有 'operator []' ——`
        + ' asy 那边报 "operator[=] defined without operator[]"');
    }
    // 核心方言的 class 至少要一个字段，而 asy 那边"只有方法的 struct"、"只有 static 成员的
    // struct"都合法 —— math.asy:442 的 `struct rootfinder_settings` 就是后者（里面全是
    // static）。所以这里补一个**看不见的**占位字段，而不是把这一族拒掉。
    // 这一条是 static 那一刀逼出来的：static 成员不占成员槽，于是 base 里凭空多出一批
    // 零字段的 struct，`import graph;` 从 189 条掉到 1 条 —— 掉下来的不是进展，是 math.asy
    // 停在了更早的地方。
    if (fields.length === 0) {
      fields.push({ name: ASY_FILLER, type: 'int', def: null, mat: mat });
      mat++;
    }
    return null;
  }

  /** 记录里的字段。找不到时把有哪些字段一起说出来。 */
  /** 记录 `t` 上的 static 字段 `nm`（没有给 null）。三条取值路径共用这一份 */
  statOf(t, nm) {
    const rec = this.records.get(t);
    if (rec === undefined || rec.statics === undefined) return null;
    const g = rec.statics.get(nm);
    return g === undefined ? null : g;
  }

  /**
   * `Box.n`：**类型名**限定的 static。放在 dotQual 后面问 —— 同名的变量在点号左边赢
   * （与 dotQual 里那三档同一条规矩），所以只有它认不出时才轮到这里。
   */
  statQual(node) {
    if (!isList(node) || head(node) !== 'qualified') return null;
    const nm = isAtom(node.items[2]) ? node.items[2].value : null;
    const base = this.plainName(node.items[1]);
    if (nm === null || base === null) return null;
    if (!this.recVis.has(base)) return null;
    return this.statOf(base, nm);
  }

  /**
   * `C.f(…)` 里的 `C.f`：**类型名**限定的 static 方法（第三十八刀）。回候选表（空数组表示
   * 没有）。`C` 要是这个单元看得见的记录名 —— 与 statQual 同一条（同名的变量在点号左边赢，
   * 所以调用处先问 dotQual）。
   */
  statMethods(node, nm) {
    if (!isList(node) || head(node) !== 'qualified') return [];
    const base = this.plainName(node.items[1]);
    if (base === null || !this.recVis.has(base)) return [];
    const rec = this.recOf(base);
    if (rec === null) return [];
    const out = [];
    for (const c of this.visibleMethods(rec, nm)) if (c.stat === true) out.push(c);
    return out;
  }

  /**
   * 把**方法**取出来当值（第四十三刀）：`int f() = a.get;`、struct 体里的
   * `addPath=addPathToEmptyArray;`（plain_bounds.asy:247 就是这一句）。
   *
   * asy 那边它是**绑住接收者的闭包**。量过：`int f() = a.get;` 之后改 `a.n`，再调
   * `f()` 回的是新值 —— 绑的是那个对象，不是取出来那一刻的字段值。而我们的方法是
   * "多一个 this 形参的普通函数"，所以这里现造一个只抓接收者的闭包：ADR-0010 那套
   * `(cfn …)` + `(mkclo …)`，与匿名函数同一副零件。struct 是引用语义，`(mkclo …)`
   * 按值抓的是那个引用，于是"改字段看得见"这条自然对上了（不是模拟的）。
   *
   * 一个方法只生一份包装（`mvals` 那张表，与数组工厂 `arrGen` 同一条路子）。
   * 门外的两条：带默认值的方法（函数值没有默认值）、可变形参的方法（包装那一层要
   * 把打好的数组原样转手，还没量过）。
   */
  /**
   * 函数体里的**函数声明**（第四十六刀）：`void f() { int g(int k) {…} write(g(1)); }`。
   * base 里 7 处（plain_picture 的 add/addBox 那一族里最多）。asy 那边它是嵌套作用域里的
   * 一个函数，能看见外层的局部量；这一层降成一个**顶层函数** —— 名字另起
   * （`asy__lf<N>_<名字>`，核心方言的模块级名字要全局唯一），签名进 funcs 表，
   * 位置就是外层这一句的位置（`L.at`），所以同一句之后的调用看得见它。
   *
   * 抓外层局部量那一档**不收**：那要闭包（与 anonFn 的捕获是同一件事）。先按名字扫一遍
   * 体，撞上外层作用域里的名字就 nope —— 不扫的话那句诊断会变成"未声明的变量"，
   * 指错地方。形参与它自己的局部量不算，所以扫的时候把它们摘掉。
   */
  localFun(n) {
    const nm = isAtom(n.items[2]) ? n.items[2].value : null;
    if (nm === null) return this.err(n, '没有名字的函数声明');
    const hit = this.localFunOuter(n);
    if (hit !== null) return this.localFunClo(n, nm, hit);
    const mark = this.diags.errorCount();
    asySig(this, n, this.at);
    if (this.diags.errorCount() > mark) return null;
    // 这一份的候选：按节点认（asySig 刚push进去的那个）
    const list = this.funcs.get(nm);
    let d = null;
    if (list !== undefined) for (const c of list) if (c.node === n) d = c;
    if (d === null) return null;
    d.sym = `${this.genSym('lf', n)}_${d.base === undefined ? nm : d.base}`;
    // 体里看得见的局部只有它自己的：作用域栈换成空的一层，降完换回来
    const saveScopes = this.scopes;
    const saveUpd = this.updates;
    this.scopes = [];
    this.updates = [];
    const text = asyFunc(this, n);
    this.scopes = saveScopes;
    this.updates = saveUpd;
    if (text === null) return null;
    this.pushWrap(text);
    return [];
  }

  /**
   * 上面那条的**闭包版**（第六十六刀）：体里用到了外层的局部量，所以不能降成顶层函数。
   * 降法与匿名函数一模一样（ADR-0010 的 `(cfn …)` + `(mkclo …)`），只是造好的那个闭包
   * 绑在一个**局部量**上，名字就是它自己的名字 —— 之后 `g(1)` 那句走的是
   * "局部量是函数类型就 callfn"那一条（calls.js 里 nameCall 的第一档），不必另开一路。
   *
   * base 里四处：plain_markers.asy:64 的 `add` 抓 `g`、plain_pens.asy:333 的 `value`
   * 抓 `offset`、plain_picture.asy:979 的 `drawAll` 抓 `oldnodes`、plain_scaling.asy:61 的
   * `dominator` 抓 `NONE`。
   *
   * 三条边界，都照"函数值没有那一格"来：
   *  - 形参**默认值**：函数值不带默认值（与 anonFn 同一条），有就 nope。
   *  - **重载**：一个名字只有一格，同名再声明一次走的是"重新声明"那条（类型相同才行）。
   *  - **递归**：`nm` 是体降完之后才声明的，体里提到自己会落到"未声明的变量"。
   *    先扫一遍把它拦在这里，理由说准。
   */
  localFunClo(n, nm, hit) {
    if (this.pre === null) {
      return this.nope(n, `函数体里的函数 '${nm}' 要抓外层的 '${hit}'`
        + '（那要在这里绑一个局部量，可这个位置放不下语句）');
    }
    const ret = this.type(n.items[1], '函数的返回类型');
    if (ret === null) return null;
    const ps = asyFormals(this, n.items[3]);
    if (ps === null) return null;
    for (const p of ps) {
      // 形参**默认值**不再挡这一档（第七十三刀）：类型那一份的默认值由 asyFnTypeOf 记进
      // fnDefs，少给实参时 asyFnValDefWrap 会补 —— three_tube.asy:172 的 `Split`
      // （`int depth=mantissaBits`）就是这一格，220 个例子里 86 个停在这一行。
      if (p.rest === true) {
        return this.nope(n, `函数体里的函数 '${nm}' 既抓外层的 '${hit}'、又有可变形参`);
      }
    }
    // 类型先定出来：默认值顺手记进 fnDefs，而且**递归**那一支要在降体之前就有这一格
    const declTy = asyFnTypeOf(this, ret, n.items[3], n);
    if (declTy === null) return null;
    // 体里提到自己**不一定**是递归：asy 的名字按签名查，同名而签名不同的那一份照旧接得住。
    // plain_Label.asy:56 的 `pair[][] conj(pair[][] a)` 体里那句 `conj(a[j][i])` 调的是
    // 内建的 `pair conj(pair)`；plain_markers.asy:64 的 `void add(real x)` 体里那句
    // `add(pic, …, point(g,t))` 调的是 plain 的 `add(picture,frame,pair)`。两处都不是递归。
    // 所以不拿"提到过"当判据：先降一遍，降通了就是这种情形；降不通、而且体里确实提到了
    // 自己，才报"递归"—— 理由说准，而且连带的那几句诊断都回滚掉。
    const rec = this.mentions(n.items[4], nm);
    const mark = rec ? this.diags.mark() : null;
    const clo = this.mkClo(n, ret, ps, n.items[4]);
    if (clo === null && rec) {
      // **递归**的那一档（第七十三刀）：先绑一格**装了箱**的局部量（长度 1 的数组，初值就是
      // 那格数组的零值），再降体 —— 体里那句递归读的就是这一格（闭包抓走的是箱子，
      // 引用语义），降完再把闭包写进箱子里。asy 那边这一格本来就是"先有名字再有值"。
      // three_tube.asy:172 的 `Split`、three.asy:1368 的 `nurb`、contour.asy 的 `process`
      // 都是这一形。
      this.diags.rollback(mark);
      const bx = this.declareBox(n, nm, declTy);
      if (bx === null) return null;
      const at = asyCore(`${declTy}[]`);
      const m2 = this.diags.mark();
      const clo2 = this.mkClo(n, ret, ps, n.items[4]);
      if (clo2 === null) {
        this.diags.rollback(m2);
        return this.nope(n, `函数体里的函数 '${nm}' 抓外层的 '${hit}'，而它自己是递归的`
          + '（这一层的名字是体降完才绑上的，递归得先有那一格 —— 另一刀）');
      }
      return [`(let ${bx} ${at} (anew ${at} (int 1)))`,
        `(aset (var ${bx}) (int 0) ${clo2.code})`];
    }
    if (clo === null) return null;
    const had = this.scopes[this.scopes.length - 1].get(nm);
    if (had !== undefined) {
      if (had !== clo.type) {
        // 类型不同：新开一格，换个符号（第六十四刀，见 declareShadow）
        const sh = this.declareShadow(nm, clo.type, false);
        return [`(let ${sh} ${asyCore(clo.type)} ${clo.code})`];
      }
      return [`(set ${this.symOf(nm)} ${clo.code})`];
    }
    if (this.declare(n, nm, clo.type) === null) return null;
    // `operator *` 这种名字也能写在**函数体里**（plain_Label.asy:46 的
    // `pair[][] operator *(pair[][] a, pair[][] b)`，写在 `SVD` 那个函数体内）。名字直接
    // 当符号用会带着空格进核心方言（`(let operator * …)`），所以局部量这一格也要过一遍
    // 改名 —— 顶层那边是 `asy__op_mul`，这里记一条 `\u0000sy:` 让 symOf 认得。
    const sym = asyFldSym(nm);
    if (sym !== nm) this.scopes[this.scopes.length - 1].set(`\u0000sy:${nm}`, sym);
    return [`(let ${sym} ${asyCore(clo.type)} ${clo.code})`];
  }

  /** 一个子树里提到过这个名字没有（localFunClo 用它拦递归） */
  mentions(node, nm) {
    const stack = [node];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined || cur === null) continue;
      if (isAtom(cur)) { if (cur.value === nm) return true; continue; }
      if (!isList(cur)) continue;
      for (let i = 1; i < cur.items.length; i++) stack.push(cur.items[i]);
    }
    return false;
  }

  mkClo(n, ret, ps, bodyNode) { return asyCloFrom(this, n, ret, ps, bodyNode); }

  /** 上面那条的扫描：体里第一个撞上外层作用域的名字（没有就 null） */
  localFunOuter(n) {
    const own = new Set();
    const ps = asyFormals(this, n.items[3]);
    if (ps !== null) for (const p of ps) own.add(p.name);
    // 写在**方法体**里的那一档（第六十九刀）：接收者也是"外层的一格" —— collections/map.asy:38
    // 的 `this.operator iter()` 写的是显式的 `this`，simplex2.asy 里 `problem` 的
    // `validConstants`/`validVar` 写的是裸字段名（`rows`、`v`、`n`）。两种都得算抓外层，
    // 不然降出来的是个顶层函数、体里却有 `(fld (var this) …)`，方言那边报"未声明的变量 this"。
    // 只在**真有 `this` 那一格**时算（static 方法里没有，plain_bounds.asy:372 那个写在
    // `static void write(extremes)` 体里的 `static void write(coord[])` 就靠这一条留在顶层）。
    const self = this.self !== null && this.lookup('this') !== null;
    const stack = [n.items[4]];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined || cur === null) continue;
      if (isAtom(cur)) {
        const v = cur.value;
        if (typeof v !== 'string' || own.has(v)) continue;
        for (const s of this.scopes) if (s.has(v)) return v;
        // **闭包体里**的那一档（graph.asy:837 的 `void omit(real[] A)` 写在
        // `new tickvalues(tickvalues v){…}` 里，体里用外层函数的形参 `a`/`b`）：进闭包时
        // scopes 换成了空的一层，外层那几层挂在 cap.outer 上，所以要顺着 cap 链再问一遍。
        if (this.capOuterHas(v)) return v;
        // 裸的成员名：`this` 那一格就是要抓的东西
        if (self && this.selfMember(v)) return 'this';
        continue;
      }
      if (!isList(cur)) continue;
      if (self && head(cur) === 'this') return 'this';
      // 里层自己声明的名字也不算：`decidstart` 的名字进 own
      if (head(cur) === 'decidstart' && isAtom(cur.items[1])) own.add(cur.items[1].value);
      for (let i = 1; i < cur.items.length; i++) stack.push(cur.items[i]);
    }
    return null;
  }

  /** 这个名字在**外层闭包**的作用域里有没有（localFunOuter 用它，顺着 cap.prev 一路问） */
  capOuterHas(nm) {
    let c = this.cap === undefined ? null : this.cap;
    while (c !== null && c !== undefined) {
      for (const s of c.outer) if (s.has(nm)) return true;
      c = c.prev;
    }
    return false;
  }

  /** 这个名字是不是当前方法所在记录的一格**实例**成员（字段或非 static 方法）。localFunOuter 用它 */
  selfMember(nm) {
    const rec = this.self.rec;
    for (const f of rec.fields) if (this.fldIs(f, nm)) return true;
    // static 的方法不带接收者，裸写它不算抓外层
    for (const c of this.visibleMethods(rec, nm)) if (c.stat !== true) return true;
    return false;
  }

  methodVal(node, rec, cand, recvCode) {
    const mn = cand.base === undefined ? cand.sym : cand.base;
    for (const p of cand.ps) {
      // 带默认值的方法**也**能当值取出来（与裸函数名那一档同一条，见 nameOf 里第六十刀
      // 那一段）：值的类型是"全部形参"那一份，默认值那几格在值这边就没了 ——
      // `colors=colorstriangular`（three_surface.asy:271）两边都是全形参那一份，通。
      // 通过这个值少给实参才是另一刀（asyFnValCall 那边有它自己的诊断）。
      if (p.rest === true) {
        return this.nope(node, `把可变形参的方法 '${rec.name}.${mn}' 当值取出来`);
      }
    }
    let w = this.mvals.get(cand.sym);
    // **`operator init` 当值取出来**（第六十二刀，collections/map.asy:102 的
    // `((F)map.operator init)()`）：候选那一份的 `ret` 是**记录名**、`sym` 是
    // `asy__ctor_<记录>` —— 那是"造一个新的、调正文、回它"的构造函数，没有接收者。
    // 而 asy 里 `m.operator init` 是**绑在 m 上的那个 void 方法**（量过：
    // `((F)m.operator init)()` 之后 `m.x` 是 3 —— 改的是 m 自己，不是一个新对象）。
    // 正文那一份正是 `asy__ctor_<记录>_body`（第一个形参就是 this，见 asyMethod），
    // 所以这一档换成它、返回类型算 void。
    const isCtor = cand.ctor === true;
    const tgt = isCtor ? `${cand.sym}_body` : cand.sym;
    const vret = isCtor ? 'void' : cand.ret;
    if (w === undefined) {
      // 名字只由**被包的那个方法**决定（cand.sym 已经全局唯一，mvals 也是按它存的），
      // 不再用 mvals.size 那个"第几个用到"的编号 —— 那样同一个库在不同入口里名字会不同。
      w = `asy__mvw_${cand.sym}`;
      const params = [];
      const args = ['(cap asy__recv)'];
      for (const p of cand.ps) {
        params.push(`(${p.name} ${asyCore(p.type)})`);
        args.push(`(var ${p.name})`);
      }
      const call = `(call ${tgt} ${args.join(' ')})`;
      const body = vret === 'void' ? `(expr ${call})` : `(ret ${call})`;
      this.pushWeak(`  (cfn ${w} ((asy__recv ${asyCore(rec.name)})) (${params.join(' ')})`
        + ` ${asyCore(vret)}\n    ${body})`);
      this.mvals.set(cand.sym, w);
    }
    return { code: `(mkclo ${w} ${recvCode})`, type: asyMValType(this, cand) };
  }

  /**
   * `a.get`（不是 `a.get()`）里那个 `get` 是个方法吗？是就回绑好接收者的闭包。
   * 回 undefined 是"这个名字不是方法"（调用处接着往下问字段）；回 null 是诊断已发。
   * **字段先赢**：同名的字段与方法在一个 struct 里是两个成员槽，取值那一边这一层
   * 一直是先看字段的，这一刀不改那个顺序。
   */
  methodValAt(node, recv, nm) {
    const rec = this.records.get(recv.type);
    if (rec === undefined) return undefined;
    for (const f of rec.fields) if (this.fldIs(f, nm)) return undefined;
    const ms = this.visibleMethods(rec, nm);
    if (ms.length === 0) return undefined;
    if (ms.length > 1) {
      // 重载的方法当值取出来：**先不定案**（与重载集同一条，见 asyCoerce 里 mover 那一档）
      return { code: null, type: `<${recv.type}.${nm} 的重载集>`,
        mover: { rec: rec, cands: ms, recv: recv.code, node: node } };
    }
    return this.methodVal(node, rec, ms[0], recv.code);
  }

  /**
   * 这一格字段在**源码里写的名字**是 nm 吗（第四十九刀）。同名的两格字段里后来那份
   * 换了槽名（`asy__fd<K>_名字`），源码里那个名字记在 `src` 上 —— 认名字的地方问这一句。
   */
  fldIs(f, nm) { return f.name === nm || f.src === nm; }

  /**
   * 源码里叫 nm 的**全部**字段格，不是函数类型那些排前面（第四十九刀）。赋值那一路
   * （stmts.js 的 asyAssignFld）拿这一串逐个试 —— three_arrows.asy 里
   * `a.size=min(…)` 要 `real size` 那格，`TeXHead3.size=TeXHead.size` 要函数那格。
   */
  fldCands(t, nm) {
    const rec = this.records.get(t);
    if (rec === undefined || nm === ASY_FILLER) return [];
    const plain = [];
    const fns = [];
    for (const f of rec.fields) {
      if (!this.fldIs(f, nm)) continue;
      if (asyIsFn(f.type)) fns.push(f); else plain.push(f);
    }
    for (const f of fns) plain.push(f);
    return plain;
  }

  recField(n, t, nm) {    const rec = this.records.get(t);
    // 占位字段是**看不见的** —— 名字虽然合法，`x.asy__filler` 在真 asy 那边是没有这个成员，
    // 所以这里也当没有（不然就是收得比 asy 多，strict 那条纪律不许）
    if (nm === ASY_FILLER) return this.err(n, `struct ${t} 没有字段 '${nm}'`);
    // 同名的字段有两格时（第四十九刀，见 recordDec）：取值这一路挑**不是函数类型**那份 ——
    // three_arrows.asy 里 `arrowhead.size > 0` / `a.size=min(…)` 要的都是 `real size`，
    // 而 `a.size(p)` 那种**调用**形态在 calls.js 里另挑函数类型那份。
    let alt = null;
    for (const f of rec.fields) {
      if (!this.fldIs(f, nm)) continue;
      if (!asyIsFn(f.type)) return f;
      if (alt === null) alt = f;
    }
    if (alt !== null) return alt;
    // 名字其实是个**方法**：取值那一边（`a.get`）第四十三刀通了 —— 走 methodValAt，
    // 在这个函数之前问。落到这里的只剩**赋值**那一边（`a.get = h;`）：量过 asy 收它
    // （那边的方法就是一格函数值字段，赋完 `a.get()` 印的是新那份），我们不收 ——
    // 方法在这一层是"多一个 this 形参的普通函数"，没有那一格可以写。所以是 nope。
    if (this.visibleMethods(rec, nm).length > 0) {
      return this.nope(n, `给方法赋值（${t}.${nm} —— asy 那边方法就是一格函数值字段，`
        + '而我们的方法是多一个 this 形参的普通函数，没有那一格）');
    }
    const names = [];
    for (const f of rec.fields) if (f.name !== ASY_FILLER) names.push(f.name);
    return this.err(n, `struct ${t} 没有字段 '${nm}' —— 有的是 ${names.join(' / ')}`);
  }

  /**
   * `new A` 的代码。字段全无默认值时就是 `(cnew A)`；有默认值就走一个生成的构造函数，
   * 因为默认值要**每次构造都重新求**（量过：`struct B { int n = bump(); }`，
   * `new B` 两次之后计数器是 2）。同一个记录只生一份构造函数。
   */
  /**
   * struct 体里的一条语句（第三十六刀）。发到隐式构造那一串里去 —— 它与字段默认值
   * **同一串**，可见位置也按同一条规矩（这一条的成员号）。回 false 表示这一条没降下来。
   */
  recStmt(s, rec, lines, saveSelf) {
    const saveAl = this.recAlias;
    this.self = { rec: rec, mat: s.mat };
    this.recAlias = { map: rec.tyAlias, bi: s.bi === undefined ? 0 : s.bi };
    const out = asyStmt(this, s.node, 'void');
    this.self = saveSelf;
    this.recAlias = saveAl;
    if (out === null) return false;
    for (const l of out) lines.push(l);
    return true;
  }

  recNew(n, t) {
    const rec = this.records.get(t);
    let any = false;
    // 记录类型的字段也算"有默认值"：asy 给它跑一遍 operator init（量过 `struct B { A a; }`
    // 之后 `b.a.y` 是 A 的字段默认值，不是空引用），所以这种记录一定要走构造函数。
    for (const f of rec.fields) if (f.def !== null || this.isRec(f.type)) any = true;
    // 摊出来的那格函数值字段（fnFldOk）也要走生成的构造函数：它的初值是个闭包
    for (const f of rec.fields) if (f.fnbody !== undefined) any = true;
    // struct 体里的语句也算"有话要说"：一个字段都没默认值、但体里有 `write(…)` 时
    // 也得走生成的构造函数（量过它每造一个实例就跑一遍）
    if (rec.stmts !== undefined && rec.stmts.length > 0) any = true;
    if (!any) return `(cnew ${t})`;
    const had = this.recInits.get(t);
    if (had !== undefined) return `(call ${had})`;
    const fname = `asy__new_${t}`;
    this.recInits.set(t, fname);
    // 正在生成构造函数的那些记录（自引用/成环的字段不造，见下面那一段）
    if (this.recBusy === undefined) this.recBusy = new Set();
    this.recBusy.add(t);
    // 构造函数是另一个作用域、另一串语句（与 defWrapper 同一套保存/还原）。
    // `at` 也挪到**这个 struct 的声明处**：字段默认值与内嵌记录该看见谁，是在那里定的
    // （量过：`struct B { A a; }` 写在 `A operator init()` 前面时 `b.a.x` 是 0，
    // 写在后面才是那份构造给的值 —— 所以这一份正文只生成一次是对的）。
    const savePre = this.pre;
    const saveUpd = this.updates;
    const saveScopes = this.scopes;
    const saveAt = this.at;
    const saveSelf = this.self;
    const saveAl = this.recAlias;
    if (rec.at !== undefined) this.at = rec.at;
    this.scopes = [new Map()];
    this.updates = [];
    // 那个局部量就叫 `this` —— 于是字段默认值里的裸字段名（走 `(fld (var this) f)`）
    // 与方法体里那条路一模一样，不用另开一套。量出来的四条正好就是 self 那套规矩：
    //   - `struct S { int x = 1; int y = x + 1; }` -> 2（**前面**的字段看得见）；
    //   - 反序 `int y = x + 1; int x = 1;` -> "no matching variable 'x'"；
    //   - `int y = f(); int f() {…}` 同样报 "no matching variable 'f'"；
    //   - 方法写在前面 `int f() {…} int y = f();` -> 7。
    // 也就是 selfField 的 `f.mat < self.mat` 与 visibleMethods 的 `c.mat <= self.mat`。
    const lines = [`(let this ${t} (cnew ${t}))`];
    this.pre = lines;
    this.declare(n, 'this', t);
    let bad = false;
    // 体里的语句与字段默认值是**同一串**，按成员号（mat）交错着发 —— 那个顺序就是
    // 源码里的顺序（量过：`int x = 1; write("body"); int y = x + 1; x = 5;`
    // 印 body、x 是 5、y 是 2）。
    const sts = rec.stmts === undefined ? [] : rec.stmts;
    let si = 0;
    for (const f of rec.fields) {
      while (si < sts.length && sts[si].mat < f.mat) {
        if (!this.recStmt(sts[si], rec, lines, saveSelf)) { bad = true; break; }
        si++;
      }
      if (bad) break;
      if (f.def === null) {
        // 摊出来的那格函数值字段（fnFldOk）：初值就是"体绑在这个 this 上"的那个闭包。
        // 位置与可见位置跟普通默认值同一条（下面那一段），所以放在这儿。
        if (f.fnbody !== undefined) {
          this.self = { rec: rec, mat: f.mat };
          this.recAlias = { map: rec.tyAlias, bi: f.bi === undefined ? 0 : f.bi };
          const fr = this.type(f.fnbody.items[1], '方法的返回类型');
          const fps = fr === null ? null : asyFormals(this, f.fnbody.items[3]);
          const clo = fps === null ? null : this.mkClo(f.fnbody, fr, fps, f.fnbody.items[4]);
          this.self = saveSelf;
          this.recAlias = saveAl;
          if (clo === null) { bad = true; break; }
          lines.push(`(fldset (var this) ${asyFldSym(f.name)} ${clo.code})`);
          continue;
        }
        // 内嵌的记录：没写默认值也要给它一个**新对象**。走 recInit：文件级的
        // operator init 管得到这一格。
        // 正在造的那个记录**自己**（自引用，见 recordBody 那一条）不造 —— 那一格留空引用，
        // 与 asy 量出来的一样（`a.next.next == null` 是 true）。间接成环（A 里有 B、
        // B 里有 A）也照这一条：recBusy 里有的都不造，不然运行时会一直造下去。
        if (this.isRec(f.type) && !this.recBusy.has(f.type)) {
          const mk = this.recInit(n, f.type);
          if (mk === null) { bad = true; break; }
          lines.push(`(fldset (var this) ${asyFldSym(f.name)} ${mk})`);
        }
        continue;
      }
      // 这一格的可见位置就是它自己的成员号（mat）；体里 `using` 与嵌套 struct 起的名字
      // 按体里的**项**号裁（第三十九刀：`B b = new B;` 里那个 `new B` 走的是 type()，
      // 而 type() 认体内别名要靠 recAlias —— 以前这一串没摆它，于是默认值里用不上）
      this.self = { rec: rec, mat: f.mat };
      this.recAlias = { map: rec.tyAlias, bi: f.bi === undefined ? 0 : f.bi };
      // 花括号初值要**把元素类型带下去**（第六十二刀）：`simplex2.asy:30` 的
      // `var[] v = {VAR_A, VAR_B};` 是一格字段的默认值，走 asyExpr 那一层看不见
      // "我该是 int[]"，报的是"推不出元素类型"。与 vardec 那一侧同一条（见 asyVardec）。
      const lit = asyIsArr(f.type) && isList(f.def) && head(f.def).startsWith('arrayinit')
        ? asyArrLit(this, f.def, f.type) : null;
      const v = lit !== null ? lit
        : asyCoerce(this, asyExpr(this, f.def), f.type, f.def, `字段 '${t}.${f.name}' 的默认值`);
      this.self = saveSelf;
      this.recAlias = saveAl;
      if (v === null) { bad = true; break; }
      lines.push(`(fldset (var this) ${asyFldSym(f.name)} ${v.code})`);
    }
    while (!bad && si < sts.length) {
      if (!this.recStmt(sts[si], rec, lines, saveSelf)) bad = true;
      si++;
    }
    lines.push('(ret (var this))');
    this.recBusy.delete(t);
    this.pre = savePre;
    this.updates = saveUpd;
    this.scopes = saveScopes;
    this.at = saveAt;
    this.self = saveSelf;
    if (bad) {
      // 生成失败时**把缓存那一格撤掉**：不撤的话后面同一个类型再要一次会命中缓存、
      // 拿到 `(call asy__new_T)`，而那份正文压根没发出去 —— 方言那一层报"未声明的函数
      // 'asy__new_autoscaleT'"（量出来的：examples/dimension.asy，探路那一趟里
      // autoscaleT 的构造生成失败、回滚之后真降那一趟就命中了这个空壳）。
      this.recInits.delete(t);
      return null;
    }
    const text = [`  (fn ${fname} () ${t}`];
    for (const s of lines) text.push(`    ${s}`);
    this.pushWeak(`${text.join('\n')})`);
    return `(call ${fname})`;
  }

  /**
   * "声明一个 T"该造什么（第二十二刀）：此处可见的文件级 `T operator init()` 顶替整个
   * 隐式构造，没有就是 recNew 那份。两者的分界是量出来的：
   *   - `A a;` 与**内嵌记录字段**走这一条；
   *   - `new A`（显式）与构造调用 `A(…)` 走 recNew —— 量过 `A(3)` 拿到的是字段默认值
   *     而不是文件级 operator init 的结果，`A r = new A;` 同理（所以那份 operator init
   *     的体里写 `new A` 不会递归）。
   */
  recInit(n, t) {
    const rec = this.records.get(t);
    // 别的模块里声明的 struct（第二十五刀）：`T t;` 该造什么是在**那个模块**里定的 ——
    // 字段默认值、内嵌记录、文件级 operator init 都是那边的名字，所以换到那个单元里问。
    if (rec !== undefined && rec.unit !== this.unit.id) {
      const prev = this.unitIn(this.units[rec.unit]);
      // 文件级 `operator init` 按**那个单元整份**问，不是按 struct 声明处（第七十九刀）：
      // plain_picture.asy:65 的 `struct scaleT` 与 :83 的 `scaleT operator init()` 一前一后，
      // 按声明处问就看不见 :83 那份 —— graph.asy:5 的 `scaleT Linear;` 于是拿到 T/Tinv
      // 都是 null 的一份，logdown.asy 那句 `Linear.T(x)` 在运行时报
      // "call of a null function value"（量过 asy：`import graph; scaleT s; s.T(3.0)` 印 3）。
      // import 把整份模块的名字都带过来，位置不参与，所以这里用单元末尾那个位置（unitIn
      // 给的就是它）。字段默认值那一份照旧按 struct 声明处（下面把 at 拨回 rec.at）。
      const oi = asyOinitFor(this, t);
      this.at = rec.at;
      const out = oi !== null ? `(call ${oi.sym})` : this.recNew(n, t);
      this.unitOut(prev);
      return out;
    }
    return this.recInitHere(n, t);
  }

  recInitHere(n, t) {
    const oi = asyOinitFor(this, t);
    if (oi !== null) return `(call ${oi.sym})`;
    return this.recNew(n, t);
  }

  /** 这个类型在**当前位置**有文件级 `operator init` 吗（stmts.js 的函数类型那一支用） */
  oinitFor(t) { return asyOinitFor(this, t); }

  /** `(name x)` -> 'x'；`(qualified ...)` 与算符名（`operator +`）都回 null */
  plainName(node) {
    if (!isList(node) || head(node) !== 'name') return null;
    const a = node.items[1];
    if (!isAtom(a)) return null;
    if (a.value.startsWith('operator ')) return null;
    return a.value;
  }

  /* ---------------------------------------------------------------- 表达式 */

  /*
   * 表达式那一族搬到 exprs.js 去了。下面这十七个是**转接**：自举那条路的模块加载器
   * 禁止 import 成环（link.js 报 "import cycle through"），而 calls.js / stmts.js 都要调
   * 表达式这一族，exprs.js 又要调它们两个 —— 所以反向那几条边不走 import，走这一层。
   * 每个都是一行，没有别的逻辑；家族文件里写的是 `L.expr(n)`，落到这里再转出去。
   */
  expr(n) { return asyExpr(this, n); }
  overPick(r, want) { return asyOverPick(this, r, want); }
  candFnType(c) { return asyCandFnType(this, c); }
  overArg(node) { return asyOverArg(this, node); }
  promote(a, b) { return asyPromote(this, a, b); }
  toPair(v) { return asyToPair(this, v); }
  coerce(v, want, node, what) { return asyCoerce(this, v, want, node, what); }
  condAt(cond, want) { return asyCondAt(this, cond, want); }
  dotQual(node) { return asyDotQual(this, node); }
  pairCall(n, nm) { return asyPairCall(this, n, nm); }
  pairArith(n, op, a, b) { return asyPairArith(this, n, op, a, b); }
  tripleArith(n, op, a, b) { return asyTripleArith(this, n, op, a, b); }
  lengthCall(n) { return asyLengthCall(this, n); }
  lengthOf(v, at) { return asyLengthOf(this, v, at); }
  strCall(n, nm) { return asyStrCall(this, n, nm); }
  strConvCall(n) { return asyStrConvCall(this, n); }
  arrLit(n, t) { return asyArrLit(this, n, t); }
  arrMethod(n, recv, nm) { return asyArrMethod(this, n, recv, nm); }


  /* 调用与重载解析那一族搬到 calls.js 去了：那些函数的第一个形参 `L` 就是这个降级器。 */

  /* 语句那一族（write / 循环 / 变量声明 / 赋值）搬到 stmts.js 去了，拆法同 calls.js。 */

  /* ---------------------------------------- 模块与顶层声明：那两族的转接 */

  /*
   * 模块那一族在 modules.js、顶层声明那一族在 decls.js。这十个也是转接，理由同上面
   * 那一段：家族文件之间要互相调，而加载器禁止 import 成环。
   * `declPass` 那一条方向特别值得记：modules.js 加载一个模块要先给它跑一遍声明遍，
   * 而 decls.js 自己又要 import modules.js 的三个 —— 所以这一条只能走转接。
   */
  modAlias(node) { return asyModAlias(this, node); }
  /** 匿名函数体里问一个外层局部量（回 `(cap 名)` / CAP_BAD / null），见 capOf 的头注释 */
  capOf(n, nm) { return asyCapOf(this, n, nm); }  capSlot(nm, ov) { return asyCapSlot(this, nm, ov); }
  modVar(n, mq) { return asyModVar(this, n, mq); }
  modCall(n, mq) { return asyModCall(this, n, mq); }
  // 语句位置的 `access m;` / `from m access x;`（stmts.js 用）。走转接是因为 modules.js
  // 要 import calls.js，而 stmts.js 直接 import modules.js 会让 exprs -> stmts -> modules
  // 这一串成环（自举那条路的加载器禁止环，量到的是 exprs.js 上那句 "import cycle through"）。
  modStmt(n, at) { return asyModStmt(this, n, at); }
  // 同一条理由（stmts.js 用）：装不装箱这一问的实现在 exprs.js 里，而 exprs.js 本来就
  // import stmts.js —— stmts.js 再直接 import 回去就是 exprs <-> stmts 那个环
  // （自举那条腿的加载器禁止环，报的是 exprs.js 上那句 "import cycle through"）。
  needsBox(nm) { return asyNeedsBox(this, nm); }
  declPass(u) { return asyDeclPass(this, u); }
  castFor(to, from, allowEc) { return asyCastFor(this, to, from, allowEc); }
  formals(node) { return asyFormals(this, node); }
  fnTypeOf(ret, formalsNode, at) { return asyFnTypeOf(this, ret, formalsNode, at); }
  gvarHere(nm) { return asyGvarHere(this, nm); }
  gvarAt(nm) { return asyGvarAt(this, nm); }
  gvarFor(nm, want) { return asyGvarFor(this, nm, want); }

  /** 同名的文件级变量在这里看得见不止一格（asy 里它们按签名分得开） */
  gvarMany(nm) {
    const list = this.globals.get(nm);
    if (list === undefined) return false;
    let k = 0;
    for (const g of list) if (g.at <= this.at && g.ok) k++;
    return k > 1;
  }

  /**
   * 试着求一下这个表达式的**类型**（诊断与前置语句都回滚，不留痕）。求不出回 null。
   * 用在"同名好几格、要靠右边的类型定案"那一档（见 assign 里的 gvarFor）。
   */
  probeType(node) {
    // `pre` 不是数组时（文件级那一层）也照样探：现给一个空的当垫子，探完丢掉 ——
    // 与 namedBuiltin 那边同一个路子。plain_Label.asy:688 的 `texpath=new path[](…)`
    // 就在文件级，不给垫子就探不出类型来，同名的两格挑不动。
    const mark = this.diags.mark();
    const savePre = this.pre;
    this.pre = [];
    const v = this.expr(node);
    this.pre = savePre;
    this.diags.rollback(mark);
    return v === null || v.type === undefined ? null : v.type;
  }

  gvarLate(node, nm) { return asyGvarLate(this, node, nm); }

  /**
   * 主文件当模块看时的名字（去掉目录与 `.asy`）。只有 autoplain 那一条判据用它 ——
   * 直接编 `plain.asy` / `plain_pens.asy` 自己时不能再给它自动引一次 plain。
   */
  rootModName() {
    const p = this.opts === null || this.opts.path === undefined ? '' : this.opts.path;
    let i = p.length - 1;
    while (i >= 0 && p.charAt(i) !== '/' && p.charAt(i) !== '\\') i--;
    const base = p.slice(i + 1);
    return base.endsWith('.asy') ? base.slice(0, base.length - 4) : base;
  }


  /**
   * 一批顶层项 -> 只含**这一批新增内容**的核心方言文本。
   * 整份文件（run）是"只有一批"的特例：那时所有的 base 都是 0，输出与从前逐字节一样。
   *
   * REPL 的增量在这一层是"发 delta"：记录、`(global …)`、helper、数组工厂、包装函数
   * 都只发这一批新出来的，函数体也只有这一批的。跨批可见性靠两样东西：单元 0 的那几张
   * 表（funcs/globals/recVis…）一直活着，以及 `atOff` —— 顶层项的下标接着往下数。
   */
  chunk(tree) {
    const baseUnits = this.units.length;
    const baseRecords = this.records.size;
    const baseGdecls = this.gdecls.length;
    const baseWraps = this.wraps.length;
    const baseUsed = new Set(this.used);
    const baseArr = new Set(this.arrGen.keys());
    let root;
    if (baseUnits === 0) {
      root = this.unitNew(tree, this.opts === null ? '' : this.opts.path);
      root.file = this.opts === null ? '' : this.opts.path;
      // **主文件也隐式 `import plain;`**（第七十刀）：真 asy 那边 `write(cm);` 不用引任何
      // 东西就能跑 —— plain 是自动引进来的，`-noplain` 才关掉。以前只有**被加载的模块**
      // 走 autoplain（asyModLoadAs 里那一句），主文件没有，于是引真 base 时
      // `size(0,22cm)` 报"未声明的变量 'cm'"。名字用文件名去掉目录与后缀：直接编
      // `plain.asy` 自己时 asyAutoPlain 那条按名字的排除就还管用。
      // 找不到 plain.asy 时 asyAutoPlainIn 会回滚，与从前一样（我们自己的 lib/asy 里没有
      // plain.asy，所以不带 ASYMPTOTE_DIR 跑测试时行为一字不变）。
      root.aplain = asyAutoPlain(this, this.rootModName());
    } else {
      // 会话根是同一个单元 0（前缀是空串、名字表一直活着），换掉的只有"这一批的顶层项"。
      // 方法体与 autounravel 那两张表也清空：上一批的已经发过了，重发就是重复定义。
      root = this.units[0];
      root.rs = this.flat(tree, 'block');
      root.callAt = new Map();
      root.methodDecls = [];
      root.auFns = [];
    }
    this.unitIn(root);
    asyDeclPass(this, root);
    // **产物还在、源文件没动的那几个库，正文一步都不降**（第七十六刀）。
    //
    // 量出来的账（unitcircle.asy，缓存全热）：整个前端 645ms 里 declPass 占 221ms、
    // 13 个库的 asyBodyPass 占 368ms —— 而后者降出来的东西**逐字节等于**盘上已经躺着的
    // `plain.sx`/`plain_bounds.sx`/…（前面量过：一个库在哪个入口底下都是同一份）。
    // 声明遍那一半省不掉（入口要那些表才编得动），正文这一半是纯白付。
    //
    // 跳过一个单元意味着这一趟**不为它发任何顶层项**：它的类、全局、函数、包装都在
    // 盘上那份产物里。链接那一层要的只是"它定义了哪些名字、签名长什么样"，那份签名清单
    // 由 cli.js 从旁边的 `.sec` 读回来（见 asyUnitModules 的 sections.skipped）。
    const skipFn = this.opts === null || this.opts === undefined
      || this.opts.skipBody === undefined || this.opts.skipBody === null ? null : this.opts.skipBody;
    const skipped = new Map();
    if (skipFn !== null) {
      for (const u of this.units) {
        if (u.id === 0 || u.id < baseUnits) continue;
        const c = skipFn({
          key: u.key, file: u.file, tpl: u.tpl !== null, init: u.init, ran: u.ran,
        });
        if (c !== null && c !== undefined) { skipped.set(u.id, c); u.frozen = true; }
      }
    }
    // 正文：按加载顺序一个单元一遍（declPass 里的递归加载已经把 units 填全了）。
    // 方法体在每个单元里先发：它们只依赖记录声明，而文件级函数的正文可能调到方法。
    const fns = [];
    const fnUnit = [];            // 与 fns 同长：每一项归哪个单元
    let main = [];
    for (const u of this.units) {
      if (u.id !== 0 && u.id < baseUnits) continue;   // 前面几批加载过的模块不重发
      if (skipped.has(u.id)) continue;                // 产物还在的库：正文不降
      const prev = this.unitIn(u);
      const at0 = fns.length;
      const stmts = asyBodyPass(this, u, fns);
      if (u.id === 0) main = stmts;
      else fns.push(this.initFn(u, stmts));
      for (let i = at0; i < fns.length; i++) fnUnit[i] = u.id;
      this.unitOut(prev);
    }
    // 分段（第八十几刀）：发出去的每一项先归到它的单元，一个库文件一段。
    // 这一步只是把从前那一坨按单元分好并按单元号拼回去 —— 下一步 cli.js 就能把每一段
    // 单独存成"这个库的产物"（按文件名），跨入口复用。weak 那一档不归任何单元。
    const secs = new Map();
    const sec = (id) => {
      let s = secs.get(id);
      if (s === undefined) { s = { cls: [], glb: [], fns: [], wraps: [] }; secs.set(id, s); }
      return s;
    };
    for (const u of this.units) {
      if (u.id === 0 || (u.id >= baseUnits && !skipped.has(u.id))) sec(u.id);
    }
    // 这一趟每个单元**有没有自己那份产物**，没有的话是哪一条挡的（cli.js 按
    // `OMNI_ASY_UNITS=1` 打印）。量出来的账：probe.asy 那一趟只有 **11 个单元**
    // （10 份库 + 入口），而日志里 `asy ast cache` 出现了 20 多次 ——
    // plain_constants / plain_pens / plain_picture / plain_Label / plain_shipout /
    // plain_scaling 那十几份**压根不是单元**（并进 plain 那一份里了），所以它们不可能有
    // 自己的 `.aif`：从 plain 的接口索引重放 import 时，这几份还是要**重新读源码**。
    // 这是"改一个字符还要 787ms"里剩下那一段的去处（ADR-0015 背景第 2 条）。
    const unitWhy = [];
    for (const u of this.units) {
      unitWhy.push({
        id: u.id,
        key: u.key,
        why: secs.has(u.id) ? '有产物'
          : (u.id !== 0 && u.id < baseUnits ? `前一批加载的（id ${u.id} < ${baseUnits}）`
            : (skipped.has(u.id) ? '正文跳过（盘上那份还算）' : '不发')),
      });
    }
    const weak = [];
    // 盘上那几份产物**已经引着**的 weak 项：这一档不能跟着入口走（见 link.js 那一节
    // "只有入口才引的那些 weak 项"）—— 它们的 `.js` 是上一趟编的，import 写死了
    // `from './omni_weak.js'`。
    const weakLib = [];
    // 跳过正文的那几份：它们的产物里引到的 weak 项从盘上拿回来（`.wk`）。
    // 不拿的话那几份 `.js` 一 import 就是"未声明"—— 它们的 `(sig "omni_weak" …)`
    // 是上一趟编出来的，指着的东西这一趟没人生。按名字去重在链接那一层（asyUnitModules）。
    for (const id of [...skipped.keys()].sort((a, b) => a - b)) {
      for (const t of skipped.get(id).weak) { weak.push(t); weakLib.push(t); }
    }
    // 记录按**声明顺序**发（字段里不许再有记录，所以这就是最终顺序）
    let ri = 0;
    for (const rec of this.records.values()) {
      if (ri++ < baseRecords) continue;
      if (skipped.has(rec.unit)) continue;   // 它那份产物里已经有了
      const fs = [];
      for (const f of rec.fields) fs.push(`(${asyFldSym(f.name)} ${asyCore(f.type)})`);
      sec(rec.unit).cls.push(`  (class ${rec.name} ${fs.join(' ')})`);
    }
    // 模块跑过了没有（第二十五刀）：`import m; import m;` 只跑一遍体，量过
    for (const u of this.units) {
      if (u.id < baseUnits || u.ran === null || skipped.has(u.id)) continue;
      sec(u.id).glb.push(`  (global ${u.ran} bool)`);
    }
    // 文件级变量（第二十四刀）：按声明顺序的一批 `(global …)`。零初始化，
    // 真正的初值是 `(main …)` 里那一句 `(set …)` —— 位置就是源码里的位置，
    // 所以「初值在那一行求」这条 asy 语义是照搬的，不是模拟的。
    for (let i = baseGdecls; i < this.gdecls.length; i++) {
      const g = this.gdecls[i];
      const gu = g.unit === undefined ? 0 : g.unit;
      if (skipped.has(gu)) continue;   // 它那份产物里已经有了
      sec(gu).glb.push(`  (global ${g.sym} ${asyCore(g.type)})`);
    }
    for (const [hnm, text] of HELPERS) {
      if (this.used.has(hnm) && !baseUsed.has(hnm)) weak.push(text);
    }
    // 元素是记录的数组 helper：正文是降级过程中按同一个工厂生成的，顺序按第一次用到
    for (const [akey, text] of this.arrGen) {
      if (!baseArr.has(akey)) weak.push(text);
    }
    for (let i = 0; i < fns.length; i++) sec(fnUnit[i]).fns.push(fns[i]);
    // 默认实参的包装：正文是降级过程中生成的，所以只能在这里发（顺序按第一次用到）
    for (let i = baseWraps; i < this.wraps.length; i++) {
      const w = this.wraps[i];
      // 归属那个单元被跳过了的（默认实参那一段里的匿名函数：降它的时候 L.unit 换成了
      // **被调方**，见 asyDefWrapper 的 unitIn）—— 归共用那一份。名字只由内容决定，
      // 所以与盘上那份产物里的同名项是同一段代码，链接那一层按名字去重。
      if (w.u < 0 || skipped.has(w.u)) weak.push(w.t);
      else sec(w.u).wraps.push(w.t);
    }
    const ids = [...secs.keys()].sort((a, b) => a - b);
    const out = ['(module'];
    for (const id of ids) for (const x of secs.get(id).cls) out.push(x);
    for (const id of ids) for (const x of secs.get(id).glb) out.push(x);
    for (const x of weak) out.push(x);
    for (const id of ids) for (const x of secs.get(id).fns) out.push(x);
    for (const id of ids) for (const x of secs.get(id).wraps) out.push(x);
    // 下一步（按文件名存产物）要的就是这张表：单元 -> 它自己那几段 + 共用的 weak
    const keys = new Map();
    // 库的**接口索引**（第七十八刀）：这一趟真降过的库单元各出一份，落到盘上叫 `.aif`。
    // 下一个例子引到同一个库时靠它，源码与树都不再碰（见 iface.js 那段账）。
    const pack = this.opts === null || this.opts === undefined
      || this.opts.astPack === undefined || this.opts.astPack === null
      ? null : this.opts.astPack;
    for (const u of this.units) {
      if (!secs.has(u.id) && !skipped.has(u.id)) continue;
      let iface = null;
      if (pack !== null && u.id !== 0 && u.key !== '' && !skipped.has(u.id)
        && u.fromIface !== true) {
        const d = asyIfaceDump(this, u, pack);
        if (!d.bad) iface = d.obj;
      }
      keys.set(u.id, {
        key: u.key, file: u.file, tpl: u.tpl !== null, init: u.init, ran: u.ran, iface,
        // 指纹要的是**源侧**的依赖图（ADR-0015 决策 1）：这一份 import 了哪几个源文件。
        // 与"这一趟的入口是谁""这一趟哪几份被跳过"都无关 —— 这正是旧那套 `.stamp`
        // 做不到的一点（它记的是链接算出来的 deps，跟着跳过与否变）。
        imps: u.imps === undefined || u.imps === null ? [] : u.imps.map((im) => im.key),
        // `include` 摊进来的那几个文件（这一刀）：印记少了它们就会复用旧代码
        inc: u.inc === undefined || u.inc === null ? [] : u.inc,
      });
    }
    this.sections = { ids, secs, weak, weakLib, keys, main, tail: '', skipped, unitWhy };
    const body = [];
    for (const s of main) body.push(`    ${s}`);
    // 退出钩子（`atexit(f)` 存下来的那一个）在这里放：main 的最后一句。
    // asy 那边的隐式 shipout 全靠它 —— plain.asy:53-62 的 exitfunction 里
    // `if(!currentpicture.empty()) shipout();`，而 plain_shipout.asy:104 那道
    // `!implicitshipout && defaultprefix` 的门闩意味着**只有**退出时那一次
    // 才真的走到 `_shipout`（显式写 `shipout(currentpicture)` 会在那儿 return）。
    // 所以没有这一句，例子跑完一张 EPS 都不出。
    const ex = this.tailExit === true ? this.exitCall() : null;
    if (ex !== null) body.push(`    ${ex}`);
    this.sections.tail = ex === null ? '' : ex;
    out.push(`  (main${body.length === 0 ? '' : `\n${body.join('\n')}`}))`);
    // 下一批的顶层项从这一批之后接着数
    this.atOff = this.atOff + root.rs.length;
    return out.join('\n') + '\n';
  }

  /** 整个程序 -> 核心方言文本。函数提到模块层，主文件剩下的语句进 (main ...)。 */
  run(tree) {
    this.tailExit = true;
    return this.chunk(tree);
  }

  /**
   * main 末尾那一句"跑退出钩子"。名字按 asy_builtins.asy 里的 `asy__atexitrun` 查，
   * 查不到（比如单独测某个不引 builtins 的片段）就回 null —— 那时一句也不发，输出与从前一样。
   */
  exitCall() {
    const list = this.funcs.get('asy__atexitrun');
    if (list === undefined) return null;
    for (const c of list) if (c.params.length === 0) return `(expr (call ${c.sym}))`;
    return null;
  }

  /**
   * 攒一份包装/提上来的函数，并记下它**归哪个单元**。不给 `u` 就是当前单元。
   * 归属决定了它进哪一份产物：默认实参的包装归**被调方**的单元（名字也只由被调方与缺的
   * 那几格决定），所以同一个库不论被谁引，那份产物都一样 —— 这是"一个库一个 js"的前提。
   */
  pushWrap(text, u) {
    this.wraps.push({ u: u === undefined ? this.unit.id : u, t: text });
  }

  /** 名字只由内容决定的那一档（内建数学包装、方法值包装、隐式构造）：链接时按名字去重。 */
  pushWeak(text) {
    this.wraps.push({ u: -1, t: text });
  }

  /**
   * 模块的初始化函数：那份文件的顶层语句。开头那两句是"只跑一次"的门闩 ——
   * 量过 `import m; import m;` 只印一遍，而同一个模块被两个模块 import 时
   * 调用点有两处，所以这道门闩得在运行期。
   */
  initFn(u, stmts) {
    const lines = [`  (fn ${u.init} () void`];
    lines.push(`    (if (var ${u.ran}) (do (ret)))`);
    lines.push(`    (set ${u.ran} (bool true))`);
    for (const s of stmts) lines.push(`    ${s}`);
    return `${lines.join('\n')})`;
  }
}

/**
 * asy 语法树 -> 核心方言文本。
 * @param {any} tree glrParse 出来的那棵树（asy.grammar 的 file 规则）
 * @param {import('../source/diag.js').Diagnostics} diags
 * @param {{path: string, load: (name: string) => any}} [opts] 模块加载器（第二十五刀）
 * @returns {string} 核心方言源文本（诊断有错时内容不可用）
 */
export function lowerAsy(tree, diags, opts, out) {
  const L = new AsyLower(diags, opts);
  const text = L.run(tree);
  // 分段（一个源文件一份产物）：要的人自己传一格进来接，不传就与从前一字不差
  if (out !== undefined && out !== null) out.sections = L.sections;
  return text;
}

/**
 * 值是**数组**的那几张表拷一份：容器各自新的，里面的记录共用。
 *
 * funcs / globals / casts / oinits / tyAlias 都是 `list = m.get(k) ?? []; list.push(g);
 * m.set(k, list)` 这么攒的 —— 只 `new Map(m)` 的话数组还是**同一个**，后来 push 进去的那一格
 * 会从快照的背面漏回去。量出来的样子：上一段代码里的 `real[] W` 到下一段还看得见，
 * 于是 `label("$B$",b,W)` 报「没有能匹配 label(string, pair, real[])」。
 */
function copyAsyLists(m) {
  const out = new Map();
  for (const [k, list] of m) out.set(k, [...list]);
  return out;
}

/**
 * asy 的增量会话（REPL）。
 *
 * 只管前半段：一批语法树 -> 只含这一批新增内容的核心方言文本。后半段（方言 -> OIR 的
 * 增量、跨批可见性、失败回滚）在 sexpr/lower.js 的 CoreSession 上，那一层是所有语法驱动
 * 前端共用的 —— 这就是"新语言从语法来"这条路上 REPL 不用各写一遍的地方。
 *
 * 失败要能回到上一批成功的样子：这一层的改动都是"往表里加"，所以复原容器就够
 * （单元 0 的那几张表 + 模块级的记录/全局/helper/包装）。
 */
export class AsySession {
  constructor(opts) {
    this.lw = new AsyLower(null, opts);
    this.lw.sessionRoot = true;
  }

  snapshot() {
    const l = this.lw;
    const u = l.units.length === 0 ? null : l.units[0];
    return {
      units: [...l.units],
      u0: u === null ? null : {
        u: u,
        funcs: copyAsyLists(u.funcs), globals: copyAsyLists(u.globals), recVis: new Map(u.recVis),
        mods: new Map(u.mods), oinits: copyAsyLists(u.oinits), oiByNode: new Map(u.oiByNode),
        casts: copyAsyLists(u.casts), castByNode: new Map(u.castByNode), at: u.at,
        tyAlias: copyAsyLists(u.tyAlias),
      },
      records: new Map(l.records), recInits: new Map(l.recInits), byKey: new Map(l.byKey),
      gdecls: [...l.gdecls], wraps: [...l.wraps], wrapNames: new Map(l.wrapNames),
      used: new Set(l.used), arrGen: new Map(l.arrGen),
      // 这几张也是**跨单元攒着**的（第七十三刀补齐）：fnDefs 里存的是默认值**节点**，
      // 漏了它，快照回滚之后还会拿着上一段代码的节点去降默认值 —— 诊断于是落在
      // 另一个文件的位置上（量出来的样子是一个例子报出另一个例子里的错）。
      fnDefs: new Map(l.fnDefs), mvals: new Map(l.mvals),
      methodDecls: [...l.methodDecls], auFns: [...l.auFns],
      castNo: l.castNo, atOff: l.atOff,
    };
  }

  /**
   * 一份快照的拷贝。
   *
   * 同一张快照要**回滚多次**时必须先拷（快扫里 220 个例子都从同一张镜像起降）：restore 之后
   * 各表是直接拿去改的，不拷就等于把上一个例子的声明记进了镜像。拷的粒度与 snapshot 一样 ——
   * 容器新的，里面的单元/记录/候选对象共用。
   */
  cloneSnap(s) {
    const u = s.u0;
    return {
      units: [...s.units],
      u0: u === null ? null : {
        u: u.u,
        funcs: copyAsyLists(u.funcs), globals: copyAsyLists(u.globals), recVis: new Map(u.recVis),
        mods: new Map(u.mods), oinits: copyAsyLists(u.oinits), oiByNode: new Map(u.oiByNode),
        casts: copyAsyLists(u.casts), castByNode: new Map(u.castByNode), at: u.at,
        tyAlias: copyAsyLists(u.tyAlias),
      },
      records: new Map(s.records), recInits: new Map(s.recInits), byKey: new Map(s.byKey),
      gdecls: [...s.gdecls], wraps: [...s.wraps], wrapNames: new Map(s.wrapNames),
      used: new Set(s.used), arrGen: new Map(s.arrGen),
      fnDefs: new Map(s.fnDefs), mvals: new Map(s.mvals),
      methodDecls: [...s.methodDecls], auFns: [...s.auFns],
      castNo: s.castNo, atOff: s.atOff,
    };
  }

  restore(s) {
    const l = this.lw;
    l.units = s.units;
    l.records = s.records;
    l.recInits = s.recInits;
    l.byKey = s.byKey;
    l.gdecls = s.gdecls;
    l.wraps = s.wraps;
    l.wrapNames = s.wrapNames;
    l.used = s.used;
    l.arrGen = s.arrGen;
    if (s.fnDefs !== undefined) l.fnDefs = s.fnDefs;
    if (s.mvals !== undefined) l.mvals = s.mvals;
    if (s.methodDecls !== undefined) l.methodDecls = s.methodDecls;
    if (s.auFns !== undefined) l.auFns = s.auFns;
    l.boxMemo = undefined;   // 装箱判据的备忘（按 fnBody 索引，回滚之后重算）
    l.castNo = s.castNo;
    l.atOff = s.atOff;
    if (s.u0 === null) {
      l.unit = null;
      return;
    }
    const u = s.u0.u;
    u.funcs = s.u0.funcs;
    u.globals = s.u0.globals;
    u.recVis = s.u0.recVis;
    u.tyAlias = s.u0.tyAlias;
    u.mods = s.u0.mods;
    u.oinits = s.u0.oinits;
    u.oiByNode = s.u0.oiByNode;
    u.casts = s.u0.casts;
    u.castByNode = s.u0.castByNode;
    u.at = s.u0.at;
    // 当前那几张表是单元里那几张的别名（见 unitIn），所以两边都要摆回去
    l.unit = u;
    l.funcs = u.funcs;
    l.globals = u.globals;
    l.recVis = u.recVis;
    l.tyAlias = u.tyAlias;
    l.mods = u.mods;
    l.oinits = u.oinits;
    l.oiByNode = u.oiByNode;
    l.casts = u.casts;
    l.castByNode = u.castByNode;
    l.at = u.at;
  }

  /** 一批语法树 -> 这一批的核心方言文本 */
  add(tree, diags) {
    this.lw.diags = diags;
    return this.lw.chunk(tree);
  }
}
