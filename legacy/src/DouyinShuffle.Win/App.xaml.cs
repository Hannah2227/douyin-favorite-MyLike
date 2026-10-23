using System.Windows;

namespace DouyinShuffle.Win;

/// <summary>
/// 应用入口:挂全局异常兜底,未处理异常不再静默闪退。
/// 日志统一走 AppLog(全项目唯一入口,带锁),写 %LOCALAPPDATA%\DouyinShuffle\init.log。
/// </summary>
public partial class App : Application
{
    private const string LogPathHint = "%LOCALAPPDATA%\\DouyinShuffle\\init.log";

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += (_, ex) =>
        {
            ex.Handled = true;
            AppLog.Write("UI UNHANDLED " + ex.Exception);
            MessageBox.Show($"发生未处理的错误:{ex.Exception.Message}\n\n详细信息已写入日志:\n{LogPathHint}",
                "MyLike", MessageBoxButton.OK, MessageBoxImage.Warning);
        };
        AppDomain.CurrentDomain.UnhandledException += (_, ex) =>
        {
            AppLog.Write("FATAL " + ex.ExceptionObject);
        };
        TaskScheduler.UnobservedTaskException += (_, ex) =>
        {
            ex.SetObserved();
            AppLog.Write("TASK UNOBSERVED " + ex.Exception);
        };
    }
}
