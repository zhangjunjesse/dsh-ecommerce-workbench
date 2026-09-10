/**
 * Host API test: drives `createHandler` against a real temp store with a real
 * (1x1 PNG) image, covering the whole extract -> recreate -> delete -> clear
 * lifecycle, including that deleted records take their image files with them.
 *
 * extract/recreate now reply with a `jobId` immediately and finish in the
 * background, so these tests wait for the job to settle before asserting.
 *
 * Run: node --test test/
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { createHandler, decodeDataUrl } = require("../lib/index.js");
const { createStore } = require("../lib/store.js");
const { createLocalProvider } = require("../lib/provider.js");

/** Smallest valid PNG, as a browser would hand it over. */
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// `PNG_BYTES` (the same PNG decoded) is declared further down with the
// importFolder fixtures; provider stubs only read it at call time, so the
// single declaration there serves both.

/** Minimal req/res doubles: enough surface for the handler under test. */
function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  return {
    method,
    url,
    headers: { host: "127.0.0.1:3080" },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; }
  };
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || null; },
    end(payload) { this.body = payload === undefined ? null : payload; }
  };
}

async function call(handler, method, url, body) {
  const res = makeRes();
  await handler(makeReq(method, url, body), res);
  const parsed = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
  return { status: res.statusCode, json: parsed, res };
}

async function freshHandler() {
  const root = await mkdtemp(join(tmpdir(), "ecom-store-"));
  const store = createStore(root);
  return { handler: createHandler(store, createLocalProvider()), store, root };
}

/** Poll a job until it leaves the "running" state. */
async function waitJob(handler, jobId) {
  for (let i = 0; i < 100; i++) {
    const r = await call(handler, "GET", "/ecom/api/job/" + jobId);
    if (r.status === 200 && r.json.job && r.json.job.status !== "running") return r.json.job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not settle: " + jobId);
}

/** Start an extract job and wait for it to finish; returns the settled job. */
async function extractJob(handler, payload) {
  const started = await call(handler, "POST", "/ecom/api/extract", payload);
  assert.equal(started.status, 200);
  assert.equal(started.json.ok, true);
  assert.ok(started.json.jobId, "extract returns a jobId immediately");
  return waitJob(handler, started.json.jobId);
}

/** Start a recreate job and wait for it to finish; returns the settled job. */
async function recreateJob(handler, payload) {
  const started = await call(handler, "POST", "/ecom/api/recreate", payload);
  assert.equal(started.status, 200);
  assert.equal(started.json.ok, true);
  assert.ok(started.json.jobId, "recreate returns a jobId immediately");
  return waitJob(handler, started.json.jobId);
}

/**
 * T恤二创 composites a print from 印花二创's RESULTS (二创印花), not the raw
 * 印花原图库 — so tests that need "a print" for tshirtRecreate must run a
 * source image through extract -> recreate first, then use one of the
 * resulting variants (not the extracted library print itself).
 */
async function recreatedPrint(handler) {
  const source = (await extractJob(handler, { images: [{ name: "p.png", dataUrl: PNG_DATA_URL }] })).prints[0];
  const row = (await recreateJob(handler, { sourceId: source.id, count: 1 })).row;
  return row.prints[0];
}

/** Start a tshirtRecreate job and wait for it to finish; returns the settled job. */
async function tshirtRecreateJob(handler, payload) {
  const started = await call(handler, "POST", "/ecom/api/tshirtRecreate", payload);
  assert.equal(started.status, 200);
  assert.equal(started.json.ok, true);
  assert.ok(started.json.jobId, "tshirtRecreate returns a jobId immediately");
  return waitJob(handler, started.json.jobId);
}

test("decodeDataUrl rejects non-image and non-data URLs", () => {
  assert.throws(() => decodeDataUrl("https://example.com/a.png"), /base64 data URLs/);
  assert.throws(() => decodeDataUrl("data:text/plain;base64,aGk="), /not an image/);
  const decoded = decodeDataUrl(PNG_DATA_URL);
  assert.equal(decoded.mimeType, "image/png");
  assert.ok(decoded.buffer.length > 0);
});

test("non-loopback requests are refused", async () => {
  const { handler } = await freshHandler();
  const res = makeRes();
  await handler({ method: "GET", url: "/ecom/api/state", headers: { host: "evil.example.com" } }, res);
  assert.equal(res.statusCode, 403);
});

test("extract stores prints and serves their bytes back", async () => {
  const { handler } = await freshHandler();

  const empty = await call(handler, "GET", "/ecom/api/state");
  assert.deepEqual(empty.json.library, []);

  const job = await extractJob(handler, {
    images: [{ name: "shot.png", dataUrl: PNG_DATA_URL }],
    prompt: "去背景"
  });
  assert.equal(job.status, "done");
  assert.equal(job.done, 1);
  assert.equal(job.prints.length, 1);
  const print = job.prints[0];
  assert.equal(print.prompt, "去背景");
  assert.equal(print.sourceName, "shot.png");

  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.library.length, 1);

  const file = await call(handler, "GET", "/ecom/api/file/" + print.file);
  assert.equal(file.status, 200);
  assert.equal(file.res.headers["content-type"], "image/png");
  assert.ok(Buffer.isBuffer(file.res.body));
});

