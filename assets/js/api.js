/* ScienceMind — 请求层
   七家预设、URL 归一化、推理参数映射、400 整组去参重试、安全 fetch、错误翻译。
   与 v11.0 src/providers.ts / openai-compatible.ts / security.ts 同口径。 */

(function () {
  const SM = window.SM;

  function presetOf(id) {
    return SM.PRESETS.find((p) => p.id === id) || SM.PRESETS[SM.PRESETS.length - 1];
  }

  function normalizeBaseUrl(base) {
    let v = String(base || "").trim().replace(/\/+$/, "");
    v = v.replace(/\/chat\/completions$/, "");
    return v.replace(/\/+$/, "");
  }

  function detectProvider(baseUrl) {
    let host;
    try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return presetOf("custom"); }
    return SM.PRESETS.find((p) => p.hosts.length > 0 && p.hosts.some((h) => host === h || host.endsWith("." + h))) || presetOf("custom");
  }

  function buildProviderParams(preset, mode) {
    if (preset.thinkingStyle === "none" || mode === "off") return {};
    const plan = SM.MODE_PLAN[mode];
    switch (preset.thinkingStyle) {
      /* 这类厂商的 effort 只到 high，传 max 会 400。假装配额不会换来更长的思考。 */
      case "reasoning_effort": return { reasoning_effort: mode === "max" ? "high" : mode };
      case "thinking": return { thinking: { type: "enabled" } };
      case "enable_thinking": return { enable_thinking: true, thinking_budget: plan.thinkingBudget };
      case "thinking_budget": return { thinking_budget: plan.thinkingBudget };
      default: return {};
    }
  }

  /* 400 兜底：去掉推理参数，并把输出上限压回安全值。
     64k 常常直接超出模型上下文，那才是 400 最常见的原因，只删推理参数救不回来。 */
  function stripReasoningParams(body) {
    const next = Object.assign({}, body);
    SM.REASONING_KEYS.forEach((k) => delete next[k]);
    if (next.max_tokens > 16384) next.max_tokens = 16384;
    return next;
  }

  function looksLikeReasoningParameterError(status, message) {
    if (status !== 400) return false;
    return /(reasoning_effort|enable_thinking|thinking_budget|thinking|max_tokens|temperature|top_p)/i.test(message || "");
  }

  function assertSecureEndpoint(base) {
    let url;
    try { url = new URL(base); } catch { throw new Error("端点地址不合法：请填写完整的 https:// 地址。"); }
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      throw new Error("非 HTTPS 端点已拒绝：禁止把 API Key 发往明文端点（仅 localhost 放行）。");
    }
    return url;
  }

  function redact(text) {
    return String(text || "")
      .replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-••••••••")
      .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer ••••••••")
      .replace(/("?(?:api_?key|authorization|token|password|secret)"?\s*[:=]\s*")[^"]+(")/gi, "$1••••••••$2");
  }

  function translateError(status, raw) {
    const text = redact(raw || "");
    const hit = SM.ERRORS.find((e) => e.test.test(String(status) + " " + text));
    if (hit) return hit.msg;
    if (/cors/i.test(text)) return "CORS 拒绝：该服务商不允许浏览器直连。请改用允许跨域的兼容端点。";
    if (status === 0) return "请求未能发出：常见原因是浏览器拦截、离线或端点不允许 CORS。";
    return "请求失败（HTTP " + status + "）：" + text.slice(0, 220);
  }

  async function readError(res) {
    let body = "";
    try { body = await res.text(); } catch (_) {}
    let message = body;
    try {
      const j = JSON.parse(body);
      message = (j.error && (j.error.message || j.error)) || j.message || body;
      if (typeof message !== "string") message = JSON.stringify(message);
    } catch (_) {}
    return message;
  }

  const SECURE_OPTS = {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
  };

  /**
   * 一次 chat/completions 调用。
   * slot: { presetId, baseUrl, model, apiKey, family }
   */
  async function callModel(slot, messages, opts) {
    opts = opts || {};
    const preset = presetOf(slot.presetId);
    const base = normalizeBaseUrl(slot.baseUrl || preset.baseUrl);
    if (!base) throw new Error("缺少端点地址。");
    if (!slot.model) throw new Error("缺少模型名。");
    if (!slot.apiKey) throw new Error("缺少 API Key。");
    assertSecureEndpoint(base);

    const mode = opts.mode || "low";
    const plan = SM.MODE_PLAN[mode] || SM.MODE_PLAN.low;
    const maxTokens = opts.maxTokens || plan.maxTokens;

    const body = {
      model: slot.model,
      messages: messages,
      stream: false,
      max_tokens: maxTokens,
    };
    if (preset.supportsTemperature) body.temperature = opts.temperature === undefined ? plan.temperature : opts.temperature;
    Object.assign(body, buildProviderParams(preset, mode));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), opts.timeout || 180000);
    const outer = opts.signal;
    const onAbort = () => controller.abort(new Error("aborted"));
    if (outer) {
      if (outer.aborted) controller.abort(new Error("aborted"));
      else outer.addEventListener("abort", onAbort, { once: true });
    }

    async function send(payload) {
      const res = await fetch(base + "/chat/completions", Object.assign({}, SECURE_OPTS, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + slot.apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }));
      return res;
    }

    let res;
    let retried = false;
    let sentBody = body;
    try {
      res = await send(body);
      if (!res.ok && res.status === 400) {
        const raw = await readError(res);
        if (looksLikeReasoningParameterError(400, raw)) {
          retried = true;
          sentBody = stripReasoningParams(body);
          res = await send(sentBody);
          /* 还不行就只可能是输出上限超出了该模型的硬限制（不少模型只给 8k）。 */
          if (!res.ok && res.status === 400) {
            sentBody = Object.assign({}, sentBody, { max_tokens: 8192 });
            res = await send(sentBody);
          }
        } else {
          throw new Error(translateError(400, raw));
        }
      }
      if (!res.ok) {
        const raw = await readError(res);
        throw new Error(translateError(res.status, raw));
      }
      let data;
      try { data = await res.json(); } catch (_) { throw new Error("响应不是合法 JSON：请检查端点是否为 OpenAI 兼容接口。"); }
      const choice = data.choices && data.choices[0];
      let content = choice && choice.message && choice.message.content;
      if (Array.isArray(content)) content = content.map((part) => (typeof part === "string" ? part : part.text || "")).join("");
      if (!content || !String(content).trim()) throw new Error("模型返回了空内容：检查模型名、额度或适配器。");
      return {
        content: String(content),
        usage: data.usage || null,
        retried: retried,
        sentBody: sentBody,
      };
    } catch (err) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason && reason.message === "timeout") throw new Error("请求超时：模型在限定时间内没有返回。可降低推理档或减少候选数。");
        throw new Error("__ABORTED__");
      }
      if (err instanceof TypeError && /fetch/i.test(err.message)) {
        throw new Error("网络或 CORS 错误：服务商可能不允许浏览器跨域直连。请确认该服务商支持 CORS，或改用允许直连的兼容端点。");
      }
      throw new Error(redact(err.message || String(err)));
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onAbort);
    }
  }

  /**
   * 流式对话（答疑台用）。SSE 逐段回传正文与 reasoning_content。
   * opts: { mode, maxTokens, temperature, signal, onDelta, onReasoning, onMeta }
   * 400 且疑似推理参数不兼容时，整组去参重试一次。
   */
  async function streamChat(slot, messages, opts) {
    opts = opts || {};
    const preset = presetOf(slot.presetId);
    const base = normalizeBaseUrl(slot.baseUrl || preset.baseUrl);
    if (!base) throw new Error("缺少端点地址。");
    if (!slot.model) throw new Error("缺少模型名。");
    if (!slot.apiKey) throw new Error("缺少 API Key。");
    assertSecureEndpoint(base);

    const mode = opts.mode || "high";
    const plan = SM.MODE_PLAN[mode] || SM.MODE_PLAN.high;
    const signal = opts.signal;

    function buildBody(withParams, capped, hardCap) {
      const want = opts.maxTokens || plan.maxTokens;
      const body = {
        model: slot.model,
        messages: messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: hardCap ? Math.min(want, hardCap) : capped ? Math.min(want, 16384) : want,
      };
      if (preset.supportsTemperature) {
        body.temperature = opts.temperature === undefined ? plan.temperature : opts.temperature;
      }
      if (withParams) Object.assign(body, buildProviderParams(preset, mode));
      return body;
    }

    async function post(body) {
      return fetch(base + "/chat/completions", Object.assign({}, SECURE_OPTS, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + slot.apiKey,
        },
        body: JSON.stringify(body),
        signal: signal,
      }));
    }

    let res;
    try {
      res = await post(buildBody(true));
      if (!res.ok && res.status === 400) {
        const raw = await readError(res);
        if (looksLikeReasoningParameterError(400, raw)) {
          res = await post(buildBody(false, true));
          if (!res.ok && res.status === 400) res = await post(buildBody(false, true, 8192));
        } else {
          throw new Error(translateError(400, raw));
        }
      }
      if (!res.ok) throw new Error(translateError(res.status, await readError(res)));
    } catch (err) {
      if (signal && signal.aborted) throw new Error("__ABORTED__");
      if (err instanceof TypeError && /fetch/i.test(err.message)) {
        throw new Error("网络或 CORS 错误：服务商可能不允许浏览器跨域直连。请确认该服务商支持 CORS，或改用允许直连的兼容端点。");
      }
      throw new Error(redact(err.message || String(err)));
    }

    function handlePayload(payload) {
      let json;
      try { json = JSON.parse(payload); } catch (_) { return false; }
      if (json.error && json.error.message) throw new Error(redact(json.error.message));
      if (opts.onMeta && (json.model || json.usage)) {
        opts.onMeta({
          model: json.model,
          usage: json.usage ? {
            prompt: json.usage.prompt_tokens || 0,
            completion: json.usage.completion_tokens || 0,
            total: json.usage.total_tokens || 0,
          } : null,
        });
      }
      const choice = json.choices && json.choices[0];
      if (!choice) return false;
      const delta = choice.delta || choice.message || {};
      const reasoning = delta.reasoning_content || delta.reasoning;
      if (reasoning && opts.onReasoning) opts.onReasoning(reasoning);
      if (delta.content && opts.onDelta) opts.onDelta(delta.content);
      return true;
    }

    // 流不可用（旧 Safari / 定制 WebView）：整段读回，兼容 SSE 文本与整包 JSON
    if (!res.body || typeof res.body.getReader !== "function") {
      const text = await res.text();
      const chunks = text.split(/\n\n/);
      let any = false;
      for (const frame of chunks) {
        for (const line of frame.split("\n")) {
          const l = line.trim();
          if (!l || l === "data: [DONE]") continue;
          if (l.startsWith("data:")) any = handlePayload(l.slice(5).trim()) || any;
        }
      }
      if (!any) handlePayload(text);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          const l = line.trim();
          if (!l.startsWith("data:")) continue;
          const payload = l.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          handlePayload(payload);
        }
      }
    }
  }

  /* 从模型输出中提取 JSON（容忍代码围栏与前后缀） */
  function extractJson(text) {
    let s = String(text || "").trim();
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    try { return JSON.parse(s); } catch (_) {}
    const start = s.indexOf("{");
    if (start < 0) throw new Error("未找到 JSON 对象");
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const slice = s.slice(start, i + 1);
          try { return JSON.parse(slice); } catch (e) { throw new Error("JSON 解析失败：" + e.message); }
        }
      }
    }
    throw new Error("JSON 不完整：括号未闭合");
  }

  async function testConnection(slot) {
    const r = await callModel(slot, [
      { role: "user", content: "只回复四个字：连接正常" },
    ], { mode: "off", maxTokens: 8, temperature: 0, timeout: 45000 });
    return r.content.trim().slice(0, 40);
  }

  function maskKey(key) {
    if (!key) return "—";
    const tail = key.slice(-4);
    return key.slice(0, 3) + "•".repeat(Math.max(4, Math.min(10, key.length - 7))) + tail;
  }

  async function fingerprint(key) {
    if (!key) return "—";
    try {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
      return Array.from(new Uint8Array(buf).slice(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (_) {
      let h = 0;
      for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
      return h.toString(16).padStart(8, "0").slice(0, 8);
    }
  }

  window.API = {
    presetOf, normalizeBaseUrl, detectProvider, buildProviderParams, stripReasoningParams,
    assertSecureEndpoint, redact, translateError, callModel, streamChat, extractJson, testConnection,
    maskKey, fingerprint, SECURE_OPTS,
  };
})();
