# Research Method

## Evidence classes

- **FACT**: directly observed in current source, tests, task artifacts, or official vendor documentation; include a file path, symbol, URL, and date where available.
- **INFERENCE**: a conclusion derived from one or more facts; state the reasoning and confidence.
- **HYPOTHESIS**: a product or user-demand assumption that still needs validation; never score it as proven demand.

### Label normalization

The research files use both canonical labels and localized labels. They mean the same thing and must not be mixed into a stronger claim:

- `FACT` / `事实` = direct observation.
- `INFERENCE` / `推论` / `边界含义` = a conclusion derived from facts.
- `HYPOTHESIS` / `假设` / `开放问题` = an unverified product, user, market, or environment question.
- `RECOMMENDATION` / `架构建议` / `建议` = conditional advice, not evidence that the feature is needed or already supported.
- `产品决策` = a decision still awaiting user, privacy, deployment, or environment evidence.

When a sentence combines observations and interpretation, keep the observation and the interpretation separately identifiable. Competitor documentation proves that a workflow or packaging pattern exists; it does not prove SqlDiff demand, frequency, willingness to pay, or retention.

## Document roles and reference aliases

The synthesis uses these roles: [`capability-inventory.md`](capability-inventory.md) is the detailed capability inventory; [`user-needs-and-priority-signals.md`](user-needs-and-priority-signals.md) records demand hypotheses; [`candidate-directions-and-validation.md`](candidate-directions-and-validation.md) contains the weighted candidate scorecard; [`technical-scalability.md`](technical-scalability.md) records technical readiness and host boundaries; and [`../roadmap.md`](../roadmap.md) is the decision-facing synthesis. Other files are supporting research and may overlap, but should not override these roles.

For compact evidence references in the supporting files, these aliases mean the following repository paths:

- `e2e-report.md` → `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md`
- `smoke-report.md` → `.trellis/tasks/archive/2026-09/09-21-desktop-m7-smoke/smoke-report.md`
- `smoke-report2.md` → `.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md`
- `dbeaver-report.md` → `.trellis/tasks/archive/2026-09/09-22-converters/dbeaver-report.md`
- `09-24-e2e-icon-release/...` → `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/...`
- Other shorthand task references such as `09-21-sqldiff-desktop/prd.md` → `.trellis/tasks/archive/2026-09/09-21-sqldiff-desktop/prd.md`; `09-24-product-expansion-roadmap/...` remains the active task path.

## Source priority

1. Current repository code, tests, specs, and task reports.
2. Official product/vendor/API documentation.
3. Reproducible experiments with public fixtures or local sample data.
4. Community reports and competitor comparisons, labeled as directional rather than authoritative.

## Roadmap rule

A candidate direction may enter the roadmap only when its problem statement, target user, value hypothesis, technical reuse, risk, and smallest validation experiment are all explicit. A technically possible feature is not automatically a validated product need.
