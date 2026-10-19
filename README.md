# WebbMC

A self-hosted Minecraft server panel, in the spirit of Crafty Controller. Run Paper, Purpur, Fabric, Vanilla, Velocity and BungeeCord servers from one web page: live console, plugins and their settings, files, backups, schedules, players and ports.

- **No npm dependencies.** Just Node.js. Java is downloaded for you, in the version each server needs.
- **Runs anywhere:** Windows, Linux, macOS, Docker or Railway.
- **Multi-user:** everyone signs in with their own account and manages their own servers. You can share servers with other people.
- **Live:** changes made by anyone show up on every open page right away, without reloading.

---

## Install

You need **Node.js 20.12 or newer** (22 LTS recommended) and **Git**. That's all: no Java, no database, no `npm install`. Everything WebbMC stores goes in its `data` folder.

### Windows

**Download [WebbMC-Setup.exe](https://github.com/web-beck/WebbMC/raw/main/installer/WebbMC-Setup.exe) and double-click it.** Windows may say *"Windows protected your PC"* because the file isn't signed: choose **More info → Run anyway**.

Or open **PowerShell** (Start menu, type `powershell`) and paste this line, which does the same:

```powershell
irm https://raw.githubusercontent.com/web-beck/WebbMC/main/install-windows.ps1 | iex
```

It asks a few questions (press Enter for the default in brackets):

- **Folder** (`C:\Users\you\WebbMC`)
- **Version:** `main` (stable) or `dev`
- **Panel port** (8420)
- **Admin username**
- **Start with Windows:** whether WebbMC starts when you sign in

Then it does the rest:

1. Installs **Node.js** and **Git** with `winget` when they're missing.
2. Downloads WebbMC.
3. Creates the admin account and prints its **one-time password**.
4. Puts a **WebbMC** shortcut on your desktop.
5. Starts the panel and opens **http://localhost:8420** in your browser.

Afterwards, start WebbMC with the desktop shortcut, and stop it with **Ctrl+C** in its window, which stops every Minecraft server cleanly first. Don't close the window with the X. **Run the same line again to update.**

<details><summary>Install by hand instead</summary>

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
# close PowerShell and open a new one, then:
cd $HOME
git clone https://github.com/web-beck/WebbMC.git
cd WebbMC
node server.js
```

No `winget`? Install [Node.js](https://nodejs.org/) (LTS) and [Git](https://git-scm.com/download/win) from their websites. More in [initial-startup.md](initial-startup.md#windows).

</details>

### Linux

The installer does everything: it installs Node.js and Git when they're missing (Ubuntu, Debian, Fedora, RHEL, Arch, openSUSE), downloads WebbMC, writes your settings, creates the admin account and can keep the panel running with pm2. **WebbMC is installed into the folder the script is in**, so make a folder first:

```bash
mkdir ~/webbmc && cd ~/webbmc
curl -fsSLO https://raw.githubusercontent.com/web-beck/WebbMC/main/installer/install-linux.sh
bash install-linux.sh
```

It asks a few questions (press Enter for the default in brackets):

- **Version:** `main` (stable) or `dev` (newest features, can break)
- **Panel port** (8420)
- **Who can reach the panel:** just this machine, or other computers too
- **Admin username**
- **Google sign-in** (optional)
- **pm2:** whether to keep the panel running
- **Firewall:** whether to open the Minecraft port

It then prints the panel's address and a **one-time password** for the admin account. Run the same script again later to update. `bash install-linux.sh --help` lists options for installing without questions.

To install by hand instead (`git clone`, `node server.js`, and a systemd service), follow [initial-startup.md](initial-startup.md#manual-install).

### macOS

Install Node.js and Git (for example `brew install node git`), then follow the Windows steps from `git clone` in Terminal.

### Docker and Railway

There's a `Dockerfile` (Node.js plus Java 25, 21 and 17) and a `railway.json`. See [Deploy on Railway](#deploy-on-railway).

### First sign-in

1. **Create your account** on the sign-in page. The first account on a new panel becomes the **admin**, so do this straight away. If you used one of the installers, sign in with the one-time password it printed instead.
2. **New server:** pick the software (Paper is a good default), the Minecraft version and the RAM, accept the Minecraft EULA and press **Create server**. WebbMC downloads the server jar and the right Java.
3. **Start** it. When the console prints `Done`, join from Minecraft at `localhost`.

To let players join over the internet, use **playit.gg** (built in, no router changes; see [Networking](#networking)) or forward the server's port (25565) on your router. **Never** forward the panel's own port (8420): reach it through an SSH tunnel or a VPN instead.

### Updating

Admins see new versions under the **bell**. **Stop servers and update** pulls the update, stops the servers, restarts the panel and starts the servers that were running. From a terminal, stop the panel, run `git pull` and start it again. On Linux you can also run `bash installer/install-linux.sh` again. Your servers, worlds, backups and accounts live in `data/`, which updates never touch.

A full walkthrough with troubleshooting is in **[initial-startup.md](initial-startup.md)**.

---

## Features

### Servers

- **Create servers** from Paper, Purpur, Fabric or Vanilla (the jar is downloaded for you), a custom jar you upload, or an existing server folder you import.
- **Proxies:** create **Velocity** or **BungeeCord** servers to put several servers behind one address. Their **Properties** tab edits the servers behind the proxy:
  - add, rename and delete servers, with a one-click add for your own servers
  - the order players start in (`try` / `priorities`)
  - Velocity's forced hosts
  - every other proxy setting, with the config file's comments as help
  - the forwarding secret, ready to copy for setting up Paper

  Saving rewrites only those entries, so the file's comments stay.
- **Power controls:** start, stop (a graceful `stop`, then a kill after a timeout), restart and force-kill, from the server page, the dashboard or a right-click on the server in the sidebar.
- **Crash detection** with auto-restart (up to 3 times in 10 minutes), and optional auto-start when the panel boots.
- **Java, automatically:** each server gets the Java it needs, worked out from:
  - the Minecraft version, using Mojang's own list
  - for proxies, the class files in the jar
  - otherwise, the jar's `version.json`

  If it isn't installed, Eclipse Temurin is downloaded into `data/java`. If a server still crashes with "compiled by a more recent version of the Java Runtime", the panel reads the version it needs from that error, remembers it, switches the server to Automatic Java and starts it again.
- **Software updates** (Settings tab):
  - the installed build next to the newest one, such as *Paper 26.3 build 205* → *build 206*. For Paper and Velocity the exact build is recognised by its checksum.
  - an **Update** button
  - any newer Minecraft version, with a warning to back up first
  - switching to another version or software in place
- **Settings:**
  - name, RAM in MB or GB, Java, JVM flags (with Aikar's flags one click away) and server arguments
  - the **port**, checked against every other port on the panel
  - the **jar name**: renaming it renames the file, and new versions download under that name

### Console and monitoring

- **Live console** with colors, command history and quick commands.
- **Metrics:** CPU, memory and player charts for the last 10 minutes, plus host CPU, RAM and disk.
- **Players:** who's online, and operators, the whitelist, bans and IP bans.
- **Server status checker** for any Java or Bedrock server, like mcsrvstat.us:
  - status, players, version, MOTD and icon
  - DNS and SRV records, and Mojang's block list
  - Query data and Forge mod lists
  - favorites you can see at a glance

### Plugins, mods and their settings

- **Install from:**
  - **Modrinth** and **Hangar** (search, or paste a link), with dependencies installed for you
  - **EssentialsX** (stable or dev builds)
  - **GeyserMC** (Geyser, Floodgate, MCXboxBroadcast)
  - **GitHub** releases
  - any direct link

  Every list is filtered to the server's software and Minecraft version, and each download is checked against its checksum. The build for the server's own type is preferred, such as the Paper build of BlueMap over the Spigot one.
- **Installed:** everything in the plugins or mods folder (and datapacks) on one list, with:
  - the **server type** each file is built for
  - the **release date** of its newest version
  - whether it's the latest, with **Update** and **Update all**
  - **Switch to Paper** when a plugin is installed as the Spigot build but a Paper build exists
  - an on/off switch for each file

  Files you added yourself are recognised by their checksum.
- **Plugin config tab:** settings forms for **Geyser** (with **MCXboxBroadcast** as a section), **DiscordSRV**, **MiniMOTD**, **TAB** and **BlueMap**:
  - built from the plugin's own config file, so they keep working when the plugin renames settings
  - the file's comments shown as help
  - main settings first, then everything else in foldable sections
  - **Save** writes only what changed and keeps every comment
  - MiniMOTD's MOTDs get the full MOTD editor with a live preview

### Look in the server list

- **Server icon:** upload any picture. It's cropped or fitted to 64×64 with smooth or pixel-art scaling.
- **MOTD editor** with a live preview:
  - colors, formats, hex colors and gradients
  - centering and templates
  - a width meter that warns when a line is too long for the server list

  Saved in each server type's own format: `§` codes, `§x` hex, `&` codes or MiniMessage.

### Files and backups

- **File manager:**
  - browse, edit text files (Ctrl+S saves), and upload by dragging files in
  - download from a link, rename, and create files and folders
  - **tick several files and delete them at once**
- **server.properties editor** with toggles, drop-downs and hints.
- **Backups** as `.tar.gz`, `.tar` or `.zip`, consistent even while the server is running (`save-off` / `save-all flush`):
  - folders left out by ticking them or with rules like `*.log`
  - retention (how many to keep), download, and one-click restore
- **Schedules:** run commands, restart, start, stop or back up on an interval or at a time of day.

### Networking

- **Ports page** (admins): every port the panel and its servers use:
  - the game port, RCON, Query, and ports plugins open (BlueMap, Dynmap, Geyser, voice chat, Votifier, Plan)
  - each one **tested**: TCP by connecting, Geyser with the Bedrock ping, Query with its handshake
  - clashes between servers flagged
  - **edit any port** right there
  - grouped **by user**, **by server** or **by port**, with foldable groups
- **playit.gg tunnels:** one click downloads the official agent and a second links your account, with no port forwarding. Each tunnel is matched to its server, including **Geyser's Bedrock port**. A playit you already installed is detected and used as it is.

### Accounts, sidebar and dashboard

- **Accounts:** usernames and passwords, optional Google sign-in, approval of new accounts, one-time passwords for resets, and **sharing** a server with other accounts.
- **Live updates:** approving an account, adding a server, sharing, changing settings and so on show up on every open page within a second.
- **Sidebar:**
  - drag servers anywhere to reorder them
  - put them in **folders**: drag folders too, drag a server in or out, fold them, and start or stop everything in a folder at once
  - **right-click** a server, a folder or the list for quick actions
  - the layout follows your account to every device
- **Dashboard:** your servers as **cards** or as a **table**. The welcome banner can be folded away.
- **Notifications** (the bell): crashes, shared servers, accounts waiting for approval, and panel updates.
- **Activity log** of everything the panel does.
- **Panel updates** from GitHub, with a `main` / `dev` branch switch. An optional webhook gives instant notices.
- **.env editor** (admins): edit the panel's settings as fields or as text, then restart from the page.

---

## Configuration

Settings come from environment variables. On your own computer, put them in a file called **`.env` in this folder** (next to `server.js`): copy `.env.example`, which explains each one, and restart the panel after editing it. Admins can also edit it in **Panel settings → .env**. `.env` is ignored by git and left out of the Docker image. **On Railway, set them in the service's Variables tab** instead. Real environment variables take priority over `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | (none) | Optional Google sign-in. Leave blank for usernames and passwords only |
| `WEBMC_ADMIN_EMAILS` | (none) | Comma-separated Google emails that are always admins (needs Google sign-in) |
| `WEBMC_PUBLIC_URL` | (detected) | The address people open the panel at, such as `https://panel.example.com`. Used for Google's redirect address, and its hostname is allowed automatically |
| `WEBMC_SESSION_SECRET` | (generated) | Signs sign-in cookies. Generated once and kept in the data folder |
| `WEBMC_PORT` (or `PORT`) | `8420` | Panel port |
| `WEBMC_HOST` | `127.0.0.1` (`0.0.0.0` on Railway) | Network interface to listen on, **not** your website URL. Use `0.0.0.0` for LAN access (see [Security](#security)) |
| `WEBMC_DATA` | Railway volume, else `./data` | Where servers, backups and `panel.json` live |
| `WEBMC_ALLOWED_HOSTS` | (none) | Comma-separated hostnames allowed to reach the panel, such as `mc.example.com` |
| `GITHUB_TOKEN` | (none) | Optional. Raises GitHub's limit (60 requests an hour per IP without one) for GitHub and EssentialsX installs and update checks |
| `WEBMC_NO_SUPERVISOR` | (unset) | `1` runs the panel without its restart helper (updates then stop the panel instead of restarting it). Not needed under pm2 |
| `WEBMC_WEBHOOK_SECRET` | (none) | Turns on the GitHub push webhook at `/api/update/webhook` for instant update notices |
| `WEBMC_PLAYIT_SOCKET` | (the usual place) | Where a playit you installed yourself listens, if you start it with its own `--socket-path` |
| `WEBMC_JAVA_PATHS` | (none) | Comma-separated Java executables to offer in each server's Java field |

Everything else (panel name, default Java, default RAM, who may sign in, Java downloads) is set in **Panel settings**.

Data layout:

```
data/
  panel.json        settings, servers, schedules, activity log, accounts, favorites
  session-secret    signs sign-in cookies (keep it private)
  playit/           the playit.gg agent, its key (keep it private) and its log
  java/             Java runtimes the panel downloaded (Eclipse Temurin)
  servers/<id>/     one folder per server (worlds, plugins, configs, server-icon.png)
  backups/<id>/     backups
```

## Accounts and Google sign-in

- **The first account is the admin.** After that, admins are made in **Panel settings → Accounts** (the shield button) and by `WEBMC_ADMIN_EMAILS`.
- **Who can sign in:** *only accounts I approve* (the default) or *anyone who signs up*. You can also approve someone before they sign up, block an account, or remove it (its servers stay).
- **Usernames** are 3 to 24 letters, digits, dots, dashes and underscores. Passwords are at least 8 characters, stored as scrypt hashes. Ten wrong passwords from one network lock it out for 15 minutes.
- **Forgotten passwords:** an admin gets a **one-time password** from the key button in **Panel settings → Accounts**. Forgot the admin password? On the machine running the panel, in this folder:

  ```
  node reset-admin.js              # the admin (or creates one called "admin")
  node reset-admin.js <username>   # that account, made an admin if it is not one
  ```

- **Everyone manages their own servers**, plus servers shared with them. Admins see everyone's in **All servers**, grouped by owner, and can hand a server to someone else.

**Google sign-in** (optional, about five minutes):

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. Under **APIs & Services → OAuth consent screen**, choose **External** and set the publishing status to **In production**.
3. Under **Credentials → Create credentials → OAuth client ID**, choose **Web application**. Add the redirect URI `http://localhost:8420/auth/google/callback` (open the panel at `localhost`, not `127.0.0.1`), and/or `https://<your-domain>/auth/google/callback`. The panel prints the exact address when it starts.
4. Put the client ID and secret in `.env` and restart.

**Accounts are a convenience, not a sandbox.** Every server runs as the same operating-system user as the panel, and plugins are ordinary Java programs that can read other servers' files. Only give access to people you trust. That's why approval is the default.

## Deploy on Railway

Railway builds from the root of this repository using the `Dockerfile` (Node.js plus Java 25, 21 and 17).

1. Create a service from `web-beck/WebbMC` (or your fork). Leave **Root Directory** empty.
2. **Attach a volume** at `/data`. Without one, worlds and backups are wiped on every redeploy.
3. Add the variable `PORT=8080`, then under **Settings → Networking** generate a public domain with target port **8080**.
4. Also under Networking, add a **TCP Proxy** to port `25565`. Players connect to the address Railway shows, and the panel shows it on the server card.
5. **Create the admin account right after deploying** (the first account is the admin), or set up Google sign-in first.
6. Give the service enough memory for the panel plus each server's maximum RAM.

To build locally: `docker build -t webbmc .`

## Security

An admin can run servers, edit files and choose which Java to launch, which is effectively control of the machine. So:

- The panel listens on `127.0.0.1` by default, so only this computer can reach it. For remote access, prefer an SSH tunnel or a VPN such as Tailscale over opening the port to the internet.
- Sign-in cookies are signed, last 30 days, and stop working as soon as an admin blocks or removes the account.
- Someone else's server is answered as "not found", so people can't even tell which other servers exist.
- Requests whose `Host` header isn't localhost, an IP address or an allowed hostname are refused (this blocks DNS rebinding).
- Every request that changes something must send an `X-WebMC: 1` header, and cross-origin requests are rejected.
- Plugin config and proxy editors only write the specific config files they know. They refuse a save if the file changed since you opened it.

## Stopping the panel

Press **Ctrl+C** (or use `pm2 stop webbmc` / `systemctl stop webbmc`). WebbMC sends `stop` to every running server, waits up to 45 seconds, then exits. Killing the Node process any other way can leave Java processes running; the panel warns about them on its next start.
