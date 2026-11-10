/* ScienceMind — 解题编排
   extractor → N 路 solver → 独立 verifier → 程序化验收 → adjudicator → evidence → 确定性渲染。
   与 v11.0 src/orchestrator.ts 的状态语义对齐；浏览器端做了有界简化。 */

(function () {
  const SM = window.SM;
  const API = window.API;

  const JSON_ONLY = SM.JSON_ONLY;
  const DATA_BOUNDARY = SM.DATA_BOUNDARY;
  const IMAGE_BOUNDARY = SM.IMAGE_BOUNDARY;
  const OUTPUT_REDLINES = SM.OUTPUT_REDLINES;

  function playbook(spec) {
    const list = SM.PLAYBOOKS[spec.subject] || SM.PLAYBOOKS.math;
    return "【分科检查项】\n" + list.map((x) => "- " + x).join("\n");
  }

  function renderDiagramBlock(diagram) {
    if (!diagram) return "";
    return "\n<已核对的图像材料 数据块>\n" + diagram.ocrText +
      "\n补充模板：" + (diagram.template || "（无）") +
      "\n边界说明：" + (diagram.boundsNote || "（无）") +
      "\n人工核对状态（程序注入，不可由模型改写）：" + (diagram.userVerified ? "已核对" : "未核对") +
      "\n</已核对的图像材料 数据块>\n仅依据上述材料推理；若仍有缺失或不确定信息请指出，不要臆造。";
  }

  function renderRagBlock(chunks) {
    if (!chunks || !chunks.length) return "";
    const body = chunks.map((c, i) =>
      `[资料 ${i + 1}] 来源：《${c.docTitle}》第 ${c.page} 页\n${c.text}`
    ).join("\n\n");
    return `\n<检索资料 数据块>\n${body}\n</检索资料 数据块>\n`;
  }

  function extractorMessages(input) {
    const system = `EXTRACTOR_V1

你是竞赛题目契约提取器，只审题，不解题。${DATA_BOUNDARY}

${IMAGE_BOUNDARY}

逐小问提取目标，不得漏掉“证明/求出/判断并说明理由/保留几位有效数字”等要求。原题永远是最高依据；不确定的图片或符号必须写入 ambiguities / imageUncertainties / missingInformation，不得猜成确定事实。物理量的单位必须放入 unit；无单位量写“1”。没有额外信息时对应数组输出空数组。

图片的「人工核对状态」由程序注入，不由你判定；你无权声明某图已核对，只需把图中未提供、存疑或无法辨认的信息逐条写进 imageUncertainties。

${JSON_ONLY}

输出结构：
{
  "subject": "math | physics",
  "domain": "如：数论、组合、几何、力学、电磁学；尽量具体",
  "taskType": "prove | find_all | calculate | derive | experiment | mixed | other",
  "objectives": [{"id":"obj_1","statement":"第一小问的完整目标","kind":"prove | find_all | calculate | derive | other"}],
  "givens": ["所有显式条件"],
  "symbols": [{"symbol":"符号","meaning":"含义","unit":"单位或1","domain":"取值范围"}],
  "assumptions": ["题目明确或标准竞赛语境必需的假设；不确定者不要强加"],
  "ambiguities": ["题意、OCR、图形或符号歧义"],
  "diagramNotes": ["只转述图中确实可见的信息，不得推断数值"],
  "imageUncertainties": ["图中未提供 / 存疑 / 无法辨认的信息；无图片则空数组"],
  "missingInformation": ["缺失且影响求解的信息"],
  "deliverables": ["最终必须交付的形式、单位、精度或证明要求"]
}`;
    const user = `竞赛：${input.contest || "未指定"}\n输出语言：简体中文\n<原始题目 数据块>\n${input.question}\n</原始题目 数据块>${renderDiagramBlock(input.diagram)}`;
    return [{ role: "system", content: system }, { role: "user", content: user }];
  }

  function solverMessages(input, spec, index, ragChunks) {
    const directives = [
      "选择最稳健、最便于完整核验的方法，优先严谨性而不是炫技。",
      "独立重做；若存在自然且严谨的不同方法，优先采用不同方法。不要为不同而使用不可靠技巧。",
      "从反向构造、不变量、极端情形、解析化或计算观察等角度独立切入，再把观察提升为严格论证。",
    ];
    const system = `SOLVER_V1

你是奥赛命题级解题者。请独立、完整地解答下面的问题，从你自己的思路出发认真推导，不必参考任何他人解法，也不要省略关键步骤。给出可公开书写、逐步可审计的完整解答，不输出隐秘思维过程。${DATA_BOUNDARY}

${IMAGE_BOUNDARY}

原题与审题契约冲突时以原题为准，并在 uncertainties 指出；不得为得到答案而补造条件。每个 objective 都必须有对应 finalAnswers 项。

${OUTPUT_REDLINES}

${ragChunks && ragChunks.length ? SM.RAG_ADDON : ""}

${playbook(spec)}

策略指令：${directives[index] || directives[0]}

步骤要求：每个 steps 项只承担一个可核验论断；justification 必须给出定理、公式、推导或构造验证；dependsOn 填写本解答内的前置步骤 id，不得循环依赖。关键步骤不能写“显然”。checks 中只能把实际做过的检查标为 pass，未做必须标 not_performed。最终证明题的 value 写结论及证明完成说明，计算题写带单位的结果。不得输出 0～1 的置信分数。

本地计算核验：本站会用浏览器内的符号/数值引擎独立重算你写下的等式。请在 toolChecks 里把关键恒等式写成可计算的形式，最多 6 条：
- identity 用于恒等式：{"stepId":"s1","kind":"identity","lhs":"(x-2)^2-1","rhs":"x^2-4*x+3","vars":["x"]}
- unit 用于物理量纲：{"stepId":"s2","kind":"unit","lhs":"2 m/s^2 * 3 s","rhs":"5 m/s"}
- 只写你确有把握的等式；lhs/rhs 必须是纯 ASCII 数学表达式（^ 表示幂、* 不能省略、sqrt() 开方），不要写中文、不要写 f(x) 这类函数记号、不要写区间或文字。
- 没有可计算核验的等式就写空数组 []。引擎会展开 lhs-rhs；不为 0 就是矛盾，会按失败关闭处理，不会放行。无法解析的条目会被标为 SKIP，不计入通过数。

${JSON_ONLY}

输出结构：
{
  "understanding":"简短题意确认",
  "approach":"本解法及为何适用",
  "assumptions":["新增假设；没有则空数组"],
  "steps":[{"id":"s1","claim":"论断或推导结果","justification":"完整依据和必要计算","dependsOn":[]}],
  "finalAnswers":[{"objectiveId":"obj_1","value":"结论、数值、公式或证明完成声明"}],
  "checks":[{"type":"如dimensions/limit/domain/counterexample/construction","target":"检查对象","status":"pass | fail | not_performed | not_applicable","detail":"实际检查过程"}],
  "toolChecks":[{"stepId":"s1","kind":"identity","lhs":"","rhs":"","vars":["x"]}],
  "uncertainties":["仍未解决的问题；没有则空数组"]
}`;
    const user = `<原始题目>\n${input.question}\n</原始题目>\n<审题契约>\n${JSON.stringify(spec)}\n</审题契约>${renderDiagramBlock(input.diagram)}${renderRagBlock(ragChunks)}`;
    return [{ role: "system", content: system }, { role: "user", content: user }];
  }

  function verifierMessages(input, spec, candidate) {
    const system = `VERIFIER_V1

你是独立、严苛的竞赛审核员，不是候选解答的合作者，也不要因为文字流畅而放行。${DATA_BOUNDARY}

${IMAGE_BOUNDARY}

先自行重算/重证关键环节，再逐 objective、逐 step 检查。主动寻找反例、遗漏情形、循环论证和非法变形；不得把候选自己的 checks 当作已验证事实。

证明题额外检查：量词、两个方向、存在性、唯一性、构造合法性、解的完备性、归纳基例和递降终止性。
物理题额外检查：系统/参考系、符号方向、守恒律条件、约束与独立方程、单位量纲、边界/极限、近似范围和最终数值。

v11 新增三项审核维度：① 是否有跳步导致结论不成立、符号或常数抄错；② 结论范围是否被错误扩大或缩小（如把存在性结论写成全称、漏掉边界情形）；③ 是否存在明显更快或更稳妥的解法值得指出。命中「显然 / 易证 / 保证正确」等措辞时，把它当作需重点复核的跳步信号，而不是放行理由。

工具结果只是证据：数值通过不能证明全称命题；工具 fail 必须认真处理。无法判断就输出 unable，不能猜。不输出置信分数。

verdict 规则：pass 仅用于所有目标和步骤完整核验且无 major/fatal 问题；needs_repair 用于局部可修问题；reject 用于核心路线失效；unable 用于信息不足或无法审核。

${JSON_ONLY}

输出结构：
{
  "verdict":"pass | needs_repair | reject | unable",
  "objectiveChecks":[{"objectiveId":"obj_1","checked":true,"satisfied":true,"evidence":"独立核验证据"}],
  "stepChecks":[{"stepId":"s1","status":"valid | invalid | unverified","issue":"无问题则写空字符串"}],
  "issues":[{"severity":"minor | major | fatal","location":"步骤或目标","description":"问题","counterexample":"可选反例","repairHint":"可选局部修复提示"}],
  "checks":[{"type":"dimensions/limit/counterexample等","performed":true,"result":"pass | fail | unknown | not_applicable","evidence":"证据；未执行则 performed=false"}],
  "summary":"审核摘要，不输出置信分数"
}`;
    const user = `<原始题目>\n${input.question}\n</原始题目>\n<审题契约>\n${JSON.stringify(spec)}\n</审题契约>\n<候选解答>\n${JSON.stringify(candidate)}\n</候选解答>\n<确定性工具结果>\n[]\n</确定性工具结果>`;
    return [{ role: "system", content: system }, { role: "user", content: user }];
  }

  function repairMessages(input, spec, candidate, report) {
    const system = `REPAIR_V1

你是原解答者，现在只做局部修复。${DATA_BOUNDARY}

只修改审核意见指出的问题；不得改变未被指出且正确的部分，不得补造条件。修复后重新输出完整的 Candidate JSON（同一结构），并在 uncertainties 中标注仍无法解决的问题。不要解释修复过程。

${JSON_ONLY}`;
    const user = `<原始题目>\n${input.question}\n</原始题目>\n<审题契约>\n${JSON.stringify(spec)}\n</审题契约>\n<原候选>\n${JSON.stringify(candidate)}\n</原候选>\n<审核意见>\n${JSON.stringify(report)}\n</审核意见>`;
    return [{ role: "system", content: system }, { role: "user", content: user }];
  }

  function adjudicatorMessages(input, spec, accepted) {
    const system = `ADJUDICATOR_V1

你是独立、严谨的第三方仲裁者，不同于生成这些解答的模型。${DATA_BOUNDARY}

逐份核对推导与最终结果，识别共性结论与分歧点；基于数学/物理正确性独立判断，选出（或综合出）最可靠的答案，不要盲从多数，也不因两份一致就免于核对。

逐 objective 规范化比较答案：代数等价、单位换算、解集和证明结论都要比较。数值相同不代表证明有效；证明路线不同不必然是冲突。只有答案兼容且各候选均已通过核验时才可 agree；若存在分歧，明确指出哪一份正确、其余错在哪里。若输出不可比较则 incomparable，若实质不兼容则 conflict。selectedCandidate 必须来自输入的 candidateIndex；agree 时选表达最清晰完整者，其他情况为 null。residualIssues 中列出仍未消除的问题。最终判断以正确性为准，不以票数为准。

${JSON_ONLY}

输出结构：{"relationship":"agree | conflict | incomparable","selectedCandidate":0,"rationale":"逐目标比较依据","residualIssues":[]}`;
    const payload = accepted.map((a, i) => ({ candidateIndex: i, candidate: a.candidate, verification: a.report }));
    const user = `<原始题目>\n${input.question}\n</原始题目>\n<审题契约>\n${JSON.stringify(spec)}\n</审题契约>\n<已通过独立核验的候选>\n${JSON.stringify(payload)}\n</已通过独立核验的候选>`;
    return [{ role: "system", content: system }, { role: "user", content: user }];
  }

  /* ---------------- 红线 ---------------- */

  function scanText(text, field, location, all) {
    const hits = [];
    if (!text) return hits;
    for (const pattern of SM.REDLINES) {
      const re = all ? new RegExp(pattern.re.source, "g") : pattern.re;
      let m;
      let guard = 0;
      while ((m = re.exec(text))) {
        guard++;
        if (guard > 50) break;
        const before = text.slice(Math.max(0, m.index - SM.NEGATION_WINDOW), m.index);
        if (!SM.NEGATION_RE.test(before)) {
          const start = Math.max(0, m.index - 18);
          const end = Math.min(text.length, m.index + m[0].length + 18);
          hits.push({
            patternId: pattern.id,
            why: pattern.why,
            field,
            location,
            excerpt: (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : ""),
          });
        }
        if (!all) break;
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    return hits;
  }

  function scanRedlines(candidate) {
    const hits = [];
    hits.push(...scanText(candidate.understanding, "understanding", "题意确认", false));
    hits.push(...scanText(candidate.approach, "approach", "解题思路", false));
    for (const step of candidate.steps || []) {
      hits.push(...scanText(step.claim, "steps." + step.id + ".claim", step.id, false));
      hits.push(...scanText(step.justification, "steps." + step.id + ".justification", step.id, false));
    }
    return hits;
  }

  /* ---------------- 结构校验 ---------------- */

  function candidateStructureErrors(spec, candidate) {
    const errors = [];
    const ids = (candidate.steps || []).map((s) => s.id);
    const set = new Set(ids);
    if (set.size !== ids.length) errors.push("步骤 id 重复。");
    for (const step of candidate.steps || []) {
      for (const dep of step.dependsOn || []) {
        if (!set.has(dep)) errors.push(`${step.id} 依赖了不存在的步骤 ${dep}。`);
      }
    }
    const state = new Map();
    const byId = new Map((candidate.steps || []).map((s) => [s.id, s]));
    const visit = (id) => {
      if (state.get(id) === 1) { errors.push(`步骤依赖存在环，涉及 ${id}。`); return; }
      if (state.get(id) === 2) return;
      state.set(id, 1);
      for (const dep of (byId.get(id) || {}).dependsOn || []) if (byId.has(dep)) visit(dep);
      state.set(id, 2);
    };
    for (const id of set) visit(id);
    for (const obj of spec.objectives || []) {
      const count = (candidate.finalAnswers || []).filter((a) => a.objectiveId === obj.id).length;
      if (count !== 1) errors.push(`目标 ${obj.id} 必须恰好有一个最终答案，实际为 ${count}。`);
    }
    return errors;
  }

  function imageGateBlockers(spec, input) {
    const blockers = [];
    if ((spec.imageUncertainties || []).length > 0) {
      blockers.push(`题目含 ${spec.imageUncertainties.length} 处图中未提供 / 存疑信息，未解决前禁止输出 verified。`);
    }
    if (input.diagram !== undefined && input.diagram.userVerified !== true) {
      blockers.push("图片材料未经人工核对（userVerified !== true），禁止输出 verified。");
    }
    return blockers;
  }

  /* 软门槛：不把候选赶出 accepted，但会把最终状态压到 needs_review。
     图片未核对属于这一类——答案可以给你看，但不能标 verified。 */
  function softBlockers(spec, input) {
    return imageGateBlockers(spec, input);
  }

  function acceptanceBlockers(spec, candidate, report, redlineHits, input) {
    const blockers = candidateStructureErrors(spec, candidate);
    if (redlineHits.length) blockers.push(`候选命中 ${redlineHits.length} 条输出红线，降级为 needs_review。`);
    if (report.verdict !== "pass") blockers.push(`审核 verdict=${report.verdict}。`);
    if ((report.issues || []).some((i) => i.severity !== "minor")) blockers.push("审核仍含 major 或 fatal 问题。");
    if ((candidate.uncertainties || []).length) blockers.push("候选仍声明了未解决的不确定项。");
    if ((candidate.checks || []).some((c) => c.status === "fail")) blockers.push("候选自己的检查存在 fail。");
    if ((report.checks || []).some((c) => c.result === "fail")) blockers.push("独立审核检查存在 fail。");
    for (const obj of spec.objectives || []) {
      const matches = (report.objectiveChecks || []).filter((c) => c.objectiveId === obj.id);
      if (matches.length !== 1 || !matches[0].checked || !matches[0].satisfied) blockers.push(`目标 ${obj.id} 未被完整审核通过。`);
    }
    for (const step of candidate.steps || []) {
      const matches = (report.stepChecks || []).filter((c) => c.stepId === step.id);
      if (matches.length !== 1 || matches[0].status !== "valid") blockers.push(`步骤 ${step.id} 未被完整审核通过。`);
    }
    return blockers;
  }

  /* ---------------- 证据量 ---------------- */

  function computeEvidence(spec, candidate, report, flags) {
    const tool = flags.tool || { passes: 0, checks: 0 };
    const objectiveIds = new Set((spec.objectives || []).map((o) => o.id));
    const stepIds = new Set((candidate.steps || []).map((s) => s.id));
    const verifiedTargets = new Set((report.objectiveChecks || [])
      .filter((c) => objectiveIds.has(c.objectiveId) && c.checked && c.satisfied)
      .map((c) => c.objectiveId)).size;
    const verifiedSteps = new Set((report.stepChecks || [])
      .filter((c) => stepIds.has(c.stepId) && c.status === "valid")
      .map((c) => c.stepId)).size;
    const reasons = [];
    if (verifiedTargets < objectiveIds.size) reasons.push(`仅 ${verifiedTargets}/${objectiveIds.size} 个小问被独立核验通过（目标覆盖率不足）。`);
    if (verifiedSteps < stepIds.size) reasons.push(`仅 ${verifiedSteps}/${stepIds.size} 个步骤被独立判为 valid（步骤覆盖率不足）。`);
    if (!flags.independentVerifier) reasons.push("解题与审核使用同一模型客户端，独立性不足；同源模型不能作为自我复核的证据。");
    if (flags.crossModelAgree === null) reasons.push("未形成多候选交叉一致的证据（单候选或未完成仲裁）。");
    else if (flags.crossModelAgree === false) reasons.push("多候选仲裁不一致，不能给出确定结论。");
    const allCovered = verifiedTargets === objectiveIds.size && verifiedSteps === stepIds.size;
    const hasExternal = flags.crossModelAgree === true;
    let confidence = "low";
    if (allCovered && flags.independentVerifier && hasExternal) confidence = "high";
    else if (allCovered && flags.independentVerifier) confidence = "medium";
    const sufficient = allCovered && flags.independentVerifier && flags.crossModelAgree !== false;
    return {
      verifiedTargets, totalTargets: objectiveIds.size,
      verifiedSteps, totalSteps: stepIds.size,
      independentToolPasses: tool.passes, independentToolChecks: tool.checks,
      independentVerifier: !!flags.independentVerifier,
      independentAdjudicator: !!flags.independentAdjudicator,
      crossModelAgree: flags.crossModelAgree,
      sufficient, confidence, insufficientReasons: reasons,
    };
  }

  /* ---------------- 确定性渲染 ---------------- */

  function renderResultMarkdown(res) {
    const L = [];
    const st = res.status;
    L.push("# ScienceMind 判定结果", "");
    L.push(`> 状态：**${st}** · 证据级别：**${res.assurance}**`);
    L.push(`> 置信说明：${res.evidence.confidence}（程序化证据强度，不是概率）`, "");
    if (res.question) { L.push("## 题目", "", res.question, ""); }

    if (res.spec) {
      L.push("## 审题契约", "");
      L.push(`- 学科：${res.spec.subject === "physics" ? "物理" : "数学"} · ${res.spec.domain}`);
      L.push(`- 任务类型：${res.spec.taskType}`);
      (res.spec.objectives || []).forEach((o) => L.push(`- 目标 ${o.id}：${o.statement}`));
      if ((res.spec.assumptions || []).length) L.push(`- 假设：${res.spec.assumptions.join("；")}`);
      if ((res.spec.imageUncertainties || []).length) L.push(`- 图中存疑：${res.spec.imageUncertainties.join("；")}`);
      L.push("");
    }

    const c = res.selectedCandidate;
    if (c) {
      L.push("## 解法", "", "**思路**：" + c.approach, "");
      (c.steps || []).forEach((s, i) => {
        L.push(`${i + 1}. **${s.id}** ${s.claim}`);
        L.push(`   ${s.justification}`);
      });
      L.push("", "## 最终答案", "");
      (c.finalAnswers || []).forEach((a) => L.push(`- **${a.objectiveId}**：${a.value}`));
      L.push("");
    }

    L.push("## 证据量", "");
    L.push(`- 目标覆盖：${res.evidence.verifiedTargets}/${res.evidence.totalTargets}`);
    L.push(`- 步骤覆盖：${res.evidence.verifiedSteps}/${res.evidence.totalSteps}`);
    L.push(`- 独立审核：${res.evidence.independentVerifier ? "是" : "否"}`);
    L.push(`- 独立仲裁：${res.evidence.independentAdjudicator ? "是" : "否"}`);
    L.push(`- 交叉一致：${res.evidence.crossModelAgree === null ? "未形成" : (res.evidence.crossModelAgree ? "是" : "否")}`);
    L.push(`- 证据是否充足：${res.evidence.sufficient ? "是" : "否"}`);
    (res.evidence.insufficientReasons || []).forEach((r) => L.push(`  - ${r}`));
    L.push("");

    if (res.tool && (res.tool.rows || []).length) {
      L.push("## 本地计算核验", "");
      L.push(`- 引擎：${res.tool.available ? "已运行（浏览器内）" : "不可用"} · 通过 ${res.tool.passes}/${res.tool.checks} · 数值佐证 ${res.tool.numeric} · 无法判定 ${res.tool.skipped}`);
      res.tool.rows.forEach((r) => L.push(`  - [${r.status}] ${r.stepId}：${r.detail}`));
      L.push("");
      L.push("> 数值抽样一致只算佐证，不是符号证明；工具发现矛盾按失败关闭处理。", "");
    }

    if ((res.warnings || []).length) {
      L.push("## 降级与警告", "");
      res.warnings.forEach((w) => L.push(`- ${w}`));
      L.push("");
    }

    L.push("## 这里不会发生什么", "");
    SM.NON_EVENTS.forEach((n) => L.push(`- ${n}`));
    L.push("", "---", "ScienceMind v11.0 · 判定由程序化门槛执行，结论不承诺绝对正确。");
    return L.join("\n");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function mdToHtml(text) {
    const lines = String(text || "").split(/\r?\n/);
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) { out.push("<p>" + para.join("<br>") + "</p>"); para = []; }
    };
    const flushList = () => {
      if (list) { out.push(`<${list.tag}>` + list.items.map((i) => `<li>${i}</li>`).join("") + `</${list.tag}>`); list = null; }
    };
    for (const raw of lines) {
      const line = escapeHtml(raw);
      if (!line.trim()) { flushPara(); flushList(); continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushPara(); flushList();
        out.push(`<h${h[1].length}>${h[2]}</h${h[1].length}>`);
        continue;
      }
      if (/^---+$/.test(line.trim())) { flushPara(); flushList(); out.push("<hr>"); continue; }
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const tag = ul ? "ul" : "ol";
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((ul ? ul[1] : ol[1]));
        continue;
      }
      if (/^>\s?/.test(line.trim())) { flushPara(); flushList(); out.push("<blockquote>" + line.replace(/^>\s?/, "") + "</blockquote>"); continue; }
      para.push(line);
    }
    flushPara(); flushList();
    return out.join("")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  /* ---------------- 编排 ---------------- */

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error((label || "调用") + "超时")), ms)),
    ]);
  }

  async function runSolve(input, cfg, hooks) {
    hooks = hooks || {};
    const emit = hooks.onEvent || function () {};
    const t0 = performance.now();
    const warnings = [];
    const degrade = [];
    const started = Date.now();
    /* 拉满：求解之外的审核也跟着提档。审核草率，求解再用力也白搭。 */
    const heavy = cfg.mode === "max";

    const slots = cfg.slots;
    const solverSlot = slots.solver;
    if (!solverSlot || !solverSlot.apiKey || !solverSlot.model) throw new Error("未配置解题模型：请先在「模型与密钥」里填写 Key 与模型名，或运行本地演示。");

    /* 1. 审题 */
    emit({ id: "extract", state: "run", note: "调用 " + (solverSlot.model || "模型") });
    let spec;
    try {
      const r = await API.callModel(solverSlot, extractorMessages(input), { mode: "low", maxTokens: 6000 });
      spec = API.extractJson(r.content);
      if (!spec || !Array.isArray(spec.objectives) || !spec.objectives.length) throw new Error("契约缺少 objectives");
      spec.subject = spec.subject === "physics" ? "physics" : "math";
      spec.objectives = spec.objectives.map((o, i) => ({
        id: o.id || "obj_" + (i + 1),
        statement: o.statement || input.question,
        kind: o.kind || "other",
      }));
      emit({ id: "extract", state: "done", note: spec.objectives.length + " 个目标 · " + (spec.domain || "未分类") });
    } catch (err) {
      if (String(err.message).indexOf("__ABORTED__") >= 0) return { aborted: true, started };
      spec = {
        subject: "math", domain: "未分类（契约解析失败）", taskType: "other",
        objectives: [{ id: "obj_1", statement: input.question.slice(0, 240), kind: "other" }],
        givens: [], symbols: [], assumptions: [], ambiguities: [],
        diagramNotes: [], imageUncertainties: [], missingInformation: [], deliverables: [],
      };
      warnings.push("审题契约解析失败，已降级为「原始题面 + 单目标」；结论只能作为 needs_review。");
      degrade.push("解析失败不静默丢弃：使用原始题面继续，但状态不得为 verified。");
      emit({ id: "extract", state: "warn", note: "契约解析失败 · 降级" });
    }

    /* 程序注入图片状态，覆盖模型自报 */
    if (input.diagram) {
      spec.diagram = input.diagram;
      spec.imageUncertainties = input.uncertainties && input.uncertainties.length
        ? input.uncertainties.slice()
        : (Array.isArray(spec.imageUncertainties) ? spec.imageUncertainties : []);
    }

    /* 2. N 路求解 */
    const n = Math.max(1, Math.min(3, cfg.candidates || 1));
    emit({ id: "solve", state: "run", note: n + " 路独立求解" });
    const ragChunks = cfg.ragChunks || [];
    const candidateResults = await Promise.all(Array.from({ length: n }, async (_, i) => {
      try {
        const r = await API.callModel(solverSlot, solverMessages(input, spec, i, ragChunks), { mode: cfg.mode });
        const c = API.extractJson(r.content);
        if (!c || !Array.isArray(c.steps) || !Array.isArray(c.finalAnswers)) throw new Error("候选结构不完整");
        c.steps = c.steps.map((s, k) => ({
          id: s.id || "s" + (k + 1),
          claim: s.claim || "",
          justification: s.justification || "",
          dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
        }));
        c.finalAnswers = c.finalAnswers.map((a) => ({ objectiveId: a.objectiveId, value: a.value }));
        c.checks = Array.isArray(c.checks) ? c.checks : [];
        c.uncertainties = Array.isArray(c.uncertainties) ? c.uncertainties : [];
        return { ok: true, index: i, candidate: c, usage: r.usage, retried: r.retried, raw: r.content };
      } catch (err) {
        if (String(err.message).indexOf("__ABORTED__") >= 0) return { ok: false, index: i, aborted: true, error: err.message };
        return { ok: false, index: i, error: err.message, raw: err.raw || "" };
      }
    }));

    if (candidateResults.some((r) => r.aborted)) return { aborted: true, started };

    const parsed = candidateResults.filter((r) => r.ok);
    candidateResults.filter((r) => !r.ok).forEach((r) => {
      warnings.push(`候选 ${r.index + 1} 求解失败：${r.error}`);
      degrade.push("解析失败不静默丢弃：失败候选的结构化内容不可用。");
    });
    if (!parsed.length) {
      emit({ id: "solve", state: "fail", note: "0 个候选" });
      return {
        status: "unresolved", assurance: "unresolved", spec, candidates: [], selectedCandidate: null,
        evidence: computeEvidence(spec, { steps: [] }, { objectiveChecks: [], stepChecks: [] }, { independentVerifier: false, independentAdjudicator: false, crossModelAgree: null }),
        warnings, degradeReasons: degrade, markdown: "", started, usage: 0,
      };
    }
    emit({ id: "solve", state: "done", note: parsed.length + "/" + n + " 个候选可解析" });

    /* 3. 红线扫描（编排层） */
    parsed.forEach((p) => { p.redlines = scanRedlines(p.candidate); });
    const redlineCount = parsed.reduce((n2, p) => n2 + p.redlines.length, 0);
    emit({ id: "redline", state: redlineCount ? "warn" : "done", note: redlineCount ? redlineCount + " 处命中" : "0 处命中" });

    /* 3.5 本地计算核验：纯浏览器内符号/数值引擎，不调用任何模型 */
    emit({ id: "tools", state: "run", note: "载入本地引擎" });
    for (const p of parsed) {
      try {
        p.tool = window.ToolCheck
          ? await window.ToolCheck.verify(p.candidate, spec)
          : { available: false, rows: [], passes: 0, checks: 0, contradictions: [], skipped: 0, numeric: 0 };
      } catch (err) {
        p.tool = { available: false, rows: [], passes: 0, checks: 0, contradictions: [], skipped: 0, numeric: 0, error: String(err.message || err) };
        warnings.push(`本地计算引擎不可用，工具证据留空：${err.message || err}`);
      }
    }
    const toolPasses = parsed.reduce((n2, p) => n2 + (p.tool ? p.tool.passes : 0), 0);
    const toolChecks = parsed.reduce((n2, p) => n2 + (p.tool ? p.tool.checks : 0), 0);
    const toolContradictions = parsed.reduce((n2, p) => n2 + (p.tool ? p.tool.contradictions.length : 0), 0);
    emit({ id: "tools", state: toolContradictions ? "warn" : (toolChecks ? "done" : "skip"),
      note: toolChecks ? `${toolPasses}/${toolChecks} 通过${toolContradictions ? " · " + toolContradictions + " 处矛盾" : ""}` : "无可核验等式" });

    /* 4. 独立审核（红线命中的候选不送审，直接不进入 accepted） */
    const verifierSlot = slots.verifier && slots.verifier.enabled ? slots.verifier : solverSlot;
    const independentVerifier = slots.verifier && slots.verifier.enabled && slots.verifier.family !== solverSlot.family;
    if (slots.verifier && slots.verifier.enabled && !independentVerifier) {
      warnings.push("审核模型与解题模型同源：审核独立性有限，同源模型不能作为自我复核的证据。");
    }
    if (!slots.verifier || !slots.verifier.enabled) {
      warnings.push("未配置独立审核模型：审核复用解题模型，独立性有限。");
    }

    const toVerify = parsed.filter((p) => p.redlines.length === 0);
    emit({ id: "verify", state: "run", note: toVerify.length + " 份候选送审" });

    for (const p of toVerify) {
      try {
        const r = await API.callModel(
          verifierSlot,
          verifierMessages(input, spec, p.candidate),
          { mode: heavy ? "high" : "medium", maxTokens: heavy ? 24576 : 9000 }
        );
        let report = API.extractJson(r.content);
        report.objectiveChecks = Array.isArray(report.objectiveChecks) ? report.objectiveChecks : [];
        report.stepChecks = Array.isArray(report.stepChecks) ? report.stepChecks : [];
        report.issues = Array.isArray(report.issues) ? report.issues : [];
        report.checks = Array.isArray(report.checks) ? report.checks : [];
        p.report = report;
        p.repairAttempted = false;

        const needsRepair = report.verdict === "needs_repair" ||
          report.issues.some((i) => i.severity === "major") ||
          report.checks.some((c) => c.result === "fail") ||
          p.candidate.uncertainties.length > 0;

        if (needsRepair && cfg.repair !== false && report.verdict !== "reject" && report.verdict !== "unable") {
          p.repairAttempted = true;
          try {
            const rr = await API.callModel(solverSlot, repairMessages(input, spec, p.candidate, report), {
              mode: cfg.mode, maxTokens: heavy ? 32768 : undefined,
            });
            const fixed = API.extractJson(rr.content);
            if (fixed && Array.isArray(fixed.steps)) {
              fixed.steps = fixed.steps.map((s, k) => ({ id: s.id || "s" + (k + 1), claim: s.claim || "", justification: s.justification || "", dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [] }));
              fixed.finalAnswers = (fixed.finalAnswers || []).map((a) => ({ objectiveId: a.objectiveId, value: a.value }));
              fixed.checks = Array.isArray(fixed.checks) ? fixed.checks : [];
              fixed.uncertainties = Array.isArray(fixed.uncertainties) ? fixed.uncertainties : [];
              p.candidate = fixed;
              p.redlines = scanRedlines(fixed);
              const vr = await API.callModel(verifierSlot, verifierMessages(input, spec, fixed), {
                mode: heavy ? "high" : "medium", maxTokens: heavy ? 24576 : 9000,
              });
              const rep = API.extractJson(vr.content);
              rep.objectiveChecks = Array.isArray(rep.objectiveChecks) ? rep.objectiveChecks : [];
              rep.stepChecks = Array.isArray(rep.stepChecks) ? rep.stepChecks : [];
              rep.issues = Array.isArray(rep.issues) ? rep.issues : [];
              rep.checks = Array.isArray(rep.checks) ? rep.checks : [];
              p.report = rep;
            }
          } catch (e) {
            warnings.push(`候选 ${p.index + 1} 有界修复失败：${e.message}`);
          }
        }
      } catch (err) {
        if (String(err.message).indexOf("__ABORTED__") >= 0) return { aborted: true, started };
        p.report = null;
        p.verifyError = err.message;
        warnings.push(`候选 ${p.index + 1} 审核失败：${err.message}`);
        degrade.push("审核失败按失败关闭处理：该候选不进入 accepted。");
      }
    }
    emit({ id: "verify", state: "done", note: toVerify.filter((p) => p.report).length + " 份完成审核" });

    /* 5. 程序化验收 */
    const evaluated = parsed.map((p) => {
      if (!p.report) {
        return { ...p, blockers: ["未取得独立审核报告。"], softBlockers: [], evidence: null };
      }
      const blockers = acceptanceBlockers(spec, p.candidate, p.report, p.redlines, input);
      (p.tool && p.tool.contradictions || []).forEach((x) => {
        blockers.push(`本地计算核验发现矛盾 @${x.stepId}：${x.detail}`);
      });
      return { ...p, blockers, softBlockers: softBlockers(spec, input), evidence: null };
    });
    const accepted = evaluated.filter((p) => p.blockers.length === 0);
    emit({ id: "gates", state: accepted.length ? "done" : "warn", note: accepted.length + " 份通过验收" });

    /* 6. 仲裁 */
    const adjudicatorSlot = slots.adjudicator && slots.adjudicator.enabled ? slots.adjudicator : null;
    let adjudication = null;
    let crossModelAgree = null;
    let selected = accepted[0] || null;

    if (accepted.length >= 2) {
      if (adjudicatorSlot) {
        emit({ id: "adjudicate", state: "run", note: "第三方仲裁" });
        try {
          const r = await API.callModel(adjudicatorSlot, adjudicatorMessages(input, spec, accepted), {
            mode: heavy ? "medium" : "low", maxTokens: heavy ? 12000 : 6000,
          });
          adjudication = API.extractJson(r.content);
          adjudication.relationship = ["agree", "conflict", "incomparable"].includes(adjudication.relationship) ? adjudication.relationship : "incomparable";
          if (adjudication.relationship === "agree" && Number.isInteger(adjudication.selectedCandidate)) {
            const idx = adjudication.selectedCandidate;
            selected = accepted[idx] || accepted[0];
            crossModelAgree = true;
          } else {
            crossModelAgree = adjudication.relationship === "conflict" ? false : null;
            selected = null;
          }
          emit({ id: "adjudicate", state: adjudication.relationship === "agree" ? "done" : "warn", note: adjudication.relationship });
        } catch (err) {
          warnings.push("第三方仲裁失败：" + err.message);
          emit({ id: "adjudicate", state: "warn", note: "仲裁失败" });
          crossModelAgree = null;
          selected = null;
        }
      } else {
        warnings.push("未配置独立第三方仲裁模型：多候选未形成交叉一致证据。");
        emit({ id: "adjudicate", state: "skip", note: "未配置" });
        crossModelAgree = null;
        selected = null;
      }
    } else {
      emit({ id: "adjudicate", state: "skip", note: accepted.length ? "单候选" : "无候选通过" });
    }

    /* 7. 证据量 */
    let evidence;
    if (selected) {
      evidence = computeEvidence(spec, selected.candidate, selected.report, {
        independentVerifier,
        independentAdjudicator: !!(adjudicatorSlot && crossModelAgree === true),
        crossModelAgree,
        tool: selected.tool || { passes: 0, checks: 0 },
      });
      selected.evidence = evidence;
    } else {
      evidence = {
        verifiedTargets: 0, totalTargets: (spec.objectives || []).length,
        verifiedSteps: 0, totalSteps: 0,
        independentToolPasses: toolPasses, independentToolChecks: toolChecks,
        independentVerifier: !!independentVerifier,
        independentAdjudicator: !!(adjudicatorSlot && crossModelAgree === true),
        crossModelAgree,
        sufficient: false, confidence: "low",
        insufficientReasons: ["没有候选通过程序化验收。"],
      };
    }
    emit({ id: "evidence", state: evidence.sufficient ? "done" : "warn", note: evidence.confidence + " · " + (evidence.sufficient ? "证据充足" : "证据不足") });

    /* 8. 状态判定 */
    let status = "unresolved";
    let assurance = "unresolved";
    const hasImageGate = input.diagram && input.diagram.userVerified !== true;
    const hasUncertainty = (spec.imageUncertainties || []).length > 0;

    if (accepted.length === 0) {
      status = "needs_review";
      assurance = "review_required";
      if (parsed.length === 0) { status = "unresolved"; assurance = "unresolved"; }
    } else if (accepted.length >= 2 && !adjudication) {
      status = "needs_review"; assurance = "review_required";
    } else if (adjudication && adjudication.relationship !== "agree") {
      status = "needs_review"; assurance = adjudication.relationship === "conflict" ? "conflict" : "review_required";
    } else if (hasImageGate || hasUncertainty) {
      status = "needs_review"; assurance = "review_required";
    } else if (cfg.strictEvidence && !evidence.sufficient) {
      status = "needs_review"; assurance = "review_required";
    } else {
      status = "verified";
      assurance = accepted.length >= 2 ? "cross_checked" : "single_verified";
    }

    /* 9. 汇总警告与降级原因 */
    evaluated.forEach((p) => {
      p.redlines.forEach((h) => warnings.push(`红线命中 [${h.patternId}] @${h.location}（${h.field}）：${h.why} 片段「${h.excerpt}」`));
    });
    evaluated.forEach((p) => {
      if (p.blockers.length) degrade.push(`候选 ${p.index + 1} 未通过验收：${p.blockers.slice(0, 4).join(" ")}${p.blockers.length > 4 ? " …" : ""}`);
    });
    if (hasImageGate || hasUncertainty) degrade.push("图片材料未完成人工核对或存在存疑项，禁止输出 verified。");
    if (adjudication && adjudication.relationship !== "agree") degrade.push("多候选仲裁未达成一致：冲突不从多数票，直接进入人工复核。");
    if (selected && selected.candidate.uncertainties.length) degrade.push("候选仍声明未解决的不确定项。");

    /* 10. 渲染 */
    const result = {
      status, assurance, spec,
      question: input.question,
      tool: selected ? selected.tool : (evaluated.length === 1 ? evaluated[0].tool : null),
      candidates: evaluated,
      selectedCandidate: selected ? selected.candidate : null,
      selectedIndex: selected ? selected.index : null,
      verification: selected ? selected.report : null,
      adjudication,
      evidence,
      warnings: Array.from(new Set(warnings)),
      degradeReasons: Array.from(new Set(degrade)),
      images: input.imageDataUrl ? [input.imageDataUrl] : [],
      createdAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
      usage: candidateResults.reduce((sum, r) => sum + (r.usage && r.usage.total_tokens || 0), 0),
    };
    result.markdown = renderResultMarkdown(result);
    emit({ id: "render", state: "done", note: "确定性 Markdown" });
    return result;
  }

  window.Solver = {
    runSolve, scanRedlines, computeEvidence, acceptanceBlockers, softBlockers,
    renderResultMarkdown, mdToHtml, escapeHtml, candidateStructureErrors,
  };
})();
