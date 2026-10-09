using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
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
[assembly: AssemblyVersion("1.9.3.0")]
[assembly: AssemblyFileVersion("1.9.3.0")]
[assembly: AssemblyInformationalVersion("1.9.3")]

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
    const int BackendStartTimeoutMs = 10000;
    const int ToolkitProbeTimeoutMs = 1000;

    static Process nodeProcess;
    static NotifyIcon trayIcon;
    static ManagerForm managerForm;
    static Mutex singleInstance;
    static string exeDir;
    static int managerPort = 7788;
    static string baseUrl;
    static string backendError;
    static bool exiting;
    static bool backendReused;
    static string updateReadyPath;
    static string updateTargetVersion;
    static System.Windows.Forms.Timer quotaTimer;
    static bool quotaPollBusy;
    static string lastQuotaAlert;

    [STAThread]
    static void Main(string[] args)
    {
        // 让 WinForms 与 WebView2 使用相同的物理 DPI，避免系统位图缩放造成页面发糊。
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        ParseUpdateReadyArguments(args);

        bool createdNew;
        singleInstance = new Mutex(true, "TypelessToolkit.Desktop.SingleInstance", out createdNew);
        if (!createdNew)
        {
            ShowExistingWindow();
            return;
        }

        SetCurrentProcessExplicitAppUserModelID(AppId);
        EnsureAppUserModelId();
        EnsureStartMenuShortcut();
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

        if (!string.IsNullOrEmpty(updateReadyPath) && !SignalUpdateReady())
        {
            Cleanup();
            return;
        }

        BuildTray();
        string pageUrl = baseUrl + (backendReused ? "/?toolkit_backend=shared" : "/");
        managerForm = new ManagerForm(pageUrl, exeDir, LoadAppIcon());
        managerForm.FormClosing += OnManagerFormClosing;
        StartQuotaNotifications();
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

    static void ParseUpdateReadyArguments(string[] args)
    {
        if (args == null) return;
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] == "--toolkit-update-ready") updateReadyPath = args[++i];
            else if (args[i] == "--toolkit-update-version") updateTargetVersion = args[++i];
        }
        if (string.IsNullOrEmpty(updateReadyPath) || string.IsNullOrEmpty(updateTargetVersion))
        {
            updateReadyPath = null;
            updateTargetVersion = null;
            return;
        }
        try
        {
            string marker = Path.GetFullPath(updateReadyPath);
            string stage = Path.GetDirectoryName(marker);
            string tempRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (stage == null || Path.GetDirectoryName(stage) == null ||
                !string.Equals(Path.GetDirectoryName(stage).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), tempRoot, StringComparison.OrdinalIgnoreCase) ||
                !Path.GetFileName(stage).StartsWith("typeless-toolkit-update-", StringComparison.OrdinalIgnoreCase) ||
                !Regex.IsMatch(Path.GetFileName(marker), "^\\.typeless-toolkit-ready-[A-Za-z0-9]+\\.marker$") ||
                !Regex.IsMatch(updateTargetVersion, "^\\d+(?:\\.\\d+){1,3}$"))
            {
                updateReadyPath = null;
                updateTargetVersion = null;
                return;
            }
            updateReadyPath = marker;
        }
        catch
        {
            updateReadyPath = null;
            updateTargetVersion = null;
        }
    }

    static bool SignalUpdateReady()
    {
        try
        {
            if (!ProbeToolkit(updateTargetVersion)) return false;
            File.WriteAllText(updateReadyPath, updateTargetVersion + Environment.NewLine);
            return true;
        }
        catch { return false; }
    }

    static bool EnsureBackend()
    {
        if (IsPortOpen())
        {
            if (ProbeExistingToolkit())
            {
                backendReused = true;
                return true;
            }
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
        nodeProcess.StartInfo.EnvironmentVariables["TYPELESS_TOOLKIT_HOST_PID"] = Process.GetCurrentProcess().Id.ToString();
        nodeProcess.StartInfo.EnvironmentVariables["TYPELESS_TOOLKIT_BACKEND_OWNER"] = "desktop-host";
        nodeProcess.StartInfo.EnvironmentVariables["TYPELESS_TOOLKIT_INSTALL_DIR"] = exeDir;

        try { nodeProcess.Start(); }
        catch (Exception error)
        {
            backendError = "无法启动 Node.js 后端：" + error.Message;
            return false;
        }

        Stopwatch startupTimer = Stopwatch.StartNew();
        while (true)
        {
            int remainingMs = BackendStartTimeoutMs - (int)startupTimer.ElapsedMilliseconds;
            if (remainingMs <= 0) break;
            Thread.Sleep(Math.Min(200, remainingMs));
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
            if (!IsPortOpen()) continue;
            remainingMs = BackendStartTimeoutMs - (int)startupTimer.ElapsedMilliseconds;
            if (remainingMs <= 0) break;
            if (ProbeToolkit(null, Math.Min(ToolkitProbeTimeoutMs, remainingMs))) return true;
        }
        backendError = "本地服务在端口 " + managerPort + " 上启动超时（" + BackendStartTimeoutMs / 1000 + " 秒内未就绪）。";
        AppendLauncherLog(backendError);
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

    /// <summary>
    /// 注册本进程的通知标识。Windows 把托盘气泡转成系统通知时，要从
    /// AppUserModelId 解析“应用名”；未注册时该字段会显示成乱码。
    /// 只写当前用户(HKCU)，不需要管理员权限。
    /// </summary>
    static void EnsureAppUserModelId()
    {
        try
        {
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(
                @"SOFTWARE\Classes\AppUserModelId\" + AppId))
            {
                if (key == null) return;
                key.SetValue("DisplayName", AppTitle, Microsoft.Win32.RegistryValueKind.String);
                key.SetValue("IconUri", Application.ExecutablePath, Microsoft.Win32.RegistryValueKind.String);
                key.SetValue("IconBackgroundColor", "0", Microsoft.Win32.RegistryValueKind.String);
            }
        }
        catch (Exception error) { AppendLauncherLog("注册通知标识失败：" + error.Message); }
    }

    // ---------- 开始菜单快捷方式 ----------
    // Win32 应用要在系统通知里正确显示“应用名”，除了注册 AppUserModelId 注册表项，
    // 还必须在开始菜单有一个携带同一 AppUserModelID 的快捷方式。
    // 便携版没有安装程序，只能首次启动时自己补一个。

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    internal class ShellLinkCoClass { }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
        void Resolve(IntPtr hwnd, int fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPersistFile
    {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, int dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    internal struct PropertyKey
    {
        public Guid fmtid;
        public int pid;
    }

    [StructLayout(LayoutKind.Explicit)]
    internal struct PropVariant
    {
        [FieldOffset(0)] public short vt;
        [FieldOffset(8)] public IntPtr pointerValue;
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        void GetCount(out int cProps);
        void GetAt(int iProp, out PropertyKey pkey);
        void GetValue(ref PropertyKey key, out PropVariant pv);
        void SetValue(ref PropertyKey key, ref PropVariant pv);
        void Commit();
    }

    static void EnsureStartMenuShortcut()
    {
        try
        {
            string exe = Application.ExecutablePath;
            string linkPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppTitle + ".lnk");
            // 已存在就直接沿用,不反复重建(避免覆盖用户自己调整过的快捷方式)
            if (File.Exists(linkPath)) return;

            var link = (IShellLinkW)(object)new ShellLinkCoClass();
            link.SetPath(exe);
            link.SetWorkingDirectory(Path.GetDirectoryName(exe));
            link.SetIconLocation(exe, 0);
            link.SetDescription(AppTitle);

            var key = new PropertyKey();
            key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); // PKEY_AppUserModel_ID
            key.pid = 5;
            var value = new PropVariant();
            value.vt = 31; // VT_LPWSTR
            value.pointerValue = Marshal.StringToCoTaskMemUni(AppId);
            try
            {
                var store = (IPropertyStore)link;
                store.SetValue(ref key, ref value);
                store.Commit();
            }
            finally { Marshal.FreeCoTaskMem(value.pointerValue); }

            ((IPersistFile)link).Save(linkPath, true);
            Marshal.FinalReleaseComObject(link);
        }
        catch (Exception error) { AppendLauncherLog("创建开始菜单快捷方式失败：" + error.Message); }
    }

    // ---------- 自绘提示窗口 ----------
    // 系统通知(ShowBalloonTip)在未注册 AppUserModelID 的便携应用上，会把“应用名”
    // 显示成乱码，且注册表项、开始菜单快捷方式、重启 explorer 都无法消除。
    // 因此改用自绘窗口：外观可控，也不依赖系统通知平台。

    // 提示窗口跟随管理页面的外观主题;页面还没加载过时先按系统主题取值。
    // ManagerForm 在另一个类里,所以这里用 internal 以便跨类同步。
    internal static bool toastDarkTheme = SystemUsesDarkTheme();

    static bool SystemUsesDarkTheme()
    {
        try
        {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
            {
                object value = key == null ? null : key.GetValue("AppsUseLightTheme");
                if (value is int) return (int)value == 0;
            }
        }
        catch (Exception) { }
        return true; // 取不到时按深色,与工具集默认观感一致
    }

    class ToastForm : Form
    {
        readonly System.Windows.Forms.Timer closeTimer;
        int remaining;

        // 不抢焦点:用户正在听写或打字时弹提示，绝不能把键盘输入抢走
        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
                cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW:不出现在 Alt+Tab
                return cp;
            }
        }

        public ToastForm(string title, string body, bool warning)
        {
            Font titleFont = new Font("Microsoft YaHei UI", 10.5f, FontStyle.Bold);
            Font bodyFont = new Font("Microsoft YaHei UI", 9f);
            Font metaFont = new Font("Microsoft YaHei UI", 8f);

            // 跟随管理页面的外观主题(浅色 / 深色 / 跟随系统在页面侧已解析成具体值)
            bool dark = toastDarkTheme;
            Color background = dark ? Color.FromArgb(32, 33, 38) : Color.FromArgb(252, 252, 253);
            Color titleColor = dark ? Color.White : Color.FromArgb(26, 28, 33);
            Color bodyColor = dark ? Color.FromArgb(198, 200, 208) : Color.FromArgb(78, 82, 90);
            Color metaColor = dark ? Color.FromArgb(150, 152, 160) : Color.FromArgb(128, 132, 140);
            Color borderColor = dark ? Color.FromArgb(58, 60, 66) : Color.FromArgb(219, 222, 228);

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = background;
            Padding = new Padding(0);

            Size bodySize = TextRenderer.MeasureText(body, bodyFont,
                new Size(326, 0), TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
            Width = 386;
            Height = 34 + 24 + bodySize.Height + 16;

            Color accent = warning
                ? (dark ? Color.FromArgb(240, 190, 70) : Color.FromArgb(198, 138, 18))
                : (dark ? Color.FromArgb(96, 170, 245) : Color.FromArgb(38, 118, 210));

            // 无边框窗口在浅色背景上需要一圈描边才立得住
            Paint += delegate(object s, PaintEventArgs e)
            {
                using (var pen = new Pen(borderColor))
                    e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
            };

            var appName = new Label();
            appName.Text = AppTitle;
            appName.ForeColor = metaColor;
            appName.Font = metaFont;
            appName.AutoSize = false;
            appName.Location = new Point(16, 8);
            appName.Size = new Size(240, 16);

            var close = new Label();
            close.Text = "✕";
            close.ForeColor = metaColor;
            close.Font = metaFont;
            close.AutoSize = false;
            close.TextAlign = ContentAlignment.MiddleCenter;
            close.Location = new Point(Width - 30, 6);
            close.Size = new Size(20, 18);
            close.Cursor = Cursors.Hand;
            close.Click += (s, e) => HideToast();

            var mark = new Label();
            mark.Text = warning ? "!" : "i";
            mark.ForeColor = accent;
            mark.Font = new Font("Segoe UI", 17f, FontStyle.Bold);
            mark.AutoSize = false;
            mark.TextAlign = ContentAlignment.MiddleCenter;
            mark.Location = new Point(16, 34);
            mark.Size = new Size(26, 30);

            var titleLabel = new Label();
            titleLabel.Text = title;
            titleLabel.ForeColor = titleColor;
            titleLabel.Font = titleFont;
            titleLabel.AutoSize = false;
            titleLabel.Location = new Point(50, 38);
            titleLabel.Size = new Size(312, 22);

            var bodyLabel = new Label();
            bodyLabel.Text = body;
            bodyLabel.ForeColor = bodyColor;
            bodyLabel.Font = bodyFont;
            bodyLabel.AutoSize = false;
            bodyLabel.Location = new Point(50, 62);
            bodyLabel.Size = new Size(326, bodySize.Height);

            Controls.Add(appName);
            Controls.Add(close);
            Controls.Add(mark);
            Controls.Add(titleLabel);
            Controls.Add(bodyLabel);

            // 点窗体和点正文都打开管理器
            EventHandler open = (s, e) => { HideToast(); OpenManager(); };
            Click += open;
            titleLabel.Click += open;
            bodyLabel.Click += open;
            mark.Click += open;
            appName.Click += open;

            closeTimer = new System.Windows.Forms.Timer();
            closeTimer.Interval = 1000;
            closeTimer.Tick += (s, e) => { if (--remaining <= 0) HideToast(); };
        }

        public void ShowToast(int seconds)
        {
            remaining = seconds;
            Rectangle area = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(area.Right - Width - 16, area.Bottom - Height - 16);
            Show();
            closeTimer.Start();
        }

        void HideToast()
        {
            closeTimer.Stop();
            Hide();
        }
    }

    static ToastForm activeToast;

    static void ShowToast(string title, string body, bool warning)
    {
        try
        {
            if (activeToast != null && !activeToast.IsDisposed) activeToast.Dispose();
            activeToast = new ToastForm(title, body, warning);
            activeToast.ShowToast(8);
        }
        catch (Exception error) { AppendLauncherLog("提示窗口失败：" + error.Message); }
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

    static bool ProbeExistingToolkit()
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(baseUrl + "/api/env");
            request.Method = "GET";
            request.Timeout = 3000;
            request.ReadWriteTimeout = 3000;
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

    static bool ProbeToolkit(string expectedVersion = null, int timeoutMs = ToolkitProbeTimeoutMs)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(baseUrl + "/api/ready");
            request.Method = "GET";
            request.Timeout = timeoutMs;
            request.ReadWriteTimeout = timeoutMs;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                string body = reader.ReadToEnd();
                bool valid = response.StatusCode == HttpStatusCode.OK &&
                    body.IndexOf("\"status\":\"OK\"", StringComparison.Ordinal) >= 0 &&
                    body.IndexOf("\"service\":\"typeless-toolkit\"", StringComparison.Ordinal) >= 0;
                if (!valid) return false;
                return string.IsNullOrEmpty(expectedVersion) || Regex.IsMatch(
                    body,
                    "\\\"toolkit_version\\\"\\s*:\\s*\\\"" + Regex.Escape(expectedVersion) + "\\\""
                );
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

    static bool SupportsSqlite(string node)
    {
        try
        {
            using (Process probe = new Process())
            {
                probe.StartInfo.FileName = node;
                probe.StartInfo.Arguments = "-e \"try { require('node:sqlite'); process.stdout.write('ok'); } catch (e) { process.exit(1); }\"";
                probe.StartInfo.CreateNoWindow = true;
                probe.StartInfo.UseShellExecute = false;
                probe.StartInfo.RedirectStandardOutput = true;
                probe.StartInfo.RedirectStandardError = true;
                probe.Start();
                if (!probe.WaitForExit(3000))
                {
                    try { probe.Kill(); } catch { }
                    return false;
                }
                return probe.ExitCode == 0 && probe.StandardOutput.ReadToEnd().Trim() == "ok";
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

        string[] candidates = new string[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"),
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe"
        };

        string fallback = null;
        Func<string, string> consider = delegate(string file)
        {
            if (string.IsNullOrWhiteSpace(file) || !File.Exists(file)) return null;
            if (fallback == null) fallback = file;
            if (SupportsSqlite(file)) return file;
            return null;
        };

        string pathValue = Environment.GetEnvironmentVariable("PATH");
        if (pathValue == null) pathValue = "";
        foreach (string directory in pathValue.Split(';'))
        {
            if (string.IsNullOrWhiteSpace(directory)) continue;
            string file = Path.Combine(directory.Trim(), "node.exe");
            string selected = consider(file);
            if (selected != null) return selected;
        }

        foreach (string candidate in candidates)
        {
            string selected = consider(candidate);
            if (selected != null) return selected;
        }

        string nvm = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "nvm");
        if (Directory.Exists(nvm))
        {
            foreach (string directory in Directory.GetDirectories(nvm))
            {
                string file = Path.Combine(directory, "node.exe");
                string selected = consider(file);
                if (selected != null) return selected;
            }
        }
        // Lite can still run without node:sqlite; only automatic account switching is unavailable.
        return fallback;
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
        trayIcon.BalloonTipClicked += delegate { OpenManager(); };
    }

    static void StartQuotaNotifications()
    {
        quotaTimer = new System.Windows.Forms.Timer();
        quotaTimer.Interval = 10000;
        quotaTimer.Tick += async delegate
        {
            if (quotaPollBusy || exiting) return;
            quotaPollBusy = true;
            try
            {
                // 原生计时器独立于隐藏 WebView 的页面计时器，只读后端缓存。
                string alert = await Task.Run(() =>
                {
                    var request = (HttpWebRequest)WebRequest.Create(baseUrl + "/api/quota-monitor/notification");
                    request.Timeout = 3000;
                    request.ReadWriteTimeout = 3000;
                    request.Proxy = null;
                    using (var response = request.GetResponse())
                    using (var reader = new StreamReader(response.GetResponseStream()))
                        return reader.ReadToEnd().Trim();
                });
                if (exiting || trayIcon == null || string.IsNullOrEmpty(alert) || alert == lastQuotaAlert) return;
                // 前缀区分提示类型:auto=即将自动切换,failed=自动切换失败
                bool autoSwitch = alert.StartsWith("auto:", StringComparison.Ordinal);
                bool autoFailed = alert.StartsWith("failed:", StringComparison.Ordinal);
                string alertId = autoSwitch ? alert.Substring(5) : (autoFailed ? alert.Substring(7) : alert);
                if (!Regex.IsMatch(alertId, @"^\d+-\d+$")) return;
                lastQuotaAlert = alert;
                // 用自绘提示替代系统气泡:便携应用的系统通知会把“应用名”显示成乱码
                if (autoSwitch)
                    ShowToast("Typeless 即将自动切换账号",
                        "当前账号额度已达阈值，15 秒后自动切换。点击打开管理器可取消。", true);
                else if (autoFailed)
                    ShowToast("Typeless 自动切换失败",
                        "没有切换到备用账号，额度仍然不足。请打开管理器查看原因并手动切换。", true);
                else
                    ShowToast("Typeless 额度提醒",
                        "当前账号额度不足。点击打开管理器，听写完成后可确认切换备用账号。", false);
            }
            catch (WebException) { /* 后端重启或暂不可用时，下次轮询重试。 */ }
            catch (Exception error) { AppendLauncherLog("额度提醒失败：" + error.Message); }
            finally { quotaPollBusy = false; }
        };
        quotaTimer.Start();
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
        ExitForToolkitUpdate();
    }

    // Windows 自更新 helper 已在临时目录启动后，界面通过 WebView2 请求完整退出。
    // Cleanup 会结束由本宿主启动的 Node 服务；helper 随后才替换程序文件。
    internal static void ExitForToolkitUpdate()
    {
        exiting = true;
        if (managerForm != null) managerForm.Close();
        Application.Exit();
    }

    static void Cleanup()
    {
        if (quotaTimer != null) { quotaTimer.Stop(); quotaTimer.Dispose(); }
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
                    // 页面在“跟随系统”时也会解析成 light/dark 再发过来,这里直接采用即可
                    if (message == "theme:dark") { TrayApp.toastDarkTheme = true; ApplyTitleBarTheme(true); }
                    else if (message == "theme:light") { TrayApp.toastDarkTheme = false; ApplyTitleBarTheme(false); }
                    else if (message == "toolkit-update:quit") TrayApp.ExitForToolkitUpdate();
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
