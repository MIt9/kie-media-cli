/**
 * KIE Media CLI — Node.js CLI tool for generating photos, videos, and audio via KIE API (kie.ai).
 * Argument parser is hand-rolled with zero runtime dependencies.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CASCADE_ORDER,
  KieClient,
  KieError,
  TaskNotFound,
  downloadFile,
} from "./client.js";
import { APIS, CATEGORIES } from "./models.js";
import { loadPricing } from "./pricing.js";
import { recommend } from "./recommend.js";
import { fetchDoc, loadRegistry } from "./registry.js";
import { extractInputSchema, formatField } from "./schema.js";
import { loadModelSchema, mergeModelMeta } from "./schema-cache.js";
import { runSetup } from "./setup.js";

export const VERSION = "0.3.1";
export const CONFIG_PATH = path.join(os.homedir(), ".kie-media", "config.json");

/** CLI Usage Error (exit code 2). */
export class UsageError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "UsageError";
  }
}

// Default metadata fallback for models outside registry (with explicit --api).
const GENERIC_MODEL = {
  category: "unknown",
  api: null,
  prompt_field: "prompt",
  image_field: "image_url",
  image_list: false,
  required: [],
  description: "Model outside registry.",
};

// ------------------------------------------------------------------ search
const SEARCH_SYNONYMS = [
  ["edit", "imagetoimage", "i2i", "img2img", "remix", "inpaint"],
  ["texttoimage", "t2i", "txt2img"],
  ["imagetovideo", "i2v", "animate"],
  ["texttovideo", "t2v"],
  ["upscale"],
  ["texttospeech", "tts", "speech", "voice"],
  ["music", "song", "audio"],
];

