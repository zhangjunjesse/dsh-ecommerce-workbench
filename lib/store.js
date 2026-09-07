/**
 * Durable store for the ecommerce workbench.
 *
 * Layout under `<root>` (default `$DSH_HOME/ecommerce-workbench`):
 *   state.json        metadata: { library, recreations, tshirts, tshirtRecreations }
 *   files/<id>.<ext>  image bytes, one file per stored image
 *
 * Metadata and bytes are split so the JSON stays small and readable, and so a
 * browser can stream an image through one URL instead of a base64 blob.
 * Writes are serialized through one promise chain: the routes are concurrent,
 * but a read-modify-write of state.json must not interleave.
 */
const { mkdir, readFile, writeFile, rm } = require("node:fs/promises");
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

const EMPTY_STATE = { library: [], recreations: [], tshirts: [], tshirtRecreations: [], prompts: [], generations: [] };

/**
 * Open (and lazily create) a store rooted at `root`.
 * @param {string} [root] - store directory; defaults to `$DSH_HOME/ecommerce-workbench`.
 */
function createStore(root) {
  const dir = root || defaultRoot();
  const filesDir = join(dir, "files");
  const statePath = join(dir, "state.json");
  /** Serializes read-modify-write cycles over state.json. */
  let queue = Promise.resolve();

  async function ensureDirs() {
    await mkdir(filesDir, { recursive: true });
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
        generations: Array.isArray(parsed.generations) ? parsed.generations : []
      };
    } catch (error) {
      if (error && error.code === "ENOENT") return Object.assign({}, EMPTY_STATE);
      throw error;
    }
  }

  async function writeState(state) {
    await ensureDirs();
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
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

    update
  };
}

module.exports = { createStore, defaultRoot };
