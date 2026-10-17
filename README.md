# WebbMC

A self-hosted Minecraft server panel in the www.webbeck.org colors, in the spirit of Crafty Controller.
No npm dependencies: just Node.js and Java. Everyone signs in with their own account and manages their own servers.

## Run it

```
git clone https://github.com/web-beck/WebbMC.git
cd WebbMC
node server.js
```

Then open http://localhost:8420. On Linux, `install-linux.sh` does it all: put it in an empty folder and run `bash install-linux.sh`. It asks for the version (main or dev), port, admin account and email, then installs WebbMC there and can keep it running with pm2 (run it again to update). For a full walkthrough on Windows or Linux, see [initial-startup.md](initial-startup.md).

Requirements:

- **Node.js 20 or newer**
- **tar**, which ships with Windows 10 and later, Linux and macOS (used for backups and Java downloads)

Java does not need to be installed. Each server uses the Java its Minecraft version needs (17 for 1.17 to 1.20.4, 21 for 1.20.5 to 1.21.x, 25 for 26.x): an installed one when it matches, otherwise the panel downloads Eclipse Temurin into `data/java` while it sets the server up. Turn this off in **Panel settings**, or pick a Java yourself in a server's **Settings**.

## Features

- **Create servers** from Paper, Purpur, Fabric or Vanilla (the jar is downloaded for you), from a custom jar you upload, or by importing an existing server folder.
- **Proxies**: create **Velocity** or **BungeeCord** servers to link several servers behind one address. WebbMC writes their first config with the port you pick (Velocity's own default config, comments included), stops them with the right command, counts players through them, and finds Velocity and BungeeCord plugins on Modrinth, Hangar and GitHub. The Properties tab shows how to add the servers behind the proxy and set up player forwarding, with each of your servers' local address ready to copy.
- **Power controls**: start, stop (graceful `stop`, then a kill after a timeout), restart and force-kill.
- **Live console** streamed over Server-Sent Events, with ANSI and `§` color codes, command history and quick commands.
- **Crash detection** with auto-restart (up to 3 times in 10 minutes), plus optional auto-start when the panel boots.
- **Metrics**: CPU, memory and player charts for the last 10 minutes, plus host CPU, RAM and disk.
- **Players**: who is online, and management of operators, the whitelist, bans and IP bans.
- **Plugins, mods and datapacks** from several sources, each filtered to the server's software and Minecraft version:
  - **Modrinth** and **Hangar** (PaperMC's plugin site): search in the panel or paste a project link. WebbMC picks the newest matching build, checks it against the site's checksum, and installs required dependencies (for example Fabric API, or ViaVersion for ViaBackwards).
  - **EssentialsX**: every module of the latest stable release or dev build, the same files as [essentialsx.net/downloads](https://essentialsx.net/downloads). Installed modules show an **Update** button, and **Update all** updates every module that is behind.
  - **GitHub**: the newest release of any repository. When a release has several jars, WebbMC suggests the one for your server and lets you pick.
  - **Any direct link** to a `.jar`.

  The **Installed** tab lists everything in the plugins/mods folder (and datapacks) and says whether each one is the latest build for the server's version or has an update, with **Update** and **Update all** buttons. Files WebbMC installed are checked where they came from; files you added yourself are recognised by their checksum when they are on Modrinth (updating one replaces the old file and keeps it disabled if it was).

  Updating or reinstalling a project replaces its old jar. Datapacks go into `<world>/datapacks`, and Vanilla servers get datapacks only. Each file can be switched on or off, which renames it to `.disabled`.
- **Server list look** (Properties tab, above the server.properties editor), with a live preview of the entry in Minecraft's multiplayer list:
  - **Server icon**: upload any picture (PNG, JPG, GIF, WebP, SVG...). It is cropped or fitted to 64x64 in the browser, with smooth or pixel-art scaling, and saved as `server-icon.png`.
  - **MOTD editor**: color swatches, bold/italic/underline/strikethrough/obfuscated, hex colors, gradients (two or three colors), centering, templates, and a width meter that warns when a line is too long for the server list. You write `&` codes (`&#rrggbb` for hex) and WebbMC saves them in the server's own format: `§` codes in server.properties (Vanilla and Fabric get the nearest of the 16 colors, since they cannot show hex), `§x` hex for Paper/Purpur/Spigot 1.16+, `&` codes in BungeeCord's config.yml, and MiniMessage in Velocity's velocity.toml. Custom and imported servers are recognised by their files.
- **Server status checker** for any Java or Bedrock server, like mcsrvstat.us and mcstatus.io: online status, latency, players (with names when the server shares them), version and protocol, MOTD with colors, icon, SRV record, DNS records (A, AAAA, CNAME, SRV, MX, NS, TXT, CAA, SOA), reverse DNS, Mojang's block list, Query data (plugins, map, software) when `enable-query` is on, Forge mod lists, and the raw response. Save servers as favorites to see their status at a glance. Links like `#/status/java/play.example.com` can be bookmarked.
- **File manager**: browse, edit text files (Ctrl+S saves), upload (drag and drop), download from a link, rename, delete, and create files and folders.
- **server.properties editor** with toggles, dropdowns and hints for the common keys.
- **Backups** as `.tar.gz` (smallest), `.tar` (fastest) or `.zip` (opens anywhere), chosen per server. When the server is online it runs `save-off` and `save-all flush` first so the copy is consistent. **Leave folders out** by ticking them (with their sizes) or with rules like `*.log` or `plugins/dynmap/web`; restoring a backup keeps the folders you leave out as they are. Includes retention, download and one-click restore.
- **playit.gg tunnels** (Panel settings, when the panel runs on your own Windows or Linux computer): one click downloads the official playit agent (checked against its published SHA-256) and runs it with the panel, a second links your playit.gg account, and each tunnel's address appears on the server it points to. No port forwarding needed. On Railway, use its TCP proxy instead.
- **RAM in MB or GB**: every memory field has an MB/GB switch, and the panel remembers your choice.
- **Schedules**: run commands, restart, start, stop or back up on an interval or at a time of day.
- **Change version or software** of an existing server in place.
- **Activity log** of everything the panel does.
- **.env editor** (admins, Panel settings → .env): edit the panel's settings file as fields or as text, then restart from the page to apply them.
- **Sharing**: a server's owner can share it with other accounts in the server's **Settings** tab. People it is shared with can run and change it like the owner, but cannot delete it or change who it is shared with. Shared servers show a "Shared by" badge.
- **Notification center** (the bell in the top right): crashes and failures on the servers you can see, and servers shared with you. Admins also see panel updates and accounts waiting for approval.
- **Panel updates**: the panel checks for a new version every 6 hours (or on **Check now** in **Panel settings → Updates**) and tells admins through the bell. In a git checkout, **Stop servers and update** runs `git pull`, stops every server, restarts the panel and starts the servers that were running. If the pull fails, nothing is stopped. The same card has a **Branch** picker to switch between `main` (stable) and `dev` (development), or any other branch that has the panel. Switching warns first (development can be broken; going back to stable can mean an older version), then stops the servers and restarts on the new branch. It refuses when the folder has local edits to tracked files. On Railway the panel compares its commit with GitHub, and Railway deploys new commits itself; pick the branch in Railway's service settings instead.
- **Ports** (admins, sidebar): every port the panel and its servers use, with the game port, RCON and Query, and the ports plugins and mods open (BlueMap, Dynmap, Geyser, Simple Voice Chat, Votifier, Plan). Each TCP port is tried on this machine, so the list shows which ports are open, free, or taken by another program, and flags clashes between servers.

## Configuration

Settings come from environment variables. On your own computer, put them in a file called **`.env` in this folder** (next to `server.js`): copy `.env.example`, which explains each one, and restart the panel after editing it. Admins can also edit it in the panel: **Panel settings → .env** shows every variable as a field (secrets hidden until you press Show) or the whole file as text, keeps the file's comments, warns before changes that can lock you out (port, listen address, data folder), and has a **Restart now** button to apply them. `.env` is ignored by git and left out of the Docker image. **On Railway, set them in the service's Variables tab** instead. Real environment variables take priority over `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | (none) | Optional Google sign-in. Leave blank for username and password only (see below) |
| `WEBMC_ADMIN_EMAILS` | (none) | Comma-separated Google emails that are always admins (needs Google sign-in) |
| `WEBMC_PUBLIC_URL` | (detected) | The address people open the panel at, such as `https://panel.example.com`. Used for Google's redirect address, and its hostname is allowed automatically |
| `WEBMC_SESSION_SECRET` | (generated) | Signs sign-in cookies. Generated once and kept in the data folder, so you rarely need it |
| `WEBMC_PORT` (or `PORT`) | `8420` | Panel port |
| `WEBMC_HOST` | `127.0.0.1` (`0.0.0.0` on Railway) | Network interface to listen on, **not** your website URL. Use `0.0.0.0` for LAN access (see Security). Leave it unset on Railway |
| `WEBMC_DATA` | Railway volume, else `./data` | Where servers, backups and `panel.json` live |
| `WEBMC_ALLOWED_HOSTS` | (none) | Comma-separated hostnames allowed to reach the panel, e.g. `mc.example.com`. The Railway domain and the `WEBMC_PUBLIC_URL` hostname are added automatically |
| `GITHUB_TOKEN` | (none) | Optional GitHub token for installing from GitHub and EssentialsX stable, and for update checks on Railway from a private fork. Without one, GitHub allows 60 requests an hour per IP, which is plenty for normal use |
| `WEBMC_NO_SUPERVISOR` | (unset) | Set to `1` to run the panel without its restart helper. In a git checkout, `node server.js` normally runs the panel as a child process so **Stop servers and update** can restart it; with this set, the panel stops after updating instead. Not needed under pm2, which the panel detects and lets restart it |
| `WEBMC_JAVA_PATHS` | (none) | Comma-separated Java executables to offer in each server's Java field. The Docker image sets this to its Java 25, 21 and 17 |

Everything else (panel name, default Java path, default RAM, who may sign in) is set in **Panel settings**.

Data layout:

```
data/
  panel.json        settings, servers, schedules, activity log, accounts, status-checker favorites
  session-secret    signs sign-in cookies (keep it private)
  playit/           the playit.gg agent, its key (playit.toml, keep it private) and its log
  password-resets.json  one-time passwords from reset-admin.js, waiting for the panel to pick them up
  java/             Java runtimes the panel downloaded (Eclipse Temurin)
  servers/<id>/     one folder per server (worlds, plugins, configs, server-icon.png)
  backups/<id>/     .tar.gz backups
```

Each server folder also has a `.webmc-addons.json` that remembers where every plugin or mod came from, so reinstalling or updating it replaces the old file.

## Accounts and Google sign-in

The panel always has a sign-in page. People **create an account with a username and password** there. When `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set they can also **sign in with Google**; when those are blank, the Google button is hidden.

- **The first account is the admin.** On a new panel (no admin yet) the first account created, by username or Google, becomes the admin. After that, admins come from **Panel settings → Accounts** (the shield button) and from `WEBMC_ADMIN_EMAILS` (Google emails that are always admins).
- **Usernames** are 3 to 24 letters, digits, dots, dashes and underscores. Passwords are at least 8 characters, stored as scrypt hashes. Ten wrong passwords from one network lock it out for 15 minutes.
- **The Account page** (sidebar, or click your name) is where people change their display name, username and password, link or unlink a Google account, and sign out other browsers. A Google account can add a username and password; Google can only be unlinked when the account has a password, so nobody locks themselves out.
- **Forgotten passwords.** An admin presses the key button next to the account in **Panel settings → Accounts** and gets a **one-time password** to pass on. It works once, for 24 hours. Signing in with it asks for a new password straight away.
- **Forgot the admin password?** In a terminal on the machine running the panel, in this folder, run:

  ```
  node reset-admin.js              # the admin account (or creates one called "admin" if there is none)
  node reset-admin.js <username>   # that account, made an admin if it is not one
  ```

  It prints a one-time password. It works whether or not the panel is running. On Railway, open a shell into the service (`railway ssh`), then run it in `/app`.
- **Everyone manages their own servers.** People see, create, change and delete only servers they own, plus servers shared with them (they can run and change those, not delete them or re-share them). Schedules, the activity log and status-checker favorites are per account too.
- **Admins** see and manage every server. The sidebar and dashboard show the admin's own servers; **All servers** shows everyone's, grouped by owner. Admins can create a server for someone else or hand one over (the **Owner** field), and see a badge on **Panel settings** when someone is waiting for approval. Servers without an owner belong to the admins.
- **Who can sign in** is set in **Panel settings → Accounts**: either *only accounts I approve* (the default; newcomers see "waiting for approval" until you approve them) or *anyone who signs up*. You can also approve an email or a username before that person signs up, block an account, or remove it. Removing an account keeps its servers.
- Only admins can import a folder from the host, use a Java executable that is not in the list, or change panel settings, because those reach outside a server's own folder.

Setting up Google sign-in (optional, once, about five minutes):

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project (or reuse one).
2. **APIs & Services → OAuth consent screen** (also called *Google Auth Platform*): choose **External**, fill in the app name and your email. The scopes WebbMC asks for (`openid`, `email`, `profile`) need no review. Set the publishing status to **In production**, otherwise only the test users you list can sign in.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web application**. Under **Authorized redirect URIs** add:
   - `http://localhost:8420/auth/google/callback` for running on your computer (open the panel at `localhost`, not `127.0.0.1`), and
   - `https://<your-railway-domain>/auth/google/callback` for Railway.

   The panel prints the exact address to use when it starts.
4. Put the client ID and secret into `.env` (or Railway's Variables) with your admin email, and restart.

**Accounts are a convenience, not a sandbox.** Every server runs as the same operating-system user as the panel, and plugins and mods are ordinary Java programs. A malicious plugin on one person's server could read other servers' files or the panel's data. Only give access to people you trust. That is why approval is the default.

## Deploy on Railway

Railway builds from the root of this repository. `railway.json` points it at the `Dockerfile` (Node.js plus Java 25, 21 and 17) and sets the healthcheck, restart policy and 60 seconds to stop servers cleanly on redeploy. `.dockerignore` keeps `data`, `.env` and the docs out of the image. To build locally: `docker build -t webbmc .`

1. Create a Railway service from the `web-beck/WebbMC` repository (or your fork). Leave **Root Directory** empty.
2. **Attach a volume** with mount path `/data` (avoid `/root`, the container's home folder). WebbMC stores everything there automatically. Without a volume, worlds and backups are wiped on every redeploy. Railway's Hobby volumes start at 5 GB, so keep the backup count modest.
3. Add the variable `PORT=8080`, then under **Settings → Networking** generate a public domain with target port **8080**. Keep the panel off 25565, which Minecraft needs. The domain is added to the allowed hosts automatically.
4. Also under Networking, add a **TCP Proxy** pointing at port `25565`. Players connect to the address Railway shows (like `shuttle.proxy.rlwy.net:15140`). The panel detects it and shows it on the server card. For any other server ports, type their proxy address into that server's **Settings → Address for players**.
5. **Set up sign-in.** A Railway domain is public, and without a login anyone who finds the URL controls the container. Add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `WEBMC_ADMIN_EMAILS` (see *Accounts and Google sign-in*), with `https://<your-railway-domain>/auth/google/callback` as a redirect URI. Or skip Google and create the admin account (the first account) on the sign-in page right after deploying.
6. Give the service enough memory for the panel plus each server's maximum RAM. Memory figures in the panel reflect the container's limit.

The image ships Java 25, 21 and 17 (`/opt/java/<version>/bin/java`), and servers on Automatic pick the matching one. Only older Minecraft versions, which need Java 8, download theirs into the volume.

## Security

An admin can run servers, edit files and choose which Java executable to launch, which is effectively control of the machine. So:

- The panel listens on `127.0.0.1` by default, so only this computer can reach it.
- On a new panel the first account created becomes the admin, so on a public deployment such as Railway, create yours right after deploying.
- Sign-in cookies are signed with a secret in the data folder, last 30 days, and stop working as soon as an admin blocks or removes the account.
- Someone else's server is answered as "not found", so people cannot even tell which other servers exist.
- If you need remote access, prefer a VPN such as Tailscale or WireGuard over opening the port to the internet.
- Requests whose `Host` header is not localhost, an IP address or an allowed hostname are refused. This blocks DNS-rebinding attacks.
- Every request that changes something must send an `X-WebMC: 1` header, and cross-origin requests are rejected. This stops other websites you visit from controlling the panel through your browser.

## Stopping the panel

Press **Ctrl+C** (or let Railway send SIGTERM on redeploy). WebbMC sends `stop` to every running server, waits up to 45 seconds, and then exits.
Killing the Node process any other way can leave Java processes running. The panel warns about them on its next start.
