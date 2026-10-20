const required = ["schemaVersion", "id", "text", "language", "attribution"];
const attributionRequired = ["speaker", "work", "sourceUrl"];

function hasKeys(value, requiredKeys, optionalKeys = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    keys.every(
      (key) => requiredKeys.includes(key) || optionalKeys.includes(key),
    )
  );
}

function plainText(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function sourceUrl(value) {
  if (!plainText(value, 2048) || !value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

/** Strict contract for the JSON body of GET /api/v1/quote. */
export function validateQuote(value) {
  if (!hasKeys(value, required)) return false;
  if (value.schemaVersion !== 1 || value.language !== "ru") return false;
  if (
    !plainText(value.id, 80) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id)
  ) {
    return false;
  }
  if (!plainText(value.text, 500)) return false;
  const attribution = value.attribution;
  if (!hasKeys(attribution, attributionRequired, ["season", "episode"])) {
    return false;
  }
  if (
    !plainText(attribution.speaker, 120) ||
    !plainText(attribution.work, 120)
  ) {
    return false;
  }
  if (!sourceUrl(attribution.sourceUrl)) return false;
  return ["season", "episode"].every(
    (key) =>
      !Object.hasOwn(attribution, key) ||
      (Number.isSafeInteger(attribution[key]) && attribution[key] > 0),
  );
}
