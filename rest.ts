// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, over the in-memory store.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id (app.ts
// adds both); errors carry {message}. Auth is decided by app.ts (ctx.authed).

import {
  VIEWER,
  FIXED_ISO,
  FIXED_EPOCH,
  ZERO_OID,
  isObjectId,
  parseCommit,
  parseTree,
  buildCommit,
  putObject,
  peelToCommit,
  findRepo,
  createRepoRecord,
  globalId,
  flattenTree,
  commitFiles,
  listCommits,
  diffTrees,
  mergeBase,
  prConflict,
  refCommit,
  blobText,
} from './store.ts';

function userJson() {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.id),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER.login}`,
    html_url: `https://example.invalid/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(store, repo) {
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  for (const pr of repo.pulls.values()) if (pr.state === 'open') openIssues += 1;
  return {
    id: repo.restId,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function labelJson(label) {
  return { id: label.restId, node_id: label.nodeId, name: label.name, color: label.color, description: '', default: false, url: `/api/v3/labels/${label.restId}` };
}

export function issueJson(store, repo, issue) {
  return {
    id: issue.restId,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(),
    labels: issue.labels.map((label) => labelJson(label)),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
  };
}

function commentJson(store, repo, issue, comment) {
  return {
    id: comment.restId,
    node_id: comment.nodeId,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.restId}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.restId}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

function prDiff(repo, pr) {
  const headTip = refCommit(repo, `refs/heads/${pr.head.ref}`);
  const baseTip = refCommit(repo, `refs/heads/${pr.base.ref}`);
  if (!headTip || !baseTip) return [];
  const base = mergeBase(repo, headTip, baseTip) ?? pr.baseShaAtCreate;
  const baseTree = base ? parseCommit(repo.objects.get(base).data).tree : null;
  const headTree = parseCommit(repo.objects.get(headTip).data).tree;
  return diffTrees(repo, baseTree, headTree);
}

export function prJson(store, repo, pr) {
  const files = prDiff(repo, pr);
  let additions = 0;
  let deletions = 0;
  for (const file of files) { additions += file.additions; deletions += file.deletions; }
  const headSha = refCommit(repo, `refs/heads/${pr.head.ref}`) ?? pr.head.sha;
  const baseSha = refCommit(repo, `refs/heads/${pr.base.ref}`) ?? pr.base.sha;
  return {
    id: pr.restId,
    node_id: pr.nodeId,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    body: pr.body,
    user: userJson(),
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    merged: pr.merged,
    mergeable: pr.merged ? false : !prConflict(repo, pr),
    mergeable_state: pr.merged ? 'unknown' : prConflict(repo, pr) ? 'conflicting' : 'clean',
    merged_by: pr.merged ? userJson() : null,
    draft: false,
    head: {
      label: `${repo.owner}:${pr.head.ref}`,
      ref: pr.head.ref,
      sha: headSha,
      user: userJson(),
      repo: repoJson(store, repo),
    },
    base: {
      label: `${repo.owner}:${pr.base.ref}`,
      ref: pr.base.ref,
      sha: baseSha,
      user: userJson(),
      repo: repoJson(store, repo),
    },
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    diff_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}.diff`,
    patch_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pr.number}`,
    commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/commits`,
    review_comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/comments`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pr.number}/comments`,
    statuses_url: `/api/v3/repos/${repo.owner}/${repo.name}/statuses/${headSha}`,
    additions,
    deletions,
    changed_files: files.length,
    commits: 1,
    review_comments: 0,
    comments: 0,
    maintainer_can_modify: false,
    author_association: 'OWNER',
  };
}

function parsePage(query) {
  const perPageRaw = Number(query.get('per_page'));
  const pageRaw = Number(query.get('page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

function paginate(ctx, list, query) {
  const { perPage, page } = parsePage(query);
  const start = (page - 1) * perPage;
  const items = list.slice(start, start + perPage);
  const headers = {};
  if (start + perPage < list.length) {
    const origin = `http://${ctx.host}`;
    const next = `${origin}${ctx.path}?per_page=${perPage}&page=${page + 1}`;
    const lastPage = Math.ceil(list.length / perPage);
    const last = `${origin}${ctx.path}?per_page=${perPage}&page=${lastPage}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { items, headers };
}

function needRepo(ctx, owner, name) {
  const repo = findRepo(ctx.store, owner, name);
  if (!repo) { ctx.json(404, { message: 'Not Found' }); return null; }
  return repo;
}

function readBodyObject(ctx) {
  if (ctx.bodyParseError) { ctx.json(400, { message: 'Malformed JSON body' }); return null; }
  const body = ctx.jsonBody;
  if (body === null || body === undefined) return {};
  if (typeof body !== 'object' || Array.isArray(body)) { ctx.json(400, { message: 'Malformed JSON body' }); return null; }
  return body;
}

export async function handleRest(ctx) {
  const seg = ctx.segments; // e.g. ['api','v3','repos', owner, name, ...]
  const method = ctx.method;

  // GET /api/v3/ — the API root (no auth needed, GitHub answers it openly).
  if ((method === 'GET') && (seg.length === 2 || (seg.length === 3 && seg[2] === ''))) {
    return ctx.json(200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://example.invalid/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://example.invalid/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
      notifications_url: '/api/v3/notifications',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/user/{user}/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (method === 'GET' && seg.length === 3 && seg[2] === 'meta') {
    return ctx.json(200, { verifiable_password_authentication: false, installed_version: '1.0.0', github_enterprise_version: '1.0.0' });
  }

  // Everything else under /api/v3 requires the bearer token.
  if (!ctx.authed) return ctx.json(401, { message: 'Bad credentials' }, { 'www-authenticate': 'Basic realm="github-core-clone", Bearer' });

  // GET /api/v3/user
  if (method === 'GET' && seg.length === 3 && seg[2] === 'user') {
    return ctx.json(200, userJson());
  }

  // /api/v3/user/repos
  if (seg.length === 4 && seg[2] === 'user' && seg[3] === 'repos') {
    if (method === 'GET') {
      const all = [...ctx.store.repos.values()].sort((a, b) => a.seq - b.seq).map((repo) => repoJson(ctx.store, repo));
      const { items, headers } = paginate(ctx, all, ctx.query);
      return ctx.json(200, items, headers);
    }
    if (method === 'POST') {
      const body = readBodyObject(ctx);
      if (body === null) return;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') return ctx.json(422, { message: 'name is required' });
      if (ctx.store.repos.has(name)) return ctx.json(422, { message: 'Repository already exists' });
      const repo = createRepoRecord(ctx.store, name, {
        description: typeof body.description === 'string' ? body.description : '',
        private: body.private === true,
      });
      return ctx.json(201, repoJson(ctx.store, repo));
    }
    return ctx.notFound();
  }

  // /api/v3/repos/{owner}/{name}[/...]
  if (seg.length >= 5 && seg[2] === 'repos') {
    const owner = seg[3];
    const name = seg[4];
    const rest = seg.slice(5);

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = needRepo(ctx, owner, name);
        if (!repo) return;
        return ctx.json(200, repoJson(ctx.store, repo));
      }
      if (method === 'PATCH') {
        const repo = needRepo(ctx, owner, name);
        if (!repo) return;
        const body = readBodyObject(ctx);
        if (body === null) return;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        return ctx.json(200, repoJson(ctx.store, repo));
      }
      if (method === 'DELETE') {
        const repo = needRepo(ctx, owner, name);
        if (!repo) return;
        ctx.store.repos.delete(name);
        return ctx.empty(204);
      }
      return ctx.notFound();
    }

    const repo = needRepo(ctx, owner, name);
    if (!repo) return;

    // GET /repos/{o}/{r}/branches[/{branch}]
    if (rest[0] === 'branches') {
      if (method !== 'GET') return ctx.notFound();
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      if (rest.length === 1) {
        return ctx.json(200, branches.map((branch) => ({
          name: branch,
          commit: { sha: repo.refs.get(`refs/heads/${branch}`), url: `/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${branch}`)}` },
          protected: false,
        })));
      }
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return ctx.json(404, { message: 'Branch not found' });
      return ctx.json(200, {
        name: branch,
        commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` },
        protected: false,
      });
    }

    // GET /repos/{o}/{r}/commits[?sha=]
    if (rest[0] === 'commits' && rest.length === 1) {
      if (method !== 'GET') return ctx.notFound();
      const from = ctx.query.get('sha') ?? repo.defaultBranch;
      let tip = null;
      if (isObjectId(from)) tip = from;
      else tip = refCommit(repo, `refs/heads/${from}`) ?? refCommit(repo, from);
      if (!tip && from) {
        // Unknown ref: GitHub answers 404 when a sha/branch does not exist.
        if (repo.refs.size === 0 && !isObjectId(from)) return ctx.json(200, []);
        return ctx.json(404, { message: 'No commit found for SHA' });
      }
      const shas = tip ? listCommits(repo, tip, 500) : [];
      const { items, headers } = paginate(ctx, shas, ctx.query);
      return ctx.json(200, items.map((sha) => {
        const commit = parseCommit(repo.objects.get(sha).data);
        return {
          sha,
          node_id: globalId('Commit', sha),
          commit: {
            // The raw object stores the message with a trailing newline;
            // the API surface shows it without one.
            message: commit.message.replace(/\n$/, ''),
            author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO },
            committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO },
            tree: { sha: commit.tree },
            url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}`,
            comment_count: 0,
          },
          url: `/api/v3/repos/${owner}/${name}/commits/${sha}`,
          html_url: `https://example.invalid/${owner}/${name}/commit/${sha}`,
          author: userJson(),
          committer: userJson(),
          parents: commit.parents.map((p) => ({ sha: p })),
        };
      }), headers);
    }

    // /repos/{o}/{r}/git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = readBodyObject(ctx);
        if (body === null) return;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isObjectId(sha)) return ctx.json(422, { message: 'Invalid ref or sha' });
        if (repo.refs.has(ref)) return ctx.json(422, { message: 'Reference already exists' });
        const object = repo.objects.get(sha);
        if (!object || (object.type !== 'commit' && object.type !== 'tag')) return ctx.json(422, { message: 'Object not found' });
        repo.refs.set(ref, sha);
        return ctx.json(201, { ref, node_id: globalId('Ref', `${repo.dbId}:${ref}`), url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: object.type, url: `/api/v3/repos/${owner}/${name}/git/${object.type}s/${sha}` } });
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          return ctx.json(200, [...repo.refs.entries()].sort().map(([ref, sha]) => ({
            ref, node_id: globalId('Ref', `${repo.dbId}:${ref}`),
            url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
            object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' },
          })));
        }
        const ref = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) return ctx.json(404, { message: 'Reference not found' });
        return ctx.json(200, {
          ref, node_id: globalId('Ref', `${repo.dbId}:${ref}`),
          url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
          object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' },
        });
      }
      return ctx.notFound();
    }

    // /repos/{o}/{r}/contents/{path...}
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      const refParam = ctx.query.get('ref');
      const branchFor = (body) => (typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch);
      if (method === 'PUT') {
        const body = readBodyObject(ctx);
        if (body === null) return;
        const branch = branchFor(body);
        const branchTip = refCommit(repo, `refs/heads/${branch}`);
        // A branch that does not exist cannot receive a contents commit, except
        // the default branch of an empty repo (the first commit creates it).
        if (!branchTip && (repo.refs.size > 0 || branch !== repo.defaultBranch)) {
          return ctx.json(404, { message: 'Branch not found' });
        }
        if (typeof body.content !== 'string' || typeof body.message !== 'string') return ctx.json(422, { message: 'content and message are required' });
        let content;
        try { content = Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64'); } catch { return ctx.json(422, { message: 'content is not valid base64' }); }
        const flat = branchTip ? flattenTree(repo, parseCommit(repo.objects.get(branchTip).data).tree) : new Map();
        const existing = flat.get(filePath);
        const isUpdate = existing !== undefined;
        if (isUpdate) {
          if (typeof body.sha !== 'string' || body.sha === '') return ctx.json(422, { message: 'sha is required to update a file' });
          if (body.sha.toLowerCase() !== existing.oid.toLowerCase()) return ctx.json(409, { message: 'sha does not match the current file' });
        } else if (typeof body.sha === 'string' && body.sha !== '') {
          return ctx.json(422, { message: 'sha does not match: the file does not exist' });
        }
        const changes = new Map([[filePath, content]]);
        const commitSha = commitFiles(repo, branch, changes, body.message);
        const blobOid = flattenTree(repo, parseCommit(repo.objects.get(commitSha).data).tree).get(filePath).oid;
        return ctx.json(isUpdate ? 200 : 201, {
          content: {
            name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length,
            url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`,
            html_url: `https://example.invalid/${owner}/${name}/blob/${branch}/${filePath}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${blobOid}`,
            download_url: null, type: 'file', encoding: 'base64',
            content: content.toString('base64'), _links: {},
          },
          commit: {
            sha: commitSha, node_id: globalId('Commit', commitSha), message: body.message,
            author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO },
            committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO },
          },
        });
      }
      if (method === 'GET') {
        let tip = null;
        if (refParam) {
          tip = isObjectId(refParam) ? refParam : (refCommit(repo, `refs/heads/${refParam}`) ?? refCommit(repo, refParam));
          if (!tip || !repo.objects.get(tip)) return ctx.json(404, { message: 'Not Found' });
        } else {
          tip = refCommit(repo, `refs/heads/${repo.defaultBranch}`);
          if (!tip) return ctx.json(404, { message: 'Not Found' });
        }
        const treeOid = parseCommit(repo.objects.get(tip).data).tree;
        const flat = flattenTree(repo, treeOid);
        if (filePath === '') {
          // Root listing.
          const rootEntries = parseTree(repo.objects.get(treeOid).data).map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name, path: entry.name, sha: entry.oid,
            size: entry.mode === '40000' ? undefined : repo.objects.get(entry.oid).data.length,
            url: `/api/v3/repos/${owner}/${name}/contents/${entry.name}`,
            html_url: `https://example.invalid/${owner}/${name}/tree/${repo.defaultBranch}/${entry.name}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/trees/${entry.oid}`,
            download_url: null,
          }));
          return ctx.json(200, rootEntries);
        }
        const file = flat.get(filePath);
        if (file) {
          const data = repo.objects.get(file.oid).data;
          return ctx.json(200, {
            type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop(), path: filePath,
            content: data.toString('base64'), sha: file.oid,
            url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`,
            html_url: `https://example.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${filePath}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${file.oid}`,
            download_url: null,
          });
        }
        // Directory?
        const prefix = `${filePath}/`;
        const children = new Map();
        for (const [path, entry] of flat) {
          if (!path.startsWith(prefix)) continue;
          const restPath = path.slice(prefix.length);
          const first = restPath.split('/')[0];
          if (!children.has(first)) {
            children.set(first, { isDir: restPath.includes('/'), entry, path: `${filePath}/${first}` });
          }
        }
        if (children.size === 0) return ctx.json(404, { message: 'Not Found' });
        const dirTreeOid = treeOidAtPath(repo, treeOid, filePath);
        const entries = [];
        for (const [childName, child] of [...children.entries()].sort()) {
          let sha = child.entry.oid;
          if (child.isDir) {
            const sub = treeOidAtPath(repo, treeOid, child.path);
            if (sub) sha = sub;
          }
          entries.push({
            type: child.isDir ? 'dir' : 'file', name: childName, path: child.path, sha,
            size: child.isDir ? undefined : repo.objects.get(child.entry.oid).data.length,
            url: `/api/v3/repos/${owner}/${name}/contents/${child.path}`,
            html_url: `https://example.invalid/${owner}/${name}/tree/${repo.defaultBranch}/${child.path}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/trees/${sha}`,
            download_url: child.isDir ? null : null,
          });
        }
        return ctx.json(200, entries);
      }
      if (method === 'DELETE') {
        const body = readBodyObject(ctx);
        if (body === null) return;
        const branch = branchFor(body);
        const branchTip = refCommit(repo, `refs/heads/${branch}`);
        if (!branchTip) return ctx.json(404, { message: 'Not Found' });
        const flat = flattenTree(repo, parseCommit(repo.objects.get(branchTip).data).tree);
        const existing = flat.get(filePath);
        if (!existing) return ctx.json(404, { message: 'Not Found' });
        if (typeof body.sha === 'string' && body.sha !== '' && body.sha.toLowerCase() !== existing.oid.toLowerCase()) {
          return ctx.json(409, { message: 'sha does not match the current file' });
        }
        const message = typeof body.message === 'string' ? body.message : `Delete ${filePath}`;
        const commitSha = commitFiles(repo, branch, new Map([[filePath, null]]), message);
        return ctx.json(200, { commit: { sha: commitSha, message, author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO } } });
      }
      return ctx.notFound();
    }

    // /repos/{o}/{r}/labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        return ctx.json(200, [...repo.labels.values()].map(labelJson));
      }
      if (method === 'POST' && rest.length === 1) {
        const body = readBodyObject(ctx);
        if (body === null) return;
        const labelName = typeof body.name === 'string' ? body.name.trim() : '';
        if (labelName === '') return ctx.json(422, { message: 'name is required' });
        const existing = repo.labels.get(labelName);
        if (existing) return ctx.json(201, labelJson(existing));
        const label = {
          name: labelName,
          color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
          restId: ctx.store.nextObjectId++,
          nodeId: '',
        };
        label.nodeId = globalId('Label', `${repo.dbId}:${label.name}`);
        repo.labels.set(labelName, label);
        return ctx.json(201, labelJson(label));
      }
      return ctx.notFound();
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
          let list = [...repo.issues.values()];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const { items, headers } = paginate(ctx, list, ctx.query);
          return ctx.json(200, items.map((issue) => issueJson(ctx.store, repo, issue)), headers);
        }
        if (method === 'POST') {
          const body = readBodyObject(ctx);
          if (body === null) return;
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') return ctx.json(422, { message: 'title is required' });
          const wantedLabels = Array.isArray(body.labels) ? body.labels : [];
          const labels = [];
          for (const raw of wantedLabels) {
            const labelName = typeof raw === 'string' ? raw : raw?.name;
            const label = repo.labels.get(labelName);
            if (!label) return ctx.json(422, { message: `Label '${labelName}' does not exist` });
            labels.push(label);
          }
          const number = repo.nextNumber++;
          const issue = {
            number,
            restId: ctx.store.nextObjectId++,
            nodeId: globalId('Issue', `${repo.dbId}:${number}`),
            title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            labels,
            comments: [],
            createdAt: FIXED_ISO,
            updatedAt: FIXED_ISO,
            closedAt: null,
          };
          repo.issues.set(number, issue);
          return ctx.json(201, issueJson(ctx.store, repo, issue));
        }
        return ctx.notFound();
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number <= 0) return ctx.notFound();
      const issue = repo.issues.get(number);
      if (rest.length === 2) {
        if (!issue) return ctx.json(404, { message: 'Not Found' });
        if (method === 'GET') return ctx.json(200, issueJson(ctx.store, repo, issue));
        if (method === 'PATCH') {
          const body = readBodyObject(ctx);
          if (body === null) return;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') {
            issue.state = body.state;
            issue.closedAt = body.state === 'closed' ? FIXED_ISO : null;
          }
          issue.updatedAt = FIXED_ISO;
          return ctx.json(200, issueJson(ctx.store, repo, issue));
        }
        return ctx.notFound();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return ctx.json(404, { message: 'Not Found' });
        if (method === 'GET') {
          return ctx.json(200, issue.comments.map((comment) => commentJson(ctx.store, repo, issue, comment)));
        }
        if (method === 'POST') {
          const body = readBodyObject(ctx);
          if (body === null) return;
          const text = typeof body.body === 'string' ? body.body : '';
          if (text === '') return ctx.json(422, { message: 'body is required' });
          const seq = repo.nextCommentId++;
          const comment = {
            restId: ctx.store.nextObjectId++,
            nodeId: globalId('IssueComment', `${repo.dbId}:${number}:${seq}`),
            body: text, createdAt: FIXED_ISO, updatedAt: FIXED_ISO,
          };
          issue.comments.push(comment);
          issue.updatedAt = FIXED_ISO;
          return ctx.json(201, commentJson(ctx.store, repo, issue, comment));
        }
        return ctx.notFound();
      }
      return ctx.notFound();
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b) => b.number - a.number);
          const { items, headers } = paginate(ctx, list, ctx.query);
          return ctx.json(200, items.map((pr) => prJson(ctx.store, repo, pr)), headers);
        }
        if (method === 'POST') {
          const body = readBodyObject(ctx);
          if (body === null) return;
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          const title = typeof body.title === 'string' ? body.title : '';
          if (head === '' || title === '') return ctx.json(422, { message: 'head and title are required' });
          const headTip = refCommit(repo, `refs/heads/${head}`);
          if (!headTip) return ctx.json(422, { message: `Head branch '${head}' not found` });
          const baseTip = refCommit(repo, `refs/heads/${base}`);
          if (!baseTip) return ctx.json(422, { message: `Base branch '${base}' not found` });
          for (const existing of repo.pulls.values()) {
            if (existing.state === 'open' && existing.head.ref === head && existing.base.ref === base) {
              return ctx.json(422, { message: 'A pull request already exists for this head and base' });
            }
          }
          const number = repo.nextNumber++;
          const pr = {
            number,
            restId: ctx.store.nextObjectId++,
            nodeId: globalId('PullRequest', `${repo.dbId}:${number}`),
            title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            head: { ref: head, sha: headTip },
            base: { ref: base, sha: baseTip },
            baseShaAtCreate: baseTip,
            merged: false,
            mergeCommitSha: null,
            mergedAt: null,
            closedAt: null,
            createdAt: FIXED_ISO,
            updatedAt: FIXED_ISO,
          };
          repo.pulls.set(number, pr);
          return ctx.json(201, prJson(ctx.store, repo, pr));
        }
        return ctx.notFound();
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number <= 0) return ctx.notFound();
      const pr = repo.pulls.get(number);
      if (rest.length === 2) {
        if (!pr) return ctx.json(404, { message: 'Not Found' });
        if (method === 'GET') return ctx.json(200, prJson(ctx.store, repo, pr));
        return ctx.notFound();
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pr) return ctx.json(404, { message: 'Not Found' });
        if (method !== 'GET') return ctx.notFound();
        const files = prDiff(repo, pr);
        return ctx.json(200, files.map((file) => ({
          sha: file.newOid ?? file.oldOid,
          filename: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          blob_url: `/api/v3/repos/${owner}/${name}/git/blobs/${file.newOid ?? file.oldOid}`,
          raw_url: `https://example.invalid/${owner}/${name}/raw/${pr.head.ref}/${file.path}`,
          contents_url: `/api/v3/repos/${owner}/${name}/contents/${file.path}?ref=${pr.head.ref}`,
          patch: '',
        })));
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') return ctx.notFound();
        if (!pr) return ctx.json(404, { message: 'Not Found' });
        if (pr.merged || pr.state !== 'open') return ctx.json(405, { message: 'Pull request is already merged or closed' });
        if (prConflict(repo, pr)) return ctx.json(405, { message: 'Merge conflict' });
        const headTip = refCommit(repo, `refs/heads/${pr.head.ref}`);
        const baseTip = refCommit(repo, `refs/heads/${pr.base.ref}`);
        if (!headTip || !baseTip) return ctx.json(405, { message: 'Head or base branch is missing' });
        const headTree = parseCommit(repo.objects.get(headTip).data).tree;
        const mergeData = buildMergeCommit(repo, baseTip, headTree, pr);
        const mergeSha = mergeData;
        repo.refs.set(`refs/heads/${pr.base.ref}`, mergeSha);
        pr.merged = true;
        pr.state = 'closed';
        pr.mergedAt = FIXED_ISO;
        pr.closedAt = FIXED_ISO;
        pr.mergeCommitSha = mergeSha;
        pr.updatedAt = FIXED_ISO;
        return ctx.json(200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
      }
      return ctx.notFound();
    }

    return ctx.notFound();
  }

  return ctx.notFound();
}

function treeOidAtPath(repo, treeOid, path) {
  const segments = path.split('/').filter(Boolean);
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segment);
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

function buildMergeCommit(repo, baseTip, headTree, pr) {
  // A squash commit: the head's tree, the base tip as parent.
  const data = buildCommit({
    tree: headTree,
    parents: [baseTip],
    message: `Merge pull request #${pr.number} from ${pr.head.ref}\n\n${pr.title}\n`,
    timestamp: FIXED_EPOCH,
  });
  return putObject(repo, 'commit', data);
}