test("extract requires images", async () => {
  const { handler } = await freshHandler();
  const res = await call(handler, "POST", "/ecom/api/extract", { images: [] });
  assert.equal(res.status, 400);
});

test("recreate produces the requested number of variants from one print", async () => {
  const { handler } = await freshHandler();
  const ex = await extractJob(handler, { images: [{ name: "a.png", dataUrl: PNG_DATA_URL }] });
  const sourceId = ex.prints[0].id;

  const job = await recreateJob(handler, { sourceId, prompt: "黑白线条", style: "简约黑白", count: 4 });
  assert.equal(job.status, "done");
  assert.equal(job.row.prints.length, 4);
  assert.equal(job.row.style, "简约黑白");
  assert.equal(job.row.sourceId, sourceId);

  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.recreations.length, 1);
});

test("recreate rejects an unknown source", async () => {
  const { handler } = await freshHandler();
  const res = await call(handler, "POST", "/ecom/api/recreate", { sourceId: "nope", count: 2 });
  assert.equal(res.status, 404);
});

test("deleting a variant drops its row once empty, and removes its file", async () => {
  const { handler, store } = await freshHandler();
  const ex = await extractJob(handler, { images: [{ name: "a.png", dataUrl: PNG_DATA_URL }] });
  const job = await recreateJob(handler, { sourceId: ex.prints[0].id, count: 2 });
  const row = job.row;
  const before = (await readdir(store.filesDir)).length;

  await call(handler, "POST", "/ecom/api/delete", { kind: "variant", id: row.id, printId: row.prints[0].id });
  let state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.recreations[0].prints.length, 1);
  assert.equal((await readdir(store.filesDir)).length, before - 1);

  await call(handler, "POST", "/ecom/api/delete", { kind: "variant", id: row.id, printId: row.prints[1].id });
  state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.recreations.length, 0, "row disappears with its last variant");
});

test("clearing the library removes records and their files", async () => {
  const { handler, store } = await freshHandler();
  await extractJob(handler, {
    images: [
      { name: "a.png", dataUrl: PNG_DATA_URL },
      { name: "b.png", dataUrl: PNG_DATA_URL }
    ]
  });
  assert.equal((await readdir(store.filesDir)).length, 3, "two source images + one combined print");

  await call(handler, "POST", "/ecom/api/clear", { kind: "library" });
  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.library.length, 0);
  assert.equal((await readdir(store.filesDir)).length, 0);
});

test("state survives a fresh handler over the same directory", async () => {
  const { handler, root } = await freshHandler();
  await extractJob(handler, { images: [{ name: "a.png", dataUrl: PNG_DATA_URL }] });
  const reopened = createHandler(createStore(root), createLocalProvider());
  const state = await call(reopened, "GET", "/ecom/api/state");
  assert.equal(state.json.library.length, 1, "library persisted to disk");
});

test("a file name escaping the store is refused", async () => {
  const { handler } = await freshHandler();
  const res = await call(handler, "GET", "/ecom/api/file/" + encodeURIComponent("../state.json"));
  assert.equal(res.status, 404);
});

test("an unknown job returns 404", async () => {
  const { handler } = await freshHandler();
  const res = await call(handler, "GET", "/ecom/api/job/nope");
  assert.equal(res.status, 404);
});

/** Provider stub with an artificial per-call delay, to prove concurrency by timing. */
function delayedProvider(delayMs) {
  const sleep = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  return {
    name: "delayed-test",
    async extract(input) {
      await sleep();
      // extract now receives an `images` array and returns ONE output.
      const first = (Array.isArray(input.images) && input.images[0]) || { buffer: input.buffer, mimeType: input.mimeType };
      return { buffer: first.buffer, mimeType: first.mimeType };
    },
    async recreate(input) {
      await sleep();
      const count = Math.max(1, Number(input.count) || 1);
      const out = [];
      for (let i = 0; i < count; i++) out.push({ buffer: input.buffer, mimeType: input.mimeType });
      return out;
    }
  };
}

test("extract combines all uploaded images into ONE task and ONE print", async () => {
  const root = await mkdtemp(join(tmpdir(), "ecom-store-"));
  const handler = createHandler(createStore(root), delayedProvider(60));

  const started = Date.now();
  const job = await extractJob(handler, {
    images: [
      { name: "a.png", dataUrl: PNG_DATA_URL },
      { name: "b.png", dataUrl: PNG_DATA_URL },
      { name: "c.png", dataUrl: PNG_DATA_URL },
      { name: "d.png", dataUrl: PNG_DATA_URL }
    ]
  });
  const elapsed = Date.now() - started;

  assert.equal(job.status, "done");
  // One submission = ONE task = ONE print, regardless of how many reference images.
  assert.equal(job.prints.length, 1, "multiple reference images combine into a single output print");
  // The whole batch is one provider call, so it finishes around one delay, not 4x.
  assert.ok(elapsed < 300, "expected one combined call, took " + elapsed + "ms");
});

test("recreate generates all variants of one batch concurrently, not one at a time", async () => {
  const root = await mkdtemp(join(tmpdir(), "ecom-store-"));
  const handler = createHandler(createStore(root), delayedProvider(150));
  const ex = await extractJob(handler, { images: [{ name: "a.png", dataUrl: PNG_DATA_URL }] });

  const started = Date.now();
  const job = await recreateJob(handler, { sourceId: ex.prints[0].id, count: 4 });
  const elapsed = Date.now() - started;

  assert.equal(job.status, "done");
  assert.equal(job.row.prints.length, 4);
  assert.ok(elapsed < 450, "expected concurrent recreate, took " + elapsed + "ms");
});

