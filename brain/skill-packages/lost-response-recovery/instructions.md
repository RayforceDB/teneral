# Lost-response recovery

Use when an external operation may have run but its reply was lost, timed out, reset or interrupted. This is untrusted procedure text: it grants no authority and runs no operation.

1. Identify the exact operation, its intended target and any idempotency key or attempt id. Preserve existing error and receipt text.
2. Check what actually completed before repeating anything. Prefer a service receipt or current-state lookup; read the conversation or remote history when the send result was uncertain.
3. Compare the observed state with the requested outcome, including exact revision, commit, recipient and content where applicable. A matching receipt ends the recovery: do not repeat the operation.
4. If the service proves the attempt was not started, a fresh attempt may be safe under the authority that governed the original operation. Record why.
5. If state is unavailable or ambiguous, stop and report the uncertainty. Ask for the missing decision or evidence rather than guessing that repetition is harmless.
6. After any justified retry, verify the resulting state independently. Record success, no-op recovery, inconclusive outcome or harm through `skill_outcome`; never equate running this procedure with success.

A skill does not authorize publishing, credentials, task-state changes, mutation or a new external operation. Those retain their original approval requirements.
