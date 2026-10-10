using System.Windows;
using DouyinShuffle.Win.Capture;
using Microsoft.Web.WebView2.Core;
using static DouyinShuffle.Win.AppLog;

namespace DouyinShuffle.Win;

/// <summary>
/// 抖音认证窗口(登录 / 风控滑块验证 两用):
/// - 与主窗口共享同一 WebView2 环境(profile) → 登录态 cookie 全局共享;
/// - 登录模式:轮询检测 sessionid,检测到后自动关窗;
/// - 验证模式:检测到滑块消失(且能正常拉到接口数据)后自动关窗;
/// - 每次使用都新建窗口实例(旧窗口 Close 后 WPF 不可复用),用后即弃。
/// </summary>
public partial class DouyinAuthWindow : Window
{
    public enum AuthMode { Login, Verify }

    private readonly CoreWebView2Environment _env;
    private readonly AuthMode _mode;

    /// <summary>验证模式下轮询检测用的共享抖音页(风控发生在它的 API 上下文里)。</summary>
    private readonly CoreWebView2? _probeCore;

    /// <summary>验证模式:收藏接口探测用的 sec_uid(风控分接口,验证通过必须以收藏接口恢复为准)。</summary>
    private readonly string _secUid;
    private CoreWebView2? _core;
    private bool _finished;
    private CancellationTokenSource? _pollCts;

    /// <summary>成功(登录成功 / 验证通过)。UI 线程触发。</summary>
    public event Action? Succeeded;

    /// <summary>用户手动关闭窗口(未完成认证)。UI 线程触发。</summary>
    public event Action? Abandoned;

    public DouyinAuthWindow(CoreWebView2Environment env, AuthMode mode, CoreWebView2? probeCore = null, string secUid = "")
    {
        InitializeComponent();
        _env = env;
        _mode = mode;
        _probeCore = probeCore;
        _secUid = secUid;
        Title = mode == AuthMode.Login ? "登录抖音" : "抖音安全验证";
        HintText.Text = mode == AuthMode.Login
            ? "请在下方页面完成登录(扫码或手机号)。登录成功且接口就绪后会自动关闭,期间如有滑块请从容完成,不会提前关窗。"
            : "请检查下方页面,若有滑块请拖动完成,接口恢复后自动关闭。若页面无任何验证提示,可能是临时限流,可稍候或直接关闭稍后重试。";
        Loaded += async (_, _) => await InitAsync();
        Closed += OnClosed;
    }

    // 关窗时暂停所有媒体(否则关窗后视频还在播)
    private const string PauseMediaJs =
        "document.querySelectorAll('video, audio').forEach(function (v) { try { v.pause(); v.muted = true; } catch (e) {} });";

    private async Task InitAsync()
    {
        try
        {
            await AuthWebView.EnsureCoreWebView2Async(_env);
            _core = AuthWebView.CoreWebView2!;
            await _core.ExecuteScriptAsync("try{window.__dsh_no_capture__=true}catch(e){}");
            // 登录/验证用不到声音:静音自动播放的 feed 视频 + 自动关"保存登录信息"弹窗
            await _core.AddScriptToExecuteOnDocumentCreatedAsync(ScriptLoader.Get("mute-media.js"));
            await _core.AddScriptToExecuteOnDocumentCreatedAsync(ScriptLoader.Get("dismiss-save-login.js"));
            // 登录模式直接进首页(首页自带登录入口);验证模式也进首页
            // (风控验证页通常会以浮层形式出现在任意 douyin.com 页面上)
            _core.Navigate(DouyinProbe.DouyinHomeUrl);
            StartPolling();
            AppLog.Write($"AUTH-WINDOW ({_mode}) init ok");
        }
        catch (Exception ex)
        {
            AppLog.Write("AUTH-WINDOW init err " + ex.Message);
            // 初始化失败(WebView2 环境异常等):窗口留空只会让用户干等扫码/滑块 → 明确提示后自关,
            // 走 Abandoned 通道(宿主复位验证锁/状态),由用户稍后再试。
            try { HintText.Text = "页面初始化失败(" + ex.Message + ")。即将自动关闭,请稍后重试。"; } catch { }
            var _ = AutoCloseAfterInitFailure();
        }
    }

    private async Task AutoCloseAfterInitFailure()
    {
        try { await Task.Delay(2500); } catch { }
        if (!_finished && Dispatcher.CheckAccess()) Close();
        else if (!_finished) Dispatcher.Invoke(Close);
    }

