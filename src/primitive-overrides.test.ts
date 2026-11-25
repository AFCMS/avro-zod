import { expect, expectTypeOf, test, vi } from "vitest";
import * as z from "zod/v4";
import * as core from "zod/v4/core";
import * as mini from "zod/v4/mini";

import {
  type AvroSchema,
  type FromAvroOptions,
  type PrimitiveOverrides,
  type ToZod,
  avroMetadata,
  fromAvro,
} from "./index.ts";

test("omitted, empty, and undefined overrides retain the default mappings", () => {
  const schemas = [
    fromAvro("long"),
    fromAvro("long", undefined),
    fromAvro("long", {}),
    fromAvro("long", { primitives: undefined }),
    fromAvro("long", { primitives: {} }),
    fromAvro("long", { primitives: { long: undefined } }),
  ] as const;
  expectTypeOf(schemas[0]).toEqualTypeOf<core.$ZodBigIntFormat>();
  expectTypeOf(schemas[1]).toEqualTypeOf<core.$ZodBigIntFormat>();
  expectTypeOf(schemas[2]).toEqualTypeOf<core.$ZodBigIntFormat>();
  expectTypeOf(schemas[3]).toEqualTypeOf<core.$ZodBigIntFormat>();
  expectTypeOf(schemas[4]).toEqualTypeOf<core.$ZodBigIntFormat>();
  expectTypeOf(schemas[5]).toEqualTypeOf<core.$ZodBigIntFormat>();
  for (const schema of schemas) {
    expect(core.parse(schema, 42n)).toBe(42n);
    expect(core.safeParse(schema, 42).success).toBe(false);
  }
});

test.each([
  ["null", null],
  ["boolean", true],
  ["int", 42],
  ["long", 42n],
  ["float", 1.5],
  ["double", 1.5],
  ["bytes", new Uint8Array([1])],
  ["string", "original"],
] as const)("%s can be replaced in string and object declarations", (type, original) => {
  const replacement = z.literal("mapped");
  const primitives: PrimitiveOverrides = { [type]: replacement };
  for (const source of [type, { type }]) {
    const schema = fromAvro(source, { primitives });
    expect(core.parse(schema, "mapped")).toBe("mapped");
    expect(core.safeParse(schema, original).success).toBe(false);
    expect(schema).not.toBe(replacement);
    expect(avroMetadata.get(schema)?.source).toBe(source);
  }
});

test("a numeric long retains its exact schema class and exports to JSON Schema", () => {
  const source = {
    type: "record",
    name: "Event",
    fields: [{ name: "id", type: "long" }],
  } as const satisfies AvroSchema;
  const replacement = z.number().min(0).describe("Event ID");
  const primitives = { long: replacement } satisfies PrimitiveOverrides;
  const schema = fromAvro(source, { primitives });
  expectTypeOf(schema).toEqualTypeOf<ToZod<typeof source, typeof primitives>>();
  expectTypeOf(schema._zod.def.shape.id).toEqualTypeOf<z.ZodNumber>();
  expectTypeOf<core.input<typeof schema>>().toEqualTypeOf<{ id: number }>();
  expectTypeOf<core.output<typeof schema>>().toEqualTypeOf<{ id: number }>();
  expect(core.parse(schema, { id: 1.5 })).toEqual({ id: 1.5 });
  expect(core.safeParse(schema, { id: 1n }).success).toBe(false);
  expect(core.safeParse(schema, { id: -1 }).success).toBe(false);
  expect(core.safeParse(schema, { id: 1, extra: true }).success).toBe(false);
  expect(() => z.toJSONSchema(fromAvro(source))).toThrow("BigInt");
  expect(z.toJSONSchema(schema)).toMatchObject({
    type: "object",
    properties: { id: { type: "number", minimum: 0, description: "Event ID" } },
    required: ["id"],
    additionalProperties: false,
  });
});

test("a partial mapping preserves the other primitive types and constraints", () => {
  const schema = fromAvro(
    {
      type: "record",
      name: "Partial",
      fields: [
        { name: "id", type: "long" },
        { name: "count", type: "int" },
        { name: "name", type: "string" },
        { name: "active", type: "boolean" },
      ],
    },
    { primitives: { long: z.number() } },
  );
  type Expected = { id: number; count: number; name: string; active: boolean };
  expectTypeOf<core.input<typeof schema>>().toEqualTypeOf<Expected>();
  expectTypeOf<core.output<typeof schema>>().toEqualTypeOf<Expected>();
  expectTypeOf(schema._zod.def.shape.count).toEqualTypeOf<core.$ZodNumberFormat>();
  const value = { id: 1, count: 2, name: "event", active: true };
  expect(core.parse(schema, value)).toEqual(value);
  expect(core.safeParse(schema, { ...value, count: 2147483648 }).success).toBe(false);
  expect(core.safeParse(schema, { ...value, name: 2 }).success).toBe(false);
  expect(core.safeParse(fromAvro("long"), 1).success).toBe(false);
});

