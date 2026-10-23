using System.IO;

namespace DouyinShuffle.Win;

/// <summary>
/// 统一日志(全项目唯一入口):写 %LOCALAPPDATA%\DouyinShuffle\init.log。
/// 带大小上限(2MB 截半),防长期使用无限膨胀(采集时每页写多条 DIAG)。
/// 替代此前 MainWindow.Log / DouyinProbe.Log / PlaybackController.Log 三处静态钩子。
/// </summary>
internal static class AppLog
{
    private static readonly object Sync = new();
    private static string LogPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "DouyinShuffle", "init.log");

    public static void Write(string msg)
    {
        try
        {
            lock (Sync)
            {
                var path = LogPath;
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                // 超过 2MB → 保留后半(简单轮转;诊断日志无需完整历史)
                var fi = new FileInfo(path);
                if (fi.Exists && fi.Length > 2 * 1024 * 1024)
                {
                    var lines = File.ReadAllLines(path);
                    File.WriteAllLines(path, lines[(lines.Length / 2)..]);
                }
                File.AppendAllText(path, $"{DateTime.Now:HH:mm:ss} {msg}\r\n");
            }
        }
        catch { }
    }
}
