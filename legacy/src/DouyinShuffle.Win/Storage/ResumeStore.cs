using System.IO;
using Newtonsoft.Json;

namespace DouyinShuffle.Win.Storage;

/// <summary>上次播放会话快照(退出播放页时记录;支持"继续上次播放")。</summary>
public sealed class ResumeSnapshot
{
    /// <summary>退出时正在播放的 aweme_id。</summary>
    public string AwemeId { get; set; } = "";

    /// <summary>该条内的播放位置(秒)。</summary>
    public double PositionSec { get; set; }

    /// <summary>播放队列的 aweme_id 顺序快照(重建队列用)。</summary>
    public List<string> QueueIds { get; set; } = new();

    /// <summary>是否手动退出(连播自然播完整个队列 = false,不提示继续)。</summary>
    public bool ManualExit { get; set; }

    /// <summary>保存时间(unix 秒)。</summary>
    public long SavedAt { get; set; }
}

/// <summary>resume.json 存取(每账号数据目录内,与列表数据同域隔离)。原子写。</summary>
public sealed class ResumeStore
{
    private readonly string _path;

    public ResumeStore(string dataDir)
    {
        _path = Path.Combine(dataDir, "resume.json");
    }

    public ResumeSnapshot? Load()
    {
        try
        {
            if (File.Exists(_path))
                return JsonConvert.DeserializeObject<ResumeSnapshot>(File.ReadAllText(_path));
        }
        catch { }
        return null;
    }

    public void Save(ResumeSnapshot snapshot)
    {
        snapshot.SavedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        AtomicFile.WriteAllText(_path, JsonConvert.SerializeObject(snapshot, Formatting.Indented));
    }

    public void Delete()
    {
        try { if (File.Exists(_path)) File.Delete(_path); } catch { }
    }
}