test("mapping types propagate through records, arrays, maps, and unions", () => {
  const schema = fromAvro(
    {
      type: "record",
      name: "Container",
      fields: [
        {
          name: "items",
          type: {
            type: "array",
            items: {
              type: "map",
              values: {
                type: "record",
                name: "Entry",
                fields: [{ name: "value", type: ["null", "long"] }],
              },
            },
          },
        },
      ],
    },
    { primitives: { long: z.number() } },
  );
  type Expected = { items: Record<string, { value: number | null }>[] };
  expectTypeOf<core.input<typeof schema>>().toEqualTypeOf<Expected>();
  expectTypeOf<core.output<typeof schema>>().toEqualTypeOf<Expected>();
  const entry = schema._zod.def.shape.items._zod.def.element._zod.def.valueType;
  expectTypeOf(entry._zod.def.shape.value._zod.def.options[1]).toEqualTypeOf<z.ZodNumber>();
  const value = { items: [{ first: { value: 1 }, empty: { value: null } }] };
  expect(core.parse(schema, value)).toEqual(value);
  expect(core.safeParse(schema, { items: [{ first: { value: 1n } }] }).success).toBe(false);
});

test("logical types use the replacement while retaining the original annotation", () => {
  const source = { type: "long", logicalType: "timestamp-millis", doc: "Created at" } as const;
  const schema = fromAvro(source, { primitives: { long: z.number() } });
  expectTypeOf(schema).toEqualTypeOf<z.ZodNumber>();
  expect(core.parse(schema, 123)).toBe(123);
  expect(avroMetadata.get(schema)?.source).toBe(source);
});

test("recursive and reused named validators apply the same primitive overrides", () => {
  const schema = fromAvro(
    {
      type: "record",
      name: "Container",
      fields: [
        {
          name: "first",
          type: {
            type: "record",
            name: "Node",
            fields: [
              { name: "value", type: "long" },
              { name: "children", type: { type: "array", items: "Node" } },
              { name: "byName", type: { type: "map", values: "Node" } },
            ],
          },
        },
        { name: "second", type: "Node" },
      ],
    },
    { primitives: { long: z.number() } },
  );
  expectTypeOf(schema._zod.def.shape.first._zod.def.shape.value).toEqualTypeOf<z.ZodNumber>();
  expectTypeOf<core.output<typeof schema._zod.def.shape.second>>().toBeUnknown();
  expect(schema._zod.def.shape.first).toBe(schema._zod.def.shape.second);
  const leaf = { value: 1, children: [], byName: {} };
  const value = { first: { value: 2, children: [leaf], byName: { leaf } }, second: leaf };
  expect(core.parse(schema, value)).toEqual(value);
  expect(
    core.safeParse(schema, {
      ...value,
      first: { ...value.first, children: [{ ...leaf, value: 1n }] },
    }).success,
  ).toBe(false);
  expect(core.safeParse(schema, { ...value, second: { ...leaf, value: 1n } }).success).toBe(false);
});

test("recursive validators report premature resolution and remain usable after compilation", () => {
  expect.assertions(2);
  const add = avroMetadata.add.bind(avroMetadata);
  const errors: unknown[] = [];
  // Observe registrations through the exported registry, before the parent record is complete.
  const observer = vi.spyOn(avroMetadata, "add").mockImplementation((schema, ...metadata) => {
    if (schema instanceof core.$ZodLazy) {
      try {
        schema._zod.def.getter();
      } catch (error) {
        errors.push(error);
      }
    }
    return add(schema, ...metadata);
  });
  try {
    const schema = fromAvro(
      {
        type: "record",
        name: "Node",
        fields: [
          { name: "value", type: "long" },
          { name: "next", type: ["null", "Node"] },
        ],
      },
      { primitives: { long: z.number() } },
    );
    expect(errors).toEqual([
      new Error('Invalid Avro schema at $.fields[1].type[1]: unfinished definition "Node"'),
    ]);
    const value = { value: 1, next: { value: 2, next: null } };
    expect(core.parse(schema, value)).toEqual(value);
  } finally {
    observer.mockRestore();
  }
});

test("overlapping replacements preserve Avro union identity and branch metadata", () => {
  const replacement = z.number();
  const primitives = { int: replacement, long: replacement };
  const schema = fromAvro(["int", "long"], { primitives });
  expectTypeOf<core.output<typeof schema>>().toEqualTypeOf<number>();
  expect(schema._zod.def.options).toHaveLength(2);
  expect(schema._zod.def.options.map((branch) => avroMetadata.get(branch)?.source)).toEqual([
    "int",
    "long",
  ]);
  expect(core.parse(schema, 1.5)).toBe(1.5);
  expect(() => fromAvro(["long", { type: "long" }], { primitives })).toThrow(
    "duplicate union branch",
  );
});

