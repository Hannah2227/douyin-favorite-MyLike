using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using DouyinShuffle.Win.Capture;
using DouyinShuffle.Win.Export;
using DouyinShuffle.Win.Player;
using DouyinShuffle.Win.Storage;
using Microsoft.Web.WebView2.Core;

namespace DouyinShuffle.Win;

/// <summary>
/// 主窗口:UI 宿主 + WebView2 编排。业务职责已拆出:
/// - CollectOrchestrator:采集全流程编排(探测/两级采集/风控自愈/断点续采);
/// - LikeCollector(Capture/):采集执行与消息泵,脚本在 Capture/Scripts/;
/// - PlaybackController(Player/):播放队列/取链/预取;
/// - AppLog:统一日志。
/// 本类只保留:窗口生命周期、WebView2 环境、UI 桥接命令泵、视图切换、登录窗口编排。
/// 所有命令在 UI 线程异步执行(await,不 .Result),绝无死锁。
/// </summary>
public partial class MainWindow : Window
{
    private readonly string _rootDir;      // DouyinShuffle 根(账号清单所在)
    private string _dataDir;               // 当前账号数据目录(Data\<profile>)
    private readonly string _uiDir;
    private string _profileDir;            // 当前账号 WebView2 profile(Profiles\<profile>)
    private CoreWebView2Environment? _env;
    private DouyinAuthWindow? _authWindow;
    private DouyinPageWindow? _pageWindow;
    private DouyinEngineWindow? _engineWindow;
    private LikeCollector? _collector;
    private LikeListStore? _store;
    private PlaybackController? _player;
    // 新增：批量取消点赞服务；与原有采集/本地删除逻辑独立。
    private UnlikeService? _unlikeService;
    private CancellationTokenSource? _unlikeCts;   // 批量取消点赞:运行中令牌(防重入 + 停止)
    private bool _playerUnlikeBusy;                 // 播放页内单条取消点赞:忙标志(防重复)
    private CollectOrchestrator? _orchestrator;

    /// <summary>账号清单(多账号:每账号独立 profile + 数据目录;单账号/老用户只有一项)。</summary>
    private AccountRegistry _accounts = new();

    /// <summary>当前在线账号(随切换变更;ProfileName 是 Data\Profiles 目录名主键)。</summary>
    private AccountInfo _account = new() { ProfileName = "default" };

    /// <summary>应用级设置(settings.json:主题等,与账号无关 —— 换账号不该改外观)。</summary>
    private Storage.AppSettings _settings = new();

    /// <summary>WebView 体系是否已初始化(幂等闸;换舱走 Teardown/Init 不经此标志)。</summary>
    private bool _coreReadyOnce;

    /// <summary>抖音引擎页的 Core(屏幕外常显窗口里;登录态/签名/采集引擎)。</summary>
    private CoreWebView2? DouyinCore => _engineWindow?.Core;

    internal bool IsShuttingDown { get; private set; }
    internal LikeCollector? Collector => _collector;
    internal CoreWebView2? DouyinCoreInternal => DouyinCore;

    /// <summary>验证窗口是否打开(打开期间点「采集」应提示等待,而不是启动新一轮刺激接口)。</summary>
    internal bool IsVerifyWindowOpen => _authWindow != null;

    public MainWindow()
    {
        InitializeComponent();
        _rootDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DouyinShuffle");
        _uiDir = Path.Combine(Path.GetTempPath(), "dsh_ui_" + Process.GetCurrentProcess().Id);
        // 账号解析:老用户(default 目录)迁移成 user1;之后按 accounts.json 记录恢复上次账号。
        // 目录结构:%LOCALAPPDATA%\DouyinShuffle\{accounts.json,settings.json, Profiles\<profile>, Data\<profile>}
        _settings = Storage.AppSettings.Load(_rootDir);
        // 启动即套用记忆的主题(窗口露边底色在页面加载前就要对,否则深色下先闪一帧浅色)
        ApplyWindowTheme(_settings.Theme);
        _account = ResolveStartupAccount(out _dataDir, out _profileDir);
        Closed += OnClosed;
        // WebView2 控件初始化必须在窗口完全呈现后(ContentRendered):
        // 代码注入的 WebView2 控件在 Loaded 阶段 EnsureCoreWebView2Async 会因视觉树
        // 尚未完成呈现而 HwndHost 创建失败(ObjectDisposedException)。
        // ★Loaded 不再订阅 OnLoadedAsync(它曾先于 ContentRendered 触发,用未呈现控件初始化即崩)。
        ContentRendered += (_, _) => { if (!_coreReadyOnce) OnLoadedAsync(this, new RoutedEventArgs()); };
        StateChanged += OnStateChanged;
        SizeChanged += (_, _) => QueueNudgeSettled();   // 尺寸变化后 WebView(HwndHost)可能错位(连续缩放时去抖,停稳再排)
        DpiChanged += (_, _) => QueueNudgeAll();   // 跨屏拖动/系统缩放比变化:DIP 尺寸不变但物理像素变,
                                                   // HwndHost 子窗口不重排就会把整页渲染进左上角一块
                                                   // (200% 缩放下正好 1/4 —— "播放页平移到左上角"的根源之一)
        LocationChanged += (_, _) => QueueNudgeSettled();   // ★窗口拖动后子窗口坐标可能失同步(自绘标题栏
                                                            // 的 Win32 模态拖动期间 WebView2 收不到正常
                                                            // 位置更新)。★必须去抖:拖动中每次移动都
                                                            // nudge 会对可见 WebView 反复抖动重排 = 频闪,
                                                            // 停稳 150ms 后只补排一次。
        try { Icon = CreateHeartIcon(); } catch { }
        SourceInitialized += (_, _) =>
        {
            // 挂 WndProc 钩子:捕获 WM_EXITSIZEMOVE(拖动/缩放模态循环结束的精确信号)。
            // ★句柄此时必须已存在(SourceInitialized 语义保证);仍判空防御,避免
            // HwndSource.FromHwnd(0) 抛 "Hwnd of zero is not valid" 连锁崩溃。
            var helper = new System.Windows.Interop.WindowInteropHelper(this);
            var hwnd = helper.Handle;
            if (hwnd == IntPtr.Zero) { AppLog.Write("wndproc hook skipped: hwnd zero"); return; }
            System.Windows.Interop.HwndSource.FromHwnd(hwnd)?.AddHook(WndProcHook);
        };
    }

    // ---------- 无边框窗口:状态联动 ----------

    /// <summary>
    /// 启动时账号解析(v1.0.7 终版:零拷贝、零询问、秒开):
    /// ① 老用户(无 accounts.json + 存在 Data\default)→ **不复制任何数据**,
    ///    首个账号 user1 **直接指到 default 目录**(数据+登录态原地就是它的)。
    ///    旧版曾整体复制 Data+Profiles(数百 MB,启动卡数秒)——纯浪费,default
    ///    本来就是它的数据,引用即可。default 仅在被多账号覆盖后留作回退,无需备份。
    /// ② 有清单 → 恢复上次使用账号(CurrentProfile)。
    /// ③ 全新安装 → 建首个 user1(目录空,登录时生成)。
    /// </summary>
    private AccountInfo ResolveStartupAccount(out string dataDir, out string profileDir)
    {
        _accounts = AccountRegistry.Load(_rootDir);
        var legacyData = Path.Combine(_rootDir, "Data", "default");
        var legacyProfile = Path.Combine(_rootDir, "Profiles", "default");

        // ① 老用户:清单为空 + 存在老 default 数据 → user1 直接"指到"default 目录(零拷贝)
        if (_accounts.Accounts.Count == 0 && Directory.Exists(legacyData))
        {
            var acc = new AccountInfo
            {
                ProfileName = "user1",
                DisplayName = "账号1",
                CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                LastUsedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
            };
            // ★回填 sec_uid:老 state.json 里的 SecUserId 是同人检测的依据
            try
            {
                var st = Path.Combine(legacyData, "state.json");
                if (File.Exists(st))
                {
                    var state = Newtonsoft.Json.JsonConvert.DeserializeObject<Storage.SyncState>(File.ReadAllText(st));
                    acc.SecUid = state?.SecUserId ?? "";
                }
            }
            catch { }
            _accounts.Accounts.Add(acc);
            _accounts.CurrentProfile = acc.ProfileName;
            // ★零拷贝引用写进清单:default 原地就是它的数据/登录态,以后新增、删除、切换
            //   账号都按这条绑定走,不会因为"账号数变了"而改指到别的目录
            if (Directory.Exists(legacyData)) acc.DataDirName = "default";
            if (Directory.Exists(legacyProfile)) acc.ProfileDirName = "default";
            _accounts.Save(_rootDir);
            AppLog.Write($"ACCOUNT legacy default -> user1 (zero-copy reference, secUid={(acc.SecUid.Length > 0 ? "filled" : "empty")}, data={acc.DataDirName})");
        }
        else if (_accounts.Accounts.Count == 0)
        {
            // ③ 全新安装:建首个账号
            var acc = new AccountInfo
            {
                ProfileName = "user1",
                DisplayName = "账号1",
                CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
            };
            _accounts.Accounts.Add(acc);
            _accounts.CurrentProfile = acc.ProfileName;
            _accounts.Save(_rootDir);
        }
        else
        {
            // ② 有清单:确认上次账号存在(被手动删目录等异常时回退到第一个)
            if (_accounts.Current == null)
            {
                _accounts.CurrentProfile = _accounts.Accounts[0].ProfileName;
                _accounts.Save(_rootDir);
            }
        }

        // ★历史清单(没有绑定字段)先修复绑定,再解析目录 —— 顺序不能反,否则本次运行
        //   仍会按"账号名拼目录"给出另一个答案,和上次运行的数据目录对不上
        RepairLegacyDirBinding(legacyData, legacyProfile);

        var cur = _accounts.Current!;
        cur.LastUsedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        _accounts.Save(_rootDir);
        dataDir = DataDirOf(cur);
        profileDir = ProfileDirOf(cur);
        return cur;
    }

    /// <summary>修复"清单里没记绑定、而 default 与同名目录并存"的历史状态(自检发现的目录改指问题)。
    /// 判定依据:谁最近被写过(items.dylist 最后写入时间)谁就是本机实际在用的那份。
    /// 只写清单里的绑定名,不移动/不复制/不删除任何目录 —— 另一份原样留着可找回。</summary>
    private void RepairLegacyDirBinding(string legacyData, string legacyProfile)
    {
        if (!Directory.Exists(legacyData)) return;
        var changed = false;
        foreach (var a in _accounts.Accounts)
        {
            if (a.DataDirName.Length > 0 || a.ProfileDirName.Length > 0) continue;   // 已有绑定:不动
            var ownData = Path.Combine(_rootDir, "Data", a.ProfileName);
            if (!Directory.Exists(ownData)) continue;
            var legacyNewer = LastWriteOf(Path.Combine(legacyData, "items.dylist"))
                              > LastWriteOf(Path.Combine(ownData, "items.dylist"));
            AppLog.Write($"ACCOUNT binding check {a.ProfileName}: defaultNewer={legacyNewer}");
            if (!legacyNewer) continue;
            a.DataDirName = "default";
            if (Directory.Exists(legacyProfile)) a.ProfileDirName = "default";
            changed = true;
            AppLog.Write($"ACCOUNT binding repaired {a.ProfileName} -> default (profile-named dir kept aside)");
        }
        if (changed) _accounts.Save(_rootDir);
    }

    private static DateTime LastWriteOf(string path)
    {
        try { return File.Exists(path) ? File.GetLastWriteTimeUtc(path) : DateTime.MinValue; }
        catch { return DateTime.MinValue; }
    }

    /// <summary>持久化账号清单(切换/重命名/头像更新后调用)。</summary>
    private void SaveAccounts()
    {
        _account.LastUsedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        _accounts.Save(_rootDir);
    }

    // ---------- 账号目录绑定(单一真源) ----------
    // ★修复(自检发现):早期版本"数据目录/登录态目录"有两条推断路径 ——
    //   ① ResolveStartupAccount:账号数==1 且存在 default → 指到 default(零拷贝)
    //   ② SwitchAccountAsync / 删除 / 合并:直接按 ProfileName 拼目录
    //   两条路径对同一账号给出不同答案,而清单里没有任何记录 → 用户新增第二个账号或
    //   从别的账号切回来时,user1 会静默从 `Data\default` 改指到 `Data\user1`(旧拷贝)。
    //   现在:目录名一律经这两个方法取,且解析结果写进 accounts.json(AccountInfo.DataDirName)。
    private string DataDirOf(AccountInfo a)
        => Path.Combine(_rootDir, "Data", string.IsNullOrEmpty(a.DataDirName) ? a.ProfileName : a.DataDirName);

    private string ProfileDirOf(AccountInfo a)
        => Path.Combine(_rootDir, "Profiles", string.IsNullOrEmpty(a.ProfileDirName) ? a.ProfileName : a.ProfileDirName);

