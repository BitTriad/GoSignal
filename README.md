# GoSignal

GoSignal is a Slack-native launch readiness agent for the Slack Agent Builder Challenge Track 3. This repository implements the hackathon MVP: analyze a launch thread, pull public Slack evidence in real time, build a durable markdown launch brief canvas, and drive one next action from a deterministic readiness engine.

## What ships in v1

- Thread-first readiness analysis using public Slack context.
- Deterministic classification for blockers, rollback risk, sign-offs, dependencies, and ambiguity.
- Markdown canvas generation for the durable launch brief.
- Block Kit message rendering for readiness boards, blockers, and actions.
- Optional Cerebras-backed natural summaries and DM answers with deterministic fallback.
- App Home listing of recent launches and rerun actions.
- In-memory storage by default with a Postgres adapter for hosted deployment.
- Azure-ready Postgres configuration with optional TLS settings.

## Project structure

- `manifest.json`: Slack app manifest tuned for the agent messaging experience.
- `src/app.ts`: Bolt app bootstrap and dependency wiring.
- `src/handlers/`: Slack event, shortcut, and action handlers.
- `src/domain/`: Launch models and deterministic readiness rules.
- `src/services/`: Launch orchestration, retrieval, canvas, and home rendering.
- `src/repositories/`: In-memory and Postgres persistence layers.
- `test/`: Unit and integration-style tests for the MVP flow.

## Local development

1. Copy `.env.example` to `.env` and fill in Slack credentials.
2. Install dependencies with `npm install`.
3. Run `npm run dev` for a one-shot local process, or `npm run dev:watch` while iterating on TypeScript files.
4. Use `slack run` if you want Slack CLI-managed local development. This repository now includes the `.slack/` project files and a CLI hook that starts GoSignal through `npm run dev:watch`.
5. Import `manifest.json` into Slack or use Slack CLI to wire the app to your workspace.
6. Create an app-level token and keep `Socket Mode` enabled for the easiest local setup.
7. Before Marketplace-style distribution, switch the app to HTTP mode with request URLs instead of Socket Mode.

### Optional LLM mode

- Keep `ENABLE_LLM_SUMMARIES=false` to use the deterministic provider only.
- To enable more natural summaries and DM answers, set:
  - `ENABLE_LLM_SUMMARIES=true`
  - `LLM_PROVIDER=cerebras`
  - `CEREBRAS_API_KEY`
  - Optional `CEREBRAS_MODEL`, `CEREBRAS_BASE_URL`, and `CEREBRAS_REASONING_EFFORT`
- Recommended for GoSignal: `CEREBRAS_REASONING_EFFORT=none`. This app needs concise, grounded launch summaries, not long hidden reasoning traces that can consume the whole completion budget.
- Run `npm run check:llm` to verify the exact Cerebras path GoSignal uses in production. The check fails if GoSignal falls back to deterministic output.
- The deterministic readiness engine still decides launch state, blockers, and approvals. The LLM only rewrites those results into more natural language and answers follow-up questions from the stored launch record.

### Slack CLI notes

- `.slack/config.json` binds this checkout to the current Slack CLI project.
- `.slack/hooks.json` overrides the CLI start hook so `slack run` launches the real TypeScript GoSignal app instead of a sample `app.js`.
- If you want to point this repo at a different Slack app later, reinitialize the project with Slack CLI rather than editing the generated project files by hand.

## Azure App Service deployment

GoSignal is now set up to deploy cleanly to Azure App Service from GitHub Actions.

### Database choice for Azure

Use Azure Database for PostgreSQL Flexible Server for GoSignal.

- GoSignal persists launches through `pg` in [src/repositories/postgresLaunchRepository.ts](/Users/anshul/Documents/Slack Project/src/repositories/postgresLaunchRepository.ts).
- The current repository schema uses PostgreSQL tables, a unique index, and `JSONB` payload storage in [src/repositories/schema.sql](/Users/anshul/Documents/Slack Project/src/repositories/schema.sql).
- If the Azure wizard is offering Cosmos DB API for MongoDB, do not use that option for this codebase unless you plan to rewrite the persistence layer.

### What changed for deployment

- `npm run build` now compiles app code only into `dist/`.
- `npm start` runs the production build through the root `server.js` entrypoint so Azure App Service can detect it as a Node app.
- `GET /` and `GET /healthz` are available for smoke tests and App Service health checks.
- The GitHub Actions workflow runs type-checks, tests, builds a deployable bundle, and deploys to Azure on every push to `main`.
- Database tables are created automatically on app startup when `DATABASE_URL` is set.

### One-time Azure setup

1. Create an Azure App Service web app for Node.js 22.
2. In Azure App Service `Configuration`, add these app settings:
   - `SLACK_SIGNING_SECRET`
   - `SLACK_BOT_TOKEN`
   - `USE_SOCKET_MODE=true` if you want to keep the current Socket Mode setup
   - `SLACK_APP_TOKEN` if `USE_SOCKET_MODE=true`
   - `DATABASE_URL` for your PostgreSQL connection string
   - `DATABASE_SSL_MODE=require` for Azure Database for PostgreSQL
   - `DATABASE_CA_CERT_PATH` only if you later choose certificate validation with a custom CA bundle
   - `ENABLE_LLM_SUMMARIES=false` unless you add an LLM provider later
3. Download the App Service publish profile from Azure.
4. In GitHub, add:
   - Repository variable `AZURE_WEBAPP_NAME`
   - Repository secret `AZURE_WEBAPP_PUBLISH_PROFILE`
5. Push to `main`. GitHub Actions will test, package, and deploy GoSignal automatically.

### Recommended runtime modes

- Easiest first deployment: keep `USE_SOCKET_MODE=true` and reuse your existing Slack app setup.
- More production-like later: switch to `USE_SOCKET_MODE=false` and point Slack event subscriptions and interactivity to `https://<your-app-name>.azurewebsites.net/slack/events`.
- Easiest database rollout: create the web app and Azure Database for PostgreSQL separately, then set `DATABASE_URL` in App Service.

### Useful checks after deploy

- Open `https://<your-app-name>.azurewebsites.net/` for a plain-text service check.
- Open `https://<your-app-name>.azurewebsites.net/healthz` for JSON health output.
- In Azure Log Stream, confirm the app starts with `GoSignal listening on port ...`.
- In Azure Log Stream, confirm you do not see database connection errors after adding `DATABASE_URL`.
- If App Service still falls back to a static page, set the Startup Command to `npm start` in the App Service configuration.

## Runtime notes

- v1 is intentionally public-first for retrieval. Real-time Search results are only used when a user-triggered action provides an action token and the context is public-channel safe.
- The canvas is markdown-only by design. Interactive state stays in messages and App Home.
- The default provider is deterministic and evidence-backed. Cerebras is optional for natural summaries and DM answers.
