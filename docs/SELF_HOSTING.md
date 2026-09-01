# Self-Hosting BookForge

This guide is for running BookForge yourself — on your own laptop, your own
server, or your own cloud account — rather than using a hosted BookForge
subscription at **[bookforgeai.io](https://bookforgeai.io)**. It covers
everything the README's [Quick Start](../README.md#quick-start) doesn't: a
full environment variable reference, AI provider setup (local model or your
own cloud API keys), production deployment options, keeping your instance up
to date, and troubleshooting.

If you just want to try BookForge locally for development, the README's Quick
Start is enough — come back here when you're ready to run it for real, keep
it running, or understand exactly what each setting does.

## Contents

1. [What self-hosting means here](#1-what-self-hosting-means-here)
2. [Prerequisites](#2-prerequisites)
3. [Get the code and install dependencies](#3-get-the-code-and-install-dependencies)
4. [Start Supabase and apply migrations](#4-start-supabase-and-apply-migrations)
5. [Environment variables](#5-environment-variables)
6. [Choose your AI engine](#6-choose-your-ai-engine)
7. [Run it](#7-run-it)
8. [Deploying for real, ongoing use](#8-deploying-for-real-ongoing-use)
9. [Keeping your instance up to date](#9-keeping-your-instance-up-to-date)
10. [Troubleshooting](#10-troubleshooting)
11. [Data, privacy, and license](#11-data-privacy-and-license)

See also: [docs/MULTIPASS_DEPLOY.md](MULTIPASS_DEPLOY.md) — a fully explicit, copy-pasteable walkthrough from an empty Multipass Ubuntu VM to a running instance.

---

## 1. What self-hosting means here

BookForge ships as one codebase with two ways to run it, controlled entirely
by `NEXT_PUBLIC_DEPLOYMENT_MODE`:

| | Self-hosted (this guide) | Managed SaaS (a BookForge subscription) |
|---|---|---|
| Who runs the servers | You | BookForge |
| `NEXT_PUBLIC_DEPLOYMENT_MODE` | unset, or `self_hosted` | `managed_saas` |
| Supabase project | Your own (local or your own cloud project) | BookForge's |
| AI cost | Your own local model, or your own provider API key(s) | Included in your subscription, metered automatically |
| AI engine choice (Settings / onboarding) | LM Studio (local) or any cloud provider | Cloud providers only — LM Studio is hidden, since it's a server on *your* machine and unreachable from BookForge's hosted runtime |
| Billing/subscription code | Never runs — there is nothing to bypass, since self-hosted deployments never call it | Stripe checkout, credit ledger, tier enforcement |
| CreativeWriter collaboration panels (reader comments, contributor suggestions) | Off — no per-user entitlement system exists yet, so they're off deployment-wide rather than open to everyone | On |

Everything else — the manuscript pipeline, BookForge Critic, Rewrite
Architect, exports, CreativeWriter's writing desk — is identical in both
modes. Self-hosting isn't a stripped-down trial; it's the same product, run
on your own infrastructure, at no cost beyond whatever AI compute you choose
to use.

## 2. Prerequisites

- **Node.js 20.9 or later** (required by Next.js 16 — check with `node --version`)
- **npm** (ships with Node)
- **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** (or another Docker-compatible runtime) — the Supabase CLI runs Postgres, Auth, and Storage as containers
- **[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)** (`npm install -g supabase`, or via Homebrew: `brew install supabase/tap/supabase`) — developed against 2.x
- One AI engine, either:
  - **[LM Studio](https://lmstudio.ai/)** running locally with at least one instruction-tuned model loaded, or
  - An API key from OpenAI, Anthropic, Google, and/or [OpenRouter](https://openrouter.ai/) (one key routes to many models)

No Vercel account, Stripe account, or managed Supabase project is needed for self-hosting — those only matter for the managed-SaaS side.

## 3. Get the code and install dependencies

```bash
git clone https://github.com/ricardojjulia/BookForge.git
cd BookForge
npm install
```

(Or clone your own fork's URL instead, if you're working from one.)

## 4. Start Supabase and apply migrations

```bash
supabase start
```

This pulls and starts the local Postgres/Auth/Storage/Studio containers. First run takes a few minutes; later runs are fast. When it finishes, it prints a block of URLs and keys — keep this terminal output, you'll copy several values from it in the next step.

Then apply the database schema:

```bash
supabase migration up
```

This runs every file in `supabase/migrations/` (70+ as of this writing) against your fresh local database, in order. On a brand-new `supabase start` this always applies cleanly — see [Troubleshooting](#10-troubleshooting) if you ever see a `relation already exists` error instead (it means the local database wasn't actually fresh, not that a migration is broken).

## 5. Environment variables

Copy the template and fill it in:

```bash
cp .env.example .env.local
```

`.env.local` is already git-ignored — never commit it. Here's what each variable is for and where to get it, for a self-hosted deployment specifically:

| Variable | Required? | Where it comes from |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **Required** | `supabase status` → `API URL` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Required** | `supabase status` → `anon key` |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required** | `supabase status` → `service_role key`. Used server-side only (account deletion, the Steward console, admin operations) — never exposed to the browser. Keep this out of source control and out of any client-side code. |
| `NEXT_PUBLIC_SITE_URL` | Recommended | The URL your instance is actually reachable at, e.g. `http://localhost:4747` for local dev, or `https://your-domain.com` once deployed. Used to build absolute links (password reset, email invites). |
| `NEXT_PUBLIC_DEPLOYMENT_MODE` | Optional | Leave unset, or set to `self_hosted` explicitly. Only ever set to `managed_saas` if you specifically intend to run the paid-subscription code path (you'll also need Stripe configured — see below). |
| `LMSTUDIO_BASE_URL` | Optional | Defaults to `http://localhost:1234/v1`. Only needed if LM Studio runs somewhere other than the same machine on the default port. |
| `LMSTUDIO_API_KEY` | Optional | Defaults to `lm-studio` (LM Studio's own placeholder key — it doesn't check it). |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `OPENROUTER_API_KEY` | Optional | Only needed if you want a cloud provider available (see [§6](#6-choose-your-ai-engine)). Each user can also enter their own key directly in **Settings** instead of setting one here server-wide. |
| `RESEND_API_KEY` | Optional | [Resend](https://resend.com) — powers outbound email (collaborator invites, notifications). Leave blank and the app still works; invite links are shown directly in the UI instead of emailed. |
| `RESEND_FROM` | Optional | Defaults to a shared BookForge sender address that works without domain verification. |
| `NEXT_PUBLIC_HCAPTCHA_SITE_KEY` | Optional | A [hCaptcha](https://hcaptcha.com) site key for the sign-in/sign-up form. Leave blank for self-hosting — the form renders with no CAPTCHA widget, which is correct for a single self-hosted instance. Only set this alongside enabling CAPTCHA in your own Supabase project's Auth settings, and only once this key is live everywhere that talks to that project (Supabase enforces the token project-wide the moment it's turned on). |
| `CRON_SECRET` | Optional for most self-hosters | Bearer token gating `/api/internal/*` routes (account-purge flagging, email retry sweeps, assignment reminders). Only matters if you wire up your own scheduler (cron, systemd timer) to hit those routes periodically — see [§8](#8-deploying-for-real-ongoing-use). |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | **Not used in self-hosted mode** | Only relevant if you deliberately run in `managed_saas` mode with real billing. Leave unset for self-hosting — the billing code path never runs without `NEXT_PUBLIC_DEPLOYMENT_MODE=managed_saas`. |
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL` / `LLM_TEMPERATURE` / `LLM_MAX_OUTPUT_TOKENS` | Optional, advanced | Forces every user onto one specific provider/model server-wide, bypassing per-user Settings. Most self-hosters should leave these unset and let each account configure its own AI engine in **Settings** instead. |

## 6. Choose your AI engine

You have two options, and they aren't mutually exclusive — BookForge can route different tasks to different engines per user, per **Settings → AI Settings**.

**Option A — Local model via LM Studio (private, no per-token cost)**

1. Install and open [LM Studio](https://lmstudio.ai/).
2. Download at least one instruction-tuned model (7B+ parameters recommended; larger models generally handle BookForge's whole-book context better, at the cost of speed).
3. In LM Studio, start the local server (Developer tab → "Start Server"), and confirm it's listening on `http://localhost:1234`.
4. In BookForge, go to **Settings → AI Settings** and confirm it detects your loaded model(s).

Your manuscript text never leaves your machine in this mode — every AI call goes to `localhost`.

**Option B — Bring your own cloud API key**

Set one or more of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, or `OPENROUTER_API_KEY` in `.env.local` (server-wide), or have each user paste their own key into **Settings** (per-account, takes priority over the server-wide key). OpenRouter is usually the simplest option: one key, many backend models, and BookForge already has sensible per-task model defaults for it — see [docs/HOWTO.md §9](HOWTO.md#9-set-up-openrouter-and-per-task-model-routing).

Cloud calls are billed directly by that provider to whichever API key was used — BookForge itself never adds a markup or a subscription fee for this in self-hosted mode.

## 7. Run it

```bash
npm run dev
```

Open `http://localhost:4747`, create an account, and go to **Settings** to confirm your AI engine is detected. From here, [docs/HOWTO.md](HOWTO.md) walks through real end-to-end scenarios (importing a manuscript, running Auto-Review, exporting).

## 8. Deploying for real, ongoing use

For anything beyond local development — a server you leave running, a shared instance for a small team — you have a few options. All of them assume you've already run `supabase start`/`migration up` somewhere Supabase can stay running (your own server, or a [hosted Supabase project](https://supabase.com/dashboard) if you'd rather not manage Postgres yourself — either works, since BookForge only talks to Supabase over its standard API/connection string, not anything local-only).

**Deploying to a fresh VM specifically?** [docs/MULTIPASS_DEPLOY.md](MULTIPASS_DEPLOY.md) is a fully explicit, copy-pasteable walkthrough from an empty [Multipass](https://canonical.com/multipass) Ubuntu VM through a running instance — every command, in order, including hardware sizing, installing Docker/Node/the Supabase CLI from scratch, and a systemd service. The rest of this section covers the same ground at a higher level, for any Linux server.

**Production build:**

```bash
npm run build
npm run start   # runs the production build on port 4747
```

**Running it continuously** — a process manager keeps it alive across reboots and crashes. A minimal `systemd` unit:

```ini
# /etc/systemd/system/bookforge.service
[Unit]
Description=BookForge AI
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/bookforge-ai
EnvironmentFile=/opt/bookforge-ai/.env.local
ExecStart=/usr/bin/npm run start
Restart=on-failure
User=bookforge

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now bookforge
```

**Putting it behind a domain with HTTPS** — a reverse proxy terminates TLS and forwards to BookForge's port. [Caddy](https://caddyserver.com/) does this in three lines with automatic certificate management:

```caddyfile
your-domain.com {
    reverse_proxy localhost:4747
}
```

Set `NEXT_PUBLIC_SITE_URL=https://your-domain.com` once you have a real domain, so generated links (password reset, invites) point at the right place.

**Scheduled internal jobs (optional):** if you want the account-deletion purge sweep, collaboration email retries, or CreativeWriter assignment reminders to run automatically rather than only when a page happens to poll them, set `CRON_SECRET` and hit these routes on a schedule (cron, systemd timer, or any scheduler you already run) with `Authorization: Bearer $CRON_SECRET`:

```bash
curl -X GET https://your-domain.com/api/internal/account-purge \
  -H "Authorization: Bearer $CRON_SECRET"
```

`vercel.json`'s `crons` block documents the schedules BookForge's own hosted deployment uses as a reference (daily for account-purge). None of this is required for BookForge to function — without it, purge/reminder sweeps just don't run until something else triggers them.

## 9. Keeping your instance up to date

```bash
git pull
npm install
supabase migration up
npm run build && npm run start   # or restart your process manager
```

`supabase migration up` only applies migration files it hasn't seen before — it's safe to run after every update, even if nothing changed. Check `CHANGELOG.md` for what's new.

## 10. Troubleshooting

**LM Studio: "connection failed" in Settings.** Confirm LM Studio's local server is actually started (Developer tab) and at least one model is loaded. If it's on a different machine or port, set `LMSTUDIO_BASE_URL` to match.

**`supabase migration up` fails with `relation "X" already exists`.** This means your local Postgres already has tables from a previous, out-of-band setup — not that a migration file is broken. On a genuinely fresh instance this shouldn't happen; if it does, `supabase db reset` wipes and rebuilds the local database from your migrations (fastest fix), or `supabase stop --no-backup` followed by `supabase start` tears down and recreates the containers and their data volumes entirely (note: plain `supabase stop` without `--no-backup` preserves your data across the stop, which is what you want *except* in this specific recovery case).

**Cloud provider calls fail immediately.** Double-check the relevant `*_API_KEY` is set (either server-wide in `.env.local`, or per-account in Settings) and that the account you're testing with actually selected that provider under Settings → AI Settings rather than defaulting to LM Studio.

**Port conflicts.** Local Supabase uses ports 58321 (API), 58322 (Postgres), 58323 (Studio), 58324 (Inbucket/email testing), 58327 (analytics), and 58329 (connection pooler) — see `supabase/config.toml`. BookForge itself runs on 4747 (`npm run dev`/`start`, both configurable via the `-p` flag in `package.json`'s scripts if you need different ports).

**Email invites aren't arriving.** If `RESEND_API_KEY` is unset, this is expected — invite links are shown directly in the UI instead. Set a real Resend key to send actual emails.

**Confirmation/invite emails land in spam, or a confirmation link says "invalid or expired" on the very first click.** This is usually Outlook/Hotmail's Safe Links feature, which auto-visits (and burns) one-time links in an email server-side before the recipient ever opens it — not a BookForge bug. Signup confirmation has a 6-digit code as a fallback for exactly this case (enter it on the "Confirm your email" screen instead of clicking the link). For real deliverability to strict providers, configure SPF and DMARC records for whatever domain you send from, in addition to the DKIM record your email provider sets up automatically.

## 11. Data, privacy, and license

Nothing about a self-hosted deployment ever calls out to BookForge's own servers — no telemetry, no license check, no phone-home. Your Supabase project is yours; your manuscripts live in your own Postgres/Storage. AI calls go only to whichever engine you configured (your own LM Studio instance, or the cloud provider(s) whose keys you supplied).

BookForge AI is licensed under **AGPL-3.0** (see [LICENSE](../LICENSE)): you're free to self-host, modify, and even run it commercially. If you modify it and let others interact with your modified version over a network — including as a hosted service — you must make your modified source available to those users under the same license.
