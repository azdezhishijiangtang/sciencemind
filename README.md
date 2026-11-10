# ScienceMind

**把解题关进程序化的笼子。**

[![License: All Rights Reserved](assets/img/license-notice.svg)](./LICENSE)

一个跑在浏览器里的竞赛解题工作台（数学 / 物理，CMO、IMO、CPhO、IPhO 量级）。自带 API Key，无后端、无账号、无云同步：题图与讲义留在这台机器上，AI 请求由浏览器直连服务商，输出前必须通过一组由代码执行的验收门槛。

> 它不以「答得快、答得多」为卖点，而以「**错得可见**」为卖点：不给伪造的置信度百分比，只给可核验的证据覆盖率；题面抄错比答错更危险，所以图片题必须人工核对才允许输出「已验证」。

在线使用：**<https://azdezhishijiangtang.github.io/sciencemind/>**

---

## 它解决什么问题

大模型做竞赛题，失败往往不是「不会」，而是这几种：

| 失败形态 | ScienceMind 的处置 |
| --- | --- |
| 用「显然成立」「易证」跳过关键论证 | 红线正则扫描叙述字段，命中即降级并标出位置 |
| OCR 把 `x²` 读成 `2x`，验证器验的是错的题 | 图片题未勾选人工核对，程序禁止输出 `verified` |
| 自己写完自己批，批语是「思路正确」 | 审核必须由第二个模型族独立重算，候选自报的 checks 不算证据 |
| 两份答案数值一样就宣布一致 | 仲裁只看正确性，不看票数；证明无效时数值相同也不算通过 |
| 出错时静默吞掉，页面照样显示成功 | 失败关闭：解析失败、审核失败、证据不足都写明原因并降级 |

---

## 判题链路

一道题从进入页面到给出结论，经过十二道可逐段检查的关卡：

1. **入口分流** — 拍题 / 资料共用一套不确定性语义
2. **本地 OCR** — 浏览器内识别，结果只是「待核对的草稿」
3. **人工核对** — 逐字确认题面，存疑项显式登记
4. **题目契约** — 目标、符号、假设、图片边界成为结构化字段
5. **请求层** — URL 归一化、七家参数映射、400 整组去参重试
6. **N 路求解** — solver 独立作答，候选之间互不可见
7. **独立审核** — verifier 逐目标、逐步骤重算，不看自我评价
8. **程序化验收** — 结构 / 漏审 / 工具 fail / 红线四类门槛
9. **第三方仲裁** — adjudicator 只认正确性，不盲从多数
10. **证据量** — 覆盖率、独立性、交叉一致 → `sufficient`
11. **确定性渲染** — Markdown 由代码组装，输出层不改写证明
12. **结果页** — 证据、降级原因、八条「不会发生」

### 三档模型

| 角色 | 立场 | 默认行为 |
| --- | --- | --- |
| `solver` | 强推理 | 把题做出来，允许多路独立候选 |
| `verifier` | 独立第二模型 | 先自行重算，再逐目标逐步骤审核，主动找反例 |
| `adjudicator` | 第三方 | 逐目标规范化比较，判断证明是否有效 |

开启「强制三档来自不同模型族」后，同源会直接抛错：禁止同源模型自我复核或自我仲裁。默认不强制，但会在结果页标注「审核独立性有限」——不静默改变语义。

### 状态只有三档

- `verified` — 通过全部门槛，附证据级别（`cross_checked` / `single_verified`）
- `needs_review` — 有候选但被拦下，逐条写明拦在哪
- `unresolved` — 没有可用候选，不包装成答案

---

## 功能

### 解题

- 文字题、图片题（本地 OCR + 人工核对硬门槛）
- 候选数 1–3 路独立求解，推理档位 关 / 低 / 中 / 高
- 结果页给出证据量面板、可审计步骤、降级与警告、判定依据
- 一键复制 Markdown、导出 `.md`、导出证据 JSON

### 资料库

- 导入 PDF / TXT / Markdown，逐页提取文字层；扫描页标「未提取」，不假装识别成功
- 浏览器内 TF-IDF 检索，无 Key 也能用
- 解题时勾选「注入资料库片段」，命中的讲义片段连同页码一起进入提示词
- lite / full 两档备份包导出

### 档案

每次判题连同证据量、降级原因一起留在本机 IndexedDB。没有「手动标记已解决」的入口，也没有一键忽略检查。

### 方法

页面内写明十二道关、三档分工、红线规则、证据量字段与四类边界，逐条对应 v11.0 方案。

---

## 隐私与密钥

- **Key 只存在内存句柄**，刷新即失，不写 `localStorage` / `sessionStorage` / 备份包
- 空闲 15 分钟、页面隐藏 3 分钟、`pagehide` 触发自动锁定
- 非 HTTPS 端点一律拒绝，仅 `localhost` 放行
- 请求使用 `credentials: omit`、`referrerPolicy: no-referrer`、`cache: no-store`
- 错误信息统一脱敏，不回显 Bearer 头与请求体
- 题图、讲义、档案全部留在本机 IndexedDB，不上传任何服务器

