# Self-Hosting BookForge on a Multipass VM (step by step, from empty)

This is a fully explicit, copy-pasteable walkthrough for taking a **brand-new,
empty [Multipass](https://canonical.com/multipass) Ubuntu VM** to a running
BookForge instance — nothing assumed to be pre-installed except Multipass
itself on your host machine.

It assumes:
- **No local LLM.** You'll use a cloud AI provider key (OpenAI, Anthropic,
  Google, or OpenRouter) instead of LM Studio. LM Studio needs a GPU and a
  desktop UI, neither of which a headless VM has.
- You want the full stack self-contained in the VM: the BookForge app *and*
  a local Supabase (Postgres/Auth/Storage) instance, both running on the same
  VM.

This is a companion to [docs/SELF_HOSTING.md](SELF_HOSTING.md), which
explains *what* each step does and *why*. This doc is the *exact commands*,
in order, for a fresh Ubuntu VM specifically. If a command here produces an
error you don't understand, SELF_HOSTING.md's
[Troubleshooting](SELF_HOSTING.md#10-troubleshooting) section is the first
place to check.

## Contents

1. [Hardware sizing](#1-hardware-sizing)
2. [Launch the VM](#2-launch-the-vm)
3. [Shell into the VM](#3-shell-into-the-vm)
4. [Install system packages](#4-install-system-packages)
5. [Install Node.js](#5-install-nodejs)
6. [Install Docker](#6-install-docker)
7. [Install the Supabase CLI](#7-install-the-supabase-cli)
8. [Clone BookForge and install dependencies](#8-clone-bookforge-and-install-dependencies)
9. [Start Supabase and apply the database schema](#9-start-supabase-and-apply-the-database-schema)
10. [Configure environment variables](#10-configure-environment-variables)
11. [Build and do a first run](#11-build-and-do-a-first-run)
12. [Access it from your host machine](#12-access-it-from-your-host-machine)
13. [Keep it running permanently (systemd)](#13-keep-it-running-permanently-systemd)
14. [Optional: a real domain with HTTPS](#14-optional-a-real-domain-with-https)
15. [Updating later](#15-updating-later)
16. [Multipass-specific troubleshooting](#16-multipass-specific-troubleshooting)

---

## 1. Hardware sizing

BookForge's own app process is light. The heavy part is the local Supabase
stack (`supabase start` runs ~11 Docker containers: Postgres, Auth, Realtime,
Storage, Kong, PostgREST, Studio, Inbucket, Edge Runtime, and — as configured
in this repo's `supabase/config.toml` — Analytics/Logflare, which is one of
the heavier ones).

| | Minimum (works, tight) | Recommended |
|---|---|---|
| vCPU | 2 | 4 |
| RAM | 4GB | 8GB |
| Disk | 20GB | 30–40GB |

RAM is the binding constraint, not CPU. Disk needs headroom for Docker
images (~2–3GB), `node_modules`, the Next.js build cache, and Postgres data
that grows as you add books.

## 2. Launch the VM

From your **host machine** (not inside any VM yet):

```bash
multipass launch --name bookforge --cpus 4 --memory 8G --disk 30G
```

Use `--cpus 2 --memory 4G --disk 20G` instead if you're deliberately going
with the minimum tier from the table above.

Confirm it's running:

```bash
multipass list
```

You should see `bookforge` with a state of `Running` and an IPv4 address —
note that address, you'll need it in [step 12](#12-access-it-from-your-host-machine).

## 3. Shell into the VM

```bash
multipass shell bookforge
```

Every command from here through step 13 runs **inside this VM shell**,
unless a step explicitly says "back on your host machine."

## 4. Install system packages

```bash
sudo apt update
sudo apt install -y curl git ca-certificates gnupg build-essential
```

- `curl`/`gnupg` — needed to add the Docker and Node.js package repositories below
- `git` — to clone the BookForge repo
- `build-essential` — safety net for any npm dependency that needs to compile a native module during `npm install` (BookForge's own direct dependencies are pure JavaScript, but this avoids a possible failure from a transitive one)

## 5. Install Node.js

BookForge requires **Node.js 20.9 or later** (Next.js 16's minimum). This
installs the current Node 20.x LTS line from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify:

```bash
node --version   # should print v20.9.0 or higher
npm --version
```

## 6. Install Docker

The Supabase CLI needs a Docker-compatible runtime to run Postgres/Auth/Storage
as containers. This installs Docker Engine directly from Docker's official
install script (this is plain Docker Engine, not Docker Desktop — Docker
Desktop is a Mac/Windows GUI product and isn't used on a headless Linux VM):

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

**Important:** the group change above doesn't take effect in your current
shell. Exit and reconnect:

```bash
exit
```

Then from your host machine again:

```bash
multipass shell bookforge
```

Verify Docker works **without** `sudo` now:

```bash
docker run hello-world
```

If that prints a "Hello from Docker!" message, you're good. If it still says
permission denied, the group change genuinely needs a fresh login — try
`newgrp docker` as a one-shot fix for the current shell, or restart the VM
entirely with `multipass restart bookforge` (from the host) and shell back in.

## 7. Install the Supabase CLI

This detects your VM's CPU architecture automatically (Multipass on Apple
Silicon Macs creates `arm64` VMs; Multipass on Intel Macs or Linux hosts
typically creates `amd64` VMs — this command handles either):

```bash
ARCH=$(dpkg --print-architecture)
curl -fsSL "https://github.com/supabase/cli/releases/latest/download/supabase_linux_${ARCH}.deb" -o supabase.deb
sudo dpkg -i supabase.deb
rm supabase.deb
```

Verify:

```bash
supabase --version
```

## 8. Clone BookForge and install dependencies

```bash
git clone https://github.com/ricardojjulia/BookForge.git
cd BookForge
npm install
```

(If you're working from your own fork, clone that URL instead.)

## 9. Start Supabase and apply the database schema

```bash
supabase start
```

**First run pulls ~11 Docker images and takes several minutes** — this is
the single slowest step in this whole guide. Later runs (e.g. after a VM
reboot) are fast.

When it finishes, it prints a block like this — **keep this terminal output
visible**, you'll copy three values from it in the next step:

```text
API URL: http://127.0.0.1:58321
...
anon key: eyJhbGciOiJI...
service_role key: eyJhbGciOiJI...
```

If you scroll past it, run `supabase status` any time to print it again.

Now apply the database schema (70+ migration files, run once against your
fresh database):

```bash
supabase migration up
```

This should complete with no errors on a genuinely fresh `supabase start`. If
you see `relation "X" already exists` instead, see
[SELF_HOSTING.md's troubleshooting section](SELF_HOSTING.md#10-troubleshooting) —
it means the local database wasn't actually fresh, not that a migration file
is broken.

## 10. Configure environment variables

```bash
cp .env.example .env.local
nano .env.local
```

(Or `vim`, if you prefer — `nano` isn't installed by default on every base
Ubuntu image; if `nano` isn't found, `sudo apt install -y nano` first, or use
`vi`, which always is.)

Fill in at minimum:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:58321        # "API URL" from step 9
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJI...           # "anon key" from step 9
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJI...               # "service_role key" from step 9
NEXT_PUBLIC_SITE_URL=http://<VM-IP-ADDRESS>:4747        # from `multipass list`, or your real domain if you did step 14
```

Since you're using a **cloud AI provider, not a local LLM**, also set at
least one of:

```bash
OPENROUTER_API_KEY=sk-or-...    # simplest: one key, many models
# or
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...
```

You only need one of these — OpenRouter is the easiest single choice. Leave
`LMSTUDIO_BASE_URL`/`LMSTUDIO_API_KEY` as their defaults; they're simply
unused since no LM Studio server exists on this VM.

Every other variable in `.env.local` can stay blank for a basic self-hosted
setup — see [SELF_HOSTING.md §5](SELF_HOSTING.md#5-environment-variables)
for the full reference of what each one does.

Save and exit (`nano`: `Ctrl+O`, `Enter`, `Ctrl+X`).

## 11. Build and do a first run

```bash
npm run build
npm run start
```

`npm run start` runs the production build on port `4747` and blocks the
terminal (this is expected — it's the running server). Leave this running
for now to confirm it works; [step 13](#13-keep-it-running-permanently-systemd)
sets it up to run permanently in the background instead.

## 12. Access it from your host machine

Get the VM's IP address (from your **host machine**, in a separate terminal —
don't close the one running `npm run start`):

```bash
multipass list
```

Open `http://<VM-IP-ADDRESS>:4747` in a browser on your host machine. You
should see BookForge's sign-in page.

**Note on reachability:** by default, Multipass VMs sit behind NAT — reachable
from the *host machine itself* and usually from other devices on the same
LAN, but not from the public internet without additional router-level port
forwarding or a bridged Multipass network. That's fine for personal/local use;
see [step 14](#14-optional-a-real-domain-with-https) if you specifically need
it reachable from the internet under a real domain.

Create an account, then go to **Settings → AI Settings** to confirm your
cloud provider key is detected.

## 13. Keep it running permanently (systemd)

Stop the foreground `npm run start` from step 11 (`Ctrl+C`), then set it up
as a background service that survives reboots and restarts on crashes.

First, create a dedicated system user to run it as (don't run a
network-facing service as your own login user or as root):

```bash
sudo useradd --system --home /opt/bookforge-ai --shell /usr/sbin/nologin bookforge
sudo mkdir -p /opt/bookforge-ai
sudo cp -r ~/BookForge/. /opt/bookforge-ai/
sudo chown -R bookforge:bookforge /opt/bookforge-ai
```

Create the service file:

```bash
sudo tee /etc/systemd/system/bookforge.service > /dev/null <<'EOF'
[Unit]
Description=BookForge AI
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=/opt/bookforge-ai
EnvironmentFile=/opt/bookforge-ai/.env.local
ExecStart=/usr/bin/npm run start
Restart=on-failure
User=bookforge

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start it:

```bash
sudo systemctl enable --now bookforge
sudo systemctl status bookforge
```

`status` should show `active (running)`. Check logs any time with:

```bash
sudo journalctl -u bookforge -f
```

**Also make Supabase's Docker containers start on boot** — `supabase start`
only starts them for the current session by default; Docker's own restart
policy on the containers it created (which the Supabase CLI sets) generally
handles this, but confirm after a `multipass restart bookforge` (from the
host) that `docker ps` inside the VM shows the containers back up. If not,
re-run `supabase start` inside the VM — it's safe to run again and won't
duplicate or reset existing data.

## 14. Optional: a real domain with HTTPS

Only relevant if this VM is genuinely reachable from the internet at a public
IP (a cloud-hosted Multipass instance, or a local one with router port
forwarding set up) and you have a domain pointed at it.

```bash
sudo apt install -y caddy
```

Point that domain's DNS A record at the VM's public IP, then:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
your-domain.com {
    reverse_proxy localhost:4747
}
EOF
sudo systemctl restart caddy
```

Caddy handles TLS certificates automatically. Update
`NEXT_PUBLIC_SITE_URL=https://your-domain.com` in `.env.local`, then
`sudo systemctl restart bookforge` so generated links (password reset,
invites) point at the right place.

## 15. Updating later

```bash
cd /opt/bookforge-ai   # or ~/BookForge if you're updating the non-systemd copy
git pull
npm install
supabase migration up
npm run build
sudo systemctl restart bookforge   # if running under systemd
```

`supabase migration up` only applies migration files it hasn't seen before —
safe to run after every update even if nothing changed.

## 16. Multipass-specific troubleshooting

**`docker run hello-world` says permission denied even after `usermod -aG docker`.**
The group membership change needs a fresh login session, not just a new
command. `exit` the shell entirely and `multipass shell bookforge` back in
(or `multipass restart bookforge` from the host, then shell in again).

**VM IP address changed after a restart.** Multipass VMs can get a new DHCP
lease on restart. Re-check `multipass list` from the host and update
`NEXT_PUBLIC_SITE_URL` in `.env.local` (and restart the `bookforge` service)
if you're accessing it by raw IP rather than a domain.

**`supabase start` fails claiming a port is already in use.** Local Supabase
uses ports 58321 (API), 58322 (Postgres), 58323 (Studio), 58324
(Inbucket/email testing), 58327 (Analytics), and 58329 (connection pooler) —
see `supabase/config.toml`. If another process on the VM already holds one of
these (rare on a fresh VM), either stop that process or change the
conflicting port in `supabase/config.toml` before re-running `supabase start`.

**Everything else** (LM Studio-not-relevant here since you have no local
model, cloud provider call failures, email invites, migration conflicts) —
see [SELF_HOSTING.md §10](SELF_HOSTING.md#10-troubleshooting), which applies
identically once BookForge itself is running, regardless of what it's running
on.

---

See [docs/SELF_HOSTING.md](SELF_HOSTING.md) for the full environment variable
reference, and [docs/HOWTO.md](HOWTO.md) for a walkthrough of actually using
BookForge once it's running (importing a manuscript, running Auto-Review,
exporting).