/** Provider stub whose Nth call (1-based) always fails; the rest succeed like `delayedProvider`. */
function flakyProvider(delayMs, failOnCall) {
  let calls = 0;
  const sleep = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  return {
    name: "flaky-test",
    async extract(input) {
      calls += 1;
      const mine = calls;
      await sleep();
      if (mine === failOnCall) throw new Error("simulated stall/failure on call " + mine);
      const first = (Array.isArray(input.images) && input.images[0]) || { buffer: input.buffer, mimeType: input.mimeType };
      return { buffer: first.buffer, mimeType: first.mimeType };
    },
    async recreate(input) {
      calls += 1;
      const mine = calls;
      await sleep();
      if (mine === failOnCall) throw new Error("simulated stall/failure on call " + mine);
      return [{ buffer: input.buffer, mimeType: input.mimeType }];
    },
    async generate(input) {
      calls += 1;
      const mine = calls;
      await sleep();
      if (mine === failOnCall) throw new Error("simulated stall/failure on call " + mine);
      const first = (Array.isArray(input.images) && input.images[0]) || { buffer: PNG_BYTES, mimeType: "image/png" };
      return [{ buffer: first.buffer, mimeType: first.mimeType }];
    }
  };
}

test("extract reports a real error when the single combined call fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "ecom-store-"));
  // The 1st extract call fails -> the whole (single-call) task errors.
  const handler = createHandler(createStore(root), flakyProvider(5, 1));
  const job = await extractJob(handler, { images: [{ name: "a.png", dataUrl: PNG_DATA_URL }, { name: "b.png", dataUrl: PNG_DATA_URL }] });
  assert.equal(job.status, "error");
  assert.ok(/simulated stall/.test(job.error));
  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.library.length, 0, "no print is kept when the combined call fails");
});

test("recreate keeps successful variants even when one fails, instead of discarding the whole batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "ecom-store-"));
  const handler = createHandler(createStore(root), delayedProvider(10));
  const ex = await extractJob(handler, { images: [{ name: "a.png", dataUrl: PNG_DATA_URL }] });

  // The 2nd recreate call (1st is the extract's own call) fails.
  const flaky = flakyProvider(10, 2);
  const handler2 = createHandler(createStore(root), flaky);
  const job = await recreateJob(handler2, { sourceId: ex.prints[0].id, count: 3 });

  assert.equal(job.status, "done", "batch still succeeds despite one failed variant");
  assert.equal(job.row.prints.length, 2, "the two successful variants are kept");
  assert.ok(job.error && /1 张生成失败/.test(job.error), "failure is surfaced as a warning: " + job.error);
});

// ---------- T恤管理: plain upload, no generation, no job ----------------

test("tshirt/create stores a named T恤 with multiple photos and serves them back", async () => {
  const { handler } = await freshHandler();

  const empty = await call(handler, "GET", "/ecom/api/state");
  assert.deepEqual(empty.json.tshirts, []);

  const res = await call(handler, "POST", "/ecom/api/tshirt/create", {
    name: "白色圆领",
    images: [
      { name: "front.png", dataUrl: PNG_DATA_URL },
      { name: "back.png", dataUrl: PNG_DATA_URL }
    ]
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.tshirt.name, "白色圆领");
  assert.equal(res.json.tshirt.images.length, 2);

  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.tshirts.length, 1);

  const file = await call(handler, "GET", "/ecom/api/file/" + res.json.tshirt.images[0]);
  assert.equal(file.status, 200);
  assert.equal(file.res.headers["content-type"], "image/png");
});

test("tshirt/create requires images and defaults an empty name", async () => {
  const { handler } = await freshHandler();
  const empty = await call(handler, "POST", "/ecom/api/tshirt/create", { name: "x", images: [] });
  assert.equal(empty.status, 400);

  const noName = await call(handler, "POST", "/ecom/api/tshirt/create", { images: [{ name: "a.png", dataUrl: PNG_DATA_URL }] });
  assert.equal(noName.json.tshirt.name, "未命名T恤");
});

test("tshirt/addImages appends more photos to an existing T恤 over time", async () => {
  const { handler } = await freshHandler();
  const created = await call(handler, "POST", "/ecom/api/tshirt/create", {
    name: "条纹T", images: [{ name: "a.png", dataUrl: PNG_DATA_URL }]
  });
  const id = created.json.tshirt.id;

  const added = await call(handler, "POST", "/ecom/api/tshirt/addImages", {
    id, images: [{ name: "b.png", dataUrl: PNG_DATA_URL }, { name: "c.png", dataUrl: PNG_DATA_URL }]
  });
  assert.equal(added.status, 200);
  assert.equal(added.json.tshirt.images.length, 3);

  const missing = await call(handler, "POST", "/ecom/api/tshirt/addImages", {
    id: "nope", images: [{ name: "a.png", dataUrl: PNG_DATA_URL }]
  });
  assert.equal(missing.status, 404);
});

