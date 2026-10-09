; Build parameters are supplied from windows-build.json by build-public-release.ps1.
[Setup]
AppId={#AppId}
AppName=Typeless Toolkit
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\{#InstallDirectory}
DefaultGroupName=Typeless Toolkit
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=TypelessToolkit-v{#AppVersion}-win-x64-{#Edition}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle={#WizardStyle}
WizardSizePercent={#WizardSizePercent}
WizardImageFile={#WizardImageFile}
WizardSmallImageFile={#WizardSmallImageFile}
WizardImageFileDynamicDark={#WizardImageFileDynamicDark}
WizardSmallImageFileDynamicDark={#WizardSmallImageFileDynamicDark}
DisableWelcomePage=no
ShowLanguageDialog=auto
CloseApplications=no
RestartApplications=no
UninstallDisplayIcon={app}\TypelessToolkit.exe
SetupIconFile={#SourceDir}\tray-icon.ico
AppMutex=TypelessToolkit.Desktop.SingleInstance
SetupLogging=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "installer\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[LangOptions]
DialogFontName={#WizardFontName}
DialogFontSize={#WizardFontSize}
WelcomeFontName={#WizardFontName}

[Messages]
chinesesimplified.SetupWindowTitle=安装 — Typeless 工具集
chinesesimplified.UninstallAppFullTitle=卸载 — Typeless 工具集
chinesesimplified.WelcomeLabel1=欢迎安装 Typeless 工具集
english.WelcomeLabel1=Welcome to Typeless Toolkit
chinesesimplified.SetupAppRunningError=Typeless 工具集仍在运行。%n%n请右键点击系统托盘中的工具集图标，选择“退出”，然后点击“确定”继续。仅关闭窗口会收纳到托盘。%n%n不需要关闭 Typeless 本体。
english.SetupAppRunningError=Typeless Toolkit is still running.%n%nRight-click its system tray icon and choose Exit, then click OK. Closing the window only minimizes it to the tray.%n%nYou do not need to close Typeless itself.
chinesesimplified.UninstallAppRunningError=Typeless 工具集仍在运行。%n%n请从系统托盘选择“退出”后继续卸载，不需要关闭 Typeless 本体。
english.UninstallAppRunningError=Typeless Toolkit is still running.%n%nChoose Exit from its system tray menu before uninstalling. You do not need to close Typeless itself.
chinesesimplified.SelectDirLabel3=程序将安装到下面的目录。账号、词库与配置独立保存，更新或卸载不会删除这些数据。
english.SelectDirLabel3=Program files go in the folder below. Accounts, dictionary and settings are stored separately and retained during updates and uninstall.
chinesesimplified.FinishedHeadingLabel=Typeless 工具集已安装
english.FinishedHeadingLabel=Typeless Toolkit is installed
chinesesimplified.FinishedLabel=安装完成。点击“完成”后即可打开工具集。%n%n原 ZIP 用户可进入“设置 → 同步与数据 → 备份与迁移”，展开“从旧 Windows ZIP 目录迁移”，迁入账号、词库与配置。旧目录不会自动删除。
chinesesimplified.FinishedLabelNoIcons=安装完成。点击“完成”后即可打开工具集。%n%n原 ZIP 用户可进入“设置 → 同步与数据 → 备份与迁移”，展开“从旧 Windows ZIP 目录迁移”，迁入账号、词库与配置。旧目录不会自动删除。
english.FinishedLabel=Installation is complete. Click Finish to open Typeless Toolkit.%n%nExisting ZIP users can open Settings → Sync & Data → Backup & Migration → Migrate from old Windows ZIP directory to transfer accounts, dictionary and settings. The old folder is not deleted.
english.FinishedLabelNoIcons=Installation is complete. Click Finish to open Typeless Toolkit.%n%nExisting ZIP users can open Settings → Sync & Data → Backup & Migration → Migrate from old Windows ZIP directory to transfer accounts, dictionary and settings. The old folder is not deleted.
chinesesimplified.ConfirmUninstall=确认卸载 Typeless 工具集及其程序组件吗？%n%n账号、词库和配置数据将保留。
english.ConfirmUninstall=Uninstall Typeless Toolkit and its program components?%n%nAccounts, dictionary and settings will be retained.

[CustomMessages]
chinesesimplified.LaunchToolkit=打开 Typeless 工具集
english.LaunchToolkit=Open Typeless Toolkit
chinesesimplified.WelcomeBody=在一个窗口中管理 Typeless 账号、个人词库、备份与同步。%n%n本次安装：%1%n版本：{#AppVersion}%n%n默认仅为当前 Windows 用户安装，不需要管理员权限。升级现有版本会保留用户数据。%n%n点击“下一步”继续。
english.WelcomeBody=Manage Typeless accounts, your dictionary, backups and sync in one desktop window.%n%nThis installation: %1%nVersion: {#AppVersion}%n%nInstalls for the current Windows user by default, without administrator privileges. Existing user data is retained during updates.%n%nClick Next to continue.
#if Edition == "lite"
chinesesimplified.EditionName=Lite 轻量版 · 使用本机 Node.js，需自行维护运行环境
english.EditionName=Lite · Uses your system Node.js, which you maintain yourself
#else
chinesesimplified.EditionName=内置 Node 版（推荐）· 自带运行环境，无需另装 Node.js
english.EditionName=Bundled Node (recommended) · Includes the runtime; no separate Node.js installation required
#endif
chinesesimplified.RuntimeHeading=检查 Lite 运行环境
english.RuntimeHeading=Check the Lite runtime
chinesesimplified.RuntimeDescription=使用本机 Node.js，不会安装或修改系统 Node。
english.RuntimeDescription=Uses your system Node.js without installing or modifying it.
chinesesimplified.RuntimeProbeFailed=无法完成本机 Node 检查。Lite 不包含运行环境，请先安装受支持的 Node LTS，或改用内置 Node 安装版。
english.RuntimeProbeFailed=The system Node.js check could not be completed. Lite does not include a runtime. Install a supported Node.js LTS or choose the bundled Node installer.
chinesesimplified.HostStillRunning=旧工具集仍在运行。请从系统托盘选择“退出”后重试；仅关闭窗口不够，不需要关闭 Typeless 本体。
english.HostStillRunning=The old Toolkit is still running. Choose Exit from its system tray menu and retry. Closing the window is not enough; you do not need to close Typeless itself.
chinesesimplified.InstallFailed=安装未完成。请查看安装器错误与安装日志；原用户数据保留。
english.InstallFailed=Installation did not complete. Check the installer error and setup log. Existing user data is retained.
chinesesimplified.InstallCancelled=已取消安装；原用户数据保留。
english.InstallCancelled=Installation was cancelled. Existing user data is retained.

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\TypelessToolkit.exe"; Flags: dontcopy
Source: "{#SourceDir}\Microsoft.Web.WebView2.Core.dll"; Flags: dontcopy
Source: "{#SourceDir}\Microsoft.Web.WebView2.WinForms.dll"; Flags: dontcopy
Source: "{#SourceDir}\windows-build.json"; Flags: dontcopy

[InstallDelete]
#if Edition == "lite"
Type: filesandordirs; Name: "{app}\runtime"
#endif

[Icons]
Name: "{userprograms}\Typeless Toolkit"; Filename: "{app}\TypelessToolkit.exe"

[Run]
Filename: "{app}\TypelessToolkit.exe"; Description: "{cm:LaunchToolkit}"; Flags: nowait postinstall skipifsilent

[Code]
const
  Synchronize = $00100000;
  WaitTimeout = $00000102;
function OpenProcess(Access: Cardinal; Inherit: Boolean; ProcessId: Cardinal): THandle;
  external 'OpenProcess@kernel32.dll stdcall';
function WaitForSingleObject(Handle: THandle; Milliseconds: Cardinal): Cardinal;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function CloseHandle(Handle: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';
function GetWindowThreadProcessId(Window: HWND; var ProcessId: Cardinal): Cardinal;
  external 'GetWindowThreadProcessId@user32.dll stdcall';
function GetCurrentProcessId(): Cardinal;
  external 'GetCurrentProcessId@kernel32.dll stdcall';

var
  Installed: Boolean;
  InstallStarted: Boolean;
  FailureRecorded: Boolean;
  RuntimePage: TOutputMsgWizardPage;

function JsonString(Value: String): String;
begin
  StringChangeEx(Value, '\', '\\', True);
  StringChangeEx(Value, '"', '\"', True);
  Result := '"' + Value + '"';
end;

procedure WriteUpdateResult(Status, ErrorMessage: String);
var
  FileName, Version: String;
begin
  FileName := ExpandConstant('{param:TOOLKITUPDATERESULT|}');
  Version := ExpandConstant('{param:TOOLKITUPDATEVERSION|}');
  if FileName = '' then Exit;
  SaveStringToFile(FileName, UTF8Encode(
    '{"stage":"install","status":' + JsonString(Status) +
    ',"target_version":' + JsonString(Version) +
    ',"error":' + JsonString(ErrorMessage) + '}'), False);
end;

procedure InitializeWizard();
var
  ExitCode: Integer;
  ProbeResult: AnsiString;
  ProbeArgument: String;
begin
  WizardForm.WelcomeLabel2.Caption := FmtMessage(CustomMessage('WelcomeBody'), [CustomMessage('EditionName')]);
#if Edition == "lite"
  RuntimePage := CreateOutputMsgPage(wpWelcome, CustomMessage('RuntimeHeading'),
    CustomMessage('RuntimeDescription'), '');
  ExtractTemporaryFile('TypelessToolkit.exe');
  ExtractTemporaryFile('Microsoft.Web.WebView2.Core.dll');
  ExtractTemporaryFile('Microsoft.Web.WebView2.WinForms.dll');
  ExtractTemporaryFile('windows-build.json');
  if ActiveLanguage = 'english' then ProbeArgument := '--probe-node-text-en'
  else ProbeArgument := '--probe-node-text';
  if Exec(ExpandConstant('{tmp}\TypelessToolkit.exe'),
    ProbeArgument + ' "' + ExpandConstant('{tmp}\node-probe.txt') + '"', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and
    LoadStringFromFile(ExpandConstant('{tmp}\node-probe.txt'), ProbeResult) then
    RuntimePage.MsgLabel.Caption := UTF8Decode(ProbeResult)
  else
    RuntimePage.MsgLabel.Caption := CustomMessage('RuntimeProbeFailed');
#endif
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  HostPid: Cardinal;
  ExitCode: Integer;
  HostHandle: THandle;
begin
  Result := '';
  HostPid := StrToIntDef(ExpandConstant('{param:TOOLKITHOSTPID|0}'), 0);
  if HostPid = 0 then
  begin
    GetWindowThreadProcessId(FindWindowByWindowName('Typeless Toolkit'), HostPid);
    if FileExists(ExpandConstant('{app}\TypelessToolkit.exe')) then
      Exec(ExpandConstant('{app}\TypelessToolkit.exe'), '--quit-for-install', '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
  end;
  if HostPid = 0 then Exit;
  HostHandle := OpenProcess(Synchronize, False, HostPid);
  if HostHandle = 0 then Exit;
  if WaitForSingleObject(HostHandle, {#WaitSeconds} * 1000) = WaitTimeout then
    Result := CustomMessage('HostStillRunning');
  CloseHandle(HostHandle);
  if Result <> '' then
  begin
    FailureRecorded := True;
    WriteUpdateResult('failed', Result);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then InstallStarted := True;
  if CurStep = ssPostInstall then
  begin
    Installed := True;
    WriteUpdateResult('installed', '');
  end;
end;

procedure DeinitializeSetup();
var
  Stage, Command: String;
  ExitCode: Integer;
begin
  if not Installed and not FailureRecorded then
  begin
    if InstallStarted then WriteUpdateResult('failed', CustomMessage('InstallFailed'))
    else WriteUpdateResult('cancelled', CustomMessage('InstallCancelled'));
  end;
  Stage := ExpandConstant('{param:TOOLKITUPDATESTAGE|}');
  if Stage <> '' then
  begin
    StringChangeEx(Stage, '''', '''''', True);
    Command := '-NoProfile -NonInteractive -Command "Wait-Process -Id ' + IntToStr(GetCurrentProcessId()) +
      ' -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ''' + Stage + ''' -Recurse -Force"';
    Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Command, '', SW_HIDE, ewNoWait, ExitCode);
  end;
end;
