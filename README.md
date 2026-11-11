# @afcms/avro-zod

Convert Apache Avro schema declarations into Zod 4 validators for decoded JavaScript values.

```ts
import { avroMetadata, fromAvro, type AvroSchema } from "@afcms/avro-zod";
import { z } from "zod";

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

EventSchema.parse({ id: 1n, status: "NEW", note: null });
EventSchema.shape.status.options; // ("NEW" | "DONE")[]
EventSchema.pick({ status: true }); // retains the enum's symbol union
avroMetadata.get(EventSchema)?.fullName; // "demo.Event"
avroMetadata.get(EventSchema)?.source; // original declaration, typed as unknown
```

Records reject extra keys. Every field is required, including nullable fields and fields with defaults; defaults are retained as annotations. `int` uses signed 32-bit numbers, `long` uses signed 64-bit `bigint`, and `float`/`double` accept all JavaScript numbers, including `NaN` and infinities. `bytes` and `fixed` use `Uint8Array`.

Unions accept unwrapped values in declaration order, including overlapping branches. Named definitions are scoped to each conversion and resolved by fullname or the enclosing namespace; recursive records work, while unresolved and forward references throw errors with declaration paths. Aliases are retained as annotations rather than used for schema evolution or reference lookup.

Literal schemas preserve Zod child types and object methods. Schemas whose structure is only known at runtime, and named reference sites, infer `unknown`; references still validate against their resolved schema at runtime. The exported `ToZod<S>` type describes this mapping.

Logical types validate their underlying Avro representation. Their annotations, along with defaults, aliases, docs, and field order, remain in `avroMetadata` as `{ source: unknown; fullName?: string }`. Field annotations live on the parent record's source because several fields can share one named validator. This package does not decode Avro binary or tagged JSON data, apply defaults, or convert logical values into objects such as `Date`.
