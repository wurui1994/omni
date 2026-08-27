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
// 两个模块里同名的 struct、给别的模块的 struct 写文件级 `operator init`、
// `m.x = …`（限定名当赋值目标））。
//
// **`explicit` 形参**（第二十六刀：`void p(explicit real r)` 这个槽只收类型一模一样的
// 实参 —— 量过它连内建的 int->real 提升都挡，而且**不进签名身份**（同签名的第二份还是
// 替换）。降级要做的只有两件：formals 记个标记、fit 多问一句）。
// **用户定义的转换**（第二十七刀：`T operator cast(S)` 管所有隐式位置、`operator ecast`
// 只管 `(T) x`。它原来在门外，理由是会改**重载解析的打分**；量清了才收：跟内建提升
// **同价**（打平就是 ambiguous）、而且**不串**（源类型必须一模一样），见 castSig）。
// **`autounravel`**（第二十八刀：struct 体里带它的声明其实是**文件级**的声明 ——
// 形参显式、没有 this，可见位置是那个 struct 的位置，见 auMod）。
// **函数类型**（`real f(real)` 这种形参、`f(v)` 的间接调用、裸函数名当值用、
// 以及函数值类型的**变量**（`real f(real) = twice;` 与 typedef 拼的那一份走同一条路）——
// 类型全是字符串，所以它就是 `R(P,…)` 那个拼法，见 asyIsFn / fnTypeOf / fnValCall）。
// **typedef 与 `using`**（别名表 tyAlias：名字 -> 一串 {t, at}，`t` 是已经解析好的类型
// 字符串，type() 一查就换掉 —— asy 的 typedef 不造新类型，所以"换掉"就是全部语义。
// 存一串是因为同一个名字可以 typedef 多次，而名字解析是顺序的，见 aliasAt）。
//
// 不支持（见到就报错，报错里说清是哪一条）：标准库模块（`import graph;`）、
// 把**方法**取出来当值（`int f() = a.get;` —— asy 收，那是绑住接收者的闭包；
// 我们的方法是"多一个 this 形参的普通函数"，绑接收者要现造闭包。recField 里那句 nope，
// `bad/fn-value` 钉着）、
// 给切片赋值（`a[0:2] = b`）、
// 字符串的 `reverse`（asy 是**按字节**倒的，而 Omni 的 string 是 UTF-8 字节序列
// （ADR-0005）—— 非 ASCII 倒过来在 C 那条腿上是一串坏字节，在 JS 那条腿上要看
// 宿主怎么处理，"六条腿逐字节相同"这句话就保不住了，所以门外）、
// 字符串的 `insert`/`split`（`insert` 要的 `substr` 拼接现成，但 asy 的越界行为
// 还没量全；`split` 要 `string[]` 的返回值，那条路还没走通）、
// 循环条件里的 `?:`（摊出来的赋值只能落在循环外面，条件就只
// 算一次了 —— 语义会变，所以报错而不是悄悄换个意思）、
// struct 的这三条边界（每条都有 bad/ 用例钉着）：**自引用**字段
// （`struct A { A next; }` —— asy 收，我们不收，见下面的差别一节）、
// 把方法**当值**取出来（`int f() = a.get;` —— asy 收，那是绑住接收者的闭包；
// 我们的方法是"多一个 this 形参的普通函数"，而核心方言里函数不是值）、
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

import { isList, isAtom, isStr, head } from '../sexpr/read.js';

/** 所有「这一刀还没做」的报错都带上这句 —— 测试轴按它判「拒得对不对」 */
export const ASY_NOPE = 'asy 前端第一刀还不支持';

const SCALARS = new Set(['int', 'real', 'bool', 'string']);

/** dotQual 的第三种答案："是带点的名字，但接收者那一层已经报过错了" */
const DOT_BAD = { bad: true };

/** 模块相关的顶层声明（第二十五刀）。认得的是前三条，后面几条在 modStmt 里报"还没做" */
const ASY_MODSTM = new Set(['import', 'access', 'from-access', 'unravel', 'include',
  'template-access', 'receive-typedef']);

/** 能当数组元素的**内建**类型。pair 是第八刀加的（核心方言的 `(arr T)` 现在收向量元素）；
 *  记录（struct）是第十九刀加的，但它不在这个表里 —— 记录是逐文件声明的，问 isRec。
 *  数组也不在里面 —— 多维数组那一刀问的是 arrElemOk（它对元素递归）。 */
const ASY_ARRELEM = new Set(['int', 'real', 'bool', 'string', 'pair', 'triple']);

/** 数组元素这一刀收的东西写成一句话，四处报错共用（免得四处各写一遍走样） */
const ASY_ARRELEM_TEXT = '数组元素这一刀只有 int/real/bool/string/pair/triple、struct 与它们的数组';

/**
 * 实参类型 -> 形参类型要走几次隐式转换：0 = 同型，1 = 一次转换，-1 = 不行。
 * 表就是 asy 的那三条（int->real、int/real->pair，见 coerce）。重载解析按这个打分：
 * 同型优先，两个候选各要一次转换就是歧义（量过 asy 也报 ambiguous）。
 * 名字带 asy 前缀是封闭 ABI 的要求：模块级名字全仓唯一。
 */
function asyConvCost(from, to) {
  if (from === to) return 0;
  if (from === 'int' && to === 'real') return 1;
  if (to === 'pair' && (from === 'int' || from === 'real')) return 1;
  return -1;
}


/** 算符文本。语法模板里有两种写法：`(bin "+" …)` 给的是字符串节点，
 *  `(self $2 $1 $3)` 直接把 SELFOP **词法 token**（原子）搬过来。两种都要认。
 *  名字带 asy 前缀是封闭 ABI 的要求：模块级的名字全局唯一（mir/print.js 已有一个 opText）。 */
const asyOpText = (n) => (isStr(n) || isAtom(n) ? n.value : null);

/**
 * 能重载的算符 -> 生成的函数名片段（第二十三刀）。`V operator +(V,V)` 降成一个普通函数
 * `asy__op_add`，重载解析那一套（第十一刀）因此白捡 —— asy 里算符本来就是"名字叫
 * `operator +` 的函数"，量过它跟普通重载在同一张候选表里：用户写了
 * `int operator +(int,int) { return a*b; }` 之后 `2 + 3` 印的是 **6**。
 *
 * 表外分两类，诊断也分两类：
 *  - `ASY_OPBAD` 里的 **asy 自己就不收**（量过 `bool operator &&(V,V)` 那行 asy 报
 *    `2.16: syntax error:` 并 exit 1 —— camp.y 的 operator 产生式里没有这两个 token）。
 *    这种是普通错误，不带 ASY_NOPE：不是我们还没做。
 *  - 其余（`cast`、`::`、`..`、`[]`、`&`、`|`、`**` …，量过 asy 全都**收**）是我们还没做，
 *    报 ASY_NOPE。`cast` 尤其不是形态问题，它会改重载解析的打分，见 bad/op-cast.asy。
 */
const ASY_OPSYM = new Map([
  ['+', 'add'], ['-', 'sub'], ['*', 'mul'], ['/', 'div'], ['#', 'quot'], ['%', 'mod'],
  ['^', 'pow'], ['==', 'eq'], ['!=', 'ne'], ['<', 'lt'], ['<=', 'le'], ['>', 'gt'],
  ['>=', 'ge'], ['!', 'not'], ['--', 'seg'], ['^^', 'cat'],
]);

/** asy 的语法本身就拒的算符名（量过）。见 strict/op-logic.asy。 */
const ASY_OPBAD = new Set(['&&', '||']);

/** `cycle` 那个字面量落到哪个名字上（见 lit）：绘图层 stage0/lib/asy/plain.asy 里
 *  的 `path cyclepath;`。前端与绘图层之间**只有这一个**约定的名字。 */
const ASY_CYCLE = 'cyclepath';

/** 文件级变量收得下的类型（第三十刀放开）：int/real/bool/string、pair/triple、
 *  记录，以及它们的一维数组。核心方言的 `(global …)` 原先只收标量，理由写的是
 *  「聚合的身份不在 MIR 的 8 位类型码里」—— 量下来那个身份**根本不需要**：class 与
 *  数组在四条腿上都是一个指针（LLVM 的 T_AGG/T_ARR 都是 `ptr`），字段与元素的身份
 *  是从表达式的 OIR 类型来的。绘图层要 currentpicture/defaultpen 这种模块级单件，
 *  所以这一条是那一刀的前置。判定在 globalNames 里（要看 this.records）。 */


/** 数组类型在这一层就是「元素名 + []」的字符串（`'real[]'`），核心方言那边是 `(arr real)`。
 *  用字符串是因为这个文件里所有类型都是字符串，Map 查表与 `===` 比较都现成 ——
 *  为数组另造一个对象型会把每处比较都改成函数调用。名字带 asy 前缀：模块级名字全仓唯一。 */
const asyIsArr = (t) => t !== null && t !== undefined && t.endsWith('[]');
const asyElem = (t) => t.slice(0, -2);

/** 类型名 -> 能当标识符片段的名字（`real[]` -> `arr_real`）。数组 helper 的名字要用它 ——
 *  `asy__grow_real[]` 不是一个标识符。递归，所以 `real[][]` 是 `arr_arr_real`。 */
const asyMangle = (t) => (asyIsArr(t) ? `arr_${asyMangle(asyElem(t))}` : t);

/**
 * 函数类型在这一层也是字符串，拼法照 asy 自己的：`real(real)`、`void(int,string)`。
 * 量出来的理由：真 base 在场时 304 个 examples 里 203 个第一个撞的就是
 * `math.asy:446` 的 `real findroot(real f(real), …)` —— 函数类型的形参。
 *
 * 用 asy 的拼法而不是另造一个（`fn<real|real>` 之类）是为了诊断：报错里印的类型
 * 就是用户写的那几个字。代价是**返回类型自己是函数类型**时这个拼法有歧义
 * （`real(real)(int)` 的第一对括号分不清是谁的），所以那一种在 asyFnSplit 里认不出来、
 * 由调用方报"还没做" —— 认不出比猜错好。
 */
const asyIsFn = (t) => t !== null && t !== undefined && t.length > 2 && t.endsWith(')');

/** `real(int,string)` -> `{ ret: 'real', params: ['int','string'] }`；认不出给 null。 */
function asyFnSplit(t) {
  let i = 0;
  while (i < t.length && t.charAt(i) !== '(') i++;
  if (i === 0 || i >= t.length) return null;
  // 那个 '(' 必须与**最后一个字符**配对，否则就是 `real(real)(int)` 那种歧义拼法
  let d = 0;
  let k = i;
  while (k < t.length) {
    const c = t.charAt(k);
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) break; }
    k++;
  }
  if (k !== t.length - 1) return null;
  const inner = t.slice(i + 1, t.length - 1);
  const params = [];
  if (inner !== '') {
    let cur = '';
    let j = 0;
    d = 0;
    while (j < inner.length) {
      const c = inner.charAt(j);
      if (c === '(') d++;
      else if (c === ')') d--;
      if (c === ',' && d === 0) { params.push(cur); cur = ''; } else cur = `${cur}${c}`;
      j++;
    }
    params.push(cur);
  }
  return { ret: t.slice(0, i), params: params };
}

/**
 * pair 就是核心方言的 `(vec real 2)`：第 0 道是 x，第 1 道是 y。
 *
 * 为什么不给核心方言加一条 `pair` 类型：`+` 和 `-` 在 pair 上就是**逐分量**的，
 * 而向量的 `+ -` 已经是逐道的；`(vlit …)`、`(lane …)` 正好是"造一个"和"取一个分量"。
 * 剩下的复数 `*`、`/`、`abs`、`==` 和 `(x,y)` 的印法都是 **asy 的语义**，不是"向量"的
 * 语义 —— 那几条落在这一层的 helper 里，六条腿共用同一份，不会分叉。
 *
 * 代价写在明处：`?:` 的两支是 pair 时靠 ZERO 里那个零向量占位。
 * `pair[]` 第八刀通了：核心方言的 `(arr T)` 现在收 `(vec T N)` 元素，运行时那一份
 * 按字节的实现管长度与增长，元素的读写由每条腿自己发（见 omni_arr.c 尾部）。
 */
const ASY_PAIR_TY = '(vec real 2)';
/**
 * triple 是 `(vec real 4)`，**第 3 道空着**。为什么不是 `(vec real 3)`：MIR 的类型码
 * 把向量宽度存成**对数**（`mir/ir.js` 的高 3 位），3 在那里根本编不出来 —— 放开它是
 * 重画类型码，牵动 MIR + 三个后端 + SPIR-V。而硬件本来就把 vec3 垫成 vec4
 * （SIMD 寄存器、GPU 的 vec3 对齐都是 16 字节），所以垫一道不是将就，是常规做法。
 * 代价写在明处：每个 triple 占 32 字节而不是 24；第 3 道**永远不参与语义** ——
 * 所有 helper 都是逐道写死的，`==` 只比前三道，印的时候也只印前三道。
 */
const ASY_TRIPLE_TY = '(vec real 4)';
const asyCore = (t) => {
  if (asyIsArr(t)) return `(arr ${asyCore(asyElem(t))})`;
  if (asyIsFn(t)) {
    const s = asyFnSplit(t);
    let ps = '';
    for (const p of s.params) ps = ps === '' ? asyCore(p) : `${ps} ${asyCore(p)}`;
    return `(fnty (${ps}) ${asyCore(s.ret)})`;
  }
  if (t === 'pair') return ASY_PAIR_TY;
  return t === 'triple' ? ASY_TRIPLE_TY : t;
};

/**
 * asy 的内建实数函数是一张**数据表**（`frontend-asy/builtins.tab`），不是这里的代码 ——
 * asy 自己也是这么组织的（builtin.cc 里 `addRealFunc(sin,SYM(sin))` 那一段就是一张
 * 名字->实现的表）。这个函数只负责把那张表读成 Map；实现分两种：
 *   rmath = 核心方言白名单里的 `(rmath …)`（转手宿主的数学库：C 是 libm、JS 是 Math.*）；
 *   nope  = 还没做。
 * 表由驱动（cli.js）读进来 —— 文件 IO 不在降级器里，跟语法表、模块一个路子。
 */
export function parseAsyBuiltins(text) {
  const out = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const cols = [];
    for (const c of line.split(' ')) if (c !== '') cols.push(c);
    if (cols.length !== 5) continue;
    out.set(cols[0], {
      arity: Number(cols[1]), ret: cols[2], kind: cols[3],
      fn: cols[3] === 'rmath' ? cols[4] : undefined,
    });
  }
  return out;
}


/** 没写初值时的零值。asy 也是这么定的（未初始化的 int 是 0，string 是空串，pair 是 (0,0)）。 */
const ZERO = new Map([
  ['int', '(int 0)'],
  ['real', '(real 0.0)'],
  ['bool', '(bool false)'],
  ['string', '(str "")'],
  ['pair', `(vlit ${ASY_PAIR_TY} (real 0.0) (real 0.0))`],
  // 量过：`triple t;` 是 (0,0,0)
  ['triple', `(vlit ${ASY_TRIPLE_TY} (real 0.0) (real 0.0) (real 0.0) (real 0.0))`],
]);

/**
 * pair 上的内建函数。返回类型是量出来的（`asy -noV`）：
 *   abs((3,-4)) / length((1,2))  -> real（模）
 *   conj((1,2))                  -> (1,-2)
 *   xpart/ypart                  -> real（`z.x`/`z.y` 是同一件事）
 * `angle`/`dir`/`expi` 这一刀还没做（atan2/cos/sin 已经在 rmath 白名单里了，接上就行）；
 * `unit` 见文件头。
 * `realpart`/`imagpart` **asy 自己就没有**（量过："no matching variable 'realpart'"），
 * 所以这里也没有 —— 补上就是比 asy 多接受一门语言。
 */
const ASY_PAIRFN = new Set(['conj', 'xpart', 'ypart', 'zpart', 'angle', 'unit', 'dir', 'expi',
  'dot', 'cross', 'realmult']);

/**
 * 字符串上的内建函数。`params` 是每个实参要的类型，`min` 是最少给几个 ——
 * asy 那边 `substr(s,i)` 与 `find(s,t)` 是靠**默认实参**少给一个，这一刀没有默认实参
 * 机制，所以按"给了几个"分派：substr 少给走"到末尾"那条 helper，find 少给补起点 0。
 * `reverse` 刻意不收：它按字节翻转，非 ASCII 翻出来不是合法 UTF-8，而"印一串非法字节"
 * 在 C 与 JS 两条腿上不是同一件事 —— 没量准的东西不收。
 */
const ASY_STRFN = new Map([
  ['substr', { params: ['string', 'int', 'int'], min: 2, fn: 'asy__ssub', short: 'asy__ssubto', ret: 'string' }],
  ['find', { params: ['string', 'string', 'int'], min: 2, fn: 'asy__sfindp', ret: 'int' }],
  ['rfind', { params: ['string', 'string'], min: 2, fn: 'asy__srfind', ret: 'int' }],
  ['replace', { params: ['string', 'string', 'string'], min: 3, fn: 'asy__srepl', ret: 'string' }],
  ['erase', { params: ['string', 'int', 'int'], min: 3, fn: 'asy__serase', ret: 'string' }],
  ['insert', { params: ['string', 'int', 'string'], min: 3, fn: 'asy__sins', ret: 'string' }],
  ['split', { params: ['string', 'string'], min: 2, fn: 'asy__ssplit', ret: 'string[]' }],
]);

/** helper 之间的依赖：发了外层那条，被它调用的也要发。 */
const ASY_STR_DEPS = new Map([
  ['asy__ssubto', ['asy__ssub']],
  ['asy__serase', ['asy__ssub', 'asy__ssubto']],
  ['asy__sfindp', ['asy__ssub', 'asy__ssubto']],
  ['asy__srepl', ['asy__ssub', 'asy__ssubto']],
  ['asy__sins', ['asy__ssub', 'asy__ssubto']],
  ['asy__ssplit', ['asy__ssub', 'asy__ssubto', 'asy__sfindp']],
]);

/**
 * 字符串上**刻意没做**的那几个，各自带上理由 —— 落到"内建函数 'xxx' 没有"那条通用
 * 消息里的话，看的人分不清是"这一刀没做"还是"asy 也没有"。
 */
const ASY_STR_NOPE = new Map([
  ['reverse', "字符串的 reverse（asy 是按字节倒的，而 Omni 的 string 是 UTF-8 字节序列 —— 非 ASCII 倒出来在 C 与 JS 两条腿上不是同一件事）"],
]);

/** 核心方言的字符串字面量。刻意不用 JSON.stringify：它对控制字符发 \uXXXX，
 *  而 sexpr/read.js 的转义表里没有 \u（那是 WAT 的方言）。只转必须转的五个。 */
function strLit(s) {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else out += ch;
  }
  return out + '"';
}

/**
 * 按需发的 helper 函数。多数是「asy 的算符与核心方言的算符不是同一个」逼出来的：
 * `#` 向下取整、`%` 的符号跟着除数、int 上的 `^` 是幂、`abs(int)` 回 int。
 * 每条都只发一次，且只在用到时发。
 */
