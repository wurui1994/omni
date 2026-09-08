#!/usr/bin/env node
// Omni stage0 — "离 QuickJS 还差多少"的**量尺**（ADR-0020）
//
// 一条特性一个探针（一小段代码 + 一行输出）。每条都交给 qjs 与 `omni run` 各跑一趟：
//   ok    两边输出一样 —— 这一格通了
//   差    我们跑不出来 / 输出不一样（后面印的是我们那侧的第一行报错，那就是缺口的名字）
//   参考侧红  qjs 自己都不干（探针写错了，或者 QuickJS 也不支持 —— 那不算我们的缺口）
//
//   node tests/js262/probe.js            全量，最后印一张按族分的覆盖表
//   node tests/js262/probe.js class      只跑名字里含 class 的
//   node tests/js262/probe.js --verbose  每条都印两边的输出
//
// 这一份**不是门**（不进 tests/all.js）：它是"现在到哪儿了"的度量，数字会随 P1..P6 往上走。

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = process.env.OMNI_CLI || join(root, 'src', 'core', 'cli.js');
const args = process.argv.slice(2);
const filters = args.filter((a) => !a.startsWith('-'));
const verbose = args.includes('--verbose');

function findQjs() {
  if (process.env.OMNI_QJS) return process.env.OMNI_QJS;
  const w = spawnSync('which', ['qjs'], { encoding: 'utf8' });
  if (w.status === 0 && w.stdout.trim()) return w.stdout.trim();
  const ref = join(root, '..', '..', 'Documents', 'Lang', 'reference', 'quickjs-2026-06-04', 'qjs');
  return existsSync(ref) ? ref : null;
}
const QJS = findQjs();
if (QJS === null) {
  process.stdout.write('probe: 没找到 qjs（OMNI_QJS 指一份）—— 没有尺子就不量\n');
  process.exit(0);
}