test("deleting one T恤 image keeps the T恤; deleting the whole T恤 removes all its files", async () => {
  const { handler, store } = await freshHandler();
  const created = await call(handler, "POST", "/ecom/api/tshirt/create", {
    name: "T", images: [{ name: "a.png", dataUrl: PNG_DATA_URL }, { name: "b.png", dataUrl: PNG_DATA_URL }]
  });
  const tshirt = created.json.tshirt;
  const before = (await readdir(store.filesDir)).length;

  await call(handler, "POST", "/ecom/api/delete", { kind: "tshirtImage", id: tshirt.id, file: tshirt.images[0] });
  let state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.tshirts[0].images.length, 1);
  assert.equal((await readdir(store.filesDir)).length, before - 1);

  await call(handler, "POST", "/ecom/api/delete", { kind: "tshirt", id: tshirt.id });
  state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.tshirts.length, 0);
  assert.equal((await readdir(store.filesDir)).length, before - 2);
});

test("clearing all T恤s removes records and their files", async () => {
  const { handler, store } = await freshHandler();
  await call(handler, "POST", "/ecom/api/tshirt/create", { name: "A", images: [{ name: "a.png", dataUrl: PNG_DATA_URL }] });
  await call(handler, "POST", "/ecom/api/tshirt/create", { name: "B", images: [{ name: "b.png", dataUrl: PNG_DATA_URL }] });
  assert.equal((await readdir(store.filesDir)).length, 2);

  await call(handler, "POST", "/ecom/api/clear", { kind: "tshirts" });
  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.tshirts.length, 0);
  assert.equal((await readdir(store.filesDir)).length, 0);
});

// ---------- T恤二创: ONE T恤, multi-select photo x multi-select print -> cross product ----------

test("tshirtRecreate applies one T恤 photo + one print pair", async () => {
  const { handler } = await freshHandler();
  const tshirt = (await call(handler, "POST", "/ecom/api/tshirt/create", {
    name: "白T", images: [{ name: "front.png", dataUrl: PNG_DATA_URL }]
  })).json.tshirt;
  const print = await recreatedPrint(handler);

  const job = await tshirtRecreateJob(handler, {
    tshirtId: tshirt.id, printIds: [print.id], prompt: "印在正中间"
  });
  assert.equal(job.status, "done");
  assert.equal(job.rows.length, 1);
  assert.equal(job.rows[0].prints.length, 1);
  assert.equal(job.rows[0].tshirtId, tshirt.id);
  assert.equal(job.rows[0].tshirtName, "白T");
  assert.equal(job.rows[0].printId, print.id);
  assert.equal(job.rows[0].prompt, "印在正中间");

  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.tshirtRecreations.length, 1);
});

test("tshirtRecreate cross-products every selected photo of the T恤 with every selected print", async () => {
  const { handler } = await freshHandler();
  const tshirt = (await call(handler, "POST", "/ecom/api/tshirt/create", {
    name: "白T", images: [
      { name: "front.png", dataUrl: PNG_DATA_URL },
      { name: "back.png", dataUrl: PNG_DATA_URL }
    ]
  })).json.tshirt;
  assert.equal(tshirt.images.length, 2);
  const printA = await recreatedPrint(handler);
  const printB = await recreatedPrint(handler);

  const job = await tshirtRecreateJob(handler, {
    tshirtId: tshirt.id, tshirtImages: [tshirt.images[0], tshirt.images[1]],
    printIds: [printA.id, printB.id], prompt: "居中"
  });
  assert.equal(job.status, "done");
  assert.equal(job.total, 4, "2 photos x 2 print = 4 pairs");
  assert.equal(job.rows.length, 4);

  const pairs = job.rows.map((r) => r.tshirtFile + "|" + r.printId).sort();
  const expected = [
    tshirt.images[0] + "|" + printA.id, tshirt.images[0] + "|" + printB.id,
    tshirt.images[1] + "|" + printA.id, tshirt.images[1] + "|" + printB.id
  ].sort();
  assert.deepEqual(pairs, expected, "every selected photo is paired with every print exactly once");
  job.rows.forEach((r) => {
    assert.equal(r.tshirtId, tshirt.id, "all rows belong to the one selected T恤");
    assert.equal(r.prints.length, 1, "each pair produces exactly one composite");
  });

  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.tshirtRecreations.length, 4);
});

test("tshirtRecreate uses the requested photos when given, and falls back to the first otherwise", async () => {
  const { handler } = await freshHandler();
  const tshirt = (await call(handler, "POST", "/ecom/api/tshirt/create", {
    name: "多图T恤", images: [
      { name: "front.png", dataUrl: PNG_DATA_URL },
      { name: "back.png", dataUrl: PNG_DATA_URL },
      { name: "detail.png", dataUrl: PNG_DATA_URL }
    ]
  })).json.tshirt;
  assert.equal(tshirt.images.length, 3, "one T恤 record holds all three uploaded photos");
  const print = await recreatedPrint(handler);

  // No tshirtImages -> defaults to the first photo.
  const defaultJob = await tshirtRecreateJob(handler, { tshirtId: tshirt.id, printIds: [print.id] });
  assert.equal(defaultJob.rows.length, 1);
  assert.equal(defaultJob.rows[0].tshirtFile, tshirt.images[0]);

  // Explicit photo -> that one is used, not the first.
  const pickedJob = await tshirtRecreateJob(handler, {
    tshirtId: tshirt.id, printIds: [print.id], tshirtImages: [tshirt.images[2]]
  });
  assert.equal(pickedJob.rows[0].tshirtFile, tshirt.images[2]);

  // A file name that isn't one of this T恤's photos is ignored, not trusted;
  // with nothing valid left, it falls back to the first photo.
  const bogusJob = await tshirtRecreateJob(handler, {
    tshirtId: tshirt.id, printIds: [print.id], tshirtImages: ["../../etc/passwd"]
  });
  assert.equal(bogusJob.rows[0].tshirtFile, tshirt.images[0]);
});

