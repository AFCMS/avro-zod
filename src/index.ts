import * as z from "zod/v4/core";

type Primitive = "null" | "boolean" | "int" | "long" | "float" | "double" | "bytes" | "string";

interface Annotations {
  readonly [annotation: string]: unknown;
}

interface Named extends Annotations {
  readonly name: string;
  readonly namespace?: string;
  readonly aliases?: readonly string[];
  readonly doc?: string;
}

interface Field extends Annotations {
  readonly name: string;
  readonly type: AvroSchema;
  readonly default?: unknown;
  readonly aliases?: readonly string[];
  readonly doc?: string;
  readonly order?: "ascending" | "descending" | "ignore";
}

/**
 * An Avro declaration. Readonly collections support `as const satisfies AvroSchema`.
 */
export type AvroSchema =
  | string
  | (Annotations & { readonly type: Primitive; readonly logicalType?: string })
  | (Named & { readonly type: "record"; readonly fields: readonly Field[] })
  | (Named & {
      readonly type: "enum";
      readonly symbols: readonly string[];
      readonly default?: string;
    })
  | (Named & { readonly type: "fixed"; readonly size: number })
  | (Annotations & { readonly type: "array"; readonly items: AvroSchema })
  | (Annotations & { readonly type: "map"; readonly values: AvroSchema })
  | readonly AvroSchema[];

type PrimitiveSchemas = {
  null: z.$ZodNull;
  boolean: z.$ZodBoolean<boolean>;
  int: z.$ZodNumberFormat;
  long: z.$ZodBigIntFormat;
  float: z.$ZodCustom<number, number>;
  double: z.$ZodCustom<number, number>;
  bytes: z.$ZodCustom<Uint8Array, Uint8Array>;
  string: z.$ZodString<string>;
};

/** Replacement validators for Avro primitives; omitted or undefined entries use the defaults. */
export type PrimitiveOverrides = { readonly [P in Primitive]?: z.$ZodType | undefined };

export interface FromAvroOptions<M extends PrimitiveOverrides = PrimitiveOverrides> {
  readonly primitives?: M | undefined;
}

type CheckedOverrides<M extends PrimitiveOverrides> = M &
  Record<Exclude<keyof M, Primitive>, never>;

type PrimitiveSchema<P extends Primitive, M extends PrimitiveOverrides> = M extends unknown
  ? P extends keyof M
    ? Extract<M[P], z.$ZodType> | (undefined extends M[P] ? PrimitiveSchemas[P] : never)
    : PrimitiveSchemas[P]
  : never;

type RecordSchema<
  F extends readonly Field[],
  M extends PrimitiveOverrides,
> = number extends F["length"]
  ? z.$ZodUnknown
  : string extends F[number]["name"]
    ? z.$ZodUnknown
    : z.$ZodObject<{ -readonly [P in F[number] as P["name"]]: ToZod<P["type"], M> }, z.$strict>;

type UnionSchema<
  S extends readonly AvroSchema[],
  M extends PrimitiveOverrides,
> = number extends S["length"] ? z.$ZodUnknown : z.$ZodUnion<{ [K in keyof S]: ToZod<S[K], M> }>;

/** Preserve literal child validators; widened declarations and reference sites infer unknown. */
export type ToZod<S extends AvroSchema, M extends PrimitiveOverrides = {}> = [AvroSchema] extends [
  S,
]
  ? z.$ZodUnknown
  : S extends Primitive
    ? PrimitiveSchema<S, M>
    : S extends string
      ? z.$ZodUnknown
      : S extends readonly AvroSchema[]
        ? UnionSchema<S, M>
        : S extends { readonly type: infer T extends Primitive }
          ? PrimitiveSchema<T, M>
          : S extends { readonly type: "record"; readonly fields: infer F extends readonly Field[] }
            ? RecordSchema<F, M>
            : S extends {
                  readonly type: "enum";
                  readonly symbols: infer V extends readonly string[];
                }
              ? string extends V[number]
                ? z.$ZodUnknown
                : z.$ZodEnum<{ [K in V[number]]: K }>
              : S extends { readonly type: "array"; readonly items: infer I extends AvroSchema }
                ? z.$ZodArray<ToZod<I, M>>
                : S extends { readonly type: "map"; readonly values: infer V extends AvroSchema }
                  ? z.$ZodRecord<z.$ZodString<string>, ToZod<V, M>>
                  : S extends { readonly type: "fixed" }
                    ? PrimitiveSchemas["bytes"]
                    : z.$ZodUnknown;

/** Shallow metadata avoids recursively instantiating the Avro input type in Zod's registry. */
export const avroMetadata = z.registry<{ source: unknown; fullName?: string }>();

interface Definition {
  schema?: z.$ZodType;
}

interface Compiled {
  schema: z.$ZodType;
  // Avro union identity differs from the JavaScript representation of a branch.
  key: string;
}

