# Adapter review and limits

The local candidate received a separate code review against revision 3. The review found and prompted these fixes:

- Distinguish known 403 rate-limit errors from authentication failures; unknown 403 remains forbidden.
- Validate resumed source/normalized hash offsets and parser presence/shape; reject reset digest state and lost partial records.
- Require an invocation-budget callback for checkpoint coordination and yield before staging, final verification, source validation and commit.
- Align basic optional-column support and exclude all Google-native MIME types from binary CSV candidates.
- Preserve submillisecond timestamp ordering and explicitly leave undeclared altitude/speed units unresolved.

The reviewed safety contract is conditional on the injected production writer correctly implementing durable pins/reservations, checkpoint and manifest binding, receipt lookup, immutable-frame arbitration and recovery barriers. Tests use fake services; they do not establish that writer or the live Drive publication primitive.

Source reads are bracketed by metadata checks. Reserved asset IDs are never replaced after uncertain creates. Exact-byte readback is required before checkpoint authority advances. Only acquired locks are released. Incomplete staging contributes no run totals or rewards.

Final results are recorded in gas-test-results.txt. Actual cloud Apps Script execution, permissions, folder writes, production application behavior, scheduler and completed-run publication were not tested or activated.
