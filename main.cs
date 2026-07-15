using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("Typeless Toolkit")]
[assembly: AssemblyProduct("Typeless Toolkit")]
[assembly: AssemblyDescription("Typeless desktop account and dictionary toolkit")]
[assembly: AssemblyCompany("Typeless Toolkit Contributors")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Typeless Toolkit Contributors")]
[assembly: AssemblyVersion("1.4.2.0")]
[assembly: AssemblyFileVersion("1.4.2.0")]
[assembly: AssemblyInformationalVersion("1.4.2")]

class TrayApp
{
    [DllImport("shell32.dll", SetLastError = true)]
    static extern int SetCurrentProcessExplicitAppUserModelID(string appID);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    const int SW_RESTORE = 9;
    const string AppTitle = "Typeless Toolkit";
    const string AppId = "TypelessToolkit.Desktop";

    static Process nodeProcess;
    static NotifyIcon trayIcon;
    static ManagerForm managerForm;
    static Mutex singleInstance;
    static string exeDir;
    static int managerPort = 7788;
    static string baseUrl;
    static string backendError;
    static bool exiting;

    [STAThread]
    static void Main()
    {
        // 让 WinForms 与 WebView2 使用相同的物理 DPI，避免系统位图缩放造成页面发糊。
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }

        bool createdNew;
        singleInstance = new Mutex(true, "TypelessToolkit.Desktop.SingleInstance", out createdNew);
        if (!createdNew)
        {
            ShowExistingWindow();
            return;
        }

        SetCurrentProcessExplicitAppUserModelID(AppId);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        exeDir = Path.GetDirectoryName(Application.ExecutablePath);
        managerPort = ReadManagerPort();
        baseUrl = "http://127.0.0.1:" + managerPort;

        if (!EnsureBackend())
        {
            MessageBox.Show(
                "无法启动本地服务。\n\n" + (backendError ?? "请确认 server\\manager.js 存在；Portable 版还应包含 runtime\\node.exe，Lite 版则需要安装 Node.js 22.12+。"),
                AppTitle,
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return;
        }

        BuildTray();
        managerForm = new ManagerForm(baseUrl, exeDir, LoadAppIcon());
        managerForm.FormClosing += OnManagerFormClosing;
        Application.Run(managerForm);
        Cleanup();
    }

    static void ShowExistingWindow()
    {
        IntPtr window = FindWindow(null, AppTitle);
        if (window != IntPtr.Zero)
        {
            ShowWindow(window, SW_RESTORE);
            SetForegroundWindow(window);
        }
    }

    static bool EnsureBackend()
    {
        if (IsPortOpen())
        {
            if (ProbeToolkit()) return true;
            int occupiedPort = managerPort;
            if (!UseFallbackPort())
            {
                backendError = "端口 " + occupiedPort + " 已被其他程序占用，且找不到可用的回退端口。请修改 data\\config.json 中的 manager_port。";
                return false;
            }
            AppendLauncherLog("端口 " + occupiedPort + " 已被其他程序占用，本次改用 " + managerPort + "。 ");
        }
        else if (!CanBindPort(managerPort))
        {
            int unavailablePort = managerPort;
            if (!UseFallbackPort())
            {
                backendError = "端口 " + unavailablePort + " 无法绑定，且找不到可用的回退端口。该端口可能被 Windows 保留，请修改 data\\config.json 中的 manager_port。";
                return false;
            }
            AppendLauncherLog("端口 " + unavailablePort + " 无法绑定（可能被 Windows 保留），本次改用 " + managerPort + "。 ");
        }

        string node = FindNode();
        if (node == null)
        {
            backendError = "未找到 Node.js。Portable 版应包含 runtime\\node.exe；Lite 版需要安装 Node.js 22.12+。";
            return false;
        }

        string serverDir = Path.Combine(exeDir, "server");
        string manager = Path.Combine(serverDir, "manager.js");
        if (!File.Exists(manager))
        {
            backendError = "缺少后端文件：" + manager + "。请完整解压发行包，不要单独复制或运行源码根目录中的 EXE。";
            return false;
        }

        string dataDir = Path.Combine(exeDir, "data");
        Directory.CreateDirectory(dataDir);

        nodeProcess = new Process();
        nodeProcess.StartInfo.FileName = node;
        nodeProcess.StartInfo.Arguments = "manager.js";
        nodeProcess.StartInfo.WorkingDirectory = serverDir;
        nodeProcess.StartInfo.CreateNoWindow = true;
        nodeProcess.StartInfo.UseShellExecute = false;
        nodeProcess.StartInfo.RedirectStandardError = true;
        nodeProcess.StartInfo.EnvironmentVariables["TYPELESS_DATA_DIR"] = dataDir;
        nodeProcess.StartInfo.EnvironmentVariables["TYPELESS_MANAGER_PORT"] = managerPort.ToString();

        try { nodeProcess.Start(); }
        catch (Exception error)
        {
            backendError = "无法启动 Node.js 后端：" + error.Message;
            return false;
        }

        for (int i = 0; i < 30; i++)
        {
            Thread.Sleep(200);
            if (IsPortOpen())
            {
                if (ProbeToolkit()) return true;
                backendError = "端口 " + managerPort + " 已被其他程序占用，无法确认本地服务身份。";
                return false;
            }
            if (nodeProcess.HasExited)
            {
                string details = "";
                try { details = nodeProcess.StandardError.ReadToEnd().Trim(); } catch { }
                backendError = details.Length > 0
                    ? "Node.js 后端启动失败：" + details
                    : "Node.js 后端已退出，退出代码 " + nodeProcess.ExitCode + "。";
                AppendLauncherLog(backendError);
                return false;
            }
        }
        backendError = "本地服务在端口 " + managerPort + " 上启动超时。";
        return false;
    }

    static bool CanBindPort(int port)
    {
        TcpListener listener = null;
        try
        {
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.ExclusiveAddressUse = true;
            listener.Start();
            return true;
        }
        catch { return false; }
        finally { if (listener != null) try { listener.Stop(); } catch { } }
    }

    static bool UseFallbackPort()
    {
        int preferred = managerPort;
        for (int offset = 1; offset <= 100; offset++)
        {
            int candidate = preferred + offset;
            if (candidate > 65535) break;
            if (CanBindPort(candidate))
            {
                managerPort = candidate;
                baseUrl = "http://127.0.0.1:" + managerPort;
                return true;
            }
        }
        for (int candidate = 17888; candidate <= 17988; candidate++)
        {
            if (CanBindPort(candidate))
            {
                managerPort = candidate;
                baseUrl = "http://127.0.0.1:" + managerPort;
                return true;
            }
        }
        return false;
    }

    static void AppendLauncherLog(string message)
    {
        try
        {
            string logDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "TypelessToolkit"
            );
            Directory.CreateDirectory(logDir);
            File.AppendAllText(
                Path.Combine(logDir, "launcher.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message.Trim() + Environment.NewLine
            );
        }
        catch { }
    }

    static int ReadManagerPort()
    {
        string[] candidates = new string[] {
            Path.Combine(exeDir, "data", "config.json"),
            Path.Combine(exeDir, "config.json"),
            Path.Combine(exeDir, "server", "config.json")
        };
        foreach (string candidate in candidates)
        {
            try
            {
                if (!File.Exists(candidate)) continue;
                string json = File.ReadAllText(candidate);
                Match match = Regex.Match(json, "\\\"manager_port\\\"\\s*:\\s*(\\d+)");
                int port;
                if (match.Success && int.TryParse(match.Groups[1].Value, out port) && port > 0 && port <= 65535)
                    return port;
            }
            catch { }
        }
        return 7788;
    }

    static bool ProbeToolkit()
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(baseUrl + "/api/env");
            request.Method = "GET";
            request.Timeout = 1000;
            request.ReadWriteTimeout = 1000;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                string body = reader.ReadToEnd();
                return response.StatusCode == HttpStatusCode.OK &&
                    body.IndexOf("\"status\":\"OK\"", StringComparison.Ordinal) >= 0 &&
                    body.IndexOf("\"service\":\"typeless-toolkit\"", StringComparison.Ordinal) >= 0;
            }
        }
        catch { return false; }
    }

    static bool IsPortOpen()
    {
        try
        {
            using (TcpClient client = new TcpClient())
            {
                IAsyncResult result = client.BeginConnect("127.0.0.1", managerPort, null, null);
                return result.AsyncWaitHandle.WaitOne(250) && client.Connected;
            }
        }
        catch { return false; }
    }

    static string FindNode()
    {
        // Portable release ships a pinned Node.js runtime beside the launcher.
        // Prefer it so the app works after extraction without a system install.
        string bundled = Path.Combine(exeDir, "runtime", "node.exe");
        if (File.Exists(bundled)) return bundled;

        string pathValue = Environment.GetEnvironmentVariable("PATH");
        if (pathValue == null) pathValue = "";
        foreach (string directory in pathValue.Split(';'))
        {
            if (string.IsNullOrWhiteSpace(directory)) continue;
            string file = Path.Combine(directory.Trim(), "node.exe");
            if (File.Exists(file)) return file;
        }

        string[] candidates = new string[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"),
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe"
        };
        foreach (string candidate in candidates) if (File.Exists(candidate)) return candidate;

        string nvm = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "nvm");
        if (Directory.Exists(nvm))
        {
            foreach (string directory in Directory.GetDirectories(nvm))
            {
                string file = Path.Combine(directory, "node.exe");
                if (File.Exists(file)) return file;
            }
        }
        return null;
    }

    static Icon LoadAppIcon()
    {
        string iconPath = Path.Combine(exeDir, "tray-icon.ico");
        try
        {
            if (File.Exists(iconPath)) return new Icon(iconPath);
            return Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch { return SystemIcons.Application; }
    }

    static void BuildTray()
    {
        trayIcon = new NotifyIcon();
        trayIcon.Icon = LoadAppIcon();
        trayIcon.Text = AppTitle;
        trayIcon.Visible = true;

        ContextMenu menu = new ContextMenu();
        menu.MenuItems.Add("打开管理器", delegate { OpenManager(); });
        menu.MenuItems.Add("刷新页面", delegate { if (managerForm != null) managerForm.ReloadPage(); });
        menu.MenuItems.Add("-");
        menu.MenuItems.Add("退出", delegate { ExitApplication(); });
        trayIcon.ContextMenu = menu;
        trayIcon.DoubleClick += delegate { OpenManager(); };
    }

    static void OpenManager()
    {
        if (managerForm == null || managerForm.IsDisposed) return;
        managerForm.Show();
        if (managerForm.WindowState == FormWindowState.Minimized)
            managerForm.WindowState = FormWindowState.Normal;
        managerForm.Activate();
        managerForm.BringToFront();
    }

    static void OnManagerFormClosing(object sender, FormClosingEventArgs e)
    {
        if (exiting) return;
        e.Cancel = true;
        managerForm.Hide();
    }

    static void ExitApplication()
    {
        exiting = true;
        if (managerForm != null) managerForm.Close();
        Application.Exit();
    }

    static void Cleanup()
    {
        if (trayIcon != null)
        {
            trayIcon.Visible = false;
            trayIcon.Dispose();
        }
        try
        {
            if (nodeProcess != null && !nodeProcess.HasExited) nodeProcess.Kill();
            if (nodeProcess != null) nodeProcess.Dispose();
        }
        catch { }
        if (singleInstance != null) singleInstance.Dispose();
    }
}

