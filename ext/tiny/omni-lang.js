// ext/tiny/omni-lang.js —— tiny 这格扩展的入口（约定见 docs/EXTENSIONS.md）

import { Diagnostics, SourceFile, OmniError } from '../../src/core/source/diag.js';
import { readText } from '../../src/core/host/native.js';
import { basename } from '../../src/core/host/path.js';
import { lowerCoreSexpr } from '../../src/core/sexpr/lower.js';
import { parse, ParseError } from '../../src/core/frontend-engine/parse-driver.js';
import { LexError } from '../../src/core/frontend-engine/lexrules.js';
import { tinyLang } from './lang.js';
import { lowerTiny, TinyError } from './lower.js';

let API = null;

export function tinyToSx(path) {
  const src = readText(path);
  try {
    return lowerTiny(parse(src, tinyLang));
  } catch (err) {
    if (err instanceof ParseError || err instanceof LexError || err instanceof TinyError) {
      throw new OmniError(`${basename(path)}: ${err.message}`);
    }
    throw err;
  }
}

export function compileTiny(path) {
  const diags = new Diagnostics();
  const mod = lowerCoreSexpr(new SourceFile(`${path}.sx`, tinyToSx(path)), diags);
  diags.throwIfErrors();
  if (API !== null) API.log(`tiny front end  ${path} -> OIR  ${mod.funcs.length} funcs`);
  return { ast: null, mod, diags };
}

export function registerTinyExt(api) {
  API = api;
  api.registerCap('tiny.toSx', tinyToSx);
  api.registerLang(['.tiny'], 'mini', (path) => compileTiny(path));
}
