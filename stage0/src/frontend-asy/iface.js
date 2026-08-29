// **库的接口索引**（第七十八刀）：一个库编过一次之后，别的程序要用它只需要「名字 + 签名」，
// 不需要它的源码，也不需要它的树。
//
// 量出来的账（`access graph;` 之后那 17 个单元）：
//   - 候选表里那 14234 个 `node`（声明的整棵子树）打包起来 **61MB**，而编另一个例子时
//     它们一共只被摸 2–8 次 —— 全都在 calls.js:1993 那一句 `isList(d.node)`：取被调方的
//     体给"默认值里的匿名函数抓外层名字"判一下。
//   - 真正每趟都要读的只有**默认实参的表达式**：6913 个，打包一共 441KB。
//   - `rec.stmts` 只被读 `.length`（struct 体的语句总共 44 条）。
// 所以接口 = 一张平的表 + 那 441KB 表达式碎片。声明遍那 367ms（tri.asy 一共 4 行代码）
// 因此可以整段不跑 —— 这一份就是那张表的写与读。
//
// 树的碎片怎么存：`pack`/`unpack` 从外面传进来（cli.js 里那对 astPack/astUnpack），
// 这一份不认识文件系统，也不认识缓存目录。
//
// 单元号（`unit`）不能直接存：换个入口跑时单元的建立顺序不一样，号也不一样。存的是
// **单元的身份**（`key`，`plain` / `collections.iter(T=int)` 这种），读回来再按 key 认。

/** 一格 AST 存成碎片下标（null 就是没有）。同一棵子树只存一份；打包失败那一格记 null，
 *  整份接口于是作废（asyIfaceDump 末尾那一扫），下一趟照旧从源码走。 */
function fragOf(x, frags, memo, pack) {
  if (x === null || x === undefined) return -1;
  const had = memo.get(x);
  if (had !== undefined) return had;
  const i = frags.length;
  frags.push(pack(x));
  memo.set(x, i);
  return i;
}

/** 形参那一格：名字、类型、几个记号，加默认值那棵子树的碎片下标 */
function dumpPs(ps, frags, memo, pack) {
  const out = [];
  for (const p of ps === undefined || ps === null ? [] : ps) {
    out.push({
      n: p.name, t: p.type, e: p.exp === true, k: p.kw === true,
      r: p.rest === true, s: p.src === undefined ? null : p.src,
      d: fragOf(p.def, frags, memo, pack),
    });
  }
  return out;
}

/** 一个函数候选。`u` 记的是**来源单元的 key**，不是单元号。 */
function dumpCand(c, keyOf, frags, memo, pack) {
  return {
    ret: c.ret,
    ps: dumpPs(c.ps, frags, memo, pack),
    sym: c.sym,
    base: c.base === undefined ? null : c.base,
    pfx: c.pfx,
    u: keyOf(c.unit),
    at: c.at,
    dat: c.dat === undefined ? c.at : c.dat,
    mat: c.mat === undefined ? null : c.mat,
    // 方法/构造那两格：`rec` 是记录对象，存它的名字，读回来再接上
    rec: c.rec === undefined || c.rec === null ? null : c.rec.name,
    ctor: c.ctor === true,
    dup: c.dup === true,
    ap: c.ap === true,
    abi: c.abi === undefined ? null : c.abi,
    stat: c.stat === true,
    opNonStat: c.opNonStat === true,
    slot: c.slot === undefined || c.slot === null ? null : c.slot,
    // 默认值里有匿名函数要抓外层名字时，被调方的**体**也得跟着（calls.js:1993）。
    // 只有"真带默认值"的候选才存这一格 —— 别的存了就是白搭 61MB。
    body: -1,
  };
}

