/**
 * Host half of the ecommerce workbench.
 *
 * Owns everything the browser cannot: durable storage of the print library and
 * the re-creation feed (`lib/store.js`), and the image-provider seam that a
 * real service plugs into later (`lib/provider.js`). The browser half talks to
 * it over a loopback-fenced JSON API under `/ecom/api`.
 *
 *   GET   /ecom/api/state           -> { library, recreations, tshirts, tshirtRecreations }
 *   POST  /ecom/api/extract         -> { images:[{name,dataUrl}], prompt }        -> { jobId }
 *   POST  /ecom/api/recreate        -> { sourceId, prompt, style, count }         -> { jobId }
 *   POST  /ecom/api/tshirtRecreate  -> { tshirtId, tshirtImages?[], printIds[] (from 二创印花), prompt } -> { jobId }
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
 */
const { createStore } = require("./store.js");
const { createLocalProvider, createToapisProvider } = require("./provider.js");
const { readdir, readFile } = require("node:fs/promises");
const { join: joinPath, extname } = require("node:path");

/** Extension -> mime map for locally imported files (mirrors lib/store.js). */
const IMPORT_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

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
 * @returns {(req: object, res: object) => Promise<void>}
 */
function createHandler(store, provider) {
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

  return async function handler(req, res) {
    if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: "forbidden" });
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/ecom/api/state") {
        return writeJson(res, 200, Object.assign({ ok: true }, await store.read()));
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
            job.stage = "done";
            job.status = "done";
            await store.update(function (state2) { state2.recreations = [row].concat(state2.recreations); });
          } catch (error) {
            job.status = "error";
            job.error = String((error && error.message) || error);
            if (pastedSource) await store.deleteFile(source.file).catch(function () {});
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
          } else if (payload.kind === "tshirtRecreations") {
            state.tshirtRecreations.forEach(function (r) { r.prints.forEach(function (p) { files.push(p.file); }); });
            state.tshirtRecreations = [];
          } else if (payload.kind === "prompts") {
            state.prompts = [];
          }
          return files;
        });
        for (const file of orphans) await store.deleteFile(file);
        return writeJson(res, 200, { ok: true });
      }

      return writeJson(res, 404, { ok: false, error: "unknown endpoint" });
    } catch (error) {
      return writeJson(res, 500, { ok: false, error: String((error && error.message) || error) });
    }
  };
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
}

module.exports = { name, inject, apply, createHandler, decodeDataUrl, pickRepresentativeFile };
