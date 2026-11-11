---
description: Create a PRD (Product Requirement Document)
model: opencode/big-pickle
---

Check if a prd.md file exists or not. If not, create one. 

# Workflow
1. Start with the requirements from `../docs/requirments.md`
2. Write a short product summary in plain language
3. Define one main product goal before listing features
4. Add two or three success metrics
5. Describe the main personas and their use cases
6. Separate in-scope features from out-of-scope features
7. Write user stories for the most important user outcomes.
8. Write simple user flows for the must-have features
9. Prioritize features before moving to the technical specification

# Format
It should have the following format:

Product name:
[Name of the product]

1. Product summary
[Explain the product in 3 to 5 sentences]
2. Problem statement
[What problem are you solving and why does it matter?]
3. Product goal
[This product helps] [target user] [achieve outcome]
4. Success metrics
- [Metric 1]
- [Metric 2]
- [Metric 3]
5. Primary users
Persona 1:
- Role: 
- Goal:
- Frustration:
- Main use cases:
- Success condition:;
6. Feature scope
in scope for this version:
- [Feature 1 and reason]
- [Feature 2 and reason]
- [Feature 3 and reason]
7. Out of scope
Not included in this version:
- [Feature or capability and reason]
- [Feature or capability and reason]
8. User stories
US-001: As a [role], I want [capability], so that [benefit]
US-002: As a [role], I want [capability], so that [benefit]
9. User flows
Flow name:
- Start:
- Action:
- System response:
- Success path:
- Failure path:
10. Feature priorities
Must-have:
- [Feature]
Should-have:
- [Feature]
Could-have:
- [Feature]
Later:
- [Feature]
11. Open questions
- [Question that must be answered before technical design]
12. Links to requirements
- Supports REQ-F-001
- Supports REQ-NF-001
- Supports BR-001

## Your resources

- The path to the PRD file: `../docs/prd.md`

