/**
 * Durable store for the ecommerce workbench.
 *
 * Layout under `<root>` (default `$DSH_HOME/ecommerce-workbench`):
 *   state.json          metadata: { library, recreations, tshirts, tshirtRecreations, prompts, generations, scenes, workflows }
 *   workflow-runs.json  workflow run history: { runs: [...] }
 *   files/<id>.<ext>    image bytes, one file per stored image
 *
 * Metadata and bytes are split so the JSON stays small and readable, and so a
 * browser can stream an image through one URL instead of a base64 blob.
 *
 * Workflow runs get their own document rather than a key in `state.json`, for
 * the same reason: `GET /ecom/api/state` is polled and returns records the
 * client renders directly, and folding a few hundred run logs into it would make
 * every poll carry the entire history. `state.json` holds only each workflow's
 * *config* (enabled / schedule / last outcome).
 *
 * Writes are serialized through one promise chain: the routes are concurrent,
 * but a read-modify-write of state.json must not interleave. The runs document
 * has its own chain, since the two are independent and must not block each other.
 */
const { mkdir, readFile, writeFile, rm, open, rename } = require("node:fs/promises");
const { join, extname } = require("node:path");
const { homedir } = require("node:os");
const { randomUUID } = require("node:crypto");

const EXT_BY_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

/** Default store root; honours `$DSH_HOME` like the rest of DSH. */
function defaultRoot() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "ecommerce-workbench");
}

const EMPTY_STATE = { library: [], recreations: [], tshirts: [], tshirtRecreations: [], prompts: [], generations: [], scenes: [], workflows: [], workflowGroups: [] };

/**
 * Open (and lazily create) a store rooted at `root`.
 * @param {string} [root] - store directory; defaults to `$DSH_HOME/ecommerce-workbench`.
 */
