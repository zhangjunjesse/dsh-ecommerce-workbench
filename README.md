# DSH Ecommerce Workbench Mock

A DSH plugin that renders a local e-commerce design workbench as the profile's
primary UI, so opening DSH lands on the workbench. Ships **印花管理** (印花提取 +
印花二创, real generation) and **T恤二创** (apply a print onto a T恤, real
generation) as the print pipeline; then **工作流** (a list plus one page per
workflow — its settings, the work it owns, and every run it has made; ships with
**印花流水线**, the four-step batch pipeline, already registered) and **成品库**
(the finished shelf, browsed like a shopping app) directly beneath it; below a
divider sit the non-pipeline items: **通用工作台** (free-form prompt + reference
images → outputs, the daily driver), **T恤管理** (upload and manage multiple
reference photos per T恤, no generation), **提示词管理** (saved prompts, pickable
from every composer) and **场景图管理** (paste scene photos straight into a
masonry pool, no generation).

The workbench is backed by a real Host API that persists to disk: images are
uploaded, stored as files, and their metadata is kept in `state.json`. Image
generation is real too — the host shells out to the `toapis-gpt-image-2` skill's
`scripts/generate.py`, which calls the ToAPIs `gpt-image-2` service (upload the
reference image → create a task → poll → download). If the skill script or an API
key is unavailable, the workbench **falls back to a no-network passthrough**
(`createLocalProvider`) so it stays functional.

## Phase 1 (current): 印花管理

Two flows under the「印花管理」module:

- **印花提取** — paste/upload one or more images plus a prompt, submit, and
  **one submission = one task = one extracted print**: every uploaded image is
  passed to the service together as references and combined into a single output
  (edit mode: isolate the pattern, drop the background). Results land directly in
  the 印花原图库 (the results feed), newest first, each row keeping the source
  thumbnail + prompt so a print stays traceable. Per-item remove and a clear-all
  action are on the toolbar.
- **印花二创** — pick **one** print from the 原图库 **or paste/upload a print image
  straight into the composer** as the source, enter a prompt, choose a style and
  the number of outputs (1 / 2 / 4 / 6); one feed row is created with that many
  re-created prints (edit mode: re-create the pattern in the chosen style). A
  pasted source is stored for that row only (not added to the 原图库) and is
  cleaned up when the row is deleted. Variants and whole rows can be removed.

The other modules (工作台首页 / 场景图管理 / 模特管理 / 产品管理) are out of
scope for now.

## T恤二创

Picks **one** T恤(from「T恤管理」), then multi-selects from **two pools**:
that T恤's own reference photos (front/back/detail — pick one or several) and
prints from 印花二创's RESULTS, i.e. **二创印花**, not the raw 印花原图库.
**Multi-select on either side is a cross product**: every chosen photo of
that one T恤 is paired with every chosen print, one generation per pair
(e.g. 2 photos x 3 prints = 6 generations), each pair becoming its own feed
row — always exactly one composite per pair, no per-pair output-count
picker. Real generation, edit mode with two reference images (T恤 photo
first, print second) so the model keeps the T恤's shape/fabric/lighting and
places the print onto it rather than treating either image as a style
reference only. Same non-blocking job + live-progress + partial-failure-
tolerant shape as 印花二创 — the job's `total`/`done` track pairs, not
variants, and a stuck/failed pair does not discard the other already-
generated rows. Each feed row shows the source T恤 photo + print on the left
and the one generated composite on the right; rows can be removed.

## T恤管理

