/**
 * Image-provider seam for the ecommerce workbench.
 *
 * Nothing that needs a paid image service goes through this interface, and the
 * shipped implementation can be chosen at startup in `lib/index.js`:
 *
 *   - `createToapisProvider()` — real generation. Shells out to the
 *     `toapis-gpt-image-2` skill's `scripts/generate.py` via `child_process`,
 *     which uploads the reference image, creates a task, polls, and downloads
 *     the result. Re-uses the skill's own CLI so the API protocol and key
 *     handling stay with the maintained tool. Throws if the script or an API
 *     key is unavailable, so the caller can fall back.
 *
 *   - `createLocalProvider()` — no-network passthrough: extraction returns the
 *     uploaded bytes unchanged and re-creation returns N copies of the source.
 *     Used as the fallback so the whole app stays functional when the real
 *     service is not configured.
 *
 * A real provider only has to implement the same three methods (`extract`,
 * `recreate`, `applyToTshirt`).
 */
const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const { tmpdir, homedir } = require("node:os");
const { join, extname, dirname } = require("node:path");

/**
 * @typedef {object} ImageInput
 * @property {Buffer} buffer     raw image bytes
 * @property {string} mimeType   e.g. "image/png"
 */

/**
 * @typedef {object} ImageOutput
 * @property {Buffer} buffer
 * @property {string} mimeType
 */

/** Extension -> mime map for the files the ToAPIs service hands back. */
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

/** Default mime when an output file's extension is unknown. */
function mimeFor(filePath) {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] || "image/png";
}

/** Smallest image extension for a mime, so a temp source file gets a sane name. */
function extFor(mimeType) {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  return ".png";
}

/** Path to the ToAPIs CLI, overridable via `TOAPIS_SCRIPT`. */
function defaultScriptPath() {
  if (process.env.TOAPIS_SCRIPT) return process.env.TOAPIS_SCRIPT;
  return join(homedir(), ".dsh", "skills", "toapis-gpt-image-2", "scripts", "generate.py");
}

/** Whether any API key the script would read is actually present. */
function hasApiKey() {
  if (process.env.TOAPIS_API_KEY) return true;
  if (existsSync(join(homedir(), ".toapis_key"))) return true;
  const dir = dirname(defaultScriptPath());
  return existsSync(join(dir, ".toapis_key"));
}

/**
 * Real ToAPIs provider.
 * @param {{scriptPath?: string, python?: string, tmpDir?: string, timeoutMs?: number, baseUrl?: string}} [options]
 * @returns {{name: string, extract: Function, recreate: Function}}
 */
