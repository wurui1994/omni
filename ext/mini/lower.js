// ext/mini/lower.js —— mini 的降级：每个节点一小步，落到核心方言
//
// 与 `ext/lua/lower.js` 是同一个形状（每节点一小步 + 记账），但短得多 —— 因为 mini 的
// 语义就是核心方言的语义（数是 real、比较出 bool），没有 Lua 那些要还的账。

const T = { real: 'real', bool: 'bool', string: 'string' };
const BIN = {
  '+': T.real, '-': T.real, '*': T.real, '/': T.real,
  '<': T.bool, '>': T.bool, '<=': T.bool, '>=': T.bool, '==': T.bool, '!=': T.bool,
  '&&': T.bool, '||': T.bool,
};

class MiniError extends Error {}
const no = (why) => { throw new MiniError(why); };

const real = (t) => `(real ${Number.isInteger(Number(t)) ? `${Number(t)}.0` : String(Number(t))})`;

function exp(n, sc) {
  switch (n.kind) {
    case 'number': return { sx: real(n.value), type: T.real };
    case 'string': return { sx: `(str ${JSON.stringify(n.value)})`, type: T.string };
    case 'paren': return exp(n.inner, sc);
    case 'name': {
      const t = sc.get(n.value);
      if (t === undefined) no(`名字 '${n.value}' 没声明过`);
      return { sx: `(var ${n.value})`, type: t };
    }
    case 'prefix': {
      const a = exp(n.a, sc);
      if (n.op === '-' && a.type !== T.real) no('一元 `-` 要一个数');
      if (n.op === '!' && a.type !== T.bool) no('`!` 要一个真假值');
      return { sx: `(un "${n.op === '!' ? '!' : '-'}" ${a.sx})`, type: a.type };
    }
    case 'binop': {
      const k = BIN[n.op];
      if (k === undefined) no(`算符 '${n.op}' 还没降`);
      const a = exp(n.a, sc);
      const b = exp(n.b, sc);
      if (a.type !== b.type) no(`'${n.op}' 两边类型不一样`);
      return { sx: `(bin "${n.op}" ${a.sx} ${b.sx})`, type: k };
    }
    default: return no(`表达式 '${n.kind}' 还没降`);
  }
}

function stats(xs, sc) {
  const out = [];
  for (const s of xs ?? []) {
    switch (s.kind) {
      case 'let': {
        const v = exp(s.init, sc);
        sc.set(s.names[0], v.type);
        out.push(`(let ${s.names[0]} ${v.type} ${v.sx})`);
        break;
      }
      case 'assign': {
        if (s.targets.length !== 1 || s.values.length !== 1) no('一次只赋一格');
        const t = sc.get(s.targets[0].value);
        if (t === undefined) no(`名字 '${s.targets[0].value}' 没声明过`);
        const v = exp(s.values[0], sc);
        if (v.type !== t) no('赋的类型与声明的不一样');
        out.push(`(set ${s.targets[0].value} ${v.sx})`);
        break;
      }
      case 'print': out.push(`(print ${exp(s.v, sc).sx})`); break;
      case 'if': {
        const c = exp(s.cond, sc);
        if (c.type !== T.bool) no('`if` 的条件要真假值');
        const th = `(do ${stats(s.then.stats, sc).join(' ')})`;
        const el = s.else === undefined ? '' : ` (do ${stats(s.else.stats, sc).join(' ')})`;
        out.push(`(if ${c.sx} ${th}${el})`);
        break;
      }
      case 'while': {
        const c = exp(s.cond, sc);
        if (c.type !== T.bool) no('`while` 的条件要真假值');
        out.push(`(while ${c.sx} (do ${stats(s.body.stats, sc).join(' ')}))`);
        break;
      }
      case 'break': out.push('(brk)'); break;
      default: no(`语句 '${s.kind}' 还没降`);
    }
  }
  return out;
}

/** 一份 mini -> 核心方言的文本。 */
export function lowerMini(ast) {
  const body = stats(ast.stats, new Map());
  return `(module\n  (main\n${body.map((x) => `    ${x}`).join('\n')}))\n`;
}

export { MiniError };
