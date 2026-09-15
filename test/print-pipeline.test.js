/**
 * 印花流水线 test: drives the real workflow through the real handler, store and
 * registry, with a counting provider stub standing in for ToAPIs.
 *
 * The centrepiece is the arithmetic the feature is specified by — one group of
 * screenshots must cost exactly 1 extract + 8 re-created prints + 24 T恤
 * composites + 192 composites-in-scene = 225 calls — because that number is both
 * the promise to the user and the thing that spends their credits. Everything
 * else here protects a property that would otherwise only show up as wasted
 * money: re-running resumes instead of paying twice, the ceiling actually stops a
 * run, and a group cannot escape the inbox directory.
 *
 * Run: node --test "test/*.test.js"
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, readdir, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  createHandler,
  createRegistry,
  BUILT_IN_WORKFLOWS
} = require("../lib/index.js");
const { createStore } = require("../lib/store.js");
const {
  WORKFLOW_ID,
  LOOSE_GROUP,
  inboxRoot
} = require("../lib/printPipeline.js");

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_DATA_URL.split(",")[1], "base64");

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
    body: null,
    headers: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
    end(payload) { this.body = payload === undefined ? null : payload; }
  };
}

async function call(handler, method, url, body) {
  const res = makeRes();
  await handler(makeReq(method, url, body), res);
  return {
    status: res.statusCode,
    headers: res.headers || {},
    json: typeof res.body === "string" ? JSON.parse(res.body) : res.body
  };
}

/** Counts every provider call, so a run's real cost can be asserted exactly. */
function makeStubProvider() {
  const calls = { extract: 0, recreate: 0, applyToTshirt: 0, generate: 0 };
  // The full inputs of every 融合 call, so a test can assert what the pipeline
  // actually handed the model — the extra 细节图 references in particular, which
  // are invisible in a call count.
  const tshirtInputs = [];
  return {
    name: "stub",
    calls,
    tshirtInputs,
    total() { return calls.extract + calls.recreate + calls.applyToTshirt + calls.generate; },
    async extract() { calls.extract++; return { buffer: PNG_BYTES, mimeType: "image/png" }; },
    async recreate() { calls.recreate++; return [{ buffer: PNG_BYTES, mimeType: "image/png" }]; },
    async applyToTshirt(input) {
      calls.applyToTshirt++;
      tshirtInputs.push(input || {});
      return [{ buffer: PNG_BYTES, mimeType: "image/png" }];
    },
    async generate() { calls.generate++; return [{ buffer: PNG_BYTES, mimeType: "image/png" }]; }
  };
}

/** Write a real PNG into the inbox, where the pipeline reads groups from. */
async function putInboxImage(store, groupKey, fileName) {
  const directory = groupKey === LOOSE_GROUP ? inboxRoot(store) : join(inboxRoot(store), groupKey);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), PNG_BYTES);
}

test("a group's reference image is served from the inbox, and the name cannot climb out", async () => {
  // A group's screenshots are read straight off disk and never copied into the
  // store, so `/ecom/api/file/` cannot serve them — the names in `group.images` are
  // uploaded file names, not store ids. The UI needs them anyway: a group is called
  // 「组3」 and "3 张参考图" is not an identity.
  //
  // Both halves of the query come from the client, so this is also the route where
  // a traversal would land, and both are asserted here.
  const { handler, store, groupKey } = await freshPipeline();
  await putInboxImage(store, groupKey, "shot.png");

  const ok = await call(handler, "GET", "/ecom/api/workflow/group/image?groupKey=" +
    encodeURIComponent(groupKey) + "&name=" + encodeURIComponent("shot.png"));
  assert.equal(ok.status, 200, "the group's own image must be served");
  assert.equal(ok.headers["content-type"], "image/png", "and typed, or the browser will not draw it");
  assert.equal(ok.json.length, PNG_BYTES.length, "with the actual bytes");

  const missing = await call(handler, "GET", "/ecom/api/workflow/group/image?groupKey=" +
    encodeURIComponent(groupKey) + "&name=nope.png");
  assert.equal(missing.status, 404);

  // The file name cannot climb out of the group folder...
  for (const bad of ["../state.json", "..\\state.json", "sub/shot.png", ""]) {
    const res = await call(handler, "GET", "/ecom/api/workflow/group/image?groupKey=" +
      encodeURIComponent(groupKey) + "&name=" + encodeURIComponent(bad));
    assert.equal(res.status, 400, "a file name of " + JSON.stringify(bad) + " must be refused, not resolved");
  }

  // ...and the key cannot climb out of the inbox root.
  const badKey = await call(handler, "GET", "/ecom/api/workflow/group/image?groupKey=" +
    encodeURIComponent("../..") + "&name=shot.png");
  assert.equal(badKey.status, 400, "a group key that escapes the inbox must be refused");
});

