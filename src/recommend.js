/**
 * Model recommendations: group registry models by family, select top (latest)
 * model per family, and associate pricing from pricing list (src/pricing.js).
 */

import { priceForModel } from "./pricing.js";

/** Popular model families by category in order of recognition. */
export const POPULAR_FAMILIES = {
  image: ["nano-banana", "gpt-image", "flux", "seedream", "imagen"],
  video: ["seedance", "veo", "kling", "hailuo", "sora", "grok-imagine"],
  audio: ["suno", "elevenlabs"],
};

/**
 * Parses model id into family/version/suffix.
 * "google/nano-banana-2"        → family "google-nano-banana", version 2, suffix ""
 * "bytedance/seedance-2-mini"   → family "bytedance-seedance", version 2, suffix "mini"
 * "veo3_fast"                   → family "veo", version 3, suffix "fast"
 */
export function familyOf(modelId) {
  const norm = String(modelId)
    .toLowerCase()
    .replace(/[/_\s]+/g, "-")
    .replace(/v(?=\d)/g, "");
  const match = /(\d+)(?:[.-](\d+))?/.exec(norm);
  if (!match) return { family: norm, version: 0, suffix: "" };
  const family = norm.slice(0, match.index).replace(/-+$/g, "");
  const minor = match[2] ? Number(match[2]) / 10 ** match[2].length : 0;
  const suffix = norm.slice(match.index + match[0].length).replace(/^-+/g, "");
  return { family, version: Number(match[1]) + minor, suffix };
}

function popularityKey(category, family) {
  const keys = POPULAR_FAMILIES[category] || [];
  return keys.find((key) => family.includes(key)) || null;
}

function popularityIndex(category, family) {
  const key = popularityKey(category, family);
  if (key === null) return Infinity;
  return POPULAR_FAMILIES[category].indexOf(key);
}

function pickTopModel(candidates, pricingRecords) {
  const decorated = candidates.map(([id, entry]) => {
    const parsed = familyOf(id);
    const price = priceForModel(pricingRecords, id);
    return { id, entry, ...parsed, price, priceMax: price ? price.creditsMax : -1 };
  });
  decorated.sort((a, b) =>
    b.version - a.version ||
    b.priceMax - a.priceMax ||
    a.suffix.length - b.suffix.length ||
    a.id.localeCompare(b.id)
  );
  return decorated[0];
}

/**
 * Returns recommended models for a category (up to limit models).
 * Tiers: quality | balanced | budget (null if price unknown).
 */
export function recommend(category, registryModels, pricingRecords, { limit = 4 } = {}) {
  const families = new Map();
  for (const [id, entry] of registryModels) {
    if (entry.category !== category || entry.stale) continue;
    const { family } = familyOf(id);
    if (!families.has(family)) families.set(family, []);
    families.get(family).push([id, entry]);
  }

  const tops = [...families.entries()].map(([family, candidates]) => ({
    family,
    popKey: popularityKey(category, family),
    popularity: popularityIndex(category, family),
    top: pickTopModel(candidates, pricingRecords),
  }));

  tops.sort((a, b) =>
    a.popularity - b.popularity ||
    b.top.version - a.top.version ||
    b.top.priceMax - a.top.priceMax ||
    a.family.localeCompare(b.family)
  );

  const seenKeys = new Set();
  const deduped = tops.filter(({ popKey }) => {
    if (popKey === null) return true;
    if (seenKeys.has(popKey)) return false;
    seenKeys.add(popKey);
    return true;
  });

  const chosen = deduped.slice(0, limit).map(({ family, top }) => ({
    family,
    model: top.id,
    description: top.entry.description || "",
    pricing: top.price
      ? {
          creditsMin: top.price.creditsMin,
          creditsMax: top.price.creditsMax,
          usdMin: top.price.usdMin,
          usdMax: top.price.usdMax,
          units: top.price.units,
          approximate: top.price.approximate,
        }
      : null,
  }));

  const priced = chosen.filter((c) => c.pricing);
  for (const option of chosen) option.tier = null;
  if (priced.length > 0) {
    const byPrice = [...priced].sort((a, b) => b.pricing.creditsMax - a.pricing.creditsMax);
    byPrice[0].tier = "quality";
    if (byPrice.length > 1) byPrice[byPrice.length - 1].tier = "budget";
    for (const option of byPrice.slice(1, -1)) option.tier = "balanced";
  }
  return chosen;
}