> 纯静态 BYOK 无法抵御解锁期间的 XSS。密钥只存内存，降低的是持久化暴露面，不是硬件级隔离。根治方案是服务端代理 + HttpOnly 会话，那不属于纯前端直连模式。

---

## 快速开始

1. 打开 <https://azdezhishijiangtang.github.io/sciencemind/>
2. 点右上角「未配置模型」→ 选择服务商，填 Key 与模型名
3. 回到解题页，粘贴题目或上传题图 → **开始判题**

**没有 Key 也能跑**：点「载入示例」→「开始判题」，会执行一次完整的本地演示——两份示例候选、示例审核、示例仲裁，全部在浏览器内完成，不发任何请求。演示里第二份候选故意写了「由对称性显然」，用来观察红线是怎么把它拦下来的。

### 支持的服务商

| 服务商 | 默认端点 | 推理参数映射 |
| --- | --- | --- |
| OpenAI | `api.openai.com/v1` | `reasoning_effort` |
| DeepSeek | `api.deepseek.com/v1` | `thinking` |
| 智谱 GLM | `open.bigmodel.cn/api/paas/v4` | `thinking` |
| Kimi / Moonshot | `api.moonshot.cn/v1` | `thinking` |
| 通义千问 / DashScope | `dashscope.aliyuncs.com/compatible-mode/v1` | `enable_thinking` + `thinking_budget` |
| Gemini | `generativelanguage.googleapis.com/v1beta/openai` | `thinking_budget` |
| 自定义 | 任意 HTTPS 的 OpenAI 兼容端点 | 不注入 |

遇到 400 且错误信息指向推理参数时，会整组去参后重试一次。返回 `Failed to fetch` 通常是服务商不允许浏览器跨域，而不是 Key 错误——纯前端直连只支持显式开放 CORS 的端点。

---

## 本地运行

纯静态，无构建步骤（**仅在获得作者授权的前提下**）：

```bash
git clone https://github.com/azdezhishijiangtang/sciencemind.git
cd sciencemind
python3 -m http.server 8080
# 打开 http://localhost:8080
```

直接双击 `index.html` 也能用，但 `file://` 下 IndexedDB 与部分浏览器 API 行为不一致，建议起本地服务器。

### 部署

仓库自带 `.github/workflows/deploy.yml`：推送到 `main` 后自动发布到 GitHub Pages。若更换部署账户，需在 **Settings → Pages → Source** 重新选择 **GitHub Actions**。

---

## 已知边界

按 v11.0 方案自己的口径，这是「闭环交付版」而非「正式版」：

- 真实服务商端点未逐家实测（参数映射在 mock 上验证）
- 未做抓包网络审计与真机 CSP / Vault 验收
- 没有人工金标集，因此**不提供任何「正确率提升 X%」的数字**
- 未测试错误答案放行率
- CORS 直连只支持显式开放跨域的服务商

页面里所有「已实现 / 原型 / 设计中」的标注都按真实状态写，不把演示说成生产能力。

---

## 目录

```
index.html                 单页应用外壳
assets/css/app.css         设计系统：纸张、红笔、仪器面板 + 月光模式
assets/js/data.js          七家预设、推理档位、红线规则、示例数据
assets/js/api.js           请求层：URL 归一化、参数映射、400 去参、脱敏
assets/js/solver.js        编排：OCR 契约 → N 路求解 → 审核 → 门槛 → 仲裁 → 证据量
assets/js/store.js         IndexedDB、偏好、TF-IDF 索引、备份包
assets/js/ui.js            视图、交互、主题切换、导入导出
.github/workflows/deploy.yml
LICENSE
```

---

## 主题

右上角的太阳 / 月亮按钮切换**日光 / 月光**。首次访问跟随系统 `prefers-color-scheme`，手动切换后记住选择（仅存主题名，不存任何其他内容）。月光模式不是把纸刷黑，而是换一张深色的纸：暖墨绿底、米白字，红笔提亮以维持同等阅读对比。

---

## 版权与使用限制

**本仓库不是开源项目，保留所有权利（All Rights Reserved）。** 完整声明见 [LICENSE](./LICENSE)。

本仓库全部内容——源代码、判题编排与验收逻辑、提示词与红线规则、界面设计与文案、文档、示例题目、部署配置——著作权归 **azdezhishijiangtang** 所有，**不适用 MIT / GPL / Apache-2.0 等任何开源许可证**，未向任何人授予默认使用许可。

未经作者事先书面许可，禁止：

1. 复制、转载、摘编、截图、克隆、镜像、上传网盘或以任何渠道分发本仓库的全部或部分内容；
2. 将本仓库内容（含修改版、衍生版）用于自己或第三方的项目、作业、文章、视频、产品，无论商业或非商业；
3. 出售、付费分享、打包倒卖或以任何形式牟利；
4. 删除、遮盖或修改版权标识、作者署名及 `LICENSE` 文件。

如需使用，请通过 GitHub [@azdezhishijiangtang](https://github.com/azdezhishijiangtang) 联系作者取得**事先书面授权**。

页面可以公开访问，仅表示本站点可以浏览，不构成对代码与内容的任何使用授权。

> 判题结果不构成对数学 / 物理结论的正确性保证。`verified` 只表示通过了本流程的程序化检查。
