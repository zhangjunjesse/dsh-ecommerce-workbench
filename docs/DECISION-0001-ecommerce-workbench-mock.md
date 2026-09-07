# Decision: 电商工作台作为 Web Profile 主界面 Mock

Status: current

## Problem

动态 Cordis 原型需要手动运行，无法满足「DSH 启动后直接进入电商工作台」的产品形态：用户希望打开 DSH 立即看到工作台，而不是看到 Cordis Run 卡片、手动点击运行、进入弹窗或依赖启动后再点击进入。

## Decision

将 Mock 电商工作台打包为可安装的 Web Profile 插件（`dsh-ecommerce-workbench-mock`），借助 bundle patch（`cordis.patch.yml`）自动挂载。客户端把工作台注册为**对话视图环里的一个标签**（`conversation.view`，id `ecom-workbench`），与原生对话（Chat + 底部输入框）**共存而非整屏接管**。

工作台由**真实的 Host API 支撑并持久化**：客户端通过 `fetch` 调 `/ecom/api`（state / extract / recreate / delete / clear / file），Host 半把图片存成文件、把元数据写入 `state.json`（位于 `$DSH_HOME/ecommerce-workbench`）。图片生成为真实调用：`createToapisProvider()` 复用 `toapis-gpt-image-2` 技能的 `scripts/generate.py`（edit 模式）上传参考图 → 建任务 → 轮询 → 下载，接入的是 ToAPIs `gpt-image-2` 服务；当技能脚本或 API Key 不可用时回退到 `createLocalProvider()`（无网络透传），工作台因此始终可用。

第 1 阶段（当前已实现）只做「印花管理」：

- 印花提取：粘贴/上传一张或多张图片 + 提示词提交，每张源图产出**一张**提取印花；结果直接落在印花原图库（结果区），最新的在最前，每行保留源图缩略图与提示词以便追溯；支持单条移除与一键清空。
- 印花二创：从原图库**单选一张**印花，输入提示词、选择风格与输出数量（1 / 2 / 4 / 6），一次生成 N 张二创，作为一行结果（源印花 → N 张二创）；支持删除单张变体与整行。

第 2 阶段新增「T恤二创」（真实生成）与「T恤管理」（纯上传存储，为 T恤二创 提供输入）：

- T恤二创：**T恤和印花都支持多选**（`tshirtIds[]` x `printIds[]`），多选时是**笛卡尔积**——每件选中的T恤都跟每张选中的印花配对生成一次（例如 2 件T恤 x 3 张印花 = 6 次生成），每一对是结果区里独立的一行，每对固定生成 1 张合成图（不再有单独的输出数量选择器，v0.9.3 已去掉；v0.9.4 把单选改成多选+笛卡尔积）。T恤有多张照片时可以逐件选择这次配对用哪一张。Provider 用 edit 模式传两张参考图（T恤照片在先、印花在后），让模型保留T恤的版型/面料/光影，把印花贴合上去。与「印花二创」共用同一套非阻塞 job + 实时进度 + 部分失败容错的实现，只是 `job.total`/`job.done` 统计的是配对数而不是变体数，`job.rows`（不再是单个 `job.row`）收集每一对生成完的行，某一对失败/卡住不影响其余已生成的行。**印花来源是「印花二创」的结果（二创印花），不是印花原图库**：`/ecom/api/tshirtRecreate` 的 `printIds` 在 `state.recreations` 里查找（原先误查 `state.library`，v0.9.2 修正），客户端选择器传入的是 `recreations` 的展平列表，而不是 `library`。
- T恤管理定位为「T恤二创」的输入准备，不是重点模块：左侧导航把「印花提取／印花二创／T恤二创」放在主分组，「T恤管理」单独放在分割线下方的次要分组（字号更小、颜色更淡）。

其余模块（工作台首页 / 场景图管理 / 模特管理 / 产品管理）不在当前阶段范围，后续版本开放。

## Alternatives considered

- 动态 Cordis 插件 + Run 卡片：需手动运行，违背「启动即进入」，已否决。
- **注册进 `conversation.view` 作为视图标签（采纳）**：与原生对话共存、不吞掉对话/输入框。代价是工作台默认不是启动即显示的主界面（对话为默认视图，点「电商工作台」标签切入）；正因需要保持「能与代理对话」，最终采纳此方案。
- 整屏接管 `conversation` 槽位：让工作台成为唯一主界面，但会隐藏原生对话（无对话入口，无法与代理交流），已否决并撤回。
- 弹窗 / overlay 工作台：需要入口按钮，违背产品形态，已否决。
- 收起底部输入框：曾设计一个「收起输入框」按钮来放大工作台。由于对话输入框属于 conversation 外壳、视图无法干净地重渲染，点击不生效，已被**放弃**（用户明确「这个功能先不做」），相关状态不再存在于当前实现。

## Consequences

