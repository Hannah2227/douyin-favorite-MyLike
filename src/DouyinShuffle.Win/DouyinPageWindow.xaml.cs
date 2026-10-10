using System.Windows;
using DouyinShuffle.Win.Capture;
using Microsoft.Web.WebView2.Core;
using static DouyinShuffle.Win.AppLog;

namespace DouyinShuffle.Win;

/// <summary>
/// 独立抖音原页窗口(播放时点"原页"弹出,看评论/点赞):
/// - 与主窗口共享同一 WebView2 环境(profile) → 登录态 cookie 共享;
/// - 关闭窗口 → 回主窗口续播(宿主在 Closed 里调 ResumeAfterNavigate)。
/// </summary>
public partial class DouyinPageWindow : Window
{
    private readonly CoreWebView2Environment _env;
    private CoreWebView2? _core;
    private bool _loaded;

    /// <summary>窗口被关闭(无论哪种方式)。</summary>
    public event Action? ClosedByUser;

    /// <summary>已开窗口导航到新视频(原来只 Activate,用户以为新视频的原页打不开)。</summary>
    public void NavigateTo(string awemeId)
    {
        try { _core?.Navigate($"https://www.douyin.com/video/{awemeId}"); } catch { }
    }

    public DouyinPageWindow(CoreWebView2Environment env, string awemeId)
    {
        InitializeComponent();
        _env = env;
        Loaded += async (_, _) =>
        {
            if (_loaded) return;
            _loaded = true;
            await InitAsync(awemeId);
        };
        Closed += (_, _) =>
        {
            // 关窗即停止:暂停所有媒体 + 导航到空白页销毁原页面
            // (浏览器进程不随窗口销毁,不清页面音频会继续播)
            try { _core?.ExecuteScriptAsync(PauseMediaJs); } catch { }
            try { _core?.Navigate("about:blank"); } catch { }
            try { _core?.Stop(); } catch { }
            ClosedByUser?.Invoke();
        };
        BtnClose.Click += (_, _) => Close();
    }

    // 关窗时暂停所有媒体(否则关窗后视频还在播)
    private const string PauseMediaJs =
        "document.querySelectorAll('video, audio').forEach(function (v) { try { v.pause(); v.muted = true; } catch (e) {} });";

    private async Task InitAsync(string awemeId)
    {
        try
        {
            await PageWebView.EnsureCoreWebView2Async(_env);
            _core = PageWebView.CoreWebView2!;
            // 自动关"保存登录信息"弹窗(登录后首次打开原页常弹,易被误认为风控)
            await _core.AddScriptToExecuteOnDocumentCreatedAsync(ScriptLoader.Get("dismiss-save-login.js"));
            _core.Navigate($"https://www.douyin.com/video/{awemeId}");
            AppLog.Write($"PAGE-WINDOW nav {awemeId}");
        }
        catch (Exception ex)
        {
            AppLog.Write("PAGE-WINDOW init err " + ex.Message);
            // 初始化失败:窗口留空不如直接关闭,走 ClosedByUser 让宿主回播放页续播
            try { if (Dispatcher.CheckAccess()) Close(); else Dispatcher.Invoke(Close); } catch { }
        }
    }
}
