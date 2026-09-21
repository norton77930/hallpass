<!--
Sync Impact Report

- Version change: unversioned scaffold -> 1.0.0
- Modified principles: none; this is the initial ratification
- Added principles:
  - I. Product Requirements Are the Source of Truth
  - II. Clean-Room Implementation
  - III. End-to-End Requirement Traceability
  - IV. Explicit Uncertainty
  - V. Least-Privilege Browser Access
  - VI. Privacy, Consent, and Data Minimization
  - VII. Observable and Testable Requirements
  - VIII. Manifest V3 Baseline
  - IX. Requirements Before Architecture
  - X. Dependency Discipline
  - XI. Defined Failure Behavior
  - XII. Specification Before Implementation
- Added sections: Product and Platform Constraints; Specification Workflow and Quality Gates
- Removed sections: none
- Follow-up TODOs: none
-->
# Chrome Extension Product Constitution

## Core Principles

### I. Product Requirements Are the Source of Truth

Normative product behavior MUST originate in the approved Product Requirements. Reference-extension
implementation details, conventions, and accidental behavior MUST NOT become product requirements
without explicit supporting evidence and approval. When sources conflict, the governing priority is
this Constitution, then the Product Requirements Draft, then documented reference analysis.

Rationale: separating observed evidence from approved intent prevents an existing implementation from
silently defining the new product.

### II. Clean-Room Implementation

The project MUST NOT copy or adapt reference-extension source code, bundled or minified code,
proprietary assets, private identifiers, private implementation architecture, or undocumented
internal protocols. The project MAY independently reimplement externally observable behavior that is
confirmed by an approved product requirement. Every such behavior MUST be described without relying
on private implementation details.

Rationale: a clean-room boundary protects legal provenance and keeps the new product independently
designed.

### III. End-to-End Requirement Traceability

Every in-scope capability MUST preserve an auditable chain:

`Reference Feature -> Product Requirement -> Spec User Story / Functional Requirement -> Plan -> Task
-> Implementation -> Test`.

Each artifact MUST retain stable identifiers or an explicit mapping table. A reference feature that is
out of scope MUST still have a recorded destination, such as `REFERENCE-ONLY`, rather than disappearing
from traceability.

Rationale: complete mappings make scope changes, omissions, and unsupported additions detectable.

### IV. Explicit Uncertainty

Unknown or unapproved behavior MUST remain explicitly labeled `NEEDS-CLARIFICATION`, `UNRESOLVED`,
`Behavior not confirmed`, or `Design decision required`. A plausible convention, common industry
pattern, or apparent reference behavior MUST NOT be promoted to a normative requirement. Work MUST
stop at the first gate that genuinely requires a product decision from the user.

Rationale: visible uncertainty is safer and more reviewable than a confident but unsupported
assumption.

### V. Least-Privilege Browser Access

Chrome Extension permissions and host access MUST follow least privilege. Every requested permission
MUST trace to an approved capability and observable acceptance scenario. Permission scope MUST NOT be
broadened for convenience, anticipated future work, or parity with a reference extension. Denial and
revocation behavior MUST be specified for every capability that depends on permission.

Rationale: browser permissions expose user activity and data, so excess access is a product and
security defect.

### VI. Privacy, Consent, and Data Minimization

Page content, URLs, selected text, authentication state, session data, and browser-derived information
MUST be treated as potentially sensitive. Specifications MUST identify relevant data categories,
user-trigger boundaries, permission implications, external transmission, authentication handling,
persistence expectations, and observable failure behavior. Collection, transmission, or persistence
MUST NOT be assumed when the Product Requirements do not authorize it.

Rationale: explicit boundaries let users and reviewers understand when sensitive browser context may
leave the page, browser, or device.

### VII. Observable and Testable Requirements

Every `MUST` and `SHOULD` product capability MUST have observable, technology-agnostic acceptance
criteria. Acceptance scenarios MUST state preconditions, the user-visible action or event, and the
result that can be verified. Private functions, internal classes, module boundaries, and specific test
tools MUST NOT serve as acceptance criteria.

Rationale: requirements are useful only when independent reviewers can determine whether they are
satisfied.

### VIII. Manifest V3 Baseline

Manifest V3 MUST be the default Chrome Extension platform baseline. Any proposed deviation MUST be
supported by an approved requirement that cannot be met within that baseline and MUST receive an
explicit governance amendment before planning proceeds.

Rationale: a declared platform baseline constrains scope without prematurely selecting an application
architecture.

### IX. Requirements Before Architecture

