// WebbMC-Setup.exe: the Windows installer window. Pages: Welcome, Options, Installing, Done. The work itself is done by
// install-windows.ps1, carried inside this exe and run hidden without questions (WEBBMC_YES=1 and the answers in
// WEBBMC_* variables); its output becomes the progress log, and the address and one-time password are read from it.
//
// Build with the C# compiler that ships with Windows (.NET Framework 4, C# 5), from the WebbMC folder:
//   & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ /out:installer\WebbMC-Setup.exe /win32icon:static\favicon.ico /resource:installer\install-windows.ps1,install-windows.ps1 /resource:static\favicon.png,favicon.png installer\WebbMC-Setup.cs
// Build again after changing install-windows.ps1 (the exe has its own copy). WebbMC itself is always downloaded fresh.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [STAThread]
    static void Main()
    {
        try { SetProcessDPIAware(); } catch { } // sharp text on scaled screens
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm());
    }
}

class SetupForm : Form
{
    // The panel's colors.
    static readonly Color Bg = Color.FromArgb(0x18, 0x0f, 0x36);
    static readonly Color InputBg = Color.FromArgb(0x26, 0x1a, 0x4e);
    static readonly Color LogBg = Color.FromArgb(0x10, 0x0a, 0x26);
    static readonly Color Line = Color.FromArgb(0x3a, 0x2e, 0x66);
    static readonly Color Fg = Color.FromArgb(0xed, 0xed, 0xed);
    static readonly Color Muted = Color.FromArgb(0xb4, 0xae, 0xc8);
    static readonly Color Accent = Color.FromArgb(0x39, 0xff, 0x14);
    static readonly Color Ink = Color.FromArgb(0x12, 0x0a, 0x2f);
    static readonly Color Danger = Color.FromArgb(0xff, 0x6b, 0x8b);
    static readonly string[] Steps = { "Welcome", "Options", "Installing", "Done" };

    readonly Panel side, body, footer;
    readonly Panel[] pages = new Panel[4];
    readonly Button back, next, cancel;
    int page;

    // Options
    TextBox folder, admin;
    RadioButton stable, development;
    NumericUpDown port;
    CheckBox atLogin, startNow;
    Label optionsNote, optionsError;
    bool updating;

    // Installing and done
    Label status, doneTitle, doneText, runText, otpUser;
    ProgressBar bar;
    TextBox log, otpBox;
    LinkLabel link;
    Panel signIn;
    Process proc;
    string script, url, otp, error;
    bool running, failed;
    Image logo;

    public SetupForm()
    {
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Text = "WebbMC Setup";
        ClientSize = new Size(760, 500);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Bg;
        ForeColor = Fg;
        Font = new Font("Segoe UI", 9.75F);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        try { logo = Image.FromStream(Resource("favicon.png")); } catch { }

        side = new Panel { Location = new Point(0, 0), Size = new Size(210, 500) };
        side.Paint += PaintSide;
        Controls.Add(side);

        body = new Panel { Location = new Point(210, 0), Size = new Size(550, 436) };
        Controls.Add(body);

        footer = new Panel { Location = new Point(210, 436), Size = new Size(550, 64) };
        footer.Paint += (s, e) => { using (Pen p = new Pen(Line)) e.Graphics.DrawLine(p, 0, 0, footer.Width, 0); };
        Controls.Add(footer);
        cancel = MakeButton("Cancel", false, new Point(426, 16));
        next = MakeButton("Next", true, new Point(282, 16));
        next.Width = 136; // fits "Open WebbMC"
        back = MakeButton("Back", false, new Point(170, 16));
        footer.Controls.AddRange(new Control[] { back, next, cancel });
        back.Click += (s, e) => { if (page == 1) Show(0); else if (page == 2 && failed) Show(1); };
        next.Click += (s, e) => Next();
        cancel.Click += (s, e) => Close();
        AcceptButton = next;

        BuildWelcome();
        BuildOptions();
        BuildInstalling();
        BuildDone();
        Show(0);
    }

    static Stream Resource(string name)
    {
        return Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
    }

