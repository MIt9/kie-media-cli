/**
 * Seed model registry for KIE API — built-in fallback and metadata source
 * (required/prompt_field/image_field/api) for known models.
 *
 * Live catalog is fetched from https://docs.kie.ai/llms.txt (src/registry.js);
 * seed metadata takes precedence when IDs match.
 *
 * Entry fields:
 * - category: image | video | audio
 * - api: jobs | veo | runway | gpt4o | flux | suno — API type (create/status endpoints)
 * - prompt_field: input field for --prompt (null if model takes no prompt)
 * - image_field: input field for --image URLs (null if model takes no images)
 * - image_list: true if image_field expects an array of URLs
 * - required: required input fields (validated pre-flight)
 * - defaults: default values for required fields
 * - description: concise description and optional parameters
 *
 * Metadata verified against schemas on docs.kie.ai (kie schema MODEL).
 */

export const CATEGORIES = ["image", "video", "audio"];
export const APIS = ["jobs", "veo", "runway", "gpt4o", "flux", "suno"];

/** Documentation URLs for dedicated APIs outside the llms.txt market catalog. */
export const DEDICATED_DOC_URLS = {
  veo: "https://docs.kie.ai/veo3-api/generate-veo-3-video.md",
  suno: "https://docs.kie.ai/suno-api/generate-music.md",
  flux: "https://docs.kie.ai/flux-kontext-api/generate-or-edit-image.md",
  gpt4o: "https://docs.kie.ai/4o-image-api/generate-4-o-image.md",
  runway: "https://docs.kie.ai/runway-api/generate-ai-video.md",
};

function m(category, api, {
  prompt_field = "prompt",
  image_field = null,
  image_list = false,
  required = [],
  defaults = {},
  description = "",
} = {}) {
  const entry = {
    category, api, prompt_field, image_field, image_list, required, defaults, description,
  };
  if (api !== "jobs") {
    entry.dedicated = true;
    entry.docUrl = DEDICATED_DOC_URLS[api] || null;
  }
  return entry;
}