test("bytes replacements leave fixed byte-length validation intact", () => {
  const schema = fromAvro(
    {
      type: "record",
      name: "Data",
      fields: [
        { name: "data", type: "bytes" },
        { name: "hash", type: { type: "fixed", name: "Hash", size: 2 } },
      ],
    },
    { primitives: { bytes: z.string() } },
  );
  expectTypeOf<core.output<typeof schema>>().toEqualTypeOf<{ data: string; hash: Uint8Array }>();
  const value = { data: "AQI=", hash: new Uint8Array([1, 2]) };
  expect(core.parse(schema, value)).toEqual(value);
  const invalid = core.safeParse(schema, { ...value, hash: "AQI=" });
  expect(invalid.success).toBe(false);
  expect(invalid.error?.issues).toEqual([
    { code: "custom", path: ["hash"], message: "Input not instance of Uint8Array" },
  ]);
  expect(core.safeParse(schema, { ...value, hash: new Uint8Array(1) }).success).toBe(false);
});

test("string replacements apply to map values while keys remain unrestricted strings", () => {
  const schema = fromAvro(
    { type: "map", values: "string" },
    { primitives: { string: z.literal("value") } },
  );
  expectTypeOf<core.output<typeof schema>>().toEqualTypeOf<Record<string, "value">>();
  expect(core.parse(schema, { arbitrary: "value" })).toEqual({ arbitrary: "value" });
  expect(core.safeParse(schema, { arbitrary: "other" }).success).toBe(false);
});

test("replacement transforms preserve exact child validators and distinct input/output types", () => {
  const replacement = z.string().transform((value) => Number(value));
  const primitives = { long: replacement } satisfies PrimitiveOverrides;
  const schema = fromAvro(
    { type: "record", name: "Transformed", fields: [{ name: "id", type: "long" }] },
    { primitives },
  );
  expectTypeOf(schema._zod.def.shape.id).toEqualTypeOf<typeof replacement>();
  expectTypeOf<core.input<typeof schema>>().toEqualTypeOf<{ id: string }>();
  expectTypeOf<core.output<typeof schema>>().toEqualTypeOf<{ id: number }>();
  expect(core.parse(schema, { id: "42" })).toEqual({ id: 42 });
  expect(core.safeParse(schema, { id: 42 }).success).toBe(false);
});

test("optional override properties infer both the replacement and default schemas", () => {
  function convert(primitives: { long?: z.ZodNumber }) {
    const schema = fromAvro("long", { primitives });
    expectTypeOf(schema).toEqualTypeOf<z.ZodNumber | core.$ZodBigIntFormat>();
    expectTypeOf<core.input<typeof schema>>().toEqualTypeOf<number | bigint>();
    expectTypeOf<core.output<typeof schema>>().toEqualTypeOf<number | bigint>();
    return schema;
  }
  expect(core.parse(convert({}), 1n)).toBe(1n);
  expect(core.parse(convert({ long: z.number() }), 1)).toBe(1);
});

test("optional options and mappings retain the possibility of the defaults", () => {
  function convert(options?: FromAvroOptions<{ long: z.ZodNumber }>) {
    const schema = fromAvro("long", options);
    expectTypeOf(schema).toEqualTypeOf<z.ZodNumber | core.$ZodBigIntFormat>();
    return schema;
  }
  expect(core.parse(convert(), 1n)).toBe(1n);
  expect(core.parse(convert({}), 1n)).toBe(1n);
  expect(core.parse(convert({ primitives: { long: z.number() } }), 1)).toBe(1);
  const explicit = fromAvro<"long", { long: z.ZodNumber }>("long", {});
  expectTypeOf(explicit).toEqualTypeOf<z.ZodNumber | core.$ZodBigIntFormat>();
});

test("union mappings and widened declarations retain sound inference", () => {
  function convert(primitives: { long: z.ZodNumber } | {}) {
    const schema = fromAvro("long", { primitives });
    expectTypeOf(schema).toEqualTypeOf<z.ZodNumber | core.$ZodBigIntFormat>();
    return schema;
  }
  function dynamic(source: AvroSchema) {
    return fromAvro(source, { primitives: { long: z.number() } });
  }
  expectTypeOf<core.output<ReturnType<typeof dynamic>>>().toBeUnknown();
  expect(core.parse(convert({}), 1n)).toBe(1n);
  expect(core.parse(convert({ long: z.number() }), 1)).toBe(1);
  expect(core.parse(dynamic("long"), 1)).toBe(1);
});

