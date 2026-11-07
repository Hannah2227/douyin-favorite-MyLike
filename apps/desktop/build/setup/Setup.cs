using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;

internal sealed class Setup
{
    private readonly Window window;
    private readonly string installer;
    private readonly string previous;
    private readonly long requiredBytes;
    private readonly TextBox folder;
    private readonly CheckBox shortcut;
    private readonly Button primary;
    private readonly Button close;
    private readonly Button togglePath;
    private readonly TextBlock heading;
    private readonly TextBlock status;
    private readonly FrameworkElement options;
    private readonly FrameworkElement pathPanel;
    private readonly FrameworkElement progress;
    private bool installing;
    private string installedExecutable;

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 6)
            return 1;

        using (var mutex = new Mutex(false, "Local\\MyLike-Setup-" + args[5]))
        {
            try
            {
                if (!mutex.WaitOne(0))
                    return 0;
            }
            catch (AbandonedMutexException)
            {
                // The previous setup window exited without releasing the mutex.
            }

            try
            {
                var app = new Application();
                var setup = new Setup(args);
                return app.Run(setup.window);
            }
            catch (Exception)
            {
                MessageBox.Show("无法打开 MyLike 安装界面。请重新运行安装程序。", "MyLike 安装");
                return 1;
            }
            finally
            {
                mutex.ReleaseMutex();
            }
        }
    }

    private Setup(string[] args)
    {
        installer = args[0];
        previous = args[2] == @"\." ? null : Path.GetFullPath(args[2]).TrimEnd('\\');
        requiredBytes = long.Parse(args[4], CultureInfo.InvariantCulture) * 1024;
        var resources = Assembly.GetExecutingAssembly();
        using (var view = resources.GetManifestResourceStream("MyLike.Setup.xaml"))
            window = (Window)XamlReader.Load(view);

        var icon = new BitmapImage();
        using (var stream = resources.GetManifestResourceStream("MyLike.Icon.png"))
        {
            icon.BeginInit();
            icon.CacheOption = BitmapCacheOption.OnLoad;
            icon.StreamSource = stream;
            icon.EndInit();
        }
        icon.Freeze();
        window.Icon = icon;
        Control<Image>("Logo").Source = icon;
        heading = Control<TextBlock>("Heading");
        status = Control<TextBlock>("Status");
        folder = Control<TextBox>("Folder");
        shortcut = Control<CheckBox>("Shortcut");
        primary = Control<Button>("Primary");
        close = Control<Button>("CloseButton");
        togglePath = Control<Button>("TogglePath");
        options = Control<FrameworkElement>("Options");
        pathPanel = Control<FrameworkElement>("PathPanel");
        progress = Control<FrameworkElement>("Progress");

        folder.Text = Path.GetFullPath(args[1]).TrimEnd('\\');
        shortcut.IsChecked = args[3] == "1";
        Control<Button>("MinimizeButton").Click += (sender, e) => window.WindowState = WindowState.Minimized;
        close.Click += (sender, e) => window.Close();
        window.Closing += (sender, e) => e.Cancel = installing;
        togglePath.Click += (sender, e) => SetPathVisible(pathPanel.Visibility != Visibility.Visible);
        Control<Button>("Browse").Click += (sender, e) => Browse();
        primary.Click += (sender, e) => Activate();
        folder.TextChanged += (sender, e) => SetStatus("");
    }

    private T Control<T>(string name) where T : class
    {
        return (T)window.FindName(name);
    }

    private void SetPathVisible(bool visible)
    {
        pathPanel.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        togglePath.Content = visible ? "收起安装地址  ⌃" : "自定义安装地址  ⌄";
        if (visible)
            folder.Focus();
    }

    private void SetStatus(string message, bool error = false)
    {
        status.Foreground = new SolidColorBrush(error ? Color.FromRgb(165, 35, 72) : Color.FromRgb(103, 93, 107));
        status.Text = message;
    }

    private void Browse()
    {
        try
        {
            var selected = FolderPicker.Choose(window, folder.Text);
            if (selected == null)
                return;

            var path = Path.GetFullPath(selected).TrimEnd('\\');
            // When choosing a shared folder, propose a dedicated MyLike subfolder.
            if (!IsPrevious(path) && (IsRoot(selected) || HasEntries(path)))
                path = Path.Combine(selected, "MyLike");
            folder.Text = path;
        }
        catch (Exception)
        {
            SetStatus("无法读取该位置。请手动输入安装地址。", true);
        }
    }

    private static bool HasEntries(string path)
    {
        using (var entries = Directory.EnumerateFileSystemEntries(path).GetEnumerator())
            return entries.MoveNext();
    }

    private bool IsPrevious(string path)
    {
        return string.Equals(path, previous, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsRoot(string path)
    {
        return string.Equals(Path.GetPathRoot(path).TrimEnd('\\'), path.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    }

    private string ValidateLocation()
    {
        var text = folder.Text.Trim();
        if (text.Length < 3 || !char.IsLetter(text[0]) || text[1] != ':' ||
            (text[2] != '\\' && text[2] != '/'))
            throw new IOException("请输入本机磁盘上的完整安装地址。");

        var full = Path.GetFullPath(text);
        var path = full.TrimEnd('\\');
        if (IsRoot(full) || File.Exists(path))
            throw new IOException("请为 MyLike 选择一个独立的安装文件夹。");

        if (!IsPrevious(path) && Directory.Exists(path) && HasEntries(path))
            throw new IOException("该文件夹已有其他文件。请选择空文件夹或原来的 MyLike 安装位置。");

        if (new DriveInfo(Path.GetPathRoot(full)).AvailableFreeSpace < requiredBytes)
            throw new IOException("磁盘空间不足。请选择其他安装位置。");

        Directory.CreateDirectory(path);
        using (new FileStream(Path.Combine(path, ".mylike-" + Guid.NewGuid().ToString("N")),
            FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose))
        {
            // Probe write access before handing the directory to NSIS.
        }
        return path;
    }

    private async void Activate()
    {
        if (installing)
            return;
        if (installedExecutable != null)
        {
            try
            {
                Process.Start(new ProcessStartInfo(installedExecutable)
                {
                    WorkingDirectory = Path.GetDirectoryName(installedExecutable)
                });
                window.Close();
            }
            catch (Exception)
            {
                SetStatus("暂时无法启动 MyLike。你也可以从开始菜单打开。", true);
            }
            return;
        }

        string path;
        try
        {
            path = ValidateLocation();
        }
        catch (UnauthorizedAccessException)
        {
            SetPathVisible(true);
            SetStatus("无法写入该位置。请选择有写入权限的文件夹。", true);
            return;
        }
        catch (IOException error)
        {
            SetPathVisible(true);
            SetStatus(error.Message, true);
            return;
        }
        catch (Exception)
        {
            SetPathVisible(true);
            SetStatus("无法使用该安装地址。请检查路径或选择其他位置。", true);
            return;
        }

        installing = true;
        close.IsEnabled = false;
        primary.Visibility = Visibility.Collapsed;
        options.Visibility = Visibility.Collapsed;
        progress.Visibility = Visibility.Visible;
        heading.Text = "正在安装";
        SetStatus("正在将 MyLike 安装到所选位置");
        try
        {
            var arguments = "/S /currentuser" + (shortcut.IsChecked == true ? "" : " --no-desktop-shortcut");
            using (var process = Process.Start(new ProcessStartInfo(installer, arguments + " /D=" + path)
            {
                UseShellExecute = false,
                CreateNoWindow = true
            }))
            {
                await Task.Run(() => process.WaitForExit());
                if (process.ExitCode != 0)
                    throw new IOException();
            }
            var executable = Path.Combine(path, "MyLike.exe");
            if (!File.Exists(executable))
                throw new IOException();

            installedExecutable = executable;
            heading.Text = "安装完成";
            primary.Content = "打开 MyLike";
            SetStatus("也可以从开始菜单打开 MyLike");
        }
        catch (Exception)
        {
            heading.Text = "MyLike";
            options.Visibility = Visibility.Visible;
            SetPathVisible(true);
            SetStatus("安装未完成。请确认 MyLike 已退出，然后重试。", true);
        }
        finally
        {
            installing = false;
            progress.Visibility = Visibility.Collapsed;
            close.IsEnabled = true;
            primary.Visibility = Visibility.Visible;
        }
    }
}
