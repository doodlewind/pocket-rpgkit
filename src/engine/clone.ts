// src/engine/clone.ts — host-portable snapshot copy for the pure
// reducers. The desktop guest runs on QuickJS/rquickjs, which has no
// structuredClone global (fleet review C06: the app threw on its first
// native frame). Every folded state is plain JSON-shaped data — switches,
// fibers, compiled programs, typed arrays are NOT part of these states — so
// a recursive value clone is enough and keeps the reducer free of host
// globals. undefined-valued keys are preserved (a held self switch is
// cleared by storing undefined, not by deleting the key).

export function deepClone<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    const out = new Array<unknown>(v.length);
    for (let i = 0; i < v.length; i++) out[i] = deepClone(v[i]);
    return out as T;
  }
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k in src) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = deepClone(src[k]);
  }
  return out as T;
}
