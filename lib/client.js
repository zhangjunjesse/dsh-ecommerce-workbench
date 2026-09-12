// Browser half of the ecommerce workbench. Registers the workbench into the
// conversation view ring so DSH opens straight into it (no Cordis run card, no
// popup, no manual enter). Ships 印花管理 (印花提取 + 印花二创, real Host API +
// real generation), T恤二创/T恤管理 (composite a print onto a T恤; store a
// T恤's reference photos), 工作流 (enable/schedule/trigger registered workflows
// and read their run logs — the workflows themselves are code, not data),
// 通用工作台 (free-form prompt + references), 提示词管理 (saved prompts) and
// 场景图管理 (paste-and-store scene photos, no generation).
window.__ModuleLoader__.load({
  id: "dsh-ecommerce-workbench-mock",
  factory: function (require) {
    var module = { exports: {} };

    function apply(ctx) {
      var slots = ctx.get("slots");
      if (!slots) return;
      var React = require("react");
      var h = React.createElement;

      // ---------- tiny helpers -------------------------------------------
      var STYLES = ["简约黑白", "国潮插画", "波普撞色", "手绘水彩", "扁平矢量"];
      /** Client-side id for pending uploads only; stored records are id'd by the host. */
      var rid = function () { return Math.random().toString(36).slice(2, 9); };

      // ---------- style helpers (Midjourney-like light / neutral) --------
      var UI = {
        bg: "#fafafb",
        text: "#1c1d1f",
        text2: "#5b5e66",
        border: "#ececf0",
        panel: { background: "#ffffff", border: "1px solid #ececf0", borderRadius: 14, padding: 18, boxShadow: "0 1px 3px rgba(20,20,25,0.04)" },
        card: { background: "#ffffff", border: "1px solid #ececf0", borderRadius: 12, overflow: "hidden" },
        btnPrimary: { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 10, border: "1px solid #1c1d1f", background: "#1c1d1f", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 },
        btnGhost: { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 10, border: "1px solid #e5e5ea", background: "#ffffff", color: "#3f4145", cursor: "pointer", fontSize: 13 },
        chip: { padding: "5px 12px", borderRadius: 999, border: "1px solid #e5e5ea", background: "#f5f5f7", color: "#5b5e66", cursor: "pointer", fontSize: 12.5 },
        chipOn: { padding: "5px 12px", borderRadius: 999, border: "1px solid #1c1d1f", background: "#1c1d1f", color: "#fff", cursor: "pointer", fontSize: 12.5, fontWeight: 600 },
        muted: { color: "#8a8d94", fontSize: 12.5 }
      };

      // ---------- host API (durable store lives on the node half) ---------
      var API = "/ecom/api";
      function apiGet(path) {
        return fetch(API + path).then(function (r) { return r.json(); });
      }
      function apiPost(path, body) {
        return fetch(API + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {})
        }).then(function (r) { return r.json(); });
      }
      /** Stored image URL for a file name handed out by the host. */
      function fileUrl(fileName) { return API + "/file/" + encodeURIComponent(fileName); }
      /** Job-start endpoint per generation kind (see the host /ecom/api routes). */
      var JOB_PATHS = { extract: "/extract", recreate: "/recreate", tshirtRecreate: "/tshirtRecreate", generate: "/generate" };
      /** Read one File/Blob as a base64 data URL the host can decode. */
      function readAsDataUrl(file) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () { resolve(String(reader.result)); };
          reader.onerror = function () { reject(reader.error); };
          reader.readAsDataURL(file);
        });
      }

      // ---------- layout: bound the shell's view area ----------------------
      // The conversation shell scrolls `.scrollBody`, and while a session is
      // active it overrides its view area to `flex: 1 0 auto; min-height: auto`
      // — content-sized and non-shrinkable, which is right for Chat (messages
      // grow, the shell scrolls) but wrong for a view that scrolls internally.
      // Because that ancestor is then indefinite-height, a percentage height on
      // the workbench collapses to `auto`, so the whole workbench — left nav and
      // composer included — grows and rides the shell's scroller.
      //
      // Re-bind the ancestors hosting this workbench back to a shrinkable,
      // definite height. This is done in JS by walking UP from the workbench
      // root to the nearest scrollable ancestor rather than with a CSS selector:
      // the shell wraps each slot in `data-slot` elements that use
      // `display: contents`, so the workbench's DOM parent is NOT the flex item
      // that grows (`:has(> .root)` binds the contents wrapper, where flex
      // properties do nothing) and the wrapper depth is not fixed.
      var ECOM_ROOT_CLASS = "dsh-ecom-root";
      var LAYOUT_STYLE_INJECTED = false;
      function injectLayoutStyle() {
        if (LAYOUT_STYLE_INJECTED || typeof document === "undefined") return;
        LAYOUT_STYLE_INJECTED = true;
        var el = document.createElement("style");
        el.dataset.dshEcomLayout = "1";
        el.textContent = "." + ECOM_ROOT_CLASS + "{height:100%;min-height:0;}";
        document.head.appendChild(el);
      }
      /**
       * Bound every box-generating ancestor between `el` and the scroll
       * container, so the workbench fills the visible area and scrolls its own
       * results list. Returns a function restoring the previous inline styles
       * (the shell needs its growing view area back for Chat).
       */
      function bindLayoutAncestors(el) {
        if (!el || typeof window === "undefined") return function () {};
        var boxes = [];
        var node = el.parentElement;
        var scroller = null;
        while (node) {
          var cs = window.getComputedStyle(node);
          if (cs.overflowY === "auto" || cs.overflowY === "scroll") { scroller = node; break; }
          // `display: contents` elements generate no box; styling them is a no-op.
          if (cs.display !== "contents") boxes.push(node);
          node = node.parentElement;
        }
        if (scroller === null) return function () {};
        var saved = boxes.map(function (n) {
          var prev = { node: n, flex: n.style.flex, minHeight: n.style.minHeight, overflow: n.style.overflow, height: n.style.height };
          n.style.flex = "1 1 0";
          n.style.minHeight = "0";
          n.style.overflow = "hidden";
          return prev;
        });
        return function () {
          saved.forEach(function (p) {
            p.node.style.flex = p.flex;
            p.node.style.minHeight = p.minHeight;
            p.node.style.overflow = p.overflow;
            p.node.style.height = p.height;
          });
        };
      }

      // ---------- live-progress helpers (real generation is slow) --------
      // Real generation takes tens of seconds per batch. The submit returns a
      // jobId immediately and the client polls it, so the wait shows a live
      // stage + elapsed timer + done/total instead of a silent "生成中…". These
      // are the shared pieces both flows use.
      var SPINNER_STYLE_INJECTED = false;
      function injectSpinnerStyle() {
        if (SPINNER_STYLE_INJECTED || typeof document === "undefined") return;
        SPINNER_STYLE_INJECTED = true;
        var el = document.createElement("style");
        el.textContent = "@keyframes dshSpin{to{transform:rotate(360deg)}}";
        document.head.appendChild(el);
      }
      function Spinner() {
        return h("span", {
          style: {
            display: "inline-block", width: 12, height: 12, borderRadius: "50%",
            border: "2px solid #e2e2e6", borderTopColor: "#1c1d1f",
            animation: "dshSpin .8s linear infinite", verticalAlign: "middle", flex: "0 0 auto"
          }
        });
      }
      function fmtElapsed(seconds) {
        var m = Math.floor(seconds / 60);
        var s = Math.floor(seconds % 60);
        return m + ":" + (s < 10 ? "0" : "") + s;
      }
      function pad2(n) { return (n < 10 ? "0" : "") + n; }
      /** Absolute stamp for a stored timestamp: 「09-10 23:47」, or 「—」 when there is none. */
      function fmtStamp(ms) {
        if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "—";
        var d = new Date(ms);
        var stamp = pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
        return d.getFullYear() === new Date().getFullYear() ? stamp : d.getFullYear() + "-" + stamp;
      }
      /** Wall clock with seconds — log lines are read in sequence, so minutes are not enough. */
      function fmtClock(ms) {
        if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "--:--:--";
        var d = new Date(ms);
        return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
      }
      /** How long a run took, in units a person reads at a glance. */
      function fmtDuration(ms) {
        if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "—";
        if (ms < 1000) return ms + " 毫秒";
        var seconds = ms / 1000;
        if (seconds < 60) return (Math.round(seconds * 10) / 10) + " 秒";
        return Math.floor(seconds / 60) + " 分 " + Math.round(seconds % 60) + " 秒";
      }
      /** Human summary of a stored schedule; null means "manual only". */
      function fmtSchedule(schedule) {
        if (!schedule) return "仅手动";
        if (schedule.type === "interval") {
          var minutes = Number(schedule.everyMinutes) || 0;
          if (minutes > 0 && minutes % 60 === 0) return "每 " + (minutes / 60) + " 小时";
          return "每 " + minutes + " 分钟";
        }
        if (schedule.type === "daily") return "每天 " + schedule.atTime;
        return "仅手动";
      }
      /** Status pill text/colour for a workflow's last outcome. */
      function workflowStatus(lastStatus, running) {
        if (running) return { text: "运行中", color: "#1f5fa9", bg: "#eef4fd" };
        if (lastStatus === "success") return { text: "成功", color: "#1c7a4a", bg: "#eaf7f0" };
        if (lastStatus === "failed") return { text: "失败", color: "#b23c2e", bg: "#fdf1f0" };
        if (lastStatus === "skipped") return { text: "已跳过", color: "#8a6d1f", bg: "#fdf6e3" };
        return { text: "尚未运行", color: "#8a8d94", bg: "#f5f5f7" };
      }
      function runStatusLabel(status) {
        if (status === "running") return "运行中";
        if (status === "success") return "成功";
        if (status === "failed") return "失败";
        if (status === "skipped") return "已跳过";
        return status || "";
      }
      function runStatusColor(status) {
        if (status === "success") return "#1c7a4a";
        if (status === "failed") return "#b23c2e";
        if (status === "skipped") return "#8a6d1f";
        if (status === "running") return "#1f5fa9";
        return UI.text2;
      }
      function triggerLabel(trigger) {
        return trigger === "schedule" ? "周期" : "手动";
      }
      function stageLabel(stage) {
        if (stage === "queued") return "已提交";
        if (stage === "uploading") return "正在上传参考图";
        if (stage === "generating") return "正在生成印花";
        if (stage === "downloading") return "正在下载";
        if (stage === "done") return "已完成";
        return "处理中";
      }
      /** Same variant-picking rule as the host's `pickRepresentativeFile`, ported
       * to the browser so a folder picked via native dialog can be reduced to one
       * representative image per product without a round trip. */
      function pickRepresentativeFileClient(fileNames) {
        var byPattern = function (re) { return fileNames.filter(function (f) { return re.test(f); })[0]; };
        return (
          byPattern(/under5mb/i) ||
          byPattern(/transparent_clean\.(png|jpe?g|webp)$/i) ||
          byPattern(/composite/i) ||
          fileNames.slice().sort()[0]
        );
      }
      /**
       * Toolbar control that bulk-imports already-finished prints from a local
       * folder tree (one subfolder per product, each holding a 印花/print
       * subfolder) straight into 印花二创's results — no generation, no
       * re-running work already done outside the workbench.
       *
       * Click "导入文件夹" → click "选择文件夹" → the OS folder dialog opens.
       * There is no path to type: browsers never hand back an absolute
       * filesystem path from that dialog (a platform restriction), so the
       * picked files are read in the browser and uploaded directly — one
       * representative image per product subfolder.
       */
      function ImportFolderButton(props) {
        var openState = React.useState(false);
        var open = openState[0]; var setOpen = openState[1];
        var busyState = React.useState(false);
        var busy = busyState[0]; var setBusy = busyState[1];
        var resultState = React.useState(null); // {imported, skipped} | {error}
        var result = resultState[0]; var setResult = resultState[1];
        var fileInputRef = React.useRef(null);
        var pickerSupported = typeof document !== "undefined" && "webkitdirectory" in document.createElement("input");

        function applyResult(res) {
          setBusy(false);
          if (!res || res.ok !== true) { setResult({ error: (res && res.error) || "导入失败" }); return; }
          setResult({ imported: res.imported.length, skipped: res.skipped.length, skippedList: res.skipped });
          if (res.imported.length > 0 && props.onImported) props.onImported(res.imported);
        }

        /** Reduce the picked file list to one representative image per product
         * subfolder (any folder under the picked root whose own subfolder is
         * named/labelled 印花 or "print"), then upload just those. */
        function onPickFolder(e) {
          var files = Array.prototype.slice.call(e.target.files || []);
          e.target.value = "";
          if (files.length === 0) return;
          var groups = {};
          files.forEach(function (f) {
            var rel = f.webkitRelativePath || f.name;
            var segs = rel.split("/");
            if (segs.length < 3 || !/\.(png|jpe?g|webp|gif)$/i.test(f.name)) return;
            var product = segs[1];
            var underPrintFolder = segs.slice(2, segs.length - 1).some(function (s) {
              return s === "印花" || s.indexOf("印花") !== -1 || /print/i.test(s);
            });
            if (!underPrintFolder) return;
            (groups[product] = groups[product] || []).push(f);
          });
          var products = Object.keys(groups);
          if (products.length === 0) {
            setResult({ error: "所选文件夹里没有找到「产品/印花/图片」这样的结构" });
            return;
          }
          setBusy(true);
          setResult(null);
          var picks = products.map(function (product) {
            var names = groups[product].map(function (f) { return f.name; });
            var chosenName = pickRepresentativeFileClient(names);
            var chosenFile = groups[product].filter(function (f) { return f.name === chosenName; })[0];
            return { product: product, file: chosenFile };
          });
          Promise.all(picks.map(function (p) {
            return readAsDataUrl(p.file).then(function (dataUrl) {
              return { product: p.product, fileName: p.file.name, dataUrl: dataUrl };
            });
          })).then(function (items) {
            return apiPost("/importFiles", { items: items });
          }).then(applyResult, function (err) {
            setBusy(false);
            setResult({ error: String((err && err.message) || err) });
          });
        }

        if (!open) {
          return h("button", { style: Object.assign({}, UI.btnGhost, { display: "flex", alignItems: "center", gap: 5 }), onClick: function () { setOpen(true); }, title: "从本地文件夹批量导入已有印花" },
            IconFolder(13), "导入文件夹");
        }
        return h("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
          h("input", { ref: fileInputRef, type: "file", webkitdirectory: "true", directory: "true", multiple: true, onChange: onPickFolder, style: { display: "none" } }),
          pickerSupported
            ? h("button", { style: Object.assign({}, UI.btnPrimary, { padding: "6px 12px" }, busy ? { opacity: 0.4, cursor: "not-allowed" } : {}), disabled: busy, onClick: function () { if (fileInputRef.current) fileInputRef.current.click(); } },
                busy ? "导入中…" : "选择文件夹")
            : h("span", { style: { fontSize: 12, color: "#b23c2e" } }, "当前浏览器不支持选择文件夹"),
          h("button", { style: UI.btnGhost, onClick: function () { setOpen(false); setResult(null); } }, "取消"),
          result ? h("span", { style: { fontSize: 12, color: result.error ? "#b23c2e" : "#5b5e66" } },
            result.error || ("已导入 " + result.imported + " 个" + (result.skipped > 0 ? "，跳过 " + result.skipped + " 个" : ""))) : null);
      }
      /** Prepend `fresh` records to `prev`, skipping records already present (by id). */
      function mergePrints(prev, fresh) {
        var seen = {};
        prev.forEach(function (p) { seen[p.id] = true; });
        var add = (fresh || []).filter(function (p) { return !seen[p.id]; });
        return add.concat(prev);
      }
      /** Sort outputs newest-first by creation time (newest at the top). */
      function byNewest(a, b) {
        return (b && b.createdAt || 0) - (a && a.createdAt || 0);
      }
      /** A persistent in-progress card shown in the results feed once a job is
       * submitted, so the task stays visible while it runs and even after you
       * switch tabs (the views stay mounted, so this survives). Skeleton thumb +
       * title/subtitle + live stage/done/total/elapsed. */
      function PendingRow(props) {
        var j = props.job;
        var stage = j.stage || "queued"; var done = j.done || 0; var total = j.total || 1;
        var age = Math.max(0, Math.floor((Date.now() - (j.start || Date.now())) / 1000));
        var countText = total > 1 ? (" · " + done + "/" + total) : "";
        var failed = j.status === "error";
        return h("div", { style: { display: "flex", alignItems: "center", gap: 16, padding: 12, background: "#ffffff", border: "1px solid #ececf0", borderRadius: 14 } },
          h("div", { style: { width: 72, height: 72, flex: "0 0 auto", borderRadius: 10, background: "#eef0f2", border: "1px solid #ececf0", display: "flex", alignItems: "center", justifyContent: "center" } },
            failed ? IconClose(18) : Spinner()),
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { color: failed ? "#b23c2e" : UI.text, fontSize: 13, fontWeight: 500 } }, failed ? "生成失败" : (j.title || "生成中")),
            j.subtitle ? h("div", { style: { color: "#5b5e66", fontSize: 12.5, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, j.subtitle) : null,
            failed
              ? (j.error ? h("div", { style: { color: "#b23c2e", fontSize: 12, marginTop: 3 } }, j.error) : null)
              : h("div", { style: { display: "flex", alignItems: "center", gap: 8, color: "#8a8d94", fontSize: 12, marginTop: 3 } },
                  h("span", null, stageLabel(stage) + countText),
                  h("span", null, "已等待 " + fmtElapsed(age)))));
      }

      // ---------- click-to-enlarge lightbox --------------------------------
      var ZOOM_STYLE_INJECTED = false;
      function injectZoomHoverStyle() {
        if (ZOOM_STYLE_INJECTED || typeof document === "undefined") return;
        ZOOM_STYLE_INJECTED = true;
        var el = document.createElement("style");
        el.textContent = ".dsh-thumb-zoom:hover{box-shadow:inset 0 0 0 999px rgba(0,0,0,.12);}";
        document.head.appendChild(el);
      }
      /** Full-screen preview for one image; closes on backdrop click or Escape. */
      function Lightbox(props) {
        var image = props.image;
        React.useEffect(function () {
          if (!image) return undefined;
          function onKey(e) { if (e.key === "Escape") props.onClose(); }
          document.addEventListener("keydown", onKey);
          return function () { document.removeEventListener("keydown", onKey); };
        }, [image]);
        if (!image) return null;
        return h("div", {
          onClick: props.onClose,
          style: {
            position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000,
            background: "rgba(20,20,22,0.82)", display: "flex", alignItems: "center", justifyContent: "center",
            padding: 40, cursor: "zoom-out"
          }
        },
          h("img", { src: image.src, alt: image.label || "", onClick: function (e) { e.stopPropagation(); }, style: { maxWidth: "100%", maxHeight: "100%", borderRadius: 8, boxShadow: "0 20px 60px rgba(0,0,0,.5)", cursor: "default", display: "block" } }),
          h("button", {
            onClick: props.onClose, title: "关闭",
            style: { position: "fixed", top: 20, right: 24, width: 40, height: 40, borderRadius: 999, border: "1px solid rgba(255,255,255,.25)", background: "rgba(255,255,255,.1)", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }
          }, IconClose(18)));
      }

      /** Copy `text` to the clipboard; falls back to a hidden textarea + execCommand
       * when the async Clipboard API is unavailable (older/insecure contexts). */
      function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
        }
        fallbackCopy(text);
        return Promise.resolve();
      }
      function fallbackCopy(text) {
        try {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        } catch (e) { /* clipboard unavailable; nothing more we can do */ }
      }
      /** Destructive actions ask for a second confirmation before they run. */
      function confirmAction(message) {
        return typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(message) : true;
      }
      /** One-click copy for a displayed prompt; briefly shows a check mark. */
      function CopyButton(props) {
        var copiedState = React.useState(false);
        var copied = copiedState[0]; var setCopied = copiedState[1];
        var text = props.text || "";
        function onClick(e) {
          e.stopPropagation();
          if (!text) return;
          copyText(text).then(function () {
            setCopied(true);
            setTimeout(function () { setCopied(false); }, 1200);
          });
        }
        return h("button", {
          type: "button", title: copied ? "已复制" : "复制提示词", onClick: onClick,
          style: {
            flex: "0 0 auto", width: 22, height: 22, marginTop: 2, borderRadius: 6, border: "1px solid #ececf0",
            background: copied ? "#eef7ee" : "#f5f5f7", color: copied ? "#2f8a3e" : "#5b5e66",
            cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center"
          }
        }, copied ? IconCheck(11) : IconCopy(12));
      }

      // A square image tile. `src` renders real bytes; without it the tile is a
      // neutral placeholder (used while a pasted file is still being read).
      // When `onZoom` is given and a real image is present, the tile opens the
      // shared lightbox on click (this is the only click meaning for a plain
      // Thumb; callers that also need click-to-select, like the 二创 picker,
      // must not pass onZoom and should add their own zoom affordance instead).
      function Thumb(cfg) {
        var size = cfg.size || 56;
        var clickable = typeof cfg.onZoom === "function" && !!cfg.src;
        if (clickable) injectZoomHoverStyle();
        return h("div", {
          className: clickable ? "dsh-thumb-zoom" : undefined,
          onClick: clickable ? function (e) { e.stopPropagation(); cfg.onZoom({ src: cfg.src, label: cfg.label || "" }); } : undefined,
          style: {
            width: size, height: size, flex: "0 0 auto", borderRadius: Math.max(8, size / 6),
            background: "#f2f2f4", position: "relative", overflow: "hidden", border: "1px solid #ececf0",
            cursor: clickable ? "zoom-in" : undefined
          }
        }, cfg.src
          ? h("img", { src: cfg.src, alt: cfg.label || "", style: { width: "100%", height: "100%", objectFit: "cover", display: "block" } })
          : null);
      }

      // ---------- inline SVG icons (no emoji) -----------------------------
      function Icon(path, size, strokeWidth) {
        return h("svg", { width: size || 16, height: size || 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: strokeWidth || 1.8, strokeLinecap: "round", strokeLinejoin: "round" }, path);
      }
      function IconUpload(size) {
        return Icon([
          h("rect", { key: "r", x: 3, y: 3, width: 18, height: 18, rx: 4 }),
          h("circle", { key: "c", cx: 9, cy: 9, r: 1.6, fill: "currentColor", stroke: "none" }),
          h("path", { key: "p", d: "M21 15l-5.2-5.2a2 2 0 0 0-2.8 0L4 19" })
        ], size);
      }
      function IconSettings(size) {
        return Icon([
          h("circle", { key: "c", cx: 12, cy: 12, r: 3.2 }),
          h("path", { key: "p", d: "M19.4 13.5a7.6 7.6 0 0 0 0-3l1.9-1.4-2-3.4-2.2.7a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.4a7.6 7.6 0 0 0-2.6 1.5l-2.2-.7-2 3.4L4.6 10.5a7.6 7.6 0 0 0 0 3L2.7 15l2 3.4 2.2-.7a7.6 7.6 0 0 0 2.6 1.5l.5 2.3h4l.5-2.3a7.6 7.6 0 0 0 2.6-1.5l2.2.7 2-3.4z" })
        ], size);
      }
      function IconArrowRight(size) {
        return Icon([h("path", { key: "p", d: "M5 12h14M13 6l6 6-6 6" })], size);
      }
      function IconClose(size) {
        return Icon([h("path", { key: "p", d: "M6 6l12 12M18 6L6 18" })], size, 2);
      }
      function IconCheck(size) {
        return Icon([h("path", { key: "p", d: "M5 12.5l4.5 4.5L19 7" })], size, 2.2);
      }
      function IconTrash(size) {
        return Icon([
          h("path", { key: "a", d: "M4 7h16" }),
          h("path", { key: "b", d: "M9 7V4h6v3" }),
          h("path", { key: "c", d: "M6 7l1 13h10l1-13" }),
          h("path", { key: "d", d: "M10 11v6M14 11v6" })
        ], size);
      }
      function IconLayers(size) {
        return Icon([
          h("path", { key: "a", d: "M12 3l9 5-9 5-9-5 9-5z" }),
          h("path", { key: "b", d: "M3 13l9 5 9-5" })
        ], size);
      }
      function IconWand(size) {
        return Icon([
          h("path", { key: "a", d: "M4 20L18 6" }),
          h("path", { key: "b", d: "M15 3l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2z" }),
          h("path", { key: "c", d: "M5 13l.6 1.4L7 15l-1.4.6L5 17l-.6-1.4L3 15l1.4-.6z" })
        ], size, 1.6);
      }
      function IconSparkle(size) {
        return Icon([
          h("path", { key: "a", d: "M12 3l1.6 4.7L18 9l-4.4 1.3L12 15l-1.6-4.7L6 9l4.4-1.3z" }),
          h("path", { key: "b", d: "M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" })
        ], size, 1.6);
      }
      function IconZoom(size) {
        return Icon([
          h("circle", { key: "c", cx: 10, cy: 10, r: 6.5 }),
          h("path", { key: "l", d: "M20 20l-5.5-5.5" })
        ], size, 2);
      }
      function IconCopy(size) {
        return Icon([
          h("rect", { key: "a", x: 8, y: 8, width: 12, height: 12, rx: 2 }),
          h("path", { key: "b", d: "M4 16V6a2 2 0 0 1 2-2h10" })
        ], size);
      }
      function IconFolder(size) {
        return Icon([
          h("path", { key: "a", d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" })
        ], size);
      }
      function IconBox(size) {
        return Icon([
          h("path", { key: "a", d: "M3 8l9-5 9 5-9 5-9-5z" }),
          h("path", { key: "b", d: "M3 8v8l9 5 9-5V8" }),
          h("path", { key: "c", d: "M12 13v8" })
        ], size);
      }
      function IconShirt(size) {
        return Icon([
          h("path", { key: "a", d: "M8 4L4 7l2 3 2-1v9h8v-9l2 1 2-3-4-3-2 2h-4z" })
        ], size);
      }
      function IconImage(size) {
        return Icon([
          h("rect", { key: "a", x: 3, y: 4, width: 18, height: 16, rx: 3 }),
          h("circle", { key: "b", cx: 8.5, cy: 9.5, r: 1.7 }),
          h("path", { key: "c", d: "M4 17l4.7-4.7a2 2 0 0 1 2.8 0L16 17" }),
          h("path", { key: "d", d: "M14.5 15.5l1.6-1.6a2 2 0 0 1 2.8 0L21 16" })
        ], size, 1.6);
      }
      function IconPlus(size) {
        return Icon([h("path", { key: "p", d: "M12 5v14M5 12h14" })], size, 2);
      }
      function IconBookmark(size) {
        return Icon([h("path", { key: "p", d: "M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" })], size, 1.6);
      }
      function IconSpark(size) {
        return Icon([
          h("path", { key: "a", d: "M12 3l2.2 5.4L20 10.5l-5.8 2.1L12 18l-2.2-5.4L4 10.5l5.8-2.1z" }),
          h("path", { key: "b", d: "M18.5 16.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" })
        ], size, 1.5);
      }
      function IconEdit(size) {
        return Icon([h("path", { key: "p", d: "M4 20l1-4L16.5 4.5a2 2 0 0 1 2.8 0l.7.7a2 2 0 0 1 0 2.8L9 19l-4 1z" })], size, 1.6);
      }
      function IconReplay(size) {
        return Icon([
          h("path", { key: "a", d: "M3 12a9 9 0 1 0 3-6.7" }),
          h("path", { key: "b", d: "M3 4v5h5" })
        ], size, 1.8);
      }
      function IconFlow(size) {
        return Icon([
          h("rect", { key: "a", x: 3, y: 3, width: 6.5, height: 5.5, rx: 1.6 }),
          h("rect", { key: "b", x: 14.5, y: 15.5, width: 6.5, height: 5.5, rx: 1.6 }),
          h("path", { key: "c", d: "M9.5 5.75h4a3.5 3.5 0 0 1 3.5 3.5v6.25" })
        ], size, 1.6);
      }

      function IconGallery(size) {
        return Icon([
          h("rect", { key: "a", x: 3, y: 7, width: 14, height: 13, rx: 2 }),
          h("path", { key: "b", d: "M6.5 7V5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2V14a2 2 0 0 1-2 2h-1" }),
          h("circle", { key: "c", cx: 7.6, cy: 11.4, r: 1.3 }),
          h("path", { key: "d", d: "M4 17.5l3.4-3.4a1.6 1.6 0 0 1 2.3 0L13 17.5" })
        ], size, 1.6);
      }

      // ---------- saved-prompt quick picker + manager ----------------------
      /** A small bookmark button in each composer; opens a menu of saved prompts,
       * and picking one fills the composer's prompt via `onPick(text)`. */
      function PromptPicker(props) {
        var prompts = props.prompts || [];
        var onPick = props.onPick;
        var openState = React.useState(false);
        var open = openState[0]; var setOpen = openState[1];
        var btnRef = React.useRef(null);
        var dropRef = React.useRef(null);
        var posState = React.useState({ top: 0, left: 0 });
        var pos = posState[0]; var setPos = posState[1];
        React.useEffect(function () {
          if (!open) return undefined;
          function onDoc(e) {
            var inBtn = btnRef.current && btnRef.current.contains(e.target);
            var inDrop = dropRef.current && dropRef.current.contains(e.target);
            if (!inBtn && !inDrop) setOpen(false);
          }
          document.addEventListener("mousedown", onDoc);
          return function () { document.removeEventListener("mousedown", onDoc); };
        }, [open]);
        function toggle() {
          if (!open) {
            var r = btnRef.current && btnRef.current.getBoundingClientRect();
            if (r) {
              // Open downward below the button, keep inside the viewport so it is
              // never clipped by the workbench's overflow or hidden behind the
              // DSH top/right chrome. `position: fixed` escapes the shell's
              // overflow:hidden ancestors.
              var left = Math.max(8, Math.min(r.left, window.innerWidth - 252));
              setPos({ top: r.bottom + 6, left: left });
            }
          }
          setOpen(!open);
        }
        return h("div", { ref: btnRef, style: { position: "relative", flex: "0 0 auto" } },
          h("button", { title: "选择提示词", onClick: toggle, style: { flex: "0 0 auto", width: 34, height: 34, borderRadius: 9, border: 0, background: open ? "#eceef1" : "transparent", color: open ? UI.text : UI.text2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" } }, IconBookmark(16)),
          open ? h("div", { ref: dropRef, style: { position: "fixed", top: pos.top, left: pos.left, zIndex: 3000, width: 240, maxHeight: 320, overflow: "auto", background: "#fff", border: "1px solid #ececf0", borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,.2)", padding: 6 } },
            prompts.length === 0
              ? h("div", { style: { ...UI.muted, padding: "10px 12px", fontSize: 12.5 } }, "暂无提示词，去「提示词管理」添加")
              : prompts.slice().sort(byNewest).map(function (p) {
                  return h("button", { key: p.id, onClick: function () { onPick(p.text); setOpen(false); }, style: { display: "block", width: "100%", textAlign: "left", padding: "8px 10px", borderRadius: 8, border: 0, background: "transparent", color: UI.text, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, lineHeight: "19px" } },
                    h("div", { style: { fontWeight: 500, color: UI.text } }, p.name || "提示词"),
                    h("div", { style: { ...UI.muted, fontSize: 11.5, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p.text));
                })) : null);
      }

      /** 提示词管理: create / edit / delete / clear the saved common prompts. */
      function PromptManager(props) {
        var prompts = props.prompts; var setPrompts = props.setPrompts;
        var nameState = React.useState("");
        var name = nameState[0]; var setName = nameState[1];
        var textState = React.useState("");
        var text = textState[0]; var setText = textState[1];
        var editIdState = React.useState(null);
        var editId = editIdState[0]; var setEditId = editIdState[1];
        var errorState = React.useState("");
        var error = errorState[0]; var setError = errorState[1];

        function startEdit(p) { setName(p.name); setText(p.text); setEditId(p.id); }
        function cancelEdit() { setName(""); setText(""); setEditId(null); setError(""); }
        function save() {
          if (name.trim() === "" || text.trim() === "") { setError("请填写名称和内容"); return; }
          setError("");
          var body = { name: name.trim(), text: text.trim() };
          if (editId) body.id = editId;
          apiPost("/prompt", body).then(function (res) {
            if (!res || res.ok !== true) { setError((res && res.error) || "保存失败"); return; }
            if (editId) {
              setPrompts(function (prev) { return prev.map(function (p) { return p.id === editId ? res.prompt : p; }); });
              cancelEdit();
            } else {
              setPrompts(function (prev) { return [res.prompt].concat(prev); });
              setName(""); setText("");
            }
          }, function (err) { setError(String((err && err.message) || err)); });
        }
        function remove(p) {
          if (!confirmAction("确定删除提示词「" + (p.name || p.text || "") + "」？")) return;
          apiPost("/delete", { kind: "prompt", id: p.id });
          setPrompts(function (prev) { return prev.filter(function (x) { return x.id !== p.id; }); });
          if (editId === p.id) cancelEdit();
        }
        function clearAll() {
          if (!confirmAction("确定清空所有提示词？")) return;
          apiPost("/clear", { kind: "prompts" });
          setPrompts([]);
          cancelEdit();
        }

        var form = h("div", { style: { flex: "0 0 auto", width: "100%", margin: "0 0 16px" } },
          h("div", { style: { border: "1px solid #ececf0", borderRadius: 14, background: "#ffffff", padding: "12px 14px", boxShadow: "0 1px 6px rgba(20,20,25,0.04)" } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
              h("input", { value: name, onChange: function (e) { setName(e.target.value); }, placeholder: "名称，如「去背景」", style: { flex: "0 0 38%", minWidth: 0, border: "1px solid #e5e5ea", outline: 0, borderRadius: 9, padding: "8px 10px", fontSize: 13, color: UI.text, background: "#fff", boxSizing: "border-box" } }),
              h("input", { value: text, onChange: function (e) { setText(e.target.value); }, placeholder: "提示词内容", style: { flex: 1, minWidth: 0, border: "1px solid #e5e5ea", outline: 0, borderRadius: 9, padding: "8px 10px", fontSize: 13, color: UI.text, background: "#fff", boxSizing: "border-box" } }),
              h("button", { onClick: cancelEdit, style: Object.assign({}, UI.btnGhost, { flex: "0 0 auto", display: editId ? "inline-flex" : "none" }) }, "取消"),
              h("button", { onClick: save, style: Object.assign({}, UI.btnPrimary, { flex: "0 0 auto" }) }, editId ? "更新" : "保存")),
            error ? h("div", { style: { flex: "0 0 auto", marginTop: 8, fontSize: 12.5, color: "#b23c2e" } }, error) : null));

        var toolbar = prompts.length > 0 ? h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", margin: "2px 2px 10px" } },
          h("span", { style: { ...UI.muted } }, prompts.length + " 条"),
          h("button", { style: Object.assign({}, UI.btnGhost, { display: "flex", alignItems: "center", gap: 5 }), onClick: clearAll },
            IconTrash(13), "清空")) : null;

        var list;
        if (prompts.length > 0) {
          list = h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 10, padding: "4px 4px 12px" } },
            prompts.slice().sort(byNewest).map(function (p) {
              return h("div", { key: p.id, style: { display: "flex", alignItems: "flex-start", gap: 12, padding: 12, background: "#ffffff", border: "1px solid #ececf0", borderRadius: 14 } },
                h("div", { style: { flex: 1, minWidth: 0 } },
                  h("div", { style: { color: UI.text, fontSize: 13, fontWeight: 500 } }, p.name || "提示词"),
                  h("div", { style: { ...UI.muted, fontSize: 12.5, marginTop: 3, whiteSpace: "pre-wrap", wordBreak: "break-word" } }, p.text)),
                h("div", { style: { display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto", marginTop: 2 } },
                  h("button", { title: "编辑", onClick: function () { startEdit(p); }, style: { flex: "0 0 auto", width: 30, height: 30, borderRadius: 8, border: "1px solid #ececf0", background: "#f5f5f7", color: UI.text2, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconEdit(14)),
                  h("button", { title: "复制", onClick: function (e) { e.stopPropagation(); copyText(p.text); }, style: { flex: "0 0 auto", width: 30, height: 30, borderRadius: 8, border: "1px solid #ececf0", background: "#f5f5f7", color: UI.text2, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconCopy(13)),
                  h("button", { title: "删除", onClick: function () { remove(p); }, style: { flex: "0 0 auto", width: 30, height: 30, borderRadius: 8, border: "1px solid #ececf0", background: "#f5f5f7", color: UI.text2, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconTrash(14))));
            }));
        } else {
          list = h("div", { style: { flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" } },
            h("div", { style: { ...UI.muted, textAlign: "center", padding: "0 24px" } }, "暂无提示词。添加一个你常用的，就能在印花提取 / 印花二创 / T恤二创里一键填入。"));
        }

        return h("div", { style: { flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" } },
          form, toolbar, list);
      }

      // ---------- 工作流 ---------------------------------------------------
      /**
       * The settings block of a workflow's detail page: whether it is on, when
       * it runs next, and how to trigger it by hand.
       *
       * It owns only its own text box. Everything else is the host's, read from
       * the workflow view the host merged (registry definition + stored config +
       * live state) and written straight back to it — there is no local copy of
       * a schedule to drift out of step with the one the scheduler is using.
       */
      function WorkflowSettingsCard(props) {
        var w = props.workflow;
        var schedule = w.schedule || null;
        var type = schedule ? schedule.type : "none";
        var scheduleKey = type + ":" + ((schedule && (schedule.everyMinutes || schedule.atTime)) || "");
        var minutesState = React.useState(schedule && schedule.type === "interval" ? String(schedule.everyMinutes) : "30");
        var minutes = minutesState[0]; var setMinutes = minutesState[1];
        // Re-seed the box whenever the host reports a different schedule, so a
        // change made elsewhere (or a rejected value snapping back) is reflected
        // instead of being masked by whatever was last typed here.
        React.useEffect(function () {
          if (schedule && schedule.type === "interval") setMinutes(String(schedule.everyMinutes));
        }, [scheduleKey]);

        var status = workflowStatus(w.lastStatus, w.running);
        var smallBtn = { flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 11px", borderRadius: 9, border: "1px solid #e5e5ea", background: "#ffffff", color: UI.text2, cursor: "pointer", fontSize: 12.5 };
        var selectStyle = { flex: "0 0 auto", border: "1px solid #e5e5ea", outline: 0, borderRadius: 9, padding: "6px 8px", fontSize: 12.5, color: UI.text, background: "#fff" };
        var inputStyle = { flex: "0 0 auto", width: 66, border: "1px solid #e5e5ea", outline: 0, borderRadius: 9, padding: "6px 8px", fontSize: 12.5, color: UI.text, background: "#fff", boxSizing: "border-box" };

        function commitMinutes() {
          var value = Math.round(Number(minutes));
          if (!isFinite(value) || value < 1) {
            setMinutes(schedule && schedule.type === "interval" ? String(schedule.everyMinutes) : "30");
            return;
          }
          if (schedule && schedule.type === "interval" && Number(schedule.everyMinutes) === value) return;
          props.onConfig({ schedule: { type: "interval", everyMinutes: value } });
        }

        return h("div", { style: { flex: "0 0 auto", background: "#ffffff", border: "1px solid #ececf0", borderRadius: 14, padding: "14px 16px", boxShadow: "0 1px 3px rgba(20,20,25,0.04)" } },
          h("div", { style: { display: "flex", alignItems: "flex-start", gap: 12 } },
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
                h("span", { style: { color: UI.text, fontSize: 14, fontWeight: 600 } }, w.name || w.id),
                h("span", { style: { flex: "0 0 auto", padding: "2px 8px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, background: status.bg, color: status.color } }, status.text)),
              h("div", { style: { ...UI.muted, marginTop: 4, fontSize: 12.5 } }, w.description || "（代码里没有写说明）")),
            h("div", { style: { display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" } },
              h("button", {
                onClick: function () { props.onConfig({ enabled: !w.enabled }); },
                title: w.enabled ? "停用后不再按周期执行；手动运行仍然可用" : "启用后按周期执行",
                style: Object.assign({}, smallBtn, w.enabled
                  ? { background: "#1c1d1f", color: "#fff", border: "1px solid #1c1d1f" }
                  : null)
              }, w.enabled ? "已启用" : "已停用"),
              h("button", {
                onClick: function () { props.onRun(); },
                disabled: w.running === true,
                // For a queue-driven workflow this button cannot mean "run what I
                // just uploaded" — it runs the next *approved* group. Saying so is
                // the difference between a useful shortcut and a button that
                // appears to do nothing.
                title: w.id === PIPELINE_WORKFLOW_ID
                  ? "处理队列里下一个「已确认」的组。要跑刚上传的那一组，请到「分组与成品」里点「估算并运行」。"
                  : "手动触发一次（停用状态下也可以）",
                style: Object.assign({}, smallBtn, {
                  border: "1px solid #1c1d1f", background: "#1c1d1f", color: "#fff", fontWeight: 600,
                  cursor: w.running ? "default" : "pointer", opacity: w.running ? 0.55 : 1
                })
              }, w.running ? "运行中…" : (w.id === PIPELINE_WORKFLOW_ID ? "跑下一组" : "立即运行")))),

          h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 12 } },
            h("span", { style: { flex: "0 0 auto", ...UI.muted } }, "周期"),
            h("select", {
              value: type,
              onChange: function (e) {
                var next = e.target.value;
                if (next === "none") { props.onConfig({ schedule: null }); return; }
                if (next === "interval") {
                  var seeded = Math.round(Number(minutes));
                  props.onConfig({ schedule: { type: "interval", everyMinutes: isFinite(seeded) && seeded >= 1 ? seeded : 30 } });
                  return;
                }
                props.onConfig({ schedule: { type: "daily", atTime: (schedule && schedule.type === "daily" && schedule.atTime) || "09:00" } });
              },
              style: selectStyle
            },
              h("option", { value: "none" }, "不按周期"),
              h("option", { value: "interval" }, "按间隔"),
              h("option", { value: "daily" }, "每天固定时间")),
            type === "interval" ? h("input", {
              key: "minutes",
              value: minutes,
              inputMode: "numeric",
              onChange: function (e) { setMinutes(e.target.value); },
              onBlur: commitMinutes,
              onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); commitMinutes(); } },
              style: inputStyle
            }) : null,
            type === "interval" ? h("span", { key: "unit", style: { flex: "0 0 auto", ...UI.muted } }, "分钟") : null,
            type === "daily" ? h("input", {
              key: "at",
              type: "time",
              value: (schedule && schedule.atTime) || "09:00",
              onChange: function (e) { props.onConfig({ schedule: { type: "daily", atTime: e.target.value } }); },
              style: Object.assign({}, inputStyle, { width: 108 })
            }) : null,
            h("span", { style: { flex: "1 1 auto" } }),
            h("span", { style: { flex: "0 0 auto", ...UI.muted } },
              w.enabled && w.schedule
                ? fmtSchedule(w.schedule) + " · 下次运行 " + fmtStamp(w.nextRunAt)
                : "未启用周期（" + fmtSchedule(w.schedule) + "）")),

          h("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 8, fontSize: 12.5, color: UI.text2 } },
            h("span", null, "上次运行 " + fmtStamp(w.lastRunAt)),
            h("span", { style: { color: runStatusColor(w.running ? "running" : w.lastStatus) } }, w.running ? "运行中" : runStatusLabel(w.lastStatus)),
            w.enabled ? null : h("span", { style: { color: "#a9acb3" } }, "（已停用，只手动运行）")));
      }

      /** One row of the workflow list — a summary, and a way into its page. */
      function WorkflowListRow(props) {
        var w = props.workflow;
        var status = workflowStatus(w.lastStatus, w.running);
        return h("button", {
          onClick: function () { props.onOpen(); },
          style: {
            display: "flex", alignItems: "center", gap: 14, width: "100%", textAlign: "left", padding: "14px 16px",
            borderRadius: 14, border: "1px solid #ececf0", background: "#ffffff", cursor: "pointer",
            boxShadow: "0 1px 3px rgba(20,20,25,0.04)", font: "inherit"
          }
        },
          h("span", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, borderRadius: 12, background: "#f2f3f5", color: UI.text2 } }, IconFlow(19)),
          h("span", { style: { flex: 1, minWidth: 0, display: "block" } },
            h("span", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
              h("span", { style: { color: UI.text, fontSize: 14, fontWeight: 600 } }, w.name || w.id),
              h("span", { style: { flex: "0 0 auto", padding: "2px 8px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, background: status.bg, color: status.color } }, status.text),
              w.enabled ? null : h("span", { style: { color: "#a9acb3", fontSize: 11.5 } }, "已停用")),
            h("span", { style: { display: "block", ...UI.muted, marginTop: 4, fontSize: 12.5 } }, w.description || "（代码里没有写说明）"),
            h("span", { style: { display: "block", marginTop: 6, fontSize: 11.5, color: "#a9acb3" } },
              (w.enabled && w.schedule ? fmtSchedule(w.schedule) + " · 下次 " + fmtStamp(w.nextRunAt) : "未启用周期") +
              " · 上次运行 " + fmtStamp(w.lastRunAt))),
          h("span", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 5, color: UI.text2, fontSize: 12.5, fontWeight: 600 } }, "进入", IconArrowRight(14)));
      }

      /**
       * A workflow's own page.
       *
       * The list is only a list; everything you can *do* to a workflow lives
       * here — its settings, the work it owns (a pipeline's queue of reference
       * groups and the cost estimate), and the history of everything it has run.
       */
      function WorkflowDetail(props) {
        var w = props.workflow;
        var refresh = props.refresh;
        var runsState = React.useState([]);
        var runs = runsState[0]; var setRuns = runsState[1];
        var detailState = React.useState(null);
        var detail = detailState[0]; var setDetail = detailState[1];
        var errorState = React.useState("");
        var error = errorState[0]; var setError = errorState[1];
        var detailRef = React.useRef(null);
        React.useEffect(function () { detailRef.current = detail; }, [detail]);

        function loadRuns() {
          return apiGet("/workflow/runs?workflowId=" + encodeURIComponent(w.id) + "&limit=50").then(function (res) {
            if (res && res.ok === true) setRuns(res.runs || []);
          }, function () {});
        }
        function loadDetail(runId) {
          return apiGet("/workflow/run?id=" + encodeURIComponent(runId)).then(function (res) {
            if (res && res.ok === true) setDetail(res.run);
          }, function () {});
        }
        React.useEffect(function () { loadRuns(); }, []);

        // While something is running, keep the history and the live record
        // fresh: a scheduled run starts with nobody touching the page.
        var liveRunning = detail !== null && detail.status === "running";
        React.useEffect(function () {
          if (w.running !== true && liveRunning !== true) return;
          var alive = true;
          var timer = setInterval(function () {
            if (!alive) return;
            loadRuns();
            var current = detailRef.current;
            if (current && current.status === "running") loadDetail(current.id);
          }, 2000);
          return function () { alive = false; clearInterval(timer); };
        }, [w.running, liveRunning]);

        function saveConfig(body) {
          setError("");
          apiPost("/workflow/config", Object.assign({ id: w.id }, body)).then(function (res) {
            if (!res || res.ok !== true) { setError((res && res.error) || "保存失败"); return; }
            if (refresh) refresh();
          }, function (err) { setError(String((err && err.message) || err)); });
        }
        function runNow() {
          setError("");
          apiPost("/workflow/run", { id: w.id }).then(function (res) {
            if (!res || res.ok !== true) { setError((res && res.error) || "触发失败"); return; }
            if (refresh) refresh();
            loadRuns();
          }, function (err) { setError(String((err && err.message) || err)); });
        }
        function clearHistory() {
          if (!confirmAction("确定清空这个工作流的运行日志？")) return;
          apiPost("/workflow/clear", { id: w.id }).then(function () {
            setRuns([]); setDetail(null);
          }, function (err) { setError(String((err && err.message) || err)); });
        }

        var history = h("div", { style: { flex: "0 0 auto" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 } },
            h("span", { style: { color: UI.text, fontSize: 13, fontWeight: 700 } }, "运行记录"),
            h("span", { style: { ...UI.muted } }, runs.length > 0 ? runs.length + " 次" : "还没有"),
            h("span", { style: { flex: 1 } }),
            runs.length > 0 ? h("button", { onClick: clearHistory, style: Object.assign({}, UI.btnGhost, { padding: "5px 10px", fontSize: 12.5, color: "#b23c2e" }) }, "清空") : null),
          runs.length === 0
            ? h("div", { style: { ...UI.muted, padding: "10px 2px" } }, "还没跑过。")
            : h("div", { style: { display: "flex", gap: 12, minHeight: 220, maxHeight: 380 } },
                h("div", { style: { flex: "0 0 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 6, overflow: "auto" } },
                  runs.map(function (r) {
                    var active = detail !== null && detail.id === r.id;
                    return h("button", {
                      key: r.id,
                      onClick: function () { loadDetail(r.id); },
                      style: { flex: "0 0 auto", textAlign: "left", cursor: "pointer", fontSize: 12, padding: "7px 9px", borderRadius: 10, background: "#fff", border: "1px solid " + (active ? "#1c1d1f" : "#ececf0"), font: "inherit" }
                    },
                      h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                        h("span", { style: { color: runStatusColor(r.status), fontWeight: 600 } }, runStatusLabel(r.status)),
                        h("span", { style: { color: "#a9acb3" } }, triggerLabel(r.trigger)),
                        h("span", { style: { flex: 1 } }),
                        h("span", { style: { color: "#a9acb3" } }, fmtStamp(r.startedAt))),
                      h("div", { style: { color: UI.text2, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
                        r.status === "skipped" ? (r.skippedReason || "已跳过") : ("耗时 " + fmtDuration(r.durationMs) + " · 日志 " + (r.logCount || 0) + " 行")));
                  })),
                h("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" } },
                  h("div", { style: { flex: "0 0 auto", marginBottom: 8, ...UI.muted } },
                    detail ? "这次运行的日志 · " + fmtStamp(detail.startedAt) : "选一次运行，看它当时打了什么日志"),
                  h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", background: "#fff", border: "1px solid #ececf0", borderRadius: 10, padding: "8px 10px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, lineHeight: 1.65 } },
                    detail === null
                      ? h("div", { style: { color: "#a9acb3" } }, "—")
                      : h(React.Fragment, null,
                          detail.error ? h("div", { key: "err", style: { color: "#b23c2e", marginBottom: 6 } }, "错误：" + detail.error) : null,
                          detail.summary ? h("div", { key: "sum", style: { color: "#1c7a4a", marginBottom: 6 } }, "结果：" + detail.summary) : null,
                          (detail.logs || []).length === 0
                            ? h("div", { key: "none", style: { color: "#a9acb3" } }, "（这次运行没有输出日志）")
                            : (detail.logs || []).map(function (line, i) {
                                return h("div", { key: i, style: { display: "flex", gap: 8, alignItems: "flex-start" } },
                                  h("span", { style: { flex: "0 0 auto", color: "#b9bcc2" } }, fmtClock(line.t)),
                                  h("span", { style: { flex: 1, minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", color: line.level === "error" ? "#b23c2e" : (line.level === "warn" ? "#8a6d1f" : UI.text2) } }, line.message));
                              }))))));

        return h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", padding: "2px 4px 20px" } },
          h("button", {
            onClick: function () { props.onBack(); },
            style: { flex: "0 0 auto", alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 12, padding: "6px 12px", borderRadius: 9, border: "1px solid #e5e5ea", background: "#fff", color: UI.text2, cursor: "pointer", fontSize: 12.5 }
          }, "← 返回工作流"),
          error ? h("div", { style: { flex: "0 0 auto", marginBottom: 10, padding: "8px 12px", borderRadius: 10, background: "#fdf1f0", color: "#b23c2e", fontSize: 12.5 } }, error) : null,
          h(WorkflowSettingsCard, { workflow: w, onConfig: saveConfig, onRun: runNow }),
          w.id === PIPELINE_WORKFLOW_ID ? h(PipelinePanel, {
            workflows: props.workflows,
            library: props.library,
            recreations: props.recreations,
            tshirtRecreations: props.tshirtRecreations,
            onZoom: props.onZoom,
            refresh: refresh,
            onOpenProducts: props.onOpenProducts
          }) : null,
          history);
      }

      /**
       * The pipeline workflow's own panels.
       *
       * The engine is generic; the queue of reference groups, the cost estimate
       * and the product library belong to 印花流水线 alone, and the client finds
       * them by workflow id. Everything here is self-contained: it owns its state
       * and its polling, so the workflow card above stays a plain card.
       */
      var PIPELINE_WORKFLOW_ID = "print.pipeline";

      /** One clickable result thumbnail, optionally removable. */
      function AssetTile(props) {
        var asset = props.asset;
        return h("div", { style: { position: "relative", width: 92, height: 92, flex: "0 0 auto" } },
          h("img", {
            src: fileUrl(asset.file),
            loading: "lazy",
            alt: "",
            onClick: function () { if (props.onZoom) props.onZoom({ src: fileUrl(asset.file), label: props.label || "" }); },
            style: { width: 92, height: 92, objectFit: "cover", borderRadius: 10, border: "1px solid #ececf0", background: "#f5f5f7", cursor: "zoom-in", display: "block" }
          }),
          props.onDelete ? h("button", {
            title: "删除这一张",
            onClick: function (e) { e.stopPropagation(); props.onDelete(); },
            style: { position: "absolute", top: 4, right: 4, width: 22, height: 22, padding: 0, borderRadius: 7, border: "1px solid #e5e5ea", background: "rgba(255,255,255,0.94)", color: "#b23c2e", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }
          }, IconTrash(12)) : null);
      }

      /** A labelled row of result thumbnails for one pipeline stage. */
      function AssetSection(props) {
        return h("div", { style: { flex: "0 0 auto", marginTop: 10 } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
            h("span", { style: { color: UI.text, fontSize: 12.5, fontWeight: 600 } }, props.title),
            h("span", { style: { ...UI.muted, fontSize: 12 } }, props.assets.length + " 张"),
            props.hint ? h("span", { style: { color: "#a9acb3", fontSize: 11.5 } }, props.hint) : null),
          props.assets.length === 0
            ? h("div", { style: { ...UI.muted, fontSize: 12 } }, "还没有")
            : h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
                props.assets.map(function (asset, index) {
                  return h(AssetTile, {
                    key: asset.key || index,
                    asset: asset,
                    label: props.label,
                    onZoom: props.onZoom,
                    onDelete: props.onDelete ? function () { props.onDelete(asset); } : null
                  });
                })));
      }

      function PipelinePanel(props) {
        var workflows = props.workflows || [];
        var pipeline = workflows.filter(function (w) { return w.id === PIPELINE_WORKFLOW_ID; })[0] || null;
        var refresh = props.refresh;
        var onZoom = props.onZoom;
        var library = props.library || [];
        var recreations = props.recreations || [];
        var tshirtRecreations = props.tshirtRecreations || [];

        var groupsState = React.useState([]);
        var groups = groupsState[0]; var setGroups = groupsState[1];
        var inboxState = React.useState("");
        var inbox = inboxState[0]; var setInbox = inboxState[1];
        var estimateState = React.useState(null);
        var estimate = estimateState[0]; var setEstimate = estimateState[1];
        var resultsState = React.useState(null);
        var results = resultsState[0]; var setResults = resultsState[1];
        var uploadNameState = React.useState("");
        var uploadName = uploadNameState[0]; var setUploadName = uploadNameState[1];
        // Picked screenshots, staged until 创建分组 is pressed — the same
        // pending-then-submit shape every other composer in this workbench uses.
        var pendingState = React.useState([]);
        var pending = pendingState[0]; var setPending = pendingState[1];
        var busyState = React.useState("");
        var busy = busyState[0]; var setBusy = busyState[1];
        var errorState = React.useState("");
        var error = errorState[0]; var setError = errorState[1];
        var fileRef = React.useRef(null);

        var anyRunning = groups.some(function (g) { return g.status === "running"; }) ||
          (pipeline !== null && pipeline.running === true);

        function loadGroups() {
          return apiGet("/workflow/groups").then(function (res) {
            if (res && res.ok === true) { setGroups(res.groups || []); setInbox(res.inbox || ""); }
          }, function () {});
        }
        function loadOutputs(groupKey) {
          return apiGet("/workflow/outputs?groupKey=" + encodeURIComponent(groupKey) + "&limit=400").then(function (res) {
            if (res && res.ok === true) setResults({ key: groupKey, outputs: res.outputs || [], total: res.total || 0 });
          }, function () {});
        }

        React.useEffect(function () { loadGroups(); }, []);
        // Poll while a group is being processed: this panel is the only place its
        // progress is visible, and a *scheduled* run starts with nobody clicking.
        React.useEffect(function () {
          if (!anyRunning && estimate === null) return;
          var alive = true;
          var timer = setInterval(function () {
            if (!alive) return;
            loadGroups();
            if (refresh) refresh();
          }, 2500);
          return function () { alive = false; clearInterval(timer); };
        }, [anyRunning, estimate === null]);

        function openEstimate(groupKey) {
          setError("");
          setBusy("estimate");
          apiGet("/workflow/estimate?groupKey=" + encodeURIComponent(groupKey)).then(function (res) {
            setBusy("");
            if (!res || res.ok !== true) { setError((res && res.error) || "无法估算"); return; }
            setEstimate(res.plan);
          }, function (err) { setBusy(""); setError(String((err && err.message) || err)); });
        }
        function runGroup(groupKey, force) {
          setError("");
          setBusy("run");
          apiPost("/workflow/run", { id: PIPELINE_WORKFLOW_ID, params: { groupKey: groupKey, force: force === true } }).then(function (res) {
            setBusy("");
            if (!res || res.ok !== true) { setError((res && res.error) || "启动失败"); return; }
            setEstimate(null);
            if (refresh) refresh();
            loadGroups();
          }, function (err) { setBusy(""); setError(String((err && err.message) || err)); });
        }
        function approveGroup(groupKey, approved) {
          setError("");
          apiPost("/workflow/group/approve", { groupKey: groupKey, approved: approved }).then(function (res) {
            if (!res || res.ok !== true) { setError((res && res.error) || "操作失败"); return; }
            loadGroups();
          }, function (err) { setError(String((err && err.message) || err)); });
        }
        function deleteGroup(group) {
          if (!confirmAction("确定把分组「" + group.name + "」从收图目录移除？已经生成的成品会保留。")) return;
          apiPost("/workflow/group/delete", { groupKey: group.key }).then(function () {
            if (estimate && estimate.group.key === group.key) setEstimate(null);
            if (results && results.key === group.key) setResults(null);
            loadGroups();
          });
        }
        /** Stage picked files; nothing is written until 创建分组. */
        function addFiles(files) {
          var list = Array.prototype.slice.call(files || []);
          // Release the input on every path: a file input only fires `change`
          // when its value actually changes, so an un-cleared value makes
          // re-picking the same files look like a dead control.
          if (fileRef.current) fileRef.current.value = "";
          if (list.length === 0) return;
          setError("");
          Promise.all(list.map(readAsDataUrl)).then(function (dataUrls) {
            setPending(function (prev) {
              return prev.concat(list.map(function (file, index) {
                return { key: rid() + index, name: file.name, dataUrl: dataUrls[index] };
              }));
            });
          }, function (err) { setError("读不出这几张图：" + String((err && err.message) || err)); });
        }
        function createGroup() {
          if (pending.length === 0) { setError("先选几张参考图"); return; }
          if (uploadName.trim() === "") { setError("请先填分组名——同一个商品的截图要放在一组里"); return; }
          setError("");
          setBusy("upload");
          apiPost("/workflow/group/upload", {
            name: uploadName.trim(),
            images: pending.map(function (item) { return { name: item.name, dataUrl: item.dataUrl }; })
          }).then(function (res) {
            setBusy("");
            if (!res || res.ok !== true) { setError((res && res.error) || "上传失败"); return; }
            setPending([]);
            setUploadName("");
            if (res.rejected && res.rejected.length > 0) setError("有 " + res.rejected.length + " 张没能写入：" + res.rejected[0]);
            loadGroups();
            // The next thing anyone wants after creating a group is what it will
            // cost, so ask straight away instead of making them find the row.
            if (res.group && res.group.key) openEstimate(res.group.key);
          }, function (err) { setBusy(""); setError(String((err && err.message) || err)); });
        }
        function deleteOutput(id) {
          if (!confirmAction("确定删除这张成片？")) return;
          apiPost("/workflow/output/delete", { id: id }).then(function () {
            if (results) loadOutputs(results.key);
          });
        }
        function deleteAsset(kind, asset) {
          if (!confirmAction("确定删除这一张？")) return;
          if (kind === "library") apiPost("/delete", { kind: "library", id: asset.rowId }).then(function () { if (refresh) refresh(); });
          else if (kind === "recreate") apiPost("/delete", { kind: "variant", id: asset.rowId, printId: asset.id }).then(function () { if (refresh) refresh(); });
          else if (kind === "tshirt") apiPost("/delete", { kind: "tshirtVariant", id: asset.rowId, printId: asset.id }).then(function () { if (refresh) refresh(); });
        }

        /** Stage 1–3 artefacts for one group, straight out of the normal feeds. */
        function groupAssets(groupKey) {
          var prints = [];
          library.filter(function (row) { return row.groupKey === groupKey; }).forEach(function (row) {
            prints.push({ key: row.id, file: row.file, rowId: row.id });
          });
          var recreated = [];
          recreations.filter(function (row) { return row.groupKey === groupKey; }).forEach(function (row) {
            (row.prints || []).forEach(function (print) {
              recreated.push({ key: print.id, file: print.file, id: print.id, rowId: row.id });
            });
          });
          var composites = [];
          tshirtRecreations.filter(function (row) { return row.groupKey === groupKey; }).forEach(function (row) {
            (row.prints || []).forEach(function (print) {
              composites.push({ key: print.id, file: print.file, id: print.id, rowId: row.id });
            });
          });
          return { prints: prints, recreated: recreated, composites: composites };
        }

        function statusChip(group) {
          if (group.status === "running") return { text: "处理中", color: "#1f5fa9", bg: "#eef4fd" };
          if (group.status === "done") return { text: "已完成", color: "#1c7a4a", bg: "#eaf7f0" };
          if (group.status === "failed") return { text: "有失败", color: "#b23c2e", bg: "#fdf1f0" };
          if (group.approvedAt !== null) return { text: "已确认待跑", color: "#8a6d1f", bg: "#fdf6e3" };
          return { text: "未确认", color: "#8a8d94", bg: "#f5f5f7" };
        }

        var header = h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 } },
          h("span", { style: { color: UI.text, fontSize: 13, fontWeight: 600, flex: "0 0 auto" } }, "参考图分组"),
          h("span", { style: { ...UI.muted, fontSize: 11.5, flex: "1 1 260px", minWidth: 0, wordBreak: "break-all" } }, inbox ? "收图目录：" + inbox : ""),
          props.onOpenProducts ? h("button", {
            onClick: function () { props.onOpenProducts(); },
            style: Object.assign({}, UI.btnGhost, { padding: "6px 11px", fontSize: 12.5 })
          }, "成品库") : null,
          h("button", { onClick: function () { loadGroups(); }, style: Object.assign({}, UI.btnGhost, { padding: "6px 11px", fontSize: 12.5 }) }, "刷新"));

        var uploadBar = h("div", { style: { flex: "0 0 auto", marginBottom: 12, padding: "10px 12px", borderRadius: 12, background: "#f7f8fa", border: "1px solid #ececf0" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
            h("input", {
              value: uploadName,
              onChange: function (e) { setUploadName(e.target.value); },
              placeholder: "分组名，例如「商品A」（同一个商品的截图放一组）",
              style: { flex: "1 1 220px", minWidth: 0, border: "1px solid #e5e5ea", outline: 0, borderRadius: 9, padding: "7px 10px", fontSize: 12.5, color: UI.text, background: "#fff", boxSizing: "border-box" }
            }),
            h("button", {
              onClick: function () { if (fileRef.current) fileRef.current.click(); },
              style: Object.assign({}, UI.btnGhost, { padding: "7px 12px" })
            }, "选择图片"),
            h("input", {
              ref: fileRef,
              type: "file",
              accept: "image/*",
              multiple: true,
              onChange: function (e) { addFiles(e.target.files); },
              style: { display: "none" }
            }),
            h("span", { style: { ...UI.muted, flex: "0 0 auto" } }, pending.length > 0 ? "已选 " + pending.length + " 张" : "还没有选图"),
            h("span", { style: { flex: "1 1 auto" } }),
            h("button", {
              onClick: createGroup,
              disabled: busy === "upload" || pending.length === 0 || uploadName.trim() === "",
              title: pending.length === 0 ? "先选几张参考图" : (uploadName.trim() === "" ? "先填分组名" : "把这一组写进收图目录"),
              style: Object.assign({}, UI.btnPrimary, (busy === "upload" || pending.length === 0 || uploadName.trim() === "") ? { opacity: 0.5, cursor: "default" } : null)
            }, busy === "upload" ? "正在创建…" : "创建分组")),
          // Staged, not uploaded on pick. The previous flow wrote on file-select,
          // which silently required the name to be typed FIRST — the natural
          // order (pick the screenshots, then name the group) failed with a
          // message and left nothing to retry with.
          pending.length > 0 ? h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 } },
            pending.map(function (item) {
              return h("div", { key: item.key, style: { position: "relative", width: 56, height: 56 } },
                h("img", { src: item.dataUrl, alt: "", title: item.name, style: { width: 56, height: 56, objectFit: "cover", borderRadius: 8, border: "1px solid #ececf0", display: "block" } }),
                h("button", {
                  title: "移除",
                  onClick: function () { setPending(function (prev) { return prev.filter(function (p) { return p.key !== item.key; }); }); },
                  style: { position: "absolute", top: -6, right: -6, width: 18, height: 18, padding: 0, borderRadius: "50%", border: "1px solid #e5e5ea", background: "#fff", color: "#b23c2e", cursor: "pointer", fontSize: 11, lineHeight: "1", display: "flex", alignItems: "center", justifyContent: "center" }
                }, "×"));
            })) : null,
          h("div", { style: { color: "#a9acb3", fontSize: 11.5, marginTop: 8 } },
            "也可以直接把文件夹丢进上面的收图目录：一个子目录 = 一组参考图，刷新后就会出现。散在目录根下的图会被合并成一组「未分组」。"));

        var estimateBox = estimate === null ? null : h("div", { style: { flex: "0 0 auto", margin: "0 0 12px", padding: "12px 14px", borderRadius: 12, background: "#fffdf5", border: "1px solid #f0e2b8" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 } },
            h("span", { style: { color: UI.text, fontSize: 13, fontWeight: 600 } }, "分组「" + estimate.group.name + "」要花多少"),
            h("span", { style: { flex: 1 } }),
            h("button", { onClick: function () { setEstimate(null); }, style: Object.assign({}, UI.btnGhost, { padding: "5px 10px", fontSize: 12.5 }) }, "取消")),
          h("div", { style: { display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5, color: UI.text2, marginBottom: 8 } },
            h("span", { key: "a" }, "参考图 " + estimate.group.imageCount + " 张"),
            h("span", { key: "b" }, "提取印花 " + estimate.plan.extract),
            h("span", { key: "c" }, "印花二创 " + estimate.plan.recreate + "（" + estimate.prompts.recreate.length + " 个提示词 × " + estimate.settings.recreateOutputs + "）"),
            h("span", { key: "d" }, "T恤融合 " + estimate.plan.tshirt + (estimate.tshirt ? "（" + estimate.tshirt.selected.length + " 款式）" : "")),
            h("span", { key: "e" }, "换装裂变 " + estimate.plan.scene + "（每件 " + estimate.settings.scenePasses + " 轮 × " + estimate.settings.sceneOutputs + " 张）")),
          h("div", { style: { fontSize: 13, color: UI.text, fontWeight: 600, marginBottom: 8 } },
            "合计 " + estimate.plan.total + " 次生成调用，本次还需 " + estimate.pending.total + " 次" +
            (estimate.pending.total < estimate.plan.total ? "（其余已完成，会自动跳过）" : "") +
            "；单次上限 " + estimate.cap.max + " 次"),
          estimate.warnings.length > 0 ? h("div", { style: { marginBottom: 8 } },
            estimate.warnings.map(function (warning, index) {
              return h("div", { key: index, style: { color: "#8a6d1f", fontSize: 12, lineHeight: 1.7 } }, "· " + warning);
            })) : null,
          estimate.cap.exceeded ? h("div", { style: { color: "#b23c2e", fontSize: 12.5, marginBottom: 8 } },
            "已超过单次上限，直接运行会被拒绝。请减少款式或参考图，或调高 ECOM_WORKFLOW_MAX_CALLS。") : null,
          h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
            h("button", {
              disabled: busy === "run",
              onClick: function () { runGroup(estimate.group.key, false); },
              style: Object.assign({}, UI.btnPrimary, busy === "run" ? { opacity: 0.6 } : null)
            }, busy === "run" ? "正在启动…" : "确认并立即运行"),
            h("button", {
              onClick: function () { approveGroup(estimate.group.key, true); setEstimate(null); },
              style: UI.btnGhost
            }, "只确认，交给周期跑"),
            h("button", {
              disabled: busy === "run",
              onClick: function () { runGroup(estimate.group.key, true); },
              title: "忽略已产出的结果，全部重新生成",
              style: UI.btnGhost
            }, "强制重跑")));

        var groupList = groups.length === 0
          ? h("div", { style: { flex: "0 0 auto", padding: "16px 4px", ...UI.muted } },
              "收图目录里还没有参考图。上传一组，或者把文件夹丢进收图目录。")
          : h("div", { style: { flex: "0 0 auto", display: "flex", flexDirection: "column", gap: 8 } },
              groups.map(function (group) {
                var chip = statusChip(group);
                return h("div", { key: group.key, style: { padding: "10px 12px", borderRadius: 12, background: "#fff", border: "1px solid #ececf0" } },
                  h("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
                    h("span", { style: { color: UI.text, fontSize: 13, fontWeight: 600 } }, group.name),
                    h("span", { style: { flex: "0 0 auto", padding: "2px 8px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, background: chip.bg, color: chip.color } }, chip.text),
                    h("span", { style: { ...UI.muted, fontSize: 12 } }, group.imageCount + " 张参考图"),
                    group.counts ? h("span", { style: { ...UI.muted, fontSize: 12 } },
                      "印花 " + group.counts.extract + " · 二创 " + group.counts.recreate + " · T恤 " + group.counts.tshirt + " · 成片 " + group.counts.scene) : null,
                    h("span", { style: { flex: "1 1 auto" } }),
                    h("button", { onClick: function () { openEstimate(group.key); }, disabled: busy === "estimate", style: Object.assign({}, UI.btnGhost, { padding: "5px 10px", fontSize: 12.5 }) }, "估算并运行"),
                    results && results.key === group.key
                      ? h("button", { onClick: function () { setResults(null); }, style: Object.assign({}, UI.btnGhost, { padding: "5px 10px", fontSize: 12.5 }) }, "收起成品")
                      : h("button", { onClick: function () { loadOutputs(group.key); }, style: Object.assign({}, UI.btnGhost, { padding: "5px 10px", fontSize: 12.5 }) }, "看成品"),
                    group.approvedAt === null
                      ? h("button", { onClick: function () { approveGroup(group.key, true); }, title: "交给周期调度一组一组地跑", style: Object.assign({}, UI.btnGhost, { padding: "5px 10px", fontSize: 12.5 }) }, "确认排队")
                      : h("button", { onClick: function () { approveGroup(group.key, false); }, style: Object.assign({}, UI.btnGhost, { padding: "5px 10px", fontSize: 12.5 }) }, "取消排队"),
                    h("button", { onClick: function () { deleteGroup(group); }, title: "从收图目录移除", style: { flex: "0 0 auto", width: 28, height: 28, borderRadius: 8, border: "1px solid #ececf0", background: "#f5f5f7", color: UI.text2, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconTrash(13))),
                  h("div", { style: { ...UI.muted, fontSize: 11.5, marginTop: 4, wordBreak: "break-all" } }, group.images.join("、")));
              }));

        var resultsBox = results === null ? null : (function () {
          var assets = groupAssets(results.key);
          return h("div", { style: { flex: "0 0 auto", marginTop: 12, padding: "12px 14px", borderRadius: 12, background: "#fff", border: "1px solid #ececf0" } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 4 } },
              h("span", { style: { color: UI.text, fontSize: 13, fontWeight: 600 } }, "「" + results.key + "」的产出"),
              h("span", { style: { ...UI.muted, fontSize: 12 } },
                "共 " + (assets.prints.length + assets.recreated.length + assets.composites.length + results.total) + " 张"),
              h("span", { style: { flex: 1 } }),
              h("button", { onClick: function () { loadOutputs(results.key); if (refresh) refresh(); }, style: Object.assign({}, UI.btnGhost, { padding: "5px 10px", fontSize: 12.5 }) }, "刷新")),
            h("div", { style: { ...UI.muted, fontSize: 11.5 } },
              "前三步的产物同时也进了 印花原图库 / 二创印花 / T恤二创结果，可以在那些模块里继续用。"),
            h(AssetSection, { title: "① 提取印花", assets: assets.prints, onZoom: onZoom, onDelete: function (asset) { deleteAsset("library", asset); } }),
            h(AssetSection, { title: "② 二创印花", assets: assets.recreated, onZoom: onZoom, onDelete: function (asset) { deleteAsset("recreate", asset); } }),
            h(AssetSection, { title: "③ 二创T恤", assets: assets.composites, onZoom: onZoom, onDelete: function (asset) { deleteAsset("tshirt", asset); } }),
            h(AssetSection, {
              title: "④ 场景成片",
              hint: "（成品库，与场景图管理的参考图池分开）",
              assets: results.outputs,
              onZoom: onZoom,
              onDelete: function (asset) { deleteOutput(asset.id); }
            }));
        })();

        return h("div", { style: { flex: "0 0 auto", marginTop: 12, padding: "14px 16px", borderRadius: 14, background: "#fbfbfc", border: "1px solid #ececf0" } },
          header,
          uploadBar,
          error ? h("div", { style: { flex: "0 0 auto", marginBottom: 10, padding: "8px 12px", borderRadius: 10, background: "#fdf1f0", color: "#b23c2e", fontSize: 12.5 } }, error) : null,
          estimateBox,
          groupList,
          resultsBox);
      }

      /**
       * 工作流管理: enable/disable, choose a schedule, trigger by hand, read the
       * run history and each run's own log.
       *
       * A workflow itself is code and is registered in the plugin — this view
       * deliberately cannot create one, so with nothing registered it shows an
       * empty state that says so rather than an empty list pretending to be a
       * feature that is merely unused.
       */
      /**
       * 工作流: a list, and one page per workflow.
       *
       * A workflow is code and is registered in the plugin — this view cannot
       * create one, so the list is short by nature. It only says what exists;
       * opening a row is where you actually work with it.
       */
      function WorkflowManager(props) {
        var workflows = props.workflows || [];
        var detailState = React.useState(null);
        var detailId = detailState[0]; var setDetailId = detailState[1];
        var anyRunning = workflows.some(function (w) { return w.running === true; });
        var selected = detailId === null ? null : (workflows.filter(function (w) { return w.id === detailId; })[0] || null);

        if (selected !== null) {
          return h(WorkflowDetail, {
            workflow: selected,
            workflows: workflows,
            refresh: props.refresh,
            library: props.library,
            recreations: props.recreations,
            tshirtRecreations: props.tshirtRecreations,
            onZoom: props.onZoom,
            onOpenProducts: props.onOpenProducts,
            onBack: function () { setDetailId(null); }
          });
        }

        if (workflows.length === 0) {
          return h("div", { style: { flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" } },
            h("div", { style: { maxWidth: 540, padding: "0 24px" } },
              h("div", { style: { display: "flex", justifyContent: "center", color: "#c3c6cc", marginBottom: 14 } }, IconFlow(36)),
              h("div", { style: { color: UI.text, fontSize: 14.5, fontWeight: 600, textAlign: "center", marginBottom: 10 } }, "还没有已注册的工作流"),
              h("div", { style: { color: UI.muted.color, fontSize: 12.5, lineHeight: 1.8 } },
                "工作流由代码注册（插件里的 ",
                h("code", { style: { background: "#f2f3f5", padding: "1px 5px", borderRadius: 5 } }, "lib/workflows.js"),
                "），不在这里创建 —— 一个工作流要做什么，本身就是代码。")));
        }

        return h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", padding: "2px 4px 16px" } },
          h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, margin: "2px 2px 12px" } },
            h("span", { style: { ...UI.muted } }, workflows.length + " 个工作流 · 周期调度只在 DSH 运行期间生效"),
            anyRunning ? h("span", { style: { display: "flex", alignItems: "center", gap: 6, color: "#1f5fa9", fontSize: 12.5, flex: "0 0 auto" } }, Spinner(), "有工作流正在运行") : null),
          h("div", { style: { flex: "0 0 auto", display: "flex", flexDirection: "column", gap: 10 } },
            workflows.map(function (w) {
              return h(WorkflowListRow, { key: w.id, workflow: w, onOpen: function () { setDetailId(w.id); } });
            })));
      }

      // ---------- 成品库 ---------------------------------------------------
      /** How many products one 商品 page loads; a group makes ~192. */
      var PRODUCT_FETCH_LIMIT = 2000;
      /**
       * How many tiles across in the 成品库 feed.
       *
       * A fixed count rather than 场景图管理's width-derived one: that pool fills
       * whatever width it is given, which on a narrow pane means a handful of
       * very large tiles. Here the count is chosen deliberately — the shelf is
       * for scanning, and a predictable 4 across keeps every shot the same size
       * no matter how the pane is sized.
       */
      var PRODUCT_COLUMNS = 4;

      /**
       * The finished products, browsed the way a shopping app shows a listing:
       * a grid of 商品, and inside one a product page with a big image, arrows,
       * a rail of that 款式's other shots, and the 款式 switcher.
       *
       * The structure is the data's own, not an invention: a reference group is
       * a 商品, each 二创T恤 is a 款式 (SKU), and that 款式's 场景成片 are its
       * gallery. The intermediates (印花 / 二创印花 / 二创T恤) live in their own
       * modules and in the workflow's group view; this is the finished shelf.
       */
      /** A product's measured aspect ratio, or null when it was never measured. */
      function productAspect(item) {
        var width = Number(item && item.width);
        var height = Number(item && item.height);
        if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return null;
        return width + " / " + height;
      }

      /**
       * 成品库 — the finished shelf, browsed the way a shopping app is browsed:
       * a **waterfall of goods**, and a product page when you tap one.
       *
       * The structure is the data's own, not an invention: a reference group is a
       * 商品, each 二创T恤 is a 款式 (SKU), and that 款式's 场景成片 are its
       * gallery. The feed shows every shot; tapping one opens its 商品 with that
       * shot already selected, where the cover, the arrows, the left rail of the
       * same 款式's other shots and the 款式 switcher live.
       *
       * Why a waterfall rather than a grid of covers: this is a shelf of images
       * to browse, and the shots come in whatever shape the model returned. A
       * fixed tile would crop them; a waterfall keeps every shot whole and lets
       * the eye scan them the way it scans a shopping feed.
       */
      function ProductLibrary(props) {
        var openState = React.useState(null); // { groupKey, shotId } while a 商品 is open
        var open = openState[0]; var setOpen = openState[1];
        var productsState = React.useState([]);
        var products = productsState[0]; var setProducts = productsState[1];
        var loadingState = React.useState(true);
        var loading = loadingState[0]; var setLoading = loadingState[1];
        var errorState = React.useState("");
        var error = errorState[0]; var setError = errorState[1];
        var filterState = React.useState(null); // groupKey, or null for everything
        var filter = filterState[0]; var setFilter = filterState[1];
        var poolRef = React.useRef(null);
        var visibleState = React.useState(MASONRY_PAGE);
        var visibleCount = visibleState[0]; var setVisibleCount = visibleState[1];
        var sentinelRef = React.useRef(null);

        function load() {
          setLoading(true);
          apiGet("/workflow/outputs?workflowId=" + encodeURIComponent(PIPELINE_WORKFLOW_ID) + "&limit=" + PRODUCT_FETCH_LIMIT).then(function (res) {
            setLoading(false);
            if (!res || res.ok !== true) { setError((res && res.error) || "读不到成品"); return; }
            setError("");
            setProducts(res.outputs || []);
          }, function (err) { setLoading(false); setError(String((err && err.message) || err)); });
        }
        React.useEffect(function () { load(); }, []);

        function deleteProduct(id) {
          if (!confirmAction("确定删除这张成片？文件会一起删掉。")) return;
          apiPost("/workflow/output/delete", { id: id }).then(function () {
            setProducts(function (prev) { return prev.filter(function (p) { return p.id !== id; }); });
          }, function (err) { setError(String((err && err.message) || err)); });
        }

        // 商品 list (for the filter chips and the product page), plus each 商品's
        // 款式 numbering so a tile can say which 款式 it belongs to.
        var goods = [];
        var byKey = {};
        var styleIndex = {};
        products.forEach(function (p) {
          var key = p.groupKey || "未命名";
          if (!byKey[key]) { byKey[key] = { key: key, name: p.groupName || key, items: [], styles: [], byStyle: {} }; goods.push(byKey[key]); }
          var goods2 = byKey[key];
          goods2.items.push(p);
          if (!goods2.byStyle[p.tshirtFile]) {
            goods2.byStyle[p.tshirtFile] = { file: p.tshirtFile, sceneFile: p.sceneFile, items: [] };
            goods2.styles.push(goods2.byStyle[p.tshirtFile]);
          }
          goods2.byStyle[p.tshirtFile].items.push(p);
        });
        goods.forEach(function (g) {
          g.items.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
          g.styles.forEach(function (style, index) {
            style.items.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
            styleIndex[g.key + "|" + style.file] = index;
          });
        });

        var ordered = (filter === null ? products : products.filter(function (p) { return p.groupKey === filter; }))
          .slice()
          .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });

        // Without IntersectionObserver, render everything rather than hiding
        // products behind a page size nothing can advance.
        var canPage = typeof IntersectionObserver !== "undefined";
        var shown = canPage ? Math.min(visibleCount, ordered.length) : ordered.length;
        var hasMore = shown < ordered.length;
        React.useEffect(function () {
          if (!hasMore) return undefined;
          var root = poolRef.current; var sentinel = sentinelRef.current;
          if (!root || !sentinel) return undefined;
          var observer = new IntersectionObserver(function (entries) {
            if (entries.some(function (entry) { return entry.isIntersecting; })) {
              setVisibleCount(function (n) { return n + MASONRY_PAGE; });
            }
          }, { root: root, rootMargin: "800px 0px" });
          observer.observe(sentinel);
          return function () { observer.disconnect(); };
        }, [hasMore]);

        if (open !== null && byKey[open.groupKey]) {
          return h(ProductViewer, {
            // Keyed by 商品: switching to another one must start a fresh page
            // rather than keep the previous 商品's 款式/shot position.
            key: open.groupKey,
            product: byKey[open.groupKey],
            focusId: open.shotId,
            onZoom: props.onZoom,
            onDelete: deleteProduct,
            onBack: function () { setOpen(null); }
          });
        }

        // Loading and empty are rendered *inside* the scroller, never instead of
        // it: the sentinel's observer is rooted on that element, and a feed whose
        // scroll container appears and disappears is one whose pagination stops
        // working the moment it is needed.
        var poolInner;
        if (loading) {
          poolInner = h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 200, ...UI.muted } }, Spinner(), "正在读成品…");
        } else if (products.length === 0) {
          poolInner = h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: 240 } },
            h("div", { style: { maxWidth: 520, padding: "0 24px", textAlign: "center" } },
              h("div", { style: { display: "flex", justifyContent: "center", color: "#c3c6cc", marginBottom: 14 } }, IconGallery(36)),
              h("div", { style: { color: UI.text, fontSize: 14.5, fontWeight: 600, marginBottom: 10 } }, "还没有成品"),
              h("div", { style: { color: UI.muted.color, fontSize: 12.5, lineHeight: 1.8 } },
                "成品来自「工作流 → 印花流水线」跑完的每一组：一个分组 = 一个商品，每个二创T恤 = 一个款式，",
                "该款式的场景成片就是它的图集。")));
        } else {
          poolInner = h("div", null,
            h("div", { style: { display: "flex", alignItems: "flex-start", gap: MASONRY_COL_GAP } },
              distributeColumns(ordered.slice(0, shown), PRODUCT_COLUMNS).map(function (column, columnIndex) {
                return h("div", {
                  key: columnIndex,
                  style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: MASONRY_COL_GAP }
                }, column.map(productTile));
              })),
            hasMore ? h("div", { ref: sentinelRef, style: { height: 1 } }) : null);
        }

        function productTile(item) {
          var src = fileUrl(item.file);
          var index = styleIndex[item.groupKey + "|" + item.tshirtFile];
          return h("div", { key: item.id, style: { borderRadius: 12, overflow: "hidden", border: "1px solid #ececf0", background: "#ffffff" } },
            h("img", {
              src: src,
              alt: "",
              loading: "lazy",
              onClick: function () { setOpen({ groupKey: item.groupKey, shotId: item.id }); },
              // Height is reserved only from the real measured ratio; an unknown
              // one lays out naturally rather than being stretched by a guess.
              style: { width: "100%", display: "block", background: "#f2f2f4", cursor: "pointer", aspectRatio: productAspect(item) || undefined }
            }),
            // One short line only. At this tile size a two-line caption with a
            // full 商品名 would dominate the image it describes; the full
            // description is still available as the tile's tooltip.
            h("div", {
              title: (item.groupName || item.groupKey) + " · " + (index === undefined ? "款式" : "款式 #" + (index + 1)) + " · 第 " + (item.pass + 1) + " 轮",
              style: { display: "flex", alignItems: "center", gap: 5, padding: "5px 7px" }
            },
              h("span", { style: { flex: 1, minWidth: 0, color: UI.text, fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, item.groupName || item.groupKey),
              h("span", { style: { flex: "0 0 auto", color: "#a9acb3", fontSize: 11 } }, index === undefined ? "款式" : "#" + (index + 1))));
        }

        var chips = h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "2px 2px 12px" } },
          h("span", { style: { ...UI.muted } }, ordered.length + " 张成片" + (hasMore ? " · 已显示 " + shown : "")),
          h("span", { style: { flex: 1 } }),
          error ? h("span", { style: { color: "#b23c2e", fontSize: 12.5 } }, error) : null,
          goods.length > 1 ? h("button", {
            onClick: function () { setFilter(null); },
            style: Object.assign({}, filter === null ? UI.chipOn : UI.chip, { flex: "0 0 auto" })
          }, "全部") : null,
          goods.length > 1 ? goods.map(function (g) {
            return h("button", {
              key: g.key,
              onClick: function () { setFilter(g.key); },
              style: Object.assign({}, filter === g.key ? UI.chipOn : UI.chip, { flex: "0 0 auto" })
            }, g.name + " " + g.items.length);
          }) : null,
          h("button", { onClick: load, style: Object.assign({}, UI.btnGhost, { padding: "5px 10px", fontSize: 12.5, flex: "0 0 auto" }) }, "刷新"));

        // Always rendered, whatever the state — the pagination sentinel observes
        // this element, so it has to exist before a second page can ever load.
        // The data attribute is what lets a test assert that invariant directly:
        // a missing scroller is invisible to any assertion about the tiles.
        var feed = h("div", {
          ref: poolRef,
          "data-ecom-feed": "products",
          style: { flex: 1, minHeight: 0, overflow: "auto", padding: "2px 4px 16px" }
        }, poolInner);

        return h("div", { style: { flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" } }, chips, feed);
      }

      /**
       * One 商品's page — the app-shaped part.
       *
       * Cover image with ‹ › and a counter, a rail of the same 款式's other
       * shots down the left, and the 款式 (二创T恤) switcher below. Arrow keys
       * move between shots, because that is what the arrows imply.
       */
      function ProductViewer(props) {
        var product = props.product;

        // 款式 = the T恤 composite; its shots are that 款式's 场景成片.
        var styles = [];
        var byStyle = {};
        product.items.forEach(function (p) {
          var key = p.tshirtFile || "unknown";
          if (!byStyle[key]) { byStyle[key] = { file: p.tshirtFile, sceneFile: p.sceneFile, items: [] }; styles.push(byStyle[key]); }
          byStyle[key].items.push(p);
        });

        // Open on the shot the feed was tapped on, so tapping a tile lands on
        // that image rather than on the first one of the 款式.
        var focusStyle = 0;
        var focusShot = 0;
        if (props.focusId) {
          styles.forEach(function (style, si) {
            style.items.forEach(function (item, sj) {
              if (item.id === props.focusId) { focusStyle = si; focusShot = sj; }
            });
          });
        }

        var styleState = React.useState(focusStyle);
        var styleIndex = styleState[0]; var setStyleIndex = styleState[1];
        var shotState = React.useState(focusShot);
        var shotIndex = shotState[0]; var setShotIndex = shotState[1];
        var safeStyleIndex = Math.min(Math.max(styleIndex, 0), Math.max(styles.length - 1, 0));
        var current = styles[safeStyleIndex] || { items: [] };
        var shots = current.items;
        var safeShotIndex = Math.min(Math.max(shotIndex, 0), Math.max(shots.length - 1, 0));
        var shot = shots[safeShotIndex] || null;

        function pickStyle(next) {
          setStyleIndex(next);
          setShotIndex(0);
        }
        function step(delta) {
          if (shots.length === 0) return;
          setShotIndex(((safeShotIndex + delta) % shots.length + shots.length) % shots.length);
        }

        React.useEffect(function () {
          if (typeof document === "undefined") return;
          function onKey(event) {
            if (event.key === "ArrowLeft") step(-1);
            else if (event.key === "ArrowRight") step(1);
          }
          document.addEventListener("keydown", onKey);
          return function () { document.removeEventListener("keydown", onKey); };
        }, [safeStyleIndex, safeShotIndex, shots.length]);

        var arrowStyle = function (disabled) {
          return {
            flex: "0 0 auto", width: 40, alignSelf: "stretch", border: "1px solid #ececf0", borderRadius: 12,
            background: "#fff", color: disabled ? "#d5d7db" : UI.text2, cursor: disabled ? "default" : "pointer",
            fontSize: 20, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center"
          };
        };

        return h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", padding: "2px 4px 20px" } },
          h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 12, marginBottom: 14 } },
            h("button", {
              onClick: function () { props.onBack(); },
              style: { display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 9, border: "1px solid #e5e5ea", background: "#fff", color: UI.text2, cursor: "pointer", fontSize: 12.5 }
            }, "← 返回成品库"),
            h("span", { style: { color: UI.text, fontSize: 14.5, fontWeight: 700 } }, product.name),
            h("span", { style: { ...UI.muted } }, styles.length + " 个款式 · " + product.items.length + " 张成片")),

          h("div", { style: { flex: "0 0 auto", display: "flex", gap: 12, minHeight: 340 } },
            // Left rail: the other shots of this 款式.
            h("div", { style: { flex: "0 0 84px", display: "flex", flexDirection: "column", gap: 8, overflow: "auto", paddingRight: 2 } },
              shots.map(function (item, index) {
                return h("button", {
                  key: item.id,
                  onClick: function () { setShotIndex(index); },
                  title: "第 " + (index + 1) + " 张",
                  style: { flex: "0 0 auto", padding: 0, borderRadius: 10, overflow: "hidden", cursor: "pointer", background: "#f5f5f7", border: "2px solid " + (index === safeShotIndex ? "#1c1d1f" : "transparent") }
                }, h("img", { src: fileUrl(item.file), loading: "lazy", alt: "", style: { width: "100%", aspectRatio: "3 / 4", objectFit: "cover", display: "block" } }));
              })),
            // The cover.
            h("div", { style: { flex: 1, minWidth: 0, display: "flex", gap: 10 } },
              h("button", { onClick: function () { step(-1); }, disabled: shots.length < 2, style: arrowStyle(shots.length < 2) }, "‹"),
              h("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 } },
                h("div", { style: { flex: 1, minHeight: 0, borderRadius: 14, overflow: "hidden", background: "#f5f5f7", border: "1px solid #ececf0", display: "flex", alignItems: "center", justifyContent: "center" } },
                  shot
                    ? h("img", {
                        src: fileUrl(shot.file),
                        alt: "",
                        onClick: function () { if (props.onZoom) props.onZoom({ src: fileUrl(shot.file), label: product.name + " · " + (safeShotIndex + 1) + "/" + shots.length }); },
                        style: { width: "100%", height: "100%", objectFit: "contain", cursor: "zoom-in", display: "block" }
                      })
                    : h("span", { style: { ...UI.muted } }, "这个款式还没有成片")),
                h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10 } },
                  h("span", { style: { ...UI.muted } }, shots.length > 0 ? (safeShotIndex + 1) + " / " + shots.length : "—"),
                  h("span", { style: { flex: 1 } }),
                  shot ? h("button", {
                    onClick: function () { props.onDelete(shot.id); },
                    style: Object.assign({}, UI.btnGhost, { padding: "5px 10px", fontSize: 12.5, color: "#b23c2e" })
                  }, "删除这张") : null)),
              h("button", { onClick: function () { step(1); }, disabled: shots.length < 2, style: arrowStyle(shots.length < 2) }, "›")),

            // Right: what this shot is made of.
            h("div", { style: { flex: "0 0 200px", display: "flex", flexDirection: "column", gap: 10 } },
              h("div", { style: { ...UI.panel, padding: 12 } },
                h("div", { style: { color: UI.text, fontSize: 12.5, fontWeight: 600, marginBottom: 8 } }, "这一张的来源"),
                h("div", { style: { display: "flex", gap: 8 } },
                  shot && shot.sceneFile ? h("div", { style: { flex: 1, minWidth: 0 } },
                    h("img", { src: fileUrl(shot.sceneFile), loading: "lazy", alt: "", style: { width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 8, border: "1px solid #ececf0", display: "block" } }),
                    h("div", { style: { ...UI.muted, fontSize: 11, marginTop: 4, textAlign: "center" } }, "场景图")) : null,
                  current.file ? h("div", { style: { flex: 1, minWidth: 0 } },
                    h("img", { src: fileUrl(current.file), loading: "lazy", alt: "", style: { width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 8, border: "1px solid #ececf0", display: "block" } }),
                    h("div", { style: { ...UI.muted, fontSize: 11, marginTop: 4, textAlign: "center" } }, "二创T恤")) : null),
                h("button", {
                  onClick: function () { if (shot && props.onZoom) props.onZoom({ src: fileUrl(current.file), label: product.name + " · 款式 " + (safeStyleIndex + 1) }); },
                  style: Object.assign({}, UI.btnGhost, { width: "100%", justifyContent: "center", marginTop: 10, padding: "6px 10px", fontSize: 12.5 })
                }, "看这个款式")),

              h("div", { style: { ...UI.panel, padding: 12, flex: 1, minHeight: 0, overflow: "auto" } },
                h("div", { style: { color: UI.text, fontSize: 12.5, fontWeight: 600, marginBottom: 6 } }, "商品信息"),
                h("div", { style: { fontSize: 12, color: UI.text2, lineHeight: 1.9 } },
                  h("div", null, "商品：" + product.name),
                  h("div", null, "款式：" + (safeStyleIndex + 1) + " / " + styles.length),
                  h("div", null, "该款式成片：" + shots.length + " 张"),
                  h("div", null, "全部成片：" + product.items.length + " 张"),
                  shot ? h("div", null, "生成于 " + fmtStamp(shot.createdAt)) : null)))),

          // 款式 switcher.
          h("div", { style: { flex: "0 0 auto", marginTop: 16 } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 } },
              h("span", { style: { color: UI.text, fontSize: 13, fontWeight: 700 } }, "款式"),
              h("span", { style: { ...UI.muted } }, styles.length + " 个 · 每个 " + (styles[0] ? styles[0].items.length : 0) + " 张成片")),
            h("div", { style: { display: "flex", gap: 10, overflowX: "auto", paddingBottom: 6 } },
              styles.map(function (style, index) {
                var active = index === safeStyleIndex;
                return h("button", {
                  key: style.file || index,
                  onClick: function () { pickStyle(index); },
                  title: "款式 " + (index + 1) + " · " + style.items.length + " 张",
                  style: { flex: "0 0 auto", width: 76, padding: 0, borderRadius: 12, overflow: "hidden", cursor: "pointer", background: "#f5f5f7", border: "2px solid " + (active ? "#1c1d1f" : "#ececf0") }
                },
                  h("img", { src: fileUrl(style.file), loading: "lazy", alt: "", style: { width: "100%", aspectRatio: "3 / 4", objectFit: "cover", display: "block" } }),
                  h("span", { style: { display: "block", padding: "4px 0", fontSize: 11, color: active ? UI.text : UI.text2, fontWeight: active ? 600 : 400, textAlign: "center" } }, "#" + (index + 1)));
              }))));
      }

      // ---------- shared workbench shell ---------------------------------
      function Workbench() {
        // Bound the shell's view area before first paint, so the workbench fills
        // the visible area and scrolls its own results list instead of growing
        // the shell's scroller (see injectLayoutStyle).
        injectLayoutStyle();
        // The left nav IS the two operations (印花提取 / 印花二创),
        // main shows the active one. No module list, no right assistant aside —
        // the child chat composer lives below in the conversation shell.
        var viewState = React.useState("印花提取");
        var view = viewState[0]; var setView = viewState[1];
        // Both feeds are owned by the host store; this is the local mirror,
        // hydrated once on mount and kept in step by the mutating calls.
        var libraryState = React.useState([]);
        var library = libraryState[0]; var setLibrary = libraryState[1];
        var recreationsState = React.useState([]);
        var recreations = recreationsState[0]; var setRecreations = recreationsState[1];
        var tshirtsState = React.useState([]);
        var tshirts = tshirtsState[0]; var setTshirts = tshirtsState[1];
        var tshirtRecreationsState = React.useState([]);
        var tshirtRecreations = tshirtRecreationsState[0]; var setTshirtRecreations = tshirtRecreationsState[1];
        var errorState = React.useState("");
        var loadError = errorState[0]; var setLoadError = errorState[1];
        // Every image in the workbench opens here on click, enlarged.
        var lightboxState = React.useState(null);
        var lightboxImage = lightboxState[0]; var setLightboxImage = lightboxState[1];
        // Bound the shell ancestors so the workbench scrolls internally; the
        // cleanup restores them, giving Chat back its growing view area.
        var rootRef = React.useRef(null);
        React.useEffect(function () {
          return bindLayoutAncestors(rootRef.current);
        }, []);
        // Saved common prompts, editable in 提示词管理 and pickable in every composer.
        var promptsState = React.useState([]);
        var prompts = promptsState[0]; var setPrompts = promptsState[1];
        // 通用工作台 output feed (free-form prompt + optional reference images).
        var generationsState = React.useState([]);
        var generations = generationsState[0]; var setGenerations = generationsState[1];
        // 场景图管理: a flat pool of scene photos, stored as-is (no generation).
        var scenesState = React.useState([]);
        var scenes = scenesState[0]; var setScenes = scenesState[1];
        // 工作流: registered definitions merged with their stored config by the
        // host. The view edits config and triggers runs; it never invents one.
        var workflowsState = React.useState([]);
        var workflows = workflowsState[0]; var setWorkflows = workflowsState[1];
        // Jobs are OWNED here (not in the per-op views) so an in-progress generation
        // keeps polling across the workbench's internal tab switches. Workbench
        // itself still unmounts when you switch the conversation view to Chat and
        // back — the host's /ecom/api/jobs (recovered in the mount effect below)
        // re-adopts anything still running so the task reappears and keeps going.
        var activeJobsState = React.useState([]);
        var activeJobs = activeJobsState[0]; var setActiveJobs = activeJobsState[1];
        var pollRef = React.useRef(null);
        var jobsRef = React.useRef([]);
        React.useEffect(function () { jobsRef.current = activeJobs; }, [activeJobs]);
        var jobSeqRef = React.useRef(0);

        /**
         * Hydrate every local mirror from the host.
         *
         * The **one** place that knows how to load state. The mount effect calls
         * this rather than repeating the field list, because two copies of that
         * list had already drifted: a field added to one was silently absent from
         * the other, and since the mount path used the other copy, 工作流 rendered
         * as empty forever while the host was returning a workflow perfectly
         * well. A list that must be kept in sync in two places will not be.
         *
         * @param {{alive?: () => boolean}} [options] - guard for a mount-time
         *   call that must not set state after unmount.
         */
        function fetchState(options) {
          var alive = options && typeof options.alive === "function" ? options.alive : function () { return true; };
          return apiGet("/state").then(function (state) {
            if (!alive() || !state || state.ok !== true) return;
            setLibrary(state.library || []);
            setRecreations(state.recreations || []);
            setTshirts(state.tshirts || []);
            setTshirtRecreations(state.tshirtRecreations || []);
            setPrompts(state.prompts || []);
            setGenerations(state.generations || []);
            setScenes(state.scenes || []);
            setWorkflows(state.workflows || []);
          });
        }
        function patchJob(localId, patch) {
          setActiveJobs(function (prev) { return prev.map(function (j) { return j.localId === localId ? Object.assign({}, j, patch) : j; }); });
        }
        function startJob(kind, meta, payload) {
          var localId = ++jobSeqRef.current;
          var job = { localId: localId, kind: kind, meta: meta || {}, jobId: null, start: Date.now(), stage: "queued", done: 0, total: (meta && meta.total) || 1, status: "running", error: null, title: meta && meta.title, subtitle: meta && meta.subtitle };
          setActiveJobs(function (prev) { return [job].concat(prev); });
          apiPost(JOB_PATHS[kind], payload).then(function (res) {
            if (!res || res.ok !== true) {
              patchJob(localId, { status: "error", stage: "done", error: (res && res.error) || "生成失败" });
              scheduleRemove(localId);
              return;
            }
            patchJob(localId, { jobId: res.jobId });
            ensurePolling();
          }, function (err) {
            patchJob(localId, { status: "error", stage: "done", error: String((err && err.message) || err) });
            scheduleRemove(localId);
          });
        }
        function ensurePolling() {
          if (pollRef.current) return;
          pollRef.current = setInterval(pollTick, 1100);
        }
        function pollTick() {
          var running = jobsRef.current.filter(function (j) { return j.status === "running" && j.jobId; });
          var busy = jobsRef.current.some(function (j) { return j.status === "running"; });
          if (running.length === 0) {
            if (!busy) { clearInterval(pollRef.current); pollRef.current = null; }
            return;
          }
          running.forEach(function (j) {
            apiGet("/job/" + j.jobId).then(function (r) {
              if (!r || !r.job) return;
              var hostJob = r.job;
              if (hostJob.status === "done" || hostJob.status === "error") {
                patchJob(j.localId, { status: hostJob.status, stage: "done", done: hostJob.total || j.total, total: hostJob.total || j.total, error: hostJob.error || null });
                fetchState();
                scheduleRemove(j.localId);
              } else {
                patchJob(j.localId, { stage: hostJob.stage, done: hostJob.done, total: hostJob.total });
              }
            }, function () {});
          });
        }
        function scheduleRemove(localId) {
          setTimeout(function () { setActiveJobs(function (prev) { return prev.filter(function (j) { return j.localId !== localId; }); }); }, 1500);
        }

        React.useEffect(function () {
          var alive = true;
          // Deliberately the shared loader, not a second copy of the field list:
          // see the note on fetchState.
          fetchState({ alive: function () { return alive; } }).catch(function (error) {
            if (alive) setLoadError(String((error && error.message) || error));
          });
          // Recover in-progress jobs that survive a workbench remount (switching to
          // Chat and back unmounts this component; the host keeps them running and
          // persists every finished result to the store).
          apiGet("/jobs").then(function (r) {
            if (!alive || !r || r.ok !== true || !r.jobs) return;
            var adopted = [];
            (r.jobs || []).forEach(function (hostJob) {
              adopted.push({
                localId: ++jobSeqRef.current, kind: hostJob.kind, meta: hostJob.meta || {},
                jobId: hostJob.jobId, start: hostJob.start, stage: hostJob.stage, done: hostJob.done,
                total: hostJob.total, status: hostJob.status, error: hostJob.error,
                title: hostJob.meta && hostJob.meta.title, subtitle: hostJob.meta && hostJob.meta.subtitle
              });
            });
            if (adopted.length > 0) { setActiveJobs(adopted); ensurePolling(); }
          });
          return function () {
            alive = false;
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          };
        }, []);

        // Primary work: the two print flows, T恤二创 (which consumes both a T恤
        // and a print, so it belongs with the generation-facing modules), and
        // 工作流 — scheduled/manual automation, which sits here rather than below
        // the divider because it *does* work on its own rather than storing
        // material for someone else to use.
        // T恤管理 is pure upload/storage housekeeping, not a generation step, so
        // it sits in its own de-emphasized group below a divider rather than
        // competing for attention with the modules users actually generate from.
        function navButton(item) {
          var name = item[0]; var IconFn = item[1]; var muted = item[2];
          var selected = view === name;
          return h("button", {
            key: name,
            onClick: function () { setView(name); },
            style: {
              display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "9px 12px", margin: "2px 0",
              textAlign: "left", border: 0, borderRadius: 10,
              background: selected ? "#eceef1" : "transparent",
              color: selected ? "#1c1d1f" : (muted ? "#8a8d94" : "#5b5e66"),
              cursor: "pointer", fontSize: muted ? 12.5 : 13.5, fontWeight: selected ? 600 : 400
            }
          }, h("span", { style: { display: "flex", flex: "0 0 auto" } }, IconFn(muted ? 14 : 16)), h("span", null, name));
        }
        var primaryNav = [["印花提取", IconLayers], ["印花二创", IconWand], ["T恤二创", IconSparkle], ["工作流", IconFlow], ["成品库", IconGallery]].map(navButton);
        // 通用工作台 is the free-form daily driver rather than a step in the print
        // pipeline, so it sits below the divider with the other non-pipeline items.
        var secondaryNav = [["通用工作台", IconSpark, true], ["T恤管理", IconShirt, true], ["提示词管理", IconBookmark, true], ["场景图管理", IconImage, true]].map(navButton);

        // Render ALL views but hide the inactive ones with display:none. The
        // workbench's tabs switch the visible view, but never unmount the others,
        // so an in-progress generation keeps polling and its placeholder + live
        // progress survive a tab switch instead of vanishing mid-task.
        var recreatedPrints = [];
        recreations.forEach(function (r) {
          r.prints.forEach(function (p) {
            recreatedPrints.push({ id: p.id, file: p.file, sourceName: r.prompt || r.sourceName || r.style || "二创印花" });
          });
        });
        var viewEls = [
          h(PrintExtract, { library: library, setLibrary: setLibrary, onZoom: setLightboxImage, prompts: prompts, startJob: startJob, activeJobs: activeJobs }),
          h(PrintRecreate, { sourcePrints: library, recreations: recreations, setRecreations: setRecreations, onZoom: setLightboxImage, prompts: prompts, startJob: startJob, activeJobs: activeJobs }),
          h(TshirtRecreate, { tshirts: tshirts, sourcePrints: recreatedPrints, recreations: tshirtRecreations, setRecreations: setTshirtRecreations, onZoom: setLightboxImage, prompts: prompts, startJob: startJob, activeJobs: activeJobs }),
          h(WorkflowManager, {
            workflows: workflows,
            refresh: fetchState,
            // The pipeline's results panel shows the artefacts its first three
            // stages wrote into the normal feeds, so it reads them from here
            // rather than fetching a second copy of the same records.
            library: library,
            recreations: recreations,
            tshirtRecreations: tshirtRecreations,
            onZoom: setLightboxImage,
            // The finished shelf has its own module; the workflow links into it
            // rather than growing a second, thinner copy of the same gallery.
            onOpenProducts: function () { setView("成品库"); }
          }),
          h(ProductLibrary, { onZoom: setLightboxImage }),
          h(GeneralWorkbench, { generations: generations, setGenerations: setGenerations, onZoom: setLightboxImage, prompts: prompts, startJob: startJob, activeJobs: activeJobs }),
          h(TshirtManager, { tshirts: tshirts, setTshirts: setTshirts, onZoom: setLightboxImage }),
          h(PromptManager, { prompts: prompts, setPrompts: setPrompts }),
          h(SceneManager, { scenes: scenes, setScenes: setScenes, onZoom: setLightboxImage, active: view === "场景图管理" })
        ];
        var viewNames = ["印花提取", "印花二创", "T恤二创", "工作流", "成品库", "通用工作台", "T恤管理", "提示词管理", "场景图管理"];
        var content = h(React.Fragment, null,
          viewEls.map(function (el, i) {
            var active = view === viewNames[i];
            return h("div", { key: viewNames[i], style: { display: active ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" } }, el);
          }));

        return h(React.Fragment, null,
          h("div", { ref: rootRef, className: ECOM_ROOT_CLASS, style: { height: "100%", minHeight: 0, overflow: "hidden", display: "flex", background: UI.bg, color: UI.text } },
            h("nav", { style: { flex: "0 0 auto", width: 176, padding: "20px 14px", background: "#ffffff", borderRight: "1px solid #ececf0", boxSizing: "border-box" } },
              h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "2px 8px 14px" } },
                h("span", { style: { display: "flex", color: UI.text } }, IconBox(18)),
                h("h2", { style: { fontSize: 15, margin: 0, fontWeight: 700, color: UI.text } }, "电商工作台")),
              h("div", { style: { color: UI.muted, fontSize: 11.5, padding: "0 8px 16px" } }, "印花管理"),
              primaryNav,
              h("div", { style: { height: 1, background: "#ececf0", margin: "14px 4px" } }),
              secondaryNav),
            h("main", { style: { flex: 1, minWidth: 0, minHeight: 0, padding: "18px 30px 28px", overflow: "hidden", display: "flex", flexDirection: "column", background: UI.bg } },
              loadError ? h("div", { style: { flex: "0 0 auto", marginBottom: 10, padding: "8px 12px", borderRadius: 10, background: "#fdf1f0", color: "#b23c2e", fontSize: 12.5 } }, loadError) : null,
              h("div", { style: { flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" } }, content))),
          h(Lightbox, { image: lightboxImage, onClose: function () { setLightboxImage(null); } }));
      }

      // ---------- 印花提取 ------------------------------------------------
      function PrintExtract(props) {
        var library = props.library; var setLibrary = props.setLibrary;
        var onZoom = props.onZoom;
        var pastedState = React.useState([]);
        var pasted = pastedState[0]; var setPasted = pastedState[1];
        var promptState = React.useState("");
        var prompt = promptState[0]; var setPrompt = promptState[1];
        var errorState = React.useState("");
        var error = errorState[0]; var setError = errorState[1];
        var settingsOpenState = React.useState(false);
        var settingsOpen = settingsOpenState[0]; var setSettingsOpen = settingsOpenState[1];
        var optsState = React.useState({ removeBg: true });
        var opts = optsState[0]; var setOpts = optsState[1];
        var fileInputRef = React.useRef(null);
        // Jobs are owned by the workbench; this view only starts them and renders
        // the placeholders for its own kind, so they survive tab switches.
        var prompts = props.prompts || [];
        var runningJobs = (props.activeJobs || []).filter(function (j) { return j.kind === "extract"; });
        var running = runningJobs.some(function (j) { return j.status === "running"; });

        /** Read real image files into the pending strip (data URL per file). */
        function addFiles(files) {
          if (running) return;
          var images = Array.prototype.slice.call(files || []).filter(function (f) {
            return f && typeof f.type === "string" && f.type.indexOf("image/") === 0;
          });
          if (images.length === 0) return;
          images.forEach(function (file) {
            var id = rid();
            setPasted(function (prev) { return prev.concat([{ id: id, name: file.name || "image", dataUrl: "" }]); });
            readAsDataUrl(file).then(function (dataUrl) {
              setPasted(function (prev) {
                return prev.map(function (s) { return s.id === id ? Object.assign({}, s, { dataUrl: dataUrl }) : s; });
              });
            }, function () {
              setPasted(function (prev) { return prev.filter(function (s) { return s.id !== id; }); });
            });
          });
        }
        function clearPasted() { setPasted([]); }
        function removePasted(id) { setPasted(function (prev) { return prev.filter(function (s) { return s.id !== id; }); }); }
        function onPaste(e) {
          var files = [];
          var items = e.clipboardData && e.clipboardData.items;
          if (items) for (var i = 0; i < items.length; i++) {
            if (items[i].kind === "file") {
              var file = items[i].getAsFile();
              if (file) files.push(file);
            }
          }
          if (files.length > 0) { e.preventDefault(); addFiles(files); }
        }
        function onDrop(e) {
          if (!e.dataTransfer) return;
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }
        function onPickFiles(e) {
          addFiles(e.target.files);
          e.target.value = "";
        }
        function startExtract() {
          var ready = pasted.filter(function (s) { return s.dataUrl !== ""; });
          if (ready.length === 0) return;
          injectSpinnerStyle();
          setError("");
          // ONE submission = ONE task = ONE extracted print. All pasted/uploaded
          // images are sent together as references and combined into a single
          // output print by the host's provider.
          props.startJob("extract", { title: "提取印花", subtitle: prompt || ("共 " + ready.length + " 张参考图"), total: 1 }, {
            images: ready.map(function (s) { return { name: s.name, dataUrl: s.dataUrl }; }),
            prompt: prompt,
            removeBg: opts.removeBg
          });
          setPasted([]);
        }
        function removeFromLibrary(id) {
          if (!confirmAction("确定移除这张印花？")) return;
          setLibrary(function (prev) { return prev.filter(function (p) { return p.id !== id; }); });
          apiPost("/delete", { kind: "library", id: id });
        }
        function clearLibrary() {
          if (!confirmAction("确定清空印花原图库？")) return;
          setLibrary([]);
          apiPost("/clear", { kind: "library" });
        }

        var readyCount = pasted.filter(function (s) { return s.dataUrl !== ""; }).length;

        var pastedRow = pasted.length > 0 ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, paddingBottom: 10, borderBottom: "1px solid #ececf0", marginBottom: 10 } },
          pasted.map(function (s) {
            return h("div", { key: s.id, style: { position: "relative" } },
              Thumb({ src: s.dataUrl, size: 44, label: s.name, onZoom: onZoom }),
              h("button", { onClick: function () { removePasted(s.id); }, style: { position: "absolute", top: -6, right: -6, width: 17, height: 17, borderRadius: 999, border: "1px solid #e5e5ea", background: "#fff", color: "#9aa0a8", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconClose(9)));
          })) : null;

        var settingsPanel = settingsOpen ? h("div", { style: { display: "flex", gap: 18, alignItems: "center", padding: "10px 2px 0", borderTop: "1px solid #ececf0", marginTop: 10, fontSize: 12.5, color: UI.text2 } },
          h("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer" } },
            h("input", { type: "checkbox", checked: opts.removeBg, onChange: function (e) { setOpts(Object.assign({}, opts, { removeBg: e.target.checked })); } }), "自动去背景")) : null;

        var submitDisabled = readyCount === 0;
        var composer = h("div", { style: { flex: "0 0 auto", width: "100%", margin: "0 0 16px" } },
          h("div", {
            onDrop: onDrop, onDragOver: function (e) { e.preventDefault(); },
            style: { border: "1px solid #ececf0", borderRadius: 14, background: "#ffffff", padding: "12px 14px", boxShadow: "0 1px 6px rgba(20,20,25,0.04)" }
          },
            h("input", { ref: fileInputRef, type: "file", accept: "image/*", multiple: true, onChange: onPickFiles, style: { display: "none" } }),
            pastedRow,
            h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
              h("button", { onClick: function () { if (fileInputRef.current) fileInputRef.current.click(); }, title: "上传图片", style: { flex: "0 0 auto", width: 34, height: 34, borderRadius: 9, border: 0, background: "transparent", color: UI.text2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" } }, IconUpload(18)),
              h("textarea", { value: prompt, onPaste: onPaste, onChange: function (e) { setPrompt(e.target.value); }, placeholder: "What will you imagine?", style: { flex: 1, border: 0, outline: 0, resize: "none", minHeight: 22, maxHeight: 140, fontSize: 14.5, lineHeight: "22px", fontFamily: "inherit", color: UI.text, padding: "6px 4px", background: "transparent", textAlign: "left" } }),
              h(PromptPicker, { prompts: prompts, onPick: setPrompt }),
              h("button", { onClick: function () { setSettingsOpen(!settingsOpen); }, title: "设置", style: { flex: "0 0 auto", width: 34, height: 34, borderRadius: 9, border: 0, background: settingsOpen ? "#eceef1" : "transparent", color: settingsOpen ? UI.text : UI.text2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" } }, IconSettings(17)),
              h("button", { onClick: startExtract, disabled: submitDisabled, title: "提取", style: Object.assign({}, UI.btnPrimary, submitDisabled ? { opacity: 0.4, cursor: "not-allowed" } : {}, { flex: "0 0 auto", width: 34, height: 34, padding: 0, borderRadius: 9, justifyContent: "center" }) }, IconArrowRight(16))),
            settingsPanel));

        // Live progress now lives in the results-area placeholder below, so the
        // composer status row only shows a hard/partial error.
        var statusLine = error
          ? h("div", { style: { flex: "0 0 auto", textAlign: "left", margin: "0 0 10px", fontSize: 12.5, color: "#b23c2e" } }, error)
          : null;

        // The library IS the result feed: every generated print lands here directly,
        // newest first — no separate "add to library" step. Each row still shows the
        // source thumbnail + prompt on the left so the print stays traceable to its input.
        var toolbar = library.length > 0 ? h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", margin: "2px 2px 10px" } },
          h("span", { style: { ...UI.muted } }, library.length + " 张"),
          h("button", { style: Object.assign({}, UI.btnGhost, { display: "flex", alignItems: "center", gap: 5 }), onClick: clearLibrary },
            IconTrash(13), "清空")) : null;

        // A visible placeholder appears as soon as a job is submitted, so the
        // task is shown in the results feed while it runs (and survives a tab
        // switch, since the workbench owns the jobs, not this view).
        var hasPending = runningJobs.length > 0;
        var pendingRow = hasPending ? runningJobs.map(function (j) { return h(PendingRow, { key: j.localId, job: j }); }) : null;
        var list;
        if (library.length > 0 || hasPending) {
          list = h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 10, padding: "4px 4px 12px" } },
            pendingRow,
            library.slice().sort(byNewest).map(function (p) {
              return h("div", { key: p.id, style: { display: "flex", alignItems: "center", gap: 16, padding: 12, background: "#ffffff", border: "1px solid #ececf0", borderRadius: 14 } },
                h("div", { style: { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 12 } },
                  h("div", { style: { borderRadius: 10, overflow: "hidden", flex: "0 0 auto" } }, Thumb({ src: fileUrl(p.sourceFile), size: 72, label: p.sourceName, onZoom: onZoom })),
                  h("div", { style: { minWidth: 0, textAlign: "left", display: "flex", alignItems: "flex-start", gap: 6 } },
                    h("div", { style: { flex: 1, minWidth: 0, color: UI.text, fontSize: 13, lineHeight: "19px", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", textAlign: "left" } }, p.prompt || p.sourceName),
                    p.prompt ? h(CopyButton, { text: p.prompt }) : null)),
                h("span", { style: { flex: "0 0 auto", color: "#c7c8cc", display: "flex" } }, IconArrowRight(16)),
                h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" } },
                  h("div", { style: { borderRadius: 10, overflow: "hidden" } }, Thumb({ src: fileUrl(p.file), size: 72, label: p.sourceName, onZoom: onZoom })),
                  h("button", { title: "移除", style: { flex: "0 0 auto", width: 30, height: 30, borderRadius: 8, border: "1px solid #ececf0", background: "#f5f5f7", color: UI.text2, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }, onClick: function () { removeFromLibrary(p.id); } }, IconTrash(14))));
            }));
        } else {
          list = h("div", { style: { flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" } },
            h("div", { style: { ...UI.muted, textAlign: "center" } }, "暂无内容"));
        }

        return h("div", { style: { flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" } },
          composer, statusLine, toolbar, list);
      }

      // ---------- 印花二创 mock ------------------------------------------
      // Same shape as 印花提取: one composer on top, one accumulating result feed
      // below. The input is ONE print picked from the 原图库 plus a prompt; the
      // batch size decides how many variants that one print produces at once,
      // so each feed row is (one source print) -> (N re-created prints).
      var RECREATE_COUNTS = [1, 2, 4, 6];
      function PrintRecreate(props) {
        var sourcePrints = props.sourcePrints;
        var recreations = props.recreations; var setRecreations = props.setRecreations;
        var onZoom = props.onZoom;
        var pickedState = React.useState(null); // exactly one selected source print id
        var picked = pickedState[0]; var setPicked = pickedState[1];
        var pickerOpenState = React.useState(false);
        var pickerOpen = pickerOpenState[0]; var setPickerOpen = pickerOpenState[1];
        var promptState = React.useState("");
        var prompt = promptState[0]; var setPrompt = promptState[1];
        var styleState = React.useState(STYLES[0]);
        var style = styleState[0]; var setStyle = styleState[1];
        var countState = React.useState(1); // default 1 output until the user asks for more
        var count = countState[0]; var setCount = countState[1];
        var settingsOpenState = React.useState(false);
        var settingsOpen = settingsOpenState[0]; var setSettingsOpen = settingsOpenState[1];
        var errorState = React.useState("");
        var error = errorState[0]; var setError = errorState[1];
        var prompts = props.prompts || [];
        var runningJobs = (props.activeJobs || []).filter(function (j) { return j.kind === "recreate"; });
        var running = runningJobs.some(function (j) { return j.status === "running"; });
        // A source can come from the 原图库 picker OR be pasted/uploaded straight
        // here as a 印花 image — mutually exclusive, whichever was chosen last.
        var pastedState = React.useState(null); // {name, dataUrl}
        var pasted = pastedState[0]; var setPasted = pastedState[1];
        var fileInputRef = React.useRef(null);

        var pickedPrint = sourcePrints.filter(function (p) { return p.id === picked; })[0] || null;

        function pick(id) {
          var next = id === picked ? null : id;
          setPicked(next);
          if (next !== null) setPasted(null); // picking from 原图库 replaces a pasted source
        }
        function setPastedFromFile(file) {
          if (!file || typeof file.type !== "string" || file.type.indexOf("image/") !== 0) return;
          var name = file.name || "image";
          readAsDataUrl(file).then(function (dataUrl) {
            setPasted({ name: name, dataUrl: dataUrl });
            setPicked(null); // a pasted source replaces any library selection
          });
        }
        function onPasteSource(e) {
          var files = [];
          var items = e.clipboardData && e.clipboardData.items;
          if (items) for (var i = 0; i < items.length; i++) {
            if (items[i].kind === "file") { var f = items[i].getAsFile(); if (f) files.push(f); }
          }
          if (files.length > 0) { e.preventDefault(); setPastedFromFile(files[0]); }
        }
        function onDropSource(e) {
          if (!e.dataTransfer) return;
          e.preventDefault();
          if (e.dataTransfer.files && e.dataTransfer.files[0]) setPastedFromFile(e.dataTransfer.files[0]);
        }
        function onPickSource(e) {
          var f = e.target.files && e.target.files[0];
          if (f) setPastedFromFile(f);
          e.target.value = "";
        }
        function clearPastedSource() { setPasted(null); }
        function startGen() {
          var hasSource = !!pickedPrint || !!pasted;
          if (!hasSource) return;
          injectSpinnerStyle();
          setError("");
          var body = { prompt: prompt, style: style, count: count };
          if (pasted) {
            body.sourceImage = pasted.dataUrl;
            body.sourceName = pasted.name || "image";
          } else {
            body.sourceId = pickedPrint.id;
          }
          props.startJob("recreate", { title: "印花二创", subtitle: prompt || (style ? style + " · " : "") + "正在生成", total: count }, body);
          setPicked(null);
          setPasted(null);
        }
        function removeRecreation(id) {
          if (!confirmAction("确定移除这一组二创结果？")) return;
          setRecreations(function (prev) { return prev.filter(function (r) { return r.id !== id; }); });
          apiPost("/delete", { kind: "recreation", id: id });
        }
        // Removing the last variant of a row drops the whole row.
        function removeVariant(rowId, printId) {
          if (!confirmAction("确定移除这个变体？")) return;
          setRecreations(function (prev) {
            return prev.map(function (r) {
              if (r.id !== rowId) return r;
              return Object.assign({}, r, { prints: r.prints.filter(function (p) { return p.id !== printId; }) });
            }).filter(function (r) { return r.prints.length > 0; });
          });
          apiPost("/delete", { kind: "variant", id: rowId, printId: printId });
        }
        function clearRecreations() {
          if (!confirmAction("确定清空所有二创结果？")) return;
          setRecreations([]);
          apiPost("/clear", { kind: "recreations" });
        }

        var pickedRow = pickedPrint ? h("div", { style: { display: "flex", gap: 8, paddingBottom: 10, borderBottom: "1px solid #ececf0", marginBottom: 10 } },
          h("div", { style: { position: "relative" } },
            Thumb({ src: fileUrl(pickedPrint.file), size: 44, label: pickedPrint.sourceName, onZoom: onZoom }),
            h("button", { onClick: function () { setPicked(null); }, style: { position: "absolute", top: -6, right: -6, width: 17, height: 17, borderRadius: 999, border: "1px solid #e5e5ea", background: "#fff", color: "#9aa0a8", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconClose(9)))) : null;

        // Picker thumbnails already use click-to-select; a separate small zoom
        // icon (stopPropagation) opens the lightbox without hijacking that click.
        var pickerPanel = pickerOpen ? h("div", { style: { borderTop: "1px solid #ececf0", marginTop: 10, paddingTop: 10, maxHeight: 168, overflow: "auto" } },
          sourcePrints.length === 0
            ? h("div", { style: { ...UI.muted, padding: "10px 2px" } }, "暂无印花")
            : h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
                sourcePrints.map(function (p) {
                  var on = picked === p.id;
                  return h("div", { key: p.id, style: { position: "relative" } },
                    h("button", {
                      onClick: function () { pick(p.id); },
                      style: { position: "relative", padding: 0, borderRadius: 10, border: on ? "2px solid #1c1d1f" : "1px solid #ececf0", background: "transparent", cursor: "pointer", lineHeight: 0 }
                    },
                      Thumb({ src: fileUrl(p.file), size: 52, label: p.sourceName }),
                      on ? h("span", { style: { position: "absolute", right: 2, bottom: 2, color: "#fff", background: "rgba(28,29,31,.65)", borderRadius: 999, width: 15, height: 15, display: "flex", alignItems: "center", justifyContent: "center" } }, IconCheck(9)) : null),
                    h("button", {
                      title: "放大预览",
                      onClick: function (e) { e.stopPropagation(); if (onZoom) onZoom({ src: fileUrl(p.file), label: p.sourceName }); },
                      style: { position: "absolute", top: -6, left: -6, width: 17, height: 17, borderRadius: 999, border: "1px solid #e5e5ea", background: "#fff", color: "#5b5e66", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }
                    }, IconZoom(9)));
                }))) : null;

        var settingsPanel = settingsOpen ? h("div", { style: { padding: "10px 2px 0", borderTop: "1px solid #ececf0", marginTop: 10 } },
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            STYLES.map(function (st) {
              return h("button", { key: st, onClick: function () { setStyle(st); }, style: st === style ? UI.chipOn : UI.chip }, st);
            })),
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 } },
            h("span", { style: { ...UI.muted } }, "输出"),
            RECREATE_COUNTS.map(function (n) {
              return h("button", { key: n, onClick: function () { setCount(n); }, style: count === n ? UI.chipOn : UI.chip }, n + " 张");
            }))) : null;

        var pastedPreviewRow = pasted ? h("div", { style: { display: "flex", gap: 8, paddingBottom: 10, borderBottom: "1px solid #ececf0", marginBottom: 10 } },
          h("div", { style: { position: "relative" } },
            Thumb({ src: pasted.dataUrl, size: 44, label: pasted.name, onZoom: onZoom }),
            h("button", { onClick: clearPastedSource, style: { position: "absolute", top: -6, right: -6, width: 17, height: 17, borderRadius: 999, border: "1px solid #e5e5ea", background: "#fff", color: "#9aa0a8", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconClose(9)))) : null;

        var composer = h("div", { style: { flex: "0 0 auto", width: "100%", margin: "0 0 16px" } },
          h("div", {
            onDrop: onDropSource, onDragOver: function (e) { e.preventDefault(); },
            style: { border: "1px solid #ececf0", borderRadius: 14, background: "#ffffff", padding: "12px 14px", boxShadow: "0 1px 6px rgba(20,20,25,0.04)" }
          },
            h("input", { ref: fileInputRef, type: "file", accept: "image/*", onChange: onPickSource, style: { display: "none" } }),
            pickedRow,
            pastedPreviewRow,
            h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
              h("button", { onClick: function () { if (fileInputRef.current) fileInputRef.current.click(); }, title: "上传印花图片", style: { flex: "0 0 auto", width: 34, height: 34, borderRadius: 9, border: 0, background: "transparent", color: UI.text2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" } }, IconUpload(18)),
              h("button", { onClick: function () { setPickerOpen(!pickerOpen); }, title: "选择印花", style: { flex: "0 0 auto", width: 34, height: 34, borderRadius: 9, border: 0, background: pickerOpen ? "#eceef1" : "transparent", color: pickerOpen ? UI.text : UI.text2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" } }, IconLayers(18)),
              h("textarea", { value: prompt, onPaste: onPasteSource, onChange: function (e) { setPrompt(e.target.value); }, placeholder: "How should it change? 可粘贴印花图片", style: { flex: 1, border: 0, outline: 0, resize: "none", minHeight: 22, maxHeight: 140, fontSize: 14.5, lineHeight: "22px", fontFamily: "inherit", color: UI.text, padding: "6px 4px", background: "transparent", textAlign: "left" } }),
              h(PromptPicker, { prompts: prompts, onPick: setPrompt }),
              h("button", { onClick: function () { setSettingsOpen(!settingsOpen); }, title: style, style: { flex: "0 0 auto", width: 34, height: 34, borderRadius: 9, border: 0, background: settingsOpen ? "#eceef1" : "transparent", color: settingsOpen ? UI.text : UI.text2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" } }, IconSettings(17)),
              h("button", { onClick: startGen, disabled: !pickedPrint && !pasted, title: "二创", style: Object.assign({}, UI.btnPrimary, (!pickedPrint && !pasted) ? { opacity: 0.4, cursor: "not-allowed" } : {}, { flex: "0 0 auto", width: 34, height: 34, padding: 0, borderRadius: 9, justifyContent: "center" }) }, IconArrowRight(16))),
            pickerPanel,
            settingsPanel));

        var statusLine = error
          ? h("div", { style: { flex: "0 0 auto", textAlign: "left", margin: "0 0 10px", fontSize: 12.5, color: "#b23c2e" } }, error)
          : null;

        var totalPrints = recreations.reduce(function (n, r) { return n + r.prints.length; }, 0);
        var toolbar = h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", margin: "2px 2px 10px" } },
          h("span", { style: { ...UI.muted } }, recreations.length > 0 ? (totalPrints + " 张") : ""),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h(ImportFolderButton, { onImported: function () {
              // Prints imported straight from disk (no generation) become normal
              // 二创印花 rows, so they're immediately selectable in T恤二创.
              apiGet("/state").then(function (state) { if (state && state.ok === true) setRecreations(state.recreations || []); });
            } }),
            recreations.length > 0 ? h("button", { style: Object.assign({}, UI.btnGhost, { display: "flex", alignItems: "center", gap: 5 }), onClick: clearRecreations },
              IconTrash(13), "清空") : null));

        var hasPending = runningJobs.length > 0;
        var pendingRow = hasPending ? runningJobs.map(function (j) { return h(PendingRow, { key: j.localId, job: j }); }) : null;
        var list;
        if (recreations.length > 0 || hasPending) {
          list = h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 10, padding: "4px 4px 12px" } },
            pendingRow,
            recreations.slice().sort(byNewest).map(function (r) {
              return h("div", { key: r.id, style: { display: "flex", alignItems: "center", gap: 16, padding: 12, background: "#ffffff", border: "1px solid #ececf0", borderRadius: 14 } },
                h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 12, maxWidth: 300, minWidth: 0 } },
                  h("div", { style: { borderRadius: 10, overflow: "hidden", flex: "0 0 auto" } }, Thumb({ src: fileUrl(r.sourceFile), size: 72, label: r.sourceName, onZoom: onZoom })),
                  h("div", { style: { minWidth: 0, textAlign: "left" } },
                    h("div", { style: { display: "flex", alignItems: "flex-start", gap: 6 } },
                      h("div", { style: { flex: 1, minWidth: 0, color: UI.text, fontSize: 13, lineHeight: "19px", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", textAlign: "left" } }, r.prompt || r.sourceName),
                      r.prompt ? h(CopyButton, { text: r.prompt }) : null),
                    h("div", { style: { ...UI.muted, fontSize: 11.5, marginTop: 3 } }, (r.style ? r.style + " · " : "") + r.prints.length + " 张"))),
                h("span", { style: { flex: "0 0 auto", color: "#c7c8cc", display: "flex" } }, IconArrowRight(16)),
                h("div", { style: { flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "flex-end" } },
                  r.prints.map(function (p) {
                    return h("div", { key: p.id, style: { position: "relative" } },
                      h("div", { style: { borderRadius: 10, overflow: "hidden" } }, Thumb({ src: fileUrl(p.file), size: 72, label: "", onZoom: onZoom })),
                      h("button", { title: "移除", onClick: function () { removeVariant(r.id, p.id); }, style: { position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: 999, border: "1px solid #e5e5ea", background: "#fff", color: "#9aa0a8", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconClose(10)));
                  })),
                h("button", { title: "移除整组", style: { flex: "0 0 auto", width: 30, height: 30, borderRadius: 8, border: "1px solid #ececf0", background: "#f5f5f7", color: UI.text2, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }, onClick: function () { removeRecreation(r.id); } }, IconTrash(14)));
            }));
        } else {
          list = h("div", { style: { flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" } },
            h("div", { style: { ...UI.muted, textAlign: "center" } }, "暂无内容"));
        }

        return h("div", { style: { flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" } },
          composer, statusLine, toolbar, list);
      }

      // ---------- T恤二创 --------------------------------------------------
      // Same job/poll shape as 印花二创, but the composer picks ONE T恤 (its
      // photos can multi-select — front/back/detail) and one or more prints
      // FROM 印花二创's RESULTS (the `sourcePrints` prop here is the flattened
      // recreation feed, not the raw 原图库). Multi-select on the photo/print
      // side is a cross product: every selected photo of that one T恤 is
      // paired with every selected print, one generation per pair, each pair
      // becoming its own feed row (photo + print) -> 1 print.
      function TshirtRecreate(props) {
        var tshirts = props.tshirts;
        var sourcePrints = props.sourcePrints;
        var recreations = props.recreations; var setRecreations = props.setRecreations;
        var onZoom = props.onZoom;
        var pickedTshirtIdState = React.useState(null); // single-select: one T恤 id
        var pickedTshirtId = pickedTshirtIdState[0]; var setPickedTshirtId = pickedTshirtIdState[1];
        // Which of that T恤's photos to use: multi-select array of file names.
        // Empty means "use its first photo" (the picker below shows that as
        // the pre-selected tile so the default is visible, not implicit).
        var pickedPhotosState = React.useState([]);
        var pickedPhotos = pickedPhotosState[0]; var setPickedPhotos = pickedPhotosState[1];
        var pickedPrintsState = React.useState([]); // multi-select: array of print ids
        var pickedPrints = pickedPrintsState[0]; var setPickedPrints = pickedPrintsState[1];
        var tshirtPickerOpenState = React.useState(false);
        var tshirtPickerOpen = tshirtPickerOpenState[0]; var setTshirtPickerOpen = tshirtPickerOpenState[1];
        var printPickerOpenState = React.useState(false);
        var printPickerOpen = printPickerOpenState[0]; var setPrintPickerOpen = printPickerOpenState[1];
        var promptState = React.useState("");
        var prompt = promptState[0]; var setPrompt = promptState[1];
        var errorState = React.useState("");
        var error = errorState[0]; var setError = errorState[1];
        var prompts = props.prompts || [];
        var runningJobs = (props.activeJobs || []).filter(function (j) { return j.kind === "tshirtRecreate"; });
        var running = runningJobs.some(function (j) { return j.status === "running"; });

        var tshirtObj = tshirts.filter(function (t) { return t.id === pickedTshirtId; })[0] || null;
        var printObjs = sourcePrints.filter(function (p) { return pickedPrints.indexOf(p.id) !== -1; });
        // Photos actually used: the explicit multi-select if any, else the
        // T恤's first photo (mirrors the host's own default).
        var chosenPhotos = tshirtObj
          ? (pickedPhotos.length > 0 ? pickedPhotos.filter(function (f) { return tshirtObj.images.indexOf(f) !== -1; }) : (tshirtObj.images ? [tshirtObj.images[0]] : []))
          : [];
        var ready = tshirtObj !== null && chosenPhotos.length > 0 && printObjs.length > 0;
        var pairCount = chosenPhotos.length * printObjs.length;

        function pickTshirt(id) {
          setPickedTshirtId(function (prev) { return id === prev ? null : id; });
          setPickedPhotos([]); // switching T恤 resets which of its photos are chosen
        }
        function togglePhoto(file) {
          setPickedPhotos(function (prev) { return prev.indexOf(file) !== -1 ? prev.filter(function (x) { return x !== file; }) : prev.concat([file]); });
        }
        function togglePrint(id) {
          setPickedPrints(function (prev) { return prev.indexOf(id) !== -1 ? prev.filter(function (x) { return x !== id; }) : prev.concat([id]); });
        }
        function removePrint(id) { setPickedPrints(function (prev) { return prev.filter(function (x) { return x !== id; }); }); }

        function startGen() {
          if (!ready) return;
          injectSpinnerStyle();
          setError("");
          props.startJob("tshirtRecreate", { title: "T恤二创", subtitle: prompt || "T恤 × 印花 · 正在生成", total: pairCount }, {
            tshirtId: tshirtObj.id,
            tshirtImages: chosenPhotos,
            printIds: printObjs.map(function (p) { return p.id; }),
            prompt: prompt
          });
          setPickedTshirtId(null);
          setPickedPhotos([]);
          setPickedPrints([]);
        }
        function removeRecreation(id) {
          if (!confirmAction("确定移除这一组T恤二创结果？")) return;
          setRecreations(function (prev) { return prev.filter(function (r) { return r.id !== id; }); });
          apiPost("/delete", { kind: "tshirtRecreation", id: id });
        }
        function removeVariant(rowId, printId) {
          if (!confirmAction("确定移除这个变体？")) return;
          setRecreations(function (prev) {
            return prev.map(function (r) {
              if (r.id !== rowId) return r;
              return Object.assign({}, r, { prints: r.prints.filter(function (p) { return p.id !== printId; }) });
            }).filter(function (r) { return r.prints.length > 0; });
          });
          apiPost("/delete", { kind: "tshirtVariant", id: rowId, printId: printId });
        }
        function clearRecreations() {
          if (!confirmAction("确定清空所有T恤二创结果？")) return;
          setRecreations([]);
          apiPost("/clear", { kind: "tshirtRecreations" });
        }

        function closeChipBtn(onClick) {
          return h("button", { onClick: onClick, style: { position: "absolute", top: -6, right: -6, width: 17, height: 17, borderRadius: 999, border: "1px solid #e5e5ea", background: "#fff", color: "#9aa0a8", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconClose(9));
        }

        var pickedRow = (tshirtObj || printObjs.length > 0) ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", paddingBottom: 10, borderBottom: "1px solid #ececf0", marginBottom: 10 } },
          tshirtObj ? chosenPhotos.map(function (file, idx) {
            return h("div", { key: "t-" + file, style: { position: "relative" } },
              Thumb({ src: fileUrl(file), size: 44, label: tshirtObj.name + " " + (idx + 1), onZoom: onZoom }),
              idx === 0 ? closeChipBtn(function () { setPickedTshirtId(null); setPickedPhotos([]); }) : null);
          }) : null,
          (tshirtObj && printObjs.length > 0) ? h("span", { style: { color: "#c7c8cc", flex: "0 0 auto" } }, IconPlus(12)) : null,
          printObjs.map(function (p) {
            return h("div", { key: "p-" + p.id, style: { position: "relative" } },
              Thumb({ src: fileUrl(p.file), size: 44, label: p.sourceName, onZoom: onZoom }),
              closeChipBtn(function () { removePrint(p.id); }));
          })) : null;

        // Multi-select variant of the picker grid: clicking a tile toggles its
        // membership instead of replacing the single selection.
        function multiPickerGrid(items, pickedIds, onToggle, thumbOf, labelOf, emptyText) {
          if (items.length === 0) return h("div", { style: { ...UI.muted, padding: "10px 2px" } }, emptyText);
          return h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
            items.map(function (item) {
              var on = pickedIds.indexOf(item.id) !== -1;
              var src = thumbOf(item);
              return h("div", { key: item.id, style: { position: "relative" } },
                h("button", {
                  onClick: function () { onToggle(item.id); },
                  style: { position: "relative", padding: 0, borderRadius: 10, border: on ? "2px solid #1c1d1f" : "1px solid #ececf0", background: "transparent", cursor: "pointer", lineHeight: 0 }
                },
                  Thumb({ src: src, size: 52, label: labelOf(item) }),
                  on ? h("span", { style: { position: "absolute", right: 2, bottom: 2, color: "#fff", background: "rgba(28,29,31,.65)", borderRadius: 999, width: 15, height: 15, display: "flex", alignItems: "center", justifyContent: "center" } }, IconCheck(9)) : null),
                h("button", {
                  title: "放大预览",
                  onClick: function (e) { e.stopPropagation(); if (onZoom) onZoom({ src: src, label: labelOf(item) }); },
                  style: { position: "absolute", top: -6, left: -6, width: 17, height: 17, borderRadius: 999, border: "1px solid #e5e5ea", background: "#fff", color: "#5b5e66", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }
                }, IconZoom(9)));
            }));
        }

        // T恤 picker is single-select: pick ONE T恤's card (its own photos are
        // chosen separately below, and CAN multi-select).
        var tshirtPickerPanel = tshirtPickerOpen ? h("div", { style: { borderTop: "1px solid #ececf0", marginTop: 10, paddingTop: 10, maxHeight: 168, overflow: "auto" } },
          tshirts.length === 0
            ? h("div", { style: { ...UI.muted, padding: "10px 2px" } }, "暂无T恤，先在「T恤管理」上传")
            : h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
                tshirts.slice().sort(byNewest).map(function (t) {
                  var on = t.id === pickedTshirtId;
                  return h("button", {
                    key: t.id, onClick: function () { pickTshirt(t.id); },
                    style: { position: "relative", padding: 0, borderRadius: 10, border: on ? "2px solid #1c1d1f" : "1px solid #ececf0", background: "transparent", cursor: "pointer", lineHeight: 0 }
                  },
                    Thumb({ src: fileUrl(t.images[0]), size: 52, label: t.name }),
                    on ? h("span", { style: { position: "absolute", right: 2, bottom: 2, color: "#fff", background: "rgba(28,29,31,.65)", borderRadius: 999, width: 15, height: 15, display: "flex", alignItems: "center", justifyContent: "center" } }, IconCheck(9)) : null);
                }))) : null;

        // The selected T恤's own photos (front/back/detail): multi-select, so
        // one T恤 can generate from several of its photos at once.
        var tshirtPhotoStrip = (tshirtPickerOpen && tshirtObj && tshirtObj.images && tshirtObj.images.length > 1)
          ? h("div", { style: { borderTop: "1px dashed #ececf0", marginTop: 10, paddingTop: 10 } },
              h("div", { style: { ...UI.muted, marginBottom: 6 } }, tshirtObj.name + "：" + tshirtObj.images.length + " 张照片，可多选用于生成"),
              multiPickerGrid(
                tshirtObj.images.map(function (file, idx) { return { id: file, idx: idx }; }),
                chosenPhotos,
                function (file) { togglePhoto(file); },
                function (item) { return fileUrl(item.id); },
                function (item) { return tshirtObj.name + " " + (item.idx + 1); },
                ""
              ))
          : null;

        var printPickerPanel = printPickerOpen ? h("div", { style: { borderTop: "1px solid #ececf0", marginTop: 10, paddingTop: 10, maxHeight: 168, overflow: "auto" } },
          multiPickerGrid(sourcePrints, pickedPrints, togglePrint, function (p) { return fileUrl(p.file); }, function (p) { return p.sourceName; }, "暂无二创印花，先在「印花二创」生成")) : null;

        var pairHint = pairCount > 1 ? h("div", { style: { ...UI.muted, padding: "8px 2px 0" } }, "将生成 " + pairCount + " 组（" + chosenPhotos.length + " 张照片 × " + printObjs.length + " 张印花）") : null;

        var composer = h("div", { style: { flex: "0 0 auto", width: "100%", margin: "0 0 16px" } },
          h("div", { style: { border: "1px solid #ececf0", borderRadius: 14, background: "#ffffff", padding: "12px 14px", boxShadow: "0 1px 6px rgba(20,20,25,0.04)" } },
            pickedRow,
            h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
              h("button", { onClick: function () { setTshirtPickerOpen(!tshirtPickerOpen); setPrintPickerOpen(false); }, title: "选择T恤", style: { flex: "0 0 auto", width: 34, height: 34, borderRadius: 9, border: 0, background: tshirtPickerOpen ? "#eceef1" : "transparent", color: tshirtPickerOpen ? UI.text : UI.text2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" } }, IconShirt(18)),
              h("button", { onClick: function () { setPrintPickerOpen(!printPickerOpen); setTshirtPickerOpen(false); }, title: "选择印花（可多选）", style: { flex: "0 0 auto", width: 34, height: 34, borderRadius: 9, border: 0, background: printPickerOpen ? "#eceef1" : "transparent", color: printPickerOpen ? UI.text : UI.text2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" } }, IconLayers(18)),
              h("textarea", { value: prompt, onChange: function (e) { setPrompt(e.target.value); }, placeholder: "How should the print sit on the T恤?", style: { flex: 1, border: 0, outline: 0, resize: "none", minHeight: 22, maxHeight: 140, fontSize: 14.5, lineHeight: "22px", fontFamily: "inherit", color: UI.text, padding: "6px 4px", background: "transparent", textAlign: "left" } }),
              h(PromptPicker, { prompts: prompts, onPick: setPrompt }),
              h("button", { onClick: startGen, disabled: !ready, title: "生成", style: Object.assign({}, UI.btnPrimary, (!ready) ? { opacity: 0.4, cursor: "not-allowed" } : {}, { flex: "0 0 auto", width: 34, height: 34, padding: 0, borderRadius: 9, justifyContent: "center" }) }, IconArrowRight(16))),
            pairHint,
            tshirtPickerPanel,
            tshirtPhotoStrip,
            printPickerPanel));

        var statusLine = error
          ? h("div", { style: { flex: "0 0 auto", textAlign: "left", margin: "0 0 10px", fontSize: 12.5, color: "#b23c2e" } }, error)
          : null;

        var totalPrints = recreations.reduce(function (n, r) { return n + r.prints.length; }, 0);
        var toolbar = recreations.length > 0 ? h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", margin: "2px 2px 10px" } },
          h("span", { style: { ...UI.muted } }, totalPrints + " 张"),
          h("button", { style: Object.assign({}, UI.btnGhost, { display: "flex", alignItems: "center", gap: 5 }), onClick: clearRecreations },
            IconTrash(13), "清空")) : null;

        var hasPending = runningJobs.length > 0;
        var pendingRow = hasPending ? runningJobs.map(function (j) { return h(PendingRow, { key: j.localId, job: j }); }) : null;
        var list;
        if (recreations.length > 0 || hasPending) {
          list = h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 10, padding: "4px 4px 12px" } },
            pendingRow,
            recreations.slice().sort(byNewest).map(function (r) {
              return h("div", { key: r.id, style: { display: "flex", alignItems: "center", gap: 16, padding: 12, background: "#ffffff", border: "1px solid #ececf0", borderRadius: 14 } },
                h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10, maxWidth: 320, minWidth: 0 } },
                  h("div", { style: { borderRadius: 10, overflow: "hidden", flex: "0 0 auto" } }, Thumb({ src: fileUrl(r.tshirtFile), size: 64, label: r.tshirtName, onZoom: onZoom })),
                  h("span", { style: { color: "#c7c8cc", flex: "0 0 auto" } }, IconPlus(12)),
                  h("div", { style: { borderRadius: 10, overflow: "hidden", flex: "0 0 auto" } }, Thumb({ src: fileUrl(r.printFile), size: 64, label: "", onZoom: onZoom })),
                  h("div", { style: { minWidth: 0, textAlign: "left" } },
                    h("div", { style: { display: "flex", alignItems: "flex-start", gap: 6 } },
                      h("div", { style: { flex: 1, minWidth: 0, color: UI.text, fontSize: 13, lineHeight: "19px", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", textAlign: "left" } }, r.prompt || r.tshirtName),
                      r.prompt ? h(CopyButton, { text: r.prompt }) : null),
                    h("div", { style: { ...UI.muted, fontSize: 11.5, marginTop: 3 } }, r.prints.length + " 张"))),
                h("span", { style: { flex: "0 0 auto", color: "#c7c8cc", display: "flex" } }, IconArrowRight(16)),
                h("div", { style: { flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "flex-end" } },
                  r.prints.map(function (p) {
                    return h("div", { key: p.id, style: { position: "relative" } },
                      h("div", { style: { borderRadius: 10, overflow: "hidden" } }, Thumb({ src: fileUrl(p.file), size: 72, label: "", onZoom: onZoom })),
                      h("button", { title: "移除", onClick: function () { removeVariant(r.id, p.id); }, style: { position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: 999, border: "1px solid #e5e5ea", background: "#fff", color: "#9aa0a8", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconClose(10)));
                  })),
                h("button", { title: "移除整组", style: { flex: "0 0 auto", width: 30, height: 30, borderRadius: 8, border: "1px solid #ececf0", background: "#f5f5f7", color: UI.text2, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }, onClick: function () { removeRecreation(r.id); } }, IconTrash(14)));
            }));
        } else {
          list = h("div", { style: { flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" } },
            h("div", { style: { ...UI.muted, textAlign: "center" } }, "暂无内容"));
        }

        return h("div", { style: { flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" } },
          composer, statusLine, toolbar, list);
      }

      // ---------- 通用工作台 -------------------------------------------------
      // The free-form daily driver: paste/upload any number of reference images,
      // write any prompt, pick how many outputs, generate. Nothing is prepended
      // to the prompt and the references carry no fixed roles, so this is not
      // tied to the print pipeline — it is the "just make me this image" surface.
      var GENERATE_COUNTS = [1, 2, 4];
      function GeneralWorkbench(props) {
        var generations = props.generations; var setGenerations = props.setGenerations;
        var onZoom = props.onZoom;
        var prompts = props.prompts || [];
        var runningJobs = (props.activeJobs || []).filter(function (j) { return j.kind === "generate"; });
        var pastedState = React.useState([]);
        var pasted = pastedState[0]; var setPasted = pastedState[1];
        var promptState = React.useState("");
        var prompt = promptState[0]; var setPrompt = promptState[1];
        var countState = React.useState(1);
        var count = countState[0]; var setCount = countState[1];
        var settingsOpenState = React.useState(false);
        var settingsOpen = settingsOpenState[0]; var setSettingsOpen = settingsOpenState[1];
        var errorState = React.useState("");
        var error = errorState[0]; var setError = errorState[1];
        var fileInputRef = React.useRef(null);

        /** Read image files into the pending reference strip (data URL per file). */
        function addFiles(files) {
          var images = Array.prototype.slice.call(files || []).filter(function (f) {
            return f && typeof f.type === "string" && f.type.indexOf("image/") === 0;
          });
          if (images.length === 0) return;
          images.forEach(function (file) {
            var id = rid();
            setPasted(function (prev) { return prev.concat([{ id: id, name: file.name || "image", dataUrl: "" }]); });
            readAsDataUrl(file).then(function (dataUrl) {
              setPasted(function (prev) {
                return prev.map(function (s) { return s.id === id ? Object.assign({}, s, { dataUrl: dataUrl }) : s; });
              });
            }, function () {
              setPasted(function (prev) { return prev.filter(function (s) { return s.id !== id; }); });
            });
          });
        }
        function removePasted(id) { setPasted(function (prev) { return prev.filter(function (s) { return s.id !== id; }); }); }
        function onPaste(e) {
          var files = [];
          var items = e.clipboardData && e.clipboardData.items;
          if (items) for (var i = 0; i < items.length; i++) {
            if (items[i].kind === "file") { var f = items[i].getAsFile(); if (f) files.push(f); }
          }
          if (files.length > 0) { e.preventDefault(); addFiles(files); }
        }
        function onDrop(e) {
          if (!e.dataTransfer) return;
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }
        function onPickFiles(e) { addFiles(e.target.files); e.target.value = ""; }

        function startGen() {
          // Reference images are optional; the prompt is what this flow needs.
          if (prompt.trim() === "") return;
          injectSpinnerStyle();
          setError("");
          var ready = pasted.filter(function (s) { return s.dataUrl !== ""; });
          props.startJob("generate", { title: "通用工作台", subtitle: prompt, total: count }, {
            images: ready.map(function (s) { return { dataUrl: s.dataUrl }; }),
            prompt: prompt,
            count: count
          });
          setPasted([]);
        }
        function removeGeneration(id) {
          if (!confirmAction("确定移除这一组结果？")) return;
          setGenerations(function (prev) { return prev.filter(function (g) { return g.id !== id; }); });
          apiPost("/delete", { kind: "generation", id: id });
        }
        function removeVariant(rowId, printId) {
          if (!confirmAction("确定移除这张结果图？")) return;
          setGenerations(function (prev) {
            return prev.map(function (g) {
              if (g.id !== rowId) return g;
              return Object.assign({}, g, { prints: g.prints.filter(function (p) { return p.id !== printId; }) });
            }).filter(function (g) { return g.prints.length > 0; });
          });
          apiPost("/delete", { kind: "generationVariant", id: rowId, printId: printId });
        }
        function clearGenerations() {
          if (!confirmAction("确定清空通用工作台的所有结果？")) return;
          setGenerations([]);
          apiPost("/clear", { kind: "generations" });
        }
        /** 复用历史任务：把该行的提示词填回输入框，并把当时的参考图从
         *  服务器拉回来转成 dataURL 填入待上传区 — 与手动粘贴的图完全等价，
         *  用户可微调提示词/增删参考图后直接重新生成。 */
        function reuseGeneration(g) {
          setError("");
          setPrompt(g.prompt || "");
          setPasted([]);
          (g.sourceFiles || []).forEach(function (f, i) {
            var id = rid();
            setPasted(function (prev) { return prev.concat([{ id: id, name: "参考图 " + (i + 1), dataUrl: "" }]); });
            fetch(fileUrl(f))
              .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
              .then(readAsDataUrl)
              .then(function (dataUrl) {
                setPasted(function (prev) {
                  return prev.map(function (s) { return s.id === id ? Object.assign({}, s, { dataUrl: dataUrl }) : s; });
                });
              }, function () {
                // Source file may have been cleaned up on the host; drop the
                // placeholder instead of leaving a forever-loading thumb.
                setPasted(function (prev) { return prev.filter(function (s) { return s.id !== id; }); });
                setError("部分参考图已不存在，未能全部填充");
              });
          });
        }

        var pastedRow = pasted.length > 0 ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, paddingBottom: 10, borderBottom: "1px solid #ececf0", marginBottom: 10 } },
          pasted.map(function (s) {
            return h("div", { key: s.id, style: { position: "relative" } },
              Thumb({ src: s.dataUrl, size: 44, label: s.name, onZoom: onZoom }),
              h("button", { onClick: function () { removePasted(s.id); }, style: { position: "absolute", top: -6, right: -6, width: 17, height: 17, borderRadius: 999, border: "1px solid #e5e5ea", background: "#fff", color: "#9aa0a8", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconClose(9)));
          })) : null;

        var settingsPanel = settingsOpen ? h("div", { style: { padding: "10px 2px 0", borderTop: "1px solid #ececf0", marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
          h("span", { style: { ...UI.muted } }, "输出"),
          GENERATE_COUNTS.map(function (n) {
            return h("button", { key: n, onClick: function () { setCount(n); }, style: count === n ? UI.chipOn : UI.chip }, n + " 张");
          })) : null;

        var submitDisabled = prompt.trim() === "";
        var composer = h("div", { style: { flex: "0 0 auto", width: "100%", margin: "0 0 16px" } },
          h("div", {
            onDrop: onDrop, onDragOver: function (e) { e.preventDefault(); },
            style: { border: "1px solid #ececf0", borderRadius: 14, background: "#ffffff", padding: "12px 14px", boxShadow: "0 1px 6px rgba(20,20,25,0.04)" }
          },
            h("input", { ref: fileInputRef, type: "file", accept: "image/*", multiple: true, onChange: onPickFiles, style: { display: "none" } }),
            pastedRow,
            h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
              h("button", { onClick: function () { if (fileInputRef.current) fileInputRef.current.click(); }, title: "上传参考图（可多张）", style: { flex: "0 0 auto", width: 34, height: 34, borderRadius: 9, border: 0, background: "transparent", color: UI.text2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" } }, IconUpload(18)),
              h("textarea", { value: prompt, onPaste: onPaste, onChange: function (e) { setPrompt(e.target.value); }, placeholder: "描述你想要的图，可粘贴多张参考图", style: { flex: 1, border: 0, outline: 0, resize: "none", minHeight: 22, maxHeight: 140, fontSize: 14.5, lineHeight: "22px", fontFamily: "inherit", color: UI.text, padding: "6px 4px", background: "transparent", textAlign: "left" } }),
              h(PromptPicker, { prompts: prompts, onPick: setPrompt }),
              h("button", { onClick: function () { setSettingsOpen(!settingsOpen); }, title: "输出 " + count + " 张", style: { flex: "0 0 auto", width: 34, height: 34, borderRadius: 9, border: 0, background: settingsOpen ? "#eceef1" : "transparent", color: settingsOpen ? UI.text : UI.text2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" } }, IconSettings(17)),
              h("button", { onClick: startGen, disabled: submitDisabled, title: "生成", style: Object.assign({}, UI.btnPrimary, submitDisabled ? { opacity: 0.4, cursor: "not-allowed" } : {}, { flex: "0 0 auto", width: 34, height: 34, padding: 0, borderRadius: 9, justifyContent: "center" }) }, IconArrowRight(16))),
            settingsPanel));

        var statusLine = error
          ? h("div", { style: { flex: "0 0 auto", textAlign: "left", margin: "0 0 10px", fontSize: 12.5, color: "#b23c2e" } }, error)
          : null;

        var totalPrints = generations.reduce(function (n, g) { return n + g.prints.length; }, 0);
        var toolbar = generations.length > 0 ? h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", margin: "2px 2px 10px" } },
          h("span", { style: { ...UI.muted } }, totalPrints + " 张"),
          h("button", { style: Object.assign({}, UI.btnGhost, { display: "flex", alignItems: "center", gap: 5 }), onClick: clearGenerations },
            IconTrash(13), "清空")) : null;

        var hasPending = runningJobs.length > 0;
        var pendingRow = hasPending ? runningJobs.map(function (j) { return h(PendingRow, { key: j.localId, job: j }); }) : null;
        var list;
        if (generations.length > 0 || hasPending) {
          list = h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 10, padding: "4px 4px 12px" } },
            pendingRow,
            generations.slice().sort(byNewest).map(function (g) {
              var refs = g.sourceFiles || [];
              return h("div", { key: g.id, style: { display: "flex", alignItems: "center", gap: 16, padding: 12, background: "#ffffff", border: "1px solid #ececf0", borderRadius: 14 } },
                h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10, maxWidth: 340, minWidth: 0 } },
                  refs.length > 0 ? h("div", { style: { display: "flex", gap: 6, flex: "0 0 auto" } },
                    refs.slice(0, 3).map(function (f, i) {
                      return h("div", { key: f, style: { borderRadius: 10, overflow: "hidden" } }, Thumb({ src: fileUrl(f), size: 56, label: "参考图 " + (i + 1), onZoom: onZoom }));
                    })) : null,
                  refs.length > 3 ? h("span", { style: { ...UI.muted, fontSize: 11.5, flex: "0 0 auto" } }, "+" + (refs.length - 3)) : null,
                  h("div", { style: { minWidth: 0, textAlign: "left" } },
                    h("div", { style: { display: "flex", alignItems: "flex-start", gap: 6 } },
                      h("div", { style: { flex: 1, minWidth: 0, color: UI.text, fontSize: 13, lineHeight: "19px", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", textAlign: "left" } }, g.prompt),
                      h(CopyButton, { text: g.prompt })),
                    h("div", { style: { ...UI.muted, fontSize: 11.5, marginTop: 3 } }, (refs.length > 0 ? refs.length + " 张参考图 · " : "") + g.prints.length + " 张"))),
                h("span", { style: { flex: "0 0 auto", color: "#c7c8cc", display: "flex" } }, IconArrowRight(16)),
                h("div", { style: { flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "flex-end" } },
                  g.prints.map(function (p) {
                    return h("div", { key: p.id, style: { position: "relative" } },
                      h("div", { style: { borderRadius: 10, overflow: "hidden" } }, Thumb({ src: fileUrl(p.file), size: 72, label: "", onZoom: onZoom })),
                      h("button", { title: "移除", onClick: function () { removeVariant(g.id, p.id); }, style: { position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: 999, border: "1px solid #e5e5ea", background: "#fff", color: "#9aa0a8", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconClose(10)));
                  })),
                h("div", { style: { flex: "0 0 auto", display: "flex", flexDirection: "column", gap: 6 } },
                  h("button", { title: "复用：填充提示词和参考图到输入框", style: { width: 30, height: 30, borderRadius: 8, border: "1px solid #ececf0", background: "#f5f5f7", color: UI.text2, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }, onClick: function () { reuseGeneration(g); } }, IconReplay(14)),
                  h("button", { title: "移除整组", style: { width: 30, height: 30, borderRadius: 8, border: "1px solid #ececf0", background: "#f5f5f7", color: UI.text2, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }, onClick: function () { removeGeneration(g.id); } }, IconTrash(14))));
            }));
        } else {
          list = h("div", { style: { flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" } },
            h("div", { style: { ...UI.muted, textAlign: "center" } }, "暂无内容"));
        }

        return h("div", { style: { flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" } },
          composer, statusLine, toolbar, list);
      }

      // ---------- T恤管理 ---------------------------------------------------
      // A T恤 is just a named group of uploaded photos (no generation): the
      // create composer takes a name + multiple images at once, and each saved
      // card can keep growing — an "添加图片" tile appends more photos to the
      // same T恤 later, so one T恤 can accumulate any number of reference shots.
      function TshirtManager(props) {
        var tshirts = props.tshirts; var setTshirts = props.setTshirts;
        var onZoom = props.onZoom;
        var creatingState = React.useState(false);
        var creating = creatingState[0]; var setCreating = creatingState[1];
        var nameState = React.useState("");
        var name = nameState[0]; var setName = nameState[1];
        var pendingState = React.useState([]); // [{id, name, dataUrl}] for the create composer
        var pending = pendingState[0]; var setPending = pendingState[1];
        var busyState = React.useState(false);
        var busy = busyState[0]; var setBusy = busyState[1];
        var errorState = React.useState("");
        var error = errorState[0]; var setError = errorState[1];
        var addBusyState = React.useState(""); // tshirt id currently receiving more images
        var addBusyId = addBusyState[0]; var setAddBusyId = addBusyState[1];
        var fileInputRef = React.useRef(null);
        var addInputRefs = React.useRef({});

        function readFilesInto(setter, files) {
          var images = Array.prototype.slice.call(files || []).filter(function (f) {
            return f && typeof f.type === "string" && f.type.indexOf("image/") === 0;
          });
          images.forEach(function (file) {
            var id = rid();
            setter(function (prev) { return prev.concat([{ id: id, name: file.name || "image", dataUrl: "" }]); });
            readAsDataUrl(file).then(function (dataUrl) {
              setter(function (prev) { return prev.map(function (s) { return s.id === id ? Object.assign({}, s, { dataUrl: dataUrl }) : s; }); });
            }, function () {
              setter(function (prev) { return prev.filter(function (s) { return s.id !== id; }); });
            });
          });
        }
        function onPickCreateFiles(e) { readFilesInto(setPending, e.target.files); e.target.value = ""; }
        function removePending(id) { setPending(function (prev) { return prev.filter(function (s) { return s.id !== id; }); }); }
        function cancelCreate() { setCreating(false); setName(""); setPending([]); setError(""); }
        function submitCreate() {
          var ready = pending.filter(function (s) { return s.dataUrl !== ""; });
          if (busy || ready.length === 0) return;
          setBusy(true); setError("");
          apiPost("/tshirt/create", {
            name: name,
            images: ready.map(function (s) { return { name: s.name, dataUrl: s.dataUrl }; })
          }).then(function (res) {
            setBusy(false);
            if (!res || res.ok !== true) { setError((res && res.error) || "创建失败"); return; }
            setTshirts(function (prev) { return [res.tshirt].concat(prev); });
            cancelCreate();
          }, function (err) {
            setBusy(false);
            setError(String((err && err.message) || err));
          });
        }
        function onPickAddFiles(tshirtId, e) {
          var files = Array.prototype.slice.call(e.target.files || []).filter(function (f) {
            return f && typeof f.type === "string" && f.type.indexOf("image/") === 0;
          });
          e.target.value = "";
          if (files.length === 0) return;
          setAddBusyId(tshirtId);
          Promise.all(files.map(readAsDataUrl)).then(function (dataUrls) {
            return apiPost("/tshirt/addImages", {
              id: tshirtId,
              images: dataUrls.map(function (d, i) { return { name: files[i].name || "image", dataUrl: d }; })
            });
          }).then(function (res) {
            setAddBusyId("");
            if (!res || res.ok !== true) { setError((res && res.error) || "添加图片失败"); return; }
            setTshirts(function (prev) { return prev.map(function (t) { return t.id === res.tshirt.id ? res.tshirt : t; }); });
          }, function (err) {
            setAddBusyId("");
            setError(String((err && err.message) || err));
          });
        }
        function removeTshirt(id) {
          if (!confirmAction("确定删除这件T恤？")) return;
          setTshirts(function (prev) { return prev.filter(function (t) { return t.id !== id; }); });
          apiPost("/delete", { kind: "tshirt", id: id });
        }
        function removeImage(tshirtId, file) {
          if (!confirmAction("确定移除这张图片？")) return;
          setTshirts(function (prev) {
            return prev.map(function (t) {
              if (t.id !== tshirtId) return t;
              return Object.assign({}, t, { images: t.images.filter(function (f) { return f !== file; }) });
            });
          });
          apiPost("/delete", { kind: "tshirtImage", id: tshirtId, file: file });
        }
        function clearAll() {
          if (!confirmAction("确定清空所有T恤？")) return;
          setTshirts([]);
          apiPost("/clear", { kind: "tshirts" });
        }

        var pendingRow = pending.length > 0 ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, paddingBottom: 10, borderBottom: "1px solid #ececf0", marginBottom: 10 } },
          pending.map(function (s) {
            return h("div", { key: s.id, style: { position: "relative" } },
              Thumb({ src: s.dataUrl, size: 52, label: s.name }),
              h("button", { onClick: function () { removePending(s.id); }, style: { position: "absolute", top: -6, right: -6, width: 17, height: 17, borderRadius: 999, border: "1px solid #e5e5ea", background: "#fff", color: "#9aa0a8", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconClose(9)));
          })) : null;

        var readyCount = pending.filter(function (s) { return s.dataUrl !== ""; }).length;
        var createPanel = creating ? h("div", { style: { flex: "0 0 auto", width: "100%", margin: "0 0 16px" } },
          h("div", { style: { border: "1px solid #ececf0", borderRadius: 14, background: "#ffffff", padding: "12px 14px", boxShadow: "0 1px 6px rgba(20,20,25,0.04)" } },
            h("input", { ref: fileInputRef, type: "file", accept: "image/*", multiple: true, onChange: onPickCreateFiles, style: { display: "none" } }),
            pendingRow,
            h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
              h("input", {
                value: name, onChange: function (e) { setName(e.target.value); }, placeholder: "T恤名称（可选）",
                style: { flex: 1, border: "1px solid #ececf0", borderRadius: 9, padding: "7px 10px", fontSize: 13.5, color: UI.text, outline: 0 }
              }),
              h("button", { onClick: function () { if (fileInputRef.current) fileInputRef.current.click(); }, title: "上传图片", style: { flex: "0 0 auto", width: 34, height: 34, borderRadius: 9, border: "1px solid #e5e5ea", background: "#fff", color: UI.text2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" } }, IconUpload(18)),
              h("button", { onClick: cancelCreate, style: Object.assign({}, UI.btnGhost) }, "取消"),
              h("button", {
                onClick: submitCreate, disabled: busy || readyCount === 0,
                style: Object.assign({}, UI.btnPrimary, (busy || readyCount === 0) ? { opacity: 0.4, cursor: "not-allowed" } : {})
              }, busy ? "创建中…" : "创建T恤" + (readyCount > 0 ? "（" + readyCount + " 张）" : ""))))) : null;

        var toolbar = h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", margin: "2px 2px 14px" } },
          h("span", { style: { ...UI.muted } }, tshirts.length + " 件T恤"),
          h("div", { style: { display: "flex", gap: 8 } },
            !creating ? h("button", { style: Object.assign({}, UI.btnPrimary, { display: "flex", alignItems: "center", gap: 6 }), onClick: function () { setCreating(true); } }, IconPlus(14), "新建T恤") : null,
            tshirts.length > 0 ? h("button", { style: Object.assign({}, UI.btnGhost, { display: "flex", alignItems: "center", gap: 5 }), onClick: clearAll }, IconTrash(13), "清空") : null));

        var errorLine = error ? h("div", { style: { flex: "0 0 auto", textAlign: "left", margin: "0 0 10px", fontSize: 12.5, color: "#b23c2e" } }, error) : null;

        var grid;
        if (tshirts.length > 0) {
          grid = h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12, padding: "4px 4px 12px", alignContent: "start" } },
            tshirts.slice().sort(byNewest).map(function (t) {
              var adding = addBusyId === t.id;
              return h("div", { key: t.id, style: { background: "#ffffff", border: "1px solid #ececf0", borderRadius: 14, padding: 12, display: "flex", flexDirection: "column", gap: 10 } },
                h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
                  h("div", { style: { fontSize: 13.5, fontWeight: 600, color: UI.text, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t.name),
                  h("button", { title: "删除整件T恤", onClick: function () { removeTshirt(t.id); }, style: { flex: "0 0 auto", width: 26, height: 26, borderRadius: 8, border: "1px solid #ececf0", background: "#f5f5f7", color: UI.text2, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconTrash(13))),
                h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
                  t.images.map(function (file) {
                    return h("div", { key: file, style: { position: "relative" } },
                      Thumb({ src: fileUrl(file), size: 64, label: t.name, onZoom: onZoom }),
                      h("button", { title: "移除", onClick: function () { removeImage(t.id, file); }, style: { position: "absolute", top: -6, right: -6, width: 17, height: 17, borderRadius: 999, border: "1px solid #e5e5ea", background: "#fff", color: "#9aa0a8", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, IconClose(9)));
                  }),
                  h("div", null,
                    h("input", {
                      ref: function (el) { addInputRefs.current[t.id] = el; },
                      type: "file", accept: "image/*", multiple: true,
                      onChange: function (e) { onPickAddFiles(t.id, e); }, style: { display: "none" }
                    }),
                    h("button", {
                      title: "添加图片", disabled: adding,
                      onClick: function () { var el = addInputRefs.current[t.id]; if (el) el.click(); },
                      style: { width: 64, height: 64, borderRadius: Math.max(8, 64 / 6), border: "1px dashed #d8d8dd", background: "#fafafb", color: UI.text2, cursor: adding ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center" }
                    }, adding ? Spinner() : IconPlus(16)))),
                h("div", { style: { ...UI.muted } }, t.images.length + " 张图片"));
            }));
        } else if (!creating) {
          grid = h("div", { style: { flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" } },
            h("div", { style: { ...UI.muted, textAlign: "center" } }, "暂无内容"));
        } else {
          grid = h("div", { style: { flex: 1, minHeight: 0 } });
        }

        return h("div", { style: { flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" } },
          createPanel, errorLine, toolbar, grid);
      }

      // ---------- 场景图管理 ----------------------------------------------
      /** 场景图瀑布流的最小列宽与列间距（px）。 */
      var MASONRY_COL_MIN = 220;
      var MASONRY_COL_GAP = 12;
      /** 渐进渲染每页追加的瓦片数（首屏只挂载一页）。 */
      var MASONRY_PAGE = 36;

      /**
       * 把 items 按顺序轮流投放到 n 列：第 i 张进第 i % n 列。
       *
       * 这是为了绕开 CSS 多列（`column-width`）的「按列填充」语义——它会把第 1
       * 列装满才轮到第 2 列，于是最新的一批全挤在最左列，视线横扫首行看到的是
       * 第 0、n、2n… 张，按上传时间读就是乱序。轮流分列之后，前 n 张（最新的
       * n 张）铺在首屏第一排、从左到右，之后依次往下，横扫即为上传时间倒序。
       *
       * 注意边界：瀑布流各列高度不等，所以「严格全局按时间排序」无法同时成立
       * ——第 n+1 张会落在第 1 列第 2 个位置，可能高于或低于第 2 张。这一点是
       * 瀑布流本身的取舍，不是实现缺陷。
       */
      function distributeColumns(items, n) {
        var count = Math.max(1, n | 0);
        var columns = [];
        for (var i = 0; i < count; i++) columns.push([]);
        items.forEach(function (item, index) { columns[index % count].push(item); });
        return columns;
      }

      /**
       * How many columns fit right now; recomputed as the container resizes.
       *
       * **The observed element must be mounted from the very first render.** This
       * effect runs once and can never notice a ref that only becomes available
       * later, so a caller that mounts its scroller *after* its data arrives
       * measures nothing and leaves the feed stuck at one column — every tile
       * stretched to the full width of the pane. (The 成品库 shipped that way
       * once; it no longer measures at all and uses a fixed count instead, but
       * the rule still binds every caller of this hook.) Render the scroller
       * always, with the loading and empty states *inside* it.
       *
       * @param {object} ref - ref to the scrolling container.
       * @param {number} [minColumnWidth] - the narrowest tolerable column.
       */
      function useColumnCount(ref, minColumnWidth) {
        var min = minColumnWidth > 0 ? minColumnWidth : MASONRY_COL_MIN;
        var state = React.useState(1);
        var count = state[0]; var setCount = state[1];
        React.useEffect(function () {
          var el = ref.current;
          if (!el) {
            console.warn("[ecom] useColumnCount: the observed element was not mounted, so the feed stays one column wide");
            return undefined;
          }
          function measure() {
            var width = el.clientWidth;
            var next = Math.max(1, Math.floor((width + MASONRY_COL_GAP) / (min + MASONRY_COL_GAP)));
            setCount(function (prev) { return prev === next ? prev : next; });
          }
          measure();
          if (typeof ResizeObserver === "undefined") return undefined;
          var observer = new ResizeObserver(measure);
          observer.observe(el);
          return function () { observer.disconnect(); };
        }, []);
        return count;
      }

      // A flat pool of scene photos. Unlike every other module there is no
      // prompt, no picker and no generation: paste or drop an image and it is
      // stored immediately (no submit step), then shown in a masonry waterfall
      // because scene photos arrive in every aspect ratio. Pure storage, so it
      // sits in the nav's de-emphasized group with the other non-pipeline items.
      function SceneManager(props) {
        var scenes = props.scenes; var setScenes = props.setScenes;
        var onZoom = props.onZoom;
        var active = props.active;
        var busyState = React.useState(0); // images still being read + uploaded
        var busy = busyState[0]; var setBusy = busyState[1];
        var errorState = React.useState("");
        var error = errorState[0]; var setError = errorState[1];
        var fileInputRef = React.useRef(null);
        // The pool scroller is always rendered (even when empty) so the column
        // measurement has a real element to observe from the very first mount.
        var poolRef = React.useRef(null);
        var columnCount = useColumnCount(poolRef);
        // Progressive rendering: `visibleCount` tiles are mounted; a sentinel at
        // the bottom of the pool raises it by one page each time it comes into
        // view. The pool is unbounded (222 photos today, ~1.7 MB each once
        // decoded), so mounting all of them would make the first paint — and
        // every subsequent reflow — pay for the whole library.
        var visibleState = React.useState(MASONRY_PAGE);
        var visibleCount = visibleState[0]; var setVisibleCount = visibleState[1];
        var sentinelRef = React.useRef(null);

        function upload(images) {
          setError("");
          setBusy(function (n) { return n + images.length; });
          apiPost("/scene/add", { images: images }).then(function (res) {
            setBusy(function (n) { return Math.max(0, n - images.length); });
            if (!res || res.ok !== true) { setError((res && res.error) || "保存失败"); return; }
            setScenes(function (prev) { return res.scenes.concat(prev); });
          }, function (err) {
            setBusy(function (n) { return Math.max(0, n - images.length); });
            setError(String((err && err.message) || err));
          });
        }

        /** Read real image files and store them straight away — no submit step.
         *  The pixel size is deliberately NOT sent: the host measures it from the
         *  bytes it stores, so a photo's recorded ratio is always its real one. */
        function uploadFiles(files) {
          var images = Array.prototype.slice.call(files || []).filter(function (f) {
            return f && typeof f.type === "string" && f.type.indexOf("image/") === 0;
          });
          if (images.length === 0) return;
          Promise.all(images.map(function (f) {
            return readAsDataUrl(f).then(function (dataUrl) { return { name: f.name || "场景图", dataUrl: dataUrl }; });
          })).then(upload, function () { setError("读取图片失败"); });
        }

        function onPickFiles(e) { uploadFiles(e.target.files); e.target.value = ""; }
        function onDrop(e) {
          if (!e.dataTransfer) return;
          e.preventDefault();
          uploadFiles(e.dataTransfer.files);
        }

        // Paste IS the primary intake here, so the listener sits on the document
        // rather than on a box that must be focused first. Every workbench view
        // stays mounted (inactive ones are hidden with `display:none`), so it is
        // gated on this view being the active tab; it is also skipped while the
        // caret sits in a text field, because the chat composer below the
        // workbench is one and an image pasted there must stay the chat's
        // business instead of silently landing in this pool.
        React.useEffect(function () {
          if (!active || typeof document === "undefined") return undefined;
          function onPaste(e) {
            var el = document.activeElement;
            var tag = el && el.tagName;
            if (tag === "TEXTAREA" || tag === "INPUT" || (el && el.isContentEditable)) return;
            var files = [];
            var items = e.clipboardData && e.clipboardData.items;
            if (items) for (var i = 0; i < items.length; i++) {
              if (items[i].kind === "file") {
                var file = items[i].getAsFile();
                if (file) files.push(file);
              }
            }
            if (files.length === 0) return;
            e.preventDefault();
            uploadFiles(files);
          }
          document.addEventListener("paste", onPaste);
          return function () { document.removeEventListener("paste", onPaste); };
        }, [active]);

        function removeScene(id) {
          if (!confirmAction("确定删除这张场景图？")) return;
          setScenes(function (prev) { return prev.filter(function (s) { return s.id !== id; }); });
          apiPost("/delete", { kind: "scene", id: id });
        }
        function clearAll() {
          if (!confirmAction("确定清空所有场景图？")) return;
          setScenes([]);
          apiPost("/clear", { kind: "scenes" });
        }

        var intake = h("div", {
          style: { flex: "0 0 auto", width: "100%", margin: "0 0 16px", border: "1px dashed #d8d8dd", borderRadius: 14, background: "#ffffff", padding: "14px 16px", boxSizing: "border-box", display: "flex", alignItems: "center", gap: 10, boxShadow: "0 1px 6px rgba(20,20,25,0.04)" }
        },
          h("input", { ref: fileInputRef, type: "file", accept: "image/*", multiple: true, onChange: onPickFiles, style: { display: "none" } }),
          h("span", { style: { display: "flex", color: UI.text2, flex: "0 0 auto" } }, IconImage(18)),
          h("span", { style: { ...UI.muted, flex: 1, minWidth: 0, textAlign: "left" } },
            busy > 0 ? "正在保存 " + busy + " 张…" : "粘贴图片（Ctrl+V）或拖入此处，松手即保存"),
          busy > 0 ? Spinner() : null,
          h("button", {
            onClick: function () { if (fileInputRef.current) fileInputRef.current.click(); },
            style: Object.assign({}, UI.btnGhost, { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 6 })
          }, IconUpload(15), "上传图片"));

        var errorLine = error ? h("div", { style: { flex: "0 0 auto", textAlign: "left", margin: "0 0 10px", fontSize: 12.5, color: "#b23c2e" } }, error) : null;

        var orderedScenes = scenes.slice().sort(byNewest);
        // Without IntersectionObserver, render everything rather than silently
        // hiding photos behind a page size nothing can advance.
        var canPage = typeof IntersectionObserver !== "undefined";
        var shown = canPage ? Math.min(visibleCount, orderedScenes.length) : orderedScenes.length;
        var hasMore = shown < orderedScenes.length;

        // The sentinel only exists while there is more to show, so the observer
        // is keyed on `hasMore` and re-arms exactly when a new page is available.
        React.useEffect(function () {
          if (!hasMore) return undefined;
          var root = poolRef.current; var sentinel = sentinelRef.current;
          if (!root || !sentinel) return undefined;
          var observer = new IntersectionObserver(function (entries) {
            if (entries.some(function (entry) { return entry.isIntersecting; })) {
              setVisibleCount(function (n) { return n + MASONRY_PAGE; });
            }
          }, { root: root, rootMargin: "800px 0px" });
          observer.observe(sentinel);
          return function () { observer.disconnect(); };
        }, [hasMore]);

        var toolbar = scenes.length > 0 ? h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", margin: "2px 2px 12px" } },
          h("span", { style: { ...UI.muted } }, scenes.length + " 张场景图" + (hasMore ? " · 已显示 " + shown : "")),
          h("button", { style: Object.assign({}, UI.btnGhost, { display: "flex", alignItems: "center", gap: 5 }), onClick: clearAll }, IconTrash(13), "清空")) : null;

        // Waterfall, but packed into explicit flex columns instead of CSS
        // multi-column: `column-width` fills column 1 to the bottom before
        // column 2, so a newest-first list reads as 0, n, 2n… across the top
        // row. Round-robin distribution (see `distributeColumns`) puts the
        // newest n photos across the first row instead, so scanning left to
        // right and downwards is scanning newest to oldest.
        /** Height reservation. The real ratio when the upload reported one;
         *  otherwise 3:4, which is what the existing library actually is
         *  (measured: 600x800) — an approximation beats a tile that starts at
         *  zero height and shoves its whole column down when the bytes land. */
        function sceneAspect(s) {
          return (s.width > 0 && s.height > 0) ? (s.width + " / " + s.height) : null;
        }
        function sceneTile(s) {
          var src = fileUrl(s.file);
          return h("div", {
            key: s.id,
            style: { position: "relative", borderRadius: 12, overflow: "hidden", border: "1px solid #ececf0", background: "#ffffff" }
          },
            h("img", {
              src: src, alt: s.name || "场景图", loading: "lazy",
              onClick: function () { onZoom({ src: src, label: s.name || "" }); },
              style: { width: "100%", display: "block", aspectRatio: sceneAspect(s) || undefined, background: "#f2f2f4", cursor: "zoom-in" }
            }),
            h("button", {
              title: "删除这张场景图", onClick: function () { removeScene(s.id); },
              style: { position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 7, border: "1px solid rgba(255,255,255,.45)", background: "rgba(20,20,22,.55)", color: "#fff", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }
            }, IconTrash(12)));
        }

        var poolInner = orderedScenes.length > 0
          ? h("div", null,
              h("div", { style: { display: "flex", alignItems: "flex-start", gap: MASONRY_COL_GAP } },
                distributeColumns(orderedScenes.slice(0, shown), columnCount).map(function (column, columnIndex) {
                  return h("div", {
                    key: columnIndex,
                    style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: MASONRY_COL_GAP }
                  }, column.map(sceneTile));
                })),
              hasMore ? h("div", { ref: sentinelRef, style: { height: 1 } }) : null)
          : h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: 200 } },
              h("div", { style: { ...UI.muted, textAlign: "center" } }, "暂无内容"));

        var pool = h("div", {
          ref: poolRef,
          style: { flex: 1, minHeight: 0, overflow: "auto", padding: "2px 4px 16px" }
        }, poolInner);

        return h("div", {
          onDrop: onDrop, onDragOver: function (e) { e.preventDefault(); },
          style: { flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }
        }, intake, errorLine, toolbar, pool);
      }

      slots.inject("conversation.view", function () {
        // Register the workbench as ONE view in the conversation view ring. This is
        // ADDITIVE: the Chat view and the always-present composer stay, so the user
        // can still converse with the agent (the composer sits below whichever view
        // is active). Click the "电商工作台" tab to show the workbench. This keeps
        // the workbench visible without swallowing the native conversation.
        return slots.register({
          name: "conversation.view",
          id: "ecom-workbench",
          order: 1,
          label: function () { return "电商工作台"; }
        }, function () {
          return h(Workbench);
        });
      });
    }

    module.exports = { apply };
    return module.exports;
  }
});
