using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace DouyinShuffle.Win;

/// <summary>
/// 抖音引擎窗口(屏幕外常驻):承载登录态/签名/采集的抖音 WebView。
/// - 为什么独立窗口:WebView2 是 HwndHost(Win32 子窗口),不受 WPF Grid 的 z-order 裁剪,
///   放主窗口里一旦 Visible 就会盖住 UI 页 → 必须物理隔离;
/// - 为什么常显:Collapsed/隐藏窗口会让 Chromium 停止渲染,SPA 懒加载与页面自身的
///   签名请求(直连采集的模板来源)都不发生;
/// - 为什么屏幕外:用户不可见。Windows 对屏幕外窗口仍保持渲染(比最小化/隐藏强)。
/// 与主窗口共享同一 CoreWebView2Environment(profile) → cookie/登录态全局共享。
/// </summary>
public partial class DouyinEngineWindow : Window
{
    public CoreWebView2? Core => EngineWebView.CoreWebView2;

    public DouyinEngineWindow()
    {
        InitializeComponent();
        // Show 前先定位(防首帧在主屏 (0,0) 闪现);Loaded 再校一次(多屏热插拔/DPI 变化后兜底)
        PositionOffscreen();
        Loaded += (_, _) => PositionOffscreen();
    }

    /// <summary>
    /// 定位到所有显示器左侧之外(不可见但持续渲染)。
    /// 注:不能用主屏右缘 —— 右侧副屏起点常正好在主屏右缘,引擎窗会完整暴露在副屏左上角
    /// (幽灵抖音页面);也不能只按主屏 WorkArea.Left 左移 —— 若副屏在主屏左侧
    /// (Left 为负的扩展布局),按主屏左缘外移仍会落在副屏可视区内。
    /// 正确锚点:虚拟屏幕最左缘(VirtualScreenLeft,多屏合一的左边界,负值即代表左侧有副屏),
    /// 再左移一个窗口宽 + 余量 → 必然在所有显示器可视区之外。
    /// </summary>
    private void PositionOffscreen()
    {
        try
        {
            Left = SystemParameters.VirtualScreenLeft - Width - 50;
            Top = SystemParameters.VirtualScreenTop;
        }
        catch { }
    }

    /// <summary>暴露 WebView2 控件供宿主初始化(EnsureCoreWebView2Async)。</summary>
    public System.Threading.Tasks.Task EnsureAsync(CoreWebView2Environment env)
        => EngineWebView.EnsureCoreWebView2Async(env);
}
