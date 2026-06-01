
# Production Agent Skills Pack

This pack contains detailed `SKILL.md` files for an agentic software delivery system that can take a product idea through requirements, architecture, implementation, testing, review, and release.

## Agents included

1. Product Requirement Agent
2. System Architect Agent
3. Frontend Engineering Agent
4. Backend Engineering Agent
5. Database Agent
6. Test Engineering Agent
7. Code Review/Security Agent
8. DevOps/Release Agent

## Recommended execution order

```text
Product Requirement Agent
  -> System Architect Agent
  -> Database Agent
  -> Backend Engineering Agent
  -> Frontend Engineering Agent
  -> Test Engineering Agent
  -> Code Review/Security Agent
  -> DevOps/Release Agent
```

For complex products, the flow is iterative. For example, the System Architect Agent may return questions to the Product Requirement Agent, or the Test Engineering Agent may ask for clearer acceptance criteria.

## Shared agent protocol

Every agent should produce explicit artifacts and a handoff package. Avoid hidden assumptions. When an agent makes a decision, it should state the reason, trade-offs, and downstream impact.

### Required handoff shape

Each agent should end major work with:

```markdown
## Handoff Summary

### Completed
- ...

### Key Decisions
- Decision: ...
  Reason: ...
  Impact: ...

### Artifacts Produced
- ...

### Open Questions
- ...

### Risks
- ...

### Next Recommended Agent
- ...

### Acceptance Gate Status
- Pass / Conditional Pass / Blocked
```

### Shared severity levels

Use these severity levels across product, architecture, code, security, test, and release reviews.

| Severity | Meaning | Required action |
|---|---|---|
| Blocker | Product cannot safely ship or core behavior is impossible/undefined. | Must fix before continuing. |
| Critical | High probability of data loss, security exposure, severe downtime, or broken core flow. | Must fix before release. |
| Major | Significant reliability, UX, maintainability, or correctness problem. | Fix before production unless explicitly accepted. |
| Minor | Small issue with low user impact. | Fix if low effort or schedule for follow-up. |
| Nit | Style, wording, cleanup, or optional improvement. | Optional. |

### Shared production-readiness rules

A feature is not production-ready unless:

- Requirements and acceptance criteria are explicit.
- Architecture and data model are documented.
- APIs have validation and error handling.
- Authentication and authorization are reviewed.
- Tests cover happy path, common failure paths, edge cases, and regressions.
- Secrets are not committed or logged.
- Database migrations are safe and reversible or have a documented mitigation plan.
- Observability exists for important flows.
- Deployment and rollback plans exist.
- Documentation is sufficient for another engineer to run and maintain the system.

## Directory layout

```text
production_agent_skills/
  README.md
  product-requirement-agent/SKILL.md
  system-architect-agent/SKILL.md
  frontend-engineering-agent/SKILL.md
  backend-engineering-agent/SKILL.md
  database-agent/SKILL.md
  test-engineering-agent/SKILL.md
  code-review-security-agent/SKILL.md
  devops-release-agent/SKILL.md
```

## How to use these skills

Use each `SKILL.md` as the behavioral contract for that agent. The orchestrator should load the relevant skill before assigning work.

A good orchestrator prompt looks like this:

```text
You are the <Agent Name>. Follow your SKILL.md exactly.
Input artifacts:
- <links or pasted artifacts>
Task:
- <specific assignment>
Expected output:
- <named artifact>
Constraints:
- <deadline, stack, compliance, repo constraints>
```

## Strong recommendation

Do not let all agents write to the repository at the same time. Route all changes through pull requests or isolated branches. Verification agents should be able to block release.

