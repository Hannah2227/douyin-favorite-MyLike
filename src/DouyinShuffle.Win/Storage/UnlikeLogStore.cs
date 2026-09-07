using System.IO;
using Newtonsoft.Json;

namespace DouyinShuffle.Win.Storage;

/// <summary>
/// 单条取消点赞结果记录(批量取消的逐一审计)。
/// Status: success=已取消 / rejected=接口明确拒绝(下架、重复取消等) / noresponse=疑似风控/黑洞。
/// </summary>
public sealed class UnlikeLogEntry
{
    public string AwemeId { get; set; } = "";
    public string Desc { get; set; } = "";
    public string AuthorName { get; set; } = "";
    public long CreateTime { get; set; }
    public string Status { get; set; } = "";
    public string Message { get; set; } = "";
    public long ProcessedAt { get; set; }
}

/// <summary>
/// 批量取消点赞的落盘快照(独立于 items.dylist):
/// - Entries:每条处理结果的审计记录(失败项据此重试);
/// - Active/PendingIds:在途批次的未处理 id 快照,崩溃后据此断点续跑。
/// </summary>
public sealed class UnlikeLog
{
    public string App { get; set; } = "DouyinShuffle";
    public bool Active { get; set; }
    public List<string> PendingIds { get; set; } = new();
    public List<UnlikeLogEntry> Entries { get; set; } = new();
    public long UpdatedAt { get; set; }
}

/// <summary>
/// 批量取消点赞日志存储:unlike_log.json(原子写,与 items.dylist/state.json 隔离)。
/// 复用 AtomicFile.WriteAllText 保证半写不损坏。
/// </summary>
public sealed class UnlikeLogStore
{
    private readonly string _path;

    public UnlikeLogStore(string dataDir)
    {
        _path = Path.Combine(dataDir, "unlike_log.json");
    }

    public UnlikeLog Load()
    {
        try
        {
            if (File.Exists(_path))
                return JsonConvert.DeserializeObject<UnlikeLog>(File.ReadAllText(_path)) ?? new UnlikeLog();
        }
        catch { }
        return new UnlikeLog();
    }

    public void Save(UnlikeLog log)
    {
        log.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        AtomicFile.WriteAllText(_path, JsonConvert.SerializeObject(log, Formatting.Indented));
    }
}
