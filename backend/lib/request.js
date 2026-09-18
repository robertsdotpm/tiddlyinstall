// POST /api/jobs bodies, decoded as Go's encoding/json decodes them into
// build.Request, so the same body is accepted or refused (`bad_json`) the
// same way: keys match case-insensitively (an exact match first), later
// keys win, null leaves a field as it is (pointers become nil), a value of
// the wrong type is an error, unknown keys are ignored. One difference: a
// key repeated with the same spelling keeps only its last value (JSON.parse),
// where Go applies each in turn; they differ only for `null` after a value.

export class BadJSON extends Error {}

const S = 'string', B = 'bool', PB = '*bool', AS = '[]string', MS = 'map[string]string';
const SOURCE = { kind: S, value: S, ref: S, version: S };
const ICON = { choice: S, data: S, filename: S, type: S, sha256: S };
const REQUEST = {
  name: S, project: S, source: SOURCE, runtime: S, select: S, range: S, launch: S, install: S,
  console: PB, menu: PB, desktop: B, root: S, rootname: S, platforms: AS, mode: S, offline: B,
  files: MS, icon: { ptr: ICON },
};

function zero(spec) {
  const out = {};
  for (const [k, t] of Object.entries(spec)) {
    if (t === S) out[k] = '';
    else if (t === B) out[k] = false;
    else if (t === PB || t === AS || t === MS || (typeof t === 'object' && t.ptr)) out[k] = null;
    else out[k] = zero(t);
  }
  return out;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function fieldFor(spec, key) {
  if (Object.hasOwn(spec, key)) return key;
  const low = key.toLowerCase();
  for (const k of Object.keys(spec)) if (k.toLowerCase() === low) return k;
  return null;
}

function decodeInto(out, spec, obj) {
  let bad = null;
  for (const [key, v] of Object.entries(obj)) {
    const f = fieldFor(spec, key);
    if (!f) continue;
    const t = spec[f];
    try {
      out[f] = decodeValue(out[f], t, v);
    } catch (e) {
      bad = bad || e;   // Go keeps going and reports the first error
    }
  }
  if (bad) throw bad;
  return out;
}

function decodeValue(cur, t, v) {
  const type = (want) => new BadJSON('cannot unmarshal ' + (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v) + ' into ' + want);
  if (t === S) {
    if (v === null) return cur;
    if (typeof v !== 'string') throw type('string');
    return v;
  }
  if (t === B) {
    if (v === null) return cur;
    if (typeof v !== 'boolean') throw type('bool');
    return v;
  }
  if (t === PB) {
    if (v === null) return null;
    if (typeof v !== 'boolean') throw type('bool');
    return v;
  }
  if (t === AS) {
    if (v === null) return null;
    if (!Array.isArray(v)) throw type('[]string');
    let bad = null;
    const out = v.map((x) => {
      if (x === null) return '';
      if (typeof x !== 'string') { bad = bad || type('string'); return ''; }
      return x;
    });
    if (bad) throw bad;
    return out;
  }
  if (t === MS) {
    if (v === null) return null;
    if (!isObj(v)) throw type('map[string]string');
    const out = cur || {};
    let bad = null;
    for (const [k, x] of Object.entries(v)) {
      if (x === null) { out[k] = ''; continue; }
      if (typeof x !== 'string') { bad = bad || type('string'); continue; }
      out[k] = x;
    }
    if (bad) throw bad;
    return out;
  }
  if (typeof t === 'object' && t.ptr) {
    if (v === null) return null;
    if (!isObj(v)) throw type('struct');
    return decodeInto(cur || zero(t.ptr), t.ptr, v);
  }
  // A struct value.
  if (v === null) return cur;
  if (!isObj(v)) throw type('struct');
  return decodeInto(cur, t, v);
}

// decodeRequest: the body (bytes) to a request with every field present,
// as json.Unmarshal into a zero build.Request leaves it. Throws BadJSON.
export function decodeRequest(bytes) {
  let v;
  try {
    v = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new BadJSON(e.message);
  }
  const out = zero(REQUEST);
  if (v === null) return out;
  if (!isObj(v)) throw new BadJSON('cannot unmarshal into build.Request');
  return decodeInto(out, REQUEST, v);
}
