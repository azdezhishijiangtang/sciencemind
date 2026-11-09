/* ScienceMind — 界面与交互 */

(function () {
  const SM = window.SM;
  const API = window.API;
  const Solver = window.Solver;
  const Store = window.Store;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));

  const state = {
    slots: [
      { role: "solver", presetId: "deepseek", model: "deepseek-reasoner", baseUrl: "", apiKey: "", enabled: true },
      { role: "verifier", presetId: "deepseek", model: "deepseek-reasoner", baseUrl: "", apiKey: "", enabled: false },
      { role: "adjudicator", presetId: "openai", model: "o3", baseUrl: "", apiKey: "", enabled: false },
    ],
    candidates: 2,
    mode: "high",
    strictEvidence: false,
    requireDistinct: false,
    useLibrary: true,
    preservePartial: true,
    image: null,
    running: false,
    controller: null,
    lastResult: null,
    docs: [],
    index: null,
    lastActivity: Date.now(),
    hiddenAt: 0,
  };

  const PRESET_BY_ID = (id) => API.presetOf(id);
  const familyOf = (slot) => (slot.presetId === "custom" ? "custom" : slot.presetId);

  /* ================= 初始化 ================= */

  function init() {
    loadPrefs();
    buildSlots();
    bindNav();
    bindTheme();
    bindComposer();
    bindSettings();
    bindLibrary();
    bindArchive();
    bindKeyboard();
    bindAutoLock();
    renderStatic();
    refreshModelButton();
    refreshComposerValues();
    loadDocs();
    loadArchive();
    switchView("solve", false);
  }

  function loadPrefs() {
    const p = Store.loadPrefs();
    if (!p) return;
    if (Array.isArray(p.slots) && p.slots.length === 3) {
      state.slots.forEach((s, i) => {
        const saved = p.slots[i];
        if (!saved) return;
        s.presetId = saved.presetId || s.presetId;
        s.model = saved.model || s.model;
        s.baseUrl = saved.baseUrl || "";
        s.enabled = i === 0 ? true : !!saved.enabled;
      });
    }
    if (p.candidates) state.candidates = p.candidates;
    if (p.mode) state.mode = p.mode;
    state.strictEvidence = !!p.strictEvidence;
    state.requireDistinct = !!p.requireDistinct;
    if (typeof p.useLibrary === "boolean") state.useLibrary = p.useLibrary;
  }

  function persist() {
    Store.savePrefs({
      slots: state.slots.map((s) => ({ presetId: s.presetId, model: s.model, baseUrl: s.baseUrl, enabled: s.enabled })),
      candidates: state.candidates, mode: state.mode,
      strictEvidence: state.strictEvidence, requireDistinct: state.requireDistinct,
      useLibrary: state.useLibrary,
    });
  }

  /* ================= 导航 ================= */

  function switchView(name, scroll) {
    $$(".view").forEach((v) => { v.hidden = v.id !== "view-" + name; });
    $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.view === name));
    $$(".mobile-tabs button").forEach((t) => t.classList.toggle("is-active", t.dataset.view === name));
    if (name === "library") renderDocList();
    if (name === "archive") renderArchive();
    if (scroll !== false) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function bindNav() {
    $$("[data-view], [data-view-link]").forEach((el) => {
      el.addEventListener("click", (e) => {
        const name = el.dataset.view || el.dataset.viewLink;
        if (!name) return;
        e.preventDefault();
        switchView(name);
      });
    });
  }

  /* ================= 日光 / 月光 ================= */

  const THEME_KEY = "sm.theme";

  function readSavedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (_) { return null; }
  }

  function applyTheme(theme, remember) {
    const night = theme === "night";
    document.documentElement.setAttribute("data-theme", night ? "night" : "day");
    const btn = $("#themeBtn");
    if (btn) {
      btn.setAttribute("aria-pressed", String(night));
      btn.setAttribute("aria-label", night ? "切换到日光模式" : "切换到月光模式");
      btn.setAttribute("title", night ? "月光 · 点击切回日光" : "日光 · 点击切到月光");
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", night ? "#131410" : "#f5f2ea");
    if (remember) { try { localStorage.setItem(THEME_KEY, night ? "night" : "day"); } catch (_) {} }
  }

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "night" ? "night" : "day";
  }

  function bindTheme() {
    applyTheme(currentTheme(), false);

    const btn = $("#themeBtn");
    if (btn) {
      btn.addEventListener("click", () => {
        applyTheme(currentTheme() === "night" ? "day" : "night", true);
        state.lastActivity = Date.now();
      });
    }

    /* 用户还没手动选过时，跟随系统。选过之后就尊重选择。 */
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) => {
      if (readSavedTheme()) return;
      applyTheme(e.matches ? "night" : "day", false);
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* ================= 输入区 ================= */

  function bindComposer() {
    const q = $("#question");
    q.addEventListener("input", () => {
      $("#qCount").textContent = q.value.trim().length + " 字";
      state.lastActivity = Date.now();
    });
    $("#qCount").textContent = q.value.trim().length + " 字";

    $("#demoBtn").addEventListener("click", () => {
      q.value = SM.SAMPLE_QUESTION;
      $("#qCount").textContent = q.value.length + " 字";
      state.image = null;
      $("#imagePanel").hidden = true;
      toast("已载入示例题。没有 Key 也可以运行本地判题演示。");
    });

    $("#clearBtn").addEventListener("click", () => {
      q.value = "";
      $("#qCount").textContent = "0 字";
      clearImage();
      $("#uncertainties").value = "";
      $("#verifiedCheck").checked = false;
    });

    $("#pasteBtn").addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return toast("剪贴板里没有文本。");
        q.value = (q.value ? q.value + "\n" : "") + text;
        q.dispatchEvent(new Event("input"));
        toast("已从剪贴板读入。");
      } catch (_) {
        toast("浏览器拒绝了剪贴板读取，请直接粘贴。");
      }
    });

    $("#imageBtn").addEventListener("click", () => $("#fileInput").click());
    $("#fileInput").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handleImage(file);
      e.target.value = "";
    });

    $("#imageClose").addEventListener("click", clearImage);
    $("#verifiedCheck").addEventListener("change", updateGateNote);
    $("#ocrBtn").addEventListener("click", runOcr);

    $$("#candSeg button").forEach((b) => b.addEventListener("click", () => {
      $$("#candSeg button").forEach((x) => x.classList.remove("is-on"));
      b.classList.add("is-on");
      state.candidates = Number(b.dataset.value);
      $("#candHint").textContent = state.candidates === 1 ? "单路" : state.candidates + " 路独立";
      persist();
    }));

    $$("#modeSeg button").forEach((b) => b.addEventListener("click", () => {
      $$("#modeSeg button").forEach((x) => x.classList.remove("is-on"));
      b.classList.add("is-on");
      state.mode = b.dataset.value;
      $("#modeHint").textContent = SM.MODE_PLAN[state.mode].label;
      persist();
    }));

    $("#useLibrary").addEventListener("change", (e) => { state.useLibrary = e.target.checked; persist(); if (state.useLibrary) loadDocs(); });
    $("#strictEvidence").addEventListener("change", (e) => { state.strictEvidence = e.target.checked; $("#drawerStrict").checked = e.target.checked; persist(); });
    $("#drawerStrict").addEventListener("change", (e) => { state.strictEvidence = e.target.checked; $("#strictEvidence").checked = e.target.checked; persist(); });

    $("#runBtn").addEventListener("click", run);
    $("#cancelBtn").addEventListener("click", cancelRun);
  }

  function refreshComposerValues() {
    $$("#candSeg button").forEach((b) => b.classList.toggle("is-on", Number(b.dataset.value) === state.candidates));
    $$("#modeSeg button").forEach((b) => b.classList.toggle("is-on", b.dataset.value === state.mode));
    $("#candHint").textContent = state.candidates === 1 ? "单路" : state.candidates + " 路独立";
    $("#modeHint").textContent = SM.MODE_PLAN[state.mode].label;
    $("#useLibrary").checked = state.useLibrary;
    $("#strictEvidence").checked = state.strictEvidence;
    $("#drawerStrict").checked = state.strictEvidence;
    $("#distinctFamilies").checked = state.requireDistinct;
  }

  function handleImage(file) {
    if (!/^image\//.test(file.type)) return toast("请选择图片文件。", true);
    if (file.size > 12 * 1024 * 1024) return toast("图片超过 12 MB，请先压缩。", true);
    const fr = new FileReader();
    fr.onload = () => {
      state.image = { dataUrl: fr.result, file: file, name: file.name, ocrText: "" };
      $("#imagePreview").src = fr.result;
      $("#imagePanel").hidden = false;
      $("#ocrStatus").textContent = "未识别";
      $("#ocrStatus").className = "ocr-status";
      $("#verifiedCheck").checked = false;
      updateGateNote();
      $("#imagePanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
    fr.readAsDataURL(file);
  }

  function clearImage() {
    state.image = null;
    $("#imagePanel").hidden = true;
    $("#imagePreview").removeAttribute("src");
    $("#ocrStatus").textContent = "未识别";
    $("#ocrProgress").hidden = true;
    $("#verifiedCheck").checked = false;
  }

  function updateGateNote() {
    const ok = $("#verifiedCheck").checked;
    $("#gateNote").style.color = ok ? "var(--green)" : "var(--amber)";
    $("#gateNote").style.background = ok ? "var(--green-wash)" : "var(--amber-wash)";
    $("#gateNote").style.borderColor = ok ? "var(--green)" : "var(--amber)";
    $("#gateNote").innerHTML = ok
      ? "已记录人工核对。程序仍会检查图中存疑项；任何未解决项都会阻止 <code>verified</code>。"
      : "未勾选核对时，本题禁止输出 <code>verified</code>，只能 <code>needs_review</code>。这条由程序判定，模型无权改写。";
  }

  const TESS_CDN = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js";

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ($(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("脚本加载失败"));
      document.head.appendChild(s);
    });
  }

  async function runOcr() {
    if (!state.image) return;
    const status = $("#ocrStatus");
    const prog = $("#ocrProgress");
    const bar = prog.querySelector("i");
    status.textContent = "加载识别引擎…";
    status.className = "ocr-status is-busy";
    prog.hidden = false;
    bar.style.width = "6%";
    try {
      await loadScript(TESS_CDN);
      if (!window.Tesseract) throw new Error("Tesseract 未就绪");
      const res = await window.Tesseract.recognize(state.image.file, "chi_sim+eng", {
        logger: (m) => {
          if (m.status === "recognizing text") {
            const p = Math.max(8, Math.round(m.progress * 100));
            bar.style.width = p + "%";
            status.textContent = "识别中 " + p + "%";
          } else if (m.status) {
            status.textContent = m.status.replace(/_/g, " ");
          }
        },
      });
      const text = (res.data && res.data.text || "").trim();
      if (!text) throw new Error("没有识别出文字");
      if (res.data.confidence !== undefined) status.dataset.conf = Math.round(res.data.confidence);
      const q = $("#question");
      q.value = q.value.trim() ? q.value.trim() + "\n\n" + text : text;
      q.dispatchEvent(new Event("input"));
      state.image.ocrText = text;
      status.textContent = "已识别 · 请逐字核对（置信度仅参考）";
      status.className = "ocr-status is-done";
      bar.style.width = "100%";
      setTimeout(() => { prog.hidden = true; }, 900);
      toast("识别完成。请核对公式与上下标：OCR 常把 x² 读成 2x。");
    } catch (err) {
      status.textContent = "识别失败 · 请手动输入";
      status.className = "ocr-status is-fail";
      prog.hidden = true;
      toast("本地 OCR 未能加载（离线或 CDN 受限）。请直接输入题面；不要假装图片已核对。", true);
    }
  }

  /* ================= 模型配置 ================= */

  function buildSlots() {
    const wrap = $("#slotList");
    wrap.innerHTML = "";
    state.slots.forEach((slot, i) => {
      const preset = PRESET_BY_ID(slot.presetId);
      const isSolver = slot.role === "solver";
      const card = document.createElement("div");
      card.className = "slot-card" + (slot.enabled ? "" : " is-off");
      card.dataset.slot = String(i);
      card.innerHTML = `
        <div class="slot-head">
          <span class="slot-title"><span class="mono">${slot.role.toUpperCase()}</span>${roleLabel(slot.role)}</span>
          ${isSolver ? `<span class="mono" style="color:var(--muted-2)">必需</span>` : `
          <label class="switch" title="启用此档">
            <input type="checkbox" data-enable ${slot.enabled ? "checked" : ""}>
            <span class="track"></span>
          </label>`}
        </div>
        <div class="slot-body">
          <div class="slot-row">
            <div class="inp-group">
              <label>服务商</label>
              <select data-provider>
                ${SM.PRESETS.map((p) => `<option value="${p.id}" ${p.id === slot.presetId ? "selected" : ""}>${p.label}</option>`).join("")}
              </select>
            </div>
            <div class="inp-group">
              <label>模型</label>
              <input data-model value="${escapeAttr(slot.model)}" list="models-${i}" placeholder="模型名">
              <datalist id="models-${i}">${(preset.models || []).map((m) => `<option value="${m}">`).join("")}</datalist>
            </div>
          </div>
          <div class="inp-group">
            <label>端点（自定义端点时必填）</label>
            <input data-base value="${escapeAttr(slot.baseUrl || "")}" placeholder="${escapeAttr(preset.baseUrl || "https://your-endpoint/v1")}">
          </div>
          <div class="inp-group">
            <label>API Key · 仅内存</label>
            <div class="key-row">
              <input data-key type="password" autocomplete="off" placeholder="${slot.apiKey ? "已解锁 · " + API.maskKey(slot.apiKey) : "sk-…"}" spellcheck="false">
              <button class="mini-btn" data-test type="button">测试</button>
            </div>
          </div>
          <div class="slot-status">
            <span data-state class="${slot.apiKey ? "ok" : ""}">${slot.apiKey ? "已解锁 · 内存中" : "未配置"}</span>
            <span data-fp>${slot.apiKey ? "指纹 —" : ""}</span>
          </div>
          ${slot.role === "verifier" ? `<p class="slot-note">建议选择与解题不同的模型族；同源时只给警告，不静默放行。</p>` : ""}
          ${slot.role === "adjudicator" ? `<p class="slot-note">只用于多候选仲裁。未启用时，多候选不会形成交叉一致证据。</p>` : ""}
        </div>`;
      wrap.appendChild(card);

      const providerEl = $("[data-provider]", card);
      const modelEl = $("[data-model]", card);
      const baseEl = $("[data-base]", card);
      const keyEl = $("[data-key]", card);
      const stateEl = $("[data-state]", card);
      const fpEl = $("[data-fp]", card);

      providerEl.addEventListener("change", () => {
        const p = PRESET_BY_ID(providerEl.value);
        slot.presetId = p.id;
        if (!modelEl.value || !p.models.includes(modelEl.value)) modelEl.value = p.models[0] || "";
        slot.model = modelEl.value;
        baseEl.placeholder = p.baseUrl || "https://your-endpoint/v1";
        baseEl.value = p.id === "custom" ? baseEl.value : "";
        slot.baseUrl = baseEl.value;
        const dl = $("datalist", card);
        if (dl) dl.innerHTML = (p.models || []).map((m) => `<option value="${m}">`).join("");
        persist();
      });
      modelEl.addEventListener("input", () => { slot.model = modelEl.value.trim(); persist(); refreshModelButton(); });
      baseEl.addEventListener("input", () => { slot.baseUrl = baseEl.value.trim(); persist(); });
      keyEl.addEventListener("input", async () => {
        const v = keyEl.value.trim();
        if (!v) return;
        slot.apiKey = v;
        stateEl.textContent = "已解锁 · 内存中";
        stateEl.className = "ok";
        fpEl.textContent = "指纹 " + await API.fingerprint(v);
        refreshModelButton();
        updateDrawerState();
      });
      const enable = $("[data-enable]", card);
      if (enable) enable.addEventListener("change", () => {
        slot.enabled = enable.checked;
        card.classList.toggle("is-off", !slot.enabled);
        refreshModelButton();
        updateDrawerState();
        persist();
      });

      $("[data-test]", card).addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        if (keyEl.value.trim()) slot.apiKey = keyEl.value.trim();
        if (!slot.apiKey) return toast("先填入 API Key。", true);
        if (!modelEl.value.trim()) return toast("先填模型名。", true);
        slot.model = modelEl.value.trim();
        slot.baseUrl = baseEl.value.trim();
        btn.disabled = true; btn.textContent = "测试中";
        stateEl.textContent = "正在发送最小请求…";
        stateEl.className = "";
        try {
          const reply = await API.testConnection(slot);
          stateEl.textContent = "连接正常 · " + reply;
          stateEl.className = "ok";
          toast("连接正常。");
        } catch (err) {
          stateEl.textContent = "失败：" + err.message.slice(0, 60);
          stateEl.className = "bad";
          toast(err.message, true);
        } finally {
          btn.disabled = false; btn.textContent = "测试";
          updateDrawerState();
        }
      });
    });
    updateDrawerState();
  }

  function roleLabel(role) {
    return role === "solver" ? "解题模型" : role === "verifier" ? "独立审核" : "第三方仲裁";
  }

  function escapeAttr(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function openDrawer() {
    buildSlots();
    $("#settingsDrawer").classList.add("is-open");
    $("#settingsDrawer").setAttribute("aria-hidden", "false");
    $("#scrim").hidden = false;
    $("#drawerClose").focus();
  }

  function closeDrawer() {
    $("#settingsDrawer").classList.remove("is-open");
    $("#settingsDrawer").setAttribute("aria-hidden", "true");
    $("#scrim").hidden = true;
    $$("[data-key]", $("#slotList")).forEach((el) => { el.value = ""; });
    persist();
  }

  function bindSettings() {
    $("#modelBtn").addEventListener("click", openDrawer);
    $("#drawerClose").addEventListener("click", closeDrawer);
    $("#drawerDone").addEventListener("click", closeDrawer);
    $("#scrim").addEventListener("click", closeDrawer);
    $(".modal-scrim").addEventListener("click", closeModal);
    $$("[data-close]").forEach((el) => el.addEventListener("click", closeModal));
    $("#distinctFamilies").addEventListener("change", (e) => {
      state.requireDistinct = e.target.checked;
      persist();
      if (state.requireDistinct) checkDistinctNow();
    });
    $("#preservePartial").addEventListener("change", (e) => { state.preservePartial = e.target.checked; });
  }

  function checkDistinctNow() {
    const fams = state.slots.filter((s) => s.role === "solver" || s.enabled).map(familyOf);
    const dup = fams.find((f, i) => fams.indexOf(f) !== i);
    if (dup) toast("同源：" + PRESET_BY_ID(dup).label + " 出现在两个档位。运行时会抛错「禁止同源模型自我复核或自我仲裁」。", true);
  }

  function updateDrawerState() {
    const solver = state.slots[0];
    const parts = [solver.apiKey ? "solver 就绪" : "solver 未配置"];
    if (state.slots[1].enabled) parts.push("verifier " + (state.slots[1].apiKey ? "就绪" : "缺 Key"));
    if (state.slots[2].enabled) parts.push("adjudicator " + (state.slots[2].apiKey ? "就绪" : "缺 Key"));
    $("#drawerState").textContent = parts.join(" · ");
  }

  function refreshModelButton() {
    const btn = $("#modelBtn");
    const solver = state.slots[0];
    const ready = solver.apiKey && solver.model;
    btn.classList.toggle("is-ready", !!ready);
    btn.classList.toggle("is-demo", !ready);
    if (ready) {
      $("#modelBtnText").textContent = solver.model;
    } else {
      $("#modelBtnText").textContent = "未配置 · 可演示";
    }
  }

  /* ================= 方法页 ================= */

  function renderStatic() {
    $("#methodRedlines").innerHTML = SM.REDLINES.map((r) => `
      <div class="rl-row"><code>${r.id}</code><p>命中样例：${r.sample}<br>${r.why}</p></div>`).join("");
    $("#methodNonEvents").innerHTML = SM.NON_EVENTS.map((n) => `<li>${n}</li>`).join("");
  }

  /* ================= 运行 ================= */

  async function run() {
    if (state.running) return;
    const question = $("#question").value.trim();
    if (!question) {
      toast("先输入题目，或点「载入示例」。", true);
      $("#question").focus();
      return;
    }
    if (state.requireDistinct) {
      const fams = state.slots.filter((s) => s.role === "solver" || s.enabled).map(familyOf);
      const dup = fams.find((f, i) => fams.indexOf(f) !== i);
      if (dup) {
        toast("禁止同源模型自我复核或自我仲裁：三档 model family 必须两两不同。", true);
        return;
      }
    }
    const solver = state.slots[0];
    const canReal = solver.apiKey && solver.model;
    if (!canReal) {
      await runDemo(question);
      return;
    }

    state.running = true;
    state.controller = new AbortController();
    $("#runBtn").disabled = true;
    $("#runBtn .run-label").textContent = "判题中…";
    $("#stageEmpty").hidden = true;
    $("#stageResult").hidden = true;
    $("#stageRun").hidden = false;
    $("#stageStatus").className = "stage-status is-run";
    $("#stageStatus").innerHTML = "<i></i>运行中";
    $("#stageMeta").textContent = "Key 只在内存 · 请求直连服务商";
    $("#stageScroll").scrollTop = 0;
    $("#runClock").textContent = "0.0s";
    $("#runId").textContent = "RUN #" + Date.now().toString(36).slice(-4).toUpperCase();

    const steps = [
      ["extract", "审题 · 提取题目契约"],
      ["solve", "独立求解"],
      ["redline", "红线扫描"],
      ["verify", "独立审核"],
      ["gates", "程序化验收"],
      ["adjudicate", "第三方仲裁"],
      ["evidence", "证据量判定"],
      ["render", "确定性渲染"],
    ];
    $("#trace").innerHTML = steps.map(([id, name], i) => `
      <li class="trace-item" data-t="${id}">
        <span class="t-no">${String(i + 1).padStart(2, "0")}</span>
        <span class="t-icon"></span>
        <span class="t-name">${name}</span>
        <span class="t-note">等待</span>
      </li>`).join("");

    const t0 = performance.now();
    const clock = setInterval(() => { $("#runClock").textContent = ((performance.now() - t0) / 1000).toFixed(1) + "s"; }, 100);
    let callCount = 0;
    const budget = () => { $("#runBudget").innerHTML = `<span>模型调用 <b>${callCount}</b> · 候选 ${state.candidates}</span><span>${state.mode.toUpperCase()} · 上限 ${state.candidates * 4 + 2} 次</span>`; };
    budget();

    const diagram = state.image ? {
      ocrText: state.image.ocrText || "（用户未运行 OCR，仅提供图片；题面由用户输入）",
      template: "",
      boundsNote: "不得从示意图比例、视觉长度或角度推断未给定的数值。",
      userVerified: $("#verifiedCheck").checked,
    } : undefined;

    const uncertainties = ($("#uncertainties").value || "").split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);

    const hooks = {
      onEvent(e) {
        const el = $(`[data-t="${e.id}"]`);
        if (!el) return;
        el.classList.remove("is-run", "is-done", "is-warn", "is-fail", "is-skip");
        if (e.state === "run") el.classList.add("is-run");
        else if (e.state === "done") el.classList.add("is-done");
        else if (e.state === "warn") el.classList.add("is-warn");
        else if (e.state === "fail") el.classList.add("is-fail");
        else if (e.state === "skip") el.classList.add("is-skip");
        const note = $(".t-note", el);
        if (note) note.textContent = e.note || "";
        if (e.state === "run" && e.id === "extract") {
          $("#runTitle").textContent = "正在审题";
          callCount++;
          budget();
        }
        if (e.state === "run" && e.id === "solve") { $("#runTitle").textContent = "独立求解 " + state.candidates + " 路"; callCount += state.candidates; budget(); }
        if (e.state === "run" && e.id === "verify") { $("#runTitle").textContent = "独立审核"; callCount += Math.min(state.candidates, 2); budget(); }
        if (e.state === "run" && e.id === "adjudicate") { $("#runTitle").textContent = "第三方仲裁"; callCount++; budget(); }
        if (e.state === "done" && e.id === "render") $("#runTitle").textContent = "正在组装结果";
      },
    };

    try {
      const result = await Solver.runSolve(
        { question, diagram, uncertainties, imageDataUrl: state.image ? state.image.dataUrl : null },
        {
          slots: {
            solver: { ...state.slots[0], family: familyOf(state.slots[0]) },
            verifier: state.slots[1].enabled ? { ...state.slots[1], family: familyOf(state.slots[1]) } : null,
            adjudicator: state.slots[2].enabled ? { ...state.slots[2], family: familyOf(state.slots[2]) } : null,
          },
          candidates: state.candidates,
          mode: state.mode,
          strictEvidence: state.strictEvidence,
          repair: true,
          ragChunks: state.useLibrary ? collectRagChunks(question) : [],
        },
        hooks
      );
      if (result.aborted) {
        toast("已中断。已生成的候选按「部分步骤」保留，不构成答案。");
        if (state.preservePartial) {
          showPartial(result, question);
        } else {
          $("#stageRun").hidden = true;
          $("#stageEmpty").hidden = false;
          setStageIdle();
        }
        return;
      }
      await presentResult(result, false);
    } catch (err) {
      $("#stageRun").hidden = true;
      $("#stageResult").hidden = false;
      $("#stageResult").innerHTML = `
        <div class="result-head result-head--unresolved">
          <div>
            <div class="result-kicker"><span class="st st--unresolved"><i></i>failed</span><span class="mono">RUN ABORTED</span></div>
            <h2 class="result-title">这次判题没有完成。</h2>
            <p class="result-sub">${escapeHtml(err.message)}</p>
          </div>
          <div class="result-actions"><button class="btn btn--sm" data-action="settings">检查模型配置</button></div>
        </div>
        <div class="result-foot"><span>没有输出任何答案</span><span>失败关闭</span></div>`;
      $("#stageStatus").className = "stage-status is-warn";
      $("#stageStatus").innerHTML = "<i></i>请求失败";
      $("#stageMeta").textContent = "未写出任何结论";
      toast(err.message, true);
      bindResultActions();
    } finally {
      clearInterval(clock);
      state.running = false;
      state.controller = null;
      $("#runBtn").disabled = false;
      $("#runBtn .run-label").textContent = "开始判题";
    }
  }

  function cancelRun() {
    if (state.controller) state.controller.abort();
  }

  function setStageIdle() {
    $("#stageStatus").className = "stage-status";
    $("#stageStatus").innerHTML = "<i></i>待命";
    $("#stageMeta").textContent = "无请求发出";
  }

  function collectRagChunks(question) {
    if (!state.index || !state.docs.length) return [];
    const hits = Store.search(state.index, question.slice(0, 300), 4);
    return hits.filter((h) => h.score > 0.002).map((h) => ({ docTitle: h.docTitle, page: h.page, text: h.text.slice(0, 900) }));
  }

  /* ================= 本地演示 ================= */

  async function runDemo(question) {
    state.running = true;
    state.controller = new AbortController();
    $("#runBtn").disabled = true;
    $("#runBtn .run-label").textContent = "演示中…";
    $("#stageEmpty").hidden = true;
    $("#stageResult").hidden = true;
    $("#stageRun").hidden = false;
    $("#stageStatus").className = "stage-status is-run";
    $("#stageStatus").innerHTML = "<i></i>本地演示";
    $("#stageMeta").textContent = "不发送任何数据 · 无 API 请求";
    $("#stageScroll").scrollTop = 0;

    const steps = [
      ["extract", "审题 · 提取题目契约", "示例契约 · 1 个目标"],
      ["solve", "独立求解", "2 路候选（示例）"],
      ["redline", "红线扫描", "候选 2 命中 1 处"],
      ["verify", "独立审核", "2 份完成"],
      ["gates", "程序化验收", "1 份通过"],
      ["adjudicate", "第三方仲裁", "agree"],
      ["evidence", "证据量判定", "sufficient · high"],
      ["render", "确定性渲染", "Markdown 由代码组装"],
    ];
    $("#trace").innerHTML = steps.map(([id, name], i) => `
      <li class="trace-item" data-t="${id}">
        <span class="t-no">${String(i + 1).padStart(2, "0")}</span>
        <span class="t-icon"></span>
        <span class="t-name">${name}</span>
        <span class="t-note">等待</span>
      </li>`).join("");
    $("#runTitle").textContent = "本地演示";
    $("#runClock").textContent = "0.0s";
    $("#runId").textContent = "DEMO #001";
    $("#runBudget").innerHTML = "<span>模型调用 <b>0</b> · 不发送任何请求</span><span>示例数据 · 非真实模型输出</span>";

    const demo = SM.DEMO;
    const spec = JSON.parse(JSON.stringify(demo.spec));
    const candidates = demo.candidates.map((c) => JSON.parse(JSON.stringify(c)));
    const verifications = demo.verifications.map((v) => JSON.parse(JSON.stringify(v)));

    for (let i = 0; i < steps.length; i++) {
      if (state.controller.signal.aborted) break;
      const el = $(`[data-t="${steps[i][0]}"]`);
      el.classList.add("is-run");
      $(".t-note", el).textContent = "运行中";
      await new Promise((r) => setTimeout(r, 420));
      el.classList.remove("is-run");
      el.classList.add(steps[i][0] === "redline" ? "is-warn" : "is-done");
      $(".t-note", el).textContent = steps[i][2];
      $("#runClock").textContent = (((i + 1) * 0.42)).toFixed(1) + "s";
    }

    const evaluated = candidates.map((c, i) => {
      const redlines = Solver.scanRedlines(c);
      const report = verifications[i];
      const blockers = i === 0 ? [] : ["候选命中 1 条输出红线，降级为 needs_review。"];
      return { index: i, candidate: c, report, redlines, blockers };
    });
    const selected = evaluated[0];
    const evidence = Solver.computeEvidence(spec, selected.candidate, selected.report, {
      independentVerifier: true, independentAdjudicator: true, crossModelAgree: true,
    });
    const warnings = [
      "红线命中 [obvious_step] @s2（steps.s2.justification）：用「显然 / 易证」代替关键论证，是跳步最常见的藏身处。片段「…由对称性显然，最小值在 x=2 处取得…」",
    ];
    const degrade = ["候选 2 未通过验收：候选命中 1 条输出红线，降级为 needs_review。"];
    const result = {
      status: "verified", assurance: "cross_checked", spec, question,
      candidates: evaluated, selectedCandidate: selected.candidate, selectedIndex: 0,
      verification: selected.report,
      adjudication: demo.adjudication,
      evidence, warnings, degradeReasons: degrade,
      images: [], createdAt: new Date().toISOString(),
      durationMs: 3360, usage: 0, demo: true,
    };
    result.markdown = Solver.renderResultMarkdown(result);
    await presentResult(result, true);

    state.running = false;
    state.controller = null;
    $("#runBtn").disabled = false;
    $("#runBtn .run-label").textContent = "开始判题";
  }

  function showPartial() {
    $("#stageRun").hidden = true;
    $("#stageEmpty").hidden = false;
    setStageIdle();
  }

  /* ================= 结果渲染 ================= */

  async function presentResult(result, demo) {
    state.lastResult = result;
    $("#stageRun").hidden = true;
    $("#stageEmpty").hidden = true;
    $("#stageResult").hidden = false;
    $("#stageResult").innerHTML = buildResultHtml(result, demo);
    $("#stageScroll").scrollTop = 0;

    $("#stageStatus").className = "stage-status " + (result.status === "verified" ? "is-ok" : result.status === "needs_review" ? "is-warn" : "");
    $("#stageStatus").innerHTML = "<i></i>" + (result.status === "verified" ? "已通过验收" : result.status === "needs_review" ? "需要人工复核" : "未解决");
    $("#stageMeta").textContent = (result.usage ? result.usage + " tokens · " : "") + (result.durationMs / 1000).toFixed(1) + "s";

    enhanceMath($("#stageResult"));
    bindResultActions();

    const id = uid();
    try {
      await Store.putArchive({
        id, createdAt: result.createdAt, question: result.question,
        status: result.status, assurance: result.assurance,
        evidence: result.evidence, markdown: result.markdown, demo: !!demo,
      });
      const all = await Store.allArchive();
      if (all.length > 60) {
        for (const old of all.slice(60)) await Store.deleteArchive(old.id);
      }
      loadArchive();
    } catch (_) {}
  }

  function statusMeta(status) {
    switch (status) {
      case "verified": return { cls: "verified", label: "verified", title: "通过程序化验收。", sub: "结论来自通过完整检查的候选；它不等于数学意义上的终审。" };
      case "needs_review": return { cls: "review", label: "needs_review", title: "答案已降级，需要人工复核。", sub: "程序化门槛拦住了至少一份候选，最终结论不成立为确定答案。" };
      case "unresolved": return { cls: "unresolved", label: "unresolved", title: "没有候选通过，未输出确定答案。", sub: "失败关闭：宁可没有答案，也不编一个。" };
      default: return { cls: "review", label: status, title: "未完成。", sub: "" };
    }
  }

  function buildResultHtml(r, demo) {
    const meta = statusMeta(r.status);
    const ev = r.evidence;
    const c = r.selectedCandidate;
    const total = (ev.totalTargets + ev.totalSteps) || 1;
    const done = ev.verifiedTargets + ev.verifiedSteps;
    const ratio = Math.max(0, Math.min(1, done / total));
    const segs = 14;
    const onCount = Math.round(ratio * segs);
    const bars = Array.from({ length: segs }, (_, i) =>
      `<i class="${i < onCount ? (ev.sufficient ? "on" : "warn") : ""}"></i>`).join("");

    const reasons = (r.degradeReasons || []).slice(0, 3);
    const subline = r.status === "verified"
      ? (demo ? "本地演示：示例候选 0 通过全部门槛；演示数据不调用模型。" : `${r.candidates.filter((x) => !x.blockers.length).length} 份候选通过全部门槛，证据级别 ${r.assurance}。`)
      : reasons[0] || meta.sub;

    const answers = c && c.finalAnswers && c.finalAnswers.length
      ? c.finalAnswers.map((a) => `<div class="answer-row"><span class="obj">${escapeHtml(a.objectiveId)}</span><div>${formatText(a.value)}</div></div>`).join("")
      : `<p class="muted-line">没有可展示的最终答案。降级原因见下方。</p>`;

    const steps = c && c.steps && c.steps.length
      ? c.steps.map((s) => `
        <div class="step">
          <span class="step-no">${escapeHtml(s.id)}</span>
          <div>
            <div class="step-claim">${formatText(s.claim)}</div>
            <div class="step-why">${formatText(s.justification)}</div>
          </div>
        </div>`).join("")
      : `<p class="muted-line">没有可展示的结构化步骤。</p>`;

    const ledger = (r.candidates || []).length > 1
      ? `<section class="r-sec">
          <h3>候选台账</h3>
          <div class="cand-list">${(r.candidates || []).map((x, i) => {
            const blockers = x.blockers || [];
            const ok = blockers.length === 0;
            const sel = r.selectedIndex === i;
            const fb = x.candidate && x.candidate.finalAnswers && x.candidate.finalAnswers[0];
            const line = ok
              ? ((fb && fb.value) || "通过结构、漏审、红线与证据量检查。")
              : blockers.slice(0, 2).join(" ");
            return `<div class="cand ${ok ? "is-pass" : "is-block"}">
              <span class="cand-no">0${i + 1}</span>
              <div class="cand-main">
                <b>候选 ${i + 1} · ${ok ? (sel ? "通过验收，已采用" : "通过验收，未采用") : "被门槛拦下"}</b>
                <p>${escapeHtml(String(line).slice(0, 160))}</p>
              </div>
              <span class="cand-tag">${ok ? "PASS" : "BLOCKED"}</span>
            </div>`;
          }).join("")}</div>
          <p class="tiny">候选之间互不可见。被拦下的候选不会被删除：拒绝理由留在这里，也留在 Markdown 里。</p>
        </section>`
      : "";

    const warnings = (r.warnings || []).length
      ? r.warnings.map((w) => {
        const isRed = /红线|同源|未通过|证据不足|未核对/.test(w);
        const tag = /红线/.test(w) ? "REDLINE" : /证据/.test(w) ? "EVIDENCE" : /同源|独立性/.test(w) ? "INDEPENDENCE" : "GATE";
        return `<div class="warn-item ${isRed ? "warn-item--red" : ""}"><span class="mono">${tag}</span>${escapeHtml(w)}</div>`;
      }).join("")
      : `<p class="muted-line">没有降级或警告。仍不代表绝对正确。</p>`;

    const spec = r.spec || {};
    const specRows = [
      ["学科", spec.subject === "physics" ? "物理" : "数学"],
      ["领域", spec.domain || "未分类"],
      ["目标", (spec.objectives || []).length + " 个"],
      ["图片", spec.diagram ? (spec.diagram.userVerified ? "已人工核对" : "未核对") : "无"],
    ].map(([k, v]) => `<div class="spec-row"><span>${k}</span><b>${escapeHtml(String(v))}</b></div>`).join("");

    const ar = r.adjudication;
    const adj = ar ? `<div class="side-block">
        <span class="mono">ADJUDICATION</span>
        <div class="spec-mini">
          <div class="spec-row"><span>关系</span><b>${escapeHtml(ar.relationship)}</b></div>
          <div class="spec-row"><span>选中</span><b>${ar.selectedCandidate === null ? "—" : "候选 " + (ar.selectedCandidate + 1)}</b></div>
        </div>
        <p class="tiny">${escapeHtml((ar.rationale || "").slice(0, 180))}</p>
      </div>` : "";

    const verifySummary = r.verification
      ? `<div class="side-block">
          <span class="mono">VERIFIER</span>
          <p class="tiny">${escapeHtml((r.verification.summary || "").slice(0, 220))}</p>
          <div class="spec-mini">
            <div class="spec-row"><span>verdict</span><b>${escapeHtml(r.verification.verdict)}</b></div>
            <div class="spec-row"><span>issues</span><b>${(r.verification.issues || []).length}</b></div>
          </div>
        </div>`
      : "";

    return `
      ${demo ? `<div class="demo-strip"><span class="mono">LOCAL DEMO</span>本地演示：示例候选与示例审核，不调用任何模型、不发送任何数据。配置 Key 后可运行真实判题。</div>` : ""}
      <div class="result-head result-head--${meta.cls}">
        <div>
          <div class="result-kicker">
            <span class="st st--${meta.cls}"><i></i>${meta.label}</span>
            <span class="mono">ASSURANCE / ${r.assurance}</span>
          </div>
          <h2 class="result-title">${meta.title}</h2>
          <p class="result-sub">${escapeHtml(subline)}</p>
        </div>
        <div class="result-actions">
          <button class="btn btn--sm" data-action="copy">复制 Markdown</button>
          <button class="btn btn--sm" data-action="download">导出 .md</button>
          <button class="btn btn--sm" data-action="evidence">证据 JSON</button>
        </div>
      </div>

      <div class="result-grid">
        <div class="result-main">
          <section class="r-sec">
            <h3>题目</h3>
            <div class="r-answer">${formatText(r.question)}</div>
          </section>
          <section class="r-sec">
            <h3>最终答案</h3>
            <div class="r-answer">${answers}</div>
          </section>
          ${ledger}
          <section class="r-sec">
            <h3>可审计的步骤</h3>
            <div class="step-list">${steps}</div>
          </section>
          <section class="r-sec">
            <h3>降级与警告</h3>
            <div class="warn-list">${warnings}</div>
          </section>
          <section class="r-sec">
            <h3>判定依据</h3>
            <p class="tiny">最终 Markdown 由代码按固定模板组装，输出层没有第二次模型改写。状态 ${r.status} 表示通过本流程的程序化检查，不表示绝对正确。</p>
          </section>
        </div>

        <aside class="result-side">
          <div class="ev">
            <div class="ev-head"><span>EVIDENCE</span><b>${done}/${total} · ${ev.confidence}</b></div>
            <div class="ev-bar">${bars}</div>
            <div class="ev-rows">
              <div class="ev-row"><span>目标覆盖</span><b>${ev.verifiedTargets}/${ev.totalTargets}</b></div>
              <div class="ev-row"><span>步骤覆盖</span><b>${ev.verifiedSteps}/${ev.totalSteps}</b></div>
              <div class="ev-row"><span>独立审核</span><b class="${ev.independentVerifier ? "yes" : "no"}">${ev.independentVerifier ? "是" : "否"}</b></div>
              <div class="ev-row"><span>独立仲裁</span><b class="${ev.independentAdjudicator ? "yes" : "no"}">${ev.independentAdjudicator ? "是" : "否"}</b></div>
              <div class="ev-row"><span>交叉一致</span><b>${ev.crossModelAgree === null ? "未形成" : ev.crossModelAgree ? "是" : "否"}</b></div>
              <div class="ev-row"><span>证据充足</span><b class="${ev.sufficient ? "yes" : "no"}">${ev.sufficient ? "是" : "否"}</b></div>
            </div>
            ${(ev.insufficientReasons || []).length ? `<div class="ev-reasons">${ev.insufficientReasons.map((x) => `<span>× ${escapeHtml(x)}</span>`).join("")}</div>` : ""}
          </div>

          <div class="side-block">
            <span class="mono">SPEC</span>
            <div class="spec-mini">${specRows}</div>
          </div>

          ${verifySummary}
          ${adj}

          <div class="ne-mini">
            <h4>这里不会发生什么</h4>
            <ul>${SM.NON_EVENTS.slice(0, 5).map((n) => `<li>${escapeHtml(n.replace(/：.*$/, ""))}</li>`).join("")}</ul>
          </div>
        </aside>
      </div>
      <div class="result-foot">
        <span>RUN ${r.createdAt.slice(0, 19).replace("T", " ")} · ${r.durationMs}ms</span>
        <span>已存入本机档案 · 未上传</span>
      </div>`;
  }

  function formatText(text) {
    const s = String(text || "");
    return escapeHtml(s).replace(/\n/g, "<br>");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function enhanceMath(root) {
    if (!root || !window.renderMathInElement) return;
    try {
      window.renderMathInElement(root, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
        ],
        throwOnError: false,
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      });
    } catch (_) {}
  }

  function bindResultActions() {
    $$("[data-action]").forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", async () => {
        const action = btn.dataset.action;
        if (action === "settings") return openDrawer();
        const r = state.lastResult;
        if (action === "copy") {
          if (!r) return;
          try { await navigator.clipboard.writeText(r.markdown); toast("已复制确定性 Markdown。"); }
          catch (_) { toast("复制失败，请手动选择。", true); }
        }
        if (action === "download") {
          if (!r) return;
          downloadText("sciencemind-" + (r.status || "result") + "-" + Date.now() + ".md", r.markdown);
        }
        if (action === "evidence") {
          if (!r) return;
          openModal("EVIDENCE OBJECT", `<pre class="code-block"><code>${escapeHtml(JSON.stringify(r.evidence, null, 2))}</code></pre>
            <p class="tiny" style="margin-top:12px">confidence 是程序化证据强度（high / medium / low），不是模型自报的概率。</p>`);
        }
      });
    });
  }

  function downloadText(name, text, type) {
    const blob = new Blob([text], { type: type || "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ================= 档案 ================= */

  async function loadArchive() {
    try {
      const list = await Store.allArchive();
      $("#archCount").textContent = list.length;
      renderArchive(list);
    } catch (_) {}
  }

  async function renderArchive(list) {
    if (!list) list = await Store.allArchive();
    const wrap = $("#archiveList");
    if (!list.length) {
      wrap.innerHTML = `<div class="arch-empty"><span class="mono">NO RECORDS</span><p>还没有判定记录。回到解题，跑一道题。</p></div>`;
      return;
    }
    wrap.innerHTML = list.map((a) => {
      const meta = statusMeta(a.status);
      const d = new Date(a.createdAt);
      return `<div class="arch-item" data-id="${a.id}">
        <div class="date">${d.toLocaleDateString("zh-CN")}<br>${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</div>
        <div>
          <h3>${escapeHtml(a.question || "（无题目）")}</h3>
          <p>${a.assurance || ""} · 证据 ${(a.evidence && a.evidence.confidence) || "—"}${a.demo ? " · 本地演示" : ""}</p>
        </div>
        <span class="st st--${meta.cls}"><i></i>${a.status}</span>
      </div>`;
    }).join("");
    $$(".arch-item", wrap).forEach((el) => el.addEventListener("click", async () => {
      const item = (await Store.allArchive()).find((x) => x.id === el.dataset.id);
      if (!item) return;
      openModal("ARCHIVE / " + item.status, `
        <div class="md">${Solver.mdToHtml(item.markdown)}</div>
        <p class="tiny" style="margin-top:16px">记录于 ${item.createdAt} · 仅存本机</p>`);
      enhanceMath($("#modalBody"));
    }));
  }

  function bindArchive() {
    $("#clearArchive").addEventListener("click", async () => {
      if (!confirm("清空本机档案？此操作不可撤销。")) return;
      await Store.clearArchive();
      await loadArchive();
      toast("档案已清空。");
    });
  }

  /* ================= 资料库 ================= */

  async function loadDocs() {
    try {
      state.docs = await Store.allDocs();
      state.index = Store.buildIndex(state.docs);
      $("#libDocs").textContent = state.docs.length;
      $("#libPages").textContent = state.docs.reduce((n, d) => n + (d.pageCount || 0), 0);
      $("#libChunks").textContent = state.docs.reduce((n, d) => n + (d.chunks || []).length, 0);
      renderDocList();
    } catch (_) {}
  }

  function renderDocList() {
    const wrap = $("#docList");
    if (!state.docs.length) {
      wrap.innerHTML = `<div class="empty-mini"><span class="mono">EMPTY</span><p>这里还没有资料。导入一本讲义，解题时勾选「注入资料库片段」即可引用。</p></div>`;
      return;
    }
    wrap.innerHTML = state.docs.map((d) => `
      <div class="doc-item" data-id="${d.id}">
        <div><b title="${escapeAttr(d.title)}">${escapeHtml(d.title)}</b><span>${d.pageCount || 0} 页 · ${(d.chunks || []).length} 片段 · ${(d.size / 1024 / 1024).toFixed(1)} MB</span></div>
        <button class="del" data-del="${d.id}" title="删除">删除</button>
      </div>`).join("");
    $$("[data-del]", wrap).forEach((b) => b.addEventListener("click", async (e) => {
      e.stopPropagation();
      await Store.deleteDoc(b.dataset.del);
      await loadDocs();
      toast("已从本机删除。");
    }));
  }

  async function importFile(file) {
    const status = $("#importStatus");
    status.hidden = false;
    status.className = "import-status";
    status.textContent = "正在读取《" + file.name + "》…";
    try {
      let extracted;
      if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
        extracted = await Store.extractPdf(file, (done, total) => {
          status.textContent = "解析 PDF：第 " + done + " / " + total + " 页…";
        });
      } else {
        extracted = await Store.extractText(file);
      }
      const chunks = [];
      let emptyPages = 0;
      for (const p of extracted.pages) {
        if (!p.text || p.text.length < 8) { emptyPages++; continue; }
        for (const text of Store.chunkText(p.text, 700)) chunks.push({ page: p.no, text });
      }
      if (!chunks.length) throw new Error("没有提取到可用文本。扫描版 PDF 需要 OCR，本版不做假识别。");
      const doc = {
        id: uid(),
        title: file.name.replace(/\.(pdf|txt|md)$/i, ""),
        kind: /\.pdf$/i.test(file.name) ? "pdf" : "text",
        size: file.size,
        pageCount: extracted.pages.length,
        truncated: extracted.truncated,
        emptyPages,
        chunks,
        original: file.size < 12 * 1024 * 1024 ? await fileToDataUrl(file) : null,
        createdAt: new Date().toISOString(),
      };
      await Store.putDoc(doc);
      await loadDocs();
      status.className = "import-status is-done";
      status.innerHTML = `已导入《${escapeHtml(doc.title)}》：${chunks.length} 个片段，${doc.pageCount} 页${emptyPages ? `，${emptyPages} 页未提取到文字（不会被检索到）` : ""}。${extracted.truncated ? " 超过 500 页，已截断。" : ""}`;
      toast("资料已存入本机 IndexedDB。");
    } catch (err) {
      status.className = "import-status is-fail";
      status.textContent = "导入失败：" + err.message;
    }
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  function bindLibrary() {
    $("#docInput").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importFile(file);
      e.target.value = "";
    });
    const dz = $("#dropzone");
    ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("is-over"); }));
    dz.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) importFile(file);
    });

    $("#libSearchBtn").addEventListener("click", doSearch);
    $("#libQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

    $("#exportLite").addEventListener("click", () => exportBackup("lite"));
    $("#exportFull").addEventListener("click", () => exportBackup("full"));
  }

  function doSearch() {
    const q = $("#libQuery").value.trim();
    const wrap = $("#libResults");
    if (!q) { wrap.innerHTML = `<p class="muted-line">输入关键词后再检索。索引在本机构建，不发送查询。</p>`; return; }
    if (!state.index || !state.index.entries.length) { wrap.innerHTML = `<p class="muted-line">资料库为空，先导入一份资料。</p>`; return; }
    const hits = Store.search(state.index, q, 6);
    if (!hits.length) { wrap.innerHTML = `<p class="muted-line">没有命中。换一个更具体的术语或符号。</p>`; return; }
    wrap.innerHTML = hits.map((h) => `
      <div class="hit">
        <div class="hit-head"><b>《${escapeHtml(h.docTitle)}》</b><span>P${h.page} · ${h.score.toFixed(3)}</span></div>
        <p>${escapeHtml(h.text.slice(0, 260))}</p>
      </div>`).join("");
  }

  async function exportBackup(kind) {
    try {
      toast("正在打包 " + kind + "…");
      const payload = await Store.buildBackup(kind);
      downloadText("sciencemind-" + kind + "-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(payload, null, 2), "application/json");
      toast(kind === "lite" ? "lite 包已生成：丢的是原件，不是内容。" : "full 包已生成：含原文与题图。");
    } catch (err) {
      toast("导出失败：" + err.message, true);
    }
  }

  /* ================= 模态 / 提示 ================= */

  function openModal(kicker, html) {
    $("#modalKicker").textContent = kicker;
    $("#modalBody").innerHTML = html;
    $("#modal").hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeModal() {
    $("#modal").hidden = true;
    $("#modalBody").innerHTML = "";
    document.body.style.overflow = "";
  }
  let toastTimer;
  function toast(msg, bad) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast is-on" + (bad ? " is-bad" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast"; }, bad ? 5200 : 3200);
  }

  /* ================= 键盘 / 自动锁定 ================= */

  function bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); run(); }
      if (e.key === "Escape") { closeModal(); if ($("#settingsDrawer").classList.contains("is-open")) closeDrawer(); }
    });
    ["pointerdown", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, () => { state.lastActivity = Date.now(); }, { passive: true }));
  }

  function lockVault(reason) {
    if (!state.slots.some((s) => s.apiKey)) return;
    state.slots.forEach((s) => { s.apiKey = ""; });
    refreshModelButton();
    buildSlots();
    updateDrawerState();
    toast("已锁定：" + reason + "。密钥已从内存清除，刷新后不会恢复。", true);
  }

  function bindAutoLock() {
    setInterval(() => {
      if (Date.now() - state.lastActivity > 15 * 60 * 1000) lockVault("空闲 15 分钟");
    }, 30000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        state.hiddenAt = Date.now();
      } else if (state.hiddenAt && Date.now() - state.hiddenAt > 3 * 60 * 1000) {
        lockVault("页面隐藏超过 3 分钟");
        state.hiddenAt = 0;
      }
    });
    window.addEventListener("pagehide", () => { state.slots.forEach((s) => { s.apiKey = ""; }); });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