/** 一个 struct：字段表、体里的 `using` 别名、`autounravel` 出来的那些名字。 */
function dumpRec(rec, frags, memo, pack) {
  const fields = [];
  for (const f of rec.fields === undefined ? [] : rec.fields) {
    fields.push({
      n: f.name, s: f.src === undefined ? null : f.src, t: f.type,
      d: fragOf(f.def, frags, memo, pack), mat: f.mat === undefined ? null : f.mat,
      bi: f.bi === undefined ? null : f.bi,
      fb: fragOf(f.fnbody, frags, memo, pack),
    });
  }
  const ta = [];
  if (rec.tyAlias !== undefined && rec.tyAlias !== null) {
    for (const [k, v] of rec.tyAlias) ta.push([k, v.t, v.bi === undefined ? 0 : v.bi]);
  }
  const ma = [];
  if (rec.memAlias !== undefined && rec.memAlias !== null) {
    for (const [k, v] of rec.memAlias) ma.push([k, v]);
  }
  return {
    name: rec.name, at: rec.at, fields, ta, ma,
    // `static` / `autounravel` 的字段（decls.js:104 那一格）：不占成员槽，另挂一张表。
    // 少了这一格的样子是 `plain:1:1: 取字段 '.keepAspect'` —— picture/filltype/projection
    // 三个 struct 全靠它（逐格对比量出来的）。
    st: rec.statics === undefined || rec.statics === null ? []
      : [...rec.statics].map(([k, v]) => [k, { sym: v.sym, t: v.type, at: v.at, ok: v.ok === true }]),
    // struct 体里的语句：**要带真货**。它们是构造的一部分 —— recNew 把「字段默认值」与
    // 「体里的语句」按成员号（`mat`）交错着发（lower.js:2426 那一段），所以别人 new 一个
    // 这种 struct 时照样要走它们。量过整摞 prelude 一共只有 44 条，便宜。
    // 每条不是裸的树，是 `{node, mat, bi}`（lower.js:1896）—— 三样都要存。
    // 量出来的样子（只存树、把 wrapper 交给打包器时）：plain 那一份有 6 条这种语句，
    // 打包器认不出形状 -> 整个 plain 的接口索引不写 -> 改一个字符还是满编重来。
    sts: Array.isArray(rec.stmts)
      ? rec.stmts.map((s) => (s === null || s === undefined ? [-1, null, null]
        : [fragOf(s.node, frags, memo, pack),
          s.mat === undefined ? null : s.mat, s.bi === undefined ? null : s.bi]))
      : [],
    au: rec.au === undefined || rec.au === null ? [] : [...rec.au],
  };
}

/**
 * 一个单元的接口。回 `{obj, bad}` —— `bad` 是"有一格存不下来"（碎片打包认不出形状），
 * 那时这一份**不写**，下一趟照旧从源码走，行为一个字不变。
 *
 * 存的是这个单元**并完之后**看得见的整张表（它自己的 + 它 import 进来的）。为什么不只存
 * 自己那一份、读的时候再顺着 import 递归：`import` 的语义里有次序、有 `private`（autoplain
 * 那一并不外导）、有 `from … access` 的挑名字，那一套要靠"把 import 语句原样重放"才准。
 * 整张表存下来就不必重放 —— 代价是几个库之间有重复，量过入口真要读的只有 plain 与
 * graph 那两份。
 */
