// 压 omni_eq_string 的短键快路：长度 0~12、只差最后一个字节、非 ASCII、同前缀
const o = {};
const names = ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef', 'abcdefg', 'abcdefgh',
  'abcdefghi', 'abcdefghij', 'abcdefghijk', 'abcdefghijkl',
  'x', 'y', 'ax', 'ay', 'abcdefgH', 'abcdefgi', '键', '键值', 'a键'];
for (let i = 0; i < names.length; i++) o[names[i]] = i;
const out = [];
for (const n of names) out.push(n + '=' + o[n]);
for (const n of ['abcdefgj', 'abcdefghz', 'b', 'az', '键x']) out.push(n + '=' + String(o[n]));
out.push('keys=' + Object.keys(o).length);
out.push('has=' + ('abcdefgh' in o) + ',' + ('abcdefgz' in o));
delete o.abcd;
out.push('afterDel=' + String(o.abcd) + ',' + Object.keys(o).length);
console.log(out.join('|'));
