// WebbMC.exe: the Windows app that runs the panel, instead of a terminal window. It shows the panel's status, address
// and log, opens it in the browser, and stops it cleanly (every Minecraft server first). Closing the window keeps
// WebbMC running in the system tray. "WebbMC.exe --tray" starts in the tray (the Startup shortcut uses it).
//
// install-windows.ps1 builds it into the WebbMC folder on every install or update, with the C# compiler that ships
// with Windows (.NET Framework 4, C# 5). It is not kept in git: a running exe could not be replaced by an update.
//   & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ /out:WebbMC.exe /win32icon:static\favicon.ico /resource:static\favicon.png,favicon.png installer\WebbMC.cs
//
// The panel is started with WEBMC_STDIN_CONTROL=1: writing "stop" to it stops it cleanly, as Ctrl+C would in a terminal.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
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
    static void Main(string[] args)
    {
        string dir = Path.GetDirectoryName(Application.ExecutablePath);
        // One app per WebbMC folder: a second start shows the first one's window.
        string id = "WebbMC-" + dir.ToLowerInvariant().GetHashCode().ToString("x");
        bool first;
        using (Mutex once = new Mutex(true, id, out first))
        {
            EventWaitHandle wake = new EventWaitHandle(false, EventResetMode.AutoReset, id + "-show");
            if (!first)
            {
                wake.Set();
                return;
            }
            try { SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new AppForm(dir, Array.IndexOf(args, "--tray") >= 0, wake));
        }
    }
}

class AppForm : Form
{
    static readonly Color Bg = Color.FromArgb(0x18, 0x0f, 0x36);
    static readonly Color InputBg = Color.FromArgb(0x26, 0x1a, 0x4e);
    static readonly Color LogBg = Color.FromArgb(0x10, 0x0a, 0x26);
    static readonly Color Line = Color.FromArgb(0x3a, 0x2e, 0x66);
    static readonly Color Fg = Color.FromArgb(0xed, 0xed, 0xed);
    static readonly Color Muted = Color.FromArgb(0xb4, 0xae, 0xc8);
    static readonly Color Accent = Color.FromArgb(0x39, 0xff, 0x14);
    static readonly Color Ink = Color.FromArgb(0x12, 0x0a, 0x2f);
    static readonly Color Warn = Color.FromArgb(0xff, 0xc8, 0x57);
    static readonly Color Danger = Color.FromArgb(0xff, 0x6b, 0x8b);

    enum State { Stopped, Starting, Running, Stopping }

    readonly string dir;
    readonly Panel side;
    readonly Label statusLabel, hint;
    readonly LinkLabel link;
    readonly Button open, startStop, restart;
    readonly TextBox log;
    readonly NotifyIcon tray;
    readonly ToolStripMenuItem trayStartStop;
    readonly Image logo;
    Process proc;
    State state = State.Stopped;
    string url;
    bool restartAfterStop, exitAfterStop, toldAboutTray, hiddenAtStart;

    public AppForm(string dir, bool startInTray, EventWaitHandle wake)
    {
        this.dir = dir;
        hiddenAtStart = startInTray;
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Text = "WebbMC";
        ClientSize = new Size(820, 520);
        MinimumSize = new Size(640, 420);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Bg;
        ForeColor = Fg;
        Font = new Font("Segoe UI", 9.75F);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        try { logo = Image.FromStream(Assembly.GetExecutingAssembly().GetManifestResourceStream("favicon.png")); } catch { }

        side = new Panel { Dock = DockStyle.Left, Width = 200 };
        side.Paint += PaintSide;

        Panel main = new Panel { Dock = DockStyle.Fill, Padding = new Padding(28, 24, 24, 20) };
        statusLabel = new Label { Dock = DockStyle.Top, Height = 34, Font = new Font("Segoe UI Semibold", 15F), ForeColor = Fg };
        link = new LinkLabel { Dock = DockStyle.Top, Height = 26, Font = new Font("Segoe UI Semibold", 11F), LinkColor = Accent, ActiveLinkColor = Accent, VisitedLinkColor = Accent };
        link.LinkClicked += (s, e) => OpenBrowser();
        hint = new Label { Dock = DockStyle.Top, Height = 40, ForeColor = Muted, Font = new Font("Segoe UI", 9F) };

        FlowLayoutPanel buttons = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 46, WrapContents = false };
        open = MakeButton("Open WebbMC", true, 140);
        startStop = MakeButton("Stop", false, 104);
        restart = MakeButton("Restart", false, 104);
        open.Click += (s, e) => OpenBrowser();
        startStop.Click += (s, e) => { if (state == State.Stopped) StartPanel(); else StopPanel(); };
        restart.Click += (s, e) => { if (state == State.Running) { restartAfterStop = true; StopPanel(); } };
        buttons.Controls.AddRange(new Control[] { open, startStop, restart });

