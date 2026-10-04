# Reports tool

The Reports tool finds and reads durable scout reports.

## Operations

- `{"op": "list"}` lists all archived namespaces. Optional `project` filters by a project name or `_independent`.
- `{"op": "get", "name": "<listed-name>"}` reads a report; `name` may include one `namespace/` prefix.

Neither operation accepts `machine`. Reports always come from the controller's archive, not the independent default or a live remote query.

## Finding reports

Reports from registered-project and independent research are listed together, newest first. A project filter limits the list to that project. Independent research is identified as `_independent`.

The archive is controller-local under `.omp/reports/<namespace>/`. Local and remote scouts write to host staging; it is collected and verified before successful scout completion or cleanup. Pending collection appears in Workers, not as an empty completed report. Project or machine removal does not remove the archive.

Collected reports include provenance from `<report-stem>.meta.json` (for example `audit.md` has `audit.meta.json`): the worker/launch, source machine, bound session and host identity, OS, source path and captured source SHA when known, collection time, byte count and SHA-256. The sidecar does not contain the prompt, credentials or conversation transcript.

## Reading reports

A listed report can be read in full using its listed name. When two projects hold reports with the same name, prefix the name with its project or `_independent`. Reports remain available after their scout completes, while its machine is offline, or after its profile is removed. Reading never fetches from a remote host.

List rows and get details include provenance when available. Older reports without a sidecar stay readable. Invalid or unreadable metadata adds an issue without hiding otherwise readable Markdown. Collection preserves report bytes, including LF/CRLF, and never overwrites a differing archive or sidecar.

Listing is not itself proof of successful scout completion: migrated local reports can already exist in the archive before in-place validation and collection acknowledgement finish. Use Workers to check pending collection.