A T恤 is a named group of uploaded reference photos — **no generation, just
durable storage and management**, since the point is capturing what a real
T恤 looks like, not creating new images of one. It's the input side for T恤二创
(which reads a T恤's first photo), so it lives in its own de-emphasized nav
group below a divider rather than beside the generation-facing modules:

- **新建T恤** — an inline composer takes an optional name plus one or more
  photos (paste/upload); submitting creates one card in the grid.
- **多图上传** — a T恤 is not limited to one photo. Each card keeps growing:
  a dashed "+" tile inside the card appends more photos to that same T恤 at
  any time (e.g. front, back, tag, detail shots collected over several visits).
- Per-image remove, per-T恤 delete, and a clear-all action are available; every
  photo opens in the click-to-enlarge lightbox like the rest of the workbench.

## 工作流

A scheduled/manual automation module, in the primary nav group directly under
T恤二创 (it *does* work on its own, unlike the storage-only modules below the
divider).

**A workflow is code, not data.** Each one is a definition registered in
`lib/workflows.js` (`{ id, name, description, run(ctx) }`), and the module ships
with **none registered** — so the view opens on an empty state that says where a
workflow comes from, rather than an empty list that looks like a feature nobody
has used yet. What the user owns is everything around the body: whether it is
enabled, its schedule, triggering it by hand, and its run history. Adding a
workflow is a code change — write the definition, list it in
`BUILT_IN_WORKFLOWS`, and it appears in the view with its own settings and
history, with no client change.

The `ctx` a workflow is handed carries `log(message, level)` (bounded, per-run),
the durable `store`, a concurrency-guarded `provider`, and `trigger`/`now()`.
The definition is validated at mount — a malformed one throws in front of whoever
just wrote it, instead of surfacing hours later as a scheduled run failing in the
dark.

**Scheduling: two shapes, deliberately.** An interval (every N minutes, 1 …
10080) or a fixed local wall-clock time (每天 HH:MM). Cron was considered and
rejected — it would add a parser, a timezone model and a DST story to answer a
question nobody has asked yet. The next occurrence is always recomputed from the
wall clock rather than by adding an interval to the previous one, so a
long-running host cannot drift, and a daily time stays on its wall clock across a
DST change.

**Enabling never fires immediately.** Turning a workflow on, or changing its
schedule, recomputes the next occurrence to one interval from now. Flipping a
switch therefore cannot cause a surprise run, and a stale timestamp from before
the change cannot fire the moment the scheduler looks at it. 立即运行 covers
impatience.

**Missed occurrences are skipped, never caught up.** The scheduler lives inside
the host process — a workflow only fires while DSH is running, nothing is
registered with the OS — so an occurrence that came due while DSH was down is
recorded **once** in the history as 已跳过 and the schedule moves on. Catching up
would mean a burst of real (possibly billable) executions the moment DSH starts,
the opposite of what 「每 30 分钟」 was understood to mean. The same rule holds
while the host is up: a host busy for three intervals fires once, not three
times.

**One run at a time per workflow.** A schedule that comes due while the previous
run is still going is skipped and counted, not queued — queueing would let a slow
workflow build an unbounded backlog, and every queued run would be a real
execution. The count is reported in the running run's log when it finishes, so
the skip is visible without writing a history entry per tick. 停用 stops the
*schedule*; it does not forbid 立即运行.

**Every attempt leaves a record.** Trigger (手动/周期), status (运行中 / 成功 /
失败 / 已跳过), start time, duration, a one-line summary returned by the workflow,
and its log lines. The history table carries **no** log lines
(`GET /ecom/api/workflow/runs`); one run's logs come from
`GET /ecom/api/workflow/run?id=…`, so drawing the table never moves the whole
archive. Logs are held in memory during a run and written **once**, at the end —
a write per line would mean thousands of `state.json` rewrites for a chatty
workflow. All bounded: the last **50** runs per workflow
(`ECOM_WORKFLOW_RUN_KEEP`), **500** across all workflows
(`ECOM_WORKFLOW_RUN_TOTAL`), **500** log lines per run
(`ECOM_WORKFLOW_LOG_LINES`), each line clipped at 2000 characters.

**A workflow cannot bypass the generation cap.** The provider it is handed is a
wrapper whose every method acquires the shared `withGeneration` slot, so there is
no unguarded path *by construction* rather than by convention. `withGeneration`
itself is deliberately not exposed to a workflow: nesting it (an outer slot
around a guarded provider call) would let two concurrent workflows hold one slot
each while each waits for a second, which deadlocks against the cap of 2.

**Deliberately absent.** There is no 「停止运行」 button: a provider call already
in flight cannot actually be interrupted, and a button that does nothing is worse
than no button. A run that was in flight when the host exited is instead closed
out at the next mount as 失败（宿主在这次运行期间退出）rather than sitting in
history claiming to be running forever.

Host endpoints: `POST /ecom/api/workflow/config` (enable / schedule),
`POST /ecom/api/workflow/run` (manual trigger → `runId` at once; 409 if one is
already in flight), `GET /ecom/api/workflow/runs`,
`GET /ecom/api/workflow/run`, `POST /ecom/api/workflow/clear`. `/ecom/api/state`
also returns `workflows`: one entry per registered definition, merged from the
registry (what exists in code) and the store (what the user changed about it),
plus its live running state.

## 成品库

The finished shelf, one level below 工作流 in the nav. It shows what the pipeline
actually produced, browsed the way a shopping app shows a listing, because the
data already has that shape:

| 电商 | 这里 |
|---|---|
| 商品 | 一个参考图分组 |
| 款式 / SKU | 一个「二创T恤」（某张 T恤照片 × 某张二创印花） |
| 款式图集 | 该款式的 8 张场景成片 |

**The shelf is shaped like a Taobao listing**, because a listing is where these
goods are headed and the shelf exists to judge them as such. Each card is:
a **square image stage** on a light ground (4 across, fixed count, newest first),
then the title (`商品A · 款式 #1`), a strong spec line where Taobao puts the price
(`8 张成片`), a row of small tags (`2 个场景` / `每场景 4 张` / `3:4`), and a hairline
with the T恤 underneath — the closest thing this data has to a shop. The whole
text block is clickable, not just the image.

What is deliberately **not** copied: price, 销量 and 店铺评分. There is no such data
here, and inventing numbers on a shelf used to decide what to publish would be
worse than leaving the slot empty; a test asserts no price or sales figure can
appear. Every line on the card is something the pipeline recorded.

The stage is a fixed square with the shot **contained** — Taobao's tile without
Taobao's crop. These are 3:4 shots and cropping one to a square cuts the garment;
a square box also cannot jump as images load, which is what the old
measured-ratio box was working around. Each 款式 shows **one** image: a 商品 with
24 款式 would otherwise be 192 near-identical tiles and the eye would have
nothing to compare. The rest of that 款式's shots are behind a swipe (drag the
image, or use its ‹ › arrows).

**Clicking a card opens a modal shaped like a Taobao product page.** The **left
rail lists every 款式 of that 商品** — Taobao's SKU list, selected one outlined —
so comparing two colourways no longer means closing the modal and finding another
card. The middle is that 款式's gallery: big image, ‹ ›, a counter
(`第 2 / 8 张`), click to zoom. The right column says what the shot is made of
(the scene photo and the 二创T恤), shows **the 款式's whole contact sheet** as a
40px grid (the rail used to do this job; now that it holds 款式, the shots need
somewhere to be seen at a glance), and lists the product's own numbers. Arrow keys
move between shots; Esc or the backdrop closes it.

It is a modal rather than a page because a page would replace the shelf and lose
the browsing context you just had, and it still has **no 款式 strip along the
bottom** — the rail does that job without spending any of the image's height.

It is deliberately **not** the same view as the workflow's group panel: the group
panel is the operator's view (queue, cost estimate, all four stages including the
intermediates), while this is the shelf of finished goods. The intermediates stay
in their own modules — 印花原图库 / 二创印花 / T恤二创结果 — where they can be
reused.

The images come back in whatever shape the model produced; tiles mount a page at a
time as a sentinel scrolls into view, and one 商品 can be filtered to via the
chips. Distribution into columns is the same **round-robin into explicit columns**
场景图管理 uses (`distributeColumns`) — never CSS multi-column, which reorders and
cannot be paginated. The measured width/height are still stored and read
(`lib/imageSize.js`): they label the card when they reduce to something a person
would write (`3:4`).