/**
 * A store seeded with everything the pipeline needs: the four prompts, one T恤
 * with three photos (三款式), a scene pool, and one group of two screenshots.
 */
async function freshPipeline(options) {
  const settings = options || {};
  const root = await mkdtemp(join(tmpdir(), "ecom-pipe-"));
  const store = createStore(root);

  const promptRows = [
    { name: "印花提取", text: "提取这件衣服上的印花；" },
    { name: "印花二创-1", text: "重新设计印花 1" },
    { name: "印花二创-2", text: "重新设计印花 2" },
    { name: "印花二创-3", text: "重新设计印花 3" },
    { name: "印花二创-4", text: "重新设计印花 4" },
    { name: "印花T恤融合", text: "把印花融入T恤" },
    { name: "换装+裂变", text: "换装并裂变" }
  ].map(function (prompt, index) {
    return { id: "p" + index, name: prompt.name, text: prompt.text, createdAt: index };
  });

  const tshirtPhotos = [];
  for (let i = 0; i < (settings.tshirtPhotos === undefined ? 3 : settings.tshirtPhotos); i++) {
    tshirtPhotos.push(await store.putFile(PNG_BYTES, "image/png"));
  }
  const sceneFiles = [];
  for (let i = 0; i < (settings.scenes === undefined ? 4 : settings.scenes); i++) {
    sceneFiles.push(await store.putFile(PNG_BYTES, "image/png"));
  }

  await store.update(function (state) {
    state.prompts = settings.prompts === undefined ? promptRows : settings.prompts;
    if (settings.tshirt !== false) {
      // `tshirtRecord` seeds a record that already has 款式, for the tests about
      // colour selection; the default stays the flat photo list, which is also how
      // a T恤 created before 款式 existed reaches the pipeline.
      state.tshirts = [settings.tshirtRecord === undefined
        ? { id: "t1", name: "测试T恤", images: tshirtPhotos, createdAt: 1 }
        : settings.tshirtRecord];
    }
    state.scenes = sceneFiles.map(function (file, index) {
      return { id: "s" + index, file: file, name: "scene", width: 1, height: 1, createdAt: index };
    });
  });

  const groupKey = settings.groupKey === undefined ? "商品A" : settings.groupKey;
  const imageCount = settings.imageCount === undefined ? 2 : settings.imageCount;
  for (let i = 0; i < imageCount; i++) {
    await putInboxImage(store, groupKey, "shot-" + (i + 1) + ".png");
  }

  const provider = makeStubProvider();
  const handler = createHandler(store, provider);
  return { handler, store, provider, root, groupKey, tshirtPhotos };
}

/** Run the pipeline for one group and wait for the run to settle AND be dropped. */
async function runPipeline(handler, params) {
  const started = await call(handler, "POST", "/ecom/api/workflow/run", { id: WORKFLOW_ID, params: params });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  let settled = null;
  for (let i = 0; i < 400; i++) {
    const r = await call(handler, "GET", "/ecom/api/workflow/run?id=" + encodeURIComponent(started.json.runId));
    if (r.status === 200 && r.json.run && r.json.run.status !== "running") { settled = r.json.run; break; }
    await new Promise(function (resolve) { setTimeout(resolve, 10); });
  }
  if (settled === null) throw new Error("pipeline run did not settle");
  // A run reports its outcome as soon as it is known, but its record is kept
  // until that outcome is durable — so "finished" and "the next run may start"
  // are two different moments, and a test that conflates them races itself into
  // a 409.
  for (let i = 0; i < 400; i++) {
    if (handler.workflows.activeRun(WORKFLOW_ID) === null) return settled;
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
  }
  throw new Error("pipeline run never released the workflow");
}

