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
    private readonly string _dataDir;
    private readonly string _uiDir;
    private readonly string _profileDir;
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
        _dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DouyinShuffle", "Data", "default");
        _uiDir = Path.Combine(Path.GetTempPath(), "dsh_ui_" + Process.GetCurrentProcess().Id);
        _profileDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DouyinShuffle", "Profiles", "default");
        Closed += OnClosed;
        Loaded += OnLoadedAsync;
        StateChanged += OnStateChanged;
        SizeChanged += (_, _) => QueueNudgeAll();   // 尺寸变化后 WebView(HwndHost)可能错位
        try { Icon = CreateHeartIcon(); } catch { }
    }

    // ---------- 无边框窗口:状态联动 ----------

    /// <summary>拖动窗口(Win32 模态拖动循环)。CSS app-region 失效时的兜底。</summary>
    private void DragWindow()
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(DragWindow); return; }
        var hwnd = new System.Windows.Interop.WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero) return;
        Win32.ReleaseCapture();
        Win32.SendMessage(hwnd, Win32.WM_NCLBUTTONDOWN, (IntPtr)Win32.HTCAPTION, IntPtr.Zero);
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
        try { FlushSaveSync(); } catch { }
        try { if (_uiDir.StartsWith(Path.GetTempPath())) Directory.Delete(_uiDir, true); } catch { }
        _authWindow?.Close();
        try { _engineWindow?.Close(); } catch { }
        _pageWindow?.Close();
    }

    private async void OnLoadedAsync(object? sender, RoutedEventArgs e)
    {
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
            Directory.CreateDirectory(_profileDir);

            var env = await CoreWebView2Environment.CreateAsync(null, _profileDir);
            _env = env;
            await Task.WhenAll(
                UiWebView.EnsureCoreWebView2Async(env),
                PlayerWebView.EnsureCoreWebView2Async(env));
            // 抖音引擎页:独立屏幕外窗口(HwndHost 不受 WPF z-order 裁剪,不能在主窗口里叠放)
            _engineWindow = new DouyinEngineWindow();
            _engineWindow.Owner = this;
            _engineWindow.Show();
            await _engineWindow.EnsureAsync(env);
            AppLog.Write("webview cores ready");

            // 播放页媒体请求改写 Referer/UA(防盗链):只对播放页开,不影响抖音页签名
            InstallMediaHeaderRewrite(PlayerWebView.CoreWebView2!);

            // 存储 + 采集器(挂在抖音页)
            _store = new LikeListStore(_dataDir);
            if (_store.HasLegacyData()) { _store.MigrateLegacy(); }
            var saved = _store.LoadItems();
            var state = _store.LoadState();

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

            await PushStateAsync();
        }
        catch (Exception ex)
        {
            AppLog.Write("INIT FAILED: " + ex);
            MessageBox.Show(this, $"初始化失败:{ex.Message}\n\n若提示 WebView2 相关错误,请先安装 WebView2 运行时:\nhttps://developer.microsoft.com/microsoft-edge/webview2/",
                "MyLike 启动失败", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();   // 不留空白残窗
        }
    }

    /// <summary>播放器初始化与事件接线(原 OnLoadedAsync 的一段,拆出便于阅读)。</summary>
    private void InitPlayer()
    {
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
        _player.Notice += msg => DispatchUi($"window.__dsh_toast && window.__dsh_toast({JsonText(msg)},false)");
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
    // 注意:用 Collapsed(非 Hidden)——旧版 WebView2 在 Hidden↔Visible 切换时有白屏不重绘 bug,
    // Collapsed 会强制重新布局,显示时必重绘;配 XAML 里 DefaultBackgroundColor=Black,切换瞬间不闪白
    private void ShowUiOnly()
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(ShowUiOnly); return; }
        // 关键:WebView2(HwndHost)从 Collapsed 切到 Visible 时,WPF 用它当前的 Width/Height
        // 做测量;如果还是上一次 Collapsed 时的小值,Chromium 第一帧就会按小尺寸渲染(左上角一块)。
        // 这里在 Visible 之前先把它的宽高对齐到 RootGrid,保证测量即正确。
        if (RootGrid.ActualWidth > 0 && RootGrid.ActualHeight > 0)
        {
            UiWebView.Width = RootGrid.ActualWidth;
            UiWebView.Height = RootGrid.ActualHeight;
        }
        UiWebView.Visibility = Visibility.Visible;
        PlayerWebView.Visibility = Visibility.Collapsed;
        QueueNudgeAll();
    }
    private void ShowPlayer()
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(ShowPlayer); return; }
        // 同 ShowUiOnly:Visible 之前必须先把宽高对齐 RootGrid,避免 Chromium 第一帧按小尺寸渲染。
        if (RootGrid.ActualWidth > 0 && RootGrid.ActualHeight > 0)
        {
            PlayerWebView.Width = RootGrid.ActualWidth;
            PlayerWebView.Height = RootGrid.ActualHeight;
        }
        UiWebView.Visibility = Visibility.Collapsed;
        PlayerWebView.Visibility = Visibility.Visible;
        // 白屏防御:Collapsed→Visible 后 WebView2 可能不主动重绘,强制布局+重绘一次
        PlayerWebView.UpdateLayout();
        PlayerWebView.InvalidateVisual();
        QueueNudgeAll();
    }

    /// <summary>WebView 渲染防御:无边框 + WebView2 HwndHost 在切换/全屏/窗口尺寸变化时
    /// 容易出现"内容整体偏移到左上角、白屏"(渲染层坐标与宿主不同步)。
    /// 经验有效修法:1px margin 抖动 + SystemIdle 优先级(等所有布局完成后再触发),
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
                // 1px margin 抖动:额外再触发一次子窗口重排(防止尺寸更新未生效的边缘情况)
                var m = el.Margin;
                el.Margin = new Thickness(m.Left + 1, m.Top, m.Right, m.Bottom);
                el.UpdateLayout();
                el.Margin = m;
                el.UpdateLayout();
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

    /// <summary>窗口尺寸/状态变化后节流触发两个 WebView 重排(HwndHost 错位兜底)。</summary>
    private void QueueNudgeAll()
    {
        if (_nudgeQueued) return;
        _nudgeQueued = true;
        Dispatcher.BeginInvoke(new Action(() =>
        {
            _nudgeQueued = false;
            NudgeWebView(PlayerWebView);
            NudgeWebView(UiWebView);
        }), System.Windows.Threading.DispatcherPriority.SystemIdle);
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
            if (mode == DouyinAuthWindow.AuthMode.Login) _orchestrator?.ClearSecUid();
            DispatchUi($"window.__dsh_toast && window.__dsh_toast({JsonText(mode == DouyinAuthWindow.AuthMode.Login ? "登录成功" : "验证通过")},false)");
            await AfterAuthSuccessAsync();
        };
        win.Abandoned += () =>
        {
            _authWindow = null;
            if (mode == DouyinAuthWindow.AuthMode.Verify)
            {
                _orchestrator?.NotifyVerifyAbandoned();   // 状态机:Verifying → RiskHeld,等下次点采集再弹
                DispatchUi("window.__dsh_verifyLock && window.__dsh_verifyLock(false)");
            }
            DispatchUi($"window.__dsh_toast && window.__dsh_toast({JsonText(mode == DouyinAuthWindow.AuthMode.Login ? "已取消登录" : "已取消验证,采集暂停")},true)");
        };
        win.Show();
    }

    /// <summary>认证成功后:重载隐藏页、刷新登录状态、若采集被风控打断则自动续采。</summary>
    private async Task AfterAuthSuccessAsync()
    {
        // 重载隐藏抖音页:登录/验证后 cookie 全换,旧页面的 securitySDK 拦截器持过期状态,
        // 不重载的话裸 fetch 会持续失败(误报风控的根源)。
        await ReloadDouyinPageAsync();
        await PushStateAsync();
        if (_orchestrator != null)
        {
            DispatchUi($"window.__dsh_toast && window.__dsh_toast({JsonText("验证通过,自动继续采集…")},false)");
            await _orchestrator.ResumeAfterAuthAsync();
        }
    }

    /// <summary>播放取链失败自动 reload 引擎页重试的次数(上限 2,防循环)。用户重新点播放时重置。</summary>
    private int _playerRiskReloadCount;

    private async void OnPlayerRisk(int index)
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(OnPlayerRisk, index); return; }
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
            DispatchUi($"window.__dsh_state && window.__dsh_state({{loggedIn:{(loggedIn ? "true" : "false")},count:{count}}})");
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
        if (idle != null) { try { idle.Wait(TimeSpan.FromSeconds(5)); } catch { } }
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
                        return $"{{\"loggedIn\":{(loggedIn ? "true" : "false")},\"count\":{_collector?.Count ?? 0},\"autoNext\":{(autoNext ? "true" : "false")}}}";
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
                        // 支持按当前筛选条件洗牌:UI 传入选中的 awemeId 列表(可选)
                        var ids = Newtonsoft.Json.JsonConvert.DeserializeObject<string[]>(jsonArgs) ?? Array.Empty<string>();
                        if (ids.Length > 0)
                        {
                            var idSet = new HashSet<string>(ids);
                            source = source.Where(i => idSet.Contains(i.AwemeId)).ToList();
                        }
                        var filtered = source.Where(i => i.Status != 1).OrderByDescending(i => i.CreateTime).ToList();
                        if (filtered.Count == 0) return "empty";
                        ShowPlayer();
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
                            if (item == null) return "err:not found";
                            // 失效内容:队列已排除它,播了必黑屏 → 明确报错(而非静默切黑屏播放页)
                            if (item.Status == 1) return "err:该内容已失效(已删除或私密),无法播放";
                            queue = all
                                .Where(i => i.Status != 1)
                                .OrderByDescending(i => i.CreateTime)
                                .ToList();
                        }
                        ShowPlayer();
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

                case "stop":
                    if (_player != null) await _player.StopAsync();
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
                OpenAuthWindow(DouyinAuthWindow.AuthMode.Verify);
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

/// <summary>Win32 互操作:无边框窗口拖动。</summary>
internal static class Win32
{
    public const int WM_NCLBUTTONDOWN = 0x00A1;
    public const int HTCAPTION = 0x2;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool ReleaseCapture();

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
}
