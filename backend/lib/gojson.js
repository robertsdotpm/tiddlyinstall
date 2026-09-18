// JSON as Go's encoding/json writes it, so answers match the Go server byte
// for byte: HTML characters and U+2028/U+2029 escaped, keys in the order
// given (Go structs keep their field order; Go maps are sorted, see sorted()).

// A value already encoded (Go's json.RawMessage).
export class Raw {
  constructor(text) { this.text = text; }
}

const ESC = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' };

export function goString(s) {
  return JSON.stringify(String(s)).replace(/[<>&\u2028\u2029]/g, (c) => ESC[c]);
}

export function goJSON(v) {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Raw) return v.text;
  switch (typeof v) {
    case 'string': return goString(v);
    case 'number': return Number.isFinite(v) ? String(v) : 'null';
    case 'boolean': return v ? 'true' : 'false';
    default: break;
  }
  if (Array.isArray(v)) return '[' + v.map(goJSON).join(',') + ']';
  const parts = [];
  for (const k of Object.keys(v)) {
    if (v[k] === undefined) continue;
    parts.push(goString(k) + ':' + goJSON(v[k]));
  }
  return '{' + parts.join(',') + '}';
}

// A map[string]T: Go writes its keys sorted.
export function sorted(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}