test("the pipeline is registered as the workbench's first real workflow", () => {
  assert.equal(BUILT_IN_WORKFLOWS.length, 1);
  assert.equal(BUILT_IN_WORKFLOWS[0].id, WORKFLOW_ID);
  assert.equal(createRegistry().get(WORKFLOW_ID).name, "印花流水线");
});

test("one group costs exactly 225 calls: 1 extract + 8 recreate + 24 T恤 + 192 场景", async () => {
  const { handler, store, provider, groupKey } = await freshPipeline();

  const estimate = await call(handler, "GET", "/ecom/api/workflow/estimate?groupKey=" + encodeURIComponent(groupKey));
  assert.equal(estimate.status, 200);
  const plan = estimate.json.plan;
  // The arithmetic the whole feature is specified by.
  assert.deepEqual(plan.plan, { extract: 1, recreate: 8, tshirt: 24, scene: 192, total: 225 });
  assert.deepEqual(plan.pending, { extract: 1, recreate: 8, tshirt: 24, scene: 192, total: 225, printsAvailable: 0 });
  assert.equal(plan.prompts.recreate.length, 4, "four 印花二创-N prompts, in numeric order");
  assert.deepEqual(plan.prompts.recreate.map(function (p) { return p.name; }), ["印花二创-1", "印花二创-2", "印花二创-3", "印花二创-4"]);
  assert.equal(plan.tshirt.selected.length, 3, "all three photos of the T恤 are used by default");
  assert.equal(plan.cap.exceeded, false);
  assert.deepEqual(plan.warnings, []);

  const run = await runPipeline(handler, { groupKey: groupKey });
  assert.equal(run.status, "success", run.error || "");
  assert.deepEqual(provider.calls, { extract: 1, recreate: 8, applyToTshirt: 24, generate: 192 });
  assert.equal(provider.total(), 225);

  const state = await store.read();
  assert.equal(state.library.length, 1, "one extracted print");
  assert.equal(state.recreations.length, 4, "one row per 印花二创-N prompt");
  assert.equal(state.recreations.reduce(function (n, row) { return n + row.prints.length; }, 0), 8);
  assert.equal(state.tshirtRecreations.length, 24, "3 款式 × 8 prints");
  assert.equal((await store.readOutputs()).outputs.length, 192, "24 composites × 2 passes × 4 images");

  // Provenance: every artefact knows which group and run produced it, which is
  // what lets a later run resume instead of starting over.
  state.recreations.forEach(function (row) { assert.equal(row.groupKey, groupKey); assert.equal(row.workflowId, WORKFLOW_ID); });
  state.tshirtRecreations.forEach(function (row) { assert.equal(row.groupKey, groupKey); });
  const outputs = (await store.readOutputs()).outputs;
  outputs.forEach(function (row) { assert.equal(row.groupKey, groupKey); assert.equal(row.workflowId, WORKFLOW_ID); });
  assert.equal(new Set(outputs.map(function (row) { return row.sceneId; })).size > 1, true, "passes do not all share one scene");
});

test("re-running the same group resumes instead of paying twice", async () => {
  const { handler, provider, groupKey } = await freshPipeline();
  await runPipeline(handler, { groupKey: groupKey });
  assert.equal(provider.total(), 225);

  // A second run finds everything already there and makes no calls at all.
  const again = await runPipeline(handler, { groupKey: groupKey });
  assert.equal(again.status, "success");
  assert.equal(provider.total(), 225, "no additional provider calls");
  assert.match(again.summary, /已是最新/);
});

test("a run interrupted mid-way resumes from what already exists", async () => {
  const { handler, store, provider, groupKey } = await freshPipeline();
  await runPipeline(handler, { groupKey: groupKey });

  // Throw away part of the last stage, as an interrupted run would leave it.
  const kept = [];
  await store.updateOutputs(function (doc) {
    doc.outputs = doc.outputs.filter(function (row, index) {
      if (index % 4 === 0) { kept.push(row); return true; }
      return false;
    });
  });
  const before = provider.total();
  const run = await runPipeline(handler, { groupKey: groupKey });
  assert.equal(run.status, "success", run.error || "");

  const missing = 192 - kept.length;
  assert.equal(provider.calls.generate, 192 + missing, "only the missing composites were regenerated");
  assert.equal(provider.total(), before + missing);
  assert.equal((await store.readOutputs()).outputs.length, 192, "the library is complete again");
});

