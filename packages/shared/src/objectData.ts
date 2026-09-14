import { z } from "zod";

/**
 * Canvas object type enum and per-type `data` validation.
 *
 * Lives in its own module (rather than inline in events.ts, where the enum
 * used to be defined) because `ObjectUpsertEventSchema` needs to validate
 * `data` conditionally on `type` — putting both in events.ts would create an
 * import cycle the moment events.ts needed this file's helpers.
 *
 * `data` stays a plain `z.record(z.unknown())` at the ObjectUpsertEventSchema
 * boundary (matching ObjectState's wire shape) rather than a Zod discriminated
 * union keyed off `type`, because `type`/`data` are sibling top-level fields,
 * not a tagged union shape. events.ts's `.superRefine` calls
 * `validateObjectData` below to do the conditional check instead.
 */
export const CanvasObjectTypeSchema = z.enum([
  "note",
  "image",
  "link",
  "embed",
  "shape",
  "zone",
]);
export type CanvasObjectType = z.infer<typeof CanvasObjectTypeSchema>;

/** Hard cap on the serialized size of any object's `data`, independent of
 *  the per-field limits below — the two combined are what prevent a
 *  malicious or buggy client from storing unbounded JSON in a room. */
export const MAX_OBJECT_DATA_BYTES = 8192;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const hexColor = () => z.string().regex(HEX_COLOR, "Must be a #rrggbb hex color");

/** Only https URLs are accepted for anything a client will later render as
 *  a live link or an <img> src — never http (mixed content) and never a
 *  javascript:/data: URL a link card could otherwise be tricked into
 *  treating as navigable. */
const httpsUrl = (maxLength: number) =>
  z
    .string()
    .max(maxLength)
    .refine((value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    }, "Must be an https:// URL");

export const NOTE_COLORS = ["yellow", "pink", "blue", "green", "purple"] as const;
export const NoteDataSchema = z.object({
  text: z.string().max(4000).default(""),
  color: z.enum(NOTE_COLORS).default("yellow"),
});
export type NoteData = z.infer<typeof NoteDataSchema>;

export const ImageDataSchema = z.object({
  url: httpsUrl(2048),
  alt: z.string().max(300).optional(),
});
export type ImageData = z.infer<typeof ImageDataSchema>;

export const LinkDataSchema = z.object({
  url: httpsUrl(2048),
  title: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
});
export type LinkData = z.infer<typeof LinkDataSchema>;

export const SHAPE_KINDS = ["rect", "ellipse", "triangle"] as const;
export const ShapeDataSchema = z.object({
  kind: z.enum(SHAPE_KINDS).default("rect"),
  fill: hexColor().default("#4f8cff"),
  stroke: hexColor().default("#ffffff"),
  strokeWidth: z.number().min(0).max(32).default(2),
});
export type ShapeData = z.infer<typeof ShapeDataSchema>;

export const ZoneDataSchema = z.object({
  label: z.string().max(100).default(""),
  color: hexColor().default("#50c878"),
});
export type ZoneData = z.infer<typeof ZoneDataSchema>;

/** `embed` is not implemented this phase (see the approved plan's "out of
 *  scope" section) — the type stays in the enum so the column/contract
 *  don't need to change later, but there is no dedicated data shape yet.
 *  Accepted permissively (still subject to MAX_OBJECT_DATA_BYTES); the
 *  client factory renders an inert placeholder rather than crashing on it. */
export const EmbedDataSchema = z.record(z.unknown());
export type EmbedData = z.infer<typeof EmbedDataSchema>;

function schemaForType(type: CanvasObjectType) {
  switch (type) {
    case "note":
      return NoteDataSchema;
    case "image":
      return ImageDataSchema;
    case "link":
      return LinkDataSchema;
    case "shape":
      return ShapeDataSchema;
    case "zone":
      return ZoneDataSchema;
    case "embed":
      return EmbedDataSchema;
  }
}

export type ObjectDataValidationResult =
  | { valid: true }
  | { valid: false; message: string };

/**
 * Validates a canvas object's `data` against its type's shape AND the
 * overall size cap. Called from ObjectUpsertEventSchema's superRefine
 * (events.ts) — the single validation point at the socket ingress, matching
 * how every other event schema in this file is the sole gate for its event.
 */
export function validateObjectData(type: CanvasObjectType, data: unknown): ObjectDataValidationResult {
  let serializedLength: number;
  try {
    serializedLength = JSON.stringify(data).length;
  } catch {
    return { valid: false, message: "data is not serializable" };
  }
  if (serializedLength > MAX_OBJECT_DATA_BYTES) {
    return { valid: false, message: `data exceeds ${MAX_OBJECT_DATA_BYTES} bytes` };
  }

  const result = schemaForType(type).safeParse(data);
  if (!result.success) {
    return { valid: false, message: `Invalid data for type "${type}": ${result.error.message}` };
  }
  return { valid: true };
}