A shot record names its own 款式: `tshirtFile` (the composite, which *is* the
款式's identity), `tshirtName` / `tshirtPhoto` (the T恤 it is a colourway of) and
`printFile` (the 二创印花 it wears), plus `sceneIndex` / `variant`. Those four were
added when the card became a listing; `scripts/backfill-output-fields.js` fills
them on records written before that by looking the composite up in
`tshirtRecreations` — nothing is inferred, it is idempotent, and it reports any
shot whose row is gone rather than guessing.

## 印花流水线

The workbench's first real workflow (`print.pipeline`, `lib/printPipeline.js`): a
**group of reference screenshots** goes in, finished products come out, with no
per-step button pressing. Open 工作流 → 印花流水线 (the row) → its page.

The 工作流 module is **a list and a page**: the list says which workflows exist
and how each last went; opening one gives that workflow its own page — the page
header carries the way back, the name, its live status and when it last ran, and
everything else sits on **three tabs** so the page is one thing at a time:

| Tab | What it holds |
| --- | --- |
| 分组与队列 | (only for a workflow that owns a queue) the reference groups, the upload composer, and one group's cost estimate and outputs — **opened inside that group's own row** |
| 设置与参数 | the run card (enable/disable, schedule, manual trigger) and the workflow's declared settings |
| 运行记录 | every run, and the selected run's log — the newest run is selected on arrival, so the tab shows a log rather than an instruction |

Nothing is expanded inline inside a card, and the queue's estimate is never
appended below the list: it belongs to one group, so it renders in that row,
next to the buttons that act on it.

```
一组参考图（同一商品的多个角度截图）
 ① 提取印花   the whole group is passed to the extractor together      → 1 张
 ② 印花二创   every 「印花二创-N」 prompt runs once, 2 outputs each      → 4 × 2 = 8 张
 ③ T恤融合    every re-created print × every selected 款式 (T恤 photo)  → 8 × 3 = 24 张
 ④ 换装裂变   every composite, 2 passes of 4, [random 场景图, composite] → 24 × 8 = 192 张
```

**That is 1 + 8 + 24 + 192 = 225 provider calls per group**, roughly two hours at
the host's concurrency of 2. Every number below exists because of that one.

**Intake: upload or folder, one place.** The inbox is
`$DSH_HOME/ecommerce-workbench/workflow-inbox/print.pipeline/`, and **one
immediate subfolder is one group**. 「上传参考图」 writes into that same
directory, so the two paths the user described converge on one source of truth
and the UI simply reads the directory. Images lying **loose in the inbox root**
are gathered into a single 「未分组」 group rather than each becoming a group of
one: a single-image group is legal, so the alternative would silently turn three
angles of one product into three separate 225-call runs, each extracting a print
from a third of the information. The estimate warns about that bucket instead,
and the fix — move them into a subfolder — stays with the user.

**The T恤 and its 款式.** The group stores which T恤 it runs against; the
default is the first T恤 and **all** of its photos, because that is what 「所有款式」
means here: one photo is one 款式 (the existing T恤二创 model, which also renders
one composite per photo). On this machine that is one T恤 with three photos, which
is exactly the 3 × 8 = 24 the feature was specified with. A stored selection that
no longer matches the T恤 (a photo was deleted, or the T恤 was switched) falls
back to the default *and says so*, rather than degrading to "generate nothing" —
the fallback is what the user would have got had they never picked.

**Prompts come from 提示词管理, matched by exact name**: `印花提取`,
`印花二创-1…N` (ordered by the numeric suffix, not alphabetically),
`印花T恤融合`, `换装+裂变`. Missing ones are not silently skipped: the estimate
lists each one, and the steps that cannot run report 0 in the plan. Only 提取 has
a built-in fallback; the other three are required for their step.

**One group per run.** The pipeline deliberately does not drain the whole queue:
one mistake, or one upstream hiccup, would otherwise cost the queue's worth of
credits instead of one group's. The scheduler's job is to chew through the queue
one group at a time — set 周期 to e.g. 每 1 小时 and approved groups are processed
in order, one per run.

**Approval is what the scheduler consumes.** A scheduled run has nobody to show
an estimate to, so it only picks up groups that were explicitly **排队**d (the
row's toggle, stored as `approvedAt`); with nothing approved it does nothing and
says so. A *manual* run names its target outright, so it needs no approval.
Re-approving a finished group re-queues it (otherwise approving after adding more
screenshots would silently do nothing).

**A group's row is two lines, in the order the questions get asked.** The first
line answers 「这是哪一组、现在什么状态、下一步做什么」 — a status dot, the
name, the status chip, the reference-image count, then 「估算并运行」 and delete.
The second line is the four step counts and the two secondary controls (「排队」,
「看成品」/「收起成品」). Six controls on one line, as it was, made the primary
action indistinguishable from the rest. The reference file names are no longer
printed under every row — they are noise at this density and now live in the
row's tooltip.

**The cost is shown before it is spent, and capped.** 「估算并运行」 fetches
`GET /ecom/api/workflow/estimate?groupKey=…` and shows the exact call counts per
step, which prompts/T恤/scene pool it will use, what is already done, and every
warning — then the user confirms. A run re-checks the same plan against
`ECOM_WORKFLOW_MAX_CALLS` (default **400**, i.e. one group plus headroom) and
refuses before its first call. The ceiling is also enforced **stage by stage
against what is actually about to be sent**, not only against the up-front
estimate: an optimistic estimate would otherwise be the one thing that could talk
the cap out of a cap. A forced re-run is checked against the full plan, since it
ignores what already exists.

**Re-running resumes; it never pays twice.** Every artefact is stamped with
`workflowId` + `groupKey` (+ the keys it derived from), so a later run can see
what already exists and generate only what is missing. That index is derived from
the artefacts themselves — there is no separate progress ledger to fall out of
step with the files. Interrupt an hour-long run, run it again, and it continues
where it stopped; run it again when it is complete and it costs nothing at all.
「强制重跑」 is the explicit way to ask for a second full pass, and it writes new
rows rather than overwriting the ones already paid for.

**Where the products go.** Steps 1–3 write into the normal feeds (印花原图库 /
二创印花 / T恤二创结果) stamped with `runId` + `groupKey`, so the artefacts are
usable in the rest of the workbench exactly like hand-made ones. Step 4 writes
into a **separate product library** (`workflow-outputs.json`,
`GET /ecom/api/workflow/outputs`). That separation is not tidiness: 场景图管理 is
the *reference* pool this step draws its random scene from, so putting the
outputs back into it would mean later runs picking the pipeline's own products as
scene references, degrading every generation after the first. The workflow's page
shows all four stages per group and can delete any of them (steps 1–3 delete
through their own modules' records, step 4 through the product library); the
finished step-4 products are also browsable in 成品库.

**Failure semantics.** Each item is caught independently and persisted the moment
it succeeds, so one bad call never discards the rest of the batch. A run that had
any failures is reported as **失败** (a green 成功 would hide it) with a summary
saying what was kept, and the group stays in the queue — the next run resumes.
Nothing is ever deleted to "clean up" a failure.

**Parameters.** The two numbers that decide step 4's shape — and most of a run's
cost — are settings, not code: **随机选择多少个场景图** (how many scenes each
二创T恤 is shot in) and **每个场景图出几张** (how many images each of those scenes
yields). They live on the workflow's page under 「参数」, save as you change them,
and apply to the next run; the estimate reflects them immediately, so the cost of a
choice is visible before it is spent. Defaults are 2 and 4, which is exactly the
225-call shape above.

A workflow **declares** its settings (key, label, type, default, range, help) and
the engine does the rest: values are validated, clamped into range rather than
rejected, stored per workflow, handed to `run` as `ctx.settings`, and returned to
the client with the declaration — so the form is generated from the declaration and
a new knob needs no client change. Two honest edges: a value outside the declared
range is clamped (the box snaps back to what will actually be used), and asking for
more *distinct* scenes than the pool holds is capped at the pool size and said so in
the estimate, because a T恤 cannot be shot in more different scenes than exist.

Env knobs: `ECOM_WORKFLOW_MAX_CALLS` (ceiling per run), `ECOM_PIPELINE_CONCURRENCY`
(calls this workflow keeps in flight; the host's global cap still applies),
`ECOM_PIPELINE_RECREATE_OUTPUTS` (2). The two step-4 numbers above are settings now;
their env vars (`ECOM_PIPELINE_SCENE_PASSES`, `ECOM_PIPELINE_SCENE_OUTPUTS`) remain
only as the **defaults** of those settings, so an existing deployment keeps the
shape it was configured with.

### Why the store now writes atomically

Workflow runs write `state.json` repeatedly while the client polls
`/ecom/api/state`, which exposed a latent defect in the store: `writeFile`
truncates the target before writing it, so a concurrent read could observe a
half-written file, fail to parse it, and surface to the client as a 500. Both
documents are now written to a sibling temp file and renamed into place, so a
reader always sees either the previous complete document or the new one — never a
torn one.

The same change made an older, documented race in the generation jobs (a job
marked `done` *before* awaiting the `store.update` that persists its row) show up
far more often, because atomic writes widen that window slightly. That ordering
is fixed too: the row is persisted first, and only then is the job published as
done, so a poller acting on 「已完成」 always finds the result already in
`/ecom/api/state`.

## Importing already-finished prints from disk

印花二创 has an「导入文件夹」button (next to 清空) for bulk-importing prints that
were already produced outside the workbench — no re-generation, no cost, and
**no path to type**: click「选择文件夹」and pick the folder in the OS dialog.
Browsers never hand back an absolute filesystem path from that dialog (a
platform restriction, not an omission here), so the picked files are read in
the browser and uploaded directly via `POST /ecom/api/importFiles`. There is
no manual-path fallback in the UI; `POST /ecom/api/importFolder` (a
server-side `readdir` given a `root` path) still exists as an API-only route
for headless/scripted use, but nothing in the client calls it.

The folder's immediate subfolders are treated as one per product
(e.g. `产品/00001`, `产品/00002`, …), each holding a「印花」(or any folder
whose name contains "print"/印花) subfolder with the finished print image(s).
One representative file is imported per product (see
`pickRepresentativeFile` in `lib/index.js`, mirrored client-side as
`pickRepresentativeFileClient`: prefers a size-capped "under5mb" variant, then
an uncompressed "transparent_clean" PNG, then a "composite" render, else the
first file alphabetically — so a product folder with several processing
variants of the same print doesn't import every duplicate). Each import
becomes a normal 二创印花 result row (`prompt` records where it came from,
`style` is "导入"), immediately selectable in T恤二创 exactly like a freshly
generated one. Synchronous (no job): reading/uploading local files is fast,
unlike real generation. Both endpoints stay under the same loopback-only
trust model as the rest of this API.

## Live progress

Real generation takes tens of seconds per batch, so extract/recreate are
**non-blocking**: they reply with a `jobId` immediately and finish in the
background. The host publishes live progress (`stage` uploading → generating →
downloading, plus `done/total` and elapsed time) at `GET /ecom/api/job/<id>`,
and the client polls it. A **persistent placeholder card** appears in the
results feed as soon as a job is submitted and stays (spinner + stage +
`已等待 m:ss`) until it finishes. The four workbench views are rendered but
hidden when inactive (`display:none`), never unmounted, so an in-progress job —
and its placeholder — survives switching between 印花提取 / 印花二创 / T恤二创
instead of vanishing mid-task. This replaces the old blocking call that left the
UI silently waiting for the whole batch.

Jobs are **owned by the workbench**, not the individual op views, so they keep
polling across the workbench's internal tab switches. Switching the whole
conversation view to **Chat and back** unmounts and remounts the workbench, but
the host keeps every running job in memory (`GET /ecom/api/jobs` lists them) and
the workbench **re-adopts** them on remount, and every finished result is already
persisted to the store — so an in-progress task reappears and keeps going rather
than being lost.

## 通用工作台

The free-form daily driver, below the divider with the other non-pipeline
items. Paste or upload **any number of reference images**, write **any prompt**,
pick how many outputs (1 / 2 / 4), and generate. Unlike the print flows nothing
is prepended to the prompt and the references carry no fixed roles — the prompt
drives everything, so it can say "combine these two" or "use the second image's
palette". Reference images are optional: with none it is plain text-to-image.

Each submission becomes one feed row (references → outputs) with a copyable
prompt; outputs and whole rows can be removed, and a row's reference images are
cleaned up when its last output goes. Every row also has a **复用** button that
refills the composer from that history row — the prompt goes back into the
input box and the row's reference images are fetched from the host and turned
back into pending paste thumbnails (equivalent to hand-pasted ones), so a past
task can be tweaked and resubmitted in one click. If a row's source files were
already cleaned up on the host, the missing thumbs are dropped with a
non-blocking warning instead of loading forever. Host endpoint: `POST /ecom/api/generate`
(same non-blocking job shape as the other flows), plus `/ecom/api/delete` as
`kind: "generation"` / `"generationVariant"` and `/ecom/api/clear` as
`kind: "generations"`.

## 提示词管理

A second-tier nav item manages saved common prompts: create (name + text),
edit, copy, delete, clear-all — persisted in the store like the rest of the
data. Every composer (印花提取 / 印花二创 / T恤二创 / 通用工作台) has a small
bookmark button that opens a picker of these prompts; picking one fills the
prompt box. Host endpoints: `POST /ecom/api/prompt` (upsert), plus
`/ecom/api/delete` as `kind: "prompt"` and `/ecom/api/clear` as
`kind: "prompts"`.

## 场景图管理

The other storage-only module: a **flat pool of scene photos**, nothing more.
There is no prompt, no picker and no generation — paste an image (**Ctrl+V**
anywhere in this view), drop files onto the module, or use「上传图片」, and it is
**stored immediately**: no pending strip and no submit button, because the point
is capturing reference scenes, not composing a task. A short 「正在保存 N 张…」
row replaces the hint while bytes are in flight.

Photos are shown **newest first**, and they render as a **masonry waterfall**:
scene photos arrive in every aspect ratio, so each tile keeps its own height
instead of being cropped to a square.

The waterfall is packed into explicit flex columns — one `<div>` per column,
round-robin, so photo *i* goes to column *i % n* — and **not** into CSS
multi-column. That is a correctness fix, not a style preference: `column-width`
fills column 1 to the bottom before it starts column 2, so a newest-first list
reads as 0, n, 2n… across the top row. The newest photos all end up stacked in
the leftmost column and the visible order looks scrambled. Round-robin puts the
newest *n* photos across the first row instead, so scanning left to right and
then downwards scans newest to oldest. The column count follows the container
width (`ResizeObserver`, ~220px per column).

The order itself is enforced at the contract boundary, not left to whoever wrote
last: `GET /ecom/api/state` sorts `scenes` by `createdAt` descending, so an
out-of-order write or a hand-edited `state.json` cannot silently make the pool
non-chronological. One paste is one moment — every photo in a single batch
shares one `createdAt`, so the order is decided *between* uploads rather than by
which file in the batch happened to finish its I/O first.

One bound worth stating plainly: because the columns have independent heights, a
waterfall cannot *also* guarantee a strict global chronological order — the
(n+1)-th photo can sit above or below the n-th depending on tile heights. What
is guaranteed is that the newest photos come first, left to right.

### Why the pool is not rendered all at once

Measured against the real library (222 photos at the time of writing): 163 MB on
disk, ~0.74 MB per file, 600x800 — about **1.7 MB of decoded bitmap each**, and
~409 MB if every one were mounted and decoded together. Two things stop that
being paid up front:

- **Height is reserved before the bytes arrive — but only when the size is
  genuinely known.** The host measures each photo from the header of the bytes it
  just stored (`lib/imageSize.js`; PNG/GIF/JPEG/WebP, no image library and no new
  dependency), never from anything a caller claims, and the tile sets
  `aspect-ratio` from it so a column does not jump when its images decode.
  Photos stored before this carry no size until a one-time startup backfill reads
  them from their files.
- **An unknown size leaves the ratio unset.** This is the load-bearing rule, not
  a nicety: `aspect-ratio` is a promise about the content, and an `<img>` uses
  `object-fit: fill` by default, so a *guessed* ratio stretches the photo. An
  earlier revision of this feature defaulted unknown sizes to `3 / 4` and
  visibly distorted the 42 of 223 photos whose real ratio differs from 3:4 by
  more than 2% (one is nearly square). A photo with no known size now lays out at
  its natural ratio; the only cost is a possible shift as it loads, and a shift
  beats a distorted photo.
- **Tiles are mounted a page at a time.** Only the first `SCENE_PAGE` (36) tiles
  exist; a sentinel below them raises the count by one more page whenever it
  scrolls into view, and the toolbar reads 「N 张场景图 · 已显示 M」while more
  remain. Without `IntersectionObserver` the pool renders everything rather than
  hiding photos behind a page size that nothing could advance.

`loading="lazy"` on every tile plus the `immutable` cache header on `/file/` do
the rest: off-screen photos are never fetched, and re-visits never re-transfer.

Deliberately **not** done yet: a paged `/ecom/api/scenes?offset&limit` API, and
server-side thumbnails. The metadata payload is 112 bytes per photo (~110 KB at
1000 photos), and images are served over loopback, so neither is the binding
constraint today. Server-side thumbnails would also mean depending on `sharp`,
which currently resolves only as a **transitive dependency of DSH itself** —
borrowing it would make this plugin break the next time DSH is upgraded, the way
`redfox-community-dsh` disappeared in the 0.1.5 upgrade.

Clicking a photo opens the shared lightbox; the button on each tile deletes that
one photo (**确定删除这张场景图？**), and the toolbar's 清空 empties the pool.
Deleting removes the record and its image bytes together, like every other
module. Host endpoints: `POST /ecom/api/scene/add` (one uploaded image = one
record), `/ecom/api/delete` as `kind: "scene"`, `/ecom/api/clear` as
`kind: "scenes"`.

One intake rule worth knowing: the paste listener lives on the `document`, gated
on this module being the active tab, and is skipped while the caret is in a text
field. The chat composer below the workbench is such a field, so pasting an image
there stays the chat's business instead of silently landing in this pool.

## Concurrent generation

A batch — several pasted/uploaded images in one 印花提取 submit, or the N
variants of one 印花二创 output count — generates **concurrently**, bounded to
`GENERATION_CONCURRENCY` (default **2**, override with
`ECOM_GENERATION_CONCURRENCY`) in-flight calls at once, instead of one item
after another. For 二创, this means the host makes `count` separate
single-output provider calls in parallel rather than one call asking for
`count` outputs, so the host controls the parallelism directly. `done/total`
on the job reflects real per-item completion (including failures — a settled
item counts, whether it succeeded or not), and the final print order matches
the request order regardless of which one finishes first.

This limit is a **global semaphore shared across every job**, so submitting
several batches while one is still running queues them rather than all hitting
the upstream at once. The submit buttons stay enabled — you can keep submitting
as many tasks as you like; each appears as its own placeholder and runs when a
generation slot frees.

**Why 2, not higher**: measured directly against the real ToAPIs service, 4
concurrent calls caused one call to stall indefinitely — no success, no error,
well past its usual ~50-90s — while the other 3 completed normally. 2 is the
empirically safer default; raise `ECOM_GENERATION_CONCURRENCY` only if your
ToAPIs plan can sustain more parallel tasks.

**A stuck or failed item never discards the rest of the batch.** Each item in
a batch is caught independently: if one image or variant fails (including a
timeout — `createToapisProvider`'s per-call timeout was also cut from 10
minutes to `ECOM_PROVIDER_TIMEOUT_MS`, default **4 minutes**, so a stuck call
fails fast instead of stalling the whole job), the job still finishes `"done"`
with every successful item kept, and `job.error` carries a short summary
("N 张…失败，已保留 M 张成功结果：…") that the client shows as a non-blocking
warning. The job only ends in `"error"` when *every* item in the batch failed.
This closes a real defect where one bad or slow item silently threw away every
already-generated, already-paid-for result in the same batch.

## Click to enlarge

Every real image in the workbench (pending paste thumbnails, 原图库 source/result
pairs, the picked print in 印花二创, the picker grid, every re-created variant, and
every photo in 场景图管理 / T恤管理) opens in a full-screen lightbox on click —
backdrop click or Escape closes it. Where click already means something else (the 二创 picker selects a
print), a small separate zoom icon opens the lightbox instead of hijacking the
selection click.

## Package layout

| File | Half | Role |
|---|---|---|
| `lib/index.js` | Host | Serves the `/ecom/api` JSON API (state / extract / recreate / tshirtRecreate / importFolder / importFiles / generate / scene/add / delete / clear / file / job / jobs / tshirt / prompt / workflow/*) and picks the image provider (ToAPIs, else local passthrough). |
| `lib/store.js` | Host | Durable store: `state.json` metadata + `workflow-runs.json` run history + `workflow-outputs.json` product library + `files/<id>.<ext>` image bytes under `$DSH_HOME/ecommerce-workbench`. Every document is replaced atomically (temp file + rename) so a concurrent read can never see a half-written file. |
| `lib/imageSize.js` | Host | Dependency-free image header reader (PNG/GIF/JPEG/WebP). Returns `null` rather than guessing, because a guessed ratio is what stretches a photo. |
| `lib/provider.js` | Host | Provider seam. `createToapisProvider()` shells out to `toapis-gpt-image-2/scripts/generate.py` (edit mode) for real extraction/二创/T恤二创 (`extract`/`recreate`/`applyToTshirt`); `createLocalProvider()` is a no-network passthrough fallback. |
| `lib/workflows.js` | Host | The workflow registry: the one place a workflow is declared and validated at mount. Holds no state. |
| `lib/workflowRunner.js` | Host | Executes a workflow and records every attempt: run records, log capture and caps, one-run-per-workflow, history retention, crash recovery, run params, and the concurrency-guarded provider a workflow is allowed to see. |
| `lib/scheduler.js` | Host | Schedule shapes and arithmetic (interval / daily), the in-process tick, and missed-occurrence detection. Pure time logic plus a timer — no workflow knowledge. |
| `lib/workflowSettings.js` | Host | The settings declaration and its resolver: what a workflow may expose as a knob, and how a stored value resolves to the one actually used (clamped, defaulted, never trusted raw). Its own module because the registry and the definitions both need it and neither may require the other. |
| `lib/printPipeline.js` | Host | 印花流水线: the inbox scan and grouping, the T恤/prompt resolution, the four-step pipeline, its declared settings, the cost estimate, and resume-from-artefacts. The one workflow-specific module; keeping it out of the engine is what lets the engine stay generic. |
| `lib/client.js` | Client | Registers the workbench as a `conversation.view` tab with React; all UI/state calls the host API. Also carries the workflow pages (list + detail), the app-style 成品库 shelf, found by workflow id, and the `shell.overlay` pill that collapses the composer. No image processing here. |
| `cordis.patch.yml` | Patch | Inserts the `ecommerce-workbench` bundle entry. |
| `scripts/backfill-output-fields.js` | Repo tool | One-off, idempotent: names the 款式 on 成品 records written before those fields existed, by looking each shot's composite up in `tshirtRecreations`. Not part of the plugin (`package.json#files` excludes it) — it is a repair tool for the store on disk. |
| `test/host-api.test.js` | Test | Drives the real handler + store through the full extract → recreate → delete → clear lifecycle (with the local provider), plus the workflow engine end to end: config, manual runs, failure, single-flight, scheduling, missed occurrences, retention, crash recovery, and persistence. |
| `test/print-pipeline.test.js` | Test | Drives 印花流水线 through the real handler with a counting provider stub: the 225-call arithmetic, resume-instead-of-repay, the hard ceiling, missing-prompt reporting, the loose-files bucket, upload collision and traversal, approval gating, product deletion, and that deleting a group keeps what it produced. |
| `test/client-render.test.js` | Test | Builds the real client component tree with a minimal React stand-in, covering the 工作流 empty state, list rows, the detail page's three tabs (settings, history, and that each tab's content stays on its own tab), the pipeline panel (group rows, the inline estimate and all four result stages) and the nav/view alignment invariant — the parts a syntax check cannot validate. |
| `docs/DECISION-0001-*.md` | Decision | Owning decision record for the workbench-as-view-tab design. |
| `docs/DECISION-0002-*.md` | Decision | Owning decision record for the workflow engine (why workflows are code, why schedules are two shapes, why misses are skipped). |
| `docs/DECISION-0003-*.md` | Decision | Owning decision record for 印花流水线 (why one group per run, why resume is derived from artefacts, why its products do not go back into the scene pool). |

## Wiring

The package is installed in the web profile as a `file:` dependency, so its
`dsh.bundle.patch` auto-overlays the Cordis config. The client half registers the
workbench as **one view in the conversation view ring** (`conversation.view`,
id `ecom-workbench`) — additive, so the native Chat view and the always-present
composer stay usable. Click the「电商工作台」tab to show the workbench.

### 收起输入框: giving the workbench the composer's height

The workbench wants as much height as it can get, and the conversation composer
sits below it. A small pill — `⌄ 收起输入框` / `⌃ 展开输入框` — hides that composer
and gives the height back.

It registers into the shell's own **`shell.overlay`** slot
(`id: "ecom-composer-toggle"`, `order: 100`), not into the workbench. The composer
belongs to the shell, so once it is collapsed the way back has to be something
that is still on screen — a button inside the workbench would disappear together
with the thing it was meant to restore. `shell.overlay` is documented as a
"frame-wide floating layer, above every column and outside their scroll
containers", **list**-kind (`replaceRisk: none`, so a fresh id sits beside the
shipped entries instead of shadowing them) and click-through per entry.

The collapse itself writes `display: none` onto the element the conversation UI
marks with **`data-composer-seat`** — a hook that package declares itself, not a
hashed CSS class — and puts the previous inline style back on the way out. React
never sets a `style` on that element (it gets `className` and a ref), which is why
this is safe to take; it is the only DOM this plugin touches that it does not own,
and if the attribute ever disappears the pill simply does nothing rather than
breaking the shell. The preference persists in
`localStorage["dsh-ecom-composer-collapsed"]`, and the component restores the
composer when it unmounts (plugin disabled or hot-reloaded) — "no input box and no
button" is the one state worth guarding against.

The client talks to the host over the loopback-fenced `/ecom/api` endpoint using
`fetch`. Only same-machine browsers (`127.0.0.1`/`localhost`) are accepted.

### Deploying an edit: `file:` is a COPY, not a live link

The web profile sets `nodeLinker: hoisted` (`~/.dsh/profiles/web/pnpm-workspace.yaml`),
so pnpm **copies this package's files into
`~/.dsh/profiles/web/node_modules/dsh-ecommerce-workbench-mock`** instead of
symlinking the source directory. Editing files here therefore changes **nothing**
that DSH loads until the copy is refreshed — and restarting `dsh web` just
re-serves the same stale copy, which looks exactly like "my change didn't work".

Worse, a plain re-`add` is a **no-op**: the lockfile records this dependency as
`resolution: {directory: …, type: directory}` with **no version and no integrity
hash**, so pnpm considers it already satisfied and skips the re-copy. Bumping
`version` in `package.json` does not help either.

The only reliable refresh is **remove, then add** (both are the sanctioned
`dsh plugin` entry points — never run npm/pnpm directly under `~/.dsh/profiles/`):

```sh
dsh plugin --profile web remove dsh-ecommerce-workbench-mock
dsh plugin --profile web add file:E:/dsh-workspace/space-1/dsh-ecommerce-workbench
```

Then confirm the copy actually moved before restarting anything — compare the
installed file against the source, e.g. check that a symbol you just added is
present in
`~/.dsh/profiles/web/node_modules/dsh-ecommerce-workbench-mock/lib/client.js`.
Finally restart `dsh web` and hard-refresh (Ctrl+Shift+R).

## Real provider prerequisites

To use real generation, the `toapis-gpt-image-2` skill must be installed with a
configured API key (`TOAPIS_API_KEY`, `~/.toapis_key`, or
`<skill>/scripts/.toapis_key`) and Python on PATH (override with `PYTHON` or
`TOAPIS_SCRIPT`). Each extraction/二创 consumes service credits.

The provider targets `https://toapis.cn` (the old `toapis.xyz` host stopped
resolving; override with `TOAPIS_BASE_URL`). Because the local forward proxy
(`HTTP_PROXY`/`HTTPS_PROXY`) breaks TLS to the ToAPIs host, the provider adds
the ToAPIs host to the child process's `no_proxy` so the request goes direct.

## Verify

- Syntax: `node --check lib/client.js && node --check lib/index.js && node --check lib/store.js && node --check lib/provider.js && node --check lib/workflows.js && node --check lib/workflowSettings.js && node --check lib/workflowRunner.js && node --check lib/scheduler.js && node --check lib/printPipeline.js`
- Tests: `node --test "test/*.test.js"` (**96/96 pass**). (The quoted glob is
  required: `node --test test/` is not usable on this Node/Windows combination —
  it tries to load the directory as a module. The three files can also be listed
  explicitly.)
  - `test/host-api.test.js` (67) covers the original lifecycle — timing-based
    concurrency proofs, partial-failure proofs (one flaky item still leaves the
    rest of the batch intact, using provider stubs), T恤 create/add-images/
    delete/clear, T恤二创 single-pair/cross-product/photo-choice/reject-unknown/
    delete/clear, 场景图管理's paste-and-store pool (one record per image,
    per-image delete taking its bytes, clear, delete/clear staying inside the
    pool while an unknown `kind` is a no-op, newest-first even when the stored
    order is reversed), and importFolder's file-picking + bulk-import +
    unreadable-root cases — plus the workflow engine, driven through an
    **injected registry** so no placeholder workflow has to ship to users:
    definition validation, schedule normalisation and date arithmetic, config
    (enable/schedule/recompute/clear, and that a rejected schedule changes
    nothing), manual runs (logs, summary, durable on settle), failure
    (recorded, handler still serving), single-flight (409 pointing at the run
    already in flight), scheduling (due fires once, not-due and disabled do
    not), a missed occurrence (exactly one 已跳过 entry, nothing executed, the
    schedule moved past it), overlap (skipped ticks counted, no backlog),
    log caps, history retention per workflow, clearing, crash recovery, that a
    workflow's provider calls go through the shared semaphore while
    `withGeneration` is unreachable, and that config + history survive reopening
    the store.
  - `test/print-pipeline.test.js` (17) drives 印花流水线 through the real handler
    with a counting stub provider, so a run's real cost is asserted exactly:
    **一组的 225 次调用** (1 extract + 8 recreate + 24 T恤 + 192 场景, from 4
    prompts × 2, 3 款式, 2 passes × 4), that a second run costs nothing, that a
    run with part of the last stage removed regenerates only the missing items,
    that a forced run pays for a second full pass without discarding the first,
    that the ceiling refuses *before* any call and the same group passes once it
    is raised, that missing/renamed prompts are reported per step, the loose-files
    bucket and its warning, upload collision naming and `../` traversal, approval
    gating a scheduled run (and a manual one needing none), a finished group
    leaving the queue and re-approval re-queuing it, listing/removing products
    with their bytes, deleting a group while keeping its products, and a stale
    T恤 selection falling back to every photo.
  - `test/client-render.test.js` (12) builds the real client component tree with
    a minimal React stand-in, covering both levels of 工作流 (the list, and a
    workflow's page split into its three tabs — the settings tab, and the history
    tab with its runs and log, each asserted not to render the other's content),
    the pipeline group panel (group rows, the 225-call estimate and all four
    result stages rendered *inside the row they belong to* — asserted down to the
    image `src` each stage renders), the 成品库 (one card per 款式, the other shots
    behind the swipe, every Taobao-card line — title, spec, tags, the T恤 — and
    **no price or 销量**, since the shelf has no such data and must not invent it;
    a square stage that contains rather than crops; then the modal: the fixed
    overlay, the 款式 **rail** asserted to be a column and not a bottom strip, one
    entry per 款式, the contact sheet, both arrows, the counter, the
    source/commerce blocks — again down to each part's images; and that clicking a
    card opens the 商品 *on the shot it was showing*), the
    mount-time hydration (a behavioural test, so a module added
    to the load list but missed on the mount path fails here instead of silently
    rendering empty), the `shell.overlay` pill (registered into that slot with an
    id, carrying a label that says what it does, and — walking the click path —
    asking for the collapsed state; the harness also asserts that the slot a
    component registers into is one the bundle actually injected, because a typo
    there leaves the entry dangling while the registration still looks fine), and
    that the nav, `viewNames` and `viewEls` lists cannot
    drift apart (a mismatch shows the wrong view under a nav label, silently and
    only after the insertion point).
- The estimate was also run against this machine's **real** store contents
  (10 prompts, 1 T恤 with 3 photos, 228 scenes) in a throwaway copy: it resolves
  all four prompt names, selects all 3 款式, and reports 1 + 8 + 24 + 192 = 225
  calls with **zero warnings** and nothing generated.
- The suites were run repeatedly (30× host, 8× all three) to confirm they are
  stable. Two races that used to flake are fixed rather than tolerated: the
  generation jobs published `done` before awaiting their `store.update`, and
  `/ecom/api/state` could combine a config snapshot with a separately-taken
  in-memory snapshot and report a finished workflow run as still running.
- Provider: `node -e "const p=require('./lib/provider.js'); console.log(p.defaultScriptPath(), p.hasApiKey())"`
- Config combines (layout-independent, proves the bundle mounts):
  `node "<npm-global>/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile web --dump-config`
  — expect exit 0 and an `id: ecommerce-workbench` entry. (`~/.dsh/tools/dsh-doctor.mjs`
  assumes a DSH **Desktop** layout; on an npm-global install its anchor/`dsh-app-boot`
  checks fail spuriously while the farm and `profiles/` checks still apply.)
- Live: **refresh the profile copy first** (see "Deploying an edit" above —
  `dsh plugin remove` + `add`), then restart `dsh web` (host code changed) and
  hard-refresh the DSH web GUI (Ctrl+Shift+R); the workbench renders and
  `/ecom/api/state` returns persisted data.
  - With no workflow registered, 工作流 shows its empty state — that is the
    expected result, not a broken page. Registering the first workflow is the
    only way to exercise the cards, the schedule pickers and the log panel in a
    real browser.