test("a forced re-run generates everything again without discarding the old rows", async () => {
  const { handler, store, provider, groupKey } = await freshPipeline();
  await runPipeline(handler, { groupKey: groupKey });
  const libraryBefore = (await store.read()).library.length;

  const forced = await runPipeline(handler, { groupKey: groupKey, force: true });
  assert.equal(forced.status, "success", forced.error || "");
  assert.equal(provider.total(), 450, "a forced run pays for a second full pass");
  assert.equal((await store.read()).library.length, libraryBefore + 1, "the earlier print is kept, not overwritten");
  assert.equal((await store.read()).recreations.length, 8, "4 rows from each pass");
});

test("the hard ceiling refuses a run before it spends anything", async () => {
  const { handler, provider, groupKey } = await freshPipeline();
  const previous = process.env.ECOM_WORKFLOW_MAX_CALLS;
  process.env.ECOM_WORKFLOW_MAX_CALLS = "100";
  try {
    const estimate = await call(handler, "GET", "/ecom/api/workflow/estimate?groupKey=" + encodeURIComponent(groupKey));
    assert.equal(estimate.json.plan.cap.exceeded, true, "the estimate says so before anything runs");

    const run = await runPipeline(handler, { groupKey: groupKey });
    assert.equal(run.status, "failed");
    assert.match(run.error, /超过单次上限/);
    assert.equal(provider.total(), 0, "not one call was made");

    // Raising the ceiling lets the very same group through.
    process.env.ECOM_WORKFLOW_MAX_CALLS = "225";
    const allowed = await runPipeline(handler, { groupKey: groupKey });
    assert.equal(allowed.status, "success", allowed.error || "");
    assert.equal(provider.total(), 225);
  } finally {
    if (previous === undefined) delete process.env.ECOM_WORKFLOW_MAX_CALLS;
    else process.env.ECOM_WORKFLOW_MAX_CALLS = previous;
  }
});

test("a missing or renamed prompt is reported, not silently skipped", async () => {
  const { handler, store, groupKey } = await freshPipeline({
    prompts: [{ id: "p0", name: "印花提取", text: "提取" }]
  });
  const estimate = await call(handler, "GET", "/ecom/api/workflow/estimate?groupKey=" + encodeURIComponent(groupKey));
  const plan = estimate.json.plan;
  assert.deepEqual(plan.plan, { extract: 1, recreate: 0, tshirt: 0, scene: 0, total: 1 });
  assert.equal(plan.warnings.length >= 3, true, "each missing prompt is named");
  assert.equal(plan.warnings.some(function (w) { return w.indexOf("印花二创-N") !== -1; }), true);
  assert.equal(plan.warnings.some(function (w) { return w.indexOf("印花T恤融合") !== -1; }), true);
  assert.equal(plan.warnings.some(function (w) { return w.indexOf("换装+裂变") !== -1; }), true);

  const run = await runPipeline(handler, { groupKey: groupKey });
  assert.equal(run.status, "success", run.error || "");
  assert.equal((await store.read()).library.length, 1, "step 1 still ran");
});

test("images loose in the inbox root become one warned-about group", async () => {
  const { handler, store } = await freshPipeline({ imageCount: 0, groupKey: LOOSE_GROUP });
  await putInboxImage(store, LOOSE_GROUP, "a.png");
  await putInboxImage(store, LOOSE_GROUP, "b.png");

  const groups = await call(handler, "GET", "/ecom/api/workflow/groups");
  assert.equal(groups.status, 200);
  assert.equal(groups.json.groups.length, 1);
  assert.equal(groups.json.groups[0].key, LOOSE_GROUP);
  assert.equal(groups.json.groups[0].name, "未分组");
  assert.equal(groups.json.groups[0].imageCount, 2);

  const estimate = await call(handler, "GET", "/ecom/api/workflow/estimate?groupKey=" + LOOSE_GROUP);
  assert.equal(estimate.json.plan.warnings.some(function (w) { return w.indexOf("散落在收图目录根下") !== -1; }), true);
});

