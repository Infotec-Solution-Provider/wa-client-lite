export default function getSerializedId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const id = value as Record<string, unknown>;
  const serializedId = id["_serialized"] ?? id["$1"];

  return typeof serializedId === "string" && serializedId.length > 0
    ? serializedId
    : null;
}