The specification phase MUST define what users need and why, not how the product will be built. It
MUST NOT choose a UI framework, bundler, state-management approach, test framework, project
architecture, or internal messaging architecture. Those decisions MAY be evaluated only after product
scope and blocking clarifications are resolved.

Rationale: architecture responds to approved behavior rather than constraining it in advance.

### X. Dependency Discipline

An external API, service, library, or protocol used by the reference extension MUST NOT automatically
become a dependency of the new product. Every dependency introduced during planning MUST trace to an
approved requirement, disclose relevant data and trust boundaries, and justify why the dependency is
necessary.

Rationale: copied dependencies can import hidden operational, privacy, licensing, and availability
risks.

### XI. Defined Failure Behavior

Every important user journey MUST specify observable behavior for applicable failures, including
unsupported or restricted pages, denied permission, inaccessible or empty content, unavailable
network, authentication or backend, browser navigation, user cancellation, stale state, and partial
failure. A scenario MUST be omitted when the corresponding capability or failure mode is genuinely out
of scope rather than invented for completeness.

Rationale: failure behavior is part of the product contract, not an implementation afterthought.

### XII. Specification Before Implementation

Implementation MUST NOT begin until the Constitution, formal specification, required clarifications,
planning, and task decomposition have passed their applicable gates. Specification work MUST NOT
create application source, manifests, service workers, content scripts, API clients, or select a
technical stack. A current workflow MUST stop before planning whenever a clarification is labeled
`BLOCKS-PLANNING`.

Rationale: staged approval prevents unresolved product choices from being embedded in code.

## Product and Platform Constraints

- The specification MUST preserve Product Requirement identifiers `PR-001` through `PR-019` and
  Reference Feature identifiers `F-001` through `F-021` through explicit destination mappings.
- `F-016` and `F-017` MUST remain `REFERENCE-ONLY` unless a later approved Product Requirement brings
  either feature into scope.
- Unconfirmed server-side and dynamic-feature-flag behavior for `PR-012`, iframe-internal and
  server-side behavior for `PR-014`, and connector transport and server-side behavior for `PR-015`
  MUST remain unresolved unless authoritative Product Requirements supply an answer.
- Reference evidence MAY support externally observable acceptance behavior. It MUST NOT expose or
  normalize private filenames, class names, function names, internal transports, or architecture in a
  normative specification.
- Sensitive-data behavior, authentication semantics, transmission policy, permission scope, and
  user-visible choices with multiple valid outcomes require explicit Product Requirements or a user
  decision.

## Specification Workflow and Quality Gates

1. Verify that the workspace, Spec-Kit integration, required skills, and authoritative evidence files
   are present before changing specification artifacts.
2. Ratify or validate this Constitution before creating a feature specification.
3. Derive independently valuable, priority-ordered user stories and testable functional requirements
   from the Product Requirements, preserving identifier mappings and out-of-scope destinations.
4. Validate traceability, uncertainty, acceptance coverage, implementation leakage, scope, and internal
   consistency. Issues with a single authoritative answer MAY be corrected; product choices MUST NOT be
   inferred.
5. Inventory unresolved decisions with stable question identifiers, related requirements, mutually
   exclusive options where possible, an unapproved recommendation if useful, impact categories, and a
   blocking level.
6. Stop for user review when a product decision is required. Planning, checklists beyond the
   specification quality check, task generation, and implementation require a later authorized
   workflow.

Reviews at every later lifecycle stage MUST verify the traceability chain, clean-room provenance,
permission minimization, privacy boundaries, failure behavior, and absence of unsupported assumptions.
A failing gate MUST remain visible in the relevant artifact; it MUST NOT be waived silently.

## Governance

This Constitution governs all project specification, planning, implementation, and review artifacts.
It supersedes conflicting workflow guidance but does not itself add product capabilities. Product
decisions remain subject to explicit user approval and the Product Requirements source-of-truth rule.

Amendments MUST document the proposed change, rationale, affected principles and artifacts, migration
or revalidation needs, and explicit approval. Versioning follows semantic versioning: a `MAJOR` change
removes or incompatibly redefines governance, a `MINOR` change adds or materially expands a principle,
and a `PATCH` change clarifies wording without changing obligations.

Compliance MUST be reviewed when approving a specification, plan, task set, implementation change, or
test result. Any deviation MUST identify the violated rule, explain why it is unavoidable, define a
time-bounded remediation, and receive explicit approval. Unapproved deviations are blocking.

**Version**: 1.0.0 | **Ratified**: 2026-08-24 | **Last Amended**: 2026-08-24
