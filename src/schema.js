/**
 * Parses market page from docs.kie.ai (.md with embedded OpenAPI spec in YAML)
 * → list of input object fields for a model.
 */

const SCALAR_KEYS = [
  "type",
  "format",
  "default",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
];

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function blockAfter(lines, start, indent) {
  const block = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      block.push(line);
      continue;
    }
    if (indentOf(line) <= indent) break;
    block.push(line);
  }
  return block;
}

/**
 * Extracts YAML block containing input fields from markdown page.
 * Returns block text or null.
 */
export function extractInputBlock(markdown) {
  const lines = String(markdown || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)input:\s*$/.exec(lines[i]);
    if (!match) continue;
    const block = blockAfter(lines, i, match[1].length);
    if (block.some((line) => /^\s*properties:\s*$/.test(line))) return block.join("\n");
  }
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*requestBody:\s*$/.test(lines[i])) continue;
    const body = blockAfter(lines, i, indentOf(lines[i]));
    const schemaIdx = body.findIndex((line) => /^\s*schema:\s*$/.test(line));
    if (schemaIdx === -1) continue;
    const block = blockAfter(body, schemaIdx, indentOf(body[schemaIdx]));
    if (block.some((line) => /^\s*properties:\s*$/.test(line))) return block.join("\n");
  }
  return null;
}

function joinDescription(lines) {
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFieldBody(bodyLines) {
  const field = { type: null, description: null, enum: [], default: undefined, constraints: {} };
  if (bodyLines.length === 0) return field;
  const bodyIndent = Math.min(...bodyLines.filter((l) => l.trim()).map(indentOf));

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (!line.trim() || indentOf(line) !== bodyIndent) continue;
    const kv = /^\s*([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();

    if (key === "description") {
      const inline = value.replace(/^[|>][-+]?\s*$/, "");
      const nested = joinDescription(blockAfter(bodyLines, i, bodyIndent));
      field.description = (inline ? `${inline} ${nested}` : nested).trim() || null;
      continue;
    }
    if (key === "enum") {
      for (const item of blockAfter(bodyLines, i, bodyIndent)) {
        const entry = /^\s*-\s+(.*)$/.exec(item);
        if (entry) field.enum.push(entry[1].trim().replace(/^['"]|['"]$/g, ""));
      }
      continue;
    }
    if (key === "items") {
      const itemType = blockAfter(bodyLines, i, bodyIndent).find((l) => /^\s*type:/.test(l));
      if (itemType) field.constraints.items = itemType.split(":")[1].trim();
      continue;
    }
    if (!SCALAR_KEYS.includes(key) || value === "") continue;
    const clean = value.replace(/^['"]|['"]$/g, "");
    if (key === "type") field.type = clean;
    else if (key === "default") field.default = clean;
    else field.constraints[key] = clean;
  }
  return field;
}

/**
 * Input fields from YAML block.
 * Returns [{ name, type, required, description, enum, default, constraints }].
 */
export function parseInputFields(block) {
  if (!block) return [];
  const lines = block.split("\n");

  const propIdx = lines.findIndex((line) => /^\s*properties:\s*$/.test(line));
  if (propIdx === -1) return [];
  const propIndent = indentOf(lines[propIdx]);

  const required = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (indentOf(lines[i]) !== propIndent || !/^\s*required:\s*$/.test(lines[i])) continue;
    for (const item of blockAfter(lines, i, propIndent)) {
      const entry = /^\s*-\s+(.*)$/.exec(item);
      if (entry) required.add(entry[1].trim().replace(/^['"]|['"]$/g, ""));
    }
  }

  const propBody = blockAfter(lines, propIdx, propIndent);
  const nameIndent = propBody.length > 0
    ? Math.min(...propBody.filter((l) => l.trim()).map(indentOf))
    : 0;

  const fields = [];
  for (let i = 0; i < propBody.length; i++) {
    const line = propBody[i];
    if (!line.trim() || indentOf(line) !== nameIndent) continue;
    const match = /^\s*([A-Za-z][\w-]*):\s*$/.exec(line);
    if (!match) continue;
    const name = match[1];
    const parsed = parseFieldBody(blockAfter(propBody, i, nameIndent));
    fields.push({
      name,
      type: parsed.type,
      required: required.has(name),
      description: parsed.description,
      enum: parsed.enum,
      default: parsed.default ?? null,
      constraints: parsed.constraints,
    });
  }
  return fields;
}

/** Markdown page → { fields, block }. */
export function extractInputSchema(markdown) {
  const block = extractInputBlock(markdown);
  return { fields: parseInputFields(block), block };
}

const PROMPT_FIELDS = ["prompt", "text", "input_text", "description"];
const IMAGE_FIELDS = [
  "image_urls",
  "input_urls",
  "image_url",
  "input_url",
  "imageUrls",
  "imageUrl",
  "filesUrl",
  "inputImage",
  "first_frame_url",
  "reference_image_urls",
  "image",
];
const IGNORED_REQUIRED = new Set(["callBackUrl", "callbackUrl"]);

/**
 * Derives model metadata from schema: prompt_field, image_field, required fields, defaults.
 */
export function deriveModelMeta(fields) {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const promptField = PROMPT_FIELDS.find((name) => byName.has(name)) || null;
  const imageField = IMAGE_FIELDS.find((name) => byName.has(name)) || null;

  const required = [];
  const defaults = {};
  for (const field of fields) {
    if (!field.required || IGNORED_REQUIRED.has(field.name)) continue;
    required.push(field.name);
    if (field.default !== null && field.default !== undefined) {
      defaults[field.name] = coerceDefault(field);
    }
  }
  return {
    prompt_field: promptField,
    image_field: imageField,
    image_list: imageField ? byName.get(imageField).type === "array" : false,
    required,
    defaults,
    fields: fields.map((f) => f.name),
  };
}

function coerceDefault(field) {
  const raw = String(field.default);
  if (field.type === "boolean") return raw === "true";
  if (field.type === "number" || field.type === "integer") {
    const num = Number(raw);
    return Number.isFinite(num) ? num : raw;
  }
  return raw;
}

/** One-line field description for human-readable output. */
export function formatField(field) {
  const parts = [];
  if (field.type) parts.push(field.type === "array" && field.constraints.items
    ? `array<${field.constraints.items}>`
    : field.type);
  if (field.enum.length > 0) parts.push(field.enum.join(" | "));
  const { minimum, maximum, minLength, maxLength, maxItems } = field.constraints;
  if (minimum !== undefined || maximum !== undefined) parts.push(`${minimum ?? ""}..${maximum ?? ""}`);
  if (minLength !== undefined || maxLength !== undefined) {
    parts.push(`length ${minLength ?? ""}..${maxLength ?? ""}`);
  }
  if (maxItems !== undefined) parts.push(`up to ${maxItems}`);
  if (field.default !== null && field.default !== undefined) parts.push(`default ${field.default}`);
  return parts.join(", ");
}
