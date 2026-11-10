/* ScienceMind — 本地计算核验层
   把浏览器内的符号/数值计算引擎接进判题链路，填的是 v11.0 里
   independentToolPasses / independentToolChecks 这两个原本写死为 0 的字段。

   两个库都放在 assets/vendor/，按需懒加载，首屏零成本、全程离线：
   - nerdamer.core：符号展开，用来严格证明恒等式（差值展开为 0）
   - math.js：数值求值、求导、单位与量纲

   三条规矩：
   1. 无法解析一律 SKIP，绝不当成通过；
   2. 数值抽样一致只标 NUMERIC，不冒充符号证明；
   3. 工具发现矛盾按失败关闭，阻止 verified。 */

(function () {
  const LIBS = {
    nerdamer: { src: "assets/vendor/nerdamer.core.min.js", ok: () => !!window.nerdamer },
    math: { src: "assets/vendor/math.js", ok: () => !!window.math },
  };
  const pending = {};

  function load(name) {
    const lib = LIBS[name];
    if (lib.ok()) return Promise.resolve(true);
    if (pending[name]) return pending[name];
    pending[name] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = lib.src;
      s.onload = () => lib.ok() ? resolve(true) : reject(new Error(name + " 已加载但没有暴露接口"));
      s.onerror = () => reject(new Error("本地计算引擎未能载入：" + lib.src));
      document.head.appendChild(s);
    });
    return pending[name];
  }

  function ready() {
    return Promise.all([load("nerdamer"), load("math")]).then(() => true);
  }

  /* 把常见数学书写转成两个库都能吃的 ASCII 表达式 */
  function normalize(s) {
    return String(s == null ? "" : s)
      .replace(/[−–—]/g, "-")
      .replace(/[×·∙]/g, "*")
      .replace(/÷/g, "/")
      .replace(/²/g, "^2").replace(/³/g, "^3")
      .replace(/π/g, "pi")
      .replace(/√\s*\(/g, "sqrt(")
      .replace(/（/g, "(").replace(/）/g, ")")
      .replace(/，/g, ",")
      .replace(/\s+/g, "")
      .trim();
  }

  const KNOWN_FN = /^(sqrt|abs|sin|cos|tan|asin|acos|atan|log|ln|exp|floor|ceil|round|max|min|sign|pi|unit)$/i;

  /* 只接受纯表达式。nerdamer 会把 f(x) 悄悄当成 f*x，那会造出假证据。 */
  function isPure(s) {
    if (!s || !/^[0-9a-zA-Z_+\-*/^().,\s\[\]{}<>=!:]+$/.test(s)) return false;
    const calls = s.match(/[A-Za-z_][A-Za-z0-9_]*\s*\(/g) || [];
    return calls.every((c) => KNOWN_FN.test(c.replace(/\s*\($/, "")));
  }

  function isZero(txt) {
    const t = String(txt || "").replace(/\s/g, "");
    if (t === "0" || t === "-0" || t === "0.0") return true;
    return /^-?0(\.0+)?$/.test(t);
  }

  const SAMPLE_POINTS = [-3, -1.5, -0.5, 0, 0.5, 1.5, 3, 4.25];

  function detectVars(lhs, rhs) {
    const text = (lhs + " " + rhs).replace(/[A-Za-z_][A-Za-z0-9_]*\s*\(/g, "");
    const found = new Set();
    (text.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).forEach((w) => {
      if (KNOWN_FN.test(w) || /^(pi|e|E|true|false)$/.test(w)) return;
      if (/^(m|s|kg|N|J|W|V|A|K|mol|cd|ohm|g|cm|km|ms|min|h|Hz|Pa|eV)$/.test(w)) return;
      found.add(w);
    });
    return Array.from(found).slice(0, 3);
  }

  function numericCompare(lhs, rhs, vars) {
    const m = window.math;
    let fl, fr;
    try {
      fl = m.compile(lhs).evaluate;
      fr = m.compile(rhs).evaluate;
    } catch (e) {
      return { status: "SKIP", detail: "表达式无法编译，程序不判定：" + e.message };
    }
    const sets = vars.length
      ? SAMPLE_POINTS.map((v, i) => {
        const scope = {};
        vars.forEach((name, k) => { scope[name] = v * (k === 0 ? 1 : (k === 1 ? 0.73 : 1.31)) + (i % 3 ? 0.17 : 0); });
        return scope;
      })
      : [{}];
    let tested = 0;
    for (const scope of sets) {
      let a, b;
      try { a = fl(scope); b = fr(scope); } catch (_) { return { status: "SKIP", detail: "代入求值时出错，程序不判定" }; }
      if (typeof a !== "number" || typeof b !== "number" || !isFinite(a) || !isFinite(b)) continue;
      tested++;
      const tol = 1e-7 * (1 + Math.abs(a) + Math.abs(b));
      if (Math.abs(a - b) > tol) {
        const where = vars.map((k) => `${k}=${Number(scope[k].toFixed(3))}`).join(", ") || "常数";
        return { status: "FAIL", detail: `代入 ${where}：左边 ${trimNum(a)}，右边 ${trimNum(b)}，不相等。` };
      }
    }
    if (!tested) return { status: "SKIP", detail: "所有抽样点都无有效数值，程序不判定" };
    return { status: "NUMERIC", detail: `${tested} 个数值抽样点一致；这是数值佐证，不是符号证明。` };
  }

  function trimNum(v) {
    return Number(v.toPrecision(8)).toString();
  }

  /* 量纲：只比基本单位组合，不验证数值 */
  function dimensionKey(expr) {
    const m = window.math;
    const v = m.evaluate(expr);
    if (!v || !v.toSI) return null;
    const si = v.toSI();
    return (si.units || [])
      .map((u) => `${u.unit.name}:${u.power}`)
      .sort().join("*") || "1";
  }

  function verifyOne(item) {
    const base = { stepId: item.stepId || "—", kind: item.kind || "identity", source: item.source || "structured" };
    if (item.kind === "unit") {
      const lhs = normalize(item.lhs), rhs = normalize(item.rhs);
      if (!isPure(lhs) || !isPure(rhs)) return Object.assign(base, { status: "SKIP", detail: "含非表达式字符，量纲不判定" });
      try {
        const a = dimensionKey(lhs), b = dimensionKey(rhs);
        if (!a || !b) return Object.assign(base, { status: "SKIP", detail: "无法解析出单位，量纲不判定" });
        return a === b
          ? Object.assign(base, { status: "PASS", method: "量纲", detail: `两侧量纲一致：${a}（只验量纲，不验数值）`, lhs, rhs })
          : Object.assign(base, { status: "FAIL", method: "量纲", detail: `量纲不一致：${a} ≠ ${b}`, lhs, rhs });
      } catch (e) {
        return Object.assign(base, { status: "SKIP", detail: "量纲解析失败：" + e.message });
      }
    }

    const lhs = normalize(item.lhs), rhs = normalize(item.rhs);
    if (!lhs || !rhs || !isPure(lhs) || !isPure(rhs)) {
      return Object.assign(base, { status: "SKIP", detail: "含中文、函数记号或非法字符，程序不判定（不计入通过数）", lhs, rhs });
    }
    base.lhs = lhs; base.rhs = rhs;

    /* 第一优先：符号展开严格证明 */
    let diffText = null;
    try {
      diffText = window.nerdamer(`(${lhs})-(${rhs})`).expand().toString();
    } catch (_) { /* 落到数值抽样 */ }

    if (diffText !== null && isZero(diffText)) {
      return Object.assign(base, { status: "PASS", method: "符号展开", detail: `差值展开为 0：(${lhs}) − (${rhs}) ≡ 0` });
    }
    if (diffText !== null && /^-?\d+(\.\d+)?$/.test(String(diffText).replace(/\s/g, ""))) {
      return Object.assign(base, { status: "FAIL", method: "符号展开", detail: `差值为非零常数 ${diffText}，两式不恒等。` });
    }

    const vars = Array.isArray(item.vars) && item.vars.length
      ? item.vars.filter((v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v))
      : detectVars(lhs, rhs);
    const cmp = numericCompare(lhs, rhs, vars);
    return Object.assign(base, { method: cmp.status === "NUMERIC" ? "数值抽样" : "数值代入", status: cmp.status, detail: cmp.detail });
  }

  /* 只核验模型显式写出的 toolChecks。
     绝不从自然语言里猜等式：中文步骤里的 "x=2"、"令 2x−4=0" 是赋值或方程，
     拿去当恒等式展开会造出假矛盾，那比不核验更坏。 */
  async function verify(candidate, spec) {
    await ready();
    const items = (candidate.toolChecks || []).slice(0, 8).map((t, i) =>
      Object.assign({}, t, { stepId: t.stepId || "T" + (i + 1), source: "模型声明" }));
    const rows = items.map(verifyOne);
    const passes = rows.filter((r) => r.status === "PASS").length;
    const checks = rows.filter((r) => r.status === "PASS" || r.status === "NUMERIC" || r.status === "FAIL").length;
    const contradictions = rows.filter((r) => r.status === "FAIL");
    return {
      rows, passes, checks, contradictions,
      skipped: rows.filter((r) => r.status === "SKIP").length,
      numeric: rows.filter((r) => r.status === "NUMERIC").length,
      available: true,
    };
  }

  /* ---------------- 计算台 ---------------- */

  function numericRoots(text) {
    const m = window.math;
    const parts = text.split("=");
    const body = parts.length === 2 ? `(${parts[0]})-(${parts[1]})` : `(${text})`;
    let f;
    try { f = m.compile(normalize(body)).evaluate; } catch (e) { throw new Error("无法编译表达式：" + e.message); }
    const roots = [];
    const lo = -50, hi = 50, N = 1600;
    let prevX = lo, prevY = null;
    for (let i = 0; i <= N; i++) {
      const x = lo + (hi - lo) * i / N;
      let y;
      try { y = f({ x: x }); } catch (_) { y = NaN; }
      if (typeof y !== "number" || !isFinite(y)) { prevY = null; prevX = x; continue; }
      if (Math.abs(y) < 1e-9) roots.push(x);
      else if (prevY !== null && isFinite(prevY) && prevY * y < 0) {
        let a = prevX, b = x, fa = prevY;
        for (let k = 0; k < 60; k++) {
          const mid = (a + b) / 2;
          let fm; try { fm = f({ x: mid }); } catch (_) { break; }
          if (fa * fm <= 0) b = mid; else { a = mid; fa = fm; }
        }
        roots.push((a + b) / 2);
      }
      prevY = y; prevX = x;
    }
    const uniq = [];
    roots.sort((a, b) => a - b).forEach((r) => {
      if (!uniq.length || Math.abs(r - uniq[uniq.length - 1]) > 1e-4) uniq.push(r);
    });
    return uniq.slice(0, 12);
  }

  async function calc(expr, op, arg) {
    await ready();
    const m = window.math, n = window.nerdamer;
    const e = normalize(expr);
    if (!e) return { ok: false, text: "请输入表达式。" };
    if (!isPure(e) && !/->/.test(e)) return { ok: false, text: "含中文或未定义的函数记号，无法计算。" };

    try {
      switch (op) {
        case "simplify": {
          let out = n(`(${e})`).expand().toString();
          if (out.length > 400) out = out.slice(0, 400) + "…";
          return { ok: true, text: out, note: "符号展开（nerdamer）" };
        }
        case "derivative": {
          const v = String(arg || "x").replace(/[^A-Za-z_]/g, "") || "x";
          const out = m.simplify(m.derivative(e, v)).toString();
          return { ok: true, text: out, note: `对 ${v} 求导（math.js）` };
        }
        case "evaluate": {
          const v = m.evaluate(e);
          const text = v && v.toString ? v.toString() : String(v);
          let dim = "";
          try { const k = dimensionKey(e); if (k && k !== "1") dim = "量纲 " + k; } catch (_) {}
          return { ok: true, text, note: "数值 / 单位计算（math.js）" + (dim ? " · " + dim : "") };
        }
        case "solve": {
          const roots = numericRoots(e);
          return roots.length
            ? { ok: true, text: roots.map((r) => "x ≈ " + trimNum(r)).join("  ·  "), note: "数值求根（−50…50 扫描 + 二分），不是符号解" }
            : { ok: true, text: "在 −50…50 内没有找到实根。", note: "数值求根，区间外可能有根" };
        }
        case "dimension": {
          const parts = e.split("==");
          if (parts.length === 2) {
            const a = dimensionKey(parts[0]), b = dimensionKey(parts[1]);
            if (!a || !b) return { ok: false, text: "无法从两侧解析出单位。" };
            return { ok: true, text: a === b ? "量纲一致：" + a : `量纲不一致：${a} ≠ ${b}`, note: "只比量纲，不比数值" };
          }
          const k = dimensionKey(e);
          return k ? { ok: true, text: "量纲 " + k, note: "以 SI 基本单位表示" } : { ok: false, text: "表达式里没有单位。" };
        }
        case "convert": {
          const parts = String(expr).split("->");
          if (parts.length !== 2) return { ok: false, text: "格式：3 km -> m" };
          const v = m.unit(parts[0].trim());
          const out = v.to(parts[1].trim());
          return { ok: true, text: out.toString(), note: "单位换算（math.js）" };
        }
        default:
          return { ok: false, text: "未知的运算。" };
      }
    } catch (err) {
      return { ok: false, text: "计算失败：" + (err && err.message ? err.message : String(err)) };
    }
  }

  /* 常用物理公式：直接给带单位的完整算式，点一下就能算 */
  const TEMPLATES = [
    { group: "运动学", items: [
      { label: "匀加速末速度", op: "evaluate", expr: "3 m/s + 2 m/s^2 * 10 s", note: "v = v₀ + at" },
      { label: "匀加速位移", op: "evaluate", expr: "0.5 * 2 m/s^2 * (10 s)^2", note: "s = ½at²" },
      { label: "制动距离", op: "evaluate", expr: "(20 m/s)^2 / (2 * 5 m/s^2)", note: "v² / 2a" },
    ] },
    { group: "力学", items: [
      { label: "牛顿第二定律", op: "evaluate", expr: "2 kg * 3 m/s^2", note: "F = ma" },
      { label: "动能", op: "evaluate", expr: "0.5 * 2 kg * (3 m/s)^2", note: "Eₖ = ½mv²" },
      { label: "重力势能", op: "evaluate", expr: "2 kg * 9.8 m/s^2 * 5 m", note: "Eₚ = mgh" },
      { label: "弹簧弹力", op: "evaluate", expr: "20 N/m * 0.1 m", note: "F = kx" },
    ] },
    { group: "电磁 / 振动", items: [
      { label: "欧姆定律", op: "evaluate", expr: "12 V / 4 ohm", note: "I = U/R" },
      { label: "电功率", op: "evaluate", expr: "12 V * 3 A", note: "P = UI" },
      { label: "单摆周期", op: "evaluate", expr: "2*pi*sqrt(1 m / (9.8 m/s^2))", note: "T = 2π√(L/g)" },
    ] },
    { group: "数学", items: [
      { label: "配方恒等式", expr: "(x-2)^2-1-(x^2-4*x+3)", op: "simplify", note: "展开差值，结果为 0 即恒等" },
      { label: "二次式求导", expr: "x^2-4*x+3", op: "derivative", note: "对 x 求导" },
      { label: "求方程的根", expr: "x^2-4*x+3", op: "solve", note: "数值求根" },
      { label: "量纲是否一致", expr: "2 kg * 3 m/s^2 == 6 N", op: "dimension", note: "只比量纲，不比数值" },
    ] },
  ];

  window.ToolCheck = { ready, verify, calc, normalize, isPure, TEMPLATES };
})();
