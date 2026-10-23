using System.IO;

namespace DouyinShuffle.Win.Storage;

/// <summary>
/// 原子文件写入:先写同目录唯一临时文件,再 Replace/Move 到目标路径。
/// 防止写入中途崩溃/断电导致数据文件(items.dylist/state.json/导出文件)半写损坏——
/// 目标文件要么是旧内容、要么是完整新内容,不存在中间态。
/// 临时文件必须唯一:state.json 存在"后台 SaveLoop 与 UI 线程 SaveAutoNext"两个并发写者,
/// 若共用固定 .tmp 路径会互相截断/交错 → 落盘损坏的 state.json(启动时静默重置断点)。
/// </summary>
internal static class AtomicFile
{
    public static void WriteAllText(string path, string content)
    {
        var tmp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(tmp, content);
        try
        {
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }
        catch
        {
            // Replace 失败(如目标被占)→ 尽力删除临时文件,不让 .tmp 越积越多
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
            throw;
        }
    }
}
