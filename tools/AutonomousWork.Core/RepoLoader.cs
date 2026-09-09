using System.Text.RegularExpressions;

namespace AutonomousWork.Core;

public static class RepoLoader
{
    static readonly HashSet<string> ValidStatuses = new(StringComparer.Ordinal)
        { "draft", "ready", "in_progress", "review", "blocked", "done" };
    static readonly HashSet<string> AllowedTaskKeys = new(StringComparer.Ordinal)
        { "id", "priority", "status", "depends_on" };
    static readonly HashSet<string> AllowedProjectKeys = new(StringComparer.Ordinal)
        { "id", "name", "repository", "enabled", "max_active_tasks" };
    static readonly Regex ProjectIdPattern = new(@"^[a-z0-9][a-z0-9-]*$", RegexOptions.Compiled);
    static readonly Regex TaskIdPattern = new(@"^[A-Z]+-[0-9]+$", RegexOptions.Compiled);
    static readonly Regex RepositoryPattern = new(@"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", RegexOptions.Compiled);
    // Required for every task whose status != draft, so the file alone tells
    // OpenCode what completion means. "Architectural direction" stays optional.
    static readonly string[] RequiredSections =
        ["goal", "context", "requirements", "acceptance criteria", "verification", "out of scope"];

    public static RepoModel Load(string root, bool checkSections)
    {
        var model = new RepoModel();
        root = Path.GetFullPath(root);
        var projectsDir = Path.Combine(root, "projects");

        if (!Directory.Exists(projectsDir))
        {
            model.Diagnostics.Add(new Diagnostic("ERROR", "projects", "Missing projects/ directory."));
            return model;
        }

        var projectDirs = Directory.GetDirectories(projectsDir).OrderBy(Path.GetFileName).ToList();
        if (projectDirs.Count == 0)
            model.Diagnostics.Add(new Diagnostic("ERROR", "projects", "No projects defined (projects/ is empty)."));

        var seenProjectIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var dir in projectDirs)
        {
            var dirName = Path.GetFileName(dir)!;
            var yamlPath = Path.Combine(dir, "project.yaml");
            if (!File.Exists(yamlPath))
            {
                model.Diagnostics.Add(new Diagnostic("ERROR", Rel(root, dir),
                    $"Missing project.yaml (directory projects/{dirName}/ has no project definition)."));
                continue;
            }
            ParseProject(model, root, dirName, yamlPath, seenProjectIds);
        }

        // Duplicate target repositories: each project must map to exactly one
        // repo; sharing one repo between projects breaks that 1:1 mapping.
        foreach (var group in model.Projects.GroupBy(p => p.Repository, StringComparer.OrdinalIgnoreCase)
                     .Where(g => g.Count() > 1).OrderBy(g => g.Key))
        {
            var owners = string.Join(", ", group.Select(p => $"'{p.Id}'").OrderBy(s => s));
            model.Diagnostics.Add(new Diagnostic("WARN", $"projects/{group.First().Id}/project.yaml",
                $"Repository '{group.Key}' is shared by multiple projects ({owners}); each project should map to exactly one dedicated repository."));
        }

        var knownProjectIds = new HashSet<string>(model.Projects.Select(p => p.Id), StringComparer.Ordinal);

        foreach (var dir in projectDirs)
        {
            var dirName = Path.GetFileName(dir)!;
            var tasksDir = Path.Combine(dir, "tasks");
            if (Directory.Exists(tasksDir))
            {
                foreach (var file in Directory.GetFiles(tasksDir, "*.md").OrderBy(Path.GetFileName))
                    ParseTask(model, root, dirName, file, knownProjectIds, checkSections);
            }
            // Stray markdown that the dispatcher will never see.
            foreach (var stray in Directory.GetFiles(dir, "*.md").OrderBy(Path.GetFileName))
            {
                model.Diagnostics.Add(new Diagnostic("ERROR", Rel(root, stray),
                    $"Task file is not under a tasks/ directory; move it to projects/{dirName}/tasks/."));
            }
        }

