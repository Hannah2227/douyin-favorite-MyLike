using DouyinShuffle.Win.Capture;
using DouyinShuffle.Win.Storage;

// No WebView, network, cookies, or user data. Use isolated test directories.
var root = Path.Combine(Path.GetTempPath(), "MyLike-merge-tests", Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var oldDir = Path.Combine(root, "old-account");
var newDir = Path.Combine(root, "new-account");
Directory.CreateDirectory(oldDir);
Directory.CreateDirectory(newDir);
var oldStore = new UnlikeLogStore(oldDir);
var newStore = new UnlikeLogStore(newDir);
newStore.Save(new UnlikeLog { PendingIds = new() { "new-only" } });
var newBytes = File.ReadAllBytes(Path.Combine(newDir, "unlike_log.json"));
var entered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
var release = new TaskCompletionSource<UnlikeOneResult>(TaskCreationOptions.RunContinuationsAsynchronously);
var receivedToken = CancellationToken.None;
var calls = new List<string>();
var removed = new List<string>();
var ended = false;
var items = new List<AwemeItem>
{
    new() { AwemeId = "old-1", AuthorName = "Alice", CreateTime = 100 },
    new() { AwemeId = "old-2", AuthorName = "Bob", CreateTime = 200 },
    new() { AwemeId = "invalid", Status = 1 }
};
var batch = new UnlikeBatchService(
    (id, token) => { calls.Add(id); receivedToken = token; entered.TrySetResult(true); return release.Task; },
    oldStore, () => items,
    id => removed.Add(id), _ => { }, (_, _, _) => { }, _ => ended = true,
    () => "test", () => Task.CompletedTask, () => throw new Exception("Unexpected verification"),
    () => Task.FromResult(true), () => false);

Check(batch.ResolveTargets(new UnlikeBatchRequest { Scope = "author", Authors = new[] { "Alice", "Bob" } })
    .SequenceEqual(new[] { "old-2", "old-1" }), "author targeting survives merge");
Check(batch.ResolveTargets(new UnlikeBatchRequest { Scope = "author" }).Count == 0,
    "empty author selection does not select every item");

batch.Start(new[] { "old-1", "old-2" });
await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
batch.Start(new[] { "invalid" });
var stopped = batch.StopAsync();
Check(receivedToken.IsCancellationRequested, "stop propagates cancellation");
Check(!stopped.IsCompleted && batch.IsRunning, "teardown waits for the in-flight callback");
release.SetResult(new UnlikeOneResult(true, UnlikeFailKind.None, 200, 0, "ok"));
await stopped.WaitAsync(TimeSpan.FromSeconds(5));
Check(!batch.IsRunning && ended, "stop awaits final status notification");
Check(calls.SequenceEqual(new[] { "old-1" }), "stop prevents the next request and rejects concurrent start");
Check(removed.SequenceEqual(new[] { "old-1" }), "a completed success is retained even when stop races it");
var log = oldStore.Load();
Check(!log.Active && log.Entries.Single().AwemeId == "old-1" && log.PendingIds.SequenceEqual(new[] { "old-2" }),
    "old account log is finalized before teardown");
Check(newBytes.SequenceEqual(File.ReadAllBytes(Path.Combine(newDir, "unlike_log.json"))),
    "new account log is untouched");
await batch.StopAsync(); // Idempotent after completion.
Console.WriteLine("All merge lifecycle checks passed.");
Console.WriteLine($"Test data: {root}");

static void Check(bool ok, string description)
{
    if (!ok) throw new Exception(description);
    Console.WriteLine($"PASS: {description}");
}
