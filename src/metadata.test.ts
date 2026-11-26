import { expect, expectTypeOf, test } from "vitest";
import * as z from "zod/v4";
import * as core from "zod/v4/core";
import * as mini from "zod/v4/mini";

import { type AvroSchema, type FromAvroOptions, avroMetadata, fromAvro } from "./index.ts";

test("metadata is disabled by default and both flags are independently optional", () => {
  const source = {
    type: "record",
    name: "Event",
    namespace: "demo",
    doc: "An event",
    fields: [{ name: "id", type: "int", doc: "Event ID" }],
  } as const satisfies AvroSchema;
  const options = [
    undefined,
    {},
    { metadata: undefined },
    { metadata: {} },
    { metadata: { description: undefined, title: undefined } },
    { metadata: { description: false, title: false } },
  ] as const;
  for (const option of options) {
    const schema = fromAvro(source, option);
    expectTypeOf(schema._zod.def.shape.id).toEqualTypeOf<core.$ZodNumberFormat>();
    expect(core.globalRegistry.get(schema)).toBeUndefined();
    expect(core.globalRegistry.get(schema._zod.def.shape.id)).toBeUndefined();
    expect(z.toJSONSchema(schema)).not.toHaveProperty("description");
    expect(z.toJSONSchema(schema)).not.toHaveProperty("title");
  }
  const described = fromAvro(source, { metadata: { description: true } });
  expect(core.globalRegistry.get(described)).toEqual({ description: "An event" });
  expect(z.toJSONSchema(described)).toMatchObject({
    description: "An event",
    properties: { id: { description: "Event ID" } },
  });
  const titled = fromAvro(source, { metadata: { title: true } });
  expect(core.globalRegistry.get(titled)).toEqual({ title: "demo.Event" });
  expect(core.globalRegistry.get(titled._zod.def.shape.id)).toBeUndefined();
  expect(z.toJSONSchema(titled)).toHaveProperty("title", "demo.Event");
});

test("declaration and field descriptions propagate through nested containers and unions", () => {
  const source = {
    type: "record",
    name: "Container",
    doc: "A container",
    fields: [
      {
        name: "items",
        doc: "Container items",
        type: {
          type: "array",
          doc: "An array",
          items: {
            type: "map",
            doc: "A map",
            values: {
              type: "record",
              name: "Entry",
              doc: "An entry",
              fields: [
                { name: "label", type: { type: "string", doc: "A label" } },
                { name: "note", type: ["null", "string"], doc: "An optional note" },
              ],
            },
          },
        },
      },
    ],
  } as const satisfies AvroSchema;
  const schema = fromAvro(source, { metadata: { description: true } });
  type Expected = { items: Record<string, { label: string; note: string | null }>[] };
  expectTypeOf<core.input<typeof schema>>().toEqualTypeOf<Expected>();
  expectTypeOf<core.output<typeof schema>>().toEqualTypeOf<Expected>();
  const items = schema._zod.def.shape.items;
  expect(core.globalRegistry.get(items)).toEqual({ description: "Container items" });
  expect(avroMetadata.get(items)?.source).toBe(source.fields[0].type);
  expect(z.toJSONSchema(schema)).toMatchObject({
    description: "A container",
    properties: {
      items: {
        description: "Container items",
        items: {
          description: "A map",
          additionalProperties: {
            description: "An entry",
            properties: {
              label: { description: "A label" },
              note: { description: "An optional note" },
            },
          },
        },
      },
    },
  });
  expect(
    z.toJSONSchema(fromAvro(source.fields[0].type, { metadata: { description: true } })),
  ).toHaveProperty("description", "An array");
  const value = { items: [{ first: { label: "one", note: null } }] };
  expect(core.parse(schema, value)).toEqual(value);
  expect(core.safeParse(schema, { items: [{ first: { label: "one" } }] }).success).toBe(false);
});

test("field descriptions are isolated from shared named definitions and other conversions", () => {
  const source = {
    type: "record",
    name: "Container",
    namespace: "demo",
    fields: [
      {
        name: "first",
        doc: "First field",
        type: { type: "enum", name: "Status", symbols: ["A", "B"], doc: "Status values" },
      },
      { name: "second", type: "Status", doc: "Second field" },
      { name: "third", type: "demo.Status" },
      { name: "fourth", type: "Status" },
    ],
  } as const satisfies AvroSchema;
  const schema = fromAvro(source, { metadata: { description: true, title: true } });
  const { first, second, third, fourth } = schema._zod.def.shape;
  expect(first).not.toBe(second);
  expect(first).not.toBe(third);
  expect(second).not.toBe(third);
  expect(third).toBe(fourth);
  expectTypeOf<core.output<typeof second>>().toBeUnknown();
  for (const field of [first, second, third]) {
    expect(avroMetadata.get(field)).toEqual({
      source: source.fields[0].type,
      fullName: "demo.Status",
    });
  }
  expect(z.toJSONSchema(schema)).toMatchObject({
    title: "demo.Container",
    properties: {
      first: { title: "demo.Status", description: "First field" },
      second: { title: "demo.Status", description: "Second field" },
      third: { title: "demo.Status", description: "Status values" },
      fourth: { title: "demo.Status", description: "Status values" },
    },
  });
  const separate = fromAvro(source, { metadata: { description: true, title: true } });
  expect(separate).not.toBe(schema);
  expect(core.globalRegistry.get(separate._zod.def.shape.second)?.description).toBe("Second field");
  const plain = fromAvro(source);
  expect(plain._zod.def.shape.first).toBe(plain._zod.def.shape.second);
  expect(core.globalRegistry.get(plain._zod.def.shape.first)).toBeUndefined();
});