test("uploads land in the same inbox the folder path uses, without clobbering", async () => {
  const { handler, store } = await freshPipeline({ imageCount: 0 });
  const upload = await call(handler, "POST", "/ecom/api/workflow/group/upload", {
    name: "商品B",
    images: [{ name: "正面.png", dataUrl: PNG_DATA_URL }, { name: "正面.png", dataUrl: PNG_DATA_URL }]
  });
  assert.equal(upload.status, 200, JSON.stringify(upload.json));
  assert.deepEqual(upload.json.saved, ["正面.png", "正面-2.png"]);
  assert.equal(upload.json.group.imageCount, 2);

  // The bytes really are on disk, where a hand-dropped folder would be.
  const onDisk = await readdir(join(inboxRoot(store), "商品B"));
  assert.deepEqual(onDisk.sort(), ["正面-2.png", "正面.png"]);

  const traversal = await call(handler, "POST", "/ecom/api/workflow/group/upload", {
    name: "../escape", images: [{ name: "x.png", dataUrl: PNG_DATA_URL }]
  });
  assert.equal(traversal.status, 400);
  assert.match(traversal.json.error, /路径分隔符|\.\./);
});

test("approval queues a group for the scheduler, and a manual run needs none", async () => {
  const { handler, store, groupKey } = await freshPipeline();

  let groups = await call(handler, "GET", "/ecom/api/workflow/groups");
  assert.equal(groups.json.groups[0].approvedAt, null, "not queued by default");

  // A scheduled run has nobody to confirm the cost, so it must not pick up an
  // unapproved group at all.
  const idle = await runPipeline(handler, undefined);
  assert.equal(idle.status, "success");
  assert.match(idle.summary, /没有已确认/);
  // The message must say what to do, not just that nothing happened: a run with
  // no target otherwise reads exactly like a broken button. And it must name the
  // controls by their *current* labels — this message pointed at a tab and a
  // button that had since been renamed, which is a dead end for the user.
  assert.match(idle.summary, /估算并运行/);
  assert.match(idle.summary, /分组与队列/);
  assert.match(idle.summary, /排队/);
  assert.equal(/确认排队|分组与成品/.test(idle.summary), false, "the hint must not name controls that no longer exist");

  const approved = await call(handler, "POST", "/ecom/api/workflow/group/approve", {
    groupKey: groupKey, approved: true, tshirtImages: []
  });
  assert.equal(approved.status, 200);
  assert.equal(typeof approved.json.group.approvedAt, "number");

  // Now a run with no params picks it up by itself.
  const scheduled = await runPipeline(handler, undefined);
  assert.equal(scheduled.status, "success", scheduled.error || "");
  assert.equal(scheduled.trigger, "manual");
  assert.equal((await store.read()).library.length, 1, "the approved group was processed");
});

test("a done group is not picked up again, but re-approving re-queues it", async () => {
  const { handler, groupKey } = await freshPipeline();
  await call(handler, "POST", "/ecom/api/workflow/group/approve", { groupKey: groupKey, approved: true });
  await runPipeline(handler, undefined);

  const idle = await runPipeline(handler, undefined);
  assert.match(idle.summary, /没有已确认/, "a finished group leaves the queue");

  await call(handler, "POST", "/ecom/api/workflow/group/approve", { groupKey: groupKey, approved: true });
  const picked = await runPipeline(handler, undefined);
  assert.equal(picked.status, "success");
  assert.match(picked.summary, /已是最新/, "it is re-picked, finds nothing missing, and costs nothing");
});

