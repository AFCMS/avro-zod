import { describe, expect, expectTypeOf, test } from "vitest";
import * as z from "zod/v4/core";

import { type AvroSchema, avroMetadata, fromAvro } from "./index.ts";

const eventSource = {
  type: "record",
  name: "Event",
  namespace: "demo",
  fields: [
    { name: "id", type: "long" },
    { name: "status", type: { type: "enum", name: "Status", symbols: ["NEW", "DONE"] } },
    { name: "note", type: ["null", "string"], default: null },
  ],
} as const satisfies AvroSchema;

const EventSchema = fromAvro(eventSource);

test("literal records preserve core field validators and input/output inference", () => {
  type Event = z.infer<typeof EventSchema>;
  expectTypeOf<Event>().toEqualTypeOf<{
    id: bigint;
    status: "NEW" | "DONE";
    note: string | null;
  }>();
  expectTypeOf<z.input<typeof EventSchema>>().toEqualTypeOf<Event>();
  expectTypeOf(EventSchema._zod.def.shape.id).toEqualTypeOf<z.$ZodBigIntFormat>();
  expectTypeOf(EventSchema._zod.def.shape.status).toEqualTypeOf<
    z.$ZodEnum<{ NEW: "NEW"; DONE: "DONE" }>
  >();
  expectTypeOf(EventSchema._zod.def.shape.status._zod.def.entries).toEqualTypeOf<{
    NEW: "NEW";
    DONE: "DONE";
  }>();
  expect(Object.values(EventSchema._zod.def.shape.status._zod.def.entries)).toEqual([
    "NEW",
    "DONE",
  ]);

  expect(z.parse(EventSchema, { id: 1n, status: "NEW", note: null })).toEqual({
    id: 1n,
    status: "NEW",
    note: null,
  });
  expect(z.safeParse(EventSchema, { id: 1n, status: "NEW" }).success).toBe(false);
  expect(z.safeParse(EventSchema, { id: 1n, status: "NEW", note: undefined }).success).toBe(false);
  expect(z.safeParse(EventSchema, { id: 1n, status: "NEW", note: null, extra: true }).success).toBe(
    false,
  );
  expect(avroMetadata.get(EventSchema)).toEqual({ source: eventSource, fullName: "demo.Event" });
  expect(avroMetadata.get(EventSchema)?.source).toBe(eventSource);
  expectTypeOf(avroMetadata.get(EventSchema)).toEqualTypeOf<
    { source: unknown; fullName?: string } | undefined
  >();
});

test("widened schemas infer unknown", () => {
  function dynamic(source: AvroSchema) {
    return fromAvro(source);
  }
  const schema = dynamic(eventSource);
  expectTypeOf<z.infer<typeof schema>>().toBeUnknown();
  expect(z.safeParse(schema, { id: 1n, status: "NEW", note: null }).success).toBe(true);

  const fields: { name: string; type: AvroSchema }[] = [{ name: "id", type: "long" }];
  const record = fromAvro({ type: "record", name: "Dynamic", fields });
  expectTypeOf<z.infer<typeof record>>().toBeUnknown();
  const symbols: string[] = ["A", "B"];
  const enumeration = fromAvro({ type: "enum", name: "Dynamic", symbols });
  expectTypeOf<z.infer<typeof enumeration>>().toBeUnknown();
  const branches: AvroSchema[] = ["int", "string"];
  const union = fromAvro(branches);
  expectTypeOf<z.infer<typeof union>>().toBeUnknown();
});

describe("decoded primitive representations", () => {
  test.each([
    ["null", null, undefined],
    ["boolean", true, 1],
    ["int", 42, 42n],
    ["long", 42n, 42],
    ["float", 1.25, "1.25"],
    ["double", 1.25, "1.25"],
    ["bytes", new Uint8Array([1, 2]), [1, 2]],
    ["string", "hello", 123],
  ] as const)("%s works as a string and object declaration", (type, valid, invalid) => {
    for (const source of [type, { type }]) {
      const schema = fromAvro(source);
      expect(z.parse(schema, valid)).toEqual(valid);
      expect(z.safeParse(schema, invalid).success).toBe(false);
      expect(avroMetadata.get(schema)?.source).toBe(source);
    }
  });

  test("int enforces signed 32-bit boundaries", () => {
    const schema = fromAvro("int");
    for (const value of [-2147483648, 0, 2147483647]) expect(z.parse(schema, value)).toBe(value);
    for (const value of [-2147483649, 2147483648, 0.5, NaN, Infinity, -Infinity, 0n]) {
      expect(z.safeParse(schema, value).success).toBe(false);
    }
  });

  test("long enforces signed 64-bit bigint boundaries", () => {
    const schema = fromAvro("long");
    for (const value of [-(2n ** 63n), 0n, 2n ** 63n - 1n])
      expect(z.parse(schema, value)).toBe(value);
    for (const value of [-(2n ** 63n) - 1n, 2n ** 63n, 1, "1"]) {
      expect(z.safeParse(schema, value).success).toBe(false);
    }
  });

  test.each(["float", "double"] as const)("%s accepts all JavaScript numbers", (type) => {
    const schema = fromAvro(type);
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<number>();
    for (const value of [NaN, Infinity, -Infinity, -0, Number.MAX_VALUE, Number.MIN_VALUE]) {
      expect(z.parse(schema, value)).toBe(value);
    }
    for (const value of ["1", 1n, null, undefined])
      expect(z.safeParse(schema, value).success).toBe(false);
  });
});