        Label logTitle = new Label { Text = "Log", Dock = DockStyle.Top, Height = 26, ForeColor = Muted, Font = new Font("Segoe UI Semibold", 9F), TextAlign = ContentAlignment.BottomLeft };
        log = new TextBox
        {
            Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, WordWrap = true,
            BackColor = LogBg, ForeColor = Muted, BorderStyle = BorderStyle.FixedSingle, Font = new Font("Consolas", 9F),
        };
        // Docked controls stack from the last one added, so add bottom to top.
        main.Controls.AddRange(new Control[] { log, logTitle, buttons, hint, link, statusLabel });
        Controls.Add(main);
        Controls.Add(side);

        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("Open WebbMC in the browser", null, (s, e) => OpenBrowser());
        menu.Items.Add("Show this window", null, (s, e) => ShowWindow());
        trayStartStop = new ToolStripMenuItem("Stop", null, (s, e) => { if (state == State.Stopped) StartPanel(); else StopPanel(); });
        menu.Items.Add(trayStartStop);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit (stops WebbMC)", null, (s, e) => ExitApp());
        tray = new NotifyIcon { Icon = Icon, Text = "WebbMC", Visible = true, ContextMenuStrip = menu };
        tray.DoubleClick += (s, e) => ShowWindow();

        // A second WebbMC.exe asks this one to show itself.
        Thread waker = new Thread(() => { while (true) { wake.WaitOne(); try { BeginInvoke((Action)ShowWindow); } catch { return; } } });
        waker.IsBackground = true;
        waker.Start();

