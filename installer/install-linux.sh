#!/usr/bin/env bash
# WebbMC installer for Linux.
#
# WebbMC is installed into the folder this file is in. Make a folder, put this file in it, and run it:
#
#   mkdir ~/webbmc && cd ~/webbmc
#   curl -fsSLO https://raw.githubusercontent.com/web-beck/WebbMC/main/installer/install-linux.sh
#   bash install-linux.sh
#
# In a WebbMC folder it lives in installer/: run from there, it updates the WebbMC folder above it.
#
# (On a desktop you can also double-click it: it opens a terminal.) It asks a few questions first (version, port, admin
# account, Google sign-in, pm2), then installs Node.js and Git when they are missing, downloads WebbMC next to itself,
# writes .env, creates the admin account and, if you want, keeps WebbMC running with pm2 so it starts at boot.
# Run it again later to update WebbMC. "bash install-linux.sh --help" lists the options for unattended installs.

# Everything runs inside main() so bash reads the whole file first: the download step replaces this file with the
# copy from the repository.
main() {
  set -euo pipefail

  local script_path=$1
  shift
  local orig_args=("$@")

  # ---- Options (each one also pre-fills the matching question) ----------------------------------------------
  local REPO=https://github.com/web-beck/WebbMC.git
  local BRANCH='' PORT='' LAN='' URL='' ADMIN='' EMAILS='' PM2='' NAME=webbmc FIREWALL='' ASSUME_YES=0

  usage() {
    cat <<EOF
Installs or updates WebbMC in the folder this script is in. Without options it asks its questions in the terminal.

Usage: bash install-linux.sh [options]

  -y, --yes             Do not ask anything: use the options below, or the defaults.
  --branch main|dev     Version to install: main (stable, the default) or dev (development).
  --port N              Port for the WebbMC web app (default 8420).
  --lan                 Let other computers open the panel (listens on every network interface).
  --url URL             The web address people open the panel at, such as https://mc.example.com.
  --admin NAME          Admin username (default admin). Gets a one-time password on a new install.
  --admin-email EMAILS  Google emails that are always admins (comma-separated; needs Google sign-in).
  --pm2 / --no-pm2      Keep WebbMC running with pm2 (the default), or not.
  --name NAME           pm2 app name (default webbmc). Use another one for a second install.
  --open-firewall       Open the Minecraft port (and the panel port with --lan) in ufw or firewalld.
  --repo URL            Git repository to install from (default $REPO).
  -h, --help            Show this help.

Google sign-in keys are read from GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment when set.
EOF
  }

  while (($#)); do
    case $1 in
      -y | --yes) ASSUME_YES=1 ;;
      --branch) BRANCH=${2:-}; shift ;;
      --branch=*) BRANCH=${1#*=} ;;
      --port) PORT=${2:-}; shift ;;
      --port=*) PORT=${1#*=} ;;
      --lan) LAN=1 ;;
      --url) URL=${2:-}; shift ;;
      --url=*) URL=${1#*=} ;;
      --admin) ADMIN=${2:-}; shift ;;
      --admin=*) ADMIN=${1#*=} ;;
      --admin-email) EMAILS=${2:-}; shift ;;
      --admin-email=*) EMAILS=${1#*=} ;;
      --pm2) PM2=1 ;;
      --no-pm2) PM2=0 ;;
      --name) NAME=${2:-}; shift ;;
      --name=*) NAME=${1#*=} ;;
      --open-firewall) FIREWALL=1 ;;
      --repo) REPO=${2:-}; shift ;;
      --repo=*) REPO=${1#*=} ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; printf '\nUnknown option: %s\n' "$1" >&2; exit 1 ;;
    esac
    shift
  done

  # ---- A terminal to ask in -----------------------------------------------------------------------------------
  # Double-clicked in a file manager there is no terminal, so open one and run this script again inside it.
  if ! { : </dev/tty; } 2>/dev/null && ((!ASSUME_YES)) && [[ -z ${WEBBMC_IN_TERMINAL:-} && -n ${DISPLAY:-}${WAYLAND_DISPLAY:-} && -f $script_path ]]; then
    export WEBBMC_IN_TERMINAL=1
    local t args=(bash "$script_path" ${orig_args[@]+"${orig_args[@]}"})
    for t in gnome-terminal konsole xfce4-terminal mate-terminal tilix kitty alacritty x-terminal-emulator xterm; do
      command -v "$t" >/dev/null || continue
      case $t in
        gnome-terminal) exec gnome-terminal -- "${args[@]}" ;;
        xfce4-terminal | mate-terminal) exec "$t" -x "${args[@]}" ;;
        kitty) exec kitty "${args[@]}" ;;
        *) exec "$t" -e "${args[@]}" ;;
      esac
    done
  fi
  local INTERACTIVE=0
  if ((!ASSUME_YES)) && { : </dev/tty; } 2>/dev/null; then INTERACTIVE=1; fi
  # Opened in a new window: keep it open at the end so the result (and the admin password) can be read.
  if [[ -n ${WEBBMC_IN_TERMINAL:-} ]] && ((INTERACTIVE)); then
    trap 'printf "\nPress Enter to close this window. "; read -r _ </dev/tty || true' EXIT
  fi

  if [[ -t 1 ]]; then
    local B=$'\033[1m' D=$'\033[2m' G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' N=$'\033[0m'
  else
    local B='' D='' G='' Y='' R='' N=''
  fi
  say() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$*" "$N"; }
  warn() { printf '  %sWarning:%s %s\n' "$Y" "$N" "$*" >&2; }
  die() {
    printf '\n%sError:%s %s\n' "$R" "$N" "$*" >&2
    exit 1
  }
  heading() { printf '\n%s%s%s\n' "$B" "$*" "$N"; }
  note() { printf '  %s%s%s\n' "$D" "$*" "$N"; }

  # ask VAR "Question" [default]: a line of text (the default when Enter is pressed or nobody is asking).
  ask() {
    local ans=''
    if ((INTERACTIVE)); then
      read -r -p "  $2${3:+ [$3]}: " ans </dev/tty || true
    fi
    printf -v "$1" '%s' "${ans:-${3:-}}"
  }
  # ask_secret VAR "Question": like ask, but the typing is hidden.
  ask_secret() {
    local ans=''
    if ((INTERACTIVE)); then
      read -r -s -p "  $2: " ans </dev/tty || true
      printf '\n' >/dev/tty
    fi
    printf -v "$1" '%s' "$ans"
  }
  # yes_no VAR "Question" y|n: sets VAR to 1 or 0.
  yes_no() {
    local ans='' def=$3
    if ((INTERACTIVE)); then
      while :; do
        read -r -p "  $2 [$([[ $def == y ]] && echo Y/n || echo y/N)]: " ans </dev/tty || true
        ans=$(printf '%s' "${ans:-$def}" | tr '[:upper:]' '[:lower:]')
        [[ $ans == y || $ans == yes || $ans == n || $ans == no ]] && break
        echo "  Type y or n."
      done
    else
      ans=$def
    fi
    if [[ $ans == y* ]]; then printf -v "$1" 1; else printf -v "$1" 0; fi
  }

  [[ $(uname -s) == Linux ]] || die "This installer is for Linux. On Windows, use install-windows.ps1 (see README.md)."

  # ---- Where and as whom ----------------------------------------------------------------------------------
  local DIR SELF=''
  if [[ -n $script_path && -f $script_path ]]; then
    DIR=$(cd "$(dirname "$script_path")" && pwd -P)
    SELF=$(basename "$script_path")
  else
    DIR=$(pwd -P) # piped into bash: the current folder
  fi
  # The copy in a WebbMC folder's installer/: WebbMC is the folder above.
  if [[ $(basename "$DIR") == installer && -f $DIR/../server.js ]]; then
    DIR=$(cd "$DIR/.." && pwd -P)
    SELF=''
  fi
  # WebbMC runs as you, or when this runs as root, as the owner of the folder.
  local RUN_USER RUN_HOME
  if ((EUID == 0)); then RUN_USER=$(stat -c %U "$DIR"); else RUN_USER=$(id -un); fi
  RUN_HOME=$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6) || true
  RUN_HOME=${RUN_HOME:-$HOME}
  ((EUID == 0)) || [[ -w $DIR ]] || die "You cannot write to $DIR. Put the script in a folder you own."
  as_user() {
    if [[ $(id -un) == "$RUN_USER" ]]; then "$@"; else runuser -u "$RUN_USER" -- env HOME="$RUN_HOME" "$@"; fi
  }
  as_root() {
    if ((EUID == 0)); then
      "$@"
    else
      command -v sudo >/dev/null || die "This step needs root, and sudo is not installed. Run the script as root instead."
      sudo "$@"
    fi
  }
  g() { as_user git -C "$DIR" "$@"; } # git in the install folder, as its owner (git refuses other owners' folders)

  local FRESH=1
  [[ -d $DIR/.git ]] && FRESH=0
  if ((FRESH)); then
    printf '\n%sWebbMC installer%s\n' "$B" "$N"
  else
    [[ -f $DIR/server.js && -f $DIR/lib/manager.js ]] || die "$DIR is a git repository, but not WebbMC. Put the script in an empty folder."
    printf '\n%sWebbMC is already installed here, so this updates it.%s\n' "$B" "$N"
  fi
  note "Folder:  $DIR"
  note "Runs as: $RUN_USER"
  if [[ $RUN_USER == root ]]; then
    warn "WebbMC will run as root, which gives every Minecraft plugin full control of this machine."
    warn "Safer: create a normal user, put this script in a folder they own, and run it as that user."
  fi

  # ---- Questions (a new install) ----------------------------------------------------------------------------
  local ADMIN_DEFAULT=${ADMIN:-admin} G_ID=${GOOGLE_CLIENT_ID:-} G_SECRET=${GOOGLE_CLIENT_SECRET:-} OPEN_FW=0 FW='' START_NOW=0
  local fw_port_note=''
  if command -v ufw >/dev/null && grep -qs '^ENABLED=yes' /etc/ufw/ufw.conf; then
    FW=ufw
  elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    FW=firewalld
  fi
  local valid_port='^[0-9]+$'

  if ((FRESH)); then
    ((INTERACTIVE)) && note "Press Enter to accept the answer in [brackets]."

    # 1. Version. Branches that do not have WebbMC yet are not offered.
    local raw='' has_main=1 has_dev=1
    if [[ $REPO =~ ^https://github\.com/([^/]+)/([^/]+)$ ]] && command -v curl >/dev/null; then
      raw="https://raw.githubusercontent.com/${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}"
      curl -fsIL -o /dev/null --max-time 15 "$raw/main/server.js" || has_main=0
      curl -fsIL -o /dev/null --max-time 15 "$raw/dev/server.js" || has_dev=0
      ((has_main || has_dev)) || die "Could not reach $REPO, or neither main nor dev has WebbMC in it yet."
    fi
    if [[ -z $BRANCH ]]; then
      heading "1. Which version?"
      echo "   1) main   stable, recommended$( ((has_main)) || echo "  ${Y}(not published yet)${N}")"
      echo "   2) dev    development: the newest features first, but things can break"
      local pick def=1
      ((has_main)) || def=2
      while :; do
        ask pick "Choose 1 or 2" "$def"
        case $pick in
          1 | main) BRANCH=main ;;
          2 | dev) BRANCH=dev ;;
          *) echo "  Type 1 or 2." && continue ;;
        esac
        if [[ $BRANCH == main ]] && ((!has_main)); then echo "  main does not have WebbMC yet. Choose dev." && continue; fi
        if [[ $BRANCH == dev ]] && ((INTERACTIVE)); then
          warn "dev gets changes before they are finished and tested. Parts of the panel can break, and in the worst case data can be lost."
          note "You can switch to main later in Panel settings > Updates."
          local ok
          yes_no ok "Install dev anyway?" n
          ((ok)) || continue
        fi
        break
      done
    fi

    # 2. Port.
    if [[ -z $PORT ]]; then
      heading "2. Web app port"
      note "The port you open the WebbMC web app on, as in http://localhost:8420. Minecraft players use other ports (25565 and up)."
      while :; do
        ask PORT "Which port should the web app use?" 8420
        local why=''
        if ! [[ $PORT =~ $valid_port ]] || ((PORT < 1 || PORT > 65535)); then
          why="Type a number from 1 to 65535."
        elif ((PORT == 25565)); then
          why="25565 is Minecraft's port. Pick another, such as 8420."
        elif (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
          why="Something on this machine already uses port $PORT. Pick another."
        fi
        [[ -z $why ]] && break
        ((INTERACTIVE)) || die "$why Use --port."
        echo "  $why"
      done
    fi
    [[ $PORT =~ $valid_port ]] && ((PORT >= 1 && PORT <= 65535)) || die "--port must be a number from 1 to 65535"

    # 3. Who can open it.
    if [[ -z $LAN ]]; then
      heading "3. Who can open the panel?"
      echo "   1) Only this machine    safest. Reach it from elsewhere through an SSH tunnel or a reverse proxy (nginx)"
      echo "   2) Other computers too  on your network, or the internet if this port is open"
      local who
      while :; do
        ask who "Choose 1 or 2" 1
        case $who in 1) LAN=0 ;; 2) LAN=1 ;; *) echo "  Type 1 or 2." && continue ;; esac
        break
      done
    fi
    ((LAN)) && note "Anyone who can reach port $PORT sees the sign-in page. Use strong passwords."

    # 4. Web address.
    if [[ -z $URL ]]; then
      heading "4. Web address (optional)"
      note "If people open the panel through a domain, such as https://mc.example.com, type it. Otherwise press Enter."
      while :; do
        ask URL "Web address" ''
        URL=${URL%/}
        [[ -z $URL || $URL =~ ^https?://[^/[:space:]]+$ ]] && break
        echo "  Type it like https://mc.example.com (no path), or press Enter to skip."
      done
    fi

    URL=${URL%/}
    [[ -z $URL || $URL =~ ^https?://[^/[:space:]]+$ ]] || die "--url must look like https://mc.example.com (no path)"

    # 5. Admin account.
    heading "5. Admin account"
    note "You get a one-time password for it at the end, and choose your own password when you first sign in."
    while :; do
      ask ADMIN "Admin username" "$ADMIN_DEFAULT"
      [[ $ADMIN =~ ^[A-Za-z0-9_.-]{3,24}$ ]] && break
      echo "  3 to 24 letters, digits, dots, dashes or underscores."
      ((INTERACTIVE)) || die "--admin must be 3 to 24 letters, digits, dots, dashes or underscores"
    done

    # 6. Admin email and Google sign-in.
    if [[ -z $EMAILS ]]; then
      heading "6. Admin email (optional)"
      note "Google accounts with these emails are always admins. Leave empty to use only usernames and passwords."
      while :; do
        ask EMAILS "Admin email(s), comma-separated" ''
        EMAILS=$(printf '%s' "$EMAILS" | tr -d '[:space:]')
        [[ -z $EMAILS || $EMAILS =~ ^[^@,]+@[^@,]+\.[^@,]+(,[^@,]+@[^@,]+\.[^@,]+)*$ ]] && break
        echo "  That does not look like an email address."
      done
    fi
    if [[ -n $EMAILS && -z $G_ID ]] && ((INTERACTIVE)); then
      note "Admin emails need Google sign-in. Create a Web application OAuth client at"
      note "https://console.cloud.google.com/apis/credentials with this redirect URI:"
      note "  ${URL:-http://localhost:$PORT}/auth/google/callback"
      note "Press Enter to skip; you can add both to .env later."
      ask G_ID "Google client ID" ''
      [[ -n $G_ID ]] && ask_secret G_SECRET "Google client secret (hidden)"
      [[ -n $G_ID && -n $G_SECRET ]] || { G_ID='' && G_SECRET=''; }
    fi

    # 7. pm2.
    if [[ -z $PM2 ]]; then
      heading "7. Keep it running"
      note "pm2 runs WebbMC in the background, starts it when the machine boots and restarts it after a crash."
      command -v pm2 >/dev/null || note "pm2 is not installed yet, so it will be installed (with npm)."
      yes_no PM2 "Run WebbMC with pm2?" y
    fi

    # 8. Firewall.
    if [[ -n $FW ]]; then
      fw_port_note=25565
      ((LAN)) && fw_port_note+=" and $PORT"
      if [[ -n $FIREWALL ]]; then
        OPEN_FW=1
      else
        heading "8. Firewall"
        note "The $FW firewall is on. Players can only join when the Minecraft port is open."
        yes_no OPEN_FW "Open port $fw_port_note (TCP) in $FW?" y
      fi
    fi

    # Summary.
    heading "Ready to install"
    printf '  %-16s %s\n' "Folder" "$DIR" "Version" "$BRANCH" "Web app port" "$PORT" \
      "Reachable from" "$( ((LAN)) && echo 'other computers too' || echo 'this machine only')" \
      "Web address" "${URL:-none}" "Admin" "$ADMIN" "Admin emails" "${EMAILS:-none}" \
      "Google sign-in" "$([[ -n $G_ID ]] && echo on || echo off)" "pm2" "$( ((PM2)) && echo "yes, as \"$NAME\"" || echo no)"
    [[ -n $FW ]] && printf '  %-16s %s\n' "Firewall" "$( ((OPEN_FW)) && echo "open $fw_port_note" || echo 'leave as is')"
    local go
    yes_no go "Install WebbMC now?" y
    ((go)) || die "Nothing was installed."
  else
    PM2=${PM2:-}
  fi

  # ---- Packages ---------------------------------------------------------------------------------------------
  local PM='' p
  for p in apt-get dnf yum pacman zypper apk; do
    if command -v "$p" >/dev/null; then PM=$p && break; fi
  done
  local apt_updated=0
  install_pkgs() {
    case $PM in
      apt-get)
        if ((!apt_updated)); then as_root apt-get update -q && apt_updated=1; fi
        as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@"
        ;;
      dnf | yum) as_root "$PM" install -y "$@" ;;
      pacman) as_root pacman -S --needed --noconfirm "$@" ;;
      zypper) as_root zypper --non-interactive install "$@" ;;
      apk) as_root apk add --no-cache "$@" ;;
      *) die "Could not find a package manager. Install $* yourself, then run this again." ;;
    esac
  }
  node_ok() {
    command -v node >/dev/null &&
      node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 12) ? 0 : 1)' 2>/dev/null
  }

  local missing=() c
  for c in git tar curl; do command -v "$c" >/dev/null || missing+=("$c"); done
  if ((${#missing[@]})); then
    say "Installing ${missing[*]}"
    [[ $PM == apt-get ]] && missing+=(ca-certificates)
    install_pkgs "${missing[@]}"
  fi
  if ! node_ok; then
    say "Installing Node.js (LTS)"
    local setup
    case $PM in
      apt-get | dnf | yum)
        # NodeSource, because many distributions ship a Node.js that is too old.
        setup=$(mktemp)
        curl -fsSL "https://$([[ $PM == apt-get ]] && echo deb || echo rpm).nodesource.com/setup_lts.x" -o "$setup"
        as_root bash "$setup"
        rm -f "$setup"
        install_pkgs nodejs
        ;;
      *) install_pkgs nodejs ;;
    esac
    hash -r
    node_ok || die "Node.js $(node --version 2>/dev/null || echo 'is missing and') is too old. WebbMC needs 20.12 or newer: install Node.js 22 LTS from https://nodejs.org, then run this again."
  fi
  note "Node.js $(node --version), $(git --version)"

  # ---- WebbMC's files ---------------------------------------------------------------------------------------
  local code_changed=0
  if ((!FRESH)); then
    say "Updating WebbMC"
    local before after
    before=$(g rev-parse HEAD)
    g pull --ff-only -q || die "git pull failed. If you edited WebbMC's files, set them aside with \"git -C '$DIR' stash\", then run this again."
    after=$(g rev-parse HEAD)
    if [[ $before != "$after" ]]; then
      code_changed=1
      g log --format='  %h %s' "$before..$after" | head -20
    else
      echo "  Already up to date ($(g rev-parse --abbrev-ref HEAD), $(g log -1 --format='%h %s'))."
    fi
  else
    say "Downloading WebbMC ($BRANCH) into $DIR"
    code_changed=1
    # git clone needs an empty folder, so fetch into this one and check the files out.
    g init -q
    g remote add origin "$REPO"
    if ! g fetch -q origin "$BRANCH"; then
      rm -rf "$DIR/.git"
      die "Could not download $BRANCH from $REPO"
    fi
    if ! g cat-file -e "origin/$BRANCH:server.js" 2>/dev/null; then
      rm -rf "$DIR/.git"
      die "The $BRANCH branch does not have WebbMC in it yet."
    fi
    # Never overwrite files that are already here, except this script and exact copies of WebbMC's own files.
    local conflicts=() f
    while IFS= read -r f; do
      [[ -e $DIR/$f || -L $DIR/$f ]] || continue
      [[ $f == "$SELF" ]] && continue
      [[ -f $DIR/$f && $(g hash-object -- "$f") == $(g rev-parse "origin/$BRANCH:$f") ]] && continue
      conflicts+=("$f")
    done < <(g ls-tree -r --name-only "origin/$BRANCH")
    if ((${#conflicts[@]})); then
      rm -rf "$DIR/.git"
      die "These files are already in $DIR and would be overwritten: ${conflicts[*]}. Move them away, or put the script in an empty folder."
    fi
    g checkout -q -f -B "$BRANCH" "origin/$BRANCH"
    g branch -q --set-upstream-to="origin/$BRANCH"
    # The downloaded copy of this script is not needed now: WebbMC has its own in installer/ (bash has read this file).
    if [[ -n $SELF && -f $DIR/$SELF ]] && ! g ls-files --error-unmatch -- "$SELF" >/dev/null 2>&1; then rm -f "$DIR/$SELF"; fi
    echo "  $(g log -1 --format='%h %s')"
  fi

  # ---- Settings (.env) --------------------------------------------------------------------------------------
  if [[ ! -f $DIR/.env ]]; then
    if [[ -f $DIR/.env.example ]]; then as_user cp "$DIR/.env.example" "$DIR/.env"; else as_user touch "$DIR/.env"; fi
  fi
  chmod 600 "$DIR/.env"
  local env_changed=0
  set_env() { # KEY VALUE: replace "KEY=" or "# KEY=" in .env, or add it at the end
    local tmp
    tmp=$(mktemp)
    awk -v k="$1" -v v="$2" '!done && $0 ~ "^#? *" k "=" { print k "=" v; done = 1; next } { print } END { if (!done) print k "=" v }' "$DIR/.env" >"$tmp"
    if ! cmp -s "$tmp" "$DIR/.env"; then
      cat "$tmp" >"$DIR/.env"
      env_changed=1
    fi
    rm -f "$tmp"
  }
  if ((FRESH)); then
    set_env WEBMC_PORT "$PORT"
    ((LAN)) && set_env WEBMC_HOST 0.0.0.0
    [[ -n $URL ]] && set_env WEBMC_PUBLIC_URL "$URL"
    [[ -n $EMAILS ]] && set_env WEBMC_ADMIN_EMAILS "$EMAILS"
    if [[ -n $G_ID ]]; then
      set_env GOOGLE_CLIENT_ID "$G_ID"
      set_env GOOGLE_CLIENT_SECRET "$G_SECRET"
    fi
    note "Settings saved in $DIR/.env (edit it and restart WebbMC to change them)."
  fi
  PORT=$(sed -n 's/^WEBMC_PORT=\([0-9][0-9]*\).*/\1/p' "$DIR/.env" | tail -1)
  PORT=${PORT:-8420}
  local HOST
  HOST=$(sed -n 's/^WEBMC_HOST=\(.*\)/\1/p' "$DIR/.env" | tail -1 | tr -d ' "')
  URL=$(sed -n 's/^WEBMC_PUBLIC_URL=\(.*\)/\1/p' "$DIR/.env" | tail -1 | tr -d ' "')

  # ---- Admin account ----------------------------------------------------------------------------------------
  local otp=''
  if ((FRESH)) && [[ ! -f $DIR/data/panel.json ]]; then
    say "Creating the admin account"
    local out
    out=$(cd "$DIR" && as_user node reset-admin.js "$ADMIN" 2>&1) || die "Could not create the admin account: $out"
    otp=$(printf '%s\n' "$out" | sed -n 's/^ *One-time password: *//p')
    echo "  Created \"$ADMIN\"."
  fi

  # ---- Firewall ---------------------------------------------------------------------------------------------
  if ((OPEN_FW)); then
    say "Opening port $fw_port_note in $FW"
    local fp fw_ports=(25565)
    ((LAN)) && fw_ports+=("$PORT")
    for fp in "${fw_ports[@]}"; do
      if [[ $FW == ufw ]]; then
        as_root ufw allow "$fp/tcp" comment WebbMC >/dev/null
      else
        as_root firewall-cmd --quiet --permanent --add-port="$fp/tcp"
      fi
    done
    [[ $FW == firewalld ]] && as_root firewall-cmd --quiet --reload
    note "Other Minecraft servers on other ports need theirs opened too (the panel's Ports page lists them)."
  fi

  # ---- pm2 --------------------------------------------------------------------------------------------------
  pm2_cwd() { # the folder the pm2 app called $1 runs in, or nothing
    as_user pm2 jlist 2>/dev/null | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try { const a = JSON.parse(s).find((p) => p.name === process.argv[1]); if (a) console.log(a.pm2_env.pm_cwd || ""); } catch {}
      });' "$1" || true
  }
  local under_pm2=0 started=0
  if ((!FRESH)) && [[ -z $PM2 ]] && command -v pm2 >/dev/null && [[ -f $DIR/ecosystem.config.cjs ]]; then PM2=1; fi
  if ((!FRESH)) && [[ -z $PM2 ]]; then
    heading "Keep it running"
    note "pm2 runs WebbMC in the background, starts it at boot and restarts it after a crash."
    yes_no PM2 "Run WebbMC with pm2?" n
  fi
  if ((PM2)); then
    if ! command -v pm2 >/dev/null; then
      say "Installing pm2"
      command -v npm >/dev/null || install_pkgs npm
      hash -r
      local prefix
      prefix=$(npm prefix -g)
      if [[ $prefix == "$RUN_HOME"/* ]]; then # Node.js from nvm or similar, in the user's home
        as_user npm install -g pm2 --loglevel=error --no-fund --no-audit
      else
        as_root npm install -g pm2 --loglevel=error --no-fund --no-audit
      fi
      hash -r
      command -v pm2 >/dev/null || die "pm2 was installed but is not on the PATH. Open a new terminal and run this again."
    fi
    as_user pm2 ping >/dev/null # starts pm2's daemon for this user
    # A pm2 app with this name that runs another folder belongs to another install.
    local other
    other=$(pm2_cwd "$NAME")
    while [[ -n $other && $other != "$DIR" ]]; do
      ((INTERACTIVE)) || die "The pm2 app \"$NAME\" already runs WebbMC from $other. Use --name to pick another name."
      echo "  The pm2 app \"$NAME\" already runs WebbMC from $other."
      ask NAME "Name for this one" "$NAME-2"
      other=$(pm2_cwd "$NAME")
    done

    say "Starting WebbMC with pm2 as \"$NAME\""
    local eco=$DIR/ecosystem.config.cjs new_eco
    new_eco=$(
      cat <<EOF
// Created by install-linux.sh: how pm2 runs WebbMC. Run the installer again to update WebbMC.
module.exports = {
  apps: [
    {
      name: '$NAME',
      cwd: __dirname,
      script: 'server.js',
      interpreter: '$(command -v node)',
      // pm2 restarts WebbMC after updates and crashes. On stop, only the panel gets the signal (treekill off), and
      // it gets 60 seconds to stop every Minecraft server cleanly before pm2 gives up on it.
      autorestart: true,
      treekill: false,
      kill_timeout: 60000,
      restart_delay: 3000,
      min_uptime: 10000,
      max_restarts: 10,
      time: true,
    },
  ],
};
EOF
    )
    local eco_changed=0
    if [[ ! -f $eco ]] || [[ $(cat "$eco") != "$new_eco" ]]; then
      printf '%s\n' "$new_eco" | as_user tee "$eco" >/dev/null
      eco_changed=1
    fi
    if [[ -n $(pm2_cwd "$NAME") ]]; then
      if ((code_changed || eco_changed || env_changed)); then
        echo "  Restarting. Running Minecraft servers are stopped cleanly; servers set to auto-start come back."
        as_user pm2 delete "$NAME" >/dev/null
        (cd "$DIR" && as_user pm2 start "$eco" >/dev/null)
        started=1
      else
        echo "  Already running, nothing to restart."
      fi
    else
      (cd "$DIR" && as_user pm2 start "$eco" >/dev/null)
      started=1
    fi
    as_user pm2 save >/dev/null
    under_pm2=1
    # Start pm2 (and so WebbMC) at boot. pm2 writes and enables a systemd (or other init) service for this user.
    if ! ls /etc/systemd/system/pm2-"$RUN_USER".service >/dev/null 2>&1; then
      echo "  Setting pm2 to start at boot."
      as_root env PATH="$PATH" "$(command -v pm2)" startup -u "$RUN_USER" --hp "$RUN_HOME" >/dev/null ||
        warn "Could not set pm2 to start at boot. Run \"pm2 startup\" and follow what it prints."
    fi
  fi

  if ((started)) && [[ -z $HOST || $HOST == 0.0.0.0 || $HOST == 127.0.0.1 || $HOST == localhost || $HOST == :: ]]; then
    printf '  Waiting for the panel'
    local i ok=0
    for i in $(seq 1 45); do
      if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then ok=1 && break; fi
      printf '.'
      sleep 1
    done
    echo
    if ((ok)); then
      echo "  ${G}Running.${N}"
    else
      as_user pm2 logs "$NAME" --lines 20 --nostream 2>/dev/null || true
      die "WebbMC did not answer on port $PORT. See its log with: pm2 logs $NAME"
    fi
  fi

  # ---- Done -------------------------------------------------------------------------------------------------
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}') || true
  ip=${ip:-SERVER-IP}
  say "WebbMC is $( ((FRESH)) && echo installed || echo up to date) in $DIR"
  echo "  Open it:"
  [[ -n $URL ]] && echo "      $URL"
  echo "      http://localhost:$PORT   (on this machine)"
  if [[ $HOST == 0.0.0.0 || $HOST == :: ]]; then
    echo "      http://$ip:$PORT   (from other computers)"
  else
    echo "    From another computer, open an SSH tunnel, then browse to http://localhost:$PORT there:"
    echo "      ssh -L $PORT:localhost:$PORT $RUN_USER@$ip"
  fi
  if [[ -n $otp ]]; then
    echo
    echo "  ${B}Sign in as:${N}           $ADMIN"
    echo "  ${B}One-time password:${N}    $otp"
    note "It works once within 24 hours; then you choose your own password."
  fi
  echo
  if ((under_pm2)); then
    echo "  pm2 status                  is it running?"
    echo "  pm2 logs $NAME             its log (Ctrl+C to leave)"
    echo "  pm2 restart $NAME          restart it (after editing .env)"
    echo "  pm2 stop $NAME             stop it and its Minecraft servers"
  else
    echo "  Start it:  cd '$DIR' && node server.js   (Ctrl+C stops it and its Minecraft servers)"
  fi
  echo "  Update:    bash '$DIR/installer/install-linux.sh'   (or use the bell in the panel)"
  if [[ -n $FW ]] && ((!OPEN_FW)) && ((FRESH)); then
    echo
    echo "  The $FW firewall is on. Players can join after: $([[ $FW == ufw ]] && echo 'sudo ufw allow 25565/tcp' || echo 'sudo firewall-cmd --permanent --add-port=25565/tcp && sudo firewall-cmd --reload')"
  fi

  if ((!under_pm2 && INTERACTIVE)); then
    yes_no START_NOW "Start WebbMC now in this terminal?" y
    if ((START_NOW)); then
      echo
      cd "$DIR"
      as_user node server.js
    fi
  fi
  echo
}

main "${BASH_SOURCE[0]:-}" "$@"
exit $?