    // ---------- 外观主题(应用级,存 settings.json;见 Storage/AppSettings.cs) ----------
    /// <summary>应用窗口露边底色(WebView 是 HwndHost 不透明,露边区域必须与页面主题配套)。
    /// 传空 = 宿主还没记过主题 → 不动(保持 XAML 默认浅色,等页面上报后采纳)。</summary>
    private void ApplyWindowTheme(string theme)
    {
        if (theme.Length == 0) return;
        var dark = theme == "dark";
        try
        {
            Background = new System.Windows.Media.SolidColorBrush(
                (System.Windows.Media.Color)System.Windows.Media.ColorConverter
                    .ConvertFromString(dark ? "#16171B" : "#F5F6F8"));
        }
        catch { }
    }

    // ---------- 账号切换(轻量换舱) ----------
    // 流程:确认可切 → Teardown(停任务/收口互斥/落盘旧账号/拆 WebView)→ 切 profile/数据目录
    //       → InitWebViewCoreAsync 重建(登录态在新 profile 里,无需重新扫码)→ UI 推送新账号身份。
    private volatile bool _switchingAccount;

    private async Task SwitchAccountAsync(AccountInfo target, bool openLoginAfterSwitch = false)
    {
        if (!Dispatcher.CheckAccess()) { _ = Dispatcher.BeginInvoke(() => SwitchAccountAsync(target, openLoginAfterSwitch)); return; }
        if (_switchingAccount) return;
        _switchingAccount = true;
        try
        {
            // 1. 过场页(主题底色 + 三步进度,替代黑盒等待)
            DispatchUi("window.__dsh_accountSwitching && window.__dsh_accountSwitching(true, 1)");
            _windowFullscreen = false;   // 退出全屏状态(重建后 z-order/尺寸重新校准)
            ExitFullscreen();

            // 2. 拆旧舱(停任务/落盘/拆 WebView;此时数据仍指向旧账号目录)
            await TeardownWebViewCoreAsync();
            DispatchUi("window.__dsh_accountSwitching && window.__dsh_accountSwitching(true, 2)");

            // 3. 切账号身份与目录
            _account = target;
            _account.LastUsedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            _accounts.CurrentProfile = target.ProfileName;
            _accounts.Save(_rootDir);
            _dataDir = DataDirOf(target);
            _profileDir = ProfileDirOf(target);
            AppLog.Write($"ACCOUNT switch -> {target.ProfileName} ({target.DisplayName}) data={Path.GetFileName(_dataDir)} profile={Path.GetFileName(_profileDir)}");

            // 4. 建新舱(登录态随 profile 恢复;数据源已指向新账号目录)
            await InitWebViewCoreAsync();
            DispatchUi("window.__dsh_accountSwitching && window.__dsh_accountSwitching(true, 3)");

            // 5. 新增账号模式:首次进入新 profile → 必然未登录 → 直接弹登录窗
            if (openLoginAfterSwitch)
            {
                if (!await IsLoggedInAsync())
                    OpenAuthWindow(DouyinAuthWindow.AuthMode.Login);
            }

            // 6. UI 推送新账号身份(头像面板 + 登录态)
            DispatchUi("window.__dsh_accountsChanged && window.__dsh_accountsChanged()");
            await PushStateAsync();
        }
        catch (Exception ex)
        {
            AppLog.Write("ACCOUNT SWITCH ERR " + ex);
            MessageBox.Show(this, $"切换账号失败:{ex.Message}\n\n请重启应用重试。", "MyLike",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            _switchingAccount = false;
            DispatchUi("window.__dsh_accountSwitching && window.__dsh_accountSwitching(false)");
        }
    }

    /// <summary>登录成功后回填账号档案(sec_uid/头像昵称),账号面板显示用。
    /// ★同一性归一(v1.0.7 终版,无弹窗):一个抖音号只允许属于一个"应用账号"。
    /// 若登录的抖音号此前登记在其他档案下,自动把那份档案**并入当前账号**
    /// (数据目录改名跟随当前 profile,旧档案删除)——用户视角:"我登录了,数据就在",
    /// 零决策零弹窗。多账号的存在意义由此收敛为:不同抖音号 = 不同应用账号。</summary>
    private async Task RefreshCurrentAccountProfileAsync()
    {
        try
        {
            var core = DouyinCore;
            if (core == null) return;
            var (health, secUid) = await DouyinProbe.CheckHealthAsync(core);
            if (health != ApiHealth.Ok || secUid.Length == 0) return;

            // ★同一性归一:sec_uid 命中其他档案 → 整个旧档案并入当前账号(静默)
            var prior = _accounts.Accounts.FirstOrDefault(a =>
                a.ProfileName != _account.ProfileName && a.SecUid == secUid && a.SecUid.Length > 0);
            if (prior != null)
            {
                MergeAccountsIntoCurrent(prior);
                toast($"已合并同一抖音号的数据(来自 {prior.DisplayName})");
                await ReloadDataLayerAsync();
                await PushStateAsync();
                DispatchUi("window.__dsh_accountsChanged && window.__dsh_accountsChanged()");
                return;
            }

            _account.SecUid = secUid;
            // 头像/昵称:复用引擎页上下文抓 profile/self(轻量,仅登录后一次)
            var raw = await core.ExecuteScriptAsync(
                "fetch('https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&version_code=290100&cookie_enabled=true&platform=PC',{credentials:'include'})" +
                ".then(function(r){return r.text()}).catch(function(e){return 'err'})");
            try
            {
                var jo = Newtonsoft.Json.Linq.JObject.Parse(raw?.Trim('"').Replace("\\\"", "\"") ?? "{}");
                var user = jo["user"];
                if (user != null)
                {
                    var nick = user.Value<string>("nickname");
                    var avatar =
                        (user["avatar_larger"]?["url_list"]?.First as Newtonsoft.Json.Linq.JValue)?.Value as string ??
                        (user["avatar_medium"]?["url_list"]?.First as Newtonsoft.Json.Linq.JValue)?.Value as string ?? "";
                    if (!string.IsNullOrWhiteSpace(nick)) _account.DisplayName = nick;
                    _account.AvatarUrl = avatar;
                }
            }
            catch { }
            SaveAccounts();
            DispatchUi("window.__dsh_accountsChanged && window.__dsh_accountsChanged()");
        }
        catch (Exception ex) { AppLog.Write("ACCOUNT profile refresh err " + ex.Message); }
    }

    /// <summary>
    /// 把 other 档案并入当前账号(_account):同一抖音号的两种壳归一为一个。
    /// 数据迁移方向:谁的目录里有真数据(items.Count>0),就并入谁;
    /// 双方都有数据时保守处理:保留当前账号的数据,把 other 的数据目录改名为
    /// otherProfile_merged_<时间戳> 留档(绝不删除用户数据)。
    /// 完成后:other 档案从清单删除,登录态(other profile)随目录一并归档。
    /// </summary>
    private void MergeAccountsIntoCurrent(AccountInfo other)
    {
        try
        {
            var curData = DataDirOf(_account);
            var othData = DataDirOf(other);
            long curCount = 0, othCount = 0;
            try { curCount = ReadItemCount(curData); } catch { }
            try { othCount = ReadItemCount(othData); } catch { }

            if (othCount > 0 && curCount == 0)
            {
                // 数据在旧壳,当前是空壳 → 整目录交换:旧数据目录改名成当前 profile 名
                var moved = Path.Combine(_rootDir, "Data", _account.ProfileName + "_old_" + DateTime.Now.ToString("MMdd_HHmmss"));
                if (Directory.Exists(curData)) Directory.Move(curData, moved);
                if (Directory.Exists(othData)) Directory.Move(othData, curData);
                _dataDir = curData;
            }
            else if (othCount > 0 && curCount > 0)
            {
                // 双方都有数据:当前优先,旧数据留档不删
                var keep = Path.Combine(_rootDir, "Data", other.ProfileName + "_merged_" + DateTime.Now.ToString("MMdd_HHmmss"));
                if (Directory.Exists(othData)) Directory.Move(othData, keep);
                AppLog.Write($"ACCOUNT merge: both sides had data, old kept at {keep}");
            }
            // othCount==0:旧壳无数据,直接删档案即可(目录留空壳无妨)

            // 登录态目录:other profile 里有登录 cookie,当前壳现在也登录着同一号;
            // 把 other 的 profile 目录改名留档(不删,防用户想找回),清单删除 other
            var othProfile = ProfileDirOf(other);
            if (Directory.Exists(othProfile))
            {
                try { Directory.Move(othProfile, othProfile + "_merged_" + DateTime.Now.ToString("MMdd_HHmmss")); } catch { }
            }

            _account.SecUid = secUidOf(other) ?? _account.SecUid;
            if (string.IsNullOrWhiteSpace(_account.DisplayName) || _account.DisplayName.StartsWith("账号"))
                _account.DisplayName = other.DisplayName;   // 继承更友好的名字
            _accounts.Accounts.Remove(other);
            if (_accounts.CurrentProfile == other.ProfileName) _accounts.CurrentProfile = _account.ProfileName;
            SaveAccounts();
            AppLog.Write($"ACCOUNT merged {other.ProfileName} into {_account.ProfileName} (cur={curCount}, other={othCount})");
        }
        catch (Exception ex)
        {
            AppLog.Write("ACCOUNT merge err " + ex);
        }
    }

    /// <summary>读某账号数据目录的 items count(合并决策用;异常返回 0)。</summary>
    private long ReadItemCount(string dataDir)
    {
        var p = Path.Combine(dataDir, "items.dylist");
        if (!File.Exists(p)) return 0;
        using var fs = File.OpenRead(p);
        using var sr = new StreamReader(fs);
        var head = sr.ReadLine() ?? "";
        // 文件是单行紧凑 JSON:{"app":...,"count":N,...}
        var m = System.Text.RegularExpressions.Regex.Match(head, "\"count\":(\\d+)");
        return m.Success ? long.Parse(m.Groups[1].Value) : 0;
    }

    private string? secUidOf(AccountInfo a) => string.IsNullOrEmpty(a.SecUid) ? null : a.SecUid;

    /// <summary>换数据目录后重建数据层(store/collector 重读新目录;UI 列表刷新)。
    /// 仅轻量重载(不动 WebView 体系,登录态不受影响)。</summary>
    private async Task ReloadDataLayerAsync()
    {
        try
        {
            _orchestrator?.Stop();
            for (var i = 0; i < 20 && _orchestrator is { IsCollecting: true }; i++) await Task.Delay(250);
            _store = new LikeListStore(_dataDir);
            var (saved, state) = await Task.Run(() => (_store.LoadItems(), _store.LoadState()));
            _collector?.Clear();
            _collector?.Seed(saved, state.MaxCursor);
            _orchestrator?.SeedState(state.SecUserId, state.CollectIncomplete);
            DispatchUi("window.__dsh_refresh && window.__dsh_refresh()");
            await PushStateAsync();
        }
        catch (Exception ex) { AppLog.Write("ACCOUNT data reload err " + ex.Message); }
    }

    /// <summary>给当前账号数据域弹 toast 的便捷方法(账号面板流程用)。</summary>
    private void toast(string msg) => DispatchUi($"window.__dsh_toast && window.__dsh_toast({JsonText(msg)},false)");

    /// <summary>拖动窗口(Win32 模态拖动循环)。CSS app-region 失效时的兜底。</summary>
    private void DragWindow()
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(DragWindow); return; }
        var hwnd = new System.Windows.Interop.WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero) return;
        Win32.ReleaseCapture();
        Win32.SendMessage(hwnd, Win32.WM_NCLBUTTONDOWN, (IntPtr)Win32.HTCAPTION, IntPtr.Zero);
    }

    /// <summary>精确的"拖动/缩放模态循环结束"信号(WM_EXITSIZEMOVE):
    /// 比去抖计时器可靠 —— 模态循环结束后 LocationChanged 可能不再补发,而这是
    /// HwndHost 子窗口 rect 最容易滞留旧值的时刻,立即硬对齐一次。</summary>
    private void OnExitsSizeMove()
    {
        if (IsShuttingDown) return;
        // 交给排程序列执行:此时刚出模态循环,布局/渲染管线需要先走完一拍
        Dispatcher.BeginInvoke(new Action(() =>
        {
            try
            {
                UpdateLayout();
                NudgeWebView(PlayerWebView);
                NudgeWebView(UiWebView);
            }
            catch { }
        }), System.Windows.Threading.DispatcherPriority.Loaded);
    }

    private IntPtr WndProcHook(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        const int WM_EXITSIZEMOVE = 0x0232;
        if (msg == WM_EXITSIZEMOVE)
        {
            OnExitsSizeMove();
        }
        return IntPtr.Zero;
    }

    private void OnStateChanged(object? sender, EventArgs e)
    {
        // 最大化时无边框窗口会溢出屏幕边缘 ~8px,补偿内边距;
        // 全屏(WindowStyle.None)本就该铺满屏幕,不补偿 → 否则四周露一圈窗口底色白框
        var compensate = WindowState == WindowState.Maximized && WindowStyle != WindowStyle.None;
        RootGrid.Margin = compensate ? new Thickness(8) : new Thickness(0);
        DispatchUi($"window.__dsh_winState && window.__dsh_winState({(WindowState == WindowState.Maximized ? "true" : "false")})");
        QueueNudgeAll();   // 窗口状态变化后 WebView(HwndHost)可能错位,节流重排
    }

    /// <summary>红色爱心图标(渲染为 256x256 位图)。</summary>
    private static ImageSource CreateHeartIcon()
    {
        const int size = 256;
        var geo = Geometry.Parse("M 12,21.35 L 10.55,20.03 C 5.4,15.36 2,12.28 2,8.5 2,5.42 4.42,3 7.5,3 9.24,3 10.91,3.81 12,5.09 13.09,3.81 14.76,3 16.5,3 19.58,3 22,5.42 22,8.5 22,12.28 18.6,15.36 13.45,20.03 Z");
        var dv = new DrawingVisual();
        using (var dc = dv.RenderOpen())
        {
            dc.PushTransform(new ScaleTransform(size / 24.0, size / 24.0));
            dc.DrawGeometry(new SolidColorBrush(Color.FromRgb(0xE1, 0x1D, 0x48)), null, geo);
            dc.Pop();
        }
        var bmp = new RenderTargetBitmap(size, size, 96, 96, PixelFormats.Pbgra32);
        bmp.Render(dv);
        bmp.Freeze();
        return bmp;
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        IsShuttingDown = true;
        TrySaveResumeSnapshot();   // ★直接关窗口时的进度补记(否则这次播放位置不会被记住)
        try { FlushSaveSync(); } catch { }
        try { if (_uiDir.StartsWith(Path.GetTempPath())) Directory.Delete(_uiDir, true); } catch { }
        _authWindow?.Close();
        try { _engineWindow?.Close(); } catch { }
        _pageWindow?.Close();
    }

    private async void OnLoadedAsync(object? sender, RoutedEventArgs e)
    {
        if (_coreReadyOnce) return;   // 幂等:ContentRendered 只初始化一次(换舱走 SwitchAccountAsync)
        _coreReadyOnce = true;
        try
        {
            // WebView2 Runtime 前置检测:缺失时(Win10 LTSC/精简系统常见)给明确指引,
            // 否则用户只看到一个空白窗口(CreateAsync 抛异常但 UI 未起,toast 无处显示)
            try
            {
                var ver = CoreWebView2Environment.GetAvailableBrowserVersionString();
                AppLog.Write("webview2 runtime " + ver);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                AppLog.Write("INIT FAILED: WebView2 Runtime missing");
                MessageBox.Show(this,
                    "未检测到 WebView2 运行时,应用无法启动。\n\n请先安装 Microsoft WebView2 Runtime(免费,约 2 分钟):\nhttps://developer.microsoft.com/microsoft-edge/webview2/\n\n安装完成后重新打开本应用即可。",
                    "MyLike 启动失败", MessageBoxButton.OK, MessageBoxImage.Error);
                Close();
                return;
            }

            ExtractWebUi();
            await InitWebViewCoreAsync();
        }
        catch (Exception ex)
        {
            AppLog.Write("INIT FAILED: " + ex);
            MessageBox.Show(this, $"初始化失败:{ex.Message}\n\n若提示 WebView2 相关错误,请先安装 WebView2 运行时:\nhttps://developer.microsoft.com/microsoft-edge/webview2/",
                "MyLike 启动失败", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();   // 不留空白残窗
        }
    }

    /// <summary>
    /// WebView 体系构建(启动与"换账号舱"共用):
    /// ① 按当前账号 profile 创建 CoreWebView2Environment(登录态所在);
    /// ② Ui/Player WebView(必要时先 Dispose 旧的)→ EnsureCoreWebView2Async;
    /// ③ 引擎窗/存储/采集器/编排器/播放器重建并接线;
    /// ④ 导航本地 UI + 抖音引擎页,恢复 z-order。
    /// 换账号 = TeardownWebViewCoreAsync() → 改 _account/_dataDir/_profileDir → 本方法。
    /// </summary>
    private async Task InitWebViewCoreAsync()
    {
        Directory.CreateDirectory(_profileDir);
        Directory.CreateDirectory(_dataDir);

        // ① 环境:profile 目录绑定在 Environment 上(换账号 = 换目录 = 新环境)。
        // Chromium 子进程退出有延迟,防 profile 锁冲突:短重试。
        CoreWebView2Environment env = null!;
        for (var attempt = 0; ; attempt++)
        {
            try { env = await CoreWebView2Environment.CreateAsync(null, _profileDir); break; }
            catch (Exception ex) when (attempt < 3)
            {
                AppLog.Write($"ENV create retry {attempt + 1}: {ex.Message}");
                await Task.Delay(1500);
            }
        }
        _env = env;

        // ② 两个 WebView:已有实例(换舱)→ 先拆再建(WebView2 控件的 CoreWebView2 一经创建
        //    不能换环境,必须 Dispose 控件重建;这是官方支持的生命周期用法)。
        //    ★顺序注意:必须只经 ReplaceWebView 完成替换+Dispose 旧控件 + 挂新控件,
        //    然后才赋 UiWebView/PlayerWebView 属性 —— 若先赋属性(=把 _uiWebViewHost 指向新控件)
        //    再 Replace,slot 已指向新控件,Remove/Dispose 会把刚建的新控件销毁(启动崩溃真因)。
        var newUi = CreateWebView();
        var newPlayer = CreateWebView();
        ReplaceWebView(ref _uiWebViewHost, newUi);
        ReplaceWebView(ref _playerWebViewHost, newPlayer);
        UiWebView = newUi;
        PlayerWebView = newPlayer;
        // ★双保险:EnsureCoreWebView2Async 要求控件已连接到"已呈现"的视觉树。
        // 若此刻控件尚未完成 Loaded 路由(刚挂进视觉树,下一拍才置位),延后到 Dispatcher.Loaded
        // 再 Ensure。★注意:InvokeAsync(async lambda) 是 async void 语义、立即返回 —— 必须用
        // TCS 真正等待内部 await 完成,否则后续 CoreWebView2 访问全是 null(换账号崩溃真因)。
        if (!UiWebView.IsLoaded)
        {
            AppLog.Write("INIT: webview not routed-loaded yet, defer core init one beat");
            var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            await Dispatcher.InvokeAsync(async () =>
            {
                try
                {
                    await UiWebView.EnsureCoreWebView2Async(env);
                    await PlayerWebView.EnsureCoreWebView2Async(env);
                }
                finally { tcs.TrySetResult(true); }
            }, System.Windows.Threading.DispatcherPriority.Loaded);
            await tcs.Task;   // 等 async 委托真正跑完(含内部 await)
        }
        else
        {
            await Task.WhenAll(
                UiWebView.EnsureCoreWebView2Async(env),
                PlayerWebView.EnsureCoreWebView2Async(env));
        }
#if !DEBUG
        // 发布版关闭 DevTools(防 F12/右键检查被浏览器层截获,与页面快捷键自定义冲突)
        try { UiWebView.CoreWebView2!.Settings.AreDevToolsEnabled = false; } catch { }
        try { PlayerWebView.CoreWebView2!.Settings.AreDevToolsEnabled = false; } catch { }
#endif
        // 关闭浏览器层加速键(F5 刷新/Ctrl+R/F3 查找等):本地应用页无浏览器刷新语义,
        // 且会与播放页"自定义快捷键"冲突(F5 等被浏览器层吃掉,页面收不到)。
        try { UiWebView.CoreWebView2!.Settings.AreBrowserAcceleratorKeysEnabled = false; } catch { }
        try { PlayerWebView.CoreWebView2!.Settings.AreBrowserAcceleratorKeysEnabled = false; } catch { }
        // 抖音引擎页:独立屏幕外窗口(HwndHost 不受 WPF z-order 裁剪,不能在主窗口里叠放)
        _engineWindow = new DouyinEngineWindow();
        _engineWindow.Owner = this;
        _engineWindow.Show();
        await _engineWindow.EnsureAsync(env);
        // ★引擎页静音(v1.0.7:修复"登录后有声音,隐藏抖音页在放视频"):
        // 隐藏页在 douyin.com 首页会自动起播 feed 视频。认证窗早就注册了 mute-media.js
        // (文档创建时注入),引擎窗漏了 —— 补上同样的文档级注入,每次导航新文档都自动静音。
        try { await _engineWindow.EngineWebView.CoreWebView2!.AddScriptToExecuteOnDocumentCreatedAsync(ScriptLoader.Get("mute-media.js")); }
        catch (Exception ex) { AppLog.Write("engine mute script err " + ex.Message); }
        AppLog.Write("webview cores ready");
        // 播放页媒体请求改写 Referer/UA(防盗链):只对播放页开,不影响抖音页签名
        InstallMediaHeaderRewrite(PlayerWebView.CoreWebView2!);

        // 存储 + 采集器(挂在抖音页)
        _store = new LikeListStore(_dataDir);
        if (_store.HasLegacyData()) { _store.MigrateLegacy(); }
        // 大数据量(几十万条 = 几十 MB JSON)启动读盘耗时秒级,放后台线程避免卡启动画面
        var (saved, state) = await Task.Run(() => (_store.LoadItems(), _store.LoadState()));

        _collector = new LikeCollector(DouyinCore!);
        _unlikeService = new UnlikeService(DouyinCore!);   // 进度/结果由 UnlikeRunAsync 统一转发
        _collector.Seed(saved, state.MaxCursor);
        var collecting = false;
        _collector.StatusChanged += msg =>
        {
            AppLog.Write("DIAG " + msg);
            if (collecting) DispatchUi($"window.__dsh_collectStatus && window.__dsh_collectStatus({JsonText(msg)})");
        };
        _collector.Diagnostic += msg => AppLog.Write("DIAG " + msg);
        _collector.CountChanged += count => DispatchUi($"window.__dsh_count && window.__dsh_count({count})");

        // 采集编排器(风控事件接线)
        _orchestrator = new CollectOrchestrator(this);
        _orchestrator.SeedState(state.SecUserId, state.CollectIncomplete);
        collecting = true;   // StatusChanged 闭包用(与编排器生命周期一致,简化传参)
        _collector.RiskDetected += _orchestrator.OnCollectRisk;
        await _collector.InstallAsync();
        // 注意:引擎页保持"零初始化脚本"的干净状态:
        // 任何文档创建时的 fetch 包装都会干扰 webmssdk 签名层 → 直连被黑洞。

        InitPlayer();

        // 播放页导航到本地 player.html(与 UI 同目录提取)
        _playerPageTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        PlayerWebView.CoreWebView2!.NavigationCompleted += (_, npc) =>
        {
            if (npc.IsSuccess) _playerPageTcs.TrySetResult(true);
        };
        PlayerWebView.CoreWebView2!.Navigate(Path.Combine(_uiDir, "player.html"));

        // UI 异步桥接(唯一通道:postMessage;不再用同步 host object,避免死锁)
        UiWebView.CoreWebView2!.WebMessageReceived += OnUiMessage;
        UiWebView.CoreWebView2!.Navigate(Path.Combine(_uiDir, "index.html"));

        // 隐藏抖音页,静默导航建立登录态(若已登录;未登录不弹窗)
        DouyinCore!.NavigationCompleted += OnDouyinNavCompleted;
        DouyinCore!.Navigate(DouyinProbe.DouyinHomeUrl);

        // ★启动 z-order 钉死:两个 WebView 常驻可见(z-order 切换方案),谁在上层必须显式
        // 声明 —— 若播放页(黑底)排在主界面上,启动就是黑屏。主界面为启动视图。
        RaiseWebViewToTop(UiWebView);
        UiWebView.Focus();

        AppLog.Write($"ACCOUNT online: {_account.ProfileName} ({_account.DisplayName}) data={Path.GetFileName(_dataDir)} profile={Path.GetFileName(_profileDir)}");
        await PushStateAsync();
    }

    /// <summary>换账号前的拆卸:停任务、关窗、Dispose WebView 控件(环境随最后一个引用释放)。</summary>
    private async Task TeardownWebViewCoreAsync()
    {
        IsShuttingDown = true;   // 复用总开关:挡住所有 DispatchUi/SaveLoop 异步尾
        try
        {
            // 停采集(等退出,防编排器在旧 Core 上继续跑)
            _orchestrator?.Stop();
            for (var i = 0; i < 20 && _orchestrator is { IsCollecting: true }; i++) await Task.Delay(250);
            // 停批量 unlike
            _unlikeCts?.Cancel();
            for (var i = 0; i < 20 && _unlikeCts != null; i++) await Task.Delay(250);
            // 收尾落盘(旧账号数据)★顺序:必须在换 _dataDir 之前,快照才落在旧账号目录里
            TrySaveResumeSnapshot();
            try { FlushSaveSync(); } catch { }
            // 关窗(引擎/认证/原页都持旧 env 引用)
            _authWindow?.Close(); _authWindow = null;
            try { _engineWindow?.Close(); } catch { }
            _engineWindow = null;
            _pageWindow?.Close(); _pageWindow = null;
            // 拆播放器与采集器引用(事件订阅随对象丢弃)
            _player = null;
            _collector = null;
            _unlikeService = null;
            _orchestrator = null;
            _store = null;
            // 拆两个 WebView 控件(Grid 中移除 + Dispose;CoreWebView2 不能换环境必须重建)
            await Dispatcher.InvokeAsync(() =>
            {
                ReplaceWebView(ref _uiWebViewHost, null);
                ReplaceWebView(ref _playerWebViewHost, null);
            });
            _env = null;
            // 给 Chromium 子进程退出时间(防新 profile 被锁)
            await Task.Delay(1500);
        }
        finally
        {
            IsShuttingDown = false;
        }
        GC.Collect();   // 提前回收旧 WebView2 包装对象,加速浏览器进程退出
        GC.WaitForPendingFinalizers();
        GC.Collect();
    }

    // ---------- WebView 控件管理(账号"换舱"时 Dispose 重建,引用经属性转发全代码零改动) ----------
    // XAML 只留容器 Grid(WebViewHost);两个控件实例由代码注入,以下属性供既有代码按原名访问。
    private Microsoft.Web.WebView2.Wpf.WebView2? _uiWebViewHost;
    private Microsoft.Web.WebView2.Wpf.WebView2? _playerWebViewHost;

    /// <summary>主界面 WebView(原 XAML x:Name="UiWebView",现为代码管理的实例)。</summary>
    public Microsoft.Web.WebView2.Wpf.WebView2 UiWebView
    {
        get => _uiWebViewHost ?? throw new InvalidOperationException("UiWebView not initialized");
        private set => _uiWebViewHost = value;
    }

    /// <summary>播放页 WebView(原 XAML x:Name="PlayerWebView",现为代码管理的实例)。</summary>
    public Microsoft.Web.WebView2.Wpf.WebView2 PlayerWebView
    {
        get => _playerWebViewHost ?? throw new InvalidOperationException("PlayerWebView not initialized");
        private set => _playerWebViewHost = value;
    }

    private Microsoft.Web.WebView2.Wpf.WebView2 CreateWebView()
    {
        return new Microsoft.Web.WebView2.Wpf.WebView2
        {
            DefaultBackgroundColor = System.Drawing.Color.Black   // 该属性是 Drawing.Color(Web 控件历史签名)
        };
    }

    /// <summary>把容器里的旧 WebView 控件替换为新实例(null = 仅移除并 Dispose)。</summary>
    private void ReplaceWebView(ref Microsoft.Web.WebView2.Wpf.WebView2? slot, Microsoft.Web.WebView2.Wpf.WebView2? newInstance)
    {
        if (slot != null)
        {
            try { WebViewHost.Children.Remove(slot); } catch { }
            try { slot.Dispose(); } catch { }
        }
        slot = newInstance;
        if (newInstance != null)
        {
            WebViewHost.Children.Add(newInstance);
        }
    }

    /// <summary>播放器初始化与事件接线(原 OnLoadedAsync 的一段,拆出便于阅读)。</summary>
    private void InitPlayer()
    {
        _lastExitWasManual = false;
        _player = new PlaybackController(PlayerWebView.CoreWebView2!);
        _player.FreshUrlFetcher = id => _collector?.FetchFreshUrlsByApiAsync(id)
            ?? Task.FromResult<FreshMedia?>(null);
        _player.PageReadyTask = WaitForPlayerPageAsync();   // 初始化完成前点播放 → 等页面就绪
        _player.CurrentChanged += (it, idx) =>
        {
            if (it != null)
                DispatchUi($"window.__dsh_onPlaying && window.__dsh_onPlaying({JsonText($"{idx + 1}/{_player.Queue.Count} {it.AuthorName} - {Truncate(it.Desc, 30)}")})");
        };
        _player.Closed += () =>
        {
            ExitFullscreen();
            ShowUiOnly();
            DispatchUi("window.__dsh_onPlaying && window.__dsh_onPlaying('')");
        };
        // 播放进度保留:手动退出 → 落盘快照(队列 id 顺序 + 当前条目 + 位置);下次播放前提示"继续/重新洗牌"
        _player.Stopped += manual =>
        {
            if (manual) _lastExitWasManual = true;
            else ClearResumeSnapshot();   // manual=false 只出现在"整轮播完"这一种情况 → 没有继续的意义
        };
        _player.SnapshotRequested += (awemeId, pos) =>
        {
            SaveResumeSnapshot(awemeId, pos, _player?.Queue.Select(i => i.AwemeId).ToList() ?? new List<string>());
        };
        _player.Notice += msg => DispatchUi($"window.__dsh_toast && window.__dsh_toast({JsonText(msg)},false)");
        // 播放页窗口控制(拖动热区/最小化/最大化/关闭):复用自绘标题栏的 Win32 通道
        _player.WindowCommand += cmd =>
        {
            if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(() => WindowCommandHandler(cmd)); return; }
            WindowCommandHandler(cmd);
        };
        _player.RiskDetected += OnPlayerRisk;
        _player.FullscreenToggleRequested += ToggleFullscreen;
        _player.UnlikeRequested += OnPlayerUnlikeRequested;
        _player.PageOpened += awemeId =>
        {
            if (_pageWindow != null) { _pageWindow.NavigateTo(awemeId); _pageWindow.Activate(); return; }
            var win = new DouyinPageWindow(_env!, awemeId);
            _pageWindow = win;
            win.Owner = this;   // 随主窗关闭,避免任务栏残留"僵尸"窗口
            win.ClosedByUser += () =>
            {
                _pageWindow = null;
                Dispatcher.BeginInvoke(() =>
                {
                    // 播放已停止时不切回播放页(否则黑屏盖住列表)
                    if (_player is { IsActive: true }) ShowPlayer();
                    _player?.ResumeAfterNavigate();
                });
            };
            win.Show();
        };
        _player.ResumeRequested += () =>
        {
            ShowPlayer();
            _player?.ResumeAfterNavigate();
        };

        // 自动连播:开关变化 → 落盘 + 同步主界面勾选态(播放页 toggle / 主界面切换 / 启动恢复统一入口)
        _player.AutoNextChanged += on =>
        {
            _store?.SaveAutoNext(on);
            DispatchUi($"window.__dsh_autoNext && window.__dsh_autoNext({(on ? "true" : "false")})");
        };
        _player.SetAutoNext(_store?.LoadState().AutoNext ?? false);   // 恢复上次选择(默认关)
    }

    // ---------- 播放页内单条取消点赞 ----------
    // 与批量 unlike(_unlikeCts 通道)相互独立:播放中批量 unlike 已被互斥拦截,
    // 故播放页单条执行时不存在并发批量;单条忙标志仅防本入口重复点击。
    // 成功(HTTP 2xx + status_code=0)才删本地并落盘;失败保留(与批量口径一致)。
    // ---------- 播放进度快照("继续上次播放"的数据来源) ----------
    private bool _lastExitWasManual;   // 上次播放退出是否手动(false=自然播完;决定是否提示"继续上次")

    /// <summary>落盘续播快照(写当前账号数据目录;失败只记日志,绝不影响退出流程)。</summary>
    private void SaveResumeSnapshot(string awemeId, double posSec, List<string> queueIds)
    {
        if (awemeId.Length == 0) return;
        try
        {
            new ResumeStore(_dataDir).Save(new ResumeSnapshot
            {
                AwemeId = awemeId,
                PositionSec = posSec,
                QueueIds = queueIds,
                ManualExit = _lastExitWasManual
            });
        }
        catch (Exception ex) { AppLog.Write("RESUME save err " + ex.Message); }
    }

    /// <summary>清掉续播快照(整轮播完 / 用户主动放弃续播):之后主界面不再提示"继续上次播放"。</summary>
    private void ClearResumeSnapshot()
    {
        try { new ResumeStore(_dataDir).Delete(); }
        catch (Exception ex) { AppLog.Write("RESUME clear err " + ex.Message); }
    }

    /// <summary>收尾时补记快照(直接关窗口 / 切换账号拆舱):播放页回包通道已经不可用,
    /// 只能同步取宿主已知的最后位置。仅在"确实在播"时写 —— 否则会覆盖掉用户上次手动退出的快照。</summary>
    private void TrySaveResumeSnapshot()
    {
        try
        {
            var snap = _player?.SnapshotNow();
            if (snap == null) return;
            _lastExitWasManual = true;   // 直接关窗 = 用户主动中断,下次应提示"继续上次播放"
            SaveResumeSnapshot(snap.Value.Id, snap.Value.Pos, snap.Value.QueueIds);
            AppLog.Write($"RESUME snapshot on exit: {snap.Value.Id} @ {snap.Value.Pos:0.#}s (queue={snap.Value.QueueIds.Count})");
        }
        catch (Exception ex) { AppLog.Write("RESUME exit save err " + ex.Message); }
    }
    /// <summary>播放页窗口命令处理(拖动/最小化/最大化/关闭应用;与自绘标题栏同一套机制)。</summary>
    private void WindowCommandHandler(string cmd)
    {
        switch (cmd)
        {
            case "winDrag": DragWindow(); break;
            case "winMin": WindowState = WindowState.Minimized; break;
            case "winMax": WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized; break;
            case "winClose": Close(); break;
        }
    }
    private void OnPlayerUnlikeRequested(AwemeItem? item)
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(() => OnPlayerUnlikeRequested(item)); return; }
        if (_playerUnlikeBusy || _unlikeCts != null)
        {
            _player?.CompleteUnlike(false, "已有取消点赞任务在处理,请稍候");
            return;
        }
        if (item == null || _collector == null || _unlikeService == null)
        {
            _player?.CompleteUnlike(false, "当前没有可取消的条目");
            return;
        }
        _playerUnlikeBusy = true;
        _ = RunPlayerUnlikeAsync(item);
    }

    private async Task RunPlayerUnlikeAsync(AwemeItem item)
    {
        try
        {
            if (!await IsLoggedInAsync())
            {
                _player?.CompleteUnlike(false, "未登录,请先在主界面完成抖音登录");
                return;
            }
            var r = await _unlikeService!.UnlikeOneAsync(item.AwemeId);
            if (r.Success)
            {
                _collector!.Remove(item.AwemeId);
                SaveNow();
                DispatchUi("window.__dsh_refresh && window.__dsh_refresh()");   // 主列表同步移除(页面当前隐藏,回列表即最新)
                _player?.CompleteUnlike(true, "已在抖音取消点赞,并已从本地移除");
            }
            else if (r.FailKind == UnlikeFailKind.NoResponse)
            {
                _player?.CompleteUnlike(false, "取消失败:接口无响应(疑似验证/风控),请稍后重试");
            }
            else
            {
                _player?.CompleteUnlike(false, "取消失败:" + r.Message);
            }
        }
        catch (Exception ex)
        {
            AppLog.Write("PLAYER UNLIKE ERR " + ex);
            _player?.CompleteUnlike(false, "取消失败,请重试");
        }
        finally { _playerUnlikeBusy = false; }
    }

    // ---------- 登录态 ----------
    internal Task<bool> IsLoggedInAsync() => DouyinProbe.IsLoggedInAsync(DouyinCore);

    private async void OnDouyinNavCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess) return;
        AppLog.Write("DOUYIN NAV " + (DouyinCore?.Source ?? ""));
        await PushStateAsync();
    }

    /// <summary>等待播放页加载完成(NavigationCompleted 一次性 TCS)。</summary>
    private TaskCompletionSource<bool>? _playerPageTcs;

    private Task WaitForPlayerPageAsync() => _playerPageTcs?.Task ?? Task.CompletedTask;

    // ---------- 视图切换(两态:UI / 播放页) ----------
    // ★方案(2024-09 定稿):两个 WebView 常驻 Visible,切换 = Win32 z-order 抬升/压底。
    // 证据(诊断日志 01:44:55):Collapsed 期间 Chromium 视口冻结在陈旧尺寸(实测 inner=69x56),
    // Visible 后 ~1s 才追上 —— 期间整页按小视口渲染贴到大 HWND 上 = "播放页缩在左上角/平移"。
    // 常驻可见让两个视口始终实时跟随窗口,陈旧值从源头消失;且完全规避旧版
    // Hidden↔Visible 的白屏不重绘 bug(不再有任何可见性切换)。
    private void ShowUiOnly()
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(ShowUiOnly); return; }
        RaiseWebViewToTop(UiWebView);
        // 键盘焦点跟随视图:两个 WebView 常驻可见(z-order 切换),被盖住的仍可持有
        // Win32 焦点 —— 不显式转移的话,回主界面后搜索框/按钮的键盘输入会"失灵"
        Dispatcher.BeginInvoke(() => { try { UiWebView.Focus(); } catch { } },
            System.Windows.Threading.DispatcherPriority.Input);
        QueueNudgeAll();
    }
    private void ShowPlayer()
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(ShowPlayer); return; }
        RaiseWebViewToTop(PlayerWebView);
        // 键盘焦点跟随视图(同上):否则进播放页后空格/Esc/方向键被盖住的主界面吃掉
        Dispatcher.BeginInvoke(() => { try { PlayerWebView.Focus(); } catch { } },
            System.Windows.Threading.DispatcherPriority.Input);
        // 兜底重排(硬归位仅在检测到 >2px 偏差时才动,平时零操作)
        NudgeWebView(PlayerWebView);
        QueueNudgeAll();
    }

    /// <summary>★顺序契约:先拉起播放页、再加载直链。
    /// 点播/续播的第一步永远是"播放页出现"(抬 z-order + 硬归位 + 页面进入加载态),
    /// 取链(网络,数百 ms~数秒)排在它之后 —— 既消除"点了没反应"的等待感,
    /// 也避免直链首帧落在播放页尚未对齐宿主的陈旧视口上(内容偏到左上角的诱因之一)。</summary>
    private async Task PreparePlayerAsync(string loadingText)
    {
        ShowPlayer();
        if (_player != null) await _player.ShowLoadingAsync(loadingText);
    }

    /// <summary>播放页已拉起、但后续校验(条目失效/快照过期/队列为空)失败 → 退回主界面。
    /// 不能让用户停在"什么都没在播的播放页"上;返回原错误串给 UI,提示语不变。</summary>
    private string PlayerBackToUi(string message)
    {
        ShowUiOnly();
        return message;
    }

    /// <summary>把 WebView 的 HwndHost 抬到兄弟窗口最顶(z-order 切换的核心)。
    /// 两个 WebView 常驻可见,被压住的那个不接收输入、不可见区域由顶层覆盖。</summary>
    private void RaiseWebViewToTop(Microsoft.Web.WebView2.Wpf.WebView2 wv)
    {
        try
        {
            if (wv is System.Windows.Interop.HwndHost h && h.Handle != IntPtr.Zero)
                Win32.SetWindowPos(h.Handle, Win32.HWND_TOP, 0, 0, 0, 0,
                    Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
        }
        catch { }
    }

    /// <summary>WebView 渲染防御:无边框 + WebView2 HwndHost 在切换/全屏/窗口尺寸变化时
    /// 容易出现"内容整体偏移到左上角、白屏"(渲染层坐标与宿主不同步)。
    /// 经验有效修法:半像素 margin 抖动 + SystemIdle 优先级(等所有布局完成后再触发),
    /// 强制 WPF 重新排 HwndHost 子窗口的位置,使其与新窗口大小对齐。</summary>
    private void NudgeWebView(FrameworkElement el)
    {
        if (el == null) return;
        Dispatcher.BeginInvoke(new Action(() =>
        {
            try
            {
                // 关键:WebView2(HwndHost)有条件不参与 Grid Stretch,会保持上次(可能 Collapsed/初始)
                // 的小尺寸 → Chromium 渲染视图缩小到左上角一块。这里显式把宽高设回父级实际尺寸,
                // 再让 WPF 走完测量/排列,HwndHost 才会调 SetWindowPos 把 Chromium 子窗口摆到正确位置。
                var parent = System.Windows.Media.VisualTreeHelper.GetParent(el) as FrameworkElement;
                if (parent != null && parent.ActualWidth > 0 && parent.ActualHeight > 0)
                {
                    el.Width = parent.ActualWidth;
                    el.Height = parent.ActualHeight;
                }
                el.UpdateLayout();
                // WPF 的 Width/Height 改变但值与旧值相同时不会触发 Arrange,子窗口仍持旧物理
                // 矩形 → 用半像素 Margin 抖动(不引入可见偏移)强制 Visual 层向 HwndHost
                // 下发新位置,把 Chromium 子窗口重新对齐窗口。
                var m2 = el.Margin;
                el.Margin = new Thickness(m2.Left, m2.Top + 0.5, m2.Right, m2.Bottom);
                el.UpdateLayout();
                el.Margin = m2;
                el.UpdateLayout();
                // 终极兜底(位置级失同步,如拖动/最大化后"播放页右下角出现在左上角"):
                // 对比 Chromium 宿主窗口的"期望矩形"(WPF 视觉树变换,物理像素)与"实际矩形"
                // (GetWindowRect,屏幕坐标),偏差 > 2 物理像素才归位 —— 平时零动作(无闪烁)。
                // ★坐标空间注意:host 是主窗口的 WS_CHILD,SetWindowPos 必须用客户区相对坐标
                // (把期望屏幕坐标减去客户区原点屏幕坐标),绝不能直接传屏幕坐标 ——
                // 那会把子窗口挪到错误位置,本身就是"平移"的一种来源。
                if (el == PlayerWebView && el is System.Windows.Interop.HwndHost host
                    && host.Visibility == Visibility.Visible && host.ActualWidth > 10)
                {
                    HardAlignWebView(host);
                }
            }
            catch { }
            el.InvalidateVisual();
        }), System.Windows.Threading.DispatcherPriority.SystemIdle);
    }

    // ---------- 窗口级全屏 ----------
    // 最佳实践:不切换 WindowState(WebView2 的 HwndHost 在 Maximized↔Normal 切换时
    // 不跟随重排是"播放页错位/平移"的根因),全屏 = 记录矩形 → 把 Normal 窗口 bounds
    // 直接铺满主屏;退出还原矩形。窗口任何尺寸/状态变化都触发节流重排兜底。
    private bool _windowFullscreen;
    private double _prevLeft, _prevTop, _prevWidth, _prevHeight;
    private bool _nudgeQueued;

    private void ToggleFullscreen()
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(ToggleFullscreen); return; }
        if (_windowFullscreen) ExitFullscreen();
        else
        {
            // 记录当前矩形:若处于最大化,先还原再取(最大化时 Left/Top 是负数,还原矩形拿不到)
            if (WindowState == WindowState.Maximized)
            {
                WindowState = WindowState.Normal;
                UpdateLayout();
            }
            _prevLeft = Left; _prevTop = Top; _prevWidth = Width; _prevHeight = Height;
            Left = 0; Top = 0;
            Width = SystemParameters.PrimaryScreenWidth;
            Height = SystemParameters.PrimaryScreenHeight;
            _windowFullscreen = true;
            QueueNudgeAll();
        }
    }
    private void ExitFullscreen()
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(ExitFullscreen); return; }
        if (!_windowFullscreen) return;
        Left = _prevLeft; Top = _prevTop; Width = _prevWidth; Height = _prevHeight;
        _windowFullscreen = false;
        QueueNudgeAll();
    }

    /// <summary>窗口尺寸/状态变化后节流触发两个 WebView 重排(HwndHost 错位兜底)。
    /// ★取控件一律走可空字段:启动/换舱期间存在"窗口事件先到、WebView 还没建好"的时间窗
    /// (初始布局的 SizeChanged、拆舱后重建前的尺寸变化),此时属性 getter 会抛
    /// InvalidOperationException —— 它跑在 Dispatcher 回调里,会直接弹"未处理的错误"。</summary>
    private void QueueNudgeAll()
    {
        if (_nudgeQueued) return;
        _nudgeQueued = true;
        Dispatcher.BeginInvoke(new Action(() =>
        {
            _nudgeQueued = false;
            var pw = _playerWebViewHost;
            if (pw != null) NudgeWebView(pw);
            var uw = _uiWebViewHost;
            if (uw != null) NudgeWebView(uw);
        }), System.Windows.Threading.DispatcherPriority.SystemIdle);
    }

    /// <summary>HwndHost 硬归位:把 Chromium 宿主子窗口的物理矩形校正到 WPF 布局矩形。
    /// 期望矩形 = host 左上/右下角经 PointToScreen(物理像素);实际矩形 = GetWindowRect。
    /// SetWindowPos 必须用"父窗口客户区相对坐标":期望屏幕坐标 - 客户区原点屏幕坐标
    /// (直接传屏幕坐标会把子窗口挪到错误位置,本身就是"平移"的一种来源)。
    /// 仅在偏差 > 2 物理像素时动作,平时零操作(无闪烁)。</summary>
    private void HardAlignWebView(System.Windows.Interop.HwndHost host)
    {
        try
        {
            var hwnd = host.Handle;   // host 自身的 HWND(WebView2 会把 Chrome_WidgetWin 挂在它下面)
            if (hwnd == IntPtr.Zero) return;
            if (!Win32.GetWindowRect(hwnd, out var rc)) return;

            // 期望物理矩形:host 视觉左上/右下角映射到屏幕
            var tl = host.PointToScreen(new Point(0, 0));
            var br = host.PointToScreen(new Point(host.ActualWidth, host.ActualHeight));

            // 偏差 > 2 物理像素才算失同步(舍入/DPI 舍入不算)
            if (Math.Abs(rc.Left - (int)tl.X) <= 2 && Math.Abs(rc.Top - (int)tl.Y) <= 2
                && Math.Abs(rc.Right - (int)br.X) <= 2 && Math.Abs(rc.Bottom - (int)br.Y) <= 2)
                return;

            // 客户区相对坐标 = 期望屏幕坐标 - 父窗口客户区原点屏幕坐标
            var rootHwnd = Win32.GetAncestor(hwnd, Win32.GA_ROOT);
            var clientOrigin = new System.Drawing.Point(0, 0);
            if (!Win32.ClientToScreen(rootHwnd, ref clientOrigin)) return;
            int x = (int)tl.X - clientOrigin.X;
            int y = (int)tl.Y - clientOrigin.Y;
            int w = (int)(br.X - tl.X);
            int h = (int)(br.Y - tl.Y);
            if (w <= 0 || h <= 0) return;
            Win32.SetWindowPos(hwnd, IntPtr.Zero, x, y, w, h,
                Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE);

            // 第二层:WebView2 的渲染窗口(Chrome_WidgetWin)挂在 host 下一层,
            // 失同步可能只发生在它身上(host 本身是正的)。期望 = 充满 host 客户区。
            var childHwnd = Win32.GetWindow(hwnd, Win32.GW_CHILD);
            if (childHwnd != IntPtr.Zero && Win32.GetWindowRect(childHwnd, out var rcChild))
            {
                var hostOrigin2 = new System.Drawing.Point(0, 0);
                if (Win32.ClientToScreen(hwnd, ref hostOrigin2)
                    && (Math.Abs(rcChild.Left - hostOrigin2.X) > 2
                        || Math.Abs(rcChild.Top - hostOrigin2.Y) > 2
                        || Math.Abs(rcChild.Right - hostOrigin2.X - w) > 2
                        || Math.Abs(rcChild.Bottom - hostOrigin2.Y - h) > 2))
                {
                    Win32.SetWindowPos(childHwnd, IntPtr.Zero, 0, 0, w, h,
                        Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE);
                }
            }
        }
        catch { }
    }

    /// <summary>去抖版 nudge(窗口拖动/连续缩放用):事件风暴期间不动作,
    /// 停稳 150ms 后补排一次 —— 拖动中实时 nudge 可见 WebView 会造成频闪。</summary>
    private System.Windows.Threading.DispatcherTimer? _nudgeSettleTimer;
    private void QueueNudgeSettled()
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(QueueNudgeSettled); return; }
        _nudgeSettleTimer ??= new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(150) };
        _nudgeSettleTimer.Stop();   // 每次事件重置计时:持续拖动/缩放期间永不触发
        _nudgeSettleTimer.Tick -= OnNudgeSettled;
        _nudgeSettleTimer.Tick += OnNudgeSettled;
        _nudgeSettleTimer.Start();
    }
    private void OnNudgeSettled(object? sender, EventArgs e)
    {
        ((System.Windows.Threading.DispatcherTimer)sender!).Stop();
        QueueNudgeAll();
    }

    /// <summary>播放页媒体请求改写 Referer/UA(防盗链)。只对播放页 WebView 开。</summary>
    private void InstallMediaHeaderRewrite(CoreWebView2 core)
    {
        try
        {
            core.WebResourceRequested += OnPlayerWebResourceRequested;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.Media);
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.Image);
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.Other);
            AppLog.Write("media header rewrite installed");
        }
        catch (Exception ex) { AppLog.Write("media rewrite err " + ex.Message); }
    }

    private void OnPlayerWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs args)
    {
        try
        {
            var uri = args.Request.Uri;
            // 只改写抖音系媒体/CDN 域请求(本地播放页自身资源不动)
            var isMedia = uri.Contains("douyinvod.com") || uri.Contains("bytecdn")
                || uri.Contains("bytegecko") || uri.Contains("zjcdn")
                || uri.Contains("volcfcdndvs") || uri.Contains("aweme.snssdk.com")
                || uri.Contains("douyinpic.com") || uri.Contains("iesdouyin.com");
            if (!isMedia) return;
            args.Request.Headers.SetHeader("Referer", "https://www.douyin.com/");
        }
        catch { }
    }

    // ---------- 认证窗口(登录 / 风控验证) ----------
    internal void OpenAuthWindow(DouyinAuthWindow.AuthMode mode, string secUid = "")
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(() => OpenAuthWindow(mode, secUid)); return; }
        if (_env == null) return;                          // 环境未就绪
        if (_authWindow != null) { _authWindow.Activate(); return; }   // 已开,聚焦即可

        var win = new DouyinAuthWindow(_env!, mode, DouyinCore, secUid);
        _authWindow = win;
        // 验证窗口打开期间禁用采集按钮(防暴力:此时点采集只会刺激接口)
        if (mode == DouyinAuthWindow.AuthMode.Verify)
            DispatchUi("window.__dsh_verifyLock && window.__dsh_verifyLock(true)");
        win.Owner = this;
        win.Succeeded += async () =>
        {
            _authWindow = null;
            if (mode == DouyinAuthWindow.AuthMode.Verify)
                DispatchUi("window.__dsh_verifyLock && window.__dsh_verifyLock(false)");
            // 登录可能换了账号 → 清 sec_uid 缓存,采集时由 ProbeAccountAsync 重新探测
            if (mode == DouyinAuthWindow.AuthMode.Login)
            {
                _orchestrator?.ClearSecUid();
                _ = RefreshCurrentAccountProfileAsync();   // 多账号:登录后回填当前账号档案(昵称/头像/sec_uid)
            }
            DispatchUi($"window.__dsh_toast && window.__dsh_toast({JsonText(mode == DouyinAuthWindow.AuthMode.Login ? "登录成功" : "验证通过")},false)");
            await AfterAuthSuccessAsync(mode);
        };
        win.Abandoned += () =>
        {
            _authWindow = null;
            if (mode == DouyinAuthWindow.AuthMode.Login)
            {
                // 未登录触发采集而弹的登录窗被关 → 复位挂起标志与采集 UI,
                // 否则进度条/采集按钮永久卡住、且残留挂起导致下次登录意外自动续采
                _orchestrator?.CancelPendingResume();
            }
            else
            {
                _orchestrator?.NotifyVerifyAbandoned();   // 状态机:Verifying → RiskHeld,等下次点采集再弹
                DispatchUi("window.__dsh_verifyLock && window.__dsh_verifyLock(false)");
            }
            DispatchUi($"window.__dsh_toast && window.__dsh_toast({JsonText(mode == DouyinAuthWindow.AuthMode.Login ? "已取消登录" : "已取消验证,采集暂停")},true)");
        };
        win.Show();
    }

    /// <summary>认证成功后:重载隐藏页、刷新登录状态;仅当采集确实被挂起等待时才提示"自动续采"
    /// (手动登录/与采集无关的认证不弹误导性文案)。</summary>
    private async Task AfterAuthSuccessAsync(DouyinAuthWindow.AuthMode mode)
    {
        // 重载隐藏抖音页:登录/验证后 cookie 全换,旧页面的 securitySDK 拦截器持过期状态,
        // 不重载的话裸 fetch 会持续失败(误报风控的根源)。
        await ReloadDouyinPageAsync();
        await PushStateAsync();
        if (_orchestrator == null) return;
        var resumed = await _orchestrator.ResumeAfterAuthAsync();
        if (resumed)
            DispatchUi($"window.__dsh_toast && window.__dsh_toast({JsonText(mode == DouyinAuthWindow.AuthMode.Login ? "登录成功,自动开始采集…" : "验证通过,自动继续采集…")},false)");
    }

    /// <summary>播放取链失败自动 reload 引擎页重试的次数(上限 2,防循环)。用户重新点播放时重置。</summary>
    private int _playerRiskReloadCount;

    private async void OnPlayerRisk(int index)
    {
        if (!Dispatcher.CheckAccess()) { _ = Dispatcher.BeginInvoke(OnPlayerRisk, index); return; }
        // 取链失败两种根因:① 引擎页 SDK 拦截器状态过期(裸 fetch 黑洞,reload 重建可修复);
        // ② detail 接口真被限(验证窗信号 favorite/self 代表不了它,弹窗只会秒过,故不弹)。
        // 用 detail 探测直接区分:接口正常 → 页面过期 → reload 后自动重播;接口受限 → 不白 reload,提示稍后。
        if (index < 0 || _playerRiskReloadCount >= 2)
        {
            DispatchUi($"window.__dsh_toast && window.__dsh_toast({JsonText("取链持续失败(页面状态异常),请稍后重试或重启应用")},true)");
            return;
        }
        // 用失败条目的 aweme_id 探测 detail 接口真实状态
        var probe = ApiHealth.NotReady;
        if (_player != null && index < _player.Queue.Count)
            probe = await DouyinProbe.CheckDetailApiAsync(DouyinCoreInternal, _player.Queue[index].AwemeId);
        if (probe != ApiHealth.Ok)
        {
            DispatchUi($"window.__dsh_toast && window.__dsh_toast({JsonText("取链接口暂时受限,请稍后重试播放(或过一会儿再试)")},true)");
            return;
        }
        // detail 接口正常 → 页面状态过期 → reload 重建 SDK 后自动重试
        _playerRiskReloadCount++;
        DispatchUi($"window.__dsh_toast && window.__dsh_toast({JsonText("取链异常,正在刷新页面状态…")},false)");
        await ReloadDouyinPageAsync();
        DispatchUi($"window.__dsh_toast && window.__dsh_toast({JsonText("页面状态已刷新,重新尝试播放…")},false)");
        if (_player != null) await _player.RetryPlayAsync(index);
    }

    // ---------- 抖音页导航(供编排器调用) ----------

    /// <summary>重载隐藏抖音页(带当前登录态刷新 securitySDK 拦截器)。最多等 8 秒。</summary>
    internal async Task ReloadDouyinPageAsync()
    {
        await NavigateDouyinAsync(TimeSpan.FromSeconds(8));
    }

    /// <summary>
    /// 引擎页预热:导航到 douyin.com 首页(非喜欢页!
    /// 首页是抖音主初始化流程,webmssdk 必加载;喜欢页是 SPA 内部路由,签名模块可能懒加载)。
    /// </summary>
    internal async Task EnsureLikePageAsync()
    {
        var core = DouyinCore;
        if (core == null) return;
        if ((core.Source ?? "").Contains("douyin.com")) return;   // 已在抖音域
        await NavigateDouyinAsync(TimeSpan.FromSeconds(30));
    }

    private async Task NavigateDouyinAsync(TimeSpan timeout)
    {
        var core = DouyinCore;
        if (core == null) return;
        try
        {
            var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            void Handler(object? s, CoreWebView2NavigationCompletedEventArgs e) => tcs.TrySetResult(e.IsSuccess);
            core.NavigationCompleted += Handler;
            try { core.Navigate(DouyinProbe.DouyinHomeUrl); }
            catch { tcs.TrySetResult(false); }
            await Task.WhenAny(tcs.Task, Task.Delay(timeout));
            core.NavigationCompleted -= Handler;
        }
        catch { }
    }

    // ---------- 退出登录 ----------
    private async Task<string> LogoutAsync()
    {
        var core = DouyinCore;
        if (core == null) return "err:not ready";
        try
        {
            // 先停采集:cookie 即将被清空,采集必失败并误弹滑块验证
            _orchestrator?.Stop();
            for (var i = 0; i < 20 && _orchestrator is { IsCollecting: true }; i++) await Task.Delay(250);
            // 先停批量取消点赞:同样会因 cookie 被清而误判 NoResponse/风控
            _unlikeCts?.Cancel();
            for (var i = 0; i < 20 && _unlikeCts != null; i++) await Task.Delay(250);   // 等 unlike 循环退出(最多 5s)
            // 删 douyin.com 全域 cookie → 下次启动需重新登录
            foreach (var domain in new[] { "https://www.douyin.com/", "https://douyin.com/", "https://passport.douyin.com/", "https://snssdk.com/" })
            {
                try
                {
                    var cookies = await core.CookieManager.GetCookiesAsync(domain);
                    foreach (var c in cookies)
                        core.CookieManager.DeleteCookie(c);
                }
                catch { }
            }
            _orchestrator?.ClearSecUid();
            SaveNow();
            try { core.Navigate(DouyinProbe.DouyinHomeUrl); } catch { }
            await PushStateAsync();
            return "ok";
        }
        catch (Exception ex) { return "err:" + ex.Message; }
    }

    // ---------- UI ↔ JS ----------
    internal void DispatchUi(string js)
    {
        if (IsShuttingDown) return;
        try
        {
            if (Dispatcher.CheckAccess()) UiEval(js);
            else Dispatcher.BeginInvoke(() => UiEval(js));
        }
        catch { }
    }
    private void UiEval(string js)
    {
        try { UiWebView.CoreWebView2?.ExecuteScriptAsync(js); } catch { }
    }

    /// <summary>推送登录态+数量到 UI(右上角按钮切换:登录 ↔ 退出登录)。</summary>
    internal async Task PushStateAsync()
    {
        try
        {
            var loggedIn = await IsLoggedInAsync();
            var count = _collector?.Count ?? 0;
            // theme 随每次状态广播下发:换账号 = 换 WebView/profile,页面重载后靠这条恢复外观
            DispatchUi($"window.__dsh_state && window.__dsh_state({{loggedIn:{(loggedIn ? "true" : "false")},count:{count},theme:{JsonText(_settings.Theme)}}})");
            AppLog.Write($"STATE loggedIn={loggedIn} count={count}");
        }
        catch (Exception ex) { AppLog.Write("STATE ERR " + ex.Message); }
    }

    // ---------- 落盘(后台合并,防 UI 卡顿) ----------
    // 旧实现:SaveNow 在 UI 线程同步序列化全量数据(数万条时数百 ms,采集期间周期性卡顿)。
    // 新实现:保存请求进队列,由后台线程串行落盘;排队期间的多次请求自动合并(取最后一次参数)。
    // 快照复制仍在锁内(毫秒级),重的序列化/写文件全部移出 UI 线程。
    // 线程安全:存储格式(format:2)只序列化稳定元数据字段 —— 链接类字段 [JsonIgnore],
    // 而 UI 线程对条目的更新全部是"引用替换"(非原地改集合),后台序列化读到新旧引用均一致。
    private readonly object _saveGate = new();
    private bool _saveQueued;
    private bool _saveRunning;
    private bool? _saveQueuedIncomplete;
    private TaskCompletionSource<bool>? _saveIdle;

    internal void SaveNow(bool? collectIncomplete = null) => RequestSave(collectIncomplete);

    private void RequestSave(bool? collectIncomplete)
    {
        if (_collector == null || _store == null) return;
        lock (_saveGate)
        {
            _saveQueued = true;
            if (collectIncomplete.HasValue) _saveQueuedIncomplete = collectIncomplete;
            if (_saveRunning) return;
            _saveRunning = true;
            _saveIdle = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _ = Task.Run(SaveLoopAsync);
        }
    }

    private async Task SaveLoopAsync()
    {
        while (true)
        {
            bool? incomplete;
            lock (_saveGate)
            {
                if (!_saveQueued)
                {
                    _saveRunning = false;
                    _saveIdle?.TrySetResult(true);
                    return;
                }
                _saveQueued = false;
                incomplete = _saveQueuedIncomplete;
                _saveQueuedIncomplete = null;
            }
            try { SaveToDisk(incomplete); }
            catch (Exception ex) { AppLog.Write("SAVE ERR " + ex.Message); }
        }
    }

    private void SaveToDisk(bool? collectIncomplete)
    {
        if (_collector == null || _store == null) return;
        var (items, cursor) = _collector.Snapshot();
        _store.Save(items, cursor, _orchestratorSecUid(), collectIncomplete);
    }

    /// <summary>同步收尾:请求一次最终保存并等后台排空(窗口关闭/进程退出前调用)。</summary>
    private void FlushSaveSync()
    {
        RequestSave(null);
        Task? idle;
        lock (_saveGate) idle = _saveRunning ? _saveIdle?.Task : null;
        if (idle != null) { try { idle.Wait(TimeSpan.FromSeconds(2)); } catch { } }
    }

    private string _orchestratorSecUid() => _orchestrator?.SecUid ?? "";

    // ---------- 桥接命令(全部在 UI 线程异步执行) ----------
    private async Task<object?> HandleCmd(string cmd, string jsonArgs)
    {
        try
        {
            switch (cmd)
            {
                case "ping":
                    return "pong";

                case "list":
                    {
                        if (_collector == null) return "[]";
                        var items = _collector.Items
                            .OrderByDescending(i => i.CreateTime)
                            .Select(i => new
                            {
                                awemeId = i.AwemeId,
                                desc = i.Desc,
                                author = i.AuthorName,
                                createTime = i.CreateTime,
                                status = i.Status,
                                coverUrl = i.CoverUrl
                            })
                            .ToArray();
                        return Newtonsoft.Json.JsonConvert.SerializeObject(items);
                    }

                case "state":
                    {
                        var loggedIn = await IsLoggedInAsync();
                        var autoNext = _player?.AutoNext ?? false;
                        // 数据占用:当前账号数据目录(items/state/resume/export)总大小,MB 保留 1 位
                        var dataMb = 0.0;
                        try
                        {
                            if (Directory.Exists(_dataDir))
                                dataMb = new DirectoryInfo(_dataDir)
                                    .EnumerateFiles("*", SearchOption.AllDirectories)
                                    .Sum(f => (double)f.Length) / 1048576.0;
                        }
                        catch { }
                        var dataMbText = dataMb.ToString("0.#", System.Globalization.CultureInfo.InvariantCulture);
                        return $"{{\"loggedIn\":{(loggedIn ? "true" : "false")},\"count\":{_collector?.Count ?? 0},\"autoNext\":{(autoNext ? "true" : "false")},\"dataMb\":{dataMbText},\"theme\":{JsonText(_settings.Theme)}}}";
                    }

                case "collect":
                    // 互斥:取消点赞运行中不接受新采集(共用引擎页)
                    if (_unlikeCts != null) return "err:批量取消点赞运行中,请先完成或停止";
                    return _orchestrator?.Start() ?? "err:not ready";

                case "stopCollect":
                    _orchestrator?.Stop();
                    return "ok";

                case "shuffle":
                    {
                        // 互斥:取消点赞运行中不接受新播放(共用引擎页)
                        if (_unlikeCts != null) return "err:批量取消点赞运行中,请先完成或停止";
                        if (_collector == null) return "empty";
                        var source = _collector.Items;   // 单次快照(每次访问都全量复制,避免重复取)
                        if (source.Count == 0) return "empty";
                        if (!await IsLoggedInAsync()) return "err:未登录,请先点登录";
                        // ★先拉起播放页(加载态),再筛队列、再取直链
                        await PreparePlayerAsync("正在获取播放地址…");
                        // 支持按当前筛选条件洗牌:UI 传入选中的 awemeId 列表(可选)
                        var ids = Newtonsoft.Json.JsonConvert.DeserializeObject<string[]>(jsonArgs) ?? Array.Empty<string>();
                        if (ids.Length > 0)
                        {
                            var idSet = new HashSet<string>(ids);
                            source = source.Where(i => idSet.Contains(i.AwemeId)).ToList();
                        }
                        var filtered = source.Where(i => i.Status != 1).OrderByDescending(i => i.CreateTime).ToList();
                        if (filtered.Count == 0) return PlayerBackToUi("empty");
                        if (_player != null)
                        {
                            _playerRiskReloadCount = 0;   // 用户主动操作 → 重置取链自愈重试上限
                            _player.SetQueue(filtered);
                            await _player.StartShuffledAsync();
                        }
                        return "ok";
                    }

                case "play":
                    {
                        // 互斥:取消点赞运行中不接受新播放(共用引擎页)
                        if (_unlikeCts != null) return "err:批量取消点赞运行中,请先完成或停止";
                        var args = Newtonsoft.Json.JsonConvert.DeserializeObject<string[]>(jsonArgs) ?? Array.Empty<string>();
                        var awemeId = args.Length > 0 ? args[0] : "";
                        if (awemeId.Length == 0 || _collector == null || _player == null) return "err";
                        if (!await IsLoggedInAsync()) return "err:未登录,请先点登录";
                        // ★先拉起播放页(加载态):队列筛选/条目定位/取直链都在其后
                        await PreparePlayerAsync("正在获取播放地址…");
                        // 单次快照:Items 每次访问都全量复制(数万条时数 ms),一条命令只取一次
                        var all = _collector.Items;
                        // 队列 = UI 传入的当前筛选列表(图集/视频/年月/搜索,与 shuffle 同一来源);
                        // 未传(旧调用/兜底)则回退全量队列(排除失效,时间倒序)
                        List<AwemeItem> queue;
                        if (args.Length > 1)
                        {
                            var idSet = new HashSet<string>(args[1..]);
                            queue = all
                                .Where(i => i.Status != 1 && idSet.Contains(i.AwemeId))
                                .OrderByDescending(i => i.CreateTime)
                                .ToList();
                        }
                        else
                        {
                            queue = all
                                .Where(i => i.Status != 1)
                                .OrderByDescending(i => i.CreateTime)
                                .ToList();
                        }
                        var item = queue.FirstOrDefault(i => i.AwemeId == awemeId);
                        if (item == null)
                        {
                            // 点击项不在筛选队列(异常兜底):回退全量队列定位,保证能播
                            item = all.FirstOrDefault(i => i.AwemeId == awemeId);
                            if (item == null) return PlayerBackToUi("err:not found");
                            // 失效内容:队列已排除它,播了必黑屏 → 明确报错(而非静默切黑屏播放页)
                            if (item.Status == 1) return PlayerBackToUi("err:该内容已失效(已删除或私密),无法播放");
                            queue = all
                                .Where(i => i.Status != 1)
                                .OrderByDescending(i => i.CreateTime)
                                .ToList();
                        }
                        _playerRiskReloadCount = 0;   // 用户主动操作 → 重置取链自愈重试上限
                        _player.SetQueue(queue);
                        var idx = queue.FindIndex(i => i.AwemeId == item.AwemeId);
                        await _player.PlayAtAsync(idx, userInitiated: true);
                        return "ok";
                    }

                case "unlike":
                    {
                        // 批量取消点赞(加固版):后台异步逐条处理,立即返回 started;
                        // 停止/进度/结束经 __dsh_unlikeStart/Progress/End 推给 UI
                        if (_unlikeCts != null) return "busy";
                        // 互斥:与采集/播放共用引擎页,同时跑会互相干扰并叠加风控
                        if (_orchestrator is { IsCollecting: true })
                            return "err:正在采集中,请先停止采集再取消点赞";
                        if (_player is { IsActive: true })
                            return "err:正在播放中,请先停止播放再取消点赞";
                        var ids = Newtonsoft.Json.JsonConvert.DeserializeObject<string[]>(jsonArgs)
                                  ?? Array.Empty<string>();
                        if (_collector == null || _store == null || _unlikeService == null)
                            return "err:not ready";
                        if (ids.Length == 0)
                            return "err:没有选择条目";
                        if (!await IsLoggedInAsync())
                            return "err:未登录,请先登录抖音";

                        _unlikeCts = new CancellationTokenSource();
                        DispatchUi($"window.__dsh_unlikeStart && window.__dsh_unlikeStart({ids.Length})");
                        _ = UnlikeRunAsync(ids);
                        return "started";
                    }

                case "unlikeStop":
                    _unlikeCts?.Cancel();
                    return "ok";

                case "delete":
                    {
                        var ids = Newtonsoft.Json.JsonConvert.DeserializeObject<string[]>(jsonArgs) ?? Array.Empty<string>();
                        if (_collector == null || _store == null) return "err";
                        foreach (var id in ids) _collector.Remove(id);
                        SaveNow();
                        await PushStateAsync();
                        return "ok";
                    }

                case "export":
                    {
                        if (_collector == null || _collector.Items.Count == 0) return "还没有数据";
                        SaveNow();
                        var dlg = new Microsoft.Win32.SaveFileDialog
                        {
                            Title = "导出播放列表",
                            Filter = "抖音收藏列表 (*.dylist)|*.dylist",
                            FileName = $"douyin_likes_{DateTime.Now:yyyyMMdd_HHmmss}.dylist"
                        };
                        if (dlg.ShowDialog() != true) return "已取消";
                        Exporter.ExportDylist(_collector.Items, dlg.FileName);
                        return $"已导出 {_collector.Count} 条";
                    }

                case "import":
                    {
                        if (_collector == null || _store == null) return "err";
                        var dlg = new Microsoft.Win32.OpenFileDialog
                        {
                            Title = "导入播放列表",
                            Filter = "抖音收藏列表 (*.dylist)|*.dylist|所有文件 (*.*)|*.*"
                        };
                        if (dlg.ShowDialog() != true) return "已取消";
                        var imported = Exporter.ImportDylist(dlg.FileName);
                        if (imported == null) return "导入失败:格式不符";
                        var before = _collector.Count;
                        _collector.Seed(imported);
                        SaveNow();
                        await PushStateAsync();
                        DispatchUi("window.__dsh_refresh && window.__dsh_refresh()");
                        return $"导入完成,新增 {_collector.Count - before} 条";
                    }

                case "login":
                    {
                        if (await IsLoggedInAsync())
                        {
                            await PushStateAsync();
                            return "already";
                        }
                        OpenAuthWindow(DouyinAuthWindow.AuthMode.Login);
                        return "ok";
                    }

                case "logout":
                    return await LogoutAsync();

                case "accounts":
                    // 账号面板数据:全部账号 + 当前(头像/显示名/secUid 由登录后采集回填)
                    {
                        var list = _accounts.Accounts
                            .OrderByDescending(a => a.LastUsedAt)
                            .Select(a => new
                            {
                                profileName = a.ProfileName,
                                displayName = a.DisplayName,
                                avatarUrl = a.AvatarUrl,
                                current = a.ProfileName == _account.ProfileName
                            });
                        return Newtonsoft.Json.JsonConvert.SerializeObject(new
                        {
                            current = _account.ProfileName,
                            accounts = list
                        });
                    }

                case "renameAccount":
                    {
                        var args = Newtonsoft.Json.JsonConvert.DeserializeObject<string[]>(jsonArgs) ?? Array.Empty<string>();
                        if (args.Length >= 2)
                        {
                            var acc = _accounts.Find(args[0]);
                            var name = (args[1] ?? "").Trim();
                            if (acc != null && name.Length > 0)
                            {
                                acc.DisplayName = name.Length > 20 ? name[..20] : name;
                                if (acc.ProfileName == _account.ProfileName) _account = acc;
                                SaveAccounts();
                                return "ok";
                            }
                        }
                        return "err:参数无效";
                    }

                case "switchAccount":
                    {
                        // 轻量换舱:目标账号 profile → 拆旧 WebView 体系 → 按新 profile 重建 → 数据源全量刷新
                        var args = Newtonsoft.Json.JsonConvert.DeserializeObject<string[]>(jsonArgs) ?? Array.Empty<string>();
                        var target = args.Length > 0 ? _accounts.Find(args[0]) : null;
                        if (target == null) return "err:账号不存在";
                        if (target.ProfileName == _account.ProfileName) return "already";
                        if (_switchingAccount) return "err:正在切换账号,请稍候";
                        _ = SwitchAccountAsync(target);
                        return "ok";
                    }

                case "addAccount":
                    {
                        // 新增账号:新 profile(userN)→ 换舱到空 profile → 弹登录窗
                        if (_switchingAccount) return "err:正在切换账号,请稍候";
                        var acc = new AccountInfo
                        {
                            ProfileName = _accounts.NextProfileName(),
                            DisplayName = "账号" + _accounts.NextProfileName().Replace("user", ""),   // 与 profile 名对齐:profile=userN → 显示名"账号N"
                            CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
                        };
                        _accounts.Accounts.Add(acc);
                        _accounts.Save(_rootDir);
                        _ = SwitchAccountAsync(acc, openLoginAfterSwitch: true);
                        return "ok";
                    }

                case "deleteAccount":
                    // 删除指定"应用账号"(数据+登录态目录改名留档,清单移除;当前在线账号不可删,须先切换)
                    {
                        var args = Newtonsoft.Json.JsonConvert.DeserializeObject<string[]>(jsonArgs) ?? Array.Empty<string>();
                        var target = args.Length > 0 ? _accounts.Find(args[0]) : null;
                        if (target == null) return "err:账号不存在";
                        if (target.ProfileName == _account.ProfileName) return "err:不能删除当前正在使用的账号,请先切换到其他账号";
                        if (_accounts.Accounts.Count <= 1) return "err:至少保留一个账号";
                        if (_switchingAccount) return "err:正在切换账号,请稍候";

                        // 数据目录改名留档(绝不物理删除用户数据;用户可手动找回或后续提供恢复入口)
                        var stamp = DateTime.Now.ToString("MMdd_HHmmss");
                        var dataDir = DataDirOf(target);
                        var profDir = ProfileDirOf(target);
                        try
                        {
                            if (Directory.Exists(dataDir)) Directory.Move(dataDir, dataDir + "_deleted_" + stamp);
                            if (Directory.Exists(profDir)) Directory.Move(profDir, profDir + "_deleted_" + stamp);
                        }
                        catch (Exception ex)
                        {
                            AppLog.Write("ACCOUNT delete dir err " + ex.Message);
                            return "err:目录占用,无法删除(请稍后再试)";
                        }
                        _accounts.Accounts.Remove(target);
                        _accounts.Save(_rootDir);
                        AppLog.Write($"ACCOUNT deleted {target.ProfileName} (dirs kept with _deleted_{stamp})");
                        return "ok";
                    }

                case "stop":
                    if (_player != null) await _player.StopAsync();
                    return "ok";

                case "resumeInfo":
                    // "继续上次播放"提示条数据:上次手动退出时的条目/位置/队列长度(与当前账号数据域一致)
                    {
                        if (_collector == null || _collector.Items.Count == 0) return "null";
                        var snap = new ResumeStore(_dataDir).Load();
                        if (snap == null || !snap.ManualExit || snap.QueueIds.Count == 0) return "null";
                        var alive = new HashSet<string>(_collector.Items.Select(i => i.AwemeId));
                        var item = _collector.Items.FirstOrDefault(i => i.AwemeId == snap.AwemeId);
                        if (item == null || !alive.Contains(snap.AwemeId)) return "null";
                        var usable = snap.QueueIds.Count(alive.Contains);
                        return Newtonsoft.Json.JsonConvert.SerializeObject(new
                        {
                            awemeId = snap.AwemeId,
                            desc = Truncate(item.Desc, 24),
                            posSec = (int)snap.PositionSec,
                            queueCount = usable
                        });
                    }

                case "resumePlayback":
                    // 继续上次播放:先拉起播放页 → 按快照重建队列 → 跳到记忆条目 → seek 记忆位置
                    {
                        if (_unlikeCts != null) return "err:批量取消点赞运行中,请先完成或停止";
                        if (_collector == null || _player == null) return "err";
                        if (!await IsLoggedInAsync()) return "err:未登录,请先点登录";
                        // ★先拉起播放页(加载态),再读快照/重建队列/取直链:
                        //   点击后立刻看到播放页,等待感落在"页面已在加载"上,而不是主界面纹丝不动
                        await PreparePlayerAsync("正在恢复上次播放…");
                        var snap = new ResumeStore(_dataDir).Load();
                        if (snap == null) return PlayerBackToUi("err:没有播放快照");
                        var all = _collector.Items;
                        var alive = all.Where(i => snap.QueueIds.Contains(i.AwemeId) && i.Status != 1)
                                       .OrderBy(i => snap.QueueIds.IndexOf(i.AwemeId))
                                       .ToList();
                        var idx = alive.FindIndex(i => i.AwemeId == snap.AwemeId);
                        if (idx < 0) return PlayerBackToUi("err:上次的条目已失效");
                        _playerRiskReloadCount = 0;
                        _player.SetQueue(alive);
                        _player.SetResumeTarget(snap.AwemeId, snap.PositionSec);   // 播到该条时 seek
                        await _player.PlayAtAsync(idx, userInitiated: true);
                        return "ok";
                    }

                case "themeChanged":
                    // 深色模式联动:UI 页主题已切换( resolved 为 light/dark ),同步窗口底色
                    // (WebView 是 HwndHost 不透明,窗口露边区域必须配套,否则深色下露白刺眼)
                    // ★同时落盘到 settings.json:主题是应用级偏好,不能只存在各账号 profile 的
                    //   localStorage 里(换账号 = 换 profile → 深色会"丢失")。
                    // ★采纳规则:宿主还没记过 → 采纳页面这次上报的值(老用户的深色偏好原先就存在
                    //   profile 的 localStorage 里,不能因"清单里还没这项"把他刷回浅色);记过之后
                    //   以宿主为准 —— 页面加载时带着另一个 profile 的旧值上报,不再覆盖它。
                    {
                        var args = Newtonsoft.Json.JsonConvert.DeserializeObject<string[]>(jsonArgs) ?? Array.Empty<string>();
                        var reported = Storage.AppSettings.Normalize(args.Length > 0 ? args[0] : null);
                        if (_settings.Theme.Length == 0)
                        {
                            _settings.Theme = reported;
                            _settings.Save(_rootDir);
                            AppLog.Write($"THEME adopt {reported} (first run, settings.json created)");
                        }
                        ApplyWindowTheme(_settings.Theme);
                    }
                    return "ok";

                case "autonext":
                    {
                        // 主界面工具栏开关:args=[true|false](播放页 toggle 走 postMessage 通道,见 PlaybackController)
                        var on = false;
                        try
                        {
                            var arr = Newtonsoft.Json.Linq.JArray.Parse(jsonArgs);
                            if (arr.Count > 0)
                                on = arr[0].Type == Newtonsoft.Json.Linq.JTokenType.Boolean
                                    ? (bool)arr[0]!
                                    : string.Equals(arr[0].ToString(), "true", StringComparison.OrdinalIgnoreCase);
                        }
                        catch { }
                        _player?.SetAutoNext(on);
                        return "ok";
                    }

                // ---------- 自绘标题栏:窗口控制 ----------
                case "winMin":
                    WindowState = WindowState.Minimized;
                    return "ok";
                case "winMax":
                    WindowState = WindowState == WindowState.Maximized
                        ? WindowState.Normal
                        : WindowState.Maximized;
                    return "ok";
                case "winClose":
                    Close();
                    return "ok";
                case "winDrag":
                    DragWindow();
                    return "ok";

                default:
                    return "unknown:" + cmd;
            }
        }
        catch (Exception ex) { AppLog.Write("CMD ERROR " + cmd + " " + ex); return "err:" + ex.Message; }
    }

    // ---------- UI 异步消息(命令泵:消息到达即响应,处理异步进行) ----------
    private void OnUiMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string cmd = "", args = "[]", id = "";
        try
        {
            var jo = Newtonsoft.Json.Linq.JObject.Parse(e.WebMessageAsJson);
            cmd = (string?)jo["cmd"] ?? "";
            args = jo["args"]?.ToString(Newtonsoft.Json.Formatting.None) ?? "[]";
            id = (string?)jo["id"] ?? "";
        }
        catch { return; }
        if (cmd.Length == 0) return;
        AppLog.Write("UI MSG cmd=" + cmd);

        // 在 UI 线程异步执行(async void 语义,绝不同步阻塞)
        _ = Dispatcher.InvokeAsync(async () =>
        {
            var result = await HandleCmd(cmd, args);
            if (id.Length == 0) return;
            var js = $"window.__dsh_respond && window.__dsh_respond({JsonText(id)}, {JsonText(result?.ToString() ?? "null")})";
            UiEval(js);
        });
    }

    // ---------- 批量取消点赞(加固编排:自适应节奏 + 风控探测分流) ----------
    // 节奏自适应:无迹象 1.5~2.5s/条,每 20 条长休 5s;出现 NoResponse 立即退避到 4~6s。
    // 连续 3 条 NoResponse → 现场分流(对齐采集/取链的"先探测再动作"哲学):
    //   favorite 探测仍通(或无法探测)→ 更像页面 SDK 状态问题 → reload 引擎页重建后慢速自愈(限 1 次);
    //   favorite 也不通 → 账号级验证 → 停止并弹验证窗(用户过滑块,引擎页自动 reload,重勾剩余即可续跑)。
    // 业务明确拒绝(有状态码:下架/重复取消等)跳过继续;连续同因拒绝≥3 视为疑似限流,退避但不中断。
    private async Task UnlikeRunAsync(string[] ids)
    {
        var ct = _unlikeCts?.Token ?? CancellationToken.None;
        var rnd = Random.Shared;
        var ok = 0;
        var skip = 0;
        var risk = 0;                 // 连续 NoResponse
        var sameReject = 0;           // 连续同文案业务拒绝
        string? lastReject = null;
        var selfHealLeft = 1;         // 风控现场 reload 自愈次数上限(防 reload 循环)
        var stopReason = "";
        try
        {
            for (var i = 0; i < ids.Length; i++)
            {
                if (ct.IsCancellationRequested) { stopReason = "已手动停止"; break; }
                DispatchUi($"window.__dsh_unlikeProgress && window.__dsh_unlikeProgress({i + 1},{ids.Length},{JsonText($"正在取消 {i + 1}/{ids.Length}…已成功 {ok} 条")})");
                var r = await _unlikeService!.UnlikeOneAsync(ids[i], ct);
                if (r.Success)
                {
                    ok++;
                    risk = 0;
                    sameReject = 0;
                    lastReject = null;
                    _collector!.Remove(ids[i]);
                    SaveNow();   // 逐条落盘:中途退出/崩溃也只丢失"未处理"部分
                }
                else if (r.FailKind == UnlikeFailKind.NoResponse)
                {
                    risk++;
                    if (risk >= 3)
                    {
                        // 现场分流:探测 favorite 只读接口,区分"页面问题(reload 可愈)"与"账号级验证(弹窗)"
                        var favOk = false;
                        var uid = _orchestratorSecUid();
                        try { if (uid.Length > 0) favOk = await DouyinProbe.CheckFavoriteApiAsync(DouyinCoreInternal, uid); } catch { }
                        if (selfHealLeft > 0 && (favOk || uid.Length == 0))
                        {
                            selfHealLeft--;
                            risk = 0;
                            DispatchUi($"window.__dsh_toast && window.__dsh_toast({JsonText("连续取消失败,正在刷新页面状态后慢速重试…")},false)");
                            await ReloadDouyinPageAsync();
                            try { await Task.Delay(4000, ct); } catch (OperationCanceledException) { stopReason = "已手动停止"; break; }
                            continue;
                        }
                        stopReason = $"连续 {risk} 条无响应且接口探测失败(疑似触发验证),已自动停止";
                        break;
                    }
                }
                else   // 业务明确拒绝(下架/重复取消等)→ 跳过继续;连续同因≥3 视为疑似限流退避
                {
                    skip++;
                    var same = lastReject != null && r.Message == lastReject;
                    lastReject = r.Message;
                    sameReject = same ? sameReject + 1 : 1;
                }

                // 自适应节奏:无迹象快,有迹象立即收敛
                var d = risk > 0
                    ? 4000 + rnd.Next(0, 2000)
                    : sameReject >= 3 ? 3000 + rnd.Next(0, 1000)
                    : 1500 + rnd.Next(0, 1000);
                if ((i + 1) % 20 == 0) d += 5000;   // 每 20 条长休散热
                try { await Task.Delay(d, ct); }
                catch (OperationCanceledException) { stopReason = "已手动停止"; break; }
            }
        }
        catch (Exception ex) { AppLog.Write("UNLIKE BATCH ERR " + ex); stopReason = "执行出错"; }
        finally
        {
            _unlikeCts = null;
            if (stopReason.Contains("验证") && !IsVerifyWindowOpen)
            {
                // 引导用户过滑块:验证通过后引擎页自动 reload;剩余条目本地未删,重新勾选即可续跑
                // 必须带 secUid:验证窗完成信号 = favorite 接口恢复(风控分接口,self 恢复说明不了)
                OpenAuthWindow(DouyinAuthWindow.AuthMode.Verify, _orchestratorSecUid());
            }
            var summary = stopReason.Length > 0
                ? $"{stopReason}。已取消 {ok} 条,失败 {skip} 条。"
                : $"已全部处理:取消 {ok} 条,失败 {skip} 条。";
            DispatchUi($"window.__dsh_unlikeEnd && window.__dsh_unlikeEnd({JsonText(summary)})");
        }
    }

    // ---------- 工具 ----------
    private static string Truncate(string? s, int max)
    {
        if (string.IsNullOrEmpty(s) || s.Length <= max) return s ?? "";
        return s[..max] + "…";
    }
    internal static string JsonText(string s) => Newtonsoft.Json.JsonConvert.SerializeObject(s);

    private void ExtractWebUi()
    {
        Directory.CreateDirectory(_uiDir);
        var asm = typeof(MainWindow).Assembly;
        foreach (var res in asm.GetManifestResourceNames())
        {
            var idx = res.IndexOf(".WebUi.", StringComparison.Ordinal);
            if (idx < 0) continue;
            var rel = res[(idx + ".WebUi.".Length)..];
            var parts = rel.Split('.');
            var ext = parts[^1];
            var dirParts = parts[..^1];
            var relative = string.Join(Path.DirectorySeparatorChar, dirParts) + "." + ext;
            var outPath = Path.Combine(_uiDir, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
            using var s = asm.GetManifestResourceStream(res)!;
            using var fs = File.Create(outPath);
            s.CopyTo(fs);
        }
    }
}

/// <summary>Win32 互操作:无边框窗口拖动 + HwndHost 子窗口硬归位。</summary>
internal static class Win32
{
    public const int WM_NCLBUTTONDOWN = 0x00A1;
    public const int HTCAPTION = 0x2;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_NOREDRAW = 0x0008;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint GW_CHILD = 5;
    public static readonly IntPtr HWND_TOP = IntPtr.Zero;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool ReleaseCapture();

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);

    public const uint GA_ROOT = 2;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr hWnd, ref System.Drawing.Point p);

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int x, int y, int cx, int cy, uint flags);
}
