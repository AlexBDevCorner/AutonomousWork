using AutonomousWork.Core;

namespace AutonomousWork.Tests;

public sealed class ValidateTests : IDisposable
{
    readonly RepoFixture fx = new();

    public void Dispose() => fx.Dispose();

    static List<Diagnostic> Errors(RepoModel model) =>
        model.Diagnostics.Where(d => d.Severity == "ERROR").ToList();

    static void AssertNoErrors(RepoModel model) =>
        Assert.Empty(Errors(model));

    [Fact]
    public void ValidTwoProjectRepo_Passes()
    {
        fx.WriteProject("alpha", repository: "Owner/Alpha");
        fx.WriteTask("alpha", "A-001");
        fx.WriteTask("alpha", "A-002", priority: 90, dependsOn: ["A-001"]);
        fx.WriteProject("beta", repository: "Owner/Beta");
        fx.WriteTask("beta", "B-001");

        AssertNoErrors(fx.Load());
    }

    [Fact]
    public void DuplicateTaskIds_ReportedOnBothFiles()
    {
        fx.WriteProject("alpha", repository: "Owner/Alpha");
        fx.WriteProject("beta", repository: "Owner/Beta");
        fx.WriteTask("alpha", "A-001");
        fx.WriteTask("beta", "A-001");

        var errors = Errors(fx.Load());
        Assert.Equal(2, errors.Count(e => e.Message.Contains("Duplicate task ID 'A-001'")));
    }

    [Fact]
    public void InvalidStatus_Reported()
    {
        fx.WriteProject("alpha");
        var path = fx.WriteTask("alpha", "A-001");
        File.WriteAllText(path, File.ReadAllText(path).Replace("status: ready", "status: someday"));

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("Invalid status 'someday'"));
    }

    [Fact]
    public void NonexistentDependency_Reported()
    {
        fx.WriteProject("alpha");
        fx.WriteTask("alpha", "A-001", dependsOn: ["A-999"]);

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("Nonexistent dependency 'A-999'"));
    }

    [Theory]
    [InlineData("not-a-repo")]
    [InlineData("Owner/")]
    [InlineData("/Repo")]
    [InlineData("a/b/c")]
    [InlineData("https://github.com/Owner/Repo")]
    [InlineData("Owner/Repo.git")]
    public void InvalidRepository_Reported(string repository)
    {
        fx.WriteProject("alpha", repository: repository);

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("Invalid repository"));
    }

    [Theory]
    [InlineData("high")]
    [InlineData("-1")]
    [InlineData("1001")]
    [InlineData("10.5")]
    public void MalformedPriority_Reported(string rawPriority)
    {
        fx.WriteProject("alpha");
        var path = fx.WriteTask("alpha", "A-001");
        File.WriteAllText(path, File.ReadAllText(path).Replace("priority: 100", $"priority: {rawPriority}"));

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("Malformed priority"));
    }

    [Fact]
    public void TaskInDirectoryWithoutProjectYaml_ReportedAsUnknownProject()
    {
        fx.WriteTask("ghost", "G-001");

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("Missing project.yaml"));
        Assert.Contains(errors, d => d.Message.Contains("Task belongs to unknown project 'ghost'"));
    }

    [Fact]
    public void DoneTaskDependingOnUnfinishedTask_Reported()
    {
        fx.WriteProject("alpha");
        fx.WriteTask("alpha", "A-001");
        fx.WriteTask("alpha", "A-002", status: "done", dependsOn: ["A-001"]);

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("Done task 'A-002' depends on unfinished task(s): A-001"));
    }

    [Fact]
    public void UnknownFrontMatterProperty_Reported()
    {
        fx.WriteProject("alpha");
        fx.WriteTask("alpha", "A-001", extraFrontMatter: "sprint: 3");

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("Unknown front-matter property 'sprint'"));
    }

    [Fact]
    public void UnknownProjectProperty_Reported()
    {
        fx.WriteProject("alpha", extraYaml: "owner: bob");

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("Unknown property 'owner'"));
    }

    [Fact]
    public void CrossProjectDependency_Reported()
    {
        fx.WriteProject("alpha", repository: "Owner/Alpha");
        fx.WriteProject("beta", repository: "Owner/Beta");
        fx.WriteTask("beta", "B-001");
        fx.WriteTask("alpha", "A-001", dependsOn: ["B-001"]);

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("belongs to project 'beta', not 'alpha'"));
    }

    [Fact]
    public void ReadyTaskMissingSection_Reported()
    {
        fx.WriteProject("alpha");
        fx.WriteTask("alpha", "A-001", fullSections: false);

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("Missing '## Out of scope' section"));
    }

    [Fact]
    public void DraftTaskMissingSection_IsWarningOnly()
    {
        fx.WriteProject("alpha");
        fx.WriteTask("alpha", "A-001", status: "draft", fullSections: false);

        var model = fx.Load();
        Assert.Empty(Errors(model));
        Assert.Contains(model.Diagnostics,
            d => d.Severity == "WARN" && d.Message.Contains("Missing '## Out of scope' section"));
    }

    [Fact]
    public void TaskIdFilenameMismatch_Reported()
    {
        fx.WriteProject("alpha");
        fx.WriteTask("alpha", "A-001", fileName: "WRONG.md");

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("does not match file name 'WRONG.md'"));
    }

    [Fact]
    public void ProjectIdDirectoryMismatch_Reported()
    {
        var yamlPath = fx.WriteProject("alpha");
        File.WriteAllText(yamlPath, File.ReadAllText(yamlPath).Replace("id: alpha", "id: beta"));

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("does not match directory name 'alpha'"));
    }

    [Fact]
    public void SelfDependency_Reported()
    {
        fx.WriteProject("alpha");
        fx.WriteTask("alpha", "A-001", dependsOn: ["A-001"]);

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("depends on itself"));
    }

    [Fact]
    public void DuplicateDependency_Reported()
    {
        fx.WriteProject("alpha");
        fx.WriteTask("alpha", "A-002");
        fx.WriteTask("alpha", "A-001", dependsOn: ["A-002", "A-002"]);

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("Duplicate dependency 'A-002'"));
    }

    [Fact]
    public void InProgressOverflowBeyondMaxActiveTasks_Reported()
    {
        fx.WriteProject("alpha", maxActiveTasks: 1);
        fx.WriteTask("alpha", "A-001", status: "in_progress");
        fx.WriteTask("alpha", "A-002", status: "in_progress");

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("has 2 in_progress task(s) but max_active_tasks is 1"));
    }

    [Fact]
    public void MissingFrontMatter_Reported()
    {
        fx.WriteProject("alpha");
        File.WriteAllText(
            Path.Combine(fx.Root, "projects", "alpha", "tasks", "A-001.md"),
            "# A-001\n\nNo front matter here.\n");

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("Missing YAML front matter"));
    }

    [Fact]
    public void StrayTaskFileOutsideTasksDir_Reported()
    {
        fx.WriteProject("alpha");
        File.WriteAllText(
            Path.Combine(fx.Root, "projects", "alpha", "STRAY.md"),
            "---\nid: S-001\npriority: 1\nstatus: ready\ndepends_on: []\n---\n");

        var errors = Errors(fx.Load());
        Assert.Contains(errors, d => d.Message.Contains("not under a tasks/ directory"));
    }
}
