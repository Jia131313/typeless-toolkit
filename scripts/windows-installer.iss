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
WizardStyle=modern
CloseApplications=no
RestartApplications=no
UninstallDisplayIcon={app}\TypelessToolkit.exe
SetupIconFile={#SourceDir}\tray-icon.ico
AppMutex=TypelessToolkit.Desktop.SingleInstance
SetupLogging=yes

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
Filename: "{app}\TypelessToolkit.exe"; Description: "启动 Typeless Toolkit"; Flags: nowait postinstall skipifsilent

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
begin
#if Edition == "lite"
  RuntimePage := CreateOutputMsgPage(wpWelcome, 'Lite 运行环境',
    'Lite 使用本机 Node.js，不会安装或修改系统 Node。', '');
  ExtractTemporaryFile('TypelessToolkit.exe');
  ExtractTemporaryFile('Microsoft.Web.WebView2.Core.dll');
  ExtractTemporaryFile('Microsoft.Web.WebView2.WinForms.dll');
  ExtractTemporaryFile('windows-build.json');
  if Exec(ExpandConstant('{tmp}\TypelessToolkit.exe'),
    '--probe-node-text "' + ExpandConstant('{tmp}\node-probe.txt') + '"', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and
    LoadStringFromFile(ExpandConstant('{tmp}\node-probe.txt'), ProbeResult) then
    RuntimePage.MsgLabel.Caption := UTF8Decode(ProbeResult)
  else
    RuntimePage.MsgLabel.Caption := '无法执行本机 Node 检查。Lite 不会安装 Node，请自行准备受支持的 Node 24 LTS，或选择内置 Node 安装版。';
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
    Result := '旧工具集仍在运行。请从托盘退出工具集后重试；不需要关闭 Typeless。';
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
    if InstallStarted then WriteUpdateResult('failed', '安装未完成，请查看安装器错误与安装日志；原用户数据保留。')
    else WriteUpdateResult('cancelled', '用户取消安装；原用户数据保留。');
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