const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fullNamePattern = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const primitives = new Set<string>([
  "null",
  "boolean",
  "int",
  "long",
  "float",
  "double",
  "bytes",
  "string",
]);

function fail(path: string, message: string): never {
  throw new Error(`Invalid Avro schema at ${path}: ${message}`);
}

function declaration(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected a schema object");
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function name(value: unknown, path: string, qualified = false): string {
  if (typeof value !== "string" || !(qualified ? fullNamePattern : namePattern).test(value)) {
    fail(path, qualified ? "expected an Avro name or fullname" : "expected an Avro name");
  }
  return value;
}

function fullname(source: Record<string, unknown>, namespace: string, path: string): string {
  const declaredName = name(source.name, `${path}.name`, true);
  const shortName = declaredName.slice(declaredName.lastIndexOf(".") + 1);
  if (primitives.has(shortName)) fail(`${path}.name`, "primitive names cannot be redefined");
  // A dotted name supplies its own namespace, overriding the namespace attribute.
  if (declaredName.includes(".")) return declaredName;
  const declaredNamespace = source.namespace === undefined ? namespace : source.namespace;
  const enclosing =
    declaredNamespace === "" ? "" : name(declaredNamespace, `${path}.namespace`, true);
  return enclosing ? `${enclosing}.${declaredName}` : declaredName;
}

function readOverrides(value: unknown): ReadonlyMap<string, z.$ZodType> {
  const overrides = new Map<string, z.$ZodType>();
  if (value === undefined) return overrides;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid primitive overrides: expected an object");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !primitives.has(key)) {
      throw new Error(`Invalid primitive override "${String(key)}": expected an Avro primitive`);
    }
    const schema = (value as Record<string, unknown>)[key];
    if (schema === undefined) continue;
    if (!(schema instanceof z.$ZodType)) {
      throw new Error(`Invalid primitive override "${key}": expected a Zod 4 schema`);
    }
    overrides.set(key, schema);
  }
  return overrides;
}

function primitive(
  type: string,
  overrides: ReadonlyMap<string, z.$ZodType>,
): z.$ZodType | undefined {
  const override = overrides.get(type);
  if (override) return z.util.clone(override);
  switch (type) {
    case "null":
      return new z.$ZodNull({ type: "null" });
    case "boolean":
      return new z.$ZodBoolean({ type: "boolean" });
    case "int":
      return z._int32(z.$ZodNumberFormat);
    case "long":
      return z._int64(z.$ZodBigIntFormat);
    // z.number() excludes NaN and infinities, which Avro floating point values allow.
    case "float":
    case "double":
      return z._custom<number>(
        z.$ZodCustom,
        (value) => typeof value === "number",
        "Expected a number",
      );
    case "bytes":
      return z._custom<Uint8Array>(
        z.$ZodCustom,
        (value) => value instanceof Uint8Array,
        "Input not instance of Uint8Array",
      );
    case "string":
      return new z.$ZodString({ type: "string" });
  }
}

function annotate(schema: z.$ZodType, source: unknown, key: string, fullName?: string): Compiled {
  // A replacement can itself be a named Avro validator; do not inherit its fullname.
  avroMetadata.add(
    schema,
    fullName === undefined && avroMetadata.get(schema)?.fullName === undefined
      ? { source }
      : { source, fullName },
  );
  return { schema, key };
}