function createStore(root) {
  const dir = root || defaultRoot();
  const filesDir = join(dir, "files");
  const statePath = join(dir, "state.json");
  const runsPath = join(dir, "workflow-runs.json");
  const outputsPath = join(dir, "workflow-outputs.json");
  /** Serializes read-modify-write cycles over state.json. */
  let queue = Promise.resolve();
  /** Serializes the same for workflow-runs.json; independent of the chain above. */
  let runsQueue = Promise.resolve();
  /** Serializes the same for workflow-outputs.json; likewise independent. */
  let outputsQueue = Promise.resolve();

  async function ensureDirs() {
    await mkdir(filesDir, { recursive: true });
  }

  /**
   * Replace a JSON document atomically.
   *
   * A plain `writeFile` truncates the target before writing it, so a *concurrent
   * read* can observe a half-written file and fail to parse it — which reaches
   * the client as a 500 rather than as stale-but-valid data. `/ecom/api/state`
   * is polled while workflow runs are writing config and history, so that window
   * is not theoretical. Writing a sibling temp file and renaming it into place
   * means a reader always sees either the previous complete document or the new
   * one, never a torn one.
   */
  async function writeJsonAtomic(path, value) {
    await ensureDirs();
    const tempPath = path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(tempPath, value, "utf8");
      await rename(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(function () {});
      throw error;
    }
  }

  async function readState() {
    try {
      const raw = await readFile(statePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        library: Array.isArray(parsed.library) ? parsed.library : [],
        recreations: Array.isArray(parsed.recreations) ? parsed.recreations : [],
        tshirts: Array.isArray(parsed.tshirts) ? parsed.tshirts : [],
        tshirtRecreations: Array.isArray(parsed.tshirtRecreations) ? parsed.tshirtRecreations : [],
        prompts: Array.isArray(parsed.prompts) ? parsed.prompts : [],
        generations: Array.isArray(parsed.generations) ? parsed.generations : [],
        scenes: Array.isArray(parsed.scenes) ? parsed.scenes : [],
        // Workflow *config* only; run history lives in workflow-runs.json.
        workflows: Array.isArray(parsed.workflows) ? parsed.workflows : [],
        // Per-group workflow state (approval, last outcome). The groups
        // themselves live on disk in the workflow inbox; this is the side table
        // keyed by group, so a deleted folder just leaves an unused entry.
        workflowGroups: Array.isArray(parsed.workflowGroups) ? parsed.workflowGroups : []
      };
    } catch (error) {
      if (error && error.code === "ENOENT") return Object.assign({}, EMPTY_STATE);
      throw error;
    }
  }

  async function writeState(state) {
    await writeJsonAtomic(statePath, JSON.stringify(state, null, 2));
  }

  /**
   * Read the workflow run history.
   *
   * A missing file is an empty history, not an error: a workbench that has never
   * run a workflow simply has no such document yet.
   * @returns {Promise<{runs: object[]}>}
   */
  async function readRuns() {
    try {
      const raw = await readFile(runsPath, "utf8");
      const parsed = JSON.parse(raw);
      return { runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
    } catch (error) {
      if (error && error.code === "ENOENT") return { runs: [] };
      throw error;
    }
  }

  /**
   * Run `mutator(doc)` over the runs document under its own write lock.
   * @param {(doc: {runs: object[]}) => any} mutator
   */
  function updateRuns(mutator) {
    const run = runsQueue.then(async () => {
      const doc = await readRuns();
      const result = await mutator(doc);
      await writeJsonAtomic(runsPath, JSON.stringify(doc, null, 2));
      return result;
    });
    runsQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * The workflow *product* library: the finished artefacts a workflow produced
   * (a pipeline's final composites), as their own document.
   *
   * Same reasoning as the run history: a single pipeline run can produce
   * hundreds of products, and `/ecom/api/state` is polled and rendered directly,
   * so they must not live in it. The intermediates a workflow creates — prints,
   * re-created prints, T恤 composites — stay in their normal feeds instead, where
   * the rest of the workbench can browse and reuse them.
   * @returns {Promise<{outputs: object[]}>}
   */
  async function readOutputs() {
    try {
      const raw = await readFile(outputsPath, "utf8");
      const parsed = JSON.parse(raw);
      return { outputs: Array.isArray(parsed.outputs) ? parsed.outputs : [] };
    } catch (error) {
      if (error && error.code === "ENOENT") return { outputs: [] };
      throw error;
    }
  }

  /**
   * Run `mutator(doc)` over the product library under its own write lock.
   * @param {(doc: {outputs: object[]}) => any} mutator
   */
  function updateOutputs(mutator) {
    const run = outputsQueue.then(async () => {
      const doc = await readOutputs();
      const result = await mutator(doc);
      await writeJsonAtomic(outputsPath, JSON.stringify(doc, null, 2));
      return result;
    });
    outputsQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Run `mutator(state)` under the write lock; its return value is passed back. */
  function update(mutator) {
    const run = queue.then(async () => {
      const state = await readState();
      const result = await mutator(state);
      await writeState(state);
      return result;
    });
    // Keep the chain alive even when this call rejects.
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    dir,
    filesDir,
    EMPTY_STATE,

    /** @returns {Promise<{library: object[], recreations: object[], tshirts: object[], tshirtRecreations: object[]}>} current metadata. */
    async read() {
      return readState();
    },

    /** @returns {Promise<{runs: object[]}>} the workflow run history, newest first by convention. */
    readRuns,

    updateRuns,

    /** @returns {Promise<{outputs: object[]}>} the workflow product library. */
    readOutputs,

    updateOutputs,

    /**
     * Write image bytes into the store.
     * @param {Buffer} buffer
     * @param {string} mimeType
     * @returns {Promise<string>} the stored file name, usable as `/ecom/api/file/<name>`.
     */
    async putFile(buffer, mimeType) {
      await ensureDirs();
      const ext = EXT_BY_MIME[mimeType] || ".bin";
      const name = randomUUID() + ext;
      await writeFile(join(filesDir, name), buffer);
      return name;
    },

    /**
     * Read stored image bytes.
     * @param {string} name - file name previously returned by {@link putFile}.
     * @returns {Promise<{buffer: Buffer, mimeType: string}>}
     */
    async getFile(name) {
      if (typeof name !== "string" || name.includes("/") || name.includes("\\") || name.includes("..")) {
        throw new Error("invalid file name");
      }
      const buffer = await readFile(join(filesDir, name));
      const ext = extname(name).toLowerCase();
      const mimeType = Object.keys(EXT_BY_MIME).filter(function (m) { return EXT_BY_MIME[m] === ext; })[0] || "application/octet-stream";
      return { buffer, mimeType };
    },

    /** Delete stored bytes; a missing file is not an error. */
    async deleteFile(name) {
      if (typeof name !== "string" || name === "") return;
      await rm(join(filesDir, name), { force: true });
    },

    /**
     * Read the leading bytes of a stored file.
     *
     * Exists so a caller can learn an image's dimensions from its header without
     * pulling a multi-megabyte photo into memory to do it.
     * @param {string} name - file name previously returned by {@link putFile}.
     * @param {number} [maxBytes] - how much to read; defaults to 64 KiB, which
     *   is far more than any of the supported headers needs.
     * @returns {Promise<Buffer>} the bytes actually read (may be shorter).
     */
    async readHeader(name, maxBytes) {
      if (typeof name !== "string" || name.includes("/") || name.includes("\\") || name.includes("..")) {
        throw new Error("invalid file name");
      }
      const limit = maxBytes > 0 ? maxBytes : 65536;
      const handle = await open(join(filesDir, name), "r");
      try {
        const buffer = Buffer.alloc(limit);
        const read = await handle.read(buffer, 0, limit, 0);
        return buffer.subarray(0, read.bytesRead);
      } finally {
        await handle.close();
      }
    },

    update
  };
}

module.exports = { createStore, defaultRoot };
