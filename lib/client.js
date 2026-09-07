// Browser half of the ecommerce workbench. Registers the workbench into the
// conversation view ring so DSH opens straight into it (no Cordis run card, no
// popup, no manual enter). Ships 印花管理 (印花提取 + 印花二创, real Host API +
// real generation) and T恤管理 (upload multiple reference photos per T恤, no
// generation — just durable storage and management).
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

        function fetchState() {
          apiGet("/state").then(function (state) {
            if (!state || state.ok !== true) return;
            setLibrary(state.library || []);
            setRecreations(state.recreations || []);
            setTshirts(state.tshirts || []);
            setTshirtRecreations(state.tshirtRecreations || []);
            setPrompts(state.prompts || []);
            setGenerations(state.generations || []);
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
          apiGet("/state").then(function (state) {
            if (!alive || !state || state.ok !== true) return;
            setLibrary(state.library || []);
            setRecreations(state.recreations || []);
            setTshirts(state.tshirts || []);
            setTshirtRecreations(state.tshirtRecreations || []);
            setPrompts(state.prompts || []);
            setGenerations(state.generations || []);
          }, function (error) {
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

        // Primary work: the two print flows plus T恤二创 (which consumes both a
        // T恤 and a print, so it belongs with the generation-facing modules).
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
        var primaryNav = [["印花提取", IconLayers], ["印花二创", IconWand], ["T恤二创", IconSparkle]].map(navButton);
        // 通用工作台 is the free-form daily driver rather than a step in the print
        // pipeline, so it sits below the divider with the other non-pipeline items.
        var secondaryNav = [["通用工作台", IconSpark, true], ["T恤管理", IconShirt, true], ["提示词管理", IconBookmark, true]].map(navButton);

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
          h(GeneralWorkbench, { generations: generations, setGenerations: setGenerations, onZoom: setLightboxImage, prompts: prompts, startJob: startJob, activeJobs: activeJobs }),
          h(TshirtManager, { tshirts: tshirts, setTshirts: setTshirts, onZoom: setLightboxImage }),
          h(PromptManager, { prompts: prompts, setPrompts: setPrompts })
        ];
        var viewNames = ["印花提取", "印花二创", "T恤二创", "通用工作台", "T恤管理", "提示词管理"];
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
                h("button", { title: "移除整组", style: { flex: "0 0 auto", width: 30, height: 30, borderRadius: 8, border: "1px solid #ececf0", background: "#f5f5f7", color: UI.text2, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }, onClick: function () { removeGeneration(g.id); } }, IconTrash(14)));
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