const HELPERS = new Map([
  ['asy__iabs', `  (fn asy__iabs ((a int)) int
    ;; 整数取绝对值。核心方言的 (rmath "fabs" …) 只吃 real，而 asy 的 abs(int) 回 int ——
    ;; 绕一趟 real 会在 2^53 以上丢精度，所以这里就是一个比较。
    (if (bin "<" (var a) (int 0)) (do (ret (un "-" (var a)))))
    (ret (var a)))`],
  ['asy__quot', `  (fn asy__quot ((a int) (b int)) int
    ;; asy 的 # 是**向下**取整；核心方言的 / 是截断。差别只在"除不尽且异号"时。
    (let q int (bin "/" (var a) (var b)))
    (if (bin "!=" (bin "%" (var a) (var b)) (int 0))
      (do
        (if (bin "!=" (bin "<" (var a) (int 0)) (bin "<" (var b) (int 0)))
          (do (set q (bin "-" (var q) (int 1)))))))
    (ret (var q)))`],
  ['asy__mod', `  (fn asy__mod ((a int) (b int)) int
    ;; asy 的 % 的符号跟着**除数**（量过：-7%3=2、7%-3=-2）；核心方言是 C 语义。
    (let m int (bin "%" (var a) (var b)))
    (if (bin "&&" (bin "!=" (var m) (int 0)) (bin "!=" (bin "<" (var m) (int 0)) (bin "<" (var b) (int 0))))
      (do (set m (bin "+" (var m) (var b)))))
    (ret (var m)))`],
  ['asy__ipow', `  (fn asy__ipow ((a int) (b int)) int
    ;; asy 的 ^ 是幂，核心方言的 ^ 是异或，所以只能写成循环。
    ;; 负指数：asy 报 "Only 1 and -1 can be raised to negative exponents as integers"，
    ;; 我们这一刀不做那条运行期检查，返回 0 —— 差别写在文件头。
    (let r int (int 1))
    (let i int (int 0))
    (if (bin "<" (var b) (int 0)) (do (ret (int 0))))
    (while (bin "<" (var i) (var b))
      (do
        (set r (bin "*" (var r) (var a)))
        (set i (bin "+" (var i) (int 1)))))
    (ret (var r)))`],
  ['asy__boolstr', `  (fn asy__boolstr ((b bool)) string
    ;; asy 在 bool 后面**总是补一个空格**（量过：write(false) 是 6 字节 "false "，
    ;; write("a",false) 是 "afalse "，所以不是对齐到 5，是算符自带的尾空格）
    (if (var b) (do (ret (str "true "))))
    (ret (str "false ")))`],
  ['asy__pmul', `  (fn asy__pmul ((a ${ASY_PAIR_TY}) (b ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    ;; pair 的 * 是**复数乘法**（量过：(1,2)*(3,-4) = (11,2)）。乘法的形状照抄
    ;; 教科书那一份：x = ax*bx - ay*by，y = ax*by + ay*bx —— 加减顺序是浮点结果的
    ;; 一部分，所以写死，不敢换成"更聪明"的写法。
    (ret (vlit ${ASY_PAIR_TY}
      (bin "-" (bin "*" (lane (var a) 0) (lane (var b) 0)) (bin "*" (lane (var a) 1) (lane (var b) 1)))
      (bin "+" (bin "*" (lane (var a) 0) (lane (var b) 1)) (bin "*" (lane (var a) 1) (lane (var b) 0))))))`],
  ['asy__pdiv', `  (fn asy__pdiv ((a ${ASY_PAIR_TY}) (b ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    ;; pair 的 / 是**复数除法**，而且是**朴素**那一份（不是 Smith 的防溢出算法）——
    ;; 量出来的：(1,1)/(1e200,1e200) 是 (0,0)（分母平方和溢出成 inf），
    ;; (1e300,1)/1e300 是 (nan,0)（右边那个实数先被提成 (1e300,0)，t 还是 inf）。
    ;; 后一条同时证明了 asy **没有** pair/real 这个重载：实数是先转成 pair 的。
    (let t real (bin "+" (bin "*" (lane (var b) 0) (lane (var b) 0)) (bin "*" (lane (var b) 1) (lane (var b) 1))))
    (ret (vlit ${ASY_PAIR_TY}
      (bin "/" (bin "+" (bin "*" (lane (var a) 0) (lane (var b) 0)) (bin "*" (lane (var a) 1) (lane (var b) 1))) (var t))
      (bin "/" (bin "-" (bin "*" (lane (var a) 1) (lane (var b) 0)) (bin "*" (lane (var a) 0) (lane (var b) 1))) (var t)))))`],
  ['asy__pabs', `  (fn asy__pabs ((a ${ASY_PAIR_TY})) real
    ;; 模。也是朴素那一份 —— 量过 abs((1e200,1e200)) 是 inf，所以不是 hypot。
    (ret (rmath "sqrt" (bin "+" (bin "*" (lane (var a) 0) (lane (var a) 0)) (bin "*" (lane (var a) 1) (lane (var a) 1))))))`],
  ['asy__pconj', `  (fn asy__pconj ((a ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    (ret (vlit ${ASY_PAIR_TY} (lane (var a) 0) (un "-" (lane (var a) 1)))))`],
  // dot / cross / realmult 在 pair 上也有（量过：dot((1,2),(3,4))=11、cross 给**实数** -2、
  // realmult 逐分量给 (3,8)）。triple 上是另外三条（asy__tdot / tcross / trealmult）。
  ['asy__pdot', `  (fn asy__pdot ((a ${ASY_PAIR_TY}) (b ${ASY_PAIR_TY})) real
    (ret (bin "+" (bin "*" (lane (var a) 0) (lane (var b) 0)) (bin "*" (lane (var a) 1) (lane (var b) 1)))))`],
  ['asy__pcross', `  (fn asy__pcross ((a ${ASY_PAIR_TY}) (b ${ASY_PAIR_TY})) real
    (ret (bin "-" (bin "*" (lane (var a) 0) (lane (var b) 1)) (bin "*" (lane (var a) 1) (lane (var b) 0)))))`],
  ['asy__prealmult', `  (fn asy__prealmult ((a ${ASY_PAIR_TY}) (b ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    (ret (vlit ${ASY_PAIR_TY} (bin "*" (lane (var a) 0) (lane (var b) 0))
      (bin "*" (lane (var a) 1) (lane (var b) 1)))))`],
  // 下面这四个都要超越函数。它们能落地是因为 rmath 的白名单已经是"宿主数学库的交集"
  // （atan2/cos/sin 都在里面），所以这里没有自己写的实现，只有 asy 那几行的形状。
  ['asy__pangle', `  (fn asy__pangle ((a ${ASY_PAIR_TY}) (warn bool)) real
    ;; angle((0,0)) 在 asy 是**运行期错误** "taking angle of (0,0)"，而 angle(z,false) 给 0
    ;; （两条都量过）。所以零点这一问必须在 atan2 之前 —— libm 的 atan2(0,0) 是 0，不报错。
    (if (bin "&&" (bin "==" (lane (var a) 0) (real 0.0)) (bin "==" (lane (var a) 1) (real 0.0)))
      (do
        (if (var warn) (do (fail (str "taking angle of (0,0)"))))
        (ret (real 0.0))))
    (ret (rmath "atan2" (lane (var a) 1) (lane (var a) 0))))`],
  ['asy__punit', `  (fn asy__punit ((a ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    ;; z / abs(z)，逐分量除。零点要挡一刀：量过 unit((0,0)) 是 (0,0) 而不是 (nan,nan)。
    ;; abs 是朴素那一份（见 asy__pabs），所以 unit((1e200,1e200)) 是 (0,0) —— 量过，一致。
    (let r real (call asy__pabs (var a)))
    (if (bin "==" (var r) (real 0.0)) (do (ret (var a))))
    (ret (vlit ${ASY_PAIR_TY} (bin "/" (lane (var a) 0) (var r)) (bin "/" (lane (var a) 1) (var r)))))`],
  ['asy__pexpi', `  (fn asy__pexpi ((t real)) ${ASY_PAIR_TY}
    ;; expi(t) = (cos t, sin t)。量过 expi(0.5) = (0.877582561890373,0.479425538604203)，
    ;; 与宿主的 cos/sin 一致 —— 两个分量各自舍入，不是"先算一个再推另一个"。
    (ret (vlit ${ASY_PAIR_TY} (rmath "cos" (var t)) (rmath "sin" (var t)))))`],
  ['asy__pdir', `  (fn asy__pdir ((d real)) ${ASY_PAIR_TY}
    ;; dir(度) = expi(radians(度))，radians 就是 deg*pi/180（照 asy 的源码顺序写，
    ;; 乘除的次序是浮点结果的一部分）。量过 dir(45) 的两个分量是 ...548 / ...547：
    ;; 不对称，正是 cos 与 sin 各自舍入的样子。
    (ret (call asy__pexpi (bin "/" (bin "*" (var d) (real 3.14159265358979311600)) (real 180.0)))))`],
  ['asy__ppowi', `  (fn asy__ppowi ((z ${ASY_PAIR_TY}) (n int)) ${ASY_PAIR_TY}
    ;; pair^**int**：反复平方（低位在前），负指数取倒数。asy 这条重载在整数上是**精确**的
    ;; —— 量过 (1,2)^30 印的是 (-6890111163,29729597084) 一个小数点都没有，而下面那条
    ;; exp/log 的路子给 (-6890111162.99996,…)。84 组 (底,指数) 的扫描里这个形状对上
    ;; 75 组，剩下九组差最后一两位（asy 那边是 libstdc++ 的 __complex_pow_unsigned，
    ;; 复数乘法带 NaN 修补，我们没有）—— 所以用例落在 tol/ 而不是逐字节那一节。
    (let m int (var n))
    (if (bin "<" (var m) (int 0)) (do (set m (un "-" (var m)))))
    (let r ${ASY_PAIR_TY} (vlit ${ASY_PAIR_TY} (real 1.0) (real 0.0)))
    (let x ${ASY_PAIR_TY} (var z))
    (while (bin ">" (var m) (int 0))
      (do
        (if (bin "==" (bin "%" (var m) (int 2)) (int 1)) (do (set r (call asy__pmul (var r) (var x)))))
        (set m (bin "/" (var m) (int 2)))
        (if (bin ">" (var m) (int 0)) (do (set x (call asy__pmul (var x) (var x)))))))
    (if (bin "<" (var n) (int 0))
      (do (ret (call asy__pdiv (vlit ${ASY_PAIR_TY} (real 1.0) (real 0.0)) (var r)))))
    (ret (var r)))`],
  ['asy__ppowz', `  (fn asy__ppowz ((z ${ASY_PAIR_TY}) (w ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    ;; pair^**pair**（real 指数先提成 (v,0)，asy 没有 pair^real 这个重载）= exp(w * log z)，
    ;; log z = (log(abs z), angle z)。三处细节都是量出来的，而且**不是**宿主 cpow：
    ;; - abs 是朴素那一份（asy__pabs），所以 (1e200,1e200)^0.5 是 (nan,nan)；真 cpow
    ;;   走 hypot，给的是 1.09868411346781e+100 那个有限值。
    ;; - w*log z 是**复数**乘法，即使 w 是实数也照乘：(1e-200,1e-200)^0.5 里 abs 下溢成 0、
    ;;   log 给 -inf，虚部那一项是 0*(-inf) = nan —— 量过 asy 也是 (nan,nan)。
    ;; - 零底数要挡在前面：量过 (0,0)^任何非零 是 (0,0)、(0,0)^(0,0) 是 (1,0)。
    ;;   （(0,0)^-1 在 asy 是运行期错误 "division by pair (0,0)"，那条走 int 那个重载，
    ;;   我们照 pair 除法的既有偏差出 IEEE 的 inf/nan，不报错 —— 见文件头那条。）
    (if (bin "&&" (bin "==" (lane (var z) 0) (real 0.0)) (bin "==" (lane (var z) 1) (real 0.0)))
      (do
        (if (bin "&&" (bin "==" (lane (var w) 0) (real 0.0)) (bin "==" (lane (var w) 1) (real 0.0)))
          (do (ret (vlit ${ASY_PAIR_TY} (real 1.0) (real 0.0)))))
        (ret (vlit ${ASY_PAIR_TY} (real 0.0) (real 0.0)))))
    (let l ${ASY_PAIR_TY} (vlit ${ASY_PAIR_TY}
      (rmath "log" (call asy__pabs (var z)))
      (rmath "atan2" (lane (var z) 1) (lane (var z) 0))))
    (let u ${ASY_PAIR_TY} (call asy__pmul (var w) (var l)))
    (let e real (rmath "exp" (lane (var u) 0)))
    (ret (vlit ${ASY_PAIR_TY}
      (bin "*" (var e) (rmath "cos" (lane (var u) 1)))
      (bin "*" (var e) (rmath "sin" (lane (var u) 1))))))`],
  ['asy__pneg', `  (fn asy__pneg ((a ${ASY_PAIR_TY})) ${ASY_PAIR_TY}
    ;; 逐分量取负。刻意不写成 (0,0) - a：那样 -0.0 会变成 0.0，而 asy 是 pair(-x,-y)。
    (ret (vlit ${ASY_PAIR_TY} (un "-" (lane (var a) 0)) (un "-" (lane (var a) 1)))))`],
  // ---- triple。全部逐道写死，第 3 道恒为 0（见 ASY_TRIPLE_TY 上方那段）。
  ['asy__tneg', `  (fn asy__tneg ((a ${ASY_TRIPLE_TY})) ${ASY_TRIPLE_TY}
    (ret (vlit ${ASY_TRIPLE_TY} (un "-" (lane (var a) 0)) (un "-" (lane (var a) 1))
      (un "-" (lane (var a) 2)) (real 0.0))))`],
  ['asy__tsmul', `  (fn asy__tsmul ((a ${ASY_TRIPLE_TY}) (s real)) ${ASY_TRIPLE_TY}
    ;; triple * real 是逐分量的（量过 (1,2,3)*2.5 与 2.5*(1,2,3) 都是 (2.5,5,7.5)）
    (ret (vlit ${ASY_TRIPLE_TY} (bin "*" (lane (var a) 0) (var s)) (bin "*" (lane (var a) 1) (var s))
      (bin "*" (lane (var a) 2) (var s)) (real 0.0))))`],
  ['asy__tsdiv', `  (fn asy__tsdiv ((a ${ASY_TRIPLE_TY}) (s real)) ${ASY_TRIPLE_TY}
    ;; triple / real，同样逐分量（量过 (1,2,3)/2 是 (0.5,1,1.5)）。除以零 asy 是运行期
    ;; 错误 "division by 0"，我们照 pair 那条既有偏差出 IEEE 的 inf/nan。
    (ret (vlit ${ASY_TRIPLE_TY} (bin "/" (lane (var a) 0) (var s)) (bin "/" (lane (var a) 1) (var s))
      (bin "/" (lane (var a) 2) (var s)) (real 0.0))))`],
  ['asy__teq', `  (fn asy__teq ((a ${ASY_TRIPLE_TY}) (b ${ASY_TRIPLE_TY})) bool
    ;; 只比前三道：第 3 道是垫出来的，不参与语义
    (ret (bin "&&" (bin "==" (lane (var a) 0) (lane (var b) 0))
      (bin "&&" (bin "==" (lane (var a) 1) (lane (var b) 1))
        (bin "==" (lane (var a) 2) (lane (var b) 2))))))`],
  ['asy__tabs', `  (fn asy__tabs ((a ${ASY_TRIPLE_TY})) real
    ;; abs = length = 三个分量的平方和开根，**朴素**那一份 ——
    ;; 量过 abs((1e200,1e200,1e200)) 是 inf（所以不是 hypot），跟 pair 一致
    (ret (rmath "sqrt" (bin "+" (bin "+" (bin "*" (lane (var a) 0) (lane (var a) 0))
      (bin "*" (lane (var a) 1) (lane (var a) 1))) (bin "*" (lane (var a) 2) (lane (var a) 2))))))`],
  ['asy__tunit', `  (fn asy__tunit ((a ${ASY_TRIPLE_TY})) ${ASY_TRIPLE_TY}
    ;; a / abs(a)，逐分量。零点挡一刀（量过 unit((0,0,0)) 是 (0,0,0)）；abs 溢出成 inf 时
    ;; 逐分量除给 (0,0,0) —— 量过 unit((1e200,1e200,1e200)) 正是 (0,0,0)。
    (let r real (call asy__tabs (var a)))
    (if (bin "==" (var r) (real 0.0)) (do (ret (var a))))
    (ret (call asy__tsdiv (var a) (var r))))`],
  ['asy__tdot', `  (fn asy__tdot ((a ${ASY_TRIPLE_TY}) (b ${ASY_TRIPLE_TY})) real
    ;; 量过 dot((1,2,3),(4,5,6)) 是 32、dot((1,2,3),(1,2,3)) 是 14
    (ret (bin "+" (bin "+" (bin "*" (lane (var a) 0) (lane (var b) 0))
      (bin "*" (lane (var a) 1) (lane (var b) 1))) (bin "*" (lane (var a) 2) (lane (var b) 2)))))`],
  ['asy__tcross', `  (fn asy__tcross ((a ${ASY_TRIPLE_TY}) (b ${ASY_TRIPLE_TY})) ${ASY_TRIPLE_TY}
    ;; 右手系（量过 cross((1,2,3),(4,5,6)) 是 (-3,6,-3)）
    (ret (vlit ${ASY_TRIPLE_TY}
      (bin "-" (bin "*" (lane (var a) 1) (lane (var b) 2)) (bin "*" (lane (var a) 2) (lane (var b) 1)))
      (bin "-" (bin "*" (lane (var a) 2) (lane (var b) 0)) (bin "*" (lane (var a) 0) (lane (var b) 2)))
      (bin "-" (bin "*" (lane (var a) 0) (lane (var b) 1)) (bin "*" (lane (var a) 1) (lane (var b) 0)))
      (real 0.0))))`],
  ['asy__trealmult', `  (fn asy__trealmult ((a ${ASY_TRIPLE_TY}) (b ${ASY_TRIPLE_TY})) ${ASY_TRIPLE_TY}
    ;; 逐分量乘。asy 没有 triple*triple，逐分量乘就叫 realmult（量过给 (4,10,18)）
    (ret (vlit ${ASY_TRIPLE_TY} (bin "*" (lane (var a) 0) (lane (var b) 0))
      (bin "*" (lane (var a) 1) (lane (var b) 1)) (bin "*" (lane (var a) 2) (lane (var b) 2)) (real 0.0))))`],
  ['asy__texpi', `  (fn asy__texpi ((t real) (p real)) ${ASY_TRIPLE_TY}
    ;; expi(θ,φ) = (sinθ cosφ, sinθ sinφ, cosθ)（弧度）。判据：expi(0.5,1.0) 印
    ;; (0.259034723999926,0.403422680111335,0.877582561890373) —— 第三道正是 cos(0.5)，
    ;; 前两道正是 sin(0.5) 乘 cos(1.0) / sin(1.0)，逐位对上。
    (let s real (rmath "sin" (var t)))
    (ret (vlit ${ASY_TRIPLE_TY} (bin "*" (var s) (rmath "cos" (var p)))
      (bin "*" (var s) (rmath "sin" (var p))) (rmath "cos" (var t)) (real 0.0))))`],
  ['asy__tdir', `  (fn asy__tdir ((t real) (p real)) ${ASY_TRIPLE_TY}
    ;; dir(θ,φ) 收的是**度**（量过 dir(30,45) 的第三道是 cos(30°)=0.866025403784439）
    (ret (call asy__texpi (bin "/" (bin "*" (var t) (real 3.14159265358979311600)) (real 180.0))
      (bin "/" (bin "*" (var p) (real 3.14159265358979311600)) (real 180.0)))))`],
  ['asy__peq', `  (fn asy__peq ((a ${ASY_PAIR_TY}) (b ${ASY_PAIR_TY})) bool
    ;; 向量上没有比较（掩码类型这一刀没有），所以逐道比。写成函数而不是内联展开：
    ;; 内联要把两边的代码各印两遍，f() == g() 就会把 f 和 g 各调两次。
    (ret (bin "&&" (bin "==" (lane (var a) 0) (lane (var b) 0)) (bin "==" (lane (var a) 1) (lane (var b) 1)))))`],
  ['asy__pairstr', `  (fn asy__pairstr ((a ${ASY_PAIR_TY})) string
    ;; write(pair) 的格式：两个分量各 %.15g，夹在圆括号里，中间一个逗号、没有空格
    ;; （量过：(0.333333333333333,0.666666666666667)、(1e+20,1e-05)、(-0,0)）
    (ret (bin "+" (str "(") (bin "+" (tostr (lane (var a) 0) (int 15))
      (bin "+" (str ",") (bin "+" (tostr (lane (var a) 1) (int 15)) (str ")")))))))`],
  ['asy__triplestr', `  (fn asy__triplestr ((a ${ASY_TRIPLE_TY})) string
    ;; write(triple) 与 pair 同一个形状，三个分量（量过：(1,2,3)、(0.5,1,1.5)、(-3,6,-3)）。
    ;; 第 3 道是垫出来的，这里**不印** —— 那一道不参与语义（见 ASY_TRIPLE_TY）。
    (ret (bin "+" (str "(") (bin "+" (tostr (lane (var a) 0) (int 15))
      (bin "+" (str ",") (bin "+" (tostr (lane (var a) 1) (int 15))
        (bin "+" (str ",") (bin "+" (tostr (lane (var a) 2) (int 15)) (str ")")))))))))`],
  // 字符串函数。核心方言给的是**严格**的三条（越界报错），asy 的这几个是**静静地失败**：
  // 量过 substr("abc",5,1) 与 substr("abc",-1,2) 都是空串（不是报错、也不是 clamp 到 0 ——
  // clamp 的话第二个会给 "ab"），substr("abc",1,100) 是 "bc"，erase("abc",-1,2) 原样返回，
  // find("abc","b",-5) 是 -1（clamp 的话会是 1）。所以"负数当无效"这条要照着写。
  ['asy__ssub', `  (fn asy__ssub ((s string) (i int) (n int)) string
    (if (bin "<" (var i) (int 0)) (do (ret (str ""))))
    (if (bin ">" (var i) (slen (var s))) (do (ret (str ""))))
    (let m int (var n))
    (if (bin ">" (bin "+" (var i) (var m)) (slen (var s)))
      (do (set m (bin "-" (slen (var s)) (var i)))))
    (if (bin "<" (var m) (int 0)) (do (ret (str ""))))
    (ret (ssub (var s) (var i) (var m))))`],
  ['asy__ssubto', `  (fn asy__ssubto ((s string) (i int)) string
    ;; substr(s,i)：到末尾。写成 helper 而不是在调用处补 (slen …)，
    ;; 那样接收者的代码要印两遍，substr(f(),1) 就会把 f 调两次。
    (ret (call asy__ssub (var s) (var i) (slen (var s)))))`],
  ['asy__serase', `  (fn asy__serase ((s string) (i int) (n int)) string
    (if (bin "<" (var i) (int 0)) (do (ret (var s))))
    (ret (bin "+" (call asy__ssub (var s) (int 0) (var i))
                  (call asy__ssubto (var s) (bin "+" (var i) (var n))))))`],
  ['asy__sfindp', `  (fn asy__sfindp ((s string) (t string) (p int)) int
    (if (bin "<" (var p) (int 0)) (do (ret (int -1))))
    (if (bin ">" (var p) (slen (var s))) (do (ret (int -1))))
    (let r int (sfind (call asy__ssubto (var s) (var p)) (var t)))
    (if (bin "<" (var r) (int 0)) (do (ret (int -1))))
    (ret (bin "+" (var r) (var p))))`],
  ['asy__srfind', `  (fn asy__srfind ((s string) (t string)) int
    ;; 最后一次出现。核心方言只有"从前往后找"，所以扫一遍记最后一次
    ;; （量过 rfind("hello world","o") 是 7）。空针在末尾命中，和 std::string::rfind 一致。
    (let best int (int -1))
    (let i int (int 0))
    (while (bin "<=" (bin "+" (var i) (slen (var t))) (slen (var s)))
      (do
        (if (bin "==" (ssub (var s) (var i) (slen (var t))) (var t)) (do (set best (var i))))
        (set i (bin "+" (var i) (int 1)))))
    (ret (var best)))`],
  ['asy__srepl', `  (fn asy__srepl ((s string) (a string) (b string)) string
    ;; 换掉**所有**不重叠的出现，从左到右（量过 replace("aaa","aa","b") 是 "ba" ——
    ;; 换掉头两个之后从第三个字符接着走）。空的被换串原样返回（量过）。
    (if (bin "==" (slen (var a)) (int 0)) (do (ret (var s))))
    (let r string (str ""))
    (let i int (int 0))
    (while (bin "<=" (bin "+" (var i) (slen (var a))) (slen (var s)))
      (do
        (if (bin "==" (ssub (var s) (var i) (slen (var a))) (var a))
          (do
            (set r (bin "+" (var r) (var b)))
            (set i (bin "+" (var i) (slen (var a)))))
          (do
            (set r (bin "+" (var r) (ssub (var s) (var i) (int 1))))
            (set i (bin "+" (var i) (int 1)))))))
    (ret (bin "+" (var r) (call asy__ssubto (var s) (var i)))))`],
  ['asy__sins', `  (fn asy__sins ((s string) (i int) (t string)) string
    ;; 量过：insert("abc",1,"XY") 是 "aXYbc"、insert("abc",2,"XY") 是 "abXYc"。
    ;; 越界**什么都不做**（不是追加）：insert("abc",3,"X")、insert("abc",5,"X")、
    ;; insert("abc",-1,"X") 与 insert("",0,"X") 全是原串。这条是这一刀补的测量 ——
    ;; 之前 insert 在门外的理由就是"越界行为没量全"。
    (if (bin "<" (var i) (int 0)) (do (ret (var s))))
    (if (bin ">=" (var i) (slen (var s))) (do (ret (var s))))
    (ret (bin "+" (call asy__ssub (var s) (int 0) (var i))
      (bin "+" (var t) (call asy__ssubto (var s) (var i))))))`],
  ['asy__ssplit', `  (fn asy__ssplit ((s string) (d string)) (arr string)
    ;; 量出来的四条：
    ;;   普通分隔符：不重叠，**保留空字段** —— split("a,,b",",") 是三个元素、
    ;;     split(",a,",",") 也是三个（两头各一个空串）、split("abc","abc") 是两个空串
    ;;   找不到 / 空串：整串一个元素（split("",",") 的长度是 1）
    ;;   分隔符是**空串**：按空格切，并且丢掉空字段 —— split("  a  b  ","") 是 [a,b]，
    ;;     而 split("a,b,c","") 是整串一个元素。只有**空格**算分隔：量过
    ;;     split('a\\tb','') 的长度是 1，制表符与换行都不算。
    (let r (arr string) (anew (arr string) (int 0)))
    (if (bin "==" (var d) (str ""))
      (do
        (let cur string (str ""))
        (let i int (int 0))
        (while (bin "<" (var i) (slen (var s)))
          (do
            (if (bin "==" (ssub (var s) (var i) (int 1)) (str " "))
              (do
                (if (bin "!=" (var cur) (str ""))
                  (do (apush (var r) (var cur)) (set cur (str "")))))
              (do (set cur (bin "+" (var cur) (ssub (var s) (var i) (int 1))))))
            (set i (bin "+" (var i) (int 1)))))
        (if (bin "!=" (var cur) (str "")) (do (apush (var r) (var cur))))
        (ret (var r))))
    (let start int (int 0))
    (let p int (call asy__sfindp (var s) (var d) (int 0)))
    (while (bin ">=" (var p) (int 0))
      (do
        (apush (var r) (call asy__ssub (var s) (var start) (bin "-" (var p) (var start))))
        (set start (bin "+" (var p) (slen (var d))))
        (set p (call asy__sfindp (var s) (var d) (var start)))))
    (apush (var r) (call asy__ssubto (var s) (var start)))
    (ret (var r)))`],
]);

/**
 * 数组三条 helper 的正文（扩长 / 切片 / `a[i:]`），按元素类型生成。
 * 标量与 pair 那五份在下面的循环里一次生好（模块级静态文本）；**记录元素**是逐类型的，
 * 由 AsyLower.arrHelper 用同一个工厂生成 —— 正文只有元素类型与"扩长填什么"两处不同，
 * 所以这里是一个函数而不是两份抄写。
 *
 * 扩长：asy 量过 `int[] e; e[2]=5;` 之后 `e.length` 是 **3**（= 下标+1），中间那些格子在
 * asy 那边是"未初始化"、读会报错；我们填零值（记录元素填 `(cnew T)`，因为方言里写不出
 * 空引用），这条差别写在文件头。
 * 切片：量过的三条 —— 半开区间、**是复制不是视图**（`b=a[0:2]; b[0]=99;` 之后 a[0] 不变，
 * 但元素是记录时"复制"复制的是句柄，所以格子里还是同一批对象，量过 asy 也是这样）、
 * 右边界超长截到末尾。左边界不 clamp、`a[3:1]` 给空数组，两条差别都在文件头。
 * `a[i:]` 单独一条而不是在调用处写 `(alen …)`：那样接收者的代码要印两遍，`f()[1:]` 会把
 * f 调两次。
 */
function asyArrHelpers(name, et, zero) {
  return [
    [`asy__grow_${name}`, `  (fn asy__grow_${name} ((a (arr ${et})) (i int)) void
    (while (bin "<=" (alen (var a)) (var i))
      (do (apush (var a) ${zero}))))`],
    [`asy__slice_${name}`, `  (fn asy__slice_${name} ((a (arr ${et})) (i int) (j int)) (arr ${et})
    (let r (arr ${et}) (anew (arr ${et}) (int 0)))
    (let k int (var i))
    (let e int (var j))
    (if (bin ">" (var e) (alen (var a))) (do (set e (alen (var a)))))
    (while (bin "<" (var k) (var e))
      (do
        (apush (var r) (aget (var a) (var k)))
        (set k (bin "+" (var k) (int 1)))))
    (ret (var r)))`],
    [`asy__slicefrom_${name}`, `  (fn asy__slicefrom_${name} ((a (arr ${et})) (i int)) (arr ${et})
    (ret (call asy__slice_${name} (var a) (var i) (alen (var a)))))`],
  ];
}