test("tshirtRecreate rejects an unknown T恤 or an unknown print", async () => {
  const { handler } = await freshHandler();
  const print = await recreatedPrint(handler);
  const tshirt = (await call(handler, "POST", "/ecom/api/tshirt/create", {
    name: "T", images: [{ name: "a.png", dataUrl: PNG_DATA_URL }]
  })).json.tshirt;

  const noTshirt = await call(handler, "POST", "/ecom/api/tshirtRecreate", { tshirtId: "nope", printIds: [print.id] });
  assert.equal(noTshirt.status, 404);

  const noPrint = await call(handler, "POST", "/ecom/api/tshirtRecreate", { tshirtId: tshirt.id, printIds: ["nope"] });
  assert.equal(noPrint.status, 404);

  const noneSelected = await call(handler, "POST", "/ecom/api/tshirtRecreate", { tshirtId: "", printIds: [print.id] });
  assert.equal(noneSelected.status, 400);

  const noPrints = await call(handler, "POST", "/ecom/api/tshirtRecreate", { tshirtId: tshirt.id, printIds: [] });
  assert.equal(noPrints.status, 400);
});

test("tshirtRecreate rejects a print that is only in 印花原图库 and hasn't been through 印花二创", async () => {
  const { handler } = await freshHandler();
  const libraryOnlyPrint = (await extractJob(handler, { images: [{ name: "p.png", dataUrl: PNG_DATA_URL }] })).prints[0];
  const tshirt = (await call(handler, "POST", "/ecom/api/tshirt/create", {
    name: "T", images: [{ name: "a.png", dataUrl: PNG_DATA_URL }]
  })).json.tshirt;

  const res = await call(handler, "POST", "/ecom/api/tshirtRecreate", { tshirtId: tshirt.id, printIds: [libraryOnlyPrint.id] });
  assert.equal(res.status, 404, "the picker offers 二创印花, not the raw 原图库 print");
});

test("deleting a T恤二创 variant drops its row once empty, and clearing removes the rest", async () => {
  const { handler, store } = await freshHandler();
  const tshirt = (await call(handler, "POST", "/ecom/api/tshirt/create", {
    name: "T", images: [{ name: "a.png", dataUrl: PNG_DATA_URL }]
  })).json.tshirt;
  const printA = await recreatedPrint(handler);
  const printB = await recreatedPrint(handler);
  const job = await tshirtRecreateJob(handler, { tshirtId: tshirt.id, printIds: [printA.id, printB.id] });
  assert.equal(job.rows.length, 2, "one row per (photo, print) pair, each with one composite");
  const row = job.rows[0];
  const before = (await readdir(store.filesDir)).length;

  await call(handler, "POST", "/ecom/api/delete", { kind: "tshirtVariant", id: row.id, printId: row.prints[0].id });
  let state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.tshirtRecreations.length, 1, "the emptied row disappears with its last variant, the other row stays");
  assert.equal((await readdir(store.filesDir)).length, before - 1);

  await call(handler, "POST", "/ecom/api/clear", { kind: "tshirtRecreations" });
  state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.tshirtRecreations.length, 0);
});

// ---------- importFolder: bulk-import already-finished local prints ----------
const { mkdir, writeFile } = require("node:fs/promises");

/** 1x1 PNG bytes, decoded once for writing real fixture files to disk. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** Build a small on-disk fixture tree mirroring the real etsy/产品 layout. */
async function makeImportFixture() {
  const root = await mkdtemp(join(tmpdir(), "ecom-import-"));
  // 00001: several processing variants -> should pick the under5mb one.
  const p1 = join(root, "00001", "印花");
  await mkdir(p1, { recursive: true });
  await writeFile(join(p1, "00001.png"), PNG_BYTES);
  await writeFile(join(p1, "00001_transparent_clean.png"), PNG_BYTES);
  await writeFile(join(p1, "00001_transparent_clean_under5mb.png"), PNG_BYTES);
  // 00002: only a composite render.
  const p2 = join(root, "00002", "印花");
  await mkdir(p2, { recursive: true });
  await writeFile(join(p2, "00002_tee_composite.png"), PNG_BYTES);
  // 00003: no print subfolder at all -> should be skipped.
  await mkdir(join(root, "00003", "场景图"), { recursive: true });
  return root;
}

