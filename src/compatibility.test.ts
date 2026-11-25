import { expect, expectTypeOf, test } from "vitest";
import * as classic from "zod/v4";
import * as core from "zod/v4/core";
import * as mini from "zod/v4/mini";

import { type AvroSchema, avroMetadata, fromAvro } from "./index.ts";

const source = {
  type: "record",
  name: "Event",
  fields: [
    { name: "id", type: "long" },
    { name: "status", type: { type: "enum", name: "Status", symbols: ["NEW", "DONE"] } },
  ],
} as const satisfies AvroSchema;

test.each([
  ["Classic", classic],
  ["Mini", mini],
] as const)("core validators compose with Zod %s", (_name, z) => {
  const event = fromAvro(source);
  const schema = z.object({
    event,
    tags: z.array(fromAvro("string")),
    count: z.optional(fromAvro("int")),
  });
  type Expected = {
    event: { id: bigint; status: "NEW" | "DONE" };
    tags: string[];
    count?: number;
  };
  expectTypeOf<core.input<typeof schema>>().toEqualTypeOf<Expected>();
  expectTypeOf<core.output<typeof schema>>().toEqualTypeOf<Expected>();
  expectTypeOf<core.output<typeof event>>().toEqualTypeOf<{
    id: bigint;
    status: "NEW" | "DONE";
  }>();

  const value = { event: { id: 1n, status: "NEW" }, tags: ["avro"], count: 2 };
  expect(z.parse(schema, value)).toEqual(value);
  expect(z.safeParse(schema, { ...value, event: { id: 1, status: "NEW" } }).success).toBe(false);
  expect(z.safeParse(schema, { ...value, event: { ...value.event, extra: true } }).success).toBe(
    false,
  );
  expect(z.safeParse(schema, { ...value, tags: [1] }).success).toBe(false);
  expect(z.safeParse(schema, { ...value, count: 2147483648 }).success).toBe(false);
  expect(avroMetadata.get(event)).toEqual({ source, fullName: "Event" });

  const fields = event._zod.def.shape;
  const picked = z.object({ status: fields.status });
  const extended = z.object({ ...fields, count: z.number() });
  expectTypeOf<core.output<typeof picked>>().toEqualTypeOf<{ status: "NEW" | "DONE" }>();
  expectTypeOf<core.output<typeof extended>>().toEqualTypeOf<{
    id: bigint;
    status: "NEW" | "DONE";
    count: number;
  }>();
  expect(z.parse(picked, { status: "DONE" })).toEqual({ status: "DONE" });
  expect(z.parse(extended, { ...value.event, count: 2 }).count).toBe(2);
});

test.each([
  ["Core", core],
  ["Classic", classic],
  ["Mini", mini],
] as const)("Zod %s supports sync and async parsing of core validators", async (_name, z) => {
  const schema = fromAvro({
    type: "record",
    name: "Node",
    fields: [
      { name: "data", type: { type: "fixed", name: "Data", size: 2 } },
      { name: "children", type: { type: "array", items: "Node" } },
    ],
  });
  const leaf = { data: new Uint8Array([1, 2]), children: [] };
  const valid = { ...leaf, children: [leaf] };
  const invalid = { ...leaf, children: [{ data: new Uint8Array(1), children: [] }] };

  expect(z.parse(schema, valid)).toEqual(valid);
  expect(z.safeParse(schema, invalid).success).toBe(false);
  await expect(z.parseAsync(schema, valid)).resolves.toEqual(valid);
  await expect(z.parseAsync(schema, invalid)).rejects.toBeInstanceOf(core.$ZodError);
  expect((await z.safeParseAsync(schema, invalid)).success).toBe(false);
});
