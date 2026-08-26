/**
 * UTF-8 编码 —— 两个后端共用的一份。
 *
 * 原本长在 `backend-c/emit.js` 里。LLVM 后端第二阶段也要它（字符串常量要发成
 * 一段 `[N x i8]` 全局），而这种东西复制第二份的下场是可预见的：某天一边改了
 * 落单代理项的处理，另一边没改，症状是「同一份源码在 C 与 LLVM 两条腿上印出不同的字节」，
 * 而那类分叉正是多方逐字节比对要抓的东西。所以提出来共用。
 *
 * 不用 Buffer / TextEncoder：那是宿主的东西，而这个文件自己也要被降级
 * （封闭 ABI，ADR-0011 决策 2）。全程只用加法、乘法、取模 —— 位运算在这个值域里
 * 只对 int 成立，而这里的一切都是 real。
 * 落单的代理项按 node 的 Buffer 一样换成 U+FFFD，否则两代生成的产物会不一样。
 */
export function utf8Bytes(s) {
  const out = [];
  const push3 = (c) => {
    out.push(224 + Math.floor(c / 4096));
    out.push(128 + (Math.floor(c / 64) % 64));
    out.push(128 + (c % 64));
  };
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) { push3(0xfffd); continue; }   // 落单的低位代理项
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) { push3(0xfffd); continue; }   // 落单的高位代理项
      c = 0x10000 + (c - 0xd800) * 1024 + (d - 0xdc00);
      i++;
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(192 + Math.floor(c / 64)); out.push(128 + (c % 64)); }
    else if (c < 0x10000) push3(c);
    else {
      out.push(240 + Math.floor(c / 262144));
      out.push(128 + (Math.floor(c / 4096) % 64));
      out.push(128 + (Math.floor(c / 64) % 64));
      out.push(128 + (c % 64));
    }
  }
  return out;
}