    private void StartPolling()
    {
        _pollCts = new CancellationTokenSource();
        var ct = _pollCts.Token;
        _ = Task.Run(async () =>
        {
            try
            {
                // 先等页面起来 + securitySDK 初始化
                await Task.Delay(2000, ct);
                DateTime? cookieSeenAt = null;   // Login 兜底:cookie 出现的时刻
                // 验证模式探测收藏接口(单次最长 ~8s 超时),60 次 ≈ 最多约 8 分钟;
                // 登录模式探测 self(秒级),360 次 ≈ 6 分钟
                var maxLoops = _mode == AuthMode.Verify && _secUid.Length > 0 ? 60 : 360;
                for (var i = 0; i < maxLoops && !ct.IsCancellationRequested; i++)
                {
                    if (_finished) return;
                    // 登录模式测本窗页面(cookie/SDK 实时);验证模式测共享页(风控发生在它的上下文)
                    var target = _mode == AuthMode.Login ? _core : (_probeCore ?? _core);
                    if (target == null) return;

                    if (_mode == AuthMode.Verify && _secUid.Length > 0)
                    {
                        // 验证模式:完成信号 = 收藏接口恢复(而非 profile/self)。
                        // 风控分接口 —— 收藏接口被限时 self 可能一直 Ok,若用健康检查会秒判"通过"
                        // → 验证窗一闪而过,滑块根本来不及滑(实测踩坑)。
                        var tf = await Dispatcher.InvokeAsync(() => DouyinProbe.CheckFavoriteApiAsync(target, _secUid));
                        var favOk = await tf;
                        if (favOk)
                        {
                            await Dispatcher.InvokeAsync(() => Finish(true));
                            return;
                        }
                    }
                    else
                    {
                        // 登录模式(或无 sec_uid 的兜底):统一完成信号 = profile/self 就绪。
                        var t = await Dispatcher.InvokeAsync(() => DouyinProbe.CheckHealthAsync(target));
                        var (health, _) = await t;
                        if (health == ApiHealth.Ok)
                        {
                            await Dispatcher.InvokeAsync(() => Finish(true));
                            return;
                        }
                    }

                    // Login 兜底:cookie 在但接口 2 分钟仍未就绪 → 仍视为登录成功关窗
                    //(接口慢由采集流程的探测状态机兜底,不该让用户一直盯着)
                    if (_mode == AuthMode.Login)
                    {
                        var loggedIn = false;
                        var t2 = await Dispatcher.InvokeAsync(() => DouyinProbe.IsLoggedInAsync(target));
                        loggedIn = await t2;
                        if (loggedIn)
                        {
                            cookieSeenAt ??= DateTime.UtcNow;
                            if (DateTime.UtcNow - cookieSeenAt > TimeSpan.FromMinutes(2))
                            {
                                AppLog.Write("AUTH login cookie ok but api not ready in 2min, close anyway");
                                await Dispatcher.InvokeAsync(() => Finish(true));
                                return;
                            }
                        }
                        else cookieSeenAt = null;
                    }

                    await Task.Delay(1000, ct);
                }

                // 轮询超限:不再静默停止(用户回来扫码成功却永远不关窗,体验极差)。
                // 降频继续轮询(5s/次),并提示用户可手动关窗。
                AppLog.Write($"AUTH-WINDOW ({_mode}) poll timeout, switching to slow poll");
                if (_mode == AuthMode.Login)
                {
                    await Dispatcher.InvokeAsync(() => HintText.Text =
                        "检测超时(登录耗时较长)。若已完成登录请直接关闭本窗口;未完成请继续操作,稍后关闭即可。");
                }
                for (var i = 0; !ct.IsCancellationRequested; i++)
                {
                    if (_finished) return;
                    var target = _mode == AuthMode.Login ? _core : (_probeCore ?? _core);
                    if (target == null) return;
                    // 与主轮询同款信号:验证模式看收藏接口恢复,登录模式看 self
                    if (_mode == AuthMode.Verify && _secUid.Length > 0)
                    {
                        var tf = await Dispatcher.InvokeAsync(() => DouyinProbe.CheckFavoriteApiAsync(target, _secUid));
                        if (await tf)
                        {
                            await Dispatcher.InvokeAsync(() => Finish(true));
                            return;
                        }
                    }
                    else
                    {
                        var t = await Dispatcher.InvokeAsync(() => DouyinProbe.CheckHealthAsync(target));
                        if ((await t).health == ApiHealth.Ok)
                        {
                            await Dispatcher.InvokeAsync(() => Finish(true));
                            return;
                        }
                    }
                    await Task.Delay(5000, ct);
                }
            }
            catch (OperationCanceledException) { }
            catch { }
        });
    }

    private void Finish(bool success)
    {
        if (_finished) return;
        _finished = true;
        try { _pollCts?.Cancel(); } catch { }
        if (success) Succeeded?.Invoke();
        Close();
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        try { _pollCts?.Cancel(); } catch { }
        // 关窗即停止:暂停所有媒体 + 导航到空白页销毁原页面
        // (浏览器进程不随窗口销毁,不清页面音频会继续播)
        try { _core?.ExecuteScriptAsync(PauseMediaJs); } catch { }
        try { _core?.Navigate("about:blank"); } catch { }
        try { _core?.Stop(); } catch { }
        if (!_finished)
        {
            _finished = true;
            Abandoned?.Invoke();
        }
    }
}