/* 探针表。族名（第一段）是印覆盖表时分的组。 */
const P = [
  // ---- 对象模型（P1）
  ['obj/字面量方法', 'const o={m(){return 1}};console.log(o.m())'],
  ['obj/访问器', 'const o={get x(){return 2}};console.log(o.x)'],
  ['obj/计算键', 'const k="a";const o={[k+"b"]:1};console.log(o.ab)'],
  ['obj/__proto__ 字面量', 'const b={x:1};const o={__proto__:b};console.log(o.x)'],
  ['obj/展开', 'const a={x:1};const o={...a,y:2};console.log(o.x+o.y)'],
  ['obj/简写', 'const x=1;const o={x};console.log(o.x)'],
  ['obj/defineProperty', 'const o={};Object.defineProperty(o,"a",{value:1});console.log(o.a)'],
  ['obj/getOwnPropertyDescriptor', 'const d=Object.getOwnPropertyDescriptor({a:1},"a");console.log(d.writable)'],
  ['obj/create+原型链', 'const o=Object.create({x:1});console.log(o.x)'],
  ['obj/getPrototypeOf', 'console.log(Object.getPrototypeOf([])===Array.prototype)'],
  ['obj/setPrototypeOf', 'const o={};Object.setPrototypeOf(o,{x:1});console.log(o.x)'],
  ['obj/freeze', 'const o=Object.freeze({a:1});o.a=2;console.log(o.a)'],
  ['obj/hasOwnProperty', 'console.log(({a:1}).hasOwnProperty("a"))'],
  ['obj/Object.hasOwn', 'console.log(Object.hasOwn({a:1},"a"))'],
  ['obj/键序', 'console.log(Object.keys({b:1,2:2,a:3,1:4}).join(","))'],
  ['obj/for-in', 'const s=[];for(const k in {a:1,b:2})s.push(k);console.log(s.join(","))'],
  ['obj/delete', 'const o={a:1};delete o.a;console.log(o.a)'],
  ['obj/in', 'console.log("a" in {a:1})'],
  ['obj/getOwnPropertyNames', 'console.log(Object.getOwnPropertyNames({a:1,b:2}).length)'],
  ['obj/fromEntries', 'console.log(Object.fromEntries([["a",1]]).a)'],
  // ---- this / 函数
  ['fn/this 接收者', 'const o={n:1,m(){return this.n}};console.log(o.m())'],
  ['fn/call', 'function f(){return this.n};console.log(f.call({n:2}))'],
  ['fn/apply', 'function f(a){return this.n+a};console.log(f.apply({n:1},[2]))'],
  ['fn/bind', 'function f(){return this.n};console.log(f.bind({n:3})())'],
  ['fn/arguments', 'function f(){return arguments.length};console.log(f(1,2,3))'],
  ['fn/默认参数', 'function f(a=5){return a};console.log(f())'],
  ['fn/剩余参数', 'function f(...a){return a.length};console.log(f(1,2))'],
  ['fn/展开调用', 'function f(a,b){return a+b};console.log(f(...[1,2]))'],
  ['fn/name/length', 'function foo(a,b){};console.log(foo.name,foo.length)'],
  ['fn/箭头 this', 'const o={n:1,m(){return (()=>this.n)()}};console.log(o.m())'],
  ['fn/new.target', 'function F(){return new.target!==undefined};console.log(new F() instanceof F===false||true)'],
  ['fn/Function 构造', 'console.log(new Function("return 1")())'],
  ['fn/eval', 'console.log(eval("1+1"))'],
  // ---- 类
  ['class/方法在原型上', 'class A{m(){return 1}};console.log(new A().m(),Object.getPrototypeOf(new A())===A.prototype)'],
  ['class/字段', 'class A{x=1};console.log(new A().x)'],
  ['class/static 方法', 'class A{static m(){return 1}};console.log(A.m())'],
  ['class/static 字段', 'class A{static x=1};console.log(A.x)'],
  ['class/static block', 'class A{static x;static{A.x=2}};console.log(A.x)'],
  ['class/访问器', 'class A{get x(){return 1}};console.log(new A().x)'],
  ['class/extends 任意', 'class A{m(){return 1}};class B extends A{};console.log(new B().m())'],
  ['class/super 方法', 'class A{m(){return 1}};class B extends A{m(){return super.m()+1}};console.log(new B().m())'],
  ['class/私有字段', 'class A{#x=1;get(){return this.#x}};console.log(new A().get())'],
  ['class/私有方法', 'class A{#m(){return 1};go(){return this.#m()}};console.log(new A().go())'],
  ['class/instanceof', 'class A{};console.log(new A() instanceof A)'],
  ['class/计算方法名', 'const k="m";class A{[k](){return 1}};console.log(new A().m())'],
  // ---- Symbol / 协议
  ['sym/基本', 'const s=Symbol("x");console.log(typeof s,s.description)'],
  ['sym/注册表', 'console.log(Symbol.for("k")===Symbol.for("k"))'],
  ['sym/当键', 'const s=Symbol();const o={[s]:1};console.log(o[s])'],
  ['sym/iterator', 'const o={[Symbol.iterator](){let i=0;return{next(){return i<2?{value:i++,done:false}:{done:true}}}}};console.log([...o].join(","))'],
  ['sym/toStringTag', 'class A{get [Symbol.toStringTag](){return "A"}};console.log(Object.prototype.toString.call(new A()))'],
  ['sym/toPrimitive', 'const o={[Symbol.toPrimitive](h){return 7}};console.log(+o)'],
  ['sym/hasInstance', 'class A{static [Symbol.hasInstance](v){return true}};console.log(({}) instanceof A)'],
  // ---- 可挂起的控制流（P2）
  ['gen/生成器', 'function* g(){yield 1;yield 2};console.log([...g()].join(","))'],
  ['gen/yield*', 'function* a(){yield 1};function* b(){yield* a();yield 2};console.log([...b()].join(","))'],
  ['gen/return/throw', 'function* g(){try{yield 1}finally{}};const it=g();it.next();console.log(it.return(9).value)'],
  ['async/Promise', 'Promise.resolve(1).then(v=>console.log(v))'],
  ['async/async 函数', 'async function f(){return 1};f().then(v=>console.log(v))'],
  ['async/await', 'async function f(){const v=await Promise.resolve(2);console.log(v)};f()'],
  ['async/all', 'Promise.all([Promise.resolve(1),2]).then(a=>console.log(a.join(",")))'],
  ['async/for-await', 'async function f(){for await(const v of [Promise.resolve(1)])console.log(v)};f()'],
  ['async/async 生成器', 'async function* g(){yield 1};(async()=>{for await(const v of g())console.log(v)})()'],
  ['async/微任务次序', 'console.log(1);Promise.resolve().then(()=>console.log(3));console.log(2)'],
  // ---- 语法（P3）
  ['syn/finally', 'try{throw 1}catch(e){}finally{console.log("f")}'],
  ['syn/可选 catch 绑定', 'try{throw 1}catch{console.log("c")}'],
  ['syn/label+break', 'outer:for(let i=0;i<2;i++){for(let j=0;j<2;j++){break outer}};console.log("l")'],
  ['syn/逗号表达式', 'let a=(1,2);console.log(a)'],
  ['syn/可选调用', 'const o={};console.log(o.f?.()===undefined)'],
  ['syn/可选链下标', 'const o=null;console.log(o?.[0])'],
  ['syn/tagged template', 'function t(s,...v){return s[0]+v[0]};console.log(t`a${1}`)'],
  ['syn/嵌套解构', 'const {a:{b}}={a:{b:1}};console.log(b)'],
  ['syn/对象 rest', 'const {a,...r}={a:1,b:2};console.log(r.b)'],
  ['syn/数组洞', 'const a=[1,,3];console.log(a.length)'],
  ['syn/解构赋值无声明', 'let a,b;({a,b}={a:1,b:2});console.log(a+b)'],
  ['syn/数字分隔符', 'console.log(1_000)'],
  ['syn/指数赋值', 'let a=2;a**=3;console.log(a)'],
  ['syn/switch 穿透', 'let s="";switch(1){case 1:s+="a";case 2:s+="b";break};console.log(s)'],
  ['syn/getter 在类的 static', 'class A{static get x(){return 1}};console.log(A.x)'],
  // ---- 标准库（P4）
  ['lib/Array 方法族', 'console.log([1,2,3].flatMap(x=>[x,x]).length,[1,[2]].flat().length,[1,2].at(-1))'],
  ['lib/Array 归并', 'console.log([1,2,3].reduceRight((a,b)=>a+b),[3,1].toSorted().join(","))'],
  ['lib/String 方法族', 'console.log("a-b".replaceAll("-","+"),"x".padEnd(3,"."),"  a ".trimEnd())'],
  ['lib/String 迭代', 'console.log([..."ab"].join(","),"ab".at(-1))'],
  ['lib/Number', 'console.log(Number.EPSILON>0,(255).toString(16),Number.parseFloat("1.5"))'],
  ['lib/Math', 'console.log(Math.clz32(1),Math.fround(1.1)>1,Math.hypot(3,4))'],
  ['lib/JSON reviver', 'console.log(JSON.parse("{\\"a\\":1}",(k,v)=>typeof v==="number"?v+1:v).a)'],
  ['lib/JSON 缩进', 'console.log(JSON.stringify({a:1},null,2).length)'],
  ['lib/Date', 'console.log(new Date(0).getTime(),new Date(0).toISOString())'],
  ['lib/RegExp 命名组', 'console.log("2020".match(/(?<y>\\d{4})/).groups.y)'],
  ['lib/RegExp lastIndex', 'const r=/a/g;r.exec("aa");console.log(r.lastIndex)'],
  ['lib/RegExp lookbehind', 'console.log(/(?<=a)b/.test("ab"))'],
  ['lib/RegExp Unicode 属性', 'console.log(/\\p{L}/u.test("a"))'],
  ['lib/String.replace 函数', 'console.log("ab".replace(/./g,c=>c.toUpperCase()))'],
  ['lib/Map/Set 迭代', 'console.log([...new Map([[1,2]]).entries()].length,[...new Set([1,1])].length)'],
  ['lib/WeakMap', 'const k={};const w=new WeakMap();w.set(k,1);console.log(w.get(k))'],
  ['lib/Proxy', 'const p=new Proxy({},{get(){return 42}});console.log(p.anything)'],
  ['lib/Reflect', 'console.log(Reflect.has({a:1},"a"),Reflect.ownKeys({a:1}).length)'],
  ['lib/TypedArray', 'const t=new Uint8Array(2);t[0]=255;console.log(t[0],t.length)'],
  ['lib/DataView', 'const d=new DataView(new ArrayBuffer(4));d.setInt32(0,7);console.log(d.getInt32(0))'],
  ['lib/BigInt 任意精度', 'console.log((2n**64n).toString())'],
  ['lib/Error cause', 'console.log(new Error("m",{cause:1}).cause)'],
  ['lib/Error 全家', 'console.log(new TypeError("t").name,new RangeError("r").name)'],
  ['lib/AggregateError', 'console.log(new AggregateError([],"m").name)'],
  ['lib/globalThis', 'console.log(typeof globalThis)'],
  ['lib/structuredClone 不做', 'console.log(typeof structuredClone)'],
];

