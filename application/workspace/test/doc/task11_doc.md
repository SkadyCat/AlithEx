Source task file: `task11.md`

Objective: Create an npm-based web application in `G:\GameExPro3\AILab` that opens as a webpage with `left_menu`, `top_menu`, `center_area`, `console`, and `right_info`; manage workspaces by cloning `workspace\test`; switch between workspaces; show `sessions`, `inprocess`, and `processed` task cards plus linked docs; launch the selected workspace's `run.bat`; and submit new Markdown tasks into `sessions`.

Changes made:
- Initialized a new npm application in `G:\GameExPro3\AILab` and added `express`.
- Added `server.js` with APIs for workspace discovery, workspace cloning, task/doc/log retrieval, task submission, and `run.bat` launching.
- Added the browser UI in `public\index.html`, `public\styles.css`, and `public\app.js` with the requested layout and interactions.
- Added `wait-for-session-doc.bat` in `workspace\test` earlier in this run so the agent queue can block correctly when empty.
- Updated `package.json` scripts for running and checking the dashboard server.

Validation results:
- `npm test` passed (`node --check server.js`).
- Homepage smoke test passed at `http://localhost:3000/`.
- API smoke tests passed for workspace listing, workspace switching data, workspace cloning from `test`, task submission into `sessions`, log retrieval, processed-card linked-doc retrieval, and the `run-agent` endpoint against a disposable stub workspace.
- Temporary validation workspaces were cleaned up after testing.

Remaining risks or blockers:
- The `run-agent` endpoint was validated with a disposable stub `run.bat`; the real behavior still depends on each workspace's own launcher script and local Copilot CLI environment.
