using System.IO;
using DouyinShuffle.Win.Capture;
using DouyinShuffle.Win.Storage;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DouyinShuffle.Win.Export;

/// <summary>
/// 播放列表导入导出(.dylist 格式,与本应用存储格式一致)。
/// format:2 = 仅元数据(链接不导出;导入后播放时实时取链,天然一致)。
/// </summary>
public static class Exporter
{
    private const int Format = 2;
    private const string AppTag = "DouyinShuffle";

    /// <summary>导出 .dylist 播放列表(仅元数据,不含链接)。返回文件路径。</summary>
    public static string ExportDylist(IEnumerable<AwemeItem> items, string filePath)
    {
        var list = items as ICollection<AwemeItem> ?? items.ToList();   // 单次物化(避免双重枚举)
        var root = new JObject
        {
            ["app"] = AppTag,
            ["format"] = Format,
            ["count"] = list.Count,
            ["exported_at"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            ["items"] = JArray.FromObject(list)
        };
        AtomicFile.WriteAllText(filePath, root.ToString(Formatting.Indented));
        return filePath;
    }

    /// <summary>
    /// 导入 .dylist 播放列表。返回条目列表;格式不符返回 null。
    /// 仅接受本应用导出的格式(format==2 && app==DouyinShuffle)。
    /// </summary>
    public static List<AwemeItem>? ImportDylist(string filePath)
    {
        try
        {
            var root = JObject.Parse(File.ReadAllText(filePath));
            if (root["app"]?.Value<string>() != AppTag) return null;
            if (root["format"]?.Value<int>() != Format) return null;
            if (root["items"] is not JArray arr) return null;
            return arr.ToObject<List<AwemeItem>>() ?? new List<AwemeItem>();
        }
        catch { return null; }
    }
}
