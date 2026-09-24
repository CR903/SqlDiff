# Candidate Direction Scorecard

Use 1–5 scores; every score must include a short evidence or hypothesis note.

| Dimension | Weight | 1 | 3 | 5 |
|---|---:|---|---|---|
| Problem severity/frequency | 25% | Rare or cosmetic | Recurring workflow pain | Repeated, costly, release-blocking work |
| Strategic fit | 20% | Drifts from safe local diff | Adjacent extension | Core to a defensible product position |
| Reuse/feasibility | 20% | New platform rewrite | Some reuse or bounded adapter | Reuses core contracts and data flow |
| Differentiation | 15% | Commodity feature | Moderate convenience | Clear underserved workflow advantage |
| Validation speed | 10% | Hard to test in a small experiment | Needs a prototype | Can test with fixture/interview quickly |
| Risk/security inverse | 10% | Material trust or safety risk | Manageable with guardrails | Mostly additive and low-risk |

## Interpretation

- **4.0+**: candidate for a near-term validation task.
- **3.0–3.9**: keep as a conditional direction; require a specific evidence gate.
- **<3.0**: defer unless new evidence changes the score.
- A high score without a user/problem source is still a hypothesis, not a commitment.

Any table using this scorecard must attach a short evidence or hypothesis note to every candidate row. Technical-readiness scores in other research files use different dimensions and must be labeled as such; they cannot be silently substituted for this product-validation score.