test("pickRepresentativeFile prefers under5mb, then transparent_clean, then composite, else first", () => {
  const { pickRepresentativeFile } = require("../lib/index.js");
  assert.equal(
    pickRepresentativeFile(["a.png", "a_transparent_clean.png", "a_transparent_clean_under5mb.png", "a_transparent_clean_compressed.png"]),
    "a_transparent_clean_under5mb.png"
  );
  assert.equal(pickRepresentativeFile(["a.png", "a_transparent_clean.png"]), "a_transparent_clean.png");
  assert.equal(pickRepresentativeFile(["a_tee_composite.png"]), "a_tee_composite.png");
  assert.equal(pickRepresentativeFile(["z.png", "a.png"]), "a.png");
});

test("importFolder bulk-imports one representative print per product into 印花二创 results", async () => {
  const { handler } = await freshHandler();
  const root = await makeImportFixture();

  const res = await call(handler, "POST", "/ecom/api/importFolder", { root });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.imported.length, 2, "00001 and 00002 imported; 00003 has no print folder");
  assert.equal(res.json.skipped.length, 1);
  assert.equal(res.json.skipped[0].product, "00003");
  assert.equal(res.json.imported[0].file, "00001_transparent_clean_under5mb.png");
  assert.equal(res.json.imported[1].file, "00002_tee_composite.png");

  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.recreations.length, 2, "each import becomes one recreation row, selectable for T恤二创");
  const names = state.json.recreations.map((r) => r.sourceName).sort();
  assert.deepEqual(names, ["00001", "00002"]);
  assert.equal(state.json.recreations[0].prints.length, 1);
  assert.equal(state.json.recreations[0].style, "导入");

  const file = await call(handler, "GET", "/ecom/api/file/" + state.json.recreations[0].prints[0].file);
  assert.equal(file.status, 200);
  assert.ok(Buffer.isBuffer(file.res.body));
});

test("importFolder rejects an unreadable root", async () => {
  const { handler } = await freshHandler();
  const res = await call(handler, "POST", "/ecom/api/importFolder", { root: join(tmpdir(), "ecom-import-does-not-exist-xyz") });
  assert.equal(res.status, 400);
});

// ---------- importFiles: same bulk-import, sourced from browser-picked files ----------
// (native folder picker never exposes an absolute path to the browser, so the
// client uploads pre-selected representative images instead of a `root`)

test("importFiles bulk-imports uploaded representative images into 印花二创 results", async () => {
  const { handler } = await freshHandler();
  const res = await call(handler, "POST", "/ecom/api/importFiles", {
    items: [
      { product: "00001", fileName: "00001_transparent_clean_under5mb.png", dataUrl: PNG_DATA_URL },
      { product: "00002", fileName: "00002_tee_composite.png", dataUrl: PNG_DATA_URL }
    ]
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.imported.length, 2);
  assert.equal(res.json.skipped.length, 0);
  assert.equal(res.json.imported[0].product, "00001");
  assert.equal(res.json.imported[0].file, "00001_transparent_clean_under5mb.png");

  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.recreations.length, 2, "each uploaded item becomes one recreation row, same as importFolder");
  const names = state.json.recreations.map((r) => r.sourceName).sort();
  assert.deepEqual(names, ["00001", "00002"]);
  assert.equal(state.json.recreations[0].style, "导入");

  const file = await call(handler, "GET", "/ecom/api/file/" + state.json.recreations[0].prints[0].file);
  assert.equal(file.status, 200);
  assert.ok(Buffer.isBuffer(file.res.body));
});

test("importFiles requires items and keeps successes when one item is malformed", async () => {
  const { handler } = await freshHandler();
  const empty = await call(handler, "POST", "/ecom/api/importFiles", { items: [] });
  assert.equal(empty.status, 400);

  const res = await call(handler, "POST", "/ecom/api/importFiles", {
    items: [
      { product: "good", fileName: "a.png", dataUrl: PNG_DATA_URL },
      { product: "bad", fileName: "b.png", dataUrl: "not-a-data-url" }
    ]
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.imported.length, 1);
  assert.equal(res.json.imported[0].product, "good");
  assert.equal(res.json.skipped.length, 1);
  assert.equal(res.json.skipped[0].product, "bad");
});

test("recreate accepts a pasted source image and cleans its file up on row delete", async () => {
  const { handler, store } = await freshHandler();
  // No library: the source comes entirely from the pasted image.
  const job = await recreateJob(handler, { sourceImage: PNG_DATA_URL, sourceName: "pasted.png", prompt: "变体", style: "国潮插画", count: 2 });
  assert.equal(job.status, "done");
  const row = job.row;
  assert.equal(row.sourceIsPasted, true);
  assert.equal(row.sourceName, "pasted.png");
  assert.equal(row.prints.length, 2);

  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.recreations[0].id, row.id);
  // The pasted source was NOT added to the 原图库.
  assert.equal(state.json.library.length, 0);

  const filesBefore = (await readdir(store.filesDir)).length; // pasted source + 2 prints
  assert.equal(filesBefore, 3);

  await call(handler, "POST", "/ecom/api/delete", { kind: "recreation", id: row.id });
  const after = (await readdir(store.filesDir)).length;
  assert.equal(after, 0, "deleting a pasted-source row removes its source file and prints");
});

test("recreate requires sourceId or sourceImage", async () => {
  const { handler } = await freshHandler();
  const res = await call(handler, "POST", "/ecom/api/recreate", { prompt: "x", count: 1 });
  assert.equal(res.status, 400);
});

