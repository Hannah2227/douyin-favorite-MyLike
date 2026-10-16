using System.IO;
using DouyinShuffle.Win.Capture;
using DouyinShuffle.Win.Storage;

static void Check(bool pass, string message) { if (!pass) throw new Exception(message); }
var root = Path.Combine(Path.GetTempPath(), "mylike-storage-test-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
foreach (var source in Enum.GetValues<ListSource>())
{
    var dir = source == ListSource.Likes ? root : Path.Combine(root, source.Key());
    var store = new LikeListStore(dir);
    var parsed = AwemeParser.Parse("{\"status_code\":0,\"aweme_list\":[{\"aweme_id\":\"" + source.Key() + "\",\"desc\":\"test\"}],\"cursor\":42,\"has_more\":true}");
    Check(parsed.MaxCursor == 42 && parsed.Items.Count == 1 && parsed.HasMore, "collection cursor parsing failed");
    store.Save(parsed.Items, parsed.MaxCursor, "test-account", true);
    new ResumeStore(dir).Save(new ResumeSnapshot { AwemeId = source.Key(), PositionSec = 7 });
}
foreach (var source in Enum.GetValues<ListSource>())
{
    var dir = source == ListSource.Likes ? root : Path.Combine(root, source.Key());
    var store = new LikeListStore(dir);
    Check(store.LoadItems().Single().AwemeId == source.Key(), "lists were mixed");
    Check(store.LoadState().MaxCursor == 42 && store.LoadState().CollectIncomplete, "sync state lost");
    Check(new ResumeStore(dir).Load()?.AwemeId == source.Key(), "playback resume was mixed");
}
Check(AwemeParser.Parse("{\"aweme_list\":[],\"max_cursor\":99,\"has_more\":false}").MaxCursor == 99, "legacy likes cursor regressed");
Console.WriteLine("Parser, likes compatibility and three-source storage/resume isolation passed.");
