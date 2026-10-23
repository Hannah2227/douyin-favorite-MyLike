using System.IO;
using Newtonsoft.Json;

namespace DouyinShuffle.Win.Storage;

/// <summary>单个账号的档案(账号选择页显示 + profile 映射)。</summary>
public sealed class AccountInfo
{
    /// <summary>内部 profile/数据目录名(user1、user2…自增,永不变更,作为稳定主键)。</summary>
    public string ProfileName { get; set; } = "";

    /// <summary>显示名(默认"账号N",用户可在面板里重命名)。</summary>
    public string DisplayName { get; set; } = "";

    /// <summary>该账号上次采集/登录时记录的 sec_uid(身份核对用)。</summary>
    public string SecUid { get; set; } = "";

    /// <summary>头像 URL(登录后从 profile 接口取一次,选择页显示)。</summary>
    public string AvatarUrl { get; set; } = "";

    /// <summary>★实际数据目录名(v1.0.7 修复;为空 = 与 ProfileName 同名)。
    /// 老用户首个账号的数据原地就在 `Data\default` 里(零拷贝引用),这个引用必须**记进清单**:
    /// 早期版本靠"账号数==1"每次推断是否引用 default,于是用户一新增第二个账号(或从别的账号
    /// 切回来),该账号就被静默改指到 `Data\user1` —— 若那份是更旧的拷贝,列表条数/续播位置
    /// 会莫名"回退"。绑定落盘后,新增/删除/切换都不再改变既有账号的目录。</summary>
    public string DataDirName { get; set; } = "";

    /// <summary>★实际 WebView2 profile 目录名(为空 = 与 ProfileName 同名)。
    /// 与 DataDirName 同理:登录态(localStorage/cookie)跟着目录走,改指 = 主题设置、
    /// 登录态都可能"回退"到另一份拷贝。</summary>
    public string ProfileDirName { get; set; } = "";

    /// <summary>最近一次使用时间(unix 秒,账号面板排序用)。</summary>
    public long LastUsedAt { get; set; }

    /// <summary>创建时间(unix 秒)。</summary>
    public long CreatedAt { get; set; }
}

/// <summary>
/// 全局账号清单(accounts.json,位于 DouyinShuffle 根目录,与各账号数据目录平级):
/// 记录本机所有账号的 profile 映射。多账号 = 每账号独立 WebView2 profile(登录态)
/// + 独立数据目录(列表/断点/偏好),一次只有一个账号在线(轻量换舱切换)。
/// </summary>
public sealed class AccountRegistry
{
    /// <summary>全部已知账号(含当前在线的)。</summary>
    public List<AccountInfo> Accounts { get; set; } = new();

    /// <summary>当前在线账号的 ProfileName(应用关闭时记录,下次启动默认选中)。</summary>
    public string CurrentProfile { get; set; } = "";

    public AccountInfo? Find(string profileName)
        => Accounts.FirstOrDefault(a => string.Equals(a.ProfileName, profileName, StringComparison.OrdinalIgnoreCase));

    /// <summary>当前在线账号(CurrentProfile 命中优先,否则第一个)。
    /// [JsonIgnore]:它是 Accounts 的派生视图,早期版本会被一起序列化进 accounts.json,
    /// 多出一份逐字段重复的对象(读回来还用不上)—— 不写、只算。</summary>
    [JsonIgnore]
    public AccountInfo? Current => Find(CurrentProfile) ?? Accounts.FirstOrDefault();

    /// <summary>下一个可用的 profile 名(user1、user2…跳过已占用)。</summary>
    public string NextProfileName()
    {
        for (var i = 1; ; i++)
        {
            var name = "user" + i;
            if (Find(name) == null) return name;
        }
    }

    public static AccountRegistry Load(string rootDir)
    {
        try
        {
            var path = Path.Combine(rootDir, "accounts.json");
            if (File.Exists(path))
                return JsonConvert.DeserializeObject<AccountRegistry>(File.ReadAllText(path)) ?? new AccountRegistry();
        }
        catch { }
        return new AccountRegistry();
    }

    public void Save(string rootDir)
    {
        Directory.CreateDirectory(rootDir);
        var path = Path.Combine(rootDir, "accounts.json");
        Storage.AtomicFile.WriteAllText(path, JsonConvert.SerializeObject(this, Formatting.Indented));
    }
}
