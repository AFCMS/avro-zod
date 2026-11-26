# @afcms/avro-zod

Convert Apache Avro schema declarations into Zod 4 validators for decoded JavaScript values.

```sh
pnpm add @afcms/avro-zod zod
```

Works with Zod Classic and Zod Mini. Generated schemas use Zod Core, so validate with top-level functions such as `z.parse(schema, value)`.

## Usage

```ts
import { fromAvro, type AvroSchema } from "@afcms/avro-zod";
import * as z from "zod/v4"; // or "zod/v4/mini"

const source = {
  type: "record",
  name: "Event",
  doc: "An event",
  fields: [
    { name: "id", type: "long", doc: "Event identifier" },
    { name: "message", type: "string" },
  ],
} as const satisfies AvroSchema;

const EventSchema = fromAvro(source);
type Event = z.infer<typeof EventSchema>;
// { id: bigint; message: string }

z.parse(EventSchema, { id: 1n, message: "Hello" });
```

## Options

```ts
const schema = fromAvro(source, {
  primitives: { long: z.number() },
  metadata: { description: true, title: true },
});

z.parse(schema, { id: 123, message: "Hello" });
z.toJSONSchema(schema);
// Includes title: "Event", description: "An event",
// and properties.id.description: "Event identifier".
```

- `primitives` replaces validators for selected Avro primitives throughout the schema. Other primitives keep their defaults.
- `metadata.description` maps Avro `doc` annotations to descriptions. Field docs take precedence over type docs.
- `metadata.title` uses named type fullnames as titles. Both metadata flags default to `false`.

## Behavior

- Records reject extra keys. All fields are required, including nullable fields and fields with defaults; defaults are not applied.
- `long` uses `bigint`; `bytes` and `fixed` use `Uint8Array`. Primitive overrides change accepted values without converting them.
- Named types and recursive records are supported. Runtime-only declarations and named reference sites infer `unknown`.
- Logical types validate their underlying representation. The package does not decode Avro binary data.

Import `avroMetadata` to access the original declaration and resolved fullname with `avroMetadata.get(schema)`.

JSON Schema export requires representable validators. Default `long`, `float`, `double`, `bytes`, and `fixed` validators cannot be exported directly; see [Zod's JSON Schema documentation](https://zod.dev/json-schema).