test("fixed validates Uint8Array byte length", () => {
  const schema = fromAvro({ type: "fixed", name: "Hash", size: 2 });
  expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<Uint8Array>();
  expect(z.parse(schema, new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]));
  expect(z.parse(schema, new Uint8Array(new ArrayBuffer(8), 2, 2)).byteLength).toBe(2);
  for (const value of [new Uint8Array(1), new Uint8Array(3), [1, 2], new ArrayBuffer(2)]) {
    expect(z.safeParse(schema, value).success).toBe(false);
  }
  expect(z.parse(fromAvro({ type: "fixed", name: "Empty", size: 0 }), new Uint8Array())).toEqual(
    new Uint8Array(),
  );
});

test("enums enforce their symbols and retain named metadata", () => {
  const source = {
    type: "enum",
    name: "State",
    namespace: "demo",
    symbols: ["NEW", "DONE"],
    default: "NEW",
  } as const satisfies AvroSchema;
  const schema = fromAvro(source);
  expect(z.parse(schema, "DONE")).toBe("DONE");
  expect(z.safeParse(schema, "OTHER").success).toBe(false);
  expect(z.safeParse(schema, undefined).success).toBe(false);
  expect(avroMetadata.get(schema)).toEqual({ source, fullName: "demo.State" });
  expect(
    z.safeParse(fromAvro({ type: "enum", name: "Empty", symbols: [] }), "anything").success,
  ).toBe(false);
});

test("nested arrays and maps retain child schema types", () => {
  const schema = fromAvro({
    type: "array",
    items: { type: "map", values: { type: "array", items: "int" } },
  });
  expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<Record<string, number[]>[]>();
  expectTypeOf(
    schema._zod.def.element._zod.def.valueType._zod.def.element,
  ).toEqualTypeOf<z.$ZodNumberFormat>();
  expect(z.parse(schema, [{ first: [1, 2], second: [] }])).toEqual([{ first: [1, 2], second: [] }]);
  expect(z.safeParse(schema, [{ first: [2147483648] }]).success).toBe(false);
  expect(z.safeParse(schema, [{ first: ["1"] }]).success).toBe(false);
});

test("unwrapped unions preserve order and permit overlapping representations", () => {
  const source = ["int", "float", "double", "long"] as const satisfies AvroSchema;
  const schema = fromAvro(source);
  expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<number | bigint>();
  expectTypeOf(schema._zod.def.options[0]).toEqualTypeOf<z.$ZodNumberFormat>();
  expect(schema._zod.def.options.map((branch) => avroMetadata.get(branch)?.source)).toEqual(source);
  expect(avroMetadata.get(schema)?.source).toBe(source);
  for (const value of [1, 1.5, NaN, Infinity, 1n]) expect(z.parse(schema, value)).toBe(value);

  const overlapping = fromAvro(["string", { type: "enum", name: "Choice", symbols: ["A", "B"] }]);
  expect(z.parse(overlapping, "A")).toBe("A");
  expect(z.parse(overlapping, "other")).toBe("other");
  expect(z.safeParse(overlapping, { string: "A" }).success).toBe(false);
  expect(z.parse(fromAvro(["int"]), 1)).toBe(1);
  const records = fromAvro([
    { type: "record", name: "A", fields: [] },
    { type: "record", name: "B", fields: [] },
  ]);
  expect(z.parse(records, {})).toEqual({});
});