class ManagerForm : Form
{
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int valueSize);

    readonly string pageUrl;
    readonly string exeDir;
    WebView2 webView;
    Label loadingLabel;

    public ManagerForm(string url, string applicationDirectory, Icon appIcon)
    {
        pageUrl = url;
        exeDir = applicationDirectory;

        Text = "Typeless Toolkit";
        Icon = appIcon;
        BackColor = Color.FromArgb(15, 20, 32);
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96F, 96F);
        Rectangle workArea = Screen.PrimaryScreen.WorkingArea;
        Width = Math.Min(1440, Math.Max(880, workArea.Width - 80));
        Height = Math.Min(880, Math.Max(620, workArea.Height - 80));
        MinimumSize = new Size(880, 620);
        StartPosition = FormStartPosition.CenterScreen;

        loadingLabel = new Label();
        loadingLabel.Dock = DockStyle.Fill;
        loadingLabel.TextAlign = ContentAlignment.MiddleCenter;
        loadingLabel.Font = new Font("Microsoft YaHei UI", 11F);
        loadingLabel.Text = "正在打开 Typeless Toolkit…";
        Controls.Add(loadingLabel);

        Shown += async delegate { await InitializeBrowser(); };
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyTitleBarTheme(true);
    }

    void ApplyTitleBarTheme(bool dark)
    {
        if (!IsHandleCreated) return;
        try
        {
            int enabled = dark ? 1 : 0;
            // 20 为 Windows 10 20H1+，19 为较早版本的兼容值。
            if (DwmSetWindowAttribute(Handle, 20, ref enabled, 4) != 0)
                DwmSetWindowAttribute(Handle, 19, ref enabled, 4);

            // Windows 11：标题栏、文字和边框直接贴合页面主题色。
            int caption = dark ? 0x20140F : 0xF9F6F5;
            int text = dark ? 0xF0E9E6 : 0x2E1D16;
            int border = dark ? 0x3F3028 : 0xEFEBE9;
            DwmSetWindowAttribute(Handle, 35, ref caption, 4);
            DwmSetWindowAttribute(Handle, 36, ref text, 4);
            DwmSetWindowAttribute(Handle, 34, ref border, 4);
        }
        catch { }
    }

    async Task InitializeBrowser()
    {
        if (webView != null) return;

        try
        {
            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "TypelessToolkit",
                "WebView2"
            );
            Directory.CreateDirectory(profileDir);

            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profileDir);
            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            webView.DefaultBackgroundColor = Color.FromArgb(15, 20, 32);
            Controls.Add(webView);
            webView.BringToFront();

            await webView.EnsureCoreWebView2Async(environment);
            webView.ZoomFactor = 1.0;
            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
            webView.CoreWebView2.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs args)
            {
                try
                {
                    string message = args.TryGetWebMessageAsString();
                    if (message == "theme:dark") ApplyTitleBarTheme(true);
                    else if (message == "theme:light") ApplyTitleBarTheme(false);
                }
                catch { }
            };
            webView.CoreWebView2.Navigate(pageUrl);
        }
        catch (Exception error)
        {
            loadingLabel.Text = "无法初始化内嵌浏览器。\n请安装 Microsoft Edge WebView2 Runtime 后重试。\n\n" + error.Message;
        }
    }

    public void ReloadPage()
    {
        if (webView != null && webView.CoreWebView2 != null) webView.CoreWebView2.Reload();
    }
}