export function asyIfaceDump(L, u, pack) {
  const frags = [];
  const memo = new Map();
  let bad = false;
  const keyOf = (id) => {
    const w = L.units[id];
    return w === undefined || w === null ? null : w.key;
  };
  const frag = (x) => fragOf(x, frags, memo, pack);
  const funcs = [];
  for (const [nm, list] of u.funcs) {
    const cs = [];
    for (const c of list) {
      // **只存这个单元自己声明的**。它 import 进来的那些名字归它们自己的库
      // （读的时候按 `imps` 把那几条 import 重放一遍，语义就还是原来那一套：
      // 有次序、有 private 不外导、有 `from … access` 挑名字）。
      // 存整张并完的表试过：17MB，plain 与 graph 各自都背着一份内建面 —— 比它替掉的
      // 7.7MB 树还大，没意义。
      if (c.unit !== u.id) continue;
      const d = dumpCand(c, keyOf, frags, memo, pack);
      // 被调方的**体**只在一种情况下要跟着存：默认值里有匿名函数（`new-function`）——
      // 那时 calls.js:1993 要拿这个体判"被抓的名字后面还会不会被改"（ode.asy:25 那一处）。
      // 一律存的话是 61MB（量过）：plain.aif 一个人就 1.4MB，比它替掉的树还大。
      let clo = false;
      for (const p of d.ps) {
        if (p.d >= 0 && frags[p.d] !== null && frags[p.d].indexOf('new-function') >= 0) clo = true;
      }
      if (clo && c.node !== undefined && c.node !== null
        && c.node.items !== undefined && c.node.items.length > 4) {
        d.body = frag(c.node.items[4]);
      }
      cs.push(d);
    }
    if (cs.length > 0) funcs.push([nm, cs]);
  }
  const globals = [];
  for (const [nm, list] of u.globals) {
    const gs = [];
    for (const g of list) {
      if (g.unit !== u.id) continue;
      gs.push({
        sym: g.sym, t: g.type, at: g.at, ok: g.ok === true,
        u: keyOf(g.unit), ap: g.ap === true,
      });
    }
    if (gs.length > 0) globals.push([nm, gs]);
  }
  const recs = [];
  const recSeen = new Map();
  for (const [nm, e] of u.recVis) {
    const r = e.rec;
    if (r === undefined || r === null || r.unit !== u.id) continue;
    if (!recSeen.has(r)) {
      recSeen.set(r, recs.length);
      recs.push(dumpRec(r, frags, memo, pack));
    }
  }
  const recVis = [];
  for (const [nm, e] of u.recVis) {
    if (e.rec === undefined || e.rec === null || !recSeen.has(e.rec)) continue;
    recVis.push([nm, recSeen.get(e.rec), e.at, e.ap === true]);
  }
  const tyAlias = [];
  for (const [nm, list] of u.tyAlias) {
    const ls = [];
    for (const a of list) {
      if (a.u !== u.id) continue;
      ls.push({ t: a.t, at: a.at, ap: a.ap === true });
    }
    if (ls.length > 0) tyAlias.push([nm, ls]);
  }
  // `operator cast` / `operator ecast`（按**目标类型**存，不进 funcs）与 `operator init`
  // （隐式构造）。少了这两张表的样子是 `bool3` 的 `? :` 两支配不上型、
  // `rotate(0)*"$x$"` 报 "'*' 两边要同型：左是 transform，右是 string"（string -> Label
  // 那一格转换没了）—— 都是量出来的。
  const dumpTab = (tab) => {
    const out = [];
    for (const [to, list] of tab === undefined || tab === null ? [] : tab) {
      const cs = [];
      for (const c of list) {
        if (c.unit !== u.id) continue;
        const d = dumpCand(c, keyOf, frags, memo, pack);
        d.to = c.to === undefined ? to : c.to;
        d.src = c.src === undefined ? null : c.src;
        d.ec = c.ec === true;
        d.viaVar = c.viaVar === true;
        cs.push(d);
      }
      if (cs.length > 0) out.push([to, cs]);
    }
    return out;
  };
  const casts = dumpTab(u.casts);
  const oinits = dumpTab(u.oinits);
  for (const s of frags) if (s === null) bad = true;
  return {
    bad,
    obj: {
      v: 3, key: u.key, pfx: u.pfx, init: u.init, ran: u.ran, aplain: u.aplain === true,
      nsym: u.nsym, ntmp: u.ntmp,
      funcs, globals, recs, recVis, tyAlias, frags, casts, oinits,
      // 它自己那几并 import（读回来要按这张表原样重放，见 asyModMerge 里那一笔）
      imps: u.imps === undefined || u.imps === null ? [] : u.imps,
      // `access m;` 那半边（第七十九刀）：它只建**别名**、不并名字，所以 asyModMerge
      // 一笔都不记 —— `.aif` 读回来 `L.mods` 是空的，默认值里那些 `settings.x` 于是落到
      // exprs.js 的"带点的名字或算符名"上。量到的样子：220 例里 101 个只要打开接口索引
      // 就编不过（报在 plain.asy:1:1，那是接口重建出来的那格空 span），关掉就好。
      mods: [...(u.mods === undefined || u.mods === null ? [] : u.mods)].map(([dst, m]) => {
        const w = L.units[m.unit];
        const nul = w === undefined || w === null;
        return {
          dst: dst,
          at: m.at,
          key: nul ? null : w.key,
          mname: nul || w.mname === undefined ? null : w.mname,
          tpl: nul || w.tpl === null || w.tpl === undefined ? null : [...w.tpl],
        };
      }),
      mset: u.mset === undefined || u.mset === null ? [] : [...u.mset],
    },
  };
}

