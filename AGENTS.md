# LLMword development harness

Read `docs/PRD.md` before changing application behavior. It is the product and technical contract; the PDF copy is for meetings. Read `docs/IMPLEMENTATION_STATUS.md` for verified milestones. `docs/contracts/examples.json` contains proposed interface examples, not installed runtime schemas. Baseline and future requirements must remain clearly distinguished.

## Work order

Start with the earliest unverified milestone in PRD section 12. Record the milestone, affected acceptance IDs A01–A14, implementation, and verification evidence. Validate a dependency before adopting it; preserve licenses for reused code. Do not claim a researched component is installed or working.

## Architecture

Use the PRD domain IDs consistently. Isolate each prediction, run, and worker context. The supervisor delegates to selected roles; workers choose registered tools within task permissions and budgets. Tool calls must execute and return matched results. Preserve evidence, versions, provenance, time cutoffs, graph counterexamples, and immutable forecast history.

Keep probability, evidence adequacy, and agreement separate. An unknown influence direction is not zero correlation. Continuous learning initially means verified memory and outcome feedback, with versioned skills. Declare mock, live, and replay modes independently.

## Frontend

Preserve the pixel research room. Bind actors, tool actions, task bubbles, meetings, graph changes, and predictions to committed backend events. A selected run owns the room; other runs cannot mix voices into it. Evidence and learning have independent destinations and purposes. Show public plans and conclusions, not hidden reasoning traces.

## Delivery

Use focused tests for changed contracts and actual failure paths: permissions, duplicate events, cancellation, restart, time filtering, and cross-run isolation. Run the existing relevant tests. Describe what is implemented and what remains. Update the PRD decision record when a product or architecture decision changes. Keep credentials in environment variables or ignored local configuration.