function compile(
  source: unknown,
  namespace: string,
  path: string,
  names: Map<string, Definition>,
  overrides: ReadonlyMap<string, z.$ZodType>,
): Compiled {
  if (typeof source === "string") {
    const schema = primitive(source, overrides);
    if (schema) return annotate(schema, source, `type:${source}`);
    name(source, path, true);
    const fullName = source.includes(".") || !namespace ? source : `${namespace}.${source}`;
    const definition = names.get(fullName);
    if (!definition) fail(path, `unresolved or forward reference "${fullName}"`);
    if (definition.schema) return { schema: definition.schema, key: `name:${fullName}` };
    const lazy = new z.$ZodLazy({
      type: "lazy",
      getter: () => {
        if (!definition.schema) fail(path, `unfinished definition "${fullName}"`);
        return definition.schema;
      },
    });
    return annotate(lazy, source, `name:${fullName}`, fullName);
  }

  if (Array.isArray(source)) {
    if (source.length === 0) fail(path, "a union must contain at least one branch");
    const seen = new Set<string>();
    const branches: z.$ZodType[] = [];
    for (const [index, branch] of source.entries()) {
      const branchPath = `${path}[${index}]`;
      if (Array.isArray(branch)) fail(branchPath, "unions cannot immediately contain other unions");
      const compiled = compile(branch, namespace, branchPath, names, overrides);
      if (seen.has(compiled.key)) fail(branchPath, `duplicate union branch ${compiled.key}`);
      seen.add(compiled.key);
      branches.push(compiled.schema);
    }
    return annotate(new z.$ZodUnion({ type: "union", options: branches }), source, "union");
  }

  const object = declaration(source, path);
  if (typeof object.type !== "string") fail(`${path}.type`, "expected a type name");
  const schema = primitive(object.type, overrides);
  if (schema) return annotate(schema, source, `type:${object.type}`);

  if (object.type === "array") {
    return annotate(
      new z.$ZodArray({
        type: "array",
        element: compile(object.items, namespace, `${path}.items`, names, overrides).schema,
      }),
      source,
      "type:array",
    );
  }
  if (object.type === "map") {
    return annotate(
      new z.$ZodRecord({
        type: "record",
        // Zod 4.0 requires a record key's non-coerced input type to be explicit.
        keyType: new z.$ZodString({ type: "string" }) as z.$ZodString<string>,
        valueType: compile(object.values, namespace, `${path}.values`, names, overrides).schema,
      }),
      source,
      "type:map",
    );
  }
  if (object.type !== "record" && object.type !== "enum" && object.type !== "fixed") {
    fail(`${path}.type`, `unsupported type "${object.type}"; named references must be strings`);
  }

  const fullName = fullname(object, namespace, path);
  if (names.has(fullName)) fail(`${path}.name`, `duplicate definition "${fullName}"`);
  // Reserve the fullname before descending so self and enclosing references can resolve lazily.
  const definition: Definition = {};
  names.set(fullName, definition);
  const childNamespace = fullName.includes(".") ? fullName.slice(0, fullName.lastIndexOf(".")) : "";
  let namedSchema: z.$ZodType;

  if (object.type === "record") {
    const fields = list(object.fields, `${path}.fields`);
    const seen = new Set<string>();
    const entries = fields.map((value, index): [string, z.$ZodType] => {
      const fieldPath = `${path}.fields[${index}]`;
      const field = declaration(value, fieldPath);
      const fieldName = name(field.name, `${fieldPath}.name`);
      if (seen.has(fieldName)) fail(`${fieldPath}.name`, `duplicate field "${fieldName}"`);
      seen.add(fieldName);
      return [
        fieldName,
        compile(field.type, childNamespace, `${fieldPath}.type`, names, overrides).schema,
      ];
    });
    namedSchema = new z.$ZodObject({
      type: "object",
      shape: Object.fromEntries(entries),
      catchall: new z.$ZodNever({ type: "never" }),
    });
  } else if (object.type === "enum") {
    const seen = new Set<string>();
    const symbols = list(object.symbols, `${path}.symbols`).map((value, index) => {
      const symbolPath = `${path}.symbols[${index}]`;
      const symbol = name(value, symbolPath);
      if (seen.has(symbol)) fail(symbolPath, `duplicate enum symbol "${symbol}"`);
      seen.add(symbol);
      return symbol;
    });
    if (
      object.default !== undefined &&
      (typeof object.default !== "string" || !seen.has(object.default))
    ) {
      fail(`${path}.default`, "enum default must be one of its symbols");
    }
    namedSchema = new z.$ZodEnum({
      type: "enum",
      entries: Object.fromEntries(symbols.map((symbol) => [symbol, symbol])),
    });
  } else {
    const size = object.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      fail(`${path}.size`, "expected a non-negative safe integer byte length");
    }
    namedSchema = new z.$ZodCustom({
      type: "custom",
      check: "custom",
      fn: (value) => value instanceof Uint8Array,
      abort: true,
      error: () => "Input not instance of Uint8Array",
      checks: [
        z._refine<Uint8Array>(
          z.$ZodCustom,
          (value) => value.byteLength === size,
          `Expected exactly ${size} bytes`,
        ),
      ],
    });
  }

  definition.schema = namedSchema;
  return annotate(namedSchema, source, `name:${fullName}`, fullName);
}

/**
 * Convert an Avro declaration into a strict Zod 4 Core validator for unwrapped JS values.
 * Parse with the top-level functions from Zod Core, Classic, or Mini.
 * Primitive replacements retain their exact validator, input, and output types.
 */
export function fromAvro<const S extends AvroSchema>(
  source: S,
  options?: { readonly primitives?: undefined },
): ToZod<S>;
export function fromAvro<const S extends AvroSchema, const M extends PrimitiveOverrides>(
  source: S,
  options: { readonly primitives: CheckedOverrides<M> },
): ToZod<S, M>;
export function fromAvro<const S extends AvroSchema, const M extends PrimitiveOverrides = {}>(
  source: S,
  options: FromAvroOptions<CheckedOverrides<M>> | undefined,
): ToZod<S, M | {}>;
export function fromAvro(source: AvroSchema, options?: FromAvroOptions): z.$ZodType {
  return compile(source, "", "$", new Map(), readOverrides(options?.primitives)).schema;
}
