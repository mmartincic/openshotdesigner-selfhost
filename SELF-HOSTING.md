# Self-hosting Open Shot Designer

This fork adds a small server so your projects live **on your own machine
instead of in one browser**. Open the same address on your laptop, phone or
tablet and you get the same projects, images, saved assemblies and custom
fixture profiles.

```
browser (any device) ──HTTPS──▶ reverse proxy + login ──▶ container :8080
                                (NPM + Authentik)          ├─ serves the app
                                                           └─ /api/kv/* → /data (plain files)
```

## What changed compared to upstream

| | Upstream (GitHub Pages) | This build |
|---|---|---|
| Where projects live | IndexedDB in one browser | `/data` on your server |
| Images (storyboards, floor plans, mood board, headshots) | IndexedDB | `/data/assets`, content-addressed |
| Saved assemblies, custom fixture profiles | localStorage | synced through the server |
| Several devices | separate libraries | one shared library |
| Two devices editing the same project | n/a | the second save is **refused**, not overwritten; the stale tab shows a *Reload* banner |
| Offline | works | the app shell loads, but saves wait until the server is reachable. Edits stay in the open tab and save automatically on reconnect |

Per-device things stay per-device on purpose: theme, language, panel sizes,
the zoom/pan of the floor plan, and which project you had open last.

The storage mode is chosen at build time (`npm run build:server`, which the
Dockerfile uses). A self-hosted
build never silently falls back to browser storage. If it can't reach the
server it shows a *Can't reach the storage server* screen with a Retry button.

## Data layout and backups

Everything is plain files under the data folder:

```
data/
  projects/<id>.json        one file per production
  assets/<id>.bin           image bytes (+ <id>.json with the MIME type)
  asset-meta/<id>.json      image metadata
  meta/…                    synced libraries and small app flags
```

Back it up with ZFS snapshots of the dataset, which is the easiest option on
TrueNAS. To restore, stop the app, put the files back and start it again.

> **Moving projects from the public version**: in the old browser, open the
> dashboard and use each project's *download project file* / *package* button.
> On your server, use **Import project file**.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port inside the container |
| `DATA_DIR` | `/data` | Where data is written |
| `MAX_BODY_MB` | `256` | Largest single upload (one project JSON or one image) |
| `AUTH_USER` / `AUTH_PASSWORD` | unset | Optional built-in basic auth. Leave unset when a proxy handles login |

The server has **no user accounts**. Everyone who gets past the login sees the
same library, so put a login in front of it (Authentik below, or the
built-in basic auth).

---

## Deploying on TrueNAS SCALE (Custom App wizard)

The route: **push this folder to GitHub → GitHub Actions builds the image
→ TrueNAS pulls it.** No building on the NAS.

### 1. Put it on GitHub

1. On github.com, click **New repository** and name it, for example,
   `openshotdesigner-selfhost`. Make it **Public**, which is simplest (see
   step 2). Don't tick "Add a README", because this folder already has one.
2. Push this folder. The web uploader caps out at 100 files and this has
   ~700, so use git (Git for Windows, or GitHub Desktop → *Add existing
   repository*):

   ```sh
   cd OpenShotDesigner-1.0.2-selfhost
   git init -b main
   git add -A
   git commit -m "Open Shot Designer 1.0.2, self-hosted"
   git remote add origin https://github.com/<you>/openshotdesigner-selfhost.git
   git push -u origin main
   ```

3. Open the repo's **Actions** tab. The **Docker image** workflow starts by
   itself and takes about 3–5 minutes. When it's green, the image is at
   `ghcr.io/<you>/openshotdesigner-selfhost:latest` (always lowercase).
   *CI* also runs (lint + tests). It's informational and doesn't block the
   image.

### 2. Let TrueNAS pull the image

New GHCR packages start **private**, even from a public repo. Pick one:

- **Make it public (recommended):** github.com → your profile → **Packages**
  → `openshotdesigner-selfhost` → **Package settings** → *Change
  visibility* → Public. The image contains no data of yours, only the app.
- **Keep it private:** create a GitHub token (*Settings → Developer settings
  → Personal access tokens (classic)*, scope `read:packages`). On TrueNAS,
  go to *Apps → Configuration → Docker registries → Add* with URI
  `ghcr.io`, your GitHub username and the token as password.

### 3. Create the dataset

Create a dataset such as `POOL/apps/openshotdesigner/data` and give the
**apps** user (UID/GID 568) read/write access. The *Apps* ACL preset works.

### 4. Custom App wizard

*Apps → Discover Apps → Custom App*:

| Field | Value |
|---|---|
| Application name | `openshotdesigner` |
| Image repository | `ghcr.io/<you>/openshotdesigner-selfhost` |
| Image tag | `latest` |
| Pull policy | *Always pull image* |
| Environment variables | none needed. Optionally `MAX_BODY_MB=256` |
| Port forwarding | container port `8080` → host port `30480`, TCP (any free port) |
| Storage | Host path `/mnt/POOL/apps/openshotdesigner/data` → mount path `/data` |
| Security context / user | run as user `568`, group `568` |
| Restart policy | unless stopped |