function createToapisProvider(options) {
  const opts = options || {};
  const scriptPath = opts.scriptPath || defaultScriptPath();
  const python = opts.python || process.env.PYTHON || "python";
  const tmpRoot = opts.tmpDir || tmpdir();
  // A single call has been observed to take ~50-90s normally, even under modest
  // concurrency. 4 minutes gives generous headroom while still failing a truly
  // stuck call (observed against the real service under high concurrency) much
  // sooner than the previous 10-minute wait, so a stall degrades one batch's
  // completion time instead of stalling the whole job for up to 10 minutes.
  const timeoutMs = opts.timeoutMs || Number(process.env.ECOM_PROVIDER_TIMEOUT_MS) || 240000;
  // The `toapis.xyz` host stopped resolving; the service lives at `toapis.cn`
  // now. Default there, and let an explicit TOAPIS_BASE_URL still win (the
  // upstream skill script reads the same variable, so this is the one knob).
  const baseUrl = opts.baseUrl || process.env.TOAPIS_BASE_URL || "https://toapis.cn";

  if (typeof scriptPath !== "string" || scriptPath === "" || !existsSync(scriptPath)) {
    throw new Error("toapis generate.py not found: " + scriptPath);
  }
  if (!hasApiKey()) {
    throw new Error("toapis API key not found (set TOAPIS_API_KEY, ~/.toapis_key, or scripts/.toapis_key)");
  }

  /** The base-URL host, for bypassing the local proxy on this one domain. */
  function baseHost(url) {
    try { return new URL(url).hostname; } catch { return ""; }
  }

  /** Add the ToAPIs host to no_proxy so urllib bypasses the broken local proxy. */
  function noProxyEnv() {
    const host = baseHost(baseUrl);
    if (!host) return {};
    const existing = (String(process.env.no_proxy || process.env.NO_PROXY || "")).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    const joined = existing.concat([host, "." + host, "*." + host]).filter(function (h, i, a) { return h && a.indexOf(h) === i; }).join(",");
    return { NO_PROXY: joined, no_proxy: joined };
  }

  /** Run the skill CLI with an args array (no shell), resolve RESULT_JSON. */
  function run(args) {
    return new Promise((resolve, reject) => {
      execFile(python, [scriptPath].concat(args), {
        maxBuffer: 32 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
        env: Object.assign({}, process.env, { TOAPIS_BASE_URL: baseUrl }, noProxyEnv())
      }, function (error, stdout, stderr) {
        if (error) {
          const detail = (stderr && stderr.trim()) || (stdout && stdout.trim()) || String((error && error.message) || error);
          return reject(new Error("toapis generation failed: " + detail));
        }
        const match = /RESULT_JSON=([\s\S]*)/.exec(String(stdout));
        if (!match) return reject(new Error("toapis: no RESULT_JSON in output\n" + stdout));
        try {
          resolve(JSON.parse(match[1]));
        } catch (e) {
          reject(new Error("toapis: could not parse RESULT_JSON"));
        }
      });
    });
  }

  /**
   * "Extract" ONE print from one or more uploaded reference images (all are
   * passed to the service as references). Uses edit mode so the model keeps the
   * design and works from the reference, isolating it from the background.
   * @param {{images?: Array<ImageInput & {name?: string}>, prompt?: string}} input
   * @returns {Promise<ImageOutput>}
   */
  async function extract(input) {
    const images = Array.isArray(input.images) && input.images.length > 0 ? input.images : [{ buffer: input.buffer, mimeType: input.mimeType }];
    const dir = await mkdtemp(join(tmpRoot, "ecom-extract-"));
    try {
      const args = ["--mode", "edit", "--prompt", extractPrompt(input.prompt), "--n", "1"];
      // Every reference image is uploaded; the service combines them into one output.
      for (let i = 0; i < images.length; i++) {
        const src = join(dir, "source" + i + extFor(images[i].mimeType || "image/png"));
        await writeFile(src, images[i].buffer);
        args.push("--image", src);
      }
      const outBase = join(dir, "out");
      args.push("--output", outBase, "--output-dir", dir);
      const result = await run(args);
      const file = result.files && result.files[0];
      if (!file) throw new Error("toapis: no output file");
      return { buffer: await readFile(file), mimeType: mimeFor(file) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(function () {});
    }
  }

  /**
   * "Re-create" N variants from one source print, one per requested variant.
   * @param {ImageInput & {prompt?: string, style?: string, count?: number}} input
   * @returns {Promise<ImageOutput[]>}
   */
  async function recreate(input) {
    const count = Math.max(1, Math.min(12, Number(input.count) || 1));
    const dir = await mkdtemp(join(tmpRoot, "ecom-recreate-"));
    try {
      const source = join(dir, "source" + extFor(input.mimeType));
      await writeFile(source, input.buffer);
      const outBase = join(dir, "out");
      const result = await run([
        "--mode", "edit",
        "--prompt", recreatePrompt(input.prompt, input.style),
        "--image", source,
        "--output", outBase,
        "--output-dir", dir,
        "--n", String(count)
      ]);
      const outputs = [];
      for (const file of result.files || []) {
        outputs.push({ buffer: await readFile(file), mimeType: mimeFor(file) });
      }
      return outputs;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(function () {});
    }
  }

  /**
   * General-purpose generation: N outputs from a free-form prompt plus zero or
   * more reference images. With references it runs edit mode (all references are
   * passed through, so the prompt can talk about "the first/second image"); with
   * none it is plain text-to-image. The prompt is passed through verbatim — this
   * is the daily-driver surface, so nothing is prepended to it.
   * @param {{images?: Array<ImageInput>, prompt?: string, count?: number}} input
   * @returns {Promise<ImageOutput[]>}
   */
  async function generate(input) {
    const count = Math.max(1, Math.min(12, Number(input.count) || 1));
    const images = Array.isArray(input.images) ? input.images : [];
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (prompt === "") throw new Error("prompt required");
    const dir = await mkdtemp(join(tmpRoot, "ecom-generate-"));
    try {
      const args = ["--mode", images.length > 0 ? "edit" : "generate", "--prompt", prompt, "--n", String(count)];
      for (let i = 0; i < images.length; i++) {
        const src = join(dir, "ref" + i + extFor(images[i].mimeType || "image/png"));
        await writeFile(src, images[i].buffer);
        args.push("--image", src);
      }
      const outBase = join(dir, "out");
      args.push("--output", outBase, "--output-dir", dir);
      const result = await run(args);
      const outputs = [];
      for (const file of result.files || []) {
        outputs.push({ buffer: await readFile(file), mimeType: mimeFor(file) });
      }
      if (outputs.length === 0) throw new Error("toapis: no output file");
      return outputs;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(function () {});
    }
  }

  /**
   * Apply a print design onto a T恤 reference photo: one composited T恤-with-print
   * image per requested variant. Passes both images as edit-mode references (tshirt
   * first, print second) so the model keeps the tshirt's shape/fabric/lighting and
   * places the print onto it, rather than treating either as a style reference only.
   * @param {{tshirtBuffer: Buffer, tshirtMimeType: string, printBuffer: Buffer, printMimeType: string, prompt?: string, count?: number}} input
   * @returns {Promise<ImageOutput[]>}
   */
  async function applyToTshirt(input) {
    const count = Math.max(1, Math.min(12, Number(input.count) || 1));
    const dir = await mkdtemp(join(tmpRoot, "ecom-tshirt-"));
    try {
      const tshirtPath = join(dir, "tshirt" + extFor(input.tshirtMimeType));
      const printPath = join(dir, "print" + extFor(input.printMimeType));
      await writeFile(tshirtPath, input.tshirtBuffer);
      await writeFile(printPath, input.printBuffer);
      const outBase = join(dir, "out");
      const result = await run([
        "--mode", "edit",
        "--prompt", applyToTshirtPrompt(input.prompt),
        "--image", tshirtPath,
        "--image", printPath,
        "--output", outBase,
        "--output-dir", dir,
        "--n", String(count)
      ]);
      const outputs = [];
      for (const file of result.files || []) {
        outputs.push({ buffer: await readFile(file), mimeType: mimeFor(file) });
      }
      return outputs;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(function () {});
    }
  }

  return { name: "toapis-gpt-image-2", extract, recreate, applyToTshirt, generate };
}

/** Prompt for extraction: isolate the print design and drop the surroundings. */
function extractPrompt(userPrompt) {
  const base = "Extract the print/印花 design from this image: isolate the pattern, remove the background and surrounding clutter, keep the design clean and fully intact, and output it as a standalone printable图案.";
  return typeof userPrompt === "string" && userPrompt.trim() ? userPrompt + ". " + base : base;
}

/** Prompt for re-creation: a new variant in the chosen style, still recognizable. */
function recreatePrompt(userPrompt, style) {
  let prompt = "Re-create this print as a new design variant: keep the pattern recognizable and printable, output a clean standalone图案.";
  if (typeof style === "string" && style.trim()) prompt += " Follow the style: " + style + ".";
  if (typeof userPrompt === "string" && userPrompt.trim()) prompt += " " + userPrompt;
  return prompt;
}

/** Prompt for applying a print onto a T恤: first reference is the tshirt, second is the print. */
function applyToTshirtPrompt(userPrompt) {
  let prompt = "The first reference image is a T-shirt photo; the second reference image is a print/图案 design. " +
    "Apply the print design onto the T-shirt: keep the T-shirt's shape, fabric texture, folds, lighting and " +
    "background exactly as in the first image, and place the print naturally on the chest area, following the " +
    "fabric's shading and perspective as if it were printed there. Do not alter the T-shirt's silhouette or color " +
    "outside the printed area. Output a clean, photorealistic product-style photo of the finished T-shirt.";
  if (typeof userPrompt === "string" && userPrompt.trim()) prompt += " " + userPrompt;
  return prompt;
}

/**
 * Local no-network provider: passes bytes through.
 * @returns {{name: string, extract: Function, recreate: Function}}
 */
function createLocalProvider() {
  return {
    name: "local-passthrough",
    /**
     * "Extract" ONE print from one or more reference images (the passthrough
     * returns the first reference unchanged).
     * @param {{images?: Array<ImageInput & {name?: string}>, prompt?: string, removeBg?: boolean}} input
     * @returns {Promise<ImageOutput>} the print image bytes
     */
    async extract(input) {
      const first = (Array.isArray(input.images) && input.images[0]) || { buffer: input.buffer, mimeType: input.mimeType };
      return { buffer: first.buffer, mimeType: first.mimeType };
    },
    /**
     * "Re-create" N variants from one source print.
     * @param {ImageInput & {prompt?: string, style?: string, count?: number}} input
     * @returns {Promise<ImageOutput[]>} one entry per requested variant
     */
    async recreate(input) {
      const count = Math.max(1, Number(input.count) || 1);
      const out = [];
      for (let i = 0; i < count; i++) out.push({ buffer: input.buffer, mimeType: input.mimeType });
      return out;
    },
    /**
     * "Apply" a print onto a T恤: no real compositing, just N copies of the tshirt
     * photo so the flow stays usable without a configured real provider.
     * @param {{tshirtBuffer: Buffer, tshirtMimeType: string, printBuffer: Buffer, printMimeType: string, prompt?: string, count?: number}} input
     * @returns {Promise<ImageOutput[]>}
     */
    async applyToTshirt(input) {
      const count = Math.max(1, Number(input.count) || 1);
      const out = [];
      for (let i = 0; i < count; i++) out.push({ buffer: input.tshirtBuffer, mimeType: input.tshirtMimeType });
      return out;
    },
    /**
     * General-purpose generation with no service: echo the first reference N
     * times, or a 1x1 placeholder when the prompt had no reference images, so
     * the flow stays usable without a configured real provider.
     * @param {{images?: Array<ImageInput>, prompt?: string, count?: number}} input
     * @returns {Promise<ImageOutput[]>}
     */
    async generate(input) {
      const count = Math.max(1, Number(input.count) || 1);
      const first = (Array.isArray(input.images) && input.images[0]) || { buffer: PLACEHOLDER_PNG, mimeType: "image/png" };
      const out = [];
      for (let i = 0; i < count; i++) out.push({ buffer: first.buffer, mimeType: first.mimeType });
      return out;
    }
  };
}

/** Smallest valid PNG, used when the passthrough provider has no reference image. */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

module.exports = { createLocalProvider, createToapisProvider, defaultScriptPath, hasApiKey };
