# Jev 全量公式评价：申请 API 与首次运行

此功能在 `codex/jev-scoring` 分支上提供实验性全量语义筛查。程序负责公式、训练/验证指标和观测定义域检查；TypeSafe Jev 负责五个独立语义维度；主 agent 负责最终逐项科学解释；研究者选择公式。

## 申请 API

1. 打开官方 [TypeSafe 控制台](https://console.typesafe.ai/)，使用 Google 或邮箱注册/登录。
2. 按控制台提示开通访问；若账户仍需 early access，按 [TypeSafe 官网](https://typesafe.ai/) 的入口申请，等待账户获得使用权限。
3. 获得访问后，在控制台的 API key 管理区域创建密钥。官方 [Quick start](https://docs.typesafe.ai/introduction/quickstart) 说明从 dashboard 获取 key。
4. 在控制台查看账户余额、计费和额度要求。当前官方 [模型页](https://docs.typesafe.ai/models) 公布 `jev-1.13.0` 输入价格为每百万 token **$0.042**，输出免费。以账户和官方实时信息为准。

申请说明核对日期：2026-10-06。无需把密钥发给聊天助手，也无需在仓库中创建包含密钥的文件。

## 准备研究证据

将完整 SISSO 输出、`sage.features.json`、原始特征提取源码交给 agent。让 agent：

- 先运行 `inspect`，健康检查含错误时停止；有验证数据时检查 `leakage`。
- 逐项阅读特征定义与对应源码，整理单位、计算方法、来源和预测时可获得性。不能仅凭特征名猜定义；AI 编写的定义先保留为 `ai-draft`。
- 从 `examples/sage.research.example.json` 建立 `sage.research.json`，填写目标定义和研究问题；提供适用范围、可追溯科学证据与解释假设。

请求及评分标准优先使用英文，最终解释可用中文。官方说明 Jev 目前英文准确率最好。

研究上下文遵循 `schemas/research-context.schema.json`。`referenceEvidence` 的每项包含 `id`、`claim`、`source`、`kind`，明确区分计算结果、研究者说明、来源文档和 AI 假设。`formulaReviews` 的键为计划内的 `id`，例如 `Models/top0003_D001::1`；可提供 `interpretation`、`assumptions`、`referenceIds`、`calculatedTrends` 和 `reviewStatus`。导数、极限与数值趋势应先由代码计算，附上方法和证据，再供 Jev 判断是否符合已知预期。

上下文允许缺少部分信息；缺少目标定义、特征描述或可靠特征定义时，语义结果保留为 `not-assessable`。目标定义经研究者确认后，将模板中的 `target.reviewStatus` 改为 `confirmed`；来自可靠文档则标为 `imported-documentation`。仍为 AI 草稿或待确认的定义不用于自动正面语义结论。AI 假设不作为自身正确性的独立证据。计划不会自动编造特征含义、补抓文献或证明因果关系。

## 不需要密钥的离线检查

在 PowerShell 中进入本仓库。把下面的示例路径换成实际目录：

```powershell
node bin/sisso-sage.mjs inspect "D:\research\sisso-run"
node bin/sisso-sage.mjs leakage "D:\research\sisso-run"
node bin/sisso-sage.mjs jev-plan "D:\research\sisso-run" --features "D:\research\sage.features.json" --context "D:\research\sage.research.json" --source-root "D:\research\feature-extraction" --output review.jev.plan.json
```

计划列出每条完整公式、全部已提供数据集的 RMSE、MAE、MaxAE、R² 和 Spearman rho、SISSO 总体报告值、特征定义和源码证据、定义域检查、完整请求和粗略费用估计。检查 `coverage.total`、`included`、`truncated` 与 `scope.topFiles`，确认实际覆盖范围。

默认覆盖最初选中的 `Models` 目录内所有匹配的 `top*_D*`/`*_coeff` 文件对，包括不同描述符维度。模型 ID 包含文件名与 rank，避免跨文件 rank 冲突。不会合并其他子目录中的不同 SISSO 运行，也不会拟合或评分未导出的 SIS 特征组合。用 `--top-file <绝对路径>` 可限定一个文件对（归档使用归档内文件名）。

`--limit 20` 可先查看前 20 条，结果明确标记截断；省略该参数才覆盖全部已导出的候选。所有文件先通过健康检查；观测定义域失败或非有限预测的公式保留证据但不调用 Jev，也不进入最终推荐。相同请求按 SHA-256 去重，所有原模型记录仍保留。

费用估计采用 UTF-8 字节数除以四，**不是官方 tokenizer**，中文、长源码等可能偏差较大。实际成功请求的 token usage 写入评分报告。过大的请求会标记 `request-too-large-reduce-context`，应减少无关上下文。不要将全量数据行或整个项目源码塞进研究上下文。

## 配置密钥并试跑

用 PowerShell 安全输入密钥，仅设置当前终端会话环境变量：

```powershell
$jevCredential = Read-Host "TypeSafe API key" -AsSecureString
$env:TYPESAFE_API_KEY = [System.Net.NetworkCredential]::new("", $jevCredential).Password
Remove-Variable jevCredential
```

无需额外安装 TypeSafe SDK：CLI 使用 Node.js 18+ 自带的 `fetch`。密钥不会写入计划、报告或检查点。

先用少量真实候选验证访问和评价质量：

```powershell
node bin/sisso-sage.mjs jev-score "D:\research\sisso-run" --features "D:\research\sage.features.json" --context "D:\research\sage.research.json" --source-root "D:\research\feature-extraction" --limit 10 --output pilot.jev.scores.json
node bin/sisso-sage.mjs jev-report pilot.jev.scores.json --output pilot.jev.md
```

`jev-score` 会向官方 `https://api.typesafe.ai/v1/systemone` 发送公式、相关特征元数据/提取源码片段、指标摘要和你提供的研究上下文。程序不发送原始样本行；你自行放入上下文的内容会发送。其余命令保持本地运行。

没有实际 API key 的情况下，仓库测试只使用模拟 API；不能把测试通过理解为 Jev 已在 SISSO 上达到可靠准确率。

## 全量评分与断点续跑

```powershell
node bin/sisso-sage.mjs jev-score "D:\research\sisso-run" --features "D:\research\sage.features.json" --context "D:\research\sage.research.json" --source-root "D:\research\feature-extraction" --output full.jev.scores.json
```

默认并发为 4，可用 `--concurrency 1` 降低并发。默认固定模型版本 `jev-1.13.0`；用 `--jev-model` 显式更换。接口对临时限流与服务错误重试，遵循 `Retry-After`。认证错误会停止启动新请求并保留已完成记录。

默认检查点为 `full.jev.scores.json.checkpoint.jsonl`。中断或部分失败后，重跑同样的命令并增加 `--resume`：

```powershell
node bin/sisso-sage.mjs jev-score "D:\research\sisso-run" --features "D:\research\sage.features.json" --context "D:\research\sage.research.json" --source-root "D:\research\feature-extraction" --output full.jev.scores.json --resume
```

可通过 `--checkpoint <文件>` 显式指定检查点。只复用请求哈希一致的成功结果；更改公式、数据、特征证据、研究上下文、模型或评分标准后，会重新评分。默认已有检查点必须使用 `--resume`，避免误重复付费。输出覆盖率始终保留失败、阻断和截断数量，失败时 CLI 返回非零退出状态。费用报告仅统计本次新成功请求；重试、失败请求和旧检查点费用另计。

## 选出候选并交给 agent 解释

```powershell
node bin/sisso-sage.mjs jev-select full.jev.scores.json --limit 5 --near-optimal-tolerance 0.10 --output shortlist.jev.json
node bin/sisso-sage.mjs jev-report full.jev.scores.json --limit 5 --output full.jev.md
```

五个维度分别为描述符含义、公式与目标的连贯性、已计算趋势与已知预期的一致性、交互含义和预测时特征可获得性。每维包含独立的证据充分性 Choice 和条件性的四档 Score；缺证据、不适用、低置信度分别保留，不压成低分。保留原始概率分布及置信度，不提供万能的 0–100 可解释性总分。

筛选先排除观测定义域/预测失败，并限定在声明的近优 RMSE 范围；优先保留性能最佳，再选择各独立语义维度偏好的不同描述符结构以及较简单的候选。最多 10 条。相同描述符表达式（忽略空白和项顺序）合并显示；不声称判定了代数等价。Jev 请求失败的公式仍可凭预测证据进入待复核候选，避免服务故障让好公式消失。

默认置信度阈值 `0.6` 只是实验起点，可用 `--confidence-threshold` 调整。高置信度不是科学正确性的证明；建议由研究者标注 50–100 条典型公式，检查排序、关键错误检出和有价值候选的保留情况，再确定标准和阈值。

让 agent 阅读报告及原始证据，逐条解释完整公式中的各项、成立条件、支持证据、反证和需要补做的验证；遇到复杂推导使用主推理模型。Jev 本身不生成分析解释，因此 Markdown 报告是审查材料，最终机理分析由 agent 完成。选择报告保留多个候选供用户取舍。

没有验证集时标记无法评价泛化。验证集存在时仍需确认划分设计；发现重复或共用结构时保留相应限制。反复用验证集挑公式后，它承担选择集角色，最终泛化结论需要未参与筛选的测试数据或适当的嵌套评价。

## 常见错误

| 情况 | 处理 |
|---|---|
| `Set TYPESAFE_API_KEY` | 在执行 CLI 的同一 PowerShell 窗口配置环境变量 |
| HTTP 401/403 | 检查 key 和账号权限，再用 `--resume` |
| HTTP 429/529 | 自动退避；若持续失败，降低并发后续跑 |
| HTTP 422 | 检查研究上下文与当前模型/API 支持情况；已完成结果保留 |
| `Checkpoint already exists` | 用 `--resume`，或选择新的输出/检查点文件 |
| `not-assessable` | 补充目标、特征来源、相关科学证据；不把它当负面结论 |
| `needs-review` | 主 agent /研究者复核；不可仅提高阈值以宣称结果更可靠 |

MCP 现有查询工具继续保持本地、只读；Jev 功能通过新增 CLI 命令和 `src/index.mjs` 的 JavaScript API 调用。