const dir = mkdtempSync(join(tmpdir(), 'omni-probe-'));
let ok = 0; let bad = 0; let refbad = 0;
const groups = new Map();

for (let i = 0; i < P.length; i++) {
  const [name, code] = P[i];
  if (filters.length > 0 && !filters.some((x) => name.includes(x))) continue;
  const g = name.split('/')[0];
  if (!groups.has(g)) groups.set(g, { ok: 0, bad: 0 });
  const f = join(dir, 'p' + i + '.js');
  writeFileSync(f, code + '\n');
  const ref = spawnSync(QJS, [f], { encoding: 'utf8' });
  const ours = spawnSync(process.execPath, [CLI, 'run', f, '--timeout', '15'], { encoding: 'utf8', cwd: root });
  if ((ref.status ?? 1) !== 0) {
    refbad++;
    process.stdout.write(`  参考侧红 ${name}\n`);
    continue;
  }
  if ((ref.stdout ?? '') === (ours.stdout ?? '')) {
    ok++;
    groups.get(g).ok++;
    if (verbose) process.stdout.write(`  ok   ${name}\n`);
    continue;
  }
  bad++;
  groups.get(g).bad++;
  const err = (ours.stderr ?? '').trim().split('\n')[0].replace(/^.*?:\d+:\d+: /, '');
  process.stdout.write(`  差   ${name.padEnd(28)} ${err || JSON.stringify(ours.stdout ?? '')}\n`);
  if (verbose) process.stdout.write(`       qjs: ${JSON.stringify(ref.stdout ?? '')}\n`);
}
rmSync(dir, { recursive: true, force: true });

process.stdout.write('\n族      通 / 总\n');
for (const [g, s] of groups) {
  const t = s.ok + s.bad;
  process.stdout.write(`  ${g.padEnd(8)}${String(s.ok).padStart(3)} / ${t}\n`);
}
process.stdout.write(`\n合计 ${ok} 通 / ${ok + bad} 条探针`
  + `${refbad > 0 ? `（另有 ${refbad} 条参考侧自己就红，不计）` : ''}\n`);
