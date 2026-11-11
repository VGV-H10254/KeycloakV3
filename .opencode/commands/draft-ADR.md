---
description: Generate an Architecture Decision Record (ADR) draft
model: opencode/big-pickle
---

Using the project requirment and technical specification below, draft an Architecture Decision Record for the architecture style. Include context, options considered, decision, reason, consequences, and implementation rules for the AI assistant. 

- The project requirment: `../docs/requirments.md`
- The PRD: `../docs/prd.md`
- The technical specification: `../docs/technical-spec.md`

# Format
ADR secition | What you write
--- | ---
Title | A short name for the decision
Status | Proposed, accepted, replaced, or rejected
Context | The problem and constraints behind the decision
Options considered | the realistic choices you compared
Decision | The option you selected
Consequences | The benefits, consts, and responsibilites created by the decision

# Template
ADR-001: [Decision title]
Status: Proposed | Accepted | Replaced | Rejected
Context: [Explain the problem, project constraints, and why a decision is needed.]
Options Considered:
1. [Option A] - [Benefit and Cost]
2. [Option B] - [Benefit and Cost]
3. [Option C] - [Benefit and Cost]

Decision:
[state the selected option clearly]

Consequences:
- [Positive consequences]
- [Trade-off or limitation]
- [Rule the AI assistant must follow during implementation]