Install, then check it from your LAN at `http://192.168.1.145:30480`. The
dashboard should say *"Everything is saved on your server"*, and the app logs
print the data folder and how many projects it found. The image has a
health check on `/healthz`, so TrueNAS shows it as healthy.

### Updating

Push a change to `main` and wait for the Actions run to finish. Then on
TrueNAS open the app → **Edit** → **Save**. With *Always pull*, it fetches
the new `latest`. Your data in the dataset is untouched.

To pin versions instead of `latest`: `git tag v1.0.2-1 && git push --tags`
publishes `:1.0.2-1`. Use that as the tag in the wizard.

### Without GitHub (build on the NAS)

Copy this folder to the NAS, then in the TrueNAS shell run
`sudo docker build -t openshotdesigner:local /mnt/POOL/apps/openshotdesigner/src`.
In the wizard use image `openshotdesigner`, tag `local`, and pull policy
*Never pull*. Everything else stays the same.

---

## Nginx Proxy Manager + Authentik

### Authentik

1. **Applications → Providers → Create → Proxy Provider**, mode **Forward
   auth (single application)**, external host
   `https://shots.tameonet.info`.
2. **Applications → Create**: name *Open Shot Designer*, slug
   `openshotdesigner`, provider = the one above. Bind the users or groups
   allowed in, for example yourself and your photo partner.
3. **Outposts → authentik Embedded Outpost → Edit** and add the application.

### NPM proxy host

*Hosts → Proxy Hosts → Add*:

- **Domain**: `shots.tameonet.info`
- **Forward**: `http` → `192.168.1.145` → `30480`
- Block common exploits: on. Websockets: not needed.
- **SSL**: your usual certificate, *Force SSL* on.
- **Advanced → Custom Nginx configuration** (replace `AUTHENTIK` with the
  address of your Authentik server, e.g. `http://192.168.1.145:9000`):

```nginx
client_max_body_size 256m;
proxy_buffers 8 16k;
proxy_buffer_size 32k;
port_in_redirect off;

location / {
    proxy_pass          $forward_scheme://$server:$port;
    auth_request        /outpost.goauthentik.io/auth/nginx;
    error_page          401 = @goauthentik_proxy_signin;
    auth_request_set    $auth_cookie $upstream_http_set_cookie;
    add_header          Set-Cookie $auth_cookie;
}

location /outpost.goauthentik.io {
    proxy_pass              AUTHENTIK/outpost.goauthentik.io;
    proxy_set_header        Host $host;
    proxy_set_header        X-Original-URL $scheme://$http_host$request_uri;
    add_header              Set-Cookie $auth_cookie;
    auth_request_set        $auth_cookie $upstream_http_set_cookie;
    proxy_pass_request_body off;
    proxy_set_header        Content-Length "";
}

location @goauthentik_proxy_signin {
    internal;
    add_header Set-Cookie $auth_cookie;
    return 302 /outpost.goauthentik.io/start?rd=$scheme://$http_host$request_uri;
}
```

When your Authentik session expires while the app is open, saves stop and a
banner says to sign in again. Open the app in a new tab, sign in, and the
original tab resumes saving on its own; your edits stay in that tab.

### Tailscale-only instead

If you don't need it on the public internet, skip NPM and Authentik and use
`http://100.83.156.115:30480` over Tailscale. Set `AUTH_USER` /
`AUTH_PASSWORD` if other people share your tailnet.

---

## How sync behaves

- **Every edit autosaves** to the server (same 300 ms debounce as upstream).
  The top bar shows *Saving… / Saved to server / Save failed*.
- **Coming back to a tab** (focus, wake, reconnect, and every 30 s while
  visible): new and deleted projects appear on the dashboard by themselves.
  If the project you have open was changed somewhere else, you get a *Reload*
  banner, and this tab can't overwrite the newer version.
- **Viewing doesn't count as editing.** Zooming, panning, switching scenes or
  scrubbing the timeline on your phone doesn't mark the project as changed,
  so it won't trigger the banner on your laptop.
- There's no live co-editing. If you and your partner edit the *same*
  project at the *same* time, whoever saves second gets the Reload banner and
  must redo that change. To keep a copy of it first, use *Download project
  file*.

## Running without Docker

```sh
npm ci
npm run build:server
DATA_DIR=./data npm run start:server        # http://localhost:8080
```

For development, run `npx vite --mode selfhost` alongside the server and add
a Vite proxy for `/api` → `http://localhost:8080`.

## Fork notes

- Upstream's GitHub Pages deploy, release and Dependabot configs were
  removed: they would publish the browser-only build. `ci.yml` (lint +
  tests) is kept. Disable it in the Actions tab if you don't want it.
- Changes are confined to: `server/`, `src/config/storage.ts`,
  `src/domain/storage/{idb,remote,syncedLocalKeys}.ts`,
  `src/utils/projectLibrary.ts`, `src/context/useAutosave.ts`, `src/main.tsx`,
  `public/sw.js` (never caches `/api/`), a few UI labels, `Dockerfile`,
  `docker-compose.yml` and `.github/workflows/docker.yml`. To pull a new
  upstream release later: `git remote add upstream
  https://github.com/koosoli/OpenShotDesigner.git`, then
  `git fetch upstream --tags && git merge <tag>`. That keeps rebasing
  onto new upstream releases simple. License: GPL-3.0, same as upstream.