    // ---------------------------------------------------------------- look

    void PaintSide(object sender, PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        float k = side.Width / 210F; // drawn by hand, so scale with the screen
        using (LinearGradientBrush b = new LinearGradientBrush(side.ClientRectangle, Color.FromArgb(0x2a, 0x0f, 0x4f), Color.FromArgb(0xc1, 0x2a, 0xab), 60F))
            g.FillRectangle(b, side.ClientRectangle);
        if (logo != null) g.DrawImage(logo, new RectangleF(57 * k, 40 * k, 96 * k, 96 * k));
        using (Font big = new Font("Segoe UI Semibold", 18F))
        using (Font small = new Font("Segoe UI", 9F))
        using (StringFormat center = new StringFormat { Alignment = StringAlignment.Center })
        {
            g.DrawString("WebbMC", big, Brushes.White, new RectangleF(0, 146 * k, side.Width, 40 * k), center);
            using (SolidBrush m = new SolidBrush(Color.FromArgb(220, 255, 255, 255)))
                g.DrawString("Minecraft server panel", small, m, new RectangleF(0, 184 * k, side.Width, 24 * k), center);
            for (int i = 0; i < Steps.Length; i++)
            {
                float y = (250 + i * 34) * k;
                bool now = i == page, done = i < page;
                using (SolidBrush dot = new SolidBrush(now ? Accent : done ? Color.White : Color.FromArgb(110, 255, 255, 255)))
                    g.FillEllipse(dot, 34 * k, y + 5 * k, 10 * k, 10 * k);
                using (Font f = new Font("Segoe UI", 10F, now ? FontStyle.Bold : FontStyle.Regular))
                using (SolidBrush t = new SolidBrush(now ? Color.White : Color.FromArgb(now || done ? 255 : 170, 255, 255, 255)))
                    g.DrawString(Steps[i], f, t, 54 * k, y);
            }
        }
    }

    Button MakeButton(string text, bool primary, Point at)
    {
        Button b = new Button { Text = text, Location = at, Size = new Size(104, 34), FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand };
        b.FlatAppearance.BorderColor = primary ? Accent : Line;
        b.BackColor = primary ? Accent : InputBg;
        b.ForeColor = primary ? Ink : Fg;
        if (primary) b.Font = new Font("Segoe UI Semibold", 9.75F);
        return b;
    }

    Panel MakePage(string title)
    {
        Panel p = new Panel { Location = new Point(0, 0), Size = body.Size, Visible = false };
        p.Controls.Add(new Label { Text = title, Location = new Point(32, 28), AutoSize = true, Font = new Font("Segoe UI Semibold", 17F), ForeColor = Fg });
        body.Controls.Add(p);
        return p;
    }

    /// A label of `width` that wraps, placed at `y`. Returns the y below it.
    int Text_(Panel p, string text, int y, Color color, float size = 9.75F, bool bold = false, int width = 480, int x = 32)
    {
        Label l = new Label { Text = text, Location = new Point(x, y), ForeColor = color, Font = new Font(bold ? "Segoe UI Semibold" : "Segoe UI", size), AutoSize = false };
        l.Size = l.GetPreferredSize(new Size(width, 0));
        l.Width = width;
        p.Controls.Add(l);
        return y + l.Height;
    }

    TextBox Input(Panel p, string value, int x, int y, int width)
    {
        TextBox t = new TextBox { Text = value, Location = new Point(x, y), Width = width, BackColor = InputBg, ForeColor = Fg, BorderStyle = BorderStyle.FixedSingle };
        p.Controls.Add(t);
        return t;
    }

    void Show(int n)
    {
        page = n;
        for (int i = 0; i < pages.Length; i++) pages[i].Visible = i == n;
        back.Visible = n == 1 || (n == 2 && failed);
        next.Visible = n != 2 || failed;
        next.Text = n == 0 ? "Next" : n == 1 ? (updating ? "Update" : "Install") : n == 2 ? "Try again" : (startNow.Checked ? "Open WebbMC" : "Start WebbMC");
        if (n == 2 && failed) next.Text = "Try again";
        cancel.Text = n == 3 ? "Finish" : n == 2 && failed ? "Close" : "Cancel";
        side.Invalidate();
        if (n == 1) folder.Focus();
    }

