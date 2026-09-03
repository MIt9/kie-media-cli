/**
 * Model schema cache: docUrl → input fields (~/.kie-media/schema-cache.json, TTL 24h).
 *
 * Allows `run` to inspect unknown model fields from live documentation
 * without making network requests on every launch.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fetchDoc } from "./registry.js";
import { deriveModelMeta, extractInputSchema } from "./schema.js";

export const SCHEMA_CACHE_PATH = path.join(os.homedir(), ".kie-media", "schema-cache.json");
export const SCHEMA_TTL_MS = 24 * 60 * 60 * 1000;

function readCache(cachePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object") return raw;
  } catch {
    // missing file or invalid JSON
  }
  return { entries: {} };
}

function writeCache(cache, cachePath) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  } catch {
    // cache is an optimization: continue without saving if write fails
  }
}

/**
 * Model input fields by docUrl: from cache or network.
 * Returns { fields, meta, source: cache|live|stale-cache } or null if unavailable.
 */
export async function loadModelSchema(docUrl, {
  refresh = false,
  cachePath = SCHEMA_CACHE_PATH,
  fetchImpl = fetchDoc,
  ttlMs = SCHEMA_TTL_MS,
} = {}) {
  if (!docUrl) return null;
  const cache = readCache(cachePath);
  const cached = cache.entries[docUrl];
  const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < ttlMs;

  if (cached && fresh && !refresh) {
    return { fields: cached.fields, meta: deriveModelMeta(cached.fields), source: "cache" };
  }

  try {
    const markdown = await fetchImpl(docUrl);
    const { fields } = extractInputSchema(markdown);
    if (fields.length > 0) {
      cache.entries[docUrl] = { fetchedAt: new Date().toISOString(), fields };
      writeCache(cache, cachePath);
      return { fields, meta: deriveModelMeta(fields), source: "live" };
    }
  } catch {
    // network or page unavailable — fallback to stale cache
  }

  if (cached) {
    return { fields: cached.fields, meta: deriveModelMeta(cached.fields), source: "stale-cache" };
  }
  return null;
}

/**
 * Merges model metadata with its live schema.
 * For seed models, manually verified metadata takes precedence.
 * For dynamic models, schema is source of truth.
 */
export function mergeModelMeta(model, schemaMeta) {
  if (!schemaMeta) return model;
  const merged = { ...model, schema_fields: schemaMeta.fields };

  if (model.dynamic || !model.api) {
    if (schemaMeta.prompt_field) merged.prompt_field = schemaMeta.prompt_field;
    if (schemaMeta.image_field) {
      merged.image_field = schemaMeta.image_field;
      merged.image_list = schemaMeta.image_list;
    }
    merged.required = schemaMeta.required;
    merged.defaults = { ...schemaMeta.defaults, ...(model.defaults || {}) };
    return merged;
  }

  if (!merged.image_field && schemaMeta.image_field) {
    merged.image_field = schemaMeta.image_field;
    merged.image_list = schemaMeta.image_list;
  }
  if ((merged.required || []).length === 0) merged.required = schemaMeta.required;
  merged.defaults = { ...schemaMeta.defaults, ...(model.defaults || {}) };
  return merged;
}
