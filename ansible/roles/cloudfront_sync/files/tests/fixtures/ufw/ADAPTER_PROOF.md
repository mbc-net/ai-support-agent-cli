# Phase A adapter proof boundary

`files/ufw_integrity.py` is not imported by the synchronization engine or installer in this phase. It does not invoke UFW, a capability probe, a subprocess, policy writes, state writes or a network request.

The `ufw-stock-036-v1` grammar verifies the complete header, each tuple and its complete generated iptables block, and the complete logging/rate-limit/footer bytes. It supports the stock action/protocol/ports, route/interface, application and logging forms represented by the real-UFW corpus. It rejects unsupported or noncanonical forms before returning a document. No unknown/comment region is ignored or silently canonicalized. Arbitrary hand-edited files need explicit review; the predictor does not make them safe by deleting their residue.

`ManagedTuple` is a prediction input, **not proof of ownership**. The later engine integration must supply tuples from its confirmed ownership manifest, retain its existing unowned collision/policy/order defenses, and validate the installed UFW source/capability profile. A comment or this Python type alone must never transfer ownership.

`predict_user_file()` eagerly rejects an invalid transition and returns the entire before/after file generation. `assert_inventory_transition()` conserves all paths, file types, mode/uid/gid and all file bytes except those exact predicted generations. No-op uses an empty transition list and therefore requires the complete inventory to remain unchanged. Multiple commands affecting the same family must be checked separately, not merged by accepting a final hash.

`capture_ufw()` reads fixed paths with nofollow/nonblocking FDs, rejects unsafe ownership/writable paths/symlinks/hardlinks/nonregular files, bounds sizes/counts, verifies read-time identities and rechecks the complete tree. Returned evidence is immutable. It does not guarantee resistance to a malicious root that can rewrite both code and evidence, nor perfect detection of an adversarial writer restoring every observable attribute between observations.

## Actual references versus pure branches

The `22.04`, `24.04`, `26.04` directories contain real enabled-UFW CLI output, operation manifests and protected-file checks. The `profiles/<OS>` directories add all five logging levels and default-policy variations with extended rules. The generator calculates expected bytes **before** executing each real UFW command. A deliberately broken predictor was verified to fail this harness.

All actual CLI references currently have `limit_supported=True`. `False` is a source-derived pure grammar branch covered by unit tests, not a claim that a real kernel lacking recent/limit capabilities was exercised. Future runtime profile selection must not infer tested kernel compatibility merely because this grammar can parse a document. Unknown runtime profiles require a fail-closed decision and explicit verification.

Only public fixture addresses and comments appear here. Golden data are read-only evidence, not configurations to deploy. This phase does not enable timers, create an integrity baseline, migrate a state format, change guard variables, modify the server firewall, or send a notification.
