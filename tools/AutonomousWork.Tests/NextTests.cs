using AutonomousWork.Core;

namespace AutonomousWork.Tests;

public sealed class NextTests : IDisposable
{
    readonly RepoFixture fx = new();

    public void Dispose() => fx.Dispose();

    static NextResult.Selected Select(RepoModel model, string? projectId = "alpha")
    {
        var result = WorkSelector.Next(model, projectId);
        return Assert.IsType<NextResult.Selected>(result);
    }

    static NextResult.NoWork ExpectNoWork(RepoModel model, string? projectId = "alpha")
    {
        var result = WorkSelector.Next(model, projectId);
        return Assert.IsType<NextResult.NoWork>(result);
    }

    [Fact]
    public void SelectsHighestPriorityReadyTask()
    {
        fx.WriteProject("alpha");
        fx.WriteTask("alpha", "A-001", priority: 10);
        fx.WriteTask("alpha", "A-002", priority: 500);

        Assert.Equal("A-002", Select(fx.Load()).Task.Id);
    }

    [Fact]
    public void PriorityTie_BrokenByTaskIdAscending()
    {
        fx.WriteProject("alpha");
        fx.WriteTask("alpha", "A-002", priority: 100);
        fx.WriteTask("alpha", "A-001", priority: 100);

        var selected = Select(fx.Load());
        Assert.Equal("A-001", selected.Task.Id);
        Assert.Equal("Owner/Repo", selected.Project.Repository);
        Assert.Equal("projects/alpha/tasks/A-001.md", selected.Task.RelativePath);
    }

    [Fact]
    public void TaskBlockedUntilDependencyIsDone()
    {
        fx.WriteProject("alpha");
        fx.WriteTask("alpha", "A-001", priority: 10);
        fx.WriteTask("alpha", "A-002", priority: 900, dependsOn: ["A-001"]);

        // A-002 has higher priority but waits for A-001.
        Assert.Equal("A-001", Select(fx.Load()).Task.Id);

        fx.WriteTask("alpha", "A-001", priority: 10, status: "done");
        Assert.Equal("A-002", Select(fx.Load()).Task.Id);
    }

    [Fact]
    public void DisabledProject_YieldsNoWork()
    {
        fx.WriteProject("alpha", enabled: false);
        fx.WriteTask("alpha", "A-001");

        var noWork = ExpectNoWork(fx.Load());
        Assert.Contains("disabled", noWork.Reason);
    }

    [Fact]
    public void MaxActiveTasksReached_YieldsNoWork()
    {
        fx.WriteProject("alpha", maxActiveTasks: 1);
        fx.WriteTask("alpha", "A-001", status: "in_progress");
        fx.WriteTask("alpha", "A-002");

        var noWork = ExpectNoWork(fx.Load());
        Assert.Contains("max_active_tasks is 1", noWork.Reason);
    }

    [Fact]
    public void CapacityBelowMax_StillSelects()
    {
        fx.WriteProject("alpha", maxActiveTasks: 2);
        fx.WriteTask("alpha", "A-001", status: "in_progress");
        fx.WriteTask("alpha", "A-002");

        Assert.Equal("A-002", Select(fx.Load()).Task.Id);
    }

    [Fact]
    public void ReviewDoesNotCountAsActiveWork()
    {
        // Deliberate: only in_progress consumes max_active_tasks capacity.
        // Stronger open-PR gating is planned for Step 10.
        fx.WriteProject("alpha", maxActiveTasks: 1);
        fx.WriteTask("alpha", "A-001", status: "review");
        fx.WriteTask("alpha", "A-002");

        Assert.Equal("A-002", Select(fx.Load()).Task.Id);
    }

    [Fact]
    public void NonReadyStatuses_AreNeverSelected()
    {
        fx.WriteProject("alpha");
        fx.WriteTask("alpha", "A-001", priority: 999, status: "draft");
        fx.WriteTask("alpha", "A-002", priority: 998, status: "blocked");
        fx.WriteTask("alpha", "A-003", priority: 1);

        Assert.Equal("A-003", Select(fx.Load()).Task.Id);
    }

    [Fact]
    public void UnknownProject_IsAnError()
    {
        fx.WriteProject("alpha");

        var result = WorkSelector.Next(fx.Load(), "nosuch");
        var unknown = Assert.IsType<NextResult.UnknownProject>(result);
        Assert.Equal("nosuch", unknown.ProjectId);
        Assert.Contains("alpha", unknown.KnownProjectIds);
    }

    [Fact]
    public void InvalidRepo_RefusesSelection_EvenForReadyTasks()
    {
        // `next` runs the SAME full validation as `validate`: a ready task
        // missing required sections blocks selection, not just CI.
        fx.WriteProject("alpha");
        fx.WriteTask("alpha", "A-001", fullSections: false);

        var result = WorkSelector.Next(fx.Load(), "alpha");
        var invalid = Assert.IsType<NextResult.InvalidRepo>(result);
        Assert.Contains(invalid.Errors, d => d.Message.Contains("Missing '## Out of scope' section"));
    }

    [Fact]
    public void DuplicateIds_RefuseSelection()
    {
        fx.WriteProject("alpha", repository: "Owner/Alpha");
        fx.WriteProject("beta", repository: "Owner/Beta");
        fx.WriteTask("alpha", "A-001");
        fx.WriteTask("beta", "A-001");

        Assert.IsType<NextResult.InvalidRepo>(WorkSelector.Next(fx.Load(), "alpha"));
    }

    [Fact]
    public void NoProjectFilter_SelectsGlobalBestAcrossEnabledProjects()
    {
        fx.WriteProject("alpha", repository: "Owner/Alpha");
        fx.WriteProject("beta", repository: "Owner/Beta");
        fx.WriteTask("alpha", "A-001", priority: 100);
        fx.WriteTask("beta", "B-001", priority: 900);

        var selected = Select(fx.Load(), projectId: null);
        Assert.Equal("B-001", selected.Task.Id);
        Assert.Equal("Owner/Beta", selected.Project.Repository);
    }

    [Fact]
    public void NoProjectFilter_SkipsDisabledProjects()
    {
        fx.WriteProject("alpha", repository: "Owner/Alpha", enabled: false);
        fx.WriteProject("beta", repository: "Owner/Beta");
        fx.WriteTask("alpha", "A-001", priority: 900);
        fx.WriteTask("beta", "B-001", priority: 100);

        Assert.Equal("B-001", Select(fx.Load(), projectId: null).Task.Id);
    }

    [Fact]
    public void EmptyProject_YieldsNoWork()
    {
        fx.WriteProject("alpha");

        var noWork = ExpectNoWork(fx.Load());
        Assert.Contains("no eligible ready task", noWork.Reason);
    }
}
