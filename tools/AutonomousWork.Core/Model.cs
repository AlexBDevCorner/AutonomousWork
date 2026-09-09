namespace AutonomousWork.Core;

public sealed record Diagnostic(string Severity, string File, string Message);

public sealed record ProjectInfo(
    string Id,
    string Name,
    string Repository,
    bool Enabled,
    int MaxActiveTasks,
    string RelativePath);

public sealed record TaskInfo(
    string Id,
    int Priority,
    string Status,
    List<string> DependsOn,
    string ProjectId,
    string RelativePath);

public sealed class RepoModel
{
    public List<ProjectInfo> Projects { get; } = [];
    public List<TaskInfo> Tasks { get; } = [];
    public List<Diagnostic> Diagnostics { get; } = [];

    public bool HasErrors => Diagnostics.Any(d => d.Severity == "ERROR");

    public IReadOnlyList<Diagnostic> Errors =>
        Diagnostics.Where(d => d.Severity == "ERROR").ToList();
}