test("titles use resolved fullnames without registering global IDs or renaming fields", () => {
  const source = {
    type: "record",
    name: "actual.Container",
    namespace: "ignored",
    fields: [
      { name: "entry", type: { type: "record", name: "Entry", fields: [] } },
      { name: "hash", type: { type: "fixed", name: "Hash", size: 2, doc: "A hash" } },
    ],
  } as const satisfies AvroSchema;
  for (let index = 0; index < 2; index++) {
    const schema = fromAvro(source, { metadata: { description: true, title: true } });
    expect(core.globalRegistry.get(schema)).toEqual({ title: "actual.Container" });
    expect(core.globalRegistry.get(schema._zod.def.shape.entry)).toEqual({ title: "actual.Entry" });
    expect(core.globalRegistry.get(schema._zod.def.shape.hash)).toEqual({
      title: "actual.Hash",
      description: "A hash",
    });
    expect(core.parse(schema, { entry: {}, hash: new Uint8Array(2) })).toEqual({
      entry: {},
      hash: new Uint8Array(2),
    });
  }
});

test("empty descriptions are preserved and non-string annotations are ignored", () => {
  const source: unknown = {
    type: "record",
    name: "Annotations",
    doc: false,
    fields: [
      { name: "empty", type: { type: "string", doc: "" } },
      { name: "emptyField", type: { type: "string", doc: "Type documentation" }, doc: "" },
      { name: "invalid", type: { type: "string", doc: 42 }, doc: {} },
      { name: "fallback", type: { type: "string", doc: "Type documentation" }, doc: null },
      { name: "plain", type: "string" },
    ],
  };
  const schema = fromAvro(source as AvroSchema, { metadata: { description: true } });
  expect(z.toJSONSchema(schema)).toMatchObject({
    properties: {
      empty: { description: "" },
      emptyField: { description: "" },
      fallback: { description: "Type documentation" },
    },
  });
  const json = z.toJSONSchema(schema);
  expect(json).not.toHaveProperty("description");
  expect(json.properties!.invalid).not.toHaveProperty("description");
  expect(json.properties!.plain).not.toHaveProperty("description");
});

test("recursive descriptions stay on their field occurrences and export valid references", () => {
  const schema = fromAvro(
    {
      type: "record",
      name: "Node",
      doc: "A node",
      fields: [
        { name: "value", type: "string", doc: "Node value" },
        { name: "children", type: { type: "array", items: "Node" }, doc: "Child nodes" },
        { name: "next", type: ["null", "Node"], doc: "Next node" },
        {
          name: "link",
          type: [
            "null",
            {
              type: "record",
              name: "Link",
              fields: [{ name: "parent", type: "Node", doc: "Parent node" }],
            },
          ],
        },
      ],
    },
    { metadata: { description: true, title: true } },
  );
  const json = z.toJSONSchema(schema);
  expect(json).toMatchObject({
    description: "A node",
    title: "Node",
    properties: {
      value: { description: "Node value" },
      children: { description: "Child nodes", items: { $ref: "#" } },
      next: { description: "Next node", anyOf: [{ type: "null" }, { $ref: "#" }] },
      link: {
        anyOf: [{ type: "null" }, { properties: { parent: { description: "Parent node" } } }],
      },
    },
  });
  const parent = schema._zod.def.shape.link._zod.def.options[1]._zod.def.shape.parent;
  expect(core.globalRegistry.get(parent)).toEqual({ description: "Parent node", title: "Node" });
  expect(avroMetadata.get(parent)).toEqual({ source: "Node", fullName: "Node" });
  expect(core.globalRegistry.get(schema)?.description).toBe("A node");
  const leaf = { value: "leaf", children: [], next: null, link: null };
  const value = { value: "root", children: [leaf], next: leaf, link: { parent: leaf } };
  expect(core.parse(schema, value)).toEqual(value);
  expect(core.safeParse(schema, { value: 42 }).success).toBe(false);
});

test.each([
  ["Classic", z],
  ["Mini", mini],
] as const)("metadata exports and composes through Zod %s", (_name, api) => {
  const source = { type: "string", doc: "A string" } as const;
  const options = { metadata: { description: true } } satisfies FromAvroOptions;
  const schema = fromAvro(source, options);
  expectTypeOf(schema).toEqualTypeOf<core.$ZodString<string>>();
  const composed = api.object({ value: schema });
  expect(api.parse(composed, { value: "test" })).toEqual({ value: "test" });
  expect(api.toJSONSchema(composed)).toMatchObject({
    properties: { value: { type: "string", description: "A string" } },
  });
});

test("metadata maps only descriptions and titles without applying defaults or logical formats", () => {
  const schema = fromAvro(
    {
      type: "record",
      name: "Event",
      aliases: ["OldEvent"],
      fields: [
        {
          name: "id",
          type: { type: "string", logicalType: "uuid" },
          default: "not-a-uuid",
          aliases: ["oldId"],
          order: "descending",
        },
        { name: "status", type: { type: "enum", name: "Status", symbols: ["A"], default: "A" } },
      ],
    },
    { metadata: { description: true, title: true } },
  );
  expect(z.toJSONSchema(schema)).toMatchObject({
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["A"], title: "Status" },
    },
    required: ["id", "status"],
  });
  const json = z.toJSONSchema(schema);
  expect(json.properties!.id).not.toHaveProperty("default");
  expect(json.properties!.id).not.toHaveProperty("format");
  expect(json.properties!.status).not.toHaveProperty("default");
  expect(core.safeParse(schema, { status: "A" }).success).toBe(false);
  expect(core.parse(schema, { id: "not-a-uuid", status: "A" })).toEqual({
    id: "not-a-uuid",
    status: "A",
  });
});