// 这里刻意不用解构（`for (const [a, b] of …)`）：封闭子集里那不是保证能降级的写法。
for (const t of ['int', 'real', 'bool', 'string', 'pair', 'triple']) {
  for (const pair of asyArrHelpers(t, asyCore(t), ZERO.get(t))) HELPERS.set(pair[0], pair[1]);
}

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
    this.scopes = [];          // 名字 -> 类型名
    this.used = new Set();     // 用到的 helper
    // for 的更新片段栈。C 式 for 降成 while 之后，`continue` 必须**先跑更新**再跳 ——
    // 不这么做 `for(i=0;i<5;++i){if(i==2)continue;}` 就死循环。量过 asy 的行为：更新会跑。
    this.updates = [];
    this.tmp = 0;
    // 当前语句的**前置语句**。核心方言里 `? :` 不是表达式，只能摊成临时量 + if/else，
    // 那两条 if/else 就攒在这里，由 stmt() 的外壳补在这条语句前面。
    // null = 不在语句上下文里（那时见到 `? :` 只能报错，不能悄悄丢）。
    this.pre = null;
    // 文件级变量（第二十四刀）：名字 -> 一串声明 {sym, type, at, ok}。
    // **一串**而不是一个，因为 asy 的名字解析是顺序的，而同一个名字可以在文件里声明
    // 多次（量过：`int a = 1; write(a); int a = 7; write(a);` 印 1 再印 7）——
    // 于是每份声明各出一个全局，用到的地方挑"此处可见的最后一份"。
    // `ok:false` 的那些是这一刀的全局量还收不下的类型（pair/记录/数组），
    // 留在表里只为让函数里那句错话说得清是哪一条。
    this.globals = new Map();
    // 按声明顺序攒起来的 `(global sym 类型)`，最后发到模块层
    this.gdecls = [];
    // 正在降级**文件级**的语句（`(main …)` 那一层）。vardec 要靠它分清
    // "这是个全局"还是"这是 main 里某个块的局部量"。
    this.fileLevel = false;
    // 默认实参的包装函数（第十刀）：`函数名|缺的槽号` -> 包装名，正文攒在 wraps 里，
    // 最后跟别的函数一起发到模块层。同一形状只生一份，顺序按第一次用到的顺序 ——
    // 同一份输入两次降出来的文本因此逐字节相同。
    this.wrapNames = new Map();
    this.wraps = [];
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
  expandIncludes(rs, depth) {
    let has = false;
    for (const r of rs) {
      const u = this.unwrapMod(r);
      if (isList(u) && head(u) === 'include') has = true;
    }
    if (!has) return rs;
    const out = [];
    for (const r of rs) {
      const u = this.unwrapMod(r);
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
      for (const x of this.expandIncludes(this.flat(tree, 'block'), depth + 1)) out.push(x);
    }
    return out;
  }

  unitNew(tree, key) {
    const id = this.units.length;
    const u = {
      id, key, rs: this.expandIncludes(this.flat(tree, 'block'), 0), pfx: id === 0 ? '' : `asy__m${id}_`,
      init: id === 0 ? null : `asy__init${id}`, ran: id === 0 ? null : `asy__ran${id}`,
      funcs: new Map(), globals: new Map(), oinits: new Map(), oiByNode: new Map(),
      casts: new Map(), castByNode: new Map(),
      recVis: new Map(), mods: new Map(), methodDecls: [], callAt: new Map(), at: 0,
      tyAlias: new Map(),
      auFns: [], bi: null,
    };
    this.units.push(u);
    return u;
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
   */
  selfField(nm) {
    if (this.self === null) return null;
    if (this.lookup(nm) !== null) return null;
    for (const f of this.self.rec.fields) if (f.name === nm && f.mat < this.self.mat) return f;
    return null;
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
    for (const c of funcs.get(key)) {
      if (!inSelf || c.mat <= this.self.mat) out.push(c);
    }
    return out;
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
    const gen = this.isRec(el) || asyIsArr(el);
    if (!gen) { this.used.add(nm); return nm; }
    if (!this.arrGen.has(nm)) {
      const zero = asyIsArr(el) ? `(anew ${asyCore(el)} (int 0))` : `(cnew ${asyCore(el)})`;
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

  err(node, msg) {
    this.diags.error(node === null || node === undefined ? null : node.span, msg);
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

  /* ------------------------------------------------------------------ 类型 */

  /** `(name-ty (name int))` -> 'int'；`(array-ty (name int) (dims))` -> 'int[]'；
   *  `(dims+ (dims))` 是两层，`int[][]`（多维数组这一刀收下了）。 */
  type(node, what) {
    if (!isList(node)) return this.err(node, `${what}：这里要一个类型`);
    const h = head(node);
    if (h === 'array-ty') {
      const d = this.dimsDepth(node.items[2]);
      if (d === null) return this.err(node, `${what}：认不出的数组维数形状`);
      const el = this.plainName(node.items[1]);
      if (el === null) return this.nope(node, '带点的类型名');
      let eel = el;
      if (this.tyAlias.has(el)) {
        const ael = this.aliasAt(el);
        if (ael === null) return this.aliasLate(node, el);
        eel = ael.t;
      }
      if (!this.arrElemOk(eel)) return this.nope(node, `${eel}[] （${ASY_ARRELEM_TEXT}）`);
      if (this.isRec(eel) && !this.recHere(eel)) return this.recLate(node, eel);
      let t = eel;
      let k = 0;
      while (k < d) { t = `${t}[]`; k++; }
      return t;
    }
    if (h !== 'name-ty') return this.err(node, `${what}：认不出的类型形状 '${h}'`);
    const nm = this.plainName(node.items[1]);
    if (nm === null) return this.nope(node, '带点的类型名');
    if (nm === 'void') return 'void';
    if (nm === 'pair') return 'pair';
    if (nm === 'triple') return 'triple';
    // typedef 的别名。放在内建名后面、记录名前面：asy 那边 `typedef int int;` 是错的，
    // 而 `typedef` 一个 struct 名的别名是对的，所以顺序只影响诊断说哪一句。
    if (this.tyAlias.has(nm)) {
      const al = this.aliasAt(nm);
      return al === null ? this.aliasLate(node, nm) : al.t;
    }
    // 记录名（第十四刀）。放在内建名单后面查，与核心方言那边同一条规矩。
    // 查的是**这个单元看得见的**那张表（recVis）：别的模块里的 struct 没 import 进来时
    // 不算类型（量过 asy 报 "no type of name"），所以 records 那张全局表只用来发文本。
    if (this.recVis.has(nm)) return this.recHere(nm) ? nm : this.recLate(node, nm);
    if (this.records.has(nm)) return this.recElsewhere(node, nm);
    if (!SCALARS.has(nm)) return this.nope(node, `类型 '${nm}'（这一刀只有 int/real/bool/string/pair/triple 与 struct）`);
    return nm;
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

  /** typedef 的名字也是顺序解析的（与 recLate 同一条规矩，只是话不一样） */
  aliasLate(node, nm) {
    return this.err(node, `'${nm}' 在这里还不是一个类型 —— typedef ${nm} 写在后面，`
      + `而 asy 的类型名是顺序解析的（那边报 "no type of name '${nm}'"）`);
  }

  /** 别名表里 `nm` 在**当前位置**可见的那一份（挑最后一份），此处一份都不可见给 null */
  aliasAt(nm) {
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
      t = this.fnTypeOf(base, start.items[2], start);
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
    // 同名再 typedef 一次：asy 收（后面那句起换成新的那一份），所以存的是一串。
    const list = this.tyAlias.has(nm) ? this.tyAlias.get(nm) : [];
    list.push({ t: t, at: at });
    this.tyAlias.set(nm, list);
    return true;
  }

  /** 别的模块里的 struct，但这个文件没把它 import 进来（asy 那边也是 "no type of name"） */
  recElsewhere(node, nm) {
    return this.err(node, `'${nm}' 是另一个模块里的 struct，这个文件没有把它引进来 ——`
      + ` \`access m;\` 只给限定名，要裸用得写 \`import m;\`（那边报 "no type of name '${nm}'"）`);
  }

  /** `t` 是声明过的记录（asy 的 struct）吗。`t` 已经是解析好的类型名，所以查全局那张表 */
  isRec(t) { return t !== null && t !== undefined && this.records.has(t); }

  /** `el` 能当数组元素吗（第十九刀起记录也能：asy 的 struct 是引用类型，`A[]` 是一串句柄；
   *  多维数组这一刀起数组自己也能 —— 格子里躺的同样是句柄） */
  arrElemOk(el) {
    if (asyIsArr(el)) return this.arrElemOk(asyElem(el));
    return ASY_ARRELEM.has(el) || this.isRec(el);
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
   * 门外的一条：把方法当值取出来（`int f() = a.late;` asy 收）—— 那要闭包（绑住接收者）。
   */
  recordDec(n, at) {
    const nm = isAtom(n.items[1]) ? n.items[1].value : null;
    if (nm === null) return this.nope(n, '没有名字的 struct');
    if (SCALARS.has(nm) || nm === 'pair' || nm === 'triple' || nm === 'void') {
      return this.err(n, `'${nm}' 是内建类型名，不能当 struct 名`);
    }
    if (this.recVis.has(nm)) return this.nope(n, `重复定义的 struct '${nm}'`);
    // struct 名是**全局共享**的一个命名空间（第二十五刀）：核心方言的 class 名、方法名
    // （`asy__m_<记录>_<方法>`）、构造函数名都是按记录名拼的，所以两个模块里同名的 struct
    // 这一刀不收 —— 拒得明白，比悄悄让一个盖掉另一个好。
    if (this.records.has(nm)) {
      return this.nope(n, `两个模块里都有 struct '${nm}'（这一刀的 struct 名是全局共享的）`);
    }
    const fields = [];
    // 记录先登记（字段还空着）：方法的签名可以提到这个记录自己（`A copy()`），
    // 而 type() 是查 recVis 认记录名的。自引用字段那一条拦在 type() 前面，
    // 所以"字段还空着"这件事在这里看不出问题。
    const rec = { name: nm, fields: fields, at: at, unit: this.unit.id };
    this.records.set(nm, rec);
    this.recVis.set(nm, { rec, at });
    // 体里的类型名按**这个 struct 的位置**判可见（recHere）：字段与方法签名只能提到
    // 前面声明过的记录。第一遍走到这里时 this.at 还是 0，所以要现设现还。
    const keepAt = this.at;
    this.at = at;
    const out = this.recordBody(n, rec, at);
    this.at = keepAt;
    return out;
  }

  /** recordDec 的体（分出来只为了那句 this.at 现设现还） */
  recordBody(n, rec, at) {
    const nm = rec.name;
    const fields = rec.fields;
    const seen = new Map();
    let mat = 0;
    for (const item of this.flat(n.items[2], 'block')) {
      const r = this.unwrapMod(item);
      if (!isList(r)) continue;
      // `autounravel`（第二十八刀）：这个成员其实是**文件级**声明 —— 交给 sig，
      // 正文攒在 auFns 里跟文件级函数一起发。它不占成员槽（不是字段也不是方法）。
      if (this.auMod(item)) {
        if (head(r) !== 'fundec') {
          this.nope(r, `autounravel 的 '${head(r)}'（这一刀只有 autounravel 的函数与算符）`);
          return null;
        }
        this.sig(r, at);
        this.auFns.push({ node: r, at });
        continue;
      }
      if (head(r) === 'fundec') {
        if (this.methodSig(rec, r, mat, at) === null) return null;
        mat++;
        continue;
      }
      if (head(r) !== 'vardec') {
        return this.nope(r, `struct 里的 '${head(r)}'（这一刀只有字段声明与方法）`);
      }
      // 字段类型是**这个 struct 自己**：asy 收（量过 `struct A { A next; int x; } A a; write(a.x);`
      // 印 0 退 0 —— 它的字段是懒的，next 就搁着不造）。我们不收：隐式 operator init 要把
      // 内嵌的对象造出来，自引用就是无限递归。这一条要拦在 type() 前面，不然 'A' 还没进
      // this.records，漏出去的是那句泛泛的「类型 'A'」。
      if (isList(r.items[1]) && head(r.items[1]) === 'name-ty'
          && this.plainName(r.items[1].items[1]) === nm) {
        return this.nope(r, `struct ${nm} 里放一个 ${nm} 字段（自引用）`);
      }
      const ft = this.type(r.items[1], `struct ${nm} 的字段`);
      if (ft === null) return null;
      if (!SCALARS.has(ft) && ft !== 'pair' && ft !== 'triple' && !this.isRec(ft)
          && !(asyIsArr(ft) && this.arrElemOk(asyElem(ft)))) {
        return this.nope(r, `struct ${nm} 的 ${ft} 字段（这一刀的字段只有 `
          + `int/real/bool/string/pair/triple、它们的一维数组，与**前面已经声明过**的 struct）`);
      }
      for (const d of this.flat(r.items[2], 'decids')) {
        if (!isList(d) || head(d) !== 'decid') return this.err(d, '认不出的字段声明');
        const start = d.items[1];
        if (!isList(start) || head(start) !== 'decidstart' || start.items.length !== 2) {
          return this.nope(start, '带维度或形参表的字段名');
        }
        const fn = isAtom(start.items[1]) ? start.items[1].value : null;
        if (fn === null) return this.err(start, '字段少了名字');
        if (seen.has(fn)) return this.err(d, `struct ${nm} 里有两个字段叫 '${fn}'`);
        seen.set(fn, true);
        fields.push({ name: fn, type: ft, def: d.items[2] === undefined ? null : d.items[2], mat: mat });
      }
      // 一条 vardec 可以声明好几个字段，它们在 asy 那边是**同一步**（互相看不见），
      // 所以 mat 是按声明语句加一，不是按字段加一。
      mat++;
    }
    // 核心方言的 class 至少要一个字段，而"只有方法的 struct"在 asy 那边是合法的 ——
    // 这条边界因此留着（要放开就得给 class 一个空字段表，那是方言那边的事）。
    if (fields.length === 0) return this.nope(n, `没有字段的 struct '${nm}'`);
    return null;
  }

  /** 记录里的字段。找不到时把有哪些字段一起说出来。 */
  recField(n, t, nm) {
    const rec = this.records.get(t);
    for (const f of rec.fields) if (f.name === nm) return f;
    // 名字其实是个**方法**：那不是"没有这个成员"，是"把方法取出来当值"——
    // asy 收（量过 `int f() = a.get;` 那句印 1：方法取出来是绑住接收者的闭包），
    // 我们不收，因为我们的方法是"多一个 this 形参的普通函数"，绑接收者要现造一个闭包。
    // 说清是这一条而不是那句泛泛的"没有字段"，`tests/asy/bad/fn-value.asy` 钉着。
    if (this.visibleMethods(rec, nm).length > 0) {
      return this.nope(n, `把方法当值取出来（${t}.${nm} —— 那是绑住接收者的闭包，`
        + '而我们的方法是多一个 this 形参的普通函数）');
    }
    const names = [];
    for (const f of rec.fields) names.push(f.name);
    return this.err(n, `struct ${t} 没有字段 '${nm}' —— 有的是 ${names.join(' / ')}`);
  }

  /**
   * `new A` 的代码。字段全无默认值时就是 `(cnew A)`；有默认值就走一个生成的构造函数，
   * 因为默认值要**每次构造都重新求**（量过：`struct B { int n = bump(); }`，
   * `new B` 两次之后计数器是 2）。同一个记录只生一份构造函数。
   */
  recNew(n, t) {
    const rec = this.records.get(t);
    let any = false;
    // 记录类型的字段也算"有默认值"：asy 给它跑一遍 operator init（量过 `struct B { A a; }`
    // 之后 `b.a.y` 是 A 的字段默认值，不是空引用），所以这种记录一定要走构造函数。
    for (const f of rec.fields) if (f.def !== null || this.isRec(f.type)) any = true;
    if (!any) return `(cnew ${t})`;
    const had = this.recInits.get(t);
    if (had !== undefined) return `(call ${had})`;
    const fname = `asy__new_${t}`;
    this.recInits.set(t, fname);
    // 构造函数是另一个作用域、另一串语句（与 defWrapper 同一套保存/还原）。
    // `at` 也挪到**这个 struct 的声明处**：字段默认值与内嵌记录该看见谁，是在那里定的
    // （量过：`struct B { A a; }` 写在 `A operator init()` 前面时 `b.a.x` 是 0，
    // 写在后面才是那份构造给的值 —— 所以这一份正文只生成一次是对的）。
    const savePre = this.pre;
    const saveUpd = this.updates;
    const saveScopes = this.scopes;
    const saveAt = this.at;
    if (rec.at !== undefined) this.at = rec.at;
    this.scopes = [new Map()];
    this.updates = [];
    const lines = [`(let o ${t} (cnew ${t}))`];
    this.pre = lines;
    this.declare(n, 'o', t);
    let bad = false;
    for (const f of rec.fields) {
      if (f.def === null) {
        // 内嵌的记录：没写默认值也要给它一个**新对象**（字段类型只能是前面声明过的记录，
        // 所以这里的递归一定会到底）。走 recInit：文件级的 operator init 管得到这一格。
        if (this.isRec(f.type)) {
          const mk = this.recInit(n, f.type);
          if (mk === null) { bad = true; break; }
          lines.push(`(fldset (var o) ${f.name} ${mk})`);
        }
        continue;
      }
      const v = this.coerce(this.expr(f.def), f.type, f.def, `字段 '${t}.${f.name}' 的默认值`);
      if (v === null) { bad = true; break; }
      lines.push(`(fldset (var o) ${f.name} ${v.code})`);
    }
    lines.push('(ret (var o))');
    this.pre = savePre;
    this.updates = saveUpd;
    this.scopes = saveScopes;
    this.at = saveAt;
    if (bad) return null;
    const text = [`  (fn ${fname} () ${t}`];
    for (const s of lines) text.push(`    ${s}`);
    this.wraps.push(`${text.join('\n')})`);
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
      this.at = rec.at;
      const out = this.recInitHere(n, t);
      this.unitOut(prev);
      return out;
    }
    return this.recInitHere(n, t);
  }

  recInitHere(n, t) {
    const oi = this.oinitFor(t);
    if (oi !== null) return `(call ${oi.sym})`;
    return this.recNew(n, t);
  }

  /** `(name x)` -> 'x'；`(qualified ...)` 与算符名（`operator +`）都回 null */
  plainName(node) {
    if (!isList(node) || head(node) !== 'name') return null;
    const a = node.items[1];
    if (!isAtom(a)) return null;
    if (a.value.startsWith('operator ')) return null;
    return a.value;
  }

  /* ---------------------------------------------------------------- 表达式 */

  /** 出 `{code, type}`；失败回 null（诊断已记） */
  expr(n) {
    if (n === undefined || n === null) return this.err(null, '少了一个表达式');
    // 字面量：LIT 是裸原子（`3` / `3.5` / `true`），STRING 是字符串节点
    if (isStr(n)) return { code: `(str ${strLit(n.value)})`, type: 'string' };
    if (isAtom(n)) return this.lit(n);
    if (!isList(n)) return this.err(n, '认不出的表达式');
    return this.exprList(n, head(n));
  }

  lit(n) {
    const t = n.value;
    if (t === 'true' || t === 'false') return { code: `(bool ${t})`, type: 'bool' };
    if (/^[0-9]/.test(t) || t.startsWith('.')) {
      const real = t.includes('.') || t.includes('e') || t.includes('E');
      return real ? { code: `(real ${t})`, type: 'real' } : { code: `(int ${t})`, type: 'int' };
    }
    // `cycle` 在词法上是 LIT（camp.l 里它走 yylval.e，不是关键字），但在语义上它是
     // 一个**值** —— 绘图层里那个"闭合记号"。所以这里把它解析成一个名字：
    // `cyclepath`（不能就叫 cycle —— 那是 LIT，asy 源码里声明不出这个名字）。
    // 于是 `a--cycle` 是普通的 `operator --(path, path)`，前端不必知道 path 是什么。
    // 没引绘图层时报的是「未声明的变量 'cyclepath'」—— 那句话指得有点偏，所以这里
    // 自己给一句。
    if (t === 'cycle') {
      if (!this.globals.has(ASY_CYCLE) && this.lookup(ASY_CYCLE) === null) {
        return this.nope(n, "'cycle'（它是绘图层的闭合记号，要 `import plain;`）");
      }
      return this.nameOf(n, ASY_CYCLE);
    }
    return this.nope(n, `字面量 '${t}'`);
  }

  /** 一个裸名字当表达式：局部 -> this 的字段 -> 文件级。name-exp 与 `cycle` 共用这一份。 */
  nameOf(n, nm) {
    const t = this.lookup(nm);
    if (t !== null) return { code: `(var ${nm})`, type: t };
    const f = this.selfField(nm);
    if (f !== null) return { code: `(fld (var this) ${nm})`, type: f.type };
    const g = this.gvarHere(nm);
    if (g !== null && g.ok) return { code: `(var ${g.sym})`, type: g.type };
    if (g !== null) {
      return this.nope(n, `函数里引用文件级变量 '${nm}'（模块级变量收 int/real/bool/string、`
        + 'pair/triple、struct，与它们的一维数组 —— 这一条不在里面）');
    }
    if (this.globals.has(nm)) return this.gvarLate(n, nm);
    // 裸的**函数名**当值用（`findroot(f, a, b)` 的那个 f）。只有一个候选时才收 ——
    // 有多个重载时"是哪一个"要靠期望类型定案，而这一层是自底向上定型的，没有期望类型可问。
    // **实参位置**上那一条已经补了（见 overArg / fit：callArgs 先不定案，等 fit 拿槽的类型
    // 挑同型的一份）；到这里还落下来的是别的位置 —— 主要是变量的初值（`real g(real,real)
    // = both;`，真 asy 收，见 bad/overload-value-init.asy）。那种情况报"还没做"而不是猜一个。
    const cands = this.visible(nm);
    if (cands.length === 1) {
      const c = cands[0];
      if (c.ps !== undefined) {
        for (const p of c.ps) if (p.def !== null && p.def !== undefined) {
          return this.nope(n, `把带默认值的函数 '${nm}' 当值用（函数值没有默认值）`);
        }
      }
      let ps = '';
      for (const p of c.params) ps = ps === '' ? p : `${ps},${p}`;
      return { code: `(fnref ${c.sym})`, type: `${c.ret}(${ps})` };
    }
    if (cands.length > 1) {
      return this.nope(n, `把有 ${cands.length} 个重载的 '${nm}' 当值用`
        + '（是哪一个要靠期望类型定案，这一层是自底向上定型的）');
    }
    return this.err(n, `未声明的变量 '${nm}'`);
  }

  /** 重载集按期望类型落成 `(fnref …)`（挑不出来给 null）。fit 已经挑过一遍，这里是落地 */
  overPick(r, want) {
    for (const c of r.v.over) if (this.candFnType(c) === want) return `(fnref ${c.sym})`;
    return null;
  }

  /** 一个候选当**函数值**时的类型文本（与 nameOf 里那份拼法必须一致） */
  candFnType(c) {
    let ps = '';
    for (const p of c.params) ps = ps === '' ? p : `${ps},${p}`;
    return `${c.ret}(${ps})`;
  }

  /**
   * 实参位置上的一个**裸名字**，而它是个有多个重载的函数名 —— 这里**先不定案**，
   * 回那一串候选，让 fit 按"这个槽要什么类型"挑（asy 就是这么定的：函数名当值用时
   * 由期望类型选重载）。挑不出来就是没有能匹配的签名，与别的实参一视同仁。
   *
   * 量出来的理由：内建面一加 `add(frame,frame)`，用户自己的 `add(int,int)` 就与它同一个
   * 重载集，`fold3(add,1,2,3)` 那句在真 asy 那边是通的，在我们这里报"当值用"。
   *
   * 顺序照 nameOf：局部量、`this` 的字段、文件级变量都遮住函数名（那三档里有就不是这条路）。
   * 带默认值的候选一律不算 —— 函数值没有默认值（nameOf 里同一条）。
   */
  overArg(node) {
    if (!isList(node) || head(node) !== 'name-exp') return null;
    const nm = this.plainName(node.items[1]);
    if (nm === null) return null;
    if (this.lookup(nm) !== null) return null;
    if (this.selfField(nm) !== null) return null;
    if (this.gvarHere(nm) !== null || this.globals.has(nm)) return null;
    const cands = this.visible(nm);
    if (cands.length < 2) return null;
    const out = [];
    for (const c of cands) {
      let ok = true;
      if (c.ps !== undefined) {
        for (const p of c.ps) if (p.def !== null && p.def !== undefined) ok = false;
      }
      if (ok) out.push(c);
    }
    return out.length < 2 ? null : { nm: nm, cands: out };
  }


  /** 数值提升：asy 允许 `3 == 3.0`（量过），核心方言两边必须同型，于是这里显式插 toreal。
   *  pair 也在这条链上：`2+(1,2)` 是 (3,2)、`(1,2)==3` 是 false —— int/real 会被
   *  提成 `(v,0)`（量过，见 asy__pdiv 的注释：连 `/` 都是先转 pair 再算的）。 */
  promote(a, b) {
    if (a.type === b.type) return a.type;
    if (a.type === 'pair' && (b.type === 'int' || b.type === 'real')) {
      const v = this.toPair(b);
      b.code = v.code; b.type = 'pair';
      return 'pair';
    }
    if (b.type === 'pair' && (a.type === 'int' || a.type === 'real')) {
      const v = this.toPair(a);
      a.code = v.code; a.type = 'pair';
      return 'pair';
    }
    if (a.type === 'int' && b.type === 'real') { a.code = `(toreal ${a.code})`; a.type = 'real'; return 'real'; }
    if (a.type === 'real' && b.type === 'int') { b.code = `(toreal ${b.code})`; b.type = 'real'; return 'real'; }
    return null;
  }

  /** int/real -> pair，就是 `(v, 0)`。asy 那边这是一条隐式转换，不是重载。 */
  toPair(v) {
    const x = v.type === 'int' ? `(toreal ${v.code})` : v.code;
    return { code: `(vlit ${ASY_PAIR_TY} ${x} (real 0.0))`, type: 'pair' };
  }

  /** 往目标类型靠：int -> real、int/real -> pair，其余不匹配就是错 */
  coerce(v, want, node, what) {
    if (v === null) return null;
    if (v.type === want) return v;
    if (v.type === 'int' && want === 'real') return { code: `(toreal ${v.code})`, type: 'real' };
    if (want === 'pair' && (v.type === 'int' || v.type === 'real')) return this.toPair(v);
    // 用户定义的转换（第二十七刀）：内建那几条不成才轮到它，源类型要一模一样（不串）
    const uc = this.castFor(want, v.type, false);
    if (uc !== null) return { code: `(call ${uc.sym} ${v.code})`, type: want };
    return this.err(node, `${what}：要 ${want}，这里是 ${v.type}`);
  }

  exprList(n, h) {
    if (h === 'name-exp') {
      const nm = this.plainName(n.items[1]);
      if (nm === null) {
        // `a.length` / `z.x`：词法上"点"是名字的一部分（`name -> name "." ID`），所以
        // 数组和 pair 的字段都不是 `(field …)` 而是一个**带点的名字**。
        const q = this.dotQual(n.items[1]);
        if (q === DOT_BAD) return null;
        if (q !== null) return this.member(n, q.recv, q.field);
        // `m.x`：模块限定的名字（第二十五刀）。变量先查（dotQual 在上面），
        // 所以同名的局部量遮住模块别名。
        const mq = this.modAlias(n.items[1]);
        if (mq !== null) return this.modVar(n, mq);
        return this.nope(n, '带点的名字或算符名');
      }
      // 局部 -> this 的字段 -> 文件级，三档都在 nameOf 里（`cycle` 那个字面量共用它）。
      // 顺序解析：后面才声明的那份文件级变量在这里不算（量过 asy 报
      // "no matching variable of name 'g'"）；struct 的成员遮住同名的文件级名字。
      return this.nameOf(n, nm);
    }
    if (h === 'binary') return this.binary(n);
    // `this`（第二十刀）：方法体里就是那个接收者形参。asy 那边 `this` 只在 struct 的
    // 方法里有意义（量过：文件级写 `this` 报 "static use of dynamic variable"）。
    if (h === 'this') {
      if (this.self === null) return this.err(n, "'this' 只能在 struct 的方法里用");
      return { code: '(var this)', type: this.self.rec.name };
    }
    if (h === 'equality') return this.compare(n, n.items[1].value);
    if (h === 'and-exp' || h === 'or-exp') return this.logic(n, h === 'and-exp' ? '&&' : '||');
    if (h === 'unary') return this.unary(n);
    if (h === 'cast') return this.cast(n);
    if (h === 'call') return this.call(n);
    if (h === 'cond') return this.cond(n);
    if (h === 'assign' || h === 'self' || h === 'prefix' || h === 'postfix') {
      return this.nope(n, `赋值/自增出现在表达式位置（'${h}'）—— 这一刀只认它们当语句`);
    }
    if (h === 'tuple-exp') return this.pairLit(n);
    if (h === 'subscript') return this.index(n);
    if (h === 'slice-exp') return this.slice(n);
    if (h === 'field') return this.field(n);
    if (h === 'new-array') return this.newArray(n);
    // `new A`：asy 的 struct 是引用语义的，所以降到核心方言的 `(cnew A)`（或者带默认值时
    // 走生成的构造函数，见 recNew）。`new-function` 要函数值，那是另一刀。
    if (h === 'new-record') {
      const t = this.type(n.items[1], 'new 的类型');
      if (t === null) return null;
      if (!this.isRec(t)) return this.nope(n, `new ${t}`);
      const code = this.recNew(n, t);
      return code === null ? null : { code: code, type: t };
    }
    if (h === 'new-function') return this.nope(n, 'new');
    if (h === 'arrayinit' || h === 'arrayinit-add' || h === 'arrayinit-rest') {
      // `{1,2,3}` 自己没有类型，类型来自左边的声明 —— 所以只在知道目标类型的地方处理
      return this.nope(n, '花括号数组初值出现在推不出元素类型的位置（只支持 `T[] a = {…}` 与 `new T[] {…}`）');
    }
    if (h === 'scale') return this.nope(n, '隐式缩放（`105cm` 这种）');
    if (h === 'join-exp') return this.joinExp(n);
    if (h === 'join-dir' || h === 'spec' || h === 'spec-curl') return this.nope(n, '路径连接');
    return this.nope(n, `表达式 '${h}'`);
  }

  /* ------------------------------------------------------------------ 数组 */

  /** `a[i]` 的**读**侧。写侧在 assign 里，因为写要先扩长（asy 的下标写会长）。 */
  index(n) {
    const a = this.expr(n.items[1]);
    if (a === null) return null;
    if (!asyIsArr(a.type)) return this.err(n, `下标只能用在数组上，这里是 ${a.type}`);
    const i = this.coerce(this.expr(n.items[2]), 'int', n, '下标');
    if (i === null) return null;
    return { code: `(aget ${a.code} ${i.code})`, type: asyElem(a.type) };
  }

  /**
   * `a[i:j]` / `a[i:]` / `a[:j]` / `a[:]`。**是复制不是视图**（量过），半开区间，
   * 右边界超长截到末尾。四种形状都落到那两条 helper 上，接收者只印一遍。
   *
   * 形状要按**项数**分，不能只看头：语法里 `[:]` 与 `[i:j]` 的头都是 `slice`
   * （`(-> (":") (slice))` 和 `(-> (exp ":" exp) (slice $1 $3))`）。
   */
  slice(n) {
    const a = this.expr(n.items[1]);
    if (a === null) return null;
    if (!asyIsArr(a.type)) return this.err(n, `切片只能用在数组上，这里是 ${a.type}`);
    const s = n.items[2];
    if (!isList(s)) return this.err(n, '认不出的切片');
    const hs = head(s);
    const el = asyElem(a.type);
    const both = hs === 'slice' && s.items.length === 3;
    if (!both && hs !== 'slice' && hs !== 'slice-from' && hs !== 'slice-to') {
      return this.nope(n, `切片的形状 '${hs}'`);
    }
    const loNode = both ? s.items[1] : (hs === 'slice-from' ? s.items[1] : null);
    const hiNode = both ? s.items[2] : (hs === 'slice-to' ? s.items[1] : null);
    const lo = loNode === null
      ? { code: '(int 0)', type: 'int' }
      : this.coerce(this.expr(loNode), 'int', n, '切片的起点');
    if (lo === null) return null;
    const sliceFn = this.arrHelper('slice', el);
    if (hiNode !== null) {
      const hi = this.coerce(this.expr(hiNode), 'int', n, '切片的终点');
      if (hi === null) return null;
      return { code: `(call ${sliceFn} ${a.code} ${lo.code} ${hi.code})`, type: a.type };
    }
    // `a[i:]` 与 `a[:]`：末端是长度
    return { code: `(call ${this.arrHelper('slicefrom', el)} ${a.code} ${lo.code})`, type: a.type };
  }

  /** `(qualified (name a) F)` 且 a 是**变量**时回 `{recv, field}`，否则回 null；
   *  接收者已经报过错的那种回 DOT_BAD（调用方就不再补一句"认不出的带点名字"）。
   *  只认变量与「变量再点几层」：`模块.名字` 也是这个形状，那要模块系统，这一刀没有。 */
  dotQual(node) {
    if (!isList(node) || head(node) !== 'qualified') return null;
    const f = isAtom(node.items[2]) ? node.items[2].value : null;
    if (f === null) return null;
    const base = this.plainName(node.items[1]);
    if (base !== null) {
      const t = this.lookup(base);
      if (t !== null) return { recv: { code: `(var ${base})`, type: t }, field: f };
      // 方法体里的裸字段名当接收者（第二十刀）：`inner.get()` 里的 inner 是 this 的字段
      const sf = this.selfField(base);
      if (sf !== null) return { recv: { code: `(fld (var this) ${base})`, type: sf.type }, field: f };
      // 文件级变量当接收者（第三十刀）：`currentpicture.nodes` 这一族。次序与 name-exp
      // 那边一致 —— 局部、this 的字段、文件级，三档。
      const g = this.gvarHere(base);
      if (g !== null && g.ok) return { recv: { code: `(var ${g.sym})`, type: g.type }, field: f };
      return null;
    }
    // `a.p.x`：接收者自己又是一个带点的名字（第十五刀的 pair 字段逼出来的 ——
    // struct 的 pair 字段一进来，`s.p.x` 就成了三层）。递归先把它降成一个值。
    // 这里不怕重复求值：能走到这条路的接收者只有变量读与字段读，两者都没有副作用。
    const inner = this.dotQual(node.items[1]);
    if (inner === null) return null;
    if (inner === DOT_BAD) return DOT_BAD;
    const recv = this.member(node.items[1], inner.recv, inner.field);
    return recv === null ? DOT_BAD : { recv, field: f };
  }

  /** `(field 值 ID)`：`a[0].x` 这种（点后面跟的不是名字而是别的表达式时走这条） */
  field(n) {
    const nm = isAtom(n.items[2]) ? n.items[2].value : null;
    const a = this.expr(n.items[1]);
    if (a === null) return null;
    return this.member(n, a, nm);
  }

  /** 取字段。数组只有 `.length`，pair 只有 `.x`/`.y`，记录按声明的字段来；别的都还没做。 */
  member(n, recv, nm) {
    if (asyIsArr(recv.type)) {
      if (nm === 'length') return { code: `(alen ${recv.code})`, type: 'int' };
      return this.nope(n, `数组的 '.${nm}'（这一刀只有 .length / .push / .pop）`);
    }
    if (this.isRec(recv.type)) {
      const f = this.recField(n, recv.type, nm);
      return f === null ? null : { code: `(fld ${recv.code} ${nm})`, type: f.type };
    }
    if (recv.type === 'pair') {
      if (nm === 'x') return { code: `(lane ${recv.code} 0)`, type: 'real' };
      if (nm === 'y') return { code: `(lane ${recv.code} 1)`, type: 'real' };
      return this.nope(n, `pair 的 '.${nm}'（这一刀只有 .x / .y）`);
    }
    if (recv.type === 'triple') {
      if (nm === 'x') return { code: `(lane ${recv.code} 0)`, type: 'real' };
      if (nm === 'y') return { code: `(lane ${recv.code} 1)`, type: 'real' };
      if (nm === 'z') return { code: `(lane ${recv.code} 2)`, type: 'real' };
      return this.nope(n, `triple 的 '.${nm}'（这一刀只有 .x / .y / .z）`);
    }
    return this.nope(n, `取字段 '.${nm}'`);
  }

  /* -------------------------------------------------------------------- pair */

  /** `(x,y)` 是 pair、`(x,y,z)` 是 triple。分量按 int -> real 提升。 */
  pairLit(n) {
    const parts = this.flat(n.items[1], 'args');
    if (parts.length === 3) return this.tripleLit(n, parts);
    if (parts.length !== 2) return this.nope(n, `${parts.length} 个分量的字面量`);
    const x = this.coerce(this.expr(parts[0]), 'real', parts[0], 'pair 的 x');
    const y = this.coerce(this.expr(parts[1]), 'real', parts[1], 'pair 的 y');
    if (x === null || y === null) return null;
    return { code: `(vlit ${ASY_PAIR_TY} ${x.code} ${y.code})`, type: 'pair' };
  }

  /** `(x,y,z)`。第 3 道垫 0（见 ASY_TRIPLE_TY 上方那段：MIR 的宽度是对数编码）。 */
  tripleLit(n, parts) {
    const x = this.coerce(this.expr(parts[0]), 'real', parts[0], 'triple 的 x');
    const y = this.coerce(this.expr(parts[1]), 'real', parts[1], 'triple 的 y');
    const z = this.coerce(this.expr(parts[2]), 'real', parts[2], 'triple 的 z');
    if (x === null || y === null || z === null) return null;
    return { code: `(vlit ${ASY_TRIPLE_TY} ${x.code} ${y.code} ${z.code} (real 0.0))`, type: 'triple' };
  }

  /** pair / triple 上的内建函数（名单见 ASY_PAIRFN）。实参是 int/real 时先隐式转成 pair。 */
  pairCall(n, nm) {
    const args = this.args(n.items[2]);
    if (args === null) return null;
    // dot / cross / realmult：pair 与 triple 各一个重载，两组都量过
    // （dot((1,2),(3,4))=11、cross(pair,pair) 给**实数** -2、realmult 逐分量；
    //  triple 那三条给 32 / (-3,6,-3) / (4,10,18)）
    if (nm === 'dot' || nm === 'cross' || nm === 'realmult') return this.vecPairFn(n, nm, args);
    // dir/expi：一个实参是 pair 那一族（度 / 弧度），**两个**实参是 triple 那一族
    // （量过 dir(30,45) 与 expi(0.5,1.0) 都给 triple）；dir(pair) 是 unit 的别名
    if (nm === 'dir' || nm === 'expi') {
      if (args.length === 2) return this.tripleDir(n, nm, args);
      if (args.length !== 1) return this.err(n, `'${nm}' 要 1 或 2 个实参，给了 ${args.length} 个`);
      const v0 = this.expr(args[0]);
      if (v0 === null) return null;
      if (nm === 'dir' && v0.type === 'pair') return this.unitOf(v0);
      const r = this.coerce(v0, 'real', args[0], `'${nm}' 的实参`);
      if (r === null) return null;
      this.used.add('asy__pexpi');
      if (nm === 'expi') return { code: `(call asy__pexpi ${r.code})`, type: 'pair' };
      this.used.add('asy__pdir');
      return { code: `(call asy__pdir ${r.code})`, type: 'pair' };
    }
    // angle(z) / angle(z, warn)：第二个实参量过是 bool，默认 true
    if (nm === 'angle') {
      if (args.length < 1 || args.length > 2) {
        return this.err(n, `'angle' 要 1 或 2 个实参，给了 ${args.length} 个`);
      }
      const z = this.coerce(this.expr(args[0]), 'pair', args[0], "'angle' 的实参");
      if (z === null) return null;
      let warn = '(bool true)';
      if (args.length === 2) {
        const w = this.coerce(this.expr(args[1]), 'bool', args[1], "'angle' 的 warn");
        if (w === null) return null;
        warn = w.code;
      }
      this.used.add('asy__pangle');
      return { code: `(call asy__pangle ${z.code} ${warn})`, type: 'real' };
    }
    if (args.length !== 1) return this.err(n, `'${nm}' 要 1 个实参，给了 ${args.length} 个`);
    const v0 = this.expr(args[0]);
    if (v0 === null) return null;
    // triple 那一族。conj/angle 在 triple 上 asy 自己就没有（量过 "no matching function
    // 'conj(triple)'" / "'angle(triple)'"），所以是**错**而不是"还没做"。
    if (v0.type === 'triple') {
      if (nm === 'xpart') return { code: `(lane ${v0.code} 0)`, type: 'real' };
      if (nm === 'ypart') return { code: `(lane ${v0.code} 1)`, type: 'real' };
      if (nm === 'zpart') return { code: `(lane ${v0.code} 2)`, type: 'real' };
      if (nm === 'unit') return this.tunitOf(v0);
      return this.err(n, `'${nm}(triple)' asy 那边没有这个重载`);
    }
    // zpart 只有 triple 那一个重载（量过 zpart((1,2)) 是 "cannot call 'real zpart(triple v)'"）
    if (nm === 'zpart') return this.err(n, `'zpart' 只收 triple，这里是 ${v0.type}`);
    const v = this.coerce(v0, 'pair', args[0], `'${nm}' 的实参`);
    if (v === null) return null;
    if (nm === 'xpart') return { code: `(lane ${v.code} 0)`, type: 'real' };
    if (nm === 'ypart') return { code: `(lane ${v.code} 1)`, type: 'real' };
    if (nm === 'unit') return this.unitOf(v);
    this.used.add('asy__pconj');
    return { code: `(call asy__pconj ${v.code})`, type: 'pair' };
  }

  /** `dot` / `cross` / `realmult`：两个实参，pair 与 triple 各一个重载。 */
  vecPairFn(n, nm, args) {
    if (args.length !== 2) return this.err(n, `'${nm}' 要 2 个实参，给了 ${args.length} 个`);
    const a = this.expr(args[0]);
    const b = this.expr(args[1]);
    if (a === null || b === null) return null;
    if (a.type === 'triple' || b.type === 'triple') {
      if (a.type !== 'triple' || b.type !== 'triple') {
        return this.err(n, `'${nm}' 的两个实参要同型：左是 ${a.type}，右是 ${b.type}（asy 那边没有到 triple 的转换）`);
      }
      const h = nm === 'dot' ? 'asy__tdot' : (nm === 'cross' ? 'asy__tcross' : 'asy__trealmult');
      this.used.add(h);
      return { code: `(call ${h} ${a.code} ${b.code})`, type: nm === 'dot' ? 'real' : 'triple' };
    }
    const av = this.coerce(a, 'pair', args[0], `'${nm}' 的左实参`);
    const bv = this.coerce(b, 'pair', args[1], `'${nm}' 的右实参`);
    if (av === null || bv === null) return null;
    const h = nm === 'dot' ? 'asy__pdot' : (nm === 'cross' ? 'asy__pcross' : 'asy__prealmult');
    this.used.add(h);
    // cross(pair,pair) 回的是**实数**（量过 -2），不是 pair
    return { code: `(call ${h} ${av.code} ${bv.code})`, type: nm === 'realmult' ? 'pair' : 'real' };
  }

  /** `dir(θ,φ)` / `expi(θ,φ)`：两个实参那一族回 triple（dir 收度、expi 收弧度）。 */
  tripleDir(n, nm, args) {
    const t = this.coerce(this.expr(args[0]), 'real', args[0], `'${nm}' 的第一个实参`);
    const p = this.coerce(this.expr(args[1]), 'real', args[1], `'${nm}' 的第二个实参`);
    if (t === null || p === null) return null;
    this.used.add('asy__texpi');
    if (nm === 'expi') return { code: `(call asy__texpi ${t.code} ${p.code})`, type: 'triple' };
    this.used.add('asy__tdir');
    return { code: `(call asy__tdir ${t.code} ${p.code})`, type: 'triple' };
  }

  /** unit(triple) */
  tunitOf(v) {
    this.used.add('asy__tabs');
    this.used.add('asy__tsdiv');
    this.used.add('asy__tunit');
    return { code: `(call asy__tunit ${v.code})`, type: 'triple' };
  }

  /** unit(z)：`dir(pair)` 也走它（量过两者同值） */
  unitOf(v) {
    this.used.add('asy__pabs');
    this.used.add('asy__punit');
    return { code: `(call asy__punit ${v.code})`, type: 'pair' };
  }

  /* ----------------------------------------------------------------- 字符串 */

  /**
   * `length(…)`：asy 只有 string 和 pair 两个重载 —— 量过 `length(int[])` 是
   * "no matching function 'length(int[])'"（数组用 `a.length`），所以这里也拒，
   * 而且拒得不带 ASY_NOPE：这不是"还没做"，是 asy 自己就没有。
   */
  lengthCall(n) {
    const args = this.args(n.items[2]);
    if (args === null) return null;
    if (args.length !== 1) return this.err(n, `'length' 要 1 个实参，给了 ${args.length} 个`);
    const v = this.expr(args[0]);
    if (v === null) return null;
    return this.lengthOf(v, args[0]);
  }

  /** length 的后半段：实参**已经降好**。按值分出来是给"同名的模块函数一个都不合用"那条
   *  回退路用的（见 callName / builtinRaw）—— 实参不能求两次。 */
  lengthOf(v, at) {
    if (v.type === 'string') return { code: `(slen ${v.code})`, type: 'int' };
    if (v.type === 'pair' || v.type === 'int' || v.type === 'real') {
      const p = this.coerce(v, 'pair', at, "'length' 的实参");
      if (p === null) return null;
      this.used.add('asy__pabs');
      return { code: `(call asy__pabs ${p.code})`, type: 'real' };
    }
    if (v.type === 'triple') {
      this.used.add('asy__tabs');
      return { code: `(call asy__tabs ${v.code})`, type: 'real' };
    }
    return this.err(at, `length(${v.type}) 在 asy 那边就是 no matching function（数组的长度写 a.length）`);
  }

  /** 字符串上的内建函数（名单与形参类型见 ASY_STRFN）。 */
  strCall(n, nm) {
    const spec = ASY_STRFN.get(nm);
    const args = this.args(n.items[2]);
    if (args === null) return null;
    const max = spec.params.length;
    if (args.length < spec.min || args.length > max) {
      const want = spec.min === max ? `${max}` : `${spec.min} 或 ${max}`;
      return this.err(n, `'${nm}' 要 ${want} 个实参，给了 ${args.length} 个`);
    }
    const parts = [];
    for (let i = 0; i < args.length; i++) {
      const v = this.coerce(this.expr(args[i]), spec.params[i], args[i], `'${nm}' 的第 ${i + 1} 个实参`);
      if (v === null) return null;
      parts.push(v.code);
    }
    let fn = spec.fn;
    if (nm === 'substr' && args.length === 2) fn = spec.short;
    else if (nm === 'find' && args.length === 2) parts.push('(int 0)');
    this.used.add(fn);
    for (const d of ASY_STR_DEPS.get(fn) ?? []) this.used.add(d);
    return { code: `(call ${fn} ${parts.join(' ')})`, type: spec.ret };
  }

  /**
   * `string(x)` —— asy 只有两条重载（量过 `asy -noV`，别的都是 no matching function）：
   *   `string(Int)`                          -> 整数的十进制
   *   `string(real x, Int digits=DBL_DIG)`   -> DBL_DIG 就是 15；`string(3,4)` 走这一条
   * bool / pair / string 都**不收**（量过：`string(true)`、`string((1,2))`、`string("a")`
   * 那边全是 no matching function），所以这里也不收 —— 多收就是比 asy 多接受一门语言。
   * 印出来的形状与 `write` 是同一份，所以借 fmtStr（real 那一档正好是 %.15g）。
   * 绘图层（stage0/lib/asy/）要拼 PostScript 文本，它缺的就是这一个。
   */
  strConvCall(n) {
    const args = this.args(n.items[2]);
    if (args === null) return null;
    if (args.length === 1) {
      const v = this.expr(args[0]);
      if (v === null) return null;
      if (v.type !== 'int' && v.type !== 'real') {
        return this.err(n, `string(${v.type}) 在 asy 那边就是 no matching function`
          + '（string 只有 string(int) 与 string(real, int)）');
      }
      return { code: this.fmtStr(v.type, v.code), type: 'string' };
    }
    if (args.length === 2) {
      const v = this.coerce(this.expr(args[0]), 'real', args[0], "'string' 的第 1 个实参");
      const d = this.coerce(this.expr(args[1]), 'int', args[1], "'string' 的第 2 个实参（有效位数）");
      if (v === null || d === null) return null;
      return { code: `(tostr ${v.code} ${d.code})`, type: 'string' };
    }
    return this.err(n, `'string' 要 1 或 2 个实参，给了 ${args.length} 个`);
  }

  /**
   * `new T[n]` / `new T[]` / `new T[] {…}`，以及多维的 `new T[n][m]` / `new T[n][]`。
   *
   * `new T[n]` 的 n 个格子在 asy 那边是**未初始化**的，读会当场报错
   * （量过：`int[] b = new int[2]; write(b[0]);` -> "read uninitialized value from array
   * at index 0"）；我们填零值。差别写在文件头 —— 这类程序本来就是有 bug 的，
   * 但"我们给 0 而 asy 报错"必须写在明处，不能等着被发现。
   *
   * 多维的三种写法量过 asy 的行为，我们逐条对上：
   *   `new real[2][3]` 两层都铺满（我们生一个构造器函数，逐行 aset 一条新的）；
   *   `new real[2][]`  外层铺 2 格、**每格是空引用**（`a[0][0]` 报 dereference of null array，
   *                    我们的 `anew` 铺的正是空引用，读它是同一句运行期错误）；
   *   `new real[][]`   长度 0。
   */
  newArray(n) {
    const el = this.type(n.items[1], 'new 的元素类型');
    if (el === null) return null;
    if (el === 'void') return this.err(n, 'new void[] 不是一个类型');
    if (!this.arrElemOk(el)) return this.nope(n, `${el}[] （${ASY_ARRELEM_TEXT}）`);
    const dimexps = n.items[2];
    const hasCount = isList(dimexps) && (head(dimexps) === 'dimexps' || head(dimexps) === 'dimexps-add');
    const tail = n.items[3];
    const init = n.items[hasCount ? 3 : 4];
    // 尾巴上那串空 `[]`（`new real[2][]` 的第二层）。有初值时 items[3] 就是它。
    let empty = 0;
    if (tail !== undefined && isList(tail) && (head(tail) === 'dims' || head(tail) === 'dims+')) {
      const d = this.dimsDepth(tail);
      if (d === null) return this.err(n, 'new 里认不出的数组维数形状');
      empty = d;
    }
    // 元素类型 = celltype 再套上那串空 `[]`；`new real[2][]` 的元素就是 `real[]`。
    // 没给长度时（`new real[]`）那串空 `[]` **就是**数组本身的维数，不是额外的一层。
    const counts = hasCount ? this.flat(dimexps, 'dimexps') : [];
    const under = hasCount ? empty : empty - 1;
    const over = hasCount ? counts.length : 1;
    let base = el;
    let i = 0;
    while (i < under) { base = `${base}[]`; i++; }
    let t = base;
    i = 0;
    while (i < over) { t = `${t}[]`; i++; }
    if (init !== undefined && isList(init) && head(init).startsWith('arrayinit')) {
      if (hasCount) return this.nope(n, '既给长度又给花括号初值');
      return this.arrLit(init, t);
    }
    if (!hasCount) return { code: `(anew ${asyCore(t)} (int 0))`, type: t };
    const vals = [];
    for (const c of counts) {
      const v = this.coerce(this.expr(c), 'int', c, 'new T[n] 的长度');
      if (v === null) return null;
      vals.push(v.code);
    }
    if (counts.length === 1) return { code: `(anew ${asyCore(t)} ${vals[0]})`, type: t };
    let as = '';
    for (const v of vals) as = `${as} ${v}`;
    return { code: `(call ${this.arrNewHelper(base, counts.length)}${as})`, type: t };
  }

  /**
   * 花括号数组初值。核心方言里没有"数组字面量"这一条，所以摊成一串语句：
   * 先 anew 一个空的，再逐个 apush，最后把临时量当值用。这跟 `? :` 用的是同一套
   * `this.pre` 机制 —— 摊出来的语句落在**当前语句之前**，求值顺序不变。
   *
   * 元素本身是数组时（`new real[][] {{1,2},{3,4,5}}`）里面那一层花括号**递归**走这里 ——
   * 走 this.expr(x) 是不行的：那一层看不见"我该是 real[]"，只会报"推不出元素类型"。
   * 每一项各摊一个临时量，所以两行不会共用同一条（asy 那边也是两条独立的行）。
   */
  arrLit(n, t) {
    if (this.pre === null) return this.nope(n, '这个位置的花括号数组初值（它要摊成语句，这里放不下）');
    const el = asyElem(t);
    const items = [];
    if (head(n) === 'arrayinit-rest') return this.nope(n, '`{…, ...rest}` 这种初值');
    for (const x of this.flat(n, 'arrayinit')) items.push(x);
    const nm = `asy__a${this.tmp++}`;
    this.pre.push(`(let ${nm} ${asyCore(t)} (anew ${asyCore(t)} (int 0)))`);
    for (const x of items) {
      const nested = asyIsArr(el) && isList(x) && head(x).startsWith('arrayinit');
      const v = nested ? this.arrLit(x, el)
        : this.coerce(this.expr(x), el, x, `${t} 初值里的一项`);
      if (v === null) return null;
      this.pre.push(`(apush (var ${nm}) ${v.code})`);
    }
    return { code: `(var ${nm})`, type: t };
  }

  /** `a.push(v)` / `a.pop()`。asy 里 push 返回压进去的那个值（量过 `int x = c.push(9);`）。 */
  arrMethod(n, recv, nm) {
    const args = this.args(n.items[2]);
    if (args === null) return null;
    const el = asyElem(recv.type);
    if (nm === 'pop') {
      if (args.length !== 0) return this.err(n, `'pop' 不要实参，给了 ${args.length} 个`);
      return { code: `(apop ${recv.code})`, type: el };
    }
    if (nm !== 'push') return this.nope(n, `数组的 '.${nm}(…)'（这一刀只有 .push / .pop）`);
    if (args.length !== 1) return this.err(n, `'push' 要 1 个实参，给了 ${args.length} 个`);
    const v = this.coerce(this.expr(args[0]), el, args[0], "'push' 的实参");
    if (v === null) return null;
    // apush 在核心方言里是**语句**（它的"值"没人用），而 asy 的 push 是表达式且返回那个值。
    // 摊成 pre：先把值绑到临时量（只算一次），push 它，再把临时量当结果。
    if (this.pre === null) return this.nope(n, '这个位置的 `.push(…)`（它要摊成语句，这里放不下）');
    const tmp = `asy__p${this.tmp++}`;
    this.pre.push(`(let ${tmp} ${asyCore(el)} ${v.code})`);
    this.pre.push(`(apush ${recv.code} (var ${tmp}))`);
    return { code: `(var ${tmp})`, type: el };
  }

  /** 算术。asy 与核心方言不一致的四个算符（`/` `#` `%` `^`）全在这里换掉。 */
  binary(n) {
    const op = asyOpText(n.items[1]) ?? '?';
    const a = this.expr(n.items[2]);
    const b = this.expr(n.items[3]);
    if (a === null || b === null) return null;
    // 提升前的右操作数留一份：`opBuiltinSig` 里的 `promote` 会**就地**把 int 提成 pair，
    // 而 asy 的 `^` 在 pair 上是**两个重载**、按指数的静态类型分路（见下面 op === '^'）。
    const b0 = { code: b.code, type: b.type };
    // 用户定义的算符先问一遍（第二十三刀）：它跟内建在同一张候选表里，见 opUser
    const u = this.opUser(n, op, [a, b], this.opBuiltinSig([a, b]));
    if (u !== null) return u;
    if (op === '<' || op === '<=' || op === '>' || op === '>=') return this.cmpCode(n, op, a, b);
    if (op === '#') {
      if (a.type !== 'int' || b.type !== 'int') return this.err(n, `'#' 两边要是 int，这里是 ${a.type} 和 ${b.type}`);
      this.used.add('asy__quot');
      return { code: `(call asy__quot ${a.code} ${b.code})`, type: 'int' };
    }
    if (op === '%') {
      // pair 上 asy 自己就没有 `%`（量过："no matching function 'operator %(pair, int)'"），
      // 所以这条是**错**，不是"还没做"；real 上的 `%` 是真的还没做。
      if (a.type === 'pair' || b.type === 'pair') return this.err(n, `pair 上没有 '%'（asy 那边也没有这个算符）`);
      if (a.type === 'triple' || b.type === 'triple') return this.err(n, `triple 上没有 '%'（asy 那边也没有这个算符）`);
      if (a.type !== 'int' || b.type !== 'int') return this.nope(n, "real 上的 '%'");
      this.used.add('asy__mod');
      return { code: `(call asy__mod ${a.code} ${b.code})`, type: 'int' };
    }
    if (op === '^') {
      // triple 上 asy 自己就没有 `^`（量过："no matching function 'operator ^(triple, int)'"）
      if (a.type === 'triple' || b.type === 'triple') return this.err(n, `triple 上没有 '^'（asy 那边也没有这个算符）`);
      // pair 上的 `^` 是**复数幂**，而且 asy 是**两个重载**，判据是指数的**静态类型**、
      // 不是值：`int k=30; (1,2)^k` 给精确的 (-6890111163,29729597084)，而 `real e=30;`
      // 与 `pair w=(30,0);` 都给 (-6890111162.99996,…)（三条都量过）。所以这里按 b 的
      // 类型分路，不是"看看指数是不是整数"。
      if (a.type === 'pair' || b.type === 'pair') {
        const av = this.coerce(a, 'pair', n, "'^' 的左边");
        if (av === null) return null;
        this.used.add('asy__pmul');
        if (b0.type === 'int') {
          this.used.add('asy__pdiv');
          this.used.add('asy__ppowi');
          return { code: `(call asy__ppowi ${av.code} ${b0.code})`, type: 'pair' };
        }
        const bv = this.coerce(b, 'pair', n, "'^' 的右边");
        if (bv === null) return null;
        this.used.add('asy__pabs');
        this.used.add('asy__ppowz');
        return { code: `(call asy__ppowz ${av.code} ${bv.code})`, type: 'pair' };
      }
      if (a.type === 'int' && b.type === 'int') {
        this.used.add('asy__ipow');
        return { code: `(call asy__ipow ${a.code} ${b.code})`, type: 'int' };
      }
      // 有一边是 real 就走 pow（量过：`2.0^3` 是 8、`2^0.5` 是 1.4142135623731）
      const av = this.coerce(a, 'real', n, "'^' 的左边");
      const bv = this.coerce(b, 'real', n, "'^' 的右边");
      if (av === null || bv === null) return null;
      return { code: `(rmath "pow" ${av.code} ${bv.code})`, type: 'real' };
    }
    if (op === '/') {
      // pair 上的 `/` 是复数除法（两边都先转成 pair —— 量过，见 asy__pdiv）
      if (a.type === 'pair' || b.type === 'pair') return this.pairArith(n, op, a, b);
      if (a.type === 'triple' || b.type === 'triple') return this.tripleArith(n, op, a, b);
      // asy 的 `/` 永远是实数除法：`1/3` 是 0.333…，整数商要写 `#`（量过）
      const av = this.coerce(a, 'real', n, "'/' 的左边");
      const bv = this.coerce(b, 'real', n, "'/' 的右边");
      if (av === null || bv === null) return null;
      return { code: `(bin "/" ${av.code} ${bv.code})`, type: 'real' };
    }
    if (op !== '+' && op !== '-' && op !== '*') return this.nope(n, `算符 '${op}'`);
    if (a.type === 'pair' || b.type === 'pair') return this.pairArith(n, op, a, b);
    if (a.type === 'triple' || b.type === 'triple') return this.tripleArith(n, op, a, b);
    const t = this.promote(a, b);
    if (t === null) return this.err(n, `'${op}' 两边要同型：左是 ${a.type}，右是 ${b.type}`);
    if (t === 'string' && op !== '+') return this.err(n, `字符串上只有 '+'，这里是 '${op}'`);
    if (t === 'bool') return this.err(n, `'${op}' 不接受 bool`);
    return { code: `(bin "${op}" ${a.code} ${b.code})`, type: t };
  }

  /** pair 上的 `+ - * /`。`+ -` 是逐分量的（向量的 `+ -` 正好就是），`* /` 是复数乘除。 */
  pairArith(n, op, a, b) {
    const av = this.coerce(a, 'pair', n, `'${op}' 的左边`);
    const bv = this.coerce(b, 'pair', n, `'${op}' 的右边`);
    if (av === null || bv === null) return null;
    if (op === '+' || op === '-') return { code: `(bin "${op}" ${av.code} ${bv.code})`, type: 'pair' };
    const helper = op === '*' ? 'asy__pmul' : 'asy__pdiv';
    this.used.add(helper);
    return { code: `(call ${helper} ${av.code} ${bv.code})`, type: 'pair' };
  }

  /**
   * triple 上的 `+ - * /`。跟 pair **不一样**，这一族没有复数那回事，量出来的是：
   *   `+ -` 逐分量（triple 两边同型；`(1,2,3)+1` 在 asy 是
   *         "no matching function 'operator +(triple, int)'" —— 没有 real->triple 这条转换）
   *   `*`   triple 与 **real** 逐分量相乘，两个次序都有（`t*2.5` 与 `2.5*t` 都给 (2.5,5,7.5)）；
   *         `triple*triple` asy 自己就没有（"no matching function 'operator *(triple, triple)'"），
   *         逐分量乘要写 `realmult`
   *   `/`   只有 triple/real（`2/t` 在 asy 也是 no matching function）
   */
  tripleArith(n, op, a, b) {
    const num = (v) => v.type === 'int' || v.type === 'real';
    if (op === '+' || op === '-') {
      if (a.type !== 'triple' || b.type !== 'triple') {
        return this.err(n, `'${op}' 两边要同型：左是 ${a.type}，右是 ${b.type}（asy 那边没有 int/real 到 triple 的转换）`);
      }
      return { code: `(bin "${op}" ${a.code} ${b.code})`, type: 'triple' };
    }
    if (op === '*') {
      const t = a.type === 'triple' ? a : b;
      const s = a.type === 'triple' ? b : a;
      if (t.type === s.type) return this.err(n, `triple 上没有 'triple * triple'（asy 那边逐分量乘要写 realmult）`);
      if (!num(s)) return this.err(n, `'*' 的另一边要是 int 或 real，这里是 ${s.type}`);
      const sv = this.coerce(s, 'real', n, "'*' 的实数那边");
      if (sv === null) return null;
      this.used.add('asy__tsmul');
      return { code: `(call asy__tsmul ${t.code} ${sv.code})`, type: 'triple' };
    }
    if (a.type !== 'triple' || !num(b)) {
      return this.err(n, `'/' 只有 triple / real 这一个重载：左是 ${a.type}，右是 ${b.type}`);
    }
    const sv = this.coerce(b, 'real', n, "'/' 的右边");
    if (sv === null) return null;
    this.used.add('asy__tsdiv');
    return { code: `(call asy__tsdiv ${a.code} ${sv.code})`, type: 'triple' };
  }

  cmpCode(n, op, a, b) {
    const t = this.promote(a, b);
    if (t === null) return this.err(n, `'${op}' 两边要同型：左是 ${a.type}，右是 ${b.type}`);
    // pair 上没有大小 —— asy 那边也没有（没有 `operator <(pair,pair)`）
    if (t === 'pair') return this.err(n, `pair 上没有 '${op}'（asy 那边也没有这个算符）`);
    // triple 同理（量过："no matching function 'operator <(triple, triple)'"）
    if (t === 'triple') return this.err(n, `triple 上没有 '${op}'（asy 那边也没有这个算符）`);
    // 记录与数组上也没有：量过 `mk(2) <= mk(2)` 在 asy 那边报
    // "no matching function 'operator <=(V, V)'"，`==`/`!=` 才是内建的（比身份）。
    // 自己定义一个 `operator <=` 是通的 —— 那一条在 opUser 里先问过了。
    if (this.isRec(t) || asyIsArr(t)) {
      if (op !== '==' && op !== '!=') {
        return this.err(n, `${t} 上没有 '${op}'（asy 那边报 "no matching function `
          + `'operator ${op}(${t}, ${t})'" —— 自己定义一个 \`operator ${op}\` 就有了）`);
      }
    }
    return { code: `(bin "${op}" ${a.code} ${b.code})`, type: 'bool' };
  }

  compare(n, op) {
    const a = this.expr(n.items[2]);
    const b = this.expr(n.items[3]);
    if (a === null || b === null) return null;
    // 用户的 `operator ==`（第二十三刀）。量过 `!=` **不会**借用它 ——
    // 只定义了 `==` 时 `a != b` 走的还是内建的身份比较，所以这里是逐个算符问的。
    const u = this.opUser(n, op, [a, b], this.opBuiltinSig([a, b]));
    if (u !== null) return u;
    const t = this.promote(a, b);
    if (t === 'pair') {
      this.used.add('asy__peq');
      const eq = `(call asy__peq ${a.code} ${b.code})`;
      return { code: op === '==' ? eq : `(un "!" ${eq})`, type: 'bool' };
    }
    if (t === 'triple') {
      // 只比前三道 —— 第 4 道是垫出来的（见 ASY_TRIPLE_TY）
      this.used.add('asy__teq');
      const eq = `(call asy__teq ${a.code} ${b.code})`;
      return { code: op === '==' ? eq : `(un "!" ${eq})`, type: 'bool' };
    }
    return this.cmpCode(n, op, a, b);
  }

  /**
   * `c ? a : b`。核心方言里 `? :` 不是表达式，于是摊成一个临时量加一条 if/else：
   *     (let t T <零值>) (if c (do (set t a)) (do (set t b)))
   * 两支各自的前置语句放进**各自那一支**里 —— 这样嵌套的 `? :` 也不会被提到 if 外面，
   * 短路语义（只算中选的那一支）跟着编码保住了。条件自己的前置语句留在外层：它总要算。
   */
  cond(n) {
    if (this.pre === null) return this.nope(n, '这个位置的 `? :`（它要摊成语句，这里放不下）');
    const c = this.coerce(this.expr(n.items[1]), 'bool', n, '`? :` 的条件');
    const outer = this.pre;
    this.pre = [];
    const a = this.expr(n.items[2]);
    const aPre = this.pre;
    this.pre = [];
    const b = this.expr(n.items[3]);
    const bPre = this.pre;
    this.pre = outer;
    if (c === null || a === null || b === null) return null;
    const t = this.promote(a, b);
    if (t === null) return this.err(n, `\`? :\` 两支要同型：真支是 ${a.type}，假支是 ${b.type}`);
    if (t === 'void') return this.err(n, '`? :` 的两支不能是 void');
    const av = this.coerce(a, t, n, '`? :` 的真支');
    const bv = this.coerce(b, t, n, '`? :` 的假支');
    if (av === null || bv === null) return null;
    const nm = `asy__c${this.tmp++}`;
    const yes = aPre.concat([`(set ${nm} ${av.code})`]).join(' ');
    const no = bPre.concat([`(set ${nm} ${bv.code})`]).join(' ');
    // 临时量要先有个初值（核心方言的 `(let …)` 要一个表达式）。记录类型给 `(cnew T)`：
    // 它**不跑**字段默认值，所以这个马上被覆盖的对象在语义上看不见（代价是一次白分配）；
    // 而写 null 是不行的 —— 方言里写不出 null。
    const init = this.isRec(t) ? `(cnew ${t})`
      : (asyIsArr(t) ? `(anew ${asyCore(t)} (int 0))` : ZERO.get(t));
    this.pre.push(`(let ${nm} ${asyCore(t)} ${init})`);
    this.pre.push(`(if ${c.code} (do ${yes}) (do ${no}))`);
    return { code: `(var ${nm})`, type: t };
  }

  logic(n, op) {
    const a = this.coerce(this.expr(n.items[1]), 'bool', n, `'${op}' 的左边`);
    const b = this.coerce(this.expr(n.items[2]), 'bool', n, `'${op}' 的右边`);
    if (a === null || b === null) return null;
    return { code: `(bin "${op}" ${a.code} ${b.code})`, type: 'bool' };
  }

  unary(n) {
    const op = asyOpText(n.items[1]) ?? '?';
    const v = this.expr(n.items[2]);
    if (v === null) return null;
    // 一元的用户算符（第二十三刀）：一元与二元同名（`operator -`）也没关系 ——
    // 候选表里两份的元数不同，fit 按元数就分开了
    const u = this.opUser(n, op, [v], this.opBuiltinSig([v]));
    if (u !== null) return u;
    if (op === '!') {
      if (v.type !== 'bool') return this.err(n, `'!' 要 bool，这里是 ${v.type}`);
      return { code: `(un "!" ${v.code})`, type: 'bool' };
    }
    if (op === '+') return v;
    if (op === '-') {
      if (v.type === 'pair') {
        this.used.add('asy__pneg');
        return { code: `(call asy__pneg ${v.code})`, type: 'pair' };
      }
      if (v.type === 'triple') {
        this.used.add('asy__tneg');
        return { code: `(call asy__tneg ${v.code})`, type: 'triple' };
      }
      if (v.type !== 'int' && v.type !== 'real') return this.err(n, `一元 '-' 要 int/real/pair/triple，这里是 ${v.type}`);
      return { code: `(un "-" ${v.code})`, type: v.type };
    }
    return this.nope(n, `一元算符 '${op}'`);
  }

  /** `(int) e` / `(real) e` / `(pair) e`。别的目标类型这一刀不做。 */
  cast(n) {
    const t = this.type(n.items[1], '强制转换');
    if (t === null) return null;
    const v = this.expr(n.items[2]);
    if (v === null) return null;
    if (t === v.type) return v;
    if (t === 'real' && v.type === 'int') return { code: `(toreal ${v.code})`, type: 'real' };
    if (t === 'int' && v.type === 'real') return { code: `(toint ${v.code})`, type: 'int' };
    if (t === 'pair' && (v.type === 'int' || v.type === 'real')) return this.toPair(v);
    // `(T) x` 是唯一收 `operator ecast` 的位置（第二十七刀）；内建那几条在上面 —— 量过
    // `(real) 3` 还是提升，用户那份是兜底。
    const uc = this.castFor(t, v.type, true);
    if (uc !== null) return { code: `(call ${uc.sym} ${v.code})`, type: t };
    return this.nope(n, `把 ${v.type} 转成 ${t}`);
  }

  /** 实参表摊平。命名实参与展开都不做 —— 那要重载解析。 */
  args(node) {
    const out = [];
    for (const a of this.flat(node, 'args')) {
      if (!isList(a) || head(a) !== 'arg') {
        this.nope(a, isList(a) && head(a) === 'arg-named' ? '命名实参' : '展开实参');
        return null;
      }
      out.push(a.items[1]);
    }
    return out;
  }

  /** 调用。`write` 是语句（void），在表达式位置见到它就报错。 */
  call(n) {
    // `a.push(v)` / `a.pop()`：被调的是 `(field 接收者 名字)`，不是普通名字
    const callee = n.items[1];
    if (isList(callee) && head(callee) === 'field') {
      const recv = this.expr(callee.items[1]);
      if (recv === null) return null;
      const mname = isAtom(callee.items[2]) ? callee.items[2].value : null;
      // 记录上的方法调用（第二十刀）。数组的 push/pop 仍走 arrMethod。
      if (mname !== null && this.isRec(recv.type)) return this.methodCall(n, recv, mname);
      if (!asyIsArr(recv.type)) return this.nope(n, `方法调用 '.${mname}(…)'`);
      return this.arrMethod(n, recv, mname);
    }
    const nm = isList(n.items[1]) && head(n.items[1]) === 'name-exp' ? this.plainName(n.items[1].items[1]) : null;
    if (nm === null && isList(callee) && head(callee) === 'name-exp') {
      // `c.push(8)` / `a.get()`：同上，点是名字的一部分，所以方法调用也是"调一个带点的名字"
      const q = this.dotQual(callee.items[1]);
      if (q === DOT_BAD) return null;
      if (q !== null) {
        if (this.isRec(q.recv.type)) return this.methodCall(n, q.recv, q.field);
        if (!asyIsArr(q.recv.type)) return this.nope(n, `${q.recv.type} 上的方法调用 '.${q.field}(…)'`);
        return this.arrMethod(n, q.recv, q.field);
      }
      // `m.f(…)`：模块限定的函数调用（第二十五刀）
      const mq = this.modAlias(callee.items[1]);
      if (mq !== null) return this.modCall(n, mq);
    }
    if (nm === null) return this.nope(n, '调用一个不是普通名字的东西（函数值、方法、算符名）');
    if (nm === 'write') return this.err(n, `${ASY_NOPE}：write 出现在表达式位置（它是语句）`);
    // 方法体里的裸方法名（第二十刀）：量过 struct 的成员**遮住**同名的文件级函数
    // （文件里有 `int who()`、struct 里也有 `who()`，方法体里调到的是后者），
    // 所以这一问放在文件级候选与内建名单**前面**。
    if (this.self !== null) {
      const ms = this.visibleMethods(this.self.rec, nm);
      if (ms.length > 0) {
        return this.userCall(n, nm, ms, { code: '(var this)', type: this.self.rec.name });
      }
    }
    // 内建数学函数先看：asy 里 sqrt/floor/… 是运行时自带的，不是 plain.asy 里的定义，
    // 所以这一层认它们不算"偷偷补模块系统"。用户自己定义了同名函数时以用户的为准
    // （asy 那边是重载，重载表里用户那份更同型时它赢）。
    // 这里问的是 **此处可见的**候选（顺序解析，见 visible）—— 用户的 sqrt 写在后面时，
    // 前面那句 sqrt 在 asy 那边也还是内建的那个。
    // 函数类型的局部量/形参（`real f(real)` 那个槽）：`f(x)` 是**间接调用**，
    // 不是查候选表。放在候选表前面问：asy 那边这个名字在这一层就是个变量，
    // 而 findroot 那种形参正是要遮住同名的文件级函数。
    const lv = this.lookup(nm);
    if (lv !== null && asyIsFn(lv)) return this.fnValCall(n, nm, lv);
    const vis = this.visible(nm);
    // 同名的用户/模块函数与内建那一族在这里**一起打分**：asy 那边内建与库里的定义是
    // 同一个重载集（builtin.cc 把内建也塞进那张表），而我们的内建面写死在这个前端里，
    // 所以判据既不是"有没有同名的函数"、也不是"合不合用"，而是**谁更同型**。
    // 两头都量过：
    //   - `length("ab")`：内建那份是同型（0 次转换），asy_builtins.asy 里的 `length(path)`
    //     要走一次 `pair -> path` 的 cast（1 次），所以内建赢 —— 少了这一比，
    //     `length(z)` 会去数一条单点路径的段数，印 0 而不是 sqrt(5)（量出来的错法）。
    //   - `length(g)`（g 是 path）：内建那份根本不适用，模块那份赢。
    // 实参在这条路上**只求一次**（callArgs 把它摊出来的语句攒在自己的 lines 里）；
    // 内建那一族因此走按值的入口（builtinRaw）。
    if (vis.length > 0) {
      const raw = this.callArgs(n);
      if (raw === null) return null;
      let best = null;
      for (const c of vis) {
        const f = this.fit(c, raw);
        if (f !== null && (best === null || f.cost < best)) best = f.cost;
      }
      const bc = this.builtinCost(nm, raw);
      if (best !== null && (bc === null || best <= bc)) return this.applyCall(n, nm, vis, raw, null);
      // 内建赢；或者两边都没有能匹配的、而这个名字**本来就是内建那一族的** ——
      // 后一种要让内建那份去报诊断（`length(int[])` 那条话说得清楚得多，
      // 比"有的是 int(path)"有用）。两条都走 builtinRaw：它回 null 时诊断已经发过了。
      if (bc !== null || (best === null && this.builtinOwns(nm, raw))) return this.builtinRaw(n, nm, raw);
      // 两边都没有能匹配的：让 applyCall 照原样报那条诊断
      return this.applyCall(n, nm, vis, raw, null);
    }
    // `A(3)`：**构造调用**（第二十一刀）。`A` 是记录名，不是变量也不是函数名，所以这一问
    // 放在内建名单前面 —— 记录名与内建那几个（sqrt/length/…）撞不上。
    if (this.isRec(nm)) return this.ctorCall(n, nm);
    if (nm === 'length') return this.lengthCall(n);
    if (nm === 'string') return this.strConvCall(n);
    if (ASY_STRFN.has(nm)) return this.strCall(n, nm);
    if (ASY_STR_NOPE.has(nm)) return this.nope(n, ASY_STR_NOPE.get(nm));
    if (ASY_PAIRFN.has(nm)) return this.pairCall(n, nm);
    if (this.math.has(nm)) return this.mathCall(n, nm);
    if (this.funcs.has(nm)) {
      return this.err(n, `'${nm}' 在这里还看不见 —— 它声明在后面，而 asy 的名字解析是顺序的（那边报 "no matching variable"）`);
    }
    return this.nope(n, `内建函数 '${nm}'（这一刀只有 write 和你自己定义的函数）`);
  }

  /**
   * 内建那一族的**按值**入口：实参已经降好（`raw`），谁都没求两次。
   * 前提是 `builtinOwns` 为真；实参类型这一族接不住时它自己发诊断并回 null。
   */
  builtinRaw(n, nm, raw) {
    // 实参的前置语句按**给的顺序**发出去（callArgs 把它们攒在各自的 lines 里）
    for (const a of raw) if (a.lines !== null) for (const s of a.lines) this.pre.push(s);
    if (nm === 'length') return this.lengthOf(raw[0].v, raw[0].node);
    return this.strRaw(n, nm, raw);
  }

  /** 字符串那一族的按值入口：与 strCall 同一份拼法，只是实参已经降好了（不再求一次） */
  strRaw(n, nm, raw) {
    const spec = ASY_STRFN.get(nm);
    const parts = [];
    for (let i = 0; i < raw.length; ++i) {
      const v = this.coerce(raw[i].v, spec.params[i], raw[i].node, `'${nm}' 的第 ${i + 1} 个实参`);
      if (v === null) return null;
      parts.push(v.code);
    }
    let fn = spec.fn;
    if (nm === 'substr' && raw.length === 2) fn = spec.short;
    else if (nm === 'find' && raw.length === 2) parts.push('(int 0)');
    this.used.add(fn);
    for (const d of ASY_STR_DEPS.get(fn) ?? []) this.used.add(d);
    return { code: `(call ${fn} ${parts.join(' ')})`, type: spec.ret };
  }

  /**
   * 这个名字加这个实参形状**是不是内建那一族的**（不看实参类型，只看名字与给了几个）。
   * 两族：`length`（与 asy_builtins.asy 的 `length(path)` 撞名）与字符串那一族
   * （`erase` 与 `asy_builtins.asy` 的 `erase(frame)` 撞名 —— 元数不同，所以按
   * "给了几个"就分得开）。带名字的实参一律不算内建那一族的：内建这一层没有形参名。
   */
  builtinOwns(nm, raw) {
    for (const a of raw) if (a.key !== null) return false;
    if (nm === 'length') return raw.length === 1;
    if (ASY_STRFN.has(nm)) {
      const s = ASY_STRFN.get(nm);
      return raw.length >= s.min && raw.length <= s.params.length;
    }
    return false;
  }

  /**
   * 内建那一族接这次实参要走几次转换（null = 这一族接不住）。与 `fit` 的 cost 同一个刻度：
   * 0 是逐个同型，1 是一次隐式提升。别的内建名字将来与模块撞上时**要在这里补一行**，
   * 不补的后果是"模块那份靠一次 cast 赢过同型的内建"，那是错的答案而不是报错。
   */
  builtinCost(nm, raw) {
    if (!this.builtinOwns(nm, raw)) return null;
    if (nm === 'length') {
      const t = raw[0].v.type;
      if (t === 'string' || t === 'pair' || t === 'triple') return 0;
      if (t === 'int' || t === 'real') return 1;
      return null;
    }
    // 字符串那一族：逐个比 `params`。int -> real 是一次提升，别的不合就是接不住
    const s = ASY_STRFN.get(nm);
    let cost = 0;
    for (let i = 0; i < raw.length; ++i) {
      const want = s.params[i];
      const got = raw[i].v.type;
      if (got === want) continue;
      if (want === 'real' && got === 'int') { cost += 1; continue; }
      return null;
    }
    return cost;
  }

  /**
   * `nm` 在**当前位置**能看见的候选。asy 的名字解析是顺序的 —— 量过：
   *   `void a() { b(); } void b() {}` 报 "no matching variable 'b'"，
   *   `int rec(int)` 的体里调 `rec(int,int)` 报 "cannot call 'int rec(int n)'"。
   * `c.at <= this.at` 里的等号是故意的：一个函数看得见自己（单函数递归 asy 允许）。
   */
  visible(nm) {
    const out = [];
    if (!this.funcs.has(nm)) return out;
    for (const c of this.funcs.get(nm)) if (c.at <= this.at) out.push(c);
    return out;
  }

  /**
   * `接收者.方法(…)`（第二十刀）。接收者已经求好了，方法名去 `记录名.方法名` 那张候选表里
   * 找；找不到就把话说清 —— 同名的**字段**意味着"调一个函数值"（那要闭包，门外），
   * 什么都没有就把有哪些方法列出来。
   */
  methodCall(n, recv, mname) {
    const rec = this.records.get(recv.type);
    const ms = this.visibleMethods(rec, mname);
    if (ms.length === 0) {
      for (const f of rec.fields) {
        if (f.name === mname) return this.nope(n, `调用一个字段（${recv.type}.${mname} 是 ${f.type}，不是方法）`);
      }
      const names = [];
      for (const key of this.units[rec.unit].funcs.keys()) {
        if (key.startsWith(`${rec.name}.`)) names.push(key.slice(rec.name.length + 1));
      }
      return this.err(n, `struct ${recv.type} 没有方法 '${mname}'`
        + `${names.length === 0 ? '（它一个方法都没有）' : ` —— 有的是 ${names.join(' / ')}`}`);
    }
    return this.userCall(n, mname, ms, recv);
  }

  /**
   * `A(3)`：构造调用（第二十一刀）。候选就是 struct 里那些 `void operator init(…)`，
   * 走的还是 userCall —— 重载解析、命名实参、默认实参一条不改，因为候选长得就像一个
   * "回记录、没有接收者的普通函数"（见 methodSig）。
   *
   * 量过的两条边界都在这里：没有 `void operator init` 的 struct 上 `A(…)` 在 asy 那边报
   * "no matching variable 'A'"（非 void 的那份不算，它不给构造函数），而 `A a;` **不**走
   * 构造函数 —— 那条只认文件级的 `A operator init()`，还在门外。
   */
  ctorCall(n, nm) {
    const cs = this.visibleMethods(this.records.get(nm), 'operator init');
    if (cs.length === 0) {
      // 这一条 asy 自己也拒（"no matching variable 'A'"），所以是 err 不是 nope ——
      // 不是"我们还没做"，是这个程序本来就不对。`tests/asy/strict/ctor-none` 钉着。
      return this.err(n, `struct ${nm} 里没有 'void operator init(…)'，所以 ${nm}(…) 不是`
        + `构造调用（真 asy 报 "no matching variable '${nm}'"）`);
    }
    return this.userCall(n, nm, cs);
  }

  /**
   * 调用用户定义的函数：**重载解析**（第十一刀）+ 位置实参 + 命名实参 + 默认实参。
   *
   * 量出来的规则（`asy -noV`，不是照文档抄的）：
   *   1. 默认值是**每次调用**求一次，而且只在那个实参没给的时候求
   *      （`void d(int x = bump())`：`d(); d(); d(99);` 之后 bump 只被调了 2 次）。
   *   2. 默认值能引用**前面的形参**（`void q(int a, int b = a + 10)`：`q(1)` 印 11）——
   *      所以它必须在被调方的作用域里求，不能在调用点展开。
   *   3. 位置实参从左到右填，命名实参按名字填，两者能混、命名的顺序可以乱
   *      （`h(1, c=3, b=2)` 印 1 2 3）。
   *   4. 求值顺序：给了的实参按**源码顺序**先求，默认值最后（量过 tick 的输出是
   *      101 202 303）。
   *   5. 重载按**同型优先**：`f(int)` 与 `f(real)` 都在时 `f(1)` 走 int 那份、`f(1.0)`
   *      走 real 那份；只有 `g(real)` 时 `g(2)` 走隐式提升。两个候选各要一次转换就是
   *      **歧义**，asy 当场报错（`p(real)` 与 `p(pair)` 遇上 `p(1)`：
   *      "call of function 'p(int)' is ambiguous"）—— 我们也报。
   *   6. 同一份签名写两次是**替换**，不是错（`int s(int)` 之后 `real s(int)`，`s(5)` 给 2.5）。
   *
   * 落法：实参**先按源码顺序求一次**（连它摊出来的语句一起攒着），再拿类型去挑候选 ——
   * 求两次会把 `show(1)` 那种带输出的实参印两遍。缺实参时不在调用点补，而是按
   * "缺了哪几个"生成一个包装函数（见 defWrapper），默认值在包装里求，规则 1、2 因此自动成立。
   *
   * `recv` 不是 null 时这是一次**方法调用**（第二十刀）：接收者当第一个实参传进去，
   * 重载解析只看写出来的那几个实参 —— `this` 不参与打分（它的类型是定死的）。
   */
  userCall(n, nm, list, recv) {
    const raw = this.callArgs(n);
    if (raw === null) return null;
    return this.applyCall(n, nm, list, raw, recv);
  }

  /**
   * userCall 的后半段：实参已经求好（`raw`），剩下的是挑候选、转换、发调用。
   * 分出来是给算符重载用的（第二十三刀）—— 那边的"实参"是已经降好的两个操作数，
   * 没有 callArgs 那一步，别的规则一条不差。
   */
  applyCall(n, nm, list, raw, recv) {
    const fits = [];
    for (const c of list) {
      const f = this.fit(c, raw);
      if (f !== null) fits.push({ c, f });
    }
    if (fits.length === 0) {
      const got = [];
      for (const r of raw) got.push(r.key === null ? r.v.type : `${r.key}=${r.v.type}`);
      const sigs = [];
      for (const c of list) sigs.push(this.sigText(c));
      return this.err(n, `没有能匹配 '${nm}(${got.join(', ')})' 的签名 —— 有的是 ${sigs.join(' / ')}`);
    }
    let best = fits[0];
    let tie = false;
    for (let i = 1; i < fits.length; i++) {
      if (fits[i].f.cost < best.f.cost) { best = fits[i]; tie = false; continue; }
      if (fits[i].f.cost === best.f.cost) tie = true;
    }
    if (tie) {
      const got = [];
      for (const r of raw) got.push(r.key === null ? r.v.type : `${r.key}=${r.v.type}`);
      return this.err(n, `'${nm}(${got.join(', ')})' 有多个同样合适的重载 —— asy 那边这也是 ambiguous`);
    }
    const d = best.c;
    const f = best.f;
    // 命名实参可能把顺序打乱，而核心方言的 `(call f a b c)` 是按写的顺序求值的 ——
    // 乱序时先把每个实参按**源码顺序**绑到临时量，再按形参顺序引用它们。
    const reorder = f.reordered && raw.length > 1;
    if (reorder && this.pre === null) return this.nope(n, '这个位置的乱序命名实参（要摊成语句，这里放不下）');
    const codes = new Map();
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      if (r.lines !== null) for (const s of r.lines) this.pre.push(s);
      const at = f.slot[i];
      // 重载集：fit 已经按这个槽的类型挑过一份了，这里把它落成 `(fnref …)`（不走 coerce ——
      // 那一份与槽同型，而 coerce 认不出"重载集"这个类型）
      if (r.v.over !== undefined) {
        const pick = this.overPick(r, d.ps[at].type);
        if (pick === null) return this.err(r.node, `'${nm}' 的实参 ${d.ps[at].name}：挑不出重载`);
        codes.set(at, pick);
        continue;
      }
      const v = this.coerce(r.v, d.ps[at].type, r.node, `'${nm}' 的实参 ${d.ps[at].name}`);
      if (v === null) return null;
      if (!reorder) { codes.set(at, v.code); continue; }
      const tmp = `asy__na${this.tmp++}`;
      this.pre.push(`(let ${tmp} ${asyCore(d.ps[at].type)} ${v.code})`);
      codes.set(at, `(var ${tmp})`);
    }
    const parts = [];
    if (recv !== null && recv !== undefined) parts.push(recv.code);
    for (let i = 0; i < d.ps.length; i++) if (codes.has(i)) parts.push(codes.get(i));
    const target = f.missing.length === 0 ? d.sym : this.defWrapper(n, nm, d, f);
    if (target === null) return null;
    const sp = parts.length === 0 ? '' : ' ';
    return { code: `(call ${target}${sp}${parts.join(' ')})`, type: d.ret };
  }

  /**
   * `a -- b`：语法上它不是 `binary` 而是 `(join-exp L (join "--") R)`（camp.y 里 join 是
   * 单独一档，`..`、`::`、方向标记都挂在这一档上）。内建的 `--` 不存在 —— 那是 guide 的
   * 东西，属于绘图层 —— 所以这里**只有**用户定义的 `operator --`（第二十三刀）。
   */
  joinExp(n) {
    const op = asyOpText(n.items[2].items[1]);
    if (op !== '--') return this.nope(n, `路径连接 '${op ?? '?'}'`);
    const a = this.expr(n.items[1]);
    const b = this.expr(n.items[3]);
    if (a === null || b === null) return null;
    // 内建的 `--` 不存在，所以"内建这一档的签名"是 null（不是 `opBuiltinSig` 的结果）
    const u = this.opUser(n, op, [a, b], null);
    if (u !== null) return u;
    return this.nope(n, `'${a.type} -- ${b.type}'（内建的 '--' 是 guide 的，那是绘图层那一刀；`
      + '自己定义一个 `operator --` 是通的）');
  }

  /**
   * 用户定义的算符（第二十三刀）：`op` 是 '+'、'=='、'--'… `vals` 是**已经降好**的操作数。
   * 回 null 表示"没有用户算符管这一档"，调用方接着走内建那条路。
   *
   * asy 把内建算符与用户算符放在**同一张候选表**里打分，所以判"谁赢"要照那张表的规则，
   * 这三条都量过（`asy -noV`）：
   *   1. 用户那份**同型**（一次转换都不用）就赢：`int operator *(int,int)` 之后 `3 * 4`
   *      印 7，不是 12。这一条最要紧 —— 漏了它算出来的是**不同的答案**，不是"多接受"。
   *   2. 用户那份的签名正好**就是内建那一档**时，它替换掉内建（重载规则 6：同签名是替换）：
   *      只写了 `real operator +(real,real)` 时 `2 + 3` 还是内建的 int 加法（印 5），
   *      而 `2 + 1.5` 走用户那份（印 0.5，左边先提成 real）。
   *   3. 内建管不了的档（记录、数组做操作数）：任何能匹配的用户算符都赢。
   * `btys` 就是"内建这一档的签名"（`opBuiltinSig`），null 表示内建管不了。
   */
  opUser(n, op, vals, btys) {
    const list = this.visible(`operator ${op}`);
    if (list.length === 0) return null;
    const raw = [];
    for (const v of vals) raw.push({ key: null, v, node: n, lines: null });
    let any = false;
    let exact = false;
    for (const c of list) {
      const f = this.fit(c, raw);
      if (f === null) continue;
      any = true;
      if (f.cost === 0) exact = true;
    }
    if (!any) return null;
    if (!exact && btys !== null) {
      const key = btys.join(',');
      let replaces = false;
      for (const c of list) if (c.params.join(',') === key) replaces = true;
      if (!replaces) return null;
    }
    return this.applyCall(n, `operator ${op}`, list, raw);
  }

  /**
   * 内建算符在这些操作数上是哪一档签名（回 null = 内建管不了这些类型）。
   * 一元就是操作数自己那一档，二元是提升之后的同型那一档（`1 + 2.0` 是 real 那档）。
   * 记录与数组内建一概不认 —— 那些只有用户算符。
   */
  opBuiltinSig(vals) {
    for (const v of vals) if (this.isRec(v.type) || asyIsArr(v.type)) return null;
    if (vals.length === 1) return [vals[0].type];
    const t = this.promote(vals[0], vals[1]);
    return t === null ? null : [t, t];
  }

  /**
   * 按**源码顺序**把实参求出来。每个实参连它摊出来的语句（`? :`、`.push(…)` 那种）
   * 一起攒在自己的 `lines` 里，等挑定候选之后再按顺序放回 `this.pre` ——
   * 挑候选要知道实参的类型，而实参不能求两次（`show(1)` 那种会印两遍）。
   */
  /**
   * 通过一个函数类型的值调用（`real f(real)` 那个形参上的 `f(x)`）。
   * 函数值没有形参名，所以命名实参与默认值在这里都不存在 —— 与 hir/check.js 的
   * callFnValue 是同一条规矩。实参照签名逐个 coerce（int -> real 那条照旧要走）。
   */
  fnValCall(n, nm, ft) {
    const s = asyFnSplit(ft);
    if (s === null) return this.nope(n, `认不出的函数类型 '${ft}'`);
    const args = this.callArgs(n);
    if (args === null) return null;
    if (args.length !== s.params.length) {
      return this.err(n, `'${nm}' 是 ${ft}，要 ${s.params.length} 个实参，给了 ${args.length} 个`);
    }
    let code = `(callfn (var ${nm})`;
    let i = 0;
    while (i < args.length) {
      if (args[i].key !== null) {
        return this.err(n, `函数值没有形参名，这里不能写 '${args[i].key}='`);
      }
      if (args[i].lines !== null) for (const l of args[i].lines) this.pre.push(l);
      // 重载集当实参（callArgs 先不定案的那种）：这里的期望类型是函数类型里那一格
      if (args[i].v.over !== undefined) {
        const pick = this.overPick(args[i], s.params[i]);
        if (pick === null) {
          return this.err(args[i].node, `'${nm}' 的第 ${i + 1} 个实参：要 ${s.params[i]}，`
            + '而这个名字的那几个重载里没有同型的一份');
        }
        code = `${code} ${pick}`;
        i++;
        continue;
      }
      const v = this.coerce(args[i].v, s.params[i], args[i].node, `'${nm}' 的第 ${i + 1} 个实参`);
      if (v === null) return null;
      code = `${code} ${v.code}`;
      i++;
    }
    return { code: `${code})`, type: s.ret };
  }

  callArgs(n) {
    const out = [];
    for (const a of this.flat(n.items[2], 'args')) {
      if (!isList(a)) { this.nope(a, '认不出的实参'); return null; }
      let key = null;
      let node = null;
      if (head(a) === 'arg') node = a.items[1];
      else if (head(a) === 'arg-named') {
        key = isAtom(a.items[1]) ? a.items[1].value : null;
        node = a.items[2];
      } else { this.nope(a, '展开实参'); return null; }
      // 有多个重载的裸函数名：先不求，等 fit 按槽的类型挑（overArg 里写了理由）
      const ov = this.overArg(node);
      if (ov !== null) {
        out.push({ key, node, v: { code: null, type: `<${ov.nm} 的重载集>`, over: ov.cands }, lines: null });
        continue;
      }
      const save = this.pre;
      const lines = save === null ? null : [];
      if (lines !== null) this.pre = lines;
      const v = this.expr(node);
      this.pre = save;
      if (v === null) return null;
      out.push({ key, node, v, lines });
    }
    return out;
  }

  /**
   * 一个候选合不合用。回 `{cost, slot, missing, reordered}` 或 null（不合用）。
   * `cost` 是要走几次隐式转换 —— 0 就是逐个同型。挑最小的那个，并列就是歧义。
   */
  /** 候选的签名文本（诊断用）。`explicit` 要印出来 —— 它决定这个候选收不收这个实参 */
  sigText(c) {
    const parts = [];
    for (let i = 0; i < c.params.length; i++) {
      const p = c.ps === undefined || c.ps[i] === undefined ? null : c.ps[i];
      parts.push(p !== null && p.exp === true ? `explicit ${c.params[i]}` : c.params[i]);
    }
    return `${c.ret}(${parts.join(', ')})`;
  }

  fit(cand, raw) {
    const filled = new Map();
    const slot = [];
    let pos = 0;
    let cost = 0;
    let reordered = false;
    let last = -1;
    for (const r of raw) {
      let at = -1;
      if (r.key === null) {
        while (filled.has(pos)) pos++;
        at = pos;
        pos++;
      } else {
        for (let k = 0; k < cand.ps.length; k++) if (cand.ps[k].name === r.key) at = k;
      }
      if (at < 0 || at >= cand.ps.length || filled.has(at)) return null;
      // 重载集当值用（callArgs 先不定案的那种）：按**这个槽要的类型**挑一份。
      // 挑到就是同型（cost 不加），挑不到这个候选就不合用 —— 与别的实参一视同仁。
      if (r.v.over !== undefined) {
        let hit = false;
        for (const c of r.v.over) if (this.candFnType(c) === cand.ps[at].type) hit = true;
        if (!hit) return null;
        filled.set(at, true);
        slot.push(at);
        if (at < last) reordered = true;
        last = at;
        continue;
      }
      // `explicit` 的槽只收类型一模一样的实参（第二十六刀，量过：连 int->real 都挡）
      if (cand.ps[at].exp === true && r.v.type !== cand.ps[at].type) return null;
      const c = asyConvCost(r.v.type, cand.ps[at].type);
      // 用户的 `operator cast`（第二十七刀）：代价**跟内建提升一样**是 1 —— 量过打平时
      // asy 报 "is ambiguous"，所以这里不能给它一个更贵的分数偷偷分出胜负。
      const uc = c < 0 && this.castFor(cand.ps[at].type, r.v.type, false) !== null ? 1 : c;
      if (uc < 0) return null;
      cost += uc;
      filled.set(at, true);
      slot.push(at);
      if (at < last) reordered = true;
      last = at;
    }
    const missing = [];
    for (let k = 0; k < cand.ps.length; k++) {
      if (filled.has(k)) continue;
      if (cand.ps[k].def === null) return null;
      missing.push(k);
    }
    return { cost, slot, missing, reordered };
  }

  /**
   * 为"缺了哪几个实参"这一种形状生成包装函数，回它的名字（同形状只生一份）。
   * 包装的形参就是给了的那几个（按形参顺序），体里逐个 `(let 缺的 T 默认值)` ——
   * 默认值因此在**被调方的作用域**里求：能看见前面的形参，也只在没给时才求。
   */
  defWrapper(n, nm, d, f) {
    const key = `${d.sym}|${f.missing.join(',')}`;
    const had = this.wrapNames.get(key);
    if (had !== undefined) return had;
    const wname = `asy__def${this.wrapNames.size}_${nm}`;
    this.wrapNames.set(key, wname);
    // 给了的那几个槽（按形参顺序）：包装的形参表就是它
    const gave = [];
    for (let i = 0; i < d.ps.length; i++) {
      let has = false;
      for (const m of f.missing) if (m === i) has = true;
      if (!has) gave.push(i);
    }
    // 换掉正在降级的那份状态：包装函数是另一个作用域、另一串语句。用完还回去。
    // `at` 也要换：默认值是在**被调方的声明处**求的，能看见的候选也是那时候的那些。
    // 被调方在别的模块里时（第二十五刀）连**单元**一起换：默认值那个表达式里的名字
    // 是那个文件里的名字。
    const savePre = this.pre;
    const saveUpd = this.updates;
    const saveScopes = this.scopes;
    const saveAt = this.at;
    const saveUnit = d.unit === undefined || d.unit === this.unit.id
      ? null : this.unitIn(this.units[d.unit]);
    this.at = d.dat === undefined ? d.at : d.dat;
    // 方法的包装（第二十刀）：多一个 `this` 形参，而默认值那一段要能看见字段 ——
    // 它是在**被调方**的作用域里求的，那个作用域里字段是可见的。
    // 构造函数的包装（第二十一刀）不一样：`this` 不是形参而是**本地量** —— 对象在这里造，
    // 造完默认值才求（量过 asy 收 `void operator init(int n = x)`，`x` 是字段，出来的是
    // 字段的默认值），最后回那个对象。
    const rec = d.rec === undefined ? null : d.rec;
    const isCtor = d.ctor === true;
    const saveSelf = this.self;
    this.scopes = [new Map()];
    if (rec !== null) {
      this.at = rec.at === undefined ? this.at : rec.at;
      this.self = { rec, mat: d.mat };
      this.declare(n, 'this', rec.name);
    }
    this.updates = [];
    const lines = [];
    this.pre = lines;
    let bad = false;
    if (isCtor) {
      const mk = this.recNew(n, rec.name);
      if (mk === null) bad = true;
      else lines.push(`(let this ${asyCore(rec.name)} ${mk})`);
    }
    for (const i of gave) this.declare(n, d.ps[i].name, d.ps[i].type);
    for (const i of f.missing) {
      const p = d.ps[i];
      const v = this.coerce(this.expr(p.def), p.type, p.def, `'${nm}' 的形参 '${p.name}' 的默认值`);
      if (v === null) { bad = true; break; }
      lines.push(`(let ${p.name} ${asyCore(p.type)} ${v.code})`);
      this.declare(n, p.name, p.type);
    }
    const args = [];
    if (rec !== null) args.push('(var this)');
    for (const p of d.ps) args.push(`(var ${p.name})`);
    if (isCtor) {
      lines.push(`(expr (call ${d.sym}_body ${args.join(' ')}))`);
      lines.push('(ret (var this))');
    } else {
      lines.push(d.ret === 'void'
        ? `(expr (call ${d.sym} ${args.join(' ')}))`
        : `(ret (call ${d.sym} ${args.join(' ')}))`);
    }
    const params = [];
    if (rec !== null && !isCtor) params.push(`(this ${asyCore(rec.name)})`);
    for (const i of gave) params.push(`(${d.ps[i].name} ${asyCore(d.ps[i].type)})`);
    const text = [`  (fn ${wname} (${params.join(' ')}) ${asyCore(d.ret)}`];
    for (const s of lines) text.push(`    ${s}`);
    this.pre = savePre;
    this.updates = saveUpd;
    this.scopes = saveScopes;
    this.at = saveAt;
    this.self = saveSelf;
    if (saveUnit !== null) this.unitOut(saveUnit);
    if (bad) return null;
    this.wraps.push(`${text.join('\n')})`);
    return wname;
  }

  /**
   * 内建数学函数。整数上的 `abs` 走一条 helper（核心方言里没有整数取绝对值），
   * 回 int 的那三个在 `(rmath …)` 外面套一层 `(toint …)` —— 结果本来就是整数，
   * 截断是精确的。
   */
  mathCall(n, nm) {
    const spec = this.math.get(nm);
    if (spec.kind === 'nope') {
      return this.nope(n, `内建函数 '${nm}'（绑定表 builtins.tab 里有它，`
        + `但宿主的数学库里没有对应的一个 —— 得自己实现，这一刀还没做）`);
    }
    const args = this.args(n.items[2]);
    if (args === null) return null;
    if (args.length !== spec.arity) {
      return this.err(n, `'${nm}' 要 ${spec.arity} 个实参，给了 ${args.length} 个`);
    }
    const vs = [];
    for (const a of args) {
      const v = this.expr(a);
      if (v === null) return null;
      vs.push(v);
    }
    if (nm === 'abs' && vs[0].type === 'int') {
      this.used.add('asy__iabs');
      return { code: `(call asy__iabs ${vs[0].code})`, type: 'int' };
    }
    if (nm === 'abs' && vs[0].type === 'pair') {
      // abs(pair) 是模，和 length(pair) 同一条（量过：abs((3,-4)) 与 length((3,-4)) 都是 5）
      this.used.add('asy__pabs');
      return { code: `(call asy__pabs ${vs[0].code})`, type: 'real' };
    }
    if (nm === 'abs' && vs[0].type === 'triple') {
      // abs(triple) 同样是模（量过 abs((1,2,3)) 与 length((1,2,3)) 都是 3.74165738677394）
      this.used.add('asy__tabs');
      return { code: `(call asy__tabs ${vs[0].code})`, type: 'real' };
    }
    const parts = [];
    for (let i = 0; i < vs.length; i++) {
      const v = this.coerce(vs[i], 'real', args[i], `'${nm}' 的第 ${i + 1} 个实参`);
      if (v === null) return null;
      parts.push(v.code);
    }
    const code = `(rmath "${spec.fn}" ${parts.join(' ')})`;
    if (spec.ret === 'int') return { code: `(toint ${code})`, type: 'int' };
    return { code, type: 'real' };
  }

  /**
   * `write` 的重载是量出来的，形状是 `write(string s="", T x, T[] more..., suffix=endl)`：
   * 前缀 `s` 与第一个 T 之间**没有**分隔符，T 与 T 之间是制表符，而所有 T 必须**同型**。
   * 逐条量过（`asy -noV`，od -c 看字节）：
   *   write("a",1,2)        -> `a1\tab2`  ... 即 "a" "1" TAB "2"
   *   write("a","b","c")    -> `ab\tc`    ... 第一个串当前缀，后两个才是 T=string
   *   write("s",true,false) -> `strue \tfalse `
   *   write(1,"b",2)        -> no matching function 'write(int, string, int)'
   *   write("a","b",1)      -> no matching function（前缀吃掉 "a" 之后 T 定成了 string）
   *   write(true,"x")       -> no matching function（没有前缀，T 定成了 bool）
   * T 是**数组**时是另一条格式，见 writeArrays。
   */
  writeStmt(n) {
    const args = this.args(n.items[2]);
    if (args === null) return null;
    if (args.length === 0) return this.nope(n, '不带实参的 write');
    const vals = [];
    for (const a of args) {
      const v = this.expr(a);
      if (v === null) return null;
      if (v.type === 'void') return this.err(a, 'write 的实参不能是 void');
      // asy 自己也不给结构体印（量过：`no matching function 'write(A)'`）。拦在这一层，
      // 不然漏出去的是核心方言那句 `(tostr E) 只接受 int / real / bool`。
      if (this.isRec(v.type)) {
        return this.err(a, `write 的实参不能是结构体 —— asy 那边 write(${v.type}) 就是 no matching function`);
      }
      vals.push(v);
    }
    // 只有实参多于一个时第一个串才是前缀 —— 单个 write("a") 里 "a" 就是那个 T
    const prefix = vals.length > 1 && vals[0].type === 'string';
    const first = prefix ? 1 : 0;
    // T 的判定：asy 那边是重载解析。有一个实参是 pair 时 T 就是 pair，别的 int/real
    // 按隐式转换补成 `(v,0)`（量过：`write(3,(1,2))` 印的是 "(3,0)" TAB "(1,2)"）。
    let t = vals[first].type;
    for (let i = first; i < vals.length; i++) {
      if (vals[i].type === 'pair') t = 'pair';
    }
    for (let i = first; i < vals.length; i++) {
      if (t === 'pair' && (vals[i].type === 'int' || vals[i].type === 'real')) {
        vals[i] = this.toPair(vals[i]);
        continue;
      }
      if (vals[i].type === t) continue;
      const shape = vals.map((v) => v.type).join(', ');
      return this.err(args[i], `write 的实参要同型 —— asy 那边 write(${shape}) 就是 no matching function`);
    }
    // T 是数组：那是另一条格式（每行「下标 : TAB 值」），见 writeArrays
    if (asyIsArr(t)) return this.writeArrays(n, vals, first);
    const parts = vals.map((v) => this.fmtStr(v.type, v.code));
    // 前缀与第一个值之间不加分隔符，值与值之间加制表符
    let code = parts[0];
    for (let i = 1; i < parts.length; i++) {
      if (!(i === 1 && prefix)) code = `(bin "+" ${code} (str "\\t"))`;
      code = `(bin "+" ${code} ${parts[i]})`;
    }
    return [`(print ${code})`];
  }

  /** 一个值印成字符串时的形状。write 的两条路（标量与数组）共用这一份。 */
  fmtStr(t, code) {
    if (t === 'string') return code;
    // real 用 15 位有效数字 —— asy 的默认输出就是 %.15g（量过：1/3 是
    // 0.333333333333333、sqrt(2) 是 1.4142135623731、1e-5 是 1e-05、-0.0 是 -0）
    if (t === 'real') return `(tostr ${code} (int 15))`;
    if (t === 'pair') {
      this.used.add('asy__pairstr');
      return `(call asy__pairstr ${code})`;
    }
    if (t === 'triple') {
      this.used.add('asy__triplestr');
      return `(call asy__triplestr ${code})`;
    }
    if (t === 'bool') {
      this.used.add('asy__boolstr');
      return `(call asy__boolstr ${code})`;
    }
    return `(tostr ${code})`;
  }

  /**
   * `write` 一个或多个**整数组**。格式是量出来的（`asy -noV`，od -c 看字节）：
   *   int[] a={10,20}; write(a);       -> "0:\tab10\n1:\tab20\n"   即每行「下标 : TAB 值」
   *   write("P",a);                    -> "P\n" 然后才是那些行（前缀**自己占一行**）
   *   int[] b={30}; write(a,b);        -> "0:\tab10\tab30\n1:\tab20\n"
   *                                       行数按最长的那个数组，短的那个到头就不印了
   *   write(new int[0]);               -> 什么都不印
   *   write(a,5);                      -> no matching function 'write(int[], int)'
   *
   * 这一条刻意**不**发 helper 函数，直接摊成语句：数组的个数是变的（helper 要按个数各发
   * 一份），而摊成语句只用一个 while。数组都先绑临时量 —— `write(f(),g())` 里 f 和 g
   * 各只能调一次。
   */
  writeArrays(n, vals, first) {
    if (this.pre === null) return this.nope(n, '这个位置的 write（它要摊成语句，这里放不下）');
    const el = asyElem(vals[first].type);
    const out = [];
    if (first === 1) out.push(`(print ${vals[0].code})`);
    const names = [];
    for (let i = first; i < vals.length; i++) {
      const nm = `asy__wa${this.tmp++}`;
      names.push(nm);
      out.push(`(let ${nm} ${asyCore(vals[first].type)} ${vals[i].code})`);
    }
    const nmax = `asy__wn${this.tmp++}`;
    out.push(`(let ${nmax} int (int 0))`);
    for (const nm of names) {
      out.push(`(if (bin "<" (var ${nmax}) (alen (var ${nm}))) (do (set ${nmax} (alen (var ${nm})))))`);
    }
    const iv = `asy__wi${this.tmp++}`;
    const sv = `asy__ws${this.tmp++}`;
    const body = [`(let ${sv} string (bin "+" (tostr (var ${iv})) (str ":")))`];
    for (const nm of names) {
      const cell = this.fmtStr(el, `(aget (var ${nm}) (var ${iv}))`);
      body.push(`(if (bin "<" (var ${iv}) (alen (var ${nm}))) (do (set ${sv} (bin "+" (var ${sv}) (bin "+" (str "\\t") ${cell})))))`);
    }
    body.push(`(print (var ${sv}))`);
    body.push(`(set ${iv} (bin "+" (var ${iv}) (int 1)))`);
    out.push(`(let ${iv} int (int 0))`);
    out.push(`(while (bin "<" (var ${iv}) (var ${nmax})) (do ${body.join(' ')}))`);
    return out;
  }

  /* ---------------------------------------------------------------- 语句 */

  /**
   * 一条 asy 语句可能摊成好几条核心方言语句，所以一律回数组；失败回 null。
   *
   * 外壳负责**前置语句**：`? :` 这种"核心方言里不是表达式"的东西，降级时要先算进一个
   * 临时量，那几条就攒在 this.pre 里，由这里补在本条语句前面。每条语句一份 pre，所以
   * 嵌套语句（if 的分支、循环体）各自算各自的，不会被提到外面去。
   */
  stmt(n, ret) {
    const outer = this.pre;
    this.pre = [];
    const lines = this.stmtOne(n, ret);
    const pre = this.pre;
    this.pre = outer;
    if (lines === null) return null;
    if (pre.length === 0) return lines;
    return pre.concat(lines);
  }

  /**
   * 循环条件里不许有前置语句。`? :` 摊出来的临时量赋值只能放在**循环外面**，那样条件就
   * 只算一次，语义就错了 —— 所以见到就报错，而不是悄悄换个意思。
   * @param {number} mark 算条件之前 this.pre 的长度
   */
  loopCond(node, what, mark) {
    if (this.pre === null || this.pre.length === mark) return true;
    return this.nope(node, `${what} 的条件里的 \`? :\`（它要摊成语句，而循环条件每轮都得重算）`);
  }

  stmtOne(n, ret) {
    if (!isList(n)) return this.err(n, '认不出的语句');
    const h = head(n);
    if (h === 'empty-stm') return [];
    if (h === 'modified') return this.stmt(n.items[2], ret);
    if (h === 'vardec') return this.vardec(n);
    if (h === 'exp-stm') return this.exprStmt(n.items[1]);
    if (h === 'block-stm') {
      const body = this.body(n.items[1], ret);
      return body === null ? null : [`(do ${body.join(' ')})`];
    }
    if (h === 'if') {
      const c = this.coerce(this.expr(n.items[1]), 'bool', n, 'if 的条件');
      const t = this.stmt(n.items[2], ret);
      if (c === null || t === null) return null;
      if (n.items[3] === undefined) return [`(if ${c.code} (do ${t.join(' ')}))`];
      const e = this.stmt(n.items[3], ret);
      if (e === null) return null;
      return [`(if ${c.code} (do ${t.join(' ')}) (do ${e.join(' ')}))`];
    }
    if (h === 'while') {
      const c = this.coerce(this.expr(n.items[1]), 'bool', n, 'while 的条件');
      if (this.loopCond(n, 'while', 0) === null) return null;
      this.updates.push([]);
      const b = this.stmt(n.items[2], ret);
      this.updates.pop();
      if (c === null || b === null) return null;
      return [`(while ${c.code} (do ${b.join(' ')}))`];
    }
    if (h === 'do') return this.doWhile(n, ret);
    if (h === 'for') return this.forStmt(n, ret);
    if (h === 'for-each') return this.forEach(n, ret);
    if (h === 'break') return ['(brk)'];
    if (h === 'continue') {
      // C 式 for 降成 while 之后，continue 要**先跑更新**再跳（量过 asy 的行为）
      const upd = this.updates.length === 0 ? [] : this.updates[this.updates.length - 1];
      const out = [];
      for (const u of upd) out.push(u);
      out.push('(cont)');
      return out;
    }
    if (h === 'return') {
      if (n.items[1] === undefined) return ['(ret)'];
      const v = this.coerce(this.expr(n.items[1]), ret, n, 'return 的值');
      return v === null ? null : [`(ret ${v.code})`];
    }
    return this.nope(n, `语句 '${h}'`);
  }

  /**
   * `do S while (c)` -> `while (true) { S; if (!c) break; }`。
   * 刻意不复制 S（复制会让 S 里的 break 落在循环外面），代价是 `continue` 在这个编码里
   * 会跳过条件检查，语义就错了 —— 所以见到就报错，而不是悄悄换个意思。
   */
  doWhile(n, ret) {
    this.updates.push([]);
    const b = this.stmt(n.items[1], ret);
    this.updates.pop();
    const mark = this.pre === null ? 0 : this.pre.length;
    const c = this.coerce(this.expr(n.items[2]), 'bool', n, 'do-while 的条件');
    if (this.loopCond(n, 'do-while', mark) === null) return null;
    if (b === null || c === null) return null;
    for (const s of b) {
      if (s === '(cont)' || s.includes(' (cont)')) return this.nope(n, 'do-while 里的 continue');
    }
    return [`(while (bool true) (do ${b.join(' ')} (if (un "!" ${c.code}) (do (brk)))))`];
  }

  /**
   * `for (T x : a) S` -> 绑一次数组**句柄**，按下标走。
   *
   * 量过的两条：循环变量是**复制**（体里 `x = 99` 不动数组），而且迭代是**活的** ——
   * 体里 push 进去的元素会被走到（`int[] a={1,2}; int n=0; for(int x:a){++n; if(n<5) a.push(9);}`
   * 走了 6 轮，末了 a.length 是 6）。所以这里绑句柄、每轮重读 `(alen …)`，
   * 而不是先拷一份快照 —— 快照会让那个程序只走 2 轮。
   */
  forEach(n, ret) {
    const el = this.type(n.items[1], 'for-each 的元素类型');
    if (el === null) return null;
    const nm = isAtom(n.items[2]) ? n.items[2].value : null;
    if (nm === null) return this.err(n, 'for-each 少了循环变量名');
    const a = this.expr(n.items[3]);
    if (a === null) return null;
    if (!asyIsArr(a.type)) return this.err(n, `for-each 要一个数组，这里是 ${a.type}`);
    if (asyElem(a.type) !== el) return this.err(n, `for-each 的元素写的是 ${el}，数组是 ${a.type}`);
    const av = `asy__f${this.tmp++}`;
    const iv = `asy__fi${this.tmp++}`;
    const upd = [`(set ${iv} (bin "+" (var ${iv}) (int 1)))`];
    this.push();
    if (this.declare(n, nm, el) === null) { this.pop(); return null; }
    this.updates.push(upd);
    const body = this.stmt(n.items[4], ret);
    this.updates.pop();
    this.pop();
    if (body === null) return null;
    const inner = [`(let ${nm} ${asyCore(el)} (aget (var ${av}) (var ${iv})))`];
    for (const s of body) inner.push(s);
    for (const s of upd) inner.push(s);
    const head3 = `(let ${av} ${asyCore(a.type)} ${a.code}) (let ${iv} int (int 0))`;
    return [`(do ${head3} (while (bin "<" (var ${iv}) (alen (var ${av}))) (do ${inner.join(' ')})))`];
  }

  /** `for (init; test; upd) body` -> `init; while (test) { body; upd }`（continue 见上） */
  forStmt(n, ret) {
    this.push();
    const init = this.forPart(n.items[1], ret);
    const mark = this.pre === null ? 0 : this.pre.length;
    const test = isList(n.items[2]) && head(n.items[2]) === 'none'
      ? { code: '(bool true)', type: 'bool' }
      : this.coerce(this.expr(n.items[2]), 'bool', n, 'for 的条件');
    if (this.loopCond(n, 'for', mark) === null) { this.pop(); return null; }
    const upd = this.forPart(n.items[3], ret);
    if (init === null || test === null || upd === null) { this.pop(); return null; }
    this.updates.push(upd);
    const body = this.stmt(n.items[4], ret);
    this.updates.pop();
    this.pop();
    if (body === null) return null;
    const inner = [];
    for (const s of body) inner.push(s);
    for (const s of upd) inner.push(s);
    return [`(do ${init.join(' ')} (while ${test.code} (do ${inner.join(' ')})))`];
  }

  /** for 的 init / update 段：`(none)` / `(stmexps ...)` / 一条 barevardec */
  forPart(n, ret) {
    if (!isList(n)) return [];
    const h = head(n);
    if (h === 'none') return [];
    if (h === 'vardec') return this.vardec(n);
    const out = [];
    for (const s of this.flat(n, 'stmexps')) {
      const one = this.stmt(s, ret);
      if (one === null) return null;
      for (const x of one) out.push(x);
    }
    return out;
  }

  /** `int a = 1, b;`：没有初值的按类型给零值 —— asy 也是这么定的 */
  vardec(n) {
    const base = this.type(n.items[1], '变量声明');
    if (base === null) return null;
    if (base === 'void') return this.err(n, 'void 变量');
    const out = [];
    for (const d of this.flat(n.items[2], 'decids')) {
      if (!isList(d) || head(d) !== 'decid') return this.err(d, '认不出的声明项');
      const start = d.items[1];
      // `real f(real) = twice;`：函数值类型的变量声明，形参表跟在**名字**后面。
      // 与 typedef 那个拼法（`typedef real F(real); F f = twice;`）是同一件事，只是类型
      // 在这里才成形 —— 所以走同一个 fnTypeOf，往下跟别的类型没有区别。
      // 量出来的理由：`import graph;` 那 193 条错里有 4 条是这个拼法。
      // 门外的一条还在门外：把**方法**取出来当值（`int f() = a.get;`）—— 那要绑接收者的
      // 闭包，右边那个 `a.get` 自己就会被拒，`tests/asy/bad/fn-value.asy` 钉着。
      let t = base;
      if (isList(start) && head(start) === 'fundecidstart') {
        t = this.fnTypeOf(base, start.items[2], start);
        if (t === null) return null;
      } else if (!isList(start) || head(start) !== 'decidstart') {
        return this.err(start, '认不出的声明项');
      } else if (start.items.length > 2) {
        // `real a[];`：维度写在名字后面。`real a[][]` 也收（多维数组这一刀）。
        const dep = this.dimsDepth(start.items[2]);
        if (dep === null) return this.nope(start, '声明里带形参表');
        if (!this.arrElemOk(t)) return this.nope(start, `${t}[] （${ASY_ARRELEM_TEXT}）`);
        let k = 0;
        while (k < dep) { t = `${t}[]`; k++; }
      }
      const nm = isAtom(start.items[1]) ? start.items[1].value : null;
      if (nm === null) return this.err(start, '声明里少了名字');
      // `A a;`（不写 `= new A`）在 asy 那边**不是** null：它隐式跑一次 operator init，
      // 而默认的那个就是 `new A`（量过：`A c;` 之后 `c == null` 是 false，
      // 而且带默认值的字段也照求 —— `struct B { int n = bump(); } B c;` 之后计数器是 1）。
      // 这里走的**只有那个默认的**：struct 体里的 `void operator init(…)`（第二十一刀的
      // 构造调用 `A(…)`）量过不参与这一句，而换掉它的**文件级** `A operator init()`
      // 还在门外（funcSig 里拦着，`bad/ctor-toplevel` 钉着）。
      let init = null;
      if (this.isRec(t)) {
        init = this.recInit(start, t);
        if (init === null) return null;
      } else if (asyIsFn(t)) {
        // 函数值的零值是**空引用**，而核心方言的 `(let …)` 一定要一个初值表达式 ——
        // 那个"空函数值"的字面量方言里还没有（`(global f (fnty …))` 不用写：零值是后端
        // 给的，`tests/sexpr/bad/fn-null` 走的就是那条）。所以带初值的收（量过五条腿
        // 都对），不带初值的先拦住 —— 不拦就把 JS 的 undefined 拼进方言文本里了。
        if (d.items[2] === undefined) {
          return this.nope(start, `没有初值的函数值变量（\`${t} g;\` —— 它的零值是空引用，`
            + '核心方言的 let 还说不出那个字面量）');
        }
        init = '';
      } else {
        init = asyIsArr(t) ? `(anew ${asyCore(t)} (int 0))` : ZERO.get(t);
        if (init === undefined) return this.nope(start, `${t} 的变量声明（这一刀给不出它的零值）`);
      }
      if (d.items[2] !== undefined) {
        // `T[] a = {1,2,3}`：花括号初值自己没有类型，元素类型从左边的声明来
        const raw = d.items[2];
        const lit = asyIsArr(t) && isList(raw) && head(raw).startsWith('arrayinit')
          ? this.arrLit(raw, t)
          : this.expr(raw);
        const v = this.coerce(lit, t, d, `'${nm}' 的初值`);
        if (v === null) return null;
        init = v.code;
      }
      // 文件级的那一层（第二十四刀）：这里不是局部量，是个全局。声明本身已经在
      // globalNames 里收过了（函数体要先看得见它），这里只发那句赋值。
      // 标量的全局是零初始化的，所以没有初值的声明什么都不发；**聚合不行**（第三十刀）——
      // 记录要 `new`、数组要 `anew`，零就是 null，一读就是 null reference。
      const g = this.fileLevel && this.scopes.length === 1 ? this.gvarAt(nm) : null;
      if (g !== null && g.ok) {
        const need = d.items[2] !== undefined || this.isRec(t) || asyIsArr(t);
        if (need) out.push(`(set ${g.sym} ${init})`);
        continue;
      }
      if (this.declare(start, nm, t) === null) return null;
      out.push(`(let ${nm} ${asyCore(t)} ${init})`);    }
    return out;
  }

  /** 语句位置的表达式。赋值/自增只认这里 —— 它们在核心方言里是语句，不是表达式。 */
  exprStmt(e) {
    if (!isList(e)) return this.err(e, '认不出的表达式语句');
    const h = head(e);
    if (h === 'assign') return this.assign(e, e.items[1], e.items[2], null);
    if (h === 'self') {
      // SELFOP 是词法给的 token（原子），而 `(prefix "+" …)` 里的算符是模板里的字符串 ——
      // 两种节点都可能，所以一律用 asyOpText 取文本，不假设是哪一种
      const op = asyOpText(e.items[1]);
      if (op === null || op.length !== 2 || !'+-*/#%^'.includes(op.slice(0, 1))) return this.nope(e, `复合赋值 '${op}'`);
      return this.assign(e, e.items[2], e.items[3], op.slice(0, 1));
    }
    // 后缀 `x++` / `a[0]++`：**asy 自己就不收**（量过：`int b=1; b++;` 报
    // "postfix expressions are not allowed"，`a[0]++` 也一样）。这一层照着拒 ——
    // 语法认得它（camp.y 里有那条产生式），但收下来就等于比 asy 多接受一门语言。
    if (h === 'postfix') return this.err(e, 'asy 自己就不收后缀 ++/--（postfix expressions are not allowed）：写成 ++x');
    if (h === 'prefix') {
      const op = asyOpText(e.items[1]);
      if (op !== '+' && op !== '-') return this.nope(e, `自增/自减 '${op}'`);
      return this.assign(e, e.items[2], null, op);
    }
    if (h === 'call') {
      const nm = isList(e.items[1]) && head(e.items[1]) === 'name-exp' ? this.plainName(e.items[1].items[1]) : null;
      if (nm === 'write') return this.writeStmt(e);
      const v = this.call(e);
      if (v === null) return null;
      return [`(expr ${v.code})`];
    }
    return this.nope(e, `语句位置的表达式 '${h}'`);
  }

  /** 赋值、复合赋值、自增自减都归到这里：目标是普通变量名，或者数组下标 */
  assign(node, lhs, rhs, op) {
    if (isList(lhs) && head(lhs) === 'subscript') return this.assignIndex(node, lhs, rhs, op);
    // 字段赋值。asy 的 struct 是引用语义的，所以不必"读出整个记录、改完再写回去"——
    // `(fldset 接收者 字段 值)` 直接改那个对象。接收者只认**普通变量**（dotQual 的限制）：
    // 复合赋值要把它求两次，而变量读没有副作用。
    if (isList(lhs) && head(lhs) === 'name-exp') {
      const q = this.dotQual(lhs.items[1]);
      if (q === DOT_BAD) return null;
      if (q !== null && this.isRec(q.recv.type)) return this.assignFld(node, q, rhs, op);
      // pair 的分量是**只读**的虚字段：量过 asy 对 `z.x = 5` 与 `a.p.x = 5` 都报
      // "virtual field is read-only"。这条不是"还没做"，所以不带 ASY_NOPE ——
      // `tests/asy/strict/pair-field-set` 钉着它。
      if (q !== null && (q.recv.type === 'pair' || q.recv.type === 'triple')) {
        return this.err(node, `${q.recv.type} 的 '${q.field}' 是只读的虚字段 —— asy 那边就是 "virtual field is read-only"`);
      }
    }
    // `f(x).字段 = v`：接收者不是名字而是一个表达式。asy 收这种（struct 是引用类型，
    // 回来的是句柄，写进去就是写那个对象 —— 量过 `pick(p,true).x = 11` 之后 p.lo.x 是 11）。
    // 接收者**只求一次**：简单赋值直接用，复合赋值先绑个临时量。
    if (isList(lhs) && head(lhs) === 'field') {
      const recv = this.expr(lhs.items[1]);
      if (recv === null) return null;
      const fname = isAtom(lhs.items[2]) ? lhs.items[2].value : null;
      if (fname === null) return this.nope(node, '给"点后面不是名字"的东西赋值');
      if (!this.isRec(recv.type)) return this.nope(node, `给 ${recv.type} 的字段赋值`);
      if (op === null) return this.assignFld(node, { recv, field: fname }, rhs, op);
      if (this.pre === null) return this.nope(node, '这个位置的复合字段赋值（它要绑一个临时量）');
      const tv = `asy__r${this.tmp++}`;
      this.pre.push(`(let ${tv} ${asyCore(recv.type)} ${recv.code})`);
      return this.assignFld(node, { recv: { code: `(var ${tv})`, type: recv.type }, field: fname }, rhs, op);
    }
    // 切片赋值 asy **有**（量过：`int[] a={1,2,3}; a[0:2]=b;` 之后 a 是 7,8,3），
    // 而且右边长度不同时整个数组的长度会跟着变 —— 那是另一条语义，这一刀没做。
    if (isList(lhs) && head(lhs) === 'slice-exp') return this.nope(node, '给切片赋值（`a[0:2] = b`）');
    const nm = isList(lhs) && head(lhs) === 'name-exp' ? this.plainName(lhs.items[1]) : null;
    if (nm === null) return this.nope(node, '赋值给不是普通变量或数组下标的东西（字段、切片、算符名）');
    // 下面发出去的代码用 `sym`（核心方言里那个名字），错话里用 `nm`（源码里那个名字）——
    // 文件级变量的两者不同：它降成了一个全局，符号名带前缀（第二十四刀）。
    let sym = nm;
    let t = this.lookup(nm);
    if (t === null) {
      // 方法体里给裸字段名赋值（第二十刀）：`x += k` 就是 `this.x += k`
      const sf = this.selfField(nm);
      if (sf !== null) {
        return this.assignFld(node, { recv: { code: '(var this)', type: this.self.rec.name }, field: nm }, rhs, op);
      }
      const g = this.gvarHere(nm);
      if (g !== null && g.ok) { sym = g.sym; t = g.type; }
      else if (g !== null) {
        return this.nope(node, `函数里改文件级变量 '${nm}'（这一刀的模块级变量`
          + '只收 int/real/bool/string —— pair/记录/数组的身份不在 MIR 的类型码里）');
      } else if (this.globals.has(nm)) return this.gvarLate(node, nm);
      else return this.err(node, `未声明的变量 '${nm}'`);
    }
    if (op === null) {
      const v = this.coerce(this.expr(rhs), t, node, `给 '${nm}' 赋的值`);
      return v === null ? null : [`(set ${sym} ${v.code})`];
    }
    // 自增自减：右边就是 1，类型跟着变量
    const one = rhs === null ? { code: t === 'real' ? '(real 1.0)' : '(int 1)', type: t } : this.expr(rhs);
    if (one === null) return null;
    if (rhs === null && t !== 'int' && t !== 'real') return this.err(node, `'${nm}' 是 ${t}，不能自增自减`);
    // 复合赋值走的是同一个二元算符（第二十三刀）：`x op= y` 就是 `x = x op y`，
    // 量过只定义了 `V operator +(V,V)` 时 `a += b` 是通的
    const cv = { code: `(var ${sym})`, type: t };
    const uv = this.opUser(node, op, [cv, one], this.opBuiltinSig([cv, one]));
    if (uv !== null) {
      const v = this.coerce(uv, t, node, `'${nm} ${op}=' 的结果`);
      return v === null ? null : [`(set ${sym} ${v.code})`];
    }
    if (t === 'pair') {
      // `z += w` 是逐分量，`z *= 2` 与 `z /= (0,1)` 走复数乘除（量过：(4,6)*=2 是
      // (8,12)、(8,12)/=(0,1) 是 (12,-8)）。`#= %= ^=` pair 上没有。
      if (op !== '+' && op !== '-' && op !== '*' && op !== '/') return this.err(node, `pair 上没有 '${op}='`);
      const v = this.pairArith(node, op, { code: `(var ${sym})`, type: 'pair' }, one);
      return v === null ? null : [`(set ${sym} ${v.code})`];
    }
    if (t === 'triple') {
      // 量过：`t += (1,1,1)` 是 (2,3,4)、`t *= 2` 是 (2,4,6)、`t /= 2` 是 (0.5,1,1.5)；
      // `t *= (1,2,3)` 在 asy 那边是 no matching function（tripleArith 里那一条挡着）
      if (op !== '+' && op !== '-' && op !== '*' && op !== '/') return this.err(node, `triple 上没有 '${op}='`);
      const v = this.tripleArith(node, op, { code: `(var ${sym})`, type: 'triple' }, one);
      return v === null ? null : [`(set ${sym} ${v.code})`];
    }
    if (op === '#' || op === '%') {
      if (t !== 'int' || one.type !== 'int') return this.err(node, `'${op}=' 两边要是 int`);
      const helper = op === '#' ? 'asy__quot' : 'asy__mod';
      this.used.add(helper);
      return [`(set ${sym} (call ${helper} (var ${sym}) ${one.code}))`];
    }
    if (op === '^') {
      if (t !== 'int' || one.type !== 'int') return this.nope(node, "real 上的 '^='");
      this.used.add('asy__ipow');
      return [`(set ${sym} (call asy__ipow (var ${sym}) ${one.code}))`];
    }
    if (op === '/') {
      if (t !== 'real') return this.nope(node, `int 上的 '/='（asy 的 / 是实数除法，赋回 int 要写 #=）`);
      const v = this.coerce(one, 'real', node, "'/=' 的右边");
      return v === null ? null : [`(set ${sym} (bin "/" (var ${sym}) ${v.code}))`];
    }
    const v = this.coerce(one, t, node, `'${op}=' 的右边`);
    if (v === null) return null;
    if (t === 'string' && op !== '+') return this.err(node, `字符串上只有 '+='`);
    if (t === 'bool') return this.err(node, `bool 上没有 '${op}='`);
    return [`(set ${sym} (bin "${op}" (var ${sym}) ${v.code}))`];
  }

  /**
   * `a.x = v` / `a.x += v` / `++a.x`。规则与变量赋值那份逐条相同（同一批测量），
   * 只是左值从 `(set 名字 …)` 换成 `(fldset 接收者 字段 …)`。
   * 接收者在复合赋值里被求两次 —— 它只可能是一个变量读（见 assign 的入口判断）。
   */
  assignFld(node, q, rhs, op) {
    const f = this.recField(node, q.recv.type, q.field);
    if (f === null) return null;
    const t = f.type;
    const put = (code) => [`(fldset ${q.recv.code} ${q.field} ${code})`];
    const cur = `(fld ${q.recv.code} ${q.field})`;
    if (op === null) {
      const v = this.coerce(this.expr(rhs), t, node, `给 '${q.field}' 赋的值`);
      return v === null ? null : put(v.code);
    }
    const one = rhs === null ? { code: t === 'real' ? '(real 1.0)' : '(int 1)', type: t } : this.expr(rhs);
    if (one === null) return null;
    if (rhs === null && t !== 'int' && t !== 'real') return this.err(node, `'${q.field}' 是 ${t}，不能自增自减`);
    // 复合赋值走的是同一个二元算符（第二十三刀）：量过只定义了 `V operator +(V,V)` 时
    // `a.f += b` 也通 —— asy 把 `x op= y` 当 `x = x op y`
    const cf = { code: cur, type: t };
    const uf = this.opUser(node, op, [cf, one], this.opBuiltinSig([cf, one]));
    if (uf !== null) {
      const v = this.coerce(uf, t, node, `'${q.field} ${op}=' 的结果`);
      return v === null ? null : put(v.code);
    }
    if (t === 'pair') {
      // pair 字段上的复合赋值与 pair 变量上那份是同一条规则（同一批测量）：`+= -=`
      // 逐分量，`*= /=` 走**复数**乘除 —— 量过 `p *= 2` 是 (4,5)->(8,10)，走
      // "coerce 成 (2,0) 再逐分量乘"会给出 (8,0)，所以这条不能少。
      if (op !== '+' && op !== '-' && op !== '*' && op !== '/') return this.err(node, `pair 上没有 '${op}='`);
      const v = this.pairArith(node, op, { code: cur, type: 'pair' }, one);
      return v === null ? null : put(v.code);
    }
    if (t === 'triple') {
      // triple 字段上的复合赋值与 triple 变量上那份同一条规则（同一批测量）
      if (op !== '+' && op !== '-' && op !== '*' && op !== '/') return this.err(node, `triple 上没有 '${op}='`);
      const v = this.tripleArith(node, op, { code: cur, type: 'triple' }, one);
      return v === null ? null : put(v.code);
    }
    if (op === '#' || op === '%') {
      if (t !== 'int' || one.type !== 'int') return this.err(node, `'${op}=' 两边要是 int`);
      const helper = op === '#' ? 'asy__quot' : 'asy__mod';
      this.used.add(helper);
      return put(`(call ${helper} ${cur} ${one.code})`);
    }
    if (op === '^') {
      if (t !== 'int' || one.type !== 'int') return this.nope(node, "real 字段上的 '^='");
      this.used.add('asy__ipow');
      return put(`(call asy__ipow ${cur} ${one.code})`);
    }
    if (op === '/') {
      if (t !== 'real') return this.nope(node, `int 字段上的 '/='（asy 的 / 是实数除法，赋回 int 要写 #=）`);
      const v = this.coerce(one, 'real', node, "'/=' 的右边");
      return v === null ? null : put(`(bin "/" ${cur} ${v.code})`);
    }
    const v = this.coerce(one, t, node, `'${op}=' 的右边`);
    if (v === null) return null;
    if (t === 'string' && op !== '+') return this.err(node, `字符串上只有 '+='`);
    if (t === 'bool') return this.err(node, `bool 上没有 '${op}='`);
    return put(`(bin "${op}" ${cur} ${v.code})`);
  }

  /**
   * `a[i] = v` / `a[i] += v` / `a[i]++`。
   *
   * 两件事和变量赋值不一样：
   *
   *  1. **写下标会把数组长到 i+1**（量过：`int[] e; e[2]=5;` 之后 `e.length` 是 3）。
   *     所以先调一个 `asy__grow_元素` 把长度顶上去，再 aset。
   *  2. 数组和下标都要**只算一次**：复合赋值要读一次写一次，`a[f()] += 1` 里的 f 不能调两遍。
   *     所以两者都先绑到临时量（用 `? :` 那套 `this.pre`）。
   */
  assignIndex(node, lhs, rhs, op) {
    const a = this.expr(lhs.items[1]);
    if (a === null) return null;
    if (!asyIsArr(a.type)) return this.err(node, `下标只能用在数组上，这里是 ${a.type}`);
    const idx = this.coerce(this.expr(lhs.items[2]), 'int', node, '下标');
    if (idx === null) return null;
    if (this.pre === null) return this.nope(node, '这个位置的下标赋值（它要摊成语句，这里放不下）');
    const el = asyElem(a.type);
    const av = `asy__d${this.tmp++}`;
    const iv = `asy__i${this.tmp++}`;
    this.pre.push(`(let ${av} ${asyCore(a.type)} ${a.code})`);
    this.pre.push(`(let ${iv} int ${idx.code})`);
    const grow = this.arrHelper('grow', el);
    const head2 = `(expr (call ${grow} (var ${av}) (var ${iv})))`;
    const cur = `(aget (var ${av}) (var ${iv}))`;
    const put = (code) => [head2, `(aset (var ${av}) (var ${iv}) ${code})`];
    if (op === null) {
      const v = this.coerce(this.expr(rhs), el, node, '赋给数组元素的值');
      return v === null ? null : put(v.code);
    }
    const one = rhs === null ? { code: el === 'real' ? '(real 1.0)' : '(int 1)', type: el } : this.expr(rhs);
    if (one === null) return null;
    if (rhs === null && el !== 'int' && el !== 'real') return this.err(node, `${el} 的数组元素不能自增自减`);
    // 复合赋值走同一个二元算符（第二十三刀）。`cur` 会出现两次，但下标与数组都已经绑成
    // 临时量了，所以求值次数不变
    const ce = { code: cur, type: el };
    const ue = this.opUser(node, op, [ce, one], this.opBuiltinSig([ce, one]));
    if (ue !== null) {
      const v = this.coerce(ue, el, node, `数组元素 '${op}=' 的结果`);
      return v === null ? null : put(v.code);
    }
    if (op === '#' || op === '%') {
      if (el !== 'int' || one.type !== 'int') return this.err(node, `'${op}=' 两边要是 int`);
      const helper = op === '#' ? 'asy__quot' : 'asy__mod';
      this.used.add(helper);
      return put(`(call ${helper} ${cur} ${one.code})`);
    }
    if (op === '^') {
      if (el === 'int' && one.type === 'int') {
        this.used.add('asy__ipow');
        return put(`(call asy__ipow ${cur} ${one.code})`);
      }
      if (el !== 'real') return this.err(node, `'^=' 的两边要是 int 或 real`);
      const v = this.coerce(one, 'real', node, "'^=' 的右边");
      return v === null ? null : put(`(rmath "pow" ${cur} ${v.code})`);
    }
    if (op === '/') {
      if (el !== 'real') return this.nope(node, `int 数组元素上的 '/='（asy 的 / 是实数除法，赋回 int 要写 #=）`);
      const v = this.coerce(one, 'real', node, "'/=' 的右边");
      return v === null ? null : put(`(bin "/" ${cur} ${v.code})`);
    }
    const v = this.coerce(one, el, node, `'${op}=' 的右边`);
    if (v === null) return null;
    if (el === 'string' && op !== '+') return this.err(node, `字符串上只有 '+='`);
    if (el === 'bool') return this.err(node, `bool 上没有 '${op}='`);
    return put(`(bin "${op}" ${cur} ${v.code})`);
  }

  /** 一段花括号里的东西：`(block-stm BLOCK)` 或直接一条 BLOCK 链 */
  body(n, ret) {
    const inner = isList(n) && head(n) === 'block-stm' ? n.items[1] : n;
    this.push();
    const out = [];
    for (const r of this.flat(inner, 'block')) {
      const one = this.stmt(r, ret);
      if (one === null) { this.pop(); return null; }
      for (const s of one) out.push(s);
    }
    this.pop();
    return out;
  }

  /* -------------------------------------------------------------- 模块 */

  /** `(idpair NAME)` -> {src, dst}；`(idpair SRC as DST)` -> 改了名的那份；别的回 null */
  idPair(n) {
    if (!isList(n) || head(n) !== 'idpair') return null;
    const a = isAtom(n.items[1]) ? n.items[1].value : null;
    if (a === null) return null;
    if (n.items.length === 2) return { src: a, dst: a };
    if (n.items.length !== 4) return null;
    const as = isAtom(n.items[2]) ? n.items[2].value : null;
    const b = isAtom(n.items[3]) ? n.items[3].value : null;
    if (as !== 'as' || b === null) return null;
    return { src: a, dst: b };
  }

  /**
   * 模块 `name` 的单元。同一个模块只加载一次（量过：`import m; import m;` 体只跑一遍），
   * 加载 = 解析（`opts.load`，文件 IO 与语法表都在 cli.js）+ 立刻走一遍**声明遍** ——
   * 声明遍走完这个单元的导出表就是全的，import 它的人才有东西可并。
   */
  modLoad(node, name) {
    const had = this.byKey.get(name);
    if (had !== undefined) return had;
    if (this.opts === null || this.opts.load === undefined || this.opts.load === null) {
      this.nope(node, `模块 '${name}'（这条路上没有模块加载器）`);
      return null;
    }
    for (const k of this.loading) {
      if (k === name) { this.nope(node, `循环 import（'${name}' 正在加载）`); return null; }
    }
    const tree = this.opts.load(name);
    if (tree === null || tree === undefined) {
      this.nope(node, `模块 '${name}' 找不到 —— 当前目录下没有 ${name}.asy`
        + '（asy 的模块是按 CWD 找的，量过；标准库那些 plain/graph/… 这一刀还没有）');
      return null;
    }
    const u = this.unitNew(tree, name);
    this.byKey.set(name, u);
    this.loading.push(name);
    const prev = this.unitIn(u);
    this.declPass(u);
    this.unitOut(prev);
    this.loading.pop();
    return u;
  }

  /** 候选换一个"可见位置"：import 进来的名字，可见位置是那条 import 语句的下标 */
  candAt(c, at) {
    return {
      ret: c.ret, params: c.params, ps: c.ps, node: c.node, sym: c.sym, base: c.base,
      pfx: c.pfx, unit: c.unit, dat: c.dat === undefined ? c.at : c.dat, at: at,
      mat: c.mat, rec: c.rec, ctor: c.ctor,
    };
  }

  /**
   * 把模块 `u` 的导出并进当前单元，可见位置是 `at`（那条 import 语句的下标）。
   * 三条量过的语义因此都是白捡的：
   *   - **顺序解析**：import 写在后面时前面那几行看不见那些名字；
   *   - **本地的声明遮住 import 进来的**（同名的候选表里本地那份在后面，at 更大）；
   *   - **传递性**：并的是模块**自己的**表，而那张表里已经含着它 import 进来的东西
   *     （量过 `import mid;` 之后 mid import 的名字也裸着可见）。
   * `only` 不是 null 时只并那几个名字（`from m access f, g;`）。
   */
  modMerge(node, u, at, only) {
    for (const [nm, list] of u.funcs) {
      // `记录名.方法名` 不并：方法跟着 struct 走（见 visibleMethods）
      if (nm.indexOf('.') >= 0) continue;
      const key = only === null ? nm : only.get(nm);
      if (key === undefined) continue;
      const dst = this.funcs.has(key) ? this.funcs.get(key) : [];
      for (const c of list) {
        let dup = false;
        for (const d of dst) if (d.sym === c.sym) dup = true;
        if (dup) continue;   // 同一个模块引两遍：名字还是那一份
        dst.push(this.candAt(c, at));
      }
      this.funcs.set(key, dst);
    }
    for (const [nm, list] of u.globals) {
      const key = only === null ? nm : only.get(nm);
      if (key === undefined) continue;
      const dst = this.globals.has(key) ? this.globals.get(key) : [];
      for (const g of list) {
        let dup = false;
        for (const d of dst) if (d.sym === g.sym) dup = true;
        if (dup) continue;
        // 同一块存储：模块里改它、这边也改它（量过两边都看得见对方的改动）
        dst.push({ sym: g.sym, type: g.type, at: at, ok: g.ok });
      }
      this.globals.set(key, dst);
    }
    for (const [nm, e] of u.recVis) {
      const key = only === null ? nm : only.get(nm);
      if (key === undefined) continue;
      if (key !== nm) { this.nope(node, `给 import 进来的 struct '${nm}' 改名`); continue; }
      if (!this.recVis.has(key)) this.recVis.set(key, { rec: e.rec, at: at });
    }
    // typedef 的别名跟着 import 一起进来（asy 那边也是：`import graph;` 之后
    // `splinetype` 就是个类型名了）。改名那种写法（`from m access X as Y;`）不收 ——
    // 与上面 struct 那一条同一个理由：别名的名字在这一刀不参与重命名。
    for (const [nm, e] of u.tyAlias) {
      const key = only === null ? nm : only.get(nm);
      if (key === undefined) continue;
      if (key !== nm) { this.nope(node, `给 import 进来的 typedef '${nm}' 改名`); continue; }
      // 位置一律按 import 那一行算（与 recVis 同一条），所以只带**模块里最后那一份**
      if (!this.tyAlias.has(key)) this.tyAlias.set(key, [{ t: e[e.length - 1].t, at: at }]);
    }
    // 用户定义的转换（第二十七刀）：`import m;` 把它们一起带进来 —— 它们不挂在某个名字上，
    // 所以 `only`（`from m access f, g;` 的那张改名表）管不到它们，那种写法这边就不并。
    if (only !== null) return;
    for (const [to, list] of u.casts) {
      const dst = this.casts.has(to) ? this.casts.get(to) : [];
      for (const c of list) {
        let dup = false;
        for (const d of dst) if (d.sym === c.sym) dup = true;
        if (dup) continue;
        dst.push({
          ret: c.ret, params: c.params, ps: c.ps, node: c.node, sym: c.sym, pfx: c.pfx,
          unit: c.unit, dat: c.dat, at: at, to: c.to, src: c.src, ec: c.ec,
        });
      }
      this.casts.set(to, dst);
    }
  }

  /**
   * `import m;` / `access m;` / `access m as mm;` / `from m access f, g;`（第二十五刀）。
   * 量过的四条（`asy -noV`）：
   *   - **模块体在那一行跑**，而且只跑一次（`import m; import m;` 只印一遍）；
   *   - `access` 也跑体，但只给限定名（`access m; write(mv);` 报 "no matching variable"）；
   *   - `import` 之后裸名字与 `m.x` 是**同一块存储**，两边都能改；
   *   - 别名（`access m as mm;`）与 `from m access f;` 都通。
   * 门外的：`unravel`、`include`、参数化模块（`from c.map(K=int) access …`）、通配的
   * `from m access *`。
   */
  modStmt(n, at) {
    const h = head(n);
    if (h === 'import' || h === 'access') {
      const list = h === 'import' ? [n.items[1]] : this.flat(n.items[1], 'idpairs');
      for (const p of list) {
        const pr = this.idPair(p);
        if (pr === null) { this.nope(p, `${h} 的这种写法`); continue; }
        const u = this.modLoad(p, pr.src);
        if (u === null) continue;
        this.mods.set(pr.dst, { unit: u.id, at: at });
        if (h === 'import') this.modMerge(p, u, at, null);
        this.modCallAt(at, u);
      }
      return null;
    }
    if (h === 'from-access') {
      if (n.items.length !== 3) return this.nope(n, '参数化的 `from … access`（模板模块）');
      const src = isAtom(n.items[1]) ? n.items[1].value : null;
      if (src === null) return this.nope(n, '`from … access` 的这种模块名');
      const names = n.items[2];
      if (isList(names) && head(names) === 'wildcard') return this.nope(n, '`from … access *`');
      const only = new Map();
      for (const p of this.flat(names, 'idpairs')) {
        const pr = this.idPair(p);
        if (pr === null) { this.nope(p, '`from … access` 里的这种写法'); continue; }
        only.set(pr.src, pr.dst);
      }
      const u = this.modLoad(n, src);
      if (u === null) return null;
      this.modMerge(n, u, at, only);
      this.modCallAt(at, u);
      return null;
    }
    return this.nope(n, `模块声明 '${h}'`);
  }

  /** 这条 import 语句要在**它自己的位置**上调一次模块的初始化函数（体在那一行跑） */
  modCallAt(at, u) {
    const list = this.unit.callAt.has(at) ? this.unit.callAt.get(at) : [];
    list.push(u.init);
    this.unit.callAt.set(at, list);
  }

  /** `(qualified (name M) NAME)` 且 M 是此处可见的模块别名时回 {unit, name}，否则 null */
  modAlias(node) {
    if (!isList(node) || head(node) !== 'qualified') return null;
    const nm = isAtom(node.items[2]) ? node.items[2].value : null;
    if (nm === null) return null;
    const base = this.plainName(node.items[1]);
    if (base === null || !this.mods.has(base)) return null;
    const m = this.mods.get(base);
    // 顺序解析：那条 import/access 写在后面时，这里还没有这个模块
    if (m.at > this.at) return null;
    return { unit: m.unit, name: nm, mod: base };
  }

  /** `m.x`：模块里的文件级变量。存储是同一块（量过两边都能改） */
  modVar(n, mq) {
    const list = this.units[mq.unit].globals.get(mq.name);
    if (list === undefined) {
      return this.nope(n, `模块限定的名字 '${mq.mod}.${mq.name}'（这一刀的 \`m.名字\` 只有`
        + '模块里的文件级变量与函数）');
    }
    const g = list[list.length - 1];
    if (!g.ok) {
      return this.nope(n, `模块限定的文件级变量 '${mq.mod}.${mq.name}'（这一刀的模块级变量`
        + '只收 int/real/bool/string）');
    }
    return { code: `(var ${g.sym})`, type: g.type };
  }

  /** `m.f(…)`：模块里的函数。候选表是那个模块的（限定名不受这边顺序解析的影响） */
  modCall(n, mq) {
    const list = this.units[mq.unit].funcs.get(mq.name);
    if (list === undefined || list.length === 0) {
      return this.err(n, `模块 '${mq.mod}' 里没有函数 '${mq.name}'`);
    }
    return this.userCall(n, mq.name, list);
  }

  /* ------------------------------------------------------------ 文件与函数 */

  /** `static real f(...)` 这类修饰在文件层是无所谓的，剥掉 */
  unwrapMod(n) {
    let cur = n;
    while (isList(cur) && head(cur) === 'modified') cur = cur.items[2];
    return cur;
  }

  /**
   * 这一句带 `autounravel` 吗（第二十八刀）。树形是 `(modified (mods "autounravel"…) DEC)`。
   * struct 体里它的意思是"这个成员其实是**文件级**的声明"：量过 `asy -noV`
   *   - `autounravel real operator cast(R r)` 之后 `real x = a;` 通（不带 autounravel 的
   *     那份 asy 收声明但**不用**它 —— 报 "cannot cast 'R' to 'real'"）；
   *   - `autounravel int twice(R r)` 之后 `twice(z)` 是**裸名字**调用，不是方法；
   *   - 可见位置是**这个 struct 的位置**：写在 struct 前面的地方看不见（"no matching
   *     variable 'k'"）。
   * 所以降级就是把它交给文件级那条路（sig），`at` 用 struct 的下标。
   */
  auMod(n) {
    let cur = n;
    while (isList(cur) && head(cur) === 'modified') {
      for (const m of this.flat(cur.items[1], 'mods')) {
        if (isAtom(m) && m.value === 'autounravel') return true;
      }
      cur = cur.items[2];
    }
    return false;
  }

  /**
   * 文件级的 `T operator init()`（第二十二刀）：asy 用它换掉 `T t;` 的隐式构造。
   * 四条都量过（`asy -noV`）：
   *   - `A operator init() { A r = new A; r.x = 5; return r; } A a;` 之后 `a.x` 是 5，
   *     而 `A b = new A;` 绕开它（`b.x` 是 0）；
   *   - 每次构造求一次（计数器加两次就是 2）；
   *   - **顺序解析**：写在 `A a;` 后面的那份不算，两份都写就是"各管后面那一段"；
   *   - **内嵌记录字段也走它**，但按**那个 struct 声明处**的可见性定：
   *     `struct B { A a; }` 写在 oi 前面时 `b.a.x` 是 0，写在后面才是 5。
   * 形参不为空的那种不收：量过 `A operator init(int)` 之后 `A a = 7;` 报
   * "cannot cast 'int' to 'A'" —— 它不是隐式转换，能拿它干什么没量出来，所以不猜。
   */
  oinitSig(n, at) {
    const ret = this.type(n.items[1], 'operator init 的返回类型');
    if (ret === null) return;
    if (!this.isRec(ret)) {
      this.nope(n, `回 ${ret} 的文件级 'operator init'（这一刀只有 struct 的那份）`);
      return;
    }
    // 别的模块里的 struct（第二十五刀）：`T t;` 造什么是在**声明它的那个模块**里定的
    // （见 recInit），所以这边再写一份的话我们会静静地不用它 —— 那不如拒得明白。
    if (this.records.get(ret).unit !== this.unit.id) {
      this.nope(n, `给另一个模块的 struct '${ret}' 定义文件级 'operator init'`);
      return;
    }
    const ps = this.formals(n.items[3]);
    if (ps === null) return;
    if (ps.length !== 0) {
      this.nope(n, `带形参的文件级 'operator init'（asy 那边它也不是隐式转换 ——`
        + ` \`${ret} a = 7;\` 报 "cannot cast"）`);
      return;
    }
    const list = this.oinits.has(ret) ? this.oinits.get(ret) : [];
    // 同名的第 2 份及以后要改个名字：核心方言里模块层的名字是全局唯一的
    const sym = list.length === 0 ? `asy__oi_${ret}` : `asy__oi${list.length}_${ret}`;
    const cand = { ret, params: [], ps: [], node: n, at, sym };
    list.push(cand);
    this.oinits.set(ret, list);
    this.oiByNode.set(n, list);
  }

  /** 记录 `t` 在**当前位置**该用哪份文件级 operator init（没有就回 null） */
  oinitFor(t) {
    const list = this.oinits.get(t);
    if (list === undefined) return null;
    let cur = null;
    for (const c of list) if (c.at <= this.at) cur = c;
    return cur;
  }

  /**
   * `T operator cast(S)` / `T operator ecast(S)`（第二十七刀）：用户定义的转换。
   * 六条都量过（`asy -noV`）：
   *   - `cast` 在**隐式位置**都管用：实参、初始化、return、数组元素赋值、数组字面量、
   *     字段默认值；`ecast` 只给 `(T) x` —— 只写 ecast 时 `V b = 5;` 报
   *     "cannot cast 'int' to 'V'"，而 `(V) 5` 通；
   *   - 代价**跟内建提升一样**：`void p(real); void p(V);` 加 `V operator cast(int)`
   *     之后 `p(3)` 报 "call ... is ambiguous"；
   *   - **不串**：`A operator cast(int)` 加 `B operator cast(A)` 之后 `q(5)`（要 B）不通，
   *     `V operator cast(real)` 之后 `p(3)`（int）也不通 —— 所以源类型必须**一模一样**；
   *   - **顺序解析**：写在调用点后面的那份不算；
   *   - 一个源类型转到两个目标、两个重载各收一个 -> ambiguous（打平的直接后果，白捡）；
   *   - `(T) x` 优先走内建（`(real) 3` 还是提升），用户那份是**兜底**。
   */
  castSig(n, at, ec) {
    const nm = ec ? 'operator ecast' : 'operator cast';
    const to = this.type(n.items[1], `${nm} 的目标类型`);
    const ps = this.formals(n.items[3]);
    if (to === null || ps === null) return;
    if (to === 'void') {
      this.err(n, `'void ${nm}(…)' 不是合法的转换 —— 转成 void 没有意义`);
      return;
    }
    if (ps.length !== 1) {
      this.nope(n, `${ps.length} 元的 '${nm}'（asy 的转换是一元的：一个源类型一个目标类型）`);
      return;
    }
    const safe = to.replace(/[^A-Za-z0-9_]/g, '_');
    const cand = {
      ret: to, params: [ps[0].type], ps, node: n, sym: `${this.pfx}asy__cast${this.castNo}_${safe}`,
      pfx: this.pfx, unit: this.unit.id, at, dat: at, to, src: ps[0].type, ec,
    };
    this.castNo++;
    const list = this.casts.has(to) ? this.casts.get(to) : [];
    list.push(cand);
    this.casts.set(to, list);
    this.castByNode.set(n, [cand]);
  }

  /**
   * 从 `from` 转到 `to` 的用户转换，按**当前位置**挑（没有就回 null）。
   * `allowEc` 只在 `(T) x` 那个位置是 true。源类型要一模一样 —— asy 不串转换（量过）。
   */
  castFor(to, from, allowEc) {
    const list = this.casts.get(to);
    if (list === undefined) return null;
    let cur = null;
    for (const c of list) {
      if (c.src !== from) continue;
      if (c.ec && !allowEc) continue;
      if (c.at > this.at) continue;
      cur = c;   // 同一对类型写两份：后面那份管后面（跟别的顺序解析一致）
    }
    return cur;
  }

  /**
   * 形参表：`(formal (implicit) TYPE (decidstart NAME))`，带默认值时多一个
   * `varinit`（`(formal EX TYPE DECIDSTART VARINIT)`，第十刀加的）。
   * 默认值这里**只存节点不降级**：它要在调用点按"缺哪几个"生成的包装函数里降，
   * 因为量过 asy 的默认值是**每次调用**求一次、而且能引用前面的形参
   * （`void q(int a, int b = a + 10)`：`q(1)` 印 11）。
   */
  formals(node) {
    const out = [];
    for (const f of this.flat(node, 'formals')) {
      if (!isList(f) || head(f) !== 'formal') return this.nope(f, '关键字形参或可变形参');
      if (f.items.length !== 4 && f.items.length !== 5) return this.nope(f, '无名形参');
      const ex = f.items[1];
      // `explicit T x`（第二十六刀）：这个槽**只收类型一模一样的实参**。量过四条：
      //   - `void p(explicit real r); p(3);` 在 asy 那边报 "cannot call ... with
      //     parameter 'int'" —— 连内建的 int->real 提升都挡，不只挡用户的 operator cast；
      //   - `p(3.0)` 通；
      //   - 它**不进签名身份**：先 `void p(real)` 再 `void p(explicit real)` 是**替换**
      //     （量过：之后 `p(3.0)` 走后者、`p(3)` 直接报错），反序则是前者被换掉；
      //   - 算符与数组形参上一样管用。
      // 于是降级要做的只有两件：这里记个标记，fit() 那边多问一句。
      const exp = isList(ex) && head(ex) === 'explicit';
      const t = this.type(f.items[2], '形参');
      const start = f.items[3];
      if (t === null) return null;
      // `real f(real)`：形参名后面挂一个形参表 —— 这个槽的类型是**函数类型**
      // （量出来的第一拦路虎，见 asyIsFn 的注释）。
      if (isList(start) && head(start) === 'fundecidstart') {
        const ft = this.fnTypeOf(t, start.items[2], start);
        if (ft === null) return null;
        const fnm = isAtom(start.items[1]) ? start.items[1].value : null;
        if (fnm === null) return this.err(start, '形参少了名字');
        out.push({ name: fnm, type: ft, exp: exp, def: f.items.length === 5 ? f.items[4] : null });
        continue;
      }
      if (!isList(start) || head(start) !== 'decidstart' || start.items.length !== 2) return this.nope(start, '带维度的形参名');
      const nm = isAtom(start.items[1]) ? start.items[1].value : null;
      if (nm === null) return this.err(start, '形参少了名字');
      out.push({ name: nm, type: t, exp: exp, def: f.items.length === 5 ? f.items[4] : null });
    }
    return out;
  }

  /**
   * `RET` + 一个形参表节点 -> 函数类型的字符串（`real(int,string)`）。
   * 这里**只要类型**：函数类型里的形参名在 asy 那边可以没有（`real f(real)`），
   * 有也不进类型身份 —— 所以不能走 formals()（它要求有名字，也要收默认值）。
   */
  fnTypeOf(ret, formalsNode, at) {
    if (asyIsFn(ret)) {
      return this.nope(at, '返回类型自己是函数类型（`real(real)(int)` 那种拼法有歧义）');
    }
    const ps = [];
    for (const f of this.flat(formalsNode, 'formals')) {
      if (!isList(f) || head(f) !== 'formal') return this.nope(f, '函数类型里的关键字形参或可变形参');
      const t = this.type(f.items[2], '函数类型里的形参');
      if (t === null) return null;
      if (f.items.length > 3) {
        const st = f.items[3];
        if (isList(st) && head(st) === 'fundecidstart') {
          const inner = this.fnTypeOf(t, st.items[2], st);
          if (inner === null) return null;
          ps.push(inner);
          continue;
        }
        if (isList(st) && head(st) === 'decidstart' && st.items.length > 2) {
          const d = this.dimsDepth(st.items[2]);
          if (d === null) return this.nope(st, '函数类型的形参名后面那串东西');
          let a = t;
          let k = 0;
          while (k < d) { a = `${a}[]`; k++; }
          ps.push(a);
          continue;
        }
      }
      ps.push(t);
    }
    let inner = '';
    for (const p of ps) inner = inner === '' ? p : `${inner},${p}`;
    return `${ret}(${inner})`;
  }

  /**
   * 第一遍：登记签名。**同名可以有多个**（第十一刀的重载）——`funcs` 里存的是一张
   * 候选表。同一份签名（形参类型逐个相同）第二次出现是**替换**，不是错：量过 asy 的
   * `int s(int x)` 后面再写 `real s(int x)`，调 `s(5)` 走的是后者。
   */
  sig(n, at) {
    const nm = isAtom(n.items[2]) ? n.items[2].value : null;
    if (nm === null) return;
    if (nm === 'operator init') { this.oinitSig(n, at); return; }
    // `operator cast` / `operator ecast`（第二十七刀）：它们不进 funcs —— 候选按**目标类型**
    // 存（见 castSig），调用点只在"转换"这一步问它，名字本身在 asy 里也调不到。
    if (nm === 'operator cast' || nm === 'operator ecast') {
      this.castSig(n, at, nm === 'operator ecast');
      return;
    }
    // 算符重载（第二十三刀）：`V operator +(V,V)` 就是个名字叫 `operator +` 的函数，
    // 所以候选表按这个名字存 —— asy 里它跟普通重载在同一张表里（量过：用户的
    // `int operator +(int,int)` 会**盖掉内建的** `2 + 3`）。降级出的符号名要是个标识符。
    let sym = nm;
    if (nm.startsWith('operator ')) {
      const op = nm.slice('operator '.length);
      if (ASY_OPBAD.has(op)) {
        this.err(n, `'operator ${op}' 不是合法的 asy 声明 —— asy 的语法里就没有这个算符名，`
          + `那边直接报 "syntax error"（不带 ASY_NOPE：不是还没做）`);
        return;
      }
      if (!ASY_OPSYM.has(op)) { this.nope(n, `算符 '${op}' 的重载`); return; }
      sym = `asy__op_${ASY_OPSYM.get(op)}`;
    }
    if (nm === 'write') { this.nope(n, "重新定义 'write'"); return; }
    const ret = this.type(n.items[1], `函数 ${nm} 的返回类型`);
    const ps = this.formals(n.items[3]);
    if (ret === null || ps === null) return;
    if (nm.startsWith('operator ') && ps.length !== 1 && ps.length !== 2) {
      this.nope(n, `${ps.length} 元的 '${nm}'（算符只有一元与二元）`);
      return;
    }
    const types = [];
    for (const p of ps) types.push(p.type);
    // `ps` 带名字与默认值节点（命名实参与默认实参要它）；`params` 只是类型，
    // 保留是因为别处的实参检查一直按下标读它。
    // `base` 是**没加单元前缀**的符号名（重载改名时要它），`unit` 是"这份声明在哪个单元里"
    // —— import 进来的候选是别的单元的，改名与默认值都归那边管（第二十五刀）。
    const cand = {
      ret, params: types, ps, node: n, sym: `${this.pfx}${sym}`, base: sym,
      pfx: this.pfx, unit: this.unit.id, at, dat: at,
    };
    const list = this.funcs.has(nm) ? this.funcs.get(nm) : [];
    const key = types.join(',');
    for (let i = 0; i < list.length; i++) {
      if (list[i].params.join(',') !== key) continue;
      list[i] = cand;
      this.funcs.set(nm, list);
      return;
    }
    list.push(cand);
    this.funcs.set(nm, list);
  }

  /**
   * 方法的签名（第二十刀）。存在 `funcs` 里的 key 是 `记录名.方法名` —— asy 的名字里不能
   * 有点，所以这个 key 不可能撞上文件级的函数名，而重载那套（候选表、同签名替换、
   * 第 2 个及以后改名）就白捡了。
   * `at` 是**结构体在文件里的下标**：方法体里能看见的文件级函数，正好是声明在这个结构体
   * 前面的那些（asy 的名字解析是顺序的，量过）。`mat` 是成员下标，管结构体内部的可见性。
   */
  methodSig(rec, n, mat, at) {
    const nm = isAtom(n.items[2]) ? n.items[2].value : null;
    if (nm === null) return null;
    // `void operator init(…)`（第二十一刀）：**构造函数**，调用形态是 `A(…)`。
    // 三条都量过：返回类型必须是 void（写 `int operator init(int)` 之后 `A(3)` 在 asy 那边
    // 报 "no matching variable 'A'" —— 那份根本没造出构造函数）、字段默认值在体之前就铺好
    // （`int z = 8;` 加体里 `z = z + 1` 出来是 9）、而 `A a;` **不**走它（量过是 0，不是
    // 体里赋的值 —— `A a;` 只认文件级的 `A operator init()`，那一条还在门外）。
    const ctor = nm === 'operator init';
    if (nm.startsWith('operator ') && !ctor) {
      return this.nope(n, `struct ${rec.name} 里的算符重载 '${nm}'`);
    }
    const ret = this.type(n.items[1], `方法 ${rec.name}.${nm} 的返回类型`);
    const ps = this.formals(n.items[3]);
    if (ret === null || ps === null) return null;
    if (ctor && ret !== 'void') {
      return this.nope(n, `返回 ${ret} 的 'operator init'（asy 只把 void 的那份当构造函数，`
        + `别的形态它自己也不给 ${rec.name}(…)）`);
    }
    const types = [];
    for (const p of ps) types.push(p.type);
    for (const p of ps) if (p.name === 'this') return this.nope(n, "叫 'this' 的形参");
    const key = `${rec.name}.${nm}`;
    // 构造函数的候选**看起来像个回记录的普通函数**（`ret` 是记录名、没有接收者），
    // 重载解析与默认实参那两套因此一字不改就能用；`ctor` 标记只在发正文时用。
    // 符号名不带单元前缀（第二十五刀）：记录名本身就是全局唯一的（见 recordDec）。
    const msym = ctor ? `asy__ctor_${rec.name}` : `asy__m_${rec.name}_${nm}`;
    const cand = {
      ret: ctor ? rec.name : ret, params: types, ps, node: n, at: -1, dat: at, mat, rec, ctor,
      sym: msym, base: msym, pfx: '', unit: this.unit.id,
    };
    const list = this.funcs.has(key) ? this.funcs.get(key) : [];
    const sk = types.join(',');
    for (let i = 0; i < list.length; i++) {
      if (list[i].params.join(',') !== sk) continue;
      list[i] = cand;
      this.funcs.set(key, list);
      return cand;
    }
    list.push(cand);
    this.funcs.set(key, list);
    this.methodDecls.push({ rec, cand, at });
    return cand;
  }

  /**
   * 方法体。与 func() 的差别只有三处：多一个 `this` 形参（核心方言里 `this` 就是个普通
   * 名字，量过它当形参名合法）、`this.self` 开着（裸字段名走 `(fld (var this) f)`、
   * 裸方法名走同一个记录的方法）、`this.at` 设成**结构体**的文件下标。
   *
   * 构造函数（`void operator init(…)`，第二十一刀）出**两个**函数：正文还是那个多带一个
   * `this` 的 void 方法（名字后缀 `_body`），外面套一层 `asy__ctor_<记录>` —— 造对象、
   * 调正文、回对象。分两层不是为了好看：体里的 `return;` 在 void 那份里是合法的一条
   * `(ret)`，塞进一个"要回记录"的函数里就不合法了。
   */
  method(rec, cand, at) {
    const ps = this.formals(cand.node.items[3]);
    if (ps === null) return null;
    const isCtor = cand.ctor === true;
    const bodyRet = isCtor ? 'void' : cand.ret;
    const bodySym = isCtor ? `${cand.sym}_body` : cand.sym;
    const keepAt = this.at;
    this.at = at;
    this.self = { rec, mat: cand.mat };
    this.push();
    this.declare(cand.node, 'this', rec.name);
    for (const p of ps) this.declare(cand.node, p.name, p.type);
    const body = this.body(cand.node.items[4], bodyRet);
    this.pop();
    this.self = null;
    this.at = keepAt;
    if (body === null) return null;
    const last = body.length === 0 ? '' : body[body.length - 1];
    if (bodyRet !== 'void' && !last.startsWith('(ret ')) {
      let zero = null;
      if (asyIsArr(bodyRet)) zero = `(anew ${asyCore(bodyRet)} (int 0))`;
      else if (this.isRec(bodyRet)) zero = this.recInit(cand.node, bodyRet);
      else zero = ZERO.get(bodyRet);
      if (zero === null) return null;
      body.push(`(ret ${zero})`);
    }
    const params = [`(this ${asyCore(rec.name)})`];
    for (const p of ps) params.push(`(${p.name} ${asyCore(p.type)})`);
    const lines = [`  (fn ${bodySym} (${params.join(' ')}) ${asyCore(bodyRet)}`];
    for (const s of body) lines.push(`    ${s}`);
    const text = `${lines.join('\n')})`;
    if (!isCtor) return text;
    // 全实参那份构造函数：造对象（字段默认值在这里铺，量过它在体之前）、调正文、回对象。
    // 缺实参那份走 defWrapper 的 isCtor 分支 —— 那边默认值要看得见字段，所以不能复用这个。
    const mk = this.recNew(cand.node, rec.name);
    if (mk === null) return null;
    const args = ['(var this)'];
    const cps = [];
    for (const p of ps) { args.push(`(var ${p.name})`); cps.push(`(${p.name} ${asyCore(p.type)})`); }
    const outer = [`  (fn ${cand.sym} (${cps.join(' ')}) ${asyCore(rec.name)}`,
      `    (let this ${asyCore(rec.name)} ${mk})`,
      `    (expr (call ${bodySym} ${args.join(' ')}))`,
      '    (ret (var this))'];
    return `${text}\n${outer.join('\n')})`;
  }

  /**
   * 第一遍收文件级变量（第二十四刀）：名字、类型、**位置**。位置要记，因为 asy 的名字
   * 解析是顺序的 —— 量过函数体里引用后面才声明的文件级变量，asy 报
   * "no matching variable of name 'g'"。
   *
   * 每份声明各出一个全局符号 `asy__g<序号>_<名字>`：同一个名字在文件里可以声明多次
   * （量过 `int a = 1; write(a); int a = 7; write(a);` 印 1 再印 7 —— 那是两个变量），
   * 而核心方言的模块级名字要全局唯一。
   *
   * 类型在这里是**照着节点看**出来的，不走 this.type()：那一路会报诊断，而这一遍
   * 只是收表，真正的检查在 vardec 里（同一句报两遍是噪音）。看不出是标量的就 ok:false，
   * 留在表里让函数里那句错话说得清是哪一条。
   */
  globalNames(n, at) {
    const tn = n.items[1];
    // 类型是**照着节点看**出来的（不走 this.type()，那一路会报诊断）。三种形状：
    //   `pen p;`      -> (name-ty (name pen))
    //   `pair[] a;`   -> (array-ty (name pair) (dims))     里面是 (name …)，没有 name-ty
    //   `real a[];`   -> (name-ty (name real)) + decidstart 上挂 dims
    let base = null;
    let arr = 0;
    let inner = tn;
    if (isList(inner) && head(inner) === 'array-ty') {
      const d = this.dimsDepth(inner.items[2]);
      arr = d === null ? 0 : d;
      inner = inner.items[1];
    }
    if (isList(inner) && head(inner) === 'name-ty') inner = inner.items[1];
    if (isList(inner) && head(inner) === 'name' && isAtom(inner.items[1])) base = inner.items[1].value;
    for (const d of this.flat(n.items[2], 'decids')) {
      if (!isList(d) || head(d) !== 'decid') continue;
      const start = d.items[1];
      if (!isList(start) || !isAtom(start.items[1])) continue;
      const nm = start.items[1].value;
      // 名字后面挂了维度（`real a[];`）—— 那也是数组，与 `real[] a;` 同一件事
      let dims = 0;
      if (isList(start) && start.items.length > 2) {
        const dd = this.dimsDepth(start.items[2]);
        dims = dd === null ? 0 : dd;
      }
      const el = base === null ? null
        : (SCALARS.has(base) || base === 'pair' || base === 'triple' || this.records.has(base) ? base : null);
      let ty = el;
      let k = 0;
      while (ty !== null && k < arr + dims) { ty = `${ty}[]`; k++; }
      // `real f(real) = twice;`：形参表跟在名字后面，那是**函数值**类型 —— 不是 `real`。
      // 这一刀的 `(global …)` 只收标量/聚合，函数值走 `(let …)` 那条（与 typedef 拼的
      // 那一份同一条路），所以这里明确记成"这一刀的全局量收不下"。
      // 不记的话拿到的是 base（`real`），后面那句赋值就报"要 real，这里是 real(real)"。
      if (isList(start) && head(start) === 'fundecidstart') ty = null;
      const ok = ty !== null;
      const g = { sym: `asy__g${this.gdecls.length}_${nm}`, type: ty, at, ok };
      const list = this.globals.has(nm) ? this.globals.get(nm) : [];
      list.push(g);
      this.globals.set(nm, list);
      if (ok) this.gdecls.push(g);
    }
  }

  /**
   * 名字 `nm` 在**当前位置**看得见的那份文件级变量（没有就 null）。顺序解析：
   * 挑 `at <= this.at` 的最后一份 —— 与 visible()（函数候选）、recHere()（类型名）
   * 是同一条规矩的第四处。
   */
  gvarHere(nm) {
    const list = this.globals.get(nm);
    if (list === undefined) return null;
    let cur = null;
    for (const g of list) if (g.at <= this.at) cur = g;
    return cur;
  }

  /** 正在降级的这一句（`this.at`）声明的那份文件级变量。vardec 用它拿符号名。 */
  gvarAt(nm) {
    const list = this.globals.get(nm);
    if (list === undefined) return null;
    for (const g of list) if (g.at === this.at) return g;
    return null;
  }

  /** 名字对得上，但那份文件级变量声明在**后面**。asy 自己也拒，所以是 err 不是 nope。 */
  gvarLate(node, nm) {
    return this.err(node, `'${nm}' 在这里还不是一个变量 —— 文件级的 ${nm} 声明在后面，`
      + `而 asy 的名字解析是顺序的（那边报 "no matching variable of name '${nm}'"）`);
  }

  /** 第二遍：函数体。核心方言要求非 void 的函数每条路径都有 ret，asy 不要求 —— 差别见下。 */
  func(n) {
    const nm = isAtom(n.items[2]) ? n.items[2].value : null;
    // 文件级的 `T operator init()`（第二十二刀）不在 funcs 里 —— 它的候选表按记录名存
    // （见 oinitSig），所以这里按节点问一遍那张表。除此之外它就是个普通的 0 元函数。
    const oiList = this.oiByNode.get(n);
    // `operator cast` / `operator ecast`（第二十七刀）同理：候选按目标类型存，这里按节点问。
    const csList = this.castByNode.get(n);
    const list = oiList !== undefined ? oiList
      : (csList !== undefined ? csList
        : (nm === null || !this.funcs.has(nm) ? null : this.funcs.get(nm)));
    if (list === null) return null;
    // 这份声明对应哪个候选：按**节点**认，不按签名 —— 同签名被后面那份替换掉时，
    // 前面那份就没有候选了（asy 那边它也确实调不到），于是这里不发它。
    let d = null;
    for (const c of list) if (c.node === n) d = c;
    if (d === null) return null;
    const ps = this.formals(n.items[3]);
    if (ps === null) return null;
    this.push();
    for (const p of ps) this.declare(n, p.name, p.type);
    const body = this.body(n.items[4], d.ret);
    this.pop();
    if (body === null) return null;
    // 掉出函数尾巴：asy 是运行期报 "function did not return a value"，我们补一条零值 ret。
    // 这是**明写的**差别，不是漏的：核心方言的检查在编译期，而这条 ret 永远走不到才对。
    const last = body.length === 0 ? '' : body[body.length - 1];
    if (d.ret !== 'void' && !last.startsWith('(ret ')) {
      let zero = null;
      if (asyIsArr(d.ret)) zero = `(anew ${asyCore(d.ret)} (int 0))`;
      else if (this.isRec(d.ret)) zero = this.recInit(n, d.ret);
      else zero = ZERO.get(d.ret);
      if (zero === null) return null;
      body.push(`(ret ${zero})`);
    }
    const params = [];
    for (const p of ps) params.push(`(${p.name} ${asyCore(p.type)})`);
    const lines = [`  (fn ${d.sym} (${params.join(' ')}) ${asyCore(d.ret)}`];
    for (const s of body) lines.push(`    ${s}`);
    return `${lines.join('\n')})`;
  }

  /**
   * 声明遍：一个单元里的记录、模块声明、函数签名、文件级变量名（第二十五刀把它从 run()
   * 里分出来 —— 每个单元都要走一遍这个）。
   * 记录与模块声明在**同一遍**里按下标走：`import` 进来的 struct 要能当后面那些
   * struct 的字段类型，而 asy 的类型名是顺序解析的。
   */
  /**
   * asy 的 **C++ 内建面**（path / pen / guide / frame / transform 那一族类型，与
   * runpath.in / runpen.in / runpicture.in 里那些函数）在真 asy 里是运行时自带的，
   * 每个文件、每个模块里都看得见 —— 它不是 `base/plain.asy` 的一部分。
   *
   * 我们把它做成**一个模块**（`stage0/lib/asy/asy_builtins.asy`，名字从 opts.prelude 来），
   * 在每个单元的声明遍开头隐式 import 一次：
   *   - struct 只声明一份（核心方言的 class 名是全局唯一的，摊进每个单元会撞名）；
   *   - 类型名与函数通过 modMerge 进到这个单元里，可见位置是 0（比所有顶层项都早）；
   *   - 体只跑一遍（modLoad 缓存 + `ran` 那道闸）。
   * 于是 `base/*.asy` 那一堆**引真的那些**就够了 —— 我们不抄 plain.asy。
   */
  builtinsIn(u, off) {
    const nm = this.opts === null || this.opts.prelude === undefined ? null : this.opts.prelude;
    if (nm === null || nm === '' || u.key === nm) return;
    const keep = this.at;
    this.at = off;
    const b = this.modLoad(null, nm);
    if (b !== null) {
      this.modMerge(null, b, off, null);
      // 体在**这个单元的正文最前面**跑（bodyPass 开头那一句）。不能挂 callAt[off] ——
      // 那张表是"源码里 import 那一行"的位置，而 off 就是第一条顶层项的位置，
      // 挂上去会把用户的第一句吃掉。init 自己有 `ran` 那道闸，多调一次不会重跑。
      u.bi = b.init;
    }
    this.at = keep;
  }

  declPass(u) {
    const rs = u.rs;
    const off = this.atOff;
    this.builtinsIn(u, off);
    for (let i = 0; i < rs.length; i++) {
      const r = this.unwrapMod(rs[i]);
      if (!isList(r)) continue;
      this.at = off + i;
      if (head(r) === 'recorddec') this.recordDec(r, off + i);
      else if (head(r) === 'typedec' || head(r) === 'typedec-using') this.typeDec(r, off + i);
      else if (ASY_MODSTM.has(head(r))) this.modStmt(r, off + i);
    }
    for (let i = 0; i < rs.length; i++) {
      const r = this.unwrapMod(rs[i]);
      if (!isList(r)) continue;
      // 这一遍也要摆好 at：签名里的记录名按**这一句的位置**判可见（recHere）。
      this.at = off + i;
      if (head(r) === 'fundec') this.sig(r, off + i);
      else if (head(r) === 'vardec') this.globalNames(r, off + i);
    }
    // 重载的名字在这里定：核心方言没有重载，所以第 2 个及以后的候选要改名。
    // 第一个保留原名 —— 绝大多数函数不重载，输出的文本因此跟以前一样好读。
    // 数的只有**这个单元自己的**候选：import 进来的那些名字在它们自己的单元里早定好了。
    for (const list of this.funcs.values()) {
      let k = 0;
      for (const c of list) {
        if (c.unit !== u.id) continue;
        if (k > 0) c.sym = `${c.pfx}asy__ov${k}_${c.base}`;
        k++;
      }
    }
  }

  /** 一个单元的正文：方法体、文件级函数体，与"剩下那些语句"（模块是初始化函数，主文件是 main） */
  bodyPass(u, fns) {
    const off = this.atOff;
    for (const m of u.methodDecls) {
      const text = this.method(m.rec, m.cand, m.at);
      if (text !== null) fns.push(text);
    }
    // struct 体里 `autounravel` 的那些（第二十八刀）：它们就是文件级函数，只是写在体里
    for (const m of u.auFns) {
      this.at = m.at;
      const f = this.func(m.node);
      if (f !== null) fns.push(f);
    }
    for (let i = 0; i < u.rs.length; i++) {
      const r = this.unwrapMod(u.rs[i]);
      if (!isList(r) || head(r) !== 'fundec') continue;
      this.at = off + i;
      const f = this.func(r);
      if (f !== null) fns.push(f);
    }
    // 文件级那一层作用域：REPL 里要**跨批留住**（第 1 批的 `real[] xs` 第 2 批还看得见）。
    // 只有会话根有这个待遇：模块单元的文件级作用域随它自己那一遍结束。
    // 标量的文件级变量走的是另一条路（`(global …)`），这一层管的是数组/pair/记录那些。
    if (this.sessionRoot && u.id === 0) {
      if (this.fileScope === null) this.fileScope = new Map();
      this.scopes.push(this.fileScope);
    } else {
      this.push();
    }
    this.fileLevel = true;
    const main = [];
    // 隐式引进来的内建面（builtinsIn）：体在这个单元的最前面跑
    if (u.bi !== undefined && u.bi !== null) main.push(`(expr (call ${u.bi}))`);
    for (let i = 0; i < u.rs.length; i++) {
      const r = this.unwrapMod(u.rs[i]);
      this.at = off + i;
      // 模块声明（第二十五刀）：声明遍已经把名字并进来了，这里发的是**体在那一行跑**
      // 的那一下 —— 初始化函数的调用，位置就是源码里 import 的位置。
      const calls = u.callAt.get(off + i);
      if (calls !== undefined) {
        for (const c of calls) main.push(`(expr (call ${c}))`);
        continue;
      }
      if (!isList(r)) continue;
      if (head(r) === 'fundec') continue;
      if (head(r) === 'recorddec') continue;      // 声明遍收过了
      if (head(r) === 'typedec' || head(r) === 'typedec-using') continue;   // 同上（只往别名表里记一条）
      if (ASY_MODSTM.has(head(r))) continue;      // 同上（没做的那几种在那边报过了）
      const s = this.stmt(r, 'void');
      if (s === null) continue;
      for (const x of s) main.push(x);
    }
    this.fileLevel = false;
    this.pop();
    return main;
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
    this.declPass(root);
    // 正文：按加载顺序一个单元一遍（declPass 里的递归加载已经把 units 填全了）。
    // 方法体在每个单元里先发：它们只依赖记录声明，而文件级函数的正文可能调到方法。
    const fns = [];
    let main = [];
    for (const u of this.units) {
      if (u.id !== 0 && u.id < baseUnits) continue;   // 前面几批加载过的模块不重发
      const prev = this.unitIn(u);
      const stmts = this.bodyPass(u, fns);
      if (u.id === 0) main = stmts;
      else fns.push(this.initFn(u, stmts));
      this.unitOut(prev);
    }
    const out = ['(module'];
    // 记录按**声明顺序**发（字段里不许再有记录，所以这就是最终顺序）
    let ri = 0;
    for (const rec of this.records.values()) {
      if (ri++ < baseRecords) continue;
      const fs = [];
      for (const f of rec.fields) fs.push(`(${f.name} ${asyCore(f.type)})`);
      out.push(`  (class ${rec.name} ${fs.join(' ')})`);
    }
    // 模块跑过了没有（第二十五刀）：`import m; import m;` 只跑一遍体，量过
    for (const u of this.units) {
      if (u.id < baseUnits || u.ran === null) continue;
      out.push(`  (global ${u.ran} bool)`);
    }
    // 文件级变量（第二十四刀）：按声明顺序的一批 `(global …)`。零初始化，
    // 真正的初值是 `(main …)` 里那一句 `(set …)` —— 位置就是源码里的位置，
    // 所以「初值在那一行求」这条 asy 语义是照搬的，不是模拟的。
    for (let i = baseGdecls; i < this.gdecls.length; i++) {
      const g = this.gdecls[i];
      out.push(`  (global ${g.sym} ${asyCore(g.type)})`);
    }
    for (const [hnm, text] of HELPERS) {
      if (this.used.has(hnm) && !baseUsed.has(hnm)) out.push(text);
    }
    // 元素是记录的数组 helper：正文是降级过程中按同一个工厂生成的，顺序按第一次用到
    for (const [akey, text] of this.arrGen) {
      if (!baseArr.has(akey)) out.push(text);
    }
    for (const f of fns) out.push(f);
    // 默认实参的包装：正文是降级过程中生成的，所以只能在这里发（顺序按第一次用到）
    for (let i = baseWraps; i < this.wraps.length; i++) out.push(this.wraps[i]);
    const body = [];
    for (const s of main) body.push(`    ${s}`);
    out.push(`  (main${body.length === 0 ? '' : `\n${body.join('\n')}`}))`);
    // 下一批的顶层项从这一批之后接着数
    this.atOff = this.atOff + root.rs.length;
    return out.join('\n') + '\n';
  }

  /** 整个程序 -> 核心方言文本。函数提到模块层，主文件剩下的语句进 (main ...)。 */
  run(tree) {
    return this.chunk(tree);
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
export function lowerAsy(tree, diags, opts) {
  return new AsyLower(diags, opts).run(tree);
}

/** 重载候选表的浅拷贝：值是数组，所以每一组也要拷一份 */
function copyAsyFuncs(m) {
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
        funcs: copyAsyFuncs(u.funcs), globals: new Map(u.globals), recVis: new Map(u.recVis),
        mods: new Map(u.mods), oinits: new Map(u.oinits), oiByNode: new Map(u.oiByNode),
        casts: new Map(u.casts), castByNode: new Map(u.castByNode), at: u.at,
        tyAlias: new Map(u.tyAlias),
      },
      records: new Map(l.records), recInits: new Map(l.recInits), byKey: new Map(l.byKey),
      gdecls: [...l.gdecls], wraps: [...l.wraps], wrapNames: new Map(l.wrapNames),
      used: new Set(l.used), arrGen: new Map(l.arrGen),
      castNo: l.castNo, tmp: l.tmp, atOff: l.atOff,
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
    l.castNo = s.castNo;
    l.tmp = s.tmp;
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