/** Normalization for comparison: lowercase letters and digits only ("nano-banana" ≈ "Nano Banana"). */
export function squashText(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Expands query into synonyms cluster. */
export function expandSearchTerms(query) {
  const needle = squashText(query);
  if (!needle) return [];
  const terms = new Set([needle]);
  for (const cluster of SEARCH_SYNONYMS) {
    if (cluster.some((term) => needle.startsWith(term))) {
      for (const term of cluster) terms.add(term);
    }
  }
  return [...terms];
}

/** Matches if at least one term matches at least one target field. */
export function matchesSearch(terms, ...fields) {
  if (terms.length === 0) return true;
  const haystack = fields.map(squashText).filter(Boolean);
  return terms.some((term) => haystack.some((field) => field.includes(term)));
}

// ------------------------------------------------------------------ args
/**
 * Lightweight argument parser.
 * spec: { bool: [...], value: [...], multi: [...], alias: { "-o": "--output" } }
 * Returns { flags, positionals }.
 */
export function parseArgs(argv, spec = {}) {
  const bools = new Set(spec.bool || []);
  const values = new Set(spec.value || []);
  const multis = new Set(spec.multi || []);
  const alias = spec.alias || {};
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    let arg = alias[argv[i]] || argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      let inlineValue = null;
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        inlineValue = arg.slice(eq + 1);
        arg = arg.slice(0, eq);
      }
      if (bools.has(arg)) {
        if (inlineValue !== null) throw new UsageError(`Flag ${arg} does not accept a value.`);
        flags[arg] = true;
      } else if (values.has(arg) || multis.has(arg)) {
        let value = inlineValue;
        if (value === null) {
          value = argv[++i];
          if (value === undefined) throw new UsageError(`Flag ${arg} requires a value.`);
        }
        if (multis.has(arg)) {
          (flags[arg] = flags[arg] || []).push(value);
        } else {
          flags[arg] = value;
        }
      } else {
        throw new UsageError(`Unknown flag: ${arg}`);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

// ------------------------------------------------------------------ helpers
/** Parse --set value: try JSON (true/false/numbers/arrays), else string. */
export function parseSetValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseSetPairs(pairs) {
  const result = {};
  for (const pair of pairs || []) {
    const eq = pair.indexOf("=");
    if (eq === -1) throw new UsageError(`--set expects key=value format, got: ${JSON.stringify(pair)}`);
    const key = pair.slice(0, eq).trim();
    if (!key) throw new UsageError(`--set: empty key in ${JSON.stringify(pair)}`);
    result[key] = parseSetValue(pair.slice(eq + 1));
  }
  return result;
}

/** Resolves model entry from registry by id; models outside registry require --api. */
export function resolveModel(modelId, apiOverride = null, registryModels = null) {
  const entry = registryModels ? registryModels.get(modelId) : null;
  if (entry) return { ...entry, id: modelId };
  if (apiOverride) return { ...GENERIC_MODEL, api: apiOverride, id: modelId };
  throw new UsageError(
    `Unknown model: ${JSON.stringify(modelId)}.\n` +
      "Model list: kie models\n" +
      "For model outside registry specify API type: --api jobs|veo|runway|gpt4o|flux|suno"
  );
}

/**
 * Builds input payload: --prompt/--image, then --set, then --json-input on top.
 */
export function buildInput(model, { prompt = null, images = null, setPairs = null, jsonInputStr = null } = {}) {
  const data = {};
  if (prompt !== null && prompt !== undefined) {
    const promptField = model.prompt_field;
    if (promptField) {
      data[promptField] = prompt;
    } else {
      console.error("Warning: model does not accept prompt, --prompt ignored.");
    }
  }
  if (images && images.length > 0) {
    const imageField = model.image_field;
    if (!imageField) {
      throw new UsageError(
        `For model ${model.id || ""} image field is unknown, --image flag is not applicable.\n` +
          `Inspect schema: kie schema ${model.id || "MODEL"}\n` +
          "and pass file or URL to the target field: --set FIELD=PATH_OR_URL\n" +
          "(local file in any field is automatically uploaded by CLI)"
      );
    }
    if (model.image_list) {
      data[imageField] = [...images];
    } else {
      if (images.length > 1) {
        throw new UsageError(`Field ${imageField} accepts a single image, got: ${images.length}.`);
      }
      data[imageField] = images[0];
    }
  }
  for (const [field, value] of Object.entries(model.defaults || {})) {
    if (data[field] === undefined) data[field] = value;
  }
  Object.assign(data, parseSetPairs(setPairs));
  if (jsonInputStr) {
    let extra;
    try {
      extra = JSON.parse(jsonInputStr);
    } catch (exc) {
      throw new UsageError(`--json-input: invalid JSON: ${exc.message}`);
    }
    if (extra === null || typeof extra !== "object" || Array.isArray(extra)) {
      throw new UsageError("--json-input must be a JSON object.");
    }
    Object.assign(data, extra);
  }
  if (model.api === "suno" && data.model === undefined) data.model = "V5";
  return data;
}

/** Pre-flight check of required fields BEFORE API request. */
export function validateInput(model, data) {
  const missing = [];
  for (const field of model.required || []) {
    const value = data[field];
    if (value === undefined || value === null || value === "" ||
        (Array.isArray(value) && value.length === 0)) {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    const lines = missing.map((field) => {
      let hint;
      if (field === model.image_field) hint = "--image FILE_OR_URL";
      else if (field === model.prompt_field) hint = "--prompt TEXT";
      else hint = `--set ${field}=VALUE`;
      return `  - ${field} (set via ${hint})`;
    });
    const tail = model.id
      ? `\nInspect model schema: kie schema ${model.id}`
      : "";
    throw new UsageError("Required model fields are missing:\n" + lines.join("\n") + tail);
  }
  if (model.api === "gpt4o" && !data.prompt && !data.filesUrl) {
    throw new UsageError("gpt4o-image requires --prompt and/or --image (filesUrl).");
  }
  if (model.api === "suno" && data.customMode) {
    for (const field of ["style", "title"]) {
      if (!data[field]) {
        throw new UsageError(`Suno in customMode requires field '${field}' (--set ${field}=...).`);
      }
    }
  }
}

function isRemoteRef(value) {
  return typeof value === "string" && /^(https?:\/\/|asset:\/\/|data:)/.test(value);
}

function isLocalFile(value) {
  if (typeof value !== "string" || value === "" || isRemoteRef(value)) return false;
  try {
    return fs.existsSync(value) && fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

/** Resolves local files to URLs via upload for ALL input fields. */
export async function resolveLocalFiles(client, model, data, log = console.error) {
  const uploaded = new Map();
  const upload = async (filePath) => {
    const key = path.resolve(filePath);
    if (!uploaded.has(key)) {
      log(`Uploading file ${filePath} ...`);
      const url = await client.upload(filePath);
      log(`  -> ${url}`);
      uploaded.set(key, url);
    }
    return uploaded.get(key);
  };

  for (const [field, value] of Object.entries(data)) {
    if (field === model.prompt_field) continue;
    const strict = field === model.image_field;
    const resolve = async (item) => {
      if (isLocalFile(item)) return upload(item);
      if (strict && typeof item === "string" && !isRemoteRef(item)) {
        throw new UsageError(`--image: not a file or URL: ${item}`);
      }
      return item;
    };
    if (Array.isArray(value)) {
      const resolved = [];
      for (const item of value) resolved.push(await resolve(item));
      data[field] = resolved;
    } else {
      data[field] = await resolve(value);
    }
  }
}

/** KIE_API_KEY from env, else ~/.kie-media/config.json. */
export function getApiKey() {
  const envKey = (process.env.KIE_API_KEY || "").trim();
  if (envKey) return envKey;
  try {
    const key = String(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).api_key || "").trim();
    if (key) return key;
  } catch {
    // missing file or invalid JSON
  }
  return null;
}

export function saveApiKey(key) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ api_key: key }, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
}

function makeClient() {
  const key = getApiKey();
  if (!key) {
    throw new UsageError(
      "KIE API key not found.\n" +
        "  1) Set environment variable: export KIE_API_KEY=your_key\n" +
        "  2) Or save key: kie config --set-key your_key\n" +
        "  3) Or run setup wizard: kie setup\n" +
        "Get key at https://kie.ai/api-key"
    );
  }
  return new KieClient(key);
}

/** Cascade jobs → veo → suno → gpt4o → flux → runway until task is found. */
async function detectApi(client, taskId) {
  for (const api of CASCADE_ORDER) {
    try {
      return { api, status: await client.status(api, taskId) };
    } catch (exc) {
      if (!(exc instanceof TaskNotFound)) throw exc;
    }
  }
  throw new UsageError(
    `Task ${taskId} not found in any API. Specify type explicitly: --api ${APIS.join("|")}`
  );
}

/** Polling until terminal status. */
async function pollUntilDone(client, api, taskId, timeoutSec, intervalSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastState = null;
  for (;;) {
    const status = await client.status(api, taskId);
    if (status.state !== lastState) {
      console.error(`Status: ${status.state}`);
      lastState = status.state;
    }
    if (status.state === "success") return status;
    if (status.state === "fail") throw new KieError(status.fail_msg || "generation failed");
    if (Date.now() >= deadline) {
      throw new KieError(
        `wait timeout (${timeoutSec}s). Task is still running — ` +
          `check status later: kie wait ${taskId}`
      );
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

function urlFilename(url, fallback) {
  try {
    const name = path.basename(new URL(url).pathname);
    return name || fallback;
  } catch {
    return fallback;
  }
}

/** Downloads resultUrls to directory. Returns saved paths. */
async function downloadResults(urls, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const saved = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    let dest = path.join(directory, urlFilename(url, `result_${i + 1}`));
    const ext = path.extname(dest);
    const base = dest.slice(0, dest.length - ext.length);
    let n = 1;
    while (fs.existsSync(dest)) dest = `${base}_${n++}${ext}`;
    console.error(`Downloading ${url} -> ${dest}`);
    await downloadFile(url, dest);
    saved.push(dest);
  }
  return saved;
}

function emit(flags, payload, human) {
  if (flags["--json"]) console.log(JSON.stringify(payload, null, 2));
  else human();
}

function printStatusHuman(status) {
  console.log(`State: ${status.state}`);
  if (status.progress !== null && status.progress !== undefined) {
    console.log(`Progress: ${status.progress}`);
  }
  if (status.state === "success") {
    if (status.tracks && status.tracks.length > 0) {
      status.tracks.forEach((track, i) => {
        console.log(`Track ${i + 1}:`);
        if (track.audioUrl) console.log(`  audioUrl:       ${track.audioUrl}`);
        if (track.streamAudioUrl) console.log(`  streamAudioUrl: ${track.streamAudioUrl}`);
      });
    } else if (status.urls && status.urls.length > 0) {
      console.log("Results:");
      for (const url of status.urls) console.log(`  ${url}`);
    } else {
      console.log("Result URLs not found, raw response:");
      console.log(JSON.stringify(status.raw, null, 2));
    }
  } else if (status.state === "fail") {
    console.log(`Generation failed: ${status.fail_msg}`);
  }
}

function warn(message) {
  console.error(`Warning: ${message}`);
}

// ------------------------------------------------------------------ commands
async function cmdCredits(flags) {
  const client = makeClient();
  const credits = await client.credits();
  emit(flags, { credits }, () => console.log(`Balance: ${credits} credits`));
  return 0;
}

async function cmdModels(flags) {
  const registry = await loadRegistry({
    refresh: Boolean(flags["--refresh"]),
    allowFetch: true,
    onWarning: warn,
  });
  let items = [...registry.models.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (flags["--category"]) items = items.filter(([, m]) => m.category === flags["--category"]);
  if (flags["--search"]) {
    const terms = expandSearchTerms(flags["--search"]);
    items = items.filter(([id, m]) => matchesSearch(terms, id, m.description));
  }
  const payload = {
    source: registry.source,
    fetchedAt: registry.fetchedAt,
    count: items.length,
    models: items.map(([id, m]) => ({
      id,
      category: m.category,
      api: m.api,
      required: m.required,
      prompt_field: m.prompt_field,
      image_field: m.image_field,
      stale: Boolean(m.stale),
      dynamic: Boolean(m.dynamic),
      docUrl: m.docUrl || null,
      description: m.description,
    })),
  };

  const human = () => {
    const date = registry.fetchedAt ? registry.fetchedAt.slice(0, 10) : "built-in";
    console.log(`Source: ${registry.source} (catalog from ${date}), models: ${items.length}`);
    if (items.length === 0) {
      console.log("Models not found.");
      return;
    }
    for (const [id, m] of items) {
      const required = (m.required && m.required.length > 0) ? m.required.join(", ") : "—";
      const stale = m.stale ? "  [stale: not in live catalog]" : "";
      console.log(`${id}  [${m.category}/${m.api}]  required: ${required}${stale}`);
      if (m.description) console.log(`    ${m.description}`);
      if (m.docUrl) console.log(`    input schema: kie schema ${id}  (${m.docUrl})`);
    }
  };
  emit(flags, payload, human);
  return 0;
}

function formatUsd(value) {
  return `$${value >= 0.1 ? value.toFixed(2) : value.toFixed(3)}`;
}

function formatPriceRange(pricing) {
  if (!pricing) return "price unknown";
  const credits = pricing.creditsMin === pricing.creditsMax
    ? `${pricing.creditsMin}`
    : `${pricing.creditsMin}–${pricing.creditsMax}`;
  const usd = pricing.usdMin === pricing.usdMax
    ? formatUsd(pricing.usdMin)
    : `${formatUsd(pricing.usdMin)}–${formatUsd(pricing.usdMax)}`;
  const units = pricing.units.length > 0 ? ` ${pricing.units.join("/")}` : "";
  const approx = pricing.approximate ? "≈" : "";
  return `${approx}${credits} credits${units} (~${usd})`;
}

async function cmdPricing(flags) {
  const pricing = await loadPricing({
    refresh: Boolean(flags["--refresh"]),
    allowFetch: true,
    onWarning: warn,
  });
  let records = pricing.records;
  if (flags["--category"]) records = records.filter((r) => r.category === flags["--category"]);
  if (flags["--search"]) {
    const terms = expandSearchTerms(flags["--search"]);
    records = records.filter((r) => matchesSearch(terms, r.id, r.description));
  }
  const payload = {
    source: pricing.source,
    fetchedAt: pricing.fetchedAt,
    count: records.length,
    prices: records,
  };
  const human = () => {
    const date = pricing.fetchedAt ? pricing.fetchedAt.slice(0, 10) : "—";
    console.log(`Source: ${pricing.source} (pricing from ${date}), records: ${records.length}`);
    if (records.length === 0) {
      console.log("Records not found. Try: kie pricing --refresh");
      return;
    }
    for (const r of records) {
      console.log(`${r.id || r.description}  [${r.category}]  ${r.credits} credits ${r.unit} (~${formatUsd(r.usd)})`);
      if (r.id && r.description) console.log(`    ${r.description}`);
    }
  };
  emit(flags, payload, human);
  return 0;
}

const TIER_LABELS = {
  quality: "maximum quality",
  balanced: "price/quality balance",
  budget: "budget, for volume",
};

async function cmdRecommend(flags, positionals) {
  const category = positionals[0];
  if (!category || !CATEGORIES.includes(category)) {
    throw new UsageError(`Specify category: kie recommend ${CATEGORIES.join("|")}`);
  }
  const registry = await loadRegistry({
    refresh: Boolean(flags["--refresh"]),
    allowFetch: true,
    onWarning: warn,
  });
  const pricing = await loadPricing({
    refresh: Boolean(flags["--refresh"]),
    allowFetch: true,
    onWarning: warn,
  });
  const options = recommend(category, registry.models, pricing.records);
  const payload = {
    category,
    pricingSource: pricing.source,
    pricingFetchedAt: pricing.fetchedAt,
    options,
  };
  const human = () => {
    if (options.length === 0) {
      console.log(`No models found for category ${category}. Refresh catalog: kie models --refresh`);
      return;
    }
    console.log(`Recommended models (${category}) — latest version of each popular family:`);
    options.forEach((option, i) => {
      const tier = option.tier ? `  [${TIER_LABELS[option.tier]}]` : "";
      console.log(`${i + 1}. ${option.model}${tier}`);
      console.log(`   ${formatPriceRange(option.pricing)}`);
      if (option.description) console.log(`   ${option.description}`);
    });
    console.log("\nRun: kie run MODEL --prompt ... --wait --download ./out --json");
  };
  emit(flags, payload, human);
  return 0;
}

function guessDocUrl(modelId) {
  return `https://docs.kie.ai/market/${modelId}.md`;
}

async function withLiveSchema(model, modelId, flags) {
  if (flags["--no-schema"]) return model;
  const docUrl = model.docUrl || guessDocUrl(modelId);
  const schema = await loadModelSchema(docUrl, { refresh: Boolean(flags["--refresh-schema"]) });
  if (!schema) {
    if (model.dynamic || !model.docUrl) {
      warn(
        `schema for model ${modelId} unavailable — fields unverified. ` +
          "If API returns 422, check documentation: kie schema " + modelId
      );
    }
    return model;
  }
  return mergeModelMeta(model, schema.meta);
}

async function cmdSchema(flags, positionals) {
  const modelId = positionals[0];
  if (!modelId) throw new UsageError("Specify model: kie schema MODEL");
  const registry = await loadRegistry({ allowFetch: true, onWarning: warn });
  const entry = registry.models.get(modelId);
  if (!entry) {
    throw new UsageError(
      `Unknown model: ${JSON.stringify(modelId)}.\n` +
        `Search: kie models --search ${modelId.split("/").pop()}`
    );
  }
  const docUrl = entry.docUrl || null;
  if (!docUrl) {
    throw new UsageError(
      `Model ${modelId} has no page in live docs.kie.ai catalog` +
        (entry.stale ? " (model marked stale — likely unlisted)." : ".") +
        "\nRefresh catalog: kie models --refresh"
    );
  }

  let markdown;
  try {
    markdown = await fetchDoc(docUrl);
  } catch (exc) {
    throw new KieError(`failed to download ${docUrl}: ${exc.message}`);
  }
  const { fields, block } = extractInputSchema(markdown);

  const payload = {
    id: modelId,
    api: entry.api,
    category: entry.category,
    docUrl,
    fields,
    raw: flags["--raw"] ? block : undefined,
  };

  const human = () => {
    console.log(`${modelId}  [${entry.category}/${entry.api}]  ${docUrl}`);
    if (fields.length === 0) {
      console.log("Failed to parse schema — open documentation page above.");
      return;
    }
    console.log("Input fields (* = required):");
    const width = Math.max(...fields.map((f) => f.name.length));
    for (const field of fields) {
      const name = (field.name + (field.required ? "*" : "")).padEnd(width + 1);
      const meta = formatField(field);
      console.log(`  ${name}  ${meta}`);
      if (field.description) console.log(`      ${field.description.slice(0, 300)}`);
    }
    console.log("\nPassing values: --set FIELD=VALUE (JSON or string), files as path or URL.");
    if (flags["--raw"] && block) console.log(`\n--- raw YAML schema ---\n${block}`);
  };
  emit(flags, payload, human);
  return 0;
}

async function cmdUpload(flags, positionals) {
  const file = positionals[0];
  if (!file) throw new UsageError("Specify file: kie upload FILE");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new UsageError(`File not found: ${file}`);
  }
  const client = makeClient();
  const url = await client.upload(file);
  emit(flags, { fileUrl: url }, () => console.log(url));
  return 0;
}

async function cmdRun(flags, positionals) {
  const modelId = positionals[0];
  if (!modelId) throw new UsageError("Specify model: kie run MODEL [--prompt ...]");
  let registry = await loadRegistry({ allowFetch: false, onWarning: warn });
  if (!registry.models.has(modelId) && !flags["--api"]) {
    registry = await loadRegistry({ refresh: true, allowFetch: true, onWarning: warn });
  }
  const registryEntry = resolveModel(modelId, flags["--api"] || null, registry.models);
  const model = await withLiveSchema(registryEntry, modelId, flags);
  const data = buildInput(model, {
    prompt: flags["--prompt"] ?? null,
    images: flags["--image"],
    setPairs: flags["--set"],
    jsonInputStr: flags["--json-input"],
  });
  validateInput(model, data);

  if (flags["--dry-run"]) {
    const payload = {
      dryRun: true,
      model: modelId,
      api: model.api,
      input: data,
      uploads: Object.entries(data)
        .flatMap(([field, value]) => (Array.isArray(value) ? value : [value]).map((v) => [field, v]))
        .filter(([, value]) => isLocalFile(value))
        .map(([field, value]) => ({ field, file: value })),
    };
    emit(flags, payload, () => {
      console.log(`${modelId} (api: ${model.api}) — request not sent (--dry-run)`);
      console.log(JSON.stringify(data, null, 2));
      for (const u of payload.uploads) console.log(`Will be uploaded: ${u.file} -> ${u.field}`);
    });
    return 0;
  }

  const client = makeClient();
  await resolveLocalFiles(client, model, data);
  const taskId = await client.create(model.api, modelId, data);
  appendHistory({ taskId, model: modelId, api: model.api });

  const payload = { taskId, model: modelId, api: model.api };

  const humanCreated = () => {
    console.log("Task created.");
    console.log(`  taskId: ${taskId}`);
    console.log(`  model:  ${modelId} (api: ${model.api})`);
    console.log(`Check status:   kie status ${taskId}`);
    console.log(`Wait for result: kie wait ${taskId}  (or kie generate wait ${taskId})`);
  };

  if (!flags["--wait"]) {
    emit(flags, payload, humanCreated);
    return 0;
  }

  const timeout = parseDuration(flags["--timeout"] ?? flags["--wait-timeout"] ?? 600, 600);
  const interval = parseDuration(flags["--interval"] ?? flags["--wait-interval"] ?? 5, 5);
  const status = await pollUntilDone(client, model.api, taskId, timeout, interval);
  payload.status = {
    state: status.state,
    urls: status.urls,
    tracks: status.tracks,
    fail_msg: status.fail_msg,
  };
  if (flags["--download"] && status.urls.length > 0) {
    payload.files = await downloadResults(status.urls, flags["--download"]);
  }

  const humanDone = () => {
    printStatusHuman(status);
    for (const file of payload.files || []) console.log(`Saved: ${file}`);
  };
  emit(flags, payload, humanDone);
  return 0;
}

async function cmdStatus(flags, positionals) {
  const taskId = positionals[0];
  if (!taskId) throw new UsageError("Specify taskId: kie status TASK_ID");
  const client = makeClient();
  let status;
  if (flags["--api"]) {
    status = await client.status(flags["--api"], taskId);
  } else {
    const detected = await detectApi(client, taskId);
    status = detected.status;
    if (!flags["--json"]) console.error(`API: ${detected.api} (auto-detected)`);
  }
  emit(flags, status, () => printStatusHuman(status));
  return status.state === "fail" ? 1 : 0;
}

async function cmdWait(flags, positionals) {
  const taskId = positionals[0];
  if (!taskId) throw new UsageError("Specify taskId: kie wait TASK_ID  (or kie generate wait TASK_ID)");
  const client = makeClient();
  let api = flags["--api"];
  if (!api) {
    const detected = await detectApi(client, taskId);
    api = detected.api;
    if (!flags["--json"]) console.error(`API: ${api} (auto-detected)`);
  }
  const timeout = parseDuration(flags["--timeout"] ?? flags["--wait-timeout"] ?? 600, 600);
  const interval = parseDuration(flags["--interval"] ?? flags["--wait-interval"] ?? 5, 5);
  const status = await pollUntilDone(client, api, taskId, timeout, interval);
  emit(flags, status, () => printStatusHuman(status));
  return 0;
}

async function cmdDownload(flags, positionals) {
  const url = positionals[0];
  if (!url) throw new UsageError("Specify URL: kie download URL [-o PATH]");
  let dest = flags["--output"];
  if (!dest) dest = urlFilename(url, "download");
  if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
    dest = path.join(dest, urlFilename(url, "download"));
  }
  await downloadFile(url, dest);
  emit(flags, { file: dest }, () => console.log(`Saved: ${dest}`));
  return 0;
}

function cmdConfig(flags) {
  const key = flags["--set-key"];
  if (!key) throw new UsageError("Specify key: kie config --set-key YOUR_KEY");
  saveApiKey(key);
  emit(flags, { config: CONFIG_PATH }, () => console.log(`Key saved to ${CONFIG_PATH}`));
  return 0;
}

// ------------------------------------------------------------------ help
const HELP = `kie-media-cli ${VERSION} — photo/video/audio generation via KIE API (kie.ai).

Usage: kie <command> [flags]

Commands:
  setup        interactive setup wizard (API key + agent skill), alias: init
                 flags: --yes (non-interactive), --local (skill from package), --repo REPO
  credits      display credit balance
  models       model registry (live catalog from docs.kie.ai, cached 24h)
                 flags: --refresh, --category image|video|audio, --search TEXT
                 aliases: --image/--video/--audio
  pricing      model pricing in credits and USD (kie.ai/pricing, cached 24h)
                 flags: --refresh, --category image|video|audio, --search TEXT
               --search supports task synonyms: edit = image-to-image = i2i =
               remix, tts = speech, upscale; hyphens and case ignored
  recommend    recommend models by category: latest version of each
    CATEGORY     popular family with pricing and quality tier
                 (image|video|audio), flags: --refresh
  schema MODEL input fields for model from documentation (--raw — raw YAML)
  upload FILE  upload local file, print fileUrl
  run MODEL    create generation task
                 --prompt TEXT        prompt text (mapped to prompt_field)
                 --image FILE_OR_URL  image input; can be repeated
                 --set KEY=VALUE      input field; value parsed as JSON
                                      (local files auto-uploaded)
                 --json-input 'JSON'  raw JSON object merged on top of input
                 --api TYPE           jobs|veo|runway|gpt4o|flux|suno (for models outside registry)
                 --dry-run            show generated input without sending request
                 --no-schema          skip fetching live schema
                 --refresh-schema     refresh model schema cache
                 --wait               wait for task completion (polling)
                 --timeout SEC        --wait timeout (default 600, accepts 10m/600s)
                 --interval SEC       polling interval (default 5, accepts 3s)
                 --download DIR       download result files (with --wait)
  cost MODEL   estimate cost without creating task
                 flags same as run (without --wait/--download), + --json
  status ID    check task status; without --api — auto-detect: ${CASCADE_ORDER.join(" → ")}
  wait ID      wait for task completion (--timeout 600 --interval 5, accepts 10m/3s)
  download URL download file (-o PATH)
  config       save API key: --set-key KEY

Hierarchical Command Aliases:
  model list [--image|--video|--audio] [--json]  → models
  model get <model> [--json|--raw]               → schema
  generate create <model> [run flags]            → run
  generate cost <model> [flags]                  → cost
  generate list [--json]                         → task history
  generate get <id> [--json]                     → status
  generate wait <id> [--json]                    → wait
  workflow list / workflow get <name>            → KIE workflow patterns

Global Flag: --json — machine-readable JSON output.
API Key: env KIE_API_KEY or ${CONFIG_PATH}`;

export function parseDuration(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const s = String(value).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)(m|s)?$/);
  if (!m) throw new UsageError(`Invalid duration format: ${value} (example: 600, 10m, 30s)`);
  const n = parseFloat(m[1]);
  const unit = m[2] || "s";
  return unit === "m" ? Math.round(n * 60) : Math.round(n);
}

// ------------------------------------------------------------------ workflows
const WORKFLOWS = [
  {
    name: "image-to-video",
    description: "Animate image to video (veo/seedance): --image → video",
    params: ["--prompt", "--image", "--set", "--api", "--wait"],
    example: "kie run veo3_fast --prompt 'cat waving hand' --image ./cat.png --wait --download ./out",
  },
  {
    name: "image-edit",
    description: "Prompt-based image editing (nano-banana-edit, flux-kontext)",
    params: ["--prompt", "--image", "--set", "--wait"],
    example: "kie run google/nano-banana-edit --prompt 'change background to forest' --image ./photo.png --wait",
  },
  {
    name: "upscale",
    description: "Image upscaling (topaz/image-upscale, etc.)",
    params: ["--image", "--set", "--wait"],
    example: "kie run topaz/image-upscale --image ./photo.png --wait --download ./out",
  },
  {
    name: "text-to-speech",
    description: "Text-to-speech voiceover (elevenlabs, suno TTS)",
    params: ["--prompt", "--set", "--wait"],
    example: "kie run elevenlabs/text-to-speech-turbo-2-5 --prompt 'Hello world' --wait --download ./out",
  },
];

async function cmdWorkflowList(flags) {
  const payload = { workflows: WORKFLOWS };
  const human = () => {
    console.log("KIE Workflows (common usage patterns):");
    for (const w of WORKFLOWS) {
      console.log(`  ${w.name} — ${w.description}`);
      console.log(`    example: ${w.example}`);
    }
    console.log("\nDetails: kie workflow get <name> --json");
  };
  emit(flags, payload, human);
  return 0;
}

async function cmdWorkflowGet(flags, positionals) {
  const name = positionals[0];
  if (!name) throw new UsageError("Specify workflow: kie workflow get <name>  (list: kie workflow list)");
  const wf = WORKFLOWS.find((w) => w.name === name);
  if (!wf) throw new UsageError(`Unknown workflow: ${name}. List: kie workflow list`);
  const payload = wf;
  const human = () => {
    console.log(`${wf.name} — ${wf.description}`);
    console.log(`Params: ${wf.params.join(", ")}`);
    console.log(`Example: ${wf.example}`);
  };
  emit(flags, payload, human);
  return 0;
}

const HISTORY_PATH = path.join(os.homedir(), ".kie-media", "history.json");
const HISTORY_LIMIT = 100;
function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
function appendHistory(entry) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    const list = loadHistory();
    list.unshift({ ...entry, timestamp: new Date().toISOString() });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(list.slice(0, HISTORY_LIMIT), null, 2));
  } catch {}
}
async function cmdHistoryList(flags) {
  const limit = parseInt(flags["--limit"] || "50", 10);
  const list = loadHistory().slice(0, limit);
  const payload = { count: list.length, jobs: list };
  const human = () => {
    if (list.length === 0) { console.log("History is empty. Run: kie run <model> --prompt ..."); return; }
    console.log(`Recent tasks: ${list.length}`);
    for (const j of list) console.log(`  ${j.taskId}  ${j.model} [${j.api}] ${j.timestamp}`);
  };
  emit(flags, payload, human);
  return 0;
}

