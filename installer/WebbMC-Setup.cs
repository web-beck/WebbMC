// WebbMC-Setup.exe: double-click installer for Windows. It carries install-windows.ps1 inside it and runs it in this
// console window, so people do not have to open PowerShell. The script itself downloads the newest WebbMC.
//
// Build (no tools to install, the compiler ships with Windows), from the WebbMC folder:
//   powershell -ExecutionPolicy Bypass -File installer\build.ps1
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

class Setup
{
    static int Main()
    {
        Console.Title = "WebbMC setup";
        string script = Path.Combine(Path.GetTempPath(), "webbmc-install-" + Guid.NewGuid().ToString("N") + ".ps1");
        int code = 1;
        try
        {
            using (Stream src = Assembly.GetExecutingAssembly().GetManifestResourceStream("install-windows.ps1"))
            using (FileStream dst = File.Create(script))
                src.CopyTo(dst);
            ProcessStartInfo psi = new ProcessStartInfo("powershell.exe",
                "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"");
            psi.UseShellExecute = false; // same console window, so the questions are asked here
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                code = p.ExitCode;
            }
        }
        catch (Exception e)
        {
            Console.WriteLine("Could not run the installer: " + e.Message);
        }
        finally
        {
            try { File.Delete(script); } catch { }
        }
        // Keep the window open: the one-time password for the admin account is printed above.
        Console.WriteLine();
        Console.Write("Press Enter to close this window. ");
        Console.ReadLine();
        return code;
    }
}