test.each([
  ["Classic", z.number()],
  ["Mini", mini.number()],
  ["Core", new core.$ZodNumber({ type: "number" })],
] as const)(
  "accepts Zod %s replacements and composes with both public APIs",
  (_name, replacement) => {
    const schema = fromAvro("long", { primitives: { long: replacement } });
    expectTypeOf(schema).toEqualTypeOf<typeof replacement>();
    expect(core.parse(schema, 1)).toBe(1);
    expect(core.safeParse(schema, 1n).success).toBe(false);
    expect(z.parse(z.object({ id: schema }), { id: 1 })).toEqual({ id: 1 });
    expect(mini.parse(mini.object({ id: schema }), { id: 1 })).toEqual({ id: 1 });
  },
);

test("clones isolate Avro metadata and preserve the supplied validator's refinements and description", () => {
  const replacement = z.number().min(0).describe("ID");
  const first = { type: "long", doc: "First" } as const;
  const second = { type: "long", doc: "Second" } as const;
  const source = {
    type: "record",
    name: "Pair",
    fields: [
      { name: "first", type: first },
      { name: "second", type: second },
    ],
  } as const;
  const schema = fromAvro(source, { primitives: { long: replacement } });
  const fields = schema._zod.def.shape;
  const separate = fromAvro("long", { primitives: { long: replacement } });
  expect(fields.first).not.toBe(fields.second);
  expect(fields.first).not.toBe(replacement);
  expect(fields.first).not.toBe(separate);
  expect(fields.first).toBeInstanceOf(z.ZodNumber);
  expect(avroMetadata.get(fields.first)).toEqual({ source: first });
  expect(avroMetadata.get(fields.second)).toEqual({ source: second });
  expect(avroMetadata.get(fields.first)?.source).toBe(first);
  expect(avroMetadata.get(separate)).toEqual({ source: "long" });
  expect(avroMetadata.has(replacement)).toBe(false);
  expect(replacement.description).toBe("ID");
  expect(core.safeParse(fields.first, -1).success).toBe(false);
  expect(z.toJSONSchema(fields.first)).toMatchObject({ description: "ID", minimum: 0 });
});

test("replacements do not inherit Avro provenance from a supplied named validator", () => {
  const source = { type: "enum", name: "Choice", symbols: ["A", "B"] } as const;
  const replacement = fromAvro(source);
  const schema = fromAvro("long", { primitives: { long: replacement } });
  expectTypeOf(schema).toEqualTypeOf<typeof replacement>();
  expect(core.parse(schema, "A")).toBe("A");
  expect(avroMetadata.get(schema)?.source).toBe("long");
  expect(avroMetadata.get(schema)?.fullName).toBeUndefined();
  expect(avroMetadata.get(replacement)).toEqual({ source, fullName: "Choice" });
});

test("invalid override names and values are rejected by TypeScript and at runtime", () => {
  const invalid = { long: z.number(), timestamp: z.number() };
  expect(() => {
    // @ts-expect-error Only Avro primitive names are supported, including in non-literal mappings.
    fromAvro("long", { primitives: invalid });
  }).toThrow('Invalid primitive override "timestamp"');
  expect(() => {
    // @ts-expect-error Replacements must be Zod 4 schemas.
    fromAvro("long", { primitives: { long: 42 } });
  }).toThrow('Invalid primitive override "long": expected a Zod 4 schema');
});

test.each([null, [], 42, "long"])("rejects invalid mapping objects: %j", (primitives) => {
  expect(() => fromAvro("long", { primitives } as FromAvroOptions)).toThrow(
    "Invalid primitive overrides: expected an object",
  );
});

test.each([null, true, 42, {}, { _zod: {} }, () => z.number()])(
  "rejects invalid replacement validators: %j",
  (long) => {
    expect(() => fromAvro("long", { primitives: { long } } as FromAvroOptions)).toThrow(
      'Invalid primitive override "long": expected a Zod 4 schema',
    );
  },
);

test("rejects symbol override names", () => {
  expect(() => {
    // @ts-expect-error Symbol keys are not Avro primitive names.
    fromAvro("long", { primitives: { [Symbol("long")]: z.number() } });
  }).toThrow("expected an Avro primitive");
});

test.each(["unknown", "Choice"])(
  "primitive overrides do not allow unsupported object type %s",
  (type) => {
    const source = [{ type: "enum", name: "Choice", symbols: ["A", "B"] }, { type }] as const;
    expect(() => fromAvro(source as AvroSchema, { primitives: { long: z.number() } })).toThrow(
      `Invalid Avro schema at $[1].type: unsupported type "${type}"; named references must be strings`,
    );
  },
);
