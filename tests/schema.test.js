import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveModelMeta,
  extractInputBlock,
  extractInputSchema,
  formatField,
  parseInputFields,
} from "../src/schema.js";
import { mergeModelMeta } from "../src/schema-cache.js";
import { SEED_MODELS } from "../src/models.js";

const MARKET_PAGE = `
# Some model

\`\`\`yaml
paths:
  /api/v1/jobs/createTask:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required:
                - model
                - input
              properties:
                model:
                  type: string
                  enum:
                    - vendor/new-model
                callBackUrl:
                  type: string
                input:
                  type: object
                  required:
                    - prompt
                    - image_urls
                    - aspect_ratio
                  properties:
                    prompt:
                      type: string
                      description: >-
                        The text prompt used to generate
                        the video.
                      minLength: 3
                      maxLength: 20000
                    image_urls:
                      type: array
                      items:
                        type: string
                      description: Reference images
                      maxItems: 9
                    aspect_ratio:
                      type: string
                      description: |-
                        Video aspect ratio
                      enum:
                        - '16:9'
                        - '9:16'
                      default: '16:9'
                    duration:
                      type: integer
                      description: Duration in seconds
                      default: 5
                    generate_audio:
                      type: boolean
                      default: true
\`\`\`
`;

const DEDICATED_PAGE = `
paths:
  /api/v1/veo/generate:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required:
                - prompt
              properties:
                prompt:
                  type: string
                  description: Prompt text
                imageUrls:
                  type: array
                  items:
                    type: string
                  description: Image list
                model:
                  type: string
                  default: veo3
`;

// ------------------------------------------------------------------ parsing
test("extractInputBlock: extracts input object from market page", () => {
  const block = extractInputBlock(MARKET_PAGE);
  assert.ok(block);
  assert.match(block, /properties:/);
  assert.match(block, /generate_audio:/);
  assert.doesNotMatch(block, /callBackUrl/);
});

test("extractInputBlock: fallback to requestBody for dedicated APIs", () => {
  const block = extractInputBlock(DEDICATED_PAGE);
  assert.ok(block);
  assert.match(block, /imageUrls:/);
});

test("extractInputBlock: no schema returns null", () => {
  assert.equal(extractInputBlock("# Just text without schema"), null);
  assert.equal(extractInputBlock(""), null);
  assert.equal(extractInputBlock(null), null);
});

test("parseInputFields: names, types, enum, default, required", () => {
  const fields = parseInputFields(extractInputBlock(MARKET_PAGE));
  assert.deepEqual(
    fields.map((f) => f.name),
    ["prompt", "image_urls", "aspect_ratio", "duration", "generate_audio"]
  );

  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(byName.prompt.type, "string");
  assert.equal(byName.prompt.required, true);
  assert.match(byName.prompt.description, /text prompt used to generate the video/);
  assert.equal(byName.prompt.constraints.maxLength, "20000");

  assert.equal(byName.image_urls.type, "array");
  assert.equal(byName.image_urls.constraints.items, "string");
  assert.equal(byName.image_urls.constraints.maxItems, "9");

  assert.deepEqual(byName.aspect_ratio.enum, ["16:9", "9:16"]);
  assert.equal(byName.aspect_ratio.default, "16:9");
  assert.equal(byName.aspect_ratio.required, true);

  assert.equal(byName.duration.required, false);
  assert.equal(byName.generate_audio.type, "boolean");
  assert.equal(byName.generate_audio.default, "true");
});

test("parseInputFields: empty input returns empty array", () => {
  assert.deepEqual(parseInputFields(null), []);
  assert.deepEqual(parseInputFields("no properties"), []);
});

test("formatField: formatted summary string", () => {
  const fields = parseInputFields(extractInputBlock(MARKET_PAGE));
  const aspect = fields.find((f) => f.name === "aspect_ratio");
  assert.match(formatField(aspect), /16:9 \| 9:16/);
  assert.match(formatField(aspect), /default 16:9/);
  assert.match(formatField(fields.find((f) => f.name === "image_urls")), /array<string>/);
});

// ------------------------------------------------------------------ metadata
test("deriveModelMeta: prompt/image fields, required and defaults from schema", () => {
  const { fields } = extractInputSchema(MARKET_PAGE);
  const meta = deriveModelMeta(fields);
  assert.equal(meta.prompt_field, "prompt");
  assert.equal(meta.image_field, "image_urls");
  assert.equal(meta.image_list, true);
  assert.deepEqual(meta.required, ["prompt", "image_urls", "aspect_ratio"]);
  assert.deepEqual(meta.defaults, { aspect_ratio: "16:9" });
});

test("deriveModelMeta: default types coerced (boolean/number)", () => {
  const meta = deriveModelMeta([
    { name: "duration", type: "integer", required: true, default: "6", enum: [], constraints: {} },
    { name: "sound", type: "boolean", required: true, default: "false", enum: [], constraints: {} },
  ]);
  assert.deepEqual(meta.defaults, { duration: 6, sound: false });
});

test("deriveModelMeta: callBackUrl not treated as required model field", () => {
  const meta = deriveModelMeta([
    { name: "prompt", type: "string", required: true, default: null, enum: [], constraints: {} },
    { name: "callBackUrl", type: "string", required: true, default: null, enum: [], constraints: {} },
  ]);
  assert.deepEqual(meta.required, ["prompt"]);
});

test("deriveModelMeta: alternative field names (text / first_frame_url)", () => {
  const meta = deriveModelMeta([
    { name: "text", type: "string", required: true, default: null, enum: [], constraints: {} },
    { name: "first_frame_url", type: "string", required: false, default: null, enum: [], constraints: {} },
  ]);
  assert.equal(meta.prompt_field, "text");
  assert.equal(meta.image_field, "first_frame_url");
  assert.equal(meta.image_list, false);
});

// ------------------------------------------------------------------ merge
test("mergeModelMeta: for dynamic model schema is source of truth", () => {
  const dynamic = {
    category: "video", api: "jobs", prompt_field: "prompt",
    image_field: null, image_list: false, required: [], dynamic: true,
  };
  const merged = mergeModelMeta(dynamic, {
    prompt_field: "prompt",
    image_field: "first_frame_url",
    image_list: false,
    required: ["prompt"],
    defaults: { resolution: "720p" },
    fields: ["prompt", "first_frame_url", "resolution"],
  });
  assert.equal(merged.image_field, "first_frame_url");
  assert.deepEqual(merged.required, ["prompt"]);
  assert.deepEqual(merged.defaults, { resolution: "720p" });
});

test("mergeModelMeta: for seed model verified metadata takes precedence", () => {
  const seed = { ...SEED_MODELS["kling-2.6/image-to-video"] };
  const merged = mergeModelMeta(seed, {
    prompt_field: "text",
    image_field: "wrong_field",
    image_list: false,
    required: ["prompt"],
    defaults: { duration: "5" },
    fields: ["prompt", "wrong_field"],
  });
  assert.equal(merged.prompt_field, "prompt");
  assert.equal(merged.image_field, "image_urls");
  assert.deepEqual(merged.required, seed.required);
  assert.equal(merged.defaults.duration, "5");
});

test("mergeModelMeta: without schema model is unchanged", () => {
  const seed = { ...SEED_MODELS["google/nano-banana"] };
  assert.deepEqual(mergeModelMeta(seed, null), seed);
});
