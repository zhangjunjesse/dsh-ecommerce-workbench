/**
 * Host half of the ecommerce workbench.
 *
 * Owns everything the browser cannot: durable storage of the print library and
 * the re-creation feed (`lib/store.js`), and the image-provider seam that a
 * real service plugs into later (`lib/provider.js`). The browser half talks to
 * it over a loopback-fenced JSON API under `/ecom/api`.
 *
 *   GET   /ecom/api/state           -> { library, recreations, tshirts, tshirtRecreations, prompts, generations }
 *   POST  /ecom/api/extract         -> { images:[{name,dataUrl}], prompt }        -> { jobId }
 *   POST  /ecom/api/recreate        -> { sourceId, prompt, style, count }         -> { jobId }
 *   POST  /ecom/api/tshirtRecreate  -> { tshirtId, tshirtImages?[], printIds[] (from 二创印花), prompt } -> { jobId }
 *   POST  /ecom/api/generate        -> { images?:[{dataUrl}], prompt, count }      -> { jobId }
 *                                     one T恤, cross product: every chosen photo x every print, one row per pair
 *   GET   /ecom/api/job/<id>        -> { job }
 *   POST  /ecom/api/tshirt/create   -> { name, images:[{name,dataUrl}] }          -> { tshirt }
 *   POST  /ecom/api/tshirt/addImages -> { id, images:[{name,dataUrl}] }           -> { tshirt }
 *   POST  /ecom/api/importFolder    -> { root }                                  -> { imported, skipped }
 *                                     bulk-import already-finished prints from a local folder tree
 *                                     (one subfolder per product, each holding a 印花/print subfolder)
 *                                     directly into 印花二创 results, bypassing generation entirely.
 *                                     server-side path read; used by the manual-path fallback.
 *   POST  /ecom/api/importFiles     -> { items:[{product,fileName,dataUrl}] }    -> { imported, skipped }
 *                                     same bulk-import, sourced from files the browser already read
 *                                     via a native folder-picker dialog (no filesystem path available
 *                                     to the browser); the client pre-selects one representative image
 *                                     per product before uploading.
 *   POST  /ecom/api/delete          -> { kind, id, printId?, file? }              -> { ok }
 *   POST  /ecom/api/clear           -> { kind }                                  -> { ok }
 *   GET   /ecom/api/file/<name>     -> image bytes
 *
 * Workflows (see lib/workflows.js, lib/workflowRunner.js, lib/scheduler.js).
 * Definitions are code; the user owns the config, the triggers and the history:
 *
 *   (state)                         -> also returns `workflows`: one merged entry per
 *                                      registered definition (enabled, schedule,
 *                                      nextRunAt, last outcome, running)
 *   GET   /ecom/api/workflow/runs   -> { runs }  history, newest first, without logs
 *                                      (?workflowId=&limit=)
 *   GET   /ecom/api/workflow/run    -> { run }   one run in full, with its logs (?id=)
 *   POST  /ecom/api/workflow/config -> { id, enabled?, schedule? } -> { workflow }
 *   POST  /ecom/api/workflow/run    -> { id } -> { runId }  manual trigger
 *   POST  /ecom/api/workflow/clear  -> { id? } -> { removed }  drop run history
 *
 * 印花流水线's own routes (they belong to that workflow, not to the engine; see
 * lib/printPipeline.js for why the queue/estimate/product concepts live there):
 *
 *   GET   /ecom/api/workflow/groups        -> { inbox, groups } the queue, from disk
 *   POST  /ecom/api/workflow/group/upload  -> { name, images } write into a group folder
 *   POST  /ecom/api/workflow/group/approve -> { groupKey, approved, tshirtId?, tshirtImages? }
 *   POST  /ecom/api/workflow/group/delete  -> { groupKey } drop the queue entry + its images
 *   GET   /ecom/api/workflow/estimate      -> { plan } what a group would cost, before it is spent
 *   GET   /ecom/api/workflow/outputs       -> { total, outputs } the product library
 *   POST  /ecom/api/workflow/output/delete -> { id } remove one product (and its bytes)
 */
const { createStore } = require("./store.js");
const { createLocalProvider, createToapisProvider } = require("./provider.js");
const { readImageSize } = require("./imageSize.js");
const { createRegistry, BUILT_IN_WORKFLOWS, effectiveSettings } = require("./workflows.js");
const { createWorkflowRunner } = require("./workflowRunner.js");
const { createScheduler, normalizeSchedule, nextRunAfter } = require("./scheduler.js");
const {
  printPipeline,
  planGroup,
  scanGroups,
  findGroup,
  groupConfig,
  touchGroup,
  normalizeGroupKey,
  groupDirectory,
  inboxRoot,
  WORKFLOW_ID: PIPELINE_ID,
  LOOSE_GROUP,
  LOOSE_GROUP_NAME
} = require("./printPipeline.js");
const { readdir, readFile, mkdir, rm, open } = require("node:fs/promises");
const { join: joinPath, extname } = require("node:path");

/** Extension -> mime map for locally imported files (mirrors lib/store.js). */
const IMPORT_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

/** Mime -> extension, for writing an uploaded reference image into the inbox. */
const INBOX_EXT_BY_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

