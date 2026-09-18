// src/core/graph/js_rt.js —— **图那条 js 腿的运行时（文本）+ 自足产物的外壳**
//
// 为什么单独一份文本：`contract.js` 的 js 后端出的是一格**函数表达式**，要外面喂十五个钩子
// （`__out` / `__show` / `__truthy` / …）。在本进程里跑没问题（`evalJs` 之后把
// `eval.js` 里那几个函数传进去），可 `build` 要落的是**一份 node 直接跑得起来的脚本** ——
// 那时钩子得跟着产物走。这一份就是跟着走的那一份。
//
// ## 它与 `eval.js` 那几个函数是**两个消费者**，不是一份知识抄两遍吗？
//
// 是两个消费者：解释器那侧要的是**代码**（还带 `Values` / `Closure` 两个类），
// 产物这侧要的是**文本**（产物里没有那两个类 —— js 后端把多值落成 `{__vals: […]}`、
// 把函数落成真的 JS 函数）。所以两侧的形状本来就不同，硬合成一份会给解释器加一层注入。
//
// 分叉的风险不靠"小心"防，靠**判据钉住**：`tests/graph/js-artifact.js` 拿三门语言的
// 全部例子，逐份比「产物跑出来的 stdout」与「`omni run --engine graph --backend js`
// 跑出来的 stdout」——一格不一样就红。规则改了只改一处、另一处忘了改，那条判据当场抓住。
//
// 印法那几条（整数印整数、列表印 `[a, b]`、记录印 `{k = v}`、map 明着报"格式还没定"）
// 的**出处**都在 `eval.js` 的 `showValue` 上，这儿是它的文本版；改那边就要改这边。

/**
 * 十五个钩子的文本。产物里原样摊在最前面。
 *
 * `__out` 是**一格有 push 的东西**（不是数组）：`prims.js` 里 print 那一行发的是
 * `__out.push(…)`，所以产物这侧只要接住 push 就行 —— 一行一句，直接写出去。
 */
