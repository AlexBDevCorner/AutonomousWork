export class GitHub {
  constructor(token, fetcher = fetch) {
    if (!token) throw new Error('GH_TOKEN is required for GitHub access.');
    this.token = token;
    this.fetcher = fetcher;
  }
  async request(method, path, body) {
    // Only idempotent reads retry. A failed dispatch can have been accepted by GitHub.
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetcher(`https://api.github.com${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'AutonomousWork', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (method === 'GET' && response.status >= 500 && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]} failed: HTTP ${response.status}`);
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
  }
  async pages(path, field) {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const value = await this.request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const items = field ? value[field] : value;
      if (!Array.isArray(items)) throw new Error('Unexpected GitHub list response.');
      all.push(...items);
      if (items.length < 100) return all;
    }
    throw new Error('GitHub pagination limit reached; refusing an incomplete snapshot.');
  }
  async snapshot(repository, target, executionRecords) {
    const prefix = `/repos/${repository}`;
    const prs = await this.pages(`${prefix}/pulls?state=all`);
    // All active workflows count, including comment-driven fixes and manually dispatched workers.
    const runs = await this.pages(`${prefix}/actions/runs?created=${encodeURIComponent('>=' + new Date(Date.now() - 7 * 86400000).toISOString())}`, 'workflow_runs');
    // Old/queued claimed runs must remain observable beyond the recent list window.
    for (const record of executionRecords) {
      const attempt = record.attempts.at(-1);
      if (attempt?.runId && !runs.some(r => r.id === attempt.runId))
        runs.push(await this.request('GET', `${prefix}/actions/runs/${attempt.runId}`));
    }
    const relevantRuns = runs.filter(r => r.path === `.github/workflows/${target.workflow}` || r.path === '.github/workflows/opencode.yml');
    const reviews = {}, checks = {}, comments = {};
    for (let i = 0; i < prs.length; i++) {
      const pr = prs[i];
      if (!pr.head.ref.startsWith('autonomous/')) continue;
      // The list endpoint does not include mergeability or authoritative merged state.
      prs[i] = await this.request('GET', `${prefix}/pulls/${pr.number}`);
      if (pr.state === 'open') {
        reviews[pr.number] = await this.pages(`${prefix}/pulls/${pr.number}/reviews`);
        checks[pr.number] = await this.pages(`${prefix}/commits/${pr.head.sha}/check-runs`, 'check_runs');
        comments[pr.number] = await this.pages(`${prefix}/issues/${pr.number}/comments`);
      }
    }
    return { prs, runs: relevantRuns, reviews, checks, comments };
  }
  async commitFiles(repository, branch, parent, files, message) {
    const prefix = `/repos/${repository}`;
    const current = await this.request('GET', `${prefix}/git/ref/heads/${branch}`);
    if (current.object.sha !== parent) throw new Error('Control branch advanced; rerun with its current HEAD.');
    const commit = await this.request('GET', `${prefix}/git/commits/${parent}`);
    const tree = await this.request('POST', `${prefix}/git/trees`, {
      base_tree: commit.tree.sha,
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
    });
    const next = await this.request('POST', `${prefix}/git/commits`, { message, tree: tree.sha, parents: [parent] });
    // A second concurrent writer cannot fast-forward its sibling commit over this one.
    await this.request('PATCH', `${prefix}/git/refs/heads/${branch}`, { sha: next.sha, force: false });
    return next.sha;
  }
  dispatch(repository, target, inputs) {
    return this.request('POST', `/repos/${repository}/actions/workflows/${target.workflow}/dispatches`,
      { ref: target.branch, inputs });
  }
}