- 工作台作为对话视图标签（`conversation.view`）与对话共存；原生对话、底部输入框与视图标题栏保持可用，用户可与代理对话。
- 客户端在浏览器内注册 UI 并调用 Host API；Host 半 `lib/index.js` 提供 `/ecom/api` JSON 接口，`lib/store.js` 负责持久化，`lib/provider.js` 是图片服务接缝。仅为同一机器的浏览器放行（`127.0.0.1` / `localhost`）。
- 插件的 `apply` 挂载 `/ecom/api` 路由；删除元数据时连同其拥有的图片字节一起删除，避免文件泄漏。
- 数据持久化到磁盘（`$DSH_HOME/ecommerce-workbench`），刷新网页不丢失；`state.json` 记录元数据，图片按独立文件保存、通过 `/ecom/api/file/<name>` 流式返回。
- 图片生成默认走 ToAPIs（`createToapisProvider`，复用 `toapis-gpt-image-2/scripts/generate.py`）：需要该技能脚本与 API Key，每次提取/二创消耗服务额度；无脚本或 Key 时回退 `createLocalProvider`（透传/复制，不产生网络调用）。因真实生成耗时数十秒，extract/recreate 改为**非阻塞任务**：立即返回 `jobId`，后台生成并通过 `GET /ecom/api/job/<id>` 发布实时进度（stage / done / total），客户端轮询并实时显示（spinner + 阶段 + 已等待时长），完成后把每张结果追加进结果区。
- **「默认启动视图」限制**：`conversation.view` 视图环在 `dsh-client-ui-conversation` 里锚定 `DEFAULT_VIEW_ID = "chat"`（`resolveActiveView` 恒回退到 chat；活动视图 id 存于该插件内部的 `chatStore`，即 `localStorage["dsh.conversation.chat"]`，未对插件暴露 setter）。因此工作台作为**视图标签**打开 DSH 时默认显示对话，需点「电商工作台」标签切入；把工作台变成真正的启动首屏需改动 DSH 外壳（`dsh-client-ui-conversation` 的默认视图行为），而非本插件可独立完成。**用户已明确接受标签模型（保持现状）**：工作台通过点「电商工作台」标签进入，不作为启动首屏，也不再改动 DSH 外壳。
- **批量生成改为并发**，且**单项失败/卡住不再拖垮整批**：印花提取多图、印花二创多张输出，改为宿主端并发调用（默认并发 2，`ECOM_GENERATION_CONCURRENCY` 可调），而非顺序逐张。用真实 ToAPIs 服务实测发现：并发 4 时其中一路会**无限期卡住**（既不成功也不报错，远超正常的 ~50-90s），且当时的实现一旦有一路失败会用 `Promise.all` 语义**整批丢弃**，导致「服务商后台已生成 N 张，工作台却只看到更少/没有」。修复为：并发度降到经验安全值 2；`createToapisProvider` 单次调用超时从 10 分钟降到 4 分钟（`ECOM_PROVIDER_TIMEOUT_MS` 可调），卡住的一路更快失败而非拖住整批；每一项独立 try/catch，只要有一项成功就保留已成功结果、`job.status="done"` 并在 `job.error` 里给出「N 张失败，已保留 M 张成功结果」的非阻塞提示，只有**全部失败**才把 job 标记为 `error`。已在真实服务上复现问题（并发 4 一路卡死）并验证修复（并发 2，count=4 全部成功，`error=null`）。
- **Correction: T恤二创"多选"的单位**。用户先要求「T恤可以多选，印花也可以多选，笛卡尔积生成」，随后澄清多选指的是**一件T恤的多张照片**（正面/背面/细节图），不是多选不同的T恤记录。已按澄清改回：`/ecom/api/tshirtRecreate` 接受单个 `tshirtId` + 该件T恤下可多选的 `tshirtImages[]` + 可多选的 `printIds[]`；笛卡尔积从「多件T恤 x 印花」改为「该件T恤选中的照片 x 选中的印花」。客户端T恤选择器改回单选，选中T恤后展开的照片带改为多选。

## Verification

- `node --check lib/client.js lib/index.js lib/store.js lib/provider.js` → Passed（语法）。
- `node --test test/host-api.test.js` → **27/27 passed**，覆盖 extract → recreate（job 非阻塞、返回 jobId 即时、轮询到 done 拿结果）→ delete（含变体删除后行消失）→ clear 生命周期，及文件随元数据删除、跨 handler 重开持久化、逃逸文件名拒绝、未知 job 返回 404；两条计时用例证明批量确实并发（而非顺序），两条用 flaky provider 证明单项失败仍保留其余成功结果、全部失败才报错；T恤管理生命周期（含多图选择、按 `tshirtImage` 指定照片、伪造文件名被拒）；T恤二创单对/**笛卡尔积**（2T恤x2印花=4 行、断言配对无重复无遗漏）/按 T恤逐件指定照片/拒绝未知T恤或印花/未选择返回 400/删除单个变体后仅该行消失、其余行保留/清空；**回归用例**：`tshirtRecreate` 用只在 `state.library`（原图库）里的印花 id 必须 404 —— 证明选择器只认「印花二创」的结果（二创印花），不认原图库源印花。
- `require('./lib/index.js')` 导出 `{ apply, createHandler, decodeDataUrl }` → Inspected（合法插件形状，Cordis 要求函数或含 `apply` 的对象）。
- 组合体检 `dsh --profile web --dump-config` → Inspected，包含 `ecommerce-workbench` 条目并解析到 `dsh-ecommerce-workbench-mock` 包。
- 浏览器端到端：`/ecom/api/state` 在运行中的 Web GUI 返回真实持久化数据；上传、存储与取回图片字节均确认可用。请在 DSH Web GUI（http://127.0.0.1:3080）硬刷新（Ctrl+Shift+R）确认工作台渲染。
