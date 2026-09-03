/**
 * kie setup (alias init) — interactive setup wizard:
 * 1) KIE API key (validation via credits, save to ~/.kie-media/config.json);
 * 2) Agent skill installation (npx skills add <repo> or --local copy from package);
 * 3) Summary and next steps.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { KieClient, KieError } from "./client.js";
import { saveApiKey } from "./cli.js";

export const SKILLS_REPO = "MIt9/kie-skills/kie-generate";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_SKILL_DIR = path.join(PACKAGE_ROOT, "skills", "visual");

function createAsker(interactive) {
  if (!interactive) {
    return { ask: async () => "", askSecret: async () => "", close: () => {} };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (question) => new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
  const askSecret = (question) =>
    new Promise((resolve) => {
      const original = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (chunk) => {
        if (chunk.includes(question) || chunk === "\r\n" || chunk === "\n") original(chunk);
        else original("*");
      };
      rl.question(question, (a) => {
        rl._writeToOutput = original;
        resolve(a.trim());
      });
    });
  return { ask, askSecret, close: () => rl.close() };
}

async function askYesNo(ask, question, defaultYes = true) {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await ask(`${question} ${suffix} `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function validateKey(key) {
  try {
    const credits = await new KieClient(key).credits();
    return { ok: true, credits, invalid: false };
  } catch (exc) {
    if (exc instanceof KieError && exc.code === 401) return { ok: false, credits: null, invalid: true };
    return { ok: false, credits: null, invalid: false, error: exc.message };
  }
}

async function stepApiKey({ asker, interactive, yes }) {
  const { ask, askSecret } = asker;
  console.log("\nStep 1/2. KIE API Key");
  const envKey = (process.env.KIE_API_KEY || "").trim();

  let key = null;
  if (yes) {
    if (envKey) {
      key = envKey;
      console.log("  Found KIE_API_KEY in environment — using it.");
    } else {
      console.log("  KIE_API_KEY not set in environment — key not saved.");
      console.log("  Set it later: export KIE_API_KEY=your_key");
      console.log("  or: kie config --set-key your_key");
      return { saved: false, credits: null };
    }
  } else {
    if (envKey) {
      const useEnv = await askYesNo(ask, "  Found KIE_API_KEY in environment. Use it?", true);
      if (useEnv) key = envKey;
    }
    while (!key) {
      key = await askSecret("  Enter KIE API Key (https://kie.ai/api-key): ");
      if (!key) {
        const abort = !(await askYesNo(ask, "  No key entered. Try again?", true));
        if (abort) {
          console.log("  Skipped. Save later: kie config --set-key your_key");
          return { saved: false, credits: null };
        }
      }
    }
  }

  process.stdout.write("  Verifying API key (credit balance check)... ");
  const check = await validateKey(key);
  if (check.ok) {
    console.log(`OK, balance: ${check.credits} credits.`);
  } else if (check.invalid) {
    console.log("invalid key (401).");
    if (!yes && interactive && (await askYesNo(ask, "  Try entering key again?", true))) {
      return stepApiKey({ asker, interactive, yes: false });
    }
    console.log("  Key NOT saved. Retry: kie setup");
    return { saved: false, credits: null };
  } else {
    console.log(`failed to verify (${check.error || "network unavailable"}).`);
    console.log("  Saving key without verification — check later: kie credits");
  }

  saveApiKey(key);
  console.log(`  Key saved to ~/.kie-media/config.json (chmod 600).`);
  return { saved: true, credits: check.credits };
}

function installSkillLocal() {
  const dest = path.join(process.cwd(), ".agents", "skills", "visual");
  if (!fs.existsSync(BUNDLED_SKILL_DIR)) {
    console.log(`  Bundled skill not found: ${BUNDLED_SKILL_DIR}`);
    return null;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(BUNDLED_SKILL_DIR, dest, { recursive: true });
  return dest;
}

function npxAvailable() {
  const result = spawnSync("npx", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

async function stepSkill({ asker, interactive, yes, local, repo }) {
  const { ask } = asker;
  console.log("\nStep 2/2. Agent Skill kie-generate");
  const manual = `npx -y skills add ${repo}`;

  if (local) {
    const dest = installSkillLocal();
    if (dest) {
      console.log(`  Skill copied to ${dest}`);
      return { installed: true, how: "local", dest };
    }
    console.log(`  Install manually: ${manual}`);
    return { installed: false, how: null };
  }

  let want = true;
  if (!yes && interactive) {
    want = await askYesNo(ask, "  Install agent skill kie-generate?", true);
  }

  if (want && !yes && interactive && npxAvailable()) {
    console.log(`  Running: ${manual}`);
    const result = spawnSync("npx", ["-y", "skills", "add", repo], { stdio: "inherit" });
    if (result.status === 0) return { installed: true, how: "npx" };
    console.log("  Installation via npx failed.");
  }

  console.log("  Install skill manually:");
  console.log(`    ${manual}`);
  console.log("  or locally from package: kie setup --local");
  return { installed: false, how: null };
}

/** Setup wizard entry point. Flags: --yes, --local, --repo REPO. */
export async function runSetup(flags = {}) {
  const yes = Boolean(flags["--yes"]);
  const local = Boolean(flags["--local"]);
  const repo = flags["--repo"] || process.env.KIE_SKILLS_REPO || SKILLS_REPO;
  const interactive = !yes && Boolean(process.stdin.isTTY);

  console.log("KIE Media CLI — Initial Setup");
  if (!yes && !interactive) {
    console.log("(non-interactive stdin — running with --yes)");
  }

  const asker = createAsker(interactive);
  let keyResult, skillResult;
  try {
    keyResult = await stepApiKey({ asker, interactive, yes: yes || !interactive });
    skillResult = await stepSkill({ asker, interactive, yes: yes || !interactive, local, repo });
  } finally {
    asker.close();
  }

  console.log("\nComplete. Summary:");
  console.log(`  API Key:     ${keyResult.saved ? "saved to ~/.kie-media/config.json" : "not saved"}`);
  if (keyResult.credits !== null && keyResult.credits !== undefined) {
    console.log(`  Balance:     ${keyResult.credits} credits`);
  }
  console.log(
    `  Agent Skill: ${skillResult.installed ? `installed (${skillResult.how})` : "not installed — command printed above"}`
  );
  console.log("\nNext Steps:");
  console.log("  kie models                 # inspect live model catalog");
  console.log('  kie run google/nano-banana --prompt "red cat in a spacesuit" \\');
  console.log("    --wait --download ./out  # first generation");
  return 0;
}