export const GRAPH_JS_RT = String.raw`
/* 一行输出就写一行。有 process 的时候走 stdout（不多一个换行、不做格式化），
   别的宿主退回 console.log —— 那是"能跑起来"与"字节对得上"之间唯一的取舍点。 */
const __out = {
  push: (s) => {
    if (typeof process !== 'undefined' && process.stdout !== undefined) process.stdout.write(s + '\n');
    else console.log(s);
  },
};

const __truthy = (v) => !(v === false || v === null || v === undefined);

/* 印法：与 eval.js 的 showValue 逐条对着（多值 -> 空格分开、列表 -> [a, b]、
   记录 -> {k = v}、函数 -> <fn 名>、map -> 明着报）。 */
function __show(v) {
  if (v !== null && typeof v === 'object' && Array.isArray(v.__vals)) return v.__vals.map(__show).join(' ');
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'function') return '<fn ' + (v.name === '' ? '?' : v.name) + '>';
  if (Array.isArray(v)) return '[' + v.map(__show).join(', ') + ']';
  if (v instanceof Map) {
    throw new Error('print: 打印一格 map 的格式还没定（四门语言各不相同）—— 要印就自己遍历');
  }
  if (typeof v === 'object') {
    return '{' + Object.entries(v).map(([k, x]) => k + ' = ' + __show(x)).join(', ') + '}';
  }
  return String(v);
}

const __pick = (v, i) => {
  if (v !== null && typeof v === 'object' && Array.isArray(v.__vals)) return v.__vals[i] ?? null;
  return i === 0 ? v : null;
};

/* 记录 = 普通对象、列表 = 普通数组（与解释器**表示相同**，不是各落一种再对齐）。
   缺字段 / 越界一律当场报：那是图这一层最保守的答案，"给零值还是给 nil"归语言。 */
const __field = (obj, name) => {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    throw new Error('field-get: 不是一格记录（.' + name + '）');
  }
  if (!(name in obj)) throw new Error('field-get: 没有这一格字段：.' + name);
  return obj[name];
};

const __setField = (obj, name, value) => {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    throw new Error('field-set: 不是一格记录（.' + name + '）');
  }
  obj[name] = value;
  return null;
};

const __index = (obj, i) => {
  if (!Array.isArray(obj)) throw new Error('index-get: 不是一格列表（[' + __show(i) + ']）');
  if (typeof i !== 'number' || i < 0 || i >= obj.length) {
    throw new Error('index-get: 下标越界 [' + __show(i) + ']（长度 ' + obj.length + '）');
  }
  return obj[i];
};

const __setIndex = (obj, i, value) => {
  if (!Array.isArray(obj)) throw new Error('index-set: 不是一格列表（[' + __show(i) + ']）');
  if (typeof i !== 'number' || i < 0 || i >= obj.length) {
    throw new Error('index-set: 下标越界 [' + __show(i) + ']（长度 ' + obj.length + '）');
  }
  obj[i] = value;
  return null;
};

/* map：宿主的 Map，键按值比。**缺键报错**（不给零值、不给 nil）—— 九门语言答案不同。 */
const __mapNew = (keys, vals) => {
  const m = new Map();
  (keys ?? []).forEach((k, i) => m.set(k, (vals ?? [])[i] ?? null));
  return m;
};

const __asMap = (obj, who) => {
  if (!(obj instanceof Map)) throw new Error(who + ': 不是一格 map');
  return obj;
};

const __mapGet = (obj, k) => {
  const m = __asMap(obj, 'map-get');
  if (!m.has(k)) {
    throw new Error('map-get: 没有这一格键 ' + __show(k) + '（缺键的默认值归语言，用 map-has 自己写）');
  }
  return m.get(k);
};

const __mapSet = (obj, k, value) => { __asMap(obj, 'map-set').set(k, value); return null; };
const __mapHas = (obj, k) => __asMap(obj, 'map-has').has(k);
/* 键按**插入序**（宿主的 Map 天然如此）。拷一份是明说的语义 —— 见 nodes.js 的 map-keys。 */
const __mapKeys = (obj) => [...__asMap(obj, 'map-keys').keys()];

/* 切片：上界不含、0 起，越界报。转换：int 是**截断**（向零），别的答案归语言的映射。 */
const __slice = (obj, from, to) => {
  if (!Array.isArray(obj)) throw new Error('slice: 不是一格列表');
  const a = from === undefined || from === null ? 0 : Number(from);
  const b = to === undefined || to === null ? obj.length : Number(to);
  if (a < 0 || b > obj.length || a > b) throw new Error('slice: 范围越界 [' + a + ', ' + b + ')');
  return obj.slice(a, b);
};

const __conv = (v, to) => {
  if (to === 'int') return Math.trunc(Number(v));
  if (to === 'float') return Number(v);
  if (to === 'str') return __show(v);
  if (to === 'bool') return __truthy(v);
  throw new Error('conv: 还没接这个目标：' + to);
};

/* 断言：不成立就把那句话印在同一格输出上、然后整个程序停下来。
   **退出码不在图上**，所以这一侧落成"非零退出" —— 那是这门宿主的样子
   （有 process 就 exit(1)，没有就抛）。判据比的是那句话，不是退出码。 */
const __assert = (cond, msg) => {
  if (__truthy(cond)) return;
  __out.push(msg === undefined || msg === null ? 'assert failed' : 'assert failed: ' + __show(msg));
  if (typeof process !== 'undefined' && process.exit !== undefined) process.exit(1);
  throw new Error('assert failed');
};
`;

/**
 * 一份**自足的 ESM**：钩子 + 那格函数表达式 + 一句调用。node 直接 `node x.mjs` 跑得起来。
 *
 * 形参的**顺序**与 `contract.js` 里 `jsLower` 发的那一行一字不差（十五格）——
 * 那一行是产物与运行时之间唯一的接口，错一格就是错位传参，而错位传参不一定当场炸。
 * 所以这两处必须一起改；判据是 `tests/graph/js-artifact.js`（产物与本进程那条腿逐行比）。
 *
 * @param source `jsLower` 出的那格函数表达式（`(__out, __show, …) => { … }`）
 * @param note 头一行注释里写清"这是谁生成的"（源文件 + 语言）
 */
export function jsModuleText(source, note) {
  return `// ${note}\n// 自足产物：node 直接跑（钩子摊在下面，见 src/core/graph/js_rt.js）\n`
    + `${GRAPH_JS_RT}\nconst __main = ${source};\n`
    + '__main(__out, __show, __truthy, __pick, __field, __setField, __index, __setIndex,\n'
    + '  __conv, __slice, __mapNew, __mapGet, __mapSet, __mapHas, __mapKeys, __assert);\n';
}