/** Make an uploaded file name safe to use as one path segment in the inbox. */
function safeInboxName(rawName, mimeType) {
  const ext = INBOX_EXT_BY_MIME[mimeType];
  if (ext === undefined) throw new Error("unsupported image type: " + mimeType);
  const base = String(rawName || "image").replace(/\.[^.]*$/, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
  return (cleaned === "" ? "image" : cleaned.slice(0, 60)) + ext;
}

/**
 * Pick one representative file out of a product's print folder when it holds
 * several processing variants of the same print (raw / transparent-cleaned /
 * compressed / size-capped). Prefers, in order: a size-capped "under5mb"
 * variant (good quality/size balance), an uncompressed transparent-cleaned
 * PNG, a "composite" render, else the first file alphabetically.
 * @param {string[]} fileNames
 * @returns {string}
 */
function pickRepresentativeFile(fileNames) {
  const byPattern = function (re) { return fileNames.filter(function (f) { return re.test(f); })[0]; };
  return (
    byPattern(/under5mb/i) ||
    byPattern(/transparent_clean\.(png|jpe?g|webp)$/i) ||
    byPattern(/composite/i) ||
    fileNames.slice().sort()[0]
  );
}

const name = "dsh-ecommerce-workbench";
const inject = ["webServer"];

/** Largest accepted request body (images arrive as base64 data URLs). */
const MAX_BODY_BYTES = 40 * 1024 * 1024;

/** Accept only same-machine browsers, like the other local-API plugins here. */
function isLoopback(req) {
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  try {
    const hostname = new URL("http://" + host).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function writeJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}

/**
 * Decode a browser `data:` URL into bytes.
 * @param {string} dataUrl
 * @returns {{buffer: Buffer, mimeType: string}}
 */
function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("image data required");
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(dataUrl);
  if (match === null) throw new Error("only base64 data URLs are accepted");
  const mimeType = match[1];
  if (mimeType.indexOf("image/") !== 0) throw new Error("not an image");
  return { buffer: Buffer.from(match[2], "base64"), mimeType };
}

/** Short id for records; distinct from the UUID file names. */
function recordId() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Coerce a pixel dimension into a stored layout hint.
 *
 * The size only ever reserves space for a tile, so anything that is not a
 * positive finite number (missing, null, NaN, a string, a negative) becomes
 * `null` — "unknown" — and the client draws the photo at its natural ratio
 * instead of trusting a bad number. Guessing here is what stretches a photo,
 * which is the exact defect this field exists to prevent.
 */
function imageDimension(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/**
 * Fill in the pixel size of scene photos stored before the size was recorded.
 *
 * The size comes from the file's own header, never from a caller, so a photo
 * either has its true size or none at all. This is a one-time convenience
 * migration rather than a correctness requirement: the client treats a missing
 * size as "unknown" and draws the photo undistorted, so a file that cannot be
 * read is simply left alone.
 *
 * @returns {Promise<number>} how many records gained a size.
 */
async function backfillSceneSizes(store) {
  const state = await store.read();
  const pending = state.scenes.filter(function (scene) {
    return !(scene.width > 0 && scene.height > 0);
  });
  if (pending.length === 0) return 0;

  const found = new Map();
  for (const scene of pending) {
    try {
      const size = readImageSize(await store.readHeader(scene.file));
      if (size) found.set(scene.id, size);
    } catch (error) {
      // Missing or unreadable file: leave it unknown rather than guess.
    }
  }
  if (found.size === 0) return 0;

  await store.update(function (next) {
    next.scenes = next.scenes.map(function (scene) {
      const size = found.get(scene.id);
      return size ? Object.assign({}, scene, { width: size.width, height: size.height }) : scene;
    });
  });
  return found.size;
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once, so a multi-image
 * extract batch or a multi-variant re-creation generates concurrently instead of
 * one-at-a-time, while still bounding how many generation calls (and, for the
 * real provider, child processes) run in parallel.
 * @param {Array} items
 * @param {number} limit
 * @param {(item: any, index: number) => Promise<any>} fn
 * @returns {Promise<Array>} results in the same order as `items`
 */
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push((async function worker() {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

/**
 * How many generation calls run at once for one batch (extract images / recreate
 * variants). Measured against the real ToAPIs service: 4 concurrent calls caused
 * one of them to stall indefinitely (never resolved, never errored, well past its
 * usual ~50-90s) while the other 3 completed normally — a symptom of the upstream
 * service's own concurrency limit, not this plugin's code. 2 is the safer default;
 * override with `ECOM_GENERATION_CONCURRENCY` if the service can take more.
 */
const GENERATION_CONCURRENCY = Number(process.env.ECOM_GENERATION_CONCURRENCY) || 2;

// Global cap on how many generation calls run at once ACROSS all jobs. A single
// batch's own variants are already bounded by mapConcurrent below, but if the
// user submits several batches while one is still running, they must queue
// rather than all hitting the upstream service at once (which is what caused a
// stall at higher concurrency). Sharing one semaphore across every job is what
// makes "submit as many as you like, they queue" safe.
let genActive = 0;
const genWaiters = [];
/** Run `fn()` holding one global generation slot; callers queue behind the cap. */
function withGeneration(fn) {
  return new Promise(function (resolve, reject) {
    function run() {
      genActive++;
      Promise.resolve().then(fn).then(function (value) {
        genActive--;
        release();
        resolve(value);
      }, function (error) {
        genActive--;
        release();
        reject(error);
      });
    }
    function release() {
      const next = genWaiters.shift();
      if (next) next();
    }
    if (genActive >= GENERATION_CONCURRENCY) genWaiters.push(run);
    else run();
  });
}

/**
 * Build the request handler. Exported for tests: it needs no Cordis context.
 * @param {ReturnType<typeof createStore>} store
 * @param {{extract: Function, recreate: Function}} provider
 * @param {object} [options]
 * @param {object} [options.registry] - workflow registry; defaults to the
 *   built-in set. Injectable so the engine (scheduling, history, logs) can be
 *   driven in tests without shipping a placeholder workflow to users.
 * @param {Function} [options.now] - injectable clock, shared by the runner and
 *   the schedule arithmetic.
 * @returns {Function} the request handler, carrying `handler.workflows` (the
 *   runner) and `handler.registry`, so the host can schedule over the very same
 *   runner instance rather than building a second, divergent one.
 */
function createHandler(store, provider, options) {
  const settings = options || {};
  const registry = settings.registry || createRegistry(BUILT_IN_WORKFLOWS);
  const clock = typeof settings.now === "function" ? settings.now : Date.now;
  // In-memory job registry. Generation is slow (tens of seconds per batch), so
  // extract/recreate reply with a job id immediately and run the work in the
  // background; the client polls /ecom/api/job/<id> for live progress and the
  // finished records.
  const jobs = new Map();
  let jobSeq = 0;
  function makeJob(kind, meta) {
    const id = "job-" + String(++jobSeq);
    const job = {
      id,
      kind: kind || null,       // extract | recreate | tshirtRecreate (for client recovery)
      meta: meta || null,       // {title, subtitle, total} shown by client placeholders
      status: "running", // running | done | error
      stage: "queued",   // queued | uploading | generating | downloading | done
      total: 0,
      done: 0,
      prints: [],        // extract: ready prints, appended incrementally
      row: null,         // recreate: the finished feed row, set once complete
      rows: [],          // tshirtRecreate: one row per (T恤, print) pair, appended incrementally
      error: null,
      createdAt: Date.now()
    };
    jobs.set(id, job);
    return job;
  }

  const workflows = createWorkflowRunner({ store, provider, registry, withGeneration, now: clock });

  /**
   * Every registered workflow, merged with its stored config and its live state.
   *
   * The registry is the source of truth for *what exists*; the store carries
   * only what the user changed about it. That split is what lets a definition be
   * added or removed in code without migrating anything: a removed workflow's
   * leftover config is simply never merged, and a new one appears immediately
   * with defaults.
   */
  async function listWorkflowViews() {
    const state = await store.read();
    const configById = new Map(state.workflows.map(function (config) { return [config.id, config]; }));
    return registry.list().map(function (definition) {
      const config = configById.get(definition.id) || {};
      // Prefer what this process knows over what the config file says. The file
      // is written asynchronously as a run starts and finishes, so mixing a
      // snapshot of it with a separately-taken memory snapshot can report a
      // finished run as still running (the two reads land on opposite sides of
      // the finish). `activeRun` and `lastOutcome` are updated together, in one
      // synchronous block, so they cannot disagree; the config is only the
      // fallback for a workflow that has not run since the host started.
      const live = workflows.activeRun(definition.id);
      const observed = live || workflows.lastOutcome(definition.id);
      return {
        id: definition.id,
        name: definition.name,
        description: definition.description || "",
        enabled: config.enabled === true,
        schedule: config.schedule || null,
        nextRunAt: typeof config.nextRunAt === "number" ? config.nextRunAt : null,
        lastRunAt: observed ? observed.startedAt : (typeof config.lastRunAt === "number" ? config.lastRunAt : null),
        lastRunId: observed ? observed.id : (config.lastRunId || null),
        lastStatus: observed ? observed.status : (config.lastStatus || null),
        running: live !== null && live.status === "running",
        runId: live ? live.id : null,
        // The knobs this workflow declares, and the values in force right now —
        // the client renders the settings form from the declaration, so a new
        // setting needs no client change.
        settingFields: definition.settings || [],
        settings: effectiveSettings(definition, config.settings)
      };
    });
  }

  // ---- 印花流水线 ---------------------------------------------------------
  // These helpers and the /workflow/group*, /workflow/estimate and
  // /workflow/output* routes below belong to ONE workflow (lib/printPipeline.js),
  // not to the engine. A pipeline needs a queue of groups, a cost estimate and a
  // product library; the generic engine deliberately knows none of that, and a
  // second workflow with those needs would bring its own.

  /** A plan without the internal lookup tables (Maps/Sets do not survive JSON). */
  function publicPlan(plan) {
    return {
      workflowId: plan.workflowId,
      group: plan.group,
      prompts: {
        extract: { name: plan.prompts.extract.name, found: plan.prompts.extract.found },
        recreate: plan.prompts.recreate.map(function (prompt) {
          return { name: prompt.name, outputs: prompt.outputs };
        }),
        tshirt: { name: plan.prompts.tshirt.name, found: plan.prompts.tshirt.found },
        scene: { name: plan.prompts.scene.name, found: plan.prompts.scene.found }
      },
      tshirt: plan.tshirt,
      scenes: plan.scenes,
      plan: plan.plan,
      pending: plan.pending,
      warnings: plan.warnings,
      cap: plan.cap,
      settings: plan.settings
    };
  }

  /** Every inbox group, merged with its stored queue state and live run. */
  async function pipelineGroups() {
    const state = await store.read();
    const scanned = await scanGroups(store);
    const active = workflows.activeRun(PIPELINE_ID);
    const activeGroup = active && active.params ? active.params.groupKey : null;
    return scanned.map(function (group) {
      const config = groupConfig(state, group.key);
      const running = activeGroup === group.key && active.status === "running";
      return {
        key: group.key,
        name: group.name,
        source: group.source,
        images: group.files,
        imageCount: group.files.length,
        status: running ? "running" : (config.status || "pending"),
        approvedAt: typeof config.approvedAt === "number" ? config.approvedAt : null,
        tshirtId: config.tshirtId || null,
        tshirtImages: Array.isArray(config.tshirtImages) ? config.tshirtImages : null,
        counts: config.counts || null,
        failures: config.failures || 0,
        lastRunAt: typeof config.lastRunAt === "number" ? config.lastRunAt : null,
        lastRunId: config.lastRunId || null,
        updatedAt: typeof config.updatedAt === "number" ? config.updatedAt : null
      };
    });
  }

  /** Write one uploaded reference image into a group folder, without clobbering. */
  async function writeInboxImage(directory, name, buffer) {
    const base = name.replace(/\.[^.]*$/, "");
    const ext = name.slice(base.length);
    let candidate = name;
    for (let attempt = 2; attempt < 200; attempt++) {
      try {
        // `wx` fails when the file exists, which is exactly the collision test.
        const handle = await open(joinPath(directory, candidate), "wx");
        try {
          await handle.write(buffer);
        } finally {
          await handle.close();
        }
        return candidate;
      } catch (error) {
        if (!error || error.code !== "EEXIST") throw error;
        candidate = base + "-" + attempt + ext;
      }
    }
    throw new Error("too many files named like " + name);
  }

  async function handler(req, res) {
    if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: "forbidden" });
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/ecom/api/state") {
        const state = await store.read();
        // The scene pool is documented as newest-first (README / DECISION-0001),
        // so the order is enforced here, at the contract boundary, instead of
        // being left to the insertion order of whoever wrote it last — a single
        // out-of-order write (or a hand-edited state.json) would otherwise turn
        // the waterfall silently non-chronological.
        state.scenes = state.scenes.slice().sort(function (a, b) {
          return ((b && b.createdAt) || 0) - ((a && a.createdAt) || 0);
        });
        // Replace the stored config array with the merged view, so the client
        // renders definitions that exist in code rather than rows in a file.
        const workflowViews = await listWorkflowViews();
        return writeJson(res, 200, Object.assign({ ok: true }, state, { workflows: workflowViews }));
      }

      if (req.method === "GET" && path.startsWith("/ecom/api/file/")) {
        const fileName = decodeURIComponent(path.slice("/ecom/api/file/".length));
        try {
          const file = await store.getFile(fileName);
          res.writeHead(200, { "content-type": file.mimeType, "cache-control": "private, max-age=31536000, immutable" });
          return res.end(file.buffer);
        } catch {
          res.writeHead(404);
          return res.end();
        }
      }

      // Recovery: list the jobs still running on the host so a freshly-mounted
      // client (e.g. after toggling to Chat and back, which unmounts the
      // workbench) can re-attach to in-progress generations and keep polling.
      if (req.method === "GET" && path === "/ecom/api/jobs") {
        const running = Array.from(jobs.values()).filter(function (j) { return j.status === "running"; }).map(function (j) {
          return { jobId: j.id, kind: j.kind, meta: j.meta, start: j.createdAt, stage: j.stage, done: j.done, total: j.total, status: j.status, error: j.error };
        });
        return writeJson(res, 200, { ok: true, jobs: running });
      }

      if (req.method === "GET" && path.startsWith("/ecom/api/job/")) {
        const jobId = decodeURIComponent(path.slice("/ecom/api/job/".length));
        const job = jobs.get(jobId);
        if (job === undefined) return writeJson(res, 404, { ok: false, error: "job not found" });
        return writeJson(res, 200, Object.assign({ ok: true }, { job }));
      }

      // Workflow run history. The list is deliberately log-free: a history table
      // shows time/trigger/status/duration, and shipping every run's log lines to
      // render it would move the whole archive on every poll. One run's logs come
      // from /ecom/api/workflow/run?id=….
      if (req.method === "GET" && path === "/ecom/api/workflow/runs") {
        const workflowId = url.searchParams.get("workflowId");
        const limit = Number(url.searchParams.get("limit")) || 20;
        const runs = await workflows.listRuns(workflowId, limit);
        return writeJson(res, 200, { ok: true, runs: runs });
      }

      if (req.method === "GET" && path === "/ecom/api/workflow/run") {
        const runId = url.searchParams.get("id") || "";
        const run = await workflows.getRun(runId);
        if (run === null) return writeJson(res, 404, { ok: false, error: "run not found" });
        return writeJson(res, 200, { ok: true, run: run });
      }

      // 印花流水线: the queue of groups in the inbox, merged with what is known
      // about each (approved? done? how much did it produce?).
      if (req.method === "GET" && path === "/ecom/api/workflow/groups") {
        const groups = await pipelineGroups();
        return writeJson(res, 200, { ok: true, inbox: inboxRoot(store), groups: groups });
      }

      // What one group would cost, before anything is spent on it. Also reports
      // every reason the pipeline cannot run as configured, so the UI can say
      // why rather than failing an hour later.
      if (req.method === "GET" && path === "/ecom/api/workflow/estimate") {
        const groupKey = url.searchParams.get("groupKey") || "";
        try {
          const plan = await planGroup(store, groupKey);
          return writeJson(res, 200, { ok: true, plan: publicPlan(plan) });
        } catch (error) {
          const code = error && error.code;
          if (code === "NO_GROUP") return writeJson(res, 404, { ok: false, error: String(error.message) });
          return writeJson(res, 400, { ok: false, error: String((error && error.message) || error) });
        }
      }

      // The workflow product library: what the pipeline finished (step 4).
      if (req.method === "GET" && path === "/ecom/api/workflow/outputs") {
        const workflowId = url.searchParams.get("workflowId");
        const groupKey = url.searchParams.get("groupKey");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 2000);
        const all = (await store.readOutputs()).outputs.filter(function (row) {
          if (workflowId && row.workflowId !== workflowId) return false;
          if (groupKey && row.groupKey !== groupKey) return false;
          return true;
        });
        const newestFirst = all.slice().sort(function (a, b) {
          return ((b && b.createdAt) || 0) - ((a && a.createdAt) || 0);
        });
        return writeJson(res, 200, { ok: true, total: all.length, outputs: newestFirst.slice(0, limit) });
      }

      if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method not allowed" });
      const payload = await readJsonBody(req);

      // One submission (one or more uploaded/pasted images) = ONE task = ONE
      // extracted print. All reference images are passed to the service together
      // and combined into a single output print — not one print per image.
      if (path === "/ecom/api/extract") {
        const images = Array.isArray(payload.images) ? payload.images : [];
        if (images.length === 0) return writeJson(res, 400, { ok: false, error: "images required" });
        const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
        const job = makeJob("extract", { title: "提取印花", subtitle: prompt || "正在提取", total: 1 });
        job.total = 1;
        job.stage = "uploading";
        const sourceFiles = [];
        (async function run() {
          try {
            const decodedImages = [];
            for (const image of images) {
              const decoded = decodeDataUrl(image.dataUrl);
              const sourceFile = await store.putFile(decoded.buffer, decoded.mimeType);
              sourceFiles.push(sourceFile);
              decodedImages.push({ buffer: decoded.buffer, mimeType: decoded.mimeType, name: typeof image.name === "string" ? image.name : "image" });
            }
            job.stage = "generating";
            const result = await withGeneration(function () {
              return provider.extract({ images: decodedImages, prompt: prompt, removeBg: payload.removeBg === true });
            });
            job.stage = "downloading";
            const printFile = await store.putFile(result.buffer, result.mimeType);
            const print = {
              id: recordId(),
              sourceName: (images[0] && images[0].name) || "image",
              sourceFile: sourceFiles[0] || printFile,
              sourceFiles: sourceFiles,
              file: printFile,
              prompt: prompt,
              createdAt: Date.now()
            };
            job.prints = [print];
            job.done = 1;
            await store.update(function (state) { state.library = [print].concat(state.library); });
            job.stage = "done";
            job.status = "done";
          } catch (error) {
            job.status = "error";
            job.error = String((error && error.message) || error);
            for (const f of sourceFiles) await store.deleteFile(f).catch(function () {});
          }
        })();
        return writeJson(res, 200, { ok: true, jobId: job.id });
      }

      // One source print -> N re-created variants, kept as one feed row.
      if (path === "/ecom/api/recreate") {
        const count = Math.min(12, Math.max(1, Number(payload.count) || 1));
        // Source is either an existing 原图库 print (sourceId) OR a directly
        // pasted image (sourceImage data URL). The pasted source is stored as a
        // one-off file owned by the resulting feed row (sourceIsPasted), so
        // deleting the row cleans it up; it is not added to the 原图库.
        let source;
        let pastedSource = false;
        if (payload.sourceId) {
          const state = await store.read();
          source = state.library.filter(function (p) { return p.id === payload.sourceId; })[0];
          if (source === undefined) return writeJson(res, 404, { ok: false, error: "source print not found" });
        } else if (typeof payload.sourceImage === "string" && payload.sourceImage.length > 0) {
          const decoded = decodeDataUrl(payload.sourceImage);
          source = {
            id: null,
            file: await store.putFile(decoded.buffer, decoded.mimeType),
            sourceName: (typeof payload.sourceName === "string" && payload.sourceName) ? payload.sourceName : "image",
            isPasted: true
          };
          pastedSource = true;
        } else {
          return writeJson(res, 400, { ok: false, error: "sourceId or sourceImage required" });
        }
        const job = makeJob("recreate", { title: "印花二创", subtitle: (typeof payload.prompt === "string" && payload.prompt) || "正在生成", total: count });
        job.total = count;
        job.stage = "uploading";
        (async function run() {
          try {
            const sourceBytes = await store.getFile(source.file);
            job.stage = "generating";
            // N variants generate concurrently (bounded), not one after another:
            // each is its own single-output call to the provider rather than one
            // call asking for N at once, so the host controls the parallelism. A
            // slow or stuck real-service call must not take down the whole batch:
            // each variant is caught independently, so N-1 successes are still
            // kept and shown even if one variant fails or times out (see
            // GENERATION_CONCURRENCY for why this matters — higher concurrency has
            // been observed to stall one in-flight call against the real ToAPIs
            // service, and Promise.all semantics would otherwise discard every
            // already-paid-for successful result along with it).
            const slots = new Array(count).fill(0);
            const settled = await mapConcurrent(slots, GENERATION_CONCURRENCY, async function (_unused, i) {
              try {
                const outputs = await withGeneration(function () {
                  return provider.recreate({
                    buffer: sourceBytes.buffer,
                    mimeType: sourceBytes.mimeType,
                    prompt: typeof payload.prompt === "string" ? payload.prompt : "",
                    style: typeof payload.style === "string" ? payload.style : "",
                    count: 1
                  });
                });
                const output = outputs[0];
                const print = { id: recordId(), file: await store.putFile(output.buffer, output.mimeType) };
                job.done = job.done + 1;
                job.prints = job.prints.concat([print]);
                return { ok: true, print };
              } catch (error) {
                job.done = job.done + 1; // one item settled (failed); keep the progress bar moving
                return { ok: false, error: String((error && error.message) || error) };
              }
            });
            const prints = settled.filter(function (r) { return r.ok; }).map(function (r) { return r.print; });
            const failed = settled.filter(function (r) { return !r.ok; });
            if (prints.length === 0) {
              job.status = "error";
              job.error = failed[0].error;
              job.stage = "done";
              if (pastedSource) await store.deleteFile(source.file).catch(function () {});
              return;
            }
            job.stage = "downloading";
            const row = {
              id: recordId(),
              sourceId: source.id,
              sourceFile: source.file,
              sourceName: source.sourceName,
              sourceIsPasted: pastedSource,
              prompt: typeof payload.prompt === "string" ? payload.prompt : "",
              style: typeof payload.style === "string" ? payload.style : "",
              prints: prints,
              createdAt: Date.now()
            };
            job.row = row;
            job.error = failed.length > 0 ? (failed.length + " 张生成失败，已保留 " + prints.length + " 张成功结果：" + failed[0].error) : null;
            // Persist before publishing "done" — see the note in /generate above.
            await store.update(function (state2) { state2.recreations = [row].concat(state2.recreations); });
            job.stage = "done";
            job.status = "done";
          } catch (error) {
            job.status = "error";
            job.error = String((error && error.message) || error);
            if (pastedSource) await store.deleteFile(source.file).catch(function () {});
          }
        })();
        return writeJson(res, 200, { ok: true, jobId: job.id });
      }

      // 通用工作台: the daily-driver surface. A free-form prompt plus zero or
      // more pasted/uploaded reference images produces N outputs, kept as one
      // feed row. Unlike the print flows nothing is prepended to the prompt and
      // the references carry no fixed roles — the user drives it entirely.
      // Same non-blocking job shape as /recreate, and the same partial-failure
      // tolerance: a stuck variant does not discard the ones already generated.
      if (path === "/ecom/api/generate") {
        const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
        if (prompt === "") return writeJson(res, 400, { ok: false, error: "prompt required" });
        const images = Array.isArray(payload.images) ? payload.images : [];
        const count = Math.min(12, Math.max(1, Number(payload.count) || 1));
        const job = makeJob("generate", { title: "通用工作台", subtitle: prompt, total: count });
        job.total = count;
        job.stage = "uploading";
        const sourceFiles = [];
        (async function run() {
          try {
            const decodedImages = [];
            for (const image of images) {
              const decoded = decodeDataUrl(image.dataUrl);
              sourceFiles.push(await store.putFile(decoded.buffer, decoded.mimeType));
              decodedImages.push({ buffer: decoded.buffer, mimeType: decoded.mimeType });
            }
            job.stage = "generating";
            const slots = new Array(count).fill(0);
            const settled = await mapConcurrent(slots, GENERATION_CONCURRENCY, async function () {
              try {
                const outputs = await withGeneration(function () {
                  return provider.generate({ images: decodedImages, prompt: prompt, count: 1 });
                });
                const output = outputs[0];
                const item = { id: recordId(), file: await store.putFile(output.buffer, output.mimeType) };
                job.done = job.done + 1;
                job.prints = job.prints.concat([item]);
                return { ok: true, print: item };
              } catch (error) {
                job.done = job.done + 1;
                return { ok: false, error: String((error && error.message) || error) };
              }
            });
            const prints = settled.filter(function (r) { return r.ok; }).map(function (r) { return r.print; });
            const failed = settled.filter(function (r) { return !r.ok; });
            if (prints.length === 0) {
              job.status = "error";
              job.error = failed[0].error;
              job.stage = "done";
              for (const f of sourceFiles) await store.deleteFile(f).catch(function () {});
              return;
            }
            job.stage = "downloading";
            const row = {
              id: recordId(),
              sourceFiles: sourceFiles,
              prompt: prompt,
              prints: prints,
              createdAt: Date.now()
            };
            job.row = row;
            job.error = failed.length > 0 ? (failed.length + " 张生成失败，已保留 " + prints.length + " 张成功结果：" + failed[0].error) : null;
            // Persist before publishing "done". A poller that acts the instant it
            // sees the job finish must find the row already in /ecom/api/state;
            // marking it done first leaves a window where the job looks complete
            // while its result is still missing, which is what made the job tests
            // intermittently fail.
            await store.update(function (state) { state.generations = [row].concat(state.generations); });
            job.stage = "done";
            job.status = "done";
          } catch (error) {
            job.status = "error";
            job.error = String((error && error.message) || error);
            for (const f of sourceFiles) await store.deleteFile(f).catch(function () {});
          }
        })();
        return writeJson(res, 200, { ok: true, jobId: job.id });
      }

      // T恤二创: ONE T恤, but one or more of its PHOTOS (front/back/detail),
      // times one or more prints FROM 印花二创's RESULTS (state.recreations,
      // i.e. 二创印花 — not the raw 印花原图库). Multi-select on either side is
      // a cross product: every selected photo of that T恤 is paired with every
      // selected print, one generation per pair, each pair becoming its own
      // feed row. Same non-blocking job shape as /recreate: reply with a jobId
      // immediately, run all pairs concurrently (bounded), and tolerate partial
      // failure — a stuck/failed pair does not discard the other already-
      // generated rows.
      if (path === "/ecom/api/tshirtRecreate") {
        const state = await store.read();
        const tshirtId = typeof payload.tshirtId === "string" ? payload.tshirtId : "";
        const printIds = Array.isArray(payload.printIds) ? payload.printIds : (payload.printId ? [payload.printId] : []);
        if (tshirtId === "") return writeJson(res, 400, { ok: false, error: "tshirtId required" });
        if (printIds.length === 0) return writeJson(res, 400, { ok: false, error: "printIds required" });

        const tshirt = state.tshirts.filter(function (t) { return t.id === tshirtId; })[0];
        if (tshirt === undefined) return writeJson(res, 404, { ok: false, error: "tshirt not found: " + tshirtId });
        if (!tshirt.images || tshirt.images.length === 0) return writeJson(res, 400, { ok: false, error: "tshirt has no photos" });

        // Which of this T恤's photos to use: one or more, defaulting to the
        // first when none (or none valid) are given.
        const requestedImages = Array.isArray(payload.tshirtImages) ? payload.tshirtImages : [];
        const images = requestedImages.filter(function (f) { return tshirt.images.indexOf(f) !== -1; });
        const chosenImages = images.length > 0 ? images : [tshirt.images[0]];

        // The prints come from 印花二创's results (state.recreations), not the
        // 印花原图库 (state.library): T恤二创 composites an already re-created
        // print onto the T恤, not the raw extracted source.
        const prints = [];
        for (const id of printIds) {
          const print = state.recreations.reduce(function (found, row) {
            if (found !== undefined) return found;
            return row.prints.filter(function (p) { return p.id === id; })[0];
          }, undefined);
          if (print === undefined) return writeJson(res, 404, { ok: false, error: "print not found: " + id });
          prints.push(print);
        }

        // Cross product: every chosen photo of this T恤 paired with every print.
        const pairs = [];
        for (const image of chosenImages) for (const p of prints) pairs.push({ tshirt: tshirt, tshirtImage: image, print: p });

        const job = makeJob("tshirtRecreate", { title: "T恤二创", subtitle: (typeof payload.prompt === "string" && payload.prompt) || "T恤 × 印花 · 正在生成", total: pairs.length });
        job.total = pairs.length;
        job.stage = "uploading";
        (async function run() {
          try {
            job.stage = "generating";
            const settled = await mapConcurrent(pairs, GENERATION_CONCURRENCY, async function (pair) {
              try {
                const tshirtBytes = await store.getFile(pair.tshirtImage);
                const printBytes = await store.getFile(pair.print.file);
                const outputs = await withGeneration(function () {
                  return provider.applyToTshirt({
                    tshirtBuffer: tshirtBytes.buffer,
                    tshirtMimeType: tshirtBytes.mimeType,
                    printBuffer: printBytes.buffer,
                    printMimeType: printBytes.mimeType,
                    prompt: typeof payload.prompt === "string" ? payload.prompt : "",
                    count: 1
                  });
                });
                const output = outputs[0];
                const item = { id: recordId(), file: await store.putFile(output.buffer, output.mimeType) };
                const row = {
                  id: recordId(),
                  tshirtId: pair.tshirt.id,
                  tshirtName: pair.tshirt.name,
                  tshirtFile: pair.tshirtImage,
                  printId: pair.print.id,
                  printFile: pair.print.file,
                  prompt: typeof payload.prompt === "string" ? payload.prompt : "",
                  prints: [item],
                  createdAt: Date.now()
                };
                job.done = job.done + 1;
                job.rows = job.rows.concat([row]);
                await store.update(function (state2) { state2.tshirtRecreations = [row].concat(state2.tshirtRecreations); });
                return { ok: true, row };
              } catch (error) {
                job.done = job.done + 1; // one pair settled (failed); keep the progress bar moving
                return { ok: false, error: String((error && error.message) || error) };
              }
            });
            const rows = settled.filter(function (r) { return r.ok; }).map(function (r) { return r.row; });
            const failed = settled.filter(function (r) { return !r.ok; });
            if (rows.length === 0) {
              job.status = "error";
              job.error = failed[0].error;
              job.stage = "done";
              return;
            }
            job.error = failed.length > 0 ? (failed.length + " 组生成失败，已保留 " + rows.length + " 组成功结果：" + failed[0].error) : null;
            job.stage = "done";
            job.status = "done";
          } catch (error) {
            job.status = "error";
            job.error = String((error && error.message) || error);
          }
        })();
        return writeJson(res, 200, { ok: true, jobId: job.id });
      }

      // Bulk-import already-finished prints from a local folder tree straight into
      // 印花二创's results, with no generation call at all: each immediate
      // subfolder of `root` is treated as one product, its "印花"/print subfolder
      // supplies one representative image (see pickRepresentativeFile for how
      // variants are resolved), and that becomes a one-print recreation row. Runs
      // synchronously (no job): reading and copying local files is fast, unlike
      // real generation. Host-only local path read; safe under the same
      // loopback-only trust model as the rest of this API.
      if (path === "/ecom/api/importFolder") {
        const root = typeof payload.root === "string" ? payload.root.trim() : "";
        if (root === "") return writeJson(res, 400, { ok: false, error: "root required" });
        let productEntries;
        try {
          productEntries = await readdir(root, { withFileTypes: true });
        } catch (error) {
          return writeJson(res, 400, { ok: false, error: "cannot read root: " + String((error && error.message) || error) });
        }
        const productNames = productEntries.filter(function (e) { return e.isDirectory(); }).map(function (e) { return e.name; }).sort();
        const imported = [];
        const skipped = [];
        for (const productName of productNames) {
          const productPath = joinPath(root, productName);
          const productSub = await readdir(productPath, { withFileTypes: true }).catch(function () { return []; });
          const printDirName = productSub.filter(function (e) { return e.isDirectory(); }).map(function (e) { return e.name; })
            .find(function (n) { return n === "印花" || n.toLowerCase() === "print" || n.toLowerCase().indexOf("print") !== -1 || n.indexOf("印花") !== -1; });
          if (printDirName === undefined) { skipped.push({ product: productName, reason: "no 印花/print subfolder" }); continue; }
          const printPath = joinPath(productPath, printDirName);
          const printFiles = (await readdir(printPath, { withFileTypes: true }).catch(function () { return []; }))
            .filter(function (e) { return e.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(e.name); })
            .map(function (e) { return e.name; });
          if (printFiles.length === 0) { skipped.push({ product: productName, reason: "no image files in " + printDirName }); continue; }
          const chosenFile = pickRepresentativeFile(printFiles);
          const chosenPath = joinPath(printPath, chosenFile);
          try {
            const buffer = await readFile(chosenPath);
            const mimeType = IMPORT_MIME_BY_EXT[extname(chosenFile).toLowerCase()] || "image/png";
            const printFile = await store.putFile(buffer, mimeType);
            const row = {
              id: recordId(),
              sourceId: null,
              sourceFile: printFile,
              sourceName: productName,
              prompt: "导入自本地：" + productName + "/" + printDirName + "/" + chosenFile,
              style: "导入",
              prints: [{ id: recordId(), file: printFile }],
              createdAt: Date.now()
            };
            await store.update(function (state) { state.recreations = [row].concat(state.recreations); });
            imported.push({ product: productName, file: chosenFile, printFile: printFile });
          } catch (error) {
            skipped.push({ product: productName, reason: String((error && error.message) || error) });
          }
        }
        return writeJson(res, 200, { ok: true, imported: imported, skipped: skipped });
      }

      // Same bulk-import as /importFolder, but sourced from files the browser
      // already read and uploaded (via a native folder-picker dialog) instead of
      // a server-side path: browsers never expose an absolute filesystem path
      // from that dialog, so there is no `root` to read here — the client already
      // reduced the picked folder to one representative image per product and
      // sends just those. Runs synchronously like /importFolder (no generation).
      if (path === "/ecom/api/importFiles") {
        const items = Array.isArray(payload.items) ? payload.items : [];
        if (items.length === 0) return writeJson(res, 400, { ok: false, error: "items required" });
        const imported = [];
        const skipped = [];
        for (const item of items) {
          const product = typeof item.product === "string" ? item.product : "导入";
          const fileName = typeof item.fileName === "string" ? item.fileName : "image";
          try {
            const decoded = decodeDataUrl(item.dataUrl);
            const printFile = await store.putFile(decoded.buffer, decoded.mimeType);
            const row = {
              id: recordId(),
              sourceId: null,
              sourceFile: printFile,
              sourceName: product,
              prompt: "导入自本地：" + product + "/" + fileName,
              style: "导入",
              prints: [{ id: recordId(), file: printFile }],
              createdAt: Date.now()
            };
            await store.update(function (state) { state.recreations = [row].concat(state.recreations); });
            imported.push({ product, file: fileName, printFile });
          } catch (error) {
            skipped.push({ product, reason: String((error && error.message) || error) });
          }
        }
        return writeJson(res, 200, { ok: true, imported, skipped });
      }

      // T恤管理: a T恤 is just a named group of uploaded photos, stored as-is (no
      // generation, so no job needed — this replies once the bytes are on disk).
      if (path === "/ecom/api/tshirt/create") {
        const images = Array.isArray(payload.images) ? payload.images : [];
        if (images.length === 0) return writeJson(res, 400, { ok: false, error: "images required" });
        const files = [];
        for (const image of images) {
          const decoded = decodeDataUrl(image.dataUrl);
          files.push(await store.putFile(decoded.buffer, decoded.mimeType));
        }
        const tshirt = {
          id: recordId(),
          name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : "未命名T恤",
          images: files,
          createdAt: Date.now()
        };
        await store.update(function (state) { state.tshirts = [tshirt].concat(state.tshirts); });
        return writeJson(res, 200, { ok: true, tshirt });
      }

      if (path === "/ecom/api/tshirt/addImages") {
        const images = Array.isArray(payload.images) ? payload.images : [];
        if (images.length === 0) return writeJson(res, 400, { ok: false, error: "images required" });
        const files = [];
        for (const image of images) {
          const decoded = decodeDataUrl(image.dataUrl);
          files.push(await store.putFile(decoded.buffer, decoded.mimeType));
        }
        let updated = null;
        await store.update(function (state) {
          state.tshirts = state.tshirts.map(function (t) {
            if (t.id !== payload.id) return t;
            updated = Object.assign({}, t, { images: t.images.concat(files) });
            return updated;
          });
        });
        if (updated === null) return writeJson(res, 404, { ok: false, error: "tshirt not found" });
        return writeJson(res, 200, { ok: true, tshirt: updated });
      }

      // 场景图管理: a flat pool of scene photos, stored as-is. One uploaded image
      // = one record (unlike a T恤, a scene photo is not a named group), which is
      // what makes per-image removal in the waterfall a plain single-record
      // delete. No generation, so no job — this replies once the bytes are stored.
      if (path === "/ecom/api/scene/add") {
        const images = Array.isArray(payload.images) ? payload.images : [];
        if (images.length === 0) return writeJson(res, 400, { ok: false, error: "images required" });
        // One paste is ONE moment: the whole batch shares a timestamp, so
        // ordering is decided between uploads rather than by which file in the
        // batch happened to finish its I/O first. Within a batch the picked
        // order is kept, and the newest-first sort stays stable over it.
        const createdAt = Date.now();
        const rows = [];
        for (const image of images) {
          const decoded = decodeDataUrl(image.dataUrl);
          const file = await store.putFile(decoded.buffer, decoded.mimeType);
          // Measured from the bytes just stored, never taken from the caller: a
          // size that cannot be read stays null and the tile then draws the
          // photo at its natural ratio, so a missing or wrong number can never
          // stretch it.
          const size = readImageSize(decoded.buffer);
          rows.push({
            id: recordId(),
            file: file,
            name: typeof image.name === "string" && image.name.trim() ? image.name.trim() : "场景图",
            width: imageDimension(size && size.width),
            height: imageDimension(size && size.height),
            createdAt: createdAt
          });
        }
        // Newest batch lands at the front; the batch's own upload order is kept.
        await store.update(function (state) { state.scenes = rows.concat(state.scenes); });
        return writeJson(res, 200, { ok: true, scenes: rows });
      }

      // Upsert a saved common prompt. Without `id` it creates one; with `id` it
      // updates that prompt in place (a "编辑" action in the manager).
      if (path === "/ecom/api/prompt") {
        const name = typeof payload.name === "string" ? payload.name.trim() : "";
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        if (name === "" || text === "") return writeJson(res, 400, { ok: false, error: "name and text required" });
        let prompt = null;
        await store.update(function (state) {
          if (payload.id) {
            state.prompts = state.prompts.map(function (p) {
              if (p.id !== payload.id) return p;
              prompt = Object.assign({}, p, { name: name, text: text });
              return prompt;
            });
          } else {
            prompt = { id: recordId(), name: name, text: text, createdAt: Date.now() };
            state.prompts = [prompt].concat(state.prompts);
          }
        });
        if (prompt === null) return writeJson(res, 404, { ok: false, error: "prompt not found" });
        return writeJson(res, 200, { ok: true, prompt: prompt });
      }

      // Deleting metadata also deletes the bytes it owned, so the store cannot leak files.
      if (path === "/ecom/api/delete") {
        const orphans = await store.update(function (state) {
          const files = [];
          if (payload.kind === "library") {
            state.library = state.library.filter(function (p) {
              if (p.id !== payload.id) return true;
              files.push(p.file, p.sourceFile);
              (p.sourceFiles || []).forEach(function (f) { files.push(f); });
              return false;
            });
          } else if (payload.kind === "recreation") {
            state.recreations = state.recreations.filter(function (r) {
              if (r.id !== payload.id) return true;
              r.prints.forEach(function (p) { files.push(p.file); });
              if (r.sourceIsPasted) files.push(r.sourceFile);
              return false;
            });
          } else if (payload.kind === "variant") {
            state.recreations = state.recreations.map(function (r) {
              if (r.id !== payload.id) return r;
              const kept = r.prints.filter(function (p) {
                if (p.id !== payload.printId) return true;
                files.push(p.file);
                return false;
              });
              return Object.assign({}, r, { prints: kept });
            }).filter(function (r) { return r.prints.length > 0; });
          } else if (payload.kind === "prompt") {
            state.prompts = state.prompts.filter(function (p) { return p.id !== payload.id; });
          } else if (payload.kind === "generation") {
            state.generations = state.generations.filter(function (g) {
              if (g.id !== payload.id) return true;
              g.prints.forEach(function (p) { files.push(p.file); });
              (g.sourceFiles || []).forEach(function (f) { files.push(f); });
              return false;
            });
          } else if (payload.kind === "generationVariant") {
            // Dropping a row's last output takes the row (and its references) too.
            state.generations = state.generations.map(function (g) {
              if (g.id !== payload.id) return g;
              const kept = g.prints.filter(function (p) {
                if (p.id !== payload.printId) return true;
                files.push(p.file);
                return false;
              });
              if (kept.length === 0) (g.sourceFiles || []).forEach(function (f) { files.push(f); });
              return Object.assign({}, g, { prints: kept });
            }).filter(function (g) { return g.prints.length > 0; });
          } else if (payload.kind === "tshirt") {
            state.tshirts = state.tshirts.filter(function (t) {
              if (t.id !== payload.id) return true;
              t.images.forEach(function (f) { files.push(f); });
              return false;
            });
          } else if (payload.kind === "tshirtImage") {
            state.tshirts = state.tshirts.map(function (t) {
              if (t.id !== payload.id) return t;
              const kept = t.images.filter(function (f) {
                if (f !== payload.file) return true;
                files.push(f);
                return false;
              });
              return Object.assign({}, t, { images: kept });
            });
          } else if (payload.kind === "scene") {
            state.scenes = state.scenes.filter(function (s) {
              if (s.id !== payload.id) return true;
              files.push(s.file);
              return false;
            });
          } else if (payload.kind === "tshirtRecreation") {
            state.tshirtRecreations = state.tshirtRecreations.filter(function (r) {
              if (r.id !== payload.id) return true;
              r.prints.forEach(function (p) { files.push(p.file); });
              return false;
            });
          } else if (payload.kind === "tshirtVariant") {
            state.tshirtRecreations = state.tshirtRecreations.map(function (r) {
              if (r.id !== payload.id) return r;
              const kept = r.prints.filter(function (p) {
                if (p.id !== payload.printId) return true;
                files.push(p.file);
                return false;
              });
              return Object.assign({}, r, { prints: kept });
            }).filter(function (r) { return r.prints.length > 0; });
          }
          return files;
        });
        for (const file of orphans) await store.deleteFile(file);
        return writeJson(res, 200, { ok: true });
      }

      if (path === "/ecom/api/clear") {
        const orphans = await store.update(function (state) {
          const files = [];
          if (payload.kind === "library") {
            state.library.forEach(function (p) {
              files.push(p.file, p.sourceFile);
              (p.sourceFiles || []).forEach(function (f) { files.push(f); });
            });
            state.library = [];
          } else if (payload.kind === "recreations") {
            state.recreations.forEach(function (r) { r.prints.forEach(function (p) { files.push(p.file); }); });
            state.recreations = [];
          } else if (payload.kind === "tshirts") {
            state.tshirts.forEach(function (t) { t.images.forEach(function (f) { files.push(f); }); });
            state.tshirts = [];
          } else if (payload.kind === "scenes") {
            state.scenes.forEach(function (s) { files.push(s.file); });
            state.scenes = [];
          } else if (payload.kind === "tshirtRecreations") {
            state.tshirtRecreations.forEach(function (r) { r.prints.forEach(function (p) { files.push(p.file); }); });
            state.tshirtRecreations = [];
          } else if (payload.kind === "prompts") {
            state.prompts = [];
          } else if (payload.kind === "generations") {
            state.generations.forEach(function (g) {
              g.prints.forEach(function (p) { files.push(p.file); });
              (g.sourceFiles || []).forEach(function (f) { files.push(f); });
            });
            state.generations = [];
          }
          return files;
        });
        for (const file of orphans) await store.deleteFile(file);
        return writeJson(res, 200, { ok: true });
      }

      // Workflow config: enable/disable and the schedule. A workflow's *body* is
      // code (lib/workflows.js) and cannot be created here — this edits only what
      // a user owns about one.
      if (path === "/ecom/api/workflow/config") {
        const definition = registry.get(payload.id);
        if (!definition) return writeJson(res, 404, { ok: false, error: "unknown workflow" });
        let schedule;
        if (Object.prototype.hasOwnProperty.call(payload, "schedule")) {
          try {
            schedule = normalizeSchedule(payload.schedule);
          } catch (error) {
            return writeJson(res, 400, { ok: false, error: String((error && error.message) || error) });
          }
        }
        // Settings are merged over what is already stored and then clamped to the
        // declared ranges, so a partial save keeps the other fields and a value
        // out of range comes back as the value actually in force.
        const settingsChanged = Object.prototype.hasOwnProperty.call(payload, "settings");
        const at = clock();
        await store.update(function (state) {
          const existing = state.workflows.filter(function (w) { return w.id === definition.id; })[0];
          const next = existing
            ? Object.assign({}, existing)
            : { id: definition.id, enabled: false, schedule: null, nextRunAt: null };
          if (settingsChanged) {
            const merged = Object.assign({}, next.settings || {}, payload.settings || {});
            next.settings = effectiveSettings(definition, merged);
          }
          const scheduleChanged = schedule !== undefined;
          if (scheduleChanged) next.schedule = schedule;
          const enabledChanged = typeof payload.enabled === "boolean" && payload.enabled !== (next.enabled === true);
          if (typeof payload.enabled === "boolean") next.enabled = payload.enabled;
          // The next occurrence is recomputed whenever the schedule or the flag
          // changes, and cleared whenever there is nothing to wait for. Enabling
          // deliberately does not fire immediately — the first run is one
          // interval away (or the next wall-clock time), and 立即运行 covers
          // impatience. Recomputing also discards a stale timestamp: without
          // this, re-enabling a long-disabled workflow would fire the instant the
          // scheduler next looked at it.
          const effective = next.schedule || null;
          const willRun = next.enabled === true && effective !== null;
          if (!willRun) next.nextRunAt = null;
          else if (scheduleChanged || enabledChanged || typeof next.nextRunAt !== "number") {
            next.nextRunAt = nextRunAfter(effective, at);
          }
          state.workflows = existing
            ? state.workflows.map(function (w) { return w.id === definition.id ? next : w; })
            : state.workflows.concat([next]);
        });
        const views = await listWorkflowViews();
        return writeJson(res, 200, {
          ok: true,
          workflow: views.filter(function (w) { return w.id === definition.id; })[0] || null
        });
      }

      // Manual trigger. Deliberately independent of `enabled`: 停用 stops the
      // schedule, it does not forbid running the thing by hand. `params` names
      // what this run should work on (the pipeline takes a group key and a
      // "force" flag) — and because a manual run names its target explicitly, it
      // needs no approval; approval only gates runs nobody is watching.
      if (path === "/ecom/api/workflow/run") {
        const definition = registry.get(payload.id);
        if (!definition) return writeJson(res, 404, { ok: false, error: "unknown workflow" });
        try {
          const record = workflows.start(definition.id, "manual", payload.params);
          return writeJson(res, 200, { ok: true, runId: record.id, run: workflows.toListEntry(record) });
        } catch (error) {
          if (error && error.code === "ALREADY_RUNNING") {
            return writeJson(res, 409, { ok: false, error: "该工作流已有一次运行在进行中", runId: error.runId });
          }
          if (error && error.code === "BAD_PARAMS") return writeJson(res, 400, { ok: false, error: String(error.message) });
          return writeJson(res, 500, { ok: false, error: String((error && error.message) || error) });
        }
      }

      // 印花流水线: put this group in the queue for the scheduler, or take it out.
      // Approving is what makes a run happen without anyone watching, so it is
      // also where the T恤 selection for the group is stored.
      if (path === "/ecom/api/workflow/group/approve") {
        const approved = payload.approved !== false;
        let group;
        try {
          group = await findGroup(store, payload.groupKey);
        } catch (error) {
          return writeJson(res, error && error.code === "NO_GROUP" ? 404 : 400, { ok: false, error: String((error && error.message) || error) });
        }
        const patch = { updatedAt: Date.now() };
        if (approved) {
          patch.approvedAt = Date.now();
          // Re-approved means "run me again": a group that finished must become
          // eligible for the scheduler again, otherwise approving a done group
          // (after adding more screenshots to it) would silently do nothing.
          patch.status = "pending";
        } else {
          patch.approvedAt = null;
        }
        if (typeof payload.tshirtId === "string" && payload.tshirtId !== "") patch.tshirtId = payload.tshirtId;
        if (Array.isArray(payload.tshirtImages)) {
          patch.tshirtImages = payload.tshirtImages.filter(function (file) { return typeof file === "string"; });
        }
        await touchGroup(store, group.key, patch);
        const groups = await pipelineGroups();
        return writeJson(res, 200, {
          ok: true,
          group: groups.filter(function (g) { return g.key === group.key; })[0] || null
        });
      }

      // 印花流水线: upload reference images straight into a group folder, so the
      // UI path and the "drop it in the folder" path converge on one place.
      if (path === "/ecom/api/workflow/group/upload") {
        let key;
        try {
          key = normalizeGroupKey(payload.name);
          if (key === LOOSE_GROUP) throw Object.assign(new Error("「" + LOOSE_GROUP_NAME + "」是散图的保留分组名，请换一个"), { code: "BAD_GROUP" });
        } catch (error) {
          return writeJson(res, 400, { ok: false, error: String((error && error.message) || error) });
        }
        const images = Array.isArray(payload.images) ? payload.images : [];
        if (images.length === 0) return writeJson(res, 400, { ok: false, error: "请至少上传一张参考图" });
        const directory = groupDirectory(store, key);
        await mkdir(directory, { recursive: true });
        const saved = [];
        const rejected = [];
        for (const image of images) {
          try {
            const decoded = decodeDataUrl(image && image.dataUrl);
            const fileName = safeInboxName(image && image.name, decoded.mimeType);
            saved.push(await writeInboxImage(directory, fileName, decoded.buffer));
          } catch (error) {
            rejected.push(String((error && error.message) || error));
          }
        }
        if (saved.length === 0) {
          return writeJson(res, 400, { ok: false, error: "没有可用的图片：" + (rejected[0] || "格式不支持") });
        }
        const groups = await pipelineGroups();
        return writeJson(res, 200, {
          ok: true,
          saved: saved,
          rejected: rejected,
          group: groups.filter(function (g) { return g.key === key; })[0] || null,
          inbox: inboxRoot(store)
        });
      }

      // Drop one group from the queue and its images from the inbox. Products
      // already generated are deliberately kept — they cost real credits, and
      // removing a queue entry is not a request to throw them away.
      if (path === "/ecom/api/workflow/group/delete") {
        let key;
        try {
          key = normalizeGroupKey(payload.groupKey);
        } catch (error) {
          return writeJson(res, 400, { ok: false, error: String((error && error.message) || error) });
        }
        if (key === LOOSE_GROUP) {
          // The loose bucket is the inbox root itself: remove only its images,
          // never the directory (which also holds every real group).
          const loose = (await scanGroups(store)).filter(function (group) { return group.key === LOOSE_GROUP; })[0];
          for (const name of loose ? loose.files : []) {
            await rm(joinPath(inboxRoot(store), name), { force: true });
          }
        } else {
          await rm(groupDirectory(store, key), { recursive: true, force: true });
        }
        await store.update(function (state) {
          state.workflowGroups = (state.workflowGroups || []).filter(function (record) {
            return !(record.key === key && record.workflowId === PIPELINE_ID);
          });
        });
        return writeJson(res, 200, { ok: true });
      }

      if (path === "/ecom/api/workflow/output/delete") {
        const id = typeof payload.id === "string" ? payload.id : "";
        if (id === "") return writeJson(res, 400, { ok: false, error: "id required" });
        let removedFile = null;
        await store.updateOutputs(function (doc) {
          doc.outputs = doc.outputs.filter(function (row) {
            if (row.id !== id) return true;
            removedFile = row.file;
            return false;
          });
        });
        if (removedFile !== null) await store.deleteFile(removedFile);
        return writeJson(res, 200, { ok: true, removed: removedFile !== null });
      }

      if (path === "/ecom/api/workflow/clear") {
        const removed = await workflows.clearRuns(
          typeof payload.id === "string" && payload.id !== "" ? payload.id : null
        );
        return writeJson(res, 200, { ok: true, removed: removed });
      }

      return writeJson(res, 404, { ok: false, error: "unknown endpoint" });
    } catch (error) {
      return writeJson(res, 500, { ok: false, error: String((error && error.message) || error) });
    }
  }

  // Handed out so the host can schedule over this very runner: a second runner
  // would have its own in-flight map, and the single-run-per-workflow guarantee
  // would hold only within each of them.
  handler.workflows = workflows;
  handler.registry = registry;
  return handler;
}

/**
 * Mount the workbench API.
 * @param {object} ctx - Cordis context carrying the web server.
 */
function apply(ctx) {
  const store = createStore();
  // Prefer the real ToAPIs generation; fall back to the no-network passthrough
  // when the script or an API key is unavailable, so the workbench stays usable.
  let provider;
  try {
    provider = createToapisProvider();
  } catch (error) {
    console.warn("[ecommerce-workbench] real image provider unavailable: " + String((error && error.message) || error));
    provider = createLocalProvider();
  }
  const handler = createHandler(store, provider);
  ctx.effect(
    function () { return ctx.webServer.register({ kind: "prefix", path: "/ecom/api", handler: handler }); },
    "dsh-ecommerce-workbench: /ecom/api route"
  );
  // One-time: scene photos stored before sizes were recorded get theirs read out
  // of the file header, so the waterfall can reserve their height truthfully
  // instead of guessing a ratio. Deliberately fire-and-forget — it is a
  // convenience, and a failure must not stop the workbench from mounting.
  backfillSceneSizes(store).then(
    function (count) {
      if (count > 0) console.log("[ecommerce-workbench] backfilled " + count + " scene photo size(s)");
    },
    function (error) {
      console.warn("[ecommerce-workbench] scene size backfill skipped: " + String((error && error.message) || error));
    }
  );

  // Workflow scheduling, over the runner the handler already owns. The
  // scheduler is in-process only: workflows fire while DSH is running, and an
  // occurrence missed while it was down is recorded as skipped rather than
  // caught up (see lib/scheduler.js).
  const scheduler = createScheduler({
    store: store,
    registry: handler.registry,
    runner: handler.workflows,
    now: Date.now
  });
  ctx.effect(
    function () {
      // Close out runs a previous host left mid-flight before scheduling starts,
      // so history cannot show a run "running" forever.
      handler.workflows.recoverInterrupted().then(
        function (count) {
          if (count > 0) console.log("[ecommerce-workbench] closed " + count + " interrupted workflow run(s)");
        },
        function (error) {
          console.warn("[ecommerce-workbench] workflow run recovery skipped: " + String((error && error.message) || error));
        }
      ).then(function () {
        return scheduler.start();
      }).catch(function (error) {
        console.warn("[ecommerce-workbench] workflow scheduler did not start: " + String((error && error.message) || error));
      });
      return function () { scheduler.stop(); };
    },
    "dsh-ecommerce-workbench: workflow scheduler"
  );
}

module.exports = {
  name,
  inject,
  apply,
  createHandler,
  decodeDataUrl,
  pickRepresentativeFile,
  backfillSceneSizes,
  createRegistry,
  createWorkflowRunner,
  createScheduler,
  normalizeSchedule,
  nextRunAfter,
  BUILT_IN_WORKFLOWS
};
