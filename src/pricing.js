/**
 * KIE Pricing List: public endpoint https://api.kie.ai/client/v1/model-pricing/page
 * (used by kie.ai/pricing page), cached at ~/.kie-media/pricing-cache.json (TTL 24h).
 * Prices depend on parameters (resolution, mode) — a single model may have multiple records.
 *
 * Fallback chain: fresh cache → live network → stale cache → empty list (source: "none").
 * Chat models (LLM) are skipped — CLI generates image/video/audio only.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRICING_URL = "https://api.kie.ai/client/v1/model-pricing/page";
export const CACHE_PATH = path.join(os.homedir(), ".kie-media", "pricing-cache.json");
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const PAGE_SIZE = 100;

/** Default conversion rate if usdPrice is missing: 1 credit = $0.005. */
export const USD_PER_CREDIT = 0.005;

const CATEGORY_BY_INTERFACE = {
  image: "image",
  video: "video",
  music: "audio",
};

/** Extract model id from pricing record anchor URL: "...?model=qwen3%2Fpro-image-to-image". */
export function extractModelId(anchor) {
  if (!anchor) return null;
  const match = /[?&]model=([^&]+)/.exec(anchor);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Normalizes raw API pricing record →
 * { id|null, category, description, credits, usd, unit, provider }.
 * Returns null for records outside image/video/audio categories.
 */
export function normalizeRecord(raw) {
  const category = CATEGORY_BY_INTERFACE[String(raw.interfaceType || "").toLowerCase()];
  if (!category) return null;
  const credits = Number(raw.creditPrice);
  if (!Number.isFinite(credits)) return null;
  const usdRaw = Number(raw.usdPrice);
  const usd = raw.usdPrice !== undefined && raw.usdPrice !== null && raw.usdPrice !== "" && Number.isFinite(usdRaw)
    ? usdRaw
    : credits * USD_PER_CREDIT;
  return {
    id: extractModelId(raw.anchor),
    category,
    description: String(raw.modelDescription || ""),
    credits,
    usd,
    unit: String(raw.creditUnit || ""),
    provider: String(raw.provider || ""),
  };
}

async function fetchPage(pageNum, pageSize, timeoutMs = 30_000) {
  const resp = await fetch(PRICING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pageNum, pageSize, modelDescription: "", interfaceType: "" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${PRICING_URL}`);
  const body = await resp.json();
  if (body.code !== 200 || !body.data) {
    throw new Error(`KIE pricing list returned error: ${body.msg || `code ${body.code}`}`);
  }
  return body.data;
}

/**
 * Fetches full pricing list page by page.
 * Returns normalized records (excluding chat).
 */
export function fetchPricing(fetchImpl = fetchPage) {
  return (async () => {
    const records = [];
    let pageNum = 1;
    for (;;) {
      const data = await fetchImpl(pageNum, PAGE_SIZE);
      const batch = Array.isArray(data.records) ? data.records : [];
      for (const raw of batch) {
        const record = normalizeRecord(raw);
        if (record) records.push(record);
      }
      const total = Number(data.total) || 0;
      if (batch.length === 0 || records.length >= total) break;
      pageNum += 1;
    }
    return records;
  })();
}

function readCache(cachePath = CACHE_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (raw && Array.isArray(raw.records) && raw.fetchedAt) return raw;
  } catch {
    // missing file or invalid JSON
  }
  return null;
}

function writeCache(records, cachePath = CACHE_PATH) {
  const cache = { fetchedAt: new Date().toISOString(), records };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  return cache;
}

/**
 * Loads pricing list with caching:
 * { records, source: live|cache|none, fetchedAt }.
 */
export async function loadPricing({
  refresh = false,
  allowFetch = true,
  cachePath = CACHE_PATH,
  fetchImpl = fetchPage,
  onWarning = null,
} = {}) {
  const cache = readCache(cachePath);
  const cacheFresh = cache && Date.now() - Date.parse(cache.fetchedAt) < CACHE_TTL_MS;
  if (cacheFresh && !refresh) {
    return { records: cache.records, source: "cache", fetchedAt: cache.fetchedAt };
  }

  if (allowFetch) {
    try {
      const records = await fetchPricing(fetchImpl);
      if (records.length > 0) {
        const written = writeCache(records, cachePath);
        return { records, source: "live", fetchedAt: written.fetchedAt };
      }
      throw new Error("pricing list is empty");
    } catch (exc) {
      if (onWarning) onWarning(`Failed to refresh pricing list (${exc.message}).`);
    }
  }

  if (cache) {
    return { records: cache.records, source: "cache", fetchedAt: cache.fetchedAt };
  }
  return { records: [], source: "none", fetchedAt: null };
}

/** String tokenizer for fuzzy matching: lowercase, splits on non-alphanumeric and boundaries. */
export function tokenize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Pricing summary for a specific model id:
 * { creditsMin, creditsMax, usdMin, usdMax, units, approximate } or null.
 */
export function priceForModel(records, modelId) {
  const summarize = (matched, approximate) => {
    const credits = matched.map((r) => r.credits);
    const usd = matched.map((r) => r.usd);
    return {
      creditsMin: Math.min(...credits),
      creditsMax: Math.max(...credits),
      usdMin: Math.min(...usd),
      usdMax: Math.max(...usd),
      units: [...new Set(matched.map((r) => r.unit.trim()).filter(Boolean))],
      approximate,
    };
  };
  const exact = records.filter((r) => r.id === modelId);
  if (exact.length > 0) return summarize(exact, false);
  const modelTokens = tokenize(modelId);
  if (modelTokens.length === 0) return null;
  const fuzzy = records.filter((r) => {
    const haystack = new Set(tokenize(r.description));
    return modelTokens.every((token) => haystack.has(token));
  });
  return fuzzy.length > 0 ? summarize(fuzzy, true) : null;
}