test("products can be listed and deleted one at a time, bytes included", async () => {
  const { handler, store, groupKey } = await freshPipeline();
  await runPipeline(handler, { groupKey: groupKey });

  const listed = await call(handler, "GET", "/ecom/api/workflow/outputs?groupKey=" + encodeURIComponent(groupKey) + "&limit=5");
  assert.equal(listed.json.total, 192);
  assert.equal(listed.json.outputs.length, 5, "the limit is honoured");
  const first = listed.json.outputs[0];

  // A shot names the 款式 it belongs to, not just the group it came from: the
  // 成品库 renders a listing-shaped card (title / spec / tags / the T恤), and the
  // last two of those only exist if the record carries them. The composite file
  // is the 款式's identity; these fields are what it *is*.
  const tshirtRow = (await store.read()).tshirtRecreations.filter(function (row) {
    return (row.prints || []).some(function (print) { return print.file === first.tshirtFile; });
  })[0];
  assert.ok(tshirtRow, "the shot's composite must come from a 二创T恤 row");
  assert.equal(first.tshirtName, tshirtRow.tshirtName, "the shot names its T恤");
  assert.equal(first.tshirtPhoto, tshirtRow.tshirtFile, "and the T恤 photo that 款式 was made from");
  assert.equal(first.printFile, tshirtRow.printFile, "and the 二创印花 it wears");
  assert.equal(first.sceneIndex !== undefined, true, "and which scene it was shot in");

  const removed = await call(handler, "POST", "/ecom/api/workflow/output/delete", { id: first.id });
  assert.equal(removed.json.removed, true);
  assert.equal((await store.readOutputs()).outputs.length, 191);
  await assert.rejects(function () { return store.getFile(first.file); }, "the bytes went with the record");

  const missingAgain = await call(handler, "POST", "/ecom/api/workflow/output/delete", { id: first.id });
  assert.equal(missingAgain.json.removed, false, "deleting twice is a no-op, not an error");
});

test("deleting a group clears its queue entry but keeps what it produced", async () => {
  const { handler, store, groupKey } = await freshPipeline();
  await runPipeline(handler, { groupKey: groupKey });

  const removed = await call(handler, "POST", "/ecom/api/workflow/group/delete", { groupKey: groupKey });
  assert.equal(removed.status, 200);
  const groups = await call(handler, "GET", "/ecom/api/workflow/groups");
  assert.deepEqual(groups.json.groups, [], "the folder is gone from the inbox");
  assert.equal((await store.read()).workflowGroups.length, 0, "and so is its queue entry");
  assert.equal((await store.readOutputs()).outputs.length, 192, "the products it paid for are kept");
});

test("a group whose T恤 selection is stale still runs against the photos that exist", async () => {
  const { handler, store, groupKey } = await freshPipeline();
  await call(handler, "POST", "/ecom/api/workflow/group/approve", {
    groupKey: groupKey, approved: true, tshirtImages: ["no-such-file.png"]
  });
  const estimate = await call(handler, "GET", "/ecom/api/workflow/estimate?groupKey=" + encodeURIComponent(groupKey));
  // A stale selection must not point the pipeline at a file that is gone: it
  // falls back to every photo and says so, rather than failing 24 calls in.
  assert.equal(estimate.json.plan.tshirt.selected.length, 3);
  assert.equal(estimate.json.plan.warnings.some(function (w) { return w.indexOf("已经不在这件T恤里") !== -1; }), true);

  const run = await runPipeline(handler, { groupKey: groupKey });
  assert.equal(run.status, "success", run.error || "");
  assert.equal((await store.read()).tshirtRecreations.length, 24);
});

