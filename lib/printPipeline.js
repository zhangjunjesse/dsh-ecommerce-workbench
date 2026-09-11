/**
 * 印花流水线 — the pipeline workflow.
 *
 * One *group* of reference images (several screenshots of the same product,
 * from different angles) goes through four steps and comes out as usable
 * products:
 *
 *   1. 提取印花   the whole group is passed to the extractor together → one print
 *   2. 印花二创   every 「印花二创-N」 prompt in 提示词管理 runs once → 2 prints
 *                 each (4 prompts → 8 re-created prints)
 *   3. T恤融合    every re-created print × every selected T恤 photo (款式), using
 *                 「印花T恤融合」 → one composite each
 *   4. 换装裂变   every composite runs 2 passes of 4 images, using 「换装+裂变」
 *                 with [a random 场景图, that composite] as the two references
 *
 * Three properties shape the design:
 *
 * - **One group per run.** A group costs ~225 provider calls and close to two
 *   hours. Processing every pending group in one run would multiply the cost of
 *   a single mistake (or a single upstream hiccup) by the size of the queue, so
 *   the scheduler's job is to chew through the queue one group at a time.
 *
 * - **Re-running resumes instead of restarting.** Interrupting an hour-long run
 *   and starting over would pay for the same images twice. Every artefact is
 *   stamped with `workflowId` + `groupKey` (+ the keys it was derived from), so
 *   a later run can see what already exists and produce only what is missing.
 *   That index is derived from the data itself — there is no separate progress
 *   ledger to fall out of step with the files.
 *
 * - **The cost is visible before it is spent.** `estimateGroup` returns the exact
 *   call counts and every reason the pipeline cannot run as configured; a run
 *   re-checks the same plan against a hard ceiling before its first call, so a
 *   scheduled run cannot quietly spend more than a manual one was allowed to.
 */
const { readdir, readFile } = require("node:fs/promises");
const { join, extname } = require("node:path");

const WORKFLOW_ID = "print.pipeline";
const WORKFLOW_NAME = "印花流水线";
const WORKFLOW_DESCRIPTION = "一组参考图 → 提取印花 → 印花二创 → T恤融合 → 换装裂变；一次只处理一组，重跑自动接着上次继续。";

/** Images dropped straight into the inbox root are gathered under this key. */
const LOOSE_GROUP = "__loose__";
const LOOSE_GROUP_NAME = "未分组";
const INBOX_FOLDER = "workflow-inbox";

const IMAGE_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

/** Prompts are matched by exact name; these are the four the pipeline looks for. */
const EXTRACT_PROMPT_NAME = "印花提取";
const RECREATE_PROMPT_PATTERN = /^印花二创-(\d+)$/;
const TSHIRT_PROMPT_NAME = "印花T恤融合";
const SCENE_PROMPT_NAME = "换装+裂变";
/** Used only when 提示词管理 has no 「印花提取」; the other three are required for their step. */
const FALLBACK_EXTRACT_PROMPT = "提取T恤上的印花；";

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/** Outputs per 印花二创 prompt (the user's "每次输出2个印花"). */
const RECREATE_OUTPUTS = positiveInt(process.env.ECOM_PIPELINE_RECREATE_OUTPUTS, 2);
/** How many times each composite is sent through 换装+裂变. */
const SCENE_PASSES = positiveInt(process.env.ECOM_PIPELINE_SCENE_PASSES, 2);
/** Images per 换装+裂变 generation. */
const SCENE_OUTPUTS = positiveInt(process.env.ECOM_PIPELINE_SCENE_OUTPUTS, 4);
/** Provider calls one run may make before it refuses to start. */
function maxCallsPerRun() {
  return positiveInt(process.env.ECOM_WORKFLOW_MAX_CALLS, 400);
}
/** How many provider calls this workflow keeps in flight; the host's global cap still applies. */
function localConcurrency() {
  return positiveInt(process.env.ECOM_PIPELINE_CONCURRENCY, 2);
}

/** Short id for records; mirrors the host's own helper. */
function recordId() {
  return Math.random().toString(36).slice(2, 10);
}

function text(error) {
  return String((error && error.message) || error);
}

function badRequest(message, code) {
  return Object.assign(new Error(message), { code: code || "BAD_REQUEST" });
}

function isImage(name) {
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME_BY_EXT, extname(name).toLowerCase());
}

function mimeOf(name) {
  return IMAGE_MIME_BY_EXT[extname(name).toLowerCase()] || "application/octet-stream";
}