        // Cross-file task checks.
        foreach (var group in model.Tasks.GroupBy(t => t.Id, StringComparer.Ordinal)
                     .Where(g => g.Count() > 1).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            foreach (var task in group.OrderBy(t => t.RelativePath))
                model.Diagnostics.Add(new Diagnostic("ERROR", task.RelativePath,
                    $"Duplicate task ID '{task.Id}' (also defined in {group.First(g => g != task).RelativePath})."));
        }

        var byId = model.Tasks
            .GroupBy(t => t.Id, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

        foreach (var task in model.Tasks.OrderBy(t => t.RelativePath))
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var dep in task.DependsOn)
            {
                if (!TaskIdPattern.IsMatch(dep))
                    model.Diagnostics.Add(new Diagnostic("ERROR", task.RelativePath,
                        $"Malformed dependency ID '{dep}' (expected like ABC-123)."));
                else if (dep == task.Id)
                    model.Diagnostics.Add(new Diagnostic("ERROR", task.RelativePath,
                        $"Task '{task.Id}' depends on itself."));
                else if (!byId.TryGetValue(dep, out var target))
                    model.Diagnostics.Add(new Diagnostic("ERROR", task.RelativePath,
                        $"Nonexistent dependency '{dep}' (no such task ID)."));
                else if (target.ProjectId != task.ProjectId)
                    model.Diagnostics.Add(new Diagnostic("ERROR", task.RelativePath,
                        $"Dependency '{dep}' belongs to project '{target.ProjectId}', not '{task.ProjectId}' (cross-project dependencies are not allowed)."));
                if (!seen.Add(dep))
                    model.Diagnostics.Add(new Diagnostic("ERROR", task.RelativePath,
                        $"Duplicate dependency '{dep}' (depends_on must list each ID once)."));
            }