test("picking one 款式 runs only that colour, and hands its 细节图 to the 融合 step", async () => {
  // The point of grouping a T恤 by 款式: choosing 白色 must mean 白色's 白底图 —
  // front and back are two products — carrying 白色's 细节图, and must not drag
  // 黑色 along. Both halves are asserted here because either one alone is the
  // silent failure: a run that quietly used every colour, or one that used the
  // right colour but sent the wrong references.
  const { handler, store, provider, groupKey } = await freshPipeline({
    tshirtRecord: {
      id: "t1", name: "测试T恤", createdAt: 1,
      colorways: [
        { id: "cw-white", name: "白色", white: [], detail: [] },
        { id: "cw-black", name: "黑色", white: [], detail: [] }
      ],
      sizeImages: []
    }
  });

  // The 白底图 and 细节图 have to be real stored bytes for the pipeline to read
  // them, so the fixture's photos are dealt out to the two colours afterwards.
  const photos = [];
  for (let i = 0; i < 3; i++) photos.push(await store.putFile(PNG_BYTES, "image/png"));
  const detail = await store.putFile(PNG_BYTES, "image/png");
  const size = await store.putFile(PNG_BYTES, "image/png");
  await store.update(function (state) {
    state.tshirts = [{
      id: "t1", name: "测试T恤", createdAt: 1,
      colorways: [
        // 白色 is shot front and back, and has a collar close-up; 黑色 has one shot.
        { id: "cw-white", name: "白色", white: [photos[0], photos[1]], detail: [detail] },
        { id: "cw-black", name: "黑色", white: [photos[2]], detail: [] }
      ],
      sizeImages: [size]
    }];
  });

  await call(handler, "POST", "/ecom/api/workflow/group/approve", {
    groupKey: groupKey, approved: true, tshirtId: "t1", tshirtColorways: ["cw-white"]
  });
  const estimate = await call(handler, "GET", "/ecom/api/workflow/estimate?groupKey=" + encodeURIComponent(groupKey));
  assert.equal(estimate.json.plan.tshirt.selected.length, 2,
    "one 款式 picked = its two 白底图, not one photo and not all three");
  assert.deepEqual(estimate.json.plan.tshirt.colorways.map(function (c) { return c.name; }), ["白色"]);
  assert.deepEqual(estimate.json.plan.tshirt.sizeImages, [size],
    "the 尺码图 travel with the product, not with the colour");

  const run = await runPipeline(handler, { groupKey: groupKey });
  assert.equal(run.status, "success", run.error || "");
  // 8 二创印花 × 1 款式 = 8 融合 calls. The step fans out over the 款式, not over its
  // photos: the model is handed the whole colour and picks which shot to draw on,
  // because nothing in the data says which of a 款式's 白底图 is the front.
  assert.equal(provider.calls.applyToTshirt, 8);
  assert.equal(provider.tshirtInputs.every(function (input) {
    // 白色's two 白底图 and its 细节图, in that order — and no 尺码图, which is a
    // diagram rather than evidence about the fabric.
    return Array.isArray(input.refs) && input.refs.length === 3;
  }), true, "every 融合 call must carry the whole 款式: 白底图 then 细节图");
  // And the colour is recorded on the product, so the shelf can group a colour's
  // shots without re-deriving it from a T恤 record that may have changed since.
  const rows = (await store.read()).tshirtRecreations;
  assert.equal(rows.every(function (r) { return r.colorwayName === "白色"; }), true);
});

// ---------------------------------------------------------------------------
// 工作流参数 — the two knobs that decide the shape (and the cost) of step 4.
// ---------------------------------------------------------------------------

