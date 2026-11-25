# @afcms/avro-zod

Convert Apache Avro schema declarations into Zod 4 validators for decoded JavaScript values.

```ts
import { avroMetadata, fromAvro, type AvroSchema } from "@afcms/avro-zod";
import * as z from "zod/v4/core";

const EventSchema = fromAvro({
  type: "record",
  name: "Event",
  namespace: "demo",
  fields: [
    { name: "id", type: "long" },
    { name: "status", type: { type: "enum", name: "Status", symbols: ["NEW", "DONE"] } },
    { name: "note", type: ["null", "string"], default: null },
  ],
} as const satisfies AvroSchema);

type Event = z.infer<typeof EventSchema>;
// { id: bigint; status: "NEW" | "DONE"; note: string | null }

z.parse(EventSchema, { id: 1n, status: "NEW", note: null });
EventSchema._zod.def.shape.status._zod.def.entries; // { NEW: "NEW"; DONE: "DONE" }
avroMetadata.get(EventSchema)?.fullName; // "demo.Event"
avroMetadata.get(EventSchema)?.source; // original declaration, typed as unknown
```

Records reject extra keys. Every field is required, including nullable fields and fields with defaults; defaults are retained as annotations. `int` uses signed 32-bit numbers, `long` uses signed 64-bit `bigint`, and `float`/`double` accept all JavaScript numbers, including `NaN` and infinities. `bytes` and `fixed` use `Uint8Array`.

Unions accept unwrapped values in declaration order, including overlapping branches. Named definitions are scoped to each conversion and resolved by fullname or the enclosing namespace; recursive records work, while unresolved and forward references throw errors with declaration paths. Aliases are retained as annotations rather than used for schema evolution or reference lookup.

Requires Zod `^4.0.0`. The package imports only `zod/v4/core` and returns Core schemas that compose with both Zod Classic (`zod/v4`) and Zod Mini (`zod/v4/mini`). Use their top-level `parse`, `safeParse`, `parseAsync`, or `safeParseAsync` functions to validate values.

Generated Core schemas expose their definitions through `_zod.def` and preserve literal child types, input types, and output types. Core schemas have no Classic instance methods such as `.parse()`, `.pick()`, or `.extend()`. To select or extend fields, build a new object schema with your preferred Zod API:

```ts
import * as z from "zod/v4/mini"; // or "zod/v4"

const fields = EventSchema._zod.def.shape;
const StatusSchema = z.object({ status: fields.status });
const ExtendedEventSchema = z.strictObject({ ...fields, count: z.number() });
// Inference preserves the original field types, including "NEW" | "DONE".
```

Migrating from earlier versions: replace `schema.parse(value)` with `z.parse(schema, value)`, `schema.shape` with `schema._zod.def.shape`, and union `schema.options` with `schema._zod.def.options`. Enum symbols are available through `Object.values(schema._zod.def.entries)`.

Schemas whose structure is only known at runtime, and named reference sites, infer `unknown`; references still validate against their resolved schema at runtime. The exported `ToZod<S, M>` type describes this mapping, with an optional primitive override mapping `M`.

To change primitive validators, pass a partial `primitives` mapping. For example, replace `long` with a number validator so it can be exported to JSON Schema:

```ts
import { fromAvro, type PrimitiveOverrides } from "@afcms/avro-zod";
import * as z from "zod/v4"; // or "zod/v4/mini"

const primitives = { long: z.number() } satisfies PrimitiveOverrides;
const NumericEventSchema = fromAvro(
  {
    type: "record",
    name: "Event",
    fields: [{ name: "id", type: "long" }],
  },
  { primitives },
);

type NumericEvent = z.infer<typeof NumericEventSchema>; // { id: number }
z.parse(NumericEventSchema, { id: 123 });
z.toJSONSchema(NumericEventSchema); // properties.id.type === "number"
```

Supported keys are `null`, `boolean`, `int`, `long`, `float`, `double`, `bytes`, and `string`. Omitted or `undefined` entries retain the defaults. Each replacement is the entire validator, including its constraints, and applies to string declarations, object declarations, logical types, and descendants throughout the conversion. Avro union identity is unchanged even if two branches use the same replacement.

Replacements can come from Zod Classic, Mini, or Core. Their exact schema class and input/output types are preserved, including transforms, while generated containers remain Core schemas. Use `satisfies PrimitiveOverrides` when checking reusable mappings to preserve their specific types. The exported `FromAvroOptions<M>` type describes options; optional overrides infer both their replacement and default possibilities. Widened Avro declarations and named reference sites retain their existing `unknown` inference.

Replacement validators are cloned for each primitive declaration so their Avro metadata does not overwrite another declaration's metadata or modify the supplied validator. A `bytes` override does not affect named `fixed` validators, which still require a `Uint8Array` of the declared length. A `string` override applies to map values declared as strings; map keys remain strings.

Replacing `long` with `z.number()` accepts numbers instead of `bigint`; it does not convert existing values. Use `z.int()` for safe integers. JavaScript numbers cannot precisely represent the full signed 64-bit range. JSON Schema conversion also requires representable validators for any other fields: the default custom `float`, `double`, `bytes`, and `fixed` validators cannot be exported directly. See [Zod's JSON Schema documentation](https://zod.dev/json-schema).

Logical types validate their underlying Avro representation. Their annotations, along with defaults, aliases, docs, and field order, remain in `avroMetadata` as `{ source: unknown; fullName?: string }`. Field annotations live on the parent record's source because several fields can share one named validator. This package does not decode Avro binary or tagged JSON data, apply defaults, or convert logical values into objects such as `Date`.