/** Deterministic, human-friendly order (so 印花二创-2 comes before 印花二创-10). */
function byNaturalName(a, b) {
  return String(a).localeCompare(String(b), "zh", { numeric: true, sensitivity: "base" });
}

/**
 * Bound how many items one stage keeps in flight.
 *
 * Each provider call this workflow makes already takes the host's shared
 * generation slot (the provider it is handed is wrapped), so this limit only
 * decides how much work is queued here; it can never exceed the global cap, and
 * nothing nests a slot inside another.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = [];
  const width = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < width; i++) {
    runners.push((async function pump() {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        try {
          results[index] = { ok: true, value: await worker(items[index], index) };
        } catch (error) {
          results[index] = { ok: false, error: text(error) };
        }
      }
    })());
  }
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Inbox: where the reference images live
// ---------------------------------------------------------------------------

/** The inbox root for this workflow; one immediate subfolder per group. */
function inboxRoot(store) {
  return join(store.dir, INBOX_FOLDER, WORKFLOW_ID);
}

/** Reject a group name that could escape the inbox directory. */
function normalizeGroupKey(value) {
  if (typeof value !== "string" || value.trim() === "") throw badRequest("分组名不能为空", "BAD_GROUP");
  const key = value.trim();
  if (key === LOOSE_GROUP) return key;
  if (key.includes("/") || key.includes("\\") || key.includes("..") || key.startsWith(".")) {
    throw badRequest("分组名不能包含路径分隔符、.. 或以 . 开头", "BAD_GROUP");
  }
  return key;
}

/** Absolute directory holding one group's images (the loose bucket is the root itself). */
function groupDirectory(store, groupKey) {
  return groupKey === LOOSE_GROUP ? inboxRoot(store) : join(inboxRoot(store), groupKey);
}

async function listImagesIn(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter(function (entry) { return entry.isFile() && isImage(entry.name); })
    .map(function (entry) { return entry.name; })
    .sort(byNaturalName);
}

/**
 * Every group currently in the inbox, in a stable order.
 *
 * A subfolder is one group. Images lying loose in the root are gathered into a
 * single 「未分组」 group rather than each becoming its own group: a group of one
 * is legal (a single screenshot), so the alternative would silently turn three
 * angles of one product into three separate runs — three times the cost and
 * three unusable extractions. The caller is warned about the bucket instead, and
 * the fix (move them into a subfolder) stays in the user's hands.
 *
 * @returns {Promise<Array<{key: string, name: string, source: string, files: string[]}>>}
 */
async function scanGroups(store) {
  const root = inboxRoot(store);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const groups = [];
  const loose = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const files = await listImagesIn(join(root, entry.name));
      if (files.length > 0) groups.push({ key: entry.name, name: entry.name, source: "inbox", files: files });
    } else if (entry.isFile() && isImage(entry.name)) {
      loose.push(entry.name);
    }
  }
  if (loose.length > 0) {
    groups.push({ key: LOOSE_GROUP, name: LOOSE_GROUP_NAME, source: "loose", files: loose.sort(byNaturalName) });
  }
  groups.sort(function (a, b) { return byNaturalName(a.name, b.name); });
  return groups;
}

async function findGroup(store, groupKey) {
  const key = normalizeGroupKey(groupKey);
  const groups = await scanGroups(store);
  const group = groups.filter(function (g) { return g.key === key; })[0];
  if (!group) throw badRequest("收图目录里没有这个分组：" + key, "NO_GROUP");
  return group;
}

/** Read one image out of the inbox, as the provider wants it. */
async function readGroupImage(store, group, fileName) {
  const buffer = await readFile(join(groupDirectory(store, group.key), fileName));
  return { buffer: buffer, mimeType: mimeOf(fileName), name: fileName };
}

// ---------------------------------------------------------------------------
// Configuration: prompts, the T恤, the scene pool
// ---------------------------------------------------------------------------

function findPrompt(prompts, name) {
  return prompts.filter(function (prompt) {
    return typeof prompt.name === "string" && prompt.name.trim() === name;
  })[0] || null;
}

/** Every 「印花二创-N」 prompt, ordered by N. */
function recreatePrompts(prompts) {
  return prompts
    .filter(function (prompt) {
      return typeof prompt.name === "string" && RECREATE_PROMPT_PATTERN.test(prompt.name.trim());
    })
    .map(function (prompt) { return { name: prompt.name.trim(), text: prompt.text || "" }; })
    .sort(function (a, b) {
      const na = Number(RECREATE_PROMPT_PATTERN.exec(a.name)[1]);
      const nb = Number(RECREATE_PROMPT_PATTERN.exec(b.name)[1]);
      return na - nb;
    });
}