            if (task.Status == "done")
            {
                var unfinished = task.DependsOn
                    .Where(dep => byId.TryGetValue(dep, out var d) && d.Status != "done")
                    .OrderBy(d => d).ToList();
                if (unfinished.Count > 0)
                    model.Diagnostics.Add(new Diagnostic("ERROR", task.RelativePath,
                        $"Done task '{task.Id}' depends on unfinished task(s): {string.Join(", ", unfinished)}."));
            }
        }

        // max_active_tasks enforcement on recorded state.
        foreach (var project in model.Projects.OrderBy(p => p.Id))
        {
            var active = model.Tasks.Count(t => t.ProjectId == project.Id && t.Status == "in_progress");
            if (active > project.MaxActiveTasks)
                model.Diagnostics.Add(new Diagnostic("ERROR", project.RelativePath,
                    $"Project '{project.Id}' has {active} in_progress task(s) but max_active_tasks is {project.MaxActiveTasks}."));
        }

        return model;
    }

    static void ParseProject(RepoModel model, string root, string dirName, string yamlPath,
        HashSet<string> seenProjectIds)
    {
        var rel = Rel(root, yamlPath);
        var fields = ParseSimpleYaml(yamlPath, model, rel);
        if (fields is null)
            return;

        foreach (var key in fields.Keys.OrderBy(k => k))
        {
            if (!AllowedProjectKeys.Contains(key))
                model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                    $"Unknown property '{key}' (allowed: {string.Join(", ", AllowedProjectKeys.OrderBy(k => k))})."));
        }
        foreach (var required in AllowedProjectKeys)
        {
            if (!fields.ContainsKey(required))
                model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                    $"Missing required property '{required}'."));
        }

        var valid = true;
        string id = fields.TryGetValue("id", out var idRaw) ? Unquote(idRaw!) : "";
        if (string.IsNullOrEmpty(id) || !ProjectIdPattern.IsMatch(id))
        {
            model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                $"Invalid project id '{id}' (expected lowercase letters/digits/dashes)."));
            valid = false;
        }
        if (id != dirName)
        {
            model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                $"Project id '{id}' does not match directory name '{dirName}' (projects/<id>/project.yaml)."));
            valid = false;
        }
        if (!seenProjectIds.Add(id))
        {
            model.Diagnostics.Add(new Diagnostic("ERROR", rel, $"Duplicate project ID '{id}'."));
            valid = false;
        }

        string repo = fields.TryGetValue("repository", out var repoRaw) ? Unquote(repoRaw!) : "";
        if (string.IsNullOrEmpty(repo) || !RepositoryPattern.IsMatch(repo) ||
            repo.Contains("://", StringComparison.Ordinal) || repo.EndsWith(".git", StringComparison.OrdinalIgnoreCase))
        {
            model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                $"Invalid repository '{repo}' (expected exactly one target in Owner/Repo format)."));
            valid = false;
        }

        var enabled = false;
        var enabledOk = false;
        if (fields.TryGetValue("enabled", out var enabledRaw))
        {
            if (bool.TryParse(Unquote(enabledRaw!).Trim(), out enabled))
                enabledOk = true;
            else
                model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                    $"Malformed enabled flag '{enabledRaw}' (expected true/false)."));
        }

        var maxActive = 0;
        var maxOk = false;
        if (fields.TryGetValue("max_active_tasks", out var maxRaw))
        {
            if (int.TryParse(Unquote(maxRaw!).Trim(), out maxActive) && maxActive >= 1 && maxActive <= 32)
                maxOk = true;
            else
                model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                    $"Malformed max_active_tasks '{maxRaw}' (expected integer 1-32)."));
        }

        if (fields.TryGetValue("name", out var nameRaw) && string.IsNullOrWhiteSpace(Unquote(nameRaw!)))
            model.Diagnostics.Add(new Diagnostic("ERROR", rel, "Project name must not be empty."));

        if (valid && enabledOk && maxOk)
            model.Projects.Add(new ProjectInfo(id, Unquote(fields["name"]), repo, enabled, maxActive, rel));
        else if (valid && !model.Projects.Any(p => p.Id == id))
            // Keep the project visible for `next` (unknown-project error) even
            // when scalar fields are malformed; validation still fails.
            model.Projects.Add(new ProjectInfo(id,
                fields.TryGetValue("name", out var n) ? Unquote(n!) : id,
                string.IsNullOrEmpty(repo) ? "unknown/unknown" : repo,
                enabledOk && enabled, maxOk ? maxActive : 1, rel));
    }

    static void ParseTask(RepoModel model, string root, string dirName, string file,
        HashSet<string> knownProjectIds, bool checkSections)
    {
        var rel = Rel(root, file);
        var fileId = Path.GetFileNameWithoutExtension(file);

        if (!knownProjectIds.Contains(dirName))
        {
            model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                $"Task belongs to unknown project '{dirName}' (no projects/{dirName}/project.yaml)."));
            return;
        }

        var lines = File.ReadAllLines(file);
        if (lines.Length == 0 || lines[0].Trim() != "---")
        {
            model.Diagnostics.Add(new Diagnostic("ERROR", rel, "Missing YAML front matter (file must start with ---)."));
            return;
        }
        var closing = Array.FindIndex(lines, 1, l => l.Trim() == "---");
        if (closing < 0)
        {
            model.Diagnostics.Add(new Diagnostic("ERROR", rel, "Unterminated YAML front matter (missing closing ---)."));
            return;
        }

        var fm = ParseFrontMatter(lines[1..closing], model, rel);
        if (fm is null)
            return;

        foreach (var key in fm.Keys.OrderBy(k => k))
        {
            if (!AllowedTaskKeys.Contains(key))
                model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                    $"Unknown front-matter property '{key}' (allowed: id, priority, status, depends_on)."));
        }
        foreach (var required in AllowedTaskKeys)
        {
            if (!fm.ContainsKey(required))
                model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                    $"Missing required front-matter property '{required}'."));
        }

        var id = fm.TryGetValue("id", out var idRaw) ? Unquote(idRaw!) : "";
        if (string.IsNullOrEmpty(id) || !TaskIdPattern.IsMatch(id))
            model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                $"Malformed task id '{id}' (expected like ABC-123)."));
        else if (id != fileId)
            model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                $"Task id '{id}' does not match file name '{fileId}.md'."));

        var priority = 0;
        var priorityOk = false;
        if (fm.TryGetValue("priority", out var priRaw))
        {
            var pri = Unquote(priRaw!).Trim();
            if (int.TryParse(pri, out priority) && priority >= 0 && priority <= 1000 &&
                pri == priority.ToString())
                priorityOk = true;
            else
                model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                    $"Malformed priority '{priRaw}' (expected integer 0-1000)."));
        }

        var status = fm.TryGetValue("status", out var statusRaw) ? Unquote(statusRaw!).Trim() : "";
        var statusOk = ValidStatuses.Contains(status);
        if (!statusOk)
            model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                $"Invalid status '{status}' (expected one of: {string.Join(", ", ValidStatuses.OrderBy(s => s))})."));

        var dependsOn = fm.TryGetValue("depends_on", out var depRaw)
            ? ParseDependsOn(depRaw!, model, rel)
            : null;

        if (TaskIdPattern.IsMatch(id) && priorityOk && statusOk && dependsOn is not null)
            model.Tasks.Add(new TaskInfo(id, priority, status, dependsOn, dirName, rel));

        if (checkSections && statusOk)
        {
            var body = lines[(closing + 1)..];
            var hasTitle = body.Any(l => l.StartsWith("# ", StringComparison.Ordinal));
            var sections = body
                .Where(l => l.StartsWith("## ", StringComparison.Ordinal))
                .Select(l => Regex.Replace(l[3..].Trim().ToLowerInvariant(), @"\s+", " "))
                .ToHashSet(StringComparer.Ordinal);
            var missing = RequiredSections.Where(s => !sections.Contains(s)).ToList();
            var severity = status == "draft" ? "WARN" : "ERROR";
            if (!hasTitle)
                model.Diagnostics.Add(new Diagnostic(severity, rel,
                    $"Missing '# Title' heading{(status == "draft" ? " (required before promoting to ready)" : "")}."));
            foreach (var section in missing)
                model.Diagnostics.Add(new Diagnostic(severity, rel,
                    $"Missing '## {ToHeading(section)}' section{(status == "draft" ? " (required before promoting to ready)" : "")}."));
        }
    }

    static string ToHeading(string normalized) => normalized switch
    {
        "acceptance criteria" => "Acceptance criteria",
        "out of scope" => "Out of scope",
        _ => char.ToUpperInvariant(normalized[0]) + normalized[1..],
    };

    // Parses `depends_on`: either `[]` / `[A-1, B-2]` inline or a `- item` list.
    static List<string>? ParseDependsOn(string raw, RepoModel model, string rel)
    {
        var trimmed = raw.Trim();
        if (trimmed.StartsWith('['))
        {
            if (!trimmed.EndsWith(']'))
            {
                model.Diagnostics.Add(new Diagnostic("ERROR", rel, "Malformed depends_on list (unclosed [)."));
                return null;
            }
            var inner = trimmed[1..^1].Trim();
            if (inner == "")
                return [];
            return inner.Split(',').Select(s => Unquote(s.Trim())).Where(s => s != "").ToList();
        }
        if (trimmed == "")
            return [];
        model.Diagnostics.Add(new Diagnostic("ERROR", rel,
            "Malformed depends_on (expected [] or a '- ID' list)."));
        return null;
    }

    // Minimal YAML reader for our flat `key: value` files. Returns null when
    // the block is structurally broken (error already recorded). Handles
    // `depends_on:` followed by `- item` lines by folding them into the value.
    static Dictionary<string, string>? ParseFrontMatter(string[] lines, RepoModel model, string rel)
    {
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        var foldedLists = new HashSet<string>(StringComparer.Ordinal);
        string? listKey = null;
        var listItems = new List<string>();
        var ok = true;

        void FlushList()
        {
            if (listKey is not null)
            {
                fields[listKey] = string.Join("\n", listItems);
                foldedLists.Add(listKey);
                listKey = null;
                listItems.Clear();
            }
        }

        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            if (string.IsNullOrWhiteSpace(line) || line.TrimStart().StartsWith('#'))
                continue;
            var trimmedStart = line.TrimStart();
            if (trimmedStart.StartsWith("- ", StringComparison.Ordinal))
            {
                if (listKey is null)
                {
                    model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                        $"Malformed front matter on line {i + 2}: list item without a key."));
                    ok = false;
                    continue;
                }
                listItems.Add(trimmedStart[2..].Trim());
                continue;
            }
            FlushList();
            var colon = line.IndexOf(':');
            if (colon < 0)
            {
                model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                    $"Malformed front matter on line {i + 2}: expected 'key: value'."));
                ok = false;
                continue;
            }
            var key = line[..colon].Trim();
            var value = line[(colon + 1)..].Trim();
            if (string.IsNullOrEmpty(key))
            {
                model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                    $"Malformed front matter on line {i + 2}: empty key."));
                ok = false;
                continue;
            }
            if (fields.ContainsKey(key) || string.Equals(listKey, key, StringComparison.Ordinal))
            {
                model.Diagnostics.Add(new Diagnostic("ERROR", rel, $"Duplicate front-matter property '{key}'."));
                ok = false;
                continue;
            }
            if (value == "")
                (listKey, listItems) = (key, []);
            else
                fields[key] = value;
        }
        FlushList();

        // Re-expand folded lists into the depends_on shape ParseDependsOn expects.
        if (fields.TryGetValue("depends_on", out var folded) && foldedLists.Contains("depends_on"))
        {
            var items = folded.Split('\n').Select(s => Unquote(s.Trim())).Where(s => s != "").ToList();
            fields["depends_on"] = "[" + string.Join(", ", items) + "]";
        }

        return ok ? fields : null;
    }

    static Dictionary<string, string>? ParseSimpleYaml(string path, RepoModel model, string rel)
    {
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        var ok = true;
        var lines = File.ReadAllLines(path);
        for (var i = 0; i < lines.Length; i++)
        {
            var line = StripInlineComment(lines[i]);
            if (string.IsNullOrWhiteSpace(line))
                continue;
            var colon = line.IndexOf(':');
            if (colon < 0)
            {
                model.Diagnostics.Add(new Diagnostic("ERROR", rel,
                    $"Malformed YAML on line {i + 1}: expected 'key: value'."));
                ok = false;
                continue;
            }
            var key = line[..colon].Trim();
            var value = line[(colon + 1)..].Trim();
            if (fields.ContainsKey(key))
            {
                model.Diagnostics.Add(new Diagnostic("ERROR", rel, $"Duplicate property '{key}'."));
                ok = false;
                continue;
            }
            fields[key] = value;
        }
        return ok ? fields : null;
    }

    static string StripInlineComment(string line)
    {
        var hash = line.IndexOf('#');
        if (hash < 0)
            return line;
        if (hash == 0 || char.IsWhiteSpace(line[hash - 1]))
            return line[..hash];
        return line;
    }

    static string Unquote(string value)
    {
        value = value.Trim();
        if (value.Length >= 2 &&
            ((value[0] == '"' && value[^1] == '"') || (value[0] == '\'' && value[^1] == '\'')))
            return value[1..^1];
        return value;
    }

    static string Rel(string root, string path) =>
        Path.GetRelativePath(root, path).Replace('\\', '/');
}