test("saved prompts upsert, persist, and can be edited or cleared", async () => {
  const { handler, root } = await freshHandler();

  // Create
  let made = await call(handler, "POST", "/ecom/api/prompt", { name: "去背景", text: "isolate the print, remove background" });
  assert.equal(made.status, 200);
  assert.equal(made.json.prompt.name, "去背景");
  const id = made.json.prompt.id;

  // Requires both name and text
  let bad = await call(handler, "POST", "/ecom/api/prompt", { name: "", text: "" });
  assert.equal(bad.status, 400);

  // Persisted in state
  let state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.prompts.length, 1);

  // Edit in place
  made = await call(handler, "POST", "/ecom/api/prompt", { id, name: "去背景2", text: "isolate and clean" });
  assert.equal(made.status, 200);
  assert.equal(made.json.prompt.name, "去背景2");
  assert.equal(made.json.prompt.text, "isolate and clean");

  // Editing an unknown id -> 404
  bad = await call(handler, "POST", "/ecom/api/prompt", { id: "nope", name: "a", text: "b" });
  assert.equal(bad.status, 404);

  // Delete
  await call(handler, "POST", "/ecom/api/delete", { kind: "prompt", id });
  state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.prompts.length, 0);

  // Clear
  await call(handler, "POST", "/ecom/api/prompt", { name: "x", text: "y" });
  await call(handler, "POST", "/ecom/api/clear", { kind: "prompts" });
  state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.prompts.length, 0);

  // Prompt state survives reopening the handler over the same dir.
  await call(handler, "POST", "/ecom/api/prompt", { name: "z", text: "w" });
  const reopened = createHandler(createStore(root), createLocalProvider());
  state = await call(reopened, "GET", "/ecom/api/state");
  assert.equal(state.json.prompts.length, 1);
});

test("GET /ecom/api/jobs lists the jobs still running on the host", async () => {
  const { handler } = await freshHandler();
  const res = await call(handler, "GET", "/ecom/api/jobs");
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(Array.isArray(res.json.jobs));
});

// ---------- 通用工作台: free-form prompt + optional reference images --------

/** Start a generate job and wait for it to settle; returns the settled job. */
async function generateJob(handler, payload) {
  const started = await call(handler, "POST", "/ecom/api/generate", payload);
  assert.equal(started.status, 200);
  assert.ok(started.json.jobId, "generate returns a jobId immediately");
  return waitJob(handler, started.json.jobId);
}

test("generate produces the requested number of outputs from reference images", async () => {
  const { handler } = await freshHandler();

  const job = await generateJob(handler, {
    images: [{ dataUrl: PNG_DATA_URL }, { dataUrl: PNG_DATA_URL }],
    prompt: "把这两张图合成一张海报",
    count: 3
  });
  assert.equal(job.status, "done");
  assert.equal(job.row.prints.length, 3);
  assert.equal(job.row.prompt, "把这两张图合成一张海报");
  assert.equal(job.row.sourceFiles.length, 2, "both reference images are kept with the row");

  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.generations.length, 1);

  const file = await call(handler, "GET", "/ecom/api/file/" + job.row.prints[0].file);
  assert.equal(file.status, 200);
  assert.ok(Buffer.isBuffer(file.res.body), "outputs are real stored files");
});

test("generate works with no reference images (text-to-image)", async () => {
  const { handler } = await freshHandler();
  const job = await generateJob(handler, { prompt: "一只戴帽子的猫", count: 1 });
  assert.equal(job.status, "done");
  assert.equal(job.row.prints.length, 1);
  assert.deepEqual(job.row.sourceFiles, [], "no references stored when none were sent");
});

test("generate requires a prompt", async () => {
  const { handler } = await freshHandler();
  const blank = await call(handler, "POST", "/ecom/api/generate", { images: [{ dataUrl: PNG_DATA_URL }] });
  assert.equal(blank.status, 400);
  const whitespace = await call(handler, "POST", "/ecom/api/generate", { prompt: "   " });
  assert.equal(whitespace.status, 400);
});

test("deleting a generate output drops its row once empty, taking references with it", async () => {
  const { handler, store } = await freshHandler();
  const job = await generateJob(handler, {
    images: [{ dataUrl: PNG_DATA_URL }],
    prompt: "变体",
    count: 2
  });
  const row = job.row;
  assert.equal((await readdir(store.filesDir)).length, 3, "1 reference + 2 outputs");

  await call(handler, "POST", "/ecom/api/delete", { kind: "generationVariant", id: row.id, printId: row.prints[0].id });
  let state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.generations[0].prints.length, 1);
  assert.equal((await readdir(store.filesDir)).length, 2, "one output gone, reference still held by the row");

  await call(handler, "POST", "/ecom/api/delete", { kind: "generationVariant", id: row.id, printId: row.prints[1].id });
  state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.generations.length, 0, "row disappears with its last output");
  assert.equal((await readdir(store.filesDir)).length, 0, "its reference images go with it");
});