async function cmdCost(flags, positionals) {
  const modelId = positionals[0];
  if (!modelId) throw new UsageError("Specify model: kie cost <model> [--prompt ...] [--image ...] [--set k=v]");
  let registry = await loadRegistry({ allowFetch: false, onWarning: warn });
  if (!registry.models.has(modelId) && !flags["--api"]) {
    registry = await loadRegistry({ refresh: true, allowFetch: true, onWarning: warn });
  }
  const registryEntry = resolveModel(modelId, flags["--api"] || null, registry.models);
  const model = await withLiveSchema(registryEntry, modelId, flags);
  const data = buildInput(model, {
    prompt: flags["--prompt"] ?? null,
    images: flags["--image"],
    setPairs: flags["--set"],
    jsonInputStr: flags["--json-input"],
  });
  validateInput(model, data);
  const pricing = await loadPricing({ allowFetch: true, onWarning: warn, refresh: Boolean(flags["--refresh"]) });
  let records = pricing.records.filter((r) => r.id === modelId);
  let approximate = false;
  if (records.length === 0) {
    const terms = expandSearchTerms(modelId);
    records = pricing.records.filter((r) => matchesSearch(terms, r.id, r.description));
    approximate = records.length > 0;
  }
  const pricingInfo = records[0] || null;
  const payload = {
    model: modelId,
    api: model.api,
    category: model.category,
    input: data,
    pricing: pricingInfo ? {
      credits: pricingInfo.credits,
      unit: pricingInfo.unit,
      usd: pricingInfo.usd,
      approximate,
      category: pricingInfo.category,
      description: pricingInfo.description,
    } : null,
    pricingSource: pricing.source,
    fetchedAt: pricing.fetchedAt,
  };
  if (!pricingInfo) payload.note = "Price not found in kie.ai pricing list — check: kie pricing --search " + modelId;
  const human = () => {
    console.log(`${modelId} [${model.api}/${model.category}]`);
    if (pricingInfo) {
      const approx = approximate ? "≈" : "";
      console.log(`Estimated cost: ${approx}${pricingInfo.credits} credits / ${pricingInfo.unit} (~${formatUsd(pricingInfo.usd)})${approximate ? " (approximate by description)" : ""}`);
      if (pricingInfo.description) console.log(`  ${pricingInfo.description}`);
    } else {
      console.log("Price not found. Try: kie pricing --search " + modelId + " --refresh");
    }
    console.log(`Pricing source: ${pricing.source} (${pricing.fetchedAt ? pricing.fetchedAt.slice(0,10) : "—"})`);
    if (approximate) console.log("≈ — matched by description keywords, not exact ID");
    console.log("Collected input:", JSON.stringify(data, null, 2));
    console.log("Run: kie run " + modelId + " --prompt ... --wait (for actual task creation)");
  };
  emit(flags, payload, human);
  return 0;
}