    // ---------------------------------------------------------------- pages

    void BuildWelcome()
    {
        Panel p = pages[0] = MakePage("Welcome to WebbMC");
        int y = Text_(p, "This sets up WebbMC, a Minecraft server panel you open in your web browser. Create servers, install plugins, back up worlds and let friends join, all from one page.", 80, Fg);
        y = Text_(p, "Setup will:", y + 18, Fg, 9.75F, true);
        foreach (string s in new[] {
            "Install Node.js and Git if they are missing",
            "Download the newest WebbMC from GitHub",
            "Create your admin account",
            "Add a WebbMC shortcut to your desktop" })
        {
            Text_(p, "\u2713", y + 6, Accent, 9.75F, true, 20);
            y = Text_(p, s, y + 6, Fg, 9.75F, false, 440, 54);
        }
        Text_(p, "You need an internet connection. It takes a few minutes, a little longer if Node.js has to be installed.", y + 24, Muted, 9F);
    }

    void BuildOptions()
    {
        Panel p = pages[1] = MakePage("Options");
        Text_(p, "Install folder", 80, Fg, 9.75F, true);
        folder = Input(p, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "WebbMC"), 32, 104, 376);
        Button browse = MakeButton("Browse...", false, new Point(416, 101));
        browse.Size = new Size(96, 28);
        browse.Click += (s, e) =>
        {
            using (FolderBrowserDialog d = new FolderBrowserDialog { Description = "Choose where to install WebbMC. A WebbMC folder is made inside it if it already has files." })
            {
                if (d.ShowDialog(this) != DialogResult.OK) return;
                string pick = d.SelectedPath;
                if (Directory.Exists(pick) && Directory.GetFileSystemEntries(pick).Length > 0 && !IsWebbMC(pick)) pick = Path.Combine(pick, "WebbMC");
                folder.Text = pick;
            }
        };
        p.Controls.Add(browse);
        optionsNote = new Label { Location = new Point(32, 132), Size = new Size(480, 20), ForeColor = Accent, Font = new Font("Segoe UI", 9F) };
        p.Controls.Add(optionsNote);

        Text_(p, "Version", 160, Fg, 9.75F, true);
        stable = new RadioButton { Text = "Stable (recommended)", Location = new Point(32, 182), AutoSize = true, Checked = true, ForeColor = Fg };
        development = new RadioButton { Text = "Development: newest features, can break", Location = new Point(220, 182), AutoSize = true, ForeColor = Fg };
        p.Controls.AddRange(new Control[] { stable, development });

        Text_(p, "Panel port", 218, Fg, 9.75F, true, 170); // narrower than the gap to "Admin username" at x 220
        port = new NumericUpDown { Minimum = 1, Maximum = 65535, Value = 8420, Location = new Point(32, 242), Width = 100, BackColor = InputBg, ForeColor = Fg, BorderStyle = BorderStyle.FixedSingle };
        p.Controls.Add(port);
        Text_(p, "Admin username", 218, Fg, 9.75F, true, 200, 220);
        admin = Input(p, "admin", 220, 242, 180);
        Text_(p, "You open WebbMC at http://localhost:<port>. You get a one-time password for the admin account at the end.", 274, Muted, 9F);

        atLogin = new CheckBox { Text = "Start WebbMC when I sign in to Windows", Location = new Point(32, 318), AutoSize = true, Checked = true, ForeColor = Fg };
        startNow = new CheckBox { Text = "Start WebbMC when setup finishes", Location = new Point(32, 344), AutoSize = true, Checked = true, ForeColor = Fg };
        p.Controls.AddRange(new Control[] { atLogin, startNow });

        optionsError = new Label { Location = new Point(32, 378), Size = new Size(480, 44), ForeColor = Danger, Font = new Font("Segoe UI", 9F) };
        p.Controls.Add(optionsError);