/**
 * 上面那一份读回来，装成一个**没有正文**的单元（`rs` 是空的）。
 *
 * 这个单元的正文一定不会降 —— 它的产物已经在盘上（调用方就是靠"产物是最新的"才来读这一份
 * 接口的），所以 `frozen` 一开始就是 true。
 *
 * 单元号按 `key` 认：接口里记的是来源单元的身份，这里查不到就补一格**占位单元**
 * （只有 key/pfx/init/ran，正文永远不降）—— 那种情况是"某个库的名字经由这个库传递出来，
 * 而那个库这一趟没人直接 import"。
 */
export function asyIfaceLoad(L, obj, file, unpack) {
  // 版本号只有一处真值：dump 那边写的 `v: 2`。**这里从前写死成 1**，于是 dump 升到 2
  // 之后这条路整片死掉 —— `OMNI_ASY_IFACE=1` 打开也一条 `asy 接口索引` 都不打，
  // 而我拿"开 617 / 关 635，一点不省"当结论记进了注释。那次测量测的是**同一条路**。
  if (obj === null || obj === undefined || obj.v !== 3) return null;
  const trees = [];
  for (const s of obj.frags) trees.push(s === null ? null : unpack(s, file));
  const tr = (i) => (i === undefined || i === null || i < 0 ? null : trees[i]);
  const idOf = (key) => {
    if (key === null || key === undefined) return -1;
    const had = L.byKey.get(key);
    if (had !== undefined) return had.id;
    const st = L.unitStub(key);
    return st.id;
  };
  const u = L.unitStub(obj.key);
  u.pfx = obj.pfx;
  u.init = obj.init;
  u.ran = obj.ran;
  u.aplain = obj.aplain === true;
  u.nsym = obj.nsym;
  u.ntmp = obj.ntmp;
  u.frozen = true;
  // 这一份是**从接口读回来的**（第七十九刀）。chunk() 靠这一格不再把它重新 dump 一遍：
  // 「读回来再存一遍」是**有损**的（存的时候只留 `unit === u.id` 那些候选，而读回来之后
  // 有些格子的来源单元变成了替身单元），存一代掉一点，几代之后名字就找不着了。
  // 量到的样子：AiryDisk 单独反复跑一直好，中间夹一个别的例子再跑就报
  // `'texpath' 在这里还看不见`（220 例里 72 个都是这一条）。盘上那份 `.aif` 原样留着就对了。
  u.fromIface = true;
  u.mset = new Set(obj.mset);
  // struct 先立起来：候选里的 `rec` 按名字指回这里
  const recs = [];
  for (const r of obj.recs) {
    const fields = [];
    for (const f of r.fields) {
      // `fnbody` 那一格：**没有就得是 undefined，不能是 null** —— recNew 的判据是
      // `f.fnbody !== undefined`（lower.js:2436），给 null 就当成"有体"，当场炸在
      // `f.fnbody.items[1]`（量出来的：cos2theta 与 integraltest 都停在这儿）。
      const fb = tr(f.fb);
      fields.push({
        name: f.n, src: f.s === null ? undefined : f.s, type: f.t,
        def: tr(f.d), mat: f.mat === null ? undefined : f.mat,
        bi: f.bi === null ? undefined : f.bi,
        fnbody: fb === null ? undefined : fb,
      });
    }
    const tyAlias = new Map();
    for (const [k, t, bi] of r.ta) tyAlias.set(k, { t, bi });
    const memAlias = new Map();
    for (const [k, v] of r.ma) memAlias.set(k, v);
    const stmts = [];
    for (const it of r.sts === undefined ? [] : r.sts) {
      const node = tr(it[0]);
      if (node === null) { stmts.push(null); continue; }
      stmts.push({ node: node, mat: it[1], bi: it[2] });
    }
    const statics = new Map();
    for (const [k, v] of r.st === undefined ? [] : r.st) {
      statics.set(k, { sym: v.sym, type: v.t, at: v.at, ok: v.ok === true, unit: u.id });
    }
    recs.push({
      name: r.name, at: r.at, unit: u.id, fields, tyAlias, memAlias, stmts, statics,
      au: new Set(r.au),
    });
  }
  const recByName = new Map();
  for (const r of recs) recByName.set(r.name, r);
  // 全局那张记录表也要认得它们（跨单元按名字找类型走的是这张表）
  if (L.records !== undefined && L.records !== null) {
    for (const r of recs) if (!L.records.has(r.name)) L.records.set(r.name, r);
  }
  // 候选上那格 `rec`：先在自己这几个里找，找不到就问全局那张表 —— 方法的宿主 struct
  // 可能是别的单元的（逐格对比里那 3 格 `rec 有无` 就是它）
  const recOf = (nm) => {
    if (nm === null || nm === undefined) return undefined;
    const r = recByName.get(nm);
    if (r !== undefined) return r;
    if (L.records === undefined || L.records === null) return undefined;
    const g = L.records.get(nm);
    return g === undefined ? undefined : g;
  };
  const mkCand = (c) => {
    const ps = [];
    for (const p of c.ps) {
      ps.push({
        name: p.n, type: p.t, exp: p.e, kw: p.k, rest: p.r,
        src: p.s === null ? undefined : p.s, def: tr(p.d),
      });
    }
    const params = [];
    for (const p of ps) params.push(p.type);
    const body = tr(c.body);
    return {
      ret: c.ret, params, ps,
      // `node` 只被 calls.js:1993 那一句用来取被调方的体：给一格形状对得上的壳就够了
      node: body === null ? null
        : { kind: 'list', items: [null, null, null, null, body], span: body.span },
      sym: c.sym, base: c.base === null ? undefined : c.base, pfx: c.pfx,
      unit: c.u === obj.key ? u.id : idOf(c.u),
      at: c.at, dat: c.dat,
      mat: c.mat === null ? undefined : c.mat,
      rec: recOf(c.rec),
      ctor: c.ctor === true ? true : undefined,
      dup: c.dup === true ? true : undefined,
      ap: c.ap === true ? true : undefined,
      abi: c.abi === null ? undefined : c.abi,
      stat: c.stat, opNonStat: c.opNonStat,
      slot: c.slot === null ? undefined : c.slot,
    };
  };
  for (const [nm, list] of obj.funcs) {
    const out = [];
    for (const c of list) out.push(mkCand(c));
    u.funcs.set(nm, out);
  }
  // 转换与隐式构造那两张表（按目标类型存）
  const loadTab = (rows, tab) => {
    for (const [to, list] of rows === undefined || rows === null ? [] : rows) {
      const out = [];
      for (const c of list) {
        const d = mkCand(c);
        d.to = c.to === undefined ? to : c.to;
        d.src = c.src === null || c.src === undefined ? undefined : c.src;
        d.ec = c.ec === true ? true : undefined;
        d.viaVar = c.viaVar === true ? true : undefined;
        out.push(d);
      }
      tab.set(to, out);
    }
  };
  loadTab(obj.casts, u.casts);
  loadTab(obj.oinits, u.oinits);
  for (const [nm, list] of obj.globals) {
    const out = [];
    for (const g of list) {
      out.push({
        sym: g.sym, type: g.t, at: g.at, ok: g.ok,
        unit: g.u === obj.key ? u.id : idOf(g.u),
        ap: g.ap === true ? true : undefined,
      });
    }
    u.globals.set(nm, out);
  }
  for (const [nm, ri, at, ap] of obj.recVis) {
    u.recVis.set(nm, { rec: recs[ri], at, ap: ap === true ? true : undefined });
  }
  for (const [nm, list] of obj.tyAlias) {
    const out = [];
    for (const a of list) out.push({ t: a.t, at: a.at, ap: a.ap === true ? true : undefined });
    u.tyAlias.set(nm, out);
  }
  return u;
}