test("named validators are reused without replacing their metadata", () => {
  const source = {
    type: "record",
    name: "Container",
    namespace: "demo",
    aliases: ["OldContainer"],
    doc: "A container",
    fields: [
      {
        name: "first",
        type: { type: "enum", name: "Status", symbols: ["A", "B"], doc: "Status values" },
        doc: "First field",
      },
      {
        name: "second",
        type: "Status",
        aliases: ["oldSecond"],
        default: "A",
        order: "descending",
        doc: "Second field",
      },
      { name: "third", type: "demo.Status" },
    ],
  } as const satisfies AvroSchema;
  const schema = fromAvro(source);
  expectTypeOf<z.infer<typeof schema._zod.def.shape.second>>().toBeUnknown();
  expect(schema._zod.def.shape.first).toBe(schema._zod.def.shape.second);
  expect(schema._zod.def.shape.first).toBe(schema._zod.def.shape.third);
  expect(avroMetadata.get(schema._zod.def.shape.first)).toEqual({
    source: source.fields[0].type,
    fullName: "demo.Status",
  });
  expect(avroMetadata.get(schema)?.source).toBe(source);
  expect(z.parse(schema, { first: "A", second: "B", third: "A" })).toEqual({
    first: "A",
    second: "B",
    third: "A",
  });
  expect(z.safeParse(schema, { first: "A", third: "A" }).success).toBe(false);
  expect(z.safeParse(schema, { first: "A", second: "C", third: "A" }).success).toBe(false);
});

test("dotted names override namespaces and nested names inherit their enclosing namespace", () => {
  const schema = fromAvro({
    type: "record",
    name: "demo.Outer",
    namespace: "ignored",
    fields: [
      {
        name: "nested",
        type: {
          type: "record",
          name: "Inner",
          fields: [
            { name: "value", type: { type: "fixed", name: "Value", size: 1 } },
            { name: "copy", type: "Value" },
          ],
        },
      },
      { name: "again", type: "Inner" },
      { name: "empty", type: { type: "record", name: "Empty", namespace: "", fields: [] } },
    ],
  });
  expect(avroMetadata.get(schema)?.fullName).toBe("demo.Outer");
  expect(avroMetadata.get(schema._zod.def.shape.nested)?.fullName).toBe("demo.Inner");
  expect(avroMetadata.get(schema._zod.def.shape.nested._zod.def.shape.value)?.fullName).toBe(
    "demo.Value",
  );
  expect(avroMetadata.get(schema._zod.def.shape.empty)?.fullName).toBe("Empty");
  expect(schema._zod.def.shape.nested).toBe(schema._zod.def.shape.again);
  expect(schema._zod.def.shape.nested._zod.def.shape.value).toBe(
    schema._zod.def.shape.nested._zod.def.shape.copy,
  );
});

test("recursive records resolve through lazy references and validate descendants", () => {
  const source = {
    type: "record",
    name: "Node",
    namespace: "tree",
    fields: [
      { name: "value", type: "int" },
      { name: "next", type: ["null", "Node"] },
    ],
  } as const satisfies AvroSchema;
  const schema = fromAvro(source);
  expect(schema._zod.def.shape.next._zod.def.options[1]).toBeInstanceOf(z.$ZodLazy);
  expect(avroMetadata.get(schema._zod.def.shape.next._zod.def.options[1])).toEqual({
    source: "Node",
    fullName: "tree.Node",
  });
  const value = { value: 1, next: { value: 2, next: null } };
  expect(z.parse(schema, value)).toEqual(value);
  expect(z.safeParse(schema, { value: 1, next: { value: "bad", next: null } }).success).toBe(false);
  expect(z.safeParse(schema, { value: 1, next: { value: 2 } }).success).toBe(false);
  expect(
    z.safeParse(schema, { value: 1, next: { value: 2, next: null, extra: true } }).success,
  ).toBe(false);
});

test("nested records can refer lazily to enclosing records", () => {
  const schema = fromAvro({
    type: "record",
    name: "Outer",
    fields: [
      {
        name: "inner",
        type: {
          type: "record",
          name: "Inner",
          fields: [{ name: "outer", type: ["null", "Outer"] }],
        },
      },
      { name: "copy", type: "Inner" },
    ],
  });
  const value = {
    inner: { outer: { inner: { outer: null }, copy: { outer: null } } },
    copy: { outer: null },
  };
  expect(z.parse(schema, value)).toEqual(value);
});

test("recursive references resolve inside arrays and maps", () => {
  const schema = fromAvro({
    type: "record",
    name: "Tree",
    fields: [
      { name: "children", type: { type: "array", items: "Tree" } },
      { name: "byName", type: { type: "map", values: "Tree" } },
    ],
  });
  const leaf = { children: [], byName: {} };
  const value = { children: [leaf], byName: { leaf } };
  expect(z.parse(schema, value)).toEqual(value);
  expect(z.safeParse(schema, { children: [{}], byName: {} }).success).toBe(false);
  expect(z.safeParse(schema, { children: [], byName: { leaf: {} } }).success).toBe(false);
});

test("logical types retain annotations and validate their underlying representation", () => {
  const source = {
    type: "long",
    logicalType: "timestamp-millis",
    doc: "Created at",
  } as const satisfies AvroSchema;
  const schema = fromAvro(source);
  expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<bigint>();
  expect(z.parse(schema, 123n)).toBe(123n);
  expect(z.safeParse(schema, new Date()).success).toBe(false);
  expect(avroMetadata.get(schema)?.source).toBe(source);
  const decimal = fromAvro({ type: "bytes", logicalType: "decimal", precision: 8, scale: 2 });
  expect(z.parse(decimal, new Uint8Array([1]))).toEqual(new Uint8Array([1]));
  expect(z.parse(fromAvro({ type: "string", logicalType: "unknown" }), "value")).toBe("value");
});