        SetState(State.Stopped);
        StartPanel();
    }

    protected override void SetVisibleCore(bool value)
    {
        // Started with --tray: stay hidden until opened from the tray.
        if (hiddenAtStart && !IsHandleCreated) { value = false; CreateHandle(); }
        base.SetVisibleCore(value);
    }

    // ---------------------------------------------------------------- look

    void PaintSide(object sender, PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        float k = side.Width / 200F;
        using (LinearGradientBrush b = new LinearGradientBrush(side.ClientRectangle, Color.FromArgb(0x2a, 0x0f, 0x4f), Color.FromArgb(0xc1, 0x2a, 0xab), 60F))
            g.FillRectangle(b, side.ClientRectangle);
        if (logo != null) g.DrawImage(logo, new RectangleF(52 * k, 40 * k, 96 * k, 96 * k));
        using (Font big = new Font("Segoe UI Semibold", 18F))
        using (Font small = new Font("Segoe UI", 9F))
        using (StringFormat center = new StringFormat { Alignment = StringAlignment.Center })
        using (SolidBrush m = new SolidBrush(Color.FromArgb(220, 255, 255, 255)))
        {
            g.DrawString("WebbMC", big, Brushes.White, new RectangleF(0, 146 * k, side.Width, 40 * k), center);
            g.DrawString("Minecraft server panel", small, m, new RectangleF(0, 184 * k, side.Width, 24 * k), center);
            // Status pill
            Color c = state == State.Running ? Accent : state == State.Stopped ? Color.FromArgb(170, 255, 255, 255) : Warn;
            string text = state == State.Running ? "Running" : state == State.Starting ? "Starting" : state == State.Stopping ? "Stopping" : "Stopped";
            RectangleF pill = new RectangleF(50 * k, 226 * k, 100 * k, 28 * k);
            using (GraphicsPath p = Rounded(pill, 14 * k))
            using (SolidBrush fill = new SolidBrush(Color.FromArgb(90, 0, 0, 0)))
                g.FillPath(fill, p);
            using (SolidBrush dot = new SolidBrush(c))
                g.FillEllipse(dot, pill.X + 12 * k, pill.Y + 9 * k, 10 * k, 10 * k);
            using (SolidBrush t = new SolidBrush(Color.White))
                g.DrawString(text, small, t, pill.X + 28 * k, pill.Y + 5 * k);
        }
    }

    static GraphicsPath Rounded(RectangleF r, float radius)
    {
        GraphicsPath p = new GraphicsPath();
        float d = radius * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    Button MakeButton(string text, bool primary, int width)
    {
        Button b = new Button { Text = text, Size = new Size(width, 34), Margin = new Padding(0, 6, 10, 0), FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand };
        b.FlatAppearance.BorderColor = primary ? Accent : Line;
        b.BackColor = primary ? Accent : InputBg;
        b.ForeColor = primary ? Ink : Fg;
        if (primary) b.Font = new Font("Segoe UI Semibold", 9.75F);
        return b;
    }

    void SetState(State s)
    {
        state = s;
        statusLabel.Text = s == State.Running ? "WebbMC is running" : s == State.Starting ? "Starting WebbMC..." : s == State.Stopping ? "Stopping WebbMC..." : "WebbMC is stopped";
        statusLabel.ForeColor = s == State.Stopped ? Muted : Fg;
        link.Text = url ?? "";
        link.Visible = url != null && s == State.Running;
        hint.Text = s == State.Running
            ? "Closing this window keeps WebbMC running in the system tray. Use Stop to stop it (your Minecraft servers are stopped cleanly first)."
            : s == State.Stopping
                ? "Stopping every Minecraft server cleanly first. This can take up to a minute."
                : s == State.Starting ? "This takes a few seconds." : "Start it to open the panel again.";
        open.Enabled = s == State.Running;
        startStop.Text = s == State.Stopped ? "Start" : "Stop";
        startStop.Enabled = s != State.Stopping;
        restart.Enabled = s == State.Running;
        trayStartStop.Text = s == State.Stopped ? "Start WebbMC" : "Stop WebbMC";
        trayStartStop.Enabled = s != State.Stopping;
        tray.Text = "WebbMC: " + (s == State.Running ? "running" : s == State.Starting ? "starting" : s == State.Stopping ? "stopping" : "stopped");
        side.Invalidate();
    }

    // ---------------------------------------------------------------- the panel

    void StartPanel()
    {
        if (proc != null) return;
        url = null;
        AppendLog("Starting WebbMC in " + dir);
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("node", "server.js")
            {
                WorkingDirectory = dir, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            };
            psi.EnvironmentVariables["WEBMC_STDIN_CONTROL"] = "1";
            proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.OutputDataReceived += (s, e) => { if (e.Data != null) BeginInvoke((Action<string>)OnLine, e.Data); };
            proc.ErrorDataReceived += (s, e) => { if (e.Data != null) BeginInvoke((Action<string>)OnLine, e.Data); };
            proc.Exited += (s, e) => BeginInvoke((Action)OnExited);
            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            SetState(State.Starting);
        }
        catch (Exception ex)
        {
            proc = null;
            AppendLog("Could not start WebbMC: " + ex.Message + ". Is Node.js installed? Run WebbMC-Setup.exe again to install it.");
            SetState(State.Stopped);
        }
    }

    void StopPanel()
    {
        if (proc == null || state == State.Stopping) return;
        SetState(State.Stopping);
        try
        {
            proc.StandardInput.WriteLine("stop");
            proc.StandardInput.Flush();
        }
        catch { }
        // The panel gives its servers 45 seconds; if it is still there well after that, end it.
        Process p = proc;
        System.Windows.Forms.Timer t = new System.Windows.Forms.Timer { Interval = 90000 };
        t.Tick += (s, e) =>
        {
            t.Stop();
            t.Dispose();
            if (proc == p && !p.HasExited)
            {
                AppendLog("WebbMC did not stop in time, so it was ended.");
                KillTree(p);
            }
        };
        t.Start();
    }

    static void KillTree(Process p)
    {
        try { Process.Start(new ProcessStartInfo("taskkill", "/T /F /PID " + p.Id) { CreateNoWindow = true, UseShellExecute = false }).WaitForExit(5000); } catch { }
    }

    void OnLine(string line)
    {
        Match m = Regex.Match(line, @"is running at (http\S+)");
        if (m.Success)
        {
            url = m.Groups[1].Value;
            SetState(State.Running);
        }
        AppendLog(line);
    }

    void OnExited()
    {
        int code = 0;
        try { code = proc.ExitCode; } catch { }
        proc = null;
        AppendLog("WebbMC stopped" + (code != 0 ? " (exit code " + code + ")" : "") + ".");
        SetState(State.Stopped);
        if (exitAfterStop) { Quit(); return; }
        if (restartAfterStop) { restartAfterStop = false; StartPanel(); return; }
        if (code != 0 && !Visible) ShowWindow(); // it stopped by itself: say so
    }

    void AppendLog(string line)
    {
        if (log.TextLength > 300000) log.Text = log.Text.Substring(log.TextLength - 200000); // keep the newest
        log.AppendText(line + Environment.NewLine);
    }

    void OpenBrowser()
    {
        if (url != null) try { Process.Start(url); } catch { }
    }

    // ---------------------------------------------------------------- window and tray

    void ShowWindow()
    {
        hiddenAtStart = false;
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    void ExitApp()
    {
        if (proc == null) { Quit(); return; }
        exitAfterStop = true;
        ShowWindow();
        StopPanel();
    }

    void Quit()
    {
        tray.Visible = false;
        tray.Dispose();
        exitAfterStop = true;
        Application.Exit();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.WindowsShutDown && proc != null)
        {
            // Windows is shutting down: stop the servers, as far as Windows waits.
            try { proc.StandardInput.WriteLine("stop"); proc.StandardInput.Flush(); proc.WaitForExit(20000); } catch { }
        }
        else if (!exitAfterStop && e.CloseReason == CloseReason.UserClosing)
        {
            // The X keeps WebbMC running in the tray.
            e.Cancel = true;
            Hide();
            if (!toldAboutTray && proc != null)
            {
                toldAboutTray = true;
                tray.ShowBalloonTip(4000, "WebbMC is still running", "It is in the system tray. Right-click its icon to open or stop it.", ToolTipIcon.Info);
            }
            return;
        }
        tray.Visible = false;
        base.OnFormClosing(e);
    }
}