        folder.TextChanged += (s, e) => CheckFolder();
        CheckFolder();
    }

    void BuildInstalling()
    {
        Panel p = pages[2] = MakePage("Installing WebbMC");
        status = new Label { Text = "Getting ready...", Location = new Point(32, 80), Size = new Size(480, 22), Font = new Font("Segoe UI Semibold", 10F), ForeColor = Fg };
        bar = new ProgressBar { Location = new Point(32, 108), Size = new Size(480, 8), Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 30 };
        log = new TextBox
        {
            Location = new Point(32, 128), Size = new Size(480, 292), Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical,
            BackColor = LogBg, ForeColor = Muted, BorderStyle = BorderStyle.FixedSingle, Font = new Font("Consolas", 8.75F), WordWrap = true,
        };
        p.Controls.AddRange(new Control[] { status, bar, log });
    }

    void BuildDone()
    {
        Panel p = pages[3] = MakePage("WebbMC is installed");
        doneTitle = (Label)p.Controls[0];
        doneText = new Label { Text = "Open it in your browser at", Location = new Point(32, 80), AutoSize = true, ForeColor = Fg };
        link = new LinkLabel { Location = new Point(32, 102), AutoSize = true, Font = new Font("Segoe UI Semibold", 11F), LinkColor = Accent, ActiveLinkColor = Accent, VisitedLinkColor = Accent };
        link.LinkClicked += (s, e) => OpenPanel();
        p.Controls.AddRange(new Control[] { doneText, link });

        signIn = new Panel { Location = new Point(32, 140), Size = new Size(480, 132), BackColor = InputBg };
        signIn.Paint += (s, e) => { using (Pen pen = new Pen(Line)) e.Graphics.DrawRectangle(pen, 0, 0, signIn.Width - 1, signIn.Height - 1); };
        signIn.Controls.Add(new Label { Text = "Sign in with", Location = new Point(16, 12), AutoSize = true, ForeColor = Muted, Font = new Font("Segoe UI Semibold", 9F) });
        otpUser = new Label { Location = new Point(16, 36), AutoSize = true, ForeColor = Fg };
        signIn.Controls.Add(otpUser);
        signIn.Controls.Add(new Label { Text = "One-time password", Location = new Point(16, 62), AutoSize = true, ForeColor = Fg });
        otpBox = new TextBox { Location = new Point(150, 58), Width = 200, ReadOnly = true, BackColor = LogBg, ForeColor = Accent, BorderStyle = BorderStyle.FixedSingle, Font = new Font("Consolas", 12F, FontStyle.Bold) };
        signIn.Controls.Add(otpBox);
        Button copy = MakeButton("Copy", false, new Point(358, 57));
        copy.Size = new Size(80, 28);
        copy.Click += (s, e) => { try { Clipboard.SetText(otpBox.Text); copy.Text = "Copied"; } catch { } };
        signIn.Controls.Add(copy);
        signIn.Controls.Add(new Label { Text = "It works once, within 24 hours. When you sign in you choose your own password.", Location = new Point(16, 98), Size = new Size(450, 20), ForeColor = Muted, Font = new Font("Segoe UI", 9F) });
        p.Controls.Add(signIn);

        runText = new Label { Location = new Point(32, 290), Size = new Size(480, 120), ForeColor = Muted, Font = new Font("Segoe UI", 9F) };
        p.Controls.Add(runText);
    }

    // ---------------------------------------------------------------- options

    static bool IsWebbMC(string dir)
    {
        return File.Exists(Path.Combine(dir, "server.js")) && Directory.Exists(Path.Combine(dir, ".git"));
    }

    void CheckFolder()
    {
        string dir = folder.Text.Trim();
        updating = false;
        try { updating = dir.Length > 0 && Path.IsPathRooted(dir) && IsWebbMC(dir); } catch { }
        optionsNote.Text = updating ? "WebbMC is already installed here. Setup will update it and keep its settings." : "";
        foreach (Control c in new Control[] { stable, development, port, admin, atLogin }) c.Enabled = !updating;
        if (page == 1) next.Text = updating ? "Update" : "Install";
    }

    static bool PortInUse(int n)
    {
        try
        {
            using (TcpClient c = new TcpClient())
            {
                IAsyncResult r = c.BeginConnect("127.0.0.1", n, null, null);
                return r.AsyncWaitHandle.WaitOne(400) && c.Connected;
            }
        }
        catch { return false; }
    }

    /// Why the options cannot be used, or null.
    string Problem()
    {
        string dir = folder.Text.Trim();
        if (dir.Length == 0) return "Choose a folder to install WebbMC in.";
        try { dir = Path.GetFullPath(dir); } catch { return "That folder name is not valid."; }
        if (!Path.IsPathRooted(folder.Text.Trim())) return "Use a full folder path, such as C:\\Users\\you\\WebbMC.";
        if (updating) return null;
        if (Directory.Exists(dir) && Directory.GetFileSystemEntries(dir).Length > 0) return "That folder already has files in it. Pick an empty or new folder (or a WebbMC folder to update it).";
        int n = (int)port.Value;
        if (n == 25565) return "25565 is Minecraft's own port. Pick another one for the panel, such as 8420.";
        if (PortInUse(n)) return "Something on this PC already uses port " + n + ". Pick another one.";
        if (!Regex.IsMatch(admin.Text.Trim(), "^[A-Za-z0-9_.-]{3,24}$")) return "The admin username must be 3 to 24 letters, digits, dots, dashes or underscores.";
        return null;
    }

    void Next()
    {
        if (page == 0) { Show(1); return; }
        if (page == 1 || (page == 2 && failed))
        {
            string why = Problem();
            optionsError.Text = why ?? "";
            if (why != null) { Show(1); return; }
            StartInstall();
            return;
        }
        if (page == 3) OpenPanel();
    }

    // ---------------------------------------------------------------- installing

    void StartInstall()
    {
        failed = false;
        error = url = otp = null;
        log.Clear();
        status.Text = "Getting ready...";
        status.ForeColor = Fg;
        bar.Style = ProgressBarStyle.Marquee;
        Show(2);
        try
        {
            script = Path.Combine(Path.GetTempPath(), "webbmc-install-" + Guid.NewGuid().ToString("N") + ".ps1");
            using (Stream src = Resource("install-windows.ps1"))
            using (FileStream dst = File.Create(script))
                src.CopyTo(dst);
            ProcessStartInfo psi = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"")
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            };
            psi.EnvironmentVariables["WEBBMC_YES"] = "1";
            psi.EnvironmentVariables["WEBBMC_DIR"] = Path.GetFullPath(folder.Text.Trim());
            psi.EnvironmentVariables["WEBBMC_BRANCH"] = development.Checked ? "dev" : "main";
            psi.EnvironmentVariables["WEBBMC_PORT"] = ((int)port.Value).ToString();
            psi.EnvironmentVariables["WEBBMC_ADMIN"] = admin.Text.Trim();
            psi.EnvironmentVariables["WEBBMC_ATLOGIN"] = atLogin.Checked ? "1" : "0";
            psi.EnvironmentVariables["WEBBMC_START"] = startNow.Checked ? "1" : "0";
            proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.OutputDataReceived += (s, e) => { if (e.Data != null) BeginInvoke((Action<string>)OnLine, e.Data); };
            proc.ErrorDataReceived += (s, e) => { if (e.Data != null) BeginInvoke((Action<string>)OnLine, e.Data); };
            proc.Exited += (s, e) => BeginInvoke((Action)OnExited);
            running = true;
            proc.Start();
            proc.StandardInput.Close();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            running = false;
            Fail("Could not start the installer: " + ex.Message);
        }
    }

    void OnLine(string raw)
    {
        // Progress bars (winget) redraw a line with \r: keep what it ends with, and skip lines of only spinner marks.
        string line = raw;
        int cr = line.LastIndexOf('\r');
        if (cr >= 0) line = line.Substring(cr + 1);
        string t = line.Trim();
        if (t.Length == 0 || !Regex.IsMatch(t, "[A-Za-z0-9]")) return;
        if (t.StartsWith("==> ")) status.Text = t.Substring(4);
        Match m = Regex.Match(t, @"One-time password:\s*(\S+)");
        if (m.Success) otp = m.Groups[1].Value;
        m = Regex.Match(t, @"Open it:\s*(http\S+)");
        if (m.Success) url = m.Groups[1].Value;
        if (t.StartsWith("Error: ")) error = t.Substring(7);
        log.AppendText(line.TrimEnd() + Environment.NewLine);
    }

    void OnExited()
    {
        running = false;
        int code = 1;
        try { code = proc.ExitCode; } catch { }
        DeleteScript();
        if (code != 0 || error != null || url == null) { Fail(error ?? "The installer stopped before it finished."); return; }
        doneTitle.Text = updating ? "WebbMC is up to date" : "WebbMC is installed";
        link.Text = url;
        signIn.Visible = otp != null;
        otpBox.Text = otp ?? "";
        otpUser.Text = "Username:  " + admin.Text.Trim();
        runText.Location = new Point(32, otp != null ? 290 : 150);
        // The WebbMC app is built from the downloaded files; without it, WebbMC runs in a terminal window instead.
        bool app = File.Exists(Path.Combine(Path.GetFullPath(folder.Text.Trim()), "WebbMC.exe"));
        runText.Text = !startNow.Checked
            ? "Start it any time with the WebbMC shortcut on your desktop."
            : app
                ? "WebbMC is running in its own window. Closing that window keeps it running in the system tray; its Stop button stops it, and your Minecraft servers with it, cleanly.\n\nNext time, start it with the WebbMC shortcut on your desktop."
                : "WebbMC is running in a terminal window. To stop it, press Ctrl+C in that window (not the X), which stops your Minecraft servers cleanly first.\n\nNext time, start it with the WebbMC shortcut on your desktop.";
        Show(3);
    }

    void Fail(string message)
    {
        failed = true;
        bar.Style = ProgressBarStyle.Continuous;
        bar.Value = 0;
        status.Text = message;
        status.ForeColor = Danger;
        status.Height = status.GetPreferredSize(new Size(480, 0)).Height;
        Show(2);
    }

    void DeleteScript()
    {
        try { if (script != null) File.Delete(script); } catch { }
    }

    /// Open the panel in the browser, starting it first when it is not running.
    void OpenPanel()
    {
        if (url == null) return;
        string health = url.Replace("localhost", "127.0.0.1").TrimEnd('/') + "/api/health";
        string home = Path.GetFullPath(folder.Text.Trim());
        string bat = Path.Combine(home, "WebbMC.exe");
        if (!File.Exists(bat)) bat = Path.Combine(home, "start-webbmc.bat");
        next.Enabled = false;
        next.Text = "Starting...";
        Thread th = new Thread(() =>
        {
            bool up = Answers(health);
            if (!up && File.Exists(bat))
            {
                try { Process.Start(new ProcessStartInfo(bat) { WorkingDirectory = Path.GetDirectoryName(bat) }); } catch { }
                for (int i = 0; i < 45 && !up; i++) { Thread.Sleep(1000); up = Answers(health); }
            }
            try { Process.Start(url); } catch { }
            BeginInvoke((Action)(() => { next.Enabled = true; next.Text = "Open WebbMC"; }));
        });
        th.IsBackground = true;
        th.Start();
    }

    static bool Answers(string health)
    {
        try
        {
            HttpWebRequest r = (HttpWebRequest)WebRequest.Create(health);
            r.Timeout = 1500;
            using (WebResponse res = r.GetResponse()) return true;
        }
        catch { return false; }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (running)
        {
            if (MessageBox.Show(this, "Stop setting up WebbMC?", "WebbMC Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
            {
                e.Cancel = true;
                return;
            }
            // The installer and what it started (git, winget).
            try { Process.Start(new ProcessStartInfo("taskkill", "/T /F /PID " + proc.Id) { CreateNoWindow = true, UseShellExecute = false }).WaitForExit(5000); } catch { }
            running = false;
        }
        DeleteScript();
        base.OnFormClosing(e);
    }
}
