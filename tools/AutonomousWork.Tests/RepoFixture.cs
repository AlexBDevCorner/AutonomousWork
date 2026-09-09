using AutonomousWork.Core;

namespace AutonomousWork.Tests;

/// <summary>
/// Builds an isolated control repo under a temp directory.
/// Each test gets a fresh fixture (xUnit constructs one instance per test).
/// </summary>
sealed class RepoFixture : IDisposable
{
    public string Root { get; }

    public RepoFixture()
    {
        Root = Path.Combine(Path.GetTempPath(), "aw-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Root);
    }

    public string WriteProject(
        string id,
        string repository = "Owner/Repo",
        bool enabled = true,
        int maxActiveTasks = 1,
        string? name = null,
        string? extraYaml = null)
    {
        var dir = Path.Combine(Root, "projects", id);
        Directory.CreateDirectory(Path.Combine(dir, "tasks"));
        var yaml =
            $"id: {id}\n" +
            $"name: {name ?? id}\n" +
            $"repository: {repository}\n" +
            $"enabled: {(enabled ? "true" : "false")}\n" +
            $"max_active_tasks: {maxActiveTasks}\n" +
            (extraYaml is null ? "" : extraYaml + "\n");
        var path = Path.Combine(dir, "project.yaml");
        File.WriteAllText(path, yaml);
        return path;
    }

    public string WriteTask(
        string projectId,
        string id,
        int priority = 100,
        string status = "ready",
        string[]? dependsOn = null,
        bool fullSections = true,
        string? extraFrontMatter = null,
        string? fileName = null,
        string? body = null)
    {
        var dir = Path.Combine(Root, "projects", projectId, "tasks");
        Directory.CreateDirectory(dir);
        var deps = dependsOn is null || dependsOn.Length == 0
            ? "[]"
            : "\n" + string.Join("\n", dependsOn.Select(d => $"  - {d}"));
        var content =
            $"---\n" +
            $"id: {id}\n" +
            $"priority: {priority}\n" +
            $"status: {status}\n" +
            $"depends_on: {deps}\n" +
            (extraFrontMatter is null ? "" : extraFrontMatter + "\n") +
            $"---\n" +
            $"\n" +
            (body ?? (fullSections ? FullBody(id) : $"# {id}\n"));
        var path = Path.Combine(dir, fileName ?? $"{id}.md");
        File.WriteAllText(path, content);
        return path;
    }

    public static string FullBody(string id) =>
        $"# {id} — title\n" +
        $"\n## Goal\n\nGoal text.\n" +
        $"\n## Context\n\nContext text.\n" +
        $"\n## Requirements\n\n1. Requirement one.\n" +
        $"\n## Architectural direction\n\nDirection text.\n" +
        $"\n## Acceptance criteria\n\n- [ ] Criterion one.\n" +
        $"\n## Verification\n\nRun the checks.\n" +
        $"\n## Out of scope\n\n- Nothing else.\n";

    public RepoModel Load(bool checkSections = true) =>
        RepoLoader.Load(Root, checkSections);

    public void Dispose()
    {
        try { Directory.Delete(Root, recursive: true); }
        catch (DirectoryNotFoundException) { }
        catch (IOException) { }
    }
}
