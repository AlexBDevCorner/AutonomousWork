// autonomous-work: deterministic control-repo CLI (no AI involved).
// Commands:
//   autonomous-work validate [--root <path>]
//   autonomous-work next [project-id] [--root <path>]
//
// All logic lives in AutonomousWork.Core (shared with tests); this project
// only parses arguments and renders results.
using System.Text.Json;
using AutonomousWork.Core;

const int ExitOk = 0;
const int ExitError = 1;
const int ExitNoWork = 2;

var argv = args.ToList();
if (argv.Count == 0 || argv.Contains("--help") || argv.Contains("-h") || argv.Contains("help"))
{
    PrintHelp();
    return argv.Count == 0 ? ExitError : ExitOk;
}

var command = argv[0].ToLowerInvariant();
var rest = argv.Skip(1).ToList();
var root = TakeOption(rest, "--root") ?? Directory.GetCurrentDirectory();

try
{
    switch (command)
    {
        case "validate":
            if (rest.Any(a => a.StartsWith('-')))
            {
                Console.Error.WriteLine($"Unknown option: {rest.First(a => a.StartsWith('-'))}");
                return ExitError;
            }
            return ValidateCommand(root);
        case "next":
        {
            string? projectId = rest.Count > 0 && !rest[0].StartsWith('-') ? rest[0] : null;
            if (projectId is not null) rest.RemoveAt(0);
            if (rest.Any(a => a.StartsWith('-')))
            {
                Console.Error.WriteLine($"Unknown option: {rest.First(a => a.StartsWith('-'))}");
                return ExitError;
            }
            return NextCommand(root, projectId);
        }
        default:
            Console.Error.WriteLine($"Unknown command: {command}");
            PrintHelp();
            return ExitError;
    }
}
catch (Exception ex)
{
    Console.Error.WriteLine($"ERROR: {ex.Message}");
    return ExitError;
}

static string? TakeOption(List<string> argv, string name)
{
    var index = argv.IndexOf(name);
    if (index < 0 || index + 1 >= argv.Count)
        return null;
    var value = argv[index + 1];
    argv.RemoveAt(index + 1);
    argv.RemoveAt(index);
    return value;
}

static void PrintHelp()
{
    Console.WriteLine("""
        autonomous-work — deterministic AutonomousWork control-repo CLI.

        Usage:
          autonomous-work validate [--root <path>]
          autonomous-work next [project-id] [--root <path>]

        Commands:
          validate   Check projects/*/project.yaml and projects/*/tasks/*.md.
                     Exit 0 when clean, 1 when any ERROR is reported.
                     WARN lines never fail validation.
          next       Deterministically select the next executable task.
                     Runs the SAME full validation first and refuses to select
                     work when the control repo has any ERROR.
                     Exit 0 + JSON object on stdout when work is available.
                     Exit 2 with empty stdout when no work is available
                     (disabled project, max_active_tasks reached, or no
                     eligible candidate). Exit 1 on errors.

        Selection algorithm (no AI involved):
          1. Project must exist and have enabled: true.
          2. in_progress count must be below max_active_tasks
             (only in_progress counts as active work; review does not block).
          3. Candidates: status == ready AND every depends_on task == done.
          4. Order by priority DESC, task ID ASC; return the first.

        Output of `next` (stdout, exactly these fields):
          {
            "taskId": "RM-048",
            "repository": "AlexBDevCorner/RepoManager",
            "taskPath": "projects/repomanager/tasks/RM-048.md"
          }

        Examples:
          autonomous-work validate
          autonomous-work validate --root C:\repos\AutonomousWork
          autonomous-work next repomanager
        """);
}

static int ValidateCommand(string root)
{
    var model = RepoLoader.Load(root, checkSections: true);
    foreach (var d in model.Diagnostics.OrderBy(d => d.File).ThenBy(d => d.Message))
        Console.WriteLine($"{d.Severity} {d.File}: {d.Message}");

    var errors = model.Diagnostics.Count(d => d.Severity == "ERROR");
    var warnings = model.Diagnostics.Count(d => d.Severity == "WARN");
    if (errors > 0)
    {
        Console.WriteLine($"Validation failed: {errors} error(s), {warnings} warning(s).");
        return ExitError;
    }

    Console.WriteLine($"Validation OK: {model.Projects.Count} project(s), {model.Tasks.Count} task(s).");
    if (warnings > 0)
        Console.WriteLine($"{warnings} warning(s).");
    return ExitOk;
}

static int NextCommand(string root, string? projectId)
{
    // Full validation first: `next` never executes against a control repo
    // that `validate` would reject (structure AND required sections).
    var model = RepoLoader.Load(root, checkSections: true);
    switch (WorkSelector.Next(model, projectId))
    {
        case NextResult.Selected(var project, var task):
        {
            var output = new
            {
                taskId = task.Id,
                repository = project.Repository,
                taskPath = task.RelativePath.Replace('\\', '/'),
            };
            Console.WriteLine(JsonSerializer.Serialize(output,
                new JsonSerializerOptions { WriteIndented = true }));
            return ExitOk;
        }
        case NextResult.NoWork(var reason):
            Console.Error.WriteLine($"No work: {reason}");
            return ExitNoWork;
        case NextResult.UnknownProject(var id, var known):
            Console.Error.WriteLine(
                $"Unknown project '{id}'. Known projects: " +
                (known.Count > 0 ? string.Join(", ", known) : "(none)") + ".");
            return ExitError;
        case NextResult.InvalidRepo(var errors):
            foreach (var d in errors.OrderBy(d => d.File).ThenBy(d => d.Message))
                Console.Error.WriteLine($"ERROR {d.File}: {d.Message}");
            Console.Error.WriteLine("Refusing to select work: control repo has validation errors.");
            return ExitError;
        default:
            Console.Error.WriteLine("ERROR: unexpected selection result.");
            return ExitError;
    }
}