function groupConfig(state, groupKey) {
  return (state.workflowGroups || []).filter(function (record) {
    return record.key === groupKey && record.workflowId === WORKFLOW_ID;
  })[0] || {};
}

/**
 * Which T恤 photos this group generates against.
 *
 * Defaults to every photo of the first T恤 — "全部款式" — and a stored selection
 * narrows it. The selection is filtered against the T恤's real photos rather
 * than trusted, so a stale choice can never point the pipeline at a file that is
 * gone; if nothing survives the filter, it falls back to the default below.
 */
function resolveTshirt(state, config) {
  const tshirts = state.tshirts || [];
  const chosen = config.tshirtId
    ? tshirts.filter(function (t) { return t.id === config.tshirtId; })[0]
    : tshirts[0];
  if (!chosen) return null;
  const all = Array.isArray(chosen.images) ? chosen.images : [];
  const wantsSpecific = Array.isArray(config.tshirtImages) && config.tshirtImages.length > 0;
  const chosenOnly = wantsSpecific
    ? all.filter(function (file) { return config.tshirtImages.indexOf(file) !== -1; })
    : all;
  // A selection that matches nothing — the photo was deleted, or the user
  // switched to a different T恤 — falls back to the documented default (every
  // photo) and says so. Degrading to "generate nothing" would look like a broken
  // workflow; degrading to the default is what the user would have got had they
  // never picked at all.
  const stale = wantsSpecific && chosenOnly.length === 0;
  return {
    id: chosen.id,
    name: chosen.name || "T恤",
    photos: all,
    selected: stale ? all : chosenOnly,
    selectionStale: stale
  };
}

// ---------------------------------------------------------------------------
// Planning: what this group would cost, and what is left to do
// ---------------------------------------------------------------------------

function sceneKey(tshirtFile, pass, variant) {
  return tshirtFile + "|" + pass + "|" + variant;
}

function tshirtKey(tshirtFile, printFile) {
  return tshirtFile + "|" + printFile;
}

/**
 * What already exists for this group, derived from the artefacts themselves.
 *
 * This is the whole of "resume": no progress file, no stage cursor. An artefact
 * records the group it belongs to and what it was derived from, so a re-run can
 * tell exactly which items are still missing.
 */
async function existingIndex(store, groupKey) {
  const state = await store.read();
  const outputs = (await store.readOutputs()).outputs;

  const library = (state.library || []).filter(function (row) { return row.groupKey === groupKey; });
  const recreations = (state.recreations || []).filter(function (row) { return row.groupKey === groupKey; });
  const tshirts = (state.tshirtRecreations || []).filter(function (row) { return row.groupKey === groupKey; });
  const products = outputs.filter(function (row) { return row.groupKey === groupKey; });

  const recreateByPrompt = new Map();
  const recreateRowByPrompt = new Map();
  const recreatedPrints = [];
  for (const row of recreations) {
    const prints = Array.isArray(row.prints) ? row.prints : [];
    if (row.promptName) {
      recreateByPrompt.set(row.promptName, prints);
      recreateRowByPrompt.set(row.promptName, row);
    }
    for (const print of prints) recreatedPrints.push(print);
  }

  return {
    extract: library[0] || null,
    recreateByPrompt: recreateByPrompt,
    recreateRowByPrompt: recreateRowByPrompt,
    recreatedPrints: recreatedPrints,
    tshirtKeys: new Set(tshirts.map(function (row) { return tshirtKey(row.tshirtFile, row.printFile); })),
    tshirtRows: tshirts,
    sceneKeys: new Set(products.map(function (row) { return sceneKey(row.tshirtFile, row.pass, row.variant); })),
    products: products
  };
}

/**
 * Everything the pipeline needs to know about one group, without generating
 * anything: the prompt set, the T恤, the scene pool, what it would cost, what is
 * already done, and every reason it cannot run as configured.
 *
 * @returns {Promise<object>} the plan (see the shape assembled at the end).
 */
