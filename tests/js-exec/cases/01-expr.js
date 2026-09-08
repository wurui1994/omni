// 表达式：字面量、算术、比较、模板串、三目、逻辑运算的"值是操作数"语义
const a = 7;
const b = 2.5;
console.log(String(a + b));
console.log(String(a - b));
console.log(String(a * b));
console.log(String(a / b));
console.log(String(a % 3));
console.log(String(-a));
console.log(String(1n + 2n));
console.log(String(1n << 62n));
console.log(String(~5n));
console.log(String(0xf0n & 0x3cn));
console.log(String(a < b));
console.log(String(a >= 7));
console.log(String("abc" < "abd"));
console.log(String(a === 7));
console.log(String(a !== 7));
console.log(String(null == undefined));
console.log(String(null === undefined));
console.log(`a=${a} b=${b} sum=${a + b}`);
console.log(String(a > b ? "big" : "small"));
console.log(String(0 || "fallback"));
console.log(String("keep" || "other"));
console.log(String(1 && "second"));
console.log(String(0 && "never"));
console.log(String(null ?? "dflt"));
console.log(String(false ?? "not used"));
console.log(String(!a));
console.log(String(typeof a));
console.log(String(typeof "s"));
console.log(String(typeof 1n));
console.log(String(typeof undefined));
console.log(String(Math.floor(b)));
console.log(String(Math.max(a, 3)));
console.log(String(Math.abs(-b)));
// fround 是为 MIR 的 T_F32 长出来的那个闭合 ABI 口子（ADR-0017 第一刀）：
// 单精度回绕必须真的发生，否则下面三行都会退化成恒等。
console.log(String(Math.fround(0.1 + 0.2)));
console.log(String(Math.fround(1 / 3)));
console.log(String(Math.fround(16777217)));
console.log(String(Math.fround(-0.5)));
console.log(String(Number("42") + 1));
console.log(String(parseInt("ff", 16)));
console.log(String(String(12.5)));
console.log(String((1 / 3).toPrecision(17)));
console.log(String((255).toString(16)));

// 实参的求值次序：会抛的 op（JSON.stringify）会被提到语句前先算，**它前面那几格也得
// 跟着提** —— 不然第二格先跑、第一格后跑。量出来的静默分叉，两条腿一起错。
let ox = 0;
console.log(ox + 1, JSON.stringify(ox = 5), ox + 1);
let oy = 0;
console.log(`${oy + 1}`, JSON.stringify(oy = 7), oy);

// 混着比（规范 7.2.13）：只有两边都是串才按串比，否则两边都 ToNumber。
// 从前这一族是当场报错 —— 而 qjs 与 node 都照上面那条给答案。
console.log("2" > "10", 2 > 10, "2" > 1, "10" < 9, "" < 1);
console.log(null >= 0, null > 0, undefined > 0, true > 0, false >= 0);
console.log("abc" < 1, 1 < "abc", "3" >= 3, "3" <= 3);

// Object.is（SameValue）：与 === 只差 NaN 与 ±0 那两格
console.log(Object.is(NaN, NaN), Object.is(-0, 0), Object.is(0, -0), Object.is(-0, -0));
console.log(Object.is(1, 1), Object.is("a", "a"), Object.is(null, null), Object.is(1, "1"));
console.log(Object.is(undefined, undefined), Object.is(NaN, 0 / 0), NaN === NaN, -0 === 0);
// bigint 字面量后面的 / 是除号，不是正则的开头（词法那一格的歧义）。
// 值用模板串印：console.log 直接印 bigint 时 node 会带 n，而这个值域里 bigint 与方言的
// int64 是同一个标签，C 那条腿分不开（见 prelude 的 $js_disp）。
console.log(`${5n / 2n} ${-7n % 3n} ${7n / 2n} ${10n / 5n}`);