// ------------------------------------------------------------------ dispatch
const COMMAND_SPECS = {
  setup: { bool: ["--json", "--yes", "--local"], value: ["--repo"], handler: (f) => runSetup(f) },
  init: { bool: ["--json", "--yes", "--local"], value: ["--repo"], handler: (f) => runSetup(f) },
  credits: { bool: ["--json"], handler: cmdCredits },
  models: {
    bool: ["--json", "--refresh", "--image", "--video", "--audio"],
    value: ["--category", "--search"],
    handler: async (flags, pos) => {
      if (flags["--image"]) flags["--category"] = "image";
      if (flags["--video"]) flags["--category"] = "video";
      if (flags["--audio"]) flags["--category"] = "audio";
      return cmdModels(flags, pos);
    },
  },
  pricing: {
    bool: ["--json", "--refresh"],
    value: ["--category", "--search"],
    handler: cmdPricing,
  },
  recommend: { bool: ["--json", "--refresh"], handler: cmdRecommend },
  schema: { bool: ["--json", "--raw"], handler: cmdSchema },
  upload: { bool: ["--json"], handler: cmdUpload },
  run: {
    bool: ["--json", "--wait", "--no-schema", "--refresh-schema", "--dry-run"],
    value: ["--prompt", "--json-input", "--api", "--timeout", "--interval", "--download", "--wait-timeout", "--wait-interval"],
    multi: ["--image", "--set"],
    alias: { "--wait-timeout": "--timeout", "--wait-interval": "--interval" },
    handler: cmdRun,
  },
  cost: {
    bool: ["--json", "--no-schema", "--refresh-schema", "--refresh"],
    value: ["--prompt", "--json-input", "--api"],
    multi: ["--image", "--set"],
    handler: cmdCost,
  },
  status: { bool: ["--json"], value: ["--api"], handler: cmdStatus },
  wait: {
    bool: ["--json"],
    value: ["--api", "--timeout", "--interval", "--wait-timeout", "--wait-interval"],
    alias: { "--wait-timeout": "--timeout", "--wait-interval": "--interval" },
    handler: cmdWait,
  },
  download: { bool: ["--json"], value: ["--output"], alias: { "-o": "--output" }, handler: cmdDownload },
  config: { bool: ["--json"], value: ["--set-key"], handler: cmdConfig },
  workflow: {
    bool: ["--json"],
    handler: async (flags, pos) => {
      const sub = pos[0];
      if (!sub || sub === "list") return cmdWorkflowList(flags);
      if (sub === "get") return cmdWorkflowGet(flags, pos.slice(1));
      throw new UsageError(`workflow: unknown subcommand ${JSON.stringify(sub)} (list|get)`);
    },
  },
  model: {
    bool: ["--json", "--refresh", "--image", "--video", "--audio"],
    value: ["--category", "--search"],
    handler: async (flags, pos) => {
      const sub = pos[0];
      if (!sub || sub === "list") {
        if (flags["--image"]) flags["--category"] = "image";
        if (flags["--video"]) flags["--category"] = "video";
        if (flags["--audio"]) flags["--category"] = "audio";
        if (pos[0] === "list") pos = pos.slice(1);
        return cmdModels(flags, pos);
      }
      if (sub === "get") return cmdSchema(flags, pos.slice(1));
      throw new UsageError(`model: use model list | model get <model>`);
    },
  },
  generate: {
    bool: ["--json"],
    value: [],
    handler: async () => {
      throw new UsageError("generate: use generate create|cost|list|get|wait|workflow");
    },
  },
};

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(`kie-media-cli ${VERSION}`);
    return 0;
  }
  const [command, ...rest] = argv;

  if (command === "generate") {
    try {
      const sub = rest[0];
      const subRest = rest.slice(1);
      if (!sub) throw new UsageError("generate: specify subcommand create|cost|list|get|wait|workflow");
      if (sub === "create") {
        const spec = COMMAND_SPECS.run;
        const { flags, positionals } = parseArgs(subRest, spec);
        return (await cmdRun(flags, positionals)) || 0;
      }
      if (sub === "cost") {
        const spec = COMMAND_SPECS.cost;
        const { flags, positionals } = parseArgs(subRest, spec);
        return (await cmdCost(flags, positionals)) || 0;
      }
      if (sub === "list") {
        const spec = { bool: ["--json"], value: ["--limit"] };
        const { flags } = parseArgs(subRest, spec);
        return (await cmdHistoryList(flags)) || 0;
      }
      if (sub === "get") {
        const spec = { bool: ["--json"], value: ["--api"] };
        const { flags, positionals } = parseArgs(subRest, spec);
        return (await cmdStatus(flags, positionals)) || 0;
      }
      if (sub === "wait") {
        const spec = { bool: ["--json"], value: ["--api", "--timeout", "--interval", "--wait-timeout", "--wait-interval"], alias: { "--wait-timeout": "--timeout", "--wait-interval": "--interval" } };
        const { flags, positionals } = parseArgs(subRest, spec);
        if (flags["--timeout"] !== undefined) flags["--timeout"] = String(parseDuration(flags["--timeout"], 600));
        if (flags["--interval"] !== undefined) flags["--interval"] = String(parseDuration(flags["--interval"], 5));
        return (await cmdWait(flags, positionals)) || 0;
      }
      if (sub === "workflow") {
        const wf = subRest[0];
        const wfRest = subRest.slice(1);
        if (!wf || wf === "list") {
          const spec = { bool: ["--json"] };
          const { flags } = parseArgs(wfRest, spec);
          return (await cmdWorkflowList(flags)) || 0;
        }
        if (wf === "get") {
          const spec = { bool: ["--json"] };
          const { flags } = parseArgs(wfRest.slice(1), spec);
          return (await cmdWorkflowGet(flags, [wfRest[0]])) || 0;
        }
        throw new UsageError(`generate workflow: unknown workflow ${JSON.stringify(wf)} (try: kie workflow list)`);
      }
      throw new UsageError(`generate: unknown subcommand ${JSON.stringify(sub)} (create|cost|list|get|wait|workflow)`);
    } catch (exc) {
      if (exc instanceof UsageError) { console.error(`Error: ${exc.message}`); return 2; }
      if (exc instanceof TaskNotFound) { console.error(`Task not found: ${exc.msg}`); return 1; }
      if (exc instanceof KieError) { console.error(exc.message); return 1; }
      throw exc;
    }
  }

  if (command === "model") {
    try {
      const sub = rest[0];
      const subRest = rest.slice(1);
      if (!sub || sub === "list") {
        const spec = { bool: ["--json", "--refresh", "--image", "--video", "--audio"], value: ["--category", "--search"] };
        const { flags } = parseArgs(subRest, spec);
        if (flags["--image"]) flags["--category"] = "image";
        if (flags["--video"]) flags["--category"] = "video";
        if (flags["--audio"]) flags["--category"] = "audio";
        return (await cmdModels(flags, [])) || 0;
      }
      if (sub === "get") {
        const spec = { bool: ["--json", "--raw"] };
        const { flags, positionals } = parseArgs(subRest, spec);
        if (positionals.length === 0) throw new UsageError("Specify model: kie model get <model>");
        return (await cmdSchema(flags, positionals)) || 0;
      }
      throw new UsageError(`model: use model list | model get <model>`);
    } catch (exc) {
      if (exc instanceof UsageError) { console.error(`Error: ${exc.message}`); return 2; }
      if (exc instanceof TaskNotFound) { console.error(`Task not found: ${exc.msg}`); return 1; }
      if (exc instanceof KieError) { console.error(exc.message); return 1; }
      throw exc;
    }
  }

  const spec = COMMAND_SPECS[command];
  if (!spec) {
    console.error(`Error: unknown command: ${command}\n`);
    console.error(HELP);
    return 2;
  }
  try {
    const { flags, positionals } = parseArgs(rest, spec);
    return (await spec.handler(flags, positionals)) || 0;
  } catch (exc) {
    if (exc instanceof UsageError) {
      console.error(`Error: ${exc.message}`);
      return 2;
    }
    if (exc instanceof TaskNotFound) {
      console.error(`Task not found: ${exc.msg}`);
      return 1;
    }
    if (exc instanceof KieError) {
      console.error(exc.message);
      return 1;
    }
    throw exc;
  }
}