async function planGroup(store, groupKey) {
  const group = await findGroup(store, groupKey);
  const state = await store.read();
  const prompts = state.prompts || [];
  const extractPrompt = findPrompt(prompts, EXTRACT_PROMPT_NAME);
  const tshirtPrompt = findPrompt(prompts, TSHIRT_PROMPT_NAME);
  const scenePrompt = findPrompt(prompts, SCENE_PROMPT_NAME);
  const recreates = recreatePrompts(prompts);
  const config = groupConfig(state, group.key);
  const tshirt = resolveTshirt(state, config);
  const scenes = state.scenes || [];
  const existing = await existingIndex(store, group.key);

  const warnings = [];
  if (!extractPrompt) warnings.push("提示词管理里没有「" + EXTRACT_PROMPT_NAME + "」，将使用内置兜底提示词。");
  if (recreates.length === 0) warnings.push("提示词管理里没有「印花二创-N」，第二步不会产出任何印花。");
  if (!tshirtPrompt) warnings.push("提示词管理里没有「" + TSHIRT_PROMPT_NAME + "」，第三步无法执行。");
  if (!scenePrompt) warnings.push("提示词管理里没有「" + SCENE_PROMPT_NAME + "」，第四步无法执行。");
  if (!tshirt) warnings.push("没有可用的T恤，第三步无法执行。");
  else if (tshirt.selected.length === 0) warnings.push("所选T恤没有可用的照片，第三步无法执行。");
  else if (tshirt.selectionStale) {
    warnings.push("该分组之前选的款式已经不在这件T恤里了，本次按全部 " + tshirt.selected.length + " 个款式处理。");
  }
  if (scenes.length === 0) warnings.push("场景图管理里没有场景图，第四步无法执行。");
  if (group.source === "loose") {
    warnings.push("这些图散落在收图目录根下，被合并成一组「" + LOOSE_GROUP_NAME + "」。如果它们其实属于不同商品，请分别放进子目录再跑——否则提取出的印花是混合的。");
  }

  const canRecreate = recreates.length > 0;
  const canTshirt = canRecreate && tshirt !== null && tshirt.selected.length > 0 && tshirtPrompt !== null;
  const canScene = canTshirt && scenePrompt !== null && scenes.length > 0;

  const recreateCount = canRecreate ? recreates.length * RECREATE_OUTPUTS : 0;
  const tshirtCount = canTshirt ? recreateCount * tshirt.selected.length : 0;
  const sceneCount = canScene ? tshirtCount * SCENE_PASSES * SCENE_OUTPUTS : 0;

  // What is still missing, given what this group already produced.
  const missingRecreate = recreates.filter(function (prompt) {
    return (existing.recreateByPrompt.get(prompt.name) || []).length < RECREATE_OUTPUTS;
  }).length * RECREATE_OUTPUTS;
  const printsAvailable = existing.recreatedPrints.length;
  const missingTshirt = canTshirt
    ? Math.max(0, recreateCount * tshirt.selected.length - existing.tshirtKeys.size)
    : 0;
  const missingScene = canScene
    ? Math.max(0, tshirtCount * SCENE_PASSES * SCENE_OUTPUTS - existing.sceneKeys.size)
    : 0;
  const missingExtract = existing.extract ? 0 : 1;

  const total = (existing.extract ? 0 : 1) + recreateCount + tshirtCount + sceneCount;
  const pending = missingExtract + missingRecreate + missingTshirt + missingScene;
  const cap = maxCallsPerRun();

  return {
    workflowId: WORKFLOW_ID,
    group: { key: group.key, name: group.name, source: group.source, imageCount: group.files.length, images: group.files },
    prompts: {
      extract: { name: EXTRACT_PROMPT_NAME, found: extractPrompt !== null, text: extractPrompt ? extractPrompt.text : FALLBACK_EXTRACT_PROMPT },
      recreate: recreates.map(function (prompt) {
        return { name: prompt.name, text: prompt.text, outputs: RECREATE_OUTPUTS };
      }),
      tshirt: { name: TSHIRT_PROMPT_NAME, found: tshirtPrompt !== null, text: tshirtPrompt ? tshirtPrompt.text : "" },
      scene: { name: SCENE_PROMPT_NAME, found: scenePrompt !== null, text: scenePrompt ? scenePrompt.text : "" }
    },
    tshirt: tshirt === null ? null : {
      id: tshirt.id,
      name: tshirt.name,
      photos: tshirt.photos,
      selected: tshirt.selected
    },
    scenes: { available: scenes.length },
    plan: { extract: 1, recreate: recreateCount, tshirt: tshirtCount, scene: sceneCount, total: total },
    pending: { extract: missingExtract, recreate: missingRecreate, tshirt: missingTshirt, scene: missingScene, total: pending, printsAvailable: printsAvailable },
    warnings: warnings,
    cap: { max: cap, exceeded: pending > cap },
    settings: { recreateOutputs: RECREATE_OUTPUTS, scenePasses: SCENE_PASSES, sceneOutputs: SCENE_OUTPUTS, concurrency: localConcurrency() },
    existing: existing
  };
}