test("settings drive step 4: how many scenes, and how many shots per scene", async () => {
  const { handler, provider, groupKey } = await freshPipeline();

  const saved = await call(handler, "POST", "/ecom/api/workflow/config", {
    id: WORKFLOW_ID, settings: { sceneCount: 3, sceneOutputs: 2 }
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.workflow.settings, { sceneCount: 3, sceneOutputs: 2 });
  assert.deepEqual(saved.json.workflow.settingFields.map(function (f) { return f.key; }),
    ["sceneCount", "sceneOutputs"], "the declaration travels with the values");

  const estimate = await call(handler, "GET", "/ecom/api/workflow/estimate?groupKey=" + encodeURIComponent(groupKey));
  const plan = estimate.json.plan;
  // 24 二创T恤 × 3 场景 × 2 张 = 144, so the whole group is 1 + 8 + 24 + 144.
  assert.equal(plan.plan.scene, 144);
  assert.equal(plan.plan.total, 177);
  assert.equal(plan.settings.sceneCount, 3);
  assert.equal(plan.settings.sceneOutputs, 2);

  const run = await runPipeline(handler, { groupKey: groupKey });
  assert.equal(run.status, "success", run.error || "");
  assert.equal(provider.calls.generate, 144, "the run spends what the settings say");
  assert.equal(provider.total(), 177);
});

test("an out-of-range setting is clamped, and a small scene pool caps the count", async () => {
  // The fixture's scene pool holds four.
  const { handler, groupKey } = await freshPipeline({ scenes: 4 });

  const saved = await call(handler, "POST", "/ecom/api/workflow/config", {
    id: WORKFLOW_ID, settings: { sceneCount: 999, sceneOutputs: 0 }
  });
  assert.deepEqual(saved.json.workflow.settings, { sceneCount: 24, sceneOutputs: 1 },
    "values are clamped to the declared range rather than saved as typed");

  const plan = (await call(handler, "GET", "/ecom/api/workflow/estimate?groupKey=" + encodeURIComponent(groupKey))).json.plan;
  assert.equal(plan.settings.sceneCountRequested, 24);
  assert.equal(plan.settings.sceneCount, 4, "you cannot shoot a T恤 in more scenes than the pool holds");
  assert.equal(plan.plan.scene, 24 * 4 * 1);
  assert.equal(plan.warnings.some(function (w) { return w.indexOf("池子里只有") !== -1; }), true,
    "and it says so rather than repeating a scene in silence");
});

test("settings persist, survive a restart, and reach the client through /state", async () => {
  const { handler, root, now } = await freshPipeline();
  await call(handler, "POST", "/ecom/api/workflow/config", { id: WORKFLOW_ID, settings: { sceneCount: 6 } });

  const view = (await call(handler, "GET", "/ecom/api/state")).json.workflows[0];
  assert.equal(view.settings.sceneCount, 6);
  assert.equal(view.settings.sceneOutputs, 4, "a partial save leaves the other field alone");

  // Reopening the store is what a host restart looks like to the config.
  const reopened = createHandler(createStore(root), makeStubProvider(), { now: now });
  const again = (await call(reopened, "GET", "/ecom/api/state")).json.workflows[0];
  assert.equal(again.settings.sceneCount, 6);
  assert.deepEqual(again.settingFields.map(function (f) { return f.key; }), ["sceneCount", "sceneOutputs"]);
});

test("one run deals its scenes from one deck, so the pool is spread rather than reused", async () => {
  // The bug this guards, and why it takes a run rather than a unit: the pool used to
  // be copied **per 款式**, so "without replacement" held only inside one 款式 and
  // two 款式 could draw the same background. Over a run that produced a handful of
  // scenes reused over and over while most of the pool went untouched — measured on
  // this machine, one scene 14 times, another 13, and only 2 of 228 used exactly
  // once. From the outside that reads as 随机选场景图并不是很随机.
  //
  // Sized so the two behaviours cannot be confused, and so the whole run stays under
  // the 400-call ceiling: 5 款式 × 8 印花 = 40 融合, × 4 scenes × 2 shots = 320 成片,
  // total 369. The 20 scene draws come from a pool of exactly 20 — dealing from one
  // deck uses every scene exactly once, while five independent draws of 4 from 20
  // cover about 14.
  const { handler, store, groupKey, tshirtPhotos } = await freshPipeline({ scenes: 20, tshirtPhotos: 5 });
  await store.update(function (state) {
    state.tshirts = [{
      id: "t1", name: "测试T恤", createdAt: 1, sizeImages: [],
      colorways: tshirtPhotos.map(function (file, index) {
        return { id: "cw" + index, name: "款式 " + (index + 1), white: [file], detail: [], model: [] };
      })
    }];
  });

  const run = await runPipeline(handler, { groupKey: groupKey });
  assert.equal(run.status, "success", run.error || "");

  const forGroup = async function () {
    return (await store.readOutputs()).outputs.filter(function (o) { return o.groupKey === groupKey; });
  };
  const outputs = await forGroup();
  assert.equal(outputs.length, 320, "5 款式 × 8 印花 × 4 scenes × 2 shots");

  // **Evenness**, not coverage, is the property that discriminates. 40 composites
  // each deal `sceneCount` scenes from one shared deck, and the deck holds exactly the
  // 20-scene pool, so the deals divide evenly and every scene ends up with the same
  // number of shots — 320 / 20 = 16. The old per-款式 copy of the pool gives some
  // scenes a dozen and others two. Coverage alone would not have caught it: 160 draws
  // cover 20 scenes even when every draw is independent, which is why the first
  // version of this test passed against a deliberately broken selector.
  const loads = new Map();
  outputs.forEach(function (o) { loads.set(o.sceneId, (loads.get(o.sceneId) || 0) + 1); });
  const counts = Array.from(loads.values());
  assert.equal(loads.size, 20, "every scene in the pool must be used");
  assert.equal(Math.max.apply(null, counts), 16,
    "one deck over a 20-scene pool is 320/20 = 16 shots each; a heavier maximum means the pool was copied per 款式");
  assert.equal(Math.min.apply(null, counts), 16, "and no scene may be left behind");

  // And a second run has nothing left to make — which scenes were used is recorded in
  // the products themselves, so a resumed run continues rather than re-deals.
  const again = await runPipeline(handler, { groupKey: groupKey });
  assert.equal(again.status, "success", again.error || "");
  assert.equal((await forGroup()).length, 320);
});