describe("declaration errors include the source path", () => {
  test.each([
    [null, "$", "schema object"],
    [42, "$", "schema object"],
    [{}, "$.type", "type name"],
    [{ type: "record", name: "Bad-Name", fields: [] }, "$.name", "Avro name"],
    [{ type: "record", name: "int", fields: [] }, "$.name", "primitive"],
    [
      { type: "record", name: "Record", namespace: "bad..namespace", fields: [] },
      "$.namespace",
      "Avro name",
    ],
    [{ type: "record", name: "Record", namespace: null, fields: [] }, "$.namespace", "Avro name"],
    [{ type: "record", name: "Record" }, "$.fields", "array"],
    [
      { type: "record", name: "Record", fields: [{ name: "missing" }] },
      "$.fields[0].type",
      "schema object",
    ],
    [
      { type: "record", name: "Record", fields: [{ name: "bad-name", type: "int" }] },
      "$.fields[0].name",
      "Avro name",
    ],
    [
      {
        type: "record",
        name: "Record",
        fields: [
          { name: "a", type: "int" },
          { name: "a", type: "long" },
        ],
      },
      "$.fields[1].name",
      "duplicate field",
    ],
    [{ type: "enum", name: "Enum", symbols: ["A", "A"] }, "$.symbols[1]", "duplicate enum"],
    [{ type: "enum", name: "Enum", symbols: ["bad-symbol"] }, "$.symbols[0]", "Avro name"],
    [{ type: "enum", name: "Enum", symbols: ["A"], default: "B" }, "$.default", "enum default"],
    [{ type: "fixed", name: "Fixed", size: -1 }, "$.size", "byte length"],
    [{ type: "fixed", name: "Fixed", size: 1.5 }, "$.size", "byte length"],
    [{ type: "fixed", name: "Fixed", size: NaN }, "$.size", "byte length"],
    [{ type: "array" }, "$.items", "schema object"],
    [{ type: "map" }, "$.values", "schema object"],
    [[], "$", "at least one branch"],
    [["int", ["string", "null"]], "$[1]", "immediately contain"],
    [["int", { type: "int", logicalType: "date" }], "$[1]", "duplicate union branch"],
    [
      [
        { type: "array", items: "int" },
        { type: "array", items: "string" },
      ],
      "$[1]",
      "duplicate union branch",
    ],
    [
      [
        { type: "map", values: "int" },
        { type: "map", values: "string" },
      ],
      "$[1]",
      "duplicate union branch",
    ],
    [[{ type: "record", name: "A", fields: [] }, "A"], "$[1]", "duplicate union branch"],
    [
      [
        { type: "record", name: "A", fields: [] },
        { type: "enum", name: "A", symbols: ["X"] },
      ],
      "$[1].name",
      "duplicate definition",
    ],
    [
      [
        { type: "fixed", name: "A", namespace: "demo", size: 1 },
        { type: "record", name: "demo.A", fields: [] },
      ],
      "$[1].name",
      "duplicate definition",
    ],
    ["Missing", "$", "unresolved or forward reference"],
    [
      {
        type: "record",
        name: "Record",
        namespace: "demo",
        fields: [{ name: "a", type: "Missing" }],
      },
      "$.fields[0].type",
      '"demo.Missing"',
    ],
    [
      {
        type: "record",
        name: "Record",
        fields: [
          { name: "a", type: "Later" },
          { name: "b", type: { type: "record", name: "Later", fields: [] } },
        ],
      },
      "$.fields[0].type",
      "forward reference",
    ],
  ])("rejects malformed declaration %#", (source, path, reason) => {
    const convert = () => fromAvro(source as AvroSchema);
    expect(convert).toThrow(`Invalid Avro schema at ${path}:`);
    expect(convert).toThrow(reason);
  });

  test("definitions do not leak between conversions", () => {
    fromAvro({ type: "record", name: "Local", fields: [] });
    expect(() => fromAvro("Local")).toThrow('unresolved or forward reference "Local"');
  });

  test("short references use the enclosing namespace", () => {
    expect(() =>
      fromAvro({
        type: "record",
        name: "Outer",
        namespace: "outer",
        fields: [
          {
            name: "defined",
            type: { type: "record", name: "Inner", namespace: "other", fields: [] },
          },
          { name: "wrong", type: "Inner" },
        ],
      }),
    ).toThrow('unresolved or forward reference "outer.Inner"');
  });
});
