# Installing WebMC

This guide takes you from a fresh Windows or Linux machine to a running WebMC panel with your first Minecraft server. It takes about 15 minutes.

- [What you need](#what-you-need)
- [Windows](#windows)
- [Linux](#linux)
- [First sign-in and first server](#first-sign-in-and-first-server)
- [Letting players connect](#letting-players-connect)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)

## What you need

- **Node.js 22 LTS or newer.** WebMC needs at least 20.12.
- **Git**, to download WebMC from [github.com/web-beck/WebbMC](https://github.com/web-beck/WebbMC) and to let the panel update itself. No GitHub account is needed.
- **tar**, which Windows 10 and later and every Linux already have.
- Enough RAM for the panel (about 100 MB) plus each Minecraft server you run (2 to 4 GB each is typical).

You do **not** need to install Java. When you create a server, WebMC downloads the Java version that Minecraft version needs (Eclipse Temurin) into `data/java`.

---

## Windows

### 1. Install Node.js and Git

Open **PowerShell** (Start menu, type `powershell`) and run:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

If `winget` is missing, download the installers instead: [nodejs.org](https://nodejs.org/) (the LTS version) and [git-scm.com](https://git-scm.com/download/win). Keep the default options.

**Close PowerShell and open a new one** so it finds the new programs, then check them:

```powershell
node --version   # v22.x.x or newer
git --version
```

### 2. Download WebMC

```powershell
cd $HOME
git clone https://github.com/web-beck/WebbMC.git
```

This creates a `WebbMC` folder in your user folder (for example `C:\Users\you\WebbMC`).

### 3. Optional: create a `.env` file

Defaults work for most people, so you can skip this step. To set up Google sign-in or change the port, copy the example file and edit it:

```powershell
cd $HOME\WebbMC
copy .env.example .env
notepad .env
```

Each setting is explained inside the file.

### 4. Start the panel

```powershell
cd $HOME\WebbMC
node server.js
```

You should see:

```
  WebMC 1.0.0 is running at http://localhost:8420
```

Open **http://localhost:8420** in your browser and continue with [First sign-in and first server](#first-sign-in-and-first-server).

> **Stopping the panel:** click the PowerShell window and press **Ctrl+C**. WebMC stops every Minecraft server cleanly, then exits. **Do not close the window with the X**: that can leave Java processes running in the background.

### 5. Optional: start WebMC when you sign in to Windows

1. Open Notepad, paste this, and save it as `start-webmc.bat` in your `WebbMC` folder (set **Save as type** to *All files*):

   ```bat
   @echo off
   title WebMC
   cd /d "%USERPROFILE%\WebbMC"
   node server.js
   pause
   ```

2. Press **Win+R**, type `shell:startup` and press Enter.
3. Right-click `start-webmc.bat` and choose **Copy**. In the Startup folder, right-click and choose **Paste shortcut**.

WebMC now opens in its own window each time you sign in. Stop it with Ctrl+C in that window.

The panel runs only while you are signed in and the PC is awake. To keep servers online, open **Settings → System → Power** and set **Sleep** to *Never* while plugged in.

---

## Linux

These commands are for **Ubuntu and Debian**. Commands for Fedora and other distributions are noted where they differ.

### 1. Install Node.js and Git

The Node.js in Ubuntu's and Debian's own repositories is often too old, so install it from NodeSource:

```bash
sudo apt update
sudo apt install -y curl git ca-certificates
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # v22.x.x or newer
```

On Fedora: `sudo dnf install -y nodejs git`. On Arch: `sudo pacman -S nodejs git`.

### 2. Download WebMC

```bash
cd ~
git clone https://github.com/web-beck/WebbMC.git
cd ~/WebbMC
```

### 3. Optional: create a `.env` file

```bash
cp .env.example .env
nano .env
```

Defaults work for most people. Each setting is explained inside the file.

### 4. Start the panel to test it

```bash
node server.js
```

When you see `WebMC 1.0.0 is running at http://localhost:8420`, open that address in a browser **on the same machine**. On a headless server, see [Opening the panel from another computer](#opening-the-panel-from-another-computer) first.

Press **Ctrl+C** to stop it. WebMC stops every Minecraft server cleanly, then exits.

### 5. Run WebMC as a service

To start WebMC at boot and keep it running after you log out, set it up as a systemd service. Create the service file:

```bash
sudo nano /etc/systemd/system/webmc.service
```

Paste this, replacing `YOUR_USER` (twice) with your Linux username (`whoami` prints it):

```ini
[Unit]
Description=WebMC Minecraft panel
After=network-online.target
Wants=network-online.target

[Service]
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/WebbMC
ExecStart=/usr/bin/node server.js
# Send the stop signal to WebMC only, so it can stop each Minecraft server cleanly (up to 45 seconds).
KillMode=mixed
TimeoutStopSec=90
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

If `which node` prints something other than `/usr/bin/node`, use that path in `ExecStart`. Then turn it on:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now webmc
systemctl status webmc          # should say "active (running)"
```

Everyday commands:

| Command | What it does |
| --- | --- |
| `sudo systemctl stop webmc` | Stops the panel and all its Minecraft servers cleanly |
| `sudo systemctl start webmc` | Starts it again |
| `sudo systemctl restart webmc` | Restarts it, for example after editing `.env` |
| `journalctl -u webmc -f` | Shows the panel's log as it runs (Ctrl+C to leave) |

Do not also run `node server.js` by hand while the service is running. Both would use the same port and data folder.

### Opening the panel from another computer

WebMC only answers on the machine it runs on (`127.0.0.1`). On a headless server, the safest way to reach it is an **SSH tunnel**. Run this on your own computer:

```bash
ssh -L 8420:localhost:8420 YOUR_USER@your-server-address
```

Leave that connection open and browse to **http://localhost:8420** on your own computer. Google sign-in also works this way, because the address is still `localhost`.

Other options:

- **A VPN** such as [Tailscale](https://tailscale.com/), which reaches the panel without exposing it to the internet.
- **Your home network:** add `WEBMC_HOST=0.0.0.0` to `.env`, restart, and open `http://<server-ip>:8420`. If you use a hostname instead of an IP address, also add it to `WEBMC_ALLOWED_HOSTS`. Allow the port in the firewall (`sudo ufw allow 8420/tcp`). Read **Security** in [README.md](README.md) first: an admin account controls the whole machine.

---

## First sign-in and first server

1. **Create your account.** On the sign-in page, choose **Create an account**. The first account on a new panel becomes the **admin**, so create yours straight away.
2. **Create a server.** Choose **New server** and pick the software (Paper is a good default), the Minecraft version and the RAM. Tick the box to agree to the **Minecraft EULA**, then press **Create server**. WebMC downloads the server jar and, if needed, the right Java. The first Java download takes a minute or two.
3. **Start it.** Press **Start**. The console shows the server starting. When it prints `Done`, the server is ready.
4. **Connect in Minecraft** from the same computer with the address `localhost`.

Other people who sign up wait for your approval by default. Approve them in **Panel settings → Accounts**, or from the bell in the top right.

**Lost the admin password?** In the `WebbMC` folder, run `node reset-admin.js`. It prints a one-time password and works whether or not the panel is running.

## Letting players connect

Players on the **same network** connect to this machine's local IP address. Find it with `ipconfig` on Windows (the *IPv4 Address* line) or `hostname -I` on Linux. Add `:port` if the server does not use the default port 25565. On Windows, a firewall prompt appears the first time a server starts: allow **Private networks**. On Linux with a firewall: `sudo ufw allow 25565/tcp` (Fedora: `sudo firewall-cmd --permanent --add-port=25565/tcp && sudo firewall-cmd --reload`).

Players **over the internet** need one of these:

- **playit.gg (easiest, no router changes).** In **Panel settings → Public address with playit.gg**, press the button to download the agent, then link your playit.gg account. Each tunnel's address appears on its server's card. This works on Windows and Linux.
- **Port forwarding.** In your router, forward TCP port `25565` (and the port of any other server) to this machine's local IP, then give players your public IP address or a domain that points to it.

Never forward the panel's port (8420) to the internet. Use an SSH tunnel or a VPN for that, as above.

## Updating

When a new version is out, admins see it under the bell in the top right. Press **Stop servers and update**: WebMC downloads the update, stops the servers, restarts and starts the servers that were running. You can also check by hand in **Panel settings → Updates → Check now**.

To update from a terminal instead, stop the panel, then:

```bash
cd ~/WebbMC      # Windows: cd $HOME\WebbMC
git pull
```

and start it again (`node server.js`, or `sudo systemctl start webmc`).

Your servers, worlds, backups and accounts are in the `data` folder, which updates never touch. Back it up before big changes.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `node` or `git` is not recognized (Windows) | Close PowerShell and open a new one after installing. If it still fails, restart Windows. |
| `node --version` shows v18 or older (Linux) | Remove the old version with `sudo apt remove nodejs`, then repeat the NodeSource step. |
| `EADDRINUSE` when starting | Something is already using port 8420, often another copy of WebMC. Stop it, or set `WEBMC_PORT=8421` in `.env`. |
| Players time out | Check the firewall and port forwarding steps above, or use playit.gg. The **Ports** page (admins) shows which ports each server uses and whether they are open. |
| Java processes left running after a crash | The panel warns about them on its next start. Stop them in Task Manager (Windows) or with `pkill java` (Linux) before starting the servers again. |

For everything else the panel can do, see [README.md](README.md).