/** A short sentence summarising a plan, used in logs and as the run's summary. */
function describePlan(plan) {
  return "提取 " + plan.plan.extract + " · 二创 " + plan.plan.recreate + " · T恤 " + plan.plan.tshirt + " · 成片 " + plan.plan.scene + " = " + plan.plan.total + " 次调用";
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

async function touchGroup(store, groupKey, patch) {
  await store.update(function (state) {
    const existing = (state.workflowGroups || []).filter(function (record) {
      return record.key === groupKey && record.workflowId === WORKFLOW_ID;
    })[0];
    const next = Object.assign({ key: groupKey, workflowId: WORKFLOW_ID }, existing || {}, patch);
    state.workflowGroups = existing
      ? state.workflowGroups.map(function (record) {
          return record.key === groupKey && record.workflowId === WORKFLOW_ID ? next : record;
        })
      : state.workflowGroups.concat([next]);
  });
}

/**
 * The group a scheduled run should pick up: the first approved group that has
 * not finished. Approval is explicit (`approveGroup`) because a scheduled run
 * cannot show anyone an estimate before spending money on it.
 */
async function nextApprovedGroup(store) {
  const state = await store.read();
  const groups = await scanGroups(store);
  for (const group of groups) {
    const config = groupConfig(state, group.key);
    if (typeof config.approvedAt !== "number") continue;
    if (config.status === "done") continue;
    return group;
  }
  return null;
}

/** Random scene, avoiding `avoid` when the pool allows it. */
function pickScene(scenes, avoid) {
  if (scenes.length === 0) return null;
  const pool = scenes.length > 1 && avoid ? scenes.filter(function (scene) { return scene.id !== avoid; }) : scenes;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * The workflow definition. `run(ctx)` receives the durable store, the
 * concurrency-guarded provider, a per-run log sink, and `ctx.params`
 * (`{groupKey, force}`) — with no params it picks the next approved group.
 */
const printPipeline = {
  id: WORKFLOW_ID,
  name: WORKFLOW_NAME,
  description: WORKFLOW_DESCRIPTION,

  async run(ctx) {
    const store = ctx.store;
    const params = ctx.params || {};
    const force = params.force === true;

    let groupKey = typeof params.groupKey === "string" && params.groupKey !== "" ? params.groupKey : null;
    if (groupKey === null) {
      const next = await nextApprovedGroup(store);
      if (next === null) {
        // Say what to do about it. "Nothing to do" alone reads as a broken
        // button, which is exactly how a run with no target looks from outside.
        const message = "没有已确认、还没跑完的分组，本次没有处理任何东西：请到「分组与成品」里选一组点「估算并运行」，" +
          "或先点「确认排队」把它交给周期执行。";
        ctx.log(message, "warn");
        return message;
      }
      groupKey = next.key;
      ctx.log("周期运行：自动挑中分组「" + next.name + "」");
    }

    const plan = await planGroup(store, groupKey);
    ctx.log("分组「" + plan.group.name + "」共 " + plan.group.imageCount + " 张参考图");
    ctx.log("预计：" + describePlan(plan) + (force ? "（强制重跑，忽略已有产物）" : ""));

    // The hard ceiling is enforced against what is *actually* about to be sent,
    // stage by stage — not only against the up-front estimate. An estimate can be
    // optimistic (a prompt deleted, a stale key), and a cap that can be talked out
    // of by a rounding error is not a cap.
    const budget = { max: plan.cap.max, used: 0 };
    function spend(count, what) {
      if (budget.used + count > budget.max) {
        throw new Error(
          "本次需要 " + (budget.used + count) + " 次调用，超过单次上限 " + budget.max + "（ECOM_WORKFLOW_MAX_CALLS，" +
          what + "）。已停止，未再消耗额度；已生成的产物全部保留。"
        );
      }
      budget.used += count;
    }

    // A forced run ignores what already exists, so the ceiling must be checked
    // against the full plan rather than the remaining work — otherwise "force"
    // would be the one setting that can walk past the cap.
    const plannedCalls = force ? plan.plan.total : plan.pending.total;

    if (plannedCalls > plan.cap.max) {
      throw new Error(
        "本次需要 " + plannedCalls + " 次调用，超过单次上限 " + plan.cap.max +
        "（ECOM_WORKFLOW_MAX_CALLS）。已拒绝执行，未消耗任何额度。"
      );
    }
    if (plannedCalls === 0) {
      ctx.log("该分组的产物已经齐全，没有需要生成的项。");
      await touchGroup(store, plan.group.key, { status: "done", lastRunId: ctx.runId, updatedAt: ctx.now() });
      return "分组「" + plan.group.name + "」已是最新，无需生成";
    }

    await touchGroup(store, plan.group.key, {
      status: "running", lastRunId: ctx.runId, lastRunAt: ctx.now(), updatedAt: ctx.now()
    });

    const failures = [];
    const produced = { extract: 0, recreate: 0, tshirt: 0, scene: 0 };
    const reused = { extract: 0, recreate: 0, tshirt: 0, scene: 0 };

    // ---- 第一步：提取印花 -------------------------------------------------
    let sourcePrintFile;
    if (plan.existing.extract && !force) {
      sourcePrintFile = plan.existing.extract.file;
      reused.extract = 1;
      ctx.log("第一步：复用已提取的印花 " + sourcePrintFile);
    } else {
      ctx.log("第一步：用整组 " + plan.group.imageCount + " 张参考图提取印花");
      try {
        const images = [];
        for (const name of plan.group.images) images.push(await readGroupImage(store, { key: plan.group.key }, name));
        spend(1, "提取印花");
        const result = await ctx.provider.extract({
          images: images,
          prompt: plan.prompts.extract.text,
          removeBg: true
        });
        sourcePrintFile = await store.putFile(result.buffer, result.mimeType);
        const print = {
          id: recordId(),
          sourceName: plan.group.name,
          sourceFile: sourcePrintFile,
          sourceFiles: [],
          file: sourcePrintFile,
          prompt: plan.prompts.extract.text,
          createdAt: Date.now(),
          workflowId: WORKFLOW_ID,
          groupKey: plan.group.key,
          runId: ctx.runId
        };
        await store.update(function (state) { state.library = [print].concat(state.library); });
        produced.extract = 1;
        ctx.log("第一步完成 → " + sourcePrintFile);
      } catch (error) {
        failures.push("提取印花：" + text(error));
        ctx.log("第一步失败：" + text(error), "error");
      }
    }

    // ---- 第二步：印花二创 -------------------------------------------------
    const recreateRows = [];
    if (sourcePrintFile && plan.prompts.recreate.length > 0) {
      ctx.log("第二步：" + plan.prompts.recreate.length + " 个「印花二创-N」，每个 " + RECREATE_OUTPUTS + " 张");
      const sourceBytes = await store.getFile(sourcePrintFile).catch(function () { return null; });
      if (sourceBytes === null) {
        failures.push("印花二创：找不到第一步的印花文件 " + sourcePrintFile);
        ctx.log("第二步跳过：第一步的印花文件不可读", "error");
      } else {
        for (const prompt of plan.prompts.recreate) {
          const already = force ? [] : (plan.existing.recreateByPrompt.get(prompt.name) || []);
          const need = Math.max(0, RECREATE_OUTPUTS - already.length);
          if (need === 0) {
            reused.recreate += already.length;
            for (const print of already) recreateRows.push(print);
            ctx.log("第二步：" + prompt.name + " 已有 " + already.length + " 张，跳过");
            continue;
          }
          ctx.log("第二步：" + prompt.name + " → 还需 " + need + " 张" + (already.length > 0 ? "（已有 " + already.length + " 张）" : ""));
          spend(need, "印花二创 " + prompt.name);
          const settled = await mapLimit(new Array(need).fill(0), localConcurrency(), async function () {
            const outputs = await ctx.provider.recreate({
              buffer: sourceBytes.buffer,
              mimeType: sourceBytes.mimeType,
              prompt: prompt.text,
              style: "",
              count: 1
            });
            const output = outputs[0];
            return { id: recordId(), file: await store.putFile(output.buffer, output.mimeType), promptName: prompt.name };
          });
          const made = [];
          settled.forEach(function (result) {
            if (result.ok) { made.push(result.value); produced.recreate++; }
            else failures.push(prompt.name + "：" + result.error);
          });
          if (made.length === 0) { ctx.log("第二步：" + prompt.name + " 全部失败", "error"); continue; }

          const prints = already.concat(made);
          recreateRows.push.apply(recreateRows, prints);
          const existingRow = force ? null : plan.existing.recreateRowByPrompt.get(prompt.name);
          if (existingRow) {
            // Extend the row the previous (interrupted) attempt created, rather
            // than leaving a half-filled row and starting a second one. A forced
            // re-run deliberately does NOT do this: it must not overwrite (and
            // silently orphan) the prints that are already there.
            await store.update(function (state) {
              state.recreations = state.recreations.map(function (row) {
                return row.id === existingRow.id ? Object.assign({}, row, { prints: prints }) : row;
              });
            });
          } else {
            const row = {
              id: recordId(),
              sourceId: plan.existing.extract ? plan.existing.extract.id : null,
              sourceFile: sourcePrintFile,
              sourceName: plan.group.name,
              sourceIsPasted: false,
              prompt: prompt.text,
              promptName: prompt.name,
              style: "",
              prints: prints,
              createdAt: Date.now(),
              workflowId: WORKFLOW_ID,
              groupKey: plan.group.key,
              runId: ctx.runId
            };
            await store.update(function (state) { state.recreations = [row].concat(state.recreations); });
          }
          ctx.log("第二步：" + prompt.name + " 完成 → " + made.length + " 张");
        }
      }
    }

    // ---- 第三步：T恤融合 ---------------------------------------------------
    const tshirtRows = [];
    if (recreateRows.length > 0 && plan.tshirt && plan.tshirt.selected.length > 0 && plan.prompts.tshirt.found) {
      const pairs = [];
      for (const print of recreateRows) {
        for (const tshirtFile of plan.tshirt.selected) {
          pairs.push({ print: print, tshirtFile: tshirtFile, key: tshirtKey(tshirtFile, print.file) });
        }
      }
      const todo = force ? pairs : pairs.filter(function (pair) { return !plan.existing.tshirtKeys.has(pair.key); });
      reused.tshirt = pairs.length - todo.length;
      ctx.log("第三步：T恤「" + plan.tshirt.name + "」选了 " + plan.tshirt.selected.length + " 个款式 × " +
        recreateRows.length + " 张二创印花 = " + pairs.length + " 件，还需生成 " + todo.length + " 件");
      // Charged as one batch, before any call: the size is known exactly, and
      // doing it here (not inside the worker) keeps a breach from being swallowed
      // by the per-item error handling below and reported as "one item failed".
      spend(todo.length, "T恤融合");
      const settled = await mapLimit(todo, localConcurrency(), async function (pair, index) {
        const tshirtBytes = await store.getFile(pair.tshirtFile);
        const printBytes = await store.getFile(pair.print.file);
        const outputs = await ctx.provider.applyToTshirt({
          tshirtBuffer: tshirtBytes.buffer,
          tshirtMimeType: tshirtBytes.mimeType,
          printBuffer: printBytes.buffer,
          printMimeType: printBytes.mimeType,
          prompt: plan.prompts.tshirt.text,
          count: 1
        });
        const output = outputs[0];
        const file = await store.putFile(output.buffer, output.mimeType);
        const row = {
          id: recordId(),
          tshirtId: plan.tshirt.id,
          tshirtName: plan.tshirt.name,
          tshirtFile: pair.tshirtFile,
          printId: pair.print.id,
          printFile: pair.print.file,
          prompt: plan.prompts.tshirt.text,
          prints: [{ id: recordId(), file: file }],
          createdAt: Date.now(),
          workflowId: WORKFLOW_ID,
          groupKey: plan.group.key,
          runId: ctx.runId
        };
        await store.update(function (state) { state.tshirtRecreations = [row].concat(state.tshirtRecreations); });
        if ((index + 1) % 8 === 0) ctx.log("第三步进度：" + (index + 1) + "/" + todo.length);
        return row;
      });
      settled.forEach(function (result) {
        if (result.ok) { tshirtRows.push(result.value); produced.tshirt++; }
        else failures.push("T恤融合：" + result.error);
      });
      ctx.log("第三步完成 → 新生成 " + produced.tshirt + " 件，复用 " + reused.tshirt + " 件");
    }

    // Everything this group has ever produced, not just this run's share — the
    // fourth step must cover composites made by an earlier attempt too.
    const allTshirtRows = force ? tshirtRows : plan.existing.tshirtRows.concat(tshirtRows);

    // ---- 第四步：换装+裂变 -------------------------------------------------
    if (allTshirtRows.length > 0 && plan.prompts.scene.found && plan.scenes.available > 0) {
      const scenes = (await store.read()).scenes;
      const items = [];
      for (const row of allTshirtRows) {
        const tshirtFile = row.prints && row.prints[0] ? row.prints[0].file : null;
        if (!tshirtFile) continue;
        for (let pass = 0; pass < SCENE_PASSES; pass++) {
          for (let variant = 0; variant < SCENE_OUTPUTS; variant++) {
            items.push({ tshirtFile: tshirtFile, pass: pass, variant: variant, key: sceneKey(tshirtFile, pass, variant) });
          }
        }
      }
      const todo = force ? items : items.filter(function (item) { return !plan.existing.sceneKeys.has(item.key); });
      reused.scene = items.length - todo.length;
      ctx.log("第四步：换装+裂变，共 " + items.length + " 张，还需生成 " + todo.length + " 张（每件 " +
        SCENE_PASSES + " 轮 × " + SCENE_OUTPUTS + " 张）");

      // One scene per (composite, pass): the four images of a pass are one
      // "generation", so they share a scene; the two passes get different ones.
      const sceneFor = new Map();
      const usedPerPass = new Map();
      const planned = todo.map(function (item) {
        const key = item.tshirtFile + "|" + item.pass;
        if (!sceneFor.has(key)) {
          const taken = usedPerPass.get(item.tshirtFile) || [];
          sceneFor.set(key, pickScene(scenes, taken[taken.length - 1] || null));
          usedPerPass.set(item.tshirtFile, taken.concat([sceneFor.get(key) ? sceneFor.get(key).id : null]));
        }
        return Object.assign({}, item, { scene: sceneFor.get(key) });
      });

      spend(planned.length, "换装+裂变");
      const settled = await mapLimit(planned, localConcurrency(), async function (item, index) {
        const sceneBytes = await store.getFile(item.scene.file);
        const tshirtBytes = await store.getFile(item.tshirtFile);
        const outputs = await ctx.provider.generate({
          images: [
            { buffer: sceneBytes.buffer, mimeType: sceneBytes.mimeType },
            { buffer: tshirtBytes.buffer, mimeType: tshirtBytes.mimeType }
          ],
          prompt: plan.prompts.scene.text,
          count: 1
        });
        const output = outputs[0];
        const file = await store.putFile(output.buffer, output.mimeType);
        const product = {
          id: recordId(),
          workflowId: WORKFLOW_ID,
          groupKey: plan.group.key,
          groupName: plan.group.name,
          runId: ctx.runId,
          kind: "scene",
          file: file,
          tshirtFile: item.tshirtFile,
          sceneId: item.scene.id,
          sceneFile: item.scene.file,
          pass: item.pass,
          variant: item.variant,
          promptName: SCENE_PROMPT_NAME,
          createdAt: Date.now()
        };
        await store.updateOutputs(function (doc) { doc.outputs = [product].concat(doc.outputs); });
        if ((index + 1) % 16 === 0) ctx.log("第四步进度：" + (index + 1) + "/" + planned.length);
        return product;
      });
      settled.forEach(function (result) {
        if (result.ok) produced.scene++;
        else failures.push("换装+裂变：" + result.error);
      });
      ctx.log("第四步完成 → 新生成 " + produced.scene + " 张，复用 " + reused.scene + " 张");
    }

    // ---- 收尾 -------------------------------------------------------------
    const counts = {
      extract: produced.extract + reused.extract,
      recreate: produced.recreate + reused.recreate,
      tshirt: produced.tshirt + reused.tshirt,
      scene: produced.scene + reused.scene
    };
    await touchGroup(store, plan.group.key, {
      status: failures.length > 0 ? "failed" : "done",
      lastRunId: ctx.runId,
      lastRunAt: ctx.now(),
      updatedAt: ctx.now(),
      counts: counts,
      failures: failures.length
    });

    const summary = "分组「" + plan.group.name + "」：新生成 " + produced.extract + "/" + produced.recreate + "/" +
      produced.tshirt + "/" + produced.scene + "（提取/二创/T恤/成片），复用 " +
      (reused.extract + reused.recreate + reused.tshirt + reused.scene) + " 项";

    if (failures.length > 0) {
      // Thrown, not returned: the run genuinely did not finish its job, and a
      // green "成功" would hide that. Everything produced is already persisted,
      // and the group stays queued, so the next run continues from here.
      ctx.log("本次有 " + failures.length + " 项失败，已保留全部成功产物。重跑会接着补。", "warn");
      failures.slice(0, 5).forEach(function (message) { ctx.log("失败：" + message, "error"); });
      throw new Error(summary + "；失败 " + failures.length + " 项（已保留成功产物，重跑会续上）：" + failures[0]);
    }
    ctx.log(summary);
    return summary;
  }
};

module.exports = {
  printPipeline,
  planGroup,
  scanGroups,
  findGroup,
  groupConfig,
  nextApprovedGroup,
  touchGroup,
  normalizeGroupKey,
  groupDirectory,
  inboxRoot,
  WORKFLOW_ID,
  WORKFLOW_NAME,
  LOOSE_GROUP,
  LOOSE_GROUP_NAME,
  EXTRACT_PROMPT_NAME,
  TSHIRT_PROMPT_NAME,
  SCENE_PROMPT_NAME,
  RECREATE_PROMPT_PATTERN,
  RECREATE_OUTPUTS,
  SCENE_PASSES,
  SCENE_OUTPUTS,
  maxCallsPerRun
};
