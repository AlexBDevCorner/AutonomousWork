namespace AutonomousWork.Core;

/// <summary>
/// Deterministic work selection. No AI involved.
/// Only <c>in_progress</c> counts as active work toward
/// <c>max_active_tasks</c>; <c>review</c> does not block scheduling.
/// (Stronger open-PR gating is planned for Step 10.)
/// </summary>
public static class WorkSelector
{
    public static NextResult Next(RepoModel model, string? projectId)
    {
        if (model.HasErrors)
            return new NextResult.InvalidRepo(model.Errors);

        List<ProjectInfo> scope;
        if (projectId is not null)
        {
            var project = model.Projects.FirstOrDefault(p =>
                string.Equals(p.Id, projectId, StringComparison.Ordinal));
            if (project is null)
            {
                return new NextResult.UnknownProject(projectId,
                    model.Projects.Select(p => p.Id).OrderBy(id => id).ToList());
            }
            scope = [project];
        }
        else
        {
            scope = model.Projects.OrderBy(p => p.Id, StringComparer.Ordinal).ToList();
        }

        var byId = model.Tasks.ToDictionary(t => t.Id, StringComparer.Ordinal);
        var candidates = new List<(ProjectInfo Project, TaskInfo Task)>();
        string? reason = null;

        foreach (var project in scope)
        {
            if (!project.Enabled)
            {
                reason ??= projectId is not null
                    ? $"project '{project.Id}' is disabled (enabled: false)."
                    : null;
                continue;
            }

            var active = model.Tasks.Count(t =>
                t.ProjectId == project.Id && t.Status == "in_progress");
            if (active >= project.MaxActiveTasks)
            {
                reason ??= projectId is not null
                    ? $"project '{project.Id}' has {active} in_progress task(s), " +
                      $"max_active_tasks is {project.MaxActiveTasks}."
                    : null;
                continue;
            }

            foreach (var task in model.Tasks.Where(t => t.ProjectId == project.Id))
            {
                if (task.Status != "ready")
                    continue;
                if (!task.DependsOn.All(dep => byId.TryGetValue(dep, out var d) && d.Status == "done"))
                    continue;
                candidates.Add((project, task));
            }
        }

        if (candidates.Count == 0)
        {
            reason ??= projectId is not null
                ? $"no eligible ready task in project '{projectId}'."
                : "no eligible ready task in any enabled project.";
            return new NextResult.NoWork(reason);
        }

        var best = candidates
            .OrderByDescending(c => c.Task.Priority)
            .ThenBy(c => c.Task.Id, StringComparer.Ordinal)
            .First();
        return new NextResult.Selected(best.Project, best.Task);
    }
}

public abstract record NextResult
{
    public sealed record Selected(ProjectInfo Project, TaskInfo Task) : NextResult;
    public sealed record NoWork(string Reason) : NextResult;
    public sealed record UnknownProject(string ProjectId, IReadOnlyList<string> KnownProjectIds) : NextResult;
    public sealed record InvalidRepo(IReadOnlyList<Diagnostic> Errors) : NextResult;
}
