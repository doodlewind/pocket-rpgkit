// src/engine/schema-validate.ts — minimal JSON Schema (draft
// 2020-12 subset) validator covering the constructs data/schema.json uses:
// type, const, enum, properties/required/additionalProperties, items,
// minItems/maxItems, oneOf, $ref + $defs, pattern, minLength/maxLength,
// minimum/maximum, exclusiveMinimum, minProperties, uniqueItems,
// prefixItems. Not a general-purpose validator — a zero-dependency checker
// for THIS schema, so the runtime data keeps an acceptance gate without
// adding a dependency.

export type Schema = Record<string, any>;

export interface VError {
  path: string;
  msg: string;
}

export function validateSchema(root: Schema, instance: unknown): VError[] {
  const errs: VError[] = [];
  const walk = (sch: Schema, v: unknown, path: string): void => {
    if (sch.$ref) {
      const name = sch.$ref.split("/").pop()!;
      walk(root.$defs[name], v, path);
      return;
    }
    if (sch.const !== undefined && v !== sch.const) errs.push({ path, msg: `must equal ${JSON.stringify(sch.const)}` });
    if (sch.enum && !sch.enum.includes(v)) errs.push({ path, msg: `must be one of ${JSON.stringify(sch.enum)}` });
    if (sch.type) {
      const types = Array.isArray(sch.type) ? sch.type : [sch.type];
      const check = (ty: string) => ({
        object: v !== null && typeof v === "object" && !Array.isArray(v),
        array: Array.isArray(v),
        string: typeof v === "string",
        integer: typeof v === "number" && Number.isInteger(v),
        number: typeof v === "number",
        boolean: typeof v === "boolean",
        null: v === null,
      })[ty];
      if (!types.some((ty: string) => check(ty))) { errs.push({ path, msg: `expected ${JSON.stringify(sch.type)}` }); return; }
    }
    if (typeof v === "string") {
      if (sch.pattern && !new RegExp(sch.pattern).test(v)) errs.push({ path, msg: `must match ${sch.pattern}` });
      if (sch.minLength !== undefined && v.length < sch.minLength) errs.push({ path, msg: `minLength ${sch.minLength}` });
      if (sch.maxLength !== undefined && v.length > sch.maxLength) errs.push({ path, msg: `maxLength ${sch.maxLength}` });
    }
    if (typeof v === "number") {
      if (sch.minimum !== undefined && v < sch.minimum) errs.push({ path, msg: `minimum ${sch.minimum}` });
      if (sch.maximum !== undefined && v > sch.maximum) errs.push({ path, msg: `maximum ${sch.maximum}` });
      if (sch.exclusiveMinimum !== undefined && v <= sch.exclusiveMinimum) errs.push({ path, msg: `exclusiveMinimum ${sch.exclusiveMinimum}` });
    }
    if (Array.isArray(v)) {
      if (sch.minItems !== undefined && v.length < sch.minItems) errs.push({ path, msg: `minItems ${sch.minItems}` });
      if (sch.maxItems !== undefined && v.length > sch.maxItems) errs.push({ path, msg: `maxItems ${sch.maxItems}` });
      if (sch.uniqueItems) {
        const seen = new Set(v.map((x) => JSON.stringify(x)));
        if (seen.size !== v.length) errs.push({ path, msg: "items must be unique" });
      }
      if (sch.items) v.forEach((el, i) => walk(sch.items, el, `${path}[${i}]`));
      if (sch.prefixItems) sch.prefixItems.forEach((s: Schema, i: number) => i < v.length && walk(s, v[i], `${path}[${i}]`));
    }
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (sch.minProperties && Object.keys(o).length < sch.minProperties) errs.push({ path, msg: `minProperties ${sch.minProperties}` });
      for (const req of sch.required ?? []) if (!(req in o)) errs.push({ path, msg: `missing required '${req}'` });
      if (sch.additionalProperties === false) {
        const allowed = new Set([...Object.keys(sch.properties ?? {}), ...(sch.required ?? [])]);
        for (const k of Object.keys(o)) if (!allowed.has(k)) errs.push({ path: `${path}.${k}`, msg: "additional property" });
      }
      for (const [k, sub] of Object.entries(sch.properties ?? {})) {
        if (k in o) walk(sub as Schema, o[k], `${path}.${k}`);
      }
    }
    if (sch.oneOf) {
      const matches = sch.oneOf.filter((branch: Schema) => {
        const sub: VError[] = [];
        const push = errs.push.bind(errs);
        errs.push = (...e: VError[]) => { sub.push(...e); return errs.length; };
        walk(branch, v, path);
        errs.push = push;
        return sub.length === 0;
      }).length;
      if (matches !== 1) errs.push({ path, msg: `oneOf: matched ${matches} branches (need exactly 1)` });
    }
  };
  walk(root, instance, "$");
  return errs;
}