test("deleting a whole generate row, and clearing, remove records and files", async () => {
  const { handler, store } = await freshHandler();
  const a = await generateJob(handler, { images: [{ dataUrl: PNG_DATA_URL }], prompt: "a", count: 1 });
  await generateJob(handler, { images: [{ dataUrl: PNG_DATA_URL }], prompt: "b", count: 1 });
  assert.equal((await readdir(store.filesDir)).length, 4, "two rows x (1 reference + 1 output)");

  await call(handler, "POST", "/ecom/api/delete", { kind: "generation", id: a.row.id });
  let state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.generations.length, 1);
  assert.equal((await readdir(store.filesDir)).length, 2);

  await call(handler, "POST", "/ecom/api/clear", { kind: "generations" });
  state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.generations.length, 0);
  assert.equal((await readdir(store.filesDir)).length, 0);
});

test("generate keeps successful outputs even when one fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "ecom-store-"));
  // The 2nd generate call of the batch fails; the rest still land.
  const handler = createHandler(createStore(root), flakyProvider(10, 2));
  const job = await generateJob(handler, { prompt: "x", count: 3 });

  assert.equal(job.status, "done", "batch still succeeds despite one failure");
  assert.equal(job.row.prints.length, 2, "the two successful outputs are kept");
  assert.ok(job.error && /1 张生成失败/.test(job.error), "failure surfaced as a warning: " + job.error);
});

// ---------- 场景图管理: a flat pool of scene photos (paste-and-store, no generation) ----------

test("scene/add stores each uploaded image as its own record and serves its bytes back", async () => {
  const { handler } = await freshHandler();

  const empty = await call(handler, "GET", "/ecom/api/state");
  assert.deepEqual(empty.json.scenes, []);

  const res = await call(handler, "POST", "/ecom/api/scene/add", {
    images: [
      { name: "street.png", dataUrl: PNG_DATA_URL },
      { name: "cafe.png", dataUrl: PNG_DATA_URL }
    ]
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.scenes.length, 2, "one record per image, not one group");
  assert.equal(res.json.scenes[0].name, "street.png");

  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.scenes.length, 2);

  const file = await call(handler, "GET", "/ecom/api/file/" + res.json.scenes[0].file);
  assert.equal(file.status, 200);
  assert.equal(file.res.headers["content-type"], "image/png");
});

test("scene/add requires images and defaults a missing name", async () => {
  const { handler } = await freshHandler();
  const empty = await call(handler, "POST", "/ecom/api/scene/add", { images: [] });
  assert.equal(empty.status, 400);

  const noName = await call(handler, "POST", "/ecom/api/scene/add", { images: [{ dataUrl: PNG_DATA_URL }] });
  assert.equal(noName.json.scenes[0].name, "场景图");
});

test("deleting one scene image removes only that record and its file", async () => {
  const { handler, store } = await freshHandler();
  const added = await call(handler, "POST", "/ecom/api/scene/add", {
    images: [
      { name: "a.png", dataUrl: PNG_DATA_URL },
      { name: "b.png", dataUrl: PNG_DATA_URL },
      { name: "c.png", dataUrl: PNG_DATA_URL }
    ]
  });
  const [a, b, c] = added.json.scenes;
  assert.equal((await readdir(store.filesDir)).length, 3);

  await call(handler, "POST", "/ecom/api/delete", { kind: "scene", id: a.id });
  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.scenes.length, 2);
  assert.deepEqual(state.json.scenes.map((s) => s.id), [b.id, c.id], "the other two are untouched");
  assert.equal((await readdir(store.filesDir)).length, 2, "only the deleted image's bytes are gone");

  const gone = await call(handler, "GET", "/ecom/api/file/" + a.file);
  assert.equal(gone.status, 404);
});

test("clearing scenes removes every record and its files", async () => {
  const { handler, store } = await freshHandler();
  await call(handler, "POST", "/ecom/api/scene/add", { images: [{ name: "a.png", dataUrl: PNG_DATA_URL }] });
  await call(handler, "POST", "/ecom/api/scene/add", { images: [{ name: "b.png", dataUrl: PNG_DATA_URL }] });
  assert.equal((await readdir(store.filesDir)).length, 2);

  await call(handler, "POST", "/ecom/api/clear", { kind: "scenes" });
  const state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.scenes.length, 0);
  assert.equal((await readdir(store.filesDir)).length, 0);
});

test("scene delete and clear stay inside the scene pool", async () => {
  const { handler, store } = await freshHandler();
  const print = (await extractJob(handler, { images: [{ name: "p.png", dataUrl: PNG_DATA_URL }] })).prints[0];
  const scene = (await call(handler, "POST", "/ecom/api/scene/add", { images: [{ name: "s.png", dataUrl: PNG_DATA_URL }] })).json.scenes[0];
  const filesBefore = (await readdir(store.filesDir)).length;

  await call(handler, "POST", "/ecom/api/clear", { kind: "scenes" });
  let state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.scenes.length, 0);
  assert.equal(state.json.library.length, 1, "the 印花原图库 keeps its print");
  assert.equal((await readdir(store.filesDir)).length, filesBefore - 1, "only the scene image's bytes went");

  // A shared delete/clear switch: an unrecognised kind must be a no-op rather
  // than falling through into another collection's removal.
  await call(handler, "POST", "/ecom/api/delete", { kind: "nope", id: scene.id });
  await call(handler, "POST", "/ecom/api/delete", { kind: "nope", id: print.id });
  state = await call(handler, "GET", "/ecom/api/state");
  assert.equal(state.json.library.length, 1);
  assert.equal((await readdir(store.filesDir)).length, filesBefore - 1);
});