export const SEED_MODELS = {
  // ---------------------------------------------------------------- image
  "google/nano-banana": m("image", "jobs", {
    required: ["prompt"],
    description: "Nano Banana (Gemini 2.5 Flash Image) — fast and cheap text-to-image by Google.",
  }),
  "google/nano-banana-edit": m("image", "jobs", {
    image_field: "image_urls", image_list: true,
    required: ["prompt", "image_urls"],
    description: "Prompt-based image editing (Nano Banana Edit).",
  }),
  "google/imagen4": m("image", "jobs", {
    required: ["prompt"],
    description: "Google Imagen 4 — high quality text-to-image.",
  }),
  "google/imagen4-fast": m("image", "jobs", {
    required: ["prompt"],
    description: "Google Imagen 4 Fast — fast variant of Imagen 4.",
  }),
  "google/imagen4-ultra": m("image", "jobs", {
    required: ["prompt"],
    description: "Google Imagen 4 Ultra — highest quality Imagen 4.",
  }),
  "bytedance/seedream-v4-text-to-image": m("image", "jobs", {
    required: ["prompt"],
    description: "Seedream 4.0 text-to-image. Options: image_size, image_resolution (1K|2K|4K), max_images.",
  }),
  "bytedance/seedream-v4-edit": m("image", "jobs", {
    image_field: "image_urls", image_list: true,
    required: ["prompt", "image_urls"],
    description: "Seedream 4.0 edit — reference-based editing. Options: image_size, image_resolution, max_images.",
  }),
  "gpt-image/1.5-text-to-image": m("image", "jobs", {
    required: ["prompt", "aspect_ratio", "quality"],
    defaults: { aspect_ratio: "1:1", quality: "medium" },
    description: "GPT Image 1.5 text-to-image. Required: aspect_ratio (1:1|2:3|3:2), quality (medium|high).",
  }),
  "gpt-image/1.5-image-to-image": m("image", "jobs", {
    image_field: "input_urls", image_list: true,
    required: ["prompt", "aspect_ratio", "quality", "input_urls"],
    defaults: { aspect_ratio: "3:2", quality: "medium" },
    description: "GPT Image 1.5 image-to-image. Required: aspect_ratio (1:1|2:3|3:2), quality (medium|high), input_urls.",
  }),
  "qwen/text-to-image": m("image", "jobs", {
    required: ["prompt"],
    description: "Qwen text-to-image — renders text in images well.",
  }),
  "qwen/image-edit": m("image", "jobs", {
    image_field: "image_url",
    required: ["prompt", "image_url"],
    description: "Qwen image edit — prompt-based image editing.",
  }),
  "flux-2/pro-text-to-image": m("image", "jobs", {
    required: ["prompt", "aspect_ratio", "resolution"],
    defaults: { aspect_ratio: "1:1", resolution: "1K" },
    description: "FLUX.2 Pro text-to-image — high quality. Required: aspect_ratio (1:1|4:3|3:4|16:9|9:16|3:2), resolution (1K|2K).",
  }),
  "flux-2/flex-image-to-image": m("image", "jobs", {
    image_field: "input_urls", image_list: true,
    required: ["prompt", "input_urls", "aspect_ratio", "resolution"],
    defaults: { aspect_ratio: "1:1", resolution: "1K" },
    description: "FLUX.2 Flex image-to-image — reference generation (input_urls). Required: aspect_ratio, resolution (1K|2K).",
  }),
  "grok-imagine/text-to-image": m("image", "jobs", {
    required: ["prompt"],
    description: "Grok Imagine text-to-image.",
  }),
  "z-image": m("image", "jobs", {
    required: ["prompt", "aspect_ratio"],
    defaults: { aspect_ratio: "1:1" },
    description: "Z-Image — lightweight and fast text-to-image. aspect_ratio: 1:1|4:3|3:4|16:9|9:16.",
  }),
  "topaz/image-upscale": m("image", "jobs", {
    prompt_field: null, image_field: "image_url",
    required: ["image_url", "upscale_factor"],
    defaults: { upscale_factor: "2" },
    description: "Topaz Image Upscale — image upscaling. No prompt required. upscale_factor: 1|2|4.",
  }),
  "recraft/remove-background": m("image", "jobs", {
    prompt_field: null, image_field: "image",
    required: ["image"],
    description: "Recraft Remove Background — background removal. No prompt required; image field is image.",
  }),
  "flux-kontext-pro": m("image", "flux", {
    image_field: "inputImage",
    required: ["prompt"],
    description: "FLUX Kontext Pro — generation/editing. Options: inputImage, aspectRatio, outputFormat (jpeg|png), enableTranslation.",
  }),
  "flux-kontext-max": m("image", "flux", {
    image_field: "inputImage",
    required: ["prompt"],
    description: "FLUX Kontext Max — top version of Kontext. Options: inputImage, aspectRatio, outputFormat (jpeg|png), enableTranslation.",
  }),
  "gpt4o-image": m("image", "gpt4o", {
    image_field: "filesUrl", image_list: true,
    required: ["size"],
    description: "GPT-4o Image. Required: size (1:1|3:2|2:3); requires --prompt and/or --image (filesUrl, up to 5 URLs).",
  }),
  // ---------------------------------------------------------------- video
  "veo3": m("video", "veo", {
    image_field: "imageUrls", image_list: true,
    required: ["prompt"],
    description: "Google Veo 3 — high quality video with audio. Options: aspect_ratio (16:9|9:16|Auto), resolution (720p|1080p|4k), generationType, enableTranslation.",
  }),
  "veo3_fast": m("video", "veo", {
    image_field: "imageUrls", image_list: true,
    required: ["prompt"],
    description: "Google Veo 3 Fast — fast and economical variant of Veo 3.",
  }),
  "veo3_lite": m("video", "veo", {
    image_field: "imageUrls", image_list: true,
    required: ["prompt"],
    description: "Google Veo 3 Lite — lightweight variant of Veo 3.",
  }),
  "runway-gen3": m("video", "runway", {
    image_field: "imageUrl",
    required: ["prompt", "duration", "quality"],
    defaults: { duration: 5, quality: "720p" },
    description: "Runway Gen-3 — text/image-to-video. Required: duration (5|10) and quality (720p|1080p); imageUrl is optional, aspectRatio (16:9|4:3|1:1|3:4|9:16).",
  }),
  "kling-2.6/text-to-video": m("video", "jobs", {
    required: ["prompt", "sound", "aspect_ratio", "duration"],
    description: 'Kling 2.6 text-to-video. Required: sound (bool), aspect_ratio, duration ("5"|"10").',
  }),
  "kling-2.6/image-to-video": m("video", "jobs", {
    image_field: "image_urls", image_list: true,
    required: ["prompt", "image_urls", "sound", "duration"],
    description: 'Kling 2.6 image-to-video. image_urls is an array (max 1). Required: sound (bool), duration ("5"|"10").',
  }),
  "kling/v2-5-turbo-text-to-video-pro": m("video", "jobs", {
    required: ["prompt"],
    description: "Kling 2.5 Turbo Pro text-to-video. Options: duration (5|10), aspect_ratio (16:9|9:16|1:1), cfg_scale.",
  }),
  "kling/v2-5-turbo-image-to-video-pro": m("video", "jobs", {
    image_field: "image_url",
    required: ["prompt", "image_url"],
    description: "Kling 2.5 Turbo Pro image-to-video. Options: tail_image_url, duration (5|10), cfg_scale.",
  }),
  "hailuo/2-3-image-to-video-pro": m("video", "jobs", {
    image_field: "image_url",
    required: ["prompt", "image_url"],
    description: 'Hailuo 2.3 Pro image-to-video. Options: duration ("6"|"10"), resolution (768P|1080P).',
  }),
  "hailuo/02-text-to-video-pro": m("video", "jobs", {
    required: ["prompt"],
    description: "Hailuo 02 Pro text-to-video.",
  }),
  "hailuo/02-image-to-video-pro": m("video", "jobs", {
    image_field: "image_url",
    required: ["prompt", "image_url"],
    description: "Hailuo 02 Pro image-to-video.",
  }),
  "bytedance/v1-pro-text-to-video": m("video", "jobs", {
    required: ["prompt"],
    description: "ByteDance Seedance v1 Pro text-to-video.",
  }),
  "wan/2-6-image-to-video": m("video", "jobs", {
    image_field: "image_urls", image_list: true,
    required: ["prompt", "image_urls"],
    description: "Wan 2.6 image-to-video. Options: duration (5|10|15), resolution (720p|1080p), multi_shots.",
  }),
  "grok-imagine/text-to-video": m("video", "jobs", {
    required: ["prompt"],
    description: "Grok Imagine text-to-video.",
  }),
  // ---------------------------------------------------------------- audio
  "suno": m("audio", "suno", {
    required: ["prompt", "model", "customMode", "instrumental"],
    defaults: { model: "V5", customMode: false, instrumental: false },
    description: "Suno — music generation. model: V3_5|V4|V4_5|V4_5PLUS|V4_5ALL|V5|V5_5 (default V5). customMode=true requires style and title.",
  }),
  "elevenlabs/text-to-speech-turbo-2-5": m("audio", "jobs", {
    prompt_field: "text",
    required: ["text"],
    description: "ElevenLabs TTS Turbo v2.5 — fast text-to-speech. text ≤ 5000 chars. Options: voice, stability, similarity_boost, style, speed (0.7–1.2).",
  }),
  "elevenlabs/text-to-speech-multilingual-v2": m("audio", "jobs", {
    prompt_field: "text",
    required: ["text", "voice"],
    defaults: { voice: "EkK5I93UQWFDigLMpZcX" },
    description: "ElevenLabs TTS Multilingual v2 — high quality multilingual TTS. text ≤ 5000 chars. voice is required.",
  }),
};

/** Default metadata for dynamic models discovered from live market catalog. */
export function dynamicModel(category, description = "") {
  return {
    category,
    api: "jobs",
    prompt_field: "prompt",
    image_field: null,
    image_list: false,
    required: [],
    description,
    dynamic: true,
  };
}
