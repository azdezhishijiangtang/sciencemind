/* ScienceMind — 本地存储与检索
   IndexedDB：资料文档、可检索片段、判定档案。
   localStorage：只存非敏感偏好，绝不存 Key。 */

(function () {
  const DB_NAME = "sciencemind";
  const DB_VER = 1;
  let dbp = null;

  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("docs")) {
          const s = db.createObjectStore("docs", { keyPath: "id" });
          s.createIndex("createdAt", "createdAt");
        }
        if (!db.objectStoreNames.contains("archive")) {
          const s = db.createObjectStore("archive", { keyPath: "id" });
          s.createIndex("createdAt", "createdAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB 打开失败"));
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      try { out = fn(s); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("事务中止"));
    }));
  }

  function reqPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function putDoc(doc) { await tx("docs", "readwrite", (s) => s.put(doc)); return doc; }
  async function getDoc(id) { const db = await openDB(); const t = db.transaction("docs"); return reqPromise(t.objectStore("docs").get(id)); }
  async function allDocs() {
    const db = await openDB();
    const t = db.transaction("docs");
    const list = await reqPromise(t.objectStore("docs").getAll());
    return list.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }
  async function deleteDoc(id) { await tx("docs", "readwrite", (s) => s.delete(id)); }

  async function putArchive(item) { await tx("archive", "readwrite", (s) => s.put(item)); return item; }
  async function getArchive(id) {
    const db = await openDB();
    const t = db.transaction("archive");
    return reqPromise(t.objectStore("archive").get(id));
  }
  async function allArchive() {
    const db = await openDB();
    const t = db.transaction("archive");
    const list = await reqPromise(t.objectStore("archive").getAll());
    return list.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }
  async function deleteArchive(id) { await tx("archive", "readwrite", (s) => s.delete(id)); }
  async function clearArchive() { await tx("archive", "readwrite", (s) => s.clear()); }

  /* ---------- 偏好 ---------- */
  const PREF_KEY = "sm.prefs.v1";
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch (_) { return {}; }
  }
  function savePrefs(p) {
    const safe = {
      slots: (p.slots || []).map((s) => ({ presetId: s.presetId, model: s.model, baseUrl: s.baseUrl, enabled: s.enabled })),
      candidates: p.candidates, mode: p.mode, strictEvidence: p.strictEvidence,
      requireDistinct: p.requireDistinct, useLibrary: p.useLibrary,
    };
    try { localStorage.setItem(PREF_KEY, JSON.stringify(safe)); } catch (_) {}
  }

  /* ---------- 文本切片 ---------- */
  function chunkText(text, maxLen) {
    maxLen = maxLen || 700;
    const clean = String(text || "").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
    if (!clean) return [];
    const parts = clean.split(/\n{2,}/);
    const chunks = [];
    let buf = "";
    const push = () => {
      if (buf.trim()) chunks.push(buf.trim());
      buf = "";
    };
    for (const part of parts) {
      if (part.length > maxLen) {
        push();
        for (let i = 0; i < part.length; i += maxLen) chunks.push(part.slice(i, i + maxLen));
        continue;
      }
      if ((buf + "\n" + part).length > maxLen) push();
      buf += (buf ? "\n" : "") + part;
    }
    push();
    return chunks;
  }

  /* ---------- 中文友好分词：汉字 bigram + 拉丁词 ---------- */
  function tokenize(text) {
    const s = String(text || "").toLowerCase();
    const out = [];
    const hanRuns = s.match(/[\u4e00-\u9fff]+/g) || [];
    for (const run of hanRuns) {
      if (run.length === 1) out.push(run);
      else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    }
    const latin = s.match(/[a-z][a-z0-9_+\-]{1,}/g) || [];
    for (const w of latin) out.push(w);
    const nums = s.match(/\d+(?:\.\d+)?/g) || [];
    for (const w of nums) out.push("n" + w);
    return out;
  }

  function buildIndex(docs) {
    const df = new Map();
    const entries = [];
    for (const doc of docs) {
      for (const chunk of doc.chunks || []) {
        const tf = new Map();
        for (const t of tokenize(chunk.text)) tf.set(t, (tf.get(t) || 0) + 1);
        for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
        entries.push({ docId: doc.id, docTitle: doc.title, page: chunk.page, text: chunk.text, tf, len: Math.max(1, chunk.text.length) });
      }
    }
    const N = Math.max(1, entries.length);
    for (const e of entries) {
      let norm = 0;
      for (const [t, n] of e.tf) {
        const idf = Math.log(1 + N / (1 + (df.get(t) || 0)));
        const w = (n / e.len) * idf;
        e.tf.set(t, w);
        norm += w * w;
      }
      e.norm = Math.sqrt(norm) || 1;
    }
    return { entries, df, N };
  }

  function search(index, query, limit) {
    const q = tokenize(query);
    const uniq = Array.from(new Set(q));
    const scored = [];
    for (const e of index.entries) {
      let score = 0;
      let hit = 0;
      for (const t of uniq) {
        const w = e.tf.get(t);
        if (w) { score += w; hit++; }
      }
      if (score > 0) scored.push({ ...e, score: score / e.norm, hit });
    }
    scored.sort((a, b) => b.score - a.score || b.hit - a.hit);
    return scored.slice(0, limit || 8);
  }

  /* ---------- PDF 提取（pdf.js 懒加载） ---------- */
  async function extractPdf(file, onProgress) {
    const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs";
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    const total = Math.min(doc.numPages, 500);
    const pages = [];
    for (let i = 1; i <= total; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        text += item.str || "";
        if (item.hasEOL) text += "\n";
      }
      pages.push({ no: i, text: text.trim() });
      if (onProgress && (i % 5 === 0 || i === total)) onProgress(i, total);
    }
    return { pages, pageCount: doc.numPages, truncated: doc.numPages > 500 };
  }

  async function extractText(file) {
    const text = await file.text();
    const pages = text.split(/\f/).map((t, i) => ({ no: i + 1, text: t.trim() }));
    return { pages: pages.filter((p) => p.text), pageCount: pages.length, truncated: false };
  }

  /* ---------- 备份导出 ---------- */
  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function buildBackup(kind) {
    const docs = await allDocs();
    const archive = await allArchive();
    const payload = {
      format: "sciencemind-backup",
      formatVersion: 1,
      kind: kind,
      createdAt: new Date().toISOString(),
      docs: docs.map((d) => ({
        id: d.id, title: d.title, kind: d.kind, size: d.size, pageCount: d.pageCount,
        createdAt: d.createdAt,
        chunks: kind === "full" ? d.chunks : d.chunks.map((c) => ({ page: c.page, text: c.text.slice(0, 220) })),
        hasOriginal: kind === "full" ? !!d.original : false,
        original: kind === "full" && d.original ? d.original : undefined,
      })),
      archive: archive.map((a) => Object.assign({}, a, { markdown: a.markdown || "" })),
    };
    payload.manifest = { count: docs.length + archive.length, note: kind === "lite" ? "文本 100% / 原件 0%" : "文本与原件 100%" };
    const json = JSON.stringify(payload);
    payload.checksum = await sha256(json);
    return payload;
  }

  window.Store = {
    openDB, putDoc, getDoc, allDocs, deleteDoc,
    putArchive, getArchive, allArchive, deleteArchive, clearArchive,
    loadPrefs, savePrefs, chunkText, tokenize, buildIndex, search,
    extractPdf, extractText, buildBackup,
  };
})();
